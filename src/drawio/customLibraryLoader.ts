import * as path from 'node:path';
import * as vscode from 'vscode';
import { config } from '../util';

export function parseMxLibraryXml(raw: string): unknown[] | undefined {
  const trimmed = raw.trim();
  const match = /<mxlibrary\b[^>]*>([\s\S]*?)<\/mxlibrary>/i.exec(trimmed);
  const jsonText = (match ? match[1] : trimmed).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function loadCustomLibraries(): Promise<{ entries: Array<Record<string, unknown>>; ids: string[] }> {
  if (!vscode.workspace.isTrusted) {
    return { entries: [], ids: [] };
  }
  const configured = config().get<string[]>('drawio.customLibraries', []);
  if (!Array.isArray(configured) || configured.length === 0) {
    return { entries: [], ids: [] };
  }
  const entries: Array<Record<string, unknown>> = [];
  const ids: string[] = [];
  const rootFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

  for (let i = 0; i < configured.length; i++) {
    const item = String(configured[i] ?? '').trim();
    if (!item) {
      continue;
    }
    const id = `drawgraph-custom-${i}`;
    if (/^https?:\/\//i.test(item)) {
      const title = item.split('/').pop()?.replace(/\.(xml|drawio)$/i, '') || `Library ${i + 1}`;
      entries.push({
        id,
        title: { main: title },
        desc: { main: item },
        libs: [{ title: { main: title }, url: item }],
      });
      ids.push(id);
      continue;
    }
    const fileUri = path.isAbsolute(item)
      ? vscode.Uri.file(item)
      : rootFolder
        ? vscode.Uri.joinPath(rootFolder, item)
        : undefined;
    if (!fileUri) {
      continue;
    }
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
      const parsed = parseMxLibraryXml(raw);
      if (!parsed) {
        continue;
      }
      const title = path.basename(fileUri.path).replace(/\.(xml|drawio)$/i, '') || `Library ${i + 1}`;
      entries.push({
        id,
        title: { main: title },
        desc: { main: item },
        libs: [{ title: { main: title }, data: parsed }],
      });
      ids.push(id);
    } catch {
      // Skip unreadable library files silently so editor startup still succeeds.
    }
  }
  return { entries, ids };
}
