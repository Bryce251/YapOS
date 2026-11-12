import { CATEGORIES, QUESTIONS, questionById } from '../../data/trivia.js';
import { shuffle } from '../engine.js';

export const KEY = 'trivia';
export const REVEAL_MS = 5000;
export const MIN_POINTS = 400;
export const MAX_POINTS = 1000;

const CAT_NAMES = new Map(CATEGORIES.map((c) => [c.id, c]));

export function speedPoints(at, starts, ends) {
  const span = Math.max(1, ends - starts);
  const left = Math.min(1, Math.max(0, (ends - at) / span));
  return Math.round((MIN_POINTS + (MAX_POINTS - MIN_POINTS) * left) / 10) * 10;
}

export function buildDeck(cats, count, random = Math.random) {
  const wanted = new Set(Array.isArray(cats) && cats.length ? cats : CATEGORIES.map((c) => c.id));
  let pool = QUESTIONS.filter((q) => wanted.has(q.cat));
  if (!pool.length) pool = QUESTIONS.slice();
  return shuffle(pool, random).slice(0, Math.max(1, count)).map((q) => q.id);
}

function ask(api, deck, i) {
  const q = questionById(deck[i]);
  if (!q) return finishOrNext(api, deck, i);
  const options = shuffle([q.a, ...q.w], api.random);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { qid: q.id, answer: options.indexOf(q.a), picks: {} };
  api.put(KEY, {
    deck,
    i,
    total: deck.length,
    phase: 'question',
    q: { id: q.id, cat: q.cat, text: q.q, options },
    answered: [],
    answer: null,
    chose: null,
    right: [],
    gained: {},
    skipped: false,
    starts,
    ends,
  });
  api.setDeadline(ends);
}

function finishOrNext(api, deck, i) {
  if (i + 1 < deck.length) return ask(api, deck, i + 1);
  return api.finish();
}

function reveal(api, skipped) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'question') return;
  const cur = api.memory.cur;
  const live = !skipped && cur && cur.qid === st.q.id;
  const chose = {};
  const right = [];
  const gained = {};
  let answer;
  if (live) {
    answer = cur.answer;
    for (const [slot, pick] of Object.entries(cur.picks)) {
      chose[slot] = pick.i;
      if (pick.i === answer) {
        const pts = speedPoints(pick.at, st.starts, st.ends);
        right.push(Number(slot));
        gained[slot] = pts;
        api.addPoints(Number(slot), pts);
      }
    }
  } else {
    const q = questionById(st.q.id);
    answer = q ? st.q.options.indexOf(q.a) : -1;
  }
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', answer, chose, right: right.sort((a, b) => a - b), gained, skipped: !live, ends });
  api.setDeadline(ends);
}

function everyoneAnswered(api, st) {
  const live = api.players().map((p) => p.slot);
  return live.length > 0 && live.every((s) => st.answered.includes(s));
}

const trivia = {
  id: 'trivia',
  name: 'Trivia',
  emoji: '🧠',
  blurb: 'Four choices, one right answer. The faster you are, the more you score.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Questions', type: 'choice', options: [5, 10, 15, 20].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to answer', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 20 },
    { id: 'cats', label: 'Categories', type: 'multi', options: CATEGORIES.map((c) => ({ value: c.id, label: `${c.emoji} ${c.name}` })), default: CATEGORIES.map((c) => c.id) },
  ],

  start(api) {
    const deck = buildDeck(api.settings.cats, api.settings.rounds, api.random);
    ask(api, deck, 0);
  },

  intent(api, slot, action) {
    if (action.type !== 'answer') return;
    const st = api.get(KEY);
    const cur = api.memory.cur;
    if (!st || st.phase !== 'question' || !cur || cur.qid !== st.q.id) return;
    if (action.q !== undefined && action.q !== st.q.id) return;
    const i = action.i;
    if (!Number.isInteger(i) || i < 0 || i >= st.q.options.length) return;
    if (cur.picks[slot] || st.answered.includes(slot)) return;
    const at = Math.min(api.now(), st.ends);
    cur.picks[slot] = { i, at };
    st.answered.push(slot);
    api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api, false);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'question') return reveal(api, false);
    return finishOrNext(api, st.deck, st.i);
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return trivia.start(api);
    if (st.phase === 'question') return reveal(api, true);
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  roster(api) {
    const st = api.get(KEY);
    if (st && st.phase === 'question' && everyoneAnswered(api, st)) reveal(api, false);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const mine = snap.meSlot;
    const myPick = st.phase === 'reveal' && st.chose && st.chose[mine] !== undefined ? st.chose[mine] : local.qid === st.q.id ? local.pick ?? null : null;
    const counts = st.q.options.map((_, i) => Object.values(st.chose || {}).filter((x) => x === i).length);
    const cat = CAT_NAMES.get(st.q.cat) || { name: 'Trivia', emoji: '❓' };
    return {
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      category: cat.name,
      emoji: cat.emoji,
      text: st.q.text,
      qid: st.q.id,
      ends: st.ends,
      starts: st.starts,
      answered: st.answered.length,
      players: snap.players.filter((p) => p.present).length,
      iAnswered: myPick !== null || (mine !== null && st.answered.includes(mine)),
      myPick,
      skipped: Boolean(st.skipped),
      options: st.q.options.map((text, i) => ({
        text,
        i,
        correct: st.phase === 'reveal' ? i === st.answer : null,
        mine: myPick === i,
        count: st.phase === 'reveal' ? counts[i] : null,
      })),
      right: (st.right || []).map((s) => bySlot.get(s)).filter(Boolean).map((p) => ({ name: p.name, id: p.id, pts: st.gained[p.slot] || 0 })),
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      gotIt: mine !== null && (st.right || []).includes(mine),
    };
  },
};

export default trivia;
