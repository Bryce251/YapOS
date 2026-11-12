import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, uuid } from '../harness.js';

const W = IDS.channels.welcome;
const G = IDS.channels.general;
const LOG = IDS.channels.modlog;

const make = (features = {}) => createHarness({ apps: ['welcome'], features });
const cfgOf = (h) => h.engine.settings.appConfig(IDS.server, 'welcome');
const patch = (h, p) => h.engine.settings.patchApp(IDS.server, 'welcome', p);
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);

async function waitFor(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('a join posts the filled card in the detected welcome channel', async () => {
  const h = await make();
  const id = uuid(1);
  await h.join(id, { username: 'newbie' });
  const m = h.lastSent(W);
  assert.ok(m, 'posted in the welcome channel');
  assert.equal(m.content, `<@${id}>`);
  assert.equal(m.embeds[0].description, `Welcome <@${id}> to **Test Town**! You're our 7th member.`);
  assert.equal(m.embeds[0].footer.text, 'Member #7');
  assert.equal(m.embeds[0].thumbnail, undefined);
  assert.equal(h.sent(G).length, 0);
});

test('member count ordinals and username fill in as plain text when the card is off', async () => {
  const h = await make();
  patch(h, { card: false, joinText: '{username} is our {count_ord} ({count}) in {server}' });
  await h.join(uuid(1), { username: 'ana' });
  await h.join(uuid(1), { username: 'bo' });
  await h.join(uuid(1), { username: 'cy' });
  const texts = h.sent(W).map((m) => m.content);
  assert.deepEqual(texts, ['ana is our 7th (7) in Test Town', 'bo is our 8th (8) in Test Town', 'cy is our 9th (9) in Test Town']);
  assert.ok(h.sent(W).every((m) => !m.embeds?.length));
});

test('a configured channel wins, set with the typed shortcut', async () => {
  const h = await make();
  const ans = await h.slash('welcome', 'channel #general', { user: IDS.admin });
  assert.match(lastText(h, ans), /Channel saved/);
  assert.equal(cfgOf(h).channel, G);
  await h.join(uuid(1));
  assert.equal(h.sent(W).length, 0);
  assert.equal(h.sent(G).filter((m) => !/Channel saved/.test(h.textOf(m))).length, 1);
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.equal(cfgOf(h).channel, null);
});

test('leave messages are off by default and post when turned on', async () => {
  const h = await make();
  await h.leave(IDS.member);
  assert.equal(h.sent(W).length, 0);
  const ans = await h.slash('welcome', 'leave on', { user: IDS.admin });
  assert.match(lastText(h, ans), /Leave messages on/);
  await h.leave(IDS.member2);
  assert.equal(h.lastSent(W).content, '**riley** left **Test Town**. We are now 4 members.');
  await h.slash('welcome', 'leave channel #general', { user: IDS.admin });
  assert.equal(cfgOf(h).leaveChannel, G);
  await h.leave(IDS.mod);
  assert.match(h.lastSent(G).content, /morgan/);
});

test('starter roles are given on join, and a failure is logged once with a friendly reason', async () => {
  const h = await make();
  h.engine.settings.patchCore(IDS.server, { logChannel: LOG });
  let ans = await h.slash('welcome', 'autorole add Gamer', { user: IDS.admin });
  assert.match(lastText(h, ans), /Starter role added/);
  ans = await h.slash('welcome', 'autorole add Admin', { user: IDS.admin });
  assert.match(lastText(h, ans), /must be above \*\*Admin\*\*/);
  assert.deepEqual(cfgOf(h).autoroles, [IDS.roles.gamer]);

  const a = uuid(1);
  await h.join(a);
  assert.ok(h.fake.memberOf(IDS.server, a).roles.includes(IDS.roles.gamer));

  await h.slash('welcome', 'autorole add VIP', { user: IDS.admin });
  h.fake.fail('PUT', new RegExp(`roles/${IDS.roles.vip}$`), { status: 403, error: 'Missing permission' });
  await h.join(uuid(1));
  await h.join(uuid(1));
  const logs = h.sent(LOG);
  assert.equal(logs.length, 1, 'logged only once');
  const text = h.textOf(logs[0]);
  assert.match(text, /couldn't give \*\*VIP\*\*/);
  assert.match(text, /Manage Roles/);
  assert.doesNotMatch(text, /403/);

  const panel = await h.slash('welcome', '', { user: IDS.admin });
  assert.match(h.textOf(panel[0]), /Recent problems/);
});

test('starter roles from the picker check each role, with select and button fallback', async () => {
  const h = await make();
  await h.slash('welcome', '', { user: IDS.admin });
  const open = await h.clickButton('Starter roles', { user: IDS.admin });
  assert.ok(JSON.stringify(open).includes('"select"'));
  const picked = await h.pick('yo:welcome:rolepick', [IDS.roles.gamer, IDS.roles.admin], { user: IDS.admin });
  const text = lastText(h, picked);
  assert.match(text, /with a catch/);
  assert.match(text, /Admin/);
  assert.deepEqual(cfgOf(h).autoroles, [IDS.roles.gamer]);
  await h.clickButton('Undo', { user: IDS.admin, in: picked });
  assert.deepEqual(cfgOf(h).autoroles, []);

  const h2 = await make({ selects: false });
  await h2.slash('welcome', '', { user: IDS.admin });
  const view = await h2.clickButton('Starter roles', { user: IDS.admin });
  assert.ok(!JSON.stringify(view[view.length - 1].components).includes('"select"'));
  await h2.click(`yo:welcome:role:${IDS.roles.vip}`, { user: IDS.admin });
  assert.deepEqual(cfgOf(h2).autoroles, [IDS.roles.vip]);
});

test('welcome DMs fall back: a failed DM pauses them and the panel says so', async () => {
  const h = await make({ dms: false });
  await h.slash('welcome', 'dm on', { user: IDS.admin });
  await h.join(uuid(1), { username: 'dee' });
  assert.ok(h.lastSent(W), 'channel welcome still posted');
  assert.equal(h.engine.caps.state(IDS.server, 'dms'), false);
  const tries = h.fake.callsTo('POST', /\/dm$/).length;
  await h.join(uuid(1));
  assert.equal(h.fake.callsTo('POST', /\/dm$/).length, tries, 'stopped trying');
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  assert.match(h.textOf(panel[0]), /Paused/);

  const ok = await make();
  patch(ok, { dm: true });
  const id = uuid(1);
  await ok.join(id, { username: 'eve' });
  const dmCh = Object.keys(ok.fake.state.dms)[0];
  assert.match(ok.lastSent(dmCh).content, /Hi eve, welcome to \*\*Test Town\*\*/);
});

test('preview: members get a private preview, admins get the panel', async () => {
  const h = await make();
  const ans = await h.slash('welcome', '', { user: IDS.member });
  assert.equal(ans[0].type, 'ephemeral');
  const t = h.textOf(ans[0]);
  assert.match(t, /Preview/);
  assert.ok(t.includes(`Welcome <@${IDS.member}> to **Test Town**!`));
  assert.equal(h.sent().length, 0, 'nothing posted');
  const denied = await h.slash('welcome', 'leave on', { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only admins/);
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  assert.ok(h.findButton('Edit messages', panel));
  const blocked = await h.clickButton('Preview', { user: IDS.member, in: panel });
  assert.match(lastText(h, blocked), /Not your panel/);
  const own = await h.clickButton('Preview', { user: IDS.admin, in: panel });
  assert.equal(own[0].type, 'ephemeral');
  assert.match(lastText(h, own), /Preview/);
  const loose = await h.click('yo:welcome:preview', { user: IDS.member });
  assert.equal(loose[0].type, 'ephemeral');
  assert.ok(h.textOf(loose[0]).includes(`Welcome <@${IDS.member}> to **Test Town**!`));
  assert.equal(h.allButtons(loose).length, 0);
});

test('the Test button posts in the channel as if the clicker joined', async () => {
  const h = await make();
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const ans = await h.clickButton('Test', { user: IDS.admin, in: panel });
  assert.match(h.textOf(ans[0]), /Sending a test/);
  await h.settle();
  const m = h.lastSent(W);
  assert.equal(m.content, `<@${IDS.admin}>`);
  assert.match(m.embeds[0].description, /Welcome <@a0000000-0000-4000-8000-000000000002> to \*\*Test Town\*\*/);
});

test('a join burst switches to one batched welcome', async () => {
  const h = await make();
  patch(h, { card: false });
  const ids = [];
  for (let i = 0; i < 15; i++) { const id = uuid(1); ids.push(id); await h.join(id, { username: `raider${i}` }); }
  assert.equal(h.sent(W).length, 10, 'first ten greeted one by one');
  assert.equal(h.engine.service('welcome').pending(IDS.server), 5);
  await h.engine.service('welcome').flushBursts(IDS.server);
  await h.settle();
  const msgs = h.sent(W);
  assert.equal(msgs.length, 11);
  assert.equal(msgs[10].content, `👋 Welcome <@${ids[10]}>, <@${ids[11]}> and 3 others to **Test Town**!`);
});

test('editing messages with the modal form, with undo', async () => {
  const h = await make();
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const ans = await h.clickButton('Edit messages', { user: IDS.admin, in: panel });
  assert.equal(ans[0].type, 'modal');
  assert.match(h.textOf(ans[0]), /Join message/);
  const saved = await h.submit('yo:welcome:save', { join: 'Yo {user}, number {count}!', leave: 'Bye {username}', dm: '', title: 'Hiya', image: 'https://i.imgur.com/abc.png' }, { user: IDS.admin });
  assert.match(lastText(h, saved), /saved/);
  const c = cfgOf(h);
  assert.equal(c.joinText, 'Yo {user}, number {count}!');
  assert.equal(c.leaveText, 'Bye {username}');
  assert.equal(c.cardTitle, 'Hiya');
  assert.equal(c.imageUrl, 'https://i.imgur.com/abc.png');
  const id = uuid(1);
  await h.join(id);
  const m = h.lastSent(W);
  assert.equal(m.embeds[0].description, `Yo <@${id}>, number 7!`);
  assert.equal(m.embeds[0].thumbnail.url, 'https://i.imgur.com/abc.png');
  await h.clickButton('Undo', { user: IDS.admin, in: saved });
  assert.match(cfgOf(h).joinText, /You're our \{count_ord\} member/);
  const denied = await h.submit('yo:welcome:save', { join: 'hacked' }, { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only admins/);
});

test('when modals are off the form falls back to chat questions', async () => {
  const h = await make({ modals: false });
  patch(h, { imageUrl: 'https://i.imgur.com/keep.png' });
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const btn = h.findButton('Edit messages', panel);
  const done = h.click(btn.custom_id, { user: IDS.admin });
  const answers = ['Hello {user} from chat', 'skip', 'skip', 'skip', 'skip'];
  for (let i = 0; i < answers.length; i++) {
    assert.ok(await waitFor(() => h.sent(G).filter((m) => m.content.startsWith(`<@${IDS.admin}>`)).length === i + 1), `question ${i + 1} asked`);
    await h.message(answers[i], { user: IDS.admin });
  }
  const clickAnswers = await done;
  await h.settle();
  assert.equal(clickAnswers.length, 1, 'the click itself was answered');
  assert.match(h.textOf(clickAnswers[0]), /in chat/);
  assert.equal(h.engine.caps.state(IDS.server, 'modals'), false);
  assert.equal(cfgOf(h).joinText, 'Hello {user} from chat');
  assert.equal(cfgOf(h).imageUrl, 'https://i.imgur.com/keep.png', 'skipping the picture question keeps the picture');
  assert.match(h.textOf(h.lastSent(G)), /Welcome messages saved/);
});

test('a picture from a host Yapin does not allow is refused in plain words', async () => {
  const h = await make();
  const saved = await h.submit('yo:welcome:save', { join: 'Hi {user}', image: 'https://evil.example.com/cat.png' }, { user: IDS.admin });
  const t = lastText(h, saved);
  assert.match(t, /not the picture/);
  assert.match(t, /evil\.example\.com/);
  assert.equal(cfgOf(h).imageUrl, null);
  assert.equal(cfgOf(h).joinText, 'Hi {user}');
  const http = await h.slash('welcome', 'image http://i.imgur.com/a.png', { user: IDS.admin });
  assert.match(lastText(h, http), /https:\/\//);
  const good = await h.slash('welcome', 'image https://media.tenor.com/x.gif', { user: IDS.admin });
  assert.match(lastText(h, good), /Picture saved/);
  assert.equal(cfgOf(h).imageUrl, 'https://media.tenor.com/x.gif');
  const sub = await h.slash('welcome', 'image https://cdn.klipy.com/a.gif', { user: IDS.admin });
  assert.match(lastText(h, sub), /Picture saved/);
});

test('panel toggles and channel picker work with selects and with buttons', async () => {
  const h = await make();
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const off = await h.clickButton('Join: On', { user: IDS.admin, in: panel });
  assert.equal(cfgOf(h).join, false);
  assert.ok(h.findButton('Join: Off', off));
  await h.join(uuid(1));
  assert.equal(h.sent(W).length, 0);
  await h.click('yo:welcome:pick:join', { user: IDS.admin });
  await h.pick('yo:welcome:chanpick:join', [G], { user: IDS.admin });
  assert.equal(cfgOf(h).channel, G);
  const nope = await h.click('yo:welcome:toggle:join', { user: IDS.member });
  assert.match(h.textOf(nope[0]), /Only admins/);

  const h2 = await make({ selects: false });
  const view = await h2.click('yo:welcome:pick:join', { user: IDS.admin });
  const last = view[view.length - 1];
  assert.ok(!JSON.stringify(last.components).includes('"select"'));
  assert.match(h2.textOf(last), /\/welcome channel #name/);
  await h2.clickButton('#general', { user: IDS.admin, in: last });
  assert.equal(cfgOf(h2).channel, G);
});

test('typed shortcuts are forgiving and /yap words route here', async () => {
  const h = await make();
  const typo = await h.slash('welcome', 'chanel #general', { user: IDS.admin });
  assert.match(lastText(h, typo), /Channel saved/);
  const odd = await h.slash('welcome', 'banana', { user: IDS.admin });
  assert.match(lastText(h, odd), /didn't get that/);
  await h.slash('yap', 'goodbye on', { user: IDS.admin });
  assert.equal(cfgOf(h).leave, true);
  await h.slash('yap', 'autorole add Gamer', { user: IDS.admin });
  assert.deepEqual(cfgOf(h).autoroles, [IDS.roles.gamer]);
  await h.message('/welcome text Hey {user}!', { user: IDS.admin });
  assert.equal(cfgOf(h).joinText, 'Hey {user}!');
});

test('presets set themed text and the detected channel', async () => {
  const h = await make();
  const app = h.engine.apps.get('welcome');
  const channels = await h.engine.detectChannels(IDS.server);
  const line = await app.def.applyPreset(h.engine, IDS.server, { preset: 'gaming', channels });
  assert.match(line, /#👋・welcome/);
  const c = cfgOf(h);
  assert.equal(c.channel, W);
  assert.match(c.joinText, /spawned/);
  for (const p of ['gaming', 'friends', 'study', 'community', 'roleplay']) assert.ok(app.def.presets[p].config.joinText.includes('{user}'));
  const fallback = await app.def.applyPreset(h.engine, IDS.server, { preset: 'study', channels: { general: channels.general } });
  assert.match(fallback, /#general/);
});

test('the batched welcome posts on its own once the joins stop', async () => {
  const h = await make();
  patch(h, { card: false });
  const ids = [];
  for (let i = 0; i < 13; i++) { const id = uuid(1); ids.push(id); await h.join(id); }
  assert.equal(h.sent(W).length, 10);
  assert.ok(await waitFor(() => h.sent(W).length === 11, 700), 'batch posted by the timer');
  assert.equal(h.lastSent(W).content, `👋 Welcome <@${ids[10]}>, <@${ids[11]}> and <@${ids[12]}> to **Test Town**!`);
  assert.equal(h.engine.service('welcome').pending(IDS.server), 0);

  const off = await make();
  for (let i = 0; i < 12; i++) await off.join(uuid(1));
  patch(off, { join: false });
  await off.engine.service('welcome').flushBursts(IDS.server);
  await off.settle();
  assert.equal(off.sent(W).length, 10, 'no batch once join messages are off');
});

test('typed message text keeps quotes and line breaks', async () => {
  const h = await make();
  await h.slash('welcome', 'text "Howdy" {user}!\nRead the rules.', { user: IDS.admin });
  assert.equal(cfgOf(h).joinText, '"Howdy" {user}!\nRead the rules.');
  await h.slash('welcome', "leave 'Bye' {username}", { user: IDS.admin });
  assert.equal(cfgOf(h).leaveText, "'Bye' {username}");
});

test('removing one starter role keeps the others', async () => {
  const h = await make();
  patch(h, { autoroles: [IDS.roles.gamer, IDS.roles.admin] });
  const ans = await h.slash('welcome', 'autorole remove Gamer', { user: IDS.admin });
  assert.match(lastText(h, ans), /Starter role removed/);
  assert.deepEqual(cfgOf(h).autoroles, [IDS.roles.admin]);
});

test('a posting problem is logged again after the channel changes', async () => {
  const h = await make();
  h.engine.settings.patchCore(IDS.server, { logChannel: LOG });
  h.fake.fail('POST', new RegExp(`channels/${W}/messages$`), { status: 403 });
  h.fake.fail('POST', new RegExp(`channels/${G}/messages$`), { status: 403 });
  await h.join(uuid(1));
  await h.join(uuid(1));
  assert.equal(h.sent(LOG).length, 1);
  assert.match(h.textOf(h.sent(LOG)[0]), /Send Messages/);
  await h.slash('welcome', 'channel #general', { user: IDS.admin });
  await h.join(uuid(1));
  assert.equal(h.sent(LOG).length, 2);
});

const STAFF_BUTTONS = [
  ['Join: On', 'yo:welcome:toggle:join'],
  ['Leave: Off', 'yo:welcome:toggle:leave'],
  ['Card: On', 'yo:welcome:toggle:card'],
  ['DM: Off', 'yo:welcome:toggle:dm'],
  ['Channel', 'yo:welcome:pick:join'],
  ['Leave channel', 'yo:welcome:pick:leave'],
  ['Edit messages', 'yo:welcome:edit'],
  ['Starter roles', 'yo:welcome:roles'],
  ['Test', 'yo:welcome:test'],
  ['Refresh', 'yo:welcome:home'],
];

test("a member can't press any button on an admin's welcome panel", async () => {
  const h = await make();
  const before = structuredClone(cfgOf(h));
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  for (const [label, id] of STAFF_BUTTONS) {
    const btn = h.allButtons(panel).find((b) => b.custom_id === id);
    assert.equal(btn?.label, label, `${label} is on the panel`);
    assert.ok(btn.messageId, 'the click lands on the panel message');
    const ans = await h.click(id, { user: IDS.member, messageId: btn.messageId });
    assert.equal(ans.length, 1);
    assert.equal(ans[0].type, 'ephemeral');
    assert.match(h.textOf(ans[0]), /Not your panel/, label);
  }
  await h.settle();
  assert.deepEqual(cfgOf(h), before);
  assert.equal(h.sent(W).length, 0, 'no test welcome was posted');
  const mine = await h.clickButton('Leave: Off', { user: IDS.admin, in: panel });
  assert.equal(mine[0].type, 'update');
  assert.equal(cfgOf(h).leave, true);
});

test('leftover or forged welcome buttons are refused by role', async () => {
  const h = await make({ selects: false });
  const before = structuredClone(cfgOf(h));
  const buttons = [
    ...STAFF_BUTTONS.map(([, id]) => id),
    `yo:welcome:chan:join:${G}`,
    `yo:welcome:chan:leave:${G}`,
    'yo:welcome:chanreset',
    `yo:welcome:role:${IDS.roles.gamer}`,
    'yo:welcome:roleclear',
  ];
  for (const user of [IDS.member, IDS.mod]) {
    for (const id of buttons) {
      const ans = await h.click(id, { user });
      assert.match(h.textOf(ans[0]), /Only admins/, id);
      assert.doesNotMatch(h.textOf(ans[0]), /403/);
    }
    const picked = await h.pick('yo:welcome:chanpick:join', [G], { user });
    assert.match(h.textOf(picked[0]), /Only admins/);
    const roles = await h.pick('yo:welcome:rolepick', [IDS.roles.gamer], { user });
    assert.match(h.textOf(roles[0]), /Only admins/);
    const saved = await h.submit('yo:welcome:save', { join: 'hacked' }, { user });
    assert.match(h.textOf(saved[0]), /Only admins/);
  }
  await h.settle();
  assert.deepEqual(cfgOf(h), before);
  assert.equal(h.sent(W).length, 0);
});

test('the handlers check the role themselves, not only the router', async () => {
  const h = await make();
  const before = structuredClone(cfgOf(h));
  const source = { server_id: IDS.server, channel_id: G, user_id: IDS.member, username: 'sam', values: { join: 'hacked' } };
  for (const action of ['save', 'toggle', 'chan', 'chanreset', 'role', 'roleclear', 'edit', 'test', 'home', 'pick', 'roles', 'chanpick', 'rolepick']) {
    const handler = h.engine.router.handlers.get(`welcome:${action}`);
    const ctx = h.engine.contextFor(source, { app: 'welcome', kind: 'modal_submit', values: source.values, args: ['join', G] });
    await assert.rejects(() => handler.run(ctx), /Only admins/, action);
  }
  assert.deepEqual(cfgOf(h), before);
});

test('Undo on a welcome change only works for the admin who made it', async () => {
  const h = await make();
  const ans = await h.slash('welcome', 'text Hello {user}', { user: IDS.admin });
  assert.equal(cfgOf(h).joinText, 'Hello {user}');
  const undo = h.findButton('Undo', ans);
  const blocked = await h.clickButton('Undo', { user: IDS.member, in: ans });
  assert.match(lastText(h, blocked), /Not your panel/);
  const forged = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(h.textOf(forged[0]), /Only admins/);
  const modTry = await h.click(undo.custom_id, { user: IDS.mod });
  assert.match(h.textOf(modTry[0]), /Only admins/);
  assert.equal(cfgOf(h).joinText, 'Hello {user}');
  await h.clickButton('Undo', { user: IDS.admin, in: ans });
  assert.match(cfgOf(h).joinText, /You're our \{count_ord\} member/);
});

test('members reach only the preview through /yap and the home screen', async () => {
  const h = await make();
  const before = structuredClone(cfgOf(h));
  for (const args of ['welcome leave on', 'welcome channel #general', 'welcome #general', 'goodbye on', 'autorole add Gamer', 'welcome test', 'welcome edit', 'welcome image none']) {
    const ans = await h.slash('yap', args, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /Only admins/, args);
  }
  const typed = await h.slash('welcome', 'autorole clear', { user: IDS.mod });
  assert.match(h.textOf(typed[0]), /Only admins/);
  assert.deepEqual(cfgOf(h), before);
  assert.equal(h.sent(W).length, 0);
  for (const args of ['welcome', 'goodbye', 'welcome preview']) {
    const ans = await h.slash('yap', args, { user: IDS.member });
    assert.equal(ans[0].type, 'ephemeral', args);
    assert.match(h.textOf(ans[0]), /Preview/);
    assert.equal(h.allButtons(ans).length, 0);
  }
  const app = h.engine.apps.get('welcome');
  const tap = (user) => {
    const answers = [];
    const source = {
      id: uuid(3), type: 'button', custom_id: 'yo:sys:open:welcome', server_id: IDS.server, channel_id: G, user_id: user, username: 'tap',
      reply: async (content, o = {}) => { const message = { id: uuid(9) }; answers.push({ type: 'reply', content, ...o, message }); return { message }; },
      ephemeral: async (content, o = {}) => { answers.push({ type: 'ephemeral', content, ...o }); },
      update: async () => {}, ack: async () => {},
    };
    return { answers, ctx: h.engine.contextFor(source, { app: 'welcome', args: '' }) };
  };
  const memberTap = tap(IDS.member);
  await app.def.panel(memberTap.ctx);
  assert.equal(memberTap.answers[0].type, 'ephemeral');
  assert.match(h.textOf(memberTap.answers[0]), /Preview/);
  assert.equal(h.allButtons(memberTap.answers).length, 0, 'no settings buttons for a member');

  const adminTap = tap(IDS.admin);
  await app.def.panel(adminTap.ctx);
  const opened = adminTap.answers[0];
  assert.ok(h.findButton('Edit messages', [opened]));
  const blocked = await h.click('yo:welcome:toggle:join', { user: IDS.member, messageId: opened.message.id });
  assert.match(lastText(h, blocked), /Not your panel/);
  assert.equal(cfgOf(h).join, true);
});

test('pickers opened from the panel stay locked to the admin', async () => {
  const h = await make({ selects: false });
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const panelId = h.findButton('Channel', panel).messageId;
  await h.click('yo:welcome:pick:join', { user: IDS.admin, messageId: panelId });
  const blocked = await h.click(`yo:welcome:chan:join:${G}`, { user: IDS.member, messageId: panelId });
  assert.match(lastText(h, blocked), /Not your panel/);
  assert.equal(cfgOf(h).channel, null);
  await h.click(`yo:welcome:chan:join:${G}`, { user: IDS.admin, messageId: panelId });
  assert.equal(cfgOf(h).channel, G);
  const undo = h.findButton('Undo', h.sent(G));
  assert.equal(undo.messageId, panelId);
  const undoBlocked = await h.click(undo.custom_id, { user: IDS.member2, messageId: panelId });
  assert.match(lastText(h, undoBlocked), /Not your panel/);
  assert.equal(cfgOf(h).channel, G);
});

test("an admin can't make a role above their own a starter role", async () => {
  const h = await make({ selects: false });
  h.engine.settings.patchCore(IDS.server, { adminRoles: [IDS.roles.vip] });
  h.fake.memberOf(IDS.server, IDS.member).roles.push(IDS.roles.vip);
  const high = await h.slash('welcome', 'autorole add Moderator', { user: IDS.member });
  assert.match(lastText(h, high), /your own highest role/);
  assert.deepEqual(cfgOf(h).autoroles, []);
  await h.click(`yo:welcome:role:${IDS.roles.mod}`, { user: IDS.member });
  assert.deepEqual(cfgOf(h).autoroles, []);
  await h.click(`yo:welcome:role:${uuid(7)}`, { user: IDS.member });
  assert.deepEqual(cfgOf(h).autoroles, []);
  const low = await h.slash('welcome', 'autorole add Gamer', { user: IDS.member });
  assert.match(lastText(h, low), /Starter role added/);
  assert.deepEqual(cfgOf(h).autoroles, [IDS.roles.gamer]);
  const owner = await h.slash('welcome', 'autorole add Moderator', { user: IDS.owner });
  assert.match(lastText(h, owner), /Starter role added/);
});

test('welcome messages posted for everyone carry no buttons', async () => {
  const h = await make();
  patch(h, { leave: true });
  await h.join(uuid(1), { username: 'newbie' });
  await h.leave(IDS.member2);
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  await h.clickButton('Test', { user: IDS.admin, in: panel });
  await h.settle();
  assert.equal(h.sent(W).length, 3);
  assert.equal(h.allButtons(h.sent(W)).length, 0);
});

const S2 = '5e000000-0000-4000-8000-000000000002';
const C2 = 'c0000000-0000-4000-8000-0000000000a1';
const R2 = { bot: 'r0000000-0000-4000-8000-0000000000a6', low: 'r0000000-0000-4000-8000-0000000000a1' };

function addSecondServer(h) {
  const st = h.fake.state;
  st.servers[S2] = { id: S2, name: 'Other Town', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 1 };
  st.roles[S2] = [
    { id: R2.bot, name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, send_messages: true }, auto: null, mentionable: false },
    { id: R2.low, name: 'Low', color: null, position: 1, perms: {}, auto: null, mentionable: false },
  ];
  st.members[S2] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [], joined_at: '2026-01-05T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [R2.bot], joined_at: '2026-01-02T00:00:00Z' },
  ];
  st.channels[S2] = [{ id: C2, name: 'lobby', type: 'text', kind: 'text', server_id: S2, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[S2] = [];
  st.everyone[S2] = { send_messages: true, view_channel: true };
}

const FORGED = [
  ...STAFF_BUTTONS.map(([, id]) => id),
  `yo:welcome:chan:join:${G}`,
  `yo:welcome:chan:leave:${G}`,
  'yo:welcome:chanreset',
  `yo:welcome:role:${IDS.roles.gamer}`,
  `yo:welcome:role:${IDS.roles.mod}`,
  'yo:welcome:roleclear',
];

test('a member who opens their own menu cannot ride its lock into welcome settings', async () => {
  const h = await make({ selects: false });
  patch(h, { autoroles: [IDS.roles.gamer] });
  const before = structuredClone(cfgOf(h));
  const menu = await h.slash('menu', '', { user: IDS.member });
  const mine = menu.find((a) => a.message)?.message.id;
  assert.ok(mine, 'the member has a menu message of their own');
  assert.equal(h.engine.router.panelOwner(mine), IDS.member);
  for (const id of FORGED) {
    const ans = await h.click(id, { user: IDS.member, messageId: mine });
    assert.equal(ans.length, 1, id);
    assert.match(h.textOf(ans[0]), /Only admins/, id);
  }
  for (const [id, values] of [['yo:welcome:chanpick:join', [G]], ['yo:welcome:chanpick:leave', [G]], ['yo:welcome:rolepick', [IDS.roles.mod, IDS.roles.vip]]]) {
    const ans = await h.pick(id, values, { user: IDS.member, messageId: mine });
    assert.match(h.textOf(ans[0]), /Only admins/, id);
  }
  const saved = await h.submit('yo:welcome:save', { join: '@everyone free stuff', image: 'none' }, { user: IDS.member, messageId: mine });
  assert.match(h.textOf(saved[0]), /Only admins/);
  await h.settle();
  assert.deepEqual(cfgOf(h), before);
  assert.equal(h.sent(W).length, 0);

  const tile = await h.click('yo:system:open:welcome', { user: IDS.member, messageId: mine });
  assert.equal(tile.length, 1);
  assert.equal(tile[0].type, 'ephemeral');
  assert.match(h.textOf(tile[0]), /Preview/);
  assert.equal(h.allButtons(tile).length, 0, 'the tile gives a member no settings buttons');

  const adminMenu = await h.slash('menu', '', { user: IDS.admin });
  const theirs = adminMenu.find((a) => a.message).message.id;
  const stolen = await h.click('yo:system:open:welcome', { user: IDS.member, messageId: theirs });
  assert.match(h.textOf(stolen[0]), /Not your panel/);
  const opened = await h.click('yo:system:open:welcome', { user: IDS.admin, messageId: theirs });
  const panelId = opened.find((a) => a.message).message.id;
  assert.ok(h.findButton('Edit messages', opened));
  const press = await h.click('yo:welcome:toggle:leave', { user: IDS.member, messageId: panelId });
  assert.match(h.textOf(press[0]), /Not your panel/);
  const other = await h.click('yo:welcome:toggle:leave', { user: IDS.member2, messageId: panelId });
  assert.match(h.textOf(other[0]), /Not your panel/);
  assert.deepEqual(cfgOf(h), before);
});

test('typed chat commands give a member nothing more than the slash menu does', async () => {
  const h = await make();
  const before = structuredClone(cfgOf(h));
  for (const text of ['!welcome leave on', '!welcome #general', '/welcome channel #general', '!welcome autorole add Moderator', '!welcome text hacked', '!welcome dm on', '!welcome image none', '!welcome test', '!welcome edit', '!yap goodbye on', '!yap autorole add Gamer', '!yap greet off']) {
    const count = h.sent().length;
    await h.message(text, { user: IDS.member });
    const fresh = h.sent().slice(count);
    assert.equal(fresh.length, 1, text);
    assert.match(h.textOf(fresh[0]), /Only admins/, text);
    assert.doesNotMatch(h.textOf(fresh[0]), /403/);
    assert.equal(h.allButtons(fresh).length, 0, text);
  }
  assert.deepEqual(cfgOf(h), before);
  assert.equal(h.sent(W).length, 0);
  const count = h.sent().length;
  await h.message('!welcome', { user: IDS.member });
  const preview = h.sent().slice(count);
  assert.match(h.textOf(preview[0]), /Preview/);
  assert.equal(h.allButtons(preview).length, 0);

  await h.message('!welcome', { user: IDS.admin });
  const panel = h.lastSent(G);
  assert.ok(h.findButton('Edit messages', [panel]));
  assert.equal(h.engine.router.panelOwner(panel.id), IDS.admin);
  for (const [, id] of STAFF_BUTTONS) {
    const ans = await h.click(id, { user: IDS.member, messageId: panel.id });
    assert.match(h.textOf(ans[0]), /Not your panel/, id);
  }
  await h.settle();
  assert.deepEqual(cfgOf(h), before);

  await h.message('!welcome edit', { user: IDS.admin });
  const card = h.lastSent(G);
  const open = h.findButton('Open form', [card]);
  assert.ok(open, 'the typed command offers an Open form button');
  const onCard = await h.click(open.custom_id, { user: IDS.member, messageId: card.id });
  assert.match(h.textOf(onCard[0]), /Not your panel/);
  const loose = await h.click(open.custom_id, { user: IDS.member });
  assert.equal(loose.length, 1);
  assert.match(h.textOf(loose[0]), /Not your form/);
  assert.ok(!loose.some((a) => a.type === 'modal'));
  assert.deepEqual(cfgOf(h), before);
});

test('ids borrowed from another server, another person or the owner get nowhere', async () => {
  const h = await make({ selects: false });
  addSecondServer(h);
  const before = structuredClone(cfgOf(h));
  const there = { user: IDS.member, server: S2, channel: C2 };
  const cfg2 = () => h.engine.settings.appConfig(S2, 'welcome');

  const own = await h.slash('welcome', '', there);
  assert.ok(h.findButton('Edit messages', own), 'the member really is in charge of their own server');
  const ownPanel = own.find((a) => a.message).message.id;

  for (const id of FORGED) {
    const ans = await h.click(id, { user: IDS.member, messageId: ownPanel });
    assert.match(h.textOf(ans[0]), /Only admins/, id);
  }
  assert.deepEqual(cfgOf(h), before);

  await h.click(`yo:welcome:chan:join:${G}`, there);
  assert.equal(cfg2().channel, null, 'a channel from another server is not accepted');
  await h.click(`yo:welcome:chan:leave:${IDS.channels.modlog}`, there);
  assert.equal(cfg2().leaveChannel, null);
  for (const stray of [IDS.roles.mod, IDS.roles.admin, IDS.roles.gamer, IDS.owner, IDS.admin, IDS.server, S2, 'everyone']) {
    await h.click(`yo:welcome:role:${stray}`, there);
    assert.deepEqual(cfg2().autoroles, [], stray);
  }
  const typed = await h.slash('welcome', `autorole add ${IDS.roles.mod}`, there);
  assert.match(lastText(h, typed), /can't find that role/);
  await h.click(`yo:welcome:role:${R2.low}`, there);
  assert.deepEqual(cfg2().autoroles, [R2.low]);
  await h.click('yo:welcome:toggle:leave', there);
  assert.equal(cfg2().leave, true);
  assert.deepEqual(cfgOf(h), before, 'the first server is untouched');

  const change = await h.slash('welcome', 'text Real text', { user: IDS.admin });
  const undo = h.findButton('Undo', change);
  for (const opts of [there, { ...there, messageId: ownPanel }, { user: IDS.member, messageId: ownPanel }]) {
    const ans = await h.click(undo.custom_id, opts);
    assert.match(h.textOf(ans[0]), /Only admins/);
  }
  assert.equal(cfgOf(h).joinText, 'Real text');
  assert.notEqual(cfg2().joinText, 'Real text');

  await h.join(uuid(1), { username: 'visitor', server: S2 });
  assert.equal(h.sent(W).length, 0);
  assert.equal(h.sent(C2).filter((m) => /Welcome <@/.test(h.textOf(m)) && !m.components?.length).length, 1);
});

test('nothing works after Welcome is uninstalled', async () => {
  const h = await make({ selects: false });
  patch(h, { card: false });
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const panelId = h.findButton('Channel', panel).messageId;
  const change = await h.slash('welcome', 'text Before uninstall', { user: IDS.admin });
  const undo = h.findButton('Undo', change);
  for (let i = 0; i < 12; i++) await h.join(uuid(1));
  assert.equal(h.engine.service('welcome').pending(IDS.server), 2);
  const posted = h.sent(W).length;

  h.engine.settings.setEnabled(IDS.server, 'welcome', false);
  const before = structuredClone(cfgOf(h));
  for (const user of [IDS.member, IDS.admin, IDS.owner]) {
    for (const id of [...FORGED, 'yo:welcome:preview']) {
      const ans = await h.click(id, { user });
      assert.match(h.textOf(ans[0]), /isn't installed here/, id);
    }
    const saved = await h.submit('yo:welcome:save', { join: 'ghost' }, { user });
    assert.match(h.textOf(saved[0]), /isn't installed here/);
    const yap = await h.slash('yap', 'welcome leave on', { user });
    assert.match(h.textOf(yap[0]), /isn't installed here/);
    const cmd = await h.slash('welcome', 'leave on', { user });
    assert.match(h.textOf(cmd[0]), /isn't installed here/);
  }
  const onPanel = await h.click('yo:welcome:toggle:join', { user: IDS.admin, messageId: panelId });
  assert.match(h.textOf(onPanel[0]), /isn't installed here/);
  const memberUndo = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(h.textOf(memberUndo[0]), /Only admins/);
  const adminUndo = await h.click(undo.custom_id, { user: IDS.admin, messageId: undo.messageId });
  assert.match(h.textOf(adminUndo[0]), /isn't installed here/);
  const tile = await h.click('yo:system:open:welcome', { user: IDS.member });
  assert.match(h.textOf(tile[0]), /isn't installed here/);
  assert.deepEqual(cfgOf(h), before);

  await h.join(uuid(1));
  await h.leave(IDS.member2);
  assert.equal(await h.engine.service('welcome').flushBursts(IDS.server), null);
  await h.settle();
  assert.equal(h.sent(W).length, posted, 'no welcome, goodbye or batch once uninstalled');
});

test('hostile button arguments and form values from an admin are handled safely', async () => {
  const h = await make({ selects: false });
  const before = structuredClone(cfgOf(h));
  for (const key of ['__proto__', 'constructor', 'toString', 'channel', 'autoroles', 'joinText', '']) {
    const ans = await h.click(`yo:welcome:toggle:${key}`, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /Old button/, key);
  }
  assert.deepEqual(cfgOf(h), before);
  assert.deepEqual(Object.keys(cfgOf(h)).sort(), Object.keys(before).sort());

  for (const id of [IDS.channels.voice, IDS.member, IDS.server, uuid(5), '']) {
    const ans = await h.click(`yo:welcome:chan:join:${id}`, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /can't find that channel/, id);
    const picked = await h.pick('yo:welcome:chanpick:leave', [id], { user: IDS.admin });
    assert.match(h.textOf(picked[0]), /can't find that channel/, id);
  }
  for (const id of [IDS.roles.top, IDS.roles.admin, IDS.roles.bot, IDS.owner, IDS.bot, IDS.server, 'everyone', uuid(7)]) {
    await h.click(`yo:welcome:role:${id}`, { user: IDS.admin });
    await h.pick('yo:welcome:rolepick', [id], { user: IDS.admin });
    assert.deepEqual(cfgOf(h).autoroles, [], id);
  }
  assert.deepEqual(cfgOf(h), before);

  for (const image of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'https://i.imgur.com.evil.example/x.png', 'https://evil.example/i.imgur.com/x.png', `https://i.imgur.com/${'a'.repeat(600)}.png`]) {
    const ans = await h.submit('yo:welcome:save', { image }, { user: IDS.admin });
    assert.match(lastText(h, ans), /not the picture/, image.slice(0, 40));
    assert.equal(cfgOf(h).imageUrl, null);
  }
  await h.submit('yo:welcome:save', { join: 'x'.repeat(5000), leave: { toString: () => 'obj' }, dm: ['a', 'b'], title: 'T'.repeat(900), image: 42 }, { user: IDS.admin });
  assert.equal(cfgOf(h).joinText.length, 1000);
  assert.equal(cfgOf(h).cardTitle.length, 200);
  assert.equal(typeof cfgOf(h).leaveText, 'string');
  assert.equal(typeof cfgOf(h).dmText, 'string');
  assert.equal(cfgOf(h).imageUrl, null);
  await h.join(uuid(1));
  assert.ok(h.lastSent(W), 'a join still posts after the oversized save');
});

test('a hostile username cannot ping or plant links through the welcome messages', async () => {
  const h = await make();
  patch(h, { leave: true, joinText: 'Hi {username} ({user})', cardTitle: 'New: {username}' });
  const bad = uuid(1);
  await h.join(bad, { username: `@everyone <@&${IDS.roles.mod}> [free](https://evil.example)\n# big` });
  const joined = h.lastSent(W);
  const text = h.textOf(joined);
  assert.equal(joined.content, `<@${bad}>`);
  assert.doesNotMatch(text, /@everyone/);
  assert.doesNotMatch(text, /<@&/);
  assert.doesNotMatch(text, /\]\(/);
  assert.doesNotMatch(text, /https:\/\//);
  assert.doesNotMatch(joined.embeds[0].description, /\n/);
  await h.leave(bad);
  const left = h.lastSent(W).content;
  assert.doesNotMatch(left, /@everyone|<@&|\]\(|https:\/\/|\n/);
  assert.match(left, /left \*\*Test Town\*\*/);

  patch(h, { card: false });
  await h.join(uuid(1), { username: '@here '.repeat(200) });
  const long = h.lastSent(W).content;
  assert.doesNotMatch(long, /@here/);
  assert.ok(long.length < 200, 'a very long name is cut short');
  await h.join(uuid(1), { username: '<<>>' });
  assert.match(h.lastSent(W).content, /Hi someone/);
  await h.join(uuid(1), { username: 'My_Bot-1234' });
  assert.match(h.lastSent(W).content, /Hi My_Bot-1234/);
});

test("an admin without staff powers can't hand a staff role to everyone who joins", async () => {
  const helper = { id: uuid(7), name: 'Helper', color: null, position: 2, perms: { kick_members: true }, auto: null, mentionable: false };
  const lowAdmin = async (features) => {
    const h = await make(features);
    h.engine.settings.patchCore(IDS.server, { adminRoles: [IDS.roles.vip] });
    h.fake.memberOf(IDS.server, IDS.member).roles.push(IDS.roles.vip);
    h.fake.state.roles[IDS.server].push({ ...helper });
    return h;
  };
  const h = await lowAdmin({ selects: false });
  const typed = await h.slash('welcome', 'autorole add Helper', { user: IDS.member });
  assert.match(lastText(h, typed), /Kick Members/);
  assert.match(lastText(h, typed), /don't have yourself/);
  await h.click(`yo:welcome:role:${helper.id}`, { user: IDS.member });
  assert.deepEqual(cfgOf(h).autoroles, []);

  const h2 = await lowAdmin();
  const picked = await h2.pick('yo:welcome:rolepick', [helper.id, IDS.roles.gamer], { user: IDS.member });
  assert.match(lastText(h2, picked), /Kick Members/);
  assert.deepEqual(cfgOf(h2).autoroles, [IDS.roles.gamer]);

  const newbie = uuid(1);
  await h.join(newbie);
  assert.ok(!h.fake.memberOf(IDS.server, newbie).roles.includes(helper.id));

  const full = await h.slash('welcome', 'autorole add Helper', { user: IDS.admin });
  assert.match(lastText(h, full), /Starter role added/);
  const gone = await h.slash('welcome', 'autorole remove Helper', { user: IDS.member });
  assert.match(lastText(h, gone), /Starter role removed/);
  const owner = await h.slash('welcome', 'autorole add Helper', { user: IDS.owner });
  assert.match(lastText(h, owner), /Starter role added/);
});

test("someone else typing in chat can't fill in an admin's form", async () => {
  const h = await make({ modals: false });
  const panel = await h.slash('welcome', '', { user: IDS.admin });
  const btn = h.findButton('Edit messages', panel);
  const done = h.click(btn.custom_id, { user: IDS.admin, messageId: btn.messageId });
  const questions = () => h.sent(G).filter((m) => m.content.startsWith(`<@${IDS.admin}>`)).length;
  assert.ok(await waitFor(() => questions() === 1));
  await h.message('@everyone hacked by sam', { user: IDS.member });
  await h.message('cancel', { user: IDS.member2 });
  await h.message('skip', { user: IDS.mod });
  assert.equal(questions(), 1, 'still waiting for the admin');
  const answers = ['The real text {user}', 'skip', 'skip', 'skip', 'skip'];
  for (let i = 0; i < answers.length; i++) {
    assert.ok(await waitFor(() => questions() === i + 1));
    if (i) await h.message('injected', { user: IDS.member });
    await h.message(answers[i], { user: IDS.admin });
  }
  await done;
  await h.settle();
  assert.equal(cfgOf(h).joinText, 'The real text {user}');
  assert.doesNotMatch(JSON.stringify(cfgOf(h)), /hacked|injected/);
});

test('a second ordinary member gets their own preview and no way in', async () => {
  const h = await make();
  const before = structuredClone(cfgOf(h));
  patch(h, { leave: true });
  for (const user of [IDS.member, IDS.member2]) {
    const name = h.fake.memberOf(IDS.server, user).username;
    for (const ans of [await h.slash('welcome', '', { user }), await h.slash('welcome', 'preview', { user }), await h.click('yo:welcome:preview', { user })]) {
      assert.equal(ans.length, 1);
      assert.equal(ans[0].type, 'ephemeral');
      assert.ok(h.textOf(ans[0]).includes(`<@${user}>`));
      assert.ok(h.textOf(ans[0]).includes(`**${name}** left`));
      assert.equal(h.allButtons(ans).length, 0);
    }
  }
  assert.equal(h.sent().length, 0, 'previews stay private');
  await h.join(uuid(1));
  assert.equal(h.allButtons(h.sent()).length, 0, 'there is no public welcome button to lean on');
  assert.deepEqual(cfgOf(h), { ...before, leave: true });
});
