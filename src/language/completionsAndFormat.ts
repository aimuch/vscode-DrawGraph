import { stripBlockComments } from '../plantuml/encoder';

export interface CompletionCandidate {
  label: string;
  insertText?: string;
  detail?: string;
  kind: 'keyword' | 'theme' | 'directive' | 'identifier' | 'property';
}

const MERMAID_DIAGRAM_HEADERS = [
  ['flowchart TD', 'Top-down flowchart'],
  ['flowchart LR', 'Left-to-right flowchart'],
  ['sequenceDiagram', 'Sequence diagram'],
  ['classDiagram', 'Class diagram'],
  ['stateDiagram-v2', 'State diagram'],
  ['erDiagram', 'Entity-relationship diagram'],
  ['gantt', 'Gantt schedule chart'],
  ['mindmap', 'Hierarchical mindmap'],
  ['pie showData', 'Pie chart'],
  ['gitGraph', 'Git commit graph'],
  ['C4Context', 'C4 Context diagram'],
  ['timeline', 'Timeline diagram'],
  ['architecture-beta', 'Architecture diagram'],
] as const;

const MERMAID_KEYWORDS = [
  'subgraph',
  'end',
  'direction',
  'participant',
  'actor',
  'note over',
  'note left of',
  'note right of',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'critical',
  'rect',
  'activate',
  'deactivate',
  'autonumber',
  'classDef',
  'class',
  'style',
  'linkStyle',
] as const;

const PLANTUML_THEMES = [
  'plain',
  'cerulean',
  'cerulean-outline',
  'blueprint',
  'mars',
  'materia',
  'sketchy-outline',
  'toy',
  'vibrant',
  'hacker',
  'carbon-gray',
  'amiga',
  'aws-orange',
] as const;

const PLANTUML_DIRECTIVES = [
  ['!theme ', 'Apply a built-in PlantUML theme'],
  ['!include ', 'Include another PlantUML file or URL'],
  ['!includesub ', 'Include a named @startsub section'],
  ['!define ', 'Define a preprocessor macro'],
  ['!pragma layout smetana', 'Render without Graphviz using built-in Smetana engine'],
] as const;

const PLANTUML_SKINPARAMS = [
  ['backgroundColor transparent', 'Transparent diagram background'],
  ['linetype ortho', 'Orthogonal right-angle connectors'],
  ['linetype polyline', 'Straight polyline connectors'],
  ['shadowing false', 'Disable drop shadows'],
  ['handwritten true', 'Sketch / handwritten style'],
  ['monochrome true', 'Grayscale rendering'],
  ['responseMessageBelowArrow true', 'Draw return messages below request arrows'],
  ['SequenceMessageAlign center', 'Center labels on sequence arrows'],
  ['roundcorner 10', 'Rounded rectangle corners'],
  ['dpi 150', 'Higher output resolution'],
] as const;

const PLANTUML_KEYWORDS = [
  'actor',
  'participant',
  'boundary',
  'control',
  'entity',
  'database',
  'collections',
  'queue',
  'component',
  'interface',
  'abstract class',
  'class',
  'enum',
  'package',
  'namespace',
  'node',
  'cloud',
  'rectangle',
  'frame',
  'folder',
  'state',
  'usecase',
  'title',
  'header',
  'footer',
  'legend',
  'caption',
  'autonumber',
  'newpage',
  'left to right direction',
  'top to bottom direction',
  'skinparam',
  'activate',
  'deactivate',
  'alt',
  'else',
  'opt',
  'loop',
  'par',
  'group',
  'box',
  'note left',
  'note right',
  'note over',
] as const;

/** Extracts declared node, participant, actor, and class identifiers from Mermaid source. */
export function extractMermaidIdentifiers(text: string): string[] {
  const ids = new Set<string>();
  const reserved = new Set([
    'flowchart',
    'graph',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'erDiagram',
    'gantt',
    'mindmap',
    'pie',
    'gitGraph',
    'subgraph',
    'end',
    'direction',
    'TB',
    'TD',
    'BT',
    'RL',
    'LR',
    'participant',
    'actor',
    'as',
    'loop',
    'alt',
    'else',
    'opt',
    'par',
    'and',
    'rect',
    'note',
    'over',
    'class',
    'classDef',
    'style',
    'linkStyle',
    'state',
    'section',
    'title',
  ]);

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) {
      continue;
    }
    const actorDecl = /^(?:participant|actor|boundary|control|entity|database|collections|queue)\s+([A-Za-z0-9_.-]+)/i.exec(line);
    if (actorDecl && !reserved.has(actorDecl[1])) {
      ids.add(actorDecl[1]);
      continue;
    }
    const classDecl = /^class\s+([A-Za-z0-9_.-]+)/.exec(line);
    if (classDecl && !reserved.has(classDecl[1])) {
      ids.add(classDecl[1]);
      continue;
    }
    const tokenRe = /\b([A-Za-z][A-Za-z0-9_.-]*)\s*(?:[\[\(\{]|-->|---|-\.->|==>|-\.-|->>|-->>)/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(line)) !== null) {
      if (!reserved.has(m[1])) {
        ids.add(m[1]);
      }
    }
  }
  return [...ids];
}

/** Extracts declared participant, actor, alias, class, and component identifiers from PlantUML source. */
export function extractPlantUmlIdentifiers(text: string): string[] {
  const ids = new Set<string>();
  let inComment = false;
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripBlockComments(raw, inComment);
    inComment = stripped.inComment;
    const line = stripped.code.trim();
    if (!line || line.startsWith("'") || line.startsWith('@') || line.startsWith('!')) {
      continue;
    }
    const aliasMatch = /\bas\s+([A-Za-z_][A-Za-z0-9_.]*)\b/.exec(line);
    if (aliasMatch) {
      ids.add(aliasMatch[1]);
    }
    const declMatch =
      /^(?:actor\/?|participant|boundary|control|entity|database|collections|queue|component|class|interface|enum|state|object)\s+([A-Za-z_][A-Za-z0-9_.]*)\b/i.exec(
        line,
      );
    if (declMatch) {
      ids.add(declMatch[1]);
    }
  }
  return [...ids];
}

/** Collects context-aware completion candidates for a Mermaid line prefix. */
export function collectMermaidCompletions(text: string, linePrefix: string): CompletionCandidate[] {
  const trimmed = linePrefix.trimStart();
  if (trimmed.startsWith('%%{')) {
    return [
      {
        label: "init: {'theme': 'default'}%%",
        detail: 'Mermaid directive',
        kind: 'directive',
      },
      {
        label: "init: {'flowchart': {'curve': 'basis'}}%%",
        detail: 'Smooth curved flowchart edges',
        kind: 'directive',
      },
    ];
  }

  const out: CompletionCandidate[] = [];
  const hasHeader = text
    .split(/\r?\n/)
    .some((l) => /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|mindmap|pie|gitGraph|C4\w+|timeline|architecture)/i.test(l.trim()));

  if (!hasHeader) {
    for (const [hdr, detail] of MERMAID_DIAGRAM_HEADERS) {
      out.push({ label: hdr, detail, kind: 'keyword' });
    }
  }
  for (const kw of MERMAID_KEYWORDS) {
    out.push({ label: kw, kind: 'keyword' });
  }
  for (const id of extractMermaidIdentifiers(text)) {
    out.push({ label: id, detail: 'Diagram node / participant', kind: 'identifier' });
  }
  return out;
}

/** Collects context-aware completion candidates for a PlantUML line prefix. */
export function collectPlantUmlCompletions(text: string, linePrefix: string): CompletionCandidate[] {
  const trimmed = linePrefix.trimStart();
  if (/^!theme\s+\S*$/i.test(trimmed)) {
    return PLANTUML_THEMES.map((t) => ({ label: t, detail: 'PlantUML theme', kind: 'theme' }));
  }
  if (/^skinparam\s+\S*$/i.test(trimmed)) {
    return PLANTUML_SKINPARAMS.map(([prop, detail]) => ({ label: prop, detail, kind: 'property' }));
  }
  if (trimmed.startsWith('!')) {
    return PLANTUML_DIRECTIVES.map(([dir, detail]) => ({
      label: dir.trim(),
      insertText: dir.slice(1),
      detail,
      kind: 'directive',
    }));
  }
  if (trimmed.startsWith('@')) {
    return [
      '@startuml',
      '@enduml',
      '@startmindmap',
      '@endmindmap',
      '@startwbs',
      '@endwbs',
      '@startgantt',
      '@endgantt',
      '@startjson',
      '@endjson',
      '@startyaml',
      '@endyaml',
    ].map((tag) => ({ label: tag, insertText: tag.slice(1), detail: 'Diagram boundary', kind: 'keyword' }));
  }

  const out: CompletionCandidate[] = [];
  for (const kw of PLANTUML_KEYWORDS) {
    out.push({ label: kw, kind: 'keyword' });
  }
  for (const id of extractPlantUmlIdentifiers(text)) {
    out.push({ label: id, detail: 'Diagram participant / element', kind: 'identifier' });
  }
  return out;
}

/**
 * Formats Mermaid source code with consistent block indentation while leaving
 * indentation-sensitive diagram types (`mindmap`, YAML frontmatter) untouched.
 */
export function formatMermaidSource(text: string, indentUnit = '    '): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  // Do not re-indent mindmaps or kanban boards where leading spaces define tree hierarchy.
  const firstCode = lines.map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('%%') && l !== '---');
  if (firstCode && /^(?:mindmap|kanban)\b/i.test(firstCode)) {
    return lines.map((l) => l.replace(/[ \t]+$/, '')).join(eol);
  }

  const out: string[] = [];
  let inFrontmatter = false;
  let seenHeader = false;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      out.push('---');
      continue;
    }
    if (inFrontmatter) {
      out.push(raw.replace(/[ \t]+$/, ''));
      if (trimmed === '---') {
        inFrontmatter = false;
      }
      continue;
    }
    if (!trimmed) {
      out.push('');
      continue;
    }
    if (trimmed.startsWith('%%{') && trimmed.endsWith('}%%')) {
      out.push(trimmed);
      continue;
    }

    if (!seenHeader && !trimmed.startsWith('%%')) {
      seenHeader = true;
      out.push(trimmed);
      depth = 1;
      continue;
    }

    const isDedentAndReindent = /^(?:else|and)\b/i.test(trimmed);
    const isClosing = /^(?:end|\})$/i.test(trimmed);
    const isSection = /^section\b/i.test(trimmed);

    if (isClosing) {
      depth = Math.max(1, depth - 1);
    }
    const lineDepth = isDedentAndReindent ? Math.max(1, depth - 1) : isSection ? 1 : depth;
    out.push(indentUnit.repeat(lineDepth) + trimmed);

    if (isSection) {
      depth = 2;
    } else if (/^(?:subgraph|loop|alt|opt|par|critical|break|rect|box)\b/i.test(trimmed) || trimmed.endsWith('{')) {
      depth++;
    }
  }

  return out.join(eol);
}

/**
 * Formats PlantUML source code with structured indentation across `@start.../@end...`
 * blocks while preserving block comments and whitespace-sensitive diagram flavors.
 */
export function formatPlantUmlSource(text: string, indentUnit = '  '): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  let inComment = false;
  let passthroughBlock = false;
  let depth = 0;

  for (const raw of lines) {
    const trimmedRight = raw.replace(/[ \t]+$/, '');
    const trimmed = trimmedRight.trim();

    if (inComment) {
      out.push(trimmedRight);
      if (trimmed.includes("'/")) {
        inComment = false;
      }
      continue;
    }
    if (!trimmed) {
      out.push('');
      continue;
    }
    if (trimmed.startsWith("/'") && !trimmed.includes("'/")) {
      inComment = true;
      out.push(indentUnit.repeat(depth) + trimmed);
      continue;
    }

    const startMatch = /^@start(\w*)/i.exec(trimmed);
    if (startMatch && startMatch[1].toLowerCase() !== 'sub') {
      const kind = (startMatch[1] || 'uml').toLowerCase();
      passthroughBlock = ['mindmap', 'wbs', 'yaml', 'json', 'salt', 'ditaa', 'dot'].includes(kind);
      depth = 0;
      out.push(trimmed);
      continue;
    }
    if (/^@end(\w*)/i.test(trimmed) && !/^@endsub\b/i.test(trimmed)) {
      passthroughBlock = false;
      depth = 0;
      out.push(trimmed);
      continue;
    }

    if (passthroughBlock) {
      out.push(trimmedRight);
      continue;
    }

    const isMidBranch = /^(?:else|elseif|fork\s+again|split\s+again|case)\b/i.test(trimmed);
    const isBlockClose =
      trimmed.startsWith('}') ||
      /^(?:endif|endwhile|endfork|end\s+fork|end\s+split|endswitch|end\s*note|endnote|end\s*hnote|end\s*rnote|end\s*ref|endlegend|end\s*box|@endsub)\b/i.test(
        trimmed,
      ) ||
      /^end$/i.test(trimmed) ||
      /^repeat\s+while\b/i.test(trimmed);

    if (isBlockClose) {
      depth = Math.max(0, depth - 1);
    }
    const lineDepth = isMidBranch ? Math.max(0, depth - 1) : depth;
    out.push(indentUnit.repeat(lineDepth) + trimmed);

    const opensBrace = trimmed.endsWith('{') && !trimmed.startsWith("'");
    const opensKeyword =
      /^(?:if\b.*?\bthen\b|while\b|repeat$|fork$|split$|switch\b|alt\b|opt\b|loop\b|par\b|par2\b|critical\b|group\b|box\b|legend$|@startsub\b)/i.test(
        trimmed,
      ) || /^(?:note|hnote|rnote|ref)\b(?!.*:)/i.test(trimmed);

    if (opensBrace || opensKeyword) {
      depth++;
    }
  }

  return out.join(eol);
}
