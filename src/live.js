import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, configFileOf } from './paths.js';
import { db, tx } from './db.js';

/**
 * Exact utilization, from the status line.
 *
 * bin/statusline.js drops a snapshot for each session into DATA_DIR/live on
 * every render, carrying the server's own utilization for the account that
 * session is using. They become rows in `utilization` - one per change, not per
 * render - tagged with that account.
 */
export const LIVE_DIR = path.join(DATA_DIR, 'live');
const KEEP_MS = 24 * 3600e3;
const IDLE_MS = 2 * 60_000;

const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Which account a snapshot speaks for, if the snapshot didn't say. */
function accountFor(d, rec) {
  // The session's own signed-in record, then the account its latest call billed.
  const ctx = d.prepare(`SELECT p.account_uuid a, p.email e FROM identity_points p
     WHERE p.session_id = ? AND p.ts <= ? AND p.source = 'context' ORDER BY p.ts DESC LIMIT 1`).get(rec.session_id, rec.ts);
  if (ctx?.a) return ctx.a;
  if (ctx?.e) {
    const r = d.prepare('SELECT account_uuid a FROM accounts WHERE LOWER(email) = ?').get(ctx.e.toLowerCase());
    if (r) return r.a;
  }
  const call = d.prepare(`SELECT account_uuid a FROM events WHERE session_id = ? AND ts <= ?
     AND account_uuid IS NOT NULL ORDER BY ts DESC LIMIT 1`).get(rec.session_id, rec.ts);
  if (call) return call.a;
  try {
    const cfg = configFileOf(rec.config_dir);
    return cfg ? JSON.parse(fs.readFileSync(cfg, 'utf8')).oauthAccount?.accountUuid ?? null : null;
  } catch { return null; }
}

export function ingestLive() {
  let names = [];
  try { names = fs.readdirSync(LIVE_DIR).filter((n) => n.endsWith('.json') && !n.startsWith('.')); } catch { return { samples: 0 }; }
  const d = db();
  const last = d.prepare('SELECT pct, resets_at FROM utilization WHERE session_id = ? AND limit_type = ? ORDER BY ts DESC LIMIT 1');
  const lastCall = d.prepare('SELECT MAX(ts) t FROM events WHERE session_id = ?');
  const ins = d.prepare(`INSERT OR IGNORE INTO utilization (ts, session_id, config_dir, account_uuid, limit_type, pct, resets_at)
                         VALUES (?,?,?,?,?,?,?)`);
  const now = Date.now();
  let samples = 0, oldest = null;
  tx(() => {
    for (const n of names) {
      const file = path.join(LIVE_DIR, n);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!rec?.session_id || !rec.ts) continue;
      if (now - rec.ts > KEEP_MS) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
      // The status line repeats the last response's numbers on every render, so
      // an idle session's reading is only as new as its last call.
      const lc = lastCall.get(rec.session_id)?.t;
      const at = lc != null && rec.ts - lc > IDLE_MS ? lc : rec.ts;
      let acct;
      for (const [type, l] of Object.entries(rec.rate_limits ?? {})) {
        if (typeof l?.used_percentage !== 'number') continue;
        const resets = toMs(l.resets_at);
        const prev = last.get(rec.session_id, type);
        if (prev && Math.abs(prev.pct - l.used_percentage) < 0.05 && prev.resets_at === resets) continue;
        acct ??= rec.account_uuid ?? accountFor(d, rec);
        if (ins.run(at, rec.session_id, rec.config_dir ?? null, acct, type, l.used_percentage, resets).changes) {
          samples++;
          oldest = Math.min(oldest ?? Infinity, at);
        }
      }
    }
  });
  return { samples, oldest };
}
