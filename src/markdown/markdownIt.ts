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
    if (lang === 'mermaid' && config().get<boolean>('markdown.mermaid', true)) {
      const line = token.map ? ` data-line="${token.map[0]}"` : '';
      return `<div class="drawgraph-mermaid code-line"${line}>${md.utils.escapeHtml(token.content)}</div>\n`;
    }
    return fallback(tokens, idx, options, env, self);
  };
  return md;
}
