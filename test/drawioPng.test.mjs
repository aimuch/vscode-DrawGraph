// Unit tests for the .drawio.png binary chunk parser (run with `npm test`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-png-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: { drawioPng: 'src/drawio/drawioPng.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { extractDiagramFromPng, isPngDiagramPath, isValidPng, pngBytesToDataUri } = await import(join(outdir, 'drawioPng.mjs'));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MXFILE = '<mxfile host="embed.diagrams.net"><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="Node 你好"/></root></mxGraphModel></diagram></mxfile>';

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // CRC is not verified by metadata readers
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function buildPng(extraChunks = []) {
  const ihdr = makeChunk('IHDR', Buffer.alloc(13));
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([PNG_SIG, ihdr, ...extraChunks, iend]);
}

test('recognises PNG paths and PNG header bytes', () => {
  assert.ok(isPngDiagramPath('/a/diagram.drawio.png'));
  assert.ok(isPngDiagramPath('/a/DIAGRAM.PNG'));
  assert.ok(!isPngDiagramPath('/a/diagram.drawio.svg'));
  assert.ok(isValidPng(buildPng()));
  assert.ok(!isValidPng(Buffer.from('not a png')));
});

test('extracts URL-encoded mxfile from PNG tEXt chunk (draw.io default format)', () => {
  const payload = Buffer.concat([Buffer.from('mxfile\0', 'latin1'), Buffer.from(encodeURIComponent(MXFILE), 'latin1')]);
  const png = buildPng([makeChunk('tEXt', payload)]);
  assert.equal(extractDiagramFromPng(png), MXFILE);
});

test('extracts zlib-compressed mxfile from PNG zTXt chunk', () => {
  const compressed = deflateSync(Buffer.from(MXFILE, 'utf8'));
  const payload = Buffer.concat([Buffer.from('mxfile\0\0', 'latin1'), compressed]);
  const png = buildPng([makeChunk('zTXt', payload)]);
  assert.equal(extractDiagramFromPng(png), MXFILE);
});

test('extracts UTF-8 mxfile from PNG iTXt chunk', () => {
  const payload = Buffer.concat([Buffer.from('mxfile\0\0\0\0\0', 'utf8'), Buffer.from(MXFILE, 'utf8')]);
  const png = buildPng([makeChunk('iTXt', payload)]);
  assert.equal(extractDiagramFromPng(png), MXFILE);
});

test('returns undefined for plain PNGs or truncated chunks', () => {
  assert.equal(extractDiagramFromPng(buildPng()), undefined);
  const otherText = makeChunk('tEXt', Buffer.from('Software\0ImageMagick', 'latin1'));
  assert.equal(extractDiagramFromPng(buildPng([otherText])), undefined);
  assert.equal(extractDiagramFromPng(PNG_SIG), undefined);
  assert.match(pngBytesToDataUri(Buffer.from([1, 2, 3])), /^data:image\/png;base64,/);
});
