import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, DATA_DIR, REPO_DIR, nodeBinary, ensureDataDir } from './paths.js';

/**
 * Running the tracker at login, via a per-user launchd agent.
 *
 * Attribution is only exact while the tracker is running - it records each
 * /login as it happens - so it is worth keeping on. The agent runs the web
 * dashboard in the background; `claude-tracker` in a terminal then attaches to
 * it instead of starting a second server.
 */
export const LABEL = 'local.claude-tracker';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(DATA_DIR, 'service.log');
const target = () => `gui/${process.getuid()}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.stdout || err.message) };
  }
}

export function installService({ port = 4785 } = {}) {
  if (process.platform !== 'darwin') throw new Error('The login service uses launchd, which is macOS only.');
  ensureDataDir();
  const args = [nodeBinary(), path.join(REPO_DIR, 'bin', 'cli.js'), 'serve', '--no-tui', '--port', String(port)];
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.CLAUDE_TRACKER_DIR) env.CLAUDE_TRACKER_DIR = process.env.CLAUDE_TRACKER_DIR;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `\n    <string>${esc(a)}</string>`).join('')}
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `\n    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('')}
  </dict>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  launchctl('bootout', `${target()}/${LABEL}`);   // replace any earlier version
  fs.writeFileSync(PLIST, plist);
  const r = launchctl('bootstrap', target(), PLIST);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
  return { plist: PLIST, log: LOG, url: `http://127.0.0.1:${port}` };
}

export function uninstallService() {
  const r = launchctl('bootout', `${target()}/${LABEL}`);
  const had = fs.existsSync(PLIST);
  if (had) fs.unlinkSync(PLIST);
  return { removed: had || r.ok };
}

export function serviceStatus() {
  const r = launchctl('print', `${target()}/${LABEL}`);
  const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
  const state = /\bstate = (\w+)/.exec(r.out)?.[1] ?? null;
  return { installed: fs.existsSync(PLIST), loaded: r.ok, state, pid: pid ? Number(pid) : null, plist: PLIST, log: LOG };
}
