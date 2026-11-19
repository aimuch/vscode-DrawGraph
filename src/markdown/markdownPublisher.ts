import * as path from 'node:path';
import * as vscode from 'vscode';
import { readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import { t } from '../l10n';
import { findMarkdownDiagramFences } from '../language/symbols';
import type { PreviewManager } from '../preview/previewManager';
import { renderD2ToSvgOffline } from '../renderers/d2Renderer';
import { renderDotToSvgOffline } from '../renderers/dotRenderer';
import { renderWaveDromToSvg } from '../renderers/wavedromRenderer';

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
      bytes =
        imageFormat === 'svg'
          ? Buffer.from(renderDotToSvgOffline(f.content), 'utf8')
          : await previews.renderDotBytes(f.content, 'png');
    } else if (f.kind === 'wavedrom') {
      bytes =
        imageFormat === 'svg'
          ? Buffer.from(renderWaveDromToSvg(f.content), 'utf8')
          : await previews.renderWaveDromBytes(f.content, 'png');
    } else {
      const svg = renderD2ToSvgOffline(f.content);
      bytes = imageFormat === 'svg' ? Buffer.from(svg, 'utf8') : await previews.rasterizeSvgToPngBytes(svg);
    }

    const fileName = `diagram-${num}-${f.kind}.${imageFormat}`;
    const assetUri = vscode.Uri.joinPath(assetsDirUri, fileName);
    await vscode.workspace.fs.writeFile(assetUri, bytes);
    assetUris.unshift(assetUri);
    diagramIdx++;

    const mdImageLine = `![${f.kind} diagram ${num}](./${assetsFolderName}/${fileName})`;
    lines.splice(f.startLine, f.endLine - f.startLine + 1, mdImageLine);
  }

  // Also expand local `.drawio` / `.dio` markdown links `[label](arch.drawio)` into rendered images
  let compiledText = lines.join('\n');
  const drawioLinkRe = /\[([^\]]+)\]\(([^)\s]+\.(?:drawio|dio))\)/gi;
  const drawioMatches = [...compiledText.matchAll(drawioLinkRe)];
  if (drawioMatches.length > 0) {
    await vscode.workspace.fs.createDirectory(assetsDirUri);
    for (const m of drawioMatches) {
      const full = m[0];
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
        compiledText = compiledText.replace(full, `![${alt}](./${assetsFolderName}/${fileName})`);
      } catch {
        // Leave unresolved link intact
      }
    }
  }

  await vscode.workspace.fs.writeFile(outputMarkdownUri, Buffer.from(compiledText, 'utf8'));
  void vscode.window.setStatusBarMessage(
    t('Compiled {0} diagram(s) into {1}', diagramIdx, path.basename(outputMarkdownUri.path)),
    4000,
  );

  return { outputMarkdownUri, assetUris, renderedCount: diagramIdx };
}
