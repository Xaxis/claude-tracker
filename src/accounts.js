import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverProfiles } from './paths.js';
import { db, tx } from './db.js';

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
 *   1. bridge   - the transcript states the owner outright.
 *   2. profile  - the profile's account timeline at the session's start.
 *   3. observed - the live watcher recorded who was signed in at that moment.
 *   4. inferred - the session sits between two anchors that agree.
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
 * Subscription tier from the macOS keychain, if it is readable without a prompt.
 * Only the plan descriptors are read - tokens are never stored or logged.
 */
export function keychainTiers() {
  if (process.platform !== 'darwin') return [];
  const out = [];
  for (const service of ['Claude Code-credentials', 'Claude Code-credentials-e5f6a7b8']) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
      });
      const o = JSON.parse(raw)?.claudeAiOauth;
      if (!o) continue;
      out.push({
        service,
        subscriptionType: o.subscriptionType ?? null,
        rateLimitTier: o.rateLimitTier ?? null,
        expiresAt: o.expiresAt ?? null,
      });
    } catch { /* locked, absent, or denied - not required */ }
  }
  return out;
}

/**
 * Account sightings recovered from a profile's rotating config backups. Each
 * backup is a dated snapshot of who was signed into that profile, which is what
 * makes it possible to attribute sessions from before the tracker existed.
 */
function backupObservations(profile) {
  let names = [];
  try { names = fs.readdirSync(profile.backupsDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /\.claude\.json\.backup\.(\d+)$/.exec(n);
    if (!m) continue;
    // A backup is a full config snapshot, so it carries the same identity and
    // billing fields as a live one. That is the only way to recover details for
    // an account that has since been signed out - or replaced in that profile.
    const account = accountFromConfig(readJson(path.join(profile.backupsDir, n)), profile.dir);
    if (account) out.push({ ts: Number(m[1]), account, source: 'backup' });
  }
  return out;
}

/** Record that `account` was signed into a profile at `ts`. */
export function observeAccount(account, ts = Date.now(), source = 'watch') {
  if (!account?.accountUuid) return;
  db().prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, email, source)
                VALUES (?,?,?,?,?) ON CONFLICT(ts, config_dir) DO NOTHING`)
    .run(ts, account.configDir ?? '', account.accountUuid, account.email ?? null, source);
  upsertAccount(account, ts);
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
  const tiers = keychainTiers();
  const seen = [];

  tx(() => {
    for (const profile of profiles) {
      const cur = profileAccount(profile);
      if (cur) {
        // Only trust the keychain's plan fields when there is one entry to read;
        // with several profiles there is no way to tell which entry is whose.
        if (tiers.length === 1) {
          cur.subscriptionType = tiers[0].subscriptionType;
          cur.rateLimitTier ||= tiers[0].rateLimitTier;
        }
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

  // Per-profile timelines: who was signed into this config directory, and when.
  const timelines = new Map();
  for (const r of d.prepare(
      'SELECT ts, config_dir, account_uuid FROM account_observations ORDER BY ts').all()) {
    if (!r.config_dir) continue;
    if (!timelines.has(r.config_dir)) timelines.set(r.config_dir, []);
    const tl = timelines.get(r.config_dir);
    // Collapse runs: only the moments the account actually changed matter.
    if (!tl.length || tl[tl.length - 1].account !== r.account_uuid) {
      tl.push({ ts: r.ts, account: r.account_uuid });
    }
  }

  /** Which account was signed into `dir` at time `t`. */
  const accountAt = (dir, t) => {
    const tl = timelines.get(dir);
    if (!tl?.length) return null;
    let hit = null;
    for (const entry of tl) {
      if (entry.ts <= t) hit = entry.account;
      else break;
    }
    // Before the first snapshot, the earliest known account is the best guess -
    // a profile is normally created for one account and kept for it.
    return hit ?? tl[0].account;
  };

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
    SELECT session_id, first_ts, config_dir FROM sessions
    WHERE (account_uuid IS NULL OR account_source IN ('inferred', 'profile'))
      AND first_ts IS NOT NULL`).all();

  const upd = d.prepare('UPDATE sessions SET account_uuid = ?, account_source = ? WHERE session_id = ?');
  const counts = { profile: 0, inferred: 0, ambiguous: 0 };

  tx(() => {
    for (const s of pending) {
      // The profile the session was recorded under names its account directly.
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

export function listAccounts() {
  return db().prepare(`
    SELECT a.*,
           (SELECT COUNT(*) FROM sessions s WHERE s.account_uuid = a.account_uuid) AS sessions
      FROM accounts a ORDER BY a.last_seen DESC`).all();
}

/** Human-friendly name for an account, without leaking a full email by default. */
export function accountLabel(row) {
  if (!row) return 'Unattributed';
  if (row.label) return row.label;
  if (row.email) return row.email;
  if (row.display_name) return row.display_name;
  return `${String(row.account_uuid).slice(0, 8)}…`;
}
