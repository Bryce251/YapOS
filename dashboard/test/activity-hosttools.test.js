import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine } from '../web/activity/js/engine.js';
import { readPresets, savePreset, deletePreset, cleanPresetName, hostBarModel, PRESETS_KEY, PRESETS_MAX } from '../web/activity/js/ui/hosttools.js';
import { spectateModel } from '../web/activity/js/ui/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function stub(id) {
  return {
    id,
    name: `Game ${id}`,
    emoji: '🎲',
    category: 'quick',
    blurb: 'Stub',
    minPlayers: 1,
    keys: [`k${id}`],
    settings: [
      { id: 'rounds', label: 'Rounds', type: 'choice', options: [3, 5].map((v) => ({ value: v, label: String(v) })), default: 3 },
      { id: 'fast', label: 'Fast', type: 'toggle', default: false },
    ],
    start(api) {
      api.put(`k${id}`, { on: 1 });
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

function party(count, joined = count) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(4);
  const engines = [];
  for (let i = 1; i <= count; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: [stub('trivia'), stub('wyr')], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: () => true });
    if (i <= joined) e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

function memStore() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('the host can take a player out of this game and they cannot rejoin until the next one', async () => {
  const r = party(3);
  await r.clock.advance(500);
  const [host, guest, third] = r.engines;
  assert.equal(host.lobby.remove(1), false, 'nothing to remove from in the lobby');
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(guest.lobby.remove(2), false, 'only the host has host tools');
  assert.equal(host.lobby.remove(0), false, 'the host cannot remove themselves');
  assert.equal(host.lobby.remove(1), true);
  await r.clock.advance(400);
  let snap = guest.snapshot();
  assert.equal(snap.meJoined, false);
  assert.equal(snap.hostTools.removed, true);
  assert.deepEqual(spectateModel(snap), { meJoined: false, joining: null, banned: false, removed: true });
  guest.join();
  await r.clock.advance(5000);
  assert.equal(guest.snapshot().meJoined, false, 'a removed player stays a watcher this game');
  assert.equal(third.snapshot().meJoined, true);
  host.lobby.end();
  await r.clock.advance(300);
  guest.join();
  await r.clock.advance(400);
  assert.equal(guest.snapshot().meJoined, true, 'they can play again once the game is over');
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(guest.snapshot().hostTools.removed, false);
});

test('locking late joins keeps watchers out of a running game but not the next one', async () => {
  const r = party(3, 2);
  await r.clock.advance(500);
  const [host, , late] = r.engines;
  assert.equal(host.lobby.lateLock(true), true);
  host.lobby.start();
  await r.clock.advance(300);
  assert.equal(late.snapshot().hostTools.lateLocked, true);
  assert.equal(spectateModel(late.snapshot()).locked, true);
  late.join();
  await r.clock.advance(5000);
  assert.equal(late.snapshot().meJoined, false);
  host.lobby.lateLock(false);
  await r.clock.advance(300);
  late.join();
  await r.clock.advance(800);
  assert.equal(late.snapshot().meJoined, true);
});

test('the host bar lists the other players and protects the owner from removal', async () => {
  const r = party(3);
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(hostBarModel(host.snapshot(), false), null, 'no host bar in the lobby');
  host.lobby.start();
  await r.clock.advance(300);
  const m = hostBarModel(host.snapshot(), true);
  assert.equal(m.open, true);
  assert.deepEqual(m.players.map((p) => p.slot), [1, 2]);
  assert.equal(hostBarModel(r.engines[1].snapshot(), true), null, 'guests never see host tools');
  const owned = { ...host.snapshot() };
  owned.players = owned.players.map((p) => (p.slot === 2 ? { ...p, isOwner: true } : p));
  owned.admin = { ...owned.admin, owner: owned.players.find((p) => p.slot === 2).id };
  assert.equal(hostBarModel(owned, true).players.find((p) => p.slot === 2).safe, true);
});

test('presets save up to five named settings on this device and load in one step', async () => {
  const store = memStore();
  assert.deepEqual(readPresets(store), []);
  assert.equal(cleanPresetName('  Friday   night​  '), 'Friday night');
  assert.equal(savePreset(store, { name: '   ', game: 'trivia', settings: {} }).reason, 'name');
  for (let i = 1; i <= PRESETS_MAX; i += 1) assert.equal(savePreset(store, { name: `P${i}`, game: 'trivia', settings: { rounds: 5 } }).ok, true);
  assert.equal(savePreset(store, { name: 'P6', game: 'trivia', settings: {} }).reason, 'full');
  assert.equal(savePreset(store, { name: 'p1', game: 'wyr', settings: { rounds: 5, fast: true }, tour: { g: ['trivia', 'wyr'] } }).ok, true, 'same name replaces');
  let list = readPresets(store);
  assert.equal(list.length, PRESETS_MAX);
  assert.equal(list[0].game, 'wyr');
  assert.deepEqual(list[0].tour, { g: ['trivia', 'wyr'] });
  list = deletePreset(store, 4);
  assert.equal(list.length, PRESETS_MAX - 1);
  store.map.set(PRESETS_KEY, '{broken');
  assert.deepEqual(readPresets(store), []);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readPresets(broken), []);
  assert.equal(savePreset(broken, { name: 'x', game: 'trivia' }).ok, false);
  assert.deepEqual(readPresets(null), []);

  const r = party(2);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  assert.equal(guest.lobby.applyPreset({ game: 'wyr', settings: { rounds: 5 } }), false);
  assert.equal(host.lobby.applyPreset({ game: 'wyr', settings: { rounds: 5, fast: true, bogus: 1 }, tour: { g: ['trivia'] } }), true);
  await r.clock.advance(300);
  const snap = guest.snapshot();
  assert.equal(snap.pick.id, 'wyr');
  assert.deepEqual(snap.settings, { rounds: 5, fast: true });
  assert.deepEqual(snap.tour.setup, { g: ['trivia'] });
  assert.equal(host.lobby.applyPreset({ game: 'gone', settings: {} }), false);
  assert.equal(host.lobby.applyPreset({ game: 'trivia', settings: { rounds: 99 }, tour: null }), true);
  await r.clock.advance(300);
  assert.equal(guest.snapshot().settings.rounds, 3);
  assert.equal(guest.snapshot().tour.setup, null);
});

test('the lobby shows tournament, late join and preset controls only to the host', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const r = party(2);
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  const store = memStore();
  const toasts = [];
  const hostLobby = createLobby({ engine: host, toast: (t) => toasts.push(t), store, sfx: null });
  const guestLobby = createLobby({ engine: guest, toast: () => {}, store: memStore(), sfx: null });
  hostLobby.update(host.snapshot());
  guestLobby.update(guest.snapshot());
  const find = (node, key) => {
    for (const c of node.childNodes || []) {
      if (c.dataset && c.dataset.key === key) return c;
      const hit = find(c, key);
      if (hit) return hit;
    }
    return null;
  };
  assert.ok(find(hostLobby.el, 'tour-toggle'));
  assert.ok(find(hostLobby.el, 'late-lock'));
  assert.ok(find(hostLobby.el, 'preset-save'));
  assert.equal(find(guestLobby.el, 'tour-toggle'), null);
  assert.equal(find(guestLobby.el, 'preset-save'), null);
  find(hostLobby.el, 'tour-toggle').click();
  await r.clock.advance(300);
  hostLobby.update(host.snapshot());
  guestLobby.update(guest.snapshot());
  assert.match(hostLobby.el.textContent, /Start tournament/);
  assert.match(guestLobby.el.textContent, /start the tournament/);
  find(hostLobby.el, 'tour-pick-wyr').click();
  await r.clock.advance(300);
  hostLobby.update(host.snapshot());
  assert.deepEqual(host.snapshot().tour.setup, { g: ['wyr'] });
  const input = find(hostLobby.el, 'preset-name');
  input.value = 'Quiz night';
  find(hostLobby.el, 'preset-save').click();
  assert.equal(readPresets(store)[0].name, 'Quiz night');
  assert.deepEqual(readPresets(store)[0].tour, { g: ['wyr'] });
  assert.ok(find(hostLobby.el, 'preset-load-0'));
  find(hostLobby.el, 'late-lock').click();
  await r.clock.advance(300);
  assert.equal(host.snapshot().hostTools.lateLocked, true);
  hostLobby.destroy();
  guestLobby.destroy();
});

test('presets reach storage only through the injected store', () => {
  const src = readFileSync(path.join(here, '..', 'web', 'activity', 'js', 'ui', 'hosttools.js'), 'utf8');
  assert.equal(/localStorage|sessionStorage/.test(src), false);
  assert.deepEqual([...src.matchAll(/setItem\(([^,]+),/g)].map((m) => m[1]), ['PRESETS_KEY']);
});
