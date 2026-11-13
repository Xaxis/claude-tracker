import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR, HOME, discoverProfiles } from './paths.js';
import { gitTop, encodedProject } from './machine.js';

/**
 * Who is filling the disks, and who leaves things behind.
 *
 * Parallel sessions write scratchpads, worktrees, test runs and caches all
 * over the box, and nothing says whose they are or whether anyone still needs
 * them: on 2026-10-07 and 10-08 the root disk hit 100% and gates failed with
 * ENOSPC, and on 2026-11-13 one ended session's scratchpad alone held 56 GB,
 * Node's compile cache 40 GB and one project's test runs thirty 600 MB folders.
 *
 * A survey walks the places that fill (the temp dir, Claude's scratchpads,
 * home, its caches, every projects folder and each repo's worktrees) with du at
 * idle disk priority, in the background, a few times a day. Each folder goes to
 * the project it belongs to: a scratchpad by the session folder it is in, a
 * worktree by its repo, a temp folder by its name (my-app-release is my-app's,
 * and a prefix in temp-prefixes.json names more). What nobody still uses is a leftover: an
 * ended session's scratchpad, a worktree no session has touched for a week, a
 * project's temp folder idle three days.
 *
 * Read only: it never deletes. Where a tool cleans up safely (tmp-sweep, wt
 * prune), it says which command does.
 */

const FILE = () => path.join(DATA_DIR, 'storage.json');
const HISTORY = () => path.join(DATA_DIR, 'storage-history.json');
const DAY = 86400e3;
const EVERY = 3 * 3600e3;          // a survey every three hours
const FIRST = 90e3;                // the first a minute and a half after start
const LEFT_SCRATCH_DAYS = 3;       // tmp-sweep's rule for an ended session's scratchpad
const LEFT_WORKTREE_DAYS = 7;
const LEFT_TEMP_DAYS = 3;
const SMALL = 50 * 2 ** 20;        // below this a folder is not worth a line

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/* --- du ---------------------------------------------------------------------- */

let ionice = null;
function lowPriority() {
  if (ionice === null) {
    ionice = false;
    try { execFileSync('ionice', ['-c3', 'true'], { stdio: 'ignore', timeout: 3000 }); ionice = true; } catch { /* none */ }
  }
  return ionice ? ['ionice', '-c3', 'nice', '-n', '19'] : ['nice', '-n', '19'];
}

/**
 * Disk usage of each folder under `dirs`, `depth` levels down: [{path, bytes,
 * newest}] where newest is the latest change to anything inside (du --time).
 * At idle disk priority, so a survey never slows anyone's work.
 */
function du(dirs, depth, timeoutMs = 30 * 60e3) {
  dirs = dirs.filter(isDir);
  if (!dirs.length) return Promise.resolve([]);
  const [cmd, ...pre] = lowPriority();
  return new Promise((resolve) => {
    const out = [];
    let rest = '';
    const child = spawn(cmd, [...pre, 'du', '-x', '--block-size=1', '--time', '--time-style=+%s', `--max-depth=${depth}`, '--', ...dirs],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        const m = /^(\d+)\t(\d+)\t(.*)$/.exec(l);
        if (m) out.push({ path: m[3], bytes: Number(m[1]), newest: Number(m[2]) * 1000 });
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve(out); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/* --- whose a folder is --------------------------------------------------------- */

// Temp folders named for a project by a short prefix of its tools' own ("ma-run-1" for
// my-app): the owner's to say, in the data folder's temp-prefixes.json, {"ma": "my-app"}.
const PREFIXES = () => path.join(DATA_DIR, 'temp-prefixes.json');
function prefixes() {
  try {
    const d = JSON.parse(fs.readFileSync(PREFIXES(), 'utf8'));
    return Object.fromEntries(Object.entries(d ?? {}).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === 'string')
      .map(([k, v]) => [k, v.toLowerCase()]));
  } catch { return {}; }
}
// Shared caches: anyone's, nobody's to clean by hand.
const CACHES = /^(?:\.cache|\.npm|\.yarn|\.yarn-cache|\.pnpm-store|\.bun|\.cargo|\.rustup|\.gradle|\.m2|\.nuget|\.local\/share\/pnpm|node-compile-cache|\.node-gyp|\.electron|\.deno|go|\.android|\.rembg)$/i;

/** How Claude Code names a directory's project folder: every character but a letter or digit is a dash. */
const encode = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Names folders by their project: the projects (a name and its checkout) and
 * the rules that recognize a folder of theirs by its name.
 */
function namer(projects) {
  const aliases = prefixes();
  const byLower = new Map();
  for (const p of projects) byLower.set(p.name.toLowerCase(), p.name);
  const stems = [];
  for (const p of projects) {
    const lower = p.name.toLowerCase();
    stems.push([lower, p.name]);
    const stem = lower.split('.')[0];
    if (stem.length >= 4 && stem !== lower) stems.push([stem, p.name]);
  }
  stems.sort((a, b) => b[0].length - a[0].length);
  return (entry) => {
    const n = entry.toLowerCase().replace(/^\.+/, '');
    for (const [stem, name] of stems) {
      if (stem.length < 4 && n !== stem) continue;
      if (n === stem || (n.startsWith(stem) && /[-_.]/.test(n[stem.length]))) return name;
    }
    const alias = /^([a-z]+)[-_]/.exec(n)?.[1];
    if (alias && aliases[alias]) return byLower.get(aliases[alias]) ?? null;
    return null;
  };
}

/* --- what is still in use ------------------------------------------------------ */

/** When a session last wrote its transcript, in any profile; null when none is left. */
function transcriptAt(profiles, encoded, sessionId) {
  let at = null;
  for (const pr of profiles) {
    try {
      const t = fs.statSync(path.join(pr.dir, 'projects', encoded, `${sessionId}.jsonl`)).mtimeMs;
      if (at == null || t > at) at = t;
    } catch { /* not in this profile */ }
  }
  return at;
}

/* --- the survey ------------------------------------------------------------------ */

let running = null;
let timer = null;

/**
 * Walk the disks and write what was found to storage.json. `context()` gives
 * {sessions: [{sessionId, parkedJobId, cwd, name}], projectOf(dir)} at the moment
 * the survey starts. One survey at a time; a second ask joins the first.
 */
export function survey(context) {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    try {
      const result = await walk(context(), t0);
      result.took = Date.now() - t0;
      writeJson(FILE(), result);
      remember(result);
      return result;
    } finally {
      running = null;
    }
  })();
  return running;
}

export const surveying = () => !!running;

/** Survey in the background: soon after start, then every few hours. */
export function startSurveys(context) {
  if (timer || process.platform !== 'linux') return;
  const go = () => survey(context).catch((err) => console.error('storage survey:', err.message));
  const last = readJson(FILE());
  const wait = last?.at ? Math.max(FIRST, last.at + EVERY - Date.now()) : FIRST;
  timer = setTimeout(function again() { go().finally(() => { timer = setTimeout(again, EVERY); timer.unref?.(); }); }, wait);
  timer.unref?.();
}

export function stopSurveys() { clearTimeout(timer); timer = null; }

function writeJson(f, v) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** The projects folders: where the repos of every session the tracker has seen live. */
function projectRoots(sessions, extra = []) {
  const roots = new Map();
  const consider = (dir) => {
    if (!dir) return;
    const top = repoTop(dir);
    if (!top) return;
    const parent = real(path.dirname(top));
    if (parent === real(HOME) || parent === '/' || !isDir(parent)) return;
    roots.set(parent, (roots.get(parent) ?? 0) + 1);
  };
  for (const s of sessions) consider(s.cwd);
  for (const d of extra) consider(d);
  return [...roots.keys()];
}

/** The main checkout a directory belongs to (a worktree counts as its repo), or null. */
const repoTop = gitTop;

async function walk({ sessions = [], recentDirs = [] }, now) {
  const uid = process.getuid?.() ?? 0;
  const tmp = real(os.tmpdir() === '/tmp' || !isDir('/tmp') ? os.tmpdir() : '/tmp');
  const scratch = path.join(tmp, `claude-${uid}`);
  const home = real(HOME);
  const roots = projectRoots(sessions, recentDirs).filter((r) => !r.startsWith(tmp));
  const profiles = discoverProfiles();

  // The repos in each projects folder, and every worktree under them.
  const projects = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const dir = path.join(root, n);
      if (!n.startsWith('.') && (exists(path.join(dir, '.git')) || exists(path.join(dir, '.claude')))) projects.push({ name: n, dir });
    }
  }
  const nameOf = namer(projects);
  const encoded = new Map(projects.map((p) => [encode(p.dir), p.name]));
  encoded.set(encode(home), path.basename(home));
  for (const r of roots) encoded.set(encode(r), `${path.basename(r)} folder`);   // sessions started in the folder itself
  const worktreeDirs = projects.map((p) => path.join(p.dir, '.claude', 'worktrees')).filter(isDir);

  // Live work: a running session's folder and its scratchpad are in use.
  const live = new Set(sessions.flatMap((s) => [s.sessionId, s.parkedJobId]).filter(Boolean));
  const liveDirs = sessions.map((s) => s.cwd).filter(Boolean);

  // du, one place at a time: the second look at a tree finds its inodes cached.
  const [tmpTop, scratchAll, homeTop, transcripts, rootsTop, worktrees] = [
    await du([tmp], 1), await du([scratch], 2), await du([home], 2),
    await du(profiles.map((p) => path.join(p.dir, 'projects')), 1),
    await du(roots, 2), await du(worktreeDirs, 1),
  ];

  const owners = new Map();
  const owner = (kind, name) => {
    const key = `${kind}:${name}`;
    let o = owners.get(key);
    if (!o) { o = { key, kind, name, bytes: 0, items: [] }; owners.set(key, o); }
    return o;
  };
  const add = (o, item) => { o.bytes += item.bytes; o.items.push(item); };
  // A cache named for a project (~/.cache/my-app-bench) is that project's; the rest are everyone's.
  const cacheOwner = (p) => { const proj = nameOf(path.basename(p)); return proj ? owner('project', proj) : owner('caches', 'Shared caches'); };
  const idleDays = (newest) => (newest ? Math.max(0, (now - newest) / DAY) : null);
  const depthOf = (p, base) => (p === base ? 0 : path.relative(base, p).split(path.sep).length);

  // Claude's scratchpads, by session.
  const projectOfEncoded = (enc) => {
    if (encoded.has(enc)) return encoded.get(enc);
    const wt = enc.split('--claude-worktrees-')[0];
    if (encoded.has(wt)) return encoded.get(wt);
    const p = encodedProject(enc);
    return p ? nameOf(p) ?? p : null;
  };
  for (const e of scratchAll) {
    const d = depthOf(e.path, scratch);
    if (d !== 2) continue;
    const [enc, sid] = path.relative(scratch, e.path).split(path.sep);
    const isSession = /^[0-9a-f-]{36}$/.test(sid);
    const name = (enc.startsWith('-') ? projectOfEncoded(enc) : nameOf(enc)) ?? enc;
    const o = owner('project', name);
    let status = 'temp', at = null;
    if (isSession) {
      at = transcriptAt(profiles, enc, sid);
      status = live.has(sid) ? 'live' : at && now - at < LEFT_SCRATCH_DAYS * DAY ? 'recent' : 'ended';
    }
    add(o, { kind: 'scratchpad', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest), sessionId: isSession ? sid : null,
      status, transcriptAt: at,
      left: isSession ? status === 'ended' : idleDays(e.newest) >= LEFT_TEMP_DAYS });
  }

  // The temp dir's own entries, by name. Small ones add up, so each owner's are summed,
  // idle and in use apart: on 2026-11-13 two projects' tests had left 4,586 folders of a
  // few MB each, 664 MB that no single line was big enough to show.
  const smalls = new Map();
  for (const e of tmpTop) {
    if (depthOf(e.path, tmp) !== 1 || e.path === scratch) continue;
    const base = path.basename(e.path);
    if (CACHES.test(base)) {
      if (e.bytes >= SMALL) add(cacheOwner(e.path), { kind: 'cache', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) });
      continue;
    }
    const proj = nameOf(base);
    const idle = idleDays(e.newest);
    const left = idle >= LEFT_TEMP_DAYS;
    if (e.bytes >= SMALL) {
      add(proj ? owner('project', proj) : owner('temp', 'Unclaimed temp'),
        { kind: 'temp', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idle, left });
      continue;
    }
    const key = `${proj ?? ''}\0${left}`;
    const g = smalls.get(key) ?? { proj, left, bytes: 0, count: 0, newest: 0, stems: new Map() };
    g.bytes += e.bytes; g.count++; g.newest = Math.max(g.newest, e.newest ?? 0);
    const stem = `${/^[^-_.]+[-_.]?/.exec(base)?.[0] ?? base}*`;
    g.stems.set(stem, (g.stems.get(stem) ?? 0) + e.bytes);
    smalls.set(key, g);
  }
  for (const g of smalls.values()) {
    if (g.bytes < SMALL) continue;
    const stems = [...g.stems].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const named = `${stems.slice(0, 3).join(', ')}${stems.length > 3 ? ', …' : ''}`;
    add(g.proj ? owner('project', g.proj) : owner('temp', 'Unclaimed temp'),
      { kind: 'temp', path: `${path.join(tmp, named)} (${g.count.toLocaleString('en-US')} folders)`, count: g.count,
        bytes: g.bytes, newest: g.newest || null, idleDays: idleDays(g.newest || null), left: g.left });
  }

  // Each repo: its checkout, by its biggest parts; its worktrees, each.
  const wtSize = new Map();
  for (const e of worktrees) {
    const parent = path.dirname(e.path);
    if (path.basename(parent) !== 'worktrees') { wtSize.set(e.path, e.bytes); continue; } // the worktrees folder itself
    const repoDir = path.dirname(path.dirname(parent));
    const proj = projects.find((p) => p.dir === repoDir)?.name ?? path.basename(repoDir);
    const inUse = liveDirs.some((d) => d === e.path || d.startsWith(e.path + path.sep));
    const idle = idleDays(e.newest);
    add(owner('project', proj), { kind: 'worktree', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idle, live: inUse,
      left: !inUse && idle >= LEFT_WORKTREE_DAYS, repo: repoDir });
  }
  for (const root of roots) {
    const top = rootsTop.filter((e) => path.dirname(e.path) === root);
    for (const e of top) {
      const base = path.basename(e.path);
      const proj = projects.find((p) => p.dir === e.path)?.name;
      if (CACHES.test(base)) { add(owner('caches', 'Shared caches'), { kind: 'cache', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) }); continue; }
      if (!proj) {
        if (e.bytes < SMALL) continue;
        const named = nameOf(base);
        add(named ? owner('project', named) : owner('home', 'Other folders'),
          { kind: 'folder', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) });
        continue;
      }
      const wt = wtSize.get(path.join(e.path, '.claude', 'worktrees')) ?? 0;
      const parts = rootsTop.filter((c) => path.dirname(c.path) === e.path)
        .map((c) => ({ name: path.basename(c.path), bytes: c.path === path.join(e.path, '.claude') ? c.bytes - wt : c.bytes }))
        .filter((c) => c.bytes >= SMALL).sort((a, b) => b.bytes - a.bytes).slice(0, 6);
      add(owner('project', proj), { kind: 'repo', path: e.path, bytes: e.bytes - wt, newest: e.newest, parts });
    }
  }

  // Home: its caches, Claude's own folder, the rest by name.
  const claudeDirs = new Set(profiles.map((p) => real(p.dir)));
  for (const e of homeTop) {
    const d = depthOf(e.path, home);
    if (d === 0) continue;
    const rel = path.relative(home, e.path);
    const first = rel.split(path.sep)[0];
    if (roots.some((r) => e.path === r || e.path.startsWith(r + path.sep))) continue;     // a projects folder in home: done above
    if (d === 1 && (first === '.cache' || claudeDirs.has(e.path))) continue;              // split below
    if (d === 2 && first === '.cache') {
      if (e.bytes >= SMALL) add(cacheOwner(e.path), { kind: 'cache', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) });
      continue;
    }
    if (d === 2 && claudeDirs.has(path.dirname(e.path))) {
      if (path.basename(e.path) === 'projects') continue;                                 // transcripts, by project below
      if (e.bytes >= SMALL) add(owner('claude', 'Claude Code'), { kind: 'claude', path: e.path, bytes: e.bytes, newest: e.newest });
      continue;
    }
    if (d !== 1 || e.bytes < SMALL) continue;
    if (CACHES.test(first) || rel === '.local') {
      add(owner('caches', 'Shared caches'), { kind: 'cache', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) });
      continue;
    }
    const proj = nameOf(first);
    add(proj ? owner('project', proj) : owner('home', 'Other folders'),
      { kind: 'folder', path: e.path, bytes: e.bytes, newest: e.newest, idleDays: idleDays(e.newest) });
  }
  for (const e of transcripts) {
    if (path.basename(path.dirname(e.path)) !== 'projects') continue;
    const proj = projectOfEncoded(path.basename(e.path));
    if (e.bytes < SMALL) continue;
    add(proj ? owner('project', proj) : owner('claude', 'Claude Code'),
      { kind: 'transcripts', path: e.path, bytes: e.bytes, newest: e.newest });
  }

  // The disks themselves, and what on each the survey did not reach.
  const disks = new Map();
  const mounts = readMounts();
  const counted = new Map();
  for (const o of owners.values()) for (const it of o.items) {
    const m = mountOf(mounts, it.path);
    counted.set(m, (counted.get(m) ?? 0) + it.bytes);
  }
  for (const p of [tmp, home, ...roots]) {
    const m = mountOf(mounts, p);
    if (disks.has(m)) continue;
    try {
      const st = fs.statfsSync(m);
      const size = st.blocks * st.bsize, avail = st.bavail * st.bsize, used = size - st.bfree * st.bsize;
      disks.set(m, { mount: m, size, used, avail, counted: counted.get(m) ?? 0 });
    } catch { /* gone */ }
  }

  const list = [...owners.values()].map((o) => {
    o.items.sort((a, b) => b.bytes - a.bytes);
    o.left = o.items.filter((i) => i.left).reduce((a, i) => a + i.bytes, 0);
    return o;
  }).sort((a, b) => b.bytes - a.bytes);
  return { at: now, version: 1, disks: [...disks.values()], owners: list, roots, tmp };
}

/** Mount points, longest first. */
function readMounts() {
  const out = [];
  try {
    for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const f = line.split(' ');
      if (f[4]) out.push(f[4].replace(/\\040/g, ' '));
    }
  } catch { out.push('/'); }
  return out.sort((a, b) => b.length - a.length);
}
const mountOf = (mounts, p) => mounts.find((m) => m === '/' || p === m || p.startsWith(m + '/')) ?? '/';

/* --- history ------------------------------------------------------------------------ */

/** Keep each owner's total once a survey, the last 30 days of them, to see who grows. */
function remember(r) {
  const h = readJson(HISTORY()) ?? [];
  h.push({ at: r.at, owners: Object.fromEntries(r.owners.map((o) => [o.key, o.bytes])),
    disks: Object.fromEntries(r.disks.map((d) => [d.mount, d.used])) });
  const keep = h.filter((x) => x.at >= r.at - 30 * DAY);
  writeJson(HISTORY(), keep);
}

/* --- the view ------------------------------------------------------------------------ */

// Caches nothing ever prunes, and how to empty one: each rebuilds what it needs on its next use.
const GROWS_ONLY_FLAG = 5 * 2 ** 30;
const GROWS_ONLY = [
  { re: /\/node-compile-cache$/, what: 'Node\'s compile cache', why: 'a file for every script node has compiled, and nothing prunes it', cmd: (p) => `rm -rf ${p}` },
  { re: /\/\.cache\/uv$/, what: 'uv\'s cache', why: 'every package version uv fetched', cmd: () => 'uv cache prune' },
  { re: /\/\.npm$/, what: 'npm\'s cache', why: 'every package version npm fetched', cmd: () => 'npm cache clean --force' },
];

const ITEMS = 8;

/**
 * The last survey for the dashboards: the disks, every owner largest first
 * with its biggest folders, what each left behind, how each grew in about a
 * day, and the commands that clean up safely. Null before the first survey.
 */
export function storageView(now = Date.now()) {
  const r = readJson(FILE());
  if (!r) return process.platform === 'linux' ? { at: null, surveying: surveying() } : null;
  const h = readJson(HISTORY()) ?? [];
  const dayAgo = [...h].reverse().find((x) => x.at <= r.at - 20 * 3600e3) ?? null;
  const owners = r.owners.map((o) => ({
    key: o.key, kind: o.kind, name: o.name, bytes: o.bytes, left: o.left,
    grew: dayAgo && dayAgo.owners[o.key] != null ? o.bytes - dayAgo.owners[o.key] : null,
    counts: {
      worktrees: o.items.filter((i) => i.kind === 'worktree').length,
      worktreesLeft: o.items.filter((i) => i.kind === 'worktree' && i.left).length,
      scratchpads: o.items.filter((i) => i.kind === 'scratchpad').length,
      scratchpadsLeft: o.items.filter((i) => i.kind === 'scratchpad' && i.left).length,
      tempLeft: o.items.filter((i) => i.kind === 'temp' && i.left).reduce((a, i) => a + (i.count ?? 1), 0),
    },
    items: o.items.slice(0, ITEMS).map(slim),
    leftovers: o.items.filter((i) => i.left).slice(0, ITEMS).map(slim),
  }));
  const left = owners.filter((o) => o.left >= SMALL / 4).sort((a, b) => b.left - a.left);
  const commands = [];
  const leftScratch = owners.reduce((a, o) => a + o.counts.scratchpadsLeft, 0);
  if (leftScratch || owners.some((o) => o.leftovers.some((i) => i.kind === 'temp'))) {
    commands.push({ cmd: '~/.claude/claude-core/bin/tmp-sweep', label: 'See what tmp-sweep would delete: ended sessions\' scratchpads and known leaks, idle and unused (add --yes to delete)' });
  }
  // Caches that only grow: nothing prunes them, and each rebuilds what it needs on the next run.
  for (const o of r.owners) for (const i of o.items) {
    const grow = i.kind === 'cache' && GROWS_ONLY.find((g) => g.re.test(i.path));
    if (grow && i.bytes >= GROWS_ONLY_FLAG) commands.push({ cmd: grow.cmd(i.path), label: `${grow.what}: ${Math.round(i.bytes / 2 ** 30)} GB, ${grow.why}` });
  }
  for (const o of owners) {
    if (!o.counts.worktreesLeft) continue;
    const repo = r.owners.find((x) => x.key === o.key)?.items.find((i) => i.kind === 'worktree')?.repo;
    if (repo) commands.push({ cmd: `cd ${repo} && ~/.claude/claude-core/bin/wt prune`, label: `${o.name}: list its stale worktrees (wt prune --yes removes them)` });
  }
  return {
    at: r.at, took: r.took ?? null, surveying: surveying(), next: r.at + EVERY,
    disks: r.disks.map((d) => ({ ...d, other: Math.max(0, d.used - d.counted),
      grew: dayAgo?.disks?.[d.mount] != null ? d.used - dayAgo.disks[d.mount] : null })),
    owners, left: left.map((o) => ({ key: o.key, name: o.name, bytes: o.left })),
    leftTotal: left.reduce((a, o) => a + o.left, 0),
    commands: commands.slice(0, 10),
  };
}

function slim(i) {
  const out = { kind: i.kind, path: i.path.replace(HOME, '~'), bytes: i.bytes, idleDays: i.idleDays != null ? Math.round(i.idleDays * 10) / 10 : null };
  if (i.sessionId) out.sessionId = i.sessionId;
  if (i.status) out.status = i.status;
  if (i.live) out.live = true;
  if (i.left) out.left = true;
  if (i.parts) out.parts = i.parts;
  if (i.count) out.count = i.count;
  return out;
}
