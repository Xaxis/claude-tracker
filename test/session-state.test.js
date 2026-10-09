import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/*
 * What each running session carries, and the shared GPU and CPU pool - in a
 * child process with a scratch home, real processes standing in for jobs (so
 * their environments are read from /proc as a real job's are), and lease
 * directories laid out the way claude-core's gpu and heavy write them.
 */
const SRC = new URL('../src/', import.meta.url).href;

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-state-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function inChild(root, body, env = {}) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    const HOME = process.env.HOME, MIN = 60_000, HOUR = 60 * MIN, now = Date.now();
    const { db } = await import('${SRC}db.js');
    const api = await import('${SRC}api.js');
    const ctx = await import('${SRC}context.js');
    const sleepers = [];
    // A process that lives for the test, with a Claude session's environment.
    const job = (sessionId, cwd) => {
      const p = spawn('sleep', ['60'], { stdio: 'ignore', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, PWD: cwd } });
      sleepers.push(p);
      return p.pid;
    };
    const startOf = (pid) => fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(')').pop().trim().split(/\\s+/)[19];
    const main = path.join(HOME, '.claude');
    const projects = path.join(main, 'projects', '-repo');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(main, 'settings.json'), '{}');
    const running = (id, name) => {
      const pid = job(id, '/repo');
      fs.mkdirSync(path.join(main, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(main, 'sessions', pid + '.json'), JSON.stringify({ pid, sessionId: id, name, status: 'busy', kind: 'interactive', cwd: '/repo', updatedAt: now }));
    };
    let seq = 0;
    // One call: its context split into input, cache writes and cache reads.
    const call = (session, ts, { input = 0, w5 = 0, w1 = 0, read = 0, side = 0, model = 'claude-opus-5-5' }) =>
      db().prepare(\`INSERT INTO events (call_id, ts, session_id, model, input_tokens, cache_write_5m, cache_write_1h, cache_read, is_sidechain, cost_usd)
                    VALUES (?,?,?,?,?,?,?,?,?,?)\`).run('c' + seq++, ts, session, model, input, w5, w1, read, side, 1);
    const file = (p, mtime) => db().prepare('INSERT INTO files (path, size, offset, mtime, scanned_at) VALUES (?,1,1,?,?)').run(p, mtime, now);
    const out = await (async () => { ${body} })();
    for (const p of sleepers) p.kill();
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root, CLAUDE_TRACKER_DIR: path.join(root, 'data'), CLAUDE_TRACKER_NOTIFY: '0',
      CLAUDE_CONFIG_DIR: '', CLAUDE_TRACKER_EXTRA_DIRS: '',
      BOX_GPU_DIR: path.join(root, 'box-gpu'), BOX_GPU_STATE: path.join(root, 'gpu-state'), BOX_HEAVY_DIR: path.join(root, 'box-heavy'),
      BOX_HEAVY_SLOTS: '', ...env },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const linux = fs.existsSync('/proc/self/environ');

test('a running session shows its main thread’s context, its subagents at work, and the turns that re-wrote a lapsed cache', () => {
  const root = scratch();
  const r = inChild(root, `
    running('sess-1', 'editor-cc');
    // The main thread's last turn carried 600k; a subagent's later turn carried more,
    // and must not be mistaken for the session's own.
    call('sess-1', now - 20 * MIN, { input: 2, w1: 1000, read: 400_000 });
    call('sess-1', now - 2 * MIN, { input: 2, w1: 4_000, read: 596_000 });
    call('sess-1', now - 1 * MIN, { side: 1, input: 2, w5: 2_000, read: 800_000 });
    // A subagent back from a long wait: its whole 500k context written again.
    call('sess-1', now - 30 * MIN, { side: 1, input: 2, w5: 490_000, read: 10_000 });
    // A first turn writes everything too, but 33k is a fresh start, not a lapse.
    call('sess-1', now - 40 * MIN, { side: 1, input: 2, w5: 33_000 });
    // ...and a lapse from yesterday is not this hour's.
    call('sess-1', now - 26 * HOUR, { side: 1, input: 2, w5: 500_000 });
    fs.writeFileSync(path.join(projects, 'sess-1.jsonl'), '');
    file(path.join(projects, 'sess-1.jsonl'), now);
    const sub = path.join(projects, 'sess-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-atranslate-1.meta.json'), JSON.stringify({ name: 'translate', agentType: 'general-purpose' }));
    file(path.join(sub, 'agent-atranslate-1.jsonl'), now - MIN);
    file(path.join(sub, 'agent-aold-2.jsonl'), now - 2 * HOUR);
    const s = api.liveSessions().find((x) => x.sessionId === 'sess-1');
    return { context: s.context, agents: s.agents.map((a) => a.name), recache: s.recache, leases: s.leases };
  `);
  assert.equal(r.context.tokens, 600_002);
  assert.equal(r.context.compactAt, 967_000);
  assert.ok(Math.abs(r.context.perTurn - 0.300001) < 1e-6, `re-reading 600k on Opus costs $0.30, not ${r.context.perTurn}`);
  assert.deepEqual(r.agents, ['translate'], 'only subagents seen in the last 15 minutes, named from their meta');
  assert.equal(r.recache.turns, 1);
  assert.ok(Math.abs(r.recache.cost - 490_000 * 6.25e-6) < 1e-6, 'priced as a 5-minute cache write');
  assert.deepEqual(r.leases, [], 'no GPU or CPU pool on this machine');
});

test('every job holding or waiting for the GPU and the CPU pool is named by its session and worktree', { skip: !linux && 'reads environments from /proc' }, () => {
  const root = scratch();
  const r = inChild(root, `
    running('sess-1', 'editor-cc');
    running('sess-2', 'castle-3');
    const gpu = process.env.BOX_GPU_DIR, heavy = process.env.BOX_HEAVY_DIR;
    // castle holds the GPU; two jobs of one editor agent wait behind it, and
    // a ticket left by a process that has exited is no one waiting.
    const holder = job('sess-2', '/work/castle');
    fs.mkdirSync(path.join(gpu, 'slot.0'), { recursive: true });
    fs.writeFileSync(path.join(gpu, 'slot.0', 'info.json'), JSON.stringify({ pid: holder, start: Number(startOf(holder)), sid: holder,
      project: 'castle', cwd: '/work/castle', cmd: 'env -u DISPLAY /home/me/.local/bin/godot-bin --path . --render', since: Math.floor(now / 1000) - 900 }));
    fs.mkdirSync(path.join(gpu, 'queue'), { recursive: true });
    const ticket = (dir, pid, at, start) => fs.writeFileSync(path.join(dir, 'queue', (at * 1e6).toFixed(0) + '-' + pid + (start ? '-' + start : '')), path.basename(dir) === 'box-gpu' ? 'editor' : 'site');
    for (const ago of [10, 9]) { const p = job('sess-1', '/work/editor/.claude/worktrees/translate/core'); ticket(gpu, p, now - ago * MIN, startOf(p)); }
    ticket(gpu, 999999999, now - 30 * MIN, 1);
    // The CPU pool: nothing held, two jobs waiting - one of them in an isolated
    // subagent's worktree, named after its id, which an earlier session made.
    fs.mkdirSync(path.join(heavy, 'queue'), { recursive: true });
    ticket(heavy, job('sess-2', '/work/castle'), now - 2 * MIN);
    const earlier = path.join(projects, 'sess-0', 'subagents');
    fs.mkdirSync(earlier, { recursive: true });
    fs.writeFileSync(path.join(earlier, 'agent-a1b2c3.jsonl'), '');
    fs.writeFileSync(path.join(earlier, 'agent-a1b2c3.meta.json'), JSON.stringify({ name: 'synth', worktreePath: '/work/castle/.claude/worktrees/agent-a1b2c3' }));
    // An index copied from another machine names the same agent at a path that is not here.
    file('/Users/someone/.claude/projects/-work-castle/sess-0/subagents/agent-a1b2c3.jsonl', now);
    file(path.join(earlier, 'agent-a1b2c3.jsonl'), now);
    ticket(heavy, job('sess-2', '/work/castle/.claude/worktrees/agent-a1b2c3/frontend'), now - MIN);
    // The lease log: an hour of it, and an older grant that does not count.
    fs.mkdirSync(process.env.BOX_GPU_STATE, { recursive: true });
    const log = (t, rec) => fs.appendFileSync(path.join(process.env.BOX_GPU_STATE, 'log.jsonl'), JSON.stringify({ t: t / 1000, ...rec }) + '\\n');
    log(now - 2 * HOUR, { event: 'grant', project: 'old', wait_s: 5000 });
    log(now - 50 * MIN, { event: 'grant', project: 'reels', wait_s: 600 });
    log(now - 40 * MIN, { event: 'release', project: 'castle', held_s: 1300 });
    log(now - 30 * MIN, { event: 'grant', project: 'editor', wait_s: 60 });
    const live = api.liveSessions();
    const [box] = api.boxes();
    const one = (id) => live.find((x) => x.sessionId === id).leases;
    return { box, s1: one('sess-1'), s2: one('sess-2') };
  `);
  const g = r.box.gpu;
  assert.equal(g.held.length, 1);
  assert.equal(g.held[0].session, 'castle-3');
  assert.match(g.held[0].cmd, /^godot-bin --path \. --render$/, 'the command, without the env prelude and the path');
  assert.equal(g.jobsWaiting, 2, 'the exited process’s ticket is nobody');
  assert.equal(g.waiting.length, 1, 'one agent’s two jobs are one wait');
  assert.deepEqual({ session: g.waiting[0].session, place: g.waiting[0].place, jobs: g.waiting[0].jobs, ahead: g.waiting[0].ahead },
    { session: 'editor-cc', place: 'translate', jobs: 2, ahead: 0 });
  assert.equal(g.hour.jobs, 2);
  assert.equal(g.hour.waitedMs, 660_000);
  assert.deepEqual(g.hour.longestHold, { ms: 1_300_000, project: 'castle' });

  const [wait] = r.s1;
  assert.equal(wait.kind, 'gpu');
  assert.equal(wait.state, 'waits');
  assert.ok(Date.now() - wait.since >= 10 * 60_000, 'waiting since its oldest job queued');
  assert.deepEqual(wait.behind.map((b) => b.who), ['castle-3']);
  assert.deepEqual(r.s2.map((l) => `${l.kind} ${l.state}`), ['gpu holds', 'cpu waits', 'cpu waits']);
  assert.deepEqual(r.s2.filter((l) => l.kind === 'cpu').map((l) => l.behind), [[], []], 'the CPU pool has no one holder to wait behind');
  assert.equal(r.box.cpu.jobsWaiting, 2);
  assert.deepEqual(r.box.cpu.waiting.map((w) => w.place), [null, 'synth'], 'an isolated subagent’s worktree goes by the agent’s name');
});

test('without /proc to read, jobs are still listed, by project', () => {
  const root = scratch();
  const r = inChild(root, `
    const gpu = process.env.BOX_GPU_DIR;
    fs.mkdirSync(path.join(gpu, 'queue'), { recursive: true });
    const p = job('sess-1', '/x');
    fs.writeFileSync(path.join(gpu, 'queue', ((now - MIN) * 1e6).toFixed(0) + '-' + p), 'editor');
    return api.boxes()[0].gpu.waiting;
  `, { CLAUDE_TRACKER_PROC: path.join(root, 'no-proc') });
  assert.equal(r.length, 1);
  assert.equal(r[0].project, 'editor');
  assert.equal(r[0].session, null);
});

test('a machine with no GPU lease or CPU pool shows none', () => {
  const root = scratch();
  assert.deepEqual(inChild(root, 'return api.boxes();'), []);
});

test('another machine’s GPU and CPU pool show as it last reported them', () => {
  const root = scratch();
  const r = inChild(root, `
    const box = { gpu: { held: [], waiting: [{ project: 'editor', session: 'cw', since: now - MIN, jobs: 1, ahead: 0 }], jobsWaiting: 1 }, cpu: null };
    db().prepare('INSERT INTO sync_machines (machine_id, name, last_seen, state, state_at) VALUES (?,?,?,?,?)')
      .run('m2', 'devbox', now, JSON.stringify({ running: [], profiles: [], box }), now);
    return api.boxes();
  `);
  assert.deepEqual(r.map((b) => [b.machine, b.gpu.waiting[0].session]), [['devbox', 'cw']]);
});

test('re-written caches are counted for subagents and the main thread apart, and the advice goes once subagents keep an hour', () => {
  const root = scratch();
  const r = inChild(root, `
    // Subagents on the 5-minute cache: a lapse after a wait re-writes 500k.
    for (let i = 0; i < 20; i++) call('s', now - i * MIN, { side: 1, input: 2, w5: 2_000, read: 500_000 });
    call('s', now - 3 * HOUR, { side: 1, input: 2, w5: 500_000 });
    // The main thread's one lapse, on its hour-long cache, last week.
    call('s', now - 3 * 86400e3, { input: 2, w1: 300_000, read: 1_000 });
    call('s', now - HOUR, { input: 2, w1: 3_000, read: 400_000 });
    const before = ctx.cacheSummary(now);
    // Subagents switched to the hour-long cache: the advice is gone.
    ctx.resetCacheSummary();
    for (let i = 0; i < 40; i++) call('s', now - i * 1000, { side: 1, input: 2, w1: 2_000, read: 500_000 });
    const after = ctx.cacheSummary(now);
    return { before, after };
  `);
  const { before, after } = r;
  assert.equal(before.day.turns, 1);
  assert.equal(before.week.sub.turns, 1);
  assert.equal(before.week.main.turns, 1);
  assert.ok(Math.abs(before.week.sub.cost - 500_000 * 6.25e-6) < 1e-6);
  assert.ok(Math.abs(before.week.main.cost - 300_000 * 10e-6) < 1e-6, 'an hour-long write is priced at twice input');
  assert.deepEqual(before.ttl, { sub: '5m', main: '1h' });
  assert.equal(before.hint?.setting, 'subagentPromptCacheTtl');
  assert.equal(before.week.share, before.week.cost / before.week.spend);
  assert.equal(after.ttl.sub, '1h');
  assert.equal(after.hint, null);
});

test('another machine on an older tracker is named as such, and its sessions’ context is worked out from its synced calls', () => {
  const root = scratch();
  const r = inChild(root, `
    const machine = (id, name, state) => db().prepare('INSERT INTO sync_machines (machine_id, name, last_seen, state, state_at) VALUES (?,?,?,?,?)')
      .run(id, name, now, JSON.stringify(state), now);
    const mine = api.build();
    // A laptop from before session detail: its running session says nothing of
    // its context, but its calls arrived here by sync.
    machine('m1', 'laptop', { running: [{ sessionId: 'lap-1', transcriptId: 'lap-1', name: 'notes', lastActivityAt: now }], profiles: [] });
    call('lap-1', now - MIN, { input: 2, w1: 1_000, read: 700_000 });
    call('lap-1', now - 20 * MIN, { side: 1, input: 2, w5: 400_000, read: 1_000 });
    machine('m2', 'same', { running: [], profiles: [], build: mine });
    machine('m3', 'ahead', { running: [], profiles: [], build: { id: 'f00f00f', at: mine.at + 86400e3 } });
    machine('m4', 'behind', { running: [], profiles: [], build: { id: 'b00b00b', at: mine.at - 86400e3 } });
    const lap = api.liveSessions().find((s) => s.sessionId === 'lap-1');
    return { mine, versions: Object.fromEntries(api.overview().sync.machines.map((m) => [m.name, m.version])),
      context: lap.context?.tokens, recache: lap.recache?.turns, sent: api.localState().build };
  `);
  assert.match(r.mine.id, /^[0-9a-f]{7,}$/, 'this tracker knows its own commit');
  assert.deepEqual(r.sent, r.mine, 'and tells the machines it syncs with');
  assert.deepEqual(r.versions, { laptop: 'older', same: null, ahead: 'newer', behind: 'older' });
  assert.equal(r.context, 701_002);
  assert.equal(r.recache, 1);
});

test('the CPU and GPU pools report the settings they publish, not copied defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-pools-'));
  const heavy = path.join(root, 'box-heavy'), gpu = path.join(root, 'box-gpu');
  fs.mkdirSync(heavy); fs.mkdirSync(gpu);
  fs.writeFileSync(path.join(heavy, 'config.json'), JSON.stringify({ slots: 24, per_project: 8, load: 30, cores: 24 }));
  fs.writeFileSync(path.join(gpu, 'config.json'), JSON.stringify({ slots: 1, configured_slots: 2 }));
  const saved = { h: process.env.BOX_HEAVY_DIR, g: process.env.BOX_GPU_DIR, s: process.env.BOX_GPU_STATE };
  Object.assign(process.env, { BOX_HEAVY_DIR: heavy, BOX_GPU_DIR: gpu, BOX_GPU_STATE: path.join(root, 'state') });
  try {
    const { boxState } = await import('../src/box.js');
    const box = boxState(Date.now() + 86_400_000);  // a time no earlier read was memoised at
    assert.equal(box.cpu.slots, 24);
    assert.equal(box.cpu.gate, 30, 'the gate heavy uses, not the core count');
    assert.equal(box.gpu.slots, 1, 'one slot while gpu backs off after a reset');
    assert.ok(Number.isFinite(box.cpu.load));
  } finally {
    for (const [k, v] of [['BOX_HEAVY_DIR', saved.h], ['BOX_GPU_DIR', saved.g], ['BOX_GPU_STATE', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
