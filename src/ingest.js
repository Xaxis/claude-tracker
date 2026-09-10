import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { discoverProfiles, prettyProject } from './paths.js';
import { db, tx } from './db.js';
import { costOf } from './pricing.js';

/**
 * Transcripts are append-only JSONL, so ingest is incremental: we remember the
 * byte offset we stopped at and resume from there. A file that shrank (rotated
 * or rewritten) is re-read from zero.
 */

/**
 * Every transcript under every discovered profile, at any depth.
 *
 * The tree is not flat. Alongside the top-level `<project>/<sessionId>.jsonl`
 * there are per-session `subagents` and `wf_...` workflow directories holding
 * subagent and workflow turns. Those are billed exactly like main-thread turns
 * and count against the same limits, so they must be ingested too; each carries
 * the parent `sessionId`, which keeps attribution intact.
 *
 * Each file is tagged with the profile it came from, which is what later lets a
 * session be attributed to an account outright instead of by inference.
 */
function listTranscripts(profiles = discoverProfiles()) {
  const out = [];

  // Deepest observed layout is project/session/subagents/workflows/wf_id/agent.jsonl.
  const MAX_DEPTH = 8;

  const walk = (dir, slug, profile, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, slug, profile, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        out.push({ path: full, slug, configDir: profile.dir, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  };

  for (const profile of profiles) {
    let projects = [];
    try {
      projects = fs.readdirSync(profile.projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const slug of projects) walk(path.join(profile.projectsDir, slug), slug, profile, 1);
  }
  return out;
}

function tsMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Pull the usage numbers out of an assistant message, normalising shapes. */
function extractUsage(msg) {
  const u = msg?.usage;
  if (!u) return null;
  const cc = u.cache_creation || {};
  // Older records only carry the flat cache_creation_input_tokens total; when the
  // 5m/1h split is absent, attribute the whole amount to the 5m bucket.
  let w5 = cc.ephemeral_5m_input_tokens ?? 0;
  let w1h = cc.ephemeral_1h_input_tokens ?? 0;
  const flat = u.cache_creation_input_tokens ?? 0;
  if (!w5 && !w1h && flat) w5 = flat;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheWrite5m: w5,
    cacheWrite1h: w1h,
    cacheRead: u.cache_read_input_tokens ?? 0,
    webSearch: u.server_tool_use?.web_search_requests ?? 0,
    serviceTier: u.service_tier ?? null,
    speed: u.speed ?? null,
  };
}

const STMT = {};
function prepare(d) {
  STMT.event ||= d.prepare(`
    INSERT INTO events (call_id, uuid, ts, session_id, request_id, model, input_tokens, output_tokens,
                        thinking_tokens, cache_write_5m, cache_write_1h, cache_read, web_search,
                        service_tier, speed, cost_usd, is_sidechain)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(call_id) DO NOTHING`);
  STMT.limit ||= d.prepare(`
    INSERT INTO limit_events (ts, session_id, account_uuid, limit_type, resets_at, status, overage)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(limit_type, resets_at, session_id) DO NOTHING`);
  STMT.bridge ||= d.prepare(`
    INSERT INTO sessions (session_id, account_uuid, account_source)
    VALUES (?,?, 'bridge')
    ON CONFLICT(session_id) DO UPDATE SET account_uuid = excluded.account_uuid, account_source = 'bridge'`);
  STMT.sessMeta ||= d.prepare(`
    INSERT INTO sessions (session_id, first_ts, last_ts, cwd, project, git_branch, version, entrypoint, config_dir)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      first_ts   = MIN(COALESCE(sessions.first_ts, excluded.first_ts), excluded.first_ts),
      last_ts    = MAX(COALESCE(sessions.last_ts, excluded.last_ts), excluded.last_ts),
      cwd        = COALESCE(excluded.cwd, sessions.cwd),
      project    = COALESCE(excluded.project, sessions.project),
      git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
      version    = COALESCE(excluded.version, sessions.version),
      entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint),
      config_dir = COALESCE(sessions.config_dir, excluded.config_dir)`);
  STMT.cost ||= d.prepare(`
    INSERT INTO sessions (session_id, reported_cost) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET reported_cost = excluded.reported_cost`);
  STMT.sessEmail ||= d.prepare(`
    INSERT INTO sessions (session_id, user_email) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET user_email = excluded.user_email`);
  STMT.acctSeen ||= d.prepare(`
    INSERT INTO accounts (account_uuid, org_uuid, first_seen, last_seen)
    VALUES (?,?,?,?)
    ON CONFLICT(account_uuid) DO UPDATE SET
      org_uuid   = COALESCE(accounts.org_uuid, excluded.org_uuid),
      first_seen = MIN(COALESCE(accounts.first_seen, excluded.first_seen), excluded.first_seen),
      last_seen  = MAX(COALESCE(accounts.last_seen, excluded.last_seen), excluded.last_seen)`);
  STMT.fileMark ||= d.prepare(`
    INSERT INTO files (path, size, offset, mtime, scanned_at) VALUES (?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, offset = excluded.offset,
      mtime = excluded.mtime, scanned_at = excluded.scanned_at`);
  return STMT;
}

/** Parse one JSONL line and write whatever it carries. Returns 1 if it was a usage event. */
function handleLine(line, ctx) {
  if (!line || line.length < 2 || line[0] !== '{') return 0;
  let d;
  try { d = JSON.parse(line); } catch { return 0; }

  const type = d.type;

  // Owner of a bridged session - the only place a transcript names its account.
  if (type === 'bridge-session') {
    if (d.sessionId && d.ownerAccountUuid) {
      STMT.bridge.run(d.sessionId, d.ownerAccountUuid);
      STMT.acctSeen.run(d.ownerAccountUuid, d.ownerOrganizationUuid ?? null, ctx.now, ctx.now);
    }
    return 0;
  }

  // Recent Claude Code versions inject the signed-in user's email into each
  // session's context. That is the only place a transcript names the account in
  // human terms, so it is what lets an account show up as an address instead of
  // a bare UUID. Older sessions predate it and stay anonymous.
  if (type === 'attachment' && d.attachment?.type === 'session_context') {
    const raw = d.attachment.context?.userEmail;
    if (raw && d.sessionId) {
      const m = /email address is\s+([^\s,;]+@[^\s,;]+?)[.,;]?(?:\s|$)/i.exec(String(raw));
      if (m) STMT.sessEmail.run(d.sessionId, m[1]);
    }
    return 0;
  }

  // Claude Code's own per-session cost rollup - kept as a cross-check.
  if (type === 'cost-state') {
    if (d.sessionId && typeof d.totalCostUSD === 'number') {
      STMT.cost.run(d.sessionId, d.totalCostUSD);
    }
    return 0;
  }

  const ts = tsMs(d.timestamp);

  // Rate-limit rejection: ground truth for calibration.
  const q = d.quotaLimits;
  if (q && q.resetsAt && q.rateLimitType && ts) {
    STMT.limit.run(ts, d.sessionId ?? null, null, q.rateLimitType, q.resetsAt,
      q.status ?? null, q.overageStatus ?? null);
  }

  if (type !== 'assistant' || !ts) return 0;

  const msg = d.message;
  const model = msg?.model;
  // "<synthetic>" marks locally generated messages (errors, limit notices) that
  // never hit the API - they carry zeroed usage and must not count as spend.
  if (!model || model === '<synthetic>') return 0;

  const u = extractUsage(msg);
  if (!u) return 0;
  const total = u.input + u.output + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
  if (total <= 0) return 0;

  // Identify the API response, not the transcript line: a multi-block response
  // is written as several lines that each repeat the same usage totals, and only
  // one of them represents real spend. message.id names the response directly;
  // requestId names the HTTP call that produced it; the line uuid is the last
  // resort for records that carry neither.
  const callId = msg.id || d.requestId || d.uuid || `${ts}:${model}`;
  const cost = costOf(model, u);
  const res = STMT.event.run(
    callId, d.uuid ?? null, ts, d.sessionId ?? null, d.requestId ?? null, model,
    u.input, u.output, u.thinking, u.cacheWrite5m, u.cacheWrite1h, u.cacheRead,
    u.webSearch, u.serviceTier, u.speed, cost, d.isSidechain ? 1 : 0,
  );
  // A repeat of a response we already have contributes nothing; report only
  // rows actually stored so the ingest count means what it says.
  const stored = res.changes > 0 ? 1 : 0;

  if (d.sessionId) {
    STMT.sessMeta.run(
      d.sessionId, ts, ts, d.cwd ?? null,
      prettyProject(ctx.slug, d.cwd), d.gitBranch ?? null, d.version ?? null, d.entrypoint ?? null,
      ctx.configDir,
    );
  }
  return stored;
}

/**
 * Read one transcript from `from` bytes to EOF, returning bytes consumed.
 *
 * Transcripts reach hundreds of megabytes, so the file is streamed rather than
 * read whole. Writes are grouped into transactions of CHUNK lines: one
 * transaction per line is punishingly slow, and one per file would hold the
 * write lock across the entire read.
 */
const CHUNK = 5000;

async function ingestFile(file, from) {
  const d = db();
  const stream = fs.createReadStream(file.path, { start: from, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const ctx = { slug: file.slug, configDir: file.configDir ?? null, now: Date.now() };
  let consumed = from;
  let events = 0;
  let pendingBytes = 0;
  let inTx = 0;

  const begin = () => { if (!inTx) d.exec('BEGIN'); };
  const commit = () => { if (inTx) { d.exec('COMMIT'); inTx = 0; } };

  try {
    for await (const line of rl) {
      // +1 for the newline. A trailing partial line (no newline yet) must not
      // advance the offset, so `consumed` only moves after a complete line.
      pendingBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (line.trim()) {
        begin();
        inTx++;
        events += handleLine(line, ctx);
        if (inTx >= CHUNK) commit();
      }
      consumed = from + pendingBytes;
    }
    commit();
  } catch (err) {
    try { if (inTx) d.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
  return { consumed: Math.min(consumed, file.size), events };
}

/**
 * Scan every transcript, ingesting only what is new.
 * @param {{force?: boolean, onProgress?: (done:number,total:number)=>void}} opts
 */
export async function ingestAll(opts = {}) {
  const d = db();
  prepare(d);
  const profiles = opts.profiles ?? discoverProfiles();
  const files = listTranscripts(profiles);
  const known = new Map(
    d.prepare('SELECT path, size, offset, mtime FROM files').all().map((r) => [r.path, r]),
  );

  let scanned = 0, skipped = 0, newEvents = 0, bytes = 0;
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    const work = batch; batch = [];
    tx(() => { for (const fn of work) fn(); });
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prev = known.get(f.path);
    let from = 0;
    if (prev && !opts.force) {
      if (f.size === prev.size && f.mtime === prev.mtime) { skipped++; continue; }
      // Shrunk => rewritten from scratch; otherwise resume where we left off.
      from = f.size >= prev.size ? prev.offset : 0;
    }

    const { consumed, events } = await ingestFile(f, from);
    newEvents += events;
    bytes += consumed - from;
    scanned++;
    batch.push(() => STMT.fileMark.run(f.path, f.size, consumed, f.mtime, Date.now()));
    if (batch.length >= 200) flush();
    opts.onProgress?.(i + 1, files.length);
  }
  flush();

  return { files: files.length, scanned, skipped, newEvents, bytes, profiles: profiles.length };
}

export { listTranscripts };
