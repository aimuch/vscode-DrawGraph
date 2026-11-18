import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';

interface SqlColumn {
  name: string;
  type: string;
  pk: boolean;
  fkTargetTable?: string;
}

interface SqlTable {
  name: string;
  columns: SqlColumn[];
}

function cleanSqlIdentifier(raw: string): string {
  const parts = raw
    .trim()
    .replace(/^[`"[[]+|[`"\]]+$/g, '')
    .split('.');
  return (parts[parts.length - 1] || raw).replace(/^[`"[[]+|[`"\]]+$/g, '').trim();
}

function splitTopLevelCommas(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && body[i - 1] !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) {
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      items.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) {
    items.push(tail);
  }
  return items;
}

/**
 * Parses SQL DDL (`CREATE TABLE ...`, inline `REFERENCES`, and `FOREIGN KEY (...) REFERENCES ...`)
 * and generates a Mermaid `erDiagram`, PlantUML entity diagram, or Draw.io ER diagram.
 */
export function convertSqlToDiagram(sqlText: string, format: 'mermaid' | 'plantuml' | 'drawio'): string {
  const stripped = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');

  const tables = new Map<string, SqlTable>();
  const relations: Array<{ fromTable: string; toTable: string; colName: string }> = [];

  const tableRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(([\s\S]*?)\)\s*(?:;|ENGINE\b|WITHOUT\b|TABLESPACE\b|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(stripped)) !== null) {
    const tableName = cleanSqlIdentifier(m[1]);
    if (!tableName) {
      continue;
    }
    const table: SqlTable = { name: tableName, columns: [] };
    tables.set(tableName, table);

    const clauses = splitTopLevelCommas(m[2]);
    const pkSet = new Set<string>();

    for (const clause of clauses) {
      const normalized = clause.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      const tablePk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(normalized);
      if (tablePk) {
        for (const col of tablePk[1].split(',')) {
          pkSet.add(cleanSqlIdentifier(col));
        }
        continue;
      }

      const tableFk =
        /^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)/i.exec(normalized);
      if (tableFk) {
        const fkCol = cleanSqlIdentifier(tableFk[1].split(',')[0] || '');
        const refTable = cleanSqlIdentifier(tableFk[2]);
        if (refTable) {
          relations.push({ fromTable: tableName, toTable: refTable, colName: fkCol || 'fk' });
          const existing = table.columns.find((c) => c.name === fkCol);
          if (existing) {
            existing.fkTargetTable = refTable;
          }
        }
        continue;
      }

      if (/^(?:UNIQUE|CHECK|INDEX|KEY|CONSTRAINT)\b/i.test(normalized)) {
        continue;
      }

      const colMatch = /^([`"[]?[A-Za-z_][A-Za-z0-9_$]*[`"\]]?)\s+([A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?)(.*)$/i.exec(
        normalized,
      );
      if (colMatch) {
        const colName = cleanSqlIdentifier(colMatch[1]);
        const colType = colMatch[2].replace(/\s+/g, '');
        const rest = colMatch[3] || '';
        const isPk = /\bPRIMARY\s+KEY\b/i.test(rest);
        const inlineRef = /\bREFERENCES\s+([^\s(]+)/i.exec(rest);
        const fkTarget = inlineRef ? cleanSqlIdentifier(inlineRef[1]) : undefined;
        if (fkTarget) {
          relations.push({ fromTable: tableName, toTable: fkTarget, colName });
        }
        table.columns.push({ name: colName, type: colType, pk: isPk, fkTargetTable: fkTarget });
      }
    }

    for (const col of table.columns) {
      if (pkSet.has(col.name)) {
        col.pk = true;
      }
    }
  }

  if (format === 'plantuml') {
    const out = ['@startuml', 'hide circle', 'skinparam linetype ortho'];
    for (const tbl of tables.values()) {
      out.push(`entity "${tbl.name}" as ${tbl.name.replace(/\W/g, '_')} {`);
      for (const c of tbl.columns) {
        const prefix = c.pk ? '* ' : '  ';
        const badge = c.pk ? ' <<PK>>' : c.fkTargetTable ? ' <<FK>>' : '';
        out.push(`  ${prefix}${c.name} : ${c.type}${badge}`);
      }
      out.push('}');
    }
    for (const rel of relations) {
      out.push(`${rel.toTable.replace(/\W/g, '_')} ||--o{ ${rel.fromTable.replace(/\W/g, '_')} : "${rel.colName}"`);
    }
    out.push('@enduml');
    return out.join('\n') + '\n';
  }

  const mmd = ['erDiagram'];
  for (const rel of relations) {
    mmd.push(`  ${rel.toTable.replace(/\W/g, '_')} ||--o{ ${rel.fromTable.replace(/\W/g, '_')} : "${rel.colName}"`);
  }
  for (const tbl of tables.values()) {
    mmd.push(`  ${tbl.name.replace(/\W/g, '_')} {`);
    for (const c of tbl.columns) {
      const safeType = c.type.replace(/[^A-Za-z0-9_]/g, '') || 'string';
      const keyTag = c.pk ? ' PK' : c.fkTargetTable ? ' FK' : '';
      mmd.push(`    ${safeType} ${c.name.replace(/\W/g, '_')}${keyTag}`);
    }
    mmd.push('  }');
  }
  const mmdSource = mmd.join('\n') + '\n';

  if (format === 'drawio') {
    return convertMermaidToDrawioXml(mmdSource);
  }
  return mmdSource;
}

/**
 * Converts a JSON document into a hierarchical Mermaid `mindmap`, PlantUML `@startjson`
 * diagram, or editable Draw.io mindmap.
 */
export function convertJsonToDiagram(jsonText: string, format: 'mermaid' | 'plantuml' | 'drawio'): string {
  const parsed: unknown = JSON.parse(jsonText);

  if (format === 'plantuml') {
    return `@startjson\n${JSON.stringify(parsed, null, 2)}\n@endjson\n`;
  }

  const lines = ['mindmap', '  root((JSON))'];
  let nodeCount = 0;
  const MAX_NODES = 160;

  const sanitizeLabel = (text: string): string =>
    text.replace(/[\r\n()[\]{}"`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'value';

  const walk = (val: unknown, depth: number) => {
    if (nodeCount >= MAX_NODES || depth > 8) {
      return;
    }
    const indent = '  '.repeat(depth);
    if (val === null || typeof val !== 'object') {
      nodeCount++;
      lines.push(`${indent}${sanitizeLabel(String(val))}`);
      return;
    }
    if (Array.isArray(val)) {
      val.slice(0, 20).forEach((item, idx) => {
        if (nodeCount >= MAX_NODES) {
          return;
        }
        nodeCount++;
        if (item !== null && typeof item === 'object') {
          lines.push(`${indent}Item ${idx}`);
          walk(item, depth + 1);
        } else {
          lines.push(`${indent}${sanitizeLabel(`[${idx}] ${String(item)}`)}`);
        }
      });
      return;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (nodeCount >= MAX_NODES) {
        break;
      }
      nodeCount++;
      if (v !== null && typeof v === 'object') {
        const badge = Array.isArray(v) ? ` (${v.length})` : '';
        lines.push(`${indent}${sanitizeLabel(k + badge)}`);
        walk(v, depth + 1);
      } else {
        lines.push(`${indent}${sanitizeLabel(`${k}: ${String(v)}`)}`);
      }
    }
  };

  walk(parsed, 2);
  const mmd = lines.join('\n') + '\n';
  return format === 'drawio' ? convertMermaidToDrawioXml(mmd) : mmd;
}
