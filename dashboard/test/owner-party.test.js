import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { awardMonth, monthOf, prevMonth, monthStart, nextMonth, MONTH_GRACE, LEADERBOARD_GAMES } from '../worker/party-leaderboard.js';
import { PARTY_OWNER_KINDS, PARTY_COUNTERS } from '../worker/owner-party.js';
import { OWNER_KINDS } from '../worker/owner.js';
import { PARTY_GAMES } from '../web/js/community-data.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
const XD = uid(1);
let ipSeq = 0;

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  const bob = (await h.login(BOB)).cookie;
  const real = h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 0, ?)');
  for (let i = 1; i <= 40; i++) real.run(uid(i), h.clock.t);
  return { h, owner, bob };
}

function seed(h, id, { points = 0, games = 0, wins = 0, best = 0, bestGame = null, name = 'Player', byGame = {}, month = 0 } = {}) {
  const db = h.db.raw;
  db.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(id, name, points, games, wins, best, bestGame, h.clock.t);
  for (const [g, pts] of Object.entries(byGame)) {
    db.prepare('INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) VALUES (?, ?, ?, 1, 0, ?, ?)').run(id, g, pts, pts, h.clock.t);
  }
  if (month) db.prepare('INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, 1, 1, 0, NULL, ?)').run(id, monthOf(h.clock.t), month, h.clock.t);
}

async function give(h, cookie, body, headers) {
  const res = await h.api('POST', '/api/owner/actions', cookie, body, headers);
  return { status: res.status, body: await res.json() };
}

async function board(h, query = '') {
  ipSeq += 1;
  const res = await h.request('GET', `/api/activity/leaderboard${query}`, { ip: `198.51.100.${(ipSeq % 200) + 1}` });
  assert.equal(res.status, 200, query);
  return res.json();
}

async function detail(h, cookie, id) {
  return (await (await h.api('GET', `/api/owner/users/${id}`, cookie)).json()).user;
}

const pts = (h, id) => h.db.raw.prepare('SELECT * FROM party_points WHERE user_id = ?').get(id);

test('every new Party kind is instant, listed for the panel and never reaches the bot', async () => {
  const { h, owner } = await setup();
  for (const kind of Object.keys(PARTY_OWNER_KINDS)) {
    assert.equal(OWNER_KINDS[kind].instant, true, kind);
    assert.equal(OWNER_KINDS[kind].gift, false, kind);
  }
  assert.equal(OWNER_KINDS['party.stats.add'].instant, true);
  assert.deepEqual([...LEADERBOARD_GAMES].sort(), Object.keys(PARTY_GAMES).sort());
  seed(h, XD, { points: 100, games: 2, wins: 1 });
  const bodies = [
    { kind: 'party.points.set', value: 5 },
    { kind: 'party.record.set', value: { games: 3, wins: 1 } },
    { kind: 'party.best.set', value: { score: 10, game: 'trivia' } },
    { kind: 'party.game.set', value: { game: 'namefive', points: 7 } },
    { kind: 'party.month.set', value: 9 },
    { kind: 'party.counters.set', value: { steals: 2 } },
    { kind: 'party.board.hide' },
    { kind: 'party.board.show' },
    { kind: 'party.reset', value: { badges: false } },
  ];
  for (const b of bodies) {
    const r = await give(h, owner, { user: XD, ...b });
    assert.equal(r.status, 201, b.kind);
    assert.equal(r.body.action.status, 'done', b.kind);
    assert.ok(r.body.action.result.length > 10, b.kind);
  }
  assert.deepEqual((await h.poll()).owner, []);
  const kinds = (await (await h.api('GET', `/api/owner/users/${XD}`, owner)).json()).catalog.kinds.map((k) => k.kind);
  for (const kind of Object.keys(PARTY_OWNER_KINDS)) assert.ok(kinds.includes(kind), kind);
});

test('non-owners, missing CSRF headers and other origins are refused for Party edits', async () => {
  const { h, owner, bob } = await setup();
  seed(h, XD, { points: 100000, games: 11, wins: 4 });
  const body = { user: XD, kind: 'party.points.set', value: 0 };
  assert.equal((await give(h, bob, body)).status, 404);
  assert.equal((await give(h, null, body)).status, 404);
  assert.equal((await give(h, owner, body, { 'X-YapOS': null })).status, 403);
  assert.equal((await give(h, owner, body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await give(h, bob, { user: XD, kind: 'party.board.hide' })).status, 404);
  assert.equal(pts(h, XD).points, 100000);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_board_hidden').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
});

test('Party edits are checked with friendly messages', async () => {
  const { h, owner } = await setup();
  const cases = [
    [{ kind: 'party.points.set', value: -1 }, /below zero/],
    [{ kind: 'party.points.set', value: 2e9 }, /too much/],
    [{ kind: 'party.points.set', value: 'inf' }, /Infinity/],
    [{ kind: 'party.month.set', value: 1.5 }, /decimals/],
    [{ kind: 'party.record.set', value: { games: 2, wins: 3 } }, /more than games/],
    [{ kind: 'party.record.set', value: { games: 2 } }, /both/],
    [{ kind: 'party.record.set', value: 4 }, /games and wins/],
    [{ kind: 'party.best.set', value: { score: 60000, game: 'trivia' } }, /at most 50,000/],
    [{ kind: 'party.best.set', value: { score: 100, game: 'chess' } }, /isn't on the Party/],
    [{ kind: 'party.best.set', value: { score: 100 } }, /Pick a game/],
    [{ kind: 'party.game.set', value: { game: 'nope', points: 1 } }, /isn't on the Party/],
    [{ kind: 'party.game.set', value: { game: 'trivia', points: -5 } }, /below zero/],
    [{ kind: 'party.counters.set', value: { hacks: 1 } }, /isn't a Party badge counter/],
    [{ kind: 'party.counters.set', value: {} }, /at least one/],
    [{ kind: 'party.counters.set', value: { steals: 100001 } }, /too much/],
    [{ kind: 'party.reset', value: { badges: 'yes' } }, /true or false/],
    [{ kind: 'party.reset', value: { everything: true } }, /Unknown reset/],
  ];
  for (const [b, re] of cases) {
    const r = await give(h, owner, { user: XD, ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(r.body.message, re, JSON.stringify(b));
  }
  assert.equal((await give(h, owner, { user: 'xd', kind: 'party.points.set', value: 1 })).status, 400);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
});

test('the owner sees the current Party leaderboard numbers for a person', async () => {
  const { h, owner } = await setup();
  seed(h, uid(2), { points: 200000, games: 30, wins: 10 });
  seed(h, XD, { points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', byGame: { trivia: 50000, draw: 30000, namefive: 20000 }, month: 100000 });
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 11, 4, '{}', ?, ?)").run(XD, JSON.stringify({ steals: 12, bestWinStreak: 4 }), h.clock.t);
  h.db.raw.prepare('INSERT INTO party_points_day (user_id, day, points) VALUES (?, ?, 100000)').run(XD, new Date(h.clock.t).toISOString().slice(0, 10));
  const u = await detail(h, owner, XD);
  const b = u.partyBoard;
  assert.equal(b.points, 100000);
  assert.equal(b.games, 11);
  assert.equal(b.wins, 4);
  assert.equal(b.best, 50000);
  assert.equal(b.bestGame, 'trivia');
  assert.equal(b.rank, 2);
  assert.equal(b.month.points, 100000);
  assert.equal(b.month.month, monthOf(h.clock.t));
  assert.equal(b.month.rank, 1);
  assert.equal(b.today.points, 100000);
  assert.deepEqual(b.byGame.map((g) => [g.game, g.points]), [['trivia', 50000], ['draw', 30000], ['namefive', 20000]]);
  assert.equal(b.counters.steals, 12);
  assert.equal(b.counters.bestWinStreak, 4);
  assert.deepEqual(Object.keys(b.counters), PARTY_COUNTERS.map((c) => c.key));
  assert.equal(b.hidden, false);
  assert.equal(b.banned, false);
  assert.equal(u.known, true);
  const nobody = (await detail(h, owner, uid(9))).partyBoard;
  assert.equal(nobody.points, 0);
  assert.equal(nobody.rank, null);
  assert.deepEqual(nobody.byGame, []);
});

test('setting all-time points, games and wins, and best game changes the boards straight away', async () => {
  const { h, owner } = await setup();
  seed(h, uid(2), { points: 3000, games: 5, wins: 2, best: 900, bestGame: 'draw' });
  seed(h, XD, { points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', byGame: { trivia: 50000 } });
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 11, 4, '{}', '{}', ?)").run(XD, h.clock.t);
  assert.equal((await board(h)).rows[0].id, XD);
  const r = await give(h, owner, { user: XD, kind: 'party.points.set', value: '1,000' });
  assert.match(r.body.action.result, /all-time Party points to 1,000 \(was 100,000\)/);
  assert.equal(pts(h, XD).points, 1000);
  assert.equal(h.db.raw.prepare('SELECT points FROM party_points_game WHERE user_id = ?').get(XD).points, 50000);
  assert.deepEqual((await board(h)).rows.map((x) => x.id), [uid(2), XD]);
  const rec = await give(h, owner, { user: XD, kind: 'party.record.set', value: { games: 2, wins: 0 } });
  assert.match(rec.body.action.result, /2 games and 0 wins \(was 11 and 4\)/);
  assert.deepEqual({ ...h.db.raw.prepare('SELECT games, wins FROM party_stats WHERE user_id = ?').get(XD) }, { games: 2, wins: 0 });
  assert.equal(pts(h, XD).games, 2);
  assert.deepEqual((await board(h, '?board=wins')).rows.map((x) => x.id), [uid(2)]);
  const best = await give(h, owner, { user: XD, kind: 'party.best.set', value: { score: 800, game: 'namefive' } });
  assert.match(best.body.action.result, /800 in Name 5 \(was 50,000 in Trivia\)/);
  const bestRows = (await board(h, '?board=best')).rows;
  assert.deepEqual(bestRows.map((x) => [x.id, x.value, x.bestGame]), [[uid(2), 900, 'draw'], [XD, 800, 'namefive']]);
  const clear = await give(h, owner, { user: XD, kind: 'party.best.set', value: { score: 0 } });
  assert.match(clear.body.action.result, /Cleared their best game/);
  assert.deepEqual({ best: pts(h, XD).best, game: pts(h, XD).best_game }, { best: 0, game: null });
  const fresh = await give(h, owner, { user: uid(3), kind: 'party.points.set', value: 50 });
  assert.equal(fresh.status, 201);
  assert.equal(pts(h, uid(3)).points, 50);
});

test('setting one game moves all-time points by the same amount so the totals still add up', async () => {
  const { h, owner } = await setup();
  seed(h, XD, { points: 100000, games: 11, wins: 4, byGame: { trivia: 50000, draw: 50000 } });
  const r = await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'trivia', points: 0 } });
  assert.match(r.body.action.result, /Trivia points to 0 \(was 50,000\)\. All-time points went down by 50,000 to 50,000/);
  assert.equal(pts(h, XD).points, 50000);
  assert.deepEqual((await board(h, '?game=trivia')).rows, []);
  const up = await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'memory', points: 500 } });
  assert.match(up.body.action.result, /Memory Chain points to 500 \(was 0\)\. All-time points went up by 500 to 50,500/);
  assert.deepEqual((await board(h, '?game=memory')).rows.map((x) => [x.id, x.value]), [[XD, 500]]);
  const same = await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'memory', points: 500 } });
  assert.match(same.body.action.result, /did not change/);
  await give(h, owner, { user: XD, kind: 'party.points.set', value: 10 });
  await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'draw', points: 0 } });
  assert.equal(pts(h, XD).points, 0);
});

test('lowering one game also lowers best scores that no longer fit', async () => {
  const { h, owner } = await setup();
  seed(h, XD, { points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', byGame: { trivia: 50000, draw: 50000 } });
  const r = await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'trivia', points: 100 } });
  assert.match(r.body.action.result, /Lowered their best Trivia game and their all-time best game to 100 to match\./);
  assert.equal(h.db.raw.prepare('SELECT best FROM party_points_game WHERE user_id = ? AND game = ?').get(XD, 'trivia').best, 100);
  assert.deepEqual({ best: pts(h, XD).best, game: pts(h, XD).best_game, points: pts(h, XD).points }, { best: 100, game: 'trivia', points: 50100 });
  await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'trivia', points: 0 } });
  assert.deepEqual({ best: pts(h, XD).best, game: pts(h, XD).best_game }, { best: 0, game: null });
  assert.deepEqual((await board(h, '?game=trivia&board=best')).rows, []);
  const draw = await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'draw', points: 60000 } });
  assert.doesNotMatch(draw.body.action.result, /Lowered/);
  assert.equal(h.db.raw.prepare('SELECT best FROM party_points_game WHERE user_id = ? AND game = ?').get(XD, 'draw').best, 50000);
});

test('setting one game counts a result that lands at the same time', async () => {
  const { h, owner } = await setup();
  seed(h, XD, { points: 1000, byGame: { trivia: 600, draw: 400 } });
  const db = h.db;
  const real = db.batch.bind(db);
  db.batch = async (stmts) => {
    db.batch = real;
    h.db.raw.prepare("UPDATE party_points SET points = points + 50 WHERE user_id = ?").run(XD);
    h.db.raw.prepare("UPDATE party_points_game SET points = points + 50 WHERE user_id = ? AND game = 'draw'").run(XD);
    return real(stmts);
  };
  await give(h, owner, { user: XD, kind: 'party.game.set', value: { game: 'trivia', points: 100 } });
  assert.equal(pts(h, XD).points, 550);
});

test('party admins who are not the owner cannot edit Party stats', async () => {
  const { h, bob } = await setup();
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(BOB.id, OWNER.id, 1);
  seed(h, XD, { points: 100000 });
  for (const body of [{ kind: 'party.points.set', value: 0 }, { kind: 'party.board.hide' }, { kind: 'party.reset' }]) {
    assert.equal((await give(h, bob, { user: XD, ...body })).status, 404, body.kind);
  }
  assert.equal((await h.api('GET', `/api/owner/users/${XD}`, bob)).status, 404);
  assert.equal(pts(h, XD).points, 100000);
});

test("setting this month's points fixes the monthly race and the award", async () => {
  const { h, owner } = await setup();
  const month = monthOf(h.clock.t);
  seed(h, XD, { points: 100000, month: 100000 });
  seed(h, uid(2), { points: 900, month: 900 });
  seed(h, uid(3), { points: 800, month: 800 });
  seed(h, uid(4), { points: 700, month: 700 });
  const r = await give(h, owner, { user: XD, kind: 'party.month.set', value: 10 });
  assert.match(r.body.action.result, /to 10 \(was 100,000\)\. All-time points did not change/);
  assert.equal(pts(h, XD).points, 100000);
  const mb = await board(h, '?period=month');
  assert.deepEqual(mb.rows.map((x) => x.id), [uid(2), uid(3), uid(4), XD]);
  const t = monthStart(nextMonth(month)) + MONTH_GRACE;
  assert.deepEqual(await awardMonth(h.db, t), { month, awarded: 3 });
  assert.deepEqual(h.db.raw.prepare('SELECT user_id FROM party_season_awards ORDER BY rank').all().map((x) => x.user_id), [uid(2), uid(3), uid(4)]);
  assert.equal(prevMonth(nextMonth(month)), month);
});

test('a hidden person is gone from every board, rank lookup, profile card and monthly award, but keeps playing', async () => {
  const { h, owner } = await setup();
  const month = monthOf(h.clock.t);
  seed(h, XD, { points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', byGame: { trivia: 50000 }, month: 100000, name: 'XD' });
  seed(h, uid(2), { points: 900, games: 3, wins: 1, best: 400, bestGame: 'trivia', byGame: { trivia: 900 }, month: 900 });
  seed(h, uid(3), { points: 800, games: 2, wins: 1, best: 300, bestGame: 'draw', byGame: { draw: 800 }, month: 800 });
  seed(h, uid(4), { points: 700, games: 1, wins: 1, best: 200, bestGame: 'draw', byGame: { draw: 700 }, month: 700 });
  assert.equal((await board(h)).rows[0].id, XD);
  const hide = await give(h, owner, { user: XD.toUpperCase(), kind: 'party.board.hide', note: 'farmed trivia' });
  assert.equal(hide.status, 201);
  assert.match(hide.body.action.result, /Removed them from every Party leaderboard/);
  assert.equal(hide.body.action.note, 'farmed trivia');
  const again = await give(h, owner, { user: XD, kind: 'party.board.hide' });
  assert.match(again.body.action.result, /already off/);
  for (const q of ['', '?board=wins', '?board=games', '?board=best', '?game=trivia', '?game=trivia&board=best', '?period=month', '?period=month&board=wins']) {
    const b = await board(h, `${q}${q ? '&' : '?'}me=${XD}`);
    assert.ok(!b.rows.some((x) => x.id === XD), q);
    assert.equal(b.me, null, q);
    assert.ok(b.rows.length >= 1, q);
    assert.equal(b.total, b.rows.length, q);
  }
  const others = await board(h, `?me=${uid(2)}`);
  assert.deepEqual(others.me, { rank: 1, value: 900 });
  assert.equal(others.rows[0].rank, 1);
  const card = await (await h.request('GET', `/api/activity/profile/${XD}`, { ip: '198.51.100.240' })).json();
  assert.equal(card.profile.rank, null);
  const card2 = await (await h.request('GET', `/api/activity/profile/${uid(2)}`, { ip: '198.51.100.241' })).json();
  assert.deepEqual(card2.profile.rank, { rank: 1, points: 900 });
  const view = (await detail(h, owner, XD)).partyBoard;
  assert.equal(view.hidden, true);
  assert.equal(view.rank, null);
  assert.equal(view.points, 100000);
  const t = monthStart(nextMonth(month)) + MONTH_GRACE;
  assert.deepEqual(await awardMonth(h.db, t), { month, awarded: 3 });
  assert.deepEqual(h.db.raw.prepare('SELECT user_id FROM party_season_awards ORDER BY rank').all().map((x) => x.user_id), [uid(2), uid(3), uid(4)]);
  const res = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: { game: 'trivia', at: h.clock.t, players: [{ id: XD, name: 'XD', username: null, score: 10, won: true, team: null }, { id: uid(5), name: 'P5', username: null, score: 5, won: false, team: null }], extra: {} }, ip: '198.51.100.242' });
  assert.equal(res.status, 201);
  assert.equal(pts(h, XD).games, 12);
  const show = await give(h, owner, { user: XD, kind: 'party.board.show' });
  assert.match(show.body.action.result, /show on the Party leaderboards again/);
  assert.equal((await board(h)).rows[0].id, XD);
  const twice = await give(h, owner, { user: XD, kind: 'party.board.show' });
  assert.match(twice.body.action.result, /already on/);
});

test('reset clears every Party leaderboard table and only touches badge stats when asked', async () => {
  const { h, owner } = await setup();
  const day = new Date(h.clock.t).toISOString().slice(0, 10);
  const counters = JSON.stringify({ steals: 12, bestWinStreak: 5 });
  const fill = (id) => {
    seed(h, id, { points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', byGame: { trivia: 50000, draw: 50000 }, month: 100000 });
    h.db.raw.prepare('INSERT INTO party_points_day (user_id, day, points) VALUES (?, ?, 100000)').run(id, day);
    h.db.raw.prepare('INSERT INTO party_games_day (user_id, day, games) VALUES (?, ?, 11)').run(id, day);
    h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 11, 4, '{}', ?, ?)").run(id, counters, h.clock.t);
    h.db.raw.prepare("INSERT INTO party_daily_streaks (user_id, last_day, streak, best, updated) VALUES (?, ?, 7, 7, ?)").run(id, day, h.clock.t);
    h.db.raw.prepare('INSERT INTO party_win_streaks (user_id, streak, best, updated) VALUES (?, 4, 6, ?)').run(id, h.clock.t);
  };
  const count = (table, id) => h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(id).n;
  fill(XD);
  fill(uid(2));
  const r = await give(h, owner, { user: XD, kind: 'party.reset', value: { badges: false } });
  assert.match(r.body.action.result, /was 100,000 points from 11 games.*were kept/);
  for (const t of ['party_points', 'party_points_game', 'party_points_month', 'party_points_day', 'party_games_day']) assert.equal(count(t, XD), 0, t);
  assert.deepEqual({ ...h.db.raw.prepare('SELECT games, wins, counters FROM party_stats WHERE user_id = ?').get(XD) }, { games: 11, wins: 4, counters });
  assert.equal(count('party_daily_streaks', XD), 1);
  assert.equal(count('party_win_streaks', XD), 1);
  assert.equal(count('party_points', uid(2)), 1);
  assert.equal(count('party_points_game', uid(2)), 2);
  const full = await give(h, owner, { user: uid(2), kind: 'party.reset', value: { badges: true } });
  assert.match(full.body.action.result, /were reset too/);
  assert.deepEqual({ ...h.db.raw.prepare('SELECT games, wins, by_game, counters FROM party_stats WHERE user_id = ?').get(uid(2)) }, { games: 0, wins: 0, by_game: '{}', counters: '{}' });
  assert.equal(count('party_daily_streaks', uid(2)), 0);
  assert.equal(count('party_win_streaks', uid(2)), 0);
  assert.equal((await detail(h, owner, uid(2))).earnedBadges.length, 0);
  assert.deepEqual((await board(h)).rows, []);
  const none = await give(h, owner, { user: uid(7), kind: 'party.reset' });
  assert.match(none.body.action.result, /nothing on the boards/);
});

test('badge counters can be set and badges follow them', async () => {
  const { h, owner } = await setup();
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 3, 1, '{}', ?, ?)").run(XD, JSON.stringify({ steals: 12, perfect: 1, winStreak: 6, bestWinStreak: 6, skillDay: 'x' }), h.clock.t);
  let u = await detail(h, owner, XD);
  assert.ok(u.earnedBadges.includes('steals-10'));
  assert.ok(u.earnedBadges.includes('streak-5'));
  const r = await give(h, owner, { user: XD, kind: 'party.counters.set', value: { steals: 0, perfect: '0', bestWinStreak: 2 } });
  assert.match(r.body.action.result, /Trivia steals 12 → 0/);
  const stored = JSON.parse(h.db.raw.prepare('SELECT counters FROM party_stats WHERE user_id = ?').get(XD).counters);
  assert.deepEqual(stored, { steals: 0, perfect: 0, winStreak: 2, bestWinStreak: 2, skillDay: 'x' });
  u = await detail(h, owner, XD);
  assert.ok(!u.earnedBadges.includes('steals-10'));
  assert.ok(!u.earnedBadges.includes('perfect-trivia'));
  assert.ok(!u.earnedBadges.includes('streak-3'));
  assert.equal(u.partyBoard.counters.bestWinStreak, 2);
  await give(h, owner, { user: uid(3), kind: 'party.counters.set', value: { pangram: 5 } });
  assert.ok((await detail(h, owner, uid(3))).earnedBadges.includes('pangram-5'));
});
