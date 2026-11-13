import * as vscode from 'vscode';
import { config, decodeDataUri, getNonce, isDarkTheme, saveBytes, withExtension } from '../util';
import { extractDiagramFromSvg, isSvgDiagramPath, replaceEmbeddedDiagram } from './drawioSvg';

type ExportFormat = 'xmlsvg' | 'xmlpng';
type ExportResult = { data?: string; error?: string };

/** Messages sent from the webview to the extension host. */
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'init' }
  | { type: 'loaded' }
  | { type: 'change'; xml: string }
  | { type: 'save'; xml: string }
  | { type: 'export'; requestId: number; data?: string; error?: string }
  | { type: 'error'; message: string };

interface EditorSession {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  pendingExports: Map<number, (result: ExportResult) => void>;
  status: { initialized: boolean; loads: number; changes: number };
}

/**
 * Custom text editor that embeds the draw.io web app (embed mode, JSON protocol)
 * and keeps it in sync with the underlying TextDocument, so dirty state, undo
 * of external edits, save/revert and hot exit are handled by VS Code.
 */
export class DrawioEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'drawGraph.drawio';

  private readonly sessions = new Set<EditorSession>();
  private activeSession: EditorSession | undefined;
  private exportCounter = 0;

  static register(context: vscode.ExtensionContext): DrawioEditorProvider {
    const provider = new DrawioEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(DrawioEditorProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
    );
    return provider;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session: EditorSession = { panel, document, pendingExports: new Map(), status: { initialized: false, loads: 0, changes: 0 } };
    this.sessions.add(session);
    if (panel.active) {
      this.activeSession = session;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview);

    // The XML the draw.io frame currently shows, used to avoid echoing our own edits back.
    let webviewXml: string | undefined;
    let applyingEdit = false;
    let editQueue: Promise<unknown> = Promise.resolve();

    const post = (message: unknown) => panel.webview.postMessage(message);
    // `*.drawio.svg`: the file is an SVG image with the diagram embedded in it.
    const svgFile = isSvgDiagramPath(document.uri.path);

    const sendLoad = () => {
      webviewXml = document.getText();
      let xml = webviewXml;
      if (svgFile && xml.trim() !== '') {
        const embedded = extractDiagramFromSvg(xml);
        if (embedded === undefined) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t('{0} has no embedded draw.io diagram. Editing it will replace the image with a new diagram.', displayName(document.uri)),
          );
        }
        xml = embedded ?? '';
      }
      // draw.io never finishes loading an empty string, so give it a blank page instead.
      // The file itself stays untouched until the user edits the diagram.
      if (xml.trim() === '') {
        xml = EMPTY_DIAGRAM;
      }
      void post({ type: 'load', xml, title: displayName(document.uri) });
    };

    const applyXml = (xml: string) => {
      webviewXml = xml;
      editQueue = editQueue.then(async () => {
        if (document.getText() === xml) {
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        edit.replace(document.uri, fullRange, xml);
        applyingEdit = true;
        try {
          await vscode.workspace.applyEdit(edit);
        } finally {
          applyingEdit = false;
        }
      });
      return editQueue;
    };

    // For SVG files every change is exported from draw.io as an editable SVG. Exports are
    // serialized; changes arriving meanwhile trigger one more export of the latest state.
    let svgSync: Promise<void> | undefined;
    let svgSyncAgain = false;
    // Latest (uncompressed) diagram XML reported by draw.io's autosave/save events.
    let latestXml: string | undefined;
    const syncSvg = (): Promise<void> => {
      if (svgSync) {
        svgSyncAgain = true;
        return svgSync;
      }
      svgSync = (async () => {
        do {
          svgSyncAgain = false;
          const result = await this.requestExport(session, 'xmlsvg', svgColorOptions());
          if (!result.data) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not update {0}: {1}', displayName(document.uri), result.error ?? 'no data'));
            return;
          }
          const svg = Buffer.from(decodeDataUri(result.data)).toString('utf8');
          await applyXml(latestXml && !svgSyncAgain ? replaceEmbeddedDiagram(svg, latestXml) : svg);
        } while (svgSyncAgain);
      })().finally(() => {
        svgSync = undefined;
      });
      return svgSync;
    };

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        switch (message.type) {
          case 'ready':
            void post({
              type: 'setup',
              drawioConfig: config().get<object>('drawio.config') ?? {},
              forwardShortcuts: config().get<boolean>('drawio.vscodeShortcuts', true),
            });
            break;
          case 'init':
            session.status.initialized = true;
            sendLoad();
            break;
          case 'loaded':
            session.status.loads++;
            break;
          case 'change':
            session.status.changes++;
            latestXml = message.xml;
            await (svgFile ? syncSvg() : applyXml(message.xml));
            break;
          case 'save':
            latestXml = message.xml;
            await (svgFile ? syncSvg() : applyXml(message.xml));
            await document.save();
            break;
          case 'export': {
            const resolve = session.pendingExports.get(message.requestId);
            session.pendingExports.delete(message.requestId);
            resolve?.(message);
            break;
          }
          case 'error':
            void vscode.window.showErrorMessage(message.message);
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0 || applyingEdit) {
          return;
        }
        // External change (text editor, git, revert...): reload the diagram.
        if (document.getText() !== webviewXml) {
          sendLoad();
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.activeSession = session;
        } else if (this.activeSession === session) {
          this.activeSession = undefined;
        }
      }),
    );

    panel.onDidDispose(() => {
      this.sessions.delete(session);
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
      for (const resolve of session.pendingExports.values()) {
        resolve({ error: 'Editor closed' });
      }
      disposables.forEach((d) => d.dispose());
    });
  }

  /**
   * Exports the active draw.io editor. Without `target` the user picks a file;
   * with `target` (e.g. from a script or `executeCommand`) it is written directly.
   */
  async exportActive(format: ExportFormat, target?: vscode.Uri): Promise<void> {
    const session = this.activeSession ?? [...this.sessions].find((s) => s.panel.visible);
    if (!session) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No active draw.io editor.'));
      return;
    }
    const isSvg = format === 'xmlsvg';
    const result = await this.requestExport(session, format, {
      spinKey: 'export',
      border: 10,
      ...(isSvg ? svgColorOptions() : { background: '#ffffff' }),
    });
    if (result.error || !result.data) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', result.error ?? 'no data'));
      return;
    }
    if (target) {
      await vscode.workspace.fs.writeFile(target, decodeDataUri(result.data));
      return;
    }
    await saveBytes(
      withExtension(session.document.uri, isSvg ? '.drawio.svg' : '.drawio.png'),
      decodeDataUri(result.data),
      isSvg ? { SVG: ['svg'] } : { PNG: ['png'] },
    );
  }

  /** Asks the draw.io frame for an export; `options` are passed to draw.io's export action. */
  private requestExport(session: EditorSession, format: ExportFormat, options: Record<string, unknown>): Promise<ExportResult> {
    const requestId = ++this.exportCounter;
    return new Promise<ExportResult>((resolve) => {
      session.pendingExports.set(requestId, resolve);
      void session.panel.webview.postMessage({ type: 'export', format, requestId, options });
      setTimeout(() => {
        if (session.pendingExports.delete(requestId)) {
          resolve({ error: vscode.l10n.t('Timed out waiting for draw.io to export.') });
        }
      }, 30000);
    });
  }

  /** Snapshot of every open draw.io editor (diagnostics / integration tests). */
  snapshot(): Array<{ uri: string; active: boolean; initialized: boolean; loads: number; changes: number }> {
    return [...this.sessions].map((s) => ({ uri: s.document.uri.toString(), active: s === this.activeSession, ...s.status }));
  }

  /** Sends a raw draw.io embed-protocol action to the editor of `uri` (diagnostics / integration tests). */
  postAction(uri: string, action: Record<string, unknown>): boolean {
    const session = [...this.sessions].find((s) => s.document.uri.toString() === uri);
    void session?.panel.webview.postMessage({ type: 'action', action });
    return !!session;
  }

  get activeDocumentUri(): vscode.Uri | undefined {
    return this.activeSession?.document.uri;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const drawioUrl = buildDrawioUrl();
    const frameOrigin = drawioUrl.origin;
    const mediaUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'drawio', file));
    const csp = [
      `default-src 'none'`,
      `frame-src ${frameOrigin}`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const loadingText = escapeHtml(vscode.l10n.t('Loading draw.io…'));
    const failText = escapeHtml(
      vscode.l10n.t('draw.io did not load from {0}. Check your network connection or the "drawGraph.drawio.url" setting.', drawioUrl.origin),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${mediaUri('main.css')}" rel="stylesheet">
</head>
<body>
  <div id="status" data-fail="${failText}">${loadingText}</div>
  <!-- main.js sets src only after its message listener is in place: a cached draw.io can
       otherwise send its first handshake message before anyone is listening. -->
  <iframe id="drawio" data-src="${escapeHtml(drawioUrl.toString())}" frameborder="0"></iframe>
  <script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
  }
}

/**
 * draw.io export options for the `drawGraph.drawio.svgColorScheme` setting. By default
 * draw.io writes adaptive SVGs (CSS `light-dark()` colors following the viewer's color
 * scheme); `light` / `dark` pin the colors.
 */
function svgColorOptions(): Record<string, unknown> {
  const scheme = config().get<string>('drawio.svgColorScheme', 'auto');
  return scheme === 'light' || scheme === 'dark' ? { theme: scheme } : {};
}

const EMPTY_DIAGRAM =
  '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

function buildDrawioUrl(): URL {
  const cfg = config();
  let url: URL;
  try {
    url = new URL(cfg.get<string>('drawio.url') || 'https://embed.diagrams.net/');
  } catch {
    url = new URL('https://embed.diagrams.net/');
  }
  const theme = cfg.get<string>('drawio.theme', 'auto');
  const dark = theme === 'dark' || (theme === 'auto' && isDarkTheme());
  const params: Record<string, string> = {
    embed: '1',
    proto: 'json',
    spin: '1',
    libraries: '1',
    configure: '1',
    noSaveBtn: '1',
    noExitBtn: '1',
    saveAndExit: '0',
    ui: cfg.get<string>('drawio.ui', 'kennedy'),
    dark: dark ? '1' : '0',
    lang: drawioLanguage(vscode.env.language),
  };
  for (const [key, value] of Object.entries(params)) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function drawioLanguage(vscodeLang: string): string {
  const lang = vscodeLang.toLowerCase();
  if (lang === 'zh-tw' || lang === 'zh-hk') {
    return 'zh-tw';
  }
  return lang.split('-')[0];
}

function displayName(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? 'diagram';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
