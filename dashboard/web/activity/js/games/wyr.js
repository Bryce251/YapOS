import { PROMPTS, promptById } from '../../data/wyr.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';

export const KEY = 'wyr';
export const REVEAL_MS = 6000;
export const WIN_POINTS = 100;
export const TIE_POINTS = 50;
export const LATE_MIN_MS = 4000;

export function buildDeck(count, random = Math.random) {
  return shuffle(PROMPTS, random).slice(0, Math.max(1, count)).map((p) => p.id);
}

export function award(votes, mode) {
  const a = [];
  const b = [];
  for (const [slot, side] of Object.entries(votes || {})) (side === 'a' ? a : b).push(Number(slot));
  const out = {};
  if (!a.length && !b.length) return { split: { a: 0, b: 0 }, gained: out, side: null };
  let side = null;
  if (a.length === b.length) {
    for (const s of a.concat(b)) out[s] = TIE_POINTS;
    return { split: { a: a.length, b: b.length }, gained: out, side: 'tie' };
  }
  if (mode === 'minority') {
    if (!a.length || !b.length) return { split: { a: a.length, b: b.length }, gained: out, side: null };
    side = a.length < b.length ? 'a' : 'b';
  } else {
    side = a.length > b.length ? 'a' : 'b';
  }
  for (const s of side === 'a' ? a : b) out[s] = WIN_POINTS;
  return { split: { a: a.length, b: b.length }, gained: out, side };
}

function ask(api, deck, i, note) {
  const p = promptById(deck[i]);
  if (!p) return next(api, deck, i);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { pid: p.id, votes: {} };
  api.put(KEY, {
    deck,
    i,
    total: deck.length,
    phase: 'vote',
    mode: api.settings.mode,
    p: { id: p.id, a: p.a, b: p.b },
    in: api.players().map((x) => x.slot),
    wait: [],
    voted: [],
    votes: null,
    split: null,
    side: null,
    gained: {},
    note: note || null,
    starts,
    ends,
  });
  api.setDeadline(ends);
}

function next(api, deck, i) {
  if (i + 1 < deck.length) return ask(api, deck, i + 1);
  return api.finish();
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = api.memory.cur;
  const votes = cur && cur.pid === st.p.id ? cur.votes : {};
  const result = award(votes, st.mode);
  for (const [slot, pts] of Object.entries(result.gained)) api.addPoints(Number(slot), pts);
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', votes, split: result.split, side: result.side, gained: result.gained, ends });
  api.setDeadline(ends);
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : null;
}

function everyoneVoted(api, st) {
  const playing = inPlay(st);
  const live = api.players().map((p) => p.slot).filter((s) => !playing || playing.includes(s));
  return live.length > 0 && live.every((s) => st.voted.includes(s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'vote') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

const wyr = {
  id: 'wyr',
  name: 'Would You Rather',
  emoji: '🤔',
  blurb: 'Pick a side before the timer runs out. Side with the crowd to score.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Prompts', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to vote', type: 'choice', options: [10, 15, 20].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    {
      id: 'mode',
      label: 'Who scores',
      type: 'choice',
      options: [
        { value: 'majority', label: 'The crowd' },
        { value: 'minority', label: 'The rebels' },
      ],
      default: 'majority',
    },
  ],

  start(api) {
    ask(api, buildDeck(api.settings.rounds, api.random), 0);
  },

  intent(api, slot, action) {
    if (action.type !== 'vote' || (action.side !== 'a' && action.side !== 'b')) return;
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'vote' || !cur || cur.pid !== st.p.id) return;
    if (action.p !== undefined && action.p !== st.p.id) return;
    if (cur.votes[slot]) return;
    if (inPlay(st) && !st.in.includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!st.in.includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    cur.votes[slot] = action.side;
    if (!st.voted.includes(slot)) st.voted.push(slot);
    api.put(KEY, st);
    if (everyoneVoted(api, st)) reveal(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'vote') return reveal(api);
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'vote' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'vote') reveal(api);
      else next(api, st.deck, st.i);
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
    if (!st) return wyr.start(api);
    if (st.phase === 'vote') return ask(api, st.deck, st.i, 'host');
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'vote') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneVoted(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const people = snap.players.filter((p) => p.slot !== null);
    const bySlot = new Map(people.map((p) => [p.slot, p]));
    const revealed = st.phase === 'reveal';
    const playing = inPlay(st);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || (playing ? !playing.includes(mine) : false));
    const myVote = revealed && st.votes && st.votes[mine] ? st.votes[mine] : local.pid === st.p.id ? local.side || null : null;
    const sideOf = (side) =>
      Object.entries(st.votes || {})
        .filter(([, v]) => v === side)
        .map(([s]) => bySlot.get(Number(s)))
        .filter(Boolean)
        .map((p) => face(p, mine));
    const split = st.split || { a: 0, b: 0 };
    const total = split.a + split.b;
    return {
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      mode: st.mode,
      a: st.p.a,
      b: st.p.b,
      pid: st.p.id,
      ends: st.ends,
      starts: st.starts,
      voted: st.voted.length,
      players: playing ? playing.length : snap.players.filter((p) => p.present).length,
      votedBy: st.voted.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      waiting,
      watching,
      canVote: st.phase === 'vote' && !waiting && !watching,
      myVote,
      note: st.note,
      split,
      pctA: total ? Math.round((split.a / total) * 100) : 50,
      pctB: total ? 100 - Math.round((split.a / total) * 100) : 50,
      side: st.side,
      voters: { a: revealed ? sideOf('a') : [], b: revealed ? sideOf('b') : [] },
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
    };
  },
};

export default wyr;
