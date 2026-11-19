// Pure, zero-vscode Architecture Drift Detector:
// Compares codebase modules/symbols against diagram-referenced labels & links to identify
// undocumented code components and stale/deleted diagram references.

export interface ArchitectureDriftReport {
  readonly undocumentedCodeItems: Array<{ name: string; relPath: string }>;
  readonly staleDiagramRefs: Array<{ ref: string; diagramPath: string }>;
  readonly coveredCount: number;
  readonly totalCodeItems: number;
}

export function computeArchitectureDrift(
  codeItems: ReadonlyArray<{ name: string; relPath: string }>,
  diagramTokensByFile: ReadonlyMap<string, ReadonlySet<string>>,
  existingWorkspaceRelPaths: ReadonlySet<string>,
): ArchitectureDriftReport {
  const allDiagramTokensLower = new Set<string>();
  for (const tokens of diagramTokensByFile.values()) {
    for (const tok of tokens) {
      allDiagramTokensLower.add(tok.toLowerCase());
    }
  }

  const undocumentedCodeItems: Array<{ name: string; relPath: string }> = [];
  let coveredCount = 0;

  for (const item of codeItems) {
    const nameLower = item.name.toLowerCase();
    const relLower = item.relPath.toLowerCase();
    const baseLower = relLower.split('/').pop() ?? relLower;
    const stemLower = baseLower.replace(/\.[^.]+$/, '');
    const isCovered =
      allDiagramTokensLower.has(nameLower) ||
      allDiagramTokensLower.has(`#${nameLower}`) ||
      allDiagramTokensLower.has(relLower) ||
      allDiagramTokensLower.has(baseLower) ||
      allDiagramTokensLower.has(stemLower);
    if (isCovered) {
      coveredCount++;
    } else {
      undocumentedCodeItems.push(item);
    }
  }

  const existingLower = new Set([...existingWorkspaceRelPaths].map((p) => p.toLowerCase()));
  const existingBasenames = new Set([...existingLower].map((p) => p.split('/').pop() ?? p));
  const staleDiagramRefs: Array<{ ref: string; diagramPath: string }> = [];

  for (const [diagramPath, tokens] of diagramTokensByFile.entries()) {
    for (const tok of tokens) {
      // Only flag path-like tokens (containing a slash or source extension) that don't exist
      if (/\.(?:ts|tsx|js|jsx|py|go|java|rs|cs|cpp|c|h|proto|prisma|sql)$/i.test(tok)) {
        const clean = tok.replace(/^\.\//, '').replace(/[:#].*$/, '').toLowerCase();
        const base = clean.split('/').pop() ?? clean;
        if (!existingLower.has(clean) && !existingBasenames.has(base)) {
          staleDiagramRefs.push({ ref: tok, diagramPath });
        }
      }
    }
  }

  return {
    undocumentedCodeItems,
    staleDiagramRefs,
    coveredCount,
    totalCodeItems: codeItems.length,
  };
}
