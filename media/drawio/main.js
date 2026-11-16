// @ts-check
// Bridges the VS Code extension host and the embedded draw.io frame (JSON embed protocol)
// via an explicit handshake state machine (`booting` -> `configured` -> `initialized` -> `ready` | `failed`).
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const frame = /** @type {HTMLIFrameElement} */ (document.getElementById('drawio'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  const statusText = /** @type {HTMLElement} */ (document.getElementById('statusText'));
  const retryBtn = /** @type {HTMLButtonElement} */ (document.getElementById('retryBtn'));
  const frameUrl = frame.dataset.src || '';
  const frameOrigin = new URL(frameUrl).origin;
  const loadingMessage = status.dataset.loading || statusText.textContent || 'Loading draw.io…';
  const failMessage = status.dataset.fail || 'draw.io failed to load.';

  /**
   * Explicit bridge lifecycle phase:
   * - `booting`: waiting for both host `setup` and iframe `configure`
   * - `configured`: configuration sent to iframe; waiting for `init`
   * - `initialized`: `init` received; host is sending `load`
   * - `ready`: diagram loaded and interactive
   * - `failed`: iframe load timed out; user can click Retry to transition back to `booting`
   * @type {'booting' | 'configured' | 'initialized' | 'ready' | 'failed'}
   */
  let bridgePhase = 'booting';
  /** @type {object | undefined} */
  let drawioConfig;
  let forwardShortcuts = true;
  let iframeRequestedConfigure = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let failTimer;
  /** @type {Set<number>} */
  const clipboardPngRequests = new Set();

  /** @param {'booting' | 'configured' | 'initialized' | 'ready' | 'failed'} next */
  function setBridgePhase(next) {
    if (bridgePhase === next) {
      return;
    }
    bridgePhase = next;
    switch (next) {
      case 'booting':
        status.style.display = 'flex';
        status.classList.remove('error');
        statusText.textContent = loadingMessage;
        retryBtn.hidden = true;
        frame.classList.remove('ready');
        break;
      case 'configured':
      case 'initialized':
        status.style.display = 'flex';
        status.classList.remove('error');
        retryBtn.hidden = true;
        break;
      case 'ready':
        status.style.display = 'none';
        status.classList.remove('error');
        retryBtn.hidden = true;
        frame.classList.add('ready');
        break;
      case 'failed':
        status.style.display = 'flex';
        status.classList.add('error');
        statusText.textContent = failMessage;
        retryBtn.hidden = false;
        frame.classList.remove('ready');
        break;
    }
    vscode.postMessage({ type: 'phase', phase: next });
  }

  function startFailTimer() {
    clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      if (bridgePhase === 'booting' || bridgePhase === 'configured') {
        setBridgePhase('failed');
      }
    }, 30000);
  }

  // --- VS Code shortcuts inside draw.io -------------------------------------------------
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
      Object.defineProperty(event, 'keyCode', { get: () => keyCode });
      Object.defineProperty(event, 'which', { get: () => keyCode });
      window.dispatchEvent(event);
    }
  }

  /** @param {object} message */
  function postToDrawio(message) {
    frame.contentWindow?.postMessage(JSON.stringify(message), frameOrigin);
  }

  function trySendConfigure(liveUpdate = false) {
    if ((iframeRequestedConfigure || liveUpdate) && drawioConfig) {
      const defaults = {
        compressXml: false,
        passThroughKeys: forwardShortcuts ? passThroughKeys() : liveUpdate ? [] : undefined,
      };
      postToDrawio({ action: 'configure', config: Object.assign(defaults, drawioConfig) });
      iframeRequestedConfigure = false;
      if (bridgePhase === 'booting') {
        setBridgePhase('configured');
      }
    }
  }

  /** @param {string} dataUri */
  async function writePngDataUriToClipboard(dataUri) {
    const response = await fetch(dataUri);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  retryBtn.addEventListener('click', () => {
    iframeRequestedConfigure = false;
    setBridgePhase('booting');
    startFailTimer();
    frame.src = 'about:blank';
    setTimeout(() => {
      frame.src = frameUrl;
    }, 20);
  });

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
      case 'setup': {
        const isLiveUpdate = bridgePhase === 'initialized' || bridgePhase === 'ready';
        drawioConfig = msg.drawioConfig || {};
        forwardShortcuts = msg.forwardShortcuts !== false;
        trySendConfigure(isLiveUpdate);
        break;
      }
      case 'load':
        postToDrawio({ action: 'load', xml: msg.xml || '', autosave: 1, title: msg.title, saveAndExit: '0', noSaveBtn: '1', noExitBtn: '1' });
        break;
      case 'action':
        postToDrawio(msg.action);
        break;
      case 'export':
        if (msg.copyToClipboard) {
          clipboardPngRequests.add(msg.requestId);
        }
        postToDrawio(Object.assign({ action: 'export', format: msg.format, drawGraphRequestId: msg.requestId }, msg.options || {}));
        break;
    }
  });

  /** @param {any} msg */
  function handleDrawioEvent(msg) {
    switch (msg.event) {
      case 'configure':
        iframeRequestedConfigure = true;
        trySendConfigure(false);
        break;
      case 'init':
        clearTimeout(failTimer);
        setBridgePhase('initialized');
        vscode.postMessage({ type: 'init' });
        break;
      case 'load':
        clearTimeout(failTimer);
        setBridgePhase('ready');
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
          if (clipboardPngRequests.delete(requestId) && msg.data) {
            writePngDataUriToClipboard(msg.data).then(
              () => vscode.postMessage({ type: 'export', requestId, data: 'copied' }),
              (err) => vscode.postMessage({ type: 'export', requestId, error: String((err && err.message) || err) }),
            );
          } else {
            vscode.postMessage({ type: 'export', requestId, data: msg.data });
          }
        }
        break;
      }
    }
  }

  startFailTimer();
  vscode.postMessage({ type: 'ready' });
  // Start loading draw.io only now that the message listener above is installed.
  frame.src = frameUrl;
})();
