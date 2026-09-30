import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, ensureDataDir } from './paths.js';
import {
  machine, TABLES, tableEnds, exportBatch, importBatch, welcome, saveState, listPeers, peerStatus,
} from './replica.js';

/**
 * Syncing with trackers on other machines.
 *
 * Two trackers talk over one ssh connection, opened by whichever machine can
 * reach the other: `ssh <host> claude-tracker sync serve` starts a relay there
 * that hands the connection to the tracker already running on that machine. So
 * each index is only ever written by the one process that owns it, nothing new
 * listens on the network, and ssh does the authenticating. Both directions
 * share the connection: a laptop that can reach a dev box, where the dev box
 * cannot reach the laptop, still gets everything the dev box has.
 *
 * The protocol is JSON, one message per line, the same from either end:
 *
 *   hello  who I am, my epoch, and where each of my tables ends
 *   want   where to resume sending me each of your tables
 *   rows   a batch of one table, and how far into it that reaches
 *   state  what is running here, and who is signed into each profile
 *   ping   still here
 *   error  why I am hanging up
 */
export const PROTOCOL = 1;
const POLL_MS = 2_000;
const PING_MS = 15_000;
const IDLE_MS = 60_000;

/* --- the connection ------------------------------------------------------- */

/**
 * One connection to another tracker, over any pair of streams.
 *
 * Imports and exports go through `serial`, the tracker's write queue, so they
 * land between refreshes rather than inside one. `admit(peer, link)` returns a
 * reason to refuse the machine, if there is one. `onRows(since)` hears that
 * rows arrived, and the earliest time they could change attribution from.
 * `localState()` says what is running here, for the other side's dashboards.
 */
export function openLink({ input, output, serial, admit = () => null, onRows = () => {}, localState = null, probe = false }) {
  const me = machine();
  const link = { peer: null, closed: false, error: null, heardAt: Date.now() };
  let wants = null;            // how far the peer has asked for, per table; advanced as rows go
  let sentAt = 0, state = '', stateAt = 0;
  let queued = 0, inbox = Promise.resolve();
  let pumping = false, again = false;
  let settleHello, settleDone;
  link.hello = new Promise((r) => { settleHello = r; });
  link.done = new Promise((r) => { settleDone = r; });

  const write = (msg) => new Promise((resolve) => {
    if (link.closed) return resolve(false);
    sentAt = Date.now();
    let flowing;
    try { flowing = output.write(`${JSON.stringify(msg)}\n`); } catch { return resolve(false); }
    if (flowing) return resolve(true);
    const go = () => { output.off('drain', go); output.off('close', go); resolve(!link.closed); };
    output.on('drain', go);
    output.on('close', go);
  });

  const close = (error = null) => {
    if (link.closed) return;
    link.closed = true;
    link.error ??= error;
    clearInterval(timer);
    rl.close();
    try { output.end(); } catch { /* already gone */ }
    settleHello(null);
    settleDone(link.error);
  };
  const fail = (message) => {
    link.error ??= message;
    try { output.write(`${JSON.stringify({ t: 'error', message })}\n`); } catch { /* already gone */ }
    close(message);
  };
  link.close = close;

  async function onHello(msg) {
    if (link.peer) return;
    if (msg.v !== PROTOCOL) {
      return fail(`the other side speaks sync protocol ${msg.v}, this one ${PROTOCOL}: update claude-tracker on both machines`);
    }
    if (typeof msg.id !== 'string' || !/^[0-9a-f]{6,32}$/.test(msg.id)) return fail('malformed hello');
    if (msg.id === me.id) return fail('both ends are the same index');
    const name = String(msg.name ?? msg.id).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 64) || msg.id;
    link.peer = { id: msg.id, name, epoch: String(msg.epoch ?? '').slice(0, 64) };
    settleHello(link.peer);
    // A probe only asks who is there.
    if (probe || msg.probe) return close();
    const refusal = admit(link.peer, link);
    if (refusal) return fail(refusal);
    const cursors = await serial(() => welcome({ ...link.peer, ends: msg.ends }));
    await write({ t: 'want', cursors });
  }

  async function onWant(msg) {
    if (!link.peer) return fail('asked for rows before saying hello');
    wants = {};
    for (const t of Object.keys(TABLES)) {
      const c = msg.cursors?.[t];
      wants[t] = Number.isSafeInteger(c) && c >= 0 ? c : 0;
    }
    pump();
    sendState(true);
  }

  async function handle(msg) {
    switch (msg.t) {
      case 'hello': return onHello(msg);
      case 'want': return onWant(msg);
      case 'rows': {
        if (!link.peer) return fail('sent rows before saying hello');
        const r = await serial(() => importBatch(link.peer.id, msg.tbl, msg.cols, msg.rows, msg.upTo));
        if (r.stored) onRows(r.since);
        return;
      }
      case 'state':
        if (link.peer) await serial(() => saveState(link.peer.id, msg));
        return;
      case 'error':
        link.error = String(msg.message ?? 'the other side hung up').slice(0, 500);
        return close();
      default:
        return;   // pings, and anything a newer version sends that this one does not know
    }
  }

  /** Send the peer every row it has not had yet, a batch at a time. */
  async function pump() {
    if (!wants || link.closed) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        for (const tbl of Object.keys(TABLES)) {
          for (;;) {
            const b = await serial(() => exportBatch(tbl, wants[tbl], { peer: link.peer.id }));
            if (!b || link.closed) break;
            wants[tbl] = b.upTo;
            if (!(await write({ t: 'rows', tbl, cols: b.cols, rows: b.rows, upTo: b.upTo }))) return;
            if (!b.more) break;
          }
        }
      } while (again && !link.closed);
    } catch (err) {
      fail(`could not send: ${err.message}`);
    } finally {
      pumping = false;
    }
  }

  /** Tell the peer what is running here - when it changes, and at least every ping. */
  async function sendState(force = false) {
    if (!wants || !localState || link.closed) return;
    let s;
    try { s = localState(); } catch { return; }
    const json = JSON.stringify(s);
    if (!force && json === state && Date.now() - stateAt < PING_MS) return;
    state = json; stateAt = Date.now();
    await write({ t: 'state', ...s });
  }

  link.nudge = () => { pump(); sendState(); };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    link.heardAt = Date.now();
    // Anything else is a login shell's chatter on the way in.
    if (!line.startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // Messages are handled in order; hold the stream back while imports catch up.
    if (++queued > 16) input.pause();
    inbox = inbox
      .then(() => (link.closed ? null : handle(msg)))
      .catch((err) => fail(err.message))
      .finally(() => { if (--queued < 4 && !link.closed) input.resume(); });
  });
  rl.on('close', () => close(link.peer ? 'connection closed' : 'connection closed before the other side said hello'));
  // readline re-emits its input's errors as its own - unhandled, a connection
  // dropped mid-write would take the whole tracker down with it.
  rl.on('error', (err) => close(err.message));
  input.on('error', (err) => close(err.message));
  output.on('error', (err) => close(err.message));

  const timer = setInterval(() => {
    if (Date.now() - link.heardAt > IDLE_MS) return fail(`nothing heard for ${IDLE_MS / 1000}s`);
    if (!wants) return;
    pump();
    sendState();
    if (Date.now() - sentAt > PING_MS) write({ t: 'ping' });
  }, POLL_MS);
  timer.unref?.();

  let ends = {};
  try { ends = tableEnds(); } catch { /* sent without them; the peer then trusts its cursors */ }
  write({ t: 'hello', v: PROTOCOL, id: me.id, name: me.name, epoch: me.epoch, ends, ...(probe ? { probe: true } : {}) });
  return link;
}

/* --- reaching another machine ---------------------------------------------- */

/*
 * How to start the relay on the other machine. A plain command runs with the
 * bare PATH a non-interactive ssh session gets, which usually lacks wherever
 * claude-tracker was linked; a login shell reads the profile that adds it.
 */
export const REMOTE_COMMANDS = [
  'claude-tracker sync serve',
  `"$SHELL" -lc 'exec claude-tracker sync serve'`,
  `sh -lc 'exec claude-tracker sync serve'`,
];

// BatchMode means ssh can never stop to ask anything - so it also cannot ask
// to trust a host it has not met under this name, and would refuse it. Trust
// on first contact is what answering yes would do; a key that has changed
// since is still refused.
const SSH_OPTIONS = [
  '-T', '-C', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
];

/** Open a link through `ssh target command`. CLAUDE_TRACKER_SSH replaces `ssh`, as GIT_SSH_COMMAND does for git. */
function dial(target, command, opts) {
  const args = [...SSH_OPTIONS, target, command];
  const custom = process.env.CLAUDE_TRACKER_SSH;
  const child = custom
    ? spawn('sh', ['-c', `${custom} "$@"`, 'ssh', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
  const link = openLink({ input: child.stdout, output: child.stdin, ...opts });
  link.exited = new Promise((resolve) => {
    child.on('close', (code) => { link.exitCode = code; resolve(); });
    child.on('error', (err) => { link.error ??= err.code === 'ENOENT' ? 'ssh is not installed' : err.message; link.close(); resolve(); });
  });
  link.done.then(() => { try { child.kill(); } catch { /* already gone */ } });
  link.why = () => link.error && link.error !== 'connection closed' && !link.error.startsWith('connection closed before')
    ? link.error
    : stderr.trim().split('\n').filter((l) => l && !/^Warning: Permanently added/.test(l)).pop()
      ?? link.error ?? `ssh exited with status ${link.exitCode}`;
  return link;
}

/** Did the remote shell fail to find the command, rather than fail to run it? */
const notFound = (link) => link.exitCode === 127 || /command not found|not found|No such file/i.test(link.why());

export function checkTarget(target) {
  if (!target || typeof target !== 'string' || target.startsWith('-') || /\s/.test(target)) {
    throw new Error(`"${target ?? ''}" is not an ssh destination - use what you would type after ssh, e.g. me@devbox`);
  }
  return target;
}

/** Can `target` be synced with? Tries each way of starting the relay until one answers. */
export async function probePeer(target, command = null, timeoutMs = 20_000) {
  checkTarget(target);
  const serial = (fn) => Promise.resolve().then(fn);
  let why = 'no answer';
  for (const c of command ? [command] : REMOTE_COMMANDS) {
    const link = dial(target, c, { serial, probe: true });
    const timer = setTimeout(() => link.close(`no answer within ${timeoutMs / 1000}s`), timeoutMs);
    const peer = await link.hello;
    clearTimeout(timer);
    link.close();
    await link.exited;
    if (peer) return { ok: true, peer, command: c };
    why = link.why();
    if (!notFound(link)) break;
  }
  return { ok: false, error: why };
}

/* --- the tracker's side ------------------------------------------------------ */

const SERVER_FILE = path.join(DATA_DIR, 'server.json');

/**
 * Tell `sync serve` where this tracker listens, and the token it has to show.
 * The file is readable only by this user, so only this user's own ssh sessions
 * can hand this tracker a connection.
 */
export function advertise(port) {
  ensureDataDir();
  const token = crypto.randomBytes(24).toString('hex');
  const tmp = `${SERVER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
  fs.renameSync(tmp, SERVER_FILE);
  return {
    token,
    withdraw() {
      try { if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE); } catch { /* gone */ }
    },
  };
}

function advertised() {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch { return null; }
}

/**
 * Sync with every configured peer, and with any machine that connects here.
 * One connection per machine: a second is refused while the first is healthy.
 */
export function startSync({ serial, onRows, localState, onChange = () => {} }) {
  const byMachine = new Map();   // machine id -> link
  const dialing = new Map();     // ssh target -> { link, failures, retryAt, busy }
  let stopped = false;

  const admit = (peer, link) => {
    const old = byMachine.get(peer.id);
    if (old && old !== link && !old.closed) {
      if (Date.now() - old.heardAt < IDLE_MS / 2) return `already syncing with ${peer.name}`;
      old.close('replaced by a newer connection');
    }
    byMachine.set(peer.id, link);
    link.done.then(() => { if (byMachine.get(peer.id) === link) byMachine.delete(peer.id); onChange(); });
    onChange();
    return null;
  };
  const opts = { serial, admit, onRows, localState };

  async function keep(peer, d) {
    d.busy = true;
    let why = null;
    try {
      peerStatus(peer.target, { status: 'connecting' });
      for (const command of peer.command ? [peer.command] : REMOTE_COMMANDS) {
        const link = dial(peer.target, command, opts);
        d.link = link;
        const hello = await link.hello;
        if (hello && !link.closed) {
          d.failures = 0;
          peerStatus(peer.target, { status: 'connected', machineId: hello.id, command });
          onChange();
        }
        await link.done;
        await link.exited;
        why = link.why();
        if (hello || !notFound(link)) break;
      }
    } catch (err) {
      why = err.message;
    } finally {
      d.link = null;
      d.busy = false;
      d.failures++;
      // Straight back after a healthy connection drops, then backing off to a
      // minute - jittered, so two machines dialling each other stop colliding.
      d.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** (d.failures - 1)) * (0.75 + Math.random() / 2);
      if (!stopped) { try { peerStatus(peer.target, { status: 'error', error: why }); } catch { /* closing */ } }
      onChange();
    }
  }

  const tick = () => {
    if (stopped) return;
    let peers;
    try { peers = listPeers(); } catch { return; }
    const wanted = new Set(peers.map((p) => p.target));
    for (const [target, d] of dialing) {
      if (!wanted.has(target)) { d.link?.close('removed'); dialing.delete(target); }
    }
    for (const p of peers) {
      const d = dialing.get(p.target) ?? { failures: 0, retryAt: 0 };
      dialing.set(p.target, d);
      if (!d.busy && Date.now() >= d.retryAt) keep(p, d);
    }
  };
  const timer = setInterval(tick, 5_000);
  timer.unref?.();
  tick();

  return {
    /** An HTTP upgrade from `sync serve` on this machine. */
    accept(req, socket, head, token) {
      const given = Buffer.from(String(req.headers['x-claude-tracker-token'] ?? ''));
      const ok = given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token));
      if (req.url !== '/sync' || String(req.headers.upgrade ?? '').toLowerCase() !== 'claude-tracker-sync' || !ok) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: claude-tracker-sync\r\nConnection: Upgrade\r\n\r\n');
      if (head?.length) socket.unshift(head);
      socket.setNoDelay(true);
      socket.setTimeout(0);
      openLink({ input: socket, output: socket, ...opts });
    },
    /** Something changed here: send it now rather than at the next poll. */
    nudge() { for (const l of byMachine.values()) l.nudge(); },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const d of dialing.values()) d.link?.close('shutting down');
      for (const l of byMachine.values()) l.close('shutting down');
    },
  };
}

/**
 * `claude-tracker sync serve`: what ssh runs on this machine when another one
 * connects. It carries the connection to the tracker running here, and says
 * why in the protocol's own words when it cannot.
 */
export async function syncServe() {
  const host = os.hostname().replace(/\.(local|lan|home|localdomain)$/i, '');
  const say = (message) => { process.stdout.write(`${JSON.stringify({ t: 'error', message })}\n`); process.exitCode = 1; };
  const s = advertised();
  if (!s) return say(`claude-tracker is not running on ${host} - start it there with: claude-tracker service install`);
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, path: '/sync',
      headers: { connection: 'Upgrade', upgrade: 'claude-tracker-sync', 'x-claude-tracker-token': s.token },
    });
    req.on('upgrade', (_res, socket, head) => {
      if (head?.length) process.stdout.write(head);
      socket.pipe(process.stdout);
      process.stdin.pipe(socket);
      socket.on('close', resolve);
      socket.on('error', resolve);
    });
    req.on('response', (res) => {
      res.resume();
      say(res.statusCode === 404
        ? `the tracker running on ${host} predates sync - restart it there: claude-tracker service install`
        : `the tracker on ${host} refused the connection (HTTP ${res.statusCode})`);
      resolve();
    });
    req.on('error', (err) => { say(`could not reach the tracker on ${host}: ${err.message}`); resolve(); });
    req.end();
  });
}
