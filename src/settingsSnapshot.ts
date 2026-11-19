import * as vscode from 'vscode';
import { AI_PROVIDER_IDS, AI_PROVIDER_PRESETS, getAiConfigSync } from './ai/aiProviders';
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
  ai: {
    provider: string;
    baseUrl: string;
    effectiveBaseUrl: string;
    model: string;
    effectiveModel: string;
    hasApiKey: boolean;
    requiresApiKey: boolean;
    autoDiscoverModels: boolean;
    providers: ReadonlyArray<{ id: string; name: string; defaultBaseUrl: string; defaultModel: string }>;
  };
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
    mermaidLook: string;
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
    d2Path: string;
    exportOnSave: string;
    exportOnSaveOutDir: string;
    markdownMermaid: boolean;
    markdownPlantuml: boolean;
    markdownDot: boolean;
    markdownWavedrom: boolean;
    markdownD2: boolean;
  };
}

let offlineStatusProvider: (() => OfflinePackStatus) | undefined;

export function setOfflinePackStatusProvider(provider: (() => OfflinePackStatus) | undefined): void {
  offlineStatusProvider = provider;
}

const RESTRICTED_SETTINGS = new Set([
  'ai.baseUrl',
  'drawio.url',
  'plantuml.render',
  'plantuml.server',
  'plantuml.jar',
  'd2.path',
  'exportOnSave',
  'exportOnSaveOutDir',
]);

const ALLOWED_SETTINGS = new Set([
  'language',
  'ai.provider',
  'ai.baseUrl',
  'ai.model',
  'drawio.theme',
  'drawio.ui',
  'drawio.svgColorScheme',
  'drawio.offlineMode',
  'drawio.hideGithubIcon',
  'drawio.vscodeShortcuts',
  'drawio.autoLoadWorkspaceLibrary',
  'drawio.url',
  'mermaid.theme',
  'mermaid.look',
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
  'd2.path',
  'exportOnSave',
  'exportOnSaveOutDir',
  'markdown.mermaid',
  'markdown.plantuml',
  'markdown.dot',
  'markdown.wavedrom',
  'markdown.d2',
]);

export function getSettingsSnapshot(): SettingsSnapshot {
  const cfg = config();
  const offline = offlineStatusProvider?.() ?? { installed: false, fileCount: 0 };
  const aiSnap = getAiConfigSync();
  return {
    isTrusted: vscode.workspace.isTrusted,
    vscodeLanguage: vscode.env.language || 'en',
    language: getLanguageSetting(),
    resolvedLanguage: getLanguage(),
    i18n: SETTINGS_DRAWER_STRINGS,
    ai: {
      provider: aiSnap.provider,
      baseUrl: aiSnap.baseUrl,
      effectiveBaseUrl: aiSnap.effectiveBaseUrl,
      model: aiSnap.model,
      effectiveModel: aiSnap.effectiveModel,
      hasApiKey: aiSnap.hasApiKey,
      requiresApiKey: aiSnap.requiresApiKey,
      autoDiscoverModels: aiSnap.autoDiscoverModels,
      providers: AI_PROVIDER_IDS.map((id) => ({
        id,
        name: AI_PROVIDER_PRESETS[id].name,
        defaultBaseUrl: AI_PROVIDER_PRESETS[id].defaultBaseUrl,
        defaultModel: AI_PROVIDER_PRESETS[id].defaultModel,
      })),
    },
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
      mermaidLook: cfg.get<string>('mermaid.look', 'classic'),
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
      d2Path: cfg.get<string>('d2.path', ''),
      exportOnSave: cfg.get<string>('exportOnSave', 'off'),
      exportOnSaveOutDir: cfg.get<string>('exportOnSaveOutDir', ''),
      markdownMermaid: cfg.get<boolean>('markdown.mermaid', true),
      markdownPlantuml: cfg.get<boolean>('markdown.plantuml', true),
      markdownDot: cfg.get<boolean>('markdown.dot', true),
      markdownWavedrom: cfg.get<boolean>('markdown.wavedrom', true),
      markdownD2: cfg.get<boolean>('markdown.d2', true),
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
    case 'setAiApiKey':
      await vscode.commands.executeCommand('drawGraph.ai.setApiKey');
      break;
    case 'clearAiApiKey':
      await vscode.commands.executeCommand('drawGraph.ai.clearApiKey');
      break;
    case 'discoverAiModels':
      await vscode.commands.executeCommand('drawGraph.ai.discoverModels');
      break;
    case 'openAiStudio':
      await vscode.commands.executeCommand('drawGraph.ai.openStudio');
      break;
  }
}

export async function openExtensionSettingsInVscode(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:drawgraph.drawgraph');
}
