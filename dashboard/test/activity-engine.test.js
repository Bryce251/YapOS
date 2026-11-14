import test from 'node:test';
import assert from 'node:assert/strict';
import { room, Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine, PLAYER_CAP, PLAYERS_BYTES, settingsFor, storedName, topSlots, SOFT_OPS, FLUSH_MS } from '../web/activity/js/engine.js';
import { OpBudget, checkSet, jsonBytes, MAX_VALUE_BYTES, MAX_KEYS, MAX_STATE_BYTES } from '../web/activity/js/limits.js';
import { GAMES } from '../web/activity/js/games/index.js';

const counter = {
  id: 'counter',
  name: 'Counter',
  emoji: '🔢',
  blurb: 'Test game',
  minPlayers: 1,
  keys: ['counter'],
  prefixes: ['counter.'],
  open: ['counter.'],
  settings: [
    { id: 'goal', label: 'Goal', type: 'choice', options: [3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
    { id: 'step', label: 'Step', type: 'choice', options: [5, 10].map((v) => ({ value: v, label: String(v) })), default: 5 },
  ],
  start(api) {
    api.memory.started = true;
    api.put('counter', { n: 0, ticks: 0 });
    api.setDeadline(api.now() + api.settings.step * 1000);
  },
  intent(api, slot, a) {
    if (a.type !== 'bump') return;
    const st = api.get('counter');
    st.n += 1;
    api.put('counter', st);
    api.addPoints(slot, 10);
    if (st.n >= api.settings.goal) api.finish();
  },
  deadline(api) {
    const st = api.get('counter');
    st.ticks += 1;
    api.put('counter', st);
    if (st.ticks >= 3) return api.finish();
    api.setDeadline(api.now() + api.settings.step * 1000);
  },
  resume(api) {
    api.memory.resumed = (api.memory.resumed || 0) + 1;
  },
};

const games = [counter, ...GAMES];

test('the host sets up the room and everyone sees the same players', async () => {
  const r = room(3, { games });
  await r.clock.advance(1000);
  const snaps = r.engines.map((e) => e.snapshot());
  assert.equal(snaps[0].isHost, true);
  assert.equal(snaps[1].isHost, false);
  for (const s of snaps) {
    assert.equal(s.room.phase, 'lobby');
    assert.equal(s.room.pick, 'counter');
    assert.deepEqual(s.players.map((p) => p.slot), [0, 1, 2]);
    assert.equal(s.players.find((p) => p.isHost).name, 'Player 1');
    assert.equal(s.hostName, 'Player 1');
  }
  assert.equal(snaps[2].players.find((p) => p.isMe).name, 'Player 3');
  assert.equal(r.hub.violations.length, 0);
});

test('only the host can change the lobby and start a game', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  assert.equal(guest.lobby.pick('trivia'), false);
  assert.equal(guest.lobby.start().ok, false);
  assert.equal(host.lobby.setting('goal', 99), false);
  assert.equal(host.lobby.setting('goal', 5), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(500);
  const s = guest.snapshot();
  assert.equal(s.room.phase, 'game');
  assert.equal(s.room.game, 'counter');
  assert.equal(s.settings.goal, 5);
  assert.deepEqual(s.state.counter, { n: 0, ticks: 0 });
  assert.equal(host.lobby.pick('trivia'), false);
});

test('ready dots travel from guests to everyone', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  r.engines[1].ready(true);
  await r.clock.advance(500);
  for (const e of r.engines) assert.equal(e.snapshot().players.find((p) => p.name === 'Player 2').ready, true);
});

test('guest intents reach the host, score points and finish the game', async () => {
  const r = room(3, { games });
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(500);
  r.engines[1].act({ type: 'bump' });
  r.engines[2].act({ type: 'bump' });
  await r.clock.advance(500);
  r.engines[1].act({ type: 'bump' });
  await r.clock.advance(500);
  const s = r.engines[2].snapshot();
  assert.equal(s.room.phase, 'results');
  assert.deepEqual(s.scores.g, { 1: 20, 2: 10 });
  assert.deepEqual(s.scores.t, { 1: 20, 2: 10 });
  assert.deepEqual(s.room.last.winners, [1]);
  assert.equal(s.players.find((p) => p.slot === 1).wins, 1);
});

test('scores carry across games and New game resets them', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  for (let round = 0; round < 2; round += 1) {
    host.lobby.start();
    await r.clock.advance(300);
    for (let i = 0; i < 3; i += 1) {
      guest.act({ type: 'bump' });
      await r.clock.advance(300);
    }
    host.lobby.toLobby();
    await r.clock.advance(300);
  }
  assert.equal(guest.snapshot().scores.t[1], 60);
  assert.equal(guest.snapshot().scores.w[1], 2);
  host.lobby.reset();
  await r.clock.advance(300);
  assert.deepEqual(guest.snapshot().scores, { g: {}, t: {}, w: {} });
});

test('a player whose clock is an hour off still sees the right time left', async () => {
  const clock = new Clock();
  const hub = new Hub(clock, {});
  const random = seeded(11);
  const host = createEngine({ transport: hub.join(person(1)), games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random });
  host.join();
  const behind = () => clock.now() - 3_600_000;
  const late = createEngine({ transport: hub.join(person(2)), games, now: behind, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random });
  late.join();
  await clock.advance(500);
  host.lobby.start();
  await clock.advance(200);
  const deadline = late.snapshot().room.deadline;
  const left = deadline - late.now();
  assert.ok(left > 4000 && left <= 5000, `about 5 s left, saw ${left} ms`);
  assert.ok(Math.abs(late.now() - host.now()) < 1000);
  assert.equal(host.now(), clock.now());
});

test('deadlines are absolute times in state and the host fires them on time', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  const t0 = r.clock.now();
  r.engines[0].lobby.start();
  await r.clock.advance(200);
  const deadline = r.engines[1].snapshot().room.deadline;
  assert.equal(deadline, t0 + 5000);
  assert.equal(r.engines[0].snapshot().room.deadline, deadline);
  await r.clock.advance(4600);
  assert.equal(r.engines[1].snapshot().state.counter.ticks, 0);
  await r.clock.advance(400);
  assert.equal(r.engines[1].snapshot().state.counter.ticks, 1);
  assert.equal(r.engines[1].snapshot().room.deadline, t0 + 10000);
  await r.clock.advance(11000);
  assert.equal(r.engines[1].snapshot().room.phase, 'results');
  assert.equal(r.engines[1].snapshot().room.deadline, null);
});

test('a new host takes over from shared state and keeps the timers', async () => {
  const r = room(3, { games });
  await r.clock.advance(500);
  const t0 = r.clock.now();
  r.engines[0].lobby.start();
  await r.clock.advance(500);
  r.engines[1].act({ type: 'bump' });
  await r.clock.advance(500);
  r.hub.leave(r.engines[0].snapshot().me);
  r.engines[0].destroy();
  await r.clock.advance(200);
  const next = r.engines[1];
  assert.equal(next.isHost(), true);
  const s = next.snapshot();
  assert.equal(s.room.phase, 'game');
  assert.equal(s.state.counter.n, 1);
  assert.equal(s.hostName, 'Player 2');
  await r.clock.advance(t0 + 5300 - r.clock.now());
  assert.equal(r.engines[2].snapshot().state.counter.ticks, 1);
  r.engines[2].act({ type: 'bump' });
  r.engines[2].act({ type: 'bump' });
  await r.clock.advance(600);
  const end = r.engines[2].snapshot();
  assert.equal(end.room.phase, 'results');
  assert.deepEqual(end.scores.g, { 1: 10, 2: 20 });
});

test('a host that left during a deadline gap still gets the round moving', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  r.hub.leave(r.engines[0].snapshot().me);
  r.engines[0].destroy();
  await r.clock.advance(20000);
  assert.equal(r.engines[1].snapshot().room.phase, 'results');
});

test('nobody goes over the op budget, even when spamming', async () => {
  const r = room(3, { games });
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(200);
  r.engines[0].lobby.setting('goal', 5);
  const start = r.clock.now();
  for (let i = 0; i < 400; i += 1) {
    r.engines[1].ready(i % 2 === 0);
    r.engines[2].ready(i % 2 === 1);
    r.engines[0].ready(i % 2 === 0);
    await r.clock.advance(25);
  }
  await r.clock.advance(30000);
  assert.deepEqual(r.hub.violations, []);
  for (const p of r.hub.people) {
    for (let from = start; from < r.clock.now(); from += 500) {
      assert.ok(r.hub.opsBy(p.id, from, from + 10000) <= SOFT_OPS, `${p.display_name} stays within the soft budget`);
    }
  }
  const last = r.engines[1].snapshot().players;
  assert.equal(last.find((p) => p.slot === 1).ready, false);
  assert.equal(last.find((p) => p.slot === 2).ready, true);
  assert.equal(r.engines[1].pendingCount, 0);
});

test('writes are batched no faster than the flush interval', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  const host = r.engines[0];
  const before = r.hub.ops.length;
  host.lobby.setting('goal', 5);
  host.lobby.setting('step', 10);
  host.lobby.setting('goal', 3);
  host.ready(true);
  await r.clock.advance(FLUSH_MS - 10);
  assert.equal(r.hub.ops.length, before);
  await r.clock.advance(20);
  assert.equal(r.hub.ops.length - before, 2);
});

test('state values stay inside the platform limits', async () => {
  assert.equal(checkSet({}, 'bad key', 1), 'bad_key');
  assert.equal(checkSet({}, 'k', 'x'.repeat(MAX_VALUE_BYTES)), 'too_big');
  const full = {};
  for (let i = 0; i < MAX_KEYS; i += 1) full[`k${i}`] = 1;
  assert.equal(checkSet(full, 'another', 1), 'too_many_keys');
  assert.equal(checkSet(full, 'k1', 2), null);
  const big = {};
  for (let i = 0; i < 17; i += 1) big[`b${i}`] = 'y'.repeat(3900);
  assert.equal(checkSet(big, 'c', 'z'.repeat(3900)), 'state_full');
  assert.ok(MAX_STATE_BYTES === 65536);
  const bigGame = { ...counter, id: 'big', start: (api) => api.put('counter', { text: 'x'.repeat(5000) }) };
  const r2 = room(1, { games: [bigGame] });
  await r2.clock.advance(300);
  const errs = [];
  r2.engines[0].on('error', (e) => errs.push(e.message));
  assert.equal(r2.engines[0].lobby.start().ok, false);
  assert.match(errs[0], /too_big/);
  assert.deepEqual(r2.hub.violations, []);
});

test('the players key stays under 4 KB with a crowded call and long emoji names', async () => {
  const clock = new Clock();
  const hub = new Hub(clock);
  const engines = [];
  for (let i = 1; i <= 60; i += 1) {
    const t = hub.join({ id: `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, display_name: '🎉'.repeat(40) + i });
    engines.push(createEngine({ transport: t, games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }));
    await clock.advance(50);
  }
  await clock.advance(20000);
  const players = hub.state.players;
  assert.ok(jsonBytes(players) <= PLAYERS_BYTES, `${jsonBytes(players)} bytes`);
  assert.ok(Object.keys(players.p).length <= PLAYER_CAP);
  assert.deepEqual(hub.violations, []);
  assert.ok(jsonBytes(storedName('🎉'.repeat(40))) <= 50);
  assert.ok(Object.keys(players.p).includes(hub.people[0].id));
});

test('people who leave are pruned first when the list is full', async () => {
  const clock = new Clock();
  const hub = new Hub(clock);
  const mk = (i) => {
    const t = hub.join({ id: `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, display_name: `P${i}` });
    return createEngine({ transport: t, games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  };
  const list = [];
  for (let i = 1; i <= PLAYER_CAP; i += 1) list.push(mk(i));
  await clock.advance(3000);
  const gone = hub.people[5].id;
  hub.leave(gone);
  list[5].destroy();
  await clock.advance(500);
  mk(999);
  await clock.advance(3000);
  const ids = Object.keys(hub.state.players.p);
  assert.equal(ids.length, PLAYER_CAP);
  assert.equal(ids.includes(gone), false);
});

test('a late joiner renders the whole game from state', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  r.engines[1].act({ type: 'bump' });
  await r.clock.advance(300);
  const late = r.add(3);
  await r.clock.advance(300);
  const s = late.snapshot();
  assert.equal(s.room.phase, 'game');
  assert.equal(s.game.id, 'counter');
  assert.deepEqual(s.state.counter, { n: 1, ticks: 0 });
  assert.equal(s.scores.g[1], 10);
  assert.equal(typeof s.room.deadline, 'number');
  assert.equal(s.players.length, 3);
  assert.equal(s.meSlot, 2);
  late.act({ type: 'bump' });
  await r.clock.advance(300);
  assert.equal(r.engines[0].snapshot().scores.g[2], 10);
});

test('guests cannot write host keys directly and strangers are ignored', async () => {
  const r = room(2, { games });
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  assert.equal(r.engines[1].direct('room', { phase: 'lobby' }), false);
  assert.equal(r.engines[1].direct('counter', { n: 50 }), false);
  assert.equal(r.engines[1].direct('counter.1', { pts: [1, 2] }), true);
  r.hub.clients.get(r.hub.people[0].id).emit('message', { data: { t: 'g', g: 'counter', a: { type: 'bump' } }, by: 'stranger' });
  await r.clock.advance(300);
  assert.equal(r.engines[0].snapshot().state.counter.n, 0);
  assert.deepEqual(r.engines[0].snapshot().state['counter.1'], { pts: [1, 2] });
});

test('helpers rank winners and clean settings', () => {
  assert.deepEqual(topSlots({ 0: 10, 1: 30, 2: 30 }), [1, 2]);
  assert.deepEqual(topSlots({ 0: 0 }), []);
  assert.deepEqual(settingsFor(counter, { opts: { counter: { goal: 77, step: 10 } } }), { goal: 3, step: 10 });
  const b = new OpBudget(3, 1000);
  b.spend(0, 3);
  assert.equal(b.available(10), 0);
  assert.equal(b.nextFree(10), 1000);
  assert.equal(b.available(1000), 3);
  assert.equal(seeded(1)() === seeded(1)(), true);
  assert.equal(person(4).display_name, 'Player 4');
});
