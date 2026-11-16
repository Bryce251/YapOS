import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine, PRED, PREDICT_MS, PREDICT_MAX } from '../web/activity/js/engine.js';
import { resultsBody, PARTY_SHARDS_PREDICTION } from '../web/activity/js/admin.js';
import { shardsEarned } from '../web/activity/js/ui/results.js';
import { predictModel, predictWaitModel, predictResultsModel, predictBox, predictResults } from '../web/activity/js/ui/predict.js';

const ID = (n) => person(n).id;

function stub() {
  return {
    id: 'trivia',
    name: 'Stub',
    emoji: '🧪',
    category: 'quiz',
    blurb: 'Stub',
    minPlayers: 1,
    keys: ['stub'],
    settings: [],
    start(api) {
      api.put('stub', { on: 1 });
      api.addPoints(0, 30);
      api.addPoints(1, 10);
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

function party(players, watchers, posts) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(9);
  const engines = [];
  for (let i = 1; i <= players + watchers; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: [stub()], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: (b) => posts.push(b) });
    if (i <= players) e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

test('watchers get a free pick at the start, right picks are posted and earn Shards, wrong ones lose nothing', async () => {
  const posts = [];
  const r = party(2, 2, posts);
  await r.clock.advance(500);
  const [host, player, right, wrong] = r.engines;
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const w = right.snapshot();
  const m = predictModel(w);
  assert.ok(m, 'a watcher sees the picker');
  assert.equal(m.players.length, 2);
  assert.equal(predictModel(player.snapshot()), null, 'players never get the picker');
  assert.equal(player.predict(0), false);
  assert.equal(right.predict(0), true);
  assert.equal(wrong.predict(1), true);
  assert.equal(predictModel(right.snapshot()).mine, 0, 'the pick shows straight away');
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state[PRED].p, { [ID(3)]: 0, [ID(4)]: 1 });
  assert.equal(wrong.predict(0), true, 'a watcher can change their mind while picks are open');
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[PRED].p[ID(4)], 0);
  assert.equal(wrong.predict(1), true);
  await r.clock.advance(PREDICT_MS);
  assert.equal(predictModel(right.snapshot()), null, 'the window closes');
  assert.equal(predictWaitModel(right.snapshot()).name, 'Player 1');
  assert.equal(right.predict(1), false);
  host.lobby.end();
  await r.clock.advance(400);
  assert.equal(posts.length, 1);
  const preds = posts[0].predictions;
  assert.deepEqual(preds, [
    { id: ID(3), name: 'Player 3', username: null, pick: ID(1), right: true },
    { id: ID(4), name: 'Player 4', username: null, pick: ID(2), right: false },
  ]);
  assert.deepEqual(resultsBody(posts[0]).predictions, preds);
  const rs = right.snapshot();
  assert.equal(shardsEarned(rs.room.last, rs.players, rs.predict), PARTY_SHARDS_PREDICTION);
  const ws = wrong.snapshot();
  assert.equal(shardsEarned(ws.room.last, ws.players, ws.predict), 0);
  const res = predictResultsModel(rs);
  assert.equal(res.right, 1);
  assert.equal(res.rows[0].isMe, true);
  assert.equal(res.rows[0].right, true);
  assert.equal(res.rows[1].pick, 'Player 2');
  installDom();
  const card = predictResults(res);
  assert.match(card.textContent, /Watcher picks/);
  assert.match(card.textContent, /1 of 2 right/);
  assert.ok(predictBox(m, () => {}));
});

test('late picks, strangers and picks for people not playing are refused', async () => {
  const posts = [];
  const r = party(2, 1, posts);
  await r.clock.advance(500);
  const [host, , watcher] = r.engines;
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(watcher.predict(7), true, 'the guest sends it but the host checks it');
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state[PRED].p, {});
  watcher.broadcast({ t: 'pick', r: 99, p: 0 });
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state[PRED].p, {});
  await r.clock.advance(PREDICT_MS);
  watcher.broadcast({ t: 'pick', r: host.snapshot().room.round, p: 0 });
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state[PRED].p, {});
});

test('a watcher who joins mid game loses their pick and players never appear in predictions', async () => {
  const posts = [];
  const r = party(2, 1, posts);
  await r.clock.advance(500);
  const [host, , watcher] = r.engines;
  host.lobby.start();
  await r.clock.advance(300);
  watcher.predict(0);
  await r.clock.advance(400);
  watcher.join();
  await r.clock.advance(400);
  assert.equal(watcher.snapshot().meJoined, true);
  host.lobby.end();
  await r.clock.advance(400);
  assert.equal(posts[0].predictions, undefined);
  const body = resultsBody({ ...posts[0], predictions: [{ id: ID(1), name: 'x', pick: ID(2), right: true }, { id: ID(9), name: 'y', pick: ID(9), right: true }, { id: ID(8), name: 'z', pick: ID(1), right: 'yes' }] });
  assert.deepEqual(body.predictions, [{ id: ID(8), name: 'z', username: null, pick: ID(1), right: false }]);
});

test('no picker opens when nobody is watching, and picks are capped', async () => {
  const posts = [];
  const r = party(2, 0, posts);
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  assert.equal(r.engines[0].snapshot().state[PRED], undefined);
  assert.equal(PREDICT_MAX, 16);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, pick: ID(1), right: true }));
  const body = resultsBody({ game: 'trivia', players: [{ id: ID(1), name: 'a', score: 1 }, { id: ID(2), name: 'b', score: 0 }], predictions: many });
  assert.equal(body.predictions.length, 16);
});
