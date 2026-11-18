import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { t } from '../l10n';
import { config } from '../util';
import { extractWebappZipEntries } from './zipReader';

const DEFAULT_RELEASE_WAR_URL = 'https://github.com/jgraph/drawio/releases/latest/download/draw.war';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.properties': 'text/plain; charset=utf-8',
};

export interface OfflinePackStatus {
  installed: boolean;
  fileCount: number;
  serverOrigin?: string;
}

/**
 * Manages an optional on-demand offline Draw.io webapp bundle under `globalStorageUri`
 * and serves it from an ephemeral `127.0.0.1` loopback HTTP server when active.
 */
export class OfflinePackManager implements vscode.Disposable {
  private readonly packDir: string;
  private server: http.Server | undefined;
  private serverPort: number | undefined;
  private startingServer: Promise<string | undefined> | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.packDir = path.join(context.globalStorageUri.fsPath, 'drawio-webapp');
  }

  get directoryPath(): string {
    return this.packDir;
  }

  isInstalled(): boolean {
    try {
      return fs.existsSync(path.join(this.packDir, 'index.html'));
    } catch {
      return false;
    }
  }

  getStatus(): OfflinePackStatus {
    const installed = this.isInstalled();
    let fileCount = 0;
    if (installed) {
      try {
        const metaRaw = fs.readFileSync(path.join(this.packDir, '.drawgraph-pack.json'), 'utf8');
        const meta = JSON.parse(metaRaw) as { fileCount?: number };
        fileCount = typeof meta.fileCount === 'number' ? meta.fileCount : 1;
      } catch {
        fileCount = 1;
      }
    }
    return {
      installed,
      fileCount,
      serverOrigin: this.serverPort ? `http://127.0.0.1:${this.serverPort}` : undefined,
    };
  }

  /**
   * Resolves the effective Draw.io base URL synchronously when possible, returning a
   * Promise only if an installed offline pack needs to cold-start its loopback server.
   */
  resolveBaseUrlSyncOrAsync(): string | Promise<string> {
    const cfg = config();
    const offlineMode = cfg.get<'auto' | 'online' | 'offline'>('drawio.offlineMode', 'auto');
    const configuredUrl = cfg.get<string>('drawio.url', 'https://embed.diagrams.net/') || 'https://embed.diagrams.net/';
    const isDefaultUrl = /^https:\/\/embed\.diagrams\.net\/?$/i.test(configuredUrl.trim());

    if (offlineMode === 'online') {
      return configuredUrl;
    }
    if ((offlineMode === 'offline' || (offlineMode === 'auto' && isDefaultUrl)) && this.isInstalled()) {
      if (this.server && this.serverPort) {
        return `http://127.0.0.1:${this.serverPort}/index.html`;
      }
      return this.ensureServerStarted().then((localUrl) => localUrl || configuredUrl);
    }
    return configuredUrl;
  }

  async resolveBaseUrl(): Promise<string> {
    const res = this.resolveBaseUrlSyncOrAsync();
    return res instanceof Promise ? await res : res;
  }

  async ensureServerStarted(): Promise<string | undefined> {
    if (!this.isInstalled()) {
      return undefined;
    }
    if (this.server && this.serverPort) {
      return `http://127.0.0.1:${this.serverPort}/index.html`;
    }
    if (this.startingServer) {
      return this.startingServer;
    }
    this.startingServer = new Promise<string | undefined>((resolve) => {
      const rootResolved = path.resolve(this.packDir);
      const srv = http.createServer(async (req, res) => {
        try {
          const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
          let relPath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, '');
          if (!relPath || relPath.endsWith('/')) {
            relPath += 'index.html';
          }
          const candidate = path.resolve(rootResolved, relPath);
          if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
          }
          const stat = await fsp.stat(candidate);
          if (!stat.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(candidate).toLowerCase();
          const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
          const bytes = await fsp.readFile(candidate);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': bytes.byteLength,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(bytes);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        }
      });

      srv.once('error', () => {
        this.startingServer = undefined;
        resolve(undefined);
      });

      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.server = srv;
          this.serverPort = addr.port;
          this.startingServer = undefined;
          resolve(`http://127.0.0.1:${addr.port}/index.html`);
        } else {
          srv.close();
          this.startingServer = undefined;
          resolve(undefined);
        }
      });
    });
    return this.startingServer;
  }

  async importFromArchiveBytes(archiveBytes: Uint8Array): Promise<number> {
    const entries = extractWebappZipEntries(archiveBytes);
    const stagingDir = `${this.packDir}.staging-${Date.now()}`;
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });

    const resolvedStaging = path.resolve(stagingDir);
    for (const entry of entries) {
      const dest = path.resolve(resolvedStaging, entry.relativePath);
      if (!dest.startsWith(resolvedStaging + path.sep)) {
        continue;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.data);
    }
    await fsp.writeFile(
      path.join(resolvedStaging, '.drawgraph-pack.json'),
      JSON.stringify({ installedAt: new Date().toISOString(), fileCount: entries.length }, null, 2),
      'utf8',
    );

    await fsp.rm(this.packDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(this.packDir), { recursive: true });
    await fsp.rename(stagingDir, this.packDir);
    await this.ensureServerStarted();
    this.onDidChangeEmitter.fire();
    return entries.length;
  }

  async importFromFile(archiveUri?: vscode.Uri): Promise<boolean> {
    let target = archiveUri;
    if (!target) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: t('Import Draw.io Offline Pack'),
        filters: {
          'Draw.io Archive (.war / .zip)': ['war', 'zip'],
        },
      });
      target = picked?.[0];
    }
    if (!target) {
      return false;
    }
    try {
      const count = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Importing offline Draw.io pack…'),
        },
        async () => {
          const bytes = await vscode.workspace.fs.readFile(target!);
          return this.importFromArchiveBytes(bytes);
        },
      );
      void vscode.window.showInformationMessage(t('Offline Draw.io pack installed ({0} files).', count));
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(t('Offline pack import failed: {0}', (err as Error).message));
      return false;
    }
  }

  async downloadOfficialPack(customUrl?: string): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(t('Offline pack download requires a trusted workspace.'));
      return false;
    }
    const downloadUrl = customUrl || DEFAULT_RELEASE_WAR_URL;
    try {
      const count = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Downloading official Draw.io offline pack (draw.war)…'),
          cancellable: true,
        },
        async (progress, token) => {
          const ctrl = new AbortController();
          const cancelSub = token.onCancellationRequested(() => ctrl.abort());
          try {
            const resp = await fetch(downloadUrl, { signal: ctrl.signal });
            if (!resp.ok) {
              throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
            }
            const totalLen = Number(resp.headers.get('content-length') || 0);
            const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
            if (totalLen > MAX_DOWNLOAD_BYTES) {
              throw new Error('Download exceeds 250 MB safety limit.');
            }
            if (!resp.body) {
              const buf = new Uint8Array(await resp.arrayBuffer());
              return await this.importFromArchiveBytes(buf);
            }
            const reader = resp.body.getReader();
            const chunks: Uint8Array[] = [];
            let received = 0;
            let lastPct = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              if (value) {
                received += value.byteLength;
                if (received > MAX_DOWNLOAD_BYTES) {
                  throw new Error('Download exceeds 250 MB safety limit.');
                }
                chunks.push(value);
                const mb = (received / (1024 * 1024)).toFixed(1);
                if (totalLen > 0) {
                  const pct = Math.min(100, Math.floor((received / totalLen) * 100));
                  const inc = Math.max(0, pct - lastPct);
                  lastPct = pct;
                  progress.report({
                    increment: inc,
                    message: `${mb} / ${(totalLen / (1024 * 1024)).toFixed(1)} MB (${pct}%)`,
                  });
                } else {
                  progress.report({ message: `${mb} MB` });
                }
              }
            }
            const combined = Buffer.concat(chunks);
            return await this.importFromArchiveBytes(combined);
          } finally {
            cancelSub.dispose();
          }
        },
      );
      void vscode.window.showInformationMessage(t('Offline Draw.io pack installed ({0} files).', count));
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return false;
      }
      void vscode.window.showErrorMessage(t('Offline pack download failed: {0}', (err as Error).message));
      return false;
    }
  }

  async removePack(): Promise<void> {
    this.stopServer();
    await fsp.rm(this.packDir, { recursive: true, force: true });
    this.onDidChangeEmitter.fire();
    void vscode.window.setStatusBarMessage(t('Offline Draw.io pack removed'), 2500);
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.serverPort = undefined;
    }
  }

  dispose(): void {
    this.stopServer();
    this.onDidChangeEmitter.dispose();
  }
}
