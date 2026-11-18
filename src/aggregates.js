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

/*
 * Sums over calls behind the frozen line, worked out once and kept until the line
 * is drawn again - after half an hour, or when a call behind it changed.
 */
const kept = new Map();
let keptOf = null;
function keep(key, fn) {
  if (keptOf !== base) { kept.clear(); keptOf = base; }
  let v = kept.get(key);
  if (v === undefined) {
    v = fn(base.cutoff);
    if (kept.size > 20_000) kept.clear();
    kept.set(key, v);
  }
  return v;
}

/**
 * An account's calls and spend from `start` to `end`, both included: what lies
 * behind the frozen line summed once and kept, what follows summed each time.
 * A billing period or a week-long window re-summed on every push, for every
 * account, was most of what the overview cost; the readings calibration scales,
 * most of a rescan.
 */
const RANGE = 'SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) c FROM events WHERE account_uuid = ? AND ts >= ?';
export function accountSpend(accountUuid, start, end) {
  const d = db();
  if (!base || start >= base.cutoff) {
    const r = d.prepare(`${RANGE} AND ts <= ?`).get(accountUuid, start, end);
    return { cost: r.c, events: r.n };
  }
  // Up to the line, or to `end` where that comes first: either way it is kept.
  const before = end < base.cutoff;
  const f = keep(`spend|${accountUuid}|${start}|${before ? end : ''}`,
    (cut) => d.prepare(`${RANGE} AND ts <= ? AND ts < ?`).get(accountUuid, start, end, cut));
  if (before) return { cost: f.c, events: f.n };
  const live = d.prepare(`${RANGE} AND ts <= ?`).get(accountUuid, base.cutoff, end);
  return { cost: f.c + live.c, events: f.n + live.n };
}

/**
 * A session's calls by the account each was billed to, in the order the
 * accounts first appear: count, spend, tokens and first call. A long session
 * has a hundred thousand calls, and the recent-sessions list summed every
 * session's, every ten seconds, for every tab.
 */
const PARTS = `SELECT account_uuid a, COUNT(*) n, SUM(cost_usd) c,
  SUM(input_tokens + output_tokens + cache_write_5m + cache_write_1h + cache_read) t, MIN(ts) f
  FROM events WHERE session_id = ?`;
export function sessionParts(sessionId) {
  const d = db();
  const rows = base
    ? [...keep(`session|${sessionId}`, (cut) => d.prepare(`${PARTS} AND ts < ? GROUP BY account_uuid`).all(sessionId, cut)),
      ...d.prepare(`${PARTS} AND ts >= ? GROUP BY account_uuid`).all(sessionId, base.cutoff)]
    : d.prepare(`${PARTS} GROUP BY account_uuid`).all(sessionId);
  const by = new Map();
  for (const r of rows) {
    const p = by.get(r.a);
    by.set(r.a, p ? { a: r.a, n: p.n + r.n, c: p.c + r.c, t: p.t + r.t, f: Math.min(p.f, r.f) } : { a: r.a, n: r.n, c: r.c, t: r.t, f: r.f });
  }
  return [...by.values()].sort((x, y) => x.f - y.f);
}

/**
 * Per-model totals of the calls since `since`, in quarter hours: `b` is a
 * bucket's start over QUARTER, and the first holds only what came at or after
 * `since`. Local days begin on a quarter hour in every time zone, so buckets add
 * up to days exactly. `filter` is { key, clause, params }: the clause narrows
 * `events e`, and the key names it. A month is a million calls; summing them for
 * each tab's charts every ten seconds took seconds. Quarters behind the frozen
 * line are kept.
 */
export const QUARTER = 15 * 60_000;
const ROLL = `SELECT e.ts / ${QUARTER} b, e.model model, COUNT(*) events, SUM(e.cost_usd) cost,
  SUM(e.input_tokens) input, SUM(e.output_tokens) output, SUM(e.thinking_tokens) thinking,
  SUM(e.cache_write_5m + e.cache_write_1h) cache_write, SUM(e.cache_read) cache_read FROM events e`;
function rolled(lo, hi, filter) {
  return db().prepare(`${ROLL} WHERE e.ts >= @lo${hi == null ? '' : ' AND e.ts < @hi'} ${filter.clause} GROUP BY b, e.model`)
    .all(hi == null ? { lo, ...filter.params } : { lo, hi, ...filter.params });
}
export function rollup(since, filter) {
  const line = base ? Math.floor(base.cutoff / QUARTER) * QUARTER : null;
  if (line == null || since >= line) return rolled(since, null, filter);
  const whole = Math.min(Math.ceil(since / QUARTER) * QUARTER, line);
  const out = whole > since ? rolled(since, whole, filter) : [];
  if (whole < line) {
    // Kept from the earliest quarter anyone asked for up to the line; reaching further back adds to it.
    const k = keep(`rollup|${filter.key}`, () => ({ from: line, rows: [] }));
    if (whole < k.from) { k.rows = rolled(whole, k.from, filter).concat(k.rows); k.from = whole; }
    const first = whole / QUARTER;
    for (const r of k.rows) if (r.b >= first) out.push(r);
  }
  return out.concat(rolled(line, null, filter));
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
