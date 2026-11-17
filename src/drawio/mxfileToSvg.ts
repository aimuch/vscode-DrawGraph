import { inflateRawSync } from 'node:zlib';
import { escapeXmlAttribute, unescapeXml } from './drawioSvg';

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

function expandFirstDiagramModel(xml: string): string {
  const diagMatch = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/i.exec(xml);
  const body = diagMatch ? diagMatch[1].trim() : xml;
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

/**
 * Lightweight, zero-dependency `<mxfile>` XML -> SVG renderer used by Git Visual Diff
 * to render raw `.drawio` / `.dio` snapshots instantly offline.
 */
export function renderMxfileToPreviewSvg(rawXml: string): string {
  const modelXml = expandFirstDiagramModel(rawXml);
  const cells = new Map<string, ParsedCell>();

  // Match UserObject/object wrappers and standalone mxCells.
  const uoRe = /<(?:UserObject|object)\b([^>]*?)>\s*<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)\s*<\/(?:UserObject|object)>/gi;
  const consumedRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  const attrOf = (attrs: string, name: string): string | undefined => {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const hit = re.exec(attrs);
    return hit ? unescapeXml(hit[1] ?? hit[2] ?? '') : undefined;
  };

  const parseGeo = (body: string) => {
    const gm = /<mxGeometry\b([^>]*)>/i.exec(body);
    const ga = gm ? gm[1] : '';
    return {
      x: parseFloat(attrOf(ga, 'x') || '0') || 0,
      y: parseFloat(attrOf(ga, 'y') || '0') || 0,
      width: parseFloat(attrOf(ga, 'width') || '120') || 120,
      height: parseFloat(attrOf(ga, 'height') || '50') || 50,
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

  // Resolve absolute coordinates accounting for container parents.
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

  if (vertices.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><text x="120" y="44" text-anchor="middle" fill="#888" font-family="sans-serif" font-size="13">(Empty Diagram)</text></svg>';
  }

  const pad = 28;
  const ox = minX - pad;
  const oy = minY - pad;
  const vw = Math.max(120, Math.ceil(maxX - minX + pad * 2));
  const vh = Math.max(80, Math.ceil(maxY - minY + pad * 2));

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${ox} ${oy} ${vw} ${vh}">`,
    '<defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#4b5563"/></marker></defs>',
  ];

  const byId = new Map(vertices.map((v) => [v.id, v]));

  // Draw edges beneath or above containers
  for (const c of cells.values()) {
    if (!c.edge || !c.source || !c.target) {
      continue;
    }
    const s = byId.get(c.source);
    const t = byId.get(c.target);
    if (!s || !t) {
      continue;
    }
    const x1 = s.ax + s.width / 2;
    const y1 = s.ay + s.height / 2;
    const x2 = t.ax + t.width / 2;
    const y2 = t.ay + t.height / 2;
    const stroke = c.style.strokeColor && c.style.strokeColor !== 'none' ? c.style.strokeColor : '#4b5563';
    const dash = c.style.dashed === '1' ? ' stroke-dasharray="5,4"' : '';
    svgParts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.6"${dash} marker-end="url(#dg-arrow)"/>`,
    );
    if (c.value) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 6;
      svgParts.push(
        `<text x="${mx}" y="${my}" text-anchor="middle" fill="#374151" font-family="sans-serif" font-size="11">${escapeXmlAttribute(c.value)}</text>`,
      );
    }
  }

  for (const v of vertices) {
    const fill = v.style.fillColor && v.style.fillColor !== 'none' ? v.style.fillColor : '#ffffff';
    const stroke = v.style.strokeColor && v.style.strokeColor !== 'none' ? v.style.strokeColor : '#374151';
    const fontColor = v.style.fontColor || '#111827';
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
    } else {
      const rx = v.style.rounded === '1' ? 7 : 2;
      svgParts.push(
        `<rect x="${v.ax}" y="${v.ay}" width="${v.width}" height="${v.height}" rx="${rx}" fill="${escapeXmlAttribute(fill)}" stroke="${escapeXmlAttribute(stroke)}" stroke-width="1.5"/>`,
      );
    }
    if (v.value) {
      const lines = v.value.split('\n');
      const isSwimlane = 'swimlane' in v.style;
      const baseY = isSwimlane ? v.ay + 18 : v.ay + v.height / 2 - ((lines.length - 1) * 14) / 2 + 4;
      lines.forEach((ln, idx) => {
        svgParts.push(
          `<text x="${v.ax + v.width / 2}" y="${baseY + idx * 15}" text-anchor="middle" fill="${escapeXmlAttribute(fontColor)}" font-family="sans-serif" font-size="12">${escapeXmlAttribute(ln)}</text>`,
        );
      });
    }
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}
