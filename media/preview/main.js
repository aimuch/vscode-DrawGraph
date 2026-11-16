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
  const findToggle = $('findToggle');
  const mapToggle = $('mapToggle');
  const settingsToggle = $('settingsToggle');
  const findBar = $('findBar');
  const findInput = /** @type {HTMLInputElement} */ ($('findInput'));
  const findCount = $('findCount');
  const minimap = $('minimap');
  const minimapSvg = $('minimapSvg');
  const minimapViewport = $('minimapViewport');

  // @ts-ignore injected by media/shared/settingsDrawer.js
  const settingsDrawer = window.createDrawGraphSettingsDrawer
    ? // @ts-ignore
      window.createDrawGraphSettingsDrawer({
        postMessage: (m) => vscode.postMessage(m),
        onVisibilityChange: (isOpen) => settingsToggle.setAttribute('aria-pressed', isOpen ? 'true' : 'false'),
      })
    : null;

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
    showMap: saved.showMap === true,
  };
  let natural = { width: 0, height: 0 };
  /** @type {SVGSVGElement | null} */
  let currentSvg = null;
  /** @type {Element[]} */
  let searchMatches = [];
  let activeMatchIdx = -1;
  let rafId = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let persistTimer;

  /**
   * Single source of truth for preview overlay visibility (`spinner`, `errorBox`, `emptyBox`, `#canvas.stale`).
   * @type {'booting' | 'loading' | 'rendered' | 'error' | 'empty'}
   */
  let uiPhase = 'booting';

  /**
   * @param {'booting' | 'loading' | 'rendered' | 'error' | 'empty'} nextPhase
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

  function syncMapUi() {
    mapToggle.setAttribute('aria-pressed', view.showMap ? 'true' : 'false');
    minimap.hidden = !view.showMap || !currentSvg;
    if (view.showMap && currentSvg) {
      rebuildMinimapSvg();
      updateMinimapViewport();
    }
  }

  function rebuildMinimapSvg() {
    if (!currentSvg || !natural.width || !natural.height) {
      minimapSvg.replaceChildren();
      return;
    }
    const clone = /** @type {SVGSVGElement} */ (currentSvg.cloneNode(true));
    clone.removeAttribute('style');
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.querySelectorAll('.drawgraph-search-match, .drawgraph-search-active').forEach((el) => {
      el.classList.remove('drawgraph-search-match', 'drawgraph-search-active');
    });
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${natural.width} ${natural.height}`);
    }
    clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    minimapSvg.replaceChildren(clone);
  }

  function updateMinimapViewport() {
    if (minimap.hidden || !natural.width || !natural.height || !view.zoom) {
      return;
    }
    const mw = minimap.clientWidth || 176;
    const mh = minimap.clientHeight || 118;
    const scale = Math.min(mw / natural.width, mh / natural.height);
    const ox = (mw - natural.width * scale) / 2;
    const oy = (mh - natural.height * scale) / 2;
    const rx = ox + (-view.x / view.zoom) * scale;
    const ry = oy + (-view.y / view.zoom) * scale;
    const rw = (stage.clientWidth / view.zoom) * scale;
    const rh = (stage.clientHeight / view.zoom) * scale;
    minimapViewport.style.left = `${rx}px`;
    minimapViewport.style.top = `${ry}px`;
    minimapViewport.style.width = `${Math.max(8, rw)}px`;
    minimapViewport.style.height = `${Math.max(8, rh)}px`;
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
      showMap: view.showMap,
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
    updateMinimapViewport();
  }

  function applyView(immediate = true) {
    if (immediate) {
      renderTransform();
    } else if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
        zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
        updateMinimapViewport();
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
    if (view.showMap) {
      minimap.hidden = false;
      rebuildMinimapSvg();
    } else {
      minimap.hidden = true;
    }
    if (!findBar.hidden && findInput.value.trim()) {
      runSearch(findInput.value, false);
    }
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
    minimapSvg.replaceChildren();
    minimap.hidden = true;
    currentSvg = null;
    searchMatches = [];
    activeMatchIdx = -1;
    natural = { width: 0, height: 0 };
    transitionUiPhase('empty');
    vscode.postMessage({ type: 'status', state: 'empty' });
  }

  // ---- Search & Highlight --------------------------------------------------------------

  function clearSearchHighlights() {
    if (currentSvg) {
      currentSvg.querySelectorAll('.drawgraph-search-match, .drawgraph-search-active').forEach((el) => {
        el.classList.remove('drawgraph-search-match', 'drawgraph-search-active');
      });
    }
    searchMatches = [];
    activeMatchIdx = -1;
  }

  /** @param {Element} el */
  function centerViewportOnElement(el) {
    if (!view.zoom) {
      return;
    }
    const elRect = el.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!elRect.width && !elRect.height) {
      return;
    }
    const nx = (elRect.left + elRect.width / 2 - canvasRect.left) / view.zoom;
    const ny = (elRect.top + elRect.height / 2 - canvasRect.top) / view.zoom;
    view.x = stage.clientWidth / 2 - nx * view.zoom;
    view.y = stage.clientHeight / 2 - ny * view.zoom;
    view.mode = 'manual';
    applyView(true);
  }

  /**
   * @param {string} rawQuery
   * @param {boolean} [centerActive]
   */
  function runSearch(rawQuery, centerActive = true) {
    clearSearchHighlights();
    const q = rawQuery.trim().toLowerCase();
    if (!q || !currentSvg) {
      findCount.textContent = '0/0';
      return;
    }
    const candidates = currentSvg.querySelectorAll('text, foreignObject');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt && txt.includes(q)) {
        el.classList.add('drawgraph-search-match');
        searchMatches.push(el);
      }
    }
    if (searchMatches.length === 0) {
      findCount.textContent = '0/0';
      return;
    }
    activeMatchIdx = 0;
    searchMatches[0].classList.add('drawgraph-search-active');
    findCount.textContent = `1/${searchMatches.length}`;
    if (centerActive) {
      centerViewportOnElement(searchMatches[0]);
    }
  }

  /** @param {number} delta */
  function stepSearchMatch(delta) {
    if (searchMatches.length === 0) {
      runSearch(findInput.value, true);
      return;
    }
    if (activeMatchIdx >= 0 && searchMatches[activeMatchIdx]) {
      searchMatches[activeMatchIdx].classList.remove('drawgraph-search-active');
    }
    activeMatchIdx = (activeMatchIdx + delta + searchMatches.length) % searchMatches.length;
    const active = searchMatches[activeMatchIdx];
    active.classList.add('drawgraph-search-active');
    findCount.textContent = `${activeMatchIdx + 1}/${searchMatches.length}`;
    centerViewportOnElement(active);
  }

  function openFindBar() {
    findBar.hidden = false;
    findToggle.setAttribute('aria-pressed', 'true');
    findInput.focus();
    findInput.select();
    if (findInput.value.trim()) {
      runSearch(findInput.value, true);
    }
  }

  function closeFindBar() {
    findBar.hidden = true;
    findToggle.setAttribute('aria-pressed', 'false');
    clearSearchHighlights();
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
    clone.querySelectorAll('.drawgraph-search-match, .drawgraph-search-active').forEach((el) => {
      el.classList.remove('drawgraph-search-match', 'drawgraph-search-active');
      if (el.className && typeof el.getAttribute('class') === 'string' && !el.getAttribute('class')?.trim()) {
        el.removeAttribute('class');
      }
    });
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
  findToggle.addEventListener('click', () => {
    if (findBar.hidden) {
      openFindBar();
    } else {
      closeFindBar();
    }
  });
  mapToggle.addEventListener('click', () => {
    view.showMap = !view.showMap;
    syncMapUi();
    persistNow();
  });
  settingsToggle.addEventListener('click', () => {
    settingsDrawer?.toggle();
  });
  findInput.addEventListener('input', () => runSearch(findInput.value, true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepSearchMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });
  $('findPrev').addEventListener('click', () => stepSearchMatch(-1));
  $('findNext').addEventListener('click', () => stepSearchMatch(1));
  $('findClose').addEventListener('click', () => closeFindBar());

  // Minimap click & drag navigation
  let minimapDragging = false;
  /** @param {PointerEvent} e */
  function panFromMinimapEvent(e) {
    if (!natural.width || !natural.height || !view.zoom) {
      return;
    }
    const rect = minimap.getBoundingClientRect();
    const mw = rect.width || 176;
    const mh = rect.height || 118;
    const scale = Math.min(mw / natural.width, mh / natural.height);
    const ox = (mw - natural.width * scale) / 2;
    const oy = (mh - natural.height * scale) / 2;
    const nx = (e.clientX - rect.left - ox) / scale;
    const ny = (e.clientY - rect.top - oy) / scale;
    view.x = stage.clientWidth / 2 - nx * view.zoom;
    view.y = stage.clientHeight / 2 - ny * view.zoom;
    view.mode = 'manual';
    applyView(false);
  }
  minimap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.stopPropagation();
    minimapDragging = true;
    minimap.setPointerCapture(e.pointerId);
    panFromMinimapEvent(e);
  });
  minimap.addEventListener('pointermove', (e) => {
    if (minimapDragging) {
      e.stopPropagation();
      panFromMinimapEvent(e);
    }
  });
  const endMinimapDrag = () => {
    if (minimapDragging) {
      minimapDragging = false;
      persistNow();
    }
  };
  minimap.addEventListener('pointerup', endMinimapDrag);
  minimap.addEventListener('pointercancel', endMinimapDrag);

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

  stage.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    if (!target || target.closest('#findBar, #minimap')) {
      return;
    }
    const anchor = target.closest('a');
    const href = anchor && (anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || '').trim();
    const textEl = target.closest('text, foreignObject');
    const label = (href || (textEl && textEl.textContent) || '').trim();
    if (label) {
      e.preventDefault();
      vscode.postMessage({ type: 'codeLink', target: label, fallbackLabel: label });
    }
  });

  stage.addEventListener('dblclick', (e) => {
    const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    if (target && target.closest('#findBar, #minimap')) {
      return;
    }
    let label = '';
    const textEl = target && target.closest('text, foreignObject');
    if (textEl) {
      label = (textEl.textContent || '').trim();
    }
    if (/^#[A-Za-z_$]/.test(label) || /^[A-Za-z0-9_./-]+\.[A-Za-z]{1,8}(?::\d+|#L\d+)?$/.test(label)) {
      vscode.postMessage({ type: 'codeLink', target: label, fallbackLabel: label });
      return;
    }
    vscode.postMessage({ type: 'openSource', label });
  });

  stage.addEventListener(
    'wheel',
    (e) => {
      const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
      if (target && target.closest('#findBar')) {
        return;
      }
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
    const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    if (target && target.closest('#findBar, #minimap')) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && target && target.closest('text, foreignObject, a')) {
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFindBar();
      return;
    }
    if (e.key === 'Escape' && !findBar.hidden) {
      e.preventDefault();
      closeFindBar();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      openFindBar();
    } else if (e.key === 'm') {
      view.showMap = !view.showMap;
      syncMapUi();
      persistNow();
    } else if (e.key === '+' || e.key === '=') {
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
    } else {
      updateMinimapViewport();
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
        if (msg.labels && typeof msg.labels === 'object') {
          const L = msg.labels;
          ds.labelLocked = L.locked;
          ds.labelUnlocked = L.pin;
          ds.bgAuto = L.bgAuto;
          ds.bgLight = L.bgLight;
          ds.bgDark = L.bgDark;
          ds.bgGrid = L.bgGrid;
          $('zoomOut').title = L.zoomOut;
          zoomLabel.title = L.resetZoom;
          $('zoomIn').title = L.zoomIn;
          $('fit').textContent = L.fit;
          $('fit').title = L.fitTitle;
          bgToggle.title = L.bgTitle;
          mapToggle.textContent = L.map;
          mapToggle.title = L.mapTitle;
          findToggle.textContent = L.find;
          findToggle.title = L.findTitle;
          lockToggle.title = L.lockTitle;
          $('exportSvg').title = L.exportSvgTitle;
          $('exportPng').title = L.exportPngTitle;
          $('copySvg').textContent = L.copySvg;
          $('copySvg').title = L.copySvgTitle;
          $('copyPng').textContent = L.copyPng;
          $('copyPng').title = L.copyPngTitle;
          prevItem.title = L.prevTitle;
          nextItem.title = L.nextTitle;
          spinner.textContent = L.rendering;
          settingsToggle.title = L.settingsTitle;
          findInput.placeholder = L.findPlaceholder;
          $('findPrev').title = L.findPrev;
          $('findNext').title = L.findNext;
          $('findClose').title = L.findClose;
          emptyBox.textContent = L.empty;
          syncBgUi();
          syncLockUi();
        }
        if (msg.settings) {
          settingsDrawer?.setState(msg.settings);
        }
        break;
      case 'settingsState':
        settingsDrawer?.setState(msg.settings);
        break;
      case 'toggleSettings':
        if (msg.settings) {
          settingsDrawer?.setState(msg.settings);
        }
        if (msg.open === true) {
          settingsDrawer?.open();
        } else if (msg.open === false) {
          settingsDrawer?.close();
        } else {
          settingsDrawer?.toggle();
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
  syncMapUi();
  renderTransform();
  persistNow();
  vscode.postMessage({ type: 'ready' });
})();
