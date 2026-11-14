import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, QUESTIONS, TIERS, questionById } from '../web/activity/data/trivia.js';
import { buildDeck, speedPoints, rampFor, tierOf, MIX } from '../web/activity/js/games/trivia.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { seeded } from './activity-kit.test.js';

const RANK = { easy: 0, medium: 1, hard: 2 };
const tierOfId = (id) => questionById(id).tier;

test('harder questions are worth more points', () => {
  assert.equal(speedPoints(0, 0, 10000, 'easy'), 1000);
  assert.equal(speedPoints(0, 0, 10000, 'medium'), 1250);
  assert.equal(speedPoints(0, 0, 10000, 'hard'), 1500);
  assert.equal(speedPoints(10000, 0, 10000, 'hard'), 600);
  assert.equal(speedPoints(10000, 0, 10000, 'easy'), 400);
  assert.equal(speedPoints(0, 0, 10000), 1000);
  assert.equal(speedPoints(0, 0, 10000, 'nonsense'), 1000);
  assert.equal(tierOf('nope').id, 'easy');
});

test('trivia has a Difficulty setting that defaults to mixed', () => {
  const trivia = GAMES.find((g) => g.id === 'trivia');
  const level = trivia.settings.find((s) => s.id === 'level');
  assert.ok(level);
  assert.equal(level.default, MIX);
  assert.deepEqual(level.options.map((o) => o.value), [MIX, 'easy', 'medium', 'hard']);
});

test('every question has a real difficulty and sane data', () => {
  const ids = new Set();
  const texts = new Set();
  for (const q of QUESTIONS) {
    assert.ok(TIERS.some((t) => t.id === q.tier), q.id);
    assert.ok(!ids.has(q.id), `duplicate id ${q.id}`);
    ids.add(q.id);
    const key = q.q.toLowerCase().replace(/[^a-z0-9]/g, '');
    assert.ok(!texts.has(key), `duplicate question ${q.id}: ${q.q}`);
    texts.add(key);
    assert.equal(q.w.length, 3, q.id);
    const all = [q.a, ...q.w].map((x) => String(x).trim().toLowerCase());
    assert.equal(new Set(all).size, 4, `${q.id} has a repeated option`);
    assert.ok(q.q.length <= 160, `${q.id} question too long`);
    for (const o of [q.a, ...q.w]) assert.ok(String(o).length > 0 && String(o).length <= 48, `${q.id} option "${o}"`);
  }
});

test('a single difficulty only uses that tier when there are enough', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const deck = buildDeck(null, 20, seeded(3), level);
    assert.equal(deck.length, 20);
    assert.equal(new Set(deck).size, 20);
    assert.ok(deck.every((id) => tierOfId(id) === level), level);
  }
});

test('a small category fills up from the nearest difficulty instead of coming up short', () => {
  const cat = CATEGORIES[0].id;
  const hard = QUESTIONS.filter((q) => q.cat === cat && q.tier === 'hard').length;
  const want = hard + 3;
  const deck = buildDeck([cat], want, seeded(5), 'hard');
  assert.equal(deck.length, Math.min(want, QUESTIONS.filter((q) => q.cat === cat).length));
  assert.equal(deck.filter((id) => tierOfId(id) === 'hard').length, hard);
  assert.ok(deck.filter((id) => tierOfId(id) !== 'hard').every((id) => tierOfId(id) === 'medium'));
});

test('mixed starts easy and gets harder', () => {
  assert.deepEqual(rampFor(10), [['easy', 4], ['medium', 3], ['hard', 3]]);
  assert.deepEqual(rampFor(5), [['easy', 2], ['medium', 2], ['hard', 1]]);
  for (const seed of [1, 2, 3, 4]) {
    const deck = buildDeck(null, 15, seeded(seed), MIX);
    assert.equal(new Set(deck).size, 15);
    const ranks = deck.map((id) => RANK[tierOfId(id)]);
    for (let i = 1; i < ranks.length; i += 1) assert.ok(ranks[i] >= ranks[i - 1], `seed ${seed}: ${ranks.join('')}`);
    assert.equal(ranks[0], 0);
    assert.equal(ranks[ranks.length - 1], 2);
  }
});

test('each category has plenty of questions at every difficulty', () => {
  for (const c of CATEGORIES) {
    for (const t of TIERS) {
      const n = QUESTIONS.filter((q) => q.cat === c.id && q.tier === t.id).length;
      assert.ok(n >= 15, `${c.id} ${t.id} has only ${n}`);
    }
  }
});
