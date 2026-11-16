import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { brotliCompressSync, deflateRawSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-eco-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: {
    encoder: 'src/plantuml/encoder.ts',
    renderer: 'src/plantuml/renderer.ts',
    lang: 'src/language/completionsAndFormat.ts',
    codeLinksXml: 'src/drawio/codeLinksXml.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const { encodePlantUml, decodePlantUml, extractPlantUmlSourceFromSvg } = await import(join(outdir, 'encoder.mjs'));
const { PlantUmlRenderer } = await import(join(outdir, 'renderer.mjs'));
const {
  collectMermaidCompletions,
  collectPlantUmlCompletions,
  formatMermaidSource,
  formatPlantUmlSource,
} = await import(join(outdir, 'lang.mjs'));
const { extractCodeLinksFromDrawioXml, buildCodeSymbolMergeXml } = await import(join(outdir, 'codeLinksXml.mjs'));

test('decodePlantUml and extractPlantUmlSourceFromSvg round-trip PlantUML SVG metadata', () => {
  const original = '@startuml\nactor 用户 as User\nUser -> API : 请求订单\n@enduml';
  const encoded = encodePlantUml(original);
  assert.equal(decodePlantUml(encoded), original);
  assert.equal(decodePlantUml(`~1${encoded}`), original);

  // PlantUML ArobaseStringCompressor strips @startuml/@enduml inside <!--SRC=[...]-->
  const strippedBody = 'Alice -> Bob : hello';
  const bodyEncoded = encodePlantUml(strippedBody);
  const svgWithSrc = `<svg xmlns="http://www.w3.org/2000/svg"><g/><!--SRC=[${bodyEncoded}]--></svg>`;
  const extracted = extractPlantUmlSourceFromSvg(svgWithSrc);
  assert.equal(extracted, '@startuml\nAlice -> Bob : hello\n@enduml\n');

  // PlantUML v1.2020+ uses Brotli compression inside <!--SRC=[...]-->
  const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const toPlantUml64 = (buf) => {
    let out = '';
    for (let i = 0; i < buf.length; i += 3) {
      const b1 = buf[i];
      const b2 = i + 1 < buf.length ? buf[i + 1] : 0;
      const b3 = i + 2 < buf.length ? buf[i + 2] : 0;
      out += ALPHA[b1 >> 2] + ALPHA[((b1 & 3) << 4) | (b2 >> 4)] + ALPHA[((b2 & 15) << 2) | (b3 >> 6)] + ALPHA[b3 & 63];
    }
    return out;
  };
  for (const sample of ['Alice -> Bob : short', 'participant Gateway\nGateway -> DB : SELECT * FROM orders\n']) {
    const brotliEncoded = toPlantUml64(brotliCompressSync(Buffer.from(sample, 'utf8')));
    const brotliSvg = `<svg xmlns="http://www.w3.org/2000/svg"><g><!--SRC=[${brotliEncoded}]--></g></svg>`;
    assert.equal(extractPlantUmlSourceFromSvg(brotliSvg), `@startuml\n${sample.trim()}\n@enduml\n`);
  }
});

test('PlantUmlRenderer falls back to HTTP POST on 414 URI Too Long and large payloads', async () => {
  const requests = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? String(init.body) : '';
    requests.push({ method, url: String(url), body });
    if (method === 'GET') {
      return new Response('URI Too Long', { status: 414, statusText: 'URI Too Long' });
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text>${body.includes('OrderService') ? 'POST_OK' : 'MISS'}</text></svg>`;
    return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
  };

  const renderer = new PlantUmlRenderer('test-post');
  try {
    // 1. 414 URI Too Long triggers POST fallback
    const svg = await renderer.render('@startuml\nClient -> OrderService : create\n@enduml', {
      mode: 'server',
      server: 'https://plantuml.example/plantuml',
      jar: '',
      java: 'java',
      dot: '',
    });
    assert.match(svg, /POST_OK/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].url, 'https://plantuml.example/plantuml/svg');
    assert.match(requests[1].body, /OrderService/);

    // 2. Huge diagrams (> 3500 encoded chars) go straight to POST without wasting a GET round-trip
    requests.length = 0;
    const hugeLines = Array.from({ length: 450 }, (_, i) => `Node_${i} -> Node_${i + 1} : step_${i}_${Math.sin(i).toFixed(6)}`).join('\n');
    const hugeSrc = `@startuml\nOrderService -> Node_0 : start\n${hugeLines}\n@enduml`;
    const svg2 = await renderer.render(hugeSrc, {
      mode: 'server',
      server: 'https://plantuml.example/plantuml',
      jar: '',
      java: 'java',
      dot: '',
    });
    assert.match(svg2, /POST_OK/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
  } finally {
    globalThis.fetch = origFetch;
    renderer.dispose();
  }
});

test('Mermaid and PlantUML completions suggest themes, directives, skinparams, and declared IDs', () => {
  const puml = '@startuml\nparticipant OrderGateway as gw\nactor Customer\n\n@enduml';
  const themeItems = collectPlantUmlCompletions(puml, '!theme cer');
  assert.ok(themeItems.some((c) => c.label === 'cerulean' && c.kind === 'theme'));

  const skinItems = collectPlantUmlCompletions(puml, 'skinparam line');
  assert.ok(skinItems.some((c) => c.label === 'linetype ortho'));

  const idItems = collectPlantUmlCompletions(puml, 'gw');
  assert.ok(idItems.some((c) => c.label === 'gw' && c.kind === 'identifier'));
  assert.ok(idItems.some((c) => c.label === 'Customer' && c.kind === 'identifier'));

  const mmd = 'flowchart LR\n  AuthGateway[Auth] --> BillingService[(DB)]\n';
  const mmdItems = collectMermaidCompletions(mmd, '  Auth');
  assert.ok(mmdItems.some((c) => c.label === 'AuthGateway' && c.kind === 'identifier'));
  assert.ok(mmdItems.some((c) => c.label === 'BillingService' && c.kind === 'identifier'));
});

test('Mermaid and PlantUML formatters indent nested blocks while preserving mindmaps and frontmatter', () => {
  const unformattedMmd = [
    '---',
    'title: Checkout',
    '---',
    'sequenceDiagram',
    'participant User',
    'alt Valid token',
    'User->>API: POST /pay',
    'else Expired',
    'API-->>User: 401',
    'end',
  ].join('\n');
  const formattedMmd = formatMermaidSource(unformattedMmd, '  ');
  assert.equal(
    formattedMmd,
    [
      '---',
      'title: Checkout',
      '---',
      'sequenceDiagram',
      '  participant User',
      '  alt Valid token',
      '    User->>API: POST /pay',
      '  else Expired',
      '    API-->>User: 401',
      '  end',
    ].join('\n'),
  );

  // Mindmap hierarchy must not be flattened.
  const mindmap = 'mindmap\n  Root\n    Child A\n      Grandchild';
  assert.equal(formatMermaidSource(mindmap, '    '), mindmap);

  const unformattedPuml = [
    '@startuml',
    'class Order {',
    '+id: UUID',
    '}',
    'if (valid?) then (yes)',
    ':charge;',
    'else (no)',
    ':reject;',
    'endif',
    '@enduml',
  ].join('\n');
  assert.equal(
    formatPlantUmlSource(unformattedPuml, '  '),
    [
      '@startuml',
      'class Order {',
      '  +id: UUID',
      '}',
      'if (valid?) then (yes)',
      '  :charge;',
      'else (no)',
      '  :reject;',
      'endif',
      '@enduml',
    ].join('\n'),
  );
});

test('extractCodeLinksFromDrawioXml parses uncompressed & compressed diagrams and builds merge cells', () => {
  const modelXml =
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<UserObject label="#PreviewManager" link="#PreviewManager" id="u1"><mxCell vertex="1" parent="1"/></UserObject>' +
    '<mxCell id="c2" value="Handler in src/extension.ts:80" vertex="1" parent="1"/>' +
    '</root></mxGraphModel>';
  const compressedB64 = deflateRawSync(Buffer.from(encodeURIComponent(modelXml), 'utf8')).toString('base64');
  const compressedMxfile = `<mxfile><diagram id="p1" name="Page-1">${compressedB64}</diagram></mxfile>`;

  const links = extractCodeLinksFromDrawioXml(compressedMxfile);
  assert.ok(links.some((l) => l.kind === 'symbol' && l.target === 'PreviewManager'));
  assert.ok(links.some((l) => l.kind === 'file' && l.target === 'src/extension.ts:80'));

  const mergeXml = buildCodeSymbolMergeXml('#DrawioEditorProvider', '#DrawioEditorProvider', 42);
  assert.match(mergeXml, /label="#DrawioEditorProvider"/);
  assert.match(mergeXml, /link="#DrawioEditorProvider"/);
});
