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
  const env = { ...process.env, HOME: home, CLAUDE_TRACKER_DIR: data, CLAUDE_TRACKER_NOTIFY: '0', CLAUDE_TRACKER_SSH: process.env.CT_TEST_SSH || fakeSsh, NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_TRACKER_EXTRA_DIRS;
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return {
    name, port, home, data, env, account, session, cli,
    append: (i) => fs.appendFileSync(transcript, `${line(i, Date.now())}\n`),
    relay: `CLAUDE_TRACKER_DIR='${data}' '${process.execPath}' '${CLI}' sync serve`,
    start() {
      this.proc = spawn(process.execPath, [CLI, 'serve', '--no-tui', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.log = '';
      this.proc.stdout.on('data', (b) => { this.log += b; });
      this.proc.stderr.on('data', (b) => { this.log += b; });
    },
    async get(p) { return (await fetch(`http://127.0.0.1:${port}${p}`)).json(); },
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

test.after(() => {
  for (const m of [laptop, devbox]) { try { m.proc?.kill(); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

test('two trackers sync both ways over one connection, live, without echoes piling up', { timeout: 120_000 }, async () => {
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
    assert.deepEqual(ov.sync.machines.map((m) => [m.name, m.online]), [[there.name, true]]);
  }

  // Running sessions from both machines, the other's marked with its name.
  const live = await until('the laptop to list the devbox session', async () => {
    const l = await laptop.get('/api/live');
    return l.length === 2 ? l : null;
  });
  assert.deepEqual(live.map((s) => [s.name, s.machine, s.account]).sort(),
    [['devbox-task', 'devbox', 'devbox@example.com'], ['laptop-task', null, 'laptop@example.com']]);

  // Both indexes hold both accounts.
  const rec = (await devbox.get('/api/overview')).accounts.map((a) => a.accountUuid).sort();
  assert.deepEqual(rec, [laptop.account.uuid, devbox.account.uuid].sort());

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

test('a machine with no tracker running says so, in its own words', { timeout: 60_000 }, async () => {
  const idle = machine('idle', 47913, { uuid: 'cccccccc-0000-0000-0000-000000000003', email: 'idle@example.com' });
  const r = laptop.cli('sync', 'add', IDLE_HOST, '--command', idle.relay);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`could not sync with ${quoted(IDLE_HOST)}: claude-tracker is not running on`));
});
