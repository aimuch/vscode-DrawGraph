// @ts-check
// Renders ```mermaid blocks in VS Code's built-in Markdown preview (loading mermaid.min.js
// lazily only when needed) and equips both Mermaid and PlantUML blocks with interactive
// hover zoom/pan controls.
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
      const scriptEl = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[nonce]'));
      const nonce = initialNonce || scriptEl?.nonce || '';
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

  /**
   * Equips a rendered diagram container with hover zoom/pan controls (`Ctrl/Cmd/Alt + Wheel`
   * to zoom, drag to pan when zoomed, `−` / `100%` / `+` buttons).
   * @param {HTMLElement} container
   * @param {Node[]} contentNodes
   */
  function mountInteractiveStage(container, contentNodes) {
    const viewport = document.createElement('div');
    viewport.className = 'drawgraph-md-viewport';
    const inner = document.createElement('div');
    inner.className = 'drawgraph-md-inner';
    for (const n of contentNodes) {
      inner.appendChild(n);
    }
    viewport.appendChild(inner);

    const controls = document.createElement('div');
    controls.className = 'drawgraph-md-controls';
    const btnOut = document.createElement('button');
    btnOut.type = 'button';
    btnOut.textContent = '−';
    btnOut.title = 'Zoom out';
    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.textContent = '100%';
    btnReset.title = 'Reset zoom & pan';
    const btnIn = document.createElement('button');
    btnIn.type = 'button';
    btnIn.textContent = '+';
    btnIn.title = 'Zoom in';
    controls.append(btnOut, btnReset, btnIn);

    let zoom = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    const apply = () => {
      const active = Math.abs(zoom - 1) > 0.001 || tx !== 0 || ty !== 0;
      inner.style.transform = active ? `translate(${tx}px, ${ty}px) scale(${zoom})` : '';
      viewport.classList.toggle('is-transformed', active);
      btnReset.textContent = `${Math.round(zoom * 100)}%`;
    };

    const zoomBy = (/** @type {number} */ factor) => {
      zoom = Math.min(8, Math.max(0.25, zoom * factor));
      apply();
    };

    btnOut.addEventListener('click', (e) => {
      e.stopPropagation();
      zoomBy(0.8);
    });
    btnIn.addEventListener('click', (e) => {
      e.stopPropagation();
      zoomBy(1.25);
    });
    btnReset.addEventListener('click', (e) => {
      e.stopPropagation();
      zoom = 1;
      tx = 0;
      ty = 0;
      apply();
    });

    viewport.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey || e.altKey)) {
          return;
        }
        e.preventDefault();
        zoom = Math.min(8, Math.max(0.25, zoom * Math.exp(-e.deltaY * 0.008)));
        apply();
      },
      { passive: false },
    );

    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (Math.abs(zoom - 1) <= 0.001 && tx === 0 && ty === 0)) {
        return;
      }
      dragging = true;
      startX = e.clientX - tx;
      startY = e.clientY - ty;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('is-dragging');
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!dragging) {
        return;
      }
      tx = e.clientX - startX;
      ty = e.clientY - startY;
      apply();
    });
    const stopDrag = () => {
      dragging = false;
      viewport.classList.remove('is-dragging');
    };
    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);

    container.classList.add('drawgraph-md-interactive');
    container.replaceChildren(viewport, controls);
  }

  function enhancePlantUmlBlocks() {
    const blocks = /** @type {NodeListOf<HTMLElement>} */ (
      document.querySelectorAll('div.drawgraph-plantuml:not([data-zoom-bound])')
    );
    for (const block of blocks) {
      if (!block.querySelector('img')) {
        continue;
      }
      block.dataset.zoomBound = '1';
      mountInteractiveStage(block, [...block.childNodes]);
    }
  }

  /** @param {boolean} forceThemeRefresh */
  async function render(forceThemeRefresh = false) {
    enhancePlantUmlBlocks();

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

    let initializedKey = '';
    for (const block of blocks) {
      const configured = block.dataset.mermaidTheme || 'auto';
      const look = block.dataset.mermaidLook === 'handDrawn' ? 'handDrawn' : 'classic';
      if (forceThemeRefresh && configured !== 'auto') {
        continue;
      }
      const theme = configured === 'auto' ? (isDark() ? 'dark' : 'default') : configured;
      const renderKey = `${theme}:${look}`;
      if (block.dataset.renderedTheme === renderKey && block.dataset.rendered === '1') {
        continue;
      }
      if (block.dataset.mermaidSource === undefined) {
        block.dataset.mermaidSource = block.textContent || '';
      }
      const source = block.dataset.mermaidSource;
      block.setAttribute('data-rendered', '1');
      block.dataset.renderedTheme = renderKey;

      if (renderKey !== initializedKey) {
        mermaid.initialize({
          startOnLoad: false,
          theme,
          look,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        initializedKey = renderKey;
      }

      const id = `drawgraph-md-mermaid-${++counter}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const node = parseCleanSvg(svg);
        if (node) {
          mountInteractiveStage(block, [node]);
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
