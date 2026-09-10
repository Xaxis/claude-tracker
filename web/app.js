/* Claude Tracker dashboard.
   Plain modules, no build step, no network beyond this local server. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4',
                '--series-5', '--series-6', '--series-7', '--series-8'];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* --- formatting ----------------------------------------------------------- */

const money = (n) => {
  if (n == null) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
};

const compact = (n) => {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

/** "3h 12m" / "6d 4h" / "just now" - the reset countdown's voice. */
function duration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayOf = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });

/**
 * Severity band for a fill percentage. The band drives colour AND the word shown
 * beside it - status colour never carries the meaning on its own.
 */
function severity(pct, blocked) {
  if (blocked) return { key: 'critical', word: 'limit reached' };
  if (pct >= 95) return { key: 'critical', word: 'nearly out' };
  if (pct >= 80) return { key: 'serious', word: 'running low' };
  if (pct >= 60) return { key: 'warning', word: 'over half' };
  return { key: 'accent', word: 'plenty left' };
}

/* --- tooltip -------------------------------------------------------------- */

const tip = $('#tooltip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add('show');
  tip.setAttribute('aria-hidden', 'false');
  const r = tip.getBoundingClientRect();
  // Keep the tooltip on screen near the right/bottom edges.
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
  const top = Math.min(Math.max(8, y + 14), window.innerHeight - r.height - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTip() {
  tip.classList.remove('show');
  tip.setAttribute('aria-hidden', 'true');
}

/* --- meter ---------------------------------------------------------------- */

function meter({ label, percent, blocked, foot }) {
  const sev = severity(percent, blocked);
  const wrap = el('div', `meter is-${sev.key}`);

  const top = el('div', 'meter-top');
  top.append(el('span', 'meter-name', label));
  top.append(el('span', 'meter-value', `${Math.round(percent)}%`));
  wrap.append(top);

  const track = el('div', 'meter-track');
  const fill = el('span', 'meter-fill');
  fill.style.width = `${Math.max(percent > 0 ? 2 : 0, Math.min(100, percent))}%`;
  track.append(fill);
  wrap.append(track);

  const f = el('div', 'meter-foot');
  f.append(el('span', null, sev.word));
  f.append(el('span', null, foot ?? ''));
  wrap.append(f);
  return wrap;
}

/* --- state ---------------------------------------------------------------- */

const state = {
  overview: null,
  days: 30,
  account: 'all',
  windowType: 'five_hour',
  showTable: false,
};

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/* --- accounts ------------------------------------------------------------- */

function renderAccounts(data) {
  const host = $('#accounts');
  host.textContent = '';

  if (!data.accounts.length) {
    host.append(el('p', 'empty', 'No accounts discovered yet.'));
    return;
  }

  for (const a of data.accounts) {
    const card = el('div', `account${a.isCurrent ? ' is-current' : ''}`);

    const head = el('div', 'account-head');
    const idBox = el('div', 'row-main');
    idBox.append(el('div', 'account-name', a.label));
    const meta = [];
    if (a.tier) meta.push(a.tier.replace('default_claude_', '').replace(/_/g, ' '));
    meta.push(`${a.sessions} sessions`);
    meta.push(`${money(a.totalCost)} tracked`);
    idBox.append(el('div', 'account-meta', meta.join(' · ')));
    head.append(idBox);

    if (a.isCurrent) head.append(el('span', 'pill now', 'signed in'));
    else if (a.limits.some((l) => l.blocked)) head.append(el('span', 'pill blocked', 'limited'));
    card.append(head);

    for (const l of a.limits) {
      const foot = l.blocked || l.active
        ? `resets in ${duration(l.resetsInMs)}`
        : 'idle — next request opens a new window';
      const m = meter({ label: l.label, percent: l.percent, blocked: l.blocked, foot });
      m.dataset.resetAt = l.end ?? '';
      m.dataset.active = l.blocked || l.active ? '1' : '';
      card.append(m);

      if (l.exhaustsAt) {
        const warn = el('div', 'panel-note',
          `At the current rate this fills in ${duration(l.exhaustsAt - data.now)}.`);
        card.append(warn);
      }
      // Every unmeasured ceiling says so, on its own row - suppressing one to
      // reduce clutter would leave an estimate looking like a measurement.
      if (l.confidence !== 'measured') {
        const note = {
          partial: '≈ ceiling from one observed limit',
          tier: '≈ ceiling borrowed from a same-plan account',
          default: '≈ ceiling estimated, none observed yet',
        }[l.confidence] ?? '≈ ceiling estimated';
        const n = el('div', 'limit-note', note);
        n.title = `Used ${money(l.used)} of an estimated ${money(l.capacity)} this window.`;
        card.append(n);
      }
    }

    // Billing period: a projection, so it is labelled as one.
    if (a.billing) {
      const b = a.billing;
      const when = new Date(b.end).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const row = el('div', 'billing');
      const head = el('div', 'billing-head');
      head.append(el('span', null, 'Renews'));
      head.append(el('span', 'billing-when', `${when} · ${duration(b.renewsInMs)}`));
      row.append(head);

      const track = el('div', 'billing-track');
      const fill = el('span');
      fill.style.width = `${b.percentElapsed}%`;
      track.append(fill);
      row.append(track);

      row.append(el('div', 'panel-note',
        `${money(b.spend.cost)} used this period · ${b.assumption}`));
      row.title = `Subscription started ${new Date(b.subscriptionStart).toLocaleDateString()}`;
      card.append(row);
    }

    host.append(card);
  }

  const note = [];
  if (data.unattributed.events) {
    note.push(`${data.unattributed.events.toLocaleString()} events (${money(data.unattributed.cost)}) not tied to an account`);
  }
  $('#accounts-note').textContent = note.join(' · ');
}

/** The single number the page leads with: the tightest live limit anywhere. */
function renderHero(data) {
  let worst = null;
  for (const a of data.accounts) {
    for (const l of a.limits) {
      if (!l.active && !l.blocked) continue;
      if (!worst || l.percent > worst.limit.percent) worst = { account: a, limit: l };
    }
  }
  const hero = $('#hero');
  if (!worst) { hero.hidden = true; return; }
  hero.hidden = false;

  const { account, limit } = worst;
  const sev = severity(limit.percent, limit.blocked);
  $('#hero-label').textContent = `${limit.label} · ${account.label}`;
  $('#hero-figure').textContent = limit.blocked ? 'Limit reached' : `${Math.round(limit.percent)}% used`;

  const parts = [];
  parts.push(`Resets in ${duration(limit.resetsInMs)} (${limit.end ? timeOf(limit.end) : '—'}).`);
  if (limit.exhaustsAt) parts.push(`At the current burn it fills in ${duration(limit.exhaustsAt - data.now)}.`);
  else if (!limit.blocked) parts.push(sev.word[0].toUpperCase() + sev.word.slice(1) + '.');
  $('#hero-sub').textContent = parts.join(' ');

  const host = $('#hero-meter');
  host.textContent = '';
  host.append(meter({
    label: 'Window fill',
    percent: limit.percent,
    blocked: limit.blocked,
    foot: `${money(limit.used)} of ~${money(limit.capacity)}`,
  }));
  const m = host.firstChild;
  m.dataset.resetAt = limit.end ?? '';
  m.dataset.active = '1';
}

/* --- daily stacked columns ------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Round y-axis top to a clean number so ticks read 0 / 20 / 40. */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (v <= mag * step) return mag * step;
  }
  return mag * 10;
}

function renderDaily(rows) {
  const host = $('#daily-chart');
  host.textContent = '';
  if (!rows.length) { host.append(el('p', 'empty', 'No usage in this range.')); return; }

  // Rank models by total spend; keep the top 7 and fold the rest into Other so
  // categorical slots are never cycled.
  const totals = new Map();
  for (const r of rows) {
    for (const [m, c] of Object.entries(r.models)) totals.set(m, (totals.get(m) ?? 0) + c);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const keep = ranked.slice(0, 7);
  const useOther = ranked.length > 7;
  const names = useOther ? [...keep, 'Other'] : keep;
  const colorOf = (name) => name === 'Other' ? cssVar('--text-muted') : cssVar(SERIES[keep.indexOf(name) % SERIES.length]);

  const series = rows.map((r) => {
    const parts = {};
    for (const n of names) parts[n] = 0;
    for (const [m, c] of Object.entries(r.models)) {
      parts[keep.includes(m) ? m : 'Other'] = (parts[keep.includes(m) ? m : 'Other'] ?? 0) + c;
    }
    return { day: r.day, total: r.cost, events: r.events, tokens: r.tokens, parts };
  });

  const W = 900, H = 260;
  const pad = { top: 12, right: 12, bottom: 26, left: 46 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxY = niceMax(Math.max(...series.map((s) => s.total)));
  const band = plotW / series.length;
  const barW = Math.min(24, band * 0.7);
  const GAP = 2; // surface gap between stacked segments

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  // gridlines + y ticks
  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 4) * i;
    const y = pad.top + plotH - (v / maxY) * plotH;
    svg.append(svgEl('line', { class: 'gridline', x1: pad.left, x2: W - pad.right, y1: y, y2: y }));
    const t = svgEl('text', { class: 'axis-label', x: pad.left - 8, y: y + 4, 'text-anchor': 'end' });
    t.textContent = v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`;
    svg.append(t);
  }

  series.forEach((s, i) => {
    const x = pad.left + i * band + (band - barW) / 2;
    let cursor = pad.top + plotH;
    const stack = names.filter((n) => s.parts[n] > 0);

    stack.forEach((name, idx) => {
      const h = (s.parts[name] / maxY) * plotH;
      if (h <= 0) return;
      const isTop = idx === stack.length - 1;
      const drawH = Math.max(1, h - (idx === 0 ? 0 : GAP));
      const y = cursor - drawH;
      const rect = svgEl('rect', {
        x, y, width: barW, height: drawH,
        fill: colorOf(name),
        // 4px rounded data-end only on the topmost segment; square at baseline.
        rx: isTop ? 4 : 0,
      });
      if (isTop && drawH < 4) rect.setAttribute('rx', Math.max(0, drawH / 2));
      svg.append(rect);
      cursor -= h;
    });

    // Invisible full-height hit target: easier to hover than a thin segment.
    const hit = svgEl('rect', {
      x: pad.left + i * band, y: pad.top, width: band, height: plotH,
      fill: 'transparent', style: 'cursor:crosshair',
    });
    hit.addEventListener('mousemove', (ev) => {
      const lines = stack.slice().reverse().map((n) =>
        `<div class="tooltip-row"><span><span class="dot" style="background:${colorOf(n)}"></span> ${n}</span><span>${money(s.parts[n])}</span></div>`).join('');
      showTip(
        `<div class="tooltip-title">${dayOf(new Date(s.day + 'T00:00:00'))}</div>${lines}` +
        `<div class="tooltip-row" style="margin-top:4px"><span>Total</span><span>${money(s.total)}</span></div>` +
        `<div class="tooltip-row"><span>Calls</span><span>${compact(s.events)}</span></div>`,
        ev.clientX, ev.clientY,
      );
    });
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);

    // x labels: thin them out so they never collide.
    const every = Math.ceil(series.length / 10);
    if (i % every === 0) {
      const t = svgEl('text', {
        class: 'axis-label', x: pad.left + i * band + band / 2,
        y: H - 8, 'text-anchor': 'middle',
      });
      t.textContent = dayOf(new Date(s.day + 'T00:00:00'));
      svg.append(t);
    }
  });

  svg.append(svgEl('line', {
    class: 'baseline', x1: pad.left, x2: W - pad.right,
    y1: pad.top + plotH, y2: pad.top + plotH,
  }));

  host.append(svg);

  // Legend is always present for two or more series.
  const legend = $('#daily-legend');
  legend.textContent = '';
  if (names.length >= 2) {
    for (const n of names) {
      const item = el('span', 'legend-item');
      const sw = el('span', 'legend-swatch');
      sw.style.background = colorOf(n);
      item.append(sw, document.createTextNode(n));
      legend.append(item);
    }
  }

  renderDailyTable(series, names);
}

function renderDailyTable(series, names) {
  const host = $('#daily-table');
  host.textContent = '';
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', null, 'Day'));
  for (const n of names) hr.append(el('th', null, n));
  hr.append(el('th', null, 'Total'));
  hr.append(el('th', null, 'Calls'));
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const s of [...series].reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, s.day));
    for (const n of names) tr.append(el('td', null, s.parts[n] ? money(s.parts[n]) : '—'));
    tr.append(el('td', null, money(s.total)));
    tr.append(el('td', null, s.events.toLocaleString()));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

/* --- window history ------------------------------------------------------- */

function renderWindows(rows) {
  const host = $('#window-chart');
  host.textContent = '';
  if (!rows.length) { host.append(el('p', 'empty', 'No windows recorded yet.')); return; }

  const data = [...rows].reverse(); // oldest first
  const W = 460, H = 190;
  const pad = { top: 14, right: 10, bottom: 24, left: 34 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, band * 0.65);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  for (const v of [0, 50, 100]) {
    const y = pad.top + plotH - (v / 100) * plotH;
    svg.append(svgEl('line', { class: 'gridline', x1: pad.left, x2: W - pad.right, y1: y, y2: y }));
    const t = svgEl('text', { class: 'axis-label', x: pad.left - 6, y: y + 4, 'text-anchor': 'end' });
    t.textContent = `${v}%`;
    svg.append(t);
  }

  data.forEach((w, i) => {
    const pct = Math.min(100, w.percent);
    const h = Math.max(1, (pct / 100) * plotH);
    const x = pad.left + i * band + (band - barW) / 2;
    const y = pad.top + plotH - h;
    const sev = severity(pct, false);
    const fill = sev.key === 'accent' ? cssVar('--series-1') : cssVar(`--${sev.key}`);
    const rect = svgEl('rect', { x, y, width: barW, height: h, fill, rx: Math.min(4, h / 2) });
    rect.addEventListener('mousemove', (ev) => showTip(
      `<div class="tooltip-title">${dayOf(w.start)} ${timeOf(w.start)}</div>` +
      `<div class="tooltip-row"><span>Used</span><span>${Math.round(w.percent)}%</span></div>` +
      `<div class="tooltip-row"><span>Spend</span><span>${money(w.cost)}</span></div>` +
      `<div class="tooltip-row"><span>Calls</span><span>${compact(w.events)}</span></div>`,
      ev.clientX, ev.clientY,
    ));
    rect.addEventListener('mouseleave', hideTip);
    svg.append(rect);
  });

  svg.append(svgEl('line', {
    class: 'baseline', x1: pad.left, x2: W - pad.right,
    y1: pad.top + plotH, y2: pad.top + plotH,
  }));
  host.append(svg);
}

/* --- model breakdown ------------------------------------------------------ */

function renderModels(rows) {
  const host = $('#model-list');
  host.textContent = '';
  if (!rows.length) { host.append(el('p', 'empty', 'No usage in this range.')); return; }
  const total = rows.reduce((a, r) => a + r.cost, 0) || 1;

  rows.slice(0, 8).forEach((r, i) => {
    const share = (r.cost / total) * 100;
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    const title = el('div', 'row-title');
    const dot = el('span', 'dot');
    dot.style.background = cssVar(SERIES[i % SERIES.length]);
    title.append(dot, document.createTextNode(' ' + r.label));
    main.append(title);
    main.append(el('div', 'row-sub',
      `${compact(r.events)} calls · ${compact(r.output)} out · ${compact(r.cache_read)} cached in`));
    row.append(main);
    // Sub-1% shares would otherwise all render as a flat "0%".
    const shareText = share > 0 && share < 1 ? '<1%' : `${share.toFixed(0)}%`;
    row.append(el('div', 'row-value', `${money(r.cost)}  ${shareText}`));

    const bar = el('div', 'row-bar');
    const span = el('span');
    span.style.width = `${share}%`;
    span.style.background = cssVar(SERIES[i % SERIES.length]);
    bar.append(span);
    row.append(bar);
    host.append(row);
  });
}

/* --- sessions ------------------------------------------------------------- */

function renderLive(rows) {
  const host = $('#live-sessions');
  host.textContent = '';
  $('#live-count').textContent = rows.length ? `${rows.length} active` : '';
  if (!rows.length) { host.append(el('p', 'empty', 'No Claude Code sessions running.')); return; }
  for (const s of rows) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', s.name || s.sessionId.slice(0, 8)));
    main.append(el('div', 'row-sub', `${s.cwd ?? ''} · pid ${s.pid}`));
    row.append(main);
    row.append(el('div', 'row-value', s.status ?? ''));
    host.append(row);
  }
}

function renderSessions(rows, accounts) {
  const host = $('#sessions');
  host.textContent = '';
  if (!rows.length) { host.append(el('p', 'empty', 'No sessions yet.')); return; }
  const nameOf = new Map(accounts.map((a) => [a.accountUuid, a.label]));
  for (const s of rows.slice(0, 12)) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', s.project || s.cwd || s.session_id.slice(0, 8)));
    const who = s.account_uuid ? (nameOf.get(s.account_uuid) ?? s.account_uuid.slice(0, 8)) : 'unattributed';
    main.append(el('div', 'row-sub',
      `${dayOf(s.last_ts)} ${timeOf(s.last_ts)} · ${who}${s.git_branch ? ' · ' + s.git_branch : ''}`));
    row.append(main);
    row.append(el('div', 'row-value', `${money(s.cost)}`));
    host.append(row);
  }
}

/* --- countdown ------------------------------------------------------------ */

/** Tick every reset countdown without refetching. */
setInterval(() => {
  const now = Date.now();
  for (const m of document.querySelectorAll('.meter[data-active="1"]')) {
    const end = Number(m.dataset.resetAt);
    if (!end) continue;
    const foot = m.querySelector('.meter-foot span:last-child');
    if (foot && foot.textContent.startsWith('resets in')) {
      foot.textContent = `resets in ${duration(end - now)}`;
    }
  }
}, 1000);

/* --- load ----------------------------------------------------------------- */

async function loadAll() {
  const ov = await getJson('/api/overview');
  state.overview = ov;
  renderHero(ov);
  renderAccounts(ov);

  // Keep the account filter in sync with what we know about.
  const sel = $('#filter-account');
  const want = ['all', ...ov.accounts.map((a) => a.accountUuid)].join(',');
  if (sel.dataset.keys !== want) {
    sel.dataset.keys = want;
    const prev = state.account;
    sel.textContent = '';
    sel.append(new Option('All accounts', 'all'));
    for (const a of ov.accounts) sel.append(new Option(a.label, a.accountUuid));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';
    state.account = sel.value;
  }

  const acct = state.account === 'all' ? '' : `&account=${encodeURIComponent(state.account)}`;
  const [daily, models, live, sess] = await Promise.all([
    getJson(`/api/history?days=${state.days}${acct}`),
    getJson(`/api/models?days=${state.days}${acct}`),
    getJson('/api/live'),
    getJson(`/api/sessions?limit=40${acct}`),
  ]);

  renderDaily(daily);
  renderModels(models);
  renderLive(live);
  renderSessions(sess, ov.accounts);
  await loadWindows();

  $('#foot-note').textContent =
    `Updated ${new Date().toLocaleTimeString()} · reading local transcripts only, nothing leaves this machine.`;
}

/**
 * The window chart is per-account, so "All accounts" has to pick one. Choosing
 * the busiest rather than the signed-in one keeps the chart useful: a freshly
 * added account has only a single window to show.
 */
function windowChartAccount(ov) {
  if (state.account !== 'all') return ov.accounts.find((a) => a.accountUuid === state.account) ?? ov.accounts[0];
  return [...ov.accounts].sort((a, b) => b.totalEvents - a.totalEvents)[0];
}

async function loadWindows() {
  const ov = state.overview;
  if (!ov?.accounts.length) return;
  const acct = windowChartAccount(ov);
  $('#window-for').textContent = acct.label;
  const rows = await getJson(`/api/windows?account=${encodeURIComponent(acct.accountUuid)}&type=${state.windowType}&count=14`);
  renderWindows(rows);
}

/* --- wiring --------------------------------------------------------------- */

$('#filter-account').addEventListener('change', (e) => { state.account = e.target.value; loadAll(); });
$('#filter-days').addEventListener('change', (e) => { state.days = Number(e.target.value); loadAll(); });
$('#window-type').addEventListener('change', (e) => { state.windowType = e.target.value; loadWindows(); });
$('#toggle-table').addEventListener('click', (e) => {
  state.showTable = !state.showTable;
  $('#daily-table').hidden = !state.showTable;
  e.currentTarget.setAttribute('aria-pressed', String(state.showTable));
});

// Theme: auto → light → dark, remembered per browser.
const THEMES = ['auto', 'light', 'dark'];
let themeIdx = Math.max(0, THEMES.indexOf(localStorage.getItem('ct-theme') || 'auto'));
function applyTheme() {
  const t = THEMES[themeIdx];
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $('#theme-label').textContent = t[0].toUpperCase() + t.slice(1);
  try { localStorage.setItem('ct-theme', t); } catch { /* private mode */ }
}
$('#theme-toggle').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  applyTheme();
  if (state.overview) loadAll();  // charts bake in resolved colours
});
applyTheme();

// Live updates pushed by the watcher.
function connect() {
  const es = new EventSource('/events');
  const label = $('#live-label');
  const box = $('#live-state');
  es.onopen = () => { box.className = 'live on'; label.textContent = 'live'; };
  es.addEventListener('update', () => { loadAll().catch(() => {}); });
  es.onerror = () => {
    box.className = 'live off';
    label.textContent = 'reconnecting…';
    // EventSource retries on its own; nothing to do but reflect the state.
  };
}

loadAll().then(connect).catch((err) => {
  document.querySelector('main').prepend(
    Object.assign(el('p', 'empty'), { textContent: `Could not load data: ${err.message}` }));
});
