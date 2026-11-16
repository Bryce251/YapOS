import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { DEFAULT_RATES, RATE_BOUNDS, clampRates, shardStatement } from '../worker/party-shards.js';
import { utcDay } from '../worker/party-results.js';

const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function party() {
  return createHarness({ PARTY_OWNER_ID: USERS.alice.id });
}

function result(h, over = {}) {
  return {
    game: 'trivia',
    at: h.clock.t,
    players: [
      { id: uid(1), name: 'Pip', username: 'pipsqueak', score: 900, won: true, team: null },
      { id: uid(2), name: 'Juno', username: null, score: 400, won: false, team: null },
    ],
    extra: {},
    ...over,
  };
}

let n = 0;
function send(h, body, ip) {
  n += 1;
  return h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body, ip: ip || `198.51.100.${(n % 200) + 1}` });
}

const rows = (h) => h.db.raw.prepare('SELECT * FROM party_shards ORDER BY at ASC, reason ASC, user_id ASC').all();
const total = (h, id) => h.db.raw.prepare('SELECT COALESCE(SUM(shards), 0) AS n FROM party_shards WHERE user_id = ?').get(id).n;

test('playing and winning a Party game queues Shards with the default rates', async () => {
  const h = party();
  const res = await send(h, result(h));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.shards, [
    { id: uid(1), shards: DEFAULT_RATES.play, reason: 'play' },
    { id: uid(1), shards: DEFAULT_RATES.win, reason: 'win' },
    { id: uid(2), shards: DEFAULT_RATES.play, reason: 'play' },
  ]);
  assert.equal(total(h, uid(1)), 20);
  assert.equal(total(h, uid(2)), 5);
  const r = rows(h);
  assert.ok(r.every((x) => x.game === 'trivia' && x.claimed === 0 && x.day === utcDay(h.clock.t)));
});

test('solo games and duplicates earn no Shards', async () => {
  const h = party();
  const solo = result(h);
  solo.players = solo.players.slice(0, 1);
  assert.equal((await send(h, solo)).status, 200);
  assert.equal(rows(h).length, 0);
  await send(h, result(h));
  const again = await send(h, result(h));
  assert.equal((await again.json()).duplicate, true);
  assert.equal(rows(h).length, 3);
});

test('the tournament winner earns the tournament bonus, and only a real player can win it', async () => {
  const h = party();
  const res = await send(h, result(h, { extra: { tournament: { winner: uid(2).toUpperCase() } } }));
  const body = await res.json();
  assert.ok(body.shards.some((s) => s.id === uid(2) && s.reason === 'tournament' && s.shards === DEFAULT_RATES.tournament));
  advance(h, 3 * MIN);
  const outsider = await send(h, result(h, { at: h.clock.t, extra: { tournament: { winner: uid(9) } } }));
  assert.equal((await outsider.json()).shards.some((s) => s.reason === 'tournament'), false);
  for (const bad of [{ tournament: 'x' }, { tournament: { winner: 5 } }, { tournament: [] }]) {
    advance(h, 3 * MIN);
    const r = await send(h, result(h, { at: h.clock.t, extra: bad }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'bad_extra');
  }
});

test('right predictions earn Shards, wrong ones cost nothing, and the Worker checks who really won', async () => {
  const h = party();
  const predictions = [
    { id: uid(10), name: 'Mila', username: 'milawaves', pick: uid(1), right: true },
    { id: uid(11), name: 'Rex', username: null, pick: uid(2), right: false },
    { id: uid(12), name: 'Liar', username: null, pick: uid(2), right: true },
    { id: uid(10), name: 'Mila again', username: null, pick: uid(1), right: true },
    { id: uid(13), name: 'Nobody', username: null, pick: uid(99), right: true },
  ];
  const res = await send(h, result(h, { predictions }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const pred = body.shards.filter((s) => s.reason === 'prediction');
  assert.deepEqual(pred, [{ id: uid(10), shards: DEFAULT_RATES.prediction, reason: 'prediction' }]);
  assert.equal(total(h, uid(11)), 0);
  assert.equal(total(h, uid(12)), 0);
  assert.equal(total(h, uid(13)), 0);
});

test('bad predictions are refused and banned watchers earn nothing', async () => {
  const h = party();
  const many = Array.from({ length: 17 }, (_, i) => ({ id: uid(20 + i), name: 'W', pick: uid(1), right: true }));
  const cases = [many, 'nope', [{ id: 'bad id', pick: uid(1) }], [{ id: uid(5), pick: 7 }], [{ id: uid(5), pick: uid(1), right: 'yes' }], ['junk']];
  for (const predictions of cases) {
    advance(h, 3 * MIN);
    const r = await send(h, result(h, { at: h.clock.t, predictions }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'bad_predictions');
  }
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'Bad', NULL, NULL, 'x', 0)").run(uid(30));
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'Bad', NULL, NULL, 'x', 0)").run(uid(2));
  advance(h, 3 * MIN);
  const res = await send(h, result(h, { at: h.clock.t, predictions: [{ id: uid(30), name: 'B', pick: uid(1), right: true }] }));
  const body = await res.json();
  assert.equal(body.shards.some((s) => s.id === uid(30) || s.id === uid(2)), false);
});

test('Party Shards stop at the daily cap and start again the next UTC day', async () => {
  const h = party();
  for (let i = 0; i < 10; i += 1) {
    advance(h, 3 * MIN);
    await send(h, result(h, { at: h.clock.t, extra: { tournament: { winner: uid(1) } } }));
  }
  assert.equal(total(h, uid(1)), DEFAULT_RATES.cap);
  assert.equal(total(h, uid(2)), 50);
  advance(h, DAY);
  await send(h, result(h, { at: h.clock.t }));
  const today = h.db.raw.prepare('SELECT COALESCE(SUM(shards), 0) AS n FROM party_shards WHERE user_id = ? AND day = ?').get(uid(1), utcDay(h.clock.t)).n;
  assert.equal(today, 20);
});

test('the cap is enforced in SQL even when two writers race', async () => {
  const h = party();
  const day = utcDay(h.clock.t);
  const stmts = [];
  for (let i = 0; i < 5; i += 1) stmts.push(shardStatement(h.db, { id: uid(1), reason: 'win', shards: 40 }, 'trivia', day, h.clock.t, 150));
  await h.db.batch(stmts);
  assert.equal(total(h, uid(1)), 150);
  const amounts = rows(h).map((r) => r.shards);
  assert.deepEqual(amounts.sort((a, b) => a - b), [30, 40, 40, 40]);
});

test('the bot polls Party Shards and acks them with shardIds', async () => {
  const h = party();
  await send(h, result(h));
  const polled = await h.poll();
  assert.equal(polled.party.shards.length, 3);
  const first = polled.party.shards[0];
  assert.deepEqual(Object.keys(first).sort(), ['game', 'id', 'reason', 'shards', 'user']);
  assert.equal(first.game, 'trivia');
  const ack = await h.bot('POST', '/bot/party/ack', { shardIds: polled.party.shards.map((s) => s.id).concat(['nope']) });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { ok: true, acked: 0, shardsAcked: 3 });
  assert.equal((await h.poll()).party.shards.length, 0);
  const both = await h.bot('POST', '/bot/party/ack', { ids: [], shardIds: [] });
  assert.deepEqual(await both.json(), { ok: true, acked: 0, shardsAcked: 0 });
  assert.equal((await h.bot('POST', '/bot/party/ack', {})).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/ack', { shardIds: 'x' })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/ack', { shardIds: Array(501).fill('a') })).status, 413);
});

test('the owner rates come from the bot, are clamped, and change what games pay', async () => {
  const h = party();
  const get = await h.bot('GET', '/bot/party/rates');
  assert.deepEqual((await get.json()).rates, DEFAULT_RATES);
  const set = await h.bot('POST', '/bot/party/rates', { play: 2, win: 9999, tournament: -5, prediction: 3.6, cap: 40 });
  assert.equal(set.status, 200);
  const { rates } = await set.json();
  assert.deepEqual(rates, { play: 2, win: RATE_BOUNDS.win[1], tournament: 0, prediction: 4, cap: 40 });
  const partial = await (await h.bot('POST', '/bot/party/rates', { play: 3 })).json();
  assert.equal(partial.rates.play, 3);
  assert.equal(partial.rates.cap, 40);
  assert.equal((await h.bot('POST', '/bot/party/rates', { bogus: 1 })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/rates', { play: '5' })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/rates', { play: 5 }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  assert.equal((await h.request('POST', '/bot/party/rates', { body: { play: 5 } })).status, 401);
  const body = await (await send(h, result(h, { extra: { tournament: { winner: uid(1) } } }))).json();
  assert.equal(total(h, uid(1)), 40);
  assert.equal(body.shards.filter((s) => s.id === uid(1)).reduce((a, s) => a + s.shards, 0), 40);
  assert.equal(body.shards.some((s) => s.reason === 'tournament'), false);
});

test('rates are clamped to sane bounds', () => {
  assert.deepEqual(clampRates({}), DEFAULT_RATES);
  assert.deepEqual(clampRates({ play: 1e9, win: -1, tournament: NaN, prediction: 2, cap: 5000 }), { play: 50, win: 0, tournament: 25, prediction: 2, cap: 1000 });
});

test('cleanup drops claimed Party Shards after two days and unclaimed ones after a month', async () => {
  const h = party();
  await send(h, result(h));
  const polled = await h.poll();
  await h.bot('POST', '/bot/party/ack', { shardIds: [polled.party.shards[0].id] });
  advance(h, 3 * DAY);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(rows(h).length, 2);
  advance(h, 30 * DAY);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(rows(h).length, 0);
});

test('a game where everyone won pays no win or prediction Shards', async () => {
  const h = party();
  const body = result(h, { predictions: [{ id: uid(40), name: 'W', pick: uid(2), right: true }] });
  body.players = body.players.map((p) => ({ ...p, won: true }));
  const res = await (await send(h, body)).json();
  assert.deepEqual(res.shards.map((s) => s.reason).sort(), ['play', 'play']);
});

test('a player listed as a watcher earns no prediction Shards', async () => {
  const h = party();
  const res = await (await send(h, result(h, { predictions: [{ id: uid(2), name: 'Juno', pick: uid(1), right: true }] }))).json();
  assert.equal(res.shards.some((s) => s.reason === 'prediction'), false);
});

test('tournament and prediction Shards have their own daily limits', async () => {
  const h = party();
  for (let i = 0; i < 14; i += 1) {
    advance(h, 3 * MIN);
    const players = [
      { id: uid(100 + i), name: 'A', username: null, score: 10, won: true, team: null },
      { id: uid(200 + i), name: 'B', username: null, score: 5, won: false, team: null },
    ];
    await send(h, { game: 'trivia', at: h.clock.t, players, extra: { tournament: { winner: uid(100 + i) } }, predictions: [{ id: uid(50), name: 'W', pick: uid(100 + i), right: true }] });
  }
  const count = (reason, id) => h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_shards WHERE reason = ? AND user_id = ?').get(reason, id).n;
  assert.equal(count('prediction', uid(50)), 10);
  const day = utcDay(h.clock.t);
  const stmts = [];
  for (let i = 0; i < 5; i += 1) stmts.push(shardStatement(h.db, { id: uid(60), reason: 'tournament', shards: 1 }, 'trivia', day, h.clock.t, 150));
  await h.db.batch(stmts);
  assert.equal(count('tournament', uid(60)), 3);
});
