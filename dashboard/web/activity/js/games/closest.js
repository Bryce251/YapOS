import { QUESTIONS, CATS, YEAR, questionById, questionsIn, catById } from '../../data/closest.js';
import { shuffle } from '../engine.js';
import { mask, unmask } from './draw.js';
import { face } from './trivia.js';
import { award, roundAt, say, streak, bump, prize, bestStreak, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'closest';
export const REVEAL_MS = 7000;
export const LATE_MIN_MS = 4000;
export const NEAR_POINTS = 500;
export const CLOSEST_POINTS = 300;
export const EXACT_POINTS = 300;
export const LOG_RANGE = Math.log(4);
export const MAX_GUESS = 1e15;
export const MIX = 'mix';

const ROASTS = [
  '🤡 {a} guessed {g}. Bold. Wrong, but bold.',
  '🛸 {a} said {g}. Which planet are you guessing from?',
  '🎯 {a} went for {g}. The target was in a different building.',
  '🙃 {a} guessed {g}. Confidence: 100%. Accuracy: less.',
  '📏 {a} said {g}. Someone check their ruler.',
  '🧭 {a} guessed {g} and wandered right off the map.',
];

const SUFFIX = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

export function parseGuess(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && Math.abs(raw) <= MAX_GUESS ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/[\s,_']/g, '').replace(/^−/, '-');
  const m = /^(-?)(\d+(?:\.\d+)?|\.\d+)([a-z]*)$/.exec(text);
  if (!m) return null;
  let n = Number(m[2]);
  if (m[3]) {
    const k = SUFFIX[m[3]];
    if (!k) return null;
    n *= k;
  }
  if (m[1]) n = -n;
  if (!Number.isFinite(n) || Math.abs(n) > MAX_GUESS) return null;
  return Math.round(n * 1000) / 1000;
}

export function isYear(q) {
  return Boolean(q) && q.unit === YEAR;
}

export function linear(q) {
  return Boolean(q) && (Number.isFinite(q.span) || q.a <= 0);
}

export function missOf(q, g) {
  if (!q || !Number.isFinite(g)) return Infinity;
  if (linear(q)) return Math.abs(g - q.a) / (q.span || Math.max(1, Math.abs(q.a)));
  if (g <= 0) return Infinity;
  return Math.abs(Math.log(g / q.a)) / LOG_RANGE;
}

export function closeness(q, g) {
  const miss = missOf(q, g);
  return Number.isFinite(miss) ? Math.max(0, 1 - miss) : 0;
}

export function isExact(q, g) {
  if (!q || !Number.isFinite(g)) return false;
  const d = Math.abs(g - q.a);
  if (d === 0) return true;
  if (isYear(q)) return false;
  if (Number.isInteger(q.a) && Math.abs(q.a) < 1000) return false;
  return d <= Math.abs(q.a) * 0.005;
}

export function scoreGuesses(q, guesses) {
  const rows = [];
  for (const [slot, g] of Object.entries(guesses || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !Number.isFinite(g)) continue;
    rows.push({ slot: s, g, miss: missOf(q, g), c: closeness(q, g), exact: isExact(q, g) });
  }
  const best = rows.reduce((m, r) => (r.miss < m ? r.miss : m), Infinity);
  const out = {};
  for (const r of rows) {
    const top = Number.isFinite(best) && r.miss === best && r.c > 0;
    const pts = Math.round(NEAR_POINTS * r.c) + (top ? CLOSEST_POINTS : 0) + (r.exact ? EXACT_POINTS : 0);
    out[r.slot] = { pts, top, exact: r.exact, c: r.c, miss: r.miss };
  }
  return out;
}

export function pool(cat) {
  return cat && cat !== MIX && CATS.some((c) => c.id === cat) ? questionsIn(cat) : QUESTIONS.slice();
}

export function buildDeck(count, cat, random = Math.random) {
  return shuffle(pool(cat), random)
    .slice(0, Math.max(1, count))
    .map((x) => x.id);
}

export function showNumber(n, q) {
  if (!Number.isFinite(n)) return '?';
  if (isYear(q)) return n < 0 ? `${-n} BC` : String(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export function withUnit(n, q) {
  const text = showNumber(n, q);
  if (!q || !q.unit || isYear(q)) return text;
  if (/^[%°]/.test(q.unit)) return `${text}${q.unit}`;
  return `${text} ${q.unit}`;
}

function roundSig(n) {
  if (!(n > 0)) return n;
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

export function hintRange(q, random = Math.random) {
  if (!q) return null;
  if (linear(q)) {
    const span = q.span || Math.max(1, Math.abs(q.a));
    const lo = q.a - Math.max(1, Math.round(span * (0.1 + random() * 0.3)));
    const hi = q.a + Math.max(1, Math.round(span * (0.1 + random() * 0.3)));
    return [lo, hi];
  }
  const lo = roundSig(q.a / (1.4 + random() * 0.8));
  const hi = roundSig(q.a * (1.4 + random() * 0.8));
  return [Math.min(lo, q.a), Math.max(hi, q.a)];
}

function questionOf(st) {
  if (!st || !Array.isArray(st.deck)) return null;
  return questionById(unmask(st.deck[st.i], st.k));
}

function ask(api, st0, i, note = null) {
  const { deck, k } = st0;
  const q = questionById(unmask(deck[i], k));
  if (!q) return next(api, { ...st0, i });
  const prev = api.get(KEY);
  const n = (prev && prev.n ? prev.n : 0) + 1;
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const cat = catById(q.cat);
  api.memory.cur = { n, picks: {} };
  roundAt(api, i + 1, deck.length);
  api.put(KEY, {
    v: 1,
    n,
    k,
    deck,
    i,
    total: deck.length,
    phase: 'guess',
    q: q.q,
    u: isYear(q) ? '' : q.unit,
    yr: isYear(q) ? 1 : 0,
    ce: cat ? cat.emoji : '❓',
    cn: cat ? cat.name : '',
    in: api.players().map((p) => p.slot),
    wait: [],
    answered: [],
    a: null,
    f: null,
    g: null,
    sc: null,
    note,
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

function roast(api, slot, g, q) {
  const fx = funMem(api);
  fx.roast = (fx.roast || 0) + 1;
  const tpl = ROASTS[Math.floor(api.random() * ROASTS.length) % ROASTS.length];
  say(api, 'custom', { text: tpl.replace('{a}', nameOf(api, slot)).replace('{g}', showNumber(g, q)) });
}

function reveal(api) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'guess') return;
  const q = questionOf(st);
  const cur = fresh(api, st);
  const guesses = {};
  for (const [slot, pick] of Object.entries(cur ? cur.picks : {})) guesses[slot] = pick.v;
  const scored = q ? scoreGuesses(q, guesses) : {};
  const gained = {};
  const sc = {};
  let wild = null;
  let exact = null;
  for (const [slot, r] of Object.entries(scored)) {
    const s = Number(slot);
    streak(api, s, r.top);
    if (r.pts > 0) gained[slot] = award(api, s, r.pts);
    sc[slot] = { p: gained[slot] || 0, t: r.top ? 1 : 0, x: r.exact ? 1 : 0 };
    if (r.top) bump(api, 'top', s);
    if (r.exact) {
      bump(api, 'exact', s);
      if (!exact) exact = s;
    }
    if (r.c === 0 && (!wild || r.miss > wild.miss)) wild = { slot: s, miss: r.miss, g: guesses[slot] };
  }
  if (q && exact !== null) say(api, 'custom', { text: `🎯 ${nameOf(api, exact)} nailed it: exactly ${withUnit(q.a, q)}!` });
  else if (q && wild) roast(api, wild.slot, wild.g, q);
  if (q && wild) {
    bump(api, 'wild', wild.slot);
    const fx = funMem(api);
    const far = Number.isFinite(wild.miss) ? wild.miss : 99;
    if (!fx.wild || far > fx.wild.miss) fx.wild = { slot: wild.slot, miss: far, g: wild.g, a: q.a, yr: isYear(q) };
    keep(api, `${nameOf(api, wild.slot)} guessed ${withUnit(wild.g, q)}. The answer was ${withUnit(q.a, q)}.`, wild.slot, Math.min(10, far));
  }
  api.memory.cur = null;
  const starts = api.now();
  const ends = starts + REVEAL_MS;
  api.put(KEY, { ...st, phase: 'reveal', a: q ? q.a : null, f: q ? q.fact : null, sp: q && linear(q) ? q.span || Math.max(1, Math.abs(q.a)) : 0, g: guesses, sc, starts, ends });
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
  if (!Number.isInteger(slot) || st.phase !== 'guess') return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  if (st.ends - api.now() >= LATE_MIN_MS) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

const closest = {
  id: 'closest',
  name: 'Closest Guess',
  emoji: '🎯',
  category: 'quiz',
  blurb: 'How many bones are in a cat? Type a number. The closest guess wins, and spot on scores a bonus.',
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Questions', type: 'choice', options: [5, 8, 10, 15].map((v) => ({ value: v, label: String(v) })), default: 8 },
    { id: 'timer', label: 'Time to guess', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    {
      id: 'cat',
      label: 'Questions about',
      type: 'choice',
      options: [{ value: MIX, label: 'Everything' }].concat(CATS.map((c) => ({ value: c.id, label: `${c.emoji} ${c.name}` }))),
      default: MIX,
    },
  ],

  start(api) {
    const k = 1 + Math.floor(api.random() * 65534);
    const deck = buildDeck(api.settings.rounds, api.settings.cat, api.random).map((id) => mask(id, k));
    ask(api, { deck, k }, 0);
  },

  intent(api, slot, action) {
    if (!action || action.type !== 'guess') return;
    const st = api.get(KEY);
    if (!st || st.phase !== 'guess' || action.n !== st.n) return;
    const v = parseGuess(action.v);
    if (v === null) return;
    const cur = fresh(api, st);
    if (!cur || cur.picks[slot]) return;
    if (!inPlay(st).includes(slot)) {
      const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
      if (!inPlay(st).includes(slot)) {
        if (admitted) api.put(KEY, st);
        return;
      }
    }
    cur.picks[slot] = { v, at: api.now() };
    if (!st.answered.includes(slot)) st.answered.push(slot);
    api.put(KEY, st);
    if (everyoneAnswered(api, st)) reveal(api);
  },

  hint(api, slot) {
    const st = api.get(KEY);
    if (!st || st.phase !== 'guess') return null;
    const cur = fresh(api, st);
    if (!cur || cur.picks[slot]) return null;
    const q = questionOf(st);
    const r = hintRange(q, api.random);
    return r ? `It's between ${showNumber(r[0], q)} and ${showNumber(r[1], q)}.` : null;
  },

  awards(api) {
    const fx = funMem(api);
    const hot = bestStreak(api, 2);
    const w = fx.wild;
    return list(
      prize(api, 'exact', 'Bullseye', '🎯', (n) => (n > 1 ? `Spot on ${n} times` : 'Guessed one exactly right')),
      prize(api, 'top', 'Human calculator', '🧮', (n) => `Closest ${n} times`, 2),
      hot ? { title: 'Locked on', emoji: '🔒', who: hot.slots, why: `Closest ${hot.n} in a row` } : null,
      w ? { title: 'Wildest guess', emoji: '🛸', who: w.slot, why: `Said ${showNumber(w.g, w.yr ? { unit: YEAR } : null)}, answer was ${showNumber(w.a, w.yr ? { unit: YEAR } : null)}` } : null,
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'guess') return reveal(api);
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'guess' && st.phase !== 'reveal')) return false;
    if (action.type === 'skip') {
      closest.deadline(api);
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
    if (!st) return closest.start(api);
    if (st.phase === 'guess' && !fresh(api, st)) return ask(api, st, st.i, 'host');
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), st.ends || api.now()));
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
    if (everyoneAnswered(api, st)) reveal(api);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st || typeof st.q !== 'string') return null;
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const revealed = st.phase === 'reveal';
    const playing = mine !== null && inPlay(st).includes(mine);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const q = { unit: st.yr ? YEAR : st.u, a: st.a, span: st.sp || undefined };
    const myGuess = revealed && st.g && Number.isFinite(st.g[mine]) ? st.g[mine] : local.n === st.n && Number.isFinite(local.v) ? local.v : null;
    const rows = [];
    if (revealed && st.g) {
      for (const [slot, g] of Object.entries(st.g)) {
        const p = bySlot.get(Number(slot));
        if (!p || !Number.isFinite(g)) continue;
        const sc = (st.sc && st.sc[slot]) || {};
        const diff = Number.isFinite(st.a) ? g - st.a : 0;
        rows.push({
          ...face(p, mine),
          slot: Number(slot),
          guess: g,
          text: showNumber(g, q),
          off: diff === 0 ? 'Exact' : `${diff > 0 ? '+' : '−'}${showNumber(Math.abs(Math.round(diff * 1000) / 1000), st.yr ? null : q)}`,
          pts: sc.p || 0,
          top: Boolean(sc.t),
          exact: Boolean(sc.x),
          miss: Number.isFinite(st.a) ? missOf({ ...q, a: st.a }, g) : Infinity,
        });
      }
      rows.sort((x, y) => x.miss - y.miss || y.pts - x.pts || x.slot - y.slot);
    }
    const mineRow = rows.find((r) => r.slot === mine) || null;
    return {
      phase: st.phase,
      n: st.n,
      number: st.i + 1,
      total: st.total,
      question: st.q,
      unit: st.yr ? '' : st.u || '',
      year: Boolean(st.yr),
      cat: { emoji: st.ce || '❓', name: st.cn || '' },
      starts: st.starts,
      ends: st.ends,
      note: st.note || null,
      playing,
      waiting,
      watching: !playing && !waiting,
      canGuess: st.phase === 'guess' && playing && myGuess === null,
      myGuess,
      myText: myGuess === null ? null : showNumber(myGuess, q),
      answered: st.answered.length,
      players: inPlay(st).filter((s) => bySlot.has(s) && bySlot.get(s).present).length,
      answeredBy: st.answered.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      answer: revealed && Number.isFinite(st.a) ? withUnit(st.a, q) : null,
      answerValue: revealed && Number.isFinite(st.a) ? st.a : null,
      fact: revealed ? st.f || null : null,
      rows,
      line: revealed ? numberLine(rows, st.a, q) : null,
      myGain: mineRow ? mineRow.pts : 0,
      myTop: Boolean(mineRow && mineRow.top),
      myExact: Boolean(mineRow && mineRow.exact),
    };
  },
};

export function numberLine(rows, a, q) {
  if (!Number.isFinite(a)) return null;
  const vals = rows.map((r) => r.guess).concat([a]);
  const lin = linear({ ...q, a });
  const f = lin ? (v) => v : (v) => Math.log(Math.max(v, Math.abs(a) / 1000, 1e-9));
  let lo = Math.min(...vals.map(f));
  let hi = Math.max(...vals.map(f));
  if (hi - lo < 1e-9) {
    const pad = lin ? Math.max(1, Math.abs(a) * 0.1) : 0.2;
    lo -= pad;
    hi += pad;
  }
  const at = (v) => Math.round(((f(v) - lo) / (hi - lo)) * 1000) / 10;
  return {
    answer: at(a),
    marks: rows.map((r) => ({ id: r.id, name: r.name, isMe: r.isMe, at: at(r.guess), top: r.top })),
  };
}

export default closest;
