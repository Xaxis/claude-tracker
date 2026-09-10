import { db } from './db.js';

/**
 * Rate-limit window reconstruction.
 *
 * Claude subscriptions enforce two rolling limits: a 5-hour "session" limit and
 * a 7-day limit. Neither is anchored to the clock - a window opens on the first
 * request made after the previous one lapsed, and runs for a fixed span.
 *
 * The 10-minute floor below is not a guess. Comparing every `resetsAt` the API
 * has reported against local transcript timestamps shows the window opening on
 * the 10-minute boundary at or before the first request of the window
 * (`npm run verify` re-runs that check against your own data).
 */

export const FIVE_HOUR = 5 * 60 * 60 * 1000;
export const SEVEN_DAY = 7 * 24 * 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export const LIMIT_TYPES = {
  five_hour: { span: FIVE_HOUR, grain: TEN_MIN, label: 'Session (5h)' },
  seven_day: { span: SEVEN_DAY, grain: ONE_HOUR, label: 'Weekly (7d)' },
};

const floorTo = (ts, grain) => Math.floor(ts / grain) * grain;

/**
 * Group chronologically ordered events into consecutive rolling windows.
 * @param {Array<{ts:number, cost:number}>} events sorted ascending by ts
 * @param {'five_hour'|'seven_day'} type
 */
export function buildWindows(events, type) {
  const { span, grain } = LIMIT_TYPES[type];
  const windows = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.ts >= cur.end) {
      cur = { start: floorTo(e.ts, grain), end: 0, cost: 0, events: 0, firstEvent: e.ts, lastEvent: e.ts };
      cur.end = cur.start + span;
      windows.push(cur);
    }
    cur.cost += e.cost;
    cur.events++;
    cur.lastEvent = e.ts;
  }
  return windows;
}

/**
 * Usage events drawn against an account's quota.
 *
 * Only the account's own sessions count. Folding unattributed usage into every
 * account would charge the same tokens to all of them at once, which inflates
 * each window and can push a reading past 100% for no real reason. Whatever we
 * could not place is reported separately instead, so an attribution gap shows up
 * as a visible number rather than as quietly wrong percentages.
 *
 * `__all__` selects every event regardless of owner; `null` selects only the
 * unattributed remainder.
 */
export function eventsFor(accountUuid, since = 0, { includeUnattributed = false } = {}) {
  const d = db();
  if (accountUuid === '__all__') {
    return d.prepare('SELECT ts, cost_usd AS cost FROM events WHERE ts >= ? ORDER BY ts').all(since);
  }
  if (accountUuid == null) {
    return d.prepare(`
      SELECT e.ts, e.cost_usd AS cost FROM events e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.ts >= ? AND s.account_uuid IS NULL ORDER BY e.ts`).all(since);
  }
  if (includeUnattributed) {
    return d.prepare(`
      SELECT e.ts, e.cost_usd AS cost FROM events e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.ts >= ? AND (s.account_uuid = ? OR s.account_uuid IS NULL) ORDER BY e.ts`).all(since, accountUuid);
  }
  return d.prepare(`
    SELECT e.ts, e.cost_usd AS cost FROM events e
    JOIN sessions s ON s.session_id = e.session_id
    WHERE s.account_uuid = ? AND e.ts >= ? ORDER BY e.ts`).all(accountUuid, since);
}

/**
 * The most recent reset time the API itself reported for this account and limit.
 * This is ground truth and outranks anything we reconstruct.
 */
export function latestResetMs(accountUuid, type) {
  const row = db().prepare(`
    SELECT MAX(resets_at) AS r FROM limit_events
     WHERE limit_type = ? AND account_uuid = ?`).get(type, accountUuid);
  return row?.r ? row.r * 1000 : null;
}

/** Spend and call count strictly inside a time range. */
export function sumBetween(accountUuid, start, end) {
  const rows = eventsFor(accountUuid, start).filter((e) => e.ts <= end);
  return { cost: rows.reduce((a, e) => a + e.cost, 0), events: rows.length };
}

/**
 * The window in force right now for an account, or the one that just lapsed.
 *
 * Two sources, in order of authority:
 *
 *   1. A reset time the API reported that has not yet passed. That names the
 *      current window's exact end, so the window is simply [end - span, end].
 *   2. Reconstruction from usage. Chaining windows is only meaningful from a
 *      known starting point - anchoring to an arbitrary lookback cutoff makes
 *      every later boundary wrong, which matters most for the 7-day window where
 *      a mis-anchored chain can be days off. So the chain starts at the last
 *      authoritative reset when there is one, and at the account's first
 *      recorded usage otherwise.
 *
 * `active` distinguishes an open window from a lapsed one: an idle account has
 * no open window, and its next request opens a fresh one at full capacity.
 */
export function currentWindow(accountUuid, type, now = Date.now()) {
  const { span } = LIMIT_TYPES[type];
  const anchor = latestResetMs(accountUuid, type);

  if (anchor && anchor > now) {
    const start = anchor - span;
    const { cost, events } = sumBetween(accountUuid, start, now);
    return { active: true, start, end: anchor, cost, events, authoritative: true };
  }

  const events = eventsFor(accountUuid, anchor ?? 0);
  const windows = buildWindows(events, type);
  const last = windows[windows.length - 1];
  if (!last) return { active: false, start: null, end: null, cost: 0, events: 0 };
  if (now >= last.end) {
    return { active: false, start: last.start, end: last.end, cost: last.cost, events: last.events, lapsed: true };
  }
  return { active: true, ...last };
}

/**
 * Burn rate over the trailing `mins` minutes, in quota units per hour.
 * Used to project when an open window will be exhausted.
 */
export function burnRate(accountUuid, mins = 30, now = Date.now()) {
  const since = now - mins * 60 * 1000;
  const rows = eventsFor(accountUuid, since);
  const cost = rows.reduce((a, r) => a + r.cost, 0);
  return { perHour: cost / (mins / 60), cost, mins, events: rows.length };
}

/**
 * Windows that closed in the recent past, newest first - for history charts.
 * Chains from the same anchor `currentWindow` uses so the history and the live
 * reading cannot disagree about where a window begins.
 */
export function recentWindows(accountUuid, type, count = 12, now = Date.now()) {
  const { span } = LIMIT_TYPES[type];
  const anchor = latestResetMs(accountUuid, type);
  // Start the chain near the anchor when we have one - it bounds the scan and
  // keeps the boundaries close to the ones the API actually reported.
  const since = anchor ? Math.max(0, anchor - span * (count + 1)) : 0;
  const events = eventsFor(accountUuid, since);
  return buildWindows(events, type).slice(-count).reverse();
}
