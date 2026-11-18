import * as vscode from 'vscode';
import { AiDiagramStudioManager } from './ai/aiDiagramStudio';
import { initAiSecretStorage } from './ai/aiProviders';
import { registerAdvancedCommands } from './commands/advancedCommands';
import { registerAiCommands } from './commands/aiCommands';
import { registerCoreCommands } from './commands/coreCommands';
import { VisualDiffManager } from './diff/visualDiffPanel';
import { DrawioEditorProvider } from './drawio/drawioEditorProvider';
import { OfflinePackManager } from './drawio/offlinePackManager';
import { DiagramExplorerProvider } from './explorer/diagramTreeView';
import { initL10n } from './l10n';
import { CodeLinkMaintenanceService, registerLiveCodeSync } from './language/codeLinkMaintenance';
import { registerLanguageFeatures } from './language/diagramFeatures';
import { disposeMarkdownPlantUml, mermaidMarkdownPlugin } from './markdown/markdownIt';
import { PreviewManager } from './preview/previewManager';
import { SettingsPanelManager } from './settingsPanel';
import { setOfflinePackStatusProvider } from './settingsSnapshot';
import type { TransitionRecord } from './stateMachine';

export function activate(context: vscode.ExtensionContext) {
  initL10n(context.extensionPath);
  initAiSecretStorage(context);

  const log = vscode.window.createOutputChannel('DrawGraph', { log: true });
  const traceTransition = (rec: TransitionRecord, machineId: string) => {
    log.debug(`[${machineId}] ${rec.from} --(${rec.event})--> ${rec.to}${rec.note ? ` (${rec.note})` : ''}`);
  };
  context.subscriptions.push(log);

  const offlinePack = new OfflinePackManager(context);
  setOfflinePackStatusProvider(() => offlinePack.getStatus());

  const diagnostics = registerLanguageFeatures(context);
  const drawio = DrawioEditorProvider.register(context, traceTransition, offlinePack);
  const previews = new PreviewManager(context, diagnostics, traceTransition);
  const settingsPanel = new SettingsPanelManager(context);
  const visualDiff = new VisualDiffManager(context, previews);
  const aiStudio = new AiDiagramStudioManager(context, drawio, previews, visualDiff);
  const explorer = new DiagramExplorerProvider();
  const codeLinkMaintenance = new CodeLinkMaintenanceService();
  const treeView = vscode.window.createTreeView('drawGraph.diagramExplorer', {
    treeDataProvider: explorer,
    dragAndDropController: explorer,
    canSelectMany: false,
  });

  registerLiveCodeSync(context, (candidates) => {
    previews.highlightCodeTargets(candidates);
    void drawio.highlightCodeTargets(candidates);
  });

  context.subscriptions.push(
    offlinePack,
    visualDiff,
    aiStudio,
    explorer,
    codeLinkMaintenance,
    treeView,
    {
      dispose: () => {
        setOfflinePackStatusProvider(undefined);
        disposeMarkdownPlantUml();
      },
    },
  );

  registerCoreCommands({ context, drawio, previews, settingsPanel });
  registerAiCommands({ context, aiStudio });
  registerAdvancedCommands({
    context,
    drawio,
    previews,
    visualDiff,
    offlinePack,
    explorer,
    settingsPanel,
    codeLinkMaintenance,
  });

  // Returned API is picked up by the built-in Markdown preview ("markdown.markdownItPlugins").
  const api: Record<string, unknown> = { extendMarkdownIt: mermaidMarkdownPlugin };
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    api.diagnostics = {
      previews: () => previews.snapshot(),
      drawioEditors: () => drawio.snapshot(),
      drawioAction: (uri: string, action: Record<string, unknown>) => drawio.postAction(uri, action),
      visualDiffs: () => visualDiff.snapshot(),
      aiStudio: () => aiStudio.snapshot(),
      offlinePack: () => offlinePack.getStatus(),
      diagramExplorer: () => explorer.snapshot(),
      machines: () => [...drawio.machines(), ...previews.machines()],
      isSettled: () => drawio.isSettled() && previews.isSettled(),
    };
  }
  return api;
}

export function deactivate() {}
