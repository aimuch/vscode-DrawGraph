import { inflateRawSync } from 'node:zlib';
import { escapeXmlAttribute, unescapeXml } from './drawioSvg';

export interface MxfileBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface ParsedCell {
  id: string;
  parent: string;
  value: string;
  style: Record<string, string>;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  points: Array<{ x: number; y: number }>;
  sourcePoint?: { x: number; y: number };
  targetPoint?: { x: number; y: number };
}

function parseStyle(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const t = part.trim();
    if (!t) {
      continue;
    }
    const eq = t.indexOf('=');
    if (eq < 0) {
      out[t] = '1';
    } else {
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return out;
}

function stripTags(html: string): string {
  return unescapeXml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

function expandDiagramModelAt(xml: string, pageIndex = 0): string {
  const diagRe = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = diagRe.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  const body = matches.length > 0 ? matches[Math.max(0, Math.min(pageIndex, matches.length - 1))] : xml;
  if (body.includes('<mxGraphModel')) {
    return body;
  }
  try {
    const inflated = inflateRawSync(Buffer.from(body, 'base64')).toString('utf8');
    return inflated.includes('%3C') || inflated.includes('%3c') ? decodeURIComponent(inflated) : inflated;
  } catch {
    return xml;
  }
}

function parseCellsFromModel(modelXml: string): {
  cells: Map<string, ParsedCell>;
  vertices: Array<ParsedCell & { ax: number; ay: number }>;
  bounds?: MxfileBounds;
} {
  const cells = new Map<string, ParsedCell>();
  const uoRe = /<(?:UserObject|object)\b([^>]*?)>\s*<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)\s*<\/(?:UserObject|object)>/gi;
  const consumedRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  const attrOf = (attrs: string, name: string): string | undefined => {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const hit = re.exec(attrs);
    return hit ? unescapeXml(hit[1] ?? hit[2] ?? '') : undefined;
  };

  const parseGeo = (body: string) => {
    const gm = /<mxGeometry\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxGeometry>)/i.exec(body);
    const ga = gm ? gm[1] : '';
    const gBody = gm ? gm[2] || '' : '';
    const points: Array<{ x: number; y: number }> = [];
    let sourcePoint: { x: number; y: number } | undefined;
    let targetPoint: { x: number; y: number } | undefined;

    const arrMatch = /<Array\b[^>]*as\s*=\s*["']points["'][^>]*>([\s\S]*?)<\/Array>/i.exec(gBody);
    if (arrMatch) {
      const ptRe = /<mxPoint\b([^>]*?)\/>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = ptRe.exec(arrMatch[1])) !== null) {
        points.push({
          x: parseFloat(attrOf(pm[1], 'x') || '0') || 0,
          y: parseFloat(attrOf(pm[1], 'y') || '0') || 0,
        });
      }
    }

    const namedPtRe = /<mxPoint\b([^>]*?)\/>/gi;
    let npm: RegExpExecArray | null;
    while ((npm = namedPtRe.exec(gBody)) !== null) {
      const role = attrOf(npm[1], 'as');
      if (role === 'sourcePoint') {
        sourcePoint = { x: parseFloat(attrOf(npm[1], 'x') || '0') || 0, y: parseFloat(attrOf(npm[1], 'y') || '0') || 0 };
      } else if (role === 'targetPoint') {
        targetPoint = { x: parseFloat(attrOf(npm[1], 'x') || '0') || 0, y: parseFloat(attrOf(npm[1], 'y') || '0') || 0 };
      }
    }

    return {
      x: parseFloat(attrOf(ga, 'x') || '0') || 0,
      y: parseFloat(attrOf(ga, 'y') || '0') || 0,
      width: parseFloat(attrOf(ga, 'width') || '120') || 120,
      height: parseFloat(attrOf(ga, 'height') || '50') || 50,
      points,
      sourcePoint,
      targetPoint,
    };
  };

  while ((m = uoRe.exec(modelXml)) !== null) {
    consumedRanges.push([m.index, m.index + m[0].length]);
    const uoAttrs = m[1] || '';
    const cellAttrs = m[2] || '';
    const cellBody = m[3] || '';
    const id = attrOf(uoAttrs, 'id') ?? attrOf(cellAttrs, 'id') ?? `c_${cells.size}`;
    const geo = parseGeo(cellBody);
    cells.set(id, {
      id,
      parent: attrOf(cellAttrs, 'parent') ?? '1',
      value: stripTags(attrOf(uoAttrs, 'label') ?? attrOf(cellAttrs, 'value') ?? ''),
      style: parseStyle(attrOf(cellAttrs, 'style') ?? ''),
      vertex: attrOf(cellAttrs, 'vertex') === '1',
      edge: attrOf(cellAttrs, 'edge') === '1',
      source: attrOf(cellAttrs, 'source'),
      target: attrOf(cellAttrs, 'target'),
      ...geo,
    });
  }

  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  while ((m = cellRe.exec(modelXml)) !== null) {
    const idx = m.index;
    if (consumedRanges.some(([s, e]) => idx >= s && idx < e)) {
      continue;
    }
    const cellAttrs = m[1] || '';
    const cellBody = m[2] || '';
    const id = attrOf(cellAttrs, 'id');
    if (!id || id === '0' || id === '1') {
      continue;
    }
    const geo = parseGeo(cellBody);
    cells.set(id, {
      id,
      parent: attrOf(cellAttrs, 'parent') ?? '1',
      value: stripTags(attrOf(cellAttrs, 'value') ?? ''),
      style: parseStyle(attrOf(cellAttrs, 'style') ?? ''),
      vertex: attrOf(cellAttrs, 'vertex') === '1',
      edge: attrOf(cellAttrs, 'edge') === '1',
      source: attrOf(cellAttrs, 'source'),
      target: attrOf(cellAttrs, 'target'),
      ...geo,
    });
  }

  const absPos = (cell: ParsedCell): { x: number; y: number } => {
    let x = cell.x;
    let y = cell.y;
    let curParent = cells.get(cell.parent);
    const guard = new Set<string>([cell.id]);
    while (curParent && !guard.has(curParent.id)) {
      guard.add(curParent.id);
      x += curParent.x;
      y += curParent.y;
      curParent = cells.get(curParent.parent);
    }
    return { x, y };
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const vertices: Array<ParsedCell & { ax: number; ay: number }> = [];

  for (const c of cells.values()) {
    if (c.vertex) {
      const p = absPos(c);
      vertices.push({ ...c, ax: p.x, ay: p.y });
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + c.width);
      maxY = Math.max(maxY, p.y + c.height);
    }
  }

  const bounds = vertices.length > 0 ? { minX, minY, maxX, maxY } : undefined;
  return { cells, vertices, bounds };
}

/** Measures the content bounding box of `<diagram>` at `pageIndex` for unified Diff alignment. */
export function measureMxfileBounds(rawXml: string, pageIndex = 0): MxfileBounds | undefined {
  return parseCellsFromModel(expandDiagramModelAt(rawXml, pageIndex)).bounds;
}

export function unionMxfileBounds(a?: MxfileBounds, b?: MxfileBounds): MxfileBounds | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Lightweight, zero-dependency `<mxfile>` XML -> SVG renderer supporting multi-page index
 * selection, waypoint polylines, cylinders, swimlanes, and optional unified bounding boxes.
 */
export function renderMxfileToPreviewSvg(rawXml: string, pageIndex = 0, overrideBounds?: MxfileBounds): string {
  const { cells, vertices, bounds: naturalBounds } = parseCellsFromModel(expandDiagramModelAt(rawXml, pageIndex));
  const effectiveBounds = overrideBounds ?? naturalBounds;

  if (vertices.length === 0 || !effectiveBounds) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><text x="120" y="44" text-anchor="middle" fill="#888" font-family="sans-serif" font-size="13">(Empty Diagram)</text></svg>';
  }

  const pad = 28;
  const ox = effectiveBounds.minX - pad;
  const oy = effectiveBounds.minY - pad;
  const vw = Math.max(120, Math.ceil(effectiveBounds.maxX - effectiveBounds.minX + pad * 2));
  const vh = Math.max(80, Math.ceil(effectiveBounds.maxY - effectiveBounds.minY + pad * 2));

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${ox} ${oy} ${vw} ${vh}">`,
    '<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#4b5563"/></marker></defs>',
  ];

  const byId = new Map(vertices.map((v) => [v.id, v]));

  // Draw edges (supporting explicit sourcePoint/targetPoint and intermediate <Array as="points"> waypoints)
  for (const c of cells.values()) {
    if (!c.edge) {
      continue;
    }
    const s = c.source ? byId.get(c.source) : undefined;
    const t = c.target ? byId.get(c.target) : undefined;
    const startPt = s ? { x: s.ax + s.width / 2, y: s.ay + s.height / 2 } : c.sourcePoint;
    const endPt = t ? { x: t.ax + t.width / 2, y: t.ay + t.height / 2 } : c.targetPoint;
    if (!startPt || !endPt) {
      continue;
    }
    const allPts = [startPt, ...c.points, endPt];
    const ptsAttr = allPts.map((p) => `${p.x},${p.y}`).join(' ');
    const stroke = c.style.strokeColor && c.style.strokeColor !== 'none' ? c.style.strokeColor : '#4b5563';
    const dash = c.style.dashed === '1' ? ' stroke-dasharray="5,4"' : '';
    const marker = c.style.endArrow === 'none' ? '' : ' marker-end="url(#dg-arrow)"';
    svgParts.push(
      `<polyline points="${ptsAttr}" fill="none" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.6"${dash}${marker}/>`,
    );
    if (c.value) {
      const midIdx = Math.floor(allPts.length / 2);
      const pA = allPts[Math.max(0, midIdx - 1)];
      const pB = allPts[midIdx];
      const mx = (pA.x + pB.x) / 2;
      const my = (pA.y + pB.y) / 2 - 6;
      svgParts.push(
        `<text x="${mx}" y="${my}" text-anchor="middle" fill="#374151" font-family="sans-serif" font-size="11">${escapeXmlAttribute(c.value)}</text>`,
      );
    }
  }

  for (const v of vertices) {
    const fill = v.style.fillColor && v.style.fillColor !== 'none' ? v.style.fillColor : '#ffffff';
    const stroke = v.style.strokeColor && v.style.strokeColor !== 'none' ? v.style.strokeColor : '#374151';
    const hasFill = v.style.fillColor !== 'none';
    const hasStroke = v.style.strokeColor !== 'none';
    const fontColor = v.style.fontColor || '#111827';
    const shapeType = v.style.shape || '';

    if ('ellipse' in v.style) {
      svgParts.push(
        `<ellipse cx="${v.ax + v.width / 2}" cy="${v.ay + v.height / 2}" rx="${v.width / 2}" ry="${v.height / 2}" fill="${escapeXmlAttribute(fill)}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
      );
    } else if ('rhombus' in v.style) {
      const cx = v.ax + v.width / 2;
      const cy = v.ay + v.height / 2;
      const pts = `${cx},${v.ay} ${v.ax + v.width},${cy} ${cx},${v.ay + v.height} ${v.ax},${cy}`;
      svgParts.push(
        `<polygon points="${pts}" fill="${escapeXmlAttribute(fill)}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
      );
    } else if (shapeType.startsWith('cylinder')) {
      const ry = Math.min(12, v.height * 0.18);
      const x = v.ax;
      const y = v.ay;
      const w = v.width;
      const h = v.height;
      const d = `M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z`;
      const cap = `M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`;
      svgParts.push(
        `<path d="${d}" fill="${escapeXmlAttribute(fill)}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
        `<path d="${cap}" fill="none" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
      );
    } else if ('swimlane' in v.style) {
      const startSize = parseFloat(v.style.startSize || '28') || 28;
      const rx = v.style.rounded === '1' ? 6 : 2;
      svgParts.push(
        `<rect x="${v.ax}" y="${v.ay}" width="${v.width}" height="${v.height}" rx="${rx}" fill="${hasFill ? escapeXmlAttribute(fill) : '#f8fafc'}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
        `<line x1="${v.ax}" y1="${v.ay + startSize}" x2="${v.ax + v.width}" y2="${v.ay + startSize}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.2"/>`,
      );
    } else if ('text' in v.style && !hasFill && !hasStroke) {
      // Pure compartment text row inside a UML class / ER swimlane
    } else {
      const rx = v.style.rounded === '1' ? 7 : 2;
      svgParts.push(
        `<rect x="${v.ax}" y="${v.ay}" width="${v.width}" height="${v.height}" rx="${rx}" fill="${hasFill ? escapeXmlAttribute(fill) : 'none'}" stroke="${hasStroke ? escapeXmlAttribute(stroke) : 'none'}" stroke-width="1.5"/>`,
      );
    }

    if (v.value) {
      const lines = v.value.split('\n');
      const isSwimlane = 'swimlane' in v.style;
      const isLeft = v.style.align === 'left';
      const anchor = isLeft ? 'start' : 'middle';
      const textX = isLeft ? v.ax + 8 : v.ax + v.width / 2;
      const baseY = isSwimlane ? v.ay + 18 : v.ay + v.height / 2 - ((lines.length - 1) * 14) / 2 + 4;
      lines.forEach((ln, idx) => {
        svgParts.push(
          `<text x="${textX}" y="${baseY + idx * 15}" text-anchor="${anchor}" fill="${escapeXmlAttribute(fontColor)}" font-family="sans-serif" font-size="12">${escapeXmlAttribute(ln)}</text>`,
        );
      });
    }
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}
