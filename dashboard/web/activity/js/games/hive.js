import { SEEDS, WORDS } from '../../data/hive.js';
import { ready as dictReady, failed as dictFailed, loading as dictLoading, isWord, load as loadDictionary } from '../dictionary.js';
import { face } from './trivia.js';

export const KEY = 'hive';
export const MISS_KEY = 'hive.miss';
export const REVEAL_PREFIX = 'hive.r.';
export const MIN_LETTERS = 4;
export const MAX_LETTERS = 30;
export const MIN_WORDS = 20;
export const MAX_WORDS = 150;
export const PANGRAM_BONUS = 7;
export const PICK_TRIES = 120;
export const LOAD_STEP_MS = 500;
export const LOAD_MAX_MS = 20000;
export const FAIL_MS = 6000;
export const REVEAL_MS = 20000;
export const RES_KEEP = 3;
export const REVEAL_WORDS = 40;
export const REVEAL_CHUNK_BYTES = 3800;
export const REVEAL_CHUNKS = 8;
export const MISS_SHOW = 18;
export const SYNC_MS = 400;
export const SLICE_MS = 30;
export const WARM_RETRY_MS = 15000;

const A = 97;

let indexed = null;
let indexing = null;
let warmedAt = -Infinity;
let timers = null;
const pools = new Map();

function later(fn, ms) {
  return timers ? timers.setTimeout(fn, ms) : setTimeout(fn, ms);
}

function cancel(handle) {
  if (handle === null || handle === undefined) return;
  if (timers) timers.clearTimeout(handle);
  else clearTimeout(handle);
}

function clockNow() {
  return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function useTimers(t) {
  timers = t && typeof t.setTimeout === 'function' && typeof t.clearTimeout === 'function' ? t : null;
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

function spin(id, i) {
  const n = Number.isFinite(id) ? Math.abs(Math.floor(id)) : 0;
  return (Math.floor(n / 26 ** (i % 5)) + i * 7 + 3) % 26;
}

export function veil(word, id) {
  const w = String(word ?? '');
  let out = '';
  for (let i = 0; i < w.length; i += 1) {
    const c = w.charCodeAt(i) - A;
    out += c >= 0 && c < 26 ? String.fromCharCode(A + ((c + spin(id, i)) % 26)) : w[i];
  }
  return out;
}

export function unveil(code, id) {
  const w = String(code ?? '');
  let out = '';
  for (let i = 0; i < w.length; i += 1) {
    const c = w.charCodeAt(i) - A;
    out += c >= 0 && c < 26 ? String.fromCharCode(A + ((c - spin(id, i) + 26) % 26)) : w[i];
  }
  return out;
}

export function loadWords(fetcher) {
  return loadDictionary(fetcher);
}

export function wordsReady() {
  return dictReady;
}

export function wordsFailed() {
  return dictFailed && !dictReady && !dictLoading();
}

export function indexReady() {
  return indexed !== null;
}

export function buildIndex(slice = SLICE_MS) {
  if (indexed) return Promise.resolve(true);
  if (indexing) return indexing;
  const out = [];
  let i = 0;
  indexing = new Promise((resolve) => {
    const step = () => {
      if (indexed) {
        indexing = null;
        resolve(true);
        return;
      }
      const until = clockNow() + slice;
      while (i < WORDS.length) {
        const w = WORDS[i];
        i += 1;
        if (w.length >= MIN_LETTERS) out.push([w, maskOf(w)]);
        if ((i & 255) === 0 && clockNow() >= until) break;
      }
      if (i < WORDS.length) {
        later(step, 0);
        return;
      }
      indexed = out;
      indexing = null;
      resolve(true);
    };
    step();
  });
  return indexing;
}

export function warm() {
  buildIndex();
  if (dictReady || dictLoading()) return;
  const at = clockNow();
  if (dictFailed && at - warmedAt < WARM_RETRY_MS) return;
  warmedAt = at;
  loadDictionary();
}

function pool(letters) {
  if (!indexed) indexed = WORDS.filter((w) => w.length >= MIN_LETTERS).map((w) => [w, maskOf(w)]);
  let list = pools.get(letters);
  if (!list) {
    const full = maskOf(letters);
    list = full > 0 ? indexed.filter(([, m]) => m > 0 && (m & full) === m).map(([w]) => w) : [];
    pools.set(letters, list);
    if (pools.size > 32) pools.delete(pools.keys().next().value);
  }
  return list;
}

export function candidates(letters, centre) {
  if (typeof letters !== 'string' || letters.length !== 7 || lettersOf(letters) !== letters || !letters.includes(centre)) return null;
  return pool(letters).filter((w) => w.includes(centre));
}

function verified(list, letters, centre) {
  if (!dictReady || !list) return [];
  const full = maskOf(letters);
  return list.filter((w) => w.length >= MIN_LETTERS && w.includes(centre) && (maskOf(w) & full) === maskOf(w) && isWord(w)).sort();
}

export function hiveWords(letters, centre) {
  return verified(candidates(letters, centre), letters, centre);
}

export function knownWord(word, letters, centre) {
  const list = candidates(letters, centre);
  if (!list) return null;
  const w = String(word ?? '');
  if (!list.includes(w)) return false;
  return dictReady ? isWord(w) : true;
}

export function lettersOf(word) {
  return [...new Set(String(word ?? '').toLowerCase().replace(/[^a-z]/g, ''))].sort().join('');
}

export function isPangram(word, letters) {
  const m = maskOf(word);
  return m > 0 && m === maskOf(letters);
}

export function wordPoints(word, letters) {
  const w = String(word ?? '');
  if (w.length < MIN_LETTERS) return 0;
  const base = w.length === MIN_LETTERS ? 1 : w.length;
  return base + (letters && isPangram(w, letters) ? PANGRAM_BONUS : 0);
}

export function byValue(letters) {
  return (a, b) => wordPoints(b, letters) - wordPoints(a, letters) || (a < b ? -1 : a > b ? 1 : 0);
}

function* search(random, opts = {}) {
  const seeds = opts.seeds || SEEDS;
  const min = opts.min ?? MIN_WORDS;
  const max = opts.max ?? MAX_WORDS;
  const tries = opts.tries ?? PICK_TRIES;
  if (!dictReady || !seeds.length) return null;
  let best = null;
  let bestGap = Infinity;
  for (let t = 0; t < tries; t += 1) {
    const seed = seeds[Math.floor(random() * seeds.length) % seeds.length];
    const letters = lettersOf(seed);
    if (letters.length !== 7) continue;
    const list = opts.words ? opts.words.filter((w) => (maskOf(w) & maskOf(letters)) === maskOf(w)) : pool(letters);
    const order = letters.split('');
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1)) % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const centre of order) {
      const words = verified(list, letters, centre);
      const gap = words.length < min ? min - words.length : words.length > max ? words.length - max : 0;
      if (!words.some((w) => isPangram(w, letters))) continue;
      const pick = { seed, letters, centre, words };
      if (!gap) return pick;
      if (gap < bestGap) {
        best = pick;
        bestGap = gap;
      }
    }
    yield t;
  }
  return best;
}

export function pickPuzzle(random = Math.random, opts = {}) {
  const it = search(random, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

export function puzzleJob(random = Math.random, opts = {}) {
  const it = search(random, opts);
  const clock = opts.clock || clockNow;
  let result = null;
  let done = false;
  return {
    bg: false,
    get done() {
      return done;
    },
    get pick() {
      return result;
    },
    run(ms = SLICE_MS) {
      if (done) return true;
      const until = clock() + ms;
      for (;;) {
        const r = it.next();
        if (r.done) {
          done = true;
          result = r.value;
          return true;
        }
        if (clock() >= until) return false;
      }
    },
  };
}

export function cleanWord(text) {
  return String(text ?? '').trim().toLowerCase();
}

export function checkWord(text, puzzle, found, opts = {}) {
  const w = cleanWord(text);
  if (!w) return 'empty';
  if (!/^[a-z]+$/.test(w)) return 'letters';
  if (w.length < MIN_LETTERS) return 'short';
  if (w.length > MAX_LETTERS) return 'long';
  const full = maskOf(puzzle.letters);
  const m = maskOf(w);
  if ((m & full) !== m) return 'outside';
  if (!w.includes(puzzle.centre)) return 'centre';
  if (found && (Array.isArray(found) ? found.includes(w) : found.has(w))) return 'found';
  if (opts.answers) {
    if (!opts.answers.has(w)) return 'unknown';
  } else if (opts.dictionary !== false && knownWord(w, puzzle.letters, puzzle.centre) === false) return 'unknown';
  return null;
}

export function problemText(code, centre) {
  const mid = centre ? centre.toUpperCase() : 'middle';
  switch (code) {
    case 'empty':
      return 'Tap or type some letters first.';
    case 'letters':
      return 'Letters only, please.';
    case 'short':
      return `Too short. Words need ${MIN_LETTERS} or more letters.`;
    case 'long':
      return 'That word is too long.';
    case 'outside':
      return "That uses a letter that isn't in the hive.";
    case 'centre':
      return `Missing the middle letter. Every word needs ${mid}.`;
    case 'found':
      return 'You already found that one.';
    case 'unknown':
      return "That's not in this hive's word list.";
    case 'late':
      return "Time's up, so that one didn't count.";
    default:
      return "That word doesn't work.";
  }
}

export const RANKS = Object.freeze([
  { at: 0, name: 'Just landed' },
  { at: 0.02, name: 'Warming up' },
  { at: 0.06, name: 'Buzzing' },
  { at: 0.12, name: 'Busy bee' },
  { at: 0.2, name: 'Honey maker' },
  { at: 0.32, name: 'Hive hero' },
  { at: 0.5, name: 'Queen bee' },
]);

export function rankOf(pts, max) {
  const ratio = max > 0 ? Math.max(0, pts) / max : 0;
  let i = 0;
  for (let k = 0; k < RANKS.length; k += 1) if (ratio >= RANKS[k].at) i = k;
  const next = RANKS[i + 1] || null;
  return {
    step: i,
    name: RANKS[i].name,
    next: next ? next.name : null,
    need: next ? Math.max(1, Math.ceil(next.at * max) - pts) : 0,
    pct: Math.min(100, Math.round((ratio / RANKS[RANKS.length - 1].at) * 100)),
  };
}

export function packReveal(entries, opts = {}) {
  const limit = opts.bytes ?? REVEAL_CHUNK_BYTES;
  const most = opts.chunks ?? REVEAL_CHUNKS;
  const size = (v) => JSON.stringify(v).length;
  let cap = opts.words ?? REVEAL_WORDS;
  for (;;) {
    const chunks = [];
    let cur = [];
    let ok = true;
    for (const [slot, words] of entries) {
      const shown = words.slice(0, cap);
      const row = [slot, shown, words.length - shown.length];
      if (size({ p: cur.concat([row]) }) > limit) {
        if (!cur.length) {
          ok = false;
          break;
        }
        chunks.push({ p: cur });
        cur = [row];
      } else cur.push(row);
    }
    if (ok && cur.length) chunks.push({ p: cur });
    if (ok && chunks.length <= most) return chunks;
    if (cap <= 0) return chunks.slice(0, most);
    cap = cap > 10 ? cap - 5 : cap - 1;
  }
}

function present(api) {
  return api.players().map((p) => p.slot);
}

function boardWith(st, slots) {
  const b = { ...(st.b || {}) };
  let added = false;
  for (const s of slots) {
    if (!Number.isInteger(s) || b[s]) continue;
    b[s] = [0, 0, 0];
    added = true;
  }
  return added ? b : null;
}

function current(api) {
  const shared = api.get(KEY);
  const cur = api.memory.cur;
  if (cur && cur.st && shared && shared.phase === 'play' && shared.id === cur.id && cur.st.phase === 'play') return cur.st;
  return shared;
}

function pay(api, cur) {
  if (!cur || !cur.owed) return;
  const owed = cur.owed;
  cur.owed = {};
  for (const [slot, pts] of Object.entries(owed)) if (pts) api.addPoints(Number(slot), pts);
}

function settle(api) {
  const cur = api.memory.cur;
  if (!cur) return;
  cancel(cur.timer);
  cur.timer = null;
  pay(api, cur);
  cur.dirty = false;
}

function commit(api, st) {
  const cur = api.memory.cur;
  if (cur && st && st.phase === 'play' && st.id === cur.id) {
    cur.st = st;
    cur.at = api.now();
  }
  settle(api);
  api.put(KEY, st);
}

function flushSoon(api, cur) {
  cur.timer = null;
  if (api.memory.cur !== cur || !cur.dirty) return;
  const shared = api.get(KEY);
  if (!shared || shared.phase !== 'play' || shared.id !== cur.id) {
    cur.dirty = false;
    return;
  }
  commit(api, cur.st);
}

function soon(api, st) {
  const cur = api.memory.cur;
  if (!cur || cur.id !== st.id) {
    api.put(KEY, st);
    return;
  }
  cur.st = st;
  cur.dirty = true;
  const wait = SYNC_MS - (api.now() - cur.at);
  if (wait <= 0) {
    commit(api, st);
    return;
  }
  if (cur.timer === null || cur.timer === undefined) cur.timer = later(() => flushSoon(api, cur), wait);
}

function begin(api, puzzle, note) {
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const id = Math.floor(api.random() * 1e9);
  const words = puzzle.words.slice();
  const max = words.reduce((a, w) => a + wordPoints(w, puzzle.letters), 0);
  const pg = words.filter((w) => isPangram(w, puzzle.letters)).length;
  const b = {};
  for (const s of present(api)) b[s] = [0, 0, 0];
  const st = { v: 1, phase: 'play', id, l: puzzle.letters, c: puzzle.centre, total: words.length, max, pg, b, r: {}, last: null, note: note || null, starts, ends };
  api.memory.job = null;
  api.memory.cur = { id, answers: new Set(words), all: words, found: {}, st, at: -Infinity, dirty: false, timer: null, owed: {} };
  commit(api, st);
  api.setDeadline(ends);
}

function failNow(api, st) {
  const ends = api.now() + FAIL_MS;
  api.memory.job = null;
  api.put(KEY, { ...(st || { v: 1, b: {} }), phase: 'fail', starts: api.now(), ends });
  api.setDeadline(ends);
}

function background(api, job) {
  if (job.bg) return;
  job.bg = true;
  const mem = api.memory;
  const step = () => {
    if (mem.job !== job || job.done) return;
    if (!job.run(SLICE_MS)) later(step, 0);
  };
  later(step, 0);
}

function tryBuild(api, st) {
  if (wordsReady()) {
    let job = api.memory.job;
    if (!job) {
      job = puzzleJob(api.random);
      api.memory.job = job;
    }
    if (!job.run(SLICE_MS)) {
      background(api, job);
      return false;
    }
    api.memory.job = null;
    if (job.pick) begin(api, job.pick, st && st.note);
    else failNow(api, st);
    return true;
  }
  if (wordsFailed()) {
    failNow(api, st);
    return true;
  }
  return false;
}

function waitForWords(api, st) {
  const now = api.now();
  const since = st && typeof st.since === 'number' ? st.since : now;
  if (now - since >= LOAD_MAX_MS) return failNow(api, st);
  const next = { v: 1, phase: 'load', b: (st && st.b) || {}, since, note: (st && st.note) || null, starts: since, ends: since + LOAD_MAX_MS };
  if (!st || st.phase !== 'load' || st.since !== since) api.put(KEY, next);
  api.setDeadline(now + LOAD_STEP_MS);
  return undefined;
}

function sortedFound(list, letters) {
  return list.slice().sort(byValue(letters));
}

function reveal(api, note) {
  const st = current(api);
  if (!st || st.phase !== 'play') return;
  let cur = api.memory.cur;
  const lost = !cur || cur.id !== st.id;
  if (lost) {
    const all = wordsReady() ? hiveWords(st.l, st.c) : [];
    cur = { id: st.id, answers: new Set(all), all, found: {} };
  } else settle(api);
  const entries = Object.keys(st.b || {})
    .map(Number)
    .sort((a, b) => (st.b[b][0] || 0) - (st.b[a][0] || 0) || a - b)
    .map((s) => [s, sortedFound(cur.found[s] || [], st.l)]);
  const chunks = lost ? [] : packReveal(entries);
  for (const k of api.keys()) if (k.startsWith(REVEAL_PREFIX)) api.put(k, null);
  chunks.forEach((c, i) => api.put(`${REVEAL_PREFIX}${i}`, c));
  const seen = new Set();
  for (const list of Object.values(cur.found)) for (const w of list) seen.add(w);
  const missed = cur.all.filter((w) => !seen.has(w)).sort(byValue(st.l));
  api.put(MISS_KEY, { w: missed.slice(0, MISS_SHOW), n: missed.length });
  api.memory.cur = null;
  const now = api.now();
  const ends = now + REVEAL_MS;
  api.put(KEY, { ...st, r: {}, phase: 'reveal', chunks: chunks.length, lost, note: note || (lost ? 'host' : null), starts: now, ends });
  api.setDeadline(ends);
}

function tell(st, slot, entry) {
  const res = st.r && typeof st.r === 'object' ? st.r : {};
  const list = Array.isArray(res[slot]) ? res[slot] : [];
  st.r = { ...res, [slot]: list.concat([entry]).slice(-RES_KEEP) };
}

function play(api, slot, action) {
  const cur = api.memory.cur;
  const st = current(api);
  if (!st || st.phase !== 'play' || action.id !== st.id) return;
  if (!cur || cur.id !== st.id) return;
  const q = Number.isInteger(action.q) && action.q >= 0 && action.q < 1e9 ? action.q : 0;
  const word = cleanWord(typeof action.x === 'string' ? unveil(action.x.slice(0, MAX_LETTERS + 4), st.id) : '');
  if (api.now() > st.ends) {
    tell(st, slot, [q, 'late', 0]);
    soon(api, st);
    return;
  }
  const mine = cur.found[slot] || (cur.found[slot] = []);
  const problem = checkWord(word, { letters: st.l, centre: st.c }, mine, { answers: cur.answers });
  if (problem) {
    if (problem === 'empty') return;
    tell(st, slot, [q, problem, 0]);
    soon(api, st);
    return;
  }
  const pts = wordPoints(word, st.l);
  const pangram = isPangram(word, st.l);
  mine.push(word);
  const row = (st.b && st.b[slot]) || [0, 0, 0];
  st.b = { ...(st.b || {}), [slot]: [row[0] + pts, row[1] + 1, row[2] + (pangram ? 1 : 0)] };
  if (pangram) st.last = { s: slot, n: ((st.last && st.last.n) || 0) + 1 };
  tell(st, slot, [q, 'ok', pts]);
  cur.owed[slot] = (cur.owed[slot] || 0) + pts;
  soon(api, st);
  const live = present(api);
  if (live.length && live.every((s) => (cur.found[s] || []).length >= cur.all.length)) reveal(api, 'all');
}

const SETTINGS = Object.freeze([
  Object.freeze({ id: 'timer', label: 'Time', type: 'choice', options: [90, 120, 180].map((v) => ({ value: v, label: v % 60 ? `${v} s` : `${v / 60} min` })), default: 120 }),
]);

const hive = {
  id: 'hive',
  name: 'Letter Hive',
  emoji: '🐝',
  category: 'words',
  blurb: 'Make words from seven letters in a honeycomb. Every word needs the middle letter.',
  minPlayers: 1,
  keys: [KEY, MISS_KEY],
  prefixes: [REVEAL_PREFIX],

  get settings() {
    warm();
    return SETTINGS;
  },

  prepare() {
    warm();
  },

  start(api) {
    buildIndex();
    loadWords();
    if (!tryBuild(api, null)) waitForWords(api, null);
  },

  intent(api, slot, action) {
    if (action.type === 'word') play(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'load') {
      if (!tryBuild(api, st)) waitForWords(api, st);
      return undefined;
    }
    if (st.phase === 'play') return reveal(api);
    return api.finish();
  },

  admin(api, action) {
    const st = current(api);
    if (!st) return false;
    if (action.type === 'skip') {
      if (st.phase === 'play') reveal(api, 'skip');
      else api.finish();
      return true;
    }
    if (action.type === 'time') {
      if (st.phase !== 'play' && st.phase !== 'reveal') return false;
      const ends = api.shift(st.ends, action.ms);
      if (st.phase === 'play') commit(api, { ...st, ends });
      else api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    buildIndex();
    loadWords();
    const st = api.get(KEY);
    if (!st) return hive.start(api);
    if (st.phase === 'load') {
      if (!tryBuild(api, st)) waitForWords(api, st);
      return undefined;
    }
    if (st.phase === 'play') return reveal(api, 'host');
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = current(api);
    if (!st || (st.phase !== 'play' && st.phase !== 'load')) return;
    const b = boardWith(st, [slot]);
    if (!b) return;
    if (st.phase === 'play') commit(api, { ...st, b });
    else api.put(KEY, { ...st, b });
  },

  roster(api) {
    const st = current(api);
    if (!st || st.phase !== 'play') return;
    const b = boardWith(st, present(api));
    if (b) commit(api, { ...st, b });
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st) return null;
    const b = st.b || {};
    const mine = snap.meSlot !== null && snap.meSlot !== undefined && b[snap.meSlot] && snap.meJoined !== false ? snap.meSlot : null;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      return p ? { slot, ...face(p, mine), present: p.present !== false } : { slot, id: null, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false, present: false };
    };
    const board = Object.keys(b)
      .map(Number)
      .map((s) => ({ ...who(s), pts: b[s][0] || 0, count: b[s][1] || 0, pangrams: b[s][2] || 0 }))
      .sort((x, y) => y.pts - x.pts || y.count - x.count || x.slot - y.slot);
    const meRow = mine !== null && b[mine] ? b[mine] : [0, 0, 0];
    const letters = st.l || '';
    const centre = st.c || '';
    const res = st.r;
    const out = {
      phase: st.phase,
      id: st.id ?? null,
      letters,
      centre,
      outer: letters.replace(centre, '').split('').filter(Boolean),
      total: st.total || 0,
      max: st.max || 0,
      pg: st.pg || 0,
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      board,
      me: { pts: meRow[0], count: meRow[1], pangrams: meRow[2] },
      rank: rankOf(meRow[0], st.max || 0),
      playing: mine !== null,
      canPlay: st.phase === 'play' && mine !== null,
      results: mine !== null && res && Array.isArray(res[mine]) ? res[mine].map(([q, code, pts]) => ({ q, code, pts })) : [],
      last: st.last ? { n: st.last.n, ...who(st.last.s) } : null,
      reveal: null,
    };
    if (st.phase === 'reveal') {
      const rows = [];
      for (let i = 0; i < (st.chunks || 0); i += 1) {
        const c = snap.state[`${REVEAL_PREFIX}${i}`];
        if (c && Array.isArray(c.p)) rows.push(...c.p);
      }
      const tally = new Map();
      for (const [, words] of rows) for (const w of words) tally.set(w, (tally.get(w) || 0) + 1);
      const shape = (w) => ({ w, pts: wordPoints(w, letters), pangram: isPangram(w, letters), only: tally.get(w) === 1 && rows.length > 1 });
      const players = rows.map(([s, words, more]) => {
        const row = b[s] || [0, 0, 0];
        return { ...who(s), pts: row[0], count: row[1], pangrams: row[2], words: words.map(shape), more: more || 0 };
      });
      const miss = snap.state[MISS_KEY] || { w: [], n: 0 };
      out.reveal = {
        lost: Boolean(st.lost),
        players,
        missed: (miss.w || []).map((w) => ({ w, pts: wordPoints(w, letters), pangram: isPangram(w, letters) })),
        missedCount: miss.n || 0,
        pangramBy: board.filter((p) => p.pangrams > 0),
      };
    }
    return out;
  },
};

export default hive;
