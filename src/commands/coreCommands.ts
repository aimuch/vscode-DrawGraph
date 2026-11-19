import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractCodeLinksFromDrawioXml, navigateToCodeTarget } from '../codeLinks';
import { DrawioEditorProvider } from '../drawio/drawioEditorProvider';
import { extractDiagramFromPng, isPngDiagramPath } from '../drawio/drawioPng';
import { extractDiagramFromSvg, isSvgDiagramPath } from '../drawio/drawioSvg';
import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';
import { t } from '../l10n';
import { findMarkdownDiagramFences } from '../language/symbols';
import { encodePlantUml, extractPlantUmlSourceFromSvg, pickBlock, splitDiagrams } from '../plantuml/encoder';
import { diagramKind, type PreviewManager } from '../preview/previewManager';
import type { SettingsPanelManager } from '../settingsPanel';
import {
  D2_TEMPLATE,
  DIAGRAM_TEMPLATES,
  DOT_TEMPLATE,
  DRAWIO_TEMPLATE,
  MERMAID_TEMPLATE,
  PLANTUML_TEMPLATE,
  WAVEDROM_TEMPLATE,
} from '../templates';
import { config, withExtension } from '../util';

export function normalizeDrawioTarget(target: vscode.Uri): vscode.Uri {
  if (/\.svg$/i.test(target.path) && !/\.(?:drawio|dio)\.svg$/i.test(target.path)) {
    return target.with({ path: target.path.replace(/\.svg$/i, '.drawio.svg') });
  }
  if (/\.png$/i.test(target.path) && !/\.(?:drawio|dio)\.png$/i.test(target.path)) {
    return target.with({ path: target.path.replace(/\.png$/i, '.drawio.png') });
  }
  return target;
}

export async function promptNewDrawioUri(defaultUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const picked = await vscode.window.showSaveDialog({
    defaultUri: defaultUri ?? (folder ? vscode.Uri.joinPath(folder, 'diagram.drawio') : undefined),
    filters: {
      'draw.io': ['drawio', 'dio'],
      [t('draw.io SVG (editable image)')]: ['drawio.svg', 'dio.svg', 'svg'],
      [t('draw.io PNG (editable image)')]: ['drawio.png', 'dio.png', 'png'],
    },
  });
  return picked ? normalizeDrawioTarget(picked) : undefined;
}

export async function createAndOpenDrawio(target: vscode.Uri): Promise<void> {
  const png = isPngDiagramPath(target.path);
  const svg = isSvgDiagramPath(target.path);
  const bytes = png || svg ? new Uint8Array(0) : Buffer.from(DRAWIO_TEMPLATE, 'utf8');
  await vscode.workspace.fs.writeFile(target, bytes);
  const viewType = png ? DrawioEditorProvider.pngViewType : DrawioEditorProvider.viewType;
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

export function activeTabContext(): { uri?: vscode.Uri; viewType?: string } {
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

function sanitizedPlantUmlServer(): string {
  const raw = (config().get<string>('plantuml.server', 'https://www.plantuml.com/plantuml') || 'https://www.plantuml.com/plantuml')
    .trim()
    .replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return raw;
    }
  } catch {
    // Fall back to default public server.
  }
  return 'https://www.plantuml.com/plantuml';
}

export interface CoreCommandDeps {
  context: vscode.ExtensionContext;
  drawio: DrawioEditorProvider;
  previews: PreviewManager;
  settingsPanel: SettingsPanelManager;
}

export function registerCoreCommands({ context, drawio, previews, settingsPanel }: CoreCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const asUri = (arg: unknown) => (arg instanceof vscode.Uri ? arg : undefined);

  const newTextDiagram = async (language: 'mermaid' | 'plantuml' | 'dot' | 'wavedrom' | 'd2', content: string) => {
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document);
    await previews.open(document.uri, true);
    return document;
  };

  register('drawGraph.openSettings', () => {
    const tabCtx = activeTabContext();
    const isDrawioTab =
      tabCtx.viewType === DrawioEditorProvider.viewType || tabCtx.viewType === DrawioEditorProvider.pngViewType;
    if (isDrawioTab && drawio.toggleSettingsDrawer()) {
      return;
    }
    if (previews.toggleSettingsDrawer()) {
      return;
    }
    if (drawio.toggleSettingsDrawer()) {
      return;
    }
    settingsPanel.open();
  });

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
      const format = fmt === 'png' ? 'png' : fmt === 'pdf' ? 'pdf' : 'svg';
      return previews.exportPlantUmlBlock(target, typeof blockIdx === 'number' ? blockIdx : 0, format);
    }
    return undefined;
  });

  register('drawGraph.plantuml.generateUrl', async (uriArg?: unknown, modeArg?: unknown): Promise<string | undefined> => {
    const editor = vscode.window.activeTextEditor;
    const targetUri = asUri(uriArg) ?? editor?.document.uri;
    if (!targetUri) {
      void vscode.window.showWarningMessage(t('Open a Mermaid or PlantUML file first.'));
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const cursorLine = editor && editor.document.uri.toString() === targetUri.toString() ? editor.selection.active.line : undefined;
    const block = pickBlock(splitDiagrams(doc.getText()), cursorLine);
    if (!block) {
      void vscode.window.showWarningMessage(t('Nothing to preview yet.'));
      return undefined;
    }
    const server = sanitizedPlantUmlServer();
    const encoded = encodePlantUml(block.source);
    const svgUrl = `${server}/svg/${encoded}`;
    const pngUrl = `${server}/png/${encoded}`;
    const markdownImg = `![diagram](${svgUrl})`;

    let chosenValue: string | undefined;
    if (modeArg === 'svg') {
      chosenValue = svgUrl;
    } else if (modeArg === 'png') {
      chosenValue = pngUrl;
    } else if (modeArg === 'markdown') {
      chosenValue = markdownImg;
    } else {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(link-external) SVG URL', detail: svgUrl, value: svgUrl },
          { label: '$(file-media) PNG URL', detail: pngUrl, value: pngUrl },
          { label: '$(markdown) Markdown Image', detail: markdownImg, value: markdownImg },
        ],
        { placeHolder: t('Copy shareable PlantUML URL or Markdown image snippet') },
      );
      chosenValue = picked?.value;
    }
    if (!chosenValue) {
      return undefined;
    }
    await vscode.env.clipboard.writeText(chosenValue);
    void vscode.window.setStatusBarMessage(t('PlantUML URL copied to clipboard'), 2500);
    return chosenValue;
  });

  register(
    'drawGraph.exportDocumentDiagrams',
    async (uriArg?: unknown, formatArg?: unknown, outDirArg?: unknown): Promise<vscode.Uri[]> => {
      const targetUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return [];
      }
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const kind = diagramKind(doc);
      const isMarkdown = doc.languageId === 'markdown' || /\.md$/i.test(targetUri.path);
      if (!kind && !isMarkdown) {
        void vscode.window.showWarningMessage(t('Open a PlantUML, Mermaid, or Markdown file with diagrams first.'));
        return [];
      }

      let format: 'svg' | 'png' | 'pdf' = 'svg';
      if (formatArg === 'svg' || formatArg === 'png' || formatArg === 'pdf') {
        format = formatArg;
      } else {
        const pickedFmt = await vscode.window.showQuickPick(
          [
            { label: 'SVG', detail: t('Vector image (.svg)'), fmt: 'svg' as const },
            { label: 'PNG', detail: t('Raster image (.png)'), fmt: 'png' as const },
            { label: 'PDF', detail: t('Portable Document Format (.pdf)'), fmt: 'pdf' as const },
          ],
          { placeHolder: t('Select export format for all diagrams in document') },
        );
        if (!pickedFmt) {
          return [];
        }
        format = pickedFmt.fmt;
      }

      const outFolder =
        asUri(outDirArg) ??
        (targetUri.scheme === 'file'
          ? vscode.Uri.joinPath(targetUri, '..')
          : vscode.workspace.workspaceFolders?.[0]?.uri);
      if (!outFolder) {
        return [];
      }

      const stem = path.basename(targetUri.path).replace(/\.[^.]+$/, '') || 'diagram';
      const baseDir = targetUri.scheme === 'file' ? path.dirname(targetUri.fsPath) : undefined;
      const tasks: Array<{ suffix: string; run: () => Promise<Uint8Array>; ext: string }> = [];

      if (kind === 'plantuml') {
        const blocks = splitDiagrams(doc.getText());
        blocks.forEach((b, idx) => {
          const suffix = blocks.length === 1 ? '' : `-${idx + 1}`;
          tasks.push({
            suffix,
            ext: `.${format}`,
            run: () => previews.renderPlantUmlBytes(b.source, format, baseDir),
          });
        });
      } else if (kind === 'mermaid') {
        if (doc.getText().trim()) {
          tasks.push({
            suffix: '',
            ext: `.${format}`,
            run: () => previews.renderMermaidBytes(doc.getText(), format),
          });
        }
      } else if (kind === 'dot') {
        if (doc.getText().trim()) {
          tasks.push({
            suffix: '',
            ext: `.${format}`,
            run: () => previews.renderDotBytes(doc.getText(), format),
          });
        }
      } else if (kind === 'wavedrom') {
        if (doc.getText().trim()) {
          tasks.push({
            suffix: '',
            ext: `.${format}`,
            run: () => previews.renderWaveDromBytes(doc.getText(), format),
          });
        }
      } else if (kind === 'd2') {
        if (doc.getText().trim()) {
          tasks.push({
            suffix: '',
            ext: `.${format}`,
            run: () => previews.renderD2Bytes(doc.getText(), format),
          });
        }
      } else if (isMarkdown) {
        const fences = findMarkdownDiagramFences(doc.getText());
        let counter = 0;
        for (const fence of fences) {
          if (fence.kind === 'plantuml') {
            for (const b of splitDiagrams(fence.content)) {
              counter++;
              tasks.push({
                suffix: `-${counter}`,
                ext: `.${format}`,
                run: () => previews.renderPlantUmlBytes(b.source, format, baseDir),
              });
            }
          } else if (fence.kind === 'mermaid' && fence.content.trim()) {
            counter++;
            tasks.push({
              suffix: `-${counter}`,
              ext: `.${format}`,
              run: () => previews.renderMermaidBytes(fence.content, format),
            });
          } else if (fence.kind === 'dot' && fence.content.trim()) {
            counter++;
            tasks.push({
              suffix: `-${counter}`,
              ext: `.${format}`,
              run: () => previews.renderDotBytes(fence.content, format),
            });
          } else if (fence.kind === 'wavedrom' && fence.content.trim()) {
            counter++;
            tasks.push({
              suffix: `-${counter}`,
              ext: `.${format}`,
              run: () => previews.renderWaveDromBytes(fence.content, format),
            });
          } else if (fence.kind === 'd2' && fence.content.trim()) {
            counter++;
            tasks.push({
              suffix: `-${counter}`,
              ext: `.${format}`,
              run: () => previews.renderD2Bytes(fence.content, format),
            });
          }
        }
      }

      if (tasks.length === 0) {
        void vscode.window.showWarningMessage(t('Nothing to preview yet.'));
        return [];
      }

      const written: vscode.Uri[] = [];
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Exporting {0} diagrams…', tasks.length),
        },
        async () => {
          for (const task of tasks) {
            const dest = vscode.Uri.joinPath(outFolder, `${stem}${task.suffix}${task.ext}`);
            const bytes = await task.run();
            await vscode.workspace.fs.writeFile(dest, bytes);
            written.push(dest);
          }
        },
      );
      void vscode.window.setStatusBarMessage(t('Exported {0} diagrams', written.length), 3000);
      return written;
    },
  );

  register('drawGraph.extractSource', async (uriArg?: unknown): Promise<vscode.TextDocument | undefined> => {
    const targetUri = asUri(uriArg) ?? activeTabContext().uri;
    if (!targetUri) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(targetUri);
    let language: 'xml' | 'plantuml' | undefined;
    let extracted: string | undefined;

    if (isPngDiagramPath(targetUri.path)) {
      extracted = extractDiagramFromPng(bytes);
      if (extracted) {
        language = 'xml';
      }
    } else if (isSvgDiagramPath(targetUri.path)) {
      const svgText = Buffer.from(bytes).toString('utf8');
      const drawioXml = extractDiagramFromSvg(svgText);
      if (drawioXml) {
        extracted = drawioXml;
        language = 'xml';
      } else {
        const puml = extractPlantUmlSourceFromSvg(svgText);
        if (puml) {
          extracted = puml;
          language = 'plantuml';
        }
      }
    }

    if (!extracted || !language) {
      void vscode.window.showWarningMessage(
        t('No embedded Draw.io or PlantUML diagram source was found in {0}.', path.basename(targetUri.path)),
      );
      return undefined;
    }

    const doc = await vscode.workspace.openTextDocument({ language, content: extracted });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    return doc;
  });

  register('drawGraph.drawio.navigateCodeLinks', async (explicitTarget?: unknown): Promise<boolean> => {
    if (typeof explicitTarget === 'string') {
      return navigateToCodeTarget(explicitTarget, activeTabContext().uri);
    }
    const active = await drawio.getActiveDiagramXml();
    if (!active) {
      void vscode.window.showWarningMessage(t('No active draw.io editor.'));
      return false;
    }
    const links = extractCodeLinksFromDrawioXml(active.xml);
    if (links.length === 0) {
      const manual = await vscode.window.showInputBox({
        prompt: t('No #Symbol or file:line labels found in diagram. Enter a #Symbol or path:line to jump to:'),
        placeHolder: '#PreviewManager or src/extension.ts:80',
      });
      return manual ? navigateToCodeTarget(manual, active.uri) : false;
    }
    if (links.length === 1) {
      return navigateToCodeTarget(links[0].label, active.uri);
    }
    const picked = await vscode.window.showQuickPick(
      links.map((l) => ({
        label: `${l.kind === 'symbol' ? '$(symbol-class)' : '$(file-code)'} ${l.label}`,
        description: l.kind === 'symbol' ? t('Workspace symbol') : t('Workspace file'),
        link: l,
      })),
      { placeHolder: t('Select a Code Link from the diagram to open in editor') },
    );
    return picked ? navigateToCodeTarget(picked.link.label, active.uri) : false;
  });

  register('drawGraph.drawio.insertCodeSymbol', async (explicitSymbol?: unknown): Promise<boolean> => {
    if (typeof explicitSymbol === 'string' && explicitSymbol.trim()) {
      const clean = explicitSymbol.trim().replace(/^#/, '');
      return drawio.insertCodeSymbolNode(`#${clean}`, `#${clean}`);
    }
    const query = await vscode.window.showInputBox({
      prompt: t('Enter a class, function, or symbol name to insert as a linked node'),
      placeHolder: 'PreviewManager',
    });
    if (!query || !query.trim()) {
      return false;
    }
    const trimmed = query.trim().replace(/^#/, '');
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      trimmed,
    );
    if (Array.isArray(symbols) && symbols.length > 1) {
      const picked = await vscode.window.showQuickPick(
        symbols.slice(0, 30).map((s) => ({
          label: `$(symbol-method) ${s.name}`,
          description: vscode.workspace.asRelativePath(s.location.uri),
          symName: s.name,
        })),
        { placeHolder: t('Select workspace symbol to link') },
      );
      if (!picked) {
        return false;
      }
      return drawio.insertCodeSymbolNode(`#${picked.symName}`, `#${picked.symName}`);
    }
    const name = Array.isArray(symbols) && symbols.length === 1 ? symbols[0].name : trimmed;
    return drawio.insertCodeSymbolNode(`#${name}`, `#${name}`);
  });

  register('drawGraph.drawio.exportSvg', (to?: unknown) => drawio.exportActive('xmlsvg', asUri(to)));
  register('drawGraph.drawio.exportPng', (to?: unknown) => drawio.exportActive('xmlpng', asUri(to)));
  register('drawGraph.drawio.exportPdf', (to?: unknown) => drawio.exportActivePdf(asUri(to)));
  register(
    'drawGraph.drawio.exportAllPages',
    async (uriArg?: unknown, fmtArg?: unknown, outDirArg?: unknown): Promise<vscode.Uri[]> => {
      let format: 'svg' | 'png' | 'pdf' = 'svg';
      if (fmtArg === 'svg' || fmtArg === 'png' || fmtArg === 'pdf') {
        format = fmtArg;
      } else {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'SVG (.drawio.svg per page)', fmt: 'svg' as const },
            { label: 'PNG (.png per page)', fmt: 'png' as const },
            { label: 'PDF (single multi-page .pdf)', fmt: 'pdf' as const },
          ],
          { placeHolder: t('Select multi-page export format') },
        );
        if (!picked) {
          return [];
        }
        format = picked.fmt;
      }
      return drawio.exportAllPages(asUri(uriArg), format, asUri(outDirArg), (svg) =>
        previews.rasterizeSvgToPngBytes(svg),
      );
    },
  );
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

  register('drawGraph.mermaid.new', () => newTextDiagram('mermaid', MERMAID_TEMPLATE));
  register('drawGraph.plantuml.new', () => newTextDiagram('plantuml', PLANTUML_TEMPLATE));
  register('drawGraph.dot.new', () => newTextDiagram('dot', DOT_TEMPLATE));
  register('drawGraph.wavedrom.new', () => newTextDiagram('wavedrom', WAVEDROM_TEMPLATE));
  register('drawGraph.d2.new', () => newTextDiagram('d2', D2_TEMPLATE));

  register('drawGraph.diagram.newFromTemplate', async (templateId?: unknown) => {
    const chosen =
      typeof templateId === 'string'
        ? DIAGRAM_TEMPLATES.find((tpl) => tpl.id === templateId)
        : (
            await vscode.window.showQuickPick(
              DIAGRAM_TEMPLATES.map((tpl) => ({ label: t(tpl.label), detail: t(tpl.detail), template: tpl })),
              { placeHolder: t('Select a diagram template') },
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
      void vscode.window.showWarningMessage(t('Open a Mermaid diagram first.'));
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
          id: 'openSettings',
          label: `$(settings-gear) ${t('DrawGraph Settings…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.openSettings'),
        },
        {
          id: 'visualDiff',
          label: `$(diff) ${t('Visual Diagram Diff vs Git HEAD')}`,
          run: () => vscode.commands.executeCommand('drawGraph.visualDiff', targetUri),
        },
        {
          id: 'navigateCodeLinks',
          label: `$(link) ${t('Navigate Code Links…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.drawio.navigateCodeLinks'),
        },
        {
          id: 'insertCodeSymbol',
          label: `$(symbol-class) ${t('Insert Workspace Code Symbol…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.drawio.insertCodeSymbol'),
        },
        {
          id: 'exportSvg',
          label: `$(export) ${t('Export as SVG')}`,
          run: () => drawio.exportActive('xmlsvg'),
        },
        {
          id: 'exportPng',
          label: `$(file-media) ${t('Export as PNG')}`,
          run: () => drawio.exportActive('xmlpng'),
        },
        {
          id: 'exportPdf',
          label: `$(file-pdf) ${t('Export as PDF')}`,
          run: () => drawio.exportActivePdf(),
        },
        {
          id: 'exportHtml',
          label: `$(globe) ${t('Export as Interactive HTML')}`,
          run: () => vscode.commands.executeCommand('drawGraph.exportHtml', targetUri),
        },
        {
          id: 'drawioToMermaid',
          label: `$(arrow-swap) ${t('Convert Draw.io to Mermaid')}`,
          run: () => vscode.commands.executeCommand('drawGraph.convert.drawioToMermaid', targetUri),
        },
        {
          id: 'drawioToPlantuml',
          label: `$(arrow-swap) ${t('Convert Draw.io to PlantUML')}`,
          run: () => vscode.commands.executeCommand('drawGraph.convert.drawioToPlantuml', targetUri),
        },
        {
          id: 'exportAllPages',
          label: `$(files) ${t('Export All Pages…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.drawio.exportAllPages', targetUri),
        },
        {
          id: 'copyPng',
          label: `$(clippy) ${t('Copy PNG')}`,
          run: () => drawio.copyActive('png'),
        },
        {
          id: 'copySvg',
          label: `$(copy) ${t('Copy SVG')}`,
          run: () => drawio.copyActive('svg'),
        },
      );
      if (tabCtx.viewType === DrawioEditorProvider.viewType && targetUri) {
        contextual.push({
          id: 'openAsText',
          label: `$(code) ${t('Open as Text')}`,
          run: () => vscode.commands.executeCommand('vscode.openWith', targetUri, 'default'),
        });
      }
    } else if (targetUri) {
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUri.toString());
      const kind = openDoc ? diagramKind(openDoc) : undefined;
      if (kind === 'mermaid' || kind === 'plantuml' || kind === 'dot' || kind === 'wavedrom' || kind === 'd2') {
        contextual.push(
          {
            id: 'previewSide',
            label: `$(open-preview) ${t('Open Diagram Preview to the Side')}`,
            run: () => previews.open(targetUri, true),
          },
          {
            id: 'aiModify',
            label: `$(sparkle) ${t('AI Modify / Optimize Diagram…')}`,
            run: () => vscode.commands.executeCommand('drawGraph.ai.openStudio', { mode: 'modify', targetUri }),
          },
          {
            id: 'aiExplain',
            label: `$(comment-discussion) ${t('AI Architecture Review & Explain')}`,
            run: () => vscode.commands.executeCommand('drawGraph.ai.explainDiagram', targetUri),
          },
          {
            id: 'visualDiff',
            label: `$(diff) ${t('Visual Diagram Diff vs Git HEAD')}`,
            run: () => vscode.commands.executeCommand('drawGraph.visualDiff', targetUri),
          },
          {
            id: 'exportPdf',
            label: `$(file-pdf) ${t('Export as PDF')}`,
            run: () => vscode.commands.executeCommand('drawGraph.exportPdf', targetUri),
          },
          {
            id: 'exportHtml',
            label: `$(globe) ${t('Export as Interactive HTML')}`,
            run: () => vscode.commands.executeCommand('drawGraph.exportHtml', targetUri),
          },
        );
        if (kind === 'mermaid') {
          contextual.push(
            {
              id: 'mermaidToDrawio',
              label: `$(type-hierarchy) ${t('Open in Draw.io')}`,
              run: () => vscode.commands.executeCommand('drawGraph.mermaid.openInDrawio', targetUri),
            },
            {
              id: 'mermaidToPlantuml',
              label: `$(arrow-swap) ${t('Convert Mermaid to PlantUML')}`,
              run: () => vscode.commands.executeCommand('drawGraph.convert.mermaidToPlantuml', targetUri),
            },
          );
        } else if (kind === 'plantuml') {
          contextual.push(
            {
              id: 'plantumlToMermaid',
              label: `$(arrow-swap) ${t('Convert PlantUML to Mermaid')}`,
              run: () => vscode.commands.executeCommand('drawGraph.convert.plantumlToMermaid', targetUri),
            },
            {
              id: 'plantumlUrl',
              label: `$(link-external) ${t('Generate Shareable PlantUML URL…')}`,
              run: () => vscode.commands.executeCommand('drawGraph.plantuml.generateUrl', targetUri),
            },
            {
              id: 'batchExport',
              label: `$(export) ${t('Export All Diagrams in File…')}`,
              run: () => vscode.commands.executeCommand('drawGraph.exportDocumentDiagrams', targetUri),
            },
          );
        }
      } else if (openDoc?.languageId === 'markdown') {
        contextual.push(
          {
            id: 'markdownPreview',
            label: `$(open-preview) ${t('Open Markdown Preview to the Side')}`,
            run: () => vscode.commands.executeCommand('markdown.showPreviewToSide', targetUri),
          },
          {
            id: 'batchExport',
            label: `$(export) ${t('Export All Diagrams in File…')}`,
            run: () => vscode.commands.executeCommand('drawGraph.exportDocumentDiagrams', targetUri),
          },
          {
            id: 'markdownPublish',
            label: `$(book) ${t('Compile Markdown for Publish (Static Diagram Assets)')}`,
            run: () => vscode.commands.executeCommand('drawGraph.markdown.compilePublish', targetUri),
          },
        );
      } else if (/\.(?:drawio|dio|svg|png|xml)$/i.test(targetUri.path)) {
        const viewType = isPngDiagramPath(targetUri.path)
          ? DrawioEditorProvider.pngViewType
          : DrawioEditorProvider.viewType;
        contextual.push({
          id: 'openInDrawio',
          label: `$(edit) ${t('Open Current File in Draw.io Editor')}`,
          description: vscode.workspace.asRelativePath(targetUri),
          run: () => vscode.commands.executeCommand('vscode.openWith', targetUri, viewType),
        });
        if (/\.(?:svg|png)$/i.test(targetUri.path)) {
          contextual.push({
            id: 'extractSource',
            label: `$(file-code) ${t('Extract Embedded Diagram Source')}`,
            run: () => vscode.commands.executeCommand('drawGraph.extractSource', targetUri),
          });
        }
      } else if (/\.(?:proto|prisma)$/i.test(targetUri.path) || /(?:openapi|swagger).*\.(?:ya?ml|json)$/i.test(targetUri.path)) {
        contextual.push({
          id: 'generateFromSpec',
          label: `$(symbol-interface) ${t('Generate Diagram from OpenAPI / Proto / Prisma…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.generateFromSpec', targetUri),
        });
      } else if (/(?:docker-compose|compose).*\.(?:ya?ml)$|\.github\/workflows\/.*\.(?:ya?ml)$/i.test(targetUri.path)) {
        contextual.push({
          id: 'generateInfraDiagram',
          label: `$(server-process) ${t('Generate Topology from Compose / GitHub Actions…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.generateInfraDiagram', targetUri),
        });
      } else if (/\.(?:sql|json)$/i.test(targetUri.path)) {
        contextual.push({
          id: 'generateFromData',
          label: `$(database) ${t('Generate Diagram from SQL / JSON…')}`,
          run: () => vscode.commands.executeCommand('drawGraph.generateFromData', targetUri),
        });
      } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|cs|go|rs|cpp|hpp|c|h|dart)$/i.test(targetUri.path)) {
        contextual.push(
          {
            id: 'generateClassDiagram',
            label: `$(symbol-class) ${t('Generate Class Diagram from Code…')}`,
            run: () => vscode.commands.executeCommand('drawGraph.generateClassDiagram', targetUri),
          },
          {
            id: 'generateDependencyDiagram',
            label: `$(references) ${t('Generate Module Dependency Diagram…')}`,
            run: () => vscode.commands.executeCommand('drawGraph.generateDependencyDiagram', targetUri),
          },
        );
      }
    }

    const creation: QuickActionItem[] = [
      {
        id: 'aiStudio',
        label: `$(sparkle) ${t('AI Diagram Studio…')}`,
        detail: t('Generate, modify, optimize, fix syntax, or review architecture with AI'),
        run: () => vscode.commands.executeCommand('drawGraph.ai.openStudio'),
      },
      {
        id: 'aiGenerate',
        label: `$(wand) ${t('Generate Diagram from Prompt with AI…')}`,
        detail: t('Create Mermaid, Draw.io, PlantUML, Graphviz DOT, or WaveDrom from natural language'),
        run: () => vscode.commands.executeCommand('drawGraph.ai.generateDiagram'),
      },
      {
        id: 'newDrawio',
        label: `$(edit) ${t('New Draw.io Diagram')}`,
        detail: '.drawio / .drawio.svg / .drawio.png',
        run: () => vscode.commands.executeCommand('drawGraph.drawio.new'),
      },
      {
        id: 'newMermaid',
        label: `$(git-merge) ${t('New Mermaid Diagram')}`,
        detail: t('Live text-to-diagram preview'),
        run: () => newTextDiagram('mermaid', MERMAID_TEMPLATE),
      },
      {
        id: 'newPlantuml',
        label: `$(type-hierarchy-sub) ${t('New PlantUML Diagram')}`,
        detail: t('UML sequence, class, component, mindmap…'),
        run: () => newTextDiagram('plantuml', PLANTUML_TEMPLATE),
      },
      {
        id: 'newD2',
        label: `$(layers) ${t('New D2 Architecture Diagram')}`,
        detail: t('Modern declarative architecture diagram (.d2)'),
        run: () => newTextDiagram('d2', D2_TEMPLATE),
      },
      {
        id: 'searchDiagrams',
        label: `$(search) ${t('Search Nodes Across Workspace Diagrams…')}`,
        detail: t('Find any service, node, or label across all workspace diagrams'),
        run: () => vscode.commands.executeCommand('drawGraph.searchDiagrams'),
      },
      {
        id: 'prImpact',
        label: `$(git-pull-request) ${t('Generate Git PR Impact Diagram…')}`,
        detail: t('Visualize changed files and downstream affected dependents'),
        run: () => vscode.commands.executeCommand('drawGraph.generatePrImpactDiagram'),
      },
      {
        id: 'archDrift',
        label: `$(pulse) ${t('Check Architecture Drift (Code ↔ Diagrams)')}`,
        detail: t('Find undocumented modules and stale diagram references'),
        run: () => vscode.commands.executeCommand('drawGraph.checkArchitectureDrift'),
      },
      {
        id: 'newFromTemplate',
        label: `$(symbol-misc) ${t('New Diagram from Template…')}`,
        detail: t('Choose from 13 built-in diagram templates'),
        run: () => vscode.commands.executeCommand('drawGraph.diagram.newFromTemplate'),
      },
      {
        id: 'codeClassDiagram',
        label: `$(symbol-class) ${t('Generate Class Diagram from Code…')}`,
        detail: t('Analyze workspace classes & interfaces into Mermaid, PlantUML, or Draw.io'),
        run: () => vscode.commands.executeCommand('drawGraph.generateClassDiagram', targetUri),
      },
      {
        id: 'codeDepDiagram',
        label: `$(references) ${t('Generate Module Dependency Diagram…')}`,
        detail: t('Visualize local module imports across files'),
        run: () => vscode.commands.executeCommand('drawGraph.generateDependencyDiagram', targetUri),
      },
      {
        id: 'dataDiagram',
        label: `$(database) ${t('Generate Diagram from SQL / JSON…')}`,
        detail: t('Convert SQL CREATE TABLE or JSON into ER / Mindmap diagrams'),
        run: () => vscode.commands.executeCommand('drawGraph.generateFromData', targetUri),
      },
      {
        id: 'specDiagram',
        label: `$(symbol-interface) ${t('Generate Diagram from OpenAPI / Proto / Prisma…')}`,
        detail: t('Visualize REST endpoints, gRPC services, or Prisma relations'),
        run: () => vscode.commands.executeCommand('drawGraph.generateFromSpec', targetUri),
      },
      {
        id: 'infraDiagram',
        label: `$(server-process) ${t('Generate Topology from Compose / GitHub Actions…')}`,
        detail: t('Visualize Docker Compose services or CI/CD job pipelines'),
        run: () => vscode.commands.executeCommand('drawGraph.generateInfraDiagram', targetUri),
      },
      {
        id: 'branchReview',
        label: `$(git-compare) ${t('Review All Modified Diagrams vs Branch…')}`,
        detail: t('Batch visual review of changed diagrams against main / HEAD'),
        run: () => vscode.commands.executeCommand('drawGraph.visualDiffBranch'),
      },
      {
        id: 'checkCodeLinks',
        label: `$(check-all) ${t('Audit Broken Diagram Code Links')}`,
        detail: t('Scan workspace diagrams for missing file references'),
        run: () => vscode.commands.executeCommand('drawGraph.checkCodeLinks'),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        id: 'settings',
        label: `$(settings-gear) ${t('DrawGraph Settings…')}`,
        detail: t('Language (中 / EN), Draw.io, Offline Pack, Mermaid & PlantUML preferences'),
        run: () => vscode.commands.executeCommand('drawGraph.openSettings'),
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
      placeHolder: t('Create, preview, diff, generate, or convert diagrams'),
    });
    await picked?.run?.();
  });
}
