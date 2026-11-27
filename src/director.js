import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, HOME, ensureDataDir } from './paths.js';
import { db, getMeta, setMeta } from './db.js';
import { readEntry, parseKeys } from './panes.js';

/**
 * The director's hands: a local API through which a service on this machine
 * starts, reads, types into and stops Claude Code sessions, and hears what
 * they do. It answers only over loopback, to a key kept readable by this user
 * alone, and never to a web page: any request with an Origin is refused.
 *
 * It may write only to sessions it started or the owner handed it (`;director`
 * in a session's thread; `;mine` takes it back). Everything it types or
 * presses goes through the Slack bridge, so it shows in that session's thread
 * as the director's and is held for an open prompt as a Slack reply is. With
 * no Slack to show it in, it does nothing. `director pause` in the channel
 * refuses every write until `director resume`.
 */

export const KEY_FILE = path.join(DATA_DIR, 'director.key');
/**
 * The accounts it may start sessions on, if any: each a Claude subscription
 * of its own, never the owner's. `{ "accounts": { "<name>": { "env": file
 * holding CLAUDE_CODE_OAUTH_TOKEN=…, "profile": its own Claude Code profile
 * folder } } }`. Once any is named, every session it starts says which.
 */
export const CONFIG_FILE = path.join(DATA_DIR, 'director.json');
const KEEP_MS = 7 * 24 * 3600e3;
// Minutes idle, each said once a stretch (a test says sooner).
const IDLE_AT = (process.env.CLAUDE_TRACKER_DIRECTOR_IDLE ?? '10,60').split(',').map(Number).filter((n) => n > 0);
const CONTEXT_AT = [70, 85];      // percent of the way to auto-compact, each said once
// How often idle stretches and context use are looked at: each look works out every session's account and context.
const WATCH_MS = Math.min(30_000, Math.max(1000, (Math.min(...IDLE_AT) * 60_000) / 4));
const BODY_MAX = 256 * 1024;
// Seconds a start waits for Claude to come up, and after which one still not up is given up (a test says sooner).
const LAUNCH_S = (process.env.CLAUDE_TRACKER_DIRECTOR_LAUNCH_S || '30,600').split(',').map(Number);
const LAUNCH_WAIT_MS = (LAUNCH_S[0] > 0 ? LAUNCH_S[0] : 30) * 1000;
const LAUNCH_GIVE_UP_MS = LAUNCH_S[1] > 0 ? LAUNCH_S[1] * 1000 : LAUNCH_WAIT_MS * 20;

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The key, made the first time: 64 hex characters in a file only this user can read. */
export function directorKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(k)) {
      if ((fs.statSync(KEY_FILE).mode & 0o077) !== 0) fs.chmodSync(KEY_FILE, 0o600);
      return k;
    }
  } catch { /* made below */ }
  ensureDataDir();
  const k = crypto.randomBytes(32).toString('hex');
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${k}\n`, { mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
  return k;
}

const expand = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, HOME));
const tilde = (p) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const accountsOf = () => readJson(CONFIG_FILE)?.accounts ?? {};

/** The profiles its accounts run in: never failed over, as they hold no sign-in of the owner's. */
export function directorProfiles() {
  return Object.values(accountsOf()).map((a) => a?.profile && expand(a.profile)).filter(Boolean);
}

/** The token in an env file: `CLAUDE_CODE_OAUTH_TOKEN=…`, maybe exported, maybe quoted. */
function tokenIn(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*?)\s*$/);
    const v = m?.[1].replace(/^(['"])(.*)\1$/, '$2');
    if (v) return v;
  }
  return null;
}

class Refused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * `hands`: `sessions()` the sessions here (null before the first look),
 * `act(op)` the panes' actions, `transcript(id)` a session's transcript,
 * `info(id)` its account and context, and `wake()` to have them followed.
 * The bridge is attached once both exist.
 */
export function startDirector({ hands, log = () => {} }) {
  const d = db();
  const q = {
    add: d.prepare('INSERT INTO director_events (at, session, kind, detail) VALUES (?, ?, ?, ?)'),
    after: d.prepare('SELECT seq, at, session, kind, detail FROM director_events WHERE seq > ? ORDER BY seq LIMIT ?'),
    // The highest number ever handed out, even if pruned since.
    last: d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'director_events'"),
    prune: d.prepare('DELETE FROM director_events WHERE at < ?'),
    own: d.prepare('SELECT * FROM director_sessions WHERE session_id = ?'),
    owned: d.prepare('SELECT session_id FROM director_sessions'),
    give: d.prepare(`INSERT INTO director_sessions (session_id, since, how) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET since = excluded.since, how = excluded.how`),
    take: d.prepare('DELETE FROM director_sessions WHERE session_id = ?'),
    move: d.prepare('UPDATE OR REPLACE director_sessions SET session_id = ? WHERE session_id = ?'),
  };
  let bridge = null;
  let usedAt = 0;
  const waiters = new Set();
  const taken = new Map();   // seq -> the Slack message it came from, marked once the director has it

  /* --- events ------------------------------------------------------------ */

  function emit(session, kind, detail = null, from = null) {
    const r = q.add.run(Date.now(), session ?? null, kind, detail ? JSON.stringify(detail) : null);
    if (from) {
      taken.set(Number(r.lastInsertRowid), from);
      if (taken.size > 200) taken.delete(taken.keys().next().value);
    }
    for (const w of waiters) w();
  }

  const row = (e) => ({ seq: e.seq, at: e.at, session: e.session, kind: e.kind, detail: e.detail ? JSON.parse(e.detail) : null });

  async function events(after, wait, res) {
    const last = q.last.get()?.seq ?? 0;
    // Asked from past the end - the database was replaced: start again from where it is.
    if (after > last) return { events: [], next: last };
    let list = q.after.all(after, 200);
    if (!list.length && wait > 0) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); res.off('close', done); resolve(); };
        const timer = setTimeout(done, wait * 1000);
        waiters.add(done);
        res.on('close', done);   // the director gave up waiting
      });
      list = q.after.all(after, 200);
    }
    // A reply the owner wrote is marked read once the director has taken it.
    for (const e of list) if (taken.has(e.seq)) { bridge?.directorTook(taken.get(e.seq)); taken.delete(e.seq); }
    return { events: list.map(row), next: list.at(-1)?.seq ?? after };
  }

  const pruner = setInterval(() => { try { q.prune.run(Date.now() - KEEP_MS); } catch { /* next hour */ } }, 3600e3);
  pruner.unref?.();
  try { q.prune.run(Date.now() - KEEP_MS); } catch { /* next hour */ }

  /* --- who a session belongs to ------------------------------------------- */

  const owns = (id) => !!q.own.get(id);
  const paused = () => getMeta('director_paused') === '1';

  /* --- what sessions do ---------------------------------------------------- */

  const seen = new Map();      // session id -> what was last seen of it, and what it was told
  const launches = new Map();  // pane -> a session the director started, until it shows up
  let looked = false;

  const percentOf = (c) => (c?.tokens && c?.compactAt ? Math.round((c.tokens / c.compactAt) * 100) : null);
  const levelOf = (pct) => CONTEXT_AT.filter((l) => pct != null && pct >= l).at(-1) ?? 0;
  const over = (status) => status !== 'busy' && status !== 'waiting';

  function sessions(list) {
    const now = Date.now();
    const ids = new Set(list.map((s) => s.sessionId));
    const gone = [...seen.values()].filter((v) => !ids.has(v.s.sessionId));
    if (!looked) {
      // Handed or started before a restart, and ended while it was down: no longer the director's.
      for (const { session_id: id } of q.owned.all()) if (!ids.has(id)) q.take.run(id);
    }
    for (const s of list) {
      let v = seen.get(s.sessionId);
      if (!v) {
        const before = gone.find((g) => g.s.pid === s.pid);
        const launch = s.pane ? launches.get(s.pane) : null;
        v = {
          s, idleSince: over(s.status) ? (s.statusAt ?? now) : null,
          idleTold: new Set(IDLE_AT.filter((m) => over(s.status) && now - (s.statusAt ?? now) >= m * 60_000)),
          level: levelOf(percentOf(hands.info(s.sessionId)?.context)),
          // Working when first seen: on a turn asked before this was looking.
          prompted: s.status === 'busy' || s.status === 'waiting',
        };
        seen.set(s.sessionId, v);
        if (before) {
          // A /clear: a new conversation in the same process, which stays whoever's it was.
          gone.splice(gone.indexOf(before), 1);
          seen.delete(before.s.sessionId);
          if (owns(before.s.sessionId)) q.move.run(s.sessionId, before.s.sessionId);
          emit(before.s.sessionId, 'exited', { replacedBy: s.sessionId });
          emit(s.sessionId, 'started', { cwd: s.cwd, owner: owns(s.sessionId) ? 'director' : 'owner', replaces: before.s.sessionId, tmux: s.tmux });
        } else if (launch) {
          launches.delete(s.pane);
          q.give.run(s.sessionId, now, 'started');
          emit(s.sessionId, 'started', { cwd: s.cwd, owner: 'director', tmux: s.tmux });
          launch.came = s;
          launch.found(s);
          v.prompt = launch.prompt;
          bridge?.directorNote(s.sessionId, `:robot_face: *the director* started this session${launch.prompt ? ': its first message is typed once it is up' : ''}`).catch(() => {});
        } else if (looked) {
          emit(s.sessionId, 'started', { cwd: s.cwd, owner: owns(s.sessionId) ? 'director' : 'owner', tmux: s.tmux });
        }
      }
      const prev = v.s;
      v.s = s;
      if (s.status === 'waiting' && prev.status === 'waiting' && prev.waitingFor !== s.waitingFor) v.waitTold = false;   // a prompt after a prompt
      if (s.status === 'waiting' && !v.waitTold) {
        if (!v.waitTimer) v.waitTimer = setTimeout(() => { v.waitTimer = null; waiting(v).catch((err) => log(`director: ${err.message}`)); }, 700);
      } else if (s.status !== 'waiting') v.waitTold = false;
      if (!over(s.status)) { v.busy = true; v.idleSince = null; }
      else if (v.busy) { v.busy = false; soonDone(v); }
      if (over(s.status) && !over(prev.status)) { v.idleSince = now; v.idleTold.clear(); }
      // Its first message, typed once it is up.
      if (v.prompt && s.status === 'idle' && s.controllable) {
        const prompt = v.prompt;
        v.prompt = null;
        write(s.sessionId, () => bridge.directorType(s.sessionId, prompt)).catch((err) => log(`director: first message for ${s.sessionId}: ${err.message}`));
      }
    }
    for (const v of gone) {
      const id = v.s.sessionId;
      seen.delete(id);
      clearTimeout(v.waitTimer); clearTimeout(v.doneTimer);
      const started = q.own.get(id)?.how === 'started';
      q.take.run(id);
      if (!started || !v.s.pane) { emit(id, 'exited'); continue; }
      // One it started goes with its tmux session; ended other than by its stop, what it last showed is kept.
      closeAfter(v).then(({ screen, closed }) => {
        emit(id, 'exited', screen ? { screen } : null);
        if (!v.stopping) {
          bridge?.directorAfter(id, `:robot_face: Claude ended without *the director* stopping it${closed ? ', so its tmux session was closed' : ''}${screen ? `. Its last lines:\n\`\`\`${screen}\`\`\`` : ''}`).catch(() => {});
        }
      });
    }
    looked = true;
  }

  /** A session it started, whose Claude has exited: its tmux session closed, and, unless it was stopped, the screen it left. */
  async function closeAfter(v) {
    let screen = null, closed = false;
    if (!v.stopping) {
      try {
        const r = await hands.act({ op: 'early', pane: v.s.pane, socket: v.s.socket, any: true });
        if (r.shell) screen = r.screen.text.split('\n').filter((x) => x.trim()).slice(-12).join('\n').slice(-1500) || null;
      } catch { /* gone already */ }
    }
    try { closed = (await hands.act({ op: 'close', pane: v.s.pane, socket: v.s.socket })).closed; } catch (err) { log(`director: ${v.s.tmux}: ${err.message}`); }
    return { screen, closed };
  }

  /**
   * What a session wrote. A turn quicker than a look at the sessions is
   * never seen working; Claude writing while it is idle ends one all the same.
   */
  function items(id, list) {
    const v = seen.get(id);
    if (!v) return;
    const now = list.filter((i) => !i.backfill);
    if (now.some((i) => i.kind === 'prompt' && !i.command)) v.prompted = true;
    if (over(v.s.status) && now.some((i) => i.kind === 'text' || (i.kind === 'note' && i.text === 'interrupted'))) soonDone(v);
  }

  /** The turn is over, a moment from now: its last words may still be on their way to the transcript. */
  function soonDone(v) {
    clearTimeout(v.doneTimer);
    v.doneTimer = setTimeout(() => {
      if (!over(v.s.status)) return;
      try { turnDone(v); } catch (err) { log(`director: ${err.message}`); }
    }, 1500);
    v.doneTimer.unref?.();
  }

  async function waiting(v) {
    if (v.s.status !== 'waiting') return;
    const p = await prompt(v.s);
    if (v.s.status !== 'waiting' || v.waitTold) return;
    v.waitTold = true;
    emit(v.s.sessionId, 'waiting', p);
  }

  /** The prompt on a session's screen, read once its dialog has drawn: as the Slack alert shows it. */
  async function prompt(s, tries = 3) {
    let screen = null;
    for (let i = 0; i < tries && !screen?.dialog; i++) {
      if (i) await new Promise((r) => setTimeout(r, 700));
      try { screen = (await hands.act({ op: 'screen', sessionId: s.sessionId })).screen; } catch { /* said without it */ }
    }
    const dlg = screen?.dialog;
    return {
      title: dlg?.title ?? s.waitingFor ?? 'input',
      text: dlg ? dlg.body.map((l) => l.text).join('\n') : (screen?.text ?? '').split('\n').slice(-16).join('\n').trim(),
      choices: (screen?.options ?? []).map((o, i) => ({ key: String(i + 1), label: o.label })),
    };
  }

  /** A turn asked since it was last said to be done: said done, with its number and how it ended. A slash command is no turn. */
  function turnDone(v) {
    if (!v.prompted) return;
    v.prompted = false;
    const t = turnIndex(v.s.sessionId);
    if (!t?.starts.length) return;
    const n = t.starts.length;
    if (v.doneN === n) return;
    v.doneN = n;
    const turn = readTurns(t, n - 1, 1)[0];
    emit(v.s.sessionId, 'turn_done', { n, answerPreview: clip(turn?.answer ?? '', 300), ...(turn?.interrupted ? { interrupted: true } : {}), ...(turn?.error ? { error: turn.error } : {}) });
  }

  /**
   * A start not up yet: still starting, stopped on a question, or ended
   * before it began - with what its screen says. Only a pane back at its
   * shell has ended: one running anything else may be Claude by another name.
   */
  async function examine(l) {
    let r;
    try { r = await hands.act({ op: 'early', pane: l.pane, socket: l.socket, any: true }); } catch (err) {
      return /gone/.test(err.message) ? { state: 'gone', why: 'its tmux session closed before Claude started' } : { state: 'starting' };
    }
    const { screen, shell } = r;
    if (shell) {
      const last = screen.text.split('\n').map((x) => x.trim()).filter(Boolean).slice(-6).join(' / ');
      return { state: 'ended', why: `Claude ended before it started${last ? `: ${clip(last, 400)}` : ''}` };
    }
    if (screen.options?.length) {
      const d = screen.dialog;
      const asked = d ? [d.title, ...d.body.slice(0, 3).map((x) => x.text)].join(' ') : screen.text.split('\n').filter(Boolean).slice(-6).join(' / ');
      return { state: 'asking', why: `Claude asked something before it started, so it was closed: ${clip(asked, 400)}` };
    }
    return { state: 'starting' };
  }

  /** A start that will not come up: its pane closed, so nothing is left waiting unseen. */
  async function abandon(l, x) {
    launches.delete(l.pane);
    if (x.state !== 'gone') await hands.act({ op: 'close', pane: l.pane, socket: l.socket, force: x.state !== 'ended' }).catch((err) => log(`director: ${l.tmux}: ${err.message}`));
  }

  /** Starts still not up once their start has answered: given up once they ask, end, or take far too long. */
  function followLaunches() {
    for (const l of launches.values()) {
      if (l.checking || Date.now() - l.at < LAUNCH_WAIT_MS) continue;
      l.checking = true;
      examine(l).then(async (x) => {
        if (launches.get(l.pane) !== l) return;   // it came up meanwhile
        if (x.state === 'starting') {
          if (Date.now() - l.at < LAUNCH_GIVE_UP_MS) return;
          const took = LAUNCH_GIVE_UP_MS < 120_000 ? `${Math.round(LAUNCH_GIVE_UP_MS / 1000)} seconds` : `${Math.round(LAUNCH_GIVE_UP_MS / 60_000)} minutes`;
          x = { state: 'late', why: `Claude was not up after ${took}, so it was closed` };
        }
        await abandon(l, x);
        emit(null, 'launch_failed', { tmux: l.tmux, cwd: l.cwd, why: x.why });
      }).catch((err) => log(`director: ${l.tmux}: ${err.message}`)).finally(() => { l.checking = false; });
    }
  }

  // Idle stretches and context use change without a session's list changing.
  const watch = setInterval(() => {
    followLaunches();
    const now = Date.now();
    for (const v of seen.values()) {
      if (v.idleSince) {
        for (const m of IDLE_AT) {
          if (v.idleTold.has(m) || now - v.idleSince < m * 60_000) continue;
          v.idleTold.add(m);
          emit(v.s.sessionId, 'idle', { minutes: m });
        }
      }
      const pct = percentOf(hands.info(v.s.sessionId)?.context);
      if (pct == null) continue;
      const level = levelOf(pct);
      if (level > v.level) emit(v.s.sessionId, 'context_high', { percent: pct });
      // Compacted or cleared: it can fill again, and be said again.
      v.level = pct < 50 ? 0 : Math.max(level, v.level);
    }
  }, WATCH_MS);
  watch.unref?.();

  /* --- turns, from the transcript ---------------------------------------------- */

  /**
   * Where each turn starts in a session's transcript, by byte: found once,
   * then kept up with. A turn is one prompt a person (or the director) typed
   * and all that followed it; slash commands are not turns.
   */
  const indexes = new Map();
  function turnIndex(id) {
    const p = hands.transcript(id);
    if (!p) return null;
    let t = indexes.get(id);
    if (!t || t.path !== p) { t = { path: p, scanned: 0, starts: [], state: {} }; indexes.set(id, t); }
    let size;
    try { size = fs.statSync(p).size; } catch { return t; }
    if (size < t.scanned) { t.scanned = 0; t.starts = []; t.state = {}; }
    t.scanned = entries(p, t.scanned, size, (e, at) => {
      if (readEntry(e, t.state).some((i) => i.kind === 'prompt' && !i.command)) t.starts.push(at);
    });
    return t;
  }

  /** Turns `from` (0-based) on, at most `limit`: what was asked, what it did, and what it said last. */
  function readTurns(t, from, limit) {
    const out = [];
    for (let i = from; i < Math.min(t.starts.length, from + limit); i++) {
      const state = { origins: t.state.origins };
      const turn = { n: i + 1, at: null, prompt: null, answer: null, tools: [] };
      entries(t.path, t.starts[i], t.starts[i + 1] ?? t.scanned, (e) => {
        for (const it of readEntry(e, state)) {
          if (it.kind === 'prompt' && !it.command && turn.prompt == null) { turn.prompt = it.text; turn.at = it.at; }
          else if (it.kind === 'text') {
            turn.answer = it.text; turn.tools.push(...it.tools);
            // Ended on a limit, a lapsed sign-in, an API failure: no answer, and no use nudging until it is over.
            if (it.failure) turn.error = it.failure; else delete turn.error;
          }
          else if (it.kind === 'note' && it.text === 'interrupted') turn.interrupted = true;
        }
      }, true);
      turn.tools = [...turn.tools, ...(state.tools ?? [])].map((x) => ({ verb: x.verb, what: x.what }));
      out.push(turn);
    }
    return out;
  }

  const USER = Buffer.from('"type":"user"');
  const RESULT = Buffer.from('"type":"tool_result"');
  /**
   * Each whole entry of a transcript between two byte offsets, with where it
   * starts; returns where the last whole line ended. Tool results - most of a
   * transcript's bytes, and never part of what is asked or said - are skipped
   * unread; so is everything but what people typed, unless `all`.
   */
  function entries(file, from, to, fn, all = false) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, Math.max(65536, to - from)));
    let pos = from, skipping = false;
    try {
      while (pos < to) {
        const len = fs.readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
        if (!len) break;
        const end = buf.subarray(0, len).lastIndexOf(10);
        if (end < 0) {
          // A line longer than the buffer - a huge tool result - or one still being written.
          if (len < buf.length) break;
          pos += len; skipping = true;
          continue;
        }
        let at = 0;
        if (skipping) { at = buf.indexOf(10) + 1; skipping = false; }
        while (at <= end) {
          const nl = buf.indexOf(10, at);
          const user = buf.subarray(at, nl).indexOf(USER);
          const wanted = all ? buf[at] === 0x7b : user >= 0;
          if (wanted && (user < 0 || buf.subarray(at, nl).indexOf(RESULT) < 0)) {
            try { fn(JSON.parse(buf.toString('utf8', at, nl)), pos + at); } catch { /* not a whole entry */ }
          }
          at = nl + 1;
        }
        pos += end + 1;
      }
    } finally { fs.closeSync(fd); }
    return pos;
  }

  /* --- acting ------------------------------------------------------------------ */

  /** A write, if the director may make one now. */
  async function write(id, fn) {
    if (paused()) throw new Refused(409, 'the owner paused the director from Slack (`director resume` there lets it carry on)');
    if (!bridge?.directorReady()) throw new Refused(409, 'Slack is not set up here, and nothing the director does may go unseen');
    if (!owns(id)) throw new Refused(403, 'not the director\'s session: it can write only to ones it started, or the owner handed it with `;director`');
    return fn();
  }

  /**
   * What a session on one of its accounts starts with: the account's own
   * profile and token. Refused, saying what to do, until both are ready - a
   * first start would stop on Claude Code's own questions, unseen.
   */
  function accountEnv(name, dir) {
    const accounts = accountsOf();
    const names = Object.keys(accounts);
    if (name == null) {
      if (names.length) throw new Refused(400, `account: say which - ${names.join(', ')}`);
      return null;
    }
    const a = accounts[String(name)];
    if (!a) throw new Refused(400, names.length ? `account: one of ${names.join(', ')}` : `account: none is set up in ${tilde(CONFIG_FILE)}`);
    if (!a.env || !a.profile) throw new Refused(409, `account ${name} needs an env file and a profile in ${tilde(CONFIG_FILE)}`);
    const envFile = expand(a.env), profile = expand(a.profile);
    const token = tokenIn(envFile);
    if (!token) throw new Refused(409, `account ${name} has no token yet: CLAUDE_CODE_OAUTH_TOKEN in ${tilde(envFile)}`);
    if (!/^[\w.~+/=-]+$/.test(token)) throw new Refused(409, `the token in ${tilde(envFile)} does not look like one`);
    const cfg = readJson(path.join(profile, '.claude.json'));
    const setUp = `run \`CLAUDE_CONFIG_DIR=${tilde(profile)} claude\` once in your projects folder, with its token set, to choose a theme and trust the folder`;
    if (!cfg?.hasCompletedOnboarding) throw new Refused(409, `${tilde(profile)} is not set up yet: ${setUp}`);
    // Trusting a folder trusts what is in it - as Claude sees it, through any symlink.
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const here = real(dir);
    const trusted = Object.entries(cfg.projects ?? {}).some(([p, v]) => v?.hasTrustDialogAccepted && [p, real(p)].some((t) => here === t || here.startsWith(`${t}/`)));
    if (!trusted) throw new Refused(409, `${tilde(dir)} is not trusted in ${tilde(profile)}: ${setUp}`);
    return { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_OAUTH_TOKEN: token };
  }

  async function launch(body) {
    if (paused()) throw new Refused(409, 'the owner paused the director from Slack');
    if (!bridge?.directorReady()) throw new Refused(409, 'Slack is not set up here, and nothing the director does may go unseen');
    const cwd = str(body.cwd, 'cwd', 1024);
    const name = body.name == null ? null : str(body.name, 'name', 40);
    if (name && !/^[A-Za-z0-9_-]+$/.test(name)) throw new Refused(400, 'name: letters, digits, _ and - only');
    const model = body.model == null ? null : str(body.model, 'model', 64);
    if (model && !/^[A-Za-z0-9._[\]-]+$/.test(model)) throw new Refused(400, 'model: a model name, such as opus or claude-opus-5-5');
    const prompt = body.prompt == null ? null : str(body.prompt, 'prompt', BODY_MAX);
    const env = accountEnv(body.account ?? null, path.resolve(cwd.replace(/^~(?=\/|$)/, HOME)));
    let r;
    try { r = await hands.act({ op: 'launch', dir: cwd, name, model, env }); } catch (err) { throw new Refused(400, err.message); }
    const l = { pane: r.pane, socket: r.socket, tmux: r.tmux, cwd: r.dir, prompt: prompt?.trim() ? prompt : null, at: Date.now(), checking: true };
    let s = await new Promise((resolve) => {
      l.found = resolve;
      launches.set(r.pane, l);
      setTimeout(() => resolve(null), LAUNCH_WAIT_MS).unref?.();
    });
    if (!s) {
      // Stopped on a question before it starts - a folder to trust, a first run - or ended: said, and the pane closed, rather than left waiting unseen.
      const x = await examine(l).catch(() => ({ state: 'starting' }));
      s = l.came ?? null;   // up while it was looked at
      if (!s && launches.get(r.pane) === l && x.state !== 'starting') {
        await abandon(l, x);
        throw new Refused(409, x.why);
      }
      l.checking = false;   // followed from here on: launch_failed if it never comes up
    }
    return { id: s?.sessionId ?? null, tmux: r.tmux, cwd: r.dir, ...(s ? {} : { pending: 'not up yet: its id comes with the started event, or launch_failed says why not' }) };
  }

  /* --- the API ------------------------------------------------------------------ */

  const str = (v, what, max) => {
    if (typeof v !== 'string' || !v.trim()) throw new Refused(400, `${what}: a string is needed`);
    if (v.length > max) throw new Refused(400, `${what}: too long`);
    return v;
  };

  async function list() {
    hands.wake();
    let all = hands.sessions();
    for (let i = 0; !all && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); all = hands.sessions(); }
    return (all ?? []).filter((s) => s.pane);
  }

  async function find(id) {
    const s = (await list()).find((x) => x.sessionId === id);
    if (!s) throw new Refused(404, 'no such session running here');
    return s;
  }

  async function describe(s) {
    const i = hands.info(s.sessionId) ?? {};
    const state = s.status === 'busy' ? 'working' : s.status === 'waiting' ? 'waiting' : 'idle';
    return {
      id: s.sessionId, name: s.tmux ?? s.name ?? (path.basename(s.cwd ?? '') || null), title: s.title ?? null,
      tmux: s.tmux ?? null, cwd: s.cwd ?? null, state,
      waiting: state === 'waiting' ? await prompt(s, 1) : null,
      context: i.context?.tokens ? { tokens: i.context.tokens, percent: percentOf(i.context) } : null,
      account: i.account ?? null, startedAt: s.startedAt ?? null,
      lastActivityAt: Math.max(s.statusAt ?? 0, i.lastActivityAt ?? 0) || null,
      owner: owns(s.sessionId) ? 'director' : 'owner',
      thread: bridge?.threadOf(s.sessionId) ?? null,
      controllable: !!s.controllable,
    };
  }

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_MAX + 4096) throw new Refused(400, 'too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return text ? JSON.parse(text) : {}; } catch { throw new Refused(400, 'not JSON'); }
  }

  /** Only from this machine, never from a browser, and only with the key. */
  function allowed(req) {
    const ip = req.socket.remoteAddress ?? '';
    if (!/^(?:127\.|::1$|::ffff:127\.)/.test(ip)) throw new Refused(403, 'loopback only');
    if (req.headers.origin !== undefined) throw new Refused(403, 'not from a web page');
    const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
    const given = Buffer.from(m?.[1] ?? '');
    const key = Buffer.from(directorKey());
    if (given.length !== key.length || !crypto.timingSafeEqual(given, key)) throw new Refused(401, 'a key is needed: Authorization: Bearer <~/.claude/tracker/director.key>');
    usedAt = Date.now();
  }

  async function route(req, res, url) {
    allowed(req);
    const parts = url.pathname.replace(/^\/api\/director\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const [a, id, op] = parts;
    const get = req.method === 'GET', postReq = req.method === 'POST';
    if (a === 'sessions' && !id && get) return { paused: paused(), sessions: await Promise.all((await list()).map(describe)) };
    if (a === 'sessions' && !id && postReq) return launch(await body(req));
    if (a === 'sessions' && id && !op && get) return describe(await find(id));
    if (a === 'sessions' && id && op && parts.length === 3) {
      const s = await find(id);
      if (get && op === 'screen') {
        const r = await hands.act({ op: 'screen', sessionId: id });
        return { text: r.screen.text, choices: (r.screen.options ?? []).map((o, i) => ({ key: String(i + 1), label: o.label })) };
      }
      if (get && op === 'turns') {
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
        const t = turnIndex(id);
        const turns = t ? readTurns(t, after, limit) : [];
        // The newest turn is done once the session has stopped working on it.
        for (const turn of turns) turn.done = turn.n < t.starts.length || (s.status !== 'busy' && s.status !== 'waiting');
        return { turns, next: turns.at(-1)?.n ?? after };
      }
      if (postReq && op === 'type') {
        const b = await body(req);
        const text = str(b.text, 'text', BODY_MAX);
        return write(id, () => bridge.directorType(id, text));
      }
      if (postReq && op === 'keys') {
        const b = await body(req);
        if (b.choice != null) {
          const n = Number(b.choice);
          if (!Number.isInteger(n) || n < 1 || n > 9) throw new Refused(400, 'choice: 1 to 9');
          return write(id, () => bridge.directorKeys(id, { choice: n }));
        }
        if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > 20 || b.keys.some((k) => typeof k !== 'string')) throw new Refused(400, 'keys: a list of key names, such as ["2"] or ["down", "enter"]');
        try { parseKeys(b.keys); } catch (err) { throw new Refused(400, err.message); }
        return write(id, () => bridge.directorKeys(id, { keys: b.keys }));
      }
      if (postReq && op === 'command') {
        const b = await body(req);
        const name = String(b.name ?? '');
        if (!['compact', 'clear', 'model'].includes(name)) throw new Refused(400, 'name: compact, clear or model');
        const arg = b.arg == null ? '' : String(b.arg).trim();
        if (name === 'model' && !/^[A-Za-z0-9._[\]-]{1,64}$/.test(arg)) throw new Refused(400, 'model needs arg: a model name, such as opus');
        if (name !== 'model' && name !== 'compact' && arg) throw new Refused(400, `${name} takes no arg`);
        if (arg.length > 2000) throw new Refused(400, 'arg: too long');
        return write(id, () => bridge.directorType(id, `/${name}${arg ? ` ${arg}` : ''}`, 'ran'));
      }
      if (postReq && op === 'stop') {
        return write(id, async () => {
          // Said before typing: Claude can have exited before this hears back.
          const v = seen.get(id);
          if (v) v.stopping = true;
          try { return await bridge.directorType(id, '/exit', 'stopped it with'); } catch (err) {
            if (v) v.stopping = false;
            throw err;
          }
        });
      }
    }
    if (a === 'events' && !id && get) {
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      const wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
      return events(after, wait, res);
    }
    if (a === 'thread' && postReq) {
      if (!bridge?.directorReady()) throw new Refused(409, 'Slack is not set up here');
      const b = await body(req);
      const text = str(b.text, 'text', 12_000);
      const choices = b.choices == null ? null : b.choices;
      if (choices && (!Array.isArray(choices) || choices.length > 9 || choices.some((c) => typeof c?.key !== 'string' || !c.key || typeof c?.label !== 'string' || !c.label))) {
        throw new Refused(400, 'choices: at most 9 of { key, label }');
      }
      if (!id) {
        const kind = String(b.kind ?? 'note');
        if (!['brief', 'decision', 'note'].includes(kind)) throw new Refused(400, 'kind: brief, decision or note');
        return bridge.directorPost({ text, kind, ref: b.ref == null ? null : String(b.ref).slice(0, 200), choices });
      }
      const r = await bridge.directorEdit(id, { text, choices });
      if (!r) throw new Refused(404, 'not a message of the director\'s');
      return r;
    }
    throw new Refused(404, 'not found');
  }

  return {
    /** Answer a request under /api/director/. */
    handle(req, res, url, sendJson) {
      route(req, res, url).then((r) => sendJson(res, r), (err) => {
        if (!(err instanceof Refused)) log(`director ${url.pathname}: ${err.message}`);
        if (!res.headersSent) sendJson(res, { error: err.message }, err instanceof Refused ? err.status : 409);
      });
    },
    attach(b) { bridge = b; },
    /** Worth following the sessions here for: it has asked lately, or has sessions of its own. */
    wanted: () => Date.now() - usedAt < 10 * 60_000 || !!q.owned.all().length,
    sessions,
    items,
    owns,
    paused,
    /** The owner, from Slack: a session handed over or taken back, the director paused or resumed, a reply, a tap. */
    hand(id, on) {
      if (on === owns(id)) return false;
      if (on) q.give.run(id, Date.now(), 'handed'); else q.take.run(id);
      emit(id, on ? 'handed_over' : 'taken_back');
      return true;
    },
    pause(on) {
      if (on === paused()) return false;
      setMeta('director_paused', on ? '1' : '0');
      emit(null, on ? 'paused' : 'resumed');
      return true;
    },
    owner(kind, detail, from = null) { emit(null, kind, detail, from); },
    stop() { clearInterval(watch); clearInterval(pruner); for (const w of waiters) w(); },
  };
}
