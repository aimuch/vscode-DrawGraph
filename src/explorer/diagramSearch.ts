import * as vscode from 'vscode';
import { extractDrawioPages } from '../drawio/codeLinksXml';
import { type DrawioEditorProvider, readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { t } from '../l10n';
import { findMarkdownDiagramFences } from '../language/symbols';
import type { PreviewManager } from '../preview/previewManager';

const SEARCH_DIAGRAM_GLOB =
  '**/*.{drawio,dio,drawio.svg,dio.svg,mmd,mermaid,puml,plantuml,pu,iuml,wsd,dot,gv,wavedrom,wave.json,d2,md}';
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';

export interface DiagramSearchMatch {
  readonly uri: vscode.Uri;
  readonly relPath: string;
  readonly diagramType: 'drawio' | 'mermaid' | 'plantuml' | 'dot' | 'wavedrom' | 'd2' | 'markdown';
  readonly label: string;
  readonly line: number;
  readonly pageId?: string;
  readonly pageName?: string;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDrawioLabels(xml: string): Array<{ label: string; pageId?: string; pageName?: string }> {
  const results: Array<{ label: string; pageId?: string; pageName?: string }> = [];
  const pages = extractDrawioPages(xml);
  const valRe = /\bvalue="([^"]{2,120})"/g;

  if (pages.length > 0) {
    for (const p of pages) {
      valRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = valRe.exec(p.diagramXml)) !== null) {
        const clean = decodeHtmlEntities(m[1]);
        if (clean.length >= 2) {
          results.push({ label: clean, pageId: p.id, pageName: p.name });
        }
      }
    }
  } else {
    let m: RegExpExecArray | null;
    while ((m = valRe.exec(xml)) !== null) {
      const clean = decodeHtmlEntities(m[1]);
      if (clean.length >= 2) {
        results.push({ label: clean });
      }
    }
  }
  return results;
}

function extractTextDiagramLabels(text: string): Array<{ label: string; line: number }> {
  const out: Array<{ label: string; line: number }> = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || /^(?:%%|'|\/\/|#)/.test(trimmed)) continue;
    // Extract quoted labels or node declarations
    const qm = /"([^"\n]{2,80})"/.exec(trimmed);
    if (qm) {
      out.push({ label: qm[1].trim(), line: i });
      continue;
    }
    const bm = /[\[\(\{]\s*([^\]\)\}\n]{2,80})\s*[\]\)\}]/.exec(trimmed);
    if (bm) {
      out.push({ label: bm[1].trim(), line: i });
      continue;
    }
    const d2m = /^([A-Za-z0-9_.-]+)\s*:\s*([^{}\n]{2,80})/.exec(trimmed);
    if (d2m && !/^(direction|shape|style|fill|stroke)$/i.test(d2m[1])) {
      out.push({ label: `${d2m[1]}: ${d2m[2].trim()}`, line: i });
      continue;
    }
    if (trimmed.length >= 3 && trimmed.length <= 90 && /-->|->|participant|class |subgraph |entity /i.test(trimmed)) {
      out.push({ label: trimmed, line: i });
    }
  }
  return out;
}

/**
 * Searches all workspace diagrams for nodes/labels matching `query` (or returns all indexed nodes when empty).
 */
export async function searchWorkspaceDiagramNodes(query = ''): Promise<DiagramSearchMatch[]> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  const uris = await vscode.workspace.findFiles(SEARCH_DIAGRAM_GLOB, EXCLUDE_GLOB, 350);
  const matches: DiagramSearchMatch[] = [];

  for (const uri of uris) {
    const lower = uri.path.toLowerCase();
    const relPath = vscode.workspace.asRelativePath(uri, false);

    if (/\.(?:drawio|dio)(?:\.svg)?$/i.test(lower)) {
      try {
        const xml = await readDrawioXmlFromUri(uri);
        if (!xml) continue;
        const labels = extractDrawioLabels(xml);
        const seen = new Set<string>();
        for (const item of labels) {
          if (needle && !item.label.toLowerCase().includes(needle)) continue;
          const k = `${item.pageId ?? ''}:${item.label}`;
          if (seen.has(k)) continue;
          seen.add(k);
          matches.push({
            uri,
            relPath,
            diagramType: 'drawio',
            label: item.label,
            line: 0,
            pageId: item.pageId,
            pageName: item.pageName,
          });
        }
      } catch {
        // Ignore unreadable
      }
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 1024 * 1024) continue;
      const text = Buffer.from(bytes).toString('utf8');

      if (lower.endsWith('.md')) {
        const fences = findMarkdownDiagramFences(text);
        for (const f of fences) {
          for (const item of extractTextDiagramLabels(f.content)) {
            if (needle && !item.label.toLowerCase().includes(needle)) continue;
            matches.push({
              uri,
              relPath,
              diagramType: 'markdown',
              label: item.label,
              line: f.startLine + 1 + item.line,
            });
          }
        }
        continue;
      }

      const dtype: DiagramSearchMatch['diagramType'] = /\.(?:mmd|mermaid)$/i.test(lower)
        ? 'mermaid'
        : /\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(lower)
          ? 'plantuml'
          : /\.(?:dot|gv)$/i.test(lower)
            ? 'dot'
            : /\.(?:d2)$/i.test(lower)
              ? 'd2'
              : 'wavedrom';
      for (const item of extractTextDiagramLabels(text)) {
        if (needle && !item.label.toLowerCase().includes(needle)) continue;
        matches.push({
          uri,
          relPath,
          diagramType: dtype,
          label: item.label,
          line: item.line,
        });
      }
    } catch {
      // Ignore
    }
  }

  return matches;
}

export async function openDiagramSearchQuickPick(
  drawio: DrawioEditorProvider,
  previews: PreviewManager,
): Promise<DiagramSearchMatch | undefined> {
  const allNodes = await searchWorkspaceDiagramNodes('');
  if (allNodes.length === 0) {
    void vscode.window.showInformationMessage(t('No diagram nodes found in this workspace.'));
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    allNodes.slice(0, 400).map((m) => ({
      label: `$(symbol-field) ${m.label}`,
      description: `${m.relPath}${m.pageName ? ` · ${m.pageName}` : m.line > 0 ? `:${m.line + 1}` : ''}`,
      detail: m.diagramType.toUpperCase(),
      match: m,
    })),
    {
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: t('Search nodes & labels across all workspace diagrams ({0} indexed)…', allNodes.length),
    },
  );
  if (!picked) {
    return undefined;
  }

  const m = picked.match;
  if (m.diagramType === 'drawio') {
    await drawio.openAtPage(m.uri, m.line);
  } else {
    const doc = await vscode.workspace.openTextDocument(m.uri);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const pos = new vscode.Position(Math.min(m.line, Math.max(0, doc.lineCount - 1)), 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    if (m.diagramType !== 'markdown') {
      await previews.open(m.uri, true, m.line);
      previews.highlightCodeTargets([m.label]);
    }
  }
  return m;
}
