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

/** Tokens as 507k or 1.2M. */
const tokens = (n) => (n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/**
 * Context bands, by what a turn re-reads: past 400k a turn costs over ten times
 * a fresh session's. The same bands as the terminal dashboard's.
 */
const contextBand = (n) => (n >= 800e3 ? 'critical' : n >= 600e3 ? 'serious' : n >= 400e3 ? 'warning' : 'accent');

/** How long a job has waited: amber, then orange past 5 minutes, red past 15. The terminal's bands. */
const waitBand = (ms) => (ms >= 15 * 60e3 ? 'critical' : ms >= 5 * 60e3 ? 'serious' : 'warning');

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

/** A meter. `plain` measures a share, not a limit, so it carries no severity. */
function meter({ label, percent, blocked, foot, plain = false }) {
  const sev = plain ? { key: 'accent', word: '' } : severity(percent, blocked);
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
  // Detail: what each session carries, the GPU and CPU pool, re-written caches.
  detail: localStorage.getItem('ct-detail') === '1',
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

/** A moment ahead as a clock time, with the day when it is not today. */
function clock(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  const opts = d.toDateString() === new Date().toDateString()
    ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString([], opts);
}

/**
 * Where each account is in use: signed into a machine's main profile, or
 * billing a session running there. Account -> machine names, null for this
 * machine and first. The same rule as the terminal dashboard's.
 */
function inUse(ov, live) {
  const out = new Map();
  const add = (acct, m) => {
    if (!acct) return;
    const list = out.get(acct) ?? [];
    if (!list.includes(m)) list.push(m);
    out.set(acct, list);
  };
  for (const p of ov.sync?.signedIn ?? []) add(p.accountUuid, p.machine);
  for (const x of live) add(x.accountUuid, x.machine ?? null);
  for (const list of out.values()) list.sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  return out;
}

function renderAccounts(data, live = []) {
  const host = $('#accounts');
  host.textContent = '';

  if (!data.accounts.length) {
    host.append(el('p', 'empty', 'No accounts discovered yet.'));
    return;
  }

  const using = inUse(data, live);
  const named = data.sync?.machines.length > 0;
  for (const a of data.accounts) {
    const where = using.get(a.accountUuid) ?? [];
    const card = el('div', `account${where.includes(null) ? ' is-current' : ''}`);

    const head = el('div', 'account-head');
    const idBox = el('div', 'row-main');
    idBox.append(el('div', 'account-name', a.label));
    const meta = [];
    if (a.tier) meta.push(a.tier.replace('default_claude_', '').replace(/_/g, ' '));
    meta.push(`${a.sessions} session${a.sessions === 1 ? '' : 's'}`);
    meta.push(`${money(a.totalCost)} tracked`);
    idBox.append(el('div', 'account-meta', meta.join(' · ')));
    head.append(idBox);

    // A pill for each machine it is in use on: green dot here, blue elsewhere.
    const pills = el('div', 'pills');
    for (const m of where) {
      const pill = el('span', `pill now ${m === null ? 'here' : 'elsewhere'}`);
      pill.append(el('span', 'dot', '●'), document.createTextNode(` ${named ? m ?? data.sync.name : 'in use'}`));
      pills.append(pill);
    }
    // An account that cannot take a request says when it can again.
    if (!a.available.now) {
      const out = el('span', 'pill blocked', `${a.available.sure ? '' : '≈ '}out until ${clock(a.available.at)}`);
      out.title = `${a.limits.find((l) => l.type === a.available.limit)?.label ?? 'A limit'} is full; usable again ${clock(a.available.at)}, in ${duration(a.available.at - data.now)}.`;
      pills.append(out);
    }
    if (pills.childNodes.length) head.append(pills);
    card.append(head);

    for (const l of a.limits) {
      const foot = l.blocked || l.active
        ? `resets in ${duration(l.resetsInMs)}`
        : 'idle — next request opens a new window';
      const m = meter({ label: l.label, percent: l.percent, blocked: l.blocked, foot });
      if (l.confidence === 'exact' || l.confidence === 'carried') {
        const tag = el('span', 'exact-tag', l.confidence === 'exact' ? 'exact' : '≈ carried');
        tag.title = l.confidence === 'exact'
          ? `Reported by Claude Code ${duration(Date.now() - l.exactAt)} ago`
          : `Reported by Claude Code ${duration(Date.now() - l.exactAt)} ago, plus an estimate of the calls made since`;
        m.querySelector('.meter-name').append(tag);
      }
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
      if (!['measured', 'exact', 'carried'].includes(l.confidence)) {
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

/** Which account to use right now, and the exact command that uses it. */
function renderRecommendation(ov) {
  const box = $('#recommend');
  const r = ov.recommendation;
  const btn = $('#rec-command');
  box.hidden = false;
  if (!r) {
    $('#rec-name').textContent = 'Every account is refused right now';
    $('#rec-why').textContent = 'The accounts below show which frees up first.';
    btn.hidden = true;
    return;
  }
  $('#rec-name').textContent = r.label;
  $('#rec-why').textContent = `${Math.round(r.headroom)}% headroom in its tightest window` +
    `${r.exact ? '' : ' (estimated)'}${r.machine ? ` · signed in on ${r.machine}` : ''}${r.note ? ` · ${r.note}` : ''}`;
  btn.hidden = !r.command;
  btn.textContent = r.command ?? '';
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
    foot: limit.confidence === 'exact' ? 'exact, reported by Claude Code'
      : limit.confidence === 'carried' ? 'reported by Claude Code, plus the calls since (≈)'
      : limit.used == null ? '' : `${money(limit.used)} of ~${money(limit.capacity)}`,
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

/** Where the numbers come from: this machine alone, or every machine it syncs with. */
function syncNote(sync) {
  if (!sync || (!sync.machines.length && !sync.peers.length)) {
    return 'reading local transcripts only, nothing leaves this machine.';
  }
  const parts = sync.machines.map((m) => (m.online
    ? `${m.name} (live)`
    : `${m.name} (last heard ${m.lastSeen ? duration(Date.now() - m.lastSeen) + ' ago' : 'never'})`));
  const failing = sync.peers.filter((p) => p.status === 'error' && p.error).map((p) => `${p.target}: ${p.error}`);
  return `${sync.name} synced over ssh with ${parts.join(', ') || 'no machine yet'}.` +
    (failing.length && !sync.machines.some((m) => m.online) ? ` ${failing.join('; ')}` : '');
}

/** Sessions in Slack, in a few words - or nothing, when it is not set up. */
function slackNote(slack) {
  if (!slack) return '';
  if (slack.state === 'off') return ' Slack: off.';
  if (slack.pairCode) return ` Slack: waiting to be paired - post "pair ${slack.pairCode}" in a channel the app is in.`;
  return ` Slack: ${slack.channel}, ${slack.state === 'connected' ? 'connected' : slack.state}${slack.paused ? ', paused' : ''}.`;
}

/** What each profile with sessions running switches to when its account runs low, on every machine. */
function renderFailover(ov) {
  const f = ov.failover;
  const host = $('#failover-rows');
  host.textContent = '';
  const plans = f ? [{ machine: ov.sync?.name ?? 'here', mode: f.mode, at: f.at, ...(f.plan ?? { entries: [] }), local: true }, ...f.remote] : [];
  for (const p of plans) {
    for (const e of p.entries ?? []) {
      const row = el('div', 'row');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', `${e.label} → ${e.target ? `${e.target.label}${e.target.pinned ? ' (your pick)' : ''}` : 'nothing to switch to'}`));
      main.append(el('div', 'row-sub', `${e.profile ?? 'a profile'}${plans.length > 1 ? ` on ${p.machine}` : ''} · ${Math.round(e.level)}% full · ${e.sessions} session${e.sessions === 1 ? '' : 's'}`
        + (e.target ? ` · ${Math.round(e.target.room)}% free there` : ' · no spare there with room')));
      row.append(main);
      row.append(el('div', 'row-value', p.mode !== 'auto' ? 'off' : !e.target ? '' : e.due ? 'switching' : `at ${e.at ?? p.at}%`));
      host.append(row);
      if (e.then?.length) host.append(el('p', 'panel-note', `If that fails: ${e.then.map((t) => t.label).join(', then ')}.`));
    }
    for (const n of p.notices ?? []) {
      host.append(el('p', `panel-note ${n.level === 'bad' ? 'is-bad' : 'is-warn'}`, `${plans.length > 1 ? `${p.machine}: ` : ''}${n.text}${n.fix ? ` To fix: ${n.fix}.` : ''}`));
    }
    if (p.local && p.best) host.append(el('p', 'panel-note', `${p.best.label} has ${Math.round(p.best.room)}% free and no spare here: claude-tracker pool add ${p.best.email}`));
  }
  for (const m of (f?.recent ?? f?.switches ?? []).filter((x) => Date.now() - x.ts < 6 * 3600e3).slice(0, 3)) {
    const where = `${m.profile}${m.machine ? ` on ${m.machine}` : ''}`;
    host.append(m.status === 'switched'
      ? el('p', 'panel-note', `Switched ${where} from ${m.from} to ${m.to}.`)
      : el('p', 'panel-note is-bad', `Could not switch ${where} to ${m.to}${m.times > 1 ? ` (${m.times} tries)` : ''}: ${m.error ?? 'no reason given'}`));
  }
  $('#failover-mode').textContent = f?.mode === 'auto' ? `on at ${f.at}%` : 'off · claude-tracker failover on';
  $('#failover').hidden = !host.childNodes.length;
}

/* --- sessions ------------------------------------------------------------- */

function renderLive(rows, waiting = 0) {
  const host = $('#live-sessions');
  host.textContent = '';
  const busy = rows.filter((r) => r.status === 'busy').length;
  // With detail off, jobs waiting for the GPU or CPU still get a word.
  const wait = !state.detail && waiting ? ` · ${waiting} job${waiting === 1 ? '' : 's'} waiting for the GPU or CPU` : '';
  $('#live-count').textContent = rows.length ? `${rows.length} running · ${busy} busy${wait}` : '';
  if (!rows.length) { host.append(el('p', 'empty', 'No Claude Code sessions running.')); return; }
  for (const s of rows) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    const title = el('div', 'row-title');
    const dot = el('span', `status-dot ${s.status === 'busy' ? 'is-busy' : ''}`);
    title.append(dot, document.createTextNode(' ' + (s.name || s.sessionId.slice(0, 8))));
    main.append(title);
    // The account this session is billing right now - per session, since a
    // background job can keep an account the rest of its profile has left.
    const who = s.account ? `${s.account}${s.background ? ' · background' : ''}` : 'unknown account';
    const where = s.machine ? `${s.machine} · ` : '';
    main.append(el('div', 'row-sub', `${who} · ${where}${(s.cwd ?? '').replace(/^\/(Users|home)\/[^/]+/, '~')}`));
    row.append(main);
    const val = el('div', 'row-value');
    const ago = el('span', 'ago');
    if (s.lastActivityAt) ago.dataset.since = s.lastActivityAt;
    ago.textContent = s.lastActivityAt ? `${duration(Date.now() - s.lastActivityAt)} ago` : '—';
    val.append(ago);
    if (s.recent?.calls) val.append(document.createTextNode(` · ${money(s.recent.cost)}/5m`));
    row.append(val);
    row.append(...sessionDetail(s));
    host.append(row);
  }
}

/**
 * What a running session carries into each turn - a bar up to where Claude
 * Code compacts - its subagents at work, how often its cache lapsed this hour,
 * and any job of its holding or waiting for the shared GPU or CPU pool.
 * Sessions on a machine running an older tracker have none of it.
 */
function sessionDetail(s) {
  const out = [];
  const c = s.context;
  if (c) {
    const band = contextBand(c.tokens);
    const bar = el('div', `ctx-bar is-${band}`);
    const fill = el('span');
    fill.style.width = `${Math.min(100, (c.tokens / c.compactAt) * 100)}%`;
    bar.append(fill);
    bar.title = `${c.tokens.toLocaleString()} tokens re-read every turn, about ${money(c.perTurn)} a turn. Claude Code compacts at about ${tokens(c.compactAt)}.`;
    out.push(bar);
    const parts = [`${tokens(c.tokens)} context a turn · ${money(c.perTurn)} to re-read`];
    if (s.agents?.length) parts.push(`${s.agents.length} agent${s.agents.length === 1 ? '' : 's'} at work: ${agentList(s.agents)}`);
    if (s.recache?.turns) parts.push(`cache re-written ${s.recache.turns}× this hour, ${money(s.recache.cost)}`);
    out.push(el('div', 'row-note', parts.join(' · ')));
  }
  for (const l of s.leases ?? []) out.push(leaseNote(l));
  return out;
}

/** Agent names, once each, with a count where several share one: `Explore ×2, speed`. */
function agentList(agents) {
  const n = new Map();
  for (const a of agents) n.set(a.name, (n.get(a.name) ?? 0) + 1);
  return [...n].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ');
}

/** A synced machine on a different tracker shows less on both sides: say which, and what fixes it. */
function renderSkew(ov) {
  const notes = (ov.sync?.machines ?? []).map((m) => (m.version === 'older'
    ? `${m.name} runs an older claude-tracker, so it shows no session detail. On ${m.name}: git pull in its claude-tracker checkout, then claude-tracker service install.`
    : m.version === 'newer'
      ? `${m.name} runs a newer claude-tracker than this machine. Here: git pull in the claude-tracker checkout, then claude-tracker service install.`
      : null)).filter(Boolean);
  // Slack stuck is said the same way: what is wrong, and the command that fixes it.
  if (ov.slack?.error) notes.push(`Slack: ${ov.slack.error}`);
  $('#skew').hidden = !notes.length;
  $('#skew').textContent = notes.join(' ');
}

/** One line for a session's job holding or waiting for the GPU or a CPU slot. */
function leaseNote(l) {
  const what = l.kind === 'gpu' ? 'the GPU' : 'a CPU slot';
  const where = l.place ? ` in ${l.place}` : '';
  const note = el('div', 'row-note');
  const ms = Date.now() - l.since;
  if (l.state === 'holds') {
    note.append(el('span', 'mark is-held', '■'), document.createTextNode(` holds ${what}${where} · `), sinceSpan(l.since));
    return note;
  }
  const mark = el('span', `mark is-${waitBand(ms)}`, '▸');
  mark.title = `Waiting since ${timeOf(l.since)}`;
  const pos = l.ahead === 0 ? 'next in line' : `${l.ahead} ahead`;
  const behind = l.behind?.length ? ` · behind ${l.behind.map((b) => b.who).join(', ')}` : '';
  note.append(mark, document.createTextNode(` ${l.jobs > 1 ? `${l.jobs} jobs` : 'a job'}${where} waiting `), sinceSpan(l.since),
    document.createTextNode(` for ${what} · ${pos}${behind}`));
  return note;
}

/** A duration that counts up by itself, from `since`. */
function sinceSpan(since) {
  const span = el('span', 'since', duration(Date.now() - since));
  span.dataset.since = since;
  return span;
}

/* --- shared GPU and CPU --------------------------------------------------- */

/** Every machine's GPU lease and CPU pool: who holds each, who waits and for how long. */
function renderBox(list) {
  const host = $('#box-groups');
  host.textContent = '';
  const many = list.length > 1 || list.some((b) => b.machine);
  let waiting = 0;
  for (const b of list) {
    for (const [kind, s] of [['gpu', b.gpu], ['cpu', b.cpu]]) {
      if (!s || (kind === 'cpu' && !s.held.length && !s.waiting.length)) continue;
      if (kind === 'cpu' && !b.machine && machineState.view) continue;  // shown by project in This machine
      waiting += s.jobsWaiting ?? 0;
      const group = el('div', 'box-group');
      const on = many ? ` on ${b.machine ?? 'this machine'}` : '';
      group.append(el('h3', null, kind === 'gpu'
        ? `GPU${on} · ${s.held.length ? 'held' : 'free'}${s.jobsWaiting ? ` · ${s.jobsWaiting} waiting` : ''}`
        : `CPU pool${on} · ${s.held.length} of ${s.slots} slots${s.jobsWaiting ? ` · ${s.jobsWaiting} waiting` : ''} · ${Math.round(s.load)} threads want a CPU (gate ${Math.round(s.gate)}, ${s.cores} cores)`));
      const rows = el('div', 'session-list');
      for (const h of s.held) rows.append(boxRow(el('span', 'mark is-held', '■'), h, h.cmd, 'holding'));
      for (const w of s.waiting) {
        const mark = el('span', `mark is-${waitBand(Date.now() - w.since)}`, '▸');
        const pos = w.ahead === 0 ? 'next in line' : `${w.ahead} ahead`;
        rows.append(boxRow(mark, w, `${w.jobs > 1 ? `${w.jobs} jobs · ` : ''}${pos}`, 'waiting'));
      }
      if (!s.held.length && !s.waiting.length) rows.append(el('p', 'empty', 'Nothing on the GPU.'));
      group.append(rows);
      if (kind === 'gpu' && s.quarantined) group.append(el('p', 'panel-note', 'Quarantined after a GPU fault: gpu --enable once it is healthy.'));
      if (kind === 'cpu' && s.waiting.length && s.held.length < s.slots && s.load >= s.gate) {
        group.append(el('p', 'panel-note', `${s.slots - s.held.length === 1 ? 'A slot is' : 'Slots are'} free, but jobs wait until fewer than ${Math.round(s.gate)} threads want a CPU.`));
      }
      const h = kind === 'gpu' ? s.hour : null;
      if (h?.jobs) {
        const parts = [`${h.jobs} job${h.jobs === 1 ? '' : 's'} waited ${duration(h.waitedMs)} in all`];
        if (h.longestWait?.ms >= 60e3) parts.push(`longest wait ${duration(h.longestWait.ms)} (${h.longestWait.project})`);
        if (h.longestHold?.ms >= 60e3) parts.push(`longest hold ${duration(h.longestHold.ms)} (${h.longestHold.project})`);
        group.append(el('p', 'panel-note', `Last hour: ${parts.join(' · ')}.`));
      }
      host.append(group);
    }
  }
  $('#box-note').textContent = waiting ? `${waiting} job${waiting === 1 ? '' : 's'} waiting` : '';
  $('#box').hidden = !host.childNodes.length;
}

function boxRow(mark, job, detail, doing) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  title.append(mark, document.createTextNode(` ${job.session ?? job.project ?? 'unknown'}`));
  main.append(title);
  main.append(el('div', 'row-sub', [job.project, job.place, detail].filter(Boolean).join(' · ')));
  row.append(main);
  const val = el('div', 'row-value');
  val.append(sinceSpan(job.since));
  val.title = `${doing} since ${timeOf(job.since)}`;
  row.append(val);
  return row;
}

/* --- this machine ---------------------------------------------------------- */

/** Names come from folders and command lines: never markup. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Bytes as 812 MB, 4.7 GB, 1.8 TB. */
function gb(n) {
  if (n == null) return '—';
  const g = n / 2 ** 30;
  if (g >= 1000) return `${(g / 1024).toFixed(1)} TB`;
  if (g >= 100) return `${Math.round(g)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / 2 ** 20))} MB`;
}
/** Cores as 0, 0.4, 9.3, 12. */
const coresOf = (n) => (n == null ? '—' : n < 0.05 ? '0' : n < 10 ? n.toFixed(1) : String(Math.round(n)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TIERS_SHOWN = ['high', 'normal', 'low', 'paused'];
const TIER_LABEL = { high: 'High', normal: 'Normal', low: 'Low', paused: 'Paused' };
const TIER_HELP = {
  high: 'Goes first: its jobs start before other projects\', and get 4× the CPU when the cores run out',
  normal: 'First come, first served, with an even share of the CPU',
  low: 'Gives way: waits while higher projects want a slot, and gets a fifth of the CPU a normal project gets',
  paused: 'Starts nothing new. What already runs goes on, on idle CPU only',
};

/*
 * A project keeps its colour from one visit to the next: seven slots, each held
 * by a project while it shows, so a filter or a quiet hour never repaints the rest.
 */
const COLOR_KEY = 'ct-project-colors';
let colorSlots = {};
try { colorSlots = JSON.parse(localStorage.getItem(COLOR_KEY)) ?? {}; } catch { /* private mode */ }
function holdColors(names) {
  const now = Date.now();
  const used = new Set(Object.values(colorSlots).map((v) => v.slot));
  for (const n of names) {
    if (colorSlots[n]) { colorSlots[n].seen = now; continue; }
    let slot = [0, 1, 2, 3, 4, 5, 6].find((s) => !used.has(s));
    if (slot == null) {
      const [victim] = Object.entries(colorSlots).filter(([k]) => !names.includes(k)).sort((a, b) => a[1].seen - b[1].seen);
      if (!victim) continue;
      slot = victim[1].slot;
      delete colorSlots[victim[0]];
    }
    colorSlots[n] = { slot, seen: now };
    used.add(slot);
  }
  try { localStorage.setItem(COLOR_KEY, JSON.stringify(colorSlots)); } catch { /* private mode */ }
}

const machineState = {
  view: null,
  open: new Set(JSON.parse(localStorage.getItem('ct-open-projects') || '[]')),
  pending: new Map(),   // project -> tier asked for, until the server says it took
  rows: new Map(),      // project -> its row, kept so a refresh never steals a click or focus
  table: false,
  allWaits: new Set(),  // projects whose whole queue shows
};

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${url} → ${r.status}`);
  return data;
}

function renderMachine(v) {
  const box = $('#machine');
  if (!v || v.unavailable) { box.hidden = true; machineState.view = null; return; }
  box.hidden = false;
  machineState.view = v;

  // The projects that get a colour: the busiest over the hour, and now.
  const weight = {};
  for (const pt of v.history.points) for (const [k, c] of Object.entries(pt.by)) if (!k.startsWith(':')) weight[k] = (weight[k] ?? 0) + c;
  for (const p of v.projects) weight[p.name] = (weight[p.name] ?? 0) + p.cores * 10;
  const top = Object.entries(weight).filter(([, c]) => c >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
  holdColors(top);
  const rest = cssVar('--text-muted');
  const colorOf = (k) => (top.includes(k) ? cssVar(SERIES[colorSlots[k].slot]) : rest);

  $('#machine-note').textContent = `Sampled every 3 s · ${timeOf(v.at)}`;
  renderMachineStats(v);
  renderCoresNow(v, top, colorOf);
  renderCoresHour(v, top, colorOf);
  renderProjects(v, top, colorOf);
  renderOthers(v);
}

function statTile(label, figure, small, sub, pct, band) {
  const t = el('div', 'stat');
  t.append(el('span', 'stat-label', label));
  const f = el('span', 'stat-figure', figure);
  if (small) f.append(' ', el('small', null, small));
  t.append(f);
  if (pct != null) {
    const track = el('div', `stat-track${band ? ` is-${band}` : ''}`);
    const fill = el('span');
    fill.style.width = `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%`;
    track.append(fill);
    t.append(track);
  }
  if (sub) t.append(el('span', 'stat-sub', sub));
  return t;
}

function renderMachineStats(v) {
  const host = $('#machine-stats');
  host.textContent = '';
  const c = v.cpu;
  const over = c.gate != null && c.demand >= c.gate;
  host.append(statTile('CPU', coresOf(c.busy), `of ${c.cores} cores busy`,
    `${Math.round(c.demand)} threads want a CPU${c.gate != null ? ` · the pool starts jobs under ${Math.round(c.gate)}` : ''}` +
    (c.pressure?.cpu >= 10 ? ` · work stalled ${Math.round(c.pressure.cpu)}% of the time` : ''),
    (c.busy / c.cores) * 100, over ? 'warning' : null));
  const m = v.mem;
  const memPct = (m.used / m.total) * 100;
  host.append(statTile('Memory', gb(m.used), `of ${gb(m.total)}`,
    `${gb(m.available)} free${m.swapUsed > 2 ** 28 ? ` · ${gb(m.swapUsed)} in swap` : ''}`,
    memPct, memPct >= 95 ? 'critical' : memPct >= 85 ? 'serious' : null));
  if (v.gpu) {
    const g = v.gpu;
    const l = g.leases;
    host.append(statTile('GPU', g.busy != null ? `${Math.round(g.busy)}%` : '—', 'busy',
      [g.vramTotal ? `${gb(g.vramUsed)} of ${gb(g.vramTotal)} video memory` : null,
       l ? `${l.held} of ${l.slots} leases held${l.waiting ? `, ${l.waiting} waiting` : ''}` : null].filter(Boolean).join(' · '),
      g.busy, null));
  }
  if (c.slots) {
    host.append(statTile('Job pool', String(c.held), `of ${c.slots} slots`,
      c.waiting ? `${plural(c.waiting, 'job')} waiting${over ? ' · the box is past its gate' : ''}` : 'Nothing waiting',
      (c.held / c.slots) * 100, null));
  }
}

/** One bar the width of every core: each project's share now, the rest of the machine, and what is idle. */
function renderCoresNow(v, top, colorOf) {
  const bar = $('#cores-bar');
  const legend = $('#cores-legend');
  bar.textContent = '';
  legend.textContent = '';
  const total = Math.max(v.cpu.cores, v.cpu.busy ?? 0);
  const parts = [];
  let restCores = 0, restMem = 0;
  for (const p of v.projects) {
    if (top.includes(p.name) && p.cores >= 0.05) parts.push({ name: p.name, cores: p.cores, mem: p.mem, color: colorOf(p.name) });
    else { restCores += p.cores; restMem += p.mem; }
  }
  for (const o of v.others) { restCores += o.cores; restMem += o.mem; }
  parts.sort((a, b) => b.cores - a.cores);
  if (restCores >= 0.05) parts.push({ name: 'Everything else', cores: restCores, mem: restMem, color: colorOf(null) });
  for (const p of parts) {
    const seg = el('span');
    seg.style.width = `${(p.cores / total) * 100}%`;
    seg.style.background = p.color;
    seg.addEventListener('mousemove', (ev) => showTip(
      `<div class="tooltip-title">${esc(p.name)}</div>` +
      `<div class="tooltip-row"><span>Cores</span><span>${coresOf(p.cores)} of ${v.cpu.cores}</span></div>` +
      `<div class="tooltip-row"><span>Share of the machine</span><span>${Math.round((p.cores / v.cpu.cores) * 100)}%</span></div>` +
      `<div class="tooltip-row"><span>Memory</span><span>${gb(p.mem)}</span></div>`, ev.clientX, ev.clientY));
    seg.addEventListener('mouseleave', hideTip);
    bar.append(seg);
  }
  const idle = Math.max(0, v.cpu.cores - (v.cpu.busy ?? 0));
  const idleSeg = el('span', 'idle');
  idleSeg.title = `${coresOf(idle)} cores idle`;
  bar.append(idleSeg);
  bar.setAttribute('aria-label', `${coresOf(v.cpu.busy)} of ${v.cpu.cores} cores busy: ` +
    parts.map((p) => `${p.name} ${coresOf(p.cores)}`).join(', '));
  for (const p of parts) {
    const item = el('span', 'legend-item');
    const sw = el('span', 'legend-swatch');
    sw.style.background = p.color;
    item.append(sw, document.createTextNode(`${p.name} `), el('b', null, coresOf(p.cores)));
    legend.append(item);
  }
  const it = el('span', 'legend-item');
  const sw = el('span', 'legend-swatch');
  sw.style.background = cssVar('--gridline');
  it.append(sw, document.createTextNode('idle '), el('b', null, coresOf(idle)));
  legend.append(it);
  $('#cores-sub').textContent = `${coresOf(v.cpu.busy)} of ${v.cpu.cores} cores busy`;
}

/** The last hour, a column a minute, stacked by project; the rest of the machine on top in grey. */
function renderCoresHour(v, top, colorOf) {
  const host = $('#cores-chart');
  host.textContent = '';
  const pts = v.history.points;
  if (pts.length < 2) { host.append(el('p', 'empty', 'The hour fills in as the tracker samples.')); $('#machine-table').textContent = ''; return; }
  const names = [...top, 'Everything else'];
  const cols = pts.map((pt) => {
    const parts = Object.fromEntries(names.map((n) => [n, 0]));
    for (const [k, c] of Object.entries(pt.by)) parts[top.includes(k) ? k : 'Everything else'] += c;
    return { t: pt.t, parts, total: Object.values(parts).reduce((a, b) => a + b, 0), busy: pt.busy, demand: pt.demand };
  });
  // Drawn at the width it shows at, so its labels stay legible on a phone.
  const W = Math.max(320, Math.min(1200, Math.round(host.clientWidth || 900))), H = W < 600 ? 160 : 200;
  const pad = { top: 10, right: 12, bottom: 24, left: 30 };
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;
  const maxY = Math.max(v.cpu.cores, ...cols.map((c) => c.total));
  const end = Math.max(...cols.map((c) => c.t)) + v.history.step;
  const start = end - 3600e3;
  const band = plotW / 60;
  const barW = Math.max(2, band - 2);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  const y = (val) => pad.top + plotH - (val / maxY) * plotH;
  for (let i = 0; i <= 4; i++) {
    const val = (v.cpu.cores / 4) * i;
    svg.append(svgEl('line', { class: 'gridline', x1: pad.left, x2: W - pad.right, y1: y(val), y2: y(val) }));
    const t = svgEl('text', { class: 'axis-label', x: pad.left - 6, y: y(val) + 4, 'text-anchor': 'end' });
    t.textContent = String(Math.round(val));
    svg.append(t);
  }
  const GAP = 2;
  for (const c of cols) {
    const i = Math.floor((c.t - start) / v.history.step);
    if (i < 0 || i >= 60) continue;
    const x = pad.left + i * band + (band - barW) / 2;
    let cursor = pad.top + plotH;
    const stack = names.filter((n) => c.parts[n] >= 0.01);
    stack.forEach((n, idx) => {
      const h = (c.parts[n] / maxY) * plotH;
      const drawH = Math.max(0.5, h - (idx === 0 ? 0 : GAP));
      const isTop = idx === stack.length - 1;
      svg.append(svgEl('rect', { x, y: cursor - drawH, width: barW, height: drawH, fill: colorOf(n === 'Everything else' ? null : n),
        rx: isTop ? Math.min(3, drawH / 2) : 0 }));
      cursor -= h;
    });
    const hit = svgEl('rect', { x: pad.left + i * band, y: pad.top, width: band, height: plotH, fill: 'transparent', style: 'cursor:crosshair' });
    hit.addEventListener('mousemove', (ev) => {
      const lines = stack.slice().reverse().map((n) =>
        `<div class="tooltip-row"><span><span class="dot" style="background:${colorOf(n === 'Everything else' ? null : n)}"></span> ${esc(n)}</span><span>${coresOf(c.parts[n])}</span></div>`).join('');
      showTip(`<div class="tooltip-title">${timeOf(c.t)}</div>${lines}` +
        `<div class="tooltip-row" style="margin-top:4px"><span>Busy</span><span>${coresOf(c.busy)} of ${v.cpu.cores}</span></div>` +
        `<div class="tooltip-row"><span>Threads wanting a CPU</span><span>${Math.round(c.demand)}</span></div>`, ev.clientX, ev.clientY);
    });
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);
  }
  for (let m = 0; m <= 60; m += W < 600 ? 30 : 10) {
    const t = svgEl('text', { class: 'axis-label', x: pad.left + m * band, y: H - 6, 'text-anchor': m === 0 ? 'start' : m === 60 ? 'end' : 'middle' });
    t.textContent = m === 60 ? 'now' : `${60 - m} min ago`;
    svg.append(t);
  }
  svg.append(svgEl('line', { class: 'baseline', x1: pad.left, x2: W - pad.right, y1: pad.top + plotH, y2: pad.top + plotH }));
  host.append(svg);
  renderCoresTable(cols, names);
}

/** The hour as a table: five minutes a row, each project's average cores. */
function renderCoresTable(cols, names) {
  const host = $('#machine-table');
  host.textContent = '';
  const rows = new Map();
  for (const c of cols) {
    const t = Math.floor(c.t / 300e3) * 300e3;
    const r = rows.get(t) ?? { n: 0, parts: Object.fromEntries(names.map((n) => [n, 0])), busy: 0 };
    r.n++; r.busy += c.busy ?? 0;
    for (const n of names) r.parts[n] += c.parts[n];
    rows.set(t, r);
  }
  const table = el('table');
  const head = el('tr');
  for (const h of ['From', ...names, 'Busy']) head.append(el('th', null, h));
  table.append(head);
  for (const [t, r] of [...rows.entries()].reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, timeOf(t)));
    for (const n of names) tr.append(el('td', null, coresOf(r.parts[n] / r.n)));
    tr.append(el('td', null, coresOf(r.busy / r.n)));
    table.append(tr);
  }
  host.append(table);
}

/*
 * The owner's rank for a project. The choice shows at once; the server is told
 * one request at a time, and a click made meanwhile is sent next: the last one wins.
 */
const inflight = new Set();
async function choosePriority(project, tier) {
  const err = $('#priority-error');
  machineState.pending.set(project, tier);
  if (machineState.view) renderProjects(machineState.view, ...lastColors);
  if (inflight.has(project)) return;
  inflight.add(project);
  try {
    for (;;) {
      const want = machineState.pending.get(project);
      const v = await postJson('/api/priority', { project, tier: want });
      if (machineState.pending.get(project) !== want) continue;
      machineState.pending.delete(project);
      err.hidden = true;
      if (v?.projects) renderMachine(v);
      break;
    }
  } catch (e) {
    const want = machineState.pending.get(project);
    machineState.pending.delete(project);
    err.textContent = `Could not set ${project} to ${TIER_LABEL[want].toLowerCase()}: ${e.message}`;
    err.hidden = false;
    if (machineState.view) renderProjects(machineState.view, ...lastColors);
  } finally {
    inflight.delete(project);
  }
}

async function runNextJob(btn, pid) {
  btn.disabled = true;
  btn.textContent = 'Asking…';
  const err = $('#priority-error');
  try {
    const v = await postJson('/api/run-next', { pid });
    err.hidden = true;
    btn.blur();  // the details refresh only while the owner is not in them
    if (v?.projects) renderMachine(v);
  } catch (e) {
    err.textContent = `Could not move that job up: ${e.message}`;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Run next';
  }
}

let lastColors = [[], () => ''];

function renderProjects(v, top, colorOf) {
  lastColors = [top, colorOf];
  const host = $('#projects');
  const pr = v.priority;
  const note = $('#priority-note');
  if (!pr.canSet) note.textContent = 'heavy is not installed here, so priorities cannot be set';
  else if (pr.broken) note.textContent = 'The priority file does not read as JSON: set any project to rewrite it';
  else if (pr.set) note.textContent = `Last set ${pr.updated ? `${duration(Date.now() - pr.updated)} ago` : ''}${pr.by ? ` from ${pr.by}` : ''}`;
  else note.textContent = 'None set yet: first come, first served, with heavy\'s own ranks';
  const active = (p) => (p.cores >= 0.05 || p.jobs.length || p.waits.length || p.sessions.length || p.leftovers.length ? 1 : 0);
  const list = [...v.projects].sort((a, b) => active(b) - active(a) || a.name.localeCompare(b.name));
  const seen = new Set();
  let prev = null;
  for (const p of list) {
    seen.add(p.name);
    let row = machineState.rows.get(p.name);
    if (!row) { row = projectRow(p.name); machineState.rows.set(p.name, row); }
    fillProject(row, p, v, colorOf);
    // Move it into place only when it is not there already: moving a node drops its hover and focus.
    const want = prev ? prev.nextSibling : host.firstChild;
    if (want !== row) host.insertBefore(row, want);
    prev = row;
  }
  for (const [name, row] of machineState.rows) if (!seen.has(name)) { row.remove(); machineState.rows.delete(name); }
  if (!list.length && !host.querySelector('.empty')) host.append(el('p', 'empty', 'No project uses this machine right now.'));
  if (list.length) host.querySelector(':scope > .empty')?.remove();
}

function projectRow(name) {
  const row = el('div', 'project');
  row.dataset.project = name;
  const head = el('div', 'project-head');
  const open = el('button', 'project-open');
  open.type = 'button';
  open.append(el('span', 'project-chev', '▸'), el('span', 'dot'), el('span', 'project-name', name), el('span', 'project-sum'));
  open.addEventListener('click', () => {
    if (machineState.open.has(name)) machineState.open.delete(name); else machineState.open.add(name);
    try { localStorage.setItem('ct-open-projects', JSON.stringify([...machineState.open])); } catch { /* private mode */ }
    if (machineState.view) renderProjects(machineState.view, ...lastColors);
  });
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', `Priority for ${name}`);
  for (const t of TIERS_SHOWN) {
    const b = el('button', null, TIER_LABEL[t]);
    b.type = 'button';
    b.dataset.tier = t;
    b.setAttribute('role', 'radio');
    b.title = TIER_HELP[t];
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-checked') === 'true' || b.disabled) return;
      choosePriority(name, t);
    });
    // Arrow keys move along the choices, as in any radio group.
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const all = [...seg.children];
      const next = all[(all.indexOf(b) + step + all.length) % all.length];
      next.focus();
      next.click();
    });
    seg.append(b);
  }
  head.append(open, seg);
  row.append(head, el('div', 'project-body'));
  return row;
}

function fillProject(row, p, v, colorOf, force = false) {
  const tier = machineState.pending.get(p.name) ?? p.tier;
  row.className = `project is-${tier}${machineState.open.has(p.name) ? ' is-open' : ''}`;
  const dot = row.querySelector('.dot');
  dot.style.background = colorOf(p.name);
  // Its summary: what it uses, and how many of each thing it runs.
  const bits = [`${coresOf(p.cores)} cores`, gb(p.mem)];
  if (p.sessions.length) bits.push(plural(p.sessions.length, 'session'));
  if (p.jobs.length || p.pool.held) bits.push(`${plural(p.jobs.length || p.pool.held, 'job')}${p.pool.share ? ` (share ${p.pool.share})` : ''}`);
  const sum = row.querySelector('.project-sum');
  sum.textContent = bits.join(' · ');
  if (p.waits.length) {
    const oldest = Math.min(...p.waits.map((w) => w.since));
    sum.append(' · ', el('span', 'is-waiting', `${p.waits.length} waiting, longest ${duration(Date.now() - oldest)}`));
  }
  if (p.leftovers.length) sum.append(` · ${plural(p.leftovers.length, 'thing', 'things')} left running`);
  const open = row.querySelector('.project-open');
  open.setAttribute('aria-expanded', String(machineState.open.has(p.name)));
  const seg = row.querySelector('.seg');
  seg.classList.toggle('is-pending', machineState.pending.has(p.name));
  for (const b of seg.children) {
    b.setAttribute('aria-checked', String(b.dataset.tier === tier));
    b.tabIndex = b.dataset.tier === tier ? 0 : -1;
    b.disabled = !v.priority.canSet;
  }
  const body = row.querySelector('.project-body');
  body.hidden = !machineState.open.has(p.name);
  // A refresh leaves the details alone while the owner is in them.
  if (body.hidden || (!force && body.contains(document.activeElement))) return;
  body.textContent = '';
  if (p.waits.length) {
    // A long queue shows its oldest few; the rest on request.
    const all = machineState.allWaits.has(p.name);
    const shown = all ? p.waits : p.waits.slice(0, 6);
    const s = section(`Waiting for a slot (${p.waits.length})`, shown.map((w) => waitRow(w, v)));
    if (p.waits.length > shown.length || all && p.waits.length > 6) {
      const more = el('button', 'small-btn more-btn', all ? 'Show fewer' : `Show all ${p.waits.length}`);
      more.type = 'button';
      more.addEventListener('click', () => {
        if (all) machineState.allWaits.delete(p.name); else machineState.allWaits.add(p.name);
        fillProject(row, p, v, colorOf, true);
      });
      s.append(more);
    }
    body.append(s);
  }
  if (p.jobs.length) body.append(section('Jobs in the pool', p.jobs.map(jobRow)));
  if (p.sessions.length) body.append(section('Sessions', p.sessions.map(sessionUseRow)));
  if (p.leftovers.length) body.append(section('Left running', p.leftovers.map(leftoverRow)));
  if (!body.childNodes.length) body.append(el('p', 'empty', 'Nothing running. Its priority applies to the next job it starts.'));
}

function section(title, rows) {
  const s = el('div');
  s.append(el('h4', null, title));
  const list = el('div', 'session-list');
  list.append(...rows);
  s.append(list);
  return s;
}

/** A process list: the busiest few, with their cores. */
const procText = (top) => top.map((t) => `${t.comm}${t.n > 1 ? ` ×${t.n}` : ''}${t.cores >= 0.05 ? ` ${coresOf(t.cores)}` : ''}`).join(' · ');

function useValue(cores, mem) {
  return el('div', 'row-value', `${coresOf(cores)} cores · ${gb(mem)}`);
}

function waitRow(w, v) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  title.append(el('span', `mark is-${waitBand(Date.now() - w.since)}`, '▸'), ` ${w.session ?? 'a job'}`);
  if (w.place) title.append(el('span', 'tag', w.place));
  if (w.solo) title.append(el('span', 'tag', 'timing check'));
  if (w.priority) title.append(el('span', 'tag', 'release'));
  if (w.next) title.append(el('span', 'tag is-next', 'runs next'));
  main.append(title, el('div', 'why', w.why ? `Waiting: ${w.why}` : 'Its heavy has not said why yet (one from before reasons were written)'));
  row.append(main);
  const side = el('div', 'row-value');
  side.append(sinceSpan(w.since));
  if (!w.next && v.priority.canSet) {
    const b = el('button', 'small-btn', 'Run next');
    b.type = 'button';
    b.title = 'Start this job before every other waiting job, as soon as a slot is free';
    b.addEventListener('click', () => runNextJob(b, w.pid));
    side.append(' ', b);
  }
  row.append(side);
  return row;
}

function jobRow(j) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  title.append(el('span', 'mark is-held', '■'), ` ${j.cmd ?? `job ${j.pid}`}`);
  title.title = j.cmd ?? '';
  main.append(title);
  const sub = el('div', 'row-sub');
  sub.append(sinceSpan(j.since), document.createTextNode(` · ${[j.session, j.place].filter(Boolean).join(' · ') || `pid ${j.pid}`}`));
  if (j.solo) sub.append(el('span', 'tag', 'timing check'));
  if (j.priority) sub.append(el('span', 'tag', 'release'));
  if (j.legacy) {
    const t = el('span', 'tag', 'old share');
    t.title = 'Started before priorities: its CPU share follows the old rules until it ends';
    sub.append(t);
  }
  main.append(sub);
  if (j.top.length) main.append(el('div', 'procs', procText(j.top)));
  row.append(main, useValue(j.cores, j.mem));
  return row;
}

function sessionUseRow(s) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  const dot = el('span', `status-dot${s.status === 'busy' ? ' is-busy' : ''}`);
  title.append(dot, ` ${s.name ?? (s.sessionId?.startsWith('pid:') ? `Claude (pid ${s.sessionId.slice(4)})` : s.sessionId?.slice(0, 8) ?? 'session')}`);
  main.append(title);
  if (s.top.length) main.append(el('div', 'procs', procText(s.top)));
  row.append(main, useValue(s.cores, s.mem));
  return row;
}

function leftoverRow(l) {
  const row = el('div', 'row');
  const main = el('div', 'row-main');
  const title = l.orphan
    ? `A killed job's processes${l.since ? `, started ${dayOf(l.since)} ${timeOf(l.since)}` : ''}`
    : `Session ${l.sessionId?.slice(0, 8) ?? ''} has ended; ${l.procs === 1 ? 'a process it started still runs' : `${l.procs} processes it started still run`}`;
  main.append(el('div', 'row-title', title));
  if (l.top.length) main.append(el('div', 'procs', l.top.map((t) => `${t.comm}${t.n > 1 ? ` ×${t.n}` : ''}`).join(' · ')));
  row.append(main, useValue(l.cores, l.mem));
  row.title = l.orphan ? `${l.unit}: its heavy is gone, but these still run in its scope` : `Started by session ${l.sessionId}`;
  return row;
}

function renderOthers(v) {
  const host = $('#others');
  host.textContent = '';
  let cores = 0, mem = 0;
  for (const o of v.others) {
    cores += o.cores; mem += o.mem;
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', o.name));
    if (o.top?.length) main.append(el('div', 'procs', procText(o.top)));
    if (o.kind === 'transient') main.append(el('div', 'procs', 'Processes that started and ended between samples, and the kernel\'s own work'));
    row.append(main, o.kind === 'transient' ? el('div', 'row-value', `${coresOf(o.cores)} cores`) : useValue(o.cores, o.mem));
    host.append(row);
  }
  $('#others-sum').textContent = `${coresOf(cores)} cores · ${gb(mem)}`;
}

/* --- disk space ------------------------------------------------------------ */

let storageView = null;

/** Why a folder counts as not cleaned up, in a few words. */
function leftWhy(i) {
  const idle = i.idleDays != null ? `${Math.round(i.idleDays)} days` : 'a while';
  if (i.kind === 'scratchpad' && i.sessionId) return `scratchpad of a session that ended; untouched ${idle}`;
  if (i.kind === 'scratchpad') return `temp folder in Claude's scratch space, untouched ${idle}`;
  if (i.kind === 'worktree') return `worktree no session is in, untouched ${idle}`;
  if (i.kind === 'temp') return `temp folder, untouched ${idle}`;
  return `untouched ${idle}`;
}

function itemLine(i, why) {
  const r = el('div', 'owner-item');
  const pathEl = el('span', 'path', i.path);
  pathEl.title = i.path;
  r.append(pathEl, el('span', 'size', gb(i.bytes)));
  if (why) r.append(el('span', 'why', why));
  return r;
}

function renderStorage(s) {
  const box = $('#storage');
  storageView = s;
  if (!s || s.unavailable) { box.hidden = true; return; }
  box.hidden = false;
  const btn = $('#storage-rescan');
  btn.disabled = !!s.surveying;
  btn.textContent = s.surveying ? 'Surveying…' : 'Rescan';
  const note = $('#storage-note');
  $('#storage .storage-row').hidden = !s.at;
  if (!s.at) {
    note.textContent = s.surveying ? 'Measuring the disks for the first time; this takes a few minutes'
      : 'Not measured yet: the first survey starts a minute and a half after the tracker does, or press Rescan';
    for (const id of ['#disks', '#owners', '#leftovers', '#cleanup', '#owners-legend']) $(id).textContent = '';
    return;
  }
  note.textContent = `Measured ${duration(Date.now() - s.at)} ago${s.took ? `, in ${duration(s.took)}` : ''} · next in ${duration(Math.max(0, s.next - Date.now()))}`;

  const disks = $('#disks');
  disks.textContent = '';
  for (const d of s.disks) {
    const pct = (d.used / d.size) * 100;
    const foot = `${gb(d.avail)} free${d.grew != null && Math.abs(d.grew) >= 2 ** 30 ? ` · ${d.grew > 0 ? 'grew' : 'shrank'} ${gb(Math.abs(d.grew))} in a day` : ''}`;
    disks.append(meter({ label: `${d.mount} · ${gb(d.used)} of ${gb(d.size)}`, percent: pct, foot }));
  }

  const kept = cssVar('--series-1'), left = cssVar('--warning');
  const legend = $('#owners-legend');
  legend.textContent = '';
  for (const [name, color] of [['in use', kept], ['not cleaned up', left]]) {
    const item = el('span', 'legend-item');
    const sw = el('span', 'legend-swatch');
    sw.style.background = color;
    item.append(sw, document.createTextNode(name));
    legend.append(item);
  }
  const owners = $('#owners');
  const openOwners = new Set([...owners.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  owners.textContent = '';
  const biggest = Math.max(1, ...s.owners.map((o) => o.bytes));
  for (const o of s.owners.slice(0, 12)) {
    const d = el('details', 'owner');
    d.dataset.key = o.key;
    if (openOwners.has(o.key)) d.open = true;
    const sum = el('summary', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', o.name));
    const sub = [];
    if (o.counts.worktrees) sub.push(`${plural(o.counts.worktrees, 'worktree')}${o.counts.worktreesLeft ? ` (${o.counts.worktreesLeft} idle)` : ''}`);
    if (o.counts.scratchpads) sub.push(`${plural(o.counts.scratchpads, 'scratchpad')}${o.counts.scratchpadsLeft ? ` (${o.counts.scratchpadsLeft} ended)` : ''}`);
    if (o.grew != null && Math.abs(o.grew) >= 256 * 2 ** 20) sub.push(`${o.grew > 0 ? 'grew' : 'shrank'} ${gb(Math.abs(o.grew))} in a day`);
    if (sub.length) main.append(el('div', 'row-sub', sub.join(' · ')));
    sum.append(main, el('div', 'row-value', gb(o.bytes)));
    const bar = el('div', 'row-bar');
    const a = el('span');
    a.style.width = `${((o.bytes - o.left) / biggest) * 100}%`;
    a.style.background = kept;
    bar.append(a);
    if (o.left > 0) {
      const b = el('span');
      b.style.width = `${(o.left / biggest) * 100}%`;
      b.style.background = left;
      b.title = `${gb(o.left)} not cleaned up`;
      bar.append(b);
    }
    sum.append(bar);
    d.append(sum);
    const items = el('div', 'owner-items');
    for (const i of o.items) items.append(itemLine(i, [i.kind, i.status === 'live' || i.live ? 'in use' : null, i.left ? 'not cleaned up' : null].filter(Boolean).join(' · ')));
    d.append(items);
    owners.append(d);
  }

  $('#left-note').textContent = s.leftTotal
    ? `${gb(s.leftTotal)} that the session or job that made it no longer uses: ended sessions' scratchpads, worktrees nobody is in, idle temp folders.`
    : 'Nothing left behind that the survey could see.';
  const leftHost = $('#leftovers');
  const openLeft = new Set([...leftHost.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  leftHost.textContent = '';
  const mostLeft = Math.max(1, ...s.left.map((o) => o.bytes));
  for (const l of s.left.slice(0, 10)) {
    const o = s.owners.find((x) => x.key === l.key);
    const d = el('details', 'owner');
    d.dataset.key = l.key;
    if (openLeft.has(l.key)) d.open = true;
    const sum = el('summary', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', l.name));
    const n = o?.leftovers.length ?? 0;
    main.append(el('div', 'row-sub', `${o?.counts.scratchpadsLeft ? `${plural(o.counts.scratchpadsLeft, 'ended scratchpad')}` : ''}${o?.counts.scratchpadsLeft && o?.counts.worktreesLeft ? ' · ' : ''}${o?.counts.worktreesLeft ? plural(o.counts.worktreesLeft, 'idle worktree') : ''}` || plural(n, 'folder')));
    sum.append(main, el('div', 'row-value', gb(l.bytes)));
    const bar = el('div', 'row-bar');
    const b = el('span');
    b.style.width = `${(l.bytes / mostLeft) * 100}%`;
    b.style.background = left;
    bar.append(b);
    sum.append(bar);
    d.append(sum);
    const items = el('div', 'owner-items');
    for (const i of o?.leftovers ?? []) items.append(itemLine(i, leftWhy(i)));
    d.append(items);
    leftHost.append(d);
  }

  const cleanup = $('#cleanup');
  cleanup.textContent = '';
  if (s.commands.length) {
    cleanup.append(el('h3', 'sub-h', 'Clean up'));
    for (const c of s.commands) {
      const row = el('div', 'cleanup-row');
      const b = el('button', 'command', c.cmd);
      b.type = 'button';
      b.title = 'Copy command';
      b.addEventListener('click', () => copyCommand(b));
      row.append(b, el('span', null, c.label));
      cleanup.append(row);
    }
  }
}

async function copyCommand(btn) {
  try {
    await navigator.clipboard.writeText(btn.textContent);
    btn.dataset.copied = '1';
    setTimeout(() => { delete btn.dataset.copied; }, 1400);
  } catch { /* clipboard unavailable - the command is still selectable */ }
}

let machineBusy = false;
async function loadMachine() {
  if (machineBusy) return;
  machineBusy = true;
  try { renderMachine(await getJson('/api/machine')); } catch { /* the next tick tries again */ } finally { machineBusy = false; }
}
async function loadStorage() {
  try { renderStorage(await getJson('/api/storage')); } catch { /* the next tick tries again */ }
}
setInterval(() => { if (document.visibilityState === 'visible') loadMachine(); }, 3000);
setInterval(() => { if (document.visibilityState === 'visible') loadStorage(); }, 60e3);
$('#storage-rescan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Surveying…';
  try { await postJson('/api/storage/rescan', {}); } catch (err) { btn.disabled = false; btn.textContent = 'Rescan'; $('#storage-note').textContent = err.message; }
});
$('#machine-table-toggle').addEventListener('click', (e) => {
  machineState.table = !machineState.table;
  $('#machine-table').hidden = !machineState.table;
  e.currentTarget.setAttribute('aria-pressed', String(machineState.table));
});

/* --- re-cached context ---------------------------------------------------- */

/** Turns that re-wrote a lapsed cache: the last day and week, subagents and main thread apart. */
function renderCache(c) {
  const box = $('#cache');
  if (!c?.week?.turns) { box.hidden = true; return; }
  box.hidden = false;
  const stats = $('#cache-stats');
  stats.textContent = '';
  for (const [label, r] of [['Last 24 hours', c.day], ['Last 7 days', c.week]]) {
    const tile = el('div', 'stat');
    tile.append(el('div', 'stat-label', label));
    tile.append(el('div', 'stat-figure', money(r.cost)));
    tile.append(meter({ label: 'Share of all spend', percent: r.share * 100, foot: `of ${money(r.spend)} spent`, plain: true }));
    tile.append(el('div', 'stat-sub', `${r.turns.toLocaleString()} turns re-wrote their cache, of ${r.calls.toLocaleString()}`));
    stats.append(tile);
  }

  const split = $('#cache-split');
  split.textContent = '';
  const ttl = (t) => (t === '1h' ? 'keeps its cache an hour' : t === '5m' ? 'keeps its cache 5 minutes' : '');
  const total = c.week.cost || 1;
  for (const [label, part, t, color] of [['Subagents', c.week.sub, c.ttl?.sub, '--series-1'], ['Main thread', c.week.main, c.ttl?.main, '--series-2']]) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    const title = el('div', 'row-title');
    const dot = el('span', 'dot');
    dot.style.background = cssVar(color);
    title.append(dot, document.createTextNode(` ${label}`));
    main.append(title);
    main.append(el('div', 'row-sub', `${part.turns.toLocaleString()} turns this week · ${ttl(t)}`));
    row.append(main);
    row.append(el('div', 'row-value', `${money(part.cost)}  ${Math.round((part.cost / total) * 100)}%`));
    const bar = el('div', 'row-bar');
    const span = el('span');
    span.style.width = `${(part.cost / total) * 100}%`;
    span.style.background = cssVar(color);
    bar.append(span);
    row.append(bar);
    split.append(row);
  }

  const hint = $('#cache-hint');
  hint.hidden = !c.hint;
  if (c.hint) {
    hint.textContent = '';
    const code = (t) => el('code', null, t);
    hint.append(
      document.createTextNode('Subagents re-write their whole context after any pause over 5 minutes. Keep it an hour with '),
      code(`"${c.hint.setting}": "${c.hint.value}"`), document.createTextNode(' in settings.json, or '),
      code(`${c.hint.env}=${c.hint.value}`), document.createTextNode('.'));
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
    // A session that switched accounts billed each for its part: show the path.
    const name = (u) => (u ? nameOf.get(u) ?? `${u.slice(0, 8)}…` : 'unattributed');
    const who = s.accounts?.length ? s.accounts.map((x) => name(x.accountUuid)).join(' → ') : name(s.account_uuid);
    main.append(el('div', 'row-sub',
      `${dayOf(s.last_ts)} ${timeOf(s.last_ts)} · ${who}${s.machine ? ' · ' + s.machine : ''}${s.git_branch ? ' · ' + s.git_branch : ''}`));
    row.append(main);
    row.append(el('div', 'row-value', `${money(s.cost)}`));
    host.append(row);
  }
}

/* --- countdown ------------------------------------------------------------ */

setInterval(() => { loadSlow().catch(() => {}); }, 10_000);

/** Tick every reset countdown and "last active" label without refetching. */
setInterval(() => {
  const now = Date.now();
  for (const a of document.querySelectorAll('.ago[data-since]')) {
    a.textContent = `${duration(now - Number(a.dataset.since))} ago`;
  }
  for (const a of document.querySelectorAll('.since[data-since]')) {
    a.textContent = duration(now - Number(a.dataset.since));
  }
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

/** Accounts, hero and running sessions - cheap, and refreshed on every push. */
let fastBusy = false, fastAgain = false;
async function loadFast() {
  // Coalesce: pushes can arrive faster than a round trip; never stack requests.
  if (fastBusy) { fastAgain = true; return; }
  fastBusy = true;
  try {
    const [ov, live, box] = await Promise.all([getJson('/api/overview'), getJson('/api/live'), getJson('/api/box')]);
    state.overview = ov;
    renderHero(ov);
    renderRecommendation(ov);
    renderFailover(ov);
    renderAccounts(ov, live);
    renderLive(live, box.reduce((a, b) => a + (b.gpu?.jobsWaiting ?? 0) + (b.cpu?.jobsWaiting ?? 0), 0));
    renderBox(box);
    renderSkew(ov);
    syncAccountFilter(ov);
    $('#foot-note').textContent = `Updated ${new Date().toLocaleTimeString()} · ${syncNote(ov.sync)}${slackNote(ov.slack)}`;
  } finally {
    fastBusy = false;
    if (fastAgain) { fastAgain = false; loadFast().catch(() => {}); }
  }
}

function syncAccountFilter(ov) {
  const sel = $('#filter-account');
  const want = ['all', ...ov.accounts.map((a) => a.accountUuid)].join(',');
  if (sel.dataset.keys === want) return;
  sel.dataset.keys = want;
  const prev = state.account;
  sel.textContent = '';
  sel.append(new Option('All accounts', 'all'));
  for (const a of ov.accounts) sel.append(new Option(a.label, a.accountUuid));
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';
  state.account = sel.value;
}

/** Charts, model split, session history - heavier, and slow-moving. */
async function loadSlow() {
  const acct = state.account === 'all' ? '' : `&account=${encodeURIComponent(state.account)}`;
  const [daily, models, sess, cache] = await Promise.all([
    getJson(`/api/history?days=${state.days}${acct}`),
    getJson(`/api/models?days=${state.days}${acct}`),
    getJson(`/api/sessions?limit=40${acct}`),
    getJson('/api/cache'),
  ]);
  renderDaily(daily);
  renderModels(models);
  renderCache(cache);
  renderSessions(sess, state.overview?.accounts ?? []);
  await loadWindows();
}

async function loadAll() {
  await Promise.all([loadMachine(), loadStorage()]);
  await loadFast();
  await loadSlow();
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

// Detail on and off, remembered per browser; d does it too.
function applyDetail() {
  document.body.classList.toggle('detail', state.detail);
  $('#detail-toggle').setAttribute('aria-pressed', String(state.detail));
  try { localStorage.setItem('ct-detail', state.detail ? '1' : '0'); } catch { /* private mode */ }
}
function toggleDetail() {
  state.detail = !state.detail;
  applyDetail();
  if (state.overview) loadAll().catch(() => {});
}
$('#detail-toggle').addEventListener('click', toggleDetail);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  toggleDetail();
});
applyDetail();

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
  // Every push refreshes accounts and running sessions immediately.
  es.addEventListener('update', () => { loadFast().catch(() => {}); });
  es.addEventListener('machine', () => { loadMachine(); });
  es.addEventListener('storage', () => { loadStorage(); });
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

// Copy the recommended command with one click.
$('#rec-command').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(btn.textContent);
    btn.dataset.copied = '1';
    setTimeout(() => { delete btn.dataset.copied; }, 1400);
  } catch { /* clipboard unavailable - the command is still selectable */ }
});
