import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import trivia, { speedPoints, buildDeck as triviaDeck, MIN_POINTS, MAX_POINTS, REVEAL_MS } from '../web/activity/js/games/trivia.js';
import wyr, { award, buildDeck as wyrDeck, WIN_POINTS, TIE_POINTS } from '../web/activity/js/games/wyr.js';
import { QUESTIONS, CATEGORIES, questionById } from '../web/activity/data/trivia.js';
import { PROMPTS } from '../web/activity/data/wyr.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { jsonBytes } from '../web/activity/js/limits.js';
import { seeded } from './activity-kit.test.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function rightIndex(st) {
  const q = questionById(st.q.id);
  return st.q.options.indexOf(q.a);
}

async function startGame(n, id, settings = {}) {
  const r = room(n);
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(id), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

test('trivia data has about 150 fresh, well-formed questions in every category', () => {
  assert.ok(QUESTIONS.length >= 145, String(QUESTIONS.length));
  const ids = new Set();
  const texts = new Set();
  for (const q of QUESTIONS) {
    assert.equal(ids.has(q.id), false, q.id);
    ids.add(q.id);
    assert.equal(texts.has(q.q), false, q.q);
    texts.add(q.q);
    assert.equal(q.w.length, 3, q.q);
    assert.equal(new Set([q.a, ...q.w]).size, 4, q.q);
    assert.ok(q.q.endsWith('?'), q.q);
    assert.ok(CATEGORIES.some((c) => c.id === q.cat));
    for (const re of BANNED) assert.equal(re.test([q.q, q.a, ...q.w].join(' ')), false, q.q);
    assert.ok(q.q.length <= 120 && [q.a, ...q.w].every((x) => x.length <= 40), q.q);
  }
  for (const c of CATEGORIES) assert.ok(QUESTIONS.filter((q) => q.cat === c.id).length >= 20, c.id);
});

test('would you rather has about 120 unique prompts', () => {
  assert.ok(PROMPTS.length >= 115, String(PROMPTS.length));
  const seen = new Set();
  for (const p of PROMPTS) {
    const key = `${p.a}|${p.b}`;
    assert.equal(seen.has(key), false, key);
    seen.add(key);
    assert.notEqual(p.a, p.b);
    for (const re of BANNED) assert.equal(re.test(`${p.a} ${p.b}`), false, key);
    assert.ok(p.a.length <= 80 && p.b.length <= 80, key);
  }
});

test('every game follows the module interface', () => {
  for (const g of GAMES) {
    assert.match(g.id, /^[a-z]+$/);
    assert.equal(typeof g.name, 'string');
    assert.equal(typeof g.blurb, 'string');
    for (const fn of ['start', 'intent', 'deadline', 'resume', 'model']) assert.equal(typeof g[fn], 'function', `${g.id}.${fn}`);
    assert.ok(Array.isArray(g.keys) && g.keys.length);
    for (const s of g.settings) assert.ok(s.options.some((o) => JSON.stringify(o.value) === JSON.stringify(s.default)) || s.type === 'multi');
  }
});

test('trivia speed points run from 1000 down to 400', () => {
  assert.equal(speedPoints(0, 0, 20000), MAX_POINTS);
  assert.equal(speedPoints(20000, 0, 20000), MIN_POINTS);
  assert.equal(speedPoints(10000, 0, 20000), 700);
  assert.ok(speedPoints(5000, 0, 20000) > speedPoints(6000, 0, 20000));
});

test('trivia decks respect categories and length', () => {
  const deck = triviaDeck(['space', 'food'], 10, seeded(3));
  assert.equal(deck.length, 10);
  assert.equal(new Set(deck).size, 10);
  for (const id of deck) assert.ok(['space', 'food'].includes(questionById(id).cat));
});

test('a trivia round hides the answer, scores by speed and reveals who got it', async () => {
  const r = await startGame(3, 'trivia', { rounds: 5, timer: 20, cats: ['science', 'animals'] });
  const [host, a, b] = r.engines;
  let st = a.snapshot().state.trivia;
  assert.equal(st.phase, 'question');
  assert.equal(st.total, 5);
  assert.equal(st.answer, null);
  assert.equal(st.chose, null);
  assert.ok(['science', 'animals'].includes(st.q.cat));
  const right = rightIndex(st);
  const wrong = (right + 1) % 4;
  a.act({ type: 'answer', i: right, q: st.q.id });
  await r.clock.advance(4000);
  b.act({ type: 'answer', i: right, q: st.q.id });
  await r.clock.advance(300);
  assert.equal(a.snapshot().state.trivia.answered.length, 2);
  assert.equal(a.snapshot().state.trivia.answer, null);
  host.act({ type: 'answer', i: wrong });
  await r.clock.advance(400);
  st = b.snapshot().state.trivia;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.answer, right);
  assert.deepEqual(st.right, [1, 2]);
  assert.ok(st.gained[1] > st.gained[2]);
  assert.equal(st.chose[0], wrong);
  const scores = b.snapshot().scores.g;
  assert.equal(scores[1], st.gained[1]);
  assert.equal(scores[0], undefined);
  const m = trivia.model(a.snapshot());
  assert.equal(m.gotIt, true);
  assert.equal(m.options[right].correct, true);
  assert.equal(m.options[right].count, 2);
  assert.equal(m.options[wrong].count, 1);
  assert.deepEqual(m.right.map((x) => x.name), ['Player 2', 'Player 3']);
  await r.clock.advance(REVEAL_MS + 300);
  st = b.snapshot().state.trivia;
  assert.equal(st.phase, 'question');
  assert.equal(st.i, 1);
});

test('answers are checked: one per player, valid options only, none after time', async () => {
  const r = await startGame(2, 'trivia', { rounds: 5, timer: 10 });
  const [, a] = r.engines;
  const st = a.snapshot().state.trivia;
  a.act({ type: 'answer', i: 9 });
  a.act({ type: 'answer', i: 'x' });
  await r.clock.advance(300);
  assert.equal(a.snapshot().state.trivia.answered.length, 0);
  a.act({ type: 'answer', i: rightIndex(st) });
  a.act({ type: 'answer', i: (rightIndex(st) + 1) % 4 });
  await r.clock.advance(11000);
  const after = a.snapshot().state.trivia;
  assert.equal(after.phase, 'reveal');
  assert.deepEqual(after.right, [1]);
  assert.equal(after.chose[1], rightIndex(st));
  a.act({ type: 'answer', i: rightIndex(st) });
  await r.clock.advance(300);
  assert.equal(a.snapshot().scores.g[1], after.gained[1]);
});

test('trivia skips the question when the host changes mid-question, then carries on', async () => {
  const r = await startGame(3, 'trivia', { rounds: 5, timer: 20 });
  const [host, a, b] = r.engines;
  const st = a.snapshot().state.trivia;
  a.act({ type: 'answer', i: rightIndex(st) });
  await r.clock.advance(500);
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(300);
  const now = b.snapshot().state.trivia;
  assert.equal(now.phase, 'reveal');
  assert.equal(now.skipped, true);
  assert.equal(now.answer, rightIndex(st));
  assert.deepEqual(now.right, []);
  assert.deepEqual(b.snapshot().scores.g, {});
  await r.clock.advance(REVEAL_MS + 300);
  const next = b.snapshot().state.trivia;
  assert.equal(next.phase, 'question');
  assert.equal(next.i, 1);
  b.act({ type: 'answer', i: rightIndex(next) });
  a.act({ type: 'answer', i: rightIndex(next) });
  await r.clock.advance(500);
  assert.equal(b.snapshot().state.trivia.phase, 'reveal');
  assert.deepEqual(b.snapshot().state.trivia.right, [1, 2]);
});

test('a host change during the reveal keeps the same deadline', async () => {
  const r = await startGame(2, 'trivia', { rounds: 5, timer: 10 });
  const [host, a] = r.engines;
  await r.clock.advance(10500);
  const reveal = a.snapshot().state.trivia;
  assert.equal(reveal.phase, 'reveal');
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(300);
  assert.equal(a.snapshot().state.trivia.phase, 'reveal');
  assert.equal(a.snapshot().room.deadline, reveal.ends);
  await r.clock.advance(REVEAL_MS);
  assert.equal(a.snapshot().state.trivia.i, 1);
});

test('a full trivia game ends on results with winners and totals', async () => {
  const r = await startGame(2, 'trivia', { rounds: 5, timer: 10 });
  const [host, a] = r.engines;
  for (let i = 0; i < 5; i += 1) {
    const st = a.snapshot().state.trivia;
    assert.equal(st.i, i);
    a.act({ type: 'answer', i: rightIndex(st) });
    host.act({ type: 'answer', i: (rightIndex(st) + 1) % 4 });
    await r.clock.advance(400);
    await r.clock.advance(REVEAL_MS + 300);
  }
  const s = a.snapshot();
  assert.equal(s.room.phase, 'results');
  assert.deepEqual(s.room.last.winners, [1]);
  assert.ok(s.scores.t[1] >= 5 * MIN_POINTS);
  assert.equal(s.scores.t[0] || 0, 0);
});

test('a late joiner sees the current question and can answer', async () => {
  const r = await startGame(2, 'trivia', { rounds: 5, timer: 20 });
  await r.clock.advance(2000);
  const late = r.add(3);
  await r.clock.advance(400);
  const m = trivia.model(late.snapshot());
  assert.equal(m.phase, 'question');
  assert.equal(m.number, 1);
  assert.equal(m.options.length, 4);
  assert.ok(m.ends > late.snapshot().now);
  assert.equal(m.iAnswered, false);
  const st = late.snapshot().state.trivia;
  late.act({ type: 'answer', i: rightIndex(st) });
  await r.clock.advance(300);
  assert.equal(trivia.model(late.snapshot(), { qid: st.q.id, pick: rightIndex(st) }).iAnswered, true);
  assert.deepEqual(late.snapshot().state.trivia.answered, [2]);
});

test('trivia state stays small with a full room', async () => {
  const r = await startGame(24, 'trivia', { rounds: 20, timer: 30 });
  await r.clock.advance(2000);
  const st = r.engines[3].snapshot().state.trivia;
  for (const e of r.engines) e.act({ type: 'answer', i: rightIndex(st) });
  await r.clock.advance(2000);
  const after = r.hub.state.trivia;
  assert.equal(after.phase, 'reveal');
  assert.ok(jsonBytes(after) < 2500, String(jsonBytes(after)));
  assert.deepEqual(r.hub.violations, []);
});

test('would you rather awards the crowd, the rebels and ties', () => {
  assert.deepEqual(award({ 0: 'a', 1: 'a', 2: 'b' }, 'majority').gained, { 0: WIN_POINTS, 1: WIN_POINTS });
  assert.deepEqual(award({ 0: 'a', 1: 'a', 2: 'b' }, 'minority').gained, { 2: WIN_POINTS });
  assert.deepEqual(award({ 0: 'a', 1: 'b' }, 'majority').gained, { 0: TIE_POINTS, 1: TIE_POINTS });
  assert.deepEqual(award({ 0: 'a', 1: 'a' }, 'minority').gained, {});
  assert.equal(award({}, 'majority').side, null);
  assert.equal(new Set(wyrDeck(10, seeded(5))).size, 10);
});

test('a would you rather round keeps votes secret until the split', async () => {
  const r = await startGame(3, 'wyr', { rounds: 5, timer: 15 });
  const [host, a, b] = r.engines;
  let st = a.snapshot().state.wyr;
  assert.equal(st.phase, 'vote');
  a.act({ type: 'vote', side: 'a', p: st.p.id });
  b.act({ type: 'vote', side: 'a' });
  await r.clock.advance(400);
  st = host.snapshot().state.wyr;
  assert.deepEqual(st.voted.sort(), [1, 2]);
  assert.equal(st.votes, null);
  assert.equal(r.hub.state.wyr.votes, null);
  host.act({ type: 'vote', side: 'b' });
  await r.clock.advance(400);
  st = a.snapshot().state.wyr;
  assert.equal(st.phase, 'reveal');
  assert.deepEqual(st.split, { a: 2, b: 1 });
  const m = wyr.model(a.snapshot());
  assert.equal(m.pctA, 67);
  assert.equal(m.pctB, 33);
  assert.equal(m.myVote, 'a');
  assert.equal(m.myGain, WIN_POINTS);
  assert.deepEqual(m.voters.a.map((p) => p.name), ['Player 2', 'Player 3']);
  assert.equal(a.snapshot().scores.g[0], undefined);
});

test('would you rather rebels mode pays the smaller side', async () => {
  const r = await startGame(3, 'wyr', { rounds: 5, timer: 10, mode: 'minority' });
  const [host, a, b] = r.engines;
  a.act({ type: 'vote', side: 'b' });
  b.act({ type: 'vote', side: 'a' });
  host.act({ type: 'vote', side: 'a' });
  a.act({ type: 'vote', side: 'a' });
  await r.clock.advance(500);
  assert.deepEqual(a.snapshot().scores.g, { 1: WIN_POINTS });
});

test('would you rather asks again when the host leaves mid-vote, then finishes', async () => {
  const r = await startGame(3, 'wyr', { rounds: 5, timer: 10 });
  const [host, a, b] = r.engines;
  const first = a.snapshot().state.wyr;
  a.act({ type: 'vote', side: 'a' });
  await r.clock.advance(400);
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(400);
  const again = b.snapshot().state.wyr;
  assert.equal(again.phase, 'vote');
  assert.equal(again.p.id, first.p.id);
  assert.deepEqual(again.voted, []);
  assert.equal(again.note, 'host');
  assert.ok(again.ends > first.ends);
  for (let i = 0; i < 5; i += 1) {
    a.act({ type: 'vote', side: 'a' });
    b.act({ type: 'vote', side: 'b' });
    await r.clock.advance(500);
    assert.equal(b.snapshot().state.wyr.phase, 'reveal');
    await r.clock.advance(7000);
  }
  const s = a.snapshot();
  assert.equal(s.room.phase, 'results');
  assert.equal(s.scores.t[1], 5 * TIE_POINTS);
  assert.deepEqual(s.room.last.winners.sort(), [1, 2]);
  assert.deepEqual(r.hub.violations, []);
});

test('nobody voting moves on when time is up', async () => {
  const r = await startGame(2, 'wyr', { rounds: 5, timer: 10 });
  await r.clock.advance(10500);
  const st = r.engines[1].snapshot().state.wyr;
  assert.equal(st.phase, 'reveal');
  assert.deepEqual(st.split, { a: 0, b: 0 });
  assert.equal(wyr.model(r.engines[1].snapshot()).pctA, 50);
});
