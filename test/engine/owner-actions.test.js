import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { createOwnerActions, cleanAction, OWNER_NS, OWNER_LOG_KEY } from '../../engine/owner-actions.js';
import { GLOBAL_KEY, canGiveCurrency, seasonBadges } from '../../engine/global.js';
import { setPrivacy } from '../../engine/profile-data.js';

const SECRET = 'test-secret-value-for-owner-actions';
const APPS = ['levels', 'economy', 'quests', 'achievements'];

function fakeWorker() {
  const w = { owner: [], results: [], resultStatus: [], catalogs: [], catalogStatus: [], polls: 0 };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'GET' && u.pathname === '/bot/poll') {
      w.polls++;
      return reply(200, { jobs: [], hot: false, owner: w.owner.slice(0, 50) });
    }
    if (init.method === 'POST' && u.pathname === '/bot/owner/results') {
      const status = w.resultStatus.length ? w.resultStatus.shift() : 200;
      if (status === 200) {
        w.results.push(...body.results);
        const done = new Set(body.results.map((r) => r.id));
        w.owner = w.owner.filter((a) => !done.has(a.id));
      }
      return reply(status, { ok: status === 200 });
    }
    if (init.method === 'POST' && u.pathname === '/bot/owner/catalog') {
      const status = w.catalogStatus.length ? w.catalogStatus.shift() : 200;
      if (status === 200) w.catalogs.push(body);
      return reply(status, { ok: status === 200 });
    }
    if (init.method === 'GET' && u.pathname === '/bot/party/stats') return reply(200, { stats: {} });
    return reply(200, { ok: true });
  };
  w.result = (id) => w.results.filter((r) => r.id === id).at(-1) || null;
  return w;
}

async function setup(apps = APPS) {
  const h = await createHarness({ apps, fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  const earned = [];
  const xp = [];
  h.bot.on('shards:earned', (ev) => { earned.push(ev); });
  h.bot.on('xp:gained', (ev) => { xp.push(ev); });
  return { h, w, dash, earned, xp };
}

const balOf = (h, uid) => h.engine.service('economy').balance(GLOBAL_KEY, uid);
const levelOf = (h, uid) => h.engine.service('levels').getUser(null, uid);
const seasonDoc = (h) => h.engine.store.get('season', GLOBAL_KEY, {});

test('cleanAction checks kinds, amounts and ids', () => {
  assert.equal(cleanAction({ user: IDS.member, kind: 'shards.add', value: 5 }), null);
  assert.match(cleanAction({ id: 'a1', user: 'bad id!', kind: 'shards.add', value: 5 }).error, /user id/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.steal', value: 5 }).error, /kind/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: 'inf' }).error, /Unlimited/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: 1e13 }).error, /between/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: 1.5 }).error, /whole number/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: 0 }).error, /between/);
  assert.equal(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.set', value: 0 }).amount, 0);
  assert.equal(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: '500' }).amount, 500);
  assert.equal(cleanAction({ id: 'a1', user: IDS.member, kind: 'shards.add', value: { amount: 7, notify: true } }).notify, true);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'xp.add', value: 1e9 + 1 }).error, /between/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'streak.set', value: 10_001 }).error, /between/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'achievement.grant', ref: '../x' }).error, /achievement id/);
  assert.match(cleanAction({ id: 'a1', user: IDS.member, kind: 'party.stats.add', value: { games: 1, wins: 1 } }).error, /website/);
  assert.equal(cleanAction({ id: 'a1', user: IDS.member, kind: 'quests.reset' }).kind, 'quests.reset');
});

test('owner Shards are given, taken and set without counting as earned, and each action runs once', async () => {
  const { h, w, dash, earned } = await setup();
  w.owner = [
    { id: 'o1', user: IDS.member, kind: 'shards.add', value: 500 },
    { id: 'o2', user: IDS.member, kind: 'shards.remove', value: 200 },
    { id: 'o3', user: IDS.member2, kind: 'shards.set', value: 1_000_000_000_000 },
  ];
  await dash.tick();
  await h.settle();
  assert.equal(balOf(h, IDS.member), 300);
  assert.equal(balOf(h, IDS.member2), 1_000_000_000_000);
  assert.equal(earned.length, 0, 'not counted as earned, so no quests or season');
  assert.equal(seasonDoc(h).shards?.[IDS.member] ?? 0, 0);
  const hist = h.engine.store.get('economy', GLOBAL_KEY, {}).users[IDS.member].hist;
  assert.deepEqual(hist.map((e) => e[2]), ['Owner gift', 'Owner adjustment']);
  assert.equal(w.result('o1').ok, true);
  assert.match(w.result('o1').message, /Gave 500/);
  assert.match(w.result('o3').message, /1,000,000,000,000/);
  assert.equal(w.owner.length, 0);

  w.owner = [{ id: 'o1', user: IDS.member, kind: 'shards.add', value: 500 }];
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 300, 'a re-sent action is not applied twice');
  assert.equal(w.results.filter((r) => r.id === 'o1').length, 2, 'but its result is sent again');
});

test('a failed results post keeps the results and never re-applies', async () => {
  const { h, w, dash } = await setup();
  w.owner = [{ id: 'r1', user: IDS.member, kind: 'shards.add', value: 50 }];
  w.resultStatus = [500];
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 50);
  assert.equal(w.results.length, 0);
  await dash.tick();
  assert.equal(balOf(h, IDS.member), 50);
  assert.equal(w.result('r1').ok, true);
  await dash.tick();
  assert.equal(w.results.length, 1, 'posted only once it worked');
});

test('applied ids survive a restart and an interrupted action is reported, not repeated', async () => {
  const { h, w } = await setup();
  const first = createOwnerActions(h.engine, { now: h.now });
  await first.run([{ id: 's1', user: IDS.member, kind: 'shards.add', value: 10 }]);
  h.engine.store.update(OWNER_NS, OWNER_LOG_KEY, (d) => { d.s2 = { at: h.now(), state: 'started', user: IDS.member, kind: 'shards.add', posted: false }; return d; }, {});
  const again = createOwnerActions(h.engine, { now: h.now });
  const results = await again.run([
    { id: 's1', user: IDS.member, kind: 'shards.add', value: 10 },
    { id: 's2', user: IDS.member, kind: 'shards.add', value: 10 },
  ]);
  assert.equal(balOf(h, IDS.member), 10);
  const s2 = results.find((r) => r.id === 's2');
  assert.equal(s2.ok, false);
  assert.match(s2.message, /restarted/);
  assert.equal(w.results.length, 0);
});

test('odd actions are refused with a clear message and change nothing', async () => {
  const { h, w, dash } = await setup();
  w.owner = [
    { id: 'b1', user: IDS.member, kind: 'shards.add', value: 'infinity' },
    { id: 'b2', user: IDS.member, kind: 'nuke' },
    { id: 'b3', user: IDS.member, kind: 'achievement.grant', ref: 'not-real' },
    { id: 'b4', user: IDS.member, kind: 'badge.grant', ref: 'made-up' },
    { id: 'b5', user: IDS.bot, kind: 'shards.add', value: 5 },
    { id: 'b6', user: IDS.member, kind: 'level.set', value: 5000 },
    { id: 'b7', user: IDS.member, kind: 'badge.grant', ref: 'season-xp-1-2999-01' },
    { id: 'b8', user: IDS.member, kind: 'party.stats.add', value: { games: 3, wins: 1 } },
  ];
  await dash.tick();
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
    const r = w.result(id);
    assert.equal(r.ok, false, id);
    assert.ok(r.message.length > 5, id);
  }
  assert.equal(balOf(h, IDS.member), 0);
  assert.equal(levelOf(h, IDS.member).level, 0);
  assert.match(w.result('b6').message, /up to 1,000/);
});

test('XP and level changes go through Levels without season XP', async () => {
  const { h, w, dash, xp } = await setup();
  w.owner = [
    { id: 'x1', user: IDS.member, kind: 'xp.add', value: 1000 },
    { id: 'x2', user: IDS.member, kind: 'xp.remove', value: 100 },
    { id: 'x3', user: IDS.member2, kind: 'level.set', value: 12 },
  ];
  await dash.tick();
  await h.settle();
  assert.equal(levelOf(h, IDS.member).xp, 900);
  assert.equal(levelOf(h, IDS.member2).level, 12);
  assert.equal(xp.length, 0, 'no xp:gained, so no quests');
  assert.equal(seasonDoc(h).xp?.[IDS.member] ?? 0, 0);
  assert.match(w.result('x3').message, /level 12/);
});

test('achievements are given without their reward, can be taken and stay taken', async () => {
  const { h, w, dash } = await setup();
  w.owner = [{ id: 'a1', user: IDS.member, kind: 'achievement.grant', ref: 'msgs10k' }];
  await dash.tick();
  await h.settle();
  const ach = h.engine.service('achievements');
  assert.ok(ach.idsOf(IDS.member).includes('msgs10k'));
  assert.equal(balOf(h, IDS.member), 0, 'no reward paid');
  assert.match(w.result('a1').message, /No Shards reward/);

  h.engine.service('levels').ownerLevel(IDS.member, 30);
  w.owner = [{ id: 'a2', user: IDS.member, kind: 'achievement.revoke', ref: 'level10' }];
  await dash.tick();
  await ach.check(IDS.member);
  assert.ok(!ach.idsOf(IDS.member).includes('level10'), 'a revoked one does not unlock again by itself');
  assert.ok(ach.idsOf(IDS.member).includes('level25'));

  w.owner = [{ id: 'a3', user: IDS.member, kind: 'achievement.grant', ref: 'level10' }];
  await dash.tick();
  assert.ok(ach.idsOf(IDS.member).includes('level10'));
});

test('badges, givers, quests and streaks', async () => {
  const { h, w, dash } = await setup();
  w.owner = [
    { id: 'g1', user: IDS.member, kind: 'badge.grant', ref: 'supporter' },
    { id: 'g2', user: IDS.member, kind: 'badge.revoke', ref: 'wins-10' },
    { id: 'g3', user: IDS.member, kind: 'badge.grant', ref: 'season-xp-2-2026-01' },
    { id: 'g4', user: IDS.member, kind: 'giver.grant' },
    { id: 'g5', user: IDS.member, kind: 'streak.set', value: 40 },
    { id: 'g6', user: IDS.member, kind: 'quests.reset' },
  ];
  await dash.tick();
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']) assert.equal(w.result(id).ok, true, `${id}: ${w.result(id).message}`);
  const stats = await dash.partyStats([IDS.member]);
  assert.ok(stats[IDS.member].badges.includes('supporter'));
  assert.ok(seasonBadges(h.engine, IDS.member).some((b) => b.month === '2026-01' && b.rank === 2 && b.kind === 'xp'));
  assert.equal(canGiveCurrency(h.engine, IDS.member), true);
  assert.equal(h.engine.service('economy').streak(IDS.member), 40);

  w.owner = [
    { id: 'g7', user: IDS.member, kind: 'giver.revoke' },
    { id: 'g8', user: IDS.member, kind: 'badge.revoke', ref: 'supporter' },
  ];
  await dash.tick();
  assert.equal(canGiveCurrency(h.engine, IDS.member), false);
  const after = await dash.partyStats([IDS.member]);
  assert.ok(!(after[IDS.member]?.badges || []).includes('supporter'));
});

test('after always tells the owner the numbers and marks what must stay private', async () => {
  const { h, w, dash } = await setup();
  w.owner = [{ id: 'p1', user: IDS.member, kind: 'shards.add', value: 25 }];
  await dash.tick();
  assert.deepEqual(w.result('p1').after, { shards: 25, privateShards: true }, 'Shards are marked private by default');
  setPrivacy(h.engine, IDS.member, { showShards: true });
  w.owner = [{ id: 'p2', user: IDS.member, kind: 'shards.add', value: 25 }];
  await dash.tick();
  assert.deepEqual(w.result('p2').after, { shards: 50 });
  setPrivacy(h.engine, IDS.member, { hidden: true });
  w.owner = [{ id: 'p3', user: IDS.member, kind: 'xp.add', value: 25 }];
  await dash.tick();
  assert.equal(w.result('p3').after.hidden, true, 'hidden profiles are marked hidden');
  assert.equal(w.result('p3').after.xp, 25);
  assert.equal(w.result('p3').after.achievements, undefined);
});

test('gift DMs go out only when asked, and never for removals', async () => {
  const { h, w, dash } = await setup();
  w.owner = [
    { id: 'd1', user: IDS.member, kind: 'shards.add', value: 500, notify: true },
    { id: 'd2', user: IDS.member, kind: 'shards.remove', value: 100, notify: true },
    { id: 'd3', user: IDS.member2, kind: 'shards.add', value: 5 },
  ];
  await dash.tick();
  await h.settle();
  const dms = h.sent().filter((m) => /YapOS team/.test(m.content || ''));
  assert.equal(dms.length, 1);
  assert.match(dms[0].content, /500 💎 Shards/);
  assert.match(w.result('d1').message, /DM/);
});

test('the catalog is pushed once at start and retried if it fails', async () => {
  const { w, dash } = await setup();
  w.catalogStatus = [500];
  await dash.tick();
  await dash.catalogWork;
  assert.equal(w.catalogs.length, 0);
  await dash.tick();
  await dash.catalogWork;
  assert.equal(w.catalogs.length, 1);
  const c = w.catalogs[0];
  assert.ok(c.achievements.some((a) => a.id === 'msgs10k' && a.label && a.emoji && a.reward === 500));
  assert.ok(c.badges.some((b) => b.id === 'supporter' && b.label === 'Supporter'));
  assert.ok(c.badges.some((b) => b.id === 'wins-10'));
  await dash.tick();
  await dash.catalogWork;
  assert.equal(w.catalogs.length, 1);
});

test('the /economy give owner flow still works', async () => {
  const { h, earned } = await setup();
  const before = balOf(h, IDS.member);
  await h.slash('economy', 'give @sam 100', { user: IDS.owner });
  assert.equal(balOf(h, IDS.member) - before, 100);
  assert.equal(earned.length, 0);
});

test('a Shards change from the owner republishes the global board in the same tick, and 0 Shards drops off it', async () => {
  const { h, w, dash } = await setup();
  const boards = [];
  const base = w.fetch;
  w.fetch = async (url, init = {}) => {
    if (init.method === 'PUT' && new URL(url).pathname === '/bot/global') boards.push(JSON.parse(init.body));
    return base(url, init);
  };
  dash.stop();
  const d2 = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.service('economy').add(IDS.server, IDS.member, 5000, 'test');
  await d2.tick();
  assert.equal(boards.length, 1);
  assert.ok(boards[0].economy.some((r) => r.id === IDS.member));
  await d2.tick();
  assert.equal(boards.length, 1, 'no change, no extra publish');
  w.owner = [{ id: 'z1', user: IDS.member, kind: 'shards.set', value: 0 }];
  await d2.tick();
  await h.settle();
  assert.equal(balOf(h, IDS.member), 0);
  assert.equal(boards.length, 2, 'the board is pushed again right away');
  assert.ok(!boards[1].economy.some((r) => r.id === IDS.member), 'someone with 0 Shards is not on the Shards board');
});
