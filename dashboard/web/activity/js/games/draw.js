import { WORDS, TIERS, wordById, wordsIn } from '../../data/draw.js';
import { shuffle } from '../engine.js';
import { INK_PREFIX, MAX_CHUNKS, inkKey } from './ink.js';
import { person } from '../players.js';
import { cleanShared } from '../text.js';
import { readInk } from './ink.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../limits.js';
import { DRAW_TIMES, timeSetting, addPts, roundOf, say, frozen, thaw, nameOf, heat, bump, topOf, times } from './drawfun.js';
import { TEAM_IDS, TEAM_MS, teamSetting, wantsTeams, splitTeams, placeLate, teamOf, teamWinners, teamNames, teamBoard, cleanTeams } from './teams.js';
import { PACK_STEP_MS, packSetting, packCode, packStep, packFor, drawablePackWords, hideWord, showWord } from './packs.js';

export const KEY = 'draw';
export const DRAWER_STEP = 5;
export const AUTO_START = Object.freeze({ min: 2, ms: 90000 });
export const HANDLE_MAX = 32;
export const PICK_MS = 12000;
export const REVEAL_MS = 5000;
export const GUESS_MAX = 500;
export const GUESS_MIN = 100;
export const FEED_MAX = 8;
export const GUESS_CHARS = 40;
export const USED_MAX = 150;
export const PACK_USED_MAX = 90;
export const GUESS_GAP_MS = 400;
export const TWIST_CHANCE = 0.35;
export const TWIST_LINES = 3;
export const STATS_MAX = 24;
export const REEL_MAX = 5;
export const FAST_SHARE = 0.25;
export const TWISTS = Object.freeze({
  u: Object.freeze({ id: 'u', emoji: '🚫', name: 'No undo', text: 'No undo and no clear. Every line counts!' }),
  l: Object.freeze({ id: 'l', emoji: '✏️', name: 'Only 3 lines', text: 'Only 3 lines allowed. Make them count!' }),
  b: Object.freeze({ id: 'b', emoji: '🙈', name: 'Blind canvas', text: "The drawer can't see their own drawing!" }),
});
export const TWIST_IDS = Object.freeze(Object.keys(TWISTS));

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function judge(guess, word) {
  const w = normalize(word);
  const g = normalize(guess);
  if (!g || !w) return 'miss';
  if (g === w) return 'right';
  const tokens = String(guess ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  for (let s = 0; s < tokens.length; s += 1) {
    let joined = '';
    for (let e = s; e < tokens.length && joined.length < w.length; e += 1) {
      joined += tokens[e];
      if (joined === w) return 'right';
    }
  }
  if (Math.abs(g.length - w.length) <= 1 && distance(g, w) === 1) return 'close';
  if (g.includes(w)) return 'hidden';
  return 'miss';
}

export function guessPoints(at, starts, ends) {
  const span = Math.max(1, ends - starts);
  const left = Math.min(1, Math.max(0, (ends - at) / span));
  return Math.round((GUESS_MIN + (GUESS_MAX - GUESS_MIN) * left) / 10) * 10;
}

export function drawerShare(points, guessers) {
  const list = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p) && p > 0);
  if (!list.length) return 0;
  const sum = list.reduce((a, b) => a + b, 0);
  const n = Math.max(1, list.length, Number.isFinite(guessers) ? Math.floor(guessers) : 0);
  return Math.floor(sum / n / DRAWER_STEP) * DRAWER_STEP;
}

export function drawerGain(got, guessers, already = 0) {
  return Math.max(0, drawerShare(got.map((g) => g[1]), guessers) - (already || 0));
}

export function handleOf(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/^@+/, '').replace(/[\s\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > HANDLE_MAX ? chars.slice(0, HANDLE_MAX).join('') : text;
}

export function mask(id, nonce) {
  return (id ^ nonce) & 0xffff;
}

export function unmask(code, nonce) {
  return (code ^ nonce) & 0xffff;
}

export function chooseWords(level, used, random = Math.random) {
  const seen = new Set(used || []);
  const from = (tier) => {
    const all = tier ? wordsIn(tier) : WORDS.slice();
    const fresh = all.filter((x) => !seen.has(x.id));
    return shuffle(fresh.length >= 3 ? fresh : all, random);
  };
  if (level === 'mix') {
    const out = [];
    for (const t of TIERS) {
      const pick = from(t.id).find((x) => !out.includes(x.id));
      if (pick) out.push(pick.id);
    }
    return out;
  }
  return from(TIERS.some((t) => t.id === level) ? level : null)
    .slice(0, 3)
    .map((x) => x.id);
}

export function nextSeat(order, present, round, pos, rounds) {
  const live = new Set(present);
  if (!order.length) return null;
  let r = round;
  let p = pos;
  for (let guard = 0; guard <= order.length * (rounds + 1); guard += 1) {
    if (p >= order.length) {
      r += 1;
      p = 0;
    }
    if (r > rounds) return null;
    if (live.has(order[p])) return { round: r, pos: p, slot: order[p] };
    p += 1;
  }
  return null;
}

export function hintSpots(word, nonce) {
  const spots = [];
  for (let i = 0; i < word.length; i += 1) if (/[a-z]/i.test(word[i])) spots.push(i);
  let s = (nonce >>> 0) || 1;
  for (let i = spots.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  return spots;
}

export function hintCount(word, starts, ends, now) {
  const letters = normalize(word).length;
  const left = (ends - now) / Math.max(1, ends - starts);
  let n = 0;
  if (letters >= 4 && left <= 0.5) n = 1;
  if (letters >= 6 && left <= 0.25) n = 2;
  return n;
}

export function blanks(word, shown, nonce) {
  const open = new Set(hintSpots(word, nonce).slice(0, shown));
  return Array.from(word).map((ch, i) => (ch === ' ' ? ' ' : open.has(i) ? ch : '_'));
}

export function drawingId(st) {
  return `draw.${st.nonce}.${st.n}`;
}

export function guessRef(st, id) {
  return `${drawingId(st)}.g${id}`;
}

export function reportableGuess(text, kind) {
  return kind === 'guess' && typeof text === 'string' && Boolean(text) && text !== '•••';
}

export function inkStrings(state, k) {
  const out = [];
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    const ch = state ? state[inkKey(i)] : null;
    if (!ch || typeof ch !== 'object' || ch.k !== k || ch.i !== i || !Array.isArray(ch.s)) continue;
    for (const s of ch.s) if (typeof s === 'string') out.push(s);
  }
  return out;
}

function showsInk(st) {
  return Boolean(st) && !st.hid && (st.phase === 'draw' || st.phase === 'reveal');
}

function presentSlots(api) {
  return api.players().map((p) => p.slot);
}

function clearInk(api) {
  for (const k of api.keys()) if (k.startsWith(INK_PREFIX)) api.put(k, null);
}

export function codeWord(code, nonce) {
  if (typeof code === 'string') return showWord(code, nonce);
  if (!Number.isInteger(code)) return null;
  const w = wordById(unmask(code, nonce));
  return w ? w.w : null;
}

function wordOf(st) {
  if (!st || st.w === null || st.w === undefined) return null;
  return codeWord(st.w, st.nonce);
}

export function pickPackWords(words, used, n, random = Math.random) {
  if (!Array.isArray(words) || !words.length || n <= 0) return [];
  const seen = new Set(used || []);
  const all = words.map((_, i) => i);
  const fresh = all.filter((i) => !seen.has(i));
  return shuffle(fresh.length >= n ? fresh : all, random).slice(0, n);
}

export function wordChoices(level, used, packWords, packUsed, only, random = Math.random) {
  const want = Array.isArray(packWords) && packWords.length ? Math.min(only ? 3 : 2, packWords.length) : 0;
  const picks = pickPackWords(packWords, packUsed, want, random);
  const ids = picks.length < 3 ? chooseWords(level, used, random).slice(0, 3 - picks.length) : [];
  return { ids, picks };
}

function mates(st, a, b) {
  if (!st || !st.tm) return false;
  const t = teamOf(st.tm, a);
  return Boolean(t) && t === teamOf(st.tm, b);
}

function finalPhase(api, st) {
  clearInk(api);
  const starts = api.now();
  const ends = starts + TEAM_MS;
  api.put(KEY, { ...st, phase: 'final', opts: [], starts, ends });
  api.setDeadline(ends);
}

function endGame(api, st, quick = false) {
  if (!st || !st.tm) return api.finish();
  if (quick) return api.finish(teamWinners(st.tm, api.points()).slots);
  finalPhase(api, st);
  return undefined;
}

function placeTeams(api, st) {
  if (!st || !st.tm) return false;
  const next = placeLate(st.tm, presentSlots(api), api.points());
  if (!next) return false;
  st.tm = next;
  return true;
}

function begin(api) {
  const code = packCode(api.settings);
  const step = packStep(api, code);
  if (step.state === 'wait') {
    api.setDeadline(api.now() + PACK_STEP_MS);
    return;
  }
  const pack = step.state === 'ready' ? step.pack : null;
  const words = pack ? drawablePackWords(pack.words) : [];
  api.memory.pack = pack;
  const present = presentSlots(api);
  let tm = null;
  if (wantsTeams(api.settings) && present.length >= 2) {
    const kept = typeof api.sameTeams === 'function' ? cleanTeams(api.sameTeams()) : null;
    const keep = kept ? Object.fromEntries(Object.entries(kept).filter(([s]) => present.includes(Number(s)))) : null;
    tm = keep && Object.keys(keep).length >= 2 && new Set(Object.values(keep)).size >= 2 ? placeLate(keep, present, {}) || keep : splitTeams(present, api.random);
  }
  const order = tm ? teamOrder(tm) : present;
  const pk = pack && words.length ? { c: code, n: pack.name } : null;
  const pm = step.state === 'fail' || (pack && !words.length) ? code : null;
  turn(api, { order, rounds: api.settings.rounds, used: [], n: 0, tm, pk, pm, pu: [] }, 1, 0);
}

export function teamOrder(tm) {
  const lists = TEAM_IDS.map((id) =>
    Object.keys(tm)
      .map(Number)
      .filter((s) => tm[s] === id)
      .sort((a, b) => a - b),
  );
  const out = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i += 1) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

function pushFeed(st, slot, text, kind, temp = null) {
  st.fid = (st.fid || 0) + 1;
  st.feed = (st.feed || []).concat([temp ? [st.fid, slot, text, kind, temp] : [st.fid, slot, text, kind]]).slice(-FEED_MAX);
}

function turn(api, prev, round, pos) {
  clearInk(api);
  const present = presentSlots(api);
  const order = prev.order.slice();
  for (const s of present) if (!order.includes(s)) order.push(s);
  const tm = prev.tm ? placeLate(prev.tm, present, api.points()) || prev.tm : null;
  let seat = nextSeat(order, present, round, pos, prev.rounds);
  for (let guard = 0; seat && present.length >= 2 && frozen(api, seat.slot) && guard < order.length * (prev.rounds + 1); guard += 1) {
    thaw(api, seat.slot);
    say(api, 'custom', { text: `❄️ ${nameOf(api, seat.slot)} is frozen and skips this turn!` });
    seat = nextSeat(order, present, seat.round, seat.pos + 1, prev.rounds);
  }
  if (!seat || present.length < 2) {
    if (prev.phase && tm) return endGame(api, { ...prev, tm }, present.length < 2);
    return api.finish();
  }
  const nonce = 1 + Math.floor(api.random() * 65535);
  const pack = prev.pk ? packFor(api, prev.pk.c) : null;
  const packWords = pack ? drawablePackWords(pack.words) : [];
  const { ids, picks } = wordChoices(api.settings.words, prev.used, packWords, prev.pu, Boolean(api.settings.packOnly), api.random);
  const opts = shuffle(ids.map((id) => mask(id, nonce)).concat(picks.map((i) => hideWord(packWords[i], nonce))), api.random);
  const starts = api.now();
  const ends = starts + PICK_MS;
  const tn = (prev.tn || 0) + 1;
  const tw = pickTwist(api, prev, tn);
  const iced = present.filter((x) => x !== seat.slot && frozen(api, x) && turnsAfter(order, seat, x, prev.rounds) > 0).length;
  roundOf(api, tn, tn + Math.max(0, seatsLeft(order, present, seat, prev.rounds) - iced));
  api.put(KEY, slim({
    v: 1,
    tn,
    tw,
    db: 0,
    lines: 0,
    sx: prev.sx || null,
    hl: prev.hl || [],
    rounds: prev.rounds,
    round: seat.round,
    pos: seat.pos,
    order,
    n: (prev.n || 0) + 1,
    drawer: seat.slot,
    phase: 'pick',
    nonce,
    opts,
    w: null,
    word: null,
    got: [],
    feed: [],
    fid: 0,
    gained: {},
    used: (prev.used || []).concat(ids).slice(-USED_MAX),
    pu: (prev.pu || []).concat(picks).slice(-PACK_USED_MAX),
    tm,
    pk: prev.pk || null,
    pm: prev.pm || null,
    note: null,
    starts,
    ends,
  }));
  api.setDeadline(ends);
  if (tw) say(api, 'custom', { text: `🌀 Twist round for ${nameOf(api, seat.slot)}: ${TWISTS[tw].name}!` });
  return undefined;
}

export function turnsAfter(order, seat, slot, rounds) {
  const at = order.indexOf(slot);
  if (at < 0) return 0;
  return (at > seat.pos ? 1 : 0) + Math.max(0, rounds - seat.round);
}

export function seatsLeft(order, present, seat, rounds) {
  const live = new Set(present);
  const here = order.filter((s) => live.has(s)).length;
  const rest = order.slice(seat.pos + 1).filter((s) => live.has(s)).length;
  return rest + Math.max(0, rounds - seat.round) * here;
}

function pickTwist(api, prev, tn) {
  if (api.settings.twists === false || tn < 2 || prev.tw) return null;
  if (api.random() >= TWIST_CHANCE) return null;
  return TWIST_IDS[Math.floor(api.random() * TWIST_IDS.length) % TWIST_IDS.length];
}

function inkLines(api, st) {
  const state = {};
  for (const k of api.keys()) if (k.startsWith(INK_PREFIX)) state[k] = api.get(k);
  try {
    return readInk(state, st.nonce).strokes.length;
  } catch {
    return 0;
  }
}

export function slim(st) {
  const room = MAX_VALUE_BYTES - 200;
  for (let guard = 0; guard < 400 && jsonBytes(st) > room; guard += 1) {
    const sx = stats(st);
    if (Array.isArray(st.hl) && st.hl.length) st.hl = st.hl.slice(1);
    else if (sx.d.length) st.sx = { ...sx, d: sx.d.slice(1) };
    else if (Array.isArray(st.used) && st.used.length > 30) st.used = st.used.slice(10);
    else if (Array.isArray(st.pu) && st.pu.length > 10) st.pu = st.pu.slice(10);
    else break;
  }
  return st;
}

function stats(st) {
  const sx = st.sx && typeof st.sx === 'object' ? st.sx : {};
  return { d: Array.isArray(sx.d) ? sx.d : [], f: sx.f || {}, h: sx.h || {} };
}

function noteTurn(api, st) {
  const sx = stats(st);
  const got = drawerGot(st).length;
  const row = [st.drawer, got, inkLines(api, st), guesserCount(api, st), st.tw ? 1 : 0, st.n];
  st.sx = { ...sx, d: sx.d.concat([row]).slice(-STATS_MAX) };
  const pick = st.hx;
  if (pick && Array.isArray(pick) && typeof pick[1] === 'string') {
    const word = wordOf(st);
    if (word) {
      const list = (st.hl || []).slice();
      const item = [pick[0], pick[1], word, st.n];
      if (list.length < REEL_MAX) list.push(item);
      else list[Math.floor(api.random() * REEL_MAX) % REEL_MAX] = item;
      st.hl = list;
    }
  }
  st.hx = null;
}

export function drawAwards(st) {
  const out = [];
  if (!st) return out;
  const sx = stats(st);
  const won = sx.d.filter((r) => Array.isArray(r) && r[1] > 0 && r[2] > 0);
  if (won.length >= 2) {
    const worst = won.slice().sort((a, b) => a[2] - b[2] || b[1] - a[1])[0];
    out.push({ emoji: '🖍️', title: 'Worst drawing that still won', who: worst[0], why: `${times(worst[2], 'line', 'lines')} and ${times(worst[1], 'person', 'people')} still got it` });
  }
  const full = {};
  for (const r of sx.d) if (Array.isArray(r) && r[3] >= 2 && r[1] >= r[3]) full[r[0]] = (full[r[0]] || 0) + 1;
  const art = topOf(full, 1);
  if (art) out.push({ emoji: '🖼️', title: 'Masterpiece', who: art.slot, why: art.n > 1 ? `Everyone guessed ${times(art.n, 'drawing', 'drawings')}` : 'Everyone guessed their drawing' });
  const twist = sx.d.filter((r) => Array.isArray(r) && r[4] && r[1] > 0);
  if (twist.length) {
    const best = twist.slice().sort((a, b) => b[1] - a[1])[0];
    out.push({ emoji: '🌀', title: 'Twist survivor', who: best[0], why: 'Got their drawing guessed in a twist round' });
  }
  const fast = topOf(sx.f, 2);
  if (fast) out.push({ emoji: '⚡', title: 'Quickest eyes', who: fast.slot, why: `First to guess ${times(fast.n, 'time', 'times')}` });
  const hot = topOf(sx.h, 2);
  if (hot) out.push({ emoji: '😬', title: 'Most dramatic guesser', who: hot.slot, why: `${times(hot.n, 'red-hot miss', 'red-hot misses')}` });
  return out;
}

export function drawHighlights(st) {
  if (!st || !Array.isArray(st.hl)) return [];
  return st.hl
    .filter((x) => Array.isArray(x) && Number.isInteger(x[0]) && typeof x[1] === 'string' && typeof x[2] === 'string')
    .map(([slot, text, word]) => ({ who: slot, text: `Guessed "${text}" for ${word}` }));
}

export function peekText(word, st, now) {
  const spots = hintSpots(word, st.nonce);
  const open = new Set(spots.slice(0, hintCount(word, st.starts, st.ends, now)));
  const first = Array.from(word).findIndex((ch) => /[a-z]/i.test(ch));
  if (first >= 0 && !open.has(first)) return `👀 It starts with "${word[first].toUpperCase()}"`;
  const next = spots.find((i) => !open.has(i));
  if (next === undefined || open.size + 1 >= spots.length) return null;
  return `👀 Letter ${next + 1} is "${word[next].toUpperCase()}"`;
}

function choose(api, st, i) {
  const code = st.opts[i];
  if (code === undefined) return;
  const starts = api.now();
  const ends = starts + api.settings.time * 1000;
  api.put(KEY, { ...st, phase: 'draw', w: code, opts: [], starts, ends });
  api.setDeadline(ends);
}

function reveal(api, note) {
  const st = api.get(KEY);
  if (!st || (st.phase !== 'draw' && st.phase !== 'pick')) return;
  if (st.phase === 'pick') {
    turn(api, st, st.round, st.pos + 1);
    return;
  }
  const ends = api.now() + REVEAL_MS;
  if (!st.hid) noteTurn(api, st);
  else st.hx = null;
  api.put(KEY, slim({ ...st, phase: 'reveal', word: wordOf(st), note: note || null, starts: api.now(), ends }));
  api.setDeadline(ends);
}

function hide(api, d) {
  const st = api.get(KEY);
  if (!showsInk(st) || d !== drawingId(st)) return false;
  clearInk(api);
  const had = (st.gained && st.gained[st.drawer]) || 0;
  if (had) api.addPoints(st.drawer, -had);
  const sx = stats(st);
  const next = {
    ...st,
    hid: 1,
    hx: null,
    db: 0,
    sx: { ...sx, d: sx.d.filter((r) => !Array.isArray(r) || r[5] !== st.n) },
    hl: (st.hl || []).filter((x) => !Array.isArray(x) || x[3] !== st.n),
    gained: { ...(st.gained || {}), [st.drawer]: 0 },
  };
  if (st.phase === 'draw') {
    api.put(KEY, next);
    reveal(api, 'hidden');
  } else {
    api.put(KEY, { ...next, note: 'hidden' });
  }
  return true;
}

function everyoneGot(api, st) {
  const guessers = presentSlots(api).filter((s) => s !== st.drawer);
  return guessers.length > 0 && guessers.every((s) => st.got.some((g) => g[0] === s));
}

function guesserCount(api, st) {
  const all = new Set(presentSlots(api).filter((s) => s !== st.drawer && !mates(st, s, st.drawer)));
  for (const g of st.got) if (!mates(st, g[0], st.drawer)) all.add(g[0]);
  return all.size;
}

function drawerGot(st) {
  return st.got.filter((g) => !mates(st, g[0], st.drawer));
}

function guess(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'draw' || slot === st.drawer) return;
  if (st.got.some((g) => g[0] === slot)) return;
  const raw = typeof action.text === 'string' ? action.text.replace(/\s+/g, ' ').trim() : '';
  if (!raw || raw.length > GUESS_CHARS || !normalize(raw)) return;
  const at = api.now();
  const gaps = (api.memory.gaps = api.memory.gaps || {});
  if (gaps[slot] && at - gaps[slot] < GUESS_GAP_MS) return;
  gaps[slot] = at;
  const word = wordOf(st);
  if (!word) return;
  const verdict = judge(raw, word);
  if (verdict === 'right') {
    const pts = guessPoints(Math.min(at, st.ends), st.starts, st.ends);
    const first = !st.got.length;
    const base = Number.isInteger(st.db) ? st.db : (st.gained && st.gained[st.drawer]) || 0;
    st.got.push([slot, pts]);
    const extra = mates(st, slot, st.drawer) ? 0 : drawerGain(drawerGot(st), guesserCount(api, st), base);
    const mine = addPts(api, slot, pts);
    const theirs = extra ? addPts(api, st.drawer, extra) : 0;
    st.got[st.got.length - 1] = [slot, pts, mine];
    st.db = base + extra;
    st.gained = { ...st.gained, [slot]: mine, [st.drawer]: ((st.gained && st.gained[st.drawer]) || 0) + theirs };
    pushFeed(st, slot, '', 'ok');
    if (first) {
      const sx = stats(st);
      st.sx = { ...sx, f: bump(sx.f, slot) };
      if (at - st.starts <= (st.ends - st.starts) * FAST_SHARE) say(api, 'fast', { slot });
    }
  } else {
    const shown = verdict === 'hidden' ? '•••' : cleanShared(raw, GUESS_CHARS) || '•••';
    const temp = verdict === 'hidden' || shown === '•••' ? null : verdict === 'close' ? 'h' : heat(raw, word);
    pushFeed(st, slot, shown, verdict === 'close' ? 'close' : 'guess', temp);
    if (temp === 'h') {
      const sx = stats(st);
      st.sx = { ...sx, h: bump(sx.h, slot) };
      const hot = (api.memory.hot = api.memory.hot && api.memory.hot.n === st.n ? api.memory.hot : { n: st.n, s: [] });
      if (!hot.s.includes(slot)) {
        hot.s.push(slot);
        say(api, verdict === 'close' ? 'close' : 'hot', { slot });
      }
    } else if (temp === 'c' && api.memory.cold !== st.n && api.random() < 0.15) {
      api.memory.cold = st.n;
      say(api, 'cold', { slot });
    }
    if (temp && temp !== 'h' && verdict === 'miss') st.hx = [slot, shown];
  }
  api.put(KEY, slim(st));
  if (verdict === 'right' && everyoneGot(api, st)) reveal(api, 'all');
}

const draw = {
  id: 'draw',
  name: 'Draw & Guess',
  category: 'drawing',
  emoji: '🎨',
  blurb: 'Take turns drawing a secret word. Guess fast to score big.',
  minPlayers: 2,
  autoStart: { min: AUTO_START.min, ms: AUTO_START.ms },
  keys: [KEY],
  prefixes: [INK_PREFIX],
  open: [INK_PREFIX],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 1 },
    timeSetting('time', DRAW_TIMES, 90),
    {
      id: 'words',
      label: 'Words',
      type: 'choice',
      options: [{ value: 'mix', label: '🎲 Mixed' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))),
      default: 'mix',
    },
    teamSetting(),
    packSetting(),
    { id: 'packOnly', label: 'Pack words only', type: 'toggle', default: false },
    { id: 'twists', label: '🌀 Twist rounds', type: 'toggle', default: true, fun: true },
  ],

  cards: ['swap', 'double', 'freeze', 'peek'],

  canFreeze(api, target) {
    const st = api.get(KEY);
    if (!st || st.phase === 'final' || !Array.isArray(st.order)) return false;
    const pos = st.order.indexOf(target);
    if (pos < 0) return false;
    return st.round < st.rounds || pos > st.pos;
  },

  hint(api, slot) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'draw' || slot === st.drawer || st.got.some((g) => g[0] === slot)) return null;
    const word = wordOf(st);
    return word ? peekText(word, st, api.now()) : null;
  },

  awards(api) {
    return drawAwards(api.get(KEY));
  },

  highlights(api) {
    return drawHighlights(api.get(KEY));
  },

  writer(get, key, slot, value) {
    if (!key.startsWith(INK_PREFIX)) return false;
    const st = get(KEY);
    if (!st || !Number.isInteger(slot) || slot !== st.drawer) return false;
    if (value === null) return true;
    return !st.hid && Boolean(value && typeof value === 'object' && value.k === st.nonce);
  },

  start(api) {
    begin(api);
  },

  results(api) {
    const st = api.get(KEY);
    return st && st.tm ? { teams: teamNames(st.tm), tm: { ...st.tm } } : {};
  },

  intent(api, slot, action) {
    if (action.type === 'guess') return guess(api, slot, action);
    if (action.type === 'pick') {
      const st = api.get(KEY);
      if (!st || st.phase !== 'pick' || slot !== st.drawer) return undefined;
      if (action.n !== undefined && action.n !== st.n) return undefined;
      if (!Number.isInteger(action.i) || action.i < 0 || action.i >= st.opts.length) return undefined;
      return choose(api, st, action.i);
    }
    return undefined;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return begin(api);
    if (st.phase === 'final') return api.finish(teamWinners(st.tm, api.points()).slots);
    if (st.phase === 'pick') return choose(api, st, Math.floor(api.random() * st.opts.length));
    if (st.phase === 'draw') return reveal(api, 'time');
    return turn(api, st, st.round, st.pos + 1);
  },

  drawings(api) {
    const st = api.get(KEY);
    return showsInk(st) ? [{ d: drawingId(st), drawer: st.drawer }] : [];
  },

  texts(api) {
    const st = api.get(KEY);
    if (!st || !Array.isArray(st.feed)) return [];
    const word = wordOf(st);
    return st.feed
      .filter((f) => Array.isArray(f) && reportableGuess(f[2], f[3]))
      .map(([id, slot, text]) => ({ r: guessRef(st, id), author: slot, text, context: word ? `Word to draw: ${word}` : null }));
  },

  replays: true,

  hiddenDrawings(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    return st && st.hid && Number.isInteger(st.nonce) ? [drawingId(st)] : [];
  },

  drawingOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!showsInk(st)) return null;
    return { d: drawingId(st), drawer: st.drawer, ink: inkStrings(snap.state, st.nonce), word: wordOf(st) };
  },

  admin(api, action) {
    if (action.type === 'hideDrawing') return hide(api, action.d);
    const st = api.get(KEY);
    if (!st || (st.phase !== 'pick' && st.phase !== 'draw' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'reveal') turn(api, st, st.round, st.pos + 1);
      else reveal(api, 'skip');
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
    if (!st || !Number.isInteger(slot)) return undefined;
    if (!Array.isArray(st.order)) return undefined;
    const placed = placeTeams(api, st);
    if (st.order.includes(slot)) {
      if (placed) api.put(KEY, st);
      return undefined;
    }
    api.put(KEY, { ...st, order: st.order.concat([slot]) });
    return undefined;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return draw.start(api);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    draw.roster(api);
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase === 'final') return;
    if (placeTeams(api, st)) api.put(KEY, st);
    if (st.phase === 'reveal') return;
    const present = presentSlots(api);
    if (present.length < 2) return endGame(api, st, true);
    if (!present.includes(st.drawer)) return reveal(api, 'left');
    if (st.phase === 'draw' && everyoneGot(api, st)) return reveal(api, 'all');
    return undefined;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const now = local.now ?? snap.now;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const who = (slot) => {
      const p = bySlot.get(slot);
      if (!p) return { slot, id: null, name: 'Player', username: null, initials: 'P', hue: 20, avatar: null, isMe: false };
      const prof = person({ id: p.id, name: p.name }) || {};
      return { slot, id: p.id, name: p.name, username: handleOf(p.username || prof.username || null), initials: p.initials, hue: p.hue, avatar: p.avatar || prof.avatar || null, isMe: p.isMe };
    };
    const amDrawer = mine !== null && mine === st.drawer;
    const playing = mine !== null && snap.meJoined !== false;
    const secret = wordOf(st);
    const shown = st.phase === 'reveal' ? st.word || secret : null;
    let word = null;
    if (amDrawer || st.phase === 'reveal') word = shown || secret;
    let hint = null;
    if (st.phase === 'draw' && secret && !amDrawer) {
      const gotIt = st.got.some((g) => g[0] === mine);
      hint = gotIt ? Array.from(secret) : blanks(secret, hintCount(secret, st.starts, st.ends, now), st.nonce);
    }
    const choices =
      amDrawer && st.phase === 'pick'
        ? st.opts.map((code, i) => {
            if (typeof code === 'string') {
              const w = showWord(code, st.nonce);
              return w ? { i, word: w, tier: 'pack' } : null;
            }
            const w = wordById(unmask(code, st.nonce));
            return w ? { i, word: w.w, tier: w.tier } : null;
          }).filter(Boolean)
        : [];
    const gotMe = st.got.find((g) => g[0] === mine);
    const teams = st.tm ? teamBoard(st.tm, snap.players, snap.scores, mine) : null;
    const myTeam = st.tm ? teamOf(st.tm, mine) : null;
    return {
      teams,
      myTeam,
      drawerTeam: st.tm ? teamOf(st.tm, st.drawer) : null,
      mate: !amDrawer && Boolean(myTeam) && myTeam === (st.tm ? teamOf(st.tm, st.drawer) : null),
      pack: st.pk ? { code: st.pk.c, name: st.pk.n } : null,
      packMiss: st.pm || null,
      phase: st.phase,
      n: st.n,
      round: st.round,
      rounds: st.rounds,
      k: st.nonce,
      drawer: who(st.drawer),
      amDrawer,
      choices,
      word,
      hint,
      letters: secret ? normalize(secret).length : 0,
      words: secret ? secret.trim().split(/\s+/).length : 0,
      starts: st.starts,
      ends: st.ends,
      got: st.got.map(([slot, pts, real]) => ({ ...who(slot), pts: Number.isFinite(real) ? real : pts })),
      gotMe: Boolean(gotMe),
      myPts: gotMe ? (Number.isFinite(gotMe[2]) ? gotMe[2] : gotMe[1]) : 0,
      canGuess: st.phase === 'draw' && !amDrawer && playing && !gotMe,
      feed: (st.feed || []).map(([id, slot, text, kind, temp]) => ({ id, ...who(slot), fid: id, text: (kind === 'close' || temp === 'h') && slot !== mine ? '' : text, kind, heat: temp === 'h' || temp === 'w' || temp === 'c' ? temp : null, mine: slot === mine })),
      twist: st.tw && TWISTS[st.tw] && st.phase !== 'final' ? { ...TWISTS[st.tw] } : null,
      lineCap: st.tw === 'l' ? TWIST_LINES : null,
      gained: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      drawerGain: st.gained ? st.gained[st.drawer] || 0 : 0,
      note: st.note,
      hidden: Boolean(st.hid),
      drawing: showsInk(st) ? drawingId(st) : null,
      spectator: !playing && !amDrawer,
    };
  },
};

export default draw;
