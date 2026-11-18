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

async function evalInTarget(predicate, expression) {
  const targets = await (await fetch('http://127.0.0.1:9339/json')).json();
  const target = targets.find((t) => predicate(t) && t.webSocketDebuggerUrl);
  if (!target) {
    return undefined;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const res = await new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    return res.result.value;
  } finally {
    ws.close();
  }
}

test('Settings Drawer, runtime Chinese/English switching, and Draw.io GitHub badge hiding work', async () => {
  const cfg = () => vscode.workspace.getConfiguration('drawGraph');
  try {
    // 1. Open Draw.io, verify bottom-right GitHub icon is hidden via configure CSS, and open Settings Drawer
    const uri = file('architecture.drawio');
    await openDrawio(uri);
    const ghState = await evalInTarget(
      (t) => /embed\.diagrams\.net/.test(t.url || ''),
      `(() => {
        const els = [...document.querySelectorAll('a[href*="github"], img[src*="github"], [title*="GitHub"]')];
        const corner = [...document.querySelectorAll('a, img, div')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.width <= 48 && r.height > 0 && r.height <= 48 && r.right >= window.innerWidth - 40 && r.bottom >= window.innerHeight - 36;
        }).map((e) => ({ tag: e.tagName, cls: e.className, title: e.getAttribute('title'), href: e.getAttribute('href'), src: e.getAttribute('src') }));
        return {
          totalGithubNodes: els.length,
          visibleGithubNodes: els.filter((e) => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0).map((e) => e.outerHTML.slice(0, 160)),
          corner,
        };
      })()`,
    );
    console.log('      draw.io corner inspection:', JSON.stringify(ghState));
    if (ghState) {
      assert.equal(ghState.visibleGithubNodes.length, 0, 'no visible GitHub badge inside draw.io');
    }

    // Open slide-in Settings Drawer over active Draw.io editor
    await vscode.commands.executeCommand('drawGraph.openSettings');
    await waitFor(
      'Settings Drawer active in Draw.io webview',
      async () => {
        const targets = await (await fetch('http://127.0.0.1:9339/json')).json();
        for (const t of targets.filter((x) => /vscode-webview/.test(x.url || '') && x.webSocketDebuggerUrl)) {
          const val = await evalInTarget(
            (cand) => cand.id === t.id,
            `!!((document.querySelector('#active-frame') && document.querySelector('#active-frame').contentDocument) || document).querySelector('#settingsWidget.active')`,
          );
          if (val === true) {
            return true;
          }
        }
        return false;
      },
      10000,
    );

    // 2. Live Chinese <-> English runtime switching updates CodeLens & Draw.io language without restart
    const beforeZhLoads = drawioOf(uri).loads;
    await cfg().update('language', 'Simplified Chinese', vscode.ConfigurationTarget.Global);
    await waitFor(
      'Draw.io reloaded in Simplified Chinese',
      () => drawioOf(uri)?.loads > beforeZhLoads && drawioOf(uri)?.phase === 'ready',
      45000,
    );
    const zhDrawioTarget = (await (await fetch('http://127.0.0.1:9339/json')).json()).find((t) => /embed\.diagrams\.net/.test(t.url || ''));
    if (zhDrawioTarget) {
      assert.match(zhDrawioTarget.url, /lang=zh\b/, 'draw.io iframe switched to lang=zh');
    }

    const mmdUri = file('flowchart.mmd');
    await vscode.workspace.openTextDocument(mmdUri);
    const zhLenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', mmdUri);
    assert.ok(zhLenses.some((l) => l.command && l.command.title.includes('预览')), 'CodeLens switched to Chinese');

    const beforeEnLoads = drawioOf(uri).loads;
    await cfg().update('language', 'English', vscode.ConfigurationTarget.Global);
    await waitFor(
      'Draw.io reloaded in English',
      () => drawioOf(uri)?.loads > beforeEnLoads && drawioOf(uri)?.phase === 'ready',
      45000,
    );
    const enLenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', mmdUri);
    assert.ok(enLenses.some((l) => l.command && l.command.title.includes('Preview')), 'CodeLens switched back to English');
  } finally {
    await cfg().update('language', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

function makeMiniZip(entries) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const dataBuf = Buffer.from(e.content, 'utf8');
    const crc = crc32(dataBuf);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(dataBuf.length, 18);
    loc.writeUInt32LE(dataBuf.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, dataBuf);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(dataBuf.length, 20);
    cen.writeUInt32LE(dataBuf.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

test('v0.3 language intelligence, converters, PDF/multi-page export, code-to-diagram, visual diff, explorer, presentation mode, and offline pack work', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 1. Language Intelligence: DocumentLinks, Rename, ColorPicker, QuickFix, SignatureHelp, Hover
  const intelUri = file('intel-v03.puml');
  fs.writeFileSync(
    intelUri.fsPath,
    [
      '@startuml',
      '!include <C4/C4_Container>',
      '!include sequence.puml',
      'skinparam backgroundColor #1e293b',
      'Container(orderSvc, "Order Service", "Node.js")',
      'orderSvc -> Billing : flowchart.mmd:1',
    ].join('\n'),
  );

  try {
    await vscode.workspace.openTextDocument(intelUri);
    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', intelUri);
    assert.ok(Array.isArray(links) && links.length >= 2, 'DocumentLinkProvider found !include and file:line links');

    const colors = await vscode.commands.executeCommand('vscode.executeDocumentColorProvider', intelUri);
    assert.ok(Array.isArray(colors) && colors.length === 1, 'DocumentColorProvider found #1e293b');

    const sigHelp = await vscode.commands.executeCommand(
      'vscode.executeSignatureHelpProvider',
      intelUri,
      new vscode.Position(4, 22),
      ',',
    );
    assert.ok(sigHelp && sigHelp.signatures.length >= 1 && sigHelp.activeParameter === 1, 'C4 SignatureHelp returned');

    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      intelUri,
      new vscode.Position(4, 4),
    );
    assert.ok(Array.isArray(hovers) && hovers.length >= 1, 'C4 HoverProvider returned macro documentation');

    const codeActions = await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider',
      intelUri,
      new vscode.Range(0, 0, 0, 5),
    );
    assert.ok(Array.isArray(codeActions) && codeActions.some((a) => a.title.includes('@enduml')), 'Quick Fix suggests @enduml');

    const renameEdit = await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      intelUri,
      new vscode.Position(5, 3),
      'checkoutSvc',
    );
    assert.ok(renameEdit && await vscode.workspace.applyEdit(renameEdit), 'RenameProvider produced valid WorkspaceEdit');
    const renamedDoc = await vscode.workspace.openTextDocument(intelUri);
    assert.match(renamedDoc.getText(), /Container\(checkoutSvc,/);
    assert.match(renamedDoc.getText(), /checkoutSvc -> Billing/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  } finally {
    if (fs.existsSync(intelUri.fsPath)) {
      fs.unlinkSync(intelUri.fsPath);
    }
  }

  // 2. PlantUML <-> Mermaid Converters & Universal PDF Export & Multi-Page Draw.io Export
  const convMmdDoc = await vscode.commands.executeCommand('drawGraph.convert.plantumlToMermaid', file('sequence.puml'));
  assert.ok(convMmdDoc && convMmdDoc.languageId === 'mermaid' && convMmdDoc.getText().includes('sequenceDiagram'));
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

  const convPumlDoc = await vscode.commands.executeCommand('drawGraph.convert.mermaidToPlantuml', file('flowchart.mmd'));
  assert.ok(convPumlDoc && convPumlDoc.languageId === 'plantuml' && convPumlDoc.getText().includes('@startuml'));
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

  const pdfOut = file('flowchart-export.pdf');
  const multiDrawio = file('multipage.drawio');
  const multiDir = file('multipage-out');
  fs.mkdirSync(multiDir.fsPath, { recursive: true });
  fs.writeFileSync(
    multiDrawio.fsPath,
    '<mxfile>' +
      '<diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Alpha" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '<diagram id="p2" name="Detail"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="Beta" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '</mxfile>',
  );
  try {
    await vscode.commands.executeCommand('drawGraph.exportPdf', file('flowchart.mmd'), pdfOut);
    const pdfBytes = fs.readFileSync(pdfOut.fsPath);
    assert.ok(pdfBytes.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'valid PDF 1.4 exported from Mermaid');

    const pageFiles = await vscode.commands.executeCommand('drawGraph.drawio.exportAllPages', multiDrawio, 'svg', multiDir);
    assert.equal(pageFiles.length, 2, 'exported 2 Draw.io pages');
    assert.match(fs.readFileSync(pageFiles[0].fsPath, 'utf8'), /Alpha/);
    assert.match(fs.readFileSync(pageFiles[1].fsPath, 'utf8'), /Beta/);

    const multiPdfFiles = await vscode.commands.executeCommand('drawGraph.drawio.exportAllPages', multiDrawio, 'pdf', multiDir);
    assert.equal(multiPdfFiles.length, 1, 'exported unopened multi-page Draw.io directly to single PDF');
    assert.match(fs.readFileSync(multiPdfFiles[0].fsPath, 'latin1'), /\/Count 2/);

    // 3. Diagram Explorer TreeView indexes workspace diagrams + multi-page children
    api.diagnostics.diagramExplorer && await vscode.commands.executeCommand('drawGraph.diagramExplorer.refresh');
    const treeEntries = await api.diagnostics.diagramExplorer();
    assert.ok(treeEntries.some((e) => e.label === 'multipage.drawio' && e.childCount === 2), 'Explorer indexed multipage.drawio with 2 pages');
    assert.ok(treeEntries.some((e) => e.label === 'notes.md' && e.childCount >= 1), 'Explorer indexed Markdown diagram fences');
  } finally {
    if (fs.existsSync(pdfOut.fsPath)) fs.unlinkSync(pdfOut.fsPath);
    if (fs.existsSync(multiDrawio.fsPath)) fs.unlinkSync(multiDrawio.fsPath);
    fs.rmSync(multiDir.fsPath, { recursive: true, force: true });
  }

  // 4. Code-to-Diagram Generator & Markdown Fence Export / Extract to .drawio.svg
  const sampleTs = file('sampleService.ts');
  const helperTs = file('sampleHelper.ts');
  const mdTemp = file('extract-demo.md');
  const extractedSvg = file('extract-demo-1.drawio.svg');
  const fenceSvg = file('fence-out.svg');
  fs.writeFileSync(helperTs.fsPath, 'export interface Store { save(id: string): void; }\n');
  fs.writeFileSync(
    sampleTs.fsPath,
    'import { Store } from "./sampleHelper";\nexport class MemoryStore implements Store {\n  items: string[] = [];\n  save(id: string): void {}\n}\n',
  );
  fs.writeFileSync(mdTemp.fsPath, '# Architecture\n\n```mermaid\nflowchart LR\n  Client --> Server\n```\n');
  try {
    const genClsDoc = await vscode.commands.executeCommand('drawGraph.generateClassDiagram', sampleTs, 'mermaid');
    assert.ok(genClsDoc && genClsDoc.getText().includes('MemoryStore'), 'generated Mermaid class diagram from TypeScript');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    const genDepDoc = await vscode.commands.executeCommand('drawGraph.generateDependencyDiagram', sampleTs, 'mermaid');
    assert.ok(genDepDoc && genDepDoc.getText().includes('sampleService.ts') && genDepDoc.getText().includes('sampleHelper.ts'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    // SQL DDL -> Mermaid erDiagram generator & static syntax linter without preview open
    const sqlDoc = await vscode.commands.executeCommand(
      'drawGraph.generateFromData',
      'CREATE TABLE users (id INT PRIMARY KEY);\nCREATE TABLE orders (id INT PRIMARY KEY, user_id INT REFERENCES users(id));',
      'mermaid',
    );
    assert.ok(sqlDoc && sqlDoc.getText().includes('erDiagram') && sqlDoc.getText().includes('orders'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const badStaticUri = file('static-lint-check.mmd');
    fs.writeFileSync(badStaticUri.fsPath, 'flowchart TD\n  subgraph UnclosedGroup\n    A --> B\n');
    try {
      await vscode.workspace.openTextDocument(badStaticUri);
      await waitFor(
        'static syntax diagnostic without preview panel',
        () => vscode.languages.getDiagnostics(badStaticUri).some((d) => d.source === 'DrawGraph' && /subgraph/i.test(d.message)),
        5000,
      );
    } finally {
      if (fs.existsSync(badStaticUri.fsPath)) fs.unlinkSync(badStaticUri.fsPath);
    }

    await vscode.commands.executeCommand('drawGraph.markdown.exportFence', mdTemp, 0, 'svg', fenceSvg);
    assert.match(fs.readFileSync(fenceSvg.fsPath, 'utf8'), /^<svg/);

    await vscode.commands.executeCommand('drawGraph.markdown.extractToDrawioSvg', mdTemp, 0, extractedSvg);
    assert.match(fs.readFileSync(extractedSvg.fsPath, 'utf8'), /content="&lt;mxfile/);
    const updatedMd = await vscode.workspace.openTextDocument(mdTemp);
    assert.match(updatedMd.getText(), /!\[diagram\]\(\.\/extract-demo-1\.drawio\.svg\)/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  } finally {
    for (const f of [sampleTs, helperTs, mdTemp, extractedSvg, fenceSvg]) {
      if (fs.existsSync(f.fsPath)) fs.unlinkSync(f.fsPath);
    }
  }

  // 5. Visual Diagram Diff + Presentation Mode + Offline Pack ZIP Import & Loopback Server
  const diffV2 = file('arch-v2.drawio');
  fs.writeFileSync(
    diffV2.fsPath,
    fs.readFileSync(file('architecture.drawio').fsPath, 'utf8').replace('Webview', 'Webview v2'),
  );
  const packZip = file('mini-drawio-pack.zip');
  fs.writeFileSync(
    packZip.fsPath,
    makeMiniZip([
      { name: 'webapp/index.html', content: '<!doctype html><title>Offline Draw.io Pack</title>' },
      { name: 'webapp/js/app.js', content: 'window.__OFFLINE_PACK__ = true;' },
    ]),
  );
  try {
    await vscode.commands.executeCommand('drawGraph.visualDiffFiles', file('architecture.drawio'), diffV2);
    await waitFor('visual diff webview ready', () => api.diagnostics.visualDiffs().some((d) => d.ready), 15000);

    // Presentation mode toggle in Mermaid preview
    const mmdDoc = await vscode.workspace.openTextDocument(file('flowchart.mmd'));
    await vscode.window.showTextDocument(mmdDoc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('drawGraph.preview.openToSide');
    await waitFor('flowchart preview ready', () => previewOf(file('flowchart.mmd'))?.status.state === 'rendered');
    const toggledPresent = await waitFor(
      'presentation mode toggled in preview webview',
      async () => {
        const targets = await (await fetch('http://127.0.0.1:9339/json')).json();
        for (const t of targets.filter((x) => /vscode-webview/.test(x.url || '') && x.webSocketDebuggerUrl)) {
          const ok = await evalInTarget(
            (cand) => cand.id === t.id,
            `(() => {
              const doc = (document.querySelector('#active-frame') && document.querySelector('#active-frame').contentDocument) || document;
              const btn = doc.querySelector('#presentToggle');
              if (!btn) return false;
              btn.click();
              return doc.body.classList.contains('presentation-mode');
            })()`,
          );
          if (ok === true) return true;
        }
        return false;
      },
      10000,
    );
    assert.equal(toggledPresent, true);

    // Offline pack import -> loopback HTTP server serves index.html -> remove cleans up
    const imported = await vscode.commands.executeCommand('drawGraph.drawio.importOfflinePack', packZip);
    assert.equal(imported, true);
    const packState = api.diagnostics.offlinePack();
    assert.equal(packState.installed, true);
    assert.ok(packState.serverOrigin && packState.serverOrigin.startsWith('http://127.0.0.1:'));
    const servedHtml = await (await fetch(`${packState.serverOrigin}/index.html`)).text();
    assert.match(servedHtml, /Offline Draw\.io Pack/);
    await vscode.commands.executeCommand('drawGraph.drawio.removeOfflinePack');
    assert.equal(api.diagnostics.offlinePack().installed, false);
  } finally {
    if (fs.existsSync(diffV2.fsPath)) fs.unlinkSync(diffV2.fsPath);
    if (fs.existsSync(packZip.fsPath)) fs.unlinkSync(packZip.fsPath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

test('v0.4 DOT & WaveDrom previews, broken-link audit & rename sync, Draw.io->Mermaid/PlantUML, interactive HTML export, spec/infra generators, hover preview, and branch review work', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const dotUri = file('topology.dot');
  const waveUri = file('spi.wavedrom');
  const htmlOut = file('architecture-bundle.html');
  const libUri = vscode.Uri.joinPath(vscode.Uri.file(workspace), '.vscode', 'drawgraph-library.xml');
  const movedSrcOld = file('oldModule.ts');
  const movedSrcNew = file('renamedModule.ts');
  const linkedMmd = file('linked-arch.mmd');

  fs.writeFileSync(dotUri.fsPath, 'digraph G { rankdir=LR; Gateway -> Auth [label="RPC"]; Auth [shape=cylinder]; }\n');
  fs.writeFileSync(
    waveUri.fsPath,
    '{ signal: [{ name: "CLK", wave: "p...." }, { name: "DATA", wave: "x3..x", data: ["0x5A"] }] }\n',
  );
  fs.writeFileSync(movedSrcOld.fsPath, '// @see architecture.drawio\nexport class OldController {}\n');
  fs.writeFileSync(linkedMmd.fsPath, 'flowchart LR\n  A[Node] --> B[Missing]\n  click A "oldModule.ts:2"\n  click B "nonExistentTarget.ts:9"\n');

  try {
    // 1. Native Graphviz DOT & WaveDrom live previews + Document Symbols
    await vscode.commands.executeCommand('drawGraph.preview.open', dotUri);
    await waitFor(
      'DOT preview rendered',
      () => previewOf(dotUri)?.status.state === 'rendered' && previewOf(dotUri)?.status.width > 50,
      10000,
    );
    const dotSyms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', dotUri);
    assert.ok(Array.isArray(dotSyms) && dotSyms.length >= 1, 'DOT DocumentSymbolProvider returned outline');

    await vscode.commands.executeCommand('drawGraph.preview.open', waveUri);
    await waitFor(
      'WaveDrom preview rendered',
      () => previewOf(waveUri)?.status.state === 'rendered' && previewOf(waveUri)?.status.width > 50,
      10000,
    );

    // 2. Markdown preview plugin renders ```dot and ```wavedrom blocks
    const mdRendered = await vscode.commands.executeCommand(
      'markdown.api.render',
      '```dot\ndigraph X { A -> B }\n```\n\n```wavedrom\n{"reg":[{"bits":8,"name":"CTRL"}]}\n```',
    );
    assert.match(mdRendered, /drawgraph-dot/, 'Markdown rendered DOT block');
    assert.match(mdRendered, /drawgraph-wavedrom/, 'Markdown rendered WaveDrom block');

    // 3. Broken Code-Link warning diagnostic + Workspace Audit + File-Rename Auto-Sync
    await vscode.workspace.openTextDocument(linkedMmd);
    await waitFor(
      'Broken code-link warning reported on nonExistentTarget.ts',
      () => vscode.languages.getDiagnostics(linkedMmd).some((d) => d.code === 'broken-code-link'),
      5000,
    );
    const brokenList = await vscode.commands.executeCommand('drawGraph.checkCodeLinks', false);
    assert.ok(Array.isArray(brokenList) && brokenList.some((b) => b.target.includes('nonExistentTarget.ts')));

    const renameEdit = new vscode.WorkspaceEdit();
    renameEdit.renameFile(movedSrcOld, movedSrcNew);
    await vscode.workspace.applyEdit(renameEdit);
    await waitFor(
      'Diagram file path auto-updated after workspace renameFile',
      async () => (await vscode.workspace.openTextDocument(linkedMmd)).getText().includes('renamedModule.ts:2'),
      6000,
    );

    // 4. Source code comment Hover thumbnail preview (`// @see architecture.drawio`)
    const commentHovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      movedSrcNew,
      new vscode.Position(0, 12),
    );
    assert.ok(
      Array.isArray(commentHovers) &&
        commentHovers.some((h) => h.contents.some((c) => String(c.value || c).includes('data:image/svg+xml;base64,'))),
      'Source comment hover rendered inline Draw.io SVG thumbnail',
    );

    // 5. Draw.io -> Mermaid & PlantUML reverse conversion + Standalone Interactive HTML export
    const revMmdDoc = await vscode.commands.executeCommand('drawGraph.convert.drawioToMermaid', file('architecture.drawio'));
    assert.ok(revMmdDoc && revMmdDoc.languageId === 'mermaid' && revMmdDoc.getText().includes('flowchart'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    await vscode.commands.executeCommand('drawGraph.exportHtml', file('architecture.drawio'), htmlOut);
    assert.match(fs.readFileSync(htmlOut.fsPath, 'utf8'), /<!DOCTYPE html>/);

    // 6. Spec (Prisma) & Infra (Docker Compose) generators + Workspace Library Scaffolder
    const prismaDoc = await vscode.commands.executeCommand(
      'drawGraph.generateFromSpec',
      'model Account { id Int @id\n sessions Session[] }\nmodel Session { id Int @id\n accountId Int\n account Account @relation(fields: [accountId], references: [id]) }',
      'mermaid',
    );
    assert.ok(prismaDoc && prismaDoc.getText().includes('erDiagram') && prismaDoc.getText().includes('Account'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    const composeDoc = await vscode.commands.executeCommand(
      'drawGraph.generateInfraDiagram',
      'services:\n  web:\n    image: nginx\n    depends_on: [redis]\n  redis:\n    image: redis:7\n',
      'mermaid',
    );
    assert.ok(composeDoc && composeDoc.getText().includes('SVC_redis'));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    const createdLib = await vscode.commands.executeCommand('drawGraph.drawio.createWorkspaceLibrary', libUri);
    assert.ok(createdLib && fs.existsSync(libUri.fsPath), 'Created .vscode/drawgraph-library.xml');
  } finally {
    for (const u of [dotUri, waveUri, htmlOut, libUri, movedSrcOld, movedSrcNew, linkedMmd]) {
      if (fs.existsSync(u.fsPath)) fs.unlinkSync(u.fsPath);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

test('v0.5 AI Diagram Studio, Multi-Provider SSE Streaming, SecretStorage, Syntax Auto-Fix, and Architecture Review work', async () => {
  const http = require('node:http');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  let sawAuthHeader = '';
  const mockServer = http.createServer((req, res) => {
    sawAuthHeader = String(req.headers.authorization || '');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-architect-v1' }, { id: 'mock-r1-reasoner' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const userText = String(parsed.messages?.[parsed.messages.length - 1]?.content || '');
        let replyContent;
        if (userText.includes('BROKEN_DIAGRAM') || userText.includes('Fix all syntax errors')) {
          replyContent = '```mermaid\nflowchart TD\n  subgraph FixedGroup\n    A["Client"] --> B["API"]\n  end\n```\n- Closed subgraph block';
        } else if (userText.includes('## Findings')) {
          replyContent =
            '<think>Reviewing architecture...</think>\n## Overview\nService gateway.\n\n## Findings\n- [HIGH] `AuthDB` — Single point of failure: Add synchronous replica.';
        } else if (userText.includes('MODIFICATION_REQUEST')) {
          replyContent =
            '```mermaid\nflowchart LR\n  Gateway["API Gateway"] --> Redis[("Redis Cache")]\n  Redis --> Order["Order Service"]\n```\n- Added Redis Cache';
        } else {
          replyContent =
            '<think>Designing clean topology...</think>\n```mermaid\nflowchart LR\n  Gateway["API Gateway"] --> Order["Order Service"]\n```\n- Created Gateway to Order flow';
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const mid = Math.floor(replyContent.length / 2);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyContent.slice(0, mid) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyContent.slice(mid) } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  const cfg = vscode.workspace.getConfiguration('drawGraph');
  const brokenUri = file('ai-broken.mmd');

  try {
    await cfg.update('ai.provider', 'OpenAI Compatible', vscode.ConfigurationTarget.Global);
    await cfg.update('ai.baseUrl', `http://127.0.0.1:${port}/v1`, vscode.ConfigurationTarget.Global);
    await cfg.update('ai.model', '', vscode.ConfigurationTarget.Global);

    // 1. SecretStorage API key + /v1/models auto-discovery
    const keySaved = await vscode.commands.executeCommand(
      'drawGraph.ai.setApiKey',
      'OpenAI Compatible',
      'sk-test-drawgraph-v05',
    );
    assert.equal(keySaved, true);

    const models = await vscode.commands.executeCommand('drawGraph.ai.discoverModels', 'OpenAI Compatible', true);
    assert.deepEqual(models, ['mock-architect-v1', 'mock-r1-reasoner']);
    assert.equal(sawAuthHeader, 'Bearer sk-test-drawgraph-v05');

    // 2. Prompt -> Diagram generation (SSE streaming + <think> stripping + live preview)
    const genRes = await vscode.commands.executeCommand('drawGraph.ai.generateDiagram', {
      prompt: 'Gateway to Order service',
      format: 'mermaid',
      openNewIfNoTarget: true,
      skipConsent: true,
    });
    assert.ok(genRes && genRes.appliedUri, 'AI generated and opened new diagram');
    assert.ok(genRes.code.includes('Order Service') && !genRes.code.includes('<think>'));
    await waitFor(
      'AI generated Mermaid preview rendered',
      () => previewOf(genRes.appliedUri)?.status.state === 'rendered',
      10000,
    );

    // 3. Natural-language diagram modification in-place
    const modRes = await vscode.commands.executeCommand('drawGraph.ai.modifyDiagram', {
      prompt: 'Insert Redis cache before Order Service',
      targetUri: genRes.appliedUri,
      applyImmediately: true,
      skipConsent: true,
    });
    assert.ok(modRes && modRes.code.includes('Redis Cache'));
    const updatedDoc = await vscode.workspace.openTextDocument(genRes.appliedUri);
    assert.match(updatedDoc.getText(), /Redis Cache/);

    // 4. Interactive AI Diagram Studio webview boots and reaches ready state + explicit FSM introspection
    await vscode.commands.executeCommand('drawGraph.ai.openStudio', {
      targetUri: genRes.appliedUri,
      mode: 'modify',
    });
    await waitFor('AI Diagram Studio webview ready', () => api.diagnostics.aiStudio().ready === true, 10000);
    const machineIds = api.diagnostics.machines().map((m) => m.id);
    assert.ok(machineIds.includes('ai-studio'), 'ai-studio state machine registered in diagnostics.machines()');
    assert.ok(machineIds.includes('offline-pack'), 'offline-pack state machine registered in diagnostics.machines()');
    assert.ok(machineIds.includes('diagram-explorer'), 'diagram-explorer state machine registered in diagnostics.machines()');
    assert.ok(machineIds.includes('mermaid-offscreen-worker'), 'mermaid-offscreen-worker state machine registered in diagnostics.machines()');
    await waitFor('All subsystem FSMs reach settled state', () => api.diagnostics.isSettled() === true, 5000);

    // 5. Quick Fix CodeActionProvider + one-click AI syntax auto-repair
    fs.writeFileSync(brokenUri.fsPath, 'flowchart TD\n  subgraph UnclosedGroup\n    A --> B\n');
    const brokenDoc = await vscode.workspace.openTextDocument(brokenUri);
    await waitFor(
      'Broken diagram diagnostic emitted',
      () => vscode.languages.getDiagnostics(brokenUri).some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      5000,
    );
    const actions = await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider',
      brokenUri,
      new vscode.Range(0, 0, 1, 5),
    );
    assert.ok(
      Array.isArray(actions) && actions.some((a) => a.command?.command === 'drawGraph.ai.fixSyntax'),
      'Quick Fix lightbulb exposes Fix Diagram Syntax with AI',
    );
    await vscode.commands.executeCommand('drawGraph.ai.fixSyntax', brokenUri, 'Unclosed subgraph', true);
    assert.match(brokenDoc.getText(), /subgraph FixedGroup[\s\S]*end/);

    // 6. Architecture review structured findings
    const explainRes = await vscode.commands.executeCommand('drawGraph.ai.explainDiagram', {
      targetUri: genRes.appliedUri,
      headless: true,
      skipConsent: true,
    });
    assert.ok(explainRes && explainRes.findings.some((f) => f.severity === 'HIGH' && f.subject === 'AuthDB'));
  } finally {
    mockServer.close();
    if (fs.existsSync(brokenUri.fsPath)) fs.unlinkSync(brokenUri.fsPath);
    await vscode.commands.executeCommand('drawGraph.ai.clearApiKey', 'OpenAI Compatible', true);
    await cfg.update('ai.provider', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('ai.baseUrl', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('ai.model', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
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
