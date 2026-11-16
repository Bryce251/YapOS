import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine } from '../web/activity/js/engine.js';
import { REACTIONS, REACT_GAP_MS, REACT_MAX } from '../web/activity/js/fun.js';
const NO_ADMINS = { isAdmin: () => false, knows: () => true, ownerId: () => null, banned: () => false, refresh: null, onChange: null };

function duel(over = {}) {
  return {
    id: 'duel',
    name: 'Duel',
    emoji: '⚔️',
    blurb: 'Test game',
    minPlayers: 1,
    keys: ['duel'],
    settings: [],
    cards: ['swap', 'double', 'freeze', 'peek'],
    start(api) {
      api.put('duel', { on: 1 });
    },
    intent(api, slot, a) {
      if (a.type === 'score') api.put('duel', { ...api.get('duel'), got: api.addPoints(slot, a.n) });
      if (a.type === 'round') api.round(a.i, a.of || 3);
      if (a.type === 'thaw') api.thaw(a.slot);
      if (a.type === 'end') api.finish();
    },
    freeze(api, to) {
      api.put('duel', { ...api.get('duel'), iced: to });
      return true;
    },
    hint() {
      return 'It starts with B';
    },
    deadline() {},
    resume() {},
    ...over,
  };
}

function funRoom(count, games, opts = {}) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(5);
  const funRandom = seeded(opts.seed || 3);
  const posts = [];
  const reports = [];
  const engines = [];
  const add = (n, join = opts.join !== false) => {
    const e = createEngine({
      transport: hub.join(person(n)),
      games,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random,
      funRandom,
      admins: NO_ADMINS,
      postResults: (b) => {
        posts.push(b);
        return true;
      },
      reportText: (b) => {
        reports.push(b);
        return true;
      },
    });
    if (join) e.join();
    engines.push(e);
    return e;
  };
  for (let i = 1; i <= count; i += 1) add(i);
  return { clock, hub, engines, posts, reports, add };
}

async function started(game, count = 3, opts = {}) {
  const r = funRoom(count, [game], opts);
  await r.clock.advance(500);
  if (opts.before) opts.before(r);
  await r.clock.advance(200);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

test('a reaction floats for everyone, watchers included, through messages not state', async () => {
  const r = funRoom(3, [duel()]);
  await r.clock.advance(500);
  const watcher = r.add(4, false);
  await r.clock.advance(500);
  const got = r.engines.map(() => []);
  r.engines.forEach((e, i) => e.on('react', (x) => got[i].push(x)));
  const before = JSON.stringify(r.hub.state);
  assert.equal(watcher.snapshot().meJoined, false);
  assert.equal(watcher.react(0), true);
  await r.clock.advance(400);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(got[i].map((x) => [x.emoji, x.name, x.mine]), [[REACTIONS[0], 'Player 4', false]]);
  assert.deepEqual(got[3].map((x) => x.mine), [true], 'your own tap floats right away');
  assert.equal(JSON.stringify(r.hub.state), before, 'reactions never touch shared state');
  assert.ok(REACTIONS.length >= 6);
  for (const e of ['😂', '🔥', '💀', '👏']) assert.ok(REACTIONS.includes(e));
});

test('reactions are rate limited per person and bad ones are ignored', async () => {
  const r = funRoom(2, [duel()]);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  const got = [];
  host.on('react', (x) => got.push(x));
  assert.equal(guest.react(1), true);
  assert.equal(guest.react(1), false, 'too soon after the last one');
  assert.equal(guest.react(99), false);
  assert.equal(guest.react('x'), false);
  let sent = 1;
  for (let i = 0; i < 60; i += 1) {
    await r.clock.advance(REACT_GAP_MS);
    if (guest.react(i % REACTIONS.length)) sent += 1;
  }
  assert.ok(sent <= REACT_MAX * 3, `sent ${sent}`);
  assert.ok(sent >= REACT_MAX, `sent ${sent}`);
  await r.clock.advance(500);
  assert.equal(got.length, sent);
  guest.broadcast({ t: 're', e: 42 });
  guest.broadcast({ t: 're', e: -1 });
  await r.clock.advance(500);
  assert.equal(got.length, sent);
  assert.deepEqual(r.hub.violations, []);
  const at = r.clock.now() - 20000;
  for (let from = at; from < r.clock.now(); from += 1000) assert.ok(r.hub.opsBy(guest.snapshot().me, from, from + 10000) <= 60);
});

test('the host can turn reactions off for everyone', async () => {
  const r = funRoom(2, [duel()]);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  assert.equal(guest.snapshot().party.reactions, true);
  assert.equal(host.lobby.party('reactions', false), true);
  await r.clock.advance(400);
  assert.equal(guest.snapshot().party.reactions, false);
  assert.equal(guest.react(0), false);
  assert.equal(host.lobby.party('reactions', true), true);
  await r.clock.advance(400);
  assert.equal(guest.react(0), true);
  assert.equal(host.lobby.party('bogus', true), false);
});

test('the reaction bar sends taps and floats are capped', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createParty, dockModel, FLOAT_MAX } = await import('../web/activity/js/ui/party.js');
  const r = funRoom(2, [duel()]);
  await r.clock.advance(500);
  const guest = r.engines[1];
  assert.equal(dockModel(guest.snapshot()).reactions, true, 'reactions work in the lobby too');
  const taps = [];
  const handlers = {};
  const engine = {
    on: (ev, fn) => {
      handlers[ev] = fn;
      return () => {};
    },
    snapshot: guest.snapshot,
    react: (i) => taps.push(i) > 0,
    play: () => false,
  };
  const party = createParty({ engine, win: { innerWidth: 300, setTimeout: () => 1, clearTimeout() {} } });
  party.update(guest.snapshot());
  const find = (key) => {
    const walk = (n) => {
      if (n.dataset && n.dataset.key === key) return n;
      for (const c of n.childNodes || []) {
        const x = walk(c);
        if (x) return x;
      }
      return null;
    };
    return walk(party.el);
  };
  assert.equal(find('react-0'), null, 'narrow screens start with the bar folded');
  find('react-open').click();
  find('react-2').click();
  assert.deepEqual(taps, [2]);
  for (let i = 0; i < FLOAT_MAX + 10; i += 1) handlers.react({ emoji: '🔥', name: 'Juno', mine: false });
  assert.equal(party.floats, FLOAT_MAX);
  for (const el of party.el.childNodes) assert.equal(el.hasAttribute('style'), false);
  party.destroy();
});
