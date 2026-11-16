// Unit tests for outline symbol parsing, Markdown fences, newpage counting, and error parsing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-lang-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: {
    symbols: 'src/language/symbols.ts',
    encoder: 'src/plantuml/encoder.ts',
    renderer: 'src/plantuml/renderer.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const { extractMermaidErrorLine, findMarkdownDiagramFences, parseMermaidOutline, parsePlantUmlOutline } = await import(
  join(outdir, 'symbols.mjs')
);
const { countPages } = await import(join(outdir, 'encoder.mjs'));
const { extractPlantUmlError } = await import(join(outdir, 'renderer.mjs'));

test('parseMermaidOutline builds nested symbols for subgraphs and sequence participants', () => {
  const flow = [
    'flowchart TD',
    '  subgraph Backend["Core Backend"]',
    '    A --> B',
    '  end',
  ].join('\n');
  const flowSymbols = parseMermaidOutline(flow);
  assert.equal(flowSymbols.length, 1);
  assert.equal(flowSymbols[0].name, 'flowchart');
  assert.equal(flowSymbols[0].children.length, 1);
  assert.equal(flowSymbols[0].children[0].name, 'Core Backend');
  assert.deepEqual([flowSymbols[0].children[0].startLine, flowSymbols[0].children[0].endLine], [1, 3]);

  const seq = 'sequenceDiagram\n  actor User\n  participant API as Backend API\n  User->>API: ping';
  const seqSymbols = parseMermaidOutline(seq);
  assert.deepEqual(
    seqSymbols[0].children.map((c) => c.name),
    ['User', 'Backend API'],
  );
});

test('parsePlantUmlOutline groups blocks and nested packages/classes', () => {
  const puml = [
    '@startuml AuthFlow',
    'actor User',
    'participant Gateway',
    '@enduml',
    '',
    '@startuml',
    'title Domain Model',
    'package "Core" {',
    '  interface Repo',
    '  class OrderService',
    '}',
    '@enduml',
  ].join('\n');
  const roots = parsePlantUmlOutline(puml);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].name, 'AuthFlow');
  assert.deepEqual(
    roots[0].children.map((c) => c.name),
    ['User', 'Gateway'],
  );
  assert.equal(roots[1].name, 'Domain Model');
  assert.equal(roots[1].children[0].name, 'Core');
  assert.deepEqual(
    roots[1].children[0].children.map((c) => c.name),
    ['Repo', 'OrderService'],
  );
});

test('findMarkdownDiagramFences detects mermaid and plantuml/puml blocks', () => {
  const md = [
    '# Doc',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '~~~puml',
    'Alice -> Bob : hi',
    '~~~',
  ].join('\n');
  const fences = findMarkdownDiagramFences(md);
  assert.equal(fences.length, 2);
  assert.equal(fences[0].kind, 'mermaid');
  assert.deepEqual([fences[0].startLine, fences[0].endLine], [1, 4]);
  assert.equal(fences[1].kind, 'plantuml');
  assert.equal(fences[1].content, 'Alice -> Bob : hi');
});

test('countPages counts newpage splits and ignores leading/commented ones', () => {
  assert.equal(countPages('@startuml\nA -> B\n@enduml'), 1);
  assert.equal(countPages('@startuml\nA -> B\nnewpage Second\nB -> C\nnewpage Third\nC -> A\n@enduml'), 3);
  assert.equal(countPages("@startuml\n/' newpage '/\nA -> B\n@enduml"), 1);
});

test('extractMermaidErrorLine and extractPlantUmlError find 1-based line numbers', () => {
  assert.equal(extractMermaidErrorLine('Parse error on line 4:\nExpecting ...'), 4);
  assert.equal(extractMermaidErrorLine('Unknown error', 7), 7);

  const errSvg =
    '<svg><g><text>[From string (line 3) ]</text><text>A -&gt; -&gt; B</text><text>Syntax Error? (Assumed diagram type: sequence)</text></g></svg>';
  const parsed = extractPlantUmlError(errSvg);
  assert.ok(parsed);
  assert.equal(parsed.line, 3);
  assert.match(parsed.message, /Syntax Error/i);
  assert.equal(extractPlantUmlError('<svg><text>All good</text></svg>'), undefined);
});
