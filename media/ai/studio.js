// @ts-check
// Interactive AI Diagram Studio webview controller:
// - 5 modes: Generate, Modify, Optimize, Fix Syntax, Explain & Architecture Review
// - Live streaming code & Markdown view + rendered SVG preview (Mermaid / Draw.io / DOT / WaveDrom / PlantUML)
// - Safe DOM construction (no unsafe innerHTML) + integrated slide-in DrawGraph Settings Drawer
(function () {
  // @ts-ignore injected by VS Code webview runtime
  const vscode = acquireVsCodeApi();
  // @ts-ignore loaded from media/vendor/mermaid.min.js
  const mermaid = window.mermaid;

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const headerTitleText = $('headerTitleText');
  const providerBadge = $('providerBadge');
  const clearSessionBtn = /** @type {HTMLButtonElement} */ ($('clearSessionBtn'));
  const settingsBtn = /** @type {HTMLButtonElement} */ ($('settingsBtn'));
  const modeBar = $('modeBar');
  const formatPickerWrap = $('formatPickerWrap');
  const lblFormat = $('lblFormat');
  const formatSelect = /** @type {HTMLSelectElement} */ ($('formatSelect'));
  const lblTarget = $('lblTarget');
  const targetBadge = $('targetBadge');
  const pagePickerWrap = document.getElementById('pagePickerWrap');
  const lblPage = document.getElementById('lblPage');
  const pageSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('pageSelect'));
  const guidelinesBadge = document.getElementById('guidelinesBadge');
  const versionHistoryBar = document.getElementById('versionHistoryBar');
  const previewZoomBar = document.getElementById('previewZoomBar');
  const studioZoomOut = document.getElementById('studioZoomOut');
  const studioZoomReset = document.getElementById('studioZoomReset');
  const studioZoomIn = document.getElementById('studioZoomIn');
  const studioZoomFit = document.getElementById('studioZoomFit');
  const codeContextWrap = $('codeContextWrap');
  const includeCodeChk = /** @type {HTMLInputElement} */ ($('includeCodeChk'));
  const codeContextText = $('codeContextText');
  const optimizePresetsBar = $('optimizePresetsBar');
  const welcomeView = $('welcomeView');
  const welcomeTitle = $('welcomeTitle');
  const welcomeSub = $('welcomeSub');
  const starterChips = $('starterChips');
  const errorBanner = $('errorBanner');
  const errorText = $('errorText');
  const retryRunBtn = /** @type {HTMLButtonElement} */ ($('retryRunBtn'));
  const statusBanner = $('statusBanner');
  const resultContainer = $('resultContainer');
  const diagramOutputSection = $('diagramOutputSection');
  const tabPreviewBtn = /** @type {HTMLButtonElement} */ ($('tabPreviewBtn'));
  const tabSourceBtn = /** @type {HTMLButtonElement} */ ($('tabSourceBtn'));
  const applyBtn = /** @type {HTMLButtonElement} */ ($('applyBtn'));
  const diffBtn = /** @type {HTMLButtonElement} */ ($('diffBtn'));
  const openNewBtn = /** @type {HTMLButtonElement} */ ($('openNewBtn'));
  const copyCodeBtn = /** @type {HTMLButtonElement} */ ($('copyCodeBtn'));
  const previewCanvas = $('previewCanvas');
  const sourceCodeView = $('sourceCodeView');
  const findingsSection = $('findingsSection');
  const findingsTitle = $('findingsTitle');
  const findingsList = $('findingsList');
  const explanationBox = $('explanationBox');
  const promptInput = /** @type {HTMLTextAreaElement} */ ($('promptInput'));
  const stopBtn = /** @type {HTMLButtonElement} */ ($('stopBtn'));
  const runBtn = /** @type {HTMLButtonElement} */ ($('runBtn'));

  // @ts-ignore injected by media/shared/settingsDrawer.js
  const settingsDrawer = window.createDrawGraphSettingsDrawer
    ? // @ts-ignore
      window.createDrawGraphSettingsDrawer({
        postMessage: (/** @type {any} */ m) => vscode.postMessage(m),
      })
    : null;

  /** @type {Record<string, string>} */
  let strings = {};
  /** @type {'generate' | 'modify' | 'optimize' | 'fix' | 'explain'} */
  let currentMode = 'generate';
  /** @type {'mermaid' | 'plantuml' | 'drawio' | 'dot' | 'wavedrom' | 'd2'} */
  let currentFormat = 'mermaid';
  /** @type {'layout' | 'style' | 'simplify' | 'resilience' | 'translate'} */
  let currentPreset = 'layout';
  /** @type {'preview' | 'source'} */
  let activeOutputTab = 'preview';
  /** @type {'welcome' | 'streaming_thinking' | 'streaming_output' | 'result_diagram' | 'result_explain' | 'error'} */
  let studioUiPhase = 'welcome';
  let latestCode = '';
  let hasPriorResult = false;
  /** @type {{ uri: string; label: string; format: string; hasDiagnostics: boolean; diagnostics: string; pages?: string[]; selectedPageIndex?: number } | null} */
  let boundTarget = null;
  let currentMermaidTheme = 'default';
  let currentMermaidLook = 'classic';
  let studioZoom = 1;
  /** @type {Array<{ id: number; label: string; format: string }>} */
  let studioVersions = [];
  let activeVersionId = 0;
  let renderSeq = 0;

  /**
   * Single source of truth for AI Studio UI visibility & button states.
   * @param {'welcome' | 'streaming_thinking' | 'streaming_output' | 'result_diagram' | 'result_explain' | 'error'} next
   * @param {string} [detail]
   */
  function transitionStudioUiPhase(next, detail) {
    studioUiPhase = next;
    const isStreaming = next === 'streaming_thinking' || next === 'streaming_output';
    runBtn.disabled = isStreaming;
    stopBtn.hidden = !isStreaming;
    welcomeView.hidden = next !== 'welcome';
    errorBanner.hidden = next !== 'error';

    if (next === 'error') {
      errorText.textContent = detail || 'AI request failed.';
      statusBanner.hidden = true;
      resultContainer.hidden = !hasPriorResult;
      return;
    }

    if (next === 'welcome') {
      statusBanner.hidden = true;
      resultContainer.hidden = true;
      return;
    }

    if (isStreaming) {
      statusBanner.hidden = false;
      statusBanner.textContent =
        next === 'streaming_thinking'
          ? `🧠 ${tr('thinkingStatus', 'Reasoning & planning topology ({0})…').replace('{0}', detail || 'AI')}`
          : tr('streamingStatus', 'Generating with {0}…').replace('{0}', detail || 'AI');
      resultContainer.hidden = false;
      return;
    }

    statusBanner.hidden = true;
    resultContainer.hidden = false;
  }

  /** @param {string} key @param {string} [fallback] */
  function tr(key, fallback) {
    return strings[key] || fallback || key;
  }

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {Record<string, any> | null} [props]
   * @param {...(Node | string | null | undefined | false)} children
   * @returns {HTMLElementTagNameMap[K]}
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'className') el.className = String(v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function sanitizeAndMountSvg(/** @type {string} */ svgMarkup) {
    previewCanvas.replaceChildren();
    if (!svgMarkup || !svgMarkup.trim()) {
      return;
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      previewCanvas.appendChild(h('div', { className: 'previewFallbackMsg' }, tr('tabSource', 'Source Code')));
      return;
    }
    root.querySelectorAll('script, foreignObject script').forEach((n) => n.remove());
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    const imported = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.importNode(root, true)));
    const vb = imported.viewBox && imported.viewBox.baseVal;
    const natW = (vb && vb.width > 0 ? vb.width : parseFloat(imported.getAttribute('width') || '0')) || 600;
    const natH = (vb && vb.height > 0 ? vb.height : parseFloat(imported.getAttribute('height') || '0')) || 400;
    imported.dataset.natW = String(natW);
    imported.dataset.natH = String(natH);
    previewCanvas.appendChild(imported);
    fitStudioZoom();
  }

  function applyStudioZoom() {
    const svg = previewCanvas.querySelector('svg');
    if (svg) {
      const natW = parseFloat(svg.dataset.natW || '0') || 600;
      const natH = parseFloat(svg.dataset.natH || '0') || 400;
      svg.style.transform = '';
      svg.style.width = `${Math.round(natW * studioZoom)}px`;
      svg.style.height = `${Math.round(natH * studioZoom)}px`;
      svg.style.maxWidth = 'none';
    }
    if (studioZoomReset) {
      studioZoomReset.textContent = `${Math.round(studioZoom * 100)}%`;
    }
  }

  function fitStudioZoom() {
    const svg = previewCanvas.querySelector('svg');
    if (!svg) {
      studioZoom = 1;
      applyStudioZoom();
      return;
    }
    const natW = parseFloat(svg.dataset.natW || '0') || 600;
    const natH = parseFloat(svg.dataset.natH || '0') || 400;
    const availW = Math.max(120, (previewCanvas.clientWidth || 480) - 28);
    const availH = Math.max(120, Math.min(410, (previewCanvas.clientHeight || 360) - 28));
    studioZoom = Math.min(1, Math.max(0.2, Math.min(availW / natW, availH / natH)));
    applyStudioZoom();
  }

  function renderVersionHistoryBar() {
    if (!versionHistoryBar) {
      return;
    }
    versionHistoryBar.replaceChildren();
    if (!Array.isArray(studioVersions) || studioVersions.length <= 1) {
      versionHistoryBar.hidden = true;
      return;
    }
    versionHistoryBar.hidden = false;
    for (const v of studioVersions) {
      const pill = h(
        'button',
        {
          type: 'button',
          className: `versionPill${v.id === activeVersionId ? ' active' : ''}`,
          onClick: () => vscode.postMessage({ type: 'selectVersion', versionId: v.id }),
        },
        `${v.label} (${v.format})`,
      );
      versionHistoryBar.appendChild(pill);
    }
    const idx = studioVersions.findIndex((v) => v.id === activeVersionId);
    if (idx > 0) {
      const prev = studioVersions[idx - 1];
      const cur = studioVersions[idx];
      if (prev.format === cur.format) {
        versionHistoryBar.appendChild(
          h(
            'button',
            {
              type: 'button',
              className: 'secondaryActionBtn',
              onClick: () => vscode.postMessage({ type: 'compareVersions', fromId: prev.id, toId: cur.id }),
            },
            tr('diffVersions', 'Diff {0} ↔ {1}').replace('{0}', prev.label).replace('{1}', cur.label),
          ),
        );
      }
    }
  }

  async function renderDiagramPreview(/** @type {{ renderKind: string; payload: string; mermaidTheme?: string; mermaidLook?: string }} */ preview) {
    if (!preview || !preview.payload) {
      previewCanvas.replaceChildren();
      return;
    }
    if (preview.renderKind === 'mermaid' && mermaid) {
      try {
        const theme = preview.mermaidTheme || currentMermaidTheme || 'default';
        const look = preview.mermaidLook || currentMermaidLook || 'classic';
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'auto' ? (document.body.classList.contains('vscode-dark') ? 'dark' : 'default') : theme,
          look: look === 'handDrawn' ? 'handDrawn' : 'classic',
        });
        const id = `aiStudioMmd_${++renderSeq}`;
        const out = await mermaid.render(id, preview.payload);
        sanitizeAndMountSvg(out.svg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        previewCanvas.replaceChildren(h('pre', { className: 'previewErrorText' }, msg));
      }
      return;
    }
    sanitizeAndMountSvg(preview.payload);
  }

  function renderMarkdownSafe(/** @type {HTMLElement} */ container, /** @type {string} */ md) {
    container.replaceChildren();
    if (!md || !md.trim()) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    /** @type {HTMLUListElement | null} */
    let ul = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        ul = null;
        continue;
      }
      if (line.startsWith('### ')) {
        ul = null;
        container.appendChild(h('h4', null, line.slice(4)));
      } else if (line.startsWith('## ')) {
        ul = null;
        container.appendChild(h('h3', null, line.slice(3)));
      } else if (line.startsWith('# ')) {
        ul = null;
        container.appendChild(h('h3', null, line.slice(2)));
      } else if (/^[-*]\s+/.test(line)) {
        // Skip raw `[HIGH]` finding lines when findings cards are already shown
        if (/^[-*]\s*\[(HIGH|MEDIUM|LOW|INFO)\]/i.test(line) && !findingsSection.hidden) {
          continue;
        }
        if (!ul) {
          ul = h('ul', null);
          container.appendChild(ul);
        }
        ul.appendChild(renderInlineBoldCode('li', line.replace(/^[-*]\s+/, '')));
      } else {
        ul = null;
        container.appendChild(renderInlineBoldCode('p', line));
      }
    }
  }

  /**
   * @param {'p' | 'li' | 'span'} tag
   * @param {string} text
   */
  function renderInlineBoldCode(tag, text) {
    const el = document.createElement(tag);
    const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIdx = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > lastIdx) {
        el.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      const tok = m[0];
      if (tok.startsWith('**')) {
        el.appendChild(h('strong', null, tok.slice(2, -2)));
      } else {
        el.appendChild(h('code', null, tok.slice(1, -1)));
      }
      lastIdx = m.index + tok.length;
    }
    if (lastIdx < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    return el;
  }

  function renderFindings(/** @type {Array<{ severity: string; subject: string; title: string; detail: string }>} */ findings) {
    findingsList.replaceChildren();
    if (!Array.isArray(findings) || findings.length === 0) {
      findingsSection.hidden = true;
      return;
    }
    findingsSection.hidden = false;
    for (const f of findings) {
      const sev = (f.severity || 'INFO').toUpperCase();
      const card = h(
        'div',
        { className: `findingCard sev-${sev.toLowerCase()}` },
        h(
          'div',
          { className: 'findingHead' },
          h('span', { className: `sevBadge sev-${sev.toLowerCase()}` }, sev),
          f.subject ? h('code', { className: 'findingSubject' }, f.subject) : null,
          h('strong', { className: 'findingTitle' }, f.title),
        ),
        f.detail ? h('p', { className: 'findingDetail' }, f.detail) : null,
      );
      findingsList.appendChild(card);
    }
  }

  function buildStarterChips() {
    starterChips.replaceChildren();
    /** @type {Array<{ format: 'mermaid' | 'drawio' | 'plantuml' | 'dot' | 'wavedrom'; label: string }>} */
    const chips = [
      { format: 'mermaid', label: tr('chipMicroservices', 'E-commerce microservices with API Gateway, Auth, Order, Kafka & PostgreSQL') },
      { format: 'drawio', label: tr('chipSequence', 'OAuth 2.0 Authorization Code + PKCE login sequence diagram') },
      { format: 'mermaid', label: tr('chipEr', 'Multi-tenant SaaS ER schema (Organizations, Users, Subscriptions, Invoices)') },
      { format: 'plantuml', label: tr('chipState', 'Distributed payment order state machine with retries, refund & compensation') },
      { format: 'wavedrom', label: tr('chipWave', 'SPI / AXI4-Lite read transaction digital timing waveform') },
    ];
    for (const ch of chips) {
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'starterChip',
          onClick: () => {
            currentMode = 'generate';
            currentFormat = ch.format;
            formatSelect.value = ch.format;
            promptInput.value = ch.label;
            syncModeUi();
            promptInput.focus();
          },
        },
        h('span', { className: 'chipFormatTag' }, ch.format.toUpperCase()),
        h('span', null, ch.label),
      );
      starterChips.appendChild(btn);
    }
  }

  function syncOutputTabs() {
    const showPreview = activeOutputTab === 'preview';
    tabPreviewBtn.classList.toggle('active', showPreview);
    tabSourceBtn.classList.toggle('active', !showPreview);
    previewCanvas.hidden = !showPreview;
    sourceCodeView.hidden = showPreview;
    if (previewZoomBar) {
      previewZoomBar.hidden = !showPreview;
    }
  }

  function syncModeUi() {
    modeBar.querySelectorAll('.modeTab').forEach((btn) => {
      const m = btn.getAttribute('data-mode');
      btn.classList.toggle('active', m === currentMode);
    });

    optimizePresetsBar.hidden = currentMode !== 'optimize';
    optimizePresetsBar.querySelectorAll('.presetPill').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === currentPreset);
    });

    // Keep format selector unlocked for Generate, Modify, and Optimize (supports cross-format AI re-draw)
    formatPickerWrap.hidden = currentMode === 'explain' || (currentMode === 'fix' && Boolean(boundTarget));
    if (boundTarget && currentMode !== 'generate') {
      targetBadge.textContent = `${boundTarget.label} (${boundTarget.format})`;
      targetBadge.classList.toggle('hasError', Boolean(boundTarget.hasDiagnostics));
    } else {
      targetBadge.textContent = tr('noActiveDiagram', 'New Diagram');
      targetBadge.classList.remove('hasError');
    }
    if (pagePickerWrap && pageSelect) {
      const pages = boundTarget && boundTarget.format === 'drawio' && currentMode !== 'generate' ? boundTarget.pages || [] : [];
      if (pages.length > 1) {
        pagePickerWrap.hidden = false;
        pageSelect.replaceChildren(
          ...pages.map((name, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = `${idx + 1}/${pages.length}: ${name}`;
            opt.selected = idx === (boundTarget?.selectedPageIndex ?? 0);
            return opt;
          }),
        );
      } else {
        pagePickerWrap.hidden = true;
      }
    }

    const placeholders = {
      generate: tr('phGenerate'),
      modify: tr('phModify'),
      optimize: tr('phOptimize'),
      fix: tr('phFix'),
      explain: tr('phExplain'),
    };
    promptInput.placeholder = placeholders[currentMode] || placeholders.generate;
  }

  function triggerRun() {
    if (studioUiPhase === 'streaming_thinking' || studioUiPhase === 'streaming_output') return;
    const prompt = promptInput.value.trim();
    if ((currentMode === 'generate' || currentMode === 'modify') && !prompt && !includeCodeChk.checked) {
      promptInput.focus();
      return;
    }
    vscode.postMessage({
      type: 'run',
      mode: currentMode,
      format: formatSelect.value,
      prompt,
      optimizePreset: currentPreset,
      includeCodeContext: !codeContextWrap.hidden && includeCodeChk.checked,
      pageIndex: pageSelect && !pagePickerWrap?.hidden ? Number(pageSelect.value) || 0 : undefined,
    });
  }

  modeBar.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement | null} */ (ev.target instanceof HTMLElement ? ev.target.closest('.modeTab') : null);
    if (!btn) return;
    const next = /** @type {typeof currentMode | null} */ (btn.getAttribute('data-mode'));
    if (next) {
      currentMode = next;
      if (next !== 'generate' && boundTarget) {
        currentFormat = /** @type {typeof currentFormat} */ (boundTarget.format);
        formatSelect.value = currentFormat;
      }
      syncModeUi();
    }
  });

  optimizePresetsBar.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement | null} */ (ev.target instanceof HTMLElement ? ev.target.closest('.presetPill') : null);
    if (!btn) return;
    const preset = /** @type {typeof currentPreset | null} */ (btn.getAttribute('data-preset'));
    if (preset) {
      currentPreset = preset;
      syncModeUi();
    }
  });

  formatSelect.addEventListener('change', () => {
    currentFormat = /** @type {typeof currentFormat} */ (formatSelect.value);
  });

  tabPreviewBtn.addEventListener('click', () => {
    activeOutputTab = 'preview';
    syncOutputTabs();
  });

  tabSourceBtn.addEventListener('click', () => {
    activeOutputTab = 'source';
    syncOutputTabs();
  });

  studioZoomOut?.addEventListener('click', () => {
    studioZoom = Math.max(0.25, studioZoom / 1.25);
    applyStudioZoom();
  });
  studioZoomIn?.addEventListener('click', () => {
    studioZoom = Math.min(4, studioZoom * 1.25);
    applyStudioZoom();
  });
  studioZoomReset?.addEventListener('click', () => {
    studioZoom = 1;
    applyStudioZoom();
  });
  studioZoomFit?.addEventListener('click', () => {
    fitStudioZoom();
  });
  guidelinesBadge?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openStyleGuide' });
  });

  runBtn.addEventListener('click', triggerRun);
  retryRunBtn.addEventListener('click', triggerRun);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  clearSessionBtn.addEventListener('click', () => {
    latestCode = '';
    hasPriorResult = false;
    promptInput.value = '';
    transitionStudioUiPhase('welcome');
    vscode.postMessage({ type: 'clearHistory' });
  });

  const openSettings = () => {
    if (settingsDrawer) {
      settingsDrawer.toggle();
    }
  };
  settingsBtn.addEventListener('click', openSettings);
  providerBadge.addEventListener('click', openSettings);

  applyBtn.addEventListener('click', () => {
    if (!latestCode) return;
    vscode.postMessage({ type: 'applyResult', code: latestCode, format: currentFormat });
    const orig = applyBtn.textContent;
    applyBtn.textContent = `✓ ${tr('appliedToast', 'Applied!')}`;
    setTimeout(() => {
      applyBtn.textContent = orig;
    }, 1400);
  });

  diffBtn.addEventListener('click', () => {
    if (!latestCode) return;
    vscode.postMessage({ type: 'previewDiff', code: latestCode, format: currentFormat });
  });

  openNewBtn.addEventListener('click', () => {
    if (!latestCode) return;
    vscode.postMessage({ type: 'openAsNew', code: latestCode, format: currentFormat });
  });

  copyCodeBtn.addEventListener('click', () => {
    if (!latestCode) return;
    vscode.postMessage({ type: 'copyCode', code: latestCode });
    const orig = copyCodeBtn.textContent;
    copyCodeBtn.textContent = `✓ ${tr('copiedToast', 'Copied!')}`;
    setTimeout(() => {
      copyCodeBtn.textContent = orig;
    }, 1200);
  });

  promptInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      triggerRun();
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'settingsState':
        if (settingsDrawer && msg.settings) {
          settingsDrawer.setState(msg.settings);
        }
        break;

      case 'studioState': {
        strings = msg.strings || strings;
        if (msg.settings && settingsDrawer) {
          settingsDrawer.setState(msg.settings);
        }
        if (msg.mermaidTheme) {
          currentMermaidTheme = msg.mermaidTheme;
        }
        if (msg.mermaidLook) {
          currentMermaidLook = msg.mermaidLook;
        }
        if (guidelinesBadge) {
          guidelinesBadge.hidden = false;
          guidelinesBadge.classList.toggle('is-loaded', Boolean(msg.hasStyleGuide));
          guidelinesBadge.textContent = msg.hasStyleGuide
            ? `✓ ${tr('styleGuideLoaded', 'Style Guide')}`
            : tr('styleGuideCreate', '+ Style Guide');
        }
        if (lblPage) {
          lblPage.textContent = `${tr('lblPage', 'Page')}:`;
        }
        if (studioZoomFit) {
          studioZoomFit.textContent = tr('btnFit', 'Fit');
        }
        if (Array.isArray(msg.versions)) {
          studioVersions = msg.versions;
          activeVersionId = Number(msg.activeVersionId) || 0;
          renderVersionHistoryBar();
        }
        boundTarget = msg.target || null;
        if (msg.mode) currentMode = msg.mode;
        if (msg.format) {
          currentFormat = msg.format;
          formatSelect.value = msg.format;
        }
        if (msg.optimizePreset) currentPreset = msg.optimizePreset;
        if (typeof msg.initialPrompt === 'string') {
          promptInput.value = msg.initialPrompt;
        }

        headerTitleText.textContent = tr('studioTitle', 'AI Diagram Studio');
        providerBadge.textContent = msg.model && msg.model !== msg.provider ? `${msg.provider} · ${msg.model}` : msg.provider;
        providerBadge.classList.toggle('needsKey', Boolean(msg.requiresApiKey && !msg.hasApiKey));
        clearSessionBtn.title = tr('btnClearChat', 'Reset Session');
        settingsBtn.title = tr('btnSettings', 'AI Settings');

        const modeLabels = {
          generate: tr('modeGenerate', 'Generate'),
          modify: tr('modeModify', 'Modify'),
          optimize: tr('modeOptimize', 'Optimize'),
          fix: tr('modeFix', 'Fix Syntax'),
          explain: tr('modeExplain', 'Explain & Review'),
        };
        modeBar.querySelectorAll('.modeTab').forEach((btn) => {
          const k = /** @type {keyof typeof modeLabels} */ (btn.getAttribute('data-mode'));
          if (k && modeLabels[k]) btn.textContent = modeLabels[k];
        });

        const presetLabels = {
          layout: tr('presetLayout', 'Layout & Subgraphs'),
          style: tr('presetStyle', 'Visual Styling'),
          simplify: tr('presetSimplify', 'Simplify'),
          resilience: tr('presetResilience', 'Resilience & Retries'),
          translate: tr('presetTranslate', 'Translate Labels'),
        };
        optimizePresetsBar.querySelectorAll('.presetPill').forEach((btn) => {
          const k = /** @type {keyof typeof presetLabels} */ (btn.getAttribute('data-preset'));
          if (k && presetLabels[k]) btn.textContent = presetLabels[k];
        });

        lblFormat.textContent = tr('lblFormat', 'Format');
        lblTarget.textContent = `${tr('lblTarget', 'Target')}:`;
        tabPreviewBtn.textContent = tr('tabPreview', 'Live Preview');
        tabSourceBtn.textContent = tr('tabSource', 'Source Code');
        applyBtn.textContent = tr('btnApply', 'Apply to Active Diagram');
        diffBtn.textContent = tr('btnVisualDiff', 'Visual Diff (Before ↔ After)');
        openNewBtn.textContent = tr('btnOpenNew', 'Open as New Diagram');
        copyCodeBtn.textContent = tr('btnCopyCode', 'Copy Code');
        runBtn.textContent = `✨ ${tr('btnRun', 'Run AI')}`;
        retryRunBtn.textContent = tr('btnRetry', 'Retry');
        stopBtn.textContent = tr('btnStop', 'Stop');
        welcomeTitle.textContent = tr('emptyWelcomeTitle');
        welcomeSub.textContent = tr('emptyWelcomeSub');
        findingsTitle.textContent = tr('findingsTitle', 'Architecture Findings');

        if (msg.codeContextLabel) {
          codeContextWrap.hidden = false;
          codeContextText.textContent = tr('chkIncludeCode', 'Include code context ({0})').replace('{0}', msg.codeContextLabel);
        } else {
          codeContextWrap.hidden = true;
        }

        buildStarterChips();
        syncModeUi();
        break;
      }

      case 'streamStart': {
        transitionStudioUiPhase('streaming_output', msg.providerLabel || 'AI');
        findingsSection.hidden = true;
        if (msg.mode === 'explain') {
          diagramOutputSection.hidden = true;
          explanationBox.hidden = false;
          explanationBox.textContent = '…';
        } else {
          diagramOutputSection.hidden = false;
          activeOutputTab = 'source';
          syncOutputTabs();
          sourceCodeView.textContent = '';
          explanationBox.hidden = true;
        }
        break;
      }

      case 'streamChunk': {
        transitionStudioUiPhase(msg.thinking ? 'streaming_thinking' : 'streaming_output', msg.providerLabel || 'AI');
        if (msg.mode === 'explain') {
          renderMarkdownSafe(explanationBox, msg.explanation || '');
        } else {
          if (typeof msg.code === 'string' && msg.code) {
            latestCode = msg.code;
            sourceCodeView.textContent = msg.code;
          }
          if (typeof msg.explanation === 'string' && msg.explanation) {
            renderMarkdownSafe(explanationBox, msg.explanation);
          }
        }
        break;
      }

      case 'streamComplete': {
        hasPriorResult = true;
        if (msg.mode === 'explain') {
          transitionStudioUiPhase('result_explain');
          diagramOutputSection.hidden = true;
          renderFindings(msg.findings || []);
          renderMarkdownSafe(explanationBox, msg.explanation || '');
        } else {
          transitionStudioUiPhase('result_diagram');
          latestCode = msg.code || '';
          currentFormat = msg.format || currentFormat;
          diagramOutputSection.hidden = !latestCode;
          sourceCodeView.textContent = latestCode;
          activeOutputTab = 'preview';
          syncOutputTabs();
          applyBtn.hidden = !msg.canApplyToTarget;
          diffBtn.hidden = !msg.canApplyToTarget;
          if (Array.isArray(msg.versions)) {
            studioVersions = msg.versions;
            activeVersionId = Number(msg.activeVersionId) || 0;
            renderVersionHistoryBar();
          }
          studioZoom = 1;
          void renderDiagramPreview(msg.preview);
          renderFindings([]);
          renderMarkdownSafe(explanationBox, msg.explanation || '');
        }
        break;
      }

      case 'streamCancelled': {
        if (hasPriorResult || latestCode) {
          transitionStudioUiPhase(currentMode === 'explain' ? 'result_explain' : 'result_diagram');
        } else {
          transitionStudioUiPhase('welcome');
        }
        break;
      }

      case 'streamError': {
        transitionStudioUiPhase('error', msg.message || 'AI request failed.');
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
