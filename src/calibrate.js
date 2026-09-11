import { db, tx } from './db.js';
import { LIMIT_TYPES, buildWindows, eventsFor } from './windows.js';

/**
 * Learning each plan's real capacity.
 *
 * Anthropic does not publish subscription limits as a token or dollar figure, so
 * a hardcoded ceiling would be fiction. What we do have is every moment the API
 * refused a request: at that instant the window was, by definition, full. Summing
 * the usage inside that window up to the refusal measures the capacity directly.
 *
 * One detail matters most for accuracy: stop at the refusal, not at the window
 * end. Hitting a limit is exactly when you switch accounts, so the tail of the
 * window usually belongs to a different account and would inflate the estimate.
 *
 * The measurement uses the same event population as the live window reading
 * (the account's own sessions), so capacity and fill are always comparable. If
 * a lot of usage is unattributed, both numbers are low together rather than
 * disagreeing - and the dashboard reports the unattributed total so the gap is
 * visible instead of silent.
 */

/** Static last resort, only for a tier we have never measured anywhere. */
const GENERIC = { five_hour: 2000, seven_day: 15000 };

/** Events that drew down this account's quota, in a time range. */
function calibrationEvents(accountUuid, since, until) {
  return db().prepare(`
    SELECT ts, cost_usd AS cost FROM events
     WHERE ts >= ? AND ts <= ? AND account_uuid = ?
     ORDER BY ts`).all(since, until, accountUuid);
}

/**
 * Measure capacity from one rejection: rebuild the window in force at that
 * moment and total the usage from its start up to the refusal.
 */
function measureRejection(accountUuid, type, resetsAtMs, rejectedAtMs) {
  const { span, grain } = LIMIT_TYPES[type];
  const windowStart = resetsAtMs - span;
  // Look back an extra span so the window that was open is reconstructed whole.
  const events = calibrationEvents(accountUuid, windowStart - span, resetsAtMs);
  const windows = buildWindows(events, type);
  const hit = windows.find((w) => Math.abs(w.end - resetsAtMs) <= grain);

  const start = hit ? hit.start : windowStart;
  const until = rejectedAtMs ?? resetsAtMs;
  const cost = events
    .filter((e) => e.ts >= start && e.ts <= until)
    .reduce((a, e) => a + e.cost, 0);

  return { cost, matched: !!hit };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Recompute capacity for every account and limit type.
 *
 * Runs in two passes so an account that has never been rate limited can inherit
 * a real measurement from another account on the same plan tier, rather than
 * falling back to an invented constant.
 */
export function calibrateAll() {
  const d = db();
  const accounts = d.prepare('SELECT account_uuid, rate_limit_tier FROM accounts').all();
  const measured = [];

  // Pass 1 - measure every account that has rejections on record.
  for (const acct of accounts) {
    for (const type of Object.keys(LIMIT_TYPES)) {
      const rejections = d.prepare(`
        SELECT resets_at, MIN(ts) AS rejected_at
          FROM limit_events
         WHERE limit_type = ? AND account_uuid = ?
         GROUP BY resets_at ORDER BY resets_at`).all(type, acct.account_uuid);

      const samples = [];
      let matched = 0;
      for (const r of rejections) {
        const m = measureRejection(acct.account_uuid, type, r.resets_at * 1000, r.rejected_at);
        if (m.cost > 0) { samples.push(m.cost); if (m.matched) matched++; }
      }
      measured.push({ acct, type, samples, matched });
    }
  }

  // Medians from whatever was actually measured, keyed by tier and also pooled
  // globally - most accounts never report a tier, so a tier-only fallback would
  // strand them on a constant when a real measurement is sitting right there.
  const tierPool = new Map();
  const globalPool = new Map();
  for (const m of measured) {
    if (!m.samples.length) continue;
    const med = median(m.samples);
    const key = `${m.acct.rate_limit_tier ?? 'unknown'}:${m.type}`;
    if (!tierPool.has(key)) tierPool.set(key, []);
    tierPool.get(key).push(med);
    if (!globalPool.has(m.type)) globalPool.set(m.type, []);
    globalPool.get(m.type).push(med);
  }

  const results = [];
  tx(() => {
    const upsert = d.prepare(`
      INSERT INTO calibration (account_uuid, limit_type, capacity, samples, confidence, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_uuid, limit_type) DO UPDATE SET
        capacity = excluded.capacity, samples = excluded.samples,
        confidence = excluded.confidence, updated_at = excluded.updated_at`);

    for (const { acct, type, samples, matched } of measured) {
      let capacity, confidence;
      if (samples.length >= 2 && matched >= 1) {
        capacity = median(samples); confidence = 'measured';
      } else if (samples.length === 1) {
        capacity = samples[0]; confidence = 'partial';
      } else {
        const tierMatch = tierPool.get(`${acct.rate_limit_tier ?? 'unknown'}:${type}`);
        const anyMatch = globalPool.get(type);
        if (tierMatch?.length) { capacity = median(tierMatch); confidence = 'tier'; }
        else if (anyMatch?.length) { capacity = median(anyMatch); confidence = 'tier'; }
        else { capacity = GENERIC[type]; confidence = 'default'; }
      }
      upsert.run(acct.account_uuid, type, capacity, samples.length, confidence, Date.now());
      results.push({ account: acct.account_uuid, type, capacity, samples: samples.length, confidence });
    }
  });

  return results;
}

export function capacityFor(accountUuid, type, tier = null) {
  const row = db().prepare('SELECT capacity, confidence, samples FROM calibration WHERE account_uuid = ? AND limit_type = ?')
    .get(accountUuid, type);
  if (row) return row;
  return { capacity: GENERIC[type], confidence: 'default', samples: 0 };
}

/**
 * Check the window model against reality: for each observed reset time, how far
 * off was our reconstructed window boundary? Surfaced by `claude-tracker verify`.
 */
export function verifyWindowModel() {
  const d = db();
  const out = [];
  for (const type of Object.keys(LIMIT_TYPES)) {
    const { span, grain } = LIMIT_TYPES[type];
    const rows = d.prepare(`
      SELECT resets_at, account_uuid, MIN(ts) AS rejected_at
        FROM limit_events WHERE limit_type = ?
       GROUP BY resets_at ORDER BY resets_at`).all(type);
    for (const r of rows) {
      const resetsAtMs = r.resets_at * 1000;
      // Model against all usage: attribution gaps must not hide a model error.
      const events = eventsFor('__all__', resetsAtMs - span * 2);
      const windows = buildWindows(events, type);
      let best = null;
      for (const w of windows) {
        const delta = Math.abs(w.end - resetsAtMs);
        if (!best || delta < best.delta) best = { delta, window: w };
      }
      out.push({
        type,
        resetsAt: resetsAtMs,
        deltaMs: best ? best.delta : null,
        withinGrain: best ? best.delta <= grain : false,
        windowCost: best?.window.cost ?? 0,
      });
    }
  }
  return out;
}
