import type MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { encodePlantUml, splitDiagrams } from '../plantuml/encoder';
import { PlantUmlRenderer } from '../plantuml/renderer';
import { config } from '../util';

const localPlantUmlCache = new Map<string, string>();
const pendingLocalKeys = new Set<string>();
const markdownPlantUmlRenderer = new PlantUmlRenderer();
let refreshScheduled = false;

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
  localPlantUmlCache.clear();
  pendingLocalKeys.clear();
}

function renderPlantUmlFence(md: MarkdownIt, rawContent: string, lineAttr: string): string {
  const blocks = splitDiagrams(rawContent);
  if (blocks.length === 0) {
    return `<div class="drawgraph-plantuml code-line"${lineAttr}></div>\n`;
  }
  const cfg = config();
  const mode = cfg.get<'auto' | 'local' | 'server'>('plantuml.render', 'auto');
  const jar = cfg.get<string>('plantuml.jar', '').trim();
  const useLocal = vscode.workspace.isTrusted && (mode === 'local' || (mode === 'auto' && jar !== ''));

  const parts: string[] = [];
  for (const block of blocks) {
    if (useLocal && jar) {
      const java = cfg.get<string>('plantuml.java', 'java');
      const dot = cfg.get<string>('plantuml.dot', '').trim();
      const key = `${java}\0${jar}\0${dot}\0${block.source}`;
      const cached = localPlantUmlCache.get(key);
      if (cached) {
        const b64 = Buffer.from(cached, 'utf8').toString('base64');
        parts.push(`<img src="data:image/svg+xml;base64,${b64}" alt="PlantUML diagram">`);
      } else {
        if (!pendingLocalKeys.has(key)) {
          pendingLocalKeys.add(key);
          void markdownPlantUmlRenderer
            .render(block.source, { mode: 'local', server: '', jar, java, dot })
            .then((svg) => {
              localPlantUmlCache.set(key, svg);
              if (localPlantUmlCache.size > 64) {
                const oldest = localPlantUmlCache.keys().next().value;
                if (oldest !== undefined) {
                  localPlantUmlCache.delete(oldest);
                }
              }
              scheduleMarkdownRefresh();
            })
            .catch((err: Error) => {
              localPlantUmlCache.set(
                key,
                `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="40"><text x="8" y="24" fill="#d32f2f" font-family="monospace" font-size="13">${md.utils.escapeHtml(err.message)}</text></svg>`,
              );
              scheduleMarkdownRefresh();
            })
            .finally(() => {
              pendingLocalKeys.delete(key);
            });
        }
        parts.push(`<span class="drawgraph-plantuml-loading">${md.utils.escapeHtml(vscode.l10n.t('Rendering…'))}</span>`);
      }
    } else {
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
      const url = `${server}/svg/${encodePlantUml(block.source)}`;
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
      return renderPlantUmlFence(md, token.content, line);
    }
    return fallback(tokens, idx, options, env, self);
  };
  return md;
}
