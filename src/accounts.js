import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLAUDE_JSON, BACKUPS_DIR } from './paths.js';
import { db, tx } from './db.js';

/**
 * Account identity and attribution.
 *
 * Nothing in a transcript names the account that paid for it, except
 * `bridge-session` records. Everything else has to be reconstructed:
 *
 *   1. bridge   - the transcript states the owner outright. Authoritative.
 *   2. observed - the live watcher recorded who was signed in at that moment.
 *   3. inferred - the session sits between two anchors that agree on the account.
 *
 * Sessions that fall between anchors that disagree are left unattributed rather
 * than guessed at, so the dashboard can show honestly how much is unaccounted.
 */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The account currently signed in, per ~/.claude.json. */
export function currentAccount() {
  const cfg = readJson(CLAUDE_JSON);
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
  };
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

/** Account sightings recovered from rotating ~/.claude/backups/.claude.json.* files. */
function backupObservations() {
  let names = [];
  try { names = fs.readdirSync(BACKUPS_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /\.claude\.json\.backup\.(\d+)$/.exec(n);
    if (!m) continue;
    const cfg = readJson(path.join(BACKUPS_DIR, n));
    const o = cfg?.oauthAccount;
    if (o?.accountUuid) {
      out.push({ ts: Number(m[1]), accountUuid: o.accountUuid, email: o.emailAddress ?? null, source: 'backup' });
    }
  }
  return out;
}

/** Record that `account` was signed in at `ts`. */
export function observeAccount(account, ts = Date.now(), source = 'watch') {
  if (!account?.accountUuid) return;
  const d = db();
  d.prepare(`INSERT INTO account_observations (ts, account_uuid, email, source) VALUES (?,?,?,?)
             ON CONFLICT(ts) DO NOTHING`).run(ts, account.accountUuid, account.email ?? null, source);
  upsertAccount(account, ts);
}

export function upsertAccount(a, ts = Date.now()) {
  if (!a?.accountUuid) return;
  db().prepare(`
    INSERT INTO accounts (account_uuid, email, display_name, org_uuid, org_name,
                          rate_limit_tier, subscription_type, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_uuid) DO UPDATE SET
      email             = COALESCE(excluded.email, accounts.email),
      display_name      = COALESCE(excluded.display_name, accounts.display_name),
      org_uuid          = COALESCE(excluded.org_uuid, accounts.org_uuid),
      org_name          = COALESCE(excluded.org_name, accounts.org_name),
      rate_limit_tier   = COALESCE(excluded.rate_limit_tier, accounts.rate_limit_tier),
      subscription_type = COALESCE(excluded.subscription_type, accounts.subscription_type),
      first_seen        = MIN(COALESCE(accounts.first_seen, excluded.first_seen), excluded.first_seen),
      last_seen         = MAX(COALESCE(accounts.last_seen, excluded.last_seen), excluded.last_seen)
  `).run(a.accountUuid, a.email ?? null, a.displayName ?? null, a.orgUuid ?? null,
         a.orgName ?? null, a.rateLimitTier ?? null, a.subscriptionType ?? null, ts, ts);
}

/** Pull in every account we can name from local config, and seed observations. */
export function discoverAccounts() {
  const d = db();
  const cur = currentAccount();
  const tiers = keychainTiers();
  // A single signed-in account maps to the one live keychain entry; extra
  // entries belong to other profiles we cannot name, so only apply when unambiguous.
  if (cur && tiers.length) {
    cur.subscriptionType = tiers[0].subscriptionType;
    cur.rateLimitTier ||= tiers[0].rateLimitTier;
  }

  tx(() => {
    if (cur) { upsertAccount(cur); observeAccount(cur, Date.now(), 'config'); }
    for (const o of backupObservations()) {
      d.prepare(`INSERT INTO account_observations (ts, account_uuid, email, source) VALUES (?,?,?,?)
                 ON CONFLICT(ts) DO NOTHING`).run(o.ts, o.accountUuid, o.email, o.source);
      upsertAccount({ accountUuid: o.accountUuid, email: o.email }, o.ts);
    }
    // groveConfigCache keys are account UUIDs the CLI has talked to.
    const cfg = readJson(CLAUDE_JSON);
    for (const [uuid, v] of Object.entries(cfg?.groveConfigCache ?? {})) {
      upsertAccount({ accountUuid: uuid }, v?.timestamp ?? Date.now());
    }
  });

  return { current: cur, keychain: tiers.length };
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
  if (!anchors.length) return { inferred: 0, ambiguous: 0, anchors: 0 };

  const times = anchors.map((a) => a.ts);
  const bisect = (t) => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const pending = d.prepare(`
    SELECT session_id, first_ts FROM sessions
    WHERE (account_uuid IS NULL OR account_source = 'inferred') AND first_ts IS NOT NULL`).all();

  const upd = d.prepare('UPDATE sessions SET account_uuid = ?, account_source = ? WHERE session_id = ?');
  let inferred = 0, ambiguous = 0;

  tx(() => {
    for (const s of pending) {
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

      if (account) { upd.run(account, 'inferred', s.session_id); inferred++; }
      else { upd.run(null, null, s.session_id); ambiguous++; }
    }
  });

  return { inferred, ambiguous, anchors: anchors.length };
}

/**
 * Give accounts a human name wherever a session recorded one.
 *
 * Sessions that captured the signed-in email are joined back to their account,
 * so an account named in any one session stops being a bare UUID everywhere.
 * Only bridge-attributed sessions are trusted here - naming an account from an
 * inferred session would let one bad guess mislabel it permanently.
 */
export function resolveAccountEmails() {
  const rows = db().prepare(`
    SELECT s.account_uuid, s.user_email, COUNT(*) AS n
      FROM sessions s
     WHERE s.user_email IS NOT NULL AND s.account_uuid IS NOT NULL
       AND s.account_source = 'bridge'
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
