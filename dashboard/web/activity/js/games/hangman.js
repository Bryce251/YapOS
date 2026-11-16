import { WORDS, CATEGORIES, wordById, wordsIn, categoryById } from '../../data/hangman.js';
import { shuffle } from '../engine.js';
import { isBlockedGameWord } from '../filter.js';
import { mask, unmask } from './draw.js';
import { face } from './trivia.js';

export const KEY = 'hangman';
export const LIVES = 6;
export const WORD_COST = 2;
export const LETTER_POINTS = 10;
export const SOLVE_POINTS = 300;
export const LIFE_POINTS = 20;
export const SPEED_BONUS = Object.freeze([200, 120, 60]);
export const REVEAL_MS = 6000;
export const LATE_MIN_MS = 8000;
export const MIX = 'mix';
export const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export function cleanLetter(raw) {
  const l = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z]$/.test(l) ? l : null;
}

export function cleanGuess(raw) {
  const w = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z]/g, '') : '';
  return w.length >= 2 && w.length <= 20 ? w : null;
}

export function patternOf(word, guessed) {
  const set = new Set(String(guessed || ''));
  return Array.from(String(word)).map((ch) => (set.has(ch) ? ch : '_')).join('');
}

export function solvedPattern(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('_');
}

export function playable(cat) {
  const pool = cat && cat !== MIX && categoryById(cat) ? wordsIn(cat) : WORDS.slice();
  return pool.filter((x) => !isBlockedGameWord(x.w));
}

export function buildDeck(count, cat, random = Math.random) {
  return shuffle(playable(cat), random)
    .slice(0, Math.max(1, count))
    .map((x) => x.id);
}

export function scoreRound(word, ps) {
  const gained = {};
  const letters = new Set(word);
  for (const [slot, row] of Object.entries(ps || {})) {
    const [guessed, lives, rank] = row;
    let pts;
    if (rank > 0) pts = SOLVE_POINTS + LIFE_POINTS * Math.max(0, lives) + (SPEED_BONUS[rank - 1] || 0);
    else pts = LETTER_POINTS * Array.from(new Set(guessed)).filter((l) => letters.has(l)).length;
    if (pts) gained[slot] = pts;
  }
  return gained;
}

function fresh(len) {
  return ['', LIVES, 0, 0, '_'.repeat(len)];
}

function wordOf(st) {
  if (!st || !Array.isArray(st.deck)) return null;
  const w = wordById(unmask(st.deck[st.i], st.k));
  return w ? w.w : null;
}

function ask(api, deck, i, k) {
  const id = unmask(deck[i], k);
  const w = wordById(id);
  if (!w) return next(api, { deck, i, k });
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const ps = {};
  for (const p of api.players()) ps[p.slot] = fresh(w.w.length);
  api.put(KEY, {
    v: 1,
    n,
    k,
    deck,
    i,
    total: deck.length,
    phase: 'guess',
    cat: w.cat,
    len: w.w.length,
    ps,
    solved: 0,
    in: api.players().map((p) => p.slot),
    wait: [],
    word: null,
    gained: {},
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, st) {
  if (st.i + 1 < st.deck.length && api.players().length) return ask(api, st.deck, st.i + 1, st.k);
  return api.finish();
}

function finished(row) {
  return row[2] > 0 || row[1] <= 0;
}

function liveIn(api, st) {
  const here = new Set(api.players().map((p) => p.slot));
  return (st.in || []).filter((s) => here.has(s) && st.ps[s]);
}

function allDone(api, st) {
  const live = liveIn(api, st);
  return live.length > 0 && live.every((s) => finished(st.ps[s]));
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  const word = wordOf(st);
  if (!word) return api.finish();
  const gained = scoreRound(word, st.ps);
  for (const [slot, pts] of Object.entries(gained)) api.addPoints(Number(slot), pts);
  const ps = {};
  for (const [slot, row] of Object.entries(st.ps)) ps[slot] = [row[0], row[1], row[2], row[3], row[2] > 0 ? word : row[4]];
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', ps, word, gained, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'guess') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) {
    st.in.push(slot);
    st.ps[slot] = st.ps[slot] || fresh(st.len);
  } else {
    st.wait.push(slot);
  }
  return true;
}

function ensureIn(api, st, slot) {
  if (st.in.includes(slot) && st.ps[slot]) return true;
  if (!api.players().some((p) => p.slot === slot)) return false;
  if (admit(api, st, slot)) api.put(KEY, st);
  return st.in.includes(slot) && Boolean(st.ps[slot]);
}

function solve(api, st, slot, row, word) {
  st.solved = (st.solved || 0) + 1;
  row[2] = st.solved;
  row[3] = Math.max(0, api.now() - st.starts);
  row[4] = word;
}

function onLetter(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess' || action.n !== st.n) return;
  const l = cleanLetter(action.l);
  if (!l || !ensureIn(api, st, slot)) return;
  const row = st.ps[slot];
  if (finished(row) || row[0].includes(l)) return;
  const word = wordOf(st);
  if (!word) return;
  row[0] += l;
  if (word.includes(l)) {
    row[4] = patternOf(word, row[0]);
    if (solvedPattern(row[4])) solve(api, st, slot, row, word);
  } else {
    row[1] = Math.max(0, row[1] - 1);
  }
  api.put(KEY, st);
  if (allDone(api, st)) reveal(api);
}

function onWord(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess' || action.n !== st.n) return;
  const guess = cleanGuess(action.w);
  if (!guess || guess.length !== st.len || !ensureIn(api, st, slot)) return;
  const row = st.ps[slot];
  if (finished(row)) return;
  const word = wordOf(st);
  if (!word) return;
  if (guess === word) solve(api, st, slot, row, word);
  else row[1] = Math.max(0, row[1] - WORD_COST);
  api.put(KEY, st);
  if (allDone(api, st)) reveal(api);
}

const hangman = {
  id: 'hangman',
  name: 'Hangman Royale',
  emoji: '🪢',
  category: 'words',
  blurb: 'Everyone guesses letters for the same secret word at once. Six lives each. Solve it first to score big.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Words', type: 'choice', options: [3, 5, 7].map((v) => ({ value: v, label: String(v) })), default: 5 },
    { id: 'timer', label: 'Time per word', type: 'choice', options: [45, 60, 90].map((v) => ({ value: v, label: `${v} s` })), default: 60 },
    {
      id: 'cat',
      label: 'Topic',
      type: 'choice',
      options: [{ value: MIX, label: 'Mix' }].concat(CATEGORIES.map((c) => ({ value: c.id, label: c.name }))),
      default: MIX,
    },
  ],

  start(api) {
    const k = 1 + Math.floor(api.random() * 65534);
    const deck = buildDeck(api.settings.rounds, api.settings.cat, api.random).map((id) => mask(id, k));
    ask(api, deck, 0, k);
  },

  intent(api, slot, action) {
    if (action.type === 'letter') onLetter(api, slot, action);
    else if (action.type === 'word') onWord(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'guess') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'guess' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      hangman.deadline(api);
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
    if (!st) return hangman.start(api);
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
    if (allDone(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !st.ps) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const here = new Set(snap.players.filter((p) => p.present).map((p) => p.slot));
    const cat = categoryById(st.cat);
    const row = mine !== null && mine !== undefined ? st.ps[mine] : null;
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const playing = Boolean(row) && (st.in || []).includes(mine);
    const revealed = st.phase === 'reveal';
    const pattern = row ? row[4] : '_'.repeat(st.len);
    const guessed = row ? row[0] : '';
    const pending = local.n === st.n && typeof local.l === 'string' ? local.l : '';
    const keys = Array.from(ALPHABET).map((l) => {
      const used = guessed.includes(l);
      const hit = used && pattern.includes(l);
      return { l, state: used ? (hit ? 'hit' : 'miss') : pending.includes(l) ? 'wait' : null };
    });
    const done = row ? finished(row) : false;
    const others = Object.entries(st.ps)
      .map(([slot, r]) => [Number(slot), r])
      .filter(([slot]) => bySlot.has(slot) && (here.has(slot) || finished(r)))
      .map(([slot, r]) => ({
        face: face(bySlot.get(slot), mine),
        slot,
        found: Array.from(r[4]).filter((c) => c !== '_').length,
        lives: r[1],
        rank: r[2],
        out: r[2] === 0 && r[1] <= 0,
        gain: revealed && st.gained ? st.gained[slot] || 0 : 0,
      }))
      .sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.found - a.found || b.lives - a.lives || a.slot - b.slot);
    return {
      phase: st.phase,
      n: st.n,
      number: st.i + 1,
      total: st.total,
      cat: cat ? { name: cat.name, emoji: cat.emoji } : { name: 'Mystery', emoji: '❓' },
      len: st.len,
      starts: st.starts,
      ends: st.ends,
      pattern: Array.from(revealed && st.word ? st.word : pattern).map((c, i) => ({ c: c === '_' ? '' : c, shown: pattern[i] !== '_', i })),
      guessed,
      lives: row ? row[1] : 0,
      maxLives: LIVES,
      rank: row ? row[2] : 0,
      solved: Boolean(row && row[2] > 0),
      out: Boolean(row && row[2] === 0 && row[1] <= 0),
      canGuess: st.phase === 'guess' && playing && !done,
      waiting,
      watching: !playing && !waiting,
      keys,
      others,
      solvedCount: Object.values(st.ps).filter((r) => r[2] > 0).length,
      players: others.length,
      word: revealed ? st.word : null,
      myGain: revealed && mine !== null && st.gained ? st.gained[mine] || 0 : 0,
    };
  },
};

export default hangman;
