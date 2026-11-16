import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';

const SECRET = 'test-secret-value-for-party-sync';

function fakeWorker() {
  const w = { xp: [], reportsOpen: 0, acks: [], ackStatus: [], stats: {}, statsCalls: [], statsStatus: 200 };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'GET' && u.pathname === '/bot/poll') return reply(200, { jobs: [], hot: false, party: { xp: w.xp.slice(0, 100), reportsOpen: w.reportsOpen } });
    if (init.method === 'POST' && u.pathname === '/bot/party/ack') {
      w.acks.push(body.ids);
      const status = w.ackStatus.length ? w.ackStatus.shift() : 200;
      if (status === 200) w.xp = w.xp.filter((r) => !body.ids.includes(String(r.id)));
      return reply(status, { ok: status === 200 });
    }
    if (init.method === 'GET' && u.pathname === '/bot/party/stats') {
      w.statsCalls.push(u.searchParams.get('ids'));
      return reply(w.statsStatus, { stats: w.stats });
    }
    return reply(200, { ok: true });
  };
  return w;
}

async function setup() {
  const h = await createHarness({ apps: ['levels', 'economy', 'quests'], fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  const played = [];
  h.bot.on('party:played', (ev) => { played.push(ev); });
  return { h, w, dash, played };
}

const xpOf = (h, uid) => h.engine.service('levels').getUser(null, uid).xp;

test('Party XP rows from the poll are applied through Levels, announced and acked once', async () => {
  const { h, w, dash, played } = await setup();
  w.reportsOpen = 3;
  w.xp = [
    { id: 'p1', user: IDS.member, xp: 25, game: 'trivia', won: true },
    { id: 'p2', user: IDS.member2, xp: 10, game: 'draw', won: false },
  ];
  await dash.tick();
  await h.settle();
  assert.equal(xpOf(h, IDS.member), 25);
  assert.equal(xpOf(h, IDS.member2), 10);
  assert.deepEqual(played, [
    { user: IDS.member, server_id: null, game: 'trivia', won: true },
    { user: IDS.member2, server_id: null, game: 'draw', won: false },
  ]);
  assert.deepEqual(w.acks, [['p1', 'p2']]);
  assert.equal(dash.reportsOpen, 3);
  assert.equal(h.engine.store.get('season', 'global', {}).xp[IDS.member], 25, 'Party XP counts toward the season');

  await dash.tick();
  assert.equal(w.acks.length, 1, 'nothing left to ack');
  assert.equal(xpOf(h, IDS.member), 25);
});

test('a failed ack never pays the same row twice', async () => {
  const { h, w, dash, played } = await setup();
  w.xp = [{ id: 'p9', user: IDS.member, xp: 15, game: 'hive', won: false }];
  w.ackStatus = [500];
  await dash.tick();
  assert.equal(xpOf(h, IDS.member), 15);
  assert.equal(w.xp.length, 1, 'the Worker still has it');
  await dash.tick();
  assert.equal(xpOf(h, IDS.member), 15, 'not applied again');
  assert.equal(played.length, 1);
  assert.deepEqual(w.acks, [['p9'], ['p9']]);
  assert.equal(w.xp.length, 0);
});

test('bad Party rows are acked without paying anything', async () => {
  const { h, w, dash, played } = await setup();
  w.reportsOpen = -4;
  w.xp = [
    { id: 'b1', user: IDS.member, xp: 9999, game: 'trivia', won: true },
    { id: 'b2', user: 'not a valid id!', xp: 10, game: 'trivia' },
    { id: 'b3', user: IDS.member, xp: 10, game: 'Bad Game!' },
    { id: 'b4', user: IDS.member, xp: 1.5, game: 'odd' },
    { id: 'has space', user: IDS.member, xp: 10, game: 'odd' },
    'nonsense',
    null,
  ];
  await dash.tick();
  assert.equal(xpOf(h, IDS.member), 0);
  assert.equal(played.length, 0);
  assert.deepEqual(w.acks, [['b1', 'b2', 'b3', 'b4']]);
  assert.equal(dash.reportsOpen, 0, 'a nonsense count is ignored');
});

test('Party XP waits when Levels is not loaded', async () => {
  const h = await createHarness({ apps: ['economy'], fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  w.xp = [{ id: 'w1', user: IDS.member, xp: 10, game: 'trivia', won: false }];
  await dash.tick();
  assert.deepEqual(w.acks, [], 'kept for later');
  assert.equal(w.xp.length, 1);
});

test('Party stats are cleaned, cached for a minute and limited to 25 ids', async () => {
  const { h, w, dash } = await setup();
  w.stats = {
    [IDS.member]: { games: 12, wins: 4, fav: 'odd', byGame: { odd: { p: 8, w: 3 }, 'Bad!': { p: 1, w: 1 } }, badges: ['faker-10', 'pangram-5', '<script>', 'pangram-5'] },
    [IDS.member2]: { games: -3, wins: 'lots', fav: 'NOPE!', byGame: [], badges: 'none' },
  };
  const got = await dash.partyStats([IDS.member, IDS.member2, 'bad id!']);
  assert.deepEqual(got[IDS.member], { games: 12, wins: 4, fav: 'odd', byGame: { odd: { p: 8, w: 3 } }, badges: ['faker-10', 'pangram-5'] });
  assert.deepEqual(got[IDS.member2], { games: 0, wins: 0, fav: null, byGame: {}, badges: [] });
  assert.equal(w.statsCalls.length, 1);
  assert.equal(w.statsCalls[0], `${IDS.member},${IDS.member2}`);
  await dash.partyStats([IDS.member]);
  assert.equal(w.statsCalls.length, 1, 'served from the cache');
  h.clock.t += 61_000;
  await dash.partyStats([IDS.member]);
  assert.equal(w.statsCalls.length, 2, 'looked up again after a minute');
  const many = Array.from({ length: 40 }, (_, i) => `u${i}`);
  await dash.partyStats(many);
  assert.equal(w.statsCalls[2].split(',').length, 25);
  w.statsStatus = 500;
  h.clock.t += 61_000;
  assert.deepEqual(await dash.partyStats(['u99']), {}, 'a failed lookup shows nothing');
});

test('Party stats are empty when the dashboard is off', async () => {
  const h = await createHarness({ apps: ['levels'] });
  assert.equal(h.engine.dashboard.enabled, false);
  assert.deepEqual(await h.engine.dashboard.partyStats([IDS.member]), {});
  assert.equal(h.engine.dashboard.reportsOpen, 0);
});
