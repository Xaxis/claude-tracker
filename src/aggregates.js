import { db } from './db.js';

/**
 * Per-account totals - calls, cost, sessions - without rescanning all history on
 * every push.
 *
 * Lifetime sums over a quarter-million calls took hundreds of milliseconds and
 * ran synchronously on every update, for the terminal and again for each open
 * browser tab. So history is split at a cutoff older than anything the live path
 * ever re-attributes: calls before it are summed once and reused, calls after it
 * are re-summed on each read. A late correction (a call moving to the account a
 * /login switched to) always lands in the live part, so totals stay exact.
 * Grouping by (account, session) keeps session counts exact as well.
 */
const LIVE_WINDOW_MS = 15 * 60_000;   // wider than the fast path's 10-minute re-check
const MAX_BASE_AGE_MS = 30 * 60_000;  // keep the live part from growing without bound

let base = null;   // { cutoff, rows: Map<'account|session', {a, s, n, c}> }

export function invalidateAggregates() { base = null; }

/** Calls older than this are frozen in the cached base. */
export function aggregatesCutoff() { return base ? base.cutoff : -Infinity; }

const GROUP = 'SELECT account_uuid a, session_id s, COUNT(*) n, SUM(cost_usd) c FROM events';
const keyOf = (r) => `${r.a}|${r.s}`;

/**
 * An account's calls and spend from `start` to `end`, both included: what lies
 * before the frozen cutoff summed once and kept, what follows summed each time.
 * A billing period or a week-long window re-summed on every push, for every
 * account, was most of what the overview cost.
 */
const RANGE = 'SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) c FROM events WHERE account_uuid = ? AND ts >= ?';
const frozen = new Map();
let frozenOf = null;
export function accountSpend(accountUuid, start, end) {
  const d = db();
  if (!base || start >= base.cutoff || end < base.cutoff) {
    const r = d.prepare(`${RANGE} AND ts <= ?`).get(accountUuid, start, end);
    return { cost: r.c, events: r.n };
  }
  if (frozenOf !== base) { frozen.clear(); frozenOf = base; }
  const key = `${accountUuid}|${start}`;
  let f = frozen.get(key);
  if (!f) {
    f = d.prepare(`${RANGE} AND ts < ?`).get(accountUuid, start, base.cutoff);
    if (frozen.size > 5000) frozen.clear();
    frozen.set(key, f);
  }
  const live = d.prepare(`${RANGE} AND ts <= ?`).get(accountUuid, base.cutoff, end);
  return { cost: f.c + live.c, events: f.n + live.n };
}

export function accountAggregates(now = Date.now()) {
  if (!base || now - base.cutoff > MAX_BASE_AGE_MS) {
    const cutoff = now - LIVE_WINDOW_MS;
    const rows = new Map();
    for (const r of db().prepare(`${GROUP} WHERE ts < ? GROUP BY account_uuid, session_id`).all(cutoff)) {
      rows.set(keyOf(r), r);
    }
    base = { cutoff, rows };
  }
  const merged = new Map(base.rows);
  // Grouped by +column so SQLite finds the last minutes by time. Plain, it read the whole
  // (account, session) index - every call ever, a fifth of a second - to group a few hundred.
  for (const r of db().prepare(`${GROUP} WHERE ts >= ? GROUP BY +account_uuid, +session_id`).all(base.cutoff)) {
    const prev = merged.get(keyOf(r));
    merged.set(keyOf(r), prev ? { a: r.a, s: r.s, n: prev.n + r.n, c: prev.c + r.c } : r);
  }
  const out = new Map();   // account_uuid (or null) -> { events, cost, sessions }
  for (const r of merged.values()) {
    const t = out.get(r.a) ?? { events: 0, cost: 0, sessions: 0 };
    t.events += r.n; t.cost += r.c; t.sessions += 1;
    out.set(r.a, t);
  }
  return out;
}
