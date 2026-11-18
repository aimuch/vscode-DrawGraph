import * as path from 'node:path';
import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { t } from '../l10n';
import { encodePlantUml, splitDiagrams } from '../plantuml/encoder';
import { PlantUmlRenderer } from '../plantuml/renderer';
import { renderDotToSvgOffline } from '../renderers/dotRenderer';
import { renderWaveDromToSvg } from '../renderers/wavedromRenderer';
import { config } from '../util';

const asyncPlantUmlCache = new Map<string, string>();
const staticSvgDataUriCache = new Map<string, string>();
const pendingAsyncKeys = new Set<string>();
const markdownPlantUmlRenderer = new PlantUmlRenderer('markdown-plantuml');
let refreshScheduled = false;

function getOrComputeStaticDataUri(cacheKey: string, computeSvg: () => string): string {
  const hit = staticSvgDataUriCache.get(cacheKey);
  if (hit !== undefined) {
    // Refresh LRU order
    staticSvgDataUriCache.delete(cacheKey);
    staticSvgDataUriCache.set(cacheKey, hit);
    return hit;
  }
  const svg = computeSvg();
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  staticSvgDataUriCache.set(cacheKey, dataUri);
  if (staticSvgDataUriCache.size > 64) {
    const oldest = staticSvgDataUriCache.keys().next().value;
    if (oldest !== undefined) {
      staticSvgDataUriCache.delete(oldest);
    }
  }
  return dataUri;
}

function scheduleMarkdownRefresh(): void {
  if (refreshScheduled) {
    return;
  }
  refreshScheduled = true;
  setTimeout(() => {
    refreshScheduled = false;
    void vscode.commands.executeCommand('markdown.preview.refresh');
  }, 120);
}

export function disposeMarkdownPlantUml(): void {
  markdownPlantUmlRenderer.dispose();
  asyncPlantUmlCache.clear();
  staticSvgDataUriCache.clear();
  pendingAsyncKeys.clear();
}

function storeCachedSvg(key: string, svg: string): void {
  asyncPlantUmlCache.set(key, svg);
  if (asyncPlantUmlCache.size > 64) {
    const oldest = asyncPlantUmlCache.keys().next().value;
    if (oldest !== undefined) {
      asyncPlantUmlCache.delete(oldest);
    }
  }
}

function resolveMarkdownBaseDir(env: unknown): string | undefined {
  if (env && typeof env === 'object') {
    const rec = env as { currentDocument?: vscode.Uri };
    if (rec.currentDocument && rec.currentDocument.scheme === 'file') {
      return path.dirname(rec.currentDocument.fsPath);
    }
  }
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.languageId === 'markdown' && active.uri.scheme === 'file') {
    return path.dirname(active.uri.fsPath);
  }
  return undefined;
}

function renderPlantUmlFence(md: MarkdownIt, rawContent: string, lineAttr: string, baseDir?: string): string {
  const blocks = splitDiagrams(rawContent);
  if (blocks.length === 0) {
    return `<div class="drawgraph-plantuml code-line"${lineAttr}></div>\n`;
  }
  const cfg = config();
  const mode = cfg.get<'auto' | 'local' | 'server'>('plantuml.render', 'auto');
  const jar = cfg.get<string>('plantuml.jar', '').trim();
  const useLocal = vscode.workspace.isTrusted && (mode === 'local' || (mode === 'auto' && jar !== ''));

  const rawServer = (cfg.get<string>('plantuml.server', 'https://www.plantuml.com/plantuml') || 'https://www.plantuml.com/plantuml')
    .trim()
    .replace(/\/+$/, '');
  let server = 'https://www.plantuml.com/plantuml';
  try {
    const parsed = new URL(rawServer);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      server = rawServer;
    }
  } catch {
    // Use default server.
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (useLocal && jar) {
      const java = cfg.get<string>('plantuml.java', 'java');
      const dot = cfg.get<string>('plantuml.dot', '').trim();
      const key = `local\0${java}\0${jar}\0${dot}\0${baseDir ?? ''}\0${block.source}`;
      const cached = asyncPlantUmlCache.get(key);
      if (cached) {
        const b64 = Buffer.from(cached, 'utf8').toString('base64');
        parts.push(`<img src="data:image/svg+xml;base64,${b64}" alt="PlantUML diagram">`);
      } else {
        if (!pendingAsyncKeys.has(key)) {
          pendingAsyncKeys.add(key);
          void markdownPlantUmlRenderer
            .render(block.source, { mode: 'local', server: '', jar, java, dot, baseDir, cancelPrevious: false })
            .then((svg) => {
              storeCachedSvg(key, svg);
              scheduleMarkdownRefresh();
            })
            .catch((err: Error) => {
              storeCachedSvg(
                key,
                `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="40"><text x="8" y="24" fill="#d32f2f" font-family="monospace" font-size="13">${md.utils.escapeHtml(err.message)}</text></svg>`,
              );
              scheduleMarkdownRefresh();
            })
            .finally(() => {
              pendingAsyncKeys.delete(key);
            });
        }
        parts.push(`<span class="drawgraph-plantuml-loading">${md.utils.escapeHtml(t('Rendering…'))}</span>`);
      }
      continue;
    }

    const encoded = encodePlantUml(block.source);
    // Large server-rendered blocks (> 3500 encoded chars) exceed HTTP GET URL limits;
    // render asynchronously via HTTP POST and embed as a base64 SVG data URI.
    if (encoded.length > 3500) {
      const key = `server-post\0${server}\0${block.source}`;
      const cached = asyncPlantUmlCache.get(key);
      if (cached) {
        const b64 = Buffer.from(cached, 'utf8').toString('base64');
        parts.push(`<img src="data:image/svg+xml;base64,${b64}" alt="PlantUML diagram">`);
      } else {
        if (!pendingAsyncKeys.has(key)) {
          pendingAsyncKeys.add(key);
          void markdownPlantUmlRenderer
            .render(block.source, { mode: 'server', server, jar: '', java: 'java', dot: '', cancelPrevious: false })
            .then((svg) => {
              storeCachedSvg(key, svg);
              scheduleMarkdownRefresh();
            })
            .catch((err: Error) => {
              storeCachedSvg(
                key,
                `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="40"><text x="8" y="24" fill="#d32f2f" font-family="monospace" font-size="13">${md.utils.escapeHtml(err.message)}</text></svg>`,
              );
              scheduleMarkdownRefresh();
            })
            .finally(() => {
              pendingAsyncKeys.delete(key);
            });
        }
        parts.push(`<span class="drawgraph-plantuml-loading">${md.utils.escapeHtml(t('Rendering…'))}</span>`);
      }
    } else {
      const url = `${server}/svg/${encoded}`;
      parts.push(`<img src="${md.utils.escapeHtml(url)}" alt="PlantUML diagram">`);
    }
  }
  return `<div class="drawgraph-plantuml code-line"${lineAttr}>${parts.join('\n')}</div>\n`;
}

/**
 * markdown-it plugin for the built-in Markdown preview: turns ```mermaid and
 * ```plantuml / ```puml fences into rendered diagrams.
 */
export function mermaidMarkdownPlugin(md: MarkdownIt): MarkdownIt {
  const fallback = md.renderer.rules.fence ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    const cfg = config();
    const line = token.map ? ` data-line="${token.map[0]}"` : '';
    if (lang === 'mermaid' && cfg.get<boolean>('markdown.mermaid', true)) {
      const theme = md.utils.escapeHtml(cfg.get<string>('mermaid.theme', 'auto'));
      return `<div class="drawgraph-mermaid code-line"${line} data-mermaid-theme="${theme}">${md.utils.escapeHtml(token.content)}</div>\n`;
    }
    if ((lang === 'plantuml' || lang === 'puml') && cfg.get<boolean>('markdown.plantuml', true)) {
      return renderPlantUmlFence(md, token.content, line, resolveMarkdownBaseDir(env));
    }
    if ((lang === 'dot' || lang === 'graphviz') && cfg.get<boolean>('markdown.dot', true)) {
      try {
        const dataUri = getOrComputeStaticDataUri(`dot\0${token.content}`, () => renderDotToSvgOffline(token.content));
        return `<div class="drawgraph-plantuml drawgraph-dot code-line"${line}><img src="${dataUri}" alt="Graphviz DOT diagram"></div>\n`;
      } catch (err) {
        return `<div class="drawgraph-plantuml code-line"${line}><pre class="drawgraph-error">${md.utils.escapeHtml((err as Error).message)}</pre></div>\n`;
      }
    }
    if ((lang === 'wavedrom' || lang === 'bitfield') && cfg.get<boolean>('markdown.wavedrom', true)) {
      try {
        const dataUri = getOrComputeStaticDataUri(`wavedrom\0${token.content}`, () => renderWaveDromToSvg(token.content));
        return `<div class="drawgraph-plantuml drawgraph-wavedrom code-line"${line}><img src="${dataUri}" alt="WaveDrom diagram"></div>\n`;
      } catch (err) {
        return `<div class="drawgraph-plantuml code-line"${line}><pre class="drawgraph-error">${md.utils.escapeHtml((err as Error).message)}</pre></div>\n`;
      }
    }
    return fallback(tokens, idx, options, env, self);
  };
  return md;
}
