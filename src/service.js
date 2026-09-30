import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, DATA_DIR, REPO_DIR, nodeBinary, ensureDataDir } from './paths.js';

/**
 * Running the tracker at login: a per-user launchd agent on macOS, a systemd
 * user service on Linux.
 *
 * Attribution is only exact while the tracker is running - it records each
 * /login as it happens - so it is worth keeping on. The service runs the web
 * dashboard in the background; `claude-tracker` in a terminal then attaches to
 * it instead of starting a second server.
 */
export const LABEL = 'local.claude-tracker';
const LOG = path.join(DATA_DIR, 'service.log');

/** What the service runs, and the environment it runs with. */
function command(port) {
  const args = [nodeBinary(), path.join(REPO_DIR, 'bin', 'cli.js'), 'serve', '--no-tui', '--port', String(port)];
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.CLAUDE_TRACKER_DIR) env.CLAUDE_TRACKER_DIR = process.env.CLAUDE_TRACKER_DIR;
  return { args, env };
}

function run(cmd, ...args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.stdout || err.message) };
  }
}

const SERVICES = {
  darwin: {
    // --- launchd ---------------------------------------------------------------
    file: path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    target: () => `gui/${process.getuid()}`,

    install(port) {
      const { args, env } = command(port);
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      run('launchctl', 'bootout', `${this.target()}/${LABEL}`);   // replace any earlier version
      fs.writeFileSync(this.file, plist);
      const r = run('launchctl', 'bootstrap', this.target(), this.file);
      if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out.trim()}`);
    },

    uninstall() {
      const r = run('launchctl', 'bootout', `${this.target()}/${LABEL}`);
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      return r.ok;
    },

    status() {
      const r = run('launchctl', 'print', `${this.target()}/${LABEL}`);
      const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
      return { loaded: r.ok, state: /\bstate = (\w+)/.exec(r.out)?.[1] ?? null, pid: pid ? Number(pid) : null };
    },
  },

  linux: {
    // --- systemd -------------------------------------------------------------
    // A user unit starts with the user's systemd instance: at login, or at boot
    // when lingering is on, which also keeps it running after the last logout.
    file: path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user', 'claude-tracker.service'),

    install(port) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, unitFile(command(port)));
      for (const args of [['daemon-reload'], ['enable', 'claude-tracker.service'], ['restart', 'claude-tracker.service']]) {
        const r = run('systemctl', '--user', ...args);
        if (!r.ok) throw new Error(`systemctl --user ${args[0]} failed: ${r.out.trim()}`);
      }
    },

    uninstall() {
      const r = run('systemctl', '--user', 'disable', '--now', 'claude-tracker.service');
      if (fs.existsSync(this.file)) { fs.unlinkSync(this.file); run('systemctl', '--user', 'daemon-reload'); }
      return r.ok;
    },

    status() {
      const r = run('systemctl', '--user', 'show', 'claude-tracker.service', '-p', 'LoadState', '-p', 'SubState', '-p', 'MainPID');
      const p = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s)));
      const pid = Number(p.MainPID) || null;
      return { loaded: r.ok && p.LoadState === 'loaded', state: p.SubState ?? null, pid };
    },
  },
};

/**
 * The systemd unit for a command. `%` is doubled everywhere, `$` in the command,
 * and the command and environment are quoted, so a path with spaces, specifier
 * or variable characters reaches the process unchanged. Paths in other
 * settings are taken as-is.
 */
export function unitFile({ args, env }) {
  const pct = (s) => String(s).replace(/%/g, '%%');
  const q = (s) => `"${pct(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=claude-tracker - Claude usage and rate-limit dashboard

[Service]
ExecStart=${args.map((a) => q(a).replace(/\$/g, '$$$$')).join(' ')}
WorkingDirectory=${pct(REPO_DIR)}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=10
StandardOutput=append:${pct(LOG)}
StandardError=append:${pct(LOG)}

[Install]
WantedBy=default.target
`;
}

function service() {
  const s = SERVICES[process.platform];
  if (!s) throw new Error('The login service needs launchd (macOS) or systemd (Linux).');
  return s;
}

export function installService({ port = 4785 } = {}) {
  const s = service();
  ensureDataDir();
  s.install(port);
  return { file: s.file, log: LOG, url: `http://127.0.0.1:${port}` };
}

export function uninstallService() {
  const s = service();
  const had = fs.existsSync(s.file);
  return { removed: s.uninstall() || had };
}

export function serviceStatus() {
  const s = service();
  return { installed: fs.existsSync(s.file), ...s.status(), file: s.file, log: LOG };
}
