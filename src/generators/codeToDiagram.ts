import { escapeXmlAttribute } from '../drawio/drawioSvg';
import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';

export interface CodeSymbolNode {
  name: string;
  detail?: string;
  kind: 'class' | 'interface' | 'enum' | 'struct' | 'method' | 'field' | 'function' | 'module';
  children?: CodeSymbolNode[];
  /** Optional base classes or referenced type names discovered from source text. */
  relations?: Array<{ target: string; kind: 'extends' | 'implements' | 'uses' }>;
}

export interface ModuleDependencyEdge {
  from: string;
  to: string;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_') || 'Sym';
}

/**
 * Extracts heritage (`extends`, `implements`) and field/parameter type references from
 * source code for a set of known type names.
 */
export function inferTypeRelationsFromSource(
  sourceText: string,
  typeNames: ReadonlySet<string>,
): Map<string, Array<{ target: string; kind: 'extends' | 'implements' | 'uses' }>> {
  const result = new Map<string, Array<{ target: string; kind: 'extends' | 'implements' | 'uses' }>>();
  const push = (owner: string, target: string, kind: 'extends' | 'implements' | 'uses') => {
    if (owner === target || !typeNames.has(target)) {
      return;
    }
    const list = result.get(owner) ?? [];
    if (!list.some((r) => r.target === target && r.kind === kind)) {
      list.push({ target, kind });
      result.set(owner, list);
    }
  };

  // TS/JS/Java/C#/Python/Dart class/interface headers
  const headerRe =
    /\b(?:class|interface|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*<[^>]*>)?(?:\s*\(([^)]*)\))?(?:\s+extends\s+([A-Za-z0-9_$,\s.<>]+?))?(?:\s+implements\s+([A-Za-z0-9_$,\s.<>]+?))?(?=\s*[\{:])/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(sourceText)) !== null) {
    const owner = m[1];
    if (!typeNames.has(owner)) {
      continue;
    }
    const pyBases = m[2] ?? '';
    const extList = m[3] ?? '';
    const implList = m[4] ?? '';
    for (const tok of (pyBases + ',' + extList).split(/[,<\s>]+/)) {
      const clean = tok.trim().split('.').pop() || '';
      if (clean) {
        push(owner, clean, 'extends');
      }
    }
    for (const tok of implList.split(/[,<\s>]+/)) {
      const clean = tok.trim().split('.').pop() || '';
      if (clean) {
        push(owner, clean, 'implements');
      }
    }
  }

  return result;
}

/**
 * Lightweight language-agnostic symbol extractor used when no LSP DocumentSymbolProvider
 * is installed or ready for a source file (supports TS/JS, Python, Java, C#, Go, Rust).
 */
export function extractFallbackCodeSymbols(sourceText: string): CodeSymbolNode[] {
  const nodes: CodeSymbolNode[] = [];
  const lines = sourceText.split(/\r?\n/);
  let currentType: CodeSymbolNode | undefined;
  let braceDepth = 0;
  let typeOpenDepth = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) {
      continue;
    }

    const typeMatch =
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    if (typeMatch && !currentType) {
      const kind = typeMatch[1] as 'class' | 'interface' | 'enum' | 'struct';
      currentType = { name: typeMatch[2], kind, children: [] };
      nodes.push(currentType);
      typeOpenDepth = braceDepth;
    } else if (currentType) {
      const pyDef = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      const tsMethod =
        /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::\s*([^{]+))?\{?$/.exec(
          line,
        );
      const tsField =
        /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:\s*([^=;]+)[;=]?/.exec(
          line,
        );
      if (pyDef && pyDef[1] !== '__init__') {
        currentType.children!.push({ name: pyDef[1], kind: 'method' });
      } else if (
        tsMethod &&
        !['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(tsMethod[1])
      ) {
        currentType.children!.push({
          name: tsMethod[1],
          kind: 'method',
          detail: tsMethod[2]?.trim(),
        });
      } else if (tsField && !line.includes('(')) {
        currentType.children!.push({
          name: tsField[1],
          kind: 'field',
          detail: tsField[2]?.trim(),
        });
      }
    }

    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        if (currentType && braceDepth <= typeOpenDepth) {
          currentType = undefined;
        }
      }
    }
  }

  return nodes;
}

/**
 * Generates a Class Diagram (`mermaid`, `plantuml`, or `drawio` `<mxfile>` XML) from
 * normalized AST symbols (`vscode.DocumentSymbol`).
 */
export function generateClassDiagramFromSymbols(
  symbols: readonly CodeSymbolNode[],
  format: 'mermaid' | 'plantuml' | 'drawio',
): string {
  // Flatten nested namespaces/modules to top-level type declarations.
  const types: CodeSymbolNode[] = [];
  const visit = (nodes: readonly CodeSymbolNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'enum' || n.kind === 'struct') {
        types.push(n);
      }
      if (n.children && n.children.length > 0) {
        visit(n.children);
      }
    }
  };
  visit(symbols);

  // If file only has top-level functions (functional module), group them into a Module box.
  if (types.length === 0) {
    const funcs = symbols.filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'field');
    if (funcs.length > 0) {
      types.push({
        name: 'Module',
        kind: 'class',
        children: funcs,
      });
    }
  }

  if (format === 'plantuml') {
    const out = ['@startuml', 'skinparam classAttributeIconSize 0'];
    for (const t of types) {
      const kw = t.kind === 'interface' ? 'interface' : t.kind === 'enum' ? 'enum' : 'class';
      const id = sanitizeId(t.name);
      out.push(`${kw} "${t.name}" as ${id} {`);
      for (const c of t.children ?? []) {
        if (c.kind === 'field') {
          out.push(`  +${c.name}${c.detail ? `: ${c.detail}` : ''}`);
        } else if (c.kind === 'method' || c.kind === 'function') {
          out.push(`  +${c.name}()${c.detail ? `: ${c.detail}` : ''}`);
        }
      }
      out.push('}');
    }
    for (const t of types) {
      const from = sanitizeId(t.name);
      for (const rel of t.relations ?? []) {
        const to = sanitizeId(rel.target);
        const arrow = rel.kind === 'extends' ? '--|>' : rel.kind === 'implements' ? '..|>' : '-->';
        out.push(`${from} ${arrow} ${to}`);
      }
    }
    out.push('@enduml');
    return out.join('\n') + '\n';
  }

  if (format === 'mermaid') {
    const out = ['classDiagram'];
    for (const t of types) {
      const id = sanitizeId(t.name);
      out.push(`  class ${id} {`);
      if (t.kind === 'interface') {
        out.push('    <<interface>>');
      } else if (t.kind === 'enum') {
        out.push('    <<enumeration>>');
      }
      for (const c of t.children ?? []) {
        const cleanDetail = (c.detail ?? '').replace(/[{}<>]/g, '').trim();
        if (c.kind === 'field') {
          out.push(`    +${c.name}${cleanDetail ? ` ${cleanDetail}` : ''}`);
        } else if (c.kind === 'method' || c.kind === 'function') {
          out.push(`    +${c.name}()${cleanDetail ? ` ${cleanDetail}` : ''}`);
        }
      }
      out.push('  }');
    }
    for (const t of types) {
      const from = sanitizeId(t.name);
      for (const rel of t.relations ?? []) {
        const to = sanitizeId(rel.target);
        const arrow = rel.kind === 'extends' ? '--|>' : rel.kind === 'implements' ? '..|>' : '-->';
        out.push(`  ${from} ${arrow} ${to}`);
      }
    }
    return out.join('\n') + '\n';
  }

  // Draw.io native UML class swimlane boxes
  const cells: string[] = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />'];
  const cols = Math.max(1, Math.ceil(Math.sqrt(types.length)));
  const idByType = new Map<string, string>();

  types.forEach((t, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 60 + col * 280;
    const y = 60 + row * 220;
    const members = (t.children ?? []).filter((c) => c.kind === 'field' || c.kind === 'method' || c.kind === 'function');
    const boxH = Math.max(84, 38 + members.length * 22);
    const cellId = `cls_${sanitizeId(t.name)}_${idx}`;
    idByType.set(t.name, cellId);
    const stereo = t.kind === 'interface' ? '«interface»\n' : t.kind === 'enum' ? '«enumeration»\n' : '';
    const fill = t.kind === 'interface' ? '#d5e8d4' : t.kind === 'enum' ? '#fff2cc' : '#dae8fc';
    const stroke = t.kind === 'interface' ? '#82b366' : t.kind === 'enum' ? '#d6b656' : '#6c8ebf';
    const headerH = stereo ? 42 : 28;

    cells.push(
      `<mxCell id="${cellId}" value="${escapeXmlAttribute(stereo + t.name)}" style="swimlane;fontStyle=1;align=center;verticalAlign=top;childLayout=stackLayout;horizontal=1;startSize=${headerH};horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="220" height="${boxH}" as="geometry" /></mxCell>`,
    );

    members.forEach((m, mIdx) => {
      const label = m.kind === 'field' ? `+ ${m.name}` : `+ ${m.name}()`;
      cells.push(
        `<mxCell id="${cellId}_m_${mIdx}" value="${escapeXmlAttribute(label)}" style="text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=8;spacingRight=4;overflow=hidden;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;rotatable=0;whiteSpace=wrap;html=1;" vertex="1" parent="${cellId}"><mxGeometry y="${headerH + mIdx * 22}" width="220" height="22" as="geometry" /></mxCell>`,
      );
    });
  });

  let edgeSeq = 0;
  for (const t of types) {
    const srcId = idByType.get(t.name);
    if (!srcId) {
      continue;
    }
    for (const rel of t.relations ?? []) {
      const dstId = idByType.get(rel.target);
      if (!dstId) {
        continue;
      }
      const style =
        rel.kind === 'extends'
          ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=0;html=1;'
          : rel.kind === 'implements'
            ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=block;endFill=0;html=1;'
            : 'edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=open;html=1;';
      cells.push(
        `<mxCell id="rel_${++edgeSeq}" value="" style="${style}" edge="1" parent="1" source="${srcId}" target="${dstId}"><mxGeometry relative="1" as="geometry" /></mxCell>`,
      );
    }
  }

  return `<mxfile><diagram id="classes" name="Class-Diagram"><mxGraphModel grid="1" gridSize="10"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

/** Extracts relative/local module import specifiers from TS/JS/Python/C/Go source text. */
export function extractLocalImports(sourceText: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+(\.[A-Za-z0-9_.]*)\s+import\b/gm,
    /^\s*#include\s+"([^"]+)"/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sourceText)) !== null) {
      const spec = m[1].trim();
      if (spec.startsWith('.') || spec.includes('/')) {
        specs.add(spec);
      }
    }
  }
  return [...specs];
}

/** Generates a Module Dependency Graph (`mermaid`, `plantuml`, or `drawio` XML). */
export function generateDependencyDiagram(
  edges: readonly ModuleDependencyEdge[],
  format: 'mermaid' | 'plantuml' | 'drawio',
): string {
  const mmdLines = ['flowchart LR'];
  for (const e of edges) {
    const a = sanitizeId(e.from);
    const b = sanitizeId(e.to);
    mmdLines.push(`  ${a}["${e.from}"] --> ${b}["${e.to}"]`);
  }
  const mmd = mmdLines.join('\n') + '\n';
  if (format === 'mermaid') {
    return mmd;
  }
  if (format === 'drawio') {
    return convertMermaidToDrawioXml(mmd);
  }
  const puml = ['@startuml', 'left to right direction'];
  for (const e of edges) {
    puml.push(`[${e.from}] --> [${e.to}]`);
  }
  puml.push('@enduml');
  return puml.join('\n') + '\n';
}
