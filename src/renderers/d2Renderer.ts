// D2 (`.d2`) declarative architecture diagram parser, offline layered SVG renderer,
// and optional local `d2` CLI bridge. Zero external runtime dependencies.

import { spawn } from 'node:child_process';

export interface D2Node {
  id: string;
  label: string;
  shape: string;
  parentId?: string;
  fill?: string;
  stroke?: string;
  fields?: Array<{ name: string; type: string; constraint?: string }>;
  isContainer: boolean;
  line: number;
}

export interface D2Edge {
  from: string;
  to: string;
  label?: string;
  bidirectional?: boolean;
  dashed?: boolean;
  line: number;
}

export interface ParsedD2Graph {
  direction: 'right' | 'down' | 'left' | 'up';
  nodes: Map<string, D2Node>;
  edges: D2Edge[];
}

function unquoteD2(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  return t;
}

function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parseD2Graph(source: string): ParsedD2Graph {
  const nodes = new Map<string, D2Node>();
  const edges: D2Edge[] = [];
  let direction: ParsedD2Graph['direction'] = 'right';

  const ensureNode = (fullId: string, line: number, labelOverride?: string): D2Node => {
    const cleanId = fullId.trim();
    const parts = cleanId.split('.').map((p) => unquoteD2(p).trim()).filter(Boolean);
    let currentPath = '';
    let lastNode: D2Node | undefined;
    for (let i = 0; i < parts.length; i++) {
      const parentId = currentPath || undefined;
      currentPath = currentPath ? `${currentPath}.${parts[i]}` : parts[i];
      let node = nodes.get(currentPath);
      if (!node) {
        node = {
          id: currentPath,
          label: parts[i],
          shape: 'rectangle',
          parentId,
          isContainer: i < parts.length - 1,
          line,
        };
        nodes.set(currentPath, node);
      } else if (i < parts.length - 1) {
        node.isContainer = true;
      }
      lastNode = node;
    }
    if (lastNode && labelOverride !== undefined && labelOverride.trim()) {
      lastNode.label = unquoteD2(labelOverride);
    }
    return lastNode!;
  };

  // Each entry on scopeStack represents ONE `{ ... }` block (which may span multiple dotted segments like `a.b {`).
  const scopeStack: string[][] = [];
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');

  for (let li = 0; li < rawLines.length; li++) {
    const stripped = stripLineComment(rawLines[li]).trim();
    if (!stripped) continue;

    // Handle closing brace lines
    if (stripped === '}') {
      scopeStack.pop();
      continue;
    }

    const flatScope = scopeStack.flat();
    const prefix = flatScope.length > 0 ? `${flatScope.join('.')}.` : '';

    // Global direction
    const dirMatch = /^direction\s*:\s*(right|down|left|up)\b/i.exec(stripped);
    if (dirMatch && scopeStack.length === 0) {
      direction = dirMatch[1].toLowerCase() as ParsedD2Graph['direction'];
      continue;
    }

    // Check if inside a style block (`node.style { fill: ... }`)
    const topScope = flatScope[flatScope.length - 1];
    if (topScope === 'style' && flatScope.length >= 2) {
      const ownerId = flatScope.slice(0, -1).join('.');
      const owner = nodes.get(ownerId);
      const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(stripped);
      if (owner && kv) {
        const k = kv[1].toLowerCase();
        const v = unquoteD2(kv[2]);
        if (k === 'fill') owner.fill = v;
        if (k === 'stroke') owner.stroke = v;
      }
      continue;
    }

    // Property on current container (shape, label, style.fill, style.stroke)
    if (flatScope.length > 0) {
      const ownerId = flatScope.join('.');
      const owner = nodes.get(ownerId);
      const propMatch = /^(shape|label|style\.fill|style\.stroke|style\.stroke-dash)\s*:\s*(.+)$/i.exec(stripped);
      if (owner && propMatch) {
        const key = propMatch[1].toLowerCase();
        const val = unquoteD2(propMatch[2]);
        if (key === 'shape') owner.shape = val.toLowerCase();
        else if (key === 'label') owner.label = val;
        else if (key === 'style.fill') owner.fill = val;
        else if (key === 'style.stroke') owner.stroke = val;
        continue;
      }
      // SQL table field inside `shape: sql_table`
      if (owner && owner.shape === 'sql_table' && !stripped.includes('->') && !stripped.includes('--')) {
        const fieldMatch = /^([A-Za-z0-9_.-]+)\s*:\s*([^{]+?)(?:\s*\{\s*constraint\s*:\s*([^}]+)\})?$/i.exec(stripped);
        if (fieldMatch && !/^(shape|label|style|icon|near|link)$/i.test(fieldMatch[1])) {
          if (!owner.fields) owner.fields = [];
          owner.fields.push({
            name: fieldMatch[1].trim(),
            type: unquoteD2(fieldMatch[2]),
            constraint: fieldMatch[3] ? unquoteD2(fieldMatch[3]) : undefined,
          });
          continue;
        }
      }
    }

    // Edge statement (supports chained edges `A -> B -> C: label`, `A <-> B`, `A -- B`)
    const edgeSuffixMatch = /^(.*?)(?:\s*:\s*([^{]+?))?(?:\s*\{([^}]*)\})?$/.exec(stripped);
    const edgeBody = edgeSuffixMatch ? edgeSuffixMatch[1].trim() : stripped;
    if (/(?:<->|->|<-|--)/.test(edgeBody) && !edgeBody.includes(':')) {
      const tokens = edgeBody.split(/\s*(<->|->|<-|--)\s*/).map((s) => s.trim()).filter(Boolean);
      if (tokens.length >= 3 && tokens.length % 2 === 1) {
        const label = edgeSuffixMatch?.[2] ? unquoteD2(edgeSuffixMatch[2]) : undefined;
        const inlineStyle = edgeSuffixMatch?.[3] || '';
        for (let ti = 0; ti < tokens.length - 2; ti += 2) {
          const rawFrom = tokens[ti];
          const op = tokens[ti + 1];
          const rawTo = tokens[ti + 2];
          const fromId = rawFrom.includes('.') || !prefix ? rawFrom : `${prefix}${rawFrom}`;
          const toId = rawTo.includes('.') || !prefix ? rawTo : `${prefix}${rawTo}`;
          const nFrom = ensureNode(fromId, li);
          const nTo = ensureNode(toId, li);
          const actualFrom = op === '<-' ? nTo.id : nFrom.id;
          const actualTo = op === '<-' ? nFrom.id : nTo.id;
          edges.push({
            from: actualFrom,
            to: actualTo,
            label: ti === tokens.length - 3 ? label : undefined,
            bidirectional: op === '<->',
            dashed: /stroke-dash/i.test(inlineStyle) || op === '--',
            line: li,
          });
        }
        continue;
      }
    }

    // Container/Block open: `id: Label {` or `id {` or `id.style {`
    const openBlock = /^([^{:]+?)(?:\s*:\s*([^{]*?))?\s*\{(.*)$/.exec(stripped);
    if (openBlock) {
      const rawKey = openBlock[1].trim();
      const rawLabel = openBlock[2]?.trim();
      const trailing = openBlock[3].trim();
      if (rawKey === 'style' && flatScope.length > 0) {
        scopeStack.push(['style']);
      } else {
        const fullId = `${prefix}${rawKey}`;
        const node = ensureNode(fullId, li, rawLabel || undefined);
        node.isContainer = true;
        // Handle single-line block: `db: Users { shape: cylinder }`
        if (trailing.endsWith('}')) {
          const inner = trailing.slice(0, -1).trim();
          for (const stmt of inner.split(';')) {
            const p = /^(shape|label|style\.fill|style\.stroke)\s*:\s*(.+)$/i.exec(stmt.trim());
            if (p) {
              const k = p[1].toLowerCase();
              const v = unquoteD2(p[2]);
              if (k === 'shape') node.shape = v.toLowerCase();
              else if (k === 'label') node.label = v;
              else if (k === 'style.fill') node.fill = v;
              else if (k === 'style.stroke') node.stroke = v;
            }
          }
          if (!inner.includes('->') && !inner.includes('{')) {
            node.isContainer = false;
          }
        } else {
          const segs = rawKey.split('.').map((s) => unquoteD2(s).trim()).filter(Boolean);
          scopeStack.push(segs.length > 0 ? segs : [rawKey]);
        }
      }
      continue;
    }

    // Inline dotted property: `db.shape: cylinder` or `db.style.fill: "#eee"`
    const dottedProp = /^(.+)\.(shape|label|style\.fill|style\.stroke)\s*:\s*(.+)$/i.exec(stripped);
    if (dottedProp) {
      const targetId = `${prefix}${dottedProp[1].trim()}`;
      const node = ensureNode(targetId, li);
      const key = dottedProp[2].toLowerCase();
      const val = unquoteD2(dottedProp[3]);
      if (key === 'shape') node.shape = val.toLowerCase();
      else if (key === 'label') node.label = val;
      else if (key === 'style.fill') node.fill = val;
      else if (key === 'style.stroke') node.stroke = val;
      continue;
    }

    // Simple node declaration: `id: Label` or bare `id`
    const nodeDecl = /^([^:{}]+?)(?:\s*:\s*(.+))?$/.exec(stripped);
    if (nodeDecl) {
      const rawKey = nodeDecl[1].trim();
      if (rawKey && !/^(vars|classes|layers|scenarios|steps)$/i.test(rawKey)) {
        ensureNode(`${prefix}${rawKey}`, li, nodeDecl[2]);
      }
    }
  }

  return { direction, nodes, edges };
}

export function renderD2ToSvgOffline(source: string, opts?: { dark?: boolean }): string {
  const dark = opts?.dark === true;
  const g = parseD2Graph(source);
  const allNodes = [...g.nodes.values()];
  if (allNodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80"><text x="16" y="44" fill="#64748b" font-family="sans-serif" font-size="13">Empty D2 diagram</text></svg>';
  }

  // Leaf nodes (actual vertices) vs pure containers (groups with children)
  const hasChild = new Set<string>();
  for (const n of allNodes) {
    if (n.parentId) hasChild.add(n.parentId);
  }
  const leaves = allNodes.filter((n) => !hasChild.has(n.id));
  const containers = allNodes.filter((n) => hasChild.has(n.id));

  // Topological layering (Longest Path / Kahn's with cycle break)
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of leaves) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  const resolveLeaf = (id: string): string => {
    if (adj.has(id)) return id;
    const child = leaves.find((l) => l.id.startsWith(`${id}.`));
    return child ? child.id : leaves[0].id;
  };
  for (const e of g.edges) {
    const u = resolveLeaf(e.from);
    const v = resolveLeaf(e.to);
    if (u !== v) {
      adj.get(u)?.push(v);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, d] of indeg) {
    if (d === 0) {
      queue.push(id);
      layer.set(id, 0);
    }
  }
  if (queue.length === 0 && leaves.length > 0) {
    queue.push(leaves[0].id);
    layer.set(leaves[0].id, 0);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    if (visited.has(u)) continue;
    visited.add(u);
    const lu = layer.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      const nextL = Math.max(layer.get(v) ?? 0, lu + 1);
      layer.set(v, nextL);
      const nextD = (indeg.get(v) ?? 1) - 1;
      indeg.set(v, nextD);
      if (nextD <= 0 && !visited.has(v)) {
        queue.push(v);
      }
    }
  }
  for (const n of leaves) {
    if (!layer.has(n.id)) layer.set(n.id, 0);
  }

  const layers = new Map<number, D2Node[]>();
  for (const n of leaves) {
    const l = layer.get(n.id) ?? 0;
    const bucket = layers.get(l) ?? [];
    bucket.push(n);
    layers.set(l, bucket);
  }

  const horizontal = g.direction === 'right' || g.direction === 'left';
  const boxMap = new Map<string, { x: number; y: number; w: number; h: number }>();

  const measureLeaf = (n: D2Node) => {
    if (n.shape === 'sql_table' && n.fields && n.fields.length > 0) {
      const maxLine = Math.max(n.label.length, ...n.fields.map((f) => `${f.name} ${f.type}`.length + 4));
      return { w: Math.max(170, maxLine * 7.5 + 28), h: 34 + n.fields.length * 22 };
    }
    const lines = n.label.split('\n');
    const maxChars = Math.max(8, ...lines.map((l) => l.length));
    const w = Math.max(124, Math.min(260, maxChars * 8 + 32));
    const h = Math.max(50, lines.length * 18 + 26);
    return { w, h };
  };

  const PAD = 48;
  const GAP_MAIN = 88;
  const GAP_CROSS = 44;
  const sortedLayerKeys = [...layers.keys()].sort((a, b) => a - b);
  if (g.direction === 'left' || g.direction === 'up') {
    sortedLayerKeys.reverse();
  }

  let mainCursor = PAD;
  for (const lKey of sortedLayerKeys) {
    const bucket = layers.get(lKey)!;
    // Group siblings by parent container for cleaner bounding boxes
    bucket.sort((a, b) => (a.parentId ?? '').localeCompare(b.parentId ?? ''));
    let crossCursor = PAD + (containers.length > 0 ? 28 : 0);
    let maxMainSize = 0;
    for (const n of bucket) {
      const sz = measureLeaf(n);
      if (horizontal) {
        boxMap.set(n.id, { x: mainCursor, y: crossCursor, w: sz.w, h: sz.h });
        crossCursor += sz.h + GAP_CROSS;
        maxMainSize = Math.max(maxMainSize, sz.w);
      } else {
        boxMap.set(n.id, { x: crossCursor, y: mainCursor, w: sz.w, h: sz.h });
        crossCursor += sz.w + GAP_CROSS;
        maxMainSize = Math.max(maxMainSize, sz.h);
      }
    }
    mainCursor += maxMainSize + GAP_MAIN;
  }

  // Compute container bounding boxes bottom-up
  const sortedContainers = [...containers].sort((a, b) => b.id.split('.').length - a.id.split('.').length);
  for (const c of sortedContainers) {
    const descendants = [...boxMap.entries()].filter(([id]) => id.startsWith(`${c.id}.`));
    if (descendants.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, b] of descendants) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    boxMap.set(c.id, { x: minX - 22, y: minY - 36, w: maxX - minX + 44, h: maxY - minY + 54 });
  }

  let totalW = 360;
  let totalH = 180;
  for (const b of boxMap.values()) {
    totalW = Math.max(totalW, b.x + b.w + PAD);
    totalH = Math.max(totalH, b.y + b.h + PAD);
  }

  const pal = dark
    ? {
        bg: '#0f172a',
        clusterFill: '#1e293b',
        clusterStroke: '#475569',
        clusterText: '#cbd5e1',
        edgeStroke: '#94a3b8',
        edgeLabelBg: '#1e293b',
        edgeLabelBorder: '#475569',
        edgeLabelText: '#e2e8f0',
        nodeFill: '#1e293b',
        nodeStroke: '#64748b',
        cylFill: '#172554',
        cylStroke: '#60a5fa',
        diaFill: '#422006',
        diaStroke: '#facc15',
        nodeText: '#f8fafc',
        tableRowStroke: '#334155',
        tableHeaderFill: '#334155',
        tableTypeText: '#94a3b8',
      }
    : {
        bg: '#ffffff',
        clusterFill: '#f8fafc',
        clusterStroke: '#94a3b8',
        clusterText: '#334155',
        edgeStroke: '#475569',
        edgeLabelBg: '#ffffff',
        edgeLabelBorder: '#e2e8f0',
        edgeLabelText: '#334155',
        nodeFill: '#ffffff',
        nodeStroke: '#334155',
        cylFill: '#eff6ff',
        cylStroke: '#3b82f6',
        diaFill: '#fefce8',
        diaStroke: '#eab308',
        nodeText: '#0f172a',
        tableRowStroke: '#e2e8f0',
        tableHeaderFill: '#1e293b',
        tableTypeText: '#64748b',
      };

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(totalW)}" height="${Math.ceil(totalH)}" viewBox="0 0 ${Math.ceil(totalW)} ${Math.ceil(totalH)}">`,
    `<defs>`,
    `<marker id="d2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="${pal.edgeStroke}"/></marker>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="${pal.bg}" rx="6"/>`,
  ];

  // Draw containers outer-to-inner
  const outerToInner = [...sortedContainers].reverse();
  for (const c of outerToInner) {
    const b = boxMap.get(c.id);
    if (!b) continue;
    const fill = c.fill || pal.clusterFill;
    const stroke = c.stroke || pal.clusterStroke;
    svgParts.push(
      `<g class="cluster" data-id="${escXml(c.id)}">` +
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.5" stroke-dasharray="6 3"/>` +
        `<text x="${b.x + 12}" y="${b.y + 20}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12" font-weight="600" fill="${pal.clusterText}">${escXml(c.label)}</text>` +
        `</g>`,
    );
  }

  // Draw edges
  for (const e of g.edges) {
    const a = boxMap.get(e.from) ?? boxMap.get(resolveLeaf(e.from));
    const b = boxMap.get(e.to) ?? boxMap.get(resolveLeaf(e.to));
    if (!a || !b) continue;
    const x1 = horizontal ? (a.x <= b.x ? a.x + a.w : a.x) : a.x + a.w / 2;
    const y1 = horizontal ? a.y + a.h / 2 : (a.y <= b.y ? a.y + a.h : a.y);
    const x2 = horizontal ? (a.x <= b.x ? b.x : b.x + b.w) : b.x + b.w / 2;
    const y2 = horizontal ? b.y + b.h / 2 : (a.y <= b.y ? b.y : b.y + b.h);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const d = horizontal
      ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    const dash = e.dashed ? ' stroke-dasharray="5 4"' : '';
    const startMarker = e.bidirectional ? ' marker-start="url(#d2-arrow)"' : '';
    svgParts.push(
      `<g class="edgePath" data-from="${escXml(e.from)}" data-to="${escXml(e.to)}">` +
        `<path d="${d}" fill="none" stroke="${pal.edgeStroke}" stroke-width="1.6"${dash}${startMarker} marker-end="url(#d2-arrow)"/>` +
        (e.label
          ? `<rect x="${mx - e.label.length * 3.6 - 6}" y="${my - 10}" width="${e.label.length * 7.2 + 12}" height="18" rx="4" fill="${pal.edgeLabelBg}" stroke="${pal.edgeLabelBorder}" stroke-width="0.8"/>` +
            `<text x="${mx}" y="${my + 3}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="11" fill="${pal.edgeLabelText}">${escXml(e.label)}</text>`
          : '') +
        `</g>`,
    );
  }

  // Draw leaf nodes
  for (const n of leaves) {
    const b = boxMap.get(n.id);
    if (!b) continue;
    const fill = n.fill || (n.shape === 'cylinder' ? pal.cylFill : n.shape === 'diamond' ? pal.diaFill : pal.nodeFill);
    const stroke = n.stroke || (n.shape === 'cylinder' ? pal.cylStroke : n.shape === 'diamond' ? pal.diaStroke : pal.nodeStroke);
    let shapeSvg = '';
    if (n.shape === 'sql_table' && n.fields && n.fields.length > 0) {
      const rows = n.fields
        .map(
          (f, idx) =>
            `<line x1="${b.x}" y1="${b.y + 30 + idx * 22}" x2="${b.x + b.w}" y2="${b.y + 30 + idx * 22}" stroke="${pal.tableRowStroke}" stroke-width="1"/>` +
            `<text x="${b.x + 10}" y="${b.y + 46 + idx * 22}" font-family="monospace" font-size="11" fill="${pal.nodeText}">${escXml(f.name)}</text>` +
            `<text x="${b.x + b.w - 10}" y="${b.y + 46 + idx * 22}" text-anchor="end" font-family="monospace" font-size="10.5" fill="${pal.tableTypeText}">${escXml(f.type)}${f.constraint ? ` (${escXml(f.constraint)})` : ''}</text>`,
        )
        .join('');
      shapeSvg =
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${pal.nodeFill}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="30" rx="6" fill="${pal.tableHeaderFill}"/>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + 19}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12" font-weight="600" fill="#ffffff">${escXml(n.label)}</text>` +
        rows;
    } else if (n.shape === 'cylinder') {
      const ry = 8;
      shapeSvg =
        `<path d="M ${b.x} ${b.y + ry} A ${b.w / 2} ${ry} 0 0 1 ${b.x + b.w} ${b.y + ry} L ${b.x + b.w} ${b.y + b.h - ry} A ${b.w / 2} ${ry} 0 0 1 ${b.x} ${b.y + b.h - ry} Z" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + ry}" rx="${b.w / 2}" ry="${ry}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 6}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12.5" font-weight="500" fill="${pal.nodeText}">${escXml(n.label)}</text>`;
    } else if (n.shape === 'diamond') {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      shapeSvg =
        `<polygon points="${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12" font-weight="500" fill="${pal.nodeText}">${escXml(n.label)}</text>`;
    } else if (n.shape === 'oval' || n.shape === 'circle' || n.shape === 'person') {
      shapeSvg =
        `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12.5" font-weight="500" fill="${pal.nodeText}">${escXml(n.label)}</text>`;
    } else {
      shapeSvg =
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.6"/>` +
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12.5" font-weight="500" fill="${pal.nodeText}">${escXml(n.label)}</text>`;
    }
    svgParts.push(`<g class="node" data-id="${escXml(n.id)}">${shapeSvg}</g>`);
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}

export async function renderD2Svg(
  source: string,
  d2Path: string,
  isTrusted: boolean,
  opts?: { dark?: boolean },
): Promise<string> {
  if (isTrusted && d2Path.trim()) {
    const cliSvg = await tryRunD2Cli(source, d2Path.trim());
    if (cliSvg) {
      return cliSvg;
    }
  }
  return renderD2ToSvgOffline(source, opts);
}

function tryRunD2Cli(source: string, bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: string | undefined) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(val);
      }
    };
    let proc;
    try {
      proc = spawn(bin, ['-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      finish(undefined);
    }, 8000);
    const MAX_D2_STDOUT = 16 * 1024 * 1024;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    proc.stdin.on('error', () => {
      // Ignore EPIPE when CLI exits early
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_D2_STDOUT) {
        proc.kill();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    proc.on('error', () => finish(undefined));
    proc.on('close', (code) => {
      if (code === 0) {
        const out = Buffer.concat(chunks).toString('utf8');
        const idx = out.indexOf('<svg');
        if (idx >= 0) {
          finish(out.slice(idx));
          return;
        }
      }
      finish(undefined);
    });
    proc.stdin.end(source, 'utf8');
  });
}

export function validateD2SyntaxStatic(source: string): Array<{ line: number; message: string; severity: 'error' | 'warning' }> {
  if (!source.trim()) {
    return [];
  }
  let depth = 0;
  let inDouble = false;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let li = 0; li < lines.length; li++) {
    const clean = stripLineComment(lines[li]);
    for (let ci = 0; ci < clean.length; ci++) {
      const ch = clean[ci];
      if (ch === '\\' && inDouble) {
        ci++;
        continue;
      }
      if (ch === '"') inDouble = !inDouble;
      else if (!inDouble) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth < 0) {
            return [{ line: li, message: 'Unexpected "}" in D2 diagram.', severity: 'error' }];
          }
        }
      }
    }
  }
  if (depth > 0) {
    return [{ line: Math.max(0, lines.length - 1), message: 'Unclosed "{" container block in D2 diagram.', severity: 'error' }];
  }
  return [];
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
