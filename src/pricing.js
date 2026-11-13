/**
 * Per-model token rates in USD per million tokens.
 *
 * Anthropic's subscription rate limits are not published as raw token counts,
 * and different models draw down a plan's quota at very different rates. We use
 * list API price as the common denominator: every event is converted to a USD
 * "quota unit", and the real ceiling for each window is then learned from
 * observed rate-limit rejections (see calibrate.js) rather than guessed.
 *
 * Cache rates follow the standard multipliers: a 5-minute cache write costs
 * 1.25x base input, a 1-hour write 2x, and a cache read 0.1x - except where a
 * model's cache reads are priced on their own (Fable 5.1 $0.25, Fable 5.2 and
 * Opus 5.5 $0.20, Sonnet 5.5 $0.10 per MTok).
 *
 * Each point release has its own line: Opus 5.5 costs less than Opus 5, and a
 * family-wide match priced and named every Opus 5.x as Opus 5. Stored calls are
 * repriced when this table changes (`repriceSql`), so a window never adds up
 * calls priced by two tables.
 */

const M = 1_000_000;

/**
 * base = input, out = output, cr = cache read (overrides the 0.1x default).
 * long = the rates for a whole call whose prompt is over `over` tokens.
 * Most specific first: claude-opus-5-5 must meet its own line before Opus 5's.
 */
const MODELS = [
  { match: /^claude-fable-5-2/, name: 'Fable 5.2', tier: 'fable', base: 8, out: 40, cr: 0.2 },
  { match: /^claude-mythos-5-2/, name: 'Mythos 5.2', tier: 'fable', base: 8, out: 40, cr: 0.2 },
  { match: /^claude-fable-5-1/, name: 'Fable 5.1', tier: 'fable', base: 10, out: 50, cr: 0.25 },
  { match: /^claude-mythos-5-1/, name: 'Mythos 5.1', tier: 'fable', base: 10, out: 50, cr: 0.25 },
  { match: /^claude-fable-5/, name: 'Fable 5', tier: 'fable', base: 10, out: 50 },
  { match: /^claude-mythos-5/, name: 'Mythos 5', tier: 'fable', base: 10, out: 50 },
  { match: /^claude-opus-5-5/, name: 'Opus 5.5', tier: 'opus', base: 4, out: 20, cr: 0.2 },
  { match: /^claude-opus-5/, name: 'Opus 5', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-8/, name: 'Opus 4.8', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-7/, name: 'Opus 4.7', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-6/, name: 'Opus 4.6', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-5/, name: 'Opus 4.5', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4/, name: 'Opus 4', tier: 'opus', base: 15, out: 75 },
  { match: /^claude-sonnet-5-5/, name: 'Sonnet 5.5', tier: 'sonnet', base: 2, out: 10, cr: 0.1 },
  { match: /^claude-sonnet-5/, name: 'Sonnet 5', tier: 'sonnet', base: 2, out: 10 },
  { match: /^claude-sonnet-4-6/, name: 'Sonnet 4.6', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-sonnet-4/, name: 'Sonnet 4', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-3-7-sonnet/, name: 'Sonnet 3.7', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-haiku-5-5/, name: 'Haiku 5.5', tier: 'haiku', base: 0.1, out: 0.5, long: { over: 100_000, base: 0.5, out: 2.5 } },
  { match: /^claude-haiku-4-5/, name: 'Haiku 4.5', tier: 'haiku', base: 1, out: 5 },
  { match: /^claude-3-5-haiku/, name: 'Haiku 3.5', tier: 'haiku', base: 0.8, out: 4 },
];

const UNKNOWN = { name: 'unknown', tier: 'unknown', base: 5, out: 25 };

const cache = new Map();

// The release an id names ("claude-opus-5-7" is Opus 5.7, "claude-haiku-4-5-20251001"
// Haiku 4.5), so a release this table does not list yet still shows as itself.
function releaseName(bare) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : null;
}

/**
 * Look up rates for a model id. Claude Code appends context/variant suffixes
 * such as "[1m]" - those do not change the per-token rate for current models,
 * so they are stripped before matching.
 */
export function modelInfo(modelId) {
  if (!modelId) return { ...UNKNOWN, id: modelId, cr: UNKNOWN.base * 0.1, long: null, known: false };
  if (cache.has(modelId)) return cache.get(modelId);
  const bare = String(modelId).replace(/\[[^\]]*\]$/, '');
  const hit = MODELS.find((m) => m.match.test(bare));
  const long = hit?.long ? { over: hit.long.over, base: hit.long.base, out: hit.long.out, cr: hit.long.cr ?? hit.long.base * 0.1 } : null;
  const info = hit
    ? { id: modelId, name: releaseName(bare) ?? hit.name, tier: hit.tier, base: hit.base, out: hit.out, cr: hit.cr ?? hit.base * 0.1, long, known: true }
    : { ...UNKNOWN, id: modelId, cr: UNKNOWN.base * 0.1, long: null, known: false };
  cache.set(modelId, info);
  return info;
}

/** Short display name, e.g. "Opus 5". Falls back to the raw id. */
export function modelLabel(modelId) {
  const i = modelInfo(modelId);
  return i.known ? i.name : String(modelId ?? 'unknown');
}

/**
 * USD cost of a single API response.
 * @param {string} modelId
 * @param {{input?:number,output?:number,cacheWrite5m?:number,cacheWrite1h?:number,cacheRead?:number}} t
 */
export function costOf(modelId, t) {
  const info = modelInfo(modelId);
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const w5 = t.cacheWrite5m ?? 0;
  const w1h = t.cacheWrite1h ?? 0;
  const read = t.cacheRead ?? 0;
  const i = info.long && input + w5 + w1h + read > info.long.over ? info.long : info;
  return (
    (input * i.base + output * i.out + w5 * i.base * 1.25 + w1h * i.base * 2 + read * i.cr) / M
  );
}

/** What costOf computes, as SQL over an events row, for one model's calls. */
export function repriceSql(modelId) {
  const info = modelInfo(modelId);
  const n = (x) => String(Number(x));
  const linear = (i) => `(input_tokens * ${n(i.base)} + output_tokens * ${n(i.out)} + cache_write_5m * ${n(i.base)} * 1.25`
    + ` + cache_write_1h * ${n(i.base)} * 2 + cache_read * ${n(i.cr)}) / ${M}.0`;
  return info.long
    ? `CASE WHEN input_tokens + cache_write_5m + cache_write_1h + cache_read > ${n(info.long.over)} THEN ${linear(info.long)} ELSE ${linear(info)} END`
    : linear(info);
}

/** Changes whenever any rate in the table does: stored costs priced by another table are stale. */
export const PRICING_ID = JSON.stringify([UNKNOWN, ...MODELS.map((m) => [m.match.source, m.base, m.out, m.cr ?? null, m.long ?? null])]);

export const KNOWN_MODELS = MODELS.map((m) => m.name);
