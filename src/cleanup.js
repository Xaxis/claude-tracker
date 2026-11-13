import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { storageView, resurvey, lowPriority, toolEnv } from './storage.js';

/**
 * The disk survey's cleanups, run from the dashboard one at a time.
 *
 * Only a cleanup the survey recommends right now can run, and only by its id:
 * the tracker never runs a command it was sent. Each shows what it would do
 * first - the tool's own dry run (tmp-sweep, wt prune) or the folder and its size
 * - and runs only when the owner then says so. It runs at idle priority, how much
 * it freed is read off the disks before and after, and the disks are surveyed
 * again so the list catches up.
 */

const KEEP = 3600e3;          // a finished cleanup's result stays an hour
const PREVIEW_MS = 120e3;
const RUN_MS = 60 * 60e3;
const TAIL = 16 * 1024;

const jobs = new Map();       // id -> { id, what, state: running|done|failed, startedAt, endedAt, freed, output, error }
let changed = () => {};
let rev = 0;

/** Called whenever a cleanup starts, finishes, or the survey after it lands. */
export function onCleanupChange(fn) { changed = fn; }

const bump = () => { rev++; try { changed(); } catch { /* a listener's trouble is not the cleanup's */ } };

/** Cleanups started in the last hour, newest first, and a number that changes whenever any of them does. */
export function cleanupState(now = Date.now()) {
  for (const [id, j] of jobs) if (j.endedAt && now - j.endedAt > KEEP) jobs.delete(id);
  return { rev, jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt) };
}

function find(id) {
  const c = storageView()?.commands?.find((x) => x.id === id);
  if (!c?.run) throw new Error('that cleanup is not recommended any more: the disks were measured again since');
  return c;
}

/** Run argv at idle priority; resolves with its output (the tail, if long) and exit code. */
function exec(argv, cwd, ms) {
  const [cmd, ...pre] = lowPriority();
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, [...pre, ...argv], { cwd: cwd ?? undefined, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (b) => { out += b; if (out.length > TAIL * 2) out = out.slice(-TAIL); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), ms);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: `${out}${err.message}` }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: signal ? -1 : code, out: out.slice(-TAIL) + (signal ? `\n(stopped: ${signal})` : '') }); });
  });
}

/** Free space on the disks the survey knows, by mount. */
function freeSpace() {
  const out = new Map();
  for (const d of storageView()?.disks ?? []) {
    try { const st = fs.statfsSync(d.mount); out.set(d.mount, st.bavail * st.bsize); } catch { /* gone */ }
  }
  return out;
}

/** What a cleanup would do: the tool's own dry run, or what it deletes. */
export async function previewCleanup(id) {
  const c = find(id);
  if (c.preview?.argv) {
    const r = await exec(c.preview.argv, c.cwd, PREVIEW_MS);
    return { id, what: c.what, cmd: c.cmd, dryRun: r.out.trim() || '(it printed nothing)', ok: r.code === 0 };
  }
  return { id, what: c.what, cmd: c.cmd, dryRun: null, ok: true };
}

/** Start a cleanup; resolves once it has started. Its progress shows in cleanupState(). */
export function runCleanup(id) {
  const c = find(id);
  const was = jobs.get(id);
  if (was?.state === 'running') throw new Error('it is running already');
  const job = { id, what: c.what, cmd: c.cmd, state: 'running', startedAt: Date.now(), endedAt: null, freed: null, output: '', error: null };
  jobs.set(id, job);
  bump();
  (async () => {
    const before = freeSpace();
    let r;
    if (c.run.remove) {
      try { fs.rmSync(c.run.remove, { recursive: true, force: true }); r = { code: 0, out: `deleted ${c.run.remove}` }; } catch (err) { r = { code: -1, out: err.message }; }
    } else {
      r = await exec(c.run.argv, c.cwd, RUN_MS);
    }
    const after = freeSpace();
    let freed = 0;
    for (const [m, b] of before) if (after.has(m)) freed += after.get(m) - b;
    Object.assign(job, { state: r.code === 0 ? 'done' : 'failed', endedAt: Date.now(), freed: Math.max(0, freed), output: r.out.trim(),
      error: r.code === 0 ? null : `it stopped with code ${r.code}` });
    bump();
    try { await resurvey(); } catch (err) { console.error('storage survey:', err.message); }
    job.remeasured = Date.now();
    bump();
  })();
  return { id, started: true };
}

/** For tests. */
export function resetCleanups() { jobs.clear(); rev = 0; }
