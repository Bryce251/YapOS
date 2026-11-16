import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { QUESTS, pickQuests, availableQuests, questDay, nextReset, questsView } from '../../apps/quests.js';
import { SEASON_NS, GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const make = (apps = ['levels', 'economy', 'casino', 'quests']) => createHarness({ apps, fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const today = (h) => questDay(h.clock.t);
const give = (h, uid, ids, have = {}) => h.engine.store.set('quests', uid, { day: today(h), quests: ids.map((id) => ({ id, have: have[id] || 0, claimed: false })) });
const questsOf = (h, uid) => h.engine.store.get('quests', uid, null)?.quests || [];
const haveOf = (h, uid, id) => questsOf(h, uid).find((q) => q.id === id)?.have;
const partyOn = (h) => { h.engine.dashboard = { ...h.engine.dashboard, enabled: true }; };

test('everyone gets 3 quests a day from different groups, the same on every server', () => {
  const pool = QUESTS;
  const a = pickQuests(IDS.member, '2026-11-07', pool);
  assert.equal(a.length, 3);
  assert.deepEqual(pickQuests(IDS.member, '2026-11-07', pool), a, 'stable for the day');
  const groups = a.map((id) => QUESTS.find((q) => q.id === id).group);
  assert.equal(new Set(groups).size, 3);
  const days = new Set(Array.from({ length: 10 }, (_, i) => pickQuests(IDS.member, `2026-11-${String(i + 10).padStart(2, '0')}`, pool).join()));
  assert.ok(days.size > 1, 'quests change from day to day');
  assert.deepEqual(pickQuests(IDS.member, '2026-11-07', pool.filter((q) => q.group === 'chat')).length, 2, 'a small pool gives what it can');
  for (const q of QUESTS) assert.ok(q.reward >= 25 && q.reward <= 100, `${q.id} reward is modest`);
  assert.equal(nextReset(Date.parse('2026-11-07T12:00:00Z')), Date.parse('2026-11-08T00:00:00Z'));
});

test('only quests people can actually finish are handed out', async () => {
  const h = await make(['levels', 'economy', 'quests']);
  let ids = availableQuests(h.engine).map((q) => q.id);
  assert.ok(!ids.includes('casino100'), 'no casino quest without the Casino app');
  assert.ok(!ids.includes('party2') && !ids.includes('partywin'), 'no Party quests while the dashboard is off');
  assert.ok(!ids.includes('voice15'), 'no voice quest while voice XP is off');
  assert.ok(ids.includes('msgs30') && ids.includes('daily'));
  partyOn(h);
  ids = availableQuests(h.engine).map((q) => q.id);
  assert.ok(ids.includes('party2') && ids.includes('partywin'));
});

test('messages, /daily and Party wins fill quests, and Claim pays once', async () => {
  const h = await make();
  partyOn(h);
  const eco = h.engine.service('economy');
  give(h, IDS.member, ['msgs30', 'daily', 'partywin'], { msgs30: 28 });
  await h.message('hello there', { user: IDS.member });
  await h.message('/rank', { user: IDS.member });
  assert.equal(haveOf(h, IDS.member, 'msgs30'), 29, 'commands do not count');
  await h.message('one more', { user: IDS.member });
  await h.message('and another', { user: IDS.member });
  assert.equal(haveOf(h, IDS.member, 'msgs30'), 30, 'stops at the goal');
  await h.slash('daily', '', { user: IDS.member });
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'daily'), 1);
  await h.bot.emit('party:played', { user: IDS.member, game: 'trivia', won: false });
  assert.equal(haveOf(h, IDS.member, 'partywin'), 0, 'a loss is not a win');
  await h.bot.emit('party:played', { user: IDS.member, game: 'trivia', won: true });
  assert.equal(haveOf(h, IDS.member, 'partywin'), 1);

  const before = eco.balance(S, IDS.member);
  let ans = await h.slash('quests', '', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /📜 Daily quests/);
  assert.match(text, /Send 30 messages/);
  assert.match(text, /ready to claim!/);
  const claimBtn = h.findButton('Claim 140 Shards', ans);
  assert.ok(claimBtn, 'one button claims every finished quest');

  const stranger = await h.click(claimBtn.custom_id, { user: IDS.member2, messageId: claimBtn.messageId });
  assert.doesNotMatch(lastText(h, stranger), /Daily quests/);
  assert.equal(eco.balance(S, IDS.member), before);

  ans = await h.click(claimBtn.custom_id, { user: IDS.member, messageId: claimBtn.messageId });
  await h.settle();
  assert.equal(eco.balance(S, IDS.member), before + 140);
  assert.ok(questsOf(h, IDS.member).every((q) => q.claimed));
  assert.match(lastText(h, ans), /All done for today/);
  const hist = h.engine.store.get('economy', GLOBAL_KEY, {}).users[IDS.member].hist;
  assert.match(hist[hist.length - 1][2], /^Daily quest: /);
  assert.ok(h.engine.store.get(SEASON_NS, GLOBAL_KEY, {}).shards[IDS.member] >= 140, 'quest rewards count toward the season');

  await h.click(claimBtn.custom_id, { user: IDS.member, messageId: claimBtn.messageId });
  assert.equal(eco.balance(S, IDS.member), before + 140, 'no double pay');
});

test('casino wins, work and XP fill their quests, and quest rewards never feed quests', async () => {
  const h = await make();
  const eco = h.engine.service('economy');
  give(h, IDS.member, ['casino100', 'shards150', 'xp200']);
  eco.add(S, IDS.member, 60, 'Coinflip win');
  eco.add(S, IDS.member, 60, 'Dice win');
  eco.add(S, IDS.member, 500, 'Blackjack bet back');
  eco.add(S, IDS.member, 500, 'Daily quest: Send 30 messages');
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'casino100'), 100);
  assert.equal(haveOf(h, IDS.member, 'shards150'), 0, 'casino, refunds and quest rewards do not count');
  await h.slash('balance', 'work', { user: IDS.member });
  await h.settle();
  assert.ok(haveOf(h, IDS.member, 'shards150') > 0);
  await h.engine.service('levels').addXp(S, IDS.member, 120, 'test');
  await h.engine.service('levels').addXp(null, IDS.member, 25, 'YapOS Party');
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'xp200'), 145);
});

test('a 3-day daily streak and work shifts are tracked', async () => {
  const h = await make();
  give(h, IDS.member, ['streak3', 'work2']);
  await h.slash('daily', '', { user: IDS.member });
  await h.slash('balance', 'work', { user: IDS.member });
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'streak3'), 1);
  assert.equal(haveOf(h, IDS.member, 'work2'), 1);
  h.clock.t += 3600_000 + 1000;
  await h.slash('balance', 'work', { user: IDS.member });
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'work2'), 2);
  h.engine.store.update('economy', GLOBAL_KEY, (d) => { d.users[IDS.member].streak = 2; d.users[IDS.member].lastDaily = h.clock.t - 25 * 3600_000; });
  await h.slash('daily', '', { user: IDS.member });
  await h.settle();
  assert.equal(haveOf(h, IDS.member, 'streak3'), 3);
});

test('new quests arrive at midnight UTC and old ones are cleared away', async () => {
  const h = await make();
  give(h, IDS.member, ['msgs30', 'daily', 'work2'], { msgs30: 30 });
  h.engine.store.set('quests', IDS.member2, { day: '2026-10-01', quests: [] });
  const view = questsView(h.engine, IDS.member, h.clock.t);
  assert.match(view.embeds[0].footer.text, /New quests in 12h/);
  h.clock.t = Date.parse('2026-11-08T00:00:01Z');
  const next = questsView(h.engine, IDS.member, h.clock.t);
  assert.doesNotMatch(h.textOf(next), /ready to claim/);
  assert.equal(h.findButton(/Claim/, [next]), null);
  await h.slash('quests', '', { user: IDS.member });
  assert.equal(h.engine.store.get('quests', IDS.member2, null), null, 'stale quest docs are pruned');
});

test('bots and the bot itself never get quests', async () => {
  const h = await make();
  give(h, IDS.bot, ['msgs30']);
  await h.bot.emit('xp:gained', { user: IDS.bot, amount: 50 });
  await h.message('beep', { user: IDS.member2, authorBot: true });
  assert.equal(h.engine.store.get('quests', IDS.member2, null), null);
});

test('/quests fits the command rules', async () => {
  const h = await make();
  const c = h.bot.commands.get('quests');
  assert.ok(c);
  assert.ok(c.description.length <= 100);
  assert.ok(h.engine.yap.find('quests'));
});
