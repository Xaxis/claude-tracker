import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

// A machine of our own making: /proc, the cgroup tree, heavy's pool and the owner's
// priorities all under a scratch folder, so what each process is can be said exactly.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tracker-machine-'));
const PROC = path.join(TMP, 'proc'), CG = path.join(TMP, 'cg'), BOX = path.join(TMP, 'box');
Object.assign(process.env, {
  CLAUDE_TRACKER_DIR: path.join(TMP, 'data'), CLAUDE_TRACKER_PROC: PROC, CLAUDE_TRACKER_CGROUP: CG,
  CLAUDE_TRACKER_DRM: path.join(TMP, 'drm'), BOX_HEAVY_DIR: BOX, BOX_GPU_DIR: path.join(TMP, 'gpu'),
  BOX_GPU_STATE: path.join(TMP, 'gpu-state'), BOX_PRIORITY_FILE: path.join(TMP, 'priority.json'), NO_COLOR: '1',
});
fs.mkdirSync(process.env.CLAUDE_TRACKER_DIR, { recursive: true });

const machine = await import('../src/machine.js');
const { storageView } = await import('../src/storage.js');

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const USER = '/user.slice/user-1000.slice/user@1000.service';
const repo = (name) => { const d = path.join(TMP, 'repos', name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };

/** One process in the fake /proc. `ticks` is its CPU time so far, in 1/100 s. */
function proc(pid, { comm, ppid = 1, ticks = 0, rss = 1000, start = 5000 + pid, cg, env = {}, argv = [comm], cwd = null }) {
  const d = path.join(PROC, String(pid));
  fs.mkdirSync(d, { recursive: true });
  const f = ['S', ppid, 0, 0, 0, 0, 0, 0, 0, 0, 0, ticks, 0, 0, 0, 20, 0, 1, 0, start, 0, rss];
  fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) ${f.join(' ')}`);
  fs.writeFileSync(path.join(d, 'cgroup'), `0::${cg}\n`);
  fs.writeFileSync(path.join(d, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0'));
  fs.writeFileSync(path.join(d, 'cmdline'), argv.join('\0'));
  if (cwd) { try { fs.unlinkSync(path.join(d, 'cwd')); } catch { /* new */ } fs.symlinkSync(cwd, path.join(d, 'cwd')); }
}
function machineFiles(busyTicks, totalTicks) {
  fs.mkdirSync(path.join(PROC, 'self'), { recursive: true });
  fs.writeFileSync(path.join(PROC, 'self', 'stat'), '1 (self) S 0');
  const idle = totalTicks - busyTicks;
  fs.writeFileSync(path.join(PROC, 'stat'), `cpu  ${busyTicks} 0 0 ${idle} 0 0 0 0 0 0\n`);
  fs.writeFileSync(path.join(PROC, 'loadavg'), '3.0 2.0 1.0 7/900 1234\n');
  fs.writeFileSync(path.join(PROC, 'meminfo'), 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
}
function scopeUse(scope, usec, memBytes) {
  const d = path.join(CG, scope);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'cpu.stat'), `usage_usec ${usec}\n`);
  fs.writeFileSync(path.join(d, 'memory.current'), String(memBytes));
  fs.writeFileSync(path.join(d, 'memory.stat'), `active_file ${2 ** 20}\ninactive_file ${2 ** 20}\n`);
}

test('the sampler says whose each process is: sessions, jobs, what was left running, and the machine itself', () => {
  const alpha = repo('alpha');
  const jobScope = `${USER}/box.slice/box-beta.slice/heavy-beta-300-1794000000000000000.scope`;
  const orphanScope = `${USER}/app.slice/heavy-gamma-400-1794000000000000000.scope`;
  const world = (k) => {
    machineFiles(1000 * k, 2400 * k);
    // A running session and a test it runs.
    proc(100, { comm: 'claude', cg: `${USER}/app.slice/run-r1.scope`, ticks: 10 * k, cwd: alpha });
    proc(101, { comm: 'MainThread', ppid: 100, cg: `${USER}/app.slice/run-r1.scope`, ticks: 100 * k, argv: ['node', '/x/node_modules/.bin/vitest', 'run'] });
    // Started by a session that has ended, still running.
    proc(200, { comm: 'uvicorn', cg: `${USER}/app.slice/run-r2.scope`, env: { CLAUDE_CODE_SESSION_ID: 'ended-session', PWD: alpha } });
    // A heavy job and its holder; and a job whose heavy is gone.
    proc(300, { comm: 'python3', ppid: 100, cg: `${USER}/app.slice/run-r1.scope`, argv: ['python3', '/x/bin/heavy', 'npm', 'test'] });
    proc(301, { comm: 'chrome-headless', ppid: 300, cg: jobScope, ticks: 50 * k });
    scopeUse(jobScope, 2e6 * k, 3 * 2 ** 30);
    proc(401, { comm: 'next-server', cg: orphanScope });
    scopeUse(orphanScope, 0, 2 ** 28);
    // A tracker's terminal dashboard under tmux, a shell beside it, and systemd above them.
    proc(601, { comm: 'systemd', cg: `${USER}/init.scope` });
    proc(501, { comm: 'tmux: server', ppid: 601, cg: `${USER}/app.slice/tmux-spawn-1.scope` });
    proc(500, { comm: 'MainThread', ppid: 501, cg: `${USER}/app.slice/tmux-spawn-1.scope`, argv: ['node', '/home/x/.local/bin/claude-tracker'] });
    proc(600, { comm: 'bash', ppid: 501, cg: `${USER}/app.slice/tmux-spawn-1.scope` });
    // A Claude process the tracker has no session for.
    proc(700, { comm: 'claude', cg: `${USER}/app.slice/run-r3.scope`, argv: ['claude', 'setup-token'], cwd: alpha });
    // A job waiting for a slot, started as a release: its ticket's first line is the project.
    proc(800, { comm: 'python3', ppid: 100, cg: `${USER}/app.slice/run-r1.scope`, start: 777 });
  };
  fs.mkdirSync(path.join(BOX, 'slot.0'), { recursive: true });
  fs.writeFileSync(path.join(BOX, 'slot.0', 'info.json'), JSON.stringify({ pid: 300, project: 'beta', cmd: 'npm test', since: Math.floor(Date.now() / 1000) - 60 }));
  const ticket = `${(Date.now() - 120e3) * 1e6}-800-777`;
  for (const d of ['queue', 'why', 'next']) fs.mkdirSync(path.join(BOX, d), { recursive: true });
  fs.writeFileSync(path.join(BOX, 'config.json'), JSON.stringify({ unset_ranks: { quiet: 'low' } }));
  fs.writeFileSync(path.join(BOX, 'queue', ticket), 'beta\npriority');
  fs.writeFileSync(path.join(BOX, 'why', ticket), JSON.stringify({ why: 'all 24 slots are taken', since: 1 }));
  fs.writeFileSync(path.join(BOX, 'next', ticket), '');

  const sessions = () => [{ sessionId: 'running-session', pid: 100, cwd: alpha, name: 'alpha-work', status: 'busy' }];
  machine.resetMachine();
  const t0 = Date.now();
  world(1);
  machine.sample(sessions(), t0);
  world(4);                       // three seconds later: 3 s of ticks at the rates above
  machine.sample(sessions(), t0 + 3000);
  const v = machine.machineView({ nameOf: () => null });

  const byName = Object.fromEntries(v.projects.map((p) => [p.name, p]));
  const a = byName.alpha;
  assert.ok(a, 'the session\'s repository is its project');
  const s = a.sessions.find((x) => x.sessionId === 'running-session');
  assert.equal(s.name, 'alpha-work');
  assert.ok(Math.abs(s.cores - 1.1) < 0.01, `its own CPU and its test's: ${s.cores}`);
  assert.equal(s.top[0].comm, 'vitest', 'node named by the script it runs, not MainThread');
  const unknown = a.sessions.find((x) => x.sessionId === 'pid:700');
  assert.equal(unknown?.name, 'claude setup-token', 'a Claude process the tracker does not know is still a session');
  assert.deepEqual(a.leftovers.map((l) => [l.sessionId, l.top[0].comm]), [['ended-session', 'uvicorn']]);

  const b = byName.beta;
  assert.equal(b.jobs.length, 1);
  assert.ok(Math.abs(b.jobs[0].cores - 2) < 0.01, `a job's CPU from its scope's cgroup: ${b.jobs[0].cores}`);
  assert.equal(b.jobs[0].mem, 3 * 2 ** 30 - 2 * 2 ** 20, 'its memory, less the page cache');
  assert.equal(b.jobs[0].legacy, false, 'a job in its project\'s slice has its rank\'s share');
  assert.deepEqual(b.waits.map((w) => [w.why, w.next, w.priority]), [['all 24 slots are taken', true, true]]);
  assert.ok(!byName['beta\npriority'], 'a ticket\'s marks are not its project');

  assert.equal(byName.gamma.leftovers[0].orphan, true, 'a scope whose heavy is gone holds what a killed job left');
  assert.equal(byName.gamma.jobs.length, 0);

  const other = Object.fromEntries(v.others.map((o) => [o.kind, o]));
  assert.ok(other.tracker.top.some((t) => t.comm === 'claude-tracker'), 'a tracker run anywhere is the tracker');
  assert.ok(other.other?.top.some((t) => t.comm === 'bash'), 'a shell in tmux is nobody\'s, not the desktop\'s');
  assert.ok(!(other.desktop?.top ?? []).some((t) => t.comm === 'bash' || t.comm === 'tmux: server'));
  assert.equal(v.cpu.cores, os.cpus().length);
  assert.deepEqual(v.priority.set, false);
  assert.equal(byName.quiet, undefined, 'a project only shows when it has something here, or the owner ranked it');
});

test('the owner\'s priorities: read from heavy\'s file, set only through heavy', () => {
  const file = process.env.BOX_PRIORITY_FILE;
  try { fs.unlinkSync(file); } catch { /* none yet */ }
  fs.writeFileSync(path.join(BOX, 'config.json'), JSON.stringify({ unset_ranks: { quiet: 'low' } }));
  assert.deepEqual(machine.priorities().ranks, { quiet: 'low' }, 'no file: the ranks heavy keeps of its own, as it publishes them');
  fs.rmSync(path.join(BOX, 'config.json'));
  assert.deepEqual(machine.priorities().ranks, {}, 'no heavy has run here: every project normal');
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { bricks: 'high', bad: 'urgent' }, updated: 1700000000, by: 'test' }));
  const p = machine.priorities();
  assert.deepEqual(p.ranks, { bricks: 'high' }, 'a tier heavy does not know is dropped');
  assert.equal(p.updated, 1700000000 * 1000);

  // A stand-in heavy that notes what it was asked, or fails as heavy does.
  const bin = path.join(TMP, 'heavy');
  const log = path.join(TMP, 'heavy.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@ by=$BOX_PRIORITY_BY" >> ${log}\n[ "$2" = "fails" ] && { echo "heavy: it broke" >&2; exit 2; }\nexit 0\n`, { mode: 0o755 });
  process.env.BOX_HEAVY_BIN = bin;
  machine.setPriority('bricks', 'paused', 'the test');
  assert.equal(fs.readFileSync(log, 'utf8').trim(), '--priority bricks paused by=the test');
  assert.throws(() => machine.setPriority('a/b', 'high'), /not a project name/);
  assert.throws(() => machine.setPriority('bricks', 'urgent'), /one of high, normal, low, paused/);
  assert.throws(() => machine.setPriority('fails', 'high'), /heavy: it broke/, 'heavy\'s own words come back');
  assert.equal(machine.runNext(1234), '');
  assert.match(fs.readFileSync(log, 'utf8'), /--run-next 1234/);
  assert.throws(() => machine.runNext(-1), /not a job/);
});

test('a folder\'s repository is found from its .git, a worktree\'s included, with no git to run', () => {
  const main = repo('gamma-main');
  const wt = path.join(main, '.claude', 'worktrees', 'feature');
  const gitdir = path.join(main, '.git', 'worktrees', 'feature');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  fs.mkdirSync(path.join(wt, 'src', 'deep'), { recursive: true });
  assert.equal(machine.gitTop(path.join(wt, 'src', 'deep')), main);
  assert.equal(machine.gitTop(path.join(main, '.claude', 'worktrees', 'gone')), main, 'a worktree since removed is still its repo\'s');
  assert.equal(machine.gitTop(path.join(TMP, 'proc')), null);

  // A session's own folders are named for where it works, every other character a dash,
  // and read back against the disk.
  const enc = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  const scratch = (d) => path.join(TMP, 'claude-1000', enc(d), '0b4f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b', 'scratchpad');
  assert.equal(machine.projectOf(scratch(wt)), 'gamma-main', 'a session in a worktree is its repo\'s');
  assert.equal(machine.projectOf(scratch(path.join(main, '.claude', 'worktrees', 'gone'))), 'gamma-main', 'so is one whose worktree is gone');
  assert.equal(machine.projectOf(scratch(path.join(TMP, 'repos', 'gone-app'))), 'gone-app', 'a project folder since removed keeps its name');
  const dotted = repo('my.dotted');
  assert.equal(machine.projectOf(scratch(dotted)), 'my.dotted', 'the dot a dash stands for is found on the disk');
  assert.equal(machine.projectOf(path.join(scratch(dotted), 'claude-1000', enc(wt), 'x')), 'gamma-main', 'the innermost session folder names it');
  assert.equal(machine.projectOf(path.join(os.homedir(), '.claude', 'projects', enc(wt), 'tools')), 'gamma-main', 'and so does a project\'s folder in ~/.claude');
});

test('the disk view: what is left behind, and caches that only grow', () => {
  const G = 2 ** 30;
  const now = Date.now();
  fs.writeFileSync(path.join(process.env.CLAUDE_TRACKER_DIR, 'storage.json'), JSON.stringify({
    at: now - 60e3, version: 1, took: 1000, roots: [], tmp: '/tmp',
    disks: [{ mount: '/', size: 100 * G, used: 60 * G, avail: 40 * G, counted: 50 * G }],
    owners: [
      { key: 'caches:Shared caches', kind: 'caches', name: 'Shared caches', bytes: 7 * G, left: 0,
        items: [{ kind: 'cache', path: '/tmp/node-compile-cache', bytes: 6 * G }, { kind: 'cache', path: '/home/x/.npm', bytes: G }] },
      { key: 'project:alpha', kind: 'project', name: 'alpha', bytes: 9 * G, left: 3 * G,
        items: [{ kind: 'worktree', path: '/r/alpha/.claude/worktrees/old', bytes: 3 * G, left: true, idleDays: 12, repo: '/r/alpha' },
          { kind: 'repo', path: '/r/alpha', bytes: 6 * G }] },
      { key: 'project:tiny', kind: 'project', name: 'tiny', bytes: G, left: 1024, items: [{ kind: 'temp', path: '/tmp/tiny', bytes: 1024, left: true, idleDays: 9 }] },
    ],
  }));
  const s = storageView(now);
  assert.equal(s.disks[0].other, 10 * G, 'what the survey did not reach');
  assert.deepEqual(s.left.map((l) => l.name), ['alpha'], 'a few bytes left behind is not worth a line');
  assert.equal(s.owners.find((o) => o.name === 'alpha').counts.worktreesLeft, 1);
  const cmds = s.commands.map((c) => c.cmd);
  assert.ok(cmds.includes('rm -rf /tmp/node-compile-cache'), 'a cache nothing prunes, past 5 GB');
  assert.ok(!cmds.includes('npm cache clean --force'), 'a small one is left alone');
  assert.ok(cmds.includes('cd /r/alpha && ~/.claude/claude-core/bin/wt prune'));
});

test('the dashboard\'s writes come only from the dashboard itself', { timeout: 120_000 }, async () => {
  const home = path.join(TMP, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const port = 47931;
  const env = { ...process.env, HOME: home, CLAUDE_TRACKER_DIR: path.join(TMP, 'served'), CLAUDE_TRACKER_NOTIFY: '0' };
  delete env.CLAUDE_TRACKER_PROC;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_TRACKER_EXTRA_DIRS;
  const server = spawn(process.execPath, [path.resolve('bin/cli.js'), 'serve', '--no-tui', '--port', String(port)], { env, stdio: 'ignore' });
  try {
    const post = (body, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/priority', method: 'POST',
        headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/machine`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(up, 'the server came up');
    const log = path.join(TMP, 'heavy.log');
    fs.writeFileSync(log, '');
    assert.equal((await post({ project: 'bricks', tier: 'high' }, { origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.match(fs.readFileSync(log, 'utf8'), /--priority bricks high by=claude-tracker \(dashboard\)/);
    for (const [why, headers] of [['another site', { origin: 'http://evil.example' }], ['a rebinding name', { host: `evil.example:${port}` }],
      ['a plain form', { 'content-type': 'application/x-www-form-urlencoded' }]]) {
      const r = await post({ project: 'bricks', tier: 'paused' }, headers);
      assert.equal(r.status, 403, why);
    }
    assert.equal((await post({ project: 'bricks', tier: 'urgent' })).status, 400);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /paused|urgent/, 'none of those reached heavy');
  } finally {
    server.kill();
  }
});
