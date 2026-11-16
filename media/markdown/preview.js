// @ts-check
// Renders ```mermaid blocks in VS Code's built-in Markdown preview, loading mermaid.min.js
// lazily only when a document actually contains a Mermaid fence.
(function () {
  const ownScript = /** @type {HTMLScriptElement | null} */ (document.currentScript);
  const mermaidUrl = ownScript && ownScript.src ? new URL('../vendor/mermaid.min.js', ownScript.src).toString() : '';
  const initialNonce = (ownScript && ownScript.nonce) || '';

  let counter = 0;
  /**
   * Explicit lazy-loader state: `unloaded` -> `loading` -> `ready` | `failed`
   * @type {'unloaded' | 'loading' | 'ready' | 'failed'}
   */
  let loaderPhase = 'unloaded';
  /** @type {Promise<any> | null} */
  let loader = null;

  function isDark() {
    const cls = document.body.classList;
    return cls.contains('vscode-dark') || (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light'));
  }

  function ensureMermaid() {
    // @ts-ignore global injected by mermaid.min.js
    if (window.mermaid) {
      loaderPhase = 'ready';
      // @ts-ignore
      return Promise.resolve(window.mermaid);
    }
    if (loaderPhase === 'loading' && loader) {
      return loader;
    }
    if (!mermaidUrl) {
      loaderPhase = 'failed';
      return Promise.reject(new Error('Could not resolve Mermaid script URL.'));
    }
    loaderPhase = 'loading';
    loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const nonce = initialNonce || document.querySelector('script[nonce]')?.nonce || '';
      if (nonce) {
        script.nonce = nonce;
      }
      script.src = mermaidUrl;
      script.onload = () => {
        // @ts-ignore
        if (window.mermaid) {
          loaderPhase = 'ready';
          // @ts-ignore
          resolve(window.mermaid);
        } else {
          loaderPhase = 'failed';
          loader = null;
          reject(new Error('Mermaid script loaded without exposing window.mermaid.'));
        }
      };
      script.onerror = () => {
        loaderPhase = 'failed';
        loader = null;
        script.remove();
        reject(new Error('Failed to load Mermaid library.'));
      };
      document.head.appendChild(script);
    });
    return loader;
  }

  /** @param {string} markup */
  function parseCleanSvg(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      return null;
    }
    svg.querySelectorAll('script, iframe, object, embed, applet, meta, base').forEach((n) => n.remove());
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      const tagName = el.nodeName.toLowerCase();
      if ((tagName === 'animate' || tagName === 'set') && /^(?:xlink:)?href$|^on/i.test(el.getAttribute('attributeName') || '')) {
        el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.replace(/[\u0000-\u0020]+/g, '');
        if (
          name.startsWith('on') ||
          name === 'srcdoc' ||
          ((name === 'href' || name === 'xlink:href' || name === 'src' || name === 'action' || name === 'formaction') &&
            /^(?:javascript|vbscript|data:text\/html):/i.test(val))
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
    return document.importNode(svg, true);
  }

  /** @param {boolean} forceThemeRefresh */
  async function render(forceThemeRefresh = false) {
    const selector = forceThemeRefresh
      ? 'div.drawgraph-mermaid[data-rendered]'
      : 'div.drawgraph-mermaid:not([data-rendered])';
    const blocks = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selector));
    if (blocks.length === 0) {
      return;
    }

    let mermaid;
    try {
      mermaid = await ensureMermaid();
    } catch (err) {
      for (const block of blocks) {
        const pre = document.createElement('pre');
        pre.className = 'drawgraph-mermaid-error';
        pre.textContent = `Mermaid: ${(err && /** @type {any} */ (err).message) || err}`;
        block.replaceChildren(pre);
      }
      return;
    }

    let initializedTheme = '';
    for (const block of blocks) {
      const configured = block.dataset.mermaidTheme || 'auto';
      if (forceThemeRefresh && configured !== 'auto') {
        continue;
      }
      const theme = configured === 'auto' ? (isDark() ? 'dark' : 'default') : configured;
      if (block.dataset.renderedTheme === theme && block.dataset.rendered === '1') {
        continue;
      }
      if (block.dataset.mermaidSource === undefined) {
        block.dataset.mermaidSource = block.textContent || '';
      }
      const source = block.dataset.mermaidSource;
      block.setAttribute('data-rendered', '1');
      block.dataset.renderedTheme = theme;

      if (theme !== initializedTheme) {
        mermaid.initialize({
          startOnLoad: false,
          theme,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        initializedTheme = theme;
      }

      const id = `drawgraph-md-mermaid-${++counter}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const node = parseCleanSvg(svg);
        if (node) {
          block.replaceChildren(node);
        } else {
          throw new Error('Invalid SVG output.');
        }
      } catch (err) {
        const pre = document.createElement('pre');
        pre.className = 'drawgraph-mermaid-error';
        pre.textContent = `Mermaid: ${(err && /** @type {any} */ (err).message) || err}`;
        block.replaceChildren(pre);
      } finally {
        document.getElementById(`d${id}`)?.remove();
        const leftover = document.getElementById(id);
        if (leftover && !block.contains(leftover)) {
          leftover.remove();
        }
      }
    }
  }

  let lastDark = isDark();
  const observer = new MutationObserver(() => {
    const nowDark = isDark();
    if (nowDark !== lastDark) {
      lastDark = nowDark;
      void render(true);
    }
  });

  function start() {
    if (document.body) {
      lastDark = isDark();
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    void render(false);
  }

  window.addEventListener('vscode.markdown.updateContent', () => void render(false));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
