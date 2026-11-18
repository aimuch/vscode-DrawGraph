import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-v04-test-'));

await esbuild.build({
  entryPoints: {
    wavedrom: 'src/renderers/wavedromRenderer.ts',
    dot: 'src/renderers/dotRenderer.ts',
    symbols: 'src/language/symbols.ts',
    drawioToText: 'src/converters/drawioToText.ts',
    specToDiagram: 'src/generators/specToDiagram.ts',
    infraToDiagram: 'src/generators/infraToDiagram.ts',
    htmlExporter: 'src/export/htmlExporter.ts',
    codeLinkCore: 'src/language/codeLinkMaintenanceCore.ts',
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

const { renderWaveDromToSvg, validateWaveDromSyntaxStatic } = await import(join(outdir, 'wavedrom.mjs'));
const { renderDotToSvgOffline, validateDotSyntaxStatic } = await import(join(outdir, 'dot.mjs'));
const { findMarkdownDiagramFences, parseDotOutline, parseWaveDromOutline } = await import(join(outdir, 'symbols.mjs'));
const { convertDrawioToMermaid, convertDrawioToPlantUml } = await import(join(outdir, 'drawioToText.mjs'));
const { convertOpenApiToDiagram, convertProtoToDiagram, convertPrismaToDiagram } = await import(
  join(outdir, 'specToDiagram.mjs')
);
const { convertDockerComposeToDiagram, convertGithubWorkflowToDiagram } = await import(
  join(outdir, 'infraToDiagram.mjs')
);
const { buildInteractiveHtmlBundle } = await import(join(outdir, 'htmlExporter.mjs'));
const {
  collectLocalFileLinksInTextDiagram,
  collectLocalFileLinksInDrawioXml,
  rewriteRenamedPathsInText,
} = await import(join(outdir, 'codeLinkCore.mjs'));

test('WaveDrom renders relaxed timing waveforms (clocks, buses, groups, edges) and BitField registers offline', () => {
  const relaxedTiming = `
    // SPI Transfer WaveJSON with JS-style unquoted keys & single quotes
    {
      signal: [
        ['SPI',
          { name: 'SCLK', wave: 'P.....', node: '.a..b.' },
          { name: 'MOSI', wave: 'x3.4.x', data: ['CMD', 'DATA'] },
        ],
        {},
        { name: 'IRQ', wave: '0..1|0' },
      ],
      edge: ['a~>b 12ns'],
      head: { text: 'SPI Read', tick: 0 },
    }
  `;
  const timingSvg = renderWaveDromToSvg(relaxedTiming);
  assert.match(timingSvg, /^<svg\b/);
  assert.match(timingSvg, /SPI: SCLK/);
  assert.match(timingSvg, /CMD/);
  assert.match(timingSvg, /DATA/);
  assert.match(timingSvg, /12ns/);

  const regJson = JSON.stringify({
    reg: [
      { bits: 1, name: 'EN', attr: 'RW', type: 4 },
      { bits: 3, name: 'MODE', attr: 'RW', type: 5 },
      { bits: 4 },
      { bits: 8, name: 'TX_DATA', attr: 'WO', type: 2 },
    ],
    config: { bits: 16, lanes: 2 },
  });
  const regSvg = renderWaveDromToSvg(regJson);
  assert.match(regSvg, /^<svg\b/);
  assert.match(regSvg, /TX_DATA/);
  assert.match(regSvg, /EN/);
  assert.match(regSvg, /WO/);

  assert.equal(validateWaveDromSyntaxStatic(relaxedTiming).length, 0);
  assert.equal(validateWaveDromSyntaxStatic('{ "foo": 1 }').length, 1);
});

test('Graphviz DOT offline engine renders clusters, cylinders, records, cycles, outlines, and Markdown fences', () => {
  const dotSrc = `
    digraph System {
      rankdir=LR;
      label="Core Topology";
      subgraph cluster_api {
        label="API Layer";
        Gateway [shape=diamond];
        Auth [shape=record, label="{<f0> AuthSvc | <f1> JWT}"];
        Gateway -> Auth [label="verify"];
      }
      DB [label="Postgres", shape=cylinder, style=filled, fillcolor="#dbeafe"];
      Auth -> DB -> Gateway [style=dashed];
    }
  `;
  const svg = renderDotToSvgOffline(dotSrc);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /API Layer/);
  assert.match(svg, /AuthSvc/);
  assert.match(svg, /Postgres/);
  assert.equal(validateDotSyntaxStatic(dotSrc).length, 0);
  assert.equal(validateDotSyntaxStatic('digraph G { A -> B ').length, 1);

  const dotOutline = parseDotOutline(dotSrc);
  assert.equal(dotOutline.length, 1);
  assert.equal(dotOutline[0].name, 'System');
  assert.ok(dotOutline[0].children.some((c) => c.name === 'API Layer'));

  const wdOutline = parseWaveDromOutline('{ signal: [{ name: "clk", wave: "p.." }] }');
  assert.equal(wdOutline.length, 1);
  assert.equal(wdOutline[0].children[0].name, 'clk');

  const mdFences = findMarkdownDiagramFences('```dot\ndigraph G { A -> B }\n```\n\n```wavedrom\n{"signal":[]}\n```');
  assert.deepEqual(mdFences.map((f) => f.kind), ['dot', 'wavedrom']);
});

test('Draw.io reverse converter extracts plain & compressed mxfile into Mermaid and PlantUML', () => {
  const innerModel =
    '<mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="grp" value="Backend" style="swimlane;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="300" height="200" as="geometry"/></mxCell>' +
    '<UserObject id="svc" label="OrderService" link="#OrderService"><mxCell style="rounded=1;" vertex="1" parent="grp"><mxGeometry x="20" y="40" width="120" height="50" as="geometry"/></mxCell></UserObject>' +
    '<mxCell id="db" value="OrdersDB" style="shape=cylinder3;" vertex="1" parent="1"><mxGeometry x="420" y="60" width="100" height="70" as="geometry"/></mxCell>' +
    '<mxCell id="e1" value="" style="dashed=1;" edge="1" parent="1" source="svc" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '<mxCell id="e1lbl" value="SQL" style="edgeLabel;" vertex="1" parent="e1"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '</root></mxGraphModel>';

  const compressedB64 = deflateRawSync(Buffer.from(encodeURIComponent(innerModel), 'utf8')).toString('base64');
  const mxfile = `<mxfile><diagram id="p1" name="Page-1">${compressedB64}</diagram></mxfile>`;

  const mmd = convertDrawioToMermaid(mxfile);
  assert.match(mmd, /^flowchart LR/);
  assert.match(mmd, /subgraph grp\["Backend"\]/);
  assert.match(mmd, /db\[\("OrdersDB"\)\]/);
  assert.match(mmd, /svc -\.->\|"SQL"\| db/);
  assert.match(mmd, /click svc "#OrderService"/);

  const puml = convertDrawioToPlantUml(mxfile);
  assert.match(puml, /@startuml/);
  assert.match(puml, /database "OrdersDB" as db/);
  assert.match(puml, /svc \.\.> db : SQL/);
});

test('OpenAPI, Protobuf, Prisma, Docker Compose, and GitHub Actions generators produce valid diagrams', () => {
  const openApiYaml = `
openapi: 3.0.3
info:
  title: Checkout API
paths:
  /orders:
    post:
      tags: [Orders]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/OrderInput'
components:
  schemas:
    OrderInput:
      type: object
`;
  assert.match(convertOpenApiToDiagram(openApiYaml, 'mermaid'), /POST \/orders/);
  assert.match(convertOpenApiToDiagram(openApiYaml, 'plantuml'), /SCH_OrderInput/);
  assert.match(convertOpenApiToDiagram(openApiYaml, 'drawio'), /<mxfile\b/);

  const protoSrc = `
    syntax = "proto3";
    service BillingService {
      rpc Charge (ChargeRequest) returns (ChargeReply);
    }
    message ChargeRequest {
      string order_id = 1;
      Money amount = 2;
    }
    message Money { int64 cents = 1; }
    enum Currency { USD = 0; CNY = 1; }
  `;
  assert.match(convertProtoToDiagram(protoSrc, 'mermaid'), /class BillingService/);
  assert.match(convertProtoToDiagram(protoSrc, 'mermaid'), /ChargeRequest --> Money/);
  assert.match(convertProtoToDiagram(protoSrc, 'plantuml'), /enum Currency/);

  const prismaSrc = `
    model User {
      id    Int    @id
      email String
      posts Post[]
    }
    model Post {
      id       Int  @id
      authorId Int
      author   User @relation(fields: [authorId], references: [id])
    }
  `;
  const prismaMmd = convertPrismaToDiagram(prismaSrc, 'mermaid');
  assert.match(prismaMmd, /erDiagram/);
  assert.match(prismaMmd, /User \|\|--o\{ Post : "author"/);

  const composeYaml = `
services:
  gateway:
    image: nginx:alpine
    ports:
      - "8080:80"
    depends_on:
      - api
    networks: [frontend]
  api:
    build: ./api
    depends_on: [postgres]
    networks: [frontend]
  postgres:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
`;
  const composeMmd = convertDockerComposeToDiagram(composeYaml, 'mermaid');
  assert.match(composeMmd, /SVC_postgres\[\("postgres \(postgres:16\)"\)\]/);
  assert.match(composeMmd, /SVC_gateway --> SVC_api/);
  assert.match(convertDockerComposeToDiagram(composeYaml, 'drawio'), /<mxfile\b/);

  const workflowYaml = `
name: Release Pipeline
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  package:
    name: Build VSIX
    needs: [lint]
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run package
`;
  const wfMmd = convertGithubWorkflowToDiagram(workflowYaml, 'mermaid');
  assert.match(wfMmd, /TRIGGER\(\["on: push, pull_request"\]\)/);
  assert.match(wfMmd, /JOB_lint --> JOB_package/);
});

test('Standalone Interactive HTML bundle sanitizes scripts and embeds multi-page SVGs, and path rewriter updates renames accurately', () => {
  const html = buildInteractiveHtmlBundle({
    title: 'System Review',
    pages: [
      { name: 'Overview', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><script>alert(1)</script><g class="node"><text x="10" y="20">Gateway</text></g></svg>' },
      { name: 'Storage', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><g class="node"><text x="10" y="20">Shard-1</text></g></svg>' },
    ],
    lang: 'zh-cn',
  });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.doesNotMatch(html, /alert\(1\)/);
  assert.match(html, /System Review/);
  assert.match(html, /聚光灯/);

  const mmdText = 'flowchart TD\n  click A "src/oldService.ts:24"\n  B["./oldService.ts#L9"]\n';
  const links = collectLocalFileLinksInTextDiagram(mmdText, 'mermaid', '/ws/docs/arch.mmd', '/ws');
  assert.equal(links.length, 2);

  const drawioLinks = collectLocalFileLinksInDrawioXml(
    '<mxfile><diagram id="1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="src/oldService.ts:10" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>',
    '/ws/docs/arch.drawio',
    '/ws',
  );
  assert.equal(drawioLinks.length, 1);

  const rewritten = rewriteRenamedPathsInText(
    mmdText,
    '/ws/src/arch.mmd',
    '/ws',
    [{ oldFsPath: '/ws/src/oldService.ts', newFsPath: '/ws/src/core/newService.ts' }],
  );
  assert.equal(rewritten.replacements, 2);
  assert.match(rewritten.updated, /"src\/core\/newService\.ts:24"/);
  assert.match(rewritten.updated, /"\.\/core\/newService\.ts#L9"/);
});
