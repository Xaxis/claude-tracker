import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home of our own, with a stand-in for the owner's tmp-sweep, a survey that
// recommends it and a cache that only grows, and nothing real to delete.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tracker-cleanup-')));
const HOME = path.join(TMP, 'home'), DATA = path.join(TMP, 'data'), SHARED = path.join(TMP, 'tmp');
const BIN = path.join(HOME, '.claude', 'claude-core', 'bin');
for (const d of [BIN, DATA, SHARED]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { HOME, CLAUDE_TRACKER_DIR: DATA, CLAUDE_TRACKER_TMP: SHARED, TMPDIR: SHARED, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const leak = path.join(SHARED, 'leaked-run-1');
const cache = path.join(SHARED, 'node-compile-cache');
fs.writeFileSync(path.join(BIN, 'tmp-sweep'), `#!/bin/sh
if [ "$1" = "--yes" ]; then rm -rf "${leak}"; echo "deleted ${leak}"; else echo "would delete ${leak} (idle 4 days)"; fi
`, { mode: 0o755 });

const { storageView } = await import('../src/storage.js');
const { previewCleanup, runCleanup, cleanupState, onCleanupChange, resetCleanups } = await import('../src/cleanup.js');
const { useLinks, ask, onBoxControl } = await import('../src/fleet.js');

function survey() {
  fs.mkdirSync(leak, { recursive: true });
  fs.writeFileSync(path.join(leak, 'out.bin'), Buffer.alloc(1024));
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'c.bin'), 'x');
  fs.writeFileSync(path.join(DATA, 'storage.json'), JSON.stringify({
    at: Date.now(), version: 1, roots: [], tmp: SHARED,
    disks: [{ mount: TMP, size: 1e12, used: 5e11, avail: 5e11, counted: 1e11 }],
    owners: [
      { key: 'project:alpha', kind: 'project', name: 'alpha', bytes: 2e9, left: 2e9,
        items: [{ kind: 'scratchpad', path: path.join(SHARED, 'claude-1000', 'x', 'y'), bytes: 2e9, status: 'ended', left: true }] },
      { key: 'caches:Shared caches', kind: 'caches', name: 'Shared caches', bytes: 6 * 2 ** 30, left: 0,
        items: [{ kind: 'cache', path: cache, bytes: 6 * 2 ** 30 }] },
    ],
  }));
}

const until = async (fn, ms = 20_000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

test('a cleanup shows its own dry run first, runs only by the id the survey gave it, and says what it freed', async () => {
  survey();
  const cmds = storageView().commands;
  const sweep = cmds.find((c) => c.cmd.endsWith('tmp-sweep'));
  const node = cmds.find((c) => c.path === cache);
  assert.ok(sweep?.id && node?.id, 'both are offered, each with an id');
  assert.match(sweep.id, /^[0-9a-f]{12}$/);
  assert.equal(storageView().commands.find((c) => c.cmd.endsWith('tmp-sweep')).id, sweep.id, 'the same cleanup keeps its id');

  const p = await previewCleanup(sweep.id);
  assert.match(p.dryRun, /would delete .*leaked-run-1/, 'the dry run is the tool\'s own');
  assert.ok(fs.existsSync(leak), 'a dry run deletes nothing');

  let heard = 0;
  onCleanupChange(() => heard++);
  assert.deepEqual(runCleanup(sweep.id), { id: sweep.id, started: true });
  assert.throws(() => runCleanup(sweep.id), /running already/);
  await until(() => cleanupState().jobs.find((j) => j.id === sweep.id)?.state === 'done');
  const job = cleanupState().jobs.find((j) => j.id === sweep.id);
  assert.ok(!fs.existsSync(leak), 'run, it deletes');
  assert.match(job.output, /deleted .*leaked-run-1/);
  assert.ok(Number.isFinite(job.freed) && job.freed >= 0, 'what it freed is read off the disk');
  assert.ok(heard >= 2, 'dashboards hear when it starts and when it ends');
  await until(() => cleanupState().jobs.find((j) => j.id === sweep.id)?.remeasured, 120_000);
  assert.ok(heard >= 3, 'and when the disks have been measured again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'storage.json'), 'utf8')).owners.some((o) => o.key === 'project:alpha'), false,
    'the survey after it is a fresh one');

  survey();
  const r = await previewCleanup(node.id);
  assert.equal(r.dryRun, null, 'a folder to delete has no dry run: what it is says it');
  assert.match(r.what, /Node's compile cache/);
  runCleanup(node.id);
  await until(() => cleanupState().jobs.find((j) => j.id === node.id)?.state === 'done');
  assert.ok(!fs.existsSync(cache), 'the cache is gone');
  await until(() => cleanupState().jobs.find((j) => j.id === node.id)?.remeasured, 120_000);
});

test('another machine\'s dashboard sees the dry run and runs a cleanup here, over the sync connection', async () => {
  resetCleanups();
  survey();
  const cmds = storageView().commands;
  const sweep = cmds.find((c) => c.cmd.endsWith('tmp-sweep'));
  const node = cmds.find((c) => c.path === cache);
  // The two ends of one connection: the laptop's link to this box, and this box's link to the laptop.
  let nudged = 0;
  const toBox = { peer: { id: 'box' } };
  const toLaptop = { peer: { id: 'laptop', name: 'the laptop' }, nudgePanel: async () => { nudged++; } };
  toBox.send = (m) => setImmediate(() => onBoxControl(toLaptop, JSON.parse(JSON.stringify(m))));
  toLaptop.send = (m) => setImmediate(() => onBoxControl(toBox, JSON.parse(JSON.stringify(m))));
  useLinks(() => [toBox]);

  const p = await ask('box', { k: 'cleanup', cleanup: sweep.id, step: 'preview' }, 30_000);
  assert.match(p.dryRun, /would delete .*leaked-run-1/, 'the dry run comes back to the dashboard that asked');
  assert.ok(fs.existsSync(leak));

  assert.deepEqual(await ask('box', { k: 'cleanup', cleanup: node.id, step: 'run' }), { id: node.id, started: true });
  await until(() => cleanupState().jobs.find((j) => j.id === node.id)?.state === 'done');
  assert.ok(!fs.existsSync(cache), 'it ran on the machine asked');
  assert.ok(nudged >= 2, 'and that machine sent its panel back at once');

  await assert.rejects(ask('box', { k: 'cleanup', cleanup: '0123456789ab', step: 'preview' }), /not recommended/);
  await assert.rejects(ask('elsewhere', { k: 'cleanup', cleanup: node.id, step: 'run' }), /not connected/);
  await until(() => cleanupState().jobs.find((j) => j.id === node.id)?.remeasured, 120_000);
  useLinks(() => []);
});

test('nothing runs that the survey does not recommend', async () => {
  survey();
  await assert.rejects(previewCleanup('rm -rf /'), /not recommended/);
  assert.throws(() => runCleanup('0123456789ab'), /not recommended/);
  fs.rmSync(path.join(BIN, 'tmp-sweep'));
  assert.ok(!storageView().commands.some((c) => c.cmd.endsWith('tmp-sweep')), 'a tool this machine lacks is not offered');
});
