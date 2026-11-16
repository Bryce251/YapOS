import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine } from '../web/activity/js/engine.js';

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

test('the last round reported is the final round and doubles points', async () => {
  const r = await started(duel({ cards: undefined }));
  const [host, a] = r.engines;
  host.act({ type: 'round', i: 1 });
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 100);
  assert.equal(a.snapshot().fun.final, false);
  host.act({ type: 'round', i: 2 });
  host.act({ type: 'round', i: 3 });
  await r.clock.advance(400);
  const s = a.snapshot();
  assert.equal(s.fun.final, true);
  assert.equal(s.fun.line.kind, 'final');
  assert.equal(s.fun.line.banner, true);
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 300);
  a.act({ type: 'score', n: -50 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 250, 'losses are not doubled');
});

test('one-round games and the setting turned off never double', async () => {
  let r = await started(duel({ cards: undefined }));
  r.engines[0].act({ type: 'round', i: 1, of: 1 });
  r.engines[1].act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(r.engines[0].snapshot().scores.g[1], 100);
  r = await started(duel({ cards: undefined }), 3, { before: (x) => x.engines[0].lobby.party('final', false) });
  r.engines[0].act({ type: 'round', i: 3 });
  r.engines[1].act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(r.engines[0].snapshot().scores.g[1], 100);
  assert.equal(r.engines[1].snapshot().fun.final, false);
  assert.equal(r.engines[1].snapshot().party.final, false);
});

test('a double card in the final round stacks to four times', async () => {
  const r = await started(duel({ cards: ['double'] }));
  const [host, a] = r.engines;
  host.act({ type: 'round', i: 3 });
  a.play('double');
  await r.clock.advance(400);
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 400);
});

test('the final round splash shows once per game and the dock shows a final chip', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createParty, splashKey, dockModel } = await import('../web/activity/js/ui/party.js');
  const r = await started(duel({ cards: undefined }));
  const a = r.engines[1];
  assert.equal(splashKey(a.snapshot()), null);
  r.engines[0].act({ type: 'round', i: 3 });
  await r.clock.advance(400);
  assert.equal(splashKey(a.snapshot()), `${a.snapshot().room.round}`);
  assert.equal(dockModel(a.snapshot()).final, true);
  const played = [];
  const win = { innerWidth: 900, setTimeout: () => 1, clearTimeout() {} };
  const party = createParty({ engine: a, win, sfx: { play: (n) => played.push(n) } });
  party.update(a.snapshot());
  party.update(a.snapshot());
  const text = (n) => (n.data !== undefined && !n.localName ? n.data : (n.childNodes || []).map(text).join(' '));
  assert.match(text(party.el), /FINAL ROUND/);
  assert.equal(played.filter((x) => x === 'start').length, 1);
  party.destroy();
});

test('a final round that runs over several rounds says FINAL ROUND only once', async () => {
  const r = await started(duel({ cards: undefined }), 2);
  const [host, a] = r.engines;
  const lines = new Set();
  for (let i = 1; i <= 6; i += 1) {
    host.act({ type: 'round', i, of: i });
    await r.clock.advance(5000);
    const line = a.snapshot().fun.line;
    if (line && line.kind === 'final') lines.add(line.i);
  }
  assert.equal(lines.size, 1);
  assert.equal(a.snapshot().fun.final, true);
});
