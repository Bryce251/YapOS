import { TIERS, WORDS, wordById, idsIn, tierOf } from '../../data/scramble.js';
import { shuffle } from '../engine.js';
import { mask, unmask } from './draw.js';
import { ready as dictReady, isWord, load as loadDictionary } from '../dictionary.js';
import { isBlockedWord } from '../filter.js';
import { cachedDaily, loadDaily, dailyFailedFor, utcDay } from '../admin.js';
import { answerHash } from '../daily.js';
import { award, roundAt, say, streak, missRest, bump, prize, bestStreak, keep, reel, list, nameOf } from './funkit.js';

export const KEY = 'scramble';
export const ROUND_MS = 25000;
export const FAST_MS = 5000;
export const REVEAL_MS = 5000;
export const PLACE_POINTS = Object.freeze([100, 70, 50, 30]);
export const LATE_POINTS = 20;
export const GUESS_GAP_MS = 300;
export const GUESS_CHARS = 24;
export const FOUND_MAX = 16;
export const SHUFFLE_TRIES = 80;
export const DAILY_ROUNDS = 5;
export const LOAD_STEP_MS = 500;
export const LOAD_MAX_MS = 15000;
export const FAIL_MS = 6000;

export function blocked(word) {
  return isBlockedWord(String(word || '').toLowerCase(), { strict: true });
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

export function judgeDaily(guess, letters, target) {
  const g = cleanGuess(guess);
  const l = String(letters || '').toLowerCase();
  if (!g) return 'empty';
  if (target && g === target) return 'right';
  if (g.length !== l.length || !sameLetters(g, l)) return 'letters';
  if (blocked(g)) return 'unknown';
  if (dictReady && isWord(g)) return target ? 'other' : 'right';
  return 'unknown';
}

export function dailyTarget(letters, check = null) {
  const key = letterKey(String(letters || '').toLowerCase());
  let first = null;
  for (let i = 0; i < WORDS.length; i += 1) {
    if (letterKey(WORDS[i]) !== key || blocked(WORDS[i])) continue;
    if (!check || check(WORDS[i])) return i;
    if (first === null) first = i;
  }
  return first;
}

export function dailyDeck(puzzle) {
  const rounds = puzzle && puzzle.scramble && Array.isArray(puzzle.scramble.rounds) ? puzzle.scramble.rounds : [];
  return rounds
    .slice(0, DAILY_ROUNDS)
    .map((r, i) => ({ l: String((r && r.letters) || '').toLowerCase(), hash: r ? r.answerHash : null, i }))
    .filter((r) => /^[a-z]{3,12}$/.test(r.l))
    .map((r) => ({ s: r.l, id: dailyTarget(r.l, puzzle.date && r.hash ? (w) => answerHash(puzzle.date, r.i, w) === r.hash : null) }));
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
  if (st.daily) return askDaily(api, st, i, note);
  const deck = st.deck.map((code) => unmask(code, st.k));
  const word = wordById(deck[i]);
  if (!word) return api.finish();
  const starts = api.now();
  const ends = starts + ROUND_MS;
  api.memory.cur = { i, words: {} };
  roundAt(api, i + 1, st.deck.length);
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

function askDaily(api, st, i, note) {
  const letters = st.dl && st.dl[i];
  if (!letters) return api.finish();
  const code = st.deck[i];
  const id = code === null || code === undefined ? null : unmask(code, st.k);
  const word = id === null ? null : wordById(id);
  const starts = api.now();
  const ends = starts + ROUND_MS;
  api.memory.cur = { i, words: {} };
  roundAt(api, i + 1, st.dl.length);
  api.put(KEY, {
    v: 1,
    k: st.k,
    deck: st.deck,
    dl: st.dl,
    daily: st.daily,
    i,
    total: st.dl.length,
    len: 'daily',
    phase: 'play',
    w: word ? code : null,
    s: letters,
    tier: tierOf(letters),
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

function failDaily(api, date) {
  const starts = api.now();
  const ends = starts + FAIL_MS;
  api.put(KEY, { v: 1, phase: 'fail', daily: date, i: 0, total: DAILY_ROUNDS, got: [], no: {}, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function startDaily(api, date, puzzle) {
  const deck = dailyDeck(puzzle);
  if (!deck.length) return failDaily(api, date);
  const k = 1 + Math.floor(api.random() * 65535);
  return askDaily(api, { k, deck: deck.map((d) => (d.id === null ? null : mask(d.id, k))), dl: deck.map((d) => d.s), daily: date }, 0);
}

function waitDaily(api, date, st) {
  const now = api.now();
  const since = st && st.phase === 'load' && typeof st.since === 'number' ? st.since : now;
  const puzzle = cachedDaily(date);
  if (puzzle) return startDaily(api, date, puzzle);
  if (now - since >= LOAD_MAX_MS || (st && dailyFailedFor(date))) return failDaily(api, date);
  loadDaily(date);
  if (!st || st.phase !== 'load') api.put(KEY, { v: 1, phase: 'load', daily: date, since, i: 0, total: DAILY_ROUNDS, got: [], no: {}, starts: since, ends: since + LOAD_MAX_MS });
  api.setDeadline(now + LOAD_STEP_MS);
  return undefined;
}

function next(api, st) {
  const total = st.daily ? (st.dl || []).length : st.deck.length;
  if (st.i + 1 < total) return ask(api, st, st.i + 1);
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
  missRest(api, st.got.map((g) => g[0]));
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  const shown = target || (found.length ? found[0][1] : null);
  api.put(KEY, { ...st, phase: 'reveal', word: shown, found: target ? found : found.slice(1), note: note || null, starts, ends });
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
  if (!target && !st.daily) return;
  const verdict = st.daily ? judgeDaily(action.text, st.s, target) : judgeGuess(action.text, target);
  if (verdict === 'empty') return;
  if (verdict !== 'right' && verdict !== 'other') {
    st.no = { ...(st.no || {}), [slot]: ((st.no && st.no[slot]) || 0) + 1 };
    api.put(KEY, st);
    return;
  }
  const place = st.got.length;
  const pts = award(api, slot, placePoints(place));
  st.got = st.got.concat([[slot, pts]]);
  const word = cleanGuess(action.text);
  if (verdict === 'other' || (verdict === 'right' && !target)) {
    const cur = api.memory.cur && api.memory.cur.i === st.i ? api.memory.cur : (api.memory.cur = { i: st.i, words: {} });
    cur.words[slot] = word;
    if (verdict === 'other' && target) keep(api, `${nameOf(api, slot)} found "${word.toUpperCase()}" when the word was ${target.toUpperCase()}`, slot, 3);
  }
  noteSolve(api, st, slot, place, at, word);
  api.put(KEY, st);
  if (everyoneGot(api, st)) reveal(api, 'all');
}

function noteSolve(api, st, slot, place, at, word) {
  const took = Math.max(0, at - st.starts);
  if (place === 0) {
    bump(api, 'first', slot);
    if (took <= FAST_MS) say(api, 'fast', { slot });
  }
  bump(api, 'solved', slot);
  const fx = api.memory.fx;
  if (place === 0 && word && (!fx.quick || took < fx.quick.ms)) fx.quick = { slot, ms: took, word };
  streak(api, slot, true);
}

export function scrambleHint(st, target, slot) {
  if (!st || st.phase !== 'play' || !target || target.length < 3) return null;
  if (st.got.some((g) => g[0] === slot)) return null;
  return `It starts with "${target.slice(0, 2).toUpperCase()}" and has ${target.length} letters.`;
}

const scramble = {
  id: 'scramble',
  name: 'Scramble Race',
  emoji: '🔀',
  category: 'words',
  blurb: 'Unscramble the letters before everyone else. The fastest fingers score the most.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Words', type: 'choice', options: [5, 8, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 8 },
    {
      id: 'length',
      label: 'Word length',
      type: 'choice',
      options: [{ value: 'mixed', label: '🎲 Mixed' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name} (${t.min}-${t.max})` }))),
      default: 'mixed',
    },
    { id: 'daily', label: 'Daily puzzle', type: 'toggle', default: false, daily: 'scramble' },
  ],

  prepare() {
    loadDictionary();
  },

  start(api) {
    loadDictionary();
    if (api.settings.daily) return waitDaily(api, utcDay(api.now()), null);
    const k = 1 + Math.floor(api.random() * 65535);
    const ids = buildDeck(api.settings.length, api.settings.rounds, api.random);
    ask(api, { k, deck: ids.map((id) => mask(id, k)), len: api.settings.length }, 0);
  },

  intent(api, slot, action) {
    if (action.type === 'guess') guess(api, slot, action);
  },

  hint(api, slot) {
    const st = api.get(KEY);
    return scrambleHint(st, targetOf(st), slot);
  },

  awards(api) {
    const fx = api.memory.fx;
    const q = fx && fx.quick;
    const hot = bestStreak(api);
    return list(
      prize(api, 'first', 'Word wizard', '🧙', (n) => (n === 1 ? 'Solved one word first' : `Solved ${n} words first`), 2),
      hot ? { title: 'Unstoppable', emoji: '🔥', who: hot.slots, why: `${hot.n} words in a row` } : null,
      q && q.ms <= 4000 ? { title: 'Blink and miss it', emoji: '⚡', who: q.slot, why: `Unscrambled ${q.word.toUpperCase()} in ${(q.ms / 1000).toFixed(1)} s` } : null,
    );
  },

  highlights(api) {
    const fx = api.memory.fx;
    const q = fx && fx.quick;
    if (q) keep(api, `${nameOf(api, q.slot)} unscrambled ${q.word.toUpperCase()} in ${(q.ms / 1000).toFixed(1)} s`, q.slot, 2);
    return reel(api);
  },

  results(api) {
    const st = api.get(KEY);
    return st && typeof st.daily === 'string' && st.phase !== 'load' && st.phase !== 'fail' ? { daily: st.daily } : {};
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'load') return waitDaily(api, st.daily, st);
    if (st.phase === 'fail') return api.finish();
    if (st.phase === 'play') return reveal(api, 'time');
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (st && (st.phase === 'load' || st.phase === 'fail') && action.type === 'skip') {
      api.finish();
      return true;
    }
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
    if (st.phase === 'load') return waitDaily(api, st.daily, st);
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
    if (st.phase === 'load' || st.phase === 'fail') {
      const watching = snap.meSlot === null || snap.meSlot === undefined || snap.meJoined === false;
      return { phase: st.phase, daily: st.daily || null, i: 0, number: 1, total: st.total || DAILY_ROUNDS, starts: st.starts, ends: st.ends, got: [], found: [], letters: [], size: 0, tier: null, playing: !watching, canGuess: false, gotMe: false, wrong: 0, note: null };
    }
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
      daily: typeof st.daily === 'string' ? st.daily : null,
    };
  },
};

export default scramble;
