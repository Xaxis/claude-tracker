import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

/**
 * Claude profiles.
 *
 * Running several accounts on one machine means several *config directories* -
 * `CLAUDE_CONFIG_DIR=~/.claude-work claude`, and so on. Each one is a complete,
 * independent Claude state tree with its own `projects/`, its own history, and
 * its own signed-in account.
 *
 * This matters more than it sounds: a config directory holds exactly one account
 * at a time, so the directory a transcript lives under *is* the account that
 * paid for it. That is real attribution, not inference - and it is why the
 * tracker discovers every profile rather than only the default one.
 *
 * Profiles are discovered at runtime, so signing a new account into a new
 * directory makes it appear on its own with no configuration.
 */

/** Where a profile keeps its config file. Differs for the default profile. */
function configFileFor(dir) {
  const inside = path.join(dir, '.claude.json');
  if (fs.existsSync(inside)) return inside;
  // The default ~/.claude keeps its config beside it, at ~/.claude.json.
  const beside = path.join(path.dirname(dir), `${path.basename(dir)}.json`);
  return fs.existsSync(beside) ? beside : null;
}

/** Does this directory look like a Claude state tree? */
function isProfileDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch { return false; }
  if (!fs.existsSync(path.join(dir, 'projects'))) return false;
  return ['settings.json', 'history.jsonl', '.claude.json', 'sessions']
    .some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Every Claude profile on this machine.
 *
 * Looks at `CLAUDE_CONFIG_DIR`, the default `~/.claude`, and any `~/.claude-*`
 * sibling. `CLAUDE_TRACKER_EXTRA_DIRS` (colon-separated) adds directories kept
 * somewhere unusual.
 *
 * A profile nested inside another is skipped: some setups keep a copy of an old
 * tree under a newer one, and walking both would scan every transcript twice.
 */
export function discoverProfiles() {
  const candidates = new Set();

  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const p of process.env.CLAUDE_CONFIG_DIR.split(':')) {
      if (p.trim()) candidates.add(path.resolve(p.trim()));
    }
  }
  for (const p of (process.env.CLAUDE_TRACKER_EXTRA_DIRS ?? '').split(':')) {
    if (p.trim()) candidates.add(path.resolve(p.trim()));
  }
  candidates.add(path.join(HOME, '.claude'));

  try {
    for (const name of fs.readdirSync(HOME)) {
      if (name === '.claude' || name.startsWith('.claude-')) {
        candidates.add(path.join(HOME, name));
      }
    }
  } catch { /* unreadable home; the explicit candidates still stand */ }

  const dirs = [...candidates]
    .map((d) => { try { return fs.realpathSync(d); } catch { return d; } })
    .filter((d, i, a) => a.indexOf(d) === i)
    .filter(isProfileDir)
    .sort();

  // Drop any profile contained in another - the outer scan already covers it.
  const outermost = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + path.sep)));

  return outermost.map((dir) => ({
    dir,
    name: path.basename(dir),
    projectsDir: path.join(dir, 'projects'),
    configFile: configFileFor(dir),
    backupsDir: path.join(dir, 'backups'),
    sessionsDir: path.join(dir, 'sessions'),
    isDefault: dir === path.join(HOME, '.claude'),
  }));
}

/** The profile a path belongs to, or null. */
export function profileForPath(profiles, filePath) {
  return profiles.find((p) => filePath.startsWith(p.dir + path.sep)) ?? null;
}

/** Where claude-tracker keeps its own state. Override with CLAUDE_TRACKER_DIR. */
export const DATA_DIR = process.env.CLAUDE_TRACKER_DIR
  ? path.resolve(process.env.CLAUDE_TRACKER_DIR)
  : path.join(HOME, '.claude', 'tracker');

export const DB_PATH = path.join(DATA_DIR, 'tracker.db');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

/**
 * Turn a project directory slug back into something readable.
 * Claude stores "/Users/me/Projects/foo" as "-Users-me-Projects-foo", which is
 * lossy (dashes in real path segments are indistinguishable from separators),
 * so prefer the `cwd` recorded inside the transcript when one is available.
 */
export function prettyProject(slug, cwd) {
  if (cwd) return path.basename(cwd) || cwd;
  const parts = String(slug).split('-').filter(Boolean);
  return parts[parts.length - 1] || slug;
}
