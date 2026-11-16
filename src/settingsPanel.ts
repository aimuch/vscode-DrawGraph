import * as vscode from 'vscode';
import { t } from './l10n';
import { applySettingUpdate, getSettingsSnapshot, openExtensionSettingsInVscode } from './settingsSnapshot';
import { getNonce } from './util';

export class SettingsPanelManager {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('drawGraph') && this.panel) {
          this.panel.title = t('DrawGraph Settings');
          void this.panel.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
        }
      }),
      { dispose: () => this.panel?.dispose() },
    );
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.panel.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
      return;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'drawGraph.settings',
      t('DrawGraph Settings'),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [mediaRoot] },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icons', 'drawgraph.svg');
    this.panel = panel;

    const webview = panel.webview;
    const nonce = getNonce();
    const sharedUri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'shared', f));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${sharedUri('settingsDrawer.css')}" rel="stylesheet">
</head>
<body>
  <script nonce="${nonce}" src="${sharedUri('settingsDrawer.js')}"></script>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const drawer = window.createDrawGraphSettingsDrawer({
        postMessage: (m) => vscode.postMessage(m),
        standalone: true,
      });
      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (msg && msg.type === 'settingsState') {
          drawer.setState(msg.settings);
        }
      });
      vscode.postMessage({ type: 'requestSettings' });
    })();
  </script>
</body>
</html>`;

    const sub = webview.onDidReceiveMessage(async (msg: { type: string; key?: string; value?: unknown }) => {
      switch (msg.type) {
        case 'requestSettings':
          void webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
          break;
        case 'updateSetting':
          if (typeof msg.key === 'string') {
            await applySettingUpdate(msg.key, msg.value);
          }
          break;
        case 'openExtensionSettings':
          await openExtensionSettingsInVscode();
          break;
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
  }
}
