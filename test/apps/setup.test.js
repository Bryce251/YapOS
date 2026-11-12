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
  return h.click(b.custom_id, { messageId: b.messageId, ...opts });
}

const MEMBER = { user: IDS.member };
const panelOf = (ans) => ans.find((a) => a.message)?.message.id;
const memberCtx = (h, user = IDS.member) => h.engine.contextFor({ id: 'forged', server_id: S, channel_id: C.general, author_id: user, author: { id: user, username: 'sam' }, content: '' }, { app: 'setup' });

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

const wizardIds = (sid) => [
  `yo:setup:step:${sid}:review`, `yo:setup:preset:${sid}:study`, `yo:setup:slot:${sid}:logs`, `yo:setup:pickch:${sid}:logs:${C.general}`,
  `yo:setup:skipch:${sid}:welcome`, `yo:setup:app:${sid}:plain`, `yo:setup:modrole:${sid}:${R.member}`, `yo:setup:recheck:${sid}`,
  `yo:setup:boot:${sid}`, `yo:setup:cancel:${sid}`,
];

test("a member pressing an admin's wizard gets Not your panel, and so does another admin", async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const mid = panelOf(ans);
  assert.ok(mid, 'the wizard is a real message');
  assert.equal(h.engine.router.panelOwner(mid), IDS.admin);
  const sid = sessionOf(h, ans);
  for (const id of [...wizardIds(sid), 'yo:setup:menu']) {
    for (const user of [IDS.member, IDS.mod, IDS.owner]) {
      const out = await h.click(id, { user, messageId: mid });
      assert.match(h.textOf(out[0]), /Not your panel/, `${id} pressed by ${user}`);
      assert.equal(out.length, 1);
    }
  }
  const s = h.engine.router.getSession(sid);
  assert.equal(s.preset, 'gaming');
  assert.equal(s.channels.logs, C.modlog);
  assert.equal(s.channels.welcome, C.welcome);
  assert.equal(s.apps.plain, false);
  assert.deepEqual(s.modRoles, []);
  assert.equal(h.engine.settings.core(S).setupDone, false);
  const mine = await h.click(`yo:setup:step:${sid}:review`, { ...ADMIN, messageId: mid });
  assert.match(h.textOf(last(mine)), /Review and boot/, 'the opener can still use it');
});

test('forged or leftover wizard buttons are refused by role', async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  const ids = [...wizardIds(sid), 'yo:setup:again', 'yo:setup:reset', 'yo:setup:resetno', 'yo:setup:resetyes'];
  for (const id of ids) {
    for (const user of [IDS.member, IDS.mod]) {
      const out = await h.click(id, { user });
      assert.match(h.textOf(out[0]), /Only admins/, `${id} pressed by ${user}`);
      assert.ok(!/403/.test(h.textOf(out[0])));
    }
  }
  const s = h.engine.router.getSession(sid);
  assert.ok(s, 'the session survives forged cancel and boot clicks');
  assert.equal(s.preset, 'gaming');
  assert.equal(s.channels.logs, C.modlog);
  assert.deepEqual(s.modRoles, []);
  assert.equal(h.engine.settings.core(S).setupDone, false);
  for (const id of wizardIds(sid)) {
    const out = await h.click(id, { user: IDS.owner });
    assert.match(h.textOf(out[0]), /someone else's setup/, `${id} pressed by another admin`);
  }
  assert.equal(h.engine.router.getSession(sid).preset, 'gaming');
  assert.equal(h.engine.settings.core(S).setupDone, false);
});

test('status and reset panels: locked to the opener, and refused by role without the lock', async () => {
  const h = await make();
  addDummies(h);
  let ans = await h.slash('setup', 'preset gaming', ADMIN);
  ans = await h.click(`yo:setup:step:${sessionOf(h, ans)}:review`, ADMIN);
  await clickLabel(h, ans, 'Boot');
  const status = await h.slash('setup', '', ADMIN);
  const mid = panelOf(status);
  assert.equal(h.engine.router.panelOwner(mid), IDS.admin);
  for (const label of ['Run again', 'Reset to defaults', 'Open menu']) {
    const b = h.findButton(label, status);
    const out = await h.click(b.custom_id, { ...MEMBER, messageId: mid });
    assert.match(h.textOf(out[0]), /Not your panel/, label);
  }
  const confirm = await clickLabel(h, status, 'Reset to defaults', { ...ADMIN, messageId: mid });
  assert.match(h.textOf(last(confirm)), /Reset YapOS to defaults\?/);
  for (const id of ['yo:setup:resetyes', 'yo:setup:resetno']) {
    const locked = await h.click(id, { ...MEMBER, messageId: mid });
    assert.match(h.textOf(locked[0]), /Not your panel/);
    const forged = await h.click(id, { user: IDS.mod });
    assert.match(h.textOf(forged[0]), /Only admins/);
  }
  assert.equal(h.engine.settings.core(S).setupDone, true, 'nothing was reset');
  assert.equal(h.engine.settings.core(S).preset, 'gaming');
  const done = await h.click('yo:setup:resetyes', { ...ADMIN, messageId: mid });
  assert.match(h.textOf(last(done)), /Reset done/);
  assert.equal(h.engine.settings.core(S).setupDone, false);
});

test('undo buttons: only the opener on the panel, only admins anywhere', async () => {
  const h = await make();
  addDummies(h);
  let ans = await h.slash('setup', 'preset study', ADMIN);
  ans = await h.click(`yo:setup:step:${sessionOf(h, ans)}:review`, ADMIN);
  ans = await clickLabel(h, ans, 'Boot');
  const undo = h.findButton('Undo', last(ans));
  assert.ok(undo.messageId, 'the boot result is its own message');
  assert.equal(h.engine.router.panelOwner(undo.messageId), IDS.admin);
  let out = await h.click(undo.custom_id, { ...MEMBER, messageId: undo.messageId });
  assert.match(h.textOf(out[0]), /Not your panel/);
  out = await h.click(undo.custom_id, { user: IDS.owner, messageId: undo.messageId });
  assert.match(h.textOf(out[0]), /Not your panel/);
  out = await h.click(undo.custom_id, MEMBER);
  assert.match(h.textOf(out[0]), /Only admins/);
  out = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(h.textOf(out[0]), /Only admins/);
  assert.equal(h.engine.settings.core(S).setupDone, true, 'still booted');
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), false);
  out = await h.click(undo.custom_id, { ...ADMIN, messageId: undo.messageId });
  assert.match(h.textOf(last(out)), /Undone/);
  assert.equal(h.engine.settings.core(S).setupDone, false);

  const saved = await h.slash('setup', 'channel logs #general', ADMIN);
  const undo2 = h.findButton('Undo', last(saved));
  assert.equal(h.engine.router.panelOwner(undo2.messageId), IDS.admin);
  out = await h.click(undo2.custom_id, { ...MEMBER, messageId: undo2.messageId });
  assert.match(h.textOf(out[0]), /Not your panel/);
  out = await h.click(undo2.custom_id, MEMBER);
  assert.match(h.textOf(out[0]), /Only admins/);
  assert.equal(h.engine.store.get('setup', S, {}).channels.logs, C.general);
});

test('home screen tile and plain words never show setup to non-admins', async () => {
  const h = await make();
  for (const user of [IDS.member, IDS.mod]) {
    const tile = await h.click('yo:system:open:setup', { user });
    assert.match(h.textOf(last(tile)), /Setup is for admins/);
    assert.equal(h.allButtons(tile).length, 0, 'no setup buttons are shown');
    for (const words of ['setup', 'boot', 'preset gaming', 'setup reset', 'setup channel logs #general']) {
      const out = await h.slash('yap', words, { user });
      assert.match(h.textOf(last(out)), /Only admins/, words);
      assert.equal(h.allButtons(out).length, 0);
    }
  }
  assert.equal(h.engine.settings.core(S).preset, null);
  assert.equal(h.engine.store.get('setup', S, null), null);
  const tile = await h.click('yo:system:open:setup', ADMIN);
  assert.match(h.textOf(last(tile)), /First boot has not run yet/);
  const mid = panelOf(tile);
  assert.equal(h.engine.router.panelOwner(mid), IDS.admin, 'the opened panel belongs to whoever clicked the tile');
  const poke = await h.click('yo:setup:again', { ...MEMBER, messageId: mid });
  assert.match(h.textOf(poke[0]), /Not your panel/);
});

test('handlers check the role themselves, not only the router', async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  const handlers = h.engine.router.handlers;
  for (const action of ['preset', 'step', 'recheck', 'slot', 'pickch', 'skipch', 'app', 'modrole', 'cancel', 'boot', 'again', 'reset', 'resetno', 'resetyes']) {
    const ctx = memberCtx(h);
    ctx.argv = [sid, 'review'];
    await assert.rejects(() => handlers.get(`setup:${action}`).run(ctx), /Only admins/, action);
  }
  const route = h.engine.yap.find('setup');
  const yapCtx = memberCtx(h, IDS.mod);
  yapCtx.argv = ['reset'];
  yapCtx.word = 'setup';
  await assert.rejects(() => route.run(yapCtx), /Only admins/);
  const cmd = h.engine.apps.get('setup').def.commands.setup;
  const cmdCtx = memberCtx(h);
  cmdCtx.argv = ['channel', 'logs', '#general'];
  await assert.rejects(() => cmd.run(cmdCtx), /Only admins/);
  assert.ok(h.engine.router.getSession(sid), 'the admin session is untouched');
  assert.equal(h.engine.settings.core(S).setupDone, false);
  assert.equal(h.engine.store.get('setup', S, null), null);
});

test('the menu button gives each person their own home screen', async () => {
  const h = await make();
  const out = await h.click('yo:setup:menu', MEMBER);
  assert.ok(out.length);
  assert.ok(!/Only admins|Not your panel/.test(h.textOf(last(out))));
  const mid = panelOf(out);
  assert.ok(mid, 'the home screen is a message');
  assert.equal(h.engine.router.panelOwner(mid), IDS.member);
  assert.equal(h.engine.settings.core(S).setupDone, false);
});

const S2 = '5e000000-0000-4000-8000-000000000002';
const C2 = 'c0000000-0000-4000-8000-0000000000b1';
const HELPER = 'r0000000-0000-4000-8000-0000000000aa';
const THERE = { user: IDS.member, server: S2, channel: C2 };
const staffIds = ['yo:setup:again', 'yo:setup:reset', 'yo:setup:resetno', 'yo:setup:resetyes'];

function addSecondServer(h) {
  const st = h.fake.state;
  st.servers[S2] = { ...st.servers[S], id: S2, name: 'Other Town', owner_id: IDS.member };
  st.roles[S2] = structuredClone(st.roles[S]);
  st.members[S2] = structuredClone(st.members[S]);
  st.channels[S2] = [{ id: C2, name: 'general', type: 'text', kind: 'text', server_id: S2, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[S2] = [];
  st.everyone[S2] = { send_messages: true, view_channel: true };
  st.roles[S].push({ id: HELPER, name: 'Helper', color: null, position: 2, perms: {}, auto: null, mentionable: false });
}

async function bootAs(h, preset = 'gaming') {
  let ans = await h.slash('setup', `preset ${preset}`, ADMIN);
  ans = await h.click(`yo:setup:step:${sessionOf(h, ans)}:review`, ADMIN);
  return clickLabel(h, ans, 'Boot');
}

test('a member cannot press setup buttons through a panel they opened themselves', async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  for (const user of [IDS.member, IDS.mod]) {
    const own = await h.slash('menu', '', { user });
    const mid = panelOf(own);
    assert.equal(h.engine.router.panelOwner(mid), user, 'their own home screen is theirs');
    for (const id of [...wizardIds(sid), ...staffIds]) {
      const asButton = await h.click(id, { user, messageId: mid });
      assert.match(h.textOf(asButton[0]), /Only admins/, `${id} as a button`);
      const asSelect = await h.pick(id, [C.general, 'gaming', R.member], { user, messageId: mid });
      assert.match(h.textOf(asSelect[0]), /Only admins/, `${id} as a select`);
      const asForm = await h.submit(id, { 0: 'gaming', preset: 'gaming', channel: C.general, role: R.member }, { user, messageId: mid });
      assert.match(h.textOf(asForm[0]), /Only admins/, `${id} as a form`);
      assert.equal(h.allButtons([...asButton, ...asSelect, ...asForm]).length, 0);
    }
    const tile = await h.click('yo:system:open:setup', { user, messageId: mid });
    assert.match(h.textOf(last(tile)), /Setup is for admins/);
    assert.equal(h.allButtons(tile).length, 0);
  }
  const s = h.engine.router.getSession(sid);
  assert.ok(s);
  assert.equal(s.preset, 'gaming');
  assert.equal(s.step, 'channels');
  assert.equal(s.channels.logs, C.modlog);
  assert.deepEqual(s.modRoles, []);
  assert.equal(h.engine.settings.core(S).setupDone, false);
  assert.equal(h.engine.store.get('setup', S, null), null);
  const second = await h.click('yo:setup:menu', { user: IDS.member2 });
  assert.ok(!/Only admins|Not your panel/.test(h.textOf(last(second))));
  assert.equal(h.engine.router.panelOwner(panelOf(second)), IDS.member2, 'a second ordinary person gets their own home screen too');
});

test('running another server does not open this one', async () => {
  const h = await make();
  addDummies(h);
  addSecondServer(h);
  assert.equal(await h.engine.perms.level(S2, IDS.member), 'owner');
  assert.equal(await h.engine.perms.level(S, IDS.member), 'member');
  const mine = await h.slash('setup', 'preset gaming', THERE);
  assert.match(h.textOf(last(mine)), /Step 2 of 6/);
  const sid2 = sessionOf(h, mine);
  const myPanel = panelOf(mine);
  const theirs = await h.slash('setup', 'preset study', ADMIN);
  const sid1 = sessionOf(h, theirs);

  for (const id of wizardIds(sid1)) {
    const out = await h.click(id, { ...THERE, messageId: myPanel });
    assert.match(h.textOf(out[0]), /someone else's setup/, `${id} pressed from the other server`);
  }
  for (const id of [...wizardIds(sid2), ...wizardIds(sid1), ...staffIds]) {
    const out = await h.click(id, MEMBER);
    assert.match(h.textOf(out[0]), /Only admins/, `${id} pressed here with an id from there`);
    const viaPanel = await h.click(id, { ...MEMBER, messageId: myPanel });
    assert.match(h.textOf(viaPanel[0]), /Only admins/);
  }
  assert.equal(h.engine.router.getSession(sid1).preset, 'study');
  assert.ok(h.engine.router.getSession(sid2), 'their own session is still there');

  let out = await h.click(`yo:setup:pickch:${sid2}:logs:${C.modlog}`, THERE);
  assert.match(h.textOf(last(out)), /couldn't use that channel/);
  out = await h.pick(`yo:setup:pickch:${sid2}:logs`, [C.modlog], THERE);
  assert.match(h.textOf(last(out)), /couldn't use that channel/);
  out = await h.click(`yo:setup:modrole:${sid2}:${HELPER}`, THERE);
  assert.match(h.textOf(last(out)), /can't use that role/);
  assert.equal(h.engine.router.getSession(sid2).channels.logs, null);
  assert.deepEqual(h.engine.router.getSession(sid2).modRoles, []);
  await h.message(`/setup channel logs <#${C.modlog}>`, THERE);
  assert.match(h.textOf(h.lastSent(C2)), /couldn't find that channel/);
  await h.message(`/setup channel logs ${C.modlog}`, THERE);
  assert.match(h.textOf(h.lastSent(C2)), /couldn't find that channel/);
  assert.equal(h.engine.store.get('setup', S2, null), null);

  let booted = await h.click(`yo:setup:step:${sid1}:review`, ADMIN);
  booted = await clickLabel(h, booted, 'Boot');
  const undo = h.findButton('Undo', last(booted));
  for (const opts of [THERE, { ...THERE, messageId: myPanel }, MEMBER, { ...MEMBER, messageId: myPanel }]) {
    out = await h.click(undo.custom_id, opts);
    assert.match(h.textOf(out[0]), /Only admins/);
  }
  assert.equal(h.engine.settings.core(S).setupDone, true);
  assert.equal(h.engine.settings.core(S).preset, 'study');

  out = await h.click(`yo:setup:boot:${sid2}`, { ...THERE, messageId: myPanel });
  assert.match(h.textOf(last(out)), /Boot complete/);
  assert.equal(h.engine.settings.core(S2).preset, 'gaming');
  assert.equal(h.engine.settings.core(S).preset, 'study', 'this server keeps its own settings');
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), false);
  const myUndo = h.findButton('Undo', last(out));
  out = await h.click(myUndo.custom_id, { ...MEMBER, messageId: myUndo.messageId });
  assert.match(h.textOf(last(out)), /Undone/);
  assert.equal(h.engine.settings.core(S2).setupDone, false);
  assert.equal(h.engine.settings.core(S).setupDone, true, 'an undo earned there only touches that server');
  out = await h.click('yo:setup:resetyes', THERE);
  assert.match(h.textOf(last(out)), /Reset done/);
  assert.equal(h.engine.settings.core(S).setupDone, true);
  assert.equal(h.engine.settings.core(S).preset, 'study');
});

test('an admin who loses the role or leaves loses the wizard, reset and undo', async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  const mid = panelOf(ans);
  const saved = await h.slash('setup', 'channel logs #general', ADMIN);
  const undo = h.findButton('Undo', last(saved));
  h.fake.memberOf(S, IDS.admin).roles = [R.member];
  h.engine.perms.invalidate();
  const refused = async () => {
    for (const id of [...wizardIds(sid), ...staffIds]) {
      const out = await h.click(id, { ...ADMIN, messageId: mid });
      assert.match(h.textOf(out[0]), /Only admins/, id);
    }
    const u = await h.click(undo.custom_id, { ...ADMIN, messageId: undo.messageId });
    assert.match(h.textOf(u[0]), /Only admins/);
    const tile = await h.click('yo:system:open:setup', ADMIN);
    assert.match(h.textOf(last(tile)), /Setup is for admins/);
    const cmd = await h.slash('setup', 'reset', ADMIN);
    assert.match(h.textOf(cmd[0]), /Only admins/);
    assert.equal(h.allButtons(cmd).length, 0);
  };
  await refused();
  h.fake.state.members[S] = h.fake.state.members[S].filter((m) => m.id !== IDS.admin);
  h.engine.perms.invalidate();
  await refused();
  assert.equal(h.engine.settings.core(S).setupDone, false);
  assert.equal(h.engine.store.get('setup', S, {}).channels.logs, C.general, 'the saved channel was not undone');
});

test('setup buttons pressed outside a server do nothing', async () => {
  const h = await make();
  addDummies(h);
  await bootAs(h);
  const ans = await h.slash('setup', 'start', ADMIN);
  const sid = sessionOf(h, ans);
  for (const user of [IDS.member, IDS.admin, IDS.owner]) {
    for (const id of [...wizardIds(sid), ...staffIds]) {
      const out = await h.click(id, { user, server: null });
      assert.match(h.textOf(out[0]), /Only admins/, id);
      assert.ok(!/403|undefined|null/.test(h.textOf(out[0])));
    }
    const tile = await h.click('yo:system:open:setup', { user, server: null });
    assert.equal(h.allButtons(tile).length, 0);
    assert.ok(!/First boot|Run again/.test(h.textOf(last(tile))));
  }
  assert.ok(h.engine.router.getSession(sid));
  assert.equal(h.engine.settings.core(S).setupDone, true);
  assert.equal(h.engine.settings.core(S).preset, 'gaming');
});

test('after Setup is uninstalled every way in is closed, Undo included', async () => {
  const h = await make();
  addDummies(h);
  const booted = await bootAs(h, 'study');
  const undo = h.findButton('Undo', last(booted));
  const status = await h.slash('setup', '', ADMIN);
  const mid = panelOf(status);
  const wizard = await h.slash('setup', 'start', ADMIN);
  const sid = sessionOf(h, wizard);
  h.engine.settings.setEnabled(S, 'setup', false);
  const before = JSON.stringify(h.engine.settings.raw(S));
  for (const user of [IDS.admin, IDS.owner, IDS.member]) {
    for (const id of [...wizardIds(sid), ...staffIds, 'yo:setup:menu']) {
      const out = await h.click(id, { user });
      assert.match(h.textOf(out[0]), /isn't installed here/, `${id} by ${user}`);
    }
    const tile = await h.click('yo:system:open:setup', { user });
    assert.match(h.textOf(last(tile)), /isn't installed here/);
    for (const words of ['setup', 'setup reset', 'preset gaming', 'boot']) {
      const out = await h.slash('yap', words, { user });
      assert.equal(h.allButtons(out).length, 0, words);
      assert.ok(!/First boot|Reset YapOS|Server type set/.test(h.textOf(last(out))), words);
    }
    const cmd = await h.slash('setup', 'reset', { user });
    assert.equal(h.allButtons(cmd).length, 0);
    assert.ok(!/Reset YapOS/.test(h.textOf(last(cmd))));
    await h.message('!setup channel logs #general', { user });
    assert.equal(h.allButtons(h.lastSent(C.general)).length, 0);
  }
  const onPanel = await h.click('yo:setup:resetyes', { ...ADMIN, messageId: mid });
  assert.match(h.textOf(onPanel[0]), /isn't installed here/);
  let out = await h.click(undo.custom_id, MEMBER);
  assert.match(h.textOf(out[0]), /Only admins/);
  out = await h.click(undo.custom_id, { ...ADMIN, messageId: undo.messageId });
  assert.match(h.textOf(last(out)), /Setup isn't installed here/);
  assert.ok(!/Undone/.test(h.textOf(last(out))));
  assert.equal(JSON.stringify(h.engine.settings.raw(S)), before, 'nothing changed while Setup was uninstalled');
  assert.equal(h.engine.settings.core(S).setupDone, true);
  assert.equal(h.engine.settings.isEnabled(S, 'greeter'), false);
  assert.equal(h.engine.settings.isEnabled(S, 'setup'), false);
});

test('typed chat commands refuse members and mods the same way the slash menu does', async () => {
  const h = await make();
  addDummies(h);
  const lines = ['!setup', '/setup', '!setup reset', '!setup status', '!setup start', '!setup preset gaming', '!setup gaming', '!setup channel logs #general', '!setup logs #general', '!yap setup reset', '!yap boot', '!yap preset gaming', '/yap setup channel logs #general'];
  for (const user of [IDS.member, IDS.mod]) {
    for (const line of lines) {
      await h.message(line, { user });
      const m = h.lastSent(C.general);
      assert.match(h.textOf(m), /Only admins/, line);
      assert.equal(h.allButtons(m).length, 0, line);
      const [cmd, ...rest] = line.slice(1).split(' ');
      const viaSlash = await h.slash(cmd, rest.join(' '), { user });
      assert.match(h.textOf(last(viaSlash)), /Only admins/, line);
      assert.equal(h.allButtons(viaSlash).length, 0, line);
    }
    await h.message('!setup reset', { user, authorAsString: true });
    assert.match(h.textOf(h.lastSent(C.general)), /Only admins/);
  }
  assert.equal(h.engine.settings.core(S).preset, null);
  assert.equal(h.engine.settings.core(S).setupDone, false);
  assert.equal(h.engine.store.get('setup', S, null), null);
  assert.equal(h.allButtons(h.sent()).length, 0, 'no setup panel was ever posted');
});

test('hostile ids and values in an admin wizard are checked against real things', async () => {
  const h = await make();
  addDummies(h);
  const ans = await h.slash('setup', 'preset gaming', ADMIN);
  const sid = sessionOf(h, ans);
  const press = async (id, values) => h.textOf(last(values ? await h.pick(id, values, ADMIN) : await h.click(id, ADMIN)));
  for (const word of ['__proto__', 'constructor', 'toString', '']) {
    assert.match(await press(`yo:setup:preset:${sid}`, [word]), /Pick a server type/, word);
    assert.match(await press(`yo:setup:step:${sid}:${word}`), /Unknown step/, word);
    assert.match(await press(`yo:setup:slot:${sid}:${word}`), /Unknown channel slot/, word);
    assert.match(await press(`yo:setup:pickch:${sid}:${word}:${C.general}`), /couldn't use that channel/, word);
    assert.match(await press(`yo:setup:app:${sid}:${word}`), /That app is gone/, word);
    assert.match(await press(`yo:setup:modrole:${sid}:${word}`), /can't use that role/, word);
    await h.click(`yo:setup:skipch:${sid}:${word}`, ADMIN);
  }
  for (const app of ['system', 'setup', 'sys']) assert.match(await press(`yo:setup:app:${sid}:${app}`), /That app is gone/, app);
  for (const role of [R.top, R.admin, R.mod, R.bot, S, 'everyone', IDS.owner, IDS.member]) assert.match(await press(`yo:setup:modrole:${sid}:${role}`), /can't use that role/, role);
  for (const ch of [C.voice, IDS.member, 'everyone']) {
    assert.match(await press(`yo:setup:pickch:${sid}:logs:${ch}`), /couldn't use that channel/, ch);
    assert.match(await press(`yo:setup:pickch:${sid}:logs`, [ch]), /couldn't use that channel/, ch);
  }
  const typed = await h.slash('setup', 'channel constructor #general', ADMIN);
  assert.match(h.textOf(last(typed)), /don't know the "constructor" slot/);
  const odd = await h.slash('setup', 'constructor #general', ADMIN);
  assert.ok(!/Saved/.test(h.textOf(last(odd))));
  const s = h.engine.router.getSession(sid);
  assert.equal(s.preset, 'gaming');
  assert.deepEqual(s.modRoles, []);
  assert.deepEqual(Object.keys(s.channels).sort(), ['announcements', 'general', 'logs', 'roles', 'rules', 'verify', 'welcome']);
  assert.equal(s.channels.logs, C.modlog);
  assert.deepEqual(Object.keys(s.apps).sort(), ['greeter', 'plain', 'rolekit']);
  assert.equal(h.engine.store.get('setup', S, null), null);
  const done = await h.click(`yo:setup:boot:${sid}`, ADMIN);
  assert.match(h.textOf(last(done)), /Boot complete/);
  assert.deepEqual(h.engine.settings.core(S).modRoles, []);
  assert.equal(h.engine.settings.isEnabled(S, 'setup'), true);
  assert.equal(h.engine.settings.core(S).logChannel, C.modlog);
});
