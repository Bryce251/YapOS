import { STARTERS, starterById } from '../../data/telephone.js';
import { shuffle } from '../engine.js';
import { pack, seatBudget, seatKey, seatOf, validChunk, readSeat, seatRoom, decodeStroke, SEAT_CHUNKS } from './ink.js';
import { mask, unmask } from './draw.js';
import { cleanShared, plainKey } from '../text.js';
import { timeSetting, addPts, roundOf, say } from './drawfun.js';
import { jsonBytes } from '../limits.js';

export const KEY = 'tel';
export const IN_KEY = 'tel.in';
export const INK_PREFIX = 'tel.d.';
export const ENTRY_PREFIX = 'tel.e.';
export const MIN_SEATS = 3;
export const MAX_SEATS = 10;
export const MAX_STEPS = 8;
export const TEXT_MAX = 80;
export const TEXT_BYTES = 160;
export const GRACE_MS = 1500;
export const SETTLE_MS = 1200;
export const TEXT_SHOW_MS = 7000;
export const DRAW_SHOW_MS = 10000;
export const END_SHOW_MS = 12000;
export const NEXT_MIN_MS = 1500;
export const AWARDS_MS = 12000;
export const REEL_TEXT = 52;
export const DRAW_TIMES_TEL = Object.freeze([50, 70, 80, 90, 120, 150, 180]);
export const LOST_MS = 7000;
export const REACT_POINTS = 10;
export const AWARD_POINTS = 50;
export const MAX_AWARDS = 6;
export const SUGGESTIONS = 3;
export const REACTS = Object.freeze(['😂', '😍', '🤯', '👏', '🔥']);
export const REACT_NAMES = Object.freeze(['Funny', 'Love it', 'Mind blown', 'Nice one', 'On fire']);
export const STEP_PHASES = Object.freeze(['write', 'draw', 'text']);
export const HID_MAX = 40;
export const RECOVER_MS = 6000;
export const RESUME_MIN_MS = 10000;
export const RC_CHUNK_BYTES = 3000;
export const RC_PARTS = 16;
export const GONE_TEXT = '📵 This link left the call';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_VAL = new Map(Array.from(B64).map((c, i) => [c, i]));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function keystream(nonce) {
  let s = ((nonce >>> 0) ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 16) & 255;
  };
}

function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    const left = bytes.length - i;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (left > 1) out += B64[(n >> 6) & 63];
    if (left > 2) out += B64[n & 63];
  }
  return out;
}

function fromB64(text) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64_VAL.get(ch);
    if (v === undefined) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function conceal(text, nonce) {
  const bytes = encoder.encode(String(text ?? ''));
  const next = keystream(nonce);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= next();
  return toB64(bytes);
}

export function uncover(code, nonce) {
  if (typeof code !== 'string' || code.length > 1024) return '';
  const bytes = fromB64(code);
  if (!bytes) return '';
  const next = keystream(nonce);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= next();
  return decoder.decode(bytes);
}

export function fitText(raw) {
  let text = cleanShared(raw, TEXT_MAX);
  for (;;) {
    const chars = Array.from(text);
    while (chars.length && encoder.encode(chars.join('')).length > TEXT_BYTES) chars.pop();
    const next = cleanShared(chars.join('').trim(), TEXT_MAX);
    if (next === text) return next;
    text = next;
  }
}

export function kindOf(step) {
  if (step === 0) return 'write';
  return step % 2 ? 'draw' : 'text';
}

export function stepsFor(n) {
  return Math.max(0, Math.min(MAX_STEPS, n));
}

export function chainAt(seat, step, n) {
  return (((seat - step) % n) + n) % n;
}

export function seatFor(chain, step, n) {
  return (chain + step) % n;
}

export function inkChars(parts) {
  return (Array.isArray(parts) ? parts : []).reduce((a, s) => a + (typeof s === 'string' ? s.length : 0), 0);
}

export function validInk(v, k) {
  return validChunk(v, k);
}

export function inkKey(seat, i = 0) {
  return seatKey(INK_PREFIX, seat, i);
}

export function seatInk(src, seat, k) {
  return readSeat(src, INK_PREFIX, seat, k);
}

export function budgetOf(st) {
  return st && Number.isInteger(st.b) && st.b > 0 ? st.b : seatBudget(st && Array.isArray(st.seats) ? st.seats.length : 1);
}

export function entryKey(i, j = 0) {
  return j ? `${ENTRY_PREFIX}${i}.${j}` : `${ENTRY_PREFIX}${i}`;
}

export function entryInk(state, i) {
  const e = state ? state[entryKey(i)] : null;
  if (!e || !Array.isArray(e.s)) return [];
  const out = e.s.filter((s) => typeof s === 'string');
  const n = Number.isInteger(e.n) ? Math.min(e.n, SEAT_CHUNKS * 2) : 1;
  for (let j = 1; j < n; j += 1) {
    const x = state[entryKey(i, j)];
    if (!x || x.c !== e.c || x.i !== e.i || x.j !== j || !Array.isArray(x.s)) break;
    for (const s of x.s) if (typeof s === 'string') out.push(s);
  }
  return out;
}

function clearSeat(api, seat) {
  for (let i = 0; i < SEAT_CHUNKS; i += 1) if (api.get(inkKey(seat, i)) !== null) api.put(inkKey(seat, i), null);
}

export function drawingId(run, c, i) {
  return `tel.${run}.${c}.${i}`;
}

export function textRef(run, c, i) {
  return `tel.${run}.${c}.${i}.t`;
}

let starterTexts = null;

export function isStarterText(t) {
  if (!starterTexts) starterTexts = new Set(STARTERS.map((s) => s.text));
  return starterTexts.has(t);
}

export function promptRef(st, seat) {
  if (!st || !Array.isArray(st.seats) || st.phase !== 'draw' || !(st.step > 0) || !Number.isInteger(seat) || seat < 0) return null;
  return textRef(st.run, chainAt(seat, st.step, st.seats.length), st.step - 1);
}

function textContext(chain, e, i) {
  if (e.k === 'w') return 'Draw Telephone, opening phrase';
  const src = i >= 2 && chain[i - 2] && chain[i - 2].t ? chain[i - 2].t : null;
  return src ? `Draw Telephone, description of a drawing of “${src}”` : 'Draw Telephone, description of a drawing';
}

function textList(api, st) {
  if (!st || !Array.isArray(st.seats) || !owned(api, st)) return [];
  const mem = api.memory;
  const n = st.seats.length;
  const out = [];
  const add = (c, i, viewers = null) => {
    const chain = mem.chains[c] || [];
    const e = chain[i];
    if (!e || e.k === 'd' || e.miss || typeof e.t !== 'string' || !e.t || isStarterText(e.t)) return;
    const item = { r: textRef(st.run, c, i), author: e.by, text: e.t, context: textContext(chain, e, i) };
    if (viewers) item.viewers = viewers;
    out.push(item);
  };
  if (st.phase === 'draw' && st.step > 0) for (let p = 0; p < n; p += 1) add(chainAt(p, st.step, n), st.step - 1, [st.seats[p]]);
  else if (st.phase === 'reveal' && st.rv) for (let i = 0; i <= st.rv.at; i += 1) add(st.rv.c, i);
  return out;
}

function hiddenSet(st) {
  return new Set(Array.isArray(st && st.hid) ? st.hid : []);
}

function words(text) {
  return new Set(plainKey(text).split(' ').filter((w) => w.length > 2));
}

export function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

function nonce(api) {
  return 1 + Math.floor(api.random() * 65534);
}

function presentSet(api) {
  return new Set(api.players().map((p) => p.slot));
}

function liveSeats(api, st) {
  const here = presentSet(api);
  return st.seats.map((slot, i) => (here.has(slot) ? i : -1)).filter((i) => i >= 0);
}

export function sinceOf(st, seat) {
  const at = st && Array.isArray(st.since) ? st.since[seat] : 0;
  return Number.isInteger(at) && at > 0 ? at : 0;
}

function fillSeats(api, st, step = st.step) {
  const here = presentSet(api);
  let moved = false;
  st.wait = (st.wait || []).filter((s) => here.has(s) || !st.seats.includes(s));
  for (let p = 0; p < st.seats.length; p += 1) {
    if (here.has(st.seats[p])) continue;
    const i = st.wait.findIndex((s) => here.has(s));
    if (i < 0) break;
    st.seats[p] = st.wait[i];
    st.wait.splice(i, 1);
    st.since = st.seats.map((_, q) => (q === p ? step || 0 : sinceOf(st, q)));
    if (Array.isArray(st.done)) st.done = st.done.filter((d) => d !== p);
    moved = true;
  }
  for (const s of here) {
    if (st.seats.includes(s) || st.wait.includes(s)) continue;
    st.wait.push(s);
    moved = true;
  }
  return moved;
}

function freshMemory(api, run, n) {
  const m = api.memory;
  for (const k of Object.keys(m)) delete m[k];
  m.run = run;
  m.chains = Array.from({ length: n }, () => []);
  m.texts = {};
  m.sugs = [];
  m.speed = {};
  m.ink = {};
  m.got = {};
  m.seen = {};
  return m;
}

function clearPrefix(api, prefix) {
  for (const k of api.keys()) if (k.startsWith(prefix)) api.put(k, null);
}

function suggestionsFor(api, n) {
  const deck = shuffle(STARTERS, api.random);
  const out = [];
  for (let p = 0; p < n; p += 1) {
    const pick = [];
    for (let j = 0; j < SUGGESTIONS; j += 1) pick.push(deck[(p * SUGGESTIONS + j) % deck.length].id);
    out.push(pick);
  }
  return out;
}

function openStep(api, st, step) {
  const mem = api.memory;
  const n = st.seats.length;
  const kind = kindOf(step);
  const k = nonce(api);
  fillSeats(api, st, step);
  const secs = kind === 'draw' ? api.settings.draw : api.settings.write;
  const starts = api.now();
  const ends = starts + secs * 1000;
  mem.texts = {};
  const next = { ...st, phase: kind, step, k, dk: kind === 'text' ? st.k : null, dby: null, done: [], pass: 0, sug: null, starts, ends, rv: null, rx: null, aw: null };
  if (kind === 'text') {
    next.dby = st.seats.map((_, q) => {
      const e = (mem.chains[chainAt(q, step - 1, n)] || [])[step - 1];
      return e && e.k === 'd' ? e.by : null;
    });
  }
  if (kind === 'write') {
    mem.sugs = suggestionsFor(api, n);
    next.sug = mem.sugs.map((ids) => ids.map((id) => mask(id, k)));
  }
  if (kind === 'draw') {
    next.b = seatBudget(n);
    clearPrefix(api, INK_PREFIX);
    const t = st.seats.map((_, p) => {
      const chain = mem.chains[chainAt(p, step, n)];
      const last = chain[step - 1];
      return conceal(last ? last.t : '', k);
    });
    api.put(IN_KEY, { k, t });
  } else {
    api.put(IN_KEY, null);
  }
  api.put(KEY, next);
  api.setDeadline(ends + GRACE_MS);
}

function lastText(chain) {
  for (let i = chain.length - 1; i >= 0; i -= 1) if (chain[i].t) return chain[i].t;
  return '';
}

function closeStep(api) {
  const st = api.get(KEY);
  if (!st || !STEP_PHASES.includes(st.phase)) return;
  const mem = api.memory;
  const n = st.seats.length;
  for (let p = 0; p < n; p += 1) {
    const chain = mem.chains[chainAt(p, st.step, n)];
    if (chain.length !== st.step) continue;
    const by = st.seats[p];
    if (st.phase === 'write') {
      const own = mem.texts[p];
      const sug = starterById((mem.sugs[p] || [])[0]);
      chain.push(own ? { k: 'w', by, t: own } : { k: 'w', by, t: sug ? sug.text : STARTERS[0].text, miss: 1 });
    } else if (st.phase === 'draw') {
      const s = seatInk((key) => api.get(key), p, st.k).s;
      if (s.length) mem.ink[by] = (mem.ink[by] || 0) + inkChars(s);
      chain.push(s.length ? { k: 'd', by, s } : { k: 'd', by, s: [], miss: 1 });
    } else {
      const own = mem.texts[p];
      chain.push(own ? { k: 't', by, t: own } : { k: 't', by, t: lastText(chain), miss: 1 });
    }
  }
  if (st.phase === 'text') clearPrefix(api, INK_PREFIX);
  const next = st.step + 1;
  if (next < st.steps) return openStep(api, st, next);
  return startReveal(api, st);
}

function startReveal(api, st) {
  clearPrefix(api, INK_PREFIX);
  api.put(IN_KEY, null);
  const mem = api.memory;
  const chains = mem.chains.filter((c) => c.length);
  if (!chains.length) return api.finish([]);
  mem.order = mem.chains.map((c, i) => (c.length ? i : -1)).filter((i) => i >= 0);
  return showChain(api, { ...st, done: [], pass: 0, sug: null, dk: null }, 0);
}

function putEntry(api, chain, c, i) {
  const e = chain[i];
  const out = { c, i, k: e.k, by: e.by };
  const rest = [];
  if (e.k === 'd') {
    const pieces = pack(Array.isArray(e.s) ? e.s : [], 0).map((ch) => ch.s);
    out.s = pieces[0] || [];
    if (pieces.length > 1) out.n = pieces.length;
    for (let j = 1; j < pieces.length; j += 1) rest.push({ c, i, j, s: pieces[j] });
  } else {
    out.t = e.t;
  }
  if (e.miss) out.miss = 1;
  if (e.hid) out.hid = 1;
  if (e.gone) out.gone = 1;
  for (const k of api.keys()) {
    const m = k.startsWith(`${ENTRY_PREFIX}${i}.`) ? Number(k.slice(`${ENTRY_PREFIX}${i}.`.length)) : 0;
    if (Number.isInteger(m) && m > rest.length) api.put(k, null);
  }
  api.put(entryKey(i), out);
  for (const x of rest) api.put(entryKey(i, x.j), x);
}

function drawingList(api, st) {
  if (!st || !Array.isArray(st.seats) || !owned(api, st)) return [];
  const mem = api.memory;
  const n = st.seats.length;
  const hid = hiddenSet(st);
  const out = [];
  const add = (c, i, viewers = null) => {
    const e = (mem.chains[c] || [])[i];
    if (!e || e.k !== 'd' || e.hid || !Array.isArray(e.s) || !e.s.length) return;
    const d = drawingId(st.run, c, i);
    if (!hid.has(d)) out.push(viewers ? { d, drawer: e.by, c, i, viewers } : { d, drawer: e.by, c, i });
  };
  if (st.phase === 'text' && st.step > 0) for (let q = 0; q < n; q += 1) add(chainAt(q, st.step - 1, n), st.step - 1, [st.seats[(q + 1) % n]]);
  else if (st.phase === 'reveal' && st.rv) for (let i = 0; i <= st.rv.at; i += 1) add(st.rv.c, i);
  return out;
}

function hide(api, d) {
  const st = api.get(KEY);
  const item = drawingList(api, st).find((x) => x.d === d);
  if (!item) return false;
  const mem = api.memory;
  const chain = mem.chains[item.c];
  const e = chain[item.i];
  mem.ink[e.by] = Math.max(0, (mem.ink[e.by] || 0) - inkChars(e.s));
  chain[item.i] = { k: 'd', by: e.by, s: [], hid: 1 };
  const n = st.seats.length;
  if (st.phase === 'text') {
    for (let q = 0; q < n; q += 1) if (chainAt(q, st.step - 1, n) === item.c) clearSeat(api, q);
  }
  if (st.phase === 'reveal' && st.rv && st.rv.c === item.c && item.i <= st.rv.at) putEntry(api, chain, item.c, item.i);
  api.put(KEY, { ...st, hid: [...hiddenSet(st)].concat([d]).slice(-HID_MAX) });
  return true;
}

function showFor(chain, at) {
  if (at >= chain.length - 1) return END_SHOW_MS;
  return chain[at].k === 'd' ? DRAW_SHOW_MS : TEXT_SHOW_MS;
}

function showChain(api, st, pos) {
  const mem = api.memory;
  clearPrefix(api, ENTRY_PREFIX);
  const c = mem.order[pos];
  const chain = mem.chains[c];
  roundOf(api, pos + 1, mem.order.length);
  putEntry(api, chain, c, 0);
  const starts = api.now();
  const ends = starts + showFor(chain, 0);
  api.put(KEY, { ...st, phase: 'reveal', rv: { pos, total: mem.order.length, c, at: 0, len: chain.length, owner: chain[0].by }, rx: [REACTS.map(() => 0)], starts, ends });
  api.setDeadline(ends);
}

function advance(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'reveal' || !st.rv) return;
  const mem = api.memory;
  const chain = mem.chains[st.rv.c];
  const at = st.rv.at + 1;
  if (chain && at < chain.length) {
    putEntry(api, chain, st.rv.c, at);
    const starts = api.now();
    const ends = starts + showFor(chain, at);
    api.put(KEY, { ...st, rv: { ...st.rv, at }, rx: st.rx.concat([REACTS.map(() => 0)]), starts, ends });
    api.setDeadline(ends);
    return;
  }
  if (st.rv.pos + 1 < mem.order.length) {
    showChain(api, st, st.rv.pos + 1);
    return;
  }
  showAwards(api, st);
}

function best(list, score, taken, low = false) {
  const rows = list
    .map((x) => ({ x, v: score(x) }))
    .filter((r) => Number.isFinite(r.v) && (low || r.v > 0))
    .sort((a, b) => (low ? a.v - b.v : b.v - a.v));
  const free = rows.find((r) => !taken.has(r.x.slot));
  return free || null;
}

export function pickAwards(mem, slots) {
  const people = slots.map((slot) => ({ slot, got: mem.got[slot] || {}, speed: mem.speed[slot] || [], ink: mem.ink[slot] || 0 }));
  const taken = new Set();
  const out = [];
  const add = (id, emoji, title, why, row) => {
    if (!row || out.length >= MAX_AWARDS) return;
    taken.add(row.x.slot);
    out.push({ id, e: emoji, title, why, slot: row.x.slot });
  };
  add('fav', '🔥', 'Crowd favorite', 'Got the most reactions', best(people, (p) => p.got.all || 0, taken));
  add('clown', '😂', 'Class clown', 'Got the most laughs', best(people, (p) => p.got.r0 || 0, taken));
  add('art', '🎨', 'Gallery star', 'Most loved drawings', best(people, (p) => p.got.d || 0, taken));
  add('pen', '✍️', 'Wordsmith', 'Most loved writing', best(people, (p) => p.got.w || 0, taken));
  const chains = (mem.chains || []).filter((c) => c.length >= 3 && c[0].t && Number.isInteger(c[0].by) && !c[0].gone);
  const ends = chains.map((c) => ({ slot: c[0].by, score: likeness(c[0].t, lastText(c.slice(1))) }));
  const wild = best(ends, (x) => 1 - x.score, taken);
  if (wild && wild.v > 0) add('wild', '🌀', 'Wildest ride', 'Their chain changed the most', wild);
  const clear = best(ends, (x) => x.score, taken);
  if (clear && clear.v > 0) add('clear', '🎯', 'Crystal clear', 'Their chain stayed closest to the start', clear);
  const fast = best(people.filter((p) => p.speed.length >= 2), (p) => p.speed.reduce((a, b) => a + b, 0) / p.speed.length, taken, true);
  add('fast', '⚡', 'Lightning hands', 'Fastest to finish each step', fast);
  add('ink', '🖍️', 'Busy pencil', 'Drew the most detail', best(people, (p) => p.ink, taken));
  return out;
}

function showAwards(api, st) {
  clearPrefix(api, ENTRY_PREFIX);
  const mem = api.memory;
  const slots = [...new Set((mem.chains || []).flat().map((e) => e.by))].filter((s) => Number.isInteger(s));
  const aw = pickAwards(mem, slots);
  for (const a of aw) addPts(api, a.slot, AWARD_POINTS, { raw: true });
  const starts = api.now();
  const ends = starts + AWARDS_MS;
  api.put(KEY, { ...st, phase: 'awards', rv: null, rx: null, aw, starts, ends });
  api.setDeadline(ends);
}

function lose(api, note) {
  const st = api.get(KEY) || {};
  clearPrefix(api, INK_PREFIX);
  clearPrefix(api, ENTRY_PREFIX);
  api.put(IN_KEY, null);
  const starts = api.now();
  const ends = starts + LOST_MS;
  api.put(KEY, { v: 1, run: st.run || 0, seats: st.seats || [], wait: st.wait || [], steps: st.steps || 0, step: st.step || 0, phase: 'lost', note, done: [], starts, ends });
  api.setDeadline(ends);
}

function allDone(api, st) {
  const live = liveSeats(api, st);
  return live.length > 0 && live.every((p) => st.done.includes(p));
}

function settle(api, st) {
  if (!allDone(api, st)) return false;
  if (st.phase === 'draw') {
    if (st.pass) return true;
    api.put(KEY, { ...st, pass: 1 });
    api.setDeadline(api.now() + SETTLE_MS);
    return true;
  }
  closeStep(api);
  return true;
}

function markDone(api, st, seat) {
  st.done = st.done.concat([seat]);
  const by = st.seats[seat];
  const took = Math.max(0, api.now() - st.starts);
  const mem = api.memory;
  mem.speed[by] = (mem.speed[by] || []).concat([took]);
  if (st.done.length === 1 && st.seats.length >= 3 && took <= (st.ends - st.starts) / 3) say(api, 'fast', { slot: by });
  api.put(KEY, st);
  settle(api, st);
}

function owned(api, st) {
  return Boolean(api.memory && api.memory.run && api.memory.run === st.run && Array.isArray(api.memory.chains));
}

function lengthOf(st, was = st.was) {
  if (was === 'reveal') return st.rv && Number.isInteger(st.rv.len) ? st.rv.len : 0;
  return Number.isInteger(st.step) ? st.step : 0;
}

function recoverable(st) {
  const was = st.phase === 'recover' ? st.was : st.phase;
  if (!Array.isArray(st.seats) || !st.seats.length) return null;
  if (STEP_PHASES.includes(was)) return was;
  if (was === 'reveal' && st.rv && Number.isInteger(st.rv.c) && Number.isInteger(st.rv.at)) return was;
  return null;
}

function beginRecover(api) {
  const st = api.get(KEY);
  const was = st ? recoverable(st) : null;
  if (!was) return lose(api, 'host');
  const now = api.now();
  const again = st.phase === 'recover';
  const left = again ? Math.max(0, st.left || 0) : Math.max(0, (st.ends || now) - now);
  const dur = again ? Math.max(0, st.dur || 0) : Math.max(0, (st.ends || now) - (st.starts || now));
  let rk = nonce(api);
  if (rk === st.rk) rk = (rk % 65534) + 1;
  const m = api.memory;
  for (const k of Object.keys(m)) delete m[k];
  m.rec = { rk, run: st.run, e: {}, d: {}, cur: {}, end: {} };
  const ends = now + RECOVER_MS;
  api.put(KEY, { ...st, phase: 'recover', was, rk, left, dur, pass: 0, starts: now, ends });
  api.setDeadline(ends);
  const done = Array.isArray(st.done) ? st.done : [];
  if (lengthOf(st, was) === 0 && (was === 'draw' || !done.length)) return finishRecover(api);
  return undefined;
}

function recoverIntent(api, st, slot, a) {
  if (st.phase !== 'recover' || a.r !== st.rk || a.run !== st.run) return;
  const rec = api.memory.rec;
  if (!rec || rec.rk !== st.rk) return;
  const n = st.seats.length;
  const seat = st.seats.indexOf(slot);
  if (seat < 0) return;
  if (a.type === 'rcend') {
    rec.end[slot] = 1;
    maybeFinishRecover(api, st);
    return;
  }
  const { c, i } = a;
  if (!Number.isInteger(c) || !Number.isInteger(i) || c < 0 || c >= n || i < 0 || i >= st.steps) return;
  if (seatFor(c, i, n) !== seat || i < sinceOf(st, seat)) return;
  const upto = lengthOf(st);
  const kind = kindOf(i);
  const key = `${c}.${i}`;
  const current = i === upto && st.was !== 'reveal' && st.was !== 'draw' && Array.isArray(st.done) && st.done.includes(seat);
  if (i >= upto && !current) return;
  if (kind !== 'draw') {
    if (typeof a.t !== 'string' || a.t.length > TEXT_MAX * 4) return;
    const t = fitText(a.t);
    if (!t || t !== a.t) return;
    if (current) {
      if (rec.cur[seat] === undefined) rec.cur[seat] = t;
      return;
    }
    if (rec.e[key]) return;
    rec.e[key] = { k: kind === 'write' ? 'w' : 't', by: slot, t };
    return;
  }
  const { j, s } = a;
  const parts = a.n;
  if (!Number.isInteger(parts) || parts < 1 || parts > RC_PARTS || !Number.isInteger(j) || j < 0 || j >= parts) return;
  if (!Array.isArray(s) || !s.length || s.length > 400) return;
  if (!s.every((x) => typeof x === 'string' && x.length <= 4096)) return;
  const bytes = jsonBytes(s);
  if (bytes > RC_CHUNK_BYTES) return;
  if (!s.every((x) => decodeStroke(x) !== null)) return;
  let d = rec.d[key];
  if (!d) d = rec.d[key] = { by: slot, n: parts, got: Array.from({ length: parts }, () => null), bytes: 0 };
  if (d.by !== slot || d.n !== parts || d.got[j] || d.bytes + bytes > budgetOf(st)) return;
  d.got[j] = s.slice();
  d.bytes += bytes;
}

function maybeFinishRecover(api, st) {
  const rec = api.memory.rec;
  if (!rec || rec.rk !== st.rk) return;
  const live = liveSeats(api, st).map((p) => st.seats[p]);
  if (live.every((slot) => rec.end[slot])) finishRecover(api);
}

function sharedEntries(api) {
  const out = {};
  for (const k of api.keys()) if (k.startsWith(ENTRY_PREFIX)) out[k] = api.get(k);
  return out;
}

function placeholder(st, mem, chain, c, i, author, here) {
  const kind = kindOf(i);
  const e = kind === 'draw' ? { k: 'd', by: author, s: [] } : { k: kind === 'write' ? 'w' : 't', by: author, t: '' };
  if (kind === 'write') {
    const p = seatFor(c, i, st.seats.length);
    const sug = starterById((mem.sugs[p] || [])[0]);
    e.t = sug ? sug.text : STARTERS[c % STARTERS.length].text;
  } else if (kind === 'text') {
    e.t = lastText(chain) || STARTERS[c % STARTERS.length].text;
  }
  e.miss = 1;
  if (!Number.isInteger(author) || !here.has(author)) e.gone = 1;
  return e;
}

function rebuild(api, st, rec, mem) {
  const n = st.seats.length;
  const was = st.was;
  const upto = lengthOf(st);
  const here = presentSet(api);
  const hid = hiddenSet(st);
  const inp = was === 'draw' ? api.get(IN_KEY) : null;
  const prompts = inp && inp.k === st.k && Array.isArray(inp.t) ? inp.t : null;
  const shown = was === 'reveal' ? sharedEntries(api) : null;
  const get = (key) => api.get(key);
  const chains = [];
  let real = 0;
  for (let c = 0; c < n; c += 1) {
    const chain = [];
    for (let i = 0; i < upto; i += 1) {
      const p = seatFor(c, i, n);
      const kind = kindOf(i);
      const author = i >= sinceOf(st, p) ? st.seats[p] : null;
      const key = `${c}.${i}`;
      let e = null;
      if (shown && c === st.rv.c && i <= st.rv.at) {
        const x = shown[entryKey(i)];
        if (x && x.c === c && x.i === i && (x.k === 'd' || typeof x.t === 'string')) {
          e = x.k === 'd' ? { k: 'd', by: x.by, s: entryInk(shown, i) } : { k: x.k, by: x.by, t: x.t };
          if (x.miss) e.miss = 1;
          if (x.hid) e.hid = 1;
          if (x.gone) e.gone = 1;
        }
      }
      if (!e && was === 'text' && i === st.step - 1 && st.dk && Array.isArray(st.dby) && Number.isInteger(st.dby[p])) {
        const s = seatInk(get, p, st.dk).s;
        e = s.length ? { k: 'd', by: st.dby[p], s } : { k: 'd', by: st.dby[p], s: [], miss: 1 };
      }
      if (!e && kind !== 'draw' && rec.e[key]) e = { ...rec.e[key] };
      if (!e && prompts && i === st.step - 1) {
        const t = uncover(prompts[seatFor(c, st.step, n)], st.k);
        if (t) e = { k: kind === 'write' ? 'w' : 't', by: author, t };
      }
      if (!e && kind === 'draw' && rec.d[key] && rec.d[key].got.every(Boolean)) e = { k: 'd', by: rec.d[key].by, s: rec.d[key].got.flat() };
      if (e && !e.gone && !e.miss) real += 1;
      if (!e) e = placeholder(st, mem, chain, c, i, author, here);
      if (e.k === 'd' && !e.hid && hid.has(drawingId(st.run, c, i))) e = { k: 'd', by: e.by, s: [], hid: 1 };
      chain.push(e);
    }
    chains.push(chain);
  }
  return { chains, real, upto };
}

function finishRecover(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'recover' || !recoverable(st)) return undefined;
  const held = api.memory.rec;
  const rec = held && held.rk === st.rk ? held : { e: {}, d: {}, cur: {}, end: {} };
  const n = st.seats.length;
  const mem = freshMemory(api, st.run, n);
  if (st.was === 'write' && Array.isArray(st.sug)) mem.sugs = st.sug.map((codes) => (Array.isArray(codes) ? codes.map((code) => unmask(code, st.k)) : []));
  const { chains, real, upto } = rebuild(api, st, rec, mem);
  if (upto > 0 && real === 0) {
    for (const k of Object.keys(mem)) delete mem[k];
    return lose(api, 'host');
  }
  mem.chains = chains;
  for (const e of chains.flat()) if (e.k === 'd' && Number.isInteger(e.by) && Array.isArray(e.s) && e.s.length) mem.ink[e.by] = (mem.ink[e.by] || 0) + inkChars(e.s);
  const base = { ...st, phase: st.was, pass: 0 };
  for (const k of ['was', 'rk', 'left', 'dur']) delete base[k];
  const now = api.now();
  if (st.was === 'reveal') {
    mem.order = chains.map((c, i) => (c.length ? i : -1)).filter((i) => i >= 0);
    const chain = chains[st.rv.c];
    if (!chain || !chain.length || mem.order[st.rv.pos] !== st.rv.c) return lose(api, 'host');
    const at = Math.min(st.rv.at, chain.length - 1);
    const ends = now + showFor(chain, at);
    api.put(KEY, { ...base, rv: { ...st.rv, at }, starts: now, ends });
    api.setDeadline(ends);
    return undefined;
  }
  if (st.was !== 'draw') for (const [seat, t] of Object.entries(rec.cur)) mem.texts[Number(seat)] = t;
  const done = (Array.isArray(st.done) ? st.done : []).filter((p) => st.was === 'draw' || mem.texts[p] !== undefined);
  const remaining = Math.max(RESUME_MIN_MS, st.left || 0);
  const ends = now + remaining;
  const next = { ...base, done, starts: ends - Math.max(st.dur || 0, remaining), ends };
  fillSeats(api, next);
  api.put(KEY, next);
  api.setDeadline(ends + GRACE_MS);
  if (liveSeats(api, next).length < 2) {
    if (next.step >= 2) return startReveal(api, next);
    return lose(api, 'few');
  }
  settle(api, next);
  return undefined;
}

function seenDrawing(snap, st) {
  const hid = hiddenSet(st);
  if (st.phase === 'text' && st.step > 0) {
    const n = st.seats.length;
    const seat = st.seats.indexOf(snap.meSlot);
    if (seat < 0 || n < 2) return null;
    const q = (seat - 1 + n) % n;
    const by = Array.isArray(st.dby) ? st.dby[q] : null;
    const ink = seatInk(snap.state, q, st.dk).s;
    if (!Number.isInteger(by) || !ink.length) return null;
    const d = drawingId(st.run, chainAt(q, st.step - 1, n), st.step - 1);
    return hid.has(d) ? null : { d, drawer: by, ink, word: null, viewers: [st.seats[seat]] };
  }
  if (st.phase === 'reveal' && st.rv) {
    for (let i = st.rv.at; i >= 0; i -= 1) {
      const e = snap.state[entryKey(i)];
      if (!e || e.c !== st.rv.c || e.i !== i || e.k !== 'd') continue;
      if (e.hid || !Array.isArray(e.s) || !e.s.length || !Number.isInteger(e.by)) return null;
      const d = drawingId(st.run, e.c, i);
      if (hid.has(d)) return null;
      const before = snap.state[entryKey(i - 1)];
      const word = before && before.c === e.c && before.i === i - 1 && typeof before.t === 'string' ? before.t : null;
      return { d, drawer: e.by, ink: entryInk(snap.state, i), word };
    }
  }
  return null;
}

function face(snap, slot) {
  const p = snap.players.find((x) => x.slot === slot);
  if (!p) return { slot, id: null, name: 'Player', initials: 'P', hue: 20, avatar: null, isMe: false, present: false };
  return { slot, id: p.id, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: Boolean(p.isMe), present: Boolean(p.present) };
}

function react(api, st, slot, action) {
  if (st.phase !== 'reveal' || !st.rv || !owned(api, st)) return;
  const { c, i, e } = action;
  if (c !== st.rv.c || !Number.isInteger(i) || i < 0 || i > st.rv.at || !Number.isInteger(e) || e < 0 || e >= REACTS.length) return;
  const entry = api.memory.chains[c][i];
  if (!entry || entry.gone || !Number.isInteger(entry.by) || entry.by === slot) return;
  const mark = `${c}.${i}.${slot}.${e}`;
  if (api.memory.seen[mark]) return;
  api.memory.seen[mark] = 1;
  const rx = st.rx.map((r) => r.slice());
  rx[i][e] += 1;
  const g = (api.memory.got[entry.by] = api.memory.got[entry.by] || {});
  g.all = (g.all || 0) + 1;
  g[`r${e}`] = (g[`r${e}`] || 0) + 1;
  if (entry.k === 'd') g.d = (g.d || 0) + 1;
  else g.w = (g.w || 0) + 1;
  api.put(KEY, { ...st, rx });
  addPts(api, entry.by, REACT_POINTS);
}

function clip(text, max) {
  const chars = Array.from(String(text || ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trim()}…` : chars.join('');
}

export function telephoneHighlights(mem) {
  const chains = Array.isArray(mem && mem.chains) ? mem.chains : [];
  const rows = [];
  for (const c of chains) {
    if (!Array.isArray(c) || c.length < 3 || !c[0] || c[0].miss || typeof c[0].t !== 'string' || !c[0].t) continue;
    let end = null;
    for (let i = c.length - 1; i >= 1; i -= 1) {
      if (c[i] && c[i].k === 't' && !c[i].miss && typeof c[i].t === 'string' && c[i].t) {
        end = c[i];
        break;
      }
    }
    if (!end || end.t === c[0].t) continue;
    rows.push({ who: c[0].by, text: `"${clip(c[0].t, REEL_TEXT)}" turned into "${clip(end.t, REEL_TEXT)}"`, score: likeness(c[0].t, end.t) });
  }
  return rows
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map(({ who, text }) => ({ who, text }));
}

export function telephoneAwards(st) {
  const list = st && Array.isArray(st.aw) ? st.aw : [];
  return list
    .filter((a) => a && Number.isInteger(a.slot) && typeof a.title === 'string')
    .map((a) => ({ emoji: a.e || '🏅', title: a.title, who: a.slot, why: typeof a.why === 'string' ? a.why : '' }));
}

export function rcChunks(parts) {
  const out = [];
  let cur = [];
  for (const s of Array.isArray(parts) ? parts : []) {
    if (typeof s !== 'string') continue;
    if (cur.length && jsonBytes(cur.concat([s])) > RC_CHUNK_BYTES) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out.filter((c) => jsonBytes(c) <= RC_CHUNK_BYTES).slice(0, RC_PARTS);
}

function inkSigOf(state, seat, k) {
  let sig = `${k}`;
  for (let i = 0; i < SEAT_CHUNKS; i += 1) {
    const v = state ? state[inkKey(seat, i)] : null;
    if (!v || !Array.isArray(v.s)) break;
    sig += `|${v.k}.${v.g}.${v.s.length}.${v.s.reduce((a, s) => a + (typeof s === 'string' ? s.length : 0), 0)}`;
  }
  return sig;
}

export function createKeeper() {
  let run = null;
  let handled = null;
  const texts = new Map();
  const inks = new Map();
  const sigs = new Map();
  const cap = MAX_STEPS + 2;

  function reset(r) {
    run = r;
    handled = null;
    texts.clear();
    inks.clear();
    sigs.clear();
  }

  function where(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!st || !Array.isArray(st.seats) || !st.seats.length) return null;
    if (st.run !== run) reset(st.run);
    const me = snap.meSlot;
    const seat = me === null || me === undefined ? -1 : st.seats.indexOf(me);
    return { st, me, seat, n: st.seats.length };
  }

  function keepText(c, i, t) {
    const key = `${c}.${i}`;
    if (!t || (!texts.has(key) && texts.size >= cap)) return;
    texts.set(key, { c, i, t });
  }

  function keepInk(state, seat, c, i, k) {
    const key = `${c}.${i}`;
    const sig = inkSigOf(state, seat, k);
    if (sigs.get(key) === sig) return;
    sigs.set(key, sig);
    const s = seatInk(state, seat, k).s;
    if (!s.length || (!inks.has(key) && inks.size >= cap)) return;
    inks.set(key, { c, i, s });
  }

  function note(snap, action) {
    const at = where(snap);
    if (!at || at.seat < 0 || !action) return;
    const { st, seat, n } = at;
    if ((st.phase !== 'write' && st.phase !== 'text') || action.step !== st.step) return;
    let t = null;
    if (action.type === 'text') t = fitText(action.text);
    else if (action.type === 'pick' && st.phase === 'write' && Array.isArray(st.sug) && Array.isArray(st.sug[seat]) && Number.isInteger(action.i)) {
      const s = starterById(unmask(st.sug[seat][action.i], st.k));
      t = s ? s.text : null;
    }
    if (t) keepText(chainAt(seat, st.step, n), st.step, t);
  }

  function observe(snap) {
    const at = where(snap);
    if (!at || at.seat < 0) return;
    const { st, me, seat, n } = at;
    const state = snap.state;
    if (st.phase === 'draw' && Number.isInteger(st.step) && st.step > 0) {
      const prev = st.step - 1;
      const c = chainAt(seat, prev, n);
      const inp = state[IN_KEY];
      if (!texts.has(`${c}.${prev}`) && prev >= sinceOf(st, seat) && inp && inp.k === st.k && Array.isArray(inp.t)) keepText(c, prev, uncover(inp.t[seatFor(c, st.step, n)], st.k));
      keepInk(state, seat, chainAt(seat, st.step, n), st.step, st.k);
    }
    if (st.phase === 'text' && Number.isInteger(st.step) && st.step > 0 && st.dk && Array.isArray(st.dby) && st.dby[seat] === me) {
      keepInk(state, seat, chainAt(seat, st.step - 1, n), st.step - 1, st.dk);
    }
  }

  function resend(snap, engine) {
    const at = where(snap);
    if (!at || at.st.phase !== 'recover' || !at.st.rk) return 0;
    const { st, seat } = at;
    const mark = `${st.run}.${st.rk}`;
    if (handled === mark) return 0;
    handled = mark;
    if (seat < 0 || !engine || typeof engine.act !== 'function') return 0;
    const base = { run: st.run, r: st.rk };
    const list = [];
    for (const x of texts.values()) list.push({ type: 'rc', ...base, c: x.c, i: x.i, t: x.t });
    for (const x of inks.values()) {
      const pieces = rcChunks(x.s);
      pieces.forEach((s, j) => list.push({ type: 'rc', ...base, c: x.c, i: x.i, j, n: pieces.length, s }));
    }
    let sent = 0;
    for (const a of list) if (engine.act(a) !== false) sent += 1;
    engine.act({ type: 'rcend', ...base });
    return sent;
  }

  return {
    note,
    observe,
    resend,
    act(engine, snap, action) {
      note(snap, action);
      return engine.act(action);
    },
    get size() {
      return texts.size + inks.size;
    },
  };
}

const telephone = {
  id: 'telephone',
  name: 'Draw Telephone',
  emoji: '☎️',
  category: 'drawing',
  blurb: 'Write a silly phrase, draw what you get, describe what you see. Watch every chain go wonderfully wrong.',
  minPlayers: MIN_SEATS,
  maxPlayers: MAX_SEATS,
  keys: [KEY, IN_KEY],
  prefixes: [INK_PREFIX, ENTRY_PREFIX],
  open: [INK_PREFIX],
  settings: [
    { id: 'write', label: 'Time to write', type: 'choice', options: [20, 30, 40, 60].map((v) => ({ value: v, label: `${v} s` })), default: 30 },
    timeSetting('draw', DRAW_TIMES_TEL, 80),
  ],

  cards: ['swap', 'double'],

  awards(api) {
    return telephoneAwards(api.get(KEY));
  },

  highlights(api) {
    const st = api.get(KEY);
    return st && owned(api, st) ? telephoneHighlights(api.memory) : [];
  },

  writer(get, key, slot, value) {
    if (!key.startsWith(INK_PREFIX)) return false;
    const st = get(KEY);
    if (!st || st.phase !== 'draw' || !Array.isArray(st.seats)) return false;
    const at = seatOf(INK_PREFIX, key);
    if (!at || st.seats[at.seat] !== slot) return false;
    return seatRoom(get, INK_PREFIX, at.seat, at.i, value, st.k, budgetOf(st));
  },

  start(api) {
    const all = api.players().map((p) => p.slot);
    const seats = all.slice(0, MAX_SEATS);
    const run = 1 + Math.floor(api.random() * 1e9);
    freshMemory(api, run, seats.length);
    const st = { v: 1, run, seats, wait: all.slice(MAX_SEATS), steps: stepsFor(seats.length), step: 0, phase: 'write', done: [], note: null };
    openStep(api, st, 0);
  },

  intent(api, slot, action) {
    const st = api.get(KEY);
    if (!st || !action || typeof action.type !== 'string') return;
    if (action.type === 'react') return react(api, st, slot, action);
    if (action.type === 'rc' || action.type === 'rcend') return recoverIntent(api, st, slot, action);
    if (action.type === 'next') {
      if (st.phase !== 'reveal' || !st.rv || action.c !== st.rv.c || action.at !== st.rv.at) return;
      const here = presentSet(api);
      if (slot !== st.rv.owner && here.has(st.rv.owner)) return;
      if (api.now() - st.starts < NEXT_MIN_MS) return;
      advance(api);
      return;
    }
    if (!STEP_PHASES.includes(st.phase) || action.step !== st.step) return;
    if (!owned(api, st)) return;
    const seat = st.seats.indexOf(slot);
    if (seat < 0) return;
    if (action.type === 'edit') {
      if (st.phase !== 'draw' || st.pass || !st.done.includes(seat)) return;
      api.put(KEY, { ...st, done: st.done.filter((d) => d !== seat) });
      return;
    }
    if (st.done.includes(seat)) return;
    if (action.type === 'done' && st.phase === 'draw') return markDone(api, st, seat);
    if (action.type === 'pick' && st.phase === 'write') {
      const ids = api.memory.sugs[seat] || [];
      const s = Number.isInteger(action.i) ? starterById(ids[action.i]) : null;
      if (!s) return;
      api.memory.texts[seat] = s.text;
      return markDone(api, st, seat);
    }
    if (action.type === 'text' && (st.phase === 'write' || st.phase === 'text')) {
      const text = fitText(action.text);
      if (!text) return;
      api.memory.texts[seat] = text;
      return markDone(api, st, seat);
    }
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish([]);
    if (st.phase === 'recover') return finishRecover(api);
    if (STEP_PHASES.includes(st.phase)) {
      if (!owned(api, st)) return beginRecover(api);
      return closeStep(api);
    }
    if (st.phase === 'reveal') {
      if (!owned(api, st)) return beginRecover(api);
      return advance(api);
    }
    if (st.phase === 'lost') return api.finish([]);
    return api.finish();
  },

  drawings(api) {
    return drawingList(api, api.get(KEY)).map((x) => (x.viewers ? { d: x.d, drawer: x.drawer, viewers: x.viewers } : { d: x.d, drawer: x.drawer }));
  },

  texts(api) {
    return textList(api, api.get(KEY));
  },

  replays: true,

  hiddenDrawings(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!st) return [];
    const out = [...hiddenSet(st)].filter((d) => typeof d === 'string');
    if (st.phase === 'reveal' && st.rv) {
      for (let i = 0; i <= st.rv.at; i += 1) {
        const e = snap.state[entryKey(i)];
        if (e && e.c === st.rv.c && e.i === i && e.k === 'd' && e.hid) out.push(drawingId(st.run, e.c, i));
      }
    }
    return out;
  },

  drawingOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!st || !Array.isArray(st.seats)) return null;
    return seenDrawing(snap, st);
  },

  admin(api, action) {
    if (action.type === 'hideDrawing') return hide(api, action.d);
    const st = api.get(KEY);
    if (!st) return false;
    if (action.type === 'skip') {
      telephone.deadline(api);
      return true;
    }
    if (action.type === 'time') {
      if (st.phase === 'recover') return false;
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends, pass: 0 });
      api.setDeadline(STEP_PHASES.includes(st.phase) ? ends + GRACE_MS : ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return telephone.start(api);
    if (st.phase === 'lost' || st.phase === 'awards') {
      if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
      return undefined;
    }
    if (st.phase === 'recover' || !owned(api, st)) return beginRecover(api);
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st || !Number.isInteger(slot) || st.seats.includes(slot) || (st.wait || []).includes(slot)) return;
    st.wait = (st.wait || []).concat([slot]);
    if (STEP_PHASES.includes(st.phase)) fillSeats(api, st);
    api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (st && st.phase === 'recover') return maybeFinishRecover(api, st);
    if (!st || !STEP_PHASES.includes(st.phase)) return;
    if (!owned(api, st)) return beginRecover(api);
    const moved = fillSeats(api, st);
    if (liveSeats(api, st).length < 2) {
      if (st.step >= 2) return startReveal(api, st);
      return lose(api, 'few');
    }
    if (moved) api.put(KEY, st);
    settle(api, st);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !Array.isArray(st.seats)) return null;
    const mine = snap.meSlot;
    const n = st.seats.length;
    const seat = mine === null || mine === undefined ? -1 : st.seats.indexOf(mine);
    const here = new Set(snap.players.filter((p) => p.present && p.joined).map((p) => p.slot));
    const done = Array.isArray(st.done) ? st.done : [];
    const stepping = STEP_PHASES.includes(st.phase);
    const out = {
      phase: st.phase,
      run: st.run,
      step: st.step,
      steps: st.steps,
      kinds: Array.from({ length: st.steps || 0 }, (_, i) => kindOf(i)),
      starts: st.starts,
      ends: st.ends,
      k: st.k || null,
      seat,
      playing: seat >= 0,
      waiting: seat < 0 && mine !== null && mine !== undefined && (st.wait || []).includes(mine),
      note: st.note || null,
      was: st.phase === 'recover' && typeof st.was === 'string' ? st.was : null,
      pass: Boolean(st.pass),
      mineDone: seat >= 0 && done.includes(seat),
      doneCount: done.filter((p) => here.has(st.seats[p])).length,
      needCount: st.seats.filter((s) => here.has(s)).length,
      working: stepping ? st.seats.map((s, p) => (here.has(s) && !done.includes(p) ? face(snap, s) : null)).filter(Boolean) : [],
      from: null,
      to: null,
      sugs: [],
      prompt: null,
      src: null,
      inkKey: null,
      budget: 0,
      reveal: null,
      awards: [],
    };
    if (stepping && seat >= 0 && n > 1) {
      if (st.step > 0) out.from = face(snap, st.seats[(seat - 1 + n) % n]);
      if (st.step + 1 < st.steps) out.to = face(snap, st.seats[(seat + 1) % n]);
      if (st.phase === 'write' && Array.isArray(st.sug) && Array.isArray(st.sug[seat])) {
        out.sugs = st.sug[seat].map((code, i) => {
          const s = starterById(unmask(code, st.k));
          return s ? { i, text: s.text } : null;
        }).filter(Boolean);
      }
      if (st.phase === 'draw') {
        const inp = snap.state[IN_KEY];
        out.prompt = inp && inp.k === st.k && Array.isArray(inp.t) ? uncover(inp.t[seat], st.k) || null : null;
        out.inkKey = inkKey(seat);
        out.budget = budgetOf(st);
      }
      if (st.phase === 'text') {
        const q = (seat - 1 + n) % n;
        const hidden = st.step > 0 && hiddenSet(st).has(drawingId(st.run, chainAt(q, st.step - 1, n), st.step - 1));
        const ink = hidden ? [] : seatInk(snap.state, q, st.dk).s;
        out.src = { key: inkKey(q), seat: q, k: st.dk, ink, blank: hidden || !ink.length, hidden };
      }
    }
    if (st.phase === 'reveal' && st.rv) {
      const rv = st.rv;
      const entries = [];
      for (let i = 0; i <= rv.at; i += 1) {
        const e = snap.state[entryKey(i)];
        if (!e || e.c !== rv.c || e.i !== i) continue;
        const by = face(snap, e.by);
        entries.push({
          i,
          k: e.k,
          by,
          t: e.k === 'd' ? null : e.gone ? GONE_TEXT : typeof e.t === 'string' ? e.t : '',
          strokes: e.k === 'd' && Array.isArray(e.s) ? e.s.length : 0,
          miss: Boolean(e.miss) && !e.gone,
          gone: Boolean(e.gone),
          hidden: Boolean(e.hid),
          rx: (st.rx && st.rx[i]) || REACTS.map(() => 0),
          mine: by.isMe,
        });
      }
      const owner = face(snap, rv.owner);
      const now = local.now ?? snap.now;
      out.reveal = {
        c: rv.c,
        pos: rv.pos,
        total: rv.total,
        at: rv.at,
        len: rv.len,
        last: rv.at >= rv.len - 1,
        finale: rv.at >= rv.len - 1 && rv.pos + 1 >= rv.total,
        owner,
        entries,
        canNext: mine !== null && mine !== undefined && (owner.isMe || !here.has(rv.owner)) && here.has(mine),
        early: now - st.starts < NEXT_MIN_MS,
        canReact: mine !== null && mine !== undefined && here.has(mine),
      };
    }
    if (st.phase === 'awards' && Array.isArray(st.aw)) out.awards = st.aw.map((a) => ({ id: a.id, e: a.e, title: a.title, why: a.why, who: face(snap, a.slot) }));
    return out;
  },
};

export default telephone;
