import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/*
 * Failing over, run in a child process with a scratch home: its own profiles,
 * index and running sessions, and a stand-in for `claude` that logs how it was
 * called and answers as the real one does. Nothing here touches real profiles.
 */
const SRC = new URL('../src/', import.meta.url).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-failover-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const fakeClaude = path.join(root, 'claude');
fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(root, 'claude.log'))}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\\n');
const args = process.argv.slice(2);
if (args.includes('--bg')) console.log('backgrounded · ' + (args.includes('--resume') ? args[args.indexOf('--resume') + 1].slice(0, 8) : 'deadbeef') + ' · ' + args[args.indexOf('-n') + 1] + ' (idle — send a prompt to start)');
else if (args[0] === 'stop') console.log('stopped ' + args[1]);
`, { mode: 0o755 });

/** Run `body` in a child with the scratch home; it prints JSON, which comes back parsed. */
function inChild(body) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    const HOME = process.env.HOME, MIN = 60_000, HOUR = 60 * MIN, now = Date.now();
    const { db } = await import('${SRC}db.js');
    const api = await import('${SRC}api.js');
    const F = await import('${SRC}failover.js');
    const profile = (name, uuid, email) => {
      const dir = path.join(HOME, name);
      fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
      const cfg = name === '.claude' ? path.join(HOME, '.claude.json') : path.join(dir, '.claude.json');
      fs.writeFileSync(cfg, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }));
      db().prepare('INSERT OR IGNORE INTO accounts (account_uuid, email, last_seen) VALUES (?,?,?)').run(uuid, email, now);
      return dir;
    };
    const sleepers = [];
    const running = (dir, id, name, status) => {
      const p = spawn('sleep', ['60'], { stdio: 'ignore' }); sleepers.push(p);
      const cwd = path.join(HOME, 'work', 'app');
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sessions', p.pid + '.json'), JSON.stringify({ pid: p.pid, sessionId: id, name, status, cwd, updatedAt: now }));
      fs.mkdirSync(path.join(dir, 'projects', '-work-app'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', '-work-app', id + '.jsonl'), '{}\\n');
    };
    const read = (acct, type, pct, resetsAt) => db().prepare("INSERT INTO utilization (ts, session_id, account_uuid, limit_type, pct, resets_at) VALUES (?, 'r-' || ?, ?, ?, ?, ?)").run(now - MIN, acct + type, acct, type, pct, resetsAt);
    const out = await (async () => { ${body} })();
    for (const p of sleepers) p.kill();
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root, CLAUDE_TRACKER_DIR: path.join(root, 'data'), CLAUDE_TRACKER_CLAUDE: fakeClaude,
      CLAUDE_TRACKER_NOTIFY: '0', CLAUDE_CONFIG_DIR: '', CLAUDE_TRACKER_EXTRA_DIRS: '' },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const calls = () => fs.readFileSync(path.join(root, 'claude.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('an idle session on an account running low moves to the profile with the most room', () => {
  const out = inChild(`
    const main = profile('.claude', 'A', 'a@x.com');
    const roomy = profile('.claude-b', 'B', 'b@x.com');
    profile('.claude-c', 'C', 'c@x.com');
    read('A', 'five_hour', 95, now + 3 * HOUR); read('A', 'seven_day', 40, now + 3 * 86400e3);
    read('B', 'five_hour', 20, now + 2 * HOUR); read('B', 'seven_day', 30, now + 4 * 86400e3);
    // C has more room on paper, but the API refused it until later.
    db().prepare("INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status) VALUES (?, 'rc', 'C', 'five_hour', ?, 'rejected')").run(now - MIN, Math.floor((now + 2 * HOUR) / 1000));
    running(main, 'aaaaaaaa-idle', 'idle-one', 'idle');
    running(main, 'bbbbbbbb-busy', 'busy-one', 'busy');
    F.setFailover({ mode: 'auto', at: 90 });
    const ov = api.overview(), live = api.liveSessions();
    const p = F.plan(ov, live);
    const first = await F.runFailover(ov, live);
    const again = await F.runFailover(api.overview(), api.liveSessions());
    return { plan: p.entries.map((e) => ({ label: e.label, due: e.due, target: e.target?.label, dir: e.target?.dir })), first, again: again.length,
      copied: fs.existsSync(path.join(roomy, 'projects', '-work-app', 'aaaaaaaa-idle.jsonl')), roomy };
  `);
  assert.deepEqual(out.plan, [{ label: 'a@x.com', due: true, target: 'b@x.com', dir: out.roomy }]);
  assert.equal(out.first.length, 1, 'only the idle session moves; the busy one finishes its turn first');
  assert.deepEqual([out.first[0].session_id, out.first[0].status, out.first[0].bg_id, out.first[0].continued], ['aaaaaaaa-idle', 'started', 'aaaaaaaa', 0], out.first[0].error);
  assert.equal(out.again, 0, 'a session moves once');
  assert.equal(out.copied, true, 'its transcript is where the new profile can resume it');
  const [c] = calls();
  assert.deepEqual(c, { args: ['--resume', 'aaaaaaaa-idle', '--fork-session', '--bg', '-n', 'idle-one'], cwd: path.join(root, 'work', 'app'), configDir: out.roomy });
});

test('a session cut off by a refusal is told to carry on; one that frees up soon stays', async () => {
  fs.rmSync(path.join(root, 'claude.log'), { force: true });
  const out = inChild(`
    const main = path.join(HOME, '.claude');
    // busy-one has since been refused mid-task, and sits idle.
    for (const f of fs.readdirSync(path.join(main, 'sessions'))) fs.rmSync(path.join(main, 'sessions', f));
    running(main, 'bbbbbbbb-busy', 'busy-one', 'idle');
    db().prepare("INSERT INTO events (call_id, ts, session_id, cost_usd) VALUES ('b1', ?, 'bbbbbbbb-busy', 1)").run(now - 10 * MIN);
    db().prepare("INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status) VALUES (?, 'bbbbbbbb-busy', 'A', 'five_hour', ?, 'rejected')").run(now - 5 * MIN, Math.floor((now + 3 * HOUR) / 1000));
    const moved = await F.runFailover(api.overview(), api.liveSessions());
    // Now an account out for only five more minutes: not worth moving.
    db().prepare("UPDATE limit_events SET resets_at = ? WHERE session_id = 'bbbbbbbb-busy'").run(Math.floor((now + 5 * MIN) / 1000));
    db().prepare("UPDATE utilization SET resets_at = ? WHERE account_uuid = 'A' AND limit_type = 'five_hour'").run(now + 5 * MIN);
    const soon = F.plan(api.overview(), api.liveSessions()).entries.find((e) => e.label === 'a@x.com');
    return { moved, soon: { due: soon.due, freesAt: soon.freesAt != null } };
  `);
  assert.deepEqual(out.moved.map((m) => [m.session_id, m.continued]), [['bbbbbbbb-busy', 1]]);
  assert.equal(calls()[0].args.at(-1), (await import('../src/failover.js')).CONTINUE);
  assert.deepEqual(out.soon, { due: false, freesAt: true });
});

test('with failover off the plan is still worked out, and nothing moves', () => {
  fs.rmSync(path.join(root, 'claude.log'), { force: true });
  const out = inChild(`
    F.setFailover({ mode: 'off' });
    db().prepare('DELETE FROM failovers').run();
    running(path.join(HOME, '.claude'), 'cccccccc-idle', 'third', 'idle');
    const ov = api.overview(), live = api.liveSessions();
    return { entries: F.plan(ov, live).entries.length, moved: (await F.runFailover(ov, live)).length };
  `);
  assert.ok(out.entries > 0);
  assert.equal(out.moved, 0);
  assert.equal(fs.existsSync(path.join(root, 'claude.log')), false, 'claude was never run');
});
