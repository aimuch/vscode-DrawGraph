// @ts-check
// Diagram preview: renders Mermaid in the webview, displays PlantUML SVG from the host,
// and provides zoom / pan / export.
(function () {
  // @ts-ignore injected by VS Code
  const vscode = acquireVsCodeApi();
  // @ts-ignore global from mermaid.min.js (only loaded for Mermaid previews)
  const mermaid = window.mermaid;

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const stage = $('stage');
  const canvas = $('canvas');
  const errorBox = $('error');
  const emptyBox = $('empty');
  const spinner = $('spinner');
  const info = $('info');
  const zoomLabel = $('zoomLabel');

  const ds = document.body.dataset;
  const MSG_INVALID_SVG = ds.errInvalidSvg || 'Invalid SVG received from renderer.';
  const MSG_MERMAID_LOAD = ds.errMermaidLoad || 'Mermaid library failed to load.';
  const MSG_PNG_RASTER = ds.errPngRaster || 'PNG export failed: the SVG could not be rasterized. Try exporting as SVG.';

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 20;
  const saved = vscode.getState() || {};
  const view = {
    zoom: typeof saved.zoom === 'number' ? saved.zoom : 1,
    x: typeof saved.x === 'number' ? saved.x : 0,
    y: typeof saved.y === 'number' ? saved.y : 0,
    // Keep fitting the diagram to the window until the user zooms or pans manually.
    autoFit: saved.autoFit !== false,
  };
  let natural = { width: 0, height: 0 };
  /** @type {SVGSVGElement | null} */
  let currentSvg = null;
  let rafId = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let persistTimer;

  function persistNow() {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    vscode.setState({ uri: ds.uri, zoom: view.zoom, x: view.x, y: view.y, autoFit: view.autoFit });
  }

  function schedulePersist() {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(persistNow, 200);
  }

  function renderTransform() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  }

  function applyView(immediate = true) {
    if (immediate) {
      renderTransform();
    } else if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
        zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
      });
    }
    schedulePersist();
  }

  /** @param {boolean} allowUpscale */
  function fit(allowUpscale) {
    if (!natural.width || !natural.height) {
      return;
    }
    const pad = 24;
    const sw = Math.max(stage.clientWidth - pad * 2, 10);
    const sh = Math.max(stage.clientHeight - pad * 2, 10);
    let zoom = Math.min(sw / natural.width, sh / natural.height);
    if (!allowUpscale) {
      zoom = Math.min(zoom, 1);
    }
    view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    view.x = (stage.clientWidth - natural.width * view.zoom) / 2;
    view.y = Math.max(pad, (stage.clientHeight - natural.height * view.zoom) / 2);
    applyView(true);
  }

  /**
   * @param {number} zoom
   * @param {number} [cx] zoom anchor, relative to the stage
   * @param {number} [cy]
   * @param {boolean} [immediate]
   */
  function zoomTo(zoom, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2, immediate = true) {
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    view.x = cx - ((cx - view.x) * zoom) / view.zoom;
    view.y = cy - ((cy - view.y) * zoom) / view.zoom;
    view.zoom = zoom;
    view.autoFit = false;
    applyView(immediate);
  }

  function clamp(/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---- Rendering ---------------------------------------------------------------------

  /** Parses SVG markup, strips active content and shows it. */
  function showSvg(/** @type {string} */ markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      showError(MSG_INVALID_SVG);
      return;
    }
    svg.querySelectorAll('script, iframe, object, embed, applet, meta, base').forEach((n) => n.remove());
    for (const styleEl of svg.querySelectorAll('style')) {
      const css = styleEl.textContent || '';
      if (/@import\b|javascript:/i.test(css)) {
        styleEl.remove();
      }
    }
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
    const node = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.importNode(svg, true)));
    canvas.replaceChildren(node);
    currentSvg = node;
    natural = measure(node);
    node.setAttribute('width', String(natural.width));
    node.setAttribute('height', String(natural.height));
    node.style.maxWidth = 'none';
    node.style.width = `${natural.width}px`;
    node.style.height = `${natural.height}px`;
    canvas.classList.remove('stale');
    errorBox.hidden = true;
    emptyBox.hidden = true;
    if (view.autoFit) {
      fit(false);
    } else {
      applyView(true);
    }
    vscode.postMessage({ type: 'status', state: 'rendered', width: natural.width, height: natural.height });
  }

  /** @param {SVGSVGElement} svg */
  function measure(svg) {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return { width: vb.width, height: vb.height };
    }
    const w = parseFloat(svg.getAttribute('width') || '');
    const h = parseFloat(svg.getAttribute('height') || '');
    if (w > 0 && h > 0) {
      return { width: w, height: h };
    }
    try {
      const box = svg.getBBox();
      return { width: Math.max(box.width, 1), height: Math.max(box.height, 1) };
    } catch {
      return { width: 300, height: 150 };
    }
  }

  function showError(/** @type {string} */ message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    emptyBox.hidden = true;
    canvas.classList.add('stale');
    vscode.postMessage({ type: 'status', state: 'error', message });
  }

  function showEmpty() {
    canvas.replaceChildren();
    currentSvg = null;
    natural = { width: 0, height: 0 };
    errorBox.hidden = true;
    emptyBox.hidden = false;
    vscode.postMessage({ type: 'status', state: 'empty' });
  }

  // Mermaid rendering is asynchronous; only the latest request is rendered.
  let mermaidTheme = '';
  let renderCount = 0;
  let rendering = false;
  /** @type {{source: string, theme: string} | null} */
  let queued = null;

  async function renderMermaid(/** @type {string} */ source, /** @type {string} */ theme) {
    queued = { source, theme };
    if (rendering) {
      return;
    }
    rendering = true;
    spinner.hidden = false;
    try {
      while (queued) {
        const job = queued;
        queued = null;
        await renderMermaidNow(job.source, job.theme);
      }
    } finally {
      rendering = false;
      spinner.hidden = true;
    }
  }

  async function renderMermaidNow(/** @type {string} */ source, /** @type {string} */ theme) {
    if (!mermaid) {
      showError(MSG_MERMAID_LOAD);
      return;
    }
    if (!source.trim()) {
      showEmpty();
      return;
    }
    document.body.dataset.theme = theme;
    if (theme !== mermaidTheme) {
      mermaid.initialize({
        startOnLoad: false,
        theme,
        securityLevel: 'strict',
        // SVG text labels (instead of HTML in <foreignObject>) keep PNG export working.
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      mermaidTheme = theme;
    }
    const id = `drawgraph-mermaid-${++renderCount}`;
    try {
      const { svg } = await mermaid.render(id, source);
      showSvg(svg);
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      // Mermaid leaves temporary nodes behind when rendering fails. (The rendered SVG
      // shown in #canvas carries the same id, so leave that one alone.)
      document.getElementById(`d${id}`)?.remove();
      const leftover = document.getElementById(id);
      if (leftover && !canvas.contains(leftover)) {
        leftover.remove();
      }
    }
  }

  function errorMessage(/** @type {any} */ err) {
    if (!err) {
      return 'Unknown error';
    }
    return String(err.message || err.str || err);
  }

  // ---- Export --------------------------------------------------------------------------

  function serializeSvg() {
    if (!currentSvg) {
      return null;
    }
    const clone = /** @type {SVGSVGElement} */ (currentSvg.cloneNode(true));
    clone.removeAttribute('style');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(natural.width));
    clone.setAttribute('height', String(natural.height));
    return new XMLSerializer().serializeToString(clone);
  }

  function exportSvg() {
    const data = serializeSvg();
    if (data) {
      vscode.postMessage({ type: 'export', format: 'svg', data });
    }
  }

  function exportPng() {
    const data = serializeSvg();
    if (!data) {
      return;
    }
    const scale = 2;
    const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.ceil(natural.width * scale);
        c.height = Math.ceil(natural.height * scale);
        const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
        ctx.fillStyle = getComputedStyle(stage).backgroundColor || '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        vscode.postMessage({ type: 'export', format: 'png', data: c.toDataURL('image/png') });
      } catch (err) {
        vscode.postMessage({ type: 'error', message: `PNG export failed (${errorMessage(err)}). Try exporting as SVG.` });
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      vscode.postMessage({ type: 'error', message: MSG_PNG_RASTER });
    };
    img.src = url;
  }

  // ---- UI events -----------------------------------------------------------------------

  $('zoomIn').addEventListener('click', () => zoomTo(view.zoom * 1.25));
  $('zoomOut').addEventListener('click', () => zoomTo(view.zoom / 1.25));
  zoomLabel.addEventListener('click', () => zoomTo(1));
  $('fit').addEventListener('click', () => {
    view.autoFit = true;
    fit(true);
  });
  $('exportSvg').addEventListener('click', exportSvg);
  $('exportPng').addEventListener('click', exportPng);
  $('copySvg').addEventListener('click', () => {
    const data = serializeSvg();
    if (data) {
      vscode.postMessage({ type: 'copy', data });
    }
  });

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // Pinch-to-zoom on trackpads arrives as ctrl+wheel.
        zoomTo(view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top, false);
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        view.autoFit = false;
        applyView(false);
      }
    },
    { passive: false },
  );

  /** @type {{x: number, y: number} | null} */
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) {
      return;
    }
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    view.autoFit = false;
    applyView(false);
  });
  const endDrag = () => {
    if (drag) {
      drag = null;
      stage.classList.remove('dragging');
      persistNow();
    }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (e.key === '+' || e.key === '=') {
      zoomTo(view.zoom * 1.25);
    } else if (e.key === '-') {
      zoomTo(view.zoom / 1.25);
    } else if (e.key === '0') {
      zoomTo(1);
    } else if (e.key === 'f') {
      view.autoFit = true;
      fit(true);
    }
  });

  window.addEventListener('resize', () => {
    if (view.autoFit) {
      fit(false);
    }
  });
  window.addEventListener('pagehide', persistNow);

  // ---- Host messages -------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'mermaid':
        void renderMermaid(String(msg.source ?? ''), String(msg.theme || 'default'));
        break;
      case 'svg':
        spinner.hidden = true;
        info.textContent = msg.info || '';
        showSvg(String(msg.svg));
        break;
      case 'loading':
        spinner.hidden = false;
        break;
      case 'empty':
        spinner.hidden = true;
        showEmpty();
        break;
      case 'error':
        spinner.hidden = true;
        showError(String(msg.message));
        break;
    }
  });

  renderTransform();
  persistNow();
  vscode.postMessage({ type: 'ready' });
})();
