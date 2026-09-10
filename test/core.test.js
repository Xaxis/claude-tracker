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
  db().prepare(`INSERT INTO events (uuid, ts, session_id, model, cost_usd) VALUES (?,?,?,?,?)`)
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
