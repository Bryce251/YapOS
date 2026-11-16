import { SEEDS as HIVE_SEEDS, WORDS as HIVE_WORDS } from '../data/hive.js';
import { WORDS as SCRAMBLE_WORDS } from '../data/scramble.js';
import { isBlockedGameWord } from './filter.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HIVE_MIN_LETTERS = 4;
export const HIVE_MAX_LETTERS = 30;
export const HIVE_MIN_WORDS = 20;
export const HIVE_MAX_WORDS = 150;
export const HIVE_PANGRAM_BONUS = 7;
export const HIVE_TRIES = 80;
export const SCRAMBLE_ROUNDS = 5;
export const SCRAMBLE_POINTS = 100;
export const SCRAMBLE_PLAN = Object.freeze([
  Object.freeze({ min: 4, max: 5 }),
  Object.freeze({ min: 4, max: 5 }),
  Object.freeze({ min: 6, max: 7 }),
  Object.freeze({ min: 6, max: 7 }),
  Object.freeze({ min: 8, max: 9 }),
]);
export const SHUFFLE_TRIES = 80;
export const DAY_MS = 24 * 60 * 60 * 1000;

const A = 97;
const indexes = new Map();

export function dayKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 10);
}

export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && dayKey(t) === value;
}

export function shiftDay(date, days) {
  return dayKey(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

export function nextReset(t = Date.now()) {
  return Date.parse(`${dayKey(t)}T00:00:00Z`) + DAY_MS;
}

export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function seededRandom(seed) {
  let a = (typeof seed === 'number' ? seed : hashText(seed)) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function answerHash(date, index, word) {
  return hashText(`${date}:${index}:${String(word || '').toLowerCase()}`).toString(16).padStart(8, '0');
}

export function cleanAnswer(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 24);
}

export function checkAnswer(date, index, guess, hash) {
  const g = cleanAnswer(guess);
  return Boolean(g) && answerHash(date, index, g) === hash;
}

export function maskOf(word) {
  const w = String(word ?? '');
  let m = 0;
  for (let i = 0; i < w.length; i += 1) {
    const c = w.charCodeAt(i) - A;
    if (c < 0 || c > 25) return -1;
    m |= 1 << c;
  }
  return m;
}

export function lettersOf(word) {
  return [...new Set(String(word ?? '').toLowerCase().replace(/[^a-z]/g, ''))].sort().join('');
}

export function isPangram(word, letters) {
  const m = maskOf(word);
  return m > 0 && m === maskOf(Array.isArray(letters) ? letters.join('') : letters);
}

export function hivePoints(word, letters) {
  const w = String(word ?? '');
  if (w.length < HIVE_MIN_LETTERS) return 0;
  const base = w.length === HIVE_MIN_LETTERS ? 1 : w.length;
  return base + (letters && isPangram(w, letters) ? HIVE_PANGRAM_BONUS : 0);
}

function indexOf(words) {
  let list = indexes.get(words);
  if (!list) {
    list = [];
    for (const w of words) {
      if (typeof w !== 'string' || w.length < HIVE_MIN_LETTERS || w.length > HIVE_MAX_LETTERS) continue;
      const m = maskOf(w);
      if (m > 0) list.push([w, m]);
    }
    indexes.set(words, list);
    if (indexes.size > 4) indexes.delete(indexes.keys().next().value);
  }
  return list;
}

function hivePool(letters, centre, words) {
  const full = maskOf(letters);
  const mid = 1 << (centre.charCodeAt(0) - A);
  const out = [];
  for (const [w, m] of indexOf(words)) {
    if ((m & full) === m && (m & mid)) out.push(w);
  }
  return out;
}

function pickHive(date, seeds, words) {
  const random = seededRandom(`hive:${date}`);
  const usable = seeds.map((s) => lettersOf(s)).filter((l) => l.length === 7);
  if (!usable.length) return null;
  let best = null;
  let bestGap = Infinity;
  for (let t = 0; t < HIVE_TRIES; t += 1) {
    const letters = usable[Math.floor(random() * usable.length) % usable.length];
    for (const centre of shuffled(letters.split(''), random)) {
      const pool = hivePool(letters, centre, words).filter((w) => !isBlockedGameWord(w));
      if (!pool.some((w) => isPangram(w, letters))) continue;
      const n = pool.length;
      const gap = n < HIVE_MIN_WORDS ? HIVE_MIN_WORDS - n : n > HIVE_MAX_WORDS ? n - HIVE_MAX_WORDS : 0;
      if (!gap) return { letters, centre };
      if (gap < bestGap) {
        best = { letters, centre };
        bestGap = gap;
      }
    }
  }
  return best || { letters: usable[0], centre: usable[0][0] };
}

function scrambleLetters(word, random) {
  const letters = word.split('');
  if (new Set(letters).size < 2) return word;
  let fallback = null;
  for (let i = 0; i < SHUFFLE_TRIES; i += 1) {
    const s = shuffled(letters, random).join('');
    if (s === word || isBlockedGameWord(s)) continue;
    if (fallback === null) fallback = s;
    let same = 0;
    for (let k = 0; k < s.length; k += 1) if (s[k] === word[k]) same += 1;
    if (s[0] !== word[0] && same <= Math.floor(word.length / 3)) return s;
  }
  return fallback || letters.slice(1).concat(letters[0]).join('');
}

export function dailyScrambleWords(date, words = SCRAMBLE_WORDS) {
  const random = seededRandom(`scramble:${date}`);
  const clean = [...new Set(words.filter((w) => typeof w === 'string' && /^[a-z]+$/.test(w) && !isBlockedGameWord(w)))];
  const taken = new Set();
  const out = [];
  for (const tier of SCRAMBLE_PLAN) {
    let pool = clean.filter((w) => w.length >= tier.min && w.length <= tier.max && !taken.has(w));
    if (!pool.length) pool = clean.filter((w) => !taken.has(w));
    if (!pool.length) break;
    const w = pool[Math.floor(random() * pool.length) % pool.length];
    taken.add(w);
    out.push(w);
  }
  return out;
}

export function dailyPuzzle(date, opts = {}) {
  if (!isDateKey(date)) throw new Error('bad date');
  const seeds = Array.isArray(opts.hiveSeeds) && opts.hiveSeeds.length ? opts.hiveSeeds : HIVE_SEEDS;
  const words = Array.isArray(opts.hiveWords) && opts.hiveWords.length ? opts.hiveWords : HIVE_WORDS;
  const scrambleWords = Array.isArray(opts.scrambleWords) && opts.scrambleWords.length ? opts.scrambleWords : SCRAMBLE_WORDS;
  const hive = pickHive(date, seeds, words);
  const random = seededRandom(`scramble-letters:${date}`);
  const rounds = dailyScrambleWords(date, scrambleWords).map((w, i) => ({
    letters: scrambleLetters(w, random),
    length: w.length,
    answerHash: answerHash(date, i, w),
  }));
  return {
    date,
    hive: { letters: hive.letters.split(''), centre: hive.centre },
    scramble: { rounds },
  };
}

export function hiveAnswers(puzzle, opts = {}) {
  const hive = puzzle && puzzle.hive;
  if (!hive || !Array.isArray(hive.letters) || hive.letters.length !== 7 || typeof hive.centre !== 'string') return [];
  const words = Array.isArray(opts.hiveWords) && opts.hiveWords.length ? opts.hiveWords : HIVE_WORDS;
  const isWord = typeof opts.isWord === 'function' ? opts.isWord : null;
  return hivePool(hive.letters.join(''), hive.centre, words)
    .filter((w) => !isBlockedGameWord(w) && (!isWord || isWord(w)))
    .sort();
}

export function scoreHive(list, puzzle, opts = {}) {
  const answers = opts.answers instanceof Set ? opts.answers : new Set(hiveAnswers(puzzle, opts));
  const letters = puzzle.hive.letters;
  const seen = new Set();
  const words = [];
  let score = 0;
  let pangrams = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const w = raw.trim().toLowerCase();
    if (!w || seen.has(w) || !answers.has(w)) continue;
    seen.add(w);
    words.push(w);
    score += hivePoints(w, letters);
    if (isPangram(w, letters)) pangrams += 1;
  }
  return { score, words: words.sort(), found: words.length, pangrams };
}

export function hiveMax(puzzle, opts = {}) {
  const answers = opts.answers ? [...opts.answers] : hiveAnswers(puzzle, opts);
  return answers.reduce((sum, w) => sum + hivePoints(w, puzzle.hive.letters), 0);
}

export function scoreScramble(list, puzzle, opts = {}) {
  const words = Array.isArray(opts.words) ? opts.words : dailyScrambleWords(puzzle.date, opts.scrambleWords);
  const answers = Array.isArray(list) ? list.slice(0, words.length) : [];
  let correct = 0;
  const right = words.map((w, i) => {
    const ok = cleanAnswer(answers[i]) === w;
    if (ok) correct += 1;
    return ok;
  });
  return { score: correct * SCRAMBLE_POINTS, correct, right, total: words.length };
}
