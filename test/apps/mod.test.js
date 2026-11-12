import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';

const S = IDS.server;
const G = IDS.channels.general;
const tkey = (uid) => `${S}:${uid}`;
const make = (opts = {}) => createHarness({ apps: ['mod'], ...opts });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);

test('mod commands fit Yapin limits and stay few', async () => {
  const h = await make();
  const mine = ['mod', 'warn', 'timeout', 'kick', 'ban', 'purge', 'lock', 'unlock', 'case'];
  for (const name of mine) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length <= 100 && c.description.length > 0);
  }
  assert.ok(h.engine.service('mod'), 'mod service is shared');
});

test('timeout via slash with a duration and reason', async () => {
  const h = await make();
  const ans = await h.slash('mod', 'timeout @sam 10m spamming links', { user: IDS.mod });
  const t = h.fake.state.timeouts[tkey(IDS.member)];
  assert.ok(t, 'timed out');
  assert.equal(t.minutes, 10);
  assert.equal(t.reason, 'spamming links');
  const text = lastText(h, ans);
  assert.match(text, /Timed out/);
  assert.match(text, /@sam/);
  assert.match(text, /Case #1/);
  assert.ok(h.findButton('Undo', ans), 'has an undo button');
});

test('timeout via typed chat and the /timeout shortcut', async () => {
  const h = await make();
  await h.message(`!mod timeout <@${IDS.member}> 2h being rude`, { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 120);
  assert.match(h.textOf(h.lastSent(G)), /Timed out/);
  await h.message('/timeout riley 5', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 5);
});

test('duration parsing: bare minutes, clamp to 28 days, off clears, no length asks', async () => {
  const h = await make();
  await h.slash('timeout', '@sam 90', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 90);
  const big = await h.slash('timeout', '@sam 60d', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 40320);
  assert.match(lastText(h, big), /28 days/);
  await h.slash('timeout', '@sam off', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  const asked = await h.slash('timeout', '@riley talking over people', { user: IDS.mod });
  assert.match(lastText(h, asked), /How long should @riley be timed out\?/);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined);
  await h.clickButton('10m', { user: IDS.mod, in: asked });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 10);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].reason, 'talking over people');
  await h.slash('mod', 'untimeout @riley', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined);
});

test('timeout without a length asks, and each answer button works', async () => {
  const h = await make();
  const asked = await h.slash('timeout', '@riley', { user: IDS.mod });
  const text = lastText(h, asked);
  assert.match(text, /How long should @riley be timed out\?/);
  for (const label of ['10m', '1h', '1d', '1w', 'Cancel']) assert.ok(h.findButton(label, asked), label);
  assert.equal(h.fake.callsTo('POST', /timeouts/).length, 0, 'nothing happens before a length is picked');
  assert.equal(h.engine.store.get('mod', S)?.cases?.length ?? 0, 0);
  const done = await h.clickButton('1h', { user: IDS.mod, in: asked });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 60);
  assert.match(lastText(h, done), /Timed out/);
  assert.ok(h.findButton('Undo', done), 'the result still has Undo');
  const again = await h.click(h.findButton('1d', asked).custom_id, { user: IDS.mod });
  assert.match(lastText(h, again), /expired/);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 60, 'a second press does nothing');

  const week = await h.message('!timeout riley being loud', { user: IDS.mod });
  assert.ok(week);
  const prompt = h.lastSent(G);
  assert.match(h.textOf(prompt), /How long/);
  await h.clickButton('1w', { user: IDS.mod, in: [prompt] });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 10080);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].reason, 'being loud');
});

test('timeout length buttons belong to the asker and keep every check', async () => {
  const h = await make();
  const asked = await h.slash('timeout', '@sam', { user: IDS.mod });
  const b = h.findButton('1h', asked);
  const other = await h.click(b.custom_id, { user: IDS.admin });
  assert.match(lastText(h, other), /expired/);
  const member = await h.click(b.custom_id, { user: IDS.member2 });
  assert.match(lastText(h, member), /Only moderators/);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  const cancel = await h.clickButton('Cancel', { user: IDS.mod, in: asked });
  assert.match(lastText(h, cancel), /Cancelled/);
  assert.equal(h.fake.callsTo('POST', /timeouts/).length, 0);
  const admin = await h.slash('timeout', '@alex', { user: IDS.mod });
  assert.match(lastText(h, admin), /above|admin/);
  assert.equal(h.findButton('1h', admin), null, 'no question when they could not do it anyway');
});

test('"forever" gets the 28 day limit and the same buttons', async () => {
  const h = await make();
  const ans = await h.slash('timeout', 'riley forever spam', { user: IDS.mod });
  const text = lastText(h, ans);
  assert.match(text, /I can't time someone out forever\. The longest is 28 days\./);
  assert.match(text, /spam/);
  assert.doesNotMatch(text, /Reason:\*\* forever/);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined);
  await h.clickButton('1d', { user: IDS.mod, in: ans });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 1440);
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].reason, 'spam');
  for (const clear of ['off', '0', 'clear']) {
    await h.slash('timeout', `riley ${clear}`, { user: IDS.mod });
    assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined, clear);
    await h.slash('timeout', 'riley 5', { user: IDS.mod });
  }
});

test('slowmode without a length asks, and odd lengths are explained', async () => {
  const h = await make();
  const asked = await h.slash('mod', 'slowmode', { user: IDS.mod });
  assert.match(lastText(h, asked), /How long should people in/);
  assert.equal(h.fake.channelById(G).slowmode, 0);
  await h.clickButton('30s', { user: IDS.mod, in: asked });
  assert.equal(h.fake.channelById(G).slowmode, 30);
  const forever = await h.slash('mod', 'slowmode forever', { user: IDS.mod });
  assert.match(lastText(h, forever), /6 hours/);
  const off = await h.clickButton('Off', { user: IDS.mod, in: forever });
  assert.match(lastText(h, off), /Slowmode off/);
  assert.equal(h.fake.channelById(G).slowmode, 0);
  const odd = await h.slash('mod', 'slowmode soonish', { user: IDS.mod });
  assert.match(lastText(h, odd), /didn't understand \*\*soonish\*\*/);
  await h.clickButton('Cancel', { user: IDS.mod, in: odd });
  assert.equal(h.fake.channelById(G).slowmode, 0);
});

test('lock and unlock take a plain channel name', async () => {
  const h = await make();
  const N = IDS.channels.news;
  h.fake.channelById(N).name = '📢・announcements';
  h.engine.cache.invalidate(S);
  const ans = await h.slash('lock', 'announcements raid incoming', { user: IDS.mod });
  assert.match(lastText(h, ans), /Channel locked/);
  assert.deepEqual(h.fake.state.overrides[`${N}:everyone`].deny, ['send_messages']);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined, 'the current channel is untouched');
  const c = h.engine.store.get('mod', S).cases.at(-1);
  assert.equal(c.reason, 'raid incoming');
  assert.equal(c.channelId, N);
  const un = await h.slash('unlock', 'Announcements', { user: IDS.mod });
  assert.match(lastText(h, un), /Channel unlocked/);
  assert.equal(h.fake.state.overrides[`${N}:everyone`], undefined);
});

test('a close channel name asks before locking', async () => {
  const h = await make();
  const N = IDS.channels.news;
  const ans = await h.slash('lock', 'anouncements spam wave', { user: IDS.mod });
  assert.match(lastText(h, ans), /Did you mean #announcements\?/);
  for (const label of ['Lock #announcements', 'Lock this channel', 'Cancel']) assert.ok(h.findButton(label, ans), label);
  assert.equal(h.fake.state.overrides[`${N}:everyone`], undefined);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
  const forged = await h.click(h.findButton('Lock #announcements', ans).custom_id, { user: IDS.admin });
  assert.match(lastText(h, forged), /expired/);
  await h.clickButton('Lock #announcements', { user: IDS.mod, in: ans });
  assert.deepEqual(h.fake.state.overrides[`${N}:everyone`].deny, ['send_messages']);
  assert.equal(h.engine.store.get('mod', S).cases.at(-1).reason, 'spam wave');

  const here = await h.slash('lock', 'anouncements', { user: IDS.mod });
  await h.clickButton('Lock this channel', { user: IDS.mod, in: here });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`].deny, ['send_messages']);
  assert.equal(h.engine.store.get('mod', S).cases.at(-1).reason, 'anouncements');

  const unAsk = await h.slash('unlock', 'anouncements', { user: IDS.mod });
  assert.ok(h.findButton('Unlock #announcements', unAsk));
  await h.clickButton('Cancel', { user: IDS.mod, in: unAsk });
  assert.ok(h.fake.state.overrides[`${N}:everyone`], 'cancel keeps it locked');
  const unAgain = await h.slash('unlock', 'anouncements', { user: IDS.mod });
  await h.clickButton('Unlock #announcements', { user: IDS.mod, in: unAgain });
  assert.equal(h.fake.state.overrides[`${N}:everyone`], undefined);
});

test('a lock reason that is not a channel name still locks this channel', async () => {
  const h = await make();
  const ans = await h.slash('lock', 'calm down please', { user: IDS.mod });
  assert.match(lastText(h, ans), /Channel locked/);
  assert.equal(h.findButton('Lock this channel', ans), null);
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`].deny, ['send_messages']);
  assert.equal(h.engine.store.get('mod', S).cases.at(-1).reason, 'calm down please');
});

test('Undo buttons carry a hint for doing it by hand', async () => {
  const h = await make();
  giveModBan(h);
  const seen = [];
  const real = h.engine.router.addUndo;
  h.engine.router.addUndo = (opts) => { seen.push(opts); return real(opts); };
  await h.slash('ban', '@sam spam', { user: IDS.mod });
  await h.slash('timeout', '@riley 1h', { user: IDS.mod });
  await h.slash('lock', 'announcements', { user: IDS.mod });
  await h.slash('warn', '@riley rude', { user: IDS.mod });
  await h.slash('mod', 'slowmode 10s', { user: IDS.mod });
  await h.slash('mod', 'slowmode 1m', { user: IDS.mod });
  assert.deepEqual(seen.map((o) => o.manual), [
    `/mod unban ${IDS.member}`,
    '/mod untimeout @riley',
    '/unlock #announcements',
    '/mod warnings @riley',
    '/mod slowmode #general off',
    '/mod slowmode #general 10s',
  ]);
});

test('timeout Undo clears it', async () => {
  const h = await make();
  const ans = await h.slash('timeout', '@sam 1h', { user: IDS.mod });
  await h.clickButton('Undo', { user: IDS.mod, in: ans });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
});

test('hierarchy: a mod cannot touch an admin', async () => {
  const h = await make();
  const ans = await h.slash('mod', 'timeout @alex 10m', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.admin)], undefined);
  assert.match(lastText(h, ans), /above/);
  assert.equal(h.fake.callsTo('POST', /timeouts/).length, 0);
  const owner = await h.slash('kick', '@jolli', { user: IDS.admin });
  assert.match(lastText(h, owner), /server owner/);
});

test('members cannot use mod commands', async () => {
  const h = await make();
  const ans = await h.slash('ban', '@riley', { user: IDS.member });
  assert.match(lastText(h, ans), /Only moderators/);
  assert.equal(h.fake.state.bans[S].length, 0);
  const hub = await h.slash('mod', '', { user: IDS.member });
  assert.match(lastText(h, hub), /Only moderators/);
  const yap = await h.slash('yap', 'kick @riley', { user: IDS.member });
  assert.match(lastText(h, yap), /Only moderators/);
  assert.ok(h.fake.memberOf(S, IDS.member2), 'still here');
});

test('ban, then Undo unbans', async () => {
  const h = await make();
  giveModBan(h);
  const ans = await h.slash('ban', '@sam raiding', { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 1);
  assert.match(lastText(h, ans), /Banned/);
  assert.ok(Object.keys(h.fake.state.dms).length, 'DMed them first');
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: ans });
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.match(h.textOf(undo[undo.length - 1]), /unbanned/);
  const c = await h.slash('case', '1', { user: IDS.mod });
  assert.match(lastText(h, c), /Undone/);
});

test('DM failure is noted but the action still happens', async () => {
  const h = await make({ features: { dms: false } });
  const ans = await h.slash('kick', '@sam', { user: IDS.mod });
  assert.equal(h.fake.memberOf(S, IDS.member), null);
  assert.match(lastText(h, ans), /couldn't DM them/);
});

test('warnings escalate to a timeout at 3', async () => {
  const h = await make();
  await h.slash('warn', '@sam one', { user: IDS.mod });
  await h.message(`!warn <@${IDS.member}> two`, { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  const third = await h.slash('mod', 'warn sam three', { user: IDS.mod });
  const t = h.fake.state.timeouts[tkey(IDS.member)];
  assert.ok(t, 'timed out at 3 warnings');
  assert.equal(t.minutes, 60);
  assert.match(lastText(h, third), /3\*\* warnings/);
  assert.match(lastText(h, third), /timed them out/);
  const list = await h.slash('mod', 'warnings @sam', { user: IDS.mod });
  assert.match(lastText(h, list), /3 active warnings/);
  await h.clickButton('Undo', { user: IDS.mod, in: third });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined, 'undoing the warn clears its timeout');
  const after = await h.slash('mod', 'warnings @sam', { user: IDS.mod });
  assert.match(lastText(h, after), /2 active warnings/);
});

test('old warnings decay and the service contract works for other apps', async () => {
  const h = await make();
  const mod = h.engine.service('mod');
  const r1 = await mod.warn(S, IDS.member, { actorId: IDS.bot, reason: 'caps', source: 'automod' });
  assert.equal(r1.count, 1);
  assert.equal(r1.escalated, null);
  assert.equal(typeof r1.case.id, 'number');
  h.engine.store.update('mod', S, (d) => { d.warns[0].at -= 40 * 864e5; });
  const r2 = await mod.warn(S, IDS.member, { actorId: IDS.bot, reason: 'caps', source: 'automod' });
  assert.equal(r2.count, 1, 'the 40 day old warning no longer counts');
  const c = await mod.timeout(S, IDS.member2, { actorId: IDS.bot, durationMs: 5 * 60000, reason: 'flood', source: 'automod' });
  assert.equal(c.action, 'timeout');
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 5);
  const added = await mod.addCase(S, { action: 'warn', targetId: IDS.member, actorId: IDS.mod, reason: 'note', source: 'manual' });
  assert.equal(added.id, c.id + 1);
});

test('purge with a user filter deletes only their messages, answering first', async () => {
  const h = await make();
  for (let i = 0; i < 4; i++) h.fake.addUserMessage(G, IDS.member, `sam ${i}`);
  for (let i = 0; i < 3; i++) h.fake.addUserMessage(G, IDS.member2, `riley ${i}`);
  const ans = await h.slash('purge', '10 @sam', { user: IDS.mod });
  const left = h.fake.messagesIn(G);
  assert.equal(left.filter((m) => m.author_id === IDS.member).length, 0);
  assert.equal(left.filter((m) => m.author_id === IDS.member2).length, 3);
  assert.match(h.textOf(ans[0]), /Clearing messages/);
  assert.match(lastText(h, ans), /Cleared 4 messages/);
});

test('purge reports skipped messages', async () => {
  const h = await make();
  for (let i = 0; i < 3; i++) h.fake.addUserMessage(G, IDS.member, `hi ${i}`);
  const realBulk = h.bot.bulkDelete.bind(h.bot);
  h.bot.bulkDelete = async (ch, ids) => { const out = await realBulk(ch, ids.slice(1)); return { ...out, skipped: [ids[0]] }; };
  const ans = await h.slash('mod', 'purge 3', { user: IDS.mod });
  assert.match(lastText(h, ans), /Cleared 2 messages/);
  assert.match(lastText(h, ans), /14 days/);
});

test('lock and unlock with a permission override', async () => {
  const h = await make();
  const ans = await h.slash('lock', 'raid in progress', { user: IDS.mod });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`], { allow: [], deny: ['send_messages'] });
  assert.match(lastText(h, ans), /permission override/);
  await h.slash('unlock', '', { user: IDS.mod });
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
});

test('lock keeps an existing override and Undo restores it', async () => {
  const h = await make();
  h.fake.state.overrides[`${G}:everyone`] = { allow: ['add_reactions'], deny: ['attach_files'] };
  const ans = await h.slash('mod', 'lock', { user: IDS.mod });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`], { allow: ['add_reactions'], deny: ['attach_files', 'send_messages'] });
  await h.clickButton('Undo', { user: IDS.mod, in: ans });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`], { allow: ['add_reactions'], deny: ['attach_files'] });
});

test('lock falls back to read-only when overrides are not available', async () => {
  const h = await make({ features: { roles: false } });
  const ans = await h.slash('lock', '', { user: IDS.mod });
  assert.equal(h.fake.channelById(G).read_only, true);
  assert.match(lastText(h, ans), /read-only instead/);
  const un = await h.slash('unlock', '', { user: IDS.mod });
  assert.equal(h.fake.channelById(G).read_only, false);
  assert.match(lastText(h, un), /unlocked/);
});

test('slowmode sets, clamps, turns off, and Undo restores', async () => {
  const h = await make();
  await h.slash('mod', 'slowmode 10s', { user: IDS.mod });
  assert.equal(h.fake.channelById(G).slowmode, 10);
  const ans = await h.slash('mod', 'slowmode 12h', { user: IDS.mod });
  assert.equal(h.fake.channelById(G).slowmode, 21600);
  await h.clickButton('Undo', { user: IDS.mod, in: ans });
  assert.equal(h.fake.channelById(G).slowmode, 10);
  await h.slash('mod', 'slowmode off', { user: IDS.mod });
  assert.equal(h.fake.channelById(G).slowmode, 0);
});

test('friendly 403 text when Yapin refuses', async () => {
  const h = await make();
  giveModBan(h);
  h.fake.fail('POST', /\/bans$/, { status: 403 });
  const ans = await h.slash('ban', '@sam', { user: IDS.mod });
  const text = lastText(h, ans);
  assert.match(text, /I couldn't ban @sam/);
  assert.match(text, /Ban Members/);
  assert.doesNotMatch(text, /403/);
});

test('missing bot permission is explained before trying', async () => {
  const h = await make();
  const botRole = h.fake.state.roles[S].find((r) => r.id === IDS.roles.bot);
  botRole.perms.ban_members = false;
  const ans = await h.slash('ban', '@sam', { user: IDS.mod });
  assert.match(lastText(h, ans), /Ban Members/);
  assert.equal(h.fake.callsTo('POST', /\/bans$/).length, 0);
});

test('case lookup shows one case, recent cases list, and missing ones', async () => {
  const h = await make();
  await h.slash('warn', '@sam spam', { user: IDS.mod });
  await h.slash('timeout', '@riley 15m flood', { user: IDS.mod });
  const one = await h.slash('case', '2', { user: IDS.mod });
  const text = lastText(h, one);
  assert.match(text, /Case #2/);
  assert.match(text, /Timeout/);
  assert.match(text, /@riley/);
  assert.match(text, /flood/);
  const typed = await h.message('!mod case 1', { user: IDS.mod });
  void typed;
  assert.match(h.textOf(h.lastSent(G)), /Case #1/);
  const none = await h.slash('case', '99', { user: IDS.mod });
  assert.match(lastText(h, none), /No case #99/);
  const recent = await h.slash('case', '', { user: IDS.mod });
  assert.match(lastText(h, recent), /Recent cases/);
});

test('actions are logged to the log channel', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('kick', '@sam left mean notes', { user: IDS.mod });
  await settle(10);
  const logged = h.sent(IDS.channels.modlog);
  assert.ok(logged.length, 'posted to mod-log');
  assert.match(h.textOf(logged[logged.length - 1]), /Kick/);
});

test('hub panel, unknown subcommand hint, and settings', async () => {
  const h = await make();
  const panel = await h.slash('mod', '', { user: IDS.mod });
  assert.match(lastText(h, panel), /Active warnings/);
  assert.ok(h.findButton('Lock this channel', panel));
  const typo = await h.slash('mod', 'timout @sam', { user: IDS.mod });
  assert.match(lastText(h, typo), /Did you mean \*\*timeout\*\*/);
  const settings = await h.slash('mod', 'settings', { user: IDS.admin });
  assert.match(lastText(h, settings), /Automatic steps/);
  await h.clickButton('Turn DMs off', { user: IDS.admin, in: settings });
  assert.equal(h.engine.settings.appConfig(S, 'mod').dmOnAction, false);
  await h.submit('yo:mod:rulesave', { days: '14', steps: '2 timeout 30m, 4 ban' }, { user: IDS.admin });
  const cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.warnDecayDays, 14);
  assert.deepEqual(cfg.escalation, [{ at: 2, action: 'timeout', durationMs: 1800000 }, { at: 4, action: 'ban' }]);
});

test('panel buttons lock the channel the click came from', async () => {
  const h = await make();
  await h.click('yo:mod:lock', { user: IDS.mod });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`].deny, ['send_messages']);
  const denied = await h.click('yo:mod:unlock', { user: IDS.member });
  assert.match(lastText(h, denied), /Only moderators/);
  await h.click('yo:mod:unlock', { user: IDS.mod });
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
});

test('yap words route to mod actions', async () => {
  const h = await make();
  await h.slash('yap', 'mute @sam 20m', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 20);
});

test('presets set the log channel and community gets stricter warnings', async () => {
  const h = await make();
  const app = h.engine.apps.get('mod');
  const channels = await h.engine.detectChannels(S);
  const line = await app.def.applyPreset(h.engine, S, { preset: 'community', channels });
  assert.equal(h.engine.settings.core(S).logChannel, IDS.channels.modlog);
  assert.equal(h.engine.settings.appConfig(S, 'mod').escalation[0].at, 2);
  assert.match(line, /mod-log/);
});

test('lock Undo after a manual unlock says it is already open', async () => {
  const h = await make();
  const ans = await h.slash('lock', '', { user: IDS.mod });
  await h.slash('unlock', '', { user: IDS.mod });
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: ans });
  const text = h.textOf(undo[undo.length - 1]);
  assert.match(text, /Already unlocked/);
  assert.doesNotMatch(text, /Something went wrong/);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
});

test('warn Undo keeps the escalation case open when clearing the timeout fails', async () => {
  const h = await make();
  await h.slash('warn', '@sam one', { user: IDS.mod });
  await h.slash('warn', '@sam two', { user: IDS.mod });
  const third = await h.slash('warn', '@sam three', { user: IDS.mod });
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)]);
  h.fake.fail('POST', /timeouts/, { status: 403 });
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: third });
  assert.match(h.textOf(undo[undo.length - 1]), /couldn't clear the timeout/);
  const cases = h.engine.store.get('mod', S).cases;
  const esc = cases.find((c) => c.action === 'timeout');
  assert.ok(!esc.undone, 'the timeout case is not marked undone');
  assert.ok(cases.find((c) => c.id === 3).undone, 'the warning itself is undone');
});

test('stored warnings stay bounded', async () => {
  const h = await make();
  const old = Date.now() - 400 * 864e5;
  h.engine.store.set('mod', S, { seq: 0, cases: [], locks: {}, warns: Array.from({ length: 2000 }, (_, i) => ({ caseId: -i, targetId: IDS.member2, at: old, reason: '' })) });
  await h.engine.service('mod').warn(S, IDS.member, { actorId: IDS.mod, reason: 'x', source: 'mod' });
  const warns = h.engine.store.get('mod', S).warns;
  assert.equal(warns.length, 2000);
  assert.equal(warns[warns.length - 1].targetId, IDS.member);
});

test('warning rules form fits modal limits even with a long rule list', async () => {
  const h = await make();
  const many = Array.from({ length: 80 }, (_, i) => ({ at: i + 1, action: 'timeout', durationMs: 3600000 * (i + 1) }));
  h.engine.settings.patchApp(S, 'mod', { escalation: many });
  const ans = await h.click('yo:mod:rules', { user: IDS.admin });
  const modal = ans.find((a) => a.type === 'modal');
  assert.ok(modal, 'opened as a pop-up form');
  const fields = modal.modal?.components || modal.components;
  for (const f of fields) {
    assert.ok(f.label.length <= 45, `label fits: ${f.label}`);
    if (f.value && f.max_length) assert.ok(f.value.length <= f.max_length);
  }
  assert.notEqual(h.engine.caps.state(S, 'modals'), false);
});

test('only admins can save warning rules', async () => {
  const h = await make();
  const ans = await h.submit('yo:mod:rulesave', { days: '1', steps: '1 ban' }, { user: IDS.mod });
  assert.match(lastText(h, ans), /Only admins/);
  assert.equal(h.engine.settings.appConfig(S, 'mod').warnDecayDays, 30);
});

test('lock understands an @everyone override keyed by the server id', async () => {
  const h = await make();
  h.bot.channelPermissions = async () => [{ role_id: S, allow: [], deny: ['send_messages'] }];
  const ans = await h.slash('lock', '', { user: IDS.mod });
  assert.match(lastText(h, ans), /Already locked/);
  assert.equal(h.fake.callsTo('PUT', /permissions/).length, 0);
});

function giveModBan(h) {
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.ban_members = true;
}

test('a mod without Ban Members cannot ban through the bot', async () => {
  const h = await make();
  const ans = await h.slash('ban', '@sam', { user: IDS.mod });
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.match(lastText(h, ans), /You need \*\*Ban Members\*\*/);
});

test('a role picked as a mod role in setup can use every action', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { modRoles: [IDS.roles.vip] });
  h.fake.memberOf(S, IDS.member2).roles.push(IDS.roles.vip);
  await h.slash('ban', '@sam', { user: IDS.member2 });
  assert.equal(h.fake.state.bans[S].length, 1);
});
const panelId = (ans) => ans.map((a) => a.message?.id).filter(Boolean).pop();
const MOD_BUTTONS = ['home', 'cases', 'settings', 'lock', 'unlock', 'purge:10', 'lookup', `uwarn:${IDS.member2}`, `uto:${IDS.member2}`, `uban:${IDS.member2}`, 'blen:x:perm'];
const ADMIN_BUTTONS = ['dm', 'rules'];

test('a plain member cannot open the Mod panel from the home screen or /yap', async () => {
  const h = await make();
  await h.slash('warn', '@riley secret reason', { user: IDS.mod });
  const home = await h.slash('menu', '', { user: IDS.member });
  const tile = h.allButtons(home).find((b) => /open:mod$/.test(b.custom_id));
  const viaTile = await h.click(tile ? tile.custom_id : 'yo:system:open:mod', { user: IDS.member, messageId: tile?.messageId ?? null });
  assert.match(lastText(h, viaTile), /Only moderators/);
  assert.doesNotMatch(lastText(h, viaTile), /secret reason|Lock this channel/);
  const forged = await h.click('yo:system:open:mod', { user: IDS.member });
  assert.match(lastText(h, forged), /Only moderators/);
  const yap = await h.slash('yap', 'mod', { user: IDS.member });
  assert.match(lastText(h, yap), /Only moderators/);
  assert.doesNotMatch(lastText(h, yap), /secret reason/);
  const staffOpen = await h.click('yo:system:open:mod', { user: IDS.mod });
  assert.match(lastText(h, staffOpen), /Active warnings/);
});

test('nobody else can press buttons on a mod panel, not even another mod', async () => {
  const h = await make();
  h.fake.addUserMessage(G, IDS.member2, 'keep me');
  const panel = await h.slash('mod', '', { user: IDS.mod });
  const messageId = panelId(panel);
  assert.ok(messageId, 'the panel is a real message');
  for (const action of MOD_BUTTONS) {
    for (const user of [IDS.member, IDS.admin]) {
      const ans = await h.click(`yo:mod:${action}`, { user, messageId });
      assert.match(lastText(h, ans), /Not your panel/, `${action} is locked to the opener`);
    }
  }
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
  assert.equal(h.fake.messagesIn(G).filter((m) => m.author_id === IDS.member2).length, 1);
  await h.click('yo:mod:lock', { user: IDS.mod, messageId });
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`].deny, ['send_messages']);
});

test('forged or leftover mod buttons are refused by role', async () => {
  const h = await make();
  h.fake.addUserMessage(G, IDS.member2, 'keep me');
  await h.slash('warn', '@riley private note', { user: IDS.mod });
  for (const action of MOD_BUTTONS) {
    const ans = await h.click(`yo:mod:${action}`, { user: IDS.member });
    assert.match(lastText(h, ans), /Only moderators/, `${action} needs a mod`);
    assert.doesNotMatch(lastText(h, ans), /private note/);
  }
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
  assert.equal(h.fake.messagesIn(G).filter((m) => m.author_id === IDS.member2).length, 1);
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0);
});

test('settings buttons: locked to the admin who opened them and admin only when forged', async () => {
  const h = await make();
  const settings = await h.slash('mod', 'settings', { user: IDS.admin });
  const messageId = panelId(settings);
  for (const action of ADMIN_BUTTONS) {
    for (const user of [IDS.member, IDS.mod]) {
      const locked = await h.click(`yo:mod:${action}`, { user, messageId });
      assert.match(lastText(h, locked), /Not your panel/);
      const forged = await h.click(`yo:mod:${action}`, { user });
      assert.match(lastText(h, forged), /Only admins/);
      assert.ok(!forged.some((a) => a.type === 'modal'), 'no form opens');
    }
  }
  const save = await h.submit('yo:mod:rulesave', { days: '1', steps: '1 ban' }, { user: IDS.member });
  assert.match(lastText(h, save), /Only admins/);
  const lockedSave = await h.submit('yo:mod:rulesave', { days: '1', steps: '1 ban' }, { user: IDS.mod, messageId });
  assert.match(lastText(h, lockedSave), /Not your panel/);
  const cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.dmOnAction, true);
  assert.equal(cfg.warnDecayDays, 30);
  const modView = await h.slash('mod', 'settings', { user: IDS.mod });
  const modPress = await h.clickButton('Turn DMs off', { user: IDS.mod, in: modView });
  assert.match(lastText(h, modPress), /Only admins/);
  assert.equal(h.engine.settings.appConfig(S, 'mod').dmOnAction, true);
});

test('handlers refuse by role even when called without the router check', async () => {
  const h = await make();
  const said = [];
  const source = (user) => ({ id: 'm1', server_id: S, channel_id: G, author_id: user, author: { id: user, username: 'x' }, content: '' });
  const quiet = (user, values) => {
    const ctx = h.engine.contextFor(source(user), { app: 'mod', kind: 'message', args: [], values });
    ctx.ephemeral = async (p) => { said.push(h.textOf(p)); return null; };
    ctx.reply = ctx.ephemeral;
    ctx.panel = ctx.ephemeral;
    ctx.update = ctx.ephemeral;
    return ctx;
  };
  const run = async (action, user, values) => {
    await h.engine.router.handlers.get(`mod:${action}`).run(quiet(user, values));
    return said[said.length - 1];
  };
  for (const action of ['home', 'cases', 'settings', 'lock', 'unlock', 'purge']) assert.match(await run(action, IDS.member), /Only moderators/, action);
  for (const action of ['dm', 'rules']) assert.match(await run(action, IDS.mod), /Only admins/, action);
  assert.match(await run('rulesave', IDS.mod, { days: '1', steps: '1 ban' }), /Only admins/);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
  assert.equal(h.engine.settings.appConfig(S, 'mod').warnDecayDays, 30);
  assert.equal(h.engine.settings.appConfig(S, 'mod').dmOnAction, true);
  await h.engine.apps.get('mod').def.panel(quiet(IDS.member));
  assert.match(said[said.length - 1], /Only moderators/);
});

test('Undo is locked to the mod who acted and refused by role when forged', async () => {
  const h = await make();
  const ans = await h.slash('timeout', '@sam 1h', { user: IDS.mod });
  const undo = h.findButton('Undo', ans);
  assert.ok(undo.messageId, 'the result is a real message');
  for (const user of [IDS.member, IDS.member2, IDS.admin]) {
    const locked = await h.click(undo.custom_id, { user, messageId: undo.messageId });
    assert.match(lastText(h, locked), /Not your panel/);
  }
  const forged = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(lastText(h, forged), /Only moderators/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)], 'still timed out');
  await h.click(undo.custom_id, { user: IDS.mod, messageId: undo.messageId });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
});

test('a mod without Ban Members cannot undo an admin ban with a forged Undo', async () => {
  const h = await make();
  const ans = await h.slash('ban', '@sam raiding', { user: IDS.admin });
  const undo = h.findButton('Undo', ans);
  const forged = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(lastText(h, forged), /Ban Members/);
  assert.equal(h.fake.state.bans[S].length, 1, 'still banned');
});

test('a mod cannot undo a timeout on someone above them with a forged Undo', async () => {
  const h = await make();
  h.fake.memberOf(S, IDS.member).roles.push(IDS.roles.vip);
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.vip).position = 5;
  const ans = await h.slash('timeout', '@sam 1h', { user: IDS.admin });
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)]);
  const undo = h.findButton('Undo', ans);
  const forged = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(lastText(h, forged), /above yours/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)], 'still timed out');
});

test('lock, slowmode and warn Undo refuse a plain member', async () => {
  const h = await make();
  const lock = await h.slash('lock', '', { user: IDS.mod });
  const slow = await h.slash('mod', 'slowmode 30s', { user: IDS.mod });
  const warn = await h.slash('warn', '@riley spam', { user: IDS.mod });
  for (const ans of [lock, slow, warn]) {
    const undo = h.findButton('Undo', ans);
    const locked = await h.click(undo.custom_id, { user: IDS.member, messageId: undo.messageId });
    assert.match(lastText(h, locked), /Not your panel/);
    const forged = await h.click(undo.custom_id, { user: IDS.member });
    assert.match(lastText(h, forged), /Only moderators/);
  }
  assert.deepEqual(h.fake.state.overrides[`${G}:everyone`].deny, ['send_messages']);
  assert.equal(h.fake.channelById(G).slowmode, 30);
  assert.equal(h.engine.store.get('mod', S).warns.length, 1);
});

test('purge needs Manage Messages on the person asking', async () => {
  const h = await make();
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.manage_messages = false;
  for (let i = 0; i < 3; i++) h.fake.addUserMessage(G, IDS.member, `hi ${i}`);
  const typed = await h.slash('purge', '3', { user: IDS.mod });
  assert.match(lastText(h, typed), /You need \*\*Manage Messages\*\*/);
  const pressed = await h.click('yo:mod:purge:100', { user: IDS.mod });
  assert.match(lastText(h, pressed), /You need \*\*Manage Messages\*\*/);
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0);
});

test('every mod message with buttons is locked to the person who ran the command', async () => {
  const h = await make();
  const outs = [
    await h.slash('mod', '', { user: IDS.mod }),
    await h.slash('case', '', { user: IDS.mod }),
    await h.slash('mod', 'settings', { user: IDS.mod }),
    await h.slash('warn', '@sam x', { user: IDS.mod }),
    await h.slash('lock', '', { user: IDS.mod }),
  ];
  for (const ans of outs) assert.equal(h.engine.router.panelOwner(panelId(ans)), IDS.mod);
});

const S2 = '5e000000-0000-4000-8000-000000000002';
const LOBBY = 'c0000000-0000-4000-8000-0000000000b1';
const S2_BOT_ROLE = 'r0000000-0000-4000-8000-0000000000b6';
const ALL_IDS = ['home', 'cases', 'settings', 'lock', 'unlock', 'purge:10', 'purge:100', 'dm', 'rules', 'rulesave', 'lookup', 'lookupsave', `uwarn:${IDS.member2}`, 'uwarnsave', `uto:${IDS.member2}`, `uban:${IDS.member2}`, 'blen:x:perm'];
const COMMANDS = ['mod', 'warn', 'timeout', 'kick', 'ban', 'purge', 'lock', 'unlock', 'case'];
const HOSTILE_FORM = { days: '0', steps: '1 ban', who: 'riley', reason: 'forged' };
const kindOf = (action) => (/save$/.test(action) ? 'modal_submit' : 'button');
const punishments = (h) => h.fake.callsTo('POST', /\/(kick|bans|timeouts)$/).length;

function addSecondServer(h) {
  const st = h.fake.state;
  st.servers[S2] = { id: S2, name: 'Sam Land', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 1 };
  st.roles[S2] = [{ id: S2_BOT_ROLE, name: 'YapOS', color: null, position: 5, perms: { administrator: true }, auto: null, mentionable: false }];
  st.members[S2] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [], joined_at: '2026-02-01T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [S2_BOT_ROLE], joined_at: '2026-02-01T00:00:00Z' },
  ];
  st.channels[S2] = [{ id: LOBBY, name: 'lobby', type: 'text', kind: 'text', server_id: S2, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[S2] = [];
  st.everyone[S2] = { send_messages: true, view_channel: true };
}

function untouched(h) {
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined, 'general is not locked');
  assert.equal(h.fake.channelById(G).slowmode, 0, 'no slowmode');
  assert.equal(h.fake.channelById(G).read_only, false, 'not read-only');
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0, 'nothing deleted');
  assert.equal(punishments(h), 0, 'nobody punished');
  const cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.dmOnAction, true);
  assert.equal(cfg.warnDecayDays, 30);
  assert.equal(cfg.escalation.length, 3);
}

test('a member who opened their own menu cannot press staff buttons through it', async () => {
  const h = await make();
  h.fake.addUserMessage(G, IDS.member2, 'keep me');
  const menu = await h.slash('menu', '', { user: IDS.member });
  const messageId = panelId(menu);
  assert.equal(h.engine.router.panelOwner(messageId), IDS.member, 'the member owns that menu');
  for (const action of ALL_IDS) {
    const ans = await h.click(`yo:mod:${action}`, { user: IDS.member, messageId, type: kindOf(action), values: HOSTILE_FORM });
    assert.match(lastText(h, ans), /Only (moderators|admins)/, `${action} is refused by role`);
    assert.ok(!ans.some((a) => a.type === 'modal'), 'no form opens');
  }
  untouched(h);
});

test('extra ids pasted onto a staff button change nothing', async () => {
  const h = await make();
  for (const extra of [IDS.owner, IDS.admin, IDS.mod, IDS.server, IDS.roles.top, IDS.bot]) {
    for (const action of ['lock', 'dm', 'rules', 'purge', 'settings', 'cases']) {
      const ans = await h.click(`yo:mod:${action}:${extra}`, { user: IDS.member });
      assert.match(lastText(h, ans), /Only (moderators|admins)/);
    }
  }
  untouched(h);
});

test('a click that claims to come from no server is refused for everyone', async () => {
  const h = await make();
  for (const user of [IDS.member, IDS.mod, IDS.admin]) {
    for (const action of ALL_IDS) await h.click(`yo:mod:${action}`, { user, server: null, type: kindOf(action), values: HOSTILE_FORM });
  }
  untouched(h);
});

test('owning another server gives no power over this one', async () => {
  const h = await make();
  addSecondServer(h);
  h.fake.addUserMessage(G, IDS.member2, 'keep me');
  assert.equal(await h.engine.perms.level(S2, IDS.member), 'owner');
  const there = { user: IDS.member, server: S2, channel: LOBBY };
  const crossed = { user: IDS.member, server: S2, channel: G };
  const lock = await h.click('yo:mod:lock', crossed);
  assert.match(lastText(h, lock), /isn't part of this server/);
  await h.slash('lock', '', crossed);
  await h.slash('unlock', '', crossed);
  await h.slash('mod', 'slowmode 6h', crossed);
  await h.slash('purge', '100', crossed);
  await h.click('yo:mod:purge:100', crossed);
  await h.slash('lock', `<#${G}>`, there);
  await h.slash('mod', `slowmode <#${G}> 6h`, there);
  await h.message(`!lock <#${G}>`, there);
  await h.slash('ban', `<@${IDS.member2}>`, there);
  await h.slash('timeout', `<@${IDS.admin}> 1d`, there);
  assert.equal(h.fake.state.bans[S].length, 0);
  assert.ok(h.fake.memberOf(S, IDS.member2));
  assert.equal(h.fake.state.timeouts[tkey(IDS.admin)], undefined);
  assert.equal(h.fake.messagesIn(G).filter((m) => m.author_id === IDS.member2).length, 1);
  await h.submit('yo:mod:rulesave', HOSTILE_FORM, crossed);
  await h.click('yo:mod:dm', crossed);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined, 'general is not locked');
  assert.equal(h.fake.channelById(G).slowmode, 0);
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0);
  const cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.dmOnAction, true);
  assert.equal(cfg.warnDecayDays, 30);
  assert.equal(h.engine.store.get('mod', S), undefined, 'no cases written here');
  const own = await h.slash('lock', '', there);
  assert.match(lastText(h, own), /Channel locked/);
  assert.deepEqual(h.fake.state.overrides[`${LOBBY}:everyone`].deny, ['send_messages']);
});

test('an Undo from this server cannot be pressed from another server', async () => {
  const h = await make();
  addSecondServer(h);
  const ans = await h.slash('timeout', '@riley 1h', { user: IDS.mod });
  const undo = h.findButton('Undo', ans);
  const tries = [
    await h.click(undo.custom_id, { user: IDS.member, server: S2, channel: LOBBY }),
    await h.click(undo.custom_id, { user: IDS.member, server: null }),
    await h.click(undo.custom_id, { user: IDS.member, server: S2, channel: G }),
  ];
  for (const t of tries) assert.match(lastText(h, t), /Only moderators/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member2)], 'still timed out');
});

test('a mod who just lost the role cannot keep moderating', async () => {
  const h = await make();
  const panel = await h.slash('mod', '', { user: IDS.mod });
  const first = await h.slash('timeout', '@sam 1h', { user: IDS.mod });
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)]);
  const before = punishments(h);
  h.fake.memberOf(S, IDS.mod).roles = [IDS.roles.member];
  const kick = await h.slash('kick', '@riley', { user: IDS.mod });
  assert.match(lastText(h, kick), /Only moderators/);
  await h.message(`!warn <@${IDS.member2}> x`, { user: IDS.mod });
  await h.slash('yap', 'ban @riley', { user: IDS.mod });
  await h.slash('lock', '', { user: IDS.mod });
  await h.clickButton('Lock this channel', { user: IDS.mod, in: panel });
  await h.clickButton('Clear 10 messages', { user: IDS.mod, in: panel });
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: first });
  assert.match(lastText(h, undo), /Only moderators/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)], 'the timeout stays');
  assert.ok(h.fake.memberOf(S, IDS.member2), 'riley is still here');
  assert.equal(punishments(h), before);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
  assert.equal(h.engine.store.get('mod', S).warns.length, 0);
});

test('an admin who just lost the role cannot change mod settings', async () => {
  const h = await make();
  const settings = await h.slash('mod', 'settings', { user: IDS.admin });
  h.fake.memberOf(S, IDS.admin).roles = [IDS.roles.member];
  await h.clickButton('Turn DMs off', { user: IDS.admin, in: settings });
  const form = await h.clickButton('Edit warning rules', { user: IDS.admin, in: settings });
  assert.ok(!form.some((a) => a.type === 'modal'));
  await h.submit('yo:mod:rulesave', HOSTILE_FORM, { user: IDS.admin });
  untouched(h);
});

test('someone who was just promoted above a mod is safe from that mod', async () => {
  const h = await make();
  await h.slash('timeout', '@riley 5', { user: IDS.mod });
  h.fake.memberOf(S, IDS.member2).roles.push(IDS.roles.admin);
  const ans = await h.slash('kick', '@riley', { user: IDS.mod });
  assert.match(lastText(h, ans), /above|admin here/);
  assert.ok(h.fake.memberOf(S, IDS.member2));
});

test('nothing in Mod works after it is uninstalled, including old buttons and Undo', async () => {
  const h = await make();
  const panel = await h.slash('mod', '', { user: IDS.mod });
  const timed = await h.slash('timeout', '@sam 1h', { user: IDS.mod });
  const menu = await h.slash('menu', '', { user: IDS.mod });
  const tile = h.allButtons(menu).find((b) => /open:mod$/.test(b.custom_id));
  h.engine.settings.setEnabled(S, 'mod', false);
  const before = h.fake.calls.length;
  for (const name of COMMANDS) {
    const viaSlash = await h.slash(name, '@riley 5', { user: IDS.mod });
    assert.match(lastText(h, viaSlash), /isn't installed here/, `/${name}`);
    await h.message(`!${name} <@${IDS.member2}> 5`, { user: IDS.mod });
  }
  for (const b of h.allButtons(panel)) {
    const ans = await h.click(b.custom_id, { user: IDS.mod, messageId: b.messageId });
    assert.match(lastText(h, ans), /isn't installed here/);
  }
  for (const action of ALL_IDS) await h.click(`yo:mod:${action}`, { user: IDS.admin, type: kindOf(action), values: HOSTILE_FORM });
  assert.match(lastText(h, await h.slash('yap', 'ban @riley', { user: IDS.mod })), /isn't installed here/);
  assert.doesNotMatch(lastText(h, await h.slash('yap', 'mod', { user: IDS.mod })), /Active warnings/);
  if (tile) assert.doesNotMatch(lastText(h, await h.click(tile.custom_id, { user: IDS.mod, messageId: tile.messageId })), /Active warnings/);
  assert.match(lastText(h, await h.click('yo:system:open:mod', { user: IDS.mod })), /isn't installed here/);
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: timed });
  assert.match(lastText(h, undo), /isn't installed here/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member)], 'the timeout stays');
  const writes = h.fake.calls.slice(before).filter((c) => c.method !== 'GET' && !/interactions|\/messages$/.test(c.path));
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), []);
  assert.equal(h.engine.settings.appConfig(S, 'mod').warnDecayDays, 30);
  assert.ok(h.fake.memberOf(S, IDS.member2));
});

test('typed chat commands are refused for members just like the slash menu', async () => {
  const h = await make();
  h.fake.addUserMessage(G, IDS.member2, 'keep me');
  await h.slash('warn', '@riley hush hush', { user: IDS.mod });
  const before = h.fake.calls.length;
  const lines = [
    ...COMMANDS.map((c) => `!${c} <@${IDS.member2}> 5 x`),
    '/ban riley', '/purge 100', '/lock',
    '!mod settings', '!mod cases', '!mod case 1', '!mod warnings riley', '!mod slowmode 6h', '!mod unban riley', '!mod panel',
  ];
  for (const [index, line] of lines.entries()) {
    for (const authorAsString of [index % 2 === 1]) {
      const seen = new Set(h.sent(G).map((m) => m.id));
      await h.message(line, { user: IDS.member, authorAsString });
      const fresh = h.sent(G).filter((m) => !seen.has(m.id));
      assert.equal(fresh.length, 1, `${line} gets one answer`);
      assert.match(h.textOf(fresh[0]), /Only moderators/, line);
      assert.doesNotMatch(h.textOf(fresh[0]), /hush hush/);
      assert.equal(h.allButtons(fresh).length, 0, 'no buttons handed to a member');
    }
  }
  const writes = h.fake.calls.slice(before).filter((c) => c.method !== 'GET' && !/\/messages(\/[^/]+)?$/.test(c.path));
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), []);
  assert.equal(h.engine.store.get('mod', S).cases.length, 1);
  assert.ok(h.fake.memberOf(S, IDS.member2));
});

test('members cannot read cases, warnings or settings through /yap words', async () => {
  const h = await make();
  await h.slash('warn', '@riley hush hush', { user: IDS.mod });
  await h.slash('mod', 'note @riley hush hush too', { user: IDS.mod });
  const words = ['timeout', 'mute', 'unmute', 'untimeout', 'kick', 'ban', 'unban', 'warn', 'warnings', 'purge', 'clear', 'slowmode', 'lock', 'unlock', 'case', 'whois', 'mod', 'Mod', '/mod', 'cases', 'settings', 'notes', 'user'];
  for (const w of words) {
    for (const tail of ['', ' riley', ' 1', ` <@${IDS.member2}> 5`]) {
      const ans = await h.slash('yap', `${w}${tail}`, { user: IDS.member });
      const text = ans.map((a) => h.textOf(a)).join('\n');
      assert.doesNotMatch(text, /hush hush|Case #|Lock this channel|Automatic steps/, `/yap ${w}${tail}`);
      assert.equal(h.allButtons(ans).filter((b) => /^yo:(mod|sys):/.test(b.custom_id)).length, 0);
    }
  }
  assert.equal(punishments(h), 0);
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0);
  assert.equal(h.fake.state.overrides[`${G}:everyone`], undefined);
});

test('hostile warning-rule forms are refused for non-admins and never wipe the rules', async () => {
  const h = await make();
  const hostile = [
    HOSTILE_FORM,
    { days: '0', steps: '' },
    {},
    [],
    ['0', '1 ban'],
    { days: ['0'], steps: ['1 ban'] },
    { days: '0', steps: '1 ban\n'.repeat(5000) },
    { days: '-1', steps: '@everyone' },
  ];
  for (const values of hostile) {
    for (const user of [IDS.member, IDS.member2, IDS.mod]) {
      for (const type of ['modal_submit', 'button', 'select']) {
        const ans = await h.click('yo:mod:rulesave', { user, type, values });
        assert.match(lastText(h, ans), /Only admins/);
      }
    }
  }
  untouched(h);
  for (const values of [undefined, {}, [], { steps: '1 ban' }, { days: '', steps: '1 ban' }, { days: '   ', steps: '' }]) {
    for (const type of ['modal_submit', 'button']) {
      const ans = await h.click('yo:mod:rulesave', { user: IDS.admin, type, values });
      assert.match(lastText(h, ans), /didn't work/);
    }
  }
  untouched(h);
  const bad = [
    { days: '1.5', steps: '' }, { days: '99999', steps: '' }, { days: '-3', steps: '' }, { days: '30', steps: '0 ban' },
    { days: '30', steps: '3 promote' }, { days: '30', steps: '3 timeout 0' }, { days: '30', steps: '3 ban; drop table' },
  ];
  for (const values of bad) {
    const ans = await h.submit('yo:mod:rulesave', values, { user: IDS.admin });
    assert.match(lastText(h, ans), /didn't work/);
  }
  untouched(h);
  const flood = Array.from({ length: 400 }, (_, i) => `${i + 1} timeout 9999d`).join(', ');
  const big = await h.submit('yo:mod:rulesave', { days: '30', steps: flood }, { user: IDS.admin });
  assert.match(lastText(h, big), /didn't work/);
  untouched(h);
  const long = await h.submit('yo:mod:rulesave', { days: '30', steps: '2 timeout 9999d' }, { user: IDS.admin });
  assert.match(lastText(h, long), /saved/);
  assert.deepEqual(h.engine.settings.appConfig(S, 'mod').escalation, [{ at: 2, action: 'timeout', durationMs: 40320 * 60000 }]);
});

test('a tampered Clear button never deletes more than 100 or turns into a name filter', async () => {
  const h = await make();
  for (let i = 0; i < 130; i++) h.fake.addUserMessage(G, i % 2 ? IDS.member : IDS.member2, `m${i}`);
  for (const arg of ['-5', 'riley', `<@${IDS.member2}>`, 'NaN', '0', '', '1e9', '999999']) {
    const ans = await h.click(`yo:mod:purge:${arg}`, { user: IDS.member });
    assert.match(lastText(h, ans), /Only moderators/);
  }
  assert.equal(h.fake.callsTo('POST', /bulk-delete/).length, 0);
  const people = () => h.fake.messagesIn(G).filter((m) => m.author_id !== IDS.bot);
  for (const [arg, want] of [['-5', 10], ['riley', 10], ['1e9', 100]]) {
    const before = people();
    const ans = await h.click(`yo:mod:purge:${arg}`, { user: IDS.mod });
    assert.match(lastText(h, ans), /Cleared \d+ message/);
    const gone = before.filter((m) => !people().some((x) => x.id === m.id));
    assert.equal(gone.length, want, `purge:${arg}`);
    assert.ok(gone.some((m) => m.author_id === IDS.member) && gone.some((m) => m.author_id === IDS.member2), 'no name filter');
  }
});

test('a forged warn Undo cannot lift a ban or timeout the presser could not lift themselves', async () => {
  const h = await make();
  h.engine.settings.patchApp(S, 'mod', { escalation: [{ at: 1, action: 'ban' }] });
  const banned = await h.slash('warn', '@sam raid', { user: IDS.admin });
  assert.equal(h.fake.state.bans[S].length, 1);
  const forged = await h.click(h.findButton('Undo', banned).custom_id, { user: IDS.mod });
  assert.match(lastText(h, forged), /Ban Members/);
  assert.equal(h.fake.state.bans[S].length, 1, 'still banned');
  assert.equal(h.engine.store.get('mod', S).warns.length, 1, 'the warning stays');

  const h2 = await make();
  h2.engine.settings.patchApp(S, 'mod', { escalation: [{ at: 1, action: 'timeout', durationMs: 3600000 }] });
  h2.fake.memberOf(S, IDS.member).roles.push(IDS.roles.vip);
  h2.fake.state.roles[S].find((r) => r.id === IDS.roles.vip).position = 5;
  const timed = await h2.slash('warn', '@sam rude', { user: IDS.admin });
  assert.ok(h2.fake.state.timeouts[tkey(IDS.member)]);
  const forged2 = await h2.click(h2.findButton('Undo', timed).custom_id, { user: IDS.mod });
  assert.match(lastText(h2, forged2), /above yours/);
  assert.ok(h2.fake.state.timeouts[tkey(IDS.member)], 'still timed out');
});

test('a timed-out mod cannot undo their own timeout', async () => {
  const h = await make();
  const ans = await h.slash('timeout', '@morgan 1h', { user: IDS.admin });
  assert.ok(h.fake.state.timeouts[tkey(IDS.mod)]);
  const undo = h.findButton('Undo', ans);
  const locked = await h.click(undo.custom_id, { user: IDS.mod, messageId: undo.messageId });
  assert.match(lastText(h, locked), /Not your panel/);
  const forged = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(lastText(h, forged), /yourself/);
  const typed = await h.slash('timeout', '@morgan off', { user: IDS.mod });
  assert.match(lastText(h, typed), /yourself/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.mod)], 'still timed out');
});

test('a mod cannot moderate someone setup marked as an admin, whatever the role order', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { adminRoles: [IDS.roles.vip] });
  h.fake.memberOf(S, IDS.member2).roles.push(IDS.roles.vip);
  assert.equal(await h.engine.perms.level(S, IDS.member2), 'admin');
  for (const line of ['kick @riley', 'ban @riley', 'timeout @riley 1h', 'warn @riley x']) {
    const ans = await h.slash('mod', line, { user: IDS.mod });
    assert.match(lastText(h, ans), /Ban Members|admin here/, line);
  }
  assert.ok(h.fake.memberOf(S, IDS.member2));
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined);
  assert.equal(h.engine.store.get('mod', S)?.warns?.length ?? 0, 0);
  const byAdmin = await h.slash('timeout', '@riley 1h', { user: IDS.admin });
  assert.ok(h.fake.state.timeouts[tkey(IDS.member2)], 'a real admin still can');
  const forged = await h.click(h.findButton('Undo', byAdmin).custom_id, { user: IDS.mod });
  assert.match(lastText(h, forged), /admin here/);
  assert.ok(h.fake.state.timeouts[tkey(IDS.member2)]);
});

test('staff cannot aim the bot at the owner, at itself or above their own role', async () => {
  const h = await make();
  giveModBan(h);
  for (const who of [`<@${IDS.owner}>`, `<@${IDS.bot}>`, '@jolli', '@yapos', IDS.owner]) {
    for (const act of ['kick', 'ban', 'timeout', 'warn']) {
      for (const user of [IDS.mod, IDS.admin]) await h.slash(act, `${who} 10m`, { user });
    }
  }
  for (const act of ['kick', 'ban', 'timeout', 'warn']) await h.slash(act, `<@${IDS.admin}> 10m`, { user: IDS.mod });
  assert.equal(punishments(h), 0);
  assert.equal(h.engine.store.get('mod', S)?.warns?.length ?? 0, 0);
});

test('mod never posts a button that is open to everyone', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  giveModBan(h);
  const runs = ['', 'settings', 'cases', 'case 1', 'warn @sam a', 'warnings @sam', 'timeout @sam 5', 'lock', 'unlock', 'slowmode 5s', 'purge 2', 'kick @riley', 'ban @sam'];
  for (const line of runs) await h.slash('mod', line, { user: IDS.mod });
  await h.message('!mod', { user: IDS.mod });
  await h.message('!mod lock', { user: IDS.mod });
  await settle(10);
  let withButtons = 0;
  for (const m of h.sent()) {
    const buttons = h.allButtons([m]);
    if (!buttons.length) continue;
    withButtons += 1;
    assert.equal(h.engine.router.panelOwner(m.id), IDS.mod, `locked: ${h.textOf(m).slice(0, 40)}`);
    for (const b of buttons) {
      const ans = await h.click(b.custom_id, { user: IDS.member2, messageId: m.id, channel: m.channel_id });
      assert.match(lastText(h, ans), /Not your panel/);
    }
  }
  assert.ok(withButtons >= 8, 'checked the panels');
  assert.ok(h.sent(IDS.channels.modlog).length > 3);
  assert.equal(h.allButtons(h.sent(IDS.channels.modlog)).length, 0, 'log posts carry no buttons');
});

test('admins set the mod log channel with /mod log, members and mods cannot', async () => {
  const h = await createHarness({ apps: ['mod'] });
  const member = await h.slash('mod', 'log #mod-log', { user: IDS.member });
  assert.match(h.textOf(member[member.length - 1]), /Only moderators/);
  const mod = await h.slash('mod', 'log #mod-log', { user: IDS.mod });
  assert.match(h.textOf(mod[mod.length - 1]), /Only admins/);
  assert.equal(h.engine.settings.core(S).logChannel, null);
  const admin = await h.slash('mod', 'log #mod-log', { user: IDS.admin });
  assert.match(h.textOf(admin[admin.length - 1]), /Log channel saved/);
  assert.equal(h.engine.settings.core(S).logChannel, IDS.channels.modlog);
  await h.slash('mod', 'log off', { user: IDS.admin });
  assert.equal(h.engine.settings.core(S).logChannel, null);
});

test('admins add and remove extra mod roles, and the role then works', async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.memberOf(S, IDS.member2).roles = [];
  const before = await h.slash('warn', '@riley spam', { user: IDS.member });
  assert.match(h.textOf(before[before.length - 1]), /Only moderators/);
  const added = await h.slash('mod', 'modrole add @Member', { user: IDS.admin });
  assert.match(h.textOf(added[added.length - 1]), /Mod role added/);
  assert.deepEqual(h.engine.settings.core(S).modRoles, [IDS.roles.member]);
  const after = await h.slash('warn', '@riley spam', { user: IDS.member });
  assert.match(h.textOf(after[after.length - 1]), /Warned/);
  await h.slash('mod', 'modrole remove @Member', { user: IDS.admin });
  assert.deepEqual(h.engine.settings.core(S).modRoles, []);
  const gone = await h.slash('warn', '@riley spam', { user: IDS.member });
  assert.match(h.textOf(gone[gone.length - 1]), /Only moderators/);
});

test('extra admin roles are for the server owner only and refuse silly roles', async () => {
  const h = await createHarness({ apps: ['mod'] });
  const admin = await h.slash('mod', 'adminrole add @VIP', { user: IDS.admin });
  assert.match(h.textOf(admin[admin.length - 1]), /Only the server owner/);
  assert.deepEqual(h.engine.settings.core(S).adminRoles, []);
  const owner = await h.slash('mod', 'adminrole add @VIP', { user: IDS.owner });
  assert.match(h.textOf(owner[owner.length - 1]), /Admin role added/);
  assert.deepEqual(h.engine.settings.core(S).adminRoles, [IDS.roles.vip]);
  const high = await h.slash('mod', 'modrole add @Admin', { user: IDS.admin });
  assert.match(h.textOf(high[high.length - 1]), /at or above your highest role/);
  const list = await h.slash('mod', 'settings', { user: IDS.admin });
  assert.match(h.textOf(list[list.length - 1]), /Extra admin roles/);
});
const HOUR = 3600000;
const DAY = 24 * HOUR;
const clocked = (opts = {}) => make({ fakeClock: true, ...opts });
const unbanJobs = (h) => h.engine.scheduler.list({ kind: 'mod.unban', serverId: S });
const isBanned = (h, uid) => h.fake.state.bans[S].some((b) => b.user_id === uid);
const modCases = (h) => h.engine.store.get('mod', S)?.cases || [];
const logTexts = (h) => h.sent(IDS.channels.modlog).map((m) => h.textOf(m)).join('\n---\n');
const sam = (h) => h.fake.memberOf(S, IDS.member);
const rejoin = (h, id, username) => {
  if (!h.fake.memberOf(S, id)) h.fake.state.members[S].push({ id, username, display_name: username, nickname: null, roles: [IDS.roles.member], joined_at: '2026-01-05T00:00:00Z' });
  h.engine.cache.invalidate(S);
};

test('a temporary ban says when it ends and lifts itself on time', async () => {
  const h = await clocked();
  giveModBan(h);
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  const ans = await h.slash('ban', '@sam 7d spamming', { user: IDS.mod });
  const text = lastText(h, ans);
  assert.match(text, /Banned/);
  assert.match(text, /@sam is banned until \*\*Sat 14 Nov, 12:00 UTC\*\* \(in 7 days\)/);
  assert.match(text, /\*\*Reason:\*\* spamming/);
  assert.match(text, /lift the ban by myself/);
  assert.ok(isBanned(h, IDS.member));
  const jobs = unbanJobs(h);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, IDS.member);
  assert.equal(jobs[0].at, h.now() + 7 * DAY);
  const dm = Object.keys(h.fake.state.dms).flatMap((cid) => h.sent(cid)).map((m) => h.textOf(m)).join('\n');
  assert.match(dm, /banned from \*\*Test Town\*\* until Sat 14 Nov, 12:00 UTC \(7 days\)/);
  const banCase = modCases(h).find((c) => c.action === 'ban');
  assert.equal(banCase.durationMs, 7 * DAY);
  await h.advance(7 * DAY - 60000);
  assert.ok(isBanned(h, IDS.member), 'still banned a minute before the end');
  await h.advance(60000);
  await settle(10);
  assert.ok(!isBanned(h, IDS.member), 'unbanned at the end');
  assert.equal(unbanJobs(h).length, 0);
  const unban = modCases(h).find((c) => c.action === 'unban');
  assert.equal(unban.reason, 'Ban expired');
  assert.equal(unban.targetName, '@sam');
  assert.match(logTexts(h), /Unban[\s\S]*Ban expired/);
  const shown = await h.slash('case', String(banCase.id), { user: IDS.mod });
  assert.match(lastText(h, shown), /Ban ends/);
});

test('ban lengths: units, years, plain numbers stay in the reason, and limits', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('mod', 'ban @sam 2h30m flood', { user: IDS.mod });
  assert.equal(unbanJobs(h)[0].at, h.now() + 2.5 * HOUR);
  assert.equal(modCases(h).at(-1).reason, 'flood');
  await h.slash('ban', '@riley 3 times spamming', { user: IDS.mod });
  assert.equal(unbanJobs(h).filter((j) => j.key === IDS.member2).length, 0, 'a bare number is not a length');
  assert.equal(modCases(h).at(-1).reason, '3 times spamming');
  assert.equal(modCases(h).at(-1).durationMs, null);
  h.fake.state.bans[S] = [];
  rejoin(h, IDS.member2, 'riley');
  await h.slash('ban', `<@${IDS.member2}> 1y`, { user: IDS.mod });
  assert.equal(unbanJobs(h).find((j) => j.key === IDS.member2).at, h.now() + 365 * DAY);
  rejoin(h, IDS.member, 'sam');
  const before = h.fake.callsTo('POST', /bans$/).length;
  for (const [line, re] of [['@sam 2y', /up to 1 year/], ['@sam 400d', /up to 1 year/], ['@sam 30s', /at least 1 minute/]]) {
    const ans = await h.slash('ban', line, { user: IDS.mod });
    assert.match(lastText(h, ans), re, line);
  }
  assert.equal(h.fake.callsTo('POST', /bans$/).length, before, 'refused lengths ban nobody');
});

test('"forever" and no length are permanent and cancel a pending unban', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1d spam', { user: IDS.mod });
  assert.equal(unbanJobs(h).length, 1);
  const ans = await h.slash('ban', `${IDS.member} forever being rude`, { user: IDS.mod });
  assert.match(lastText(h, ans), /Banned/);
  assert.doesNotMatch(lastText(h, ans), /until/);
  assert.equal(modCases(h).at(-1).reason, 'being rude');
  assert.equal(unbanJobs(h).length, 0, 'the permanent ban replaced the temporary one');
  await h.advance(2 * DAY);
  assert.ok(isBanned(h, IDS.member));
});

test('a manual unban and Undo both cancel the pending unban', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1d spam', { user: IDS.mod });
  await h.slash('mod', `unban ${IDS.member}`, { user: IDS.mod });
  assert.equal(unbanJobs(h).length, 0);
  assert.ok(!isBanned(h, IDS.member));
  rejoin(h, IDS.member, 'sam');
  const again = await h.slash('ban', '@sam 2d spam', { user: IDS.mod });
  assert.equal(unbanJobs(h).length, 1);
  const undo = await h.clickButton('Undo', { user: IDS.mod, in: again });
  assert.match(h.textOf(undo.at(-1)), /unbanned/);
  assert.equal(unbanJobs(h).length, 0);
  const casesBefore = modCases(h).length;
  await h.advance(3 * DAY);
  assert.equal(modCases(h).length, casesBefore, 'no "ban expired" case after an Undo');
});

test('a ban Yapin refuses leaves no unban job behind', async () => {
  const h = await clocked();
  giveModBan(h);
  h.fake.fail('POST', /bans$/, { status: 403 });
  const ans = await h.slash('ban', '@sam 7d spam', { user: IDS.mod });
  assert.doesNotMatch(lastText(h, ans), /Banned/);
  assert.equal(unbanJobs(h).length, 0);
});

test('a ban that ends while the bot is off still lifts, and says so', async () => {
  const h = await clocked();
  giveModBan(h);
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('ban', '@sam 1h spam', { user: IDS.mod });
  await h.skip(5 * HOUR);
  await settle(10);
  assert.ok(!isBanned(h, IDS.member));
  assert.equal(modCases(h).at(-1).reason, 'Ban expired (I was offline when it ended)');
  assert.match(logTexts(h), /I was offline when it ended/);
});

test('temporary bans survive a restart', async () => {
  const a = await clocked();
  giveModBan(a);
  await a.slash('ban', '@sam 2d spam', { user: IDS.mod });
  const banCase = modCases(a).at(-1);
  a.engine.scheduler.stop();
  const b = await clocked({ store: a.store });
  b.fake.state.bans[S].push({ user_id: IDS.member, banned_by: IDS.bot, created_at: new Date(b.now()).toISOString(), user: null });
  assert.equal(unbanJobs(b).length, 1);
  b.clock.t = a.clock.t + 3 * DAY;
  await b.runDue();
  assert.ok(!isBanned(b, IDS.member));
  const cases = modCases(b);
  assert.equal(cases.at(-1).action, 'unban');
  assert.match(cases.at(-1).reason, /offline/);
  assert.equal(cases.at(-1).id, banCase.id + 1);
  assert.equal(unbanJobs(b).length, 0);
});

test('an unban job skips people already unbanned by hand and waits while Mod is uninstalled', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1h spam', { user: IDS.mod });
  h.fake.state.bans[S] = [];
  const n = modCases(h).length;
  await h.advance(2 * HOUR);
  assert.equal(modCases(h).length, n, 'nothing logged for someone already unbanned');
  rejoin(h, IDS.member, 'sam');
  await h.slash('ban', '@sam 1h spam', { user: IDS.mod });
  h.engine.settings.setEnabled(S, 'mod', false);
  await h.advance(2 * HOUR);
  assert.ok(isBanned(h, IDS.member), 'nothing happens while uninstalled');
  assert.equal(unbanJobs(h).length, 1, 'the job waits');
  h.engine.settings.setEnabled(S, 'mod', true);
  await h.advance(6 * HOUR);
  assert.ok(!isBanned(h, IDS.member));
  assert.match(modCases(h).at(-1).reason, /Mod was uninstalled when it ended/);
});

test('when Yapin keeps refusing the unban, the log channel is told what to do', async () => {
  const h = await clocked();
  giveModBan(h);
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('ban', '@sam 1h spam', { user: IDS.mod });
  h.fake.fail('DELETE', /bans\//, { status: 403 });
  await h.advance(3 * HOUR);
  await settle(10);
  assert.ok(isBanned(h, IDS.member));
  assert.equal(unbanJobs(h).length, 0, 'gave up after the retries');
  assert.equal(h.fake.callsTo('DELETE', /bans\//).length, 4);
  const log = logTexts(h);
  assert.match(log, /I couldn't lift a ban/);
  assert.match(log, new RegExp(`/mod unban ${IDS.member}`));
  assert.doesNotMatch(log, /403/);
});

test('private notes: add, list, show in lookup, never a warning or DM', async () => {
  const h = await clocked();
  const dmsBefore = Object.keys(h.fake.state.dms).length;
  const saved = await h.slash('mod', 'note @sam keeps arguing in general', { user: IDS.mod });
  assert.match(lastText(h, saved), /Note saved/);
  assert.match(lastText(h, saved), /wasn't told/);
  await h.slash('mod', 'note @sam second thing', { user: IDS.mod });
  assert.equal(Object.keys(h.fake.state.dms).length, dmsBefore, 'no DM');
  assert.equal(modCases(h).length, 0, 'not a case');
  assert.equal((h.engine.store.get('mod', S).warns || []).length, 0, 'not a warning');
  const list = await h.slash('mod', 'notes @sam', { user: IDS.mod });
  const text = lastText(h, list);
  assert.match(text, /Notes on @sam \(2\)/);
  assert.ok(text.indexOf('second thing') < text.indexOf('keeps arguing'), 'newest first');
  const look = await h.slash('mod', 'user @sam', { user: IDS.mod });
  assert.match(lastText(h, look), /Notes\n2/);
  const none = await h.slash('mod', 'notes @riley', { user: IDS.mod });
  assert.match(lastText(h, none), /Notes on @riley \(0\)/);
  assert.match(lastText(h, none), /Nothing written yet/);
  const empty = await h.slash('mod', 'note @sam', { user: IDS.mod });
  assert.match(lastText(h, empty), /What should the note say/);
  const member = await h.slash('mod', 'note @riley sneaky', { user: IDS.member });
  assert.match(lastText(h, member), /Only moderators/);
  const peek = await h.slash('mod', 'notes @sam', { user: IDS.member });
  assert.doesNotMatch(lastText(h, peek), /keeps arguing/);
});

test('notes are bounded, long ones are cut, and only the writer or an admin removes one', async () => {
  const h = await make();
  for (let i = 1; i <= 26; i++) await h.slash('mod', `note @sam note number ${i}`, { user: IDS.mod });
  const notes = h.engine.store.get('mod', S).notes;
  assert.equal(notes.length, 25);
  assert.ok(!notes.some((n) => n.text === 'note number 1'), 'the oldest went');
  assert.match(lastText(h, await h.slash('mod', 'note @sam one more', { user: IDS.mod })), /let go of the oldest/);
  const long = await h.slash('mod', `note @riley ${'x'.repeat(700)}`, { user: IDS.mod });
  assert.match(lastText(h, long), /first 500 characters/);
  const rileyNote = h.engine.store.get('mod', S).notes.find((n) => n.targetId === IDS.member2);
  assert.equal(rileyNote.text.length, 500);
  h.fake.state.members[S].find((m) => m.id === IDS.member2).roles.push(IDS.roles.mod);
  h.engine.perms.invalidate();
  const theirs = await h.slash('mod', `note remove ${rileyNote.id}`, { user: IDS.member2 });
  assert.match(lastText(h, theirs), /only they or an admin/);
  const own = await h.slash('mod', `note remove ${rileyNote.id}`, { user: IDS.mod });
  assert.match(lastText(h, own), /Note removed/);
  const samNote = h.engine.store.get('mod', S).notes[0];
  const admin = await h.slash('mod', `note remove #${samNote.id}`, { user: IDS.admin });
  assert.match(lastText(h, admin), /Note removed/);
  assert.match(lastText(h, await h.slash('mod', 'note remove 9999', { user: IDS.mod })), /No note #9999/);
});

test('editing a case reason keeps history, updates warnings and the log message', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('warn', '@sam spam', { user: IDS.mod });
  await settle(10);
  const stored = modCases(h)[0];
  assert.ok(stored.log?.messageId, 'the log message id is kept');
  const ans = await h.slash('case', '1 reason posted scam links', { user: IDS.mod });
  assert.match(lastText(h, ans), /Reason updated/);
  assert.match(lastText(h, ans), /updated the log message/);
  await settle(10);
  const logged = h.fake.state.messages[IDS.channels.modlog].find((m) => m.id === stored.log.messageId);
  const logText = h.textOf(logged);
  assert.match(logText, /posted scam links/);
  assert.match(logText, /Was: spam \(edited by Mo/);
  assert.match(logText, /active warning/, 'the warning count line is kept');
  const view = await h.slash('case', '1', { user: IDS.mod });
  assert.match(lastText(h, view), /Earlier reasons/);
  assert.match(lastText(h, view), /edited by Mo/);
  const warns = await h.slash('mod', 'warnings @sam', { user: IDS.mod });
  assert.match(lastText(h, warns), /posted scam links/);
  await h.slash('mod', 'case 1 reason third try', { user: IDS.admin });
  assert.equal(modCases(h)[0].history.length, 2);
  assert.equal(modCases(h)[0].reason, 'third try');
  const blank = await h.slash('case', '1 reason', { user: IDS.mod });
  assert.match(lastText(h, blank), /What should the new reason be/);
});

test('a deleted log message does not stop a reason edit', async () => {
  const h = await make();
  h.engine.settings.patchCore(S, { logChannel: IDS.channels.modlog });
  await h.slash('kick', '@sam spam', { user: IDS.mod });
  await settle(10);
  const stored = modCases(h)[0];
  h.fake.state.messages[IDS.channels.modlog].find((m) => m.id === stored.log.messageId).deleted = true;
  const ans = await h.slash('case', '1 reason new words', { user: IDS.mod });
  assert.match(lastText(h, ans), /Reason updated/);
  assert.match(lastText(h, ans), /couldn't update the old log message/);
  assert.equal(modCases(h)[0].reason, 'new words');
});

test('only the mod who made a case, or an admin, can change its reason', async () => {
  const h = await make();
  await h.slash('warn', '@sam spam', { user: IDS.admin });
  await h.slash('warn', '@riley flood', { user: IDS.mod });
  const svc = h.engine.service('mod');
  const auto = await svc.addCase(S, { action: 'warn', targetId: IDS.member, actorId: IDS.bot, reason: 'caps', source: 'automod' });
  const other = await h.slash('case', '1 reason mine now', { user: IDS.mod });
  assert.match(lastText(h, other), /only they or an admin/);
  const bot = await h.slash('case', `${auto.id} reason mine now`, { user: IDS.mod });
  assert.match(lastText(h, bot), /only they or an admin/);
  assert.equal(modCases(h)[0].reason, 'spam');
  assert.match(lastText(h, await h.slash('case', '2 reason fixed', { user: IDS.mod })), /Reason updated/);
  assert.match(lastText(h, await h.slash('case', `${auto.id} reason all caps`, { user: IDS.admin })), /Reason updated/);
  const member = await h.slash('case', '2 reason hacked', { user: IDS.member });
  assert.match(lastText(h, member), /Only moderators/);
  assert.equal(modCases(h)[1].reason, 'fixed');
  const nolog = await h.slash('case', '2 reason no log', { user: IDS.mod });
  assert.doesNotMatch(lastText(h, nolog), /log message/, 'no log channel, nothing to update');
});

test('user lookup shows the whole picture with working buttons', async () => {
  const h = await clocked();
  giveModBan(h);
  Object.assign(sam(h), { invite_code: 'summer24', inviter_id: IDS.admin, nickname: 'Sammy' });
  sam(h).roles.push(IDS.roles.vip, IDS.roles.gamer);
  await h.slash('warn', '@sam spam', { user: IDS.mod });
  await h.slash('timeout', '@sam 2h flood', { user: IDS.mod });
  await h.slash('mod', 'note @sam watch this one', { user: IDS.mod });
  const ans = await h.slash('mod', 'user @sam', { user: IDS.mod });
  const text = lastText(h, ans);
  assert.match(text, /🔎 @sam/);
  assert.match(text, /Sammy \(@sam\)/);
  assert.match(text, /5 Jan 2026 \(10 months ago\)/);
  assert.match(text, /\*\*VIP\*\*, \*\*Gamer\*\*, \*\*Member\*\*/);
  assert.match(text, /`summer24` from @alex/);
  assert.match(text, /Until Sat 7 Nov, 14:00 UTC \(2 hours left\)/);
  assert.match(text, /Active warnings\n1/);
  assert.match(text, /Last cases \(2 in all\)/);
  assert.doesNotMatch(text, /watch this one/);
  assert.doesNotMatch(text, new RegExp(IDS.member), 'no raw ids');
  for (const label of ['Warn', 'Timeout', 'Ban']) assert.ok(h.findButton(label, ans), label);
  assert.equal(h.engine.router.panelOwner(panelId(ans)), IDS.mod);
  const notYours = await h.clickButton('Ban', { user: IDS.member2, in: ans });
  assert.match(lastText(h, notYours), /Not your panel/);

  const warnForm = await h.clickButton('Warn', { user: IDS.mod, in: ans });
  assert.equal(warnForm.at(-1).type, 'modal');
  const warned = await h.submit('yo:mod:uwarnsave', { reason: 'from the lookup' }, { user: IDS.mod });
  assert.match(lastText(h, warned), /now has \*\*2\*\* warnings/);
  const stale = await h.submit('yo:mod:uwarnsave', { reason: 'again' }, { user: IDS.mod });
  assert.match(lastText(h, stale), /expired/);

  const asked = await h.clickButton('Timeout', { user: IDS.mod, in: ans });
  assert.match(lastText(h, asked), /How long should @sam be timed out/);

  const banAsk = await h.clickButton('Ban', { user: IDS.mod, in: ans });
  assert.match(lastText(h, banAsk), /How long should @sam be banned/);
  for (const label of ['Permanent', '1 day', '7 days', '30 days', 'Cancel']) assert.ok(h.findButton(label, banAsk), label);
  const banned = await h.clickButton('7 days', { user: IDS.mod, in: banAsk });
  assert.match(lastText(h, banned), /banned until \*\*Sat 14 Nov, 12:00 UTC\*\* \(in 7 days\)/);
  assert.ok(isBanned(h, IDS.member));
  assert.equal(unbanJobs(h).length, 1);

  const gone = await h.slash('mod', `user ${IDS.member}`, { user: IDS.mod });
  const goneText = lastText(h, gone);
  assert.match(goneText, /Not in the server right now/);
  assert.match(goneText, /Banned until Sat 14 Nov, 12:00 UTC/);
  assert.deepEqual(h.allButtons(gone).map((b) => b.label).filter((l) => !/^Notes/.test(l) && l !== 'Add note'), [], 'only note buttons for someone already banned');
});

test('lookup buttons keep every check', async () => {
  const h = await clocked();
  const onAdmin = await h.slash('mod', 'user @alex', { user: IDS.mod });
  const ban = await h.clickButton('Ban', { user: IDS.mod, in: onAdmin });
  assert.match(lastText(h, ban), /I can't ban @alex|Ban Members/);
  const timeout = await h.clickButton('Timeout', { user: IDS.mod, in: onAdmin });
  assert.match(lastText(h, timeout), /I can't time out @alex/);
  const warn = await h.clickButton('Warn', { user: IDS.mod, in: onAdmin });
  assert.notEqual(warn.at(-1).type, 'modal');
  assert.equal(punishments(h), 0);
  for (const action of ['uwarn', 'uto', 'uban']) {
    const forged = await h.click(`yo:mod:${action}:${IDS.member2}`, { user: IDS.member });
    assert.match(lastText(h, forged), /Only moderators/);
  }
  const forgedSave = await h.submit('yo:mod:uwarnsave', { reason: 'x' }, { user: IDS.member });
  assert.match(lastText(h, forgedSave), /Only moderators/);
  const badId = await h.click('yo:mod:uban:not-a-user', { user: IDS.mod });
  assert.match(lastText(h, badId), /expired/);
  const member = await h.slash('mod', 'user @riley', { user: IDS.member });
  assert.match(lastText(h, member), /Only moderators/);
  const nobody = await h.slash('mod', 'user nobodyatall', { user: IDS.mod });
  assert.match(lastText(h, nobody), /couldn't find/);
});

test('the mod panel has a Look up button that asks for a name', async () => {
  const h = await make();
  const panel = await h.slash('mod', '', { user: IDS.mod });
  assert.match(lastText(h, panel), /Temporary bans/);
  const form = await h.clickButton('Look up', { user: IDS.mod, in: panel });
  assert.equal(form.at(-1).type, 'modal');
  assert.match(h.textOf(form.at(-1)), /Look someone up/);
  const shown = await h.submit('yo:mod:lookupsave', { who: 'riley' }, { user: IDS.mod });
  assert.match(lastText(h, shown), /🔎 @riley/);
  const typo = await h.submit('yo:mod:lookupsave', { who: 'zzzzzz' }, { user: IDS.mod });
  assert.match(lastText(h, typo), /couldn't find/);
  const forged = await h.submit('yo:mod:lookupsave', { who: 'riley' }, { user: IDS.member });
  assert.match(lastText(h, forged), /Only moderators/);
  assert.equal(h.engine.apps.get('mod').def.panelPerm, 'mod');
});

test('a ban Yapin refuses puts back the earlier temporary ban instead of leaving them banned forever', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1d spam', { user: IDS.mod });
  const before = unbanJobs(h)[0];
  h.fake.fail('POST', /bans$/, { status: 500, times: 1 });
  await h.slash('ban', `${IDS.member} 7d spam again`, { user: IDS.mod });
  const after = unbanJobs(h);
  assert.equal(after.length, 1, 'the earlier unban is still waiting');
  assert.equal(after[0].at, before.at);
  await h.advance(2 * DAY);
  assert.ok(!isBanned(h, IDS.member));
});

test('an unban that works on a retry does not claim Mod was uninstalled', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1h spam', { user: IDS.mod });
  h.fake.fail('DELETE', /bans\//, { status: 500, times: 2 });
  await h.advance(2 * HOUR);
  await settle(10);
  assert.ok(!isBanned(h, IDS.member));
  assert.equal(modCases(h).at(-1).reason, 'Ban expired');
});

test('temporary bans do not use up the banned person\'s own job allowance', async () => {
  const h = await clocked();
  giveModBan(h);
  await h.slash('ban', '@sam 1d spam', { user: IDS.mod });
  assert.equal(h.engine.scheduler.list({ userId: IDS.member }).length, 0);
  assert.equal(unbanJobs(h).length, 1);
});

test('the lookup card is posted where others can see it, so it never shows note text', async () => {
  const h = await make();
  await h.slash('mod', 'note @sam secret thing about sam', { user: IDS.mod });
  const look = await h.slash('mod', 'user @sam', { user: IDS.mod });
  const text = lastText(h, look);
  assert.match(text, /Notes\n1/);
  assert.doesNotMatch(text, /secret thing/);
});

test('user lookup: Notes shows the notes and Add note saves one from a form', async () => {
  const h = await createHarness({ apps: ['mod'] });
  await h.slash('mod', 'note @sam first thing', { user: IDS.mod });
  const look = await h.slash('mod', 'user @sam', { user: IDS.mod });
  const labels = h.allButtons(look).map((b) => b.label);
  assert.ok(labels.includes('Notes (1)'));
  assert.ok(labels.includes('Add note'));
  const shown = await h.click(h.findButton('Notes (1)', look).custom_id, { user: IDS.mod });
  assert.match(lastText(h, shown), /first thing/);
  const addId = h.findButton('Add note', look).custom_id;
  await h.submit(addId.replace(':unote:', ':unotesave:'), { text: 'second thing' }, { user: IDS.mod });
  const out = await h.slash('mod', 'notes @sam', { user: IDS.mod });
  assert.match(lastText(h, out), /second thing/);
  const forged = await h.click(h.findButton('Notes (1)', look).custom_id, { user: IDS.member });
  assert.doesNotMatch(lastText(h, forged) || '', /first thing/);
});
