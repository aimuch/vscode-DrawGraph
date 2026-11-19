import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AiDiagramStudioManager } from '../ai/aiDiagramStudio';
import { buildDrawGraphCiScript, buildDrawGraphCiWorkflowYaml } from '../ci/ciWorkflowGenerator';
import { navigateToCodeTarget } from '../codeLinks';
import { convertMermaidToPlantUml, convertPlantUmlToMermaid } from '../converters/diagramConverters';
import { convertDrawioToMermaid, convertDrawioToPlantUml } from '../converters/drawioToText';
import { extractResourceUri, type VisualDiffManager } from '../diff/visualDiffPanel';
import { extractDrawioPages } from '../drawio/codeLinksXml';
import { STARTER_WORKSPACE_LIBRARY_XML } from '../drawio/customLibraryLoader';
import { DrawioEditorProvider, readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { replaceEmbeddedDiagram } from '../drawio/drawioSvg';
import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import type { OfflinePackManager } from '../drawio/offlinePackManager';
import { openDiagramSearchQuickPick, searchWorkspaceDiagramNodes } from '../explorer/diagramSearch';
import type { DiagramExplorerProvider } from '../explorer/diagramTreeView';
import { buildInteractiveHtmlBundle } from '../export/htmlExporter';
import {
  extractFallbackCodeSymbols,
  extractLocalImports,
  generateClassDiagramFromSymbols,
  generateDependencyDiagram,
  inferTypeRelationsFromSource,
  type CodeSymbolNode,
  type ModuleDependencyEdge,
} from '../generators/codeToDiagram';
import { convertJsonToDiagram, convertSqlToDiagram } from '../generators/dataToDiagram';
import { convertInfraToDiagram } from '../generators/infraToDiagram';
import { computePrImpactGraph, renderPrImpactDiagram, type ChangedFileEntry } from '../generators/prImpactCore';
import {
  convertOpenApiToDiagram,
  convertPrismaToDiagram,
  convertProtoToDiagram,
} from '../generators/specToDiagram';
import { getLanguage, t } from '../l10n';
import { computeArchitectureDrift } from '../language/architectureDriftCore';
import type { CodeLinkMaintenanceService } from '../language/codeLinkMaintenance';
import { findMarkdownDiagramFences } from '../language/symbols';
import { compileMarkdownForPublish } from '../markdown/markdownPublisher';
import { pickBlock, splitDiagrams } from '../plantuml/encoder';
import { diagramKind, type PreviewManager } from '../preview/previewManager';
import type { SettingsPanelManager } from '../settingsPanel';
import { isDarkTheme, saveBytes, withExtension } from '../util';
import { extractWalkthroughSteps, type WalkthroughStep } from '../walkthrough/walkthroughCore';
import { activeTabContext } from './coreCommands';

const execFileAsync = promisify(execFile);

export interface AdvancedCommandDeps {
  context: vscode.ExtensionContext;
  drawio: DrawioEditorProvider;
  previews: PreviewManager;
  visualDiff: VisualDiffManager;
  aiStudio: AiDiagramStudioManager;
  offlinePack: OfflinePackManager;
  explorer: DiagramExplorerProvider;
  settingsPanel: SettingsPanelManager;
  codeLinkMaintenance: CodeLinkMaintenanceService;
}

function mapVscodeSymbolKind(kind: vscode.SymbolKind): CodeSymbolNode['kind'] | undefined {
  switch (kind) {
    case vscode.SymbolKind.Class:
      return 'class';
    case vscode.SymbolKind.Interface:
      return 'interface';
    case vscode.SymbolKind.Enum:
      return 'enum';
    case vscode.SymbolKind.Struct:
      return 'struct';
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return 'method';
    case vscode.SymbolKind.Function:
      return 'function';
    case vscode.SymbolKind.Property:
    case vscode.SymbolKind.Field:
      return 'field';
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
      return 'module';
    default:
      return undefined;
  }
}

function convertDocSymbols(symbols: readonly vscode.DocumentSymbol[]): CodeSymbolNode[] {
  const out: CodeSymbolNode[] = [];
  for (const s of symbols) {
    const mapped = mapVscodeSymbolKind(s.kind);
    const children = s.children?.length ? convertDocSymbols(s.children) : undefined;
    if (mapped) {
      out.push({
        name: s.name,
        detail: s.detail || undefined,
        kind: mapped,
        children,
      });
    } else if (children && children.length > 0) {
      out.push(...children);
    }
  }
  return out;
}

async function promptDiagramOutputFormat(
  explicit?: unknown,
): Promise<'mermaid' | 'plantuml' | 'drawio' | undefined> {
  if (explicit === 'mermaid' || explicit === 'plantuml' || explicit === 'drawio') {
    return explicit;
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(git-merge) Mermaid', detail: t('Editable text diagram with live preview'), fmt: 'mermaid' as const },
      { label: '$(type-hierarchy-sub) PlantUML', detail: t('Standard UML syntax'), fmt: 'plantuml' as const },
      { label: '$(layout) Draw.io (.drawio)', detail: t('Interactive drag-and-drop canvas'), fmt: 'drawio' as const },
    ],
    { placeHolder: t('Select target diagram format') },
  );
  return picked?.fmt;
}

export function registerAdvancedCommands({
  context,
  drawio,
  previews,
  visualDiff,
  aiStudio,
  offlinePack,
  explorer,
  settingsPanel,
  codeLinkMaintenance,
}: AdvancedCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const asUri = (arg: unknown) => (arg instanceof vscode.Uri ? arg : undefined);

  // Internal helper invoked by DocumentLinkProvider command URIs
  register('drawGraph.openCodeTarget', async (targetArg?: unknown, fromUriStr?: unknown) => {
    if (typeof targetArg !== 'string' || !targetArg) {
      return false;
    }
    const refUri = typeof fromUriStr === 'string' ? vscode.Uri.parse(fromUriStr) : activeTabContext().uri;
    return navigateToCodeTarget(targetArg, refUri);
  });

  // Diagram Explorer Sidebar actions
  register('drawGraph.diagramExplorer.refresh', () => explorer.refresh());
  register('drawGraph.explorer.openEntry', async (uriArg?: unknown, lineArg?: unknown, dtypeArg?: unknown) => {
    const uri = asUri(uriArg);
    if (!uri) {
      return;
    }
    const line = typeof lineArg === 'number' ? lineArg : 0;
    if (dtypeArg === 'drawio') {
      await drawio.openAtPage(uri, line);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const safeLine = Math.max(0, Math.min(line, Math.max(0, doc.lineCount - 1)));
    const pos = new vscode.Position(safeLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (
      dtypeArg === 'mermaid' ||
      dtypeArg === 'plantuml' ||
      dtypeArg === 'dot' ||
      dtypeArg === 'wavedrom' ||
      dtypeArg === 'd2'
    ) {
      if (doc.languageId === 'markdown') {
        await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
      } else {
        await previews.open(uri, true, safeLine);
      }
    }
  });

  // F1: Git Visual Diagram Diff & Branch Diagram Review
  register('drawGraph.visualDiff', async (arg?: unknown, refArg?: unknown) => {
    const target = extractResourceUri(arg) ?? activeTabContext().uri;
    if (!target) {
      void vscode.window.showWarningMessage(t('Open or select a diagram file first.'));
      return false;
    }
    const gitRef = typeof refArg === 'string' && refArg.trim() ? refArg.trim() : 'HEAD';
    return visualDiff.openGitDiff(target, gitRef);
  });

  register('drawGraph.visualDiffBranch', async (baseRefArg?: unknown) => {
    return visualDiff.openBranchReview(typeof baseRefArg === 'string' ? baseRefArg : undefined);
  });

  register('drawGraph.visualDiffFiles', async (leftArg?: unknown, rightArg?: unknown) => {
    return visualDiff.openFileComparison(asUri(leftArg), asUri(rightArg));
  });

  // F3: Universal PDF Export & Standalone Interactive HTML Export
  register('drawGraph.exportPdf', async (uriArg?: unknown, destArg?: unknown): Promise<vscode.Uri | undefined> => {
    const tabCtx = activeTabContext();
    const isDrawio =
      tabCtx.viewType === DrawioEditorProvider.viewType || tabCtx.viewType === DrawioEditorProvider.pngViewType;
    if (!uriArg && isDrawio) {
      return drawio.exportActivePdf(asUri(destArg));
    }
    const targetUri = asUri(uriArg) ?? tabCtx.uri;
    if (!targetUri) {
      return undefined;
    }
    if (/\.(?:drawio|dio)(?:\.(?:svg|png|xml))?$/i.test(targetUri.path)) {
      const dest = asUri(destArg) ?? withExtension(targetUri, '.pdf');
      if (destArg instanceof vscode.Uri) {
        const xml = await readDrawioXmlFromUri(targetUri);
        if (xml) {
          const pages = extractDrawioPages(xml);
          const pngPages = [];
          for (let i = 0; i < Math.max(1, pages.length); i++) {
            const svg = renderMxfileToPreviewSvg(xml, i);
            const pngBytes = await previews.rasterizeSvgToPngBytes(svg);
            pngPages.push({ bytes: pngBytes, format: 'png' as const, scale: 2 });
          }
          const { buildPdfDocument } = await import('../export/pdfWriter');
          await vscode.workspace.fs.writeFile(dest, buildPdfDocument(pngPages));
          return dest;
        }
      }
      return drawio.exportActivePdf(asUri(destArg));
    }
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const kind = diagramKind(doc);
    if (!kind) {
      return drawio.exportActivePdf(asUri(destArg));
    }
    const dest = asUri(destArg);
    const baseDir = targetUri.scheme === 'file' ? path.dirname(targetUri.fsPath) : undefined;
    const pdfBytes =
      kind === 'mermaid'
        ? await previews.renderMermaidBytes(doc.getText(), 'pdf')
        : kind === 'dot'
          ? await previews.renderDotBytes(doc.getText(), 'pdf')
          : kind === 'wavedrom'
            ? await previews.renderWaveDromBytes(doc.getText(), 'pdf')
            : kind === 'd2'
              ? await previews.renderD2Bytes(doc.getText(), 'pdf')
              : await previews.renderPlantUmlBytes(splitDiagrams(doc.getText())[0]?.source ?? doc.getText(), 'pdf', baseDir);

    if (dest) {
      await vscode.workspace.fs.writeFile(dest, pdfBytes);
      return dest;
    }
    await saveBytes(withExtension(targetUri, '.pdf'), pdfBytes, { PDF: ['pdf'] });
    return withExtension(targetUri, '.pdf');
  });

  register('drawGraph.exportHtml', async (uriArg?: unknown, destArg?: unknown): Promise<vscode.Uri | undefined> => {
    const tabCtx = activeTabContext();
    const targetUri = asUri(uriArg) ?? tabCtx.uri;
    if (!targetUri) {
      void vscode.window.showWarningMessage(t('Open or select a diagram file first.'));
      return undefined;
    }

    const pages: Array<{ name: string; svg: string; steps?: WalkthroughStep[] }> = [];
    if (
      /\.(?:drawio|dio)(?:\.(?:svg|png|xml))?$/i.test(targetUri.path) ||
      tabCtx.viewType === DrawioEditorProvider.viewType ||
      tabCtx.viewType === DrawioEditorProvider.pngViewType
    ) {
      const xml = (await readDrawioXmlFromUri(targetUri)) ?? (await drawio.getActiveDiagramXml())?.xml;
      if (!xml) {
        return undefined;
      }
      const rawPages = extractDrawioPages(xml);
      const count = Math.max(1, rawPages.length);
      for (let i = 0; i < count; i++) {
        pages.push({
          name: rawPages[i]?.name || `Page ${i + 1}`,
          svg: renderMxfileToPreviewSvg(xml, i),
        });
      }
    } else {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const kind = diagramKind(doc);
      const baseDir = targetUri.scheme === 'file' ? path.dirname(targetUri.fsPath) : undefined;
      const steps = extractWalkthroughSteps(doc.getText());
      if (kind === 'mermaid') {
        const svgBytes = await previews.renderMermaidBytes(doc.getText(), 'svg');
        pages.push({ name: path.basename(targetUri.path), svg: Buffer.from(svgBytes).toString('utf8'), steps });
      } else if (kind === 'plantuml') {
        const blocks = splitDiagrams(doc.getText());
        for (let i = 0; i < blocks.length; i++) {
          const svgBytes = await previews.renderPlantUmlBytes(blocks[i].source, 'svg', baseDir);
          pages.push({
            name: blocks[i].title || `Diagram ${i + 1}`,
            svg: Buffer.from(svgBytes).toString('utf8'),
            steps: extractWalkthroughSteps(blocks[i].source),
          });
        }
      } else if (kind === 'dot') {
        const svgBytes = await previews.renderDotBytes(doc.getText(), 'svg');
        pages.push({ name: path.basename(targetUri.path), svg: Buffer.from(svgBytes).toString('utf8'), steps });
      } else if (kind === 'wavedrom') {
        const svgBytes = await previews.renderWaveDromBytes(doc.getText(), 'svg');
        pages.push({ name: path.basename(targetUri.path), svg: Buffer.from(svgBytes).toString('utf8'), steps });
      } else if (kind === 'd2') {
        const svgBytes = await previews.renderD2Bytes(doc.getText(), 'svg');
        pages.push({ name: path.basename(targetUri.path), svg: Buffer.from(svgBytes).toString('utf8'), steps });
      }
    }

    if (pages.length === 0) {
      return undefined;
    }

    const html = buildInteractiveHtmlBundle({
      title: path.basename(targetUri.path),
      pages,
      lang: getLanguage(),
      defaultTheme: isDarkTheme() ? 'dark' : 'light',
    });
    const htmlBytes = Buffer.from(html, 'utf8');
    const dest = asUri(destArg);
    if (dest) {
      await vscode.workspace.fs.writeFile(dest, htmlBytes);
      return dest;
    }
    const defaultOut = withExtension(targetUri, '.html');
    await saveBytes(defaultOut, htmlBytes, { HTML: ['html'] });
    return defaultOut;
  });

  // Draw.io -> Mermaid / PlantUML reverse conversion
  const convertDrawioHelper = async (
    uriArg: unknown,
    targetLang: 'mermaid' | 'plantuml',
  ): Promise<vscode.TextDocument | undefined> => {
    const uri = asUri(uriArg) ?? activeTabContext().uri;
    const xml = (uri ? await readDrawioXmlFromUri(uri) : undefined) ?? (await drawio.getActiveDiagramXml())?.xml;
    if (!xml) {
      void vscode.window.showWarningMessage(t('Open or select a Draw.io diagram first.'));
      return undefined;
    }
    const outText = targetLang === 'mermaid' ? convertDrawioToMermaid(xml) : convertDrawioToPlantUml(xml);
    const outDoc = await vscode.workspace.openTextDocument({ language: targetLang, content: outText });
    await vscode.window.showTextDocument(outDoc, { viewColumn: vscode.ViewColumn.Beside });
    await previews.open(outDoc.uri, true);
    return outDoc;
  };

  register('drawGraph.convert.drawioToMermaid', (uriArg?: unknown) => convertDrawioHelper(uriArg, 'mermaid'));
  register('drawGraph.convert.drawioToPlantuml', (uriArg?: unknown) => convertDrawioHelper(uriArg, 'plantuml'));

  // F6.2: Bidirectional PlantUML <-> Mermaid Conversion
  register(
    'drawGraph.convert.plantumlToMermaid',
    async (uriArg?: unknown, sourceOverride?: unknown): Promise<vscode.TextDocument | undefined> => {
      let pumlText = typeof sourceOverride === 'string' ? sourceOverride : undefined;
      if (pumlText === undefined) {
        const editor = vscode.window.activeTextEditor;
        const targetUri = asUri(uriArg) ?? editor?.document.uri;
        if (!targetUri) {
          return undefined;
        }
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const line = editor && editor.document.uri.toString() === targetUri.toString() ? editor.selection.active.line : undefined;
        pumlText = pickBlock(splitDiagrams(doc.getText()), line)?.source ?? doc.getText();
      }
      const converted = convertPlantUmlToMermaid(pumlText);
      const outDoc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: converted });
      await vscode.window.showTextDocument(outDoc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(outDoc.uri, true);
      return outDoc;
    },
  );

  register(
    'drawGraph.convert.mermaidToPlantuml',
    async (uriArg?: unknown, sourceOverride?: unknown): Promise<vscode.TextDocument | undefined> => {
      let mmdText = typeof sourceOverride === 'string' ? sourceOverride : undefined;
      if (mmdText === undefined) {
        const targetUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          return undefined;
        }
        const doc = await vscode.workspace.openTextDocument(targetUri);
        mmdText = doc.getText();
      }
      const converted = convertMermaidToPlantUml(mmdText);
      const outDoc = await vscode.workspace.openTextDocument({ language: 'plantuml', content: converted });
      await vscode.window.showTextDocument(outDoc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(outDoc.uri, true);
      return outDoc;
    },
  );

  // F5: Markdown Fence Export & Extract to .drawio.svg
  register(
    'drawGraph.markdown.exportFence',
    async (uriArg?: unknown, fenceIdxArg?: unknown, fmtArg?: unknown, destArg?: unknown): Promise<vscode.Uri | undefined> => {
      const targetUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return undefined;
      }
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const fences = findMarkdownDiagramFences(doc.getText());
      const idx = typeof fenceIdxArg === 'number' ? fenceIdxArg : 0;
      const fence = fences[idx];
      if (!fence || !fence.content.trim()) {
        return undefined;
      }
      const format: 'svg' | 'png' | 'pdf' = fmtArg === 'png' ? 'png' : fmtArg === 'pdf' ? 'pdf' : 'svg';
      const baseDir = targetUri.scheme === 'file' ? path.dirname(targetUri.fsPath) : undefined;
      const bytes =
        fence.kind === 'mermaid'
          ? await previews.renderMermaidBytes(fence.content, format)
          : fence.kind === 'dot'
            ? await previews.renderDotBytes(fence.content, format)
            : fence.kind === 'wavedrom'
              ? await previews.renderWaveDromBytes(fence.content, format)
              : fence.kind === 'd2'
                ? await previews.renderD2Bytes(fence.content, format)
                : await previews.renderPlantUmlBytes(splitDiagrams(fence.content)[0]?.source ?? fence.content, format, baseDir);

      const dest = asUri(destArg);
      if (dest) {
        await vscode.workspace.fs.writeFile(dest, bytes);
        return dest;
      }
      const stem = path.basename(targetUri.path).replace(/\.[^.]+$/, '') || 'diagram';
      const suggested = vscode.Uri.joinPath(targetUri, '..', `${stem}-${idx + 1}.${format}`);
      const filterMap: Record<string, string[]> =
        format === 'svg' ? { SVG: ['svg'] } : format === 'pdf' ? { PDF: ['pdf'] } : { PNG: ['png'] };
      await saveBytes(suggested, bytes, filterMap);
      return suggested;
    },
  );

  register(
    'drawGraph.markdown.extractToDrawioSvg',
    async (uriArg?: unknown, fenceIdxArg?: unknown, destArg?: unknown): Promise<vscode.Uri | undefined> => {
      const targetUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        return undefined;
      }
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const fences = findMarkdownDiagramFences(doc.getText());
      let idx = typeof fenceIdxArg === 'number' ? fenceIdxArg : -1;
      if (idx < 0) {
        const cur = vscode.window.activeTextEditor?.selection.active.line ?? 0;
        idx = fences.findIndex((f) => f.kind === 'mermaid' && cur >= f.startLine && cur <= f.endLine);
        if (idx < 0) {
          idx = fences.findIndex((f) => f.kind === 'mermaid');
        }
      }
      const fence = fences[idx];
      if (!fence || fence.kind !== 'mermaid') {
        void vscode.window.showWarningMessage(t('Place cursor inside a Markdown Mermaid block first.'));
        return undefined;
      }

      const stem = path.basename(targetUri.path).replace(/\.[^.]+$/, '') || 'diagram';
      const defaultDest =
        targetUri.scheme === 'file'
          ? vscode.Uri.joinPath(targetUri, '..', `${stem}-${idx + 1}.drawio.svg`)
          : undefined;
      const dest =
        asUri(destArg) ??
        (await vscode.window.showSaveDialog({
          defaultUri: defaultDest,
          filters: { [t('draw.io SVG (editable image)')]: ['drawio.svg', 'svg'] },
        }));
      if (!dest) {
        return undefined;
      }

      const mxXml = convertMermaidToDrawioXml(fence.content);
      const previewSvg = renderMxfileToPreviewSvg(mxXml);
      const editableSvg = replaceEmbeddedDiagram(previewSvg, mxXml);
      await vscode.workspace.fs.writeFile(dest, Buffer.from(editableSvg, 'utf8'));

      if (targetUri.scheme === 'file' && dest.scheme === 'file') {
        const relImg = path.relative(path.dirname(targetUri.fsPath), dest.fsPath).split(path.sep).join('/');
        const mdRef = `![diagram](${relImg.startsWith('.') ? relImg : `./${relImg}`})`;
        const edit = new vscode.WorkspaceEdit();
        const fenceRange = new vscode.Range(
          fence.startLine,
          0,
          fence.endLine,
          doc.lineAt(Math.min(fence.endLine, doc.lineCount - 1)).text.length,
        );
        edit.replace(targetUri, fenceRange, mdRef);
        await vscode.workspace.applyEdit(edit);
      }
      return dest;
    },
  );

  // F4: Code-to-Diagram Generators (Class Diagram + Module Dependency Diagram)
  register(
    'drawGraph.generateClassDiagram',
    async (uriArg?: unknown, formatArg?: unknown, destArg?: unknown): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      const targetUri = asUri(uriArg) ?? activeTabContext().uri;
      if (!targetUri) {
        void vscode.window.showWarningMessage(t('Open or select a source code file or folder first.'));
        return undefined;
      }

      const stat = await vscode.workspace.fs.stat(targetUri);
      const files: vscode.Uri[] = [];
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(targetUri, '**/*.{ts,tsx,js,jsx,py,java,cs,go,rs,cpp,hpp,dart}'),
          '**/{node_modules,.git,dist,out,build}/**',
          40,
        );
        files.push(...found);
      } else {
        files.push(targetUri);
      }
      if (files.length === 0) {
        return undefined;
      }

      const format = await promptDiagramOutputFormat(formatArg);
      if (!format) {
        return undefined;
      }

      const allSymbols: CodeSymbolNode[] = [];
      const combinedSources: string[] = [];

      for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        combinedSources.push(text);
        let lspSymbols: vscode.DocumentSymbol[] | undefined;
        try {
          const raw = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            file,
          );
          if (Array.isArray(raw) && raw.length > 0 && 'children' in raw[0]) {
            lspSymbols = raw;
          }
        } catch {
          lspSymbols = undefined;
        }
        const converted = lspSymbols ? convertDocSymbols(lspSymbols) : [];
        if (converted.length > 0) {
          allSymbols.push(...converted);
        } else {
          allSymbols.push(...extractFallbackCodeSymbols(text));
        }
      }

      const typeNames = new Set<string>();
      const collectNames = (list: readonly CodeSymbolNode[]) => {
        for (const n of list) {
          if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'enum' || n.kind === 'struct') {
            typeNames.add(n.name);
          }
          if (n.children) {
            collectNames(n.children);
          }
        }
      };
      collectNames(allSymbols);

      const relMap = inferTypeRelationsFromSource(combinedSources.join('\n'), typeNames);
      const attachRels = (list: CodeSymbolNode[]) => {
        for (const n of list) {
          const rels = relMap.get(n.name);
          if (rels) {
            n.relations = rels;
          }
          if (n.children) {
            attachRels(n.children);
          }
        }
      };
      attachRels(allSymbols);

      const output = generateClassDiagramFromSymbols(allSymbols, format);
      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(
              (stat.type & vscode.FileType.Directory) !== 0 ? targetUri : vscode.Uri.joinPath(targetUri, '..'),
              'classes.drawio',
            ),
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) {
          return undefined;
        }
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  register(
    'drawGraph.generateDependencyDiagram',
    async (uriArg?: unknown, formatArg?: unknown, destArg?: unknown): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      let folderUri = asUri(uriArg) ?? activeTabContext().uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folderUri) {
        return undefined;
      }
      const stat = await vscode.workspace.fs.stat(folderUri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        folderUri = vscode.Uri.joinPath(folderUri, '..');
      }

      const format = await promptDiagramOutputFormat(formatArg);
      if (!format) {
        return undefined;
      }

      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folderUri, '**/*.{ts,tsx,js,jsx,mjs,cjs,py,c,cpp,h,hpp}'),
        '**/{node_modules,.git,dist,out,build,.vscode-test}/**',
        120,
      );

      const knownRel = new Map<string, string>();
      for (const f of files) {
        const rel = path.relative(folderUri.fsPath, f.fsPath).split(path.sep).join('/');
        knownRel.set(rel, rel);
        knownRel.set(rel.replace(/\.[^.]+$/, ''), rel);
      }

      const edges: ModuleDependencyEdge[] = [];
      const seenEdge = new Set<string>();

      for (const f of files) {
        const fromRel = path.relative(folderUri.fsPath, f.fsPath).split(path.sep).join('/');
        const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
        for (const spec of extractLocalImports(text)) {
          const resolvedRel = path
            .relative(folderUri.fsPath, path.resolve(path.dirname(f.fsPath), spec))
            .split(path.sep)
            .join('/');
          const toRel =
            knownRel.get(resolvedRel) ??
            knownRel.get(`${resolvedRel}/index`) ??
            (resolvedRel.startsWith('..') ? path.basename(resolvedRel) : resolvedRel);
          if (fromRel !== toRel) {
            const key = `${fromRel}->${toRel}`;
            if (!seenEdge.has(key)) {
              seenEdge.add(key);
              edges.push({ from: fromRel, to: toRel });
            }
          }
        }
      }

      const output = generateDependencyDiagram(edges, format);
      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folderUri, 'dependencies.drawio'),
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) {
          return undefined;
        }
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  // F7: Offline Draw.io Pack lifecycle commands
  const syncAfterPackChange = () => {
    drawio.broadcastSettingsState();
    previews.broadcastSettingsState();
    settingsPanel.refresh();
  };

  register('drawGraph.drawio.downloadOfflinePack', async (customUrl?: unknown) => {
    const ok = await offlinePack.downloadOfficialPack(typeof customUrl === 'string' ? customUrl : undefined);
    syncAfterPackChange();
    return ok;
  });

  register('drawGraph.drawio.importOfflinePack', async (archiveUri?: unknown) => {
    const ok = await offlinePack.importFromFile(asUri(archiveUri));
    syncAfterPackChange();
    return ok;
  });

  register('drawGraph.drawio.removeOfflinePack', async () => {
    await offlinePack.removePack();
    syncAfterPackChange();
  });

  // FP-4: SQL DDL / JSON -> ER or Mindmap Diagram Generator
  register(
    'drawGraph.generateFromData',
    async (
      uriOrTextArg?: unknown,
      formatArg?: unknown,
      destArg?: unknown,
    ): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      let rawText: string | undefined;
      let sourceKind: 'sql' | 'json' | undefined;
      let baseFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

      if (typeof uriOrTextArg === 'string' && uriOrTextArg.trim()) {
        rawText = uriOrTextArg;
      } else {
        const targetUri = asUri(uriOrTextArg) ?? vscode.window.activeTextEditor?.document.uri;
        const activeEd = vscode.window.activeTextEditor;
        if (
          activeEd &&
          !uriOrTextArg &&
          !activeEd.selection.isEmpty &&
          activeEd.document.getText(activeEd.selection).trim()
        ) {
          rawText = activeEd.document.getText(activeEd.selection);
          if (activeEd.document.uri.scheme === 'file') {
            baseFolder = vscode.Uri.joinPath(activeEd.document.uri, '..');
          }
        } else if (targetUri) {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          rawText = doc.getText();
          if (targetUri.scheme === 'file') {
            baseFolder = vscode.Uri.joinPath(targetUri, '..');
          }
          if (/\.sql$/i.test(targetUri.path) || doc.languageId === 'sql') {
            sourceKind = 'sql';
          } else if (/\.jsonc?$/i.test(targetUri.path) || doc.languageId.startsWith('json')) {
            sourceKind = 'json';
          }
        }
      }

      if (!rawText || !rawText.trim()) {
        rawText = await vscode.env.clipboard.readText();
      }
      if (!rawText || !rawText.trim()) {
        void vscode.window.showWarningMessage(t('Open a .sql / .json file or copy SQL/JSON text first.'));
        return undefined;
      }

      const trimmed = rawText.trim();
      if (!sourceKind) {
        sourceKind = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'sql';
      }

      const format = await promptDiagramOutputFormat(formatArg);
      if (!format) {
        return undefined;
      }

      let output: string;
      try {
        output =
          sourceKind === 'json' ? convertJsonToDiagram(trimmed, format) : convertSqlToDiagram(trimmed, format);
      } catch (err) {
        void vscode.window.showErrorMessage(t('Failed to parse {0}: {1}', sourceKind.toUpperCase(), (err as Error).message));
        return undefined;
      }

      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: baseFolder
              ? vscode.Uri.joinPath(baseFolder, sourceKind === 'sql' ? 'schema-er.drawio' : 'data-mindmap.drawio')
              : undefined,
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) {
          return undefined;
        }
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  // OpenAPI / Protobuf / Prisma Schema -> Diagram Generator
  register(
    'drawGraph.generateFromSpec',
    async (
      uriOrTextArg?: unknown,
      formatArg?: unknown,
      destArg?: unknown,
    ): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      let rawText: string | undefined;
      let specKind: 'openapi' | 'proto' | 'prisma' | undefined;
      let baseFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

      if (typeof uriOrTextArg === 'string' && uriOrTextArg.trim()) {
        rawText = uriOrTextArg;
      } else {
        const targetUri = asUri(uriOrTextArg) ?? vscode.window.activeTextEditor?.document.uri;
        if (targetUri) {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          rawText = doc.getText();
          if (targetUri.scheme === 'file') {
            baseFolder = vscode.Uri.joinPath(targetUri, '..');
          }
          if (/\.proto$/i.test(targetUri.path)) {
            specKind = 'proto';
          } else if (/\.prisma$/i.test(targetUri.path)) {
            specKind = 'prisma';
          } else if (/(?:openapi|swagger)/i.test(targetUri.path)) {
            specKind = 'openapi';
          }
        }
      }

      if (!rawText || !rawText.trim()) {
        void vscode.window.showWarningMessage(t('Open an OpenAPI, .proto, or .prisma file first.'));
        return undefined;
      }
      const trimmed = rawText.trim();
      if (!specKind) {
        if (/\b(?:syntax\s*=\s*"proto|service\s+\w+\s*\{|message\s+\w+\s*\{)/.test(trimmed)) {
          specKind = 'proto';
        } else if (/\bmodel\s+\w+\s*\{[\s\S]*?@id\b/.test(trimmed)) {
          specKind = 'prisma';
        } else {
          specKind = 'openapi';
        }
      }

      const format = await promptDiagramOutputFormat(formatArg);
      if (!format) {
        return undefined;
      }

      let output: string;
      try {
        output =
          specKind === 'proto'
            ? convertProtoToDiagram(trimmed, format)
            : specKind === 'prisma'
              ? convertPrismaToDiagram(trimmed, format)
              : convertOpenApiToDiagram(trimmed, format);
      } catch (err) {
        void vscode.window.showErrorMessage(t('Failed to parse {0}: {1}', specKind.toUpperCase(), (err as Error).message));
        return undefined;
      }

      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: baseFolder ? vscode.Uri.joinPath(baseFolder, `${specKind}-diagram.drawio`) : undefined,
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) return undefined;
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  // Docker Compose / GitHub Actions Workflow -> Topology Generator
  register(
    'drawGraph.generateInfraDiagram',
    async (
      uriOrTextArg?: unknown,
      formatArg?: unknown,
      destArg?: unknown,
    ): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      let rawText: string | undefined;
      let fileHint = '';
      let baseFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

      if (typeof uriOrTextArg === 'string' && uriOrTextArg.trim()) {
        rawText = uriOrTextArg;
      } else {
        const targetUri = asUri(uriOrTextArg) ?? vscode.window.activeTextEditor?.document.uri;
        if (targetUri) {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          rawText = doc.getText();
          fileHint = targetUri.path;
          if (targetUri.scheme === 'file') {
            baseFolder = vscode.Uri.joinPath(targetUri, '..');
          }
        }
      }

      if (!rawText || !rawText.trim()) {
        void vscode.window.showWarningMessage(t('Open a docker-compose.yml or GitHub Actions workflow file first.'));
        return undefined;
      }

      const format = await promptDiagramOutputFormat(formatArg);
      if (!format) {
        return undefined;
      }

      let output: string;
      try {
        output = convertInfraToDiagram(rawText.trim(), format, fileHint);
      } catch (err) {
        void vscode.window.showErrorMessage(t('Failed to parse {0}: {1}', 'YAML', (err as Error).message));
        return undefined;
      }

      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: baseFolder ? vscode.Uri.joinPath(baseFolder, 'infra-topology.drawio') : undefined,
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) return undefined;
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  // Broken Code-Link Auditor & Workspace Shape Library Scaffolder
  register('drawGraph.checkCodeLinks', async (interactiveArg?: unknown) => {
    return codeLinkMaintenance.auditWorkspace(interactiveArg !== false);
  });

  register('drawGraph.drawio.createWorkspaceLibrary', async (destArg?: unknown): Promise<vscode.Uri | undefined> => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder && !(destArg instanceof vscode.Uri)) {
      return undefined;
    }
    const dest = asUri(destArg) ?? vscode.Uri.joinPath(folder!, '.vscode', 'drawgraph-library.xml');
    try {
      await vscode.workspace.fs.stat(dest);
    } catch {
      await vscode.workspace.fs.writeFile(dest, Buffer.from(STARTER_WORKSPACE_LIBRARY_XML, 'utf8'));
    }
    await drawio.reloadWorkspaceLibraries();
    const doc = await vscode.workspace.openTextDocument(dest);
    await vscode.window.showTextDocument(doc);
    return dest;
  });

  // v0.6: Workspace Cross-Diagram Node Search
  register('drawGraph.searchDiagrams', async (queryArg?: unknown) => {
    if (typeof queryArg === 'string') {
      return searchWorkspaceDiagramNodes(queryArg);
    }
    await openDiagramSearchQuickPick(drawio, previews);
    return undefined;
  });

  // v0.6: Architecture Drift Detection (Codebase <-> Diagrams)
  register('drawGraph.checkArchitectureDrift', async (interactiveArg?: unknown) => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      return { undocumentedCodeItems: [], staleDiagramRefs: [], coveredCount: 0, totalCodeItems: 0, coveragePercent: 100 };
    }
    const [codeUris, diagramUris] = await Promise.all([
      vscode.workspace.findFiles(
        '**/*.{ts,tsx,js,jsx,py,java,go,rs,cs,cpp,hpp,dart}',
        '**/{node_modules,.git,dist,out,build,.vscode-test,test,tests,__tests__}/**',
        120,
      ),
      vscode.workspace.findFiles(
        '**/*.{drawio,dio,drawio.svg,mmd,mermaid,puml,plantuml,dot,gv,d2}',
        '**/{node_modules,.git,dist,out,build,.vscode-test}/**',
        80,
      ),
    ]);

    const codeItems: Array<{ name: string; relPath: string }> = [];
    for (const uri of codeUris) {
      const relPath = vscode.workspace.asRelativePath(uri, false);
      const base = path.basename(uri.path).replace(/\.[^.]+$/, '');
      if (base.length >= 3 && base !== 'index' && base !== 'main') {
        codeItems.push({ name: base, relPath });
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength <= 256 * 1024) {
          const syms = extractFallbackCodeSymbols(Buffer.from(bytes).toString('utf8'));
          for (const s of syms) {
            if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct') {
              codeItems.push({ name: s.name, relPath });
            }
          }
        }
      } catch {
        // Skip unreadable source
      }
    }

    const diagramTokensByFile = new Map<string, Set<string>>();
    for (const uri of diagramUris) {
      try {
        const relPath = vscode.workspace.asRelativePath(uri, false);
        const text = /\.(?:drawio|dio)/i.test(uri.path)
          ? ((await readDrawioXmlFromUri(uri)) ?? '')
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (text) {
          const tokens = new Set<string>();
          for (const m of text.matchAll(/#?[A-Za-z0-9_./-]{3,}/g)) {
            tokens.add(m[0]);
          }
          diagramTokensByFile.set(relPath, tokens);
        }
      } catch {
        // Skip unreadable diagram
      }
    }

    const report = computeArchitectureDrift(
      codeItems,
      diagramTokensByFile,
      new Set(codeUris.map((u) => vscode.workspace.asRelativePath(u, false))),
    );
    const coveragePercent =
      report.totalCodeItems === 0 ? 100 : Math.round((report.coveredCount / report.totalCodeItems) * 100);

    if (interactiveArg === false) {
      return { ...report, coveragePercent };
    }

    const items: Array<vscode.QuickPickItem & { action?: () => Thenable<unknown> | Promise<unknown> }> = [];
    if (report.undocumentedCodeItems.length > 0) {
      items.push({
        label: `$(sparkle) ${t('Sync Missing Nodes with AI ({0} undocumented)', report.undocumentedCodeItems.length)}`,
        description: `${t('Coverage')}: ${coveragePercent}%`,
        action: () =>
          aiStudio.openStudio({
            mode: 'modify',
            initialPrompt: `Add these undocumented codebase modules/classes into the architecture diagram with clean groupings and edges: ${report.undocumentedCodeItems
              .slice(0, 18)
              .map((u) => `${u.name} (${u.relPath})`)
              .join(', ')}`,
          }),
      });
    }
    for (const s of report.staleDiagramRefs.slice(0, 30)) {
      items.push({
        label: `$(warning) ${t('Stale reference')}: ${s.ref}`,
        description: s.diagramPath,
        action: async () => {
          const target = vscode.Uri.joinPath(folder, s.diagramPath);
          const doc = await vscode.workspace.openTextDocument(target);
          await vscode.window.showTextDocument(doc);
        },
      });
    }
    for (const u of report.undocumentedCodeItems.slice(0, 40)) {
      items.push({
        label: `$(symbol-class) ${u.name}`,
        description: `${t('Not in any diagram')} · ${u.relPath}`,
        action: async () => {
          const target = vscode.Uri.joinPath(folder, u.relPath);
          const doc = await vscode.workspace.openTextDocument(target);
          await vscode.window.showTextDocument(doc);
        },
      });
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        t('Architecture diagrams are in sync with the codebase ({0}% coverage).', coveragePercent),
      );
      return { ...report, coveragePercent };
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: t(
        'Architecture Drift: {0}% covered · {1} undocumented · {2} stale refs',
        coveragePercent,
        report.undocumentedCodeItems.length,
        report.staleDiagramRefs.length,
      ),
    });
    if (picked?.action) {
      await picked.action();
    }
    return { ...report, coveragePercent };
  });

  // v0.6: Git Diff / PR Architecture Impact Diagram
  register(
    'drawGraph.generatePrImpactDiagram',
    async (baseRefArg?: unknown, formatArg?: unknown, destArg?: unknown): Promise<vscode.TextDocument | vscode.Uri | undefined> => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(t('Git PR Impact Diagram requires a trusted workspace.'));
        return undefined;
      }
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder || wsFolder.uri.scheme !== 'file') {
        return undefined;
      }

      let repoRoot: string;
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], {
          cwd: wsFolder.uri.fsPath,
        });
        repoRoot = stdout.trim();
      } catch {
        void vscode.window.showWarningMessage(t('Current workspace is not inside a Git repository.'));
        return undefined;
      }

      let baseRef = typeof baseRefArg === 'string' && baseRefArg.trim() ? baseRefArg.trim() : undefined;
      if (!baseRef) {
        const picked = await vscode.window.showQuickPick(
          [
            { label: '$(git-commit) HEAD', description: t('Uncommitted changes vs HEAD'), ref: 'HEAD' },
            { label: '$(git-commit) HEAD~1', description: t('Previous commit (HEAD~1)'), ref: 'HEAD~1' },
            { label: '$(git-branch) main', description: t('Compare against main branch'), ref: 'main' },
          ],
          { placeHolder: t('Select Git base ref for PR impact analysis') },
        );
        if (!picked) return undefined;
        baseRef = picked.ref;
      }

      let format: 'mermaid' | 'drawio' | 'd2';
      if (formatArg === 'mermaid' || formatArg === 'drawio' || formatArg === 'd2') {
        format = formatArg;
      } else {
        const pickedFmt = await vscode.window.showQuickPick(
          [
            { label: '$(git-merge) Mermaid', fmt: 'mermaid' as const },
            { label: '$(layers) D2 (.d2)', fmt: 'd2' as const },
            { label: '$(layout) Draw.io (.drawio)', fmt: 'drawio' as const },
          ],
          { placeHolder: t('Select target diagram format') },
        );
        if (!pickedFmt) return undefined;
        format = pickedFmt.fmt;
      }

      const changedFiles: ChangedFileEntry[] = [];
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'diff', '--name-status', baseRef], {
          cwd: repoRoot,
        });
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^([AMDCR])\d*\t(.+?)(?:\t(.+))?$/.exec(line.trim());
          if (!m) continue;
          const status = (m[1] === 'C' ? 'A' : m[1]) as ChangedFileEntry['status'];
          const relPath = (m[3] || m[2]).trim().split(path.sep).join('/');
          changedFiles.push({ status, relPath });
        }
      } catch {
        // Ignore invalid ref
      }
      try {
        const { stdout: untracked } = await execFileAsync(
          'git',
          ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard'],
          { cwd: repoRoot },
        );
        for (const ln of untracked.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          const rel = ln.split(path.sep).join('/');
          if (!changedFiles.some((c) => c.relPath === rel)) {
            changedFiles.push({ status: 'A', relPath: rel });
          }
        }
      } catch {
        // Ignore
      }

      if (changedFiles.length === 0) {
        if (!baseRefArg) {
          void vscode.window.showInformationMessage(t('No changed files found compared to {0}.', baseRef));
        }
        return undefined;
      }

      const codeUris = await vscode.workspace.findFiles(
        '**/*.{ts,tsx,js,jsx,mjs,cjs,py}',
        '**/{node_modules,.git,dist,out,build,.vscode-test}/**',
        160,
      );
      const knownRel = new Map<string, string>();
      for (const f of codeUris) {
        const rel = path.relative(repoRoot, f.fsPath).split(path.sep).join('/');
        knownRel.set(rel, rel);
        knownRel.set(rel.replace(/\.[^.]+$/, ''), rel);
      }
      const edges: ModuleDependencyEdge[] = [];
      for (const f of codeUris) {
        const fromRel = path.relative(repoRoot, f.fsPath).split(path.sep).join('/');
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
          for (const spec of extractLocalImports(text)) {
            const resolvedRel = path
              .relative(repoRoot, path.resolve(path.dirname(f.fsPath), spec))
              .split(path.sep)
              .join('/');
            const toRel = knownRel.get(resolvedRel) ?? knownRel.get(`${resolvedRel}/index`);
            if (toRel && toRel !== fromRel) {
              edges.push({ from: fromRel, to: toRel });
            }
          }
        } catch {
          // Skip unreadable file
        }
      }

      const graph = computePrImpactGraph(baseRef, changedFiles, edges);
      const output = renderPrImpactDiagram(graph, format);

      if (format === 'drawio') {
        const dest =
          asUri(destArg) ??
          (await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(wsFolder.uri, 'pr-impact.drawio'),
            filters: { 'draw.io': ['drawio'] },
          }));
        if (!dest) return undefined;
        await vscode.workspace.fs.writeFile(dest, Buffer.from(output, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', dest, DrawioEditorProvider.viewType);
        return dest;
      }

      const doc = await vscode.workspace.openTextDocument({ language: format, content: output });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      await previews.open(doc.uri, true);
      return doc;
    },
  );

  // v0.6: Markdown One-Click Publish Compiler
  register(
    'drawGraph.markdown.compilePublish',
    async (uriArg?: unknown, formatArg?: unknown) => {
      const targetUri = asUri(uriArg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || !/\.md$/i.test(targetUri.path)) {
        void vscode.window.showWarningMessage(t('Open a Markdown (.md) file first.'));
        return undefined;
      }
      let format: 'svg' | 'png' = 'svg';
      if (formatArg === 'svg' || formatArg === 'png') {
        format = formatArg;
      } else {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'SVG (.svg)', detail: t('Crisp scalable vector assets (recommended for web/GitHub)'), fmt: 'svg' as const },
            { label: 'PNG (.png)', detail: t('Universal raster images (recommended for Confluence/Word/WeChat)'), fmt: 'png' as const },
          ],
          { placeHolder: t('Select static asset format for published Markdown') },
        );
        if (!picked) return undefined;
        format = picked.fmt;
      }
      const result = await compileMarkdownForPublish(targetUri, previews, format);
      const doc = await vscode.workspace.openTextDocument(result.outputMarkdownUri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
      void vscode.window.setStatusBarMessage(
        t('Published {0} with {1} static diagram assets', path.basename(result.outputMarkdownUri.path), result.assetUris.length),
        4000,
      );
      return result;
    },
  );

  // v0.6: Diagrams-as-Code CI Workflow Scaffolder
  register('drawGraph.ci.createWorkflow', async (baseDirArg?: unknown) => {
    const folder = asUri(baseDirArg) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      return undefined;
    }
    const wfUri = vscode.Uri.joinPath(folder, '.github', 'workflows', 'drawgraph-check.yml');
    const scriptUri = vscode.Uri.joinPath(folder, '.github', 'scripts', 'drawgraph-ci-check.mjs');
    await vscode.workspace.fs.writeFile(wfUri, Buffer.from(buildDrawGraphCiWorkflowYaml(), 'utf8'));
    await vscode.workspace.fs.writeFile(scriptUri, Buffer.from(buildDrawGraphCiScript(), 'utf8'));
    const doc = await vscode.workspace.openTextDocument(wfUri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.setStatusBarMessage(t('Created DrawGraph CI workflow & validation script'), 3500);
    return { workflowUri: wfUri, scriptUri };
  });
}
