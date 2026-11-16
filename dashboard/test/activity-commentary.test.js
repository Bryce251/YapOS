import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { createEngine } from '../web/activity/js/engine.js';
import { LINES, SAY_KINDS, LINE_GAP_MS, LINE_SHOW_MS, pickLine, fillLine } from '../web/activity/js/fun.js';
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

test('lines fill in names and never repeat back to back', () => {
  const memo = {};
  const random = seeded(9);
  let prev = null;
  for (let i = 0; i < 200; i += 1) {
    const kind = Object.keys(LINES)[i % Object.keys(LINES).length];
    const text = pickLine(kind, { a: 'Juno', b: 'Rex', n: 3 }, memo, random);
    assert.ok(text && !/\{[abn]\}/.test(text), text);
    assert.notEqual(text, prev);
    prev = text;
  }
  const streaks = new Set();
  for (let i = 0; i < 30; i += 1) streaks.add(pickLine('streak', { a: 'Juno', n: 4 }, memo, random));
  assert.ok(streaks.size >= 3, 'a varied line bank');
  assert.equal(fillLine('{a} vs {b} x{n}', { a: 'A' }), 'A vs Someone x');
});

test('the line bank is friendly and only about the game', () => {
  const all = Object.values(LINES).flat().join(' ').toLowerCase();
  for (const bad of ['stupid', 'dumb', 'idiot', 'ugly', 'loser', 'trash', 'fat', 'hate', 'shut up', 'suck']) assert.equal(all.includes(bad), false, bad);
  for (const kind of SAY_KINDS) assert.ok(kind === 'custom' || LINES[kind], kind);
  for (const lines of Object.values(LINES)) for (const l of lines) assert.ok(l.length <= 90, l);
});

test('a lead change shows a banner line after the scores settle', async () => {
  const r = await started(duel({ cards: undefined }));
  const [host, a] = r.engines;
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(1000);
  assert.equal(host.snapshot().fun.line, null, 'the first points are not a lead change');
  host.act({ type: 'score', n: 300 });
  await r.clock.advance(1000);
  const line = a.snapshot().fun.line;
  assert.equal(line.kind, 'lead');
  assert.equal(line.banner, true);
  assert.match(line.text, /Player 1/);
});

test('lines are spaced out, and the best one waits its turn', async () => {
  const r = await started(duel({ cards: undefined }));
  const [host, a, b] = r.engines;
  const seen = [];
  host.on('change', (s) => {
    const l = s.fun && s.fun.line;
    if (l && !seen.some((x) => x.i === l.i)) seen.push({ i: l.i, at: l.at, kind: l.kind });
  });
  a.act({ type: 'score', n: 10 });
  await r.clock.advance(800);
  b.act({ type: 'score', n: 20 });
  await r.clock.advance(800);
  a.act({ type: 'score', n: 30 });
  await r.clock.advance(800);
  b.act({ type: 'score', n: 40 });
  await r.clock.advance(800);
  host.act({ type: 'score', n: 500 });
  await r.clock.advance(8000);
  assert.ok(seen.length >= 2);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].at - seen[i - 1].at >= LINE_GAP_MS, 'max one line every few seconds');
  assert.equal(seen[seen.length - 1].kind, 'lead');
});

test('three scoring rounds in a row is a streak callout', async () => {
  const r = await started(duel({ cards: undefined }), 3);
  const [host, a] = r.engines;
  for (let i = 1; i <= 4; i += 1) {
    host.act({ type: 'round', i, of: 9 });
    a.act({ type: 'score', n: 10 });
    await r.clock.advance(4000);
  }
  host.act({ type: 'round', i: 5, of: 9 });
  await r.clock.advance(4000);
  const lines = [];
  for (let i = 6; i <= 7; i += 1) {
    a.act({ type: 'score', n: 10 });
    await r.clock.advance(200);
    host.act({ type: 'round', i, of: 9 });
    await r.clock.advance(300);
    lines.push(a.snapshot().fun.line);
  }
  assert.ok(lines.some((l) => l && l.kind === 'streak' && /Player 2/.test(l.text)), JSON.stringify(lines));
});

test('games can call api.say, custom text is cleaned, and unknown kinds are ignored', async () => {
  const said = [];
  const r = await started(
    duel({
      cards: undefined,
      intent(api, slot, a) {
        if (a.type === 'say') said.push(api.say(a.kind, a.data));
      },
    }),
  );
  const [host] = r.engines;
  host.act({ type: 'say', kind: 'nope', data: { slot: 1 } });
  host.act({ type: 'say', kind: 'custom', data: { text: 'see www.example.com now <@123>' } });
  await r.clock.advance(400);
  assert.deepEqual(said, [false, true]);
  const line = host.snapshot().fun.line;
  assert.equal(line.kind, 'custom');
  assert.equal(line.text.includes('example'), false);
  await r.clock.advance(4000);
  host.act({ type: 'say', kind: 'steal', data: { slot: 2 } });
  await r.clock.advance(400);
  assert.match(host.snapshot().fun.line.text, /Player 3/);
});

test('with host commentary off there are no callouts, but card plays still show', async () => {
  const r = await started(duel({ cards: ['double'] }), 3, { before: (x) => x.engines[0].lobby.party('drama', false) });
  const [host, a] = r.engines;
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(1000);
  host.act({ type: 'score', n: 300 });
  await r.clock.advance(1000);
  assert.equal(host.snapshot().fun.line, null);
  a.play('double');
  await r.clock.advance(400);
  assert.equal(host.snapshot().fun.line.kind, 'double');
});

test('the line shows once in the overlay with a sound for lead changes', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createParty, lineModel } = await import('../web/activity/js/ui/party.js');
  const r = await started(duel({ cards: undefined }));
  const [host, a] = r.engines;
  a.act({ type: 'score', n: 100 });
  await r.clock.advance(1000);
  host.act({ type: 'score', n: 300 });
  await r.clock.advance(1000);
  const snap = a.snapshot();
  assert.equal(lineModel(snap, snap.now).banner, true);
  assert.equal(lineModel(snap, snap.now + LINE_SHOW_MS + 1), null, 'old lines are not shown');
  const played = [];
  const party = createParty({ engine: a, win: { innerWidth: 900, setTimeout: () => 1, clearTimeout() {} }, sfx: { play: (n) => played.push(n) } });
  party.update(snap);
  party.update(snap);
  assert.deepEqual(played, ['turn']);
  party.destroy();
});
