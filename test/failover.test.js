import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/*
 * Switching a profile's sign-in, in a child process with a scratch home: its
 * own profiles, spares and running sessions, with made-up tokens. Nothing here
 * touches a real sign-in.
 */
const SRC = new URL('../src/', import.meta.url).href;
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'cli.js');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-switch-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Run `body` in a child with HOME at `root`; it prints JSON, which comes back parsed. */
function inChild(root, body, env = {}) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    const HOME = process.env.HOME, MIN = 60_000, HOUR = 60 * MIN, now = Date.now();
    const { db } = await import('${SRC}db.js');
    const api = await import('${SRC}api.js');
    const F = await import('${SRC}failover.js');
    const S = await import('${SRC}signin.js');
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
    const account = (uuid, email) => ({ accountUuid: uuid, emailAddress: email, organizationUuid: 'org-' + uuid });
    const token = (who) => ({ accessToken: 'at-' + who, refreshToken: 'rt-' + who, expiresAt: now + HOUR, scopes: [] });
    const sleepers = [];
    const running = (dir, id) => {
      const p = spawn('sleep', ['60'], { stdio: 'ignore' }); sleepers.push(p);
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sessions', p.pid + '.json'), JSON.stringify({ pid: p.pid, sessionId: id, status: 'busy', kind: 'interactive', cwd: HOME, updatedAt: now }));
    };
    const reading = (acct, type, pct, resetsAt) => db().prepare("INSERT INTO utilization (ts, session_id, account_uuid, limit_type, pct, resets_at) VALUES (?, 'r-' || ?, ?, ?, ?, ?)").run(now - MIN, acct + type, acct, type, pct, resetsAt);
    const out = await (async () => { ${body} })();
    for (const p of sleepers) p.kill();
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root, CLAUDE_TRACKER_DIR: path.join(root, 'data'), CLAUDE_TRACKER_NOTIFY: '0',
      CLAUDE_CONFIG_DIR: '', CLAUDE_TRACKER_EXTRA_DIRS: '', ...env },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** ~/.claude signed into A, with an MCP server's own token beside A's; spares for B and C. */
const SETUP = `
  const main = path.join(HOME, '.claude');
  fs.mkdirSync(path.join(main, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(main, 'settings.json'), '{}');
  fs.writeFileSync(path.join(main, '.credentials.json'), JSON.stringify({ claudeAiOauth: token('A'), mcpOAuth: { linear: { accessToken: 'mcp' } } }));
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: account('A', 'a@x.com'), mcpServers: { linear: {} }, userID: 'me' }));
  db().prepare("INSERT INTO accounts (account_uuid, email, last_seen) VALUES ('A', 'a@x.com', ?), ('B', 'b@x.com', ?), ('C', 'c@x.com', ?)").run(now, now, now);
  for (const who of ['B', 'C']) {
    const s = F.makeSpare(who.toLowerCase() + '@x.com');
    S.writeSignin(s, { oauth: token(who), account: account(who, who.toLowerCase() + '@x.com') });
  }
  reading('B', 'five_hour', 10, now + 2 * HOUR); reading('B', 'seven_day', 20, now + 4 * 86400e3);
  reading('C', 'five_hour', 50, now + 2 * HOUR);
  running(main, 'sess-1'); running(main, 'sess-2');
`;

test('a profile running low switches to the spare with the most room, and every sign-in ends up in exactly one place', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    reading('A', 'five_hour', 95, now + 3 * HOUR);
    F.setFailover({ mode: 'auto', at: 90 });
    const ov = api.overview(), live = api.liveSessions();
    const p = F.plan(ov, live);
    const first = F.runFailover(ov, live);
    const again = F.runFailover(api.overview(), api.liveSessions());
    return {
      plan: p.entries.map((e) => [e.profile, e.label, e.due, e.target?.label, e.sessions]),
      first: first.map((m) => [m.status, m.from_account, m.to_account, m.error]), again: again.length,
      main: { store: read(path.join(main, '.credentials.json')), config: read(path.join(HOME, '.claude.json')) },
      spareB: { store: read(path.join(HOME, '.claude-pool-b', '.credentials.json')), config: read(path.join(HOME, '.claude-pool-b', '.claude.json')) },
      spareA: { store: read(path.join(HOME, '.claude-pool-a', '.credentials.json')), config: read(path.join(HOME, '.claude-pool-a', '.claude.json')), mark: read(path.join(HOME, '.claude-pool-a', '.claude-tracker-spare')) },
      lockGone: !fs.existsSync(path.join(main, '.storage-write.lock')),
    };
  `);
  assert.deepEqual(out.plan, [['~/.claude', 'a@x.com', true, 'b@x.com', 2]]);
  assert.deepEqual(out.first, [['switched', 'A', 'B', null]]);
  assert.equal(out.again, 0, 'a switched profile is left to settle');
  // ~/.claude holds B now - and kept everything that is not the account's.
  assert.equal(out.main.store.claudeAiOauth.refreshToken, 'rt-B');
  assert.deepEqual(out.main.store.mcpOAuth, { linear: { accessToken: 'mcp' } });
  assert.equal(out.main.config.oauthAccount.accountUuid, 'B');
  assert.deepEqual([out.main.config.mcpServers, out.main.config.userID], [{ linear: {} }, 'me']);
  // B's spare gave its sign-in up; A's went into a spare of its own.
  assert.equal(out.spareB.store.claudeAiOauth, undefined);
  assert.equal(out.spareB.config.oauthAccount, undefined);
  assert.equal(out.spareA.store.claudeAiOauth.refreshToken, 'rt-A');
  assert.equal(out.spareA.config.oauthAccount.accountUuid, 'A');
  assert.deepEqual(out.spareA.mark, { email: 'a@x.com' });
  assert.equal(out.lockGone, true);
});

test('nothing switches while failover is off, below the threshold, or when the account frees up within the wait', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    reading('A', 'five_hour', 95, now + 3 * HOUR);
    const off = F.runFailover(api.overview(), api.liveSessions()).length;
    F.setFailover({ mode: 'auto', at: 97 });
    const below = F.runFailover(api.overview(), api.liveSessions()).length;
    // Refused, but back in five minutes: not worth it.
    F.setFailover({ at: 90 });
    db().prepare("INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status) VALUES (?, 'x', 'A', 'five_hour', ?, 'rejected')").run(now - MIN, Math.floor((now + 5 * MIN) / 1000));
    db().prepare("UPDATE utilization SET resets_at = ? WHERE account_uuid = 'A'").run(now + 5 * MIN);
    const soon = F.runFailover(api.overview(), api.liveSessions()).length;
    return { off, below, soon, still: read(path.join(HOME, '.claude.json')).oauthAccount.accountUuid };
  `);
  assert.deepEqual(out, { off: 0, below: 0, soon: 0, still: 'A' });
});

test('on macOS the sign-in moves between Keychain items named as Claude Code names them', () => {
  const root = scratch();
  // A stand-in for security(1): items in a JSON file, keyed by service and account.
  const items = path.join(root, 'keychain.json');
  const security = path.join(root, 'security');
  fs.writeFileSync(security, `#!${process.execPath}
const fs = require('fs'); const f = ${JSON.stringify(items)};
const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const opt = (args, k) => args[args.indexOf(k) + 1];
let args = process.argv.slice(2);
if (args[0] === '-i') args = fs.readFileSync(0, 'utf8').trim().match(/"[^"]*"|\\S+/g).map((x) => x.replace(/^"|"$/g, ''));
const key = opt(args, '-s') + '|' + opt(args, '-a');
if (args[0] === 'find-generic-password') { if (!(key in db)) process.exit(44); process.stdout.write(db[key]); }
else if (args[0] === 'add-generic-password') { db[key] = Buffer.from(opt(args, '-X'), 'hex').toString('utf8'); fs.writeFileSync(f, JSON.stringify(db)); }
`, { mode: 0o755 });
  const user = os.userInfo().username;
  const hash = (dir) => crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  const spareDir = path.join(root, '.claude-pool-b'), outDir = path.join(root, '.claude-pool-a');
  fs.writeFileSync(items, JSON.stringify({
    [`Claude Code-credentials|${user}`]: JSON.stringify({ claudeAiOauth: { accessToken: 'at-A', refreshToken: 'rt-A' }, mcpOAuth: { x: 1 } }),
    [`Claude Code-credentials-${hash(spareDir)}|${user}`]: JSON.stringify({ claudeAiOauth: { accessToken: 'at-B', refreshToken: 'rt-B' } }),
  }));
  const out = inChild(root, `
    const main = { dir: path.join(HOME, '.claude'), isDefault: true };
    fs.mkdirSync(main.dir, { recursive: true });
    fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: account('A', 'a@x.com') }));
    const spare = { dir: path.join(HOME, '.claude-pool-b'), isDefault: false };
    fs.mkdirSync(spare.dir, { recursive: true });
    fs.writeFileSync(path.join(spare.dir, '.claude.json'), JSON.stringify({ oauthAccount: account('B', 'b@x.com') }));
    const outgoing = { dir: path.join(HOME, '.claude-pool-a'), isDefault: false };
    fs.mkdirSync(outgoing.dir, { recursive: true });
    const r = S.switchSignin(main, spare, outgoing, 'darwin');
    return { from: r.from.accountUuid, to: r.to.accountUuid, config: read(path.join(HOME, '.claude.json')).oauthAccount.accountUuid };
  `, { USER: user, CLAUDE_TRACKER_SECURITY: security });
  assert.deepEqual(out, { from: 'A', to: 'B', config: 'B' });
  const kc = JSON.parse(fs.readFileSync(items, 'utf8'));
  const item = (svc) => JSON.parse(kc[`${svc}|${user}`]);
  assert.equal(item('Claude Code-credentials').claudeAiOauth.refreshToken, 'rt-B');
  assert.deepEqual(item('Claude Code-credentials').mcpOAuth, { x: 1 }, "the profile's other tokens stay");
  assert.equal(item(`Claude Code-credentials-${hash(spareDir)}`).claudeAiOauth, undefined);
  assert.equal(item(`Claude Code-credentials-${hash(outDir)}`).claudeAiOauth.refreshToken, 'rt-A');
});

test('a lock Claude Code left behind is taken over once stale', () => {
  const root = scratch();
  const out = inChild(root, `
    const lock = path.join(HOME, 'p', '.storage-write.lock');
    fs.mkdirSync(lock, { recursive: true });
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    return { ran: S.withStorageLock(path.join(HOME, 'p'), () => fs.existsSync(lock)), after: fs.existsSync(lock) };
  `);
  assert.deepEqual(out, { ran: true, after: false }, 'held while it ran, released after');
});

test('pool add signs an account into a spare, and undoes a login that came back as someone else', () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'main', emailAddress: 'main@x.com' } }));
  const fake = path.join(root, 'claude');
  fs.writeFileSync(fake, `#!/bin/sh
case "$2" in
  login) printf '{"oauthAccount":{"accountUuid":"u-%s","emailAddress":"%s"}}' "$AS" "$AS" > "$CLAUDE_CONFIG_DIR/.claude.json"
         printf '{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt-%s"}}' "$AS" > "$CLAUDE_CONFIG_DIR/.credentials.json" ;;
esac
`, { mode: 0o755 });
  const add = (as, ...args) => spawnSync(process.execPath, [CLI, 'pool', 'add', ...args], {
    env: { ...process.env, HOME: root, CLAUDE_TRACKER_DIR: path.join(root, 'data'), CLAUDE_TRACKER_CLAUDE: fake, AS: as, CLAUDE_CONFIG_DIR: '', NO_COLOR: '1' },
    encoding: 'utf8', timeout: 60_000,
  });
  let r = add('someone@else.com', 'b@x.com', '--as', 'b');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /signed in as someone@else\.com, not b@x\.com, so that was undone/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude-pool-b', '.claude.json'), 'utf8')).oauthAccount, undefined);
  r = add('b@x.com', 'b@x.com', '--as', 'b');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /b@x\.com is a spare, in ~\/\.claude-pool-b/);
  r = add('main@x.com', 'main@x.com');
  assert.match(r.stdout, /is what ~\/\.claude is signed into now/, 'the account in use needs no spare yet');
});

test('two machines running low together take different spares when the best are equally free', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    const { machine } = await import('${SRC}replica.js');
    db().prepare("DELETE FROM utilization WHERE account_uuid IN ('B', 'C')").run();   // B and C both untouched: equally free
    reading('A', 'five_hour', 95, now + 3 * HOUR);
    const pick = () => F.plan(api.overview(), api.liveSessions()).entries[0].target.label;
    const alone = pick();
    // Another machine joins whose id sorts before this one's: this one takes the next turn.
    db().prepare("INSERT INTO sync_machines (machine_id, name) VALUES ('000000000000', 'other')").run();
    const second = pick();
    return { alone, second, me: machine().id > '000000000000' };
  `);
  assert.equal(out.me, true);
  assert.notEqual(out.alone, out.second, 'each machine its own turn');
  assert.deepEqual([out.alone, out.second].sort(), ['b@x.com', 'c@x.com']);
});

test('a preferred account is switched to while it has room, and the best by room after', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    reading('A', 'five_hour', 95, now + 3 * HOUR);
    const pick = () => { const t = F.plan(api.overview(), api.liveSessions()).entries[0].target; return t && [t.label, t.pinned]; };
    const byRoom = pick();
    const other = byRoom[0] === 'b@x.com' ? 'c@x.com' : 'b@x.com';
    F.setFailover({ prefer: other.toUpperCase() });
    const preferred = pick();
    // The pick runs low: back to choosing by room.
    db().prepare("UPDATE utilization SET pct = 92 WHERE account_uuid = ? AND limit_type = 'five_hour'").run(other === 'b@x.com' ? 'B' : 'C');
    const full = pick();
    F.setFailover({ prefer: null });
    return { byRoom, other, preferred, full, cleared: F.failoverSettings().prefer };
  `);
  assert.equal(out.byRoom[1], false);
  assert.deepEqual(out.preferred, [out.other, true]);
  assert.deepEqual(out.full, [out.byRoom[0], false]);
  assert.equal(out.cleared, null);
});

// Today's outage, as it happened: ~/.claude is switched to an account whose
// weekly window resets at the same hour as another's, fills it in minutes, and
// is refused. Its readings must count as its own, and failover must move on.
const SAME_RESET = `${SETUP}
  const week = now + 4 * 86400e3;
  // C has a week of history on this weekly window, from before; B's resets at the same hour.
  db().prepare("INSERT INTO utilization (ts, session_id, config_dir, account_uuid, limit_type, pct, resets_at) VALUES (?, 'old-c', '/elsewhere', 'C', 'seven_day', 60, ?)").run(now - 2 * 86400e3, week);
  db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, email, source) VALUES (?, ?, 'A', 'a@x.com', 'watch'), (?, ?, 'B', 'b@x.com', 'watch')")
    .run(now - 3 * HOUR, main, now - 20 * MIN, main);
  db().prepare("INSERT INTO switches (ts, profile, from_account, to_account, spare, status) VALUES (?, ?, 'A', 'B', 'x', 'switched')").run(now - 20 * MIN, main);
  // ~/.claude is on B now.
  const b = S.readSignin({ dir: path.join(HOME, '.claude-pool-b'), isDefault: false });
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: account('B', 'b@x.com'), userID: 'me' }));
  const own = (ts, type, pct, resetsAt, sid = 'sess-1') => db().prepare("INSERT INTO utilization (ts, session_id, config_dir, account_uuid, limit_type, pct, resets_at) VALUES (?, ?, ?, 'C', ?, ?, ?)").run(ts, sid, main, type, pct, resetsAt);
`;

test('a profile’s own readings say how full its account is, whatever account they were matched to', () => {
  const root = scratch();
  const out = inChild(root, `${SAME_RESET}
    own(now - 10 * MIN, 'seven_day', 19, week); own(now - 10 * MIN, 'five_hour', 95, now + 4 * HOUR);
    const A = await import('${SRC}accounts.js');
    A.attributeEvents({ all: true });
    const owner = db().prepare("SELECT account_uuid a FROM utilization WHERE session_id = 'sess-1' AND limit_type = 'five_hour'").get().a;
    F.setFailover({ mode: 'auto', at: 90 });
    const e = F.plan(api.overview(), api.liveSessions()).entries[0];
    return { owner, label: e.label, level: e.level, measured: e.measured, due: e.due };
  `);
  assert.equal(out.owner, 'B', 'read in a profile watched on B for 10 minutes: B’s, not C’s');
  assert.deepEqual([out.label, Math.round(out.level), out.measured, out.due], ['b@x.com', 95, true, true]);
});

test('refused right after a switch, it switches again at once, never back to the spent account, and past a spare that fails', () => {
  const root = scratch();
  const out = inChild(root, `${SAME_RESET}
    // A third spare, D, to fall back on.
    db().prepare("INSERT INTO accounts (account_uuid, email, last_seen) VALUES ('D', 'd@x.com', ?)").run(now);
    const d = F.makeSpare('d@x.com');
    S.writeSignin(d, { oauth: token('D'), account: account('D', 'd@x.com') });
    db().prepare("INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status, config_dir) VALUES (?, 'sess-1', 'C', 'five_hour', ?, 'rejected', ?)")
      .run(now - 5 * MIN, Math.round((now + 4 * HOUR) / 1000), main);
    (await import('${SRC}accounts.js')).attributeEvents({ all: true });
    F.setFailover({ mode: 'auto', at: 90 });
    const p = F.plan(api.overview(), api.liveSessions()).entries[0];
    // The first choice's spare has lost its token, though it still names its account: the next one is used.
    fs.rmSync(path.join(p.target.dir, '.credentials.json'));
    const made = F.runFailover(api.overview(), api.liveSessions());
    const now2 = F.plan(api.overview(), api.liveSessions());
    return {
      first: [p.label, p.out, p.due, p.target.label, p.then.map((t) => t.label)],
      made: made.map((m) => m.status),
      on: read(path.join(HOME, '.claude.json')).oauthAccount.emailAddress,
      spentB: !now2.entries[0].then.concat(now2.entries[0].target ?? []).some((t) => t.label === 'b@x.com'),
    };
  `);
  assert.equal(out.first[0], 'b@x.com');
  assert.equal(out.first[1], true, 'refused in the profile: out');
  assert.equal(out.first[2], true);
  assert.deepEqual(out.made, ['failed', 'switched'], 'the next spare is tried when one fails');
  assert.notEqual(out.on, 'b@x.com');
  assert.equal(out.spentB, true, 'B is not offered again before it resets');
});

test('room on a bigger plan counts for more, and it says when another account is needed', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    reading('A', 'five_hour', 95, now + 3 * HOUR);
    // B: 80% free on a Max 20x. C: untouched, but a small plan.
    db().prepare("UPDATE accounts SET rate_limit_tier = 'default_claude_max_20x' WHERE account_uuid = 'B'").run();
    db().prepare("DELETE FROM utilization WHERE account_uuid = 'C'").run();
    const big = F.plan(api.overview(), api.liveSessions()).entries[0].target.label;
    // Both spares full: nothing to switch to, and a notice saying what to do.
    db().prepare("UPDATE utilization SET pct = 99 WHERE account_uuid = 'B' AND limit_type = 'five_hour'").run();
    reading('C', 'five_hour', 99, now + 3 * HOUR);
    const p = F.plan(api.overview(), api.liveSessions());
    return { big, target: p.entries[0].target, notices: p.notices };
  `);
  assert.equal(out.big, 'b@x.com');
  assert.equal(out.target, null);
  assert.equal(out.notices[0].level, 'bad');
  assert.match(out.notices[0].fix, /claude-tracker pool add/);
});

test('when every account is nearly used up, each runs to the end before the next', () => {
  const root = scratch();
  const out = inChild(root, `${SETUP}
    // B has 12% left, C 7%: neither has the room a switch at 90% wants.
    db().prepare("UPDATE utilization SET pct = 88 WHERE account_uuid = 'B' AND limit_type = 'five_hour'").run();
    db().prepare("UPDATE utilization SET pct = 93 WHERE account_uuid = 'C' AND limit_type = 'five_hour'").run();
    F.setFailover({ mode: 'auto', at: 90 });
    const at = (pct) => {
      db().prepare("DELETE FROM utilization WHERE account_uuid = 'A'").run();
      reading('A', 'five_hour', pct, now + 3 * HOUR);
      const e = F.plan(api.overview(), api.liveSessions()).entries[0];
      return [e.at, e.due, e.target?.label ?? null, e.then.map((t) => t.label)];
    };
    return { at92: at(92), at98: at(98), at97: at(97), notice: F.plan(api.overview(), api.liveSessions()).notices[0] };
  `);
  assert.deepEqual(out.at92, [98, false, 'b@x.com', []], 'past 90%, it keeps going; C has less left than A');
  assert.deepEqual(out.at97, [98, false, 'b@x.com', ['c@x.com']], 'once A has less left than C, C is next after B');
  assert.deepEqual(out.at98, [98, true, 'b@x.com', ['c@x.com']], 'at 98% it moves to the one with the most left');
  assert.equal(out.notice.level, 'bad');
  assert.match(out.notice.text, /nearly used up/);
});
