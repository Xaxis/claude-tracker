import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/*
 * Two real trackers, each with its own home, profile and index, syncing the way
 * `sync add` sets them up. Only ssh itself is stood in for: a script that drops
 * ssh's options and host and runs the remote command here. To go through real
 * ssh instead, set CT_TEST_SSH (e.g. "ssh") and CT_TEST_HOST (e.g. localhost).
 */
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'cli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sync-'));
const fakeSsh = path.join(root, 'ssh');
fs.writeFileSync(fakeSsh, '#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec sh -c "$1"\n', { mode: 0o755 });

const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();

function machine(name, port, account) {
  const home = path.join(root, name);
  const data = path.join(home, 'data');
  const prof = path.join(home, '.claude');
  const project = path.join(prof, 'projects', `-work-${name}`);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(prof, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(prof, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: account.uuid, emailAddress: account.email, organizationRateLimitTier: 'default_claude_max_20x' },
  }));
  const session = `${name}-session-0000-0000-000000000000`;
  const transcript = path.join(project, `${session}.jsonl`);
  const line = (i, t) => JSON.stringify({
    type: 'assistant', timestamp: iso(t), sessionId: session, cwd: `/work/${name}`, uuid: `${name}-line-${i}`,
    message: { id: `msg_${name}_${i}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000 } },
  });
  const start = Date.now() - 30 * MIN;
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'attachment', timestamp: iso(start), sessionId: session,
      attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${account.email}.` } } }),
    ...Array.from({ length: 5 }, (_, i) => line(i, start + i * MIN)),
    // A refusal with no session: the kind a unique key cannot catch coming back round.
    JSON.stringify({ type: 'system', timestamp: iso(start + 6 * MIN),
      quotaLimits: { resetsAt: Math.floor((Date.now() + 3 * 3600e3) / 1000), rateLimitType: `five_hour_${name}`, status: 'allowed' } }),
  ].join('\n') + '\n');
  // A running session, registered to a process that is alive: this test's own.
  fs.writeFileSync(path.join(prof, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: session, cwd: `/work/${name}`, name: `${name}-task`, status: 'busy',
    startedAt: start, updatedAt: Date.now(),
  }));
  // A stand-in heavy that keeps the owner's ranks where the tracker reads them, and notes what it was asked.
  const heavy = path.join(home, 'heavy');
  fs.writeFileSync(heavy, `#!/bin/sh\necho "$@ by=$BOX_PRIORITY_BY" >> '${path.join(home, 'heavy.log')}'\n`
    + `[ "$1" = --priority ] && printf '{"version":1,"projects":{"%s":"%s"},"updated":1,"by":"x"}' "$2" "$3" > "$BOX_PRIORITY_FILE"\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_TRACKER_DIR: data, CLAUDE_TRACKER_NOTIFY: '0', CLAUDE_TRACKER_SSH: process.env.CT_TEST_SSH || fakeSsh, NO_COLOR: '1',
    // Each its own GPU lease, CPU pool and priorities, none of them the machine's real ones.
    BOX_GPU_DIR: path.join(home, 'box-gpu'), BOX_HEAVY_DIR: path.join(home, 'box-heavy'), BOX_GPU_STATE: path.join(home, 'gpu-state'),
    BOX_HEAVY_BIN: heavy, BOX_PRIORITY_FILE: path.join(home, 'priority.json'), BOX_HEAVY_SLICE: '' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_TRACKER_EXTRA_DIRS;
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return {
    name, port, home, data, env, account, session, cli,
    /** A job of `project` waiting for this machine's GPU - this test process, so it is alive. */
    queueForGpu(project) {
      const q = path.join(env.BOX_GPU_DIR, 'queue');
      fs.mkdirSync(q, { recursive: true });
      const start = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(')').pop().trim().split(/\s+/)[19];
      fs.writeFileSync(path.join(q, `${(Date.now() - MIN) * 1e6}-${process.pid}-${start}`), project);
    },
    append: (i) => fs.appendFileSync(transcript, `${line(i, Date.now())}\n`),
    relay: `CLAUDE_TRACKER_DIR='${data}' '${process.execPath}' '${CLI}' sync serve`,
    start() {
      this.proc = spawn(process.execPath, [CLI, 'serve', '--no-tui', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.log = '';
      this.proc.stdout.on('data', (b) => { this.log += b; });
      this.proc.stderr.on('data', (b) => { this.log += b; });
    },
    async get(p) { return (await fetch(`http://127.0.0.1:${port}${p}`)).json(); },
    /** A write as the dashboard makes it. */
    async post(p, body) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } });
      return { status: r.status, body: await r.json() };
    },
    heavyLog: () => { try { return fs.readFileSync(path.join(home, 'heavy.log'), 'utf8'); } catch { return ''; } },
    count(sql) {
      const d = new DatabaseSync(path.join(data, 'tracker.db'), { readOnly: true });
      try { return d.prepare(sql).get().n; } finally { d.close(); }
    },
  };
}

async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

const HOST = process.env.CT_TEST_SSH ? process.env.CT_TEST_HOST || 'localhost' : 'devbox.example';
const IDLE_HOST = process.env.CT_TEST_SSH ? HOST : 'idle.example';
const quoted = (h) => h.replace(/\./g, '\\.');

const laptop = machine('laptop', 47911, { uuid: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'laptop@example.com' });
const devbox = machine('devbox', 47912, { uuid: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'devbox@example.com' });

test.after(async () => {
  // Wait for each tracker to exit before removing its files from under it.
  await Promise.all([laptop, devbox].map((m) => m.proc && m.proc.exitCode === null && new Promise((resolve) => {
    m.proc.once('exit', resolve);
    m.proc.kill();
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('two trackers sync both ways over one connection, live, without echoes piling up', { timeout: 120_000 }, async () => {
  if (fs.existsSync('/proc/self/stat')) devbox.queueForGpu('render');
  for (const m of [laptop, devbox]) {
    assert.equal(m.cli('sync', 'name', m.name).status, 0);
    m.start();
  }
  for (const m of [laptop, devbox]) await until(`${m.name} to serve`, () => m.get('/api/health'));

  // Only the laptop dials, as a laptop that can reach the dev box but not the other way round would.
  const add = laptop.cli('sync', 'add', HOST, '--command', devbox.relay, '--port', String(laptop.port));
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.match(add.stdout, new RegExp(`${quoted(HOST)} is devbox; this machine is laptop`));
  assert.match(add.stdout, /✓ syncing/);

  // Each side has the other's calls and account, and settles them on the right account.
  for (const [here, there] of [[laptop, devbox], [devbox, laptop]]) {
    const ov = await until(`${here.name} to see ${there.name}'s account`, async () => {
      const o = await here.get('/api/overview');
      return o.accounts.find((a) => a.accountUuid === there.account.uuid && a.totalEvents === 5) ? o : null;
    });
    assert.equal(ov.unattributed.events, 0);
    // Both run this same code, so neither calls the other older.
    assert.deepEqual(ov.sync.machines.map((m) => [m.name, m.online, m.version]), [[there.name, true, null]]);
  }

  // Running sessions from both machines, the other's marked with its name.
  const live = await until('the laptop to list the devbox session', async () => {
    const l = await laptop.get('/api/live');
    return l.length === 2 ? l : null;
  });
  assert.deepEqual(live.map((s) => [s.name, s.machine, s.account]).sort(),
    [['devbox-task', 'devbox', 'devbox@example.com'], ['laptop-task', null, 'laptop@example.com']]);

  // The devbox session's detail arrives as the devbox worked it out - its
  // context a turn, and its subagents and jobs, none here - not left behind at
  // the edge.
  const remote = live.find((s) => s.machine === 'devbox');
  assert.equal(remote.context?.tokens, 21_000);
  assert.deepEqual([remote.agents, remote.leases, remote.recache], [[], [], { turns: 0, cost: 0 }]);
  // ...and so does the devbox's GPU queue.
  if (fs.existsSync('/proc/self/stat')) {
    const boxes = await until('the laptop to see the devbox GPU queue', async () => {
      const b = await laptop.get('/api/box');
      return b.some((x) => x.machine === 'devbox') ? b : null;
    });
    assert.deepEqual(boxes.map((b) => [b.machine, b.gpu?.jobsWaiting, b.gpu?.waiting[0]?.project]), [['devbox', 1, 'render']]);
  }

  // Both indexes hold both accounts.
  const rec = (await devbox.get('/api/overview')).accounts.map((a) => a.accountUuid).sort();
  assert.deepEqual(rec, [laptop.account.uuid, devbox.account.uuid].sort());

  // Each machine marks both accounts in use, and says where.
  for (const m of [laptop, devbox]) {
    const out = m.cli('status').stdout;
    assert.match(out, /● laptop@example\.com on laptop /, `${m.name}: ${out}`);
    assert.match(out, /● devbox@example\.com on devbox /, `${m.name}: ${out}`);
  }

  // A new call on the devbox reaches the laptop live.
  devbox.append(5);
  await until('a new devbox call to reach the laptop', async () =>
    (await laptop.get('/api/overview')).accounts.find((a) => a.accountUuid === devbox.account.uuid)?.totalEvents === 6);

  // Rows that went across and came back are stored once, however long they bounce.
  await new Promise((r) => setTimeout(r, 6000));
  for (const m of [laptop, devbox]) {
    assert.equal(m.count('SELECT COUNT(*) n FROM events'), 11, `${m.name} events`);
    assert.equal(m.count('SELECT COUNT(*) n FROM limit_events WHERE session_id IS NULL'), 2, `${m.name} refusals`);
    assert.equal(m.count('SELECT COUNT(*) n FROM sessions'), 2, `${m.name} sessions`);
    assert.equal(m.count('SELECT COUNT(*) n FROM accounts'), 2, `${m.name} accounts`);
  }
  const status = laptop.cli('sync');
  assert.match(status.stdout, new RegExp(`${quoted(HOST)}\\s+connected`));
  assert.match(status.stdout, /devbox\s+online · 1 session running/);
});

test('each machine shows the other\'s cores, and sets the other\'s priorities through the other\'s heavy', { timeout: 60_000 }, async () => {
  if (!fs.existsSync('/proc/self/stat')) return;   // the sampler here is Linux's or macOS's
  // The laptop dialed the devbox; the devbox, which cannot dial back, still sees the laptop.
  const list = await until('the laptop to have the devbox\'s panel', async () => {
    const m = await laptop.get('/api/machine');
    return m.machines?.find((x) => x.name === 'devbox' && x.hasMachine) ? m.machines : null;
  });
  assert.deepEqual(list.map((x) => [x.name, x.self]), [['laptop', true], ['devbox', false]]);
  const devboxId = list[1].id;
  await until('the devbox to have the laptop\'s panel', async () =>
    (await devbox.get('/api/machine')).machines?.find((x) => x.name === 'laptop' && x.hasMachine));

  const there = await laptop.get(`/api/machine?on=${devboxId}`);
  assert.equal(there.remote.name, 'devbox');
  assert.equal(there.remote.online, true);
  assert.ok(there.cpu.cores >= 1, 'the devbox\'s own cores');
  // Its own pool and priorities, not the laptop's (a session's process may sit in a job's cgroup when the tests run under heavy).
  assert.equal(there.priority.file, devbox.env.BOX_PRIORITY_FILE);
  assert.equal(there.gpu?.leases?.waiting, 1, 'the devbox\'s GPU queue');
  assert.equal((await laptop.get('/api/machine')).gpu?.leases?.waiting ?? 0, 0, 'which is not the laptop\'s');

  // A click on the laptop's dashboard reaches the devbox's heavy, and the answer carries the change.
  const r = await laptop.post('/api/priority', { machine: devboxId, project: 'render', tier: 'high' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(devbox.heavyLog(), /--priority render high by=claude-tracker on laptop/);
  assert.equal(laptop.heavyLog(), '', 'the laptop\'s own heavy was not asked');
  assert.equal(r.body.projects.find((p) => p.name === 'render')?.tier, 'high', 'the devbox\'s panel came back first');
  const next = await laptop.post('/api/run-next', { machine: devboxId, pid: 4242 });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.match(devbox.heavyLog(), /--run-next 4242/);
  const bad = await laptop.post('/api/priority', { machine: 'nope00000000', project: 'render', tier: 'low' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not connected/);
});

test('a session resumed on the other machine moves only itself, and a copied profile lists nothing twice', { timeout: 120_000 }, async () => {
  // Started on the laptop, signed into the laptop's account...
  const sid = 'roamer-session-0000-0000-000000000000';
  const ctx = (email, t) => JSON.stringify({ type: 'attachment', timestamp: iso(t), sessionId: sid,
    attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${email}.` } } });
  const call = (i, t) => JSON.stringify({ type: 'assistant', timestamp: iso(t), sessionId: sid, cwd: '/work/roamer',
    message: { id: `msg_roamer_${i}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500 } } });
  const start = Date.now() - 2 * 3600e3;
  const history = [ctx(laptop.account.email, start), call(0, start + MIN), call(1, start + 2 * MIN)].join('\n') + '\n';
  fs.writeFileSync(path.join(laptop.home, '.claude', 'projects', '-work-laptop', `${sid}.jsonl`), history);
  await until('the laptop to read the roaming session', () => laptop.count(`SELECT COUNT(*) n FROM events WHERE session_id = '${sid}'`) === 2);

  // ...then its transcript carried to the devbox and resumed there, on the devbox's account.
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(devbox.home, '.claude', 'projects', '-work-devbox', `${sid}.jsonl`),
      history + [ctx(devbox.account.email, now), call(2, now + 1000)].join('\n') + '\n');
    fs.writeFileSync(path.join(devbox.home, '.claude', 'sessions', `${sleeper.pid}.json`), JSON.stringify({
      pid: sleeper.pid, sessionId: sid, cwd: '/work/roamer', name: 'roamer-task', status: 'busy', startedAt: now, updatedAt: now }));
    // A copy of the laptop's profile, running-session registry and all - as a backup taken earlier.
    const copy = path.join(laptop.home, '.claude-copy');
    fs.mkdirSync(path.join(copy, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(copy, 'sessions'));
    fs.writeFileSync(path.join(copy, 'settings.json'), '{}');
    const reg = JSON.parse(fs.readFileSync(path.join(laptop.home, '.claude', 'sessions', `${process.pid}.json`), 'utf8'));
    fs.writeFileSync(path.join(copy, 'sessions', `${process.pid}.json`), JSON.stringify({ ...reg, updatedAt: reg.updatedAt - 3600e3 }));

    for (const [here, there] of [[laptop, devbox], [devbox, laptop]]) {
      const live = await until(`${here.name} to list the roaming session on the devbox`, async () => {
        const l = await here.get('/api/live');
        return l.some((s) => s.name === 'roamer-task') && l.some((s) => s.name === 'laptop-task') ? l : null;
      });
      const mine = (m) => (m === here ? null : m.name);
      // Each session on the account it is actually running as - the laptop's own
      // sessions are not moved by a /login record written on the devbox.
      assert.deepEqual(live.map((s) => [s.name, s.machine, s.account]).sort(), [
        ['devbox-task', mine(devbox), devbox.account.email],
        ['laptop-task', mine(laptop), laptop.account.email],
        ['roamer-task', mine(devbox), devbox.account.email],
      ], `${here.name}'s running sessions`);
    }
  } finally {
    sleeper.kill();
  }
});

test('a machine with no tracker running says so, in its own words', { timeout: 60_000 }, async () => {
  const idle = machine('idle', 47913, { uuid: 'cccccccc-0000-0000-0000-000000000003', email: 'idle@example.com' });
  const r = laptop.cli('sync', 'add', IDLE_HOST, '--command', idle.relay);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`could not sync with ${quoted(IDLE_HOST)}: claude-tracker is not running on`));
});
