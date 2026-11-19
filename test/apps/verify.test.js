import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, uuid } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';

const S = IDS.server;
const C = IDS.channels;
const R = IDS.roles;

const make = (opts = {}) => createHarness({ apps: ['automod', 'verify'], ...opts });
const cfgOf = (h) => h.engine.settings.appConfig(S, 'verify');
const role = (h, id) => h.fake.state.roles[S].find((r) => r.id === id);
const rolesOf = (h, uid) => h.fake.memberOf(S, uid)?.roles || [];
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const stored = (h, id) => Object.values(h.fake.state.messages).flat().find((m) => m.id === id && !m.deleted) || null;

async function ready(h, patch = {}) {
  h.engine.settings.patchApp(S, 'verify', { enabled: true, channelId: C.welcome, roleId: R.vip, migrated: true, ...patch });
  const ans = await h.slash('verify', 'panel', { user: IDS.admin });
  assert.match(lastText(h, ans), /Panel posted/);
  return h.lastSent(C.welcome);
}

function challenge(h, ans) {
  const btns = h.allButtons(ans).filter((b) => b.custom_id.startsWith('yo:verify:ans:'));
  assert.ok(btns.length, `a challenge was shown: ${lastText(h, ans)}`);
  const sess = btns[0].custom_id.split(':')[4];
  const right = h.engine.router.getSession(sess).answer;
  return {
    right: btns.find((b) => b.custom_id.endsWith(`:${right}`)),
    wrong: btns.find((b) => !b.custom_id.endsWith(`:${right}`)),
    all: btns,
  };
}

async function pressAnswer(h, btn, user) {
  return h.click(btn.custom_id, { user, messageId: btn.messageId, channel: btn.channelId });
}

function wizard(h) {
  return h.sent().filter((m) => /Verify setup/.test(h.textOf(m))).pop();
}

async function step(h, label) {
  const msg = wizard(h);
  assert.ok(msg, 'the setup panel is showing');
  return h.clickButton(label, { user: IDS.admin, in: [msg] });
}

test('the verification gate moves out of Automod with the same role and channel', async () => {
  const store = createMemoryStore();
  store.set('settings', S, { core: {}, apps: { automod: { config: { verify: { enabled: true, channelId: C.welcome, roleId: R.vip } } } } });
  const h = await make({ store });
  const cfg = cfgOf(h);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.channelId, C.welcome);
  assert.equal(cfg.roleId, R.vip);
  assert.equal(cfg.method, 'button');
  assert.equal(cfg.legacy, true);
  assert.equal(cfg.migrated, true);
  assert.equal(h.engine.service('verify').migrate(S), false, 'migration runs once');
  const old = await h.click('yo:automod:verify', { user: IDS.member2, channel: C.welcome });
  assert.match(lastText(h, old), /verified/);
  assert.ok(rolesOf(h, IDS.member2).includes(R.vip));
  const status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /Everything checks out/);
  assert.match(lastText(h, status), /panel from Automod/);
  const pointer = await h.slash('automod', 'verify setup', { user: IDS.admin });
  assert.match(lastText(h, pointer), /Verification moved to the Verify app/);
  const panel = await h.slash('automod', '', { user: IDS.admin });
  assert.match(lastText(h, panel), /moved to the Verify app/);
});

test('migration never overwrites a Verify setup that already exists and skips servers with nothing to move', async () => {
  const store = createMemoryStore();
  store.set('settings', S, { core: {}, apps: { automod: { config: { verify: { enabled: true, channelId: C.welcome, roleId: R.vip } } }, verify: { config: { enabled: true, channelId: C.general, roleId: R.gamer } } } });
  const other = '5e000000-0000-4000-8000-000000000009';
  store.set('settings', other, { core: {}, apps: { automod: { config: { filters: {} } } } });
  const h = await make({ store });
  assert.equal(cfgOf(h).channelId, C.general);
  assert.equal(cfgOf(h).roleId, R.gamer);
  assert.equal(h.engine.settings.raw(S).apps.verify.config.migrated, true);
  assert.equal(h.engine.settings.raw(other).apps.verify, undefined);
  assert.equal(h.engine.settings.appConfig(other, 'verify').enabled, false);
});

test('setup walks an admin through every step, locks channels, verifies a newcomer and undoes it all', async () => {
  const h = await make();
  const before = Object.keys(h.fake.state.overrides).length;
  const first = await h.slash('verify', 'setup', { user: IDS.admin });
  assert.match(lastText(h, first), /Step 1 of 7: Verified role/);
  const sel = h.findButton('Pick the Verified role', [wizard(h)]);
  assert.ok(sel?.isSelect, 'roles come as a menu');
  assert.ok(!sel.options.some((o) => o.value === R.mod || o.value === R.admin), 'mod and admin roles are not offered');
  await h.pick(sel.custom_id, [R.vip], { user: IDS.admin, messageId: wizard(h).id });
  assert.match(h.textOf(wizard(h)), /Step 2 of 7: Unverified role/);
  await step(h, 'Make "Unverified"');
  const unverified = h.fake.state.roles[S].find((r) => r.name === 'Unverified');
  assert.ok(unverified, 'the Unverified role was made');
  assert.deepEqual(unverified.perms, {});
  assert.match(h.textOf(wizard(h)), /Step 3 of 7: Verify channel/);
  await step(h, 'Make #verify');
  const vc = h.fake.state.channels[S].find((c) => c.name === 'verify');
  assert.ok(vc, '#verify was made');
  assert.match(h.textOf(wizard(h)), /Step 4 of 7: How people verify/);
  await step(h, 'Emoji pick');
  assert.match(h.textOf(wizard(h)), /Step 5 of 7: Minimum account age/);
  await step(h, 'Back');
  assert.match(h.textOf(wizard(h)), /Step 4 of 7/);
  await step(h, 'Skip');
  await step(h, 'Skip');
  assert.match(h.textOf(wizard(h)), /Step 6 of 7: Welcome message/);
  const form = await step(h, 'Write my own');
  assert.equal(form[0].type, 'modal');
  await h.submit(form[0].modal.custom_id, { welcome: 'Hi {user}, welcome to {server}!' }, { user: IDS.admin });
  assert.match(h.textOf(wizard(h)), /Step 7 of 7: Hide channels/);
  const lockText = h.textOf(wizard(h));
  assert.match(lockText, /@Unverified\*\*: deny \*\*View Channel/);
  assert.match(lockText, /Members already here are not affected/);
  assert.match(lockText, /#general/);
  assert.match(lockText, /Stays visible: .*#verify/);
  assert.doesNotMatch(lockText, /#mod-log/, 'private channels are left alone');
  assert.equal(Object.keys(h.fake.state.overrides).length, before, 'nothing changes before Finish');
  await step(h, 'Yes, lock 5 channels');
  const summary = h.textOf(wizard(h));
  assert.match(summary, /Check and finish/);
  assert.match(summary, /\*\*VIP\*\*/);
  assert.match(summary, /Emoji pick/);
  const done = await step(h, 'Finish');
  const result = done[done.length - 1];
  assert.match(h.textOf(result), /Verification is on/);
  assert.match(h.textOf(result), /Hid \*\*5\*\* channels/);
  const cfg = cfgOf(h);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.roleId, R.vip);
  assert.equal(cfg.unverifiedRoleId, unverified.id);
  assert.equal(cfg.channelId, vc.id);
  assert.equal(cfg.method, 'emoji');
  assert.equal(h.fake.state.overrides[`${C.general}:${unverified.id}`].deny[0], 'view_channel');
  assert.deepEqual(h.fake.state.overrides[`${vc.id}:${unverified.id}`], { allow: ['view_channel'], deny: [] });
  assert.equal(h.fake.state.overrides[`${C.modlog}:${unverified.id}`], undefined);
  assert.equal(h.fake.state.overrides[`${C.rules}:${unverified.id}`], undefined);
  const panel = h.lastSent(vc.id);
  assert.match(h.textOf(panel), /Verify to join in/);
  const st = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, st), /5 hidden until people verify/, 'the verify channel itself is not counted as hidden');
  assert.ok(h.sent(C.modlog).some((m) => /5 channels are hidden/.test(h.textOf(m))));

  const newbie = uuid(4);
  await h.join(newbie, { username: 'newbie' });
  assert.deepEqual(rolesOf(h, newbie), [unverified.id]);
  const pressed = await h.clickButton('Verify', { user: newbie, in: panel });
  const c = challenge(h, pressed);
  assert.equal(c.all.length, 4);
  const passed = await pressAnswer(h, c.right, newbie);
  assert.match(lastText(h, passed), /You're verified/);
  assert.match(lastText(h, passed), new RegExp(`Hi <@${newbie}>, welcome to Test Town!`));
  assert.deepEqual(rolesOf(h, newbie), [R.vip]);
  assert.ok(h.sent(C.modlog).some((m) => /Verification set up/.test(h.textOf(m))));
  assert.ok(h.sent(C.modlog).some((m) => /Member verified/.test(h.textOf(m))));

  const undone = await h.clickButton('Undo', { user: IDS.admin, in: [stored(h, result.message?.id) || wizardResult(h)] });
  assert.doesNotMatch(lastText(h, undone), /Too late|Only admins/);
  assert.equal(Object.keys(h.fake.state.overrides).length, before, 'every override is back');
  assert.equal(h.fake.state.roles[S].find((r) => r.name === 'Unverified'), undefined, 'the role setup made is gone');
  assert.equal(h.fake.state.channels[S].find((c2) => c2.name === 'verify'), undefined, 'the channel setup made is gone');
  assert.equal(cfgOf(h).enabled, false);
  assert.equal(cfgOf(h).roleId, null);
});

function wizardResult(h) {
  return h.sent().filter((m) => /Verification is on/.test(h.textOf(m))).pop();
}

test('locking without an Unverified role hides channels from everyone, shows them to Verified, and warns about current members', async () => {
  const h = await make();
  await h.slash('verify', 'setup', { user: IDS.admin });
  await h.pick(h.findButton('Pick the Verified role', [wizard(h)]).custom_id, [R.vip], { user: IDS.admin, messageId: wizard(h).id });
  await step(h, 'No Unverified role');
  await h.pick(h.findButton('Pick the verify channel', [wizard(h)]).custom_id, [C.welcome], { user: IDS.admin, messageId: wizard(h).id });
  await step(h, 'Button click');
  await step(h, 'No minimum');
  await step(h, 'Use the default');
  const text = h.textOf(wizard(h));
  assert.match(text, /\*\*@everyone\*\*: deny \*\*View Channel/);
  assert.match(text, /\*\*@VIP\*\*: allow \*\*View Channel/);
  assert.match(text, /member.* here don't have \*\*VIP\*\* yet/);
  h.fake.state.overrides[`${C.general}:everyone`] = { allow: ['add_reactions'], deny: ['attach_files'] };
  await step(h, 'Yes, lock');
  await step(h, 'Finish');
  assert.deepEqual(h.fake.state.overrides[`${C.general}:everyone`], { allow: ['add_reactions'], deny: ['attach_files', 'view_channel'] });
  assert.deepEqual(h.fake.state.overrides[`${C.general}:${R.vip}`], { allow: ['view_channel'], deny: [] });
  assert.deepEqual(h.fake.state.overrides[`${C.welcome}:everyone`], { allow: ['view_channel'], deny: [] });
  const off = await h.slash('verify', 'off', { user: IDS.admin });
  assert.match(lastText(h, off), /still hidden/);
  const shown = await h.clickButton('Show hidden channels again', { user: IDS.admin, in: off });
  assert.match(lastText(h, shown), /visible again/);
  assert.deepEqual(h.fake.state.overrides[`${C.general}:everyone`], { allow: ['add_reactions'], deny: ['attach_files'] });
  assert.equal(h.fake.state.overrides[`${C.general}:${R.vip}`], undefined);
  assert.equal(h.fake.state.overrides[`${C.welcome}:everyone`], undefined);
});

test('a plain button verifies in one press and only once', async () => {
  const h = await make();
  const panel = await ready(h);
  const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(lastText(h, got), /You're verified/);
  assert.ok(rolesOf(h, IDS.member2).includes(R.vip));
  const again = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(lastText(h, again), /already verified/);
});

test('emoji pick: a wrong pick asks again, three wrong picks pause it, the right pick verifies', async () => {
  const h = await make();
  const panel = await ready(h, { method: 'emoji' });
  let c = challenge(h, await h.clickButton('Verify', { user: IDS.member, in: panel }));
  const miss = await pressAnswer(h, c.wrong, IDS.member);
  assert.match(lastText(h, miss), /Not quite/);
  assert.match(lastText(h, miss), /2 tries left/);
  assert.ok(!rolesOf(h, IDS.member).includes(R.vip));
  const stranger = await pressAnswer(h, c.right, IDS.member2);
  assert.match(lastText(h, stranger), /Not your panel/);
  assert.ok(!rolesOf(h, IDS.member2).includes(R.vip));
  c = challenge(h, [stored(h, c.wrong.messageId)]);
  await pressAnswer(h, c.wrong, IDS.member);
  c = challenge(h, [stored(h, c.wrong.messageId)]);
  const out = await pressAnswer(h, c.wrong, IDS.member);
  assert.match(lastText(h, out), /last try/);
  const wait = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, wait), /Take a short break/);
  c = challenge(h, await h.clickButton('Verify', { user: IDS.member2, in: panel }));
  const ok = await pressAnswer(h, c.right, IDS.member2);
  assert.match(lastText(h, ok), /You're verified/);
  assert.ok(rolesOf(h, IDS.member2).includes(R.vip));
});

test('pressing Verify again does not reset wrong answers', async () => {
  const h = await make();
  const panel = await ready(h, { method: 'emoji' });
  for (let i = 0; i < 2; i++) {
    const c = challenge(h, await h.clickButton('Verify', { user: IDS.member, in: panel }));
    assert.match(lastText(h, await pressAnswer(h, c.wrong, IDS.member)), /Not quite/);
  }
  const c = challenge(h, await h.clickButton('Verify', { user: IDS.member, in: panel }));
  assert.match(lastText(h, await pressAnswer(h, c.wrong, IDS.member)), /last try/);
  const wait = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, wait), /Take a short break/);
  assert.ok(!rolesOf(h, IDS.member).includes(R.vip));
});

test('hiding channels from everyone keeps my role and staff roles able to see them', async () => {
  const h = await make();
  await h.slash('verify', 'setup', { user: IDS.admin });
  await h.pick(h.findButton('Pick the Verified role', [wizard(h)]).custom_id, [R.vip], { user: IDS.admin, messageId: wizard(h).id });
  await step(h, 'No Unverified role');
  await h.pick(h.findButton('Pick the verify channel', [wizard(h)]).custom_id, [C.welcome], { user: IDS.admin, messageId: wizard(h).id });
  await step(h, 'Button click');
  await step(h, 'No minimum');
  await step(h, 'Use the default');
  assert.match(h.textOf(wizard(h)), /@YapOS\*\*.*allow \*\*View Channel/);
  await step(h, 'Yes, lock');
  await step(h, 'Finish');
  assert.deepEqual(h.fake.state.overrides[`${C.general}:${R.bot}`], { allow: ['view_channel'], deny: [] });
  assert.deepEqual(h.fake.state.overrides[`${C.general}:${R.mod}`], { allow: ['view_channel'], deny: [] });
  assert.equal(h.fake.state.overrides[`${C.general}:${R.admin}`], undefined, 'Administrator roles see everything already');
  assert.ok(h.fake.state.overrides[`${C.general}:everyone`].deny.includes('view_channel'));
});

test('math question verifies with the right sum', async () => {
  const h = await make();
  const panel = await ready(h, { method: 'math' });
  const pressed = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, pressed), /What is \*\*\d \+ \d\*\*\?/);
  const c = challenge(h, pressed);
  const [, a, b] = /(\d) \+ (\d)/.exec(lastText(h, pressed));
  assert.equal(c.right.label, String(Number(a) + Number(b)));
  const ok = await pressAnswer(h, c.right, IDS.member);
  assert.match(lastText(h, ok), /You're verified/);
});

test('agree to rules shows the rules, lets people decline, and verifies on I agree', async () => {
  const h = await make();
  const panel = await ready(h, { method: 'rules', rulesText: 'Rule one: be nice.' });
  let pressed = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, pressed), /Rule one: be nice/);
  const no = await h.clickButton("I don't agree", { user: IDS.member, in: pressed });
  assert.match(lastText(h, no), /No problem/);
  assert.ok(!rolesOf(h, IDS.member).includes(R.vip));
  pressed = await h.clickButton('Verify', { user: IDS.member, in: panel });
  const yes = await h.clickButton('I agree', { user: IDS.member, in: pressed });
  assert.match(lastText(h, yes), /You're verified/);
  assert.ok(rolesOf(h, IDS.member).includes(R.vip));
});

test('accounts younger than the minimum age are turned away', async () => {
  const h = await make();
  const panel = await ready(h, { minAccountDays: 7 });
  const young = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  h.bot.user = async (id) => ({ id, username: 'x', created_at: id === IDS.member ? young : old });
  const no = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, no), /too new/);
  assert.ok(!rolesOf(h, IDS.member).includes(R.vip));
  assert.ok(h.sent(C.modlog).some((m) => /Account too new/.test(h.textOf(m))));
  const yes = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(lastText(h, yes), /You're verified/);
});

test('a Verify role above mine or without Manage Roles gets a clear dialog, one mod alert and a fix in status', async () => {
  const h = await make();
  const panel = await ready(h);
  role(h, R.vip).position = 8;
  h.engine.perms.invalidate();
  for (let i = 0; i < 4; i++) {
    const got = await h.clickButton('Verify', { user: i % 2 ? IDS.member : IDS.member2, in: panel });
    assert.match(lastText(h, got), /can't verify you right now/);
  }
  assert.equal(h.sent(C.modlog).filter((m) => /Verification is stuck/.test(h.textOf(m))).length, 1);
  let status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /drag my role above \*\*VIP\*\*/);
  assert.ok(h.findButton('Check again', status));
  role(h, R.vip).position = 3;
  delete role(h, R.bot).perms.manage_roles;
  h.engine.perms.invalidate();
  status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /tick \*\*Manage Roles\*\*/);
  role(h, R.bot).perms.manage_roles = true;
  h.engine.perms.invalidate();
  status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /Everything checks out/);
});

test('status finds a deleted channel, role and panel and its buttons fix them', async () => {
  const h = await make();
  const panel = await ready(h);
  h.fake.state.messages[C.welcome].find((m) => m.id === panel.id).deleted = true;
  let status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /panel message was deleted/);
  const fixed = await h.clickButton('Repost the panel', { user: IDS.admin, in: status });
  assert.match(lastText(h, fixed), /Panel posted/);
  assert.notEqual(h.lastSent(C.welcome).id, panel.id);
  h.fake.state.roles[S] = h.fake.state.roles[S].filter((r) => r.id !== R.vip);
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== C.welcome);
  h.engine.cache.invalidate(S);
  status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /Verified role was deleted/);
  assert.match(lastText(h, status), /verify channel was deleted/);
  const pickRole = await h.clickButton('Pick a new role', { user: IDS.admin, in: status });
  assert.match(lastText(h, pickRole), /Step 1 of 7: Verified role/);
  const pickChannel = await h.click('yo:verify:setup:channel', { user: IDS.admin });
  assert.match(lastText(h, pickChannel), /Step 3 of 7: Verify channel/);
});

test('when the roles API is off, pressing Verify says so and the mods hear about it once', async () => {
  const h = await make();
  const panel = await ready(h);
  h.fake.fail('PUT', /\/members\/.*\/roles\//, { status: 403, error: 'Role management is in testing (flag bot_roles)' });
  for (let i = 0; i < 3; i++) {
    const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
    assert.match(lastText(h, got), /couldn't verify you/);
  }
  assert.equal(h.sent(C.modlog).filter((m) => /Verification failed/.test(h.textOf(m))).length, 1);
  assert.equal(h.engine.caps.state(S, 'roles'), false);
  const status = await h.slash('verify', 'status', { user: IDS.admin });
  assert.match(lastText(h, status), /Role changes aren't on for this server yet/);
});

test('setup refuses mod roles, roles above mine, and explains when it cannot make a role', async () => {
  const h = await make({ features: { selects: false } });
  await h.slash('verify', 'setup', { user: IDS.admin });
  assert.ok(h.findButton('VIP', [wizard(h)]), 'buttons stand in for the role menu');
  const risky = await h.click(`yo:verify:wpick:${wizard(h).components[0].components[0].custom_id.split(':')[3]}:role:${R.mod}`, { user: IDS.admin, messageId: wizard(h).id });
  assert.match(lastText(h, risky), /too powerful/);
  const sess = h.allButtons([wizard(h)]).find((b) => b.custom_id.startsWith('yo:verify:wpick:')).custom_id.split(':')[3];
  role(h, R.gamer).position = 8;
  h.engine.perms.invalidate();
  const high = await h.click(`yo:verify:wpick:${sess}:role:${R.gamer}`, { user: IDS.admin, messageId: wizard(h).id });
  assert.match(lastText(h, high), /can't hand out Gamer/);
  assert.match(lastText(h, high), /drag it higher|My role must be above/i);
  h.fake.features.roles = false;
  const made = await step(h, 'Make "Verified"');
  assert.match(lastText(h, made), /can't make roles on this server yet/);
  assert.match(h.textOf(wizard(h)), /Step 1 of 7/);
  const member = await h.click(`yo:verify:wpick:${sess}:role:${R.vip}`, { user: IDS.member, messageId: wizard(h).id });
  assert.match(lastText(h, member), /Only admins|Not your panel/);
  assert.equal(cfgOf(h).roleId, null);
});

test('the lock step explains what is missing when I cannot change channel permissions', async () => {
  const h = await make();
  await h.slash('verify', 'setup', { user: IDS.admin });
  await h.pick(h.findButton('Pick the Verified role', [wizard(h)]).custom_id, [R.vip], { user: IDS.admin, messageId: wizard(h).id });
  await step(h, 'No Unverified role');
  await h.pick(h.findButton('Pick the verify channel', [wizard(h)]).custom_id, [C.welcome], { user: IDS.admin, messageId: wizard(h).id });
  delete role(h, R.bot).perms.manage_roles;
  delete role(h, R.bot).perms.manage_channels;
  h.engine.perms.invalidate();
  await step(h, 'Skip');
  await step(h, 'Skip');
  await step(h, 'Skip');
  assert.match(h.textOf(wizard(h)), /needs \*\*Manage Roles\*\* or \*\*Manage Channels\*\*/);
  assert.ok(!h.findButton('Yes, lock', [wizard(h)]));
  await step(h, 'Leave channels alone');
  assert.match(h.textOf(wizard(h)), /Hide channels:\*\* no/);
});

test('cancelling setup removes what it made and changes nothing', async () => {
  const h = await make();
  await h.slash('verify', 'setup', { user: IDS.admin });
  await step(h, 'Make "Verified"');
  assert.ok(h.fake.state.roles[S].some((r) => r.name === 'Verified'));
  const out = await step(h, 'Cancel');
  assert.match(lastText(h, out), /Setup cancelled/);
  assert.ok(!h.fake.state.roles[S].some((r) => r.name === 'Verified'));
  assert.equal(cfgOf(h).enabled, false);
});

test('test run shows the real check without giving a role', async () => {
  const h = await make();
  await ready(h, { method: 'emoji' });
  const ans = await h.slash('verify', 'test', { user: IDS.admin });
  assert.match(lastText(h, ans), /Test run/);
  assert.match(lastText(h, ans), /Role, channel and panel all check out/);
  const c = challenge(h, ans);
  const passed = await pressAnswer(h, c.right, IDS.admin);
  assert.match(lastText(h, passed), /Test passed/);
  assert.ok(!rolesOf(h, IDS.admin).includes(R.vip));
});

test('mods can let someone in by hand, it is logged, and members cannot', async () => {
  const h = await make();
  await ready(h, { unverifiedRoleId: R.gamer });
  h.fake.memberOf(S, IDS.member2).roles.push(R.gamer);
  const no = await h.slash('verify', `user <@${IDS.member}>`, { user: IDS.member });
  assert.match(lastText(h, no), /Only moderators/);
  const ok = await h.slash('verify', `user <@${IDS.member2}>`, { user: IDS.mod });
  assert.match(lastText(h, ok), /is verified/);
  assert.deepEqual(rolesOf(h, IDS.member2), [R.member, R.vip]);
  assert.ok(h.sent(C.modlog).some((m) => /Verified by hand/.test(h.textOf(m))));
});

test('off stops the button and Undo turns it back on; setup and off are admin only', async () => {
  const h = await make();
  const panel = await ready(h);
  for (const text of ['setup', 'off', 'panel', 'test']) {
    const ans = await h.slash('verify', text, { user: IDS.member });
    assert.match(lastText(h, ans), /Only admins/, text);
  }
  const off = await h.slash('verify', 'off', { user: IDS.admin });
  assert.match(lastText(h, off), /Verification off/);
  const pressed = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(lastText(h, pressed), /Verification is off/);
  await h.clickButton('Undo', { user: IDS.admin, in: off });
  assert.equal(cfgOf(h).enabled, true);
  const away = await h.click('yo:verify:go', { user: IDS.member, server: '5e000000-0000-4000-8000-000000000002', channel: C.general });
  assert.match(lastText(h, away), /Verification is off/);
  assert.ok(!rolesOf(h, IDS.member).includes(R.vip));
});

test('a member typing /verify gets the check, and uninstalling the app stops the button', async () => {
  const h = await make();
  const panel = await ready(h);
  const typed = await h.slash('verify', '', { user: IDS.member });
  assert.match(lastText(h, typed), /You're verified/);
  h.engine.settings.setEnabled(S, 'verify', false);
  const pressed = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(lastText(h, pressed), /isn't installed here/);
});

test('help explains verification in plain steps and the main help points to it', async () => {
  const h = await createHarness({ apps: ['verify'] });
  const app = await h.slash('help', 'verify', { user: IDS.member });
  const text = lastText(h, app);
  assert.match(text, /\/verify setup/);
  assert.match(text, /Example/);
  assert.match(text, /\/verify status/);
  const all = await h.slash('help', '', { user: IDS.member });
  assert.match(lastText(h, all), /\/help verify/);
  const guide = await h.slash('verify', 'help', { user: IDS.admin });
  assert.match(lastText(h, guide), /Set it up in about a minute/);
  assert.equal(h.engine.apps.get('verify').meta.category, 'Security');
});

test('an everyday role everyone has cannot be the Unverified role', async () => {
  const h = await make();
  await h.slash('verify', 'setup', { user: IDS.admin });
  await h.pick(h.findButton('Pick the Verified role', [wizard(h)]).custom_id, [R.vip], { user: IDS.admin, messageId: wizard(h).id });
  const sel = h.findButton('Pick the Unverified role', [wizard(h)]) || h.allButtons([wizard(h)]).find((b) => b.isSelect);
  await h.pick(sel.custom_id, [R.member], { user: IDS.admin, messageId: wizard(h).id });
  const text = h.textOf(wizard(h));
  assert.match(text, /can't be the Unverified role/);
  assert.match(text, /Step 2 of 7/);
});
