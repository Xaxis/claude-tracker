import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './paths.js';

const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
-- Several instances are normal: a terminal dashboard in one window, a web one
-- in another, plus one-shot status calls from a shell prompt. WAL lets them
-- all read concurrently, but only one may write at a time - without a busy
-- timeout the losers fail instantly with "database is locked" instead of
-- waiting the few milliseconds an ingest batch actually takes.
PRAGMA busy_timeout = 10000;
`;

const SCHEMA = `

-- Incremental ingest bookkeeping: how far into each transcript we have read.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL DEFAULT 0,
  offset     INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL DEFAULT 0
);

-- One row per billed API response.
--
-- The key is the response's own id, NOT the transcript line's uuid. Claude Code
-- writes one JSONL line per content block, so a single response with 40 tool
-- calls lands as 40 lines - each repeating the *same* usage totals. Keying on
-- the line would count that response 40 times; keying on the response counts it
-- once, which is what was actually billed.
CREATE TABLE IF NOT EXISTS events (
  call_id         TEXT PRIMARY KEY,
  uuid            TEXT,
  ts              INTEGER NOT NULL,
  session_id      TEXT,
  request_id      TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  thinking_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h  INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  web_search      INTEGER NOT NULL DEFAULT 0,
  service_tier    TEXT,
  speed           TEXT,
  cost_usd        REAL NOT NULL DEFAULT 0,
  is_sidechain    INTEGER NOT NULL DEFAULT 0,
  -- Attribution is per call, not per session: a running session follows a
  -- /login onto the new account partway through, so one session can bill
  -- several accounts. Each call records the profile it was written under and
  -- the account it resolved to at its own timestamp.
  config_dir      TEXT,
  account_uuid    TEXT,
  account_source  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
-- Covering indexes: windows, burn rates and billing sums read only (account, ts,
-- cost), and the totals cache groups by (account, session) - so neither ever has
-- to visit the table rows themselves.
DROP INDEX IF EXISTS idx_events_acct_ts;
DROP INDEX IF EXISTS idx_events_acct_sess;
CREATE INDEX IF NOT EXISTS idx_events_acct_ts_cost ON events(account_uuid, ts, cost_usd);
CREATE INDEX IF NOT EXISTS idx_events_acct_sess_ts ON events(account_uuid, session_id, ts, cost_usd);
CREATE INDEX IF NOT EXISTS idx_events_unattr  ON events(account_uuid) WHERE account_uuid IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_model   ON events(model);

-- Per-session rollup, including which account owns it.
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  first_ts        INTEGER,
  last_ts         INTEGER,
  cwd             TEXT,
  project         TEXT,
  git_branch      TEXT,
  version         TEXT,
  entrypoint      TEXT,
  config_dir      TEXT,   -- the Claude profile this session was recorded under
  user_email      TEXT,   -- signed-in address, when the session recorded one
  account_uuid    TEXT,
  account_source  TEXT,   -- 'bridge' | 'profile' | 'observed' | 'inferred' | null
  reported_cost   REAL
);
CREATE INDEX IF NOT EXISTS idx_sessions_config ON sessions(config_dir);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_uuid);
CREATE INDEX IF NOT EXISTS idx_sessions_last    ON sessions(last_ts);

-- Accounts we know about, however we learned of them.
CREATE TABLE IF NOT EXISTS accounts (
  account_uuid      TEXT PRIMARY KEY,
  email             TEXT,
  display_name      TEXT,
  label             TEXT,
  org_uuid          TEXT,
  org_name          TEXT,
  rate_limit_tier   TEXT,
  subscription_type TEXT,
  billing_type      TEXT,
  subscription_at   TEXT,   -- ISO date the subscription started; anchors the cycle
  config_dir        TEXT,   -- profile this account is signed into, when known
  first_seen        INTEGER,
  last_seen         INTEGER
);

-- Hard evidence: the API told us a limit was hit and when it resets.
CREATE TABLE IF NOT EXISTS limit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  session_id    TEXT,
  account_uuid  TEXT,
  limit_type    TEXT NOT NULL,       -- 'five_hour' | 'seven_day'
  resets_at     INTEGER NOT NULL,    -- epoch seconds
  status        TEXT,
  overage       TEXT,
  UNIQUE(limit_type, resets_at, session_id)
);
CREATE INDEX IF NOT EXISTS idx_limit_ts ON limit_events(ts);

-- Sightings of "this account was signed into this profile at this time", from
-- the live watcher and from each profile's config backups. A profile holds one
-- account at a time, so these form a per-profile timeline that dates any session
-- recorded under it.
CREATE TABLE IF NOT EXISTS account_observations (
  ts           INTEGER NOT NULL,
  config_dir   TEXT NOT NULL DEFAULT '',
  account_uuid TEXT NOT NULL,
  email        TEXT,
  source       TEXT,
  PRIMARY KEY (ts, config_dir)
);
CREATE INDEX IF NOT EXISTS idx_obs_dir ON account_observations(config_dir, ts);

-- Dated statements, from inside a session's own transcript, of which account it
-- was running as. Claude Code writes a session_context record with the signed-in
-- email when a session starts and again whenever the account changes, so these
-- mark the exact moment a running session switched. Bridge records carry an
-- owner but no timestamp; they are dated by the last timestamped line before them.
CREATE TABLE IF NOT EXISTS identity_points (
  session_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  email        TEXT,
  account_uuid TEXT,
  source       TEXT NOT NULL,       -- 'context' | 'bridge'
  PRIMARY KEY (session_id, ts, source)
);

-- Learned capacity per (account, limit_type), produced by calibrate.js.
CREATE TABLE IF NOT EXISTS calibration (
  account_uuid TEXT NOT NULL,
  limit_type   TEXT NOT NULL,
  capacity     REAL NOT NULL,      -- quota units (USD-equivalent) per window
  samples      INTEGER NOT NULL DEFAULT 0,
  confidence   TEXT,               -- 'measured' | 'partial' | 'default'
  updated_at   INTEGER,
  PRIMARY KEY (account_uuid, limit_type)
);

-- Exact plan utilization, as Claude Code itself reports it to each session's
-- status line. Ground truth for the bars wherever a session has run recently.
CREATE TABLE IF NOT EXISTS utilization (
  ts           INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  config_dir   TEXT,
  account_uuid TEXT,
  limit_type   TEXT NOT NULL,       -- 'five_hour' | 'seven_day' | 'spend_limit'
  pct          REAL NOT NULL,       -- 0-100
  resets_at    INTEGER,             -- epoch ms
  PRIMARY KEY (session_id, limit_type, ts)
);
CREATE INDEX IF NOT EXISTS idx_util_acct ON utilization(account_uuid, limit_type, ts);

-- Notifications already sent, so several tracker processes never repeat one.
CREATE TABLE IF NOT EXISTS notifications (
  key TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Bump when the schema changes. Nothing is thrown away on an upgrade: Claude
 * Code deletes old transcripts, so history this index holds may exist nowhere
 * else, and account details come from config snapshots that rotate away.
 */
const SCHEMA_VERSION = 6;

function ensureSchema(d) {
  // The version has to be read before the schema is applied: an old table plus
  // a new index over a column it lacks is an error, not a no-op.
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const have = row ? Number(row.value) : 0;

  const fresh = !d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  if (have === SCHEMA_VERSION || fresh) {
    d.exec(SCHEMA);
    d.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    return;
  }

  // Rename every table aside, recreate it from the new schema, and refill it
  // with every column the two versions share. Indexes are dropped first: they
  // follow a renamed table, and would stop the new table from getting its own.
  const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name != 'meta'`).all().map((r) => r.name);
  const q = (id) => `"${id.replace(/"/g, '""')}"`;
  d.exec('BEGIN');
  try {
    for (const t of tables) {
      for (const { name } of d.prepare(`SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(t)) d.exec(`DROP INDEX ${q(name)}`);
      d.exec(`ALTER TABLE ${q(t)} RENAME TO ${q(t + '__old')}`);
    }
    d.exec(SCHEMA);
    for (const t of tables) {
      const newCols = new Set(d.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name));
      const shared = d.prepare(`PRAGMA table_info(${q(t + '__old')})`).all().map((c) => c.name).filter((c) => newCols.has(c));
      if (shared.length) {
        const cols = shared.map(q).join(', ');
        d.exec(`INSERT OR IGNORE INTO ${q(t)} (${cols}) SELECT ${cols} FROM ${q(t + '__old')}`);
      }
      d.exec(`DROP TABLE ${q(t + '__old')}`);
    }
    d.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

let _db = null;

export function db() {
  if (_db) return _db;
  ensureDataDir();
  _db = new DatabaseSync(DB_PATH);
  _db.exec(PRAGMAS);
  ensureSchema(_db);
  return _db;
}

export function getMeta(key, fallback = null) {
  const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db()
    .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** Run fn inside a transaction, rolling back on throw. */
export function tx(fn) {
  const d = db();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
