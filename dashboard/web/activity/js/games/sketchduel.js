import { WORDS, TIERS, wordById } from '../../data/draw.js';
import { shuffle } from '../engine.js';
import { isBlockedGameWord } from '../filter.js';
import { seatBudget, seatKey, seatOf, validChunk, readSeat, seatRoom, SEAT_CHUNKS } from './ink.js';
import { face } from './trivia.js';
import { timeSetting, addPts, roundOf, say, nameOf, bump, topOf, times } from './drawfun.js';

export const KEY = 'sketchduel';
export const INK_PREFIX = 'sd.d.';
export const MIN_PLAYERS = 3;
export const MAX_DUELS = 4;
export const GRACE_MS = 1500;
export const SETTLE_MS = 1200;
export const VOTE_MS = 12000;
export const RESULT_MS = 4000;
export const LOST_MS = 6000;
export const VOTE_POINTS = 100;
export const WIN_BONUS = 100;
export const TIE_BONUS = 50;
export const USED_MAX = 60;
export const HID_MAX = 24;
export const MIX = 'mix';
export const DUEL_TIMES = Object.freeze([60, 75, 90, 120, 150, 180]);

export function inkKey(seat, i = 0) {
  return seatKey(INK_PREFIX, seat, i);
}

export function seatInk(src, seat, k) {
  return readSeat(src, INK_PREFIX, seat, k);
}

export function budgetOf(st) {
  return st && Number.isInteger(st.b) && st.b > 0 ? st.b : seatBudget(st && Array.isArray(st.seats) ? st.seats.length : 1);
}

function clearSeat(api, seat) {
  for (let i = 0; i < SEAT_CHUNKS; i += 1) if (api.get(inkKey(seat, i)) !== null) api.put(inkKey(seat, i), null);
}

export function drawingId(run, round, seat) {
  return `sd.${run}.${round}.${seat}`;
}

export function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function pickDrawers(slots, plays, random = Math.random, max = MAX_DUELS) {
  const count = Math.min(max * 2, Math.floor(slots.length / 2) * 2);
  const order = shuffle(slots, random).sort((a, b) => (plays[a] || 0) - (plays[b] || 0));
  return { drawers: order.slice(0, count), out: order.slice(count) };
}

export function pairUp(drawers, history = [], random = Math.random) {
  const seen = new Set(history);
  const left = shuffle(drawers, random);
  const out = [];
  while (left.length >= 2) {
    const a = left.shift();
    let j = left.findIndex((b) => !seen.has(pairKey(a, b)));
    if (j < 0) j = 0;
    const [b] = left.splice(j, 1);
    out.push([a, b]);
  }
  return out;
}

export function wordPool(level) {
  const tiers = TIERS.map((t) => t.id);
  const want = tiers.includes(level) ? [level] : ['easy', 'medium'];
  return WORDS.filter((w) => want.includes(w.tier) && !isBlockedGameWord(w.w));
}

export function pickWords(n, level, used = [], random = Math.random) {
  const seen = new Set(used);
  const all = wordPool(level);
  const freshOnes = all.filter((w) => !seen.has(w.id));
  return shuffle(freshOnes.length >= n ? freshOnes : all, random)
    .slice(0, n)
    .map((w) => w.id);
}

export function award(votes, hidden = []) {
  const off = new Set(hidden);
  let a = 0;
  let b = 0;
  const by = { a: [], b: [] };
  for (const [slot, side] of Object.entries(votes || {})) {
    if ((side !== 'a' && side !== 'b') || off.has(side)) continue;
    if (side === 'a') a += 1;
    else b += 1;
    by[side].push(Number(slot));
  }
  const win = a === b ? (a ? 'tie' : null) : a > b ? 'a' : 'b';
  const pts = { a: a * VOTE_POINTS, b: b * VOTE_POINTS };
  if (win === 'tie') {
    pts.a += TIE_BONUS;
    pts.b += TIE_BONUS;
  } else if (win) {
    pts[win] += WIN_BONUS;
  }
  return { a, b, by: { a: by.a.sort((x, y) => x - y), b: by.b.sort((x, y) => x - y) }, win, pts };
}

function here(api) {
  return new Set(api.players().map((p) => p.slot));
}

function clearInk(api) {
  for (const k of api.keys()) if (k.startsWith(INK_PREFIX)) api.put(k, null);
}

function nonce(api) {
  return 1 + Math.floor(api.random() * 65534);
}

function hiddenSet(st) {
  return new Set(Array.isArray(st && st.hid) ? st.hid : []);
}

function openRound(api, st, round) {
  const slots = [...here(api)];
  const plays = { ...(st.plays || {}) };
  const { drawers } = pickDrawers(slots, plays, api.random);
  if (drawers.length < 2 || slots.length < MIN_PLAYERS) return lose(api, st, 'few');
  const pairs = pairUp(drawers, st.pairs || [], api.random);
  const words = pickWords(pairs.length, api.settings.level, st.used || [], api.random);
  const seats = [];
  const duels = pairs.map(([a, b], i) => {
    seats.push(a, b);
    plays[a] = (plays[a] || 0) + 1;
    plays[b] = (plays[b] || 0) + 1;
    return [seats.length - 2, seats.length - 1, words[i]];
  });
  clearInk(api);
  roundOf(api, round + 1, st.rounds || 1);
  const starts = api.now();
  const ends = starts + api.settings.draw * 1000;
  api.memory.cur = null;
  api.put(KEY, {
    ...st,
    v: 1,
    round,
    phase: 'draw',
    k: nonce(api),
    seats,
    b: seatBudget(seats.length),
    duels,
    d: 0,
    plays,
    pairs: (st.pairs || []).concat(pairs.map(([a, b]) => pairKey(a, b))).slice(-40),
    used: (st.used || []).concat(words).slice(-USED_MAX),
    done: [],
    pass: 0,
    voted: [],
    res: null,
    hid: [],
    note: null,
    starts,
    ends,
  });
  api.setDeadline(ends + GRACE_MS);
  return undefined;
}

function lose(api, st, note) {
  clearInk(api);
  const starts = api.now();
  const ends = starts + LOST_MS;
  api.memory.cur = null;
  api.put(KEY, { ...st, phase: 'lost', note, seats: [], duels: [], done: [], voted: [], res: null, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function judgesFor(api, st, d) {
  const duel = st.duels[d];
  if (!duel) return [];
  const a = st.seats[duel[0]];
  const b = st.seats[duel[1]];
  return [...here(api)].filter((s) => s !== a && s !== b);
}

function openVote(api, st, d, note = null) {
  if (d >= st.duels.length) return endRound(api, st);
  const starts = api.now();
  if (!judgesFor(api, st, d).length) {
    const res = { ...award({}), none: 1 };
    const ends = starts + RESULT_MS;
    api.put(KEY, { ...st, phase: 'result', d, voted: [], res, note: null, starts, ends });
    api.setDeadline(ends);
    return undefined;
  }
  api.memory.cur = { key: `${st.run}.${st.round}.${d}`, votes: {} };
  const ends = starts + VOTE_MS;
  api.put(KEY, { ...st, phase: 'vote', d, voted: [], res: null, pass: 0, note, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function curVotes(api, st) {
  const cur = api.memory.cur;
  return cur && cur.key === `${st.run}.${st.round}.${st.d}` ? cur : null;
}

function hiddenSides(st) {
  const hid = hiddenSet(st);
  const duel = st.duels[st.d];
  if (!duel) return [];
  const out = [];
  if (hid.has(drawingId(st.run, st.round, duel[0]))) out.push('a');
  if (hid.has(drawingId(st.run, st.round, duel[1]))) out.push('b');
  return out;
}

function showResult(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = curVotes(api, st);
  const res = award(cur ? cur.votes : {}, hiddenSides(st));
  const duel = st.duels[st.d];
  const a = st.seats[duel[0]];
  const b = st.seats[duel[1]];
  if (res.pts.a) res.pts.a = addPts(api, a, res.pts.a);
  if (res.pts.b) res.pts.b = addPts(api, b, res.pts.b);
  const wins = api.memory.wins || (api.memory.wins = {});
  if (res.win === 'a') wins[a] = (wins[a] || 0) + 1;
  if (res.win === 'b') wins[b] = (wins[b] || 0) + 1;
  api.memory.cur = null;
  const sx = duelStats(st);
  const judges = res.a + res.b;
  const winner = res.win === 'a' ? a : res.win === 'b' ? b : null;
  if (winner !== null) {
    sx.w = bump(sx.w, winner);
    if (judges >= 2 && (res.a === 0 || res.b === 0)) {
      sx.s = bump(sx.s, winner);
      say(api, 'custom', { text: `🧹 Clean sweep! Every vote went to ${nameOf(api, winner)}.` });
    } else if (Math.abs(res.a - res.b) === 1 && judges >= 3) {
      say(api, 'custom', { text: `😮‍💨 ${nameOf(api, winner)} wins it by a single vote!` });
    } else {
      say(api, 'win', { slot: winner });
    }
  } else if (res.win === 'tie') {
    sx.t = bump(bump(sx.t, a), b);
    say(api, 'custom', { text: `🤝 Dead heat between ${nameOf(api, a)} and ${nameOf(api, b)}!` });
  }
  const starts = api.now();
  const ends = starts + RESULT_MS;
  api.put(KEY, { ...st, phase: 'result', res, sx, starts, ends });
  api.setDeadline(ends);
}

function duelStats(st) {
  const sx = st && st.sx && typeof st.sx === 'object' ? st.sx : {};
  return { w: sx.w || {}, s: sx.s || {}, t: sx.t || {} };
}

export function duelAwards(st) {
  const sx = duelStats(st);
  const out = [];
  const champ = topOf(sx.w, 2);
  if (champ) out.push({ emoji: '⚔️', title: 'Duel champion', who: champ.slot, why: `Won ${times(champ.n, 'duel', 'duels')}` });
  const sweep = topOf(sx.s, 1);
  if (sweep && (!champ || sweep.slot !== champ.slot)) out.push({ emoji: '🧹', title: 'Landslide artist', who: sweep.slot, why: `Took every single vote ${times(sweep.n, 'time', 'times')}` });
  const tie = topOf(sx.t, 1);
  if (tie) out.push({ emoji: '🤝', title: 'Photo finish', who: tie.slot, why: 'Drew a duel dead level' });
  return out;
}

function endRound(api, st) {
  if (st.round + 1 < st.rounds) return openRound(api, st, st.round + 1);
  clearInk(api);
  api.memory.cur = null;
  return api.finish();
}

function liveSeats(api, st) {
  const live = here(api);
  return st.seats.map((s, i) => (live.has(s) ? i : -1)).filter((i) => i >= 0);
}

function settle(api, st) {
  const live = liveSeats(api, st);
  if (!live.length || !live.every((i) => st.done.includes(i))) return false;
  if (st.pass) return true;
  api.put(KEY, { ...st, pass: 1 });
  api.setDeadline(api.now() + SETTLE_MS);
  return true;
}

function closeDraw(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'draw') return;
  for (let i = 0; i < st.seats.length; i += 1) {
    for (let j = 0; j < SEAT_CHUNKS; j += 1) {
      const v = api.get(inkKey(i, j));
      if (v !== null && !validChunk(v, st.k)) api.put(inkKey(i, j), null);
    }
  }
  openVote(api, { ...st, pass: 0 }, 0);
}

function sideOf(st, slot) {
  const duel = st.duels[st.d];
  if (!duel) return null;
  if (st.seats[duel[0]] === slot) return 'a';
  if (st.seats[duel[1]] === slot) return 'b';
  return null;
}

function drawingList(api, st) {
  if (!st || (st.phase !== 'vote' && st.phase !== 'result')) return [];
  const duel = st.duels[st.d];
  if (!duel) return [];
  const hid = hiddenSet(st);
  const out = [];
  for (const seat of [duel[0], duel[1]]) {
    const d = drawingId(st.run, st.round, seat);
    if (hid.has(d) || !seatInk((key) => api.get(key), seat, st.k).s.length) continue;
    out.push({ d, drawer: st.seats[seat], seat });
  }
  return out;
}

function hide(api, d) {
  const st = api.get(KEY);
  const item = drawingList(api, st).find((x) => x.d === d);
  if (!item) return false;
  clearSeat(api, item.seat);
  api.put(KEY, { ...st, hid: [...hiddenSet(st)].concat([d]).slice(-HID_MAX) });
  return true;
}

function seen(snap, st) {
  if (!st || (st.phase !== 'vote' && st.phase !== 'result') || !Array.isArray(st.duels)) return [];
  const duel = st.duels[st.d];
  if (!duel) return [];
  const hid = hiddenSet(st);
  const w = wordById(duel[2]);
  const out = [];
  for (const seat of [duel[0], duel[1]]) {
    const d = drawingId(st.run, st.round, seat);
    const ink = hid.has(d) ? [] : seatInk(snap.state, seat, st.k).s;
    if (!ink.length) continue;
    out.push({ d, drawer: st.seats[seat], ink, word: w ? w.w : null, seat });
  }
  return out;
}

const sketchduel = {
  id: 'sketchduel',
  name: 'Sketch Duel',
  emoji: '⚔️',
  category: 'drawing',
  blurb: 'Two artists draw the same word side by side. Everyone else votes for the better one.',
  minPlayers: MIN_PLAYERS,
  keys: [KEY],
  prefixes: [INK_PREFIX],
  open: [INK_PREFIX],
  settings: [
    { id: 'rounds', label: 'Rounds', type: 'choice', options: [1, 2, 3, 4].map((v) => ({ value: v, label: String(v) })), default: 2 },
    timeSetting('draw', DUEL_TIMES, 90),
    {
      id: 'level',
      label: 'Words',
      type: 'choice',
      options: [{ value: MIX, label: 'Mix' }].concat(TIERS.map((t) => ({ value: t.id, label: t.name }))),
      default: MIX,
    },
  ],

  cards: ['swap', 'double'],

  awards(api) {
    return duelAwards(api.get(KEY));
  },

  writer(get, key, slot, value) {
    if (!key.startsWith(INK_PREFIX)) return false;
    const st = get(KEY);
    if (!st || st.phase !== 'draw' || !Array.isArray(st.seats)) return false;
    const at = seatOf(INK_PREFIX, key);
    if (!at || st.seats[at.seat] !== slot) return false;
    return seatRoom(get, INK_PREFIX, at.seat, at.i, value, st.k, budgetOf(st));
  },

  start(api) {
    const run = 1 + Math.floor(api.random() * 1e9);
    api.memory.cur = null;
    api.memory.wins = {};
    openRound(api, { run, rounds: api.settings.rounds, plays: {}, pairs: [], used: [] }, 0);
  },

  results(api) {
    const wins = api.memory.wins || {};
    const best = Math.max(0, ...Object.values(wins));
    const top = best > 0 ? Object.keys(wins).filter((s) => wins[s] === best).map(Number) : [];
    return { extra: top.length ? { duelWins: top } : {} };
  },

  intent(api, slot, action) {
    const st = api.get(KEY);
    if (!st || !action || typeof action.type !== 'string') return;
    if (action.type === 'vote') {
      if (st.phase !== 'vote' || action.r !== st.round || action.d !== st.d) return;
      if (action.side !== 'a' && action.side !== 'b') return;
      const cur = curVotes(api, st);
      if (!cur || cur.votes[slot] || sideOf(st, slot)) return;
      if (!here(api).has(slot)) return;
      cur.votes[slot] = action.side;
      if (!st.voted.includes(slot)) st.voted.push(slot);
      api.put(KEY, st);
      const need = judgesFor(api, st, st.d);
      if (need.every((s) => st.voted.includes(s))) showResult(api);
      return;
    }
    if (st.phase !== 'draw' || action.r !== st.round) return;
    const seat = st.seats.indexOf(slot);
    if (seat < 0) return;
    if (action.type === 'done') {
      if (st.done.includes(seat)) return;
      const next = { ...st, done: st.done.concat([seat]) };
      api.put(KEY, next);
      settle(api, next);
      return;
    }
    if (action.type === 'edit') {
      if (st.pass || !st.done.includes(seat)) return;
      api.put(KEY, { ...st, done: st.done.filter((x) => x !== seat) });
    }
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'draw') return closeDraw(api);
    if (st.phase === 'vote') return showResult(api);
    if (st.phase === 'result') return openVote(api, st, st.d + 1);
    if (st.phase === 'lost') return api.finish();
    return api.finish();
  },

  drawings(api) {
    return drawingList(api, api.get(KEY)).map((x) => ({ d: x.d, drawer: x.drawer }));
  },

  drawingsOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    return seen(snap, st);
  },

  drawingOf(snap) {
    const list = sketchduel.drawingsOf(snap);
    return list.length ? list[list.length - 1] : null;
  },

  admin(api, action) {
    if (action.type === 'hideDrawing') return hide(api, action.d);
    const st = api.get(KEY);
    if (!st || !['draw', 'vote', 'result', 'lost'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      sketchduel.deadline(api);
      return true;
    }
    if (action.type === 'time') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends, pass: 0 });
      api.setDeadline(st.phase === 'draw' ? ends + GRACE_MS : ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return sketchduel.start(api);
    if (st.phase === 'vote' && !curVotes(api, st)) return openVote(api, st, st.d, 'host');
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), (st.ends || api.now()) + (st.phase === 'draw' ? GRACE_MS : 0)));
    return undefined;
  },

  join() {},

  roster(api) {
    const st = api.get(KEY);
    if (!st) return;
    const live = here(api);
    if (st.phase !== 'lost' && live.size < 2) return lose(api, st, 'few');
    if (st.phase === 'draw') {
      if (!liveSeats(api, st).length) return closeDraw(api);
      settle(api, st);
      return undefined;
    }
    if (st.phase === 'vote') {
      const need = judgesFor(api, st, st.d);
      if (need.every((s) => st.voted.includes(s))) showResult(api);
    }
    return undefined;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !Array.isArray(st.seats)) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const present = new Set(snap.players.filter((p) => p.present && p.joined).map((p) => p.slot));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : { id: null, name: 'Player', initials: 'P', hue: 20, avatar: null, isMe: false };
    };
    const seat = mine === null || mine === undefined ? -1 : st.seats.indexOf(mine);
    const myDuel = seat >= 0 ? st.duels.findIndex((x) => x[0] === seat || x[1] === seat) : -1;
    const done = Array.isArray(st.done) ? st.done : [];
    const hid = hiddenSet(st);
    const duels = (st.duels || []).map((x, i) => {
      const w = wordById(x[2]);
      return { i, a: faceOf(st.seats[x[0]]), b: faceOf(st.seats[x[1]]), word: w ? w.w : '???', seatA: x[0], seatB: x[1] };
    });
    const out = {
      phase: st.phase,
      run: st.run,
      round: st.round,
      rounds: st.rounds,
      k: st.k || null,
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      pass: Boolean(st.pass),
      seat,
      drawing: st.phase === 'draw' && seat >= 0,
      inkKey: seat >= 0 ? inkKey(seat) : null,
      budget: budgetOf(st),
      word: myDuel >= 0 ? duels[myDuel].word : null,
      rival: myDuel >= 0 ? (duels[myDuel].seatA === seat ? duels[myDuel].b : duels[myDuel].a) : null,
      mineDone: seat >= 0 && done.includes(seat),
      doneCount: done.filter((i) => present.has(st.seats[i])).length,
      needCount: st.seats.filter((s) => present.has(s)).length,
      sitting: st.phase === 'draw' && seat < 0,
      duels,
      duel: null,
    };
    if ((st.phase === 'vote' || st.phase === 'result') && duels[st.d]) {
      const dd = duels[st.d];
      const side = dd.a.isMe ? 'a' : dd.b.isMe ? 'b' : null;
      const res = st.res || null;
      const sideInfo = (s, seatIx, who) => {
        const d = drawingId(st.run, st.round, seatIx);
        const hidden = hid.has(d);
        const ink = hidden ? [] : seatInk(snap.state, seatIx, st.k).s;
        return {
          side: s,
          who,
          d,
          key: inkKey(seatIx),
          ink,
          hidden,
          blank: !hidden && !ink.length,
          votes: res ? res[s] : null,
          voters: res ? res.by[s].map(faceOf) : [],
          pts: res ? res.pts[s] : 0,
          win: res ? res.win === s || res.win === 'tie' : false,
        };
      };
      const myVote = st.phase === 'result' && res ? (res.by.a.includes(mine) ? 'a' : res.by.b.includes(mine) ? 'b' : null) : local.key === `${st.run}.${st.round}.${st.d}` ? local.side || null : null;
      const voted = mine !== null && Array.isArray(st.voted) && st.voted.includes(mine);
      out.duel = {
        i: st.d,
        total: duels.length,
        word: dd.word,
        a: sideInfo('a', dd.seatA, dd.a),
        b: sideInfo('b', dd.seatB, dd.b),
        mySide: side,
        canVote: st.phase === 'vote' && !side && mine !== null && present.has(mine) && !voted && !myVote,
        myVote,
        voted: Array.isArray(st.voted) ? st.voted.length : 0,
        judges: [...present].filter((s) => s !== st.seats[dd.seatA] && s !== st.seats[dd.seatB]).length,
        win: res ? res.win : null,
        none: Boolean(res && res.none),
        key: `${st.run}.${st.round}.${st.d}`,
      };
    }
    return out;
  },
};

export default sketchduel;
