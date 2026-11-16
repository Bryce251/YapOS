import { STARTERS, starterById } from '../../data/story.js';
import { shuffle } from '../engine.js';
import { cleanShared } from '../text.js';
import { face } from './trivia.js';
import { award, roundAt, say, bump, most, prize, keep, reel, list, nameOf, funMem, isFrozen, thaw } from './funkit.js';

export const KEY = 'story';
export const LINE_PREFIX = 'story.l.';
export const LINE_MAX = 120;
export const MAX_LINES = 24;
export const VOTE_MS = 25000;
export const REVEAL_BASE_MS = 9000;
export const REVEAL_STEP_MS = 400;
export const REVEAL_MAX_MS = 20000;
export const LINE_POINTS = 25;
export const VOTE_POINTS = 100;
export const TOP_BONUS = 150;

export function lineKey(i) {
  return `${LINE_PREFIX}${i}`;
}

export function lineRef(run, i) {
  return `story.${run}.${i}`;
}

export function fitLine(raw) {
  return cleanShared(raw, LINE_MAX);
}

export function turnsFor(players, laps) {
  return Math.max(0, Math.min(MAX_LINES, players * laps));
}

export function revealMs(lines) {
  return Math.min(REVEAL_MAX_MS, REVEAL_BASE_MS + REVEAL_STEP_MS * Math.max(0, lines));
}

export function tally(authors, votes) {
  const count = {};
  const by = {};
  for (const i of Object.keys(authors)) {
    count[i] = 0;
    by[i] = [];
  }
  for (const [slot, i] of Object.entries(votes || {})) {
    if (count[i] === undefined) continue;
    count[i] += 1;
    by[i].push(Number(slot));
  }
  const best = Math.max(0, ...Object.values(count));
  const top = best > 0 ? Object.keys(count).filter((i) => count[i] === best).map(Number) : [];
  const gained = {};
  const res = Object.keys(authors)
    .map(Number)
    .map((i) => {
      const author = authors[i];
      const pts = count[i] * VOTE_POINTS + (top.includes(i) ? TOP_BONUS : 0);
      if (pts) gained[author] = (gained[author] || 0) + pts;
      return [i, author, count[i], by[i].sort((a, b) => a - b)];
    })
    .sort((a, b) => a[0] - b[0]);
  return { res, top, gained };
}

function here(api) {
  return new Set(api.players().map((p) => p.slot));
}

function readLines(get, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const v = get(lineKey(i));
    if (Array.isArray(v) && Number.isInteger(v[0]) && typeof v[1] === 'string') out.push({ i, by: v[0], text: v[1] });
  }
  return out;
}

function authorsOf(api, st) {
  const out = {};
  for (const l of readLines((k) => api.get(k), st.lines)) out[l.i] = l.by;
  return out;
}

function writerAt(api, st, from) {
  const live = here(api);
  for (let t = from; t < st.turns; t += 1) {
    const slot = st.order[t % st.order.length];
    if (live.has(slot)) return { t, slot };
  }
  return null;
}

export function lapsOf(st) {
  return st.order.length ? Math.max(1, Math.ceil(st.turns / st.order.length)) : 1;
}

function openTurn(api, st, from, note = null) {
  let pick = writerAt(api, st, from);
  let skipped = null;
  while (pick && isFrozen(api, pick.slot)) {
    thaw(api, pick.slot);
    skipped = pick.slot;
    pick = writerAt(api, st, pick.t + 1);
  }
  if (!pick) return toVote(api, st);
  if (Number.isInteger(skipped)) note = 'frozen';
  roundAt(api, Math.floor(pick.t / Math.max(1, st.order.length)) + 1, lapsOf(st) + 1);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.put(KEY, { ...st, phase: 'write', turn: pick.t, writer: pick.slot, note, iced: Number.isInteger(skipped) ? skipped : null, starts, ends });
  api.setDeadline(ends);
  return undefined;
}

function voters(api, st, authors) {
  const mine = Object.values(authors);
  return [...here(api)].filter((s) => mine.some((a) => a !== s));
}

function toVote(api, st) {
  const authors = authorsOf(api, st);
  if (!Object.keys(authors).length || !voters(api, st, authors).length) return showReveal(api, st, authors, {});
  api.memory.cur = { run: st.run, votes: {} };
  roundAt(api, lapsOf(st) + 1, lapsOf(st) + 1);
  const starts = api.now();
  const ends = starts + VOTE_MS;
  const next = { ...st, phase: 'vote', writer: null, voted: [], note: null, starts, ends };
  api.put(KEY, next);
  api.setDeadline(ends);
  return undefined;
}

function showReveal(api, st, authors, votes) {
  const { res, top, gained } = tally(authors, votes);
  for (const [slot, pts] of Object.entries(gained)) gained[slot] = award(api, slot, pts);
  const paid = Number.isInteger(st.paid) ? st.paid : 0;
  for (const [i, by] of Object.entries(authors)) if (Number(i) >= paid) award(api, by, LINE_POINTS, { raw: true });
  noteReveal(api, st, authors, res, top);
  api.memory.cur = null;
  api.memory.top = top.map((i) => authors[i]).filter(Number.isInteger);
  const starts = api.now();
  const ends = starts + revealMs(st.lines);
  api.put(KEY, { ...st, phase: 'reveal', writer: null, paid: st.lines, res, top, gained, starts, ends });
  api.setDeadline(ends);
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote') return;
  const cur = api.memory.cur && api.memory.cur.run === st.run ? api.memory.cur : null;
  showReveal(api, st, authorsOf(api, st), cur ? cur.votes : {});
}

function allVoted(api, st) {
  const need = voters(api, st, authorsOf(api, st));
  return need.every((s) => st.voted.includes(s));
}

function addLine(api, st, slot, text) {
  api.put(lineKey(st.lines), [slot, text]);
  const paid = Number.isInteger(st.paid) ? st.paid : 0;
  const fresh = paid === st.lines;
  if (fresh) award(api, slot, LINE_POINTS);
  bump(api, 'lines', slot);
  bump(api, 'chars', slot, Array.from(text).length);
  return openTurn(api, { ...st, lines: st.lines + 1, paid: fresh ? st.lines + 1 : paid }, st.turn + 1);
}

function noteReveal(api, st, authors, res, top) {
  const fx = funMem(api);
  const lines = readLines((k) => api.get(k), st.lines);
  const textAt = new Map(lines.map((l) => [l.i, l.text]));
  const ranked = res.filter((r) => r[2] > 0).sort((a, b) => b[2] - a[2] || a[0] - b[0]);
  for (const r of ranked.slice(0, 4)) {
    const text = textAt.get(r[0]);
    if (text) keep(api, `"${text}" by ${nameOf(api, r[1])} (${r[2] === 1 ? '1 vote' : `${r[2]} votes`})`, r[1], r[2] + (top.includes(r[0]) ? 1 : 0));
  }
  for (const r of res) bump(api, 'votes', r[1], r[2]);
  fx.top = top.map((i) => authors[i]).filter(Number.isInteger);
  if (top.length === 1 && ranked.length) say(api, 'custom', { text: `📖 ${nameOf(api, authors[top[0]])} wrote the best line!` });
}

function onLine(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write' || action.t !== st.turn || st.writer !== slot) return;
  const text = fitLine(action.text);
  if (!text) return;
  addLine(api, st, slot, text);
}

function onPass(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'write' || action.t !== st.turn || st.writer !== slot) return;
  openTurn(api, st, st.turn + 1);
}

function onVote(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'vote' || !Number.isInteger(action.i)) return;
  const cur = api.memory.cur && api.memory.cur.run === st.run ? api.memory.cur : null;
  if (!cur || cur.votes[slot] !== undefined) return;
  const authors = authorsOf(api, st);
  if (authors[action.i] === undefined || authors[action.i] === slot) return;
  if (!here(api).has(slot)) return;
  cur.votes[slot] = action.i;
  if (!st.voted.includes(slot)) st.voted.push(slot);
  api.put(KEY, st);
  if (allVoted(api, st)) reveal(api);
}

function clearLines(api) {
  for (const k of api.keys()) if (k.startsWith(LINE_PREFIX)) api.put(k, null);
}

const story = {
  id: 'story',
  name: 'Story Builder',
  emoji: '📖',
  category: 'party',
  blurb: 'Take turns adding one sentence to a silly story. Then vote for the best line.',
  minPlayers: 2,
  keys: [KEY],
  prefixes: [LINE_PREFIX],
  cards: ['swap', 'double', 'freeze'],
  settings: [
    { id: 'laps', label: 'Laps', type: 'choice', options: [2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
    { id: 'timer', label: 'Time per line', type: 'choice', options: [20, 30, 45, 60].map((v) => ({ value: v, label: `${v} s` })), default: 30 },
  ],

  canFreeze(api, to) {
    const st = api.get(KEY);
    return Boolean(st && st.phase === 'write' && st.order.includes(to) && writerAt(api, st, st.turn + 1));
  },

  awards(api) {
    funMem(api);
    const chars = most(api, 'chars');
    const lines = most(api, 'lines');
    let wordy = null;
    if (chars && lines) {
      const t = api.memory.fx.n;
      let best = 0;
      for (const [k, c] of Object.entries(t.chars || {})) {
        const avg = c / Math.max(1, t.lines[k] || 1);
        if (avg > best) {
          best = avg;
          wordy = Number(k);
        }
      }
      if (best < 60) wordy = null;
    }
    return list(
      prize(api, 'votes', 'Fan favourite', '📖', (n) => (n === 1 ? 'Got 1 vote' : `Got ${n} votes`), 2),
      Number.isInteger(wordy) ? { title: 'Novelist', emoji: '✍️', who: wordy, why: 'Wrote the longest lines' } : null,
    );
  },

  highlights(api) {
    return reel(api);
  },

  start(api) {
    clearLines(api);
    const order = shuffle(api.players().map((p) => p.slot), api.random);
    const pick = STARTERS[Math.floor(api.random() * STARTERS.length)] || STARTERS[0];
    const run = 1 + Math.floor(api.random() * 1e9);
    api.memory.cur = null;
    api.memory.top = [];
    const st = { v: 1, run, start: pick.id, order, turns: turnsFor(order.length, api.settings.laps), turn: 0, lines: 0, phase: 'write', writer: null, voted: [], res: null, top: [], gained: {}, note: null, starts: 0, ends: 0 };
    openTurn(api, st, 0);
  },

  results(api) {
    const top = Array.isArray(api.memory.top) ? [...new Set(api.memory.top.filter(Number.isInteger))] : [];
    return { extra: top.length ? { topLine: top } : {} };
  },

  intent(api, slot, action) {
    if (action.type === 'line') onLine(api, slot, action);
    else if (action.type === 'pass') onPass(api, slot, action);
    else if (action.type === 'vote') onVote(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'write') return openTurn(api, st, st.turn + 1);
    if (st.phase === 'vote') return reveal(api);
    clearLines(api);
    return api.finish();
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['write', 'vote', 'reveal'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      story.deadline(api);
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

  texts(api) {
    const st = api.get(KEY);
    if (!st || !st.lines) return [];
    const starter = starterById(st.start);
    return readLines((k) => api.get(k), st.lines).map((l) => ({ r: lineRef(st.run, l.i), author: l.by, text: l.text, context: starter ? `Story Builder, a story that starts “${starter.text}”` : 'Story Builder line' }));
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return story.start(api);
    if (st.phase === 'vote' && !(api.memory.cur && api.memory.cur.run === st.run)) {
      api.memory.cur = { run: st.run, votes: {} };
      const starts = api.now();
      const ends = starts + VOTE_MS;
      api.put(KEY, { ...st, voted: [], note: 'host', starts, ends });
      api.setDeadline(ends);
      return undefined;
    }
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st || !Number.isInteger(slot) || st.order.includes(slot)) return;
    api.put(KEY, { ...st, order: st.order.concat([slot]) });
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st) return;
    const live = here(api);
    const missing = [...live].filter((s) => !st.order.includes(s));
    const next = missing.length ? { ...st, order: st.order.concat(missing) } : st;
    if (missing.length) api.put(KEY, next);
    if (next.phase === 'write' && !live.has(next.writer)) return openTurn(api, next, next.turn + 1);
    if (next.phase === 'vote' && allVoted(api, next)) return reveal(api);
    return undefined;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !Array.isArray(st.order)) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const present = new Set(snap.players.filter((p) => p.present).map((p) => p.slot));
    const faceOf = (slot) => {
      const p = bySlot.get(slot);
      return p ? face(p, mine) : { id: null, name: 'Someone', initials: '?', hue: 20, avatar: null, isMe: false };
    };
    const starter = starterById(st.start);
    const lines = readLines((k) => snap.state[k], st.lines).map((l) => ({ i: l.i, text: l.text, by: faceOf(l.by), mine: l.by === mine, ref: l.by === mine ? null : lineRef(st.run, l.i) }));
    const upcoming = [];
    for (let t = st.turn + 1; t < st.turns && upcoming.length < 3; t += 1) {
      const slot = st.order[t % st.order.length];
      if (present.has(slot)) upcoming.push(faceOf(slot));
    }
    const myTurn = st.phase === 'write' && st.writer === mine && mine !== null;
    const sent = local.run === st.run && local.turn === st.turn && st.phase === 'write';
    const myVote = local.run === st.run && Number.isInteger(local.vote) ? local.vote : null;
    const voted = mine !== null && Array.isArray(st.voted) && st.voted.includes(mine);
    const choosable = lines.some((l) => !l.mine);
    const res = Array.isArray(st.res) ? new Map(st.res.map((r) => [r[0], r])) : new Map();
    const top = new Set(Array.isArray(st.top) ? st.top : []);
    return {
      phase: st.phase,
      run: st.run,
      starter: starter ? starter.text : '',
      lines: lines.map((l) => {
        const r = res.get(l.i);
        return { ...l, votes: r ? r[2] : 0, voters: r ? r[3].map(faceOf) : [], top: top.has(l.i), gain: st.phase === 'reveal' && r ? r[2] * VOTE_POINTS + (top.has(l.i) ? TOP_BONUS : 0) : 0 };
      }),
      turn: st.turn,
      turns: st.turns,
      lap: st.order.length ? Math.floor(st.turn / st.order.length) + 1 : 1,
      laps: st.order.length ? Math.ceil(st.turns / st.order.length) : 1,
      writer: st.writer !== null && st.writer !== undefined ? faceOf(st.writer) : null,
      upcoming,
      myTurn,
      canWrite: myTurn && !sent,
      sent,
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      iced: st.phase === 'write' && Number.isInteger(st.iced) ? faceOf(st.iced) : null,
      playing: mine !== null && st.order.includes(mine),
      canVote: st.phase === 'vote' && mine !== null && present.has(mine) && !voted && myVote === null && choosable,
      hasVoted: voted || myVote !== null,
      myVote,
      onlyMine: st.phase === 'vote' && !choosable && lines.length > 0,
      voted: Array.isArray(st.voted) ? st.voted.length : 0,
      votedBy: (Array.isArray(st.voted) ? st.voted : []).map(faceOf),
      myGain: st.phase === 'reveal' && mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      topLines: [...top],
    };
  },
};

export default story;
