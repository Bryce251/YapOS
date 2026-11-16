import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { PARTY_GAMES } from '../worker/party-results.js';
import { COUNTER_GAMES } from '../worker/party-badges.js';
import { TEXT_GAMES } from '../worker/reports.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { resultsBody, textReportBody, RESULT_GAMES, TEXT_REPORT_GAMES } from '../web/activity/js/admin.js';

const uid = (i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;

function party() {
  return createHarness({ PARTY_OWNER_ID: USERS.alice.id });
}

function post(h, path, body, ip) {
  return h.request('POST', path, { headers: { Origin: h.base }, body, ip });
}

test('the activity, the results endpoint and the game list agree on every game id', () => {
  const ids = GAMES.map((g) => g.id);
  assert.deepEqual([...ids].sort(), [...PARTY_GAMES].sort());
  assert.deepEqual([...RESULT_GAMES].sort(), [...PARTY_GAMES].sort());
  for (const id of ids) assert.equal(typeof VIEWS[id], 'function', id);
  for (const id of TEXT_REPORT_GAMES) assert.ok(TEXT_GAMES.has(id), id);
});

test('a results body built by the activity is counted by the Worker for every game', async () => {
  const h = party();
  let n = 0;
  for (const game of GAMES) {
    n += 1;
    const extra = {};
    for (const [key, g] of Object.entries(COUNTER_GAMES)) if (g === game.id) extra[key] = [uid(n * 10 + 1)];
    const body = resultsBody({
      game: game.id,
      at: h.clock.t,
      players: [
        { id: uid(n * 10 + 1), name: 'Pip', username: '@pip', score: 12, won: true, team: game.id === 'trivia' ? 'Red' : null },
        { id: uid(n * 10 + 2), name: 'Juno', username: null, score: 3, won: false, team: game.id === 'trivia' ? 'Blue' : null },
      ],
      extra,
    });
    assert.ok(body, game.id);
    const res = await post(h, '/api/activity/results', body, `198.51.100.${n}`);
    assert.equal(res.status, 201, game.id);
    const out = await res.json();
    assert.equal(out.counted, true, game.id);
    const row = h.db.raw.prepare('SELECT counters FROM party_stats WHERE user_id = ?').get(uid(n * 10 + 1));
    const counters = JSON.parse(row.counters);
    for (const key of Object.keys(extra)) assert.equal(counters[key], 1, `${game.id} ${key}`);
  }
});

test('a Bluff text report built by the activity is accepted by the Worker', async () => {
  const h = party();
  const body = textReportBody({
    kind: 'text',
    game: 'bluff',
    author: { id: uid(1), name: 'Rex', username: 'rex' },
    reporter: { id: uid(2), name: 'Mila' },
    text: 'a made up fact',
    context: 'Fact: Octopuses have ___ hearts.',
    at: h.clock.t,
  });
  assert.ok(body);
  const res = await post(h, '/api/activity/reports', body, '198.51.100.77');
  assert.equal(res.status, 201);
});
