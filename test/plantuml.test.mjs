// Unit tests for the PlantUML encoder / block splitter (run with `npm test`).
// Set DRAWGRAPH_ONLINE=1 to also render through the public PlantUML server.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-test-'));
await esbuild.build({
  entryPoints: { encoder: 'src/plantuml/encoder.ts', renderer: 'src/plantuml/renderer.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { encodePlantUml, splitDiagrams, pickBlock } = await import(join(outdir, 'encoder.mjs'));
const { PlantUmlRenderer } = await import(join(outdir, 'renderer.mjs'));

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
function decode(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 4) {
    const [c1, c2, c3, c4] = [...text.slice(i, i + 4)].map((c) => ALPHABET.indexOf(c));
    bytes.push((c1 << 2) | (c2 >> 4), ((c2 & 0xf) << 4) | (c3 >> 2), ((c3 & 0x3) << 6) | c4);
  }
  return inflateRawSync(Buffer.from(bytes), { finishFlush: 2 /* Z_SYNC_FLUSH: ignore padding bytes */ }).toString('utf8');
}

test('encodePlantUml round-trips, including non-ASCII text', () => {
  for (const src of ['@startuml\nBob -> Alice : hello\n@enduml', '@startuml\n用户 -> 系统 : 你好 ✓\n@enduml', 'a', 'ab', 'abc']) {
    const encoded = encodePlantUml(src);
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

test('splitDiagrams wraps marker-less text and closes unterminated blocks', () => {
  assert.equal(splitDiagrams('A -> B')[0].source, '@startuml\nA -> B\n@enduml');
  assert.equal(splitDiagrams('@startgantt foo\n[Task] lasts 2 days')[0].source, '@startgantt foo\n[Task] lasts 2 days\n@endgantt');
  assert.deepEqual(splitDiagrams('   \n'), []);
});

test('local mode without a jar reports a helpful error', async () => {
  const r = new PlantUmlRenderer();
  await assert.rejects(r.render('@startuml\nA->B\n@enduml', { mode: 'local', server: '', jar: '', java: 'java', dot: '' }), /plantuml\.jar/);
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
