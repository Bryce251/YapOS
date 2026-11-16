import { cleanShared, hidesWords } from '../text.js';

export const HL_KEEP = 8;

export function award(api, slot, n, o) {
  const s = Number(slot);
  if (!Number.isInteger(s) || !Number.isFinite(n) || n === 0) return 0;
  const got = api.addPoints(s, n, o);
  return Number.isFinite(got) ? got : Math.round(n);
}

export function roundAt(api, n, total) {
  if (typeof api.round === 'function') api.round(n, total);
}

export function say(api, kind, data) {
  return typeof api.say === 'function' ? api.say(kind, data) : false;
}

export function isFrozen(api, slot) {
  return typeof api.frozen === 'function' && Boolean(api.frozen(slot));
}

export function thaw(api, slot) {
  return typeof api.thaw === 'function' ? api.thaw(slot) : false;
}

export function nameOf(api, slot) {
  return typeof api.nameOf === 'function' ? api.nameOf(slot) : 'Player';
}

export function funMem(api) {
  const m = api.memory;
  if (!m.fx || typeof m.fx !== 'object') m.fx = { run: {}, best: {}, n: {}, hl: [], seen: 0 };
  return m.fx;
}

export function streak(api, slot, hit) {
  const fx = funMem(api);
  if (!hit) {
    fx.run[slot] = 0;
    return 0;
  }
  const n = (fx.run[slot] || 0) + 1;
  fx.run[slot] = n;
  fx.best[slot] = Math.max(fx.best[slot] || 0, n);
  say(api, 'streak', { slot, n });
  return n;
}

export function missRest(api, hits) {
  const fx = funMem(api);
  const got = new Set(hits);
  for (const k of Object.keys(fx.run)) if (!got.has(Number(k))) fx.run[k] = 0;
}

export function bump(api, name, slot, by = 1) {
  if (!Number.isInteger(slot) || !by) return;
  const fx = funMem(api);
  const t = fx.n[name] || (fx.n[name] = {});
  t[slot] = (t[slot] || 0) + by;
}

export function most(api, name, min = 1) {
  const t = funMem(api).n[name] || {};
  let top = 0;
  let slots = [];
  for (const [k, v] of Object.entries(t)) {
    const s = Number(k);
    if (!Number.isInteger(s) || !(v >= min)) continue;
    if (v > top) {
      top = v;
      slots = [s];
    } else if (v === top) slots.push(s);
  }
  return slots.length ? { slots: slots.sort((a, b) => a - b), n: top } : null;
}

export function prize(api, name, title, emoji, why, min = 1) {
  const m = most(api, name, min);
  if (!m) return null;
  return { title, emoji, who: m.slots, why: typeof why === 'function' ? why(m.n) : why };
}

export function bestStreak(api, min = 3) {
  const fx = funMem(api);
  let top = 0;
  let who = [];
  for (const [k, v] of Object.entries(fx.best)) {
    const s = Number(k);
    if (!Number.isInteger(s) || v < min) continue;
    if (v > top) {
      top = v;
      who = [s];
    } else if (v === top) who.push(s);
  }
  return who.length ? { slots: who.sort((a, b) => a - b), n: top } : null;
}

export function keep(api, text, who, weight = 0) {
  if (typeof text !== 'string' || !Number.isInteger(who)) return false;
  if (hidesWords(text)) return false;
  const clean = cleanShared(text, 120);
  if (!clean) return false;
  const fx = funMem(api);
  fx.seen += 1;
  fx.hl.push({ text: clean, who, w: Number(weight) || 0, at: fx.seen });
  fx.hl.sort((a, b) => b.w - a.w || a.at - b.at);
  if (fx.hl.length > HL_KEEP) fx.hl.length = HL_KEEP;
  return true;
}

export function reel(api, max = 5) {
  const fx = funMem(api);
  return fx.hl
    .slice(0, max)
    .sort((a, b) => a.at - b.at)
    .map((x) => ({ text: x.text, who: x.who }));
}

export function list(...items) {
  return items.filter(Boolean);
}
