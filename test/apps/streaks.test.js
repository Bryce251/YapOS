import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { streakMilestone, streakTable, nextMilestone, STREAK_DEFAULTS } from '../../apps/economy.js';
import { GLOBAL_KEY } from '../../engine/global.js';
import { customId } from '../../engine/router.js';

const S = IDS.server;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const make = () => createHarness({ apps: ['economy'], fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const userDoc = (h, uid) => h.engine.store.get('economy', GLOBAL_KEY, {}).users?.[uid];
const setStreak = (h, uid, streak) => h.engine.store.update('economy', GLOBAL_KEY, (d) => {
  d.users ||= {};
  d.users[uid] = { bal: 0, streak, lastDaily: h.clock.t - DAY - 60_000, lastWork: 0, inv: {}, hist: [], seen: h.clock.t };
  return d;
}, { users: {} });

test('streak milestones land on days 7, 30, 100 and every 100 after', () => {
  assert.deepEqual(STREAK_DEFAULTS, { 7: 50, 30: 100, 100: 200 });
  assert.equal(streakMilestone(6), null);
  assert.deepEqual(streakMilestone(7), { day: 7, pct: 50 });
  assert.deepEqual(streakMilestone(30), { day: 30, pct: 100 });
  assert.deepEqual(streakMilestone(100), { day: 100, pct: 200 });
  assert.equal(streakMilestone(150), null);
  assert.deepEqual(streakMilestone(300), { day: 100, pct: 200 });
  assert.equal(streakMilestone(7, { 7: 0, 30: 100, 100: 200 }), null, 'a 0% reward is off');
  assert.equal(nextMilestone(3), 7);
  assert.equal(nextMilestone(7), 30);
  assert.equal(nextMilestone(99), 100);
  assert.equal(nextMilestone(100), 200);
  assert.deepEqual(streakTable({ streakRewards: { 7: 9999, 30: -1 } }), { 7: 500, 30: 0, 100: 200 });
});

test('day 7 pays the daily plus a one-time 50% streak reward, and says so', async () => {
  const h = await make();
  setStreak(h, IDS.member, 6);
  const ans = await h.slash('daily', '', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /\+220 Shards \(day 7 streak 🔥\)/);
  assert.match(text, /7-day streak reward!\*\* \+50 bonus Shards/);
  const u = userDoc(h, IDS.member);
  assert.equal(u.bal, 220);
  assert.equal(u.hist[u.hist.length - 1][2], 'Streak reward (day 7)');
  assert.equal(u.hist[u.hist.length - 1][1], 50);

  await h.advance(DAY + 60_000);
  const day8 = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, day8), /\+180 Shards \(day 8 streak 🔥\)/);
  assert.doesNotMatch(lastText(h, day8), /streak reward!/);
});

test('day 30 and day 100 pay bigger rewards, and a hint shows a few days before', async () => {
  const h = await make();
  setStreak(h, IDS.member, 26);
  const soon = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, soon), /Streak reward in 3 days \(day 30\)/);

  setStreak(h, IDS.member, 29);
  const day30 = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, day30), /\+300 Shards \(day 30 streak 🔥\)/);
  assert.match(lastText(h, day30), /30-day streak reward!\*\* \+100 bonus/);

  setStreak(h, IDS.member2, 99);
  const day100 = await h.slash('daily', '', { user: IDS.member2 });
  assert.match(lastText(h, day100), /\+400 Shards \(day 100 streak 🔥\)/);
  assert.match(lastText(h, day100), /100-day streak reward!\*\* \+200 bonus/);
});

test('only the owner tunes streak rewards, and the new rates apply', async () => {
  const h = await make();
  const no = await h.slash('economy', 'streak 7 100', { user: IDS.admin });
  assert.match(lastText(h, no), /Only the bot owner/);
  const bad = await h.slash('economy', 'streak 7 lots', { user: IDS.owner });
  assert.match(lastText(h, bad), /didn't work/);
  const ok = await h.slash('economy', 'streak 7 100', { user: IDS.owner });
  assert.match(lastText(h, ok), /Streak rewards saved/);
  assert.deepEqual(streakTable(h.engine.settings.appConfig(GLOBAL_KEY, 'economy')), { 7: 100, 30: 100, 100: 200 });
  await h.slash('economy', 'streak 10 20 30', { user: IDS.owner });
  assert.deepEqual(streakTable(h.engine.settings.appConfig(GLOBAL_KEY, 'economy')), { 7: 10, 30: 20, 100: 30 });

  setStreak(h, IDS.member, 6);
  const ans = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, ans), /\+10 bonus/);

  const panel = await h.slash('economy', '', { user: IDS.owner });
  assert.match(lastText(h, panel), /Streak rewards/);
  assert.match(lastText(h, panel), /day 7 \+10%/);
  assert.ok(h.findButton('Streak rewards', panel));
});

test('the Party pay settings are owner-only, clamped and pushed to the dashboard', async () => {
  const h = await make();
  const pushed = [];
  h.engine.dashboard = { ...h.engine.dashboard, pushPartyRates: async () => { pushed.push(true); return true; } };
  const eco = h.engine.service('economy');
  assert.deepEqual(eco.partyRates(), { play: 5, win: 15, tournament: 25, prediction: 5, cap: 150 });
  const no = await h.slash('economy', 'party 50 50 50 50 500', { user: IDS.admin });
  assert.match(lastText(h, no), /Only the bot owner/);
  assert.equal(pushed.length, 0);
  const tooMuch = await h.slash('economy', 'party win 999', { user: IDS.owner });
  assert.match(lastText(h, tooMuch), /0 to 200/);
  const ok = await h.slash('economy', 'party 4 20 30 6 120', { user: IDS.owner });
  assert.match(lastText(h, ok), /Party rates saved/);
  assert.deepEqual(eco.partyRates(), { play: 4, win: 20, tournament: 30, prediction: 6, cap: 120 });
  await h.slash('economy', 'party win 25', { user: IDS.owner });
  assert.equal(eco.partyRates().win, 25);
  assert.equal(pushed.length, 2);
  const form = await h.submit(customId('economy', 'partysave'), { play: '5', win: '15', tournament: '25', prediction: '5', cap: '150' }, { user: IDS.owner });
  assert.match(lastText(h, form), /Party rates saved/);
  assert.equal(eco.partyRates().cap, 150);
});
