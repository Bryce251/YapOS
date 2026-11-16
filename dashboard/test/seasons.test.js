import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { SEASON_TOP } from '../worker/seasons.js';
import { decodeTerm } from '../web/activity/js/filter.js';

const SLUR = decodeTerm('yogqkz');
const uid = (i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;

function board(n, scale = 100) {
  return Array.from({ length: n }, (_, i) => ({ rank: i + 1, id: uid(i + 1), name: `Player ${i + 1}`, username: `player${i + 1}`, value: (n - i) * scale }));
}

function read(h, ip = '203.0.113.90') {
  return h.request('GET', '/api/seasons', { ip });
}

test('the bot saves a finished season and everyone can see its top 10 forever', async () => {
  const h = createHarness();
  const res = await h.bot('POST', '/bot/seasons', { month: '2026-10', boards: { xp: board(14), shards: board(3, 1000) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, month: '2026-10', xp: SEASON_TOP, shards: 3 });
  await h.bot('POST', '/bot/profiles', { profiles: [{ id: uid(1), name: 'Player 1', username: 'player1', level: 3, hidden: false }, { id: uid(2), name: 'Player 2', username: 'player2', level: 3, hidden: true }] });
  const out = await read(h);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get('Cache-Control'), 'public, max-age=300');
  const { seasons, top } = await out.json();
  assert.equal(top, SEASON_TOP);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].month, '2026-10');
  assert.equal(seasons[0].boards.xp.length, 10);
  assert.deepEqual(seasons[0].boards.xp[0], { rank: 1, name: 'Player 1', username: 'player1', value: 1400, profile: true });
  assert.equal(seasons[0].boards.xp[1].profile, false, 'hidden profiles are not linked');
  assert.equal(seasons[0].boards.xp[2].profile, false, 'people without a profile are not linked');
  assert.equal(JSON.stringify(seasons).includes(uid(1)), false, 'user ids are not shown');
  advance(h, 365 * 24 * 60 * 60 * 1000);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM season_history').get().n, 1, 'cleanup never drops seasons');
});

test('seasons are listed newest first and a re-push replaces the old boards', async () => {
  const h = createHarness();
  await h.bot('POST', '/bot/seasons', { month: '2026-08', boards: { xp: board(2) } });
  await h.bot('POST', '/bot/seasons', { month: '2026-10', boards: { shards: board(2) } });
  await h.bot('POST', '/bot/seasons', { month: '2026-09', boards: { xp: board(1) } });
  const first = await (await read(h)).json();
  assert.deepEqual(first.seasons.map((s) => s.month), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(first.seasons[0].boards.xp, []);
  await h.bot('POST', '/bot/seasons', { month: '2026-09', boards: { xp: board(4) } });
  const second = await (await read(h)).json();
  assert.equal(second.seasons[1].boards.xp.length, 4, 'a new push clears the cache');
});

test('season input is checked and names go through the filter', async () => {
  const h = createHarness();
  const bad = [
    {},
    { month: '2026-13', boards: { xp: board(1) } },
    { month: '26-10', boards: { xp: board(1) } },
    { month: '2026-11', boards: { xp: board(1) } },
    { month: '2027-01', boards: { xp: board(1) } },
    { month: '2026-10', boards: [] },
    { month: '2026-10', boards: { xp: 'nope' } },
    { month: '2026-10', boards: { xp: [] } },
  ];
  for (const body of bad) assert.equal((await h.bot('POST', '/bot/seasons', body)).status, 400, JSON.stringify(body));
  const res = await h.bot('POST', '/bot/seasons', { month: '2026-10', boards: { xp: [{ rank: 1, id: uid(1), name: `${SLUR} lord`, username: '@lordy', value: 50.9 }, { rank: 2, id: uid(1), name: 'Dupe', value: 10 }, { rank: 3, name: 'No value' }, 'junk'] } });
  assert.equal(res.status, 200);
  const { seasons } = await (await read(h)).json();
  assert.deepEqual(seasons[0].boards.xp, [{ rank: 1, name: 'lordy', username: 'lordy', value: 50, profile: false }]);
  assert.equal((await h.bot('POST', '/bot/seasons', { month: '2026-10', boards: { xp: board(1) } }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  assert.equal((await h.bot('GET', '/bot/seasons')).status, 405);
  assert.equal((await h.request('POST', '/api/seasons', { headers: { Origin: h.base, 'X-YapOS': '1' }, body: {} })).status, 405);
});

test('the season list is rate limited and the page is served by the SPA', async () => {
  const h = createHarness();
  let last;
  for (let i = 0; i < 121; i += 1) last = await read(h, '198.51.100.77');
  assert.equal(last.status, 429);
  assert.equal((await h.request('GET', '/seasons')).status, 200);
});
