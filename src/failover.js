import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, getMeta, setMeta } from './db.js';
import { discoverProfiles, tildify } from './paths.js';
import { profileAccount } from './accounts.js';
import { linkMemory } from './pool.js';

/**
 * Failing over: when the account sessions here are running on is nearly out,
 * carry them to an account with room.
 *
 * Signing an account in takes a browser, so the tracker never does it. What it
 * can do is start Claude Code under a profile already signed into another
 * account - each profile keeps its own sign-in. So the pool is this machine's
 * signed-in profiles, and a move resumes the session's conversation, forked, as
 * a background session under the profile with the most room; `claude attach`
 * opens it. Only an idle session is moved: one mid-turn finishes the turn, or
 * is refused, first, so the old and the new never work at once.
 *
 * Each machine moves its own sessions through its own profiles. Plans travel
 * with the sync state, so every dashboard shows every machine's.
 */

const CORE = ['five_hour', 'seven_day'];
/** A target needs at least this much room in its tightest window to be worth moving to. */
const MIN_ROOM = 15;

export function failoverSettings() {
  return {
    mode: getMeta('failover_mode', 'off'),
    at: Number(getMeta('failover_at', '90')),
    waitMin: Number(getMeta('failover_wait', '15')),
  };
}

export function setFailover({ mode, at, waitMin }) {
  if (mode) setMeta('failover_mode', mode);
  if (at != null) setMeta('failover_at', String(at));
  if (waitMin != null) setMeta('failover_wait', String(waitMin));
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

/** This machine's signed-in profiles: the accounts a session here can be moved to. */
export function pool() {
  return discoverProfiles().map((p) => {
    const a = profileAccount(p);
    return a ? { dir: p.dir, shown: tildify(p.dir), name: p.name, isDefault: p.isDefault, accountUuid: a.accountUuid, email: a.email } : null;
  }).filter(Boolean);
}

/**
 * For each account sessions here are running on: how full it is, whether it is
 * due to move, and where to. Also the account with the most room that no
 * profile here is signed into, when it would beat the best target here.
 */
export function plan(ov, live, settings = failoverSettings(), now = Date.now(), profiles = pool()) {
  const accounts = new Map(ov.accounts.map((a) => [a.accountUuid, a]));
  const elsewhere = new Set(live.filter((s) => s.machine).map((s) => s.accountUuid));
  // One way into each account here: the first profile signed into it.
  const ways = new Map();
  for (const p of profiles) if (!ways.has(p.accountUuid)) ways.set(p.accountUuid, p);
  const here = new Map();
  for (const s of live) {
    if (s.machine || !s.accountUuid) continue;
    if (!here.has(s.accountUuid)) here.set(s.accountUuid, []);
    here.get(s.accountUuid).push(s);
  }
  const entries = [];
  for (const [acct, sessions] of here) {
    const a = accounts.get(acct);
    const lvl = level(a);
    // Most room first; between equals, one no other machine is using.
    const target = [...ways.values()]
      .filter((p) => p.accountUuid !== acct)
      .map((p) => ({ ...p, label: accounts.get(p.accountUuid)?.label ?? p.email, room: headroom(accounts.get(p.accountUuid)) }))
      .filter((c) => c.room >= MIN_ROOM)
      .sort((x, y) => y.room - x.room || Number(elsewhere.has(x.accountUuid)) - Number(elsewhere.has(y.accountUuid)))[0] ?? null;
    // Out, but back within the wait: not worth a move.
    const freesAt = a && !a.available.now ? a.available.at : null;
    const soon = freesAt != null && freesAt - now < settings.waitMin * 60e3;
    entries.push({
      account: acct, label: a?.label ?? acct, level: lvl, due: lvl >= settings.at && !soon, freesAt,
      target: target && { accountUuid: target.accountUuid, label: target.label, room: target.room, dir: target.dir, shown: target.shown, isDefault: target.isDefault },
      sessions: sessions.map((s) => ({ sessionId: s.sessionId, name: s.name, status: s.status })),
    });
  }
  const top = Math.max(0, ...entries.map((e) => e.target?.room ?? 0));
  const best = ov.accounts
    .filter((a) => a.available.now && !ways.has(a.accountUuid))
    .map((a) => ({ accountUuid: a.accountUuid, label: a.label, email: a.email, room: headroom(a) }))
    .sort((x, y) => y.room - x.room)[0] ?? null;
  return { ...settings, entries, best: best && best.room >= top + 10 ? best : null };
}

/** Where a conversation's transcript lives in a profile, if it is there. */
function findTranscript(dir, id) {
  const projects = path.join(dir, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(projects); } catch { return null; }
  for (const slug of slugs) {
    const file = path.join(projects, slug, `${id}.jsonl`);
    if (fs.existsSync(file)) return { slug, file };
  }
  return null;
}

/** Was the conversation cut off by a refusal - refused after its last call? */
function cutOff(id) {
  const d = db();
  const refused = d.prepare("SELECT MAX(ts) t FROM limit_events WHERE session_id = ? AND status = 'rejected'").get(id)?.t;
  const called = d.prepare('SELECT MAX(ts) t FROM events WHERE session_id = ?').get(id)?.t;
  return refused != null && (called == null || refused > called);
}

/** Run Claude Code, as a given profile, and collect what it prints. */
function claude(args, { dir, isDefault, cwd }) {
  const env = { ...process.env };
  // The default profile is the one with no CLAUDE_CONFIG_DIR: naming it moves its config file.
  delete env.CLAUDE_CONFIG_DIR;
  if (!isDefault) env.CLAUDE_CONFIG_DIR = dir;
  return new Promise((resolve) => {
    const child = spawn(process.env.CLAUDE_TRACKER_CLAUDE || 'claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.code === 'ENOENT' ? 'claude is not installed or not on PATH' : err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

export const CONTINUE = 'The previous session ran out of usage on its account partway through. Carry on where it left off.';

/** The command that opens a moved session. */
export function attachCommand(row) {
  const dir = row.to_dir ?? row.dir;
  const viaDefault = discoverProfiles().some((p) => p.isDefault && p.dir === dir);
  return `${viaDefault ? '' : `CLAUDE_CONFIG_DIR=${tildify(dir)} `}claude attach ${row.bg_id}`;
}

/**
 * Move one session to the account `target`'s profile: copy its transcript
 * there, and fork it as a background session. A background original is
 * stopped once its replacement runs; an interactive one is the user's to close.
 */
export async function move(session, target, { fromAccount = null } = {}) {
  const id = session.transcriptId ?? session.sessionId;
  const row = {
    ts: Date.now(), session_id: session.sessionId, transcript_id: id, name: session.name ?? id.slice(0, 8), cwd: session.cwd,
    from_account: fromAccount ?? session.accountUuid, to_account: target.accountUuid,
    from_dir: session.profileDir, to_dir: target.dir, bg_id: null, continued: 0, status: 'failed', error: null,
  };
  const record = () => {
    db().prepare(`INSERT INTO failovers (ts, session_id, transcript_id, name, cwd, from_account, to_account, from_dir, to_dir, bg_id, continued, status, error)
      VALUES (@ts, @session_id, @transcript_id, @name, @cwd, @from_account, @to_account, @from_dir, @to_dir, @bg_id, @continued, @status, @error)`).run(row);
    return row;
  };
  if (!session.cwd || !fs.existsSync(session.cwd)) { row.error = `its folder ${session.cwd ?? ''} is gone`; return record(); }
  const src = session.profileDir && findTranscript(session.profileDir, id);
  if (!src) { row.error = 'its transcript was not found'; return record(); }
  try {
    const dest = path.join(target.dir, 'projects', src.slug, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(dest) !== path.resolve(src.file)) fs.copyFileSync(src.file, dest);
  } catch (err) { row.error = `could not copy its transcript: ${err.message}`; return record(); }

  // Its project's memories come with it: the target reads and writes the main profile's.
  try { linkMemory(target.dir, src.slug, { create: true }); } catch { /* resumes without them */ }
  row.continued = cutOff(id) ? 1 : 0;
  const args = ['--resume', id, '--fork-session', '--bg', '-n', row.name];
  if (row.continued) args.push(CONTINUE);
  const r = await claude(args, { dir: target.dir, isDefault: target.isDefault, cwd: session.cwd });
  const bg = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(r.out)?.[1];
  if (r.code !== 0 || !bg) { row.error = (r.out.trim().split('\n').pop() || `claude exited with ${r.code}`).slice(0, 300); return record(); }
  row.bg_id = bg;
  row.status = 'started';
  record();
  const from = discoverProfiles().find((p) => p.dir === session.profileDir);
  if (session.kind === 'background' && from) {
    await claude(['stop', session.sessionId.slice(0, 8)], { dir: from.dir, isDefault: from.isDefault, cwd: session.cwd });
  }
  return row;
}

/** Sessions moved recently, newest first. */
export function recentMoves(since = Date.now() - 24 * 3600e3) {
  return db().prepare('SELECT * FROM failovers WHERE ts >= ? ORDER BY ts DESC LIMIT 50').all(since);
}

/**
 * Carry out the plan: move every idle session on an account that is due, once.
 * Returns the moves made.
 */
let busy = false;
export async function runFailover(ov, live, now = Date.now()) {
  const settings = failoverSettings();
  if (settings.mode !== 'auto' || busy) return [];
  busy = true;
  try {
    const p = plan(ov, live, settings, now);
    // Moved once is moved for good; a move that failed is tried again after ten minutes.
    const done = new Set(db().prepare("SELECT session_id FROM failovers WHERE status = 'started' OR ts > ?")
      .all(now - 10 * 60e3).map((r) => r.session_id));
    const moves = [];
    for (const e of p.entries) {
      if (!e.due || !e.target) continue;
      for (const s of live) {
        if (s.machine || s.accountUuid !== e.account || s.status !== 'idle' || done.has(s.sessionId)) continue;
        moves.push(await move(s, e.target, { fromAccount: e.account }));
        done.add(s.sessionId);
      }
    }
    return moves;
  } finally {
    busy = false;
  }
}
