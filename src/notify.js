import { execFile } from 'node:child_process';
import { db, getMeta, setMeta } from './db.js';

/**
 * Desktop notifications for the moments that matter: a window getting close, a
 * limit actually hit, and a refused account coming back.
 *
 * Only trustworthy readings alert - exact status-line numbers, ceilings
 * measured from two or more refusals, or the API's own refusals - so an
 * estimate never cries wolf. Every alert is claimed in the database before it
 * is sent, so several tracker processes running at once never send it twice.
 * The first run records what is already true without announcing it.
 */
const THRESHOLDS = [80, 95];
const LABELS = {
  five_hour: 'Session (5h)', seven_day: 'Weekly (7d)', seven_day_opus: 'Weekly Opus (7d)',
  seven_day_sonnet: 'Weekly Sonnet (7d)', spend_limit: 'Spend limit',
};

function claim(key) {
  try { return db().prepare('INSERT OR IGNORE INTO notifications (key, ts) VALUES (?, ?)').run(key, Date.now()).changes > 0; }
  catch { return false; }
}

function send(title, message) {
  if (process.platform !== 'darwin' || process.env.CLAUDE_TRACKER_NOTIFY === '0') return;
  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${q(message)}" with title "${q(title)}"`], () => {});
}

const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
};

/** Work out what is newsworthy in an overview, and announce each thing once. */
export function notify(ov, now = Date.now()) {
  const baseline = !getMeta('notify_baseline');
  const out = [];
  const emit = (key, title, message) => {
    if (!claim(key)) return;
    if (!baseline) { send(title, message); out.push({ title, message }); }
  };
  const rec = ov.recommendation;
  const hint = (acct) => (rec && rec.accountUuid !== acct
    ? ` Best now: ${rec.label}${rec.command ? ` - ${rec.command}` : ''}.` : '');

  for (const a of ov.accounts) {
    for (const l of a.limits) {
      const win = `${a.accountUuid}|${l.type}|${l.end ?? 'open'}`;
      if (l.blocked) {
        emit(`hit|${win}`, 'Claude limit reached', `${a.label}: ${l.label} is full, resets in ${dur(l.resetsInMs ?? 0)}.${hint(a.accountUuid)}`);
        continue;
      }
      if (!l.active || !(l.confidence === 'exact' || l.confidence === 'measured')) continue;
      for (const th of THRESHOLDS) {
        if (l.percent >= th) {
          emit(`at${th}|${win}`, `Claude ${l.label} at ${Math.round(l.percent)}%`,
            `${a.label} - resets in ${dur(l.resetsInMs ?? 0)}.${th >= 95 ? hint(a.accountUuid) : ''}`);
        }
      }
    }
  }

  // Refusals whose reset passed within the last hour: that account is usable again.
  for (const r of db().prepare(`SELECT l.limit_type t, l.resets_at r, l.account_uuid a, COALESCE(x.label, x.email) name
      FROM limit_events l LEFT JOIN accounts x ON x.account_uuid = l.account_uuid
      WHERE l.status = 'rejected' AND l.resets_at * 1000 <= ? AND l.resets_at * 1000 > ?
      GROUP BY 1, 2, 3`).all(now, now - 3600e3)) {
    emit(`reset|${r.a}|${r.t}|${r.r}`, 'Claude limit reset', `${r.name ?? 'An account'} is available again - ${LABELS[r.t] ?? r.t} reset.`);
  }

  if (baseline) setMeta('notify_baseline', String(now));
  return out;
}
