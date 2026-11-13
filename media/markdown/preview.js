// Renders ```mermaid blocks in VS Code's built-in Markdown preview.
(function () {
  let counter = 0;

  function isDark() {
    const cls = document.body.classList;
    return cls.contains('vscode-dark') || (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light'));
  }

  // VS Code loads preview scripts asynchronously, so this script can run before
  // mermaid.min.js has finished loading. Wait for it (up to ~15s) before rendering.
  let waiting = false;
  function whenMermaidReady(callback) {
    if (window.mermaid) {
      callback();
      return;
    }
    if (waiting) {
      return;
    }
    waiting = true;
    let tries = 0;
    const timer = setInterval(() => {
      if (window.mermaid || ++tries > 300) {
        clearInterval(timer);
        waiting = false;
        if (window.mermaid) {
          callback();
        }
      }
    }, 50);
  }

  function render() {
    whenMermaidReady(() => void renderNow());
  }

  async function renderNow() {
    const mermaid = window.mermaid;
    const blocks = document.querySelectorAll('div.drawgraph-mermaid:not([data-rendered])');
    if (!mermaid || blocks.length === 0) {
      return;
    }
    mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict' });
    for (const block of blocks) {
      block.setAttribute('data-rendered', '1');
      const source = block.textContent || '';
      const id = `drawgraph-md-mermaid-${++counter}`;
      try {
        const { svg } = await mermaid.render(id, source);
        block.innerHTML = svg;
      } catch (err) {
        const pre = document.createElement('pre');
        pre.className = 'drawgraph-mermaid-error';
        pre.textContent = `Mermaid: ${(err && err.message) || err}`;
        block.replaceChildren(pre);
      } finally {
        document.getElementById(`d${id}`)?.remove();
      }
    }
  }

  window.addEventListener('vscode.markdown.updateContent', () => void render());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void render());
  } else {
    void render();
  }
})();
