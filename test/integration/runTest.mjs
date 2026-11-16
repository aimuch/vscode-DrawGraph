// Runs the integration suite inside a real VS Code with an isolated profile.
//   npm run test:integration
// Uses the locally installed VS Code when found (VSCODE_PATH overrides), otherwise downloads one.
import { runTests } from '@vscode/test-electron';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const sandbox = mkdtempSync(join(tmpdir(), 'drawgraph-it-'));
const workspace = join(sandbox, 'workspace');
cpSync(join(root, 'examples'), workspace, { recursive: true });

const candidates = [process.env.VSCODE_PATH, '/Applications/Visual Studio Code.app/Contents/MacOS/Code'].filter(Boolean);
const vscodeExecutablePath = candidates.find((p) => existsSync(p));

console.log(`workspace: ${workspace}`);
try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test/integration/suite.cjs'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      // Lets the suite send real key presses / clicks via the Chrome DevTools protocol.
      '--remote-debugging-port=9339',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${join(sandbox, 'user-data')}`,
      `--extensions-dir=${join(sandbox, 'extensions')}`,
    ],
    extensionTestsEnv: { DRAWGRAPH_IT_WORKSPACE: workspace },
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exitCode = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
