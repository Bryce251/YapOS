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

test('duration parsing: bare minutes, clamp to 28 days, off clears, default length', async () => {
  const h = await make();
  await h.slash('timeout', '@sam 90', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 90);
  const big = await h.slash('timeout', '@sam 60d', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)].minutes, 40320);
  assert.match(lastText(h, big), /28 days/);
  await h.slash('timeout', '@sam off', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member)], undefined);
  await h.slash('timeout', '@riley talking over people', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)].minutes, 10);
  await h.slash('mod', 'untimeout @riley', { user: IDS.mod });
  assert.equal(h.fake.state.timeouts[tkey(IDS.member2)], undefined);
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