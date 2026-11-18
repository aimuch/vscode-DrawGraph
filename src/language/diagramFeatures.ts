import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import { t } from '../l10n';
import { splitDiagrams } from '../plantuml/encoder';
import { config } from '../util';
import {
  C4_MACRO_SIGNATURES,
  computeC4SignatureHelp,
  computeDiagramQuickFixes,
  computeDiagramRenameRanges,
  extractDiagramDocumentLinks,
  extractHexColors,
  formatHexColor,
  validateDiagramSyntaxStatic,
} from './advancedFeatures';
import {
  collectMermaidCompletions,
  collectPlantUmlCompletions,
  formatMermaidSource,
  formatPlantUmlSource,
  type CompletionCandidate,
} from './completionsAndFormat';
import {
  findMarkdownDiagramFences,
  parseMermaidOutline,
  parsePlantUmlOutline,
  type OutlineKind,
  type OutlineNode,
} from './symbols';

export class DiagramDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('drawGraph');
  private readonly subs: vscode.Disposable[] = [];
  private readonly liveErrorUris = new Set<string>();
  private readonly lintTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.subs.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        const tmr = this.lintTimers.get(key);
        if (tmr) {
          clearTimeout(tmr);
          this.lintTimers.delete(key);
        }
        this.liveErrorUris.delete(key);
        this.collection.delete(doc.uri);
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.scheduleStaticLint(doc, 60)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleStaticLint(e.document, 250)),
    );
    for (const doc of vscode.workspace.textDocuments) {
      this.scheduleStaticLint(doc, 60);
    }
  }

  private scheduleStaticLint(document: vscode.TextDocument, delayMs: number): void {
    if (document.languageId !== 'mermaid' && document.languageId !== 'plantuml') {
      return;
    }
    const key = document.uri.toString();
    const prev = this.lintTimers.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    this.lintTimers.set(
      key,
      setTimeout(() => {
        this.lintTimers.delete(key);
        if (this.liveErrorUris.has(key)) {
          return;
        }
        const issues = validateDiagramSyntaxStatic(document.getText(), document.languageId as 'mermaid' | 'plantuml');
        if (issues.length === 0) {
          this.collection.delete(document.uri);
          return;
        }
        const diags = issues.map((iss) => {
          const safeLine = Math.max(0, Math.min(iss.line, Math.max(0, document.lineCount - 1)));
          const lineText = document.lineAt(safeLine);
          const range = lineText.range.isEmpty ? new vscode.Range(safeLine, 0, safeLine, 1) : lineText.range;
          const d = new vscode.Diagnostic(
            range,
            iss.message,
            iss.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
          );
          d.source = 'DrawGraph';
          return d;
        });
        this.collection.set(document.uri, diags);
      }, delayMs),
    );
  }

  setError(document: vscode.TextDocument, zeroBasedLine: number, message: string): void {
    const key = document.uri.toString();
    this.liveErrorUris.add(key);
    const pending = this.lintTimers.get(key);
    if (pending) {
      clearTimeout(pending);
      this.lintTimers.delete(key);
    }
    const safeLine = Math.max(0, Math.min(zeroBasedLine, Math.max(0, document.lineCount - 1)));
    const lineText = document.lineAt(safeLine);
    const range = lineText.range.isEmpty ? new vscode.Range(safeLine, 0, safeLine, 1) : lineText.range;
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'DrawGraph';
    this.collection.set(document.uri, [diagnostic]);
  }

  clear(uri: vscode.Uri): void {
    const key = uri.toString();
    this.liveErrorUris.delete(key);
    const pending = this.lintTimers.get(key);
    if (pending) {
      clearTimeout(pending);
      this.lintTimers.delete(key);
    }
    this.collection.delete(uri);
  }

  dispose(): void {
    for (const tmr of this.lintTimers.values()) {
      clearTimeout(tmr);
    }
    this.lintTimers.clear();
    this.subs.forEach((s) => s.dispose());
    this.collection.dispose();
  }
}

function toSymbolKind(kind: OutlineKind): vscode.SymbolKind {
  switch (kind) {
    case 'diagram':
      return vscode.SymbolKind.Module;
    case 'container':
      return vscode.SymbolKind.Namespace;
    case 'class':
      return vscode.SymbolKind.Class;
    case 'interface':
      return vscode.SymbolKind.Interface;
    case 'enum':
      return vscode.SymbolKind.Enum;
    case 'actor':
    case 'participant':
      return vscode.SymbolKind.Object;
    case 'state':
      return vscode.SymbolKind.Event;
    case 'section':
      return vscode.SymbolKind.Package;
  }
}

function toDocumentSymbol(document: vscode.TextDocument, node: OutlineNode): vscode.DocumentSymbol {
  const start = Math.max(0, Math.min(node.startLine, document.lineCount - 1));
  const end = Math.max(start, Math.min(node.endLine, document.lineCount - 1));
  const sel = Math.max(start, Math.min(node.selectionLine, end));
  const fullRange = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  const selRange = document.lineAt(sel).range;
  const symbol = new vscode.DocumentSymbol(node.name, node.detail ?? '', toSymbolKind(node.kind), fullRange, selRange);
  symbol.children = node.children.map((c) => toDocumentSymbol(document, c));
  return symbol;
}

class DiagramSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    if (document.lineCount === 0) {
      return [];
    }
    const text = document.getText();
    const nodes = document.languageId === 'plantuml' ? parsePlantUmlOutline(text) : parseMermaidOutline(text);
    return nodes.map((n) => toDocumentSymbol(document, n));
  }
}

class DiagramCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!config().get<boolean>('editor.codeLens', true)) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    if (document.languageId === 'plantuml') {
      const blocks = splitDiagrams(text);
      blocks.forEach((block, index) => {
        const range = new vscode.Range(block.startLine, 0, block.startLine, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(open-preview) ${t('Preview')}`,
            command: 'drawGraph.preview.openAtLine',
            arguments: [document.uri, block.startLine],
          }),
          new vscode.CodeLens(range, {
            title: t('Export as SVG'),
            command: 'drawGraph.plantuml.exportBlock',
            arguments: [document.uri, index, 'svg'],
          }),
          new vscode.CodeLens(range, {
            title: t('Export as PNG'),
            command: 'drawGraph.plantuml.exportBlock',
            arguments: [document.uri, index, 'png'],
          }),
          new vscode.CodeLens(range, {
            title: t('Convert to Mermaid'),
            command: 'drawGraph.convert.plantumlToMermaid',
            arguments: [document.uri],
          }),
        );
      });
      return lenses;
    }

    if (document.languageId === 'mermaid') {
      const firstLine = text.split(/\r?\n/).findIndex((l) => {
        const lineText = l.trim();
        return lineText.length > 0 && !lineText.startsWith('%%');
      });
      if (firstLine >= 0) {
        const range = new vscode.Range(firstLine, 0, firstLine, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(open-preview) ${t('Preview')}`,
            command: 'drawGraph.preview.openToSide',
            arguments: [document.uri],
          }),
          new vscode.CodeLens(range, {
            title: t('Open in Draw.io'),
            command: 'drawGraph.mermaid.openInDrawio',
            arguments: [document.uri],
          }),
          new vscode.CodeLens(range, {
            title: t('Convert to PlantUML'),
            command: 'drawGraph.convert.mermaidToPlantuml',
            arguments: [document.uri],
          }),
        );
      }
      return lenses;
    }

    if (document.languageId === 'markdown') {
      const fences = findMarkdownDiagramFences(text);
      fences.forEach((fence, idx) => {
        const range = new vscode.Range(fence.startLine, 0, fence.startLine, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(open-preview) ${t('Preview')}`,
            command: 'markdown.showPreviewToSide',
            arguments: [document.uri],
          }),
        );
        if (fence.content.trim().length > 0) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: t('Export as SVG'),
              command: 'drawGraph.markdown.exportFence',
              arguments: [document.uri, idx, 'svg'],
            }),
            new vscode.CodeLens(range, {
              title: t('Export as PNG'),
              command: 'drawGraph.markdown.exportFence',
              arguments: [document.uri, idx, 'png'],
            }),
          );
          if (fence.kind === 'mermaid') {
            lenses.push(
              new vscode.CodeLens(range, {
                title: t('Open in Draw.io'),
                command: 'drawGraph.mermaid.openInDrawio',
                arguments: [document.uri, fence.content],
              }),
              new vscode.CodeLens(range, {
                title: t('Extract to .drawio.svg'),
                command: 'drawGraph.markdown.extractToDrawioSvg',
                arguments: [document.uri, idx],
              }),
            );
          }
        }
      });
    }

    return lenses;
  }
}

class DiagramDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const kind = document.languageId === 'plantuml' ? 'plantuml' : 'mermaid';
    const rawLinks = extractDiagramDocumentLinks(document.getText(), kind);
    const out: vscode.DocumentLink[] = [];

    for (const item of rawLinks) {
      const range = new vscode.Range(item.line, item.startCol, item.line, item.endCol);
      let targetUri: vscode.Uri | undefined;
      if (item.kind === 'url') {
        try {
          targetUri = vscode.Uri.parse(item.target);
        } catch {
          targetUri = undefined;
        }
      } else if (item.kind === 'include' && document.uri.scheme === 'file') {
        const resolved = path.resolve(path.dirname(document.uri.fsPath), item.target);
        targetUri = vscode.Uri.file(resolved);
      } else {
        const args = encodeURIComponent(JSON.stringify([item.target, document.uri.toString()]));
        targetUri = vscode.Uri.parse(`command:drawGraph.openCodeTarget?${args}`);
      }
      if (targetUri) {
        const link = new vscode.DocumentLink(range, targetUri);
        link.tooltip = item.target;
        out.push(link);
      }
    }
    return out;
  }
}

class DiagramHoverProvider implements vscode.HoverProvider {
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const lineText = document.lineAt(position.line).text;

    if (document.languageId === 'plantuml') {
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (wordRange) {
        const word = document.getText(wordRange);
        const baseWord = word.replace(/_(?:Down|Up|Left|Right|D|U|L|R|Back|Neighbor)$/, '');
        const c4 = C4_MACRO_SIGNATURES.find((m) => m.name === word || m.name === baseWord);
        if (c4) {
          const md = new vscode.MarkdownString();
          md.appendCodeblock(c4.signature, 'plantuml');
          md.appendMarkdown(`${c4.documentation}\n\n`);
          for (const p of c4.parameters) {
            md.appendMarkdown(`- \`${p.label}\` — ${p.doc}\n`);
          }
          return new vscode.Hover(md, wordRange);
        }
      }
    }

    // Hover thumbnail preview for local .drawio / .svg / .png diagram references
    if (document.uri.scheme === 'file') {
      const pathRe = /(?:\(|"|'|=\s*)([A-Za-z0-9_./-]+\.(?:drawio\.svg|drawio\.png|dio\.svg|dio\.png|drawio|dio|svg|png))(?:\)|"|'|\s|$)/g;
      let m: RegExpExecArray | null;
      while ((m = pathRe.exec(lineText)) !== null) {
        const rel = m[1];
        const start = m.index + m[0].indexOf(rel);
        const end = start + rel.length;
        if (position.character >= start && position.character <= end) {
          const filePath = path.resolve(path.dirname(document.uri.fsPath), rel);
          try {
            const fileUri = vscode.Uri.file(filePath);
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            if (bytes.byteLength > 2 * 1024 * 1024) {
              return undefined;
            }
            let dataUri: string;
            if (/\.(?:drawio|dio)$/i.test(rel)) {
              const svg = renderMxfileToPreviewSvg(Buffer.from(bytes).toString('utf8'));
              dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
            } else if (/\.svg$/i.test(rel)) {
              dataUri = `data:image/svg+xml;base64,${Buffer.from(bytes).toString('base64')}`;
            } else {
              dataUri = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
            }
            const md = new vscode.MarkdownString(`**${path.basename(rel)}**\n\n![preview](${dataUri})`);
            md.isTrusted = false;
            return new vscode.Hover(md, new vscode.Range(position.line, start, position.line, end));
          } catch {
            return undefined;
          }
        }
      }
    }

    return undefined;
  }
}

class DiagramRenameProvider implements vscode.RenameProvider {
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Range | { range: vscode.Range; placeholder: string } {
    const kind = document.languageId === 'plantuml' ? 'plantuml' : 'mermaid';
    const res = computeDiagramRenameRanges(document.getText(), kind, position.line, position.character);
    if (!res) {
      throw new Error(t('Cannot rename this element.'));
    }
    const active = res.ranges.find(
      (r) => r.line === position.line && position.character >= r.startCol && position.character <= r.endCol,
    );
    const r = active ?? res.ranges[0];
    return {
      range: new vscode.Range(r.line, r.startCol, r.line, r.endCol),
      placeholder: res.oldName,
    };
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): vscode.WorkspaceEdit | undefined {
    const kind = document.languageId === 'plantuml' ? 'plantuml' : 'mermaid';
    const res = computeDiagramRenameRanges(document.getText(), kind, position.line, position.character);
    if (!res) {
      return undefined;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const r of res.ranges) {
      edit.replace(document.uri, new vscode.Range(r.line, r.startCol, r.line, r.endCol), newName);
    }
    return edit;
  }
}

class DiagramColorProvider implements vscode.DocumentColorProvider {
  provideDocumentColors(document: vscode.TextDocument): vscode.ColorInformation[] {
    return extractHexColors(document.getText()).map(
      (c) =>
        new vscode.ColorInformation(
          new vscode.Range(c.line, c.startCol, c.line, c.endCol),
          new vscode.Color(c.r, c.g, c.b, c.a),
        ),
    );
  }

  provideColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
    const hex = formatHexColor(color.red, color.green, color.blue, color.alpha);
    return [new vscode.ColorPresentation(hex)];
  }
}

class DiagramCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const kind = document.languageId === 'plantuml' ? 'plantuml' : 'mermaid';
    const diagLine = context.diagnostics[0]?.range.start.line ?? range.start.line;
    const fixes = computeDiagramQuickFixes(document.getText(), kind, diagLine);

    return fixes.map((fix) => {
      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      const edit = new vscode.WorkspaceEdit();
      if (fix.kind === 'prepend') {
        edit.insert(document.uri, new vscode.Position(0, 0), fix.newText);
        if (kind === 'plantuml' && fix.title.includes('@enduml')) {
          edit.insert(document.uri, new vscode.Position(document.lineCount, 0), '\n@enduml\n');
        }
      } else if (fix.kind === 'append') {
        const lastLine = Math.max(0, document.lineCount - 1);
        edit.insert(document.uri, new vscode.Position(lastLine, document.lineAt(lastLine).text.length), fix.newText);
      } else if (fix.kind === 'replace_line' && fix.line !== undefined) {
        edit.replace(document.uri, document.lineAt(fix.line).range, fix.newText);
      }
      action.edit = edit;
      action.isPreferred = true;
      return action;
    });
  }
}

class PlantUmlSignatureHelpProvider implements vscode.SignatureHelpProvider {
  provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const res = computeC4SignatureHelp(linePrefix);
    if (!res) {
      return undefined;
    }
    const sig = new vscode.SignatureInformation(res.macro.signature, res.macro.documentation);
    sig.parameters = res.macro.parameters.map((p) => new vscode.ParameterInformation(p.label, p.doc));
    const help = new vscode.SignatureHelp();
    help.signatures = [sig];
    help.activeSignature = 0;
    help.activeParameter = res.activeParameter;
    return help;
  }
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): DiagramDiagnostics {
  const diagnostics = new DiagramDiagnostics();
  const symbolProvider = new DiagramSymbolProvider();
  const codeLensProvider = new DiagramCodeLensProvider();
  const completionProvider = new DiagramCompletionProvider();
  const formattingProvider = new DiagramFormattingProvider();
  const documentLinkProvider = new DiagramDocumentLinkProvider();
  const hoverProvider = new DiagramHoverProvider();
  const renameProvider = new DiagramRenameProvider();
  const colorProvider = new DiagramColorProvider();
  const codeActionProvider = new DiagramCodeActionProvider();
  const signatureHelpProvider = new PlantUmlSignatureHelpProvider();

  const diagramSelector: vscode.DocumentSelector = [{ language: 'mermaid' }, { language: 'plantuml' }];
  const withMarkdownSelector: vscode.DocumentSelector = [
    { language: 'mermaid' },
    { language: 'plantuml' },
    { language: 'markdown' },
  ];

  context.subscriptions.push(
    diagnostics,
    codeLensProvider,
    vscode.languages.registerDocumentSymbolProvider(diagramSelector, symbolProvider),
    vscode.languages.registerCodeLensProvider(withMarkdownSelector, codeLensProvider),
    vscode.languages.registerCompletionItemProvider(diagramSelector, completionProvider, '!', '@', '{', '<', ' '),
    vscode.languages.registerDocumentFormattingEditProvider(diagramSelector, formattingProvider),
    vscode.languages.registerDocumentLinkProvider(diagramSelector, documentLinkProvider),
    vscode.languages.registerHoverProvider(withMarkdownSelector, hoverProvider),
    vscode.languages.registerRenameProvider(diagramSelector, renameProvider),
    vscode.languages.registerColorProvider(diagramSelector, colorProvider),
    vscode.languages.registerCodeActionsProvider(diagramSelector, codeActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerSignatureHelpProvider({ language: 'plantuml' }, signatureHelpProvider, '(', ','),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('drawGraph.editor.codeLens') || e.affectsConfiguration('drawGraph.language')) {
        codeLensProvider.refresh();
      }
    }),
  );

  return diagnostics;
}

function toCompletionKind(kind: CompletionCandidate['kind']): vscode.CompletionItemKind {
  switch (kind) {
    case 'keyword':
      return vscode.CompletionItemKind.Keyword;
    case 'theme':
      return vscode.CompletionItemKind.Color;
    case 'directive':
      return vscode.CompletionItemKind.Module;
    case 'property':
      return vscode.CompletionItemKind.Property;
    case 'identifier':
      return vscode.CompletionItemKind.Variable;
  }
}

class DiagramCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const fullText = document.getText();
    const candidates =
      document.languageId === 'plantuml'
        ? collectPlantUmlCompletions(fullText, linePrefix)
        : collectMermaidCompletions(fullText, linePrefix);

    return candidates.map((c) => {
      const item = new vscode.CompletionItem(c.label, toCompletionKind(c.kind));
      if (c.insertText) {
        item.insertText = c.insertText;
      }
      if (c.detail) {
        item.detail = c.detail;
      }
      return item;
    });
  }
}

class DiagramFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const original = document.getText();
    if (!original.trim()) {
      return [];
    }
    const indent = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
    const formatted =
      document.languageId === 'plantuml'
        ? formatPlantUmlSource(original, indent)
        : formatMermaidSource(original, indent);
    if (formatted === original) {
      return [];
    }
    const fullRange = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }
}
