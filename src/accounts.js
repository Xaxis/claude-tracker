import fs from 'node:fs';
import path from 'node:path';
import { discoverProfiles } from './paths.js';
import { db, tx } from './db.js';
import { accountAggregates } from './aggregates.js';

/**
 * Account identity and attribution.
 *
 * The strongest signal is the profile a session was recorded under. A Claude
 * config directory holds exactly one signed-in account at a time, so the
 * directory a transcript lives in names its owner - no inference needed. Each
 * profile's config and its rotating backups give a dated timeline of which
 * account was signed into it, which dates older sessions too.
 *
 * In order of authority:
 *
 * Per-call attribution (attributeEvents) weighs, strongest first: the session's
 * own signed-in records, observed logins, refusal consensus, bridge records, and
 * other sessions in the profile - see createResolver. Session-level attribution
 * (attributeSessions) is the older, coarser answer, kept as a last resort.
 *
 * Sessions that remain ambiguous are left unattributed rather than guessed at,
 * so the dashboard can show honestly how much is unaccounted for.
 */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function accountFromConfig(cfg, configDir = null) {
  const o = cfg?.oauthAccount;
  if (!o?.accountUuid) return null;
  return {
    accountUuid: o.accountUuid,
    email: o.emailAddress ?? null,
    displayName: o.displayName ?? o.fullName ?? null,
    orgUuid: o.organizationUuid ?? null,
    orgName: o.organizationName ?? null,
    rateLimitTier: o.organizationRateLimitTier ?? o.userRateLimitTier ?? null,
    orgType: o.organizationType ?? null,
    billingType: o.billingType ?? null,
    subscriptionAt: o.subscriptionCreatedAt ?? o.accountCreatedAt ?? null,
    configDir,
  };
}

/** The account signed into a profile right now. */
export function profileAccount(profile) {
  if (!profile?.configFile) return null;
  return accountFromConfig(readJson(profile.configFile), profile.dir);
}

/**
 * The account signed into the default profile right now - "who am I" for the
 * status line. With several profiles this is only one of them.
 */
export function currentAccount() {
  const profiles = discoverProfiles();
  const def = profiles.find((p) => p.isDefault) ?? profiles[0];
  return def ? profileAccount(def) : null;
}

/**
 * Account sightings recovered from a profile's rotating config backups. Each
 * backup is a dated snapshot of who was signed into that profile, which is what
 * makes it possible to attribute sessions from before the tracker existed.
 */
function backupObservations(profile) {
  const out = [];
  // A backup is a full config snapshot, so it carries the same identity and
  // billing fields as a live one. That is the only way to recover details for
  // an account that has since been signed out - or replaced in that profile.
  const take = (file, ts) => {
    const account = accountFromConfig(readJson(file), profile.dir);
    if (account) out.push({ ts, account, source: 'backup' });
  };
  let names = [];
  try { names = fs.readdirSync(profile.backupsDir); } catch { /* none */ }
  for (const n of names) {
    const m = /\.claude\.json\.backup\.(\d+)$/.exec(n);
    if (m) take(path.join(profile.backupsDir, n), Number(m[1]));
  }
  // Claude Code also leaves `<config>.backup` beside the config itself.
  if (profile.configFile) {
    const dir = path.dirname(profile.configFile), base = path.basename(profile.configFile);
    let siblings = [];
    try { siblings = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.backup`)); } catch { /* none */ }
    for (const n of siblings) {
      const file = path.join(dir, n);
      const m = /\.backup\.(\d+)$/.exec(n);
      let ts = m ? Number(m[1]) : null;
      if (!ts) { try { ts = Math.floor(fs.statSync(file).mtimeMs); } catch { continue; } }
      take(file, ts);
    }
  }
  return out;
}

/** Record that `account` was signed into a profile at `ts`. */
export function observeAccount(account, ts = Date.now(), source = 'watch') {
  if (!account?.accountUuid) return false;
  const dir = account.configDir ?? '';
  // A change of account is always recorded; otherwise one heartbeat every 10
  // minutes - enough to prove the profile was being watched in between (see
  // createResolver), without a row on every refresh.
  const last = db().prepare(`SELECT account_uuid, ts FROM account_observations
    WHERE config_dir = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(dir, ts);
  const changed = last?.account_uuid !== account.accountUuid;
  if (changed || ts - (last?.ts ?? 0) > 10 * 60_000) {
    db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, email, source)
                  VALUES (?,?,?,?,?) ON CONFLICT(ts, config_dir) DO NOTHING`)
      .run(ts, dir, account.accountUuid, account.email ?? null, source);
  }
  upsertAccount(account, ts);
  return changed;
}

export function upsertAccount(a, ts = Date.now()) {
  if (!a?.accountUuid) return;
  db().prepare(`
    INSERT INTO accounts (account_uuid, email, display_name, org_uuid, org_name,
                          rate_limit_tier, subscription_type, billing_type,
                          subscription_at, config_dir, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_uuid) DO UPDATE SET
      email             = COALESCE(excluded.email, accounts.email),
      display_name      = COALESCE(excluded.display_name, accounts.display_name),
      org_uuid          = COALESCE(excluded.org_uuid, accounts.org_uuid),
      org_name          = COALESCE(excluded.org_name, accounts.org_name),
      rate_limit_tier   = COALESCE(excluded.rate_limit_tier, accounts.rate_limit_tier),
      subscription_type = COALESCE(excluded.subscription_type, accounts.subscription_type),
      billing_type      = COALESCE(excluded.billing_type, accounts.billing_type),
      subscription_at   = COALESCE(excluded.subscription_at, accounts.subscription_at),
      config_dir        = COALESCE(excluded.config_dir, accounts.config_dir),
      first_seen        = MIN(COALESCE(accounts.first_seen, excluded.first_seen), excluded.first_seen),
      last_seen         = MAX(COALESCE(accounts.last_seen, excluded.last_seen), excluded.last_seen)
  `).run(a.accountUuid, a.email ?? null, a.displayName ?? null, a.orgUuid ?? null,
         a.orgName ?? null, a.rateLimitTier ?? null, a.subscriptionType ?? null,
         a.billingType ?? null, a.subscriptionAt ?? null, a.configDir ?? null, ts, ts);
}

/**
 * Learn every account from every profile: who is signed in now, and - from each
 * profile's config backups - who was signed in before. Runs on every refresh, so
 * signing a new account into a new config directory surfaces it automatically.
 */
export function discoverAccounts() {
  const d = db();
  const profiles = discoverProfiles();
  const seen = [];

  tx(() => {
    for (const profile of profiles) {
      const cur = profileAccount(profile);
      if (cur) {
        upsertAccount(cur);
        observeAccount(cur, Date.now(), 'config');
        seen.push(cur);
      }

      for (const o of backupObservations(profile)) {
        d.prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, email, source)
                   VALUES (?,?,?,?,?) ON CONFLICT(ts, config_dir) DO NOTHING`)
          .run(o.ts, o.account.configDir ?? '', o.account.accountUuid, o.account.email, o.source);
        upsertAccount(o.account, o.ts);
      }

      // groveConfigCache keys are account UUIDs this profile's CLI has talked to.
      const cfg = profile.configFile ? readJson(profile.configFile) : null;
      for (const [uuid, v] of Object.entries(cfg?.groveConfigCache ?? {})) {
        upsertAccount({ accountUuid: uuid }, v?.timestamp ?? Date.now());
      }
    }
  });

  return { profiles: profiles.length, signedIn: seen.length };
}

/**
 * Intervals during which an account provably could not serve requests, taken
 * from the API's own rejections: from the moment it refused until the reset it
 * named. Usage inside one of these cannot belong to that account, which is the
 * strongest attribution signal available - hitting a limit is exactly when you
 * switch accounts, and it is exactly when naive nearest-anchor inference would
 * otherwise keep assigning the new work to the account you just left.
 */
function blockedIntervals() {
  const byAccount = new Map();
  for (const r of db().prepare(`
      SELECT account_uuid, MIN(ts) AS from_ts, resets_at
        FROM limit_events
       WHERE status = 'rejected' AND account_uuid IS NOT NULL
       GROUP BY account_uuid, limit_type, resets_at`).all()) {
    if (!byAccount.has(r.account_uuid)) byAccount.set(r.account_uuid, []);
    byAccount.get(r.account_uuid).push([r.from_ts, r.resets_at * 1000]);
  }
  return byAccount;
}

/**
 * Assign an account to every session that lacks one.
 *
 * Anchors are moments we know the active account: bridge-attributed sessions and
 * recorded observations. A session is inferred only when the anchors on both
 * sides agree, which keeps switch-boundary sessions from being misattributed,
 * and never when the candidate account was rate limited at the time.
 */
export function attributeSessions() {
  const d = db();
  const blocked = blockedIntervals();
  const isBlocked = (account, t) =>
    (blocked.get(account) ?? []).some(([from, until]) => t >= from && t <= until);

  /*
   * Per-profile timelines: who was signed into this config directory, and when.
   *
   * Built from every dated piece of evidence, not just config snapshots. Those
   * rotate away within hours, so on a first run they often cover only the last
   * few minutes - and treating that as the whole history credits months of past
   * usage to whoever signed in most recently. Sessions that state their own
   * owner (a bridge record, or a recorded signed-in email) are dated evidence
   * about the same profile, and they reach back as far as the transcripts do.
   */
  const points = [];
  for (const r of d.prepare(
      'SELECT ts, config_dir, account_uuid FROM account_observations').all()) {
    if (r.config_dir) points.push({ dir: r.config_dir, ts: r.ts, account: r.account_uuid });
  }
  for (const r of d.prepare(`
      SELECT first_ts, last_ts, config_dir, account_uuid FROM sessions
       WHERE config_dir IS NOT NULL AND account_uuid IS NOT NULL
         AND account_source IN ('bridge', 'email') AND first_ts IS NOT NULL`).all()) {
    points.push({ dir: r.config_dir, ts: r.first_ts, account: r.account_uuid });
    if (r.last_ts) points.push({ dir: r.config_dir, ts: r.last_ts, account: r.account_uuid });
  }

  const timelines = new Map();
  for (const p of points.sort((a, b) => a.ts - b.ts)) {
    if (!timelines.has(p.dir)) timelines.set(p.dir, []);
    const tl = timelines.get(p.dir);
    // Collapse runs: only the moments the account actually changed matter.
    if (!tl.length || tl[tl.length - 1].account !== p.account) {
      tl.push({ ts: p.ts, account: p.account });
    }
  }

  /**
   * Which account was signed into `dir` at time `t`.
   *
   * Crucially this does NOT extrapolate backwards past the earliest observation
   * unless the profile has only ever held one account. Config backups rotate -
   * a handful of recent snapshots is all that survives - so the earliest thing
   * we can see may be an account that signed in long after the sessions being
   * dated. Assuming it applies backwards silently credits months of history to
   * whoever logged in most recently.
   */
  const accountAt = (dir, t) => {
    const tl = timelines.get(dir);
    if (!tl?.length) return null;
    let hit = null;
    for (const entry of tl) {
      if (entry.ts <= t) hit = entry.account;
      else break;
    }
    if (hit) return hit;
    // Before the first snapshot: safe only if this profile has never held more
    // than one account, in which case there is nothing to confuse it with.
    const distinct = new Set(tl.map((e) => e.account));
    return distinct.size === 1 ? tl[0].account : null;
  };

  // A session that recorded the signed-in email names its own account outright.
  const byEmail = new Map(
    d.prepare('SELECT LOWER(email) e, account_uuid a FROM accounts WHERE email IS NOT NULL')
      .all().map((r) => [r.e, r.a]));

  // Global anchors, for sessions whose profile has no timeline at all.
  const anchors = [];
  for (const r of d.prepare(`
      SELECT first_ts, last_ts, account_uuid FROM sessions
      WHERE account_uuid IS NOT NULL AND account_source = 'bridge'
        AND first_ts IS NOT NULL`).all()) {
    anchors.push({ ts: r.first_ts, account: r.account_uuid });
    if (r.last_ts) anchors.push({ ts: r.last_ts, account: r.account_uuid });
  }
  for (const r of d.prepare('SELECT ts, account_uuid FROM account_observations').all()) {
    anchors.push({ ts: r.ts, account: r.account_uuid });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const times = anchors.map((a) => a.ts);
  const bisect = (t) => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const pending = d.prepare(`
    SELECT session_id, first_ts, config_dir, user_email FROM sessions
    WHERE (account_uuid IS NULL OR account_source IN ('inferred', 'profile', 'email'))
      AND first_ts IS NOT NULL`).all();

  const upd = d.prepare('UPDATE sessions SET account_uuid = ?, account_source = ? WHERE session_id = ?');
  const counts = { email: 0, profile: 0, inferred: 0, ambiguous: 0 };

  tx(() => {
    for (const s of pending) {
      // The session recorded the address it was signed in as - unambiguous.
      const fromEmail = s.user_email ? byEmail.get(s.user_email.toLowerCase()) : null;
      if (fromEmail) {
        upd.run(fromEmail, 'email', s.session_id);
        counts.email++;
        continue;
      }

      // Otherwise the profile the session was recorded under names its account.
      const fromProfile = s.config_dir ? accountAt(s.config_dir, s.first_ts) : null;
      if (fromProfile) {
        upd.run(fromProfile, 'profile', s.session_id);
        counts.profile++;
        continue;
      }

      const i = bisect(s.first_ts);
      const before = i > 0 ? anchors[i - 1] : null;
      const after = i < anchors.length ? anchors[i] : null;
      let account = null;
      if (before && after) {
        if (before.account === after.account) account = before.account;
      } else if (before) {
        account = before.account;     // after the last anchor: still that account
      } else if (after) {
        account = after.account;      // before the first anchor: best available
      }

      // A rate-limited account cannot have produced this usage. Fall back to the
      // nearest anchor that was actually able to serve requests at the time.
      if (account && isBlocked(account, s.first_ts)) {
        account = null;
        for (let step = 1; step < anchors.length; step++) {
          for (const cand of [anchors[i - 1 - step], anchors[i + step]]) {
            if (!cand || account) continue;
            if (!isBlocked(cand.account, s.first_ts)) account = cand.account;
          }
          if (account) break;
        }
      }

      if (account) { upd.run(account, 'inferred', s.session_id); counts.inferred++; }
      else { upd.run(null, null, s.session_id); counts.ambiguous++; }
    }
  });

  return { ...counts, anchors: anchors.length, profiles: timelines.size };
}

/**
 * Build a resolver for "which account made this call?".
 *
 * A session is not tied to one account. Running sessions follow a /login onto
 * the new account mid-run, writing a fresh session_context record at that exact
 * moment; background jobs keep their own identity even after the profile they
 * run under switches. So the question is answered per call, at its timestamp:
 *
 *   1. session  - the latest identity record inside that same session.
 *   2. profile  - who was signed into the call's config directory then.
 *   3. inferred - the session-level answer from attributeSessions().
 */
let resolverCache = { sig: null, fn: null };

/** Cheap fingerprint of everything the resolver is built from. */
function resolverSignature(d) {
  const a = d.prepare('SELECT COUNT(*) n, MAX(ts) m FROM identity_points').get();
  const b = d.prepare('SELECT COUNT(*) n, MAX(ts) m FROM account_observations').get();
  const c = d.prepare('SELECT COUNT(*) n, COUNT(email) e FROM accounts').get();
  const s = d.prepare('SELECT COUNT(*) n, COUNT(account_uuid) k FROM sessions').get();
  const l = d.prepare('SELECT COUNT(*) n, MAX(ts) m FROM limit_events').get();
  // Readings matter per session and window, not per reading.
  const u = d.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT session_id, limit_type, resets_at FROM utilization)').get();
  return `${a.n}:${a.m}|${b.n}:${b.m}|${c.n}:${c.e}|${s.n}:${s.k}|${l.n}:${l.m}|${u.n}`;
}

function buildResolver() {
  const d = db();
  const sig = resolverSignature(d);
  if (resolverCache.sig === sig) return resolverCache.fn;
  const fn = createResolver(d);
  resolverCache = { sig, fn };
  return fn;
}

function createResolver(d) {
  const byEmail = new Map(d.prepare(
    'SELECT LOWER(email) e, account_uuid a FROM accounts WHERE email IS NOT NULL').all().map((r) => [r.e, r.a]));
  const sessionDir = new Map(d.prepare('SELECT session_id, config_dir FROM sessions').all()
    .map((r) => [r.session_id, r.config_dir]));

  /*
   * Evidence, by kind:
   *
   *   S  the session's own context records (the signed-in email, written at
   *      start and again when a /login is typed into that session), plus the
   *      refusals and status-line readings those corroborate;
   *   O  who was seen signed into the profile, while the tracker watched;
   *   C  refusal and reading consensus (below);
   *   F  the profile's switches: every session's first record, and every record
   *      that changed account. A /login moves every session in the profile, not
   *      just the one it was typed into - sessions refused together have been
   *      seen carrying on at once under the account just signed in, though only
   *      one of them recorded it;
   *   W  bridge records, which name the account a session's remote-control
   *      bridge registered with and can be days out of date.
   *
   * The newest evidence at or before a call decides, so a session follows its
   * profile's latest login unless its own records are more recent. S, C and O
   * keep every point; F and W only the moments the account changed, since their
   * repeats confirm nothing.
   */
  const push = (map, key, ts, account) => {
    if (!account || key == null || ts == null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ts, account });
  };
  const sortAll = (map) => { for (const tl of map.values()) tl.sort((a, b) => a.ts - b.ts); };
  const collapse = (map) => {
    for (const [k, tl] of map) {
      tl.sort((a, b) => a.ts - b.ts);
      map.set(k, tl.filter((e, i) => i === 0 || e.account !== tl[i - 1].account));
    }
  };
  const latest = (tl, t) => {
    if (!tl?.length) return null;
    let lo = 0, hi = tl.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tl[m].ts <= t) lo = m + 1; else hi = m; }
    return lo ? tl[lo - 1] : null;
  };
  const firstAfter = (tl, t) => {
    if (!tl?.length) return -1;
    let lo = 0, hi = tl.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tl[m].ts <= t) lo = m + 1; else hi = m; }
    return lo < tl.length ? lo : -1;
  };
  // Does the timeline name anyone but `acct` between `from` and `to`?
  const namesOther = (tl, from, to, acct) => {
    for (let i = firstAfter(tl, from - 1); i !== -1 && i < tl.length && tl[i].ts <= to; i++) {
      if (tl[i].account !== acct) return true;
    }
    return false;
  };
  // Before the first record, a timeline only speaks if it never names anyone else.
  const soleAccount = (tl) => (tl?.length && tl.every((e) => e.account === tl[0].account) ? tl[0] : null);

  const S = new Map(), W = new Map(), O = new Map(), C = new Map(), F = new Map();
  const prev = new Map();
  for (const r of d.prepare('SELECT session_id, ts, email, account_uuid, source FROM identity_points ORDER BY ts').all()) {
    const acct = r.account_uuid ?? (r.email ? byEmail.get(r.email.toLowerCase()) : null);
    if (!acct) continue;
    push(r.source === 'context' ? S : W, r.session_id, r.ts, acct);
    const k = `${r.source}|${r.session_id}`;
    if (prev.get(k) === acct) continue;
    prev.set(k, acct);
    const dir = sessionDir.get(r.session_id);
    if (dir) push(F, dir, r.ts, acct);
  }
  for (const r of d.prepare("SELECT ts, config_dir, account_uuid FROM account_observations WHERE config_dir != '' ORDER BY ts").all()) {
    push(O, r.config_dir, r.ts, r.account_uuid);
  }
  sortAll(S); sortAll(O); collapse(W); collapse(F);
  // The session's own records, before refusals and readings add to S.
  const own = new Map([...S].map(([k, tl]) => [k, tl.slice()]));

  // A sighting vouches for a profile only while it was being watched. The
  // tracker records one at least every 10 minutes while it runs, so a longer gap
  // means nobody was looking - and an isolated old snapshot must not claim
  // months of history it knows nothing about.
  const OBS_GAP = 25 * 60_000;
  const observedAt = (dir, t) => {
    if (!dir) return null;
    const e = latest(O.get(dir), t);
    return e && t - e.ts <= OBS_GAP ? e : null;
  };
  // When each watched login began: a change of account, or the first sighting after a gap.
  const OC = new Map();
  for (const [dir, tl] of O) {
    OC.set(dir, tl.filter((e, i) => i === 0 || e.account !== tl[i - 1].account || e.ts - tl[i - 1].ts > OBS_GAP));
  }

  const WEIGHT = { S: 3, O: 2, W: 1, F: 0.5 };
  // Everything known about a session at `t`, newest first; ties go to the
  // stronger kind, listed first.
  const evidence = (sid, dir, t, consensus = true) => {
    const o = observedAt(dir, t);
    return [
      [latest(S.get(sid), t), 'session', WEIGHT.S],
      [o && { ts: latest(OC.get(dir), t)?.ts ?? o.ts, account: o.account }, 'profile', WEIGHT.O],
      [consensus ? latest(C.get(sid), t) : null, 'consensus', WEIGHT.W],
      [dir ? latest(F.get(dir), t) : null, 'profile', WEIGHT.F],
      [latest(W.get(sid), t), 'bridge', WEIGHT.W],
    ].filter(([e]) => e).sort((a, b) => b[0].ts - a[0].ts);
  };

  /*
   * Refusals and status-line readings. Every session on an account is refused -
   * and reads - with that account's reset time, so a (limit, reset) pair names
   * exactly one account, whatever each session's own stale records claim. Each
   * group is settled by vote, most certain first, within what is possible: an
   * account never holds two overlapping windows of one kind, and an account
   * that is blocked cannot take the call that opens a five-hour window.
   */
  const spanOf = (type) => (type === 'five_hour' ? 5 * 3600e3 : 7 * 86400e3);
  const SLOT = 10 * 60e3;     // a five-hour window starts on the 10-minute boundary before its first call
  const GRACE = 60e3;         // requests already in flight when a refusal lands still complete
  const groups = new Map();
  const member = (type, resetsAtSec, m) => {
    const key = `${type}|${resetsAtSec}`;
    if (!groups.has(key)) groups.set(key, { key, type, resetsAt: resetsAtSec * 1000, members: [], refusals: [], overage: null });
    const g = groups.get(key);
    g.members.push(m);
    return g;
  };
  for (const r of d.prepare(`SELECT l.limit_type, l.resets_at, l.ts, l.session_id, l.overage, s.config_dir
      FROM limit_events l LEFT JOIN sessions s ON s.session_id = l.session_id
      WHERE l.status = 'rejected'`).all()) {
    const m = { sid: r.session_id, dir: r.config_dir, ts: r.ts };
    const g = member(r.limit_type, r.resets_at, m);
    g.refusals.push(m);
    g.overage ??= r.overage;
  }
  for (const r of d.prepare(`SELECT u.limit_type, u.resets_at, u.ts, u.session_id, COALESCE(u.config_dir, s.config_dir) config_dir
      FROM utilization u LEFT JOIN sessions s ON s.session_id = u.session_id
      WHERE u.resets_at IS NOT NULL AND u.limit_type IN ('five_hour', 'seven_day')`).all()) {
    member(r.limit_type, Math.round(r.resets_at / 1000), { sid: r.session_id, dir: r.config_dir, ts: r.ts });
  }
  for (const g of groups.values()) {
    g.members.sort((a, b) => a.ts - b.ts);
    g.refusals.sort((a, b) => a.ts - b.ts);
    const votes = new Map();
    // One vote per session, from the newest evidence at its latest record here.
    for (const m of new Map(g.members.map((x) => [x.sid, x])).values()) {
      const top = evidence(m.sid, m.dir, m.ts, false)[0];
      if (!top) continue;
      const v = votes.get(top[0].account) ?? { total: 0, max: 0 };
      v.total += top[2]; v.max = Math.max(v.max, top[2]);
      votes.set(top[0].account, v);
    }
    g.ranked = [...votes.entries()].sort((a, b) => b[1].max - a[1].max || b[1].total - a[1].total);
    g.strength = g.ranked[0]?.[1].max ?? 0;
    g.start = g.resetsAt - spanOf(g.type);
    g.first = g.members[0].ts;
    // From the refusal to the reset the account served nothing - unless overage
    // was letting calls through.
    g.block = g.refusals.length && !String(g.overage ?? '').startsWith('allowed')
      ? [g.refusals[0].ts, g.resetsAt] : null;
  }

  const owned = new Map();      // `${acct}|${type}` -> its windows
  const opens = new Map();      // acct -> when its five-hour windows opened
  const blocked = new Map();    // acct -> spans it could serve nothing
  const groupAccount = new Map();
  const fits = (acct, g) => {
    if ((owned.get(`${acct}|${g.type}`) ?? []).some(([s0, e0]) => s0 < g.resetsAt && g.start < e0)) return false;
    if (g.type === 'five_hour' && (blocked.get(acct) ?? []).some(([f, u]) => f <= g.start && u >= g.start + SLOT)) return false;
    if (g.block && (opens.get(acct) ?? []).some((s) => g.block[0] <= s && g.block[1] >= s + SLOT)) return false;
    return true;
  };
  const firstCall = d.prepare('SELECT MIN(ts) m FROM events WHERE ts >= ? AND ts <= ? AND +session_id = ?');
  const assign = (g, acct, tier) => {
    const key = `${acct}|${g.type}`;
    if (!owned.has(key)) owned.set(key, []);
    owned.get(key).push([g.start, g.resetsAt]);
    if (g.type === 'five_hour') { if (!opens.has(acct)) opens.set(acct, []); opens.get(acct).push(g.start); }
    if (g.block) { if (!blocked.has(acct)) blocked.set(acct, []); blocked.get(acct).push(g.block); }
    groupAccount.set(g.key, acct);
    for (const m of g.members) push(tier, m.sid, m.ts, acct);
    // A five-hour window opens with a call, so a refused session's calls since
    // it opened were the refused account's too - unless its own records or its
    // watched profile show it arriving there part-way.
    if (g.type !== 'five_hour') return;
    for (const m of new Map([...g.refusals].reverse().map((x) => [x.sid, x])).values()) {
      const c = m.sid ? firstCall.get(g.start, m.ts, m.sid)?.m : null;
      if (c == null || namesOther(own.get(m.sid), c, m.ts, acct) || namesOther(OC.get(m.dir), c, m.ts, acct)) continue;
      push(tier, m.sid, c, acct);
    }
  };
  for (const g of [...groups.values()].sort((a, b) => b.strength - a.strength || a.first - b.first)) {
    const pick = g.ranked.find(([acct]) => fits(acct, g));
    // A refusal corroborated by strong evidence is itself strong evidence.
    if (pick) assign(g, pick[0], pick[1].max >= WEIGHT.O ? S : C);
  }
  // A group nothing could settle goes to the most recent account seen in its
  // profile that could have held the window. Never a later one: history must
  // not drift onto an account signed in afterwards.
  for (const g of [...groups.values()].filter((x) => !groupAccount.has(x.key)).sort((a, b) => a.first - b.first)) {
    const tried = new Set();
    for (const dir of new Set(g.members.map((m) => m.dir).filter(Boolean))) {
      const tl = F.get(dir) ?? [];
      const j = firstAfter(tl, g.first);
      for (let i = (j === -1 ? tl.length : j) - 1; i >= 0 && !groupAccount.has(g.key); i--) {
        const a = tl[i].account;
        if (tried.has(a)) continue;
        tried.add(a);
        if (fits(a, g)) assign(g, a, C);
      }
    }
  }
  sortAll(S); sortAll(C);

  const blockedAt = (acct, t) => (blocked.get(acct) ?? []).some(([f, u]) => t >= f + GRACE && t < u);
  // Did the profile carry on during a block? One that made no calls until the
  // reset simply waited it out, still on the same account.
  const carriedOn = d.prepare('SELECT 1 FROM events WHERE ts >= ? AND ts < ? AND config_dir = ? LIMIT 1');
  const movedCache = new Map();
  const movedDuring = (dir, f, u) => {
    if (!dir) return true;
    const k = `${dir}|${f}|${u}`;
    if (!movedCache.has(k)) movedCache.set(k, !!carriedOn.get(f + GRACE, u, dir));
    return movedCache.get(k);
  };
  // Forced off: the account was refused between this evidence and the call, and
  // either still is, or the profile carried on without it in the meantime.
  const forcedOff = (acct, from, t, dir) => (blocked.get(acct) ?? []).some(([f, u]) =>
    f + GRACE <= t && u > from && (t < u || movedDuring(dir, f, u)));
  // Where a refused session went: the first thing seen of it, or of its
  // profile, after the call that names an account able to serve it.
  const nextAccount = (sid, dir, t, leaving) => {
    let best = null;
    for (const tl of [S.get(sid), C.get(sid), dir && OC.get(dir), dir && F.get(dir), W.get(sid)]) {
      for (let i = firstAfter(tl, t); i !== -1 && i < tl.length; i++) {
        const e = tl[i];
        if (best && e.ts >= best.ts) break;
        if (e.account !== leaving && !blockedAt(e.account, t)) { best = e; break; }
      }
    }
    return best;
  };

  // The first account a session is seen on, for calls made before any record.
  const firstSeen = (sid) => {
    let best = null;
    for (const tl of [S.get(sid), C.get(sid), W.get(sid)]) if (tl?.length && (!best || tl[0].ts < best.ts)) best = tl[0];
    return best;
  };

  const sessionAcct = new Map(d.prepare(
    'SELECT session_id, account_uuid, first_ts FROM sessions WHERE account_uuid IS NOT NULL').all()
    .map((r) => [r.session_id, { account: r.account_uuid, ts: r.first_ts ?? 0 }]));

  const resolve = (sid, dir, t) => {
    const o = observedAt(dir, t);
    for (const [e, src] of evidence(sid, dir, t)) {
      if (!forcedOff(e.account, Math.min(e.ts, t), t, dir)) return [e.account, src];
      // Refused since. A watched profile is the best witness of where the
      // session went - and if it still shows that account, the call was served.
      if (o) return [o.account, o.account === e.account ? 'profile' : 'moved'];
      const n = nextAccount(sid, dir, t, e.account);
      if (n) return [n.account, 'moved'];
    }
    // Nothing usable at or before the call: the first record after it speaks.
    for (const [e, src] of [
      [firstSeen(sid), 'session'], [sessionAcct.get(sid), 'inferred'], [dir ? soleAccount(F.get(dir)) : null, 'profile'],
    ]) {
      if (e && !blockedAt(e.account, t)) return [e.account, src];
    }
    return [null, null];
  };
  resolve.groupAccount = (type, resetsAtSec) => groupAccount.get(`${type}|${resetsAtSec}`) ?? null;
  return resolve;
}

/**
 * Resolve an account for every call that needs one: all unattributed calls,
 * plus everything since `since`. The recent re-check covers the race where calls
 * land a moment before the record announcing the switch that produced them.
 */
export function attributeEvents({ since = 0, all = false, includeNull = true } = {}) {
  const d = db();
  const resolve = buildResolver();
  const cols = 'call_id, session_id, config_dir, ts, account_uuid';
  const rows = all
    ? d.prepare(`SELECT ${cols} FROM events`).all()
    : includeNull
      ? d.prepare(`SELECT ${cols} FROM events WHERE account_uuid IS NULL OR ts >= ?`).all(since)
      : d.prepare(`SELECT ${cols} FROM events WHERE ts >= ?`).all(since);
  const upd = d.prepare('UPDATE events SET account_uuid = ?, account_source = ? WHERE call_id = ?');
  let changed = 0, minChangedTs = Infinity;
  tx(() => {
    for (const r of rows) {
      const [acct, src] = resolve(r.session_id, r.config_dir, r.ts);
      if (acct !== r.account_uuid) { upd.run(acct, src, r.call_id); changed++; minChangedTs = Math.min(minChangedTs, r.ts); }
    }
    // A refusal belongs to the account its whole group was settled on.
    for (const l of d.prepare(`SELECT l.id, l.session_id, l.ts, l.limit_type, l.resets_at, s.config_dir FROM limit_events l
        LEFT JOIN sessions s ON s.session_id = l.session_id
        WHERE ${includeNull || all ? 'l.account_uuid IS NULL OR ' : ''}l.ts >= ?`).all(all ? 0 : since)) {
      const acct = resolve.groupAccount(l.limit_type, l.resets_at) ?? resolve(l.session_id, l.config_dir, l.ts)[0];
      if (acct) d.prepare('UPDATE limit_events SET account_uuid = ? WHERE id = ?').run(acct, l.id);
    }
    // So does a status-line reading: its reset time says whose window it read.
    const updU = d.prepare('UPDATE utilization SET account_uuid = ? WHERE rowid = ?');
    const from = all ? 0 : Math.min(since, Date.now() - 8 * 86400e3);
    for (const u of d.prepare('SELECT rowid id, limit_type, resets_at, account_uuid FROM utilization WHERE resets_at IS NOT NULL AND ts >= ?').all(from)) {
      const acct = resolve.groupAccount(u.limit_type, Math.round(u.resets_at / 1000));
      if (acct && acct !== u.account_uuid) updU.run(acct, u.id);
    }
  });
  return { checked: rows.length, changed, minChangedTs: Number.isFinite(minChangedTs) ? minChangedTs : null };
}

/** The rules calls are billed by, for asking which account a session is on. */
export function accountResolver() {
  return buildResolver();
}

/**
 * Give accounts a human name wherever a session recorded one.
 *
 * Sessions that captured the signed-in email are joined back to their account,
 * so an account named in any one session stops being a bare UUID everywhere.
 * Only firmly attributed sessions are trusted here - naming an account from a
 * guessed session would let one bad inference mislabel it permanently.
 */
export function resolveAccountEmails() {
  const rows = db().prepare(`
    SELECT s.account_uuid, s.user_email, COUNT(*) AS n
      FROM sessions s
     WHERE s.user_email IS NOT NULL AND s.account_uuid IS NOT NULL
       AND s.account_source IN ('bridge', 'profile')
     GROUP BY s.account_uuid, s.user_email
     ORDER BY n DESC`).all();

  const claimed = new Set();
  let named = 0;
  for (const r of rows) {
    if (claimed.has(r.account_uuid)) continue;   // keep the best-supported name
    claimed.add(r.account_uuid);
    db().prepare(`UPDATE accounts SET email = COALESCE(email, ?) WHERE account_uuid = ?`)
      .run(r.user_email, r.account_uuid);
    named++;
  }
  return { named };
}

/** Set a manual display name for an account. Accepts a UUID prefix. */
export function setLabel(prefix, label) {
  const row = db().prepare(
    'SELECT account_uuid FROM accounts WHERE account_uuid LIKE ? || \'%\'').get(prefix);
  if (!row) return null;
  db().prepare('UPDATE accounts SET label = ? WHERE account_uuid = ?')
    .run(label || null, row.account_uuid);
  return row.account_uuid;
}

/** Copy session-level attribution onto limit events, which arrive without one. */
export function attributeLimitEvents() {
  db().exec(`
    UPDATE limit_events
       SET account_uuid = (SELECT s.account_uuid FROM sessions s WHERE s.session_id = limit_events.session_id)
     WHERE account_uuid IS NULL AND session_id IS NOT NULL`);
}

export function listAccounts(agg = accountAggregates()) {
  return db().prepare('SELECT * FROM accounts ORDER BY last_seen DESC').all()
    .map((a) => ({ ...a, sessions: agg.get(a.account_uuid)?.sessions ?? 0 }));
}

/** Human-friendly name for an account, without leaking a full email by default. */
export function accountLabel(row) {
  if (!row) return 'Unattributed';
  if (row.label) return row.label;
  if (row.email) return row.email;
  if (row.display_name) return row.display_name;
  return `${String(row.account_uuid).slice(0, 8)}…`;
}
