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
const { attributeSessions } = await import('../src/accounts.js');

process.on('exit', () => {
  try { closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const HOUR = 3600_000;
const MIN = 60_000;

function reset() {
  const d = db();
  for (const t of ['events', 'sessions', 'accounts', 'limit_events', 'calibration', 'account_observations', 'files']) {
    d.exec(`DELETE FROM ${t}`);
  }
}

let seq = 0;
function addEvent(sessionId, ts, cost) {
  db().prepare(`INSERT INTO events (call_id, ts, session_id, model, cost_usd) VALUES (?,?,?,?,?)`)
    .run(`e${seq++}`, ts, sessionId, 'claude-opus-5', cost);
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
