import * as vscode from 'vscode';
import { DrawioEditorProvider } from './drawio/drawioEditorProvider';
import { isSvgDiagramPath } from './drawio/drawioSvg';
import { mermaidMarkdownPlugin } from './markdown/markdownIt';
import { PreviewManager } from './preview/previewManager';
import { DRAWIO_TEMPLATE, MERMAID_TEMPLATE, PLANTUML_TEMPLATE } from './templates';

export function activate(context: vscode.ExtensionContext) {
  const drawio = DrawioEditorProvider.register(context);
  const previews = new PreviewManager(context);

  const register = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('drawGraph.preview.open', (uri?: vscode.Uri) => previews.open(uri instanceof vscode.Uri ? uri : undefined, false));
  register('drawGraph.preview.openToSide', (uri?: vscode.Uri) => previews.open(uri instanceof vscode.Uri ? uri : undefined, true));

  const target = (arg: unknown) => (arg instanceof vscode.Uri ? arg : undefined);
  register('drawGraph.drawio.exportSvg', (to?: unknown) => drawio.exportActive('xmlsvg', target(to)));
  register('drawGraph.drawio.exportPng', (to?: unknown) => drawio.exportActive('xmlpng', target(to)));
  register('drawGraph.drawio.openAsText', async () => {
    const uri = drawio.activeDocumentUri;
    if (uri) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }
  });

  register('drawGraph.drawio.new', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    let target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, 'diagram.drawio') : undefined,
      filters: {
        'draw.io': ['drawio', 'dio'],
        [vscode.l10n.t('draw.io SVG (editable image)')]: ['drawio.svg', 'svg'],
      },
    });
    if (!target) {
      return;
    }
    if (/\.svg$/i.test(target.path) && !/\.drawio\.svg$/i.test(target.path)) {
      target = target.with({ path: target.path.replace(/\.svg$/i, '.drawio.svg') });
    }
    // An SVG diagram starts empty: the editor shows a blank page and writes the SVG on the first edit.
    const content = isSvgDiagramPath(target.path) ? '' : DRAWIO_TEMPLATE;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', target, DrawioEditorProvider.viewType);
  });

  const newTextDiagram = async (language: 'mermaid' | 'plantuml', content: string) => {
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document);
    await previews.open(document.uri, true);
  };
  register('drawGraph.mermaid.new', () => newTextDiagram('mermaid', MERMAID_TEMPLATE));
  register('drawGraph.plantuml.new', () => newTextDiagram('plantuml', PLANTUML_TEMPLATE));

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
