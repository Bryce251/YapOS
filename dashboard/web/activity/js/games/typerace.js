import { SENTENCES, WORDS } from '../../data/typerace.js';
import { shuffle } from '../engine.js';
import { mask, unmask } from './draw.js';
import { face } from './trivia.js';
import { award, roundAt, say, streak, missRest, bump, prize, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'typerace';
export const LEAD_MS = 3000;
export const SHOW_MS = 6000;
export const LATE_MIN_MS = 10000;
export const MAX_CPS = 22;
export const SKEW_SLACK = 1500;
export const PROG_SLACK = 4;
export const MAX_ERRORS = 999;
export const TEXT_MAX = 140;
export const WORD_COUNT = 12;
export const PLACE_POINTS = Object.freeze([300, 240, 200, 170, 150, 135, 120, 110]);
export const FLOOR_POINTS = 100;
export const ACC_POINTS = 100;
export const PART_POINTS = 80;
export const CLOSE_MS = 400;
export const FLAGGED = -1;
export const IDLE_AFTER_MS = 10000;
export const IDLE_CALL_MS = 5000;

export function cleanTyped(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

export function minMsFor(text) {
  return Math.ceil((String(text || '').length / MAX_CPS) * 1000);
}

export function wpmOf(len, ms) {
  if (!(len > 0) || !(ms > 0)) return 0;
  return Math.round(len / 5 / (ms / 60000));
}

export function accuracyOf(len, errors) {
  const e = Math.max(0, Math.floor(Number(errors) || 0));
  if (!(len > 0)) return 0;
  return Math.round((100 * len) / (len + e));
}

export function correctPrefix(text, typed) {
  const a = String(text || '');
  const b = String(typed || '');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

export function placePoints(place) {
  return place >= 1 && place <= PLACE_POINTS.length ? PLACE_POINTS[place - 1] : FLOOR_POINTS;
}

export function scoreRow(row, len) {
  const [c, place, , e] = row;
  if (place === FLAGGED) return 0;
  if (place > 0) return placePoints(place) + Math.round(ACC_POINTS * (accuracyOf(len, e) / 100) ** 2);
  return len > 0 ? Math.round((PART_POINTS * Math.min(c, len)) / len) : 0;
}

function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function textFor(kind, id) {
  if (kind === 'words') {
    let text = shuffle(WORDS, seededRandom(id)).slice(0, WORD_COUNT).join(' ');
    while (text.length > TEXT_MAX) text = text.slice(0, text.lastIndexOf(' '));
    return text;
  }
  return SENTENCES[id] || null;
}

export function buildDeck(count, kind, random = Math.random) {
  const n = Math.max(1, count);
  if (kind === 'words') return Array.from({ length: n }, () => 1 + Math.floor(random() * 65000));
  const ids = shuffle(SENTENCES.map((s, i) => i).filter((i) => SENTENCES[i].length <= TEXT_MAX), random);
  return Array.from({ length: n }, (x, i) => ids[i % ids.length]);
}

function fresh() {
  return [0, 0, 0, 0];
}

function race(api, i, deck, k, kind) {
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const text = textFor(kind, unmask(deck[i], k));
  if (!text) return api.finish();
  const go = api.now() + LEAD_MS;
  const ends = go + api.settings.timer * 1000;
  const here = api.players().map((p) => p.slot);
  const ps = {};
  for (const s of here) ps[s] = fresh();
  roundAt(api, i + 1, deck.length);
  api.put(KEY, {
    v: 1,
    n,
    i,
    total: deck.length,
    deck,
    k,
    kind,
    text,
    phase: 'race',
    ps,
    in: here,
    wait: [],
    fin: 0,
    best: prev && prev.best ? prev.best : {},
    gained: {},
    starts: api.now(),
    go,
    ends,
  });
  api.setDeadline(ends);
}

function next(api, st) {
  if (st.i + 1 < st.total && api.players().length) return race(api, st.i + 1, st.deck, st.k, st.kind);
  return api.finish();
}

function liveIn(api, st) {
  const here = new Set(api.players().map((p) => p.slot));
  return (st.in || []).filter((s) => here.has(s) && st.ps[s]);
}

function allDone(api, st) {
  const live = liveIn(api, st);
  return live.length > 0 && live.every((s) => st.ps[s][1] !== 0);
}

export function onlyIdleLeft(api, st) {
  const live = liveIn(api, st);
  const left = live.filter((s) => st.ps[s][1] === 0);
  return left.length > 0 && left.length < live.length && left.every((s) => st.ps[s][0] === 0);
}

function lastCall(api, st) {
  if (!onlyIdleLeft(api, st)) return;
  const ends = Math.max(api.now(), st.go + IDLE_AFTER_MS) + IDLE_CALL_MS;
  if (ends >= st.ends) return;
  st.ends = ends;
  api.put(KEY, st);
  api.setDeadline(ends);
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'race') return;
  const len = st.text.length;
  const gained = {};
  const best = { ...(st.best || {}) };
  const winners = [];
  for (const [k, row] of Object.entries(st.ps)) {
    const slot = Number(k);
    const pts = scoreRow(row, len);
    if (pts) gained[slot] = award(api, slot, pts);
    if (row[1] > 0) {
      const wpm = wpmOf(len, row[2]);
      if (!(slot in best) || wpm > best[slot]) best[slot] = wpm;
      if (row[1] === 1) winners.push(slot);
      if (row[1] === 1) keep(api, `${nameOf(api, slot)} won round ${st.i + 1} at ${wpm} WPM`, slot, 2 + wpm / 50);
      if (accuracyOf(len, row[3]) === 100) bump(api, 'clean', slot);
    }
  }
  for (const s of winners) {
    bump(api, 'first', s);
    streak(api, s, true);
  }
  missRest(api, winners);
  const now = api.now();
  api.put(KEY, { ...st, phase: 'show', gained, best, starts: now, ends: now + SHOW_MS });
  api.setDeadline(now + SHOW_MS);
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'race') return false;
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) {
    st.in.push(slot);
    st.ps[slot] = st.ps[slot] || fresh();
  } else st.wait.push(slot);
  return true;
}

function ensureIn(api, st, slot) {
  if (st.in.includes(slot) && st.ps[slot]) return true;
  if (!api.players().some((p) => p.slot === slot)) return false;
  if (admit(api, st, slot)) api.put(KEY, st);
  return st.in.includes(slot) && Boolean(st.ps[slot]);
}

function onProgress(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'race' || action.n !== st.n || !ensureIn(api, st, slot)) return;
  const row = st.ps[slot];
  if (row[1] !== 0) return;
  const len = st.text.length;
  const since = Math.max(0, api.now() - st.go);
  const cap = Math.min(len - 1, Math.floor((since / 1000) * MAX_CPS) + PROG_SLACK);
  const c = Math.max(0, Math.min(cap, Math.floor(Number(action.c) || 0)));
  if (c === row[0]) return;
  row[0] = c;
  api.put(KEY, st);
}

function onDone(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'race' || action.n !== st.n || !ensureIn(api, st, slot)) return;
  const row = st.ps[slot];
  if (row[1] !== 0) return;
  const text = st.text;
  if (cleanTyped(action.t) !== text) return;
  const since = api.now() - st.go;
  const ms = Math.round(Number(action.ms));
  if (!Number.isFinite(ms) || ms > since + SKEW_SLACK) return;
  const took = Math.max(ms, since - SKEW_SLACK);
  if (took < minMsFor(text)) {
    row[1] = FLAGGED;
    api.put(KEY, st);
    say(api, 'custom', { text: `🤖 ${nameOf(api, slot)} typed faster than humanly possible, so that round doesn't count` });
    if (allDone(api, st)) reveal(api);
    return;
  }
  st.fin = (st.fin || 0) + 1;
  row[0] = text.length;
  row[1] = st.fin;
  row[2] = took;
  row[3] = Math.max(0, Math.min(MAX_ERRORS, Math.floor(Number(action.e) || 0)));
  if (row[1] === 1) say(api, 'fast', { slot });
  else if (row[1] === 2) {
    const first = Object.values(st.ps).find((r) => r[1] === 1);
    if (first && took - first[2] <= CLOSE_MS) say(api, 'close', { slot });
  }
  api.put(KEY, st);
  if (allDone(api, st)) reveal(api);
  else lastCall(api, st);
}

function topBest(best) {
  let top = null;
  for (const [k, v] of Object.entries(best || {})) {
    const s = Number(k);
    if (!Number.isInteger(s) || !(v > 0)) continue;
    if (!top || v > top.n || (v === top.n && s < top.slot)) top = { slot: s, n: v };
  }
  return top;
}

const typerace = {
  id: 'typerace',
  name: 'Typing Race',
  emoji: '⌨️',
  category: 'quick',
  blurb: 'Everyone gets the same sentence. Type it fast and clean. First to finish scores the most.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double'],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [3, 5, 7].map((v) => ({ value: v, label: String(v) })), default: 5 },
    { id: 'timer', label: 'Time per round', type: 'choice', options: [30, 45, 60].map((v) => ({ value: v, label: `${v} s` })), default: 45 },
    {
      id: 'kind',
      label: 'Text',
      type: 'choice',
      options: [
        { value: 'sentences', label: 'Sentences' },
        { value: 'words', label: 'Word lists' },
      ],
      default: 'sentences',
    },
  ],

  start(api) {
    const kind = api.settings.kind === 'words' ? 'words' : 'sentences';
    const k = 1 + Math.floor(api.random() * 65534);
    const deck = buildDeck(api.settings.rounds, kind, api.random).map((id) => mask(id, k));
    race(api, 0, deck, k, kind);
  },

  intent(api, slot, action) {
    if (!action) return;
    if (action.type === 'prog') onProgress(api, slot, action);
    else if (action.type === 'done') onDone(api, slot, action);
  },

  results(api) {
    const st = api.get(KEY);
    const top = st ? topBest(st.best) : null;
    return top ? { note: `⌨️ Top speed: ${top.n} WPM by ${nameOf(api, top.slot)}` } : {};
  },

  awards(api) {
    funMem(api);
    const st = api.get(KEY);
    const top = st ? topBest(st.best) : null;
    return list(
      top ? { emoji: '🏎️', title: 'Speed demon', who: top.slot, why: `Top speed: ${top.n} WPM` } : null,
      prize(api, 'first', 'Photo finish', '🏁', (n) => (n === 1 ? 'Won a round' : `Won ${n} rounds`), 2),
      prize(api, 'clean', 'Sharpshooter', '🎯', (n) => (n === 1 ? 'Typed a round without a single slip' : `Typed ${n} rounds without a single slip`)),
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'race') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'race' && st.phase !== 'show')) return false;
    if (action.type === 'skip') {
      typerace.deadline(api);
      return true;
    }
    if (action.type === 'time') {
      const ends = Math.max(api.shift(st.ends, action.ms), st.phase === 'race' ? st.go + 5000 : api.now());
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return typerace.start(api);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'race') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (allDone(api, st)) reveal(api);
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st || !st.ps || typeof st.text !== 'string') return null;
    const mine = snap.meSlot;
    const len = st.text.length;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const here = new Set(snap.players.filter((p) => p.present).map((p) => p.slot));
    const row = mine !== null && mine !== undefined ? st.ps[mine] : null;
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const playing = Boolean(row) && (st.in || []).includes(mine);
    const shown = st.phase === 'show';
    const racers = Object.entries(st.ps)
      .map(([k, r]) => [Number(k), r])
      .filter(([slot, r]) => bySlot.has(slot) && (here.has(slot) || r[1] > 0))
      .map(([slot, r]) => ({
        face: face(bySlot.get(slot), mine),
        slot,
        share: len ? Math.min(1, r[0] / len) : 0,
        place: r[1] > 0 ? r[1] : 0,
        flagged: r[1] === FLAGGED,
        wpm: r[1] > 0 ? wpmOf(len, r[2]) : 0,
        acc: r[1] > 0 ? accuracyOf(len, r[3]) : 0,
        gain: shown && st.gained ? st.gained[slot] || 0 : 0,
      }))
      .sort((a, b) => (a.place || 99) - (b.place || 99) || b.share - a.share || a.slot - b.slot);
    const me = racers.find((x) => x.slot === mine) || null;
    return {
      n: st.n,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      text: st.text,
      kind: st.kind === 'words' ? 'words' : 'sentences',
      starts: st.starts,
      go: st.go,
      ends: st.ends,
      waiting,
      watching: !playing && !waiting,
      canType: st.phase === 'race' && playing && row[1] === 0,
      done: Boolean(row && row[1] !== 0),
      place: row && row[1] > 0 ? row[1] : 0,
      flagged: Boolean(row && row[1] === FLAGGED),
      wpm: me ? me.wpm : 0,
      acc: me ? me.acc : 0,
      myGain: me ? me.gain : 0,
      racers,
      finished: racers.filter((x) => x.place > 0).length,
      best: Object.keys(st.best || {}).length && mine !== null && st.best[mine] ? st.best[mine] : 0,
    };
  },
};

export default typerace;
