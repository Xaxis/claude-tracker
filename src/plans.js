import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

/**
 * What each subscription costs, to set beside what its use would have cost at
 * API prices.
 *
 * Claude Code says which plan an account is on (its rate-limit tier) but never
 * what the owner pays for it. The list price stands in, and the owner can say
 * otherwise per account: a price in another currency or with tax, a discount,
 * a seat an employer pays for (0). An account whose plan has no list price (an
 * organization's seat) has no price until the owner gives one.
 */

const LIST = [
  { match: /max_20x/, usd: 200, plan: 'Max 20x' },
  { match: /max_5x/, usd: 100, plan: 'Max 5x' },
  { match: /(?:^|_)pro(?:_|$)/, usd: 20, plan: 'Pro' },
];

const DAY = 86400e3;
// A subscription the tracker has not seen for longer than a billing period may have ended.
const GONE = 35 * DAY;

const FILE = () => path.join(DATA_DIR, 'plan-prices.json');
let cached = null;
function owned() {
  if (cached) return cached;
  try { cached = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { cached = {}; }
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) cached = {};
  return cached;
}

/**
 * An account's monthly price: {usd, plan, source}, source 'owner' when the owner
 * set it, 'list' for the plan's list price, null when nothing says.
 */
export function planPrice(account) {
  const listed = LIST.find((l) => l.match.test(String(account.rate_limit_tier ?? account.tier ?? '')));
  const mine = owned()[account.account_uuid ?? account.accountUuid];
  if (typeof mine === 'number' && Number.isFinite(mine) && mine >= 0) return { usd: mine, plan: listed?.plan ?? null, source: 'owner' };
  return listed ? { usd: listed.usd, plan: listed.plan, source: 'list' } : { usd: null, plan: null, source: null };
}

/** Set what the owner pays for an account each month; null goes back to the list price. */
export function setPlanPrice(accountUuid, usd) {
  if (typeof accountUuid !== 'string' || !/^[\w-]{1,80}$/.test(accountUuid)) throw new Error('not an account');
  if (usd != null && !(typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd <= 100_000)) throw new Error('a monthly price is a number of dollars, 0 or more');
  const next = { ...owned() };
  if (usd == null) delete next[accountUuid]; else next[accountUuid] = Math.round(usd * 100) / 100;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, FILE());
  cached = next;
}

/** A monthly price spread over the days of a year. */
export const perDay = (usd) => (usd * 12) / 365.25;

/**
 * What the owner paid in subscriptions on the day starting at `dayStart`, for the
 * accounts given: each priced account from its subscription's start until a
 * billing period after the tracker last saw it.
 */
export function paidOn(accounts, dayStart) {
  let usd = 0;
  for (const a of accounts) {
    const p = planPrice(a);
    if (p.usd == null) continue;
    const from = a.subscription_at ? Date.parse(a.subscription_at) : a.first_seen;
    if (Number.isFinite(from) && from >= dayStart + DAY) continue;
    if (a.last_seen && a.last_seen + GONE < dayStart) continue;
    usd += perDay(p.usd);
  }
  return usd;
}

/** For tests. */
export function resetPlans() { cached = null; }
