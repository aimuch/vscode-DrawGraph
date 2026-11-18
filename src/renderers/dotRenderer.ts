// Graphviz DOT (`.dot` / `.gv`) parser, offline Sugiyama layered DAG SVG renderer,
// and optional `dot -Tsvg` local CLI bridge. Zero external runtime dependencies.

import { spawn } from 'node:child_process';

export interface DotNode {
  id: string;
  label: string;
  shape: string;
  color?: string;
  fillcolor?: string;
  fontcolor?: string;
  style?: string;
  clusterId?: string;
  line: number;
}

export interface DotEdge {
  from: string;
  to: string;
  directed: boolean;
  label?: string;
  color?: string;
  style?: string;
  line: number;
}

export interface DotCluster {
  id: string;
  label: string;
  color?: string;
  fillcolor?: string;
  style?: string;
  nodeIds: string[];
  line: number;
}

export interface ParsedDotGraph {
  id: string;
  directed: boolean;
  rankdir: 'TB' | 'BT' | 'LR' | 'RL';
  label?: string;
  nodes: Map<string, DotNode>;
  edges: DotEdge[];
  clusters: DotCluster[];
}

interface DotToken {
  type: 'word' | 'string' | 'symbol' | 'edgeop';
  value: string;
  line: number;
}

function tokenizeDot(source: string): DotToken[] {
  const tokens: DotToken[] = [];
  let i = 0;
  let line = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Line comments (`//` or `#` preprocessor lines)
    if ((ch === '/' && next === '/') || (ch === '#' && (i === 0 || source[i - 1] === '\n'))) {
      while (i < n && source[i] !== '\n') {
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          line++;
        }
        i++;
      }
      i += 2;
      continue;
    }
    // Edge operator
    if ((ch === '-' && next === '>') || (ch === '-' && next === '-')) {
      tokens.push({ type: 'edgeop', value: ch + next, line });
      i += 2;
      continue;
    }
    // Quoted string
    if (ch === '"') {
      const startLine = line;
      let val = '';
      i++;
      while (i < n) {
        const c = source[i++];
        if (c === '\n') {
          line++;
        }
        if (c === '\\' && i < n) {
          const esc = source[i++];
          if (esc === 'n' || esc === 'l' || esc === 'r') {
            val += '\n';
          } else {
            val += esc;
          }
        } else if (c === '"') {
          break;
        } else {
          val += c;
        }
      }
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }
    // HTML-like label `< ... >`
    if (ch === '<') {
      const startLine = line;
      let depth = 1;
      let raw = '';
      i++;
      while (i < n && depth > 0) {
        const c = source[i++];
        if (c === '\n') {
          line++;
        }
        if (c === '<') {
          depth++;
          raw += c;
        } else if (c === '>') {
          depth--;
          if (depth > 0) {
            raw += c;
          }
        } else {
          raw += c;
        }
      }
      const plain = raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      tokens.push({ type: 'string', value: plain, line: startLine });
      continue;
    }
    // Structural symbols
    if ('{}[];=,'.includes(ch)) {
      tokens.push({ type: 'symbol', value: ch, line });
      i++;
      continue;
    }
    // Port separator `:` — skip `:port(:compass)?` attached to node IDs when parsing endpoints
    if (ch === ':') {
      tokens.push({ type: 'symbol', value: ':', line });
      i++;
      continue;
    }
    // Bare identifier / number / color `#hex`
    const startLine = line;
    let end = i;
    while (
      end < n &&
      !/\s/.test(source[end]) &&
      !'{}[];=,:'.includes(source[end]) &&
      !(source[end] === '-' && (source[end + 1] === '>' || source[end + 1] === '-')) &&
      !(source[end] === '/' && (source[end + 1] === '/' || source[end + 1] === '*')) &&
      source[end] !== '"'
    ) {
      end++;
    }
    tokens.push({ type: 'word', value: source.slice(i, end), line: startLine });
    i = end;
  }

  return tokens;
}

export function parseDotGraph(source: string): ParsedDotGraph {
  const tokens = tokenizeDot(source);
  if (tokens.length === 0) {
    throw new Error('Empty Graphviz DOT document.');
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  if (peek()?.type === 'word' && peek()!.value.toLowerCase() === 'strict') {
    next();
  }

  const headTok = next();
  if (!headTok || headTok.type !== 'word' || !/^(?:di)?graph$/i.test(headTok.value)) {
    throw new Error(`Expected "digraph" or "graph" at line ${(headTok?.line ?? 0) + 1}.`);
  }
  const directed = headTok.value.toLowerCase() === 'digraph';

  let graphId = 'G';
  if (peek() && (peek()!.type === 'word' || peek()!.type === 'string')) {
    graphId = next()!.value;
  }
  if (!peek() || peek()!.value !== '{') {
    throw new Error(`Expected "{" after ${headTok.value} header.`);
  }
  next(); // consume '{'

  const graph: ParsedDotGraph = {
    id: graphId,
    directed,
    rankdir: 'TB',
    nodes: new Map<string, DotNode>(),
    edges: [],
    clusters: [],
  };

  function parseAttrBlocks(): Record<string, string> {
    const attrs: Record<string, string> = {};
    while (peek()?.value === '[') {
      next(); // '['
      while (pos < tokens.length && peek()?.value !== ']') {
        const kTok = next();
        if (!kTok) {
          break;
        }
        if (kTok.value === ',' || kTok.value === ';') {
          continue;
        }
        if (peek()?.value === '=') {
          next(); // '='
          const vTok = next();
          if (vTok) {
            attrs[kTok.value.toLowerCase()] = vTok.value;
          }
        }
        if (peek()?.value === ',' || peek()?.value === ';') {
          next();
        }
      }
      if (peek()?.value === ']') {
        next();
      }
    }
    return attrs;
  }

  function ensureNode(
    id: string,
    line: number,
    defaults: Record<string, string>,
    explicitAttrs?: Record<string, string>,
    clusterId?: string,
  ): DotNode {
    const merged = { ...defaults, ...(explicitAttrs ?? {}) };
    const existing = graph.nodes.get(id);
    if (existing) {
      if (explicitAttrs) {
        if (explicitAttrs.label !== undefined) {
          existing.label = explicitAttrs.label === '\\N' ? id : explicitAttrs.label;
        }
        if (explicitAttrs.shape) existing.shape = explicitAttrs.shape.toLowerCase();
        if (explicitAttrs.color) existing.color = explicitAttrs.color;
        if (explicitAttrs.fillcolor) existing.fillcolor = explicitAttrs.fillcolor;
        if (explicitAttrs.fontcolor) existing.fontcolor = explicitAttrs.fontcolor;
        if (explicitAttrs.style) existing.style = explicitAttrs.style;
      }
      if (clusterId && !existing.clusterId) {
        existing.clusterId = clusterId;
      }
      return existing;
    }
    const rawLabel = merged.label !== undefined ? merged.label : id;
    const node: DotNode = {
      id,
      label: rawLabel === '\\N' ? id : rawLabel,
      shape: (merged.shape || 'box').toLowerCase(),
      color: merged.color,
      fillcolor: merged.fillcolor,
      fontcolor: merged.fontcolor,
      style: merged.style,
      clusterId,
      line,
    };
    graph.nodes.set(id, node);
    return node;
  }

  function readEndpointNodeIds(
    nodeDefaults: Record<string, string>,
    edgeDefaults: Record<string, string>,
    cluster?: DotCluster,
  ): { ids: string[]; line: number } | undefined {
    const t0 = peek();
    if (!t0) {
      return undefined;
    }
    // Anonymous or named subgraph as endpoint `{ A; B }` or `subgraph X { ... }`
    if (t0.value === '{' || (t0.type === 'word' && t0.value.toLowerCase() === 'subgraph')) {
      let subId = `sub_${graph.clusters.length + 1}`;
      const startLine = t0.line;
      if (t0.type === 'word') {
        next(); // 'subgraph'
        if (peek() && (peek()!.type === 'word' || peek()!.type === 'string')) {
          subId = next()!.value;
        }
      }
      if (peek()?.value === '{') {
        next();
        const isCluster = /^cluster/i.test(subId);
        const targetCluster: DotCluster | undefined = isCluster
          ? { id: subId, label: subId.replace(/^cluster_?/i, ''), nodeIds: [], line: startLine }
          : cluster;
        if (isCluster && targetCluster) {
          graph.clusters.push(targetCluster);
        }
        const collected = parseBlock({ ...nodeDefaults }, { ...edgeDefaults }, targetCluster);
        return { ids: collected, line: startLine };
      }
      return undefined;
    }

    if (t0.type === 'word' || t0.type === 'string') {
      const tok = next()!;
      // Consume optional `:port(:compass)?` suffix
      while (peek()?.value === ':') {
        next();
        if (peek() && (peek()!.type === 'word' || peek()!.type === 'string')) {
          next();
        }
      }
      return { ids: [tok.value], line: tok.line };
    }
    return undefined;
  }

  function parseBlock(
    nodeDefaults: Record<string, string>,
    edgeDefaults: Record<string, string>,
    cluster?: DotCluster,
  ): string[] {
    const blockNodeIds = new Set<string>();
    const addBlockNode = (id: string) => {
      blockNodeIds.add(id);
      if (cluster && !cluster.nodeIds.includes(id)) {
        cluster.nodeIds.push(id);
      }
    };

    while (pos < tokens.length && peek()?.value !== '}') {
      const cur = peek()!;
      if (cur.value === ';') {
        next();
        continue;
      }

      const lower = cur.type === 'word' ? cur.value.toLowerCase() : '';

      // Default attribute statements: `graph [...]`, `node [...]`, `edge [...]`
      if ((lower === 'graph' || lower === 'node' || lower === 'edge') && tokens[pos + 1]?.value === '[') {
        next();
        const attrs = parseAttrBlocks();
        if (lower === 'graph') {
          applyScopeAttrs(attrs, cluster);
        } else if (lower === 'node') {
          Object.assign(nodeDefaults, attrs);
        } else {
          Object.assign(edgeDefaults, attrs);
        }
        continue;
      }

      // Scope-level `key = value` (e.g. `rankdir=LR`, `label="Cluster A"`)
      if ((cur.type === 'word' || cur.type === 'string') && tokens[pos + 1]?.value === '=') {
        const k = next()!.value.toLowerCase();
        next(); // '='
        const v = next()?.value ?? '';
        applyScopeAttrs({ [k]: v }, cluster);
        continue;
      }

      const first = readEndpointNodeIds(nodeDefaults, edgeDefaults, cluster);
      if (!first) {
        next();
        continue;
      }

      // Check for edge chain: `A -> B -> C [attrs]`
      if (peek()?.type === 'edgeop') {
        const chain: Array<{ ids: string[]; op?: string; line: number }> = [{ ids: first.ids, line: first.line }];
        while (peek()?.type === 'edgeop') {
          const op = next()!.value;
          const rhs = readEndpointNodeIds(nodeDefaults, edgeDefaults, cluster);
          if (!rhs) {
            break;
          }
          chain[chain.length - 1].op = op;
          chain.push({ ids: rhs.ids, line: rhs.line });
        }
        const eAttrs = { ...edgeDefaults, ...parseAttrBlocks() };
        for (const group of chain) {
          for (const nid of group.ids) {
            ensureNode(nid, group.line, nodeDefaults, undefined, cluster?.id);
            addBlockNode(nid);
          }
        }
        for (let ci = 0; ci < chain.length - 1; ci++) {
          const isDir = chain[ci].op === '->' || directed;
          for (const u of chain[ci].ids) {
            for (const v of chain[ci + 1].ids) {
              graph.edges.push({
                from: u,
                to: v,
                directed: isDir,
                label: eAttrs.label,
                color: eAttrs.color,
                style: eAttrs.style,
                line: chain[ci].line,
              });
            }
          }
        }
        continue;
      }

      // Standalone node declaration (or completed subgraph)
      const nAttrs = peek()?.value === '[' ? parseAttrBlocks() : undefined;
      for (const nid of first.ids) {
        ensureNode(nid, first.line, nodeDefaults, nAttrs, cluster?.id);
        addBlockNode(nid);
      }
    }

    if (peek()?.value === '}') {
      next();
    }
    return [...blockNodeIds];
  }

  function applyScopeAttrs(attrs: Record<string, string>, cluster?: DotCluster) {
    if (cluster) {
      if (attrs.label !== undefined) cluster.label = attrs.label;
      if (attrs.color) cluster.color = attrs.color;
      if (attrs.fillcolor || attrs.bgcolor) cluster.fillcolor = attrs.fillcolor || attrs.bgcolor;
      if (attrs.style) cluster.style = attrs.style;
      return;
    }
    if (attrs.rankdir) {
      const rd = attrs.rankdir.toUpperCase();
      if (rd === 'TB' || rd === 'BT' || rd === 'LR' || rd === 'RL') {
        graph.rankdir = rd;
      }
    }
    if (attrs.label !== undefined) {
      graph.label = attrs.label;
    }
  }

  parseBlock({}, {});
  return graph;
}

/**
 * Renders a Graphviz DOT string into a clean standalone SVG completely offline in pure TypeScript.
 */
export function renderDotToSvgOffline(source: string): string {
  const g = parseDotGraph(source);
  const nodeList = [...g.nodes.values()];
  if (nodeList.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80"><rect width="100%" height="100%" fill="#ffffff"/><text x="160" y="44" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="13">Empty DOT graph (${escXml(g.id)})</text></svg>`;
  }

  const horizontal = g.rankdir === 'LR' || g.rankdir === 'RL';
  const reversed = g.rankdir === 'BT' || g.rankdir === 'RL';

  // Measure each node box
  const dims = new Map<string, { w: number; h: number; lines: string[]; recordFields?: string[] }>();
  for (const nd of nodeList) {
    const isRecord = nd.shape === 'record' || nd.shape === 'mrecord';
    const rawLabel = isRecord ? nd.label.replace(/^\{|\}$/g, '') : nd.label;
    const recordFields = isRecord ? rawLabel.split('|').map((s) => s.replace(/<[^>]+>/g, '').trim()) : undefined;
    const lines = isRecord
      ? [recordFields!.join(' | ')]
      : nd.label.split(/\r?\n/).map((s) => s.trim());
    const maxChars = Math.max(3, ...lines.map((l) => l.length));
    let w = Math.max(84, maxChars * 8 + 28);
    let h = Math.max(40, lines.length * 18 + 18);
    if (nd.shape === 'circle' || nd.shape === 'doublecircle') {
      const side = Math.max(52, Math.min(120, Math.max(w * 0.75, h)));
      w = side;
      h = side;
    } else if (nd.shape === 'diamond') {
      w = Math.max(108, w * 1.25);
      h = Math.max(58, h * 1.25);
    }
    dims.set(nd.id, { w, h, lines, recordFields });
  }

  // Cycle-breaking DFS + longest-path layer assignment
  const adj = new Map<string, string[]>();
  for (const nd of nodeList) {
    adj.set(nd.id, []);
  }
  const dagEdges: Array<{ u: string; v: string }> = [];
  const state = new Map<string, number>(); // 0 unvisited, 1 visiting, 2 done

  const rawAdj = new Map<string, string[]>();
  for (const nd of nodeList) rawAdj.set(nd.id, []);
  for (const e of g.edges) {
    if (e.from !== e.to) {
      rawAdj.get(e.from)?.push(e.to);
    }
  }

  function dfs(u: string) {
    state.set(u, 1);
    for (const v of rawAdj.get(u) ?? []) {
      const st = state.get(v) ?? 0;
      if (st === 1) {
        // Back-edge: reverse for ranking only
        dagEdges.push({ u: v, v: u });
      } else {
        dagEdges.push({ u, v });
        if (st === 0) {
          dfs(v);
        }
      }
    }
    state.set(u, 2);
  }
  for (const nd of nodeList) {
    if ((state.get(nd.id) ?? 0) === 0) {
      dfs(nd.id);
    }
  }

  const indeg = new Map<string, number>();
  for (const nd of nodeList) {
    indeg.set(nd.id, 0);
    adj.set(nd.id, []);
  }
  for (const de of dagEdges) {
    adj.get(de.u)!.push(de.v);
    indeg.set(de.v, (indeg.get(de.v) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const nd of nodeList) {
    rank.set(nd.id, 0);
    if ((indeg.get(nd.id) ?? 0) === 0) {
      queue.push(nd.id);
    }
  }
  while (queue.length > 0) {
    const u = queue.shift()!;
    const ru = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if (ru + 1 > (rank.get(v) ?? 0)) {
        rank.set(v, ru + 1);
      }
      const nextDeg = (indeg.get(v) ?? 1) - 1;
      indeg.set(v, nextDeg);
      if (nextDeg === 0) {
        queue.push(v);
      }
    }
  }

  let maxRank = 0;
  for (const r of rank.values()) {
    maxRank = Math.max(maxRank, r);
  }

  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const nd of nodeList) {
    const r = reversed ? maxRank - (rank.get(nd.id) ?? 0) : (rank.get(nd.id) ?? 0);
    layers[r].push(nd.id);
  }

  // Barycenter ordering within layers to reduce edge crossings and keep cluster siblings adjacent
  const clusterOrder = new Map<string, number>();
  g.clusters.forEach((c, idx) => clusterOrder.set(c.id, idx + 1));

  const posInLayer = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((id, i) => posInLayer.set(id, i)));

  for (let pass = 0; pass < 2; pass++) {
    for (let li = 1; li < layers.length; li++) {
      layers[li].sort((a, b) => {
        const ca = clusterOrder.get(g.nodes.get(a)?.clusterId ?? '') ?? 0;
        const cb = clusterOrder.get(g.nodes.get(b)?.clusterId ?? '') ?? 0;
        if (ca !== cb) {
          return ca - cb;
        }
        const predsA = g.edges.filter((e) => e.to === a).map((e) => posInLayer.get(e.from) ?? 0);
        const predsB = g.edges.filter((e) => e.to === b).map((e) => posInLayer.get(e.from) ?? 0);
        const avgA = predsA.length ? predsA.reduce((s, x) => s + x, 0) / predsA.length : (posInLayer.get(a) ?? 0);
        const avgB = predsB.length ? predsB.reduce((s, x) => s + x, 0) / predsB.length : (posInLayer.get(b) ?? 0);
        return avgA - avgB;
      });
      layers[li].forEach((id, i) => posInLayer.set(id, i));
    }
  }

  // Coordinate assignment
  const padOuter = 36;
  const titleOffset = g.label ? 28 : 0;
  const rankGap = 76;
  const siblingGap = 36;
  const coords = new Map<string, { x: number; y: number; w: number; h: number }>();

  if (!horizontal) {
    // TB / BT: layers stack vertically
    const layerWidths = layers.map((layer) =>
      layer.reduce((sum, id, idx) => sum + dims.get(id)!.w + (idx > 0 ? siblingGap : 0), 0),
    );
    const maxLayerW = Math.max(240, ...layerWidths);
    let curY = padOuter + titleOffset + 18;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (layer.length === 0) continue;
      const lw = layerWidths[li];
      const maxH = Math.max(...layer.map((id) => dims.get(id)!.h));
      let curX = padOuter + (maxLayerW - lw) / 2;
      for (const id of layer) {
        const d = dims.get(id)!;
        coords.set(id, { x: curX, y: curY + (maxH - d.h) / 2, w: d.w, h: d.h });
        curX += d.w + siblingGap;
      }
      curY += maxH + rankGap;
    }
  } else {
    // LR / RL: layers stack horizontally
    const layerHeights = layers.map((layer) =>
      layer.reduce((sum, id, idx) => sum + dims.get(id)!.h + (idx > 0 ? siblingGap : 0), 0),
    );
    const maxLayerH = Math.max(160, ...layerHeights);
    let curX = padOuter + 18;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (layer.length === 0) continue;
      const lh = layerHeights[li];
      const maxW = Math.max(...layer.map((id) => dims.get(id)!.w));
      let curY = padOuter + titleOffset + (maxLayerH - lh) / 2;
      for (const id of layer) {
        const d = dims.get(id)!;
        coords.set(id, { x: curX + (maxW - d.w) / 2, y: curY, w: d.w, h: d.h });
        curY += d.h + siblingGap;
      }
      curX += maxW + rankGap;
    }
  }

  let totalW = 320;
  let totalH = 180;
  for (const c of coords.values()) {
    totalW = Math.max(totalW, c.x + c.w + padOuter + 18);
    totalH = Math.max(totalH, c.y + c.h + padOuter + 18);
  }

  const parts: string[] = [];

  if (g.label) {
    parts.push(`<text x="${totalW / 2}" y="${padOuter - 4}" text-anchor="middle" font-size="14" font-weight="600" fill="#0f172a">${escXml(g.label)}</text>`);
  }

  // Render subgraph clusters behind edges & nodes
  for (const cl of g.clusters) {
    const boxes = cl.nodeIds.map((id) => coords.get(id)).filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (boxes.length === 0) continue;
    const minX = Math.min(...boxes.map((b) => b.x)) - 16;
    const minY = Math.min(...boxes.map((b) => b.y)) - 28;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 16;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 14;
    const fill = cl.fillcolor || '#f8fafc';
    const stroke = cl.color || '#94a3b8';
    const dash = cl.style?.includes('dashed') ? ' stroke-dasharray="5,4"' : '';
    parts.push(
      `<g class="cluster"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="6" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.3"${dash}/>`,
      `<text x="${minX + 10}" y="${minY + 17}" font-size="11.5" font-weight="600" fill="#334155">${escXml(cl.label)}</text></g>`,
    );
  }

  // Render edges
  for (const e of g.edges) {
    const src = coords.get(e.from);
    const dst = coords.get(e.to);
    if (!src || !dst) continue;
    const stroke = e.color || '#475569';
    const dash = e.style?.includes('dashed')
      ? ' stroke-dasharray="6,4"'
      : e.style?.includes('dotted')
        ? ' stroke-dasharray="2,3"'
        : '';
    const marker = e.directed ? ' marker-end="url(#dot-arrow)"' : '';

    if (e.from === e.to) {
      const lx = src.x + src.w;
      const ly = src.y + src.h / 2;
      parts.push(
        `<path class="edgePath" d="M ${lx} ${ly - 6} C ${lx + 34} ${ly - 24}, ${lx + 34} ${ly + 24}, ${lx} ${ly + 6}" fill="none" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}${marker}/>`,
      );
      continue;
    }

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    let dPath: string;

    if (!horizontal) {
      const goingDown = dst.y >= src.y;
      x1 = src.x + src.w / 2;
      y1 = goingDown ? src.y + src.h : src.y;
      x2 = dst.x + dst.w / 2;
      y2 = goingDown ? dst.y : dst.y + dst.h;
      const cy = (y1 + y2) / 2;
      dPath = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
    } else {
      const goingRight = dst.x >= src.x;
      x1 = goingRight ? src.x + src.w : src.x;
      y1 = src.y + src.h / 2;
      x2 = goingRight ? dst.x : dst.x + dst.w;
      y2 = dst.y + dst.h / 2;
      const cx = (x1 + x2) / 2;
      dPath = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
    }

    parts.push(`<g class="edgePath"><path d="${dPath}" fill="none" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}${marker}/>`);
    if (e.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const bw = e.label.length * 6.8 + 10;
      parts.push(
        `<rect x="${mx - bw / 2}" y="${my - 9}" width="${bw}" height="16" rx="3" fill="#ffffff" opacity="0.92"/>`,
        `<text x="${mx}" y="${my + 3}" text-anchor="middle" font-size="11" fill="#334155">${escXml(e.label)}</text>`,
      );
    }
    parts.push(`</g>`);
  }

  // Render nodes
  for (const nd of nodeList) {
    const box = coords.get(nd.id)!;
    const dm = dims.get(nd.id)!;
    const stroke = nd.color || '#1e293b';
    const isFilled = Boolean(nd.fillcolor) || Boolean(nd.style?.includes('filled'));
    const fill = nd.fillcolor || (isFilled ? '#e2e8f0' : '#ffffff');
    const textFill = nd.fontcolor || '#0f172a';
    const dash = nd.style?.includes('dashed') ? ' stroke-dasharray="5,3"' : '';
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    parts.push(`<g class="node" data-node-id="${escXml(nd.id)}">`);

    switch (nd.shape) {
      case 'ellipse':
      case 'oval':
      case 'circle':
      case 'doublecircle': {
        parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${box.w / 2}" ry="${box.h / 2}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`);
        if (nd.shape === 'doublecircle') {
          parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${Math.max(4, box.w / 2 - 4)}" ry="${Math.max(4, box.h / 2 - 4)}" fill="none" stroke="${escXml(stroke)}" stroke-width="1.1"/>`);
        }
        break;
      }
      case 'diamond': {
        const pts = `${cx},${box.y} ${box.x + box.w},${cy} ${cx},${box.y + box.h} ${box.x},${cy}`;
        parts.push(`<polygon points="${pts}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`);
        break;
      }
      case 'hexagon': {
        const inset = Math.min(18, box.w * 0.18);
        const pts = `${box.x + inset},${box.y} ${box.x + box.w - inset},${box.y} ${box.x + box.w},${cy} ${box.x + box.w - inset},${box.y + box.h} ${box.x + inset},${box.y + box.h} ${box.x},${cy}`;
        parts.push(`<polygon points="${pts}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`);
        break;
      }
      case 'cylinder': {
        const ry = 7;
        const body = `M ${box.x} ${box.y + ry} L ${box.x} ${box.y + box.h - ry} A ${box.w / 2} ${ry} 0 0 0 ${box.x + box.w} ${box.y + box.h - ry} L ${box.x + box.w} ${box.y + ry}`;
        parts.push(
          `<path d="${body}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`,
          `<ellipse cx="${cx}" cy="${box.y + ry}" rx="${box.w / 2}" ry="${ry}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"/>`,
        );
        break;
      }
      case 'plaintext':
      case 'plain':
      case 'none':
        break;
      case 'record':
      case 'mrecord': {
        const rx = nd.shape === 'mrecord' ? 8 : 2;
        parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rx}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`);
        const fields = dm.recordFields ?? [nd.label];
        const fw = box.w / Math.max(1, fields.length);
        fields.forEach((fText, fi) => {
          if (fi > 0) {
            const dx = box.x + fi * fw;
            parts.push(`<line x1="${dx}" y1="${box.y}" x2="${dx}" y2="${box.y + box.h}" stroke="${escXml(stroke)}" stroke-width="1.1"/>`);
          }
          parts.push(`<text x="${box.x + (fi + 0.5) * fw}" y="${cy + 4}" text-anchor="middle" font-size="12" fill="${escXml(textFill)}">${escXml(fText)}</text>`);
        });
        parts.push(`</g>`);
        continue;
      }
      default: {
        const rx = nd.style?.includes('rounded') || nd.shape === 'mrecord' ? 8 : 4;
        parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rx}" fill="${escXml(fill)}" stroke="${escXml(stroke)}" stroke-width="1.4"${dash}/>`);
        break;
      }
    }

    const lineStart = cy - ((dm.lines.length - 1) * 16) / 2 + 4;
    dm.lines.forEach((ln, li) => {
      parts.push(`<text x="${cx}" y="${lineStart + li * 16}" text-anchor="middle" font-size="12" fill="${escXml(textFill)}">${escXml(ln)}</text>`);
    });
    parts.push(`</g>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">`,
    `<defs><marker id="dot-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#475569"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...parts,
    `</svg>`,
  ].join('');
}

const cliSvgCache = new Map<string, string>();

/**
 * Renders Graphviz DOT using local `dot -Tsvg` when available and trusted,
 * falling back seamlessly to the built-in pure-TS layout renderer.
 */
export async function renderDotSvg(source: string, dotExecutable = '', allowCli = false): Promise<string> {
  // Validate syntax up-front so parse errors report accurate line numbers
  parseDotGraph(source);

  if (allowCli) {
    const bin = dotExecutable.trim() || 'dot';
    const cacheKey = `${bin}\0${source}`;
    const cached = cliSvgCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const cliResult = await tryRunDotCli(bin, source);
    if (cliResult) {
      cliSvgCache.set(cacheKey, cliResult);
      if (cliSvgCache.size > 48) {
        const first = cliSvgCache.keys().next().value;
        if (first !== undefined) cliSvgCache.delete(first);
      }
      return cliResult;
    }
  }

  return renderDotToSvgOffline(source);
}

function tryRunDotCli(bin: string, source: string): Promise<string | undefined> {
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
      proc = spawn(bin, ['-Tsvg'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      finish(undefined);
    }, 6000);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
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

export function validateDotSyntaxStatic(source: string): Array<{ line: number; message: string; severity: 'error' | 'warning' }> {
  if (!source.trim()) {
    return [];
  }
  const issues: Array<{ line: number; message: string; severity: 'error' | 'warning' }> = [];
  // Check brace balance
  let depth = 0;
  let inQuote = false;
  const lines = source.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    for (let ci = 0; ci < ln.length; ci++) {
      const ch = ln[ci];
      if (ch === '/' && ln[ci + 1] === '/' && !inQuote) break;
      if (ch === '"' && ln[ci - 1] !== '\\') {
        inQuote = !inQuote;
      } else if (!inQuote) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
    }
  }
  if (depth !== 0) {
    issues.push({
      line: Math.max(0, lines.length - 1),
      message: depth > 0 ? 'Unclosed "{" block in Graphviz DOT.' : 'Unexpected "}" in Graphviz DOT.',
      severity: 'error',
    });
    return issues;
  }

  try {
    const g = parseDotGraph(source);
    if (!g.directed && source.includes('->')) {
      issues.push({
        line: 0,
        message: 'Undirected "graph" uses directed "->" edge operator (use "--" or change header to "digraph").',
        severity: 'warning',
      });
    }
  } catch (err) {
    const msg = (err as Error).message || 'Invalid DOT syntax.';
    const lm = /line\s+(\d+)/i.exec(msg);
    issues.push({ line: lm ? Math.max(0, parseInt(lm[1], 10) - 1) : 0, message: msg, severity: 'error' });
  }
  return issues;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
