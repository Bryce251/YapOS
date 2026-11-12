import test from 'node:test';
import assert from 'node:assert/strict';
import { room, Clock, Hub, person } from './activity-kit.test.js';
import { createEngine, RESEND_MS, LATE_MS } from '../web/activity/js/engine.js';
import { connect, PARENT_ORIGINS, HELLO_MS, HELLO_TRIES } from '../web/activity/js/bridge.js';
import { OpBudget, OPS_MAX, jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';
import { GAMES } from '../web/activity/js/games/index.js';
import draw from '../web/activity/js/games/draw.js';
import { INK_BYTES, MAX_CHUNKS, CHUNK_BYTES } from '../web/activity/js/games/ink.js';

const tally = {
  id: 'tally',
  name: 'Tally',
  emoji: '🔢',
  blurb: 'Test game',
  minPlayers: 1,
  keys: ['tally'],
  prefixes: ['pad.'],
  open: ['pad.'],
  settings: [],
  writer(get, key, slot, value) {
    const st = get('tally');
    return Boolean(st) && slot === st.owner && (value === null || value.k === st.k);
  },
  start(api) {
    api.memory.fresh = true;
    api.put('tally', { n: 0, owner: 1, k: 7 });
    api.setDeadline(api.now() + 5000);
  },
  intent(api, slot, a) {
    if (a.type !== 'bump') return;
    const st = api.get('tally');
    st.n += 1;
    api.put('tally', st);
  },
  deadline(api) {
    const st = api.get('tally');
    st.ticks = (st.ticks || 0) + 1;
    api.put('tally', st);
    api.setDeadline(api.now() + 5000);
  },
  resume(api) {
    api.memory.resumed = (api.memory.resumed || 0) + 1;
  },
  model() {
    return null;
  },
};

const games = [tally, ...GAMES];

async function started(n = 3) {
  const r = room(n, { games });
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(500);
  return r;
}

test('a guest cannot overwrite the room, scores or game state, and the host puts them back', async () => {
  const r = await started(3);
  const guest = r.hub.people[1].id;
  const room0 = r.engines[0].snapshot().room;
  r.hub.set(guest, 'room', { ...room0, phase: 'results' });
  r.hub.set(guest, 'scores', { g: { 1: 9999 }, t: { 1: 9999 }, w: {} });
  r.hub.set(guest, 'tally', { n: 500, owner: 1, k: 7 });
  await r.clock.advance(50);
  for (const e of r.engines) {
    const s = e.snapshot();
    assert.equal(s.room.phase, 'game');
    assert.equal(s.scores.g[1] || 0, 0);
    assert.equal(s.state.tally.n, 0);
  }
  await r.clock.advance(1000);
  assert.equal(r.hub.state.room.phase, 'game');
  assert.equal(r.hub.state.tally.n, 0);
  assert.equal(r.hub.state.scores.g[1] || 0, 0);
  const late = r.add(4);
  await r.clock.advance(500);
  assert.equal(late.snapshot().room.phase, 'game');
  assert.equal(late.snapshot().state.tally.n, 0);
});

test('open keys only take writes from the player the game allows', async () => {
  const r = await started(3);
  const [host, owner, other] = r.engines;
  assert.equal(owner.snapshot().meSlot, 1);
  assert.equal(owner.direct('pad.0', { k: 7, s: 'hi' }), true);
  assert.equal(other.direct('pad.0', { k: 7, s: 'nope' }), false);
  assert.equal(owner.direct('pad.1', { k: 6, s: 'old' }), false);
  await r.clock.advance(500);
  assert.deepEqual(host.snapshot().state['pad.0'], { k: 7, s: 'hi' });
  r.hub.set(r.hub.people[2].id, 'pad.0', { k: 7, s: 'graffiti' });
  r.hub.set(r.hub.people[1].id, 'pad.3', { k: 3, s: 'stale' });
  await r.clock.advance(50);
  for (const e of r.engines) {
    assert.deepEqual(e.snapshot().state['pad.0'], { k: 7, s: 'hi' });
    assert.equal(e.snapshot().state['pad.3'], undefined);
  }
  await r.clock.advance(1000);
  assert.deepEqual(r.hub.state['pad.0'], { k: 7, s: 'hi' });
  assert.equal('pad.3' in r.hub.state, false);
});

test('Draw & Guess only lets the drawer write ink for the current turn', () => {
  const st = { drawer: 2, nonce: 99 };
  const get = (k) => (k === 'draw' ? st : null);
  assert.equal(draw.writer(get, 'ink.0', 2, { k: 99, i: 0, s: [] }), true);
  assert.equal(draw.writer(get, 'ink.0', 2, null), true);
  assert.equal(draw.writer(get, 'ink.0', 1, { k: 99, i: 0, s: [] }), false);
  assert.equal(draw.writer(get, 'ink.0', 2, { k: 98, i: 0, s: [] }), false);
  assert.equal(draw.writer(get, 'draw', 2, null), false);
  assert.equal(draw.writer(() => null, 'ink.0', 2, null), false);
  assert.ok(INK_BYTES + 6 * 4096 <= 64 * 1024, 'core keys plus one turn of ink fit in the call');
  assert.ok(MAX_CHUNKS * CHUNK_BYTES >= INK_BYTES);
});

test('a write the parent drops is sent again', async () => {
  const r = await started(2);
  const realSet = r.hub.set.bind(r.hub);
  let swallowed = 0;
  r.hub.set = (id, key, val) => {
    if (key === 'tally' && !swallowed) {
      swallowed += 1;
      return true;
    }
    return realSet(id, key, val);
  };
  r.engines[1].act({ type: 'bump' });
  await r.clock.advance(500);
  assert.equal(swallowed, 1);
  assert.equal(r.engines[0].snapshot().state.tally.n, 1);
  assert.equal(r.engines[1].snapshot().state.tally.n, 0);
  await r.clock.advance(RESEND_MS + 500);
  assert.equal(r.hub.state.tally.n, 1);
  assert.equal(r.engines[1].snapshot().state.tally.n, 1);
});

test('drop forgets queued writes under a prefix', async () => {
  const r = await started(2);
  const owner = r.engines[1];
  owner.direct('pad.0', { k: 7, s: 'a' });
  owner.direct('pad.1', null);
  assert.equal(owner.drop('pad.', (v) => v !== null), 1);
  await r.clock.advance(500);
  assert.equal('pad.0' in r.hub.state, false);
});

test('a second init keeps the host game going instead of restarting it', async () => {
  const r = await started(2);
  const host = r.engines[0];
  const client = r.hub.clients.get(r.hub.people[0].id);
  host.act({ type: 'bump' });
  await r.clock.advance(300);
  const before = host.snapshot().state.tally;
  client.emit('init', {});
  await r.clock.advance(300);
  assert.equal(host.isHost(), true);
  assert.deepEqual(host.snapshot().state.tally, before);
  assert.equal(host.snapshot().room.phase, 'game');
});

test('guests nudge a host whose timer is late, but never early', async () => {
  const clock = new Clock();
  const hub = new Hub(clock);
  const sleepy = (fn, ms) => clock.setTimeout(fn, ms >= 4000 ? ms * 100 : ms);
  const mk = (n, st) => createEngine({ transport: hub.join(person(n)), games, now: clock.now, setTimeout: st, clearTimeout: clock.clearTimeout });
  const host = mk(1, sleepy);
  const guest = mk(2, clock.setTimeout);
  await clock.advance(500);
  host.lobby.start();
  await clock.advance(300);
  const d = host.snapshot().room.deadline;
  await clock.advance(d - clock.now() - 100);
  assert.equal(host.snapshot().state.tally.ticks, undefined);
  await clock.advance(100 + LATE_MS - 200);
  assert.equal(host.snapshot().state.tally.ticks, undefined, 'guests wait a moment before nudging');
  await clock.advance(700);
  assert.equal(host.snapshot().state.tally.ticks, 1);
  assert.equal(guest.snapshot().state.tally.ticks, 1);
  assert.ok(hub.ops.some((o) => o.id === hub.people[1].id && o.what === 'send'));
});

test('scores forget people who were pruned from the player list', async () => {
  const clock = new Clock();
  const hub = new Hub(clock);
  const host = createEngine({ transport: hub.join(person(1)), games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await clock.advance(500);
  hub.set(hub.people[0].id, 'scores', { g: {}, t: { 0: 5, 77: 40 }, w: { 77: 1 } });
  await clock.advance(100);
  createEngine({ transport: hub.join(person(2)), games, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await clock.advance(1000);
  const s = host.snapshot().scores;
  assert.equal(s.t[77], undefined);
  assert.equal(s.w[77], undefined);
  assert.equal(s.t[0], 5);
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES);
});

function fakeWindow() {
  const posted = [];
  const listeners = [];
  const timers = [];
  const parent = {
    postMessage(m, origin) {
      posted.push({ m: JSON.parse(JSON.stringify(m)), origin });
    },
  };
  const win = {
    parent,
    location: new URL('https://yapos.dev/activity/'),
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
  };
  const deliver = (data, origin = 'https://www.yapin.gg') => {
    for (const fn of listeners) fn({ data, origin, source: parent });
  };
  const tick = () => {
    const list = timers.splice(0);
    for (const x of list) x.fn();
    return list.length;
  };
  return { win, posted, deliver, tick };
}

test('the bridge says hello again until the parent answers, then stops', () => {
  const { win, posted, deliver, tick } = fakeWindow();
  const api = connect({ win });
  assert.equal(posted.length, PARENT_ORIGINS.length);
  assert.equal(tick(), 1);
  assert.equal(posted.length, PARENT_ORIGINS.length * 2);
  deliver({ yapper: 1, type: 'init', me: 'u1', host: 'u1', participants: [], state: {} });
  assert.equal(api.ready, true);
  tick();
  assert.equal(tick(), 0);
  assert.equal(posted.length, PARENT_ORIGINS.length * 2);
  assert.ok(HELLO_MS >= 500);
});

test('the bridge gives up saying hello after a while', () => {
  const { win, posted, tick } = fakeWindow();
  connect({ win });
  for (let i = 0; i < HELLO_TRIES + 5; i += 1) tick();
  assert.equal(posted.length, PARENT_ORIGINS.length * (HELLO_TRIES + 1));
});

test('the bridge does not spend its budget before the parent answers', () => {
  const { win } = fakeWindow();
  const budget = new OpBudget(OPS_MAX, 10000);
  const api = connect({ win, budget, now: () => 0 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(api.set('k', i), false);
    assert.equal(api.send({ i }), false);
  }
  assert.equal(budget.available(0), OPS_MAX);
});

test('an open write that is no longer allowed is not sent again', async () => {
  const r = await started(2);
  const [host, owner] = r.engines;
  const realSet = r.hub.set.bind(r.hub);
  const tries = [];
  r.hub.set = (id, key, val) => {
    if (key.startsWith('pad.')) {
      tries.push(key);
      return true;
    }
    return realSet(id, key, val);
  };
  assert.equal(owner.direct('pad.0', { k: 7, s: 'late' }), true);
  await r.clock.advance(400);
  assert.equal(tries.length, 1);
  r.hub.set = (id, key, val) => {
    if (key.startsWith('pad.')) tries.push(key);
    return realSet(id, key, val);
  };
  realSet(r.hub.people[0].id, 'tally', { n: 0, owner: 1, k: 8 });
  await r.clock.advance(RESEND_MS * 3);
  assert.equal(tries.length, 1);
  assert.equal('pad.0' in r.hub.state, false);
  assert.equal(owner.snapshot().state['pad.0'], undefined);
  assert.equal(host.snapshot().state['pad.0'], undefined);
});
