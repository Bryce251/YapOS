import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { seasonSync, dropSeasonSync, cleanBoards, SEASON_EVENT } from '../../engine/seasons-sync.js';
import { addSeason, rollSeason } from '../../engine/global.js';
import { setPrivacy } from '../../engine/profile-data.js';

function fakeWorker() {
  const w = { seasons: [], status: [] };
  w.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const status = w.status.length ? w.status.shift() : 200;
    if (path === '/bot/seasons') w.seasons.push(JSON.parse(init.body));
    return { ok: status === 200, status, text: async () => '{}' };
  };
  return w;
}

async function make() {
  const h = await createHarness({ apps: ['levels', 'economy', 'profile'], fakeClock: true });
  h.clock.t = Date.parse('2026-10-20T12:00:00Z');
  h.engine.config.dashboardUrl = 'https://yapos.test';
  h.engine.config.dashboardSecret = 'test-secret';
  const w = fakeWorker();
  dropSeasonSync(h.engine);
  const sync = seasonSync(h.engine, { fetch: w.fetch });
  sync.install();
  return { h, w, sync };
}

test('seasons-sync: boards are cleaned to rank, id, name, username and value', () => {
  const b = cleanBoards({ xp: [['u-1', 50], { id: 'u-2', score: 20, name: 'Bo' }, { id: 'bad id!' }], shards: 'nope' });
  assert.deepEqual(b.xp, [{ rank: 1, id: 'u-1', name: null, username: null, value: 50 }, { rank: 2, id: 'u-2', name: 'Bo', username: null, value: 20 }]);
  assert.deepEqual(b.shards, []);
});

test('seasons-sync: a season:closed event pushes the month with names filled in', async () => {
  const { h, w } = await make();
  await h.bot.emit(SEASON_EVENT, {
    month: '2026-10',
    boards: {
      xp: [{ rank: 1, id: IDS.member, name: 'Sam', username: 'sam', value: 900 }, { rank: 2, id: IDS.member2, value: 400 }],
      shards: [{ rank: 1, id: IDS.member2, name: 'Riley', username: 'riley', value: 1200 }],
    },
  });
  assert.equal(w.seasons.length, 1);
  const sent = w.seasons[0];
  assert.equal(sent.month, '2026-10');
  assert.deepEqual(sent.boards.xp[0], { rank: 1, id: IDS.member, name: 'Sam', username: 'sam', value: 900 });
  assert.equal(sent.boards.xp[1].id, IDS.member2);
  assert.equal(typeof sent.boards.xp[1].name, 'string');
  assert.deepEqual(sent.boards.shards, [{ rank: 1, id: IDS.member2, name: 'Riley', username: 'riley', value: 1200 }]);
});

test('seasons-sync: months that closed while offline come from the season history, once', async () => {
  const { h, w, sync } = await make();
  addSeason(h.engine, 'xp', IDS.member, 300);
  addSeason(h.engine, 'shards', IDS.member2, 80);
  h.clock.t = Date.parse('2027-03-02T00:00:00Z');
  const closed = rollSeason(h.engine);
  assert.ok(closed?.month);
  await sync.push();
  assert.equal(w.seasons.length, 1);
  assert.equal(w.seasons[0].month, closed.month);
  assert.equal(w.seasons[0].boards.xp[0].id, IDS.member);
  assert.equal(w.seasons[0].boards.xp[0].value, 300);
  assert.equal(w.seasons[0].boards.shards[0].id, IDS.member2);
  await sync.push();
  assert.equal(w.seasons.length, 1, 'a month is sent only once');
});

test('seasons-sync: a failed upload waits in the outbox and goes out later', async () => {
  const { h, w, sync } = await make();
  w.status.push(500);
  await h.bot.emit(SEASON_EVENT, { month: '2026-09', boards: { xp: [{ id: IDS.member, value: 10 }], shards: [] } });
  assert.equal(sync.waiting, 1);
  await sync.push();
  assert.equal(sync.waiting, 0);
  assert.equal(w.seasons.length, 2);
  assert.equal(w.seasons[1].month, '2026-09');
});

test('seasons-sync: bad events are ignored', async () => {
  const { h, w, sync } = await make();
  await h.bot.emit(SEASON_EVENT, { month: 'last month', boards: {} });
  await h.bot.emit(SEASON_EVENT, null);
  assert.equal(sync.waiting, 0);
  assert.equal(w.seasons.length, 0);
});

test('seasons-sync: people who hid their profile show as a hidden player on the public board', async () => {
  const { h, w } = await make();
  setPrivacy(h.engine, IDS.member, { hidden: true });
  await h.bot.emit(SEASON_EVENT, { month: '2026-08', boards: { xp: [{ rank: 1, id: IDS.member, name: 'Sam', username: 'sam', value: 900 }], shards: [] } });
  assert.deepEqual(w.seasons[0].boards.xp[0], { rank: 1, id: IDS.member, name: 'Hidden player', username: null, value: 900 });
});
