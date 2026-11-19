import { splitDiagrams, stripBlockComments } from '../plantuml/encoder';
import { parseD2Graph } from '../renderers/d2Renderer';
import { parseDotGraph } from '../renderers/dotRenderer';
import { parseWaveJson } from '../renderers/wavedromRenderer';

export type OutlineKind = 'diagram' | 'container' | 'class' | 'interface' | 'enum' | 'actor' | 'participant' | 'state' | 'section';

export interface OutlineNode {
  name: string;
  detail?: string;
  kind: OutlineKind;
  startLine: number;
  endLine: number;
  selectionLine: number;
  children: OutlineNode[];
}

export interface MarkdownDiagramFence {
  kind: 'mermaid' | 'plantuml' | 'dot' | 'wavedrom' | 'd2';
  startLine: number;
  endLine: number;
  content: string;
}

/** Parses outline symbols from a Mermaid document. */
export function parseMermaidOutline(text: string): OutlineNode[] {
  const lines = text.split(/\r?\n/);
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  const pushNode = (node: OutlineNode, isContainer = false) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    if (isContainer) {
      stack.push(node);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('%%')) {
      continue;
    }

    if (roots.length === 0 && stack.length === 0) {
      const header =
        /^(flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4\w+|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?)\b(?:\s+(TB|TD|BT|RL|LR))?/i.exec(
          trimmed,
        );
      if (header) {
        pushNode(
          {
            name: header[1],
            detail: header[2] || undefined,
            kind: 'diagram',
            startLine: i,
            endLine: lines.length - 1,
            selectionLine: i,
            children: [],
          },
          true,
        );
        continue;
      }
    }

    const subgraph = /^subgraph\s+(?:([A-Za-z0-9_-]+)\s*\["?([^"\]]+)"?\]|"([^"]+)"|(.+))$/i.exec(trimmed);
    if (subgraph) {
      const label = (subgraph[2] || subgraph[3] || subgraph[4] || subgraph[1] || 'subgraph').trim();
      pushNode({ name: label, detail: 'subgraph', kind: 'container', startLine: i, endLine: i, selectionLine: i, children: [] }, true);
      continue;
    }

    if (/^end\b/i.test(trimmed) && stack.length > 1) {
      const closed = stack.pop()!;
      closed.endLine = i;
      continue;
    }

    const section = /^section\s+(.+)$/i.exec(trimmed);
    if (section) {
      pushNode({ name: section[1].trim(), kind: 'section', startLine: i, endLine: i, selectionLine: i, children: [] });
      continue;
    }

    const seqActor = /^(participant|actor|boundary|control|entity|database|collections|queue)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(trimmed);
    if (seqActor) {
      const kind: OutlineKind = seqActor[1].toLowerCase() === 'actor' ? 'actor' : 'participant';
      const alias = seqActor[3]?.trim().replace(/^["']|["']$/g, '');
      const id = seqActor[2].replace(/^["']|["']$/g, '');
      pushNode({ name: alias || id, detail: alias ? id : seqActor[1], kind, startLine: i, endLine: i, selectionLine: i, children: [] });
      continue;
    }

    const cls = /^class\s+([A-Za-z0-9_~<>-]+)(?:\["?([^"\]]+)"?\])?\s*(\{)?/.exec(trimmed);
    if (cls) {
      pushNode({ name: cls[2] || cls[1], kind: 'class', startLine: i, endLine: i, selectionLine: i, children: [] });
      continue;
    }

    const state = /^state\s+(?:"([^"]+)"\s+as\s+([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+))\b/.exec(trimmed);
    if (state) {
      pushNode({ name: state[1] || state[3] || state[2], kind: 'state', startLine: i, endLine: i, selectionLine: i, children: [] });
    }
  }

  while (stack.length > 0) {
    const open = stack.pop()!;
    if (open.endLine < open.startLine || open.kind === 'diagram') {
      open.endLine = Math.max(open.startLine, lines.length - 1);
    }
  }
  return roots;
}

/** Parses outline symbols from a PlantUML document, grouped by `@start...` blocks. */
export function parsePlantUmlOutline(text: string): OutlineNode[] {
  const blocks = splitDiagrams(text);
  const allLines = text.split(/\r?\n/);
  const result: OutlineNode[] = [];

  blocks.forEach((block, idx) => {
    const firstLine = (allLines[block.startLine] ?? '').trim();
    const startKind = /^@start(\w*)/i.exec(firstLine)?.[1] || 'uml';
    const root: OutlineNode = {
      name: block.title || `Diagram ${idx + 1}`,
      detail: `@start${startKind}`,
      kind: 'diagram',
      startLine: block.startLine,
      endLine: block.endLine,
      selectionLine: block.startLine,
      children: [],
    };

    const stack: OutlineNode[] = [root];
    let inComment = false;

    for (let lineNo = block.startLine; lineNo <= block.endLine && lineNo < allLines.length; lineNo++) {
      const stripped = stripBlockComments(allLines[lineNo], inComment);
      inComment = stripped.inComment;
      const line = stripped.code.trim();
      if (!line || line.startsWith("'") || /^@(?:start|end)\w*/i.test(line)) {
        continue;
      }

      if (line === '}' && stack.length > 1) {
        const closed = stack.pop()!;
        closed.endLine = lineNo;
        continue;
      }

      const container =
        /^(package|namespace|node|folder|frame|cloud|database|rectangle|partition|box)\s+(?:"([^"]+)"|([^\s{]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:.*(\{))?/i.exec(
          line,
        );
      if (container) {
        const node: OutlineNode = {
          name: (container[2] || container[3] || container[4] || container[1]).trim(),
          detail: container[1].toLowerCase(),
          kind: 'container',
          startLine: lineNo,
          endLine: lineNo,
          selectionLine: lineNo,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        if (container[5] || /^box\b/i.test(line)) {
          stack.push(node);
        }
        continue;
      }

      if (/^end\s*box\b/i.test(line) && stack.length > 1) {
        const closed = stack.pop()!;
        closed.endLine = lineNo;
        continue;
      }

      const typeDecl = /^(?:abstract\s+)?(class|interface|enum|entity|struct|protocol|annotation)\s+(?:"([^"]+)"|([A-Za-z0-9_.$<>-]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:.*(\{))?/i.exec(
        line,
      );
      if (typeDecl) {
        const kw = typeDecl[1].toLowerCase();
        const kind: OutlineKind = kw === 'interface' || kw === 'protocol' ? 'interface' : kw === 'enum' ? 'enum' : 'class';
        const node: OutlineNode = {
          name: (typeDecl[2] || typeDecl[3] || typeDecl[4]).trim(),
          detail: kw,
          kind,
          startLine: lineNo,
          endLine: lineNo,
          selectionLine: lineNo,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        if (typeDecl[5]) {
          stack.push(node);
        }
        continue;
      }

      const participant =
        /^(actor\/?|participant|boundary|control|collections|queue|component|usecase\/?|agent)\s+(?:"([^"]+)"|([^\s:]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?/i.exec(
          line,
        );
      if (participant) {
        const kw = participant[1].toLowerCase();
        const node: OutlineNode = {
          name: (participant[2] || participant[3] || participant[4]).trim(),
          detail: participant[4] && participant[2] ? participant[4] : kw,
          kind: kw.startsWith('actor') ? 'actor' : 'participant',
          startLine: lineNo,
          endLine: lineNo,
          selectionLine: lineNo,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        continue;
      }

      const state = /^state\s+(?:"([^"]+)"\s+as\s+([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))(?:\s*(\{))?/i.exec(line);
      if (state) {
        const node: OutlineNode = {
          name: (state[1] || state[3] || state[2]).trim(),
          detail: 'state',
          kind: 'state',
          startLine: lineNo,
          endLine: lineNo,
          selectionLine: lineNo,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        if (state[4]) {
          stack.push(node);
        }
      }
    }

    while (stack.length > 1) {
      const unclosed = stack.pop()!;
      unclosed.endLine = Math.max(unclosed.startLine, block.endLine);
    }

    result.push(root);
  });

  return result;
}

/** Finds ```mermaid, ```plantuml / ```puml, ```dot / ```graphviz, ```wavedrom / ```bitfield, and ```d2 fences in Markdown. */
export function findMarkdownDiagramFences(text: string): MarkdownDiagramFence[] {
  const lines = text.split(/\r?\n/);
  const fences: MarkdownDiagramFence[] = [];
  let active: { kind: MarkdownDiagramFence['kind']; marker: string; startLine: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!active) {
      const open = /^\s*(`{3,}|~{3,})\s*(mermaid|plantuml|puml|dot|graphviz|wavedrom|bitfield|d2)(?:\s+.*)?$/i.exec(line);
      if (open) {
        const lang = open[2].toLowerCase();
        const kind: MarkdownDiagramFence['kind'] =
          lang === 'mermaid'
            ? 'mermaid'
            : lang === 'dot' || lang === 'graphviz'
              ? 'dot'
              : lang === 'wavedrom' || lang === 'bitfield'
                ? 'wavedrom'
                : lang === 'd2'
                  ? 'd2'
                  : 'plantuml';
        active = {
          kind,
          marker: open[1],
          startLine: i,
        };
      }
    } else {
      const ch = active.marker[0];
      const closeRe = new RegExp(`^\\s*\\${ch}{${active.marker.length},}\\s*$`);
      if (closeRe.test(line)) {
        fences.push({
          kind: active.kind,
          startLine: active.startLine,
          endLine: i,
          content: lines.slice(active.startLine + 1, i).join('\n'),
        });
        active = undefined;
      }
    }
  }
  return fences;
}

export function parseDotOutline(text: string): OutlineNode[] {
  try {
    const g = parseDotGraph(text);
    const totalLines = Math.max(0, text.split(/\r?\n/).length - 1);
    const root: OutlineNode = {
      name: g.id,
      detail: g.directed ? `digraph (${g.rankdir})` : `graph (${g.rankdir})`,
      kind: 'diagram',
      startLine: 0,
      endLine: totalLines,
      selectionLine: 0,
      children: [],
    };
    const clustered = new Set<string>();
    for (const cl of g.clusters) {
      const cNode: OutlineNode = {
        name: cl.label || cl.id,
        detail: 'cluster',
        kind: 'container',
        startLine: cl.line,
        endLine: cl.line,
        selectionLine: cl.line,
        children: [],
      };
      for (const nid of cl.nodeIds) {
        const nd = g.nodes.get(nid);
        if (nd) {
          clustered.add(nid);
          cNode.children.push({
            name: nd.label || nd.id,
            detail: nd.shape,
            kind: 'participant',
            startLine: nd.line,
            endLine: nd.line,
            selectionLine: nd.line,
            children: [],
          });
        }
      }
      root.children.push(cNode);
    }
    for (const nd of g.nodes.values()) {
      if (!clustered.has(nd.id)) {
        root.children.push({
          name: nd.label || nd.id,
          detail: nd.shape,
          kind: 'participant',
          startLine: nd.line,
          endLine: nd.line,
          selectionLine: nd.line,
          children: [],
        });
      }
    }
    return [root];
  } catch {
    return [];
  }
}

export function parseWaveDromOutline(text: string): OutlineNode[] {
  try {
    const doc = parseWaveJson(text);
    const totalLines = Math.max(0, text.split(/\r?\n/).length - 1);
    if (Array.isArray(doc.reg)) {
      return [
        {
          name: doc.head?.text || 'Register BitField',
          detail: 'reg',
          kind: 'diagram',
          startLine: 0,
          endLine: totalLines,
          selectionLine: 0,
          children: doc.reg
            .filter((r) => r.name !== undefined)
            .map((r) => ({
              name: String(r.name),
              detail: `${r.bits}b${r.attr ? ` (${Array.isArray(r.attr) ? r.attr.join(',') : r.attr})` : ''}`,
              kind: 'participant',
              startLine: 0,
              endLine: 0,
              selectionLine: 0,
              children: [],
            })),
        },
      ];
    }
    if (Array.isArray(doc.signal)) {
      const children: OutlineNode[] = [];
      for (const item of doc.signal) {
        if (Array.isArray(item)) {
          const [grp, ...rest] = item;
          children.push({
            name: String(grp),
            detail: 'group',
            kind: 'container',
            startLine: 0,
            endLine: 0,
            selectionLine: 0,
            children: rest
              .filter((s): s is { name?: string; wave?: string } => !Array.isArray(s) && Boolean(s?.name))
              .map((s) => ({
                name: String(s.name),
                detail: s.wave || '',
                kind: 'participant',
                startLine: 0,
                endLine: 0,
                selectionLine: 0,
                children: [],
              })),
          });
        } else if (item && 'name' in item && item.name) {
          children.push({
            name: String(item.name),
            detail: item.wave || '',
            kind: 'participant',
            startLine: 0,
            endLine: 0,
            selectionLine: 0,
            children: [],
          });
        }
      }
      return [
        {
          name: doc.head?.text || 'Timing Waveform',
          detail: 'signal',
          kind: 'diagram',
          startLine: 0,
          endLine: totalLines,
          selectionLine: 0,
          children,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/** Parses outline symbols from a D2 diagram document. */
export function parseD2Outline(text: string): OutlineNode[] {
  try {
    const g = parseD2Graph(text);
    const totalLines = Math.max(0, text.split(/\r?\n/).length - 1);
    const byId = new Map<string, OutlineNode>();
    const roots: OutlineNode[] = [];

    for (const node of g.nodes.values()) {
      const outline: OutlineNode = {
        name: node.label || node.id,
        detail: node.isContainer ? 'container' : node.shape,
        kind: node.isContainer ? 'container' : node.shape === 'sql_table' || node.shape === 'class' ? 'class' : 'participant',
        startLine: node.line,
        endLine: node.line,
        selectionLine: node.line,
        children: [],
      };
      byId.set(node.id, outline);
    }

    for (const node of g.nodes.values()) {
      const outline = byId.get(node.id)!;
      if (node.parentId && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(outline);
      } else {
        roots.push(outline);
      }
    }

    return [
      {
        name: 'D2 Diagram',
        detail: `direction: ${g.direction}`,
        kind: 'diagram',
        startLine: 0,
        endLine: totalLines,
        selectionLine: 0,
        children: roots,
      },
    ];
  } catch {
    return [];
  }
}

/** Extracts a 1-based line number from a Mermaid parser error message. */
export function extractMermaidErrorLine(message: string, hashLine?: number): number | undefined {
  if (typeof hashLine === 'number' && Number.isFinite(hashLine) && hashLine >= 1) {
    return Math.floor(hashLine);
  }
  const m = /(?:Parse error on line|Error .*? line|line)\s+(\d+)/i.exec(message);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1) {
      return n;
    }
  }
  return undefined;
}
