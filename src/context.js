import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { costOf } from './pricing.js';

/**
 * What each session carries into every turn, and what re-caching it costs.
 *
 * Every turn re-sends the whole conversation, so a turn's context - input plus
 * cache writes plus cache reads - is what that session costs per turn: at 600k
 * tokens a turn re-reads 18 times what a fresh session does. Most of it is
 * read from the prompt cache, which lapses after a pause: by default 5 minutes
 * for subagents, an hour for the main thread on a subscription. The turn after a
 * lapse writes the whole context again, at 12 to 20 times the read price. On a
 * busy machine those re-writes are a quarter of all spend.
 */

const CTX = 'input_tokens + cache_write_5m + cache_write_1h + cache_read';
const WRITES = 'cache_write_5m + cache_write_1h';

/** A turn re-wrote an expired cache when most of a sizeable context was written, not read. */
const RECACHE_MIN = 50_000;
const RECACHE = `(${CTX}) >= ${RECACHE_MIN} AND (${WRITES}) * 2 >= (${CTX})`;

/** Subagents seen working within this long count as active. */
const AGENT_WINDOW_MS = 15 * 60_000;

/** The context window a model compacts within: native 1M models, else 200k. */
function contextWindow(model) {
  const bare = String(model ?? '').replace(/\[[^\]]*\]$/, '');
  return /claude-(3|opus-4-[0-6]|sonnet-4|haiku-4)/.test(bare) ? 200_000 : 1_000_000;
}

/** Claude Code compacts at about 96.7% of the window by default. */
const compactAt = (model) => Math.round(contextWindow(model) * 0.967);

/**
 * The main thread's newest turn among `ids` (a session can write under its own
 * id and a parked job's): how much context it carried, when, and what
 * re-reading that much costs per turn.
 */
export function mainContext(ids) {
  const q = db().prepare(`SELECT ${CTX} AS tokens, ts, model FROM events
     WHERE session_id = ? AND is_sidechain = 0 ORDER BY ts DESC LIMIT 1`);
  let best = null;
  for (const id of ids.filter(Boolean)) {
    const r = q.get(id);
    if (r && (!best || r.ts > best.ts)) best = r;
  }
  if (!best) return null;
  return {
    tokens: best.tokens, at: best.ts, model: best.model,
    compactAt: compactAt(best.model),
    perTurn: costOf(best.model, { cacheRead: best.tokens }),
  };
}

/* --- subagents ------------------------------------------------------------ */

/**
 * Transcripts named `name`, here: the index can also hold paths from another
 * machine's tree, copied over with an old index, which are no use here.
 */
function indexed(name) {
  return db().prepare('SELECT path FROM files WHERE path LIKE ?').all(`%${path.sep}${name}`)
    .map((r) => r.path).filter((p) => fs.existsSync(p));
}

// A session's transcript directory never moves; found once, by its main file.
const dirOf = new Map();
function transcriptDir(sessionId, now) {
  const known = dirOf.get(sessionId);
  // A miss - nothing ingested for it yet - is looked for again after a minute.
  if (known && (known.dir || now - known.at < 60_000)) return known.dir;
  const [file] = indexed(`${sessionId}.jsonl`);
  const dir = file ? path.join(path.dirname(file), sessionId) : null;
  dirOf.set(sessionId, { dir, at: now });
  return dir;
}

const metaOf = new Map();
function agentMeta(file) {
  if (metaOf.has(file)) return metaOf.get(file);
  let m = null;
  try {
    const j = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    m = { name: j.name ?? j.agentType ?? null, type: j.agentType ?? null };
  } catch { /* none written */ }
  metaOf.set(file, m);
  return m;
}

/**
 * What to call a job's worktree: an isolated subagent's is named after its id
 * (`agent-abed60a8…`), and the meta beside that agent's transcript says what it
 * is called. The worktree can outlive the session that made it, so the agent is
 * looked for by id, wherever it was recorded. Any other worktree keeps its name.
 */
const placeNames = new Map();
export function placeName(_sessionId, place) {
  if (!place || !/^agent-[0-9a-z]+$/.test(place)) return place;
  const now = Date.now();
  const known = placeNames.get(place);
  if (known && (known.name || now - known.at < 60_000)) return known.name ?? place;
  const name = indexed(`${place}.jsonl`).map((p) => agentMeta(p)?.name).find(Boolean) ?? null;
  placeNames.set(place, { name, at: now });
  return name ?? place;
}

/**
 * Subagents of a session seen working recently, newest first, by their
 * transcripts' last writes. The index already records when each was last
 * read, so this costs a range scan, not a directory walk.
 */
export function activeAgents(sessionId, now = Date.now()) {
  const dir = sessionId && transcriptDir(sessionId, now);
  if (!dir) return [];
  const lo = path.join(dir, 'subagents') + path.sep;
  return db().prepare(`SELECT path, mtime FROM files WHERE path >= ? AND path < ? AND mtime >= ? ORDER BY mtime DESC`)
    .all(lo, lo + '￿', now - AGENT_WINDOW_MS)
    .map((r) => ({ name: agentMeta(r.path)?.name ?? path.basename(r.path, '.jsonl').replace(/^agent-/, ''), at: r.mtime }));
}

/* --- re-caching ------------------------------------------------------------ */

/** What the cache writes of these turns cost, priced per model. */
function writeCost(rows) {
  let cost = 0;
  for (const r of rows) cost += costOf(r.model, { cacheWrite5m: r.w5, cacheWrite1h: r.w1 });
  return cost;
}

/** Turns of these sessions that re-wrote an expired cache since `since`. */
export function sessionRecaches(ids, since) {
  const q = db().prepare(`SELECT model, cache_write_5m w5, cache_write_1h w1 FROM events
     WHERE session_id = ? AND ts >= ? AND ${RECACHE}`);
  const rows = ids.filter(Boolean).flatMap((id) => q.all(id, since));
  return { turns: rows.length, cost: writeCost(rows) };
}

/**
 * Re-caching across every session since `since`: how many turns re-wrote an
 * expired cache and what that cost, against all spend, for subagents and the
 * main thread apart - they keep their caches for different lengths of time.
 */
function recacheSince(since) {
  const d = db();
  const total = d.prepare('SELECT COALESCE(SUM(cost_usd), 0) c, COUNT(*) n FROM events WHERE ts >= ?').get(since);
  const rows = d.prepare(`SELECT is_sidechain sc, model, COUNT(*) n, SUM(cache_write_5m) w5, SUM(cache_write_1h) w1
     FROM events WHERE ts >= ? AND ${RECACHE} GROUP BY is_sidechain, model`).all(since);
  const part = (sc) => {
    const mine = rows.filter((r) => r.sc === sc);
    return { turns: mine.reduce((a, r) => a + r.n, 0), cost: writeCost(mine) };
  };
  const sub = part(1), main = part(0);
  const cost = sub.cost + main.cost;
  return { turns: sub.turns + main.turns, cost, spend: total.c, calls: total.n,
    share: total.c ? cost / total.c : 0, sub, main };
}

/**
 * Which cache lifetime subagents and the main thread write with now: '5m', '1h',
 * or null when they wrote nothing lately. Counted by call over the latest
 * writes, not by tokens - one lapse re-writes as much as a day of turns, and
 * would hide a change of setting for hours.
 */
function ttls(since) {
  const q = db().prepare(`SELECT SUM(h) h, COUNT(*) n FROM (SELECT cache_write_1h > cache_write_5m AS h FROM events
     WHERE is_sidechain = ? AND ts >= ? AND cache_write_5m + cache_write_1h > 0 ORDER BY ts DESC LIMIT 200)`);
  const of = (sc) => {
    const r = q.get(sc, since);
    return r.n ? (r.h * 2 > r.n ? '1h' : '5m') : null;
  };
  return { sub: of(1), main: of(0) };
}

let memo = null;
const MEMO_MS = 60_000;

/**
 * The machine-wide re-caching picture for the dashboards: the last day and the
 * last week. Older turns never change, so it is worked out at most once a minute.
 */
export function cacheSummary(now = Date.now()) {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const day = recacheSince(now - 86400e3);
  const week = recacheSince(now - 7 * 86400e3);
  const ttl = ttls(now - 86400e3);
  // Subagents still on the 5-minute cache, and re-writing it for real money: say
  // what raises it. Once they write 1-hour caches the advice goes away by itself.
  const hint = ttl.sub === '5m' && week.sub.cost > 0.05 * week.spend
    ? { setting: 'subagentPromptCacheTtl', value: '1h', env: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL' }
    : null;
  const value = { day, week, ttl, hint };
  memo = { at: now, value };
  return value;
}

export function resetCacheSummary() { memo = null; }
