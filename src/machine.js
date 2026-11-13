import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boxState, poolConfig } from './box.js';

/**
 * What is using this machine right now - its cores, memory and GPU - by project,
 * Claude session and job, and how that went over the last hour.
 *
 * Asking "what is occupying the cores?" used to take a session ps, heavy
 * --status and guesswork. Everything needed is already on the box: every
 * process's CPU time and memory in /proc, each heavy job's exact use in its
 * own cgroup, and whose a process is in its environment (Claude Code puts
 * CLAUDE_CODE_SESSION_ID in every command it runs) or its ancestry.
 *
 * Each process is counted once, in the first of: a heavy job (its scope's
 * cgroup says whose), a running Claude session (by its environment, or by
 * descent from the session's own process), a process an ended session left
 * running, this tracker, and everything else (the desktop, your browser, the
 * system). Linux only; elsewhere there is no view.
 */

const PROC = () => process.env.CLAUDE_TRACKER_PROC || '/proc';
const CGROUP = () => process.env.CLAUDE_TRACKER_CGROUP || '/sys/fs/cgroup';
const DRM = () => process.env.CLAUDE_TRACKER_DRM || '/sys/class/drm';
const TICK = 100;                 // USER_HZ: what /proc's CPU times count in, on every Linux Node runs on
const STEP = 3000;                // a sample every 3 s
const KEEP = 3600e3;              // an hour of them
const HOME = os.homedir();

let PAGE = 4096;
try { PAGE = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 2000 }).trim()) || 4096; } catch { /* 4 KB */ }

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
export const hasProc = () => fs.existsSync(`${PROC()}/self/stat`) && process.platform === 'linux';

/* --- the machine as a whole ----------------------------------------------- */

/** Busy and total jiffies across every core, from /proc/stat's first line. */
function cpuTimes() {
  const line = read(`${PROC()}/stat`)?.split('\n', 1)[0];
  if (!line?.startsWith('cpu ')) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0);                     // idle + iowait
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0); // guest time is already in user
  return { busy: total - idle, total };
}

/** /proc/pressure: the share of the last 10 s that some task waited for the CPU, memory or disk. */
function pressure() {
  const out = {};
  for (const k of ['cpu', 'memory', 'io']) {
    const m = /some avg10=([\d.]+)/.exec(read(`${PROC()}/pressure/${k}`) ?? '');
    out[k] = m ? Number(m[1]) : null;
  }
  return out;
}

function memory() {
  const t = read(`${PROC()}/meminfo`) ?? '';
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? 0) * 1024;
  const total = kb('MemTotal'), available = kb('MemAvailable');
  return { total, available, used: total - available, swapUsed: kb('SwapTotal') - kb('SwapFree'), swapTotal: kb('SwapTotal') };
}

/** The GPU's busy share and memory, where the driver says (amdgpu does); null otherwise. */
function gpuNow() {
  let cards = [];
  try { cards = fs.readdirSync(DRM()).filter((n) => /^card\d+$/.test(n)); } catch { return null; }
  for (const c of cards) {
    const dev = path.join(DRM(), c, 'device');
    const busy = read(path.join(dev, 'gpu_busy_percent'));
    if (busy == null) continue;
    return {
      busy: Number(busy),
      vramUsed: Number(read(path.join(dev, 'mem_info_vram_used')) ?? 0) || null,
      vramTotal: Number(read(path.join(dev, 'mem_info_vram_total')) ?? 0) || null,
    };
  }
  return null;
}

/* --- processes ------------------------------------------------------------- */

/** One process from /proc/<pid>/stat: its name, parent, CPU time and resident memory. */
function procStat(pid) {
  const s = read(`${PROC()}/${pid}/stat`);
  if (!s) return null;
  const close = s.lastIndexOf(')');
  const r = s.slice(close + 2).split(' ');
  if (r[0] === 'Z' || r[0] === 'X') return null;
  return {
    pid, comm: s.slice(s.indexOf('(') + 1, close), ppid: Number(r[1]),
    cpu: Number(r[11]) + Number(r[12]), start: Number(r[19]), threads: Number(r[17]), rss: Number(r[21]) * PAGE,
  };
}

// What never changes for a process - its cgroup, environment and command line -
// is read once, keyed by pid and start time, since pids are reused.
const fixed = new Map();
function fixedOf(p) {
  const key = `${p.pid}:${p.start}`;
  let f = fixed.get(key);
  if (f) return f;
  const cg = (read(`${PROC()}/${p.pid}/cgroup`) ?? '').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? '';
  let sessionId = null, pwd = null;
  const env = read(`${PROC()}/${p.pid}/environ`);
  if (env) {
    for (const e of env.split('\0')) {
      if (e.startsWith('CLAUDE_CODE_SESSION_ID=')) sessionId = e.slice(23) || null;
      else if (e.startsWith('PWD=')) pwd = e.slice(4) || null;
    }
  }
  const argv = (read(`${PROC()}/${p.pid}/cmdline`) ?? '').split('\0').filter(Boolean);
  // A Claude Code process is a session even when the tracker has not heard of it yet.
  const claude = p.comm === 'claude';
  let cwd = null;
  if (claude) { try { cwd = fs.readlinkSync(`${PROC()}/${p.pid}/cwd`); } catch {} }
  const tracker = argv.slice(1, 3).some((a) => /(?:^|\/)claude-tracker(?:\/bin\/cli\.js)?$/.test(a));
  f = { cg, sessionId, pwd, cwd, claude, tracker, cmd: argv.join(' ').slice(0, 300), label: procLabel(p.comm, argv) };
  fixed.set(key, f);
  return f;
}

// Names that say only which interpreter runs: Node calls its main thread MainThread.
const GENERIC = /^(?:MainThread|node|nodejs|python[\d.]*|bash|sh|dash|zsh|npm|npx|yarn|pnpm|bun|deno|java|ruby|perl|env|timeout|nice|uv|tsx|electron)$/;

/** What a process is, for a person: its name, or for an interpreter the script it runs. */
function procLabel(comm, argv) {
  if (!GENERIC.test(comm) || !argv.length) return comm;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // `sh -c "heavy npm test"` runs its first word; `node -e '…'` runs a script with no name.
    if (a === '-c' && args[i + 1]) return procLabel('sh', ['sh', ...args[i + 1].trim().split(/\s+/)]);
    if (/^(?:-e|-p|--eval|--print)$/.test(a)) return `${comm === 'MainThread' ? 'node' : comm} ${a}`;
    if (a.startsWith('-') || /^[A-Z_]+=/.test(a)) continue;
    const base = path.basename(a);
    if (GENERIC.test(base)) continue;
    return base.slice(0, 40);
  }
  return comm === 'MainThread' ? 'node' : comm;
}

/* --- projects --------------------------------------------------------------- */

const projectMemo = new Map();

/**
 * The project a directory belongs to, named as heavy names it, so a project's
 * sessions and its jobs meet under one name: a session's folder's project, else
 * the main repository's directory name (a worktree counts as its repo), else the
 * directory's own name.
 */
/**
 * The main checkout `dir` belongs to, as `git rev-parse --git-common-dir` would
 * say (a worktree counts as its repo), or null outside a repository. Read from
 * the .git files themselves: a git per folder blocked the server for seconds
 * on a loaded box, once per folder a session had used.
 */
const topMemo = new Map();
export function gitTop(dir) {
  if (!dir) return null;
  if (topMemo.has(dir)) return topMemo.get(dir);
  let top = null;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* not here */ }
    if (st?.isDirectory()) { top = d; break; }
    if (st?.isFile()) {
      // A worktree's .git names its gitdir, whose commondir leads to the main repository's .git.
      const m = /^gitdir:\s*(.+)$/m.exec(read(g) ?? '');
      if (m) {
        const gitdir = path.resolve(d, m[1].trim());
        const common = path.resolve(gitdir, (read(path.join(gitdir, 'commondir')) ?? '').trim() || '.');
        top = path.basename(common) === '.git' ? path.dirname(common) : common;
      }
      break;
    }
    if (path.dirname(d) === d) break;
  }
  if (topMemo.size > 5000) topMemo.clear();
  topMemo.set(dir, top);
  return top;
}

export function projectOf(dir) {
  if (!dir) return null;
  if (projectMemo.has(dir)) return projectMemo.get(dir);
  let name = null;
  // A Claude session's own folders (its scratchpad in the temp dir's claude-<uid>, its
  // ~/.claude/projects folder) are named for the directory it works in; the innermost
  // names it, should one session work inside another's scratchpad.
  const parts = dir.split('/');
  for (let i = parts.length - 1; i >= 1 && !name; i--) {
    if (parts[i].startsWith('-') && (/^claude-\d+$/.test(parts[i - 1]) || (parts[i - 1] === 'projects' && parts[i - 2] === '.claude'))) {
      name = encodedProject(parts[i]);
    }
  }
  if (!name) {
    const top = gitTop(dir);
    if (top) name = path.basename(top);
  }
  name ??= path.basename(dir) || dir;
  if (projectMemo.size > 2000) projectMemo.clear();
  projectMemo.set(dir, name);
  return name;
}

/**
 * The directory a Claude folder name stands for. Claude names a session's
 * folders for its working directory with every character but a letter or digit
 * made a dash ("/srv/my-app/.claude/worktrees/a" is "-srv-my-app--claude-worktrees-a"),
 * so the name is read back against the disk, a listing per level: {dir, rest},
 * the deepest directory that exists along it and what of the name is left
 * past it ('' when all of it matched).
 */
const decodeMemo = new Map();
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const encodeName = (s) => s.replace(/[^A-Za-z0-9]/g, '-');

/** The directories in `dir` an encoded name `e` may be, tried by name: a dash for '-', '.' or '_'. */
function probe(dir, e) {
  const gaps = e.split('-');
  if (gaps.length > 5) return [];
  let names = [gaps[0]];
  for (const g of gaps.slice(1)) names = names.flatMap((n) => ['-', '.', '_'].map((sep) => n + sep + g));
  return names.filter((n) => n && isDir(path.join(dir, n)));
}

/** Up to `max` directory names in `dir`: a temp dir can hold a hundred thousand. */
function someDirs(dir, max) {
  const out = [];
  let d = null;
  try {
    d = fs.opendirSync(dir);
    for (let e = d.readSync(), n = 0; e && n < max; e = d.readSync(), n++) if (e.isDirectory()) out.push(e.name);
  } catch { /* unreadable */ } finally { try { d?.closeSync(); } catch { /* closed */ } }
  return out;
}

export function decodeDir(enc) {
  if (decodeMemo.has(enc)) return decodeMemo.get(enc);
  let best = { dir: '/', rest: enc.slice(1) };
  const walk = (dir, rest, depth) => {
    if (rest === '') { best = { dir, rest }; return true; }
    if (dir.length > best.dir.length) best = { dir, rest };
    if (depth > 40) return false;
    const tokens = rest.split('-');
    const tried = new Set();
    for (let k = 1; k <= tokens.length; k++) {
      const after = tokens.slice(k).join('-');
      for (const n of probe(dir, tokens.slice(0, k).join('-'))) {
        tried.add(n);
        if (walk(path.join(dir, n), k === tokens.length ? '' : after, depth + 1)) return true;
      }
    }
    // A name a dash stands in for more than those three ("a b", "a+b"): from a listing.
    for (const n of someDirs(dir, 5000)) {
      const e = encodeName(n);
      if (tried.has(n) || !(rest === e || rest.startsWith(`${e}-`))) continue;
      if (walk(path.join(dir, n), rest === e ? '' : rest.slice(e.length + 1), depth + 1)) return true;
    }
    return false;
  };
  if (enc.startsWith('-')) walk('/', enc.slice(1), 0);
  if (decodeMemo.size > 2000) decodeMemo.clear();
  decodeMemo.set(enc, best);
  return best;
}

/**
 * The project of a Claude folder name: its directory's, or, when that is gone,
 * its repository's (a removed worktree's), else the first of what is left
 * ("-srv-gone-app" with /srv still there is "gone-app").
 */
export function encodedProject(enc) {
  const { dir, rest } = decodeDir(enc);
  if (!rest) return projectOf(dir);
  const top = gitTop(dir);
  if (top) return path.basename(top);
  return rest.split('--')[0] || null;
}

/* --- the owner's priorities ------------------------------------------------- */

export const TIERS = ['high', 'normal', 'low', 'paused'];
const WEIGHTS = { high: '400', normal: '100', low: '20', paused: 'idle' };

/** Where heavy reads the owner's priorities: what it publishes, else its default. */
export function priorityFile() {
  return poolConfig().priority_file || process.env.BOX_PRIORITY_FILE
    || path.join(HOME, '.local', 'state', 'box', 'priority.json');
}

/**
 * The owner's ranks: {set, ranks, file, updated, by}. Without the file, the
 * ranks heavy keeps of its own, as it publishes them; every other project normal.
 */
export function priorities() {
  const file = priorityFile();
  const text = read(file);
  if (text == null) return { set: false, ranks: { ...(poolConfig().unset_ranks ?? {}) }, file, updated: null, by: null };
  try {
    const d = JSON.parse(text);
    const ranks = {};
    for (const [p, t] of Object.entries(d.projects ?? {})) if (TIERS.includes(t)) ranks[p] = t;
    return { set: true, ranks, file, updated: d.updated ? d.updated * 1000 : null, by: d.by ?? null };
  } catch { return { set: true, ranks: {}, file, updated: null, by: null, broken: true }; }
}

/* --- sampling ---------------------------------------------------------------- */

let prev = null;           // the last pass: per-process CPU times and per-scope usage
let latest = null;         // the last sample, as the view is built from it
const history = [];        // {t, busy, demand, mem, by: {project: cores}}, a sample each STEP

/** Which bucket outside every project a process belongs to, from its cgroup. */
function otherKind(cg, uid) {
  if (/app-(?:org\.chromium\.Chromium|google-chrome|firefox|org\.mozilla|brave|microsoft-edge)/i.test(cg)) return 'browser';
  if (/\/session\.slice\/|gnome-shell|\/init\.scope$|xdg-desktop|pipewire|wireplumber/.test(cg)) return 'desktop';
  if (uid !== process.getuid?.() || /^\/system\.slice\//.test(cg) || cg === '/' || cg === '/init.scope') return 'system';
  return 'other';
}

/**
 * Take one sample: every process's CPU since the last pass, heavy jobs from
 * their cgroups, all of it put in a bucket. `sessions` is the running Claude
 * sessions: [{sessionId, parkedJobId, pid, cwd, name, status}].
 */
export function sample(sessions = [], now = Date.now()) {
  if (!hasProc()) return null;
  const times = cpuTimes();
  const dt = prev ? (now - prev.at) / 1000 : 0;

  // Every live process, once.
  const procs = new Map();
  let names = [];
  try { names = fs.readdirSync(PROC()); } catch { return null; }
  for (const n of names) {
    if (n.charCodeAt(0) < 48 || n.charCodeAt(0) > 57) continue;
    const p = procStat(Number(n));
    if (p) procs.set(p.pid, p);
  }
  const uids = new Map();
  const uidOf = (pid) => {
    if (!uids.has(pid)) { try { uids.set(pid, fs.statSync(`${PROC()}/${pid}`).uid); } catch { uids.set(pid, -1); } }
    return uids.get(pid);
  };

  // Running sessions by every id their commands carry, and by their own process.
  const bySid = new Map(), byPid = new Map();
  for (const s of sessions) {
    const info = { ...s, project: projectOf(s.cwd) };
    for (const id of [s.sessionId, s.parkedJobId]) if (id) bySid.set(id, info);
    if (s.pid) byPid.set(s.pid, info);
  }

  // heavy's slot holders by pid: a job's scope is named for its holder.
  const box = boxState(now);
  const holders = new Map((box?.cpu?.held ?? []).map((h) => [h.pid, h]));

  // Whose each process is.
  const owner = new Map();
  const ownerOf = (pid, depth = 0) => {
    if (owner.has(pid)) return owner.get(pid);
    const p = procs.get(pid);
    if (!p) return null;
    const f = fixedOf(p);
    let o = null;
    const job = /\/(heavy-[^/]*-(\d+)-(\d+)\.scope)(?:\/|$)/.exec(f.cg);
    if (job) o = { kind: 'job', scope: f.cg.slice(0, job.index + job[1].length + 1), unit: job[1], holder: Number(job[2]) };
    else if (pid === process.pid) o = { kind: 'tracker' };
    else if (byPid.has(pid)) o = { kind: 'session', s: byPid.get(pid) };
    else if (f.sessionId && bySid.has(f.sessionId)) o = { kind: 'session', s: bySid.get(f.sessionId) };
    else if (f.claude && f.cwd) {
      o = { kind: 'session', s: { sessionId: `pid:${pid}`, pid, cwd: f.cwd, project: projectOf(f.cwd),
        name: / /.test(f.cmd) ? f.cmd.replace(/^\S*\//, '').slice(0, 60) : null } };
    }
    else if (f.tracker || /\/claude-tracker\.service$/.test(f.cg)) o = { kind: 'tracker' };
    else if (depth < 64 && p.ppid > 1 && procs.has(p.ppid)) {
      // A child is its parent's only when the parent is someone's: systemd and the terminal are no one's.
      const up = ownerOf(p.ppid, depth + 1);
      if (up && (up.kind === 'session' || up.kind === 'leftover' || up.kind === 'tracker')) o = up;
    }
    if (!o && f.sessionId) o = { kind: 'leftover', sessionId: f.sessionId, project: projectOf(f.pwd) };
    if (!o) o = { kind: otherKind(f.cg, uidOf(pid)) };
    owner.set(pid, o);
    return o;
  };

  // CPU each process used since the last pass, in cores.
  const cpuNow = new Map();
  for (const p of procs.values()) {
    const was = prev?.procs.get(p.pid);
    const used = was && was.start === p.start ? Math.max(0, p.cpu - was.cpu) : 0;
    cpuNow.set(p.pid, dt > 0 ? used / TICK / dt : 0);
  }

  // Buckets: a project each, then the machine's own.
  const buckets = new Map();
  const bucket = (key, kind, name) => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, kind, name, cores: 0, mem: 0, procs: 0, sessions: new Map(), jobs: new Map(), leftovers: new Map(), comms: new Map() };
      buckets.set(key, b);
    }
    return b;
  };
  const addComm = (map, p, cores) => {
    const label = fixedOf(p).label;
    const c = map.get(label) ?? { comm: label, cores: 0, mem: 0, n: 0 };
    c.cores += cores; c.mem += p.rss; c.n++;
    map.set(label, c);
  };

  const scopes = new Map();
  for (const p of procs.values()) {
    const o = ownerOf(p.pid);
    const cores = cpuNow.get(p.pid) ?? 0;
    if (o.kind === 'job') {
      let j = scopes.get(o.scope);
      if (!j) {
        const h = holders.get(o.holder);
        j = { scope: o.scope, unit: o.unit, holder: o.holder, held: h ?? null, procs: 0, comms: new Map(),
          project: h?.project ?? o.unit.replace(/^heavy-/, '').replace(/-\d+-\d+\.scope$/, '') };
        scopes.set(o.scope, j);
      }
      j.procs++;
      addComm(j.comms, p, cores);
    } else if (o.kind === 'session') {
      const b = bucket(`p:${o.s.project}`, 'project', o.s.project);
      b.cores += cores; b.mem += p.rss; b.procs++;
      let s = b.sessions.get(o.s.sessionId);
      if (!s) {
        s = { sessionId: o.s.sessionId, name: o.s.name ?? null, status: o.s.status ?? null, cwd: o.s.cwd ?? null,
          cores: 0, mem: 0, procs: 0, comms: new Map() };
        b.sessions.set(o.s.sessionId, s);
      }
      s.cores += cores; s.mem += p.rss; s.procs++;
      addComm(s.comms, p, cores);
    } else if (o.kind === 'leftover') {
      const name = o.project ?? 'unknown';
      const b = bucket(`p:${name}`, 'project', name);
      b.cores += cores; b.mem += p.rss; b.procs++;
      const l = b.leftovers.get(o.sessionId) ?? { sessionId: o.sessionId, cores: 0, mem: 0, procs: 0, comms: new Map() };
      l.cores += cores; l.mem += p.rss; l.procs++;
      addComm(l.comms, p, cores);
      b.leftovers.set(o.sessionId, l);
    } else {
      const b = bucket(o.kind, o.kind, o.kind);
      b.cores += cores; b.mem += p.rss; b.procs++;
      addComm(b.comms, p, cores);
    }
  }

  // heavy jobs: exact CPU and memory from each scope's cgroup, children it reaped included.
  const scopeUse = new Map();
  for (const j of scopes.values()) {
    const dir = path.join(CGROUP(), j.scope);
    const usage = Number(/usage_usec (\d+)/.exec(read(path.join(dir, 'cpu.stat')) ?? '')?.[1] ?? NaN);
    const stat = read(path.join(dir, 'memory.stat')) ?? '';
    const field = (k) => Number(new RegExp(`^${k} (\\d+)`, 'm').exec(stat)?.[1] ?? 0);
    const current = Number(read(path.join(dir, 'memory.current')) ?? NaN);
    // What the job holds, not the page cache its reads left behind, which the kernel drops at need.
    const mem = Number.isFinite(current) ? Math.max(0, current - field('active_file') - field('inactive_file')) : null;
    scopeUse.set(j.scope, usage);
    const was = prev?.scopeUse.get(j.scope);
    let cores = Number.isFinite(usage) && Number.isFinite(was) && dt > 0 ? Math.max(0, usage - was) / 1e6 / dt : null;
    if (cores == null) cores = [...j.comms.values()].reduce((a, c) => a + c.cores, 0);
    const memUse = mem ?? [...j.comms.values()].reduce((a, c) => a + c.mem, 0);
    const b = bucket(`p:${j.project}`, 'project', j.project);
    b.cores += cores; b.mem += memUse; b.procs += j.procs;
    // A scope is named for its heavy, which lives as long as the job: one whose heavy is gone
    // holds what a killed job left running, nobody's any more.
    if (!procs.has(j.holder)) {
      const ns = Number(/-(\d+)\.scope$/.exec(j.unit)?.[1]);
      b.leftovers.set(j.scope, { orphan: true, unit: j.unit, since: Number.isFinite(ns) ? Math.floor(ns / 1e6) : null,
        cores, mem: memUse, procs: j.procs, comms: j.comms });
      continue;
    }
    // A job heavy started before projects had slices of their own runs at app.slice's share.
    b.jobs.set(j.scope, { ...j, cores, mem: memUse, legacy: /\/app\.slice\/heavy-/.test(j.scope) });
  }

  const busy = times && prev?.times && times.total > prev.times.total
    ? ((times.busy - prev.times.busy) / (times.total - prev.times.total)) * os.cpus().length : null;
  const loadavg = (read(`${PROC()}/loadavg`) ?? '').split(' ');
  const s = {
    at: now, dt,
    cpu: {
      cores: os.cpus().length || 1, busy,
      demand: Number(loadavg[3]?.split('/')[0]) || 0,
      load: [Number(loadavg[0]) || 0, Number(loadavg[1]) || 0, Number(loadavg[2]) || 0],
      pressure: pressure(),
    },
    mem: memory(), gpu: gpuNow(), buckets, box,
  };
  prev = { at: now, times, procs, scopeUse };
  for (const k of fixed.keys()) {
    const pid = Number(k.split(':')[0]);
    if (!procs.has(pid)) fixed.delete(k);
  }
  if (dt > 0) {
    latest = s;
    const by = {};
    for (const b of buckets.values()) if (b.cores >= 0.05) by[b.kind === 'project' ? b.name : `:${b.kind}`] = Math.round(b.cores * 100) / 100;
    history.push({ t: now, busy, demand: s.cpu.demand, mem: s.mem.used, by });
    while (history.length && history[0].t < now - KEEP) history.shift();
  }
  return s;
}

/* --- the sampler ------------------------------------------------------------- */

let timer = null;

/** Sample every few seconds in the background, with the running sessions `sessions()` gives. */
export function startSampler(sessions) {
  if (timer || !hasProc()) return;
  const tick = () => { try { sample(sessions()); } catch (err) { console.error('machine sample:', err.message); } };
  tick();
  timer = setInterval(tick, STEP);
  timer.unref?.();
}

export function stopSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Two samples a moment apart, for a one-off look (the CLI), when no sampler runs. */
export async function sampleNow(sessions, gapMs = 1000) {
  if (!hasProc()) return null;
  if (latest && Date.now() - latest.at < STEP * 2) return latest;
  sample(sessions());
  await new Promise((r) => setTimeout(r, gapMs));
  sample(sessions());
  return latest;
}

/* --- the view ------------------------------------------------------------------ */

const OTHER_LABEL = { tracker: 'claude-tracker', desktop: 'Desktop', browser: 'Your browser', system: 'System', other: 'Other processes' };
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const tops = (comms, n = 3) => [...comms.values()].sort((a, b) => b.cores - a.cores || b.mem - a.mem).slice(0, n)
  .map((c) => ({ comm: c.comm, cores: round(c.cores), mem: c.mem, n: c.n }));

/** A project as the owner names it: home is "~", the projects folder "Projects". */
function labelOf(name) {
  if (name === path.basename(HOME)) return `~ (${name})`;
  return name;
}

/**
 * The machine for the dashboards: totals, every project with its rank,
 * sessions, jobs and waiting jobs (and why each waits), the machine's own
 * buckets, and the last hour, a point every `step` ms. `nameOf` names a
 * session from its id.
 */
export function machineView({ step = 15e3, nameOf = () => null, placeName = (_id, p) => p } = {}) {
  const s = latest;
  if (!s) return null;
  const prio = priorities();
  const cfg = poolConfig();
  const box = s.box;
  const projects = new Map();
  const project = (name) => {
    let p = projects.get(name);
    if (!p) {
      const tier = prio.ranks[name] ?? 'normal';
      p = { name, label: labelOf(name), tier, ranked: name in prio.ranks, weight: WEIGHTS[tier],
        cores: 0, mem: 0, procs: 0, sessions: [], jobs: [], waits: [], leftovers: [],
        pool: { held: 0, waiting: 0, share: tier === 'high' ? cfg.borrow ?? null : cfg.per_project ?? null } };
      projects.set(name, p);
    }
    return p;
  };
  const others = [];
  for (const b of s.buckets.values()) {
    if (b.kind !== 'project') {
      others.push({ kind: b.kind, name: OTHER_LABEL[b.kind] ?? b.kind, cores: round(b.cores), mem: b.mem, procs: b.procs, top: tops(b.comms) });
      continue;
    }
    const p = project(b.name);
    p.cores = round(b.cores); p.mem = b.mem; p.procs = b.procs;
    p.sessions = [...b.sessions.values()].sort((a, c) => c.cores - a.cores).map((x) => ({
      sessionId: x.sessionId, name: x.name ?? nameOf(x.sessionId), status: x.status, cwd: x.cwd,
      cores: round(x.cores), mem: x.mem, procs: x.procs, top: tops(x.comms) }));
    p.jobs = [...b.jobs.values()].sort((a, c) => (a.held?.since ?? 0) - (c.held?.since ?? 0)).map((j) => ({
      slot: j.held?.slot ?? null, pid: j.holder, cmd: j.held?.cmd ?? null, since: j.held?.since ?? null,
      sessionId: j.held?.sessionId ?? null, session: nameOf(j.held?.sessionId), place: placeName(j.held?.sessionId, placeOf(j.held?.cwd)),
      solo: !!j.held?.solo, priority: !!j.held?.priority, legacy: j.legacy,
      cores: round(j.cores), mem: j.mem, procs: j.procs, top: tops(j.comms, 2) }));
    p.leftovers = [...b.leftovers.values()].sort((a, c) => c.mem - a.mem).map((l) => ({
      sessionId: l.sessionId ?? null, orphan: !!l.orphan, unit: l.unit ?? null, since: l.since ?? null,
      cores: round(l.cores), mem: l.mem, procs: l.procs, top: tops(l.comms) }));
  }
  for (const w of box?.cpu?.waiting ?? []) {
    const p = project(w.project ?? 'unknown');
    p.waits.push({ ticket: w.ticket, pid: w.pid, since: w.since, why: w.why, priority: w.priority, solo: w.solo,
      next: w.next, sessionId: w.sessionId, session: nameOf(w.sessionId), place: placeName(w.sessionId, placeOf(w.cwd)) });
    p.pool.waiting++;
  }
  for (const h of box?.cpu?.held ?? []) project(h.project ?? 'unknown').pool.held++;
  for (const name of Object.keys(prio.ranks)) if (prio.set) project(name);

  // What came and went between samples (a build's compilers, a test's workers) shows only in the total.
  const counted = [...s.buckets.values()].reduce((a, b) => a + b.cores, 0);
  if (s.cpu.busy != null && s.cpu.busy - counted >= 0.2) {
    others.push({ kind: 'transient', name: 'Short-lived processes and the kernel', cores: round(s.cpu.busy - counted), mem: 0, procs: 0, top: [] });
  }
  const rank = (t) => TIERS.indexOf(t);
  const list = [...projects.values()].sort((a, b) => rank(a.tier) - rank(b.tier) || a.name.localeCompare(b.name));
  others.sort((a, b) => b.cores - a.cores);

  // The last hour, a point per step: each project's cores, the busiest first.
  const points = [];
  for (const h of history) {
    const t = Math.floor(h.t / step) * step;
    let pt = points[points.length - 1];
    if (!pt || pt.t !== t) { pt = { t, n: 0, busy: 0, demand: 0, mem: 0, by: {} }; points.push(pt); }
    pt.n++; pt.busy += h.busy ?? 0; pt.demand += h.demand; pt.mem += h.mem;
    for (const [k, v] of Object.entries(h.by)) pt.by[k] = (pt.by[k] ?? 0) + v;
  }
  const total = {};
  for (const pt of points) {
    for (const k of Object.keys(pt.by)) { pt.by[k] = round(pt.by[k] / pt.n); total[k] = (total[k] ?? 0) + pt.by[k]; }
    pt.busy = round(pt.busy / pt.n); pt.demand = round(pt.demand / pt.n, 1); pt.mem = Math.round(pt.mem / pt.n);
    delete pt.n;
  }
  const series = Object.keys(total).sort((a, b) => total[b] - total[a]);

  return {
    at: s.at,
    cpu: { ...s.cpu, busy: round(s.cpu.busy), gate: box?.cpu?.gate ?? null, slots: box?.cpu?.slots ?? null,
      held: box?.cpu?.held.length ?? 0, waiting: box?.cpu?.waiting.length ?? 0 },
    mem: s.mem,
    gpu: s.gpu || box?.gpu ? { ...(s.gpu ?? {}), leases: box?.gpu ? { held: box.gpu.held.length, waiting: box.gpu.waiting.length, slots: box.gpu.slots } : null } : null,
    priority: { set: prio.set, file: prio.file, updated: prio.updated, by: prio.by, broken: !!prio.broken,
      tiers: TIERS, weights: WEIGHTS, canSet: !!heavyBin() && !!box?.cpu },
    projects: list, others,
    history: { step, series, points },
  };
}

/** The worktree a job ran in - `m9-translate` - or null for a main checkout. */
function placeOf(cwd) {
  if (!cwd) return null;
  const m = /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/.exec(cwd) ?? /-wt[/\\]([^/\\]+)/.exec(cwd);
  return m ? m[1] : null;
}

/** heavy, where it is installed: BOX_HEAVY_BIN, then on PATH, then claude-core's place. */
export function heavyBin() {
  const cands = [process.env.BOX_HEAVY_BIN, ...String(process.env.PATH ?? '').split(':').map((d) => d && path.join(d, 'heavy')),
    path.join(HOME, '.claude', 'claude-core', 'bin', 'heavy')].filter(Boolean);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ } }
  return null;
}

/**
 * Set a project's rank through heavy, the one place the rule lives: it writes
 * the owner's file and gives every project's jobs their share of the CPU at
 * once. Resolves to the new ranks, or throws with heavy's own words.
 */
export function setPriority(project, tier, by = 'claude-tracker') {
  const bin = heavyBin();
  if (!bin) throw new Error('heavy is not installed here (claude-core\'s bin/heavy)');
  if (!TIERS.includes(tier)) throw new Error(`a priority is one of ${TIERS.join(', ')}`);
  if (typeof project !== 'string' || !/^[^\s/\\]{1,100}$/.test(project)) throw new Error('not a project name');
  try {
    execFileSync(bin, ['--priority', project, tier], { encoding: 'utf8', timeout: 20000, env: { ...process.env, BOX_PRIORITY_BY: by },
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error((err.stderr || err.message || 'heavy failed').toString().trim().split('\n').pop());
  }
  return priorities();
}

/** The owner's "run this next" for one waiting job, by its heavy pid. */
export function runNext(pid) {
  const bin = heavyBin();
  if (!bin) throw new Error('heavy is not installed here (claude-core\'s bin/heavy)');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('not a job');
  try {
    return execFileSync(bin, ['--run-next', String(pid)], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, BOX_PRIORITY_BY: 'claude-tracker' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new Error((err.stderr || err.message || 'heavy failed').toString().trim().split('\n').pop());
  }
}

/** For tests: forget every sample. */
export function resetMachine() {
  prev = null; latest = null; history.length = 0; fixed.clear(); projectMemo.clear(); topMemo.clear(); decodeMemo.clear();
}
