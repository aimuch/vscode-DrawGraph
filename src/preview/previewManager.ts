import * as path from 'node:path';
import * as vscode from 'vscode';
import { pickBlock, splitDiagrams } from '../plantuml/encoder';
import { CancelledError, PlantUmlRenderer } from '../plantuml/renderer';
import { config, decodeDataUri, getNonce, isDarkTheme, saveBytes, withExtension } from '../util';

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
}

/** What the webview last reported, exposed for diagnostics and integration tests. */
export interface RenderStatus {
  state: 'pending' | 'rendered' | 'error' | 'empty';
  width?: number;
  height?: number;
  error?: string;
  /** Number of status reports received so far. */
  count: number;
}

/** A webview panel showing the live rendering of one Mermaid / PlantUML document. */
class DiagramPreview {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly renderer = new PlantUmlRenderer();
  private updateTimer: NodeJS.Timeout | undefined;
  private lastBlockSource: string | undefined;
  private cursorLine: number | undefined;
  private disposed = false;
  status: RenderStatus = { state: 'pending', count: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly panel: vscode.WebviewPanel,
    readonly uri: vscode.Uri,
    readonly kind: DiagramKind,
    private readonly onDispose: () => void,
  ) {
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

  private get document(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
  }

  private updateTitle() {
    this.panel.title = vscode.l10n.t('Preview {0}', path.basename(this.uri.path));
  }

  /** Called when the cursor moves in an editor showing this document (PlantUML: choose the diagram block). */
  setCursorLine(line: number) {
    if (this.kind !== 'plantuml' || this.cursorLine === line) {
      return;
    }
    this.cursorLine = line;
    this.scheduleUpdate(50);
  }

  scheduleUpdate(delay = config().get<number>('preview.debounce', 400)) {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => void this.update(), delay);
  }

  async update(force = false) {
    if (this.disposed) {
      return;
    }
    let document = this.document;
    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(this.uri);
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
        return;
      }
    }
    const text = document.getText();
    if (this.kind === 'mermaid') {
      this.post({ type: 'mermaid', source: text, theme: mermaidTheme() });
      return;
    }

    const blocks = splitDiagrams(text);
    const block = pickBlock(blocks, this.cursorLine);
    if (!block) {
      this.lastBlockSource = undefined;
      this.post({ type: 'empty' });
      return;
    }
    if (!force && block.source === this.lastBlockSource) {
      return;
    }
    this.lastBlockSource = block.source;
    const cfg = config();
    this.post({ type: 'loading' });
    try {
      const svg = await this.renderer.render(block.source, {
        mode: cfg.get('plantuml.render', 'auto'),
        server: cfg.get('plantuml.server', 'https://www.plantuml.com/plantuml'),
        jar: cfg.get('plantuml.jar', ''),
        java: cfg.get('plantuml.java', 'java'),
        dot: cfg.get('plantuml.dot', ''),
        baseDir: document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined,
      });
      this.post({ type: 'svg', svg, info: blocks.length > 1 ? `${blocks.indexOf(block) + 1} / ${blocks.length}` : '' });
    } catch (err) {
      if (err instanceof CancelledError) {
        return;
      }
      this.lastBlockSource = undefined;
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private post(message: unknown) {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private async onMessage(msg: {
    type: string;
    format?: string;
    data?: string;
    message?: string;
    state?: RenderStatus['state'];
    width?: number;
    height?: number;
  }) {
    switch (msg.type) {
      case 'status':
        this.status = { state: msg.state ?? 'pending', width: msg.width, height: msg.height, error: msg.message, count: this.status.count + 1 };
        break;
      case 'ready':
        await this.update(true);
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
      case 'copy':
        if (msg.data) {
          await vscode.env.clipboard.writeText(msg.data);
          void vscode.window.setStatusBarMessage(vscode.l10n.t('SVG copied to clipboard'), 2000);
        }
        break;
      case 'error':
        void vscode.window.showErrorMessage(msg.message ?? 'Unknown error');
        break;
      case 'openSource':
        await vscode.window.showTextDocument(this.uri, { viewColumn: vscode.ViewColumn.One });
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const t = (s: string) => vscode.l10n.t(s);
    const mermaidScript = this.kind === 'mermaid' ? `<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>` : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('preview', 'main.css')}" rel="stylesheet">
</head>
<body data-kind="${this.kind}" data-uri="${escapeAttr(this.uri.toString())}">
  <div id="toolbar">
    <button id="zoomOut" title="${t('Zoom out')}">−</button>
    <button id="zoomLabel" title="${t('Reset zoom (100%)')}">100%</button>
    <button id="zoomIn" title="${t('Zoom in')}">+</button>
    <button id="fit" title="${t('Fit to window')}">${t('Fit')}</button>
    <span class="sep"></span>
    <button id="exportSvg" title="${t('Export as SVG')}">SVG</button>
    <button id="exportPng" title="${t('Export as PNG')}">PNG</button>
    <button id="copySvg" title="${t('Copy SVG to clipboard')}">${t('Copy')}</button>
    <span id="info"></span>
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.updateTimer);
    this.renderer.cancel();
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

  constructor(private readonly context: vscode.ExtensionContext) {
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('drawGraph')) {
          this.previews.forEach((p) => void p.update(true));
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.previews.forEach((p) => void p.update(true));
      }),
      { dispose: () => this.previews.forEach((p) => p.dispose()) },
    );
  }

  async open(uri: vscode.Uri | undefined, toSide: boolean): Promise<void> {
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
    const column = toSide ? vscode.ViewColumn.Beside : (editor?.viewColumn ?? vscode.ViewColumn.Active);
    const existing = this.previews.get(target.toString());
    if (existing) {
      existing.panel.reveal(column, toSide);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PreviewManager.viewType,
      path.basename(target.path),
      { viewColumn: column, preserveFocus: toSide },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const preview = this.create(panel, target, kind);
    if (editor && editor.document.uri.toString() === target.toString()) {
      preview.setCursorLine(editor.selection.active.line);
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
      this.create(panel, uri, kind);
    } catch {
      panel.dispose();
    }
  }

  /** Snapshot of every open preview (diagnostics / integration tests). */
  snapshot(): Array<{ uri: string; kind: DiagramKind; status: RenderStatus }> {
    return [...this.previews.values()].map((p) => ({ uri: p.uri.toString(), kind: p.kind, status: p.status }));
  }

  private create(panel: vscode.WebviewPanel, uri: vscode.Uri, kind: DiagramKind): DiagramPreview {
    const key = uri.toString();
    const preview = new DiagramPreview(this.context, panel, uri, kind, () => this.previews.delete(key));
    this.previews.set(key, preview);
    return preview;
  }
}
