import { TOPICS, wordById, topicById, wordsOf } from '../../data/odd.js';
import { shuffle } from '../engine.js';
import { INK_PREFIX, MAX_CHUNKS, PIECE_CHARS, LEVELS, COLORS, GRID_W, GRID_H, FILL, inkKey, encodeParts, encodeStroke, decodeStroke, isFill, pack, inkBytes, dedupe, simplify } from './ink.js';
import { mask, unmask, nextSeat } from './draw.js';
import { person } from '../players.js';
import { timeSetting, addPts, roundOf, say, frozen, thaw, nameOf, bump, topOf, times } from './drawfun.js';

export const KEY = 'odd';
export const INTRO_MS = 5000;
export const TURN_MS = 25000;
export const VOTE_MS = 20000;
export const GUESS_MS = 15000;
export const REVEAL_MS = 7000;
export const TURN_TIMES = Object.freeze([15, 20, 25, 30, 45, 60]);
export const VOTE_POINTS = 100;
export const CREW_BONUS = 50;
export const ESCAPE_POINTS = 300;
export const STEAL_POINTS = 250;
export const CHOICES = 6;
export const PEN_SIZE = 1;
export const INK_MAX = 30000;
export const CAP_MIN = 200;
export const CAP_MAX = 3000;
export const STROKE_POINTS = 1500;
export const PARTS_MAX = 6;
export const PALETTE = Object.freeze([3, 8, 6, 9, 4, 10, 7, 11, 1, 5, 2]);
export const USED_MAX = 60;
export const FLAG_PHASES = Object.freeze(['draw', 'vote', 'guess']);

const EXTRA_EPS = [8, 12, 18, 26];

export function strokeCap(turns) {
  const n = Math.max(1, Math.floor(Number(turns) || 1));
  return Math.max(CAP_MIN, Math.min(CAP_MAX, Math.floor((INK_MAX * 0.9) / n)));
}

export function colorFor(i) {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function compact(pts) {
  let out = simplify(dedupe(Array.isArray(pts) ? pts : []), LEVELS[0]);
  while (out.length > Math.floor(STROKE_POINTS * 0.75)) out = out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
  return out;
}

export function capFor(st, used) {
  const total = Array.isArray(st.order) ? st.order.length * (st.laps || 1) : 1;
  const left = Math.max(1, total - (Array.isArray(st.marks) ? st.marks.length : 0));
  const room = Math.floor(((INK_MAX - Math.max(0, used)) * 0.9) / left);
  return Math.max(CAP_MIN, Math.min(CAP_MAX, Math.max(st.cap || 0, room)));
}

function partsLength(parts) {
  return parts.reduce((a, s) => a + s.length, 0);
}

export function fitStroke(pts, c, z, cap) {
  let clean = dedupe(Array.isArray(pts) ? pts : []);
  if (clean.length > STROKE_POINTS) clean = compact(clean);
  if (!clean.length) return null;
  for (const eps of LEVELS.concat(EXTRA_EPS)) {
    const parts = encodeParts({ c, z, pts: clean }, eps);
    if (parts.length && parts.length <= PARTS_MAX && partsLength(parts) <= cap) return parts;
  }
  let thin = clean;
  while (thin.length > 2) {
    thin = thin.filter((_, i) => i % 2 === 0 || i === thin.length - 1);
    const parts = encodeParts({ c, z, pts: thin }, EXTRA_EPS[EXTRA_EPS.length - 1]);
    if (parts.length && parts.length <= PARTS_MAX && partsLength(parts) <= cap) return parts;
  }
  const dot = encodeParts({ c, z, pts: [clean[0]] }, 0);
  return dot.length && partsLength(dot) <= cap ? dot : null;
}

export function joinParts(list) {
  if (!Array.isArray(list) || !list.length || list.length > PARTS_MAX) return null;
  const pts = [];
  for (const s of list) {
    if (typeof s !== 'string' || s.length > PIECE_CHARS) return null;
    const d = decodeStroke(s);
    if (!d || isFill(d)) return null;
    for (const p of d.pts) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (pts.length > STROKE_POINTS) return null;
  }
  return pts.length ? pts : null;
}

export function rawInk(state, k) {
  const out = [];
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    const ch = state ? state[inkKey(i)] : null;
    if (!ch || typeof ch !== 'object' || ch.k !== k || ch.i !== i || !Array.isArray(ch.s)) continue;
    for (const s of ch.s) if (typeof s === 'string') out.push(s);
  }
  return out;
}

export function wordKey(k) {
  return (k * 31 + 7) & 0xffff;
}

export function oddKey(k) {
  return (k * 13 + 101) & 0xffff;
}

export function secretWord(st) {
  if (!st || st.w === null || st.w === undefined) return null;
  return wordById(unmask(st.w, wordKey(st.k)));
}

export function secretOdd(st) {
  if (!st || st.x === null || st.x === undefined) return null;
  return unmask(st.x, oddKey(st.k));
}

export function tally(votes) {
  const counts = {};
  for (const target of Object.values(votes || {})) {
    if (!Number.isInteger(target)) continue;
    counts[target] = (counts[target] || 0) + 1;
  }
  let top = null;
  let best = 0;
  let tied = false;
  for (const [slot, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      top = Number(slot);
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  return { counts, top: tied ? null : top, best, tied };
}

export function award({ order, odd, votes, caught, stole }) {
  const out = {};
  const add = (slot, n) => {
    out[slot] = (out[slot] || 0) + n;
  };
  for (const [voter, target] of Object.entries(votes || {})) {
    const v = Number(voter);
    if (v !== odd && target === odd && order.includes(v)) add(v, VOTE_POINTS);
  }
  if (!caught) add(odd, ESCAPE_POINTS);
  else if (stole) add(odd, STEAL_POINTS);
  else for (const s of order) if (s !== odd) add(s, CREW_BONUS);
  return out;
}

export function pickOdd(slots, past, random = Math.random) {
  if (!slots.length) return null;
  const times = (s) => (past || []).filter((x) => x === s).length;
  const least = Math.min(...slots.map(times));
  const pool = slots.filter((s) => times(s) === least);
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

export function pickWord(topicSetting, used, random = Math.random) {
  const seen = new Set(used || []);
  const topics = topicSetting && topicSetting !== 'mix' && topicById(topicSetting) ? [topicById(topicSetting)] : TOPICS.slice();
  const fresh = topics.filter((t) => wordsOf(t.id).some((w) => !seen.has(w.id)));
  const from = shuffle(fresh.length ? fresh : topics, random);
  const lastTopic = (used || []).length ? (wordById(used[used.length - 1]) || {}).topic : null;
  const topic = from.find((t) => t.id !== lastTopic) || from[0];
  const words = wordsOf(topic.id);
  const left = words.filter((w) => !seen.has(w.id));
  const list = left.length ? left : words;
  return list[Math.floor(random() * list.length)] || list[0];
}

export function guessChoices(word, random = Math.random) {
  const others = shuffle(
    wordsOf(word.topic).filter((w) => w.id !== word.id),
    random,
  ).slice(0, CHOICES - 1);
  return shuffle([word].concat(others), random).map((w) => w.id);
}

export function drawingId(st, slot) {
  return `odd.${st.k}.${slot}`;
}

function hiddenOf(st) {
  return Array.isArray(st && st.hid) ? st.hid : [];
}

export function authors(st) {
  if (!st || !Array.isArray(st.marks)) return [];
  const hid = new Set(hiddenOf(st));
  const out = [];
  for (let i = st.marks.length - 1; i >= 0; i -= 1) {
    const s = st.marks[i];
    if (!Number.isInteger(s) || s < 0 || hid.has(s) || out.includes(s)) continue;
    out.unshift(s);
  }
  return out;
}

function lensFit(raw, st) {
  const lens = st.lens;
  if (!Array.isArray(lens) || !Array.isArray(st.marks) || lens.length !== st.marks.length) return false;
  return lens.reduce((a, n) => a + (Number.isInteger(n) && n > 0 ? n : 0), 0) === raw.length;
}

export function splitLines(raw, st, slot) {
  const mine = [];
  const rest = [];
  if (lensFit(raw, st)) {
    let at = 0;
    st.marks.forEach((s, i) => {
      const n = Number.isInteger(st.lens[i]) && st.lens[i] > 0 ? st.lens[i] : 0;
      (s === slot ? mine : rest).push(...raw.slice(at, at + n));
      at += n;
    });
    return { mine, rest };
  }
  const pos = st.order.indexOf(slot);
  const col = pos >= 0 ? st.cols[pos] : null;
  for (const s of raw) {
    const d = decodeStroke(s);
    (d && d.c === col ? mine : rest).push(s);
  }
  return { mine, rest };
}

function miss(st) {
  return { ...st, marks: st.marks.concat([-1]), lens: (Array.isArray(st.lens) ? st.lens : []).concat([0]) };
}

function present(api) {
  return api.players().map((p) => p.slot);
}

function inRound(api, st) {
  const live = new Set(present(api));
  return st.order.filter((s) => live.has(s));
}

function clearInk(api) {
  for (const k of api.keys()) if (k.startsWith(INK_PREFIX)) api.put(k, null);
}

function newRound(api, prev) {
  clearInk(api);
  const slots = present(api);
  const r = (prev ? prev.r : 0) + 1;
  const rounds = prev ? prev.rounds : api.settings.rounds;
  if (slots.length < 3 || r > rounds) return api.finish();
  const laps = prev ? prev.laps : api.settings.laps;
  const word = pickWord(api.settings.topic, prev ? prev.used : [], api.random);
  const past = prev ? prev.past || [] : [];
  const odd = pickOdd(slots, past, api.random);
  const order = shuffle(slots, api.random);
  if (order[0] === odd && order.length > 1) [order[0], order[1]] = [order[1], order[0]];
  const k = 1 + Math.floor(api.random() * 65534);
  const starts = api.now();
  const ends = starts + INTRO_MS;
  api.memory.round = { r, odd, word: word.id, votes: {} };
  roundOf(api, r, rounds);
  api.put(KEY, {
    v: 1,
    r,
    rounds,
    laps,
    tms: prev && Number.isInteger(prev.tms) ? prev.tms : turnMs(api),
    sx: prev && prev.sx ? prev.sx : null,
    k,
    t: word.topic,
    w: mask(word.id, wordKey(k)),
    x: mask(odd, oddKey(k)),
    order,
    cols: order.map((_, i) => colorFor(i)),
    phase: 'intro',
    lap: 1,
    pos: -1,
    turn: null,
    n: 0,
    cap: strokeCap(order.length * laps),
    marks: [],
    lens: [],
    hid: [],
    wait: [],
    voted: [],
    votes: null,
    counts: null,
    opts: [],
    odd: null,
    word: null,
    guess: null,
    caught: null,
    stole: null,
    gained: {},
    note: null,
    used: (prev ? prev.used || [] : []).slice(-USED_MAX),
    past: past.slice(-32),
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function turnMs(api) {
  const secs = Number(api.settings.turn);
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : TURN_MS;
}

function advance(api, st) {
  const hid = new Set(hiddenOf(st));
  const live = present(api).filter((s) => !hid.has(s));
  let seat = st.turn === null ? nextSeat(st.order, live, 1, 0, st.laps) : nextSeat(st.order, live, st.lap, st.pos + 1, st.laps);
  for (let guard = 0; seat && frozen(api, seat.slot) && guard <= st.order.length * (st.laps + 1); guard += 1) {
    thaw(api, seat.slot);
    say(api, 'custom', { text: `❄️ ${nameOf(api, seat.slot)} is frozen and skips a line!` });
    st = { ...miss(st), lap: seat.round, pos: seat.pos };
    seat = nextSeat(st.order, live, seat.round, seat.pos + 1, st.laps);
  }
  if (!seat) return startVote(api, st);
  const starts = api.now();
  const ends = starts + (Number.isInteger(st.tms) && st.tms > 0 ? st.tms : TURN_MS);
  api.put(KEY, { ...st, phase: 'draw', lap: seat.round, pos: seat.pos, turn: seat.slot, n: st.n + 1, note: null, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function startVote(api, st, note = null) {
  if (api.memory.round) api.memory.round.votes = {};
  else api.memory.round = { r: st.r, votes: {} };
  const starts = api.now();
  const ends = starts + VOTE_MS;
  api.put(KEY, { ...st, phase: 'vote', turn: null, voted: [], note, starts, ends });
  api.setDeadline(ends);
}

function votesOf(api, st) {
  const mem = api.memory.round;
  return mem && mem.r === st.r && mem.votes ? mem.votes : {};
}

function everyoneVoted(api, st) {
  const live = inRound(api, st);
  return live.length > 0 && live.every((s) => st.voted.includes(s));
}

function closeVote(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const votes = votesOf(api, st);
  const odd = secretOdd(st);
  const t = tally(votes);
  const caught = t.top !== null && t.top === odd;
  if (!caught) return settle(api, { ...st, votes, counts: t.counts }, { caught: false, guess: null });
  const word = secretWord(st);
  const opts = guessChoices(word, api.random).map((id) => mask(id, wordKey(st.k)));
  const starts = api.now();
  const ends = starts + GUESS_MS;
  api.put(KEY, { ...st, phase: 'guess', votes, counts: t.counts, odd, opts, caught: true, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function settle(api, st, { caught, guess, note = null }) {
  const odd = secretOdd(st);
  const word = secretWord(st);
  const votes = st.votes || {};
  const stole = Boolean(caught && word && guess === word.id);
  const gained = note ? {} : award({ order: st.order, odd, votes: Object.fromEntries(Object.entries(votes).map(([a, b]) => [Number(a), b])), caught, stole });
  if (!note && caught) noteCatchers(api, votes, odd);
  for (const [slot, pts] of Object.entries(gained)) gained[slot] = addPts(api, Number(slot), pts);
  const sx = oddStats(st);
  if (!note && Number.isInteger(odd)) {
    if (!caught) {
      sx.e = bump(sx.e, odd);
      say(api, 'custom', { text: `🕵️ ${nameOf(api, odd)} got away with it!` });
    } else if (stole) {
      sx.s = bump(sx.s, odd);
      say(api, 'steal', { slot: odd });
    } else {
      say(api, 'custom', { text: `🎯 Caught! ${nameOf(api, odd)} was faking it.` });
    }
    for (const s of catchersOf(votes, odd)) sx.c = bump(sx.c, s);
  }
  const g = guess === null || guess === undefined ? null : wordById(guess);
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.memory.round = null;
  api.put(KEY, {
    ...st,
    phase: 'reveal',
    turn: null,
    votes,
    counts: st.counts || tally(votes).counts,
    odd,
    word: word ? word.w : null,
    guess: g ? g.w : null,
    caught: Boolean(caught),
    stole,
    gained,
    sx,
    note,
    opts: [],
    used: (st.used || []).concat(word ? [word.id] : []).slice(-USED_MAX),
    past: (st.past || []).concat(Number.isInteger(odd) ? [odd] : []).slice(-32),
    starts,
    ends,
  });
  api.setDeadline(ends);
}

function oddStats(st) {
  const sx = st && st.sx && typeof st.sx === 'object' ? st.sx : {};
  return { e: sx.e || {}, s: sx.s || {}, c: sx.c || {} };
}

export function oddAwards(st) {
  const sx = oddStats(st);
  const out = [];
  const sneak = topOf(sx.e, 1);
  if (sneak) out.push({ emoji: '🎭', title: 'Master of disguise', who: sneak.slot, why: `Faked it and got away ${times(sneak.n, 'time', 'times')}` });
  const thief = topOf(sx.s, 1);
  if (thief) out.push({ emoji: '😈', title: 'Word thief', who: thief.slot, why: 'Got caught but guessed the word anyway' });
  const eye = topOf(sx.c, 2);
  if (eye) out.push({ emoji: '🔍', title: 'Sharp eye', who: eye.slot, why: `Spotted the faker ${times(eye.n, 'time', 'times')}` });
  return out;
}

export function oddHint(st, slot, random = Math.random) {
  if (!st || !['intro', 'draw', 'vote'].includes(st.phase) || !Array.isArray(st.order) || !st.order.includes(slot)) return null;
  const odd = secretOdd(st);
  if (slot === odd) {
    const w = secretWord(st);
    const first = w ? Array.from(w.w).find((ch) => /[a-z]/i.test(ch)) : null;
    return first ? `👀 The word starts with "${first.toUpperCase()}"` : null;
  }
  const safe = st.order.filter((s) => s !== slot && s !== odd);
  if (!safe.length) return null;
  return { slot: safe[Math.floor(random() * safe.length) % safe.length] };
}

export function catchersOf(votes, odd) {
  if (!Number.isInteger(odd)) return [];
  return Object.entries(votes || {})
    .filter(([voter, target]) => target === odd && Number(voter) !== odd)
    .map(([voter]) => Number(voter))
    .filter(Number.isInteger);
}

function noteCatchers(api, votes, odd) {
  const seen = new Set(Array.isArray(api.memory.caught) ? api.memory.caught : []);
  for (const s of catchersOf(votes, odd)) seen.add(s);
  api.memory.caught = [...seen];
}

function endEarly(api, st, note) {
  return settle(api, { ...st, votes: st.votes || {} }, { caught: false, guess: null, note });
}

function inkOf(api, st) {
  const ink = {};
  for (const key of api.keys()) if (key.startsWith(INK_PREFIX)) ink[key] = api.get(key);
  return rawInk(ink, st.k);
}

function writeChunks(api, chunks) {
  for (const ch of chunks) {
    const have = api.get(inkKey(ch.i));
    if (JSON.stringify(have) !== JSON.stringify(ch)) api.put(inkKey(ch.i), ch);
  }
}

function fits(chunks) {
  return Boolean(chunks && chunks.length <= MAX_CHUNKS && inkBytes(chunks) <= INK_MAX);
}

export function squeeze(raw, extra, k) {
  for (const eps of LEVELS.slice(1).concat(EXTRA_EPS)) {
    const thin = raw.map((s) => {
      const d = decodeStroke(s);
      if (!d || isFill(d)) return s;
      const parts = encodeParts(d, eps);
      return parts.length === 1 && parts[0].length <= s.length ? parts[0] : s;
    });
    const chunks = pack(thin.concat(extra), k);
    if (fits(chunks)) return chunks;
  }
  return null;
}

function place(api, st, slot, chunks, added = 0) {
  const ok = fits(chunks);
  if (ok) writeChunks(api, chunks);
  const lens = Array.isArray(st.lens) && st.lens.length === st.marks.length ? st.lens : null;
  advance(api, { ...st, marks: st.marks.concat([ok ? slot : -1]), lens: lens ? lens.concat([ok ? added : 0]) : null });
}

function hide(api, d) {
  const st = api.get(KEY);
  if (!st || !FLAG_PHASES.includes(st.phase)) return false;
  const slot = authors(st).find((s) => drawingId(st, s) === d);
  if (slot === undefined) return false;
  const { rest } = splitLines(inkOf(api, st), st, slot);
  const chunks = pack(rest, st.k);
  clearInk(api);
  writeChunks(api, chunks);
  const next = {
    ...st,
    marks: st.marks.map((s) => (s === slot ? -1 : s)),
    lens: Array.isArray(st.lens) && st.lens.length === st.marks.length ? st.lens.map((n, i) => (st.marks[i] === slot ? 0 : n)) : null,
    hid: hiddenOf(st).concat([slot]),
  };
  if (st.phase === 'draw' && st.turn === slot) advance(api, miss(next));
  else api.put(KEY, next);
  return true;
}

export function fillPoint(action) {
  const x = action ? action.x : undefined;
  const y = action ? action.y : undefined;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > GRID_W || y > GRID_H) return null;
  return [x, y];
}

function fill(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'draw' || slot !== st.turn) return;
  if (action.n !== st.n) return;
  const at = fillPoint(action);
  if (!at) return;
  const c = st.cols[st.pos] ?? colorFor(st.pos);
  const raw = inkOf(api, st);
  const extra = [encodeStroke({ c, z: FILL, pts: [at] })];
  const chunks = pack(raw.concat(extra), st.k);
  place(api, st, slot, fits(chunks) ? chunks : squeeze(raw, extra, st.k), 1);
}

function stroke(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'draw' || slot !== st.turn) return;
  if (action.n !== st.n) return;
  const pts = joinParts(action.s);
  if (!pts) return;
  const c = st.cols[st.pos] ?? colorFor(st.pos);
  const raw = inkOf(api, st);
  const used = inkBytes(pack(raw, st.k));
  let parts = fitStroke(pts, c, PEN_SIZE, capFor(st, used));
  let chunks = parts ? pack(raw.concat(parts), st.k) : null;
  if (!fits(chunks) && parts) chunks = squeeze(raw, parts, st.k);
  if (!fits(chunks)) {
    parts = fitStroke(pts, c, PEN_SIZE, CAP_MIN);
    chunks = parts ? pack(raw.concat(parts), st.k) : null;
    if (!fits(chunks) && parts) chunks = squeeze(raw, parts, st.k);
  }
  place(api, st, slot, chunks, parts ? parts.length : 0);
}

function vote(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  if (action.r !== undefined && action.r !== st.r) return;
  const target = action.target;
  if (!Number.isInteger(target) || target === slot) return;
  if (!st.order.includes(slot) || !st.order.includes(target)) return;
  if (st.voted.includes(slot)) return;
  if (!api.memory.round || api.memory.round.r !== st.r) api.memory.round = { r: st.r, votes: {} };
  api.memory.round.votes[slot] = target;
  api.put(KEY, { ...st, voted: st.voted.concat([slot]) });
  if (everyoneVoted(api, api.get(KEY))) closeVote(api);
}

function guess(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess' || slot !== secretOdd(st)) return;
  if (action.r !== undefined && action.r !== st.r) return;
  if (!Number.isInteger(action.i) || action.i < 0 || action.i >= st.opts.length) return;
  settle(api, st, { caught: true, guess: unmask(st.opts[action.i], wordKey(st.k)) });
}

function admit(st, slot) {
  if (!Number.isInteger(slot) || st.order.includes(slot) || st.wait.includes(slot)) return false;
  st.wait.push(slot);
  return true;
}

const odd = {
  id: 'odd',
  name: 'Odd One Out',
  emoji: '🕵️',
  category: 'drawing',
  blurb: 'Everyone draws the secret word one line at a time, except one player who is faking it. Spot them!',
  minPlayers: 3,
  keys: [KEY],
  prefixes: [INK_PREFIX],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [1, 2, 3, 4].map((v) => ({ value: v, label: String(v) })), default: 2 },
    { id: 'laps', label: 'Lines each', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
    timeSetting('turn', TURN_TIMES, 25, 'Drawing time'),
    {
      id: 'topic',
      label: 'Topics',
      type: 'choice',
      options: [{ value: 'mix', label: '🎲 Mixed' }].concat(TOPICS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))),
      default: 'mix',
    },
  ],

  cards: ['swap', 'double', 'freeze', 'peek'],

  canFreeze(api, target) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'intro' && st.phase !== 'draw') || !st.order.includes(target)) return false;
    if (st.phase === 'intro') return true;
    return st.lap < st.laps || st.order.indexOf(target) > st.pos;
  },

  hint(api, slot) {
    const h = oddHint(api.get(KEY), slot, api.random);
    if (!h) return null;
    return typeof h === 'string' ? h : `👀 ${nameOf(api, h.slot)} is NOT the odd one out`;
  },

  awards(api) {
    return oddAwards(api.get(KEY));
  },

  start(api) {
    newRound(api, null);
  },

  results(api) {
    const caught = Array.isArray(api.memory.caught) ? api.memory.caught.filter(Number.isInteger) : [];
    return { extra: caught.length ? { fakerCaught: caught } : {} };
  },

  intent(api, slot, action) {
    if (action.type === 'stroke') return stroke(api, slot, action);
    if (action.type === 'fill') return fill(api, slot, action);
    if (action.type === 'vote') return vote(api, slot, action);
    if (action.type === 'guess') return guess(api, slot, action);
    return undefined;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'intro' || st.phase === 'draw') return advance(api, st.phase === 'draw' ? miss(st) : st);
    if (st.phase === 'vote') return closeVote(api);
    if (st.phase === 'guess') return settle(api, st, { caught: true, guess: null });
    return newRound(api, st);
  },

  drawings(api) {
    const st = api.get(KEY);
    if (!st || !FLAG_PHASES.includes(st.phase)) return [];
    return authors(st).map((s) => ({ d: drawingId(st, s), drawer: s }));
  },

  drawingOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!st || !FLAG_PHASES.includes(st.phase)) return null;
    const list = authors(st);
    if (!list.length) return null;
    const slot = list[list.length - 1];
    const w = secretWord(st);
    return { d: drawingId(st, slot), drawer: slot, ink: splitLines(rawInk(snap.state, st.k), st, slot).mine, word: w ? w.w : null };
  },

  admin(api, action) {
    if (action.type === 'hideDrawing') return hide(api, action.d);
    const st = api.get(KEY);
    if (!st || !['intro', 'draw', 'vote', 'guess', 'reveal'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      odd.deadline(api);
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
    if (!st) return odd.start(api);
    if (st.phase === 'vote' && !api.memory.round) startVote(api, st, 'host');
    else if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return odd.roster(api);
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && st.phase !== 'reveal' && admit(st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase === 'reveal') return undefined;
    const live = present(api);
    let added = false;
    for (const s of live) if (admit(st, s)) added = true;
    if (added) api.put(KEY, st);
    const playing = inRound(api, st);
    const o = secretOdd(st);
    if (!live.includes(o)) return endEarly(api, st, 'left');
    if (playing.length < 3 && st.phase !== 'guess') return endEarly(api, st, 'few');
    if (st.phase === 'draw' && !live.includes(st.turn)) return advance(api, miss(st));
    if (st.phase === 'vote' && everyoneVoted(api, st)) return closeVote(api);
    return undefined;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      if (!p) return { slot, id: null, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false, present: false };
      const prof = person({ id: p.id, name: p.name }) || {};
      return { slot, id: p.id, name: p.name, username: p.username || prof.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || prof.avatar || null, isMe: p.isMe, present: p.present };
    };
    const reveal = st.phase === 'reveal';
    const oddSlot = reveal || st.phase === 'guess' ? st.odd : secretOdd(st);
    const w = secretWord(st);
    const topic = topicById(st.t) || { id: st.t, name: 'Mystery', emoji: '❓' };
    const playing = mine !== null && st.order.includes(mine) && snap.meJoined !== false;
    let role = 'watch';
    if (playing) role = mine === oddSlot ? 'odd' : 'crew';
    const myPos = playing ? st.order.indexOf(mine) : -1;
    const strokesBy = (slot) => st.marks.filter((s) => s === slot).length;
    const shownOdd = reveal || st.phase === 'guess' ? who(st.odd) : null;
    const hid = new Set(hiddenOf(st));
    const seats = st.order.map((slot, i) => ({
      ...who(slot),
      hidden: hid.has(slot),
      color: COLORS[st.cols[i]] || COLORS[1],
      up: st.phase === 'draw' && slot === st.turn,
      lines: strokesBy(slot),
      voted: st.phase === 'vote' && st.voted.includes(slot),
      isOdd: Boolean(shownOdd) && slot === st.odd,
    }));
    const myVote = st.votes && mine !== null && st.votes[mine] !== undefined ? st.votes[mine] : st.phase === 'vote' && local.at === st.starts && Number.isInteger(local.vote) ? local.vote : null;
    const counts = st.counts || {};
    const tallyRows = reveal || st.phase === 'guess'
      ? seats
          .map((s) => ({
            ...s,
            count: counts[s.slot] || 0,
            by: Object.entries(st.votes || {})
              .filter(([, t]) => t === s.slot)
              .map(([v]) => who(Number(v))),
          }))
          .filter((s) => s.count > 0)
          .sort((a, b) => b.count - a.count || a.slot - b.slot)
      : [];
    const choices = st.phase === 'guess' ? st.opts.map((code, i) => ({ i, word: (wordById(unmask(code, wordKey(st.k))) || { w: '?' }).w })) : [];
    const turnWho = st.phase === 'draw' && st.turn !== null ? who(st.turn) : null;
    const wait = Array.isArray(st.wait) && mine !== null && st.wait.includes(mine);
    return {
      phase: st.phase,
      r: st.r,
      rounds: st.rounds,
      lap: st.lap,
      laps: st.laps,
      n: st.n,
      k: st.k,
      cap: st.cap,
      topic: { name: topic.name, emoji: topic.emoji },
      role,
      word: role === 'crew' || reveal ? (reveal ? st.word : w ? w.w : null) : null,
      seats,
      turn: turnWho,
      myTurn: st.phase === 'draw' && playing && st.turn === mine,
      myColor: myPos >= 0 ? COLORS[st.cols[myPos]] || COLORS[1] : null,
      myColorIndex: myPos >= 0 ? st.cols[myPos] : null,
      turnNo: Math.max(0, st.marks.length + (st.phase === 'draw' ? 1 : 0)),
      turns: st.order.length * st.laps,
      turnMs: Number.isInteger(st.tms) && st.tms > 0 ? st.tms : TURN_MS,

      starts: st.starts,
      ends: st.ends,
      voteAt: st.phase === 'vote' ? st.starts : null,
      canVote: st.phase === 'vote' && playing && !st.voted.includes(mine) && myVote === null,
      myVote,
      voted: st.voted.length,
      voters: inRoundCount(snap, st),
      votedBy: st.phase === 'vote' ? st.voted.map((s) => who(s)) : [],
      odd: shownOdd,
      choices,
      canGuess: st.phase === 'guess' && role === 'odd',
      caught: st.caught,
      stole: st.stole,
      guess: st.guess,
      tally: tallyRows,
      gained: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      gains: st.gained || {},
      note: st.note,
      hiddenMine: mine !== null && hid.has(mine),
      waiting: wait || (mine !== null && !playing && snap.meJoined !== false),
    };
  },
};

function inRoundCount(snap, st) {
  const live = new Set(snap.players.filter((p) => p.present && p.slot !== null).map((p) => p.slot));
  return st.order.filter((s) => live.has(s)).length;
}

export default odd;
