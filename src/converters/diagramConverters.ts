import { stripBlockComments } from '../plantuml/encoder';

/**
 * Converts PlantUML source (`@startuml` sequence, class, activity/component, or `@startmindmap`)
 * into idiomatic Mermaid syntax.
 */
export function convertPlantUmlToMermaid(rawSource: string): string {
  const rawLines = rawSource.split(/\r?\n/);
  const lines: string[] = [];
  let inComment = false;
  let isMindmap = false;

  for (const raw of rawLines) {
    const stripped = stripBlockComments(raw, inComment);
    inComment = stripped.inComment;
    const trimmed = stripped.code.trim();
    if (!trimmed) {
      continue;
    }
    if (/^@startmindmap\b/i.test(trimmed)) {
      isMindmap = true;
      continue;
    }
    if (/^@(?:start|end)\w*/i.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("'")) {
      lines.push(`%% ${trimmed.slice(1).trim()}`);
      continue;
    }
    if (trimmed.startsWith('!') || /^skinparam\b/i.test(trimmed) || /^(?:hide|scale)\b/i.test(trimmed)) {
      continue;
    }
    lines.push(stripped.code);
  }

  if (isMindmap) {
    const out = ['mindmap'];
    for (const raw of lines) {
      const t = raw.trim();
      if (t.startsWith('%%')) {
        out.push(`  ${t}`);
        continue;
      }
      const m = /^([*+-]+)\s*(.+)$/.exec(t);
      if (m) {
        const depth = Math.max(1, m[1].length);
        out.push(`${'  '.repeat(depth)}${m[2].trim()}`);
      }
    }
    return out.join('\n') + '\n';
  }

  // Detect flavor: class diagram vs sequence diagram vs flowchart/activity.
  const joined = lines.join('\n');
  const looksLikeClass =
    /\b(?:class|interface|enum|abstract\s+class)\s+[A-Za-z0-9_."]+/i.test(joined) ||
    /<\|--|\.\.\|>|\*--|o--/.test(joined);
  const looksLikeSequence =
    !looksLikeClass &&
    (/\b(?:actor|participant|boundary|control|entity|autonumber)\b/i.test(joined) ||
      /^\s*[A-Za-z0-9_."]+\s*-+>+\s*[A-Za-z0-9_."]+\s*:/m.test(joined));

  if (looksLikeClass) {
    const out = ['classDiagram'];
    let inClassBody = false;
    for (const raw of lines) {
      const t = raw.trim();
      if (t.startsWith('%%')) {
        out.push(`  ${t}`);
        continue;
      }
      const iface = /^(?:interface)\s+"?([A-Za-z0-9_]+)"?(?:\s+as\s+([A-Za-z0-9_]+))?\s*(\{)?/i.exec(t);
      if (iface) {
        const name = iface[2] || iface[1];
        out.push(`  class ${name} {`);
        out.push('    <<interface>>');
        if (!iface[3]) {
          out.push('  }');
        } else {
          inClassBody = true;
        }
        continue;
      }
      const enumDecl = /^enum\s+"?([A-Za-z0-9_]+)"?\s*(\{)?/i.exec(t);
      if (enumDecl) {
        out.push(`  class ${enumDecl[1]} {`);
        out.push('    <<enumeration>>');
        if (!enumDecl[2]) {
          out.push('  }');
        } else {
          inClassBody = true;
        }
        continue;
      }
      const cls = /^(?:abstract\s+)?class\s+"?([A-Za-z0-9_]+)"?(?:\s+as\s+([A-Za-z0-9_]+))?\s*(\{)?/i.exec(t);
      if (cls) {
        const name = cls[2] || cls[1];
        if (cls[3]) {
          out.push(`  class ${name} {`);
          inClassBody = true;
        } else {
          out.push(`  class ${name}`);
        }
        continue;
      }
      if (inClassBody && t === '}') {
        out.push('  }');
        inClassBody = false;
        continue;
      }
      if (inClassBody) {
        out.push(`    ${t}`);
        continue;
      }
      const rel = /^"?([A-Za-z0-9_]+)"?\s*(<\|--|--\|>|\.\.\|>|<\|\.\.|\*--|o--|-->|\.\.>|--)\s*"?([A-Za-z0-9_]+)"?(?:\s*:\s*(.+))?$/.exec(t);
      if (rel) {
        const op = rel[2] === '--|>' ? '--|>' : rel[2] === '<|..' ? '<|..' : rel[2];
        const lbl = rel[4] ? ` : ${rel[4].trim()}` : '';
        out.push(`  ${rel[1]} ${op} ${rel[3]}${lbl}`);
      }
    }
    return out.join('\n') + '\n';
  }

  if (looksLikeSequence) {
    const out = ['sequenceDiagram'];
    for (const raw of lines) {
      const t = raw.trim();
      if (t.startsWith('%%')) {
        out.push(`  ${t}`);
        continue;
      }
      if (/^autonumber\b/i.test(t)) {
        out.push('  autonumber');
        continue;
      }
      const decl = /^(actor|participant|boundary|control|entity|database|collections|queue)\s+(?:"([^"]+)"|(\S+))(?:\s+as\s+(\S+))?$/i.exec(t);
      if (decl) {
        const kw = decl[1].toLowerCase() === 'actor' ? 'actor' : 'participant';
        const rawLabel = decl[2] || decl[3];
        const alias = decl[4];
        if (alias) {
          out.push(`  ${kw} ${alias} as ${rawLabel}`);
        } else {
          out.push(`  ${kw} ${rawLabel}`);
        }
        continue;
      }
      if (/^(?:alt|else|opt|loop|par|critical|break|end)\b/i.test(t)) {
        out.push(`  ${t}`);
        continue;
      }
      if (/^(?:activate|deactivate)\s+/i.test(t)) {
        out.push(`  ${t}`);
        continue;
      }
      const note = /^note\s+(left of|right of|over)\s+([^:]+)\s*:\s*(.+)$/i.exec(t);
      if (note) {
        out.push(`  Note ${note[1]} ${note[2].trim()}: ${note[3].trim()}`);
        continue;
      }
      const msg = /^"?([A-Za-z0-9_.-]+)"?\s*(--?>?>?|<--?)\s*"?([A-Za-z0-9_.-]+)"?\s*:\s*(.*)$/.exec(t);
      if (msg) {
        const rawOp = msg[2];
        if (rawOp.startsWith('<')) {
          const arrow = rawOp.includes('--') ? '-->>' : '->>';
          out.push(`  ${msg[3]}${arrow}${msg[1]}: ${msg[4].trim()}`);
        } else {
          const arrow = rawOp.startsWith('--') ? '-->>' : '->>';
          out.push(`  ${msg[1]}${arrow}${msg[3]}: ${msg[4].trim()}`);
        }
      }
    }
    return out.join('\n') + '\n';
  }

  // Fallback: Flowchart / Component / Activity conversion
  const dir = /\bleft\s+to\s+right\s+direction\b/i.test(joined) ? 'LR' : 'TD';
  const out = [`flowchart ${dir}`];
  let stepIdx = 0;
  let prevId: string | undefined;

  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('%%') || /^(?:left\s+to\s+right|top\s+to\s+bottom)\s+direction\b/i.test(t)) {
      continue;
    }
    if (/^start$/i.test(t)) {
      prevId = 'Start';
      out.push('  Start([Start])');
      continue;
    }
    if (/^stop$|^end$/i.test(t)) {
      const stopId = 'End';
      out.push('  End([End])');
      if (prevId) {
        out.push(`  ${prevId} --> ${stopId}`);
      }
      prevId = undefined;
      continue;
    }
    const act = /^:(.+?);$/.exec(t);
    if (act) {
      const id = `S${++stepIdx}`;
      out.push(`  ${id}["${act[1].replace(/"/g, "'")}"]`);
      if (prevId) {
        out.push(`  ${prevId} --> ${id}`);
      }
      prevId = id;
      continue;
    }
    const compEdge = /^\[?("?[^\]"-]+"?)\]?\s*(--?>|\.\.>)\s*\[?("?[^\]"-]+"?)\]?(?:\s*:\s*(.+))?$/.exec(t);
    if (compEdge) {
      const clean = (s: string) => s.replace(/^["'\[]|["'\]]$/g, '').trim();
      const lLabel = clean(compEdge[1]);
      const rLabel = clean(compEdge[3]);
      const lId = lLabel.replace(/[^\w]/g, '_') || `N${++stepIdx}`;
      const rId = rLabel.replace(/[^\w]/g, '_') || `N${++stepIdx}`;
      const arrow = compEdge[2].includes('.') ? '-.->' : '-->';
      const edgeLbl = compEdge[4] ? `|${compEdge[4].trim()}|` : '';
      out.push(`  ${lId}["${lLabel}"] ${arrow}${edgeLbl} ${rId}["${rLabel}"]`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Converts Mermaid source (`sequenceDiagram`, `classDiagram`, `flowchart`/`graph`, or `mindmap`)
 * into idiomatic PlantUML (`@startuml ... @enduml` or `@startmindmap ... @endmindmap`).
 */
export function convertMermaidToPlantUml(rawSource: string): string {
  const lines = rawSource.split(/\r?\n/);
  const codeLines = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith('---'));
  const firstHeader = codeLines.find((l) => !l.trim().startsWith('%%'))?.trim() ?? '';

  if (/^mindmap\b/i.test(firstHeader)) {
    const out = ['@startmindmap'];
    const indents: number[] = [];
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^mindmap\b/i.test(t) || t.startsWith('%%')) {
        continue;
      }
      const spaces = raw.match(/^\s*/)?.[0].length ?? 0;
      while (indents.length > 0 && indents[indents.length - 1] >= spaces) {
        indents.pop();
      }
      indents.push(spaces);
      const cleanLabel = t.replace(/^([A-Za-z0-9_-]+)\(\((.+)\)\)$/, '$2').replace(/^([A-Za-z0-9_-]+)\[(.+)\]$/, '$2');
      out.push(`${'*'.repeat(indents.length)} ${cleanLabel}`);
    }
    out.push('@endmindmap');
    return out.join('\n') + '\n';
  }

  if (/^sequenceDiagram\b/i.test(firstHeader)) {
    const out = ['@startuml'];
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^sequenceDiagram\b/i.test(t)) {
        continue;
      }
      if (t.startsWith('%%')) {
        out.push(`' ${t.slice(2).trim()}`);
        continue;
      }
      const decl = /^(actor|participant)\s+(\S+)(?:\s+as\s+(.+))?$/i.exec(t);
      if (decl) {
        const kw = decl[1].toLowerCase();
        const id = decl[2];
        const alias = decl[3]?.trim();
        if (alias) {
          out.push(`${kw} "${alias.replace(/"/g, '')}" as ${id}`);
        } else {
          out.push(`${kw} ${id}`);
        }
        continue;
      }
      const note = /^Note\s+(left of|right of|over)\s+([^:]+):\s*(.+)$/i.exec(t);
      if (note) {
        out.push(`note ${note[1].toLowerCase()} ${note[2].trim()} : ${note[3].trim()}`);
        continue;
      }
      const msg = /^([A-Za-z0-9_.-]+?)\s*(--?>>?|--?[x)])([+-])?\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(t);
      if (msg) {
        const arrow = msg[2].startsWith('--') ? '-->' : '->';
        out.push(`${msg[1]} ${arrow} ${msg[4]} : ${msg[5].trim()}`);
        if (msg[3] === '+') {
          out.push(`activate ${msg[4]}`);
        } else if (msg[3] === '-') {
          out.push(`deactivate ${msg[1]}`);
        }
        continue;
      }
      out.push(t);
    }
    out.push('@enduml');
    return out.join('\n') + '\n';
  }

  if (/^classDiagram\b/i.test(firstHeader)) {
    const out = ['@startuml'];
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^classDiagram(?:-v2)?\b/i.test(t)) {
        continue;
      }
      if (t.startsWith('%%')) {
        out.push(`' ${t.slice(2).trim()}`);
        continue;
      }
      if (t === '<<interface>>' || t === '<<enumeration>>') {
        continue;
      }
      out.push(t);
    }
    out.push('@enduml');
    return out.join('\n') + '\n';
  }

  // Default: Flowchart / Graph -> PlantUML component/rectangle diagram
  const out = ['@startuml'];
  if (/^(?:flowchart|graph)\s+(?:LR|RL)\b/i.test(firstHeader)) {
    out.push('left to right direction');
  }
  const declared = new Set<string>();
  const ensureRect = (id: string, label?: string) => {
    if (!declared.has(id)) {
      declared.add(id);
      const display = (label || id).replace(/"/g, "'");
      out.push(`rectangle "${display}" as ${id}`);
    }
  };
  const nodeRe = /^([A-Za-z0-9_.-]+)(?:\s*[\[\(\{]+([^\]\)\}]+)[\]\)\}]+)?$/;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t || /^(?:flowchart|graph)\b/i.test(t) || /^(?:classDef|class|style|linkStyle)\b/i.test(t)) {
      continue;
    }
    if (t.startsWith('%%')) {
      out.push(`' ${t.slice(2).trim()}`);
      continue;
    }
    const sg = /^subgraph\s+(?:([A-Za-z0-9_.-]+)\s*\["?([^"\]]+)"?\]|"([^"]+)"|(.+))$/i.exec(t);
    if (sg) {
      const title = (sg[2] || sg[3] || sg[4] || sg[1] || 'Group').trim().replace(/"/g, "'");
      out.push(`package "${title}" {`);
      continue;
    }
    if (/^end$/i.test(t)) {
      out.push('}');
      continue;
    }
    const edge = /^(.+?)\s*(?:--\s*([^>-][^-\n]*?)\s*(-->|---|-\.->|==>)|(-->|---|-\.->|==>)(?:\|([^|]*)\|)?)\s*(.+)$/.exec(t);
    if (edge) {
      const ln = nodeRe.exec(edge[1].trim());
      const rn = nodeRe.exec(edge[6].trim());
      if (ln && rn) {
        ensureRect(ln[1], ln[2]);
        ensureRect(rn[1], rn[2]);
        const op = (edge[3] || edge[4] || '-->').includes('.') ? '..>' : '-->';
        const lbl = (edge[2] || edge[5] || '').trim();
        out.push(`${ln[1]} ${op} ${rn[1]}${lbl ? ` : ${lbl}` : ''}`);
      }
    }
  }
  out.push('@enduml');
  return out.join('\n') + '\n';
}
