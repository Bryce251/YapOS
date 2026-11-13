import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHarness, IDS, settle } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';
import { ICONS, COLORS } from '../../engine/ui.js';
import {
  REEL, LIMITS, reelSymbol, slotPayout, diceFaces, dicePayout, rouletteWins, rouletteReturn,
  crashPointX100, multX100, msFor, handTotal, cardText, dealerPlays, parseAmountToken, resolveBet, parseArgs,
} from '../../apps/casino.js';

const S = IDS.server;
const G = IDS.channels.general;
const A = IDS.member;
const B = IDS.member2;
const START = Date.parse('2026-11-07T12:00:00Z');
const CARD = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, J: 10, Q: 11, K: 12 };

function fakeEconomy(start = {}) {
  const bal = { ...start };
  const log = [];
  return {
    bal,
    log,
    currency: () => ({ name: 'coins', emoji: '🪙' }),
    balance: (sid, uid) => bal[uid] || 0,
    add: (sid, uid, n, reason) => { bal[uid] = (bal[uid] || 0) + n; log.push(['add', uid, n, reason]); return bal[uid]; },
    take: (sid, uid, n, reason) => {
      if ((bal[uid] || 0) < n) return null;
      bal[uid] -= n;
      log.push(['take', uid, n, reason]);
      return bal[uid];
    },
    transfer: () => false,
  };
}

const withEco = (h, eco) => { h.engine.services.set('economy', eco); return eco; };
const svc = (h) => h.engine.service('casino');
const live = (h, id, ch = G) => h.fake.state.messages[ch].find((m) => m.id === id);
const replyMsg = (ans) => ans.find((a) => a.type === 'reply')?.message;
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const sweep = async (h) => { await svc(h).sweep(); await settle(); };
const clockAt = (t) => { t.mock.timers.enable({ apis: ['Date'], now: START }); return (ms) => t.mock.timers.tick(ms); };
const doc = (h) => h.engine.store.get('casino', S);
const jobs = (h) => h.engine.scheduler.list({ kind: 'casino.cleanup' });

const rolls = (h, ...values) => svc(h).useRandom((min, max) => {
  assert.ok(values.length, `ran out of rolls (wanted ${min}..${max - 1})`);
  const v = values.shift();
  assert.ok(Number.isInteger(v) && v >= min && v < max, `roll ${v} outside ${min}..${max - 1}`);
  return v;
});

async function make(opts = {}, { cooldown = 0, eco = { [A]: 1000, [B]: 1000 } } = {}) {
  const h = await createHarness({ apps: ['casino'], ...opts });
  h.engine.settings.setEnabled(S, 'casino', true);
  h.engine.settings.patchApp(S, 'casino', { cooldownSeconds: cooldown });
  const e = eco ? withEco(h, fakeEconomy(eco)) : null;
  return { h, eco: e };
}

function findBtn(h, msg, match) {
  const m = live(h, msg.id) || msg;
  return h.allButtons([m]).find((b) => (match instanceof RegExp ? match.test(b.custom_id) : b.label === match)) || null;
}

async function press(h, msg, match, user = A) {
  const b = findBtn(h, msg, match);
  assert.ok(b, `button ${match} exists; have ${h.allButtons([live(h, msg.id) || msg]).map((x) => x.label).join(', ')}`);
  return h.click(b.custom_id, { user, messageId: msg.id });
}

async function play(h, command, args, user = A) {
  const ans = await h.slash(command, args, { user });
  return { ans, msg: replyMsg(ans), text: lastText(h, ans) };
}

test('meta: seven commands, yap words, the cleanup job, off by default, icon and color', async () => {
  const h = await createHarness({ apps: ['casino'] });
  const want = {
    casino: 'Casino hub with server coins: /casino, /casino stats, /casino top, /casino rules',
    coinflip: 'Flip a coin for coins: /coinflip heads 100, /coinflip tails half',
    dice: 'Roll a die for coins: /dice 6 100, /dice over 3 100, /dice even 50',
    slots: 'Spin the slot machine: /slots 100',
    blackjack: 'Play blackjack against the dealer: /blackjack 100',
    roulette: 'Bet on the roulette wheel: /roulette red 100, /roulette 17 50, /roulette 2nd 100',
    crash: 'Ride the multiplier and cash out before it crashes: /crash 100, /crash 100 2x',
  };
  for (const [name, description] of Object.entries(want)) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.equal(c.description, description);
    assert.ok(c.description.length <= 100);
  }
  for (const w of ['casino', 'gamble', 'coinflip', 'flip', 'cf', 'dice', 'roll', 'slots', 'slot', 'spin', 'blackjack', 'bj', 'roulette', 'wheel', 'crash', 'rocket']) {
    assert.equal(h.engine.yap.find(w)?.app, 'casino', w);
  }
  assert.ok(h.engine.scheduler.has('casino.cleanup'));
  const a = h.engine.apps.get('casino');
  assert.equal(a.meta.category, 'Fun');
  assert.equal(a.meta.icon, '🎰');
  assert.equal(a.meta.defaultEnabled, false);
  assert.equal(a.def.panelPerm, 'member');
  assert.equal(a.def.help.length, 4);
  assert.equal(h.engine.settings.isEnabled(S, 'casino'), false);
  assert.equal(ICONS.casino, '🎰');
  assert.equal(COLORS.casino, 0xd4af37);
  const off = await h.slash('slots', '100', { user: A });
  assert.match(lastText(h, off), /Casino isn't installed here/);
  assert.deepEqual(a.def.dashboard.map((f) => f.key), ['coinflip', 'dice', 'slots', 'blackjack', 'roulette', 'crash', 'minBet', 'maxBet', 'cooldownSeconds', 'crashMax']);
  for (const f of a.def.dashboard) assert.ok(f.web === true && typeof f.validate === 'function', f.key);
});

test('math: slots, roulette, dice, coinflip and crash pay back what the rules say', () => {
  let sum = 0;
  let paid = 0;
  let hits = 0;
  const seen = { triple: {}, pair: 0, cherryPair: 0, none: 0 };
  for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b++) for (let c = 0; c < 32; c++) {
    const keys = [reelSymbol(a), reelSymbol(b), reelSymbol(c)];
    const sp = slotPayout(keys, 100);
    sum += sp.num / sp.den;
    paid += slotPayout(keys, 10).payout;
    if (sp.kind !== 'none') hits++;
    if (sp.kind === 'triple') seen.triple[sp.symbol] = (seen.triple[sp.symbol] || 0) + 1;
    else if (sp.kind === 'pair' && sp.symbol === 'cherry') seen.cherryPair++;
    else if (sp.kind === 'pair') seen.pair++;
    else seen.none++;
  }
  assert.equal(REEL.reduce((n, s) => n + s.weight, 0), 32);
  assert.equal(sum * 2, 63575);
  assert.ok(Math.abs(sum / 32768 - 317875 / 327680) < 1e-12);
  assert.ok(sum / 32768 > 0.97 && sum / 32768 < 0.971);
  assert.equal(paid, 317875, 'slotPayout pays 317,875 coins over every spin of 10');
  assert.equal(hits, 32768 - 19812);
  assert.deepEqual(seen.triple, { cherry: 343, lemon: 216, orange: 125, grape: 64, bell: 27, star: 27, diamond: 8, seven: 8 });
  assert.equal(seen.cherryPair, 3675);
  assert.equal(seen.pair, 8463);
  assert.equal(seen.none, 19812);

  const picks = [...Array.from({ length: 37 }, (_, i) => i), 'red', 'black', 'even', 'odd', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3'];
  for (const p of picks) {
    let total = 0;
    for (let pocket = 0; pocket <= 36; pocket++) if (rouletteWins(p, pocket)) total += rouletteReturn(p);
    assert.equal(total, 36, `roulette ${p}`);
  }
  assert.equal(rouletteWins('red', 0), false);
  assert.equal(rouletteWins('c1', 34), true);
  assert.equal(rouletteWins('c3', 36), true);

  const dicePicks = [1, 2, 3, 4, 5, 6].map((n) => ({ type: 'face', n }));
  for (let n = 1; n <= 5; n++) dicePicks.push({ type: 'over', n });
  for (let n = 2; n <= 6; n++) dicePicks.push({ type: 'under', n });
  for (const type of ['even', 'odd', 'high', 'low']) dicePicks.push({ type });
  for (const p of dicePicks) {
    let total = 0;
    for (let roll = 1; roll <= 6; roll++) total += dicePayout(p, roll, 6000);
    assert.equal(total, 34_920, JSON.stringify(p));
    assert.ok(Math.abs(total / 6 / 6000 - 0.97) < 1e-12, JSON.stringify(p));
  }
  assert.equal(dicePayout({ type: 'face', n: 6 }, 6, 100), 582);
  assert.equal(dicePayout({ type: 'over', n: 4 }, 5, 100), 291);
  assert.equal(dicePayout({ type: 'over', n: 1 }, 2, 100), 116);
  assert.equal(dicePayout({ type: 'under', n: 6 }, 1, 100), 116);
  assert.equal(dicePayout({ type: 'over', n: 2 }, 6, 100), 145);
  assert.equal(dicePayout({ type: 'under', n: 5 }, 4, 100), 145);
  assert.equal(dicePayout({ type: 'over', n: 1 }, 1, 100), 0);

  assert.equal(crashPointX100(1, 50), 5000);
  assert.ok(crashPointX100(970_001, 50) < 100);
  assert.equal(crashPointX100(970_000, 50), 100);
  let wins = 0;
  for (let r = 1; r <= 1_000_000; r++) if (crashPointX100(r, 100) >= 200) wins++;
  assert.equal(wins / 1e6, Math.floor(97_000_000 / 200) / 1e6);
  assert.ok(Math.abs((wins / 1e6) * 2 - 0.97) < 1e-9);
  for (let x = 101; x <= 10_000; x += 7) {
    const ms = msFor(x);
    assert.ok(multX100(ms) >= x, `reaches ${x}`);
    assert.ok(ms === 0 || multX100(ms - 1) < x, `not earlier for ${x}`);
  }
  assert.equal(multX100(8000), 200);
  assert.equal(msFor(200), 8000);

  assert.deepEqual(handTotal([CARD.A, CARD.A, CARD[9]]), { total: 21, soft: true });
  assert.equal(handTotal([CARD.A, CARD.K]).total, 21);
  assert.deepEqual(handTotal([CARD.A, CARD[6], CARD.K]), { total: 17, soft: false });
  assert.equal(cardText(0), 'A♠');
  assert.equal(cardText(13 + 12), 'K♥');
  const shoe = [CARD[5], CARD.K];
  assert.deepEqual(dealerPlays([CARD.A, CARD[6]], () => shoe.shift()), [CARD.A, CARD[6]], 'soft 17 stands');
  assert.equal(handTotal(dealerPlays([CARD[10], CARD[4]], () => shoe.shift())).total, 19);
  const soft = [CARD[6], CARD.K];
  const drawn = dealerPlays([CARD.A, CARD[5]], () => soft.shift());
  assert.deepEqual(drawn, [CARD.A, CARD[5], CARD[6], CARD.K], 'soft 16 draws, then a hard 12 draws again');
  assert.deepEqual(handTotal(drawn.slice(0, 3)), { total: 12, soft: false });
  assert.equal(handTotal(drawn).total, 22);
});

test('amounts: numbers, k, m, b and t, all, half and the bad ones', () => {
  assert.deepEqual(parseAmountToken('100'), { kind: 'number', n: 100 });
  assert.deepEqual(parseAmountToken('1,000'), { kind: 'number', n: 1000 });
  assert.deepEqual(parseAmountToken('2k'), { kind: 'number', n: 2000 });
  assert.deepEqual(parseAmountToken('1.5k'), { kind: 'number', n: 1500 });
  assert.deepEqual(parseAmountToken('1.1k'), { kind: 'number', n: 1100 });
  assert.deepEqual(parseAmountToken('1m'), { kind: 'number', n: 1_000_000 });
  assert.deepEqual(parseAmountToken('100coins'), { kind: 'number', n: 100 });
  assert.deepEqual(parseAmountToken('2b'), { kind: 'number', n: 2_000_000_000 });
  assert.deepEqual(parseAmountToken('1.5t'), { kind: 'number', n: 1_500_000_000_000 });
  assert.deepEqual(parseAmountToken('9,000,000,000'), { kind: 'number', n: 9_000_000_000 });
  assert.deepEqual(parseAmountToken('all'), { kind: 'all' });
  assert.deepEqual(parseAmountToken('max'), { kind: 'all' });
  assert.deepEqual(parseAmountToken('half'), { kind: 'half' });
  for (const bad of ['-5', '0', '1.5', 'abc', '1.2345k', '']) assert.equal(parseAmountToken(bad), null, bad);
  const lim = { minBet: 10, maxBet: 1000 };
  assert.deepEqual(resolveBet({ kind: 'all' }, 5000, lim), { bet: 1000 });
  assert.deepEqual(resolveBet({ kind: 'all' }, 300, lim), { bet: 300 });
  assert.deepEqual(resolveBet({ kind: 'half' }, 301, lim), { bet: 150 });
  assert.equal(resolveBet({ kind: 'half' }, 1, lim).error, 'low');
  assert.equal(resolveBet({ kind: 'number', n: 5 }, 100, lim).error, 'small');
  assert.equal(resolveBet({ kind: 'number', n: 5000 }, 9000, lim).error, 'big');
  assert.deepEqual(parseArgs('dice', ['6', '100']).pick, { type: 'face', n: 6 });
  assert.deepEqual(parseArgs('dice', ['bet', '100', 'over', '3']).pick, { type: 'over', n: 3 });
  assert.equal(parseArgs('roulette', ['17', '50']).pick, 17);
  assert.equal(parseArgs('roulette', ['50', 'zero']).pick, 0);
  assert.equal(parseArgs('coinflip', ['100', 't']).pick, 'tails');
  assert.equal(parseArgs('crash', ['100', '2.5x'], { crashMax: 50 }).target, 250);
  assert.equal(parseArgs('crash', ['auto', '3', '100'], { crashMax: 50 }).target, 300);
  assert.match(parseArgs('dice', ['100']).error.title, /Pick what to bet on/);
  assert.match(parseArgs('slots', []).error.title, /How much/);
});

test('coinflip: a win pays 1.95x, a loss takes the bet, and the bet goes first', async () => {
  const { h, eco } = await make();
  svc(h).useRandom((min, max) => {
    assert.deepEqual([min, max], [0, 2]);
    assert.equal(eco.bal[A], 900, 'the bet was taken before the coin was flipped');
    return 0;
  });
  const win = await play(h, 'coinflip', 'heads 100');
  assert.ok(win.msg, win.text);
  assert.match(h.textOf(win.msg), /landed on \*\*Heads\*\*/);
  assert.match(h.textOf(win.msg), /You won \*\*195\*\* 🪙 \(1\.95x\)/);
  assert.match(h.textOf(win.msg), /Balance: \*\*1,095\*\* 🪙/);
  assert.equal(eco.bal[A], 1095);
  assert.deepEqual(eco.log.slice(-2), [['take', A, 100, 'Coinflip bet'], ['add', A, 195, 'Coinflip win']]);
  assert.equal(h.engine.router.panelOwner(win.msg.id), null, 'game messages are public');
  rolls(h, 1);
  const loss = await play(h, 'coinflip', '100 heads');
  assert.match(h.textOf(loss.msg), /You lost \*\*100\*\* 🪙/);
  assert.equal(eco.bal[A], 995);
  rolls(h, 0);
  const small = await play(h, 'coinflip', 'heads 10');
  assert.match(h.textOf(small.msg), /You won \*\*19\*\* 🪙 \(1\.9x\)/);
  assert.equal(eco.bal[A], 1004);
  eco.bal[A] = 995;
  assert.match((await play(h, 'coinflip', '100')).text, /Pick a side/);
  assert.match((await play(h, 'coinflip', 'tails')).text, /How much do you want to bet/);
  assert.equal(eco.bal[A], 995);
});

test('dice: faces, over and under, even and bad ranges', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 10_000 } });
  rolls(h, 6);
  assert.match(h.textOf((await play(h, 'dice', '6 100')).msg), /You won \*\*582\*\* 🪙 \(5\.82x\)/);
  rolls(h, 5);
  assert.match(h.textOf((await play(h, 'dice', 'over 3 100')).msg), /You won \*\*194\*\* 🪙 \(1\.94x\)/);
  rolls(h, 1);
  assert.match(h.textOf((await play(h, 'dice', 'under 2 100')).msg), /You won \*\*582\*\*/);
  rolls(h, 3);
  assert.match(h.textOf((await play(h, 'dice', 'even 100')).msg), /You lost \*\*100\*\*/);
  assert.equal(eco.bal[A], 10_000 - 400 + 582 + 194 + 582);
  const before = eco.bal[A];
  rolls(h);
  assert.match((await play(h, 'dice', 'over 6 100')).text, /That roll can't happen/);
  assert.match((await play(h, 'dice', 'under 1 100')).text, /That roll can't happen/);
  assert.match((await play(h, 'dice', '7 100')).text, /That roll can't happen/);
  assert.match((await play(h, 'dice', '100')).text, /Pick what to bet on/);
  assert.equal(eco.bal[A], before);
});

test('slots: three sevens, a cherry pair, another pair and nothing', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, 30, 31, 30);
  const jackpot = await play(h, 'slots', '100');
  assert.match(h.textOf(jackpot.msg), /\[ 7️⃣ \| 7️⃣ \| 7️⃣ \]/);
  assert.match(h.textOf(jackpot.msg), /You won \*\*25,000\*\* 🪙 \(250x\)/);
  assert.equal(eco.bal[A], 25_900);
  rolls(h, 0, 6, 7);
  assert.match(h.textOf((await play(h, 'slots', '100')).msg), /You won \*\*250\*\* 🪙 \(2\.5x\)/);
  rolls(h, 7, 8, 13);
  const pair = await play(h, 'slots', '100');
  assert.match(h.textOf(pair.msg), /Pair: your bet back/);
  assert.equal(pair.msg.embeds[0].color, COLORS.casino);
  rolls(h, 0, 7, 13);
  assert.match(h.textOf((await play(h, 'slots', '100')).msg), /You lost \*\*100\*\*/);
  assert.equal(eco.bal[A], 25_900 + 150 + 0 - 100);
});

test('roulette: a number, red on zero, a dozen, a column, zero and a forged button', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, 17);
  const num = await play(h, 'roulette', '17 100');
  assert.match(h.textOf(num.msg), /landed on ⚫ \*\*17\*\*/);
  assert.match(h.textOf(num.msg), /You won \*\*3,600\*\* 🪙 \(36x\)/);
  rolls(h, 0);
  assert.match(h.textOf((await play(h, 'roulette', 'red 100')).msg), /🟢 \*\*0\*\*[\s\S]*You lost/);
  rolls(h, 14);
  assert.match(h.textOf((await play(h, 'roulette', '2nd 100')).msg), /You won \*\*300\*\* 🪙 \(3x\)/);
  rolls(h, 36);
  assert.match(h.textOf((await play(h, 'roulette', 'col3 100')).msg), /You won \*\*300\*\*/);
  rolls(h, 0);
  assert.match(h.textOf((await play(h, 'roulette', 'zero 100')).msg), /You won \*\*3,600\*\*/);
  const after = 1000 + 3500 - 100 + 200 + 200 + 3500;
  assert.equal(eco.bal[A], after);
  rolls(h);
  assert.match((await play(h, 'roulette', '40 100')).text, /isn't on the wheel/);
  assert.match((await play(h, 'roulette', 'redd 100')).text, /Did you mean \*\*red\*\*/);
  for (const bad of ['__proto__', 'constructor', 'toString']) {
    const forged = await h.click(`yo:casino:again:roulette:${A}:${bad}:100`, { user: A, messageId: num.msg.id });
    assert.match(lastText(h, forged), /out of date/, bad);
  }
  assert.match(lastText(h, await h.click(`yo:casino:again:__proto__:${A}:100`, { user: A })), /out of date/);
  assert.equal(eco.bal[A], after);
});

test('Again replays the same bet in the same message, respects the cooldown and only the player can press it', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make({}, { cooldown: 3 });
  rolls(h, 0);
  const first = await play(h, 'coinflip', 'heads 100');
  const again = findBtn(h, first.msg, 'Again');
  assert.match(again.custom_id, new RegExp(`^yo:casino:again:coinflip:${A}:heads:100$`));
  const early = await press(h, first.msg, 'Again');
  assert.match(lastText(h, early), /Take a breather/);
  assert.match(lastText(h, early), /3 seconds/);
  const other = await press(h, first.msg, 'Again', B);
  assert.match(lastText(h, other), /Not your panel/);
  assert.equal(eco.bal[B], 1000);
  tick(3000);
  rolls(h, 1);
  const res = await press(h, first.msg, 'Again');
  assert.equal(res[0].type, 'update');
  assert.match(h.textOf(live(h, first.msg.id)), /You lost \*\*100\*\*/);
  assert.equal(h.sent(G).length, 1, 'Again reuses the message');
  assert.equal(eco.bal[A], 995);
});

test('blackjack naturals: blackjack pays 3:2, the dealer can have one, both is a push', async () => {
  const { h, eco } = await make();
  rolls(h, CARD.A, CARD[9], CARD.K, CARD[7]);
  const bj = await play(h, 'blackjack', '100');
  assert.match(h.textOf(bj.msg), /Blackjack! You won \*\*250\*\* 🪙/);
  assert.equal(eco.bal[A], 1150);
  assert.equal(h.allButtons([bj.msg]).filter((b) => /:bj:/.test(b.custom_id)).length, 0, 'no Hit or Stand');
  assert.ok(findBtn(h, bj.msg, 'New hand'));
  rolls(h, CARD[9], CARD.A, CARD[7], CARD.Q);
  assert.match(h.textOf((await play(h, 'blackjack', '100')).msg), /dealer has blackjack. You lost \*\*100\*\*/);
  rolls(h, CARD.A, CARD.A, CARD.J, CARD.K);
  assert.match(h.textOf((await play(h, 'blackjack', '100')).msg), /Push. Your \*\*100\*\* 🪙 came back/);
  assert.equal(eco.bal[A], 1050);
  assert.equal(svc(h).isPlaying(S, A), false);
  assert.deepEqual(doc(h).open, {});
  assert.equal(jobs(h).length, 0);
});

test('blackjack: hit, bust, stand, dealer soft 17, push and dealer draws', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, CARD[2], CARD[10], CARD[3], CARD[6]);
  const hand = await play(h, 'blackjack', '100');
  assert.match(h.textOf(hand.msg), /\*\*Dealer\*\* 🂠 10♠ \(shows 10\)/);
  assert.match(h.textOf(hand.msg), /\*\*You\*\* 2♠ 3♠ · 5/);
  assert.ok(findBtn(h, hand.msg, 'Double'));
  assert.equal(svc(h).isPlaying(S, A), true);
  assert.equal(doc(h).open[svc(h).game(S, A).id].held, 100);
  rolls(h, CARD[10]);
  await press(h, hand.msg, 'Hit');
  assert.match(h.textOf(live(h, hand.msg.id)), /2♠ 3♠ 10♠ · 15/);
  assert.equal(findBtn(h, hand.msg, 'Double'), null, 'no double after a hit');
  rolls(h, CARD.K);
  await press(h, hand.msg, 'Hit');
  assert.match(h.textOf(live(h, hand.msg.id)), /Bust! You lost \*\*100\*\*/);
  assert.equal(eco.bal[A], 900);

  rolls(h, CARD[10], CARD.A, CARD[9], CARD[6]);
  const soft = await play(h, 'blackjack', '100');
  await press(h, soft.msg, 'Stand');
  assert.match(h.textOf(live(h, soft.msg.id)), /\*\*Dealer\*\* A♠ 6♠ · soft 17/);
  assert.match(h.textOf(live(h, soft.msg.id)), /You win! You got \*\*200\*\*/);
  assert.equal(eco.bal[A], 1000);

  rolls(h, CARD[10], CARD[10], CARD[8], CARD[8]);
  const push = await play(h, 'blackjack', '100');
  await press(h, push.msg, 'Stand');
  assert.match(h.textOf(live(h, push.msg.id)), /Push/);
  assert.equal(eco.bal[A], 1000);

  rolls(h, CARD[10], CARD[10], CARD[8], CARD[4], CARD[5]);
  const lose = await play(h, 'blackjack', '100');
  await press(h, lose.msg, 'Stand');
  assert.match(h.textOf(live(h, lose.msg.id)), /10♠ 4♠ 5♠ · 19/);
  assert.match(h.textOf(live(h, lose.msg.id)), /The dealer wins. You lost/);
  assert.equal(eco.bal[A], 900);
  const st = svc(h).stats(S, A);
  assert.equal(st.n, 4);
  assert.equal(st.wagered, 400);
  assert.equal(st.returned, 300);
  assert.equal(st.games.blackjack.n, 4);
});

test('blackjack double: takes a second bet, one card, then stands; refused after a hit or when short', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, CARD[5], CARD[10], CARD[6], CARD[6], CARD[10], CARD.K);
  const hand = await play(h, 'blackjack', '100');
  await press(h, hand.msg, 'Double');
  const text = h.textOf(live(h, hand.msg.id));
  assert.match(text, /bet \*\*200\*\* 🪙 \(doubled\)/);
  assert.match(text, /5♠ 6♠ 10♠ · 21/);
  assert.match(text, /dealer went bust. You got \*\*400\*\*/);
  assert.equal(eco.bal[A], 1200);
  assert.deepEqual(eco.log.filter((l) => l[0] === 'take').map((l) => l[3]), ['Blackjack bet', 'Blackjack double']);
  assert.equal(svc(h).stats(S, A).wagered, 200);

  rolls(h, CARD[2], CARD[10], CARD[3], CARD[7], CARD[4]);
  const hit = await play(h, 'blackjack', '100');
  await press(h, hit.msg, 'Hit');
  const late = await h.click(`yo:casino:bj:${svc(h).game(S, A).id}:${A}:double`, { user: A, messageId: hit.msg.id });
  assert.match(lastText(h, late), /only double on your first two cards/);
  await h.slash('casino', 'end', { user: A });

  eco.bal[A] = 150;
  rolls(h, CARD[5], CARD[10], CARD[6], CARD[7]);
  const poor = await play(h, 'blackjack', '100');
  const no = await press(h, poor.msg, 'Double');
  assert.match(lastText(h, no), /Not enough coins to double/);
  assert.match(lastText(h, no), /needs another \*\*100\*\* 🪙. You have \*\*50\*\* 🪙/);
  assert.match(h.textOf(live(h, poor.msg.id)), /5♠ 6♠ · 11/);
  assert.ok(findBtn(h, poor.msg, 'Double'));
  assert.equal(eco.bal[A], 50);
});

test('blackjack idle: the hand stands by itself after 2 minutes and the message is edited', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  rolls(h, CARD[10], CARD[10], CARD[8], CARD[7]);
  const hand = await play(h, 'blackjack', '100');
  assert.match(h.textOf(hand.msg), /auto-stands after 2 minutes/);
  tick(60_000);
  await sweep(h);
  assert.equal(svc(h).isPlaying(S, A), true);
  tick(61_000);
  await sweep(h);
  assert.match(h.textOf(live(h, hand.msg.id)), /You win! You got \*\*200\*\*/);
  assert.equal(eco.bal[A], 1100);
  assert.equal(svc(h).isPlaying(S, A), false);
});

test('crash: cash out at 2x, the message updates and the ticker stops', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  rolls(h, 194_000);
  const round = await play(h, 'crash', '100');
  assert.match(h.textOf(round.msg), /Multiplier \*\*1\.00x\*\*/);
  assert.ok(findBtn(h, round.msg, 'Cash out'));
  assert.equal(eco.bal[A], 900);
  tick(2000);
  await sweep(h);
  assert.match(h.textOf(live(h, round.msg.id)), /Multiplier \*\*1\.18x\*\*/);
  tick(6000);
  const cashId = findBtn(h, round.msg, 'Cash out').custom_id;
  const res = await press(h, round.msg, 'Cash out');
  assert.equal(res[0].type, 'update');
  const done = h.textOf(live(h, round.msg.id));
  assert.match(done, /Cashed out at \*\*2\.00x\*\* · you won \*\*200\*\*/);
  assert.match(done, /It crashed at 5\.00x/);
  assert.equal(eco.bal[A], 1100);
  const edits = h.fake.callsTo('PATCH', new RegExp(round.msg.id)).length;
  tick(10_000);
  await sweep(h);
  assert.equal(h.fake.callsTo('PATCH', new RegExp(round.msg.id)).length, edits, 'no edits after the round ended');
  const twice = await h.click(cashId, { user: A, messageId: round.msg.id });
  assert.match(lastText(h, twice), /Too late/);
  assert.equal(eco.bal[A], 1100);
  assert.ok(findBtn(h, round.msg, 'Play again'));
});

test('crash: a bust at 1.50x, a late click and an instant 1.00x bust', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  rolls(h, Math.floor(97_000_000 / 150));
  const round = await play(h, 'crash', '100');
  const cash = findBtn(h, round.msg, 'Cash out').custom_id;
  tick(msFor(150) + 20);
  await sweep(h);
  assert.match(h.textOf(live(h, round.msg.id)), /Crashed at \*\*1\.50x\*\*. You lost \*\*100\*\*/);
  assert.equal(eco.bal[A], 900);
  const late = await h.click(cash, { user: A, messageId: round.msg.id });
  assert.match(lastText(h, late), /Too late/);
  assert.equal(eco.bal[A], 900);
  rolls(h, 999_999);
  const instant = await play(h, 'crash', '100');
  assert.match(h.textOf(instant.msg), /Crashed at \*\*1\.00x\*\* right away/);
  assert.equal(h.allButtons([instant.msg]).length, 0);
  assert.equal(svc(h).isPlaying(S, A), false);
  assert.equal(eco.bal[A], 800);
});

test('crash: auto cash-out, a target over the top refused, and the top cashes out by itself', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, 194_000);
  const auto = await play(h, 'crash', '100 2x');
  assert.match(h.textOf(auto.msg), /Auto cash-out at \*\*2\.00x\*\*/);
  tick(8000);
  await sweep(h);
  assert.match(h.textOf(live(h, auto.msg.id)), /Cashed out at \*\*2\.00x\*\*/);
  assert.equal(eco.bal[A], 1100);
  rolls(h);
  assert.match((await play(h, 'crash', '100 60x')).text, /That target didn't work/);
  assert.match((await play(h, 'crash', '100 1x')).text, /1\.01x to 50x/);
  assert.equal(eco.bal[A], 1100);
  rolls(h, 1);
  const top = await play(h, 'crash', '100');
  tick(msFor(5000) + 10);
  await sweep(h);
  assert.match(h.textOf(live(h, top.msg.id)), /Reached the top of \*\*50\.00x\*\*/);
  assert.equal(eco.bal[A], 1000 + 100 + 4900);
  rolls(h, 1);
  const again = await press(h, top.msg, 'Play again');
  assert.equal(again[0].type, 'update');
  assert.equal(svc(h).game(S, A).kind, 'crash');
  await h.slash('casino', 'end', { user: A });
});

test('crash edits are bounded and spaced', async (t) => {
  const tick = clockAt(t);
  const { h } = await make({}, { eco: { [A]: 1000 } });
  h.engine.settings.patchApp(S, 'casino', { crashMax: 100 });
  const stamps = [];
  const edit = h.engine.budget.edit;
  h.engine.budget.edit = (job) => { stamps.push(Date.now()); return edit(job); };
  rolls(h, 1);
  await play(h, 'crash', '100');
  for (let i = 0; i < 40 && svc(h).isPlaying(S, A); i++) {
    tick(2000);
    await sweep(h);
  }
  assert.equal(svc(h).isPlaying(S, A), false);
  assert.ok(stamps.length <= LIMITS.CRASH_MAX_EDITS + 1, `${stamps.length} edits`);
  assert.ok(stamps.length >= 20, `${stamps.length} edits`);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 2000, `gap ${stamps[i] - stamps[i - 1]}`);
});

test('locks: one live game per player, starts in flight and the server caps', async () => {
  const { h, eco } = await make({}, { eco: {} });
  eco.bal[A] = 1000;
  svc(h).useRandom((min) => (min === 1 ? 1 : CARD[6]));
  const first = await play(h, 'blackjack', '100');
  assert.ok(first.msg);
  assert.match((await play(h, 'crash', '100')).text, /already playing[\s\S]*blackjack hand/);
  assert.match((await play(h, 'slots', '100')).text, /already playing/);
  await h.slash('casino', 'end', { user: A });
  assert.equal(eco.bal[A], 900, 'ending your own hand stands it, and 12 loses to 18');
  const [x, y] = await Promise.all([h.slash('blackjack', '100', { user: A }), h.slash('blackjack', '100', { user: A })]);
  assert.equal([x, y].filter((r) => replyMsg(r)).length, 1);
  assert.match(lastText(h, [x, y].find((r) => !replyMsg(r))), /One moment|already playing/);
  assert.equal(eco.bal[A], 800);
  await h.slash('casino', 'end', { user: A });
  const users = [];
  for (let i = 0; i < 11; i++) {
    const id = `a0000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
    h.fake.state.members[S].push({ id, username: `p${i}`, display_name: `P${i}`, nickname: null, roles: [IDS.roles.member], joined_at: '2026-02-01T00:00:00Z' });
    eco.bal[id] = 1000;
    users.push(id);
  }
  h.engine.cache.invalidate(S);
  for (let i = 0; i < 3; i++) assert.ok((await play(h, 'crash', '100', users[i])).msg, `crash ${i}`);
  assert.match((await play(h, 'crash', '100', users[3])).text, /already 3 crash rounds/);
  for (let i = 3; i < 10; i++) assert.ok((await play(h, 'blackjack', '100', users[i])).msg, `blackjack ${i}`);
  assert.match((await play(h, 'blackjack', '100', users[10])).text, /already 10 live games/);
  assert.equal(eco.bal[users[10]], 1000);
  assert.equal(svc(h).active(S).live, 10);
  rolls(h, 0);
  assert.ok((await play(h, 'coinflip', 'heads 100', users[10])).msg, 'instant games still work');
  for (const u of users) await h.slash('casino', `end <@${u}>`, { user: IDS.mod });
});

test('refusals take nothing: no Economy, game off, limits, funds, cooldown and unknown words', async () => {
  const bare = await createHarness({ apps: ['casino'] });
  bare.engine.settings.setEnabled(S, 'casino', true);
  assert.match(lastText(bare, await bare.slash('slots', '100', { user: A })), /The casino needs Economy/);
  const { h, eco } = await make({}, { cooldown: 3, eco: { [A]: 50 } });
  rolls(h);
  h.engine.settings.patchApp(S, 'casino', { slots: false });
  assert.match((await play(h, 'slots', '10')).text, /Slots is off here/);
  h.engine.settings.patchApp(S, 'casino', { coinflip: false, dice: false, blackjack: false, roulette: false, crash: false });
  assert.match((await play(h, 'dice', '6 10')).text, /The casino is closed/);
  h.engine.settings.patchApp(S, 'casino', { coinflip: true, dice: true, slots: true, blackjack: true, roulette: true, crash: true });
  assert.match((await play(h, 'slots', '5')).text, /too small[\s\S]*\*\*10\*\* 🪙/);
  assert.match((await play(h, 'slots', '5000')).text, /too big[\s\S]*\*\*1,000\*\* 🪙/);
  assert.match((await play(h, 'slots', '100')).text, /You have \*\*50\*\* 🪙, so you can't bet \*\*100\*\* 🪙/);
  assert.match((await play(h, 'slots', '-5')).text, /That bet didn't work/);
  assert.match((await play(h, 'slots', 'lots')).text, /I didn't get that/);
  assert.match((await play(h, 'coinflip', 'haeds 10')).text, /Did you mean \*\*heads\*\*/);
  eco.bal[A] = 15;
  assert.match((await play(h, 'slots', 'half')).text, /You have \*\*15\*\* 🪙 and the smallest bet is \*\*10\*\* 🪙/);
  assert.equal(eco.bal[A], 15);
  assert.equal(eco.log.length, 0);
  rolls(h, 0, 7, 13);
  assert.ok((await play(h, 'slots', 'all')).msg);
  assert.equal(eco.bal[A], 0);
  eco.bal[A] = 100;
  assert.match((await play(h, 'slots', '10')).text, /Take a breather/);
  assert.equal(eco.bal[A], 100);
  const throwing = withEco(h, { ...fakeEconomy({ [B]: 100 }), take: () => { throw new Error('store is down'); } });
  assert.match((await play(h, 'slots', '10', B)).text, /couldn't take the bet[\s\S]*Nothing was taken/);
  assert.equal(throwing.bal[B], 100);
});

test('never pays twice: double Stand, double Cash out and a late click', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  rolls(h, CARD[10], CARD[10], CARD[8], CARD[7]);
  const hand = await play(h, 'blackjack', '100');
  const stand = findBtn(h, hand.msg, 'Stand').custom_id;
  const [one, two] = await Promise.all([h.click(stand, { user: A, messageId: hand.msg.id }), h.click(stand, { user: A, messageId: hand.msg.id })]);
  assert.equal([one, two].filter((r) => r[0]?.type === 'update').length, 1);
  assert.equal(eco.bal[A], 1100);
  const after = await h.click(stand, { user: A, messageId: hand.msg.id });
  assert.match(lastText(h, after), /That game is over/);
  assert.equal(eco.bal[A], 1100);
  rolls(h, 194_000);
  const round = await play(h, 'crash', '100');
  tick(8000);
  const cash = findBtn(h, round.msg, 'Cash out').custom_id;
  await Promise.all([h.click(cash, { user: A, messageId: round.msg.id }), h.click(cash, { user: A, messageId: round.msg.id })]);
  assert.equal(eco.bal[A], 1200);
  assert.equal(eco.log.filter((l) => l[0] === 'add').length, 2);
});

test('restart: clicking an old hand cancels it and gives the bet back once', async () => {
  const store = createMemoryStore();
  const eco = fakeEconomy({ [A]: 1000 });
  const { h: a } = await make({ fakeClock: true, store }, { eco: null });
  withEco(a, eco);
  rolls(a, CARD[2], CARD[10], CARD[3], CARD[6]);
  const hand = await play(a, 'blackjack', '100');
  assert.equal(eco.bal[A], 900);
  const hit = findBtn(a, hand.msg, 'Hit').custom_id;
  a.engine.scheduler.stop();
  const { h: b } = await make({ fakeClock: true, store }, { eco: null });
  withEco(b, eco);
  const res = await b.click(hit, { user: A, messageId: hand.msg.id });
  assert.equal(res[0].type, 'update');
  assert.match(b.textOf(res[0]), /I restarted, so this game was cancelled. Your bet went back to you/);
  assert.equal(res[0].components.length, 0);
  assert.equal(eco.bal[A], 1000);
  assert.deepEqual(b.engine.store.get('casino', S).open, {});
  assert.equal(jobs(b).length, 0);
  await b.click(hit, { user: A, messageId: hand.msg.id });
  assert.equal(eco.bal[A], 1000);
  assert.equal(b.engine.store.get('casino', S).stats[A], undefined, 'a cancelled game is not counted');
});

test('restart: the safety check refunds crash rounds and hands nobody clicks', async () => {
  const store = createMemoryStore();
  const eco = fakeEconomy({ [A]: 1000, [B]: 1000 });
  const { h: a } = await make({ fakeClock: true, store }, { eco: null });
  withEco(a, eco);
  rolls(a, 1);
  const round = await play(a, 'crash', '100', A);
  rolls(a, CARD[2], CARD[10], CARD[3], CARD[6]);
  const hand = await play(a, 'blackjack', '50', B);
  assert.equal(jobs(a).length, 2);
  a.engine.scheduler.stop();
  a.engine.apps.get('casino').def.dispose(a.engine);
  const { h: b } = await make({ fakeClock: true, store }, { eco: null });
  withEco(b, eco);
  b.fake.state.messages[G] = structuredClone(a.fake.state.messages[G]);
  b.clock.t = a.clock.t;
  await b.advance(3 * 60_000 + 1000);
  assert.equal(eco.bal[A], 1000);
  assert.equal(eco.bal[B], 1000);
  for (const m of [round.msg, hand.msg]) {
    assert.match(b.textOf(live(b, m.id)), /Game cancelled/);
    assert.equal(live(b, m.id).components.length, 0);
  }
  assert.deepEqual(b.engine.store.get('casino', S).open, {});
  assert.equal(jobs(b).length, 0);
});

test('uninstalling Casino mid-game ends it and refunds the bet', async () => {
  const { h, eco } = await make({ fakeClock: true });
  rolls(h, CARD[2], CARD[10], CARD[3], CARD[6]);
  const hand = await play(h, 'blackjack', '100');
  assert.equal(eco.bal[A], 900);
  h.engine.settings.setEnabled(S, 'casino', false);
  const blocked = await press(h, hand.msg, 'Hit');
  assert.match(lastText(h, blocked), /Casino isn't installed here/);
  await settle();
  await h.advance(1000);
  assert.match(h.textOf(live(h, hand.msg.id)), /Cancelled: Casino was uninstalled here/);
  assert.equal(live(h, hand.msg.id).components.length, 0);
  assert.equal(eco.bal[A], 1000);
  assert.equal(svc(h).isPlaying(S, A), false);
  assert.equal(jobs(h).length, 0);
});

test('Economy turned off mid-hand: the hand still pays, Double and new games are refused', async () => {
  const { h, eco } = await make();
  rolls(h, CARD[5], CARD[10], CARD[6], CARD[7]);
  const hand = await play(h, 'blackjack', '100');
  h.engine.settings.setEnabled(S, 'economy', false);
  const dbl = await press(h, hand.msg, 'Double');
  assert.match(lastText(h, dbl), /Economy is off now, so you can't double/);
  rolls(h, CARD[10]);
  await press(h, hand.msg, 'Hit');
  assert.match(h.textOf(live(h, hand.msg.id)), /You win! You got \*\*200\*\*/);
  assert.equal(eco.bal[A], 1100);
  assert.match((await play(h, 'slots', '100')).text, /The casino needs Economy/);
});

test('/casino end stands your own hand or cashes out your round; only a mod ending someone else\'s game refunds it', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  rolls(h, CARD[10], CARD[10], CARD[6], CARD[7]);
  const hand = await play(h, 'blackjack', '100');
  assert.equal(eco.bal[A], 900);
  assert.match((await play(h, 'casino', `end <@${A}>`, B)).text, /Needs Mod|Only moderators/);
  const ended = (await play(h, 'casino', 'end')).text;
  assert.match(ended, /I stood your blackjack hand/);
  assert.match(ended, /The dealer wins. You lost \*\*100\*\*/);
  await settle();
  assert.match(h.textOf(live(h, hand.msg.id)), /The dealer wins/);
  assert.equal(eco.bal[A], 900, 'a 16 against a 10 cannot be cancelled for a refund');
  assert.match((await play(h, 'casino', 'end')).text, /not in a live game/);
  rolls(h, CARD[10], CARD[10], CARD[6], CARD[7]);
  await play(h, 'blackjack', '100');
  assert.match((await play(h, 'casino', `end <@${A}>`)).text, /I stood your blackjack hand/);
  assert.equal(eco.bal[A], 800, 'naming yourself is not a mod end');

  rolls(h, 194_000);
  const round = await play(h, 'crash', '100', B);
  tick(8000);
  assert.match((await play(h, 'casino', 'end', B)).text, /I cashed out your crash round. 💰 Cashed out at \*\*2\.00x\*\* · you won \*\*200\*\*/);
  await settle();
  assert.match(h.textOf(live(h, round.msg.id)), /Cashed out at \*\*2\.00x\*\*/);
  assert.equal(eco.bal[B], 1100);
  rolls(h, 194_000);
  const flat = await play(h, 'crash', '100', B);
  const flatText = (await play(h, 'casino', 'end', B)).text;
  assert.match(flatText, /your bet of \*\*100\*\* 🪙 came back/);
  await settle();
  assert.equal(live(h, flat.msg.id).embeds[0].color, COLORS.casino, 'a cash-out that only gives the bet back is not shown as a win');
  assert.equal(eco.bal[B], 1100);

  rolls(h, 1);
  const stuck = await play(h, 'crash', '100', B);
  assert.match((await play(h, 'casino', `end <@${B}>`, IDS.mod)).text, /game was cancelled and their bet went back/);
  await settle();
  assert.match(h.textOf(live(h, stuck.msg.id)), /a moderator ended it/);
  assert.equal(eco.bal[B], 1100);
  assert.equal(svc(h).stats(S, A).n, 2);
  assert.equal(svc(h).stats(S, B).n, 2, 'the mod-cancelled round is not counted');
});

test('a button with a live game id of the wrong kind never refunds that game', async () => {
  const { h, eco } = await make();
  rolls(h, CARD[10], CARD[10], CARD[10], CARD[6], CARD.K);
  const hand = await play(h, 'blackjack', '100');
  const gid = svc(h).game(S, A).id;
  assert.equal(eco.bal[A], 900);
  const forged = await h.click(`yo:casino:cash:${gid}:${A}`, { user: A });
  assert.match(lastText(h, forged), /out of date/);
  const other = await h.click(`yo:casino:cash:${gid}:${A}`, { user: A, messageId: 'not-a-game' });
  assert.match(lastText(h, other), /out of date/);
  assert.equal(eco.bal[A], 900);
  assert.equal(doc(h).open[gid].held, 100);
  await press(h, hand.msg, 'Stand');
  assert.match(h.textOf(live(h, hand.msg.id)), /dealer went bust. You got \*\*200\*\*/);
  assert.equal(eco.bal[A], 1100);

  rolls(h, 194_000);
  await play(h, 'crash', '100');
  const cid = svc(h).game(S, A).id;
  const wrong = await h.click(`yo:casino:bj:${cid}:${A}:stand`, { user: A });
  assert.match(lastText(h, wrong), /out of date/);
  assert.equal(eco.bal[A], 1000);
  assert.equal(doc(h).open[cid].held, 100);
  await h.slash('casino', 'end', { user: A });
});

test('blackjack: hitting to 21 stands by itself, a 3-card 21 against a dealer 21 pushes, and a double can bust', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  rolls(h, CARD[2], CARD[10], CARD[3], CARD[7], CARD[10], CARD[6]);
  const hand = await play(h, 'blackjack', '100');
  await press(h, hand.msg, 'Hit');
  await press(h, hand.msg, 'Hit');
  const won = h.textOf(live(h, hand.msg.id));
  assert.match(won, /2♠ 3♠ 10♠ 6♠ · 21/);
  assert.match(won, /You win! You got \*\*200\*\*/);
  assert.equal(svc(h).isPlaying(S, A), false);
  assert.equal(eco.bal[A], 1100);

  rolls(h, CARD[2], CARD[10], CARD[3], CARD[6], CARD[10], CARD[6], CARD[5]);
  const tie = await play(h, 'blackjack', '100');
  await press(h, tie.msg, 'Hit');
  await press(h, tie.msg, 'Hit');
  const pushed = h.textOf(live(h, tie.msg.id));
  assert.match(pushed, /\*\*Dealer\*\* 10♠ 6♠ 5♠ · 21/);
  assert.match(pushed, /Push. Your \*\*100\*\* 🪙 came back/);
  assert.equal(eco.bal[A], 1100);

  rolls(h, CARD[10], CARD[10], CARD[5], CARD[7], CARD.K);
  const dbl = await play(h, 'blackjack', '100');
  await press(h, dbl.msg, 'Double');
  const bust = h.textOf(live(h, dbl.msg.id));
  assert.match(bust, /bet \*\*200\*\* 🪙 \(doubled\)/);
  assert.match(bust, /Bust! You lost \*\*200\*\*/);
  assert.equal(eco.bal[A], 900);
  assert.deepEqual(doc(h).open, {});
  assert.equal(svc(h).stats(S, A).games.blackjack.wagered, 400);
});

test('crash: a click after the top pays the top, a click before the target pays the click', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make({}, { eco: { [A]: 1000 } });
  h.engine.settings.patchApp(S, 'casino', { crashMax: 2 });
  rolls(h, 1);
  const late = await play(h, 'crash', '100');
  tick(9000);
  await press(h, late.msg, 'Cash out');
  assert.match(h.textOf(live(h, late.msg.id)), /Reached the top of \*\*2\.00x\*\* and cashed out · you won \*\*200\*\*/);
  assert.equal(eco.bal[A], 1100);
  rolls(h, 1);
  const exact = await play(h, 'crash', '100');
  tick(8000);
  await press(h, exact.msg, 'Cash out');
  assert.match(h.textOf(live(h, exact.msg.id)), /Reached the top of \*\*2\.00x\*\*/);
  assert.equal(eco.bal[A], 1200);

  h.engine.settings.patchApp(S, 'casino', { crashMax: 50 });
  rolls(h, 194_000);
  const early = await play(h, 'crash', '100 3x');
  tick(8000);
  await press(h, early.msg, 'Cash out');
  assert.match(h.textOf(live(h, early.msg.id)), /Cashed out at \*\*2\.00x\*\* · you won \*\*200\*\*/);
  assert.equal(eco.bal[A], 1300);
});

test('small bets: the smallest allowed bet is 10, and a crash target that cannot win is refused', async () => {
  const { h, eco } = await make();
  assert.match((await play(h, 'casino', 'minbet 1', IDS.admin)).text, /whole number from 10 up/);
  assert.match((await play(h, 'casino', 'maxbet 5', IDS.admin)).text, /whole number from 10 up/);
  const field = h.engine.apps.get('casino').def.dashboard.find((f) => f.key === 'minBet');
  assert.equal(field.min, 10);
  assert.match(field.validate({ engine: h.engine, serverId: S }, 1).error, /from 10 up/);
  rolls(h);
  const refused = await play(h, 'crash', '10 1.05x');
  assert.match(refused.text, /That target can't win/);
  assert.match(refused.text, /a 1\.05x cash-out only gives your bet back/);
  assert.equal(eco.bal[A], 1000);
  assert.equal(svc(h).isPlaying(S, A), false);
  rolls(h, 6);
  assert.match(h.textOf((await play(h, 'dice', 'over 1 10')).msg), /You won \*\*11\*\* 🪙 \(1\.1x\)/);
});

test('a full scheduler never strands money: a failed payout is retried without a job, and a game left on disk is settled on start', async (t) => {
  const tick = clockAt(t);
  const { h, eco } = await make();
  const add = eco.add;
  let broken = true;
  eco.add = (...args) => { if (broken) throw new Error('store is down'); return add(...args); };
  h.engine.scheduler.schedule = () => { throw new Error('This server already has 1000 things scheduled'); };
  rolls(h, 0);
  const res = await play(h, 'coinflip', 'heads 100');
  assert.match(res.text, /couldn't pay you yet/);
  assert.equal(jobs(h).length, 0);
  assert.equal(Object.values(doc(h).open)[0].held, 195);
  broken = false;
  tick(LIMITS.CHECK_MS + 1000);
  await sweep(h);
  assert.equal(eco.bal[A], 1095);
  assert.deepEqual(doc(h).open, {});

  const store = createMemoryStore();
  store.set('casino', S, { open: { abcd1234: { kind: 'crash', uid: A, channelId: G, messageId: null, at: 1, held: 100 } }, stats: {}, totals: { n: 0, wagered: 0, returned: 0, best: 0, bestBy: null } });
  const shared = fakeEconomy({ [A]: 900 });
  const { h: boot } = await make({ fakeClock: true, store }, { eco: null });
  withEco(boot, shared);
  await settle();
  assert.equal(jobs(boot).length, 1, 'the orphaned bet got a safety check on start');
  await boot.advance(3 * 60_000 + 1000);
  assert.equal(shared.bal[A], 1000);
  assert.deepEqual(boot.engine.store.get('casino', S).open, {});
  assert.equal(jobs(boot).length, 0);
});

test('stats and top: wagered, won back, biggest win, server totals and the user cap', async () => {
  const { h } = await make();
  rolls(h, 0);
  await play(h, 'coinflip', 'heads 100', A);
  rolls(h, 1);
  await play(h, 'coinflip', 'heads 200', A);
  rolls(h, 6);
  await play(h, 'dice', '6 100', B);
  const a = svc(h).stats(S, A);
  assert.equal(a.n, 2);
  assert.equal(a.wagered, 300);
  assert.equal(a.returned, 195);
  assert.equal(a.best, 95);
  assert.deepEqual(svc(h).totals(S), { n: 3, wagered: 400, returned: 777, best: 482, bestBy: B });
  const mine = await play(h, 'casino', 'stats', A);
  assert.match(mine.text, /Games played: \*\*2\*\*/);
  assert.match(mine.text, /Net: \*\*-105\*\* 🪙/);
  assert.match(mine.text, /Biggest win: \*\*95\*\* 🪙/);
  assert.match((await play(h, 'casino', 'stats', IDS.mod)).text, /You haven't played yet. Try \*\*\/slots 50\*\*/);
  assert.match((await play(h, 'casino', `stats <@${B}>`, A)).text, /Riley's casino stats[\s\S]*Net: \*\*\+482\*\*/);
  const top = await play(h, 'casino', 'top', A);
  assert.ok(top.msg, 'top is a public reply');
  assert.equal(h.allButtons([top.msg]).length, 0);
  const text = h.textOf(top.msg);
  assert.ok(text.indexOf(B) < text.indexOf(A), 'sorted by net');
  assert.match(text, /🥇/);
  assert.match(text, /3 games · 400 coins bet · 777 coins paid out/);
  const big = h.textOf((await play(h, 'casino', 'top biggest', A)).msg);
  assert.match(big, /biggest win \*\*482\*\*/);
  assert.match(big, /biggest win \*\*95\*\*/);

  const store = createMemoryStore();
  const stats = {};
  for (let i = 0; i < LIMITS.MAX_STAT_USERS; i++) stats[`u${i}`] = { n: 1, wagered: 10, returned: 0, best: 0, games: {}, seen: 1000 + i };
  store.set('casino', S, { open: {}, stats, totals: { n: 0, wagered: 0, returned: 0, best: 0, bestBy: null } });
  const { h: full } = await make({ store });
  rolls(full, 0);
  await play(full, 'coinflip', 'heads 100', A);
  const kept = full.engine.store.get('casino', S).stats;
  assert.equal(Object.keys(kept).length, LIMITS.MAX_STAT_USERS);
  assert.equal(kept.u0, undefined, 'the oldest player was dropped');
  assert.ok(kept[A]);
  const empty = await make();
  assert.match((await play(empty.h, 'casino', 'top', A)).text, /Nobody has played here yet/);
});

test('admin: typed settings, the settings panel, the Bet limits form and validators', async () => {
  const { h } = await make();
  const cfg = () => h.engine.settings.appConfig(S, 'casino');
  assert.match((await play(h, 'casino', 'maxbet 500', A)).text, /Needs Admin|Only admins/);
  assert.match((await play(h, 'casino', 'maxbet 500', IDS.admin)).text, /biggest bet is now \*\*500\*\*/);
  assert.equal(cfg().maxBet, 500);
  assert.match((await play(h, 'casino', 'minbet 600', IDS.admin)).text, /smallest bet can't be bigger than the biggest bet \(500\)/);
  assert.match((await play(h, 'casino', 'maxbet 0', IDS.admin)).text, /whole number from 10 up[\s\S]*`inf` for no biggest bet/);
  assert.match((await play(h, 'casino', 'minbet 5', IDS.admin)).text, /whole number from 10 up/);
  assert.match((await play(h, 'casino', 'minbet 15', IDS.admin)).text, /Saved/);
  assert.match((await play(h, 'casino', 'cooldown 301', IDS.admin)).text, /0 to 300/);
  await h.slash('casino', 'cooldown 5', { user: IDS.admin });
  assert.match((await play(h, 'casino', 'crashmax 1', IDS.admin)).text, /2 to 100/);
  await h.slash('casino', 'crashmax 20', { user: IDS.admin });
  assert.match((await play(h, 'casino', 'off slots', IDS.admin)).text, /Slots is off. The other games still work/);
  assert.match((await play(h, 'casino', 'off chess', IDS.admin)).text, /I didn't get that/);
  assert.deepEqual([cfg().minBet, cfg().maxBet, cfg().cooldownSeconds, cfg().crashMax, cfg().slots], [15, 500, 5, 20, false]);

  const panel = await h.slash('casino', 'settings', { user: IDS.admin });
  assert.match(lastText(h, panel), /Casino settings/);
  assert.match(lastText(h, panel), /Slots:\*\* ⚪ Off/);
  await h.clickButton('Slots: off', { user: IDS.admin, in: panel });
  assert.equal(cfg().slots, true);
  const sneaky = await h.click('yo:casino:toggle:dice', { user: A });
  assert.match(lastText(h, sneaky), /Needs Admin|Only admins/);
  assert.equal(cfg().dice, true);
  const form = await h.clickButton('Bet limits', { user: IDS.admin, in: panel });
  assert.equal(form[0].type, 'modal');
  const bad = await h.submit('yo:casino:limitsave', { minbet: '900', maxbet: '800', cooldown: '0', crashmax: '50' }, { user: IDS.admin });
  assert.match(lastText(h, bad), /smallest bet didn't work[\s\S]*\(800\)/);
  const good = await h.submit('yo:casino:limitsave', { minbet: '700', maxbet: '2,000', cooldown: '0', crashmax: '50' }, { user: IDS.admin });
  assert.match(lastText(h, good), /Saved/);
  assert.deepEqual([cfg().minBet, cfg().maxBet, cfg().cooldownSeconds, cfg().crashMax], [700, 2000, 0, 50]);

  const field = (key) => h.engine.apps.get('casino').def.dashboard.find((f) => f.key === key);
  const vctx = { engine: h.engine, serverId: S };
  assert.match(field('minBet').validate(vctx, 3000).error, /can't be bigger than the biggest bet \(2,000\)/);
  assert.deepEqual(field('minBet').validate(vctx, 3000, { minBet: 3000, maxBet: 5000 }), { value: 3000 });
  assert.match(field('maxBet').validate(vctx, 100, { maxBet: 100, minBet: 'x' }).error, /smaller than the smallest bet \(700\)/);
  assert.match(field('crashMax').validate(vctx, 101).error, /2 to 100/);
  assert.deepEqual(field('cooldownSeconds').validate(vctx, '0'), { value: 0 });
  assert.deepEqual(field('slots').validate(vctx, 'off'), { value: false });
});

test('bet limits: any whole number is allowed and the biggest bet can be inf', async () => {
  const { h, eco } = await make({}, { eco: { [A]: 20_000_000 } });
  const cfg = () => h.engine.settings.appConfig(S, 'casino');

  assert.match((await play(h, 'casino', 'maxbet 5m', IDS.admin)).text, /biggest bet is now \*\*5,000,000\*\*/);
  assert.equal(cfg().maxBet, 5_000_000);
  assert.match((await play(h, 'casino', 'minbet 2,000,000', IDS.admin)).text, /smallest bet is now \*\*2,000,000\*\*/);
  assert.equal(cfg().minBet, 2_000_000);

  assert.match((await play(h, 'casino', 'maxbet inf', IDS.admin)).text, /no biggest bet now/);
  assert.equal(cfg().maxBet, 'inf');
  assert.match((await play(h, 'casino', 'minbet inf', IDS.admin)).text, /whole number from 10 up/);
  assert.equal(cfg().minBet, 2_000_000);
  assert.match((await play(h, 'casino', 'minbet 9m', IDS.admin)).text, /smallest bet is now \*\*9,000,000\*\*/);

  const settings = await h.slash('casino', 'settings', { user: IDS.admin });
  assert.match(lastText(h, settings), /Biggest bet:\*\* \*\*any amount\*\*/);
  assert.match((await play(h, 'casino', 'rules', A)).text, /and up, with no limit/);
  assert.match(lastText(h, await h.slash('casino', '', { user: A })), /and up, with no limit/);

  rolls(h, 0);
  const won = await play(h, 'coinflip', 'heads 9000000');
  assert.match(h.textOf(won.msg), /You won \*\*17,550,000\*\*/);
  assert.equal(eco.bal[A], 20_000_000 - 9_000_000 + 17_550_000);

  const big = { minBet: 10, maxBet: Infinity };
  assert.deepEqual(resolveBet({ kind: 'all' }, 28_550_000, big), { bet: 28_550_000 });
  assert.deepEqual(resolveBet({ kind: 'number', n: 9_999_999_999 }, 0, big), { bet: 9_999_999_999 });

  const form = await h.clickButton('Bet limits', { user: IDS.admin, in: settings });
  const field = form[0].modal.components.find((c) => c.custom_id === 'maxbet');
  assert.equal(field.value, 'inf');
  assert.match(field.label, /inf/);
  assert.ok(field.max_length >= 16);
  const saved = await h.submit('yo:casino:limitsave', { minbet: '1,000,000', maxbet: 'unlimited', cooldown: '0', crashmax: '50' }, { user: IDS.admin });
  assert.match(lastText(h, saved), /Saved[\s\S]*1,000,000[\s\S]*no limit/);
  assert.deepEqual([cfg().minBet, cfg().maxBet], [1_000_000, 'inf']);

  await play(h, 'casino', 'maxbet inf', IDS.admin);
  await play(h, 'casino', 'minbet 1000t', IDS.admin);
  const panel = await h.slash('casino', '', { user: A });
  const playForm = await h.clickButton('Coinflip', { user: A, in: panel });
  const betField = playForm[0].modal.components.find((c) => c.custom_id === 'bet');
  assert.deepEqual(parseAmountToken(betField.value), { kind: 'number', n: 1_000_000_000_000_000 });
  assert.ok(betField.value.length <= betField.max_length);

  const dash = (key) => h.engine.apps.get('casino').def.dashboard.find((f) => f.key === key);
  assert.equal(dash('maxBet').unlimited, true);
  assert.equal(dash('maxBet').max, 1_000_000_000_000_000);
  assert.equal(dash('minBet').unlimited, undefined);
  assert.equal(dash('minBet').max, 1_000_000_000_000_000);
  const vctx = { engine: h.engine, serverId: S };
  assert.deepEqual(dash('maxBet').validate(vctx, 'inf'), { value: 'inf' });
  assert.deepEqual(dash('minBet').validate(vctx, 50_000_000), { value: 50_000_000 });
  assert.match(dash('minBet').validate(vctx, 'inf').error, /whole number from 10 up/);
});

test('panel: members get the games, rules, stats and top; admins also settings; the play form starts a game', async () => {
  const { h, eco } = await make();
  const member = await h.slash('casino', '', { user: A });
  const text = lastText(h, member);
  assert.match(text, /Coinflip/);
  assert.match(text, /Just for fun with server coins. No real money/);
  for (const label of ['Coinflip', 'Dice', 'Slots', 'Blackjack', 'Roulette', 'Crash', 'Rules', 'My stats', 'Top']) assert.ok(h.findButton(label, member), label);
  assert.equal(h.findButton('Settings', member), null);
  const admin = await h.slash('casino', '', { user: IDS.admin });
  assert.ok(h.findButton('Settings', admin));
  const rules = await h.clickButton('Rules', { user: A, in: member });
  assert.match(lastText(h, rules), /3:2[\s\S]*36x[\s\S]*No real money/);
  const form = await h.clickButton('Coinflip', { user: A, in: member });
  assert.equal(form[0].type, 'modal');
  rolls(h, 0);
  const started = await h.submit('yo:casino:playsave:coinflip', { pick: 'heads', bet: '100' }, { user: A });
  assert.match(h.textOf(replyMsg(started)), /You won \*\*195\*\*/);
  assert.equal(eco.bal[A], 1095);
  rolls(h, 194_000);
  const crash = await h.submit('yo:casino:playsave:crash', { bet: '50', target: '2' }, { user: B });
  assert.match(h.textOf(replyMsg(crash)), /Auto cash-out at \*\*2\.00x\*\*/);
  await h.slash('casino', 'end', { user: B });
  const home = await h.slash('menu', '', { user: A });
  assert.ok(h.findButton('Casino', home), 'the home screen shows Casino once it is installed');
});

test('typed chat and /yap words reach the casino', async () => {
  const { h, eco } = await make();
  rolls(h, 0);
  await h.message('!coinflip heads 100', { user: A });
  assert.match(h.textOf(h.lastSent(G)), /You won \*\*195\*\*/);
  rolls(h, 30, 30, 30);
  await h.slash('yap', 'spin 10', { user: A });
  assert.match(h.textOf(h.lastSent(G)), /\(250x\)/);
  rolls(h, 6);
  await h.slash('yap', 'casino dice 6 10', { user: A });
  assert.match(h.textOf(h.lastSent(G)), /You won \*\*58\*\* 🪙 \(5\.8x\)/);
  const rules = await h.slash('yap', 'gamble rules', { user: A });
  assert.match(lastText(h, rules), /Casino rules and payouts/);
  assert.match(lastText(h, await h.slash('casino', 'slotz', { user: A })), /Did you mean \*\*slots\*\*/);
  assert.equal(eco.bal[A], 1000 + 95 + 2490 + 48);
});

test('a failed payout is kept and paid by the next check', async () => {
  const { h, eco } = await make({ fakeClock: true });
  const add = eco.add;
  let broken = true;
  eco.add = (...args) => { if (broken) throw new Error('store is down'); return add(...args); };
  rolls(h, 0);
  const res = await play(h, 'coinflip', 'heads 100');
  assert.match(res.text, /couldn't pay you yet[\s\S]*\*\*195\*\*/);
  assert.equal(eco.bal[A], 900);
  const owed = Object.values(doc(h).open);
  assert.equal(owed.length, 1);
  assert.equal(owed[0].kind, 'owed');
  assert.equal(owed[0].held, 195);
  await h.advance(3 * 60_000 + 1000);
  assert.equal(eco.bal[A], 900);
  assert.equal(jobs(h).length, 1, 'still trying');
  broken = false;
  await h.advance(3 * 60_000 + 1000);
  assert.equal(eco.bal[A], 1095);
  assert.deepEqual(doc(h).open, {});
  assert.equal(jobs(h).length, 0);
  assert.equal(svc(h).stats(S, A).returned, 195);
});

test('the real Economy app pays and logs casino games', async () => {
  const h = await createHarness({ apps: ['casino', 'economy'], fakeClock: true });
  h.engine.settings.setEnabled(S, 'casino', true);
  h.engine.settings.patchApp(S, 'casino', { cooldownSeconds: 0 });
  const eco = h.engine.service('economy');
  eco.add(S, A, 500, 'Seed');
  const before = eco.balance(S, A);
  rolls(h, 19);
  const res = await play(h, 'roulette', 'red 100');
  assert.match(h.textOf(res.msg), /You won \*\*200\*\*/);
  assert.equal(eco.balance(S, A), before + 100);
  rolls(h, 2);
  await play(h, 'roulette', 'red all');
  assert.equal(eco.balance(S, A), Math.max(0, before + 100 - 1000));
});

test('no comments in the casino app or its tests', () => {
  for (const rel of ['../../apps/casino.js', './casino.test.js']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const bad = src.split(/\r?\n/).filter((l) => /^\s*(\/\/|\/\*|\*\/)/.test(l));
    assert.deepEqual(bad, [], rel);
  }
});
