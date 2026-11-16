import { CATEGORIES, QUESTIONS, TIERS, questionById } from '../../data/trivia.js';
import { shuffle } from '../engine.js';
import { person } from '../players.js';
import { TEAM_MS, teamSetting, wantsTeams, splitTeams, placeLate, teamOf, teamWinners, teamNames, teamBoard, cleanTeams } from './teams.js';
import { PACK_STEP_MS, PACK_EMOJI, packSetting, packCode, packStep, packFor, packTrivia } from './packs.js';

export const KEY = 'trivia';
export const FX_KEY = 'trivia.fx';
export const PACK_CAT = 'pack';
export const PACK_PREFIX = '~';
const PACK_ID_RE = /^~\d{1,3}$/;
export const REVEAL_MS = 4000;
export const MIN_POINTS = 400;
export const MAX_POINTS = 1000;
export const LATE_MIN_MS = 4000;
export const WAGER_MS = 9000;
export const WAGER_FLOOR = 300;
export const WAGER_STEPS = Object.freeze([0, 25, 50, 100]);
export const STEAL_POINTS = 150;
export const FAST_MS = 2500;
export const PERFECT_MIN = 8;
export const BOLT_COUNT = 5;
export const BOLT_MS = 30000;
export const BOLT_POINTS = 150;
export const BOLT_SWEEP = 150;
export const BOLT_SHOW_MS = 6000;
export const BOLT_LATE_MS = 8000;
export const HL_KEEP = 5;
export const LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

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

export function wagerAmount(points, step) {
  if (!WAGER_STEPS.includes(step)) return 0;
  const base = Math.max(WAGER_FLOOR, Math.max(0, Math.round(Number(points) || 0)));
  return Math.round((base * step) / 1000) * 10;
}

export function wagerSpot(total, on) {
  return on && total >= 4 ? total - 2 : -1;
}

export function stealOf(picks, answer) {
  const order = Object.entries(picks || {})
    .map(([s, p]) => ({ s: Number(s), i: p && p.i, at: p && p.at }))
    .filter((x) => Number.isInteger(x.s) && Number.isInteger(x.i) && Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at || a.s - b.s);
  if (order.length < 2 || order[0].i === answer) return null;
  const thief = order.find((x) => x.i === answer);
  return thief ? { by: thief.s, from: order[0].s } : null;
}

export function hintLetters(count, answer, random = Math.random) {
  if (!Number.isInteger(count) || count < 3 || !Number.isInteger(answer) || answer < 0 || answer >= count) return [];
  const wrong = shuffle(
    Array.from({ length: count }, (_, i) => i).filter((i) => i !== answer),
    random,
  );
  return wrong.slice(0, Math.min(2, count - 2)).sort((a, b) => a - b);
}

export function hintText(letters, prefix = '') {
  if (!letters.length) return null;
  const names = letters.map((i) => LETTERS[i] || String(i + 1));
  const body = names.length === 1 ? `It's not ${names[0]}.` : `It's not ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}.`;
  return `${prefix}${body} ${letters.length >= 2 ? "It's a 50/50 now!" : 'One less to worry about.'}`;
}

export function boltPoints(right, count) {
  const n = Math.max(0, Math.floor(right) || 0);
  return n * BOLT_POINTS + (count > 0 && n >= count ? BOLT_SWEEP : 0);
}

function say(api, kind, data) {
  if (api && typeof api.say === 'function') api.say(kind, data);
}

function tick(api, n, total) {
  if (api && typeof api.round === 'function') api.round(n, total);
}

function give(api, slot, n, opts) {
  const got = api.addPoints(slot, n, opts);
  return Number.isFinite(got) ? got : n;
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function carryOf(st) {
  return {
    tm: (st && st.tm) || null,
    pk: (st && st.pk) || null,
    pm: (st && st.pm) || null,
    wi: st && Number.isInteger(st.wi) ? st.wi : -1,
    lb: Boolean(st && st.lb),
    sm: st ? st.sm !== 0 : true,
  };
}

function carried(carry) {
  return { tm: carry.tm, pk: carry.pk, pm: carry.pm, wi: carry.wi, lb: carry.lb ? 1 : 0, sm: carry.sm ? 1 : 0 };
}

function roundsOf(deck, carry) {
  return deck.length + (carry.lb ? 1 : 0);
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

function fxOf(api) {
  const fx = api.get(FX_KEY);
  if (!fx || typeof fx !== 'object') return { s: {}, b: {}, w: {}, r: {}, hl: [] };
  return { s: { ...(fx.s || {}) }, b: { ...(fx.b || {}) }, w: { ...(fx.w || {}) }, r: { ...(fx.r || {}) }, hl: Array.isArray(fx.hl) ? fx.hl.slice() : [] };
}

function noteFx(api, fn) {
  const fx = fxOf(api);
  fn(fx);
  fx.hl = fx.hl
    .filter((x) => x && typeof x.x === 'string')
    .sort((a, b) => (b.w || 0) - (a.w || 0))
    .slice(0, HL_KEEP);
  api.put(FX_KEY, fx);
}

function addHl(fx, x, s, w) {
  const text = clip(x, 118);
  if (!text || fx.hl.some((h) => h.x === text)) return;
  const item = { x: text, w: Math.round(w * 10) / 10 };
  if (Number.isInteger(s)) item.s = s;
  fx.hl.push(item);
}

function step(api, deck, i, carry) {
  if (i === carry.wi && i < deck.length) return wagerPhase(api, deck, i, carry);
  return ask(api, deck, i, carry);
}

function previewOf(deck, i) {
  if (isPackId(deck[i])) return { cat: PACK_CAT, tier: PACK_CAT };
  const q = questionById(deck[i]);
  return q ? { cat: q.cat, tier: q.tier } : { cat: PACK_CAT, tier: PACK_CAT };
}

function wagerPhase(api, deck, i, carry) {
  const starts = api.now();
  const ends = starts + WAGER_MS;
  const pre = previewOf(deck, i);
  tick(api, i + 1, roundsOf(deck, carry));
  api.memory.bets = { i, p: {} };
  api.put(KEY, {
    deck,
    i,
    total: deck.length,
    phase: 'wager',
    wc: pre.cat,
    wt: pre.tier,
    ...carried(carry),
    in: api.players().map((p) => p.slot),
    wait: [],
    answered: [],
    bet: [],
    starts,
    ends,
  });
  api.setDeadline(ends);
}

function betsFor(api, i) {
  const mem = api.memory.bets;
  api.memory.bets = null;
  if (!mem || mem.i !== i) return null;
  const pts = api.points();
  const out = {};
  let bold = null;
  for (const [slot, p] of Object.entries(mem.p)) {
    const amt = wagerAmount(pts[slot], p);
    if (amt > 0) out[slot] = amt;
    if (p === 100 && amt > 0 && (!bold || amt > bold.amt)) bold = { slot: Number(slot), amt };
  }
  if (bold) say(api, 'wager', { slot: bold.slot });
  return out;
}

function ask(api, deck, i, carry = carryOf(api.get(KEY))) {
  let q = isPackId(deck[i]) ? packQuestion(api, carry, deck[i]) : questionById(deck[i]);
  if (!q && isPackId(deck[i])) {
    q = swapIn(api, deck);
    if (q) deck = deck.map((id, k) => (k === i ? q.id : id));
  }
  if (!q) return finishOrNext(api, deck, i, carry);
  const wg = i === carry.wi ? betsFor(api, i) : null;
  const options = shuffle([q.a, ...q.w], api.random);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  const answer = options.indexOf(q.a);
  const salt = q.cat === PACK_CAT ? Math.floor(api.random() * 1000) : 0;
  tick(api, i + 1, roundsOf(deck, carry));
  api.memory.cur = { qid: q.id, answer, picks: {} };
  const placed = carry.tm ? placeLate(carry.tm, api.players().map((p) => p.slot), api.points()) : null;
  const next = {
    deck,
    i,
    total: deck.length,
    phase: 'question',
    q: q.cat === PACK_CAT ? { id: q.id, cat: q.cat, tier: q.tier, text: q.q, options, s: salt, x: hideAnswer(answer, salt, options.length) } : { id: q.id, cat: q.cat, tier: q.tier, text: q.q, options },
    ...carried(carry),
    tm: placed || carry.tm,
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
  };
  if (i === carry.wi) next.wq = 1;
  if (wg && Object.keys(wg).length) next.wg = wg;
  api.put(KEY, next);
  api.setDeadline(ends);
  return undefined;
}

function endGame(api, st) {
  if (st && st.tm) {
    const starts = api.now();
    const ends = starts + TEAM_MS;
    api.put(KEY, { ...st, phase: 'final', starts, ends });
    api.setDeadline(ends);
    return undefined;
  }
  return api.finish();
}

function finishOrNext(api, deck, i, carry) {
  const c = carry || carryOf(api.get(KEY));
  if (i + 1 < deck.length) return step(api, deck, i + 1, c);
  const st = api.get(KEY) || { deck, i, total: deck.length };
  if (c.lb && boltStart(api, deck, c)) return undefined;
  return endGame(api, { ...st, ...carried(c) });
}

function boltStart(api, deck, carry) {
  const used = new Set(deck);
  const ids = buildDeck(api.settings.cats, deck.length + BOLT_COUNT + 5, api.random, 'easy')
    .filter((id) => !used.has(id))
    .slice(0, BOLT_COUNT);
  const bq = ids
    .map((id) => questionById(id))
    .filter(Boolean)
    .map((q) => ({ id: q.id, text: q.q, options: shuffle([q.a, ...q.w], api.random) }));
  if (!bq.length) return false;
  const starts = api.now();
  const ends = starts + BOLT_MS;
  const total = roundsOf(deck, carry);
  tick(api, total, total);
  api.memory.bolt = { at: starts, picks: {} };
  api.put(KEY, {
    deck,
    i: deck.length - 1,
    total: deck.length,
    phase: 'bolt',
    bq,
    ...carried(carry),
    in: api.players().map((p) => p.slot),
    wait: [],
    answered: [],
    done: [],
    starts,
    ends,
  });
  api.setDeadline(ends);
  return true;
}

export function boltAnswers(st) {
  return ((st && st.bq) || []).map((b) => {
    const q = questionById(b.id);
    return q ? b.options.indexOf(q.a) : -1;
  });
}

function boltReveal(api, skipped) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'bolt') return;
  const mem = api.memory.bolt;
  const live = !skipped && mem && mem.at === st.starts;
  const ba = boltAnswers(st);
  const bp = {};
  const bk = {};
  const br = {};
  const sweeps = [];
  if (live) {
    for (const [slot, list] of Object.entries(mem.picks)) {
      const s = Number(slot);
      const right = list.filter((x, k) => x === ba[k]).length;
      bp[slot] = ba.map((_, k) => (Number.isInteger(list[k]) ? String(list[k]) : '-')).join('');
      br[slot] = right;
      const pts = boltPoints(right, ba.length);
      if (pts > 0) bk[slot] = give(api, s, pts);
      if (right >= ba.length && ba.length >= 3) sweeps.push(s);
    }
    if (Object.values(br).some((n) => n > 0)) {
      noteFx(api, (fx) => {
        for (const [slot, n] of Object.entries(br)) if (n > 0) fx.b[slot] = (fx.b[slot] || 0) + n;
        for (const s of sweeps.slice(0, 2)) addHl(fx, `⚡ ${api.nameOf(s)} went ${ba.length} for ${ba.length} in the lightning round!`, s, 8);
      });
    }
    if (sweeps.length) say(api, 'custom', { text: `⚡ ${api.nameOf(sweeps[0])} swept the lightning round!` });
  }
  api.memory.bolt = null;
  const now = api.now();
  const ends = now + BOLT_SHOW_MS;
  api.put(KEY, { ...st, phase: 'boltshow', ba, bp, bk, br, skipped: !live, starts: now, ends });
  api.setDeadline(ends);
}

function begin(api) {
  const code = packCode(api.settings);
  const pstep = packStep(api, code);
  if (pstep.state === 'wait') {
    api.setDeadline(api.now() + PACK_STEP_MS);
    return;
  }
  const pack = pstep.state === 'ready' ? pstep.pack : null;
  const questions = pack ? packTrivia(pack.trivia) : [];
  api.memory.pack = pack;
  const present = api.players().map((p) => p.slot);
  let tm = null;
  if (wantsTeams(api.settings) && present.length >= 2) {
    const kept = typeof api.sameTeams === 'function' ? cleanTeams(api.sameTeams()) : null;
    const keep = kept ? Object.fromEntries(Object.entries(kept).filter(([s]) => present.includes(Number(s)))) : null;
    tm = keep && Object.keys(keep).length >= 2 && new Set(Object.values(keep)).size >= 2 ? placeLate(keep, present, {}) || keep : splitTeams(present, api.random);
  }
  const pk = questions.length ? { c: code, n: pack.name } : null;
  const pm = pstep.state === 'fail' || (pack && !questions.length) ? code : null;
  const deck = deckWithPack(questions, api.settings.cats, api.settings.rounds, api.random, api.settings.level);
  const carry = { tm, pk, pm, wi: wagerSpot(deck.length, api.settings.wager !== false), lb: api.settings.lightning !== false, sm: api.settings.steal !== false };
  step(api, deck, 0, carry);
}

function settleWagers(api, st, right, gained) {
  const wg = st.wg || {};
  const pts = api.points();
  const net = {};
  for (const [slot, amt] of Object.entries(wg)) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !(amt > 0)) continue;
    if (right.includes(s)) {
      const won = give(api, s, amt);
      gained[slot] = (gained[slot] || 0) + won;
      net[slot] = won;
    } else {
      const loss = Math.min(amt, Math.max(0, Number(pts[slot]) || 0));
      if (loss > 0) {
        api.addPoints(s, -loss, { raw: true });
        gained[slot] = (gained[slot] || 0) - loss;
      }
      net[slot] = -loss;
    }
  }
  return net;
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
  let sl = null;
  if (live) {
    answer = cur.answer;
    let fastest = null;
    for (const [slot, pick] of Object.entries(cur.picks)) {
      chose[slot] = pick.i;
      if (pick.i === answer) {
        const pts = speedPoints(pick.at, st.starts, st.ends, st.q.tier);
        right.push(Number(slot));
        gained[slot] = give(api, Number(slot), pts);
        if (pick.at - st.starts <= FAST_MS && (!fastest || pick.at < fastest.at)) fastest = { slot: Number(slot), at: pick.at };
      }
    }
    const net = settleWagers(api, st, right, gained);
    if (st.sm !== 0) {
      const steal = stealOf(cur.picks, answer);
      if (steal) {
        const now = api.points();
        const n = Math.min(STEAL_POINTS, Math.max(0, Number(now[steal.from]) || 0));
        if (n > 0) {
          api.addPoints(steal.from, -n, { raw: true });
          gained[steal.from] = (gained[steal.from] || 0) - n;
        }
        const b = give(api, steal.by, STEAL_POINTS);
        gained[steal.by] = (gained[steal.by] || 0) + b;
        sl = { by: steal.by, from: steal.from, n, b };
        say(api, 'steal', { slot: steal.by, other: steal.from });
      }
    }
    if (fastest && !sl) say(api, 'fast', { slot: fastest.slot });
    const hl = [];
    if (sl) hl.push({ x: `😈 ${api.nameOf(sl.by)} stole the points from ${api.nameOf(sl.from)} on "${clip(st.q.text, 60)}"`, s: sl.by, w: 4 });
    const wrongs = new Map();
    for (const pick of Object.values(cur.picks)) if (pick.i !== answer) wrongs.set(pick.i, (wrongs.get(pick.i) || 0) + 1);
    const top = [...wrongs.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (top && top[1] >= 2 && top[1] >= right.length) hl.push({ x: `💀 ${top[1]} people were sure it was "${clip(st.q.options[top[0]], 40)}" for "${clip(st.q.text, 60)}"`, w: 3 + top[1] });
    for (const [slot, n] of Object.entries(net)) {
      const s = Number(slot);
      const amt = st.wg[slot];
      hl.push({ x: n > 0 ? `💰 ${api.nameOf(s)} bet ${amt.toLocaleString('en-US')} and won it!` : `💸 ${api.nameOf(s)} bet ${amt.toLocaleString('en-US')} and it did not go to plan`, s, w: 2 + Math.min(4, amt / 500) });
    }
    const tally = right.length > 0 && st.total >= PERFECT_MIN;
    if (hl.length || sl || tally) {
      noteFx(api, (fx) => {
        if (sl) fx.s[sl.by] = (fx.s[sl.by] || 0) + 1;
        if (tally) for (const s of right) fx.r[s] = (fx.r[s] || 0) + 1;
        for (const [slot, n] of Object.entries(net)) fx.w[slot] = (fx.w[slot] || 0) + n;
        for (const x of hl) addHl(fx, x.x, x.s, x.w);
      });
    }
  } else if (st.q.cat === PACK_CAT) {
    answer = showAnswer(st.q);
  } else {
    const q = questionById(st.q.id);
    answer = q ? st.q.options.indexOf(q.a) : -1;
  }
  api.memory.cur = null;
  const ends = api.now() + REVEAL_MS;
  const next = { ...st, phase: 'reveal', answer, chose, right: right.sort((a, b) => a - b), gained, skipped: !live, ends };
  if (sl) next.sl = sl;
  else delete next.sl;
  api.put(KEY, next);
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

const OPEN = ['question', 'wager', 'bolt'];

function doneList(st) {
  if (st.phase === 'wager') return st.bet || [];
  if (st.phase === 'bolt') return st.done || [];
  return st.answered || [];
}

function everyoneAnswered(api, st) {
  const playing = inPlay(st);
  const done = doneList(st);
  const live = api.players().map((p) => p.slot).filter((s) => !playing || playing.includes(s));
  return live.length > 0 && live.every((s) => done.includes(s));
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot) || !OPEN.includes(st.phase)) return false;
  if (!Array.isArray(st.in)) st.in = [];
  if (!Array.isArray(st.wait)) st.wait = [];
  if (st.in.includes(slot) || st.wait.includes(slot)) return false;
  const gap = st.phase === 'bolt' ? BOLT_LATE_MS : st.phase === 'wager' ? 0 : LATE_MIN_MS;
  if (st.ends - api.now() >= gap) st.in.push(slot);
  else st.wait.push(slot);
  return true;
}

function closePhase(api, st) {
  if (st.phase === 'question') return reveal(api, false);
  if (st.phase === 'wager') return ask(api, st.deck, st.i, carryOf(st));
  if (st.phase === 'bolt') return boltReveal(api, false);
  return undefined;
}

function letIn(api, st, slot) {
  if (st.in.includes(slot)) return true;
  const admitted = api.players().some((p) => p.slot === slot) && admit(api, st, slot);
  if (st.in.includes(slot)) return true;
  if (admitted) api.put(KEY, st);
  return false;
}

function placeBet(api, st, slot, action) {
  const mem = api.memory.bets;
  if (st.phase !== 'wager' || !mem || mem.i !== st.i) return;
  if (!WAGER_STEPS.includes(action.p) || (st.bet || []).includes(slot)) return;
  if (!letIn(api, st, slot)) return;
  mem.p[slot] = action.p;
  st.bet = (st.bet || []).concat([slot]);
  api.put(KEY, st);
  if (everyoneAnswered(api, st)) ask(api, st.deck, st.i, carryOf(st));
}

function boltPick(api, st, slot, action) {
  const mem = api.memory.bolt;
  if (st.phase !== 'bolt' || !mem || mem.at !== st.starts) return;
  const { k, i } = action;
  if (!Number.isInteger(k) || k < 0 || k >= st.bq.length) return;
  if (!Number.isInteger(i) || i < 0 || i >= st.bq[k].options.length) return;
  if (!letIn(api, st, slot)) return;
  const list = mem.picks[slot] || [];
  if (k !== list.length) return;
  mem.picks[slot] = list.concat([i]);
  if (mem.picks[slot].length < st.bq.length) return;
  st.done = (st.done || []).concat([slot]);
  api.put(KEY, st);
  if (everyoneAnswered(api, st)) boltReveal(api, false);
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

function topOf(map, min = 1) {
  let best = null;
  for (const [slot, n] of Object.entries(map || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !(n >= min)) continue;
    if (!best || n > best.n || (n === best.n && s < best.slot)) best = { slot: s, n };
  }
  return best;
}

function lowOf(map) {
  let best = null;
  for (const [slot, n] of Object.entries(map || {})) {
    const s = Number(slot);
    if (!Number.isInteger(s) || !(n < 0)) continue;
    if (!best || n < best.n || (n === best.n && s < best.slot)) best = { slot: s, n };
  }
  return best;
}

function boltModel(st, mine, bySlot, local) {
  const playing = inPlay(st) || [];
  const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
  const watching = !waiting && (mine === null || !playing.includes(mine));
  const show = st.phase === 'boltshow';
  const mineKey = mine !== null ? String(mine) : null;
  const sent = local && local.bolt === st.starts && Array.isArray(local.picks) ? local.picks : [];
  const stored = show && mineKey && st.bp && typeof st.bp[mineKey] === 'string' ? st.bp[mineKey].split('').map((c) => (c === '-' ? null : Number(c))) : null;
  const myPicks = stored || sent;
  const k = Math.min(myPicks.length, st.bq.length);
  const iDone = mine !== null && (st.done || []).includes(mine);
  const board = show
    ? Object.entries(st.br || {})
        .map(([s, n]) => ({ slot: Number(s), n, pts: (st.bk && st.bk[s]) || 0 }))
        .filter((x) => bySlot.has(x.slot))
        .sort((a, b) => b.n - a.n || b.pts - a.pts || a.slot - b.slot)
        .map((x) => ({ ...face(bySlot.get(x.slot), mine), right: x.n, pts: x.pts }))
    : [];
  return {
    phase: st.phase,
    key: `${st.starts}`,
    bolt: st.starts,
    starts: st.starts,
    ends: st.ends,
    count: st.bq.length,
    at: k,
    current: !show && !iDone && k < st.bq.length ? { k, text: st.bq[k].text, options: st.bq[k].options.map((text, i) => ({ text, i })) } : null,
    canAnswer: st.phase === 'bolt' && !waiting && !watching && !iDone && k < st.bq.length,
    iDone: iDone || k >= st.bq.length,
    waiting,
    watching,
    done: (st.done || []).length,
    players: playing.length,
    doneBy: (st.done || []).map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
    skipped: Boolean(show && st.skipped),
    review: show
      ? st.bq.map((b, i) => ({ text: b.text, answer: b.options[st.ba[i]] || '', mine: Number.isInteger(myPicks[i]) ? b.options[myPicks[i]] || '' : null, right: Number.isInteger(myPicks[i]) && myPicks[i] === st.ba[i] }))
      : [],
    myRight: show && mineKey && st.br ? st.br[mineKey] || 0 : 0,
    myGain: show && mineKey && st.bk ? st.bk[mineKey] || 0 : 0,
    board,
  };
}

export function skillsOf(fx, total) {
  const out = {};
  const add = (slot, key, n) => {
    if (!(n > 0)) return;
    out[slot] = { ...(out[slot] || {}), [key]: Math.floor(n) };
  };
  for (const [slot, n] of Object.entries(fx.s || {})) add(slot, 's', Number(n));
  for (const [slot, n] of Object.entries(fx.b || {})) add(slot, 'l', Number(n));
  if (total >= PERFECT_MIN) for (const [slot, n] of Object.entries(fx.r || {})) if (Number(n) >= total) add(slot, 'p', 1);
  return out;
}

const trivia = {
  id: 'trivia',
  name: 'Trivia',
  category: 'quiz',
  emoji: '🧠',
  blurb: 'Four choices, one right answer. Be quick, steal points, bet big, then survive the lightning round.',
  minPlayers: 1,
  keys: [KEY, FX_KEY],
  cards: ['swap', 'double', 'peek'],
  settings: [
    { id: 'rounds', label: 'Questions', type: 'choice', options: [5, 8, 10, 15, 20].map((v) => ({ value: v, label: String(v) })), default: 10 },
    { id: 'timer', label: 'Time to answer', type: 'choice', options: [10, 15, 20, 30].map((v) => ({ value: v, label: `${v} s` })), default: 15 },
    {
      id: 'level',
      label: 'Difficulty',
      type: 'choice',
      options: [{ value: MIX, label: '🎲 Mixed, gets harder' }].concat(TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))),
      default: MIX,
    },
    { id: 'cats', label: 'Categories', type: 'multi', options: CATEGORIES.map((c) => ({ value: c.id, label: `${c.emoji} ${c.name}` })), default: CATEGORIES.map((c) => c.id) },
    { id: 'steal', label: '😈 Steal mode', type: 'toggle', default: true, fun: true },
    { id: 'wager', label: '💰 Wager round', type: 'toggle', default: true, fun: true },
    { id: 'lightning', label: '⚡ Lightning round', type: 'toggle', default: true, fun: true },
    teamSetting(),
    packSetting(),
  ],

  start(api) {
    begin(api);
  },

  results(api) {
    const st = api.get(KEY);
    const out = st && st.tm ? { teams: teamNames(st.tm), tm: { ...st.tm } } : {};
    const skills = skillsOf(fxOf(api), st && Number.isInteger(st.total) ? st.total : 0);
    if (Object.keys(skills).length) {
      out.skills = skills;
      out.questions = st && Number.isInteger(st.total) ? st.total : 0;
    }
    return out;
  },

  hint(api, slot) {
    const st = api.get(KEY);
    if (!st) return null;
    if (st.phase === 'question') {
      const cur = api.memory.cur;
      if (!cur || cur.qid !== st.q.id || cur.picks[slot] || (st.answered || []).includes(slot)) return null;
      return hintText(hintLetters(st.q.options.length, cur.answer, api.random));
    }
    if (st.phase === 'bolt') {
      const mem = api.memory.bolt;
      if (!mem || mem.at !== st.starts) return null;
      const k = mem.picks[slot] ? mem.picks[slot].length : 0;
      if (k >= st.bq.length) return null;
      return hintText(hintLetters(st.bq[k].options.length, boltAnswers(st)[k], api.random), `Question ${k + 1}: `);
    }
    return null;
  },

  awards(api) {
    const fx = fxOf(api);
    const out = [];
    const thief = topOf(fx.s);
    if (thief) out.push({ emoji: '😈', title: 'Master thief', who: thief.slot, why: thief.n === 1 ? 'Pulled off a steal' : `${thief.n} steals this game` });
    const roller = topOf(fx.w, 1);
    if (roller) out.push({ emoji: '💰', title: 'High roller', who: roller.slot, why: `Won ${roller.n.toLocaleString('en-US')} on a wager` });
    const brave = lowOf(fx.w);
    if (brave) out.push({ emoji: '🎰', title: 'Fearless gambler', who: brave.slot, why: 'Bet big. The question had other plans.' });
    const bolt = topOf(fx.b, 3);
    if (bolt) out.push({ emoji: '🌩️', title: 'Lightning legend', who: bolt.slot, why: `${bolt.n} right in the lightning round` });
    return out.slice(0, 3);
  },

  highlights(api) {
    return fxOf(api).hl.map((x) => (Number.isInteger(x.s) ? { text: x.x, who: x.s } : { text: x.x }));
  },

  intent(api, slot, action) {
    if (!action || typeof action !== 'object') return;
    const st = api.get(KEY);
    if (!st) return;
    if (action.type === 'bet') return placeBet(api, st, slot, action);
    if (action.type === 'bolt') return boltPick(api, st, slot, action);
    if (action.type !== 'answer') return;
    const cur = api.memory.cur;
    if (st.phase !== 'question' || !cur || cur.qid !== st.q.id) return;
    if (action.q !== undefined && action.q !== st.q.id) return;
    const i = action.i;
    if (!Number.isInteger(i) || i < 0 || i >= st.q.options.length) return;
    if (cur.picks[slot] || st.answered.includes(slot)) return;
    if (inPlay(st) && !letIn(api, st, slot)) return;
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
    if (OPEN.includes(st.phase)) return closePhase(api, st);
    if (st.phase === 'boltshow') return endGame(api, st);
    return finishOrNext(api, st.deck, st.i, carryOf(st));
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || !['question', 'reveal', 'wager', 'bolt', 'boltshow'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      if (st.phase === 'reveal') finishOrNext(api, st.deck, st.i, carryOf(st));
      else if (st.phase === 'boltshow') endGame(api, st);
      else closePhase(api, st);
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
    if (st.phase === 'wager') return ask(api, st.deck, st.i, carryOf(st));
    if (st.phase === 'bolt') return boltReveal(api, true);
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
    if (!OPEN.includes(st.phase)) {
      if (added) api.put(KEY, st);
      return;
    }
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (added) api.put(KEY, st);
    if (everyoneAnswered(api, st)) closePhase(api, st);
  },

  model(snap, local = {}) {
    const st = snap.state[KEY];
    if (!st) return null;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const mine = snap.meSlot;
    const myTeam = st.tm ? teamOf(st.tm, mine) : null;
    const teams = st.tm ? teamBoard(st.tm, snap.players, snap.scores, mine) : null;
    const lightning = Boolean(st.lb);
    if (st.phase === 'final') return { phase: 'final', teams, myTeam, starts: st.starts, ends: st.ends, number: st.total, total: st.total, lightning };
    if (st.phase === 'bolt' || st.phase === 'boltshow') return { ...boltModel(st, mine, bySlot, local), teams, myTeam, number: st.total, total: st.total, lightning };
    const playing = inPlay(st);
    const waiting = mine !== null && Array.isArray(st.wait) && st.wait.includes(mine);
    const watching = !waiting && (mine === null || (playing ? !playing.includes(mine) : false));
    const catId = st.q ? st.q.cat : st.wc;
    const fromPack = catId === PACK_CAT;
    const cat = fromPack ? { name: (st.pk && st.pk.n) || 'Word pack', emoji: PACK_EMOJI } : CAT_NAMES.get(catId) || { name: 'Trivia', emoji: '❓' };
    const tier = tierOf(st.q ? st.q.tier : st.wt);
    const head = {
      teams,
      myTeam,
      pack: st.pk ? { code: st.pk.c, name: st.pk.n } : null,
      packMiss: st.pm || null,
      fromPack,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      lightning,
      category: cat.name,
      emoji: cat.emoji,
      tier: fromPack ? null : tier.id,
      tierName: tier.name,
      tierEmoji: tier.emoji,
      tierBonus: tier.mult > 1 ? `×${tier.mult}` : '',
      starts: st.starts,
      ends: st.ends,
      waiting,
      watching,
      players: playing ? playing.length : snap.players.filter((p) => p.present).length,
    };
    if (st.phase === 'wager') {
      const myPts = mine !== null && snap.scores && snap.scores.g ? Number(snap.scores.g[mine]) || 0 : 0;
      const sent = local.wager === st.starts ? local.bet ?? null : null;
      const locked = mine !== null && (st.bet || []).includes(mine);
      return {
        ...head,
        key: `${st.starts}`,
        bets: WAGER_STEPS.map((p) => ({ p, amount: wagerAmount(myPts, p), mine: sent === p })),
        myBet: sent,
        canBet: !waiting && !watching && sent === null && !locked,
        iBet: sent !== null || locked,
        betBy: (st.bet || []).map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
        answered: (st.bet || []).length,
      };
    }
    const myPick = st.phase === 'reveal' && st.chose && st.chose[mine] !== undefined ? st.chose[mine] : local.qid === st.q.id ? local.pick ?? null : null;
    const counts = st.q.options.map((_, i) => Object.values(st.chose || {}).filter((x) => x === i).length);
    const faceAt = (s) => (bySlot.has(s) ? face(bySlot.get(s), mine) : null);
    const wagers = Object.entries(st.wg || {})
      .map(([s, amt]) => ({ who: faceAt(Number(s)), amt }))
      .filter((x) => x.who)
      .sort((a, b) => b.amt - a.amt);
    const steal = st.phase === 'reveal' && st.sl && faceAt(st.sl.by) && faceAt(st.sl.from) ? { by: faceAt(st.sl.by), from: faceAt(st.sl.from), n: st.sl.n || 0, b: st.sl.b || 0 } : null;
    return {
      ...head,
      text: st.q.text,
      qid: st.q.id,
      answered: st.answered.length,
      answeredBy: st.answered.map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine)),
      canAnswer: st.phase === 'question' && !waiting && !watching,
      iAnswered: myPick !== null || (mine !== null && st.answered.includes(mine)),
      myPick,
      skipped: Boolean(st.skipped),
      wagerRound: Boolean(st.wq),
      wagers,
      myWager: mine !== null && st.wg ? st.wg[mine] || 0 : 0,
      steal,
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
