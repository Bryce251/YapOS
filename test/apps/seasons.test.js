import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { seasonMonth, seasonName, seasonEndsAt, seasonTop, addSeason, rollSeason, seasonBoard, seasonBadges, seasonBadgeText, SEASON_NS, GLOBAL_KEY, patchGlobalConfig } from '../../engine/global.js';
import { partyText, partyGameName, partyBadgeName } from '../../apps/levels.js';
import { earnSource } from '../../apps/economy.js';

const S = IDS.server;
const make = (apps = ['levels', 'economy']) => createHarness({ apps, fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const seasonDoc = (h) => h.engine.store.get(SEASON_NS, GLOBAL_KEY, {});
const uid = (n) => `a0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

test('season months, names and the end of the month are UTC', () => {
  assert.equal(seasonMonth(Date.parse('2026-11-30T23:59:59Z')), '2026-11');
  assert.equal(seasonMonth(Date.parse('2026-12-01T00:00:00Z')), '2026-12');
  assert.equal(seasonName('2026-11'), 'November 2026');
  assert.equal(seasonName('junk'), 'this season');
  assert.equal(seasonEndsAt(Date.parse('2026-12-15T10:00:00Z')), Date.parse('2027-01-01T00:00:00Z'));
  assert.deepEqual(seasonTop({ a: 5, b: 9, c: 0, d: 'x', e: 5 }, 3), [['b', 9], ['a', 5], ['e', 5]]);
  assert.equal(seasonBadgeText({ month: '2026-10', kind: 'xp', rank: 1 }), '🥇 #1 XP · October 2026');
  assert.equal(seasonBadgeText({ month: '2026-10', kind: 'shards', rank: 7 }), '🏅 #7 Shards · October 2026');
});

test('XP earned counts toward the season, admin changes do not, and the month end keeps levels and Shards', async () => {
  const h = await make();
  patchGlobalConfig(h.engine, 'economy', { activityPay: { chat: 0, voice: 0, levelup: 0, weekly: 500 } });
  const levels = h.engine.service('levels');
  const eco = h.engine.service('economy');
  await levels.addXp(S, IDS.member, 300, 'test');
  await levels.addXp(S, IDS.member2, 120, 'test');
  await levels.addXp(S, IDS.member, -50, 'test');
  for (let i = 0; i < 12; i++) await levels.addXp(S, uid(i), 10 + i, 'test');
  eco.add(S, IDS.member, 500, 'Trivia win');
  eco.add(S, IDS.member2, 900, 'Coinflip win');
  eco.add(S, IDS.member2, 900, 'Game win');
  await h.settle();
  const doc = seasonDoc(h);
  assert.equal(doc.month, '2026-11');
  assert.equal(doc.xp[IDS.member], 300, 'losing XP does not lower the season');
  assert.equal(doc.shards[IDS.member], 500, 'trivia prizes count');
  assert.equal(doc.shards[IDS.member2], undefined, 'casino and bet pots do not count');

  const xpBefore = levels.getUser(S, IDS.member).xp;
  const balBefore = eco.balance(S, IDS.member);
  await h.advanceTo('2026-12-01T00:00:30Z');
  const after = seasonDoc(h);
  assert.equal(after.month, '2026-12');
  assert.deepEqual(after.xp, {});
  assert.deepEqual(after.shards, {});
  assert.equal(levels.getUser(S, IDS.member).xp, xpBefore, 'levels never reset');
  assert.equal(eco.balance(S, IDS.member), balBefore, 'wallets never reset');
  assert.deepEqual(seasonBadges(h.engine, IDS.member).map((b) => [b.month, b.kind, b.rank]), [['2026-11', 'xp', 1], ['2026-11', 'shards', 1]]);
  assert.deepEqual(seasonBadges(h.engine, IDS.member2).map((b) => [b.kind, b.rank]), [['xp', 2]]);
  const xpWinners = Object.entries(after.badges).filter(([, list]) => list.some((b) => b.kind === 'xp')).length;
  assert.equal(xpWinners, 10, 'only the top 10 get a badge');
  assert.deepEqual(seasonBadges(h.engine, uid(0)), [], 'eleventh place and below get nothing');
  assert.equal(after.history['2026-11'].xp.length, 10);
  assert.equal(h.sent().length, 0, 'the month end posts nothing anywhere');

  assert.equal(rollSeason(h.engine), null, 'closing twice does nothing');
  assert.equal(seasonBadges(h.engine, IDS.member).length, 2);
});

test('a missed month end still closes the right season the next time anyone earns', async () => {
  const h = await make(['economy']);
  addSeason(h.engine, 'shards', IDS.member, 40, Date.parse('2026-11-20T00:00:00Z'));
  addSeason(h.engine, 'shards', IDS.member2, 70, Date.parse('2027-02-03T00:00:00Z'));
  const doc = seasonDoc(h);
  assert.equal(doc.month, '2027-02');
  assert.deepEqual(doc.shards, { [IDS.member2]: 70 });
  assert.deepEqual(seasonBadges(h.engine, IDS.member).map((b) => [b.month, b.kind, b.rank, b.score]), [['2026-11', 'shards', 1, 40]]);
  const board = seasonBoard(h.engine, 'shards', Date.parse('2027-02-04T00:00:00Z'));
  assert.deepEqual(board.list, [{ id: IDS.member2, score: 70 }]);
});

test('/leaderboard season shows this month and the tab buttons switch boards', async () => {
  const h = await make();
  const levels = h.engine.service('levels');
  await levels.addXp(S, IDS.member, 80, 'test');
  await levels.addXp(S, IDS.member2, 200, 'test');
  let ans = await h.slash('leaderboard', 'season', { user: IDS.member });
  let text = lastText(h, ans);
  assert.match(text, /Season leaderboard · November 2026/);
  assert.match(text, /🥇 \*\*Riley\*\* · 200 XP this month/);
  assert.match(text, /🥈 \*\*Sam\*\* · 80 XP this month {2}◂ you/);
  assert.match(text, /Levels never reset/);
  assert.deepEqual(h.allButtons(ans).map((b) => b.label), ['Sort by XP', 'Sort by voice time']);
  ans = await h.slash('leaderboard', 'season', { user: IDS.mod });
  assert.match(lastText(h, ans), /You haven't earned XP this month yet/);
  ans = await h.slash('leaderboard', '', { user: IDS.member });
  const tab = h.findButton('This season', ans);
  assert.ok(tab);
  ans = await h.click(tab.custom_id, { user: IDS.member, messageId: tab.messageId });
  assert.match(lastText(h, ans), /Season leaderboard/);
});

test('/rank shows season badges and the YapOS Party section', async () => {
  const h = await make();
  const levels = h.engine.service('levels');
  await levels.addXp(S, IDS.member, 150, 'test');
  h.clock.t = Date.parse('2026-12-02T12:00:00Z');
  rollSeason(h.engine);
  await levels.addXp(S, IDS.member, 30, 'test');
  const asked = [];
  h.engine.dashboard = { ...h.engine.dashboard, partyStats: async (ids) => { asked.push(ids); return { [IDS.member]: { games: 7, wins: 3, fav: 'odd', byGame: {}, badges: ['faker-10', 'pangram-5', 'someNewBadge'] } }; } };
  const ans = await h.slash('rank', '', { user: IDS.member });
  const text = lastText(h, ans);
  assert.deepEqual(asked, [[IDS.member]]);
  assert.match(text, /🗓️ Season/);
  assert.match(text, /This month: `30 XP` · #1/);
  assert.match(text, /🥇 #1 XP · November 2026/);
  assert.match(text, /🎉 YapOS Party/);
  assert.match(text, /`7` games · `3` wins/);
  assert.match(text, /Favorite: 🕵️ Odd One Out/);
  assert.match(text, /🕵️ Faker caught 10 times · 🐝 Pangram hunter · 🎖️ Some New Badge/);
});

test('/rank still answers when Party stats are slow or missing', async () => {
  const h = await make();
  await h.engine.service('levels').addXp(S, IDS.member, 50, 'test');
  h.engine.dashboard = { ...h.engine.dashboard, partyStats: async () => { throw new Error('down'); } };
  let ans = await h.slash('rank', '', { user: IDS.member });
  assert.doesNotMatch(lastText(h, ans), /YapOS Party/);
  h.engine.dashboard = { ...h.engine.dashboard, partyStats: async () => ({ [IDS.member]: { games: 0, wins: 0, fav: null, byGame: {}, badges: [] } }) };
  ans = await h.slash('rank', '', { user: IDS.member });
  assert.doesNotMatch(lastText(h, ans), /YapOS Party/, 'nobody sees an empty Party section');
});

test('Party XP has no server, so it never posts a level-up anywhere', async () => {
  const h = await make();
  const res = await h.engine.service('levels').addXp(null, IDS.member, 5000, 'YapOS Party');
  await h.settle();
  assert.ok(res.leveledUp);
  assert.equal(h.sent().length, 0);
});

test('Party labels fall back to readable names', () => {
  assert.equal(partyGameName('hive'), '🐝 Letter Hive');
  assert.equal(partyGameName('mysteryGame'), 'Mystery Game');
  assert.equal(partyBadgeName('pangram-5'), '🐝 Pangram hunter');
  assert.equal(partyBadgeName('wins_25'), '🎖️ Wins 25');
  assert.equal(partyText(null), null);
  assert.equal(partyText({ games: 1, wins: 1, fav: null, badges: [] }), '`1` game · `1` win');
});

test('Shards earned through daily and work count toward the Shards season', async () => {
  const h = await make();
  const earned = [];
  const daily = [];
  h.bot.on('shards:earned', (ev) => { earned.push(ev); });
  h.bot.on('economy:daily', (ev) => { daily.push(ev); });
  await h.slash('daily', '', { user: IDS.member });
  await h.slash('balance', 'work', { user: IDS.member });
  await h.settle();
  const doc = seasonDoc(h);
  const total = earned.filter((e) => e.user === IDS.member).reduce((n, e) => n + e.amount, 0);
  assert.ok(total > 0);
  assert.equal(doc.shards[IDS.member], total);
  assert.deepEqual(earned.map((e) => e.source), ['daily', 'work']);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].streak, 1);
  const ans = await h.slash('balance', 'season', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /Shards season · November 2026/);
  assert.match(text, /You: \*\*#1\*\* of 1/);
  assert.match(text, /Nobody's wallet resets/);
  const top = await h.slash('balance', 'top', { user: IDS.member });
  assert.ok(h.findButton('This season', top));
});

test('earn sources sort casino, quests, Party and games apart', () => {
  assert.equal(earnSource('Slots win'), 'casino');
  assert.equal(earnSource('Blackjack bet back'), 'other');
  assert.equal(earnSource('Daily quest: Send 30 messages'), 'quest');
  assert.equal(earnSource('YapOS Party'), 'party');
  assert.equal(earnSource('Game win'), 'game');
  assert.equal(earnSource('Trivia win'), 'game');
  assert.equal(earnSource(undefined), 'other');
});

test('a clock that jumps back a month never wipes or merges the season', async () => {
  const h = await make();
  addSeason(h.engine, 'xp', IDS.member, 50, Date.parse('2026-12-05T00:00:00Z'));
  assert.equal(rollSeason(h.engine, Date.parse('2026-11-30T00:00:00Z')), null);
  addSeason(h.engine, 'xp', IDS.member, 10, Date.parse('2026-11-30T00:00:00Z'));
  assert.equal(seasonDoc(h).month, '2026-12');
  assert.equal(seasonDoc(h).xp[IDS.member], 60);
  const closed = rollSeason(h.engine, Date.parse('2027-01-01T00:00:01Z'));
  assert.equal(closed.month, '2026-12');
  assert.equal(seasonBadges(h.engine, IDS.member).length, 1);
});
