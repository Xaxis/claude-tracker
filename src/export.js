import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { HOME, tildify, configFileOf, discoverProfiles } from './paths.js';
import { overview, profileStates } from './api.js';
import { spares, SPARE_PREFIX } from './failover.js';
import { machine, remoteMachines } from './replica.js';

/**
 * Every account as a spreadsheet, for Google Sheets or anything that opens a
 * CSV: who it is, its plan and dates, where it is signed in, how much of it is
 * left. Claude Code is never told a payment card or a phone number, so those
 * columns are there to fill in by hand.
 */

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-CA') : '');
const minute = (ms) => (ms ? `${day(ms)} ${new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');

function planName(tier, orgType, seat) {
  const max = /max_(\d+)x/.exec(tier ?? '');
  if (max) return `Max ${max[1]}x`;
  if (orgType === 'claude_team' || /raven/.test(tier ?? '')) return seat === 'team_premium' ? 'Team (premium seat)' : 'Team (standard seat)';
  if (orgType === 'claude_enterprise') return 'Enterprise';
  if (/pro/.test(tier ?? '') || orgType === 'claude_pro') return 'Pro';
  return tier ?? '';
}

/** What each account's own sign-in says about it, from every profile and spare on this machine. */
function signinDetails() {
  const out = new Map();
  for (const p of discoverProfiles()) {
    const a = readJson(p.configFile ?? configFileOf(p.dir))?.oauthAccount;
    if (a?.accountUuid && !out.has(a.accountUuid)) out.set(a.accountUuid, a);
  }
  return out;
}

/** Where each account is signed in: this machine's profiles and spares, and each synced machine's main profile. */
function whereSignedIn() {
  const out = new Map();
  const add = (acct, where) => { if (acct) out.set(acct, [...(out.get(acct) ?? []), where]); };
  const here = machine().name;
  for (const p of profileStates()) add(p.accountUuid, `${here} ${p.dir}`);
  for (const s of spares()) add(s.accountUuid, `${here} spare`);
  for (const m of remoteMachines()) {
    for (const p of m.profiles ?? []) if (!String(p.dir ?? '').includes(SPARE_PREFIX)) add(p.accountUuid, `${m.name} ${p.dir}`);
  }
  return out;
}

export const COLUMNS = [
  'Email', 'Name', 'Phone number', 'Payment card', 'Plan', 'Organization', 'Billing',
  'Account created', 'Subscribed since', 'Renews', 'Signed in on',
  '5-hour used', 'Weekly used', 'Available', 'Last used', 'Notes', 'Account ID',
];

export function accountRows(ov = overview(), now = Date.now()) {
  const d = db();
  const stored = new Map(d.prepare('SELECT * FROM accounts').all().map((r) => [r.account_uuid, r]));
  const lastUsed = new Map(d.prepare('SELECT account_uuid, MAX(ts) last FROM events WHERE account_uuid IS NOT NULL GROUP BY account_uuid').all().map((r) => [r.account_uuid, r.last]));
  const own = signinDetails();
  const where = whereSignedIn();
  return ov.accounts
    .filter((a) => a.email)
    .map((a) => {
      const s = stored.get(a.accountUuid) ?? {};
      const o = own.get(a.accountUuid) ?? {};
      const used = (type) => {
        const l = a.limits.find((x) => x.type === type);
        return l ? `${Math.round(l.active ? l.percent : 0)}%` : '';
      };
      const created = Date.parse(o.accountCreatedAt ?? '') || null;
      const subscribed = Date.parse(s.subscription_at ?? o.subscriptionCreatedAt ?? '') || null;
      return {
        'Email': a.email,
        'Name': o.fullName ?? s.display_name ?? '',
        'Phone number': '',
        'Payment card': '',
        'Plan': planName(s.rate_limit_tier ?? o.organizationRateLimitTier, o.organizationType, o.seatTier),
        // A personal plan's organization is just "<email>'s Organization": only a real one is worth a column.
        'Organization': s.org_name && !/'s Organization$/.test(s.org_name) ? s.org_name : '',
        'Billing': s.billing_type === 'stripe_subscription' ? 'Card subscription (Stripe)' : (s.billing_type ?? '').replace(/_/g, ' '),
        'Account created': day(created),
        'Subscribed since': day(subscribed),
        'Renews': a.billing ? day(a.billing.end) : '',
        'Signed in on': (where.get(a.accountUuid) ?? []).join('; '),
        '5-hour used': used('five_hour'),
        'Weekly used': used('seven_day'),
        'Available': a.available.now ? 'now' : a.available.at ? minute(a.available.at) : 'out',
        'Last used': minute(lastUsed.get(a.accountUuid)),
        'Notes': '',
        'Account ID': a.accountUuid,
        _sort: subscribed ?? created ?? now,
      };
    })
    .sort((x, y) => x._sort - y._sort);
}

/** A cell as CSV: quoted when it must be, and never read by a spreadsheet as a formula. */
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function accountsCsv(rows = accountRows()) {
  return [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))].map((line) => line.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function exportFileName(now = Date.now()) {
  return `claude-accounts-${day(now)}.csv`;
}

/** Write the spreadsheet; by default into Downloads, where a browser upload looks first. */
export function exportAccounts(file) {
  const downloads = path.join(HOME, 'Downloads');
  const target = path.resolve(file ?? path.join(fs.existsSync(downloads) ? downloads : HOME, exportFileName()));
  const rows = accountRows();
  fs.writeFileSync(target, accountsCsv(rows));
  return { file: target, shown: tildify(target), count: rows.length };
}
