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
 * 1.25x base input, a 1-hour write 2x, and a cache read 0.1x - with the one
 * documented exception that Fable-tier cache reads are billed at $0.25/MTok.
 */

const M = 1_000_000;

/** base = input, out = output, cr = cache read (overrides the 0.1x default). */
const MODELS = [
  { match: /^claude-fable-5-1/, name: 'Fable 5.1', tier: 'fable', base: 10, out: 50, cr: 0.25 },
  { match: /^claude-mythos-5-1/, name: 'Mythos 5.1', tier: 'fable', base: 10, out: 50, cr: 0.25 },
  { match: /^claude-fable-5/, name: 'Fable 5', tier: 'fable', base: 10, out: 50 },
  { match: /^claude-mythos-5/, name: 'Mythos 5', tier: 'fable', base: 10, out: 50 },
  { match: /^claude-opus-5/, name: 'Opus 5', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-8/, name: 'Opus 4.8', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-7/, name: 'Opus 4.7', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-6/, name: 'Opus 4.6', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4-5/, name: 'Opus 4.5', tier: 'opus', base: 5, out: 25 },
  { match: /^claude-opus-4/, name: 'Opus 4', tier: 'opus', base: 15, out: 75 },
  { match: /^claude-sonnet-5/, name: 'Sonnet 5', tier: 'sonnet', base: 2, out: 10 },
  { match: /^claude-sonnet-4-6/, name: 'Sonnet 4.6', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-sonnet-4/, name: 'Sonnet 4', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-3-7-sonnet/, name: 'Sonnet 3.7', tier: 'sonnet', base: 3, out: 15 },
  { match: /^claude-haiku-4-5/, name: 'Haiku 4.5', tier: 'haiku', base: 1, out: 5 },
  { match: /^claude-3-5-haiku/, name: 'Haiku 3.5', tier: 'haiku', base: 0.8, out: 4 },
];

const UNKNOWN = { name: 'unknown', tier: 'unknown', base: 5, out: 25 };

const cache = new Map();

/**
 * Look up rates for a model id. Claude Code appends context/variant suffixes
 * such as "[1m]" - those do not change the per-token rate for current models,
 * so they are stripped before matching.
 */
export function modelInfo(modelId) {
  if (!modelId) return { ...UNKNOWN, id: modelId, known: false };
  if (cache.has(modelId)) return cache.get(modelId);
  const bare = String(modelId).replace(/\[[^\]]*\]$/, '');
  const hit = MODELS.find((m) => m.match.test(bare));
  const info = hit
    ? { id: modelId, name: hit.name, tier: hit.tier, base: hit.base, out: hit.out, cr: hit.cr ?? hit.base * 0.1, known: true }
    : { ...UNKNOWN, id: modelId, cr: UNKNOWN.base * 0.1, known: false };
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
  const i = modelInfo(modelId);
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const w5 = t.cacheWrite5m ?? 0;
  const w1h = t.cacheWrite1h ?? 0;
  const read = t.cacheRead ?? 0;
  return (
    (input * i.base + output * i.out + w5 * i.base * 1.25 + w1h * i.base * 2 + read * i.cr) / M
  );
}

export const KNOWN_MODELS = MODELS.map((m) => m.name);
