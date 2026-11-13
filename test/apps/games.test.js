import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';
import { QUESTIONS, CATEGORIES, tttWinner, c4Drop, c4Line, rpsWinner } from '../../apps/games.js';

const S = IDS.server;
const G = IDS.channels.general;
const A = IDS.member;
const B = IDS.member2;
const START = Date.parse('2026-11-07T12:00:00Z');
const make = (opts = {}) => createHarness({ apps: ['games'], ...opts });

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
const clockAt = (t) => { t.mock.timers.enable({ apis: ['Date'], now: START }); return (ms) => t.mock.timers.tick(ms); };
const svc = (h) => h.engine.service('games');
const live = (h, id, ch = G) => h.fake.state.messages[ch].find((m) => m.id === id);
const replyMsg = (ans) => ans.find((a) => a.type === 'reply')?.message;
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const sweep = async (h) => { await svc(h).sweep(); await settle(); };

function findBtn(h, msg, match) {
  const m = live(h, msg.id) || msg;
  return h.allButtons([m]).find((b) => (match instanceof RegExp ? match.test(b.custom_id) : b.label === match)) || null;
}

async function press(h, msg, match, user) {
  const b = findBtn(h, msg, match);
  assert.ok(b, `button ${match} exists; have ${h.allButtons([live(h, msg.id) || msg]).map((x) => x.label).join(', ')}`);
  return h.click(b.custom_id, { user, messageId: msg.id });
}

async function startGame(h, args, { user = A, accepter = B } = {}) {
  const ans = await h.slash('game', args, { user });
  const msg = replyMsg(ans);
  assert.ok(msg, `a challenge was posted for "${args}": ${lastText(h, ans)}`);
  if (accepter) await press(h, msg, 'Accept', accepter);
  return msg;
}

const cell = (i) => new RegExp(`:mv:[^:]+:${i}$`);

test('commands, meta and the shared service', async () => {
  const h = await make();
  for (const name of ['game', 'trivia']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100);
  }
  const a = h.engine.apps.get('games');
  assert.equal(a.meta.category, 'Fun');
  assert.equal(a.meta.icon, '🎮');
  assert.equal(a.def.panelPerm, 'member');
  assert.ok(a.def.help.length >= 3);
  assert.ok(svc(h).isPlaying && svc(h).active && svc(h).sweep);
  assert.ok(h.engine.scheduler.has('games.cleanup'));
});

test('question bank: 150+ questions, every category, four distinct answers, fits on buttons', () => {
  const all = Object.values(QUESTIONS).flat();
  assert.ok(all.length >= 150, `have ${all.length}`);
  assert.deepEqual(Object.keys(QUESTIONS).sort(), Object.keys(CATEGORIES).sort());
  for (const [cat, list] of Object.entries(QUESTIONS)) assert.ok(list.length >= 20, `${cat} has ${list.length}`);
  const seen = new Set();
  for (const q of all) {
    assert.equal(q.length, 5, q[0]);
    assert.equal(new Set(q.slice(1).map((x) => x.toLowerCase())).size, 4, `distinct answers: ${q[0]}`);
    assert.ok(q[0].length <= 200 && q[0].endsWith('?'), q[0]);
    for (const opt of q.slice(1)) assert.ok(opt.length > 0 && opt.length <= 70, opt);
    assert.ok(!seen.has(q[0]), `duplicate ${q[0]}`);
    seen.add(q[0]);
  }
});

test('win and draw helpers', () => {
  assert.equal(tttWinner([0, 0, 0, null, 1, 1, null, null, null]).player, 0);
  assert.deepEqual(tttWinner([1, 0, 0, null, 1, 0, null, null, 1]).line, [0, 4, 8]);
  assert.equal(tttWinner([0, 1, 0, 0, 1, 1, 1, 0, 0]), null);
  const b = Array.from({ length: 6 }, () => Array(7).fill(null));
  assert.equal(c4Drop(b, 3), 5);
  for (let r = 5; r >= 2; r--) b[r][3] = 1;
  assert.ok(c4Line(b, 2, 3));
  assert.equal(c4Drop(b, 3), 1);
  const d = Array.from({ length: 6 }, () => Array(7).fill(null));
  for (let i = 0; i < 4; i++) d[5 - i][i] = 0;
  assert.equal(c4Line(d, 2, 3).length, 4);
  d[5][0] = 1;
  assert.equal(c4Line(d, 2, 3), null);
  assert.equal(rpsWinner('rock', 'scissors'), 0);
  assert.equal(rpsWinner('rock', 'paper'), 1);
  assert.equal(rpsWinner('paper', 'paper'), null);
});

test('tic-tac-toe: challenge, accept, turns, outsiders refused, win, rematch and stats', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const ans = await h.slash('game', `tictactoe <@${B}>`, { user: A });
  const msg = replyMsg(ans);
  assert.match(h.textOf(msg), /challenges/);
  assert.ok(findBtn(h, msg, 'Accept') && findBtn(h, msg, 'Decline'));
  assert.equal(h.engine.router.panelOwner(msg.id), null, 'the game message is not locked to one person');
  const early = await h.click('yo:games:mv:gone1234:0', { user: A, messageId: msg.id });
  assert.match(lastText(h, early), /out of date/);
  const wrong = await press(h, msg, 'Accept', IDS.mod);
  assert.match(lastText(h, wrong), /for someone else/);
  const own = await press(h, msg, 'Accept', A);
  assert.match(lastText(h, own), /can't accept your own/);
  await press(h, msg, 'Accept', B);
  const board = live(h, msg.id);
  assert.match(h.textOf(board), /❌ <@.+> vs ⭕/);
  assert.match(h.textOf(board), new RegExp(`<@${A}>'s turn`));
  assert.equal(h.allButtons([board]).filter((b) => /:mv:/.test(b.custom_id)).length, 9);
  const outsider = await press(h, msg, cell(4), IDS.mod);
  assert.match(lastText(h, outsider), /not in this game/);
  assert.equal(live(h, msg.id).components[1].components[1].label, '·', 'outsider click changed nothing');
  const notTurn = await press(h, msg, cell(4), B);
  assert.match(lastText(h, notTurn), /not your turn/);
  await press(h, msg, cell(0), A);
  const taken = await h.click(findBtn(h, msg, cell(0)).custom_id, { user: B, messageId: msg.id });
  assert.match(lastText(h, taken), /taken/);
  await press(h, msg, cell(3), B);
  await press(h, msg, cell(1), A);
  await press(h, msg, cell(4), B);
  const win = await press(h, msg, cell(2), A);
  assert.equal(win[0].type, 'update', 'the move edits the same message');
  const done = live(h, msg.id);
  assert.match(h.textOf(done), new RegExp(`🏆 <@${A}> wins!`));
  assert.ok(h.allButtons([done]).filter((b) => /:mv:/.test(b.custom_id)).every((b) => b.disabled));
  assert.equal(h.allButtons([done]).filter((b) => b.style === 'success').length, 3, 'winning line highlighted');
  assert.ok(findBtn(h, msg, 'Rematch'));
  assert.equal(svc(h).isPlaying(S, A), false);
  const doc = h.engine.store.get('games', S);
  assert.equal(doc.stats[A].ttt.w, 1);
  assert.equal(doc.stats[B].ttt.l, 1);
  assert.deepEqual(doc.open, {});
  assert.equal(h.engine.scheduler.list({ kind: 'games.cleanup' }).length, 0);
  const stray = await press(h, msg, 'Rematch', IDS.mod);
  assert.match(lastText(h, stray), /not in this game/);
  await press(h, msg, 'Rematch', B);
  assert.match(h.textOf(live(h, msg.id)), /challenges <@.+> to \*\*Tic-tac-toe\*\*/);
  assert.equal(h.sent(G).length, 1, 'rematch reuses the same message');
  await press(h, msg, 'Accept', A);
  assert.match(h.textOf(live(h, msg.id)), new RegExp(`<@${B}>'s turn`));
  const stats = await h.slash('game', 'stats', { user: A });
  assert.match(lastText(h, stats), /1 win · 0 losses · 0 draws/);
});

test('tic-tac-toe draw and give up', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const msg = await startGame(h, `ttt <@${B}>`);
  for (const [i, who] of [[0, A], [1, B], [2, A], [4, B], [3, A], [5, B], [7, A], [6, B], [8, A]]) await press(h, msg, cell(i), who);
  assert.match(h.textOf(live(h, msg.id)), /It's a draw/);
  assert.equal(h.engine.store.get('games', S).stats[A].ttt.d, 1);
  await press(h, msg, 'Rematch', A);
  await press(h, msg, 'Accept', B);
  const gave = await press(h, msg, 'Give up', B);
  assert.match(lastText(h, gave), new RegExp(`<@${B}> gave up, so <@${A}> wins`));
});

test('challenges: decline, call off, open challenges and expiry', async (t) => {
  const tick = clockAt(t);
  const h = await make();
  const one = replyMsg(await h.slash('game', `rps <@${B}>`, { user: A }));
  const other = await press(h, one, 'Decline', IDS.mod);
  assert.match(lastText(h, other), /for someone else/);
  await press(h, one, 'Decline', B);
  assert.match(h.textOf(live(h, one.id)), /said no thanks/);
  assert.equal(live(h, one.id).components.length, 0);
  const two = replyMsg(await h.slash('game', `c4 <@${B}>`, { user: A }));
  await press(h, two, 'Decline', A);
  assert.match(h.textOf(live(h, two.id)), /called it off/);
  const open = replyMsg(await h.slash('game', 'tictactoe', { user: A }));
  assert.match(h.textOf(open), /anyone here/);
  const openDecline = await press(h, open, 'Decline', IDS.mod);
  assert.match(lastText(h, openDecline), /Only the challenger/);
  await press(h, open, 'Accept', IDS.mod);
  assert.deepEqual(svc(h).game(S, A).players.sort(), [A, IDS.mod].sort());
  await h.slash('game', 'end', { user: A });
  const late = replyMsg(await h.slash('game', `ttt <@${B}>`, { user: IDS.admin }));
  tick(61_000);
  await sweep(h);
  assert.match(h.textOf(live(h, late.id)), /didn't answer in time/);
  assert.equal(live(h, late.id).components.length, 0);
  assert.equal(svc(h).isPlaying(S, IDS.admin), false);
  const lazy = replyMsg(await h.slash('game', `ttt <@${B}>`, { user: IDS.admin }));
  tick(61_000);
  await press(h, lazy, 'Accept', B);
  assert.match(h.textOf(live(h, lazy.id)), /didn't answer in time/);
});

test('refusals: yourself, the bot, unknown people, busy players, unknown games', async () => {
  const h = await make();
  assert.match(lastText(h, await h.slash('game', `ttt <@${A}>`, { user: A })), /can't play yourself/);
  assert.match(lastText(h, await h.slash('game', `ttt <@${IDS.bot}>`, { user: A })), /can't press buttons/);
  assert.match(lastText(h, await h.slash('game', 'ttt nobodyhere', { user: A })), /couldn't find them/);
  assert.match(lastText(h, await h.slash('game', 'chess @riley', { user: A })), /don't know the game/);
  assert.match(lastText(h, await h.slash('game', 'tictacto @riley', { user: A })), /Did you mean/);
  await startGame(h, `ttt <@${B}>`);
  assert.match(lastText(h, await h.slash('game', `c4 <@${IDS.mod}>`, { user: A })), /already in a game/);
  assert.match(lastText(h, await h.slash('game', `c4 <@${B}>`, { user: IDS.mod })), /already in a game/);
  assert.equal(svc(h).active(S).games, 1);
  const list = await h.slash('game', 'list', { user: IDS.mod });
  assert.match(lastText(h, list), /vs/);
});

test('max 10 games per server', async () => {
  const h = await make();
  const extra = [];
  for (let i = 0; i < 11; i++) {
    const id = `a0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
    h.fake.state.members[S].push({ id, username: `player${i}`, display_name: `Player ${i}`, nickname: null, roles: [IDS.roles.member], joined_at: '2026-02-01T00:00:00Z' });
    extra.push(id);
  }
  h.engine.cache.invalidate(S);
  for (let i = 0; i < 10; i++) {
    const ans = await h.slash('game', 'tictactoe', { user: extra[i] });
    assert.ok(replyMsg(ans), `game ${i} started`);
  }
  const over = await h.slash('game', 'tictactoe', { user: extra[10] });
  assert.match(lastText(h, over), /already 10 games/);
});

test('connect 4: discs drop, full columns lock, vertical win', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const msg = await startGame(h, `connect4 <@${B}>`);
  const board = live(h, msg.id);
  assert.equal(board.components.length, 3);
  assert.deepEqual(board.components[0].components.map((b) => b.label), ['1', '2', '3', '4']);
  assert.deepEqual(board.components[1].components.map((b) => b.label), ['5', '6', '7']);
  assert.match(h.textOf(board), /⚪⚪⚪⚪⚪⚪⚪/);
  for (let i = 0; i < 3; i++) {
    await press(h, msg, cell(0), A);
    await press(h, msg, cell(0), B);
  }
  const col = findBtn(h, msg, cell(0));
  assert.equal(col.disabled, true, 'a full column is disabled');
  const full = await h.click(col.custom_id, { user: A, messageId: msg.id });
  assert.match(lastText(h, full), /column is full/);
  assert.match(h.textOf(live(h, msg.id)), /🟡⚪{6}\n🔴⚪{6}\n🟡⚪{6}\n🔴⚪{6}\n🟡⚪{6}\n🔴⚪{6}/u);
  for (let i = 0; i < 3; i++) {
    await press(h, msg, cell(1), A);
    await press(h, msg, cell(2), B);
  }
  await press(h, msg, cell(1), A);
  const end = live(h, msg.id);
  assert.match(h.textOf(end), new RegExp(`🏆 <@${A}> wins`));
  assert.equal(h.allButtons([end]).some((b) => /:mv:/.test(b.custom_id)), false);
  assert.ok(findBtn(h, msg, 'Rematch'));
});

test('rock paper scissors: picks stay private until both have picked', async () => {
  const h = await make();
  const msg = await startGame(h, `rps <@${B}>`);
  const first = await press(h, msg, 'Rock', A);
  assert.equal(first[0].type, 'update');
  assert.equal(first[1].type, 'ephemeral');
  assert.match(h.textOf(first[1]), /You picked 🪨 \*\*Rock\*\*/);
  const shown = h.textOf(live(h, msg.id));
  assert.match(shown, /✅ picked/);
  assert.doesNotMatch(shown, /Rock\*\*/);
  const again = await press(h, msg, 'Paper', A);
  assert.match(lastText(h, again), /already picked/);
  const outsider = await press(h, msg, 'Paper', IDS.mod);
  assert.match(lastText(h, outsider), /not in this game/);
  await press(h, msg, 'Scissors', B);
  const done = h.textOf(live(h, msg.id));
  assert.match(done, /picked 🪨 \*\*Rock\*\*/);
  assert.match(done, /picked ✂️ \*\*Scissors\*\*/);
  assert.match(done, new RegExp(`🏆 <@${A}> wins`));
  await press(h, msg, 'Rematch', B);
  await press(h, msg, 'Accept', A);
  await press(h, msg, 'Paper', A);
  await press(h, msg, 'Paper', B);
  assert.match(h.textOf(live(h, msg.id)), /It's a draw/);
});

test('bets: held on accept, winner takes the pot, draws and declines give coins back', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 100, [IDS.mod]: 10 }));
  const msg = replyMsg(await h.slash('game', `rps <@${B}> bet 50`, { user: A }));
  assert.match(h.textOf(msg), /Bet: \*\*50\*\* 🪙 each · winner takes \*\*100\*\* 🪙/);
  assert.equal(eco.bal[A], 100, 'nothing is taken before the challenge is accepted');
  await press(h, msg, 'Accept', B);
  assert.equal(eco.bal[A], 50);
  assert.equal(eco.bal[B], 50);
  assert.deepEqual(h.engine.store.get('games', S).open[svc(h).game(S, A).id].held.players.sort(), [A, B].sort());
  await press(h, msg, 'Rock', A);
  await press(h, msg, 'Scissors', B);
  assert.equal(eco.bal[A], 150);
  assert.equal(eco.bal[B], 50);
  assert.match(h.textOf(live(h, msg.id)), /takes \*\*100\*\* 🪙/);
  await press(h, msg, 'Rematch', B);
  await press(h, msg, 'Accept', A);
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 0);
  await press(h, msg, 'Paper', A);
  await press(h, msg, 'Paper', B);
  assert.equal(eco.bal[A], 150);
  assert.equal(eco.bal[B], 50);
  assert.match(h.textOf(live(h, msg.id)), /Both bets went back/);
  const declined = replyMsg(await h.slash('game', `ttt <@${B}> 20`, { user: A }));
  await press(h, declined, 'Decline', B);
  assert.equal(eco.bal[A], 150);
  assert.equal(eco.bal[B], 50);
});

test('bets: not enough coins, limits, bets off and no Economy app', async () => {
  const h = await make();
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 50`, { user: A })), /needs the \*\*Economy\*\* app/);
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 10 }));
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 500`, { user: A })), /Not enough coins/);
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 5000`, { user: A })), /biggest bet here is \*\*1,000\*\*/);
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet lots`, { user: A })), /whole numbers/);
  const msg = replyMsg(await h.slash('game', `rps <@${B}> bet 50`, { user: A }));
  const poor = await press(h, msg, 'Accept', B);
  assert.match(lastText(h, poor), /You need \*\*50\*\* 🪙 to accept and you have \*\*10\*\* 🪙/);
  assert.equal(eco.bal[A], 100, 'the challenger got their stake back');
  assert.equal(eco.bal[B], 10);
  assert.ok(findBtn(h, msg, 'Accept'), 'the challenge stays open');
  eco.bal[B] = 60;
  await press(h, msg, 'Accept', B);
  assert.equal(eco.bal[B], 10);
  assert.equal(eco.bal[A], 50);
  await h.slash('game', 'end', { user: A });
  assert.equal(eco.bal[B], 110, 'giving up hands the pot to the other player');
  h.engine.settings.patchApp(S, 'games', { bets: false });
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 5`, { user: A })), /Bets are off/);
  h.engine.settings.patchApp(S, 'games', { bets: true });
  h.engine.settings.setEnabled(S, 'economy', false);
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 5`, { user: A })), /Economy/);
});

test('idle players forfeit after 2 minutes and the winner takes the pot', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const tick = clockAt(t);
  const h = await make();
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 100 }));
  const msg = await startGame(h, `ttt <@${B}> bet 40`);
  await press(h, msg, cell(4), A);
  tick(60_000);
  await sweep(h);
  assert.match(h.textOf(live(h, msg.id)), new RegExp(`<@${B}>'s turn`));
  tick(61_000);
  await sweep(h);
  assert.match(h.textOf(live(h, msg.id)), new RegExp(`<@${B}> didn't move for 2 minutes, so <@${A}> wins`));
  assert.equal(eco.bal[A], 140);
  assert.equal(eco.bal[B], 60);
  const rps = await startGame(h, `rps <@${B}> bet 10`);
  tick(121_000);
  const lateClick = await press(h, rps, 'Rock', A);
  assert.match(lastText(h, lateClick), /Nobody picked in time/i);
  assert.equal(eco.bal[A], 140);
  assert.equal(eco.bal[B], 60);
});

test('mods can end a stuck game; members cannot end someone else\'s', async () => {
  const h = await make();
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 100 }));
  const msg = await startGame(h, `c4 <@${B}> bet 25`);
  assert.equal(eco.bal[A], 75);
  const denied = await h.slash('game', `end <@${A}>`, { user: IDS.member2 });
  assert.match(lastText(h, denied), /Needs Mod|Only moderators/);
  const ok = await h.slash('game', `end <@${A}>`, { user: IDS.mod });
  assert.match(lastText(h, ok), /cancelled and any bets went back/);
  await settle();
  assert.match(h.textOf(live(h, msg.id)), /a moderator ended it/);
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 100);
  assert.match(lastText(h, await h.slash('game', 'end', { user: A })), /not in a game/);
});

test('typed chat commands and /yap shortcuts work too', async () => {
  const h = await make();
  await h.message(`!game tictactoe <@${B}>`, { user: A });
  assert.match(h.textOf(h.lastSent(G)), /challenges/);
  await h.slash('game', 'end', { user: A });
  await h.slash('yap', `rps <@${B}>`, { user: A });
  assert.equal(svc(h).game(S, A).kind, 'rps');
});

test('restart: clicking an old board cancels it and gives bets back once', async () => {
  const store = createMemoryStore();
  const eco = fakeEconomy({ [A]: 100, [B]: 100 });
  const a = await make({ fakeClock: true, store });
  withEco(a, eco);
  const msg = await startGame(a, `rps <@${B}> bet 30`);
  assert.equal(eco.bal[A], 70);
  const rock = findBtn(a, msg, 'Rock').custom_id;
  a.engine.scheduler.stop();
  const b = await make({ fakeClock: true, store });
  withEco(b, eco);
  const res = await b.click(rock, { user: A, messageId: msg.id });
  assert.equal(res[0].type, 'update');
  assert.match(b.textOf(res[0]), /I restarted, so this game was cancelled/);
  assert.equal(res[0].components.length, 0);
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 100);
  assert.deepEqual(b.engine.store.get('games', S).open, {});
  assert.equal(b.engine.scheduler.list({ kind: 'games.cleanup' }).length, 0);
  await b.click(rock, { user: B, messageId: msg.id });
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 100);
});

test('restart: the safety check tidies boards and trivia nobody clicks', async () => {
  const store = createMemoryStore();
  const eco = fakeEconomy({ [A]: 100, [B]: 100 });
  const a = await make({ fakeClock: true, store });
  withEco(a, eco);
  const game = await startGame(a, `ttt <@${B}> bet 20`);
  const quiz = replyMsg(await a.slash('trivia', '5', { user: IDS.mod, channel: IDS.channels.news }));
  assert.ok(quiz);
  assert.equal(a.engine.scheduler.list({ kind: 'games.cleanup' }).length, 2);
  await a.advance(3 * 60_000 + 1000);
  assert.equal(a.engine.scheduler.list({ kind: 'games.cleanup' }).length, 2, 'live games push their check back');
  a.engine.scheduler.stop();
  const b = await make({ fakeClock: true, store });
  withEco(b, eco);
  b.fake.state.messages[G] = structuredClone(a.fake.state.messages[G]);
  b.fake.state.messages[IDS.channels.news] = structuredClone(a.fake.state.messages[IDS.channels.news]);
  b.clock.t = a.clock.t;
  await b.advance(3 * 60_000 + 1000);
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 100);
  assert.match(b.textOf(live(b, game.id)), /Game cancelled/);
  assert.equal(live(b, game.id).components.length, 0);
  assert.match(b.textOf(live(b, quiz.id, IDS.channels.news)), /Trivia stopped/);
  assert.deepEqual(b.engine.store.get('games', S).open, {});
  assert.equal(b.engine.scheduler.list({ kind: 'games.cleanup' }).length, 0);
});

test('uninstalling Games ends running games at the next check and refunds bets', async () => {
  const h = await make({ fakeClock: true });
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 100 }));
  const msg = await startGame(h, `c4 <@${B}> bet 10`);
  assert.equal(eco.bal[A], 90);
  h.engine.settings.setEnabled(S, 'games', false);
  const blocked = await press(h, msg, cell(0), A);
  assert.match(lastText(h, blocked), /isn't installed here/);
  await h.advance(3 * 60_000 + 1000);
  assert.match(h.textOf(live(h, msg.id)), /Games was uninstalled here/);
  assert.equal(eco.bal[A], 100);
  assert.equal(eco.bal[B], 100);
  assert.equal(svc(h).isPlaying(S, A), false);
});

test('trivia: one question, answer once, reveal with who got it right, another question', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const tick = clockAt(t);
  const h = await make();
  const ans = await h.slash('trivia', '', { user: A });
  const msg = replyMsg(ans);
  assert.equal(h.engine.router.panelOwner(msg.id), null);
  const q = svc(h).trivia(G);
  assert.equal(q.total, 1);
  assert.match(h.textOf(msg), new RegExp(q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const right = new RegExp(`:ta:${q.id}:0:${q.answer}$`);
  const wrong = new RegExp(`:ta:${q.id}:0:${(q.answer + 1) % 4}$`);
  const mine = await press(h, msg, right, A);
  assert.equal(mine[0].type, 'ephemeral');
  assert.match(h.textOf(mine[0]), /Locked in/);
  const twice = await press(h, msg, wrong, A);
  assert.match(lastText(h, twice), /already answered/);
  await press(h, msg, wrong, B);
  await press(h, msg, right, IDS.mod);
  tick(3000);
  await sweep(h);
  assert.match(live(h, msg.id).embeds[0].footer.text, /3 answers/);
  tick(17_001);
  await sweep(h);
  const shown = live(h, msg.id);
  const text = h.textOf(shown);
  assert.match(text, /Got it right \(2\)/);
  assert.match(text, new RegExp(`Fastest: <@${A}>`));
  assert.doesNotMatch(text, new RegExp(`Got it right.*<@${B}>`));
  assert.ok(h.allButtons([shown]).filter((b) => /:ta:/.test(b.custom_id)).every((b) => b.disabled));
  const late = await press(h, msg, /:tagain:/, IDS.admin);
  assert.equal(late[0].type, 'update');
  assert.equal(h.sent(G).length, 1, 'another question reuses the message');
  assert.notEqual(svc(h).trivia(G).id, q.id);
  const stale = await h.click(`yo:games:ta:${q.id}:0:${q.answer}`, { user: B, messageId: msg.id });
  assert.match(lastText(h, stale), /restarted|over/i);
  assert.equal(h.engine.store.get('games', S).stats[A].trivia.correct, 1);
});

test('trivia round: scores, next questions in the same message, final results and a coin prize', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const tick = clockAt(t);
  const h = await make();
  const eco = withEco(h, fakeEconomy({}));
  const msg = replyMsg(await h.slash('trivia', '3 science', { user: A }));
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const q = svc(h).trivia(G);
    assert.equal(q.index, i);
    assert.equal(q.category, 'science');
    seen.add(q.question);
    assert.match(h.textOf(live(h, msg.id)), new RegExp(`${i + 1}/3`));
    await press(h, msg, new RegExp(`:ta:${q.id}:${i}:${q.answer}$`), A);
    await press(h, msg, new RegExp(`:ta:${q.id}:${i}:${i === 1 ? q.answer : (q.answer + 1) % 4}$`), B);
    tick(20_001);
    await sweep(h);
    if (i < 2) {
      assert.match(h.textOf(live(h, msg.id)), /Next question/);
      assert.match(h.textOf(live(h, msg.id)), /Scores/);
      tick(5_001);
      await sweep(h);
    }
  }
  assert.equal(seen.size, 3, 'no repeats in a round');
  const final = h.textOf(live(h, msg.id));
  assert.match(final, /Trivia results/);
  assert.match(final, new RegExp(`🥇 <@${A}> · 3 points`));
  assert.match(final, new RegExp(`🥈 <@${B}> · 1 point`));
  assert.match(final, /won \*\*25\*\* 🪙/);
  assert.equal(eco.bal[A], 25);
  assert.equal(eco.bal[B], undefined);
  assert.equal(h.sent(G).length, 1, 'the whole round used one message');
  assert.equal(svc(h).trivia(G), null);
  assert.equal(h.engine.store.get('games', S).stats[A].trivia.wins, 1);
  assert.ok(findBtn(h, msg, 'Play again'));
});

test('trivia: answer count edits are coalesced', async (t) => {
  const tick = clockAt(t);
  const h = await make();
  const msg = replyMsg(await h.slash('trivia', '', { user: A }));
  const q = svc(h).trivia(G);
  const before = h.fake.callsTo('PATCH', new RegExp(msg.id)).length;
  for (const user of [A, B, IDS.mod, IDS.admin, IDS.owner]) await press(h, msg, new RegExp(`:ta:${q.id}:0:0$`), user);
  assert.equal(h.fake.callsTo('PATCH', new RegExp(msg.id)).length - before, 0, 'no edit per click');
  tick(3001);
  await sweep(h);
  assert.equal(h.fake.callsTo('PATCH', new RegExp(msg.id)).length - before, 1, 'one edit for all five answers');
  assert.match(live(h, msg.id).embeds[0].footer.text, /5 answers/);
});

test('trivia: one per channel, stop rules, categories and bad input', async (t) => {
  const tick = clockAt(t);
  const h = await make();
  const msg = replyMsg(await h.slash('trivia', '20', { user: A }));
  assert.equal(svc(h).trivia(G).total, 10, 'rounds are capped at 10');
  assert.match(lastText(h, await h.slash('trivia', '', { user: B })), /already running here/);
  const no = await press(h, msg, 'Stop', B);
  assert.match(lastText(h, no), /can't stop this one/);
  await press(h, msg, 'Stop', IDS.mod);
  await settle();
  assert.match(h.textOf(live(h, msg.id)), /Stopped by/);
  assert.equal(svc(h).trivia(G), null);
  const cats = await h.slash('trivia', 'categories', { user: B });
  assert.match(lastText(h, cats), /Geography/);
  const bad = await h.slash('trivia', 'histroy', { user: B });
  assert.match(lastText(h, bad), /Did you mean \*\*history\*\*/);
  replyMsg(await h.slash('trivia', 'music', { user: B }));
  assert.equal(svc(h).trivia(G).category, 'music');
  tick(1000);
  const stop = await h.slash('trivia', 'stop', { user: B });
  assert.match(lastText(h, stop), /stopped/i);
  assert.match(lastText(h, await h.slash('trivia', 'stop', { user: B })), /Nothing is running/);
});

test('trivia: clicks after a restart tidy the message', async () => {
  const store = createMemoryStore();
  const a = await make({ store });
  const msg = replyMsg(await a.slash('trivia', '', { user: A }));
  const q = a.engine.service('games').trivia(G);
  const b = await make({ store });
  const res = await b.click(`yo:games:ta:${q.id}:0:${q.answer}`, { user: B, messageId: msg.id });
  assert.equal(res[0].type, 'update');
  assert.match(b.textOf(res[0]), /Trivia stopped/);
  assert.equal(b.engine.store.get('games', S).open[q.id], undefined);
});

test('panel: members get games and trivia, admins also get settings', async () => {
  const h = await make();
  const home = await h.slash('menu', '', { user: A });
  assert.ok(h.findButton('Games', home), 'the home screen shows the Games tile to members');
  const member = await h.slash('game', '', { user: A });
  const text = lastText(h, member);
  assert.match(text, /Tic-tac-toe/);
  assert.match(text, /Trivia/);
  assert.equal(h.findButton('Settings', member), null);
  assert.ok(h.findButton('Trivia question', member));
  const started = await h.clickButton('Trivia question', { user: A, in: member });
  assert.ok(replyMsg(started), 'trivia posted as its own message');
  assert.equal(h.engine.router.panelOwner(replyMsg(started).id), null);
  const admin = await h.slash('game', '', { user: IDS.admin });
  const settings = await h.clickButton('Settings', { user: IDS.admin, in: admin });
  assert.match(lastText(h, settings), /Games settings/);
  await h.clickButton('Turn bets off', { user: IDS.admin, in: settings });
  assert.equal(h.engine.settings.appConfig(S, 'games').bets, false);
  const sneaky = await h.click('yo:games:tbets', { user: A });
  assert.match(lastText(h, sneaky), /Needs Admin|Only admins/);
  assert.equal(h.engine.settings.appConfig(S, 'games').bets, false);
});

test('admin typed settings and the settings form', async () => {
  const h = await make();
  assert.match(lastText(h, await h.slash('game', 'prize 50', { user: A })), /Needs Admin|Only admins/);
  assert.match(lastText(h, await h.slash('game', 'prize 50', { user: IDS.admin })), /\*\*50\*\*/);
  assert.equal(h.engine.settings.appConfig(S, 'games').triviaPrize, 50);
  await h.slash('game', 'maxbet 500', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'games').maxBet, 500);
  assert.match(lastText(h, await h.slash('game', 'maxbet zero', { user: IDS.admin })), /didn't work/);
  await h.slash('game', 'bets off', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'games').bets, false);
  await h.slash('game', 'prize off', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'games').triviaPrize, 0);
  const saved = await h.submit('yo:games:setsave', { prize: '30', maxbet: '2,000' }, { user: IDS.admin });
  assert.match(lastText(h, saved), /Saved/);
  assert.equal(h.engine.settings.appConfig(S, 'games').maxBet, 2000);
  assert.equal(h.engine.settings.appConfig(S, 'games').triviaPrize, 30);
  const bad = await h.submit('yo:games:setsave', { prize: '-3', maxbet: '10' }, { user: IDS.admin });
  assert.match(lastText(h, bad), /didn't work/);
});

test('big bet caps, inf for no limit and old saved numbers all work', async () => {
  const h = await make();
  await h.slash('game', 'maxbet 5m', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'games').maxBet, 5_000_000);
  await h.slash('game', 'prize 2,500,000', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'games').triviaPrize, 2_500_000);

  const off = await h.slash('game', 'maxbet inf', { user: IDS.admin });
  assert.match(lastText(h, off), /no limit/i);
  assert.equal(h.engine.settings.appConfig(S, 'games').maxBet, 'inf');
  assert.match(lastText(h, await h.slash('game', 'settings', { user: IDS.admin })), /Biggest bet:\*\* No limit/);
  assert.match(lastText(h, await h.slash('game', 'prize inf', { user: IDS.admin })), /didn't work/);

  const form = await h.submit('yo:games:setsave', { prize: '30', maxbet: 'unlimited' }, { user: IDS.admin });
  assert.match(lastText(h, form), /no limit/i);
  assert.equal(h.engine.settings.appConfig(S, 'games').maxBet, 'inf');
  assert.match(lastText(h, await h.slash('game', 'maxbet nope', { user: IDS.admin })), /didn't work/);
});

test('an unlimited max bet lets any bet through', async () => {
  const h = await make();
  withEco(h, fakeEconomy({ [A]: 9_000_000, [B]: 9_000_000 }));
  await h.slash('game', 'maxbet 100', { user: IDS.admin });
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 5000`, { user: A })), /too big/);
  await h.slash('game', 'maxbet inf', { user: IDS.admin });
  const ok = await h.slash('game', `rps <@${B}> bet 5000`, { user: A });
  assert.doesNotMatch(lastText(h, ok), /too big/);
});

test('even with no limit a bet stays a real number of coins', async () => {
  const h = await make();
  withEco(h, fakeEconomy({ [A]: 9_000_000, [B]: 9_000_000 }));
  await h.slash('game', 'maxbet inf', { user: IDS.admin });
  const huge = lastText(h, await h.slash('game', `rps <@${B}> bet 9000000000000000`, { user: A }));
  assert.match(huge, /too big/);
  assert.doesNotMatch(huge, /Infinity|NaN/);
  assert.match(lastText(h, await h.slash('game', `rps <@${B}> bet 99999999999999999999`, { user: A })), /didn't work/);
});

test('forged buttons and odd words never reach object internals', async () => {
  const h = await make();
  for (const word of ['constructor', '__proto__', 'toString']) {
    const ans = await h.slash('game', `${word} <@${B}>`, { user: A });
    assert.match(lastText(h, ans), /don't know the game/, word);
  }
  assert.match(lastText(h, await h.slash('trivia', 'constructor', { user: A })), /don't know that category/);
  const msg = await startGame(h, `rps <@${B}>`);
  const gid = svc(h).game(S, A).id;
  for (const bad of ['constructor', '__proto__', 'hasOwnProperty']) {
    const res = await h.click(`yo:games:rps:${gid}:${bad}`, { user: A, messageId: msg.id });
    assert.match(lastText(h, res), /Pick again/, bad);
  }
  assert.doesNotMatch(h.textOf(live(h, msg.id)), /undefined/);
  assert.match(h.textOf(live(h, msg.id)), /choosing/);
  const again = await h.click('yo:games:tagain:3:constructor', { user: A });
  assert.ok(svc(h).trivia(G), 'a forged category falls back to mixed questions');
  assert.doesNotMatch(lastText(h, again), /ran out/);
});

test('rematch pressed by both players at once starts only one game', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const eco = withEco(h, fakeEconomy({ [A]: 100, [B]: 100 }));
  const msg = await startGame(h, `rps <@${B}> bet 10`);
  await press(h, msg, 'Rock', A);
  await press(h, msg, 'Scissors', B);
  const rm = findBtn(h, msg, 'Rematch').custom_id;
  const [x, y] = await Promise.all([h.click(rm, { user: A, messageId: msg.id }), h.click(rm, { user: B, messageId: msg.id })]);
  assert.equal(svc(h).active(S).games, 1);
  assert.equal([x, y].filter((r) => r[0]?.type === 'update').length, 1);
  assert.match(lastText(h, [x, y].find((r) => r[0]?.type !== 'update')), /expired/);
  assert.equal(eco.bal[A] + eco.bal[B], 200);
});

test('rematch refused for coins keeps the button working for later', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await make();
  const eco = withEco(h, fakeEconomy({ [A]: 20, [B]: 20 }));
  const msg = await startGame(h, `rps <@${B}> bet 20`);
  await press(h, msg, 'Rock', A);
  await press(h, msg, 'Scissors', B);
  assert.equal(eco.bal[B], 0);
  const poor = await press(h, msg, 'Rematch', B);
  assert.match(lastText(h, poor), /Not enough coins/);
  await press(h, msg, 'Rematch', A);
  assert.match(h.textOf(live(h, msg.id)), /challenges/);
});

test('late clicks on a finished trivia or game never wipe the result', async (t) => {
  const tick = clockAt(t);
  const h = await make();
  const msg = replyMsg(await h.slash('trivia', '', { user: A }));
  const q = svc(h).trivia(G);
  tick(20_001);
  await sweep(h);
  const result = h.textOf(live(h, msg.id));
  assert.match(result, /✅/);
  const lateAnswer = await h.click(`yo:games:ta:${q.id}:0:${q.answer}`, { user: B, messageId: msg.id });
  assert.equal(lateAnswer[0].type, 'ephemeral');
  assert.match(lastText(h, lateAnswer), /already over/);
  const lateStop = await h.click(`yo:games:ts:${q.id}`, { user: A, messageId: msg.id });
  assert.equal(lateStop[0].type, 'ephemeral');
  assert.equal(h.textOf(live(h, msg.id)), result);
  const ch = replyMsg(await h.slash('game', `ttt <@${B}>`, { user: A }));
  const accept = findBtn(h, ch, 'Accept').custom_id;
  tick(61_000);
  await sweep(h);
  const expired = h.textOf(live(h, ch.id));
  const lateAccept = await h.click(accept, { user: B, messageId: ch.id });
  assert.match(lastText(h, lateAccept), /game is over/);
  assert.doesNotMatch(lastText(h, lateAccept), /restarted/);
  assert.equal(h.textOf(live(h, ch.id)), expired);
});

test('a game ended by a mod while it is starting gives both stakes back', async () => {
  const h = await make();
  const bal = { [A]: 100, [B]: 100 };
  const slow = {
    currency: () => ({ name: 'coins', emoji: '🪙' }),
    balance: (sid, uid) => bal[uid] || 0,
    add: (sid, uid, n) => { bal[uid] = (bal[uid] || 0) + n; return bal[uid]; },
    take: async (sid, uid, n) => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (bal[uid] < n) return null;
      bal[uid] -= n;
      return bal[uid];
    },
  };
  withEco(h, slow);
  const msg = replyMsg(await h.slash('game', `rps <@${B}> bet 30`, { user: A }));
  const acc = h.click(findBtn(h, msg, 'Accept').custom_id, { user: B, messageId: msg.id });
  await new Promise((r) => setImmediate(r));
  const end = h.slash('game', `end <@${A}>`, { user: IDS.mod });
  const [accepted] = await Promise.all([acc, end]);
  await settle();
  assert.deepEqual([bal[A], bal[B]], [100, 100]);
  assert.deepEqual(h.engine.store.get('games', S).open, {});
  assert.equal(svc(h).active(S).games, 0);
  assert.match(lastText(h, accepted), /ended|over/i);
  assert.equal(h.engine.scheduler.list({ kind: 'games.cleanup' }).length, 0);
});

test('rock paper scissors: a player who never picks forfeits with a clear note', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const tick = clockAt(t);
  const h = await make();
  const msg = await startGame(h, `rps <@${B}>`);
  await press(h, msg, 'Paper', A);
  tick(121_000);
  await sweep(h);
  assert.match(h.textOf(live(h, msg.id)), new RegExp(`<@${B}> didn't pick for 2 minutes, so <@${A}> wins`));
});

test('trivia rounds cut short pay no prize', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const tick = clockAt(t);
  const h = await make();
  const eco = withEco(h, fakeEconomy({}));
  const msg = replyMsg(await h.slash('trivia', '5', { user: A }));
  const q = svc(h).trivia(G);
  await press(h, msg, new RegExp(`:ta:${q.id}:0:${q.answer}$`), B);
  tick(20_001);
  await sweep(h);
  h.engine.settings.setEnabled(S, 'games', false);
  tick(5_001);
  await sweep(h);
  tick(20_001);
  await sweep(h);
  assert.equal(svc(h).trivia(G), null);
  assert.equal(eco.bal[B], undefined, 'no coins for an unfinished round');
  assert.equal(h.engine.store.get('games', S).stats[B].trivia.wins, 0);
});
