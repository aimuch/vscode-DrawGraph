import * as path from 'node:path';
import * as vscode from 'vscode';
import { config, decodeDataUri, getNonce, isDarkTheme, resolveAutoExportUri, saveBytes, withExtension } from '../util';
import { extractDiagramFromPng, pngBytesToDataUri } from './drawioPng';
import { extractDiagramFromSvg, isSvgDiagramPath, replaceEmbeddedDiagram } from './drawioSvg';

type ExportFormat = 'xmlsvg' | 'xmlpng' | 'png';
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
  uri: vscode.Uri;
  isBinaryPng: boolean;
  pendingExports: Map<number, (result: ExportResult) => void>;
  status: { initialized: boolean; loads: number; changes: number };
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

const SVG_SYNC_DEBOUNCE_MS = 200;
const DEFAULT_BUILTIN_LIBRARIES = 'general;uml;er;bpmn;flowchart;basic;arrows2';

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
  private readonly pendingInitialXml = new Map<string, string>();
  private readonly pngSyncFlushers = new Map<string, () => Promise<boolean>>();
  private readonly pngReloaders = new Map<string, () => void>();
  private readonly onDidChangePngDocEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DrawioPngDocument>>();

  static register(context: vscode.ExtensionContext): DrawioEditorProvider {
    const provider = new DrawioEditorProvider(context);
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
        if (
          e.affectsConfiguration('drawGraph.drawio.config') ||
          e.affectsConfiguration('drawGraph.drawio.vscodeShortcuts') ||
          e.affectsConfiguration('drawGraph.drawio.customLibraries')
        ) {
          void provider.broadcastSetup();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void provider.autoExportOnSave(doc.uri);
      }),
    );
    return provider;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  /** Queues converted `<mxfile>` XML to be loaded and persisted as SVG/PNG when `uri` opens. */
  queueInitialXml(uri: vscode.Uri, mxfileXml: string): void {
    this.pendingInitialXml.set(uri.toString(), mxfileXml);
  }

  private buildSetupPayloadSyncOrAsync(): Record<string, unknown> | Promise<Record<string, unknown>> {
    const cfg = config();
    const baseConfig = { ...(cfg.get<Record<string, unknown>>('drawio.config') ?? {}) };
    const forwardShortcuts = cfg.get<boolean>('drawio.vscodeShortcuts', true);
    const configuredLibs = cfg.get<string[]>('drawio.customLibraries', []);
    if (!vscode.workspace.isTrusted || !Array.isArray(configuredLibs) || configuredLibs.length === 0) {
      return { type: 'setup', drawioConfig: baseConfig, forwardShortcuts };
    }
    return loadCustomLibraries().then((customLibs) => {
      if (customLibs.entries.length > 0) {
        const existingLibs = Array.isArray(baseConfig.libraries) ? baseConfig.libraries : [];
        baseConfig.libraries = [
          ...existingLibs,
          {
            title: { main: vscode.l10n.t('Workspace Libraries') },
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
      void s.panel.webview.postMessage(payload);
    }
  }

  private async autoExportOnSave(savedUri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    const mode = config().get<'off' | 'svg' | 'png'>('exportOnSave', 'off');
    if (mode !== 'svg' && mode !== 'png') {
      return;
    }
    // Skip files that are already self-contained image diagrams.
    if (/\.(?:svg|png)$/i.test(savedUri.path)) {
      return;
    }
    const session = [...this.sessions].find((s) => s.uri.toString() === savedUri.toString());
    if (!session) {
      return;
    }
    const isSvg = mode === 'svg';
    const result = await this.requestExport(session, isSvg ? 'xmlsvg' : 'xmlpng', {
      border: 10,
      ...(isSvg ? svgColorOptions() : { background: '#ffffff' }),
    });
    if (!result.data) {
      return;
    }
    const target = resolveAutoExportUri(savedUri, isSvg ? '.svg' : '.png');
    await vscode.workspace.fs.writeFile(target, decodeDataUri(result.data));
    void vscode.window.setStatusBarMessage(vscode.l10n.t('Exported to {0}', vscode.workspace.asRelativePath(target)), 2500);
  }

  // ---- Text-backed custom editor (.drawio, .dio, .drawio.xml, .drawio.svg) --------------

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session: EditorSession = {
      panel,
      uri: document.uri,
      isBinaryPng: false,
      pendingExports: new Map(),
      status: { initialized: false, loads: 0, changes: 0 },
    };
    this.sessions.add(session);
    if (panel.active) {
      this.activeSession = session;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview);

    let webviewXml: string | undefined;
    let lastAppliedVersion = -1;
    let applyingEdit = false;
    let disposed = false;
    let persistAfterMermaidLoad = false;
    let editQueue: Promise<boolean> = Promise.resolve(true);

    const post = (message: unknown) => {
      if (!disposed) {
        void panel.webview.postMessage(message);
      }
    };
    const svgFile = isSvgDiagramPath(document.uri.path);

    const sendLoad = () => {
      const pendingXml = this.pendingInitialXml.get(document.uri.toString());
      if (pendingXml !== undefined) {
        this.pendingInitialXml.delete(document.uri.toString());
        persistAfterMermaidLoad = true;
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
            vscode.l10n.t('{0} has no embedded draw.io diagram. Editing it will replace the image with a new diagram.', displayName(document.uri)),
          );
        }
        xml = embedded ?? '';
      }
      if (xml.trim() === '') {
        xml = EMPTY_DIAGRAM;
      }
      post({ type: 'load', xml, title: displayName(document.uri) });
    };

    const applyXml = (xml: string): Promise<boolean> => {
      webviewXml = xml;
      const next = editQueue.then(async () => {
        if (disposed) {
          return false;
        }
        if (document.getText() === xml) {
          lastAppliedVersion = document.version;
          return true;
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        edit.replace(document.uri, fullRange, xml);
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
      });
      editQueue = next.catch(() => false);
      return next;
    };

    let svgSync: Promise<boolean> | undefined;
    let svgSyncAgain = false;
    let svgDebounceTimer: NodeJS.Timeout | undefined;
    let pendingDebouncedSync: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | undefined;
    let latestXml: string | undefined;

    const cancelPendingSvgDebounce = () => {
      if (svgDebounceTimer !== undefined) {
        clearTimeout(svgDebounceTimer);
        svgDebounceTimer = undefined;
      }
      if (pendingDebouncedSync) {
        pendingDebouncedSync.resolve(false);
        pendingDebouncedSync = undefined;
      }
    };

    const syncSvgNow = (): Promise<boolean> => {
      if (svgDebounceTimer !== undefined) {
        clearTimeout(svgDebounceTimer);
        svgDebounceTimer = undefined;
      }
      const waiter = pendingDebouncedSync;
      pendingDebouncedSync = undefined;

      if (svgSync) {
        svgSyncAgain = true;
        if (waiter) {
          void svgSync.then(waiter.resolve);
        }
        return svgSync;
      }
      svgSync = (async () => {
        let finalSvg: string | undefined;
        do {
          svgSyncAgain = false;
          const xmlSnapshot = latestXml;
          const result = await this.requestExport(session, 'xmlsvg', svgColorOptions());
          if (disposed) {
            return false;
          }
          if (!result.data) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not update {0}: {1}', displayName(document.uri), result.error ?? 'no data'));
            return false;
          }
          if (svgSyncAgain) {
            continue;
          }
          const svg = Buffer.from(decodeDataUri(result.data)).toString('utf8');
          const xmlToEmbed = latestXml ?? xmlSnapshot;
          finalSvg = xmlToEmbed ? replaceEmbeddedDiagram(svg, xmlToEmbed) : svg;
        } while (svgSyncAgain && !disposed);
        return finalSvg !== undefined ? applyXml(finalSvg) : false;
      })().finally(() => {
        svgSync = undefined;
      });
      if (waiter) {
        void svgSync.then(waiter.resolve);
      }
      return svgSync;
    };

    const scheduleSvgSync = (): Promise<boolean> => {
      if (svgSync) {
        svgSyncAgain = true;
        return svgSync;
      }
      if (!pendingDebouncedSync) {
        let resolveFn!: (ok: boolean) => void;
        const promise = new Promise<boolean>((r) => {
          resolveFn = r;
        });
        pendingDebouncedSync = { promise, resolve: resolveFn };
      }
      if (svgDebounceTimer !== undefined) {
        clearTimeout(svgDebounceTimer);
      }
      svgDebounceTimer = setTimeout(() => {
        svgDebounceTimer = undefined;
        void syncSvgNow();
      }, SVG_SYNC_DEBOUNCE_MS);
      return pendingDebouncedSync.promise;
    };

    let messageChain: Promise<void> = Promise.resolve();
    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (message.type === 'export') {
          const resolve = session.pendingExports.get(message.requestId);
          session.pendingExports.delete(message.requestId);
          resolve?.(message);
          return;
        }
        messageChain = messageChain
          .then(async () => {
            if (disposed) {
              return;
            }
            switch (message.type) {
              case 'ready': {
                const setup = this.buildSetupPayloadSyncOrAsync();
                post(setup instanceof Promise ? await setup : setup);
                break;
              }
              case 'init':
                session.status.initialized = true;
                sendLoad();
                break;
              case 'loaded':
                session.status.loads++;
                if (persistAfterMermaidLoad) {
                  persistAfterMermaidLoad = false;
                  const exported = await this.requestExport(session, 'xmlsvg', svgColorOptions());
                  if (exported.data && !disposed) {
                    const svg = Buffer.from(decodeDataUri(exported.data)).toString('utf8');
                    const embeddedXml = extractDiagramFromSvg(svg);
                    const ok = await applyXml(svgFile ? (embeddedXml ? replaceEmbeddedDiagram(svg, embeddedXml) : svg) : (embeddedXml ?? svg));
                    if (ok && !disposed) {
                      await document.save();
                    }
                  }
                }
                break;
              case 'change': {
                latestXml = message.xml;
                const applied = await (svgFile ? scheduleSvgSync() : applyXml(message.xml));
                if (applied) {
                  session.status.changes++;
                }
                break;
              }
              case 'save': {
                latestXml = message.xml;
                const ok = await (svgFile ? syncSvgNow() : applyXml(message.xml));
                if (ok && !disposed) {
                  await document.save();
                }
                break;
              }
              case 'error':
                void vscode.window.showErrorMessage(message.message);
                break;
            }
          })
          .catch(() => undefined);
      }),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && svgFile && svgDebounceTimer !== undefined) {
          e.waitUntil(syncSvgNow().then(() => []));
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
          cancelPendingSvgDebounce();
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
      disposed = true;
      cancelPendingSvgDebounce();
      this.sessions.delete(session);
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
      for (const resolve of session.pendingExports.values()) {
        resolve({ error: 'Editor closed' });
      }
      session.pendingExports.clear();
      disposables.forEach((d) => d.dispose());
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
    const session: EditorSession = {
      panel,
      uri: document.uri,
      isBinaryPng: true,
      pendingExports: new Map(),
      status: { initialized: false, loads: 0, changes: 0 },
    };
    this.sessions.add(session);
    if (panel.active) {
      this.activeSession = session;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview);

    let disposed = false;
    let persistAfterMermaidLoad = false;
    let writingDisk = false;

    const post = (message: unknown) => {
      if (!disposed) {
        void panel.webview.postMessage(message);
      }
    };

    const sendLoad = () => {
      const pendingXml = this.pendingInitialXml.get(key);
      if (pendingXml !== undefined) {
        this.pendingInitialXml.delete(key);
        persistAfterMermaidLoad = true;
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
          vscode.l10n.t('{0} has no embedded draw.io diagram. Editing it will replace the image with a new diagram.', displayName(document.uri)),
        );
        post({ type: 'load', xml: EMPTY_DIAGRAM, title: displayName(document.uri) });
        return;
      }
      post({ type: 'load', xml: pngBytesToDataUri(document.bytes), title: displayName(document.uri) });
    };

    let pngSync: Promise<boolean> | undefined;
    let pngSyncAgain = false;
    let pngDebounceTimer: NodeJS.Timeout | undefined;
    let pendingDebouncedSync: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | undefined;

    const cancelPendingPngDebounce = () => {
      if (pngDebounceTimer !== undefined) {
        clearTimeout(pngDebounceTimer);
        pngDebounceTimer = undefined;
      }
      if (pendingDebouncedSync) {
        pendingDebouncedSync.resolve(false);
        pendingDebouncedSync = undefined;
      }
    };

    const applyPngBytes = (nextBytes: Uint8Array, emitEditEvent = true): boolean => {
      if (disposed) {
        return false;
      }
      const prevBytes = document.bytes;
      if (prevBytes.length === nextBytes.length && Buffer.compare(prevBytes, nextBytes) === 0) {
        return true;
      }
      document.setBytes(nextBytes);
      if (emitEditEvent) {
        this.onDidChangePngDocEmitter.fire({
          document,
          undo: () => {
            document.setBytes(prevBytes);
            sendLoad();
          },
          redo: () => {
            document.setBytes(nextBytes);
            sendLoad();
          },
        });
      }
      return true;
    };

    const syncPngNow = (): Promise<boolean> => {
      if (pngDebounceTimer !== undefined) {
        clearTimeout(pngDebounceTimer);
        pngDebounceTimer = undefined;
      }
      const waiter = pendingDebouncedSync;
      pendingDebouncedSync = undefined;

      if (pngSync) {
        pngSyncAgain = true;
        if (waiter) {
          void pngSync.then(waiter.resolve);
        }
        return pngSync;
      }
      pngSync = (async () => {
        let latestBytes: Uint8Array | undefined;
        do {
          pngSyncAgain = false;
          const result = await this.requestExport(session, 'xmlpng', { border: 10, background: '#ffffff' });
          if (disposed) {
            return false;
          }
          if (!result.data) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not update {0}: {1}', displayName(document.uri), result.error ?? 'no data'));
            return false;
          }
          if (pngSyncAgain) {
            continue;
          }
          latestBytes = decodeDataUri(result.data);
        } while (pngSyncAgain && !disposed);
        return latestBytes ? applyPngBytes(latestBytes) : false;
      })().finally(() => {
        pngSync = undefined;
      });
      if (waiter) {
        void pngSync.then(waiter.resolve);
      }
      return pngSync;
    };

    const schedulePngSync = (): Promise<boolean> => {
      if (pngSync) {
        pngSyncAgain = true;
        return pngSync;
      }
      if (!pendingDebouncedSync) {
        let resolveFn!: (ok: boolean) => void;
        const promise = new Promise<boolean>((r) => {
          resolveFn = r;
        });
        pendingDebouncedSync = { promise, resolve: resolveFn };
      }
      if (pngDebounceTimer !== undefined) {
        clearTimeout(pngDebounceTimer);
      }
      pngDebounceTimer = setTimeout(() => {
        pngDebounceTimer = undefined;
        void syncPngNow();
      }, SVG_SYNC_DEBOUNCE_MS);
      return pendingDebouncedSync.promise;
    };

    this.pngSyncFlushers.set(key, () => (pngDebounceTimer !== undefined || pngSync ? syncPngNow() : Promise.resolve(true)));
    this.pngReloaders.set(key, () => {
      cancelPendingPngDebounce();
      sendLoad();
    });

    const disposables: vscode.Disposable[] = [];
    if (document.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), path.basename(document.uri.fsPath)),
      );
      watcher.onDidChange(async () => {
        if (writingDisk || document.isDirty || disposed) {
          return;
        }
        try {
          const disk = await vscode.workspace.fs.readFile(document.uri);
          if (Buffer.compare(disk, document.bytes) !== 0) {
            document.markSaved(disk);
            sendLoad();
          }
        } catch {
          // Ignore transient read errors.
        }
      });
      disposables.push(watcher);
    }

    let messageChain: Promise<void> = Promise.resolve();
    disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (message.type === 'export') {
          const resolve = session.pendingExports.get(message.requestId);
          session.pendingExports.delete(message.requestId);
          resolve?.(message);
          return;
        }
        messageChain = messageChain
          .then(async () => {
            if (disposed) {
              return;
            }
            switch (message.type) {
              case 'ready': {
                const setup = this.buildSetupPayloadSyncOrAsync();
                post(setup instanceof Promise ? await setup : setup);
                break;
              }
              case 'init':
                session.status.initialized = true;
                sendLoad();
                break;
              case 'loaded':
                session.status.loads++;
                if (persistAfterMermaidLoad) {
                  persistAfterMermaidLoad = false;
                  const ok = await syncPngNow();
                  if (ok && !disposed) {
                    writingDisk = true;
                    try {
                      await vscode.workspace.fs.writeFile(document.uri, document.bytes);
                      document.markSaved();
                    } finally {
                      writingDisk = false;
                    }
                  }
                }
                break;
              case 'change': {
                const applied = await schedulePngSync();
                if (applied) {
                  session.status.changes++;
                }
                break;
              }
              case 'save': {
                const ok = await syncPngNow();
                if (ok && !disposed) {
                  await vscode.commands.executeCommand('workbench.action.files.save');
                }
                break;
              }
              case 'error':
                void vscode.window.showErrorMessage(message.message);
                break;
            }
          })
          .catch(() => undefined);
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
      disposed = true;
      cancelPendingPngDebounce();
      this.pngSyncFlushers.delete(key);
      this.pngReloaders.delete(key);
      this.sessions.delete(session);
      if (this.activeSession === session) {
        this.activeSession = undefined;
      }
      for (const resolve of session.pendingExports.values()) {
        resolve({ error: 'Editor closed' });
      }
      session.pendingExports.clear();
      disposables.forEach((d) => d.dispose());
    });
  }

  private async savePngDocument(document: DrawioPngDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    const flush = this.pngSyncFlushers.get(document.uri.toString());
    if (flush) {
      await flush();
    }
    await vscode.workspace.fs.writeFile(document.uri, document.bytes);
    document.markSaved();
  }

  private async savePngDocumentAs(
    document: DrawioPngDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const flush = this.pngSyncFlushers.get(document.uri.toString());
    if (flush) {
      await flush();
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
    const flush = this.pngSyncFlushers.get(document.uri.toString());
    if (flush) {
      await flush();
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

  // ---- Shared commands & helpers --------------------------------------------------------

  private get currentSession(): EditorSession | undefined {
    return this.activeSession ?? [...this.sessions].find((s) => s.panel.visible);
  }

  /**
   * Exports the active draw.io editor. Without `target` the user picks a file;
   * with `target` (e.g. from a script or `executeCommand`) it is written directly.
   */
  async exportActive(format: 'xmlsvg' | 'xmlpng', target?: vscode.Uri): Promise<void> {
    const session = this.currentSession;
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
      withExtension(session.uri, isSvg ? '.drawio.svg' : '.drawio.png'),
      decodeDataUri(result.data),
      isSvg ? { SVG: ['svg'] } : { PNG: ['png'] },
    );
  }

  /** Copies the active draw.io diagram to the system clipboard as SVG text or a PNG image. */
  async copyActive(format: 'svg' | 'png'): Promise<void> {
    const session = this.currentSession;
    if (!session) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No active draw.io editor.'));
      return;
    }
    if (format === 'svg') {
      const result = await this.requestExport(session, 'xmlsvg', { border: 10, ...svgColorOptions() });
      if (result.error || !result.data) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', result.error ?? 'no data'));
        return;
      }
      const svg = Buffer.from(decodeDataUri(result.data)).toString('utf8');
      await vscode.env.clipboard.writeText(svg);
      void vscode.window.setStatusBarMessage(vscode.l10n.t('SVG copied to clipboard'), 2000);
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
      void vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', result.error));
      return;
    }
    void vscode.window.setStatusBarMessage(vscode.l10n.t('PNG copied to clipboard'), 2000);
  }

  /** Asks the draw.io frame for an export; `options` are passed to draw.io's export action. */
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
          resolve({ error: vscode.l10n.t('Timed out waiting for draw.io to export.') });
        }
      }, 30000);
      session.pendingExports.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      void session.panel.webview.postMessage({ type: 'export', format, requestId, options, copyToClipboard });
    });
  }

  /** Snapshot of every open draw.io editor (diagnostics / integration tests). */
  snapshot(): Array<{ uri: string; active: boolean; initialized: boolean; loads: number; changes: number }> {
    return [...this.sessions].map((s) => ({ uri: s.uri.toString(), active: s === this.activeSession, ...s.status }));
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

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const drawioUrl = buildDrawioUrl();
    const frameOrigin = drawioUrl.origin;
    const mediaUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'drawio', file));
    const csp = [
      `default-src 'none'`,
      `frame-src ${frameOrigin}`,
      `connect-src data:`,
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

async function loadCustomLibraries(): Promise<{ entries: Array<Record<string, unknown>>; ids: string[] }> {
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
