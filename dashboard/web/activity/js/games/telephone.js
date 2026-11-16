import { STARTERS, starterById } from '../../data/telephone.js';
import { shuffle } from '../engine.js';
import { jsonBytes } from '../limits.js';
import { decodeStroke } from './ink.js';
import { mask, unmask } from './draw.js';
import { cleanShared, plainKey } from '../text.js';

export const KEY = 'tel';
export const IN_KEY = 'tel.in';
export const INK_PREFIX = 'tel.d.';
export const ENTRY_PREFIX = 'tel.e.';
export const MIN_SEATS = 3;
export const MAX_SEATS = 10;
export const MAX_STEPS = 8;
export const TEXT_MAX = 80;
export const TEXT_BYTES = 160;
export const INK_CHARS = 3000;
export const INK_PARTS = 160;
export const INK_BYTES = 3700;
export const GRACE_MS = 1500;
export const SETTLE_MS = 1200;
export const TEXT_SHOW_MS = 9000;
export const DRAW_SHOW_MS = 12000;
export const END_SHOW_MS = 14000;
export const NEXT_MIN_MS = 1500;
export const AWARDS_MS = 15000;
export const LOST_MS = 7000;
export const REACT_POINTS = 10;
export const AWARD_POINTS = 50;
export const MAX_AWARDS = 6;
export const SUGGESTIONS = 3;
export const REACTS = Object.freeze(['😂', '😍', '🤯', '👏', '🔥']);
export const REACT_NAMES = Object.freeze(['Funny', 'Love it', 'Mind blown', 'Nice one', 'On fire']);
export const STEP_PHASES = Object.freeze(['write', 'draw', 'text']);
export const HID_MAX = 40;

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
  if (!v || typeof v !== 'object' || v.k !== k || !Array.isArray(v.s)) return false;
  if (v.s.length > INK_PARTS || inkChars(v.s) > INK_CHARS) return false;
  if (jsonBytes(v) > INK_BYTES) return false;
  return v.s.every((s) => typeof s === 'string' && decodeStroke(s) !== null);
}

export function inkKey(seat) {
  return `${INK_PREFIX}${seat}`;
}

export function entryKey(i) {
  return `${ENTRY_PREFIX}${i}`;
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

function fillSeats(api, st) {
  const here = presentSet(api);
  let moved = false;
  st.wait = (st.wait || []).filter((s) => here.has(s) || !st.seats.includes(s));
  for (let p = 0; p < st.seats.length; p += 1) {
    if (here.has(st.seats[p])) continue;
    const i = st.wait.findIndex((s) => here.has(s));
    if (i < 0) break;
    st.seats[p] = st.wait[i];
    st.wait.splice(i, 1);
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
  fillSeats(api, st);
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
      const v = api.get(inkKey(p));
      const s = validInk(v, st.k) ? v.s : [];
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

function entryValue(chain, c, i) {
  const e = chain[i];
  const out = { c, i, k: e.k, by: e.by };
  if (e.k === 'd') out.s = e.s;
  else out.t = e.t;
  if (e.miss) out.miss = 1;
  if (e.hid) out.hid = 1;
  return out;
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
    for (let q = 0; q < n; q += 1) if (chainAt(q, st.step - 1, n) === item.c && api.get(inkKey(q)) !== null) api.put(inkKey(q), null);
  }
  if (st.phase === 'reveal' && st.rv && st.rv.c === item.c && item.i <= st.rv.at) api.put(entryKey(item.i), entryValue(chain, item.c, item.i));
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
  api.put(entryKey(0), entryValue(chain, c, 0));
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
    api.put(entryKey(at), entryValue(chain, st.rv.c, at));
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
  const chains = (mem.chains || []).filter((c) => c.length >= 3 && c[0].t);
  const ends = chains.map((c) => ({ slot: c[0].by, score: likeness(c[0].t, lastText(c.slice(1))) }));
  const wild = best(ends, (x) => 1 - x.score, taken);
  if (wild && wild.v > 0) add('wild', '🌀', 'Wildest ride', 'Their chain changed the most', wild);
  const clear = best(ends, (x) => x.score, taken);
  if (clear && clear.v > 0) add('clear', '🎯', 'Crystal clear', 'Their chain stayed closest to the start', clear);
  const fast = best(people.filter((p) => p.speed.length >= 2), (p) => p.speed.reduce((a, b) => a + b, 0) / p.speed.length, taken, true);
  add('fast', '⚡', 'Lightning hands', 'Fastest to finish each step', fast);
  add('ink', '🖍️', 'Ink champion', 'Used the most ink', best(people, (p) => p.ink, taken));
  return out;
}

function showAwards(api, st) {
  clearPrefix(api, ENTRY_PREFIX);
  const mem = api.memory;
  const slots = [...new Set((mem.chains || []).flat().map((e) => e.by))];
  const aw = pickAwards(mem, slots);
  for (const a of aw) api.addPoints(a.slot, AWARD_POINTS);
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
  api.put(KEY, st);
  settle(api, st);
}

function owned(api, st) {
  return Boolean(api.memory && api.memory.run && api.memory.run === st.run && Array.isArray(api.memory.chains));
}

function seenDrawing(snap, st) {
  const hid = hiddenSet(st);
  if (st.phase === 'text' && st.step > 0) {
    const n = st.seats.length;
    const seat = st.seats.indexOf(snap.meSlot);
    if (seat < 0 || n < 2) return null;
    const q = (seat - 1 + n) % n;
    const by = Array.isArray(st.dby) ? st.dby[q] : null;
    const v = snap.state[inkKey(q)];
    if (!Number.isInteger(by) || !validInk(v, st.dk) || !v.s.length) return null;
    const d = drawingId(st.run, chainAt(q, st.step - 1, n), st.step - 1);
    return hid.has(d) ? null : { d, drawer: by, ink: v.s.slice(), word: null, viewers: [st.seats[seat]] };
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
      return { d, drawer: e.by, ink: e.s.slice(), word };
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
  if (!entry || entry.by === slot) return;
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
  api.addPoints(entry.by, REACT_POINTS);
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
    { id: 'write', label: 'Time to write', type: 'choice', options: [30, 40, 60].map((v) => ({ value: v, label: `${v} s` })), default: 40 },
    { id: 'draw', label: 'Time to draw', type: 'choice', options: [50, 70, 90].map((v) => ({ value: v, label: `${v} s` })), default: 70 },
  ],

  writer(get, key, slot, value) {
    if (!key.startsWith(INK_PREFIX)) return false;
    const st = get(KEY);
    if (!st || st.phase !== 'draw' || !Array.isArray(st.seats)) return false;
    const seat = Number(key.slice(INK_PREFIX.length));
    if (!Number.isInteger(seat) || key !== inkKey(seat) || st.seats[seat] !== slot) return false;
    return validInk(value, st.k);
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
    if (STEP_PHASES.includes(st.phase)) {
      if (!owned(api, st)) return lose(api, 'host');
      return closeStep(api);
    }
    if (st.phase === 'reveal') {
      if (!owned(api, st)) return lose(api, 'host');
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
    if (!owned(api, st)) return lose(api, 'host');
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
    if (!st || !STEP_PHASES.includes(st.phase)) return;
    if (!owned(api, st)) return lose(api, 'host');
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
      }
      if (st.phase === 'text') {
        const key = inkKey((seat - 1 + n) % n);
        const v = snap.state[key];
        const q = (seat - 1 + n) % n;
        const hidden = st.step > 0 && hiddenSet(st).has(drawingId(st.run, chainAt(q, st.step - 1, n), st.step - 1));
        out.src = { key, k: st.dk, blank: hidden || !validInk(v, st.dk) || !v.s.length, hidden };
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
          t: e.k === 'd' ? null : typeof e.t === 'string' ? e.t : '',
          strokes: e.k === 'd' && Array.isArray(e.s) ? e.s.length : 0,
          miss: Boolean(e.miss),
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
