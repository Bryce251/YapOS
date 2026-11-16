import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine, FUN, CARDS } from '../web/activity/js/engine.js';
import { cardsFor, dealCards, slotAbove, cardByCode, CARD_IDS } from '../web/activity/js/fun.js';

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

test('card helpers deal only what a game supports and find the player above', () => {
  assert.deepEqual(cardsFor({ cards: ['swap', 'nope', 'double'] }), ['swap', 'double']);
  assert.deepEqual(cardsFor({ cards: ['peek'] }), [], 'peek needs a hint hook');
  assert.deepEqual(cardsFor({ cards: ['peek'], hint() {} }), ['peek']);
  assert.deepEqual(cardsFor({}), []);
  const dealt = dealCards([0, 1, 2, 'x'], ['swap'], seeded(1));
  assert.deepEqual(dealt, { 0: 's', 1: 's', 2: 's' });
  assert.deepEqual(dealCards([0, 1], [], seeded(1)), {});
  assert.equal(slotAbove({ 0: 50, 1: 20, 2: 10 }, [0, 1, 2], 2), 1);
  assert.equal(slotAbove({ 0: 50, 1: 20, 2: 10 }, [0, 1, 2], 1), 0);
  assert.equal(slotAbove({ 0: 50, 1: 20, 2: 10 }, [0, 1, 2], 0), null);
  assert.equal(slotAbove({ 0: 20, 1: 20 }, [0, 1], 1), null);
  assert.equal(CARDS.length, 4);
  for (const c of CARDS) assert.equal(cardByCode(c.code).id, c.id);
  assert.deepEqual(CARD_IDS, ['swap', 'freeze', 'double', 'peek']);
});

test('the host deals one card per joined player, and none when the setting is off or the game has none', async () => {
  let r = await started(duel());
  let f = r.hub.state[FUN];
  assert.deepEqual(Object.keys(f.c).sort(), ['0', '1', '2']);
  for (const e of r.engines) {
    const s = e.snapshot();
    assert.ok(s.fun.card, 'everyone sees their own card');
    assert.equal(s.fun.used, false);
  }
  r = await started(duel(), 3, { before: (x) => assert.equal(x.engines[0].lobby.party('cards', false), true) });
  assert.equal(r.engines[1].snapshot().party.cards, false);
  assert.equal(r.engines[1].snapshot().fun.card, null);
  r = await started(duel({ cards: undefined }));
  assert.equal(r.hub.state[FUN], undefined, 'games without cards write no fun state at all');
  assert.equal(r.engines[2].snapshot().fun.card, null);
  assert.equal(r.engines[1].lobby.party('cards', false), false, 'only the host changes party extras');
});

test('swap trades scores with the player just above, once per game', async () => {
  const r = await started(duel({ cards: ['swap'] }));
  const [host, a, b] = r.engines;
  host.act({ type: 'score', n: 300 });
  a.act({ type: 'score', n: 100 });
  b.act({ type: 'score', n: 50 });
  await r.clock.advance(400);
  assert.equal(b.play('swap'), true);
  await r.clock.advance(400);
  let s = host.snapshot();
  assert.deepEqual(s.scores.g, { 0: 300, 1: 50, 2: 100 });
  assert.equal(b.snapshot().fun.used, true);
  assert.equal(b.play('swap'), false, 'a used card cannot be played again');
  assert.equal(s.fun.line.kind, 'swap');
  assert.match(s.fun.line.text, /Player 3/);
  assert.equal(r.hub.violations.length, 0);
});

test('swap at the top is refused privately and the card stays in hand', async () => {
  const r = await started(duel({ cards: ['swap'] }));
  const [host, a, b] = r.engines;
  host.act({ type: 'score', n: 300 });
  await r.clock.advance(400);
  const toA = [];
  const toB = [];
  a.on('cardno', (x) => toA.push(x.text));
  b.on('cardno', (x) => toB.push(x.text));
  const mine = [];
  host.on('cardno', (x) => mine.push(x.text));
  assert.equal(host.play('swap'), false);
  assert.match(mine[0], /Nobody is above you/);
  a.act({ type: 'score', n: 500 });
  await r.clock.advance(400);
  b.play('swap');
  await r.clock.advance(400);
  assert.equal(b.snapshot().fun.used, true, 'Player 3 had someone above, so it worked');
  assert.equal(toA.length, 0);
  assert.equal(host.snapshot().fun.used, false, 'the host still holds the refused card');
});

test('double makes the next points count twice and then wears off', async () => {
  const r = await started(duel({ cards: ['double'] }));
  const [host, a] = r.engines;
  assert.equal(a.play('double'), true);
  await r.clock.advance(400);
  assert.equal(a.snapshot().fun.double, true);
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 200);
  assert.equal(host.snapshot().state.duel.got, 200, 'addPoints returns what was really awarded');
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 300);
  assert.equal(a.snapshot().fun.double, false);
  a.act({ type: 'score', n: -40 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[1], 260, 'losses are never multiplied');
});

test('freeze calls the game hook, marks the target and thaws on request', async () => {
  const seen = [];
  const r = await started(
    duel({
      cards: ['freeze'],
      canFreeze(api, to, by) {
        seen.push([to, by]);
        return to !== 0;
      },
    }),
  );
  const [host, a] = r.engines;
  const no = [];
  a.on('cardno', (x) => no.push(x.text));
  a.play('freeze', 0);
  await r.clock.advance(400);
  assert.equal(no.length, 1, 'the game said no');
  assert.equal(a.snapshot().fun.used, false);
  a.play('freeze', 2);
  await r.clock.advance(400);
  const s = host.snapshot();
  assert.deepEqual(s.fun.frozen, [2]);
  assert.equal(s.state.duel.iced, 2);
  assert.deepEqual(seen, [
    [0, 1],
    [2, 1],
  ]);
  assert.equal(r.engines[2].snapshot().fun.frozen.includes(2), true);
  host.act({ type: 'thaw', slot: 2 });
  await r.clock.advance(400);
  assert.deepEqual(r.engines[2].snapshot().fun.frozen, []);
});

test('peek shows a hint only to the player who played it', async () => {
  const r = await started(duel({ cards: ['peek'] }));
  const [, a, b] = r.engines;
  const got = [];
  const other = [];
  a.on('hint', (x) => got.push(x.text));
  b.on('hint', (x) => other.push(x.text));
  assert.equal(a.play('peek'), true);
  await r.clock.advance(500);
  assert.deepEqual(got, ['It starts with B']);
  assert.deepEqual(other, []);
  assert.equal(a.snapshot().fun.used, true);
});

test('a late joiner is dealt a card too', async () => {
  const r = await started(duel({ cards: ['double'] }), 2);
  const late = r.add(3);
  await r.clock.advance(800);
  assert.equal(late.snapshot().meJoined, true);
  assert.equal(late.snapshot().fun.card.id, 'double');
});

test('the card tray opens, lists freeze targets and plays the card', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createParty, dockModel } = await import('../web/activity/js/ui/party.js');
  const r = await started(duel({ cards: ['freeze'] }));
  const a = r.engines[1];
  const m = dockModel(a.snapshot(), { cardOpen: true });
  assert.equal(m.card.id, 'freeze');
  assert.deepEqual(
    m.card.targets.map((t) => t.slot),
    [0, 2],
  );
  const timers = [];
  const win = { innerWidth: 400, setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length, clearTimeout() {} };
  const plays = [];
  const engine = { on: a.on, snapshot: a.snapshot, react: () => true, play: (id, to) => plays.push([id, to]) && a.play(id, to) };
  const party = createParty({ engine, win, sfx: null, toast: null });
  document.body.append(party.el);
  party.update(a.snapshot());
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
  find('chaos-card').click();
  find('card-to-2').click();
  assert.deepEqual(plays, [['freeze', 2]]);
  await r.clock.advance(500);
  party.update(a.snapshot());
  assert.equal(find('chaos-card'), null, 'the card leaves the tray once played');
  party.destroy();
});

test('swap only trades with someone still in the game', async () => {
  const r = await started(duel({ cards: ['swap'] }));
  const [host, a, b] = r.engines;
  host.act({ type: 'score', n: 50 });
  a.act({ type: 'score', n: 500 });
  b.act({ type: 'score', n: 10 });
  await r.clock.advance(400);
  r.hub.leave(a.snapshot().me);
  a.destroy();
  await r.clock.advance(1500);
  assert.equal(b.play('swap'), true);
  await r.clock.advance(400);
  const g = host.snapshot().scores.g;
  assert.equal(g[2], 50);
  assert.equal(g[0], 10);
  assert.equal(g[1], 500);
});
