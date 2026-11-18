import * as path from 'node:path';
import * as vscode from 'vscode';
import { navigateToCodeTarget } from '../codeLinks';
import { convertMermaidToPlantUml, convertPlantUmlToMermaid } from '../converters/diagramConverters';
import { extractResourceUri, type VisualDiffManager } from '../diff/visualDiffPanel';
import { DrawioEditorProvider } from '../drawio/drawioEditorProvider';
import { replaceEmbeddedDiagram } from '../drawio/drawioSvg';
import { convertMermaidToDrawioXml } from '../drawio/mermaidToDrawio';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import type { OfflinePackManager } from '../drawio/offlinePackManager';
import type { DiagramExplorerProvider } from '../explorer/diagramTreeView';
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
import { t } from '../l10n';
import { findMarkdownDiagramFences } from '../language/symbols';
import { pickBlock, splitDiagrams } from '../plantuml/encoder';
import { diagramKind, type PreviewManager } from '../preview/previewManager';
import type { SettingsPanelManager } from '../settingsPanel';
import { saveBytes, withExtension } from '../util';
import { activeTabContext } from './coreCommands';

export interface AdvancedCommandDeps {
  context: vscode.ExtensionContext;
  drawio: DrawioEditorProvider;
  previews: PreviewManager;
  visualDiff: VisualDiffManager;
  offlinePack: OfflinePackManager;
  explorer: DiagramExplorerProvider;
  settingsPanel: SettingsPanelManager;
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
  offlinePack,
  explorer,
  settingsPanel,
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
    if (dtypeArg === 'mermaid' || dtypeArg === 'plantuml') {
      if (doc.languageId === 'markdown') {
        await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
      } else {
        await previews.open(uri, true, safeLine);
      }
    }
  });

  // F1: Git Visual Diagram Diff
  register('drawGraph.visualDiff', async (arg?: unknown, refArg?: unknown) => {
    const target = extractResourceUri(arg) ?? activeTabContext().uri;
    if (!target) {
      void vscode.window.showWarningMessage(t('Open or select a diagram file first.'));
      return false;
    }
    const gitRef = typeof refArg === 'string' && refArg.trim() ? refArg.trim() : 'HEAD';
    return visualDiff.openGitDiff(target, gitRef);
  });

  register('drawGraph.visualDiffFiles', async (leftArg?: unknown, rightArg?: unknown) => {
    return visualDiff.openFileComparison(asUri(leftArg), asUri(rightArg));
  });

  // F3: Universal PDF Export
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
        : await previews.renderPlantUmlBytes(splitDiagrams(doc.getText())[0]?.source ?? doc.getText(), 'pdf', baseDir);

    if (dest) {
      await vscode.workspace.fs.writeFile(dest, pdfBytes);
      return dest;
    }
    await saveBytes(withExtension(targetUri, '.pdf'), pdfBytes, { PDF: ['pdf'] });
    return withExtension(targetUri, '.pdf');
  });

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
}
