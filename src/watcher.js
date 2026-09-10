import fs from 'node:fs';
import { PROJECTS_DIR, CLAUDE_JSON, SESSIONS_DIR } from './paths.js';
import { currentAccount, observeAccount } from './accounts.js';

/**
 * Live watching.
 *
 * Transcripts are appended to constantly while Claude Code is running, so raw
 * filesystem events are debounced into at most one refresh per settle window.
 *
 * Watching ~/.claude.json is what makes historical attribution work: it records
 * which account was signed in at which moment, so sessions that carry no owner
 * of their own can still be placed. Without it we would only ever know who is
 * signed in right now.
 */

const SETTLE_MS = 1500;
const POLL_MS = 60_000;

export function startWatcher({ onChange }) {
  let timer = null;
  let pending = null;
  let closed = false;

  const schedule = (reason) => {
    if (closed) return;
    pending = reason;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = pending;
      pending = null;
      onChange({ reason: r });
    }, SETTLE_MS);
  };

  const watchers = [];
  const tryWatch = (target, opts, handler) => {
    try {
      const w = fs.watch(target, opts, handler);
      w.on('error', () => { /* directory vanished; the poll below still covers us */ });
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };

  // Recursive watching is supported on macOS and Windows; elsewhere the poll
  // interval below is the fallback.
  const recursive = tryWatch(PROJECTS_DIR, { recursive: true }, (_e, name) => {
    if (name && !String(name).endsWith('.jsonl')) return;
    schedule('transcript');
  });

  tryWatch(SESSIONS_DIR, {}, () => schedule('session'));

  let lastAccount = currentAccount()?.accountUuid ?? null;
  const checkAccount = () => {
    const cur = currentAccount();
    if (!cur) return;
    observeAccount(cur, Date.now(), 'watch');
    if (cur.accountUuid !== lastAccount) {
      lastAccount = cur.accountUuid;
      schedule('account-switch');
    }
  };
  tryWatch(CLAUDE_JSON, {}, checkAccount);

  // Safety net: a periodic sweep covers platforms without recursive watch and
  // any event the OS coalesced away.
  const poll = setInterval(() => {
    checkAccount();
    schedule(recursive ? 'poll' : 'poll-scan');
  }, POLL_MS);

  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(poll);
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
  };
}
