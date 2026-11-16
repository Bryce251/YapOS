import test from 'node:test';
import assert from 'node:assert/strict';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine, cleanCode, cleanSetting, CODE_MAX, settingsFor } from '../web/activity/js/engine.js';
import { configureAdmins, resetAdmins, resultsBody, sendResults, partyXp, RESULTS_ENDPOINT, RESULT_PLAYERS_MAX, PARTY_XP_PLAY, PARTY_XP_WIN } from '../web/activity/js/admin.js';
import { catchersOf } from '../web/activity/js/games/odd.js';
import { fastestOf } from '../web/activity/js/games/reflex.js';
import { hiveResults } from '../web/activity/js/games/hive.js';
import { xpEarned, xpText } from '../web/activity/js/ui/results.js';

const ID = (n) => person(n).id;

function stubGame(over = {}) {
  return {
    id: 'trivia',
    name: 'Stub',
    emoji: '🧪',
    category: 'quiz',
    blurb: 'Stub game',
    minPlayers: 1,
    keys: ['stub'],
    settings: [{ id: 'pack', label: 'Pack code', type: 'code', default: '' }],
    start(api) {
      api.put('stub', { on: 1 });
      api.addPoints(0, 30);
      api.addPoints(1, 10);
    },
    intent() {},
    deadline(api) {
      api.finish();
    },
    resume() {},
    model() {
      return null;
    },
    results() {
      return { extra: { fakerCaught: [1, 7], 'bad key': [0] }, teams: { 0: 'Red', 1: 'Blue' } };
    },
    ...over,
  };
}

function party(count, game, posts) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(5);
  const engines = [];
  for (let i = 1; i <= count; i += 1) {
    const t = hub.join(person(i));
    const e = createEngine({ transport: t, games: [game], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: (b) => posts.push(b) });
    e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

test('the host posts results with scores, winners, teams and badge counters when a game ends', async () => {
  const posts = [];
  const r = party(3, stubGame(), posts);
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  assert.equal(host.lobby.end(), true);
  await r.clock.advance(300);
  assert.equal(posts.length, 1);
  const body = posts[0];
  assert.equal(body.game, 'trivia');
  assert.equal(typeof body.at, 'number');
  assert.equal(body.players.length, 3);
  assert.deepEqual(body.players[0], { id: ID(1), name: 'Player 1', username: null, score: 30, won: true, team: 'Red' });
  assert.equal(body.players[1].won, false);
  assert.equal(body.players[1].team, 'Blue');
  assert.equal(body.players[2].score, 0);
  assert.deepEqual(body.extra, { fakerCaught: [ID(2)] });
  for (const e of r.engines) {
    const last = e.snapshot().room.last;
    assert.deepEqual(last.ps.slice().sort(), [0, 1, 2]);
  }
  assert.ok(resultsBody(body));
});

test('a game with one player posts nothing and gives no Party XP', async () => {
  const posts = [];
  const r = party(1, stubGame({ start(api) { api.put('stub', { on: 1 }); api.addPoints(0, 5); } }), posts);
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(100);
  r.engines[0].lobby.end();
  await r.clock.advance(100);
  assert.equal(posts.length, 0);
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.last.ps, undefined);
  assert.equal(xpEarned(snap.room.last, snap.players), 0);
});

test('a broken results hook never stops the game from finishing', async () => {
  const posts = [];
  const r = party(2, stubGame({ results() { throw new Error('boom'); } }), posts);
  await r.clock.advance(500);
  r.engines[0].lobby.start();
  await r.clock.advance(100);
  r.engines[0].lobby.end();
  await r.clock.advance(100);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].extra, {});
});

test('results bodies are checked before they leave the activity', () => {
  const p = (n, extra = {}) => ({ id: ID(n), name: `P${n}`, username: null, score: n, won: false, team: null, ...extra });
  assert.equal(resultsBody({ game: 'nope', players: [p(1), p(2)] }), null);
  assert.equal(resultsBody({ game: 'hive', players: [p(1)] }), null);
  assert.equal(resultsBody({ game: 'hive', players: [p(1), p(1)] }), null);
  assert.equal(resultsBody({ game: 'hive', players: [p(1), { ...p(2), id: 'bad id!' }] }), null);
  const many = Array.from({ length: 30 }, (_, i) => p(i + 1));
  assert.equal(resultsBody({ game: 'hive', players: many }).players.length, RESULT_PLAYERS_MAX);
  const b = resultsBody({ game: 'hive', at: 5.4, players: [p(1, { score: 1e12, won: 'yes', username: '@cool name' }), p(2, { score: 'x', won: true, team: 'T'.repeat(80) })], extra: { pangram: [ID(1), ID(1), 'stranger'], 'no way': [ID(1)], list: 'x' } });
  assert.equal(b.at, 5);
  assert.equal(b.players[0].score, 1000000);
  assert.equal(b.players[0].won, false);
  assert.equal(b.players[0].username, 'coolname');
  assert.equal(b.players[1].score, 0);
  assert.equal(b.players[1].won, true);
  assert.equal(b.players[1].team.length, 24);
  assert.deepEqual(b.extra, { pangram: [ID(1)] });
});

test('sendResults posts to the results endpoint', async () => {
  const log = [];
  configureAdmins({ fetch: async (url, init) => { log.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) }; }, refreshMs: 0, win: null });
  try {
    const ok = await sendResults({ game: 'reflex', players: [{ id: ID(1), name: 'A', score: 3, won: true }, { id: ID(2), name: 'B', score: 1 }] });
    assert.equal(ok, true);
    assert.equal(log[0].url, RESULTS_ENDPOINT);
    assert.equal(log[0].init.method, 'POST');
    assert.equal(JSON.parse(log[0].init.body).players.length, 2);
    assert.equal(await sendResults({ game: 'reflex', players: [] }), false);
    assert.equal(log.length, 1);
  } finally {
    resetAdmins();
  }
});

test('games expose their badge counters', () => {
  assert.deepEqual(catchersOf({ 0: 2, 1: 2, 2: 0, 3: 1 }, 2).sort(), [0, 1]);
  assert.deepEqual(catchersOf({ 0: 2 }, null), []);
  assert.deepEqual(fastestOf({ 0: 300, 1: 250, 2: 250 }).sort(), [1, 2]);
  assert.deepEqual(fastestOf({}), []);
  assert.deepEqual(hiveResults({ phase: 'reveal', b: { 0: [10, 3, 1], 1: [4, 2, 0] } }), { extra: { pangram: [0] } });
  assert.deepEqual(hiveResults({ phase: 'reveal', daily: '2026-11-15', b: {} }), { extra: {}, daily: '2026-11-15' });
  assert.deepEqual(hiveResults({ phase: 'fail', daily: '2026-11-15', b: {} }), { extra: {} });
});

test('the results screen hints at the Party XP you earned', () => {
  const players = [{ isMe: true, slot: 1 }, { isMe: false, slot: 0 }];
  assert.equal(partyXp(false), PARTY_XP_PLAY);
  assert.equal(partyXp(true), PARTY_XP_PLAY + PARTY_XP_WIN);
  assert.equal(xpEarned({ ps: [0, 1], winners: [1] }, players), 25);
  assert.equal(xpEarned({ ps: [0, 1], winners: [0] }, players), 10);
  assert.equal(xpEarned({ ps: [0, 2], winners: [] }, players), 0);
  assert.equal(xpEarned({ winners: [1] }, players), 0);
  assert.equal(xpText(25), '+25 Party XP');
  assert.equal(xpText(0), '');
});

test('code settings keep only uppercase letters and digits, up to 12', async () => {
  assert.equal(cleanCode('ab-12 cd!'), 'AB12CD');
  assert.equal(cleanCode('x'.repeat(40)).length, CODE_MAX);
  assert.equal(cleanCode(''), '');
  assert.equal(cleanCode(42), undefined);
  const spec = { id: 'pack', type: 'code', default: '' };
  assert.equal(cleanSetting(spec, 'k7 q2'), 'K7Q2');
  assert.equal(cleanSetting({ ...spec, max: 4 }, 'abcdefg'), 'ABCD');
  assert.equal(cleanSetting(spec, null), undefined);
  const posts = [];
  const r = party(2, stubGame(), posts);
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.setting('pack', 'fun-pack 9'), true);
  await r.clock.advance(300);
  const g = r.engines[1].games[0];
  assert.equal(settingsFor(g, r.engines[1].snapshot().room).pack, 'FUNPACK9');
  assert.equal(r.engines[1].snapshot().settings.pack, 'FUNPACK9');
});

test('the lobby shows a code box the host can type into, and the results card shows Party XP', async () => {
  const { installDom, FakeEvent } = await import('./dom-shim.js');
  installDom({ url: 'https://yapos.dev/activity/' });
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const { createResults } = await import('../web/activity/js/ui/results.js');
  const posts = [];
  const r = party(2, stubGame(), posts);
  await r.clock.advance(500);
  const host = r.engines[0];
  const lobby = createLobby({ engine: host, toast() {}, sfx: { play() {} }, store: null });
  document.body.append(lobby.el);
  lobby.update(host.snapshot());
  const input = lobby.el.querySelector('.code-input');
  assert.ok(input);
  input.value = 'ab 12-cd';
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  assert.equal(input.value, 'AB12CD');
  input.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  await r.clock.advance(300);
  assert.equal(host.snapshot().settings.pack, 'AB12CD');
  const guest = createLobby({ engine: r.engines[1], toast() {}, sfx: { play() {} }, store: null });
  guest.update(r.engines[1].snapshot());
  assert.equal(guest.el.querySelector('.code-input'), null);
  assert.match(guest.el.querySelector('.code-value').textContent, /AB12CD/);
  host.lobby.start();
  await r.clock.advance(200);
  host.lobby.end();
  await r.clock.advance(300);
  const res = createResults({ engine: r.engines[0], fx: { confetti() {}, clear() {} } });
  res.update(r.engines[0].snapshot());
  assert.equal(res.el.querySelector('.xp-chip').textContent, '+25 Party XP');
  const res2 = createResults({ engine: r.engines[1], fx: { confetti() {}, clear() {} } });
  res2.update(r.engines[1].snapshot());
  assert.equal(res2.el.querySelector('.xp-chip').textContent, '+10 Party XP');
  lobby.destroy();
  guest.destroy();
  res.destroy();
  res2.destroy();
});
