import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import trivia, {
  KEY as TKEY,
  FX_KEY,
  REVEAL_MS,
  WAGER_MS,
  WAGER_FLOOR,
  BOLT_MS,
  BOLT_SHOW_MS,
  BOLT_POINTS,
  BOLT_SWEEP,
  STEAL_POINTS,
  wagerAmount,
  wagerSpot,
  stealOf,
  hintLetters,
  hintText,
  boltPoints,
  boltAnswers,
} from '../web/activity/js/games/trivia.js';
import higherlower, { KEY as HKEY, REVEAL_MS as H_REVEAL_MS, higherSide, pickOrder } from '../web/activity/js/games/higherlower.js';
import reflex, { KEY as RKEY, SHOW_MS, greenOf } from '../web/activity/js/games/reflex.js';
import { koOut, koOn, koTotal, koOutText, koLine, SURVIVOR_POINTS } from '../web/activity/js/games/knockout.js';
import { createTriviaView, footerText, betLabel, stealText } from '../web/activity/js/views/trivia.js';
import { createHigherlowerView } from '../web/activity/js/views/higherlower.js';
import { createReflexView, koNote } from '../web/activity/js/views/reflex.js';
import { questionById } from '../web/activity/data/trivia.js';
import { cardsFor } from '../web/activity/js/fun.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function host(r) {
  return r.engines.find((e) => e.isHost());
}

function state(r, key) {
  return r.hub.state[key];
}

function rightIndex(st) {
  return st.q.options.indexOf(questionById(st.q.id).a);
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

async function start(n, game, settings = {}) {
  const r = room(n, { games: [trivia, higherlower, reflex] });
  await r.clock.advance(500);
  const h = r.engines[0];
  assert.equal(h.lobby.pick(game.id), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(h.lobby.setting(k, v), true, k);
  assert.equal(h.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

test('the quiz games have friendly new settings that are on by default and shorter clocks', () => {
  const s = (g, id) => g.settings.find((x) => x.id === id);
  for (const id of ['steal', 'wager', 'lightning']) {
    assert.equal(s(trivia, id).type, 'toggle', id);
    assert.equal(s(trivia, id).default, true, id);
  }
  assert.equal(s(trivia, 'timer').default, 15);
  assert.ok(s(trivia, 'timer').options.some((o) => o.value === 30), 'longer clocks are still there');
  assert.equal(s(higherlower, 'knockout').default, true);
  assert.equal(s(reflex, 'knockout').default, true);
  assert.equal(s(higherlower, 'timer').default, 8);
  assert.ok(REVEAL_MS <= 4000 && H_REVEAL_MS <= 4000 && SHOW_MS <= 4500);
  assert.deepEqual(cardsFor(trivia), ['swap', 'double', 'peek']);
  assert.deepEqual(cardsFor(higherlower), ['swap', 'double', 'peek']);
  assert.deepEqual(cardsFor(reflex), ['swap', 'double']);
  for (const g of [trivia, higherlower, reflex]) {
    assert.equal(typeof g.awards, 'function');
    assert.equal(typeof g.highlights, 'function');
    assert.equal(g.freeze, undefined, 'nobody takes turns, so there is nothing to freeze');
    for (const re of BANNED) assert.doesNotMatch(`${g.name} ${g.blurb} ${g.settings.map((x) => x.label).join(' ')}`, re);
  }
});

test('wagers, steals, hints and lightning points add up', () => {
  assert.equal(wagerAmount(0, 100), WAGER_FLOOR);
  assert.equal(wagerAmount(2000, 50), 1000);
  assert.equal(wagerAmount(2000, 25), 500);
  assert.equal(wagerAmount(2000, 0), 0);
  assert.equal(wagerAmount(2000, 33), 0);
  assert.equal(wagerSpot(10, true), 8);
  assert.equal(wagerSpot(3, true), -1);
  assert.equal(wagerSpot(10, false), -1);
  assert.deepEqual(stealOf({ 0: { i: 1, at: 10 }, 1: { i: 2, at: 20 }, 2: { i: 2, at: 30 } }, 2), { by: 1, from: 0 });
  assert.equal(stealOf({ 0: { i: 2, at: 10 }, 1: { i: 1, at: 20 } }, 2), null, 'the fastest was right, so nothing to steal');
  assert.equal(stealOf({ 0: { i: 1, at: 10 }, 1: { i: 3, at: 20 } }, 2), null, 'nobody got it right');
  assert.equal(stealOf({ 0: { i: 1, at: 10 } }, 2), null);
  for (let seed = 1; seed < 20; seed += 1) {
    const out = hintLetters(4, seed % 4, seeded(seed));
    assert.equal(out.length, 2);
    assert.ok(!out.includes(seed % 4), 'a hint never rules out the right answer');
  }
  assert.deepEqual(hintLetters(2, 0), []);
  assert.match(hintText([1, 3]), /^It's not B or D\. It's a 50\/50 now!$/);
  assert.equal(hintText([]), null);
  assert.equal(boltPoints(5, 5), 5 * BOLT_POINTS + BOLT_SWEEP);
  assert.equal(boltPoints(3, 5), 3 * BOLT_POINTS);
  assert.equal(boltPoints(0, 5), 0);
  assert.equal(betLabel({ p: 0, amount: 0 }), 'Play it safe');
  assert.equal(betLabel({ p: 100, amount: 1200 }), 'All in · 1,200');
  assert.equal(stealText({ by: { name: 'Juno' }, from: { isMe: true }, n: 150 }), '😈 Juno stole 150 points from you!');
});

test('a full Trivia game: steals, a wager round, a lightning final worth double, awards and highlights', async () => {
  const r = await start(3, trivia, { rounds: 5, timer: 10 });
  const h = host(r);
  let st = state(r, TKEY);
  assert.equal(st.wi, 3, 'the wager is the second last question');
  for (let q = 0; q < 3; q += 1) {
    st = state(r, TKEY);
    assert.equal(st.phase, 'question');
    const right = rightIndex(st);
    bySlot(r, 2).act({ type: 'answer', i: (right + 1) % 4, q: st.q.id });
    await r.clock.advance(150);
    bySlot(r, 1).act({ type: 'answer', i: right, q: st.q.id });
    await r.clock.advance(150);
    bySlot(r, 0).act({ type: 'answer', i: right, q: st.q.id });
    await r.clock.advance(300);
    st = state(r, TKEY);
    assert.equal(st.phase, 'reveal');
    assert.equal(st.sl.by, 1, 'the next fastest right answer steals');
    assert.equal(st.sl.from, 2);
    assert.ok(st.gained[1] > st.gained[0], 'the thief gets a bonus');
    assert.ok(jsonBytes(st) < MAX_VALUE_BYTES);
    const m = trivia.model(bySlot(r, 2).snapshot());
    assert.match(stealText(m.steal), /stole|swooped/);
    await r.clock.advance(REVEAL_MS + 200);
  }
  st = state(r, TKEY);
  assert.equal(st.phase, 'wager');
  assert.equal(st.i, 3);
  assert.equal(st.q, undefined, 'the question stays hidden while betting');
  const before = { ...h.snapshot().scores.g };
  const wm = trivia.model(bySlot(r, 1).snapshot());
  assert.equal(wm.phase, 'wager');
  assert.equal(wm.bets.length, 4);
  assert.match(footerText(wm), /Pick your bet/);
  bySlot(r, 1).act({ type: 'bet', p: 100 });
  bySlot(r, 2).act({ type: 'bet', p: 50 });
  bySlot(r, 2).act({ type: 'bet', p: 100 });
  bySlot(r, 0).act({ type: 'bet', p: 7 });
  await r.clock.advance(300);
  assert.equal(state(r, TKEY).phase, 'wager');
  assert.deepEqual(state(r, TKEY).bet.sort(), [1, 2]);
  bySlot(r, 0).act({ type: 'bet', p: 0 });
  await r.clock.advance(300);
  st = state(r, TKEY);
  assert.equal(st.phase, 'question', 'everyone bet, so the question starts right away');
  assert.equal(st.wq, 1);
  assert.equal(st.wg[1], wagerAmount(before[1], 100));
  assert.equal(st.wg[2], wagerAmount(before[2], 50));
  assert.equal(st.wg[0], undefined);
  const right = rightIndex(st);
  bySlot(r, 1).act({ type: 'answer', i: right, q: st.q.id });
  await r.clock.advance(150);
  bySlot(r, 2).act({ type: 'answer', i: (right + 2) % 4, q: st.q.id });
  bySlot(r, 0).act({ type: 'answer', i: (right + 2) % 4, q: st.q.id });
  await r.clock.advance(300);
  st = state(r, TKEY);
  assert.equal(st.phase, 'reveal');
  assert.ok(st.gained[1] >= st.wg[1], 'the winning bet pays out');
  const after = h.snapshot().scores.g;
  const had = before[2] || 0;
  assert.equal(after[2] || 0, had - Math.min(st.wg[2], had), 'the losing bet is taken away, but never below zero');
  assert.match(footerText(trivia.model(bySlot(r, 2).snapshot())), /Not this time/);
  await r.clock.advance(REVEAL_MS + 200);
  st = state(r, TKEY);
  assert.equal(st.phase, 'question');
  assert.equal(st.i, 4);
  assert.equal(h.snapshot().fun.final, false, 'the lightning round is the final round, not the last question');
  await r.clock.advance(10 * 1000 + 200);
  await r.clock.advance(REVEAL_MS + 200);
  st = state(r, TKEY);
  assert.equal(st.phase, 'bolt');
  assert.equal(st.bq.length, 5);
  assert.ok(st.bq.every((b) => !st.deck.includes(b.id)), 'lightning questions are fresh');
  assert.ok(jsonBytes(st) < MAX_VALUE_BYTES, String(jsonBytes(st)));
  assert.equal(h.snapshot().fun.final, true, 'FINAL ROUND for the lightning round');
  const ba = boltAnswers(st);
  for (let k = 0; k < 5; k += 1) bySlot(r, 1).act({ type: 'bolt', k, i: ba[k] });
  for (let k = 0; k < 5; k += 1) bySlot(r, 0).act({ type: 'bolt', k, i: k < 3 ? ba[k] : (ba[k] + 1) % 4 });
  bySlot(r, 2).act({ type: 'bolt', k: 2, i: 0 });
  await r.clock.advance(400);
  st = state(r, TKEY);
  assert.equal(st.phase, 'bolt');
  assert.deepEqual(st.done.slice().sort(), [0, 1]);
  const bm = trivia.model(bySlot(r, 2).snapshot(), { bolt: st.starts, picks: [] });
  assert.equal(bm.canAnswer, true);
  assert.equal(bm.current.k, 0);
  await r.clock.advance(BOLT_MS);
  st = state(r, TKEY);
  assert.equal(st.phase, 'boltshow');
  assert.equal(st.br[1], 5);
  assert.equal(st.br[0], 3);
  assert.equal(st.bk[1], boltPoints(5, 5) * 2, 'the final round doubles lightning points');
  assert.equal(st.bk[0], boltPoints(3, 5) * 2);
  const show = trivia.model(bySlot(r, 1).snapshot());
  assert.equal(show.myRight, 5);
  assert.equal(show.review.length, 5);
  assert.match(footerText(show), /5 of 5 right/);
  await r.clock.advance(BOLT_SHOW_MS + 200);
  const snap = h.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [1]);
  const titles = snap.fun.awards.map((a) => a.title);
  assert.ok(titles.includes('Master thief'), titles.join(', '));
  assert.ok(titles.includes('High roller') || titles.includes('Fearless gambler'), titles.join(', '));
  assert.ok(snap.fun.highlights.length >= 2);
  assert.ok(snap.fun.highlights.some((x) => /lightning round|stole|bet/.test(x.text)));
  for (const a of snap.fun.awards) for (const re of BANNED) assert.doesNotMatch(`${a.title} ${a.why}`, re);
  assert.ok(jsonBytes(r.hub.state[FX_KEY] || {}) < 2000);
  assert.deepEqual(r.hub.violations, []);
});

test('Trivia with every extra off plays exactly like the classic game', async () => {
  const r = await start(2, trivia, { rounds: 5, timer: 10, steal: false, wager: false, lightning: false });
  for (let q = 0; q < 5; q += 1) {
    const st = state(r, TKEY);
    assert.equal(st.phase, 'question');
    bySlot(r, 0).act({ type: 'answer', i: (rightIndex(st) + 1) % 4, q: st.q.id });
    await r.clock.advance(100);
    bySlot(r, 1).act({ type: 'answer', i: rightIndex(st), q: st.q.id });
    await r.clock.advance(300);
    assert.equal(state(r, TKEY).sl, undefined, 'no steals');
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(host(r).snapshot().room.phase, 'results');
  assert.equal(r.hub.state[FX_KEY] ?? null, null, 'nothing extra is written');
});

test('a host change while betting or during the lightning round keeps the game going fairly', async () => {
  const r = await start(3, trivia, { rounds: 5, timer: 10 });
  for (let q = 0; q < 3; q += 1) {
    await r.clock.advance(10 * 1000 + 200);
    await r.clock.advance(REVEAL_MS + 200);
  }
  let st = state(r, TKEY);
  assert.equal(st.phase, 'wager');
  bySlot(r, 1).act({ type: 'bet', p: 100 });
  await r.clock.advance(300);
  const old = r.engines[0];
  r.hub.leave(old.snapshot().me);
  old.destroy();
  r.engines.splice(0, 1);
  await r.clock.advance(600);
  st = state(r, TKEY);
  assert.equal(st.phase, 'question', 'the new host skips straight to the question');
  assert.equal(st.wg, undefined, 'lost bets are simply not counted');
  await r.clock.advance(10 * 1000 + 200);
  await r.clock.advance(REVEAL_MS + 200);
  await r.clock.advance(10 * 1000 + 200);
  await r.clock.advance(REVEAL_MS + 200);
  st = state(r, TKEY);
  assert.equal(st.phase, 'bolt');
  const ba = boltAnswers(st);
  bySlot(r, 1).act({ type: 'bolt', k: 0, i: ba[0] });
  await r.clock.advance(300);
  const late = r.add(9);
  late.join();
  await r.clock.advance(600);
  const lateSlot = late.snapshot().meSlot;
  assert.ok(state(r, TKEY).in.includes(lateSlot), 'a late joiner with time left plays the lightning round');
  const next = r.engines.find((e) => e.isHost());
  r.hub.leave(next.snapshot().me);
  next.destroy();
  r.engines.splice(r.engines.indexOf(next), 1);
  await r.clock.advance(600);
  st = state(r, TKEY);
  assert.equal(st.phase, 'boltshow');
  assert.equal(st.skipped, true);
  assert.deepEqual(st.bk, {});
  await r.clock.advance(BOLT_SHOW_MS + 300);
  assert.equal(host(r).snapshot().room.phase, 'results');
});

test('the peek card gives a fair hint and only while it can still help', () => {
  const store = {};
  const api = {
    random: seeded(4),
    memory: {},
    get: (k) => (store[k] ? JSON.parse(JSON.stringify(store[k])) : null),
  };
  store[TKEY] = { phase: 'question', q: { id: 'x', options: ['a', 'b', 'c', 'd'] }, answered: [] };
  api.memory.cur = { qid: 'x', answer: 2, picks: {} };
  const hint = trivia.hint(api, 0);
  assert.match(hint, /^It's not [ABD] or [ABD]\./);
  assert.doesNotMatch(hint, /C/);
  api.memory.cur.picks[0] = { i: 1, at: 1 };
  assert.equal(trivia.hint(api, 0), null, 'too late once you answered');
  store[TKEY] = { phase: 'wager' };
  assert.equal(trivia.hint(api, 1), null);
  const hl ={ phase: 'guess', r: 2, a: { id: 'x' }, b: { id: 'y' } };
  store[HKEY] = hl;
  api.memory.cur = { r: 2, picks: { 1: 'a' } };
  assert.equal(higherlower.hint(api, 1), null);
});

test('knockout picks who goes out: wrong answers first, then the slowest, always down to a 1 vs 1', () => {
  assert.deepEqual(koOut([0, 1, 2, 3], [{ s: 0, ok: true }, { s: 1, ok: true }, { s: 2, ok: false }, { s: 3, ok: false }]), [3, 2]);
  assert.deepEqual(koOut([0, 1, 2, 3], [{ s: 0, ok: true }, { s: 1, ok: false }, { s: 2, ok: false }, { s: 3, ok: false }]), [3, 2], 'never below two before the final');
  assert.deepEqual(koOut([0, 1, 2], [{ s: 0, ok: true }, { s: 1, ok: true }, { s: 2, ok: true }]), [2], 'everyone right: the slowest goes');
  assert.deepEqual(koOut([0, 1, 2], [{ s: 0, ok: false }, { s: 1, ok: false }, { s: 2, ok: false }]), [], 'everyone missed: nobody goes');
  assert.deepEqual(koOut([0, 1], [{ s: 1, ok: true }, { s: 0, ok: true }]), [0]);
  assert.deepEqual(koOut([0, 1], [{ s: 1, ok: true }]), [0], 'someone who left counts as a miss');
  assert.deepEqual(koOut([5], [{ s: 5, ok: true }]), []);
  assert.equal(koOn({ knockout: true }, 1), false);
  assert.equal(koOn({ knockout: false }, 5), false);
  assert.equal(koOn({}, 2), true);
  assert.equal(koTotal(3, [1, 2]), 3);
  assert.equal(koTotal(3, [1, 2, 3, 4]), 5);
  assert.deepEqual(pickOrder({ 0: 'a', 1: 'b', 2: 'a' }, { 0: 50, 1: 10, 2: 20 }, 'a', [0, 1, 2, 3]).map((x) => x.s), [2, 0, 1, 3]);
  assert.equal(koOutText({ out: [{ name: 'Rex' }] }), '👋 Rex is out!');
  assert.equal(koOutText({ out: [{ isMe: true }] }), '👋 You are out!');
  assert.match(koLine({ duel: true, left: 2 }), /1 vs 1/);
});

test('Higher or Lower knockout: wrong pickers go out, the final 1 vs 1 counts double, and the survivor wins', async () => {
  const r = await start(4, higherlower, { timer: 8 });
  let st = state(r, HKEY);
  assert.equal(st.ko, 1);
  assert.deepEqual(st.al, [0, 1, 2, 3]);
  let right = higherSide(st.a.id, st.b.id);
  let wrong = right === 'a' ? 'b' : 'a';
  bySlot(r, 0).act({ type: 'pick', side: right, r: st.r });
  await r.clock.advance(100);
  bySlot(r, 1).act({ type: 'pick', side: right, r: st.r });
  bySlot(r, 2).act({ type: 'pick', side: wrong, r: st.r });
  await r.clock.advance(100);
  bySlot(r, 3).act({ type: 'pick', side: wrong, r: st.r });
  await r.clock.advance(400);
  st = state(r, HKEY);
  assert.equal(st.phase, 'reveal');
  assert.deepEqual(st.kx, [3, 2]);
  assert.deepEqual(st.al, [0, 1]);
  const outView = higherlower.model(bySlot(r, 3).snapshot());
  assert.equal(outView.ko.out.length, 2);
  await r.clock.advance(H_REVEAL_MS + 200);
  st = state(r, HKEY);
  assert.equal(st.phase, 'guess');
  assert.deepEqual(st.in, [0, 1], 'only the survivors play');
  assert.equal(host(r).snapshot().fun.final, true, 'the 1 vs 1 is the FINAL ROUND');
  const m3 = higherlower.model(bySlot(r, 3).snapshot());
  assert.equal(m3.watching, true);
  assert.equal(m3.ko.imOut, true);
  assert.equal(m3.ko.duel, true);
  const late = r.add(8);
  late.join();
  await r.clock.advance(600);
  assert.equal(state(r, HKEY).in.includes(late.snapshot().meSlot), false, 'late joiners watch the knockout');
  right = higherSide(st.a.id, st.b.id);
  const pts = { ...host(r).snapshot().scores.g };
  bySlot(r, 1).act({ type: 'pick', side: right, r: st.r });
  await r.clock.advance(1000);
  bySlot(r, 0).act({ type: 'pick', side: right, r: st.r });
  await r.clock.advance(400);
  st = state(r, HKEY);
  assert.deepEqual(st.al, [1]);
  assert.equal(st.sv, SURVIVOR_POINTS * 2);
  assert.ok(host(r).snapshot().scores.g[1] - (pts[1] || 0) > SURVIVOR_POINTS);
  const champ = higherlower.model(bySlot(r, 1).snapshot());
  assert.equal(champ.ko.champ.isMe, true);
  await r.clock.advance(H_REVEAL_MS + 200);
  const snap = host(r).snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [1]);
  assert.ok(snap.fun.awards.some((a) => a.title === 'Last one standing'));
  assert.deepEqual(r.hub.violations, []);
});

test('Reflex knockout: a false start goes out first, then the slower tapper, and the survivor wins', async () => {
  const r = await start(3, reflex, { fakeouts: 'off' });
  let st = state(r, RKEY);
  assert.equal(st.ko, 1);
  bySlot(r, 2).act({ type: 'early', r: st.r, on: 'red' });
  await r.clock.advance(Math.max(0, greenOf(st) - host(r).now()) + 400);
  bySlot(r, 0).act({ type: 'tap', r: st.r, ms: 210 });
  bySlot(r, 1).act({ type: 'tap', r: st.r, ms: 240 });
  await r.clock.advance(400);
  st = state(r, RKEY);
  assert.equal(st.phase, 'show');
  assert.deepEqual(st.kx, [2]);
  assert.deepEqual(st.al, [0, 1]);
  assert.match(koNote(reflex.model(bySlot(r, 2).snapshot())), /out/);
  await r.clock.advance(SHOW_MS + 200);
  st = state(r, RKEY);
  assert.equal(st.phase, 'wait');
  assert.deepEqual(st.in, [0, 1]);
  await r.clock.advance(Math.max(0, greenOf(st) - host(r).now()) + 400);
  bySlot(r, 0).act({ type: 'tap', r: st.r, ms: 190 });
  bySlot(r, 1).act({ type: 'tap', r: st.r, ms: 330 });
  await r.clock.advance(400);
  st = state(r, RKEY);
  assert.deepEqual(st.al, [0]);
  assert.ok(st.sv > 0);
  assert.match(koNote(reflex.model(bySlot(r, 0).snapshot())), /You won the knockout/);
  await r.clock.advance(SHOW_MS + 200);
  const snap = host(r).snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [0]);
  assert.ok(snap.fun.awards.some((a) => a.title === 'Last one standing'));
  assert.ok(snap.fun.awards.some((a) => a.title === 'Fastest hands'));
  assert.deepEqual(r.hub.violations, []);
});

test('the trivia view shows the wager buttons and walks through the lightning round one question at a time', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [trivia] });
  await r.clock.advance(500);
  const played = [];
  const cues = { play: (n) => played.push(n), burst() {}, float() {} };
  const i1 = 1;
  const engine = r.engines[i1];
  const v = createTriviaView({ engine, fx: { confetti() {} }, cues });
  engine.on('change', (snap) => v.update(snap));
  r.engines[0].lobby.pick('trivia');
  r.engines[0].lobby.setting('rounds', 5);
  r.engines[0].lobby.setting('timer', 10);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  for (let q = 0; q < 3; q += 1) {
    await r.clock.advance(10 * 1000 + 200);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(state(r, TKEY).phase, 'wager');
  assert.match(text(v.el), /How much do you dare to bet/);
  const bets = v.el.querySelectorAll('.qz-bet');
  assert.equal(bets.length, 4);
  [...bets].find((b) => b.dataset.key === 'bet-100').click();
  await r.clock.advance(300);
  const mySlot = engine.snapshot().meSlot;
  assert.ok(state(r, TKEY).bet.includes(mySlot));
  assert.match(text(v.el), /Bet locked in/);
  await r.clock.advance(WAGER_MS);
  assert.equal(state(r, TKEY).phase, 'question');
  assert.match(text(v.el), /You bet/);
  for (let q = 0; q < 2; q += 1) {
    await r.clock.advance(10 * 1000 + 200);
    await r.clock.advance(REVEAL_MS + 200);
  }
  const st = state(r, TKEY);
  assert.equal(st.phase, 'bolt');
  assert.match(text(v.el), /Lightning round/);
  const ba = boltAnswers(st);
  for (let k = 0; k < 5; k += 1) {
    assert.match(text(v.el), new RegExp(`Question ${k + 1} of 5`));
    [...v.el.querySelectorAll('.qz-bolt-options .option')].find((b) => b.dataset.key === `bolt-${k}-${ba[k]}`).click();
  }
  await r.clock.advance(300);
  assert.match(text(v.el), /All five done/);
  assert.ok(state(r, TKEY).done.includes(mySlot));
  await r.clock.advance(BOLT_MS);
  assert.equal(state(r, TKEY).phase, 'boltshow');
  assert.match(text(v.el), /5 of 5 right/);
  assert.ok(played.includes('correct'));
  for (const node of [v.el, ...all(v.el)]) assert.equal(node.hasAttribute('style'), false);
  for (const re of BANNED) assert.doesNotMatch(text(v.el), re);
  v.destroy();
});

test('the knockout views show who is still standing without inline styles', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3, { games: [higherlower, reflex] });
  await r.clock.advance(500);
  const hv = createHigherlowerView({ engine: r.engines[1], fx: { confetti() {} }, cues: null });
  const rv = createReflexView({ engine: r.engines[2], fx: { confetti() {} }, cues: null, win: {} });
  r.engines[1].on('change', (s) => hv.update(s));
  r.engines[2].on('change', (s) => rv.update(s));
  r.engines[0].lobby.pick('higherlower');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  assert.match(text(hv.el), /3 still standing/);
  assert.ok(hv.el.querySelector('.ko-bar'));
  assert.doesNotMatch(text(hv.el), /Round 1 of/);
  for (const node of [hv.el, ...all(hv.el)]) assert.equal(node.hasAttribute('style'), false);
  hv.destroy();
  rv.destroy();
});

test('quiz state stays inside the limits with a full room and every extra on', async () => {
  const r = await start(24, trivia, { rounds: 5, timer: 10 });
  for (let q = 0; q < 5; q += 1) {
    const st = state(r, TKEY);
    if (st.phase === 'wager') {
      for (const e of r.engines) e.act({ type: 'bet', p: 100 });
      await r.clock.advance(500);
    }
    const now = state(r, TKEY);
    for (const e of r.engines) e.act({ type: 'answer', i: rightIndex(now), q: now.q.id });
    await r.clock.advance(800);
    assert.ok(jsonBytes(state(r, TKEY)) < MAX_VALUE_BYTES);
    await r.clock.advance(REVEAL_MS + 200);
  }
  const st = state(r, TKEY);
  assert.equal(st.phase, 'bolt');
  const ba = boltAnswers(st);
  for (const e of r.engines) for (let k = 0; k < 5; k += 1) e.act({ type: 'bolt', k, i: ba[k] });
  await r.clock.advance(1500);
  const show = state(r, TKEY);
  assert.equal(show.phase, 'boltshow');
  assert.ok(jsonBytes(show) < MAX_VALUE_BYTES, String(jsonBytes(show)));
  assert.ok(jsonBytes(r.hub.state[FX_KEY]) < MAX_VALUE_BYTES);
  assert.equal(STEAL_POINTS > 0, true);
  assert.deepEqual(r.hub.violations, []);
});
