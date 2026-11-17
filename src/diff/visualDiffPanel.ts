import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
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
  ready: boolean;
  beforeEmpty: boolean;
  afterEmpty: boolean;
}

interface DiffSession {
  uri: string;
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

async function readGitHeadBytes(fileUri: vscode.Uri): Promise<{ bytes?: Uint8Array; refLabel: string }> {
  if (fileUri.scheme !== 'file') {
    return { refLabel: 'HEAD' };
  }
  const cwd = path.dirname(fileUri.fsPath);
  try {
    const { stdout: topStdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const repoRoot = topStdout.trim();
    const relPosix = path.relative(repoRoot, fileUri.fsPath).split(path.sep).join('/');
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${relPosix}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 25 * 1024 * 1024,
    });
    return { bytes: new Uint8Array(stdout), refLabel: 'HEAD' };
  } catch {
    return { bytes: undefined, refLabel: t('HEAD (not in commit)') };
  }
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

export class VisualDiffManager implements vscode.Disposable {
  private readonly sessions = new Set<DiffSession>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly previews: PreviewManager,
  ) {}

  snapshot(): DiffSnapshot[] {
    return [...this.sessions].map((s) => ({
      uri: s.uri,
      ready: s.ready,
      beforeEmpty: s.beforeEmpty,
      afterEmpty: s.afterEmpty,
    }));
  }

  async openGitDiff(targetUri: vscode.Uri): Promise<boolean> {
    const [{ bytes: headBytes, refLabel }, workingBytes] = await Promise.all([
      readGitHeadBytes(targetUri),
      readWorkingBytes(targetUri),
    ]);
    const baseDir = targetUri.scheme === 'file' ? path.dirname(targetUri.fsPath) : undefined;
    const before = await this.normalizeDiagramBytes(targetUri.path, headBytes, refLabel, baseDir);
    const after = await this.normalizeDiagramBytes(targetUri.path, workingBytes, t('Working Tree'), baseDir);
    this.openDiffPanel(targetUri, `${path.basename(targetUri.path)} (${t('Visual Diff')})`, before, after);
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

    const [leftBytes, rightBytes] = await Promise.all([readWorkingBytes(left), readWorkingBytes(right)]);
    const before = await this.normalizeDiagramBytes(
      left.path,
      leftBytes,
      path.basename(left.path),
      left.scheme === 'file' ? path.dirname(left.fsPath) : undefined,
    );
    const after = await this.normalizeDiagramBytes(
      right.path,
      rightBytes,
      path.basename(right.path),
      right.scheme === 'file' ? path.dirname(right.fsPath) : undefined,
    );
    this.openDiffPanel(
      right,
      `${path.basename(left.path)} ↔ ${path.basename(right.path)}`,
      before,
      after,
    );
    return true;
  }

  private async normalizeDiagramBytes(
    filePath: string,
    bytes: Uint8Array | undefined,
    label: string,
    baseDir?: string,
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
      return { label, empty: false, renderKind: 'svg', payload: renderMxfileToPreviewSvg(text) };
    }
    if (/\.(?:mmd|mermaid)$/i.test(lower)) {
      return { label, empty: false, renderKind: 'mermaid', payload: text };
    }
    if (/\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(lower)) {
      try {
        const blocks = splitDiagrams(text);
        const src = blocks[0]?.source ?? text;
        const svgBytes = await this.previews.renderPlantUmlBytes(src, 'svg', baseDir);
        return { label, empty: false, renderKind: 'svg', payload: Buffer.from(svgBytes).toString('utf8') };
      } catch (err) {
        const errSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="80"><rect width="100%" height="100%" fill="#fff5f5"/><text x="16" y="44" fill="#c53030" font-family="sans-serif" font-size="13">${escapeXml((err as Error).message)}</text></svg>`;
        return { label, empty: false, renderKind: 'svg', payload: errSvg };
      }
    }
    return { label, empty: false, renderKind: 'svg', payload: renderMxfileToPreviewSvg(text) };
  }

  private openDiffPanel(
    uri: vscode.Uri,
    title: string,
    before: NormalizedDiffSide,
    after: NormalizedDiffSide,
  ): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'drawGraph.visualDiff',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icons', 'drawgraph.svg');

    const session: DiffSession = {
      uri: uri.toString(),
      panel,
      ready: false,
      beforeEmpty: before.empty,
      afterEmpty: after.empty,
    };
    this.sessions.add(session);

    const webview = panel.webview;
    const nonce = getNonce();
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...p));
    const needMermaid = before.renderKind === 'mermaid' || after.renderKind === 'mermaid';
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
    <span class="sep"></span>
    <button id="zoomOutBtn" type="button" title="${tr('Zoom out')}">−</button>
    <button id="zoomResetBtn" type="button" title="${tr('Reset zoom (100%)')}">100%</button>
    <button id="zoomInBtn" type="button" title="${tr('Zoom in')}">+</button>
    <button id="fitBtn" type="button">${tr('Fit')}</button>
    <div id="onionControls" hidden>
      <label>${tr('Opacity')} <input id="onionSlider" type="range" min="0" max="100" value="50"></label>
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
      <div id="swipeDivider"><div class="swipeHandle">⇔</div></div>
    </div>
  </div>
  ${needMermaid ? `<script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>` : ''}
  <script nonce="${nonce}" src="${media('diff', 'main.js')}"></script>
</body>
</html>`;

    const sub = webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === 'ready') {
        session.ready = true;
        void webview.postMessage({
          type: 'loadDiff',
          before,
          after,
          mermaidTheme: mermaidTheme(),
          emptyText: t('Empty / Not Present'),
        });
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      this.sessions.delete(session);
    });
  }

  dispose(): void {
    for (const s of this.sessions) {
      s.panel.dispose();
    }
    this.sessions.clear();
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
