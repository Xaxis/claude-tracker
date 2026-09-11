#!/usr/bin/env node
// Claude Code status line for claude-tracker.
//
// Claude Code hands every status-line command the exact plan utilization it
// holds for this session - the server's own numbers, not an estimate. This
// records them for the tracker and prints a compact summary. It must never
// break the status line, so every failure is swallowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, configFileOf } from '../src/paths.js';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
let d = {};
try { d = JSON.parse(raw); } catch { /* print nothing useful, but don't fail */ }

const configDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const limits = d.rate_limits || {};

// Who this session is running as: interactive sessions (the only ones with a
// status line) follow their profile's current login.
let who = null, whoId = null;
try {
  const cfg = configFileOf(configDir);
  const acct = cfg ? JSON.parse(fs.readFileSync(cfg, 'utf8')).oauthAccount : null;
  who = acct?.emailAddress ?? null; whoId = acct?.accountUuid ?? null;
} catch { /* unnamed */ }

if (d.session_id) {
  try {
    const dir = path.join(DATA_DIR, 'live');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      ts: Date.now(), session_id: d.session_id, config_dir: configDir,
      cwd: d.cwd ?? d.workspace?.current_dir ?? null, model: d.model?.id ?? null,
      subscription_type: d.subscription_type ?? null,
      rate_limits_available: d.rate_limits_available ?? null, rate_limits: limits,
      account_uuid: whoId, email: who,
    };
    // Write-then-rename, so the tracker never reads a half-written snapshot.
    const tmp = path.join(dir, `.${d.session_id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, path.join(dir, `${d.session_id}.json`));
  } catch { /* the tracker is optional; the status line is not */ }
}

// --- what the status line shows -------------------------------------------
const resetMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const until = (ms) => {
  if (ms == null) return '';
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d`;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return `${m}m`;
};
// Colour unless asked for none (https://no-color.org).
const PLAIN = !!process.env.NO_COLOR;
const color = (pct) => (PLAIN ? '' : pct >= 90 ? '\x1b[31m' : pct >= 70 ? '\x1b[33m' : '\x1b[32m');
const DIM = PLAIN ? '' : '\x1b[2m', RESET = PLAIN ? '' : '\x1b[0m';

const parts = [];
if (who) parts.push(`${DIM}${who.split('@')[0]}${RESET}`);
for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d'], ['spend_limit', 'spend']]) {
  const l = limits[key];
  if (!l || typeof l.used_percentage !== 'number') continue;
  const r = until(resetMs(l.resets_at));
  parts.push(`${label} ${color(l.used_percentage)}${Math.round(l.used_percentage)}%${RESET}${r ? `${DIM} ${r}${RESET}` : ''}`);
}
process.stdout.write(parts.join(`${DIM} · ${RESET}`));
