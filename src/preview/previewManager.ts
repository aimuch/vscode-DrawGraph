import * as path from 'node:path';
import * as vscode from 'vscode';
import { onDidChangeAiApiKey } from '../ai/aiProviders';
import { navigateToCodeTarget } from '../codeLinks';
import { buildInteractiveHtmlBundle } from '../export/htmlExporter';
import { buildPdfDocument } from '../export/pdfWriter';
import { getLanguage, t } from '../l10n';
import type { DiagramDiagnostics } from '../language/diagramFeatures';
import { extractMermaidErrorLine } from '../language/symbols';
import { countPages, pickBlock, splitDiagrams } from '../plantuml/encoder';
import { CancelledError, extractPlantUmlError, PlantUmlRenderer, type WorkerPhase } from '../plantuml/renderer';
import type { HostToPreviewMessage, PreviewToHostMessage } from '../protocol/messages';
import { renderDotSvg } from '../renderers/dotRenderer';
import { renderWaveDromToSvg } from '../renderers/wavedromRenderer';
import {
  applySettingUpdate,
  getSettingsSnapshot,
  handleSettingsDrawerAction,
  openExtensionSettingsInVscode,
} from '../settingsSnapshot';
import { StateMachine, type MachineSnapshot, type TransitionRecord, type TransitionTable } from '../stateMachine';
import { config, decodeDataUri, getNonce, isDarkTheme, resolveAutoExportUri, saveBytes, withExtension } from '../util';

export type DiagramKind = 'mermaid' | 'plantuml' | 'dot' | 'wavedrom';

export function diagramKind(document: vscode.TextDocument): DiagramKind | undefined {
  if (
    document.languageId === 'mermaid' ||
    document.languageId === 'plantuml' ||
    document.languageId === 'dot' ||
    document.languageId === 'wavedrom'
  ) {
    return document.languageId;
  }
  const lower = document.uri.path.toLowerCase();
  if (lower.endsWith('.wave.json')) {
    return 'wavedrom';
  }
  const ext = path.extname(lower);
  if (ext === '.mmd' || ext === '.mermaid') {
    return 'mermaid';
  }
  if (['.puml', '.plantuml', '.pu', '.iuml', '.wsd'].includes(ext)) {
    return 'plantuml';
  }
  if (ext === '.dot' || ext === '.gv') {
    return 'dot';
  }
  if (ext === '.wavedrom') {
    return 'wavedrom';
  }
  return undefined;
}

interface PreviewState {
  uri: string;
  locked?: boolean;
}

export type PreviewPhase =
  | 'initializing'
  | 'debouncing'
  | 'rendering'
  | 'ready'
  | 'error'
  | 'empty'
  | 'suspended'
  | 'disposed';
export type PreviewEvent =
  | 'SCHEDULE_UPDATE'
  | 'START_RENDER'
  | 'RENDER_OK'
  | 'RENDER_EMPTY'
  | 'RENDER_ERROR'
  | 'RENDER_CANCELLED'
  | 'SUSPEND'
  | 'RESUME'
  | 'RETARGET'
  | 'DISPOSE';

const PREVIEW_TRANSITIONS: TransitionTable<PreviewPhase, PreviewEvent> = {
  initializing: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    SUSPEND: 'suspended',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  debouncing: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    SUSPEND: 'suspended',
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
    SUSPEND: 'suspended',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  ready: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    SUSPEND: 'suspended',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  error: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    SUSPEND: 'suspended',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  empty: {
    SCHEDULE_UPDATE: 'debouncing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    SUSPEND: 'suspended',
    RETARGET: 'initializing',
    DISPOSE: 'disposed',
  },
  suspended: {
    RESUME: 'initializing',
    START_RENDER: 'rendering',
    RENDER_OK: 'ready',
    RENDER_EMPTY: 'empty',
    RENDER_ERROR: 'error',
    RETARGET: 'suspended',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const PREVIEW_SETTLED: readonly PreviewPhase[] = ['ready', 'error', 'empty', 'suspended', 'disposed'];

type BlockSelectionState =
  | { mode: 'cursor'; line: number | undefined }
  | { mode: 'manual'; blockIndex: number; expectedEditorLine?: number };

export interface RenderStatus {
  state: 'pending' | 'rendered' | 'error' | 'empty';
  width?: number;
  height?: number;
  error?: string;
  count: number;
}

type OffscreenResult = { data?: string; width?: number; height?: number; error?: string };

let previewSeq = 0;

/** A webview panel showing the live rendering of one Mermaid / PlantUML document. */
class DiagramPreview {
  readonly lifecycle: StateMachine<PreviewPhase, PreviewEvent>;
  readonly renderer: PlantUmlRenderer;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingOffscreen = new Map<number, (res: OffscreenResult) => void>();
  private offscreenCounter = 0;
  private webviewReady = false;
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
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) {
          clearTimeout(this.updateTimer);
          this.updateTimer = undefined;
          this.renderer.cancel();
          this.webviewReady = false;
          this.flushPendingOffscreen('Preview hidden');
          this.lifecycle.send('SUSPEND', 'tab hidden');
        } else if (this.lifecycle.state === 'suspended') {
          this.lifecycle.send('RESUME', 'tab revealed');
          if (this.webviewReady) {
            void this.update(true, false);
          }
        }
      }),
      panel.webview.onDidReceiveMessage((msg: PreviewToHostMessage) => this.onMessage(msg)),
    );
  }

  get canRenderOffscreen(): boolean {
    return this.kind === 'mermaid' && this.webviewReady && this.panel.visible && !this.isDisposed;
  }

  private flushPendingOffscreen(reason: string): void {
    for (const resolve of this.pendingOffscreen.values()) {
      resolve({ error: reason });
    }
    this.pendingOffscreen.clear();
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
    const base = t('Preview {0}', path.basename(this.uri.path));
    this.panel.title = this.locked ? `[${base}]` : base;
  }

  toggleLock(): void {
    this.locked = !this.locked;
    this.updateTitle();
    this.pushConfig();
  }

  toggleSettingsDrawer(): void {
    this.post({ type: 'toggleSettings', settings: getSettingsSnapshot() });
  }

  pushSettingsState(): void {
    this.post({ type: 'settingsState', settings: getSettingsSnapshot() });
  }

  highlightCode(candidates: string[]): void {
    this.post({ type: 'highlightCode', candidates });
  }

  private buildLocalizedLabels(): Record<string, string> {
    return {
      locked: t('Locked'),
      pin: t('Pin'),
      bgAuto: t('Bg: Auto'),
      bgLight: t('Bg: Light'),
      bgDark: t('Bg: Dark'),
      bgGrid: t('Bg: Grid'),
      zoomOut: t('Zoom out'),
      resetZoom: t('Reset zoom (100%)'),
      zoomIn: t('Zoom in'),
      fit: t('Fit'),
      fitTitle: t('Fit to window'),
      bgTitle: t('Cycle preview background'),
      map: t('Map'),
      mapTitle: t('Toggle minimap (m)'),
      find: t('Find'),
      findTitle: t('Find text in diagram (Cmd/Ctrl+F or /)'),
      present: t('Present'),
      presentTitle: t('Presentation & Spotlight mode (p)'),
      exitPresent: t('Exit Presentation (Esc)'),
      laser: t('Laser'),
      lockTitle: t('Lock or unlock preview to current file'),
      exportMenu: `${t('Export')} ▾`,
      exportMenuTitle: t('Export or copy diagram'),
      exportSvg: t('Export as SVG'),
      exportSvgTitle: t('Export as SVG'),
      exportPng: t('Export as PNG'),
      exportPngTitle: t('Export as PNG'),
      exportPdf: t('Export as PDF'),
      exportPdfTitle: t('Export as PDF'),
      exportHtml: t('Export as Interactive HTML'),
      exportHtmlTitle: t('Export standalone interactive HTML presentation'),
      copySvg: t('Copy SVG'),
      copySvgTitle: t('Copy SVG to clipboard'),
      copyPng: t('Copy PNG'),
      copyPngTitle: t('Copy PNG image to clipboard'),
      prevTitle: t('Previous diagram or page ([)'),
      nextTitle: t('Next diagram or page (])'),
      rendering: t('Rendering…'),
      settingsTitle: t('Settings'),
      findPlaceholder: t('Find in diagram…'),
      findPrev: t('Previous match'),
      findNext: t('Next match'),
      findClose: t('Close'),
      empty: t('Nothing to preview yet.'),
    };
  }

  pushConfig(): void {
    this.updateTitle();
    const cfg = config();
    this.post({
      type: 'config',
      pngScale: cfg.get<number>('preview.pngScale', 2),
      pngTransparent: cfg.get<boolean>('preview.pngTransparent', false),
      locked: this.locked,
      uri: this.uri.toString(),
      labels: this.buildLocalizedLabels(),
      settings: getSettingsSnapshot(),
    });
  }

  retarget(newUri: vscode.Uri, newKind: DiagramKind, cursorLine?: number): void {
    const prevUri = this.uri;
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.renderer.cancel();
    if (prevUri.toString() !== newUri.toString()) {
      this.diagnostics?.releasePreviewAuthority(prevUri);
    }
    this.uri = newUri;
    this.lastBlockKey = undefined;
    this.selection = { mode: 'cursor', line: cursorLine };
    this.pageIndex = 0;
    this.status = { state: 'pending', count: 0 };
    this.lifecycle.send('RETARGET', path.basename(newUri.path));
    this.updateTitle();

    if (newKind !== this.kind) {
      this.kind = newKind;
      this.webviewReady = false;
      this.flushPendingOffscreen('Preview retargeted');
      this.panel.webview.html = this.getHtml();
    } else {
      this.pushConfig();
      void this.update(true, false);
    }
  }

  setCursorLine(line: number) {
    if (this.kind !== 'plantuml') {
      return;
    }
    if (this.selection.mode === 'manual' && this.selection.expectedEditorLine === line) {
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
    if (!this.panel.visible) {
      this.lastBlockKey = undefined;
      this.lifecycle.send('SUSPEND', 'edit while hidden');
      return;
    }
    clearTimeout(this.updateTimer);
    this.lifecycle.send('SCHEDULE_UPDATE');
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, delay);
  }

  requestSilentExport(format: 'svg' | 'png' | 'pdf'): void {
    this.post({ type: 'silentExport', format });
  }

  requestOffscreenMermaid(source: string, format: 'svg' | 'png'): Promise<OffscreenResult> {
    const requestId = ++this.offscreenCounter;
    return new Promise<OffscreenResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingOffscreen.delete(requestId)) {
          resolve({ error: t('Timed out rendering Mermaid diagram.') });
        }
      }, 20000);
      this.pendingOffscreen.set(requestId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.post({
        type: 'renderOffscreen',
        requestId,
        source,
        theme: mermaidTheme(),
        format,
      });
    });
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

    if (this.kind === 'dot' || this.kind === 'wavedrom') {
      if (!text.trim()) {
        this.lastBlockKey = undefined;
        this.diagnostics?.clear(this.uri);
        this.lifecycle.send('RENDER_EMPTY');
        this.post({ type: 'empty' });
        return;
      }
      if (!force && text === this.lastBlockKey) {
        if (this.lifecycle.state === 'debouncing') {
          this.lifecycle.send('RENDER_OK', 'unchanged');
        }
        return;
      }
      this.lastBlockKey = text;
      this.lifecycle.send('START_RENDER');
      this.post({ type: 'loading' });
      try {
        const svg =
          this.kind === 'dot'
            ? await renderDotSvg(text, config().get('plantuml.dot', ''), vscode.workspace.isTrusted)
            : renderWaveDromToSvg(text);
        this.diagnostics?.clear(this.uri);
        this.post({ type: 'svg', svg, info: '', canNav: false });
      } catch (err) {
        this.lastBlockKey = undefined;
        const msg = (err as Error).message;
        const lineMatch = /line\s+(\d+)/i.exec(msg);
        this.diagnostics?.setError(document, lineMatch ? Math.max(0, parseInt(lineMatch[1], 10) - 1) : 0, msg);
        this.lifecycle.send('RENDER_ERROR');
        this.post({ type: 'error', message: msg });
      }
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
      const pageLabel = totalPages > 1 ? t('Page {0}/{1}', this.pageIndex + 1, totalPages) : '';
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

  private post(message: HostToPreviewMessage) {
    if (!this.isDisposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private async onMessage(msg: PreviewToHostMessage) {
    switch (msg.type) {
      case 'offscreenRendered': {
        const resolve = this.pendingOffscreen.get(msg.requestId);
        this.pendingOffscreen.delete(msg.requestId);
        resolve?.(msg);
        break;
      }
      case 'status': {
        this.status = {
          state: msg.state ?? 'pending',
          width: msg.width,
          height: msg.height,
          error: msg.message,
          count: this.status.count + 1,
        };
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
        this.webviewReady = true;
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
        } else if (msg.format === 'pdf') {
          const pngBytes = decodeDataUri(msg.data);
          const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
          const pdfBytes = buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
          await saveBytes(withExtension(this.uri, '.pdf'), pdfBytes, { PDF: ['pdf'] });
        } else if (msg.format === 'html') {
          const html = buildInteractiveHtmlBundle({
            title: path.basename(this.uri.path),
            pages: [{ name: path.basename(this.uri.path), svg: msg.data }],
            lang: getLanguage(),
            defaultTheme: isDarkTheme() ? 'dark' : 'light',
          });
          await saveBytes(withExtension(this.uri, '.html'), Buffer.from(html, 'utf8'), { HTML: ['html'] });
        }
        break;
      case 'autoExportData': {
        if (!msg.data || !vscode.workspace.isTrusted) {
          return;
        }
        const ext = msg.format === 'svg' ? '.svg' : msg.format === 'pdf' ? '.pdf' : '.png';
        const target = resolveAutoExportUri(this.uri, ext);
        let bytes: Uint8Array;
        if (msg.format === 'svg') {
          bytes = Buffer.from(msg.data, 'utf8');
        } else if (msg.format === 'pdf') {
          const pngBytes = decodeDataUri(msg.data);
          const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
          bytes = buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
        } else {
          bytes = decodeDataUri(msg.data);
        }
        await vscode.workspace.fs.writeFile(target, bytes);
        void vscode.window.setStatusBarMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
        break;
      }
      case 'copy':
        if (msg.data) {
          await vscode.env.clipboard.writeText(msg.data);
          void vscode.window.setStatusBarMessage(t('SVG copied to clipboard'), 2000);
        }
        break;
      case 'copiedPng':
        void vscode.window.setStatusBarMessage(t('PNG copied to clipboard'), 2000);
        break;
      case 'error':
        void vscode.window.showErrorMessage(msg.message ?? 'Unknown error');
        break;
      case 'openSource':
        await this.jumpToSource(msg.label);
        break;
      case 'codeLink': {
        const jumped = msg.target ? await navigateToCodeTarget(msg.target, this.uri) : false;
        if (!jumped) {
          await this.jumpToSource(msg.fallbackLabel ?? msg.target);
        }
        break;
      }
      case 'requestSettings':
        this.post({ type: 'settingsState', settings: getSettingsSnapshot() });
        break;
      case 'updateSetting':
        if (typeof msg.key === 'string') {
          await applySettingUpdate(msg.key, msg.value);
        }
        break;
      case 'drawerAction':
        await handleSettingsDrawerAction(msg.action);
        this.post({ type: 'settingsState', settings: getSettingsSnapshot() });
        break;
      case 'openExtensionSettings':
        await openExtensionSettingsInVscode();
        break;
      case 'openAiStudio':
        await vscode.commands.executeCommand('drawGraph.ai.openStudio', { targetUri: this.uri });
        break;
      case 'aiFixSyntax':
        await vscode.commands.executeCommand('drawGraph.ai.fixSyntax', this.uri, msg.errorHint);
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const cfg = config();
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const imgSrc = vscode.workspace.isTrusted
      ? `${webview.cspSource} https: data: blob:`
      : `${webview.cspSource} data: blob:`;
    const csp = [
      `default-src 'none'`,
      `img-src ${imgSrc}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const tr = (s: string) => escapeAttr(t(s));
    const mermaidScript = this.kind === 'mermaid' ? `<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>` : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('preview', 'main.css')}" rel="stylesheet">
  <link href="${media('shared', 'settingsDrawer.css')}" rel="stylesheet">
</head>
<body
  data-kind="${this.kind}"
  data-uri="${escapeAttr(this.uri.toString())}"
  data-locked="${this.locked}"
  data-png-scale="${cfg.get<number>('preview.pngScale', 2)}"
  data-png-transparent="${cfg.get<boolean>('preview.pngTransparent', false)}"
  data-label-locked="${tr('Locked')}"
  data-label-unlocked="${tr('Pin')}"
  data-bg-auto="${tr('Bg: Auto')}"
  data-bg-light="${tr('Bg: Light')}"
  data-bg-dark="${tr('Bg: Dark')}"
  data-bg-grid="${tr('Bg: Grid')}"
  data-err-invalid-svg="${tr('Invalid SVG received from renderer.')}"
  data-err-mermaid-load="${tr('Mermaid library failed to load.')}"
  data-err-png-raster="${tr('PNG export failed: the SVG could not be rasterized. Try exporting as SVG.')}"
>
  <div id="toolbar">
    <button id="zoomOut" title="${tr('Zoom out')}">−</button>
    <button id="zoomLabel" title="${tr('Reset zoom (100%)')}">100%</button>
    <button id="zoomIn" title="${tr('Zoom in')}">+</button>
    <button id="fit" title="${tr('Fit to window')}">${tr('Fit')}</button>
    <button id="bgToggle" title="${tr('Cycle preview background')}">${tr('Bg: Auto')}</button>
    <button id="mapToggle" title="${tr('Toggle minimap (m)')}">${tr('Map')}</button>
    <button id="findToggle" title="${tr('Find text in diagram (Cmd/Ctrl+F or /)')}">${tr('Find')}</button>
    <button id="presentToggle" title="${tr('Presentation & Spotlight mode (p)')}">${tr('Present')}</button>
    <button id="lockToggle" title="${tr('Lock or unlock preview to current file')}">${tr('Pin')}</button>
    <span class="sep"></span>
    <div class="toolbar-dropdown">
      <button id="exportMenuBtn" type="button" aria-haspopup="menu" aria-expanded="false" title="${tr('Export or copy diagram')}">${tr('Export')} ▾</button>
      <div id="exportDropdown" role="menu" hidden>
        <button id="exportSvg" role="menuitem" title="${tr('Export as SVG')}">${tr('Export as SVG')}</button>
        <button id="exportPng" role="menuitem" title="${tr('Export as PNG')}">${tr('Export as PNG')}</button>
        <button id="exportPdf" role="menuitem" title="${tr('Export as PDF')}">${tr('Export as PDF')}</button>
        <button id="exportHtml" role="menuitem" title="${tr('Export standalone interactive HTML presentation')}">${tr('Export as Interactive HTML')}</button>
        <div class="menu-divider"></div>
        <button id="copySvg" role="menuitem" title="${tr('Copy SVG to clipboard')}">${tr('Copy SVG')}</button>
        <button id="copyPng" role="menuitem" title="${tr('Copy PNG image to clipboard')}">${tr('Copy PNG')}</button>
      </div>
    </div>
    <span class="sep"></span>
    <button id="prevItem" class="nav-btn" title="${tr('Previous diagram or page ([)')}" hidden>◀</button>
    <span id="info"></span>
    <button id="nextItem" class="nav-btn" title="${tr('Next diagram or page (])')}" hidden>▶</button>
    <span class="toolbar-spacer"></span>
    <span id="spinner" hidden>${tr('Rendering…')}</span>
    <button id="aiStudioBtn" type="button" title="${tr('Open AI Diagram Studio')}">✨ AI</button>
    <button id="settingsToggle" title="${tr('Settings')}">⚙</button>
  </div>
  <div id="stage">
    <div id="canvas"></div>
    <div id="presentHud" hidden>
      <button id="laserToggleBtn" type="button">${tr('Laser')}</button>
      <button id="exitPresentBtn" type="button">${tr('Exit Presentation (Esc)')}</button>
    </div>
    <div id="laserDot" hidden></div>
    <div id="findBar" hidden>
      <input id="findInput" type="text" placeholder="${tr('Find in diagram…')}">
      <span id="findCount">0/0</span>
      <button id="findPrev" type="button" title="${tr('Previous match')}">▲</button>
      <button id="findNext" type="button" title="${tr('Next match')}">▼</button>
      <button id="findClose" type="button" title="${tr('Close')}">✕</button>
    </div>
    <div id="minimap" hidden>
      <div id="minimapSvg"></div>
      <div id="minimapViewport"></div>
    </div>
  </div>
  <pre id="error" hidden></pre>
  <button id="aiFixBtn" type="button" hidden>✨ ${tr('Fix with AI')}</button>
  <div id="empty" hidden>${tr('Nothing to preview yet.')}</div>
  ${mermaidScript}
  <script nonce="${nonce}" src="${media('shared', 'settingsDrawer.js')}"></script>
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
    this.webviewReady = false;
    this.diagnostics?.releasePreviewAuthority(this.uri);
    this.flushPendingOffscreen('Preview disposed');
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

export function mermaidTheme(): string {
  const theme = config().get<string>('mermaid.theme', 'auto');
  if (theme === 'auto') {
    return isDarkTheme() ? 'dark' : 'default';
  }
  return theme;
}

export type OffscreenWorkerPhase = 'cold' | 'booting' | 'busy' | 'warm_idle' | 'disposed';
export type OffscreenWorkerEvent =
  | 'SPAWN_WORKER'
  | 'WORKER_READY'
  | 'START_JOB'
  | 'JOBS_DRAINED'
  | 'IDLE_EXPIRED'
  | 'WORKER_CLOSED'
  | 'DISPOSE';

const OFFSCREEN_WORKER_TRANSITIONS: TransitionTable<OffscreenWorkerPhase, OffscreenWorkerEvent> = {
  cold: {
    SPAWN_WORKER: 'booting',
    DISPOSE: 'disposed',
  },
  booting: {
    WORKER_READY: 'warm_idle',
    START_JOB: 'busy',
    WORKER_CLOSED: 'cold',
    DISPOSE: 'disposed',
  },
  busy: {
    WORKER_READY: 'busy',
    START_JOB: 'busy',
    JOBS_DRAINED: 'warm_idle',
    WORKER_CLOSED: 'cold',
    DISPOSE: 'disposed',
  },
  warm_idle: {
    START_JOB: 'busy',
    IDLE_EXPIRED: 'cold',
    WORKER_CLOSED: 'cold',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const OFFSCREEN_WORKER_SETTLED: readonly OffscreenWorkerPhase[] = ['cold', 'warm_idle', 'disposed'];

export class PreviewManager implements vscode.WebviewPanelSerializer {
  static readonly viewType = 'drawGraph.preview';
  private readonly previews = new Map<string, DiagramPreview>();
  private readonly sharedExporter: PlantUmlRenderer;
  private readonly workerLifecycle: StateMachine<OffscreenWorkerPhase, OffscreenWorkerEvent>;
  private workerPanel: vscode.WebviewPanel | undefined;
  private workerReady: Promise<void> | undefined;
  private workerIdleTimer: NodeJS.Timeout | undefined;
  private workerPending = new Map<number, (res: OffscreenResult) => void>();
  private workerReqSeq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics?: DiagramDiagnostics,
    private readonly onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
  ) {
    this.sharedExporter = new PlantUmlRenderer('plantuml-shared-exporter', onTransition);
    this.workerLifecycle = new StateMachine<OffscreenWorkerPhase, OffscreenWorkerEvent>({
      id: 'mermaid-offscreen-worker',
      initial: 'cold',
      transitions: OFFSCREEN_WORKER_TRANSITIONS,
      settledStates: OFFSCREEN_WORKER_SETTLED,
      onTransition,
    });
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
      onDidChangeAiApiKey(() => {
        this.previews.forEach((p) => p.pushSettingsState());
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.autoExportOnSave(doc);
      }),
      {
        dispose: () => {
          this.disposeWorkerPanel(true);
          this.sharedExporter.dispose();
          this.previews.forEach((p) => p.dispose());
        },
      },
    );
  }

  broadcastSettingsState(): void {
    this.previews.forEach((p) => p.pushSettingsState());
  }

  highlightCodeTargets(candidates: string[]): void {
    if (candidates.length === 0) {
      return;
    }
    for (const p of this.previews.values()) {
      if (p.panel.visible) {
        p.highlightCode(candidates);
      }
    }
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

  toggleSettingsDrawer(): boolean {
    const active =
      [...this.previews.values()].find((p) => p.panel.active) ??
      [...this.previews.values()].find((p) => p.panel.visible);
    if (!active) {
      return false;
    }
    active.toggleSettingsDrawer();
    return true;
  }

  async open(uri: vscode.Uri | undefined, toSide: boolean, atLine?: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    if (!target) {
      void vscode.window.showWarningMessage(t('Open a Mermaid or PlantUML file first.'));
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    const kind = diagramKind(document);
    if (!kind) {
      void vscode.window.showWarningMessage(t('This file is not a Mermaid or PlantUML diagram.'));
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

  async renderPlantUmlBytes(source: string, format: 'svg' | 'png' | 'pdf', baseDir?: string): Promise<Uint8Array> {
    const cfg = config();
    const opts = {
      mode: cfg.get<'auto' | 'local' | 'server'>('plantuml.render', 'auto'),
      server: cfg.get('plantuml.server', 'https://www.plantuml.com/plantuml'),
      jar: cfg.get('plantuml.jar', ''),
      java: cfg.get('plantuml.java', 'java'),
      dot: cfg.get('plantuml.dot', ''),
      baseDir,
    };
    if (format === 'svg') {
      let svg = await this.sharedExporter.render(source, opts);
      if (!/<!--\s*SRC=\[/.test(svg)) {
        const { encodePlantUml } = await import('../plantuml/encoder');
        svg = svg.replace(/<\/svg>\s*$/i, `<!--SRC=[${encodePlantUml(source)}]-->\n</svg>`);
      }
      return Buffer.from(svg, 'utf8');
    }
    const pngBytes = await this.sharedExporter.renderPng(source, opts);
    if (format === 'pdf') {
      return buildPdfDocument([{ bytes: pngBytes, format: 'png', scale: 1 }]);
    }
    return pngBytes;
  }

  /**
   * Renders Mermaid source code to `svg`, `png`, or `pdf` bytes, reusing any open Mermaid
   * preview webview or spinning up a short-lived background worker webview when needed.
   */
  async renderMermaidBytes(source: string, format: 'svg' | 'png' | 'pdf'): Promise<Uint8Array> {
    const rasterFmt = format === 'svg' ? 'svg' : 'png';
    const openMermaid = [...this.previews.values()].find((p) => p.canRenderOffscreen);
    let result: OffscreenResult | undefined;
    if (openMermaid) {
      result = await openMermaid.requestOffscreenMermaid(source, rasterFmt);
      if (
        result.error === 'Preview retargeted' ||
        result.error === 'Preview hidden' ||
        result.error === 'Preview disposed'
      ) {
        result = undefined;
      }
    }
    if (!result) {
      result = await this.runInWorkerWebview(source, rasterFmt);
    }

    if (result.error || !result.data) {
      throw new Error(result.error ?? t('Mermaid export failed.'));
    }
    if (format === 'svg') {
      return Buffer.from(result.data, 'utf8');
    }
    const pngBytes = decodeDataUri(result.data);
    if (format === 'pdf') {
      const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
      return buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
    }
    return pngBytes;
  }

  async renderDotBytes(source: string, format: 'svg' | 'png' | 'pdf'): Promise<Uint8Array> {
    const svg = await renderDotSvg(source, config().get('plantuml.dot', ''), vscode.workspace.isTrusted);
    if (format === 'svg') {
      return Buffer.from(svg, 'utf8');
    }
    const pngBytes = await this.rasterizeSvgToPngBytes(svg);
    if (format === 'pdf') {
      const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
      return buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
    }
    return pngBytes;
  }

  async renderWaveDromBytes(source: string, format: 'svg' | 'png' | 'pdf'): Promise<Uint8Array> {
    const svg = renderWaveDromToSvg(source);
    if (format === 'svg') {
      return Buffer.from(svg, 'utf8');
    }
    const pngBytes = await this.rasterizeSvgToPngBytes(svg);
    if (format === 'pdf') {
      const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
      return buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
    }
    return pngBytes;
  }

  /**
   * Rasterizes an arbitrary standalone SVG string into PNG bytes via the background webview worker.
   */
  async rasterizeSvgToPngBytes(svgMarkup: string): Promise<Uint8Array> {
    const res = await this.runInWorkerWebview(svgMarkup, 'png', 'svg_raster');
    if (res.error || !res.data) {
      throw new Error(res.error ?? t('PNG export failed: the SVG could not be rasterized. Try exporting as SVG.'));
    }
    return decodeDataUri(res.data);
  }

  private async runInWorkerWebview(
    source: string,
    format: 'svg' | 'png',
    jobKind: 'mermaid' | 'svg_raster' = 'mermaid',
  ): Promise<OffscreenResult> {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
      this.workerIdleTimer = undefined;
    }

    if (!this.workerPanel) {
      this.workerLifecycle.send('SPAWN_WORKER');
      const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
      const panel = vscode.window.createWebviewPanel(
        'drawGraph.mermaidWorker',
        t('Rendering Mermaid…'),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
      );
      this.workerPanel = panel;
      const nonce = getNonce();
      const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'vendor', 'mermaid.min.js'));
      const pngScale = Math.max(1, config().get<number>('preview.pngScale', 2));

      this.workerReady = new Promise<void>((resolveReady) => {
        const sub = panel.webview.onDidReceiveMessage((msg: { type: string; requestId?: number; data?: string; width?: number; height?: number; error?: string }) => {
          if (msg.type === 'workerReady') {
            this.workerLifecycle.send('WORKER_READY');
            resolveReady();
          } else if (msg.type === 'offscreenRendered' && msg.requestId !== undefined) {
            const cb = this.workerPending.get(msg.requestId);
            this.workerPending.delete(msg.requestId);
            cb?.(msg);
          }
        });
        panel.onDidDispose(() => {
          sub.dispose();
          resolveReady();
          if (this.workerPanel === panel) {
            this.workerPanel = undefined;
            this.workerReady = undefined;
            this.workerLifecycle.send('WORKER_CLOSED');
          }
          for (const cb of this.workerPending.values()) {
            cb({ error: 'Worker closed' });
          }
          this.workerPending.clear();
        });
      });

      const csp = `default-src 'none'; img-src ${panel.webview.cspSource} data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
      panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>
<body>
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  let seq = 0;
  let lastTheme = '';
  let jobChain = Promise.resolve();

  function rasterizeSerializedSvg(serialized, w, h, requestId) {
    const scale = ${pngScale};
    const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = Math.ceil(w * scale);
          c.height = Math.ceil(h * scale);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          vscode.postMessage({ type: 'offscreenRendered', requestId, data: c.toDataURL('image/png'), width: w, height: h });
        } catch (e) {
          vscode.postMessage({ type: 'offscreenRendered', requestId, error: String(e && e.message || e) });
        } finally {
          URL.revokeObjectURL(url);
          resolve();
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        vscode.postMessage({ type: 'offscreenRendered', requestId, error: 'Rasterization failed' });
        resolve();
      };
      img.src = url;
    });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'renderOffscreen') return;
    jobChain = jobChain.then(async () => {
      try {
        let svgMarkup = msg.source;
        if (msg.jobKind !== 'svg_raster') {
          if (msg.theme !== lastTheme) {
            window.mermaid.initialize({ startOnLoad: false, theme: msg.theme || 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } });
            lastTheme = msg.theme;
          }
          const id = 'dg-worker-' + (++seq);
          const out = await window.mermaid.render(id, msg.source);
          document.getElementById('d' + id)?.remove();
          svgMarkup = out.svg;
        }
        const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
        const svg = doc.documentElement;
        const vb = svg.viewBox && svg.viewBox.baseVal;
        const w = (vb && vb.width > 0 ? vb.width : parseFloat(svg.getAttribute('width') || '400')) || 400;
        const h = (vb && vb.height > 0 ? vb.height : parseFloat(svg.getAttribute('height') || '300')) || 300;
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
        svg.removeAttribute('style');
        const serialized = new XMLSerializer().serializeToString(svg);
        if (msg.format === 'svg') {
          vscode.postMessage({ type: 'offscreenRendered', requestId: msg.requestId, data: serialized, width: w, height: h });
          return;
        }
        await rasterizeSerializedSvg(serialized, w, h, msg.requestId);
      } catch (err) {
        vscode.postMessage({ type: 'offscreenRendered', requestId: msg.requestId, error: String(err && err.message || err) });
      }
    });
  });
  vscode.postMessage({ type: 'workerReady' });
})();
</script>
</body></html>`;
    }

    await this.workerReady;
    if (!this.workerPanel) {
      return { error: 'Worker closed' };
    }
    this.workerLifecycle.send('START_JOB', jobKind);
    const requestId = ++this.workerReqSeq;
    const result = await new Promise<OffscreenResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.workerPending.delete(requestId)) {
          resolve({ error: t('Timed out rendering Mermaid diagram.') });
        }
      }, 20000);
      this.workerPending.set(requestId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      void this.workerPanel?.webview.postMessage({
        type: 'renderOffscreen',
        requestId,
        source,
        theme: mermaidTheme(),
        format,
        jobKind,
      });
    });

    if (this.workerPending.size === 0) {
      this.workerLifecycle.send('JOBS_DRAINED');
      this.workerIdleTimer = setTimeout(() => {
        if (this.workerPending.size === 0) {
          this.workerLifecycle.send('IDLE_EXPIRED');
          this.disposeWorkerPanel();
        }
      }, 1500);
    }

    return result;
  }

  private disposeWorkerPanel(finalDispose = false): void {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
      this.workerIdleTimer = undefined;
    }
    const panel = this.workerPanel;
    this.workerPanel = undefined;
    this.workerReady = undefined;
    if (finalDispose) {
      this.workerLifecycle.send('DISPOSE');
    } else if (panel) {
      this.workerLifecycle.send('WORKER_CLOSED');
    }
    panel?.dispose();
  }

  async exportPlantUmlBlock(uri: vscode.Uri, blockIndex: number, format: 'svg' | 'png' | 'pdf'): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const blocks = splitDiagrams(document.getText());
    const block = blocks[blockIndex] ?? blocks[0];
    if (!block) {
      return;
    }
    const baseDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    try {
      const bytes = await this.renderPlantUmlBytes(block.source, format, baseDir);
      const filterMap: Record<string, string[]> =
        format === 'svg' ? { SVG: ['svg'] } : format === 'pdf' ? { PDF: ['pdf'] } : { PNG: ['png'] };
      await saveBytes(withExtension(uri, `.${format}`), bytes, filterMap);
    } catch (err) {
      void vscode.window.showErrorMessage(t('Export failed: {0}', (err as Error).message));
    }
  }

  private async autoExportOnSave(document: vscode.TextDocument): Promise<void> {
    if (!vscode.workspace.isTrusted || document.isUntitled) {
      return;
    }
    const mode = config().get<'off' | 'svg' | 'png' | 'pdf'>('exportOnSave', 'off');
    if (mode !== 'svg' && mode !== 'png' && mode !== 'pdf') {
      return;
    }
    const ext = mode === 'svg' ? '.svg' : mode === 'pdf' ? '.pdf' : '.png';
    const kind = diagramKind(document);
    if (!kind) {
      return;
    }
    if (kind === 'mermaid') {
      const openPreview = this.previews.get(document.uri.toString());
      if (openPreview && openPreview.canRenderOffscreen) {
        openPreview.requestSilentExport(mode);
        return;
      }
      try {
        const bytes = await this.renderMermaidBytes(document.getText(), mode);
        const target = resolveAutoExportUri(document.uri, ext);
        await vscode.workspace.fs.writeFile(target, bytes);
        void vscode.window.setStatusBarMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
      } catch (err) {
        void vscode.window.showErrorMessage(t('Export failed: {0}', (err as Error).message));
      }
      return;
    }
    if (kind === 'dot' || kind === 'wavedrom') {
      try {
        const target = resolveAutoExportUri(document.uri, ext);
        const data =
          kind === 'dot'
            ? await this.renderDotBytes(document.getText(), mode)
            : await this.renderWaveDromBytes(document.getText(), mode);
        await vscode.workspace.fs.writeFile(target, data);
        void vscode.window.setStatusBarMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
      } catch (err) {
        void vscode.window.showErrorMessage(t('Export failed: {0}', (err as Error).message));
      }
      return;
    }
    const blocks = splitDiagrams(document.getText());
    if (blocks.length === 0) {
      return;
    }
    const baseDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    try {
      const target = resolveAutoExportUri(document.uri, ext);
      const data = await this.renderPlantUmlBytes(blocks[0].source, mode, baseDir);
      await vscode.workspace.fs.writeFile(target, data);
      void vscode.window.setStatusBarMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
    } catch (err) {
      void vscode.window.showErrorMessage(t('Export failed: {0}', (err as Error).message));
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
    const out: MachineSnapshot[] = [this.sharedExporter.snapshot().worker, this.workerLifecycle.snapshot()];
    for (const p of this.previews.values()) {
      out.push(p.lifecycle.snapshot());
      if (p.kind === 'plantuml') {
        out.push(p.renderer.snapshot().worker);
      }
    }
    return out;
  }

  isSettled(): boolean {
    if (!this.sharedExporter.snapshot().isSettled || !this.workerLifecycle.isSettled || this.workerPending.size > 0) {
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
