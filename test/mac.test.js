import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A Mac of our own making: what ps, lsof, vm_stat, sysctl, ioreg, mount and taskpolicy
// print there, replayed by stand-ins on PATH, so the code that reads them runs here.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tracker-mac-')));
const BIN = path.join(TMP, 'bin'), OUT = path.join(TMP, 'out'), HOME = path.join(TMP, 'Users', 'me');
const SHARED = path.join(TMP, 'private', 'tmp'), MINE = path.join(TMP, 'private', 'var', 'folders', 'xy', 'T');
for (const d of [BIN, OUT, HOME, SHARED, MINE]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, {
  CLAUDE_TRACKER_PLATFORM: 'darwin', CLAUDE_TRACKER_DIR: path.join(TMP, 'data'), HOME, TMPDIR: MINE,
  CLAUDE_TRACKER_TMP: SHARED, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
  BOX_HEAVY_DIR: path.join(TMP, 'box'), BOX_GPU_DIR: path.join(TMP, 'gpu'), BOX_GPU_STATE: path.join(TMP, 'gpu-state'),
  BOX_PRIORITY_FILE: path.join(TMP, 'priority.json'), FAKE_OUT: OUT, CLAUDE_TRACKER_PROC: path.join(TMP, 'no-proc'), PATH: `${BIN}:${process.env.PATH}`,
});
fs.mkdirSync(process.env.CLAUDE_TRACKER_DIR, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const tool = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
tool('ps', 'case "$*" in *args=*) cat "$FAKE_OUT/ps-args" ;; *) cat "$FAKE_OUT/ps" ;; esac');
tool('lsof', 'printf "p%s\\nfcwd\\nn%s\\n" "$3" "$(cat "$FAKE_OUT/cwd-$3")"');   // lsof -a -p PID -d cwd -Fn
tool('vm_stat', 'cat "$FAKE_OUT/vm_stat"');
tool('sysctl', 'cat "$FAKE_OUT/swap"');
tool('ioreg', 'cat "$FAKE_OUT/ioreg"');
tool('mount', 'cat "$FAKE_OUT/mount"');
tool('taskpolicy', 'echo "$*" >> "$FAKE_OUT/taskpolicy.log"; shift; exec "$@"');
tool('gdu', 'exit 1');   // no Homebrew coreutils: BSD du's flags, which GNU du takes too

const machine = await import('../src/machine.js');
const { survey, storageView } = await import('../src/storage.js');

const me = process.getuid();
// heavy's slot holder must be alive (kill -0, as on a Mac): this test's own process stands in for it.
const HEAVY = process.pid;
const repo = (name) => { const d = path.join(TMP, 'Projects', name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const START = 'Thu Nov 13 07:55:17 2026';

test('on a Mac the sampler reads ps, vm_stat, sysctl and ioreg, and says whose each process is', () => {
  const alpha = repo('alpha');
  fs.writeFileSync(path.join(OUT, 'cwd-400'), alpha);
  const world = (k) => {
    // pid ppid uid rss(KB) cputime lstart comm: what `ps -o pid=,ppid=,uid=,rss=,time=,lstart=,comm=` prints.
    const row = (pid, ppid, uid, rss, time, comm) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(uid).padStart(5)} ${String(rss).padStart(8)} ${time.padStart(11)} ${START} ${comm}`;
    fs.writeFileSync(path.join(OUT, 'ps'), [
      row(1, 0, 0, 20000, `1-00:00:0${k}.00`, '/sbin/launchd'),
      row(90, 1, 88, 300000, '0:00.00', '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer'),
      row(200, 1, me, 800000, `1:0${k}.00`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      // A session the tracker knows, and the test it runs.
      row(300, 1, me, 400000, `0:0${k}.00`, `${HOME}/.local/share/claude/versions/2.1.0`),
      row(310, 300, me, 200000, `0:${String(2 + k * 2).padStart(2, '0')}.00`, '/opt/homebrew/bin/node'),
      // A Claude process the tracker has not heard of: its folder comes from lsof.
      row(400, 1, me, 100000, '0:00.50', `${HOME}/.local/share/claude/versions/2.1.0`),
      // A heavy job: heavy's own process holds the slot, and what it runs is the job.
      row(HEAVY, 300, me, 30000, '0:00.10', '/usr/bin/python3'),
      row(510, HEAVY, me, 2000000, `0:${String(10 + k * 6).padStart(2, '0')}.00`, '/usr/local/bin/cargo'),
      row(700, 1, me, 9000, '0:00.00', '/usr/libexec/trustd'),
      row(800, 1, me, 9000, '0:00.00', '/Applications/Notes.app/Contents/MacOS/Notes'),
    ].join('\n') + '\n');
  };
  fs.writeFileSync(path.join(OUT, 'ps-args'), [
    '  300 claude --resume', '  310 node /x/node_modules/.bin/vitest run', '  400 claude setup-token',
    `  ${HEAVY} /usr/bin/python3 /x/bin/heavy cargo build`, '  510 cargo build --release',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'vm_stat'), 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\n'
    + 'Pages free:                               1000.\nPages active:                            9000.\nPages inactive:                           2000.\n'
    + 'Pages speculative:                         500.\nPages purgeable:                           500.\n');
  fs.writeFileSync(path.join(OUT, 'swap'), 'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n');
  fs.writeFileSync(path.join(OUT, 'ioreg'), '+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X>\n  {\n'
    + '    "PerformanceStatistics" = {"In use system memory"=734003200,"Device Utilization %"=37,"Renderer Utilization %"=30}\n  }\n');
  const box = process.env.BOX_HEAVY_DIR;
  fs.mkdirSync(path.join(box, 'slot.0'), { recursive: true });
  fs.writeFileSync(path.join(box, 'slot.0', 'info.json'), JSON.stringify({ pid: HEAVY, project: 'beta', cmd: 'cargo build', since: Math.floor(Date.now() / 1000) - 60 }));

  const sessions = [{ sessionId: 'running-session', pid: 300, cwd: alpha, name: 'alpha-work', status: 'busy' }];
  machine.resetMachine();
  const t0 = Date.now();
  world(1);
  assert.ok(machine.sample(sessions, t0), 'a Mac can be sampled');
  world(4);                       // three seconds later
  const s = machine.sample(sessions, t0 + 3000);
  const v = machine.machineView({ nameOf: () => null });

  const byName = Object.fromEntries(v.projects.map((p) => [p.name, p]));
  const a = byName.alpha;
  const run = a.sessions.find((x) => x.sessionId === 'running-session');
  assert.ok(Math.abs(run.cores - 3) < 0.01, `the session's own CPU and its test's, from ps's times: ${run.cores}`);
  assert.equal(run.top[0].comm, 'vitest', 'node named by the script it runs');
  assert.equal(a.sessions.find((x) => x.sessionId === 'pid:400')?.name, 'claude setup-token',
    'a Claude the tracker does not know is still a session, in the folder lsof gives');

  const b = byName.beta;
  assert.equal(b?.jobs.length, 1, 'heavy\'s process and what it runs are one job, its project\'s');
  assert.ok(Math.abs(b.jobs[0].cores - 6) < 0.01, `a job's CPU, its children's included: ${b.jobs[0].cores}`);
  assert.equal(b.jobs[0].mem, (30000 + 2000000) * 1024);
  assert.ok(!a.sessions.some((x) => x.top.some((t) => t.comm === 'cargo')), 'a job run from a session is not the session\'s');

  const other = Object.fromEntries(v.others.map((o) => [o.kind, o]));
  assert.ok(Math.abs(other.browser.cores - 1) < 0.01, 'Chrome is the browser');
  assert.ok(other.desktop.top.some((t) => t.comm === 'WindowServer'));
  assert.ok(Math.abs(other.system.cores - 1) < 0.01 && other.system.top.some((t) => t.comm === 'trustd'),
    'launchd (a day of CPU, d-hh:mm:ss) and what /usr/libexec runs are the system');
  assert.ok(other.other.top.some((t) => t.comm === 'Notes'), 'an app is nobody\'s');

  assert.equal(s.mem.available, 4000 * 16384, 'free, inactive, speculative and purgeable pages are what apps can still have');
  assert.equal(s.mem.swapUsed, 1024.5 * 2 ** 20);
  assert.equal(s.mem.swapTotal, 2048 * 2 ** 20);
  assert.deepEqual(s.gpu, { busy: 37, vramUsed: 734003200, vramTotal: null }, 'Apple\'s GPU shares memory: no total of its own');
  assert.equal(s.cpu.demand, os.loadavg()[0]);
  assert.equal(v.cpu.cores, os.cpus().length);
});

test('on a Mac the survey uses BSD du at background priority, leaves guarded folders alone, and reads APFS mounts', { timeout: 60_000 }, async () => {
  const big = (p, mtime) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync('fallocate', ['-l', String(60 * 2 ** 20), p]);
    if (mtime) for (const x of [p, path.dirname(p)]) fs.utimesSync(x, mtime, mtime);
  };
  const alpha = repo('alpha');
  const old = new Date(Date.now() - 5 * 86400e3);
  big(path.join(SHARED, 'alpha-run-1', 'out.bin'), old);                    // a project's test run, idle five days
  big(path.join(MINE, 'node-compile-cache', 'v22', 'c.bin'));               // Node's cache, in the per-user temp dir
  big(path.join(HOME, 'Documents', 'taxes.pdf'));                           // macOS asks before a program opens it
  big(path.join(HOME, 'Library', 'Caches', 'com.example.app', 'blob'));
  big(path.join(HOME, 'tools', 'model.bin'));
  fs.writeFileSync(path.join(OUT, 'mount'), '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n'
    + '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n'
    + `/dev/disk9s1 on ${TMP} (apfs, local, nodev, nosuid, journaled, noowners)\n`);

  const r = await survey(() => ({ sessions: [{ sessionId: 'running-session', cwd: alpha }], recentDirs: [] }));
  const items = r.owners.flatMap((o) => o.items.map((i) => ({ ...i, owner: o.name })));
  const at = (p) => items.find((i) => i.path === p);

  const run = at(path.join(SHARED, 'alpha-run-1'));
  assert.equal(run?.owner, 'alpha', 'a temp folder named for a project is the project\'s');
  assert.ok(run.bytes >= 60 * 2 ** 20, 'sized by du -k');
  assert.ok(Math.abs(run.idleDays - 5) < 0.1 && run.left, `idle since its newest change, so left behind: ${run.idleDays}`);
  assert.equal(at(path.join(MINE, 'node-compile-cache'))?.owner, 'Shared caches', 'the per-user temp dir is surveyed too');
  assert.equal(at(path.join(HOME, 'Library', 'Caches'))?.owner, 'Shared caches', '~/Library\'s caches are caches');
  assert.equal(at(path.join(HOME, 'tools'))?.owner, 'Other folders');
  assert.ok(!items.some((i) => i.path.startsWith(path.join(HOME, 'Documents'))), 'Documents is never opened');
  assert.deepEqual(r.disks.map((d) => d.mount), [TMP], 'each folder is on the mount `mount` names for it');
  assert.ok(r.disks[0].size > 0 && r.disks[0].counted >= 4 * 60 * 2 ** 20);
  assert.match(fs.readFileSync(path.join(OUT, 'taskpolicy.log'), 'utf8'), /^-b nice -n 19 du -x -k -d 1 /m, 'du runs at background priority');
  assert.ok(storageView().owners.length > 0, 'the dashboard shows it');
});
