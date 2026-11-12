import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';

test('every command fits Yapin limits and the total stays well under 100', async () => {
  const h = await createHarness();
  assert.ok(h.bot.commands.size <= 40, `${h.bot.commands.size} commands`);
  for (const [name, c] of h.bot.commands) {
    assert.match(name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(c.description.length <= 100, `/${name} description too long`);
    assert.ok(c.description.length > 0, `/${name} needs a description`);
  }
});

test('/menu shows the home screen as an embed card with tile buttons, V2 or not', async () => {
  for (const features of [{}, { v2: false }]) {
    const h = await createHarness({ features });
    const ans = await h.slash('menu', '', { user: IDS.admin });
    assert.equal(ans.length, 1);
    assert.notEqual(ans[0].flags, 32768);
    assert.equal(ans[0].embeds[0].title, "🖥️ YapOS 1.0 'Boot'");
    assert.ok(ans[0].components.length <= 5);
    assert.deepEqual(ans[0].components[ans[0].components.length - 1].components.map((b) => b.custom_id), ['yo:system:help', 'yo:system:apps']);
  }
});

test('/menu typed in chat works too', async () => {
  const h = await createHarness();
  await h.message('/menu');
  const m = h.lastSent(IDS.channels.general);
  assert.ok(m, 'replied in channel');
  assert.match(h.textOf(m), /Boot/);
});

test('/help lists apps and falls back to buttons without select menus', async () => {
  const h = await createHarness({ features: { selects: false } });
  const ans = await h.slash('help');
  const last = ans[ans.length - 1];
  assert.match(h.textOf(last), /YapOS help/);
  assert.ok(!JSON.stringify(last.components).includes('"select"'));
});

test('/status reports connection and budget', async () => {
  const h = await createHarness();
  const ans = await h.slash('status', '', { user: IDS.owner });
  const text = h.textOf(ans[0]);
  assert.match(text, /Latency/);
  assert.match(text, /Message budget/);
  assert.equal(ans[0].type, 'ephemeral', 'only the owner sees it');
});

test('/apps is admin only and toggles apps', async () => {
  const h = await createHarness();
  const denied = await h.slash('apps', '', { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only admins/);
  const ans = await h.slash('apps', '', { user: IDS.admin });
  const toggles = h.allButtons(ans).filter((b) => b.custom_id.startsWith('yo:system:toggle:'));
  if (!toggles.length) return;
  const target = toggles[0].custom_id.split(':')[3];
  const before = h.engine.settings.isEnabled(IDS.server, target);
  await h.click(toggles[0].custom_id, { user: IDS.admin });
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), !before);
  const notAdmin = await h.click(toggles[0].custom_id, { user: IDS.member });
  assert.match(h.textOf(notAdmin[0]), /Only admins/);
});

test('/yap suggests close words for typos', async () => {
  const h = await createHarness();
  const ans = await h.slash('yap', 'hlep', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /didn't get that/);
});

test('old buttons get a friendly note, not a failure', async () => {
  const h = await createHarness();
  const ans = await h.click('yo:nope:gone');
  assert.match(h.textOf(ans[0]), /older panel/);
});

test('slow handlers are auto-acked before the 3 second deadline', async () => {
  const h = await createHarness();
  h.engine.router.register('system', 'slow', { run: () => new Promise((r) => setTimeout(r, 2600)) });
  const ans = await h.click('yo:system:slow');
  await new Promise((r) => setTimeout(r, 2700));
  const all = h.fake.answers.filter((a) => a.interactionId === (ans[0]?.interactionId ?? h.fake.answers.at(-1).interactionId));
  assert.ok(h.fake.answers.some((a) => a.type === 'ack'), 'auto ack was sent');
  void all;
});

test('DMs get a friendly Pocket note', async () => {
  const h = await createHarness();
  await h.dm('hello');
  const dmCh = Object.keys(h.fake.state.dms)[0];
  assert.match(h.lastSent(dmCh)?.content || '', /Pocket/);
});

test('author as a plain string does not crash commands', async () => {
  const h = await createHarness();
  await h.message('/menu', { authorAsString: true });
  assert.ok(h.lastSent(IDS.channels.general));
});

test('/status is only for the bot owner, not even the server owner', async () => {
  const h = await createHarness();
  h.engine.config.ownerId = IDS.admin;
  const owner = await h.slash('status', '', { user: IDS.owner });
  assert.match(h.textOf(owner[0]), /Only YapOS's owner/);
  const mod = await h.slash('status', '', { user: IDS.mod });
  assert.match(h.textOf(mod[0]), /Only YapOS's owner/);
  const clicked = await h.click('yo:system:status', { user: IDS.owner });
  assert.match(h.textOf(clicked[0]), /Only YapOS's owner/);
  const me = await h.slash('status', '', { user: IDS.admin });
  assert.match(h.textOf(me[me.length - 1]), /System monitor/);
});

test('the home screen only shows the Status button to the bot owner', async () => {
  const h = await createHarness();
  h.engine.config.ownerId = IDS.admin;
  const owner = await h.slash('menu', '', { user: IDS.owner });
  assert.ok(!h.allButtons(owner).some((b) => b.custom_id === 'yo:system:status'));
  const me = await h.slash('menu', '', { user: IDS.admin });
  assert.ok(h.allButtons(me).some((b) => b.custom_id === 'yo:system:status'));
});
test('/status stays private: no buttons, so it is never posted publicly', async () => {
  const h = await createHarness();
  const ans = await h.slash('status', '', { user: IDS.owner });
  assert.equal(ans.length, 1);
  assert.equal(ans[0].type, 'ephemeral');
  assert.ok(!ans[0].components?.length);
  const clicked = await h.click('yo:system:status', { user: IDS.owner });
  assert.equal(clicked[0].type, 'ephemeral');
});
test('a panel only works for the person who opened it', async () => {
  const h = await createHarness();
  const ans = await h.slash('apps', '', { user: IDS.admin });
  const toggle = h.allButtons(ans).find((b) => b.custom_id.startsWith('yo:system:toggle:'));
  assert.ok(toggle.messageId, 'the panel message is known');
  const target = toggle.custom_id.split(':')[3];
  const before = h.engine.settings.isEnabled(IDS.server, target);
  const member = await h.click(toggle.custom_id, { user: IDS.member, messageId: toggle.messageId });
  assert.match(h.textOf(member[0]), /Not your panel/);
  h.addSecondAdmin();
  const otherAdmin = await h.click(toggle.custom_id, { user: IDS.admin2, messageId: toggle.messageId });
  assert.match(h.textOf(otherAdmin[0]), /Not your panel/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), before, 'nothing changed');
  await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), !before, 'the opener can still use it');
  const flip = toggle.custom_id.replace(/:(on|off)$/, (m, v) => (v === 'on' ? ':off' : ':on'));
  const byOwner = await h.click(flip, { user: IDS.owner, messageId: toggle.messageId });
  assert.doesNotMatch(h.textOf(byOwner[0]), /Not your panel/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), before, 'the owner can use it too');
});

test('the home screen is locked to whoever ran /menu, typed or from the slash menu', async () => {
  const h = await createHarness();
  const ans = await h.slash('menu', '', { user: IDS.admin });
  const open = h.allButtons(ans).find((b) => b.custom_id.startsWith('yo:system:open:'));
  const other = await h.click(open.custom_id, { user: IDS.member, messageId: open.messageId });
  assert.match(h.textOf(other[0]), /Not your panel/);
  await h.message('/menu', { user: IDS.mod });
  const typed = h.lastSent(IDS.channels.general);
  const btn = h.allButtons([typed]).find((b) => b.custom_id.startsWith('yo:system:'));
  const blocked = await h.click(btn.custom_id, { user: IDS.member, messageId: typed.id });
  assert.match(h.textOf(blocked[0]), /Not your panel/);
});

async function withDemo() {
  const { defineApp } = await import('../../engine/apps.js');
  const { customId } = await import('../../engine/router.js');
  const h = await createHarness({ apps: [] });
  const seen = { panel: [], yap: [] };
  const demo = defineApp({
    id: 'demo',
    name: 'Demo',
    icon: '🧪',
    description: 'A sample app for tests.',
    panel: async (ctx) => {
      seen.panel.push(ctx.userId);
      return ctx.ephemeral({ content: 'Demo panel', components: [{ type: 'row', components: [{ type: 'button', style: 'secondary', label: 'Poke', custom_id: customId('demo', 'poke') }] }] });
    },
    components: { poke: { run: (ctx) => ctx.ephemeral('Poked') } },
    yap: [{ words: ['demoword'], run: async (ctx) => { seen.yap.push({ user: ctx.userId, argv: ctx.argv, app: ctx.app }); return ctx.ephemeral('Demo yap'); } }],
  });
  await demo.setup(h.bot);
  return { h, seen };
}

const toggleOf = (h, where) => h.allButtons(where).find((b) => b.custom_id.startsWith('yo:system:toggle:demo'));

test('the Apps button on the home screen is admin only, on a panel or forged', async () => {
  const { h } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.admin });
  const apps = h.allButtons(home).find((b) => b.custom_id === 'yo:system:apps');
  assert.ok(apps, 'admins see the Apps button');
  const onPanel = await h.click(apps.custom_id, { user: IDS.member, messageId: apps.messageId });
  assert.match(h.textOf(onPanel[0]), /Not your panel/);
  const forged = await h.click(apps.custom_id, { user: IDS.member });
  assert.match(h.textOf(forged[0]), /Only admins/);
  const modForged = await h.click(apps.custom_id, { user: IDS.mod });
  assert.match(h.textOf(modForged[0]), /Only admins/);
  const mine = await h.click(apps.custom_id, { user: IDS.admin, messageId: apps.messageId });
  assert.ok(toggleOf(h, mine), 'the admin gets the apps panel');
  const memberHome = await h.slash('menu', '', { user: IDS.member });
  assert.ok(!h.allButtons(memberHome).some((b) => b.custom_id === 'yo:system:apps'), 'members never see the Apps button');
});

test('install and uninstall buttons refuse members and mods, on a panel or forged', async () => {
  const { h } = await withDemo();
  const panel = await h.slash('apps', '', { user: IDS.admin });
  const toggle = toggleOf(h, panel);
  assert.ok(toggle.messageId);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  const onPanel = await h.click(toggle.custom_id, { user: IDS.member, messageId: toggle.messageId });
  assert.match(h.textOf(onPanel[0]), /Not your panel/);
  const forged = await h.click(toggle.custom_id, { user: IDS.member });
  assert.match(h.textOf(forged[0]), /Only admins/);
  const modForged = await h.click(toggle.custom_id, { user: IDS.mod });
  assert.match(h.textOf(modForged[0]), /Only admins/);
  const shortForged = await h.click('yo:system:toggle:demo', { user: IDS.member2 });
  assert.match(h.textOf(shortForged[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true, 'nothing changed');
  await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), false);
});

test('app installs need a server, so a click without one changes nothing', async () => {
  const { h } = await withDemo();
  const toggled = await h.click('yo:system:toggle:demo:off', { user: IDS.admin, server: null });
  assert.match(h.textOf(toggled[0]), /Servers only/);
  const opened = await h.click('yo:system:apps', { user: IDS.admin, server: null });
  assert.match(h.textOf(opened[0]), /Servers only/);
  assert.ok(!h.allButtons(opened).length);
  const tile = await h.click('yo:system:open:demo', { user: IDS.admin, server: null });
  assert.match(h.textOf(tile[0]), /Servers only/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  assert.deepEqual(h.engine.settings.servers().filter((s) => s !== IDS.server), []);
});

test('an install button does what its label says, even when pressed twice', async () => {
  const { h } = await withDemo();
  const panel = await h.slash('apps', '', { user: IDS.admin });
  const toggle = toggleOf(h, panel);
  assert.match(toggle.label, /Uninstall Demo/);
  assert.match(toggle.custom_id, /:off$/);
  await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), false, 'a stale Uninstall never installs');
  await h.click('yo:system:toggle:demo:on', { user: IDS.owner });
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
});

test('system apps and made-up ids cannot be toggled', async () => {
  const { h } = await withDemo();
  const core = await h.click('yo:system:toggle:system:off', { user: IDS.admin });
  assert.match(h.textOf(core[0]), /always on/);
  const unknown = await h.click('yo:system:toggle:nothing:off', { user: IDS.admin });
  assert.match(h.textOf(unknown[0]), /Can't change that/);
  assert.equal(h.engine.settings.raw(IDS.server).apps.nothing, undefined);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'system'), true);
});

test('the Status button is for the bot owner only, on a panel or forged', async () => {
  const { h } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.owner });
  const status = h.allButtons(home).find((b) => b.custom_id === 'yo:system:status');
  assert.ok(status);
  const onPanel = await h.click(status.custom_id, { user: IDS.admin, messageId: status.messageId });
  assert.match(h.textOf(onPanel[0]), /Not your panel/);
  for (const user of [IDS.member, IDS.mod, IDS.admin]) {
    const forged = await h.click(status.custom_id, { user });
    assert.match(h.textOf(forged[0]), /Only YapOS's owner/);
    assert.doesNotMatch(h.textOf(forged[0]), /Latency/);
  }
  const mine = await h.click(status.custom_id, { user: IDS.owner, messageId: status.messageId });
  assert.match(h.textOf(mine[0]), /System monitor/);
  assert.equal(mine[0].type, 'ephemeral');
});

test('a help panel belongs to whoever asked, and anyone can ask for their own', async () => {
  const { h } = await withDemo();
  const help = await h.slash('help', '', { user: IDS.admin });
  const pick = h.allButtons(help).find((b) => b.custom_id === 'yo:system:helppick');
  const panelId = help[help.length - 1].message.id;
  assert.ok(pick && panelId);
  const other = await h.pick(pick.custom_id, ['demo'], { user: IDS.member, messageId: panelId });
  assert.match(h.textOf(other[0]), /Not your panel/);
  const mine = await h.pick(pick.custom_id, ['demo'], { user: IDS.admin, messageId: panelId });
  assert.match(h.textOf(mine[0]), /Demo/);
  const own = await h.slash('help', '', { user: IDS.member });
  assert.match(h.textOf(own[own.length - 1]), /YapOS help/);
  const detail = await h.click('yo:system:helpapp:demo', { user: IDS.member });
  assert.match(h.textOf(detail[0]), /A sample app for tests/);
  const back = h.allButtons(detail).find((b) => b.custom_id === 'yo:system:help');
  const blocked = await h.click(back.custom_id, { user: IDS.member2, messageId: back.messageId });
  assert.match(h.textOf(blocked[0]), /Not your panel/);
  const allowed = await h.click(back.custom_id, { user: IDS.member, messageId: back.messageId });
  assert.match(h.textOf(allowed[allowed.length - 1]), /YapOS help/);
});

test('help never echoes mentions or markup back', async () => {
  const { h } = await withDemo();
  const typed = await h.slash('help', '@everyone', { user: IDS.member });
  assert.match(h.textOf(typed[0]), /No such app/);
  assert.doesNotMatch(h.textOf(typed[0]), /@/);
  const picked = await h.pick('yo:system:helppick', [`<@${IDS.owner}>`], { user: IDS.member });
  assert.match(h.textOf(picked[0]), /No such app/);
  assert.doesNotMatch(h.textOf(picked[0]), /[<@]/);
});

test('an app tile opens that app for the person who clicked, and the new panel is theirs', async () => {
  const { h, seen } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.admin });
  const tile = h.allButtons(home).find((b) => b.custom_id === 'yo:system:open:demo');
  assert.ok(tile);
  const other = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.match(h.textOf(other[0]), /Not your panel/);
  assert.deepEqual(seen.panel, []);
  const opened = await h.click(tile.custom_id, { user: IDS.admin, messageId: tile.messageId });
  assert.deepEqual(seen.panel, [IDS.admin]);
  assert.equal(opened[0].type, 'update');
  const poke = h.allButtons(opened).find((b) => b.custom_id === 'yo:demo:poke');
  const stranger = await h.click(poke.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.match(h.textOf(stranger[0]), /Not your panel/);
  await h.click(tile.custom_id, { user: IDS.member });
  assert.deepEqual(seen.panel, [IDS.admin, IDS.member], 'a leftover tile runs the app as the clicker, never as the opener');
});

test('tiles refuse apps that are missing, uninstalled or the system itself', async () => {
  const { h, seen } = await withDemo();
  const none = await h.click('yo:system:open:nothing', { user: IDS.member });
  assert.match(h.textOf(none[0]), /Nothing to open/);
  const self = await h.click('yo:system:open:system', { user: IDS.member });
  assert.match(h.textOf(self[0]), /Nothing to open/);
  const blank = await h.click('yo:system:open', { user: IDS.member });
  assert.match(h.textOf(blank[0]), /Nothing to open/);
  h.engine.settings.setEnabled(IDS.server, 'demo', false);
  const off = await h.click('yo:system:open:demo', { user: IDS.member });
  assert.match(h.textOf(off[0]), /isn't installed here/);
  assert.deepEqual(seen.panel, []);
});

test('/yap hands the typed words to the app as the person who typed them', async () => {
  const { h, seen } = await withDemo();
  const ans = await h.slash('yap', 'demoword one two', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /Demo yap/);
  assert.deepEqual(seen.yap, [{ user: IDS.member, argv: ['one', 'two'], app: 'demo' }]);
  await h.slash('yap', 'demo', { user: IDS.member2 });
  assert.deepEqual(seen.panel, [IDS.member2]);
  h.engine.settings.setEnabled(IDS.server, 'demo', false);
  const off = await h.slash('yap', 'demoword', { user: IDS.admin });
  assert.match(h.textOf(off[0]), /isn't installed here/);
  const offPanel = await h.slash('yap', 'demo', { user: IDS.admin });
  assert.match(h.textOf(offPanel[0]), /isn't installed here/);
  assert.equal(seen.yap.length, 1);
  assert.equal(seen.panel.length, 1);
});

test('/yap cannot reach the apps panel or the system monitor', async () => {
  const { h } = await withDemo();
  for (const word of ['apps', 'status', 'system', 'toggle']) {
    const ans = await h.slash('yap', word, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /didn't get that/);
    assert.ok(!h.allButtons(ans).some((b) => b.custom_id.startsWith('yo:system:toggle')));
  }
});

test('a home screen opened by a member has no staff buttons and stays theirs', async () => {
  const { h } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.member });
  const ids = h.allButtons(home).map((b) => b.custom_id);
  assert.deepEqual(ids.filter((id) => id === 'yo:system:apps' || id === 'yo:system:status'), []);
  const help = h.allButtons(home).find((b) => b.custom_id === 'yo:system:help');
  const admin = await h.click(help.custom_id, { user: IDS.admin, messageId: help.messageId });
  assert.match(h.textOf(admin[0]), /Not your panel/);
  const mine = await h.click(help.custom_id, { user: IDS.member, messageId: help.messageId });
  assert.match(h.textOf(mine[mine.length - 1]), /YapOS help/);
});

const S2 = '5e000000-0000-4000-8000-000000000002';
const C2 = 'c0000000-0000-4000-8000-0000000000a1';
const R2 = 'r0000000-0000-4000-8000-0000000000b6';

function addSecondServer(h) {
  const st = h.fake.state;
  st.servers[S2] = { id: S2, name: 'Other Town', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 1 };
  st.roles[S2] = [{ id: R2, name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, send_messages: true }, auto: null, mentionable: false }];
  st.members[S2] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [], joined_at: '2026-01-05T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [R2], joined_at: '2026-01-02T00:00:00Z' },
  ];
  st.channels[S2] = [{ id: C2, name: 'general', type: 'text', kind: 'text', server_id: S2, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[S2] = [];
  st.everyone[S2] = { send_messages: true, view_channel: true };
}

const STAFF_IDS = ['yo:system:apps', 'yo:system:toggle:demo:off', 'yo:system:toggle:demo:on', 'yo:system:toggle:demo'];

test('staff buttons pressed on a panel the member opened themselves are still refused', async () => {
  const { h } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.member });
  const mine = h.allButtons(home).find((b) => b.custom_id === 'yo:system:help');
  assert.ok(mine.messageId);
  assert.equal(h.engine.router.panelOwner(mine.messageId), IDS.member);
  const on = { user: IDS.member, messageId: mine.messageId };
  for (const id of STAFF_IDS) {
    const tries = [await h.click(id, on), await h.pick(id, ['demo'], on), await h.submit(id, { app: 'demo', enabled: 'false' }, on)];
    for (const ans of tries) {
      assert.match(h.textOf(ans[0]), /Only admins/, id);
      assert.ok(!h.allButtons(ans).some((b) => b.custom_id.startsWith('yo:system:toggle')), id);
    }
  }
  const status = await h.click('yo:system:status', on);
  assert.match(h.textOf(status[0]), /Only YapOS's owner/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  assert.equal(h.engine.settings.raw(IDS.server).apps.demo, undefined, 'nothing was written');
});

test('ids pasted into a button give no extra rights', async () => {
  const { h } = await withDemo();
  const pasted = [
    `yo:system:toggle:demo:off:${IDS.owner}`,
    `yo:system:toggle:demo:off:${IDS.admin}:${IDS.server}`,
    `yo:system:apps:${IDS.owner}`,
    `yo:system:apps:${IDS.roles.top}`,
    `yo:system:toggle:demo:${IDS.roles.admin}`,
  ];
  for (const id of pasted) {
    const ans = await h.click(id, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /Only admins/, id);
  }
  const status = await h.click(`yo:system:status:${IDS.owner}`, { user: IDS.member });
  assert.match(h.textOf(status[0]), /Only YapOS's owner/);
  const nobody = await h.click('yo:system:toggle:demo:off', { user: 'a0000000-0000-4000-8000-0000000000ff' });
  assert.match(h.textOf(nobody[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
});

test('running another server does not make someone an admin here', async () => {
  const { h } = await withDemo();
  addSecondServer(h);
  const there = { user: IDS.member, server: S2, channel: C2 };
  const theirs = await h.slash('apps', '', there);
  const toggle = toggleOf(h, theirs);
  assert.ok(toggle, 'they manage apps in their own server');
  await h.click(toggle.custom_id, { ...there, messageId: toggle.messageId });
  assert.equal(h.engine.settings.isEnabled(S2, 'demo'), false);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true, 'this server is untouched');
  const carried = await h.click(toggle.custom_id, { user: IDS.member, messageId: toggle.messageId });
  assert.match(h.textOf(carried[0]), /Only admins/);
  const named = await h.click(`yo:system:toggle:demo:off:${IDS.server}`, there);
  assert.doesNotMatch(h.textOf(named[0]), /Only admins/);
  const opened = await h.click('yo:system:apps', { user: IDS.member, messageId: toggle.messageId });
  assert.match(h.textOf(opened[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  const adminThere = await h.click('yo:system:toggle:demo:on', { user: IDS.admin, server: S2, channel: C2 });
  assert.match(h.textOf(adminThere[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(S2, 'demo'), false, 'an admin here is nobody there');
});

test('typed commands get the same checks as the slash menu', async () => {
  const { h } = await withDemo();
  for (const text of ['!apps', '/apps', '!apps demo off']) {
    await h.message(text, { user: IDS.member });
    const m = h.lastSent(IDS.channels.general);
    assert.match(h.textOf(m), /Only admins/, text);
    assert.ok(!h.allButtons([m]).length, text);
  }
  await h.message('!apps', { user: IDS.member, authorAsString: true });
  assert.match(h.textOf(h.lastSent(IDS.channels.general)), /Only admins/);
  for (const user of [IDS.member, IDS.mod, IDS.admin]) {
    await h.message('!status', { user });
    const m = h.lastSent(IDS.channels.general);
    assert.match(h.textOf(m), /Only YapOS's owner/);
    assert.doesNotMatch(h.textOf(m), /Latency/);
  }
  for (const word of ['apps', 'status', 'toggle demo off', '/apps']) {
    await h.message(`!yap ${word}`, { user: IDS.member });
    assert.match(h.textOf(h.lastSent(IDS.channels.general)), /didn't get that/, word);
  }
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  await h.message('!apps', { user: IDS.admin });
  const panel = h.lastSent(IDS.channels.general);
  const toggle = toggleOf(h, [panel]);
  assert.ok(toggle, 'an admin gets the panel from chat');
  const blocked = await h.click(toggle.custom_id, { user: IDS.member, messageId: panel.id });
  assert.match(h.textOf(blocked[0]), /Not your panel/);
  const forged = await h.click(toggle.custom_id, { user: IDS.member });
  assert.match(h.textOf(forged[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
});

test('rights follow the role: lost with it at once, never gained by a lookalike role', async () => {
  const { h } = await withDemo();
  const sam = h.fake.memberOf(IDS.server, IDS.member);
  sam.roles.push(IDS.roles.vip, IDS.roles.gamer);
  const vip = await h.click('yo:system:toggle:demo:off', { user: IDS.member });
  assert.match(h.textOf(vip[0]), /Only admins/);
  h.engine.settings.patchCore(IDS.server, { modRoles: [IDS.roles.vip] });
  h.engine.perms.invalidate();
  const asMod = await h.click('yo:system:toggle:demo:off', { user: IDS.member });
  assert.match(h.textOf(asMod[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  const panel = await h.slash('apps', '', { user: IDS.admin });
  const toggle = toggleOf(h, panel);
  const alex = h.fake.memberOf(IDS.server, IDS.admin);
  alex.roles = alex.roles.filter((r) => r !== IDS.roles.admin);
  const demoted = await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.match(h.textOf(demoted[0]), /Only admins/);
  const again = await h.slash('apps', '', { user: IDS.admin });
  assert.match(h.textOf(again[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true, 'a removed admin changes nothing');
  const { h: h2 } = await withDemo();
  h2.fake.memberOf(IDS.server, IDS.member).roles.push(IDS.roles.top);
  await h2.click('yo:system:toggle:demo:off', { user: IDS.member });
  assert.equal(h2.engine.settings.isEnabled(IDS.server, 'demo'), false, 'a real admin role does work');
});

test('hostile app ids and form values are refused without a trace', async () => {
  const { h } = await withDemo();
  const long = 'a'.repeat(5000);
  for (const id of ['__proto__', 'constructor', 'DEMO', 'demo.off', '../demo', '@everyone', `<@${IDS.owner}>`, 'system']) {
    const ans = await h.click(`yo:system:toggle:${id}:off`, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /Can't change that/, id);
    assert.doesNotMatch(h.textOf(ans[0]), /[<@]/, id);
  }
  assert.deepEqual(Object.keys(h.engine.settings.raw(IDS.server).apps), []);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  for (const value of ['__proto__', 'constructor', '@everyone', long, 'system:toggle:demo:off', { app: 'demo' }, null, 42]) {
    const ans = await h.pick('yo:system:helppick', [value], { user: IDS.member });
    assert.ok(ans.length, 'answered');
    assert.doesNotMatch(h.textOf(ans[ans.length - 1]), /@everyone|a{40}/);
    assert.ok(!h.allButtons(ans).some((b) => b.custom_id.startsWith('yo:system:toggle')));
  }
  const form = await h.submit('yo:system:helppick', { app: '@everyone', server_id: S2, user_id: IDS.owner }, { user: IDS.member });
  assert.match(h.textOf(form[form.length - 1]), /YapOS help/);
  const formStatus = await h.submit('yo:system:status', { user_id: IDS.owner, owner: 'true' }, { user: IDS.member });
  assert.match(h.textOf(formStatus[0]), /Only YapOS's owner/);
  const formOpen = await h.submit('yo:system:open:system', { app: 'system' }, { user: IDS.member });
  assert.match(h.textOf(formOpen[0]), /Nothing to open/);
  const helpLong = await h.slash('help', `${long} <@${IDS.owner}>`, { user: IDS.member });
  assert.ok(h.textOf(helpLong[0]).length < 400);
  const yapLong = await h.slash('yap', `@everyone${long}`, { user: IDS.member });
  assert.doesNotMatch(h.textOf(yapLong[0]), /@everyone/);
  assert.ok(h.textOf(yapLong[0]).length < 400);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
});

test('the home screen has no back door into admin views', async () => {
  const { h, seen } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.member });
  const mine = h.allButtons(home).find((b) => b.custom_id === 'yo:system:open:demo');
  assert.ok(mine.messageId);
  for (const id of ['system', 'apps', 'status', 'toggle', 'sys', 'System', 'd.e.m.o', '../demo', 'demo!']) {
    const ans = await h.click(`yo:system:open:${id}`, { user: IDS.member, messageId: mine.messageId });
    assert.match(h.textOf(ans[0]), /Nothing to open/, id);
    assert.ok(!h.allButtons(ans).length, id);
  }
  const staffView = (ans) => h.allButtons(ans).some((b) => /yo:system:(toggle|apps|status)/.test(b.custom_id)) || /Latency|Uninstall/.test(h.textOf(ans[ans.length - 1]));
  for (const word of ['System', 'SYSTEM', 'apps', 'status', 'menu apps', '']) {
    const ans = await h.slash('yap', word, { user: IDS.member });
    assert.ok(!staffView(ans), word);
  }
  assert.deepEqual(seen.panel, []);
});

test('buttons that were never handed out do nothing', async () => {
  const { h } = await withDemo();
  const undo = await h.click('yo:sys:undo:abc123', { user: IDS.member });
  assert.match(h.textOf(undo[0]), /Too late to undo/);
  const form = await h.click('yo:sys:form:abc123', { user: IDS.member });
  assert.match(h.textOf(form[0]), /expired/);
  const made = await h.click('yo:system:install:demo', { user: IDS.member });
  assert.match(h.textOf(made[0]), /older panel/);
  const real = h.engine.router.addUndo({ serverId: IDS.server, actorId: IDS.admin, label: 'test change', perm: 'admin', run: async () => { h.engine.settings.setEnabled(IDS.server, 'demo', false); } });
  const stolen = await h.click(real.button.custom_id, { user: IDS.member });
  assert.match(h.textOf(stolen[0]), /Only admins/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
});

test('an uninstalled app stays closed to old buttons, tiles and typed words', async () => {
  const { h, seen } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.member });
  const tile = h.allButtons(home).find((b) => b.custom_id === 'yo:system:open:demo');
  const opened = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  const poke = h.allButtons(opened).find((b) => b.custom_id === 'yo:demo:poke');
  assert.ok(poke);
  await h.click('yo:system:toggle:demo:off', { user: IDS.admin });
  const before = seen.panel.length;
  const stalePoke = await h.click(poke.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.match(h.textOf(stalePoke[0]), /isn't installed here/);
  const staleTile = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.match(h.textOf(staleTile[0]), /isn't installed here/);
  await h.message('!yap demoword', { user: IDS.member });
  assert.match(h.textOf(h.lastSent(IDS.channels.general)), /isn't installed here/);
  await h.message('!yap demo', { user: IDS.member });
  assert.match(h.textOf(h.lastSent(IDS.channels.general)), /isn't installed here/);
  const fresh = await h.slash('menu', '', { user: IDS.member });
  assert.ok(!h.allButtons(fresh).some((b) => b.custom_id === 'yo:system:open:demo'), 'the tile is gone');
  const selfInstall = await h.click('yo:system:toggle:demo:on', { user: IDS.member, messageId: tile.messageId });
  assert.match(h.textOf(selfInstall[0]), /Only admins/);
  assert.equal(seen.panel.length, before);
  assert.equal(seen.yap.length, 0);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), false);
});

test('direct messages cannot reach server controls', async () => {
  const { h } = await withDemo();
  for (const text of ['/apps', '!apps', '/status', '!yap apps', 'yo:system:toggle:demo:off']) await h.dm(text, { user: IDS.member });
  const dmCh = Object.keys(h.fake.state.dms)[0];
  assert.ok(h.sent(dmCh).length);
  for (const m of h.sent(dmCh)) {
    assert.doesNotMatch(h.textOf(m), /Uninstall|Latency/);
    assert.ok(!h.allButtons([m]).length);
  }
  const status = await h.click('yo:system:status', { user: IDS.member, server: null });
  assert.match(h.textOf(status[0]), /Only YapOS's owner/);
  const toggled = await h.click('yo:system:toggle:demo:off', { user: IDS.member, server: null });
  assert.match(h.textOf(toggled[0]), /Servers only/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, 'demo'), true);
  assert.deepEqual(h.engine.settings.servers().filter((s) => s !== IDS.server), []);
});

test('a second ordinary member gets their own working home, help and app panel', async () => {
  const { h, seen } = await withDemo();
  const first = await h.slash('menu', '', { user: IDS.member });
  const second = await h.slash('menu', '', { user: IDS.member2 });
  const tile = h.allButtons(second).find((b) => b.custom_id === 'yo:system:open:demo');
  const firstTile = h.allButtons(first).find((b) => b.custom_id === 'yo:system:open:demo');
  assert.notEqual(tile.messageId, firstTile.messageId);
  const crossed = await h.click(firstTile.custom_id, { user: IDS.member2, messageId: firstTile.messageId });
  assert.match(h.textOf(crossed[0]), /Not your panel/);
  const opened = await h.click(tile.custom_id, { user: IDS.member2, messageId: tile.messageId });
  assert.deepEqual(seen.panel, [IDS.member2]);
  const poke = h.allButtons(opened).find((b) => b.custom_id === 'yo:demo:poke');
  const poked = await h.click(poke.custom_id, { user: IDS.member2, messageId: tile.messageId });
  assert.match(h.textOf(poked[0]), /Poked/);
  const help = await h.slash('help', 'demo', { user: IDS.member2 });
  assert.match(h.textOf(help[0]), /A sample app for tests/);
  const yap = await h.slash('yap', 'demoword hi', { user: IDS.member2 });
  assert.match(h.textOf(yap[0]), /Demo yap/);
});

test('the server owner and the bot owner can press buttons on anyone\'s panel', async () => {
  const h = await createHarness();
  h.addSecondAdmin();
  h.engine.config.ownerId = IDS.member2;
  h.engine.perms.invalidate();
  const ans = await h.slash('apps', '', { user: IDS.admin });
  const toggle = h.allButtons(ans).find((b) => b.custom_id.startsWith('yo:system:toggle:'));
  assert.ok(toggle.messageId);
  const target = toggle.custom_id.split(':')[3];
  const on = toggle.custom_id.replace(/:(on|off)$/, ':on');
  const off = toggle.custom_id.replace(/:(on|off)$/, ':off');
  const start = h.engine.settings.isEnabled(IDS.server, target);

  for (const user of [IDS.member, IDS.mod, IDS.admin2]) {
    for (const id of [on, off]) {
      const out = await h.click(id, { user, messageId: toggle.messageId });
      assert.match(h.textOf(out[0]), /Not your panel/, user);
    }
  }
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), start);

  const serverOwner = await h.click(start ? off : on, { user: IDS.owner, messageId: toggle.messageId });
  assert.doesNotMatch(h.textOf(serverOwner[0]), /Not your panel/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), !start, 'the server owner pressed it');

  const botOwner = await h.click(start ? on : off, { user: IDS.member2, messageId: toggle.messageId });
  assert.doesNotMatch(h.textOf(botOwner[0]), /Not your panel/);
  assert.equal(h.engine.settings.isEnabled(IDS.server, target), start, 'the bot owner pressed it without owning the server');

  const home = await h.slash('menu', '', { user: IDS.member });
  const tile = h.allButtons(home).find((b) => b.custom_id.startsWith('yo:system:open:'));
  assert.ok(tile.messageId);
  for (const user of [IDS.admin, IDS.admin2, IDS.mod]) {
    assert.match(h.textOf((await h.click(tile.custom_id, { user, messageId: tile.messageId }))[0]), /Not your panel/);
  }
  for (const user of [IDS.owner, IDS.member2]) {
    assert.doesNotMatch(h.textOf((await h.click(tile.custom_id, { user, messageId: tile.messageId }))[0]), /Not your panel/);
  }
});

test('without a bot owner setting, the owner on record with Yapin\' is the bot owner', async () => {
  const h = await createHarness();
  assert.equal(h.engine.isBotOwner(IDS.owner), true);
  assert.equal(h.engine.isBotOwner(IDS.admin), false);
  assert.equal(h.engine.isBotOwner(IDS.bot), false);
  assert.equal(h.engine.isBotOwner(null), false);
});

const tileIds = (h, where) => h.allButtons(where).filter((b) => b.custom_id.startsWith('yo:system:open:')).map((b) => b.custom_id.split(':')[3]).sort();
const messageById = (h, id) => h.sent().find((m) => m.id === id);
const BOOT = "🖥️ YapOS 1.0 'Boot'";

test('the home screen only shows tiles each person can use', async () => {
  const h = await createHarness();
  const memberAns = await h.slash('menu', '', { user: IDS.member });
  const member = tileIds(h, memberAns);
  for (const id of ['mod', 'automod', 'welcome', 'roles']) assert.ok(!member.includes(id), `members do not see ${id}`);
  for (const id of ['levels', 'tickets', 'studio']) assert.ok(member.includes(id), `members see ${id}`);
  assert.ok(!h.textOf(memberAns[0]).includes('**Mod**'), 'the list matches the tiles');
  const mod = tileIds(h, await h.slash('menu', '', { user: IDS.mod }));
  for (const id of ['mod', 'automod', 'levels', 'tickets', 'studio']) assert.ok(mod.includes(id), `mods see ${id}`);
  for (const id of ['welcome', 'roles']) assert.ok(!mod.includes(id), `mods do not see ${id}`);
  const adminAns = await h.slash('menu', '', { user: IDS.admin });
  const admin = tileIds(h, adminAns);
  for (const id of ['mod', 'automod', 'welcome', 'roles', 'levels', 'tickets', 'studio']) assert.ok(admin.includes(id), `admins see ${id}`);
  assert.match(h.textOf(adminAns[0]), /🛡️ \*\*Mod\*\* · /);
});

test('an app can say who its tile is for with panelPerm', async () => {
  const { defineApp } = await import('../../engine/apps.js');
  const h = await createHarness({ apps: [] });
  const make = (id, panelPerm) => defineApp({ id, name: id, icon: '🧪', description: 'Test app.', panelPerm, panel: (ctx) => ctx.info('Hi', 'There') });
  for (const [id, perm] of [['staffonly', 'mod'], ['everyone', undefined], ['mod', 'member'], ['odd', 'wizard']]) await make(id, perm).setup(h.bot);
  assert.deepEqual(tileIds(h, await h.slash('menu', '', { user: IDS.member })), ['everyone', 'mod', 'odd']);
  assert.deepEqual(tileIds(h, await h.slash('menu', '', { user: IDS.mod })), ['everyone', 'mod', 'odd', 'staffonly']);
});

test('a tile opens its app on the same message, with a way home', async () => {
  const { h, seen } = await withDemo();
  const home = await h.slash('menu', '', { user: IDS.member });
  const tile = h.allButtons(home).find((b) => b.custom_id === 'yo:system:open:demo');
  const before = h.sent().length;
  const opened = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.deepEqual(seen.panel, [IDS.member]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].type, 'update');
  assert.equal(h.sent().length, before, 'no new message');
  const msg = messageById(h, tile.messageId);
  assert.equal(msg.content, 'Demo panel');
  assert.deepEqual(msg.embeds, []);
  assert.deepEqual(h.allButtons([msg]).map((b) => b.custom_id), ['yo:demo:poke', 'yo:system:home']);
  assert.equal(msg.components.length, 2, 'Home sits on its own row');
  assert.equal(h.engine.router.panelOwner(tile.messageId), IDS.member, 'the lock stays with the opener');
  const stranger = await h.click('yo:system:home', { user: IDS.member2, messageId: tile.messageId });
  assert.match(h.textOf(stranger[0]), /Not your panel/);
  const strangerTile = await h.click(tile.custom_id, { user: IDS.member2, messageId: tile.messageId });
  assert.match(h.textOf(strangerTile[0]), /Not your panel/);
  const back = await h.click('yo:system:home', { user: IDS.member, messageId: tile.messageId });
  assert.equal(back[0].type, 'update');
  assert.equal(h.sent().length, before);
  assert.equal(messageById(h, tile.messageId).embeds[0].title, BOOT);
  assert.ok(h.allButtons([messageById(h, tile.messageId)]).some((b) => b.custom_id === 'yo:system:open:demo'));
  const again = await h.click(tile.custom_id, { user: IDS.member, messageId: tile.messageId });
  assert.equal(again[0].type, 'update');
  assert.equal(h.sent().length, before);
  assert.deepEqual(seen.panel, [IDS.member, IDS.member]);
});

test('real app tiles open in place for the person allowed to use them', async () => {
  const h = await createHarness();
  for (const [user, id] of [[IDS.mod, 'mod'], [IDS.mod, 'automod'], [IDS.admin, 'welcome'], [IDS.admin, 'roles'], [IDS.member, 'levels'], [IDS.member, 'studio']]) {
    const home = await h.slash('menu', '', { user });
    const tile = h.allButtons(home).find((b) => b.custom_id === `yo:system:open:${id}`);
    assert.ok(tile, id);
    const before = h.sent().length;
    const opened = await h.click(tile.custom_id, { user, messageId: tile.messageId });
    assert.equal(opened[0].type, 'update', id);
    assert.equal(h.sent().length, before, `${id} opened without a new message`);
    const msg = messageById(h, tile.messageId);
    assert.ok(h.allButtons([msg]).some((b) => b.custom_id === 'yo:system:home'), `${id} has a way home`);
    assert.ok(msg.components.length <= 5, id);
  }
});

test('a home screen typed in chat opens tiles in place too', async () => {
  const { h } = await withDemo();
  await h.message('/menu', { user: IDS.member });
  const home = h.lastSent(IDS.channels.general);
  assert.ok(h.allButtons([home]).some((b) => b.custom_id === 'yo:system:open:demo'));
  const before = h.sent().length;
  const opened = await h.click('yo:system:open:demo', { user: IDS.member, messageId: home.id });
  assert.equal(opened[0].type, 'update');
  assert.equal(h.sent().length, before);
  assert.match(h.textOf(messageById(h, home.id)), /Demo panel/);
  const stranger = await h.click('yo:system:open:demo', { user: IDS.member2, messageId: home.id });
  assert.match(h.textOf(stranger[0]), /Not your panel/);
});

async function withPanels() {
  const { defineApp } = await import('../../engine/apps.js');
  const h = await createHarness({ apps: [] });
  const btn = (id) => ({ type: 'button', style: 'secondary', label: id, custom_id: `yo:demo:${id}` });
  const fullRow = (r) => ({ type: 'row', components: [0, 1, 2, 3, 4].map((n) => btn(`b${r}${n}`)) });
  const panels = {
    roomy: (ctx) => ctx.ephemeral({ content: 'Roomy', components: [fullRow(0), fullRow(1), fullRow(2), fullRow(3), { type: 'row', components: [btn('last')] }] }),
    packed: (ctx) => ctx.ephemeral({ content: 'Packed', components: [0, 1, 2, 3, 4].map(fullRow) }),
    plain: (ctx) => ctx.info('Just words', 'Nothing to press here.'),
    layout: (ctx) => ctx.reply({ layout: [{ type: 17, components: [{ type: 10, content: 'V2 panel' }] }] }),
    filed: (ctx) => ctx.reply({ content: 'Here is a file', files: [{ name: 'a.txt', data: Buffer.from('hi') }] }),
  };
  for (const [id, panel] of Object.entries(panels)) await defineApp({ id, name: id, icon: '🧪', description: 'Test app.', panel }).setup(h.bot);
  const home = await h.slash('menu', '', { user: IDS.admin });
  const open = async (id) => {
    const tile = h.allButtons(home).find((b) => b.custom_id === `yo:system:open:${id}`);
    const before = h.sent().length;
    const ans = await h.click(tile.custom_id, { user: IDS.admin, messageId: tile.messageId });
    return { ans, tile, added: h.sent().length - before, msg: messageById(h, tile.messageId) };
  };
  return { h, open };
}

test('a full panel still gets a way home, merged into its last row or by falling back', async () => {
  const { h, open } = await withPanels();
  const roomy = await open('roomy');
  assert.equal(roomy.ans[0].type, 'update');
  assert.equal(roomy.msg.components.length, 5);
  assert.deepEqual(roomy.msg.components[4].components.map((b) => b.custom_id), ['yo:demo:last', 'yo:system:home']);
  await h.click('yo:system:home', { user: IDS.admin, messageId: roomy.tile.messageId });
  const packed = await open('packed');
  assert.equal(packed.added, 1, 'a full panel opens as its own message, like before');
  assert.notEqual(packed.ans[0].type, 'update');
  assert.equal(packed.msg.embeds[0].title, BOOT, 'the home screen stays as it was');
  const posted = h.lastSent(IDS.channels.general);
  assert.equal(posted.content, 'Packed');
  assert.equal(h.engine.router.panelOwner(posted.id), IDS.admin);
});

test('a panel with no buttons opens in place with a Home row', async () => {
  const { open } = await withPanels();
  const plain = await open('plain');
  assert.equal(plain.ans[0].type, 'update');
  assert.equal(plain.added, 0);
  assert.match(plain.msg.embeds[0].description, /Nothing to press here/);
  assert.deepEqual(plain.msg.components.map((r) => r.components.map((b) => b.custom_id)), [['yo:system:home']]);
});

test('panels with a V2 layout or files fall back to a new message', async () => {
  const { h, open } = await withPanels();
  const layout = await open('layout');
  assert.notEqual(layout.ans[0].type, 'update');
  assert.equal(layout.msg.embeds[0].title, BOOT);
  assert.match(h.textOf(layout.ans[0]), /V2 panel/);
  const filed = await open('filed');
  assert.ok(!filed.ans.some((a) => a.type === 'update'));
  assert.equal(filed.msg.embeds[0].title, BOOT);
});

test('the Home button rebuilds the home screen for whoever presses it', async () => {
  const { h } = await withDemo();
  const forged = await h.click('yo:system:home', { user: IDS.member });
  assert.match(h.textOf(forged[forged.length - 1]), /YapOS 1\.0 'Boot'/);
  assert.ok(!h.allButtons(forged).some((b) => b.custom_id === 'yo:system:apps'), 'no staff buttons for members');
  const noServer = await h.click('yo:system:home', { user: IDS.member, server: null });
  assert.match(h.textOf(noServer[0]), /Servers only/);
});
