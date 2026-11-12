import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';

const R = IDS.roles;
const CH = IDS.channels;
const admin = { user: IDS.admin };

const menus = (h) => h.engine.store.get('roles', IDS.server, { menus: {} }).menus;
const lastMenuId = (h) => Object.keys(menus(h)).at(-1);
const memberRoles = (h, uid = IDS.member) => h.fake.memberOf(IDS.server, uid).roles;
const last = (ans) => ans[ans.length - 1];

async function newMenu(h, title = 'Games') {
  await h.slash('roles', `new ${title}`, admin);
  return lastMenuId(h);
}

async function postedMessage(h, mid) {
  const m = menus(h)[mid];
  return h.fake.messagesIn(m.channelId).find((x) => x.id === m.messageId);
}

test('creating a menu through the form, then adding roles with the picker', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const home = await h.slash('roles', '', admin);
  assert.match(h.textOf(home[0]), /No role menus yet/);
  const form = await h.click('yo:roles:new', admin);
  assert.equal(form[0].type, 'modal');
  assert.equal(form[0].modal.custom_id, 'yo:roles:created');
  const made = await h.submit('yo:roles:created', { title: 'Games', description: 'Pick what you play' }, admin);
  assert.match(h.textOf(last(made)), /Games/);
  const mid = lastMenuId(h);
  assert.equal(mid, 'm1');
  assert.equal(menus(h)[mid].description, 'Pick what you play');

  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const sel = last(picker).components[0].components[0];
  assert.equal(sel.type, 'select');
  const labels = sel.options.map((o) => o.label);
  assert.ok(labels.includes('Gamer') && labels.includes('VIP'));
  assert.ok(!labels.includes('Admin') && !labels.includes('Founders') && !labels.includes('YapOS'), 'roles at or above the bot are hidden');
  const gamer = sel.options.find((o) => o.label === 'Gamer').value;
  const added = await h.pick(sel.custom_id, [gamer], admin);
  assert.match(h.textOf(last(added)), /Added \*\*Gamer\*\*/);
  assert.deepEqual(menus(h)[mid].items.map((i) => i.roleId), [R.gamer]);
});

test('typed add takes a role, emoji and label', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.message(`/roles add ${mid} @VIP ⭐ Very Important`, admin);
  const item = menus(h)[mid].items[0];
  assert.equal(item.roleId, R.vip);
  assert.equal(item.emoji, '⭐');
  assert.equal(item.label, 'Very Important');
  const refused = await h.slash('roles', `add ${mid} Admin`, admin);
  assert.match(h.textOf(last(refused)), /My role must be above/);
  assert.equal(menus(h)[mid].items.length, 1);
});

test('members cannot open the editor', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const ans = await h.slash('roles', '', { user: IDS.member });
  assert.match(h.textOf(ans[0]), /Only admins/);
});

test('posting a buttons menu and clicking toggles the role on and off', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer 🎮`, admin);
  const picker = await h.click(`yo:roles:post:${mid}`, admin);
  const sel = h.allButtons(picker).find((b) => b.isSelect);
  assert.ok(sel, 'channel select shown');
  assert.ok(h.findButton('Post in #get-roles', picker), 'suggests the roles channel');
  await h.pick(sel.custom_id, [CH.roles], admin);
  const msg = await postedMessage(h, mid);
  assert.ok(msg, 'menu posted in get-roles');
  assert.equal(msg.channel_id, CH.roles);
  const btn = h.allButtons([msg])[0];
  assert.equal(btn.custom_id, `yo:roles:p:${mid}:0`);

  const on = await h.click(btn.custom_id, { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.equal(on[0].type, 'ephemeral');
  assert.match(on[0].content, /Added \*\*@Gamer\*\*/);
  assert.ok(memberRoles(h).includes(R.gamer));
  const off = await h.click(btn.custom_id, { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(off[0].content, /Removed \*\*@Gamer\*\*/);
  assert.ok(!memberRoles(h).includes(R.gamer));
});

test('unique mode swaps roles, add mode never removes', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h, 'Teams');
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `add ${mid} @VIP`, admin);
  await h.slash('roles', `mode ${mid} unique`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  const swap = await h.click(`yo:roles:p:${mid}:1`, { user: IDS.member });
  assert.match(swap[0].content, /Added \*\*@VIP\*\*/);
  assert.match(swap[0].content, /Removed \*\*@Gamer\*\*/);
  assert.ok(memberRoles(h).includes(R.vip) && !memberRoles(h).includes(R.gamer));

  await h.slash('roles', `mode ${mid} add`, admin);
  const again = await h.click(`yo:roles:p:${mid}:1`, { user: IDS.member });
  assert.match(again[0].content, /only gives roles/);
  assert.ok(memberRoles(h).includes(R.vip));
});

test('editing a posted menu updates the same message', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const first = menus(h)[mid].messageId;
  await h.slash('roles', `add ${mid} @VIP`, admin);
  assert.equal(menus(h)[mid].dirty, true);
  const upd = await h.click(`yo:roles:post:${mid}`, admin);
  assert.match(h.textOf(last(upd)), /Updated the post/);
  assert.equal(menus(h)[mid].messageId, first);
  const msg = await postedMessage(h, mid);
  assert.equal(h.allButtons([msg]).length, 2);
  assert.ok(h.fake.callsTo('PATCH', new RegExp(`/messages/${first}$`)).length >= 1);
});

test('dropdown menus fall back to buttons when select menus are off, and say so', async () => {
  const h = await createHarness({ apps: ['roles'], features: { selects: false } });
  const mid = await newMenu(h, 'Colors');
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `type ${mid} dropdown`, admin);
  const ans = await h.slash('roles', `post ${mid} #get-roles`, admin);
  assert.match(h.textOf(last(ans)), /as buttons instead/);
  const msg = await postedMessage(h, mid);
  assert.ok(!JSON.stringify(msg.components).includes('"select"'));
  assert.equal(menus(h)[mid].postedAs, 'buttons');
  const on = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(on[0].content, /Added/);

  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  assert.ok(!JSON.stringify(last(picker).components).includes('"select"'), 'role picker uses buttons too');
  const vip = h.findButton('VIP', last(picker));
  await h.click(vip.custom_id, admin);
  assert.equal(menus(h)[mid].items.length, 2);
});

test('dropdown menus work when select menus are on', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h, 'Colors');
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `add ${mid} @VIP`, admin);
  await h.slash('roles', `type ${mid} dropdown`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msg = await postedMessage(h, mid);
  const sel = msg.components[0].components[0];
  assert.equal(sel.type, 'select');
  const res = await h.pick(sel.custom_id, ['0', '1'], { user: IDS.member });
  assert.match(res[0].content, /Added \*\*@Gamer\*\*/);
  assert.match(res[0].content, /Added \*\*@VIP\*\*/);
});

test('reaction menus react with each emoji and give and take roles', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h, 'Pings');
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `type ${mid} reactions`, admin);
  const refused = await h.slash('roles', `post ${mid} #get-roles`, admin);
  assert.match(h.textOf(last(refused)), /need an emoji/);
  assert.equal(menus(h)[mid].messageId, null);

  h.engine.store.update('roles', IDS.server, (d) => { d.menus[mid].items[0].emoji = '🎮'; return d; });
  await h.slash('roles', `add ${mid} @VIP ⭐`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msg = await postedMessage(h, mid);
  assert.deepEqual(msg.components, []);
  const reacted = h.fake.state.reactions.filter((r) => r.message_id === msg.id).map((r) => r.emoji);
  assert.deepEqual(reacted, ['🎮', '⭐']);

  await h.react(msg.id, '🎮', { user: IDS.member, channel: CH.roles });
  assert.ok(memberRoles(h).includes(R.gamer));
  await h.react(msg.id, '🎮', { user: IDS.member, channel: CH.roles, remove: true });
  assert.ok(!memberRoles(h).includes(R.gamer));
  await h.react(msg.id, '🎮', { user: IDS.bot, channel: CH.roles });
  assert.ok(!h.fake.memberOf(IDS.server, IDS.bot).roles.includes(R.gamer));
});

test('a role moved above the bot is refused with a friendly reason', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.fake.state.roles[IDS.server].find((r) => r.id === R.gamer).position = 8;
  const ans = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(ans[0].content, /above my role/);
  assert.match(ans[0].content, /YapOS/);
  assert.ok(!memberRoles(h).includes(R.gamer));
  const home = await h.slash('roles', '', admin);
  assert.match(h.textOf(home[0]), /Needs a look/);
});

test('a deleted role is skipped and admins are told', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `add ${mid} @VIP`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.fake.state.roles[IDS.server] = h.fake.state.roles[IDS.server].filter((r) => r.id !== R.gamer);
  const ans = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(ans[0].content, /deleted/);
  const editor = await h.slash('roles', `open ${mid}`, admin);
  assert.match(h.textOf(last(editor)), /role was deleted/);
  const home = await h.slash('roles', 'list', admin);
  assert.match(h.textOf(last(home)), /was deleted/);
  const upd = await h.click(`yo:roles:post:${mid}`, admin);
  assert.match(h.textOf(last(upd)), /Skipped 1 deleted role/);
  assert.deepEqual(menus(h)[mid].items.map((i) => i?.roleId ?? null), [null, R.vip]);
  const msg = await postedMessage(h, mid);
  assert.deepEqual(h.allButtons([msg]).map((b) => b.custom_id), [`yo:roles:p:${mid}:1`], 'the remaining role keeps its old button id');
  const ok = await h.click(`yo:roles:p:${mid}:1`, { user: IDS.member });
  assert.match(ok[0].content, /Added \*\*@VIP\*\*/);
  const stale = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(stale[0].content, /out of date/);
  assert.ok(!memberRoles(h).includes(R.gamer));
});

test('roles with staff permissions are hidden, refused when typed, and refused at click time', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const labels = last(picker).components[0].components[0].options.map((o) => o.label);
  assert.ok(!labels.includes('Moderator'), 'Moderator has kick and timeout, so it is hidden');
  const typed = await h.slash('roles', `add ${mid} @Moderator`, admin);
  assert.match(h.textOf(last(typed)), /staff permissions/);
  assert.equal(menus(h)[mid].items.length, 0);

  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.fake.state.roles[IDS.server].find((r) => r.id === R.gamer).perms = { ban_members: true };
  h.engine.perms.invalidate();
  const ans = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(ans[0].content, /staff permissions/);
  assert.ok(!memberRoles(h).includes(R.gamer));
  const home = await h.slash('roles', '', admin);
  assert.match(h.textOf(home[0]), /Ban Members/);
});

test('people with an admin role can only add roles below their own highest role', async () => {
  const h = await createHarness({ apps: ['roles'] });
  h.engine.settings.patchCore(IDS.server, { adminRoles: [R.gamer] });
  h.fake.memberOf(IDS.server, IDS.member2).roles.push(R.gamer);
  h.engine.perms.invalidate();
  const lead = { user: IDS.member2 };
  await h.slash('roles', 'new Teams', lead);
  const mid = lastMenuId(h);
  const refused = await h.slash('roles', `add ${mid} @VIP`, lead);
  assert.match(h.textOf(last(refused)), /above your highest role/);
  const picker = await h.click(`yo:roles:add:${mid}:0`, lead);
  assert.ok(!h.textOf(last(picker)).includes('VIP') && !JSON.stringify(last(picker).components).includes('"VIP"'));
  await h.slash('roles', `add ${mid} @Member`, lead);
  assert.deepEqual(menus(h)[mid].items.map((i) => i.roleId), [R.member]);
});

test('a slow admin log never delays the answer to a click', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.engine.services.set('mod', { log: () => new Promise(() => {}) });
  h.fake.state.roles[IDS.server].find((r) => r.id === R.gamer).position = 8;
  const started = Date.now();
  const ans = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(ans[0].content, /above my role/);
  assert.ok(Date.now() - started < 2000);
});

test('when role changes are still in testing the member gets a plain reason', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.fake.fail('PUT', /\/members\/[^/]+\/roles\//, { status: 403, error: 'Role management is in testing (flag bot_roles)' });
  const ans = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(ans[0].content, /still in testing/);
  assert.ok(!/403|flag/.test(ans[0].content));
  const home = await h.slash('roles', '', admin);
  assert.match(h.textOf(home[0]), /role management is still in testing/);
});

test('reaction menus take back the reactions of roles that left the menu', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h, 'Pings');
  await h.slash('roles', `add ${mid} @Gamer 🎮`, admin);
  await h.slash('roles', `add ${mid} @VIP ⭐`, admin);
  await h.slash('roles', `type ${mid} reactions`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msgId = menus(h)[mid].messageId;
  const botReactions = () => h.fake.state.reactions.filter((r) => r.message_id === msgId && r.user_id === IDS.bot).map((r) => r.emoji);
  assert.deepEqual(botReactions(), ['🎮', '⭐']);
  await h.slash('roles', `remove ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  assert.equal(menus(h)[mid].messageId, msgId);
  assert.deepEqual(botReactions(), ['⭐']);
  assert.equal(h.fake.callsTo('PUT', /reactions/).length, 2, 'existing reactions are not added twice');
  await h.slash('roles', `type ${mid} buttons`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  assert.deepEqual(botReactions(), []);
  const msg = await postedMessage(h, mid);
  assert.equal(h.allButtons([msg]).length, 1);
});

test('delete takes the post down and Undo brings it back', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const oldMsg = menus(h)[mid].messageId;
  const del = await h.click(`yo:roles:del:${mid}`, admin);
  assert.match(h.textOf(last(del)), /Menu deleted/);
  assert.equal(menus(h)[mid], undefined);
  assert.ok(!h.fake.messagesIn(CH.roles).some((m) => m.id === oldMsg), 'post removed');
  const undo = h.findButton('Undo', del);
  assert.ok(undo);
  const denied = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only admins/);
  const back = await h.click(undo.custom_id, admin);
  assert.match(h.textOf(back[0]), /Menu restored/);
  const restored = menus(h)[mid];
  assert.ok(restored);
  assert.ok(restored.messageId && restored.messageId !== oldMsg, 'posted again');
  assert.ok(await postedMessage(h, mid));
});

test('removing a role from a menu has an Undo', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const ans = await h.click(`yo:roles:unitem:${mid}:0`, admin);
  assert.match(h.textOf(last(ans)), /Took \*\*Gamer\*\* off/);
  assert.equal(menus(h)[mid].items[0], null);
  await h.click(h.findButton('Undo', ans).custom_id, admin);
  assert.equal(menus(h)[mid].items[0].roleId, R.gamer);
});

test('emoji and label are set through the form', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const form = await h.click(`yo:roles:itemform:${mid}:0`, admin);
  assert.equal(form[0].type, 'modal');
  const bad = await h.submit('yo:roles:itemsave', { emoji: 'notanemoji', label: 'Gamers' }, admin);
  assert.match(h.textOf(last(bad)), /doesn't look like one emoji/);
  await h.submit('yo:roles:itemsave', { emoji: '🎮', label: 'Gamers' }, admin);
  assert.deepEqual({ ...menus(h)[mid].items[0] }, { roleId: R.gamer, emoji: '🎮', label: 'Gamers' });
});

test('a full 25 role menu fits 5 rows and every custom id is under 100 characters', async () => {
  const h = await createHarness({ apps: ['roles'] });
  for (let i = 0; i < 23; i++) {
    h.fake.state.roles[IDS.server].push({ id: `r0000000-0000-4000-8100-${String(i).padStart(12, '0')}`, name: `Game ${i + 1}`, color: null, position: 1, perms: {}, auto: null, mentionable: false });
  }
  const mid = await newMenu(h, 'A very long title for a role menu that keeps going and going and going');
  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const pickAll = async (ans) => {
    const sel = h.allButtons(last(ans)).find((b) => b.isSelect);
    if (!sel) return null;
    return h.pick(sel.custom_id, sel.options.map((o) => o.value).slice(0, sel.max_values), admin);
  };
  await pickAll(picker);
  const again = await h.click(`yo:roles:add:${mid}:0`, admin);
  await pickAll(again);
  const items = menus(h)[mid].items;
  assert.equal(items.length, 25);
  const full = await h.click(`yo:roles:add:${mid}:0`, admin);
  assert.match(h.textOf(last(full)), /full|no more roles/i);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msg = await postedMessage(h, mid);
  assert.equal(msg.components.length, 5);
  assert.ok(msg.components.every((r) => r.components.length === 5));
  await h.click(`yo:roles:items:${mid}:1`, admin);
  await h.click(`yo:roles:preview:${mid}`, admin);
  const ids = h.allButtons().map((b) => b.custom_id);
  assert.ok(ids.length > 25);
  for (const id of ids) assert.ok(id.length <= 100, `${id} is ${id.length} chars`);
});

test('typos get a suggestion and /yap words open the editor', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const typo = await h.slash('roles', 'pots m1', admin);
  assert.match(h.textOf(last(typo)), /Did you mean/);
  const yap = await h.slash('yap', 'rolemenu', admin);
  assert.match(h.textOf(last(yap)), /Role menus/);
  const denied = await h.slash('yap', 'reactionroles', { user: IDS.member });
  assert.match(h.textOf(last(denied)), /Only admins/);
});

test('gaming preset drafts a Games menu and points at the roles channel', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const app = h.engine.apps.get('roles');
  const channels = await h.engine.detectChannels(IDS.server);
  const line = await app.def.applyPreset(h.engine, IDS.server, { preset: 'gaming', channels });
  assert.match(line, /Games/);
  assert.match(line, /#get-roles/);
  const games = Object.values(menus(h)).find((m) => m.title === 'Games');
  assert.ok(games && games.messageId === null, 'drafted, not posted');
  await app.def.applyPreset(h.engine, IDS.server, { preset: 'gaming', channels });
  assert.equal(Object.keys(menus(h)).length, 1, 'running it twice does not duplicate');
  const other = await app.def.applyPreset(h.engine, IDS.server, { preset: 'study', channels: {} });
  assert.match(other, /Roles/);
  assert.equal(Object.keys(menus(h)).length, 1);
});

test('panel shows the editor to admins and a note to members', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const ans = await h.click('yo:system:open:roles', admin);
  assert.match(h.textOf(last(ans)), /Role menus/);
  assert.ok(h.findButton('New menu', last(ans)));
  const m = await h.click('yo:system:open:roles', { user: IDS.member });
  assert.match(h.textOf(last(m)), /Admins post role menus/);
  assert.equal(h.allButtons(m).length, 0);
  const mod = await h.click('yo:system:open:roles', { user: IDS.mod });
  assert.equal(h.allButtons(mod).length, 0);
});

const staffButtons = (mid) => ['home', 'clear', 'new', 'created', `open:${mid}`, `add:${mid}:0`, 'addpg:zz:0', 'addsel:zz', 'addbtn:zz:0', `items:${mid}:0`, `item:${mid}:0`, `itemform:${mid}:0`, 'itemsave', `unitem:${mid}:0`, `text:${mid}`, 'textsave', `type:${mid}:reactions`, `mode:${mid}:add`, `preview:${mid}`, `post:${mid}`, `postsel:${mid}`, 'postch:zz:0', `del:${mid}`];

test('every editor button is locked to the admin who opened the panel and refused by role when forged', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const editor = await h.slash('roles', `open ${mid}`, admin);
  const panelId = last(editor).message.id;
  assert.ok(panelId);
  const actions = staffButtons(mid);
  const registered = [...h.engine.router.handlers.keys()].filter((k) => k.startsWith('roles:')).map((k) => k.split(':')[1]).filter((a) => a !== 'p' && a !== 'd');
  assert.deepEqual([...new Set(actions.map((a) => a.split(':')[0]))].sort(), registered.sort(), 'every staff action is covered');
  const before = JSON.stringify(menus(h));
  for (const action of actions) {
    const id = `yo:roles:${action}`;
    for (const user of [IDS.member, IDS.mod]) {
      const locked = await h.click(id, { user, messageId: panelId });
      assert.match(h.textOf(locked[0]), /Not your panel/, `${action} on a panel someone else opened`);
      const forged = await h.click(id, { user });
      assert.equal(forged[0].type, 'ephemeral');
      assert.match(h.textOf(forged[0]), /Only admins/, `${action} forged`);
    }
  }
  assert.equal(JSON.stringify(menus(h)), before);
  assert.equal(h.sent(CH.roles).length, 0);
});

test('another admin cannot press buttons on a panel they did not open', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  const editor = await h.slash('roles', `open ${mid}`, admin);
  h.addSecondAdmin();
  const ans = await h.clickButton('Delete', { user: IDS.admin2, in: last(editor) });
  assert.match(h.textOf(ans[0]), /Not your panel/);
  assert.ok(menus(h)[mid]);
  const mine = await h.clickButton('Delete', { user: IDS.admin, in: last(editor) });
  assert.equal(menus(h)[mid], undefined);
  const panel = h.fake.messagesIn(CH.general).find((x) => x.id === last(editor).message.id);
  const undo = h.findButton('Undo', [panel]);
  assert.ok(undo, 'the result with Undo replaced the same panel');
  assert.ok(mine.length >= 1);
  const peek = await h.click(undo.custom_id, { user: IDS.member, messageId: panel.id });
  assert.match(h.textOf(peek[0]), /Not your panel/);
  const forged = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(h.textOf(forged[0]), /Only admins/);
  assert.equal(menus(h)[mid], undefined);
  const byOwner = await h.click(undo.custom_id, { user: IDS.owner, messageId: panel.id });
  assert.doesNotMatch(h.textOf(byOwner[0]), /Not your panel/);
  assert.ok(menus(h)[mid], 'the owner can press Undo on an admin panel');
});

test('form handlers and the yap route check the role themselves', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  const asMember = (values) => h.engine.contextFor({ server_id: IDS.server, channel_id: CH.general, user_id: IDS.member, username: 'sam', values }, { app: 'roles', kind: 'modal_submit', values, args: [] });
  const handler = (action) => h.engine.router.handlers.get(`roles:${action}`);
  h.engine.store.set('roles', `form:${IDS.server}:${IDS.member}`, { kind: 'text', mid, at: Date.now() });
  await assert.rejects(handler('created').run(asMember({ title: 'Sneaky' })), /Only admins/);
  await assert.rejects(handler('textsave').run(asMember({ title: 'Sneaky' })), /Only admins/);
  await assert.rejects(handler('itemsave').run(asMember({ emoji: '🎮', label: 'Sneaky' })), /Only admins/);
  await assert.rejects(h.engine.yap.find('roles').run(asMember({})), /Only admins/);
  assert.deepEqual(Object.keys(menus(h)), [mid]);
  assert.equal(menus(h)[mid].title, 'Games');
});

test('pickers only work for the admin who opened them', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const sel = h.allButtons(last(picker)).find((b) => b.isSelect);
  const gamer = sel.options.find((o) => o.label === 'Gamer').value;
  const other = await h.pick(sel.custom_id, [gamer], { user: IDS.owner });
  assert.match(h.textOf(last(other)), /expired/);
  assert.equal(menus(h)[mid].items.length, 0);
  await h.pick(sel.custom_id, [gamer], admin);
  assert.equal(menus(h)[mid].items.length, 1);

  h.fake.features.selects = false;
  const chans = await h.click(`yo:roles:post:${mid}`, admin);
  const quick = h.findButton('get-roles', last(chans));
  assert.match(quick.custom_id, /^yo:roles:postch:/);
  const stolen = await h.click(quick.custom_id, { user: IDS.owner });
  assert.match(h.textOf(last(stolen)), /expired/);
  assert.equal(menus(h)[mid].messageId, null);
  await h.click(quick.custom_id, admin);
  assert.equal(menus(h)[mid].channelId, CH.roles);
});

test('a channel that is not in this server is refused when posting', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const foreign = 'c0000000-0000-4000-8000-0000000000ff';
  const ans = await h.pick(`yo:roles:postsel:${mid}`, [foreign], admin);
  assert.match(h.textOf(last(ans)), /can't find that channel/);
  assert.equal(menus(h)[mid].messageId, null);
  assert.equal(h.fake.callsTo('POST', new RegExp(`/channels/${foreign}/messages`)).length, 0);
});

test('posted menus are open to everyone but drafts, previews and old ids give nothing', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const draft = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member });
  assert.match(draft[0].content, /isn't posted/);
  assert.ok(!memberRoles(h).includes(R.gamer));
  const odd = await h.click('yo:roles:p:constructor:0', { user: IDS.member });
  assert.match(odd[0].content, /deleted/);

  const preview = await h.click(`yo:roles:preview:${mid}`, admin);
  const previewId = last(preview).message.id;
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msg = await postedMessage(h, mid);
  const onPreview = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member, messageId: previewId });
  assert.match(h.textOf(onPreview[0]), /Not your panel/);
  const ownPreview = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.admin, messageId: previewId });
  assert.match(ownPreview[0].content, /old copy/);
  const wrongKind = await h.pick(`yo:roles:d:${mid}`, ['0'], { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(wrongKind[0].content, /isn't posted/);
  assert.ok(!memberRoles(h).includes(R.gamer));

  const first = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(first[0].content, /Added \*\*@Gamer\*\*/);
  const second = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member2, channel: CH.roles, messageId: msg.id });
  assert.match(second[0].content, /Added \*\*@Gamer\*\*/);
  assert.ok(memberRoles(h).includes(R.gamer) && memberRoles(h, IDS.member2).includes(R.gamer));
  assert.equal(h.engine.router.panelOwner(msg.id), null);

  await h.slash('roles', `type ${mid} reactions`, admin);
  h.engine.store.update('roles', IDS.server, (d) => { d.menus[mid].items[0].emoji = '🎮'; return d; });
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const late = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(late[0].content, /isn't posted/);
  await h.react(msg.id, '🎮', { user: IDS.member2, channel: CH.roles, remove: true });
  assert.ok(!memberRoles(h, IDS.member2).includes(R.gamer));
  await h.react(msg.id, '🎮', { user: IDS.mod, channel: CH.roles });
  assert.ok(memberRoles(h, IDS.mod).includes(R.gamer));
});

const SERVER_B = '5e000000-0000-4000-8000-0000000000b2';
const B_CHANNEL = 'c0000000-0000-4000-8000-0000000000b1';
const B_BOT_ROLE = 'r0000000-0000-4000-8000-0000000000b6';
const B_FUN_ROLE = 'r0000000-0000-4000-8000-0000000000b2';
const plainRole = (n, name, position = 2) => ({ id: `r0000000-0000-4000-8200-${String(n).padStart(12, '0')}`, name, color: null, position, perms: {}, auto: null, mentionable: false });

function addSecondServer(h) {
  const s = h.fake.state;
  s.servers[SERVER_B] = { id: SERVER_B, name: 'Other Place', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 2 };
  s.roles[SERVER_B] = [
    { id: B_BOT_ROLE, name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, send_messages: true }, auto: null, mentionable: false },
    { id: B_FUN_ROLE, name: 'Fun', color: null, position: 2, perms: {}, auto: null, mentionable: false },
  ];
  s.members[SERVER_B] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [], joined_at: '2026-01-05T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [B_BOT_ROLE], joined_at: '2026-01-02T00:00:00Z' },
  ];
  s.channels[SERVER_B] = [{ id: B_CHANNEL, name: 'lobby', type: 'text', kind: 'text', server_id: SERVER_B, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  s.bans[SERVER_B] = [];
  s.everyone[SERVER_B] = { send_messages: true, view_channel: true };
}

async function postedGamerMenu(h) {
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer 🎮`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  return { mid, msg: await postedMessage(h, mid) };
}

test('a member pressing staff buttons on a panel they opened themselves is still refused by role', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const mine = await h.slash('menu', '', { user: IDS.member });
  const myPanel = mine.find((a) => a.message)?.message.id;
  assert.ok(myPanel, 'the member has a panel of their own');
  assert.equal(h.engine.router.panelOwner(myPanel), IDS.member);
  const before = JSON.stringify(menus(h));
  for (const action of staffButtons(mid)) {
    const ans = await h.click(`yo:roles:${action}`, { user: IDS.member, messageId: myPanel });
    assert.equal(ans.length, 1, `${action} gives one answer`);
    assert.equal(ans[0].type, 'ephemeral');
    assert.match(h.textOf(ans[0]), /Only admins/, `${action} on the member's own panel`);
    assert.ok(!/\b40[0-9]\b/.test(h.textOf(ans[0])));
  }
  for (const [action, values] of [['created', { title: 'Sneaky' }], ['textsave', { title: 'Sneaky' }], ['itemsave', { emoji: '🎮', label: 'Sneaky' }]]) {
    const ans = await h.submit(`yo:roles:${action}`, values, { user: IDS.member, messageId: myPanel });
    assert.match(h.textOf(ans[0]), /Only admins/);
  }
  for (const [action, values] of [['addsel:zz', ['0']], [`postsel:${mid}`, [CH.general]]]) {
    const ans = await h.pick(`yo:roles:${action}`, values, { user: IDS.member, messageId: myPanel });
    assert.match(h.textOf(ans[0]), /Only admins/);
  }
  assert.equal(JSON.stringify(menus(h)), before);
  assert.equal(h.sent(CH.roles).length, 0);

  const tile = await h.click('yo:system:open:roles', { user: IDS.member, messageId: myPanel });
  assert.match(h.textOf(last(tile)), /Admins post role menus/);
  assert.equal(h.allButtons(tile).length, 0);
  const shown = h.fake.messagesIn(CH.general).find((x) => x.id === myPanel);
  assert.ok(!h.allButtons([shown]).some((b) => b.custom_id.startsWith('yo:roles:')), 'no editor buttons leak onto the home screen');
});

test('typed chat commands and yap words refuse a member the same way the slash menu does', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const before = JSON.stringify(menus(h));
  const tries = ['!roles', '!roles new Sneaky', `!roles add ${mid} @VIP`, `!roles post ${mid} #general`, `!roles delete ${mid}`, `!roles type ${mid} reactions`, `/roles remove ${mid} @Gamer`, '!yap roles new Sneaky', `!yap rolemenu delete ${mid}`, `!yap reactionroles post ${mid} #general`];
  for (const text of tries) {
    const count = h.sent(CH.general).length;
    await h.message(text, { user: IDS.member });
    const reply = h.sent(CH.general).slice(count);
    assert.equal(reply.length, 1, text);
    assert.match(h.textOf(reply[0]), /Only admins/, text);
    assert.equal(h.allButtons(reply).length, 0, text);
  }
  for (const args of ['new Sneaky', `delete ${mid}`, `post ${mid} #general`, `mode ${mid} add`]) {
    assert.match(h.textOf(last(await h.slash('roles', args, { user: IDS.mod }))), /Only admins/);
    assert.match(h.textOf(last(await h.slash('yap', `roles ${args}`, { user: IDS.member }))), /Only admins/);
  }
  assert.equal(JSON.stringify(menus(h)), before);
  assert.equal(h.sent(CH.roles).length, 0);
});

test('the Open form button from a typed command cannot be borrowed', async () => {
  const h = await createHarness({ apps: ['roles'] });
  await h.message('!roles new', admin);
  const prompt = h.lastSent(CH.general);
  const open = h.findButton('Open form', [prompt]);
  assert.ok(open);
  const locked = await h.click(open.custom_id, { user: IDS.member, messageId: prompt.id });
  assert.match(h.textOf(locked[0]), /Not your panel/);
  const forged = await h.click(open.custom_id, { user: IDS.member });
  assert.ok(!forged.some((a) => a.type === 'modal'));
  assert.match(h.textOf(forged[0]), /Not your form/);
  const sneak = await h.submit('yo:roles:created', { title: 'Sneaky' }, { user: IDS.member });
  assert.match(h.textOf(sneak[0]), /Only admins/);
  assert.equal(Object.keys(menus(h)).length, 0);
});

test('a pending form, a picker or an Undo that belongs to an admin is useless to a member', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.click(`yo:roles:itemform:${mid}:0`, admin);
  const stolenForm = await h.submit('yo:roles:itemsave', { emoji: '💀', label: 'Hacked' }, { user: IDS.member });
  assert.match(h.textOf(stolenForm[0]), /Only admins/);
  const otherAdmin = await h.submit('yo:roles:itemsave', { emoji: '💀', label: 'Hacked' }, { user: IDS.owner });
  assert.match(h.textOf(last(otherAdmin)), /form expired/);
  assert.equal(menus(h)[mid].items[0].label, 'Gamer');

  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const sel = h.allButtons(last(picker)).find((b) => b.isSelect);
  const sess = sel.custom_id.split(':')[3];
  for (const user of [IDS.member, IDS.mod]) {
    assert.match(h.textOf((await h.pick(sel.custom_id, ['0', '1'], { user }))[0]), /Only admins/);
    assert.match(h.textOf((await h.click(`yo:roles:addbtn:${sess}:0`, { user }))[0]), /Only admins/);
    assert.match(h.textOf((await h.click(`yo:roles:postch:${sess}:0`, { user }))[0]), /Only admins/);
  }
  assert.equal(menus(h)[mid].items.length, 1);

  const removed = await h.click(`yo:roles:unitem:${mid}:0`, admin);
  const undoItem = h.findButton('Undo', removed);
  const del = await h.click(`yo:roles:del:${mid}`, admin);
  const undoMenu = h.findButton('Undo', del);
  const mine = await h.slash('menu', '', { user: IDS.member });
  const myPanel = mine.find((a) => a.message).message.id;
  for (const undo of [undoItem, undoMenu]) {
    for (const user of [IDS.member, IDS.mod]) {
      assert.match(h.textOf((await h.click(undo.custom_id, { user }))[0]), /Only admins/);
    }
    assert.match(h.textOf((await h.click(undo.custom_id, { user: IDS.member, messageId: myPanel }))[0]), /Only admins/);
  }
  assert.equal(menus(h)[mid], undefined);
  const real = await h.click(undoMenu.custom_id, admin);
  assert.match(h.textOf(real[0]), /Menu restored/);
  assert.equal(menus(h)[mid].items[0], null);
});

test('a session of the wrong kind is treated as expired instead of breaking', async () => {
  const h = await createHarness({ apps: ['roles'], features: { selects: false } });
  const mid = await newMenu(h);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  const chans = await h.click(`yo:roles:post:${mid}`, admin);
  const chanSess = h.findButton('get-roles', last(chans)).custom_id.split(':')[3];
  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const roleSess = h.findButton('VIP', last(picker)).custom_id.split(':')[3];
  for (const id of [`yo:roles:addbtn:${chanSess}:0`, `yo:roles:addpg:${chanSess}:0`, `yo:roles:postch:${roleSess}:0`]) {
    const ans = await h.click(id, admin);
    assert.match(h.textOf(last(ans)), /expired/, id);
  }
  const sel = await h.pick(`yo:roles:addsel:${chanSess}`, ['0'], admin);
  assert.match(h.textOf(last(sel)), /expired/);
  assert.equal(menus(h)[mid].items.length, 1);
  assert.equal(menus(h)[mid].messageId, null);
});

test('being in charge of another server gives nothing in this one', async () => {
  const h = await createHarness({ apps: ['roles'] });
  addSecondServer(h);
  const { mid, msg } = await postedGamerMenu(h);
  const inB = { user: IDS.member, server: SERVER_B, channel: B_CHANNEL };
  await h.slash('roles', 'new Mine', inB);
  const menusB = () => h.engine.store.get('roles', SERVER_B, { menus: {} }).menus;
  const midB = Object.keys(menusB()).at(-1);
  assert.ok(midB, 'the member really is an admin in the other server');

  await h.slash('roles', `add ${midB} <@&${R.vip}>`, inB);
  await h.slash('roles', `add ${midB} ${R.admin}`, inB);
  assert.equal(menusB()[midB].items.length, 0, 'roles from another server cannot be added');
  await h.slash('roles', `add ${midB} @Fun`, inB);
  assert.equal(menusB()[midB].items.length, 1);

  const foreignPost = await h.pick(`yo:roles:postsel:${midB}`, [CH.roles], inB);
  assert.match(h.textOf(last(foreignPost)), /can't find that channel/);
  await h.slash('roles', `post ${midB} <#${CH.general}>`, inB);
  assert.equal(menusB()[midB].messageId, null);
  assert.equal(h.sent(CH.roles).length, 1);
  assert.equal(h.sent(CH.general).filter((m) => /Mine/.test(h.textOf(m))).length, 0);

  const picker = await h.click(`yo:roles:add:${mid}:0`, admin);
  const sel = h.allButtons(last(picker)).find((b) => b.isSelect);
  const borrowed = await h.pick(sel.custom_id, ['0'], inB);
  assert.match(h.textOf(last(borrowed)), /expired/);
  assert.equal(menusB()[midB].items.length, 1);

  const removed = await h.click(`yo:roles:unitem:${mid}:0`, admin);
  const undo = h.findButton('Undo', removed);
  const undoFromB = await h.click(undo.custom_id, inB);
  assert.match(h.textOf(undoFromB[0]), /Only admins/);
  assert.equal(menus(h)[mid].items[0], null);
  await h.click(undo.custom_id, admin);
  assert.equal(menus(h)[mid].items[0].roleId, R.gamer);
  const before = JSON.stringify(menus(h));

  for (const action of [`del:${mid}`, `type:${mid}:reactions`, `mode:${mid}:add`, `text:${mid}`, `post:${mid}`]) {
    const here = await h.click(`yo:roles:${action}`, { user: IDS.member });
    assert.match(h.textOf(here[0]), /Only admins/);
  }
  assert.equal(JSON.stringify(menus(h)), before);

  const wrongServer = await h.click(`yo:roles:p:${mid}:0`, { ...inB, messageId: msg.id });
  assert.ok(!/Added/.test(wrongServer[0].content));
  assert.ok(!memberRoles(h).includes(R.gamer));
  assert.deepEqual(h.fake.memberOf(SERVER_B, IDS.member).roles, []);
  await h.react(msg.id, '🎮', inB);
  assert.ok(!memberRoles(h).includes(R.gamer));
});

test('roles that carry staff powers inside YapOS never go on a menu and are refused at click time', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const helper = plainRole(1, 'Helper');
  const lead = plainRole(2, 'Lead');
  const support = plainRole(3, 'Support');
  const ticket = plainRole(4, 'ticket-0001', 5);
  const trusted = plainRole(5, 'Trusted');
  const guarded = [helper, lead, support, ticket, trusted];
  h.fake.state.roles[IDS.server].push(...guarded);

  const mid = await newMenu(h, 'Open to all');
  for (const r of guarded) await h.slash('roles', `add ${mid} <@&${r.id}>`, admin);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  assert.equal(menus(h)[mid].items.length, 6);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const msg = await postedMessage(h, mid);

  h.engine.settings.patchCore(IDS.server, { modRoles: [helper.id], adminRoles: [lead.id] });
  h.engine.settings.patchApp(IDS.server, 'tickets', { staffRoles: [support.id] });
  h.engine.store.set('tickets', IDS.server, { seq: 1, tickets: { 1: { number: 1, status: 'open', openerId: IDS.member2, roleId: ticket.id } } });
  h.engine.settings.patchApp(IDS.server, 'automod', { exempt: { channels: [], roles: [trusted.id] } });
  h.engine.perms.invalidate();

  const at = { user: IDS.member, channel: CH.roles, messageId: msg.id };
  for (let idx = 0; idx < 5; idx++) {
    const ans = await h.click(`yo:roles:p:${mid}:${idx}`, at);
    assert.equal(ans[0].type, 'ephemeral');
    assert.match(ans[0].content, /won't hand it out/, `item ${idx}`);
    assert.ok(!/\b40[0-9]\b/.test(ans[0].content));
  }
  assert.deepEqual(memberRoles(h), [R.member]);
  assert.equal(await h.engine.perms.level(IDS.server, IDS.member), 'member');
  const fine = await h.click(`yo:roles:p:${mid}:5`, at);
  assert.match(fine[0].content, /Added \*\*@Gamer\*\*/);
  const other = await h.click(`yo:roles:p:${mid}:5`, { ...at, user: IDS.member2 });
  assert.match(other[0].content, /Added \*\*@Gamer\*\*/);
  const home = await h.slash('roles', '', admin);
  assert.match(h.textOf(home[0]), /stopped handing it out/);

  const second = await newMenu(h, 'Later');
  for (const r of guarded) {
    const typed = await h.slash('roles', `add ${second} <@&${r.id}>`, admin);
    assert.match(h.textOf(last(typed)), /can't go on a menu/, r.name);
  }
  assert.equal(menus(h)[second].items.length, 0);
  const picker = await h.click(`yo:roles:add:${second}:0`, admin);
  const labels = h.allButtons(last(picker)).find((b) => b.isSelect).options.map((o) => o.label);
  assert.ok(labels.includes('VIP'));
  for (const r of guarded) assert.ok(!labels.includes(r.name), `${r.name} hidden from the picker`);
});

test('guarded roles are also refused on dropdown and reaction menus, and unique mode never strips them', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const helper = plainRole(1, 'Helper');
  h.fake.state.roles[IDS.server].push(helper);
  const mid = await newMenu(h, 'Pick');
  await h.slash('roles', `add ${mid} <@&${helper.id}> 🛟`, admin);
  await h.slash('roles', `add ${mid} @Gamer 🎮`, admin);
  await h.slash('roles', `type ${mid} dropdown`, admin);
  await h.slash('roles', `mode ${mid} unique`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  h.engine.settings.patchCore(IDS.server, { modRoles: [helper.id] });
  h.fake.memberOf(IDS.server, IDS.mod).roles.push(helper.id);
  h.engine.perms.invalidate();
  let msg = await postedMessage(h, mid);
  const picked = await h.pick(`yo:roles:d:${mid}`, ['0'], { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(picked[0].content, /won't hand it out/);
  assert.deepEqual(memberRoles(h), [R.member]);
  await h.pick(`yo:roles:d:${mid}`, ['1'], { user: IDS.mod, channel: CH.roles, messageId: msg.id });
  assert.ok(memberRoles(h, IDS.mod).includes(helper.id), 'a guarded role someone already holds is left alone');
  assert.ok(memberRoles(h, IDS.mod).includes(R.gamer));

  await h.slash('roles', `mode ${mid} toggle`, admin);
  await h.slash('roles', `type ${mid} reactions`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  msg = await postedMessage(h, mid);
  await h.react(msg.id, '🛟', { user: IDS.member, channel: CH.roles });
  assert.deepEqual(memberRoles(h), [R.member]);
  await h.react(msg.id, '🛟', { user: IDS.mod, channel: CH.roles, remove: true });
  assert.ok(memberRoles(h, IDS.mod).includes(helper.id));
  await h.react(msg.id, '🎮', { user: IDS.member2, channel: CH.roles });
  assert.ok(memberRoles(h, IDS.member2).includes(R.gamer));
});

test('a role added to the editor but not yet published cannot be taken from the live post', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const { mid, msg } = await postedGamerMenu(h);
  await h.slash('roles', `add ${mid} @VIP ⭐`, admin);
  assert.equal(menus(h)[mid].dirty, true);
  const at = { user: IDS.member, channel: CH.roles, messageId: msg.id };
  const early = await h.click(`yo:roles:p:${mid}:1`, at);
  assert.match(early[0].content, /isn't on the posted menu yet/);
  assert.ok(!memberRoles(h).includes(R.vip));
  assert.match((await h.click(`yo:roles:p:${mid}:0`, at))[0].content, /Added \*\*@Gamer\*\*/);
  await h.click(`yo:roles:post:${mid}`, admin);
  assert.match((await h.click(`yo:roles:p:${mid}:1`, at))[0].content, /Added \*\*@VIP\*\*/);
  assert.match((await h.click(`yo:roles:p:${mid}:1`, { ...at, user: IDS.member2 }))[0].content, /Added \*\*@VIP\*\*/);

  await h.slash('roles', `type ${mid} reactions`, admin);
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  const live = await postedMessage(h, mid);
  const extra = plainRole(9, 'Early');
  h.fake.state.roles[IDS.server].push(extra);
  h.engine.perms.invalidate();
  await h.slash('roles', `add ${mid} <@&${extra.id}> 🚀`, admin);
  assert.equal(menus(h)[mid].items.length, 3);
  await h.react(live.id, '🚀', { user: IDS.member, channel: CH.roles });
  assert.ok(!memberRoles(h).includes(extra.id));
  await h.slash('roles', `post ${mid} #get-roles`, admin);
  await h.react(live.id, '🚀', { user: IDS.member, channel: CH.roles });
  assert.ok(memberRoles(h).includes(extra.id));
});

test('public buttons only ever change the clicker, with whatever ids are pasted in', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const { mid, msg } = await postedGamerMenu(h);
  const at = { user: IDS.member, channel: CH.roles, messageId: msg.id };
  const odd = [`p:${mid}:-1`, `p:${mid}:1`, `p:${mid}:0.5`, `p:${mid}:length`, `p:${mid}:constructor`, `p:${mid}:${IDS.owner}`, `p:${mid}`, 'p', 'p:__proto__:0', 'p:m999:0', `p:${R.admin}:0`];
  for (const action of odd) {
    const ans = await h.click(`yo:roles:${action}`, at);
    assert.equal(ans.length, 1, action);
    assert.equal(ans[0].type, 'ephemeral', action);
    assert.ok(!/Added/.test(h.textOf(ans[0])), action);
    assert.ok(!/\b(40[0-9]|500)\b|TypeError|undefined|Something went wrong/.test(h.textOf(ans[0])), action);
  }
  assert.deepEqual(memberRoles(h), [R.member]);
  const extraArg = await h.click(`yo:roles:p:${mid}:0:${IDS.member2}`, at);
  assert.match(extraArg[0].content, /Added \*\*@Gamer\*\*/);
  assert.ok(memberRoles(h).includes(R.gamer));
  assert.ok(!memberRoles(h, IDS.member2).includes(R.gamer), 'a pasted user id changes nobody else');
  const strange = await h.pick(`yo:roles:d:${mid}`, ['0', 'constructor', '-1', IDS.owner], at);
  assert.match(strange[0].content, /isn't posted/);
  assert.equal(h.fake.callsTo('PUT', new RegExp(`/members/(?!${IDS.member})[^/]+/roles/`)).length, 0);
  assert.equal(await h.engine.perms.level(IDS.server, IDS.member), 'member');
});

test('after the app is uninstalled old buttons, reactions and commands do nothing', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const { mid, msg } = await postedGamerMenu(h);
  const editor = await h.slash('roles', `open ${mid}`, admin);
  const reactMid = await newMenu(h, 'Pings');
  await h.slash('roles', `add ${reactMid} @VIP ⭐`, admin);
  await h.slash('roles', `type ${reactMid} reactions`, admin);
  await h.slash('roles', `post ${reactMid} #general`, admin);
  const reactMsg = await postedMessage(h, reactMid);
  h.engine.settings.setEnabled(IDS.server, 'roles', false);
  const before = JSON.stringify(menus(h));

  const click = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member, channel: CH.roles, messageId: msg.id });
  assert.match(h.textOf(click[0]), /isn't installed here/);
  await h.react(reactMsg.id, '⭐', { user: IDS.member });
  assert.deepEqual(memberRoles(h), [R.member]);
  const staff = await h.clickButton('Delete', { user: IDS.admin, in: last(editor) });
  assert.match(h.textOf(staff[0]), /isn't installed here/);
  for (const user of [IDS.member, IDS.admin]) {
    const slash = await h.slash('roles', 'new Again', { user });
    assert.ok(!/Made \*\*/.test(h.textOf(last(slash))));
    await h.message('!roles new Again', { user });
    const yap = await h.slash('yap', 'roles new Again', { user });
    assert.match(h.textOf(last(yap)), /isn't installed here/);
    const tile = await h.click('yo:system:open:roles', { user });
    assert.match(h.textOf(last(tile)), /isn't installed here/);
  }
  assert.equal(JSON.stringify(menus(h)), before);

  h.engine.settings.setEnabled(IDS.server, 'roles', true);
  const back = await h.click(`yo:roles:p:${mid}:0`, { user: IDS.member2, channel: CH.roles, messageId: msg.id });
  assert.match(back[0].content, /Added \*\*@Gamer\*\*/);
});

test('an admin who lost the role cannot keep using the panel they opened', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const { mid } = await postedGamerMenu(h);
  const editor = await h.slash('roles', `open ${mid}`, admin);
  const m = h.fake.memberOf(IDS.server, IDS.admin);
  m.roles = m.roles.filter((r) => r !== R.admin);
  h.engine.perms.invalidate();
  const ans = await h.clickButton('Delete', { user: IDS.admin, in: last(editor) });
  assert.match(h.textOf(ans[0]), /Only admins/);
  assert.ok(menus(h)[mid]);
});

test('hostile form values are cut down and never break the editor', async () => {
  const h = await createHarness({ apps: ['roles'] });
  const made = await h.submit('yo:roles:created', { title: `@everyone ${'x'.repeat(5000)}`, description: 'y'.repeat(9000) }, admin);
  assert.ok(last(made));
  const mid = lastMenuId(h);
  assert.ok(menus(h)[mid].title.length <= 100);
  assert.ok(menus(h)[mid].description.length <= 1000);
  await h.submit('yo:roles:created', ['not', 'a', 'form'], admin);
  await h.slash('roles', `add ${mid} @Gamer`, admin);
  await h.click(`yo:roles:itemform:${mid}:0`, admin);
  const bad = await h.submit('yo:roles:itemsave', { emoji: '<@&everyone> 🎮🎮 <script>', label: 'z'.repeat(900) }, admin);
  assert.match(h.textOf(last(bad)), /doesn't look like one emoji/);
  await h.submit('yo:roles:itemsave', { emoji: '', label: 'z'.repeat(900) }, admin);
  assert.ok(menus(h)[mid].items[0].label.length <= 80);
  assert.equal(menus(h)[mid].items[0].roleId, R.gamer);
  await h.click(`yo:roles:text:${mid}`, admin);
  await h.submit('yo:roles:textsave', { title: '', description: 'd'.repeat(5000), mid: 'm999', roleId: R.admin }, admin);
  assert.ok(menus(h)[mid].title.length > 0);
  assert.ok(menus(h)[mid].description.length <= 1000);
  for (const id of [`type:${mid}:constructor`, `mode:${mid}:__proto__`, `type:${mid}`, `item:${mid}:abc`, `unitem:${mid}:-1`, `itemform:${mid}:99`, 'open:constructor', 'del:__proto__', 'open', 'add']) {
    const ans = await h.click(`yo:roles:${id}`, admin);
    assert.ok(ans.length >= 1, id);
    assert.ok(!/Something went wrong|TypeError/.test(h.textOf(last(ans))), id);
  }
  assert.equal(menus(h)[mid].type, 'buttons');
  assert.equal(menus(h)[mid].mode, 'toggle');
});
