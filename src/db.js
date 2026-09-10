import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './paths.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
-- Several instances are normal: a terminal dashboard in one window, a web one
-- in another, plus one-shot status calls from a shell prompt. WAL lets them
-- all read concurrently, but only one may write at a time - without a busy
-- timeout the losers fail instantly with "database is locked" instead of
-- waiting the few milliseconds an ingest batch actually takes.
PRAGMA busy_timeout = 10000;

-- Incremental ingest bookkeeping: how far into each transcript we have read.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL DEFAULT 0,
  offset     INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL DEFAULT 0
);

-- One row per billed assistant response.
CREATE TABLE IF NOT EXISTS events (
  uuid            TEXT PRIMARY KEY,
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
  is_sidechain    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
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
  account_uuid    TEXT,
  account_source  TEXT,   -- 'bridge' | 'observed' | 'inferred' | null
  reported_cost   REAL
);
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

-- Sightings of "this account was signed in at this time", from the live watcher
-- and from .claude.json backups. Used to attribute sessions with no bridge record.
CREATE TABLE IF NOT EXISTS account_observations (
  ts           INTEGER PRIMARY KEY,
  account_uuid TEXT NOT NULL,
  email        TEXT,
  source       TEXT
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

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
 * add a column to a table that already exists, so widen it explicitly.
 */
const MIGRATIONS = [
  ['sessions', 'user_email', 'TEXT'],
];

function migrate(d) {
  for (const [table, column, type] of MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

let _db = null;

export function db() {
  if (_db) return _db;
  ensureDataDir();
  _db = new DatabaseSync(DB_PATH);
  _db.exec(SCHEMA);
  migrate(_db);
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
