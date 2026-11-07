import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, uuid } from '../harness.js';
import { levelFor, xpForLevel, totalXpForLevel } from '../../apps/levels.js';
import { customId } from '../../engine/router.js';

const S = IDS.server;
const G = IDS.channels.general;
const NEWS = IDS.channels.news;
const VOICE = IDS.channels.voice;
const START = Date.parse('2026-11-07T12:00:00Z');

const make = (opts = {}) => createHarness({ apps: ['levels'], ...opts });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const userOf = (h, uid) => h.engine.service('levels').getUser(S, uid);
const seed = (h, users) => h.engine.store.set('levels', S, { users: Object.fromEntries(Object.entries(users).map(([id, u]) => [id, { xp: 0, level: levelFor(u.xp || 0), voiceSeconds: 0, messages: 0, lastXpAt: 0, ...u }])) });
const levelUps = (h, ch) => h.sent(ch).filter((m) => /reached/.test(m.content || ''));
const cfg = (h) => h.engine.settings.appConfig(S, 'levels');

function clock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(Math, 'random', () => 0);
  return (ms) => t.mock.timers.tick(ms);
}

test('curve helpers follow the MEE6 formula', () => {
  assert.equal(xpForLevel(0), 100);
  assert.equal(xpForLevel(1), 155);
  assert.equal(xpForLevel(2), 220);
  assert.equal(xpForLevel(10), 5 * 100 + 500 + 100);
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(2), 255);
  assert.equal(levelFor(0), 0);
  assert.equal(levelFor(99), 0);
  assert.equal(levelFor(100), 1);
  assert.equal(levelFor(254), 1);
  assert.equal(levelFor(255), 2);
  assert.equal(levelFor(-50), 0);
  for (let l = 1; l <= 60; l++) {
    assert.equal(levelFor(totalXpForLevel(l)), l);
    assert.equal(levelFor(totalXpForLevel(l) - 1), l - 1);
  }
});

test('levels commands stay few and fit Yapin limits', async () => {
  const h = await make();
  for (const name of ['rank', 'leaderboard', 'levels']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100);
  }
  const svc = h.engine.service('levels');
  assert.equal(typeof svc.getUser, 'function');
  assert.equal(typeof svc.addXp, 'function');
});

test('chat XP is 15 to 25 times the rate, once per cooldown', async (t) => {
  const tick = clock(t);
  const h = await make();
  await h.message('hello everyone');
  assert.equal(userOf(h, IDS.member).xp, 15);
  await h.message('still talking');
  await h.message('and more');
  assert.equal(userOf(h, IDS.member).xp, 15);
  tick(30_000);
  await h.message('half a minute later');
  assert.equal(userOf(h, IDS.member).xp, 15);
  tick(31_000);
  await h.message('a minute later');
  assert.equal(userOf(h, IDS.member).xp, 30);
  assert.equal(userOf(h, IDS.member).messages, 5);
  Math.random.mock.mockImplementation(() => 0.999);
  tick(61_000);
  await h.message('lucky roll');
  assert.equal(userOf(h, IDS.member).xp, 55);
  await h.slash('levels', 'rate 2', { user: IDS.admin });
  tick(61_000);
  Math.random.mock.mockImplementation(() => 0);
  await h.message('double time');
  assert.equal(userOf(h, IDS.member).xp, 85);
});

test('commands, bots, DMs and short messages earn nothing', async (t) => {
  clock(t);
  const h = await make();
  await h.message('!rank');
  await h.message('/leaderboard');
  await h.message('ok');
  await h.message('  hi  ');
  await h.message('i am a bot talking', { authorBot: true });
  await h.dm('hello from a DM');
  assert.equal(userOf(h, IDS.member).xp, 0);
  assert.equal(h.engine.service('levels').getUser(S, IDS.bot).xp, 0);
});

test('no-XP channels and roles', async (t) => {
  const tick = clock(t);
  const h = await make();
  const ans = await h.slash('levels', 'noxp #announcements', { user: IDS.admin });
  assert.match(lastText(h, ans), /don't earn XP/);
  assert.deepEqual(cfg(h).noXpChannels, [NEWS]);
  await h.message('posting in news', { channel: NEWS });
  assert.equal(userOf(h, IDS.member).xp, 0);
  await h.message('posting in general');
  assert.equal(userOf(h, IDS.member).xp, 15);
  await h.slash('levels', 'noxp @VIP', { user: IDS.admin });
  assert.deepEqual(cfg(h).noXpRoles, [IDS.roles.vip]);
  h.fake.memberOf(S, IDS.member2).roles.push(IDS.roles.vip);
  await h.message('vip chatter', { user: IDS.member2 });
  assert.equal(userOf(h, IDS.member2).xp, 0);
  await h.slash('levels', 'noxp #announcements', { user: IDS.admin });
  assert.deepEqual(cfg(h).noXpChannels, []);
  tick(61_000);
  await h.message('news is open again', { channel: NEWS });
  assert.equal(userOf(h, IDS.member).xp, 30);
});

async function levelUpIn(t, setupFn, features = {}) {
  clock(t);
  const h = await make({ features });
  await setupFn?.(h);
  seed(h, { [IDS.member]: { xp: 95 } });
  await h.message('this levels me up');
  await h.settle();
  assert.equal(userOf(h, IDS.member).level, 1);
  return h;
}

test('level-up message in the same channel by default', async (t) => {
  const h = await levelUpIn(t);
  const ups = levelUps(h, G);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].content, `🎉 <@${IDS.member}> reached **level 1**!`);
});

test('level-up message in a set channel, with a custom template', async (t) => {
  const h = await levelUpIn(t, async (hh) => {
    const ans = await hh.slash('levels', 'channel #announcements', { user: IDS.admin });
    assert.match(lastText(hh, ans), /announcements|Level-ups saved/);
    await hh.slash('levels', 'message GG {username}, level {level} in {server}! reached', { user: IDS.admin });
  });
  assert.equal(levelUps(h, G).length, 0);
  const ups = levelUps(h, NEWS);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].content, 'GG Sam, level 1 in Test Town! reached');
});

test('level-up by DM, and back to the channel when DMs are off', async (t) => {
  const h = await levelUpIn(t, (hh) => hh.slash('levels', 'channel dm', { user: IDS.admin }));
  const dmChannel = `d${IDS.member.slice(1)}`;
  assert.equal(levelUps(h, dmChannel).length, 1);
  assert.equal(levelUps(h, G).length, 0);
});

test('level-up DM falls back to the same channel', async (t) => {
  const h = await levelUpIn(t, (hh) => hh.slash('levels', 'channel dm', { user: IDS.admin }), { dms: false });
  assert.equal(levelUps(h, G).length, 1);
});

test('level-ups off stays quiet', async (t) => {
  const h = await levelUpIn(t, (hh) => hh.slash('levels', 'channel off', { user: IDS.admin }));
  assert.equal(levelUps(h).length, 0);
});

test('quick level-ups collapse to the newest level when the budget is busy', async (t) => {
  const tick = clock(t);
  const h = await make();
  for (let i = 0; i < 25; i++) h.engine.budget.send({ serverId: S, channelId: G, content: `filler ${i}`, priority: 'high' });
  await h.settle();
  const svc = h.engine.service('levels');
  await svc.addXp(S, IDS.member, 100, 'test', { channelId: G });
  await svc.addXp(S, IDS.member, 155, 'test', { channelId: G });
  await svc.addXp(S, IDS.member, 220, 'test', { channelId: G });
  await h.settle();
  assert.equal(userOf(h, IDS.member).level, 3);
  assert.equal(levelUps(h, G).length, 0, 'waiting for room in the budget');
  assert.equal(h.engine.budget.queued, 1);
  tick(61_000);
  h.engine.budget._pump();
  await h.settle();
  const ups = levelUps(h, G);
  assert.equal(ups.length, 1);
  assert.match(ups[0].content, /level 3/);
});

test('reward roles stack by default, or keep only the highest', async (t) => {
  clock(t);
  const h = await make();
  let ans = await h.slash('levels', 'reward 2 @Gamer', { user: IDS.admin });
  assert.match(lastText(h, ans), /Reward saved/);
  ans = await h.slash('levels', 'reward 5 @VIP', { user: IDS.admin });
  assert.match(lastText(h, ans), /level 5/);
  assert.deepEqual(cfg(h).rewards, { 2: IDS.roles.gamer, 5: IDS.roles.vip });
  const svc = h.engine.service('levels');
  await svc.addXp(S, IDS.member, totalXpForLevel(2), 'test');
  let roles = h.fake.memberOf(S, IDS.member).roles;
  assert.ok(roles.includes(IDS.roles.gamer));
  assert.ok(!roles.includes(IDS.roles.vip));
  await svc.addXp(S, IDS.member, totalXpForLevel(5) - totalXpForLevel(2), 'test');
  roles = h.fake.memberOf(S, IDS.member).roles;
  assert.ok(roles.includes(IDS.roles.gamer) && roles.includes(IDS.roles.vip), 'stacked');

  await h.slash('levels', 'stack off', { user: IDS.admin });
  assert.equal(cfg(h).stackRewards, false);
  await svc.addXp(S, IDS.member2, totalXpForLevel(3), 'test');
  assert.ok(h.fake.memberOf(S, IDS.member2).roles.includes(IDS.roles.gamer));
  await svc.addXp(S, IDS.member2, totalXpForLevel(6), 'test');
  roles = h.fake.memberOf(S, IDS.member2).roles;
  assert.ok(roles.includes(IDS.roles.vip));
  assert.ok(!roles.includes(IDS.roles.gamer), 'lower reward removed');

  ans = await h.slash('levels', 'reward remove 2', { user: IDS.admin });
  assert.match(lastText(h, ans), /Reward removed/);
  assert.deepEqual(cfg(h).rewards, { 5: IDS.roles.vip });
});

test('reward roles above the bot or with staff permissions are refused', async () => {
  const h = await make();
  const elite = uuid(7);
  h.fake.state.roles[S].push({ id: elite, name: 'Elite', color: null, position: 8, perms: {}, auto: null, mentionable: false });
  let ans = await h.slash('levels', 'reward 3 @Elite', { user: IDS.admin });
  assert.match(lastText(h, ans), /must be above/);
  ans = await h.slash('levels', 'reward 3 @Moderator', { user: IDS.admin });
  assert.match(lastText(h, ans), /staff permissions/);
  ans = await h.slash('levels', 'reward 3 @Admin', { user: IDS.admin });
  assert.match(lastText(h, ans), /staff permissions/);
  ans = await h.slash('levels', 'reward 3 @everyone', { user: IDS.admin });
  assert.match(lastText(h, ans), /can't be a reward|couldn't find/);
  assert.deepEqual(cfg(h).rewards, {});
});

test('a reward that fails to give is logged once and never breaks chat XP', async (t) => {
  const tick = clock(t);
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('levels', 'reward 1 @Gamer', { user: IDS.admin });
  h.fake.fail('PUT', /\/members\/[^/]+\/roles\//, { status: 403, error: 'Missing permission' });
  seed(h, { [IDS.member]: { xp: 95 }, [IDS.member2]: { xp: 95 } });
  await h.message('level up please');
  await h.message('me too please', { user: IDS.member2 });
  tick(61_000);
  await h.message('still chatting fine');
  await h.settle();
  assert.equal(userOf(h, IDS.member).level, 1);
  assert.equal(userOf(h, IDS.member2).level, 1);
  assert.equal(userOf(h, IDS.member).xp, 125);
  const logs = h.sent(IDS.channels.modlog);
  assert.equal(logs.length, 1);
  assert.match(h.textOf(logs[0]), /Gamer/);
  assert.match(h.textOf(logs[0]), /My role/);
  assert.equal(levelUps(h, G).length, 2);
});

test('voice XP for a 10 minute session with someone else there', async (t) => {
  const tick = clock(t);
  const h = await make();
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceJoin(IDS.member);
  await h.voiceJoin(IDS.member2);
  tick(10 * 60_000 + 20_000);
  await h.voiceLeave(IDS.member);
  let u = userOf(h, IDS.member);
  assert.equal(u.xp, 50);
  assert.equal(u.voiceSeconds, 620);
  await h.voiceLeave(IDS.member2);
  u = userOf(h, IDS.member2);
  assert.equal(u.xp, 50, 'the last one out still had company');
});

test('no voice XP when alone, or with voice XP off', async (t) => {
  const tick = clock(t);
  const h = await make();
  await h.voiceJoin(IDS.member);
  await h.voiceJoin(IDS.member2);
  tick(10 * 60_000);
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 0, 'voice XP is off by default');
  await h.voiceLeave(IDS.member2);
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceJoin(IDS.member);
  tick(10 * 60_000);
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 0);
  assert.equal(userOf(h, IDS.member).voiceSeconds, 0);
});

test('a move within 5 seconds keeps one voice session', async (t) => {
  const tick = clock(t);
  const h = await make();
  const V2 = uuid(5);
  h.fake.state.channels[S].push({ id: V2, name: 'Gaming', type: 'voice', kind: 'voice', server_id: S, position: 7, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceJoin(IDS.member2);
  await h.voiceJoin(IDS.member);
  tick(330_000);
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 25);
  tick(2000);
  await h.voiceJoin(IDS.member, { channel: V2 });
  await h.voiceJoin(IDS.member2, { channel: V2 });
  tick(280_000);
  await h.voiceLeave(IDS.member, { channel: V2 });
  const u = userOf(h, IDS.member);
  assert.equal(u.xp, 50, '10 full minutes in one session, not 5 + 4');
  assert.equal(u.voiceSeconds, 612);
});

test('a join that arrives before the leave of a move is one session too', async (t) => {
  const tick = clock(t);
  const h = await make();
  const V2 = uuid(5);
  h.fake.state.channels[S].push({ id: V2, name: 'Gaming', type: 'voice', kind: 'voice', server_id: S, position: 7, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceJoin(IDS.member2, { channel: V2 });
  await h.voiceJoin(IDS.member);
  tick(300_000);
  await h.voiceJoin(IDS.member, { channel: V2 });
  await h.voiceLeave(IDS.member, { channel: VOICE });
  assert.equal(userOf(h, IDS.member).xp, 0, 'old channel leave is part of the move');
  h.fake.state.voice[V2].add(IDS.member);
  tick(300_000);
  await h.voiceLeave(IDS.member, { channel: V2 });
  assert.equal(userOf(h, IDS.member).xp, 50);
});

test('a session from before a restart is not counted', async (t) => {
  clock(t);
  const h = await make();
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 0);
});

test('/rank for yourself and for someone else', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 300, voiceSeconds: 3900 }, [IDS.member2]: { xp: 1200 } });
  let ans = await h.slash('rank', '', { user: IDS.member });
  let text = lastText(h, ans);
  assert.match(text, /Sam/);
  assert.match(text, /Level 2/);
  assert.match(text, /Rank \*\*#2\*\* of 2/);
  assert.match(text, /45 \/ 220 XP to level 3/);
  assert.match(text, /[█░]{14}/);
  assert.match(text, /1h 5m/);
  ans = await h.slash('rank', '@riley', { user: IDS.member });
  text = lastText(h, ans);
  assert.match(text, /Riley/);
  assert.match(text, /#1/);
  ans = await h.slash('rank', '', { user: IDS.mod });
  assert.match(lastText(h, ans), /Not ranked yet/);
  ans = await h.slash('rank', '@nobodyatall', { user: IDS.member });
  assert.match(lastText(h, ans), /couldn't find/);
  await h.slash('levels', 'reward 5 @VIP', { user: IDS.admin });
  ans = await h.slash('rank', '', { user: IDS.member });
  assert.match(lastText(h, ans), /Next reward: \*\*@VIP\*\* at level 5/);
});

test('leaderboard pages with buttons and sorts by voice time', async () => {
  const h = await make();
  const users = {};
  for (let i = 0; i < 23; i++) users[uuid(1)] = { xp: 5000 - i * 100 };
  users[IDS.member] = { xp: 10000 };
  users[IDS.member2] = { xp: 50, voiceSeconds: 9000 };
  seed(h, users);
  const ans = await h.slash('leaderboard', '', { user: IDS.member });
  let text = lastText(h, ans);
  assert.match(text, /🥇 Sam/);
  assert.match(text, /Page 1 of 3/);
  const prev = h.findButton('Prev', ans);
  assert.equal(prev.disabled, true);
  const next = h.findButton('Next', ans);
  assert.ok(!next.disabled);
  const page2 = await h.click(next.custom_id, { user: IDS.member2, messageId: ans[0].message?.id });
  assert.equal(page2[0].type, 'update');
  text = h.textOf(page2[0]);
  assert.match(text, /Page 2 of 3/);
  assert.match(text, /\*\*11\.\*\*/);
  const third = await h.slash('leaderboard', '3', { user: IDS.member });
  assert.match(lastText(h, third), /Page 3 of 3/);
  assert.match(lastText(h, third), /Riley/);
  assert.equal(h.findButton('Next', third).disabled, true);
  const voice = await h.slash('leaderboard', 'voice', { user: IDS.member });
  text = lastText(h, voice);
  assert.match(text, /voice time/);
  assert.match(text, /🥇 Riley · 2h 30m/);
  assert.match(text, /Page 1 of 1/);
  const back = h.findButton('Sort by XP', voice);
  const xpView = await h.click(back.custom_id, { user: IDS.member });
  assert.match(h.textOf(xpView[0]), /🥇 Sam/);
});

test('settings are admin only, including old admin panels', async () => {
  const h = await make();
  let ans = await h.slash('levels', '', { user: IDS.member });
  assert.match(lastText(h, ans), /Only admins/);
  ans = await h.slash('levels', 'rate 3', { user: IDS.mod });
  assert.match(lastText(h, ans), /Only admins/);
  assert.equal(cfg(h).rate, 1);
  const panel = await h.slash('levels', '', { user: IDS.admin });
  assert.match(lastText(h, panel), /Levels settings/);
  const toggle = h.findButton('Chat XP', panel);
  const refused = await h.click(toggle.custom_id, { user: IDS.member });
  assert.match(lastText(h, refused), /Only admins/);
  assert.equal(cfg(h).messageXp, true);
  const resetAll = await h.click(customId('levels', 'resetallyes'), { user: IDS.member });
  assert.match(lastText(h, resetAll), /Only admins/);
  const ok = await h.click(toggle.custom_id, { user: IDS.admin });
  assert.equal(ok[0].type, 'update');
  assert.equal(cfg(h).messageXp, false);
  await h.clickButton('Voice XP', { user: IDS.admin, in: panel });
  assert.equal(cfg(h).voiceXp, true);
  await h.clickButton('Level-ups: Off', { user: IDS.admin, in: panel });
  assert.equal(cfg(h).announce, 'off');
  const noChannel = await h.clickButton('Level-ups: Level-up channel', { user: IDS.admin, in: panel });
  assert.match(lastText(h, noChannel), /Pick a channel first/);
  const form = await h.clickButton('Rate & cooldown', { user: IDS.admin, in: panel });
  assert.equal(form[0].type, 'modal');
  await h.submit(customId('levels', 'ratesave'), { rate: '1.5', cooldown: '30' }, { user: IDS.admin });
  assert.equal(cfg(h).rate, 1.5);
  assert.equal(cfg(h).cooldownSeconds, 30);
  const bad = await h.submit(customId('levels', 'ratesave'), { rate: 'lots', cooldown: '30' }, { user: IDS.admin });
  assert.match(lastText(h, bad), /rate didn't work/);
  const sneaky = await h.submit(customId('levels', 'ratesave'), { rate: '5', cooldown: '0' }, { user: IDS.member });
  assert.match(lastText(h, sneaky), /Only admins/);
  assert.equal(cfg(h).rate, 1.5);
});

test('members opening Levels from the menu see their rank', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 150 } });
  const ans = await h.click(customId('system', 'open', 'levels'), { user: IDS.member });
  assert.match(lastText(h, ans), /Level 1/);
  const adminView = await h.click(customId('system', 'open', 'levels'), { user: IDS.admin });
  assert.match(lastText(h, adminView), /Levels settings/);
  const yap = await h.slash('yap', 'rank', { user: IDS.member });
  assert.match(lastText(h, yap), /Level 1/);
});

test('reset one person, then Undo', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900, voiceSeconds: 120 } });
  const ans = await h.slash('levels', 'reset @sam', { user: IDS.admin });
  assert.match(lastText(h, ans), /XP reset/);
  assert.equal(userOf(h, IDS.member).xp, 0);
  const refused = await h.clickButton('Undo', { user: IDS.member, in: ans });
  assert.match(lastText(h, refused), /Only admins/);
  assert.equal(userOf(h, IDS.member).xp, 0);
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member).voiceSeconds, 120);
  assert.equal(userOf(h, IDS.member).level, levelFor(900));
});

test('reset someone from the panel form', async () => {
  const h = await make();
  seed(h, { [IDS.member2]: { xp: 400 } });
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const form = await h.clickButton('Reset someone', { user: IDS.admin, in: panel });
  assert.equal(form[0].type, 'modal');
  const done = await h.submit(customId('levels', 'resetuser'), { user: 'riley' }, { user: IDS.admin });
  assert.match(lastText(h, done), /XP reset/);
  assert.equal(userOf(h, IDS.member2).xp, 0);
});

test('reset everyone needs a confirm and has Undo', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const ask = await h.slash('levels', 'reset all', { user: IDS.admin });
  assert.match(lastText(h, ask), /Reset everyone\?/);
  assert.equal(userOf(h, IDS.member).xp, 900, 'nothing happens before the confirm');
  const done = await h.clickButton('Yes, reset everyone', { user: IDS.admin, in: ask });
  assert.equal(done[0].type, 'update');
  assert.match(h.textOf(done[0]), /Everyone reset/);
  assert.equal(userOf(h, IDS.member).xp, 0);
  assert.equal(userOf(h, IDS.member2).xp, 0);
  await h.clickButton('Undo', { user: IDS.admin, in: done });
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 300);
  const ask2 = await h.slash('levels', 'reset all', { user: IDS.admin });
  const cancel = await h.clickButton('Cancel', { user: IDS.admin, in: ask2 });
  assert.match(h.textOf(cancel[0]), /Nothing was reset/);
  assert.equal(userOf(h, IDS.member).xp, 900);
});

test('typed settings commands', async () => {
  const h = await make();
  let ans = await h.slash('levels', 'rate 1.5', { user: IDS.admin });
  assert.match(lastText(h, ans), /1\.5/);
  assert.equal(cfg(h).rate, 1.5);
  ans = await h.slash('levels', 'rate 9', { user: IDS.admin });
  assert.match(lastText(h, ans), /didn't work/);
  assert.equal(cfg(h).rate, 1.5);
  await h.slash('levels', 'cooldown 90', { user: IDS.admin });
  assert.equal(cfg(h).cooldownSeconds, 90);
  await h.slash('levels', 'voicerate 8', { user: IDS.admin });
  assert.equal(cfg(h).voiceXpPerMinute, 8);
  await h.slash('levels', 'channel #announcements', { user: IDS.admin });
  assert.equal(cfg(h).announce, 'channel');
  assert.equal(cfg(h).channelId, NEWS);
  await h.slash('levels', 'channel here', { user: IDS.admin });
  assert.equal(cfg(h).announce, 'here');
  await h.slash('levels', 'xp off', { user: IDS.admin });
  assert.equal(cfg(h).messageXp, false);
  await h.slash('levels', 'xp on', { user: IDS.admin });
  assert.equal(cfg(h).messageXp, true);
  ans = await h.slash('levels', 'set @sam 12', { user: IDS.admin });
  assert.match(lastText(h, ans), /level 12/);
  assert.equal(userOf(h, IDS.member).level, 12);
  assert.equal(userOf(h, IDS.member).xp, totalXpForLevel(12));
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.equal(userOf(h, IDS.member).xp, 0);
  ans = await h.slash('levels', 'set @sam lots', { user: IDS.admin });
  assert.match(lastText(h, ans), /Who and which level/);
  ans = await h.slash('levels', 'rewrd 5 @VIP', { user: IDS.admin });
  assert.match(lastText(h, ans), /Did you mean/);
  await h.message('!levels rate 2', { user: IDS.admin });
  assert.equal(cfg(h).rate, 2);
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const text = lastText(h, panel);
  assert.match(text, /×2/);
  assert.match(text, /90s/);
});

test('/levels set gives the rewards up to that level', async () => {
  const h = await make();
  await h.slash('levels', 'reward 3 @Gamer', { user: IDS.admin });
  await h.slash('levels', 'set @riley 4', { user: IDS.admin });
  await h.settle();
  assert.ok(h.fake.memberOf(S, IDS.member2).roles.includes(IDS.roles.gamer));
});

test('uninstalling the app stops XP', async (t) => {
  const tick = clock(t);
  const h = await make();
  await h.slash('levels', 'voice on', { user: IDS.admin });
  h.engine.settings.setEnabled(S, 'levels', false);
  await h.message('nobody is counting');
  await h.voiceJoin(IDS.member);
  await h.voiceJoin(IDS.member2);
  tick(10 * 60_000);
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 0);
  const ans = await h.slash('rank', '', { user: IDS.member });
  assert.match(lastText(h, ans), /isn't installed/);
  h.engine.settings.setEnabled(S, 'levels', true);
  await h.message('counting again');
  assert.equal(userOf(h, IDS.member).xp, 15);
});

test('presets set sensible defaults', async () => {
  const h = await make();
  const app = h.engine.apps.get('levels').def;
  h.engine.settings.patchApp(S, 'levels', app.presets.study.config);
  let line = await app.applyPreset(h.engine, S, { preset: 'study' });
  assert.equal(typeof line, 'string');
  assert.equal(cfg(h).rate, 0.5);
  assert.equal(cfg(h).announce, 'off');
  assert.equal(cfg(h).voiceXp, true);
  line = await app.applyPreset(h.engine, S, { preset: 'community' });
  assert.equal(cfg(h).announce, 'here');
  const lvl = uuid(5);
  h.fake.state.channels[S].push({ id: lvl, name: '🆙・level-ups', type: 'text', kind: 'text', server_id: S, position: 8, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  h.engine.cache.invalidate(S);
  line = await app.applyPreset(h.engine, S, { preset: 'community' });
  assert.equal(cfg(h).announce, 'channel');
  assert.equal(cfg(h).channelId, lvl);
  assert.match(line, /level-ups/);
  assert.equal(app.presets.roleplay.config.cooldownSeconds, 90);
});

test('the service adds XP and reads users for other apps', async () => {
  const h = await make();
  const svc = h.engine.service('levels');
  const res = await svc.addXp(S, IDS.member, 260, 'quest', { channelId: G });
  assert.equal(res.level, 2);
  assert.equal(res.leveledUp, true);
  const u = svc.getUser(S, IDS.member);
  assert.equal(u.xp, 260);
  assert.equal(u.level, 2);
  assert.equal(svc.getUser(S, IDS.member2).xp, 0);
});

test('a DM that fails to send falls back to the same channel', async (t) => {
  const h = await levelUpIn(t, (hh) => {
    hh.fake.fail('POST', /^\/channels\/d[^/]+\/messages$/, { status: 403, error: 'This person has DMs closed' });
    return hh.slash('levels', 'channel dm', { user: IDS.admin });
  });
  assert.equal(levelUps(h, G).length, 1);
});

test('a level-up channel that refuses messages is logged once', async (t) => {
  const tick = clock(t);
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('levels', 'channel #announcements', { user: IDS.admin });
  h.fake.fail('POST', new RegExp(`^/channels/${NEWS}/messages$`), { status: 403, error: 'Missing permission' });
  seed(h, { [IDS.member]: { xp: 95 }, [IDS.member2]: { xp: 95 } });
  await h.message('level me up');
  await h.message('me as well', { user: IDS.member2 });
  await h.settle();
  tick(1000);
  await h.settle();
  const logs = h.sent(IDS.channels.modlog);
  assert.equal(logs.length, 1);
  assert.match(h.textOf(logs[0]), /level-up message/i);
  assert.doesNotMatch(h.textOf(logs[0]), /403/);
});

test('keep-highest mode does not take old rewards away when the new one fails', async (t) => {
  clock(t);
  const h = await make();
  await h.slash('levels', 'reward 2 @Gamer', { user: IDS.admin });
  await h.slash('levels', 'reward 5 @VIP', { user: IDS.admin });
  await h.slash('levels', 'stack off', { user: IDS.admin });
  const svc = h.engine.service('levels');
  await svc.addXp(S, IDS.member, totalXpForLevel(2), 'test');
  assert.ok(h.fake.memberOf(S, IDS.member).roles.includes(IDS.roles.gamer));
  h.fake.fail('PUT', new RegExp(`/roles/${IDS.roles.vip}$`), { status: 403, error: 'Missing permission' });
  await svc.addXp(S, IDS.member, totalXpForLevel(5) - totalXpForLevel(2), 'test');
  const roles = h.fake.memberOf(S, IDS.member).roles;
  assert.ok(!roles.includes(IDS.roles.vip));
  assert.ok(roles.includes(IDS.roles.gamer), 'kept the lower reward');
});

test('a role with top-level staff flags is refused as a reward', async () => {
  const h = await make();
  const sneaky = uuid(7);
  h.fake.state.roles[S].push({ id: sneaky, name: 'Helper', color: null, position: 1, perms: {}, manage_messages: true, auto: null, mentionable: false });
  const ans = await h.slash('levels', 'reward 3 @Helper', { user: IDS.admin });
  assert.match(lastText(h, ans), /staff permissions/);
  assert.deepEqual(cfg(h).rewards, {});
});

test('removing a reward has Undo', async () => {
  const h = await make();
  await h.slash('levels', 'reward 4 @Gamer', { user: IDS.admin });
  const ans = await h.slash('levels', 'reward remove 4', { user: IDS.admin });
  assert.deepEqual(cfg(h).rewards, {});
  const refused = await h.clickButton('Undo', { user: IDS.member, in: ans });
  assert.match(lastText(h, refused), /Only admins/);
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.deepEqual(cfg(h).rewards, { 4: IDS.roles.gamer });
});

test('pressing Reset everyone twice keeps the first Undo working', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  const ask = await h.slash('levels', 'reset all', { user: IDS.admin });
  const yes = h.findButton('Yes, reset everyone', ask);
  const first = await h.click(yes.custom_id, { user: IDS.admin });
  const second = await h.click(yes.custom_id, { user: IDS.admin });
  assert.notEqual(second[0].type, 'update');
  assert.match(lastText(h, second), /Already reset/);
  await h.clickButton('Undo', { user: IDS.admin, in: first });
  assert.equal(userOf(h, IDS.member).xp, 900);
});

test('two messages at the same moment only earn XP once', async (t) => {
  clock(t);
  const h = await make();
  await h.slash('levels', 'noxp @VIP', { user: IDS.admin });
  h.engine.perms.invalidate();
  await Promise.all([h.message('first at once'), h.message('second at once')]);
  assert.equal(userOf(h, IDS.member).xp, 15);
});

test('rejoining the same voice channel after a missed leave starts a fresh session', async (t) => {
  const tick = clock(t);
  const h = await make();
  await h.slash('levels', 'voice on', { user: IDS.admin });
  await h.voiceJoin(IDS.member2);
  await h.voiceJoin(IDS.member);
  h.engine.settings.setEnabled(S, 'levels', false);
  await h.voiceLeave(IDS.member);
  h.engine.settings.setEnabled(S, 'levels', true);
  tick(5 * 3600_000);
  await h.voiceJoin(IDS.member);
  tick(3 * 60_000);
  await h.voiceLeave(IDS.member);
  assert.equal(userOf(h, IDS.member).xp, 15);
});

test('the Leaderboard button on panels opens a private board and leaves the panel alone', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 500 } });
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const peek = await h.clickButton('Leaderboard', { user: IDS.member, in: panel });
  assert.notEqual(peek[0].type, 'update');
  assert.match(lastText(h, peek), /Leaderboard/);
  assert.match(lastText(h, peek), /Sam/);
});
