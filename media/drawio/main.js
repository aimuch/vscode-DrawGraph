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
  let configureRequested = false;
  let initialized = false;

  /** @param {object} message */
  function postToDrawio(message) {
    frame.contentWindow?.postMessage(JSON.stringify(message), frameOrigin);
  }

  function sendConfigure() {
    if (configureRequested && drawioConfig) {
      postToDrawio({ action: 'configure', config: Object.assign({ compressXml: false }, drawioConfig) });
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
        sendConfigure();
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
