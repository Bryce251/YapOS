import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine, placementPoints, championOf, cleanTour, pickTourGames, PLACE_POINTS, TOUR_GAMES } from '../web/activity/js/engine.js';
import { resultsBody, partyShards, PARTY_SHARDS_PLAY, PARTY_SHARDS_WIN, PARTY_SHARDS_TOURNAMENT } from '../web/activity/js/admin.js';
import { shardsEarned, shardsText } from '../web/activity/js/ui/results.js';
import { tourModel, championTitle, togglePick, tourSetupModel } from '../web/activity/js/ui/tournament.js';
import { headerModel } from '../web/activity/js/ui/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ID = (n) => person(n).id;

function stub(id, scores) {
  return {
    id,
    name: `Game ${id}`,
    emoji: '🎲',
    category: 'quick',
    blurb: 'Stub',
    minPlayers: 1,
    keys: [`k${id}`],
    settings: [],
    start(api) {
      api.put(`k${id}`, { on: 1 });
      for (const [slot, n] of Object.entries(scores)) api.addPoints(Number(slot), n);
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

function party(count, games, posts) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(3);
  const engines = [];
  for (let i = 1; i <= count; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: (b) => posts.push(b) });
    e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

test('placement points follow 10/7/5/3/2/1 with shared places for ties and winners first', () => {
  assert.deepEqual(PLACE_POINTS, [10, 7, 5, 3, 2, 1]);
  const pts = placementPoints([
    { slot: 0, score: 50, won: false },
    { slot: 1, score: 80, won: true },
    { slot: 2, score: 50, won: false },
    { slot: 3, score: 10, won: false },
    { slot: 4, score: 5 },
    { slot: 5, score: 4 },
    { slot: 6, score: 3 },
    { slot: 7, score: 2 },
  ]);
  assert.deepEqual(pts, { 1: 10, 0: 7, 2: 7, 3: 3, 4: 2, 5: 1, 6: 0, 7: 0 });
  assert.deepEqual(placementPoints([{ slot: 0, score: 0, won: true }, { slot: 1, score: 99, won: false }]), { 0: 10, 1: 7 });
  assert.deepEqual(placementPoints(null), {});
});

test('the champion has the most points, then the most wins, then the best last game', () => {
  assert.equal(championOf({ 0: 20, 1: 24 }), 1);
  assert.equal(championOf({ 0: 24, 1: 24 }, { 0: 1, 1: 2 }), 1);
  assert.equal(championOf({ 0: 24, 1: 24 }, { 0: 1, 1: 1 }, { 0: 10, 1: 7 }), 0);
  assert.equal(championOf({ 0: 0 }), null);
  assert.equal(championOf({}), null);
});

test('tournament settings are cleaned and random games fill the gaps', () => {
  const games = [stub('trivia', {}), stub('wyr', {}), stub('draw', {}), { ...stub('telephone', {}), minPlayers: 3 }];
  assert.equal(cleanTour(null, games), null);
  assert.deepEqual(cleanTour({ g: ['wyr', 'nope', 'wyr', 'draw', 'trivia', 'telephone'] }, games), { g: ['wyr', 'draw', 'trivia'] });
  assert.deepEqual(cleanTour({}, games), { g: [] });
  const picked = pickTourGames(games, ['draw'], 2, seeded(1));
  assert.equal(picked.length, TOUR_GAMES);
  assert.equal(picked[0], 'draw');
  assert.equal(new Set(picked).size, TOUR_GAMES);
  assert.equal(picked.includes('telephone'), false, 'games that need more players are skipped');
  assert.equal(pickTourGames(games.slice(0, 2), [], 2, seeded(1)), null);
  assert.deepEqual(togglePick(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(togglePick(['a', 'b', 'c'], 'd'), ['a', 'b', 'c']);
  assert.deepEqual(togglePick([{ id: 'a' }], 'b'), ['a', 'b']);
});

test('a full tournament runs three games, keeps standings and crowns a champion who earns the bonus', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 30, 1: 10, 2: 0 }), stub('wyr', { 0: 5, 1: 20, 2: 1 }), stub('draw', { 0: 30, 1: 40, 2: 50 })];
  const r = party(3, games, posts);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  assert.equal(host.lobby.tournament({ g: ['trivia', 'wyr', 'draw'] }), true);
  await r.clock.advance(300);
  assert.deepEqual(guest.snapshot().tour.setup, { g: ['trivia', 'wyr', 'draw'] });
  assert.equal(tourSetupModel(guest.snapshot(), games).on, true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  assert.equal(guest.snapshot().room.game, 'trivia');
  assert.match(headerModel(guest.snapshot()).status, /Game 1 of 3/);
  host.lobby.end();
  await r.clock.advance(300);
  let snap = guest.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.tour.live.pts, { 0: 10, 1: 7, 2: 5 });
  let m = tourModel(snap, games);
  assert.equal(m.next.id, 'wyr');
  assert.equal(m.rows[0].name, 'Player 1');
  assert.equal(posts[0].extra.tournament, undefined);
  assert.equal(guest.lobby.next().ok, false, 'only the host moves the tournament on');
  assert.equal(host.lobby.start().ok, true, 'Play again during a tournament starts the next game');
  await r.clock.advance(300);
  assert.equal(guest.snapshot().room.game, 'wyr');
  host.lobby.end();
  await r.clock.advance(300);
  assert.deepEqual(guest.snapshot().tour.live.pts, { 0: 17, 1: 17, 2: 10 });
  assert.equal(host.lobby.next().ok, true);
  await r.clock.advance(300);
  assert.equal(guest.snapshot().room.game, 'draw');
  host.lobby.end();
  await r.clock.advance(300);
  snap = guest.snapshot();
  assert.equal(snap.tour.live.done, true);
  assert.deepEqual(snap.tour.live.pts, { 0: 22, 1: 24, 2: 20 });
  assert.equal(snap.tour.live.champ, 1);
  assert.equal(snap.room.last.champ, 1);
  m = tourModel(snap, games);
  assert.equal(championTitle(m), "You're the champion!");
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2].extra.tournament, { winner: ID(2) });
  assert.deepEqual(resultsBody(posts[2]).extra.tournament, { winner: ID(2) });
  assert.equal(shardsEarned(snap.room.last, snap.players), PARTY_SHARDS_PLAY + PARTY_SHARDS_TOURNAMENT);
  assert.equal(shardsText(shardsEarned(snap.room.last, snap.players)), `+${PARTY_SHARDS_PLAY + PARTY_SHARDS_TOURNAMENT} 💎`);
  const hostSnap = host.snapshot();
  assert.equal(shardsEarned(hostSnap.room.last, hostSnap.players), PARTY_SHARDS_PLAY);
  assert.equal(partyShards(true, true), PARTY_SHARDS_PLAY + PARTY_SHARDS_WIN + PARTY_SHARDS_TOURNAMENT);
  assert.equal(host.lobby.start().ok, true, 'a finished tournament starts a new one');
  await r.clock.advance(300);
  assert.equal(guest.snapshot().tour.live.i, 0);
  assert.deepEqual(guest.snapshot().tour.live.pts, {});
  host.lobby.toLobby();
  await r.clock.advance(300);
  assert.equal(guest.snapshot().tour.live, null);
  assert.deepEqual(guest.snapshot().tour.setup, { g: ['trivia', 'wyr', 'draw'] });
});

test('random tournaments pick three games and turning it off goes back to single games', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 1 }), stub('wyr', { 0: 1 }), stub('draw', { 0: 1 }), stub('chain', { 0: 1 })];
  const r = party(2, games, posts);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  host.lobby.tournament(true);
  await r.clock.advance(300);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const live = guest.snapshot().tour.live;
  assert.equal(live.g.length, 3);
  assert.equal(new Set(live.g).size, 3);
  host.lobby.toLobby();
  host.lobby.tournament(null);
  await r.clock.advance(300);
  assert.equal(guest.snapshot().tour.setup, null);
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(guest.snapshot().tour.live, null);
});

test('a tournament champion who left before the last game gets no bonus', async () => {
  const posts = [];
  const games = [stub('trivia', { 0: 1, 1: 99 }), stub('wyr', { 0: 1, 1: 99 }), stub('draw', { 3: 50, 2: 10, 0: 1 })];
  const r = party(4, games, posts);
  await r.clock.advance(500);
  const [host, , third] = r.engines;
  host.lobby.tournament({ g: ['trivia', 'wyr', 'draw'] });
  await r.clock.advance(200);
  host.lobby.start();
  await r.clock.advance(200);
  host.lobby.end();
  await r.clock.advance(200);
  host.lobby.next();
  await r.clock.advance(200);
  host.lobby.end();
  await r.clock.advance(200);
  r.engines[1].leave();
  r.hub.leave(person(2).id);
  await r.clock.advance(400);
  host.lobby.next();
  await r.clock.advance(200);
  host.lobby.end();
  await r.clock.advance(400);
  const snap = third.snapshot();
  assert.deepEqual(snap.tour.live.pts, { 0: 19, 1: 20, 2: 17, 3: 20 });
  assert.equal(snap.tour.live.champ, 1);
  assert.equal(posts[2].extra.tournament, undefined);
  assert.equal(snap.room.last.champ, undefined);
});

test('the tournament code has no comments and its CSS loads before admin.css and juice.css', () => {
  const html = readFileSync(path.join(here, '..', 'web', 'activity', 'index.html'), 'utf8');
  const at = html.indexOf('/activity/css/tournament.css');
  assert.ok(at > 0);
  assert.ok(at < html.indexOf('/activity/css/admin.css'));
  assert.ok(at < html.indexOf('/activity/css/juice.css'));
  for (const f of ['js/ui/tournament.js', 'js/ui/predict.js', 'js/ui/replay.js', 'js/ui/hosttools.js', 'css/tournament.css']) {
    const src = readFileSync(path.join(here, '..', 'web', 'activity', f), 'utf8');
    assert.equal(/\/\*|(^|[^:'"`])\/\/(?!\/)/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")), false, f);
  }
});
