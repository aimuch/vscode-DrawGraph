// Unit tests for StateMachine and CoalescedTaskMachine.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as esbuild from 'esbuild';

const outdir = mkdtempSync(join(tmpdir(), 'drawgraph-fsm-test-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: { stateMachine: 'src/stateMachine.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});
const { CoalescedTaskMachine, StateMachine } = await import(join(outdir, 'stateMachine.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('StateMachine enforces valid transitions, tracks settled state, and bounds history', () => {
  const seen = [];
  const fsm = new StateMachine({
    id: 'test:handshake',
    initial: 'booting',
    settledStates: ['ready', 'failed'],
    maxHistory: 4,
    transitions: {
      booting: { CONFIGURED: 'configured', FAIL: 'failed' },
      configured: { LOADED: 'ready', FAIL: 'failed' },
      ready: { RELOAD: 'configured' },
      failed: { RETRY: 'booting' },
    },
    onTransition: (rec) => seen.push(`${rec.from}->${rec.to}`),
  });

  assert.equal(fsm.state, 'booting');
  assert.equal(fsm.isSettled, false);
  assert.deepEqual(fsm.allowedEvents(), ['CONFIGURED', 'FAIL']);
  assert.equal(fsm.send('LOADED'), false, 'rejects invalid transition from booting');
  assert.equal(fsm.state, 'booting');

  assert.ok(fsm.send('CONFIGURED'));
  assert.ok(fsm.send('LOADED'));
  assert.equal(fsm.state, 'ready');
  assert.equal(fsm.isSettled, true);

  assert.ok(fsm.send('RELOAD'));
  assert.ok(fsm.send('FAIL', 'timeout'));
  assert.ok(fsm.send('RETRY'));
  const snap = fsm.snapshot();
  assert.equal(snap.state, 'booting');
  assert.equal(snap.transitions.length, 4, 'ring buffer capped at maxHistory');
  assert.equal(seen.length, 5);
});

test('CoalescedTaskMachine coalesces rapid schedules, discards superseded passes, and flushes on demand', async () => {
  let version = 0;
  let producedCount = 0;
  const committed = [];

  const sync = new CoalescedTaskMachine({
    id: 'test:svg-sync',
    debounceMs: 40,
    produce: async () => {
      const snap = ++producedCount && version;
      await sleep(30);
      return `v${snap}`;
    },
    commit: async (val) => {
      committed.push(val);
      return true;
    },
  });

  // Burst of 3 schedules within debounce window -> 1 produce + 1 commit.
  version = 1;
  const p1 = sync.schedule();
  version = 2;
  const p2 = sync.schedule();
  version = 3;
  const p3 = sync.schedule();
  assert.equal(sync.state, 'debouncing');
  assert.deepEqual(await Promise.all([p1, p2, p3]), [true, true, true]);
  assert.equal(producedCount, 1);
  assert.deepEqual(committed, ['v3']);
  assert.equal(sync.isSettled, true);

  // Schedule while produce() is already running -> superseded intermediate result skipped, latest committed.
  version = 4;
  const f1 = sync.flush();
  assert.equal(sync.state, 'running');
  await sleep(10);
  version = 5;
  const f2 = sync.schedule();
  assert.equal(sync.state, 'running_dirty');
  assert.deepEqual(await Promise.all([f1, f2]), [true, true]);
  assert.deepEqual(committed, ['v3', 'v5'], 'v4 intermediate pass was discarded without committing');
  assert.equal(sync.state, 'idle');

  // Cancel invalidates pending debounce immediately.
  version = 6;
  const cancelled = sync.schedule();
  sync.cancel('external edit');
  assert.equal(await cancelled, false);
  assert.equal(sync.state, 'idle');

  sync.dispose();
  assert.equal(sync.state, 'disposed');
});
