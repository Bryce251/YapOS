import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { awardMonth, monthOf, prevMonth, isOffBoard } from '../worker/party-leaderboard.js';
import { rerankWithout, useBoardOwner, isBoardOwner, ownerFromEnv, notOwnerSql, BOARD_HIDDEN_TEXT } from '../worker/board-owner.js';

const OWNER = USERS.alice.id;
const uid = (i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;

function harness() {
  return createHarness({ PARTY_OWNER_ID: OWNER.toUpperCase() });
}

function seedPoints(h, id, points, extra = {}) {
  const r = { games: 5, wins: 2, best: Math.floor(points / 2), best_game: 'trivia', ...extra };
  h.db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `Name ${id.slice(-2)}`, `user${id.slice(-2)}`, points, r.games, r.wins, r.best, r.best_game, 1000);
  h.db.raw.prepare('INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'trivia', points, r.games, r.wins, r.best, 1000);
  h.db.raw.prepare('INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, monthOf(h.clock.t), points, r.games, r.wins, r.best, r.best_game, 1000);
}

async function board(h, query, ip = '198.51.100.31') {
  const res = await h.request('GET', `/api/activity/leaderboard${query}`, { ip });
  assert.equal(res.status, 200);
  return res.json();
}

function seedAll(h) {
  seedPoints(h, OWNER, 90_000, { games: 99, wins: 80, best: 50_000 });
  seedPoints(h, uid(1), 5000);
  seedPoints(h, uid(2), 4000);
  seedPoints(h, uid(3), 4000);
}

test('board owner helpers read the env id case-insensitively and rerank without gaps', () => {
  assert.equal(ownerFromEnv({ PARTY_OWNER_ID: ' ABC-1 ' }), 'abc-1');
  assert.equal(ownerFromEnv({ PARTY_OWNER_ID: 'bad id!' }), null);
  assert.equal(ownerFromEnv({}), null);
  useBoardOwner({ PARTY_OWNER_ID: OWNER.toUpperCase() });
  assert.equal(isBoardOwner(OWNER), true);
  assert.equal(isBoardOwner(OWNER.toUpperCase()), true);
  assert.equal(isBoardOwner(uid(1)), false);
  assert.match(notOwnerSql('p.user_id'), /LOWER\(p\.user_id\) != '/);
  const list = [{ id: uid(1), rank: 1 }, { id: OWNER, rank: 2 }, { id: uid(2), rank: 2 }, { id: uid(3), rank: 4 }, { id: null, rank: 5 }];
  assert.deepEqual(rerankWithout(list).map((r) => [r.id, r.rank]), [[uid(1), 1], [uid(2), 2], [uid(3), 3], [null, 4]]);
  assert.deepEqual(rerankWithout([{ id: OWNER, rank: 1 }, { id: uid(1), rank: 2 }]).map((r) => r.rank), [1]);
  useBoardOwner({});
  assert.equal(isBoardOwner(OWNER), false);
  assert.equal(notOwnerSql('x'), '1 = 1');
  assert.equal(BOARD_HIDDEN_TEXT, 'Hidden from leaderboards');
});

test('the owner is hidden from every party board, others move up and ranks have no gaps', async () => {
  const h = harness();
  seedAll(h);
  const cases = ['?board=points', '?board=wins', '?board=games', '?board=best', '?board=points&period=month', '?board=points&game=trivia', '?board=wins&game=trivia', '?board=best&game=trivia'];
  for (const q of cases) {
    const body = await board(h, `${q}&me=${uid(1)}`);
    const ids = body.rows.map((r) => r.id);
    assert.equal(ids.includes(OWNER), false, q);
    assert.equal(body.total, 3, q);
    assert.equal(body.rows[0].rank, 1, q);
    assert.ok(body.rows.every((r, i) => r.rank <= i + 1), q);
    assert.equal(body.me.rank, 1, `${q} others rank as if the owner is not there`);
    assert.equal(body.meHidden, undefined, q);
  }
  const pts = await board(h, '?board=points');
  assert.deepEqual(pts.rows.map((r) => [r.id, r.rank]), [[uid(1), 1], [uid(2), 2], [uid(3), 2]]);
});

test('the owner asking for their own rank gets Hidden instead of a number, matched by id not name', async () => {
  const h = harness();
  seedAll(h);
  const body = await board(h, `?board=points&me=${OWNER.toUpperCase()}`);
  assert.equal(body.me, null);
  assert.equal(body.meHidden, true);
  assert.equal(await isOffBoard(h.db, OWNER), true);
  h.db.raw.prepare('UPDATE party_points SET name = ?, username = ? WHERE user_id = ?').run('Jolli', '00', uid(2));
  const named = await board(h, '?board=points', '198.51.100.44');
  assert.ok(named.rows.some((r) => r.id === uid(2)), 'someone else named like the owner still shows');
  const row = h.db.raw.prepare('SELECT points, games FROM party_points WHERE user_id = ?').get(OWNER);
  assert.equal(row.points, 90_000, 'the owner keeps their points');
});

test('without an owner id nobody is hidden', async () => {
  const h = createHarness();
  seedAll(h);
  const body = await board(h, '?board=points');
  assert.equal(body.rows[0].id, OWNER);
  assert.equal(body.total, 4);
});

test('month prizes skip the owner but prizes already recorded are kept', async () => {
  const h = harness();
  const month = monthOf(h.clock.t);
  seedAll(h);
  h.db.raw.prepare('INSERT INTO party_season_awards (month, rank, user_id, name, username, points, awarded) VALUES (?, ?, ?, ?, ?, ?, ?)').run(prevMonth(month), 1, OWNER, 'Jolli', '00', 1, 1);
  useBoardOwner(h.env);
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1, 1)).getTime();
  const out = await awardMonth(h.db, next);
  assert.equal(out.month, month);
  const rows = h.db.raw.prepare('SELECT rank, user_id FROM party_season_awards WHERE month = ? ORDER BY rank').all(month);
  assert.deepEqual(rows.map((r) => [r.rank, r.user_id]), [[1, uid(1)], [2, uid(2)], [3, uid(3)]]);
  const old = h.db.raw.prepare('SELECT user_id FROM party_season_awards WHERE month = ?').get(prevMonth(month));
  assert.equal(old.user_id, OWNER);
});

test('the global XP and Shards boards hide the owner and renumber', async () => {
  const h = harness();
  const levels = [{ id: OWNER, rank: 1, name: 'Jolli', level: 99, xp: 9e6 }, { id: uid(1), rank: 2, name: 'A', level: 10, xp: 100 }, { id: uid(2), rank: 3, name: 'B', level: 9, xp: 90 }];
  const economy = [{ id: uid(1), rank: 1, name: 'A', balance: 500 }, { id: OWNER.toUpperCase(), rank: 2, name: 'Jolli', balance: 400 }, { id: uid(2), rank: 3, name: 'B', balance: 300 }];
  h.db.raw.prepare('INSERT INTO global_board (id, data, updated) VALUES (?, ?, ?)').run('global', JSON.stringify({ levels, economy, updatedAt: 1 }), 1);
  const res = await h.request('GET', '/api/public/global');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.levels.map((r) => [r.id, r.rank]), [[uid(1), 1], [uid(2), 2]]);
  assert.deepEqual(body.economy.map((r) => [r.id, r.rank]), [[uid(1), 1], [uid(2), 2]]);
});

test('past seasons skip the owner when shown and close the gap', async () => {
  const h = harness();
  const entry = (id, rank, value, name) => ({ id, rank, name, username: name.toLowerCase(), value });
  const xp = [entry(OWNER, 1, 900, 'Jolli'), entry(uid(1), 2, 800, 'Ann'), entry(uid(2), 3, 700, 'Ben')];
  const shards = [entry(uid(1), 1, 50, 'Ann'), entry(OWNER, 2, 40, 'Jolli'), entry(uid(2), 3, 30, 'Ben')];
  assert.equal((await h.bot('POST', '/bot/seasons', { month: '2026-10', boards: { xp, shards } })).status, 200);
  const res = await h.request('GET', '/api/seasons');
  const { seasons } = await res.json();
  assert.deepEqual(seasons[0].boards.xp.map((r) => [r.name, r.rank]), [['Ann', 1], ['Ben', 2]]);
  assert.deepEqual(seasons[0].boards.shards.map((r) => [r.name, r.rank]), [['Ann', 1], ['Ben', 2]]);
  assert.equal(JSON.stringify(seasons).includes(OWNER), false);
  const stored = JSON.parse(h.db.raw.prepare('SELECT boards FROM season_history WHERE month = ?').get('2026-10').boards);
  assert.equal(stored.xp[0].id, OWNER, 'the recorded season is not changed');
});

test('clan top members skip the owner', async () => {
  const h = harness();
  const profile = (id, name, level) => h.db.raw.prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, 0, ?)')
    .run(id, name.toLowerCase(), name.toLowerCase(), name, level, '[]', '[]', '[]', h.clock.t);
  profile(OWNER, 'Jolli', 99);
  profile(uid(1), 'Ann', 10);
  profile(uid(2), 'Ben', 5);
  const push = await h.bot('POST', '/bot/clans', { clans: [{ id: 'c1', tag: 'OWL', name: 'Night Owls', colour: null, banner: null, join: 'open', leader: uid(1), created: 1, count: 3, members: [OWNER, uid(1), uid(2)] }], full: true, known: ['c1'] });
  assert.equal(push.status, 200);
  advance(h, 1000);
  const body = await (await h.request('GET', '/api/clans/OWL')).json();
  assert.deepEqual(body.clan.top.map((m) => m.username), ['ann', 'ben']);
  assert.equal(body.clan.members, 3, 'the member count still counts the owner');
});
