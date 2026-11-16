import * as vscode from 'vscode';
import { t } from '../l10n';
import { splitDiagrams } from '../plantuml/encoder';
import { config } from '../util';
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
  private readonly closeSub: vscode.Disposable;

  constructor() {
    this.closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
      this.collection.delete(doc.uri);
    });
  }

  setError(document: vscode.TextDocument, zeroBasedLine: number, message: string): void {
    const safeLine = Math.max(0, Math.min(zeroBasedLine, Math.max(0, document.lineCount - 1)));
    const lineText = document.lineAt(safeLine);
    const range = lineText.range.isEmpty ? new vscode.Range(safeLine, 0, safeLine, 1) : lineText.range;
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'DrawGraph';
    this.collection.set(document.uri, [diagnostic]);
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.closeSub.dispose();
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
        );
      }
      return lenses;
    }

    if (document.languageId === 'markdown') {
      for (const fence of findMarkdownDiagramFences(text)) {
        const range = new vscode.Range(fence.startLine, 0, fence.startLine, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(open-preview) ${t('Preview')}`,
            command: 'markdown.showPreviewToSide',
            arguments: [document.uri],
          }),
        );
        if (fence.kind === 'mermaid' && fence.content.trim().length > 0) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: t('Open in Draw.io'),
              command: 'drawGraph.mermaid.openInDrawio',
              arguments: [document.uri, fence.content],
            }),
          );
        }
      }
    }

    return lenses;
  }
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): DiagramDiagnostics {
  const diagnostics = new DiagramDiagnostics();
  const symbolProvider = new DiagramSymbolProvider();
  const codeLensProvider = new DiagramCodeLensProvider();
  const completionProvider = new DiagramCompletionProvider();
  const formattingProvider = new DiagramFormattingProvider();

  context.subscriptions.push(
    diagnostics,
    codeLensProvider,
    vscode.languages.registerDocumentSymbolProvider([{ language: 'mermaid' }, { language: 'plantuml' }], symbolProvider),
    vscode.languages.registerCodeLensProvider(
      [{ language: 'mermaid' }, { language: 'plantuml' }, { language: 'markdown' }],
      codeLensProvider,
    ),
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'mermaid' }, { language: 'plantuml' }],
      completionProvider,
      '!',
      '@',
      '{',
      ' ',
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: 'mermaid' }, { language: 'plantuml' }],
      formattingProvider,
    ),
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
