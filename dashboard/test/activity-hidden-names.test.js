import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person as kitPerson } from './activity-kit.test.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import { HIDDEN_NAME, nameHidden, handleHidden, shownName, resetHidden, setHiddenName } from '../web/activity/js/hidden.js';
import { person, people } from '../web/activity/js/players.js';
import { GAMES } from '../web/activity/js/games/index.js';

const HIDDEN = kitPerson(2).id;
const HANDLE = kitPerson(3).id;
const seen = [];

const namer = {
  id: 'namer',
  name: 'Namer',
  emoji: '\u{1F3F7}️',
  blurb: 'Test game',
  minPlayers: 1,
  keys: ['namer'],
  start(api) {
    seen.push(api.players().map((p) => [p.id, p.name, api.nameOf(p.slot)]));
    api.put('namer', { on: 1 });
    api.setDeadline(api.now() + 60000);
  },
  intent() {},
  deadline(api) {
    api.setDeadline(api.now() + 60000);
  },
};

function fakeFetch(state) {
  return async (url) => {
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: [], owner: null, ...(state.names ? { hiddenNames: ids.filter((id) => state.names.includes(id)) } : {}), ...(state.handles ? { hiddenUsernames: ids.filter((id) => state.handles.includes(id)) } : {}) }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
    await clock.advance(ms / 6);
  }
}

test('the name helper swaps in Hidden name and drops a hidden username', () => {
  resetHidden();
  const p = { id: 'abc', display_name: 'Rude Name', username: 'rudeguy' };
  assert.deepEqual([person(p).name, person(p).username], ['Rude Name', 'rudeguy']);
  assert.equal(setHiddenName('abc', true, false), true);
  assert.equal(setHiddenName('abc', true, false), false, 'no change, no event');
  assert.equal(person(p).name, HIDDEN_NAME);
  assert.equal(person(p).username, 'rudeguy');
  assert.equal(person(p).initials, 'HN');
  setHiddenName('abc', false, true);
  assert.equal(person(p).name, 'Rude Name');
  assert.equal(person(p).username, null);
  assert.equal(person({ id: 'abc', username: 'rudeguy' }).name, HIDDEN_NAME, 'a name that is only the username is hidden with it');
  assert.equal(shownName('abc', 'Stored'), 'Stored');
  setHiddenName('abc', true, true);
  assert.equal(shownName('abc', 'Stored'), HIDDEN_NAME);
  assert.deepEqual(people([p, { id: 'zzz', display_name: 'Fine' }]).map((x) => x.name), [HIDDEN_NAME, 'Fine']);
  resetHidden();
  assert.equal(nameHidden('abc'), false);
});

test('the host learns hidden names from the admin check and every game screen uses Hidden name', async () => {
  resetAdmins();
  seen.length = 0;
  const state = { names: [HIDDEN], handles: [HANDLE] };
  configureAdmins({ fetch: fakeFetch(state), refreshMs: 0, win: null });
  const r = room(3, { games: [namer, ...GAMES] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  assert.equal(nameHidden(HIDDEN), true);
  assert.equal(handleHidden(HANDLE), true);
  const [host] = r.engines;
  for (const e of r.engines) {
    const snap = e.snapshot();
    assert.equal(snap.players.find((p) => p.id === HIDDEN).name, HIDDEN_NAME, 'lobby and scoreboard rows');
    assert.equal(snap.players.find((p) => p.id === HIDDEN).initials, 'HN');
    assert.equal(snap.players.find((p) => p.id === HANDLE).username, null);
    assert.equal(snap.players.find((p) => p.id === kitPerson(1).id).name, 'Player 1');
  }
  host.lobby.pick('namer');
  host.lobby.start();
  await settle(r.clock);
  const row = seen[0].find(([id]) => id === HIDDEN);
  assert.deepEqual(row, [HIDDEN, HIDDEN_NAME, HIDDEN_NAME], 'player lists and turn labels');
  state.names = [];
  state.handles = [];
  await refreshAdmins(r.engines.map((e) => e.snapshot().me), { force: true });
  await settle(r.clock);
  assert.equal(host.snapshot().players.find((p) => p.id === HIDDEN).name, 'Player 2', 'unhiding restores the name');
  assert.equal(nameHidden(HIDDEN), false);
  resetAdmins();
});

test('resetting the admin cache forgets hidden names', () => {
  setHiddenName('x1', true, true);
  resetAdmins();
  assert.equal(nameHidden('x1'), false);
  assert.equal(handleHidden('x1'), false);
});

test('a stored name that is only the hidden username is hidden even after the person leaves', () => {
  resetHidden();
  person({ id: 'gone', username: 'rudeguy' });
  setHiddenName('gone', false, true);
  assert.equal(shownName('gone', 'rudeguy'), HIDDEN_NAME);
  assert.equal(shownName('gone', '@RudeGuy'), HIDDEN_NAME);
  assert.equal(shownName('gone', 'Real Name'), 'Real Name');
  assert.equal(shownName('other', 'rudeguy'), 'rudeguy');
  setHiddenName('gone', false, false);
  assert.equal(shownName('gone', 'rudeguy'), 'rudeguy');
  resetHidden();
  setHiddenName('gone', false, true);
  assert.equal(shownName('gone', 'rudeguy'), 'rudeguy', 'nothing is known after a reset');
  resetHidden();
});
