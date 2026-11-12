import { PROMPTS, promptById } from '../../data/wyr.js';
import { shuffle } from '../engine.js';

export const KEY = 'wyr';
export const REVEAL_MS = 6000;
export const WIN_POINTS = 100;
export const TIE_POINTS = 50;

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

function everyoneVoted(api, st) {
  const live = api.players().map((p) => p.slot);
  return live.length > 0 && live.every((s) => st.voted.includes(s));
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

  resume(api) {
    const st = api.get(KEY);
    if (!st) return wyr.start(api);
    if (st.phase === 'vote') return ask(api, st.deck, st.i, 'host');
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (st && st.phase === 'vote' && everyoneVoted(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const people = snap.players.filter((p) => p.slot !== null);
    const bySlot = new Map(people.map((p) => [p.slot, p]));
    const revealed = st.phase === 'reveal';
    const myVote = revealed && st.votes && st.votes[mine] ? st.votes[mine] : local.pid === st.p.id ? local.side || null : null;
    const sideOf = (side) =>
      Object.entries(st.votes || {})
        .filter(([, v]) => v === side)
        .map(([s]) => bySlot.get(Number(s)))
        .filter(Boolean)
        .map((p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar }));
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
      players: snap.players.filter((p) => p.present).length,
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
