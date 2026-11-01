import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, getMeta, setMeta } from './db.js';
import { discoverProfiles, tildify, HOME, configFileOf } from './paths.js';
import { profileAccount } from './accounts.js';
import { readSignin, writeSignin, switchSignin, withStorageLock, signinHealth } from './signin.js';
import { machine } from './replica.js';

/**
 * Failing over: when the account a profile is signed into runs low, sign the
 * profile into another account with room - what a /login in one of its sessions
 * does - and every session running in it carries on as that account, mid-task.
 *
 * Signing in takes a browser, so it is done once per account, ahead of time,
 * into a spare: `~/.claude-pool-<name>`, a profile that only holds a sign-in
 * while its account is not in use. A switch moves the incoming account's
 * sign-in out of its spare into the profile, and the outgoing one into a spare
 * of its own. Moved, never copied: each token refresh retires the token before
 * it, so a sign-in left in two places would go stale in one of them.
 *
 * The tracker service is the one thing on a machine that switches - never the
 * sessions themselves - and a profile it has just switched is left to settle,
 * so each running low is handled once.
 *
 * How full a profile's account is comes first from the profile's own sessions:
 * their status-line readings and refusals since it was signed in. Those cannot
 * be pinned on the wrong account, as matching readings to accounts by reset time
 * can when two accounts' windows reset together. An account a profile has run
 * out on is spent until its window resets, whatever else claims it has room.
 */

const CORE = ['five_hour', 'seven_day'];
/** A target needs at least this much room in its tightest window to be worth switching to. */
export const MIN_ROOM = 15;
/**
 * Once no spare has that much, every account is nearly used up: rather than
 * stop at the threshold, each account runs to here - just short of being
 * refused - and then on to whichever has the most left.
 */
const LAST_CALL = 98;
/** Less room than this is not worth a switch. */
const LEFTOVER = 2;
/**
 * After a switch, sessions go on using the sign-in they hold for up to ~30s: their
 * readings in that time are still the old account's. Past it, the profile is
 * free to switch again - at once, if the new account turns out to be out too.
 */
const GRACE_MS = 45e3;
/**
 * A sign-in lapses when its refresh token runs out, some weeks after the browser login
 * however often it is refreshed, and every session on it is logged out. A profile moves
 * off one this long before that, and a spare needs twice this left to be switched to.
 */
const LAPSE_MS = 3600e3;
/** A spare running out within this long is named, to be signed in again ahead of time. */
const RENEW_MS = 3 * 86400e3;
export const SPARE_PREFIX = '.claude-pool-';
const MARK = '.claude-tracker-spare';

export function failoverSettings() {
  return {
    mode: getMeta('failover_mode', 'off'),
    at: Number(getMeta('failover_at', '90')),
    waitMin: Number(getMeta('failover_wait', '15')),
    // The account you would rather it switched to, when it has room; null to choose by room.
    prefer: getMeta('failover_prefer', '') || null,
  };
}

export function setFailover({ mode, at, waitMin, prefer }) {
  if (mode) setMeta('failover_mode', mode);
  if (at != null) setMeta('failover_at', String(at));
  if (waitMin != null) setMeta('failover_wait', String(waitMin));
  if (prefer !== undefined) setMeta('failover_prefer', prefer ? String(prefer).toLowerCase() : '');
  return failoverSettings();
}

/** How big an account's plan is, in Pro-sized units: room on a Max 20x goes 20 times as far. */
export function capacity(tier) {
  const m = /max_(\d+)x/.exec(tier ?? '');
  return m ? Number(m[1]) : 1;
}

/** Accounts a profile here was refused on, and until when: they are not switched to before then. */
function spent(now = Date.now()) {
  let all = {};
  try { all = JSON.parse(getMeta('failover_out', '{}')); } catch { /* start over */ }
  return new Map(Object.entries(all).filter(([, until]) => until > now));
}

function markSpent(accountUuid, until) {
  const all = Object.fromEntries(spent());
  all[accountUuid] = Math.max(all[accountUuid] ?? 0, until);
  setMeta('failover_out', JSON.stringify(all));
}

/** When a profile's present sign-in began: its last switch, or the last sighting of it on another account. */
function signedSince(dir, accountUuid) {
  const d = db();
  const switched = d.prepare("SELECT MAX(ts) t FROM switches WHERE profile = ? AND status = 'switched'").get(dir)?.t ?? 0;
  const other = d.prepare('SELECT MAX(ts) t FROM account_observations WHERE config_dir = ? AND account_uuid IS NOT ?').get(dir, accountUuid)?.t ?? 0;
  return Math.max(switched, other);
}

/**
 * What the profile's own sessions say about the account it is signed into now:
 * the latest reading of each open window, and whether they have been refused.
 */
function ownState(dir, since, now) {
  const d = db();
  const from = since + GRACE_MS;
  const latest = new Map();
  for (const r of d.prepare(`SELECT limit_type, pct, resets_at FROM utilization
      WHERE config_dir = ? AND ts > ? AND resets_at > ? AND limit_type IN ('five_hour', 'seven_day') ORDER BY ts`).all(dir, from, now)) {
    latest.set(r.limit_type, r);
  }
  const refused = d.prepare(`SELECT resets_at FROM limit_events
      WHERE config_dir = ? AND ts > ? AND status = 'rejected' AND resets_at * 1000 > ? ORDER BY ts DESC LIMIT 1`).get(dir, from, now);
  if (refused) return { level: 100, out: true, until: refused.resets_at * 1000 };
  if (!latest.size) return null;
  const fullest = [...latest.values()].sort((a, b) => b.pct - a.pct)[0];
  return { level: fullest.pct, out: fullest.pct >= 100, until: fullest.resets_at };
}

/** Room left in an account's tightest window, 0 when it cannot take a request. */
export function headroom(a) {
  if (!a?.available?.now) return 0;
  const core = a.limits.filter((l) => CORE.includes(l.type));
  return core.length ? Math.min(...core.map((l) => 100 - (l.active ? l.percent : 0))) : 100;
}

/** How full an account's fullest window is - 100 when it is out. */
export function level(a) {
  if (!a) return 0;
  if (!a.available.now) return 100;
  return Math.max(0, ...a.limits.filter((l) => CORE.includes(l.type) && l.active).map((l) => l.percent));
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const healthRead = new Map();
/** A profile's signinHealth, read at most once a minute - on a Mac each read is a Keychain call. Undefined when it cannot be read. */
function health(p) {
  const hit = healthRead.get(p.dir);
  if (hit && Date.now() - hit.at < 60e3) return hit.h;
  let h;
  try { h = signinHealth(p); } catch { h = undefined; }
  healthRead.set(p.dir, { at: Date.now(), h });
  return h;
}

/** Less than `ms` left before it runs out. */
const within = (runsOutAt, ms, now = Date.now()) => runsOutAt != null && runsOutAt - now < ms;

/**
 * Among spares equally good, which this machine takes: each machine synced
 * with takes its own turn, so two running low together on one account do not
 * pile onto one spare.
 */
function turnOf(group) {
  if (group.length < 2) return group[0] ?? null;
  const me = machine().id;
  const ids = [me, ...db().prepare('SELECT machine_id FROM sync_machines').all().map((r) => r.machine_id)].sort();
  const sorted = [...group].sort((x, y) => String(x.accountUuid).localeCompare(String(y.accountUuid)));
  return sorted[ids.indexOf(me) % sorted.length];
}

/**
 * This machine's spares: what each is for, the account whose sign-in it holds now if any,
 * and when that runs out. One that has run out, or that Claude Code logged out, holds none:
 * it is `lapsed` until signed in again.
 */
export function spares() {
  let names = [];
  try { names = fs.readdirSync(HOME); } catch { return []; }
  return names.filter((n) => n.startsWith(SPARE_PREFIX)).map((n) => {
    const dir = path.join(HOME, n);
    const mark = readJson(path.join(dir, MARK));
    if (!mark) return null;
    const a = profileAccount({ dir, configFile: configFileOf(dir) });
    const h = health({ dir, isDefault: false });
    const lapsed = !!h && (h.out || within(h.runsOutAt, 0));
    // Tokens that could not be read are given the benefit of the doubt, as before; none at all, or lapsed, are no sign-in.
    const holds = !!a?.accountUuid && h !== null && !lapsed;
    return { dir, shown: tildify(dir), isDefault: false, for: mark.email ?? null, accountUuid: holds ? a.accountUuid : null, email: holds ? a.email ?? null : null,
      runsOutAt: h?.runsOutAt ?? null, longLived: !!h?.longLived, lapsed };
  }).filter(Boolean);
}

/** Make a spare for `email` - empty until a sign-in is put in it. */
export function makeSpare(email, name = email.split('@')[0]) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
  let dir = path.join(HOME, `${SPARE_PREFIX}${base}`);
  for (let i = 2; fs.existsSync(dir) && readJson(path.join(dir, MARK))?.email?.toLowerCase() !== email.toLowerCase(); i++) {
    dir = path.join(HOME, `${SPARE_PREFIX}${base}-${i}`);
  }
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, MARK), JSON.stringify({ email }));
  return { dir, shown: tildify(dir), isDefault: false, for: email, accountUuid: null, email: null };
}

/** The spare an account's sign-in goes into when its profile switches away from it. */
function spareOf(email, list = spares()) {
  const e = email?.toLowerCase();
  return list.find((s) => s.for?.toLowerCase() === e && !s.accountUuid) ?? makeSpare(email ?? 'account@unknown');
}

/**
 * For each profile sessions are running in here: the account it is signed
 * into, how full that is, whether it is due to switch, and to which spare's
 * account. Also the account with the most room that has no spare here, when
 * it would beat every one that has.
 */
export function plan(ov, live, settings = failoverSettings(), now = Date.now(), held = spares(), profiles = discoverProfiles()) {
  const accounts = new Map(ov.accounts.map((a) => [a.accountUuid, a]));
  const tiers = new Map(db().prepare('SELECT account_uuid, rate_limit_tier FROM accounts').all().map((r) => [r.account_uuid, r.rate_limit_tier]));
  const out = spent(now);
  const elsewhere = new Set(live.filter((s) => s.machine).map((s) => s.accountUuid));
  const working = new Map();
  for (const s of live) {
    if (s.machine || !s.profileDir) continue;
    working.set(s.profileDir, (working.get(s.profileDir) ?? 0) + 1);
  }
  const entries = [];
  for (const [dir, sessions] of working) {
    const profile = profiles.find((p) => p.dir === dir);
    const signed = profile && profileAccount(profile);
    if (!signed) continue;
    const a = accounts.get(signed.accountUuid);
    // The profile's own sessions, when they have said anything since it was signed in; else the account's numbers.
    const own = ownState(dir, signedSince(dir, signed.accountUuid), now);
    const lvl = own ? own.level : level(a);
    const isOut = own ? own.out : !!a && !a.available.now;
    // Its sign-in logged out by Claude Code, or about to run out: nothing its sessions can go on with, whatever its room.
    const h = health(profile);
    const lapsing = !!h && (h.out || within(h.runsOutAt, LAPSE_MS, now));
    const stuck = isOut || lapsing;
    // Room weighed by plan size; within 5 points counts as equal and, between
    // equals, one no other machine is using; then this machine's turn among them.
    const rank = (x) => [Math.round(x.room * x.capacity / 5), elsewhere.has(x.accountUuid) ? 0 : 1];
    const usable = held
      .filter((s) => s.accountUuid && s.accountUuid !== signed.accountUuid && !out.has(s.accountUuid) && !within(s.runsOutAt, 2 * LAPSE_MS, now))
      .map((s) => ({ ...s, label: accounts.get(s.accountUuid)?.label ?? s.email, room: headroom(accounts.get(s.accountUuid)), capacity: capacity(tiers.get(s.accountUuid)) }))
      .filter((s) => s.room > LEFTOVER);
    // Nothing with real room left: use this account to the end, then whatever has more than it.
    const scarce = !usable.some((s) => s.room >= MIN_ROOM);
    const at = scarce ? Math.max(settings.at, LAST_CALL) : settings.at;
    // What this account will have left when it switches: worth going to only what has more.
    const left = stuck ? 0 : Math.min(100 - at, Math.max(0, 100 - lvl));
    const options = usable
      .filter((s) => (scarce ? s.room > left + LEFTOVER : s.room >= MIN_ROOM))
      .sort((x, y) => rank(y)[0] - rank(x)[0] || rank(y)[1] - rank(x)[1]);
    // Your pick, while it has room; otherwise the best.
    const picked = settings.prefer && options.find((x) => x.email?.toLowerCase() === settings.prefer);
    const first = picked ? { ...picked, pinned: true }
      : turnOf(options.filter((x) => String(rank(x)) === String(rank(options[0]))));
    // In order: where it goes, then where it goes if that fails.
    const order = first ? [first, ...options.filter((x) => x.accountUuid !== first.accountUuid)] : [];
    // Refused or logged out here, should every one of those fail to switch to: a spare too low to pick still beats that.
    const fallback = stuck ? usable.filter((x) => !order.some((o) => o.accountUuid === x.accountUuid)).sort((x, y) => y.room * y.capacity - x.room * x.capacity) : [];
    // Out, but back within the wait: not worth a switch.
    const freesAt = isOut ? (own?.until ?? a?.available.at ?? null) : null;
    const soon = freesAt != null && freesAt - now < settings.waitMin * 60e3;
    const shape = (t) => ({ accountUuid: t.accountUuid, label: t.label, email: t.email, room: t.room, capacity: t.capacity, dir: t.dir, shown: t.shown, pinned: !!t.pinned });
    entries.push({
      dir, profile: tildify(dir), isDefault: !!profile.isDefault, sessions,
      account: signed.accountUuid, email: signed.email, label: a?.label ?? signed.email ?? signed.accountUuid,
      level: lvl, at, scarce, due: lapsing || ((lvl >= at || isOut) && !soon), out: isOut, freesAt, measured: !!own,
      lapsing, runsOutAt: h?.runsOutAt ?? null,
      // Until when this account is no use, when the profile's own sessions were refused on it.
      spentUntil: own?.out ? own.until : null,
      target: order[0] ? shape(order[0]) : null,
      then: order.slice(1, 4).map(shape),
      // Every spare to try, in turn, when it switches.
      tries: [...order, ...fallback].map(shape),
    });
  }
  const covered = new Set([...held.map((s) => s.accountUuid), ...entries.map((e) => e.account)]);
  const top = Math.max(0, ...entries.map((e) => e.target?.room ?? 0));
  const best = ov.accounts
    .filter((a) => a.available.now && !covered.has(a.accountUuid) && a.email)
    .map((a) => ({ accountUuid: a.accountUuid, label: a.label, email: a.email, room: headroom(a) }))
    .sort((x, y) => y.room - x.room)[0] ?? null;
  return { ...settings, entries, best: best && best.room >= top + 10 ? best : null, notices: notices(entries, held, profiles, out, now) };
}

const day = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * What needs doing by hand for failover to keep working: an account to add
 * when nothing is left to switch to, a spare whose sign-in has run out or soon
 * will, or one that no longer holds a sign-in.
 */
function notices(entries, held, profiles, out, now = Date.now()) {
  const list = [];
  const ADD = 'add another Claude account (a Max plan goes furthest): sign it up at claude.ai, then run claude-tracker pool add <email> --long on this machine';
  for (const e of entries) {
    if (!e.target) {
      const back = [...out.values()].sort((x, y) => x - y)[0] ?? null;
      list.push({ level: 'bad', text: `${e.profile} has nothing left to switch to: every spare here is out, low or empty.`, fix: ADD, until: back });
    } else if (e.scarce) {
      list.push({ level: 'bad', text: `Every account is nearly used up, so ${e.profile} runs each to ${e.at}% before moving on.`, fix: ADD });
    } else if (!e.then.length) {
      list.push({ level: 'warn', text: `${e.profile} has one spare left with room: ${e.target.label}.`, fix: ADD });
    }
  }
  // A spare emptied by a switch is fine while its account is signed into a profile; otherwise its sign-in is gone.
  const signedHere = new Set(profiles.filter((p) => !p.dir.includes(SPARE_PREFIX)).map((p) => profileAccount(p)?.email?.toLowerCase()).filter(Boolean));
  const holding = new Set(held.map((s) => s.email?.toLowerCase()).filter(Boolean));
  // Run out, or soon to: signed in again ahead of time, unless the account has a lasting sign-in here besides.
  const lasting = new Set(held.filter((s) => s.accountUuid && !within(s.runsOutAt, RENEW_MS, now)).map((s) => s.email?.toLowerCase()));
  const renew = new Map();
  let urgent = false;
  for (const s of held) {
    const e = s.for?.toLowerCase();
    if (!e || signedHere.has(e) || lasting.has(e)) continue;
    if (s.lapsed) { renew.set(e, 'ran out'); urgent = true; }
    else if (s.accountUuid && within(s.runsOutAt, RENEW_MS, now) && !renew.has(e)) {
      renew.set(e, `runs out ${day(s.runsOutAt)}`);
      urgent ||= within(s.runsOutAt, 86400e3, now);
    }
  }
  if (renew.size) {
    const names = [...renew.keys()].sort();
    list.push({
      level: urgent ? 'bad' : 'warn',
      text: `Spare sign-ins that have run out or soon will: ${names.map((e) => `${e} (${renew.get(e)})`).join(', ')}. A sign-in lasts some weeks from its login, and failover will not switch to one that has run out.`,
      fix: names.map((e) => `claude-tracker pool add ${e} --long`).join(' && '),
    });
  }
  for (const s of held) {
    const e = s.for?.toLowerCase();
    if (s.accountUuid || !e || signedHere.has(e) || holding.has(e) || renew.has(e)) continue;
    list.push({ level: 'warn', text: `${s.shown} no longer holds a sign-in for ${s.for}.`, fix: `claude-tracker pool add ${s.for} --long` });
  }
  return list;
}

function record(row) {
  db().prepare(`INSERT INTO switches (ts, profile, from_account, to_account, spare, status, error)
    VALUES (@ts, @profile, @from_account, @to_account, @spare, @status, @error)`).run(row);
  return row;
}

/** Switch one profile to the account in `target`'s spare, now. */
export function switchProfile(entry, target) {
  const row = { ts: Date.now(), profile: entry.dir, from_account: entry.account, to_account: target.accountUuid, spare: target.dir, status: 'failed', error: null };
  try {
    const list = spares();
    const spare = list.find((s) => s.dir === target.dir);
    if (!spare?.accountUuid) throw new Error(`${target.shown} no longer holds a sign-in`);
    switchSignin({ dir: entry.dir, isDefault: entry.isDefault, shown: entry.profile }, spare, spareOf(entry.email, list));
    row.status = 'switched';
  } catch (err) {
    row.error = String(err.message ?? err).slice(0, 300);
  } finally {
    healthRead.clear();   // sign-ins moved, or may have
  }
  return record(row);
}

/** Switches made recently, newest first. */
export function recentSwitches(since = Date.now() - 24 * 3600e3) {
  return db().prepare('SELECT * FROM switches WHERE ts >= ? ORDER BY ts DESC LIMIT 50').all(since);
}

/**
 * Carry out the plan: switch every profile that is due and has somewhere to
 * go - once, then leave it to settle. Returns the switches made.
 */
export function runFailover(ov, live, now = Date.now()) {
  const settings = failoverSettings();
  if (settings.mode !== 'auto') return [];
  const settling = db().prepare("SELECT profile FROM switches WHERE ts > ? AND status = 'switched'").all(now - GRACE_MS).map((r) => r.profile);
  const made = [];
  for (const e of plan(ov, live, settings, now).entries) {
    if (!e.due || !e.target || settling.includes(e.dir)) continue;
    // Not to come back to this account before it resets, whatever its numbers say.
    if (e.spentUntil) markSpent(e.account, e.spentUntil);
    // The first that works: a spare that fails to switch to, the next one is tried.
    for (const t of e.tries) {
      const m = { ...switchProfile(e, t), lapsing: e.lapsing };
      made.push(m);
      if (m.status === 'switched') break;
    }
  }
  return made;
}

/* --- long-lived tokens -------------------------------------------------------- */

/** How long a token from `claude setup-token` lasts. */
const LONG_LIVED_MS = 365 * 86400e3;
const LONG_TOKEN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{40,}$/;

/** The plan Claude Code shows and runs a token as - it cannot ask, with only the inference scope. */
const planOf = (tier) => (/max/.test(tier ?? '') ? 'max' : /raven/.test(tier ?? '') ? 'team' : 'pro');

/** Whether Claude Code runs on `token`: one short request, in a scratch profile. */
function works(token) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ct-token-'));
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(process.env.CLAUDE_TRACKER_CLAUDE || 'claude', ['-p', 'Reply with just: ok', '--model', 'haiku'], { env, cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 120e3);
    const done = (ok) => { clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); resolve(ok); };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Keep `email`'s long-lived token, from `claude setup-token`, in a spare. It lasts a year
 * and is never refreshed, so being in two places does not use it up as it would a
 * sign-in: one token is a spare on every machine. It can only run Claude - claude.ai's
 * connectors, Remote Control and Claude in Chrome want a full sign-in.
 */
export async function addToken(email, token, { until = Date.now() + LONG_LIVED_MS, account = null, check = true } = {}) {
  const e = email.toLowerCase();
  const t = String(token ?? '').replace(/\s+/g, '');
  if (!LONG_TOKEN.test(t)) return { error: 'that is not a long-lived token - they start sk-ant-oat' };
  const row = db().prepare('SELECT account_uuid, email, org_uuid, rate_limit_tier FROM accounts WHERE lower(email) = ?').get(e);
  const who = account ?? (row && { accountUuid: row.account_uuid, emailAddress: row.email, organizationUuid: row.org_uuid, rateLimitTier: row.rate_limit_tier });
  if (!who?.accountUuid) return { error: `${email} has not been seen on this machine yet, so its account is not known` };
  if (check && !(await works(t))) return { error: 'Claude Code could not run on that token' };
  const list = spares();
  const spare = list.find((s) => s.email?.toLowerCase() === e) ?? list.find((s) => s.for?.toLowerCase() === e && !s.accountUuid) ?? makeSpare(email);
  const tier = who.rateLimitTier ?? null;
  withStorageLock(spare.dir, () => writeSignin(spare, {
    oauth: { accessToken: t, refreshToken: null, expiresAt: null, refreshTokenExpiresAt: until, scopes: ['user:inference'], subscriptionType: planOf(tier), rateLimitTier: tier },
    account: { accountUuid: who.accountUuid, emailAddress: who.emailAddress ?? email, organizationUuid: who.organizationUuid ?? null },
  }));
  healthRead.clear();
  return { added: spare };
}

/** Every long-lived token on this machine, in spares and profiles alike: what `pool import` takes on another. */
export function longLivedTokens(profiles = discoverProfiles()) {
  const found = new Map();
  for (const p of [...profiles.filter((x) => !x.dir.includes(SPARE_PREFIX)), ...spares()]) {
    let s = null;
    try { s = readSignin(p); } catch { /* unreadable: nothing to give */ }
    if (!s || s.oauth.refreshToken != null || !s.account.emailAddress) continue;
    found.set(s.account.emailAddress.toLowerCase(), {
      email: s.account.emailAddress, token: s.oauth.accessToken, until: s.oauth.refreshTokenExpiresAt ?? null,
      account: { accountUuid: s.account.accountUuid, emailAddress: s.account.emailAddress, organizationUuid: s.account.organizationUuid ?? null, rateLimitTier: s.oauth.rateLimitTier ?? null },
    });
  }
  return [...found.values()];
}

/** Take another machine's long-lived tokens, each into its account's spare, unless this machine holds it already. */
export async function importTokens(list, profiles = discoverProfiles()) {
  const here = new Set(longLivedTokens(profiles).map((x) => x.token));
  const out = [];
  for (const x of list) {
    if (here.has(x.token)) { out.push({ email: x.email, already: true }); continue; }
    out.push({ email: x.email, ...(await addToken(x.email, x.token, { until: x.until ?? undefined, account: x.account, check: false })) });
  }
  return out;
}

/* --- adding accounts ---------------------------------------------------------- */

function claude(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.env.CLAUDE_TRACKER_CLAUDE || 'claude', args, { env, stdio: 'inherit' });
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
}

/** Sign `email` into a spare of its own: Claude Code's own login, in the browser, once. */
export async function addSpare(email, name, profiles = discoverProfiles()) {
  const e = email.toLowerCase();
  const list = spares();
  const lasts = (s) => !within(s.runsOutAt, RENEW_MS);
  const holding = list.find((s) => s.email?.toLowerCase() === e && lasts(s));
  if (holding) return { already: `${email} is already a spare here, in ${holding.shown}.` };
  const inUse = profiles.find((p) => !p.dir.includes(SPARE_PREFIX) && profileAccount(p)?.email?.toLowerCase() === e);
  if (inUse?.isDefault) return { already: `${email} is what ${tildify(inUse.dir)} is signed into now; when it is switched away it gets a spare of its own.` };
  // An empty spare, or one whose sign-in has run out or soon will: signed in again where it is.
  const waiting = list.find((s) => s.for?.toLowerCase() === e && (!s.accountUuid || !lasts(s)));
  const spare = waiting ?? makeSpare(email, name ?? email.split('@')[0]);
  const code = await claude(['auth', 'login', '--email', email], { ...process.env, CLAUDE_CONFIG_DIR: spare.dir });
  const who = readSignin(spare);
  if (code !== 0 || !who) return { error: 'not signed in', spare };
  if (who.account.emailAddress?.toLowerCase() !== e) {
    // The browser was signed into someone else; the spare was empty, so empty it again.
    withStorageLock(spare.dir, () => writeSignin(spare, null));
    return { error: `the browser signed in as ${who.account.emailAddress}, not ${email}, so that was undone`, spare };
  }
  return { added: spare };
}
