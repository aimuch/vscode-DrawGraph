import * as vscode from 'vscode';
import type { AiDiagramStudioManager, HeadlessAiTaskArgs, OpenStudioOptions } from '../ai/aiDiagramStudio';
import {
  clearApiKey,
  fetchProviderModels,
  setApiKey,
  type AiProviderId,
} from '../ai/aiProviders';
import type { AiDiagramFormat, OptimizePreset } from '../ai/diagramAiCore';
import { extractResourceUri } from '../diff/visualDiffPanel';
import { t } from '../l10n';
import { applySettingUpdate } from '../settingsSnapshot';

export interface AiCommandDeps {
  context: vscode.ExtensionContext;
  aiStudio: AiDiagramStudioManager;
}

export function registerAiCommands({ context, aiStudio }: AiCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('drawGraph.ai.openStudio', async (arg?: unknown) => {
    if (arg instanceof vscode.Uri) {
      await aiStudio.openStudio({ targetUri: arg, mode: 'modify' });
      return;
    }
    const resUri = extractResourceUri(arg);
    if (resUri) {
      await aiStudio.openStudio({ targetUri: resUri, mode: 'modify' });
      return;
    }
    if (arg && typeof arg === 'object') {
      await aiStudio.openStudio(arg as OpenStudioOptions);
      return;
    }
    await aiStudio.openStudio();
  });

  register('drawGraph.ai.generateDiagram', async (arg?: unknown) => {
    if (arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) && 'prompt' in arg) {
      const opts = arg as {
        prompt?: string;
        format?: AiDiagramFormat;
        applyImmediately?: boolean;
        openNewIfNoTarget?: boolean;
        skipConsent?: boolean;
      };
      return aiStudio.executeHeadlessTask({
        mode: 'generate',
        prompt: opts.prompt ?? '',
        format: opts.format ?? 'mermaid',
        applyImmediately: opts.applyImmediately ?? false,
        openNewIfNoTarget: opts.openNewIfNoTarget ?? true,
        skipConsent: opts.skipConsent,
      });
    }
    await aiStudio.openStudio({ mode: 'generate' });
    return undefined;
  });

  register('drawGraph.ai.generateFromSelection', async (arg?: unknown) => {
    if (arg && typeof arg === 'object' && !(arg instanceof vscode.Uri) && 'headless' in arg) {
      const opts = arg as { format?: AiDiagramFormat; prompt?: string; skipConsent?: boolean };
      return aiStudio.executeHeadlessTask({
        mode: 'generate',
        format: opts.format ?? 'mermaid',
        prompt: opts.prompt ?? 'Visualize the selected code architecture and control/data flow.',
        openNewIfNoTarget: true,
        skipConsent: opts.skipConsent,
      });
    }
    await aiStudio.openStudio({
      mode: 'generate',
      initialPrompt: t('Visualize the selected code architecture and control/data flow.'),
    });
    return undefined;
  });

  register('drawGraph.ai.modifyDiagram', async (arg?: unknown) => {
    const uriFromArg = extractResourceUri(arg);
    if (arg && typeof arg === 'object' && !uriFromArg && 'prompt' in arg) {
      const opts = arg as HeadlessAiTaskArgs;
      return aiStudio.executeHeadlessTask({
        ...opts,
        mode: opts.mode ?? 'modify',
        applyImmediately: opts.applyImmediately ?? true,
      });
    }
    const prompt = await vscode.window.showInputBox({
      title: `✨ ${t('Modify Diagram with AI')}`,
      prompt: t('Describe how to update, extend, or reorganize the diagram (or leave empty to open AI Studio)'),
      placeHolder: t('e.g. Add a Redis cache before PostgreSQL and group backend services into a subgraph'),
    });
    if (prompt === undefined) {
      return undefined;
    }
    if (!prompt.trim()) {
      await aiStudio.openStudio({ mode: 'modify', targetUri: uriFromArg });
      return undefined;
    }
    return aiStudio.executeHeadlessTask({
      mode: 'modify',
      prompt,
      targetUri: uriFromArg,
      applyImmediately: true,
    });
  });

  register('drawGraph.ai.optimizeDiagram', async (arg?: unknown, presetArg?: unknown) => {
    const uriFromArg = extractResourceUri(arg);
    if (arg && typeof arg === 'object' && !uriFromArg && 'optimizePreset' in arg) {
      const opts = arg as HeadlessAiTaskArgs;
      return aiStudio.executeHeadlessTask({
        ...opts,
        mode: 'optimize',
        applyImmediately: opts.applyImmediately ?? true,
      });
    }
    let preset = presetArg as OptimizePreset | undefined;
    if (!preset) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: `$(layout) ${t('Layout & Subgraphs')}`, detail: t('Group related nodes, align flow direction, and reduce crossings'), preset: 'layout' as const },
          { label: `$(symbol-color) ${t('Visual Styling')}`, detail: t('Semantic shapes (cylinders, diamonds) and cohesive color palette'), preset: 'style' as const },
          { label: `$(fold) ${t('Simplify')}`, detail: t('De-clutter redundant pass-through nodes while keeping core flows'), preset: 'simplify' as const },
          { label: `$(shield) ${t('Resilience & Retries')}`, detail: t('Add missing error paths, timeouts, caching, or DLQ patterns'), preset: 'resilience' as const },
          { label: `$(globe) ${t('Translate Labels')}`, detail: t('Translate human-readable node and edge labels (EN ↔ 中文)'), preset: 'translate' as const },
        ],
        { placeHolder: t('Select AI diagram optimization preset') },
      );
      if (!picked) {
        return undefined;
      }
      preset = picked.preset;
    }
    return aiStudio.executeHeadlessTask({
      mode: 'optimize',
      optimizePreset: preset,
      targetUri: uriFromArg,
      applyImmediately: true,
    });
  });

  register('drawGraph.ai.fixSyntax', async (uriArg?: unknown, errorHintArg?: unknown, skipConsentArg?: unknown) => {
    const targetUri = extractResourceUri(uriArg);
    const diagnosticHint = typeof errorHintArg === 'string' ? errorHintArg : undefined;
    const skipConsent = skipConsentArg === true;
    return aiStudio.executeHeadlessTask({
      mode: 'fix',
      targetUri,
      diagnosticHint,
      applyImmediately: true,
      openNewIfNoTarget: false,
      skipConsent,
    });
  });

  register('drawGraph.ai.explainDiagram', async (arg?: unknown) => {
    const uriFromArg = extractResourceUri(arg);
    if (arg && typeof arg === 'object' && !uriFromArg && 'headless' in arg) {
      const opts = arg as { targetUri?: vscode.Uri; prompt?: string; skipConsent?: boolean };
      return aiStudio.executeHeadlessTask({
        mode: 'explain',
        targetUri: opts.targetUri,
        prompt: opts.prompt ?? '',
        skipConsent: opts.skipConsent,
      });
    }
    await aiStudio.openStudio({
      mode: 'explain',
      targetUri: uriFromArg,
      autoRun: true,
    });
    return undefined;
  });

  register('drawGraph.ai.setApiKey', async (providerArg?: unknown, explicitKeyArg?: unknown) => {
    const provider = typeof providerArg === 'string' ? (providerArg as AiProviderId) : undefined;
    const explicitKey = typeof explicitKeyArg === 'string' ? explicitKeyArg : undefined;
    return setApiKey(provider, explicitKey);
  });

  register('drawGraph.ai.clearApiKey', async (providerArg?: unknown, silentArg?: unknown) => {
    const provider = typeof providerArg === 'string' ? (providerArg as AiProviderId) : undefined;
    return clearApiKey(provider, silentArg === true);
  });

  register('drawGraph.ai.discoverModels', async (providerArg?: unknown, nonInteractiveArg?: unknown) => {
    const provider = typeof providerArg === 'string' ? (providerArg as AiProviderId) : undefined;
    const models = await fetchProviderModels(provider);
    if (nonInteractiveArg === true) {
      return models;
    }
    if (models.length === 0) {
      void vscode.window.showInformationMessage(t('No models returned by the current AI provider.'));
      return models;
    }
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m })),
      { placeHolder: t('Select AI model ({0} discovered)', models.length) },
    );
    if (picked) {
      await applySettingUpdate('ai.model', picked.label);
    }
    return models;
  });

  register('drawGraph.ai.createStyleGuide', async (destArg?: unknown): Promise<vscode.Uri | undefined> => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder && !(destArg instanceof vscode.Uri)) {
      return undefined;
    }
    const dest = destArg instanceof vscode.Uri ? destArg : vscode.Uri.joinPath(folder!, '.vscode', 'drawgraph-ai.md');
    const starter = [
      '# DrawGraph AI Diagram Style Guide',
      '',
      '<!-- Automatically loaded by DrawGraph AI Diagram Studio in trusted workspaces -->',
      '',
      '## Visual & Layout Conventions',
      '- Prefer left-to-right (`LR` / `direction: right`) for service architectures and top-down (`TD`) for workflows.',
      '- Group internal microservices into clear subgraphs / containers (`Frontend`, `Backend`, `Data Layer`).',
      '- Use cylinder shapes for databases/caches and diamond shapes for decision gates.',
      '',
      '## Naming & Labeling',
      '- Keep node labels concise (2–4 words) and annotate edges with protocol/event names (`HTTPS`, `gRPC`, `Kafka`).',
      '- Avoid generic labels like `Service A`; use concrete domain names from the codebase.',
      '',
    ].join('\n');
    try {
      await vscode.workspace.fs.stat(dest);
    } catch {
      await vscode.workspace.fs.writeFile(dest, Buffer.from(starter, 'utf8'));
    }
    const doc = await vscode.workspace.openTextDocument(dest);
    await vscode.window.showTextDocument(doc);
    return dest;
  });
}
