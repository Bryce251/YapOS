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
  const boardId = next.messageId;
  assert.ok(boardId);
  const locked = await h.click(next.custom_id, { user: IDS.member2, messageId: boardId });
  assert.match(lastText(h, locked), /Not your panel/);
  const page2 = await h.click(next.custom_id, { user: IDS.member, messageId: boardId });
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
  const undo = h.findButton('Undo', ans);
  assert.ok(undo.messageId);
  const locked = await h.click(undo.custom_id, { user: IDS.member, messageId: undo.messageId });
  assert.match(lastText(h, locked), /Not your panel/);
  h.addSecondAdmin();
  const otherAdmin = await h.click(undo.custom_id, { user: IDS.admin2, messageId: undo.messageId });
  assert.match(lastText(h, otherAdmin), /Not your panel/);
  const refused = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(lastText(h, refused), /Only admins/);
  const modRefused = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(lastText(h, modRefused), /Only admins/);
  assert.equal(userOf(h, IDS.member).xp, 0);
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member).voiceSeconds, 120);
  assert.equal(userOf(h, IDS.member).level, levelFor(900));
  const again = await h.slash('levels', 'reset @sam', { user: IDS.admin });
  assert.equal(userOf(h, IDS.member).xp, 0);
  const ownerUndo = h.findButton('Undo', again);
  const byOwner = await h.click(ownerUndo.custom_id, { user: IDS.owner, messageId: ownerUndo.messageId });
  assert.doesNotMatch(lastText(h, byOwner), /Not your panel/);
  assert.equal(userOf(h, IDS.member).xp, 900);
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
  const undo = h.findButton('Undo', ans);
  const locked = await h.click(undo.custom_id, { user: IDS.member, messageId: undo.messageId });
  assert.match(lastText(h, locked), /Not your panel/);
  const refused = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(lastText(h, refused), /Only admins/);
  assert.deepEqual(cfg(h).rewards, {});
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
  const locked = await h.clickButton('Leaderboard', { user: IDS.member, in: panel });
  assert.match(lastText(h, locked), /Not your panel/);
  const peek = await h.clickButton('Leaderboard', { user: IDS.admin, in: panel });
  assert.notEqual(peek[0].type, 'update');
  assert.equal(h.allButtons(peek).length, 0);
  assert.match(lastText(h, peek), /Leaderboard/);
  assert.match(lastText(h, peek), /Sam/);
});

const STAFF_ACTIONS = ['tmsg', 'tvoice', 'tstack', 'ann', 'rateform', 'ratesave', 'resetform', 'resetuser', 'resetall', 'resetallyes', 'cancel'];

test('every settings button is locked to the admin who opened the panel', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const buttons = h.allButtons(panel);
  assert.ok(buttons.length >= 11);
  h.addSecondAdmin();
  for (const b of buttons) {
    assert.ok(b.messageId, b.label);
    for (const user of [IDS.member, IDS.mod, IDS.admin2]) {
      const out = await h.click(b.custom_id, { user, messageId: b.messageId });
      assert.match(lastText(h, out), /Not your panel/, b.label);
    }
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
  const board = h.findButton('Leaderboard', panel);
  const byOwner = await h.click(board.custom_id, { user: IDS.owner, messageId: board.messageId });
  assert.doesNotMatch(lastText(h, byOwner), /Not your panel/);
  assert.match(lastText(h, byOwner), /Leaderboard/);
});

test('forged or leftover staff buttons are refused by role', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  assert.deepEqual(Object.keys(h.engine.apps.get('levels').def.components).filter((k) => !['lb', 'lbpeek'].includes(k)).sort(), [...STAFF_ACTIONS].sort());
  for (const action of STAFF_ACTIONS) {
    for (const user of [IDS.member, IDS.mod]) {
      const id = action === 'ann' ? customId('levels', 'ann', 'off') : customId('levels', action);
      const out = ['ratesave', 'resetuser'].includes(action)
        ? await h.submit(id, { rate: '5', cooldown: '0', user: 'riley' }, { user })
        : await h.click(id, { user });
      assert.match(lastText(h, out), /Only admins/, action);
    }
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 300);
});

test('staff handlers check the role themselves when called without the router', async () => {
  const h = await make();
  seed(h, { [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const handlers = h.engine.router.handlers;
  for (const action of STAFF_ACTIONS) {
    for (const user of [IDS.member, IDS.mod]) {
      const values = { rate: '5', cooldown: '0', user: 'riley' };
      const source = { server_id: S, channel_id: G, user_id: user, username: 'x', values };
      const ctx = h.engine.contextFor(source, { app: 'levels', kind: 'modal_submit', values, args: ['off'] });
      await assert.rejects(() => handlers.get(`levels:${action}`).run(ctx), /Only admins/, action);
    }
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member2).xp, 300);
});

test('the reset confirm and its Undo stay with the admin who asked', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  const ask = await h.slash('levels', 'reset all', { user: IDS.admin });
  const yes = h.findButton('Yes, reset everyone', ask);
  h.addSecondAdmin();
  for (const user of [IDS.member, IDS.mod, IDS.admin2]) {
    const out = await h.click(yes.custom_id, { user, messageId: yes.messageId });
    assert.match(lastText(h, out), /Not your panel/);
  }
  const cancel = h.findButton('Cancel', ask);
  assert.match(lastText(h, await h.click(cancel.custom_id, { user: IDS.member, messageId: cancel.messageId })), /Not your panel/);
  assert.equal(userOf(h, IDS.member).xp, 900);
  const done = await h.click(yes.custom_id, { user: IDS.admin, messageId: yes.messageId });
  assert.equal(userOf(h, IDS.member).xp, 0);
  const undo = h.findButton('Undo', done);
  assert.match(lastText(h, await h.click(undo.custom_id, { user: IDS.member, messageId: yes.messageId })), /Not your panel/);
  assert.match(lastText(h, await h.click(undo.custom_id, { user: IDS.member })), /Only admins/);
  assert.match(lastText(h, await h.click(undo.custom_id, { user: IDS.mod })), /Only admins/);
  assert.equal(userOf(h, IDS.member).xp, 0);
  await h.click(undo.custom_id, { user: IDS.admin, messageId: yes.messageId });
  assert.equal(userOf(h, IDS.member).xp, 900);
  const askAgain = await h.slash('levels', 'reset all', { user: IDS.admin });
  const yesAgain = h.findButton('Yes, reset everyone', askAgain);
  const byOwner = await h.click(yesAgain.custom_id, { user: IDS.owner, messageId: yesAgain.messageId });
  assert.doesNotMatch(lastText(h, byOwner), /Not your panel/);
  assert.equal(userOf(h, IDS.member).xp, 0);
});

test('an Undo button pressed from another server is refused', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  const ans = await h.slash('levels', 'reset @sam', { user: IDS.admin });
  const undo = h.findButton('Undo', ans);
  const out = await h.click(undo.custom_id, { user: IDS.admin, server: uuid(9) });
  assert.match(lastText(h, out), /another server/);
  assert.equal(userOf(h, IDS.member).xp, 0);
});

test('rank cards and leaderboards belong to whoever asked', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 500 }, [IDS.member2]: { xp: 100 } });
  const rankCard = await h.slash('rank', '', { user: IDS.member });
  const peek = h.findButton('Leaderboard', rankCard);
  assert.ok(peek.messageId);
  assert.match(lastText(h, await h.click(peek.custom_id, { user: IDS.member2, messageId: peek.messageId })), /Not your panel/);
  assert.match(lastText(h, await h.click(peek.custom_id, { user: IDS.admin, messageId: peek.messageId })), /Not your panel/);
  assert.match(lastText(h, await h.click(peek.custom_id, { user: IDS.member, messageId: peek.messageId })), /Sam/);
  const own = await h.slash('rank', '', { user: IDS.member2 });
  assert.match(lastText(h, await h.clickButton('Leaderboard', { user: IDS.member2, in: own })), /Sam/);
  await h.message('!leaderboard', { user: IDS.member });
  const board = h.lastSent(G);
  const sort = h.findButton('Sort by voice time', [board]);
  assert.match(lastText(h, await h.click(sort.custom_id, { user: IDS.member2, messageId: board.id })), /Not your panel/);
  assert.equal((await h.click(sort.custom_id, { user: IDS.member, messageId: board.id }))[0].type, 'update');
});

test('the home screen and /yap never show settings to non-admins', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 150 } });
  for (const user of [IDS.member, IDS.mod]) {
    const opened = await h.click(customId('system', 'open', 'levels'), { user });
    assert.doesNotMatch(lastText(h, opened), /Levels settings/);
    assert.equal(h.findButton('Reset everyone', opened), null);
    const yap = await h.slash('yap', 'levels rate 5', { user });
    assert.doesNotMatch(lastText(h, yap), /Saved/);
    const reset = await h.slash('yap', 'levels reset all', { user });
    assert.equal(h.findButton('Yes, reset everyone', reset), null);
  }
  assert.equal(cfg(h).rate, 1);
  assert.equal(userOf(h, IDS.member).xp, 150);
  const adminYap = await h.slash('yap', 'levels rate 2', { user: IDS.admin });
  assert.match(lastText(h, adminYap), /Saved/);
  assert.equal(cfg(h).rate, 2);
});

const OTHER = '5e000000-0000-4000-8000-0000000000b2';
const READ_ONLY = ['lb', 'lbpeek'];
const staffId = (action) => (action === 'ann' ? customId('levels', 'ann', 'off') : customId('levels', action));
const HOSTILE = { rate: '5', cooldown: '0', user: 'riley' };

async function waitFor(check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

function addOtherServer(h) {
  const st = h.fake.state;
  const boss = { id: uuid(7), name: 'Boss', color: null, position: 9, perms: { administrator: true }, auto: null, mentionable: false };
  const botRole = { id: uuid(7), name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, send_messages: true }, auto: null, mentionable: false };
  const lobby = { id: uuid(5), name: 'lobby', type: 'text', kind: 'text', server_id: OTHER, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 };
  st.servers[OTHER] = { id: OTHER, name: 'Other Town', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 1 };
  st.roles[OTHER] = [boss, botRole];
  st.members[OTHER] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [boss.id], joined_at: '2026-02-01T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [botRole.id], joined_at: '2026-02-01T00:00:00Z' },
  ];
  st.channels[OTHER] = [lobby];
  st.bans[OTHER] = [];
  st.everyone[OTHER] = { send_messages: true, view_channel: true };
  return lobby.id;
}

test('a panel the member opened does not unlock staff buttons', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const card = await h.slash('rank', '', { user: IDS.member });
  const mine = h.findButton('Leaderboard', card).messageId;
  assert.ok(mine);
  await h.message('!leaderboard', { user: IDS.member });
  const typed = h.lastSent(G).id;
  for (const messageId of [mine, typed]) {
    for (const action of STAFF_ACTIONS) {
      const out = ['ratesave', 'resetuser'].includes(action)
        ? await h.submit(staffId(action), HOSTILE, { user: IDS.member, messageId })
        : await h.click(staffId(action), { user: IDS.member, messageId });
      assert.match(lastText(h, out), /Only admins/, action);
      assert.equal(h.allButtons(out).length, 0, action);
    }
  }
  const menu = await h.slash('menu', '', { user: IDS.member });
  const menuId = menu.find((a) => a.message)?.message.id ?? mine;
  const opened = await h.click(customId('system', 'open', 'levels'), { user: IDS.member, messageId: menuId });
  assert.doesNotMatch(lastText(h, opened), /Levels settings/);
  assert.match(lastText(h, opened), /Sam/);
  assert.deepEqual(h.allButtons(opened).map((b) => b.custom_id), [customId('levels', 'lbpeek')]);
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 300);
});

test('an Undo the member did not earn stays shut, even from their own panel', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  await h.slash('levels', 'reward 4 @Gamer', { user: IDS.admin });
  const removed = await h.slash('levels', 'reward remove 4', { user: IDS.admin });
  const setTo = await h.slash('levels', 'set @sam 1', { user: IDS.admin });
  const card = await h.slash('rank', '', { user: IDS.member });
  const mine = h.findButton('Leaderboard', card).messageId;
  for (const ans of [removed, setTo]) {
    const undo = h.findButton('Undo', ans);
    for (const user of [IDS.member, IDS.member2, IDS.mod]) {
      assert.match(lastText(h, await h.click(undo.custom_id, { user, messageId: mine })), user === IDS.member ? /Only admins/ : /Not your panel/);
      assert.match(lastText(h, await h.click(undo.custom_id, { user })), /Only admins/);
    }
  }
  assert.match(lastText(h, await h.click(customId('sys', 'undo', 'zzzzzz'), { user: IDS.member, messageId: mine })), /Too late to undo/);
  assert.deepEqual(cfg(h).rewards, {});
  assert.equal(userOf(h, IDS.member).level, 1);
  await h.clickButton('Undo', { user: IDS.admin, in: setTo });
  assert.equal(userOf(h, IDS.member).xp, 900);
});

test('being the owner of another server gives nothing here', async () => {
  const h = await make();
  const lobby = addOtherServer(h);
  const there = { user: IDS.member, server: OTHER, channel: lobby };
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const reset = await h.slash('levels', 'reset @riley', { user: IDS.admin });
  const undo = h.findButton('Undo', reset);
  assert.equal(userOf(h, IDS.member2).xp, 0);

  const panel = await h.slash('levels', '', there);
  assert.match(lastText(h, panel), /Levels settings/);
  const buttons = h.allButtons(panel);
  assert.ok(buttons.length >= 11);
  for (const b of buttons.filter((x) => !READ_ONLY.some((a) => x.custom_id.startsWith(customId('levels', a))))) {
    const out = await h.click(b.custom_id, { user: IDS.member, messageId: b.messageId });
    assert.match(lastText(h, out), /Only admins/, b.label);
  }
  for (const action of ['ratesave', 'resetuser']) {
    assert.match(lastText(h, await h.submit(staffId(action), HOSTILE, { user: IDS.member, messageId: buttons[0].messageId })), /Only admins/);
  }
  assert.match(lastText(h, await h.click(undo.custom_id, there)), /Only admins/);
  assert.match(lastText(h, await h.click(undo.custom_id, { ...there, messageId: buttons[0].messageId })), /Only admins/);
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member2).xp, 0);

  await h.slash('levels', 'rate 5', there);
  assert.equal(h.engine.settings.appConfig(OTHER, 'levels').rate, 5);
  let out = await h.slash('levels', `reward 2 <@&${IDS.roles.gamer}>`, there);
  assert.match(lastText(h, out), /couldn't find that role/);
  out = await h.slash('levels', `reward 2 <@&${IDS.roles.admin}>`, there);
  assert.doesNotMatch(lastText(h, out), /Reward saved/);
  out = await h.slash('levels', `channel <#${NEWS}>`, there);
  assert.match(lastText(h, out), /couldn't find that channel/);
  await h.slash('levels', `set <@${IDS.member2}> 50`, there);
  await h.slash('levels', `reset <@${IDS.member}>`, there);
  await h.slash('levels', 'reset all', there);
  await h.click(customId('levels', 'resetallyes'), there);
  await h.settle();
  assert.deepEqual(h.engine.settings.appConfig(OTHER, 'levels').rewards, {});
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 0);
  assert.deepEqual(h.fake.memberOf(S, IDS.member).roles, [IDS.roles.member]);
  assert.deepEqual(h.fake.memberOf(S, IDS.member2).roles, [IDS.roles.member]);

  await h.clickButton('Undo', { user: IDS.admin, in: reset });
  assert.equal(userOf(h, IDS.member2).xp, 300);
});

test('staff buttons pressed outside a server are refused', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  const before = structuredClone(cfg(h));
  for (const user of [IDS.member, IDS.admin, IDS.owner]) {
    for (const action of STAFF_ACTIONS) {
      const out = ['ratesave', 'resetuser'].includes(action)
        ? await h.submit(staffId(action), HOSTILE, { user, server: null })
        : await h.click(staffId(action), { user, server: null });
      assert.match(lastText(h, out), /Only admins/, action);
    }
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
});

test('typed chat commands get the same refusals as the slash menu', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const tries = ['', 'rate 5', 'cooldown 0', 'voice on', 'xp off', 'stack off', 'channel off', 'message hi {user}', 'noxp #general', 'reward 1 @Moderator', 'reward 1 @Gamer', `set <@${IDS.member}> 500`, `reset <@${IDS.member2}>`, 'reset all'];
  for (const user of [IDS.member, IDS.mod]) {
    for (const args of tries) {
      const count = h.sent(G).length;
      await h.message(`!levels ${args}`.trim(), { user });
      const fresh = h.sent(G).slice(count);
      assert.equal(fresh.length, 1, args);
      assert.match(h.textOf(fresh[0]), /Only admins/, args);
      assert.equal(h.allButtons(fresh).length, 0, args);
      const viaSlash = await h.slash('levels', args, { user });
      assert.match(lastText(h, viaSlash), /Only admins/, args);
      const viaYap = await h.slash('yap', `levels ${args}`, { user });
      assert.doesNotMatch(lastText(h, viaYap), /Saved|Levels settings|Reset everyone|XP reset|Level set|Reward saved/, args);
    }
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 300);
  assert.deepEqual(h.fake.memberOf(S, IDS.member).roles, [IDS.roles.member]);
  await h.message('!rank', { user: IDS.member });
  const card = h.lastSent(G);
  const peek = h.findButton('Leaderboard', [card]);
  assert.match(lastText(h, await h.click(peek.custom_id, { user: IDS.member2, messageId: card.id })), /Not your panel/);
  assert.match(lastText(h, await h.click(peek.custom_id, { user: IDS.member, messageId: card.id })), /Sam/);
});

test('replaying buttons after the app is uninstalled does nothing', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 } });
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const board = await h.slash('leaderboard', '', { user: IDS.member });
  const boardId = h.findButton('Sort by voice time', board).messageId;
  const before = structuredClone(cfg(h));
  h.engine.settings.setEnabled(S, 'levels', false);
  for (const b of h.allButtons(panel)) {
    for (const user of [IDS.admin, IDS.member]) {
      const out = await h.click(b.custom_id, { user, messageId: user === IDS.admin ? b.messageId : null });
      assert.match(lastText(h, out), /isn't installed/, b.label);
    }
  }
  for (const action of ['ratesave', 'resetuser', 'resetallyes']) {
    assert.match(lastText(h, await h.submit(staffId(action), HOSTILE, { user: IDS.member })), /isn't installed/);
  }
  assert.match(lastText(h, await h.click(customId('levels', 'lb', 1, 'voice'), { user: IDS.member, messageId: boardId })), /isn't installed/);
  assert.match(lastText(h, await h.click(customId('system', 'open', 'levels'), { user: IDS.member })), /isn't installed/);
  for (const words of ['rank', 'leaderboard', 'levels', 'levels rate 5']) {
    assert.match(lastText(h, await h.slash('yap', words, { user: IDS.member })), /isn't installed/, words);
  }
  for (const typed of ['!rank', '!leaderboard', '!levels rate 5']) {
    await h.message(typed, { user: IDS.member });
    assert.match(h.textOf(h.lastSent(G)), /isn't installed|Only admins/, typed);
  }
  assert.deepEqual(cfg(h), before);
  assert.equal(userOf(h, IDS.member).xp, 900);
});

test('leaderboard buttons never rewrite a message the presser does not own', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 500 }, [IDS.member2]: { xp: 100, voiceSeconds: 600 } });
  await h.engine.budget.send({ serverId: S, channelId: G, content: 'Pick your roles', opts: { components: [{ type: 'row', components: [{ type: 'button', style: 'primary', label: 'Gamer', custom_id: 'yo:roles:pick:gamer' }] }] }, priority: 'high' });
  await h.settle();
  const stored = () => h.fake.messagesIn(G).find((m) => m.content === 'Pick your roles');
  const publicId = stored().id;
  const forged = await h.click(customId('levels', 'lb', 1, 'voice'), { user: IDS.member, messageId: publicId });
  assert.notEqual(forged[0].type, 'update');
  assert.match(lastText(h, forged), /Leaderboard/);
  assert.ok(stored(), 'the public message kept its text');
  assert.equal(stored().embeds, null);
  assert.equal(h.findButton('Gamer', [stored()]).custom_id, 'yo:roles:pick:gamer');

  const board = await h.slash('leaderboard', '', { user: IDS.member });
  const sort = h.findButton('Sort by voice time', board);
  h.engine.router.releasePanel(sort.messageId);
  const stranger = await h.click(sort.custom_id, { user: IDS.member2, messageId: sort.messageId });
  assert.notEqual(stranger[0].type, 'update');
  assert.match(lastText(h, stranger), /Riley · 10m in voice/);
  const original = h.fake.messagesIn(G).find((m) => m.id === sort.messageId);
  assert.match(h.textOf(original), /🥇 Sam/);
  assert.doesNotMatch(h.textOf(original), /in voice/);
  const own = h.findButton('Sort by XP', stranger);
  assert.ok(own.messageId && own.messageId !== sort.messageId);
  assert.match(lastText(h, await h.click(own.custom_id, { user: IDS.member, messageId: own.messageId })), /Not your panel/);
  assert.equal((await h.click(own.custom_id, { user: IDS.member2, messageId: own.messageId }))[0].type, 'update');

  for (const args of [['999999', 'xp'], ['-5', 'nope'], ['NaN', '__proto__'], ['1e9', 'constructor'], []]) {
    const out = await h.click(customId('levels', 'lb', ...args), { user: IDS.member });
    assert.match(lastText(h, out), /Page 1 of 1/, args.join(','));
  }
});

test('hostile form values never save odd settings', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 900 }, [IDS.member2]: { xp: 300 } });
  const before = structuredClone(cfg(h));
  const bad = [{}, { rate: '', cooldown: '' }, { rate: '   ', cooldown: '60' }, { rate: '1', cooldown: '' }, { rate: '-1', cooldown: '60' }, { rate: 'Infinity', cooldown: '60' }, { rate: '1e9', cooldown: '60' }, { rate: '1', cooldown: '1.5' }, { rate: '1', cooldown: '-1' }, { rate: '1', cooldown: '99999' }, { rate: {}, cooldown: [] }, { rate: ['1', '2'], cooldown: '60' }];
  for (const values of bad) {
    const out = await h.submit(customId('levels', 'ratesave'), values, { user: IDS.admin });
    assert.match(lastText(h, out), /didn't work/, JSON.stringify(values));
  }
  assert.match(lastText(h, await h.click(customId('levels', 'ratesave'), { user: IDS.admin })), /didn't work/);
  for (const typed of ['rate', 'cooldown', 'voicerate']) {
    assert.match(lastText(h, await h.slash('levels', typed, { user: IDS.admin })), /didn't work/, typed);
  }
  assert.deepEqual(cfg(h), before);
  for (const user of ['', '   ', '@everyone', '*', 'all', `<@&${IDS.roles.member}>`, `<@${IDS.bot}>`, 'x'.repeat(5000), {}]) {
    const out = await h.submit(customId('levels', 'resetuser'), { user }, { user: IDS.admin });
    assert.doesNotMatch(lastText(h, out), /XP reset|Everyone reset/, String(user).slice(0, 20));
  }
  assert.match(lastText(h, await h.click(customId('levels', 'resetuser'), { user: IDS.admin })), /couldn't find/);
  assert.equal(userOf(h, IDS.member).xp, 900);
  assert.equal(userOf(h, IDS.member2).xp, 300);
  for (const mode of ['dm_', 'everyone', '__proto__', '', 'CHANNEL']) {
    await h.click(customId('levels', 'ann', mode), { user: IDS.admin });
    assert.ok(['here', 'channel', 'dm', 'off'].includes(cfg(h).announce), mode);
  }
});

test('only the admin who opened a chat form can answer it', async () => {
  const h = await make({ features: { modals: false } });
  const panel = await h.slash('levels', '', { user: IDS.admin });
  const btn = h.findButton('Rate & cooldown', panel);
  const done = h.click(btn.custom_id, { user: IDS.admin, messageId: btn.messageId });
  const asked = () => h.sent(G).filter((m) => m.content.startsWith(`<@${IDS.admin}>`)).length;
  assert.ok(await waitFor(() => asked() === 1));
  await h.message('5', { user: IDS.member });
  await h.message('5', { user: IDS.mod });
  assert.equal(asked(), 1);
  await h.message('2', { user: IDS.admin });
  assert.ok(await waitFor(() => asked() === 2));
  await h.message('0', { user: IDS.member });
  assert.equal(cfg(h).rate, 1);
  await h.message('45', { user: IDS.admin });
  await done;
  assert.ok(await waitFor(() => cfg(h).rate === 2));
  assert.equal(cfg(h).cooldownSeconds, 45);
});

test('a nickname cannot make the level-up message ping roles or everyone', async (t) => {
  clock(t);
  const h = await make();
  await h.slash('levels', 'message GG {username} reached level {level}', { user: IDS.admin });
  h.fake.memberOf(S, IDS.member).nickname = `<@&${IDS.roles.mod}> @everyone <@${IDS.owner}>`;
  h.engine.perms.invalidate();
  seed(h, { [IDS.member]: { xp: 95 } });
  await h.message('this levels me up');
  await h.settle();
  const ups = levelUps(h, G);
  assert.equal(ups.length, 1);
  assert.doesNotMatch(ups[0].content, /<@|@everyone|@here/);
  assert.match(ups[0].content, /reached level 1/);
});

test('ordinary members can still use their own cards side by side', async () => {
  const h = await make();
  seed(h, { [IDS.member]: { xp: 500 }, [IDS.member2]: { xp: 100 } });
  const a = await h.slash('leaderboard', '', { user: IDS.member });
  const b = await h.slash('leaderboard', '', { user: IDS.member2 });
  const sortA = h.findButton('Sort by voice time', a);
  const sortB = h.findButton('Sort by voice time', b);
  assert.notEqual(sortA.messageId, sortB.messageId);
  assert.equal((await h.click(sortB.custom_id, { user: IDS.member2, messageId: sortB.messageId }))[0].type, 'update');
  assert.equal((await h.click(sortA.custom_id, { user: IDS.member, messageId: sortA.messageId }))[0].type, 'update');
  const opened = await h.click(customId('system', 'open', 'levels'), { user: IDS.member2 });
  assert.match(lastText(h, opened), /Riley/);
  assert.match(lastText(h, await h.clickButton('Leaderboard', { user: IDS.member2, in: opened })), /Sam/);
});
