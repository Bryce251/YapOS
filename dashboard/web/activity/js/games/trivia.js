import { CATEGORIES, QUESTIONS, TIERS, questionById } from '../../data/trivia.js';
import { shuffle } from '../engine.js';
import { person } from '../players.js';
import { TEAM_MS, teamSetting, wantsTeams, splitTeams, placeLate, teamOf, teamWinners, teamNames, teamBoard } from './teams.js';
import { PACK_STEP_MS, PACK_EMOJI, packSetting, packCode, packStep, packFor, packTrivia } from './packs.js';

export const KEY = 'trivia';
export const PACK_CAT = 'pack';
export const PACK_PREFIX = '~';
const PACK_ID_RE = /^~\d{1,3}$/;
export const REVEAL_MS = 5000;
export const MIN_POINTS = 400;
export const MAX_POINTS = 1000;
export const LATE_MIN_MS = 4000;

const CAT_NAMES = new Map(CATEGORIES.map((c) => [c.id, c]));
const TIER_BY_ID = new Map(TIERS.map((t) => [t.id, t]));
const TIER_ORDER = TIERS.map((t) => t.id);
export const MIX = 'mix';

export function tierOf(id) {
  return TIER_BY_ID.get(id) || TIER_BY_ID.get('easy');
}

export function speedPoints(at, starts, ends, tier = 'easy') {
  const span = Math.max(1, ends - starts);
  const left = Math.min(1, Math.max(0, (ends - at) / span));
  const base = MIN_POINTS + (MAX_POINTS - MIN_POINTS) * left;
  return Math.round((base * tierOf(tier).mult) / 10) * 10;
}

function nearest(tier) {
  const at = TIER_ORDER.indexOf(tier);
  return TIER_ORDER.slice().sort((a, b) => Math.abs(TIER_ORDER.indexOf(a) - at) - Math.abs(TIER_ORDER.indexOf(b) - at) || TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
}

function draw(pool, tier, n, used, random) {
  const out = [];
  for (const t of nearest(tier)) {
    if (out.length >= n) break;
    const fresh = shuffle(pool.filter((q) => q.tier === t && !used.has(q.id)), random);
    for (const q of fresh.slice(0, n - out.length)) {
      used.add(q.id);
      out.push(q);
    }
  }
  return out;
}

export function rampFor(count) {
  const n = Math.max(1, count);
  const easy = Math.ceil(n / 3);
  const hard = Math.floor(n / 3);
  return [
    ['easy', easy],
    ['medium', n - easy - hard],
    ['hard', hard],
  ];
}

export function buildDeck(cats, count, random = Math.random, level = MIX) {
  const wanted = new Set(Array.isArray(cats) && cats.length ? cats : CATEGORIES.map((c) => c.id));
  let pool = QUESTIONS.filter((q) => wanted.has(q.cat));
  if (!pool.length) pool = QUESTIONS.slice();
  const n = Math.max(1, Math.min(count, pool.length));
  const used = new Set();
  if (TIER_BY_ID.has(level)) return shuffle(draw(pool, level, n, used, random), random).map((q) => q.id);
  const deck = [];
  for (const [tier, k] of rampFor(n)) deck.push(...shuffle(draw(pool, tier, k, used, random), random));
  return deck.map((q) => q.id);
}

export function isPackId(id) {
  return typeof id === 'string' && PACK_ID_RE.test(id);
}

export function packDeck(questions, count, random = Math.random) {
  const list = Array.isArray(questions) ? questions : [];
  return shuffle(list.map((_, i) => i), random)
    .slice(0, Math.max(0, count))
    .map((i) => `${PACK_PREFIX}${i}`);
}

export function deckWithPack(questions, cats, count, random = Math.random, level = MIX) {
  const head = packDeck(questions, count, random);
  const left = count - head.length;
  return left > 0 ? head.concat(buildDeck(cats, left, random, level)) : head;
}

export function hideAnswer(answer, salt, n) {
  return (answer + salt) % n;
}

export function showAnswer(q) {
  if (!q || !Array.isArray(q.options) || !Number.isInteger(q.x) || !Number.isInteger(q.s)) return -1;
  const n = q.options.length;
  return (((q.x - q.s) % n) + n) % n;
}

function carryOf(st) {
  return { tm: (st && st.tm) || null, pk: (st && st.pk) || null, pm: (st && st.pm) || null };
}

function packQuestion(api, carry, id) {
  if (!carry.pk) return null;
  const pack = packFor(api, carry.pk.c);
  if (!pack) return null;
  const list = packTrivia(pack.trivia);
  const q = list[Number(id.slice(PACK_PREFIX.length))];
  return q ? { id, cat: PACK_CAT, tier: PACK_CAT, q: q.q, a: q.a, w: q.w } : null;
}

function swapIn(api, deck) {
  const fresh = buildDeck(api.settings.cats, deck.length + 5, api.random, api.settings.level).find((id) => !deck.includes(id));
  return fresh ? questionById(fresh) : null;
}

function ask(api, deck, i, carry = carryOf(api.get(KEY))) {
  let q = isPackId(deck[i]) ? packQuestion(api, carry, deck[i]) : questionById(deck[i]);
  if (!q && isPackId(deck[i])) {
    q = swapIn(api, deck);
    if (q) deck = deck.map((id, k) => (k === i ? q.id : id));
  }
  if (!q) return finishOrNext(api, deck, i, carry);
  const options = shuffle([q.a, ...q.w], api.random);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const answer = options.indexOf(q.a);
  const salt = q.cat === PACK_CAT ? Math.floor(api.random() * 1000) : 0;
  api.memory.cur = { qid: q.id, answer, picks: {} };
  const placed = carry.tm ? placeLate(carry.tm, api.players().map((p) => p.slot), api.points()) : null;
  api.put(KEY, {
    deck,
    i,
    total: deck.length,
    phase: 'question',
    q: q.cat === PACK_CAT ? { id: q.id, cat: q.cat, tier: q.tier, text: q.q, options, s: salt, x: hideAnswer(answer, salt, options.length) } : { id: q.id, cat: q.cat, tier: q.tier, text: q.q, options },
    tm: placed || carry.tm,
    pk: carry.pk,
    pm: carry.pm,
    in: api.players().map((p) => p.slot),
    wait: [],
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

function finishOrNext(api, deck, i, carry) {
  if (i + 1 < deck.length) return carry ? ask(api, deck, i + 1, carry) : ask(api, deck, i + 1);
  const st = api.get(KEY);
  if (st && st.tm) {
    const starts = api.now();
    const ends = starts + TEAM_MS;
    api.put(KEY, { ...st, phase: 'final', starts, ends });
    api.setDeadline(ends);
    return undefined;
  }
  return api.finish();
}

function begin(api) {
  const code = packCode(api.settings);
  const step = packStep(api, code);
  if (step.state === 'wait') {
    api.setDeadline(api.now() + PACK_STEP_MS);
    return;
  }
  const pack = step.state === 'ready' ? step.pack : null;
  const questions = pack ? packTrivia(pack.trivia) : [];
  api.memory.pack = pack;
  const present = api.players().map((p) => p.slot);
  const tm = wantsTeams(api.settings) && present.length >= 2 ? splitTeams(present, api.random) : null;
  const pk = questions.length ? { c: code, n: pack.name } : null;
  const pm = step.state === 'fail' || (pack && !questions.length) ? code : null;
  const deck = deckWithPack(questions, api.settings.cats, api.settings.rounds, api.random, api.settings.level);
  ask(api, deck, 0, { tm, pk, pm });
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
        const pts = speedPoints(pick.at, st.starts, st.ends, st.q.tier);
        right.push(Number(slot));
        gained[slot] = pts;
        api.addPoints(Number(slot), pts);
      }
    }
  } else if (st.q.cat === PACK_CAT) {
    answer = showAnswer(st.q);
  } else {
    const q = questionById(st.q.id);
    answer = q ? st.q.options.indexOf(q.a) : -1;
  }
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', answer, chose, right: right.sort((a, b) => a - b), gained, skipped: !live, ends });
  api.setDeadline(ends);
}

function placeTeams(api, st) {
  if (!st || !st.tm) return false;
  const next = placeLate(st.tm, api.players().map((p) => p.slot), api.points());
  if (!next) return false;
  st.tm = next;
  return true;
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : null;
}

function everyoneAnswered(api, st) {
  const playing = inPlay(st);
  const live = api.players().map((p) => p.slot).filter((s) => !playing || playing.includes(s));
  return live.length > 0 && live.every((s) => st.answered.includes(s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'question') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

export function face(p, mine) {
  const known = person({ id: p.id, name: p.name }) || {};
  return {
    id: p.id,
    name: p.name,
    username: p.username || known.username || null,
    initials: p.initials || known.initials || '?',
    hue: p.hue ?? known.hue ?? 20,
    avatar: p.avatar || known.avatar || null,
    isMe: mine !== null && mine !== undefined && p.slot === mine,
  };
}

const trivia = {
  id: 'trivia',
  name: 'Trivia',
  category: 'quiz',
  emoji: '🧠',
  blurb: 'Four choices, one right answer. The faster you are, the more you score.',
  minPlayers: 1,
  keys: [KEY],
  settings: [
    { id: 'rounds', label: 'Questions', type: 'choice', options: [5, 10, 15, 20].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to answer', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 20 },
    {
      id: 'level',
      label: 'Difficulty',
      type: 'choice',
      options: [{ value: MIX, label: '🎲 Mixed, gets harder' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))),
      default: MIX,
    },
    { id: 'cats', label: 'Categories', type: 'multi', options: CATEGORIES.map((c) => ({ value: c.id, label: `${c.emoji} ${c.name}` })), default: CATEGORIES.map((c) => c.id) },
    teamSetting(),
    packSetting(),
  ],

  start(api) {
    begin(api);
  },

  results(api) {
    const st = api.get(KEY);
    return st && st.tm ? { teams: teamNames(st.tm) } : {};
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
    if (inPlay(st) && !st.in.includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!st.in.includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    const at = Math.min(api.now(), st.ends);
    cur.picks[slot] = { i, at };
    st.answered.push(slot);
    api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api, false);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return begin(api);
    if (st.phase === 'final') return api.finish(teamWinners(st.tm, api.points()).slots);
    if (st.phase === 'question') return reveal(api, false);
    return finishOrNext(api, st.deck, st.i);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'question' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      if (st.phase === 'question') reveal(api, false);
      else finishOrNext(api, st.deck, st.i);
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
    if (!st) return trivia.start(api);
    if (st.phase === 'question') return reveal(api, true);
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (!st) return;
    const placed = placeTeams(api, st);
    if (admit(api, st, slot) || placed) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase === 'final') return;
    let added = placeTeams(api, st);
    if (st.phase !== 'question') {
      if (added) api.put(KEY, st);
      return;
    }
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api, false);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const mine = snap.meSlot;
    const playing = inPlay(st);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || (playing ? !playing.includes(mine) : false));
    const myPick = st.phase === 'reveal' && st.chose && st.chose[mine] !== undefined ? st.chose[mine] : local.qid === st.q.id ? local.pick ?? null : null;
    const counts = st.q.options.map((_, i) => Object.values(st.chose || {}).filter((x) => x === i).length);
    const fromPack = st.q.cat === PACK_CAT;
    const cat = fromPack ? { name: (st.pk && st.pk.n) || 'Word pack', emoji: PACK_EMOJI } : CAT_NAMES.get(st.q.cat) || { name: 'Trivia', emoji: '❓' };
    const tier = tierOf(st.q.tier);
    const myTeam = st.tm ? teamOf(st.tm, mine) : null;
    return {
      teams: st.tm ? teamBoard(st.tm, snap.players, snap.scores, mine) : null,
      myTeam,
      pack: st.pk ? { code: st.pk.c, name: st.pk.n } : null,
      packMiss: st.pm || null,
      fromPack,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      category: cat.name,
      emoji: cat.emoji,
      tier: fromPack ? null : tier.id,
      tierName: tier.name,
      tierEmoji: tier.emoji,
      tierBonus: tier.mult > 1 ? `×${tier.mult}` : '',
      text: st.q.text,
      qid: st.q.id,
      ends: st.ends,
      starts: st.starts,
      answered: st.answered.length,
      players: playing ? playing.length : snap.players.filter((p) => p.present).length,
      answeredBy: st.answered.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      waiting,
      watching,
      canAnswer: st.phase === 'question' && !waiting && !watching,
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
      right: (st.right || []).map((s) => bySlot.get(s)).filter(Boolean).map((p) => ({ ...face(p, mine), pts: st.gained[p.slot] || 0, team: st.tm ? teamOf(st.tm, p.slot) : null })),
      myGain: mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      gotIt: mine !== null && (st.right || []).includes(mine),
    };
  },
};

export default trivia;
