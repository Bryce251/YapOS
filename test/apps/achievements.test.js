import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { ACHIEVEMENTS, rewardOf, scanTickets, evaluate, statsOf } from '../../apps/achievements.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const make = (apps = ['economy', 'levels', 'quests', 'clans', 'achievements']) => createHarness({ apps, fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const eco = (h) => h.engine.service('economy');
const got = (h, uid) => h.engine.service('achievements').list(uid);
const dmsTo = (h, uid) => h.sent(`d${uid.slice(1)}`);

test('the achievement list covers the brief with small one-time rewards', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  for (const id of ['msgs1k', 'msgs10k', 'casino50', 'tickets100', 'streak30', 'level25', 'level50', 'party100', 'quests50', 'clanfound']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of ACHIEVEMENTS) assert.ok(a.reward > 0 && a.reward <= 1000, `${a.id} reward is modest`);
});

test('reaching 1,000 messages unlocks once, pays once and DMs privately', async () => {
  const h = await make();
  h.engine.store.update('levels', GLOBAL_KEY, (d) => { d.users ||= {}; d.users[IDS.member] = { xp: 10, level: 0, voiceSeconds: 0, messages: 999, lastXpAt: 0 }; return d; }, { users: {} });
  const channelBefore = h.sent(IDS.channels.general).length;
  await h.message('this one makes a thousand', { user: IDS.member });
  await h.settle();
  assert.deepEqual(got(h, IDS.member), ['msgs1k']);
  const reward = rewardOf(h.engine, 'msgs1k');
  assert.equal(eco(h).balance(S, IDS.member), reward);
  const dms = dmsTo(h, IDS.member);
  assert.equal(dms.length, 1);
  assert.match(h.textOf(dms[0]), /Achievement unlocked!/);
  assert.match(h.textOf(dms[0]), /Chatterbox/);
  assert.equal(h.sent(IDS.channels.general).length, channelBefore, 'never posts in channels');

  await h.advance(2 * 60_000);
  await h.message('and another one here', { user: IDS.member });
  await h.settle();
  assert.equal(eco(h).balance(S, IDS.member), reward, 'paid only once');
  assert.equal(dmsTo(h, IDS.member).length, 1);
});

test('casino wins, quests, Party games and streaks are counted from events', async () => {
  const h = await make();
  for (let i = 0; i < 49; i++) eco(h).add(S, IDS.member, 10, 'Slots win');
  eco(h).add(S, IDS.member, 10, 'Work');
  await h.settle();
  assert.equal(statsOf(h.engine, IDS.member).casino, 49);
  assert.ok(!got(h, IDS.member).includes('casino50'));
  eco(h).add(S, IDS.member, 10, 'Blackjack win');
  await h.settle();
  assert.ok(got(h, IDS.member).includes('casino50'));

  for (let i = 0; i < 10; i++) eco(h).add(S, IDS.member2, 25, 'Daily quest: Claim your /daily');
  await h.settle();
  assert.ok(got(h, IDS.member2).includes('quests10'));

  for (let i = 0; i < 10; i++) await h.bot.emit('party:played', { user: IDS.admin, game: 'trivia', won: i < 3 });
  await h.settle();
  assert.ok(got(h, IDS.admin).includes('party10'));
  assert.equal(statsOf(h.engine, IDS.admin).partyWins, 3);

  await h.bot.emit('economy:daily', { user: IDS.mod, streak: 7 });
  await h.settle();
  assert.ok(got(h, IDS.mod).includes('streak7'));
  assert.ok(!got(h, IDS.mod).includes('streak30'));
});

test('founding and joining a clan unlock their achievements', async () => {
  const h = await make();
  eco(h).add(GLOBAL_KEY, IDS.member, 600, 'Test funds');
  await h.slash('clan', 'create Night Owls OWL', { user: IDS.member });
  await h.settle();
  assert.ok(got(h, IDS.member).includes('clanfound'));
  await h.slash('clan', 'invite @riley', { user: IDS.member });
  await h.slash('clan', 'accept', { user: IDS.member2 });
  await h.settle();
  assert.ok(got(h, IDS.member2).includes('clanjoin'));
  assert.ok(!got(h, IDS.member2).includes('clanfound'));
});

test('ticket openers are counted from the tickets data, each ticket once', async () => {
  const h = await make();
  const tickets = {};
  for (let n = 1; n <= 99; n++) tickets[n] = { number: n, openerId: IDS.member, status: 'closed', createdAt: n };
  h.engine.store.set('tickets', S, { seq: 99, tickets });
  assert.deepEqual(scanTickets(h.engine, S), [IDS.member]);
  assert.equal(statsOf(h.engine, IDS.member).tickets, 99);
  assert.deepEqual(scanTickets(h.engine, S), [], 'nothing new, nothing counted');
  h.engine.store.update('tickets', S, (d) => { d.tickets[100] = { number: 100, openerId: IDS.member, status: 'open', createdAt: 100 }; return d; }, {});
  scanTickets(h.engine, S);
  await evaluate(h.engine, IDS.member);
  assert.ok(got(h, IDS.member).includes('tickets100'));
  assert.equal(statsOf(h.engine, IDS.member).tickets, 100);
});

test('/achievements lists progress, marks new ones and can turn DMs off', async () => {
  const h = await make();
  await h.bot.emit('economy:daily', { user: IDS.member, streak: 7 });
  await h.settle();
  const ans = await h.slash('achievements', '', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /Achievements · 1\//);
  assert.match(text, /On a roll/);
  assert.match(text, /new!/);
  assert.match(text, /0\/1,000/);
  assert.ok(h.findButton('Next', ans));

  const again = await h.slash('achievements', '', { user: IDS.member });
  assert.doesNotMatch(lastText(h, again), /new!/, 'seen after the first look');

  const off = await h.slash('achievements', 'dm off', { user: IDS.member });
  assert.match(lastText(h, off), /won't DM you/);
  await h.bot.emit('economy:daily', { user: IDS.member, streak: 30 });
  await h.settle();
  assert.ok(got(h, IDS.member).includes('streak30'));
  assert.equal(dmsTo(h, IDS.member).length, 1, 'only the first unlock was DMed');

  const other = await h.slash('achievements', '@sam', { user: IDS.member2 });
  assert.match(lastText(h, other), /achievements/);
  assert.match(lastText(h, other), /On a roll/);
});

test('only the owner tunes rewards, and a paused reward still unlocks', async () => {
  const h = await make();
  const no = await h.slash('achievements', 'reward streak7 999', { user: IDS.admin });
  assert.match(lastText(h, no), /Owner only/);
  const yes = await h.slash('achievements', 'reward streak7 80', { user: IDS.owner });
  assert.match(lastText(h, yes), /pays 80/);
  assert.equal(rewardOf(h.engine, 'streak7'), 80);
  await h.bot.emit('economy:daily', { user: IDS.member, streak: 7 });
  await h.settle();
  assert.equal(eco(h).balance(S, IDS.member), 80);
  const hist = h.engine.store.get('economy', GLOBAL_KEY, {}).users[IDS.member].hist;
  assert.equal(hist.at(-1)[2], 'Achievement: On a roll');

  await h.slash('achievements', 'reward off', { user: IDS.owner });
  await h.bot.emit('economy:daily', { user: IDS.member, streak: 30 });
  await h.settle();
  assert.ok(got(h, IDS.member).includes('streak30'));
  assert.equal(eco(h).balance(S, IDS.member), 80, 'no Shards while rewards are off');
});

test('every command in the bot still fits well under the 100 command limit', async () => {
  const h = await createHarness({ fakeClock: true });
  const names = h.engine.apps.list().flatMap((a) => Object.keys(a.def.commands || {}));
  assert.equal(new Set(names).size, names.length, 'no command is defined twice');
  assert.ok(names.length <= 75, `${names.length} commands`);
  for (const id of ['clans', 'achievements']) assert.ok(h.engine.apps.has(id), `${id} is discovered from apps/`);
  assert.ok(names.includes('event') && names.includes('clan') && names.includes('achievements'));
});
