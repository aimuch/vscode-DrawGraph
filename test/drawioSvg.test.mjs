// Unit tests for the .drawio.svg helpers (run with `npm test`).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-test-'));
await esbuild.build({
  entryPoints: { drawioSvg: 'src/drawio/drawioSvg.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { extractDiagramFromSvg, isSvgDiagramPath, replaceEmbeddedDiagram, unescapeXml } = await import(join(outdir, 'drawioSvg.mjs'));

const MXFILE = '<mxfile host="x"><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="2" value="A &amp; &quot;B&quot; 你好"/></root></mxGraphModel></diagram></mxfile>';
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

test('extracts the diagram embedded by draw.io', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px" content="${escapeAttr(MXFILE)}"><rect/></svg>`;
  assert.equal(extractDiagramFromSvg(svg), MXFILE);
});

test('handles an XML prolog, single quotes and other attributes before content', () => {
  const svg = `<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg version='1.1' content='${escapeAttr(MXFILE)}' style="background:#fff">\n</svg>`;
  assert.equal(extractDiagramFromSvg(svg), MXFILE);
});

test('ignores SVGs without a draw.io diagram', () => {
  assert.equal(extractDiagramFromSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), undefined);
  assert.equal(extractDiagramFromSvg('<svg content="hello"></svg>'), undefined);
  // A content attribute on a child element must not be picked up.
  assert.equal(extractDiagramFromSvg(`<svg><g content="${escapeAttr(MXFILE)}"/></svg>`), undefined);
  assert.equal(extractDiagramFromSvg('not svg at all'), undefined);
});

test('unescapes named and numeric entities', () => {
  assert.equal(unescapeXml('&lt;a&gt; &amp;amp; &quot;&apos; &#10;&#x4F60;&#22909;'), '<a> &amp; "\' \n你好');
});

test('recognises SVG diagram paths', () => {
  assert.ok(isSvgDiagramPath('/a/b.drawio.svg'));
  assert.ok(isSvgDiagramPath('/a/B.DRAWIO.SVG'));
  assert.ok(!isSvgDiagramPath('/a/b.drawio'));
  assert.ok(!isSvgDiagramPath('/a/b.drawio.xml'));
});

test('replaceEmbeddedDiagram swaps the content attribute and round-trips', () => {
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;&lt;diagram&gt;COMPRESSED&lt;/diagram&gt;&lt;/mxfile&gt;" width="1"><g content="keep"/></svg>`;
  const xml = MXFILE + '\n  <!-- line 2 -->';
  const out = replaceEmbeddedDiagram(svg, xml);
  assert.equal(extractDiagramFromSvg(out), xml.trim());
  assert.ok(out.startsWith('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" content="'));
  assert.ok(out.endsWith('" width="1"><g content="keep"/></svg>'));
  assert.ok(!out.includes('COMPRESSED'));
});

test('replaceEmbeddedDiagram adds content when missing and survives $ patterns', () => {
  const out = replaceEmbeddedDiagram('<svg width="1"></svg>', '<mxfile>$& $1</mxfile>');
  assert.equal(extractDiagramFromSvg(out), '<mxfile>$& $1</mxfile>');
});
