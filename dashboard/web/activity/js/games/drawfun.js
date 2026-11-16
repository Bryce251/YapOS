import { plainKey, editDistance, closeEnough } from '../text.js';

export const DRAW_TIMES = Object.freeze([60, 80, 90, 120, 150, 180]);
export const QUICK_TIMES = Object.freeze([15, 20, 25, 30, 45, 60]);

export function secsLabel(secs) {
  const v = Math.max(0, Math.floor(Number(secs) || 0));
  if (v < 120) return `${v} s`;
  const m = Math.floor(v / 60);
  const s = v % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function timeSetting(id, values, def, label = 'Drawing time') {
  return { id, label, type: 'choice', options: values.map((v) => ({ value: v, label: secsLabel(v) })), default: def };
}

export function addPts(api, slot, n, o) {
  const got = api.addPoints(slot, n, o);
  return Number.isFinite(got) ? got : n;
}

export function roundOf(api, n, total) {
  if (api && typeof api.round === 'function') api.round(n, total);
}

export function say(api, kind, data) {
  if (!api || typeof api.say !== 'function') return false;
  try {
    return api.say(kind, data);
  } catch {
    return false;
  }
}

export function frozen(api, slot) {
  return Boolean(api && typeof api.frozen === 'function' && api.frozen(slot));
}

export function thaw(api, slot) {
  if (api && typeof api.thaw === 'function') api.thaw(slot);
}

export function nameOf(api, slot) {
  return api && typeof api.nameOf === 'function' ? api.nameOf(slot) : 'Player';
}

export function heat(guess, word) {
  const g = plainKey(guess).replace(/ /g, '');
  const w = plainKey(word).replace(/ /g, '');
  if (!g || !w) return 'c';
  if (g === w) return 'h';
  if (closeEnough(g, w, { slack: w.length >= 8 ? 3 : 2 })) return 'h';
  const d = editDistance(g, w, Math.max(g.length, w.length));
  const ratio = d / Math.max(g.length, w.length);
  const lead = w.length >= 4 && g.length >= 3 && g.slice(0, 3) === w.slice(0, 3);
  if (ratio <= 0.5 || lead || (w.length >= 5 && (w.includes(g) || g.includes(w)) && g.length >= 3)) return 'w';
  return 'c';
}

export const HEAT = Object.freeze({
  h: Object.freeze({ emoji: '🔥', text: 'Hot!' }),
  w: Object.freeze({ emoji: '♨️', text: 'Warm' }),
  c: Object.freeze({ emoji: '🥶', text: 'Cold' }),
});

export function bump(map, slot, n = 1) {
  const out = { ...(map && typeof map === 'object' ? map : {}) };
  out[slot] = (Number(out[slot]) || 0) + n;
  return out;
}

export function topOf(map, min = 1) {
  let best = null;
  for (const [k, v] of Object.entries(map || {})) {
    const n = Number(v) || 0;
    const slot = Number(k);
    if (!Number.isInteger(slot) || n < min) continue;
    if (!best || n > best.n || (n === best.n && slot < best.slot)) best = { slot, n };
  }
  return best;
}

export function times(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
