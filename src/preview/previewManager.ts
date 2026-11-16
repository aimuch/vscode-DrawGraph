import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiagramDiagnostics } from '../language/diagramFeatures';
import { extractMermaidErrorLine } from '../language/symbols';
import { countPages, pickBlock, splitDiagrams } from '../plantuml/encoder';
import { CancelledError, extractPlantUmlError, PlantUmlRenderer, type WorkerPhase } from '../plantuml/renderer';
import { StateMachine, type MachineSnapshot, type TransitionRecord, type TransitionTable } from '../stateMachine';
import { config, decodeDataUri, getNonce, isDarkTheme, resolveAutoExportUri, saveBytes, withExtension } from '../util';

export type DiagramKind = 'mermaid' | 'plantuml';

export function diagramKind(document: vscode.TextDocument): DiagramKind | undefined {
  if (document.languageId === 'mermaid' || document.languageId === 'plantuml') {
    return document.languageId;
  }
  const ext = path.extname(document.uri.path).toLowerCase();
  if (ext === '.mmd' || ext === '.mermaid') {
    return 'mermaid';
  }
  if (['.puml', '.plantuml', '.pu', '.iuml', '.wsd'].includes(ext)) {
    return 'plantuml';
  }
  return undefined;
}

interface PreviewState {
  uri: string;
  locked?: boolean;
}

export type PreviewPhase = 'initializing' | 'debouncing' | 'rendering' | 'ready' | 'error' | 'empty' | 'disposed';
export type PreviewEvent =
  | 'SCHEDULE_UPDATE'
  | 'START_RENDER'
  | 'RENDER_OK'
  | 'RENDER_EMPTY'
  | 'RENDER_ERROR'
  | 'RENDER_CANCELLED'
  | 'RETARGET'
  | 'DISPOSE';

const PREVIEW_TRANSITIONS: TransitionTable<PreviewPhase, PreviewEvent> = {
  initializing: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  debouncing: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  rendering: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RENDER_CANCELLED: 'ready',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  ready: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  error: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  empty: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const PREVIEW_SETTLED: readonly PreviewPhase[] = ['ready', 'error', 'empty', 'disposed'];

/** Explicit discriminated union replacing ad-hoc `manualBlockIndex` + `suppressCursorSync` timer flags. */
type BlockSelectionState =
  | { mode: 'cursor'; line: number | undefined }
  | { mode: 'manual'; blockIndex: number; expectedEditorLine?: number };

/** What the webview last reported, exposed for diagnostics and integration tests. */
export interface RenderStatus {
  state: 'pending' | 'rendered' | 'error' | 'empty';
  width?: number;
  height?: number;
  error?: string;
  /** Number of status reports received so far. */
  count: number;
}

let previewSeq = 0;

/** A webview panel showing the live rendering of one Mermaid / PlantUML document. */
class DiagramPreview {
  readonly lifecycle: StateMachine<PreviewPhase, PreviewEvent>;
  readonly renderer: PlantUmlRenderer;
  private readonly disposables: vscode.Disposable[] = [];
  private updateTimer: NodeJS.Timeout | undefined;
  private lastBlockKey: string | undefined;
  private selection: BlockSelectionState = { mode: 'cursor', line: undefined };
  private pageIndex = 0;
  uri: vscode.Uri;
  kind: DiagramKind;
  locked: boolean;
  status: RenderStatus = { state: 'pending', count: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    kind: DiagramKind,
    locked: boolean,
    private readonly diagnostics: DiagramDiagnostics | undefined,
    onTransition: ((record: TransitionRecord<string, string>, machineId: string) => void) | undefined,
    private readonly onDispose: () => void,
  ) {
    const id = `preview:${++previewSeq}:${path.basename(uri.path)}`;
    this.uri = uri;
    this.kind = kind;
    this.locked = locked;
    this.lifecycle = new StateMachine<PreviewPhase, PreviewEvent>({
      id,
      initial: 'initializing',
      transitions: PREVIEW_TRANSITIONS,
      settledStates: PREVIEW_SETTLED,
      onTransition,
    });
    this.renderer = new PlantUmlRenderer(`${id}:plantuml`, onTransition);

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.iconPath = vscode.Uri.joinPath(media, 'preview', 'icon.svg');
    panel.webview.html = this.getHtml();
    this.updateTitle();

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
    );
  }

  private get isDisposed(): boolean {
    return this.lifecycle.state === 'disposed';
  }

  get selectionMode(): 'cursor' | 'manual' {
    return this.selection.mode;
  }

  get isSettled(): boolean {
    return this.lifecycle.isSettled && this.updateTimer === undefined && this.renderer.snapshot().isSettled;
  }

  private get document(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
  }

  private updateTitle() {
    const base = vscode.l10n.t('Preview {0}', path.basename(this.uri.path));
    this.panel.title = this.locked ? `[${base}]` : base;
  }

  toggleLock(): void {
    this.locked = !this.locked;
    this.updateTitle();
    this.pushConfig();
  }

  pushConfig(): void {
    const cfg = config();
    this.post({
      type: 'config',
      pngScale: cfg.get<number>('preview.pngScale', 2),
      pngTransparent: cfg.get<boolean>('preview.pngTransparent', false),
      locked: this.locked,
      uri: this.uri.toString(),
    });
  }

  retarget(newUri: vscode.Uri, newKind: DiagramKind, cursorLine?: number): void {
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.renderer.cancel();
    this.uri = newUri;
    this.lastBlockKey = undefined;
    this.selection = { mode: 'cursor', line: cursorLine };
    this.pageIndex = 0;
    this.status = { state: 'pending', count: 0 };
    this.lifecycle.send('RETARGET', path.basename(newUri.path));
    this.updateTitle();

    if (newKind !== this.kind) {
      this.kind = newKind;
      this.panel.webview.html = this.getHtml();
    } else {
      this.pushConfig();
      void this.update(true, false);
    }
  }

  /** Called when the cursor moves in an editor showing this document (PlantUML: choose the diagram block). */
  setCursorLine(line: number) {
    if (this.kind !== 'plantuml') {
      return;
    }
    if (this.selection.mode === 'manual' && this.selection.expectedEditorLine === line) {
      // Consume programmatic cursor sync triggered by toolbar `navigate()` without leaving manual mode.
      this.selection = { mode: 'manual', blockIndex: this.selection.blockIndex };
      return;
    }
    if (this.selection.mode === 'cursor' && this.selection.line === line) {
      return;
    }
    this.selection = { mode: 'cursor', line };
    this.scheduleUpdate(50);
  }

  scheduleUpdate(delay = config().get<number>('preview.debounce', 400)) {
    if (this.isDisposed) {
      return;
    }
    clearTimeout(this.updateTimer);
    this.lifecycle.send('SCHEDULE_UPDATE');
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, delay);
  }

  requestSilentExport(format: 'svg' | 'png'): void {
    this.post({ type: 'silentExport', format });
  }

  private currentCursorLine(): number | undefined {
    return this.selection.mode === 'cursor' ? this.selection.line : undefined;
  }

  async update(force = false, bypassCache = false) {
    if (this.isDisposed || !this.panel.visible) {
      return;
    }
    let document = this.document;
    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(this.uri);
      } catch (err) {
        this.lifecycle.send('RENDER_ERROR');
        this.post({ type: 'error', message: (err as Error).message });
        return;
      }
    }
    const text = document.getText();
    if (this.kind === 'mermaid') {
      this.lifecycle.send('START_RENDER');
      this.post({ type: 'mermaid', source: text, theme: mermaidTheme() });
      return;
    }

    const blocks = splitDiagrams(text);
    const block =
      this.selection.mode === 'manual' && blocks[this.selection.blockIndex]
        ? blocks[this.selection.blockIndex]
        : pickBlock(blocks, this.currentCursorLine());
    if (!block) {
      this.lastBlockKey = undefined;
      this.diagnostics?.clear(this.uri);
      this.lifecycle.send('RENDER_EMPTY');
      this.post({ type: 'empty' });
      return;
    }
    const blockIdx = blocks.indexOf(block);
    const totalPages = countPages(block.source);
    if (this.pageIndex >= totalPages) {
      this.pageIndex = 0;
    }
    const blockKey = `${blockIdx}:${this.pageIndex}:${block.source}`;
    if (!force && blockKey === this.lastBlockKey) {
      if (this.lifecycle.state === 'debouncing') {
        this.lifecycle.send('RENDER_OK', 'unchanged block');
      }
      return;
    }
    this.lastBlockKey = blockKey;

    const cfg = config();
    this.lifecycle.send('START_RENDER');
    this.post({ type: 'loading' });
    try {
      const svg = await this.renderer.render(block.source, {
        mode: cfg.get('plantuml.render', 'auto'),
        server: cfg.get('plantuml.server', 'https://www.plantuml.com/plantuml'),
        jar: cfg.get('plantuml.jar', ''),
        java: cfg.get('plantuml.java', 'java'),
        dot: cfg.get('plantuml.dot', ''),
        baseDir: document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined,
        page: this.pageIndex,
        noCache: bypassCache,
      });

      const syntaxErr = extractPlantUmlError(svg);
      if (syntaxErr) {
        this.diagnostics?.setError(document, block.startLine + syntaxErr.line - 1, syntaxErr.message);
      } else {
        this.diagnostics?.clear(this.uri);
      }

      const blockLabel = blocks.length > 1 ? `${blockIdx + 1} / ${blocks.length}` : '';
      const pageLabel = totalPages > 1 ? vscode.l10n.t('Page {0}/{1}', this.pageIndex + 1, totalPages) : '';
      const info = [blockLabel, pageLabel].filter(Boolean).join(' · ');
      this.post({ type: 'svg', svg, info, canNav: blocks.length > 1 || totalPages > 1 });
    } catch (err) {
      if (err instanceof CancelledError) {
        this.lifecycle.send('RENDER_CANCELLED');
        return;
      }
      this.lastBlockKey = undefined;
      this.lifecycle.send('RENDER_ERROR');
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async navigate(delta: number) {
    const doc = this.document ?? (await vscode.workspace.openTextDocument(this.uri).then((d) => d, () => undefined));
    if (!doc || this.kind !== 'plantuml') {
      return;
    }
    const blocks = splitDiagrams(doc.getText());
    if (blocks.length === 0) {
      return;
    }
    const currentBlock =
      (this.selection.mode === 'manual' && blocks[this.selection.blockIndex]) ||
      pickBlock(blocks, this.currentCursorLine()) ||
      blocks[0];
    let blockIdx = Math.max(0, blocks.indexOf(currentBlock));
    const pages = countPages(currentBlock.source);

    if (pages > 1 && this.pageIndex + delta >= 0 && this.pageIndex + delta < pages) {
      this.pageIndex += delta;
    } else if (blocks.length > 1) {
      blockIdx = (blockIdx + delta + blocks.length) % blocks.length;
      const nextBlock = blocks[blockIdx];
      this.pageIndex = delta < 0 ? Math.max(0, countPages(nextBlock.source) - 1) : 0;

      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
      this.selection = {
        mode: 'manual',
        blockIndex: blockIdx,
        expectedEditorLine: editor ? nextBlock.startLine : undefined,
      };
      if (editor) {
        const pos = new vscode.Position(nextBlock.startLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } else if (pages > 1) {
      this.pageIndex = (this.pageIndex + delta + pages) % pages;
    }
    await this.update(true, false);
  }

  private async jumpToSource(label?: string) {
    const existingEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
    const editor = await vscode.window.showTextDocument(this.uri, {
      viewColumn: existingEditor?.viewColumn ?? vscode.ViewColumn.One,
    });
    const doc = editor.document;
    let startLine = 0;
    let endLine = Math.max(0, doc.lineCount - 1);
    if (this.kind === 'plantuml') {
      const blocks = splitDiagrams(doc.getText());
      const activeBlock =
        (this.selection.mode === 'manual' && blocks[this.selection.blockIndex]) ||
        pickBlock(blocks, this.currentCursorLine());
      if (activeBlock) {
        startLine = activeBlock.startLine;
        endLine = Math.min(endLine, activeBlock.endLine);
      }
    }

    let targetLine = this.currentCursorLine() ?? startLine;
    const needle = (label ?? '').trim();
    if (needle.length >= 2) {
      for (let i = startLine; i <= endLine; i++) {
        if (doc.lineAt(i).text.includes(needle)) {
          targetLine = i;
          break;
        }
      }
    }
    targetLine = Math.max(0, Math.min(targetLine, Math.max(0, doc.lineCount - 1)));
    const col = doc.lineAt(targetLine).firstNonWhitespaceCharacterIndex;
    const pos = new vscode.Position(targetLine, col);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private post(message: unknown) {
    if (!this.isDisposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private async onMessage(msg: {
    type: string;
    format?: string;
    data?: string;
    message?: string;
    label?: string;
    delta?: number;
    line?: number;
    state?: RenderStatus['state'];
    width?: number;
    height?: number;
  }) {
    switch (msg.type) {
      case 'status': {
        this.status = { state: msg.state ?? 'pending', width: msg.width, height: msg.height, error: msg.message, count: this.status.count + 1 };
        if (msg.state === 'rendered') {
          this.lifecycle.send('RENDER_OK');
        } else if (msg.state === 'empty') {
          this.lifecycle.send('RENDER_EMPTY');
        } else if (msg.state === 'error') {
          this.lifecycle.send('RENDER_ERROR');
        }
        if (this.kind === 'mermaid') {
          if (msg.state === 'rendered' || msg.state === 'empty') {
            this.diagnostics?.clear(this.uri);
          } else if (msg.state === 'error' && msg.message && this.document) {
            const errLine = extractMermaidErrorLine(msg.message, msg.line) ?? 1;
            this.diagnostics?.setError(this.document, errLine - 1, msg.message);
          }
        }
        break;
      }
      case 'ready':
        await this.update(true, false);
        break;
      case 'toggleLock':
        this.toggleLock();
        break;
      case 'navigate':
        await this.navigate(msg.delta === -1 ? -1 : 1);
        break;
      case 'export':
        if (!msg.data) {
          return;
        }
        if (msg.format === 'svg') {
          await saveBytes(withExtension(this.uri, '.svg'), Buffer.from(msg.data, 'utf8'), { SVG: ['svg'] });
        } else if (msg.format === 'png') {
          await saveBytes(withExtension(this.uri, '.png'), decodeDataUri(msg.data), { PNG: ['png'] });
        }
        break;
      case 'autoExportData': {
        if (!msg.data || !vscode.workspace.isTrusted) {
          return;
        }
        const isSvg = msg.format === 'svg';
        const target = resolveAutoExportUri(this.uri, isSvg ? '.svg' : '.png');
        const bytes = isSvg ? Buffer.from(msg.data, 'utf8') : decodeDataUri(msg.data);
        await vscode.workspace.fs.writeFile(target, bytes);
        void vscode.window.setStatusBarMessage(vscode.l10n.t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
        break;
      }
      case 'copy':
        if (msg.data) {
          await vscode.env.clipboard.writeText(msg.data);
          void vscode.window.setStatusBarMessage(vscode.l10n.t('SVG copied to clipboard'), 2000);
        }
        break;
      case 'copiedPng':
        void vscode.window.setStatusBarMessage(vscode.l10n.t('PNG copied to clipboard'), 2000);
        break;
      case 'error':
        void vscode.window.showErrorMessage(msg.message ?? 'Unknown error');
        break;
      case 'openSource':
        await this.jumpToSource(msg.label);
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const cfg = config();
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const t = (s: string) => escapeAttr(vscode.l10n.t(s));
    const mermaidScript = this.kind === 'mermaid' ? `<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>` : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('preview', 'main.css')}" rel="stylesheet">
</head>
<body
  data-kind="${this.kind}"
  data-uri="${escapeAttr(this.uri.toString())}"
  data-locked="${this.locked}"
  data-png-scale="${cfg.get<number>('preview.pngScale', 2)}"
  data-png-transparent="${cfg.get<boolean>('preview.pngTransparent', false)}"
  data-label-locked="${t('Locked')}"
  data-label-unlocked="${t('Pin')}"
  data-bg-auto="${t('Bg: Auto')}"
  data-bg-light="${t('Bg: Light')}"
  data-bg-dark="${t('Bg: Dark')}"
  data-bg-grid="${t('Bg: Grid')}"
  data-err-invalid-svg="${t('Invalid SVG received from renderer.')}"
  data-err-mermaid-load="${t('Mermaid library failed to load.')}"
  data-err-png-raster="${t('PNG export failed: the SVG could not be rasterized. Try exporting as SVG.')}"
>
  <div id="toolbar">
    <button id="zoomOut" title="${t('Zoom out')}">−</button>
    <button id="zoomLabel" title="${t('Reset zoom (100%)')}">100%</button>
    <button id="zoomIn" title="${t('Zoom in')}">+</button>
    <button id="fit" title="${t('Fit to window')}">${t('Fit')}</button>
    <button id="bgToggle" title="${t('Cycle preview background')}">${t('Bg: Auto')}</button>
    <button id="lockToggle" title="${t('Lock or unlock preview to current file')}">${t('Pin')}</button>
    <span class="sep"></span>
    <button id="exportSvg" title="${t('Export as SVG')}">SVG</button>
    <button id="exportPng" title="${t('Export as PNG')}">PNG</button>
    <button id="copySvg" title="${t('Copy SVG to clipboard')}">${t('Copy SVG')}</button>
    <button id="copyPng" title="${t('Copy PNG image to clipboard')}">${t('Copy PNG')}</button>
    <span class="sep"></span>
    <button id="prevItem" class="nav-btn" title="${t('Previous diagram or page ([)')}" hidden>◀</button>
    <span id="info"></span>
    <button id="nextItem" class="nav-btn" title="${t('Next diagram or page (])')}" hidden>▶</button>
    <span id="spinner" hidden>${t('Rendering…')}</span>
  </div>
  <div id="stage"><div id="canvas"></div></div>
  <pre id="error" hidden></pre>
  <div id="empty" hidden>${t('Nothing to preview yet.')}</div>
  ${mermaidScript}
  <script nonce="${nonce}" src="${media('preview', 'main.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.lifecycle.send('DISPOSE');
    this.renderer.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
    this.onDispose();
  }
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function mermaidTheme(): string {
  const theme = config().get<string>('mermaid.theme', 'auto');
  if (theme === 'auto') {
    return isDarkTheme() ? 'dark' : 'default';
  }
  return theme;
}

export class PreviewManager implements vscode.WebviewPanelSerializer {
  static readonly viewType = 'drawGraph.preview';
  private readonly previews = new Map<string, DiagramPreview>();
  private readonly sharedExporter: PlantUmlRenderer;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics?: DiagramDiagnostics,
    private readonly onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
  ) {
    this.sharedExporter = new PlantUmlRenderer('plantuml-shared-exporter', onTransition);
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(PreviewManager.viewType, this),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.previews.get(e.document.uri.toString())?.scheduleUpdate();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.previews.get(e.textEditor.document.uri.toString())?.setCursorLine(e.selections[0].active.line);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || !config().get<boolean>('preview.followActiveEditor', true)) {
          return;
        }
        const kind = diagramKind(editor.document);
        if (!kind) {
          return;
        }
        const key = editor.document.uri.toString();
        if (this.previews.has(key)) {
          return;
        }
        const unlocked = [...this.previews.values()].find((p) => !p.locked && p.panel.visible);
        if (unlocked) {
          this.retargetPreview(unlocked, editor.document.uri, kind, editor.selection.active.line);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('drawGraph')) {
          this.previews.forEach((p) => {
            p.pushConfig();
            void p.update(true, true);
          });
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.previews.forEach((p) => void p.update(true, false));
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.autoExportOnSave(doc);
      }),
      {
        dispose: () => {
          this.sharedExporter.dispose();
          this.previews.forEach((p) => p.dispose());
        },
      },
    );
  }

  private retargetPreview(preview: DiagramPreview, newUri: vscode.Uri, kind: DiagramKind, cursorLine?: number): void {
    this.previews.delete(preview.uri.toString());
    preview.retarget(newUri, kind, cursorLine);
    this.previews.set(newUri.toString(), preview);
  }

  toggleLockActive(): void {
    const active =
      [...this.previews.values()].find((p) => p.panel.active) ??
      [...this.previews.values()].find((p) => p.panel.visible);
    active?.toggleLock();
  }

  async open(uri: vscode.Uri | undefined, toSide: boolean, atLine?: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    if (!target) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Open a Mermaid or PlantUML file first.'));
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    const kind = diagramKind(document);
    if (!kind) {
      void vscode.window.showWarningMessage(vscode.l10n.t('This file is not a Mermaid or PlantUML diagram.'));
      return;
    }
    const line = atLine ?? (editor && editor.document.uri.toString() === target.toString() ? editor.selection.active.line : undefined);
    const column = toSide ? vscode.ViewColumn.Beside : (editor?.viewColumn ?? vscode.ViewColumn.Active);
    const existing = this.previews.get(target.toString());
    if (existing) {
      if (line !== undefined) {
        existing.setCursorLine(line);
      }
      existing.panel.reveal(column, toSide);
      return;
    }

    if (config().get<boolean>('preview.followActiveEditor', true)) {
      const unlocked = [...this.previews.values()].find((p) => !p.locked);
      if (unlocked) {
        this.retargetPreview(unlocked, target, kind, line);
        unlocked.panel.reveal(column, toSide);
        return;
      }
    }

    const lockedByDefault = !config().get<boolean>('preview.followActiveEditor', true);
    const panel = vscode.window.createWebviewPanel(
      PreviewManager.viewType,
      path.basename(target.path),
      { viewColumn: column, preserveFocus: toSide },
      { enableScripts: true },
    );
    const preview = this.create(panel, target, kind, lockedByDefault);
    if (line !== undefined) {
      preview.setCursorLine(line);
    }
  }

  async exportPlantUmlBlock(uri: vscode.Uri, blockIndex: number, format: 'svg' | 'png'): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const blocks = splitDiagrams(document.getText());
    const block = blocks[blockIndex] ?? blocks[0];
    if (!block) {
      return;
    }
    const cfg = config();
    const opts = {
      mode: cfg.get<'auto' | 'local' | 'server'>('plantuml.render', 'auto'),
      server: cfg.get('plantuml.server', 'https://www.plantuml.com/plantuml'),
      jar: cfg.get('plantuml.jar', ''),
      java: cfg.get('plantuml.java', 'java'),
      dot: cfg.get('plantuml.dot', ''),
      baseDir: document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined,
    };
    try {
      if (format === 'svg') {
        const svg = await this.sharedExporter.render(block.source, opts);
        await saveBytes(withExtension(uri, '.svg'), Buffer.from(svg, 'utf8'), { SVG: ['svg'] });
      } else {
        const png = await this.sharedExporter.renderPng(block.source, opts);
        await saveBytes(withExtension(uri, '.png'), png, { PNG: ['png'] });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', (err as Error).message));
    }
  }

  private async autoExportOnSave(document: vscode.TextDocument): Promise<void> {
    if (!vscode.workspace.isTrusted || document.isUntitled) {
      return;
    }
    const mode = config().get<'off' | 'svg' | 'png'>('exportOnSave', 'off');
    if (mode !== 'svg' && mode !== 'png') {
      return;
    }
    const kind = diagramKind(document);
    if (!kind) {
      return;
    }
    if (kind === 'mermaid') {
      const openPreview = this.previews.get(document.uri.toString());
      if (openPreview) {
        openPreview.requestSilentExport(mode);
      }
      return;
    }
    const blocks = splitDiagrams(document.getText());
    if (blocks.length === 0) {
      return;
    }
    const cfg = config();
    const opts = {
      mode: cfg.get<'auto' | 'local' | 'server'>('plantuml.render', 'auto'),
      server: cfg.get('plantuml.server', 'https://www.plantuml.com/plantuml'),
      jar: cfg.get('plantuml.jar', ''),
      java: cfg.get('plantuml.java', 'java'),
      dot: cfg.get('plantuml.dot', ''),
      baseDir: document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined,
    };
    try {
      const target = resolveAutoExportUri(document.uri, mode === 'svg' ? '.svg' : '.png');
      const data =
        mode === 'svg'
          ? Buffer.from(await this.sharedExporter.render(blocks[0].source, opts), 'utf8')
          : await this.sharedExporter.renderPng(blocks[0].source, opts);
      await vscode.workspace.fs.writeFile(target, data);
      void vscode.window.setStatusBarMessage(vscode.l10n.t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', (err as Error).message));
    }
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PreviewState | undefined): Promise<void> {
    if (!state?.uri) {
      panel.dispose();
      return;
    }
    const uri = vscode.Uri.parse(state.uri);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const kind = diagramKind(document);
      if (!kind) {
        panel.dispose();
        return;
      }
      this.create(panel, uri, kind, state.locked === true);
    } catch {
      panel.dispose();
    }
  }

  /** Snapshot of every open preview (backwards-compatible + explicit FSM metadata). */
  snapshot(): Array<{
    uri: string;
    kind: DiagramKind;
    locked: boolean;
    phase: PreviewPhase;
    selectionMode: 'cursor' | 'manual';
    workerPhase: WorkerPhase;
    isSettled: boolean;
    status: RenderStatus;
  }> {
    return [...this.previews.values()].map((p) => ({
      uri: p.uri.toString(),
      kind: p.kind,
      locked: p.locked,
      phase: p.lifecycle.state,
      selectionMode: p.selectionMode,
      workerPhase: p.renderer.snapshot().worker.state,
      isSettled: p.isSettled,
      status: p.status,
    }));
  }

  machines(): MachineSnapshot[] {
    const out: MachineSnapshot[] = [this.sharedExporter.snapshot().worker];
    for (const p of this.previews.values()) {
      out.push(p.lifecycle.snapshot());
      if (p.kind === 'plantuml') {
        out.push(p.renderer.snapshot().worker);
      }
    }
    return out;
  }

  isSettled(): boolean {
    if (!this.sharedExporter.snapshot().isSettled) {
      return false;
    }
    for (const p of this.previews.values()) {
      if (!p.isSettled) {
        return false;
      }
    }
    return true;
  }

  private create(panel: vscode.WebviewPanel, uri: vscode.Uri, kind: DiagramKind, locked: boolean): DiagramPreview {
    const preview = new DiagramPreview(this.context, panel, uri, kind, locked, this.diagnostics, this.onTransition, () => {
      if (this.previews.get(preview.uri.toString()) === preview) {
        this.previews.delete(preview.uri.toString());
      }
    });
    this.previews.set(uri.toString(), preview);
    return preview;
  }
}
