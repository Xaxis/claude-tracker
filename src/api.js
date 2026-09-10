import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { SESSIONS_DIR } from './paths.js';
import { accountLabel, listAccounts, currentAccount } from './accounts.js';
import { capacityFor } from './calibrate.js';
import { LIMIT_TYPES, currentWindow, burnRate, recentWindows } from './windows.js';
import { modelLabel } from './pricing.js';

const UNATTRIBUTED = '__unattributed__';

/** Percent used, clamped for display but reported raw in `raw`. */
function pct(used, capacity) {
  if (!capacity) return { value: 0, raw: 0 };
  const raw = (used / capacity) * 100;
  return { value: Math.max(0, Math.min(100, raw)), raw };
}

/**
 * Status of one limit window: how full it is, when it frees up, and - while a
 * window is open and burning - roughly how long the remaining headroom lasts.
 */
function windowStatus(accountUuid, type, tier, now) {
  const w = currentWindow(accountUuid, type, now);
  const cap = capacityFor(accountUuid, type, tier);
  const used = w.cost ?? 0;
  const p = pct(used, cap.capacity);
  const rate = w.active ? burnRate(accountUuid, type === 'five_hour' ? 30 : 180, now) : null;

  // A window that is already full has nothing left to project.
  let exhaustsAt = null;
  if (w.active && used < cap.capacity && rate && rate.perHour > 0) {
    const remaining = Math.max(0, cap.capacity - used);
    const hours = remaining / rate.perHour;
    const projected = now + hours * 3600 * 1000;
    // Only meaningful if the burn would exhaust the window before it resets.
    if (projected < w.end) exhaustsAt = projected;
  }

  return {
    type,
    label: LIMIT_TYPES[type].label,
    active: w.active,
    start: w.start,
    end: w.end,
    resetsInMs: w.end ? Math.max(0, w.end - now) : null,
    used,
    capacity: cap.capacity,
    confidence: cap.confidence,
    samples: cap.samples,
    percent: p.value,
    percentRaw: p.raw,
    events: w.events ?? 0,
    burnPerHour: rate?.perHour ?? 0,
    exhaustsAt,
  };
}

/** Rate-limit rejections still in force right now, straight from the API's own word. */
function activeRejections(now) {
  return db().prepare(`
    SELECT limit_type, MAX(resets_at) AS resets_at, account_uuid
      FROM limit_events
     WHERE status = 'rejected' AND resets_at * 1000 > ?
     GROUP BY limit_type, account_uuid`).all(now);
}

export function overview(now = Date.now()) {
  const d = db();
  const accounts = listAccounts();
  const cur = currentAccount();
  const rejections = activeRejections(now);

  const unattributed = d.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(e.cost_usd),0) AS cost
      FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
     WHERE s.account_uuid IS NULL`).get();

  const rows = accounts.map((a) => {
    const tier = a.rate_limit_tier;
    const limits = Object.keys(LIMIT_TYPES).map((t) => {
      const st = windowStatus(a.account_uuid, t, tier, now);
      const rej = rejections.find((r) => r.limit_type === t && r.account_uuid === a.account_uuid);
      if (rej) {
        // The API said this window is closed - that outranks any estimate.
        st.blocked = true;
        st.end = rej.resets_at * 1000;
        st.resetsInMs = Math.max(0, st.end - now);
        st.percent = 100;
        st.exhaustsAt = null;
      }
      return st;
    });
    const totals = d.prepare(`
      SELECT COUNT(*) AS events, COALESCE(SUM(e.cost_usd),0) AS cost
        FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE s.account_uuid = ?`).get(a.account_uuid);

    return {
      accountUuid: a.account_uuid,
      label: accountLabel(a),
      email: a.email,
      tier: tier,
      subscription: a.subscription_type,
      isCurrent: cur?.accountUuid === a.account_uuid,
      sessions: a.sessions,
      totalCost: totals.cost,
      totalEvents: totals.events,
      limits,
    };
  });

  // Sort by most-constrained first: that's what the user actually needs to see.
  rows.sort((a, b) => {
    const worst = (r) => Math.max(...r.limits.map((l) => l.percent));
    return worst(b) - worst(a);
  });

  return {
    now,
    accounts: rows,
    unattributed: { events: unattributed.events, cost: unattributed.cost },
    current: cur ? { accountUuid: cur.accountUuid, email: cur.email } : null,
  };
}

/**
 * Build the account filter for a query.
 *
 * node:sqlite rejects a named parameter the statement does not mention, so the
 * bindings have to be built alongside the clause rather than passed always.
 */
function accountFilter(accountUuid, prefix = 'AND') {
  if (!accountUuid || accountUuid === 'all') return { clause: '', params: {} };
  if (accountUuid === UNATTRIBUTED) return { clause: `${prefix} s.account_uuid IS NULL`, params: {} };
  return { clause: `${prefix} s.account_uuid = @acct`, params: { acct: accountUuid } };
}

/** Daily totals for the trailing `days`, split by model. */
export function history(days = 30, accountUuid = null) {
  const since = Date.now() - days * 86400000;
  const { clause: where, params } = accountFilter(accountUuid);
  const rows = db().prepare(`
    SELECT strftime('%Y-%m-%d', e.ts/1000, 'unixepoch', 'localtime') AS day,
           e.model AS model,
           COUNT(*) AS events,
           SUM(e.input_tokens + e.output_tokens + e.cache_write_5m + e.cache_write_1h + e.cache_read) AS tokens,
           SUM(e.cost_usd) AS cost
      FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
     WHERE e.ts >= @since ${where}
     GROUP BY day, model ORDER BY day`).all({ since, ...params });

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, cost: 0, tokens: 0, events: 0, models: {} });
    const e = byDay.get(r.day);
    e.cost += r.cost; e.tokens += r.tokens; e.events += r.events;
    const name = modelLabel(r.model);
    e.models[name] = (e.models[name] ?? 0) + r.cost;
  }
  return [...byDay.values()];
}

/** Recent sessions with their cost and owning account. */
export function sessions(limit = 40, accountUuid = null) {
  const { clause: where, params } = accountFilter(accountUuid, 'WHERE');
  return db().prepare(`
    SELECT s.session_id, s.project, s.cwd, s.git_branch, s.first_ts, s.last_ts,
           s.account_uuid, s.account_source, s.version,
           COALESCE(SUM(e.cost_usd), 0) AS cost,
           COUNT(e.uuid) AS events,
           COALESCE(SUM(e.input_tokens + e.output_tokens + e.cache_write_5m + e.cache_write_1h + e.cache_read), 0) AS tokens
      FROM sessions s LEFT JOIN events e ON e.session_id = s.session_id
      ${where}
     GROUP BY s.session_id
     HAVING events > 0
     ORDER BY s.last_ts DESC LIMIT @limit`).all({ limit, ...params });
}

/** Claude Code processes running right now, from the CLI's own session registry. */
export function liveSessions() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8'));
      if (!s.sessionId) continue;
      // The registry keeps entries for exited processes; drop anything whose pid is gone.
      let alive = true;
      try { process.kill(s.pid, 0); } catch { alive = false; }
      if (!alive) continue;
      out.push({
        sessionId: s.sessionId, pid: s.pid, cwd: s.cwd, name: s.name,
        status: s.status, startedAt: s.startedAt, updatedAt: s.updatedAt,
        version: s.version, kind: s.kind,
      });
    } catch { /* mid-write or malformed */ }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Per-model totals over the trailing `days`. */
export function modelBreakdown(days = 30, accountUuid = null) {
  const since = Date.now() - days * 86400000;
  const { clause: where, params } = accountFilter(accountUuid);
  const rows = db().prepare(`
    SELECT e.model, COUNT(*) AS events, SUM(e.cost_usd) AS cost,
           SUM(e.input_tokens) AS input, SUM(e.output_tokens) AS output,
           SUM(e.thinking_tokens) AS thinking,
           SUM(e.cache_write_5m + e.cache_write_1h) AS cache_write,
           SUM(e.cache_read) AS cache_read
      FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
     WHERE e.ts >= @since ${where}
     GROUP BY e.model ORDER BY cost DESC`).all({ since, ...params });
  return rows.map((r) => ({ ...r, label: modelLabel(r.model) }));
}

/** Window-by-window history, for the "how full does it usually get" chart. */
export function windowHistory(accountUuid, type = 'five_hour', count = 14) {
  const tierRow = db().prepare('SELECT rate_limit_tier FROM accounts WHERE account_uuid = ?').get(accountUuid);
  const cap = capacityFor(accountUuid, type, tierRow?.rate_limit_tier);
  return recentWindows(accountUuid, type, count).map((w) => ({
    start: w.start, end: w.end, cost: w.cost, events: w.events,
    percent: cap.capacity ? Math.min(100, (w.cost / cap.capacity) * 100) : 0,
  }));
}

export { UNATTRIBUTED };
