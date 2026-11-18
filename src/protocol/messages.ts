import type { SettingsSnapshot } from '../settingsSnapshot';

export type PreviewRenderState = 'pending' | 'rendered' | 'error' | 'empty';

/** Discriminated union of all messages sent from the Diagram Preview webview to the Extension Host. */
export type PreviewToHostMessage =
  | { type: 'ready' }
  | {
      type: 'status';
      state: PreviewRenderState;
      width?: number;
      height?: number;
      message?: string;
      line?: number;
    }
  | { type: 'toggleLock' }
  | { type: 'navigate'; delta: number }
  | { type: 'export'; format: 'svg' | 'png' | 'pdf' | 'html'; data: string; width?: number; height?: number }
  | { type: 'autoExportData'; format: 'svg' | 'png' | 'pdf'; data: string }
  | { type: 'offscreenRendered'; requestId: number; data?: string; width?: number; height?: number; error?: string }
  | { type: 'copy'; data: string }
  | { type: 'copiedPng' }
  | { type: 'error'; message: string }
  | { type: 'openSource'; label?: string }
  | { type: 'codeLink'; target: string; fallbackLabel?: string }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; key: string; value: unknown }
  | { type: 'drawerAction'; action: 'downloadOfflinePack' | 'importOfflinePack' | 'removeOfflinePack' }
  | { type: 'openExtensionSettings' };

/** Discriminated union of all messages sent from the Extension Host to the Diagram Preview webview. */
export type HostToPreviewMessage =
  | { type: 'mermaid'; source: string; theme: string }
  | { type: 'svg'; svg: string; info: string; canNav: boolean }
  | {
      type: 'config';
      pngScale: number;
      pngTransparent: boolean;
      locked: boolean;
      uri: string;
      labels?: Record<string, string>;
      settings?: SettingsSnapshot;
    }
  | { type: 'silentExport'; format: 'svg' | 'png' | 'pdf' }
  | { type: 'renderOffscreen'; requestId: number; source: string; theme: string; format: 'svg' | 'png' }
  | { type: 'loading' }
  | { type: 'empty' }
  | { type: 'error'; message: string }
  | { type: 'settingsState'; settings: SettingsSnapshot }
  | { type: 'toggleSettings'; open?: boolean; settings?: SettingsSnapshot }
  | { type: 'highlightCode'; candidates: string[] };

/** Discriminated union of messages sent from the Draw.io bridge webview to the Extension Host. */
export type DrawioToHostMessage =
  | { type: 'ready' }
  | { type: 'phase'; phase: 'booting' | 'configured' | 'initialized' | 'ready' | 'failed' }
  | { type: 'init' }
  | { type: 'loaded' }
  | { type: 'change'; xml: string }
  | { type: 'save'; xml: string }
  | { type: 'export'; requestId: number; data?: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'requestSettings' }
  | { type: 'updateSetting'; key: string; value: unknown }
  | { type: 'drawerAction'; action: 'downloadOfflinePack' | 'importOfflinePack' | 'removeOfflinePack' }
  | { type: 'openExtensionSettings' };
