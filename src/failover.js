import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, getMeta, setMeta } from './db.js';
import { discoverProfiles, tildify, HOME, configFileOf } from './paths.js';
import { profileAccount } from './accounts.js';
import { readSignin, writeSignin, switchSignin, withStorageLock } from './signin.js';
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
 */

const CORE = ['five_hour', 'seven_day'];
/** A target needs at least this much room in its tightest window to be worth switching to. */
export const MIN_ROOM = 15;
/** After a switch, the profile's new account has time to show before another is considered. */
const SETTLE_MS = 10 * 60e3;
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

/** This machine's spares: what each is for, and the account whose sign-in it holds now, if any. */
export function spares() {
  let names = [];
  try { names = fs.readdirSync(HOME); } catch { return []; }
  return names.filter((n) => n.startsWith(SPARE_PREFIX)).map((n) => {
    const dir = path.join(HOME, n);
    const mark = readJson(path.join(dir, MARK));
    if (!mark) return null;
    const a = profileAccount({ dir, configFile: configFileOf(dir) });
    return { dir, shown: tildify(dir), isDefault: false, for: mark.email ?? null, accountUuid: a?.accountUuid ?? null, email: a?.email ?? null };
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
    const lvl = level(a);
    // Most room - within 5 points counts as equal - and, between equals, one no
    // other machine is using; then this machine's turn among what is left.
    const rank = (x) => [Math.round(x.room / 5), elsewhere.has(x.accountUuid) ? 0 : 1];
    const options = held
      .filter((s) => s.accountUuid && s.accountUuid !== signed.accountUuid)
      .map((s) => ({ ...s, label: accounts.get(s.accountUuid)?.label ?? s.email, room: headroom(accounts.get(s.accountUuid)) }))
      .filter((s) => s.room >= MIN_ROOM)
      .sort((x, y) => rank(y)[0] - rank(x)[0] || rank(y)[1] - rank(x)[1]);
    // Your pick, while it has room; otherwise the best by room.
    const picked = settings.prefer && options.find((x) => x.email?.toLowerCase() === settings.prefer);
    const target = picked ? { ...picked, pinned: true }
      : turnOf(options.filter((x) => options.length && String(rank(x)) === String(rank(options[0]))));
    // Out, but back within the wait: not worth a switch.
    const freesAt = a && !a.available.now ? a.available.at : null;
    const soon = freesAt != null && freesAt - now < settings.waitMin * 60e3;
    entries.push({
      dir, profile: tildify(dir), isDefault: !!profile.isDefault, sessions,
      account: signed.accountUuid, email: signed.email, label: a?.label ?? signed.email ?? signed.accountUuid,
      level: lvl, due: lvl >= settings.at && !soon, out: !!a && !a.available.now, freesAt,
      target: target && { accountUuid: target.accountUuid, label: target.label, email: target.email, room: target.room, dir: target.dir, shown: target.shown, pinned: !!target.pinned },
    });
  }
  const covered = new Set([...held.map((s) => s.accountUuid), ...entries.map((e) => e.account)]);
  const top = Math.max(0, ...entries.map((e) => e.target?.room ?? 0));
  const best = ov.accounts
    .filter((a) => a.available.now && !covered.has(a.accountUuid) && a.email)
    .map((a) => ({ accountUuid: a.accountUuid, label: a.label, email: a.email, room: headroom(a) }))
    .sort((x, y) => y.room - x.room)[0] ?? null;
  return { ...settings, entries, best: best && best.room >= top + 10 ? best : null };
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
  const settling = db().prepare('SELECT profile FROM switches WHERE ts > ?').all(now - SETTLE_MS).map((r) => r.profile);
  const made = [];
  for (const e of plan(ov, live, settings, now).entries) {
    if (!e.due || !e.target || settling.includes(e.dir)) continue;
    made.push(switchProfile(e, e.target));
  }
  return made;
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
  const holding = list.find((s) => s.email?.toLowerCase() === e);
  if (holding) return { already: `${email} is already a spare here, in ${holding.shown}.` };
  const inUse = profiles.find((p) => !p.dir.includes(SPARE_PREFIX) && profileAccount(p)?.email?.toLowerCase() === e);
  if (inUse?.isDefault) return { already: `${email} is what ${tildify(inUse.dir)} is signed into now; when it is switched away it gets a spare of its own.` };
  const waiting = list.find((s) => s.for?.toLowerCase() === e && !s.accountUuid);
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
