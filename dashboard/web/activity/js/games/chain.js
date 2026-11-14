import { ready as dictReady, failed as dictFailed, isWord, load as loadDictionary } from '../dictionary.js';

export const KEY = 'chain';
export const USED_PREFIX = 'chain.u.';
export const MIN_LETTERS = 3;
export const MAX_LETTERS = 45;
export const RECENT = 10;
export const HASH_LEN = 7;
export const PER_CHUNK = 500;
export const MAX_CHUNKS = 8;
export const MAX_TRIES = 6;
export const WIN_BONUS = 250;
export const START_LETTERS = 'abcdefghilmnoprstw';

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
  if (w.length < MIN_LETTERS) return 'short';
  if (w.length > MAX_LETTERS) return 'long';
  if (letter && w[0] !== letter) return 'start';
  if (isUsed(used, w)) return 'used';
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

function endIfDone(api, st) {
  const left = standing(st.order, st.lives, presentSlots(api));
  if (left.length > 1) return false;
  for (const s of left) api.addPoints(s, WIN_BONUS);
  api.put(KEY, { ...st, phase: 'over', winner: left.length ? left[0] : null });
  api.finish(left);
  return true;
}

function startTurn(api, st, slot, note) {
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const next = { ...st, phase: 'turn', cur: slot, t: (st.t || 0) + 1, note: note || null, starts, ends, dict: dictState(st), bad: null };
  api.put(KEY, next);
  api.setDeadline(ends);
  return next;
}

function loseLife(st, slot) {
  st.lives = { ...st.lives, [slot]: Math.max(0, (st.lives[slot] || 0) - 1) };
  if (!st.lives[slot] && !st.out.includes(slot)) st.out = st.out.concat([slot]);
}

function advance(api, st, note) {
  if (endIfDone(api, st)) return;
  const slot = nextUp(st.order, st.lives, presentSlots(api), st.cur);
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
  const checked = dictReady;
  const was = st.dict;
  st.dict = dictState(st);
  const problem = checkWord(action.text, st.letter, hostUsed(api), { dictionary: checked });
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
  const pts = wordPoints(word);
  api.addPoints(slot, pts);
  st.count = (st.count || 0) + 1;
  st.words = st.words.concat([[st.count, slot, word]]).slice(-RECENT);
  remember(api, st, word);
  st.vote = checked ? null : { n: st.count, w: word, s: slot, no: [], prev: st.letter, pts };
  st.letter = lastLetter(word);
  st.last = { kind: 'word', s: slot, w: word };
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
  api.addPoints(v.s, -v.pts);
  loseLife(st, v.s);
  if (endIfDone(api, st)) return;
  if (st.cur === v.s || !present.includes(st.cur) || !(st.lives[st.cur] > 0)) {
    advance(api, st);
    return;
  }
  startTurn(api, st, st.cur, 'again');
}

export function lateLives(st, present) {
  const alive = standing(st.order, st.lives, present).map((s) => st.lives[s] || 0);
  return Math.max(1, alive.length ? Math.min(...alive) : 1);
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
  emoji: '🔗',
  blurb: 'Say a word that starts with the last letter of the one before. Run out of time and you lose a life.',
  minPlayers: 2,
  keys: [KEY],
  prefixes: [USED_PREFIX],
  settings: [
    { id: 'timer', label: 'Time per turn', type: 'choice', options: [10, 15, 20].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    { id: 'lives', label: 'Lives', type: 'choice', options: [1, 2, 3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
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
    const st = { v: 2, order, lives, max: api.settings.lives, out: [], letter, words: [], n: 0, count: 0, vote: null, bad: null, dict: dictFailed && !dictReady ? 0 : 1, last: null, t: 0, cur: null, phase: 'turn' };
    const first = order[Math.floor(api.random() * order.length)];
    startTurn(api, st, first, 'first');
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
    loseLife(st, st.cur);
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
      api.setDeadline(ends);
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
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    chain.roster(api);
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'turn') return;
    if (endIfDone(api, st)) return;
    if (!presentSlots(api).includes(st.cur)) {
      st.last = { kind: 'left', s: st.cur, w: null };
      advance(api, st);
    }
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
      max: st.max,
      players: st.order.map((s) => ({ ...who(s), lives: st.lives[s] || 0, out: !(st.lives[s] > 0), isCur: s === st.cur })),
      words: st.words.map(([n, s, w]) => ({ n, word: w, ...who(s), latest: Boolean(v && v.n === n) })),
      vote,
      last: st.last ? { kind: st.last.kind, w: st.last.w, ...who(st.last.s) } : null,
      note: st.note,
      dict: st.dict !== 0,
      bad,
    };
  },
};

export default chain;
