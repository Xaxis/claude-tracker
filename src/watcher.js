import fs from 'node:fs';
import path from 'node:path';
import { discoverProfiles } from './paths.js';
import { profileAccount, observeAccount } from './accounts.js';

/**
 * Live watching.
 *
 * Transcripts are appended to constantly while Claude Code is running, so raw
 * filesystem events are debounced into at most one refresh per settle window.
 *
 * Watching each profile's config file is what makes historical attribution work:
 * it records which account was signed into which profile at which moment, so
 * sessions that carry no owner of their own can still be placed. Without it we
 * would only ever know who is signed in right now.
 *
 * The home directory is watched too, so creating a whole new profile - signing
 * a new account into a new config directory - is picked up without a restart.
 */

const SETTLE_MS = 1500;
const POLL_MS = 60_000;
const RESCAN_MS = 5 * 60_000;

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

  let watchers = [];
  const tryWatch = (target, opts, handler) => {
    try {
      const w = fs.watch(target, opts, handler);
      w.on('error', () => { /* target vanished; the poll below still covers us */ });
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };

  // Remember the account signed into each profile, so a switch is noticed.
  const lastAccount = new Map();

  const checkAccounts = (profiles) => {
    for (const p of profiles) {
      const cur = profileAccount(p);
      if (!cur) continue;
      observeAccount(cur, Date.now(), 'watch');
      if (lastAccount.get(p.dir) !== cur.accountUuid) {
        const first = !lastAccount.has(p.dir);
        lastAccount.set(p.dir, cur.accountUuid);
        if (!first) schedule('account-switch');
      }
    }
  };

  let profileKey = '';

  /** (Re)attach watches to whatever profiles exist right now. */
  const attach = () => {
    const profiles = discoverProfiles();
    const key = profiles.map((p) => p.dir).join('|');
    const changed = key !== profileKey;
    if (!changed) { checkAccounts(profiles); return profiles; }

    profileKey = key;
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
    watchers = [];

    for (const p of profiles) {
      // Recursive watching is supported on macOS and Windows; elsewhere the
      // poll interval below is the fallback.
      tryWatch(p.projectsDir, { recursive: true }, (_e, name) => {
        if (name && !String(name).endsWith('.jsonl')) return;
        schedule('transcript');
      });
      tryWatch(p.sessionsDir, {}, () => schedule('session'));
      if (p.configFile) tryWatch(p.configFile, {}, () => checkAccounts([p]));
    }

    // A new profile directory appearing in home means a new account to track.
    tryWatch(path.dirname(profiles[0]?.dir ?? process.env.HOME ?? '.'), {}, (_e, name) => {
      if (name && String(name).startsWith('.claude')) schedule('profile-added');
    });

    checkAccounts(profiles);
    if (changed && profileKey) schedule('profiles-changed');
    return profiles;
  };

  attach();
  // First pass only seeded the map; don't report a switch for it.
  const poll = setInterval(() => { checkAccounts(discoverProfiles()); schedule('poll'); }, POLL_MS);
  const rescan = setInterval(attach, RESCAN_MS);

  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(poll);
    clearInterval(rescan);
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
  };
}
