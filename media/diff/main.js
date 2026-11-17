// @ts-check
// Interactive Git Visual Diagram Diff webview supporting Side-by-Side synchronized pan/zoom,
// Swipe split-curtain comparison, and Onion-Skin + RGBA Pixel Diff highlighting.
(function () {
  // @ts-ignore injected by VS Code
  const vscode = acquireVsCodeApi();
  // @ts-ignore optional Mermaid library
  const mermaid = window.mermaid;

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const diffStage = $('diffStage');
  const sideView = $('sideView');
  const overlayView = $('overlayView');
  const canvasBefore = $('canvasBefore');
  const canvasAfter = $('canvasAfter');
  const badgeBefore = $('badgeBefore');
  const badgeAfter = $('badgeAfter');
  const overlayBefore = $('overlayBefore');
  const overlayAfter = $('overlayAfter');
  const swipeDivider = $('swipeDivider');
  const onionControls = $('onionControls');
  const onionSlider = /** @type {HTMLInputElement} */ ($('onionSlider'));
  const pixelDiffBtn = $('pixelDiffBtn');
  const pixelDiffCanvas = /** @type {HTMLCanvasElement} */ ($('pixelDiffCanvas'));
  const diffStats = $('diffStats');
  const zoomResetBtn = $('zoomResetBtn');

  /** @type {'side' | 'swipe' | 'onion'} */
  let mode = 'side';
  let zoom = 1;
  let panX = 24;
  let panY = 36;
  let swipePct = 50;
  let pixelDiffActive = false;
  let natural = { width: 480, height: 320 };
  let emptyLabel = 'Empty';

  /** @type {{ svgOrDataUri: string, isPng: boolean } | null} */
  let renderedBefore = null;
  /** @type {{ svgOrDataUri: string, isPng: boolean } | null} */
  let renderedAfter = null;

  function applyTransforms() {
    const tf = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    canvasBefore.style.transform = tf;
    canvasAfter.style.transform = tf;
    overlayBefore.style.transform = tf;
    overlayAfter.style.transform = tf;
    pixelDiffCanvas.style.transform = tf;
    zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
    updateOverlayClipAndOpacity();
  }

  function updateOverlayClipAndOpacity() {
    if (mode === 'swipe') {
      swipeDivider.hidden = false;
      swipeDivider.style.left = `${swipePct}%`;
      overlayAfter.style.clipPath = `inset(0 0 0 ${swipePct}%)`;
      overlayAfter.style.opacity = '1';
      overlayBefore.style.opacity = '1';
      pixelDiffCanvas.hidden = true;
    } else if (mode === 'onion') {
      swipeDivider.hidden = true;
      overlayAfter.style.clipPath = 'none';
      if (pixelDiffActive) {
        overlayBefore.style.opacity = '0.22';
        overlayAfter.style.opacity = '0.22';
        pixelDiffCanvas.hidden = false;
      } else {
        overlayBefore.style.opacity = '1';
        overlayAfter.style.opacity = String(Number(onionSlider.value) / 100);
        pixelDiffCanvas.hidden = true;
      }
    }
  }

  function fitToStage() {
    const pane = mode === 'side' ? $('paneAfter') : overlayView;
    const pw = Math.max(80, (pane.clientWidth || diffStage.clientWidth / 2) - 48);
    const ph = Math.max(80, (pane.clientHeight || diffStage.clientHeight) - 64);
    zoom = Math.min(1.5, Math.max(0.1, Math.min(pw / Math.max(1, natural.width), ph / Math.max(1, natural.height))));
    panX = Math.max(16, ((pane.clientWidth || pw) - natural.width * zoom) / 2);
    panY = Math.max(34, ((pane.clientHeight || ph) - natural.height * zoom) / 2);
    applyTransforms();
  }

  /** @param {'side' | 'swipe' | 'onion'} next */
  function setMode(next) {
    mode = next;
    diffStage.dataset.mode = next;
    document.querySelectorAll('.diffModes button').forEach((b) => {
      const btn = /** @type {HTMLButtonElement} */ (b);
      btn.classList.toggle('active', btn.dataset.mode === next);
    });
    sideView.hidden = next !== 'side';
    overlayView.hidden = next === 'side';
    onionControls.hidden = next !== 'onion';
    fitToStage();
    if (next === 'onion' && pixelDiffActive) {
      void computePixelDiff();
    }
  }

  /**
   * Sanitizes SVG string and returns a cloned DOM element + measured size.
   * @param {string} markup
   */
  function parseCleanSvg(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      return null;
    }
    svg.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        if (attr.name.toLowerCase().startsWith('on')) {
          el.removeAttribute(attr.name);
        }
      }
    }
    const vb = /** @type {any} */ (svg).viewBox && /** @type {any} */ (svg).viewBox.baseVal;
    const w = (vb && vb.width > 0 ? vb.width : parseFloat(svg.getAttribute('width') || '480')) || 480;
    const h = (vb && vb.height > 0 ? vb.height : parseFloat(svg.getAttribute('height') || '320')) || 320;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    svg.style.maxWidth = 'none';
    return { node: document.importNode(svg, true), serialized: new XMLSerializer().serializeToString(svg), width: w, height: h };
  }

  let mmdSeq = 0;
  /**
   * @param {any} side
   * @param {string} theme
   */
  async function resolveSideVisual(side, theme) {
    if (!side || side.empty) {
      return null;
    }
    if (side.renderKind === 'png') {
      return { svgOrDataUri: String(side.payload), isPng: true, width: 480, height: 320 };
    }
    let svgText = String(side.payload || '');
    if (side.renderKind === 'mermaid' && mermaid) {
      mermaid.initialize({ startOnLoad: false, theme: theme || 'default', securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } });
      const id = `dg-diff-mmd-${++mmdSeq}`;
      const out = await mermaid.render(id, svgText);
      document.getElementById(`d${id}`)?.remove();
      svgText = out.svg;
    }
    const parsed = parseCleanSvg(svgText);
    if (!parsed) {
      return null;
    }
    return { svgOrDataUri: parsed.serialized, isPng: false, width: parsed.width, height: parsed.height, node: parsed.node };
  }

  /**
   * @param {HTMLElement} target
   * @param {any} resolved
   */
  function mountVisual(target, resolved) {
    target.replaceChildren();
    if (!resolved) {
      const empty = document.createElement('div');
      empty.className = 'emptyPlaceholder';
      empty.textContent = emptyLabel;
      target.appendChild(empty);
      return;
    }
    if (resolved.isPng) {
      const img = document.createElement('img');
      img.src = resolved.svgOrDataUri;
      img.onload = () => {
        natural.width = Math.max(natural.width, img.naturalWidth || 400);
        natural.height = Math.max(natural.height, img.naturalHeight || 300);
        fitToStage();
      };
      target.appendChild(img);
      return;
    }
    const parsed = parseCleanSvg(resolved.svgOrDataUri);
    if (parsed) {
      target.appendChild(parsed.node);
    }
  }

  /** @param {{ svgOrDataUri: string, isPng: boolean } | null} item @param {number} w @param {number} h */
  function rasterizeItem(item, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    if (!item) {
      return Promise.resolve(ctx.getImageData(0, 0, w, h));
    }
    const url = item.isPng
      ? item.svgOrDataUri
      : URL.createObjectURL(new Blob([item.svgOrDataUri], { type: 'image/svg+xml' }));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, img.naturalWidth || w, img.naturalHeight || h);
        if (!item.isPng) {
          URL.revokeObjectURL(url);
        }
        resolve(ctx.getImageData(0, 0, w, h));
      };
      img.onerror = () => {
        if (!item.isPng) {
          URL.revokeObjectURL(url);
        }
        resolve(ctx.getImageData(0, 0, w, h));
      };
      img.src = url;
    });
  }

  async function computePixelDiff() {
    const w = Math.max(1, Math.min(2400, Math.ceil(natural.width)));
    const h = Math.max(1, Math.min(2400, Math.ceil(natural.height)));
    const [imgA, imgB] = await Promise.all([rasterizeItem(renderedBefore, w, h), rasterizeItem(renderedAfter, w, h)]);
    pixelDiffCanvas.width = w;
    pixelDiffCanvas.height = h;
    pixelDiffCanvas.style.width = `${w}px`;
    pixelDiffCanvas.style.height = `${h}px`;
    const ctx = /** @type {CanvasRenderingContext2D} */ (pixelDiffCanvas.getContext('2d'));
    const out = ctx.createImageData(w, h);
    let changed = 0;
    const a = imgA.data;
    const b = imgB.data;
    const d = out.data;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
      if (delta > 28) {
        changed++;
        d[i] = 255;
        d[i + 1] = 45;
        d[i + 2] = 85;
        d[i + 3] = 225;
      }
    }
    ctx.putImageData(out, 0, 0);
    const pct = ((changed / Math.max(1, w * h)) * 100).toFixed(2);
    diffStats.textContent = `${pct}% Δ`;
    updateOverlayClipAndOpacity();
  }

  // ---- Controls & synchronized pan/zoom -----------------------------------------------

  document.querySelectorAll('.diffModes button').forEach((b) => {
    const btn = /** @type {HTMLButtonElement} */ (b);
    btn.addEventListener('click', () => {
      if (btn.dataset.mode) {
        setMode(/** @type {'side' | 'swipe' | 'onion'} */ (btn.dataset.mode));
      }
    });
  });

  $('zoomInBtn').addEventListener('click', () => {
    zoom = Math.min(12, zoom * 1.25);
    applyTransforms();
  });
  $('zoomOutBtn').addEventListener('click', () => {
    zoom = Math.max(0.08, zoom / 1.25);
    applyTransforms();
  });
  zoomResetBtn.addEventListener('click', () => {
    zoom = 1;
    applyTransforms();
  });
  $('fitBtn').addEventListener('click', fitToStage);
  onionSlider.addEventListener('input', updateOverlayClipAndOpacity);
  pixelDiffBtn.addEventListener('click', () => {
    pixelDiffActive = !pixelDiffActive;
    pixelDiffBtn.classList.toggle('active', pixelDiffActive);
    if (pixelDiffActive) {
      void computePixelDiff();
    } else {
      diffStats.textContent = '';
      updateOverlayClipAndOpacity();
    }
  });

  let draggingSwipe = false;
  let panning = false;
  let anchorX = 0;
  let anchorY = 0;

  swipeDivider.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    draggingSwipe = true;
    swipeDivider.setPointerCapture(e.pointerId);
  });
  swipeDivider.addEventListener('pointermove', (e) => {
    if (!draggingSwipe) {
      return;
    }
    const rect = overlayView.getBoundingClientRect();
    swipePct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100));
    updateOverlayClipAndOpacity();
  });
  swipeDivider.addEventListener('pointerup', () => {
    draggingSwipe = false;
  });

  diffStage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('#swipeDivider'))) {
      return;
    }
    panning = true;
    anchorX = e.clientX - panX;
    anchorY = e.clientY - panY;
    diffStage.setPointerCapture(e.pointerId);
  });
  diffStage.addEventListener('pointermove', (e) => {
    if (!panning) {
      return;
    }
    panX = e.clientX - anchorX;
    panY = e.clientY - anchorY;
    applyTransforms();
  });
  diffStage.addEventListener('pointerup', () => {
    panning = false;
  });
  diffStage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoom = Math.max(0.08, Math.min(12, zoom * Math.exp(-e.deltaY * 0.01)));
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
      }
      applyTransforms();
    },
    { passive: false },
  );

  window.addEventListener('resize', fitToStage);

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'loadDiff') {
      return;
    }
    emptyLabel = msg.emptyText || 'Empty';
    badgeBefore.textContent = msg.before?.label || 'Before';
    badgeAfter.textContent = msg.after?.label || 'After';

    const [visA, visB] = await Promise.all([
      resolveSideVisual(msg.before, msg.mermaidTheme),
      resolveSideVisual(msg.after, msg.mermaidTheme),
    ]);
    renderedBefore = visA ? { svgOrDataUri: visA.svgOrDataUri, isPng: visA.isPng } : null;
    renderedAfter = visB ? { svgOrDataUri: visB.svgOrDataUri, isPng: visB.isPng } : null;

    natural = {
      width: Math.max(visA?.width || 0, visB?.width || 0, 320),
      height: Math.max(visA?.height || 0, visB?.height || 0, 220),
    };

    mountVisual(canvasBefore, visA);
    mountVisual(canvasAfter, visB);
    mountVisual(overlayBefore, visA);
    mountVisual(overlayAfter, visB);
    fitToStage();
  });

  vscode.postMessage({ type: 'ready' });
})();
