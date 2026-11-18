import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { config } from '../util';

export const STARTER_WORKSPACE_LIBRARY_XML = `<mxlibrary>[
  {"xml":"&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;mxCell id=&quot;2&quot; value=&quot;Microservice&quot; style=&quot;rounded=1;whiteSpace=wrap;html=1;fillColor=#dbeafe;strokeColor=#2563eb;fontStyle=1;&quot; vertex=&quot;1&quot; parent=&quot;1&quot;&gt;&lt;mxGeometry width=&quot;130&quot; height=&quot;54&quot; as=&quot;geometry&quot;/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;","w":130,"h":54,"aspect":"fixed","title":"Microservice"},
  {"xml":"&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;mxCell id=&quot;2&quot; value=&quot;Database&quot; style=&quot;shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;fillColor=#dcfce7;strokeColor=#16a34a;fontStyle=1;&quot; vertex=&quot;1&quot; parent=&quot;1&quot;&gt;&lt;mxGeometry width=&quot;100&quot; height=&quot;70&quot; as=&quot;geometry&quot;/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;","w":100,"h":70,"aspect":"fixed","title":"Database"},
  {"xml":"&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;mxCell id=&quot;2&quot; value=&quot;Event Queue&quot; style=&quot;shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;fillColor=#fef9c3;strokeColor=#ca8a04;fontStyle=1;&quot; vertex=&quot;1&quot; parent=&quot;1&quot;&gt;&lt;mxGeometry width=&quot;140&quot; height=&quot;48&quot; as=&quot;geometry&quot;/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;","w":140,"h":48,"aspect":"fixed","title":"Event Queue"}
]</mxlibrary>
`;

export function discoverWorkspaceLibraryFsPathsSync(): string[] {
  if (!vscode.workspace.isTrusted || !config().get<boolean>('drawio.autoLoadWorkspaceLibrary', true)) {
    return [];
  }
  const found: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    for (const rel of [path.join('.vscode', 'drawgraph-library.xml'), 'drawgraph-library.xml']) {
      const candidate = path.join(folder.uri.fsPath, rel);
      if (fs.existsSync(candidate)) {
        found.push(candidate);
      }
    }
  }
  return found;
}

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
  const autoPaths = discoverWorkspaceLibraryFsPathsSync();
  const combined = [...autoPaths, ...(Array.isArray(configured) ? configured : [])];
  if (combined.length === 0) {
    return { entries: [], ids: [] };
  }
  const entries: Array<Record<string, unknown>> = [];
  const ids: string[] = [];
  const rootFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const seenPaths = new Set<string>();

  for (let i = 0; i < combined.length; i++) {
    const item = String(combined[i] ?? '').trim();
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
    if (!fileUri || seenPaths.has(fileUri.fsPath)) {
      continue;
    }
    seenPaths.add(fileUri.fsPath);
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
