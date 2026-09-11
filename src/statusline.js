import fs from 'node:fs';
import path from 'node:path';
import { discoverProfiles, REPO_DIR, nodeBinary } from './paths.js';

/**
 * Installing the status line into each Claude profile.
 *
 * Claude Code runs a profile's `statusLine` command on every render and feeds
 * it the session's exact plan utilization. Pointing that at bin/statusline.js
 * is how the tracker gets real numbers instead of estimates. Everything else in
 * settings.json is left exactly as it was, a backup is written before any
 * change, and a status line someone else configured is never replaced unless
 * asked to.
 */
const SCRIPT = path.join(REPO_DIR, 'bin', 'statusline.js');
const isOurs = (sl) => typeof sl?.command === 'string' && sl.command.includes('statusline.js') && sl.command.includes('claude-tracker');

export function statusLineCommand() {
  return `${nodeBinary()} "${SCRIPT}"`;
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON - left untouched`);
  }
}

function write(file, obj) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.claude-tracker-backup-${Date.now()}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function statusLineState() {
  return discoverProfiles().map((p) => {
    const file = path.join(p.dir, 'settings.json');
    let sl = null;
    try { sl = read(file).statusLine ?? null; } catch { sl = { unreadable: true }; }
    return { profile: p.name, file, state: sl ? (isOurs(sl) ? 'installed' : 'other') : 'none', statusLine: sl };
  });
}

export function installStatusLine({ force = false } = {}) {
  const command = statusLineCommand();
  return discoverProfiles().map((p) => {
    const file = path.join(p.dir, 'settings.json');
    try {
      const cfg = read(file);
      if (cfg.statusLine && !isOurs(cfg.statusLine) && !force) {
        return { profile: p.name, result: 'skipped', reason: 'has its own status line (use --force to replace)' };
      }
      if (isOurs(cfg.statusLine) && cfg.statusLine.command === command) return { profile: p.name, result: 'already installed' };
      cfg.statusLine = { type: 'command', command, padding: 0 };
      write(file, cfg);
      return { profile: p.name, result: 'installed' };
    } catch (err) {
      return { profile: p.name, result: 'failed', reason: err.message };
    }
  });
}

export function uninstallStatusLine() {
  return discoverProfiles().map((p) => {
    const file = path.join(p.dir, 'settings.json');
    try {
      const cfg = read(file);
      if (!isOurs(cfg.statusLine)) return { profile: p.name, result: 'not installed' };
      delete cfg.statusLine;
      write(file, cfg);
      return { profile: p.name, result: 'removed' };
    } catch (err) {
      return { profile: p.name, result: 'failed', reason: err.message };
    }
  });
}
