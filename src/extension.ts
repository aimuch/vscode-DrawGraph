import * as vscode from 'vscode';
import { DrawioEditorProvider } from './drawio/drawioEditorProvider';
import { isPngDiagramPath } from './drawio/drawioPng';
import { isSvgDiagramPath } from './drawio/drawioSvg';
import { convertMermaidToDrawioXml } from './drawio/mermaidToDrawio';
import { registerLanguageFeatures } from './language/diagramFeatures';
import { disposeMarkdownPlantUml, mermaidMarkdownPlugin } from './markdown/markdownIt';
import { diagramKind, PreviewManager } from './preview/previewManager';
import type { TransitionRecord } from './stateMachine';
import { DIAGRAM_TEMPLATES, DRAWIO_TEMPLATE, MERMAID_TEMPLATE, PLANTUML_TEMPLATE } from './templates';
import { withExtension } from './util';

function normalizeDrawioTarget(target: vscode.Uri): vscode.Uri {
  if (/\.svg$/i.test(target.path) && !/\.drawio\.svg$/i.test(target.path)) {
    return target.with({ path: target.path.replace(/\.svg$/i, '.drawio.svg') });
  }
  if (/\.png$/i.test(target.path) && !/\.drawio\.png$/i.test(target.path)) {
    return target.with({ path: target.path.replace(/\.png$/i, '.drawio.png') });
  }
  return target;
}

async function promptNewDrawioUri(defaultUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showSaveDialog({
    defaultUri: defaultUri ?? (folder ? vscode.Uri.joinPath(folder, 'diagram.drawio') : undefined),
    filters: {
      'draw.io': ['drawio', 'dio'],
      [vscode.l10n.t('draw.io SVG (editable image)')]: ['drawio.svg', 'svg'],
      [vscode.l10n.t('draw.io PNG (editable image)')]: ['drawio.png', 'png'],
    },
  });
  return picked ? normalizeDrawioTarget(picked) : undefined;
}

async function createAndOpenDrawio(target: vscode.Uri): Promise<void> {
  const png = isPngDiagramPath(target.path);
  const svg = isSvgDiagramPath(target.path);
  // Editable SVG/PNG diagrams start empty: the editor shows a blank page and writes the image on the first edit.
  const bytes = png || svg ? new Uint8Array(0) : Buffer.from(DRAWIO_TEMPLATE, 'utf8');
  await vscode.workspace.fs.writeFile(target, bytes);
  const viewType = png ? DrawioEditorProvider.pngViewType : DrawioEditorProvider.viewType;
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

function activeTabContext(): { uri?: vscode.Uri; viewType?: string } {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputText) {
    return { uri: input.uri };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { uri: input.uri, viewType: input.viewType };
  }
  if (vscode.window.activeTextEditor) {
    return { uri: vscode.window.activeTextEditor.document.uri };
  }
  return {};
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('DrawGraph', { log: true });
  const traceTransition = (rec: TransitionRecord, machineId: string) => {
    log.debug(`[${machineId}] ${rec.from} --(${rec.event})--> ${rec.to}${rec.note ? ` (${rec.note})` : ''}`);
  };
  context.subscriptions.push(log);

  const diagnostics = registerLanguageFeatures(context);
  const drawio = DrawioEditorProvider.register(context, traceTransition);
  const previews = new PreviewManager(context, diagnostics, traceTransition);
  context.subscriptions.push({ dispose: () => disposeMarkdownPlantUml() });

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const asUri = (arg: unknown) => (arg instanceof vscode.Uri ? arg : undefined);

  register('drawGraph.preview.open', (uri?: unknown) => previews.open(asUri(uri), false));
  register('drawGraph.preview.openToSide', (uri?: unknown) => previews.open(asUri(uri), true));
  register('drawGraph.preview.openAtLine', async (uri?: unknown, line?: unknown) => {
    const target = asUri(uri);
    const lineNum = typeof line === 'number' ? line : undefined;
    if (target && lineNum !== undefined) {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target.toString());
      if (editor) {
        const pos = new vscode.Position(lineNum, 0);
        editor.selection = new vscode.Selection(pos, pos);
      }
    }
    await previews.open(target, true, lineNum);
  });
  register('drawGraph.preview.toggleLock', () => previews.toggleLockActive());
  register('drawGraph.plantuml.exportBlock', (uri?: unknown, blockIdx?: unknown, fmt?: unknown) => {
    const target = asUri(uri);
    if (target) {
      return previews.exportPlantUmlBlock(target, typeof blockIdx === 'number' ? blockIdx : 0, fmt === 'png' ? 'png' : 'svg');
    }
    return undefined;
  });

  register('drawGraph.drawio.exportSvg', (to?: unknown) => drawio.exportActive('xmlsvg', asUri(to)));
  register('drawGraph.drawio.exportPng', (to?: unknown) => drawio.exportActive('xmlpng', asUri(to)));
  register('drawGraph.drawio.copySvg', () => drawio.copyActive('svg'));
  register('drawGraph.drawio.copyPng', () => drawio.copyActive('png'));
  register('drawGraph.drawio.openAsText', async () => {
    const uri = drawio.activeDocumentUri;
    if (uri) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }
  });

  register('drawGraph.drawio.new', async (explicitTarget?: unknown) => {
    const target = asUri(explicitTarget) ?? (await promptNewDrawioUri());
    if (target) {
      await createAndOpenDrawio(target);
    }
  });

  const newTextDiagram = async (language: 'mermaid' | 'plantuml', content: string) => {
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document);
    await previews.open(document.uri, true);
  };
  register('drawGraph.mermaid.new', () => newTextDiagram('mermaid', MERMAID_TEMPLATE));
  register('drawGraph.plantuml.new', () => newTextDiagram('plantuml', PLANTUML_TEMPLATE));

  register('drawGraph.diagram.newFromTemplate', async (templateId?: unknown) => {
    const chosen =
      typeof templateId === 'string'
        ? DIAGRAM_TEMPLATES.find((t) => t.id === templateId)
        : (
            await vscode.window.showQuickPick(
              DIAGRAM_TEMPLATES.map((t) => ({ label: t.label, detail: t.detail, template: t })),
              { placeHolder: vscode.l10n.t('Select a diagram template') },
            )
          )?.template;
    if (!chosen) {
      return;
    }
    if (chosen.kind === 'drawio') {
      const target = await promptNewDrawioUri();
      if (target) {
        await createAndOpenDrawio(target);
      }
      return;
    }
    await newTextDiagram(chosen.kind, chosen.content);
  });

  register('drawGraph.mermaid.openInDrawio', async (uriArg?: unknown, explicitSource?: unknown, explicitDest?: unknown) => {
    const sourceUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
    let mermaidSource = typeof explicitSource === 'string' ? explicitSource : undefined;
    if (mermaidSource === undefined && sourceUri) {
      const doc = await vscode.workspace.openTextDocument(sourceUri);
      mermaidSource = doc.getText();
    }
    if (!mermaidSource || !mermaidSource.trim()) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Open a Mermaid diagram first.'));
      return;
    }
    const defaultDest =
      sourceUri && sourceUri.scheme === 'file' ? withExtension(sourceUri, '.drawio') : undefined;
    const target = asUri(explicitDest) ?? (await promptNewDrawioUri(defaultDest));
    if (!target) {
      return;
    }
    const normalized = normalizeDrawioTarget(target);
    const convertedXml = convertMermaidToDrawioXml(mermaidSource);
    const png = isPngDiagramPath(normalized.path);
    const svg = isSvgDiagramPath(normalized.path);
    if (png || svg) {
      await vscode.workspace.fs.writeFile(normalized, new Uint8Array(0));
      drawio.queueInitialXml(normalized, convertedXml);
    } else {
      await vscode.workspace.fs.writeFile(normalized, Buffer.from(convertedXml, 'utf8'));
    }
    const viewType = png ? DrawioEditorProvider.pngViewType : DrawioEditorProvider.viewType;
    await vscode.commands.executeCommand('vscode.openWith', normalized, viewType);
  });

  interface QuickActionItem extends vscode.QuickPickItem {
    id?: string;
    run?: () => Thenable<unknown> | Promise<unknown> | void;
  }

  register('drawGraph.quickMenu', async (uriArg?: unknown, directActionId?: unknown) => {
    const tabCtx = activeTabContext();
    const targetUri = asUri(uriArg) ?? tabCtx.uri;
    const isDrawioTab =
      tabCtx.viewType === DrawioEditorProvider.viewType || tabCtx.viewType === DrawioEditorProvider.pngViewType;

    const contextual: QuickActionItem[] = [];
    if (isDrawioTab) {
      contextual.push(
        {
          id: 'exportSvg',
          label: `$(export) ${vscode.l10n.t('Export as SVG')}`,
          run: () => drawio.exportActive('xmlsvg'),
        },
        {
          id: 'exportPng',
          label: `$(file-media) ${vscode.l10n.t('Export as PNG')}`,
          run: () => drawio.exportActive('xmlpng'),
        },
        {
          id: 'copyPng',
          label: `$(clippy) ${vscode.l10n.t('Copy PNG')}`,
          run: () => drawio.copyActive('png'),
        },
        {
          id: 'copySvg',
          label: `$(copy) ${vscode.l10n.t('Copy SVG')}`,
          run: () => drawio.copyActive('svg'),
        },
      );
      if (tabCtx.viewType === DrawioEditorProvider.viewType && targetUri) {
        contextual.push({
          id: 'openAsText',
          label: `$(code) ${vscode.l10n.t('Open as Text')}`,
          run: () => vscode.commands.executeCommand('vscode.openWith', targetUri, 'default'),
        });
      }
    } else if (targetUri) {
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUri.toString());
      const kind = openDoc ? diagramKind(openDoc) : undefined;
      if (kind === 'mermaid' || kind === 'plantuml') {
        contextual.push({
          id: 'previewSide',
          label: `$(open-preview) ${vscode.l10n.t('Open Diagram Preview to the Side')}`,
          run: () => previews.open(targetUri, true),
        });
        if (kind === 'mermaid') {
          contextual.push({
            id: 'mermaidToDrawio',
            label: `$(type-hierarchy) ${vscode.l10n.t('Open in Draw.io')}`,
            run: () => vscode.commands.executeCommand('drawGraph.mermaid.openInDrawio', targetUri),
          });
        }
      } else if (openDoc?.languageId === 'markdown') {
        contextual.push({
          id: 'markdownPreview',
          label: `$(open-preview) ${vscode.l10n.t('Open Markdown Preview to the Side')}`,
          run: () => vscode.commands.executeCommand('markdown.showPreviewToSide', targetUri),
        });
      } else if (/\.(?:drawio|dio|svg|png|xml)$/i.test(targetUri.path)) {
        const viewType = isPngDiagramPath(targetUri.path)
          ? DrawioEditorProvider.pngViewType
          : DrawioEditorProvider.viewType;
        contextual.push({
          id: 'openInDrawio',
          label: `$(edit) ${vscode.l10n.t('Open Current File in Draw.io Editor')}`,
          description: vscode.workspace.asRelativePath(targetUri),
          run: () => vscode.commands.executeCommand('vscode.openWith', targetUri, viewType),
        });
      }
    }

    const creation: QuickActionItem[] = [
      {
        id: 'newDrawio',
        label: `$(edit) ${vscode.l10n.t('New Draw.io Diagram')}`,
        detail: '.drawio / .drawio.svg / .drawio.png',
        run: () => vscode.commands.executeCommand('drawGraph.drawio.new'),
      },
      {
        id: 'newMermaid',
        label: `$(git-merge) ${vscode.l10n.t('New Mermaid Diagram')}`,
        detail: vscode.l10n.t('Live text-to-diagram preview'),
        run: () => newTextDiagram('mermaid', MERMAID_TEMPLATE),
      },
      {
        id: 'newPlantuml',
        label: `$(type-hierarchy-sub) ${vscode.l10n.t('New PlantUML Diagram')}`,
        detail: vscode.l10n.t('UML sequence, class, component, mindmap…'),
        run: () => newTextDiagram('plantuml', PLANTUML_TEMPLATE),
      },
      {
        id: 'newFromTemplate',
        label: `$(symbol-misc) ${vscode.l10n.t('New Diagram from Template…')}`,
        detail: vscode.l10n.t('Choose from 13 built-in diagram templates'),
        run: () => vscode.commands.executeCommand('drawGraph.diagram.newFromTemplate'),
      },
    ];

    const items: QuickActionItem[] =
      contextual.length > 0
        ? [...contextual, { label: '', kind: vscode.QuickPickItemKind.Separator }, ...creation]
        : creation;

    if (typeof directActionId === 'string') {
      const match = items.find((i) => i.id === directActionId);
      await match?.run?.();
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'DrawGraph',
      placeHolder: vscode.l10n.t('Create, preview, or convert diagrams'),
    });
    await picked?.run?.();
  });

  // Returned API is picked up by the built-in Markdown preview ("markdown.markdownItPlugins").
  const api: Record<string, unknown> = { extendMarkdownIt: mermaidMarkdownPlugin };
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    api.diagnostics = {
      previews: () => previews.snapshot(),
      drawioEditors: () => drawio.snapshot(),
      drawioAction: (uri: string, action: Record<string, unknown>) => drawio.postAction(uri, action),
      machines: () => [...drawio.machines(), ...previews.machines()],
      isSettled: () => drawio.isSettled() && previews.isSettled(),
    };
  }
  return api;
}

export function deactivate() {}
