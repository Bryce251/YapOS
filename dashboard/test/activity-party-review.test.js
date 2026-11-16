import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine, PRED, PREDICT_MAX } from '../web/activity/js/engine.js';
import { resultsBody } from '../web/activity/js/admin.js';
import { TUNES, KINDS } from '../web/activity/data/musicquiz.js';
import { WORDS } from '../web/activity/data/hangman.js';
import { STARTERS } from '../web/activity/data/story.js';
import { isBlockedGameWord } from '../web/activity/js/filter.js';
import { hidesWords } from '../web/activity/js/text.js';

const ID = (n) => person(n).id;

function stub(id, scores, min = 1) {
  return {
    id,
    name: `Game ${id}`,
    emoji: '🎲',
    category: 'quick',
    blurb: 'Stub',
    minPlayers: min,
    keys: [`k${id}`],
    settings: [],
    start(api) {
      api.put(`k${id}`, { on: 1 });
      const here = new Set(api.players().map((p) => p.slot));
      for (const [slot, n] of Object.entries(scores)) if (here.has(Number(slot))) api.addPoints(Number(slot), n);
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

function party(players, watchers, games, posts) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(5);
  const engines = [];
  for (let i = 1; i <= players + watchers; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: (b) => posts.push(b) });
    if (i <= players) e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

function hostOf(r) {
  return r.engines.find((e) => e.snapshot().isHost && r.hub.clients.has(e.snapshot().me));
}

test('a one-player tournament runs to the end, crowns the player and posts nothing', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 5 }), stub('wyr', { 0: 5 }), stub('draw', { 0: 5 }), stub('odd', { 0: 5 }, 3)];
  const r = party(1, 0, games, posts);
  await r.clock.advance(500);
  const [host] = r.engines;
  host.lobby.tournament(true);
  await r.clock.advance(200);
  assert.equal(host.lobby.start().ok, true);
  for (let i = 0; i < 3; i += 1) {
    await r.clock.advance(200);
    assert.notEqual(host.snapshot().room.game, 'odd', 'a game that needs three players is never picked for one');
    host.lobby.end();
    await r.clock.advance(200);
    if (i < 2) assert.equal(host.lobby.next().ok, true);
  }
  const snap = host.snapshot();
  assert.equal(snap.tour.live.done, true);
  assert.equal(snap.tour.live.champ, 0);
  assert.equal(posts.length, 0, 'a one-player game never earns anything');
  assert.equal(snap.room.last.champ, undefined);
});

test('two players: the host leaves mid-tournament and the new host finishes it with the same standings', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 10, 1: 30 }), stub('wyr', { 0: 10, 1: 30 }), stub('draw', { 1: 30, 2: 10 })];
  const r = party(3, 0, games, posts);
  await r.clock.advance(500);
  const [first, second, third] = r.engines;
  first.lobby.tournament({ g: ['trivia', 'wyr', 'draw'] });
  await r.clock.advance(200);
  first.lobby.start();
  await r.clock.advance(200);
  first.lobby.end();
  await r.clock.advance(300);
  assert.deepEqual(second.snapshot().tour.live.pts, { 0: 7, 1: 10, 2: 5 });
  first.destroy();
  r.hub.leave(ID(1));
  await r.clock.advance(2000);
  assert.equal(second.snapshot().isHost, true);
  assert.equal(second.lobby.next().ok, true);
  await r.clock.advance(300);
  assert.equal(third.snapshot().room.game, 'wyr');
  second.lobby.end();
  await r.clock.advance(300);
  second.lobby.next();
  await r.clock.advance(300);
  second.lobby.end();
  await r.clock.advance(300);
  const snap = third.snapshot();
  assert.equal(snap.tour.live.done, true);
  assert.equal(snap.tour.live.champ, 1);
  assert.deepEqual(posts[posts.length - 1].extra.tournament, { winner: ID(2) });
});

test('a tournament swaps in another game when the next one needs more players than are left', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 1, 1: 2, 2: 3 }), stub('odd', { 0: 1 }, 3), stub('wyr', { 0: 1, 1: 2 }), stub('chain', { 0: 1, 1: 2 })];
  const r = party(3, 0, games, posts);
  await r.clock.advance(500);
  const [host, guest, third] = r.engines;
  host.lobby.tournament({ g: ['trivia', 'odd', 'wyr'] });
  await r.clock.advance(200);
  host.lobby.start();
  await r.clock.advance(200);
  host.lobby.end();
  await r.clock.advance(200);
  third.leave();
  await r.clock.advance(400);
  assert.equal(host.lobby.next().ok, true);
  await r.clock.advance(200);
  const live = guest.snapshot().tour.live;
  assert.equal(guest.snapshot().room.game, 'chain');
  assert.deepEqual(live.g, ['trivia', 'chain', 'wyr']);
  assert.equal(live.i, 1);
});

test('eight players and a watcher: removed players earn nothing, cannot win and cannot predict', async () => {
  const posts = [];
  const scores = { 0: 10, 1: 900, 2: 30, 3: 40, 4: 50, 5: 60, 6: 70, 7: 80 };
  const games = [stub('trivia', scores)];
  const r = party(8, 1, games, posts);
  await r.clock.advance(500);
  const host = r.engines[0];
  const removed = r.engines[1];
  const watcher = r.engines[8];
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(host.lobby.remove(1), true);
  await r.clock.advance(300);
  assert.equal(removed.snapshot().meJoined, false);
  assert.equal(removed.predict(7), false, 'a removed player cannot turn into a predictor');
  await r.clock.advance(300);
  assert.equal(Object.keys(host.snapshot().state[PRED].p).length, 0);
  assert.equal(watcher.predict(7), true);
  await r.clock.advance(300);
  host.lobby.end();
  await r.clock.advance(300);
  const snap = watcher.snapshot();
  assert.deepEqual(snap.room.last.winners, [7], 'the removed top scorer does not win');
  assert.equal(posts.length, 1);
  const body = resultsBody(posts[0]);
  assert.equal(body.players.length, 7);
  assert.equal(body.players.some((p) => p.id === ID(2)), false);
  assert.deepEqual(body.predictions.map((p) => [p.id, p.pick, p.right]), [[ID(9), ID(8), true]]);
});

test('predictions stay capped with a full call of watchers', async () => {
  const posts = [];
  const r = party(2, PREDICT_MAX + 2, [stub('trivia', { 0: 1, 1: 5 })], posts);
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  for (const e of r.engines.slice(2)) {
    e.predict(1);
    await r.clock.advance(50);
  }
  await r.clock.advance(300);
  assert.equal(Object.keys(r.engines[0].snapshot().state[PRED].p).length, PREDICT_MAX);
  r.engines[0].lobby.end();
  await r.clock.advance(300);
  assert.equal(resultsBody(posts[0]).predictions.length, PREDICT_MAX);
});

test('the new games’ word lists, story openers and tune list are clean and only public domain tunes are left', () => {
  for (const w of WORDS) assert.equal(isBlockedGameWord(w.w), false, w.w);
  for (const s of STARTERS) assert.equal(hidesWords(s.text), false, s.text);
  assert.equal(TUNES.some((t) => /scarborough/i.test(t.title)), false, 'the well known Scarborough Fair tune comes from a 20th century collection');
  for (const k of KINDS) assert.ok(TUNES.filter((t) => t.kind === k.id).length >= 5, k.id);
  const names = TUNES.map((t) => t.title.toLowerCase());
  for (const banned of ['tetris', 'star wars', 'harry potter', 'pokemon', 'mario']) assert.equal(names.some((n) => n.includes(banned)), false);
});
