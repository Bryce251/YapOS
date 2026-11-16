import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';
import { cleanReplay, DISMISSED_KEEP } from '../worker/reports.js';
import { REPLAY_EVENTS, REPLAY_MAX_MS, PIXEL_CELLS } from '../web/activity/js/games/replayformat.js';

const OWNER = USERS.alice;
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const S1 = encodeStroke({ c: 3, z: 1, pts: [[10, 10], [40, 40]] });
const S2 = encodeStroke({ c: 8, z: 1, pts: [[100, 100], [140, 120]] });
const S3 = encodeStroke({ c: 6, z: 2, pts: [[200, 50], [220, 90], [260, 60]] });

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function inkReplay(over = {}) {
  return {
    v: 1,
    kind: 'ink',
    authors: [{ id: uid(1), name: 'Rex' }, { id: uid(3), name: 'Juno' }],
    events: [[1, 0, S1], [0, 1200, S2], [1, 1300, 1], [0, 4000, S3]],
    ...over,
  };
}

function pixelReplay(over = {}) {
  const grid = Array(PIXEL_CELLS).fill('0');
  grid[0] = '4';
  grid[5] = 'b';
  return {
    v: 1,
    kind: 'pixel',
    authors: [{ id: uid(1), name: 'Rex' }, { id: uid(3), name: 'Juno' }],
    events: [[0, 100, 0, '4'], [1, 300, 5, 'b']],
    grid: grid.join(''),
    ...over,
  };
}

function report(over = {}) {
  return {
    game: 'odd',
    drawer: { id: uid(1), name: 'Rex', username: 'rexplorer' },
    reporter: { id: uid(2), name: 'Mila' },
    ink: [S3],
    word: 'lighthouse',
    at: Date.UTC(2026, 10, 12, 11, 59),
    replay: inkReplay(),
    ...over,
  };
}

function send(h, body, ip = '198.51.100.9') {
  return h.request('POST', '/api/activity/reports', { headers: { Origin: h.base }, body, ip });
}

const replays = (h) => h.db.raw.prepare('SELECT * FROM party_report_replays ORDER BY created ASC').all();

test('a drawing report keeps its replay in its own table and staff get it back', async () => {
  const h = party();
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?)').run(uid(3), 'realjuno', 'Real Juno', h.clock.t);
  const res = await send(h, report({ replay: inkReplay({ authors: [{ id: uid(1).toUpperCase(), name: '  Rex\u0000 ' }, { id: uid(3), name: 'Juno' }] }) }));
  assert.equal(res.status, 201);
  const [row] = replays(h);
  const stored = JSON.parse(row.data);
  assert.deepEqual(stored.authors, [{ id: uid(1), name: 'Rex' }, { id: uid(3), name: 'Juno' }]);
  assert.deepEqual(stored.events, inkReplay().events);
  const { cookie } = await h.login(OWNER);
  const data = await (await h.api('GET', '/api/party/reports', cookie)).json();
  const [r] = data.reports;
  assert.equal(r.id, row.report_id);
  assert.equal(r.replay.kind, 'ink');
  assert.deepEqual(r.replay.events, stored.events);
  assert.equal(r.replay.authors[1].profile.display_name, 'Real Juno');
  assert.equal(r.replay.authors[1].banned, false);
  assert.equal(r.replay.truncated, false);
  assert.deepEqual(r.ink, [S3], 'the old ink field stays for older pages');
});

test('reports without a replay still work and come back without one', async () => {
  const h = party();
  const body = report();
  delete body.replay;
  assert.equal((await send(h, body)).status, 201);
  assert.equal(replays(h).length, 0);
  const { cookie } = await h.login(OWNER);
  const [r] = (await (await h.api('GET', '/api/party/reports', cookie)).json()).reports;
  assert.equal('replay' in r, false);
});

test('Pixel Art pictures can be reported with a cell-by-cell replay', async () => {
  const h = party();
  const res = await send(h, report({ game: 'pixel', ink: [], word: 'a castle', replay: pixelReplay() }));
  assert.equal(res.status, 201);
  const { cookie } = await h.login(OWNER);
  const [r] = (await (await h.api('GET', '/api/party/reports?kind=drawing', cookie)).json()).reports;
  assert.equal(r.game, 'pixel');
  assert.equal(r.kind, 'drawing');
  assert.equal(r.replay.kind, 'pixel');
  assert.equal(r.replay.grid, pixelReplay().grid);
  assert.deepEqual(r.replay.events, pixelReplay().events);
});

test('bad replays are refused with a friendly 400 and nothing is stored', async () => {
  const h = party();
  const big = encodeStroke({ c: 1, z: 1, pts: Array.from({ length: 400 }, (_, i) => [i % 480, (i * 7) % 360]) });
  const cases = [
    ['not an object', report({ replay: 'nope' })],
    ['too big', report({ replay: inkReplay({ events: Array.from({ length: 80 }, (_, i) => [0, i, big]), authors: [{ id: uid(1), name: 'Rex' }] }) })],
    ['too many steps', report({ replay: inkReplay({ authors: [{ id: uid(1), name: 'Rex' }], events: Array.from({ length: REPLAY_EVENTS + 1 }, (_, i) => [0, i, S1]) }) })],
    ['bad artist id', report({ replay: inkReplay({ authors: [{ id: uid(1), name: 'Rex' }, { id: 'no way', name: 'X' }] }) })],
    ['duplicate artist', report({ replay: inkReplay({ authors: [{ id: uid(1), name: 'Rex' }, { id: uid(1).toUpperCase(), name: 'Rex' }] }) })],
    ['unknown artist', report({ replay: inkReplay({ events: [[2, 0, S1], [0, 1, S2], [1, 2, S3]] }) })],
    ['unused artist', report({ replay: inkReplay({ events: [[0, 0, S1]] }) })],
    ['drawer missing', report({ replay: inkReplay({ authors: [{ id: uid(4), name: 'Zed' }, { id: uid(3), name: 'Juno' }] }) })],
    ['out of order', report({ replay: inkReplay({ events: [[1, 500, S1], [0, 200, S2]] }) })],
    ['too long ago', report({ replay: inkReplay({ events: [[1, 0, S1], [0, REPLAY_MAX_MS + 1, S2]] }) })],
    ['negative time', report({ replay: inkReplay({ events: [[1, -1, S1], [0, 2, S2]] }) })],
    ['bad stroke', report({ replay: inkReplay({ events: [[1, 0, 'AB'], [0, 2, S2]] }) })],
    ['bad colour in stroke', report({ replay: inkReplay({ events: [[1, 0, `_${S1.slice(1)}`], [0, 2, S2]] }) })],
    ['undo past the start', report({ replay: inkReplay({ events: [[1, 0, S1], [0, 2, 5]] }) })],
    ['wrong kind for game', report({ replay: pixelReplay() })],
    ['wrong version', report({ replay: inkReplay({ v: 2 }) })],
    ['extra field', report({ replay: inkReplay({ html: '<b>' }) })],
    ['grid on ink', report({ replay: inkReplay({ grid: '0'.repeat(PIXEL_CELLS) }) })],
    ['cell off the canvas', report({ game: 'pixel', ink: [], replay: pixelReplay({ events: [[0, 1, PIXEL_CELLS, '4'], [1, 2, 5, 'b']] }) })],
    ['colour not in palette', report({ game: 'pixel', ink: [], replay: pixelReplay({ events: [[0, 1, 3, 'z'], [1, 2, 5, 'b']] }) })],
    ['bad pixel grid', report({ game: 'pixel', ink: [], replay: pixelReplay({ grid: 'x'.repeat(PIXEL_CELLS) }) })],
    ['truncated not a flag', report({ replay: inkReplay({ truncated: 'yes' }) })],
  ];
  for (const [what, body] of cases) {
    const res = await send(h, body, `198.51.100.${cases.findIndex((c) => c[0] === what) + 20}`);
    assert.equal(res.status, 400, what);
    assert.equal((await res.json()).error, 'bad_replay', what);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_reports').get().n, 0);
  assert.equal(replays(h).length, 0);
});

test('the replay goes away with its report, by hand or by cleanup', async () => {
  const h = party();
  assert.equal((await send(h, report())).status, 201);
  assert.equal((await send(h, report({ drawer: { id: uid(3), name: 'Juno' }, ink: [S1], replay: inkReplay() }), '198.51.100.50')).status, 201);
  assert.equal(replays(h).length, 2);
  const { cookie } = await h.login(OWNER);
  const [first, second] = replays(h);
  assert.equal((await h.api('DELETE', `/api/party/reports/${first.report_id}`, cookie)).status, 200);
  assert.deepEqual(replays(h).map((r) => r.report_id), [second.report_id]);
  h.db.raw.prepare("UPDATE party_reports SET status = 'dismissed', dismissed_at = ? WHERE id = ?").run(h.clock.t - DISMISSED_KEEP - 1000, second.report_id);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(replays(h).length, 0);
  h.db.raw.prepare("INSERT INTO party_report_replays (report_id, data, created) VALUES ('ghost', '{}', 1)").run();
  await h.worker.scheduled({}, h.env, {});
  assert.equal(replays(h).length, 0, 'orphans are cleared');
});

test('a forged replay cannot frame someone or swap in a different drawing', async () => {
  const h = party();
  const solo = (over) => report({ game: 'draw', ink: [S1, S2], replay: { v: 1, kind: 'ink', authors: [{ id: uid(1), name: 'Rex' }], events: [[0, 0, S1], [0, 500, S2]] }, ...over });
  const cases = [
    ['extra artist in a one-artist game', solo({ replay: inkReplay() })],
    ['someone else drew it in a one-artist game', solo({ game: 'telephone', replay: { v: 1, kind: 'ink', authors: [{ id: uid(1), name: 'Rex' }, { id: uid(5), name: 'Kai' }], events: [[1, 0, S1], [0, 500, S2]] } })],
    ['replay ends in a different drawing', report({ ink: [S2] })],
    ['replay of another drawing in a one-artist game', solo({ ink: [S3] })],
    ['pixel steps disagree with the picture', report({ game: 'pixel', ink: [], replay: pixelReplay({ events: [[0, 100, 0, '4'], [1, 300, 5, 'b'], [1, 400, 9, '7']] }) })],
  ];
  for (const [i, [what, body]] of cases.entries()) {
    const res = await send(h, body, `198.51.100.${i + 120}`);
    assert.equal(res.status, 400, what);
    assert.equal((await res.json()).error, 'bad_replay', what);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_reports').get().n, 0);
  assert.equal((await send(h, solo({ replay: { v: 1, kind: 'ink', authors: [{ id: uid(1), name: 'Fake Name' }], events: [[0, 0, S1], [0, 500, S2]] } }), '198.51.100.200')).status, 201);
  assert.equal(JSON.parse(replays(h)[0].data).authors[0].name, 'Rex', "the reported player's name matches the report card");
  assert.equal((await send(h, report({ game: 'pixel', ink: [S1], drawer: { id: uid(3), name: 'Juno' }, replay: pixelReplay() }), '198.51.100.201')).status, 201);
  const row = h.db.raw.prepare("SELECT ink FROM party_reports WHERE game = 'pixel'").get();
  assert.equal(row.ink, '[]', 'Pixel Art reports never carry pen lines');
});

test('a truncated or oversized replay is not held to the exact reported lines', () => {
  assert.doesNotThrow(() => cleanReplay(inkReplay({ truncated: true }), 'odd', uid(1), null, [S1]));
  assert.doesNotThrow(() => cleanReplay(inkReplay(), 'odd', uid(1), null, [S3]), 'only the reported player\'s own lines are compared');
  assert.throws(() => cleanReplay(inkReplay(), 'odd', uid(1), null, [S1]), /reported drawing/);
});

test('cleanReplay keeps only the checked fields', () => {
  const out = cleanReplay(inkReplay({ truncated: true, late: false }), 'odd', uid(1));
  assert.deepEqual(Object.keys(out).sort(), ['authors', 'events', 'kind', 'truncated', 'v']);
  assert.throws(() => cleanReplay(inkReplay(), 'odd', uid(9)), /artists/);
});
