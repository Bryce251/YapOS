import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const SECRET = 'test-secret-value-for-party-shards';

function fakeWorker() {
  const w = { xp: [], shards: [], acks: [], ackStatus: [], rates: [], ratesStatus: [] };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'GET' && u.pathname === '/bot/poll') return reply(200, { jobs: [], hot: false, party: { xp: w.xp.slice(0, 100), shards: w.shards.slice(0, 100), reportsOpen: 0 } });
    if (init.method === 'POST' && u.pathname === '/bot/party/ack') {
      w.acks.push(body);
      const status = w.ackStatus.length ? w.ackStatus.shift() : 200;
      if (status === 200) {
        w.xp = w.xp.filter((r) => !(body.ids || []).includes(String(r.id)));
        w.shards = w.shards.filter((r) => !(body.shardIds || []).includes(String(r.id)));
      }
      return reply(status, { ok: status === 200 });
    }
    if (init.method === 'POST' && u.pathname === '/bot/party/rates') {
      w.rates.push(body);
      const status = w.ratesStatus.length ? w.ratesStatus.shift() : 200;
      return reply(status, { ok: status === 200 });
    }
    return reply(200, { ok: true });
  };
  return w;
}

async function setup(apps = ['levels', 'economy', 'quests']) {
  const h = await createHarness({ apps, fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  const earned = [];
  h.bot.on('shards:earned', (ev) => { earned.push(ev); });
  return { h, w, dash, earned };
}

const balOf = (h, uid) => h.engine.service('economy').balance(GLOBAL_KEY, uid);
const histOf = (h, uid) => h.engine.store.get('economy', GLOBAL_KEY, {}).users?.[uid]?.hist || [];

test('Party Shards rows are paid as earned Shards with the YapOS Party reason and acked with shardIds', async () => {
  const { h, w, dash, earned } = await setup();
  w.xp = [{ id: 'x1', user: IDS.member, xp: 20, game: 'trivia', won: true }];
  w.shards = [
    { id: 's1', user: IDS.member, shards: 5, reason: 'play', game: 'trivia' },
    { id: 's2', user: IDS.member, shards: 15, reason: 'win', game: 'trivia' },
    { id: 's3', user: IDS.member2, shards: 5, reason: 'prediction', game: null },
    { id: 's4', user: IDS.member2, shards: 25, reason: 'tournament', game: 'tournament' },
  ];
  await dash.tick();
  await h.settle();
  assert.equal(balOf(h, IDS.member), 20);
  assert.equal(balOf(h, IDS.member2), 30);
  const last = histOf(h, IDS.member).at(-1);
  assert.equal(last[2], 'YapOS Party');
  assert.ok(earned.every((e) => e.source === 'party'), 'counted as Party earnings for quests');
  assert.equal(h.engine.store.get('season', 'global', {}).shards[IDS.member], 20, 'Party Shards count toward the season');
  assert.equal(w.acks.length, 1);
  assert.deepEqual(w.acks[0].ids, ['x1']);
  assert.deepEqual(w.acks[0].shardIds, ['s1', 's2', 's3', 's4']);
  assert.equal(w.shards.length, 0);

  await dash.tick();
  assert.equal(w.acks.length, 1, 'nothing left to ack');
  assert.equal(balOf(h, IDS.member), 20);
});

test('a failed ack never pays the same Shards twice', async () => {
  const { h, w, dash } = await setup();
  w.shards = [{ id: 's9', user: IDS.member, shards: 15, reason: 'win', game: 'hive' }];
  w.ackStatus = [500];
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 15);
  assert.equal(w.shards.length, 1, 'the Worker still has it');
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 15, 'not paid again');
  assert.deepEqual(w.acks.map((a) => a.shardIds), [['s9'], ['s9']]);
  assert.equal(w.shards.length, 0);
  assert.deepEqual(h.engine.store.get('party', 'appliedShards', []), ['s9'], 'the paid id is remembered across restarts');
});

test('bad Shards rows are acked and dropped without paying anyone', async () => {
  const { h, w, dash } = await setup();
  w.shards = [
    { id: 'b1', user: IDS.member, shards: 0, reason: 'win', game: 'trivia' },
    { id: 'b2', user: IDS.member, shards: 10001, reason: 'win', game: 'trivia' },
    { id: 'b3', user: '../etc', shards: 5, reason: 'win', game: 'trivia' },
    { id: 'b4', user: IDS.member, shards: 5, reason: 'gift', game: 'trivia' },
    { id: 'b5', user: IDS.member, shards: 2.5, reason: 'play', game: 'trivia' },
    { id: 'ok', user: IDS.member, shards: 5, reason: 'play', game: 'BAD GAME NAME' },
    'nonsense',
  ];
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 5, 'only the good row pays, even with an odd game name');
  assert.deepEqual(w.acks[0].shardIds.sort(), ['b1', 'b2', 'b3', 'b4', 'b5', 'ok'].sort());
});

test('without the Economy app Shards rows wait instead of being dropped', async () => {
  const { h, w, dash } = await setup(['levels']);
  w.shards = [{ id: 'w1', user: IDS.member, shards: 5, reason: 'play', game: 'trivia' }];
  await dash.tick();
  assert.equal(w.acks.length, 0);
  assert.equal(w.shards.length, 1);
  assert.equal(h.engine.store.get('party', 'appliedShards', []).length, 0);
});

test('a payment that throws is not remembered, so it is tried again', async () => {
  const { h, w, dash } = await setup();
  const eco = h.engine.service('economy');
  const realAdd = eco.add;
  let fail = true;
  eco.add = (...args) => {
    if (fail) throw new Error('disk full');
    return realAdd(...args);
  };
  w.shards = [{ id: 'r1', user: IDS.member, shards: 5, reason: 'play', game: 'trivia' }];
  await dash.tick();
  assert.equal(w.acks.length, 0);
  assert.deepEqual(h.engine.store.get('party', 'appliedShards', []), []);
  fail = false;
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 5);
  assert.deepEqual(w.acks[0].shardIds, ['r1']);
  eco.add = realAdd;
});

test('the owner Party rates go to the Worker on the first poll and again when they change', async () => {
  const { h, w, dash } = await setup();
  await dash.tick();
  await dash.ratesWork;
  assert.deepEqual(w.rates, [{ play: 25, win: 100, tournament: 500, prediction: 50 }]);
  await dash.tick();
  await dash.ratesWork;
  assert.equal(w.rates.length, 1, 'sent once, not every poll');

  dash.start();
  await h.slash('economy', 'party 4 20 30 6', { user: IDS.owner });
  await h.settle();
  assert.deepEqual(w.rates.at(-1), { play: 4, win: 20, tournament: 30, prediction: 6 });
  dash.stop();
});

test('a failed rates push is retried on the next poll', async () => {
  const { w, dash } = await setup();
  w.ratesStatus = [503];
  await dash.tick();
  await dash.ratesWork;
  assert.equal(w.rates.length, 1);
  await dash.tick();
  await dash.ratesWork;
  assert.equal(w.rates.length, 2);
  await dash.tick();
  await dash.ratesWork;
  assert.equal(w.rates.length, 2);
});

test('the bot pays every Party Shards row with no daily cap, daily puzzle and streak rows included', async () => {
  const { h, w, dash } = await setup();
  w.shards = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, user: IDS.member, shards: 25, reason: 'win', game: 'trivia' }));
  w.shards.push({ id: 'd1', user: IDS.member, shards: 25, reason: 'daily', game: 'hive' }, { id: 'k1', user: IDS.member, shards: 20, reason: 'streak', game: 'daily' });
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 12 * 25 + 25 + 20, 'no daily cap');
  assert.equal(w.acks[0].shardIds.length, 14);
  assert.equal(w.shards.length, 0);
  assert.equal(h.engine.store.get('party', 'shardDay', null), null, 'no per-day counter is kept');
});

test('rates are not pushed when the Economy app is not loaded', async () => {
  const { w, dash } = await setup(['levels']);
  await dash.tick();
  await dash.ratesWork;
  assert.equal(w.rates.length, 0);
});

test('the bot pays 2nd place, win streak and big tournament rows at the new rates', async () => {
  const { h, w, dash } = await setup();
  w.shards = [
    { id: 'p1', user: IDS.member, shards: 50, reason: 'place', game: 'trivia' },
    { id: 'p2', user: IDS.member, shards: 100, reason: 'winstreak', game: 'trivia' },
    { id: 'p3', user: IDS.member, shards: 5000, reason: 'tournament', game: 'tournament' },
    { id: 'p4', user: IDS.member, shards: 1000, reason: 'win', game: 'trivia' },
  ];
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 50 + 100 + 5000 + 1000);
  assert.deepEqual(w.acks[0].shardIds.sort(), ['p1', 'p2', 'p3', 'p4']);
});

test('the bot pushes the new defaults when its saved rates are still the old defaults', async () => {
  const { h, w, dash } = await setup();
  await h.slash('economy', 'party 10 25 100 15', { user: IDS.owner });
  await dash.tick();
  await dash.ratesWork;
  assert.deepEqual(w.rates.at(-1), { play: 25, win: 100, tournament: 500, prediction: 50 });
});
