import { TUNES, KINDS, tuneById, tunesIn } from '../../data/musicquiz.js';
import { shuffle } from '../engine.js';
import { mask, unmask } from './draw.js';
import { face } from './trivia.js';
import { award, roundAt, say, streak, bump, prize, bestStreak, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'musicquiz';
export const LEAD_MS = 1800;
export const REVEAL_MS = 6000;
export const MAX_POINTS = 1000;
export const MIN_POINTS = 400;
export const LATE_MIN_MS = 5000;
export const CHOICES = 4;
export const CLIP_SECONDS = 12;
export const MIX = 'mix';
export const FAST_MS = 3000;

export function musicHint(st, cur, slot) {
  if (!st || st.phase !== 'listen' || !cur || cur.n !== st.n || cur.picks[slot]) return null;
  const wrong = st.c.map((id, i) => i).filter((i) => i !== cur.answer);
  if (!wrong.length) return null;
  const t = tuneById(st.c[wrong[(st.n + slot) % wrong.length]]);
  return t ? `It's not "${t.title}".` : null;
}

export function speedPoints(at, starts, ends) {
  const span = Math.max(1, ends - starts);
  const used = Math.min(1, Math.max(0, (at - starts) / span));
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * used);
}

export function pool(kind) {
  return kind && kind !== MIX && KINDS.some((k) => k.id === kind) ? tunesIn(kind) : TUNES.slice();
}

export function buildDeck(count, kind, random = Math.random) {
  return shuffle(pool(kind), random)
    .slice(0, Math.max(1, count))
    .map((t) => t.id);
}

export function choicesFor(id, random = Math.random) {
  const tune = tuneById(id);
  if (!tune) return [];
  const same = shuffle(TUNES.filter((t) => t.id !== id && t.kind === tune.kind), random);
  const rest = shuffle(TUNES.filter((t) => t.id !== id && t.kind !== tune.kind), random);
  const others = same.slice(0, 2).concat(rest).slice(0, CHOICES - 1);
  return shuffle([id, ...others.map((t) => t.id)], random);
}

export function midiHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function schedule(tune, limit = CLIP_SECONDS) {
  if (!tune || !Array.isArray(tune.notes)) return [];
  const beat = 60 / (tune.bpm || 100);
  const out = [];
  let t = 0;
  for (const [midi, beats] of tune.notes) {
    const dur = beats * beat;
    if (t >= limit) break;
    if (midi > 0) out.push({ at: t, dur: Math.min(dur, limit - t), hz: midiHz(midi) });
    t += dur;
  }
  return out;
}

export function clipLength(tune, limit = CLIP_SECONDS) {
  const notes = schedule(tune, limit);
  if (!notes.length) return 0;
  const last = notes[notes.length - 1];
  return last.at + last.dur;
}

function tuneOf(st) {
  if (!st || !Array.isArray(st.deck)) return null;
  return tuneById(unmask(st.deck[st.i], st.k));
}

function ask(api, st0, i, note = null) {
  const { deck, k } = st0;
  const tune = tuneById(unmask(deck[i], k));
  if (!tune) return next(api, { ...st0, i });
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const c = choicesFor(tune.id, api.random);
  const shown = api.now();
  const starts = shown + LEAD_MS;
  const ends = starts + api.settings.timer * 1000;
  api.memory.cur = { n, answer: c.indexOf(tune.id), picks: {} };
  roundAt(api, i + 1, deck.length);
  api.put(KEY, {
    v: 1,
    n,
    k,
    deck,
    i,
    total: deck.length,
    phase: 'listen',
    c,
    in: api.players().map((p) => p.slot),
    wait: [],
    answered: [],
    answer: null,
    chose: null,
    right: [],
    gained: {},
    note,
    shown,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, st) {
  if (st.i + 1 < st.deck.length && api.players().length) return ask(api, st, st.i + 1);
  return api.finish();
}

function fresh(api, st) {
  const cur = api.memory.cur;
  return cur && cur.n === st.n ? cur : null;
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'listen') return;
  const tune = tuneOf(st);
  const answer = tune ? st.c.indexOf(tune.id) : -1;
  const cur = fresh(api, st);
  const chose = {};
  const right = [];
  const gained = {};
  let quick = null;
  for (const [slot, pick] of Object.entries(cur ? cur.picks : {})) {
    chose[slot] = pick.i;
    const s = Number(slot);
    streak(api, s, pick.i === answer);
    if (pick.i !== answer) continue;
    right.push(s);
    gained[slot] = award(api, s, speedPoints(pick.at, st.starts, st.ends));
    bump(api, 'right', s);
    const ms = Math.max(0, pick.at - st.starts);
    if (!quick || ms < quick.ms) quick = { slot: s, ms };
  }
  if (quick && tune) {
    if (quick.ms <= FAST_MS) say(api, 'fast', { slot: quick.slot });
    const fx = funMem(api);
    if (!fx.quick || quick.ms < fx.quick.ms) fx.quick = { ...quick, title: tune.title };
  }
  if (tune && cur) {
    for (const [slot, pick] of Object.entries(cur.picks)) {
      if (pick.i === answer) continue;
      const wrong = tuneById(st.c[pick.i]);
      if (wrong) keep(api, `${nameOf(api, Number(slot))} heard ${tune.title} and was sure it was ${wrong.title}`, Number(slot), right.length ? 1 + right.length / 4 : 0.5);
    }
  }
  api.memory.cur = null;
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', answer, chose, right: right.sort((a, b) => a - b), gained, starts, ends });
  api.setDeadline(ends);
}

function inPlay(st) {
  return Array.isArray(st.in) ? st.in : [];
}

function everyoneAnswered(api, st) {
  const live = api.players().map((p) => p.slot).filter((s) => inPlay(st).includes(s));
  return live.length > 0 && live.every((s) => st.answered.includes(s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || st.phase !== 'listen') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

const musicquiz = {
  id: 'musicquiz',
  name: 'Music Quiz',
  emoji: '🎵',
  category: 'quiz',
  blurb: 'Hear a famous old tune and name it before everyone else. Faster answers score more.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Tunes', type: 'choice', options: [5, 8, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 8 },
    { id: 'timer', label: 'Time to answer', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    {
      id: 'kind',
      label: 'Tunes from',
      type: 'choice',
      options: [{ value: MIX, label: 'Everything' }].concat(KINDS.map((k) => ({ value: k.id, label: k.name }))),
      default: MIX,
    },
  ],

  start(api) {
    const k = 1 + Math.floor(api.random() * 65534);
    const deck = buildDeck(api.settings.rounds, api.settings.kind, api.random).map((id) => mask(id, k));
    ask(api, { deck, k }, 0);
  },

  intent(api, slot, action) {
    if (action.type !== 'answer' || !Number.isInteger(action.i)) return;
    const st = api.get(KEY);
    if (!st || st.phase !== 'listen' || action.n !== st.n) return;
    if (action.i < 0 || action.i >= st.c.length) return;
    const cur = fresh(api, st);
    if (!cur || cur.picks[slot]) return;
    if (!inPlay(st).includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!inPlay(st).includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    cur.picks[slot] = { i: action.i, at: Math.max(api.now(), st.starts) };
    if (!st.answered.includes(slot)) st.answered.push(slot);
    api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api);
  },

  hint(api, slot) {
    const st = api.get(KEY);
    return musicHint(st, st ? fresh(api, st) : null, slot);
  },

  awards(api) {
    const fx = funMem(api);
    const hot = bestStreak(api);
    const q = fx.quick;
    return list(
      prize(api, 'right', 'Golden ears', '🎧', (n) => `Named ${n} tunes`, 3),
      hot ? { title: 'Perfect pitch', emoji: '🎼', who: hot.slots, why: `${hot.n} tunes in a row` } : null,
      q && q.ms <= FAST_MS ? { title: 'Name that tune', emoji: '⚡', who: q.slot, why: `Got ${q.title} in ${(q.ms / 1000).toFixed(1)} s` } : null,
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'listen') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'listen' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      musicquiz.deadline(api);
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
    if (!st) return musicquiz.start(api);
    if (st.phase === 'listen' && !fresh(api, st)) return ask(api, st, st.i, 'host');
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'listen') return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api);
  },

  tuneOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    return st ? tuneOf(st) : null;
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || !Array.isArray(st.c)) return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const revealed = st.phase === 'reveal';
    const playing = mine !== null && inPlay(st).includes(mine);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const myPick = revealed && st.chose && st.chose[mine] !== undefined ? st.chose[mine] : local.n === st.n && Number.isInteger(local.pick) ? local.pick : null;
    const tune = revealed ? tuneOf(st) : null;
    const counts = st.c.map((_, i) => (revealed && st.chose ? Object.values(st.chose).filter((x) => x === i).length : null));
    return {
      phase: st.phase,
      n: st.n,
      number: st.i + 1,
      total: st.total,
      shown: st.shown,
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      options: st.c.map((id, i) => {
        const t = tuneById(id);
        return { i, text: t ? t.title : '???', mine: myPick === i, correct: revealed ? i === st.answer : null, count: counts[i] };
      }),
      playing,
      waiting,
      watching: !playing && !waiting,
      canAnswer: st.phase === 'listen' && playing && myPick === null,
      iAnswered: myPick !== null,
      myPick,
      answered: st.answered.length,
      players: inPlay(st).filter((s) => bySlot.has(s) && bySlot.get(s).present).length,
      answeredBy: st.answered.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      title: tune ? tune.title : null,
      by: tune ? tune.by : null,
      gotIt: revealed && mine !== null && Array.isArray(st.right) && st.right.includes(mine),
      myGain: revealed && mine !== null && st.gained ? st.gained[mine] || 0 : 0,
      right: revealed ? (st.right || []).map((s) => (bySlot.get(s) ? { ...face(bySlot.get(s), mine), pts: st.gained[s] || 0 } : null)).filter(Boolean) : [],
    };
  },
};

export default musicquiz;
