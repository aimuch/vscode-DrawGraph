// Reverse-converts Draw.io (`<mxfile>` / `<mxGraphModel>`) diagrams — both plain and
// deflate-compressed — into structured Mermaid or PlantUML source text.

import { inflateRawSync } from 'node:zlib';
import { unescapeXml } from '../drawio/drawioSvg';

interface RawCell {
  id: string;
  parent: string;
  value: string;
  link?: string;
  style: Record<string, string>;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  x: number;
  y: number;
}

function parseStyle(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) out[t] = '1';
    else out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function cleanLabel(html: string): string {
  return unescapeXml(
    html
      .replace(/<br\s*\/?>/gi, ' / ')
      .replace(/<\/(?:div|p|li)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractModelXml(xml: string, pageIndex = 0): string {
  const diagRe = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/gi;
  const pages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = diagRe.exec(xml)) !== null) {
    pages.push(m[1].trim());
  }
  const body = pages.length > 0 ? pages[Math.max(0, Math.min(pageIndex, pages.length - 1))] : xml;
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

function parseCells(modelXml: string): RawCell[] {
  const out: RawCell[] = [];
  const consumed: Array<[number, number]> = [];

  const attr = (attrs: string, name: string): string | undefined => {
    const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const hit = re.exec(attrs);
    return hit ? unescapeXml(hit[1] ?? hit[2] ?? '') : undefined;
  };

  const geoXY = (body: string) => {
    const gm = /<mxGeometry\b([^>]*?)(?:\/>|>[\s\S]*?<\/mxGeometry>)/i.exec(body);
    const ga = gm ? gm[1] : '';
    return {
      x: parseFloat(attr(ga, 'x') ?? '0') || 0,
      y: parseFloat(attr(ga, 'y') ?? '0') || 0,
    };
  };

  const uoRe = /<(?:UserObject|object)\b([^>]*?)>\s*<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)\s*<\/(?:UserObject|object)>/gi;
  let m: RegExpExecArray | null;
  while ((m = uoRe.exec(modelXml)) !== null) {
    consumed.push([m.index, m.index + m[0].length]);
    const uoA = m[1];
    const cA = m[2];
    const cB = m[3] ?? '';
    const id = attr(uoA, 'id') ?? attr(cA, 'id');
    if (!id) continue;
    const { x, y } = geoXY(cB);
    out.push({
      id,
      parent: attr(cA, 'parent') ?? '1',
      value: cleanLabel(attr(uoA, 'label') ?? attr(cA, 'value') ?? ''),
      link: attr(uoA, 'link') ?? attr(cA, 'link'),
      style: parseStyle(attr(cA, 'style') ?? ''),
      vertex: attr(cA, 'vertex') === '1',
      edge: attr(cA, 'edge') === '1',
      source: attr(cA, 'source'),
      target: attr(cA, 'target'),
      x,
      y,
    });
  }

  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  while ((m = cellRe.exec(modelXml)) !== null) {
    const pos = m.index;
    if (consumed.some(([s, e]) => pos >= s && pos < e)) continue;
    const cA = m[1];
    const cB = m[2] ?? '';
    const id = attr(cA, 'id');
    if (!id) continue;
    const { x, y } = geoXY(cB);
    out.push({
      id,
      parent: attr(cA, 'parent') ?? '',
      value: cleanLabel(attr(cA, 'value') ?? ''),
      link: attr(cA, 'link'),
      style: parseStyle(attr(cA, 'style') ?? ''),
      vertex: attr(cA, 'vertex') === '1',
      edge: attr(cA, 'edge') === '1',
      source: attr(cA, 'source'),
      target: attr(cA, 'target'),
      x,
      y,
    });
  }
  return out;
}

interface ExtractedStructure {
  direction: 'LR' | 'TD';
  containers: Array<{ id: string; safeId: string; label: string; children: RawCell[] }>;
  topVertices: RawCell[];
  edges: Array<{
    sourceId: string;
    targetId: string;
    label: string;
    dashed: boolean;
    undirected: boolean;
  }>;
  safeIds: Map<string, string>;
}

function buildGraphStructure(mxfileOrXml: string, pageIndex = 0): ExtractedStructure {
  const modelXml = extractModelXml(mxfileOrXml, pageIndex);
  const rawCells = parseCells(modelXml);
  const byId = new Map<string, RawCell>();
  for (const c of rawCells) {
    byId.set(c.id, c);
  }

  const edgeIds = new Set(rawCells.filter((c) => c.edge).map((c) => c.id));
  const edgeChildLabels = new Map<string, string>();
  for (const c of rawCells) {
    if (c.vertex && (edgeIds.has(c.parent) || c.style.edgeLabel === '1') && c.value) {
      edgeChildLabels.set(c.parent, c.value);
    }
  }

  const realVertices = rawCells.filter(
    (c) => c.vertex && c.id !== '0' && c.id !== '1' && !edgeIds.has(c.parent) && c.style.edgeLabel !== '1',
  );

  // Identify container vertices (those that have child vertices)
  const childrenByParent = new Map<string, RawCell[]>();
  for (const v of realVertices) {
    if (v.parent && v.parent !== '0' && v.parent !== '1' && byId.has(v.parent)) {
      let arr = childrenByParent.get(v.parent);
      if (!arr) {
        arr = [];
        childrenByParent.set(v.parent, arr);
      }
      arr.push(v);
    }
  }

  const containerIds = new Set(childrenByParent.keys());
  const safeIds = new Map<string, string>();
  const usedIds = new Set<string>();
  let seq = 1;

  const allocSafeId = (rawId: string, label: string, prefix = 'N'): string => {
    const candidateBase = /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawId) && !/^(?:end|subgraph|graph|flowchart|class|state|click)$/i.test(rawId)
      ? rawId
      : label
          .replace(/[^A-Za-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .replace(/^(\d)/, `${prefix}_$1`) || `${prefix}${seq++}`;
    let candidate = candidateBase;
    while (!candidate || usedIds.has(candidate) || /^(?:end|subgraph|graph|flowchart)$/i.test(candidate)) {
      candidate = `${candidateBase}_${seq++}`;
    }
    usedIds.add(candidate);
    safeIds.set(rawId, candidate);
    return candidate;
  };

  for (const v of realVertices) {
    allocSafeId(v.id, v.value, containerIds.has(v.id) ? 'Group' : 'N');
  }

  const containers = [...containerIds].map((cid) => {
    const cell = byId.get(cid)!;
    return {
      id: cid,
      safeId: safeIds.get(cid)!,
      label: cell.value || cid,
      children: childrenByParent.get(cid) ?? [],
    };
  });

  const topVertices = realVertices.filter(
    (v) => !containerIds.has(v.id) && (!v.parent || v.parent === '0' || v.parent === '1' || !containerIds.has(v.parent)),
  );

  const absPos = (c: RawCell): { x: number; y: number } => {
    let x = c.x;
    let y = c.y;
    let cur = byId.get(c.parent);
    let guard = 0;
    while (cur && cur.id !== '0' && cur.id !== '1' && guard++ < 8) {
      x += cur.x;
      y += cur.y;
      cur = byId.get(cur.parent);
    }
    return { x, y };
  };

  let sumDx = 0;
  let sumDy = 0;
  const edges: ExtractedStructure['edges'] = [];

  for (const c of rawCells) {
    if (!c.edge || !c.source || !c.target) continue;
    const sId = safeIds.get(c.source);
    const tId = safeIds.get(c.target);
    if (!sId || !tId) continue;
    const sCell = byId.get(c.source);
    const tCell = byId.get(c.target);
    if (sCell && tCell) {
      const p1 = absPos(sCell);
      const p2 = absPos(tCell);
      sumDx += Math.abs(p2.x - p1.x);
      sumDy += Math.abs(p2.y - p1.y);
    }
    edges.push({
      sourceId: sId,
      targetId: tId,
      label: c.value || edgeChildLabels.get(c.id) || '',
      dashed: c.style.dashed === '1',
      undirected: c.style.endArrow === 'none',
    });
  }

  const direction: 'LR' | 'TD' = sumDx > sumDy * 1.25 ? 'LR' : 'TD';
  return { direction, containers, topVertices, edges, safeIds };
}

function formatMermaidNode(id: string, cell: RawCell): string {
  const lbl = (cell.value || id).replace(/"/g, "'");
  const s = cell.style;
  if (s.rhombus === '1' || s.shape === 'rhombus') {
    return `${id}{"${lbl}"}`;
  }
  if (s.cylinder === '1' || s.shape === 'cylinder' || s.shape === 'cylinder3' || s.shape === 'datastore') {
    return `${id}[("${lbl}")]`;
  }
  if (s.ellipse === '1' || s.shape === 'ellipse') {
    return `${id}(["${lbl}"])`;
  }
  if (s.rounded === '1') {
    return `${id}("${lbl}")`;
  }
  return `${id}["${lbl}"]`;
}

export function convertDrawioToMermaid(mxfileOrXml: string, pageIndex = 0): string {
  const st = buildGraphStructure(mxfileOrXml, pageIndex);
  const lines: string[] = [`flowchart ${st.direction}`];
  const clickLinks: string[] = [];

  const emitVertex = (v: RawCell, indent: string) => {
    const id = st.safeIds.get(v.id)!;
    lines.push(`${indent}${formatMermaidNode(id, v)}`);
    if (v.link) {
      clickLinks.push(`  click ${id} "${v.link.replace(/"/g, '')}"`);
    }
  };

  for (const grp of st.containers) {
    lines.push(`  subgraph ${grp.safeId}["${grp.label.replace(/"/g, "'")}"]`);
    for (const ch of grp.children) {
      emitVertex(ch, '    ');
    }
    lines.push('  end');
  }

  for (const v of st.topVertices) {
    emitVertex(v, '  ');
  }

  for (const e of st.edges) {
    const arrow = e.undirected ? (e.dashed ? '-.-' : '---') : e.dashed ? '-.->' : '-->';
    if (e.label) {
      lines.push(`  ${e.sourceId} ${arrow}|"${e.label.replace(/"/g, "'").replace(/\|/g, '/')}"| ${e.targetId}`);
    } else {
      lines.push(`  ${e.sourceId} ${arrow} ${e.targetId}`);
    }
  }

  for (const cl of clickLinks) {
    lines.push(cl);
  }

  return `${lines.join('\n')}\n`;
}

function formatPlantUmlNode(id: string, cell: RawCell): string {
  const lbl = (cell.value || id).replace(/"/g, "'");
  const linkSuffix = cell.link ? ` [[${cell.link}]]` : '';
  const s = cell.style;
  if (s.shape === 'umlActor' || s.umlActor === '1') {
    return `actor "${lbl}" as ${id}${linkSuffix}`;
  }
  if (s.cylinder === '1' || s.shape === 'cylinder' || s.shape === 'cylinder3' || s.shape === 'datastore') {
    return `database "${lbl}" as ${id}${linkSuffix}`;
  }
  if (s.rhombus === '1' || s.shape === 'rhombus') {
    return `agent "${lbl}" as ${id}${linkSuffix}`;
  }
  if (s.ellipse === '1' || s.shape === 'ellipse') {
    return `usecase "${lbl}" as ${id}${linkSuffix}`;
  }
  return `rectangle "${lbl}" as ${id}${linkSuffix}`;
}

export function convertDrawioToPlantUml(mxfileOrXml: string, pageIndex = 0): string {
  const st = buildGraphStructure(mxfileOrXml, pageIndex);
  const lines: string[] = ['@startuml'];
  if (st.direction === 'LR') {
    lines.push('left to right direction');
  }

  for (const grp of st.containers) {
    lines.push(`package "${grp.label.replace(/"/g, "'")}" as ${grp.safeId} {`);
    for (const ch of grp.children) {
      lines.push(`  ${formatPlantUmlNode(st.safeIds.get(ch.id)!, ch)}`);
    }
    lines.push('}');
  }

  for (const v of st.topVertices) {
    lines.push(formatPlantUmlNode(st.safeIds.get(v.id)!, v));
  }

  for (const e of st.edges) {
    const arrow = e.undirected ? (e.dashed ? '..' : '--') : e.dashed ? '..>' : '-->';
    const lbl = e.label ? ` : ${e.label}` : '';
    lines.push(`${e.sourceId} ${arrow} ${e.targetId}${lbl}`);
  }

  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}
