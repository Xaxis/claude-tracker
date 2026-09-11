import { ingestAll, ingestPaths } from './ingest.js';
import { ingestLive } from './live.js';
import {
  discoverAccounts, attributeSessions, attributeLimitEvents,
  listAccounts, accountLabel, resolveAccountEmails, setLabel, attributeEvents,
} from './accounts.js';
import { calibrateAll, verifyWindowModel } from './calibrate.js';
import { overview, modelBreakdown, liveSessions } from './api.js';
import { LIMIT_TYPES, resetWindowCache, earliestCachedChain } from './windows.js';
import { invalidateAggregates, aggregatesCutoff } from './aggregates.js';
import { closeDb } from './db.js';
import { DATA_DIR, DB_PATH } from './paths.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = new Proxy(C, { get: (t, k) => (useColor ? t[k] ?? '' : '') });

const money = (n) => `$${n.toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);

function duration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function bar(percent, width = 28) {
  const filled = Math.round((Math.min(100, percent) / 100) * width);
  const color = percent >= 90 ? c.red : percent >= 70 ? c.yellow : c.green;
  return `${color}${'█'.repeat(filled)}${c.gray}${'░'.repeat(width - filled)}${c.reset}`;
}

/** Full refresh: read new transcript data, then re-derive everything from it. */
async function refresh({ quiet = false, force = false, reattribute = 'recent' } = {}) {
  const t0 = Date.now();
  discoverAccounts();
  let last = 0;
  const res = await ingestAll({
    force,
    onProgress: (done, total) => {
      if (quiet || !process.stdout.isTTY) return;
      const now = Date.now();
      if (now - last < 120 && done !== total) return;
      last = now;
      process.stdout.write(`\r${c.dim}scanning ${done}/${total} transcripts${c.reset}   `);
    },
  });
  if (!quiet && process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
  attributeSessions();
  attributeLimitEvents();
  resolveAccountEmails();
  // Per-call attribution. A full pass on startup and explicit ingests; otherwise
  // re-check the last six hours so late-arriving identity records still land.
  const a = attributeEvents(reattribute === 'all' ? { all: true } : { since: Date.now() - 6 * 3600_000 });
  const live = ingestLive();
  invalidateCaches(reattribute === 'all', res.minNewTs, a.minChangedTs, live.oldest);
  calibrateAll();
  return { ...res, ms: Date.now() - t0 };
}

/**
 * The live path, run on every burst of transcript writes.
 *
 * Reads only the files that changed and re-attributes only recent calls - no
 * directory walk, no keychain, no recalibration. It has to stay cheap enough to
 * run several times a second while dozens of sessions are writing at once.
 */
async function fastRefresh(paths = []) {
  const t0 = Date.now();
  const r = paths.length ? await ingestPaths(paths) : { scanned: 0, newEvents: 0 };
  const a = attributeEvents({ since: Date.now() - 10 * 60_000, includeNull: false });
  const live = ingestLive();
  invalidateCaches(false, r.minNewTs, a.minChangedTs, live.oldest);
  return { ...r, attributed: a.changed, exact: live.samples, ms: Date.now() - t0 };
}

/**
 * Drop the cached window chains and account totals only when something they
 * were built from changed - a new or re-attributed call older than what they
 * already cover. Dropping them on every rescan made the next read rebuild whole
 * histories once a minute.
 */
function invalidateCaches(all, ...times) {
  const touched = Math.min(...times.map((t) => t ?? Infinity));
  if (all || touched < earliestCachedChain()) resetWindowCache();
  if (all || touched < aggregatesCutoff()) invalidateAggregates();
}

function cmdStatus() {
  const o = overview();
  console.log();
  console.log(`${c.bold}Claude usage${c.reset} ${c.dim}· ${new Date(o.now).toLocaleString()}${c.reset}`);
  console.log();

  if (!o.accounts.length) {
    console.log(`  ${c.dim}No accounts found yet. Run ${c.reset}claude-tracker ingest${c.dim} first.${c.reset}\n`);
    return;
  }

  for (const a of o.accounts) {
    const marker = a.isCurrent ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
    const tier = a.tier ? ` ${c.dim}${a.tier.replace('default_claude_', '')}${c.reset}` : '';
    console.log(`${marker} ${c.bold}${a.label}${c.reset}${tier}  ${c.dim}${money(a.totalCost)} tracked · ${a.sessions} session${a.sessions === 1 ? '' : 's'}${c.reset}`);
    for (const l of a.limits) {
      const blocked = l.blocked ? ` ${c.red}LIMIT HIT${c.reset}` : '';
      const conf = l.confidence === 'default' ? `${c.dim}(est)${c.reset}` : l.confidence === 'partial' ? `${c.dim}(~)${c.reset}` : '';
      const state = l.active || l.blocked
        ? `resets in ${duration(l.resetsInMs)}`
        : `${c.dim}idle${c.reset}`;
      console.log(`    ${pad(l.label, 14)} ${bar(l.percent)} ${pad(l.percent.toFixed(0) + '%', 5)} ${pad(state, 22)} ${conf}${blocked}`);
      if (l.exhaustsAt) {
        console.log(`    ${' '.repeat(14)} ${c.yellow}↳ at current burn, full in ${duration(l.exhaustsAt - o.now)}${c.reset}`);
      }
    }
    console.log();
  }

  if (o.unattributed.events) {
    console.log(`  ${c.dim}${o.unattributed.events.toLocaleString()} events (${money(o.unattributed.cost)}) could not be tied to an account.${c.reset}`);
  }
  const rec = o.recommendation;
  if (rec) {
    const how = rec.command ? `  ${c.dim}→${c.reset} ${rec.command}` : `  ${c.dim}(${rec.note})${c.reset}`;
    console.log(`  ${c.green}Use now:${c.reset} ${c.bold}${rec.label}${c.reset} ${c.dim}${Math.round(rec.headroom)}% headroom${rec.exact ? '' : ' (est)'}${c.reset}${how}`);
  } else {
    console.log(`  ${c.red}Every account is refused right now.${c.reset}`);
  }
  const live = liveSessions();
  if (live.length) {
    console.log(`  ${c.cyan}${live.length}${c.reset} ${c.dim}Claude Code session${live.length === 1 ? '' : 's'} running now${c.reset}`);
  }
  console.log();
}

function cmdAccounts() {
  const rows = listAccounts();
  console.log();
  let anonymous = 0;
  for (const a of rows) {
    const named = a.label || a.email || a.display_name;
    if (!named) anonymous++;
    console.log(`${c.bold}${accountLabel(a)}${c.reset}`);
    console.log(`  ${c.dim}uuid${c.reset}     ${a.account_uuid}`);
    if (a.org_name) console.log(`  ${c.dim}org${c.reset}      ${a.org_name}`);
    if (a.rate_limit_tier) console.log(`  ${c.dim}tier${c.reset}     ${a.rate_limit_tier}`);
    console.log(`  ${c.dim}sessions${c.reset} ${a.sessions}`);
    if (!named) {
      console.log(`  ${c.dim}name it${c.reset}  claude-tracker label ${a.account_uuid.slice(0, 8)} "some name"`);
    }
    console.log();
  }
  if (!rows.length) { console.log(`  ${c.dim}none discovered${c.reset}\n`); return; }
  if (anonymous) {
    console.log(`${c.dim}${anonymous} account${anonymous === 1 ? '' : 's'} without a name. Claude only records the`);
    console.log(`email of the account signed in at the time, and only in recent versions —`);
    console.log(`older sessions leave a UUID. Sign in to one and it names itself, or set`);
    console.log(`a label by hand.${c.reset}\n`);
  }
}

function cmdLabel(rest) {
  const [prefix, ...words] = rest;
  if (!prefix) {
    console.error('usage: claude-tracker label <uuid-prefix> "display name"');
    process.exitCode = 1;
    return;
  }
  const uuid = setLabel(prefix, words.join(' '));
  if (!uuid) {
    console.error(`No account starts with "${prefix}". Run: claude-tracker accounts`);
    process.exitCode = 1;
    return;
  }
  console.log(words.length
    ? `${c.green}✓${c.reset} ${uuid.slice(0, 8)}… is now "${words.join(' ')}"`
    : `${c.green}✓${c.reset} cleared the label on ${uuid.slice(0, 8)}…`);
}

function cmdModels(days) {
  const rows = modelBreakdown(days);
  console.log(`\n${c.bold}Model usage${c.reset} ${c.dim}· last ${days} days${c.reset}\n`);
  const total = rows.reduce((a, r) => a + r.cost, 0) || 1;
  for (const r of rows) {
    const share = (r.cost / total) * 100;
    console.log(`  ${pad(r.label, 14)} ${bar(share, 20)} ${pad(share.toFixed(1) + '%', 7)} ${pad(money(r.cost), 10)} ${c.dim}${r.events.toLocaleString()} calls${c.reset}`);
  }
  console.log(`\n  ${c.dim}total${c.reset} ${money(total)}\n`);
}

function cmdVerify() {
  const rows = verifyWindowModel();
  console.log(`\n${c.bold}Window model check${c.reset} ${c.dim}· reconstructed boundaries vs. reset times the API reported${c.reset}\n`);
  if (!rows.length) {
    console.log(`  ${c.dim}No rate-limit events recorded yet - nothing to check against.${c.reset}\n`);
    return;
  }
  let ok = 0;
  for (const r of rows) {
    const good = r.withinGrain;
    if (good) ok++;
    const mark = good ? `${c.green}✓${c.reset}` : `${c.yellow}~${c.reset}`;
    const off = r.deltaMs == null ? '—' : `${Math.round(r.deltaMs / 60000)}m off`;
    console.log(`  ${mark} ${pad(LIMIT_TYPES[r.type].label, 14)} reset ${new Date(r.resetsAt).toLocaleString()}  ${c.dim}${pad(off, 10)} window=${money(r.windowCost)}${c.reset}`);
  }
  console.log(`\n  ${ok}/${rows.length} reset times matched a reconstructed window boundary.\n`);
}

async function cmdStatusline(action, flags) {
  const { installStatusLine, uninstallStatusLine, statusLineState } = await import('./statusline.js');
  if (action === 'install' || action === 'uninstall') {
    const res = action === 'install' ? installStatusLine({ force: !!flags.force }) : uninstallStatusLine();
    for (const r of res) console.log(`  ${pad(r.profile, 20)} ${r.result}${r.reason ? ` ${c.dim}- ${r.reason}${c.reset}` : ''}`);
    if (action === 'install') console.log(`\n${c.dim}New and running Claude Code sessions pick it up on their next render; the tracker then shows exact numbers.${c.reset}`);
    return;
  }
  for (const r of statusLineState()) console.log(`  ${pad(r.profile, 20)} ${r.state}`);
}

async function cmdService(action, flags) {
  const { installService, uninstallService, serviceStatus } = await import('./service.js');
  if (action === 'install') {
    const r = installService({ port: Number(flags.port ?? 4785) });
    console.log(`${c.green}✓${c.reset} running at login - ${r.url}\n  ${c.dim}log: ${r.log}${c.reset}`);
  } else if (action === 'uninstall') {
    console.log(uninstallService().removed ? `${c.green}✓${c.reset} removed` : 'not installed');
  } else {
    const s = serviceStatus();
    console.log(s.installed ? `installed · ${s.state ?? 'not loaded'}${s.pid ? ` · pid ${s.pid}` : ''}\n  ${c.dim}log: ${s.log}${c.reset}` : 'not installed');
  }
}

function help() {
  console.log(`
${c.bold}claude-tracker${c.reset} — local usage and rate-limit tracking for Claude accounts

  ${c.bold}serve${c.reset} [--port N] [--open]   live terminal dashboard + web dashboard (default)
        ${c.dim}--no-tui${c.reset}              web dashboard only
        ${c.dim}--no-web${c.reset}              terminal dashboard only
  ${c.bold}tui${c.reset}                         terminal dashboard alone, no HTTP server
  ${c.bold}status${c.reset}                      one-shot limit status for every account
  ${c.bold}ingest${c.reset} [--force]            read new transcript data
  ${c.bold}accounts${c.reset}                    list discovered accounts
  ${c.bold}label${c.reset} <uuid-prefix> <name>  give an account a readable name
  ${c.bold}models${c.reset} [--days N]           per-model usage breakdown
  ${c.bold}verify${c.reset}                      check the window model against observed resets
  ${c.bold}where${c.reset}                       print data locations
  ${c.bold}statusline${c.reset} install|uninstall  exact limits via each profile's status line
  ${c.bold}service${c.reset} install|uninstall     run in the background at login (macOS)

${c.dim}In the terminal dashboard: q quit · r refresh · a cycle account · w switch
window · space pause · ↑↓/jk scroll${c.reset}

${c.dim}Data is read from your local Claude transcripts. Nothing is uploaded.${c.reset}
`);
}

function parseArgs(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

/**
 * Commands that keep running after `serve()` resolves. Their database must stay
 * open - a `return` inside the try below still runs the `finally`, so closing it
 * there would pull the connection out from under a live dashboard.
 */
const LONG_RUNNING = new Set(['serve', 'dash', 'tui']);

export async function runCli(argv) {
  const { flags, rest } = parseArgs(argv);
  const cmd = rest[0] ?? 'serve';

  try {
    switch (cmd) {
      case 'ingest': {
        const r = await refresh({ force: !!flags.force, reattribute: 'all' });
        console.log(`${c.green}✓${c.reset} ${r.scanned} transcripts read (${r.skipped} unchanged), ` +
          `${r.newEvents.toLocaleString()} new events in ${(r.ms / 1000).toFixed(1)}s`);
        break;
      }
      case 'status': await refresh({ quiet: true }); cmdStatus(); break;
      case 'accounts': await refresh({ quiet: true }); cmdAccounts(); break;
      case 'label': cmdLabel(rest.slice(1)); break;
      case 'statusline': await cmdStatusline(rest[1] ?? 'status', flags); break;
      case 'service': await cmdService(rest[1] ?? 'status', flags); break;
      case 'models': await refresh({ quiet: true }); cmdModels(Number(flags.days ?? 30)); break;
      case 'verify': await refresh({ quiet: true }); cmdVerify(); break;
      case 'where':
        console.log(`data dir : ${DATA_DIR}`);
        console.log(`database : ${DB_PATH}`);
        break;
      case 'serve': case 'dash': case 'tui': {
        const { serve } = await import('./server.js');
        // The terminal dashboard needs a real TTY; piping output turns it off.
        const wantTui = !flags['no-tui'] && process.stdout.isTTY;
        await serve({
          port: Number(flags.port ?? process.env.PORT ?? 4785),
          open: !!flags.open,
          tui: cmd === 'tui' ? process.stdout.isTTY : wantTui,
          web: !flags['no-web'] && cmd !== 'tui',
          notifications: !flags['no-notify'] && process.env.CLAUDE_TRACKER_NOTIFY !== '0',
          refresh,
          fastRefresh,
        });
        return; // the dashboards own the process from here
      }
      case 'help': case '--help': case '-h': help(); break;
      default:
        console.error(`Unknown command: ${cmd}`);
        help();
        process.exitCode = 1;
    }
  } finally {
    if (!LONG_RUNNING.has(cmd)) closeDb();
  }
}
