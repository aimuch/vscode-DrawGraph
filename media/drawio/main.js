// @ts-check
// Bridges the VS Code extension host and the embedded draw.io frame (JSON embed protocol).
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const frame = /** @type {HTMLIFrameElement} */ (document.getElementById('drawio'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  const frameUrl = frame.dataset.src || '';
  const frameOrigin = new URL(frameUrl).origin;

  /** @type {object | undefined} */
  let drawioConfig;
  let forwardShortcuts = true;

  // --- VS Code shortcuts inside draw.io -------------------------------------------------
  // Keys pressed inside the cross-origin draw.io frame never reach VS Code. draw.io's
  // `passThroughKeys` option makes it hand the listed combinations to us instead
  // ({event: 'shortcut'}); we replay them as key presses in this document, which VS Code
  // forwards to its keybinding service, so user keybindings still apply.
  // `primary` is Cmd on macOS and Ctrl elsewhere (draw.io treats Ctrl and Cmd alike).
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const FORWARDED_SHORTCUTS = [
    { key: 'F1', code: 'F1' }, // command palette
    { key: 'p', code: 'KeyP', primary: true, shift: true }, // command palette (draw.io: format panel)
    { key: 'p', code: 'KeyP', primary: true }, // quick open (draw.io: print)
    { key: 'w', code: 'KeyW', primary: true }, // close editor
    { key: 'n', code: 'KeyN', primary: true }, // new file
    { key: 'o', code: 'KeyO', primary: true }, // open file
    { key: 'n', code: 'KeyN', primary: true, shift: true }, // new window
    { key: 't', code: 'KeyT', primary: true, shift: true }, // reopen closed editor
    { key: 'w', code: 'KeyW', primary: true, shift: true }, // close window
    { key: 'x', code: 'KeyX', primary: true, shift: true }, // extensions view
    { key: '\\', code: 'Backslash', primary: true }, // split editor
    { key: 'Tab', code: 'Tab', ctrl: true }, // next editor
    { key: 'Tab', code: 'Tab', ctrl: true, shift: true }, // previous editor
    { key: '`', code: 'Backquote', ctrl: true }, // terminal
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: String(n), code: `Digit${n}`, primary: true })), // editor groups
  ];

  function passThroughKeys() {
    return FORWARDED_SHORTCUTS.map((s) => ({
      key: s.key,
      ctrl: !!(s.primary || s.ctrl),
      shift: !!s.shift,
      alt: false,
      command: { key: s.key, code: s.code, shift: !!s.shift, ctrl: !!s.ctrl || (!!s.primary && !isMac), meta: !!s.primary && isMac },
    }));
  }

  /** @param {string} code */
  function keyCodeFor(code) {
    const special = { Tab: 9, Backquote: 192, Backslash: 220 };
    if (code in special) return special[/** @type {keyof typeof special} */ (code)];
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit\d$/.test(code)) return 48 + Number(code[5]);
    if (/^F\d+$/.test(code)) return 111 + Number(code.slice(1));
    return 0;
  }

  /** Replays a shortcut handed over by draw.io as a key press VS Code will see. */
  function replayShortcut(/** @type {any} */ cmd) {
    if (!cmd || typeof cmd.code !== 'string') {
      return;
    }
    const keyCode = keyCodeFor(cmd.code);
    const key = cmd.shift && cmd.key.length === 1 ? cmd.key.toUpperCase() : cmd.key;
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, {
        key,
        code: cmd.code,
        shiftKey: !!cmd.shift,
        ctrlKey: !!cmd.ctrl,
        metaKey: !!cmd.meta,
        altKey: false,
        bubbles: true,
        cancelable: true,
      });
      // keyCode/which cannot be set through the constructor.
      Object.defineProperty(event, 'keyCode', { get: () => keyCode });
      Object.defineProperty(event, 'which', { get: () => keyCode });
      window.dispatchEvent(event);
    }
  }
  let configureRequested = false;
  let initialized = false;

  /** @param {object} message */
  function postToDrawio(message) {
    frame.contentWindow?.postMessage(JSON.stringify(message), frameOrigin);
  }

  function sendConfigure(force = false) {
    if ((configureRequested || force) && drawioConfig) {
      // The user's own drawGraph.drawio.config wins over our defaults (including passThroughKeys).
      const defaults = { compressXml: false, passThroughKeys: forwardShortcuts ? passThroughKeys() : [] };
      postToDrawio({ action: 'configure', config: Object.assign(defaults, drawioConfig) });
      configureRequested = false;
    }
  }

  const failTimer = setTimeout(() => {
    if (!initialized) {
      status.textContent = status.dataset.fail || 'draw.io failed to load.';
      status.classList.add('error');
    }
  }, 30000);

  window.addEventListener('message', (event) => {
    if (event.source === frame.contentWindow) {
      if (event.origin !== frameOrigin || typeof event.data !== 'string') {
        return;
      }
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleDrawioEvent(msg);
      return;
    }
    // Messages from the extension host.
    const msg = event.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'setup':
        drawioConfig = msg.drawioConfig || {};
        forwardShortcuts = msg.forwardShortcuts !== false;
        sendConfigure(initialized);
        break;
      case 'load':
        postToDrawio({ action: 'load', xml: msg.xml || '', autosave: 1, title: msg.title, saveAndExit: '0', noSaveBtn: '1', noExitBtn: '1' });
        break;
      case 'action':
        // Raw draw.io embed action (diagnostics / integration tests).
        postToDrawio(msg.action);
        break;
      case 'export':
        // draw.io echoes the request back in `message`, which is how replies are matched.
        postToDrawio(Object.assign({ action: 'export', format: msg.format, drawGraphRequestId: msg.requestId }, msg.options || {}));
        break;
    }
  });

  /** @param {any} msg */
  function handleDrawioEvent(msg) {
    switch (msg.event) {
      case 'configure':
        configureRequested = true;
        sendConfigure();
        break;
      case 'init':
        initialized = true;
        clearTimeout(failTimer);
        vscode.postMessage({ type: 'init' });
        break;
      case 'load':
        status.style.display = 'none';
        frame.classList.add('ready');
        vscode.postMessage({ type: 'loaded' });
        break;
      case 'shortcut':
        replayShortcut(msg.command);
        break;
      case 'autosave':
        vscode.postMessage({ type: 'change', xml: msg.xml });
        break;
      case 'save':
        vscode.postMessage({ type: 'save', xml: msg.xml });
        break;
      case 'export': {
        const requestId = msg.message && msg.message.drawGraphRequestId;
        if (requestId !== undefined) {
          vscode.postMessage({ type: 'export', requestId, data: msg.data });
        }
        break;
      }
    }
  }

  vscode.postMessage({ type: 'ready' });
  // Start loading draw.io only now that the message listener above is installed.
  frame.src = frameUrl;
})();
