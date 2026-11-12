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
const panelId = (ans) => ans.map((a) => a.message?.id).filter(Boolean).pop();
const MOD_BUTTONS = ['home', 'cases', 'settings', 'lock', 'unlock', 'purge:10'];
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
const ALL_IDS = ['home', 'cases', 'settings', 'lock', 'unlock', 'purge:10', 'purge:100', 'dm', 'rules', 'rulesave'];
const COMMANDS = ['mod', 'warn', 'timeout', 'kick', 'ban', 'purge', 'lock', 'unlock', 'case'];
const HOSTILE_FORM = { days: '0', steps: '1 ban' };
const kindOf = (action) => (action === 'rulesave' ? 'modal_submit' : 'button');
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
  const words = ['timeout', 'mute', 'unmute', 'untimeout', 'kick', 'ban', 'unban', 'warn', 'warnings', 'purge', 'clear', 'slowmode', 'lock', 'unlock', 'case', 'mod', 'Mod', '/mod', 'cases', 'settings'];
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
