import { CATEGORIES, PUZZLES, puzzleByN, categoryById } from '../../data/emoji.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';
import { cleanText, plainKey, editDistance, closeEnough } from '../text.js';

export const KEY = 'emoji';
export const REVEAL_MS = 5000;
export const MIN_POINTS = 400;
export const MAX_POINTS = 1000;
export const LATE_MIN_MS = 4000;
export const GUESS_CHARS = 60;
export const GUESS_GAP_MS = 300;

export function mask(n, k) {
  return (n ^ k) & 0xffff;
}

export function unmask(code, k) {
  return (code ^ k) & 0xffff;
}

export function scramble(text, k) {
  return Array.from(String(text ?? ''))
    .map((ch, i) => String.fromCodePoint(ch.codePointAt(0) ^ ((k + i * 7) & 0x1f)))
    .join('');
}

export const unscramble = scramble;

export function speedPoints(at, starts, ends) {
  const span = Math.max(1, ends - starts);
  const left = Math.min(1, Math.max(0, (ends - at) / span));
  return Math.round((MIN_POINTS + (MAX_POINTS - MIN_POINTS) * left) / 10) * 10;
}

export function hintLevel(starts, ends, now, first = ends) {
  return Math.max(levelAt(starts, ends, now), levelAt(starts, Number.isFinite(first) ? first : ends, now));
}

function levelAt(starts, ends, now) {
  const span = Math.max(1, ends - starts);
  const gone = (now - starts) / span;
  if (gone >= 2 / 3) return 2;
  if (gone >= 1 / 3) return 1;
  return 0;
}

function isLetter(ch) {
  return /[\p{L}\p{N}]/u.test(ch);
}

export function pattern(answer) {
  return String(answer ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word).map((ch) => (isLetter(ch) ? '_' : ch)));
}

export function patternText(answer) {
  return pattern(answer)
    .map((w) => w.join(' '))
    .join('   ');
}

export function letterCount(answer) {
  return Array.from(String(answer ?? '')).filter(isLetter).length;
}

export function answersOf(p) {
  return p ? [p.a].concat(p.alt || []) : [];
}

function nearLimit(len) {
  if (len >= 10) return 3;
  if (len >= 5) return 2;
  return 1;
}

export function judge(guess, p) {
  if (!p) return 'miss';
  const g = plainKey(guess);
  if (!g) return 'empty';
  const answers = answersOf(p);
  if (closeEnough(guess, answers)) return 'right';
  for (const a of answers) {
    const k = plainKey(a);
    if (!k) continue;
    const lim = nearLimit(k.length);
    if (editDistance(g, k, lim) <= lim) return 'close';
  }
  const mine = new Set(g.split(' ').filter((w) => w.length >= 3));
  for (const a of answers) {
    const words = plainKey(a).split(' ').filter((w) => w.length >= 3);
    if (words.length > 1 && words.some((w) => mine.has(w))) return 'part';
  }
  return 'miss';
}

export function buildDeck(cats, count, random = Math.random) {
  const wanted = new Set(Array.isArray(cats) && cats.length ? cats : CATEGORIES.map((c) => c.id));
  let pool = PUZZLES.filter((p) => wanted.has(p.cat));
  if (!pool.length) pool = PUZZLES.slice();
  const groups = new Map();
  for (const p of shuffle(pool, random)) {
    if (!groups.has(p.cat)) groups.set(p.cat, []);
    groups.get(p.cat).push(p);
  }
  const order = shuffle(Array.from(groups.keys()), random);
  const n = Math.max(1, Math.min(count, pool.length));
  const out = [];
  while (out.length < n) {
    for (const cat of order) {
      const g = groups.get(cat);
      if (g.length && out.length < n) out.push(g.shift().n);
    }
  }
  return out;
}

export function puzzleOf(st) {
  if (!st || !Number.isInteger(st.c) || !Number.isInteger(st.k)) return null;
  return puzzleByN(unmask(st.c, st.k));
}

function ask(api, base, i, note) {
  const p = puzzleByN(unmask(base.deck[i], base.k));
  if (!p) return next(api, base, i);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.gaps = {};
  api.memory.round = i;
  api.put(KEY, {
    k: base.k,
    deck: base.deck,
    i,
    total: base.deck.length,
    phase: 'guess',
    e: p.e,
    c: base.deck[i],
    in: api.players().map((x) => x.slot),
    wait: [],
    got: [],
    a: null,
    why: null,
    note: note || null,
    starts,
    ends,
    h: ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, st, i) {
  if (i + 1 < st.deck.length) return ask(api, st, i + 1);
  return api.finish();
}

function reveal(api, why) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  const p = puzzleOf(st);
  const now = api.now();
  api.put(KEY, { ...st, phase: 'reveal', a: p ? p.a : '', why: why || 'time', starts: now, ends: now + REVEAL_MS });
  api.setDeadline(now + REVEAL_MS);
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : null;
}

function everyoneGot(api, st) {
  const playing = inPlay(st);
  const live = api.players().map((p) => p.slot).filter((s) => !playing || playing.includes(s));
  return live.length > 0 && live.every((s) => st.got.some((g) => g[0] === s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'guess') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function guessText(st, action) {
  if (typeof action.x === 'string') return unscramble(action.x.slice(0, GUESS_CHARS * 2), st.k);
  if (typeof action.text === 'string') return action.text;
  return '';
}

function guess(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  if (action.i !== undefined && action.i !== st.i) return;
  if (st.got.some((g) => g[0] === slot)) return;
  if (!api.players().some((p) => p.slot === slot)) return;
  if (inPlay(st) && !st.in.includes(slot)) {
    const admitted = admit(api, st, slot);
    if (!st.in.includes(slot)) {
      if (admitted) api.put(KEY, st);
      return;
    }
  }
  const text = cleanText(guessText(st, action), GUESS_CHARS);
  if (!plainKey(text)) return;
  const at = api.now();
  const gaps = (api.memory.gaps = api.memory.gaps || {});
  if (gaps[slot] && at - gaps[slot] < GUESS_GAP_MS) return;
  gaps[slot] = at;
  const p = puzzleOf(st);
  if (!p || judge(text, p) !== 'right') return;
  const pts = speedPoints(Math.min(at, st.ends), st.starts, st.ends);
  st.got.push([slot, pts]);
  api.addPoints(slot, pts);
  api.put(KEY, st);
  if (everyoneGot(api, st)) reveal(api, 'all');
}

const emoji = {
  id: 'emoji',
  name: 'Emoji Decode',
  emoji: '🧩',
  category: 'quiz',
  blurb: 'A row of emoji hides a movie, a saying, a place and more. Crack it first to score big.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Puzzles', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to guess', type: 'choice', options: [20, 30, 45].map((v) => ({ value: v, label: `${v} s` })), default: 30 },
    { id: 'cats', label: 'Categories', type: 'multi', options: CATEGORIES.map((c) => ({ value: c.id, label: `${c.emoji} ${c.plural}` })), default: CATEGORIES.map((c) => c.id) },
  ],

  start(api) {
    const k = 1 + Math.floor(api.random() * 65535);
    const deck = buildDeck(api.settings.cats, api.settings.rounds, api.random).map((n) => mask(n, k));
    ask(api, { k, deck }, 0);
  },

  intent(api, slot, action) {
    if (action.type === 'guess') guess(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'guess') return reveal(api, 'time');
    return next(api, st, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'guess' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'guess') reveal(api, 'skip');
      else next(api, st, st.i);
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

  resume(api) {
    const st = api.get(KEY);
    if (!st) return emoji.start(api);
    if (!puzzleOf(st) || !Array.isArray(st.deck)) return api.finish();
    api.memory.gaps = {};
    if (st.phase === 'guess') {
      if (!Array.isArray(st.got)) return reveal(api, 'host');
      if (api.now() >= st.ends) return reveal(api, 'time');
      if (api.deadline === null) api.setDeadline(st.ends);
      return emoji.roster(api);
    }
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'guess') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneGot(api, st)) reveal(api, 'all');
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const now = local.now ?? snap.now;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const playing = inPlay(st);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || (playing ? !playing.includes(mine) : false));
    const p = puzzleOf(st);
    const reveal = st.phase === 'reveal';
    const level = reveal ? 2 : hintLevel(st.starts, st.ends, now, st.h);
    const mineGot = (st.got || []).find((g) => g[0] === mine);
    const gotMe = Boolean(mineGot);
    const cat = p ? categoryById(p.cat) : null;
    const answer = reveal ? st.a || (p ? p.a : '') : gotMe && p ? p.a : null;
    return {
      phase: st.phase,
      i: st.i,
      rid: `${st.k}:${st.i}`,
      number: st.i + 1,
      total: st.total,
      emoji: st.e,
      level,
      category: level >= 1 && cat ? { name: cat.name, emoji: cat.emoji } : null,
      pattern: !reveal && level >= 2 && !gotMe && p ? pattern(p.a) : null,
      letters: p ? letterCount(p.a) : 0,
      answer,
      starts: st.starts,
      ends: st.ends,
      why: st.why || null,
      note: st.note || null,
      players: playing ? Math.max((st.got || []).length, snap.players.filter((x) => x.present && x.joined && playing.includes(x.slot)).length) : snap.players.filter((x) => x.present && x.joined).length,
      solved: (st.got || []).length,
      got: (st.got || [])
        .map(([slot, pts], idx) => {
          const who = bySlot.get(slot);
          return who ? { ...face(who, mine), slot, pts, first: idx === 0 } : null;
        })
        .filter(Boolean),
      gotMe,
      myGain: mineGot ? mineGot[1] : 0,
      waiting,
      watching,
      canGuess: st.phase === 'guess' && !waiting && !watching && !gotMe,
    };
  },
};

export default emoji;
