import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-v03-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: {
    minimalEdit: 'src/drawio/minimalEdit.ts',
    pdfWriter: 'src/export/pdfWriter.ts',
    renderer: 'src/plantuml/renderer.ts',
    mermaidToDrawio: 'src/drawio/mermaidToDrawio.ts',
    converters: 'src/converters/diagramConverters.ts',
    codeToDiagram: 'src/generators/codeToDiagram.ts',
    mxfileToSvg: 'src/drawio/mxfileToSvg.ts',
    advancedFeatures: 'src/language/advancedFeatures.ts',
    lang: 'src/language/completionsAndFormat.ts',
    codeLinksXml: 'src/drawio/codeLinksXml.ts',
    zipReader: 'src/drawio/zipReader.ts',
    settingsStrings: 'src/settingsStrings.ts',
    dataToDiagram: 'src/generators/dataToDiagram.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const { computeMinimalTextChange } = await import(join(outdir, 'minimalEdit.mjs'));
const { buildPdfDocument } = await import(join(outdir, 'pdfWriter.mjs'));
const { PlantUmlRenderer, CancelledError } = await import(join(outdir, 'renderer.mjs'));
const { convertMermaidToDrawioXml } = await import(join(outdir, 'mermaidToDrawio.mjs'));
const { convertPlantUmlToMermaid, convertMermaidToPlantUml } = await import(join(outdir, 'converters.mjs'));
const {
  extractFallbackCodeSymbols,
  inferTypeRelationsFromSource,
  generateClassDiagramFromSymbols,
  extractLocalImports,
  generateDependencyDiagram,
} = await import(join(outdir, 'codeToDiagram.mjs'));
const { renderMxfileToPreviewSvg, measureMxfileBounds, unionMxfileBounds } = await import(join(outdir, 'mxfileToSvg.mjs'));
const {
  extractDiagramDocumentLinks,
  computeDiagramRenameRanges,
  extractHexColors,
  formatHexColor,
  computeDiagramQuickFixes,
  computeC4SignatureHelp,
  validateDiagramSyntaxStatic,
} = await import(join(outdir, 'advancedFeatures.mjs'));
const { collectPlantUmlCompletions } = await import(join(outdir, 'lang.mjs'));
const { extractDrawioPages } = await import(join(outdir, 'codeLinksXml.mjs'));
const { buildStoreZipBuffer, extractWebappZipEntries } = await import(join(outdir, 'zipReader.mjs'));
const { SETTINGS_DRAWER_STRINGS } = await import(join(outdir, 'settingsStrings.mjs'));
const { convertSqlToDiagram, convertJsonToDiagram } = await import(join(outdir, 'dataToDiagram.mjs'));

/** Builds a valid 2x2 RGBA PNG with Sub filter on row 0 and Paeth filter on row 1, including semi-transparent alpha. */
function makeSampleRgbaPng() {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const tBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    let c = 0xffffffff;
    for (const b of Buffer.concat([tBuf, data])) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // RGBA
  const rawScanlines = Buffer.from([
    1, 255, 0, 0, 255, 0, 255, 0, 0, // filter=Sub
    4, 0, 0, 255, 128, 10, 20, 30, 0, // filter=Paeth, alpha=128 -> triggers /SMask
  ]);
  const idat = deflateSync(rawScanlines);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('D5: Settings Drawer and package.nls EN/ZH dictionaries maintain 100% key parity', () => {
  const enDrawerKeys = Object.keys(SETTINGS_DRAWER_STRINGS.en).sort();
  const zhDrawerKeys = Object.keys(SETTINGS_DRAWER_STRINGS['zh-cn']).sort();
  assert.deepEqual(zhDrawerKeys, enDrawerKeys);

  const pkgEn = JSON.parse(readFileSync('package.nls.json', 'utf8'));
  const pkgZh = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8'));
  assert.deepEqual(Object.keys(pkgZh).sort(), Object.keys(pkgEn).sort());
});

test('D6: computeMinimalTextChange isolates minimal interior delta and preserves UTF-16 surrogate pairs', () => {
  assert.equal(computeMinimalTextChange('<mxfile>same</mxfile>', '<mxfile>same</mxfile>'), undefined);

  const d1 = computeMinimalTextChange('<mxfile><mxCell value="A"/></mxfile>', '<mxfile><mxCell value="Beta"/></mxfile>');
  assert.deepEqual(d1, { startOffset: 23, endOffset: 24, replacement: 'Beta' });

  // Surrogate pair emoji 🚀 (\uD83D\uDE80) shares high surrogate \uD83D with 🔥 (\uD83D\uDD25)
  const oldEmoji = 'prefix 🚀 suffix';
  const newEmoji = 'prefix 🔥 suffix';
  const dEmoji = computeMinimalTextChange(oldEmoji, newEmoji);
  assert.ok(dEmoji);
  const reconstructed = oldEmoji.slice(0, dEmoji.startOffset) + dEmoji.replacement + oldEmoji.slice(dEmoji.endOffset);
  assert.equal(reconstructed, newEmoji);
  assert.equal(dEmoji.replacement, '🔥');
});

test('D1: PlantUmlRenderer cancelPrevious=false lets concurrent Markdown blocks all resolve without self-cancellation', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    await new Promise((r) => setTimeout(r, 25));
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg"><text>${String(url).slice(-8)}</text></svg>`, { status: 200 });
  };
  const renderer = new PlantUmlRenderer('md-concurrency-test');
  const baseOpts = { mode: 'server', server: 'https://plantuml.example/plantuml', jar: '', java: 'java', dot: '', noCache: true };
  try {
    // 1. Default cancelPrevious=true cancels superseded in-flight render
    const pCanceled = renderer.render('@startuml\nA -> B\n@enduml', baseOpts);
    const pLatest = renderer.render('@startuml\nC -> D\n@enduml', baseOpts);
    await assert.rejects(pCanceled, (err) => err instanceof CancelledError);
    assert.match(await pLatest, /<svg/);

    // 2. cancelPrevious=false (used by Markdown multi-block renderer) resolves all concurrent blocks
    const results = await Promise.all([
      renderer.render('@startuml\nBlock1 -> B\n@enduml', { ...baseOpts, cancelPrevious: false }),
      renderer.render('@startuml\nBlock2 -> B\n@enduml', { ...baseOpts, cancelPrevious: false }),
      renderer.render('@startuml\nBlock3 -> B\n@enduml', { ...baseOpts, cancelPrevious: false }),
    ]);
    assert.equal(results.length, 3);
    results.forEach((svg) => assert.match(svg, /^<svg/));
  } finally {
    globalThis.fetch = origFetch;
    renderer.dispose();
  }
});

test('F3: buildPdfDocument generates valid multi-page PDF 1.4 with RGBA PNG SMask and JPEG streams', () => {
  const png = makeSampleRgbaPng();
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = buildPdfDocument([
    { bytes: png, format: 'png', scale: 2 },
    { bytes: fakeJpeg, format: 'jpeg', widthPx: 400, heightPx: 300, scale: 2 },
  ]);
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
  assert.match(text, /\/SMask \d+ 0 R/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /xref\n0 \d+/);
  assert.ok(text.endsWith('%%EOF\n'));

  const multiPageMx = '<mxfile><diagram id="d1" name="Overview"><mxGraphModel/></diagram><diagram id="d2" name="Detail"><mxGraphModel/></diagram></mxfile>';
  const pages = extractDrawioPages(multiPageMx);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].name, 'Overview');
  assert.equal(pages[1].name, 'Detail');
  assert.match(pages[1].diagramXml, /name="Detail"/);
});

test('F6: Mermaid classDiagram, erDiagram, mindmap -> Draw.io XML and PlantUML <-> Mermaid converters', () => {
  const clsXml = convertMermaidToDrawioXml('classDiagram\n  class Order {\n    +String id\n    +pay()\n  }\n  class Payment\n  Order --> Payment : uses');
  assert.match(clsXml, /swimlane/);
  assert.match(clsXml, /Order/);
  assert.match(clsXml, /Payment/);

  const erXml = convertMermaidToDrawioXml('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    int id PK\n  }');
  assert.match(erXml, /ERzeroToMany/);
  assert.match(erXml, /CUSTOMER/);

  const mmXml = convertMermaidToDrawioXml('mindmap\n  root((DrawGraph))\n    Draw.io\n    Mermaid\n    PlantUML');
  assert.match(mmXml, /DrawGraph/);
  assert.match(mmXml, /PlantUML/);

  const pumlSeq = '@startuml\nactor Alice\nparticipant Bob\nAlice -> Bob : ping\nBob --> Alice : pong\n@enduml';
  const mmdSeq = convertPlantUmlToMermaid(pumlSeq);
  assert.match(mmdSeq, /^sequenceDiagram/m);
  assert.match(mmdSeq, /Alice->>Bob: ping/);
  assert.match(mmdSeq, /Bob-->>Alice: pong/);

  const roundTripPuml = convertMermaidToPlantUml(mmdSeq);
  assert.match(roundTripPuml, /@startuml/);
  assert.match(roundTripPuml, /Alice -> Bob : ping/);
  assert.match(roundTripPuml, /@enduml/);
});

test('F4: Code-to-Diagram extracts classes, heritage relations, and module dependency graphs', () => {
  const tsCode = `
    export interface Renderer {
      render(src: string): Promise<string>;
    }
    export class PlantUmlService implements Renderer {
      private cacheSize: number = 32;
      render(src: string): Promise<string> { return Promise.resolve(src); }
    }
  `;
  const syms = extractFallbackCodeSymbols(tsCode);
  assert.equal(syms.length, 2);
  const rels = inferTypeRelationsFromSource(tsCode, new Set(['Renderer', 'PlantUmlService']));
  syms.find((s) => s.name === 'PlantUmlService').relations = rels.get('PlantUmlService');

  const mmdClass = generateClassDiagramFromSymbols(syms, 'mermaid');
  assert.match(mmdClass, /classDiagram/);
  assert.match(mmdClass, /PlantUmlService \.\.\|> Renderer/);

  const drawioClass = generateClassDiagramFromSymbols(syms, 'drawio');
  assert.match(drawioClass, /<mxfile>/);
  assert.match(drawioClass, /PlantUmlService/);

  const imports = extractLocalImports(`import { a } from './util';\nexport * from '../shared/protocol';\nimport fs from 'node:fs';`);
  assert.deepEqual(imports, ['./util', '../shared/protocol']);

  const depPuml = generateDependencyDiagram([{ from: 'src/extension.ts', to: 'src/util.ts' }], 'plantuml');
  assert.match(depPuml, /\[src\/extension\.ts\] --> \[src\/util\.ts\]/);
});

test('F1: renderMxfileToPreviewSvg renders both plain and deflate-compressed mxfile XML offline', () => {
  const model =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="n1" value="Gateway" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="50" as="geometry"/></mxCell>' +
    '<mxCell id="n2" value="Database" style="ellipse;" vertex="1" parent="1"><mxGeometry x="240" y="40" width="120" height="50" as="geometry"/></mxCell>' +
    '<mxCell id="e1" value="SQL" edge="1" parent="1" source="n1" target="n2"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';
  const compressed = deflateRawSync(Buffer.from(encodeURIComponent(model), 'utf8')).toString('base64');
  const svg = renderMxfileToPreviewSvg(`<mxfile><diagram id="p1" name="Page-1">${compressed}</diagram></mxfile>`);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /Gateway/);
  assert.match(svg, /Database/);
  assert.match(svg, /SQL/);
});

test('F2, F9, F10, F11: Document links, block-scoped rename, color picker, quick fixes, and C4 signature help', () => {
  const puml = [
    '@startuml',
    '!include common/theme.iuml',
    '!include <C4/C4_Container>',
    'skinparam backgroundColor #1e293b',
    'participant OrderGateway',
    'OrderGateway -> Billing : src/billing.ts:42',
    '@enduml',
    '@startuml',
    'participant OrderGateway',
    '@enduml',
  ].join('\n');

  const links = extractDiagramDocumentLinks(puml, 'plantuml');
  assert.ok(links.some((l) => l.kind === 'include' && l.target === 'common/theme.iuml'));
  assert.ok(links.some((l) => l.kind === 'file' && l.target === 'src/billing.ts:42'));

  // Rename in block 1 must NOT touch OrderGateway in block 2!
  const rename = computeDiagramRenameRanges(puml, 'plantuml', 4, 15);
  assert.ok(rename);
  assert.equal(rename.oldName, 'OrderGateway');
  assert.equal(rename.ranges.length, 2);
  assert.ok(rename.ranges.every((r) => r.line <= 6));

  // Hex color extraction & formatting
  const colors = extractHexColors(puml);
  assert.equal(colors.length, 1);
  assert.equal(formatHexColor(colors[0].r, colors[0].g, colors[0].b, colors[0].a), '#1e293b');

  // Quick Fixes
  const fixesPuml = computeDiagramQuickFixes('@startuml\nAlice -> Bob : hi', 'plantuml');
  assert.ok(fixesPuml.some((f) => f.title.includes('@enduml')));
  const fixesMmd = computeDiagramQuickFixes('flowchart TD\n  A -> B', 'mermaid', 1);
  assert.ok(fixesMmd.some((f) => f.newText.includes('-->')));

  // Stdlib completions + C4 signature help
  const stdlibItems = collectPlantUmlCompletions(puml, '!include <C4/');
  assert.ok(stdlibItems.some((c) => c.label === '<C4/C4_Container>'));
  const sig = computeC4SignatureHelp('Container(api, "API Gateway", ');
  assert.ok(sig);
  assert.equal(sig.macro.name, 'Container');
  assert.equal(sig.activeParameter, 2);

  // Unclosed string literal at cursor must still track active parameter accurately
  const sigUnclosed = computeC4SignatureHelp('Container(orderSvc, "Order');
  assert.ok(sigUnclosed);
  assert.equal(sigUnclosed.activeParameter, 1);
});

test('F7: Pure ZIP reader normalizes nested webapp/index.html and strips path-traversal entries', () => {
  const zip = buildStoreZipBuffer([
    { name: '../../../etc/passwd', content: 'blocked' },
    { name: 'drawio-24.0/src/main/webapp/index.html', content: '<html>Draw.io Offline</html>' },
    { name: 'drawio-24.0/src/main/webapp/js/app.min.js', content: 'console.log("ok");' },
    { name: 'META-INF/MANIFEST.MF', content: 'Manifest-Version: 1.0' },
  ]);
  const entries = extractWebappZipEntries(zip);
  assert.deepEqual(
    entries.map((e) => e.relativePath).sort(),
    ['index.html', 'js/app.min.js'],
  );
});

test('CR-2: buildPdfDocument decodes PlantUML-style 4-bit PLTE indexed PNG + tRNS, grayscale PNG, and SOF0 JPEG', () => {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const pngChunk = (type, data) => {
    const tBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    let c = 0xffffffff;
    for (const b of Buffer.concat([tBuf, data])) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
  };

  // 4-bit indexed PNG (width=2, height=1, colorType=3) with 2 palette entries + tRNS alpha
  const ihdrIdx = Buffer.alloc(13);
  ihdrIdx.writeUInt32BE(2, 0);
  ihdrIdx.writeUInt32BE(1, 4);
  ihdrIdx[8] = 4; // 4-bit
  ihdrIdx[9] = 3; // PLTE indexed
  const plte = Buffer.from([255, 128, 0, 0, 64, 255]);
  const trns = Buffer.from([120, 255]);
  const idatIdx = deflateSync(Buffer.from([0, 0x01])); // filter=0, pixel0=idx0, pixel1=idx1
  const indexedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdrIdx),
    pngChunk('PLTE', plte),
    pngChunk('tRNS', trns),
    pngChunk('IDAT', idatIdx),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  // 8-bit grayscale PNG (colorType=0)
  const ihdrGray = Buffer.alloc(13);
  ihdrGray.writeUInt32BE(2, 0);
  ihdrGray.writeUInt32BE(1, 4);
  ihdrGray[8] = 8;
  ihdrGray[9] = 0;
  const grayPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdrGray),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 64, 192]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  // Minimal JPEG with SOF0 (width=320, height=200) and omitted widthPx/heightPx
  const sof0Jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xc8, 0x01, 0x40, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);

  const pdf = buildPdfDocument([
    { bytes: indexedPng, format: 'png', scale: 1 },
    { bytes: grayPng, format: 'png', scale: 1 },
    { bytes: sof0Jpeg, format: 'jpeg', scale: 1 },
  ]);
  const text = pdf.toString('latin1');
  assert.match(text, /\/Count 3/);
  assert.match(text, /\/Width 320 \/Height 200/);
  assert.match(text, /\/SMask \d+ 0 R/);
});

test('CR-3 & FP-1: Unified mxfile bounding box, multi-page selection, cylinders, and waypoint polylines', () => {
  const multi =
    '<mxfile>' +
    '<diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="db" value="OrdersDB" style="shape=cylinder3;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="100" y="120" width="120" height="60" as="geometry"/></mxCell>' +
    '</root></mxGraphModel></diagram>' +
    '<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="n1" value="SecondPageNode" vertex="1" parent="1"><mxGeometry x="20" y="10" width="120" height="50" as="geometry"/></mxCell>' +
    '<mxCell id="e1" value="bent" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="20" y="80" as="sourcePoint"/><mxPoint x="200" y="80" as="targetPoint"/><Array as="points"><mxPoint x="110" y="140"/></Array></mxGeometry></mxCell>' +
    '</root></mxGraphModel></diagram>' +
    '</mxfile>';

  const b0 = measureMxfileBounds(multi, 0);
  const b1 = measureMxfileBounds(multi, 1);
  const unified = unionMxfileBounds(b0, b1);
  assert.deepEqual(unified, { minX: 20, minY: 10, maxX: 220, maxY: 180 });

  const svgPage0 = renderMxfileToPreviewSvg(multi, 0, unified);
  const svgPage1 = renderMxfileToPreviewSvg(multi, 1, unified);
  assert.match(svgPage0, /OrdersDB/);
  assert.match(svgPage0, /<path d="M 100 /); // cylinder3 path
  assert.match(svgPage1, /SecondPageNode/);
  assert.match(svgPage1, /<polyline points="20,80 110,140 200,80"/);
  // Both share the exact same viewBox thanks to unified bounds!
  assert.equal(svgPage0.match(/viewBox="[^"]+"/)?.[0], svgPage1.match(/viewBox="[^"]+"/)?.[0]);
});

test('FP-4: SQL DDL & JSON -> Diagram generators and zero-false-positive Static Syntax Linter', () => {
  const sql = `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL
    );
    CREATE TABLE orders (
      id INT PRIMARY KEY,
      user_id INT REFERENCES users(id),
      total DECIMAL(10, 2)
    );
  `;
  const mmdEr = convertSqlToDiagram(sql, 'mermaid');
  assert.match(mmdEr, /^erDiagram/m);
  assert.match(mmdEr, /users \|\|--o\{ orders : "user_id"/);
  assert.match(convertSqlToDiagram(sql, 'drawio'), /ERzeroToMany/);

  const jsonSrc = JSON.stringify({ service: 'Gateway', routes: ['/auth', '/pay'] });
  assert.match(convertJsonToDiagram(jsonSrc, 'mermaid'), /^mindmap/m);
  assert.match(convertJsonToDiagram(jsonSrc, 'plantuml'), /^@startjson/m);

  // Static linter must produce ZERO false positives on bundled example files
  const exMmd = readFileSync('examples/flowchart.mmd', 'utf8');
  const exPuml = readFileSync('examples/sequence.puml', 'utf8');
  assert.equal(validateDiagramSyntaxStatic(exMmd, 'mermaid').length, 0);
  assert.equal(validateDiagramSyntaxStatic(exPuml, 'plantuml').length, 0);

  // Static linter catches unclosed @startuml, unclosed subgraph, and single -> arrow
  assert.equal(validateDiagramSyntaxStatic('@startuml\nA -> B', 'plantuml').length, 1);
  assert.equal(validateDiagramSyntaxStatic('flowchart TD\n  subgraph S1\n    A --> B', 'mermaid').length, 1);
  assert.equal(validateDiagramSyntaxStatic('flowchart TD\n  A -> B', 'mermaid').length, 1);
});
