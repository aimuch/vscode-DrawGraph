import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractDrawioPages } from '../drawio/codeLinksXml';
import { DrawioEditorProvider, readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { isPngDiagramPath } from '../drawio/drawioPng';
import { t } from '../l10n';
import { DIAGRAM_TREE_MIME } from '../language/diagramFeatures';
import { findMarkdownDiagramFences } from '../language/symbols';
import { splitDiagrams } from '../plantuml/encoder';
import { StateMachine, type MachineSnapshot, type TransitionRecord, type TransitionTable } from '../stateMachine';

export type ExplorerDiagramType = 'drawio' | 'mermaid' | 'plantuml' | 'dot' | 'wavedrom' | 'markdown';

export interface DiagramTreeNode {
  kind: 'file' | 'subdiagram';
  uri: vscode.Uri;
  label: string;
  description?: string;
  diagramType: ExplorerDiagramType;
  line?: number;
  pageId?: string;
  children?: DiagramTreeNode[];
}

export type ExplorerIndexPhase = 'stale' | 'debouncing' | 'scanning' | 'scanning_dirty' | 'ready' | 'disposed';
export type ExplorerIndexEvent =
  | 'SCHEDULE_INVALIDATE'
  | 'DEBOUNCE_FIRED'
  | 'FORCE_REFRESH'
  | 'BEGIN_SCAN'
  | 'SCAN_CLEAN'
  | 'SCAN_DIRTY'
  | 'DISPOSE';

const EXPLORER_INDEX_TRANSITIONS: TransitionTable<ExplorerIndexPhase, ExplorerIndexEvent> = {
  stale: {
    SCHEDULE_INVALIDATE: 'debouncing',
    FORCE_REFRESH: 'stale',
    BEGIN_SCAN: 'scanning',
    DISPOSE: 'disposed',
  },
  debouncing: {
    SCHEDULE_INVALIDATE: 'debouncing',
    DEBOUNCE_FIRED: 'stale',
    FORCE_REFRESH: 'stale',
    BEGIN_SCAN: 'scanning',
    DISPOSE: 'disposed',
  },
  scanning: {
    SCHEDULE_INVALIDATE: 'scanning_dirty',
    FORCE_REFRESH: 'scanning_dirty',
    SCAN_CLEAN: 'ready',
    DISPOSE: 'disposed',
  },
  scanning_dirty: {
    SCHEDULE_INVALIDATE: 'scanning_dirty',
    FORCE_REFRESH: 'scanning_dirty',
    SCAN_DIRTY: 'stale',
    DISPOSE: 'disposed',
  },
  ready: {
    SCHEDULE_INVALIDATE: 'debouncing',
    FORCE_REFRESH: 'stale',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const EXPLORER_INDEX_SETTLED: readonly ExplorerIndexPhase[] = ['stale', 'ready', 'disposed'];

const PRIMARY_DIAGRAM_GLOB = '**/*.{drawio,dio,mmd,mermaid,puml,plantuml,pu,iuml,wsd,dot,gv,wavedrom}';
const SECONDARY_DIAGRAM_GLOB = '**/*.{drawio.svg,drawio.png,drawio.xml,dio.svg,dio.png,dio.xml,wave.json,md}';
const WATCHER_GLOB = '**/*.{drawio,dio,mmd,mermaid,puml,plantuml,pu,iuml,wsd,dot,gv,wavedrom,json,md,svg,png,xml}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';
const SCAN_CONCURRENCY = 12;

function classifyDiagramUri(uri: vscode.Uri): ExplorerDiagramType | undefined {
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
  if (/\.(?:dot|gv)$/i.test(lower)) {
    return 'dot';
  }
  if (/\.(?:wavedrom|wave\.json)$/i.test(lower)) {
    return 'wavedrom';
  }
  if (lower.endsWith('.md')) {
    return 'markdown';
  }
  return undefined;
}

export class DiagramExplorerProvider
  implements vscode.TreeDataProvider<DiagramTreeNode>, vscode.TreeDragAndDropController<DiagramTreeNode>, vscode.Disposable
{
  readonly dragMimeTypes = [DIAGRAM_TREE_MIME, 'text/uri-list'];
  readonly dropMimeTypes: readonly string[] = [];
  private readonly emitter = new vscode.EventEmitter<DiagramTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifecycle: StateMachine<ExplorerIndexPhase, ExplorerIndexEvent>;
  private cachedRoots: DiagramTreeNode[] | undefined;
  private inflightScan: Promise<DiagramTreeNode[]> | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor(onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void) {
    this.lifecycle = new StateMachine<ExplorerIndexPhase, ExplorerIndexEvent>({
      id: 'diagram-explorer',
      initial: 'stale',
      transitions: EXPLORER_INDEX_TRANSITIONS,
      settledStates: EXPLORER_INDEX_SETTLED,
      onTransition,
    });
    const watcher = vscode.workspace.createFileSystemWatcher(WATCHER_GLOB);
    const scheduleInvalidate = (uri?: vscode.Uri) => {
      if (this.lifecycle.state === 'disposed') {
        return;
      }
      if (uri && !classifyDiagramUri(uri)) {
        return;
      }
      if (this.lifecycle.state === 'scanning' || this.lifecycle.state === 'scanning_dirty') {
        this.lifecycle.send('SCHEDULE_INVALIDATE', 'change arrived during scan');
        return;
      }
      this.lifecycle.send('SCHEDULE_INVALIDATE');
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        if (this.lifecycle.send('DEBOUNCE_FIRED')) {
          this.cachedRoots = undefined;
          this.emitter.fire();
        }
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

  machines(): MachineSnapshot[] {
    return [this.lifecycle.snapshot()];
  }

  isSettled(): boolean {
    return this.lifecycle.isSettled;
  }

  refresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.cachedRoots = undefined;
    this.lifecycle.send('FORCE_REFRESH');
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
      const iconId =
        element.diagramType === 'mermaid'
          ? 'git-merge'
          : element.diagramType === 'wavedrom'
            ? 'pulse'
            : element.diagramType === 'dot'
              ? 'graph-scatter'
              : 'type-hierarchy-sub';
      item.iconPath = new vscode.ThemeIcon(iconId);
      item.command = {
        command: 'drawGraph.explorer.openEntry',
        title: t('Open Diagram'),
        arguments: [element.uri, 0, element.diagramType],
      };
    }

    return item;
  }

  handleDrag(source: readonly DiagramTreeNode[], dataTransfer: vscode.DataTransfer): void {
    if (source.length === 0) {
      return;
    }
    const payload = source.map((s) => ({
      uri: s.uri.toString(),
      diagramType: s.diagramType,
      line: s.line,
    }));
    dataTransfer.set(DIAGRAM_TREE_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
    dataTransfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(source.map((s) => s.uri.toString()).join('\r\n')),
    );
  }

  async getChildren(element?: DiagramTreeNode): Promise<DiagramTreeNode[]> {
    if (element) {
      return element.children ?? [];
    }
    if (this.cachedRoots && this.lifecycle.state === 'ready') {
      return this.cachedRoots;
    }
    if (this.inflightScan) {
      return this.inflightScan;
    }
    if (!vscode.workspace.workspaceFolders?.length || this.lifecycle.state === 'disposed') {
      return [];
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.lifecycle.send('BEGIN_SCAN');
    const scanPromise = this.scanWorkspaceDiagrams().finally(() => {
      this.inflightScan = undefined;
    });
    this.inflightScan = scanPromise;
    return scanPromise;
  }

  private async inspectSingleUri(uri: vscode.Uri): Promise<DiagramTreeNode | undefined> {
    const dtype = classifyDiagramUri(uri);
    if (!dtype) {
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    const relDir = path.dirname(rel);
    const dirDesc = relDir === '.' ? '' : relDir;

    if (dtype === 'markdown') {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 1024 * 1024) {
          return undefined;
        }
        const fences = findMarkdownDiagramFences(Buffer.from(bytes).toString('utf8'));
        if (fences.length === 0) {
          return undefined;
        }
        const children: DiagramTreeNode[] = fences.map((f, idx) => ({
          kind: 'subdiagram',
          uri,
          label: `${f.kind} #${idx + 1}`,
          description: `L${f.startLine + 1}`,
          diagramType: f.kind,
          line: f.startLine,
        }));
        return {
          kind: 'file',
          uri,
          label: path.basename(uri.path),
          description: [dirDesc, `${fences.length} diagrams`].filter(Boolean).join(' · '),
          diagramType: 'markdown',
          line: fences[0].startLine,
          children,
        };
      } catch {
        return undefined;
      }
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
      return {
        kind: 'file',
        uri,
        label: path.basename(uri.path),
        description: [dirDesc, children ? `${children.length} pages` : ''].filter(Boolean).join(' · '),
        diagramType: 'drawio',
        children,
      };
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
      return {
        kind: 'file',
        uri,
        label: path.basename(uri.path),
        description: [dirDesc, children ? `${children.length} blocks` : ''].filter(Boolean).join(' · '),
        diagramType: 'plantuml',
        children,
      };
    }

    return {
      kind: 'file',
      uri,
      label: path.basename(uri.path),
      description: dirDesc,
      diagramType: dtype,
    };
  }

  private async scanWorkspaceDiagrams(): Promise<DiagramTreeNode[]> {
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
    let cursor = 0;
    const workerCount = Math.min(SCAN_CONCURRENCY, uris.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < uris.length && this.lifecycle.state !== 'disposed') {
          const idx = cursor++;
          const node = await this.inspectSingleUri(uris[idx]);
          if (node) {
            nodes.push(node);
          }
        }
      }),
    );

    nodes.sort((a, b) => a.uri.path.localeCompare(b.uri.path));

    if (this.lifecycle.state === 'scanning_dirty') {
      this.cachedRoots = undefined;
      this.lifecycle.send('SCAN_DIRTY');
      setTimeout(() => {
        if (this.lifecycle.state !== 'disposed') {
          this.emitter.fire();
        }
      }, 60);
      return nodes;
    }

    this.cachedRoots = nodes;
    this.lifecycle.send('SCAN_CLEAN', `count=${nodes.length}`);
    return nodes;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.lifecycle.send('DISPOSE');
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
