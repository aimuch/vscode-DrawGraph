// @ts-check
// Slide-in Settings Drawer shared by Draw.io custom editors, Diagram Previews, and the
// standalone DrawGraph Settings view. Uses pure DOM construction (no innerHTML) and
// host-injected bilingual dictionaries (简体中文 / English).
(function () {
  /** @type {Record<'en' | 'zh-cn', Record<string, string>>} */
  const FALLBACK_STRINGS = {
    en: { title: 'DrawGraph Settings', close: 'Close (Esc)', openVscodeSettings: 'Open Full DrawGraph Settings in VS Code' },
    'zh-cn': { title: 'DrawGraph 设置', close: '关闭 (Esc)', openVscodeSettings: '在 VS Code 设置页中查看全部 DrawGraph 配置' },
  };

  /**
   * Safe DOM element factory without innerHTML.
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
        if (v === undefined || v === null || v === false) {
          continue;
        }
        if (k === 'className') {
          el.className = String(v);
        } else if (k === 'dataset' && typeof v === 'object') {
          for (const [dk, dv] of Object.entries(v)) {
            if (dv !== undefined) {
              el.dataset[dk] = String(dv);
            }
          }
        } else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'placeholder' || k === 'type' || k === 'name' || k === 'title') {
          // @ts-ignore direct DOM property assignment
          el[k] = v;
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          el.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) {
        continue;
      }
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function createCloseIconSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute(
      'd',
      'M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z',
    );
    svg.appendChild(p);
    return svg;
  }

  /**
   * @param {{ postMessage: (msg: any) => void, standalone?: boolean, onVisibilityChange?: (open: boolean) => void }} opts
   */
  function createDrawGraphSettingsDrawer(opts) {
    const standalone = opts.standalone === true;
    /** @type {any} */
    let state = null;
    let visible = standalone;

    const backdrop = h('div', { id: 'settingsBackdrop' });
    if (!standalone) {
      document.body.appendChild(backdrop);
    }

    const titleEl = h('h2', { id: 'settingsTitle' });
    const zhQuickBtn = h('button', { type: 'button', dataset: { lang: 'Simplified Chinese' } }, '中');
    const enQuickBtn = h('button', { type: 'button', dataset: { lang: 'English' } }, 'EN');
    const langQuick = h('div', { id: 'settingsLangQuick', role: 'radiogroup' }, zhQuickBtn, enQuickBtn);
    const closeBtn = standalone ? null : h('button', { type: 'button', id: 'settingsClose' }, createCloseIconSvg());
    const headerEl = h('div', { id: 'settingsHeader' }, titleEl, langQuick, closeBtn);
    const contentEl = h('div', { id: 'settingsContent' });
    const openExtBtn = h('button', { type: 'button', id: 'openExtSettingsBtn', className: 'settingsLink' });
    const footerEl = h('div', { id: 'settingsFooter' }, openExtBtn);

    const widget = h(
      'div',
      {
        id: 'settingsWidget',
        className: standalone ? 'standalone active' : '',
        role: standalone ? 'region' : 'dialog',
        'aria-modal': standalone ? undefined : 'true',
        'aria-labelledby': 'settingsTitle',
      },
      headerEl,
      contentEl,
      footerEl,
    );
    document.body.appendChild(widget);

    /** @type {HTMLElement | null} */
    let previouslyFocused = null;

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
     * @param {string | number} [arg0]
     */
    function tr(key, arg0) {
      const lang = activeLang();
      const dict = (state && state.i18n && state.i18n[lang]) || FALLBACK_STRINGS[lang] || FALLBACK_STRINGS.en;
      const enDict = (state && state.i18n && state.i18n.en) || FALLBACK_STRINGS.en;
      const raw = dict[key] || enDict[key] || key;
      return arg0 !== undefined ? raw.replace('{0}', String(arg0)) : raw;
    }

    /** @param {string} key @param {any} value */
    function sendUpdate(key, value) {
      if (!state) {
        return;
      }
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
      } else if (key === 'preview.syncWithCodeCursor') {
        state.preview.syncWithCodeCursor = Boolean(value);
      } else if (key === 'codeLinks.checkBrokenLinks') {
        state.preview.checkBrokenLinks = Boolean(value);
      } else if (key === 'codeLinks.syncOnFileRename') {
        state.preview.syncOnFileRename = Boolean(value);
      } else if (key === 'preview.debounce') {
        state.preview.debounce = Math.max(0, Math.round(Number(value) || 0));
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
      } else if (key === 'exportOnSaveOutDir') {
        state.plantuml.exportOnSaveOutDir = value;
      } else if (key === 'markdown.mermaid') {
        state.plantuml.markdownMermaid = Boolean(value);
      } else if (key === 'markdown.plantuml') {
        state.plantuml.markdownPlantuml = Boolean(value);
      } else if (key === 'markdown.dot') {
        state.plantuml.markdownDot = Boolean(value);
      } else if (key === 'markdown.wavedrom') {
        state.plantuml.markdownWavedrom = Boolean(value);
      }
      opts.postMessage({ type: 'updateSetting', key, value });
      renderPreservingFocus();
    }

    /**
     * @param {string} setting
     * @param {Array<[string, string]>} items
     * @param {string} current
     */
    function buildSegmented(setting, items, current) {
      return h(
        'div',
        { className: 'settingsSegmented', role: 'radiogroup', dataset: { setting } },
        ...items.map(([val, label]) => {
          const sel = String(val) === String(current);
          return h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(sel),
              className: sel ? 'settingsSegment selected' : 'settingsSegment',
              dataset: { value: val },
              onClick: () => {
                if (!sel) {
                  sendUpdate(setting, val);
                }
              },
            },
            label,
          );
        }),
      );
    }

    /**
     * @param {string} setting
     * @param {string} label
     * @param {boolean} checked
     */
    function buildCheckbox(setting, label, checked) {
      const input = h('input', {
        type: 'checkbox',
        checked: Boolean(checked),
        dataset: { setting },
        onChange: () => sendUpdate(setting, input.checked),
      });
      return h('label', { className: 'settingsCheckboxLabel' }, input, h('span', null, label));
    }

    /**
     * @param {string} setting
     * @param {string} currentVal
     * @param {string} placeholder
     * @param {boolean} disabled
     */
    function buildTextInput(setting, currentVal, placeholder, disabled) {
      const input = h('input', {
        type: 'text',
        className: 'settingsInput',
        value: String(currentVal || ''),
        placeholder,
        spellcheck: 'false',
        disabled,
        dataset: { textSetting: setting },
        onChange: () => sendUpdate(setting, input.value.trim()),
        onKeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
        },
      });
      return input;
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

      zhQuickBtn.classList.toggle('selected', eff === 'zh-cn');
      enQuickBtn.classList.toggle('selected', eff === 'en');

      const vscodeDisplay = /^zh\b/i.test(state.vscodeLanguage || '') ? '简体中文' : 'English';
      const langOptions = [
        ['Auto', tr('langFollow', vscodeDisplay)],
        ['Simplified Chinese', '简体中文'],
        ['English', 'English'],
      ];
      const untrusted = !state.isTrusted;

      // 1. Language section
      const secLang = h(
        'div',
        { className: 'settingsSection' },
        h('h3', null, tr('secLang')),
        h(
          'div',
          { className: 'settingsChoices' },
          ...langOptions.map(([val, label]) => {
            const sel = state.language === val;
            const radio = h('input', {
              type: 'radio',
              name: 'dgLanguage',
              value: val,
              checked: sel,
              onChange: () => {
                if (radio.checked) {
                  sendUpdate('language', val);
                }
              },
            });
            return h('label', { className: sel ? 'settingsChoice selected' : 'settingsChoice' }, radio, h('span', null, label));
          }),
        ),
      );

      // 2. Draw.io section (including Offline Engine Pack manager)
      const packInstalled = Boolean(state.drawio.offlinePackInstalled);
      const offlineCard = h(
        'div',
        { className: 'settingsCard' },
        h(
          'div',
          { className: 'settingsOfflineRow' },
          h(
            'span',
            { className: packInstalled ? 'settingsBadge ready' : 'settingsBadge' },
            packInstalled ? tr('offlineInstalled', state.drawio.offlinePackFiles || 1) : tr('offlineMissing'),
          ),
          h(
            'div',
            { className: 'settingsActionGroup' },
            h(
              'button',
              {
                type: 'button',
                className: 'settingsActionBtn',
                disabled: untrusted,
                onClick: () => opts.postMessage({ type: 'drawerAction', action: 'downloadOfflinePack' }),
              },
              tr('btnDownloadPack'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'settingsActionBtn',
                onClick: () => opts.postMessage({ type: 'drawerAction', action: 'importOfflinePack' }),
              },
              tr('btnImportPack'),
            ),
            packInstalled &&
              h(
                'button',
                {
                  type: 'button',
                  className: 'settingsActionBtn danger',
                  onClick: () => opts.postMessage({ type: 'drawerAction', action: 'removeOfflinePack' }),
                },
                tr('btnRemovePack'),
              ),
          ),
        ),
        h(
          'div',
          { className: 'settingsGrid' },
          h('label', { className: 'settingsKey' }, tr('lblDrawioUrl')),
          buildTextInput('drawio.url', state.drawio.url, 'https://embed.diagrams.net/', untrusted),
        ),
      );

      const secDrawio = h(
        'div',
        { className: 'settingsSection' },
        h('h3', null, tr('secDrawio')),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblTheme')),
          buildSegmented(
            'drawio.theme',
            [
              ['auto', tr('optAuto')],
              ['light', tr('optLight')],
              ['dark', tr('optDark')],
            ],
            state.drawio.theme,
          ),
        ),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblUi')),
          buildSegmented(
            'drawio.ui',
            [
              ['kennedy', tr('uiKennedy')],
              ['simple', tr('uiSimple')],
              ['min', tr('uiMin')],
              ['atlas', tr('uiAtlas')],
              ['sketch', tr('uiSketch')],
            ],
            state.drawio.ui,
          ),
        ),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblSvgColor')),
          buildSegmented(
            'drawio.svgColorScheme',
            [
              ['auto', tr('svgAuto')],
              ['light', tr('svgLight')],
              ['dark', tr('svgDark')],
            ],
            state.drawio.svgColorScheme,
          ),
        ),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblOfflineMode')),
          buildSegmented(
            'drawio.offlineMode',
            [
              ['auto', tr('offAuto')],
              ['online', tr('offOnline')],
              ['offline', tr('offLocal')],
            ],
            state.drawio.offlineMode || 'auto',
          ),
        ),
        h(
          'div',
          { className: 'settingsCheckboxes' },
          buildCheckbox('drawio.hideGithubIcon', tr('chkHideGh'), state.drawio.hideGithubIcon),
          buildCheckbox('drawio.vscodeShortcuts', tr('chkShortcuts'), state.drawio.vscodeShortcuts),
          buildCheckbox('drawio.autoLoadWorkspaceLibrary', tr('chkAutoWorkspaceLib'), state.drawio.autoLoadWorkspaceLibrary),
        ),
        offlineCard,
      );

      // 3. Mermaid & Preview section
      const secPreview = h(
        'div',
        { className: 'settingsSection' },
        h('h3', null, tr('secPreview')),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblMermaidTheme')),
          buildSegmented(
            'mermaid.theme',
            [
              ['auto', tr('optAuto')],
              ['default', tr('mmdDefault')],
              ['dark', tr('optDark')],
              ['forest', tr('mmdForest')],
              ['neutral', tr('mmdNeutral')],
            ],
            state.preview.mermaidTheme,
          ),
        ),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblPngScale')),
          buildSegmented(
            'preview.pngScale',
            [
              ['1', '1x'],
              ['2', '2x (Retina)'],
              ['3', '3x'],
              ['4', '4x'],
            ],
            String(state.preview.pngScale),
          ),
        ),
        h(
          'div',
          { className: 'settingsCheckboxes' },
          buildCheckbox('preview.followActiveEditor', tr('chkFollow'), state.preview.followActiveEditor),
          buildCheckbox('preview.syncWithCodeCursor', tr('chkSyncCursor'), state.preview.syncWithCodeCursor),
          buildCheckbox('codeLinks.checkBrokenLinks', tr('chkCheckLinks'), state.preview.checkBrokenLinks),
          buildCheckbox('codeLinks.syncOnFileRename', tr('chkRenameSync'), state.preview.syncOnFileRename),
          buildCheckbox('preview.pngTransparent', tr('chkTransparent'), state.preview.pngTransparent),
          buildCheckbox('editor.codeLens', tr('chkCodeLens'), state.preview.codeLens),
          buildCheckbox('toolbar.showQuickMenu', tr('chkQuickMenu'), state.preview.showQuickMenu),
        ),
        h(
          'div',
          { className: 'settingsCard' },
          h(
            'div',
            { className: 'settingsGrid' },
            h('label', { className: 'settingsKey' }, tr('lblDebounce')),
            buildTextInput('preview.debounce', String(state.preview.debounce ?? 400), '400', false),
          ),
        ),
      );

      // 4. PlantUML & Markdown section
      const secPlantuml = h(
        'div',
        { className: 'settingsSection' },
        h('h3', null, tr('secPlantuml')),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblRender')),
          buildSegmented(
            'plantuml.render',
            [
              ['auto', tr('rndAuto')],
              ['local', tr('rndLocal')],
              ['server', tr('rndServer')],
            ],
            state.plantuml.render,
          ),
        ),
        h(
          'div',
          { className: 'settingsRow' },
          h('span', { className: 'settingsLabel' }, tr('lblExportSave')),
          buildSegmented(
            'exportOnSave',
            [
              ['off', tr('expOff')],
              ['svg', 'SVG'],
              ['png', 'PNG'],
              ['pdf', 'PDF'],
            ],
            state.plantuml.exportOnSave,
          ),
        ),
        h(
          'div',
          { className: 'settingsCheckboxes' },
          buildCheckbox('markdown.mermaid', tr('chkMdMermaid'), state.plantuml.markdownMermaid),
          buildCheckbox('markdown.plantuml', tr('chkMdPlantuml'), state.plantuml.markdownPlantuml),
          buildCheckbox('markdown.dot', tr('chkMdDot'), state.plantuml.markdownDot),
          buildCheckbox('markdown.wavedrom', tr('chkMdWaveDrom'), state.plantuml.markdownWavedrom),
        ),
        h(
          'div',
          { className: 'settingsCard' },
          h(
            'div',
            { className: 'settingsGrid' },
            h('label', { className: 'settingsKey' }, tr('lblPumlServer')),
            buildTextInput('plantuml.server', state.plantuml.server, 'https://www.plantuml.com/plantuml', untrusted),
            h('label', { className: 'settingsKey' }, tr('lblPumlJar')),
            buildTextInput('plantuml.jar', state.plantuml.jar, tr('phJar'), untrusted),
            h('label', { className: 'settingsKey' }, tr('lblExportOutDir')),
            buildTextInput('exportOnSaveOutDir', state.plantuml.exportOnSaveOutDir || '', tr('phExportOutDir'), untrusted),
          ),
          untrusted && h('p', { className: 'settingsNote' }, tr('untrustedNote')),
        ),
      );

      contentEl.replaceChildren(secLang, secDrawio, secPreview, secPlantuml);
    }

    zhQuickBtn.addEventListener('click', () => sendUpdate('language', 'Simplified Chinese'));
    enQuickBtn.addEventListener('click', () => sendUpdate('language', 'English'));
    openExtBtn.addEventListener('click', () => opts.postMessage({ type: 'openExtensionSettings' }));

    function open() {
      if (standalone || visible) {
        return;
      }
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      visible = true;
      widget.classList.add('transition', 'active');
      backdrop.classList.add('active');
      opts.postMessage({ type: 'requestSettings' });
      opts.onVisibilityChange?.(true);
      setTimeout(() => {
        (closeBtn || zhQuickBtn).focus();
      }, 20);
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
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
      previouslyFocused = null;
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
