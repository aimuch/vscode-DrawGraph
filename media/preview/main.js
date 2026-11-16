// @ts-check
// Diagram preview: renders Mermaid in the webview, displays PlantUML SVG from the host,
// and coordinates UI display, viewport pan/zoom, and async Mermaid rendering via explicit states.
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
  const prevItem = $('prevItem');
  const nextItem = $('nextItem');
  const bgToggle = $('bgToggle');
  const lockToggle = $('lockToggle');

  const ds = document.body.dataset;
  const MSG_INVALID_SVG = ds.errInvalidSvg || 'Invalid SVG received from renderer.';
  const MSG_MERMAID_LOAD = ds.errMermaidLoad || 'Mermaid library failed to load.';
  const MSG_PNG_RASTER = ds.errPngRaster || 'PNG export failed: the SVG could not be rasterized. Try exporting as SVG.';

  let pngScale = Math.max(1, Number(ds.pngScale) || 2);
  let pngTransparent = ds.pngTransparent === 'true';
  let locked = ds.locked === 'true';

  const BG_MODES = ['auto', 'light', 'dark', 'grid'];
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 20;
  const saved = vscode.getState() || {};
  const view = {
    zoom: typeof saved.zoom === 'number' ? saved.zoom : 1,
    x: typeof saved.x === 'number' ? saved.x : 0,
    y: typeof saved.y === 'number' ? saved.y : 0,
    /** @type {'auto_fit' | 'manual'} */
    mode: saved.autoFit === false ? 'manual' : 'auto_fit',
    bg: BG_MODES.includes(saved.bg) ? saved.bg : 'auto',
  };
  let natural = { width: 0, height: 0 };
  /** @type {SVGSVGElement | null} */
  let currentSvg = null;
  let rafId = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let persistTimer;

  /**
   * Single source of truth for preview overlay visibility (`spinner`, `errorBox`, `emptyBox`, `#canvas.stale`).
   * @type {'booting' | 'loading' | 'rendered' | 'error' | 'empty'}
   */
  let uiPhase = 'booting';

  /**
   * @param {typeof uiPhase} nextPhase
   * @param {string} [errorMessageText]
   */
  function transitionUiPhase(nextPhase, errorMessageText) {
    uiPhase = nextPhase;
    switch (nextPhase) {
      case 'booting':
        spinner.hidden = true;
        errorBox.hidden = true;
        emptyBox.hidden = true;
        canvas.classList.remove('stale');
        break;
      case 'loading':
        spinner.hidden = false;
        emptyBox.hidden = true;
        break;
      case 'rendered':
        spinner.hidden = true;
        errorBox.hidden = true;
        emptyBox.hidden = true;
        canvas.classList.remove('stale');
        break;
      case 'error':
        spinner.hidden = true;
        errorBox.textContent = errorMessageText || 'Unknown error';
        errorBox.hidden = false;
        emptyBox.hidden = true;
        canvas.classList.toggle('stale', currentSvg !== null);
        break;
      case 'empty':
        spinner.hidden = true;
        errorBox.hidden = true;
        emptyBox.hidden = false;
        canvas.classList.remove('stale');
        break;
    }
  }

  function syncLockUi() {
    lockToggle.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lockToggle.textContent = locked ? ds.labelLocked || 'Locked' : ds.labelUnlocked || 'Pin';
  }

  function syncBgUi() {
    document.body.dataset.bg = view.bg;
    const labels = {
      auto: ds.bgAuto || 'Bg: Auto',
      light: ds.bgLight || 'Bg: Light',
      dark: ds.bgDark || 'Bg: Dark',
      grid: ds.bgGrid || 'Bg: Grid',
    };
    bgToggle.textContent = labels[/** @type {keyof typeof labels} */ (view.bg)] || labels.auto;
  }

  function persistNow() {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    vscode.setState({
      uri: ds.uri,
      locked,
      zoom: view.zoom,
      x: view.x,
      y: view.y,
      autoFit: view.mode === 'auto_fit',
      bg: view.bg,
    });
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
    view.mode = 'manual';
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
    transitionUiPhase('rendered');
    if (view.mode === 'auto_fit') {
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

  /**
   * @param {string} message
   * @param {number} [line]
   */
  function showError(message, line) {
    transitionUiPhase('error', message);
    vscode.postMessage({ type: 'status', state: 'error', message, line });
  }

  function showEmpty() {
    canvas.replaceChildren();
    currentSvg = null;
    natural = { width: 0, height: 0 };
    transitionUiPhase('empty');
    vscode.postMessage({ type: 'status', state: 'empty' });
  }

  // Explicit single-flight coalescing state machine for Mermaid renders:
  // `idle` -> `rendering` <-> `rendering_dirty` -> `idle`
  let mermaidTheme = '';
  let renderCount = 0;
  /** @type {'idle' | 'rendering' | 'rendering_dirty'} */
  let mermaidPhase = 'idle';
  /** @type {{source: string, theme: string} | null} */
  let nextMermaidJob = null;

  async function renderMermaid(/** @type {string} */ source, /** @type {string} */ theme) {
    nextMermaidJob = { source, theme };
    if (mermaidPhase === 'rendering' || mermaidPhase === 'rendering_dirty') {
      mermaidPhase = 'rendering_dirty';
      return;
    }
    mermaidPhase = 'rendering';
    transitionUiPhase('loading');
    try {
      while (nextMermaidJob) {
        const job = nextMermaidJob;
        nextMermaidJob = null;
        mermaidPhase = 'rendering';
        await renderMermaidNow(job.source, job.theme);
      }
    } finally {
      mermaidPhase = 'idle';
      if (uiPhase === 'loading') {
        spinner.hidden = true;
      }
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
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      mermaidTheme = theme;
    }
    const id = `drawgraph-mermaid-${++renderCount}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (mermaidPhase === 'rendering_dirty') {
        // Superseded by a newer queued edit; skip DOM replacement and render latest immediately.
        return;
      }
      showSvg(svg);
    } catch (err) {
      if (mermaidPhase !== 'rendering_dirty') {
        showError(errorMessage(err), errorLine(err));
      }
    } finally {
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

  function errorLine(/** @type {any} */ err) {
    const locLine = err && err.hash && ((err.hash.loc && err.hash.loc.first_line) || err.hash.line);
    if (typeof locLine === 'number' && locLine >= 1) {
      return locLine;
    }
    const msg = errorMessage(err);
    const m = /(?:Parse error on line|line)\s+(\d+)/i.exec(msg);
    return m ? parseInt(m[1], 10) : undefined;
  }

  // ---- Export & Clipboard --------------------------------------------------------------

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

  /** @returns {Promise<HTMLCanvasElement | null>} */
  function rasterizeToCanvas() {
    const data = serializeSvg();
    if (!data) {
      return Promise.resolve(null);
    }
    const scale = pngScale;
    const transparent = pngTransparent || view.bg === 'grid';
    const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = Math.ceil(natural.width * scale);
          c.height = Math.ceil(natural.height * scale);
          const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
          if (!transparent) {
            ctx.fillStyle = view.bg === 'dark' ? '#1e1e1e' : view.bg === 'light' ? '#ffffff' : getComputedStyle(stage).backgroundColor || '#ffffff';
            ctx.fillRect(0, 0, c.width, c.height);
          }
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c);
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(MSG_PNG_RASTER));
      };
      img.src = url;
    });
  }

  function exportSvg(silent = false) {
    const data = serializeSvg();
    if (data) {
      vscode.postMessage({ type: silent ? 'autoExportData' : 'export', format: 'svg', data });
    }
  }

  async function exportPng(silent = false) {
    try {
      const c = await rasterizeToCanvas();
      if (c) {
        vscode.postMessage({ type: silent ? 'autoExportData' : 'export', format: 'png', data: c.toDataURL('image/png') });
      }
    } catch (err) {
      if (!silent) {
        vscode.postMessage({ type: 'error', message: errorMessage(err) });
      }
    }
  }

  async function copyPng() {
    try {
      const c = await rasterizeToCanvas();
      if (!c) {
        return;
      }
      const blob = await new Promise((resolve, reject) => {
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode PNG.'))), 'image/png');
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      vscode.postMessage({ type: 'copiedPng' });
    } catch (err) {
      vscode.postMessage({ type: 'error', message: `Copy PNG failed: ${errorMessage(err)}` });
    }
  }

  // ---- UI events -----------------------------------------------------------------------

  $('zoomIn').addEventListener('click', () => zoomTo(view.zoom * 1.25));
  $('zoomOut').addEventListener('click', () => zoomTo(view.zoom / 1.25));
  zoomLabel.addEventListener('click', () => zoomTo(1));
  $('fit').addEventListener('click', () => {
    view.mode = 'auto_fit';
    fit(true);
  });
  bgToggle.addEventListener('click', () => {
    const idx = BG_MODES.indexOf(view.bg);
    view.bg = BG_MODES[(idx + 1) % BG_MODES.length];
    syncBgUi();
    persistNow();
  });
  lockToggle.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleLock' });
  });
  prevItem.addEventListener('click', () => vscode.postMessage({ type: 'navigate', delta: -1 }));
  nextItem.addEventListener('click', () => vscode.postMessage({ type: 'navigate', delta: 1 }));
  $('exportSvg').addEventListener('click', () => exportSvg(false));
  $('exportPng').addEventListener('click', () => void exportPng(false));
  $('copySvg').addEventListener('click', () => {
    const data = serializeSvg();
    if (data) {
      vscode.postMessage({ type: 'copy', data });
    }
  });
  $('copyPng').addEventListener('click', () => void copyPng());

  stage.addEventListener('dblclick', (e) => {
    let label = '';
    const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    const textEl = target && target.closest('text, foreignObject');
    if (textEl) {
      label = (textEl.textContent || '').trim();
    }
    vscode.postMessage({ type: 'openSource', label });
  });

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomTo(view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top, false);
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        view.mode = 'manual';
        applyView(false);
      }
    },
    { passive: false },
  );

  /**
   * Explicit pointer gesture state: `idle` | `panning`
   * @type {{ phase: 'idle' } | { phase: 'panning', anchorX: number, anchorY: number }}
   */
  let pointerGesture = { phase: 'idle' };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    pointerGesture = { phase: 'panning', anchorX: e.clientX - view.x, anchorY: e.clientY - view.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (pointerGesture.phase !== 'panning') {
      return;
    }
    view.x = e.clientX - pointerGesture.anchorX;
    view.y = e.clientY - pointerGesture.anchorY;
    view.mode = 'manual';
    applyView(false);
  });
  const endDrag = () => {
    if (pointerGesture.phase === 'panning') {
      pointerGesture = { phase: 'idle' };
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
      view.mode = 'auto_fit';
      fit(true);
    } else if (e.key === '[') {
      vscode.postMessage({ type: 'navigate', delta: -1 });
    } else if (e.key === ']') {
      vscode.postMessage({ type: 'navigate', delta: 1 });
    }
  });

  window.addEventListener('resize', () => {
    if (view.mode === 'auto_fit') {
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
        info.textContent = '';
        prevItem.hidden = true;
        nextItem.hidden = true;
        void renderMermaid(String(msg.source ?? ''), String(msg.theme || 'default'));
        break;
      case 'svg':
        info.textContent = msg.info || '';
        prevItem.hidden = !msg.canNav;
        nextItem.hidden = !msg.canNav;
        showSvg(String(msg.svg));
        break;
      case 'config':
        if (typeof msg.pngScale === 'number' && msg.pngScale >= 1) {
          pngScale = msg.pngScale;
        }
        if (typeof msg.pngTransparent === 'boolean') {
          pngTransparent = msg.pngTransparent;
        }
        if (typeof msg.locked === 'boolean') {
          locked = msg.locked;
          syncLockUi();
          persistNow();
        }
        if (typeof msg.uri === 'string') {
          ds.uri = msg.uri;
          persistNow();
        }
        break;
      case 'silentExport':
        if (msg.format === 'svg') {
          exportSvg(true);
        } else if (msg.format === 'png') {
          void exportPng(true);
        }
        break;
      case 'loading':
        transitionUiPhase('loading');
        break;
      case 'empty':
        info.textContent = '';
        prevItem.hidden = true;
        nextItem.hidden = true;
        showEmpty();
        break;
      case 'error':
        showError(String(msg.message));
        break;
    }
  });

  transitionUiPhase('booting');
  syncBgUi();
  syncLockUi();
  renderTransform();
  persistNow();
  vscode.postMessage({ type: 'ready' });
})();
