import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-v06-test-'));

await esbuild.build({
  entryPoints: {
    d2Renderer: 'src/renderers/d2Renderer.ts',
    walkthroughCore: 'src/walkthrough/walkthroughCore.ts',
    prImpactCore: 'src/generators/prImpactCore.ts',
    architectureDriftCore: 'src/language/architectureDriftCore.ts',
    ciWorkflowGenerator: 'src/ci/ciWorkflowGenerator.ts',
    htmlExporter: 'src/export/htmlExporter.ts',
    symbols: 'src/language/symbols.ts',
    aiCore: 'src/ai/diagramAiCore.ts',
    settingsStrings: 'src/settingsStrings.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

process.on('exit', () => rmSync(outdir, { recursive: true, force: true }));

const { parseD2Graph, renderD2ToSvgOffline, validateD2SyntaxStatic } = await import(join(outdir, 'd2Renderer.mjs'));
const { extractWalkthroughSteps } = await import(join(outdir, 'walkthroughCore.mjs'));
const { computePrImpactGraph, renderPrImpactDiagram } = await import(join(outdir, 'prImpactCore.mjs'));
const { computeArchitectureDrift } = await import(join(outdir, 'architectureDriftCore.mjs'));
const { buildDrawGraphCiWorkflowYaml, buildDrawGraphCiScript } = await import(join(outdir, 'ciWorkflowGenerator.mjs'));
const { buildInteractiveHtmlBundle } = await import(join(outdir, 'htmlExporter.mjs'));
const { findMarkdownDiagramFences, parseD2Outline } = await import(join(outdir, 'symbols.mjs'));
const { buildAiDiagramPrompt, extractAndNormalizeAiDiagram, spliceDrawioPageXml } = await import(
  join(outdir, 'aiCore.mjs')
);
const { SETTINGS_DRAWER_STRINGS } = await import(join(outdir, 'settingsStrings.mjs'));

test('D2 parser, offline SVG renderer, static linter, and document outline', () => {
  const sample = [
    'direction: right',
    'client: Web App',
    'backend: Core Cluster {',
    '  api: API Gateway',
    '  db: Primary DB {',
    '    shape: cylinder',
    '  }',
    '  api -> db: SQL',
    '}',
    'client -> backend.api: HTTPS',
  ].join('\n');

  const g = parseD2Graph(sample);
  assert.equal(g.direction, 'right');
  assert.ok(g.nodes.has('client'));
  assert.ok(g.nodes.has('backend'));
  assert.ok(g.nodes.has('backend.api'));
  assert.ok(g.nodes.has('backend.db'));
  assert.equal(g.nodes.get('backend.db').shape, 'cylinder');
  assert.equal(g.edges.length, 2);

  const svg = renderD2ToSvgOffline(sample);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /Core Cluster/);
  assert.match(svg, /API Gateway/);
  assert.match(svg, /Primary DB/);

  assert.equal(validateD2SyntaxStatic(sample).length, 0);
  const badIssues = validateD2SyntaxStatic('backend: Cluster {\n  api: Gateway\n');
  assert.ok(badIssues.some((i) => /unclosed|\{/i.test(i.message)));

  const outline = parseD2Outline(sample);
  assert.equal(outline.length, 1);
  assert.ok(outline[0].children.some((c) => c.name === 'Core Cluster' && c.children.length === 2));
});

test('Markdown fence extractor recognizes ```d2 alongside Mermaid/PlantUML/DOT/WaveDrom', () => {
  const md = [
    '# System',
    '```d2',
    'a -> b: hello',
    '```',
    '```mermaid',
    'flowchart LR',
    '  X --> Y',
    '```',
  ].join('\n');
  const fences = findMarkdownDiagramFences(md);
  assert.equal(fences.length, 2);
  assert.equal(fences[0].kind, 'd2');
  assert.equal(fences[1].kind, 'mermaid');
});

test('Walkthrough step extractor parses Mermaid, PlantUML, DOT, and D2 steps and embeds them in Interactive HTML', () => {
  const mmd = [
    'flowchart LR',
    '  %% step 1: Ingress Gateway',
    '  Client --> Gateway',
    '  %% step 2: Order Persistence',
    '  Gateway --> OrderDB',
  ].join('\n');
  const steps = extractWalkthroughSteps(mmd);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].title, 'Ingress Gateway');
  assert.ok(steps[0].targets.includes('Client') && steps[0].targets.includes('Gateway'));
  assert.equal(steps[1].title, 'Order Persistence');

  const d2Steps = extractWalkthroughSteps('# step 1: Auth Check\nauth -> db: verify\n');
  assert.equal(d2Steps.length, 1);
  assert.equal(d2Steps[0].title, 'Auth Check');

  const html = buildInteractiveHtmlBundle({
    title: 'Walkthrough Demo',
    pages: [{ name: 'Page 1', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"></svg>', steps }],
  });
  assert.match(html, /Ingress Gateway/);
  assert.match(html, /stepHud/);
});

test('Git Diff / PR Architecture Impact Graph computes 1-hop downstream dependents and renders Mermaid/D2/Draw.io', () => {
  const graph = computePrImpactGraph(
    'main',
    [
      { relPath: 'src/core/auth.ts', status: 'M' },
      { relPath: 'src/core/token.ts', status: 'A' },
    ],
    [
      { from: 'src/api/loginController.ts', to: 'src/core/auth.ts' },
      { from: 'src/core/auth.ts', to: 'src/core/token.ts' },
    ],
  );
  assert.deepEqual(graph.impactedDependents, ['src/api/loginController.ts']);

  const mmd = renderPrImpactDiagram(graph, 'mermaid');
  assert.match(mmd, /flowchart LR/);
  assert.match(mmd, /loginController\.ts/);
  assert.match(mmd, /classDef modified/);

  const d2 = renderPrImpactDiagram(graph, 'd2');
  assert.match(d2, /direction: right/);
  assert.match(d2, /loginController\.ts/);

  const drawio = renderPrImpactDiagram(graph, 'drawio');
  assert.match(drawio, /<mxfile/);
});

test('Architecture Drift detector reports undocumented code modules and stale diagram file references', () => {
  const tokensByFile = new Map([
    ['docs/arch.mmd', new Set(['AuthService', 'src/deletedService.ts'])],
  ]);
  const report = computeArchitectureDrift(
    [
      { name: 'AuthService', relPath: 'src/authService.ts' },
      { name: 'BillingService', relPath: 'src/billingService.ts' },
    ],
    tokensByFile,
    new Set(['src/authService.ts', 'src/billingService.ts']),
  );
  assert.equal(report.coveredCount, 1);
  assert.equal(report.totalCodeItems, 2);
  assert.equal(report.undocumentedCodeItems.length, 1);
  assert.equal(report.undocumentedCodeItems[0].name, 'BillingService');
  assert.equal(report.staleDiagramRefs.length, 1);
  assert.equal(report.staleDiagramRefs[0].ref, 'src/deletedService.ts');
});

test('CI workflow scaffolder emits valid GitHub Actions YAML and zero-dependency validator script', () => {
  const yaml = buildDrawGraphCiWorkflowYaml();
  const script = buildDrawGraphCiScript();
  assert.match(yaml, /name: DrawGraph Diagram Check/);
  assert.match(yaml, /node \.github\/scripts\/drawgraph-ci-check\.mjs/);
  assert.match(script, /validateD2|unbalanced|mxGraphModel/i);
});

test('AI Diagram Core v0.6 supports D2 format, workspace style guide injection, and Draw.io single-page splicing', () => {
  const prompt = buildAiDiagramPrompt({
    mode: 'generate',
    format: 'd2',
    userPrompt: 'API Gateway to Redis',
    teamGuidelines: 'Always use cylinder shapes for caches.',
    lang: 'en',
  });
  assert.match(prompt, /TEAM_STYLE_GUIDE/);
  assert.match(prompt, /Always use cylinder shapes for caches\./);
  assert.match(prompt, /Target format: \*\*D2\*\*/);

  const extracted = extractAndNormalizeAiDiagram('```d2\ngateway -> redis\n```\nSummary.', 'd2', true);
  assert.match(extracted.code, /gateway -> redis/);

  const multiPage = [
    '<mxfile>',
    '  <diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Old1" vertex="1" parent="1"/></root></mxGraphModel></diagram>',
    '  <diagram id="p2" name="Detail"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="Old2" vertex="1" parent="1"/></root></mxGraphModel></diagram>',
    '</mxfile>',
  ].join('\n');
  const updatedPage2 =
    '<mxfile><diagram id="new-id" name="Renamed"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="Updated2" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>';
  const spliced = spliceDrawioPageXml(multiPage, 1, updatedPage2);
  assert.match(spliced, /Old1/);
  assert.match(spliced, /Updated2/);
  assert.match(spliced, /<diagram id="p2" name="Detail">/);
  assert.doesNotMatch(spliced, /Old2/);
});

test('EN/ZH localization parity for package.nls and SETTINGS_DRAWER_STRINGS in v0.6.0', () => {
  const enNls = JSON.parse(readFileSync('package.nls.json', 'utf8'));
  const zhNls = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8'));
  assert.deepEqual(Object.keys(enNls).sort(), Object.keys(zhNls).sort());

  assert.deepEqual(
    Object.keys(SETTINGS_DRAWER_STRINGS.en).sort(),
    Object.keys(SETTINGS_DRAWER_STRINGS['zh-cn']).sort(),
  );
});
