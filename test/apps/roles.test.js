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
});
