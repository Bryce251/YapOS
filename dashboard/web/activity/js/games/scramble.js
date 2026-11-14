import { TIERS, wordById, idsIn, tierOf } from '../../data/scramble.js';
import { shuffle } from '../engine.js';
import { mask, unmask } from './draw.js';
import { ready as dictReady, isWord, load as loadDictionary } from '../dictionary.js';

export const KEY = 'scramble';
export const ROUND_MS = 30000;
export const REVEAL_MS = 5000;
export const PLACE_POINTS = Object.freeze([100, 70, 50, 30]);
export const LATE_POINTS = 20;
export const GUESS_GAP_MS = 300;
export const GUESS_CHARS = 24;
export const FOUND_MAX = 16;
export const SHUFFLE_TRIES = 80;
export const BLOCKED = Object.freeze(new Set(['rape', 'neger', 'perianal', 'bordello', 'raunchier', 'boogerman', 'snog']));

export function blocked(word) {
  return BLOCKED.has(String(word || '').toLowerCase());
}

export function cleanGuess(text) {
  const raw = String(text ?? '');
  if (raw.length > GUESS_CHARS) return '';
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

export function letterKey(word) {
  return Array.from(String(word || '').toLowerCase()).sort().join('');
}

export function sameLetters(a, b) {
  return letterKey(a) === letterKey(b);
}

export function placePoints(place) {
  return place < PLACE_POINTS.length ? PLACE_POINTS[place] : LATE_POINTS;
}

function spots(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) n += 1;
  return n;
}

export function scrambleWord(word, random = Math.random, real = () => false) {
  const w = String(word || '').toLowerCase();
  const letters = Array.from(w);
  if (letters.length < 2 || new Set(letters).size < 2) return w;
  let fallback = null;
  let loose = null;
  for (let i = 0; i < SHUFFLE_TRIES; i += 1) {
    const s = shuffle(letters, random).join('');
    if (s === w || blocked(s)) continue;
    if (loose === null) loose = s;
    if (real(s)) continue;
    if (fallback === null) fallback = s;
    if (s[0] !== w[0] && spots(s, w) <= Math.floor(w.length / 3)) return s;
  }
  if (fallback !== null) return fallback;
  if (loose !== null) return loose;
  return letters.slice(1).concat(letters[0]).join('');
}

export function judgeGuess(guess, target, { dictionary } = {}) {
  const g = cleanGuess(guess);
  const t = String(target || '').toLowerCase();
  if (!g) return 'empty';
  if (g === t) return 'right';
  if (g.length !== t.length || !sameLetters(g, t)) return 'letters';
  if (blocked(g)) return 'unknown';
  const dict = dictionary === undefined ? dictReady : Boolean(dictionary) && dictReady;
  if (dict && isWord(g)) return 'other';
  return 'unknown';
}

export function buildDeck(length, rounds, random = Math.random) {
  const count = Math.max(1, Math.floor(rounds) || 1);
  if (TIERS.some((t) => t.id === length)) return shuffle(idsIn(length), random).slice(0, count);
  const base = Math.floor(count / TIERS.length);
  const extra = count - base * TIERS.length;
  const out = [];
  TIERS.forEach((t, i) => {
    const take = base + (i >= TIERS.length - extra ? 1 : 0);
    out.push(...shuffle(idsIn(t.id), random).slice(0, take));
  });
  return out;
}

export function hintFrom(starts, ends) {
  return starts + Math.min(ROUND_MS, Math.max(0, ends - starts)) / 2;
}

function presentSlots(api) {
  return api.players().map((p) => p.slot);
}

function targetOf(st) {
  if (!st || st.w === null || st.w === undefined) return null;
  return wordById(unmask(st.w, st.k));
}

function ask(api, st, i, note) {
  const deck = st.deck.map((code) => unmask(code, st.k));
  const word = wordById(deck[i]);
  if (!word) return api.finish();
  const starts = api.now();
  const ends = starts + ROUND_MS;
  api.memory.cur = { i, words: {} };
  api.put(KEY, {
    v: 1,
    k: st.k,
    deck: st.deck,
    i,
    total: st.deck.length,
    len: st.len,
    phase: 'play',
    w: mask(deck[i], st.k),
    s: scrambleWord(word, api.random, (x) => dictReady && isWord(x)),
    tier: tierOf(word),
    got: [],
    no: {},
    found: null,
    word: null,
    note: note || null,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, st) {
  if (st.i + 1 < st.deck.length) return ask(api, st, st.i + 1);
  return api.finish();
}

function reveal(api, note) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'play') return;
  const cur = api.memory.cur;
  const words = cur && cur.i === st.i ? cur.words : {};
  const target = targetOf(st);
  const found = [];
  for (const [slot] of st.got) {
    const w = words[slot];
    if (w && w !== target) found.push([slot, w]);
    if (found.length >= FOUND_MAX) break;
  }
  api.memory.cur = null;
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', word: target, found, note: note || null, starts, ends });
  api.setDeadline(ends);
}

function everyoneGot(api, st) {
  const present = presentSlots(api);
  return present.length > 0 && present.every((s) => st.got.some((g) => g[0] === s));
}

function guess(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'play') return;
  if (action.i !== undefined && action.i !== st.i) return;
  if (!presentSlots(api).includes(slot)) return;
  if (st.got.some((g) => g[0] === slot)) return;
  if (typeof action.text !== 'string') return;
  const at = api.now();
  const gaps = (api.memory.gaps = api.memory.gaps || {});
  if (gaps[slot] && at - gaps[slot] < GUESS_GAP_MS) return;
  gaps[slot] = at;
  const target = targetOf(st);
  if (!target) return;
  const verdict = judgeGuess(action.text, target);
  if (verdict === 'empty') return;
  if (verdict !== 'right' && verdict !== 'other') {
    st.no = { ...(st.no || {}), [slot]: ((st.no && st.no[slot]) || 0) + 1 };
    api.put(KEY, st);
    return;
  }
  const pts = placePoints(st.got.length);
  st.got = st.got.concat([[slot, pts]]);
  if (verdict === 'other') {
    const cur = api.memory.cur && api.memory.cur.i === st.i ? api.memory.cur : (api.memory.cur = { i: st.i, words: {} });
    cur.words[slot] = cleanGuess(action.text);
  }
  api.addPoints(slot, pts);
  api.put(KEY, st);
  if (everyoneGot(api, st)) reveal(api, 'all');
}

const scramble = {
  id: 'scramble',
  name: 'Scramble Race',
  emoji: '🔀',
  category: 'words',
  blurb: 'Unscramble the letters before everyone else. The fastest fingers score the most.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Words', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    {
      id: 'length',
      label: 'Word length',
      type: 'choice',
      options: [{ value: 'mixed', label: '🎲 Mixed' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name} (${t.min}-${t.max})` }))),
      default: 'mixed',
    },
  ],

  prepare() {
    loadDictionary();
  },

  start(api) {
    loadDictionary();
    const k = 1 + Math.floor(api.random() * 65535);
    const ids = buildDeck(api.settings.length, api.settings.rounds, api.random);
    ask(api, { k, deck: ids.map((id) => mask(id, k)), len: api.settings.length }, 0);
  },

  intent(api, slot, action) {
    if (action.type === 'guess') guess(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'play') return reveal(api, 'time');
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'play' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'play') reveal(api, 'skip');
      else next(api, st);
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
    if (!Number.isInteger(slot)) return;
    scramble.roster(api);
  },

  resume(api) {
    loadDictionary();
    const st = api.get(KEY);
    if (!st) return scramble.start(api);
    if (st.phase === 'play') {
      const cur = api.memory.cur;
      if (!cur || cur.i !== st.i) return reveal(api, 'host');
    }
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'play') return;
    if (everyoneGot(api, st)) reveal(api, 'all');
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const now = local.now ?? snap.now;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      return p
        ? { slot, id: p.id, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: p.isMe }
        : { slot, id: null, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false };
    };
    const target = targetOf(st);
    const playing = mine !== null && snap.meJoined !== false;
    const gotAt = st.got.findIndex((g) => g[0] === mine);
    const gotMe = mine !== null && gotAt >= 0;
    const revealed = st.phase === 'reveal';
    const hintOn = st.phase === 'play' && now >= hintFrom(st.starts, st.ends);
    const sent = local.solved && local.solved.i === st.i ? local.solved.word : null;
    const foundMine = revealed ? (st.found || []).find((f) => f[0] === mine) : null;
    const tier = TIERS.find((t) => t.id === st.tier) || null;
    return {
      phase: st.phase,
      i: st.i,
      number: st.i + 1,
      total: st.total,
      letters: Array.from(st.s || ''),
      size: (st.s || '').length,
      tier: tier ? { id: tier.id, name: tier.name, emoji: tier.emoji } : null,
      starts: st.starts,
      ends: st.ends,
      hint: hintOn && target ? target[0] : null,
      hintAt: hintFrom(st.starts, st.ends),
      answer: revealed ? st.word || target : null,
      check: target,
      found: revealed ? (st.found || []).map(([slot, word]) => ({ word, ...who(slot) })) : [],
      got: st.got.map(([slot, pts], place) => ({ ...who(slot), pts, place: place + 1 })),
      gotMe,
      place: gotMe ? gotAt + 1 : 0,
      myPts: gotMe ? st.got[gotAt][1] : 0,
      myWord: gotMe ? (foundMine ? foundMine[1] : sent || (revealed ? st.word || target : null)) : null,
      wrong: mine !== null && st.no ? st.no[mine] || 0 : 0,
      playing,
      canGuess: st.phase === 'play' && playing && !gotMe,
      players: (snap.players || []).filter((p) => p.present && p.slot !== null && p.joined !== false).length,
      note: st.note,
    };
  },
};

export default scramble;
