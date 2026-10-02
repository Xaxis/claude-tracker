import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { discoverProfiles, HOME, tildify } from './paths.js';
import { accountLabel, listAccounts, currentAccount, profileAccount, accountResolver } from './accounts.js';
import { capacityFor } from './calibrate.js';
import { LIMIT_TYPES, currentWindow, burnRate, recentWindows, sumBetween } from './windows.js';
import { modelLabel } from './pricing.js';
import { billingPeriod, periodSpend } from './billing.js';
import { accountAggregates } from './aggregates.js';
import { machine, remoteMachines, listPeers, machineNameOf } from './replica.js';
import { failoverSettings, recentSwitches } from './failover.js';
import { getMeta } from './db.js';

const UNATTRIBUTED = '__unattributed__';

/** Every limit Claude Code knows about, including ones only a refusal reveals. */
const EXTRA_LABELS = {
  seven_day_opus: 'Weekly Opus (7d)', seven_day_sonnet: 'Weekly Sonnet (7d)',
  seven_day_oauth_apps: 'Weekly apps (7d)', spend_limit: 'Spend limit',
};
export const limitLabel = (type) => LIMIT_TYPES[type]?.label ?? EXTRA_LABELS[type] ?? type;

/** The newest exact reading for an account's window that has not reset yet. */
function exactReading(accountUuid, type, now) {
  // Never one dated before its own window began: an idle session's fresh numbers, misdated.
  const span = LIMIT_TYPES[type]?.span ?? 0;
  return db().prepare(`SELECT ts, pct, resets_at FROM utilization
     WHERE account_uuid = ? AND limit_type = ? AND (resets_at > ? OR (resets_at IS NULL AND ts > ?))
       AND (resets_at IS NULL OR ts >= resets_at - ?)
     ORDER BY ts DESC LIMIT 1`).get(accountUuid, type, now, now - 30 * 60_000, span) ?? null;
}

/**
 * Status of one limit window: how full it is, when it frees up, and - while it
 * is open and burning - roughly how long the headroom lasts.
 *
 * Where Claude Code has reported the window's exact utilization (through a
 * session's status line), that is the reading, and its reset time is the one
 * the server gave. Between reports it is carried forward with the calls made
 * since, at the rate the report itself implies - local spend per point. Only
 * with no report does the bar fall back to an estimated ceiling.
 */
function windowStatus(accountUuid, type, tier, now) {
  const w = currentWindow(accountUuid, type, now);
  const cap = capacityFor(accountUuid, type, tier);
  const rate = burnRate(accountUuid, type === 'five_hour' ? 30 : 180, now);
  const ex = exactReading(accountUuid, type, now);

  let percent, used = w.cost ?? 0, capacity = cap.capacity, confidence = cap.confidence;
  let start = w.start, end = w.end, active = w.active;
  if (ex) {
    end = ex.resets_at ?? end;
    start = end ? end - LIMIT_TYPES[type].span : start;
    const before = sumBetween(accountUuid, start ?? ex.ts, ex.ts).cost;
    const after = sumBetween(accountUuid, ex.ts, now).cost;
    const perPoint = ex.pct >= 3 && before > 0 ? before / ex.pct : capacity ? capacity / 100 : null;
    const since = perPoint ? after / perPoint : 0;
    percent = ex.pct + since;
    used = before + after;
    if (perPoint) capacity = perPoint * 100;
    // Exact as Claude Code read it; whatever the calls since have added is estimated.
    confidence = since >= 1 ? 'carried' : 'exact';
    active = true;
  } else {
    percent = capacity ? (used / capacity) * 100 : 0;
  }
  // A window whose time is up is empty again - the next request opens a new one -
  // however full it got.
  const lastPercent = active ? null : percent;
  if (!active) percent = 0;
  const percentRaw = percent;
  percent = Math.max(0, Math.min(100, percent));

  // A window that is already full has nothing left to project.
  let exhaustsAt = null;
  if (active && percent < 100 && rate.perHour > 0 && capacity) {
    const projected = now + ((((100 - percent) / 100) * capacity) / rate.perHour) * 3600e3;
    if (end && projected < end) exhaustsAt = projected;
  }

  return {
    type, label: limitLabel(type), active, start, end,
    resetsInMs: end ? Math.max(0, end - now) : null,
    used, capacity, confidence, samples: cap.samples,
    percent, percentRaw, lastPercent, events: w.events ?? 0,
    burnPerHour: rate.perHour, exhaustsAt, exactAt: ex?.ts ?? null,
  };
}

/**
 * The account to use right now: never one that is refused on any limit,
 * preferring one already signed into a profile here (usable immediately), then
 * one signed in on another synced machine, then the most headroom in its
 * tightest window. An idle window counts as empty - the next request opens a
 * fresh one.
 */
function recommend(rows, now) {
  const signedIn = new Map();
  const run = (p) => (p.isDefault ? 'claude' : `CLAUDE_CONFIG_DIR=${p.dir} claude`);
  for (const p of profileStates()) {
    if (p.accountUuid && !signedIn.has(p.accountUuid)) signedIn.set(p.accountUuid, { name: p.name, command: run(p), machine: null });
  }
  for (const m of remoteMachines(now)) {
    for (const p of m.profiles) {
      if (p.accountUuid && !signedIn.has(p.accountUuid)) signedIn.set(p.accountUuid, { name: p.name, command: run(p), machine: m.name });
    }
  }
  const rank = (x) => (x.profile ? (x.profile.machine ? 1 : 2) : 0);
  const scored = rows.filter((a) => a.available.now).map((a) => {
    const core = a.limits.filter((l) => LIMIT_TYPES[l.type]);
    const headroom = core.length ? Math.min(...core.map((l) => 100 - (l.active ? l.percent : 0))) : 100;
    return {
      a, headroom, profile: signedIn.get(a.accountUuid) ?? null,
      exact: core.every((l) => !l.active || l.confidence === 'exact'),
    };
  }).sort((x, y) => rank(y) - rank(x) || y.headroom - x.headroom);
  const best = scored[0];
  if (!best) return null;
  const p = best.profile;
  return {
    accountUuid: best.a.accountUuid, label: best.a.label, headroom: best.headroom, exact: best.exact,
    profile: p?.name ?? null,
    machine: p?.machine ?? null,
    command: p?.command ?? null,
    note: p ? null : 'not signed into any profile - /login with it first',
  };
}

/**
 * When an account can take a request again: now, unless a window is full -
 * refused by the API, or read or carried to 100% - and then when the last such
 * window resets. `sure` when that rests on a refusal or an exact reading
 * rather than an estimate.
 */
export function availability(limits) {
  const out = limits.filter((l) => l.blocked || (l.active && l.percent >= 100));
  if (!out.length) return { now: true, at: null, limit: null, sure: true };
  const last = out.reduce((a, b) => ((b.end ?? 0) > (a.end ?? 0) ? b : a));
  return {
    now: false, at: last.end ?? null, limit: last.type,
    sure: out.every((l) => l.blocked || l.confidence === 'exact'),
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
  const agg = accountAggregates(now);
  const accounts = listAccounts(agg);
  const cur = currentAccount();
  const rejections = activeRejections(now);

  const unattributed = agg.get(null) ?? { events: 0, cost: 0 };

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
    // Limits only a refusal reveals - weekly Opus and Sonnet caps and the like.
    for (const r of rejections.filter((x) => x.account_uuid === a.account_uuid && !LIMIT_TYPES[x.limit_type])) {
      limits.push({
        type: r.limit_type, label: limitLabel(r.limit_type), active: true, blocked: true,
        start: null, end: r.resets_at * 1000, resetsInMs: Math.max(0, r.resets_at * 1000 - now),
        used: null, capacity: null, confidence: 'measured', samples: 0, percent: 100, percentRaw: 100,
        events: 0, burnPerHour: 0, exhaustsAt: null, exactAt: null,
      });
    }
    // A gateway spend limit, when Claude Code reports one.
    const spend = exactReading(a.account_uuid, 'spend_limit', now);
    if (spend) {
      limits.push({
        type: 'spend_limit', label: limitLabel('spend_limit'), active: true, blocked: spend.pct >= 100,
        start: null, end: spend.resets_at, resetsInMs: spend.resets_at ? Math.max(0, spend.resets_at - now) : null,
        used: null, capacity: null, confidence: 'exact', samples: 0,
        percent: Math.min(100, spend.pct), percentRaw: spend.pct,
        events: 0, burnPerHour: 0, exhaustsAt: null, exactAt: spend.ts,
      });
    }
    const totals = agg.get(a.account_uuid) ?? { events: 0, cost: 0 };
    const available = availability(limits);

    // Only a monthly subscription has a cycle to project. A prepaid or org seat
    // records a start date too, but projecting monthly renewals from it is fiction.
    const projectable = !a.billing_type || a.billing_type === 'stripe_subscription';
    const period = projectable ? billingPeriod(a.subscription_at, 'month', now) : null;
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
      available,
      billing: period ? { ...period, spend: periodSpend(d, a.account_uuid, period) } : null,
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
    recommendation: recommend(rows, now),
    sync: syncSummary(now),
    failover: failoverSummary(now),
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
  // Filter on the call's own account: a session that switched mid-run then
  // shows up under each account for exactly the part it billed there.
  if (accountUuid === UNATTRIBUTED) return { clause: `${prefix} e.account_uuid IS NULL`, params: {} };
  return { clause: `${prefix} e.account_uuid = @acct`, params: { acct: accountUuid } };
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
      FROM events e
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
  const rows = db().prepare(`
    SELECT s.session_id, s.project, s.cwd, s.git_branch, s.first_ts, s.last_ts,
           s.account_uuid, s.account_source, s.version, s.config_dir,
           COALESCE(SUM(e.cost_usd), 0) AS cost,
           COUNT(e.call_id) AS events,
           COALESCE(SUM(e.input_tokens + e.output_tokens + e.cache_write_5m + e.cache_write_1h + e.cache_read), 0) AS tokens
      FROM sessions s LEFT JOIN events e ON e.session_id = s.session_id
      ${where}
     GROUP BY s.session_id
     HAVING events > 0
     ORDER BY s.last_ts DESC LIMIT @limit`).all({ limit, ...params });
  // A session that switched accounts billed each for part of it - list both.
  const split = db().prepare(`SELECT account_uuid a, SUM(cost_usd) c FROM events
     WHERE session_id = ? GROUP BY account_uuid ORDER BY MIN(ts)`);
  for (const r of rows) {
    r.accounts = split.all(r.session_id).map((x) => ({ accountUuid: x.a, cost: x.c }));
    r.machine = machineNameOf(r.config_dir);
  }
  return rows;
}

/**
 * Claude Code processes running right now, on this machine and on every synced
 * machine still reporting, each with the account it is running as *at this
 * moment*. Another machine's sessions carry its name in `machine`.
 */
export function liveSessions(now = Date.now()) {
  const out = localSessions(now);
  const byUuid = new Map(db().prepare('SELECT * FROM accounts').all().map((a) => [a.account_uuid, a]));
  for (const m of remoteMachines(now)) {
    for (const s of m.running) {
      const acct = s.accountUuid ? byUuid.get(s.accountUuid) : null;
      out.push({ ...s, account: acct ? accountLabel(acct) : s.account, machine: m.name });
    }
  }
  return out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/** When a session's transcript in `profile` was last written, if it is there. */
function transcriptWritten(profile, sessionId) {
  let slugs = [];
  try { slugs = fs.readdirSync(profile.projectsDir); } catch { return 0; }
  for (const slug of slugs) {
    try { return fs.statSync(path.join(profile.projectsDir, slug, `${sessionId}.jsonl`)).mtimeMs; } catch { /* not here */ }
  }
  return 0;
}

/**
 * Every live process in the profiles' running-session registries, once each.
 *
 * A copied profile carries a copy of the registry, naming processes that run
 * under the original. A process belongs to the profile whose entry it updated
 * last - or, if that cannot tell them apart, whose transcript it is writing.
 */
function runningEntries() {
  const byPid = new Map();
  for (const profile of discoverProfiles()) {
    let names = [];
    try { names = fs.readdirSync(profile.sessionsDir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(profile.sessionsDir, n), 'utf8')); } catch { continue; }
      if (!s.sessionId) continue;
      // The registry keeps entries for exited processes; drop anything whose pid is gone.
      try { process.kill(s.pid, 0); } catch { continue; }
      const prev = byPid.get(s.pid);
      const e = { profile, s };
      if (!prev) { byPid.set(s.pid, e); continue; }
      const d = (s.updatedAt ?? 0) - (prev.s.updatedAt ?? 0)
        || transcriptWritten(profile, s.sessionId) - transcriptWritten(prev.profile, prev.s.sessionId);
      if (d > 0) byPid.set(s.pid, e);
    }
  }
  return byPid.values();
}

/**
 * Claude Code processes running on this machine, across every profile.
 *
 * A session's current account is decided by the same rules its calls are
 * billed by - the newest of its own records and its profile's latest login - so
 * a /login typed into one session shows on every session it moved.
 */
export function localSessions(now = Date.now()) {
  const d = db();
  const acctRows = d.prepare('SELECT * FROM accounts').all();
  const byUuid = new Map(acctRows.map((a) => [a.account_uuid, a]));

  // Prefix match written as a range so it can use the index - LIKE 'x%' can't
  // here, and forced a full scan of every call for every running session.
  const lastIdentity = d.prepare(`SELECT session_id sid, ts FROM identity_points
     WHERE session_id >= ? AND session_id < ? || '~' ORDER BY ts DESC LIMIT 1`);
  const recent = d.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, MAX(ts) last
     FROM events WHERE session_id >= ? AND session_id < ? || '~' AND ts >= ?`);
  const lastCall = d.prepare(`SELECT session_id sid, MAX(ts) last FROM events WHERE session_id >= ? AND session_id < ? || '~'`);
  const who = accountResolver();

  const out = [];
  const signedInTo = new Map();
  for (const { profile, s } of runningEntries()) {
    if (!signedInTo.has(profile.dir)) signedInTo.set(profile.dir, profileAccount(profile));
    const signedIn = signedInTo.get(profile.dir);
    // A parked job writes its transcript under its job id, not the host session's.
    const keys = [s.sessionId, s.parkedJobId].filter(Boolean);
    // The transcript's own id: whichever key has the newest record or call.
    let sid = null, seen = -Infinity;
    for (const k of keys) {
      for (const r of [lastIdentity.get(k, k), lastCall.get(k, k)]) {
        const ts = r?.ts ?? r?.last;
        if (r?.sid && ts > seen) { sid = r.sid; seen = ts; }
      }
    }
    let acct = null, source = null;
    if (sid) {
      const [uuid, src] = who(sid, profile.dir, now);
      if (uuid) { acct = byUuid.get(uuid) ?? { account_uuid: uuid }; source = src; }
    }
    if (!acct && signedIn) { acct = byUuid.get(signedIn.accountUuid); source = 'profile'; }

    let calls = 0, cost = 0, last = null;
    for (const k of keys) {
      const r = recent.get(k, k, now - 5 * 60_000);
      calls += r.calls; cost += r.cost;
      const lc = lastCall.get(k, k).last;
      if (lc && (!last || lc > last)) last = lc;
    }

    out.push({
      sessionId: s.sessionId, pid: s.pid, cwd: s.cwd, name: s.name,
      status: s.status, kind: s.kind, background: !!s.parkedJobId,
      startedAt: s.startedAt, updatedAt: s.updatedAt,
      lastCallAt: last,
      lastActivityAt: Math.max(s.updatedAt ?? 0, last ?? 0) || null,
      profile: profile.name,
      profileDir: profile.dir,
      transcriptId: sid,
      accountUuid: acct?.account_uuid ?? null,
      account: acct ? accountLabel(acct) : null,
      accountSource: source,
      recent: { calls, cost, perHour: cost * 12 },
      machine: null,
    });
  }
  return out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/** Each profile on this machine and who is signed into it, as other machines are told. */
export function profileStates() {
  return discoverProfiles().map((p) => {
    const a = profileAccount(p);
    return { name: p.name, dir: tildify(p.dir), isDefault: p.isDefault, accountUuid: a?.accountUuid ?? null, email: a?.email ?? null };
  });
}

/** What this machine tells the machines it syncs with. */
export function localState() {
  const f = failoverSummary();
  return {
    running: localSessions(), profiles: profileStates(),
    failover: {
      mode: f.mode, at: f.at, best: f.plan?.best ? { label: f.plan.best.label, room: f.plan.best.room } : null,
      entries: (f.plan?.entries ?? []).map((e) => ({
        profile: e.profile, label: e.label, level: e.level, due: e.due, out: e.out, sessions: e.sessions,
        target: e.target && { label: e.target.label, room: e.target.room, shown: e.target.shown },
      })),
      switches: f.switches.map((m) => ({ ts: m.ts, profile: m.profile, from: m.from, to: m.to, status: m.status })),
    },
  };
}

/**
 * Failing over, for the dashboards: this machine's settings, the plan the
 * service last worked out, its switches today, and every other machine's plan
 * and switches as they last reported them.
 */
function failoverSummary(now = Date.now()) {
  let cached = null;
  try { cached = JSON.parse(getMeta('failover_plan') ?? 'null'); } catch { /* none yet */ }
  const names = new Map(db().prepare('SELECT account_uuid, email, label FROM accounts').all().map((a) => [a.account_uuid, a.label ?? a.email]));
  const switches = recentSwitches(now - 24 * 3600e3).map((m) => ({
    ts: m.ts, profile: tildify(m.profile), from: names.get(m.from_account) ?? m.from_account,
    to: names.get(m.to_account) ?? m.to_account, status: m.status, error: m.error,
  }));
  const remote = remoteMachines(now).filter((m) => m.failover).map((m) => ({ machine: m.name, ...m.failover }));
  return { ...failoverSettings(), plan: cached, switches, remote };
}

/**
 * This machine's name, the machines it syncs with, how reaching them is going,
 * and who is signed into each one's main profile (machine null: this one).
 */
function syncSummary(now) {
  const peers = listPeers().map((p) => ({ target: p.target, status: p.status, error: p.error, at: p.status_at }));
  const remote = remoteMachines(now);
  const machines = remote.map(({ id, name, online, lastSeen }) => ({ id, name, online, lastSeen }));
  const signedIn = [];
  const main = profileStates().find((p) => p.isDefault);
  if (main?.accountUuid) signedIn.push({ machine: null, accountUuid: main.accountUuid });
  for (const m of remote) {
    const p = m.profiles.find((x) => x.isDefault);
    if (p?.accountUuid) signedIn.push({ machine: m.name, accountUuid: p.accountUuid });
  }
  return { name: machine().name, machines, peers, signedIn };
}

/**
 * Where each account is in use: signed into a machine's main profile, or
 * billing a session running there. Account -> machine names, null for this
 * machine and listed first. Takes the running sessions the caller already
 * has, rather than reading them all again.
 */
export function inUse(ov, live) {
  const out = new Map();
  const add = (acct, m) => {
    if (!acct) return;
    const list = out.get(acct) ?? [];
    if (!list.includes(m)) list.push(m);
    out.set(acct, list);
  };
  for (const p of ov.sync?.signedIn ?? []) add(p.accountUuid, p.machine);
  for (const s of live) add(s.accountUuid, s.machine ?? null);
  for (const list of out.values()) list.sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  return out;
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
      FROM events e
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
