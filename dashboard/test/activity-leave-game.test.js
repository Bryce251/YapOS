import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine } from '../web/activity/js/engine.js';
import { headerModel, stripModel } from '../web/activity/js/ui/app.js';

function stub() {
  return {
    id: 'stubgame',
    name: 'Stub game',
    emoji: '🎲',
    category: 'quick',
    blurb: 'Stub',
    minPlayers: 1,
    keys: ['kstub'],
    settings: [],
    start(api) {
      api.put('kstub', { on: 1 });
      api.addPoints(1, 40);
    },
    intent() {},
    deadline() {},
    resume() {},
    model() {
      return null;
    },
  };
}

function party(count) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(5);
  const engines = [];
  for (let i = 1; i <= count; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: [stub()], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: () => {} });
    e.join();
    engines.push(e);
  }
  return { clock, engines };
}

test('a player can leave a running game and keep watching, and only players see the button', async () => {
  const { clock, engines } = party(3);
  await clock.advance(500);
  const [host, guest] = engines;
  assert.equal(headerModel(guest.snapshot()).canLeave, false, 'no leave button in the lobby header');
  assert.equal(host.lobby.start().ok, true);
  await clock.advance(300);
  const before = headerModel(guest.snapshot());
  assert.equal(before.phase, 'game');
  assert.equal(before.canLeave, true);
  assert.equal(before.quitArmed, false);
  assert.equal(headerModel(guest.snapshot(), { quitArmed: true }).quitArmed, true);
  assert.equal(guest.leave(), true);
  await clock.advance(1500);
  const snap = guest.snapshot();
  assert.equal(snap.room.phase, 'game', 'the game keeps going for everyone else');
  assert.equal(snap.meJoined, false);
  const after = headerModel(snap, { quitArmed: true });
  assert.equal(after.canLeave, false);
  assert.equal(after.quitArmed, false);
  const me = stripModel(snap).rows.find((p) => p.isMe);
  assert.ok(me && me.pts >= 40, 'points scored before leaving stay on the board');
  assert.equal(headerModel(host.snapshot()).canLeave, true, 'the host can leave the game too without ending it');
});
