import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { overview, history, sessions, modelBreakdown, liveSessions, windowHistory, localState, boxes, build,
  machinePanel, storagePanel, surveyNow, startMachineWatch } from './api.js';
import { setPriority, runNext } from './machine.js';
import { cacheSummary } from './context.js';
import { verifyWindowModel } from './calibrate.js';
import { startWatcher } from './watcher.js';
import { listAccounts } from './accounts.js';
import { notify } from './notify.js';
import { PROTOCOL, advertise, startSync } from './sync.js';
import { plan, runFailover } from './failover.js';
import { send, onSend } from './notify.js';
import { setMeta } from './db.js';
import { accountsCsv, exportFileName } from './export.js';
import { startPanes } from './panes.js';
import { startBridge, bridgeStatus, readConfig as slackConfig } from './bridge.js';
import { machine } from './replica.js';
import { useLinks, onPanel, panelOf, ask, onBoxControl } from './fleet.js';
import { setPlanPrice } from './plans.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const clients = new Set();

function sendJson(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

/** Push an event to every connected dashboard. */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Resolve and confirm the result stays inside web/ - no traversal out of it.
  const full = path.resolve(WEB_DIR, rel);
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

function handleApi(req, res, url) {
  const q = url.searchParams;
  const account = q.get('account') || null;
  const days = Math.min(365, Math.max(1, Number(q.get('days') ?? 30)));

  switch (url.pathname) {
    case '/api/health': return sendJson(res, { app: 'claude-tracker', pid: process.pid, sync: PROTOCOL, slack: 1 });
    case '/api/overview': return sendJson(res, overview());
    case '/api/history': return sendJson(res, history(days, account));
    case '/api/sessions': return sendJson(res, sessions(Math.min(200, Number(q.get('limit') ?? 40)), account));
    case '/api/models': return sendJson(res, modelBreakdown(days, account));
    case '/api/live': return sendJson(res, liveSessions());
    case '/api/box': return sendJson(res, boxes());
    // This machine's, or with ?on=<machine id> a synced machine's as it last sent it.
    case '/api/machine': return sendJson(res, panelOf('machine', q.get('on'), machinePanel));
    case '/api/storage': return sendJson(res, panelOf('storage', q.get('on'), storagePanel));
    case '/api/cache': return sendJson(res, cacheSummary());
    case '/api/accounts': return sendJson(res, listAccounts());
    case '/api/accounts.csv': {
      const csv = accountsCsv();
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFileName()}"`,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(csv),
      });
      return res.end(csv);
    }
    case '/api/verify': return sendJson(res, verifyWindowModel());
    case '/api/slack': return sendJson(res, bridgeStatus() ?? { state: 'off' });
    case '/api/windows':
      if (!account) return sendJson(res, { error: 'account required' }, 400);
      return sendJson(res, windowHistory(account, q.get('type') ?? 'five_hour', Math.min(60, Number(q.get('count') ?? 14))));
    default:
      return sendJson(res, { error: 'not found' }, 404);
  }
}

/**
 * The dashboard's only writes: the owner's priorities, "run this next", and a
 * fresh disk survey. Every other route is a read. A page on another site can
 * make a browser send a request here, so a write must come from this
 * dashboard: the Host must be this loopback address (no DNS rebinding), any
 * Origin must be the same, and the body must be JSON, which no plain form or
 * cross-site fetch can send without asking first.
 */
async function handleWrite(req, res, url) {
  const host = String(req.headers.host ?? '');
  const local = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
  const origin = req.headers.origin;
  if (!local || (origin && origin !== `http://${host}`) || !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    return sendJson(res, { error: 'writes come from the dashboard itself' }, 403);
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return sendJson(res, { error: 'too large' }, 413);
  }
  let msg;
  try { msg = body ? JSON.parse(body) : {}; } catch { return sendJson(res, { error: 'not JSON' }, 400); }
  // Another machine's priorities go to the tracker beside its heavy, over the sync link.
  const there = typeof msg.machine === 'string' && msg.machine !== machine().id ? msg.machine : null;
  try {
    switch (url.pathname) {
      case '/api/priority':
        if (there) await ask(there, { k: 'prio', project: msg.project, tier: msg.tier });
        else setPriority(msg.project, msg.tier, 'claude-tracker (dashboard)');
        broadcast('machine', { at: Date.now() });
        return sendJson(res, panelOf('machine', there, machinePanel));
      case '/api/run-next':
        if (there) await ask(there, { k: 'next', pid: Number(msg.pid) });
        else runNext(Number(msg.pid));
        broadcast('machine', { at: Date.now() });
        return sendJson(res, panelOf('machine', there, machinePanel));
      case '/api/plan-price':
        setPlanPrice(msg.account, msg.usd ?? null);
        broadcast('update', { reason: 'plan-price', at: Date.now(), newEvents: 0 });
        return sendJson(res, { ok: true });
      case '/api/storage/rescan':
        surveyNow().then(() => broadcast('storage', { at: Date.now() }), (err) => console.error('storage survey:', err.message));
        return sendJson(res, { started: true });
      default:
        return sendJson(res, { error: 'not found' }, 404);
    }
  } catch (err) {
    return sendJson(res, { error: err.message }, 400);
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  // Keep intermediaries and idle sockets from dropping the stream.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

/**
 * Run the tracker: an HTTP dashboard, a terminal dashboard, or both.
 *
 * Both surfaces live in one process and share a single watcher, so the browser
 * and the terminal always show the same numbers and the transcripts are only
 * scanned once no matter how many views are open.
 */
/** Is another claude-tracker already serving on this port? */
async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return (await r.json())?.app === 'claude-tracker' ? 'tracker' : 'other';
  } catch (err) {
    return err?.cause?.code === 'ECONNREFUSED' || err?.name === 'TypeError' ? 'free' : 'other';
  }
}

export async function serve({ port = 4785, open = false, refresh, fastRefresh, afterSync, tui = true, web = true, notifications = true }) {
  // Refreshes share one database connection and ingest in chunked transactions
  // that span awaits, so two must never interleave. Everything that writes goes
  // through this queue, one at a time.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  // Pin which code this is now, before anything can be pulled over it.
  build();

  // Bring the database current before accepting requests.
  await serial(() => refresh({ quiet: true, reattribute: 'all' }));

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); }
    catch { res.writeHead(400).end('Bad request'); return; }

    // A failing query must surface as a 500, never take the server down with it.
    try {
      if (url.pathname === '/events') return handleEvents(req, res);
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        return handleWrite(req, res, url).catch((err) => {
          console.error(`${url.pathname}:`, err.message);
          if (!res.headersSent) sendJson(res, { error: err.message }, 500); else res.end();
        });
      }
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error(`${url.pathname}:`, err.message);
      if (!res.headersSent) return sendJson(res, { error: err.message }, 500);
      return res.end();
    }
  });

  let addr = null;
  let attached = false;
  if (web) {
    // One web server per port. If a tracker already serves it - usually the
    // login service - the terminal dashboard attaches to that instead.
    const who = await probe(port);
    if (who === 'tracker' && tui) {
      web = false; attached = true; addr = `http://127.0.0.1:${port}`;
    } else if (who !== 'free' && tui) {
      web = false;
    } else {
      // Bind to loopback only: this exposes local usage history and should
      // never be reachable from the network. As a background service, wait for
      // the port rather than exit - a foreground tracker may be holding it.
      let waited = false, lost = null;
      for (;;) {
        try {
          // Each attempt removes both of its listeners, whichever way it ends -
          // a service can wait on the port for hours.
          await new Promise((resolve, reject) => {
            const onError = (err) => { server.off('listening', onListening); reject(err); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
          });
          break;
        } catch (err) {
          if (err.code !== 'EADDRINUSE') throw err;
          // A dashboard that loses the port between the probe and the bind -
          // usually to the login service starting up - joins whoever took it.
          if (tui) { lost = await probe(port); break; }
          waited = true;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      if (lost) {
        web = false;
        if (lost === 'tracker') { attached = true; addr = `http://127.0.0.1:${port}`; }
      } else {
        // Whatever held the port may have been an older tracker re-attributing
        // with its own rules meanwhile; settle everything again under ours.
        if (waited) await serial(() => refresh({ quiet: true, reattribute: 'all' }));
        addr = `http://127.0.0.1:${port}`;
      }
    }
  }

  // What uses this machine: sampled by whichever process shows it, and its disks
  // surveyed by the one that serves the port.
  if (web || tui) startMachineWatch({ surveys: web });

  let ui = null;
  let sync = null;
  // Alerts are checked at most every 10s, whatever the push rate.
  let lastNotify = 0;
  const push = (info) => {
    if (web) broadcast('update', { reason: info.reason, at: Date.now(), newEvents: info.newEvents ?? 0 });
    ui?.update();
    sync?.nudge();
    if (notifications && Date.now() - lastNotify > 10_000) {
      lastNotify = Date.now();
      try { notify(overview()); } catch { /* an alert must never take the dashboards down */ }
    }
  };

  // Full rescan on a slow cadence: files the watches missed, keychain, calibration.
  let fullBusy = false;
  const fullTimer = setInterval(() => {
    if (fullBusy) return;
    fullBusy = true;
    serial(() => refresh({ quiet: true }))
      .then(() => push({ reason: 'rescan' }))
      .catch((err) => (ui ? ui.reportError(err.message) : console.error('rescan failed:', err.message)))
      .finally(() => { fullBusy = false; });
  }, 60_000);

  const stopWatching = startWatcher({
    onChange: async (info) => {
      try {
        const r = await serial(() => fastRefresh(info.paths ?? []));
        push({ ...info, newEvents: r?.newEvents ?? 0 });
      } catch (err) {
        // The TUI owns the screen, so a stray write would corrupt the frame -
        // hand it the message to show in its footer instead of dropping it.
        if (ui) ui.reportError(err.message);
        else console.error('refresh failed:', err.message);
      }
    },
  });

  // Syncing with other machines belongs to whichever process serves the port -
  // the one `sync serve` finds. Rows that arrive are settled a second at a time.
  let advert = null;
  let control = null, drive = null;
  if (web) {
    advert = advertise(port);
    let since = null, settling = null;
    const onRows = (t) => {
      since = Math.min(since ?? Infinity, t ?? Infinity);
      settling ??= setTimeout(() => {
        const from = since;
        since = null; settling = null;
        serial(() => afterSync(from))
          .then(() => push({ reason: 'sync' }))
          .catch((err) => (ui ? ui.reportError(err.message) : console.error('sync failed:', err.message)));
      }, 1000);
    };
    sync = startSync({
      serial, onRows, localState, onLink: (link) => drive?.linked(link),
      // A priority set from another machine's dashboard is answered here; the rest is Slack's.
      onControl: async (link, msg) => (await onBoxControl(link, msg, () => broadcast('machine', { at: Date.now() }))) || control?.(link, msg),
      localPanel: () => ({ machine: machinePanel(), storage: storagePanel() }),
      onPanel,
    });
    useLinks(() => sync?.links() ?? []);
    server.on('upgrade', (req, socket, head) => sync.accept(req, socket, head, advert.token));
  }

  // Driving sessions from Slack, also this process's: the bridge, where Slack
  // is set up here, and following the sessions running here - for that bridge,
  // or for a synced machine's.
  if (web) {
    drive = startDriving({ sync: () => sync, log: (m) => (ui ? ui.reportError(m) : console.error(m)) });
    control = drive.control;
    onSend((title, message) => drive.bridge.notice(title, message));
  }

  // Failing over is this process's too: every 20s, work out where sessions here
  // would go and keep that for the dashboards and other machines - and, when
  // it is switched on, move the ones that are due.
  let failTimer = null;
  if (web) {
    let failing = false;
    const told = new Map();
    const failover = async () => {
      if (failing) return;
      failing = true;
      try {
        const ov = overview(), live = liveSessions();
        const p = plan(ov, live);
        setMeta('failover_plan', JSON.stringify({ ...p, computedAt: Date.now() }));
        for (const n of p.notices) {
          if (n.level !== 'bad' || Date.now() - (told.get(n.text) ?? 0) < 6 * 3600e3) continue;
          told.set(n.text, Date.now());
          send('Claude failover needs you', `${n.text} To fix: ${n.fix}.`);
        }
        const names = new Map(ov.accounts.map((a) => [a.accountUuid, a.label]));
        const made = runFailover(ov, live);
        for (const m of made) {
          // A switch failing the same way every tick is said once an hour, not every 20 seconds.
          const why = `${m.profile}|${m.to_account}|${m.error}`;
          if (m.status !== 'switched') { if (Date.now() - (told.get(why) ?? 0) < 3600e3) continue; told.set(why, Date.now()); }
          send(m.status === 'switched' ? 'Claude switched accounts' : 'Claude could not switch accounts',
            m.status === 'switched'
              ? `${names.get(m.from_account) ?? 'The account'} ${m.lapsing ? 'was signed out, or about to be' : 'ran low'}; its sessions carry on as ${names.get(m.to_account) ?? 'another account'}.`
              : m.error);
        }
        if (made.length) push({ reason: 'failover' });
      } catch (err) {
        if (ui) ui.reportError(`failover: ${err.message}`); else console.error('failover failed:', err.message);
      } finally {
        failing = false;
      }
    };
    failTimer = setInterval(failover, 20_000);
    setTimeout(failover, 3_000).unref();
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(fullTimer);
    clearInterval(failTimer);
    drive?.stop();
    stopWatching();
    sync?.stop();
    advert?.withdraw();
    ui?.stop();
    for (const c of clients) { try { c.end(); } catch { /* already gone */ } }
    if (web) server.close(() => process.exit(0));
    else process.exit(0);
    // Don't hang on a wedged keep-alive socket.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (open && addr) exec(`open ${addr}`);

  if (tui) {
    const { startTui } = await import('./tui.js');
    ui = startTui({ webUrl: addr ? `${addr}${attached ? ' (service)' : ''}` : 'web dashboard off', onQuit: shutdown });
  } else if (web) {
    console.log(`\n  claude-tracker  →  ${addr}\n  watching for new usage… (ctrl-c to stop)\n`);
  }
}

/**
 * The bridge to Slack, and the sessions here it - or another machine's bridge
 * - follows and types into. Each synced machine's tracker follows its own
 * sessions and sends what they say over the sync connection; whichever
 * machine has Slack set up does the talking to Slack for all of them.
 */
function startDriving({ sync, log }) {
  let panes = null;
  const watchers = new Set();    // links whose machine's bridge follows the sessions here
  const hubs = new Set();        // links to machines with Slack set up themselves
  const asked = new Map();       // request id -> { resolve, reject, timer }
  let nextId = 1;

  const bridge = startBridge({
    here: machine().name,
    log,
    info: sessionInfo,
    usage: usageText,
    // A thread this machine does not know may be one of a machine that runs Slack itself.
    forward: (type, payload) => {
      for (const l of hubs) l.send({ t: 'ctl', k: 'event', type, payload });
      return hubs.size > 0;
    },
  });

  const tell = (msg) => { for (const l of watchers) l.send({ t: 'ctl', ...msg }); };
  function want() {
    const needed = bridge.active || watchers.size > 0;
    if (needed && !panes) {
      panes = startPanes({
        onSessions: (list) => { bridge.sessions(null, list); tell({ k: 'sessions', list }); },
        onItems: (id, items) => { bridge.items(null, id, items); tell({ k: 'items', id, items }); },
      });
      bridge.machine(null, machine().name, (op) => panes.act(op));
    } else if (!needed && panes) {
      panes.stop();
      panes = null;
      bridge.machineDown(null);
    }
  }

  /** Ask a machine whose sessions come through here to do something to one. */
  const remoteAct = (link) => (op) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { asked.delete(id); reject(new Error(`${link.peer.name} did not answer`)); }, 30_000);
    asked.set(id, { resolve, reject, timer });
    link.send({ t: 'ctl', k: 'do', id, op });
  });

  /** A machine just connected: if Slack runs here, ask it for its sessions. */
  function linked(link) {
    if (!bridge.active) return;
    link.send({ t: 'ctl', k: 'watch' });
    // A tracker from before this says nothing back.
    const peer = link.peer;
    link.heardCtl = false;
    setTimeout(() => {
      if (!link.heardCtl && !link.closed) { bridge.machine(peer.id, peer.name, remoteAct(link)); bridge.machineDown(peer.id, { old: true }); }
    }, 15_000).unref?.();
    link.done.then(() => bridge.machineDown(peer.id));
  }

  async function control(link, msg) {
    link.heardCtl = true;
    const peer = link.peer;
    switch (msg.k) {
      case 'watch':
        // Both have Slack: each carries its own sessions, and passes on what is the other's.
        if (bridge.active) { link.send({ t: 'ctl', k: 'hub' }); hubs.add(link); link.done.then(() => hubs.delete(link)); return; }
        // `claude-tracker slack off` here says no machine drives the sessions here.
        if (slackConfig()?.disabled) { link.send({ t: 'ctl', k: 'refused' }); return; }
        watchers.add(link);
        link.done.then(() => { watchers.delete(link); want(); });
        want();
        // Before its first look, the list comes with that look.
        if (panes.sessions()) link.send({ t: 'ctl', k: 'sessions', list: panes.sessions() });
        return;
      case 'unwatch': watchers.delete(link); want(); return;
      case 'hub': hubs.add(link); link.done.then(() => hubs.delete(link)); return;
      case 'refused': bridge.machine(peer.id, peer.name, remoteAct(link)); bridge.machineDown(peer.id, { refused: true }); return;
      case 'sessions':
        bridge.machine(peer.id, peer.name, remoteAct(link));
        bridge.sessions(peer.id, Array.isArray(msg.list) ? msg.list : []);
        return;
      case 'items': if (typeof msg.id === 'string' && Array.isArray(msg.items)) bridge.items(peer.id, msg.id, msg.items); return;
      case 'event': bridge.foreign(msg.type, msg.payload); return;
      case 'do': {
        let reply;
        try {
          if (!panes) throw new Error('not following the sessions here');
          reply = { ok: true, r: await panes.act(msg.op ?? {}) };
        } catch (err) { reply = { ok: false, error: err.message }; }
        link.send({ t: 'ctl', k: 'done', id: msg.id, ...reply });
        return;
      }
      case 'done': {
        const a = asked.get(msg.id);
        if (!a) return;
        asked.delete(msg.id);
        clearTimeout(a.timer);
        if (msg.ok) a.resolve(msg.r); else a.reject(new Error(msg.error ?? 'failed'));
        return;
      }
      default:
    }
  }

  // Slack set up, or taken down, from another process: follow along.
  let was = false;
  const timer = setInterval(() => {
    want();
    if (bridge.active === was) return;
    was = bridge.active;
    for (const l of sync()?.links() ?? []) {
      if (was) linked(l); else l.send({ t: 'ctl', k: 'unwatch' });
    }
  }, 3000);
  timer.unref?.();
  want();
  was = bridge.active;

  return {
    bridge, control, linked,
    stop() { clearInterval(timer); panes?.stop(); bridge.stop(); },
  };
}

/** What the tracker knows of a running session: its account and context. Read every few seconds at most. */
let infoCache = { at: 0, by: new Map() };
function sessionInfo(sessionId) {
  if (Date.now() - infoCache.at > 5000) {
    const by = new Map();
    try { for (const s of liveSessions()) for (const id of [s.sessionId, s.transcriptId]) if (id) by.set(id, s); } catch { /* keep the old */ }
    infoCache = { at: Date.now(), by };
  }
  return infoCache.by.get(sessionId) ?? null;
}

/** Every account, how full, and which to use: for `usage` in Slack. */
function usageText() {
  const ov = overview();
  const pct = (l) => (l?.percent == null ? '–' : `${Math.round(l.percent)}%`);
  const rows = ov.accounts
    .map((a) => ({ a, five: a.limits.find((l) => l.type === 'five_hour'), week: a.limits.find((l) => l.type === 'seven_day') }))
    .filter(({ a }) => a.sessions || a.isCurrent || (a.limits ?? []).some((l) => l.active))
    .sort((x, y) => (y.five?.percent ?? 0) - (x.five?.percent ?? 0));
  const out = rows.map(({ a, five, week }) => {
    const ends = a.limits.filter((l) => l.blocked).map((l) => l.end).filter(Boolean);
    const free = ends.length ? ` · out until ${new Date(Math.max(...ends)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return `${a.isCurrent ? ':large_green_circle:' : ':white_circle:'} *${a.label}* · 5h ${pct(five)} · 7d ${pct(week)}${free}`;
  });
  const r = ov.recommendation;
  if (r) out.push(`\n*Use now:* ${r.label} · ${Math.round(r.headroom)}% headroom${r.command ? ` · \`${r.command}\`` : ''}`);
  return out.join('\n');
}
