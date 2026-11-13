import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from './harness.js';

const S = IDS.server;
const G = IDS.channels.general;
const NEWS = IDS.channels.news;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const all = async (opts = {}) => {
  const h = await createHarness({ fakeClock: true, ...opts });
  h.engine.config.liveEditGapMs = 0;
  return h;
};
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const replyMsg = (ans) => ans.find((a) => a.type === 'reply')?.message;
const buttonsOf = (m) => (m?.components || []).flatMap((r) => r.components || []);
const live = (h, id, ch = G) => h.fake.state.messages[ch].find((m) => m.id === id);
const withId = (h, part, ch = G) => [...h.sent(ch)].reverse().find((m) => JSON.stringify(m.components || []).includes(part));

async function press(h, msg, match, user) {
  const m = live(h, msg.id) || msg;
  const b = h.allButtons([m]).find((x) => (match instanceof RegExp ? match.test(x.custom_id) : x.label === match));
  assert.ok(b, `button ${match} exists; have ${h.allButtons([m]).map((x) => x.label).join(', ')}`);
  return h.click(b.custom_id, { user, messageId: msg.id });
}

const EXPECTED_COMMANDS = {
  system: ['menu', 'help', 'status', 'apps', 'yap'],
  automod: ['automod'],
  casino: ['casino', 'coinflip', 'dice', 'slots', 'blackjack', 'roulette', 'crash'],
  economy: ['daily', 'balance', 'shop', 'economy'],
  engage: ['poll', 'giveaway'],
  games: ['game', 'trivia'],
  levels: ['rank', 'leaderboard', 'levels'],
  mod: ['mod', 'warn', 'timeout', 'kick', 'ban', 'purge', 'lock', 'unlock', 'case'],
  pocket: ['remind', 'afk', 'pocket'],
  roles: ['roles'],
  studio: ['caption', 'gif'],
  tickets: ['ticket', 'tickets'],
  tools: ['tag', 'embed', 'schedule'],
  voice: ['voice'],
  welcome: ['welcome'],
};

test('every app loads together with its own commands, well under the 100 limit', async () => {
  const h = await all();
  const owner = new Map();
  for (const a of h.engine.apps.list()) {
    for (const name of Object.keys(a.def.commands || {})) {
      assert.ok(!owner.has(name), `/${name} is claimed by ${owner.get(name)} and ${a.meta.id}`);
      owner.set(name, a.meta.id);
    }
  }
  for (const [app, names] of Object.entries(EXPECTED_COMMANDS)) {
    assert.ok(h.engine.apps.get(app), `${app} is loaded`);
    for (const n of names) assert.equal(owner.get(n), app, `/${n} belongs to ${app}`);
  }
  assert.equal(owner.size, h.bot.commands.size);
  assert.ok(owner.size <= 60, `${owner.size} commands`);
  for (const c of h.bot.commands.values()) assert.ok(c.description.length > 0 && c.description.length <= 100);
  const words = new Map();
  for (const r of h.engine.yap.routes()) for (const w of r.words) {
    assert.ok(!words.has(w) || words.get(w) === r.app, `/yap ${w} is claimed by ${words.get(w)} and ${r.app}`);
    words.set(w, r.app);
  }
  for (const w of words.keys()) assert.ok(!h.bot.commands.has(w) || owner.get(w) === words.get(w), `/yap ${w} points away from /${w}`);
  assert.ok(!h.lines.some((l) => /error/i.test(l)), h.lines.join('\n'));
});

test('every app has help lines and a panel, and the home screen fits each level', async () => {
  const h = await all();
  for (const a of h.engine.apps.list()) {
    if (a.meta.core) continue;
    assert.ok((a.def.help || []).length > 0, `${a.meta.id} has help lines`);
    assert.equal(typeof a.def.panel, 'function', `${a.meta.id} has a panel`);
  }
  const tiles = async (user) => {
    const ans = await h.slash('menu', '', { user });
    return new Set(h.allButtons(ans).filter((b) => b.custom_id.startsWith('yo:system:open:')).map((b) => b.custom_id.split(':')[3]));
  };
  const member = await tiles(IDS.member);
  const mod = await tiles(IDS.mod);
  const admin = await tiles(IDS.admin);
  for (const id of ['economy', 'engage', 'games', 'levels', 'pocket', 'tickets', 'tools', 'voice']) assert.ok(member.has(id), `members see ${id}`);
  for (const id of ['mod', 'automod', 'roles', 'welcome']) assert.ok(!member.has(id), `members do not see ${id}`);
  for (const id of ['mod', 'automod']) assert.ok(mod.has(id), `mods see ${id}`);
  for (const id of ['roles', 'welcome']) assert.ok(!mod.has(id) && admin.has(id), `${id} is for admins`);
  assert.ok(admin.size >= mod.size && mod.size >= member.size);
  assert.ok(admin.size <= 20, 'every tile fits on the home screen');
  for (const user of [IDS.member, IDS.mod, IDS.admin]) {
    for (const id of await tiles(user)) {
      const ans = await h.click(`yo:system:open:${id}`, { user });
      const text = h.textOf(ans[ans.length - 1]);
      assert.ok(text.length > 0, `${id} panel answers for ${user}`);
      assert.doesNotMatch(text, /Something went wrong|Needs (Mod|Admin)/, `${id} panel for ${user}: ${text}`);
    }
  }
});

test('a giveaway with a level requirement reads levels from the Levels app', async () => {
  const h = await all();
  await h.slash('giveaway', '1d 1 Prize level 5', { user: IDS.mod });
  const card = withId(h, ':enter:');
  assert.ok(card, 'the giveaway card was posted');
  let ans = await press(h, card, /:enter:/, IDS.member);
  assert.match(lastText(h, ans), /level 5/);
  await h.slash('levels', 'set @sam 6', { user: IDS.owner });
  ans = await press(h, card, /:enter:/, IDS.member);
  assert.match(lastText(h, ans), /You're in!/);
  await h.advance(DAY);
  await settle();
  assert.match(h.textOf(live(h, card.id)), /Winners?/);
  assert.ok(h.sent(G).some((m) => /Congratulations <@a0000000-0000-4000-8000-000000000004>/.test(m.content || '')), 'Sam is announced');
});

test('a bet game pays out through the real Economy app', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await all();
  const eco = h.engine.service('economy');
  eco.add(S, IDS.member, 200, 'seed');
  eco.add(S, IDS.member2, 200, 'seed');
  const msg = replyMsg(await h.slash('game', `rps <@${IDS.member2}> bet 50`, { user: IDS.member }));
  assert.ok(msg, 'challenge posted');
  await press(h, msg, 'Accept', IDS.member2);
  assert.equal(eco.balance(S, IDS.member), 150);
  assert.equal(eco.balance(S, IDS.member2), 150);
  await press(h, msg, 'Rock', IDS.member);
  await press(h, msg, 'Scissors', IDS.member2);
  assert.equal(eco.balance(S, IDS.member), 250);
  assert.equal(eco.balance(S, IDS.member2), 150);
  const wallet = await h.slash('balance', '', { user: IDS.member });
  assert.match(h.textOf(wallet[wallet.length - 1]), /250/);
});

test('automod times out through the Mod app with a real case and log entry', async () => {
  const h = await all();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  const cfg = h.engine.settings.appConfig(S, 'automod');
  h.engine.settings.patchApp(S, 'automod', { actions: { ...cfg.actions, spam: 'timeout' } });
  for (let i = 0; i < 7; i++) await h.message(`flood ${i}`);
  await settle();
  const timeouts = h.fake.calls.filter((c) => c.method !== 'GET' && /timeout/.test(c.path));
  assert.ok(timeouts.length >= 1, `a timeout call was made: ${h.fake.calls.map((c) => `${c.method} ${c.path}`).join(', ')}`);
  const cases = await h.slash('case', '1', { user: IDS.mod });
  assert.match(lastText(h, cases), /Timeout/);
  assert.ok(h.sent(IDS.channels.modlog).length >= 1, 'something reached the log channel');
});

test('Pocket and Studio each answer only their own words in DMs', async () => {
  const h = await all();
  const dmOf = (u) => `d${u.slice(1)}`;
  const dmText = (u) => h.sent(dmOf(u)).map((m) => h.textOf(m)).join('\n---\n');
  await h.dm('remind in 2h stretch', { user: IDS.member });
  assert.match(dmText(IDS.member), /Reminder #1 set/);
  assert.equal(h.engine.scheduler.list({ kind: 'pocket.remind', userId: IDS.member }).length, 1);
  const pic = { path: 'abc/pic.png', name: 'pic.png', size: 1234, width: 800, height: 600 };
  const before = h.sent(dmOf(IDS.member2)).length;
  await h.dm('caption hello there', { user: IDS.member2, attachments: [pic] });
  const answered = () => h.sent(dmOf(IDS.member2)).length > before || h.fake.calls.some((c) => /typing|files/.test(c.path));
  for (let i = 0; i < 100 && !answered(); i++) await settle(20);
  const after = h.sent(dmOf(IDS.member2)).slice(before).map((m) => h.textOf(m)).join('\n');
  assert.doesNotMatch(after, /YapOS Pocket|What you can type here/, 'Pocket does not answer caption');
  assert.ok(h.sent(dmOf(IDS.member2)).length > before || h.fake.calls.some((c) => /typing|files/.test(c.path)), 'Studio answered caption');
  const pocketWords = ['remind', 'note', 'notes', 'todo', 'todos', 'afk', 'pocket', 'help', 'tz'];
  const studioWords = ['caption', 'gif', 'studio'];
  const claims = (word) => h.engine.dmRoutes.filter((r) => { try { return r.match({ content: word === 'studio' ? word : `${word} x`, attachments: [pic] }); } catch { return false; } }).map((r) => r.app);
  for (const w of pocketWords) assert.deepEqual(claims(w).slice(0, 1), ['pocket'], `${w} goes to Pocket`);
  for (const w of studioWords) assert.deepEqual(claims(w).slice(0, 1), ['studio'], `${w} goes to Studio`);
});

test('tags never take over real commands', async () => {
  const h = await all();
  for (const name of ['ban', 'daily', 'remind', 'menu', 'poll']) {
    const ans = await h.slash('tag', `add ${name} Hijacked!`, { user: IDS.mod });
    assert.doesNotMatch(lastText(h, ans), /Tag saved|saved/i, `a tag named ${name} is refused`);
  }
  await h.slash('tag', 'add rules Be nice.', { user: IDS.mod });
  await h.message('!rules', { user: IDS.member });
  assert.ok(h.sent(G).some((m) => /Be nice\./.test(m.content || h.textOf(m))), 'the tag posts');
  const posts = h.sent(G).length;
  await h.message('!daily', { user: IDS.member2 });
  assert.ok(!h.sent(G).slice(posts).some((m) => /Hijacked/.test(h.textOf(m))));
  assert.match(h.textOf(h.lastSent(G)), /Shards|💎/, '!daily still runs Economy');
});

test('jobs from every app survive a restart and run on the new copy', async () => {
  const a = await all();
  a.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.ban_members = true;
  a.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await a.slash('ban', `<@${IDS.member2}> 1d spamming`, { user: IDS.mod });
  assert.equal(a.fake.state.bans[S].length, 1);
  await a.slash('giveaway', '2h 1 Restart prize', { user: IDS.mod });
  await a.slash('poll', 'Lunch? | Tacos | Sushi 3h', { user: IDS.member });
  await a.slash('remind', 'in 5h stretch', { user: IDS.member });
  await a.slash('schedule', `<#${NEWS}> daily 18:00 Evening news`, { user: IDS.admin });
  const kinds = new Set(a.engine.scheduler.list().map((j) => j.kind));
  for (const k of ['mod.unban', 'engage.giveawayend', 'engage.pollend', 'pocket.remind', 'tools.post']) assert.ok(kinds.has(k), `${k} is scheduled; have ${[...kinds].join(', ')}`);
  a.engine.scheduler.stop();
  await a.store.flush();

  const b = await all({ store: a.store });
  b.fake.state.messages = a.fake.state.messages;
  b.fake.state.bans = a.fake.state.bans;
  b.fake.state.dms = a.fake.state.dms;
  b.clock.t = a.clock.t;
  const left = new Set(b.engine.scheduler.list().map((j) => j.kind));
  for (const k of kinds) assert.ok(left.has(k), `${k} came back after the restart`);
  await b.advance(DAY + HOUR);
  await settle();
  assert.equal(b.fake.state.bans[S].length, 0, 'the temporary ban ended');
  const giveaway = withId(b, ':enter:');
  assert.match(b.textOf(live(b, giveaway.id)), /Ended|ended|No winners|Winners/);
  const poll = withId(b, ':vote:');
  assert.match(b.textOf(live(b, poll.id)), /Poll ended|ended/);
  const dm = `d${IDS.member.slice(1)}`;
  assert.ok(b.sent(dm).some((m) => /stretch/.test(b.textOf(m))), 'the reminder arrived');
  assert.ok(b.sent(NEWS).some((m) => /Evening news/.test(b.textOf(m))), 'the scheduled post went out');
  const after = new Set(b.engine.scheduler.list().map((j) => j.kind));
  for (const k of ['mod.unban', 'engage.giveawayend', 'engage.pollend', 'pocket.remind']) assert.ok(!after.has(k), `${k} finished`);
  assert.ok(after.has('tools.post'), 'the daily post stays scheduled');
  assert.equal(b.engine.scheduler.stats().waiting, 0, 'every job has a handler');
});

test('uninstalling Games gives held bets back right away', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await all();
  const eco = h.engine.service('economy');
  eco.add(S, IDS.member, 100, 'seed');
  eco.add(S, IDS.member2, 100, 'seed');
  const msg = replyMsg(await h.slash('game', `ttt <@${IDS.member2}> bet 40`, { user: IDS.member }));
  await press(h, msg, 'Accept', IDS.member2);
  assert.equal(eco.balance(S, IDS.member), 60);
  await h.click('yo:system:toggle:games:off', { user: IDS.admin });
  await settle();
  await h.runDue();
  assert.equal(eco.balance(S, IDS.member), 100, 'no three-minute wait');
  assert.equal(eco.balance(S, IDS.member2), 100);
  assert.match(h.textOf(live(h, msg.id)), /uninstalled/);
});

test('installing Mod again lifts a ban that ended while it was off, right away', async () => {
  const h = await all();
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.ban_members = true;
  await h.slash('ban', `<@${IDS.member2}> 1h spamming`, { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 1);
  h.engine.settings.setEnabled(S, 'mod', false);
  await h.advance(2 * HOUR);
  assert.equal(h.fake.state.bans[S].length, 1, 'still banned while Mod is off');
  h.engine.settings.setEnabled(S, 'mod', true);
  await settle();
  await h.runDue();
  assert.equal(h.fake.state.bans[S].length, 0, 'lifted without waiting 6 hours');
});