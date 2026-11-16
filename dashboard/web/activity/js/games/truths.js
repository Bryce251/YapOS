import { shuffle } from '../engine.js';
import { cleanShared, plainKey } from '../text.js';
import { face } from './trivia.js';
import { award, roundAt, say, streak, bump as tick, prize, bestStreak, keep, reel, list, nameOf, funMem, isFrozen, thaw } from './funkit.js';

export const KEY = 'truths';
export const STATEMENT_MAX = 70;
export const SPOT_POINTS = 100;
export const FOOL_POINTS = 100;
export const REVEAL_MS = 7000;
export const END_MS = 9000;
export const EMPTY_END_MS = 5000;
export const RESUME_MIN_MS = 20000;
export const LATE_MAX = 40;

export const PROBLEMS = Object.freeze({
  empty: 'Fill in all three statements first.',
  same: 'Make all three statements different.',
  lie: 'Tap “Lie” on the one that isn’t true.',
});

export function mask(i, nonce) {
  return (i ^ nonce) & 0xffff;
}

export function unmask(code, nonce) {
  return (code ^ nonce) & 0xffff;
}

export function cleanSet(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const out = raw.map((x) => (typeof x === 'string' ? cleanShared(x, STATEMENT_MAX) : ''));
  if (out.some((x) => !x)) return null;
  const keys = new Set(out.map((x) => plainKey(x) || x.toLowerCase()));
  if (keys.size !== 3) return null;
  return out;
}

export function problemOf(raw, lie) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [0, 1, 2].map((i) => cleanShared(list[i], STATEMENT_MAX));
  if (out.some((x) => !x)) return 'empty';
  if (new Set(out.map((x) => plainKey(x) || x.toLowerCase())).size !== 3) return 'same';
  if (!Number.isInteger(lie) || lie < 0 || lie > 2) return 'lie';
  return null;
}

export function score(votes, lieAt, writer) {
  const gained = {};
  const spotted = [];
  const fooled = [];
  for (const [key, pick] of Object.entries(votes || {})) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || slot === writer) continue;
    if (pick === lieAt) {
      spotted.push(slot);
      gained[slot] = (gained[slot] || 0) + SPOT_POINTS;
    } else {
      fooled.push(slot);
    }
  }
  if (fooled.length) gained[writer] = (gained[writer] || 0) + FOOL_POINTS * fooled.length;
  return { gained, spotted, fooled };
}

export function best(tally) {
  let top = 0;
  let slots = [];
  for (const [key, n] of Object.entries(tally || {})) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || !(n > 0)) continue;
    if (n > top) {
      top = n;
      slots = [slot];
    } else if (n === top) {
      slots.push(slot);
    }
  }
  return { slots: slots.sort((a, b) => a - b), n: top };
}

export function statementRef(n, v, i) {
  return `truths.${n}.${v}.${i}`;
}

function bump(tally, slot, by = 1) {
  const out = { ...(tally || {}) };
  out[slot] = (out[slot] || 0) + by;
  return out;
}

function sets(api) {
  if (!api.memory.sets || typeof api.memory.sets !== 'object') api.memory.sets = {};
  return api.memory.sets;
}

function liveSlots(api) {
  return api.players().map((p) => p.slot);
}

function voteMs(api) {
  return (Number(api.settings.vote) || 15) * 1000;
}

function writeMs(api) {
  return (Number(api.settings.write) || 60) * 1000;
}

function iced(st) {
  return Array.isArray(st && st.ice) ? st.ice : [];
}

function startWrite(api) {
  sets(api);
  api.memory.cur = null;
  const starts = api.now();
  const ends = starts + writeMs(api);
  api.put(KEY, {
    phase: 'write',
    n: 1 + Math.floor(api.random() * 0xfffe),
    h: 0,
    v: 0,
    in: liveSlots(api),
    late: [],
    done: [],
    order: [],
    i: 0,
    fooled: {},
    spotted: {},
    note: null,
    starts,
    ends,
  });
  api.setDeadline(ends);
}

function allWritten(api, st) {
  const live = liveSlots(api).filter((s) => st.in.includes(s));
  return live.every((s) => st.done.includes(s));
}

function endWrite(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write') return;
  const have = sets(api);
  const ready = st.in.filter((s) => have[s]);
  if (!ready.length) return endGame(api, st, 'empty');
  const order = shuffle(ready, api.random);
  return beginSet(api, { ...st, order, total: order.length }, 0);
}

function beginSet(api, base, from, note = null) {
  const have = sets(api);
  let i = from;
  while (i < base.order.length && !have[base.order[i]]) i += 1;
  if (i >= base.order.length) return endGame(api, base);
  const writer = base.order[i];
  const set = have[writer];
  const perm = shuffle([0, 1, 2], api.random);
  const v = (base.v || 0) + 1;
  api.memory.cur = { v, writer, lieAt: perm.indexOf(set.lie), votes: {} };
  roundAt(api, i + 1, base.order.length);
  const ice = liveSlots(api).filter((s) => s !== writer && isFrozen(api, s));
  const starts = api.now();
  const ends = starts + voteMs(api);
  api.put(KEY, {
    phase: 'vote',
    n: base.n,
    h: base.h || 0,
    v,
    in: base.in,
    late: base.late || [],
    done: base.done || [],
    order: base.order,
    total: base.order.length,
    i,
    writer,
    s: perm.map((k) => set.s[k]),
    voted: [],
    ice,
    lie: null,
    votes: null,
    gained: null,
    fooled: base.fooled || {},
    spotted: base.spotted || {},
    note,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function everyoneVoted(api, st) {
  const ice = iced(st);
  return liveSlots(api)
    .filter((s) => s !== st.writer && !ice.includes(s))
    .every((s) => st.voted.includes(s));
}

function answerReady(api, st) {
  const cur = api.memory.cur;
  if (!cur || cur.v !== st.v) return true;
  return cur.lieAt !== null || !liveSlots(api).includes(st.writer);
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = api.memory.cur;
  const known = cur && cur.v === st.v && cur.writer === st.writer && Number.isInteger(cur.lieAt);
  let next = { ...st, phase: 'reveal', lie: null, votes: {}, gained: {}, note: 'lost' };
  if (known) {
    const result = score(cur.votes, cur.lieAt, st.writer);
    for (const [slot, pts] of Object.entries(result.gained)) result.gained[slot] = award(api, slot, pts);
    noteReveal(api, st, cur, result);
    let fooled = st.fooled || {};
    let spotted = st.spotted || {};
    if (result.fooled.length) fooled = bump(fooled, st.writer, result.fooled.length);
    for (const s of result.spotted) spotted = bump(spotted, s);
    next = { ...st, phase: 'reveal', lie: cur.lieAt, votes: { ...cur.votes }, gained: result.gained, fooled, spotted, note: null };
  }
  api.memory.cur = null;
  for (const s of iced(st)) thaw(api, s);
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...next, ice: [], starts, ends });
  api.setDeadline(ends);
}

function endGame(api, st, why = null) {
  const starts = api.now();
  const ends = starts + (why === 'empty' ? EMPTY_END_MS : END_MS);
  api.memory.cur = null;
  api.put(KEY, {
    phase: 'end',
    n: st.n,
    h: st.h || 0,
    v: st.v || 0,
    in: st.in || [],
    late: st.late || [],
    done: [],
    order: st.order || [],
    total: (st.order || []).length,
    i: (st.order || []).length,
    fooled: st.fooled || {},
    spotted: st.spotted || {},
    liar: best(st.fooled),
    detective: best(st.spotted),
    note: why,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function advance(api) {
  const st = api.get(KEY);
  if (!st) return api.finish();
  if (st.phase === 'write') return endWrite(api);
  if (st.phase === 'vote') return reveal(api);
  if (st.phase === 'reveal') return beginSet(api, st, st.i + 1);
  return api.finish();
}

function matchLie(shown, list, lie) {
  const keyOf = (x) => plainKey(x) || String(x).toLowerCase();
  const a = shown.map(keyOf).sort().join('\n');
  const b = list.map(keyOf).sort().join('\n');
  if (a !== b) return null;
  const at = shown.findIndex((x) => keyOf(x) === keyOf(list[lie]));
  return at >= 0 ? at : null;
}

function takeSet(api, slot, action) {
  const st = api.get(KEY);
  if (!st || action.n !== st.n) return;
  const list = cleanSet(action.s);
  if (!list || !Number.isInteger(action.c)) return;
  const lie = unmask(action.c, st.n);
  if (lie < 0 || lie > 2) return;
  const have = sets(api);
  if (st.phase === 'write') {
    if (!st.in.includes(slot)) return;
    have[slot] = { s: list, lie };
    const open = action.open === true;
    const done = st.done.filter((s) => s !== slot);
    if (!open) done.push(slot);
    st.done = done;
    api.put(KEY, st);
    if (allWritten(api, st)) endWrite(api);
    return;
  }
  if (st.phase !== 'vote' && st.phase !== 'reveal') return;
  const at = st.order.indexOf(slot);
  if (at < 0 || at < st.i || (st.phase === 'reveal' && at === st.i) || have[slot]) return;
  have[slot] = { s: list, lie };
  const cur = api.memory.cur;
  if (st.phase === 'vote' && at === st.i && cur && cur.v === st.v && cur.writer === slot && cur.lieAt === null) {
    cur.lieAt = matchLie(st.s, list, lie);
    if (everyoneVoted(api, st)) reveal(api);
  }
}

function takeVote(api, slot, action) {
  const st = api.get(KEY);
  const cur = api.memory.cur;
  if (!st || st.phase !== 'vote' || !cur || cur.v !== st.v || action.v !== st.v) return;
  if (slot === st.writer || !Number.isInteger(action.pick) || action.pick < 0 || action.pick > 2) return;
  if (iced(st).includes(slot)) return;
  if (cur.votes[slot] !== undefined || !liveSlots(api).includes(slot)) return;
  cur.votes[slot] = action.pick;
  if (!st.voted.includes(slot)) st.voted.push(slot);
  api.put(KEY, st);
  if (everyoneVoted(api, st) && answerReady(api, st)) reveal(api);
}

function noteReveal(api, st, cur, result) {
  const voters = Object.keys(cur.votes).length;
  if (result.fooled.length) tick(api, 'fooled', st.writer, result.fooled.length);
  for (const s of result.spotted) {
    tick(api, 'spotted', s);
    streak(api, s, true);
  }
  for (const s of result.fooled) streak(api, s, false);
  if (voters >= 2 && result.fooled.length === voters) say(api, 'custom', { text: `🤥 ${nameOf(api, st.writer)} fooled EVERYONE!` });
  else if (voters >= 2 && !result.fooled.length) say(api, 'custom', { text: `🔍 Nobody fell for ${nameOf(api, st.writer)}'s lie.` });
  const lie = Array.isArray(st.s) ? st.s[cur.lieAt] : null;
  if (lie && result.fooled.length) keep(api, `${nameOf(api, st.writer)}'s lie "${lie}" fooled ${result.fooled.length === 1 ? '1 person' : `${result.fooled.length} people`}`, st.writer, result.fooled.length + 1);
  else if (lie && voters) keep(api, `${nameOf(api, st.writer)}'s lie "${lie}" fooled nobody`, st.writer, 0.5);
}

export function truthsHint(st, cur, slot) {
  if (!st || st.phase !== 'vote' || !cur || cur.v !== st.v || !Number.isInteger(cur.lieAt)) return null;
  if (slot === st.writer || cur.votes[slot] !== undefined) return null;
  const truth = [0, 1, 2].filter((i) => i !== cur.lieAt);
  const at = truth[(st.v + slot) % truth.length];
  return `Statement ${at + 1} is true. Trust me.`;
}

const truths = {
  id: 'truths',
  name: 'Two Truths and a Lie',
  emoji: '🤥',
  category: 'party',
  blurb: 'Write two truths and one fib about yourself. Spot everyone else’s lie.',
  minPlayers: 3,
  keys: [KEY],
  cards: ['swap', 'double', 'freeze', 'peek'],
  settings: [
    { id: 'write', label: 'Time to write', type: 'choice', options: [45, 60, 90, 120].map((v) => ({ value: v, label: `${v} s` })), default: 60 },
    { id: 'vote', label: 'Time to vote', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
  ],

  start(api) {
    api.memory.sets = {};
    startWrite(api);
  },

  intent(api, slot, action) {
    if (!action || typeof action !== 'object' || !Number.isInteger(slot)) return;
    if (action.type === 'set') return takeSet(api, slot, action);
    if (action.type === 'edit') {
      const st = api.get(KEY);
      if (!st || st.phase !== 'write' || action.n !== st.n || !st.done.includes(slot)) return;
      st.done = st.done.filter((s) => s !== slot);
      api.put(KEY, st);
      return;
    }
    if (action.type === 'vote') return takeVote(api, slot, action);
    return undefined;
  },

  deadline(api) {
    return advance(api);
  },

  hint(api, slot) {
    return truthsHint(api.get(KEY), api.memory.cur, slot);
  },

  awards(api) {
    funMem(api);
    const sharp = bestStreak(api, 2);
    return list(
      prize(api, 'fooled', 'Best poker face', '😐', (n) => (n === 1 ? 'Fooled 1 person' : `Fooled ${n} people`)),
      prize(api, 'spotted', 'Human lie detector', '🔍', (n) => (n === 1 ? 'Spotted 1 lie' : `Spotted ${n} lies`), 2),
      sharp ? { title: 'Mind reader', emoji: '🔮', who: sharp.slots, why: `Spotted ${sharp.n} lies in a row` } : null,
    );
  },

  highlights(api) {
    return reel(api);
  },

  texts(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'vote' && st.phase !== 'reveal') || !Array.isArray(st.s) || !Number.isInteger(st.writer)) return [];
    const cur = api.memory.cur;
    let lie = null;
    if (st.phase === 'reveal' && Number.isInteger(st.lie)) lie = st.lie;
    else if (cur && cur.v === st.v && Number.isInteger(cur.lieAt)) lie = cur.lieAt;
    return st.s
      .map((text, i) => {
        if (typeof text !== 'string' || !text) return null;
        const kind = lie === null ? '' : lie === i ? ', their lie' : ', one of their truths';
        return { r: statementRef(st.n, st.v || 0, i), author: st.writer, text, context: `Two Truths and a Lie, statement ${i + 1} of ${st.s.length}${kind}` };
      })
      .filter(Boolean);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['write', 'vote', 'reveal', 'end'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      advance(api);
      return true;
    }
    if (action.type === 'time' && Number.isFinite(action.ms)) {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return truths.start(api);
    api.memory.sets = {};
    api.memory.cur = null;
    const h = (st.h || 0) + 1;
    const now = api.now();
    if (st.phase === 'write') {
      const ends = Math.max(st.ends, now + RESUME_MIN_MS);
      api.put(KEY, { ...st, h, done: [], note: 'host', ends });
      api.setDeadline(ends);
      return undefined;
    }
    if (st.phase === 'vote') {
      const v = (st.v || 0) + 1;
      api.memory.cur = { v, writer: st.writer, lieAt: null, votes: {} };
      const ends = now + voteMs(api);
      api.put(KEY, { ...st, h, v, voted: [], note: 'host', starts: now, ends });
      api.setDeadline(ends);
      if (!liveSlots(api).includes(st.writer)) reveal(api);
      return undefined;
    }
    api.put(KEY, { ...st, h });
    if (api.deadline === null) api.setDeadline(Math.max(now, st.ends || now));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st || !Number.isInteger(slot) || st.in.includes(slot) || (st.late || []).includes(slot)) return;
    const late = (st.late || []).concat(slot).slice(-LATE_MAX);
    api.put(KEY, { ...st, late });
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st) return;
    if (st.phase === 'write' && allWritten(api, st)) endWrite(api);
    else if (st.phase === 'vote' && everyoneVoted(api, st) && answerReady(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const people = snap.players.filter((p) => p.slot !== null && p.slot !== undefined);
    const bySlot = new Map(people.map((p) => [p.slot, p]));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : null;
    };
    const faces = (slots) => (slots || []).map(faceOf).filter(Boolean);
    const present = people.filter((p) => p.present !== false && p.joined !== false).map((p) => p.slot);
    const base = {
      phase: st.phase,
      n: st.n,
      h: st.h || 0,
      v: st.v || 0,
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      me: mine,
      number: Math.min((st.i || 0) + 1, st.total || 0),
      total: st.total || 0,
    };
    if (st.phase === 'write') {
      const writer = mine !== null && st.in.includes(mine);
      return {
        ...base,
        writer,
        late: mine !== null && !writer,
        done: writer && st.done.includes(mine),
        doneCount: st.done.length,
        inCount: st.in.length,
        doneBy: faces(st.done),
      };
    }
    if (st.phase === 'end') {
      const pick = (b) => ({ people: faces(b && b.slots), n: b ? b.n : 0, isMe: Boolean(b && mine !== null && b.slots.includes(mine)) });
      return { ...base, liar: pick(st.liar), detective: pick(st.detective), empty: st.note === 'empty' };
    }
    const revealed = st.phase === 'reveal';
    const isWriter = mine !== null && mine === st.writer;
    const frozen = st.phase === 'vote' && mine !== null && iced(st).includes(mine);
    const canVote = st.phase === 'vote' && mine !== null && !isWriter && !frozen;
    const sent = local.v === st.v && Number.isInteger(local.pick) ? local.pick : null;
    const theirs = revealed && st.votes && mine !== null && st.votes[mine] !== undefined ? st.votes[mine] : null;
    const myPick = revealed ? theirs : sent;
    const lost = revealed && st.lie === null;
    const statements = (st.s || []).map((text, i) => ({
      i,
      text,
      isLie: revealed && st.lie === i,
      mine: myPick === i,
      voters: revealed
        ? faces(
            Object.entries(st.votes || {})
              .filter(([, p]) => p === i)
              .map(([s]) => Number(s)),
          )
        : [],
    }));
    const voters = present.filter((s) => s !== st.writer && !iced(st).includes(s));
    const gained = st.gained || {};
    const fooled = revealed && !lost ? Object.values(st.votes || {}).filter((p) => p !== st.lie).length : 0;
    return {
      ...base,
      writerFace: faceOf(st.writer) || { name: 'A player', initials: '?', hue: 20, isMe: false },
      isWriter,
      canVote: canVote && myPick === null,
      watching: mine === null,
      frozen,
      myPick,
      statements,
      voted: st.voted.length,
      voterCount: voters.length,
      votedBy: faces(st.voted),
      lost,
      lie: revealed ? st.lie : null,
      spotted: revealed && !lost && myPick !== null && myPick === st.lie,
      fooledMe: revealed && !lost && myPick !== null && myPick !== st.lie,
      fooled,
      totalVotes: revealed ? Object.keys(st.votes || {}).length : 0,
      myGain: mine !== null ? gained[mine] || 0 : 0,
      lieText: revealed && !lost ? st.s[st.lie] : null,
    };
  },
};

export default truths;
