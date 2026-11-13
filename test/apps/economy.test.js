import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';
import { parseAmount, streakBonus } from '../../apps/economy.js';
import { GLOBAL_KEY, CURRENCY } from '../../engine/global.js';

const S = IDS.server;
const R = IDS.roles;
const OTHER = '5e000000-0000-4000-8000-0000000000ff';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const make = (opts = {}) => createHarness({ apps: ['economy'], fakeClock: true, ...opts });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const eco = (h) => h.engine.service('economy');
const bal = (h, uid) => eco(h).balance(S, uid);
const userDoc = (h, uid) => h.engine.store.get('economy', GLOBAL_KEY, {}).users?.[uid];

async function stockShop(h) {
  await h.slash('shop', `add role <@&${R.vip}> 500`, { user: IDS.admin });
  await h.slash('shop', 'add item "Golden ticket" 200', { user: IDS.admin });
}

function selectIn(h, ans) {
  return h.allButtons(ans).find((b) => b.isSelect) || null;
}

test('economy commands fit Yapin limits and the service is shared', async () => {
  const h = await make();
  for (const name of ['daily', 'balance', 'shop', 'economy']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100, `/${name} description fits`);
  }
  const s = eco(h);
  for (const fn of ['currency', 'balance', 'add', 'take', 'transfer']) assert.equal(typeof s[fn], 'function', fn);
  assert.deepEqual(s.currency(S), { name: 'Shards', emoji: '💎' });
});

test('amount parsing and streak bonus', () => {
  assert.equal(parseAmount('50'), 50);
  assert.equal(parseAmount('1,000'), 1000);
  assert.equal(parseAmount('2.5k'), 2500);
  assert.equal(parseAmount('1m'), 1_000_000);
  assert.equal(parseAmount('3b'), 3_000_000_000);
  assert.equal(parseAmount('1t'), 1_000_000_000_000);
  assert.ok(Number.isNaN(parseAmount('1.5')));
  assert.ok(Number.isNaN(parseAmount('9999t')));
  assert.equal(parseAmount('sam'), null);
  assert.equal(parseAmount('inf'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(streakBonus(1), 10);
  assert.equal(streakBonus(5), 50);
  assert.equal(streakBonus(10), 100);
  assert.equal(streakBonus(40), 100);
});

test('daily pays, refuses a second claim, grows the streak and caps it', async () => {
  const h = await make();
  const first = await h.slash('daily', '');
  assert.match(lastText(h, first), /\+110 Shards \(day 1\)/);
  assert.match(lastText(h, first), /Balance \*\*110\*\* · next daily in 24h/);
  assert.equal(bal(h, IDS.member), 110);

  await h.advance(5 * HOUR);
  const again = await h.slash('daily', '');
  assert.match(lastText(h, again), /Already claimed today/);
  assert.match(lastText(h, again), /19h/);
  assert.equal(again[again.length - 1].type, 'ephemeral');
  assert.equal(bal(h, IDS.member), 110);

  await h.advance(19 * HOUR);
  const day2 = await h.slash('daily', '');
  assert.match(lastText(h, day2), /\+120 Shards \(day 2 streak 🔥\)/);
  assert.equal(bal(h, IDS.member), 230);

  for (let d = 3; d <= 12; d++) {
    await h.advance(DAY + 60_000);
    await h.slash('daily', '');
  }
  const u = userDoc(h, IDS.member);
  assert.equal(u.streak, 12);
  assert.equal(u.hist[u.hist.length - 1][1], 200, 'bonus stops at +100%');
});

test('daily streak resets after 48 hours and says so', async () => {
  const h = await make();
  await h.slash('daily', '');
  await h.advance(30 * HOUR);
  await h.slash('daily', '');
  assert.equal(userDoc(h, IDS.member).streak, 2);
  await h.advance(49 * HOUR);
  const ans = await h.slash('daily', '');
  assert.match(lastText(h, ans), /\+110 Shards \(day 1\)/);
  assert.match(lastText(h, ans), /2-day streak ended/);
  assert.equal(userDoc(h, IDS.member).streak, 1);
});

test('coin amounts and settings go far past a million', async () => {
  const h = await make();
  await h.slash('economy', 'daily 5b', { user: IDS.owner });
  assert.equal(h.engine.settings.appConfig(GLOBAL_KEY, 'economy').dailyAmount, 5_000_000_000);
  await h.slash('economy', 'start 1b', { user: IDS.owner });
  assert.equal(bal(h, IDS.member2), 1_000_000_000);

  const give = await h.slash('economy', 'give @sam 2t', { user: IDS.owner });
  assert.match(lastText(h, give), /2,000,000,000,000/);
  assert.equal(bal(h, IDS.member), 2_001_000_000_000);
  assert.match(lastText(h, await h.slash('economy', 'give @sam 9999t', { user: IDS.owner })), /didn't work/);

  await stockShop(h);
  const cost = await h.slash('shop', 'price 2 3b', { user: IDS.admin });
  assert.match(lastText(h, cost), /3,000,000,000/);
  const stock = await h.slash('shop', 'stock "Golden ticket" 50m', { user: IDS.admin });
  assert.match(lastText(h, stock), /50,000,000 left/);
  const open = await h.slash('shop', 'stock "Golden ticket" inf', { user: IDS.admin });
  assert.match(lastText(h, open), /no limit/);
  assert.equal(h.engine.store.get('economy', S).items[1].stock, null);
});

test('daily amount 0 turns daily off', async () => {
  const h = await make();
  await h.slash('economy', 'daily 0', { user: IDS.owner });
  const ans = await h.slash('daily', '');
  assert.match(lastText(h, ans), /Daily is off/);
  assert.equal(bal(h, IDS.member), 0);
});

test('balance card shows wallet, rank, streak and buttons; others have no buttons', async () => {
  const h = await make();
  await h.slash('daily', '');
  eco(h).add(S, IDS.member2, 500, 'test');
  const mine = await h.slash('balance', '');
  const text = lastText(h, mine);
  assert.match(text, /Sam's wallet/);
  assert.match(text, /110 Shards 💎/);
  assert.match(text, /#2 of 2/);
  assert.match(text, /1 day/);
  for (const label of ['Daily', 'Work', 'Top 10', 'History']) assert.ok(h.findButton(label, mine), label);
  const theirs = await h.slash('balance', '@riley');
  assert.match(lastText(h, theirs), /Riley's wallet/);
  assert.match(lastText(h, theirs), /#1 of 2/);
  assert.equal(h.allButtons(theirs).length, 0);
  const bot = await h.slash('balance', `<@${IDS.bot}>`);
  assert.match(lastText(h, bot), /Bots have no wallet/);
  const nobody = await h.slash('balance', 'zzzzqqq');
  assert.match(lastText(h, nobody), /couldn't find/);
});

test('wallet buttons act for whoever presses them and are locked to the opener', async () => {
  const h = await make();
  const card = await h.slash('balance', '');
  const daily = await h.clickButton('Daily', { user: IDS.member, in: card });
  assert.match(lastText(h, daily), /\+110 Shards/);
  const stranger = await h.clickButton('Work', { user: IDS.member2, in: card });
  assert.match(lastText(h, stranger), /Not your panel/);
  assert.equal(bal(h, IDS.member2), 0);
});

test('work pays within range, has a cooldown, and can be turned off', async () => {
  const h = await make();
  const ans = await h.slash('balance', 'work');
  const got = bal(h, IDS.member);
  assert.ok(got >= 20 && got <= 80, `paid ${got}`);
  assert.match(lastText(h, ans), /Shift done/);
  assert.match(lastText(h, ans), /earned/);
  const again = await h.slash('balance', 'work');
  assert.match(lastText(h, again), /work again in \*\*1h\*\*/);
  assert.equal(bal(h, IDS.member), got);
  await h.advance(HOUR);
  await h.slash('balance', 'work');
  assert.ok(bal(h, IDS.member) > got);

  await h.slash('economy', 'work 5 5', { user: IDS.owner });
  await h.advance(HOUR);
  const before = bal(h, IDS.member);
  await h.slash('balance', 'work');
  assert.equal(bal(h, IDS.member), before + 5);

  await h.slash('economy', 'work off', { user: IDS.owner });
  await h.advance(HOUR);
  const off = await h.slash('balance', 'work');
  assert.match(lastText(h, off), /Work is off/);
  assert.equal(bal(h, IDS.member), before + 5);
});

test('pay moves Shards, refuses self, bots, missing people and overspending', async () => {
  const h = await make();
  eco(h).add(S, IDS.member, 300, 'seed');
  const ok = await h.slash('balance', 'pay @riley 50');
  assert.match(lastText(h, ok), /Sam paid Riley/);
  assert.equal(bal(h, IDS.member), 250);
  assert.equal(bal(h, IDS.member2), 50);
  assert.match(lastText(h, await h.slash('balance', 'pay @sam 5')), /can't pay yourself/);
  assert.match(lastText(h, await h.slash('balance', `pay <@${IDS.bot}> 5`)), /Bots can't take Shards/);
  assert.match(lastText(h, await h.slash('balance', 'pay @riley 9999')), /Not enough Shards/);
  assert.match(lastText(h, await h.slash('balance', 'pay @riley 1.5')), /amount didn't work/);
  assert.match(lastText(h, await h.slash('balance', 'pay @riley')), /Pay who, and how much/);
  assert.match(lastText(h, await h.slash('balance', 'pay a0000000-0000-4000-8000-0000000000ff 5')), /isn't in this server/);
  assert.equal(bal(h, IDS.member), 250);
  assert.equal(bal(h, IDS.member2), 50);
  const hist = userDoc(h, IDS.member2).hist;
  assert.match(hist[hist.length - 1][2], /From Sam/);
});

test('big payments ask first; only the payer can confirm, and only once', async () => {
  const h = await make();
  eco(h).add(S, IDS.member, 5000, 'seed');
  const ask = await h.slash('balance', 'pay @riley 2,000');
  assert.match(lastText(h, ask), /Big payment/);
  assert.equal(bal(h, IDS.member2), 0);
  const stranger = await h.clickButton('Send 2,000', { user: IDS.member2, in: ask });
  assert.match(lastText(h, stranger), /Not your panel|Not yours/);
  const b = h.findButton('Send 2,000', ask);
  const sneaky = await h.click(b.custom_id, { user: IDS.member2 });
  assert.match(lastText(h, sneaky), /Not yours/);
  assert.equal(bal(h, IDS.member2), 0);
  const done = await h.clickButton('Send 2,000', { user: IDS.member, in: ask });
  assert.match(lastText(h, done), /Sam paid Riley/);
  assert.equal(bal(h, IDS.member), 3000);
  assert.equal(bal(h, IDS.member2), 2000);
  const twice = await h.click(b.custom_id, { user: IDS.member });
  assert.match(lastText(h, twice), /Already handled/);
  assert.equal(bal(h, IDS.member), 3000);

  const ask2 = await h.slash('balance', 'pay @riley 1500');
  await h.clickButton('Cancel', { user: IDS.member, in: ask2 });
  assert.equal(bal(h, IDS.member), 3000);
  const ask3 = await h.slash('balance', 'pay @riley 1500');
  eco(h).take(S, IDS.member, 2000, 'spent elsewhere');
  const late = await h.clickButton('Send 1,500', { user: IDS.member, in: ask3 });
  assert.match(lastText(h, late), /Not enough Shards/);
  assert.equal(bal(h, IDS.member), 1000);
});

test('top shows the richest with medals and your own place', async () => {
  const h = await make();
  eco(h).add(S, IDS.member, 300, 'x');
  eco(h).add(S, IDS.member2, 900, 'x');
  eco(h).add(S, IDS.mod, 50, 'x');
  const ans = await h.slash('balance', 'top');
  const text = lastText(h, ans);
  assert.match(text, /Richest yappers everywhere/);
  assert.match(text, /One leaderboard for every server/);
  assert.match(text, /🥇 Riley · 900 💎/);
  assert.match(text, /🥈 Sam · 300 💎/);
  assert.match(text, /🥉 Mo · 50 💎/);
  assert.match(text, /You: \*\*#2\*\*/);
});

test('history keeps the last 20 changes; others only for admins', async () => {
  const h = await make();
  for (let i = 1; i <= 25; i++) eco(h).add(S, IDS.member, i, `gift ${i}`);
  assert.equal(userDoc(h, IDS.member).hist.length, 20);
  const ans = await h.slash('balance', 'history');
  const text = lastText(h, ans);
  assert.match(text, /last 20 changes/);
  assert.match(text, /gift 25/);
  assert.doesNotMatch(text, /gift 5\b/);
  assert.equal(ans[ans.length - 1].type, 'ephemeral');
  const denied = await h.slash('balance', 'history @riley');
  assert.match(lastText(h, denied), /Only admins/);
  const adminView = await h.slash('balance', 'history @sam', { user: IDS.admin });
  assert.match(lastText(h, adminView), /Sam's last 20 changes/);
});

test('shop admin commands: add, refuse protected roles, members denied', async () => {
  const h = await make();
  const denied = await h.slash('shop', `add role <@&${R.vip}> 500`);
  assert.match(lastText(h, denied), /Only admins/);
  await stockShop(h);
  const items = h.engine.store.get('economy', S).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].roleId, R.vip);
  assert.equal(items[1].name, 'Golden ticket');
  assert.match(lastText(h, await h.slash('shop', `add role <@&${R.mod}> 100`, { user: IDS.admin })), /staff permissions/);
  assert.match(lastText(h, await h.slash('shop', `add role <@&${R.admin}> 100`, { user: IDS.admin })), /staff permissions|above/);
  h.engine.settings.patchApp(S, 'tickets', { staffRoles: [R.gamer] });
  assert.match(lastText(h, await h.slash('shop', 'add role Gamer 100', { user: IDS.admin })), /ticket staff/);
  h.engine.settings.patchApp(S, 'tickets', { staffRoles: [] });
  h.engine.settings.patchCore(S, { modRoles: [R.gamer] });
  assert.match(lastText(h, await h.slash('shop', 'add role Gamer 100', { user: IDS.admin })), /YapOS moderator/);
  h.engine.settings.patchCore(S, { modRoles: [] });
  assert.match(lastText(h, await h.slash('shop', 'add VIP 100', { user: IDS.admin })), /A role or an item/);
  assert.match(lastText(h, await h.slash('shop', 'add item Cookie 0', { user: IDS.admin })), /price didn't work/);
  const again = await h.slash('shop', `add role <@&${R.vip}> 650`, { user: IDS.admin });
  assert.match(lastText(h, again), /Price updated/);
  assert.equal(h.engine.store.get('economy', S).items.length, 2);
  assert.equal(h.engine.store.get('economy', S).items[0].price, 650);
});

test('the shop card is public, lists items and is not locked', async () => {
  const h = await make();
  const empty = await h.slash('shop', '');
  assert.match(lastText(h, empty), /shop is empty/);
  await stockShop(h);
  const ans = await h.slash('shop', '');
  const text = lastText(h, ans);
  assert.match(text, /🛒 \*\*VIP\*\* · 500 💎 · gives @VIP/);
  assert.match(text, /🛒 \*\*Golden ticket\*\* · 200 💎/);
  assert.equal(ans[ans.length - 1].type, 'reply');
  const sel = selectIn(h, ans);
  assert.ok(sel, 'has a select menu');
  assert.equal(h.engine.router.panelOwner(ans[ans.length - 1].message.id), null, 'nobody owns the shop card');
  const wallet = await h.clickButton('My wallet', { user: IDS.member2, in: ans });
  assert.match(lastText(h, wallet), /Riley's wallet/);
});

test('buying a role: confirm, take Shards, give the role, refuse a second buy', async () => {
  const h = await make();
  await stockShop(h);
  eco(h).add(S, IDS.member, 600, 'seed');
  const shop = await h.slash('shop', '');
  const sel = selectIn(h, shop);
  const items = h.engine.store.get('economy', S).items;
  const ask = await h.pick(sel.custom_id, [items[0].id], { user: IDS.member, messageId: shop[shop.length - 1].message.id });
  assert.match(lastText(h, ask), /Buy VIP\?/);
  assert.match(lastText(h, ask), /You get the \*\*@VIP\*\* role/);
  const thief = await h.click(h.findButton('Buy for 500', ask).custom_id, { user: IDS.member2 });
  assert.match(lastText(h, thief), /Not yours/);
  const done = await h.clickButton('Buy for 500', { user: IDS.member, in: ask });
  assert.match(lastText(h, done), /Bought VIP/);
  assert.equal(bal(h, IDS.member), 100);
  assert.ok(h.fake.memberOf(S, IDS.member).roles.includes(R.vip));
  const twice = await h.click(h.findButton('Buy for 500', ask).custom_id, { user: IDS.member });
  assert.match(lastText(h, twice), /Already handled/);
  assert.equal(bal(h, IDS.member), 100);
  const typed = await h.slash('shop', 'buy vip');
  assert.match(lastText(h, typed), /already have/);
});

test('not enough Shards and price changes never charge', async () => {
  const h = await make();
  await stockShop(h);
  eco(h).add(S, IDS.member, 300, 'seed');
  const poor = await h.slash('shop', 'buy VIP');
  assert.match(lastText(h, poor), /Not enough Shards/);
  assert.match(lastText(h, poor), /200 💎 more/);
  const ask = await h.slash('shop', 'buy golden');
  assert.match(lastText(h, ask), /Buy Golden ticket\?/);
  await h.slash('shop', 'price "Golden ticket" 250', { user: IDS.admin });
  const late = await h.clickButton('Buy for 200', { user: IDS.member, in: ask });
  assert.match(lastText(h, late), /price changed/);
  assert.equal(bal(h, IDS.member), 300);
});

test('custom items go to the inventory and show in /balance', async () => {
  const h = await make();
  await stockShop(h);
  eco(h).add(S, IDS.member, 500, 'seed');
  for (let i = 0; i < 2; i++) {
    const ask = await h.slash('shop', 'buy golden');
    await h.clickButton('Buy for 200', { user: IDS.member, in: ask });
  }
  assert.equal(bal(h, IDS.member), 100);
  const card = await h.slash('balance', '');
  assert.match(lastText(h, card), /2× Golden ticket/);
  const hist = userDoc(h, IDS.member).hist;
  assert.match(hist[hist.length - 1][2], /Bought Golden ticket/);
  const slots = Object.keys(userDoc(h, IDS.member).inv);
  assert.deepEqual(slots.map((k) => k.startsWith(`${S}:`)), [true], 'inventory slots name the shop they came from');
});

test('limited stock sells out and the posted shop card updates', async () => {
  const h = await make();
  await stockShop(h);
  const stock = await h.slash('shop', 'stock "Golden ticket" 1', { user: IDS.admin });
  assert.match(lastText(h, stock), /1 left/);
  const shop = await h.slash('shop', '');
  const shopMsg = shop[shop.length - 1].message;
  assert.match(h.textOf(shopMsg), /1 left/);
  eco(h).add(S, IDS.member, 1000, 'seed');
  eco(h).add(S, IDS.member2, 1000, 'seed');
  const a = await h.slash('shop', 'buy golden');
  const b = await h.slash('shop', 'buy golden', { user: IDS.member2 });
  await h.clickButton('Buy for 200', { user: IDS.member, in: a });
  const lost = await h.clickButton('Buy for 200', { user: IDS.member2, in: b });
  assert.match(lastText(h, lost), /Sold out/);
  assert.equal(bal(h, IDS.member2), 1000);
  await h.settle();
  const edited = h.fake.messagesIn(shopMsg.channel_id).find((m) => m.id === shopMsg.id);
  assert.match(h.textOf(edited), /sold out/);
  const soldOut = await h.slash('shop', 'buy golden', { user: IDS.member2 });
  assert.match(lastText(h, soldOut), /Sold out/);
  await h.slash('shop', 'stock golden off', { user: IDS.admin });
  assert.equal(h.engine.store.get('economy', S).items[1].stock, null);
  const which = await h.slash('shop', 'stock 5', { user: IDS.admin });
  assert.match(lastText(h, which), /Which item/);
});

test('a failed role grant refunds the Shards and the stock', async () => {
  const h = await make();
  await stockShop(h);
  await h.slash('shop', 'stock VIP 3', { user: IDS.admin });
  eco(h).add(S, IDS.member, 600, 'seed');
  const ask = await h.slash('shop', 'buy vip');
  h.fake.fail('PUT', /\/roles\//, { status: 403, times: 1 });
  const ans = await h.clickButton('Buy for 500', { user: IDS.member, in: ask });
  assert.match(lastText(h, ans), /Couldn't give the role/);
  assert.match(lastText(h, ans), /went back to your wallet/);
  assert.equal(bal(h, IDS.member), 600);
  assert.equal(h.engine.store.get('economy', S).items[0].stock, 3);
  assert.ok(!h.fake.memberOf(S, IDS.member).roles.includes(R.vip));
  const hist = userDoc(h, IDS.member).hist;
  assert.match(hist[hist.length - 1][2], /Refund: VIP/);
});

test('a role that gains staff permissions is paused at purchase without charging', async () => {
  const h = await make();
  await stockShop(h);
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  eco(h).add(S, IDS.member, 600, 'seed');
  const ask = await h.slash('shop', 'buy vip');
  h.fake.state.roles[S].find((r) => r.id === R.vip).perms = { kick_members: true };
  h.engine.perms.invalidate();
  const ans = await h.clickButton('Buy for 500', { user: IDS.member, in: ask });
  assert.match(lastText(h, ans), /paused/);
  assert.equal(bal(h, IDS.member), 600);
  assert.match(h.textOf(h.lastSent(IDS.channels.modlog)), /Shop item paused/);
});

test('without select menus the shop falls back to buttons', async () => {
  const h = await make({ features: { selects: false } });
  await stockShop(h);
  eco(h).add(S, IDS.member, 600, 'seed');
  const shop = await h.slash('shop', '');
  assert.equal(selectIn(h, shop), null);
  const ask = await h.clickButton('VIP · 500', { user: IDS.member, in: shop });
  assert.match(lastText(h, ask), /Buy VIP\?/);
  await h.clickButton('Buy for 500', { user: IDS.member, in: ask });
  assert.ok(h.fake.memberOf(S, IDS.member).roles.includes(R.vip));
});

test('shop remove has Undo and the shop holds at most 20 items', async () => {
  const h = await make();
  await stockShop(h);
  const which = await h.slash('shop', 'remove', { user: IDS.admin });
  assert.match(lastText(h, which), /Remove which item/);
  const ans = await h.slash('shop', 'remove 2', { user: IDS.admin });
  assert.match(lastText(h, ans), /Taken out of the shop/);
  assert.equal(h.engine.store.get('economy', S).items.length, 1);
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.equal(h.engine.store.get('economy', S).items.length, 2);
  assert.equal(h.engine.store.get('economy', S).items[1].name, 'Golden ticket');
  for (let i = 0; i < 18; i++) await h.slash('shop', `add item Thing${i} 10`, { user: IDS.admin });
  const full = await h.slash('shop', 'add item Extra 10', { user: IDS.admin });
  assert.match(lastText(h, full), /shop is full/);
  const shop = await h.slash('shop', '');
  const sel = selectIn(h, shop);
  assert.equal(sel.options.length, 20);
});

test('/economy is admins only, and only the owner gets its buttons', async () => {
  const h = await make();
  const denied = await h.slash('economy', '');
  assert.match(lastText(h, denied), /Only admins/);
  const adminPanel = await h.slash('economy', '', { user: IDS.admin });
  assert.match(lastText(h, adminPanel), /Economy settings/);
  assert.equal(h.allButtons(adminPanel).length, 0, 'admins see the panel but no earn or give buttons');
  const panel = await h.slash('economy', '', { user: IDS.owner });
  const text = lastText(h, panel);
  assert.match(text, /Economy settings/);
  assert.match(text, /Shards/);
  for (const label of ['Daily amount', 'Work: on', 'Give Shards', 'Take Shards', 'Reset someone']) assert.ok(h.findButton(label, panel), label);
  assert.equal(h.findButton('Currency', panel), null, 'the currency editor is gone');
  const toggled = await h.clickButton('Work: on', { user: IDS.owner, in: panel });
  assert.ok(toggled.length);
  assert.equal(h.engine.settings.appConfig(GLOBAL_KEY, 'economy').workEnabled, false);
  const sneaky = await h.click(h.findButton('Give Shards', panel).custom_id, { user: IDS.member });
  assert.match(lastText(h, sneaky), /Only admins/);
  const adminTry = await h.click(h.findButton('Give Shards', panel).custom_id, { user: IDS.admin });
  assert.match(lastText(h, adminTry), /Only the bot owner/);
});

test('give and take are logged and can be undone', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  const give = await h.slash('economy', 'give @sam 100 contest prize', { user: IDS.owner });
  assert.match(lastText(h, give), /Gave \*\*100\*\* Shards/);
  assert.equal(bal(h, IDS.member), 100);
  await h.settle();
  const log = h.textOf(h.lastSent(IDS.channels.modlog));
  assert.match(log, /Shards given/);
  assert.match(log, /contest prize/);
  const hist = userDoc(h, IDS.member).hist;
  assert.match(hist[hist.length - 1][2], /Given by Jolli: contest prize/);
  await h.clickButton('Undo', { user: IDS.owner, in: give });
  assert.equal(bal(h, IDS.member), 0);

  eco(h).add(S, IDS.member, 30, 'seed');
  const take = await h.slash('economy', 'take @sam 100', { user: IDS.owner });
  assert.match(lastText(h, take), /all they had/);
  assert.equal(bal(h, IDS.member), 0);
  await h.clickButton('Undo', { user: IDS.owner, in: take });
  assert.equal(bal(h, IDS.member), 30);
  assert.match(lastText(h, await h.slash('economy', `give <@${IDS.bot}> 5`, { user: IDS.owner })), /Bots can't hold Shards/);
  assert.match(lastText(h, await h.slash('economy', 'give @sam lots', { user: IDS.owner })), /how much/);
});

test('give through the panel form', async () => {
  const h = await make();
  const panel = await h.slash('economy', '', { user: IDS.owner });
  const opened = await h.clickButton('Give Shards', { user: IDS.owner, in: panel });
  assert.equal(opened[opened.length - 1].type, 'modal');
  const modalId = opened[opened.length - 1].modal.custom_id;
  const saved = await h.submit(modalId, { user: '@riley', amount: '75', reason: 'helping out' }, { user: IDS.owner });
  assert.match(lastText(h, saved), /Gave \*\*75\*\* Shards/);
  assert.equal(bal(h, IDS.member2), 75);
});

test('reset wipes a wallet with Undo', async () => {
  const h = await make();
  await h.slash('daily', '');
  const ans = await h.slash('economy', 'reset @sam', { user: IDS.owner });
  assert.match(lastText(h, ans), /Wallet reset/);
  assert.equal(userDoc(h, IDS.member), undefined);
  const member = await h.clickButton('Undo', { user: IDS.member, in: ans });
  assert.ok(member.length);
  assert.equal(userDoc(h, IDS.member), undefined, 'members cannot undo');
  await h.clickButton('Undo', { user: IDS.owner, in: ans });
  assert.equal(bal(h, IDS.member), 110);
  assert.equal(userDoc(h, IDS.member).streak, 1);
  assert.match(lastText(h, await h.slash('economy', 'reset @riley', { user: IDS.owner })), /Nothing to reset/);
});

test('the currency is always Shards and cannot be changed', async () => {
  const h = await make();
  assert.deepEqual(eco(h).currency(S), CURRENCY);
  const fixed = await h.slash('economy', 'currency gems', { user: IDS.owner });
  assert.match(lastText(h, fixed), /One currency everywhere/);
  const emoji = await h.slash('economy', 'emoji XX', { user: IDS.owner });
  assert.match(lastText(h, emoji), /One currency everywhere/);
  assert.deepEqual(eco(h).currency(S), CURRENCY);
  const cfg = h.engine.settings.appConfig(GLOBAL_KEY, 'economy');
  assert.equal(cfg.currencyName, undefined);
  assert.equal(cfg.currencyEmoji, undefined);
});

test('daily, work and starting balance are one setting for the whole bot', async () => {
  const h = await make();
  await h.slash('economy', 'daily 250', { user: IDS.owner });
  const d = await h.slash('daily', '');
  assert.match(lastText(h, d), /\+275 Shards \(day 1\)/);
  await h.slash('economy', 'start 40', { user: IDS.owner });
  assert.equal(bal(h, IDS.member2), 40);
  await h.slash('balance', 'work', { user: IDS.member2 });
  assert.ok(bal(h, IDS.member2) >= 60);
  assert.match(userDoc(h, IDS.member2).hist[0][2], /Starting balance/);
  assert.match(lastText(h, await h.slash('economy', 'daily lots', { user: IDS.owner })), /didn't work/);
  assert.match(lastText(h, await h.slash('economy', 'wrok 1', { user: IDS.owner })), /Did you mean \*\*work\*\*/);
  await h.slash('economy', 'work 90 10', { user: IDS.owner });
  const cfg = h.engine.settings.appConfig(GLOBAL_KEY, 'economy');
  assert.equal(cfg.workMin, 10);
  assert.equal(cfg.workMax, 90);
  assert.equal(h.engine.settings.appConfig(S, 'economy').workMin, 20, 'nothing is stored per server');
});

test('only the owner can change earn rates or hand out Shards', async () => {
  const h = await make();
  const rate = await h.slash('economy', 'daily 500', { user: IDS.admin });
  assert.match(lastText(h, rate), /Only the bot owner can change how many Shards people earn/);
  assert.equal(h.engine.settings.appConfig(GLOBAL_KEY, 'economy').dailyAmount, 100);
  const give = await h.slash('economy', 'give @sam 100', { user: IDS.admin });
  assert.match(lastText(h, give), /Only the bot owner can hand out/);
  assert.equal(bal(h, IDS.member), 0);
  const reset = await h.slash('economy', 'reset @sam', { user: IDS.admin });
  assert.match(lastText(h, reset), /Only the bot owner/);

  const allowed = await h.slash('economy', 'allow @alex', { user: IDS.owner });
  assert.match(lastText(h, allowed), /can hand out/);
  const nowOk = await h.slash('economy', 'give @sam 100', { user: IDS.admin });
  assert.match(lastText(h, nowOk), /Gave \*\*100\*\* Shards/);
  assert.equal(bal(h, IDS.member), 100);
  const list = await h.slash('economy', 'givers', { user: IDS.owner });
  assert.match(lastText(h, list), /Who can hand out Shards/);

  await h.slash('economy', 'deny @alex', { user: IDS.owner });
  const blocked = await h.slash('economy', 'give @sam 100', { user: IDS.admin });
  assert.match(lastText(h, blocked), /Only the bot owner can hand out/);
  assert.equal(bal(h, IDS.member), 100);
  const notOwner = await h.slash('economy', 'allow @riley', { user: IDS.admin });
  assert.match(lastText(h, notOwner), /Only the bot owner/);
});

test('a giver still cannot hand the keys to someone else', async () => {
  const h = await make();
  await h.slash('economy', 'allow @alex', { user: IDS.owner });
  const tried = await h.slash('economy', 'allow @riley', { user: IDS.admin });
  assert.match(lastText(h, tried), /Only the bot owner can change who hands out Shards/);
  const riley = await h.slash('economy', 'give @sam 100', { user: IDS.member2 });
  assert.match(lastText(h, riley), /Only admins/);
  assert.equal(bal(h, IDS.member), 0);
});

test('Undo stops working once someone loses the right to hand out Shards', async () => {
  const h = await make();
  await h.slash('economy', 'allow @alex', { user: IDS.owner });
  const give = await h.slash('economy', 'give @sam 100', { user: IDS.admin });
  assert.equal(bal(h, IDS.member), 100);
  await h.slash('economy', 'deny @alex', { user: IDS.owner });
  const sneaky = await h.clickButton('Undo', { user: IDS.admin, in: give });
  assert.match(lastText(h, sneaky), /Only the bot owner can hand out/);
  assert.equal(bal(h, IDS.member), 100, 'an admin cannot move global Shards with Undo');
  await h.clickButton('Undo', { user: IDS.owner, in: give });
  assert.equal(bal(h, IDS.member), 0);
});

test('one wallet, one daily and one leaderboard for every server', async () => {
  const h = await make();
  await h.slash('daily', '');
  assert.equal(bal(h, IDS.member), 110);
  assert.equal(h.engine.store.get('economy', S, null)?.users?.[IDS.member], undefined, 'wallets are not stored per server');
  const s = eco(h);
  s.add(OTHER, IDS.member, 50, 'won elsewhere');
  assert.equal(s.balance(S, IDS.member), 160, 'a payout in another server shows up here');
  assert.equal(s.balance(OTHER, IDS.member), 160);
  const again = await h.slash('daily', '');
  assert.match(lastText(h, again), /one daily for the whole bot/);
});

test('old per-server wallets are summed once on start', async () => {
  const store = createMemoryStore();
  const other = '5e000000-0000-4000-8000-0000000000fe';
  const blank = () => ({ users: {}, items: [], seq: 0, shopMsgs: [] });
  store.update('economy', S, (d) => {
    d.users = { [IDS.member]: { bal: 100, streak: 3, lastDaily: 1000, lastWork: 0, inv: { i1: { name: 'Cookie', n: 2 } }, hist: [[1000, 100, 'old']], seen: 1000 } };
  }, blank());
  store.update('economy', other, (d) => {
    d.users = { [IDS.member]: { bal: 40, streak: 1, lastDaily: 9000, lastWork: 5, inv: { i1: { name: 'Potion', n: 1 } }, hist: [[9000, 40, 'newer']], seen: 9000 } };
  }, blank());

  const b = await createHarness({ apps: ['economy'], fakeClock: true, store });
  const u = userDoc(b, IDS.member);
  assert.equal(u.bal, 140, 'balances add up');
  assert.equal(u.streak, 1, 'the most recent daily wins');
  assert.equal(u.lastDaily, 9000);
  assert.equal(u.lastWork, 5);
  assert.equal(u.inv[`${S}:i1`].n, 2, 'each shop keeps its own items');
  assert.equal(u.inv[`${other}:i1`].name, 'Potion', 'two shops that both call an item i1 never merge');
  assert.equal(u.hist[u.hist.length - 1][2], 'newer');
  b.engine.scheduler.stop();

  const c = await createHarness({ apps: ['economy'], fakeClock: true, store: b.store });
  assert.equal(userDoc(c, IDS.member).bal, 140, 'the merge never runs twice');
});

test('merging is safe on a bot with no data', async () => {
  const h = await make();
  assert.equal(bal(h, IDS.member), 0);
  assert.equal(h.engine.store.get('economy', GLOBAL_KEY, {}).merged, true);
});

test('earn settings are owner only on the dashboard', async () => {
  const h = await make();
  const fields = h.engine.apps.list().find((x) => x.meta.id === 'economy').def.dashboard;
  for (const key of ['dailyAmount', 'workMin', 'workMax', 'workEnabled', 'begEnabled', 'startBalance']) {
    const f = fields.find((x) => x.key === key);
    assert.ok(f, key);
    assert.equal(f.owner, true, key);
    assert.equal(typeof f.read, 'function', key);
  }
  assert.equal(fields.find((x) => x.key === 'currencyName'), undefined);
  assert.equal(fields.find((x) => x.key === 'currencyEmoji'), undefined);
});

test('service contract: integers only, atomic take, never negative, transfer', async () => {
  const h = await make();
  const s = eco(h);
  assert.equal(s.balance(S, IDS.member), 0);
  assert.equal(s.add(S, IDS.member, 100, 'game win'), 100);
  assert.equal(s.take(S, IDS.member, 150, 'bet'), null);
  assert.equal(s.balance(S, IDS.member), 100);
  assert.equal(s.take(S, IDS.member, 40, 'bet'), 60);
  assert.throws(() => s.add(S, IDS.member, 1.5, 'x'), /whole numbers/);
  assert.throws(() => s.add(S, IDS.member, -5, 'x'), /whole numbers/);
  assert.throws(() => s.take(S, IDS.member, 0, 'x'), /whole numbers/);
  assert.equal(s.transfer(S, IDS.member, IDS.member2, 100, 'trade'), false);
  assert.equal(s.transfer(S, IDS.member, IDS.member, 10, 'trade'), false);
  assert.equal(s.transfer(S, IDS.member, IDS.member2, 60, 'trade'), true);
  assert.equal(s.balance(S, IDS.member), 0);
  assert.equal(s.balance(S, IDS.member2), 60);
  assert.equal(s.take(S, IDS.member, 1, 'x'), null);
  assert.equal(s.add(S, IDS.bot, 10, 'x'), 0);
  assert.equal(s.balance(S, IDS.bot), 0);
  const results = [s.take(S, IDS.member2, 50, 'a'), s.take(S, IDS.member2, 50, 'b')];
  assert.deepEqual(results, [10, null]);
  assert.equal(userDoc(h, IDS.member2).hist[userDoc(h, IDS.member2).hist.length - 1][2], 'a');
  s.add(S, IDS.member, 999_999_999, 'big');
  s.add(S, IDS.member, 999_999_999, 'big');
  assert.equal(Number.isInteger(s.balance(S, IDS.member)), true);
});

test('wallets and streaks survive a restart', async () => {
  const a = await make();
  await a.slash('daily', '');
  await a.slash('shop', 'add item Cookie 10', { user: IDS.admin });
  a.engine.scheduler.stop();
  const b = await createHarness({ apps: ['economy'], fakeClock: true, store: a.store });
  b.clock.t = a.clock.t + 25 * HOUR;
  assert.equal(b.engine.service('economy').balance(S, IDS.member), 110);
  const ans = await b.slash('daily', '');
  assert.match(lastText(b, ans), /\+120 Shards \(day 2 streak 🔥\)/);
  assert.equal(b.engine.store.get('economy', S).items[0].name, 'Cookie');
});

test('home screen tile opens the wallet for members and settings for admins', async () => {
  const h = await make();
  const home = await h.slash('menu', '');
  const tile = h.findButton('Economy', home);
  assert.ok(tile, 'members see the Economy tile');
  const opened = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.match(lastText(h, opened), /Sam's wallet/);
  const adminHome = await h.slash('menu', '', { user: IDS.admin });
  const atile = h.findButton('Economy', adminHome);
  const aopened = await h.click(atile.custom_id, { user: IDS.admin, messageId: atile.messageId });
  assert.match(lastText(h, aopened), /Economy settings/);
});

test('/yap routes to economy and uninstalling blocks it', async () => {
  const h = await make();
  const ans = await h.slash('yap', 'daily');
  assert.match(lastText(h, ans), /\+110 Shards/);
  const pay = await h.slash('yap', 'pay @riley 10');
  assert.match(lastText(h, pay), /Sam paid Riley/);
  h.engine.settings.setEnabled(S, 'economy', false);
  const off = await h.slash('balance', '');
  assert.match(lastText(h, off), /isn't installed/);
});

test('typed chat commands work too', async () => {
  const h = await make();
  await h.message('!daily');
  assert.equal(bal(h, IDS.member), 110);
  await h.message(`!balance pay <@${IDS.member2}> 25`);
  assert.equal(bal(h, IDS.member2), 25);
  assert.match(h.textOf(h.lastSent(IDS.channels.general)), /Sam paid Riley/);
});

test('day 5 of a streak pays +50% and reads like the brief', async () => {
  const h = await make();
  for (let d = 1; d <= 4; d++) {
    await h.slash('daily', '');
    await h.advance(DAY + 60_000);
  }
  const ans = await h.slash('daily', '');
  assert.match(lastText(h, ans), /💎 \+150 Shards \(day 5 streak 🔥\)/);
  assert.match(lastText(h, ans), /Streak bonus \+50%/);
});

test('a used or cancelled buy confirmation never charges again', async () => {
  const h = await make();
  await stockShop(h);
  eco(h).add(S, IDS.member, 1000, 'seed');
  const ask = await h.slash('shop', 'buy golden');
  const b = h.findButton('Buy for 200', ask);
  assert.ok(Buffer.byteLength(b.custom_id) <= 100);
  await h.click(b.custom_id, { user: IDS.member });
  assert.equal(bal(h, IDS.member), 800);
  const again = await h.click(b.custom_id, { user: IDS.member });
  assert.match(lastText(h, again), /Already handled/);
  assert.equal(bal(h, IDS.member), 800);
  assert.match(lastText(h, await h.slash('balance', '')), /1× Golden ticket/);

  const ask2 = await h.slash('shop', 'buy golden');
  const b2 = h.findButton('Buy for 200', ask2);
  await h.clickButton('Cancel', { user: IDS.member, in: ask2 });
  const afterCancel = await h.click(b2.custom_id, { user: IDS.member });
  assert.match(lastText(h, afterCancel), /Already handled/);
  assert.equal(bal(h, IDS.member), 800);

  const forged = await h.click(`yo:economy:buyok:zzzzzz:${IDS.member}`, { user: IDS.member });
  assert.match(lastText(h, forged), /Already handled/);
  assert.equal(bal(h, IDS.member), 800);
});

test('names never show raw ids', async () => {
  const h = await make();
  await h.slash('economy', `give @sam 50 for <@&${R.vip}> and <@${IDS.member2}> @everyone`, { user: IDS.owner });
  const hist = await h.slash('balance', 'history');
  const text = lastText(h, hist);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}/);
  assert.doesNotMatch(text, /@everyone/);
  assert.match(text, /@​role and @​someone/);

  const added = await h.slash('shop', `add item "VIP <@&${R.vip}> pass" 10`, { user: IDS.admin });
  assert.doesNotMatch(lastText(h, added), /[0-9a-f]{8}-[0-9a-f]{4}/);
  assert.doesNotMatch(h.engine.store.get('economy', S).items[0].name, /[0-9a-f]{8}-/);
});

test('with daily off the wallet hides the Daily button, and empty takes leave no history line', async () => {
  const h = await make();
  await h.slash('economy', 'daily 0', { user: IDS.owner });
  const card = await h.slash('balance', '');
  assert.equal(h.findButton('Daily', card), null);
  assert.match(lastText(h, card), /Daily\s+Off/);
  const take = await h.slash('economy', 'take @sam 10', { user: IDS.owner });
  assert.match(lastText(h, take), /no Shards to take/);
  assert.equal((userDoc(h, IDS.member)?.hist || []).length, 0);
});

test('beg sometimes pays a little, always has a cooldown, and works typed too', async () => {
  const h = await make();
  const c = h.bot.commands.get('beg');
  assert.ok(c && c.description.length <= 100);
  const ans = await h.slash('beg', '');
  const got = bal(h, IDS.member);
  assert.ok(got >= 0 && got <= 25, `got ${got}`);
  assert.match(lastText(h, ans), /Someone helped|No luck/);
  assert.match(lastText(h, ans), /beg again in/);
  const again = await h.slash('beg', '');
  assert.match(lastText(h, again), /Give it a rest/);
  assert.equal(bal(h, IDS.member), got);
  let paid = got;
  for (let i = 0; i < 20; i++) {
    await h.advance(5 * 60_000);
    await h.slash('balance', 'beg');
  }
  paid = bal(h, IDS.member);
  assert.ok(paid > got, 'twenty begs pay something');
  assert.ok(paid <= got + 20 * 25);
  assert.ok(userDoc(h, IDS.member).lastBeg);
});
