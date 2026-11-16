import { escapeXmlAttribute } from './drawioSvg';

interface FlowNode {
  id: string;
  label: string;
  style: string;
  width: number;
  height: number;
  subgraph?: string;
}

interface FlowSubgraph {
  id: string;
  title: string;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  style: string;
}

function xmlCellAttr(text: string): string {
  return escapeXmlAttribute(text);
}

function measureBox(label: string, minW = 120, minH = 54): { width: number; height: number } {
  const lines = label.split(/\r?\n|<br\s*\/?>/i);
  let maxCols = 0;
  for (const line of lines) {
    let cols = 0;
    for (const ch of line) {
      cols += ch.charCodeAt(0) > 0x7f ? 2 : 1;
    }
    maxCols = Math.max(maxCols, cols);
  }
  return {
    width: Math.max(minW, Math.min(280, maxCols * 8 + 36)),
    height: Math.max(minH, lines.length * 22 + 28),
  };
}

function parseNodeToken(raw: string): { id: string; label?: string; style?: string } | undefined {
  const token = raw.trim();
  if (!token) {
    return undefined;
  }
  const patterns: Array<{ re: RegExp; style: string }> = [
    { re: /^([A-Za-z0-9_.-]+)\s*\(\(\s*"?([^")]*?)"?\s*\)\)$/, style: 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\(\[\s*"?([^"\]]*?)"?\s*\]\)$/, style: 'rounded=1;whiteSpace=wrap;html=1;arcSize=50;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\(\s*"?([^")]*?)"?\s*\)\]$/, style: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\[\s*"?([^"\]]*?)"?\s*\]\]$/, style: 'shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\{\{\s*"?([^"}]*?)"?\s*\}\}$/, style: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\{\s*"?([^"}]*?)"?\s*\}$/, style: 'rhombus;whiteSpace=wrap;html=1;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\s*"?([^"\]]*?)"?\s*\]$/, style: 'rounded=1;whiteSpace=wrap;html=1;' },
    { re: /^([A-Za-z0-9_.-]+)\s*\(\s*"?([^")]*?)"?\s*\)$/, style: 'rounded=1;whiteSpace=wrap;html=1;arcSize=24;' },
  ];
  for (const { re, style } of patterns) {
    const m = re.exec(token);
    if (m) {
      return { id: m[1], label: m[2].trim() || m[1], style };
    }
  }
  const bare = /^([A-Za-z0-9_.-]+)$/.exec(token);
  if (bare) {
    return { id: bare[1] };
  }
  return undefined;
}

function edgeStyleFor(op: string): string {
  let style = 'edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;';
  if (op.includes('.')) {
    style += 'dashed=1;';
  }
  if (op.includes('=')) {
    style += 'strokeWidth=2;';
  }
  if (op.startsWith('<')) {
    style += 'startArrow=classic;startFill=1;';
  }
  if (!op.endsWith('>') && !op.endsWith('x') && !op.endsWith('o')) {
    style += 'endArrow=none;';
  }
  return style;
}

function convertSequenceToMxfile(lines: string[]): string {
  const participants: Array<{ id: string; label: string; isActor: boolean }> = [];
  const seen = new Map<string, number>();
  const messages: Array<{ from: string; to: string; text: string; dashed: boolean }> = [];

  const ensureParticipant = (id: string, label?: string, isActor = false) => {
    const cleanId = id.replace(/^["']|["']$/g, '').trim();
    if (!cleanId) {
      return;
    }
    const existing = seen.get(cleanId);
    if (existing !== undefined) {
      if (label) {
        participants[existing].label = label;
      }
      if (isActor) {
        participants[existing].isActor = true;
      }
      return;
    }
    seen.set(cleanId, participants.length);
    participants.push({ id: cleanId, label: (label || cleanId).replace(/^["']|["']$/g, ''), isActor });
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%') || /^(?:autonumber|activate|deactivate|loop|alt|else|opt|par|and|critical|break|rect|end|note|title)\b/i.test(line)) {
      continue;
    }
    const decl = /^(actor|participant)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (decl) {
      ensureParticipant(decl[2], decl[3]?.trim(), decl[1].toLowerCase() === 'actor');
      continue;
    }
    const msg = /^([A-Za-z0-9_.-]+?)\s*(--?>>?|--?[x)])[+-]?\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (msg) {
      ensureParticipant(msg[1]);
      ensureParticipant(msg[3]);
      messages.push({ from: msg[1], to: msg[3], text: msg[4].trim(), dashed: msg[2].startsWith('--') });
    }
  }

  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const spacingX = 200;
  const startX = 80;
  const topY = 60;
  const stepY = 60;
  const lifelineHeight = Math.max(180, messages.length * stepY + 100);

  participants.forEach((p, idx) => {
    const cx = startX + idx * spacingX;
    const cellId = `p_${idx}`;
    const style = p.isActor
      ? 'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;participant=umlActor;size=40;'
      : 'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;';
    cells.push(
      `<mxCell id="${cellId}" value="${xmlCellAttr(p.label)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${cx}" y="${topY}" width="120" height="${lifelineHeight}" as="geometry" /></mxCell>`,
    );
  });

  messages.forEach((m, idx) => {
    const fromIdx = seen.get(m.from) ?? 0;
    const toIdx = seen.get(m.to) ?? 0;
    const y = topY + 70 + idx * stepY;
    const fromX = startX + fromIdx * spacingX + 60;
    const toX = startX + toIdx * spacingX + 60;
    const style = `html=1;verticalAlign=bottom;endArrow=${m.dashed ? 'open' : 'block'};${m.dashed ? 'dashed=1;' : ''}`;
    cells.push(
      `<mxCell id="m_${idx}" value="${xmlCellAttr(m.text)}" style="${style}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${fromX}" y="${y}" as="sourcePoint" /><mxPoint x="${toX}" y="${y}" as="targetPoint" /></mxGeometry></mxCell>`,
    );
  });

  return wrapMxfile(cells);
}

function wrapMxfile(cells: string[]): string {
  return `<mxfile>
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

/**
 * Converts Mermaid diagram syntax (`flowchart`/`graph`, `sequenceDiagram`, `stateDiagram`,
 * etc.) into native, editable draw.io `<mxfile>` XML with positioned vertices, subgraphs,
 * and orthogonal connectors.
 */
export function convertMermaidToDrawioXml(source: string): string {
  const rawLines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));

  if (rawLines.length === 0) {
    return wrapMxfile(['<mxCell id="0" />', '<mxCell id="1" parent="0" />']);
  }

  if (/^sequenceDiagram\b/i.test(rawLines[0])) {
    return convertSequenceToMxfile(rawLines);
  }

  let horizontal = false;
  let reverseDir = false;
  const header = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/i.exec(rawLines[0]);
  if (header) {
    const dir = header[1].toUpperCase();
    horizontal = dir === 'LR' || dir === 'RL';
    reverseDir = dir === 'BT' || dir === 'RL';
  }

  const nodes = new Map<string, FlowNode>();
  const subgraphs = new Map<string, FlowSubgraph>();
  const edges: FlowEdge[] = [];
  const sgStack: string[] = [];

  const upsertNode = (spec: { id: string; label?: string; style?: string }) => {
    const normalizedId = spec.id === '[*]' ? '__start_end__' : spec.id;
    let existing = nodes.get(normalizedId);
    const label = spec.label ?? existing?.label ?? normalizedId;
    const style =
      spec.style ??
      existing?.style ??
      (spec.id === '[*]' ? 'ellipse;html=1;shape=startState;fillColor=#000000;strokeColor=#000000;' : 'rounded=1;whiteSpace=wrap;html=1;');
    const isDiamond = style.startsWith('rhombus');
    const dims = spec.id === '[*]' ? { width: 30, height: 30 } : measureBox(label, isDiamond ? 130 : 120, isDiamond ? 70 : 54);
    const currentSg = sgStack[sgStack.length - 1];
    if (!existing) {
      existing = {
        id: normalizedId,
        label: spec.id === '[*]' ? '' : label,
        style,
        width: dims.width,
        height: dims.height,
        subgraph: currentSg,
      };
      nodes.set(normalizedId, existing);
    } else {
      if (spec.label) {
        existing.label = spec.label;
        existing.width = dims.width;
        existing.height = dims.height;
      }
      if (spec.style) {
        existing.style = spec.style;
      }
      if (!existing.subgraph && currentSg) {
        existing.subgraph = currentSg;
      }
    }
    return existing.id;
  };

  const edgePattern =
    /^(.*?)\s*(?:--\s*([^>-][^-\n]*?)\s*(-->|---|-\.->|==>)|(<-->|<-\.->|<==>|-->|---|-\.->|-\.-|==>|===)(?:\|([^|]*)\|)?)\s*(.+)$/;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (
      i === 0 &&
      /^(?:flowchart|graph|stateDiagram(?:-v2)?|classDiagram(?:-v2)?|erDiagram|mindmap|gantt|pie)\b/i.test(line)
    ) {
      continue;
    }
    if (/^(?:classDef|class|style|linkStyle|click|direction)\b/i.test(line)) {
      continue;
    }
    const sgMatch = /^subgraph\s+(?:([A-Za-z0-9_.-]+)\s*\[\s*"?([^"\]]+)"?\s*\]|"([^"]+)"|(.+))$/i.exec(line);
    if (sgMatch) {
      const id = `sg_${subgraphs.size + 1}`;
      const title = (sgMatch[2] || sgMatch[3] || sgMatch[4] || sgMatch[1] || 'Group').trim();
      subgraphs.set(id, { id, title });
      sgStack.push(id);
      continue;
    }
    if (/^end\b/i.test(line)) {
      sgStack.pop();
      continue;
    }

    // State diagram transition: `StateA --> StateB : label`
    const stateEdge = /^(\[\*\]|[A-Za-z0-9_.-]+)\s*(-->)\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(line);
    if (stateEdge) {
      const fromId = upsertNode({ id: stateEdge[1] });
      const toId = upsertNode({ id: stateEdge[3] });
      edges.push({ from: fromId, to: toId, label: (stateEdge[4] || '').trim(), style: edgeStyleFor('-->') });
      continue;
    }

    // Flowchart chained or single edges.
    let remainder = line;
    let matchedEdge = false;
    const chain: Array<{ nodeRaw: string; op?: string; label?: string }> = [];
    while (true) {
      const m = edgePattern.exec(remainder);
      if (!m) {
        break;
      }
      matchedEdge = true;
      const leftRaw = m[1].trim();
      const op = (m[3] || m[4] || '-->').trim();
      const label = (m[2] ?? m[5] ?? '').trim();
      chain.push({ nodeRaw: leftRaw, op, label });
      remainder = m[6].trim();
    }
    if (matchedEdge) {
      chain.push({ nodeRaw: remainder });
      const ids: string[] = [];
      for (const item of chain) {
        const parsed = parseNodeToken(item.nodeRaw) ?? { id: item.nodeRaw.replace(/[^\w.-]/g, '_') || `n_${nodes.size + 1}`, label: item.nodeRaw };
        ids.push(upsertNode(parsed));
      }
      for (let k = 0; k < chain.length - 1; k++) {
        edges.push({
          from: ids[k],
          to: ids[k + 1],
          label: chain[k].label || '',
          style: edgeStyleFor(chain[k].op || '-->'),
        });
      }
      continue;
    }

    const standalone = parseNodeToken(line);
    if (standalone) {
      upsertNode(standalone);
    }
  }

  if (nodes.size === 0) {
    upsertNode({ id: 'diagram', label: rawLines[0] });
  }

  // Assign layered ranks via longest-path BFS avoiding cycles.
  const ranks = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (e.from !== e.to) {
      adj.get(e.from)?.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      ranks.set(id, 0);
    }
  }
  if (queue.length === 0) {
    const first = nodes.keys().next().value as string;
    queue.push(first);
    ranks.set(first, 0);
  }
  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    const u = queue.shift()!;
    const r = ranks.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        visited.add(v);
        ranks.set(v, r + 1);
        queue.push(v);
      } else if ((ranks.get(v) ?? 0) < r + 1 && (ranks.get(u) ?? 0) <= (ranks.get(v) ?? 0)) {
        ranks.set(v, Math.min(nodes.size, r + 1));
      }
    }
  }
  let maxRank = 0;
  for (const id of nodes.keys()) {
    if (!ranks.has(id)) {
      ranks.set(id, 0);
    }
    maxRank = Math.max(maxRank, ranks.get(id)!);
  }

  const layers = new Map<number, FlowNode[]>();
  for (const node of nodes.values()) {
    const rawRank = ranks.get(node.id) ?? 0;
    const rank = reverseDir ? maxRank - rawRank : rawRank;
    const list = layers.get(rank) ?? [];
    list.push(node);
    layers.set(rank, list);
  }

  const coords = new Map<string, { x: number; y: number }>();
  const rankGap = 190;
  const laneGap = 150;
  const originX = 80;
  const originY = 80;

  for (let r = 0; r <= maxRank; r++) {
    const list = layers.get(r) ?? [];
    list.forEach((node, idx) => {
      const x = horizontal ? originX + r * (rankGap + 40) : originX + idx * (laneGap + 50);
      const y = horizontal ? originY + idx * (laneGap - 10) : originY + r * (rankGap - 40);
      coords.set(node.id, { x, y });
    });
  }

  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const sgBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

  for (const node of nodes.values()) {
    if (!node.subgraph) {
      continue;
    }
    const pos = coords.get(node.id)!;
    const b = sgBounds.get(node.subgraph) ?? {
      minX: pos.x,
      minY: pos.y,
      maxX: pos.x + node.width,
      maxY: pos.y + node.height,
    };
    b.minX = Math.min(b.minX, pos.x);
    b.minY = Math.min(b.minY, pos.y);
    b.maxX = Math.max(b.maxX, pos.x + node.width);
    b.maxY = Math.max(b.maxY, pos.y + node.height);
    sgBounds.set(node.subgraph, b);
  }

  for (const [sgId, sg] of subgraphs) {
    const b = sgBounds.get(sgId);
    if (!b) {
      continue;
    }
    const padX = 24;
    const padTop = 40;
    const padBottom = 24;
    const gx = Math.max(20, b.minX - padX);
    const gy = Math.max(20, b.minY - padTop);
    const gw = b.maxX - b.minX + padX * 2;
    const gh = b.maxY - b.minY + padTop + padBottom;
    cells.push(
      `<mxCell id="${xmlCellAttr(sgId)}" value="${xmlCellAttr(sg.title)}" style="swimlane;whiteSpace=wrap;html=1;startSize=28;rounded=1;" vertex="1" parent="1"><mxGeometry x="${gx}" y="${gy}" width="${gw}" height="${gh}" as="geometry" /></mxCell>`,
    );
    // Convert children to container-relative coordinates.
    for (const node of nodes.values()) {
      if (node.subgraph === sgId) {
        const pos = coords.get(node.id)!;
        coords.set(node.id, { x: pos.x - gx, y: pos.y - gy });
      }
    }
  }

  for (const node of nodes.values()) {
    const pos = coords.get(node.id)!;
    const parentId = node.subgraph && sgBounds.has(node.subgraph) ? node.subgraph : '1';
    cells.push(
      `<mxCell id="v_${xmlCellAttr(node.id)}" value="${xmlCellAttr(node.label)}" style="${node.style}" vertex="1" parent="${xmlCellAttr(parentId)}"><mxGeometry x="${pos.x}" y="${pos.y}" width="${node.width}" height="${node.height}" as="geometry" /></mxCell>`,
    );
  }

  edges.forEach((e, idx) => {
    cells.push(
      `<mxCell id="e_${idx}" value="${xmlCellAttr(e.label)}" style="${e.style}" edge="1" parent="1" source="v_${xmlCellAttr(e.from)}" target="v_${xmlCellAttr(e.to)}"><mxGeometry relative="1" as="geometry" /></mxCell>`,
    );
  });

  return wrapMxfile(cells);
}
