import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

/** Root of the Claude CLI state directory. Override with CLAUDE_CONFIG_DIR. */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, '.claude');

/** Per-project transcript directories: ~/.claude/projects/<slug>/<sessionId>.jsonl */
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** Global CLI config; holds the currently signed-in oauthAccount. */
export const CLAUDE_JSON = path.join(HOME, '.claude.json');

/** Rotating backups of the above - a cheap history of account switches. */
export const BACKUPS_DIR = path.join(CLAUDE_DIR, 'backups');

/** Live per-process session registry written by running Claude Code instances. */
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

/** Where claude-tracker keeps its own state. Override with CLAUDE_TRACKER_DIR. */
export const DATA_DIR = process.env.CLAUDE_TRACKER_DIR
  ? path.resolve(process.env.CLAUDE_TRACKER_DIR)
  : path.join(CLAUDE_DIR, 'tracker');

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
