import fs from 'node:fs';
import path from 'node:path';
import { discoverProfiles, HOME } from './paths.js';
import { profileAccount, observeAccount } from './accounts.js';

/**
 * Live watching.
 *
 * Throttled, not debounced. A debounce waits for a quiet gap before refreshing,
 * and with many sessions running there is never a quiet gap - transcripts are
 * written every few hundred milliseconds, so every write pushed the refresh out
 * again and the dashboards starved. Here a burst is coalesced for at most
 * COALESCE_MS, and no pending change ever waits longer than MAX_WAIT_MS.
 *
 * The changed file paths are handed to the refresh, so it reads only those.
 */

const COALESCE_MS = 200;
const MAX_WAIT_MS = 800;
const ACCOUNT_POLL_MS = 2000;
const HEARTBEAT_MS = 5000;
const RESCAN_MS = 60_000;

export function startWatcher({ onChange }) {
  let closed = false;
  let timer = null;
  let firstPendingAt = 0;
  let running = false;
  let pendingPaths = new Set();
  let pendingReasons = new Set();

  const flush = async () => {
    timer = null;
    if (closed) return;
    // One refresh at a time; anything arriving meanwhile is picked up next.
    if (running) { timer = setTimeout(flush, 50); return; }
    const paths = [...pendingPaths];
    const reasons = [...pendingReasons];
    pendingPaths = new Set();
    pendingReasons = new Set();
    firstPendingAt = 0;
    running = true;
    try {
      await onChange({ reason: reasons.includes('account-switch') ? 'account-switch' : reasons[0], reasons, paths });
    } catch { /* the caller reports its own failures */ }
    finally { running = false; }
  };

  const schedule = (reason, file = null) => {
    if (closed) return;
    if (file) pendingPaths.add(file);
    pendingReasons.add(reason);
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    if (timer) clearTimeout(timer);
    // Coalesce briefly, but never past the hard ceiling set by the first change.
    const wait = Math.max(0, Math.min(COALESCE_MS, firstPendingAt + MAX_WAIT_MS - now));
    timer = setTimeout(flush, wait);
  };

  let watchers = [];
  const tryWatch = (target, opts, handler) => {
    try {
      const w = fs.watch(target, opts, handler);
      w.on('error', () => { /* target vanished; the polls below still cover us */ });
      watchers.push(w);
    } catch { /* not watchable here; the polls below still cover us */ }
  };

  // Remember who is signed into each profile, so a switch is noticed.
  const lastAccount = new Map();
  const checkAccounts = (profiles) => {
    for (const p of profiles) {
      const cur = profileAccount(p);
      if (!cur) continue;
      const prev = lastAccount.get(p.dir);
      if (prev !== cur.accountUuid) {
        lastAccount.set(p.dir, cur.accountUuid);
        observeAccount(cur, Date.now(), 'watch');
        if (prev !== undefined) schedule('account-switch');
      }
    }
  };

  let profiles = [];
  let profileKey = '';
  const attach = () => {
    profiles = discoverProfiles();
    const key = profiles.map((p) => p.dir).join('|');
    if (key === profileKey) return;
    const isNew = profileKey !== '';
    profileKey = key;
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
    watchers = [];

    for (const p of profiles) {
      tryWatch(p.projectsDir, { recursive: true }, (_e, name) => {
        if (!name || !String(name).endsWith('.jsonl')) return;
        schedule('transcript', path.join(p.projectsDir, String(name)));
      });
      tryWatch(p.sessionsDir, {}, () => schedule('session'));
      // Config files are replaced by rename, which silently kills a watch on the
      // file itself - so watch the directory that holds it and filter by name.
      if (p.configFile) {
        const base = path.basename(p.configFile);
        tryWatch(path.dirname(p.configFile), {}, (_e, name) => {
          if (name && String(name).startsWith(base)) checkAccounts([p]);
        });
      }
    }
    // A new ~/.claude-* directory is a new account to track.
    tryWatch(HOME, {}, (_e, name) => {
      if (name && String(name).startsWith('.claude') && !String(name).includes('.json')) attach();
    });
    checkAccounts(profiles);
    if (isNew) schedule('profiles-changed');
  };

  attach();

  // Safety nets, cheap enough to run often: an account switch shows within
  // ACCOUNT_POLL_MS even if the OS drops the event, a heartbeat keeps "last
  // active" and burn rates moving in quiet periods, and a rescan picks up
  // profiles and files the watches missed.
  const accountPoll = setInterval(() => checkAccounts(profiles), ACCOUNT_POLL_MS);
  const heartbeat = setInterval(() => schedule('heartbeat'), HEARTBEAT_MS);
  const rescan = setInterval(attach, RESCAN_MS);

  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(accountPoll);
    clearInterval(heartbeat);
    clearInterval(rescan);
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
  };
}
