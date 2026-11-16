import type MarkdownIt from 'markdown-it';
import { config } from '../util';

/**
 * markdown-it plugin for the built-in Markdown preview: turns ```mermaid fences into
 * placeholders that media/markdown/preview.js renders with Mermaid.
 */
export function mermaidMarkdownPlugin(md: MarkdownIt): MarkdownIt {
  const fallback = md.renderer.rules.fence ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    const cfg = config();
    if (lang === 'mermaid' && cfg.get<boolean>('markdown.mermaid', true)) {
      const line = token.map ? ` data-line="${token.map[0]}"` : '';
      const theme = md.utils.escapeHtml(cfg.get<string>('mermaid.theme', 'auto'));
      return `<div class="drawgraph-mermaid code-line"${line} data-mermaid-theme="${theme}">${md.utils.escapeHtml(token.content)}</div>\n`;
    }
    return fallback(tokens, idx, options, env, self);
  };
  return md;
}
