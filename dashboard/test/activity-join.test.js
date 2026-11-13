import test from 'node:test';
import assert from 'node:assert/strict';
import { room, Clock, Hub } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine, PLAYER_CAP, PLAYERS_BYTES, autoOf } from '../web/activity/js/engine.js';
import { jsonBytes } from '../web/activity/js/limits.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { board, standings } from '../web/activity/js/ui/board.js';
import { clock } from '../web/activity/js/ui/dom.js';
import { lobbyModel, needText } from '../web/activity/js/ui/lobby.js';

const joins = [];

const tap = {
  id: 'tap',
  name: 'Tap',
  emoji: '👆',
  blurb: 'Test game',
  minPlayers: 1,
  keys: ['tap'],
  settings: [],
  start(api) {
    api.put('tap', { n: 0, seats: api.players().map((p) => p.slot) });
  },
  intent(api, slot, a) {
    if (a.type !== 'tap') return;
    const st = api.get('tap');
    st.n += 1;
    api.put('tap', st);
    api.addPoints(slot, 10);
  },
  join(api, slot) {
    joins.push({ slot, players: api.players().map((p) => p.slot) });
    const st = api.get('tap');
    api.put('tap', { ...st, seats: st.seats.concat([slot]) });
  },
};

const race = {
  id: 'race',
  name: 'Race',
  emoji: '🏁',
  blurb: 'Starts on its own',
  minPlayers: 2,
  autoStart: { min: 2, ms: 90000 },
  keys: ['race'],
  settings: [],
  started: 0,
  start(api) {
    race.started += 1;
    api.put('race', { on: true, who: api.players().map((p) => p.slot) });
  },
  intent() {},
};

const boom = {
  id: 'boom',
  name: 'Boom',
  emoji: '💥',
  blurb: 'Throws on join',
  minPlayers: 1,
  keys: ['boom'],
  settings: [],
  start(api) {
    api.put('boom', { n: 0 });
  },
  intent(api, slot) {
    api.addPoints(slot, 5);
  },
  join() {
    throw new Error('join went wrong');
  },
};

const games = [tap, race, boom, ...GAMES];

async function lobby(n, opts = {}) {
  const r = room(n, { games, join: false, ...opts });
  await r.clock.advance(500);
  return r;
}

test('being in the call does not make you a player until you press Join', async () => {
  const r = await lobby(3);
  const [host, a, b] = r.engines;
  for (const e of r.engines) {
    const s = e.snapshot();
    assert.equal(s.playing, 0);
    assert.equal(s.meJoined, false);
    assert.deepEqual(s.players.map((p) => p.slot), [0, 1, 2]);
    assert.ok(s.players.every((p) => p.present && !p.joined));
  }
  assert.deepEqual(host.lobby.start(), { ok: false, reason: 'players', need: 1 });
  a.join();
  b.join();
  assert.equal(a.snapshot().joining, 'in');
  await r.clock.advance(600);
  for (const e of r.engines) assert.equal(e.snapshot().playing, 2);
  assert.equal(a.snapshot().meJoined, true);
  assert.equal(a.snapshot().joining, null);
  assert.equal(host.snapshot().meJoined, false);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state.tap.seats, [1, 2]);
  assert.deepEqual(r.hub.violations, []);
});

test('the host ignores game moves from people who are only watching', async () => {
  const r = await lobby(3);
  const [host, a, watcher] = r.engines;
  a.join();
  await r.clock.advance(600);
  host.lobby.start();
  await r.clock.advance(400);
  assert.equal(watcher.act({ type: 'tap' }), false);
  assert.equal(host.act({ type: 'tap' }), false);
  const raw = r.hub.clients.get(r.hub.people[2].id);
  raw.send({ t: 'g', g: 'tap', a: { type: 'tap' } });
  raw.send({ t: 'many', m: [{ t: 'g', g: 'tap', a: { type: 'tap' } }, { t: 'g', g: 'tap', a: { type: 'tap' } }] });
  await r.clock.advance(400);
  assert.equal(host.snapshot().state.tap.n, 0);
  assert.deepEqual(host.snapshot().scores.g, {});
  a.act({ type: 'tap' });
  await r.clock.advance(400);
  assert.equal(watcher.snapshot().state.tap.n, 1);
  assert.deepEqual(watcher.snapshot().scores.g, { 1: 10 });
  assert.equal(watcher.snapshot().players.find((p) => p.isMe).joined, false);
});

test('a watcher cannot write open game keys, even raw', async () => {
  const pad = {
    id: 'pad',
    name: 'Pad',
    emoji: '📝',
    blurb: 'Open keys',
    minPlayers: 1,
    keys: [],
    prefixes: ['pad.'],
    open: ['pad.'],
    settings: [],
    start() {},
    intent() {},
  };
  const r = room(3, { games: [pad], join: false });
  await r.clock.advance(500);
  const [host, a, watcher] = r.engines;
  a.join();
  await r.clock.advance(600);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  assert.equal(a.direct('pad.0', { s: 'mine' }), true);
  assert.equal(watcher.direct('pad.1', { s: 'nope' }), false);
  r.hub.clients.get(r.hub.people[2].id).set('pad.2', { s: 'forged' });
  await r.clock.advance(4000);
  for (const e of r.engines) {
    assert.deepEqual(e.snapshot().state['pad.0'], { s: 'mine' });
    assert.equal(e.snapshot().state['pad.1'], undefined);
    assert.equal(e.snapshot().state['pad.2'], undefined);
  }
});

test('Leave and leaving the call both drop you from play', async () => {
  const r = await lobby(3);
  const [host, a, b] = r.engines;
  host.join();
  a.join();
  b.join();
  await r.clock.advance(600);
  assert.equal(host.snapshot().playing, 3);
  a.leave();
  await r.clock.advance(600);
  assert.equal(host.snapshot().playing, 2);
  assert.equal(a.snapshot().meJoined, false);
  assert.equal(a.snapshot().players.find((p) => p.isMe).slot, 1, 'a watcher keeps their seat and name');
  r.hub.leave(r.hub.people[2].id);
  b.destroy();
  await r.clock.advance(600);
  assert.equal(host.snapshot().playing, 1);
  const st = r.hub.state.players.p[r.hub.people[1] ? r.hub.people[1].id : ''];
  assert.equal(Boolean(st && st.y), false);
  const back = r.add(3);
  await r.clock.advance(600);
  assert.equal(back.snapshot().meJoined, false, 'coming back to the call starts you as a watcher');
});

test('someone who joins mid-game gets fitted in by the game, on the host only', async () => {
  joins.length = 0;
  const r = await lobby(3);
  const [host, a, late] = r.engines;
  a.join();
  await r.clock.advance(600);
  host.lobby.start();
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().state.tap.seats, [1]);
  late.join();
  await r.clock.advance(600);
  assert.equal(joins.length, 1, 'only the host runs join');
  assert.equal(joins[0].slot, 2);
  assert.deepEqual(joins[0].players, [1, 2], 'they are already a player when join runs');
  assert.deepEqual(late.snapshot().state.tap.seats, [1, 2]);
  late.act({ type: 'tap' });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[2], 10);
  late.join();
  await r.clock.advance(600);
  assert.equal(joins.length, 1, 'joining twice does not fit them in twice');
});

test('a game that throws on join cannot break the room', async () => {
  const r = await lobby(2);
  const [host, late] = r.engines;
  host.join();
  await r.clock.advance(300);
  host.lobby.pick('boom');
  assert.equal(host.lobby.start().ok, true);
  const errs = [];
  host.on('error', (e) => errs.push(e.message));
  await r.clock.advance(300);
  late.join();
  await r.clock.advance(600);
  assert.match(errs.join(' '), /join went wrong/);
  assert.equal(host.snapshot().playing, 2);
  late.act({ type: 'hit' });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 5);
  assert.equal(host.snapshot().room.phase, 'game');
});

test('a game with autoStart counts down once enough people join, for everyone at once', async () => {
  race.started = 0;
  const r = await lobby(3);
  const [host, a, b] = r.engines;
  assert.deepEqual(autoOf(race), { min: 2, ms: 90000 });
  host.lobby.pick('race');
  await r.clock.advance(300);
  assert.equal(host.snapshot().room.auto, null);
  a.join();
  await r.clock.advance(600);
  assert.equal(b.snapshot().room.auto, null, 'one player is not enough');
  b.join();
  await r.clock.advance(600);
  const auto = host.snapshot().room.auto;
  assert.ok(auto && auto.at - auto.from === 90000);
  for (const e of r.engines) assert.deepEqual(e.snapshot().room.auto, auto);
  b.leave();
  await r.clock.advance(600);
  for (const e of r.engines) assert.equal(e.snapshot().room.auto, null, 'dropping below two cancels it');
  b.join();
  await r.clock.advance(600);
  const again = host.snapshot().room.auto;
  assert.ok(again && again.at > auto.at);
  host.join();
  await r.clock.advance(600);
  assert.deepEqual(host.snapshot().room.auto, again, 'joining during the countdown keeps the same timer');
  await r.clock.advance(again.at - r.clock.now() - 1000);
  assert.equal(host.snapshot().room.phase, 'lobby');
  await r.clock.advance(1500);
  assert.equal(race.started, 1);
  for (const e of r.engines) {
    const s = e.snapshot();
    assert.equal(s.room.phase, 'game');
    assert.equal(s.room.game, 'race');
    assert.equal(s.room.auto, null);
  }
  assert.deepEqual(host.snapshot().state.race.who, [0, 1, 2]);
  assert.deepEqual(r.hub.violations, []);
});

test('the host can start early, and picking another game cancels the countdown', async () => {
  race.started = 0;
  const r = await lobby(2);
  const [host, a] = r.engines;
  host.join();
  a.join();
  await r.clock.advance(600);
  host.lobby.pick('race');
  await r.clock.advance(300);
  assert.ok(a.snapshot().room.auto);
  assert.equal(a.lobby.start().ok, false);
  host.lobby.pick('tap');
  await r.clock.advance(300);
  assert.equal(a.snapshot().room.auto, null);
  host.lobby.pick('race');
  await r.clock.advance(300);
  assert.ok(a.snapshot().room.auto);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  assert.equal(a.snapshot().room.phase, 'game');
  assert.equal(a.snapshot().room.auto, null);
  await r.clock.advance(95000);
  assert.equal(race.started, 1, 'the countdown does not start it a second time');
  host.lobby.toLobby();
  await r.clock.advance(300);
  assert.ok(a.snapshot().room.auto, 'back in the lobby the countdown starts again');
});

test('a new host picks up the countdown from shared state', async () => {
  race.started = 0;
  const r = await lobby(3);
  const [host, a, b] = r.engines;
  a.join();
  b.join();
  host.lobby.pick('race');
  await r.clock.advance(600);
  const auto = a.snapshot().room.auto;
  assert.ok(auto);
  r.hub.leave(r.hub.people[0].id);
  host.destroy();
  await r.clock.advance(300);
  assert.equal(a.isHost(), true);
  assert.deepEqual(a.snapshot().room.auto, auto);
  await r.clock.advance(auto.at - r.clock.now() + 500);
  assert.equal(b.snapshot().room.phase, 'game');
  assert.equal(race.started, 1);
});

test('watchers are pruned before players when the list is full', async () => {
  const clock2 = new Clock();
  const hub = new Hub(clock2);
  const engines = [];
  for (let i = 1; i <= PLAYER_CAP + 8; i += 1) {
    const t = hub.join({ id: `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`, display_name: `Person number ${i}` });
    const e = createEngine({ transport: t, games, now: clock2.now, setTimeout: clock2.setTimeout, clearTimeout: clock2.clearTimeout });
    if (i % 3 === 0) e.join();
    engines.push(e);
    await clock2.advance(60);
  }
  await clock2.advance(20000);
  const ps = hub.state.players;
  assert.ok(Object.keys(ps.p).length <= PLAYER_CAP);
  assert.ok(jsonBytes(ps) <= PLAYERS_BYTES);
  const playerIds = hub.people.filter((p, i) => (i + 1) % 3 === 0).map((p) => p.id);
  for (const id of playerIds) assert.equal(ps.p[id] && ps.p[id].y, 1, 'every player keeps their seat');
  assert.equal(engines[0].snapshot().playing, playerIds.length);
  assert.deepEqual(hub.violations, []);
});

test('the scoreboard ranks players, marks the top three, highlights you and badges the drawer', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const mk = (slot, name, game, extra = {}) => ({ id: `id${slot}`, slot, name, username: `user${slot}`, initials: name[0], hue: slot * 30, avatar: null, present: true, joined: true, isMe: false, game, ...extra });
  const players = [
    mk(0, 'Jolli', 4040),
    mk(1, 'Jakens', 4500),
    mk(2, 'Shi-sho', 4030, { isMe: true }),
    mk(3, 'Deepend', 0, { avatar: 'https://files.yapper.website/a.png' }),
    ...Array.from({ length: 8 }, (_, i) => mk(4 + i, `Guest ${i}`, 100 * i)),
  ];
  const rows = standings(players, 'game');
  assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ['Jakens', 'Jolli', 'Shi-sho']);
  const watching = standings([...players, mk(20, 'Mila', 0, { joined: false }), mk(21, 'Ozzy', 50, { joined: false })], 'game').map((r) => r.name);
  assert.equal(watching.includes('Mila'), false);
  assert.equal(watching.includes('Ozzy'), true);
  const el = board(rows, { label: 'Points this game', layout: 'bar', badge: { slot: 0, icon: '✏️', label: 'Drawing now' }, gains: { 1: 120 } });
  const nodes = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) nodes.push(c);
      walk(c);
    }
  };
  walk(el);
  const cards = nodes.filter((n) => n.classList && n.classList.contains('board-card'));
  const rest = nodes.filter((n) => n.classList && n.classList.contains('board-row'));
  assert.deepEqual(cards.map((c) => c.dataset.id), ['id1', 'id0', 'id2']);
  assert.ok(cards[0].classList.contains('place-1'));
  assert.ok(cards[2].classList.contains('is-me'));
  assert.equal(rest.length, 9);
  assert.equal(nodes.filter((n) => n.classList && n.classList.contains('is-me')).length, 1);
  const badge = nodes.find((n) => n.classList && n.classList.contains('board-badge'));
  assert.ok(badge && badge.dataset.badge === 'Drawing now');
  assert.equal(cards[1].dataset.badge, 'Drawing now');
  assert.ok(nodes.some((n) => n.classList && n.classList.contains('board-gain') && n.textContent === '+120'));
  assert.ok(nodes.some((n) => n.localName === 'img' && n.src === 'https://files.yapper.website/a.png' && n.getAttribute('referrerpolicy') === 'no-referrer'));
  assert.ok(el.classList.contains('board-bar'));
  assert.equal(el.dataset.scoreboard, 'list');
});

test('lobby text and countdown clock read naturally', () => {
  assert.equal(clock(90000), '1:30');
  assert.equal(clock(83001), '1:24');
  assert.equal(clock(-5), '0:00');
  assert.equal(needText(1), 'Waiting for one more player');
  assert.equal(needText(3), 'Waiting for 3 more players');
  const snap = {
    isHost: false,
    hostName: 'Jolli',
    pick: race,
    settings: {},
    meJoined: false,
    joining: null,
    autoStart: { min: 2, ms: 90000 },
    room: { round: 0, auto: null },
    players: [
      { id: 'a', slot: 0, name: 'Jolli', username: 'jolli', present: true, joined: true, isHost: true, isMe: false, total: 0 },
      { id: 'b', slot: 1, name: 'Deepend', username: 'greninjite', present: true, joined: false, isHost: false, isMe: true, total: 0 },
    ],
  };
  const m = lobbyModel(snap, games);
  assert.equal(m.need, 1);
  assert.deepEqual(m.playing.map((p) => p.username), ['jolli']);
  assert.deepEqual(m.watching.map((p) => p.name), ['Deepend']);
});

function eventWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    },
    count(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

async function mount(engine) {
  const { window } = globalThis;
  const root = document.createElement('div');
  document.body.append(root);
  const events = eventWindow();
  const win = Object.assign(window, events, {
    document,
    parent: window,
    innerWidth: 400,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  return { root, win, app: mountApp({ root, engine, bridge: { close() {} }, win }) };
}

function textOf(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(textOf).join(' ');
}

function byKey(root, key) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out.find((el) => el.dataset && el.dataset.key === key) || null;
}

test('new profiles trigger one re-render, not one per profile', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await lobby(2);
  const { win, app } = await mount(r.engines[1]);
  await r.clock.advance(300);
  const before = app.renders;
  for (let i = 0; i < 6; i += 1) win.dispatchEvent({ type: 'yapos:profiles' });
  assert.equal(app.renders, before);
  await new Promise((done) => setTimeout(done, 250));
  assert.equal(app.renders, before + 1);
  app.destroy();
  assert.equal(win.count('yapos:profiles'), 0);
});

test('the lobby shows Join, the waiting line, then a shared m:ss countdown with Start now for the host', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await lobby(2);
  const [hostEngine, guestEngine] = r.engines;
  const host = await mount(hostEngine);
  const guest = await mount(guestEngine);
  hostEngine.lobby.pick('race');
  await r.clock.advance(400);
  assert.match(textOf(guest.root), /Join game/);
  assert.match(textOf(guest.root), /Waiting for 2 more players/);
  byKey(guest.root, 'join').click();
  await r.clock.advance(600);
  assert.match(textOf(guest.root), /Waiting for one more player/);
  assert.match(textOf(guest.root), /Leave game/);
  byKey(host.root, 'join').click();
  await r.clock.advance(8600);
  host.app.render(hostEngine.snapshot());
  guest.app.render(guestEngine.snapshot());
  assert.match(textOf(guest.root), /Starting in\s+1:2\d/);
  assert.equal(byKey(guest.root, 'start'), null);
  assert.match(textOf(byKey(host.root, 'start')), /Start now/);
  byKey(host.root, 'start').click();
  await r.clock.advance(400);
  assert.equal(guestEngine.snapshot().room.phase, 'game');
  host.app.destroy();
  guest.app.destroy();
});

test('a watcher sees a Join game button during a game and can hop in late', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await lobby(2);
  const [hostEngine, guestEngine] = r.engines;
  hostEngine.join();
  await r.clock.advance(300);
  hostEngine.lobby.pick('trivia');
  hostEngine.lobby.start();
  await r.clock.advance(400);
  const guest = await mount(guestEngine);
  await r.clock.advance(300);
  assert.match(textOf(guest.root), /Watching/);
  byKey(guest.root, 'join-late').click();
  await r.clock.advance(600);
  assert.equal(guestEngine.snapshot().meJoined, true);
  assert.equal(byKey(guest.root, 'join-late'), null);
  guest.app.destroy();
});
