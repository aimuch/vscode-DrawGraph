import { splitDiagrams, stripBlockComments } from '../plantuml/encoder';

export interface DiagramTextLink {
  line: number;
  startCol: number;
  endCol: number;
  target: string;
  kind: 'include' | 'file' | 'symbol' | 'url';
}

export interface TextRangeOffset {
  line: number;
  startCol: number;
  endCol: number;
}

export interface HexColorMatch {
  line: number;
  startCol: number;
  endCol: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface QuickFixEdit {
  title: string;
  kind: 'append' | 'prepend' | 'replace_line';
  line?: number;
  newText: string;
}

export interface C4MacroSignature {
  name: string;
  signature: string;
  documentation: string;
  parameters: Array<{ label: string; doc: string }>;
}

export const C4_MACRO_SIGNATURES: readonly C4MacroSignature[] = [
  {
    name: 'Person',
    signature: 'Person(alias, label, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares an internal human user / actor in C4.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier used in Rel()' },
      { label: 'label', doc: 'Display name of the person' },
      { label: '?descr', doc: 'Optional role description' },
      { label: '?sprite', doc: 'Optional icon sprite' },
      { label: '?tags', doc: 'Optional stereotype tags' },
      { label: '?link', doc: 'Optional hyperlink URL' },
    ],
  },
  {
    name: 'Person_Ext',
    signature: 'Person_Ext(alias, label, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares an external person / customer in C4.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'Display name' },
      { label: '?descr', doc: 'Optional description' },
    ],
  },
  {
    name: 'System',
    signature: 'System(alias, label, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares a software system in C4 Context/Container diagrams.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'System title' },
      { label: '?descr', doc: 'Optional system responsibilities' },
    ],
  },
  {
    name: 'System_Ext',
    signature: 'System_Ext(alias, label, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares an external software system.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'External system title' },
      { label: '?descr', doc: 'Optional description' },
    ],
  },
  {
    name: 'Container',
    signature: 'Container(alias, label, techn, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares an application/service container in C4.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'Container name' },
      { label: 'techn', doc: 'Technology stack (e.g. "Node.js / TypeScript")' },
      { label: '?descr', doc: 'Optional container responsibilities' },
    ],
  },
  {
    name: 'ContainerDb',
    signature: 'ContainerDb(alias, label, techn, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares a database container in C4.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'Database name' },
      { label: 'techn', doc: 'Database engine (e.g. "PostgreSQL 16")' },
      { label: '?descr', doc: 'Optional schema/data description' },
    ],
  },
  {
    name: 'Component',
    signature: 'Component(alias, label, techn, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares a component inside a container.',
    parameters: [
      { label: 'alias', doc: 'Unique identifier' },
      { label: 'label', doc: 'Component name' },
      { label: 'techn', doc: 'Implementation technology' },
      { label: '?descr', doc: 'Optional description' },
    ],
  },
  {
    name: 'System_Boundary',
    signature: 'System_Boundary(alias, label, ?tags, ?link)',
    documentation: 'Groups containers belonging to a single system (`System_Boundary(id, "Title") { ... }`).',
    parameters: [
      { label: 'alias', doc: 'Boundary identifier' },
      { label: 'label', doc: 'Boundary display title' },
    ],
  },
  {
    name: 'Container_Boundary',
    signature: 'Container_Boundary(alias, label, ?tags, ?link)',
    documentation: 'Groups components belonging to a single container.',
    parameters: [
      { label: 'alias', doc: 'Boundary identifier' },
      { label: 'label', doc: 'Boundary display title' },
    ],
  },
  {
    name: 'Rel',
    signature: 'Rel(from, to, label, ?techn, ?descr, ?sprite, ?tags, ?link)',
    documentation: 'Declares a directional relationship between two C4 elements.',
    parameters: [
      { label: 'from', doc: 'Source element alias' },
      { label: 'to', doc: 'Target element alias' },
      { label: 'label', doc: 'Action / relationship label' },
      { label: '?techn', doc: 'Optional protocol (e.g. "gRPC / HTTPS")' },
      { label: '?descr', doc: 'Optional details' },
    ],
  },
];

export const PLANTUML_STDLIB_INCLUDES: ReadonlyArray<readonly [string, string]> = [
  ['<C4/C4_Context>', 'C4 Model — System Context level'],
  ['<C4/C4_Container>', 'C4 Model — Container level'],
  ['<C4/C4_Component>', 'C4 Model — Component level'],
  ['<C4/C4_Deployment>', 'C4 Model — Deployment diagram'],
  ['<C4/C4_Sequence>', 'C4 Model — Sequence diagram'],
  ['<awslib/AWSCommon>', 'AWS Architecture Icons common definitions'],
  ['<azure/AzureCommon>', 'Microsoft Azure Icons common definitions'],
  ['<kubernetes/k8s-sprites-unlabeled-25pct>', 'Kubernetes architecture sprites'],
  ['<tupadr3/font-awesome-5/users>', 'Font Awesome 5 user icon sprite'],
  ['<tupadr3/font-awesome-5/server>', 'Font Awesome 5 server icon sprite'],
];

/**
 * Extracts clickable links (`!include`, `!includesub`, Mermaid `click`, URLs, `#Symbol`,
 * and `path/to/file.ext:line`) with exact line/column spans for `DocumentLinkProvider`.
 */
export function extractDiagramDocumentLinks(text: string, kind: 'mermaid' | 'plantuml'): DiagramTextLink[] {
  const links: DiagramTextLink[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (kind === 'plantuml') {
      const inc = /^(\s*!(?:include|include_many|include_once|includesub)\s+)(?!<)([^\s!']+)(?:![^\s]+)?/i.exec(line);
      if (inc) {
        const startCol = inc[1].length;
        const target = inc[2].trim();
        links.push({
          line: i,
          startCol,
          endCol: startCol + target.length,
          target,
          kind: /^https?:\/\//i.test(target) ? 'url' : 'include',
        });
        continue;
      }
    }

    if (kind === 'mermaid') {
      const clickMatch = /^(\s*click\s+\S+\s+(?:href\s+)?")([^"]+)(")/i.exec(line);
      if (clickMatch) {
        const startCol = clickMatch[1].length;
        const target = clickMatch[2].trim();
        links.push({
          line: i,
          startCol,
          endCol: startCol + target.length,
          target,
          kind: /^https?:\/\//i.test(target) ? 'url' : target.startsWith('#') ? 'symbol' : 'file',
        });
      }
    }

    // Explicit URLs
    const urlRe = /https?:\/\/[^\s)"'<>]+/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(line)) !== null) {
      links.push({
        line: i,
        startCol: m.index,
        endCol: m.index + m[0].length,
        target: m[0],
        kind: 'url',
      });
    }

    // Workspace file:line references (e.g. `src/extension.ts:42` or `flowchart.mmd:1`)
    const fileRefRe =
      /\b((?:[A-Za-z0-9_./-]+\/[A-Za-z0-9_.-]+\.[A-Za-z]{1,8}(?::\d+|#L\d+)?)|(?:[A-Za-z0-9_.-]+\.[A-Za-z]{1,8}(?::\d+|#L\d+)))\b/g;
    while ((m = fileRefRe.exec(line)) !== null) {
      const candidate = m[1];
      const startCol = m.index;
      const overlaps = links.some((l) => l.line === i && startCol < l.endCol && startCol + candidate.length > l.startCol);
      if (!overlaps && !/^(?:http|https)/i.test(candidate)) {
        links.push({
          line: i,
          startCol,
          endCol: startCol + candidate.length,
          target: candidate,
          kind: 'file',
        });
      }
    }
  }

  return links;
}

/**
 * Computes safe within-diagram identifier rename ranges (`F2` Rename Symbol) for a
 * Mermaid or PlantUML document at `(lineIdx, colIdx)`.
 */
export function computeDiagramRenameRanges(
  text: string,
  kind: 'mermaid' | 'plantuml',
  lineIdx: number,
  colIdx: number,
): { oldName: string; ranges: TextRangeOffset[] } | undefined {
  const lines = text.split(/\r?\n/);
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return undefined;
  }
  const targetLine = lines[lineIdx];
  const identRe = /[A-Za-z_][A-Za-z0-9_.-]*/g;
  let selected: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(targetLine)) !== null) {
    if (colIdx >= m.index && colIdx <= m.index + m[0].length) {
      selected = m[0];
      break;
    }
  }
  if (!selected) {
    return undefined;
  }

  const reserved = new Set([
    'flowchart',
    'graph',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'erDiagram',
    'mindmap',
    'gantt',
    'subgraph',
    'end',
    'participant',
    'actor',
    'boundary',
    'control',
    'entity',
    'database',
    'class',
    'interface',
    'enum',
    'package',
    'skinparam',
    'as',
    'startuml',
    'enduml',
    'TB',
    'TD',
    'LR',
    'RL',
    'BT',
  ]);
  if (reserved.has(selected)) {
    return undefined;
  }

  // Scope rename to the active @start...@end block in multi-diagram PlantUML files.
  let startLine = 0;
  let endLine = lines.length - 1;
  if (kind === 'plantuml') {
    const blocks = splitDiagrams(text);
    const active = blocks.find((b) => lineIdx >= b.startLine && lineIdx <= b.endLine);
    if (active) {
      startLine = active.startLine;
      endLine = Math.min(endLine, active.endLine);
    }
  }

  const escaped = selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`, 'g');
  const ranges: TextRangeOffset[] = [];
  let inComment = false;

  for (let i = startLine; i <= endLine; i++) {
    const raw = lines[i];
    if (kind === 'mermaid' && raw.trim().startsWith('%%')) {
      continue;
    }
    if (kind === 'plantuml') {
      const stripped = stripBlockComments(raw, inComment);
      inComment = stripped.inComment;
      if (stripped.code.trim().startsWith("'")) {
        continue;
      }
    }
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(raw)) !== null) {
      ranges.push({ line: i, startCol: m.index, endCol: m.index + selected.length });
    }
  }

  return ranges.length > 0 ? { oldName: selected, ranges } : undefined;
}

/** Extracts `#RGB`, `#RRGGBB`, and `#RRGGBBAA` color literals from Mermaid / PlantUML source. */
export function extractHexColors(text: string): HexColorMatch[] {
  const matches: HexColorMatch[] = [];
  const lines = text.split(/\r?\n/);
  const hexRe = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('%%') || trimmed.startsWith("'")) {
      continue;
    }
    let m: RegExpExecArray | null;
    hexRe.lastIndex = 0;
    while ((m = hexRe.exec(line)) !== null) {
      const hex = m[1];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 1;
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255;
        g = parseInt(hex[1] + hex[1], 16) / 255;
        b = parseInt(hex[2] + hex[2], 16) / 255;
      } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16) / 255;
        g = parseInt(hex.slice(2, 4), 16) / 255;
        b = parseInt(hex.slice(4, 6), 16) / 255;
      } else {
        r = parseInt(hex.slice(0, 2), 16) / 255;
        g = parseInt(hex.slice(2, 4), 16) / 255;
        b = parseInt(hex.slice(4, 6), 16) / 255;
        a = parseInt(hex.slice(6, 8), 16) / 255;
      }
      matches.push({ line: i, startCol: m.index, endCol: m.index + m[0].length, r, g, b, a });
    }
  }
  return matches;
}

export function formatHexColor(r: number, g: number, b: number, a = 1): string {
  const byte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  const rgb = `#${byte(r)}${byte(g)}${byte(b)}`;
  return a < 0.999 ? `${rgb}${byte(a)}` : rgb;
}

/** Computes contextual Quick Fix edits (`CodeActionProvider`) for common syntax errors. */
export function computeDiagramQuickFixes(
  text: string,
  kind: 'mermaid' | 'plantuml',
  diagnosticLine?: number,
): QuickFixEdit[] {
  const fixes: QuickFixEdit[] = [];
  const lines = text.split(/\r?\n/);

  if (kind === 'plantuml') {
    const hasStart = lines.some((l) => /^@start\w+/i.test(l.trim()));
    const hasEnd = lines.some((l) => /^@end\w+/i.test(l.trim()));
    if (hasStart && !hasEnd) {
      const startTag = lines.map((l) => /^@start(\w+)/i.exec(l.trim())).find(Boolean)?.[1] ?? 'uml';
      fixes.push({
        title: `Append missing @end${startTag}`,
        kind: 'append',
        newText: `\n@end${startTag}\n`,
      });
    } else if (!hasStart && text.trim().length > 0) {
      fixes.push({
        title: 'Wrap diagram in @startuml … @enduml',
        kind: 'prepend',
        newText: '@startuml\n',
      });
    }
  } else if (kind === 'mermaid') {
    const firstCode = lines.find((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('%%') && t !== '---';
    });
    if (
      firstCode &&
      !/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|mindmap|pie|gitGraph|C4\w+|timeline|architecture|quadrantChart|xychart|sankey|kanban|packet|block)/i.test(
        firstCode.trim(),
      )
    ) {
      fixes.push({
        title: 'Prepend "flowchart TD" diagram header',
        kind: 'prepend',
        newText: 'flowchart TD\n',
      });
    }
    if (diagnosticLine !== undefined && lines[diagnosticLine]) {
      const badLine = lines[diagnosticLine];
      // Common typo: single `->` in Mermaid flowchart instead of `-->`
      if (/^\s*[A-Za-z0-9_]+\s*->\s*[A-Za-z0-9_]+/.test(badLine) && !badLine.includes('->>')) {
        fixes.push({
          title: 'Replace "->" with Mermaid arrow "-->"',
          kind: 'replace_line',
          line: diagnosticLine,
          newText: badLine.replace(/\s*->\s*/, ' --> '),
        });
      }
    }
  }

  return fixes;
}

/** Computes C4-PlantUML macro signature help (`SignatureHelpProvider`) at the cursor prefix. */
export function computeC4SignatureHelp(
  linePrefix: string,
): { macro: C4MacroSignature; activeParameter: number } | undefined {
  // Scan left-to-right so an unclosed string literal at the cursor never corrupts outer `(` tracking.
  const callStack: Array<{ openIdx: number; commas: number }> = [];
  let inQuotes = false;

  for (let i = 0; i < linePrefix.length; i++) {
    const ch = linePrefix[i];
    if (ch === '"' && linePrefix[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) {
      continue;
    }
    if (ch === '(') {
      callStack.push({ openIdx: i, commas: 0 });
    } else if (ch === ')') {
      callStack.pop();
    } else if (ch === ',' && callStack.length > 0) {
      callStack[callStack.length - 1].commas++;
    }
  }

  const activeCall = callStack[callStack.length - 1];
  if (!activeCall) {
    return undefined;
  }

  const before = linePrefix.slice(0, activeCall.openIdx);
  const fnMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
  if (!fnMatch) {
    return undefined;
  }
  const fnName = fnMatch[1];
  const baseName = fnName.replace(/_(?:Down|Up|Left|Right|D|U|L|R|Back|Neighbor)$/, '');
  const macro = C4_MACRO_SIGNATURES.find((m) => m.name === fnName || m.name === baseName);
  if (!macro) {
    return undefined;
  }

  return {
    macro,
    activeParameter: Math.min(activeCall.commas, Math.max(0, macro.parameters.length - 1)),
  };
}
