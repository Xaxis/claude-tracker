/**
 * Subscription renewal dates.
 *
 * Claude stores when each subscription started (`subscriptionCreatedAt`) but
 * never says when it next renews. For a monthly plan the renewal is the same
 * day-of-month as the start, so the cycle can be projected forward from it.
 *
 * That projection is an inference, and it is wrong in cases we cannot see from
 * here: an annual plan renews yearly, and a plan that was cancelled, paused, or
 * switched has a different anchor than the one on disk. So the dashboards label
 * these as estimated, and `assumption` says exactly what was assumed.
 */

const DAY = 86400000;

/**
 * Add `n` months to a date, keeping the day-of-month where possible.
 * Billing on the 31st lands on the last day of a shorter month, which is what
 * subscription billing does rather than skipping the month.
 */
function addMonths(date, n) {
  const y = date.getFullYear();
  const m = date.getMonth() + n;
  const target = new Date(y, m, 1, date.getHours(), date.getMinutes(), date.getSeconds());
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/**
 * Project the current billing period from a subscription start date.
 * @param {string|number|null} startedAt ISO string or epoch ms
 * @param {'month'|'year'} cycle
 * @param {number} now
 */
export function billingPeriod(startedAt, cycle = 'month', now = Date.now()) {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;

  const step = cycle === 'year' ? 12 : 1;
  let periodStart = start;
  let periodEnd = addMonths(start, step);

  if (periodEnd.getTime() <= now) {
    // Jump most of the way in one go rather than looping month by month.
    const approx = cycle === 'year' ? 365 : 30.44;
    let guess = Math.max(0, Math.floor((now - start.getTime()) / (approx * DAY)) - 1);
    guess -= guess % step;
    periodStart = addMonths(start, guess);
    periodEnd = addMonths(start, guess + step);
    while (periodEnd.getTime() <= now) {
      guess += step;
      periodStart = addMonths(start, guess);
      periodEnd = addMonths(start, guess + step);
    }
  }

  const total = periodEnd.getTime() - periodStart.getTime();
  const elapsed = now - periodStart.getTime();
  return {
    start: periodStart.getTime(),
    end: periodEnd.getTime(),
    renewsInMs: Math.max(0, periodEnd.getTime() - now),
    percentElapsed: total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0,
    cycle,
    subscriptionStart: start.getTime(),
    assumption: cycle === 'year'
      ? 'annual cycle, projected from the subscription start date'
      : 'monthly cycle, projected from the subscription start date',
    estimated: true,
  };
}

/** Spend inside the current billing period, in quota units. */
export function periodSpend(db, accountUuid, period) {
  if (!period) return { cost: 0, events: 0 };
  const row = db.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(e.cost_usd), 0) AS cost
      FROM events e JOIN sessions s ON s.session_id = e.session_id
     WHERE s.account_uuid = ? AND e.ts >= ? AND e.ts <= ?`)
    .get(accountUuid, period.start, period.end);
  return { cost: row.cost, events: row.events };
}
