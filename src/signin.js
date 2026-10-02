import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configFileOf } from './paths.js';

/**
 * A profile's sign-in, read and written the way Claude Code itself does - so
 * moving one into a profile is what a /login there would have done, and every
 * session running in it carries on as that account.
 *
 * A sign-in has two halves. The tokens live in the profile's secure storage:
 * on macOS a Keychain item, elsewhere `<profile>/.credentials.json`. Only their
 * `claudeAiOauth` part is the account's; the rest of the store - an MCP server's
 * own tokens, say - belongs to the profile and stays put. The account's details
 * live in the profile's config file, as `oauthAccount`.
 *
 * Writes take the lock Claude Code takes for its own (a proper-lockfile at
 * `<profile>/.storage-write.lock`), so a switch never lands inside a refresh.
 */

const LOCK_STALE_MS = 15_000;

/** Run `fn` holding the profile's secure-storage write lock. */
export function withStorageLock(dir, fn) {
  const lock = path.join(dir, '.storage-write.lock');
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A holder refreshes the lock's time while it lives; an old one was abandoned.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (attempt >= 40) throw new Error(`${dir} is busy writing its sign-in; try again shortly`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

/** The Keychain account Claude Code files its items under. */
function keychainAccount() {
  let user;
  try { user = process.env.USER || os.userInfo().username; } catch { user = null; }
  return user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
}

/** The Keychain item a profile's tokens are in: suffixed with a hash of its folder, unless it is ~/.claude. */
export function keychainService(dir, isDefault) {
  const suffix = isDefault ? '' : `-${crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
  return `Claude Code-credentials${suffix}`;
}

function parseStore(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* maybe hex */ }
  if (/^[0-9a-f]+$/i.test(t)) { try { return JSON.parse(Buffer.from(t, 'hex').toString('utf8')); } catch { /* not that either */ } }
  throw new Error('its sign-in could not be read');
}

/** Where a profile keeps its tokens, and how to read and write them. */
export function storeOf(profile, platform = process.platform) {
  const file = path.join(profile.dir, '.credentials.json');
  if (platform !== 'darwin') {
    return {
      read() { try { return parseStore(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } },
      write(data) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, file);
      },
    };
  }
  const service = keychainService(profile.dir, profile.isDefault);
  const account = keychainAccount();
  const security = process.env.CLAUDE_TRACKER_SECURITY || 'security';
  return {
    read() {
      try {
        return parseStore(execFileSync(security, ['find-generic-password', '-a', account, '-w', '-s', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }));
      } catch (err) {
        if (err.status === 44) return null;   // no such item
        if (err.status == null) throw err;
        throw new Error(`the Keychain would not give up ${service} (security exited ${err.status})`);
      }
    },
    write(data) {
      // As Claude Code does: through stdin, so the secret is never on a command line.
      const hex = Buffer.from(JSON.stringify(data), 'utf8').toString('hex');
      execFileSync(security, ['-i'], { input: `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`, stdio: ['pipe', 'ignore', 'pipe'], timeout: 10_000 });
    },
  };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The config file a profile's account details are in - made if it has none yet. */
function configOf(profile) {
  return configFileOf(profile.dir) ?? (profile.isDefault
    ? path.join(path.dirname(profile.dir), `${path.basename(profile.dir)}.json`)
    : path.join(profile.dir, '.claude.json'));
}

const usable = (o) => typeof o?.accessToken === 'string' && typeof o?.refreshToken === 'string';

/** A profile's sign-in: its tokens and its account, or null if it holds none. */
export function readSignin(profile, platform = process.platform) {
  const store = storeOf(profile, platform).read();
  const oauth = store?.claudeAiOauth;
  const account = readJson(configOf(profile))?.oauthAccount ?? null;
  return usable(oauth) && account?.accountUuid ? { oauth, account } : null;
}

/** Put a sign-in into a profile - or, with null, take the one it holds out. */
export function writeSignin(profile, signin, platform = process.platform) {
  const store = storeOf(profile, platform);
  const data = store.read() ?? {};
  if (signin) data.claudeAiOauth = signin.oauth; else delete data.claudeAiOauth;
  store.write(data);
  const file = configOf(profile);
  const cfg = readJson(file) ?? {};
  if (signin) cfg.oauthAccount = signin.account; else delete cfg.oauthAccount;
  writeJson(file, cfg);
}

/**
 * Switch `profile` to the account held in `spare`, as a /login would. The
 * account it is on goes into `outgoing` - its own spare - so no sign-in is ever
 * lost, and none is ever left in two places to go stale.
 *
 * In this order, so stopping part-way leaves at worst a second copy, never a
 * missing one: the outgoing sign-in is saved first, then the profile takes the
 * incoming one, and only then is the spare emptied.
 */
export function switchSignin(profile, spare, outgoing, platform = process.platform) {
  return withStorageLock(profile.dir, () => withStorageLock(spare.dir, () => {
    const current = readSignin(profile, platform);
    const incoming = readSignin(spare, platform);
    if (!incoming) throw new Error(`${spare.shown ?? spare.dir} holds no sign-in`);
    if (current && !outgoing) throw new Error(`nowhere to keep ${current.account.emailAddress}'s sign-in, so nothing was switched`);
    if (current) {
      withStorageLock(outgoing.dir, () => writeSignin(outgoing, current, platform));
      const saved = readSignin(outgoing, platform);
      if (saved?.oauth.refreshToken !== current.oauth.refreshToken) throw new Error(`could not save ${current.account.emailAddress}'s sign-in, so nothing was switched`);
    }
    writeSignin(profile, incoming, platform);
    if (readSignin(profile, platform)?.account.accountUuid !== incoming.account.accountUuid) throw new Error('the profile did not take the new sign-in');
    writeSignin(spare, null, platform);
    return { from: current?.account ?? null, to: incoming.account };
  }));
}
