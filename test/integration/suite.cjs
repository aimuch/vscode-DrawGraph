// Integration tests executed inside VS Code (see runTest.mjs).
// Needs network access: draw.io loads from embed.diagrams.net, PlantUML renders via its server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const workspace = process.env.DRAWGRAPH_IT_WORKSPACE;
const file = (name) => vscode.Uri.file(path.join(workspace, name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, predicate, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await predicate();
    if (last) {
      return last;
    }
    await sleep(200);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for: ${what}`);
}

let api;
const previewOf = (uri) => api.diagnostics.previews().find((p) => p.uri === uri.toString());
const drawioOf = (uri) => api.diagnostics.drawioEditors().find((e) => e.uri === uri.toString());

async function replaceAll(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('activates and registers languages', async () => {
  const doc = await vscode.workspace.openTextDocument(file('flowchart.mmd'));
  assert.equal(doc.languageId, 'mermaid');
  const ext = vscode.extensions.getExtension('drawgraph.drawgraph');
  assert.ok(ext, 'extension found');
  api = await ext.activate();
  assert.equal(typeof api.extendMarkdownIt, 'function');
  const puml = await vscode.workspace.openTextDocument(file('sequence.puml'));
  assert.equal(puml.languageId, 'plantuml');
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['drawGraph.quickMenu', 'drawGraph.preview.open', 'drawGraph.preview.openToSide', 'drawGraph.drawio.new', 'drawGraph.drawio.exportSvg']) {
    assert.ok(commands.includes(id), `command ${id}`);
  }
});

test('Mermaid preview renders, reports errors and recovers', async () => {
  const uri = file('flowchart.mmd');
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('drawGraph.preview.openToSide');
  const ok = await waitFor('mermaid rendered', () => previewOf(uri)?.status.state === 'rendered' && previewOf(uri).status);
  assert.ok(ok.width > 50 && ok.height > 50, `size ${ok.width}x${ok.height}`);

  const good = doc.getText();
  await replaceAll(doc, 'flowchart TD\n  A --> ');
  const bad = await waitFor('mermaid error', () => previewOf(uri)?.status.state === 'error' && previewOf(uri).status);
  assert.match(bad.error, /Parse error|error/i);
  await waitFor('mermaid diagnostic published', () => vscode.languages.getDiagnostics(uri).some((d) => d.source === 'DrawGraph'));

  await replaceAll(doc, good);
  await waitFor('mermaid recovered', () => previewOf(uri)?.status.state === 'rendered');
  await waitFor('mermaid diagnostic cleared', () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'DrawGraph').length === 0);
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('PlantUML preview renders the block under the cursor (server mode)', async () => {
  const uri = file('sequence.puml');
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  editor.selection = new vscode.Selection(3, 0, 3, 0);
  await vscode.commands.executeCommand('drawGraph.preview.openToSide');
  const first = await waitFor('plantuml rendered', () => previewOf(uri)?.status.state === 'rendered' && { ...previewOf(uri).status }, 45000);
  assert.ok(first.width > 50, `first diagram width ${first.width}`);

  // Move the cursor into the second @startuml block -> a different diagram.
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const classLine = doc.getText().split('\n').findIndex((l) => l.startsWith('class PreviewManager'));
  vscode.window.activeTextEditor.selection = new vscode.Selection(classLine, 0, classLine, 0);
  const second = await waitFor(
    'second diagram rendered',
    () => {
      const s = previewOf(uri)?.status;
      return s && s.count > first.count && s.state === 'rendered' && s;
    },
    45000,
  );
  assert.notDeepEqual([second.width, second.height], [first.width, first.height]);
});

test('Markdown preview plugin renders ```mermaid and ```plantuml blocks', async () => {
  const md = fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8') + '\n```plantuml\nAlice -> Bob : hello\n```\n';
  const html = await vscode.commands.executeCommand('markdown.api.render', md);
  assert.match(html, /class="drawgraph-mermaid/);
  assert.match(html, /sequenceDiagram/);
  assert.match(html, /class="drawgraph-plantuml/);
  assert.match(html, /plantuml\.com\/plantuml\/svg\//);
});

test('Document symbols, CodeLens, templates and preview lock work', async () => {
  const pumlUri = file('sequence.puml');
  await vscode.workspace.openTextDocument(pumlUri);
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', pumlUri);
  assert.ok(Array.isArray(symbols) && symbols.length >= 2, 'PlantUML outline symbols returned');

  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', pumlUri);
  assert.ok(Array.isArray(lenses) && lenses.length >= 2, 'PlantUML CodeLenses returned');

  // Open preview for flowchart.mmd, lock it, then create a template diagram alongside it.
  const mmdUri = file('flowchart.mmd');
  const mmdDoc = await vscode.workspace.openTextDocument(mmdUri);
  await vscode.window.showTextDocument(mmdDoc, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('drawGraph.preview.openToSide');
  await waitFor('flowchart rendered before lock', () => previewOf(mmdUri)?.status.state === 'rendered');
  if (!previewOf(mmdUri).locked) {
    await vscode.commands.executeCommand('drawGraph.preview.toggleLock');
  }
  assert.equal(previewOf(mmdUri).locked, true, 'preview locked to flowchart.mmd');

  await vscode.commands.executeCommand('drawGraph.diagram.newFromTemplate', 'mermaid-sequence');
  const tplDoc = vscode.window.activeTextEditor?.document;
  assert.ok(tplDoc && tplDoc.isUntitled && tplDoc.getText().includes('sequenceDiagram'));
  await waitFor('template preview rendered while locked preview stays open', () => previewOf(tplDoc.uri)?.status.state === 'rendered');
  assert.ok(previewOf(mmdUri), 'locked preview was preserved');
  await waitFor('all state machines settled', () => api.diagnostics.isSettled());
  const machines = api.diagnostics.machines();
  assert.ok(Array.isArray(machines) && machines.some((m) => m.id.startsWith('preview:') && m.state === 'ready' && m.transitions.length > 0));
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('new Mermaid diagram command opens an untitled file with a live preview', async () => {
  await vscode.commands.executeCommand('drawGraph.mermaid.new');
  const doc = vscode.window.activeTextEditor?.document;
  assert.ok(doc && doc.isUntitled && doc.languageId === 'mermaid');
  await waitFor('untitled preview rendered', () => previewOf(doc.uri)?.status.state === 'rendered');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
});

test('draw.io custom editor loads, exports and reloads on external edits', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const uri = file('architecture.drawio');
  await vscode.commands.executeCommand('vscode.open', uri);
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab.input instanceof vscode.TabInputCustom, 'opened in a custom editor');
  assert.equal(tab.input.viewType, 'drawGraph.drawio');

  await waitFor('draw.io loaded', () => drawioOf(uri)?.loads >= 1, 60000);

  const svgOut = file('out.drawio.svg');
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', svgOut);
  const svg = fs.readFileSync(svgOut.fsPath, 'utf8');
  assert.match(svg, /^<svg/);
  assert.match(svg, /content="/, 'SVG embeds the diagram so it stays editable');
  assert.match(svg, /VS Code/);

  const pngOut = file('out.drawio.png');
  await vscode.commands.executeCommand('drawGraph.drawio.exportPng', pngOut);
  const png = fs.readFileSync(pngOut.fsPath);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  // An edit made outside the visual editor must be pushed into draw.io.
  const doc = await vscode.workspace.openTextDocument(uri);
  const before = drawioOf(uri).loads;
  await replaceAll(doc, doc.getText().replace('value="Webview"', 'value="Webview (edited)"'));
  await waitFor('draw.io reloaded', () => drawioOf(uri).loads > before, 30000);
  assert.ok(doc.isDirty);

  // Exports reflect the reloaded diagram.
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', svgOut);
  assert.match(fs.readFileSync(svgOut.fsPath, 'utf8'), /Webview \(edited\)/);
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('new draw.io file can be created and opened', async () => {
  // Bypasses the save dialog: create the file the same way the command does, then open it.
  const uri = file('created.drawio');
  fs.writeFileSync(uri.fsPath, '');
  await vscode.commands.executeCommand('vscode.openWith', uri, 'drawGraph.drawio');
  await waitFor('empty draw.io file loaded', () => drawioOf(uri)?.loads >= 1, 60000);
});

// --- .drawio.svg -----------------------------------------------------------------------

const mergeCell = (label) => ({
  action: 'merge',
  xml:
    '<mxfile><diagram id="merge" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    `<mxCell id="added" value="${label}" style="ellipse;" vertex="1" parent="1"><mxGeometry x="80" y="200" width="160" height="60" as="geometry"/></mxCell>` +
    '</root></mxGraphModel></diagram></mxfile>',
});

async function openDrawio(uri) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.open', uri);
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'drawGraph.drawio', 'opened in the draw.io editor');
  await waitFor('draw.io loaded', () => drawioOf(uri)?.loads >= 1, 60000);
  return vscode.workspace.openTextDocument(uri);
}

test('.drawio.svg opens in draw.io, edits rewrite the SVG, and it reopens', async () => {
  // Produce a real draw.io SVG from the example diagram.
  const svgUri = file('flow.drawio.svg');
  await openDrawio(file('architecture.drawio'));
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', svgUri);
  const original = fs.readFileSync(svgUri.fsPath, 'utf8');
  assert.match(original, /content="/);

  const doc = await openDrawio(svgUri);
  await sleep(3000);
  assert.ok(!doc.isDirty, 'just opening the file must not modify it');
  // The diagram loaded from the SVG is the full original one.
  const loaded = file('loaded.drawio.svg');
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', loaded);
  const loadedSvg = fs.readFileSync(loaded.fsPath, 'utf8');
  for (const label of ['VS Code', 'Webview', 'draw.io (embed)', 'postMessage']) {
    assert.ok(loadedSvg.includes(label), `loaded diagram contains "${label}"`);
  }

  // Edit inside draw.io -> the document becomes a new SVG with the change embedded and drawn.
  assert.ok(api.diagnostics.drawioAction(svgUri.toString(), mergeCell('Added in SVG')));
  await waitFor('SVG rewritten', () => doc.getText().includes('Added in SVG'), 30000);
  const text = doc.getText();
  assert.match(text, /^<svg[\s\S]*<\/svg>\s*$/, 'still a complete SVG document');
  assert.match(text, /^<svg[^>]*\scontent="[^"]*Added in SVG/, 'diagram embedded (uncompressed) in the content attribute');
  assert.match(text, /^<svg[^>]*\scontent="&lt;mxfile[^"]*&lt;mxGraphModel/, 'embedded diagram is plain XML, so git diffs stay readable');
  assert.match(text.replace(/content="[^"]*"/, ''), /Added in SVG/, 'label drawn in the image itself');
  assert.ok(doc.isDirty);

  await doc.save();
  const onDisk = fs.readFileSync(svgUri.fsPath, 'utf8');
  assert.equal(onDisk, text);
  console.log(`      saved SVG root: ${onDisk.slice(0, onDisk.indexOf('content=')).slice(0, 300)}`);

  // Reopening shows the edited diagram.
  await openDrawio(svgUri);
  const check = file('check.drawio.svg');
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', check);
  assert.match(fs.readFileSync(check.fsPath, 'utf8'), /Added in SVG/);
});

test('empty .drawio.svg starts blank and becomes an SVG on the first edit', async () => {
  const uri = file('blank.drawio.svg');
  fs.writeFileSync(uri.fsPath, '');
  const doc = await openDrawio(uri);
  await sleep(1500);
  assert.equal(doc.getText(), '');
  api.diagnostics.drawioAction(uri.toString(), mergeCell('First shape'));
  await waitFor('blank SVG written', () => doc.getText().startsWith('<svg') && doc.getText().includes('First shape'), 30000);
  await doc.save();
});

test('a plain SVG without a diagram is left untouched when opened', async () => {
  const uri = file('plain.drawio.svg');
  const plain = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  fs.writeFileSync(uri.fsPath, plain);
  const doc = await openDrawio(uri);
  await sleep(1500);
  assert.equal(doc.getText(), plain);
  assert.ok(!doc.isDirty);
});

test('external edits to a .drawio.svg reload the editor', async () => {
  const uri = file('flow.drawio.svg');
  const doc = await openDrawio(uri);
  const before = drawioOf(uri).loads;
  const edit = new vscode.WorkspaceEdit();
  const renamed = doc.getText().replace(/Added in SVG/g, 'Renamed outside');
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), renamed);
  await vscode.workspace.applyEdit(edit);
  await waitFor('reloaded', () => drawioOf(uri).loads > before, 30000);
  const check = file('check2.drawio.svg');
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', check);
  assert.match(fs.readFileSync(check.fsPath, 'utf8'), /Renamed outside/);
  await vscode.commands.executeCommand('workbench.action.files.revert');
});

test('drawGraph.drawio.svgColorScheme controls the colors written to SVG', async () => {
  const uri = file('colors.drawio.svg');
  fs.writeFileSync(uri.fsPath, '');
  const doc = await openDrawio(uri);
  const cfg = () => vscode.workspace.getConfiguration('drawGraph');
  const pinkFill = /#f8cecc|rgb\(248,\s*206,\s*204\)/i;
  const drawn = (svg) => svg.replace(/content="[^"]*"/, ''); // the picture, without the embedded diagram
  const shape = (label) => ({
    action: 'merge',
    xml:
      '<mxfile><diagram id="c" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      `<mxCell id="s" value="${label}" style="rounded=1;fillColor=#f8cecc;strokeColor=#b85450;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>` +
      '</root></mxGraphModel></diagram></mxfile>',
  });
  try {
    const results = {};
    for (const scheme of ['light', 'dark', 'auto']) {
      await cfg().update('drawio.svgColorScheme', scheme, vscode.ConfigurationTarget.Global);
      const label = `scheme-${scheme}`;
      api.diagnostics.drawioAction(uri.toString(), shape(label));
      await waitFor(`SVG written with ${scheme} colors`, () => drawn(doc.getText()).includes(label), 30000);
      results[scheme] = drawn(doc.getText());
    }
    // draw.io pins colors by setting `color-scheme` on the SVG root: the light-dark() colors
    // inside then always resolve to the same variant, whatever the viewer's mode.
    const scheme = (svg) => /^<svg[^>]*style="[^"]*color-scheme:\s*([a-z ]+?)\s*;/.exec(svg)?.[1];
    assert.equal(scheme(results.light), 'light', 'light: pinned to light colors');
    assert.match(results.light, pinkFill, 'light: the light fill color is used');
    assert.equal(scheme(results.dark), 'dark', 'dark: pinned to dark colors');
    assert.equal(scheme(results.auto), 'light dark', 'auto: adaptive colors (draw.io default)');
    console.log(`      color-scheme: light=${scheme(results.light)} dark=${scheme(results.dark)} auto=${scheme(results.auto)}`);

    // "Export as SVG" follows the setting too.
    await cfg().update('drawio.svgColorScheme', 'light', vscode.ConfigurationTarget.Global);
    const exported = file('colors-export.svg');
    await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', exported);
    assert.equal(scheme(fs.readFileSync(exported.fsPath, 'utf8')), 'light');
  } finally {
    await cfg().update('drawio.svgColorScheme', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
});

test('.drawio.png opens in draw.io, edits rewrite valid PNG with embedded diagram, and Mermaid converts to draw.io', async () => {
  const pngUri = file('editable.drawio.png');
  await openDrawio(file('architecture.drawio'));
  await vscode.commands.executeCommand('drawGraph.drawio.exportPng', pngUri);
  const initialPng = fs.readFileSync(pngUri.fsPath);
  assert.deepEqual([...initialPng.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.open', pngUri);
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'drawGraph.drawioPng', 'opened in drawioPng editor');
  await waitFor('drawioPng loaded', () => drawioOf(pngUri)?.loads >= 1, 60000);

  const beforeChanges = drawioOf(pngUri).changes;
  assert.ok(api.diagnostics.drawioAction(pngUri.toString(), mergeCell('PNG Editable Node')));
  await waitFor('drawioPng updated', () => drawioOf(pngUri)?.changes > beforeChanges, 30000);
  await vscode.commands.executeCommand('workbench.action.files.save');

  const checkSvg = file('from-png-check.drawio.svg');
  await vscode.commands.executeCommand('drawGraph.drawio.exportSvg', checkSvg);
  assert.match(fs.readFileSync(checkSvg.fsPath, 'utf8'), /PNG Editable Node/);

  // Convert a Mermaid diagram directly into a saved .drawio file and verify draw.io loads it.
  const convertedUri = file('from-mermaid.drawio');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('drawGraph.mermaid.openInDrawio', file('flowchart.mmd'), undefined, convertedUri);
  await waitFor(
    'Mermaid converted, saved, and loaded in draw.io',
    () =>
      fs.existsSync(convertedUri.fsPath) &&
      fs.readFileSync(convertedUri.fsPath, 'utf8').includes('<mxGraphModel') &&
      drawioOf(convertedUri)?.loads >= 1,
    60000,
  );
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

// --- Keyboard shortcuts inside the draw.io editor ----------------------------------------
// Real input is sent through the Chrome DevTools protocol (runTest.mjs opens port 9339).

async function devtools() {
  const targets = await (await fetch('http://127.0.0.1:9339/json')).json();
  const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  return {
    close: () => ws.close(),
    evaluate,
    async clickWebview(fx, fy) {
      const r = await evaluate(
        `(() => { const f = [...document.querySelectorAll('iframe')].find((el) => { const b = el.getBoundingClientRect(); return b.width > 100 && b.height > 100 && b.left >= 0 && b.top >= 0 && getComputedStyle(el).visibility !== 'hidden'; }); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
      );
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: r.x + r.w * fx, y: r.y + r.h * fy, button: 'left', clickCount: 1 });
      }
      await sleep(300);
    },
    // modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8
    async key(key, code, keyCode, modifiers = 0) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
      }
      await sleep(700);
    },
  };
}

const PRIMARY = process.platform === 'darwin' ? 4 : 2; // Cmd on macOS, Ctrl elsewhere
const quickInputOpen = `(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()`;

test('VS Code shortcuts work while the draw.io editor has focus', async () => {
  const cdp = await devtools();
  try {
    const uri = file('architecture.drawio');
    await openDrawio(uri);
    const focusCanvas = () => cdp.clickWebview(0.6, 0.75);

    await focusCanvas();
    await cdp.key('P', 'KeyP', 80, PRIMARY | 8);
    assert.ok(await cdp.evaluate(quickInputOpen), 'Cmd/Ctrl+Shift+P opens the command palette');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    await focusCanvas();
    await cdp.key('F1', 'F1', 112);
    assert.ok(await cdp.evaluate(quickInputOpen), 'F1 opens the command palette');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    // draw.io keeps its own shortcuts: select all + delete edits the diagram.
    await focusCanvas();
    const before = drawioOf(uri).changes;
    await cdp.key('a', 'KeyA', 65, PRIMARY);
    await cdp.key('Delete', 'Delete', 46);
    await waitFor('draw.io handled its own shortcut', () => drawioOf(uri).changes > before, 10000);
    await vscode.commands.executeCommand('workbench.action.files.revert');

    await focusCanvas();
    await cdp.key('w', 'KeyW', 87, PRIMARY);
    await waitFor('Cmd/Ctrl+W closed the editor', () => !drawioOf(uri), 5000);

    // With the setting off, draw.io keeps the keys (Cmd/Ctrl+Shift+P toggles its format panel).
    await vscode.workspace.getConfiguration('drawGraph').update('drawio.vscodeShortcuts', false, vscode.ConfigurationTarget.Global);
    await openDrawio(uri);
    await focusCanvas();
    await cdp.key('P', 'KeyP', 80, PRIMARY | 8);
    assert.ok(!(await cdp.evaluate(quickInputOpen)), 'not forwarded when drawGraph.drawio.vscodeShortcuts is false');
    await cdp.key('P', 'KeyP', 80, PRIMARY | 8); // toggle draw.io's format panel back
  } finally {
    await vscode.workspace.getConfiguration('drawGraph').update('drawio.vscodeShortcuts', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    cdp.close();
  }
});

test('IntelliSense, formatting, URL generation, batch export, source extraction & Code Links work', async () => {
  // 1. CompletionItemProvider & DocumentFormattingEditProvider
  const fmtUri = file('unformatted.mmd');
  fs.writeFileSync(fmtUri.fsPath, 'flowchart LR\nsubgraph Backend\nAPI[API] --> DB[(DB)]\nend\n');
  const fmtDoc = await vscode.workspace.openTextDocument(fmtUri);
  const completions = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    fmtUri,
    new vscode.Position(2, 3),
  );
  assert.ok(completions && completions.items.some((i) => i.label === 'API' || (i.label && i.label.label === 'API')), 'completes declared Mermaid node IDs');

  const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', fmtUri, {
    tabSize: 2,
    insertSpaces: true,
  });
  assert.ok(Array.isArray(edits) && edits.length >= 1, 'returns formatting edits');
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.set(fmtUri, edits);
  await vscode.workspace.applyEdit(wsEdit);
  assert.match(fmtDoc.getText(), /\n  subgraph Backend\n    API\[API\] --> DB\[\(DB\)\]\n  end/);
  await fmtDoc.save();

  // 2. Shareable PlantUML URL generation
  const pumlUri = file('sequence.puml');
  const mdSnippet = await vscode.commands.executeCommand('drawGraph.plantuml.generateUrl', pumlUri, 'markdown');
  assert.match(String(mdSnippet), /^!\[diagram\]\(https:\/\/www\.plantuml\.com\/plantuml\/svg\/[0-9A-Za-z\-_]+\)$/);

  // 3. Batch export all diagrams in multi-block PlantUML + extract embedded PlantUML source from SVG
  const batchOutDir = vscode.Uri.file(fs.mkdtempSync(path.join(workspace, 'batch-out-')));
  try {
    const exportedUris = await vscode.commands.executeCommand('drawGraph.exportDocumentDiagrams', pumlUri, 'svg', batchOutDir);
    assert.ok(Array.isArray(exportedUris) && exportedUris.length >= 2, `batch exported ${exportedUris?.length} SVGs`);
    assert.ok(fs.existsSync(exportedUris[0].fsPath));

    const extractedPumlDoc = await vscode.commands.executeCommand('drawGraph.extractSource', exportedUris[0]);
    assert.ok(extractedPumlDoc, 'extracted embedded PlantUML source from server-rendered SVG');
    assert.equal(extractedPumlDoc.languageId, 'plantuml');
    assert.match(extractedPumlDoc.getText(), /@startuml/);
  } finally {
    fs.rmSync(batchOutDir.fsPath, { recursive: true, force: true });
    if (fs.existsSync(fmtUri.fsPath)) {
      fs.unlinkSync(fmtUri.fsPath);
    }
  }

  // 4. .dio.svg custom editor + Code Links file:line navigation
  const dioSvgUri = file('linked.dio.svg');
  fs.writeFileSync(dioSvgUri.fsPath, '');
  const dioDoc = await openDrawio(dioSvgUri);
  assert.ok(await vscode.commands.executeCommand('drawGraph.drawio.insertCodeSymbol', 'PreviewManager'));
  await waitFor('.dio.svg updated with code symbol node', () => dioDoc.getText().includes('#PreviewManager'), 30000);
  await dioDoc.save();

  const extractedXmlDoc = await vscode.commands.executeCommand('drawGraph.extractSource', dioSvgUri);
  assert.ok(extractedXmlDoc && extractedXmlDoc.getText().includes('#PreviewManager'), 'extracted mxfile XML from .dio.svg');

  const jumped = await vscode.commands.executeCommand('drawGraph.drawio.navigateCodeLinks', 'flowchart.mmd:2');
  assert.equal(jumped, true, 'Code Link jumped to workspace file:line');
  assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('flowchart.mmd'));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  fs.unlinkSync(dioSvgUri.fsPath);
});

exports.run = async function run() {
  const failures = [];
  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      console.log(`  ✔ ${name} (${Date.now() - start}ms)`);
    } catch (err) {
      failures.push(name);
      console.log(`  ✖ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n  ${tests.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) {
    throw new Error(`${failures.length} integration test(s) failed`);
  }
};
