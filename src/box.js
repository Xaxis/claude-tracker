import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine's shared GPU lease and CPU pool, as claude-core's `gpu` and
 * `heavy` keep them, with every holder and waiter named by its Claude session.
 *
 * Only one job holds the GPU at a time, and a job behind a long render can wait
 * ten minutes or more: work stalls, and an agent on Claude Code's default
 * 5-minute subagent cache re-writes its whole context when it resumes. Neither
 * tool says which session is waiting; the job's own environment does, because
 * Claude Code puts CLAUDE_CODE_SESSION_ID in every command it runs.
 *
 * Read only. A machine without the tools (or a Mac, which has no /proc to
 * read an environment from) shows what the state files say, or nothing.
 */

const GPU_DIR = () => process.env.BOX_GPU_DIR || '/tmp/box-gpu';
const GPU_STATE = () => process.env.BOX_GPU_STATE || path.join(os.homedir(), '.local', 'state', 'box-gpu');
const HEAVY_DIR = () => process.env.BOX_HEAVY_DIR || '/tmp/box-heavy';
const PROC = () => process.env.CLAUDE_TRACKER_PROC || '/proc';

const HOUR = 3600e3;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };

/** Fields of /proc/<pid>/stat after the command name, or null when gone or a zombie. */
function procStat(pid) {
  try {
    const rest = fs.readFileSync(`${PROC()}/${pid}/stat`, 'utf8').split(')').pop().trim().split(/\s+/);
    return rest[0] === 'Z' || rest[0] === 'X' ? null : rest;
  } catch { return null; }
}

const hasProc = () => fs.existsSync(`${PROC()}/self`);

/** Is `pid` alive - and, where /proc can say, the same process that started at `start`? */
function alive(pid, start) {
  if (!pid) return false;
  if (hasProc()) {
    const st = procStat(pid);
    return !!st && (start == null || Number(st[19]) === Number(start));
  }
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// A process's environment never changes, so each is read once.
const envCache = new Map();

/** The Claude session that ran `pid`, and where, from its environment. */
function whoRan(pid) {
  // Keyed by start time as well: pids are reused.
  const key = `${pid}:${procStat(pid)?.[19] ?? ''}`;
  if (envCache.has(key)) return envCache.get(key);
  let out = { sessionId: null, cwd: null };
  try {
    const env = fs.readFileSync(`${PROC()}/${pid}/environ`, 'utf8').split('\0');
    const get = (k) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1) || null;
    out = { sessionId: get('CLAUDE_CODE_SESSION_ID'), cwd: get('PWD') };
  } catch { /* gone, another user's, or no /proc */ }
  if (envCache.size > 500) envCache.clear();
  envCache.set(key, out);
  return out;
}

/** One holder of a slot, from its info.json. */
function holder(dir, name, now) {
  const info = readJson(path.join(dir, name, 'info.json'));
  if (!info?.pid) return null;
  // The GPU lease lasts while any process of the job lives; its session id is the job's.
  if (!alive(info.pid, info.start) && !(info.sid && alive(info.sid))) return null;
  const who = whoRan(info.pid);
  const ran = who.sessionId ? who : whoRan(info.sid);
  return {
    slot: name, project: info.project ?? null, pid: info.pid,
    since: info.since ? info.since * 1000 : null,
    heldMs: info.since ? Math.max(0, now - info.since * 1000) : null,
    cmd: info.cmd ?? null, cwd: ran.cwd ?? info.cwd ?? null, sessionId: ran.sessionId,
    solo: !!info.solo, priority: !!info.priority,
  };
}

/**
 * Live queue tickets, oldest first. A ticket is `<time ns>-<pid>[-<start>]`: its
 * first line the project, then what it was started as (priority, solo, defer
 * ...). heavy notes why each waits in why/<ticket>, and the owner's "run next"
 * in next/<ticket>.
 */
function queue(dir, now) {
  const out = [];
  const next = new Set(list(path.join(dir, 'next')) ?? []);
  for (const name of list(path.join(dir, 'queue')) ?? []) {
    const [ns, pid, start] = name.replace(/^0/, '').split('-');
    if (!/^\d+$/.test(ns ?? '') || !/^\d+$/.test(pid ?? '')) continue;
    if (!alive(Number(pid), start)) continue;
    let lines;
    try { lines = fs.readFileSync(path.join(dir, 'queue', name), 'utf8').split('\n').map((l) => l.trim()); } catch { continue; }
    const since = Math.floor(Number(ns) / 1e6);
    const who = whoRan(Number(pid));
    out.push({ ticket: name, project: lines[0] || null, pid: Number(pid), since, waitedMs: Math.max(0, now - since),
      sessionId: who.sessionId, cwd: who.cwd, priority: lines.includes('priority'), solo: lines.includes('solo'),
      why: readJson(path.join(dir, 'why', name))?.why ?? null, next: next.has(name) });
  }
  return out;
}

/** The GPU lease log's last hour: how long jobs waited, and the longest hold. */
function gpuHour(now) {
  const file = path.join(GPU_STATE(), 'log.jsonl');
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // Only the tail: the log only grows, and an hour of it is a few hundred lines.
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const since = now - HOUR;
  let jobs = 0, waitedMs = 0, longestWait = null, longestHold = null, refused = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!(r.t * 1000 >= since)) continue;
    if (r.event === 'grant') {
      jobs++;
      const w = (r.wait_s ?? 0) * 1000;
      waitedMs += w;
      if (!longestWait || w > longestWait.ms) longestWait = { ms: w, project: r.project ?? null };
    } else if (r.event === 'release' && r.held_s != null) {
      const h = r.held_s * 1000;
      if (!longestHold || h > longestHold.ms) longestHold = { ms: h, project: r.project ?? null };
    } else if (r.event === 'refuse' || r.event === 'kill' || r.event === 'software') {
      refused++;
    }
  }
  return { jobs, waitedMs, longestWait, longestHold, refused };
}

const slotNames = (dir) => (list(dir) ?? []).filter((n) => n.startsWith('slot.'));

/**
 * Who holds and who waits for the GPU and the CPU pool right now, or null when
 * this machine has neither. Waiters come oldest first. Read at most once a
 * second, however many dashboards ask.
 */
let memo = null;
export function boxState(now = Date.now()) {
  if (memo && Math.abs(now - memo.at) < 1000) return memo.value;
  const value = readBox(now);
  memo = { at: now, value };
  return value;
}

/** A pool's live settings, which heavy and gpu publish as config.json on every run, or {}. */
function config(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) ?? {}; } catch { return {}; }
}

/** heavy's live settings: slots, shares, the load gate, where the owner's priorities live. */
export const poolConfig = () => config(HEAVY_DIR());

/** Threads that want a CPU right now, the number heavy gates on (/proc/loadavg's runnable
 *  count); the 1-minute load where there is no /proc. */
function cpuDemand() {
  try {
    const n = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[3].split('/')[0]);
    if (Number.isFinite(n)) return n;
  } catch {}
  return os.loadavg()[0];
}

function readBox(now) {
  const gpuDir = GPU_DIR(), heavyDir = HEAVY_DIR();
  const hasGpu = list(gpuDir) != null, hasHeavy = list(heavyDir) != null;
  if (!hasGpu && !hasHeavy) return null;
  const out = { gpu: null, cpu: null };
  if (hasGpu) {
    out.gpu = {
      held: slotNames(gpuDir).map((n) => holder(gpuDir, n, now)).filter(Boolean),
      waiting: queue(gpuDir, now),
      quarantined: fs.existsSync(path.join(GPU_STATE(), 'quarantine.json')),
      slots: config(gpuDir).slots ?? 2,
      hour: gpuHour(now),
    };
  }
  if (hasHeavy) {
    const cores = os.cpus().length || 4, cfg = config(heavyDir);
    out.cpu = {
      held: slotNames(heavyDir).map((n) => holder(heavyDir, n, now)).filter(Boolean),
      waiting: queue(heavyDir, now),
      // heavy publishes what it runs with; before its first run, its defaults.
      slots: cfg.slots ?? (Number(process.env.BOX_HEAVY_SLOTS) || cores),
      gate: cfg.load ?? cores * 1.25,
      load: cpuDemand(), cores,
    };
  }
  return out;
}

/** The worktree a job ran in - `m9-translate` - or null for a main checkout. */
function placeOf(cwd) {
  if (!cwd) return null;
  const m = /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/.exec(cwd) ?? /-wt[/\\]([^/\\]+)/.exec(cwd);
  return m ? m[1] : null;
}

/**
 * Waiters gathered by session and worktree, oldest first: one agent's test run
 * queues several jobs at once, and they read as one wait.
 */
function gather(waiting, nameOf, placeName) {
  const groups = new Map();
  waiting.forEach((w, i) => {
    const place = placeName(w.sessionId, placeOf(w.cwd));
    const key = `${w.sessionId ?? w.project}|${place}`;
    const g = groups.get(key);
    if (g) { g.jobs++; g.since = Math.min(g.since, w.since); return; }
    groups.set(key, { project: w.project, session: nameOf(w.sessionId), sessionId: w.sessionId, place, jobs: 1, since: w.since, ahead: i });
  });
  return [...groups.values()];
}

const shortCmd = (cmd) => (cmd ?? '').replace(/^(env\s+(-u\s+\S+\s+|\S+=\S+\s+)*)/, '').replace(/^(\S*\/)?(\S+)/, '$2').slice(0, 120);

/**
 * The GPU and CPU pool for the dashboards, every job named by its session
 * (`nameOf` turns a session id into a name) and worktree (`placeName` names a
 * subagent's). Small enough to send
 * to synced machines as it is, and dated rather than timed, so it only changes
 * when a job comes or goes.
 */
export function boxView(box, nameOf = () => null, placeName = (_id, place) => place) {
  if (!box) return null;
  const view = (s) => s && {
    held: s.held.map((h) => ({ project: h.project, session: nameOf(h.sessionId), sessionId: h.sessionId,
      place: placeName(h.sessionId, placeOf(h.cwd)), since: h.since, cmd: shortCmd(h.cmd) })),
    waiting: gather(s.waiting, nameOf, placeName),
    jobsWaiting: s.waiting.length,
  };
  const gpu = view(box.gpu);
  const cpu = view(box.cpu);
  if (gpu) Object.assign(gpu, { quarantined: box.gpu.quarantined, hour: box.gpu.hour });
  if (cpu) Object.assign(cpu, { slots: box.cpu.slots, gate: box.cpu.gate, load: box.cpu.load, cores: box.cpu.cores });
  return { gpu, cpu };
}

/**
 * What one session's jobs are doing with the shared GPU and CPU pool: those
 * that hold a slot, and those waiting for one - with what they wait behind.
 */
export function sessionLeases(view, sessionIds) {
  if (!view) return [];
  const ids = new Set(sessionIds.filter(Boolean));
  const out = [];
  for (const kind of ['gpu', 'cpu']) {
    const s = view[kind];
    if (!s) continue;
    for (const h of s.held) if (ids.has(h.sessionId)) out.push({ kind, state: 'holds', since: h.since, place: h.place, jobs: 1 });
    for (const w of s.waiting) {
      if (!ids.has(w.sessionId)) continue;
      // The GPU is one lease, so a waiter waits behind whoever holds it. The CPU
      // pool has several slots and a load gate: nobody in particular.
      out.push({ kind, state: 'waits', since: w.since, place: w.place, jobs: w.jobs, ahead: w.ahead,
        behind: kind === 'gpu' ? s.held.map((h) => ({ who: h.session ?? h.project, project: h.project, since: h.since })) : [] });
    }
  }
  return out;
}
