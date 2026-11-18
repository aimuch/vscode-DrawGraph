import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { extractDrawioPages } from '../drawio/codeLinksXml';
import { extractDiagramFromSvg, isSvgDiagramPath } from '../drawio/drawioSvg';
import { measureMxfileBounds, renderMxfileToPreviewSvg, unionMxfileBounds } from '../drawio/mxfileToSvg';
import { t } from '../l10n';
import { splitDiagrams } from '../plantuml/encoder';
import { mermaidTheme, type PreviewManager } from '../preview/previewManager';
import { getNonce } from '../util';

const execFileAsync = promisify(execFile);

export interface NormalizedDiffSide {
  label: string;
  empty: boolean;
  renderKind: 'svg' | 'png' | 'mermaid';
  payload: string;
}

export interface DiffSnapshot {
  uri: string;
  gitRef?: string;
  pageIndex: number;
  pageCount: number;
  ready: boolean;
  beforeEmpty: boolean;
  afterEmpty: boolean;
}

interface DiffSession {
  mode: 'git' | 'files';
  targetUri: vscode.Uri;
  leftUri?: vscode.Uri;
  gitRef: string;
  pageIndex: number;
  pages: string[];
  panel: vscode.WebviewPanel;
  ready: boolean;
  beforeEmpty: boolean;
  afterEmpty: boolean;
}

export function extractResourceUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'resourceUri' in arg) {
    const candidate = (arg as { resourceUri?: unknown }).resourceUri;
    if (candidate instanceof vscode.Uri) {
      return candidate;
    }
  }
  return undefined;
}

async function resolveGitRepoRoot(fileUri: vscode.Uri): Promise<string | undefined> {
  if (!vscode.workspace.isTrusted || fileUri.scheme !== 'file') {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], {
      cwd: path.dirname(fileUri.fsPath),
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readGitRefBytes(fileUri: vscode.Uri, gitRef = 'HEAD'): Promise<{ bytes?: Uint8Array; refLabel: string }> {
  if (!vscode.workspace.isTrusted) {
    return { refLabel: t('Untrusted workspace') };
  }
  const repoRoot = await resolveGitRepoRoot(fileUri);
  if (!repoRoot) {
    return { refLabel: `${gitRef} (${t('not in commit')})` };
  }
  try {
    const relPosix = path.relative(repoRoot, fileUri.fsPath).split(path.sep).join('/');
    const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'show', `${gitRef}:${relPosix}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 25 * 1024 * 1024,
    });
    return { bytes: new Uint8Array(stdout), refLabel: gitRef };
  } catch {
    return { bytes: undefined, refLabel: `${gitRef} (${t('not in commit')})` };
  }
}

async function listGitRefsForFile(fileUri: vscode.Uri): Promise<Array<{ ref: string; detail: string }>> {
  const repoRoot = await resolveGitRepoRoot(fileUri);
  if (!repoRoot) {
    return [{ ref: 'HEAD', detail: 'Current commit' }];
  }
  const items: Array<{ ref: string; detail: string }> = [
    { ref: 'HEAD', detail: t('Latest commit (HEAD)') },
    { ref: 'HEAD~1', detail: t('Previous commit (HEAD~1)') },
  ];
  try {
    const relPosix = path.relative(repoRoot, fileUri.fsPath).split(path.sep).join('/');
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'log', '-n', '12', '--pretty=format:%h\t%s (%cr)', '--', relPosix],
      { cwd: repoRoot },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const [hash, subject] = line.split('\t');
      if (hash && subject) {
        items.push({ ref: hash.trim(), detail: subject.trim() });
      }
    }
  } catch {
    // Ignore git log failures
  }
  return items;
}

async function readWorkingBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (openDoc) {
    return Buffer.from(openDoc.getText(), 'utf8');
  }
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

function extractRawMxfileText(filePath: string, bytes?: Uint8Array): string | undefined {
  if (!bytes || bytes.byteLength === 0 || filePath.toLowerCase().endsWith('.png')) {
    return undefined;
  }
  const raw = Buffer.from(bytes).toString('utf8');
  if (isSvgDiagramPath(filePath)) {
    return extractDiagramFromSvg(raw);
  }
  if (/\.(?:drawio|dio|xml)$/i.test(filePath) && raw.includes('<mx')) {
    return raw;
  }
  return undefined;
}

export class VisualDiffManager implements vscode.Disposable {
  private readonly sessions = new Set<DiffSession>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly previews: PreviewManager,
  ) {
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('drawGraph.language') || e.affectsConfiguration('drawGraph.mermaid.theme')) {
          for (const s of this.sessions) {
            void this.refreshSession(s);
          }
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        for (const s of this.sessions) {
          void this.refreshSession(s);
        }
      }),
    );
  }

  snapshot(): DiffSnapshot[] {
    return [...this.sessions].map((s) => ({
      uri: s.targetUri.toString(),
      gitRef: s.mode === 'git' ? s.gitRef : undefined,
      pageIndex: s.pageIndex,
      pageCount: s.pages.length,
      ready: s.ready,
      beforeEmpty: s.beforeEmpty,
      afterEmpty: s.afterEmpty,
    }));
  }

  async openGitDiff(targetUri: vscode.Uri, gitRef = 'HEAD'): Promise<boolean> {
    const session = this.createPanelSession('git', targetUri, `${path.basename(targetUri.path)} (${t('Visual Diff')})`, gitRef);
    await this.refreshSession(session);
    return true;
  }

  async openFileComparison(beforeUri?: vscode.Uri, afterUri?: vscode.Uri): Promise<boolean> {
    let left = beforeUri;
    let right = afterUri;
    const filters = {
      Diagrams: ['drawio', 'dio', 'svg', 'png', 'mmd', 'mermaid', 'puml', 'plantuml', 'pu', 'iuml', 'wsd'],
    };
    if (!left) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: t('Select "Before" Diagram'),
        filters,
      });
      left = picked?.[0];
    }
    if (!left) {
      return false;
    }
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: t('Select "After" Diagram'),
        filters,
      });
      right = picked?.[0];
    }
    if (!right) {
      return false;
    }

    const session = this.createPanelSession(
      'files',
      right,
      `${path.basename(left.path)} ↔ ${path.basename(right.path)}`,
      'HEAD',
      left,
    );
    await this.refreshSession(session);
    return true;
  }

  private buildUiLabels(): Record<string, string> {
    return {
      side: t('Side-by-Side'),
      swipe: t('Swipe'),
      onion: t('Onion / Pixel Diff'),
      zoomOut: t('Zoom out'),
      zoomReset: t('Reset zoom (100%)'),
      zoomIn: t('Zoom in'),
      fit: t('Fit'),
      opacity: t('Opacity'),
      pixelDiff: t('Highlight Changed Pixels'),
      emptyText: t('Empty / Not Present'),
      refPrefix: t('Base: {0}', ''),
    };
  }

  private async computeSessionPayload(session: DiffSession) {
    let leftBytes: Uint8Array | undefined;
    let leftLabel: string;
    let leftPath = session.targetUri.path;

    if (session.mode === 'git') {
      const gitData = await readGitRefBytes(session.targetUri, session.gitRef);
      leftBytes = gitData.bytes;
      leftLabel = gitData.refLabel;
    } else {
      leftPath = session.leftUri!.path;
      leftBytes = await readWorkingBytes(session.leftUri!);
      leftLabel = path.basename(leftPath);
    }

    const rightBytes = await readWorkingBytes(session.targetUri);
    const rightLabel = session.mode === 'git' ? t('Working Tree') : path.basename(session.targetUri.path);

    // Discover multi-page Draw.io tabs and compute unified bounding box so unchanged shapes stay aligned!
    const mxLeft = extractRawMxfileText(leftPath, leftBytes);
    const mxRight = extractRawMxfileText(session.targetUri.path, rightBytes);
    const leftPages = mxLeft ? extractDrawioPages(mxLeft) : [];
    const rightPages = mxRight ? extractDrawioPages(mxRight) : [];
    const maxPages = Math.max(leftPages.length, rightPages.length);
    const pageNames: string[] = [];
    for (let i = 0; i < maxPages; i++) {
      pageNames.push(rightPages[i]?.name || leftPages[i]?.name || `Page ${i + 1}`);
    }
    session.pages = pageNames;
    if (session.pageIndex >= Math.max(1, pageNames.length)) {
      session.pageIndex = 0;
    }

    const useUnifiedMxfile =
      Boolean(mxLeft || mxRight) &&
      (/\.(?:drawio|dio|xml)$/i.test(leftPath) || session.pageIndex > 0) &&
      (/\.(?:drawio|dio|xml)$/i.test(session.targetUri.path) || session.pageIndex > 0);

    const unifiedBounds = useUnifiedMxfile
      ? unionMxfileBounds(
          mxLeft ? measureMxfileBounds(mxLeft, session.pageIndex) : undefined,
          mxRight ? measureMxfileBounds(mxRight, session.pageIndex) : undefined,
        )
      : undefined;

    const before = useUnifiedMxfile && mxLeft
      ? {
          label: leftLabel,
          empty: false,
          renderKind: 'svg' as const,
          payload: renderMxfileToPreviewSvg(mxLeft, session.pageIndex, unifiedBounds),
        }
      : await this.normalizeDiagramBytes(
          leftPath,
          leftBytes,
          leftLabel,
          session.leftUri?.scheme === 'file' ? path.dirname(session.leftUri.fsPath) : path.dirname(session.targetUri.fsPath),
          session.pageIndex,
        );

    const after = useUnifiedMxfile && mxRight
      ? {
          label: rightLabel,
          empty: false,
          renderKind: 'svg' as const,
          payload: renderMxfileToPreviewSvg(mxRight, session.pageIndex, unifiedBounds),
        }
      : await this.normalizeDiagramBytes(
          session.targetUri.path,
          rightBytes,
          rightLabel,
          session.targetUri.scheme === 'file' ? path.dirname(session.targetUri.fsPath) : undefined,
          session.pageIndex,
        );

    session.beforeEmpty = before.empty;
    session.afterEmpty = after.empty;

    return {
      type: 'loadDiff',
      before,
      after,
      isGit: session.mode === 'git',
      gitRef: session.gitRef,
      pages: session.pages,
      pageIndex: session.pageIndex,
      mermaidTheme: mermaidTheme(),
      labels: this.buildUiLabels(),
      emptyText: t('Empty / Not Present'),
    };
  }

  private async refreshSession(session: DiffSession): Promise<void> {
    if (!session.ready) {
      return;
    }
    const payload = await this.computeSessionPayload(session);
    void session.panel.webview.postMessage(payload);
  }

  private async normalizeDiagramBytes(
    filePath: string,
    bytes: Uint8Array | undefined,
    label: string,
    baseDir?: string,
    pageIndex = 0,
  ): Promise<NormalizedDiffSide> {
    if (!bytes || bytes.byteLength === 0) {
      return { label, empty: true, renderKind: 'svg', payload: '' };
    }
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.png')) {
      return {
        label,
        empty: false,
        renderKind: 'png',
        payload: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      };
    }
    const text = Buffer.from(bytes).toString('utf8');
    if (!text.trim()) {
      return { label, empty: true, renderKind: 'svg', payload: '' };
    }
    if (lower.endsWith('.svg')) {
      return { label, empty: false, renderKind: 'svg', payload: text };
    }
    if (/\.(?:drawio|dio|xml)$/i.test(lower)) {
      return { label, empty: false, renderKind: 'svg', payload: renderMxfileToPreviewSvg(text, pageIndex) };
    }
    if (/\.(?:mmd|mermaid)$/i.test(lower)) {
      return { label, empty: false, renderKind: 'mermaid', payload: text };
    }
    if (/\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(lower)) {
      try {
        const blocks = splitDiagrams(text);
        const src = blocks[Math.min(pageIndex, Math.max(0, blocks.length - 1))]?.source ?? text;
        const svgBytes = await this.previews.renderPlantUmlBytes(src, 'svg', baseDir);
        return { label, empty: false, renderKind: 'svg', payload: Buffer.from(svgBytes).toString('utf8') };
      } catch (err) {
        const errSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="80"><rect width="100%" height="100%" fill="#fff5f5"/><text x="16" y="44" fill="#c53030" font-family="sans-serif" font-size="13">${escapeXml((err as Error).message)}</text></svg>`;
        return { label, empty: false, renderKind: 'svg', payload: errSvg };
      }
    }
    return { label, empty: false, renderKind: 'svg', payload: renderMxfileToPreviewSvg(text, pageIndex) };
  }

  private createPanelSession(
    mode: 'git' | 'files',
    targetUri: vscode.Uri,
    title: string,
    gitRef: string,
    leftUri?: vscode.Uri,
  ): DiffSession {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'drawGraph.visualDiff',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icons', 'drawgraph.svg');

    const session: DiffSession = {
      mode,
      targetUri,
      leftUri,
      gitRef,
      pageIndex: 0,
      pages: [],
      panel,
      ready: false,
      beforeEmpty: false,
      afterEmpty: false,
    };
    this.sessions.add(session);

    const webview = panel.webview;
    const nonce = getNonce();
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...p));
    const needMermaid = /\.(?:mmd|mermaid)$/i.test(targetUri.path) || (leftUri ? /\.(?:mmd|mermaid)$/i.test(leftUri.path) : false);
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

    const tr = (s: string) => escapeXml(t(s));

    webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('diff', 'main.css')}" rel="stylesheet">
</head>
<body>
  <div id="diffToolbar">
    <div class="diffModes" role="tablist">
      <button type="button" data-mode="side" class="active">${tr('Side-by-Side')}</button>
      <button type="button" data-mode="swipe">${tr('Swipe')}</button>
      <button type="button" data-mode="onion">${tr('Onion / Pixel Diff')}</button>
    </div>
    <button id="gitRefBtn" type="button" hidden title="${tr('Select baseline Git commit or branch')}">HEAD ▾</button>
    <select id="pageSelect" hidden aria-label="Diagram page"></select>
    <span class="sep"></span>
    <button id="zoomOutBtn" type="button" title="${tr('Zoom out')}">−</button>
    <button id="zoomResetBtn" type="button" title="${tr('Reset zoom (100%)')}">100%</button>
    <button id="zoomInBtn" type="button" title="${tr('Zoom in')}">+</button>
    <button id="fitBtn" type="button">${tr('Fit')}</button>
    <div id="onionControls" hidden>
      <label><span id="lblOpacity">${tr('Opacity')}</span> <input id="onionSlider" type="range" min="0" max="100" value="50"></label>
      <button id="pixelDiffBtn" type="button">${tr('Highlight Changed Pixels')}</button>
      <span id="diffStats"></span>
    </div>
  </div>
  <div id="diffStage" data-mode="side">
    <div id="sideView">
      <div class="diffPane" id="paneBefore">
        <div class="paneBadge" id="badgeBefore"></div>
        <div class="paneCanvas" id="canvasBefore"></div>
      </div>
      <div class="diffPane" id="paneAfter">
        <div class="paneBadge" id="badgeAfter"></div>
        <div class="paneCanvas" id="canvasAfter"></div>
      </div>
    </div>
    <div id="overlayView" hidden>
      <div class="overlayLayer" id="overlayBefore"></div>
      <div class="overlayLayer" id="overlayAfter"></div>
      <canvas id="pixelDiffCanvas" hidden></canvas>
      <div id="swipeDivider" role="slider" tabindex="0" aria-label="Swipe comparison split" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
        <div class="swipeHandle">⇔</div>
      </div>
    </div>
  </div>
  ${needMermaid ? `<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>` : ''}
  <script nonce="${nonce}" src="${media('diff', 'main.js')}"></script>
</body>
</html>`;

    const sub = webview.onDidReceiveMessage(async (msg: { type: string; pageIndex?: number }) => {
      if (msg.type === 'ready') {
        session.ready = true;
        await this.refreshSession(session);
      } else if (msg.type === 'selectPage' && typeof msg.pageIndex === 'number') {
        session.pageIndex = Math.max(0, msg.pageIndex);
        await this.refreshSession(session);
      } else if (msg.type === 'pickGitRef' && session.mode === 'git') {
        const refs = await listGitRefsForFile(session.targetUri);
        const picked = await vscode.window.showQuickPick(
          refs.map((r) => ({ label: `$(git-commit) ${r.ref}`, description: r.detail, ref: r.ref })),
          { placeHolder: t('Select baseline Git commit or branch') },
        );
        if (picked) {
          session.gitRef = picked.ref;
          await this.refreshSession(session);
        }
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      this.sessions.delete(session);
    });

    return session;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    for (const s of this.sessions) {
      s.panel.dispose();
    }
    this.sessions.clear();
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
