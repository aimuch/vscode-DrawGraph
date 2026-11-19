// Pure, zero-vscode PR / Git Diff Architecture Impact Diagram generator.
// Maps changed files (Added / Modified / Deleted) + 1-hop downstream dependents into
// color-coded Mermaid, Draw.io XML, or D2 architecture impact diagrams.

import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';

export type GitChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface ChangedFileEntry {
  readonly relPath: string;
  readonly status: GitChangeStatus;
}

export interface ModuleImportEdge {
  readonly from: string;
  readonly to: string;
}

export interface PrImpactGraph {
  readonly baseRef: string;
  readonly changed: ChangedFileEntry[];
  readonly impactedDependents: string[];
  readonly edges: ModuleImportEdge[];
}

function sanitizeNodeId(relPath: string): string {
  const clean = relPath.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return `M_${clean || 'root'}`;
}

function shortLabel(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 2) return relPath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Computes the 1-hop downstream architecture impact graph from changed files and workspace import edges.
 */
export function computePrImpactGraph(
  baseRef: string,
  changed: readonly ChangedFileEntry[],
  allEdges: readonly ModuleImportEdge[],
): PrImpactGraph {
  const changedSet = new Set(changed.map((c) => c.relPath));
  const impactedSet = new Set<string>();
  const relevantEdges: ModuleImportEdge[] = [];

  for (const edge of allEdges) {
    const fromChanged = changedSet.has(edge.from);
    const toChanged = changedSet.has(edge.to);
    if (fromChanged || toChanged) {
      relevantEdges.push(edge);
      if (toChanged && !fromChanged) {
        impactedSet.add(edge.from);
      }
    }
  }

  return {
    baseRef,
    changed: [...changed],
    impactedDependents: [...impactedSet].sort(),
    edges: relevantEdges,
  };
}

/**
 * Renders a `PrImpactGraph` to Mermaid, Draw.io XML, or D2 source.
 */
export function renderPrImpactDiagram(
  graph: PrImpactGraph,
  format: 'mermaid' | 'drawio' | 'd2' = 'mermaid',
): string {
  if (format === 'd2') {
    const lines: string[] = [
      `# PR Architecture Impact vs ${graph.baseRef}`,
      'direction: right',
      '',
      'changed: Changed Modules {',
    ];
    for (const c of graph.changed) {
      const id = sanitizeNodeId(c.relPath);
      const fill = c.status === 'A' ? '#dcfce7' : c.status === 'D' ? '#fee2e2' : '#fef3c7';
      const stroke = c.status === 'A' ? '#16a34a' : c.status === 'D' ? '#dc2626' : '#d97706';
      lines.push(`  ${id}: "[${c.status}] ${shortLabel(c.relPath)}" { style.fill: "${fill}"; style.stroke: "${stroke}" }`);
    }
    lines.push('}');
    if (graph.impactedDependents.length > 0) {
      lines.push('impacted: Downstream Impacted {');
      for (const imp of graph.impactedDependents) {
        const id = sanitizeNodeId(imp);
        lines.push(`  ${id}: "${shortLabel(imp)}" { style.fill: "#dbeafe"; style.stroke: "#2563eb" }`);
      }
      lines.push('}');
    }
    const changedSet = new Set(graph.changed.map((c) => c.relPath));
    for (const e of graph.edges) {
      const fromScope = changedSet.has(e.from) ? 'changed' : 'impacted';
      const toScope = changedSet.has(e.to) ? 'changed' : 'impacted';
      lines.push(`${fromScope}.${sanitizeNodeId(e.from)} -> ${toScope}.${sanitizeNodeId(e.to)}: imports`);
    }
    return `${lines.join('\n')}\n`;
  }

  const lines: string[] = [
    `%% PR Architecture Impact vs ${graph.baseRef}`,
    'flowchart LR',
    '  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px',
    '  classDef modified fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px',
    '  classDef deleted fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px,stroke-dasharray: 4 3',
    '  classDef impacted fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px',
    '',
    '  subgraph CHANGED["Changed Files"]',
  ];

  const addedIds: string[] = [];
  const modifiedIds: string[] = [];
  const deletedIds: string[] = [];
  const impactedIds: string[] = [];

  for (const c of graph.changed) {
    const id = sanitizeNodeId(c.relPath);
    lines.push(`    ${id}["[${c.status}] ${shortLabel(c.relPath)}"]`);
    if (c.status === 'A') addedIds.push(id);
    else if (c.status === 'D') deletedIds.push(id);
    else modifiedIds.push(id);
  }
  lines.push('  end');

  if (graph.impactedDependents.length > 0) {
    lines.push('  subgraph IMPACTED["Downstream Impacted Dependents"]');
    for (const imp of graph.impactedDependents) {
      const id = sanitizeNodeId(imp);
      lines.push(`    ${id}["${shortLabel(imp)}"]`);
      impactedIds.push(id);
    }
    lines.push('  end');
  }

  for (const e of graph.edges) {
    lines.push(`  ${sanitizeNodeId(e.from)} -. imports .-> ${sanitizeNodeId(e.to)}`);
  }

  if (addedIds.length > 0) lines.push(`  class ${addedIds.join(',')} added`);
  if (modifiedIds.length > 0) lines.push(`  class ${modifiedIds.join(',')} modified`);
  if (deletedIds.length > 0) lines.push(`  class ${deletedIds.join(',')} deleted`);
  if (impactedIds.length > 0) lines.push(`  class ${impactedIds.join(',')} impacted`);

  const mmd = `${lines.join('\n')}\n`;
  if (format === 'drawio') {
    return convertMermaidToDrawioXml(mmd);
  }
  return mmd;
}
