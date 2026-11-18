import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildPdfDocument } from '../export/pdfWriter';
import { getDrawioLanguage, t } from '../l10n';
import type { DrawioToHostMessage } from '../protocol/messages';
import {
  applySettingUpdate,
  getSettingsSnapshot,
  handleSettingsDrawerAction,
  openExtensionSettingsInVscode,
} from '../settingsSnapshot';
import {
  CoalescedTaskMachine,
  StateMachine,
  type MachineSnapshot,
  type SyncPhase,
  type TransitionRecord,
  type TransitionTable,
} from '../stateMachine';
import { config, decodeDataUri, getNonce, isDarkTheme, resolveAutoExportUri, saveBytes, withExtension } from '../util';
import { buildCodeSymbolMergeXml, extractCodeLinksFromDrawioXml, extractDrawioPages } from './codeLinksXml';
import { discoverWorkspaceLibraryFsPathsSync, loadCustomLibraries, parseMxLibraryXml } from './customLibraryLoader';
import { extractDiagramFromPng, isPngDiagramPath, pngBytesToDataUri } from './drawioPng';
import { extractDiagramFromSvg, isSvgDiagramPath, replaceEmbeddedDiagram } from './drawioSvg';
import { computeMinimalTextChange } from './minimalEdit';
import { renderMxfileToPreviewSvg } from './mxfileToSvg';
import type { OfflinePackManager } from './offlinePackManager';

export { parseMxLibraryXml };

type ExportFormat = 'xmlsvg' | 'xmlpng' | 'png';
type ExportResult = { data?: string; error?: string };

export type DrawioSessionPhase = 'booting' | 'configured' | 'loading_diagram' | 'ready' | 'failed' | 'disposed';
export type DrawioSessionEvent =
  | 'SETUP_SENT'
  | 'BRIDGE_CONFIGURED'
  | 'INIT_RECEIVED'
  | 'LOAD_SENT'
  | 'DIAGRAM_LOADED'
  | 'RELOAD_EXTERNAL'
  | 'LOAD_FAILED'
  | 'RETRY_BOOT'
  | 'DISPOSE';

const SESSION_TRANSITIONS: TransitionTable<DrawioSessionPhase, DrawioSessionEvent> = {
  booting: {
    SETUP_SENT: 'booting',
    BRIDGE_CONFIGURED: 'configured',
    INIT_RECEIVED: 'loading_diagram',
    LOAD_FAILED: 'failed',
    RETRY_BOOT: 'booting',
    DISPOSE: 'disposed',
  },
  configured: {
    SETUP_SENT: 'configured',
    INIT_RECEIVED: 'loading_diagram',
    LOAD_FAILED: 'failed',
    RETRY_BOOT: 'booting',
    DISPOSE: 'disposed',
  },
  loading_diagram: {
    SETUP_SENT: 'loading_diagram',
    LOAD_SENT: 'loading_diagram',
    DIAGRAM_LOADED: 'ready',
    LOAD_FAILED: 'failed',
    RETRY_BOOT: 'booting',
    DISPOSE: 'disposed',
  },
  ready: {
    SETUP_SENT: 'ready',
    LOAD_SENT: 'loading_diagram',
    RELOAD_EXTERNAL: 'loading_diagram',
    DIAGRAM_LOADED: 'ready',
    RETRY_BOOT: 'booting',
    DISPOSE: 'disposed',
  },
  failed: {
    RETRY_BOOT: 'booting',
    INIT_RECEIVED: 'loading_diagram',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const SESSION_SETTLED: readonly DrawioSessionPhase[] = ['ready', 'failed', 'disposed'];

interface EditorSession {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  isBinaryPng: boolean;
  frameOrigin: string;
  lifecycle: StateMachine<DrawioSessionPhase, DrawioSessionEvent>;
  syncMachine?: CoalescedTaskMachine<unknown>;
  pendingExports: Map<number, (result: ExportResult) => void>;
  status: { initialized: boolean; loads: number; changes: number };
  isEditQueueIdle: () => boolean;
  flushPendingEdits: () => Promise<void>;
}

interface SessionHooks {
  sendLoad: (event: 'LOAD_SENT' | 'RELOAD_EXTERNAL') => void;
  onLoaded: () => Promise<void>;
  onChange: (xml: string) => Promise<void>;
  onSave: (xml: string) => Promise<void>;
  onDisposeExtra?: () => void;
}

class DrawioPngDocument implements vscode.CustomDocument {
  private _bytes: Uint8Array;
  private _savedBytes: Uint8Array;
  private _disposed = false;

  constructor(
    readonly uri: vscode.Uri,
    initialBytes: Uint8Array,
  ) {
    this._bytes = initialBytes;
    this._savedBytes = initialBytes;
  }

  get bytes(): Uint8Array {
    return this._bytes;
  }

  get isDirty(): boolean {
    if (this._bytes.length !== this._savedBytes.length) {
      return true;
    }
    return Buffer.compare(this._bytes, this._savedBytes) !== 0;
  }

  setBytes(next: Uint8Array): void {
    this._bytes = next;
  }

  markSaved(saved?: Uint8Array): void {
    if (saved) {
      this._bytes = saved;
    }
    this._savedBytes = this._bytes;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    this._disposed = true;
  }
}

const IMAGE_SYNC_DEBOUNCE_MS = 200;
const DEFAULT_BUILTIN_LIBRARIES = 'general;uml;er;bpmn;flowchart;basic;arrows2';
const DRAWIO_GITHUB_SELECTORS = [
  'a[href*="github.com/jgraph"]',
  'a[href*="github.com/drawio"]',
  '.geTabContainer a[href*="github.com"]',
  '.geFooterContainer a[href*="github.com"]',
  'a[title*="GitHub"]:not(.geDiagramContainer a)',
  'img[src*="github-logo"]:not(.geDiagramContainer img)',
  'img[src*="flows/github"]:not(.geDiagramContainer img)',
].join(', ');
const HIDE_DRAWIO_GITHUB_CSS = `${DRAWIO_GITHUB_SELECTORS} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
const SHOW_DRAWIO_GITHUB_CSS = `${DRAWIO_GITHUB_SELECTORS} { display: inline-block !important; visibility: visible !important; pointer-events: auto !important; }`;

/**
 * Manages embedded draw.io editors for both text-based formats (`.drawio`, `.dio`,
 * `.drawio.xml`, `.drawio.svg`) and binary editable PNGs (`.drawio.png`).
 */
export class DrawioEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'drawGraph.drawio';
  static readonly pngViewType = 'drawGraph.drawioPng';

  private readonly sessions = new Set<EditorSession>();
  private activeSession: EditorSession | undefined;
  private exportCounter = 0;
  private sessionSeq = 0;
  private readonly pendingInitialXml = new Map<string, string>();
  private readonly pendingInitialPage = new Map<string, number>();
  private readonly pngSyncMachines = new Map<string, CoalescedTaskMachine<Uint8Array>>();
  private readonly pngReloaders = new Map<string, () => void>();
  private readonly onDidChangePngDocEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DrawioPngDocument>>();
  private readonly codeLinksStatusBar: vscode.StatusBarItem;

  static register(
    context: vscode.ExtensionContext,
    onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
    offlinePack?: OfflinePackManager,
  ): DrawioEditorProvider {
    const provider = new DrawioEditorProvider(context, onTransition, offlinePack);
    const pngProvider: vscode.CustomEditorProvider<DrawioPngDocument> = {
      onDidChangeCustomDocument: provider.onDidChangePngDocEmitter.event,
      openCustomDocument: (uri, openContext) => provider.openPngDocument(uri, openContext),
      resolveCustomEditor: (document, panel) => provider.resolvePngEditor(document, panel),
      saveCustomDocument: (document, cancellation) => provider.savePngDocument(document, cancellation),
      saveCustomDocumentAs: (document, destination, cancellation) => provider.savePngDocumentAs(document, destination, cancellation),
      revertCustomDocument: (document, cancellation) => provider.revertPngDocument(document, cancellation),
      backupCustomDocument: (document, context, cancellation) => provider.backupPngDocument(document, context, cancellation),
    };

    context.subscriptions.push(
      provider.codeLinksStatusBar,
      provider.onDidChangePngDocEmitter,
      vscode.window.registerCustomEditorProvider(DrawioEditorProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.window.registerCustomEditorProvider(DrawioEditorProvider.pngViewType, pngProvider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('drawGraph')) {
          return;
        }
        provider.refreshStatusBarText();
        provider.broadcastSettingsState();
        if (
          e.affectsConfiguration('drawGraph.language') ||
          e.affectsConfiguration('drawGraph.drawio.theme') ||
          e.affectsConfiguration('drawGraph.drawio.ui') ||
          e.affectsConfiguration('drawGraph.drawio.url') ||
          e.affectsConfiguration('drawGraph.drawio.offlineMode')
        ) {
          void provider.reloadAllFrames();
        } else if (
          e.affectsConfiguration('drawGraph.drawio.config') ||
          e.affectsConfiguration('drawGraph.drawio.vscodeShortcuts') ||
          e.affectsConfiguration('drawGraph.drawio.customLibraries') ||
          e.affectsConfiguration('drawGraph.drawio.autoLoadWorkspaceLibrary') ||
          e.affectsConfiguration('drawGraph.drawio.hideGithubIcon')
        ) {
          void provider.broadcastSetup();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (config().get<string>('drawio.theme', 'auto') === 'auto') {
          void provider.reloadAllFrames();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void provider.autoExportOnSave(doc.uri);
      }),
    );
    if (offlinePack) {
      context.subscriptions.push(
        offlinePack.onDidChange(() => {
          provider.broadcastSettingsState();
          void provider.reloadAllFrames();
        }),
      );
    }
    return provider;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
    private readonly offlinePack?: OfflinePackManager,
  ) {
    this.codeLinksStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.codeLinksStatusBar.command = 'drawGraph.drawio.navigateCodeLinks';
    this.refreshStatusBarText();
  }

  private refreshStatusBarText(): void {
    this.codeLinksStatusBar.text = `$(link) ${t('Code Links')}`;
    this.codeLinksStatusBar.tooltip = t('Navigate #Symbol or file:line Code Links in this Draw.io diagram');
  }

  broadcastSettingsState(): void {
    const settings = getSettingsSnapshot();
    for (const s of this.sessions) {
      void s.panel.webview.postMessage({ type: 'settingsState', settings });
    }
  }

  private resolveEffectiveUrlSyncOrAsync(): URL | Promise<URL> {
    if (!this.offlinePack) {
      return buildDrawioUrl();
    }
    const base = this.offlinePack.resolveBaseUrlSyncOrAsync();
    return base instanceof Promise ? base.then((u) => buildDrawioUrl(u)) : buildDrawioUrl(base);
  }

  private async resolveEffectiveUrl(): Promise<URL> {
    const res = this.resolveEffectiveUrlSyncOrAsync();
    return res instanceof Promise ? await res : res;
  }

  private async reloadAllFrames(): Promise<void> {
    const setup = await this.buildSetupPayloadSyncOrAsync();
    const nextUrl = await this.resolveEffectiveUrl();
    const loadingText = t('Loading draw.io…');
    const failText = t(
      'draw.io did not load from {0}. Check your network connection or the "drawGraph.drawio.url" setting.',
      nextUrl.origin,
    );
    const retryText = t('Retry');

    for (const s of this.sessions) {
      await s.flushPendingEdits();
      if (s.frameOrigin !== nextUrl.origin) {
        s.frameOrigin = nextUrl.origin;
        s.lifecycle.send('RETRY_BOOT');
        s.panel.webview.html = this.getHtml(s.panel.webview, nextUrl);
      } else {
        s.lifecycle.send('SETUP_SENT');
        void s.panel.webview.postMessage(setup);
        void s.panel.webview.postMessage({
          type: 'reloadFrame',
          frameUrl: nextUrl.toString(),
          loadingText,
          failText,
          retryText,
        });
      }
    }
  }

  toggleSettingsDrawer(): boolean {
    const session = this.currentSession;
    if (!session) {
      return false;
    }
    void session.panel.webview.postMessage({ type: 'toggleSettings', settings: getSettingsSnapshot() });
    return true;
  }

  private setActiveSession(session: EditorSession | undefined): void {
    this.activeSession = session;
    if (this.activeSession) {
      this.codeLinksStatusBar.show();
    } else {
      this.codeLinksStatusBar.hide();
    }
  }

  /** Queues converted `<mxfile>` XML to be loaded and persisted as SVG/PNG when `uri` opens. */
  queueInitialXml(uri: vscode.Uri, mxfileXml: string): void {
    this.pendingInitialXml.set(uri.toString(), mxfileXml);
  }

  /** Opens or focuses `uri` in Draw.io and activates the 0-based `<diagram>` tab `pageIndex`. */
  async openAtPage(uri: vscode.Uri, pageIndex: number): Promise<void> {
    this.pendingInitialPage.set(uri.toString(), Math.max(0, pageIndex));
    const viewType = isPngDiagramPath(uri.path) ? DrawioEditorProvider.pngViewType : DrawioEditorProvider.viewType;
    const existing = [...this.sessions].find((s) => s.uri.toString() === uri.toString());
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
    if (existing && existing.status.initialized && !existing.isBinaryPng) {
      const xml = await readDrawioXmlFromUri(uri);
      if (xml) {
        this.pendingInitialPage.delete(uri.toString());
        void existing.panel.webview.postMessage({
          type: 'load',
          xml,
          page: Math.max(0, pageIndex),
          title: displayName(uri),
        });
      }
    }
  }

  private createLifecycleMachine(uri: vscode.Uri): StateMachine<DrawioSessionPhase, DrawioSessionEvent> {
    return new StateMachine<DrawioSessionPhase, DrawioSessionEvent>({
      id: `drawio-editor:${++this.sessionSeq}:${displayName(uri)}`,
      initial: 'booting',
      transitions: SESSION_TRANSITIONS,
      settledStates: SESSION_SETTLED,
      onTransition: this.onTransition,
    });
  }

  private buildSetupPayloadSyncOrAsync(): Record<string, unknown> | Promise<Record<string, unknown>> {
    const cfg = config();
    const baseConfig = { ...(cfg.get<Record<string, unknown>>('drawio.config') ?? {}) };
    const hideGithub = cfg.get<boolean>('drawio.hideGithubIcon', true);
    const userCss = typeof baseConfig.css === 'string' ? baseConfig.css : '';
    const githubCss = hideGithub ? HIDE_DRAWIO_GITHUB_CSS : SHOW_DRAWIO_GITHUB_CSS;
    baseConfig.css = userCss ? `${githubCss}\n${userCss}` : githubCss;

    const forwardShortcuts = cfg.get<boolean>('drawio.vscodeShortcuts', true);
    const configuredLibs = cfg.get<string[]>('drawio.customLibraries', []);
    const autoLibs = discoverWorkspaceLibraryFsPathsSync();
    if (
      !vscode.workspace.isTrusted ||
      ((!Array.isArray(configuredLibs) || configuredLibs.length === 0) && autoLibs.length === 0)
    ) {
      return { type: 'setup', drawioConfig: baseConfig, forwardShortcuts };
    }
    return loadCustomLibraries().then((customLibs) => {
      if (customLibs.entries.length > 0) {
        const existingLibs = Array.isArray(baseConfig.libraries) ? baseConfig.libraries : [];
        baseConfig.libraries = [
          ...existingLibs,
          {
            title: { main: t('Workspace Libraries') },
            entries: customLibs.entries,
          },
        ];
        if (typeof baseConfig.defaultLibraries !== 'string') {
          baseConfig.defaultLibraries = [DEFAULT_BUILTIN_LIBRARIES, ...customLibs.ids].join(';');
        }
      }
      return { type: 'setup', drawioConfig: baseConfig, forwardShortcuts };
    });
  }

  private async broadcastSetup(): Promise<void> {
    const payload = await this.buildSetupPayloadSyncOrAsync();
    for (const s of this.sessions) {
      s.lifecycle.send('SETUP_SENT');
      void s.panel.webview.postMessage(payload);
    }
  }

  private async autoExportOnSave(savedUri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    const mode = config().get<'off' | 'svg' | 'png' | 'pdf'>('exportOnSave', 'off');
    if (mode !== 'svg' && mode !== 'png' && mode !== 'pdf') {
      return;
    }
    if (/\.(?:svg|png|pdf)$/i.test(savedUri.path)) {
      return;
    }
    const session = [...this.sessions].find((s) => s.uri.toString() === savedUri.toString());
    if (!session) {
      return;
    }
    const isSvg = mode === 'svg';
    const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
    const result = await this.requestExport(session, isSvg ? 'xmlsvg' : mode === 'pdf' ? 'png' : 'xmlpng', {
      border: 10,
      ...(isSvg ? svgColorOptions() : { background: '#ffffff', ...(mode === 'pdf' ? { scale } : {}) }),
    });
    if (!result.data) {
      return;
    }
    const rawBytes = decodeDataUri(result.data);
    const outBytes = mode === 'pdf' ? buildPdfDocument([{ bytes: rawBytes, format: 'png', scale }]) : rawBytes;
    const ext = isSvg ? '.svg' : mode === 'pdf' ? '.pdf' : '.png';
    const target = resolveAutoExportUri(savedUri, ext);
    await vscode.workspace.fs.writeFile(target, outBytes);
    void vscode.window.setStatusBarMessage(t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
  }

  /** Shared session message/lifecycle wiring across text and binary PNG Draw.io editors. */
  private wireCommonSessionLifecycle(session: EditorSession, disposables: vscode.Disposable[], hooks: SessionHooks): void {
    const { panel, lifecycle } = session;
    const isDisposed = () => lifecycle.state === 'disposed';
    const post = (message: unknown) => {
      if (!isDisposed()) {
        void panel.webview.postMessage(message);
      }
    };

    let messageChain: Promise<void> = Promise.resolve();
    disposables.push(
      panel.webview.onDidReceiveMessage((message: DrawioToHostMessage) => {
        if (message.type === 'export') {
          const resolve = session.pendingExports.get(message.requestId);
          session.pendingExports.delete(message.requestId);
          resolve?.(message);
          return;
        }
        messageChain = messageChain
          .then(async () => {
            if (isDisposed()) {
              return;
            }
            switch (message.type) {
              case 'ready': {
                lifecycle.send('SETUP_SENT');
                const setup = this.buildSetupPayloadSyncOrAsync();
                post(setup instanceof Promise ? await setup : setup);
                break;
              }
              case 'phase':
                if (message.phase === 'configured') {
                  lifecycle.send('BRIDGE_CONFIGURED');
                } else if (message.phase === 'failed') {
                  lifecycle.send('LOAD_FAILED');
                } else if (message.phase === 'booting') {
                  lifecycle.send('RETRY_BOOT');
                }
                break;
              case 'init':
                session.status.initialized = true;
                lifecycle.send('INIT_RECEIVED');
                hooks.sendLoad('LOAD_SENT');
                break;
              case 'loaded':
                session.status.loads++;
                lifecycle.send('DIAGRAM_LOADED');
                await hooks.onLoaded();
                break;
              case 'change':
                await hooks.onChange(message.xml);
                break;
              case 'save':
                await hooks.onSave(message.xml);
                break;
              case 'error':
                void vscode.window.showErrorMessage(message.message);
                break;
              case 'requestSettings':
                post({ type: 'settingsState', settings: getSettingsSnapshot() });
                break;
              case 'updateSetting':
                await applySettingUpdate(message.key, message.value);
                break;
              case 'drawerAction':
                await handleSettingsDrawerAction(message.action);
                break;
              case 'openExtensionSettings':
                await openExtensionSettingsInVscode();
                break;
            }
          })
          .catch(() => undefined);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.setActiveSession(session);
        } else if (this.activeSession === session) {
          this.setActiveSession(undefined);
        }
      }),
    );

    panel.onDidDispose(() => {
      hooks.onDisposeExtra?.();
      lifecycle.send('DISPOSE');
      this.sessions.delete(session);
      if (this.activeSession === session) {
        this.setActiveSession(undefined);
      }
      for (const resolve of session.pendingExports.values()) {
        resolve({ error: 'Editor closed' });
      }
      session.pendingExports.clear();
      disposables.forEach((d) => d.dispose());
    });
  }

  // ---- Text-backed custom editor (.drawio, .dio, .drawio.xml, .drawio.svg) --------------

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const lifecycle = this.createLifecycleMachine(document.uri);
    let pendingEdits = 0;
    let editQueue: Promise<boolean> = Promise.resolve(true);
    const maybeUrl = this.resolveEffectiveUrlSyncOrAsync();
    const initialUrl = maybeUrl instanceof Promise ? await maybeUrl : maybeUrl;

    const session: EditorSession = {
      panel,
      uri: document.uri,
      isBinaryPng: false,
      frameOrigin: initialUrl.origin,
      lifecycle,
      pendingExports: new Map(),
      status: { initialized: false, loads: 0, changes: 0 },
      isEditQueueIdle: () => pendingEdits === 0 && session.pendingExports.size === 0,
      flushPendingEdits: async () => {
        if (session.syncMachine && !session.syncMachine.isSettled) {
          await session.syncMachine.flush();
        }
        await editQueue;
      },
    };
    this.sessions.add(session);
    if (panel.active) {
      this.setActiveSession(session);
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview, initialUrl);

    let webviewXml: string | undefined;
    let lastAppliedVersion = -1;
    let applyingEdit = false;
    let initialLoadPersist: 'none' | 'persist_on_first_load' = 'none';
    let latestXml: string | undefined;

    const isDisposed = () => lifecycle.state === 'disposed';
    const post = (message: unknown) => {
      if (!isDisposed()) {
        void panel.webview.postMessage(message);
      }
    };
    const svgFile = isSvgDiagramPath(document.uri.path);

    const sendLoad = (event: 'LOAD_SENT' | 'RELOAD_EXTERNAL' = 'LOAD_SENT') => {
      lifecycle.send(event);
      const pendingXml = this.pendingInitialXml.get(document.uri.toString());
      if (pendingXml !== undefined) {
        this.pendingInitialXml.delete(document.uri.toString());
        initialLoadPersist = 'persist_on_first_load';
        latestXml = pendingXml;
        post({ type: 'load', xml: pendingXml, title: displayName(document.uri) });
        return;
      }

      webviewXml = document.getText();
      lastAppliedVersion = document.version;
      let xml = webviewXml;
      if (svgFile && xml.trim() !== '') {
        const embedded = extractDiagramFromSvg(xml);
        if (embedded === undefined) {
          void vscode.window.showWarningMessage(
            t('{0} has no embedded draw.io diagram. Editing it will replace the image with a new diagram.', displayName(document.uri)),
          );
        }
        xml = embedded ?? '';
      }
      if (xml.trim() === '') {
        xml = EMPTY_DIAGRAM;
      }
      const queuedPage = this.pendingInitialPage.get(document.uri.toString());
      if (queuedPage !== undefined) {
        this.pendingInitialPage.delete(document.uri.toString());
      }
      post({ type: 'load', xml, page: queuedPage, title: displayName(document.uri) });
    };

    const applyXml = (xml: string): Promise<boolean> => {
      webviewXml = xml;
      pendingEdits++;
      const next = editQueue.then(async () => {
        try {
          if (isDisposed()) {
            return false;
          }
          const currentText = document.getText();
          const delta = computeMinimalTextChange(currentText, xml);
          if (!delta) {
            lastAppliedVersion = document.version;
            return true;
          }
          const edit = new vscode.WorkspaceEdit();
          const minRange = new vscode.Range(
            document.positionAt(delta.startOffset),
            document.positionAt(delta.endOffset),
          );
          edit.replace(document.uri, minRange, delta.replacement);
          applyingEdit = true;
          try {
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) {
              lastAppliedVersion = document.version;
            }
            return ok;
          } finally {
            applyingEdit = false;
          }
        } finally {
          pendingEdits--;
        }
      });
      editQueue = next.catch(() => false);
      return next;
    };

    const svgSyncMachine = svgFile
      ? new CoalescedTaskMachine<string>({
          id: `${lifecycle.id}:svg-sync`,
          debounceMs: IMAGE_SYNC_DEBOUNCE_MS,
          onTransition: this.onTransition,
          produce: async () => {
            const xmlSnapshot = latestXml;
            const result = await this.requestExport(session, 'xmlsvg', svgColorOptions());
            if (isDisposed()) {
              return undefined;
            }
            if (!result.data) {
              void vscode.window.showErrorMessage(t('Could not update {0}: {1}', displayName(document.uri), result.error ?? 'no data'));
              return undefined;
            }
            const svg = Buffer.from(decodeDataUri(result.data)).toString('utf8');
            const xmlToEmbed = latestXml ?? xmlSnapshot;
            return xmlToEmbed ? replaceEmbeddedDiagram(svg, xmlToEmbed) : svg;
          },
          commit: (finalSvg) => applyXml(finalSvg),
        })
      : undefined;
    session.syncMachine = svgSyncMachine as CoalescedTaskMachine<unknown> | undefined;

    const disposables: vscode.Disposable[] = [
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && svgSyncMachine?.hasPendingDebounce) {
          e.waitUntil(svgSyncMachine.flush().then(() => []));
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.document.uri.toString() !== document.uri.toString() ||
          e.contentChanges.length === 0 ||
          applyingEdit ||
          e.document.version === lastAppliedVersion
        ) {
          return;
        }
        if (document.getText() !== webviewXml) {
          svgSyncMachine?.cancel('external document edit');
          sendLoad('RELOAD_EXTERNAL');
        }
      }),
    ];

    this.wireCommonSessionLifecycle(session, disposables, {
      sendLoad,
      onLoaded: async () => {
        if (initialLoadPersist === 'persist_on_first_load') {
          initialLoadPersist = 'none';
          const exported = await this.requestExport(session, 'xmlsvg', svgColorOptions());
          if (exported.data && !isDisposed()) {
            const svg = Buffer.from(decodeDataUri(exported.data)).toString('utf8');
            const embeddedXml = extractDiagramFromSvg(svg);
            const ok = await applyXml(
              svgFile ? (embeddedXml ? replaceEmbeddedDiagram(svg, embeddedXml) : svg) : (embeddedXml ?? svg),
            );
            if (ok && !isDisposed()) {
              await document.save();
            }
          }
        }
      },
      onChange: async (xml) => {
        latestXml = xml;
        const applied = await (svgSyncMachine ? svgSyncMachine.schedule() : applyXml(xml));
        if (applied) {
          session.status.changes++;
        }
      },
      onSave: async (xml) => {
        latestXml = xml;
        const ok = await (svgSyncMachine ? svgSyncMachine.flush() : applyXml(xml));
        if (ok && !isDisposed()) {
          await document.save();
        }
      },
      onDisposeExtra: () => {
        svgSyncMachine?.dispose();
      },
    });
  }

  // ---- Binary custom editor (.drawio.png) -----------------------------------------------

  private async openPngDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<DrawioPngDocument> {
    const sourceUri = openContext.backupId ? vscode.Uri.file(openContext.backupId) : uri;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(sourceUri);
    } catch {
      bytes = new Uint8Array(0);
    }
    const doc = new DrawioPngDocument(uri, bytes);
    if (openContext.backupId) {
      try {
        const diskBytes = await vscode.workspace.fs.readFile(uri);
        doc.markSaved(diskBytes);
        doc.setBytes(bytes);
      } catch {
        // Unsaved file on disk.
      }
    }
    return doc;
  }

  private async resolvePngEditor(document: DrawioPngDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    const lifecycle = this.createLifecycleMachine(document.uri);
    const maybeUrl = this.resolveEffectiveUrlSyncOrAsync();
    const initialUrl = maybeUrl instanceof Promise ? await maybeUrl : maybeUrl;
    const session: EditorSession = {
      panel,
      uri: document.uri,
      isBinaryPng: true,
      frameOrigin: initialUrl.origin,
      lifecycle,
      pendingExports: new Map(),
      status: { initialized: false, loads: 0, changes: 0 },
      isEditQueueIdle: () => session.pendingExports.size === 0,
      flushPendingEdits: async () => {
        if (session.syncMachine && !session.syncMachine.isSettled) {
          await session.syncMachine.flush();
        }
      },
    };
    this.sessions.add(session);
    if (panel.active) {
      this.setActiveSession(session);
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview, initialUrl);

    let initialLoadPersist: 'none' | 'persist_on_first_load' = 'none';
    let writingDisk = false;

    const isDisposed = () => lifecycle.state === 'disposed';
    const post = (message: unknown) => {
      if (!isDisposed()) {
        void panel.webview.postMessage(message);
      }
    };

    const sendLoad = (event: 'LOAD_SENT' | 'RELOAD_EXTERNAL' = 'LOAD_SENT') => {
      lifecycle.send(event);
      const pendingXml = this.pendingInitialXml.get(key);
      if (pendingXml !== undefined) {
        this.pendingInitialXml.delete(key);
        initialLoadPersist = 'persist_on_first_load';
        post({ type: 'load', xml: pendingXml, title: displayName(document.uri) });
        return;
      }

      if (document.bytes.length === 0) {
        post({ type: 'load', xml: EMPTY_DIAGRAM, title: displayName(document.uri) });
        return;
      }
      const embedded = extractDiagramFromPng(document.bytes);
      if (embedded === undefined) {
        void vscode.window.showWarningMessage(
          t('{0} has no embedded draw.io diagram. Editing it will replace the image with a new diagram.', displayName(document.uri)),
        );
        post({ type: 'load', xml: EMPTY_DIAGRAM, title: displayName(document.uri) });
        return;
      }
      post({ type: 'load', xml: pngBytesToDataUri(document.bytes), title: displayName(document.uri) });
    };

    const pngSyncMachine = new CoalescedTaskMachine<Uint8Array>({
      id: `${lifecycle.id}:png-sync`,
      debounceMs: IMAGE_SYNC_DEBOUNCE_MS,
      onTransition: this.onTransition,
      produce: async () => {
        const result = await this.requestExport(session, 'xmlpng', { border: 10, background: '#ffffff' });
        if (isDisposed()) {
          return undefined;
        }
        if (!result.data) {
          void vscode.window.showErrorMessage(t('Could not update {0}: {1}', displayName(document.uri), result.error ?? 'no data'));
          return undefined;
        }
        return decodeDataUri(result.data);
      },
      commit: (nextBytes) => {
        if (isDisposed()) {
          return false;
        }
        const prevBytes = document.bytes;
        if (prevBytes.length === nextBytes.length && Buffer.compare(prevBytes, nextBytes) === 0) {
          return true;
        }
        document.setBytes(nextBytes);
        this.onDidChangePngDocEmitter.fire({
          document,
          undo: () => {
            document.setBytes(prevBytes);
            sendLoad('RELOAD_EXTERNAL');
          },
          redo: () => {
            document.setBytes(nextBytes);
            sendLoad('RELOAD_EXTERNAL');
          },
        });
        return true;
      },
    });
    session.syncMachine = pngSyncMachine as CoalescedTaskMachine<unknown>;
    this.pngSyncMachines.set(key, pngSyncMachine);
    this.pngReloaders.set(key, () => {
      pngSyncMachine.cancel('revert document');
      sendLoad('RELOAD_EXTERNAL');
    });

    const disposables: vscode.Disposable[] = [];
    if (document.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), path.basename(document.uri.fsPath)),
      );
      watcher.onDidChange(async () => {
        if (writingDisk || document.isDirty || isDisposed()) {
          return;
        }
        try {
          const disk = await vscode.workspace.fs.readFile(document.uri);
          if (Buffer.compare(disk, document.bytes) !== 0) {
            document.markSaved(disk);
            pngSyncMachine.cancel('external disk edit');
            sendLoad('RELOAD_EXTERNAL');
          }
        } catch {
          // Ignore transient read errors.
        }
      });
      disposables.push(watcher);
    }

    this.wireCommonSessionLifecycle(session, disposables, {
      sendLoad,
      onLoaded: async () => {
        if (initialLoadPersist === 'persist_on_first_load') {
          initialLoadPersist = 'none';
          const ok = await pngSyncMachine.flush();
          if (ok && !isDisposed()) {
            writingDisk = true;
            try {
              await vscode.workspace.fs.writeFile(document.uri, document.bytes);
              document.markSaved();
            } finally {
              writingDisk = false;
            }
          }
        }
      },
      onChange: async () => {
        const applied = await pngSyncMachine.schedule();
        if (applied) {
          session.status.changes++;
        }
      },
      onSave: async () => {
        const ok = await pngSyncMachine.flush();
        if (ok && !isDisposed()) {
          await vscode.commands.executeCommand('workbench.action.files.save');
        }
      },
      onDisposeExtra: () => {
        pngSyncMachine.dispose();
        this.pngSyncMachines.delete(key);
        this.pngReloaders.delete(key);
      },
    });
  }

  private async savePngDocument(document: DrawioPngDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    const sync = this.pngSyncMachines.get(document.uri.toString());
    if (sync && !sync.isSettled) {
      await sync.flush();
    }
    await vscode.workspace.fs.writeFile(document.uri, document.bytes);
    document.markSaved();
  }

  private async savePngDocumentAs(
    document: DrawioPngDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const sync = this.pngSyncMachines.get(document.uri.toString());
    if (sync && !sync.isSettled) {
      await sync.flush();
    }
    await vscode.workspace.fs.writeFile(destination, document.bytes);
    document.markSaved();
  }

  private async revertPngDocument(document: DrawioPngDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    const diskBytes = await vscode.workspace.fs.readFile(document.uri);
    document.markSaved(diskBytes);
    this.pngReloaders.get(document.uri.toString())?.();
  }

  private async backupPngDocument(
    document: DrawioPngDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const sync = this.pngSyncMachines.get(document.uri.toString());
    if (sync && !sync.isSettled) {
      await sync.flush();
    }
    await vscode.workspace.fs.writeFile(context.destination, document.bytes);
    return {
      id: context.destination.fsPath,
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Ignore missing backup file.
        }
      },
    };
  }

  // ---- Shared commands & introspection --------------------------------------------------

  private get currentSession(): EditorSession | undefined {
    return this.activeSession ?? [...this.sessions].find((s) => s.panel.visible);
  }

  async exportActive(format: 'xmlsvg' | 'xmlpng', target?: vscode.Uri): Promise<void> {
    const session = this.currentSession;
    if (!session) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return;
    }
    const isSvg = format === 'xmlsvg';
    const result = await this.requestExport(session, format, {
      spinKey: 'export',
      border: 10,
      ...(isSvg ? svgColorOptions() : { background: '#ffffff' }),
    });
    if (result.error || !result.data) {
      void vscode.window.showErrorMessage(t('Export failed: {0}', result.error ?? 'no data'));
      return;
    }
    if (target) {
      await vscode.workspace.fs.writeFile(target, decodeDataUri(result.data));
      return;
    }
    await saveBytes(
      withExtension(session.uri, isSvg ? '.drawio.svg' : '.drawio.png'),
      decodeDataUri(result.data),
      isSvg ? { SVG: ['svg'] } : { PNG: ['png'] },
    );
  }

  async exportActivePdf(target?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const session = this.currentSession;
    if (!session) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return undefined;
    }
    const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
    const result = await this.requestExport(session, 'png', {
      spinKey: 'export',
      border: 10,
      scale,
      background: '#ffffff',
    });
    if (result.error || !result.data) {
      void vscode.window.showErrorMessage(t('Export failed: {0}', result.error ?? 'no data'));
      return undefined;
    }
    const pngBytes = decodeDataUri(result.data);
    const pdfBytes = buildPdfDocument([{ bytes: pngBytes, format: 'png', scale }]);
    if (target) {
      await vscode.workspace.fs.writeFile(target, pdfBytes);
      return target;
    }
    await saveBytes(withExtension(session.uri, '.pdf'), pdfBytes, { PDF: ['pdf'] });
    return withExtension(session.uri, '.pdf');
  }

  /**
   * Exports all `<diagram>` pages of a Draw.io file (either active editor or disk URI)
   * as individual SVG/PNG files or a multi-page PDF document.
   */
  async exportAllPages(
    uriArg?: vscode.Uri,
    format: 'svg' | 'png' | 'pdf' = 'svg',
    outDirArg?: vscode.Uri,
    svgRasterizer?: (svg: string) => Promise<Uint8Array>,
  ): Promise<vscode.Uri[]> {
    let sourceUri = uriArg;
    let rawXml: string | undefined;
    const active = !uriArg ? await this.getActiveDiagramXml() : undefined;
    if (active) {
      sourceUri = active.uri;
      rawXml = active.xml;
    } else if (sourceUri) {
      rawXml = await readDrawioXmlFromUri(sourceUri);
    }

    if (!sourceUri || !rawXml) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return [];
    }

    const pages = extractDrawioPages(rawXml);
    if (pages.length === 0) {
      return [];
    }

    const outDir =
      outDirArg ??
      (sourceUri.scheme === 'file' ? vscode.Uri.joinPath(sourceUri, '..') : vscode.workspace.workspaceFolders?.[0]?.uri);
    if (!outDir) {
      return [];
    }

    const stem =
      path
        .basename(sourceUri.path)
        .replace(/\.(?:drawio|dio)\.(?:svg|png|xml)$/i, '')
        .replace(/\.[^.]+$/, '') || 'diagram';
    const matchingSession = [...this.sessions].find((s) => s.uri.toString() === sourceUri!.toString());
    const scale = Math.max(1, config().get<number>('preview.pngScale', 2));
    const written: vscode.Uri[] = [];
    const pdfPages: Array<{ bytes: Uint8Array; format: 'png'; scale?: number }> = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const safeName = page.name.replace(/[^\w\u0080-\uffff.-]+/g, '_').replace(/^_+|_+$/g, '') || `Page-${i + 1}`;
      const suffix = pages.length === 1 ? '' : `-${safeName}`;
      const singleMxfile = `<mxfile>${page.diagramXml}</mxfile>`;
      const renderedPageSvg = renderMxfileToPreviewSvg(singleMxfile);

      if (format === 'svg') {
        let svgBytes: Uint8Array;
        if (matchingSession && pages.length === 1) {
          const res = await this.requestExport(matchingSession, 'xmlsvg', { border: 10, ...svgColorOptions() });
          svgBytes = res.data
            ? decodeDataUri(res.data)
            : Buffer.from(replaceEmbeddedDiagram(renderedPageSvg, singleMxfile), 'utf8');
        } else {
          svgBytes = Buffer.from(replaceEmbeddedDiagram(renderedPageSvg, singleMxfile), 'utf8');
        }
        const dest = vscode.Uri.joinPath(outDir, `${stem}${suffix}.drawio.svg`);
        await vscode.workspace.fs.writeFile(dest, svgBytes);
        written.push(dest);
      } else {
        let pngBytes: Uint8Array | undefined;
        if (matchingSession && pages.length === 1) {
          const res = await this.requestExport(matchingSession, 'png', {
            border: 10,
            scale,
            background: '#ffffff',
          });
          if (res.data) {
            pngBytes = decodeDataUri(res.data);
          }
        }
        if (!pngBytes && svgRasterizer) {
          pngBytes = await svgRasterizer(renderedPageSvg);
        }
        if (!pngBytes) {
          continue;
        }
        if (format === 'png') {
          const dest = vscode.Uri.joinPath(outDir, `${stem}${suffix}.png`);
          await vscode.workspace.fs.writeFile(dest, pngBytes);
          written.push(dest);
        } else {
          pdfPages.push({ bytes: pngBytes, format: 'png', scale });
        }
      }
    }

    if (format === 'pdf' && pdfPages.length > 0) {
      const pdfDest = vscode.Uri.joinPath(outDir, `${stem}.pdf`);
      await vscode.workspace.fs.writeFile(pdfDest, buildPdfDocument(pdfPages));
      written.push(pdfDest);
    }

    if (written.length > 0) {
      void vscode.window.setStatusBarMessage(t('Exported {0} pages', written.length), 3000);
    }
    return written;
  }

  async copyActive(format: 'svg' | 'png'): Promise<void> {
    const session = this.currentSession;
    if (!session) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return;
    }
    if (format === 'svg') {
      const result = await this.requestExport(session, 'xmlsvg', { border: 10, ...svgColorOptions() });
      if (result.error || !result.data) {
        void vscode.window.showErrorMessage(t('Export failed: {0}', result.error ?? 'no data'));
        return;
      }
      const svg = Buffer.from(decodeDataUri(result.data)).toString('utf8');
      await vscode.env.clipboard.writeText(svg);
      void vscode.window.setStatusBarMessage(t('SVG copied to clipboard'), 2000);
      return;
    }

    const scale = config().get<number>('preview.pngScale', 2);
    const transparent = config().get<boolean>('preview.pngTransparent', false);
    const result = await this.requestExport(
      session,
      'png',
      {
        border: 10,
        scale,
        ...(transparent ? {} : { background: '#ffffff' }),
      },
      true,
    );
    if (result.error) {
      void vscode.window.showErrorMessage(t('Export failed: {0}', result.error));
      return;
    }
    void vscode.window.setStatusBarMessage(t('PNG copied to clipboard'), 2000);
  }

  private requestExport(
    session: EditorSession,
    format: ExportFormat,
    options: Record<string, unknown>,
    copyToClipboard = false,
  ): Promise<ExportResult> {
    const requestId = ++this.exportCounter;
    return new Promise<ExportResult>((resolve) => {
      const timer = setTimeout(() => {
        if (session.pendingExports.delete(requestId)) {
          resolve({ error: t('Timed out waiting for draw.io to export.') });
        }
      }, 30000);
      session.pendingExports.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      void session.panel.webview.postMessage({ type: 'export', format, requestId, options, copyToClipboard });
    });
  }

  /** Snapshot of every open draw.io editor (backwards-compatible + explicit FSM state). */
  snapshot(): Array<{
    uri: string;
    active: boolean;
    initialized: boolean;
    loads: number;
    changes: number;
    phase: DrawioSessionPhase;
    syncPhase: SyncPhase;
    isSettled: boolean;
  }> {
    return [...this.sessions].map((s) => {
      const syncSettled = s.syncMachine ? s.syncMachine.isSettled : true;
      return {
        uri: s.uri.toString(),
        active: s === this.activeSession,
        ...s.status,
        phase: s.lifecycle.state,
        syncPhase: s.syncMachine ? s.syncMachine.state : 'idle',
        isSettled: s.lifecycle.isSettled && syncSettled && s.isEditQueueIdle(),
      };
    });
  }

  machines(): MachineSnapshot[] {
    const out: MachineSnapshot[] = [];
    for (const s of this.sessions) {
      out.push(s.lifecycle.snapshot());
      if (s.syncMachine) {
        out.push(s.syncMachine.snapshot());
      }
    }
    return out;
  }

  isSettled(): boolean {
    for (const s of this.sessions) {
      if (!s.lifecycle.isSettled || !s.isEditQueueIdle() || (s.syncMachine && !s.syncMachine.isSettled)) {
        return false;
      }
    }
    return true;
  }

  /** Sends a raw draw.io embed-protocol action to the editor of `uri` (diagnostics / integration tests). */
  postAction(uri: string, action: Record<string, unknown>): boolean {
    const session = [...this.sessions].find((s) => s.uri.toString() === uri);
    void session?.panel.webview.postMessage({ type: 'action', action });
    return !!session;
  }

  get activeDocumentUri(): vscode.Uri | undefined {
    const session = this.currentSession;
    return session && !session.isBinaryPng ? session.uri : undefined;
  }

  /** Returns the `<mxfile>` XML of the active or visible draw.io editor. */
  async getActiveDiagramXml(): Promise<{ uri: vscode.Uri; xml: string } | undefined> {
    const session = this.currentSession;
    if (!session) {
      return undefined;
    }
    await session.flushPendingEdits();
    if (!session.isBinaryPng) {
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === session.uri.toString());
      if (openDoc) {
        const raw = openDoc.getText();
        if (isSvgDiagramPath(session.uri.path)) {
          const embedded = extractDiagramFromSvg(raw);
          if (embedded) {
            return { uri: session.uri, xml: embedded };
          }
        } else if (raw.trim()) {
          return { uri: session.uri, xml: raw };
        }
      }
    }
    const exported = await this.requestExport(session, 'xmlsvg', {});
    if (exported.data) {
      const svg = Buffer.from(decodeDataUri(exported.data)).toString('utf8');
      const embedded = extractDiagramFromSvg(svg);
      if (embedded) {
        return { uri: session.uri, xml: embedded };
      }
    }
    return undefined;
  }

  async reloadWorkspaceLibraries(): Promise<void> {
    await this.broadcastSetup();
  }

  async highlightCodeTargets(candidates: string[]): Promise<void> {
    if (this.sessions.size === 0 || candidates.length === 0) {
      return;
    }
    const needles = candidates.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    for (const s of this.sessions) {
      if (!s.panel.visible) continue;
      try {
        const xml = await readDrawioXmlFromUri(s.uri);
        if (!xml) continue;
        const links = extractCodeLinksFromDrawioXml(xml);
        const hit = links.find((lk) => {
          const tgt = lk.target.toLowerCase();
          const lbl = lk.label.toLowerCase();
          return needles.some((nd) => {
            const bare = nd.startsWith('#') ? nd.slice(1) : nd;
            return tgt.includes(nd) || tgt.includes(bare) || lbl === bare;
          });
        });
        if (hit) {
          this.codeLinksStatusBar.text = `$(target) ${hit.label}`;
          this.codeLinksStatusBar.show();
          return;
        }
      } catch {
        // Ignore
      }
    }
    this.refreshStatusBarText();
  }

  /** Merges a code-linked `#Symbol` or `file:line` node into the active draw.io editor. */
  insertCodeSymbolNode(label: string, linkTarget: string): boolean {
    const session = this.currentSession;
    if (!session) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return false;
    }
    const xml = buildCodeSymbolMergeXml(label, linkTarget);
    void session.panel.webview.postMessage({ type: 'action', action: { action: 'merge', xml } });
    return true;
  }

  private getHtml(webview: vscode.Webview, drawioUrl = buildDrawioUrl()): string {
    const nonce = getNonce();
    const frameOrigin = drawioUrl.origin;
    const mediaUri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...parts));
    const csp = [
      `default-src 'none'`,
      `frame-src ${frameOrigin}`,
      `connect-src data:`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const loadingText = escapeHtml(t('Loading draw.io…'));
    const failText = escapeHtml(
      t('draw.io did not load from {0}. Check your network connection or the "drawGraph.drawio.url" setting.', drawioUrl.origin),
    );
    const retryText = escapeHtml(t('Retry'));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${mediaUri('drawio', 'main.css')}" rel="stylesheet">
  <link href="${mediaUri('shared', 'settingsDrawer.css')}" rel="stylesheet">
</head>
<body>
  <div id="status" data-loading="${loadingText}" data-fail="${failText}">
    <span id="statusText">${loadingText}</span>
    <button id="retryBtn" type="button" hidden>${retryText}</button>
  </div>
  <!-- main.js sets src only after its message listener is in place: a cached draw.io can
       otherwise send its first handshake message before anyone is listening. -->
  <iframe id="drawio" data-src="${escapeHtml(drawioUrl.toString())}" frameborder="0"></iframe>
  <script nonce="${nonce}" src="${mediaUri('shared', 'settingsDrawer.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('drawio', 'main.js')}"></script>
</body>
</html>`;
  }
}

export async function readDrawioXmlFromUri(uri: vscode.Uri): Promise<string | undefined> {
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (openDoc) {
    const text = openDoc.getText();
    if (isSvgDiagramPath(uri.path)) {
      return extractDiagramFromSvg(text);
    }
    return text.trim() ? text : undefined;
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (isPngDiagramPath(uri.path)) {
    return extractDiagramFromPng(bytes);
  }
  const raw = Buffer.from(bytes).toString('utf8');
  if (isSvgDiagramPath(uri.path)) {
    return extractDiagramFromSvg(raw);
  }
  return raw.trim() ? raw : undefined;
}

function svgColorOptions(): Record<string, unknown> {
  const scheme = config().get<string>('drawio.svgColorScheme', 'auto');
  return scheme === 'light' || scheme === 'dark' ? { theme: scheme } : {};
}

const EMPTY_DIAGRAM =
  '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

function buildDrawioUrl(explicitBaseUrl?: string): URL {
  const cfg = config();
  const rawBase = explicitBaseUrl || cfg.get<string>('drawio.url') || 'https://embed.diagrams.net/';
  let url: URL;
  try {
    url = new URL(rawBase);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      url = new URL('https://embed.diagrams.net/');
    }
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
    lang: getDrawioLanguage(),
  };
  for (const [key, value] of Object.entries(params)) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function displayName(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? 'diagram';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
