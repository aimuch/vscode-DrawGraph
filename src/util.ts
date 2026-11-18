import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from './l10n';

export function getNonce(): string {
  return randomBytes(24).toString('base64');
}

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('drawGraph');
}

export function isDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

/** Decodes a `data:` URI (base64 or percent-encoded) into raw bytes. */
export function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) {
    throw new Error('Not a data URI');
  }
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    return Buffer.from(payload, 'base64');
  }
  return Buffer.from(decodeURIComponent(payload), 'utf8');
}

/** Replaces the extension of `uri` (handling compound ones such as `.drawio.xml` or `.dio.svg`). */
export function withExtension(uri: vscode.Uri, ext: string): vscode.Uri {
  const filePath = uri.path.replace(/(\.(?:drawio|dio)\.(xml|svg|png)|\.[^./]+)$/i, '') + ext;
  return uri.with({ path: filePath });
}

export async function saveBytes(defaultUri: vscode.Uri, data: Uint8Array, filters: Record<string, string[]>): Promise<void> {
  const target = await vscode.window.showSaveDialog({ defaultUri, filters });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, data);
  const open = t('Open');
  const choice = await vscode.window.showInformationMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), open);
  if (choice === open) {
    await vscode.commands.executeCommand('vscode.open', target);
  }
}

/** Resolves the target URI for `drawGraph.exportOnSave` alongside or in `exportOnSaveOutDir`. */
export function resolveAutoExportUri(sourceUri: vscode.Uri, ext: '.svg' | '.png' | '.pdf'): vscode.Uri {
  const outDir = config().get<string>('exportOnSaveOutDir', '').trim();
  const replaced = withExtension(sourceUri, ext);
  if (!outDir) {
    return replaced;
  }
  const baseName = path.posix.basename(replaced.path);
  if (path.isAbsolute(outDir)) {
    return vscode.Uri.file(path.join(outDir, baseName));
  }
  const dirUri = vscode.Uri.joinPath(sourceUri, '..');
  return vscode.Uri.joinPath(dirUri, outDir, baseName);
}
