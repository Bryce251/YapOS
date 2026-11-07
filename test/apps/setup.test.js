import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';

const S = IDS.server;
const C = IDS.channels;
const R = IDS.roles;
const ADMIN = { user: IDS.admin };

function addDummies(h, { failApply = false } = {}) {
  const calls = [];
  h.engine.apps.register(
    { id: 'greeter', name: 'Greeter', icon: '👋', description: 'Says hi to newcomers', defaults: { greeting: 'hello' }, core: false, defaultEnabled: true },
    {
      presets: { gaming: { enabled: true, config: { greeting: 'gg' } }, study: { enabled: false } },
      applyPreset: async (engine, sid, opts) => {
        calls.push({ sid, ...opts });
        if (failApply) { const e = new Error('Missing permission'); e.status = 403; throw e; }
        return `Greeter will say hi in #${opts.channels.welcome?.name || 'nowhere'}`;
      },
      commands: {},
    },
  );
  h.engine.apps.register(
    { id: 'rolekit', name: 'Rolekit', icon: '🎭', description: 'Self roles', defaults: {}, core: false, defaultEnabled: true },
    { presets: { gaming: { enabled: false }, community: { enabled: true } }, botPerms: ['manage_roles'], commands: {} },
  );
  h.engine.apps.register(
    { id: 'plain', name: 'Plain', icon: '📦', description: 'An app with no presets', defaults: {}, core: false, defaultEnabled: false },
    { commands: {} },
  );
  return calls;
}

const last = (ans) => ans[ans.length - 1];
const sessionOf = (h, ans) => {
  const b = h.allButtons(ans).find((x) => /^yo:setup:(step|preset|cancel|boot):/.test(x.custom_id));
  return b.custom_id.split(':')[3];
};

const make = (opts = {}) => createHarness({ apps: ['setup'], ...opts });

async function clickLabel(h, ans, label, opts = ADMIN) {
  const b = h.findButton(label, ans);
  assert.ok(b, `button "${label}" missing. Have: ${h.allButtons(ans).map((x) => x.label).join(', ')}`);
  return h.click(b.custom_id, opts);
}

test('full first boot wizard by clicks', async () => {
  const h = await make();
  const calls = addDummies(h);
  let ans = await h.slash('setup', '', ADMIN);
  const first = last(ans);
  assert.equal(first.type, 'reply', 'panels with buttons are normal messages');
  assert.match(h.textOf(first), /First boot/);
  assert.match(h.textOf(first), /Friends hangout/);
  assert.match(h.textOf(first), /Custom/);
  const sel = h.allButtons(ans).find((b) => b.isSelect);
  assert.ok(sel, 'preset select menu shown');
  const sid = sessionOf(h, ans);

  ans = await h.pick(sel.custom_id, ['gaming'], ADMIN);
  let text = h.textOf(last(ans));
  assert.match(text, /Step 2 of 6/);
  assert.match(text, /👋・welcome/);
  assert.match(text, /📜┃rules/);
  assert.match(text, /mod-log/);
  assert.match(text, /announcements/);
  assert.match(text, /get-roles/);
  assert.match(text, /Verify\*\*: \*skipped\*/);

  ans = await clickLabel(h, ans, 'Next');
  text = h.textOf(last(ans));
  assert.match(text, /Apps to install/);
  assert.match(text, /🟢 👋 \*\*Greeter/);
  assert.match(text, /⚪ 🎭 \*\*Rolekit/);
  assert.match(text, /⚪ 📦 \*\*Plain/);
  ans = await clickLabel(h, ans, 'Rolekit');
  assert.match(h.textOf(last(ans)), /🟢 🎭 \*\*Rolekit/);

  ans = await clickLabel(h, ans, 'Next');
  text = h.textOf(last(ans));
  assert.match(text, /Staff roles/);
  assert.match(text, /Mods\*\* \(from permissions\): \*\*@Moderator/);
  assert.match(text, /Admins\*\* \(from permissions\): .*@Admin/);
  assert.ok(!/@YapOS/.test(text), 'the bot role is not offered as staff');
  ans = await clickLabel(h, ans, '@VIP');
  assert.match(h.textOf(last(ans)), /Extra mod roles\*\*: \*\*@VIP/);

  ans = await clickLabel(h, ans, 'Next');
  text = h.textOf(last(ans));
  assert.match(text, /Permission check/);
  assert.match(text, /✅ \*\*Manage Roles/);
  assert.match(text, /✅ \*\*Role position/);

  ans = await clickLabel(h, ans, 'Next');
  text = h.textOf(last(ans));
  assert.match(text, /Review and boot/);
  assert.match(text, /Gaming/);
  assert.equal(h.sent().filter((m) => !m.flags && !/First boot|Setup|Channels|Apps|Staff|Permissions|Review/.test(h.textOf(m))).length, 0, 'nothing posted before Boot except the wizard panel');
  assert.equal(h.engine.settings.core(S).setupDone, false);

  ans = await clickLabel(h, ans, 'Boot');
  assert.equal(ans[0].type, 'update', 'answers the click first');
  assert.match(h.textOf(ans[0]), /Booting/);
  const done = last(ans);
  text = h.textOf(done);
  assert.match(text, /Boot complete/);
  assert.match(text, /Greeter will say hi in #👋・welcome/);
  assert.ok(h.findButton('Open menu', done));
  assert.ok(h.findButton('Undo', done));

  const core = h.engine.settings.core(S);
  assert.equal(core.preset, 'gaming');
  assert.equal(core.logChannel, C.modlog);
  assert.deepEqual(core.modRoles, [R.vip]);
  assert.equal(core.setupDone, true);
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), true);
  assert.equal(h.engine.settings.isEnabled(S, 'rolekit'), true);
  assert.equal(h.engine.settings.isEnabled(S, 'plain'), false);
  assert.equal(h.engine.settings.appConfig(S, 'greeter').greeting, 'gg');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preset, 'gaming');
  assert.equal(calls[0].channels.welcome.id, C.welcome);
  assert.equal(calls[0].channels.logs.id, C.modlog);

  const stale = await h.click(`yo:setup:step:${sid}:apps`, ADMIN);
  assert.match(h.textOf(stale[0]), /expired/);

  const menu = await h.click('yo:setup:menu', ADMIN);
  assert.ok(menu.length, 'menu button answers');
  assert.match(h.textOf(last(menu)), /YapOS|menu/i);
});

test('select menus off: presets and channels fall back to buttons', async () => {
  const h = await make({ features: { selects: false } });
  addDummies(h);
  let ans = await h.slash('setup', '', ADMIN);
  const shown = last(ans);
  assert.ok(!JSON.stringify(shown.components).includes('"select"'), 'no select in the fallback');
  assert.ok(h.findButton('Gaming', shown));
  assert.ok(h.findButton('Roleplay', shown));
  assert.equal(h.engine.caps.state(S, 'selects'), false);
  ans = await clickLabel(h, [shown], 'Study');
  assert.match(h.textOf(last(ans)), /Step 2 of 6/);

  ans = await clickLabel(h, ans, 'Logs');
  const picker = last(ans);
  assert.ok(!JSON.stringify(picker.components).includes('"select"'));
  assert.match(h.textOf(picker), /Pick the logs channel/);
  ans = await clickLabel(h, [picker], '#general');
  assert.match(h.textOf(last(ans)), /Logs\*\*: <#c0000000-0000-4000-8000-000000000001> \(#general\)/);

  ans = await clickLabel(h, ans, 'Welcome');
  ans = await clickLabel(h, ans, 'Skip this one');
  assert.match(h.textOf(last(ans)), /Welcome\*\*: \*skipped\*/);
});

test('select menus on: channel picker uses a select', async () => {
  const h = await make();
  let ans = await h.slash('setup', 'preset community', ADMIN);
  ans = await clickLabel(h, ans, 'Announcements');
  const sel = h.allButtons(ans).find((b) => b.isSelect);
  assert.ok(sel);
  ans = await h.pick(sel.custom_id, [C.general], ADMIN);
  assert.match(h.textOf(last(ans)), /Announcements\*\*: <#c0000000-0000-4000-8000-000000000001>/);
});

test('permission check warns when the bot role lacks Manage Roles or sits too low', async () => {
  const h = await make();
  addDummies(h);
  const botRole = h.fake.state.roles[S].find((r) => r.id === R.bot);
  delete botRole.perms.manage_roles;
  let ans = await h.slash('setup', '', ADMIN);
  const sel = h.allButtons(ans).find((b) => b.isSelect);
  ans = await h.pick(sel.custom_id, ['community'], ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:perms`, ADMIN);
  let text = h.textOf(last(ans));
  assert.match(text, /❌ \*\*Manage Roles\*\*: needed by Rolekit/);
  assert.match(text, /turn on \*\*Manage Roles/);
  assert.match(text, /You can boot anyway/);

  botRole.perms.manage_roles = true;
  h.fake.state.roles[S].find((r) => r.id === R.member).position = 8;
  ans = await clickLabel(h, ans, 'Check again');
  text = h.textOf(last(ans));
  assert.match(text, /✅ \*\*Manage Roles/);
  assert.match(text, /Drag \*\*YapOS\*\* above \*\*@Member\*\*/);

  ans = await clickLabel(h, ans, 'Next');
  assert.match(h.textOf(last(ans)), /Permission notes/);
  ans = await clickLabel(h, ans, 'Boot');
  assert.match(h.textOf(last(ans)), /Still to fix: Drag YapOS above @Member/);
});

test('members and mods are refused', async () => {
  const h = await make();
  const denied = await h.slash('setup', '', { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only admins/);
  const mod = await h.slash('setup', 'status', { user: IDS.mod });
  assert.match(h.textOf(mod[0]), /Only admins/);
  const ans = await h.slash('setup', '', ADMIN);
  const sid = sessionOf(h, ans);
  const click = await h.click(`yo:setup:step:${sid}:apps`, { user: IDS.member });
  assert.match(h.textOf(click[0]), /Only admins/);
  const other = await h.click(`yo:setup:step:${sid}:apps`, { user: IDS.owner });
  assert.match(h.textOf(other[0]), /someone else's setup/);
  await h.message('/setup preset gaming', { user: IDS.member });
  assert.match(h.textOf(h.lastSent(C.general)), /Only admins/);
  assert.equal(h.engine.settings.core(S).preset, null);
});

test('rerun shows current config, reset asks first, undo restores', async () => {
  const h = await make();
  addDummies(h);
  let ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  await clickLabel(h, ans, 'Boot');
  assert.equal(h.engine.settings.isEnabled(S, 'rolekit'), false);

  ans = await h.slash('setup', '', ADMIN);
  const status = last(ans);
  let text = h.textOf(status);
  assert.match(text, /✅ done/);
  assert.match(text, /Gaming/);
  assert.match(text, /Greeter/);
  assert.ok(h.findButton('Run again', status));

  ans = await clickLabel(h, [status], 'Reset to defaults');
  assert.match(h.textOf(last(ans)), /Reset YapOS to defaults\?/);
  assert.equal(h.engine.settings.core(S).setupDone, true, 'nothing changes before confirming');
  const keep = await clickLabel(h, ans, 'Keep my settings');
  assert.match(h.textOf(last(keep)), /Kept your settings/);

  ans = await h.click('yo:setup:resetyes', ADMIN);
  const resetCard = last(ans);
  assert.match(h.textOf(resetCard), /Reset done/);
  let core = h.engine.settings.core(S);
  assert.equal(core.setupDone, false);
  assert.equal(core.preset, null);
  assert.equal(core.logChannel, null);
  assert.equal(h.engine.settings.isEnabled(S, 'rolekit'), true);
  assert.equal(h.engine.settings.appConfig(S, 'greeter').greeting, 'hello');

  const undo = await clickLabel(h, [resetCard], 'Undo');
  assert.match(h.textOf(last(undo)), /Undone/);
  core = h.engine.settings.core(S);
  assert.equal(core.setupDone, true);
  assert.equal(core.preset, 'gaming');
  assert.equal(core.logChannel, C.modlog);
  assert.equal(h.engine.settings.isEnabled(S, 'rolekit'), false);
  assert.equal(h.engine.settings.appConfig(S, 'greeter').greeting, 'gg');

  ans = await h.slash('setup', '', ADMIN);
  ans = await clickLabel(h, ans, 'Run again');
  text = h.textOf(last(ans));
  assert.match(text, /First boot/);
  assert.match(text, /Current pick: \*\*🎮 Gaming/);
});

test('undo after boot restores the earlier settings', async () => {
  const h = await make();
  addDummies(h);
  let ans = await h.slash('setup', 'preset study', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  ans = await clickLabel(h, ans, 'Boot');
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), false);
  await clickLabel(h, [last(ans)], 'Undo');
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), true);
  assert.equal(h.engine.settings.core(S).setupDone, false);
});

test('typed shortcuts: preset, channel, status', async () => {
  const h = await make();
  addDummies(h);
  await h.message('/setup preset gaming', ADMIN);
  let m = h.lastSent(C.general);
  assert.match(h.textOf(m), /Server type set to \*\*Gaming\*\*/);
  assert.match(h.textOf(m), /Step 2 of 6/);

  await h.message('/setup channel logs #general', ADMIN);
  m = h.lastSent(C.general);
  assert.match(h.textOf(m), /Logs\*\* channel is now <#c0000000-0000-4000-8000-000000000001>/);
  assert.match(h.textOf(m), /finish first boot/);
  const back = h.findButton('Back to setup', m);
  assert.ok(back, 'links back to the open wizard');
  const ans = await h.click(back.custom_id, ADMIN);
  assert.match(h.textOf(last(ans)), /Logs\*\*: <#c0000000-0000-4000-8000-000000000001>/);

  await h.message('/setup channel log #mod-log', ADMIN);
  assert.match(h.textOf(h.lastSent(C.general)), /Logs\*\* channel is now <#c0000000-0000-4000-8000-000000000004>/);
  await h.message('/setup channel verify none', ADMIN);
  assert.match(h.textOf(h.lastSent(C.general)), /Verify\*\* channel is now skipped/);
  await h.message('/setup channel wat #general', ADMIN);
  assert.match(h.textOf(h.lastSent(C.general)), /don't know the "wat" slot/);
  await h.message('/setup channel logs #does-not-exist-at-all', ADMIN);
  assert.match(h.textOf(h.lastSent(C.general)), /couldn't find that channel/);
  await h.message('/setup preset spaceship', ADMIN);
  assert.match(h.textOf(h.lastSent(C.general)), /don't know that server type/);

  await h.message('/setup status', ADMIN);
  m = h.lastSent(C.general);
  assert.match(h.textOf(m), /not yet/);
  assert.match(h.textOf(m), /mod-log/);

  const st = await h.slash('setup', 'status', ADMIN);
  assert.match(h.textOf(last(st)), /Setup/);
  const typo = await h.slash('setup', 'stauts', ADMIN);
  assert.match(h.textOf(last(typo)), /Did you mean \*\*status\*\*/);
});

test('channel shortcut after boot updates the log channel and can be undone', async () => {
  const h = await make();
  let ans = await h.slash('setup', 'preset friends', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  await clickLabel(h, ans, 'Boot');
  assert.equal(h.engine.settings.core(S).logChannel, C.modlog);
  ans = await h.slash('setup', 'channel logs #general', ADMIN);
  assert.equal(h.engine.settings.core(S).logChannel, C.general);
  await clickLabel(h, [last(ans)], 'Undo');
  assert.equal(h.engine.settings.core(S).logChannel, C.modlog);
});

test('yap words reach setup', async () => {
  const h = await make();
  const ans = await h.slash('yap', 'preset study', ADMIN);
  assert.match(h.textOf(last(ans)), /Server type set to \*\*Study\*\*/);
  const boot = await h.slash('yap', 'boot', ADMIN);
  assert.match(h.textOf(last(boot)), /First boot/);
  const denied = await h.slash('yap', 'setup', { user: IDS.member });
  assert.match(h.textOf(last(denied)), /Only admins/);
});

test('works with no other apps installed', async () => {
  const h = await make();
  let ans = await h.slash('setup', '', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.pick(h.allButtons(ans).find((b) => b.isSelect).custom_id, ['custom'], ADMIN);
  ans = await h.click(`yo:setup:step:${sid}:apps`, ADMIN);
  assert.match(h.textOf(last(ans)), /No other apps are installed/);
  ans = await h.click(`yo:setup:step:${sid}:perms`, ADMIN);
  assert.match(h.textOf(last(ans)), /need no special permissions/);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  ans = await clickLabel(h, ans, 'Boot');
  assert.match(h.textOf(last(ans)), /Boot complete/);
  assert.match(h.textOf(last(ans)), /No extra apps installed/);
  assert.equal(h.engine.settings.core(S).preset, 'custom');
});

test('an app that fails its preset step gets a friendly line, boot still finishes', async () => {
  const h = await make();
  addDummies(h, { failApply: true });
  let ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  ans = await clickLabel(h, ans, 'Boot');
  const text = h.textOf(last(ans));
  assert.match(text, /Boot complete/);
  assert.match(text, /Greeter couldn't finish its part/);
  assert.ok(!/403/.test(text));
  assert.equal(h.engine.settings.core(S).setupDone, true);
});

test('cancel closes without changes, and nothing is posted on its own', async () => {
  const h = await make();
  await h.join('a0000000-0000-4000-8000-0000000000aa', { username: 'newbie' });
  assert.equal(h.sent().length, 0, 'no automatic posts');
  let ans = await h.slash('setup', '', ADMIN);
  ans = await clickLabel(h, ans, 'Cancel');
  assert.match(h.textOf(last(ans)), /Setup closed/);
  assert.equal(h.engine.settings.core(S).setupDone, false);
  assert.equal(h.sent().filter((m) => !/Setup closed|First boot/.test(h.textOf(m))).length, 0, 'only the wizard panel itself');
});

test('typed status and reset panels stay up long enough to use their buttons', async () => {
  const h = await make();
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 1000) delays.push(ms); return real(fn, ms, ...rest); };
  try {
    await h.message('/setup status', ADMIN);
    await h.message('/setup reset', ADMIN);
    await h.message('/setup channel logs #mod-log', ADMIN);
  } finally {
    globalThis.setTimeout = real;
  }
  assert.ok(!delays.includes(20_000), 'no panel uses the short 20 second lifetime');
  assert.equal(delays.filter((ms) => ms === 15 * 60_000).length, 2);
  assert.ok(delays.includes(2 * 60_000), 'the saved note with Undo stays for two minutes');
});

test('a setup panel from another server is refused', async () => {
  const h = await make();
  const S2 = '5e000000-0000-4000-8000-000000000002';
  h.fake.state.servers[S2] = { ...h.fake.state.servers[S], id: S2, name: 'Other Town' };
  h.fake.state.roles[S2] = structuredClone(h.fake.state.roles[S]);
  h.fake.state.members[S2] = structuredClone(h.fake.state.members[S]);
  const ans = await h.slash('setup', '', ADMIN);
  const sid = sessionOf(h, ans);
  const cross = await h.click(`yo:setup:boot:${sid}`, { ...ADMIN, server: S2 });
  assert.match(h.textOf(cross[0]), /someone else's setup/);
  assert.equal(h.engine.settings.core(S2).setupDone, false);
  assert.equal(h.engine.settings.core(S).setupDone, false);
});

test('crafted mod role clicks are checked against real roles', async () => {
  const h = await make();
  let ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:modrole:${sid}:${R.bot}`, ADMIN);
  assert.match(h.textOf(last(ans)), /can't use that role/);
  ans = await h.click(`yo:setup:modrole:${sid}:not-a-role`, ADMIN);
  assert.match(h.textOf(last(ans)), /can't use that role/);
  ans = await h.click(`yo:setup:modrole:${sid}:${R.gamer}`, ADMIN);
  assert.match(h.textOf(last(ans)), /Extra mod roles\*\*: \*\*@Gamer/);
  ans = await h.click(`yo:setup:modrole:${sid}:${R.gamer}`, ADMIN);
  assert.match(h.textOf(last(ans)), /Extra mod roles\*\*: \*none\*/);
});

test('boot still finishes when the panel can no longer be edited', async () => {
  const h = await make();
  addDummies(h);
  let ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  ans = await h.click(`yo:setup:step:${sid}:review`, ADMIN);
  h.fake.fail('POST', /\/interactions\/.+\/callback$/, { status: 404, error: 'Unknown message', times: 1 });
  ans = await clickLabel(h, ans, 'Boot');
  assert.match(h.textOf(last(ans)), /Boot complete/);
  assert.equal(h.engine.settings.core(S).setupDone, true);
  assert.equal(h.engine.settings.appConfig(S, 'greeter').greeting, 'gg');
});
