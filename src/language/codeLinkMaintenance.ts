// VS Code host integration for:
// 1. Broken Code-Link auditing, Quick Fixes, and refactor-aware `onDidRenameFiles` path sync
// 2. Live Editor Cursor & Debugger Stack -> Diagram node highlighting ("Live Architecture Map")

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { computeMinimalTextChange } from '../drawio/minimalEdit';
import { readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { t } from '../l10n';
import { config } from '../util';
import {
  collectLocalFileLinksInDrawioXml,
  collectLocalFileLinksInTextDiagram,
  rewriteRenamedPathsInText,
} from './codeLinkMaintenanceCore';

export const BROKEN_LINK_DIAGNOSTIC_CODE = 'broken-code-link';

const SYNCABLE_DIAGRAM_GLOB = '**/*.{drawio,dio,drawio.xml,dio.xml,drawio.svg,dio.svg,mmd,mermaid,puml,plantuml,pu,iuml,wsd,md}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';

function fileExistsOnDisk(docFsPath: string, cleanRel: string, wsRoot?: string): boolean {
  const docCandidate = path.resolve(path.dirname(docFsPath), cleanRel);
  if (fs.existsSync(docCandidate)) {
    return true;
  }
  if (wsRoot) {
    const wsCandidate = path.resolve(wsRoot, cleanRel);
    if (fs.existsSync(wsCandidate)) {
      return true;
    }
  }
  return false;
}

async function fileExistsAsync(docFsPath: string, cleanRel: string, wsRoot?: string): Promise<boolean> {
  const docCandidate = vscode.Uri.file(path.resolve(path.dirname(docFsPath), cleanRel));
  try {
    await vscode.workspace.fs.stat(docCandidate);
    return true;
  } catch {
    // Try workspace root fallback
  }
  if (wsRoot) {
    const wsCandidate = vscode.Uri.file(path.resolve(wsRoot, cleanRel));
    try {
      await vscode.workspace.fs.stat(wsCandidate);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function collectBrokenLinkDiagnosticsForDocumentAsync(
  document: vscode.TextDocument,
): Promise<vscode.Diagnostic[]> {
  if (document.uri.scheme !== 'file') {
    return [];
  }
  if (document.languageId !== 'mermaid' && document.languageId !== 'plantuml') {
    return [];
  }
  if (!config().get<boolean>('codeLinks.checkBrokenLinks', true)) {
    return [];
  }
  const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  const wsRoot = wsFolder?.uri.fsPath;
  const links = collectLocalFileLinksInTextDiagram(
    document.getText(),
    document.languageId as 'mermaid' | 'plantuml',
    document.uri.fsPath,
    wsRoot,
  );
  if (links.length === 0) {
    return [];
  }

  const checks = await Promise.all(
    links.map(async (lk) => ({
      lk,
      exists: await fileExistsAsync(document.uri.fsPath, lk.cleanRelativePath, wsRoot),
    })),
  );

  const diags: vscode.Diagnostic[] = [];
  for (const { lk, exists } of checks) {
    if (!exists) {
      const range = new vscode.Range(lk.line, lk.startCol, lk.line, lk.endCol);
      const d = new vscode.Diagnostic(
        range,
        t('Broken diagram file link: "{0}" does not exist in workspace.', lk.cleanRelativePath),
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'DrawGraph';
      d.code = BROKEN_LINK_DIAGNOSTIC_CODE;
      diags.push(d);
    }
  }
  return diags;
}

export function collectBrokenLinkDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
  if (document.uri.scheme !== 'file') {
    return [];
  }
  if (document.languageId !== 'mermaid' && document.languageId !== 'plantuml') {
    return [];
  }
  if (!config().get<boolean>('codeLinks.checkBrokenLinks', true)) {
    return [];
  }
  const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  const wsRoot = wsFolder?.uri.fsPath;
  const links = collectLocalFileLinksInTextDiagram(
    document.getText(),
    document.languageId as 'mermaid' | 'plantuml',
    document.uri.fsPath,
    wsRoot,
  );

  const diags: vscode.Diagnostic[] = [];
  for (const lk of links) {
    if (!fileExistsOnDisk(document.uri.fsPath, lk.cleanRelativePath, wsRoot)) {
      const range = new vscode.Range(lk.line, lk.startCol, lk.line, lk.endCol);
      const d = new vscode.Diagnostic(
        range,
        t('Broken diagram file link: "{0}" does not exist in workspace.', lk.cleanRelativePath),
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'DrawGraph';
      d.code = BROKEN_LINK_DIAGNOSTIC_CODE;
      diags.push(d);
    }
  }
  return diags;
}

export async function provideBrokenLinkQuickFixes(
  document: vscode.TextDocument,
  context: vscode.CodeActionContext,
): Promise<vscode.CodeAction[]> {
  const actions: vscode.CodeAction[] = [];
  const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    return actions;
  }

  for (const diag of context.diagnostics) {
    if (diag.code !== BROKEN_LINK_DIAGNOSTIC_CODE) {
      continue;
    }
    const rawText = document.getText(diag.range);
    const suffixMatch = /^(.*?)((?::\d+(?::\d+)?|#L?\d+)?)$/.exec(rawText);
    const brokenFile = suffixMatch ? suffixMatch[1] : rawText;
    const lineSuffix = suffixMatch ? suffixMatch[2] : '';
    const baseName = path.basename(brokenFile);
    if (!baseName) {
      continue;
    }
    const candidates = await vscode.workspace.findFiles(`**/${baseName}`, EXCLUDE_GLOB, 5);
    for (const cand of candidates) {
      const nextRel = brokenFile.startsWith('.')
        ? path.relative(path.dirname(document.uri.fsPath), cand.fsPath).split(path.sep).join('/')
        : path.relative(wsFolder.uri.fsPath, cand.fsPath).split(path.sep).join('/');
      const normalized = brokenFile.startsWith('.') && !nextRel.startsWith('.') ? `./${nextRel}` : nextRel;
      const replacement = `${normalized}${lineSuffix}`;
      const act = new vscode.CodeAction(
        t('Update broken link to "{0}"', replacement),
        vscode.CodeActionKind.QuickFix,
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, diag.range, replacement);
      act.edit = edit;
      act.diagnostics = [diag];
      act.isPreferred = candidates.length === 1;
      actions.push(act);
    }
  }
  return actions;
}

export interface BrokenLinkEntry {
  uri: vscode.Uri;
  line: number;
  target: string;
  label: string;
}

export class CodeLinkMaintenanceService implements vscode.Disposable {
  private readonly drawioDiagCollection = vscode.languages.createDiagnosticCollection('drawGraphLinks');
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.subs.push(
      this.drawioDiagCollection,
      vscode.workspace.onDidRenameFiles((e) => {
        void this.onFilesRenamed(e);
      }),
    );
  }

  private async onFilesRenamed(event: vscode.FileRenameEvent): Promise<void> {
    if (!vscode.workspace.isTrusted || !config().get<boolean>('codeLinks.syncOnFileRename', true)) {
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot || event.files.length === 0) {
      return;
    }
    const renames = event.files
      .filter((f) => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file')
      .map((f) => ({ oldFsPath: f.oldUri.fsPath, newFsPath: f.newUri.fsPath }));
    if (renames.length === 0) {
      return;
    }

    const oldBasenames = renames.map((r) => path.basename(r.oldFsPath)).filter(Boolean);
    const diagramUris = await vscode.workspace.findFiles(SYNCABLE_DIAGRAM_GLOB, EXCLUDE_GLOB, 300);
    const edit = new vscode.WorkspaceEdit();
    let touchedFiles = 0;

    for (const uri of diagramUris) {
      try {
        const alreadyOpen = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        const text = alreadyOpen
          ? alreadyOpen.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (!oldBasenames.some((bn) => text.includes(bn))) {
          continue;
        }
        const { updated, replacements } = rewriteRenamedPathsInText(text, uri.fsPath, wsRoot, renames);
        if (replacements > 0 && updated !== text) {
          const doc = alreadyOpen ?? (await vscode.workspace.openTextDocument(uri));
          const change = computeMinimalTextChange(doc.getText(), updated);
          if (change) {
            edit.replace(
              uri,
              new vscode.Range(doc.positionAt(change.startOffset), doc.positionAt(change.endOffset)),
              change.replacement,
            );
            touchedFiles++;
          }
        }
      } catch {
        // Ignore binary or unreadable files
      }
    }

    if (touchedFiles > 0) {
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        void vscode.window.setStatusBarMessage(
          t('Updated diagram links in {0} file(s).', touchedFiles),
          4000,
        );
      }
    }
  }

  /**
   * Audits all workspace diagrams (`.drawio`, `.drawio.svg`, `.mmd`, `.puml`) for broken
   * local file references, updates diagnostics, and returns all discovered broken links.
   */
  async auditWorkspace(interactive = true): Promise<BrokenLinkEntry[]> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
      return [];
    }
    this.drawioDiagCollection.clear();
    const broken: BrokenLinkEntry[] = [];

    const uris = await vscode.workspace.findFiles(
      '**/*.{drawio,dio,drawio.svg,dio.svg,mmd,mermaid,puml,plantuml,pu,iuml,wsd}',
      EXCLUDE_GLOB,
      400,
    );

    for (const uri of uris) {
      const lower = uri.path.toLowerCase();
      if (/\.(?:drawio|dio)(?:\.svg)?$/i.test(lower)) {
        try {
          const xml = await readDrawioXmlFromUri(uri);
          if (!xml) continue;
          const links = collectLocalFileLinksInDrawioXml(xml, uri.fsPath, wsRoot);
          const fileDiags: vscode.Diagnostic[] = [];
          for (const lk of links) {
            if (!fileExistsOnDisk(uri.fsPath, lk.cleanRelativePath, wsRoot)) {
              broken.push({ uri, line: 0, target: lk.rawTarget, label: lk.label });
              const d = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1),
                t('Broken diagram file link: "{0}" does not exist in workspace.', lk.cleanRelativePath),
                vscode.DiagnosticSeverity.Warning,
              );
              d.source = 'DrawGraph';
              d.code = BROKEN_LINK_DIAGNOSTIC_CODE;
              fileDiags.push(d);
            }
          }
          if (fileDiags.length > 0) {
            this.drawioDiagCollection.set(uri, fileDiags);
          }
        } catch {
          // Ignore
        }
      } else {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(bytes).toString('utf8');
          const kind = /\.(?:mmd|mermaid)$/i.test(lower) ? 'mermaid' : 'plantuml';
          const links = collectLocalFileLinksInTextDiagram(text, kind, uri.fsPath, wsRoot);
          for (const lk of links) {
            if (!fileExistsOnDisk(uri.fsPath, lk.cleanRelativePath, wsRoot)) {
              broken.push({ uri, line: lk.line, target: lk.rawTarget, label: lk.cleanRelativePath });
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (interactive) {
      if (broken.length === 0) {
        void vscode.window.showInformationMessage(t('All diagram code links in workspace are valid.'));
      } else {
        const picked = await vscode.window.showQuickPick(
          broken.map((b) => ({
            label: `$(warning) ${b.target}`,
            description: `${vscode.workspace.asRelativePath(b.uri, false)}${b.line ? `:${b.line + 1}` : ''}`,
            entry: b,
          })),
          { placeHolder: t('Found {0} broken diagram link(s) — select to open', broken.length) },
        );
        if (picked) {
          const e = picked.entry;
          if (/\.(?:drawio|dio)(?:\.svg)?$/i.test(e.uri.path)) {
            await vscode.commands.executeCommand('vscode.open', e.uri);
          } else {
            const doc = await vscode.workspace.openTextDocument(e.uri);
            const ed = await vscode.window.showTextDocument(doc);
            const pos = new vscode.Position(e.line, 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        }
      }
    }

    return broken;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}

const DIAGRAM_LANG_IDS = new Set(['mermaid', 'plantuml', 'dot', 'wavedrom', 'markdown']);

function extractEnclosingSymbolAtLine(document: vscode.TextDocument, line: number): string | undefined {
  const declRe =
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:pub\s+)?(?:class|interface|struct|enum|trait|function|def|fn|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  for (let i = Math.min(line, document.lineCount - 1); i >= 0; i--) {
    const m = declRe.exec(document.lineAt(i).text);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/**
 * Tracks source-editor cursor changes and debugger stack-frame pauses, emitting normalized
 * file & symbol candidates so open Diagram Previews and Draw.io editors can highlight the
 * active architecture node in real time.
 */
export function registerLiveCodeSync(
  context: vscode.ExtensionContext,
  onHighlight: (candidates: string[]) => void,
): void {
  let timer: NodeJS.Timeout | undefined;

  const scheduleFromEditor = (editor: vscode.TextEditor | undefined) => {
    if (!config().get<boolean>('preview.syncWithCodeCursor', true)) {
      return;
    }
    if (!editor || editor.document.uri.scheme !== 'file' || DIAGRAM_LANG_IDS.has(editor.document.languageId)) {
      return;
    }
    if (/\.(?:drawio|dio|mmd|mermaid|puml|plantuml|dot|gv|wavedrom)$/i.test(editor.document.uri.path)) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      const doc = editor.document;
      const rel = vscode.workspace.asRelativePath(doc.uri, false).split(path.sep).join('/');
      const base = path.basename(doc.uri.fsPath);
      const baseStem = base.replace(/\.[^.]+$/, '');
      const sym = extractEnclosingSymbolAtLine(doc, editor.selection.active.line);
      const candidates = [rel, base, ...(sym ? [`#${sym}`, sym] : []), ...(baseStem.length >= 3 ? [baseStem] : [])];
      onHighlight(candidates);
    }, 150);
  };

  const debugWithStackEvent = vscode.debug as unknown as {
    onDidChangeActiveStackItem?: (listener: (item: unknown) => unknown) => vscode.Disposable;
  };
  const stackSub = debugWithStackEvent.onDidChangeActiveStackItem
    ? debugWithStackEvent.onDidChangeActiveStackItem(async (item: unknown) => {
        if (!item || !config().get<boolean>('preview.syncWithCodeCursor', true)) {
          return;
        }
        const maybeFrame = item as { session?: vscode.DebugSession; threadId?: number; frameId?: number };
        if (maybeFrame.session && typeof maybeFrame.frameId === 'number' && typeof maybeFrame.threadId === 'number') {
          try {
            const resp = await maybeFrame.session.customRequest('stackTrace', {
              threadId: maybeFrame.threadId,
              levels: 5,
            });
            const frames: Array<{ id?: number; name?: string; source?: { path?: string; name?: string } }> =
              resp?.stackFrames ?? [];
            const hit = frames.find((f) => f.id === maybeFrame.frameId) ?? frames[0];
            if (hit) {
              const cands: string[] = [];
              if (hit.source?.path) {
                cands.push(vscode.workspace.asRelativePath(hit.source.path, false).split(path.sep).join('/'));
                cands.push(path.basename(hit.source.path));
              }
              if (hit.name) {
                const fnClean = hit.name.split('.').pop()?.replace(/\(.*\)$/, '').trim();
                if (fnClean && fnClean.length >= 2) {
                  cands.push(`#${fnClean}`, fnClean);
                }
              }
              if (cands.length > 0) {
                onHighlight(cands);
                return;
              }
            }
          } catch {
            // Fallback to active editor opened by debugger
          }
        }
        scheduleFromEditor(vscode.window.activeTextEditor);
      })
    : { dispose: () => {} };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleFromEditor(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((ed) => scheduleFromEditor(ed)),
    stackSub,
    {
      dispose: () => {
        if (timer) clearTimeout(timer);
      },
    },
  );
}
