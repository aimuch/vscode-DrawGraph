// Build script: bundles the extension host code and copies vendored webview assets.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const vendor = [
  ['node_modules/mermaid/dist/mermaid.min.js', 'media/vendor/mermaid.min.js'],
];

function copyVendor() {
  for (const [from, to] of vendor) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

copyVendor();
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
