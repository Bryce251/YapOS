import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { DEFAULT_RATES, RATE_BOUNDS, PAY_GAP_MS, clampRates, shardStatement, streakShards, DAILY_PUZZLE_SHARDS } from '../worker/party-shards.js';
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
  assert.equal(total(h, uid(1)), DEFAULT_RATES.play + DEFAULT_RATES.win);
  assert.equal(total(h, uid(2)), DEFAULT_RATES.play);
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

test('Party Shards have no daily cap, so every paced game keeps paying all day', async () => {
  const h = party();
  for (let i = 0; i < 40; i += 1) {
    advance(h, 3 * MIN);
    const g = result(h, { at: h.clock.t, extra: { tournament: { winner: uid(1) } } });
    g.players[0].won = i % 2 === 0;
    g.players[1].won = i % 2 === 1;
    g.players[0].score = 900 + i;
    await send(h, g);
  }
  const day = utcDay(h.clock.t);
  const today = (id) => h.db.raw.prepare('SELECT COALESCE(SUM(shards), 0) AS n FROM party_shards WHERE user_id = ? AND day = ?').get(id, day).n;
  const tours = h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_shards WHERE user_id = ? AND reason = 'tournament'").get(uid(1)).n;
  assert.equal(tours, 10);
  assert.equal(today(uid(2)), 40 * DEFAULT_RATES.play + 20 * DEFAULT_RATES.win);
  assert.ok(today(uid(1)) > 150);
  assert.equal(today(uid(1)), 40 * DEFAULT_RATES.play + 20 * DEFAULT_RATES.win + tours * DEFAULT_RATES.tournament);
});

test('games closer together than the pay gap pay nothing extra, even when two writers race', async () => {
  const h = party();
  const day = utcDay(h.clock.t);
  const stmts = [];
  for (let i = 0; i < 5; i += 1) stmts.push(shardStatement(h.db, { id: uid(1), reason: 'win', shards: 40 }, 'trivia', day, h.clock.t));
  await h.db.batch(stmts);
  assert.equal(total(h, uid(1)), 40);
  await send(h, result(h));
  advance(h, PAY_GAP_MS.play / 2);
  const quick = result(h, { at: h.clock.t });
  quick.players[0].score = 901;
  const fast = await (await send(h, quick)).json();
  assert.equal(fast.counted, true);
  assert.deepEqual(fast.shards, []);
  advance(h, PAY_GAP_MS.play);
  const later = result(h, { at: h.clock.t });
  later.players[0].score = 902;
  const ok = await (await send(h, later)).json();
  assert.equal(ok.shards.filter((s) => s.reason === 'play').length, 2);
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
  assert.deepEqual(rates, { play: 2, win: RATE_BOUNDS.win[1], tournament: 0, prediction: 4 });
  const partial = await (await h.bot('POST', '/bot/party/rates', { play: 3 })).json();
  assert.equal(partial.rates.play, 3);
  assert.equal(partial.rates.win, RATE_BOUNDS.win[1]);
  assert.equal((await h.bot('POST', '/bot/party/rates', { bogus: 1 })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/rates', { play: '5' })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/rates', { play: 5 }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  assert.equal((await h.request('POST', '/bot/party/rates', { body: { play: 5 } })).status, 401);
  const body = await (await send(h, result(h, { extra: { tournament: { winner: uid(1) } } }))).json();
  assert.equal(total(h, uid(1)), 3 + RATE_BOUNDS.win[1]);
  assert.equal(body.shards.filter((s) => s.id === uid(1)).reduce((a, s) => a + s.shards, 0), 3 + RATE_BOUNDS.win[1]);
  assert.equal(body.shards.some((s) => s.reason === 'tournament'), false);
});

test('rates are clamped to sane bounds', () => {
  assert.deepEqual(clampRates({}), DEFAULT_RATES);
  assert.deepEqual(clampRates({ play: 1e9, win: -1, tournament: NaN, prediction: 2, cap: 5000 }), { play: RATE_BOUNDS.play[1], win: 0, tournament: DEFAULT_RATES.tournament, prediction: 2 });
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

test('tournament and prediction Shards are paced instead of capped', async () => {
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
  assert.equal(count('prediction', uid(50)), 14);
  const day = utcDay(h.clock.t);
  const stmts = [];
  for (let i = 0; i < 5; i += 1) stmts.push(shardStatement(h.db, { id: uid(60), reason: 'tournament', shards: 1 }, 'trivia', day, h.clock.t));
  await h.db.batch(stmts);
  assert.equal(count('tournament', uid(60)), 1);
  advance(h, PAY_GAP_MS.tournament + 1);
  await h.db.batch([shardStatement(h.db, { id: uid(60), reason: 'tournament', shards: 1 }, 'trivia', day, h.clock.t)]);
  assert.equal(count('tournament', uid(60)), 2);
});

test('the daily puzzle streak bonus grows and tops out', () => {
  assert.equal(streakShards(0), 0);
  assert.equal(streakShards(1), 0);
  assert.equal(streakShards(2), 10);
  assert.equal(streakShards(5), 25);
  assert.equal(streakShards(500), 50);
  assert.ok(DAILY_PUZZLE_SHARDS > 0);
});

test('a big Shards day raises a cheat alert and holds Party Shards until staff handle it', async () => {
  const { SHARDS_ALERT_DAY } = await import('../worker/party-shards.js');
  const h = party();
  const day = utcDay(h.clock.t);
  h.db.raw.prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run('seed1', uid(1), SHARDS_ALERT_DAY - 5, 'play', 'trivia', h.clock.t - 10 * MIN, day);
  const first = await (await send(h, result(h))).json();
  assert.ok(first.shards.some((s) => s.id === uid(1)));
  const alert = h.db.raw.prepare("SELECT * FROM party_cheat_alerts WHERE user_id = ? AND kind = 'shards_day'").get(uid(1));
  assert.ok(alert, 'crossing the daily alert line raises an alert');
  assert.equal(alert.status, 'open');
  advance(h, 3 * MIN);
  const before = total(h, uid(1));
  const second = await (await send(h, result(h, { players: [{ id: uid(1), name: 'Pip', username: null, score: 800, won: true, team: null }, { id: uid(2), name: 'Juno', username: null, score: 300, won: false, team: null }] }))).json();
  assert.deepEqual(second.held, [uid(1)]);
  assert.equal(total(h, uid(1)), before, 'held players earn nothing more');
  assert.ok(second.shards.some((s) => s.id === uid(2)), 'the other player still earns');
  h.db.raw.prepare("UPDATE party_cheat_alerts SET status = 'handled', handled_at = ? WHERE user_id = ?").run(h.clock.t, uid(1));
  advance(h, 3 * MIN);
  const third = await (await send(h, result(h, { players: [{ id: uid(1), name: 'Pip', username: null, score: 700, won: true, team: null }, { id: uid(2), name: 'Juno', username: null, score: 200, won: false, team: null }] }))).json();
  assert.ok(third.shards.some((s) => s.id === uid(1)), 'pay comes back once staff handle the alert');
});

test('farming one opponent puts Party Shards on hold', async () => {
  const h = party();
  const { CHEAT_PAIR_GAMES } = await import('../worker/party-cheats.js');
  for (let i = 0; i < CHEAT_PAIR_GAMES; i += 1) {
    advance(h, 40 * 1000);
    await send(h, result(h, { players: [{ id: uid(1), name: 'Pip', username: null, score: 900 + i, won: true, team: null }, { id: uid(2), name: 'Juno', username: null, score: 100, won: false, team: null }] }));
  }
  assert.ok(h.db.raw.prepare("SELECT 1 FROM party_cheat_alerts WHERE user_id = ? AND kind = 'farm' AND status = 'open'").get(uid(1)));
  advance(h, 40 * 1000);
  const body = await (await send(h, result(h, { players: [{ id: uid(1), name: 'Pip', username: null, score: 5000, won: true, team: null }, { id: uid(2), name: 'Juno', username: null, score: 100, won: false, team: null }] }))).json();
  assert.ok(body.held.includes(uid(1)));
  assert.ok(!body.shards.some((s) => s.id === uid(1)));
});
