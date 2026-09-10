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
 * Everything here is derived from transcripts on disk, so the index is a cache,
 * not a record. When the schema changes, rebuilding from source is both simpler
 * and more trustworthy than migrating - a full rescan takes about half a minute.
 * Only genuinely user-authored state is carried across (currently: labels).
 */
const SCHEMA_VERSION = 5;

const DERIVED_TABLES = [
  'files', 'events', 'sessions', 'limit_events', 'calibration', 'accounts',
];

// Account sightings are NOT derived: each comes from a config snapshot that
// rotates away within hours. Once lost they cannot be recovered from anything on
// disk, so they survive a rebuild.
const PRESERVED_TABLES = ['account_observations'];

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

  // Preserve names the user set by hand; they cannot be re-derived.
  let labels = [];
  try {
    labels = d.prepare('SELECT account_uuid, label FROM accounts WHERE label IS NOT NULL').all();
  } catch { /* table predates labels */ }

  let observations = [];
  try {
    observations = d.prepare('SELECT ts, config_dir, account_uuid, email, source FROM account_observations').all();
  } catch { /* table predates per-profile observations */ }

  for (const t of DERIVED_TABLES) d.exec(`DROP TABLE IF EXISTS ${t}`);
  d.exec(SCHEMA);
  for (const o of observations) {
    d.prepare(`INSERT INTO account_observations (ts, config_dir, account_uuid, email, source)
               VALUES (?,?,?,?,?) ON CONFLICT(ts, config_dir) DO NOTHING`)
      .run(o.ts, o.config_dir ?? '', o.account_uuid, o.email, o.source);
  }
  for (const l of labels) {
    d.prepare(`INSERT INTO accounts (account_uuid, label) VALUES (?, ?)
               ON CONFLICT(account_uuid) DO UPDATE SET label = excluded.label`)
      .run(l.account_uuid, l.label);
  }
  d.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
}

let _db = null;

export function db() {
  if (_db) return _db;
  ensureDataDir();
  _db = new DatabaseSync(DB_PATH);
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
