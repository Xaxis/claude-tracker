import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the tracker at a scratch database before anything imports it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tracker-test-'));
process.env.CLAUDE_TRACKER_DIR = TMP;
process.env.NO_COLOR = '1';

const { db, closeDb } = await import('../src/db.js');
const { costOf, modelInfo, modelLabel } = await import('../src/pricing.js');
const { buildWindows, currentWindow, FIVE_HOUR, SEVEN_DAY } = await import('../src/windows.js');
const { calibrateAll, capacityFor } = await import('../src/calibrate.js');
const { attributeSessions, attributeEvents } = await import('../src/accounts.js');

process.on('exit', () => {
  try { closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const HOUR = 3600_000;
const MIN = 60_000;

function reset() {
  const d = db();
  for (const t of ['events', 'sessions', 'accounts', 'limit_events', 'calibration', 'account_observations', 'files', 'identity_points', 'utilization', 'notifications']) {
    d.exec(`DELETE FROM ${t}`);
  }
}

let seq = 0;
function addEvent(sessionId, ts, cost) {
  // Calls carry their own account; in these fixtures it is the session's.
  const acct = db().prepare('SELECT account_uuid a FROM sessions WHERE session_id = ?').get(sessionId)?.a ?? null;
  db().prepare(`INSERT INTO events (call_id, ts, session_id, model, cost_usd, account_uuid) VALUES (?,?,?,?,?,?)`)
    .run(`e${seq++}`, ts, sessionId, 'claude-opus-5', cost, acct);
}
function addSession(sessionId, firstTs, account, source = 'bridge') {
  db().prepare(`INSERT INTO sessions (session_id, first_ts, last_ts, account_uuid, account_source)
                VALUES (?,?,?,?,?)`).run(sessionId, firstTs, firstTs, account, source);
}
function addAccount(uuid, tier = null) {
  db().prepare('INSERT INTO accounts (account_uuid, rate_limit_tier) VALUES (?,?)').run(uuid, tier);
}
function addRejection(account, type, atTs, resetsAtSec, session = 's1') {
  db().prepare(`INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status)
                VALUES (?,?,?,?,?, 'rejected')`).run(atTs, session, account, type, resetsAtSec);
}

/* ------------------------------------------------------------------ pricing */

test('pricing uses the right per-model rates', () => {
  // 1M input on Opus 5 is $5; 1M output is $25.
  assert.equal(costOf('claude-opus-5', { input: 1_000_000 }), 5);
  assert.equal(costOf('claude-opus-5', { output: 1_000_000 }), 25);
  // Cache: 5m write is 1.25x input, 1h write is 2x, read is 0.1x.
  assert.equal(costOf('claude-opus-5', { cacheWrite5m: 1_000_000 }), 6.25);
  assert.equal(costOf('claude-opus-5', { cacheWrite1h: 1_000_000 }), 10);
  assert.equal(costOf('claude-opus-5', { cacheRead: 1_000_000 }), 0.5);
  // Sonnet 5 and Haiku 4.5 are cheaper tiers.
  assert.equal(costOf('claude-sonnet-5', { input: 1_000_000 }), 2);
  assert.equal(costOf('claude-haiku-4-5-20251001', { output: 1_000_000 }), 5);
});

test('context-window suffixes do not change the rate', () => {
  assert.equal(costOf('claude-opus-5[1m]', { input: 1_000_000 }), costOf('claude-opus-5', { input: 1_000_000 }));
  assert.equal(modelLabel('claude-opus-5[1m]'), 'Opus 5');
});

test('an unknown model still produces a finite cost', () => {
  const info = modelInfo('claude-something-new');
  assert.equal(info.known, false);
  assert.ok(Number.isFinite(costOf('claude-something-new', { input: 1000, output: 1000 })));
});

/* ------------------------------------------------------------------ windows */

test('a window opens on the 10-minute boundary at or before first use', () => {
  const t = Date.UTC(2026, 8, 10, 12, 26, 30);   // 12:26:30
  const [w] = buildWindows([{ ts: t, cost: 1 }], 'five_hour');
  assert.equal(new Date(w.start).getUTCMinutes(), 20);
  assert.equal(new Date(w.start).getUTCSeconds(), 0);
  assert.equal(w.end - w.start, FIVE_HOUR);
});

test('usage inside a window stays in it; usage after it opens a new one', () => {
  const t0 = Date.UTC(2026, 8, 10, 12, 0, 0);
  const windows = buildWindows([
    { ts: t0, cost: 1 },
    { ts: t0 + 4 * HOUR, cost: 2 },          // still inside the 5h window
    { ts: t0 + 6 * HOUR, cost: 4 },          // after it lapsed -> new window
  ], 'five_hour');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].cost, 3);
  assert.equal(windows[1].cost, 4);
});

test('an idle gap does not create empty windows', () => {
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  const windows = buildWindows([
    { ts: t0, cost: 1 },
    { ts: t0 + 80 * HOUR, cost: 1 },         // days later
  ], 'five_hour');
  assert.equal(windows.length, 2);
});

test('the seven-day window spans seven days', () => {
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  const [w] = buildWindows([{ ts: t0, cost: 1 }], 'seven_day');
  assert.equal(w.end - w.start, SEVEN_DAY);
});

test('a reported reset time overrides the reconstructed window', () => {
  reset();
  const now = Date.now();
  // Reset times arrive as whole seconds, so align the fixture to a second.
  const resetsAt = Math.floor((now + 2 * HOUR) / 1000) * 1000;
  addAccount('acct-a');
  addSession('s1', now - 10 * HOUR, 'acct-a');
  addRejection('acct-a', 'five_hour', now - HOUR, Math.floor(resetsAt / 1000));
  // Usage both inside and before the authoritative window.
  addEvent('s1', resetsAt - FIVE_HOUR - HOUR, 99);   // before the window: excluded
  addEvent('s1', resetsAt - FIVE_HOUR + MIN, 7);     // inside: counted
  addEvent('s1', now - MIN, 3);                      // inside: counted

  const w = currentWindow('acct-a', 'five_hour', now);
  assert.equal(w.authoritative, true);
  assert.equal(w.end, resetsAt);
  assert.equal(w.cost, 10, 'only usage inside the reported window counts');
});

/* -------------------------------------------------------------- calibration */

test('capacity is measured from usage up to the refusal, not the whole window', () => {
  reset();
  const resetsAt = Date.UTC(2026, 8, 5, 15, 0, 0);
  const start = resetsAt - FIVE_HOUR;
  const rejectedAt = resetsAt - HOUR;        // refused an hour before reset
  addAccount('acct-a');
  addAccount('acct-b');
  addSession('sa', start, 'acct-a');
  addSession('sb', start, 'acct-b');

  addEvent('sa', start + MIN, 40);           // counts toward acct-a's ceiling
  addEvent('sa', rejectedAt - MIN, 20);      // counts
  // After the refusal the user switched to acct-b; that must not inflate acct-a.
  addEvent('sb', rejectedAt + MIN, 500);

  addRejection('acct-a', 'five_hour', rejectedAt, Math.floor(resetsAt / 1000), 'sa');
  calibrateAll();

  const cap = capacityFor('acct-a', 'five_hour');
  assert.equal(cap.capacity, 60, 'capacity is the pre-refusal total only');
  assert.equal(cap.confidence, 'partial', 'one sample is only partial confidence');
});

test('an account with no rejection inherits a measured ceiling, not a constant', () => {
  reset();
  const resetsAt = Date.UTC(2026, 8, 5, 15, 0, 0);
  const start = resetsAt - FIVE_HOUR;
  addAccount('measured-1', 'tier-x');
  addAccount('never-limited', 'tier-x');
  addSession('sm', start, 'measured-1');
  addEvent('sm', start + MIN, 123);
  addRejection('measured-1', 'five_hour', resetsAt - MIN, Math.floor(resetsAt / 1000), 'sm');

  calibrateAll();
  const cap = capacityFor('never-limited', 'five_hour');
  assert.equal(cap.capacity, 123);
  assert.equal(cap.confidence, 'tier');
});

/* ------------------------------------------------------------- attribution */

test('a session between two agreeing anchors is inferred', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  addAccount('acct-a');
  addSession('anchor-1', t0, 'acct-a', 'bridge');
  addSession('anchor-2', t0 + 10 * HOUR, 'acct-a', 'bridge');
  addSession('unknown', t0 + 5 * HOUR, null, null);

  attributeSessions();
  const row = db().prepare('SELECT account_uuid, account_source FROM sessions WHERE session_id = ?').get('unknown');
  assert.equal(row.account_uuid, 'acct-a');
  assert.equal(row.account_source, 'inferred');
});

test('anchors that disagree leave the session unattributed rather than guessing', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  addAccount('acct-a');
  addAccount('acct-b');
  addSession('anchor-a', t0, 'acct-a', 'bridge');
  addSession('anchor-b', t0 + 10 * HOUR, 'acct-b', 'bridge');
  addSession('unknown', t0 + 5 * HOUR, null, null);

  attributeSessions();
  const row = db().prepare('SELECT account_uuid FROM sessions WHERE session_id = ?').get('unknown');
  assert.equal(row.account_uuid, null);
});

test('usage is never attributed to an account that was rate limited at the time', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  const blockedFrom = t0 + 2 * HOUR;
  const blockedUntil = t0 + 9 * HOUR;
  addAccount('acct-a');
  addAccount('acct-b');
  // Both surrounding anchors say acct-a, but acct-a was refused service then.
  addSession('anchor-1', t0, 'acct-a', 'bridge');
  addSession('anchor-2', t0 + 10 * HOUR, 'acct-a', 'bridge');
  addSession('anchor-b', t0 + 20 * HOUR, 'acct-b', 'bridge');
  addSession('unknown', t0 + 5 * HOUR, null, null);
  addRejection('acct-a', 'five_hour', blockedFrom, Math.floor(blockedUntil / 1000), 'anchor-1');

  attributeSessions();
  const row = db().prepare('SELECT account_uuid FROM sessions WHERE session_id = ?').get('unknown');
  assert.notEqual(row.account_uuid, 'acct-a');
});

test('bridge attribution is authoritative and never overwritten', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  addAccount('acct-a');
  addAccount('acct-b');
  addSession('anchor-1', t0, 'acct-b', 'bridge');
  addSession('fixed', t0 + HOUR, 'acct-a', 'bridge');
  addSession('anchor-2', t0 + 2 * HOUR, 'acct-b', 'bridge');

  attributeSessions();
  const row = db().prepare('SELECT account_uuid, account_source FROM sessions WHERE session_id = ?').get('fixed');
  assert.equal(row.account_uuid, 'acct-a');
  assert.equal(row.account_source, 'bridge');
});

/* ------------------------------------------------------------------ billing */

const { billingPeriod } = await import('../src/billing.js');

test('the billing period is projected forward from the subscription start', () => {
  const start = '2026-01-15T10:00:00Z';
  const now = Date.parse('2026-09-20T00:00:00Z');
  const p = billingPeriod(start, 'month', now);
  // The 15th is the anchor, so the period in force on the 20th ends next month.
  assert.equal(new Date(p.end).getDate(), 15);
  assert.ok(p.end > now, 'the period end is in the future');
  assert.ok(p.start <= now, 'the period has already started');
  assert.ok(p.percentElapsed > 0 && p.percentElapsed < 100);
});

test('a subscription that starts on the 31st bills on short months too', () => {
  // February has no 31st; billing lands on the last day rather than skipping.
  const p = billingPeriod('2026-01-31T00:00:00Z', 'month', Date.parse('2026-02-10T00:00:00Z'));
  const end = new Date(p.end);
  assert.equal(end.getMonth(), 1, 'ends in February');
  assert.equal(end.getDate(), 28, 'clamped to the last day of the month');
});

test('an annual cycle advances a year at a time', () => {
  const p = billingPeriod('2024-03-05T00:00:00Z', 'year', Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(new Date(p.end).getFullYear(), 2027);
  assert.equal(new Date(p.end).getMonth(), 2);
});

test('a period is always reported as an estimate', () => {
  const p = billingPeriod('2026-01-15T10:00:00Z', 'month', Date.parse('2026-09-20T00:00:00Z'));
  assert.equal(p.estimated, true);
  assert.match(p.assumption, /projected from the subscription start/);
});

test('a missing or unparseable start date yields no period', () => {
  assert.equal(billingPeriod(null), null);
  assert.equal(billingPeriod('not a date'), null);
});

/* ------------------------------------------------- profile-based attribution */

test('a session is attributed to whoever was signed into its profile', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  addAccount('work');
  addAccount('personal');
  // Two profiles, each with its own signed-in account.
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, source)
                VALUES (?,?,?,'backup')`).run(t0, '/home/me/.claude-work', 'work');
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, source)
                VALUES (?,?,?,'backup')`).run(t0, '/home/me/.claude-personal', 'personal');

  db().prepare(`INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)`)
    .run('s-work', t0 + 5 * HOUR, t0 + 5 * HOUR, '/home/me/.claude-work');
  db().prepare(`INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)`)
    .run('s-personal', t0 + 5 * HOUR, t0 + 5 * HOUR, '/home/me/.claude-personal');

  attributeSessions();
  const w = db().prepare('SELECT account_uuid, account_source FROM sessions WHERE session_id = ?').get('s-work');
  const p = db().prepare('SELECT account_uuid, account_source FROM sessions WHERE session_id = ?').get('s-personal');
  assert.equal(w.account_uuid, 'work');
  assert.equal(w.account_source, 'profile');
  assert.equal(p.account_uuid, 'personal', 'concurrent profiles do not bleed into each other');
});

test('a profile that changed accounts attributes by date, not by latest', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  const dir = '/home/me/.claude';
  addAccount('old');
  addAccount('new');
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, source)
                VALUES (?,?,?,'backup')`).run(t0, dir, 'old');
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, source)
                VALUES (?,?,?,'backup')`).run(t0 + 10 * HOUR, dir, 'new');

  for (const [id, at] of [['before', t0 + 2 * HOUR], ['after', t0 + 20 * HOUR]]) {
    db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)')
      .run(id, at, at, dir);
  }
  attributeSessions();
  assert.equal(db().prepare('SELECT account_uuid a FROM sessions WHERE session_id=?').get('before').a, 'old');
  assert.equal(db().prepare('SELECT account_uuid a FROM sessions WHERE session_id=?').get('after').a, 'new');
});

/* ------------------------------------------------- one response, one charge */

test('a multi-block response is billed once, not once per content block', async () => {
  reset();
  // Claude Code writes one JSONL line per content block, each repeating the
  // SAME usage totals. Counting per line inflated real usage by ~2x overall.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-profile-'));
  const proj = path.join(root, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');

  const usage = {
    input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 500_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  };
  const blocks = ['text', 'tool_use', 'tool_use', 'thinking'];
  const lines = blocks.map((b, i) => JSON.stringify({
    type: 'assistant', uuid: `line-${i}`, timestamp: '2026-09-01T10:00:00.000Z',
    sessionId: 'sess-1', requestId: 'req_same', cwd: '/tmp/demo',
    message: { id: 'msg_same', model: 'claude-opus-5', content: [{ type: b }], usage },
  }));
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), lines.join('\n') + '\n');

  const { ingestAll } = await import('../src/ingest.js');
  await ingestAll({ profiles: [{ dir: root, name: 'demo', projectsDir: path.join(root, 'projects') }] });

  const row = db().prepare('SELECT COUNT(*) n, SUM(cache_read) cr FROM events').get();
  assert.equal(row.n, 1, `${blocks.length} lines are one API response`);
  assert.equal(row.cr, 500_000, 'usage counted once, not multiplied by block count');
  fs.rmSync(root, { recursive: true, force: true });
});

test('history is never attributed backwards to a newly signed-in account', () => {
  reset();
  const dir = '/home/me/.claude';
  const july = Date.UTC(2026, 6, 1);
  const today = Date.UTC(2026, 8, 10, 10, 0);
  addAccount('old-account');
  addAccount('just-logged-in');

  // Config backups rotate, so the only snapshot left is from minutes ago.
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, source)
                VALUES (?,?,?,'backup')`).run(today, dir, 'just-logged-in');
  // But a bridge-attributed session proves who was using the profile in July.
  db().prepare(`INSERT INTO sessions (session_id, first_ts, last_ts, config_dir, account_uuid, account_source)
                VALUES (?,?,?,?,?, 'bridge')`).run('known', july, july, dir, 'old-account');
  // The session under test predates the surviving snapshot.
  db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)')
    .run('old-work', july + HOUR, july + HOUR, dir);

  attributeSessions();
  const got = db().prepare('SELECT account_uuid a FROM sessions WHERE session_id=?').get('old-work').a;
  assert.notEqual(got, 'just-logged-in', 'July usage must not land on an account that appeared in September');
  assert.equal(got, 'old-account');
});


/* ------------------------------------------------------ per-call attribution */

function rawEvent(id, sessionId, ts, configDir) {
  db().prepare(`INSERT INTO events (call_id, ts, session_id, model, cost_usd, config_dir)
                VALUES (?,?,?,'claude-opus-5',1,?)`).run(id, ts, sessionId, configDir);
}
const acctOf = (id) => db().prepare('SELECT account_uuid a FROM events WHERE call_id = ?').get(id).a;

test('a session that follows a /login bills each account for its own part', () => {
  reset();
  const dir = '/home/me/.claude';
  const t0 = Date.UTC(2026, 8, 11, 13, 0);
  const sw = t0 + 3 * HOUR;                      // the /login
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('old', 'old@x.com'), ('new', 'new@x.com')").run();
  db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)').run('s', t0, sw + HOUR, dir);
  // The running session writes a context record at start, and again at the switch.
  db().prepare("INSERT INTO identity_points (session_id, ts, email, source) VALUES ('s', ?, 'old@x.com', 'context')").run(t0);
  db().prepare("INSERT INTO identity_points (session_id, ts, email, source) VALUES ('s', ?, 'new@x.com', 'context')").run(sw);
  rawEvent('before', 's', sw - MIN, dir);
  rawEvent('after', 's', sw + MIN, dir);

  attributeEvents({ all: true });
  assert.equal(acctOf('before'), 'old');
  assert.equal(acctOf('after'), 'new', 'calls after the switch must not stay on the old account');
});

test('a background job keeps its own account when the profile switches', () => {
  reset();
  const dir = '/home/me/.claude';
  const t0 = Date.UTC(2026, 8, 11, 13, 0);
  const sw = t0 + HOUR;
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('old', 'old@x.com'), ('new', 'new@x.com')").run();
  // The profile moved to the new account...
  db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, source) VALUES (?, ?, 'old', 'watch')").run(t0, dir);
  db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, source) VALUES (?, ?, 'new', 'watch')").run(sw, dir);
  // The tracker was watching, so it left a heartbeat every few minutes.
  db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, source) VALUES (?, ?, 'new', 'watch')").run(sw + 30 * MIN, dir);
  // ...but the job's own transcript still says the old one after the switch.
  db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)').run('job', t0, sw + HOUR, dir);
  db().prepare("INSERT INTO identity_points (session_id, ts, email, source) VALUES ('job', ?, 'old@x.com', 'context')").run(sw + 30 * MIN);
  rawEvent('job-call', 'job', sw + 40 * MIN, dir);
  // An ordinary session with no records of its own follows the profile.
  db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)').run('plain', sw, sw + HOUR, dir);
  rawEvent('plain-call', 'plain', sw + 40 * MIN, dir);

  attributeEvents({ all: true });
  assert.equal(acctOf('job-call'), 'old', "the session's own record outranks the profile");
  assert.equal(acctOf('plain-call'), 'new');
});

/* --------------------------------------------------------- schema rebuilds */

test('account rows survive a schema rebuild', async () => {
  // Plan tier and subscription dates come from config snapshots that rotate
  // away within hours; a rebuild that drops them loses them for good.
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rebuild-'));
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const run = (code) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code],
    { env: { ...process.env, CLAUDE_TRACKER_DIR: dir }, encoding: 'utf8' });

  let r = run(`const { db } = await import('${dbUrl}');
    db().prepare("INSERT INTO accounts (account_uuid, email, rate_limit_tier, subscription_at, label) VALUES ('keep', 'k@x.com', 'max_20x', '2026-09-10T12:00:00Z', 'mine')").run();
    db().prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();`);
  assert.equal(r.status, 0, r.stderr);

  // Reopening at an older version forces a rebuild.
  r = run(`const { db } = await import('${dbUrl}');
    const row = db().prepare("SELECT email, rate_limit_tier, subscription_at, label FROM accounts WHERE account_uuid = 'keep'").get();
    const v = db().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
    console.log(JSON.stringify({ row, rebuilt: v !== '1' }));`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.rebuilt, true, 'the rebuild actually ran');
  assert.deepEqual({ ...out.row }, { email: 'k@x.com', rate_limit_tier: 'max_20x', subscription_at: '2026-09-10T12:00:00Z', label: 'mine' });
  fs.rmSync(dir, { recursive: true, force: true });
});


/* ------------------------------------------------------ refusals as evidence */

const point = (sid, ts, { account = null, email = null, source }) =>
  db().prepare('INSERT INTO identity_points (session_id, ts, email, account_uuid, source) VALUES (?,?,?,?,?)').run(sid, ts, email, account, source);
const session = (sid, t0, dir) =>
  db().prepare('INSERT INTO sessions (session_id, first_ts, last_ts, config_dir) VALUES (?,?,?,?)').run(sid, t0, t0 + 6 * HOUR, dir);
const refuse = (sid, ts, resetsAtMs, type = 'five_hour') =>
  db().prepare("INSERT INTO limit_events (ts, session_id, limit_type, resets_at, status) VALUES (?,?,?,?, 'rejected')")
    .run(ts, sid, type, Math.floor(resetsAtMs / 1000));

test('sessions refused together are on one account, whatever stale records say', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0);
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  for (const s of ['s1', 's2', 's3']) session(s, t0, '/home/me/.claude');
  point('s1', t0, { account: 'A', source: 'bridge' });
  point('s2', t0, { account: 'A', source: 'bridge' });
  point('s3', t0, { account: 'B', source: 'bridge' });                 // stale
  point('s3', t0 + HOUR, { email: 'a@x.com', source: 'context' });     // its own signed-in record
  for (const s of ['s1', 's2', 's3']) refuse(s, t0 + 2 * HOUR, t0 + 5 * HOUR);
  attributeEvents({ all: true });
  assert.deepEqual(db().prepare('SELECT DISTINCT account_uuid a FROM limit_events').all().map((r) => r.a), ['A']);
});

test('calls made while an account was refused belong to the account the session moved to', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('s', t0, dir);
  point('s', t0, { account: 'A', source: 'bridge' });                  // the bridge keeps saying A
  refuse('s', t0 + HOUR, t0 + 5 * HOUR);                               // A is refused...
  point('s', t0 + 3 * HOUR, { email: 'b@x.com', source: 'context' });  // ...and the session is next seen on B
  rawEvent('before', 's', t0 + 30 * MIN, dir);
  rawEvent('during', 's', t0 + 2 * HOUR, dir);
  rawEvent('after', 's', t0 + 4 * HOUR, dir);
  attributeEvents({ all: true });
  assert.equal(acctOf('before'), 'A');
  assert.equal(acctOf('during'), 'B', 'A could not serve anything between its refusal and reset');
  assert.equal(acctOf('after'), 'B');
});

test('an account never holds two overlapping windows of the same kind', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0);
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('s1', t0, '/d1'); session('s2', t0, '/d2'); session('s3', t0, '/d3');
  point('s1', t0, { email: 'a@x.com', source: 'context' });
  refuse('s1', t0 + HOUR, t0 + 5 * HOUR);                              // A's window: t0 .. t0+5h
  point('s2', t0, { account: 'A', source: 'bridge' });
  point('s3', t0, { account: 'B', source: 'bridge' });
  refuse('s2', t0 + 2 * HOUR, t0 + 6 * HOUR);                          // overlaps A's window,
  refuse('s3', t0 + 2 * HOUR, t0 + 6 * HOUR);                          // so it cannot be A's too
  attributeEvents({ all: true });
  const owner = (sid) => db().prepare('SELECT account_uuid a FROM limit_events WHERE session_id = ?').get(sid).a;
  assert.equal(owner('s1'), 'A');
  assert.equal(owner('s2'), 'B');
  assert.equal(owner('s3'), 'B');
});

test('every row survives a schema upgrade, not just account details', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-upgrade-'));
  const dbUrl = new URL('../src/db.js', import.meta.url).href;
  const run = (code) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code],
    { env: { ...process.env, CLAUDE_TRACKER_DIR: dir }, encoding: 'utf8' });
  let r = run(`const { db } = await import('${dbUrl}');
    db().prepare("INSERT INTO events (call_id, ts, cost_usd) VALUES ('kept', 1, 2.5)").run();
    db().prepare("INSERT INTO limit_events (ts, limit_type, resets_at, status) VALUES (1, 'five_hour', 99, 'rejected')").run();
    db().prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();`);
  assert.equal(r.status, 0, r.stderr);
  r = run(`const { db } = await import('${dbUrl}');
    console.log(JSON.stringify({ e: db().prepare("SELECT cost_usd c FROM events WHERE call_id = 'kept'").get(),
      l: db().prepare('SELECT COUNT(*) n FROM limit_events').get().n,
      idx: db().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").get().n }));`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.e?.c, 2.5, 'history the transcripts may no longer hold is kept');
  assert.equal(out.l, 1);
  assert.ok(out.idx >= 4, 'indexes are rebuilt on the new table');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------- exact utilization */

test('status-line readings become utilization samples, once per change', async () => {
  reset();
  const { ingestLive, LIVE_DIR } = await import('../src/live.js');
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const base = Date.now();
  const snap = (pct, dt) => fs.writeFileSync(path.join(LIVE_DIR, 'sess-x.json'), JSON.stringify({
    ts: base + dt, session_id: 'sess-x', config_dir: '/home/me/.claude', account_uuid: 'A',
    rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(base / 1000) + 3600 } } }));
  snap(40, 0); ingestLive(); snap(40, 1000); ingestLive(); snap(41.5, 2000); ingestLive();
  const rows = db().prepare("SELECT pct, account_uuid FROM utilization WHERE session_id = 'sess-x' ORDER BY ts").all();
  assert.deepEqual(rows.map((r) => r.pct), [40, 41.5], 'an unchanged reading is not stored again');
  assert.equal(rows[0].account_uuid, 'A');
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
});

test('a bar anchors to the exact reading and moves with calls made since', async () => {
  reset();
  const { overview } = await import('../src/api.js');
  const now = Date.now();
  db().prepare("INSERT INTO accounts (account_uuid, email, last_seen) VALUES ('A', 'a@x.com', ?)").run(now);
  const reading = now - 10 * MIN;
  db().prepare(`INSERT INTO utilization (ts, session_id, account_uuid, limit_type, pct, resets_at)
                VALUES (?, 'sx', 'A', 'five_hour', 50, ?)`).run(reading, now + 2 * HOUR);
  const call = (id, ts, cost) => db().prepare('INSERT INTO events (call_id, ts, session_id, cost_usd, account_uuid) VALUES (?,?,?,?,?)').run(id, ts, 'sx', cost, 'A');
  call('c1', reading - 30 * MIN, 10);   // $10 had bought 50% -> $0.20 a point
  call('c2', reading + 5 * MIN, 5);     // $5 since -> another 25 points
  const a = overview(now).accounts.find((x) => x.accountUuid === 'A');
  const l = a.limits.find((x) => x.type === 'five_hour');
  assert.equal(l.confidence, 'exact');
  assert.ok(Math.abs(l.percent - 75) < 0.5, `expected ~75%, got ${l.percent}`);
  assert.equal(l.end, now + 2 * HOUR, 'the reset time is the one Claude Code reported');
});

test('an old sighting does not claim a profile for months', () => {
  reset();
  const dir = '/home/me/.claude', april = Date.UTC(2026, 3, 9);
  db().prepare("INSERT INTO accounts (account_uuid) VALUES ('old'), ('A')").run();
  db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, source) VALUES (?, ?, 'old', 'backup')").run(april, dir);
  const later = april + 150 * 86400e3;
  session('s', later, dir);
  point('s', later, { account: 'A', source: 'bridge' });
  rawEvent('c', 's', later + HOUR, dir);
  attributeEvents({ all: true });
  assert.equal(acctOf('c'), 'A', 'a lone April snapshot knows nothing about September');
});

test('a session refused seconds after the others still moves on at the reset', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('first', t0, dir); session('late', t0, dir);
  point('first', t0, { email: 'a@x.com', source: 'context' });
  refuse('first', t0 + HOUR, t0 + 2 * HOUR);                 // the group's first refusal
  refuse('late', t0 + HOUR + 20_000, t0 + 2 * HOUR);          // this session, 20s later
  point('late', t0 + 3 * HOUR, { email: 'b@x.com', source: 'context' });
  rawEvent('meanwhile', 'first', t0 + 1.5 * HOUR, dir);      // the profile carried on without A
  rawEvent('after-reset', 'late', t0 + 2.5 * HOUR, dir);
  attributeEvents({ all: true });
  assert.equal(acctOf('after-reset'), 'B');
});

test('the watcher leaves a heartbeat, not just changes', async () => {
  reset();
  const { observeAccount } = await import('../src/accounts.js');
  const t0 = Date.UTC(2026, 8, 11, 12, 0), acct = { accountUuid: 'A', configDir: '/home/me/.claude' };
  observeAccount(acct, t0); observeAccount(acct, t0 + 5 * MIN); observeAccount(acct, t0 + 12 * MIN);
  assert.equal(db().prepare('SELECT COUNT(*) n FROM account_observations').get().n, 2);
});

test('the calls leading up to a refusal belong to the refused account', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('s1', t0 - 6 * HOUR, dir); session('s2', t0 - 6 * HOUR, dir);
  point('s1', t0 - 6 * HOUR, { email: 'a@x.com', source: 'context' });
  point('s2', t0 - 6 * HOUR, { account: 'B', source: 'bridge' });    // stale all along
  refuse('s1', t0 + HOUR, t0 + 5 * HOUR);                              // A's window opened at t0
  refuse('s2', t0 + HOUR, t0 + 5 * HOUR);
  rawEvent('pre-window', 's2', t0 - HOUR, dir);
  rawEvent('in-window', 's2', t0 + 30 * MIN, dir);
  attributeEvents({ all: true });
  assert.equal(acctOf('in-window'), 'A', 'refused on A, so its calls inside that window were A');
  assert.equal(acctOf('pre-window'), 'B');
});

test('a session that waits out its limit carries on with the same account', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 9, 2, 30), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('s', t0, dir); session('later', t0 + 6 * HOUR, dir);
  point('s', t0, { account: 'A', source: 'bridge' });
  point('later', t0 + 6 * HOUR, { account: 'B', source: 'bridge' });
  rawEvent('opened', 's', t0 + 5 * MIN, dir);
  refuse('s', t0 + 4 * HOUR, t0 + 5 * HOUR);                   // A is full until t0+5h
  rawEvent('in-flight', 's', t0 + 4 * HOUR + 5_000, dir);       // answered just after the refusal
  rawEvent('resumed', 's', t0 + 5 * HOUR + 5 * MIN, dir);       // nothing ran in between
  attributeEvents({ all: true });
  assert.equal(acctOf('in-flight'), 'A');
  assert.equal(acctOf('resumed'), 'A', 'no call ran during the block, so the session waited for A');
});

test('a five-hour window cannot open on an account that hit its weekly limit', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 9, 22, 0), dir = '/home/me/.claude', DAY = 86400e3;
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('old', t0 - 7 * DAY, dir); session('s', t0 - 3 * DAY, dir);
  point('old', t0 - 7 * DAY, { account: 'B', source: 'bridge' });  // B was used here before
  point('s', t0 - 3 * DAY, { account: 'A', source: 'bridge' });    // this bridge keeps naming A
  refuse('s', t0, t0 + 5 * DAY, 'seven_day');                      // A is out for the week...
  rawEvent('after', 's', t0 + 15 * MIN, dir);                       // ...yet the session carried on
  refuse('s', t0 + 3 * HOUR, t0 + 5 * HOUR + 10 * MIN);             // until a window opened at t0+10m filled
  attributeEvents({ all: true });
  const owner = db().prepare("SELECT account_uuid a FROM limit_events WHERE limit_type = 'five_hour'").get().a;
  assert.equal(owner, 'B', 'A could not have opened a window while out for the week');
  assert.equal(acctOf('after'), 'B');
});

test('every session in a profile follows a /login typed into any one of them', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 10, 12, 0), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  session('here', t0, dir); session('other', t0, dir);
  point('here', t0, { email: 'a@x.com', source: 'context' });
  point('other', t0, { email: 'a@x.com', source: 'context' });
  point('here', t0 + HOUR, { email: 'b@x.com', source: 'context' });  // the /login, recorded here only
  rawEvent('other-before', 'other', t0 + 30 * MIN, dir);
  rawEvent('other-after', 'other', t0 + 2 * HOUR, dir);
  attributeEvents({ all: true });
  assert.equal(acctOf('other-before'), 'A');
  assert.equal(acctOf('other-after'), 'B', 'the other session never recorded the switch, but made it');
});

test('readings that share a reset time are one account; a session left behind keeps its own', () => {
  reset();
  const t0 = Date.UTC(2026, 8, 11, 16, 0), dir = '/home/me/.claude';
  db().prepare("INSERT INTO accounts (account_uuid, email) VALUES ('A', 'a@x.com'), ('B', 'b@x.com')").run();
  // The profile moved from A to B while the tracker watched.
  for (let m = 0; m <= 60; m += 10) {
    db().prepare("INSERT INTO account_observations (ts, config_dir, account_uuid, source) VALUES (?, ?, ?, 'watch')")
      .run(t0 + m * MIN, dir, m < 20 ? 'A' : 'B');
  }
  const sids = ['s1', 's2', 's3', 'stale'];
  for (const s of sids) { session(s, t0 - HOUR, dir); point(s, t0 - HOUR, { email: 'a@x.com', source: 'context' }); }
  point('stale', t0 + 45 * MIN, { email: 'a@x.com', source: 'context' });  // this one never picked up the switch
  const read = (sid, resetsAt) => db().prepare(`INSERT INTO utilization (ts, session_id, config_dir, account_uuid, limit_type, pct, resets_at)
    VALUES (?, ?, ?, 'B', 'five_hour', 50, ?)`).run(t0 + 50 * MIN, sid, dir, resetsAt);   // tagged with the profile's account
  for (const s of ['s1', 's2', 's3']) read(s, t0 + 4 * HOUR + 20 * MIN);
  read('stale', t0 + 3 * HOUR);
  attributeEvents({ all: true });
  const tag = (sid) => db().prepare('SELECT account_uuid a FROM utilization WHERE session_id = ?').get(sid).a;
  assert.equal(tag('s1'), 'B');
  assert.equal(tag('stale'), 'A', "its reading carries A's reset time, so it read A's window");
});

test('a bridge record is dated by the line after it, not the one before', async () => {
  reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bridge-'));
  const proj = path.join(root, 'projects', '-tmp-demo');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  const call = (id, ts) => JSON.stringify({ type: 'assistant', uuid: id, timestamp: ts, sessionId: 'sess-b', cwd: '/tmp/demo',
    message: { id, model: 'claude-opus-5', content: [{ type: 'text' }], usage } });
  fs.writeFileSync(path.join(proj, 'sess-b.jsonl'), [
    call('m1', '2026-09-10T17:35:00.000Z'),
    // Resumed hours later, after a /login: the bridge registers again first.
    JSON.stringify({ type: 'bridge-session', sessionId: 'sess-b', ownerAccountUuid: 'acct-new' }),
    JSON.stringify({ type: 'user', timestamp: '2026-09-10T19:05:00.000Z', sessionId: 'sess-b', message: { role: 'user', content: 'go on' } }),
    call('m2', '2026-09-10T19:05:08.000Z'),
  ].join('\n') + '\n');
  const { ingestAll } = await import('../src/ingest.js');
  await ingestAll({ profiles: [{ dir: root, name: 'demo', projectsDir: path.join(root, 'projects') }] });
  const p = db().prepare("SELECT ts FROM identity_points WHERE source = 'bridge' AND session_id = 'sess-b'").get();
  assert.equal(p?.ts, Date.parse('2026-09-10T19:05:00.000Z'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('bridge records stored under the old dating move to the call that followed', async () => {
  reset();
  const { redateBridgePoints } = await import('../src/ingest.js');
  db().prepare("DELETE FROM meta WHERE key = 'bridge_dating'").run();
  const t1 = Date.UTC(2026, 8, 10, 17, 35), t2 = Date.UTC(2026, 8, 10, 19, 5);
  rawEvent('before', 'sb', t1, '/home/me/.claude');
  rawEvent('resumed', 'sb', t2, '/home/me/.claude');
  point('sb', t1, { account: 'new', source: 'bridge' });
  redateBridgePoints();
  assert.deepEqual(db().prepare("SELECT ts FROM identity_points WHERE session_id = 'sb'").all().map((r) => r.ts), [t2]);
});

test('an idle session is read as of its last call, not the render', async () => {
  reset();
  const { ingestLive, LIVE_DIR } = await import('../src/live.js');
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const now = Date.now(), lastCallAt = now - HOUR;
  db().prepare("INSERT INTO events (call_id, ts, session_id, cost_usd) VALUES ('idle-call', ?, 'sess-idle', 1)").run(lastCallAt);
  fs.writeFileSync(path.join(LIVE_DIR, 'sess-idle.json'), JSON.stringify({
    ts: now, session_id: 'sess-idle', config_dir: '/home/me/.claude', account_uuid: 'A',
    rate_limits: { five_hour: { used_percentage: 30, resets_at: Math.floor(now / 1000) + 3600 } } }));
  ingestLive();
  assert.equal(db().prepare("SELECT ts FROM utilization WHERE session_id = 'sess-idle'").get().ts, lastCallAt);
  fs.rmSync(LIVE_DIR, { recursive: true, force: true });
});
