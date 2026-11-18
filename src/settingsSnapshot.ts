import * as vscode from 'vscode';
import type { OfflinePackStatus } from './drawio/offlinePackManager';
import { getLanguage, getLanguageSetting, type LanguageSetting, type ResolvedLanguage } from './l10n';
import { SETTINGS_DRAWER_STRINGS } from './settingsStrings';
import { config } from './util';

export interface SettingsSnapshot {
  isTrusted: boolean;
  vscodeLanguage: string;
  language: LanguageSetting;
  resolvedLanguage: ResolvedLanguage;
  i18n: Record<'en' | 'zh-cn', Record<string, string>>;
  drawio: {
    theme: string;
    ui: string;
    svgColorScheme: string;
    offlineMode: string;
    offlinePackInstalled: boolean;
    offlinePackFiles: number;
    offlineServerOrigin?: string;
    hideGithubIcon: boolean;
    vscodeShortcuts: boolean;
    autoLoadWorkspaceLibrary: boolean;
    url: string;
  };
  preview: {
    mermaidTheme: string;
    pngScale: number;
    pngTransparent: boolean;
    followActiveEditor: boolean;
    syncWithCodeCursor: boolean;
    checkBrokenLinks: boolean;
    syncOnFileRename: boolean;
    debounce: number;
    codeLens: boolean;
    showQuickMenu: boolean;
  };
  plantuml: {
    render: string;
    server: string;
    jar: string;
    exportOnSave: string;
    exportOnSaveOutDir: string;
    markdownMermaid: boolean;
    markdownPlantuml: boolean;
    markdownDot: boolean;
    markdownWavedrom: boolean;
  };
}

let offlineStatusProvider: (() => OfflinePackStatus) | undefined;

export function setOfflinePackStatusProvider(provider: (() => OfflinePackStatus) | undefined): void {
  offlineStatusProvider = provider;
}

const RESTRICTED_SETTINGS = new Set([
  'drawio.url',
  'plantuml.render',
  'plantuml.server',
  'plantuml.jar',
  'exportOnSave',
  'exportOnSaveOutDir',
]);

const ALLOWED_SETTINGS = new Set([
  'language',
  'drawio.theme',
  'drawio.ui',
  'drawio.svgColorScheme',
  'drawio.offlineMode',
  'drawio.hideGithubIcon',
  'drawio.vscodeShortcuts',
  'drawio.autoLoadWorkspaceLibrary',
  'drawio.url',
  'mermaid.theme',
  'preview.pngScale',
  'preview.pngTransparent',
  'preview.followActiveEditor',
  'preview.syncWithCodeCursor',
  'codeLinks.checkBrokenLinks',
  'codeLinks.syncOnFileRename',
  'preview.debounce',
  'editor.codeLens',
  'toolbar.showQuickMenu',
  'plantuml.render',
  'plantuml.server',
  'plantuml.jar',
  'exportOnSave',
  'exportOnSaveOutDir',
  'markdown.mermaid',
  'markdown.plantuml',
  'markdown.dot',
  'markdown.wavedrom',
]);

export function getSettingsSnapshot(): SettingsSnapshot {
  const cfg = config();
  const offline = offlineStatusProvider?.() ?? { installed: false, fileCount: 0 };
  return {
    isTrusted: vscode.workspace.isTrusted,
    vscodeLanguage: vscode.env.language || 'en',
    language: getLanguageSetting(),
    resolvedLanguage: getLanguage(),
    i18n: SETTINGS_DRAWER_STRINGS,
    drawio: {
      theme: cfg.get<string>('drawio.theme', 'auto'),
      ui: cfg.get<string>('drawio.ui', 'kennedy'),
      svgColorScheme: cfg.get<string>('drawio.svgColorScheme', 'auto'),
      offlineMode: cfg.get<string>('drawio.offlineMode', 'auto'),
      offlinePackInstalled: offline.installed,
      offlinePackFiles: offline.fileCount,
      offlineServerOrigin: offline.serverOrigin,
      hideGithubIcon: cfg.get<boolean>('drawio.hideGithubIcon', true),
      vscodeShortcuts: cfg.get<boolean>('drawio.vscodeShortcuts', true),
      autoLoadWorkspaceLibrary: cfg.get<boolean>('drawio.autoLoadWorkspaceLibrary', true),
      url: cfg.get<string>('drawio.url', 'https://embed.diagrams.net/'),
    },
    preview: {
      mermaidTheme: cfg.get<string>('mermaid.theme', 'auto'),
      pngScale: cfg.get<number>('preview.pngScale', 2),
      pngTransparent: cfg.get<boolean>('preview.pngTransparent', false),
      followActiveEditor: cfg.get<boolean>('preview.followActiveEditor', true),
      syncWithCodeCursor: cfg.get<boolean>('preview.syncWithCodeCursor', true),
      checkBrokenLinks: cfg.get<boolean>('codeLinks.checkBrokenLinks', true),
      syncOnFileRename: cfg.get<boolean>('codeLinks.syncOnFileRename', true),
      debounce: cfg.get<number>('preview.debounce', 400),
      codeLens: cfg.get<boolean>('editor.codeLens', true),
      showQuickMenu: cfg.get<boolean>('toolbar.showQuickMenu', true),
    },
    plantuml: {
      render: cfg.get<string>('plantuml.render', 'auto'),
      server: cfg.get<string>('plantuml.server', 'https://www.plantuml.com/plantuml'),
      jar: cfg.get<string>('plantuml.jar', ''),
      exportOnSave: cfg.get<string>('exportOnSave', 'off'),
      exportOnSaveOutDir: cfg.get<string>('exportOnSaveOutDir', ''),
      markdownMermaid: cfg.get<boolean>('markdown.mermaid', true),
      markdownPlantuml: cfg.get<boolean>('markdown.plantuml', true),
      markdownDot: cfg.get<boolean>('markdown.dot', true),
      markdownWavedrom: cfg.get<boolean>('markdown.wavedrom', true),
    },
  };
}

export async function applySettingUpdate(key: string, rawValue: unknown): Promise<boolean> {
  if (!ALLOWED_SETTINGS.has(key)) {
    return false;
  }
  if (!vscode.workspace.isTrusted && RESTRICTED_SETTINGS.has(key)) {
    return false;
  }
  let value: unknown = rawValue;
  if (key === 'preview.pngScale') {
    const n = Number(rawValue);
    if (![1, 2, 3, 4].includes(n)) {
      return false;
    }
    value = n;
  } else if (key === 'preview.debounce') {
    const n = Math.max(0, Math.round(Number(rawValue) || 0));
    value = n;
  }
  await config().update(key, value, vscode.ConfigurationTarget.Global);
  return true;
}

export async function handleSettingsDrawerAction(action: unknown): Promise<void> {
  switch (action) {
    case 'downloadOfflinePack':
      await vscode.commands.executeCommand('drawGraph.drawio.downloadOfflinePack');
      break;
    case 'importOfflinePack':
      await vscode.commands.executeCommand('drawGraph.drawio.importOfflinePack');
      break;
    case 'removeOfflinePack':
      await vscode.commands.executeCommand('drawGraph.drawio.removeOfflinePack');
      break;
  }
}

export async function openExtensionSettingsInVscode(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:drawgraph.drawgraph');
}
