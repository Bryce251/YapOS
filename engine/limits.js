export const UNLIMITED = Infinity;
export const HARD_CAP = 1_000_000_000_000_000;

const INF_WORDS = new Set(['inf', 'infinite', 'infinity', 'unlimited', 'nolimit', 'nocap', 'none', 'any', 'anyamount', 'forever', '∞']);
const SUFFIX = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

const clean = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');

export function isUnlimited(value) {
  if (value === Infinity) return true;
  if (typeof value === 'number') return false;
  if (value === null || value === undefined) return false;
  return INF_WORDS.has(clean(value));
}

export function parseLimit(text, { min = 0, max = HARD_CAP, unlimited = true } = {}) {
  if (unlimited && isUnlimited(text)) return UNLIMITED;
  if (typeof text === 'number' && !Number.isFinite(text)) return null;
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '').replace(/\s*(?:coins?|shards?|💎|🪙)$/, '').replace(/\s+/g, '');
  const m = /^(\d+(?:\.\d+)?)([kmbt]?)$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * SUFFIX[m[2]];
  if (!Number.isFinite(v) || Math.abs(v - Math.round(v)) > 1e-6) return null;
  const n = Math.round(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

export function readLimit(value, fallback, opts = {}) {
  const n = parseLimit(value, opts);
  return n === null ? fallback : n;
}

export function storeLimit(value) {
  return isUnlimited(value) ? 'inf' : value;
}

export const fmtNumber = (n) => Number(n).toLocaleString('en-US');

export function limitText(value, { word = 'any amount', fmt = fmtNumber } = {}) {
  return isUnlimited(value) ? word : fmt(value);
}

export function atMost(value, cap) {
  return isUnlimited(cap) ? value : Math.min(value, cap);
}

export function withinLimit(value, cap) {
  return isUnlimited(cap) || value <= cap;
}

export function limitHelp(label, { min = 0, example = '500', word = 'inf' } = {}) {
  return `Use a whole number from ${fmtNumber(min)} up, like \`${example}\`, or \`${word}\` for ${label}.`;
}
