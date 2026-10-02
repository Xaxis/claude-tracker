import { ingestAll, ingestPaths, placeRecords } from './ingest.js';
import { ingestLive } from './live.js';
import {
  discoverAccounts, attributeSessions, attributeLimitEvents,
  listAccounts, accountLabel, resolveAccountEmails, setLabel, attributeEvents,
} from './accounts.js';
import { calibrateAll, verifyWindowModel } from './calibrate.js';
import { overview, modelBreakdown, liveSessions, inUse } from './api.js';
import { LIMIT_TYPES, resetWindowCache, earliestCachedChain } from './windows.js';
import { invalidateAggregates, aggregatesCutoff } from './aggregates.js';
import { closeDb } from './db.js';
import { importMark } from './replica.js';
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

/** One line per account in use somewhere: how full, and where its sessions go. */
function printPlan(p, machine, settings) {
  if (!p.entries.length) { console.log(`  ${c.dim}${machine}: no sessions running${c.reset}`); return; }
  for (const e of p.entries) {
    const head = `  ${c.bold}${e.label}${c.reset} ${c.dim}on ${machine} · ${pct(e.level)} of its fullest window${c.reset}`;
    const verb = e.out ? `${c.yellow}moving sessions${c.reset}`
      : e.due ? `${c.yellow}moving background sessions${c.reset}` : 'would move sessions';
    const where = e.target
      ? `${verb} to ${c.bold}${e.target.label}${c.reset} ${c.dim}(${e.target.shown} · ${pct(e.target.room)} free)${c.reset}`
      : `${c.red}nowhere to move to${c.reset} ${c.dim}- no other account with room is signed in on ${machine}${c.reset}`;
    const at = !e.target || e.out ? '' : e.due ? ` ${c.dim}- open windows when it runs out${c.reset}`
      : ` ${c.dim}- background ones at ${settings.at}%, open windows when it runs out${c.reset}`;
    console.log(`${head}\n    ${where}${at}`);
  }
  if (p.best) {
    console.log(`  ${c.dim}${p.best.label} has ${pct(p.best.room)} free but is signed in nowhere on ${machine}${c.reset}`);
    if (p.best.email && machine === 'this machine') console.log(`  ${c.dim}  add it: claude-tracker pool add ${p.best.email}${c.reset}`);
  }
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
      ? `${c.green}✓${c.reset} failing over at ${s.at}% - idle sessions on an account that full move to the account here with the most room`
      : `${c.green}✓${c.reset} failover off - the plan is still shown, nothing is moved`);
    return;
  }
  const ov = overview();
  const live = liveSessions();
  if (action === 'move') {
    const q = args[0];
    const s = live.find((x) => !x.machine && (x.sessionId.startsWith(q ?? '\0') || x.name === q));
    if (!s) { console.error(`No session running here is called "${q ?? ''}". See: claude-tracker failover`); process.exitCode = 1; return; }
    const p = F.plan(ov, live);
    let target = p.entries.find((e) => e.account === s.accountUuid)?.target;
    if (flags.to) {
      const profile = F.pool().find((x) => x.email?.toLowerCase() === String(flags.to).toLowerCase());
      if (!profile) { console.error(`No profile here is signed into ${flags.to}. Add one: claude-tracker pool add ${flags.to}`); process.exitCode = 1; return; }
      target = profile;
    }
    if (!target) { console.error('There is no other account with room signed in on this machine.'); process.exitCode = 1; return; }
    console.log(`${c.dim}moving ${s.name ?? s.sessionId.slice(0, 8)} to ${target.label ?? target.email}…${c.reset}`);
    const m = await F.move(s, target, { fromAccount: s.accountUuid });
    if (m.status !== 'started') { console.error(`${c.red}✗${c.reset} ${m.error}`); process.exitCode = 1; return; }
    console.log(`${c.green}✓${c.reset} it carries on in the background${m.continued ? ', picking up where it was cut off' : ''}. Open it:\n  ${F.attachCommand(m)}`);
    return;
  }

  const s = F.failoverSettings();
  console.log(`\n${c.bold}Failover${c.reset}  ${s.mode === 'auto' ? `${c.green}on${c.reset} at ${s.at}%` : `${c.dim}off${c.reset} ${c.dim}(claude-tracker failover on)${c.reset}`}${s.mode === 'auto' && s.waitMin ? ` ${c.dim}· not when the account frees up within ${s.waitMin}m${c.reset}` : ''}\n`);
  printPlan(F.plan(ov, live, s), 'this machine', s);
  for (const r of ov.failover.remote) {
    console.log();
    printPlan({ entries: r.entries.map((e) => ({ ...e, target: e.target && { ...e.target } })), best: r.best }, r.machine, { at: r.at });
  }
  const moves = ov.failover.moves;
  if (moves.length) {
    console.log(`\n${c.bold}Moved today${c.reset}`);
    for (const m of moves) {
      console.log(`  ${when(m.ts)}  ${m.name} ${c.dim}${m.from} →${c.reset} ${m.to}  ${m.status === 'started' ? `${c.dim}${m.attach}${c.reset}` : `${c.red}${m.error}${c.reset}`}`);
    }
  }
  console.log();
}

async function cmdPool(action, args, flags) {
  const F = await import('./failover.js');
  if (action === 'add') {
    const email = args[0];
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) { console.error('usage: claude-tracker pool add <email> [--as <name>]'); process.exitCode = 1; return; }
    const { HOME, configFileOf } = await import('./paths.js');
    const { profileAccount } = await import('./accounts.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { spawn } = await import('node:child_process');
    const already = F.pool().find((p) => p.email?.toLowerCase() === email.toLowerCase());
    if (already) {
      console.log(`${email} is already signed in on this machine, in ${already.shown}.`);
      if (!already.isDefault) console.log(`${c.dim}To have it share this machine's settings, skills and memories: claude-tracker pool link${c.reset}`);
      return;
    }
    const name = String(flags.as ?? email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dir = path.join(HOME, `.claude-${name}`);
    // Never sign over a profile that is another account's: two emails can share a name.
    const holder = profileAccount({ dir, configFile: configFileOf(dir) });
    if (holder && holder.email?.toLowerCase() !== email.toLowerCase()) {
      console.error(`${dir.replace(HOME, '~')} is already signed in as ${holder.email}. Give this one another name:\n  claude-tracker pool add ${email} --as <name>`);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    // The same setup as the main profile, so a session moved here behaves as it did.
    const { shareSetup } = await import('./pool.js');
    shareSetup(dir);
    console.log(`Signing ${email} into ${dir.replace(HOME, '~')} - finish the login in your browser.\n`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.env.CLAUDE_TRACKER_CLAUDE || 'claude', ['auth', 'login', '--email', email],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'inherit' });
      child.on('error', () => resolve(-1));
      child.on('close', resolve);
    });
    const who = profileAccount({ dir, configFile: configFileOf(dir) });
    const again = `claude-tracker pool add ${email}${flags.as ? ` --as ${flags.as}` : ''}`;
    if (code !== 0 || !who) { console.error(`\n${c.red}✗${c.reset} not signed in - run it again when ready: ${again}`); process.exitCode = 1; return; }
    if (who.email?.toLowerCase() !== email.toLowerCase()) {
      // The browser was signed into another account. The profile was empty before,
      // so sign it out again rather than leave it holding the wrong one.
      await new Promise((resolve) => {
        const child = spawn(process.env.CLAUDE_TRACKER_CLAUDE || 'claude', ['auth', 'logout'],
          { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'ignore' });
        child.on('error', resolve);
        child.on('close', resolve);
      });
      console.error(`\n${c.red}✗${c.reset} the browser signed in as ${who.email}, not ${email}, so that was undone.`);
      console.error(`  Open the sign-in link in a private window, sign in as ${email}, and run: ${again}`);
      process.exitCode = 1;
      return;
    }
    // Now there is a config file to carry MCP servers and folder trust into.
    const shared = shareSetup(dir);
    console.log(`\n${c.green}✓${c.reset} ${dir.replace(HOME, '~')} is signed in as ${c.bold}${who.email}${c.reset}; sessions can now be moved to it.`);
    if (shared.copied.length) console.log(`  ${c.dim}also given: ${shared.copied.join(', ')}${c.reset}`);
    return;
  }

  if (action === 'link') {
    const { shareSetup, mainProfile } = await import('./pool.js');
    const main = mainProfile();
    for (const p of F.pool().filter((x) => !x.isDefault)) {
      const r = shareSetup(p.dir, { force: !!flags.force });
      const did = [...r.linked, ...r.copied, ...(r.memories ? [`${r.memories} project memories`] : [])];
      console.log(`  ${pad(p.shown, 24)} ${did.length ? `${c.green}shared${c.reset} ${did.join(', ')}` : `${c.dim}already shares ${main ? main.name : 'the main profile'}'s setup${c.reset}`}`);
      if (r.kept.length) console.log(`  ${' '.repeat(24)} ${c.yellow}kept its own${c.reset} ${r.kept.join(', ')} ${c.dim}- --force replaces them, keeping the old as .pre-pool${c.reset}`);
    }
    return;
  }

  const ov = overview();
  const byUuid = new Map(ov.accounts.map((a) => [a.accountUuid, a]));
  const room = (uuid) => { const a = byUuid.get(uuid); return a ? (a.available.now ? `${pct(F.headroom(a))} free` : `out until ${when(a.available.at)}`) : ''; };
  console.log(`\n${c.bold}Signed-in profiles - where sessions can be moved${c.reset}\n`);
  for (const p of F.pool()) console.log(`  ${pad(p.shown, 22)} ${pad(p.email ?? p.accountUuid, 28)} ${c.dim}${room(p.accountUuid)}${c.reset}`);
  for (const m of (await import('./replica.js')).remoteMachines()) {
    for (const p of m.profiles.filter((x) => x.accountUuid)) console.log(`  ${pad(`${p.dir} (${m.name})`, 22)} ${pad(p.email ?? p.accountUuid, 28)} ${c.dim}${room(p.accountUuid)}${c.reset}`);
  }
  const signed = new Set([...F.pool().map((p) => p.accountUuid)]);
  const missing = ov.accounts.filter((a) => !signed.has(a.accountUuid) && a.available.now && a.email);
  if (missing.length) {
    console.log(`\n  ${c.dim}Not signed in on this machine:${c.reset}`);
    for (const a of missing) console.log(`  ${pad(a.email, 50)} ${c.dim}${room(a.accountUuid)} · claude-tracker pool add ${a.email}${c.reset}`);
  }
  console.log();
}

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
  ${c.bold}ingest${c.reset} [--force]            read new transcript data
  ${c.bold}accounts${c.reset}                    list discovered accounts
  ${c.bold}label${c.reset} <uuid-prefix> <name>  give an account a readable name
  ${c.bold}models${c.reset} [--days N]           per-model usage breakdown
  ${c.bold}verify${c.reset}                      check the window model against observed resets
  ${c.bold}where${c.reset}                       print data locations
  ${c.bold}statusline${c.reset} install|uninstall  exact limits via each profile's status line
  ${c.bold}service${c.reset} install|uninstall     run in the background at login (launchd or systemd)
  ${c.bold}sync${c.reset} add <ssh-host>           sync with the tracker on another machine, over ssh
  ${c.bold}sync${c.reset} [status]|remove <host>|name <name>
  ${c.bold}failover${c.reset} [status]|on|off      move sessions off an account that runs low
        ${c.dim}on [--at 90] [--wait 15]${c.reset}  at what fill, and not if it frees up that soon
        ${c.dim}move <session> [--to <email>]${c.reset}  move one now
  ${c.bold}pool${c.reset} [list]|add <email>        accounts signed in here, that sessions can move to
        ${c.dim}link [--force]${c.reset}           share this machine's setup with every pool profile

${c.dim}In the terminal dashboard: q quit · r refresh · a cycle account · w switch
window · space pause · ↑↓/jk scroll${c.reset}

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
      case 'accounts': await refresh({ quiet: true }); cmdAccounts(); break;
      case 'label': cmdLabel(rest.slice(1)); break;
      case 'statusline': await cmdStatusline(rest[1] ?? 'status', flags); break;
      case 'service': await cmdService(rest[1] ?? 'status', flags); break;
      case 'sync': await cmdSync(rest[1] ?? 'status', rest.slice(2), flags); break;
      case 'failover': await refresh({ quiet: true }); await cmdFailover(rest[1] ?? 'status', rest.slice(2), flags); break;
      case 'pool': await cmdPool(rest[1] ?? 'list', rest.slice(2), flags); break;
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
