import * as path from 'node:path';
import * as vscode from 'vscode';
import { t } from './l10n';
export { buildCodeSymbolMergeXml, extractCodeLinksFromDrawioXml, type DiagramCodeLink } from './drawio/codeLinksXml';

function parseFileTarget(raw: string): { filePath: string; line?: number } {
  const cleaned = raw.replace(/^file:\/\//i, '').trim();
  const hashLine = /^(.*?)#L(\d+)(?:-L?\d+)?$/i.exec(cleaned);
  if (hashLine) {
    return { filePath: hashLine[1], line: parseInt(hashLine[2], 10) };
  }
  const colonLine = /^(.*?):(\d+)(?::\d+)?$/.exec(cleaned);
  if (colonLine) {
    return { filePath: colonLine[1], line: parseInt(colonLine[2], 10) };
  }
  return { filePath: cleaned };
}

async function openFileAtLine(uri: vscode.Uri, oneBasedLine?: number): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    if (oneBasedLine !== undefined && oneBasedLine >= 1) {
      const lineIdx = Math.min(oneBasedLine - 1, Math.max(0, doc.lineCount - 1));
      const col = doc.lineAt(lineIdx).firstNonWhitespaceCharacterIndex;
      const pos = new vscode.Position(lineIdx, col);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a diagram code-link target (`#SymbolName`, `SymbolName`, or `path/to/file.ts:line`)
 * and opens the matching file/symbol in the VS Code editor.
 */
export async function navigateToCodeTarget(rawTarget: string, contextUri?: vscode.Uri): Promise<boolean> {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return false;
  }

  const explicitSymbol = trimmed.startsWith('#') ? trimmed.slice(1).trim() : undefined;

  // 1. Try resolving as a workspace/relative file path when it looks like a path or has an extension.
  if (!explicitSymbol && /[./\\]/.test(trimmed)) {
    const { filePath, line } = parseFileTarget(trimmed);
    const candidates: vscode.Uri[] = [];
    if (path.isAbsolute(filePath)) {
      candidates.push(vscode.Uri.file(filePath));
    } else {
      if (contextUri && contextUri.scheme === 'file') {
        candidates.push(vscode.Uri.joinPath(contextUri, '..', filePath));
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(vscode.Uri.joinPath(folder.uri, filePath));
      }
    }
    for (const candidate of candidates) {
      try {
        await vscode.workspace.fs.stat(candidate);
        if (await openFileAtLine(candidate, line)) {
          return true;
        }
      } catch {
        // Try next candidate.
      }
    }
    const baseName = path.posix.basename(filePath.replace(/\\/g, '/'));
    if (baseName) {
      const found = await vscode.workspace.findFiles(`**/${baseName}`, '**/node_modules/**', 5);
      if (found.length > 0 && (await openFileAtLine(found[0], line))) {
        return true;
      }
    }
  }

  // 2. Search workspace symbols (`vscode.executeWorkspaceSymbolProvider`).
  const symbolQuery = (explicitSymbol ?? trimmed).split(/[.#]/).pop() || (explicitSymbol ?? trimmed);
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    symbolQuery,
  );
  if (Array.isArray(symbols) && symbols.length > 0) {
    const exact = symbols.filter((s) => s.name === symbolQuery || s.name === (explicitSymbol ?? trimmed));
    const pool = exact.length > 0 ? exact : symbols;
    let chosen = pool[0];
    if (pool.length > 1) {
      const picked = await vscode.window.showQuickPick(
        pool.slice(0, 30).map((s) => ({
          label: `$(symbol-method) ${s.name}`,
          description: s.containerName || vscode.workspace.asRelativePath(s.location.uri),
          detail: `${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`,
          sym: s,
        })),
        { placeHolder: t('Select symbol definition for "{0}"', symbolQuery) },
      );
      if (!picked) {
        return true;
      }
      chosen = picked.sym;
    }
    const doc = await vscode.workspace.openTextDocument(chosen.location.uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(chosen.location.range.start, chosen.location.range.start);
    editor.revealRange(chosen.location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  return false;
}
