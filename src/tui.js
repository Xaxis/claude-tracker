import { spawn } from 'node:child_process';
import { overview, liveSessions, modelBreakdown, windowHistory, inUse, boxes } from './api.js';
import { cacheSummary } from './context.js';
import { plan, setFailover, failoverSettings, spares, switchProfile, headroom, MIN_ROOM } from './failover.js';

/**
 * Live terminal dashboard.
 *
 * Renders into the alternate screen buffer and repaints a whole frame at a time,
 * so there is no flicker and no partial-line tearing. It shares a process with
 * the web server: the same watcher refresh drives both, so the terminal and the
 * browser never disagree about what they are showing.
 */

/* --- ansi ----------------------------------------------------------------- */

const ESC = '\x1b[';
const A = {
  alt: `${ESC}?1049h`, unalt: `${ESC}?1049l`,
  hide: `${ESC}?25l`, show: `${ESC}?25h`,
  home: `${ESC}H`, clear: `${ESC}2J`,
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
};

const truecolor = !process.env.NO_COLOR &&
  /truecolor|24bit/i.test(process.env.COLORTERM ?? '');

/** 24-bit colour where the terminal supports it, a 256-colour approximation otherwise. */
function fg(hex) {
  if (process.env.NO_COLOR) return '';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (truecolor) return `${ESC}38;2;${r};${g};${b}m`;
  // xterm 6x6x6 cube
  const q = (v) => Math.round((v / 255) * 5);
  return `${ESC}38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
}

// Same roles as the web dashboard's status palette.
const C = {
  accent: fg('#3987e5'),
  good: fg('#0ca30c'),
  warning: fg('#fab219'),
  serious: fg('#ec835a'),
  critical: fg('#d03b3b'),
  muted: fg('#898781'),
  text: '',
  reset: A.reset,
};

// Colour codes and OSC 8 hyperlinks - neither takes up room on screen.
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const vlen = (s) => s.replace(ANSI_RE, '').length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));
const LINK_END = '\x1b]8;;\x1b\\';
/** Text that opens `url` when clicked, in terminals that support hyperlinks. */
const hyperlink = (text, url) => `\x1b]8;;${url}\x1b\\${text}${LINK_END}`;
const truncate = (s, n) => {
  if (vlen(s) <= n) return s;
  // Walk the string keeping escape sequences intact while counting visible chars.
  let out = '', seen = 0, i = 0, inLink = false;
  while (i < s.length && seen < n) {
    if (s[i] === '\x1b') {
      const m = /^(?:\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(s.slice(i));
      if (m) {
        if (m[0].startsWith('\x1b]8;')) inLink = !/^\x1b\]8;[^;]*;(?:\x07|\x1b\\)$/.test(m[0]);
        out += m[0]; i += m[0].length; continue;
      }
    }
    out += s[i]; seen++; i++;
  }
  return out + (inLink ? LINK_END : '') + A.reset;
};

/** Open a URL in the default browser, without waiting on it. */
function openUrl(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* nothing to open it with */ }
}

/* --- formatting ----------------------------------------------------------- */

const money = (n) => {
  if (n == null) return '—';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
};

const compact = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

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

function severity(pct, blocked) {
  if (blocked) return { color: C.critical, word: 'limit reached' };
  if (pct >= 95) return { color: C.critical, word: 'nearly out' };
  if (pct >= 80) return { color: C.serious, word: 'running low' };
  if (pct >= 60) return { color: C.warning, word: 'over half' };
  return { color: C.accent, word: 'plenty left' };
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function meterBar(pct, width, color) {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return `${color}${'█'.repeat(filled)}${C.muted}${'░'.repeat(Math.max(0, width - filled))}${C.reset}`;
}

function sparkline(values, max) {
  if (!values.length) return '';
  const top = max || Math.max(...values, 1);
  return values.map((v) => {
    const i = Math.min(BLOCKS.length - 1, Math.max(0, Math.round((v / top) * (BLOCKS.length - 1))));
    const sev = severity((v / top) * 100, false);
    return `${sev.color}${BLOCKS[i]}${C.reset}`;
  }).join('');
}

/* --- the dashboard -------------------------------------------------------- */

/** A moment ahead as a clock time - with the day when it is not today - and how far off it is. */
function clockAt(ts, now) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  const hm = d.toTimeString().slice(0, 5);
  const day = d.toDateString() === new Date(now).toDateString() ? '' : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} `;
  return `${day}${hm} (in ${duration(ts - now)})`;
}

/**
 * What each profile with sessions running switches to when its account runs
 * low, machine by machine, and the switches made in the last few hours.
 */
function failoverLines(f, here, now) {
  if (!f) return [];
  const plans = [{ machine: here ?? 'here', mode: f.mode, at: f.at, ...(f.plan ?? { entries: [] }), local: true }, ...f.remote];
  const rows = [];
  for (const p of plans) {
    for (const e of p.entries ?? []) {
      const who = `${C.muted}${e.profile ?? "a profile"}${plans.length > 1 ? ` on ${p.machine}` : ''}${C.reset} ${A.bold}${e.label}${A.reset} ${C.muted}${Math.round(e.level)}%${C.reset}`;
      const to = e.target
        ? `${C.accent}${e.target.label}${C.reset} ${C.muted}${Math.round(e.target.room)}% free${e.target.pinned ? ' · your pick' : ''}${C.reset}`
        : `${C.critical}nothing${C.reset} ${C.muted}- no spare there with room${C.reset}`;
      const state = p.mode !== 'auto' ? `${C.muted}(off)${C.reset}`
        : !e.target ? '' : e.due ? `${C.warning}switching${C.reset}` : `${C.muted}at ${e.at ?? p.at}%${C.reset}`;
      rows.push(`  ${C.muted}↪${C.reset} ${who} → ${to}  ${state}`);
      if (e.then?.length) rows.push(`    ${C.muted}if that fails: ${e.then.map((t) => t.label).join(' → ')}${C.reset}`);
    }
    for (const n of p.notices ?? []) {
      rows.push(`  ${n.level === 'bad' ? C.critical : C.warning}!${C.reset} ${plans.length > 1 ? `${C.muted}${p.machine}:${C.reset} ` : ''}${n.text}`);
      if (n.fix) rows.push(`    ${C.muted}→ ${n.fix}${C.reset}`);
    }
    if (p.local && p.best) rows.push(`    ${C.muted}${p.best.label} has ${Math.round(p.best.room)}% free: claude-tracker pool add ${p.best.email}${C.reset}`);
  }
  for (const m of (f.switches ?? []).filter((x) => now - x.ts < 6 * 3600e3).slice(0, 3)) {
    rows.push(m.status === 'switched'
      ? `    ${C.good}switched${C.reset} ${m.profile} ${m.from} → ${m.to}`
      : `    ${C.critical}could not switch${C.reset} ${m.profile}: ${C.muted}${m.error}${C.reset}`);
  }
  if (!rows.length) return [];
  const pick = f.prefer ? ` · prefers ${f.prefer}` : '';
  const head = f.mode === 'auto' ? `${C.good}FAILOVER${C.reset} ${C.muted}on at ${f.at}%${pick} · f t +/- s${C.reset}` : `${C.muted}FAILOVER off${pick} · f to turn on${C.reset}`;
  return [`  ${head}`, ...rows];
}

/* --- what sessions carry, and the shared GPU and CPU ------------------------ */

/** Tokens as 507k or 1.2M. */
const tokens = (n) => (n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/**
 * Context bands, by what a turn re-reads: past 400k a turn costs over ten times
 * a fresh session's, and the bands step up from there to the auto-compact.
 */
function contextColor(n) {
  if (n >= 800e3) return C.critical;
  if (n >= 600e3) return C.serious;
  if (n >= 400e3) return C.warning;
  return C.accent;
}

/** How long a job has waited: amber, then orange past 5 minutes, red past 15. */
const waitColor = (ms) => (ms >= 15 * 60e3 ? C.critical : ms >= 5 * 60e3 ? C.serious : C.warning);

/** One line for a session's job holding or waiting for the GPU or a CPU slot. */
function leaseLine(l, now) {
  const what = l.kind === 'gpu' ? 'the GPU' : 'a CPU slot';
  const where = l.place ? ` in ${l.place}` : '';
  const ms = now - l.since;
  if (l.state === 'holds') return `${C.muted}■ holds ${what}${where} · ${duration(ms)}${C.reset}`;
  const jobs = l.jobs > 1 ? `${l.jobs} jobs` : 'a job';
  const pos = l.ahead === 0 ? 'next in line' : `${l.ahead} ahead`;
  const behind = l.behind?.length ? ` · behind ${l.behind.map((b) => `${b.who} (${duration(now - b.since)})`).join(', ')}` : '';
  return `${waitColor(ms)}▸ ${jobs}${where} waiting ${duration(ms)} for ${what}${C.reset}${C.muted} · ${pos}${behind}${C.reset}`;
}

/** The GPU lease and the CPU pool of each machine that has them: who holds, who waits. */
function boxLines(list, inner, rule, now) {
  const L = [];
  const many = list.length > 1 || list.some((b) => b.machine);
  for (const b of list) {
    const on = many ? ` ON ${(b.machine ?? 'this machine').toUpperCase()}` : '';
    for (const [kind, s] of [['GPU', b.gpu], ['CPU', b.cpu]]) {
      if (!s || (!s.held.length && !s.waiting.length && kind === 'CPU')) continue;
      const head = kind === 'GPU'
        ? `GPU${on} · ${s.held.length ? `${s.held.length} held` : 'free'}${s.jobsWaiting ? ` · ${s.jobsWaiting} waiting` : ''}`
        : `CPU POOL${on} · ${s.held.length} of ${s.slots} slots${s.jobsWaiting ? ` · ${s.jobsWaiting} waiting` : ''} · load ${Math.round(s.load)} on ${s.cores} cores`;
      L.push(rule(head));
      if (kind === 'GPU' && s.quarantined) L.push(`  ${C.critical}quarantined after a GPU fault${C.reset} ${C.muted}- gpu --enable once it is healthy${C.reset}`);
      const nameW = 20, placeW = 15;
      for (const h of s.held) {
        L.push(`  ${C.accent}■${C.reset} ${padEnd(truncate(h.session ?? h.project ?? '?', nameW), nameW + 1)}${C.muted}${padEnd(truncate(h.place ?? '', placeW), placeW + 1)}${C.reset}` +
          `${padEnd(duration(now - h.since), 8)}${C.muted}${truncate(h.cmd ?? '', Math.max(10, inner - nameW - placeW - 14))}${C.reset}`);
      }
      for (const w of s.waiting) {
        const ms = now - w.since;
        const pos = w.ahead === 0 ? 'next in line' : `${w.ahead} ahead`;
        L.push(`  ${waitColor(ms)}▸${C.reset} ${padEnd(truncate(w.session ?? w.project ?? '?', nameW), nameW + 1)}${C.muted}${padEnd(truncate(w.place ?? '', placeW), placeW + 1)}${C.reset}` +
          `${waitColor(ms)}${padEnd(duration(ms), 8)}${C.reset}${C.muted}${w.jobs > 1 ? `${w.jobs} jobs · ` : ''}${pos}${C.reset}`);
      }
      if (!s.held.length && !s.waiting.length) L.push(`  ${C.muted}nothing on the GPU${C.reset}`);
      if (kind === 'CPU' && s.waiting.length && s.held.length < s.slots && s.load >= s.cores) {
        L.push(`    ${C.muted}${s.slots - s.held.length === 1 ? 'a slot is' : 'slots are'} free, but jobs wait until the load drops under ${s.cores}${C.reset}`);
      }
      const h = kind === 'GPU' ? s.hour : null;
      if (h?.jobs) {
        const parts = [`${h.jobs} job${h.jobs === 1 ? '' : 's'} waited ${duration(h.waitedMs)} in all`];
        if (h.longestWait?.ms >= 60e3) parts.push(`longest wait ${duration(h.longestWait.ms)} (${h.longestWait.project})`);
        if (h.longestHold?.ms >= 60e3) parts.push(`longest hold ${duration(h.longestHold.ms)} (${h.longestHold.project})`);
        L.push(`    ${C.muted}last hour: ${parts.join(' · ')}${C.reset}`);
      }
      L.push('');
    }
  }
  return L;
}

/** Turns that re-wrote a lapsed cache: last day and week, subagents and main thread apart. */
function cacheLines(c, inner) {
  if (!c?.week?.turns) return [];
  const L = [];
  const barW = Math.max(6, Math.min(20, inner - 60));
  const row = (label, r) => `  ${padEnd(label, 12)}${meterBar(r.share * 100, barW, r.share >= 0.2 ? C.serious : C.accent)} ` +
    `${padEnd(`${Math.round(r.share * 100)}%`, 5)}${padEnd(money(r.cost), 9)}${C.muted}of ${money(r.spend)} spent · ${r.turns.toLocaleString()} turns${C.reset}`;
  L.push(row('last 24h', c.day));
  L.push(row('last 7 days', c.week));
  const ttl = (t) => (t === '1h' ? 'keep their cache an hour' : t === '5m' ? 'keep their cache 5 minutes' : '');
  L.push(`    ${C.muted}subagents   ${padEnd(money(c.week.sub.cost), 8)}${padEnd(`${c.week.sub.turns.toLocaleString()} turns`, 13)}${ttl(c.ttl?.sub)}${C.reset}`);
  L.push(`    ${C.muted}main thread ${padEnd(money(c.week.main.cost), 8)}${padEnd(`${c.week.main.turns.toLocaleString()} turns`, 13)}${ttl(c.ttl?.main)}${C.reset}`);
  if (c.hint) {
    L.push(`  ${C.warning}!${C.reset} Subagents re-write their whole context after any pause over 5 minutes.`);
    L.push(`    ${C.muted}Keep it an hour: ${C.reset}"${c.hint.setting}": "${c.hint.value}"${C.muted} in settings.json, or ${c.hint.env}=${c.hint.value}${C.reset}`);
  }
  return L;
}

/** The machines this one syncs with, for the header: bright while they report, dim once they stop. */
function syncMark(sync, now) {
  if (!sync) return '';
  const parts = sync.machines.map((m) => (m.online
    ? `${C.good}⇄${C.reset} ${m.name}`
    : `${C.muted}⇄ ${m.name} ${m.lastSeen ? duration(now - m.lastSeen) : 'never'}${C.reset}`));
  // A peer that has never answered has no machine to show yet - show why.
  for (const p of sync.peers) {
    if (p.status !== 'connected' && !sync.machines.length) parts.push(`${C.critical}⇄${C.reset} ${C.muted}${p.target}${C.reset}`);
  }
  return parts.join(' ');
}

export function startTui({ webUrl, onQuit }) {
  // The web dashboard's address, clickable where the terminal supports links.
  const url = /^https?:\/\/\S+/.exec(webUrl ?? '')?.[0] ?? null;
  const linkedUrl = url ? webUrl.replace(url, hyperlink(url, url)) : webUrl;
  const out = process.stdout;
  const state = {
    scroll: 0,
    windowType: 'five_hour',
    accountIdx: 0,      // 0 = all accounts
    live: true,
    lastRefresh: Date.now(),
    error: null,
    note: null,          // what a key just did, shown in the footer for a few seconds
    noteAt: 0,
    confirmSwitch: 0,    // when s was first pressed: a second press within 5s switches
  };

  let data = { overview: null, live: [], models: [], windows: [] };
  let slowAt = 0;

  // Accounts and running sessions refresh on every push. The history panels are
  // costlier and change slowly, so they refresh at most every 10s.
  function collect(force = false) {
    const ov = overview();
    const accounts = ov.accounts;
    const picked = state.accountIdx > 0 ? accounts[state.accountIdx - 1] : null;
    // With no account selected, chart the busiest one - a freshly added account
    // has only a single window and makes the history look broken.
    const focus = picked ?? [...accounts].sort((a, b) => b.totalEvents - a.totalEvents)[0];
    const slow = force || Date.now() - slowAt > 10_000;
    const live = liveSessions();
    data = {
      overview: ov,
      live,
      // Worked out here, not the service's copy: a key pressed here shows at once.
      plan: plan(ov, live),
      boxes: boxes(),
      cache: slow ? cacheSummary() : data.cache,
      models: slow ? modelBreakdown(7, picked?.accountUuid ?? null) : data.models,
      windows: slow ? (focus ? windowHistory(focus.accountUuid, state.windowType, 24) : []) : data.windows,
      focus,
    };
    if (slow) slowAt = Date.now();
  }

  /** Build the frame as an array of lines, each already fitted to `width`. */
  function frame(width, height) {
    const L = [];
    const inner = width - 4;
    const now = Date.now();
    const ov = data.overview;

    const ruleLine = (label) => {
      const text = label ? ` ${label} ` : '';
      const dashes = Math.max(0, inner - vlen(text));
      return `  ${C.muted}${text}${'─'.repeat(dashes)}${C.reset}`;
    };
    const rule = (label) => L.push(ruleLine(label));

    // ---- header
    const liveMark = state.live ? `${C.good}●${C.reset} live` : `${C.critical}●${C.reset} paused`;
    // When the numbers below were read - proof at a glance that they are moving.
    const stamp = `${C.muted}updated ${new Date(state.lastRefresh).toTimeString().slice(0, 8)}${C.reset}`;
    const left = `${A.bold}Claude Tracker${A.reset}`;
    const synced = syncMark(ov?.sync, now);
    let right = `${liveMark} ${C.muted}·${C.reset} ${stamp}${synced ? ` ${C.muted}·${C.reset} ${synced}` : ''} ${C.muted}·${C.reset} ${C.accent}${linkedUrl}${C.reset}`;
    // Too narrow for everything on one line: the machines go on the next.
    const wraps = synced && vlen(left) + 2 + vlen(right) > inner;
    if (wraps) right = `${liveMark} ${C.muted}·${C.reset} ${stamp} ${C.muted}·${C.reset} ${C.accent}${linkedUrl}${C.reset}`;
    L.push(`  ${padEnd(left, Math.max(0, inner - vlen(right)))}${right}`);
    L.push(wraps ? `  ${synced}` : '');

    if (!ov || !ov.accounts.length) {
      // Usage with no identifiable account is a real state, not an empty one -
      // saying "no data" here would contradict the web dashboard, which shows
      // the same usage perfectly well.
      const un = ov?.unattributed;
      if (un?.events) {
        L.push(`  ${C.muted}Usage found, but no account could be identified.${C.reset}`);
        L.push('');
        L.push(`  ${un.events.toLocaleString()} calls · ${money(un.cost)} tracked`);
        L.push('');
        L.push(`  ${C.muted}Sign in with Claude Code so a profile config exists, then press r.${C.reset}`);
      } else {
        L.push(`  ${C.muted}No usage data found yet.${C.reset}`);
        L.push('');
        L.push(`  ${C.muted}Looked in every Claude profile on this machine and found no${C.reset}`);
        L.push(`  ${C.muted}transcripts. Run Claude Code once, then press r.${C.reset}`);
      }
      return L;
    }

    // ---- hero: the tightest live limit anywhere
    let worst = null;
    for (const a of ov.accounts) {
      for (const l of a.limits) {
        if (!l.active && !l.blocked) continue;
        if (!worst || l.percent > worst.l.percent) worst = { a, l };
      }
    }
    if (worst) {
      const { a, l } = worst;
      const sev = severity(l.percent, l.blocked);
      L.push(`  ${C.muted}${l.label} · ${a.label}${C.reset}`);
      const head = l.blocked
        ? `${sev.color}${A.bold}LIMIT REACHED${A.reset}`
        : `${sev.color}${A.bold}${Math.round(l.percent)}% used${A.reset}`;
      const resets = `${C.muted}resets in${C.reset} ${duration(l.resetsInMs)}`;
      L.push(`  ${padEnd(head, 20)}${meterBar(l.percent, Math.max(10, inner - 44), sev.color)}  ${resets}`);
      if (l.exhaustsAt) {
        L.push(`  ${C.warning}↳ at the current burn this fills in ${duration(l.exhaustsAt - now)}${C.reset}`);
      }
      L.push('');
    }

    // ---- which account to use right now
    const rec = ov.recommendation;
    if (rec) {
      const how = rec.command
        ? `  ${C.accent}${rec.command}${C.reset}${rec.machine ? `${C.muted} on ${rec.machine}${C.reset}` : ''}`
        : `  ${C.muted}${rec.note}${C.reset}`;
      L.push(`  ${C.good}USE NOW${C.reset}  ${A.bold}${rec.label}${A.reset}  ` +
        `${C.muted}${Math.round(rec.headroom)}% headroom${rec.exact ? '' : ' (est)'}${C.reset}${how}`);
    } else {
      L.push(`  ${C.critical}Every account is refused right now${C.reset} ${C.muted}- see resets below${C.reset}`);
    }
    for (const line of failoverLines({ ...ov.failover, ...failoverSettings(), plan: data.plan }, ov.sync?.name, now)) L.push(line);
    L.push('');

    // ---- running now, each with the account it is billing *right now*
    const carried = data.live.reduce((a, x) => a + (x.context?.tokens ?? 0), 0);
    rule(`RUNNING NOW · ${data.live.length} session${data.live.length === 1 ? '' : 's'}${carried ? ` · ${tokens(carried)} context a turn in all` : ''}`);
    // What each session carries into a turn, its subagents at work, and how
    // often its cache lapsed this hour - with room made for them first.
    const wide = inner >= 96;
    const AGENTS = 7, RECACHE = 13;
    const extraW = wide ? 1 + AGENTS + RECACHE : 1;
    // The account column gives way to the machine name, not the other way round.
    const whoWidth = (machine) => Math.max(12, Math.min(30, inner - 22 - 14 - extraW - 18 - (machine ? machine.length + 3 : 0)));
    if (data.live.some((x) => x.context)) {
      const w = whoWidth(null);
      L.push(`  ${C.muted}${' '.repeat(23)}${padEnd('', w + 1)}${padEnd('context', 14)}${wide ? `${padEnd('agents', AGENTS)}${padEnd('↻ last hour', RECACHE)}` : ''}${C.reset}`);
    }
    const shown = data.live.slice(0, 10);
    for (const s of shown) {
      const busy = s.status === 'busy';
      const dot = busy ? `${C.warning}●${C.reset}` : `${C.muted}○${C.reset}`;
      const ago = s.lastActivityAt ? duration(now - s.lastActivityAt) : '—';
      const burn = s.recent.calls ? `${money(s.recent.cost)}/5m` : '';
      const who = s.account ? `${s.account}${s.background ? ' (bg)' : ''}` : 'unknown account';
      const name = s.name || s.sessionId.slice(0, 8);
      const tail = `${C.muted}${padEnd(ago, 6)}${C.reset} ${padEnd(burn, 10)}${s.machine ? `${C.muted}on ${s.machine}${C.reset}` : ''}`;
      // Context: the figure, and a bar up to where Claude Code compacts.
      const c = s.context;
      const ctx = c ? `${contextColor(c.tokens)}${padEnd(tokens(c.tokens), 5)}${C.reset}${meterBar((c.tokens / c.compactAt) * 100, 8, contextColor(c.tokens))}` : `${C.muted}${padEnd('—', 13)}${C.reset}`;
      const agents = s.agents?.length ? `${C.muted}+${s.agents.length}${C.reset}` : '';
      const re = s.recache?.turns ? `${s.recache.cost >= 10 ? C.serious : C.muted}↻${s.recache.turns} ${money(s.recache.cost)}${C.reset}` : '';
      const extra = wide ? ` ${padEnd(agents, AGENTS)}${padEnd(re, RECACHE)}` : ' ';
      const whoW = whoWidth(s.machine);
      L.push(`  ${dot} ${padEnd(truncate(name, 20), 21)}${C.accent}${padEnd(truncate(who, whoW), whoW + 1)}${C.reset}${ctx}${extra}${tail}`);
      for (const l of s.leases ?? []) L.push(`      ${leaseLine(l, now)}`);
    }
    if (data.live.length > shown.length) L.push(`    ${C.muted}+${data.live.length - shown.length} more${C.reset}`);
    if (!data.live.length) L.push(`  ${C.muted}no Claude Code sessions running${C.reset}`);
    L.push('');

    // ---- the shared GPU and CPU pool
    for (const line of boxLines(data.boxes ?? [], inner, ruleLine, now)) L.push(line);

    // ---- accounts
    rule('ACCOUNTS');
    L.push('');
    // In use here: green. In use only on another synced machine: blue. With
    // machines to tell apart, each account says which it is in use on.
    const using = inUse(ov, data.live);
    const machines = ov.sync?.machines.length > 0;
    for (const a of ov.accounts) {
      const where = using.get(a.accountUuid) ?? [];
      const mark = where.includes(null) ? `${C.good}●${C.reset}` : where.length ? `${C.accent}●${C.reset}` : `${C.muted}○${C.reset}`;
      const on = machines && where.length ? `${C.muted}on ${where.map((m) => m ?? ov.sync.name).join(', ')}${C.reset} ` : '';
      const tier = a.tier ? `${C.muted}${a.tier.replace('default_claude_', '').replace(/_/g, ' ')}${C.reset}` : '';
      const exact = a.limits.some((l) => l.confidence === 'exact') ? `${C.good}exact${C.reset} ${C.muted}·${C.reset} ` : '';
      const stats = `${exact}${C.muted}${money(a.totalCost)} · ${a.sessions} session${a.sessions === 1 ? '' : 's'}${C.reset}`;
      // An account that cannot take a request says when it can again.
      const out = a.available.now ? ''
        : `${C.critical}${a.available.sure ? '' : '≈ '}out until ${clockAt(a.available.at, now)}${C.reset} `;
      const name = `${mark} ${A.bold}${a.label}${A.reset} ${out}${on}${tier}`;
      L.push(`  ${padEnd(truncate(name, inner - vlen(stats) - 2), inner - vlen(stats))}${stats}`);

      // Budget the row explicitly, then give the bar whatever is left. Widths
      // are computed once per card so every bar in it starts and ends on the
      // same column - ragged bars are much harder to compare at a glance. The
      // severity word is what keeps colour from carrying meaning alone, so it
      // outranks the bar and the reset clock when space runs short.
      const LABEL = 14, PCT = 4, GAPS = 4;
      const rows = a.limits.map((l) => ({
        l,
        sev: severity(l.percent, l.blocked),
        when: l.blocked || l.active ? `resets ${duration(l.resetsInMs)}` : 'idle',
      }));
      // Fixed to the longest severity word so bars align across every card,
      // not just within one.
      const wordW = 13;
      let whenW = Math.max(16, ...rows.map((r) => r.when.length));
      let barW = inner - 4 - LABEL - PCT - GAPS - whenW - wordW;
      if (barW < 8) {
        whenW = Math.max(...rows.map((r) => r.when.length));
        barW = inner - 4 - LABEL - PCT - GAPS - whenW - wordW;
      }
      const showWhen = barW >= 6;
      if (!showWhen) barW = Math.max(4, inner - 4 - LABEL - PCT - GAPS - wordW);

      for (const { l, sev, when } of rows) {
        L.push([
          `    ${C.muted}${padEnd(l.label, LABEL)}${C.reset}`,
          meterBar(l.percent, barW, sev.color),
          `${sev.color}${String(Math.round(l.percent)).padStart(3)}%${C.reset}${l.confidence === 'measured' || l.confidence === 'exact' ? ' ' : `${C.muted}≈${C.reset}`}`,
          showWhen ? `${C.muted}${padEnd(when, whenW)}${C.reset}` : '',
          `${sev.color}${sev.word}${C.reset}`,
        ].filter(Boolean).join(' '));
      }

      if (a.billing) {
        const when = new Date(a.billing.end).toLocaleDateString([], { month: 'short', day: 'numeric' });
        L.push(`    ${C.muted}${padEnd('Renews', 14)} ${when} · in ${duration(a.billing.renewsInMs)} ` +
          `· ${money(a.billing.spend.cost)} used this period ${C.muted}(est)${C.reset}`);
      }

      const NOTE = {
        partial: 'from a single observed limit — approximate',
        tier: 'borrowed from another account on the same plan',
        default: 'estimated — no limit observed anywhere yet',
      };
      const carried = a.limits.filter((l) => l.confidence === 'carried');
      if (carried.length) {
        const age = Math.max(...carried.map((l) => now - (l.exactAt ?? now)));
        L.push(`    ${C.muted}${carried.map((l) => l.label).join(' + ')}: Claude Code's reading ${duration(age)} ago, plus the calls made since (≈)${C.reset}`);
      }
      const soft = a.limits.filter((l) => !['measured', 'exact', 'carried'].includes(l.confidence));
      if (soft.length) {
        // Group so two limits sharing a confidence produce one line, not two.
        const seen = new Set();
        for (const l of soft) {
          if (seen.has(l.confidence)) continue;
          seen.add(l.confidence);
          const same = soft.filter((x) => x.confidence === l.confidence);
          const which = same.length === a.limits.length
            ? 'Both ceilings'
            : `${same.map((x) => x.label).join(' + ')} ceiling`;
          L.push(`    ${C.muted}${which} ${NOTE[l.confidence] ?? 'estimated'}${C.reset}`);
        }
      }
      L.push('');
    }

    // ---- window history
    const typeName = state.windowType === 'five_hour' ? 'Session (5h)' : 'Weekly (7d)';
    rule(`RECENT ${typeName.toUpperCase()} WINDOWS  ·  ${data.focus?.label ?? ''}`);
    L.push('');
    if (data.windows.length) {
      const pcts = [...data.windows].reverse().map((w) => w.percent);
      L.push(`  ${sparkline(pcts, 100)}  ${C.muted}oldest → newest, full scale = 100%${C.reset}`);
      const last = data.windows[0];
      L.push(`  ${C.muted}latest ${money(last.cost)} (${Math.round(last.percent)}%) · ${compact(last.events)} calls${C.reset}`);
    } else {
      L.push(`  ${C.muted}no windows recorded yet${C.reset}`);
    }
    L.push('');

    // ---- models
    rule('BY MODEL · LAST 7 DAYS');
    L.push('');
    const total = data.models.reduce((s, m) => s + m.cost, 0) || 1;
    for (const m of data.models.slice(0, 5)) {
      const share = (m.cost / total) * 100;
      const barW = Math.max(6, Math.min(20, inner - 46));
      const shareText = share > 0 && share < 1 ? '<1%' : `${share.toFixed(0)}%`;
      L.push(`  ${padEnd(m.label, 14)} ${meterBar(share, barW, C.accent)} ` +
        `${padEnd(shareText, 5)} ${padEnd(money(m.cost), 9)}${C.muted}${compact(m.events)} calls${C.reset}`);
    }
    if (!data.models.length) L.push(`  ${C.muted}no usage in the last 7 days${C.reset}`);
    L.push('');

    // ---- re-caching
    const cache = cacheLines(data.cache, inner);
    if (cache.length) {
      rule('CACHE RE-WRITTEN AFTER A PAUSE');
      L.push('');
      for (const line of cache) L.push(line);
      L.push('');
    }

    if (ov.unattributed.events) {
      L.push(`  ${C.muted}${ov.unattributed.events.toLocaleString()} events (${money(ov.unattributed.cost)}) not tied to an account${C.reset}`);
      L.push('');
    }

    return L;
  }

  function render() {
    const width = Math.max(60, out.columns || 80);
    const height = Math.max(12, out.rows || 24);
    const body = frame(width, height);

    const age = Math.round((Date.now() - state.lastRefresh) / 1000);
    const noted = state.note && Date.now() - state.noteAt < 6000;
    const footer = state.error
      ? `  ${C.critical}refresh failed:${C.reset} ${state.error} ${C.muted}· showing data from ${age}s ago · r to retry${C.reset}`
      : noted ? `  ${state.note}`
        : `  ${C.muted}q${C.reset} quit  ${C.muted}r${C.reset} refresh  ` +
          `${C.muted}a${C.reset} account  ${C.muted}w${C.reset} window  ${C.muted}↑↓${C.reset} scroll` +
          (url ? `  ${C.muted}o${C.reset} open web` : '') +
          `  ${C.muted}f${C.reset} failover  ${C.muted}t${C.reset} switch to  ${C.muted}+/-${C.reset} at  ${C.muted}s${C.reset} switch now  ${C.muted}e${C.reset} export` +
          (state.live ? '' : `  ${C.warning}paused${C.reset}`);

    const viewH = height - 2;
    const maxScroll = Math.max(0, body.length - viewH);
    state.scroll = Math.min(state.scroll, maxScroll);
    const slice = body.slice(state.scroll, state.scroll + viewH);
    while (slice.length < viewH) slice.push('');

    // One write per frame: no tearing, no flicker.
    const lines = slice.map((l) => truncate(l, width) + `${ESC}K`);
    lines.push(truncate(footer, width) + `${ESC}K`);
    out.write(A.home + lines.join('\n') + A.reset);
  }

  function refreshAndRender(force = false) {
    try {
      collect(force);
      state.error = null;
      state.lastRefresh = Date.now();
    } catch (err) {
      // Keep the last good frame, but say so - silently serving stale numbers
      // is worse than an ugly footer, because it looks like nothing changed.
      state.error = err.message;
    }
    render();
  }

  // ---- input
  const stdin = process.stdin;
  const rawCapable = stdin.isTTY;
  if (rawCapable) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
  }

  const say = (note) => { state.note = note; state.noteAt = Date.now(); };

  /** Failover, from the keyboard: on and off, the threshold, the account it goes to, and switching now. */
  function failoverKey(key) {
    const s = failoverSettings();
    if (key === 'f') {
      const next = setFailover({ mode: s.mode === 'auto' ? 'off' : 'auto' });
      say(next.mode === 'auto' ? `${C.good}failover on${C.reset} at ${next.at}%` : `${C.warning}failover off${C.reset} - nothing switches by itself`);
    } else if (key === '+' || key === '=' || key === '-') {
      const at = Math.max(50, Math.min(100, s.at + (key === '-' ? -5 : 5)));
      setFailover({ at });
      say(`switches at ${at}%`);
    } else if (key === 't') {
      // Cycle: choose by room, then each account a spare holds that has room to switch to, then back.
      const byUuid = new Map((data.overview?.accounts ?? []).map((a) => [a.accountUuid, a]));
      const held = spares().filter((x) => x.email && headroom(byUuid.get(x.accountUuid)) >= MIN_ROOM).map((x) => x.email.toLowerCase()).sort();
      const i = s.prefer ? held.indexOf(s.prefer) : -1;
      const next = i + 1 < held.length ? held[i + 1] : null;
      setFailover({ prefer: next });
      say(next ? `switches to ${C.accent}${next}${C.reset} while it has room - t for the next` : 'switches to the spare with the most room');
    } else if (key === 's') {
      const e = data.plan?.entries.find((x) => x.isDefault) ?? data.plan?.entries[0];
      if (!e?.target) { say(`${C.critical}nothing to switch to${C.reset}`); return; }
      if (Date.now() - state.confirmSwitch > 5000) {
        state.confirmSwitch = Date.now();
        say(`${C.warning}s again${C.reset} to switch ${e.profile} from ${e.label} to ${e.target.label} now`);
        return;
      }
      state.confirmSwitch = 0;
      const r = switchProfile(e, e.target);
      say(r.status === 'switched'
        ? `${C.good}switched${C.reset} ${e.profile} to ${e.target.label} - its sessions carry on as it within about 30s`
        : `${C.critical}could not switch:${C.reset} ${r.error}`);
    }
  }

  const onKey = (key) => {
    const accounts = data.overview?.accounts ?? [];
    switch (key) {
      case 'q': case '': quit(); return;
      case 'r': refreshAndRender(true); return;
      case 'o': if (url) openUrl(url); return;
      case 'a':
        state.accountIdx = (state.accountIdx + 1) % (accounts.length + 1);
        refreshAndRender(true); return;
      case 'w':
        state.windowType = state.windowType === 'five_hour' ? 'seven_day' : 'five_hour';
        refreshAndRender(true); return;
      case ' ':
        state.live = !state.live; render(); return;
      case '[A': case 'k': state.scroll = Math.max(0, state.scroll - 1); render(); return;
      case '[B': case 'j': state.scroll += 1; render(); return;
      case '[5~': state.scroll = Math.max(0, state.scroll - 10); render(); return;
      case '[6~': state.scroll += 10; render(); return;
      case 'g': state.scroll = 0; render(); return;
      case 'e':
        import('./export.js').then(({ exportAccounts }) => {
          try {
            const r = exportAccounts();
            say(`${C.good}exported${C.reset} ${r.count} accounts to ${r.shown} ${C.muted}- Google Sheets: File → Import → Upload${C.reset}`);
          } catch (err) { say(`${C.critical}could not export:${C.reset} ${err.message}`); }
          render();
        });
        return;
      case 'f': case 't': case '+': case '=': case '-': case 's':
        try { failoverKey(key); } catch (err) { say(`${C.critical}${err.message}${C.reset}`); }
        refreshAndRender(); return;
      default: return;
    }
  };
  if (rawCapable) stdin.on('data', onKey);

  const onResize = () => render();
  out.on('resize', onResize);

  // Countdown ticks once a second; the numbers move without refetching.
  const tick = setInterval(() => { if (state.live) render(); }, 1000);
  // Periodic full recompute so window rollovers land even without a file event.
  const slow = setInterval(() => { if (state.live) refreshAndRender(); }, 30_000);

  let done = false;
  function quit() {
    if (done) return;
    done = true;
    clearInterval(tick);
    clearInterval(slow);
    out.off('resize', onResize);
    if (rawCapable) {
      stdin.off('data', onKey);
      try { stdin.setRawMode(false); } catch { /* already restored */ }
      stdin.pause();
    }
    out.write(A.show + A.unalt);
    onQuit?.();
  }

  out.write(A.alt + A.hide + A.clear);
  refreshAndRender();

  return {
    /** Called by the watcher when new usage lands. */
    update() { if (state.live) refreshAndRender(); },
    /** Surface a background failure rather than quietly showing stale numbers. */
    reportError(message) { state.error = message; render(); },
    stop: quit,
  };
}
