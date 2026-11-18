import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractDrawioPages } from '../drawio/codeLinksXml';
import { DrawioEditorProvider, readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { isPngDiagramPath } from '../drawio/drawioPng';
import { t } from '../l10n';
import { findMarkdownDiagramFences } from '../language/symbols';
import { splitDiagrams } from '../plantuml/encoder';

export interface DiagramTreeNode {
  kind: 'file' | 'subdiagram';
  uri: vscode.Uri;
  label: string;
  description?: string;
  diagramType: 'drawio' | 'mermaid' | 'plantuml' | 'markdown';
  line?: number;
  pageId?: string;
  children?: DiagramTreeNode[];
}

const PRIMARY_DIAGRAM_GLOB = '**/*.{drawio,dio,mmd,mermaid,puml,plantuml,pu,iuml,wsd}';
const SECONDARY_DIAGRAM_GLOB = '**/*.{drawio.svg,drawio.png,drawio.xml,dio.svg,dio.png,dio.xml,md}';
const WATCHER_GLOB = '**/*.{drawio,dio,mmd,mermaid,puml,plantuml,pu,iuml,wsd,md,svg,png,xml}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';

function classifyDiagramUri(uri: vscode.Uri): 'drawio' | 'mermaid' | 'plantuml' | 'markdown' | undefined {
  const lower = uri.path.toLowerCase();
  if (/\.(?:drawio|dio)(?:\.(?:svg|png|xml))?$/i.test(lower)) {
    return 'drawio';
  }
  if (/\.(?:mmd|mermaid)$/i.test(lower)) {
    return 'mermaid';
  }
  if (/\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(lower)) {
    return 'plantuml';
  }
  if (lower.endsWith('.md')) {
    return 'markdown';
  }
  return undefined;
}

export class DiagramExplorerProvider implements vscode.TreeDataProvider<DiagramTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DiagramTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private cachedRoots: DiagramTreeNode[] | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(WATCHER_GLOB);
    const scheduleInvalidate = (uri?: vscode.Uri) => {
      if (uri && !classifyDiagramUri(uri)) {
        return;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        this.cachedRoots = undefined;
        this.emitter.fire();
      }, 250);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(scheduleInvalidate),
      watcher.onDidDelete(scheduleInvalidate),
      watcher.onDidChange(scheduleInvalidate),
      vscode.workspace.onDidSaveTextDocument((doc) => scheduleInvalidate(doc.uri)),
    );
  }

  refresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.cachedRoots = undefined;
    this.emitter.fire();
  }

  async snapshot(): Promise<Array<{ uri: string; label: string; type: string; childCount: number }>> {
    const roots = await this.getChildren();
    return roots.map((r) => ({
      uri: r.uri.toString(),
      label: r.label,
      type: r.diagramType,
      childCount: r.children?.length ?? 0,
    }));
  }

  getTreeItem(element: DiagramTreeNode): vscode.TreeItem {
    const hasChildren = Boolean(element.children && element.children.length > 0);
    const item = new vscode.TreeItem(
      element.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.description = element.description;
    item.resourceUri = element.uri;
    item.contextValue = element.kind === 'file' ? `diagramFile.${element.diagramType}` : 'diagramSubitem';

    if (element.diagramType === 'drawio') {
      item.iconPath = new vscode.ThemeIcon(element.kind === 'subdiagram' ? 'file-submodule' : 'layout');
      if (element.kind === 'subdiagram') {
        item.command = {
          command: 'drawGraph.explorer.openEntry',
          title: t('Open in Draw.io'),
          arguments: [element.uri, element.line ?? 0, 'drawio', element.pageId],
        };
      } else {
        const viewType = isPngDiagramPath(element.uri.path)
          ? DrawioEditorProvider.pngViewType
          : DrawioEditorProvider.viewType;
        item.command = {
          command: 'vscode.openWith',
          title: t('Open in Draw.io'),
          arguments: [element.uri, viewType],
        };
      }
    } else if (element.diagramType === 'markdown' || element.line !== undefined) {
      item.iconPath = new vscode.ThemeIcon(element.kind === 'subdiagram' ? 'symbol-namespace' : 'markdown');
      item.command = {
        command: 'drawGraph.explorer.openEntry',
        title: t('Open Diagram'),
        arguments: [element.uri, element.line, element.diagramType],
      };
    } else {
      item.iconPath = new vscode.ThemeIcon(element.diagramType === 'mermaid' ? 'git-merge' : 'type-hierarchy-sub');
      item.command = {
        command: 'drawGraph.explorer.openEntry',
        title: t('Open Diagram'),
        arguments: [element.uri, 0, element.diagramType],
      };
    }

    return item;
  }

  async getChildren(element?: DiagramTreeNode): Promise<DiagramTreeNode[]> {
    if (element) {
      return element.children ?? [];
    }
    if (this.cachedRoots) {
      return this.cachedRoots;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }

    const [primaryUris, secondaryUris] = await Promise.all([
      vscode.workspace.findFiles(PRIMARY_DIAGRAM_GLOB, EXCLUDE_GLOB, 400),
      vscode.workspace.findFiles(SECONDARY_DIAGRAM_GLOB, EXCLUDE_GLOB, 250),
    ]);
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const u of [...primaryUris, ...secondaryUris]) {
      const k = u.toString();
      if (!seen.has(k)) {
        seen.add(k);
        uris.push(u);
      }
    }

    const nodes: DiagramTreeNode[] = [];

    for (const uri of uris) {
      const dtype = classifyDiagramUri(uri);
      if (!dtype) {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(uri, false);
      const relDir = path.dirname(rel);
      const dirDesc = relDir === '.' ? '' : relDir;

      if (dtype === 'markdown') {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength > 1024 * 1024) {
            continue;
          }
          const fences = findMarkdownDiagramFences(Buffer.from(bytes).toString('utf8'));
          if (fences.length === 0) {
            continue;
          }
          const children: DiagramTreeNode[] = fences.map((f, idx) => ({
            kind: 'subdiagram',
            uri,
            label: `${f.kind} #${idx + 1}`,
            description: `L${f.startLine + 1}`,
            diagramType: f.kind,
            line: f.startLine,
          }));
          nodes.push({
            kind: 'file',
            uri,
            label: path.basename(uri.path),
            description: [dirDesc, `${fences.length} diagrams`].filter(Boolean).join(' · '),
            diagramType: 'markdown',
            line: fences[0].startLine,
            children,
          });
        } catch {
          // Skip unreadable files
        }
        continue;
      }

      if (dtype === 'drawio') {
        let children: DiagramTreeNode[] | undefined;
        try {
          const xml = await readDrawioXmlFromUri(uri);
          if (xml) {
            const pages = extractDrawioPages(xml);
            if (pages.length > 1) {
              children = pages.map((p, idx) => ({
                kind: 'subdiagram',
                uri,
                label: p.name || `Page ${idx + 1}`,
                description: `#${idx + 1}`,
                diagramType: 'drawio',
                line: idx,
                pageId: p.id,
              }));
            }
          }
        } catch {
          // Ignore parse errors
        }
        nodes.push({
          kind: 'file',
          uri,
          label: path.basename(uri.path),
          description: [dirDesc, children ? `${children.length} pages` : ''].filter(Boolean).join(' · '),
          diagramType: 'drawio',
          children,
        });
        continue;
      }

      if (dtype === 'plantuml') {
        let children: DiagramTreeNode[] | undefined;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength <= 1024 * 1024) {
            const blocks = splitDiagrams(Buffer.from(bytes).toString('utf8'));
            if (blocks.length > 1) {
              children = blocks.map((b, idx) => ({
                kind: 'subdiagram',
                uri,
                label: `Block #${idx + 1}`,
                description: `L${b.startLine + 1}`,
                diagramType: 'plantuml',
                line: b.startLine,
              }));
            }
          }
        } catch {
          // Ignore
        }
        nodes.push({
          kind: 'file',
          uri,
          label: path.basename(uri.path),
          description: [dirDesc, children ? `${children.length} blocks` : ''].filter(Boolean).join(' · '),
          diagramType: 'plantuml',
          children,
        });
        continue;
      }

      nodes.push({
        kind: 'file',
        uri,
        label: path.basename(uri.path),
        description: dirDesc,
        diagramType: 'mermaid',
      });
    }

    nodes.sort((a, b) => a.uri.path.localeCompare(b.uri.path));
    this.cachedRoots = nodes;
    return nodes;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
