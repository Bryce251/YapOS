import { ITEMS, KINDS, itemById, showValue } from '../../data/higherlower.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';

export const KEY = 'higherlower';
export const REVEAL_MS = 4500;
export const BASE_POINTS = 100;
export const STREAK_STEP = 25;
export const STREAK_CAP = 8;
export const LATE_MIN_MS = 3000;

export function pointsFor(streak) {
  const s = Math.max(1, Math.floor(streak) || 1);
  return BASE_POINTS + STREAK_STEP * Math.min(STREAK_CAP, s - 1);
}

export function fairPair(a, b) {
  if (!a || !b || a.id === b.id || a.kind !== b.kind || a.value === b.value) return false;
  const k = KINDS[a.kind];
  const hi = Math.max(a.value, b.value);
  const lo = Math.min(a.value, b.value);
  if (a.kind === 'year') return hi !== lo;
  return lo > 0 && hi / lo >= (k ? k.gap : 1.1);
}

export function buildDeck(count, random = Math.random) {
  const n = Math.max(1, Math.floor(count) || 1);
  const used = new Set();
  const kinds = Object.keys(KINDS);
  const byKind = new Map(kinds.map((k) => [k, ITEMS.filter((x) => x.kind === k)]));
  const out = [];
  let order = shuffle(kinds, random);
  let guard = 0;
  while (out.length < n && guard < n * 40) {
    guard += 1;
    if (!order.length) order = shuffle(kinds, random);
    const kind = order.shift();
    const pool = shuffle(byKind.get(kind).filter((x) => !used.has(x.id)), random);
    let pair = null;
    for (let i = 0; i < pool.length && !pair; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        if (fairPair(pool[i], pool[j])) {
          pair = [pool[i], pool[j]];
          break;
        }
      }
    }
    if (!pair) continue;
    used.add(pair[0].id);
    used.add(pair[1].id);
    out.push([pair[0].id, pair[1].id]);
  }
  return out;
}

export function higherSide(aId, bId) {
  const a = itemById(aId);
  const b = itemById(bId);
  if (!a || !b) return null;
  return a.value > b.value ? 'a' : 'b';
}

export function score(picks, right, streaks, playing) {
  const next = { ...(streaks || {}) };
  const gained = {};
  for (const slot of playing) {
    if (picks[slot] && picks[slot] === right) {
      next[slot] = (next[slot] || 0) + 1;
      gained[slot] = pointsFor(next[slot]);
    } else {
      next[slot] = 0;
    }
  }
  return { streaks: next, gained };
}

function shown(item) {
  return { id: item.id, n: item.name, e: item.emoji };
}

function ask(api, deck, i, note) {
  const pair = deck[i];
  const a = pair && itemById(pair[0]);
  const b = pair && itemById(pair[1]);
  if (!a || !b) return next(api, deck, i);
  const prev = api.get(KEY);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const r = (prev && prev.r ? prev.r : 0) + 1;
  api.memory.cur = { r, picks: {} };
  api.put(KEY, {
    deck,
    i,
    r,
    total: deck.length,
    phase: 'guess',
    kind: a.kind,
    a: shown(a),
    b: shown(b),
    in: api.players().map((p) => p.slot),
    wait: [],
    done: [],
    picks: null,
    right: null,
    vals: null,
    streaks: prev && prev.streaks ? prev.streaks : {},
    best: prev && prev.best ? prev.best : {},
    gained: {},
    note: note || null,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, deck, i) {
  if (i + 1 < deck.length && api.players().length) return ask(api, deck, i + 1);
  return api.finish();
}

function playingNow(api, st) {
  const live = api.players().map((p) => p.slot);
  return Array.isArray(st.in) ? live.filter((s) => st.in.includes(s)) : live;
}

function everyoneIn(api, st) {
  const live = playingNow(api, st);
  return live.length > 0 && live.every((s) => st.done.includes(s));
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  const cur = api.memory.cur;
  const picks = cur && cur.r === st.r ? cur.picks : {};
  const right = higherSide(st.a.id, st.b.id);
  const playing = (Array.isArray(st.in) ? st.in : []).filter((s) => Number.isInteger(s));
  const result = score(picks, right, st.streaks, playing);
  const best = { ...(st.best || {}) };
  for (const [slot, n] of Object.entries(result.streaks)) if (n > (best[slot] || 0)) best[slot] = n;
  for (const [slot, pts] of Object.entries(result.gained)) api.addPoints(Number(slot), pts);
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, {
    ...st,
    phase: 'reveal',
    picks,
    right,
    vals: { a: showValue(itemById(st.a.id)), b: showValue(itemById(st.b.id)) },
    streaks: result.streaks,
    best,
    gained: result.gained,
    starts: api.now(),
    ends,
  });
  api.setDeadline(ends);
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

const higherlower = {
  id: 'higherlower',
  name: 'Higher or Lower',
  emoji: '📈',
  category: 'quick',
  blurb: 'Two things, one hidden number. Pick the bigger one fast and build a streak for bonus points.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to pick', type: 'choice', options: [7, 10, 15].map((v) => ({ value: v, label: `${v} s` })), default: 10 },
  ],

  start(api) {
    ask(api, buildDeck(api.settings.rounds, api.random), 0);
  },

  intent(api, slot, action) {
    if (action.type !== 'pick' || (action.side !== 'a' && action.side !== 'b')) return;
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'guess' || !cur || cur.r !== st.r) return;
    if (action.r !== undefined && action.r !== st.r) return;
    if (cur.picks[slot]) return;
    if (!st.in.includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!st.in.includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    cur.picks[slot] = action.side;
    if (!st.done.includes(slot)) st.done.push(slot);
    api.put(KEY, st);
    if (everyoneIn(api, st)) reveal(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'guess') return reveal(api);
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'guess' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      higherlower.deadline(api);
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
    if (!st) return higherlower.start(api);
    if (st.phase === 'guess') {
      const cur = api.memory.cur;
      if (!cur || cur.r !== st.r) return ask(api, st.deck, st.i, 'host');
    }
    if (api.deadline === null) api.setDeadline(api.now());
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
    if (everyoneIn(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : null;
    };
    const revealed = st.phase === 'reveal';
    const playing = Array.isArray(st.in) ? st.in : [];
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || !playing.includes(mine));
    const myPick = revealed ? (st.picks && st.picks[mine]) || null : local.r === st.r ? local.side || null : null;
    const sideOf = (side) =>
      Object.entries(st.picks || {})
        .filter(([, v]) => v === side)
        .map(([s]) => faceOf(Number(s)))
        .filter(Boolean);
    const live = playing.filter((s) => bySlot.has(s) && bySlot.get(s).present);
    const kind = KINDS[st.kind] || null;
    const streak = mine !== null && st.streaks ? st.streaks[mine] || 0 : 0;
    const hot = Object.entries(st.streaks || {})
      .filter(([, n]) => n >= 3)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([s, n]) => ({ who: faceOf(Number(s)), n }))
      .filter((x) => x.who);
    return {
      phase: st.phase,
      r: st.r,
      number: st.i + 1,
      total: st.total,
      ask: kind ? kind.ask : 'Which is bigger?',
      kind: st.kind,
      a: { name: st.a.n, emoji: st.a.e, value: revealed && st.vals ? st.vals.a : null },
      b: { name: st.b.n, emoji: st.b.e, value: revealed && st.vals ? st.vals.b : null },
      starts: st.starts,
      ends: st.ends,
      note: st.note,
      waiting,
      watching,
      canPick: st.phase === 'guess' && !waiting && !watching && !myPick,
      myPick,
      right: revealed ? st.right : null,
      correct: revealed ? Boolean(myPick) && myPick === st.right : null,
      done: st.done.length,
      players: live.length || playing.length,
      doneBy: st.done.map(faceOf).filter(Boolean),
      pickers: { a: revealed ? sideOf('a') : [], b: revealed ? sideOf('b') : [] },
      streak,
      best: mine !== null && st.best ? st.best[mine] || 0 : 0,
      hot,
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
    };
  },
};

export default higherlower;
