// @ts-check
// Slide-in Settings Drawer shared by Draw.io custom editors, Diagram Previews, and the
// standalone DrawGraph Settings view. Supports instant bilingual switching (简体中文 / English).
(function () {
  const CLOSE_SVG =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>';

  /** @type {Record<'en' | 'zh-cn', Record<string, string>>} */
  const STRINGS = {
    en: {
      title: 'DrawGraph Settings',
      close: 'Close (Esc)',
      secLang: 'Language · Global',
      langFollow: 'Follow VS Code (Current: {0})',
      secDrawio: 'Draw.io Editor',
      lblTheme: 'Editor Theme',
      optAuto: 'Follow Editor',
      optLight: 'Light',
      optDark: 'Dark',
      lblUi: 'UI Layout',
      uiKennedy: 'Classic',
      uiSimple: 'Simple',
      uiMin: 'Compact',
      uiAtlas: 'Atlas',
      uiSketch: 'Sketch',
      lblSvgColor: 'SVG Colors',
      svgAuto: 'Adaptive',
      svgLight: 'Light',
      svgDark: 'Dark',
      chkHideGh: 'Hide bottom-right GitHub icon',
      chkShortcuts: 'Forward common VS Code shortcuts',
      lblDrawioUrl: 'Draw.io URL:',
      secPreview: 'Mermaid & Diagram Preview',
      lblMermaidTheme: 'Mermaid Theme',
      mmdDefault: 'Default',
      mmdForest: 'Forest',
      mmdNeutral: 'Neutral',
      lblPngScale: 'PNG Scale',
      chkFollow: 'Auto-follow active diagram editor',
      chkTransparent: 'Transparent PNG export background',
      chkCodeLens: 'Show editor CodeLens actions',
      chkQuickMenu: 'Show colorful top-right toolbar icon',
      secPlantuml: 'PlantUML & Markdown',
      lblRender: 'Render Engine',
      rndAuto: 'Auto',
      rndLocal: 'Local JAR',
      rndServer: 'Server',
      lblExportSave: 'Export on Save',
      expOff: 'Off',
      chkMdMermaid: 'Render Mermaid in Markdown preview',
      chkMdPlantuml: 'Render PlantUML in Markdown preview',
      lblPumlServer: 'Server URL:',
      lblPumlJar: 'plantuml.jar:',
      phJar: '/path/to/plantuml.jar (optional)',
      untrustedNote: 'Workspace is untrusted: server URLs and local JAR paths are read-only.',
      openVscodeSettings: 'Open Full DrawGraph Settings in VS Code',
    },
    'zh-cn': {
      title: 'DrawGraph 设置',
      close: '关闭 (Esc)',
      secLang: '界面语言 · 全局生效',
      langFollow: '跟随 VS Code（当前：{0}）',
      secDrawio: 'Draw.io 可视化编辑器',
      lblTheme: '编辑器主题',
      optAuto: '跟随编辑器',
      optLight: '浅色',
      optDark: '深色',
      lblUi: '界面布局',
      uiKennedy: '经典 Kennedy',
      uiSimple: '简约 Simple',
      uiMin: '紧凑 Min',
      uiAtlas: '极简 Atlas',
      uiSketch: '手绘 Sketch',
      lblSvgColor: 'SVG 导出配色',
      svgAuto: '自适应',
      svgLight: '固定浅色',
      svgDark: '固定深色',
      chkHideGh: '隐藏右下角 GitHub 小图标',
      chkShortcuts: '透传常用 VS Code 快捷键',
      lblDrawioUrl: '服务地址：',
      secPreview: 'Mermaid 与图表预览',
      lblMermaidTheme: 'Mermaid 主题',
      mmdDefault: '默认',
      mmdForest: '森林',
      mmdNeutral: '中性',
      lblPngScale: 'PNG 导出倍率',
      chkFollow: '预览窗口自动跟随当前编辑器',
      chkTransparent: '导出 PNG 使用透明背景',
      chkCodeLens: '显示编辑器上方 CodeLens 快捷入口',
      chkQuickMenu: '显示右上角彩色快捷菜单图标',
      secPlantuml: 'PlantUML 渲染与自动导出',
      lblRender: '渲染方式',
      rndAuto: '自动',
      rndLocal: '本地 JAR',
      rndServer: '在线服务器',
      lblExportSave: '保存时自动导出',
      expOff: '关闭',
      chkMdMermaid: '渲染 Markdown 中的 Mermaid',
      chkMdPlantuml: '渲染 Markdown 中的 PlantUML',
      lblPumlServer: '服务器地址：',
      lblPumlJar: 'plantuml.jar：',
      phJar: '/path/to/plantuml.jar（留空则用服务器）',
      untrustedNote: '当前工作区不受信任：外部服务地址与本地 JAR 路径处于只读保护状态。',
      openVscodeSettings: '在 VS Code 设置页中查看全部 DrawGraph 配置',
    },
  };

  /** @param {string} s */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * @param {{ postMessage: (msg: any) => void, standalone?: boolean, onVisibilityChange?: (open: boolean) => void }} opts
   */
  function createDrawGraphSettingsDrawer(opts) {
    const standalone = opts.standalone === true;
    /** @type {any} */
    let state = null;
    let visible = standalone;

    const backdrop = document.createElement('div');
    backdrop.id = 'settingsBackdrop';
    if (!standalone) {
      document.body.appendChild(backdrop);
    }

    const widget = document.createElement('div');
    widget.id = 'settingsWidget';
    if (standalone) {
      widget.classList.add('standalone', 'active');
    }
    widget.innerHTML =
      '<div id="settingsHeader">' +
      '<h2 id="settingsTitle"></h2>' +
      '<div id="settingsLangQuick" role="radiogroup">' +
      '<button type="button" data-lang="Simplified Chinese">中</button>' +
      '<button type="button" data-lang="English">EN</button>' +
      '</div>' +
      (standalone ? '' : `<button type="button" id="settingsClose">${CLOSE_SVG}</button>`) +
      '</div>' +
      '<div id="settingsContent"></div>' +
      '<div id="settingsFooter"><button type="button" id="openExtSettingsBtn" class="settingsLink"></button></div>';
    document.body.appendChild(widget);

    const titleEl = /** @type {HTMLElement} */ (widget.querySelector('#settingsTitle'));
    const langQuick = /** @type {HTMLElement} */ (widget.querySelector('#settingsLangQuick'));
    const contentEl = /** @type {HTMLElement} */ (widget.querySelector('#settingsContent'));
    const openExtBtn = /** @type {HTMLButtonElement} */ (widget.querySelector('#openExtSettingsBtn'));
    const closeBtn = /** @type {HTMLButtonElement | null} */ (widget.querySelector('#settingsClose'));

    /** @returns {'en' | 'zh-cn'} */
    function activeLang() {
      if (!state) {
        return 'en';
      }
      if (state.language === 'Simplified Chinese') {
        return 'zh-cn';
      }
      if (state.language === 'English') {
        return 'en';
      }
      return /^zh\b/i.test(state.vscodeLanguage || '') ? 'zh-cn' : 'en';
    }

    /**
     * @param {string} key
     * @param {string} [arg0]
     */
    function tr(key, arg0) {
      const dict = STRINGS[activeLang()] || STRINGS.en;
      const raw = dict[key] || STRINGS.en[key] || key;
      return arg0 !== undefined ? raw.replace('{0}', arg0) : raw;
    }

    /**
     * @param {string} setting
     * @param {Array<[string, string]>} items
     * @param {string} current
     */
    function renderSegmented(setting, items, current) {
      return (
        `<div class="settingsSegmented" role="radiogroup" data-setting="${esc(setting)}">` +
        items
          .map(([val, label]) => {
            const sel = String(val) === String(current);
            return `<button type="button" role="radio" aria-checked="${sel}" class="settingsSegment${sel ? ' selected' : ''}" data-value="${esc(val)}">${esc(label)}</button>`;
          })
          .join('') +
        '</div>'
      );
    }

    /**
     * @param {string} setting
     * @param {string} label
     * @param {boolean} checked
     */
    function renderCheckbox(setting, label, checked) {
      return (
        `<label class="settingsCheckboxLabel">` +
        `<input type="checkbox" data-setting="${esc(setting)}"${checked ? ' checked' : ''}>` +
        `<span>${esc(label)}</span>` +
        `</label>`
      );
    }

    /** @param {string} key @param {any} value */
    function sendUpdate(key, value) {
      if (!state) {
        return;
      }
      // Optimistically apply to local state so UI feels instantaneous.
      if (key === 'language') {
        state.language = value;
        state.resolvedLanguage = activeLang();
      } else if (key.startsWith('drawio.')) {
        state.drawio[key.slice(7)] = value;
      } else if (key === 'mermaid.theme') {
        state.preview.mermaidTheme = value;
      } else if (key === 'preview.pngScale') {
        state.preview.pngScale = Number(value);
      } else if (key === 'preview.pngTransparent') {
        state.preview.pngTransparent = Boolean(value);
      } else if (key === 'preview.followActiveEditor') {
        state.preview.followActiveEditor = Boolean(value);
      } else if (key === 'editor.codeLens') {
        state.preview.codeLens = Boolean(value);
      } else if (key === 'toolbar.showQuickMenu') {
        state.preview.showQuickMenu = Boolean(value);
      } else if (key === 'plantuml.render') {
        state.plantuml.render = value;
      } else if (key === 'plantuml.server') {
        state.plantuml.server = value;
      } else if (key === 'plantuml.jar') {
        state.plantuml.jar = value;
      } else if (key === 'exportOnSave') {
        state.plantuml.exportOnSave = value;
      } else if (key === 'markdown.mermaid') {
        state.plantuml.markdownMermaid = Boolean(value);
      } else if (key === 'markdown.plantuml') {
        state.plantuml.markdownPlantuml = Boolean(value);
      }
      opts.postMessage({ type: 'updateSetting', key, value });
      renderPreservingFocus();
    }

    function renderPreservingFocus() {
      const prevScroll = contentEl.scrollTop;
      const active = document.activeElement;
      const focusedField =
        active instanceof HTMLInputElement && active.dataset.textSetting
          ? {
              key: active.dataset.textSetting,
              val: active.value,
              start: active.selectionStart,
              end: active.selectionEnd,
            }
          : null;

      render();
      contentEl.scrollTop = prevScroll;

      if (focusedField) {
        const restored = /** @type {HTMLInputElement | null} */ (
          contentEl.querySelector(`input[data-text-setting="${focusedField.key}"]`)
        );
        if (restored) {
          restored.value = focusedField.val;
          restored.focus();
          if (focusedField.start !== null && focusedField.end !== null) {
            restored.setSelectionRange(focusedField.start, focusedField.end);
          }
        }
      }
    }

    function render() {
      if (!state) {
        return;
      }
      const eff = activeLang();
      titleEl.textContent = tr('title');
      if (closeBtn) {
        closeBtn.title = tr('close');
      }
      openExtBtn.textContent = tr('openVscodeSettings');

      langQuick.querySelectorAll('button').forEach((btn) => {
        const b = /** @type {HTMLButtonElement} */ (btn);
        const isZhBtn = b.dataset.lang === 'Simplified Chinese';
        const selected = (isZhBtn && eff === 'zh-cn') || (!isZhBtn && eff === 'en');
        b.classList.toggle('selected', selected);
      });

      const vscodeDisplay = /^zh\b/i.test(state.vscodeLanguage || '') ? '简体中文' : 'English';
      const langOptions = [
        ['Auto', tr('langFollow', vscodeDisplay)],
        ['Simplified Chinese', '简体中文'],
        ['English', 'English'],
      ];

      const dis = state.isTrusted ? '' : ' disabled';

      let html = '';
      // 1. Language
      html +=
        `<div class="settingsSection"><h3>${esc(tr('secLang'))}</h3>` +
        `<div class="settingsChoices">` +
        langOptions
          .map(([val, label]) => {
            const sel = state.language === val;
            return (
              `<label class="settingsChoice${sel ? ' selected' : ''}">` +
              `<input type="radio" name="dgLanguage" value="${esc(val)}"${sel ? ' checked' : ''}>` +
              `<span>${esc(label)}</span>` +
              `</label>`
            );
          })
          .join('') +
        `</div></div>`;

      // 2. Draw.io
      html +=
        `<div class="settingsSection"><h3>${esc(tr('secDrawio'))}</h3>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblTheme'))}</span>` +
        renderSegmented(
          'drawio.theme',
          [
            ['auto', tr('optAuto')],
            ['light', tr('optLight')],
            ['dark', tr('optDark')],
          ],
          state.drawio.theme,
        ) +
        `</div>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblUi'))}</span>` +
        renderSegmented(
          'drawio.ui',
          [
            ['kennedy', tr('uiKennedy')],
            ['simple', tr('uiSimple')],
            ['min', tr('uiMin')],
            ['atlas', tr('uiAtlas')],
            ['sketch', tr('uiSketch')],
          ],
          state.drawio.ui,
        ) +
        `</div>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblSvgColor'))}</span>` +
        renderSegmented(
          'drawio.svgColorScheme',
          [
            ['auto', tr('svgAuto')],
            ['light', tr('svgLight')],
            ['dark', tr('svgDark')],
          ],
          state.drawio.svgColorScheme,
        ) +
        `</div>` +
        `<div class="settingsCheckboxes">` +
        renderCheckbox('drawio.hideGithubIcon', tr('chkHideGh'), state.drawio.hideGithubIcon) +
        renderCheckbox('drawio.vscodeShortcuts', tr('chkShortcuts'), state.drawio.vscodeShortcuts) +
        `</div>` +
        `<div class="settingsCard"><div class="settingsGrid">` +
        `<label class="settingsKey">${esc(tr('lblDrawioUrl'))}</label>` +
        `<input type="text" class="settingsInput" data-text-setting="drawio.url" value="${esc(state.drawio.url)}" placeholder="https://embed.diagrams.net/" spellcheck="false"${dis}>` +
        `</div></div>` +
        `</div>`;

      // 3. Mermaid & Preview
      html +=
        `<div class="settingsSection"><h3>${esc(tr('secPreview'))}</h3>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblMermaidTheme'))}</span>` +
        renderSegmented(
          'mermaid.theme',
          [
            ['auto', tr('optAuto')],
            ['default', tr('mmdDefault')],
            ['dark', tr('optDark')],
            ['forest', tr('mmdForest')],
            ['neutral', tr('mmdNeutral')],
          ],
          state.preview.mermaidTheme,
        ) +
        `</div>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblPngScale'))}</span>` +
        renderSegmented(
          'preview.pngScale',
          [
            ['1', '1x'],
            ['2', '2x (Retina)'],
            ['3', '3x'],
            ['4', '4x'],
          ],
          String(state.preview.pngScale),
        ) +
        `</div>` +
        `<div class="settingsCheckboxes">` +
        renderCheckbox('preview.followActiveEditor', tr('chkFollow'), state.preview.followActiveEditor) +
        renderCheckbox('preview.pngTransparent', tr('chkTransparent'), state.preview.pngTransparent) +
        renderCheckbox('editor.codeLens', tr('chkCodeLens'), state.preview.codeLens) +
        renderCheckbox('toolbar.showQuickMenu', tr('chkQuickMenu'), state.preview.showQuickMenu) +
        `</div></div>`;

      // 4. PlantUML & Markdown
      html +=
        `<div class="settingsSection"><h3>${esc(tr('secPlantuml'))}</h3>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblRender'))}</span>` +
        renderSegmented(
          'plantuml.render',
          [
            ['auto', tr('rndAuto')],
            ['local', tr('rndLocal')],
            ['server', tr('rndServer')],
          ],
          state.plantuml.render,
        ) +
        `</div>` +
        `<div class="settingsRow"><span class="settingsLabel">${esc(tr('lblExportSave'))}</span>` +
        renderSegmented(
          'exportOnSave',
          [
            ['off', tr('expOff')],
            ['svg', 'SVG'],
            ['png', 'PNG'],
          ],
          state.plantuml.exportOnSave,
        ) +
        `</div>` +
        `<div class="settingsCheckboxes">` +
        renderCheckbox('markdown.mermaid', tr('chkMdMermaid'), state.plantuml.markdownMermaid) +
        renderCheckbox('markdown.plantuml', tr('chkMdPlantuml'), state.plantuml.markdownPlantuml) +
        `</div>` +
        `<div class="settingsCard"><div class="settingsGrid">` +
        `<label class="settingsKey">${esc(tr('lblPumlServer'))}</label>` +
        `<input type="text" class="settingsInput" data-text-setting="plantuml.server" value="${esc(state.plantuml.server)}" placeholder="https://www.plantuml.com/plantuml" spellcheck="false"${dis}>` +
        `<label class="settingsKey">${esc(tr('lblPumlJar'))}</label>` +
        `<input type="text" class="settingsInput" data-text-setting="plantuml.jar" value="${esc(state.plantuml.jar)}" placeholder="${esc(tr('phJar'))}" spellcheck="false"${dis}>` +
        `</div>` +
        (state.isTrusted ? '' : `<p class="settingsNote">${esc(tr('untrustedNote'))}</p>`) +
        `</div></div>`;

      contentEl.innerHTML = html;
      bindContentListeners();
    }

    function bindContentListeners() {
      contentEl.querySelectorAll('input[name="dgLanguage"]').forEach((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        input.addEventListener('change', () => {
          if (input.checked) {
            sendUpdate('language', input.value);
          }
        });
      });

      contentEl.querySelectorAll('.settingsSegmented').forEach((groupEl) => {
        const group = /** @type {HTMLElement} */ (groupEl);
        const setting = group.dataset.setting || '';
        group.querySelectorAll('.settingsSegment').forEach((btnEl) => {
          const btn = /** @type {HTMLButtonElement} */ (btnEl);
          btn.addEventListener('click', () => {
            if (!btn.classList.contains('selected') && btn.dataset.value !== undefined) {
              sendUpdate(setting, btn.dataset.value);
            }
          });
        });
      });

      contentEl.querySelectorAll('input[type="checkbox"][data-setting]').forEach((el) => {
        const cb = /** @type {HTMLInputElement} */ (el);
        cb.addEventListener('change', () => {
          if (cb.dataset.setting) {
            sendUpdate(cb.dataset.setting, cb.checked);
          }
        });
      });

      contentEl.querySelectorAll('input[data-text-setting]').forEach((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        const commit = () => {
          const key = input.dataset.textSetting;
          if (key) {
            sendUpdate(key, input.value.trim());
          }
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
        });
      });
    }

    langQuick.querySelectorAll('button').forEach((el) => {
      const btn = /** @type {HTMLButtonElement} */ (el);
      btn.addEventListener('click', () => {
        if (btn.dataset.lang) {
          sendUpdate('language', btn.dataset.lang);
        }
      });
    });

    openExtBtn.addEventListener('click', () => {
      opts.postMessage({ type: 'openExtensionSettings' });
    });

    function open() {
      if (standalone || visible) {
        return;
      }
      visible = true;
      widget.classList.add('transition', 'active');
      backdrop.classList.add('active');
      opts.postMessage({ type: 'requestSettings' });
      opts.onVisibilityChange?.(true);
    }

    function close() {
      if (standalone || !visible) {
        return;
      }
      visible = false;
      widget.classList.add('transition');
      widget.classList.remove('active');
      backdrop.classList.remove('active');
      opts.onVisibilityChange?.(false);
    }

    function toggle() {
      if (visible) {
        close();
      } else {
        open();
      }
    }

    closeBtn?.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && visible && !standalone) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });

    return {
      open,
      close,
      toggle,
      isOpen: () => visible,
      /** @param {any} nextState */
      setState(nextState) {
        state = nextState;
        renderPreservingFocus();
      },
    };
  }

  // @ts-ignore attach to window for webviews
  window.createDrawGraphSettingsDrawer = createDrawGraphSettingsDrawer;
})();
