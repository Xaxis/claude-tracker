import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { db, tx, getMeta, setMeta } from './db.js';
import { DATA_DIR } from './paths.js';
import { costOf } from './pricing.js';

/**
 * Keeping the indexes of trackers on several machines in step.
 *
 * Each tracker keeps a whole index of its own; syncing copies rows between them
 * so every machine sees every machine's usage. What is copied is evidence -
 * calls, identity records, sightings, refusals, status-line readings, sessions
 * and accounts - never conclusions. Each side re-runs attribution over the
 * union, and so arrives at the same answer as the other.
 *
 * Profiles are named by path, and the same path on two machines is two
 * different profiles: ~/.claude on each can be signed into different accounts.
 * So a profile path from another machine is stored as `<machine id>:<path>`. A
 * local path starts with '/', a foreign one never does, and a foreign path that
 * names this machine turns back into a local one.
 */

/* --- which machine this is ------------------------------------------------ */

function hardwareId() {
  try { return fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* not Linux */ }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1];
    } catch { /* fall through */ }
  }
  return os.hostname();
}

let self = null;

/**
 * This index's identity: a random id, the name other machines show it under,
 * and an epoch that changes whenever its rows are renumbered.
 *
 * The id is tied to the machine and data directory it was made on. An index
 * copied to another machine - ~/.claude carried over wholesale - must not go on
 * speaking as the one it was copied from, so there it gets a fresh id.
 */
export function machine() {
  if (self) return { ...self, name: machineName() };
  const fp = crypto.createHash('sha256').update(`${hardwareId()}|${DATA_DIR}`).digest('hex').slice(0, 16);
  let id = getMeta('machine_id');
  if (!id || getMeta('machine_fp') !== fp) {
    id = crypto.randomBytes(6).toString('hex');
    setMeta('machine_id', id);
    setMeta('machine_fp', fp);
    setMeta('sync_epoch', '');
  }
  let epoch = getMeta('sync_epoch');
  if (!epoch) { epoch = crypto.randomBytes(6).toString('hex'); setMeta('sync_epoch', epoch); }
  self = { id, epoch };
  return { ...self, name: machineName() };
}

/** What other machines call this one: its hostname, unless named otherwise. */
function machineName() {
  return getMeta('machine_name') || os.hostname().replace(/\.(local|lan|home|localdomain)$/i, '');
}

export function setMachineName(name) {
  setMeta('machine_name', String(name).trim().slice(0, 64));
  return machine();
}

/* --- profile paths across machines --------------------------------------- */

/** A stored profile path, as another machine should store it. */
export function exportDir(dir) {
  return typeof dir === 'string' && dir.startsWith('/') ? `${machine().id}:${dir}` : dir;
}

/** A profile path received from machine `from`, as this machine stores it. */
export function importDir(dir, from) {
  if (typeof dir !== 'string' || !dir) return dir;
  const mine = `${machine().id}:`;
  if (dir.startsWith(mine)) return dir.slice(mine.length);
  return dir.startsWith('/') ? `${from}:${dir}` : dir;
}

/** The machine a stored profile path belongs to - null for this one. */
export function dirMachine(dir) {
  return /^([0-9a-f]{6,32}):\//.exec(dir ?? '')?.[1] ?? null;
}

/* --- what is synced ------------------------------------------------------- */

/*
 * Column types: T text, I integer, R real; `!` means never null. `log` tables
 * change in place and are read through sync_dirty; the rest only gain rows and
 * are read by rowid. `own` names the column that says which machine a row came
 * from, so it is not sent straight back there.
 */
export const TABLES = {
  accounts: {
    log: true, key: 'account_uuid',
    cols: {
      account_uuid: 'T!', email: 'T', display_name: 'T', label: 'T', org_uuid: 'T', org_name: 'T',
      rate_limit_tier: 'T', subscription_type: 'T', billing_type: 'T', subscription_at: 'T',
      config_dir: 'T', first_seen: 'I', last_seen: 'I',
    },
  },
  sessions: {
    log: true, key: 'session_id',
    cols: {
      session_id: 'T!', first_ts: 'I', last_ts: 'I', cwd: 'T', project: 'T', git_branch: 'T',
      version: 'T', entrypoint: 'T', config_dir: 'T', user_email: 'T', reported_cost: 'R', bridge_account: 'T',
    },
    // A session's account is a conclusion, except when a bridge record named it.
    select: { bridge_account: "CASE WHEN x.account_source = 'bridge' THEN x.account_uuid END" },
  },
  events: {
    own: 'config_dir',
    cols: {
      call_id: 'T!', uuid: 'T', ts: 'I!', session_id: 'T', request_id: 'T', model: 'T',
      input_tokens: 'I!', output_tokens: 'I!', thinking_tokens: 'I!', cache_write_5m: 'I!',
      cache_write_1h: 'I!', cache_read: 'I!', web_search: 'I!', service_tier: 'T', speed: 'T',
      is_sidechain: 'I!', config_dir: 'T',
    },
  },
  identity_points: {
    own: 'config_dir',
    cols: { session_id: 'T!', ts: 'I!', email: 'T', account_uuid: 'T', source: 'T!', config_dir: 'T' },
  },
  account_observations: {
    own: 'config_dir',
    cols: { ts: 'I!', config_dir: 'T!', account_uuid: 'T!', email: 'T', source: 'T' },
  },
  limit_events: {
    own: 'config_dir',
    cols: { ts: 'I!', session_id: 'T', limit_type: 'T!', resets_at: 'I!', status: 'T', overage: 'T', config_dir: 'T' },
  },
  utilization: {
    own: 'config_dir',
    cols: { ts: 'I!', session_id: 'T!', config_dir: 'T', account_uuid: 'T', limit_type: 'T!', pct: 'R!', resets_at: 'I' },
  },
};

const stmts = new Map();
const stmt = (sql) => {
  let s = stmts.get(sql);
  if (!s) { s = db().prepare(sql); stmts.set(sql, s); }
  return s;
};

/** Where each table ends right now, so a peer can tell if it has read past it. */
export function tableEnds() {
  const out = {};
  const logged = stmt('SELECT MAX(seq) m FROM sync_dirty').get().m ?? 0;
  for (const [t, spec] of Object.entries(TABLES)) {
    out[t] = spec.log ? logged : stmt(`SELECT MAX(rowid) m FROM ${t}`).get().m ?? 0;
  }
  return out;
}

/**
 * The next rows of `tbl` after `after`, as arrays in `cols` order. Rows that
 * came from `peer` are left out - it has them - but still move `upTo` on.
 * Returns null when there is nothing after `after`.
 */
export function exportBatch(tbl, after, { limit = 2000, peer = null } = {}) {
  const spec = TABLES[tbl];
  const cols = Object.keys(spec.cols);
  const sel = cols.map((c) => (spec.select?.[c] ? `${spec.select[c]} AS ${c}` : `x.${c}`)).join(', ');
  const got = stmt(spec.log
    ? `SELECT d.seq AS _at, ${sel} FROM sync_dirty d LEFT JOIN ${tbl} x ON x.${spec.key} = d.key
        WHERE d.tbl = '${tbl}' AND d.seq > ? ORDER BY d.seq LIMIT ?`
    : `SELECT x.rowid AS _at, ${sel} FROM ${tbl} x WHERE x.rowid > ? ORDER BY x.rowid LIMIT ?`).all(after, limit);
  if (!got.length) return null;
  const theirs = peer && spec.own ? `${peer}:` : null;
  const rows = [];
  for (const r of got) {
    if (r[cols[0]] == null) continue;   // logged, since removed
    if (theirs && String(r[spec.own] ?? '').startsWith(theirs)) continue;
    rows.push(cols.map((c) => (c === 'config_dir' ? exportDir(r[c]) : r[c])));
  }
  return { cols, rows, upTo: got[got.length - 1]._at, more: got.length === limit };
}

/* --- taking rows in -------------------------------------------------------- */

function checked(tbl, col, type, v) {
  const need = type.endsWith('!');
  if (v === null || v === undefined) {
    if (need) throw new Error(`${tbl}.${col} is missing`);
    return null;
  }
  const ok = type[0] === 'T' ? typeof v === 'string' && v.length <= 65536
    : type[0] === 'I' ? Number.isSafeInteger(v)
      : typeof v === 'number' && Number.isFinite(v);
  if (!ok) throw new Error(`${tbl}.${col} is not a valid ${type[0] === 'T' ? 'string' : 'number'}`);
  return v;
}

// When two machines disagree about a session or an account, the one that saw
// it more recently wins; otherwise what is here stays. Either way both end up
// with the same row, and a merge that changes nothing is not sent back.
const prefer = (tbl, col, seen) => `CASE WHEN COALESCE(excluded.${seen}, 0) > COALESCE(${tbl}.${seen}, 0)
  THEN COALESCE(excluded.${col}, ${tbl}.${col}) ELSE COALESCE(${tbl}.${col}, excluded.${col}) END`;
const least = (tbl, col) => `MIN(COALESCE(${tbl}.${col}, excluded.${col}), COALESCE(excluded.${col}, ${tbl}.${col}))`;
const most = (tbl, col) => `MAX(COALESCE(${tbl}.${col}, excluded.${col}), COALESCE(excluded.${col}, ${tbl}.${col}))`;

/**
 * Each stores one row, returning undefined if that changed nothing, null if it
 * changed something attribution does not read, or else the time from which
 * attribution could change.
 */
const IMPORT = {
  events(r) {
    // Priced here, by this machine's table, so every call is priced the same way.
    const cost = costOf(r.model, { input: r.input_tokens, output: r.output_tokens,
      cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read });
    const res = stmt(`INSERT INTO events (call_id, uuid, ts, session_id, request_id, model, input_tokens,
        output_tokens, thinking_tokens, cache_write_5m, cache_write_1h, cache_read, web_search,
        service_tier, speed, cost_usd, is_sidechain, config_dir)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(call_id) DO NOTHING`).run(
      r.call_id, r.uuid, r.ts, r.session_id, r.request_id, r.model, r.input_tokens, r.output_tokens,
      r.thinking_tokens, r.cache_write_5m, r.cache_write_1h, r.cache_read, r.web_search,
      r.service_tier, r.speed, cost, r.is_sidechain, r.config_dir);
    return res.changes ? r.ts : undefined;
  },

  identity_points(r) {
    return stmt(`INSERT INTO identity_points (session_id, ts, email, account_uuid, source, config_dir) VALUES (?,?,?,?,?,?)
      ON CONFLICT(session_id, ts, source) DO NOTHING`).run(r.session_id, r.ts, r.email, r.account_uuid, r.source, r.config_dir)
      .changes ? r.ts : undefined;
  },

  account_observations(r) {
    return stmt(`INSERT INTO account_observations (ts, config_dir, account_uuid, email, source) VALUES (?,?,?,?,?)
      ON CONFLICT(ts, config_dir) DO NOTHING`).run(r.ts, r.config_dir, r.account_uuid, r.email, r.source)
      .changes ? r.ts : undefined;
  },

  limit_events(r) {
    // A unique key never matches on NULL, so a refusal with no session would be
    // stored again every time it came back round.
    const res = r.session_id == null
      ? stmt(`INSERT INTO limit_events (ts, session_id, limit_type, resets_at, status, overage, config_dir)
          SELECT ?, NULL, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM limit_events
            WHERE session_id IS NULL AND limit_type = ? AND resets_at = ?)`)
        .run(r.ts, r.limit_type, r.resets_at, r.status, r.overage, r.config_dir, r.limit_type, r.resets_at)
      : stmt(`INSERT INTO limit_events (ts, session_id, limit_type, resets_at, status, overage, config_dir) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(limit_type, resets_at, session_id) DO NOTHING`)
        .run(r.ts, r.session_id, r.limit_type, r.resets_at, r.status, r.overage, r.config_dir);
    return res.changes ? r.ts : undefined;
  },

  utilization(r) {
    return stmt(`INSERT INTO utilization (ts, session_id, config_dir, account_uuid, limit_type, pct, resets_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id, limit_type, ts) DO NOTHING`)
      .run(r.ts, r.session_id, r.config_dir, r.account_uuid, r.limit_type, r.pct, r.resets_at).changes ? r.ts : undefined;
  },

  sessions(r) {
    const before = stmt('SELECT account_source FROM sessions WHERE session_id = ?').get(r.session_id);
    const p = (c) => prefer('sessions', c, 'last_ts');
    const bridged = "excluded.account_source = 'bridge' AND sessions.account_source IS NOT 'bridge'";
    stmt(`INSERT INTO sessions (session_id, first_ts, last_ts, cwd, project, git_branch, version, entrypoint,
        config_dir, user_email, reported_cost, account_uuid, account_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        first_ts = ${least('sessions', 'first_ts')}, last_ts = ${most('sessions', 'last_ts')},
        cwd = ${p('cwd')}, project = ${p('project')}, git_branch = ${p('git_branch')}, version = ${p('version')},
        entrypoint = ${p('entrypoint')}, user_email = ${p('user_email')}, reported_cost = ${p('reported_cost')},
        config_dir = COALESCE(sessions.config_dir, excluded.config_dir),
        account_uuid = CASE WHEN ${bridged} THEN excluded.account_uuid ELSE sessions.account_uuid END,
        account_source = CASE WHEN ${bridged} THEN 'bridge' ELSE sessions.account_source END`).run(
      r.session_id, r.first_ts, r.last_ts, r.cwd, r.project, r.git_branch, r.version, r.entrypoint,
      r.config_dir, r.user_email, r.reported_cost, r.bridge_account, r.bridge_account ? 'bridge' : null);
    // A new session brings a profile for its records; a bridge record, an owner.
    const moved = !before || (r.bridge_account && before.account_source !== 'bridge');
    return moved ? r.first_ts ?? r.last_ts ?? 0 : null;
  },

  accounts(r) {
    const before = stmt('SELECT email FROM accounts WHERE account_uuid = ?').get(r.account_uuid);
    const p = (c) => prefer('accounts', c, 'last_seen');
    stmt(`INSERT INTO accounts (account_uuid, email, display_name, label, org_uuid, org_name, rate_limit_tier,
        subscription_type, billing_type, subscription_at, config_dir, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_uuid) DO UPDATE SET
        email = COALESCE(accounts.email, excluded.email), label = COALESCE(accounts.label, excluded.label),
        display_name = ${p('display_name')}, org_uuid = ${p('org_uuid')}, org_name = ${p('org_name')},
        rate_limit_tier = ${p('rate_limit_tier')}, subscription_type = ${p('subscription_type')},
        billing_type = ${p('billing_type')}, subscription_at = ${p('subscription_at')}, config_dir = ${p('config_dir')},
        first_seen = ${least('accounts', 'first_seen')}, last_seen = ${most('accounts', 'last_seen')}`).run(
      r.account_uuid, r.email, r.display_name, r.label, r.org_uuid, r.org_name, r.rate_limit_tier,
      r.subscription_type, r.billing_type, r.subscription_at, r.config_dir, r.first_seen, r.last_seen);
    // Records name accounts by email, so a newly named account can claim any of them.
    return r.email && !before?.email ? 0 : null;
  },
};

/**
 * Store a batch of rows from machine `from`, and remember how far into its
 * table that reaches - in one transaction, so the two never disagree.
 * Returns how many rows changed anything, and the earliest time any of them
 * could change attribution from (null if none can).
 */
export function importBatch(from, tbl, cols, rows, upTo) {
  const spec = TABLES[tbl];
  if (!spec) throw new Error(`unknown table "${tbl}"`);
  if (!Array.isArray(cols) || !Array.isArray(rows) || !Number.isSafeInteger(upTo) || upTo < 0) {
    throw new Error(`${tbl}: malformed batch`);
  }
  const at = new Map(cols.map((c, i) => [c, i]));
  const want = Object.entries(spec.cols);
  let stored = 0, since = Infinity;
  tx(() => {
    for (const raw of rows) {
      if (!Array.isArray(raw) || raw.length !== cols.length) throw new Error(`${tbl}: malformed row`);
      const r = {};
      for (const [c, type] of want) r[c] = checked(tbl, c, type, at.has(c) ? raw[at.get(c)] : null);
      if ('config_dir' in r) r.config_dir = importDir(r.config_dir, from);
      const t = IMPORT[tbl](r);
      if (t !== undefined) stored++;
      if (t != null) since = Math.min(since, t);
    }
    stmt(`INSERT INTO sync_cursors (machine_id, tbl, cursor) VALUES (?,?,?)
      ON CONFLICT(machine_id, tbl) DO UPDATE SET cursor = excluded.cursor`).run(from, tbl, upTo);
    if (Number.isFinite(since)) noteImport(since);
  });
  return { stored, since: Number.isFinite(since) ? since : null };
}

/*
 * Other tracker processes on this machine - a terminal dashboard attached to
 * the service - cache history they will not re-read. They check this after
 * each refresh, and drop whatever an import reached back past.
 */
function noteImport(since) {
  const prev = importMark();
  const now = Date.now();
  // Readers look at least once a minute; folding five minutes together means
  // none can miss an earlier, older import behind a later, newer one.
  const oldest = prev.at && now - prev.at < 5 * 60_000 ? Math.min(prev.since, since) : since;
  setMeta('sync_import', `${prev.n + 1}|${oldest}|${now}`);
}

/** The latest import: a counter, and the earliest time it reached back to. */
export function importMark() {
  const [n, since, at] = String(getMeta('sync_import', '0|0|0')).split('|').map(Number);
  return { n: n || 0, since: since || 0, at: at || 0 };
}

/* --- machines and peers ---------------------------------------------------- */

/**
 * A machine has said hello: note it, and work out where to resume reading it.
 * A new epoch, or an index shorter than where we had read to, means its rows
 * were renumbered or replaced - read it all again. Re-reading costs time,
 * never correctness: every row is stored at most once.
 */
export function welcome({ id, name, epoch, ends }) {
  const known = stmt('SELECT epoch FROM sync_machines WHERE machine_id = ?').get(id);
  tx(() => {
    stmt(`INSERT INTO sync_machines (machine_id, name, epoch, last_seen) VALUES (?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET name = excluded.name, epoch = excluded.epoch, last_seen = excluded.last_seen`)
      .run(id, name, epoch, Date.now());
    if (known && known.epoch !== epoch) stmt('DELETE FROM sync_cursors WHERE machine_id = ?').run(id);
  });
  const have = new Map(stmt('SELECT tbl, cursor FROM sync_cursors WHERE machine_id = ?').all(id).map((r) => [r.tbl, r.cursor]));
  const out = {};
  for (const t of Object.keys(TABLES)) {
    const c = have.get(t) ?? 0;
    out[t] = Number.isSafeInteger(ends?.[t]) && c > ends[t] ? 0 : c;
  }
  return out;
}

const clean = (v, max = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a machine says is running there and who is signed in, kept to known fields. */
export function saveState(id, state) {
  const running = (Array.isArray(state?.running) ? state.running : []).slice(0, 200).map((s) => ({
    sessionId: clean(s?.sessionId, 64), name: clean(s?.name), cwd: clean(s?.cwd, 1000), status: clean(s?.status, 20),
    background: !!s?.background, lastActivityAt: num(s?.lastActivityAt), profile: clean(s?.profile),
    accountUuid: clean(s?.accountUuid, 64), account: clean(s?.account),
    recent: { calls: num(s?.recent?.calls) ?? 0, cost: num(s?.recent?.cost) ?? 0 },
  })).filter((s) => s.sessionId);
  const profiles = (Array.isArray(state?.profiles) ? state.profiles : []).slice(0, 50).map((p) => ({
    name: clean(p?.name), dir: clean(p?.dir, 1000), isDefault: !!p?.isDefault,
    accountUuid: clean(p?.accountUuid, 64), email: clean(p?.email),
  }));
  const f = state?.failover;
  const failover = f && typeof f === 'object' ? {
    mode: clean(f.mode, 10), at: num(f.at),
    best: f.best ? { label: clean(f.best.label), room: num(f.best.room) } : null,
    entries: (Array.isArray(f.entries) ? f.entries : []).slice(0, 20).map((e) => ({
      profile: clean(e?.profile), label: clean(e?.label), level: num(e?.level), due: !!e?.due, out: !!e?.out, sessions: num(e?.sessions) ?? 0,
      target: e?.target ? { label: clean(e.target.label), room: num(e.target.room), shown: clean(e.target.shown) } : null,
      then: (Array.isArray(e?.then) ? e.then : []).slice(0, 5).map((t) => ({ label: clean(t?.label), room: num(t?.room) })),
    })),
    notices: (Array.isArray(f.notices) ? f.notices : []).slice(0, 10).map((n) => ({
      level: n?.level === 'bad' ? 'bad' : 'warn', text: clean(n?.text, 300), fix: clean(n?.fix, 300),
    })),
    switches: (Array.isArray(f.switches) ? f.switches : []).slice(0, 20).map((m) => ({
      ts: num(m?.ts), profile: clean(m?.profile), from: clean(m?.from), to: clean(m?.to), status: clean(m?.status, 10),
    })),
  } : null;
  const now = Date.now();
  stmt('UPDATE sync_machines SET state = ?, state_at = ?, last_seen = ? WHERE machine_id = ?')
    .run(JSON.stringify({ running, profiles, failover }), now, now, id);
}

export function heardFrom(id) {
  stmt('UPDATE sync_machines SET last_seen = ? WHERE machine_id = ?').run(Date.now(), id);
}

/** A machine is online while it keeps reporting; it reports every few seconds. */
const ONLINE_MS = 45_000;

/** Every other machine this index has synced with, and what is running there now. */
export function remoteMachines(now = Date.now()) {
  return stmt('SELECT machine_id, name, last_seen, state, state_at FROM sync_machines ORDER BY name').all().map((r) => {
    let state = null;
    try { state = r.state ? JSON.parse(r.state) : null; } catch { /* unreadable: nothing running */ }
    const current = !!r.state_at && now - r.state_at < ONLINE_MS;
    return {
      id: r.machine_id, name: r.name ?? r.machine_id, lastSeen: r.last_seen,
      online: !!r.last_seen && now - r.last_seen < ONLINE_MS,
      running: current ? state?.running ?? [] : [],
      profiles: current ? state?.profiles ?? [] : [],
      failover: current ? state?.failover ?? null : null,
    };
  });
}

/** Name of the machine a stored profile path belongs to - null for this one. */
export function machineNameOf(dir) {
  const id = dirMachine(dir);
  if (!id) return null;
  return stmt('SELECT name FROM sync_machines WHERE machine_id = ?').get(id)?.name ?? id;
}

export function listPeers() {
  return stmt('SELECT * FROM sync_peers ORDER BY added_at').all();
}

export function addPeer(target, command = null) {
  stmt(`INSERT INTO sync_peers (target, command, added_at) VALUES (?,?,?)
    ON CONFLICT(target) DO UPDATE SET command = COALESCE(excluded.command, sync_peers.command)`).run(target, command, Date.now());
}

export function removePeer(target) {
  return stmt('DELETE FROM sync_peers WHERE target = ?').run(target).changes > 0;
}

export function peerStatus(target, { status, error = null, machineId = null, command = null }) {
  stmt(`UPDATE sync_peers SET status = ?, error = ?, status_at = ?, machine_id = COALESCE(?, machine_id),
    command = COALESCE(?, command) WHERE target = ?`).run(status, error, Date.now(), machineId, command, target);
}
