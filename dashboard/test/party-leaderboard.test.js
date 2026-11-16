import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { DAILY_POINTS_CAP, DAILY_GAMES_CAP, DEFAULT_POINT_CAP, POINT_CAPS, LEADERBOARD_GAMES, countedPoints, pointCap, parseLeaderboardQuery } from '../worker/party-leaderboard.js';
import { PARTY_GAMES } from '../worker/party-results.js';
import { cleanup } from '../worker/cron.js';

const uid = (i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;

function party() {
  return createHarness({ PARTY_OWNER_ID: USERS.alice.id });
}

function game(h, players, over = {}) {
  return { game: 'trivia', at: h.clock.t, players, extra: {}, ...over };
}

function p(i, score, won = false, extra = {}) {
  return { id: uid(i), name: `Player ${i}`, username: `player${i}`, score, won, team: null, ...extra };
}

async function send(h, body, ip = '198.51.100.20') {
  const res = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body, ip });
  advance(h, 3 * MIN);
  return res;
}

async function board(h, query = '', ip = '198.51.100.30') {
  const res = await h.request('GET', `/api/activity/leaderboard${query}`, { ip });
  return { res, body: await res.json() };
}

const row = (h, id) => h.db.raw.prepare('SELECT * FROM party_points WHERE user_id = ?').get(id);
const gameRow = (h, id, g) => h.db.raw.prepare('SELECT * FROM party_points_game WHERE user_id = ? AND game = ?').get(id, g);

test('every result game has a leaderboard entry and sane caps', () => {
  assert.deepEqual([...LEADERBOARD_GAMES].sort(), [...PARTY_GAMES].sort());
  for (const g of LEADERBOARD_GAMES) {
    assert.ok(pointCap(g) >= DEFAULT_POINT_CAP);
    assert.ok(pointCap(g) <= DAILY_POINTS_CAP);
  }
  assert.equal(pointCap('reflex'), DEFAULT_POINT_CAP);
  assert.equal(pointCap('trivia'), POINT_CAPS.trivia);
  assert.equal(countedPoints('reflex', -40), 0);
  assert.equal(countedPoints('reflex', 10_000_000), DEFAULT_POINT_CAP);
  assert.equal(countedPoints('reflex', 812.7), 812);
});

test('an accepted game adds points, games, wins and best to both tables', async () => {
  const h = party();
  assert.equal((await send(h, game(h, [p(1, 900, true), p(2, 400)]))).status, 201);
  assert.equal((await send(h, game(h, [p(1, 300), p(2, 1200, true)], { game: 'draw' }))).status, 201);
  const a = row(h, uid(1));
  assert.equal(a.points, 1200);
  assert.equal(a.games, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.best, 900);
  assert.equal(a.best_game, 'trivia');
  const b = row(h, uid(2));
  assert.equal(b.points, 1600);
  assert.equal(b.best, 1200);
  assert.equal(b.best_game, 'draw');
  assert.equal(gameRow(h, uid(2), 'trivia').points, 400);
  assert.equal(gameRow(h, uid(2), 'draw').wins, 1);
});

test('solo, duplicate and rejected games add nothing', async () => {
  const h = party();
  await send(h, game(h, [p(1, 900, true)]));
  assert.equal(row(h, uid(1)), undefined);
  const body = game(h, [p(1, 900, true), p(2, 400)]);
  await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body });
  const dup = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body });
  assert.equal((await dup.json()).duplicate, true);
  assert.equal(row(h, uid(1)).games, 1);
  const bad = await h.request('POST', '/api/activity/results', { headers: { Origin: 'https://evil.example' }, body: game(h, [p(3, 5), p(4, 5)]) });
  assert.equal(bad.status, 403);
  assert.equal(row(h, uid(3)), undefined);
});

test('banned players earn nothing and never show up', async () => {
  const h = party();
  h.db.raw.prepare("INSERT INTO party_bans (id, banned_by, banned_at) VALUES (?, 'x', 0)").run(uid(2));
  await send(h, game(h, [p(1, 900, true), p(2, 4000)]));
  assert.equal(row(h, uid(2)), undefined);
  h.db.raw.prepare("INSERT INTO party_bans (id, banned_by, banned_at) VALUES (?, 'x', 0)").run(uid(1));
  const { body } = await board(h, `?me=${uid(1)}`);
  assert.equal(body.rows.length, 0);
  assert.equal(body.total, 0);
  assert.equal(body.me, null);
});

test('a single game is capped and a day is capped at the daily limit', async () => {
  const h = party();
  await send(h, game(h, [p(1, 9_000_000, true), p(2, 10)], { game: 'reflex' }));
  assert.equal(row(h, uid(1)).points, DEFAULT_POINT_CAP);
  assert.equal(row(h, uid(1)).best, DEFAULT_POINT_CAP);
  for (let i = 0; i < 5; i += 1) await send(h, game(h, [p(1, 9_000_000 + i, true), p(2, 10 + i)], { game: 'reflex' }));
  assert.equal(row(h, uid(1)).points, DAILY_POINTS_CAP);
  assert.equal(row(h, uid(1)).games, 6);
  assert.equal(gameRow(h, uid(1), 'reflex').points, DAILY_POINTS_CAP);
  const day = h.db.raw.prepare('SELECT points FROM party_points_day WHERE user_id = ?').get(uid(1));
  assert.equal(day.points, DAILY_POINTS_CAP);
  advance(h, 24 * 60 * MIN);
  await send(h, game(h, [p(1, 500, true), p(2, 10)], { game: 'reflex' }));
  assert.equal(row(h, uid(1)).points, DAILY_POINTS_CAP + 500);
  await cleanup(h.db, h.clock.t + 5 * 24 * 60 * MIN);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_points_day').get().n, 0);
});

test('the leaderboard ranks, ties, filters by game and pins the viewer', async () => {
  const h = party();
  await send(h, game(h, [p(1, 900, true), p(2, 400), p(3, 400)]));
  await send(h, game(h, [p(4, 2000, true), p(5, 100)], { game: 'hive' }));
  const { res, body } = await board(h, `?board=points&me=${uid(5)}&limit=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=30/);
  assert.equal(body.board, 'points');
  assert.equal(body.game, 'all');
  assert.equal(body.total, 5);
  assert.deepEqual(body.rows.map((r) => [r.rank, r.id, r.value]), [[1, uid(4), 2000], [2, uid(1), 900], [3, uid(2), 400]]);
  assert.deepEqual(body.me, { rank: 5, value: 100 });
  const top = body.rows[0];
  assert.equal(top.bestGame, 'hive');
  assert.equal(top.games, 1);
  assert.equal(top.wins, 1);
  assert.equal(top.link, false);
  assert.equal(top.avatar, null);
  const tie = await board(h, '?board=points&limit=5', '198.51.100.31');
  assert.deepEqual(tie.body.rows.map((r) => r.rank), [1, 2, 3, 3, 5]);
  const hive = await board(h, '?board=points&game=hive', '198.51.100.32');
  assert.deepEqual(hive.body.rows.map((r) => r.id), [uid(4), uid(5)]);
  assert.equal(hive.body.rows[0].name, 'Player 4');
  const wins = await board(h, `?board=wins&me=${uid(2)}`, '198.51.100.33');
  assert.deepEqual(wins.body.rows.map((r) => r.id), [uid(1), uid(4)].sort((a, b) => (a < b ? -1 : 1)));
  assert.equal(wins.body.me, null);
  const games = await board(h, '?board=games', '198.51.100.34');
  assert.equal(games.body.total, 5);
  const best = await board(h, '?board=best&game=trivia', '198.51.100.35');
  assert.equal(best.body.rows[0].value, 900);
});

test('the board is cached for about 30 seconds', async () => {
  const h = party();
  await send(h, game(h, [p(1, 900, true), p(2, 400)]));
  const first = await board(h);
  assert.equal(first.body.rows.length, 2);
  await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: game(h, [p(3, 5000, true), p(4, 1)]) });
  const cached = await board(h);
  assert.equal(cached.body.rows.length, 2);
  advance(h, 31 * 1000);
  const fresh = await board(h);
  assert.equal(fresh.body.rows.length, 4);
  assert.equal(fresh.body.rows[0].id, uid(3));
});

test('names are filtered, avatars come from the profile cache and hidden profiles get no link', async () => {
  const h = party();
  await send(h, game(h, [p(1, 900, true, { name: 'just 14/88 things' }), p(2, 400), p(3, 100, false, { username: 'pip' })]));
  const t = h.clock.t;
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(uid(2), 'player2', 'Two', 'https://files.yapper.website/a.png', t);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(uid(1), 'player1', 'One', 'https://evil.example/a.png', t);
  const pub = h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, 'x', 1, 1, NULL, '[]', '[]', '[]', NULL, ?, ?)");
  pub.run(uid(2), 'player2', 'player2', 0, t);
  pub.run(uid(1), 'player1', 'player1', 1, t);
  pub.run(uid(9), 'pip', 'pip', 0, t);
  const { body } = await board(h);
  const [one, two, three] = body.rows;
  assert.equal(one.name, 'One');
  assert.equal(one.username, null);
  assert.equal(one.avatar, null);
  assert.equal(one.link, false);
  assert.equal(two.avatar, 'https://files.yapper.website/a.png');
  assert.equal(two.link, true);
  assert.equal(two.username, 'player2');
  assert.equal(three.username, null);
  assert.equal(three.link, false);
  assert.equal(three.name, 'Player 3');
});

test('a forged result cannot rename a player who has a known profile', async () => {
  const h = party();
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?)').run(uid(1), 'realone', 'Real One', h.clock.t);
  await send(h, game(h, [p(1, 900, true, { name: 'Someone Else', username: 'jolli' }), p(2, 400)]));
  const { body } = await board(h);
  const one = body.rows.find((r) => r.id === uid(1));
  assert.equal(one.name, 'Real One');
  assert.equal(one.username, 'realone');
  const two = body.rows.find((r) => r.id === uid(2));
  assert.equal(two.username, null);
});

test('games and wins stop counting after the daily game limit', async () => {
  const h = party();
  for (let i = 0; i < DAILY_GAMES_CAP + 5; i += 1) {
    await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: game(h, [p(1, 10 + i, true), p(2, i)], { game: 'reflex' }), ip: `198.51.${100 + (i % 50)}.${i}` });
    advance(h, 1000);
  }
  assert.equal(row(h, uid(1)).games, DAILY_GAMES_CAP);
  assert.equal(row(h, uid(1)).wins, DAILY_GAMES_CAP);
  assert.equal(gameRow(h, uid(1), 'reflex').games, DAILY_GAMES_CAP);
  advance(h, 24 * 60 * MIN);
  await send(h, game(h, [p(1, 7, true), p(2, 1)], { game: 'reflex' }));
  assert.equal(row(h, uid(1)).games, DAILY_GAMES_CAP + 1);
  await cleanup(h.db, h.clock.t + 5 * 24 * 60 * MIN);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_games_day').get().n, 0);
});

test('bad queries are refused politely and the route is rate limited', async () => {
  const h = party();
  for (const q of ['?board=xp', '?game=chess', '?me=not%20an%20id']) {
    const { res, body } = await board(h, q);
    assert.equal(res.status, 400);
    assert.equal(typeof body.message, 'string');
  }
  assert.equal((await h.request('POST', '/api/activity/leaderboard', { headers: { Origin: h.base }, body: {} })).status, 405);
  assert.equal(parseLeaderboardQuery(new URL('https://x/?limit=999')).limit, 50);
  assert.equal(parseLeaderboardQuery(new URL('https://x/?limit=0')).limit, 1);
  assert.equal(parseLeaderboardQuery(new URL('https://x/')).limit, 20);
  let last = null;
  for (let i = 0; i < 125; i += 1) last = await h.request('GET', '/api/activity/leaderboard', { ip: '198.51.100.99' });
  assert.equal(last.status, 429);
});

test('the leaderboard page is served by the website', async () => {
  const h = party();
  const res = await h.request('GET', '/party/leaderboard');
  assert.notEqual(res.status, 404);
});

test('the in-call leaderboard opens, switches boards, filters games and closes on Esc', async () => {
  const { installDom, flush, fire, FakeEvent } = await import('./dom-shim.js');
  const { document } = installDom({ url: 'https://dash.example.test/activity/' });
  const ui = await import('../web/activity/js/ui/leaderboard.js');
  const { GAMES } = await import('../web/activity/js/games/index.js');
  const calls = [];
  let reply = () => ({ ok: true, status: 200, json: async () => ({
    board: 'points',
    game: 'all',
    rows: [
      { rank: 1, id: uid(1), name: 'Pip', username: 'pip', avatar: 'https://evil.example/x.png', value: 52000, games: 40, wins: 12, best: 9000, bestGame: 'trivia', link: true },
      { rank: 2, id: uid(2), name: '<b>Juno</b>', username: null, avatar: null, value: 41000, games: 30, wins: 3, best: 2000, bestGame: 'hive', link: false },
      { rank: 4, id: uid(5), name: 'Me', username: null, avatar: null, value: 12400, games: 9, wins: 1, best: 3000, bestGame: null, link: false },
    ],
    me: { rank: 143, value: 12400 },
    total: 200,
  }) });
  ui.resetLeaderboard();
  ui.configureLeaderboard({ fetch: async (url, init) => {
    calls.push({ url, init });
    return reply(url);
  }, now: () => 1000 });
  const host = document.createElement('div');
  document.body.append(host);
  const opener = document.createElement('button');
  host.append(opener);
  opener.focus();
  const view = ui.openLeaderboard(host, { engine: { snapshot: () => ({ me: uid(5).toUpperCase() }) } });
  await flush();
  assert.equal(calls[0].url, `/api/activity/leaderboard?board=points&game=all&limit=20&me=${uid(5)}`);
  assert.equal(calls[0].init.credentials, 'same-origin');
  const rows = view.el.querySelectorAll('.lb-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector('.lb-rank').textContent, '🥇');
  assert.equal(rows[2].querySelector('.lb-rank').textContent, '#4');
  assert.ok(rows[2].className.includes('is-me'));
  assert.ok(view.el.textContent.includes('<b>Juno</b>'));
  assert.equal(view.el.querySelectorAll('img').length, 0);
  assert.equal(view.el.querySelector('.lb-me').textContent, "You're #143 with 12,400 points");
  const options = view.el.querySelectorAll('option');
  assert.equal(options.length, GAMES.length + 1);
  assert.ok(options.some((o) => o.textContent === '🐝 Letter Hive'));
  const wins = view.el.querySelectorAll('.lb-tab').find((b) => b.textContent === 'Wins');
  fire(wins, 'click');
  await flush();
  assert.match(calls.at(-1).url, /board=wins/);
  const select = view.el.querySelector('.lb-game');
  select.value = 'hive';
  fire(select, 'change');
  await flush();
  assert.match(calls.at(-1).url, /board=wins&game=hive/);
  const n = calls.length;
  fire(wins, 'click');
  await view.show('wins', 'hive');
  assert.equal(calls.length, n);
  const esc = new FakeEvent('keydown', { key: 'Escape' });
  document.dispatchEvent(esc);
  assert.equal(view.closed, true);
  assert.equal(view.el.parentNode, null);
  ui.resetLeaderboard();
});

test('the in-call leaderboard shows friendly empty and error states', async () => {
  const { installDom, flush } = await import('./dom-shim.js');
  const { document } = installDom({ url: 'https://dash.example.test/activity/' });
  const ui = await import('../web/activity/js/ui/leaderboard.js');
  ui.resetLeaderboard();
  ui.configureLeaderboard({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ rows: [], me: null, total: 0 }) }) });
  const empty = ui.openLeaderboard(document.body, { me: { id: uid(7) } });
  await flush();
  assert.match(empty.el.textContent, /Nobody here yet/);
  assert.match(empty.el.querySelector('.lb-me').textContent, /not on this board yet/);
  empty.close();
  ui.resetLeaderboard();
  ui.configureLeaderboard({ fetch: async () => ({ ok: false, status: 429 }) });
  const busy = ui.openLeaderboard(document.body, {});
  await flush();
  assert.match(busy.el.textContent, /Lots of people are looking/);
  assert.equal(busy.el.querySelector('.lb-me').textContent, '');
  busy.close();
  ui.resetLeaderboard();
  ui.configureLeaderboard({ fetch: async () => { throw new Error('down'); } });
  const down = ui.openLeaderboard(document.body, {});
  await flush();
  assert.match(down.el.textContent, /Couldn't load the leaderboard/);
  down.close();
  assert.equal(ui.meLine('wins', { rank: 2, value: 1 }), "You're #2 with 1 win");
  assert.equal(ui.boardUrl('best', 'draw', 'bad id!'), '/api/activity/leaderboard?board=best&game=draw&limit=20');
  ui.resetLeaderboard();
});

test('the dev server seeds a sample party leaderboard', async () => {
  const { seedPartyLeaderboard } = await import('../dev.mjs');
  const h = party();
  seedPartyLeaderboard(h.db, h.clock.t);
  const { res, body } = await board(h, '?board=points&limit=20', '198.51.100.70');
  assert.equal(res.status, 200);
  assert.equal(body.rows.length, 20);
  assert.ok(body.total >= 30);
  for (let i = 1; i < body.rows.length; i += 1) assert.ok(body.rows[i - 1].value >= body.rows[i].value);
  const hive = await board(h, '?board=best&game=hive', '198.51.100.71');
  assert.ok(hive.body.rows.length > 0);
});
