import { ingestAll, ingestPaths, placeRecords } from './ingest.js';
import { ingestLive } from './live.js';
import {
  discoverAccounts, attributeSessions, attributeLimitEvents,
  listAccounts, accountLabel, resolveAccountEmails, setLabel, attributeEvents,
} from './accounts.js';
import { calibrateAll, verifyWindowModel } from './calibrate.js';
import { overview, modelBreakdown, liveSessions, inUse, boxes, versionOf } from './api.js';
import { cacheSummary } from './context.js';
import { LIMIT_TYPES, resetWindowCache, earliestCachedChain } from './windows.js';
import { invalidateAggregates, aggregatesCutoff } from './aggregates.js';
import { closeDb } from './db.js';
import { importMark, remoteMachines } from './replica.js';
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
  if (!m) return `${s}s`;
  return `${m}m`;
}

const tokens = (n) => (n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Agent names, once each, with a count where several share one: `Explore ×2, speed`. */
function agentList(agents) {
  const n = new Map();
  for (const a of agents) n.set(a.name, (n.get(a.name) ?? 0) + 1);
  return [...n].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ');
}

/** What fixes a synced machine running a different tracker, or null when it runs the same. */
function skewNote(name, version) {
  if (version === 'older') return `${name} runs an older claude-tracker, so it shows no session detail. On ${name}: git pull in its claude-tracker checkout, then claude-tracker service install`;
  if (version === 'newer') return `${name} runs a newer claude-tracker than this machine. Here: git pull in the claude-tracker checkout, then claude-tracker service install`;
  return null;
}
const ctxColor = (n) => (n >= 600e3 ? c.red : n >= 400e3 ? c.yellow : '');
const waitColor = (ms) => (ms >= 5 * 60e3 ? c.red : c.yellow);

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
  invalidateCaches(reattribute === 'all', res.minNewTs, a.minChangedTs, live.oldest, importedSince());
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
  invalidateCaches(false, r.minNewTs, a.minChangedTs, live.oldest, importedSince());
  return { ...r, attributed: a.changed, exact: live.samples, ms: Date.now() - t0 };
}

/**
 * Rows from another machine have arrived: re-derive what they bear on. `since`
 * is the earliest time they could change attribution from - null when they
 * only touched what attribution never reads.
 */
function afterSync(since) {
  if (since == null || !Number.isFinite(since)) return;
  placeRecords();
  attributeSessions();
  attributeLimitEvents();
  resolveAccountEmails();
  const a = attributeEvents({ since: Math.min(since, Date.now() - 6 * 3600_000) });
  invalidateCaches(false, since, a.minChangedTs);
}

/**
 * How far back rows imported by another process on this machine reached, if
 * any arrived since this one last looked. A terminal dashboard attached to the
 * service caches history of its own, and would otherwise never see them.
 */
let seenImport = null;
function importedSince() {
  const m = importMark();
  const fresh = seenImport !== null && m.n !== seenImport;
  seenImport = m.n;
  return fresh ? m.since : null;
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

  const live = liveSessions();
  const using = inUse(o, live);
  const synced = o.sync.machines.length > 0;
  for (const a of o.accounts) {
    // In use here: green. In use only on another synced machine: blue.
    const where = using.get(a.accountUuid) ?? [];
    const marker = where.includes(null) ? `${c.green}●${c.reset}` : where.length ? `${c.blue}●${c.reset}` : `${c.gray}○${c.reset}`;
    const on = synced && where.length ? ` ${c.dim}on ${where.map((m) => m ?? o.sync.name).join(', ')}${c.reset}` : '';
    const tier = a.tier ? ` ${c.dim}${a.tier.replace('default_claude_', '')}${c.reset}` : '';
    const out = a.available.now ? ''
      : ` ${c.red}${a.available.sure ? '' : '≈ '}out until ${new Date(a.available.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (in ${duration(a.available.at - o.now)})${c.reset}`;
    console.log(`${marker} ${c.bold}${a.label}${c.reset}${out}${on}${tier}  ${c.dim}${money(a.totalCost)} tracked · ${a.sessions} session${a.sessions === 1 ? '' : 's'}${c.reset}`);
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
  if (live.length) {
    const carried = live.reduce((a, s) => a + (s.context?.tokens ?? 0), 0);
    const waiting = boxes().reduce((a, b) => a + (b.gpu?.jobsWaiting ?? 0) + (b.cpu?.jobsWaiting ?? 0), 0);
    console.log(`  ${c.cyan}${live.length}${c.reset} ${c.dim}Claude Code session${live.length === 1 ? '' : 's'} running now` +
      `${carried ? ` · ${tokens(carried)} context a turn in all` : ''}${waiting ? ` · ${waiting} job${waiting === 1 ? '' : 's'} waiting for the GPU or CPU pool` : ''}` +
      ` · claude-tracker sessions${c.reset}`);
  }
  console.log();
}

/** One line for a session's job holding or waiting for the GPU or a CPU slot. */
function leaseText(l, now) {
  const what = l.kind === 'gpu' ? 'the GPU' : 'a CPU slot';
  const where = l.place ? ` in ${l.place}` : '';
  const ms = now - l.since;
  if (l.state === 'holds') return `${c.dim}■ holds ${what}${where} · ${duration(ms)}${c.reset}`;
  const pos = l.ahead === 0 ? 'next in line' : `${l.ahead} ahead`;
  const behind = l.behind?.length ? ` · behind ${l.behind.map((b) => `${b.who} (${duration(now - b.since)})`).join(', ')}` : '';
  return `${waitColor(ms)}▸ ${l.jobs > 1 ? `${l.jobs} jobs` : 'a job'}${where} waiting ${duration(ms)} for ${what}${c.reset}${c.dim} · ${pos}${behind}${c.reset}`;
}

/** What is running, what each session carries into a turn, and who waits for the GPU or CPU pool. */
function cmdSessions() {
  const now = Date.now();
  const live = liveSessions(now);
  const carried = live.reduce((a, s) => a + (s.context?.tokens ?? 0), 0);
  console.log(`\n${c.bold}Running now${c.reset} ${c.dim}· ${live.length} session${live.length === 1 ? '' : 's'}${carried ? ` · ${tokens(carried)} context a turn in all` : ''}${c.reset}\n`);
  for (const m of remoteMachines(now)) {
    const note = skewNote(m.name, versionOf(m.build));
    if (note) console.log(`  ${c.yellow}!${c.reset} ${note}\n`);
  }
  if (!live.length) console.log(`  ${c.dim}no Claude Code sessions running${c.reset}`);
  for (const s of live) {
    const dot = s.status === 'busy' ? `${c.yellow}●${c.reset}` : `${c.gray}○${c.reset}`;
    const x = s.context;
    const ctx = x ? `${ctxColor(x.tokens)}${pad(tokens(x.tokens), 5)}${c.reset} ${c.dim}${pad(`${money(x.perTurn)}/turn`, 11)}${c.reset}` : `${c.dim}${pad('—', 17)}${c.reset}`;
    const agents = s.agents?.length ? `${s.agents.length} agent${s.agents.length === 1 ? '' : 's'}` : '';
    const re = s.recache?.turns ? `↻${s.recache.turns} ${money(s.recache.cost)} this hour` : '';
    console.log(`  ${dot} ${pad((s.name || s.sessionId.slice(0, 8)).slice(0, 22), 23)}${pad((s.account ?? 'unknown account').slice(0, 30), 31)}${ctx} ` +
      `${c.dim}${pad(agents, 10)}${re}${s.machine ? `  on ${s.machine}` : ''}${c.reset}`);
    if (s.agents?.length) console.log(`      ${c.dim}agents at work: ${agentList(s.agents)}${c.reset}`);
    for (const l of s.leases ?? []) console.log(`      ${leaseText(l, now)}`);
  }
  for (const b of boxes(now)) {
    const on = b.machine ? ` on ${b.machine}` : '';
    for (const [kind, x] of [['gpu', b.gpu], ['cpu', b.cpu]]) {
      if (!x || (kind === 'cpu' && !x.held.length && !x.waiting.length)) continue;
      const head = kind === 'gpu'
        ? `GPU${on}${c.reset} ${c.dim}· ${x.held.length ? 'held' : 'free'}${x.jobsWaiting ? ` · ${x.jobsWaiting} waiting` : ''}`
        : `CPU pool${on}${c.reset} ${c.dim}· ${x.held.length} of ${x.slots} slots${x.jobsWaiting ? ` · ${x.jobsWaiting} waiting` : ''} · load ${Math.round(x.load)} on ${x.cores} cores`;
      console.log(`\n${c.bold}${head}${c.reset}`);
      for (const h of x.held) console.log(`  ${c.blue}■${c.reset} ${pad(h.session ?? h.project ?? '?', 22)} ${c.dim}${pad(cut(h.place ?? '', 16), 16)}${c.reset} ${pad(duration(now - h.since), 8)} ${c.dim}${(h.cmd ?? '').slice(0, 70)}${c.reset}`);
      for (const w of x.waiting) {
        const pos = w.ahead === 0 ? 'next in line' : `${w.ahead} ahead`;
        console.log(`  ${waitColor(now - w.since)}▸${c.reset} ${pad(w.session ?? w.project ?? '?', 22)} ${c.dim}${pad(cut(w.place ?? '', 16), 16)}${c.reset} ${waitColor(now - w.since)}${pad(duration(now - w.since), 8)}${c.reset} ${c.dim}${w.jobs > 1 ? `${w.jobs} jobs · ` : ''}${pos}${c.reset}`);
      }
      if (kind === 'cpu' && x.waiting.length && x.held.length < x.slots && x.load >= x.cores) {
        console.log(`  ${c.dim}${x.slots - x.held.length === 1 ? 'a slot is' : 'slots are'} free, but jobs wait until the load drops under ${x.cores}${c.reset}`);
      }
      const h = kind === 'gpu' ? x.hour : null;
      if (h?.jobs) {
        const parts = [`${h.jobs} job${h.jobs === 1 ? '' : 's'} waited ${duration(h.waitedMs)} in all`];
        if (h.longestWait?.ms >= 60e3) parts.push(`longest wait ${duration(h.longestWait.ms)} (${h.longestWait.project})`);
        if (h.longestHold?.ms >= 60e3) parts.push(`longest hold ${duration(h.longestHold.ms)} (${h.longestHold.project})`);
        console.log(`  ${c.dim}last hour: ${parts.join(' · ')}${c.reset}`);
      }
    }
  }
  console.log();
}

/** Turns that re-wrote a lapsed cache, last day and week. */
function printCache() {
  const x = cacheSummary();
  if (!x.week.turns) return;
  console.log(`${c.bold}Cache re-written after a pause${c.reset}\n`);
  for (const [label, r] of [['last 24h', x.day], ['last 7 days', x.week]]) {
    console.log(`  ${pad(label, 12)} ${bar(r.share * 100, 20)} ${pad(`${Math.round(r.share * 100)}%`, 5)} ${pad(money(r.cost), 10)} ${c.dim}of ${money(r.spend)} · ${r.turns.toLocaleString()} turns${c.reset}`);
  }
  const ttl = (t) => (t === '1h' ? 'keep their cache an hour' : t === '5m' ? 'keep their cache 5 minutes' : '');
  console.log(`    ${c.dim}subagents    ${pad(money(x.week.sub.cost), 10)} ${pad(`${x.week.sub.turns.toLocaleString()} turns`, 12)} ${ttl(x.ttl.sub)}${c.reset}`);
  console.log(`    ${c.dim}main thread  ${pad(money(x.week.main.cost), 10)} ${pad(`${x.week.main.turns.toLocaleString()} turns`, 12)} ${ttl(x.ttl.main)}${c.reset}`);
  if (x.hint) {
    console.log(`\n  ${c.yellow}!${c.reset} Subagents re-write their whole context after any pause over 5 minutes. Keep it an hour:`);
    console.log(`    "${x.hint.setting}": "${x.hint.value}" ${c.dim}in settings.json, or${c.reset} ${x.hint.env}=${x.hint.value}`);
  }
  console.log();
}

async function cmdExport(file) {
  const { exportAccounts } = await import('./export.js');
  const r = exportAccounts(file);
  console.log(`${c.green}✓${c.reset} ${r.count} account${r.count === 1 ? '' : 's'} → ${c.bold}${r.shown}${c.reset}`);
  console.log(`${c.dim}  Google Sheets: File → Import → Upload, and pick that file. Phone number and${c.reset}`);
  console.log(`${c.dim}  payment card are left blank: Claude Code is never told them.${c.reset}`);
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
  printCache();
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
    const r = await installService({ port: Number(flags.port ?? 4785) });
    console.log(`${c.green}✓${c.reset} running at login - ${r.url}\n  ${c.dim}log: ${r.log}${c.reset}`);
  } else if (action === 'uninstall') {
    console.log(uninstallService().removed ? `${c.green}✓${c.reset} removed` : 'not installed');
  } else {
    const s = serviceStatus();
    console.log(s.installed ? `installed · ${s.state ?? 'not loaded'}${s.pid ? ` · pid ${s.pid}` : ''}\n  ${c.dim}log: ${s.log}${c.reset}` : 'not installed');
  }
}

/* --- failing over ---------------------------------------------------------- */

const pct = (n) => `${Math.round(n)}%`;
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One line per profile sessions run in: its account, how full, and what it switches to. */
function printPlan(p, machine, settings) {
  if (!p.entries?.length) { console.log(`  ${c.dim}${machine}: no sessions running${c.reset}`); return; }
  for (const e of p.entries) {
    console.log(`  ${c.bold}${e.profile ?? "a profile"}${c.reset} ${c.dim}on ${machine} · signed into${c.reset} ${e.label} ${c.dim}· ${pct(e.level)} of its fullest window · ${e.sessions} session${e.sessions === 1 ? '' : 's'}${c.reset}`);
    console.log(e.target
      ? `    ${e.due ? `${c.yellow}switching${c.reset}` : 'switches'} to ${c.bold}${e.target.label}${c.reset} ${c.dim}(${pct(e.target.room)} free${e.target.pinned ? ', your pick' : ''})${e.due ? '' : ` at ${e.at ?? settings.at}%`}${c.reset}`
      : `    ${c.red}nothing to switch to${c.reset} ${c.dim}- no spare on ${machine} holds an account with room${c.reset}`);
    if (e.then?.length) console.log(`    ${c.dim}if that fails: ${e.then.map((t) => `${t.label} (${pct(t.room)} free)`).join(', then ')}${c.reset}`);
  }
  for (const n of p.notices ?? []) {
    console.log(`  ${n.level === 'bad' ? c.red : c.yellow}! ${n.text}${c.reset}`);
    if (n.fix) console.log(`    ${c.dim}→ ${n.fix}${c.reset}`);
  }
  if (p.best) console.log(`  ${c.dim}${p.best.label} has ${pct(p.best.room)} free and no spare on ${machine}${p.best.email ? `: claude-tracker pool add ${p.best.email}` : ''}${c.reset}`);
}

async function cmdFailover(action, args, flags) {
  const F = await import('./failover.js');
  if (action === 'on' || action === 'off') {
    const at = flags.at != null ? Number(flags.at) : undefined;
    const waitMin = flags.wait != null ? Number(flags.wait) : undefined;
    if ((at != null && !(at > 0 && at <= 100)) || (waitMin != null && !(waitMin >= 0))) {
      console.error('usage: claude-tracker failover on [--at 1-100] [--wait minutes]'); process.exitCode = 1; return;
    }
    const s = F.setFailover({ mode: action === 'on' ? 'auto' : 'off', at, waitMin });
    console.log(s.mode === 'auto'
      ? `${c.green}✓${c.reset} at ${s.at}%, a profile's sessions switch to the spare account with the most room`
      : `${c.green}✓${c.reset} failover off - the plan is still shown, nothing switches`);
    return;
  }
  if (action === 'prefer') {
    const want = args[0];
    if (!want) { console.error('usage: claude-tracker failover prefer <email>|auto'); process.exitCode = 1; return; }
    if (want === 'auto') { F.setFailover({ prefer: null }); console.log(`${c.green}✓${c.reset} switches to the spare with the most room`); return; }
    if (!F.spares().some((x) => x.email?.toLowerCase() === want.toLowerCase())) {
      console.error(`No spare here holds ${want}. Add it: claude-tracker pool add ${want}`); process.exitCode = 1; return;
    }
    F.setFailover({ prefer: want });
    console.log(`${c.green}✓${c.reset} switches to ${c.bold}${want}${c.reset} while it has room, else the spare with the most`);
    return;
  }
  const ov = overview();
  const live = liveSessions();
  const p = F.plan(ov, live);
  if (action === 'switch') {
    // Switch now: the profile named (default ~/.claude's entry, or the only one), to the spare named or the best.
    const e = p.entries.find((x) => (flags.profile ? x.profile === flags.profile || x.dir === flags.profile : x.isDefault)) ?? (p.entries.length === 1 ? p.entries[0] : null);
    if (!e) { console.error('No profile here has sessions running to switch. Name one: --profile ~/.claude'); process.exitCode = 1; return; }
    let target = e.target;
    if (flags.to) {
      const s = F.spares().find((x) => x.email?.toLowerCase() === String(flags.to).toLowerCase());
      if (!s) { console.error(`No spare here holds ${flags.to}. Add it: claude-tracker pool add ${flags.to}`); process.exitCode = 1; return; }
      target = { accountUuid: s.accountUuid, label: s.email, dir: s.dir, shown: s.shown };
    }
    if (!target) { console.error('No spare here holds an account with room.'); process.exitCode = 1; return; }
    const r = F.switchProfile(e, target);
    if (r.status !== 'switched') { console.error(`${c.red}✗${c.reset} ${r.error}`); process.exitCode = 1; return; }
    console.log(`${c.green}✓${c.reset} ${e.profile} is signed into ${c.bold}${target.label}${c.reset}; its ${e.sessions} session${e.sessions === 1 ? '' : 's'} carry on as that account within about 30 seconds.`);
    return;
  }

  const s = F.failoverSettings();
  console.log(`\n${c.bold}Failover${c.reset}  ${s.mode === 'auto' ? `${c.green}on${c.reset} at ${s.at}%` : `${c.dim}off${c.reset} ${c.dim}(claude-tracker failover on)${c.reset}`}${s.prefer ? ` ${c.dim}· prefers ${s.prefer}${c.reset}` : ''}\n`);
  printPlan(p, 'this machine', s);
  for (const r of ov.failover.remote) { console.log(); printPlan(r, r.machine, { at: r.at }); }
  if (ov.failover.switches.length) {
    console.log(`\n${c.bold}Switched today${c.reset}`);
    for (const m of ov.failover.switches) {
      console.log(`  ${when(m.ts)}  ${m.profile} ${c.dim}${m.from} →${c.reset} ${m.to}${m.status === 'switched' ? '' : `  ${c.red}${m.error}${c.reset}`}`);
    }
  }
  console.log();
}

async function cmdPool(action, args, flags) {
  const F = await import('./failover.js');
  if (action === 'add') {
    const email = args[0];
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) { console.error('usage: claude-tracker pool add <email> [--as <name>]'); process.exitCode = 1; return; }
    console.log(`Signing ${email} into a spare - finish the login in your browser.\n`);
    const r = await F.addSpare(email, typeof flags.as === 'string' ? flags.as : undefined);
    if (r.already) { console.log(r.already); return; }
    if (r.error) {
      console.error(`\n${c.red}✗${c.reset} ${r.error}. Try again with a private browser window: claude-tracker pool add ${email}${flags.as ? ` --as ${flags.as}` : ''}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${c.green}✓${c.reset} ${email} is a spare, in ${r.added.shown}; a profile running low can switch to it.`);
    return;
  }

  const ov = overview();
  const byUuid = new Map(ov.accounts.map((a) => [a.accountUuid, a]));
  const room = (uuid) => { const a = byUuid.get(uuid); return a ? (a.available.now ? `${pct(F.headroom(a))} free` : `out until ${when(a.available.at)}`) : ''; };
  const { discoverProfiles } = await import('./paths.js');
  const { profileAccount } = await import('./accounts.js');
  console.log(`\n${c.bold}Signed in on this machine${c.reset}\n`);
  for (const p of discoverProfiles().filter((x) => !x.dir.includes(F.SPARE_PREFIX))) {
    const a = profileAccount(p);
    if (a) console.log(`  ${pad(tildePath(p.dir), 26)} ${pad(a.email ?? a.accountUuid, 28)} ${c.dim}${room(a.accountUuid)} · in use${c.reset}`);
  }
  for (const s of F.spares()) {
    console.log(s.accountUuid
      ? `  ${pad(s.shown, 26)} ${pad(s.email, 28)} ${c.dim}${room(s.accountUuid)} · spare${c.reset}`
      : `  ${pad(s.shown, 26)} ${pad(s.for ?? '', 28)} ${c.dim}signed into a profile right now${c.reset}`);
  }
  const here = new Set([...F.spares().map((s) => s.email?.toLowerCase()), ...F.spares().map((s) => s.for?.toLowerCase()),
    ...discoverProfiles().map((p) => profileAccount(p)?.email?.toLowerCase())]);
  const missing = ov.accounts.filter((a) => a.email && !here.has(a.email.toLowerCase()));
  if (missing.length) {
    console.log(`\n  ${c.dim}No spare on this machine:${c.reset}`);
    for (const a of missing) console.log(`  ${pad(a.email, 54)} ${c.dim}${room(a.accountUuid)} · claude-tracker pool add ${a.email}${c.reset}`);
  }
  console.log();
}

const tildePath = (p) => p.replace(process.env.HOME ?? '', '~');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (t) => (t ? `${duration(Date.now() - t)} ago` : 'never');

/** The tracker serving this machine's port, if there is one - and whether it can sync. */
async function localTracker(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    return h?.app === 'claude-tracker' ? h : null;
  } catch { return null; }
}

/**
 * Syncing is done by the tracker running here, not by this command. Make sure
 * one is running that can, then watch it reach `target`.
 */
async function handOver(port, target) {
  const R = await import('./replica.js');
  const started = Date.now();
  let h = await localTracker(port);
  if (h && !h.sync) {
    const { serviceStatus, installService } = await import('./service.js');
    let installed = false;
    try { installed = serviceStatus().installed; } catch { /* no service manager here */ }
    if (!installed) {
      console.log(`The tracker running here predates sync. Restart it and it will start syncing with ${target}.`);
      return;
    }
    console.log(`${c.dim}restarting the login service, which predates sync…${c.reset}`);
    await installService({ port });
    h = null;
    // It reads any new transcripts before it serves again.
    for (let i = 0; i < 120 && !h?.sync; i++) { await sleep(1000); h = await localTracker(port); }
  }
  if (!h) {
    console.log(`Nothing is running here to do the syncing. Start it with ${c.bold}claude-tracker service install${c.reset},`);
    console.log('or leave claude-tracker open.');
    return;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const p = R.listPeers().find((x) => x.target === target);
    if (p?.status === 'connected' && p.status_at >= started - 1000) {
      console.log(`${c.green}✓${c.reset} syncing - both machines' dashboards now show both machines`);
      return;
    }
    if (p?.status === 'error' && p.status_at >= started) {
      console.log(`${c.yellow}!${c.reset} the tracker running here could not connect: ${p.error}`);
      console.log(`${c.dim}  It keeps retrying. See how it is going with: claude-tracker sync${c.reset}`);
      return;
    }
  }
  console.log(`still connecting - see how it is going with: ${c.bold}claude-tracker sync${c.reset}`);
}

async function cmdSync(action, args, flags) {
  const S = await import('./sync.js');
  const R = await import('./replica.js');
  const port = Number(flags.port ?? 4785);

  if (action === 'serve') {
    await S.syncServe();
    // The relay's stdin would hold the process open after the connection ends.
    process.exit(process.exitCode ?? 0);
  }

  const me = R.machine();
  if (action === 'add') {
    const target = args[0];
    try { S.checkTarget(target); } catch (err) { console.error(err.message); process.exitCode = 1; return; }
    console.log(`${c.dim}connecting to ${target} over ssh…${c.reset}`);
    const r = await S.probePeer(target, typeof flags.command === 'string' ? flags.command : null);
    if (!r.ok) {
      console.error(`${c.red}✗${c.reset} could not sync with ${target}: ${r.error}`);
      if (/Host key verification failed/i.test(r.error)) {
        const host = target.replace(/^.*@/, '');
        console.error(`${c.dim}  ${host} presents a different host key from the one this machine recorded for it.`);
        console.error(`  If it was reinstalled, forget the old key and try again: ssh-keygen -R ${host}${c.reset}`);
      } else {
        console.error(`${c.dim}  It needs \`ssh ${target}\` to work without a password prompt, and claude-tracker`);
        console.error(`  running there: claude-tracker service install${c.reset}`);
      }
      process.exitCode = 1;
      return;
    }
    R.addPeer(target, r.command);
    console.log(`${c.green}✓${c.reset} ${target} is ${c.bold}${r.peer.name}${c.reset}; this machine is ${c.bold}${me.name}${c.reset}`);
    await handOver(port, target);
    return;
  }
  if (action === 'remove') {
    console.log(R.removePeer(args[0]) ? `${c.green}✓${c.reset} no longer connecting to ${args[0]}` : `not connecting to ${args[0]}`);
    return;
  }
  if (action === 'name') {
    if (!args.length) { console.error('usage: claude-tracker sync name <name>'); process.exitCode = 1; return; }
    const m = R.setMachineName(args.join(' '));
    console.log(`${c.green}✓${c.reset} this machine is now ${c.bold}${m.name}${c.reset} ${c.dim}- other machines see it when they next connect${c.reset}`);
    return;
  }

  console.log(`\n${c.bold}This machine${c.reset}  ${me.name} ${c.dim}(${me.id})${c.reset}`);
  const peers = R.listPeers();
  const machines = R.remoteMachines();
  if (!peers.length && !machines.length) {
    console.log(`\n  ${c.dim}Not syncing with any machine. Add one with: claude-tracker sync add me@devbox${c.reset}\n`);
    return;
  }
  if (peers.length) {
    console.log(`\n${c.bold}Connects to${c.reset}`);
    for (const p of peers) {
      const mark = p.status === 'connected' ? `${c.green}●${c.reset}` : p.status === 'error' ? `${c.red}●${c.reset}` : `${c.gray}○${c.reset}`;
      console.log(`  ${mark} ${pad(p.target, 28)} ${p.status ?? 'waiting for the tracker here'} ${c.dim}${p.status_at ? ago(p.status_at) : ''}${c.reset}`);
      if (p.status === 'error' && p.error) console.log(`    ${c.dim}${p.error}${c.reset}`);
    }
  }
  if (machines.length) {
    console.log(`\n${c.bold}Synced with${c.reset}`);
    for (const m of machines) {
      const mark = m.online ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
      const seen = m.online ? 'online' : `last heard ${ago(m.lastSeen)}`;
      const running = m.running.length ? ` · ${m.running.length} session${m.running.length === 1 ? '' : 's'} running` : '';
      console.log(`  ${mark} ${pad(m.name, 28)} ${seen}${running}`);
      const note = skewNote(m.name, versionOf(m.build));
      if (note) console.log(`    ${c.yellow}${note}${c.reset}`);
    }
  }
  console.log();
}

function help() {
  console.log(`
${c.bold}claude-tracker${c.reset} — local usage and rate-limit tracking for Claude accounts

  ${c.bold}serve${c.reset} [--port N] [--open]   live terminal dashboard + web dashboard (default)
        ${c.dim}--no-tui${c.reset}              web dashboard only
        ${c.dim}--no-web${c.reset}              terminal dashboard only
  ${c.bold}tui${c.reset}                         terminal dashboard alone, no HTTP server
  ${c.bold}status${c.reset}                      one-shot limit status for every account
  ${c.bold}sessions${c.reset}                    what is running, its context a turn, who waits for the GPU or CPU
  ${c.bold}ingest${c.reset} [--force]            read new transcript data
  ${c.bold}accounts${c.reset}                    list discovered accounts
        ${c.dim}export [file.csv]${c.reset}         every account as a spreadsheet (Downloads by default)
  ${c.bold}label${c.reset} <uuid-prefix> <name>  give an account a readable name
  ${c.bold}models${c.reset} [--days N]           per-model usage breakdown
  ${c.bold}verify${c.reset}                      check the window model against observed resets
  ${c.bold}where${c.reset}                       print data locations
  ${c.bold}statusline${c.reset} install|uninstall  exact limits via each profile's status line
  ${c.bold}service${c.reset} install|uninstall     run in the background at login (launchd or systemd)
  ${c.bold}sync${c.reset} add <ssh-host>           sync with the tracker on another machine, over ssh
  ${c.bold}sync${c.reset} [status]|remove <host>|name <name>
  ${c.bold}failover${c.reset} [status]|on|off      switch a profile off an account that runs low
        ${c.dim}on [--at 90] [--wait 15]${c.reset}  at what fill, and not if it frees up that soon
        ${c.dim}switch [--to <email>]${c.reset}     switch now
        ${c.dim}prefer <email>|auto${c.reset}       which account it switches to
  ${c.bold}pool${c.reset} [list]|add <email>        spare sign-ins on this machine, to switch to

${c.dim}In the terminal dashboard: q quit · r refresh · d detail on/off (context per turn,
agents, GPU and CPU pool, re-written caches) · a cycle account · w switch window ·
space pause · ↑↓/jk scroll · f failover on/off · t account to switch to ·
+/- threshold · s switch now (press twice) · e export accounts${c.reset}

${c.dim}Data is read from your local Claude transcripts. Nothing leaves this machine except\nto machines you sync with, over ssh.${c.reset}
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
      case 'accounts':
        await refresh({ quiet: true });
        if (rest[1] === 'export') await cmdExport(rest[2] ?? flags.out); else cmdAccounts();
        break;
      case 'label': cmdLabel(rest.slice(1)); break;
      case 'statusline': await cmdStatusline(rest[1] ?? 'status', flags); break;
      case 'service': await cmdService(rest[1] ?? 'status', flags); break;
      case 'sync': await cmdSync(rest[1] ?? 'status', rest.slice(2), flags); break;
      case 'failover': await refresh({ quiet: true }); await cmdFailover(rest[1] ?? 'status', rest.slice(2), flags); break;
      case 'pool': await cmdPool(rest[1] ?? 'list', rest.slice(2), flags); break;
      case 'models': await refresh({ quiet: true }); cmdModels(Number(flags.days ?? 30)); break;
      case 'sessions': await refresh({ quiet: true }); cmdSessions(); break;
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
          afterSync,
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
