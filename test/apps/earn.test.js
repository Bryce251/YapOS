import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { activityPay, levelUpPay, clanPay, earnSource, partyRates, PAY_DEFAULTS, PARTY_DEFAULTS, PARTY_OLD_DEFAULTS, PARTY_BOUNDS, CHAT_PAY_COOLDOWN_MS, WEEK_MS } from '../../apps/economy.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const make = (apps = ['economy', 'levels', 'quests']) => createHarness({ apps, fakeClock: true });
const eco = (h) => h.engine.service('economy');
const bal = (h, uid) => eco(h).balance(S, uid);
const hist = (h, uid) => h.engine.store.get('economy', GLOBAL_KEY, {}).users?.[uid]?.hist || [];
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const xp = (h, ev) => h.bot.emit('xp:gained', { user: IDS.member, server_id: null, serverId: S, amount: 20, reason: null, messages: 0, voiceSeconds: 0, ...ev });

test('pay rates have sane defaults and clamp junk', () => {
  assert.deepEqual(activityPay({}), PAY_DEFAULTS);
  assert.deepEqual(activityPay({ activityPay: { chat: 999, voice: -3, levelup: 'x', weekly: 1e9 } }), { chat: 50, voice: 0, levelup: PAY_DEFAULTS.levelup, weekly: 10000 });
  assert.deepEqual(PARTY_DEFAULTS, { play: 25, win: 100, tournament: 500, prediction: 50 });
  assert.deepEqual(PARTY_BOUNDS, { play: 250, win: 1000, tournament: 5000, prediction: 250 });
  assert.equal('cap' in partyRates({ partyRates: { cap: 150 } }), false, 'the old daily cap is gone');
  assert.equal(levelUpPay(10, 4, 5), 50);
  assert.equal(levelUpPay(10, 4, 7), 50 + 60 + 70);
  assert.equal(levelUpPay(0, 1, 9), 0);
  assert.equal(levelUpPay(1, 0, 1000), Array.from({ length: 50 }, (_, i) => 951 + i).reduce((a, b) => a + b, 0), 'a huge jump only pays the last 50 levels');
  assert.equal(clanPay(3, false), 3);
  assert.equal(clanPay(3, true), 4);
  assert.equal(clanPay(10, true, 0.25), 14);
  for (const [r, src] of [['Chatting', 'chat'], ['Voice time', 'voice'], ['Weekly bonus', 'weekly'], ['Level 12 reward', 'levelup'], ['YapOS Party', 'party']]) assert.equal(earnSource(r), src);
});

test('Party rates still on the old defaults move to the new defaults, and custom rates are kept', () => {
  assert.deepEqual(partyRates({ partyRates: { ...PARTY_OLD_DEFAULTS } }), PARTY_DEFAULTS);
  assert.deepEqual(partyRates({ partyRates: { play: 10, win: 25, tournament: 100, prediction: 16 } }), { play: 10, win: 25, tournament: 100, prediction: 16 });
  assert.deepEqual(partyRates({ partyRates: { play: 4, win: 20, tournament: 30, prediction: 6 } }), { play: 4, win: 20, tournament: 30, prediction: 6 });
  assert.deepEqual(partyRates({ partyRates: { play: 9999, win: 9999, tournament: 9999, prediction: 9999 } }), PARTY_BOUNDS);
});

test('the owner can set the new higher Party rates and /balance earn explains places and streaks', async () => {
  const h = await make();
  const ok = await h.slash('economy', 'party 250 1000 5000 250', { user: IDS.owner });
  assert.match(lastText(h, ok), /Party rates saved/);
  assert.deepEqual(eco(h).partyRates(), { play: 250, win: 1000, tournament: 5000, prediction: 250 });
  const bad = await h.slash('economy', 'party tournament 5001', { user: IDS.owner });
  assert.match(lastText(h, bad), /can be 0 to 5,000/);
  await h.slash('economy', 'party 25 100 500 50', { user: IDS.owner });
  const ans = await h.slash('balance', 'earn', { user: IDS.member });
  const text = lastText(h, ans);
  assert.match(text, /100 a win/);
  assert.match(text, /50 for 2nd and 25 for 3rd with 4\+ players/);
  assert.match(text, /win streaks \+10% a win, up to \+100%/);
});

test('chatting pays at most once a minute, silently', async () => {
  const h = await make();
  const before = h.sent(IDS.channels.general).length;
  await xp(h, { messages: 1 });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.chat);
  assert.equal(hist(h, IDS.member).at(-1)[2], 'Chatting');
  await xp(h, { messages: 3 });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.chat, 'no second payout inside the cooldown');
  await h.advance(CHAT_PAY_COOLDOWN_MS);
  await xp(h, { messages: 1 });
  await h.settle();
  assert.equal(bal(h, IDS.member), 2 * PAY_DEFAULTS.chat);
  assert.equal(h.sent(IDS.channels.general).length, before, 'chat pay never posts a message');
  await xp(h, { messages: 1, serverId: null });
  await h.advance(CHAT_PAY_COOLDOWN_MS);
  await xp(h, { messages: 0, amount: 20 });
  await h.settle();
  assert.equal(bal(h, IDS.member), 2 * PAY_DEFAULTS.chat, 'no server or no messages, no chat pay');
});

test('chat and voice pay respect servers where Economy is uninstalled', async () => {
  const h = await make();
  h.engine.settings.setEnabled?.(S, 'economy', false);
  if (h.engine.settings.isEnabled(S, 'economy')) return;
  await xp(h, { messages: 1, voiceSeconds: 600 });
  await h.settle();
  assert.equal(bal(h, IDS.member), 0);
});

test('voice time pays per full minute and carries the leftover seconds', async () => {
  const h = await make();
  await xp(h, { voiceSeconds: 90 });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.voice);
  await xp(h, { voiceSeconds: 30 });
  await h.settle();
  assert.equal(bal(h, IDS.member), 2 * PAY_DEFAULTS.voice, 'the carried 30 seconds made a full minute');
  assert.equal(hist(h, IDS.member).at(-1)[2], 'Voice time');
});

test('level ups pay once per level, and old levels are never paid twice', async () => {
  const h = await make();
  await xp(h, { level: 5, leveledUp: true });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.levelup * 5, 'the first level up only pays that level, not every old one');
  await xp(h, { level: 7, leveledUp: true, serverId: null });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.levelup * (5 + 6 + 7), 'Party XP level ups with no server pay too');
  await xp(h, { level: 6, leveledUp: true });
  await xp(h, { level: 7, leveledUp: true });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.levelup * 18, 'a reset and re-level pays nothing again');
  await xp(h, { level: 8, leveledUp: false });
  await h.settle();
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.levelup * 18, 'no level up, no pay');
});

test('the weekly bonus pays once every 7 days from /daily weekly and the wallet button', async () => {
  const h = await make();
  const ans = await h.slash('daily', 'weekly', { user: IDS.member });
  assert.match(lastText(h, ans), /weekly bonus/i);
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.weekly);
  const again = await h.slash('balance', 'weekly', { user: IDS.member });
  assert.match(lastText(h, again), /Already claimed this week/);
  assert.equal(bal(h, IDS.member), PAY_DEFAULTS.weekly);
  await h.advance(WEEK_MS);
  await h.slash('daily', 'week', { user: IDS.member });
  assert.equal(bal(h, IDS.member), 2 * PAY_DEFAULTS.weekly);
  const daily = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, daily), /balance earn/);
});

test('/balance earn lists every way to earn with no Party daily limit', async () => {
  const h = await make();
  const ans = await h.slash('balance', 'earn', { user: IDS.member });
  const text = lastText(h, ans);
  for (const bit of ['/daily', 'weekly', 'Chatting', 'Voice', 'Level ups', 'Clans', 'YapOS Party', '/quests', 'daily puzzle']) assert.ok(text.includes(bit), bit);
  assert.match(text, /no daily limit/);
  const q = await h.slash('quests', '', { user: IDS.member });
  assert.match(lastText(h, q), /balance earn/);
});

test('only the owner sets activity pay, and 0 turns one off', async () => {
  const h = await make();
  const denied = await h.slash('economy', 'earn chat 9', { user: IDS.admin });
  assert.match(lastText(h, denied), /Owner only/);
  assert.equal(activityPay(h.engine.store.get('config', GLOBAL_KEY, {})?.economy || {}).chat, PAY_DEFAULTS.chat);
  await h.slash('economy', 'earn 0 2 20 900', { user: IDS.owner });
  assert.deepEqual(eco(h).activityPay(), { chat: 0, voice: 2, levelup: 20, weekly: 900 });
  await h.slash('economy', 'chat 7', { user: IDS.owner });
  assert.equal(eco(h).activityPay().chat, 7);
  const bad = await h.slash('economy', 'earn voice 500', { user: IDS.owner });
  assert.match(lastText(h, bad), /can be 0 to 20/);
  const cap = await h.slash('economy', 'party cap 150', { user: IDS.owner });
  assert.match(lastText(h, cap), /no daily limit/i);
  await h.slash('economy', 'earn chat 0', { user: IDS.owner });
  await xp(h, { messages: 1 });
  await h.settle();
  assert.equal(bal(h, IDS.member), 0);
});

test('activity pay counts toward the Earn 150 Shards quest source list', async () => {
  const h = await make();
  const seen = [];
  h.bot.on('shards:earned', (ev) => { seen.push(ev.source); });
  await xp(h, { messages: 1, voiceSeconds: 60, level: 3, leveledUp: true });
  await h.settle();
  assert.deepEqual(seen.sort(), ['chat', 'levelup', 'voice']);
});
