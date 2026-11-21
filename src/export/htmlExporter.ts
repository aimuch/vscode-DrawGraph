// Builds a 100% standalone, zero-network-dependency interactive `.html` presentation
// bundle for 1 or N SVG diagram pages, with wheel zoom, drag pan, multi-page tabs,
// live search, minimap, theme toggle, and spotlight/laser presentation mode.

import type { WalkthroughStep } from '../walkthrough/walkthroughCore';

export interface HtmlDiagramPage {
  name: string;
  svg: string;
  steps?: WalkthroughStep[];
}

export interface InteractiveHtmlOptions {
  title: string;
  pages: HtmlDiagramPage[];
  lang?: 'en' | 'zh-cn';
  defaultTheme?: 'light' | 'dark';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeSvgMarkup(svg: string): string {
  // Strip any executable script tags or inline event handlers before embedding
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
}

export function buildInteractiveHtmlBundle(opts: InteractiveHtmlOptions): string {
  const isZh = opts.lang === 'zh-cn';
  const theme = opts.defaultTheme === 'dark' ? 'dark' : 'light';
  const pages = opts.pages.map((p, idx) => ({
    name: p.name || (isZh ? `第 ${idx + 1} 页` : `Page ${idx + 1}`),
    svgB64: Buffer.from(sanitizeSvgMarkup(p.svg), 'utf8').toString('base64'),
    steps: p.steps ?? [],
  }));

  const L = isZh
    ? {
        fit: '适应窗口 (F)',
        bg: '背景切换',
        map: '小地图 (M)',
        find: '搜索 (/)',
        present: '演示聚光灯 (P)',
        laser: '激光笔 (L)',
        exit: '退出演示 (Esc)',
        searchPh: '在图表中搜索文本…',
        stepsHint: '步 · ←/→',
      }
    : {
        fit: 'Fit (F)',
        bg: 'Background',
        map: 'Minimap (M)',
        find: 'Find (/)',
        present: 'Present (P)',
        laser: 'Laser (L)',
        exit: 'Exit (Esc)',
        searchPh: 'Find in diagram…',
        stepsHint: 'steps · ←/→',
      };

  const payloadJson = JSON.stringify(pages).replace(/</g, '\\u003c');

  return /* html */ `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${escHtml(opts.title)}</title>
<style>
  :root {
    --bg: #f8fafc; --bar: #ffffff; --fg: #0f172a; --muted: #64748b;
    --border: #e2e8f0; --accent: #2563eb; --hover: #f1f5f9;
  }
  body[data-bg="dark"] {
    --bg: #0f172a; --bar: #1e293b; --fg: #f8fafc; --muted: #94a3b8;
    --border: #334155; --accent: #3b82f6; --hover: #334155;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; }
  #bar {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px;
    background: var(--bar); border-bottom: 1px solid var(--border); z-index: 10; flex-wrap: nowrap; overflow-x: auto;
  }
  .title { font-weight: 600; font-size: 13px; margin-right: 6px; white-space: nowrap; }
  button, select, input {
    background: transparent; color: var(--fg); border: 1px solid var(--border);
    border-radius: 5px; padding: 4px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  button:hover, select:hover { background: var(--hover); }
  button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .spacer { flex: 1; }
  #stage { flex: 1; position: relative; overflow: hidden; cursor: grab; user-select: none; }
  #stage.dragging { cursor: grabbing; }
  body[data-bg="grid"] #stage {
    background-color: #ffffff;
    background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
    background-size: 18px 18px;
  }
  #canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  #findBox {
    position: absolute; top: 12px; right: 14px; display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; background: var(--bar); border: 1px solid var(--border); border-radius: 7px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.16); z-index: 20;
  }
  #findBox[hidden], #minimap[hidden], #hud[hidden], #stepHud[hidden], #laser[hidden] { display: none !important; }
  #minimap {
    position: absolute; right: 14px; bottom: 14px; width: 184px; height: 124px;
    background: var(--bar); border: 1px solid var(--border); border-radius: 7px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.18); overflow: hidden; z-index: 18;
  }
  #miniSvg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  #miniSvg svg { max-width: 100%; max-height: 100%; }
  #miniVp { position: absolute; border: 1.5px solid var(--accent); background: rgba(37,99,235,0.12); pointer-events: none; }
  .dg-match { filter: drop-shadow(0 0 5px #f59e0b); }
  .dg-match-cur { filter: drop-shadow(0 0 9px #ef4444); }
  body.present #bar { display: none; }
  #hud {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 8px; padding: 6px 12px; border-radius: 999px;
    background: rgba(15,23,42,0.86); border: 1px solid rgba(255,255,255,0.18); z-index: 30;
  }
  #hud button { color: #fff; border-color: rgba(255,255,255,0.24); border-radius: 999px; }
  #stepHud {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px;
    background: var(--bar); border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0,0,0,0.18); z-index: 25; font-size: 12px;
  }
  body.present #stepHud { bottom: 58px; }
  svg.dg-spot g.node, svg.dg-spot g.edgePath, svg.dg-spot g.cluster, svg.dg-spot g.elem, svg.dg-spot g.d2-node { opacity: 0.18; transition: opacity 0.16s; }
  svg.dg-spot .dg-spot-on, svg.dg-spot .dg-spot-on * { opacity: 1 !important; filter: drop-shadow(0 0 8px rgba(37,99,235,0.5)); }
  #laser {
    position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
    background: #ff2222; box-shadow: 0 0 12px 4px rgba(255,34,34,0.8); pointer-events: none; z-index: 40;
  }
</style>
</head>
<body data-bg="${theme}">
  <div id="bar">
    <span class="title">${escHtml(opts.title)}</span>
    <select id="pageSel" hidden></select>
    <button id="zOut" type="button">−</button>
    <button id="zLbl" type="button">100%</button>
    <button id="zIn" type="button">+</button>
    <button id="fitBtn" type="button">${escHtml(L.fit)}</button>
    <button id="bgBtn" type="button">${escHtml(L.bg)}</button>
    <button id="mapBtn" type="button">${escHtml(L.map)}</button>
    <button id="findBtn" type="button">${escHtml(L.find)}</button>
    <button id="presBtn" type="button">${escHtml(L.present)}</button>
    <span class="spacer"></span>
  </div>
  <div id="stage">
    <div id="canvas"></div>
    <div id="findBox" hidden>
      <input id="findIn" type="text" placeholder="${escHtml(L.searchPh)}">
      <span id="findCnt">0/0</span>
      <button id="findClose" type="button">✕</button>
    </div>
    <div id="minimap" hidden>
      <div id="miniSvg"></div>
      <div id="miniVp"></div>
    </div>
    <div id="hud" hidden>
      <button id="laserBtn" type="button">${escHtml(L.laser)}</button>
      <button id="exitBtn" type="button">${escHtml(L.exit)}</button>
    </div>
    <div id="stepHud" hidden>
      <button id="stepPrev" type="button">◀</button>
      <span id="stepText"></span>
      <button id="stepNext" type="button">▶</button>
      <button id="stepClear" type="button">✕</button>
    </div>
    <div id="laser" hidden></div>
  </div>
<script>
(function () {
  const PAGES = ${payloadJson};
  const BGS = ['light', 'dark', 'grid'];
  let pageIdx = 0, zoom = 1, panX = 24, panY = 24, natW = 600, natH = 400;
  let showMap = false, presenting = false, laser = false, curSvg = null, matches = [], matchIdx = -1;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), canvas = $('canvas'), pageSel = $('pageSel'), zLbl = $('zLbl');
  const minimap = $('minimap'), miniSvg = $('miniSvg'), miniVp = $('miniVp');
  const findBox = $('findBox'), findIn = $('findIn'), findCnt = $('findCnt');
  const hud = $('hud'), laserEl = $('laser'), laserBtn = $('laserBtn');
  const stepHud = $('stepHud'), stepText = $('stepText');
  let stepIdx = -1;

  function applyStep(idx) {
    const steps = (PAGES[pageIdx] && PAGES[pageIdx].steps) || [];
    if (!steps.length || !curSvg) return;
    stepIdx = ((idx % steps.length) + steps.length) % steps.length;
    const st = steps[stepIdx];
    stepText.textContent = (stepIdx + 1) + '/' + steps.length + ': ' + st.title;
    curSvg.querySelectorAll('.dg-spot-on').forEach((x) => x.classList.remove('dg-spot-on'));
    const needles = (st.targets || []).map((t) => String(t).toLowerCase());
    let hit = false;
    curSvg.querySelectorAll('g.node, g.elem, g.cluster, g.edgePath, g.d2-node, g.d2-container').forEach((el) => {
      const txt = (el.textContent || '').trim().toLowerCase();
      const idAttr = (el.getAttribute('id') || '').toLowerCase();
      if (needles.some((nd) => txt === nd || txt.includes(nd) || idAttr.includes(nd))) {
        el.classList.add('dg-spot-on');
        hit = true;
      }
    });
    curSvg.classList.toggle('dg-spot', hit);
  }
  function clearStep() {
    stepIdx = -1;
    curSvg?.classList.remove('dg-spot');
    curSvg?.querySelectorAll('.dg-spot-on').forEach((x) => x.classList.remove('dg-spot-on'));
    const steps = (PAGES[pageIdx] && PAGES[pageIdx].steps) || [];
    if (steps.length) stepText.textContent = steps.length + ' ${escHtml(L.stepsHint)}';
  }
  $('stepPrev').onclick = () => applyStep(stepIdx <= 0 ? ((PAGES[pageIdx].steps || []).length - 1) : stepIdx - 1);
  $('stepNext').onclick = () => applyStep(stepIdx < 0 ? 0 : stepIdx + 1);
  $('stepClear').onclick = clearStep;

  function decodeUtf8B64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function applyTf() {
    canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    zLbl.textContent = Math.round(zoom * 100) + '%';
    updateMiniVp();
  }

  function zoomAt(next, cx, cy) {
    const z = Math.max(0.05, Math.min(20, next));
    const ax = cx !== undefined ? cx : stage.clientWidth / 2;
    const ay = cy !== undefined ? cy : stage.clientHeight / 2;
    panX = ax - ((ax - panX) * z) / zoom;
    panY = ay - ((ay - panY) * z) / zoom;
    zoom = z;
    applyTf();
  }

  function fit() {
    const sw = Math.max(80, stage.clientWidth - 48), sh = Math.max(80, stage.clientHeight - 48);
    zoom = Math.min(2, Math.max(0.08, Math.min(sw / Math.max(1, natW), sh / Math.max(1, natH))));
    panX = (stage.clientWidth - natW * zoom) / 2;
    panY = (stage.clientHeight - natH * zoom) / 2;
    applyTf();
  }

  function updateMiniVp() {
    if (minimap.hidden || !natW || !natH) return;
    const mw = 184, mh = 124;
    const sc = Math.min(mw / natW, mh / natH);
    const ox = (mw - natW * sc) / 2, oy = (mh - natH * sc) / 2;
    miniVp.style.left = (ox + (-panX / zoom) * sc) + 'px';
    miniVp.style.top = (oy + (-panY / zoom) * sc) + 'px';
    miniVp.style.width = Math.max(8, (stage.clientWidth / zoom) * sc) + 'px';
    miniVp.style.height = Math.max(8, (stage.clientHeight / zoom) * sc) + 'px';
  }

  function loadPage(idx) {
    pageIdx = Math.max(0, Math.min(idx, PAGES.length - 1));
    const markup = decodeUtf8B64(PAGES[pageIdx].svgB64);
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    canvas.replaceChildren();
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    natW = (vb && vb.width > 0 ? vb.width : parseFloat(svg.getAttribute('width') || '600')) || 600;
    natH = (vb && vb.height > 0 ? vb.height : parseFloat(svg.getAttribute('height') || '400')) || 400;
    svg.style.width = natW + 'px';
    svg.style.height = natH + 'px';
    curSvg = document.importNode(svg, true);
    canvas.appendChild(curSvg);
    if (showMap) {
      const clone = curSvg.cloneNode(true);
      clone.removeAttribute('style');
      miniSvg.replaceChildren(clone);
    }
    const steps = PAGES[pageIdx].steps || [];
    stepIdx = -1;
    stepHud.hidden = steps.length === 0;
    if (steps.length) stepText.textContent = steps.length + ' ${escHtml(L.stepsHint)}';
    fit();
  }

  if (PAGES.length > 1) {
    pageSel.hidden = false;
    PAGES.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = (i + 1) + '/' + PAGES.length + ': ' + p.name;
      pageSel.appendChild(opt);
    });
    pageSel.addEventListener('change', () => loadPage(Number(pageSel.value) || 0));
  }

  $('zIn').onclick = () => zoomAt(zoom * 1.25);
  $('zOut').onclick = () => zoomAt(zoom / 1.25);
  zLbl.onclick = () => zoomAt(1);
  $('fitBtn').onclick = fit;
  $('bgBtn').onclick = () => {
    const cur = document.body.dataset.bg || 'light';
    document.body.dataset.bg = BGS[(BGS.indexOf(cur) + 1) % BGS.length];
  };
  $('mapBtn').onclick = () => {
    showMap = !showMap;
    $('mapBtn').classList.toggle('active', showMap);
    minimap.hidden = !showMap;
    if (showMap && curSvg) {
      const clone = curSvg.cloneNode(true);
      clone.removeAttribute('style');
      miniSvg.replaceChildren(clone);
      updateMiniVp();
    }
  };

  function togglePresent(on) {
    presenting = on;
    document.body.classList.toggle('present', presenting);
    hud.hidden = !presenting;
    if (!presenting) {
      laser = false;
      laserEl.hidden = true;
      curSvg?.classList.remove('dg-spot');
    }
    setTimeout(fit, 20);
  }
  $('presBtn').onclick = () => togglePresent(!presenting);
  $('exitBtn').onclick = () => togglePresent(false);
  laserBtn.onclick = () => { laser = !laser; laserBtn.classList.toggle('active', laser); if (!laser) laserEl.hidden = true; };

  $('findBtn').onclick = () => { findBox.hidden = !findBox.hidden; if (!findBox.hidden) findIn.focus(); };
  $('findClose').onclick = () => { findBox.hidden = true; };
  findIn.oninput = () => {
    curSvg?.querySelectorAll('.dg-match,.dg-match-cur').forEach((e) => e.classList.remove('dg-match', 'dg-match-cur'));
    matches = []; matchIdx = -1;
    const q = findIn.value.trim().toLowerCase();
    if (!q || !curSvg) { findCnt.textContent = '0/0'; return; }
    curSvg.querySelectorAll('g.node, g.elem, g.cluster, text').forEach((el) => {
      if ((el.textContent || '').toLowerCase().includes(q)) {
        el.classList.add('dg-match');
        matches.push(el);
      }
    });
    if (matches.length) {
      matchIdx = 0;
      matches[0].classList.add('dg-match-cur');
      findCnt.textContent = '1/' + matches.length;
    } else {
      findCnt.textContent = '0/0';
    }
  };

  let dragging = false, sx = 0, sy = 0, moved = false;
  stage.onpointerdown = (e) => {
    if (e.button !== 0 || e.target.closest('#findBox,#minimap,#hud')) return;
    dragging = true; moved = false; sx = e.clientX - panX; sy = e.clientY - panY;
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointermove = (e) => {
    if (presenting && laser) { laserEl.hidden = false; laserEl.style.left = e.clientX + 'px'; laserEl.style.top = e.clientY + 'px'; }
    if (!dragging) return;
    moved = true; panX = e.clientX - sx; panY = e.clientY - sy; applyTf();
  };
  stage.onpointerup = () => { dragging = false; stage.classList.remove('dragging'); };
  stage.onclick = (e) => {
    if (!presenting || moved || !curSvg) return;
    const nd = e.target instanceof Element ? e.target.closest('g.node, g.elem, g.cluster, g.edgePath') : null;
    curSvg.querySelectorAll('.dg-spot-on').forEach((x) => x.classList.remove('dg-spot-on'));
    if (nd) { curSvg.classList.add('dg-spot'); nd.classList.add('dg-spot-on'); }
    else { curSvg.classList.remove('dg-spot'); }
  };
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(zoom * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  window.onkeydown = (e) => {
    if (e.target === findIn) {
      if (e.key === 'Escape') findBox.hidden = true;
      else if (e.key === 'Enter' && matches.length) {
        matches[matchIdx]?.classList.remove('dg-match-cur');
        matchIdx = (matchIdx + 1) % matches.length;
        matches[matchIdx].classList.add('dg-match-cur');
        findCnt.textContent = (matchIdx + 1) + '/' + matches.length;
      }
      return;
    }
    if (e.key === 'Escape' && stepIdx >= 0) clearStep();
    else if (e.key === 'Escape' && presenting) togglePresent(false);
    else if (e.key === 'ArrowRight' && (PAGES[pageIdx].steps || []).length) { e.preventDefault(); applyStep(stepIdx < 0 ? 0 : stepIdx + 1); }
    else if (e.key === 'ArrowLeft' && (PAGES[pageIdx].steps || []).length) { e.preventDefault(); applyStep(stepIdx <= 0 ? PAGES[pageIdx].steps.length - 1 : stepIdx - 1); }
    else if (e.key === 'f') fit();
    else if (e.key === '0') zoomAt(1);
    else if (e.key === '+' || e.key === '=') zoomAt(zoom * 1.25);
    else if (e.key === '-') zoomAt(zoom / 1.25);
    else if (e.key === 'm') $('mapBtn').click();
    else if (e.key === 'p') togglePresent(!presenting);
    else if (e.key === 'l' && presenting) laserBtn.click();
    else if (e.key === '/') { e.preventDefault(); findBox.hidden = false; findIn.focus(); }
  };
  window.onresize = fit;
  loadPage(0);
})();
</script>
</body>
</html>`;
}
