import { overview, liveSessions, modelBreakdown, windowHistory } from './api.js';

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const vlen = (s) => s.replace(ANSI_RE, '').length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));
const truncate = (s, n) => {
  if (vlen(s) <= n) return s;
  // Walk the string keeping escape sequences intact while counting visible chars.
  let out = '', seen = 0, i = 0;
  while (i < s.length && seen < n) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i]; seen++; i++;
  }
  return out + A.reset;
};

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

export function startTui({ webUrl, onQuit }) {
  const out = process.stdout;
  const state = {
    scroll: 0,
    windowType: 'five_hour',
    accountIdx: 0,      // 0 = all accounts
    live: true,
    lastRefresh: Date.now(),
    error: null,
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
    data = {
      overview: ov,
      live: liveSessions(),
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

    const rule = (label) => {
      const text = label ? ` ${label} ` : '';
      const dashes = Math.max(0, inner - vlen(text));
      L.push(`  ${C.muted}${text}${'─'.repeat(dashes)}${C.reset}`);
    };

    // ---- header
    const liveMark = state.live ? `${C.good}●${C.reset} live` : `${C.critical}●${C.reset} paused`;
    // When the numbers below were read - proof at a glance that they are moving.
    const stamp = `${C.muted}updated ${new Date(state.lastRefresh).toTimeString().slice(0, 8)}${C.reset}`;
    const right = `${liveMark} ${C.muted}·${C.reset} ${stamp} ${C.muted}·${C.reset} ${C.accent}${webUrl}${C.reset}`;
    const left = `${A.bold}Claude Tracker${A.reset}`;
    L.push(`  ${padEnd(left, Math.max(0, inner - vlen(right)))}${right}`);
    L.push('');

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
      const how = rec.command ? `  ${C.accent}${rec.command}${C.reset}` : `  ${C.muted}${rec.note}${C.reset}`;
      L.push(`  ${C.good}USE NOW${C.reset}  ${A.bold}${rec.label}${A.reset}  ` +
        `${C.muted}${Math.round(rec.headroom)}% headroom${rec.exact ? '' : ' (est)'}${C.reset}${how}`);
    } else {
      L.push(`  ${C.critical}Every account is refused right now${C.reset} ${C.muted}- see resets below${C.reset}`);
    }
    L.push('');

    // ---- running now, each with the account it is billing *right now*
    rule(`RUNNING NOW · ${data.live.length} session${data.live.length === 1 ? '' : 's'}`);
    const shown = data.live.slice(0, 10);
    for (const s of shown) {
      const busy = s.status === 'busy';
      const dot = busy ? `${C.warning}●${C.reset}` : `${C.muted}○${C.reset}`;
      const ago = s.lastActivityAt ? duration(now - s.lastActivityAt) : '—';
      const burn = s.recent.calls ? `${money(s.recent.cost)}/5m` : '';
      const who = s.account ? `${s.account}${s.background ? ' (bg)' : ''}` : 'unknown account';
      const name = s.name || s.sessionId.slice(0, 8);
      const tail = `${C.muted}${padEnd(ago, 6)}${C.reset} ${padEnd(burn, 10)}`;
      const whoW = Math.max(12, Math.min(30, inner - 22 - 18));
      L.push(`  ${dot} ${padEnd(truncate(name, 20), 21)}${C.accent}${padEnd(truncate(who, whoW), whoW + 1)}${C.reset}${tail}`);
    }
    if (data.live.length > shown.length) L.push(`    ${C.muted}+${data.live.length - shown.length} more${C.reset}`);
    if (!data.live.length) L.push(`  ${C.muted}no Claude Code sessions running${C.reset}`);
    L.push('');

    // ---- accounts
    rule('ACCOUNTS');
    L.push('');
    for (const a of ov.accounts) {
      const mark = a.isCurrent ? `${C.good}●${C.reset}` : `${C.muted}○${C.reset}`;
      const tier = a.tier ? `${C.muted}${a.tier.replace('default_claude_', '').replace(/_/g, ' ')}${C.reset}` : '';
      const exact = a.limits.some((l) => l.confidence === 'exact') ? `${C.good}exact${C.reset} ${C.muted}·${C.reset} ` : '';
      const stats = `${exact}${C.muted}${money(a.totalCost)} · ${a.sessions} session${a.sessions === 1 ? '' : 's'}${C.reset}`;
      const name = `${mark} ${A.bold}${a.label}${A.reset} ${tier}`;
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
      const soft = a.limits.filter((l) => l.confidence !== 'measured' && l.confidence !== 'exact');
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
    const footer = state.error
      ? `  ${C.critical}refresh failed:${C.reset} ${state.error} ${C.muted}· showing data from ${age}s ago · r to retry${C.reset}`
      : `  ${C.muted}q${C.reset} quit  ${C.muted}r${C.reset} refresh  ` +
        `${C.muted}a${C.reset} account  ${C.muted}w${C.reset} window  ${C.muted}↑↓${C.reset} scroll` +
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

  const onKey = (key) => {
    const accounts = data.overview?.accounts ?? [];
    switch (key) {
      case 'q': case '': quit(); return;
      case 'r': refreshAndRender(true); return;
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
