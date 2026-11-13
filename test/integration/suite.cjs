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
  for (const id of ['drawGraph.preview.open', 'drawGraph.preview.openToSide', 'drawGraph.drawio.new', 'drawGraph.drawio.exportSvg']) {
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

  await replaceAll(doc, good);
  await waitFor('mermaid recovered', () => previewOf(uri)?.status.state === 'rendered');
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

test('Markdown preview plugin turns ```mermaid into a diagram placeholder', async () => {
  const md = fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8');
  const html = await vscode.commands.executeCommand('markdown.api.render', md);
  assert.match(html, /class="drawgraph-mermaid/);
  assert.match(html, /sequenceDiagram/);
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
