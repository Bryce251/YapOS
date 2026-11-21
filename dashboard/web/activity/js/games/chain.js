import { ready as dictReady, failed as dictFailed, isWord, load as loadDictionary } from '../dictionary.js';
import { isBlockedWord, BLOCKED_NOTE } from '../filter.js';
import { CATEGORIES } from '../../data/categories.js';

export const KEY = 'chain';
export const USED_PREFIX = 'chain.u.';
export const MIN_LETTERS = 3;
export const MAX_LETTERS = 60;
export const RECENT = 10;
export const HASH_LEN = 7;
export const PER_CHUNK = 500;
export const MAX_CHUNKS = 8;
export const MAX_TRIES = 6;
export const WIN_BONUS = 250;
export const START_LETTERS = 'abcdefghilmnoprstw';
export const MIN_TURN = 5;
export const LENGTHS = [0, 3, 5, 8];
export const GRACE = 500;
export const BONUS_LETTERS = 'qxz';
export const CAT_EVERY = 3;
export const CAT_EXTRA = 3;
export const HARD_EXTRA = 3;
export const CAT_POINTS = 50;
export const CLUTCH_MS = 1500;
export const FAST_MS = 2500;
export const STREAK_CALLS = Object.freeze([3, 5, 8, 12, 20]);
export const LONG_MIN = 7;

const CAT_SETS = new Map();

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

export function categoryWords(id) {
  const c = categoryById(id);
  return c ? c.words.split(' ').filter(Boolean) : [];
}

function catSet(id) {
  if (!CAT_SETS.has(id)) CAT_SETS.set(id, new Set(categoryWords(id)));
  return CAT_SETS.get(id);
}

export function inCategory(word, id) {
  const set = catSet(id);
  if (!set.size) return true;
  const w = String(word ?? '').trim().toLowerCase();
  if (set.has(w)) return true;
  if (w.endsWith('es') && set.has(w.slice(0, -2))) return true;
  return w.endsWith('s') && set.has(w.slice(0, -1));
}

export function catOptions(id, letter, used) {
  return categoryWords(id).filter((w) => w[0] === letter && w.length >= 3 && !isUsed(used, w));
}

export function pickCategory(random = Math.random, last = null) {
  const list = CATEGORIES.filter((c) => c.id !== last);
  return list[Math.floor(random() * list.length) % list.length].id;
}

export function isBonus(word) {
  const w = String(word ?? '').trim().toLowerCase();
  return w.length > 0 && BONUS_LETTERS.includes(w[w.length - 1]);
}

export function maskWord(word) {
  const w = String(word ?? '');
  const keep = Math.ceil(w.length / 2);
  return w.slice(0, keep).toUpperCase() + '_'.repeat(Math.max(0, w.length - keep));
}

export function catProblem(id) {
  const c = categoryById(id);
  return c ? `That's not on my list of ${c.name.toLowerCase()}. Try another!` : "That word doesn't fit this round's category.";
}

export function wordRef(n) {
  return `chain.${n}`;
}

const HI = 1679616;
const LO = 46656;

export function cleanWord(text) {
  return String(text ?? '').trim().toLowerCase();
}

export function wordHash(word) {
  const w = cleanWord(word);
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < w.length; i += 1) {
    const c = w.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  const n = ((a >>> 0) % HI) * LO + ((b >>> 0) % LO);
  return n.toString(36).padStart(HASH_LEN, '0');
}

export function hashesIn(values) {
  const out = new Set();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (let i = 0; i + HASH_LEN <= v.length; i += HASH_LEN) out.add(v.slice(i, i + HASH_LEN));
  }
  return out;
}

export function usedFrom(state) {
  const values = Object.keys(state || {}).filter((k) => k.startsWith(USED_PREFIX)).map((k) => state[k]);
  const set = hashesIn(values);
  return { size: set.size, has: (w) => set.has(wordHash(w)) };
}

function isUsed(used, w) {
  if (!used) return false;
  if (Array.isArray(used)) return used.includes(w);
  if (typeof used.has === 'function') return used.has(w);
  return false;
}

export function checkWord(text, letter, used, opts = {}) {
  const w = cleanWord(text);
  if (!w) return 'empty';
  if (!/^[a-z]+$/.test(w)) return 'letters';
  if (isBlockedWord(w, { strict: true })) return 'blocked';
  if (w.length < MIN_LETTERS) return 'short';
  if (w.length > MAX_LETTERS) return 'long';
  if (letter && w[0] !== letter) return 'start';
  if (isUsed(used, w)) return 'used';
  if (opts.cat && !inCategory(w, opts.cat)) return 'cat';
  const dict = opts.dictionary === undefined ? dictReady : Boolean(opts.dictionary) && dictReady;
  if (dict && !isWord(w)) return 'unknown';
  return null;
}

export const PROBLEMS = Object.freeze({
  empty: 'Type a word first.',
  letters: 'Letters only, please. No spaces, numbers or symbols.',
  short: `Words need at least ${MIN_LETTERS} letters.`,
  long: `That word is too long. Words can have up to ${MAX_LETTERS} letters.`,
  start: 'That word starts with the wrong letter.',
  used: 'Someone already played that word.',
  unknown: "That's not a word in my English dictionary. Check the spelling.",
  blocked: BLOCKED_NOTE,
  cat: "That word doesn't fit this round's category. Try another!",
});

export function wordPoints(word) {
  return Math.min(150, 10 * String(word).length);
}

export function lastLetter(word) {
  const w = cleanWord(word);
  return w ? w[w.length - 1] : null;
}

export const MIN_VOTERS = 2;

export function voters(order, present, author, cur) {
  return order.filter((s) => s !== author && s !== cur && present.includes(s));
}

export function votesNeeded(eligible) {
  return Math.floor(eligible / 2) + 1;
}

export function nextUp(order, lives, present, from) {
  const live = new Set(present);
  const ok = (s) => (lives[s] || 0) > 0 && live.has(s);
  if (!order.length) return null;
  const at = order.indexOf(from);
  for (let i = 1; i <= order.length; i += 1) {
    const s = order[(Math.max(at, -1) + i + order.length) % order.length];
    if (ok(s)) return s;
  }
  return null;
}

export function standing(order, lives, present) {
  const live = new Set(present);
  return order.filter((s) => (lives[s] || 0) > 0 && live.has(s));
}

function presentSlots(api) {
  return api.players().map((p) => p.slot);
}

function give(api, slot, n, o) {
  const got = api.addPoints(slot, n, o);
  return Number.isFinite(got) ? got : n;
}

function say(api, kind, data) {
  if (typeof api.say === 'function') api.say(kind, data);
}

function nameAt(api, slot) {
  return typeof api.nameOf === 'function' ? api.nameOf(slot) : 'Player';
}

function stats(api) {
  if (!api.memory || typeof api.memory !== 'object') return { long: [], bw: [], bonus: {}, clutch: {}, cat: {}, sk: {} };
  if (!api.memory.fx || typeof api.memory.fx !== 'object') api.memory.fx = { long: [], bw: [], bonus: {}, clutch: {}, cat: {}, sk: {} };
  return api.memory.fx;
}

function bump(map, slot, by = 1) {
  map[slot] = (map[slot] || 0) + by;
  return map[slot];
}

export function activeCat(st) {
  return st && st.cat && !st.cx ? st.cat : null;
}

export function turnExtra(st, cat) {
  const hard = st.bonus && st.letter && BONUS_LETTERS.includes(st.letter) ? HARD_EXTRA : 0;
  return (cat ? CAT_EXTRA : 0) + hard;
}

export function roundAt(st, now) {
  if (!st.until || !st.len) return { n: (st.laps || 0) + 1, total: 0 };
  const t0 = st.until - st.len * 60000;
  return { n: Math.max(1, Math.min(st.len, Math.floor((now - t0) / 60000) + 1)), total: st.len };
}

function reportRound(api, st) {
  if (typeof api.round !== 'function') return;
  const r = roundAt(st, api.now());
  api.round(r.n, r.total);
}

function newLap(api, st) {
  if (!st.cats) {
    st.cat = null;
    return;
  }
  const want = (st.laps || 0) % CAT_EVERY === CAT_EVERY - 1;
  if (want && !st.cat) {
    st.cat = pickCategory(api.random, st.lc || null);
    st.lc = st.cat;
    const c = categoryById(st.cat);
    say(api, 'custom', { text: `${c.emoji} Category round: ${c.name}! This lap, every word must be ${c.what}.` });
  } else if (!want && st.cat) {
    st.cat = null;
    say(api, 'custom', { text: '✅ Category round over. Any word goes again!' });
  }
}

function skipFrozen(api, st, slot) {
  if (typeof api.frozen !== 'function') return slot;
  let at = slot;
  for (let i = 0; i < st.order.length && at !== null && api.frozen(at); i += 1) {
    if (typeof api.thaw === 'function') api.thaw(at);
    st.fz = at;
    const lap = Array.isArray(st.lap) ? st.lap : [];
    if (!lap.includes(at)) st.lap = lap.concat([at]);
    at = nextUp(st.order, st.lives, presentSlots(api), at);
  }
  return at;
}

function keepLong(fx, word, slot) {
  if (word.length < LONG_MIN - 1) return;
  fx.long = fx.long.filter((x) => x[1] !== word).concat([[word.length, word, slot]]).sort((a, b) => b[0] - a[0]).slice(0, 3);
}

const CLUTCH_LINES = ['😅 {a} made it with a second to spare!', '😅 Phew! {a} beat the buzzer.', '😅 {a} likes to live dangerously.'];

function cheer(api, st, slot, word, bonus, cat) {
  const fx = stats(api);
  const left = st.ends - api.now();
  const took = api.now() - (st.starts || api.now());
  keepLong(fx, word, slot);
  if (cat) bump(fx.cat, slot);
  const n = bump(fx.sk, slot);
  const name = nameAt(api, slot);
  if (bonus) {
    bump(fx.bonus, slot);
    fx.bw = fx.bw.concat([[word, slot]]).slice(-3);
    say(api, 'custom', { text: `💥 ${name} ended on ${word.slice(-1).toUpperCase()}! Double points!` });
  }
  if (left < CLUTCH_MS) {
    bump(fx.clutch, slot);
    say(api, 'custom', { text: CLUTCH_LINES[Math.floor(api.random() * CLUTCH_LINES.length) % CLUTCH_LINES.length].replace('{a}', name) });
  } else if (took < FAST_MS) say(api, 'fast', { slot });
  if (n < 3 || STREAK_CALLS.includes(n)) say(api, 'streak', { slot, n });
}

function hurt(api, st, slot) {
  loseLife(st, slot);
  stats(api).sk[slot] = 0;
  if (!(st.lives[slot] > 0)) say(api, 'out', { slot });
}

function forgetWord(api, word, slot) {
  const fx = stats(api);
  fx.long = fx.long.filter((x) => x[1] !== word);
  if (fx.bw.some((x) => x[0] === word) && fx.bonus[slot]) fx.bonus[slot] -= 1;
  fx.bw = fx.bw.filter((x) => x[0] !== word);
}

function topOf(map, min = 1) {
  const list = Object.entries(map || {}).map(([s, n]) => [Number(s), n]).filter(([s, n]) => Number.isInteger(s) && n >= min);
  if (!list.length) return null;
  const best = Math.max(...list.map((x) => x[1]));
  return { slots: list.filter((x) => x[1] === best).map((x) => x[0]), n: best };
}

function chunkKey(i) {
  return `${USED_PREFIX}${i % MAX_CHUNKS}`;
}

function hostUsed(api) {
  const values = api.keys().filter((k) => k.startsWith(USED_PREFIX)).map((k) => api.get(k));
  const set = hashesIn(values);
  return { has: (w) => set.has(wordHash(w)) };
}

function remember(api, st, word) {
  const n = st.n || 0;
  const key = chunkKey(Math.floor(n / PER_CHUNK));
  const prev = n % PER_CHUNK === 0 ? '' : api.get(key) || '';
  api.put(key, prev + wordHash(word));
  st.n = n + 1;
}

function forgetLast(api, st) {
  const n = st.n || 0;
  if (n <= 0) return;
  const key = chunkKey(Math.floor((n - 1) / PER_CHUNK));
  const prev = api.get(key) || '';
  const next = prev.slice(0, Math.max(0, prev.length - HASH_LEN));
  api.put(key, next || null);
  st.n = n - 1;
}

function dictState(st) {
  if (dictReady) return 1;
  if (dictFailed) return 0;
  return st.dict === 0 ? 0 : 1;
}

export function speedLap(st, left, base) {
  const had = Array.isArray(st.lap) ? st.lap : [];
  const lap = Number.isInteger(st.cur) && !had.includes(st.cur) ? had.concat([st.cur]) : had.slice();
  if (!left.length || left.some((s) => !lap.includes(s))) {
    st.lap = lap.filter((s) => left.includes(s));
    return false;
  }
  st.lap = [];
  st.laps = (st.laps || 0) + 1;
  if (!st.fast) return false;
  const now = st.span || base;
  const span = Math.max(MIN_TURN, now - 1);
  if (span === now) return false;
  st.span = span;
  st.up = (st.t || 0) + 1;
  return true;
}

export function timeWinners(order, lives, points, words) {
  const val = (s) => [lives[s] || 0, Number(points[s]) || 0, Number(words[s]) || 0];
  const list = order.slice().sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  if (!list.length) return { w: [], why: 'none' };
  const top = val(list[0]);
  const w = list.filter((s) => val(s).every((n, i) => n === top[i]));
  if (w.length > 1) return { w, why: 'tie' };
  if (list.length < 2) return { w, why: 'lives' };
  const next = val(list[1]);
  const why = top[0] !== next[0] ? 'lives' : top[1] !== next[1] ? 'points' : 'words';
  return { w, why };
}

function names(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function timeNote(fin, nameOf) {
  const w = fin && Array.isArray(fin.w) ? fin.w : [];
  const who = names(w.map((s) => nameOf(s)));
  if (!fin || !w.length) return "Time's up!";
  if (fin.why === 'tie') return `Time's up! ${who} tied on lives, points and words.`;
  if (fin.why === 'points') return `Time's up! Lives were tied, so ${who} won with the most points.`;
  if (fin.why === 'words') return `Time's up! Lives and points were tied, so ${who} won by playing the most words.`;
  return `Time's up! ${who} had the most lives left.`;
}

function timeLeft(api, st) {
  return Boolean(st.until) && api.now() + GRACE >= st.until;
}

function timeUp(api, st) {
  const left = standing(st.order, st.lives, presentSlots(api));
  const fin = timeWinners(left, st.lives, api.points(), st.wc || {});
  for (const s of fin.w) give(api, s, WIN_BONUS, { raw: true });
  api.put(KEY, { ...st, phase: 'over', winner: fin.w.length === 1 ? fin.w[0] : null, fin, bad: null, vote: null, last: { kind: 'time', s: null, w: null } });
  api.finish(fin.w);
}

function turnDeadline(st, ends) {
  return st.until ? Math.min(ends, st.until) : ends;
}

function endIfDone(api, st) {
  const left = standing(st.order, st.lives, presentSlots(api));
  if (left.length > 1) return false;
  for (const s of left) give(api, s, WIN_BONUS, { raw: true });
  api.put(KEY, { ...st, phase: 'over', winner: left.length ? left[0] : null });
  api.finish(left);
  return true;
}

function startTurn(api, st, slot, note) {
  const starts = api.now();
  const cat = st.cat && catOptions(st.cat, st.letter, hostUsed(api)).length ? st.cat : null;
  const ends = starts + ((st.span || api.settings.timer) + turnExtra(st, cat)) * 1000;
  const next = { ...st, phase: 'turn', cur: slot, t: (st.t || 0) + 1, note: note || null, starts, ends, dict: dictState(st), bad: null, cx: st.cat && !cat ? 1 : 0, fz: Number.isInteger(st.fz) ? st.fz : null };
  api.put(KEY, next);
  api.setDeadline(turnDeadline(next, ends));
  reportRound(api, next);
  return next;
}

function loseLife(st, slot) {
  st.lives = { ...st.lives, [slot]: Math.max(0, (st.lives[slot] || 0) - 1) };
  if (!st.lives[slot] && !st.out.includes(slot)) st.out = st.out.concat([slot]);
}

function advance(api, st, note) {
  const laps = st.laps || 0;
  speedLap(st, standing(st.order, st.lives, presentSlots(api)), api.settings.timer);
  if (endIfDone(api, st)) return;
  if ((st.laps || 0) !== laps) newLap(api, st);
  st.fz = null;
  const slot = skipFrozen(api, st, nextUp(st.order, st.lives, presentSlots(api), st.cur));
  if (slot === null) {
    api.finish();
    return;
  }
  startTurn(api, st, slot, note);
}

function play(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'turn' || slot !== st.cur) return;
  if (action.t !== undefined && action.t !== st.t) return;
  if (st.until && api.now() >= st.until) {
    timeUp(api, st);
    return;
  }
  const checked = dictReady;
  const was = st.dict;
  st.dict = dictState(st);
  const cat = activeCat(st);
  const problem = checkWord(action.text, st.letter, hostUsed(api), { dictionary: checked, cat });
  if (problem) {
    const tries = st.bad && st.bad.t === st.t ? st.bad.k : 0;
    if (tries >= MAX_TRIES || problem === 'empty') {
      if (was !== st.dict) api.put(KEY, st);
      return;
    }
    st.bad = { t: st.t, k: tries + 1, s: slot, why: problem };
    api.put(KEY, st);
    return;
  }
  const word = cleanWord(action.text);
  const bonus = Boolean(st.bonus) && isBonus(word);
  const pts = give(api, slot, wordPoints(word) * (bonus ? 2 : 1) + (cat ? CAT_POINTS : 0));
  cheer(api, st, slot, word, bonus, cat);
  st.count = (st.count || 0) + 1;
  st.wc = { ...(st.wc || {}), [slot]: ((st.wc || {})[slot] || 0) + 1 };
  st.words = st.words.concat([[st.count, slot, word]]).slice(-RECENT);
  remember(api, st, word);
  st.vote = checked ? null : { n: st.count, w: word, s: slot, no: [], prev: st.letter, pts };
  st.letter = lastLetter(word);
  st.last = { kind: 'word', s: slot, w: word, b: bonus ? 1 : 0, c: cat ? 1 : 0, p: pts };
  st.bad = null;
  advance(api, st);
}

function nope(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'turn' || !st.vote) return;
  const v = st.vote;
  if (action.n !== v.n || slot === v.s || slot === st.cur || !st.order.includes(slot) || v.no.includes(slot)) return;
  const present = presentSlots(api);
  const eligible = voters(st.order, present, v.s, st.cur).length;
  if (eligible < MIN_VOTERS) return;
  v.no = v.no.concat([slot]);
  if (v.no.length < votesNeeded(eligible)) {
    api.put(KEY, st);
    return;
  }
  st.words = st.words.filter((x) => x[0] !== v.n);
  if (v.n === st.count) forgetLast(api, st);
  st.letter = v.prev;
  st.struck = (st.struck || 0) + 1;
  st.vote = null;
  st.last = { kind: 'reject', s: v.s, w: v.w };
  api.addPoints(v.s, -v.pts, { raw: true });
  if (st.wc && st.wc[v.s]) st.wc = { ...st.wc, [v.s]: st.wc[v.s] - 1 };
  forgetWord(api, v.w, v.s);
  hurt(api, st, v.s);
  st.fz = null;
  if (endIfDone(api, st)) return;
  if (st.cur === v.s || !present.includes(st.cur) || !(st.lives[st.cur] > 0)) {
    advance(api, st);
    return;
  }
  startTurn(api, st, st.cur, 'again');
}

export function lateLives() {
  return 1;
}

export function seat(order, slot, cur) {
  if (order.includes(slot)) return order.slice();
  const at = order.indexOf(cur);
  if (at < 0) return order.concat([slot]);
  return order.slice(0, at + 1).concat([slot], order.slice(at + 1));
}

const chain = {
  id: 'chain',
  name: 'Word Chain',
  category: 'words',
  emoji: '🔗',
  blurb: 'Say a word that starts with the last letter of the one before. Run out of time and you lose a life.',
  minPlayers: 2,
  keys: [KEY],
  prefixes: [USED_PREFIX],
  cards: ['swap', 'double', 'freeze', 'peek'],
  settings: [
    { id: 'timer', label: 'Time per turn', type: 'choice', options: [8, 10, 12, 15, 20].map((v) => ({ value: v, label: `${v} s` })), default: 12 },
    { id: 'lives', label: 'Lives', type: 'choice', options: [1, 2, 3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
    { id: 'speedup', label: 'Speed up each lap', type: 'toggle', default: true },
    { id: 'length', label: 'Game length', type: 'choice', options: LENGTHS.map((v) => ({ value: v, label: v ? `${v} min` : 'No limit' })), default: 5 },
    { id: 'bonus', label: '💥 Q, X, Z score double', type: 'toggle', default: true, fun: true },
    { id: 'cats', label: '🐾 Category laps', type: 'toggle', default: true, fun: true },
  ],

  prepare() {
    loadDictionary();
  },

  start(api) {
    loadDictionary();
    const order = presentSlots(api);
    const lives = {};
    for (const s of order) lives[s] = api.settings.lives;
    const letter = START_LETTERS[Math.floor(api.random() * START_LETTERS.length)];
    const length = LENGTHS.includes(api.settings.length) ? api.settings.length : 0;
    const until = length ? Math.round(api.now() + length * 60000) : 0;
    const st = { v: 4, order, lives, max: api.settings.lives, out: [], letter, words: [], n: 0, count: 0, vote: null, bad: null, dict: dictFailed && !dictReady ? 0 : 1, last: null, t: 0, cur: null, phase: 'turn', span: api.settings.timer, fast: api.settings.speedup === false ? 0 : 1, lap: [], laps: 0, up: 0, until, len: length, wc: {}, bonus: api.settings.bonus === false ? 0 : 1, cats: api.settings.cats === false ? 0 : 1, cat: null, lc: null, cx: 0, fz: null };
    if (api.memory) api.memory.fx = null;
    const first = order[Math.floor(api.random() * order.length)];
    startTurn(api, st, first, 'first');
  },

  results(api) {
    const st = api.get(KEY);
    if (!st || !st.fin) return {};
    return { note: timeNote(st.fin, (s) => api.nameOf(s)) };
  },

  texts(api) {
    const st = api.get(KEY);
    if (!st || !Array.isArray(st.words)) return [];
    return st.words
      .filter((x) => Array.isArray(x) && Number.isInteger(x[0]) && Number.isInteger(x[1]) && typeof x[2] === 'string' && x[2])
      .map(([n, s, w], i, all) => ({ r: wordRef(n), author: s, text: w, context: i > 0 ? `Word Chain, played after “${all[i - 1][2]}”` : 'Word Chain' }));
  },

  canFreeze(api, target, by) {
    const st = api.get(KEY);
    return Boolean(st && st.phase === 'turn' && target !== by && st.order.includes(target) && st.lives[target] > 0);
  },

  freeze(api, target, by) {
    return chain.canFreeze(api, target, by);
  },

  hint(api, slot) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn' || slot !== st.cur || !st.letter) return null;
    const used = hostUsed(api);
    const cat = activeCat(st);
    const pool = cat ? catOptions(cat, st.letter, used) : [...new Set(CATEGORIES.flatMap((c) => catOptions(c.id, st.letter, used)))];
    if (!pool.length) return null;
    const w = pool[Math.floor(api.random() * pool.length) % pool.length];
    return `👀 Try this one: ${maskWord(w)} (${w.length} letters)`;
  },

  awards(api) {
    const fx = api.memory ? api.memory.fx : null;
    if (!fx) return [];
    const out = [];
    const long = fx.long[0];
    if (long && long[0] >= LONG_MIN) out.push({ emoji: '📏', title: 'Wordsmith', who: long[2], why: `Longest word of the game, ${long[0]} letters` });
    const bonus = topOf(fx.bonus);
    if (bonus) out.push({ emoji: '💥', title: 'Bonus hunter', who: bonus.slots, why: bonus.n === 1 ? 'Ended a word on Q, X or Z' : `Ended ${bonus.n} words on Q, X or Z` });
    const clutch = topOf(fx.clutch, 2);
    if (clutch) out.push({ emoji: '😅', title: 'Clutch player', who: clutch.slots, why: `Beat the buzzer ${clutch.n} times` });
    const cat = topOf(fx.cat, 2);
    if (cat) out.push({ emoji: '🏷️', title: 'Category champ', who: cat.slots, why: `${cat.n} words in category rounds` });
    return out;
  },

  highlights(api) {
    const fx = api.memory ? api.memory.fx : null;
    if (!fx) return [];
    const out = fx.long.map(([n, w, s]) => ({ text: `📏 “${w}”, ${n} letters`, who: s }));
    for (const [w, s] of fx.bw) if (!fx.long.some((x) => x[1] === w)) out.push({ text: `💥 “${w}” for double points`, who: s });
    return out.slice(0, 5);
  },

  intent(api, slot, action) {
    if (action.type === 'word') return play(api, slot, action);
    if (action.type === 'nope') return nope(api, slot, action);
    return undefined;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase !== 'turn') return undefined;
    if (timeLeft(api, st)) return timeUp(api, st);
    hurt(api, st, st.cur);
    st.last = { kind: st.lives[st.cur] ? 'miss' : 'out', s: st.cur, w: null };
    return advance(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn') return false;
    if (action.type === 'skip') {
      st.last = { kind: 'skip', s: st.cur, w: null };
      advance(api, st);
      return true;
    }
    if (action.type === 'time') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(turnDeadline(st, ends));
      return true;
    }
    return false;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn' || !Number.isInteger(slot)) return;
    if (st.order.includes(slot)) return;
    const present = presentSlots(api).filter((s) => s !== slot);
    st.lives = { ...st.lives, [slot]: lateLives(st, present) };
    st.order = seat(st.order, slot, st.cur);
    api.put(KEY, st);
  },

  resume(api) {
    loadDictionary();
    const st = api.get(KEY);
    if (!st) return chain.start(api);
    if (st.phase !== 'turn') return undefined;
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), turnDeadline(st, st.ends || api.now())));
    chain.roster(api);
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn') return;
    const here = presentSlots(api);
    const gone = st.order.filter((s) => !here.includes(s) && (st.lives[s] || 0) > 0);
    if (gone.length) {
      st.lives = { ...st.lives };
      for (const s of gone) {
        st.lives[s] = 0;
        if (!st.out.includes(s)) st.out = st.out.concat([s]);
      }
    }
    if (endIfDone(api, st)) return;
    if (!here.includes(st.cur)) {
      st.last = { kind: 'left', s: st.cur, w: null };
      advance(api, st);
      return;
    }
    if (gone.length) api.put(KEY, st);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      return p
        ? { slot, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: p.isMe, present: p.present }
        : { slot, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false, present: false };
    };
    const present = snap.players.filter((p) => p.present && p.slot !== null).map((p) => p.slot);
    const v = st.vote;
    let vote = null;
    if (v) {
      const eligible = voters(st.order, present, v.s, st.cur).length;
      const open = eligible >= MIN_VOTERS;
      const voted = v.no.includes(mine) || (local.nope === v.n);
      vote = {
        n: v.n,
        word: v.w,
        by: who(v.s),
        count: v.no.length,
        need: votesNeeded(eligible),
        voted,
        open,
        onClock: mine !== null && mine === st.cur,
        canVote: open && st.phase === 'turn' && mine !== null && mine !== v.s && mine !== st.cur && st.order.includes(mine) && !voted,
      };
    }
    const myTurn = st.phase === 'turn' && mine !== null && st.cur === mine;
    const cat = st.cat ? categoryById(st.cat) : null;
    const bad = st.bad && st.bad.t === st.t && st.bad.s === mine ? { k: st.bad.k, why: st.bad.why } : null;
    return {
      phase: st.phase,
      t: st.t,
      letter: st.letter,
      count: Math.max(0, (st.count || 0) - (st.struck || 0)),
      cur: st.cur === null ? null : who(st.cur),
      myTurn,
      playing: mine !== null && st.order.includes(mine),
      alive: mine !== null && (st.lives[mine] || 0) > 0,
      starts: st.starts,
      ends: st.ends,
      span: st.span || null,
      extra: st.phase === 'turn' && st.span && st.ends && st.starts ? Math.max(0, Math.round((st.ends - st.starts) / 1000) - st.span) : 0,
      fast: Boolean(st.fast),
      sped: Boolean(st.up) && st.up === st.t,
      until: st.until || 0,
      fin: st.fin ? st.fin.why : null,
      max: st.max,
      players: st.order.map((s) => ({ ...who(s), lives: st.lives[s] || 0, out: !(st.lives[s] > 0), isCur: s === st.cur })),
      words: st.words.map(([n, s, w]) => ({ n, word: w, ...who(s), latest: Boolean(v && v.n === n), bonus: Boolean(st.bonus) && isBonus(w) })),
      vote,
      last: st.last ? { kind: st.last.kind, w: st.last.w, ...who(st.last.s), bonus: Boolean(st.last.b), cat: Boolean(st.last.c), pts: Number(st.last.p) || 0 } : null,
      bonus: Boolean(st.bonus),
      cat: cat ? { id: cat.id, name: cat.name, emoji: cat.emoji, what: cat.what } : null,
      catOn: Boolean(cat) && !st.cx,
      skipped: Number.isInteger(st.fz) ? who(st.fz) : null,
      note: st.note,
      dict: st.dict !== 0,
      bad,
    };
  },
};

export default chain;
