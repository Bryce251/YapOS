import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine } from '../web/activity/js/engine.js';
import { shardPay, placeShards, streakShards, partyShards, PARTY_SHARDS_PLAY, PARTY_SHARDS_WIN, PARTY_SHARDS_TOURNAMENT, PARTY_SHARDS_PREDICTION } from '../web/activity/js/admin.js';
import { shardsEarned, shardsBreakdown, SHARDS_TITLE } from '../web/activity/js/ui/results.js';

const ID = (n) => person(n).id;

function stubGame() {
  return {
    id: 'trivia',
    name: 'Stub',
    emoji: '🧪',
    category: 'quiz',
    blurb: 'Stub game',
    minPlayers: 1,
    keys: ['stub'],
    settings: [],
    start(api) {
      api.put('stub', { on: 1 });
      api.addPoints(0, 90);
      api.addPoints(1, 50);
      api.addPoints(2, 30);
      api.addPoints(3, 10);
    },
    intent() {},
    deadline(api) {
      api.finish();
    },
    resume() {},
    model() {
      return null;
    },
  };
}

function party(count, postResults) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(9);
  const engines = [];
  for (let i = 1; i <= count; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: [stubGame()], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults });
    e.join();
    engines.push(e);
  }
  return { clock, engines };
}

async function playOne(r) {
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  assert.equal(r.engines[0].lobby.end(), true);
  await r.clock.advance(300);
}

test('the activity shows the new default Party pay', () => {
  assert.equal(PARTY_SHARDS_PLAY, 25);
  assert.equal(PARTY_SHARDS_WIN, 100);
  assert.equal(PARTY_SHARDS_TOURNAMENT, 500);
  assert.equal(PARTY_SHARDS_PREDICTION, 50);
  assert.equal(partyShards(true), 125);
  assert.equal(placeShards(2), 50);
  assert.equal(placeShards(3), 25);
  assert.equal(placeShards(4), 0);
  assert.deepEqual([1, 2, 4, 11, 30].map((n) => streakShards(n)), [0, 10, 30, 100, 100]);
  for (const bit of ['25 a game', '100 more for a win', '50 for 2nd', '25 for 3rd', '4+ players', '+10%', '+100%']) assert.ok(SHARDS_TITLE.includes(bit), bit);
});

test('Worker pay rows turn into a compact per-slot breakdown', () => {
  const players = [{ id: ID(1), slot: 0 }, { id: ID(2), slot: 1 }, { id: ID(3), slot: 2 }];
  const sp = shardPay([
    { id: ID(1), shards: 25, reason: 'play' },
    { id: ID(1), shards: 100, reason: 'win' },
    { id: ID(1).toUpperCase(), shards: 30, reason: 'winstreak', streak: 4 },
    { id: ID(2), shards: 25, reason: 'play' },
    { id: ID(2), shards: 50, reason: 'place', place: 2 },
    { id: ID(3), shards: 25, reason: 'play' },
    { id: ID(3), shards: 25, reason: 'place', place: 3 },
    { id: ID(3), shards: 5, reason: 'gift' },
    { id: ID(3), shards: 1e9, reason: 'play' },
    { id: ID(9), shards: 50, reason: 'prediction' },
    null,
  ], players);
  assert.deepEqual(sp, {
    0: { t: 155, w: 100, s: 30, n: 4 },
    1: { t: 75, p: 50, r: 2 },
    2: { t: 50, p: 25, r: 3 },
  });
  const me = (slot) => [{ slot, isMe: true, id: 'x' }];
  const last = { ps: [0, 1, 2], winners: [0], sp };
  assert.equal(shardsBreakdown(last, me(0)), '+100 win · +30 streak x4');
  assert.equal(shardsBreakdown(last, me(1)), '+50 2nd place');
  assert.equal(shardsBreakdown(last, me(2)), '+25 3rd place');
  assert.equal(shardsEarned(last, me(0)), 155);
  assert.equal(shardsEarned(last, me(1)), 75);
  assert.equal(shardsBreakdown({ ps: [0, 1], winners: [0] }, me(0)), '');
  assert.equal(shardsEarned({ ps: [0, 1], winners: [0] }, me(0)), 125, 'without the Worker reply the estimate stays');
});

test('the host shares what the Worker really paid, so every player sees their breakdown', async () => {
  const posts = [];
  const r = party(4, async (body) => {
    posts.push(body);
    const [a, b, c] = body.players.map((p) => p.id);
    return { ok: true, counted: true, shards: [
      { id: a, shards: 25, reason: 'play' },
      { id: a, shards: 100, reason: 'win' },
      { id: a, shards: 20, reason: 'winstreak', streak: 3 },
      { id: b, shards: 25, reason: 'play' },
      { id: b, shards: 50, reason: 'place', place: 2 },
      { id: c, shards: 25, reason: 'play' },
      { id: c, shards: 25, reason: 'place', place: 3 },
    ], held: [] };
  });
  await playOne(r);
  assert.equal(posts.length, 1);
  const seen = r.engines.map((e) => {
    const snap = e.snapshot();
    return [shardsEarned(snap.room.last, snap.players), shardsBreakdown(snap.room.last, snap.players)];
  });
  assert.deepEqual(seen, [
    [145, '+100 win · +20 streak x3'],
    [75, '+50 2nd place'],
    [50, '+25 3rd place'],
    [PARTY_SHARDS_PLAY, ''],
  ]);
});

test('without a Worker reply the results keep the estimate', async () => {
  const r = party(4, () => true);
  await playOne(r);
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.last.sp, undefined);
  assert.equal(shardsEarned(snap.room.last, snap.players), PARTY_SHARDS_PLAY + PARTY_SHARDS_WIN);
});
