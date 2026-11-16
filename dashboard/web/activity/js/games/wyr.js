import { PROMPTS, promptById } from '../../data/wyr.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';

export const KEY = 'wyr';
export const REVEAL_MS = 5000;
export const RECAP_MS = 14000;
export const WIN_POINTS = 100;
export const TIE_POINTS = 50;
export const LATE_MIN_MS = 4000;
export const TWIN_MIN = 3;

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

function sidesOf(votes) {
  const a = [];
  const b = [];
  for (const [slot, side] of Object.entries(votes || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s)) continue;
    if (side === 'a') a.push(s);
    else if (side === 'b') b.push(s);
  }
  return [a.sort((x, y) => x - y), b.sort((x, y) => x - y)];
}

function rows(hist) {
  return (Array.isArray(hist) ? hist : []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && Array.isArray(r[1]) && Array.isArray(r[2]));
}

export function pickOf(row, slot) {
  if (row[1].includes(slot)) return 'a';
  if (row[2].includes(slot)) return 'b';
  return null;
}

export function agreement(hist, x, y) {
  let same = 0;
  let both = 0;
  for (const row of rows(hist)) {
    const px = pickOf(row, x);
    const py = pickOf(row, y);
    if (!px || !py) continue;
    both += 1;
    if (px === py) same += 1;
  }
  return { same, both };
}

function slotsIn(hist) {
  const out = new Set();
  for (const row of rows(hist)) for (const s of row[1].concat(row[2])) if (Number.isInteger(s)) out.add(s);
  return [...out].sort((a, b) => a - b);
}

export function twinFor(hist, slot) {
  let best = null;
  for (const other of slotsIn(hist)) {
    if (other === slot) continue;
    const { same, both } = agreement(hist, slot, other);
    if (!both || same < 1) continue;
    if (!best || same > best.same || (same === best.same && both < best.both)) best = { slot: other, same, both };
  }
  return best;
}

export function soulmates(hist) {
  const all = slotsIn(hist);
  let best = null;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const { same, both } = agreement(hist, all[i], all[j]);
      if (same < TWIN_MIN || same / both < 0.75) continue;
      if (!best || same > best.same || (same === best.same && same / both > best.same / best.both)) best = { pair: [all[i], all[j]], same, both };
    }
  }
  return best;
}

export function sideCounts(hist) {
  const rebel = {};
  const crowd = {};
  for (const row of rows(hist)) {
    const [a, b] = [row[1], row[2]];
    if (!a.length || !b.length || a.length === b.length) continue;
    const big = a.length > b.length ? a : b;
    const small = big === a ? b : a;
    for (const s of small) rebel[s] = (rebel[s] || 0) + 1;
    for (const s of big) crowd[s] = (crowd[s] || 0) + 1;
  }
  return { rebel, crowd };
}

function topOf(map, min) {
  const list = Object.entries(map).map(([s, n]) => [Number(s), n]).filter(([, n]) => n >= min);
  if (!list.length) return null;
  const best = Math.max(...list.map((x) => x[1]));
  return { slots: list.filter((x) => x[1] === best).map((x) => x[0]), n: best };
}

function give(api, slot, n) {
  const got = api.addPoints(slot, n);
  return Number.isFinite(got) ? got : n;
}

function say(api, kind, data) {
  if (typeof api.say === 'function') api.say(kind, data);
}

function ask(api, deck, i, note) {
  const p = promptById(deck[i]);
  if (!p) return next(api, deck, i);
  const prev = api.get(KEY);
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
    h: prev && Array.isArray(prev.h) ? prev.h.filter((r) => Array.isArray(r) && r[0] !== p.id) : [],
    rc: api.settings.recap === false ? 0 : 1,
  });
  api.setDeadline(ends);
  if (typeof api.round === 'function') api.round(i + 1, deck.length);
  return undefined;
}

function next(api, deck, i) {
  if (i + 1 < deck.length) return ask(api, deck, i + 1);
  const st = api.get(KEY);
  if (st && st.phase === 'reveal' && st.rc !== 0 && rows(st.h).some((r) => r[1].length + r[2].length > 0)) {
    const starts = api.now();
    const ends = starts + RECAP_MS;
    api.put(KEY, { ...st, phase: 'recap', starts, ends, gained: {}, note: null });
    api.setDeadline(ends);
    return undefined;
  }
  return api.finish();
}

function cheer(api, result) {
  const sk = api.memory.sk && typeof api.memory.sk === 'object' ? api.memory.sk : {};
  api.memory.sk = sk;
  const voters = Object.keys(result.gained).map(Number);
  const [a, b] = [result.split.a, result.split.b];
  for (const s of Object.keys(sk).map(Number)) if (!voters.includes(s)) sk[s] = 0;
  for (const s of voters) {
    sk[s] = (sk[s] || 0) + 1;
    say(api, 'streak', { slot: s, n: sk[s] });
  }
  if (a + b >= 3 && (!a || !b)) say(api, 'custom', { text: `🤝 Everyone picked ${a ? 'A' : 'B'}! Total agreement.` });
  else if (a + b >= 4 && a === b) say(api, 'custom', { text: "⚖️ A perfect split! This crowd can't agree on anything." });
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = api.memory.cur;
  const votes = cur && cur.pid === st.p.id ? cur.votes : {};
  const result = award(votes, st.mode);
  const gained = {};
  for (const [slot, pts] of Object.entries(result.gained)) gained[slot] = give(api, Number(slot), pts);
  api.memory.cur = null;
  cheer(api, result);
  const [a, b] = sidesOf(votes);
  const h = (Array.isArray(st.h) ? st.h : []).filter((r) => Array.isArray(r) && r[0] !== st.p.id).concat([[st.p.id, a, b]]);
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', votes, split: result.split, side: result.side, gained, ends, h });
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
  category: 'party',
  emoji: '🤔',
  blurb: 'Pick a side before the timer runs out. Side with the crowd to score.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Prompts', type: 'choice', options: [5, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to vote', type: 'choice', options: [8, 10, 12, 15, 20].map((v) => ({ value: v, label: `${v} s` })), default: 12 },
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
    { id: 'recap', label: '👀 Who picked what', type: 'toggle', default: true, fun: true },
  ],

  start(api) {
    api.memory.sk = {};
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

  hint(api) {
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'vote' || !cur || cur.pid !== st.p.id) return null;
    const [a, b] = sidesOf(cur.votes);
    if (!a.length && !b.length) return null;
    return `👀 So far ${a.length} picked A and ${b.length} picked B.`;
  },

  awards(api) {
    const st = api.get(KEY);
    if (!st) return [];
    const out = [];
    const pair = soulmates(st.h);
    if (pair) out.push({ emoji: '💞', title: 'Soulmates', who: pair.pair, why: `Picked the same side ${pair.same} of ${pair.both} times` });
    const { rebel, crowd } = sideCounts(st.h);
    const r = topOf(rebel, 2);
    if (r) out.push({ emoji: '😈', title: 'Rebel', who: r.slots, why: `Went against the crowd ${r.n} times` });
    const c = topOf(crowd, 3);
    if (c && (!r || c.slots.some((s) => !r.slots.includes(s)))) out.push({ emoji: '🐑', title: 'Crowd whisperer', who: c.slots.filter((s) => !r || !r.slots.includes(s)), why: `Sided with the crowd ${c.n} times` });
    return out;
  },

  highlights(api) {
    const st = api.get(KEY);
    if (!st) return [];
    const out = [];
    const list = rows(st.h);
    const split = list.filter((r) => r[1].length && r[2].length && r[1].length + r[2].length >= 4).sort((x, y) => Math.abs(x[1].length - x[2].length) - Math.abs(y[1].length - y[2].length))[0];
    if (split && Math.abs(split[1].length - split[2].length) <= 1) {
      const p = promptById(split[0]);
      if (p) out.push({ text: `⚖️ The great divide: ${p.a}, or ${p.b}? (${split[1].length} vs ${split[2].length})` });
    }
    const same = list.find((r) => r[1].length + r[2].length >= 3 && (!r[1].length || !r[2].length));
    if (same) {
      const p = promptById(same[0]);
      if (p) out.push({ text: `🤝 Everyone would rather ${same[1].length ? p.a : p.b}` });
    }
    return out;
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'vote') return reveal(api);
    if (st.phase === 'recap') return api.finish();
    return next(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['vote', 'reveal', 'recap'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      if (st.phase === 'vote') reveal(api);
      else if (st.phase === 'recap') api.finish();
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
    if (api.deadline === null) api.setDeadline(st.phase === 'recap' ? Math.max(api.now(), st.ends || 0) : api.now());
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
    const faceOf = (s) => {
      const p = bySlot.get(s);
      return p ? face(p, mine) : null;
    };
    if (st.phase === 'recap') {
      const hist = rows(st.h);
      const twin = mine !== null ? twinFor(hist, mine) : null;
      const pair = soulmates(hist);
      return {
        phase: 'recap',
        number: st.total,
        total: st.total,
        mode: st.mode,
        starts: st.starts,
        ends: st.ends,
        rounds: hist
          .map((r) => {
            const p = promptById(r[0]);
            if (!p) return null;
            const big = r[1].length === r[2].length ? null : r[1].length > r[2].length ? 'a' : 'b';
            return { pid: r[0], a: p.a, b: p.b, votersA: r[1].map(faceOf).filter(Boolean), votersB: r[2].map(faceOf).filter(Boolean), mine: mine !== null ? pickOf(r, mine) : null, big };
          })
          .filter(Boolean),
        twin: twin && faceOf(twin.slot) ? { ...faceOf(twin.slot), same: twin.same, both: twin.both } : null,
        pair: pair && pair.pair.every((s) => faceOf(s)) ? { people: pair.pair.map(faceOf), same: pair.same, both: pair.both } : null,
        watching: mine === null,
      };
    }
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
