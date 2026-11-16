import * as vscode from 'vscode';
import { DrawioEditorProvider } from './drawio/drawioEditorProvider';
import { isPngDiagramPath } from './drawio/drawioPng';
import { isSvgDiagramPath } from './drawio/drawioSvg';
import { convertMermaidToDrawioXml } from './drawio/mermaidToDrawio';
import { registerLanguageFeatures } from './language/diagramFeatures';
import { disposeMarkdownPlantUml, mermaidMarkdownPlugin } from './markdown/markdownIt';
import { PreviewManager } from './preview/previewManager';
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

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = registerLanguageFeatures(context);
  const drawio = DrawioEditorProvider.register(context);
  const previews = new PreviewManager(context, diagnostics);
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

  // Returned API is picked up by the built-in Markdown preview ("markdown.markdownItPlugins").
  const api: Record<string, unknown> = { extendMarkdownIt: mermaidMarkdownPlugin };
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    api.diagnostics = {
      previews: () => previews.snapshot(),
      drawioEditors: () => drawio.snapshot(),
      drawioAction: (uri: string, action: Record<string, unknown>) => drawio.postAction(uri, action),
    };
  }
  return api;
}

export function deactivate() {}
