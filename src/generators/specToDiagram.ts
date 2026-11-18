// Converts API & data schema specifications — OpenAPI/Swagger (JSON or YAML),
// Protocol Buffers (`.proto`), and Prisma (`schema.prisma`) — into Mermaid,
// PlantUML, or editable Draw.io diagrams. Zero external runtime dependencies.

import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';

export type DiagramTargetFormat = 'mermaid' | 'plantuml' | 'drawio';

/**
 * Lightweight, indentation-aware YAML subset parser sufficient for structured
 * OpenAPI, Docker Compose, and GitHub Actions workflow manifests.
 */
export function parseSimpleYaml(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  interface YamlLine {
    indent: number;
    text: string;
  }

  const rawLines = text.split(/\r?\n/);
  const lines: YamlLine[] = [];

  for (const raw of rawLines) {
    // Strip unquoted `#` comment
    let inSingle = false;
    let inDouble = false;
    let clean = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle && raw[i - 1] !== '\\') inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]))) {
        break;
      }
      clean += c;
    }
    const trimmedRight = clean.replace(/\s+$/, '');
    if (!trimmedRight.trim() || /^---$|^\.\.\.$/.test(trimmedRight.trim())) {
      continue;
    }
    const indent = /^(\s*)/.exec(trimmedRight)?.[1].replace(/\t/g, '  ').length ?? 0;
    lines.push({ indent, text: trimmedRight.trim() });
  }

  function parseScalar(raw: string): unknown {
    const s = raw.trim();
    if (!s || s === '~' || s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return splitInlineCollection(inner).map((item) => parseScalar(item));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      const obj: Record<string, unknown> = {};
      if (!inner) return obj;
      for (const pair of splitInlineCollection(inner)) {
        const colon = findKeyColon(pair);
        if (colon > 0) {
          const k = String(parseScalar(pair.slice(0, colon)));
          obj[k] = parseScalar(pair.slice(colon + 1));
        }
      }
      return obj;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(s)) {
      return Number(s);
    }
    return s;
  }

  function splitInlineCollection(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let depth = 0;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        cur += c;
        if (c === quote && s[i - 1] !== '\\') quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
        cur += c;
      } else if (c === '[' || c === '{') {
        depth++;
        cur += c;
      } else if (c === ']' || c === '}') {
        depth--;
        cur += c;
      } else if (c === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function findKeyColon(s: string): number {
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote && s[i - 1] !== '\\') quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ':' && (i + 1 === s.length || /\s/.test(s[i + 1]))) {
        return i;
      }
    }
    return -1;
  }

  let idx = 0;

  function parseBlock(minIndent: number): unknown {
    if (idx >= lines.length || lines[idx].indent < minIndent) {
      return {};
    }
    if (lines[idx].text.startsWith('- ') || lines[idx].text === '-') {
      const arr: unknown[] = [];
      const baseIndent = lines[idx].indent;
      while (idx < lines.length && lines[idx].indent === baseIndent && (lines[idx].text.startsWith('- ') || lines[idx].text === '-')) {
        const rest = lines[idx].text.slice(1).trim();
        idx++;
        if (!rest) {
          arr.push(parseBlock(baseIndent + 1));
        } else {
          const colon = findKeyColon(rest);
          if (colon > 0) {
            const itemObj: Record<string, unknown> = {};
            const k = String(parseScalar(rest.slice(0, colon)));
            const vPart = rest.slice(colon + 1).trim();
            if (vPart && vPart !== '|' && vPart !== '>') {
              itemObj[k] = parseScalar(vPart);
            } else {
              itemObj[k] = parseBlock(baseIndent + 2);
            }
            if (idx < lines.length && lines[idx].indent > baseIndent) {
              const extra = parseBlock(lines[idx].indent);
              if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
                Object.assign(itemObj, extra);
              }
            }
            arr.push(itemObj);
          } else {
            arr.push(parseScalar(rest));
          }
        }
      }
      return arr;
    }

    const obj: Record<string, unknown> = {};
    const baseIndent = lines[idx].indent;
    while (idx < lines.length && lines[idx].indent >= baseIndent) {
      if (lines[idx].indent > baseIndent) {
        // Skip stray multiline scalar lines (e.g. `run: |`)
        idx++;
        continue;
      }
      const lineText = lines[idx].text;
      if (lineText.startsWith('- ') || lineText === '-') {
        break;
      }
      const colon = findKeyColon(lineText);
      if (colon < 0) {
        idx++;
        continue;
      }
      const key = String(parseScalar(lineText.slice(0, colon)));
      const valText = lineText.slice(colon + 1).trim();
      idx++;
      if (!valText) {
        if (idx < lines.length && lines[idx].indent > baseIndent) {
          obj[key] = parseBlock(lines[idx].indent);
        } else {
          obj[key] = null;
        }
      } else if (valText === '|' || valText === '>' || valText === '|-' || valText === '>-') {
        const chunks: string[] = [];
        while (idx < lines.length && lines[idx].indent > baseIndent) {
          chunks.push(lines[idx].text);
          idx++;
        }
        obj[key] = chunks.join('\n');
      } else {
        obj[key] = parseScalar(valText);
      }
    }
    return obj;
  }

  return parseBlock(lines[0]?.indent ?? 0);
}

function safeId(raw: string, prefix = 'N'): string {
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!clean) return prefix;
  return /^\d/.test(clean) ? `${prefix}_${clean}` : clean;
}

// ---- 1. OpenAPI / Swagger -> Diagram --------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

function collectSchemaRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((x) => collectSchemaRefs(x, out));
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.$ref === 'string') {
    const m = /\/([^/]+)$/.exec(rec.$ref);
    if (m) out.add(m[1]);
  }
  for (const val of Object.values(rec)) {
    collectSchemaRefs(val, out);
  }
  return out;
}

export function convertOpenApiToDiagram(text: string, format: DiagramTargetFormat): string {
  const spec = parseSimpleYaml(text) as Record<string, unknown>;
  if (!spec || typeof spec !== 'object' || (!spec.openapi && !spec.swagger && !spec.paths)) {
    throw new Error('Not a valid OpenAPI / Swagger document (missing "openapi", "swagger", or "paths").');
  }

  const info = (spec.info && typeof spec.info === 'object' ? spec.info : {}) as Record<string, unknown>;
  const apiTitle = String(info.title || 'API Service').replace(/"/g, "'");
  const pathsObj = (spec.paths && typeof spec.paths === 'object' ? spec.paths : {}) as Record<string, unknown>;
  const components = (spec.components && typeof spec.components === 'object' ? spec.components : {}) as Record<string, unknown>;
  const schemasObj = ((components.schemas ?? spec.definitions) || {}) as Record<string, unknown>;

  interface EndpointInfo {
    id: string;
    method: string;
    route: string;
    tag: string;
    refs: string[];
  }

  const endpoints: EndpointInfo[] = [];
  let epSeq = 1;
  for (const [route, pathItem] of Object.entries(pathsObj)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const itemRec = pathItem as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = itemRec[method];
      if (!op || typeof op !== 'object') continue;
      const opRec = op as Record<string, unknown>;
      const tags = Array.isArray(opRec.tags) && opRec.tags.length > 0 ? String(opRec.tags[0]) : 'Endpoints';
      const refs = [...collectSchemaRefs(opRec)];
      endpoints.push({
        id: `EP_${epSeq++}`,
        method: method.toUpperCase(),
        route,
        tag: tags,
        refs,
      });
    }
  }

  const schemaNames = new Set<string>(Object.keys(schemasObj));
  for (const ep of endpoints) {
    ep.refs.forEach((r) => schemaNames.add(r));
  }

  const schemaEdges: Array<{ from: string; to: string }> = [];
  for (const [sName, sDef] of Object.entries(schemasObj)) {
    for (const ref of collectSchemaRefs(sDef)) {
      if (ref !== sName) {
        schemaEdges.push({ from: sName, to: ref });
      }
    }
  }

  if (format === 'plantuml') {
    const lines = ['@startuml', 'left to right direction', `rectangle "${apiTitle}" as API_ROOT`];
    const byTag = new Map<string, EndpointInfo[]>();
    for (const ep of endpoints) {
      const list = byTag.get(ep.tag) ?? [];
      list.push(ep);
      byTag.set(ep.tag, list);
    }
    for (const [tag, list] of byTag) {
      lines.push(`package "${tag.replace(/"/g, "'")}" {`);
      for (const ep of list) {
        lines.push(`  rectangle "${ep.method} ${ep.route}" as ${ep.id}`);
      }
      lines.push('}');
      for (const ep of list) {
        lines.push(`API_ROOT --> ${ep.id}`);
      }
    }
    if (schemaNames.size > 0) {
      lines.push(`package "Schemas" {`);
      for (const s of schemaNames) {
        lines.push(`  entity "${s}" as SCH_${safeId(s)}`);
      }
      lines.push('}');
    }
    for (const ep of endpoints) {
      for (const r of ep.refs) {
        lines.push(`${ep.id} ..> SCH_${safeId(r)}`);
      }
    }
    for (const se of schemaEdges) {
      lines.push(`SCH_${safeId(se.from)} --> SCH_${safeId(se.to)}`);
    }
    lines.push('@enduml');
    return `${lines.join('\n')}\n`;
  }

  const mmd: string[] = ['flowchart LR', `  API_ROOT(["${apiTitle}"])`];
  const byTag = new Map<string, EndpointInfo[]>();
  for (const ep of endpoints) {
    const list = byTag.get(ep.tag) ?? [];
    list.push(ep);
    byTag.set(ep.tag, list);
  }
  for (const [tag, list] of byTag) {
    mmd.push(`  subgraph ${safeId(tag, 'Tag')}["${tag.replace(/"/g, "'")}"]`);
    for (const ep of list) {
      mmd.push(`    ${ep.id}["${ep.method} ${ep.route}"]`);
    }
    mmd.push('  end');
    for (const ep of list) {
      mmd.push(`  API_ROOT --> ${ep.id}`);
    }
  }
  if (schemaNames.size > 0) {
    mmd.push(`  subgraph Schemas["Models & Schemas"]`);
    for (const s of schemaNames) {
      mmd.push(`    SCH_${safeId(s)}[("${s}")]`);
    }
    mmd.push('  end');
  }
  for (const ep of endpoints) {
    for (const r of ep.refs) {
      mmd.push(`  ${ep.id} -.-> SCH_${safeId(r)}`);
    }
  }
  for (const se of schemaEdges) {
    mmd.push(`  SCH_${safeId(se.from)} --> SCH_${safeId(se.to)}`);
  }

  const mermaidOut = `${mmd.join('\n')}\n`;
  return format === 'drawio' ? convertMermaidToDrawioXml(mermaidOut) : mermaidOut;
}

// ---- 2. Protocol Buffers (`.proto`) -> Diagram ----------------------------------------

export function convertProtoToDiagram(text: string, format: DiagramTargetFormat): string {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  interface ProtoField {
    label: string;
    type: string;
    name: string;
  }
  interface ProtoMessage {
    name: string;
    kind: 'message' | 'enum';
    fields: ProtoField[];
  }
  interface ProtoRpc {
    name: string;
    req: string;
    res: string;
  }
  interface ProtoService {
    name: string;
    rpcs: ProtoRpc[];
  }

  const messages: ProtoMessage[] = [];
  const services: ProtoService[] = [];

  const blockRe = /\b(message|enum|service)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(clean)) !== null) {
    const kind = m[1] as 'message' | 'enum' | 'service';
    const name = m[2];
    const body = m[3];

    if (kind === 'service') {
      const rpcs: ProtoRpc[] = [];
      const rpcRe = /\brpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)/g;
      let rm: RegExpExecArray | null;
      while ((rm = rpcRe.exec(body)) !== null) {
        rpcs.push({
          name: rm[1],
          req: rm[2].split('.').pop()!,
          res: rm[3].split('.').pop()!,
        });
      }
      services.push({ name, rpcs });
    } else if (kind === 'enum') {
      const fields: ProtoField[] = [];
      for (const ln of body.split(';')) {
        const em = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)/.exec(ln);
        if (em) {
          fields.push({ label: '', type: em[2], name: em[1] });
        }
      }
      messages.push({ name, kind: 'enum', fields });
    } else {
      const fields: ProtoField[] = [];
      for (const ln of body.split(';')) {
        const mapM = /^\s*map<\s*([A-Za-z0-9_.]+)\s*,\s*([A-Za-z0-9_.]+)\s*>\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(ln);
        if (mapM) {
          fields.push({ label: 'map', type: mapM[2].split('.').pop()!, name: mapM[3] });
          continue;
        }
        const fm = /^\s*(?:(repeated|optional|required)\s+)?([A-Za-z0-9_.]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(ln);
        if (fm) {
          fields.push({ label: fm[1] ?? '', type: fm[2].split('.').pop()!, name: fm[3] });
        }
      }
      messages.push({ name, kind: 'message', fields });
    }
  }

  if (messages.length === 0 && services.length === 0) {
    throw new Error('No message, enum, or service definitions found in Protobuf source.');
  }

  const declaredTypes = new Set(messages.map((x) => x.name));

  if (format === 'plantuml') {
    const lines = ['@startuml'];
    for (const svc of services) {
      lines.push(`interface "${svc.name}" <<service>> {`);
      for (const r of svc.rpcs) {
        lines.push(`  +${r.name}(${r.req}): ${r.res}`);
      }
      lines.push('}');
    }
    for (const msg of messages) {
      lines.push(`${msg.kind === 'enum' ? 'enum' : 'class'} ${msg.name} {`);
      for (const f of msg.fields) {
        lines.push(msg.kind === 'enum' ? `  ${f.name}` : `  +${f.name}: ${f.label ? `${f.label} ` : ''}${f.type}`);
      }
      lines.push('}');
    }
    for (const svc of services) {
      const seen = new Set<string>();
      for (const r of svc.rpcs) {
        for (const tName of [r.req, r.res]) {
          if (declaredTypes.has(tName) && !seen.has(tName)) {
            seen.add(tName);
            lines.push(`${svc.name} ..> ${tName}`);
          }
        }
      }
    }
    for (const msg of messages) {
      if (msg.kind !== 'message') continue;
      for (const f of msg.fields) {
        if (declaredTypes.has(f.type) && f.type !== msg.name) {
          lines.push(`${msg.name} --> ${f.type} : ${f.name}`);
        }
      }
    }
    lines.push('@enduml');
    return `${lines.join('\n')}\n`;
  }

  const mmd = ['classDiagram'];
  for (const svc of services) {
    mmd.push(`  class ${svc.name} {`, `    <<service>>`);
    for (const r of svc.rpcs) {
      mmd.push(`    +${r.name}(${r.req}) ${r.res}`);
    }
    mmd.push('  }');
  }
  for (const msg of messages) {
    mmd.push(`  class ${msg.name} {`);
    if (msg.kind === 'enum') mmd.push('    <<enumeration>>');
    for (const f of msg.fields) {
      mmd.push(msg.kind === 'enum' ? `    ${f.name}` : `    +${f.label ? `${f.label}_` : ''}${f.type} ${f.name}`);
    }
    mmd.push('  }');
  }
  for (const svc of services) {
    const seen = new Set<string>();
    for (const r of svc.rpcs) {
      for (const tName of [r.req, r.res]) {
        if (declaredTypes.has(tName) && !seen.has(tName)) {
          seen.add(tName);
          mmd.push(`  ${svc.name} ..> ${tName}`);
        }
      }
    }
  }
  for (const msg of messages) {
    if (msg.kind !== 'message') continue;
    for (const f of msg.fields) {
      if (declaredTypes.has(f.type) && f.type !== msg.name) {
        mmd.push(`  ${msg.name} --> ${f.type} : ${f.name}`);
      }
    }
  }

  const mermaidOut = `${mmd.join('\n')}\n`;
  return format === 'drawio' ? convertMermaidToDrawioXml(mermaidOut) : mermaidOut;
}

// ---- 3. Prisma Schema (`schema.prisma`) -> ER Diagram ---------------------------------

export function convertPrismaToDiagram(text: string, format: DiagramTargetFormat): string {
  const clean = text.replace(/\/\/.*$/gm, '');
  interface PrismaField {
    name: string;
    baseType: string;
    isList: boolean;
    isOptional: boolean;
    isId: boolean;
    hasRelationAttrs: boolean;
  }
  interface PrismaModel {
    name: string;
    fields: PrismaField[];
  }

  const models: PrismaModel[] = [];
  const modelRe = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(clean)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields: PrismaField[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('@@')) continue;
      const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\]|\?)?(.*)$/.exec(line);
      if (!fm) continue;
      const modifier = fm[3] ?? '';
      const rest = fm[4] ?? '';
      fields.push({
        name: fm[1],
        baseType: fm[2],
        isList: modifier === '[]',
        isOptional: modifier === '?',
        isId: /\b@id\b/.test(rest),
        hasRelationAttrs: /@relation\s*\([^)]*fields\s*:/.test(rest),
      });
    }
    models.push({ name, fields });
  }

  if (models.length === 0) {
    throw new Error('No Prisma "model" blocks found in schema.');
  }

  const modelSet = new Set(models.map((x) => x.name));
  const relations: Array<{ parent: string; child: string; fieldName: string; many: boolean }> = [];
  const pairSeen = new Set<string>();

  for (const mdl of models) {
    for (const f of mdl.fields) {
      if (!modelSet.has(f.baseType)) continue;
      if (f.hasRelationAttrs) {
        const key = `${f.baseType}->${mdl.name}:${f.name}`;
        if (!pairSeen.has(key)) {
          pairSeen.add(key);
          relations.push({ parent: f.baseType, child: mdl.name, fieldName: f.name, many: true });
        }
      }
    }
  }
  // Fallback for implicit relations without explicit `fields:` (e.g. M:N)
  for (const mdl of models) {
    for (const f of mdl.fields) {
      if (!modelSet.has(f.baseType) || f.baseType === mdl.name) continue;
      const alreadyLinked = relations.some(
        (r) => (r.parent === mdl.name && r.child === f.baseType) || (r.parent === f.baseType && r.child === mdl.name),
      );
      if (!alreadyLinked && f.isList) {
        relations.push({ parent: mdl.name, child: f.baseType, fieldName: f.name, many: true });
      }
    }
  }

  if (format === 'plantuml') {
    const lines = ['@startuml', 'hide circle', 'skinparam linetype ortho'];
    for (const mdl of models) {
      lines.push(`entity "${mdl.name}" as ${mdl.name} {`);
      for (const f of mdl.fields) {
        if (modelSet.has(f.baseType)) continue;
        lines.push(`  ${f.isId ? '* ' : '  '}${f.name} : ${f.baseType}${f.isOptional ? '?' : ''}`);
      }
      lines.push('}');
    }
    for (const r of relations) {
      lines.push(`${r.parent} ||--o{ ${r.child} : "${r.fieldName}"`);
    }
    lines.push('@enduml');
    return `${lines.join('\n')}\n`;
  }

  const mmd = ['erDiagram'];
  for (const mdl of models) {
    mmd.push(`  ${mdl.name} {`);
    for (const f of mdl.fields) {
      if (modelSet.has(f.baseType)) continue;
      mmd.push(`    ${f.baseType} ${f.name}${f.isId ? ' PK' : ''}`);
    }
    mmd.push('  }');
  }
  for (const r of relations) {
    mmd.push(`  ${r.parent} ||--o{ ${r.child} : "${r.fieldName}"`);
  }

  const mermaidOut = `${mmd.join('\n')}\n`;
  return format === 'drawio' ? convertMermaidToDrawioXml(mermaidOut) : mermaidOut;
}
