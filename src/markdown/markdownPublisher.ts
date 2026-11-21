import * as path from 'node:path';
import * as vscode from 'vscode';
import { readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import { findMarkdownDiagramFences } from '../language/symbols';
import type { PreviewManager } from '../preview/previewManager';

export interface MarkdownPublishResult {
  readonly outputMarkdownUri: vscode.Uri;
  readonly assetUris: vscode.Uri[];
  readonly renderedCount: number;
}

/**
 * Compiles a Markdown document containing diagram code fences (`mermaid`, `plantuml`,
 * `dot`, `wavedrom`, `d2`) and local `.drawio` links into a portable `.published.md`
 * with pre-rendered static `.svg` or `.png` image assets — ready for GitHub, Feishu,
 * Yuque, Notion, or WeChat.
 */
export async function compileMarkdownForPublish(
  sourceUri: vscode.Uri,
  previews: PreviewManager,
  imageFormat: 'svg' | 'png' = 'svg',
): Promise<MarkdownPublishResult> {
  const doc = await vscode.workspace.openTextDocument(sourceUri);
  const originalText = doc.getText();
  const baseDir = sourceUri.scheme === 'file' ? path.dirname(sourceUri.fsPath) : undefined;
  const stem = path.basename(sourceUri.path).replace(/\.md$/i, '') || 'document';
  const parentDir = vscode.Uri.joinPath(sourceUri, '..');
  const assetsFolderName = `${stem}.assets`;
  const assetsDirUri = vscode.Uri.joinPath(parentDir, assetsFolderName);
  const outputMarkdownUri = vscode.Uri.joinPath(parentDir, `${stem}.published.md`);

  const fences = findMarkdownDiagramFences(originalText);
  const lines = originalText.replace(/\r\n/g, '\n').split('\n');
  const assetUris: vscode.Uri[] = [];
  let diagramIdx = 0;

  if (fences.length > 0) {
    await vscode.workspace.fs.createDirectory(assetsDirUri);
  }

  // Replace fences from bottom to top so earlier line indices remain valid
  for (let i = fences.length - 1; i >= 0; i--) {
    const f = fences[i];
    const num = i + 1;
    let bytes: Uint8Array;
    if (f.kind === 'mermaid') {
      bytes = await previews.renderMermaidBytes(f.content, imageFormat);
    } else if (f.kind === 'plantuml') {
      bytes = await previews.renderPlantUmlBytes(f.content, imageFormat, baseDir);
    } else if (f.kind === 'dot') {
      bytes = await previews.renderDotBytes(f.content, imageFormat);
    } else if (f.kind === 'wavedrom') {
      bytes = await previews.renderWaveDromBytes(f.content, imageFormat);
    } else {
      bytes = await previews.renderD2Bytes(f.content, imageFormat);
    }

    const fileName = `diagram-${num}-${f.kind}.${imageFormat}`;
    const assetUri = vscode.Uri.joinPath(assetsDirUri, fileName);
    await vscode.workspace.fs.writeFile(assetUri, bytes);
    assetUris.unshift(assetUri);
    diagramIdx++;

    const mdImageLine = `![${f.kind} diagram ${num}](./${assetsFolderName}/${fileName})`;
    lines.splice(f.startLine, f.endLine - f.startLine + 1, mdImageLine);
  }

  // Also expand local `.drawio` / `.dio` markdown links `[label](arch.drawio)` or `![label](arch.drawio)`
  // Replace in reverse index order so earlier match offsets stay exact and `$` sequences aren't interpreted.
  let compiledText = lines.join('\n');
  const drawioLinkRe = /!?\[([^\]]+)\]\(([^)\s]+\.(?:drawio|dio))\)/gi;
  const drawioMatches = [...compiledText.matchAll(drawioLinkRe)];
  if (drawioMatches.length > 0) {
    await vscode.workspace.fs.createDirectory(assetsDirUri);
    for (let mi = drawioMatches.length - 1; mi >= 0; mi--) {
      const m = drawioMatches[mi];
      const matchStart = m.index ?? 0;
      const matchEnd = matchStart + m[0].length;
      const alt = m[1];
      const rel = m[2];
      try {
        const targetUri = vscode.Uri.joinPath(parentDir, rel);
        const xml = await readDrawioXmlFromUri(targetUri);
        if (!xml) continue;
        const svg = renderMxfileToPreviewSvg(xml);
        const bytes = imageFormat === 'svg' ? Buffer.from(svg, 'utf8') : await previews.rasterizeSvgToPngBytes(svg);
        const fileName = `drawio-${++diagramIdx}.${imageFormat}`;
        const assetUri = vscode.Uri.joinPath(assetsDirUri, fileName);
        await vscode.workspace.fs.writeFile(assetUri, bytes);
        assetUris.push(assetUri);
        const replacement = `![${alt}](./${assetsFolderName}/${fileName})`;
        compiledText = `${compiledText.slice(0, matchStart)}${replacement}${compiledText.slice(matchEnd)}`;
      } catch {
        // Leave unresolved link intact
      }
    }
  }

  await vscode.workspace.fs.writeFile(outputMarkdownUri, Buffer.from(compiledText, 'utf8'));

  return { outputMarkdownUri, assetUris, renderedCount: diagramIdx };
}
