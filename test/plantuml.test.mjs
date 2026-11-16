// Unit tests for the PlantUML encoder / block splitter / local pipe worker (run with `npm test`).
// Set DRAWGRAPH_ONLINE=1 to also render through the public PlantUML server.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: { encoder: 'src/plantuml/encoder.ts', renderer: 'src/plantuml/renderer.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { encodePlantUml, encodePlantUmlAsync, splitDiagrams, pickBlock } = await import(join(outdir, 'encoder.mjs'));
const { PlantUmlRenderer, extractSvg } = await import(join(outdir, 'renderer.mjs'));

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
function decode(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 4) {
    const [c1, c2, c3, c4] = [...text.slice(i, i + 4)].map((c) => ALPHABET.indexOf(c));
    bytes.push((c1 << 2) | (c2 >> 4), ((c2 & 0xf) << 4) | (c3 >> 2), ((c3 & 0x3) << 6) | c4);
  }
  return inflateRawSync(Buffer.from(bytes), { finishFlush: 2 /* Z_SYNC_FLUSH: ignore padding bytes */ }).toString('utf8');
}

test('encodePlantUml and encodePlantUmlAsync round-trip, including non-ASCII text', async () => {
  for (const src of ['@startuml\nBob -> Alice : hello\n@enduml', '@startuml\n用户 -> 系统 : 你好 ✓\n@enduml', 'a', 'ab', 'abc']) {
    const encoded = encodePlantUml(src);
    const encodedAsync = await encodePlantUmlAsync(src);
    assert.equal(encodedAsync, encoded);
    assert.match(encoded, /^[0-9A-Za-z\-_]+$/);
    assert.equal(decode(encoded), src);
  }
});

test('splitDiagrams finds every @start/@end block with line numbers', () => {
  const text = "' header\n@startuml\nA -> B\n@enduml\n\n@startmindmap\n* root\n@endmindmap\n";
  const blocks = splitDiagrams(text);
  assert.equal(blocks.length, 2);
  assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [1, 3]);
  assert.deepEqual([blocks[1].startLine, blocks[1].endLine], [5, 7]);
  assert.equal(blocks[1].source, '@startmindmap\n* root\n@endmindmap');
  assert.equal(pickBlock(blocks, 0), blocks[0]);
  assert.equal(pickBlock(blocks, 2), blocks[0]);
  assert.equal(pickBlock(blocks, 4), blocks[0]);
  assert.equal(pickBlock(blocks, 6), blocks[1]);
  assert.equal(pickBlock(blocks, undefined), blocks[0]);
});

test('splitDiagrams ignores nested @startsub/@endsub and markers inside block comments', () => {
  const text = [
    "/'",
    '@startuml',
    'Ignored -> Block',
    '@enduml',
    "'/",
    '@startuml',
    'A -> B',
    '@startsub PART',
    'B -> C',
    '@endsub',
    'C -> D',
    '@enduml',
  ].join('\n');
  const blocks = splitDiagrams(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual([blocks[0].startLine, blocks[0].endLine], [5, 11]);
  assert.ok(blocks[0].source.includes('C -> D'));
});

test('splitDiagrams wraps marker-less text and closes unterminated blocks', () => {
  assert.equal(splitDiagrams('A -> B')[0].source, '@startuml\nA -> B\n@enduml');
  assert.equal(splitDiagrams('@startgantt foo\n[Task] lasts 2 days')[0].source, '@startgantt foo\n[Task] lasts 2 days\n@endgantt');
  assert.deepEqual(splitDiagrams('   \n'), []);
});

test('extractSvg keeps nested <svg> icons intact', () => {
  const raw = '<?xml version="1.0"?>\n<svg width="100" height="50"><g><svg id="sprite" width="16" height="16"><path d="M0 0"/></svg></g><text>ok</text></svg>\ntrailing';
  const extracted = extractSvg(raw);
  assert.equal(
    extracted,
    '<svg width="100" height="50"><g><svg id="sprite" width="16" height="16"><path d="M0 0"/></svg></g><text>ok</text></svg>',
  );
});

test('local mode without a jar reports a helpful error', async () => {
  const r = new PlantUmlRenderer();
  await assert.rejects(r.render('@startuml\nA->B\n@enduml', { mode: 'local', server: '', jar: '', java: 'java', dot: '' }), /plantuml\.jar/);
});

test('local pipe worker reuses a warm process, caches results, and recovers after exit', async () => {
  const mockJava = join(outdir, 'mock-java');
  const mockJar = join(outdir, 'fake-plantuml.jar');
  writeFileSync(mockJar, '');
  writeFileSync(
    mockJava,
    `#!${process.execPath}
const args = process.argv.slice(2);
const delimIdx = args.indexOf('-pipedelimitor');
const delim = delimIdx >= 0 ? args[delimIdx + 1] : '';
let buf = '';
let count = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const end = buf.indexOf('@enduml');
    if (end < 0) break;
    const block = buf.slice(0, end + 7);
    buf = buf.slice(end + 7).replace(/^\\r?\\n/, '');
    count++;
    if (block.includes('CRASH_NOW')) {
      process.stderr.write('simulated crash\\n');
      process.exit(2);
    }
    const label = block.replace(/[^\\w-]/g, '_');
    process.stdout.write('<?xml version="1.0"?><svg data-pid="' + process.pid + '" data-seq="' + count + '"><svg id="nested"/><text>' + label + '</text></svg>\\n' + delim + '\\n');
  }
});
`,
  );
  chmodSync(mockJava, 0o755);

  const r = new PlantUmlRenderer();
  try {
    const opts = { mode: 'local', server: '', jar: mockJar, java: mockJava, dot: '' };
    const svg1 = await r.render('@startuml\nA -> B\n@enduml', opts);
    const svg2 = await r.render('@startuml\nB -> C\n@enduml', opts);
    const pid1 = /data-pid="(\d+)"/.exec(svg1)?.[1];
    const pid2 = /data-pid="(\d+)"/.exec(svg2)?.[1];
    assert.ok(pid1, 'captured worker PID');
    assert.equal(pid1, pid2, 'reused the same warm local process across renders');
    assert.match(svg1, /data-seq="1"/);
    assert.match(svg2, /data-seq="2"/);
    assert.match(svg2, /<svg id="nested"\/>/, 'nested SVG preserved');
    assert.equal(r.snapshot().worker.state, 'warm_idle');
    assert.equal(r.snapshot().isSettled, true);

    // Repeat render of the first diagram comes from the LRU cache (still seq="1").
    const cached = await r.render('@startuml\nA -> B\n@enduml', opts);
    assert.equal(cached, svg1);

    // bypass cache forces a fresh render on the same warm worker (seq="3").
    const fresh = await r.render('@startuml\nA -> B\n@enduml', { ...opts, noCache: true });
    assert.match(fresh, new RegExp(`data-pid="${pid1}"`));
    assert.match(fresh, /data-seq="3"/);

    // Worker crash rejects that render and automatically spawns a new process next time.
    await assert.rejects(r.render('@startuml\nCRASH_NOW\n@enduml', opts), /simulated crash/);
    const recovered = await r.render('@startuml\nD -> E\n@enduml', opts);
    const pid3 = /data-pid="(\d+)"/.exec(recovered)?.[1];
    assert.ok(pid3 && pid3 !== pid1, 'spawned a fresh worker after crash');
  } finally {
    r.dispose();
  }
});

test('server rendering returns SVG', { skip: !process.env.DRAWGRAPH_ONLINE }, async () => {
  const r = new PlantUmlRenderer();
  const opts = { mode: 'server', server: 'https://www.plantuml.com/plantuml', jar: '', java: 'java', dot: '' };
  const svg = await r.render('@startuml\nBob -> Alice : hello 你好\n@enduml', opts);
  assert.match(svg, /^<svg/);
  assert.match(svg, /Alice/);
  assert.match(svg, /你好/);
  // Syntax errors still come back as an SVG describing the error.
  const err = await r.render('@startuml\nthis is -> -> not valid ((\n@enduml', opts);
  assert.match(err, /^<svg/);
  // Reasonably large diagrams still fit in the URL.
  const big = '@startuml\n' + Array.from({ length: 300 }, (_, i) => `N${i} -> N${i + 1} : step ${i}`).join('\n') + '\n@enduml';
  assert.match(await r.render(big, opts), /N299/);
  // Huge, incompressible ones fail with a hint towards local rendering.
  const huge = '@startuml\n' + Array.from({ length: 400 }, (_, i) => `N${i} -> N${i + 1} : ${Math.random()}`).join('\n') + '\n@enduml';
  await assert.rejects(r.render(huge, opts), /plantuml\.jar/);
});
