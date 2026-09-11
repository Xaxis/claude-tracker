import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { overview, history, sessions, modelBreakdown, liveSessions, windowHistory } from './api.js';
import { verifyWindowModel } from './calibrate.js';
import { startWatcher } from './watcher.js';
import { listAccounts } from './accounts.js';
import { notify } from './notify.js';

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
    case '/api/health': return sendJson(res, { app: 'claude-tracker', pid: process.pid });
    case '/api/overview': return sendJson(res, overview());
    case '/api/history': return sendJson(res, history(days, account));
    case '/api/sessions': return sendJson(res, sessions(Math.min(200, Number(q.get('limit') ?? 40)), account));
    case '/api/models': return sendJson(res, modelBreakdown(days, account));
    case '/api/live': return sendJson(res, liveSessions());
    case '/api/accounts': return sendJson(res, listAccounts());
    case '/api/verify': return sendJson(res, verifyWindowModel());
    case '/api/windows':
      if (!account) return sendJson(res, { error: 'account required' }, 400);
      return sendJson(res, windowHistory(account, q.get('type') ?? 'five_hour', Math.min(60, Number(q.get('count') ?? 14))));
    default:
      return sendJson(res, { error: 'not found' }, 404);
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

export async function serve({ port = 4785, open = false, refresh, fastRefresh, tui = true, web = true, notifications = true }) {
  // Refreshes share one database connection and ingest in chunked transactions
  // that span awaits, so two must never interleave. Everything that writes goes
  // through this queue, one at a time.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  // Bring the database current before accepting requests.
  await serial(() => refresh({ quiet: true, reattribute: 'all' }));

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); }
    catch { res.writeHead(400).end('Bad request'); return; }

    // A failing query must surface as a 500, never take the server down with it.
    try {
      if (url.pathname === '/events') return handleEvents(req, res);
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

  let ui = null;
  // Alerts are checked at most every 10s, whatever the push rate.
  let lastNotify = 0;
  const push = (info) => {
    if (web) broadcast('update', { reason: info.reason, at: Date.now(), newEvents: info.newEvents ?? 0 });
    ui?.update();
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

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(fullTimer);
    stopWatching();
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
