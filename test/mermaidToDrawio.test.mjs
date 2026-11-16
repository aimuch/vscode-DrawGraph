// Unit tests for Mermaid -> draw.io (<mxfile>) conversion.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-m2d-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: { mermaidToDrawio: 'src/drawio/mermaidToDrawio.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { convertMermaidToDrawioXml } = await import(join(outdir, 'mermaidToDrawio.mjs'));

test('converts flowchart with subgraphs, shapes and labeled edges into mxfile XML', () => {
  const mmd = [
    '%% comment',
    'flowchart LR',
    '  subgraph Editor["Code Editor"]',
    '    A[Write .mmd] --> B{Valid?}',
    '  end',
    '  B -- Yes --> C[(Database)]',
    '  B -.->|No| D((Retry))',
  ].join('\n');
  const xml = convertMermaidToDrawioXml(mmd);
  assert.match(xml, /^<mxfile>/);
  assert.match(xml, /<mxGraphModel\b/);
  assert.match(xml, /value="Code Editor"[^>]*swimlane/);
  assert.match(xml, /value="Write \.mmd"/);
  assert.match(xml, /value="Valid\?"[^>]*rhombus/);
  assert.match(xml, /value="Database"[^>]*cylinder3/);
  assert.match(xml, /value="Retry"[^>]*ellipse/);
  assert.match(xml, /value="Yes"[^>]*edge="1"/);
  assert.match(xml, /value="No"[^>]*dashed=1;/);
});

test('converts sequenceDiagram actors, participants and messages into lifelines and arrows', () => {
  const seq = [
    'sequenceDiagram',
    '  actor User',
    '  participant API as Backend API',
    '  User->>API: Request',
    '  API-->>User: Response',
  ].join('\n');
  const xml = convertMermaidToDrawioXml(seq);
  assert.match(xml, /umlLifeline/);
  assert.match(xml, /participant=umlActor/);
  assert.match(xml, /value="Backend API"/);
  assert.match(xml, /value="Request"/);
  assert.match(xml, /value="Response"[^>]*dashed=1;/);
});
