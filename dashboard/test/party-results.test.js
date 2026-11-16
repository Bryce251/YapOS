import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { DAILY_XP_CAP, PLAY_XP, WIN_XP, favouriteGame } from '../worker/party-results.js';
import { PARTY_BADGES, BADGE_IDS, badgesFor } from '../worker/party-badges.js';

const uid = (i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;

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

function send(h, body, { ip = '198.51.100.20', origin } = {}) {
  const headers = { Origin: origin === undefined ? h.base : origin };
  if (headers.Origin === null) delete headers.Origin;
  return h.request('POST', '/api/activity/results', { headers, body, ip });
}

const xpRows = (h) => h.db.raw.prepare('SELECT * FROM party_xp ORDER BY at ASC, id ASC').all();
const statRow = (h, id) => h.db.raw.prepare('SELECT * FROM party_stats WHERE user_id = ?').get(id);

test('a finished game updates stats for every player and queues Party XP', async () => {
  const h = party();
  const res = await send(h, result(h));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.counted, true);
  assert.deepEqual(body.xp, [{ id: uid(1), xp: PLAY_XP + WIN_XP }, { id: uid(2), xp: PLAY_XP }]);
  const pip = statRow(h, uid(1));
  assert.equal(pip.games, 1);
  assert.equal(pip.wins, 1);
  assert.deepEqual(JSON.parse(pip.by_game), { trivia: { p: 1, w: 1 } });
  const juno = statRow(h, uid(2));
  assert.equal(juno.wins, 0);
  const rows = xpRows(h);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].claimed, 0);
  assert.equal(rows[0].day, '2026-11-12');
});

test('solo games are not counted', async () => {
  const h = party();
  const body = result(h);
  body.players = body.players.slice(0, 1);
  const res = await send(h, body);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, counted: false, reason: 'solo' });
  assert.equal(xpRows(h).length, 0);
});

test('the same result posted twice within two minutes counts once', async () => {
  const h = party();
  assert.equal((await send(h, result(h))).status, 201);
  advance(h, 30 * 1000);
  const again = await send(h, result(h, { at: h.clock.t }));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(statRow(h, uid(1)).games, 1);
  advance(h, 3 * MIN);
  assert.equal((await send(h, result(h, { at: h.clock.t }))).status, 201);
  assert.equal(statRow(h, uid(1)).games, 2);
});

test('bad results are refused with a plain reason', async () => {
  const h = party();
  const cases = [
    [{ game: 'chess' }, 'bad_game'],
    [{ at: h.clock.t - 2 * 24 * 60 * MIN }, 'bad_time'],
    [{ at: 'soon' }, 'bad_time'],
    [{ players: [] }, 'bad_players'],
    [{ players: Array.from({ length: 17 }, (_, i) => ({ id: uid(i + 1), name: 'P', score: 1, won: false })) }, 'bad_players'],
    [{ players: [{ id: uid(1), name: 'A', score: 1 }, { id: uid(1), name: 'B', score: 2 }] }, 'bad_players'],
    [{ players: [{ id: 'bad id!', name: 'A', score: 1 }, { id: uid(2), name: 'B', score: 2 }] }, 'bad_id'],
    [{ players: [{ id: uid(1), name: 'A', score: Infinity }, { id: uid(2), name: 'B', score: 2 }] }, 'bad_score'],
    [{ players: [{ id: uid(1), name: 'A', score: '5' }, { id: uid(2), name: 'B', score: 2 }] }, 'bad_score'],
    [{ players: [{ id: uid(1), name: 'A', score: 5, won: 'yes' }, { id: uid(2), name: 'B', score: 2 }] }, 'bad_won'],
    [{ extra: [] }, 'bad_extra'],
    [{ extra: { fakerCaught: 'everyone' } }, 'bad_extra'],
  ];
  for (const [over, code] of cases) {
    const res = await send(h, result(h, over), { ip: `198.51.100.${cases.findIndex((c) => c[0] === over) + 40}` });
    assert.equal(res.status, 400, code);
    assert.equal((await res.json()).error, code);
  }
  assert.equal(xpRows(h).length, 0);
});

test('results need the site origin and are rate limited per address', async () => {
  const h = party();
  assert.equal((await send(h, result(h), { origin: null })).status, 403);
  assert.equal((await send(h, result(h), { origin: 'https://evil.example' })).status, 403);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await send(h, result(h, { players: [{ id: uid(1), name: 'A', score: i, won: true }, { id: uid(2), name: 'B', score: 0, won: false }] }));
  }
  assert.equal(last.status, 429);
});

test('Party XP stops at the daily cap and starts again the next UTC day', async () => {
  const h = party();
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    advance(h, 3 * MIN);
    const res = await send(h, result(h, { at: h.clock.t, players: [{ id: uid(1), name: 'A', score: i, won: true }, { id: uid(2), name: 'B', score: 0, won: false }] }), { ip: `198.51.100.${60 + i}` });
    const body = await res.json();
    total += body.xp.filter((x) => x.id === uid(1)).reduce((s, x) => s + x.xp, 0);
  }
  assert.equal(total, DAILY_XP_CAP);
  assert.equal(statRow(h, uid(1)).games, 12);
  h.clock.t = Date.UTC(2026, 10, 13, 0, 5);
  const next = await (await send(h, result(h, { at: h.clock.t }))).json();
  assert.equal(next.xp.find((x) => x.id === uid(1)).xp, PLAY_XP + WIN_XP);
});

test('party-banned players keep stats but get no Party XP', async () => {
  const h = party();
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'Juno', NULL, NULL, ?, 1)").run(uid(2), USERS.alice.id);
  const body = await (await send(h, result(h))).json();
  assert.deepEqual(body.xp.map((x) => x.id), [uid(1)]);
  assert.equal(statRow(h, uid(2)).games, 1);
});

test('extra counters only count for their own game and only for listed players', async () => {
  const h = party();
  const odd = result(h, { game: 'odd', extra: { fakerCaught: [uid(1), uid(1).toUpperCase(), uid(9), 42], pangram: [uid(2)] } });
  assert.equal((await send(h, odd)).status, 201);
  assert.deepEqual(JSON.parse(statRow(h, uid(1)).counters), { fakerCaught: 1 });
  assert.deepEqual(JSON.parse(statRow(h, uid(2)).counters), {});
});

test('the bot poll carries Party XP and open reports, and ack marks them claimed', async () => {
  const h = party();
  await send(h, result(h));
  h.db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, reporter_id, reporter_name, ink, at, created, ip_hash, status) VALUES ('r1', 'draw', ?, 'A', ?, 'B', '[]', 1, 1, 'x', 'open')").run(uid(3), uid(4));
  const polled = await h.poll();
  assert.equal(polled.party.reportsOpen, 1);
  assert.equal(polled.party.xp.length, 2);
  assert.deepEqual(Object.keys(polled.party.xp[0]).sort(), ['game', 'id', 'user', 'won', 'xp']);
  const first = polled.party.xp.find((x) => x.user === uid(1));
  assert.equal(first.won, true);
  assert.equal(first.game, 'trivia');
  const ack = await h.bot('POST', '/bot/party/ack', { ids: polled.party.xp.map((x) => x.id).concat(['nope']) });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { ok: true, acked: 2 });
  assert.equal((await h.poll()).party.xp.length, 0);
  assert.equal((await h.bot('POST', '/bot/party/ack', { ids: 'x' })).status, 400);
  assert.equal((await h.bot('POST', '/bot/party/ack', { ids: [] }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
});

test('the poll hands out at most 100 Party XP rows, oldest first', async () => {
  const h = party();
  const stmt = h.db.raw.prepare("INSERT INTO party_xp (id, user_id, xp, game, won, day, at, claimed) VALUES (?, ?, 10, 'trivia', 0, '2026-11-12', ?, 0)");
  for (let i = 0; i < 130; i += 1) stmt.run(`x${String(i).padStart(4, '0')}`, uid(1), 1000 + i);
  const { party: p } = await h.poll();
  assert.equal(p.xp.length, 100);
  assert.equal(p.xp[0].id, 'x0000');
});

test('the bot can read Party stats with favourite game and badges', async () => {
  const h = party();
  for (let i = 0; i < 10; i += 1) {
    advance(h, 3 * MIN);
    await send(h, result(h, { game: i < 6 ? 'odd' : 'draw', at: h.clock.t, players: [{ id: uid(1), name: 'A', score: i, won: true }, { id: uid(2), name: 'B', score: 0, won: false }], extra: { fakerCaught: [uid(1)] } }), { ip: `198.51.100.${100 + i}` });
  }
  h.db.raw.prepare("INSERT INTO party_daily_streaks (user_id, last_day, streak, best, updated) VALUES (?, '2026-11-12', 7, 7, 1)").run(uid(1));
  const res = await h.bot('GET', `/bot/party/stats?ids=${uid(1)},${uid(2)},${uid(9)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.stats).sort(), [uid(1), uid(2)]);
  const a = body.stats[uid(1)];
  assert.equal(a.games, 10);
  assert.equal(a.wins, 10);
  assert.equal(a.fav, 'odd');
  assert.deepEqual(a.byGame, { odd: { p: 6, w: 6 }, draw: { p: 4, w: 4 } });
  assert.deepEqual(a.badges, ['first-game', 'games-10', 'wins-10', 'daily-7']);
  assert.deepEqual(body.stats[uid(2)].badges, ['first-game', 'games-10']);
  assert.equal(body.badges.length, PARTY_BADGES.length);
  assert.equal((await h.bot('GET', '/bot/party/stats?ids=')).status, 400);
  const many = Array.from({ length: 26 }, (_, i) => uid(i + 1)).join(',');
  assert.equal((await h.bot('GET', `/bot/party/stats?ids=${many}`)).status, 400);
  assert.equal((await h.request('GET', `/bot/party/stats?ids=${uid(1)}`)).status, 401);
});

test('badge rules and the favourite game are worked out from the counters', () => {
  assert.equal(new Set(BADGE_IDS).size, BADGE_IDS.length);
  for (const b of PARTY_BADGES) {
    assert.ok(b.label && b.emoji && b.hint, b.id);
  }
  assert.deepEqual(badgesFor({ games: 0, wins: 0, counters: {} }), []);
  assert.deepEqual(
    badgesFor({ games: 100, wins: 50, counters: { fakerCaught: 10, pangram: 5, topTake: 3, fastest: 5 }, dailyBest: 7 }),
    BADGE_IDS.slice(),
  );
  assert.deepEqual(badgesFor({ games: 9, wins: 9, counters: { fakerCaught: 9, pangram: 4, topTake: 2, fastest: 4 }, dailyBest: 6 }), ['first-game']);
  assert.equal(favouriteGame({}), null);
  assert.equal(favouriteGame({ hive: { p: 3, w: 0 }, draw: { p: 3, w: 1 } }), 'draw');
  assert.equal(favouriteGame({ hive: { p: 3, w: 1 }, draw: { p: 3, w: 1 } }), 'draw');
});

test('cleanup drops old dedupe rows and claimed Party XP', async () => {
  const h = party();
  await send(h, result(h));
  const polled = await h.poll();
  await h.bot('POST', '/bot/party/ack', { ids: polled.party.xp.map((x) => x.id) });
  advance(h, 3 * 24 * 60 * MIN);
  await h.worker.scheduled({}, h.env, { waitUntil() {} });
  assert.equal(xpRows(h).length, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_results').get().n, 0);
  assert.equal(statRow(h, uid(1)).games, 1);
});

test('the daily Party XP cap holds across many results from many addresses', async () => {
  const h = party();
  const sends = [];
  for (let i = 0; i < 20; i += 1) {
    const body = result(h, {
      players: [
        { id: uid(1), name: 'Pip', username: null, score: 900 + i, won: true, team: null },
        { id: uid(100 + i), name: 'Other', username: null, score: i, won: false, team: null },
      ],
    });
    sends.push(send(h, body, { ip: `198.51.100.${40 + i}` }));
  }
  await Promise.all(sends);
  const total = h.db.raw.prepare('SELECT SUM(xp) AS n FROM party_xp WHERE user_id = ?').get(uid(1)).n;
  assert.equal(total, DAILY_XP_CAP);
});

test('the same result sent twice is only counted once', async () => {
  const h = party();
  const [a, b] = await Promise.all([send(h, result(h)), send(h, result(h), { ip: '198.51.100.21' })]);
  const counted = [await a.json(), await b.json()].filter((r) => r.counted).length;
  assert.equal(counted, 1);
  assert.equal(statRow(h, uid(1)).games, 1);
  assert.equal(xpRows(h).length, 2);
});
