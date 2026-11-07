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
  const pv = await h.clickButton('Preview', { user: IDS.member, in: panel });
  assert.match(lastText(h, pv), /Preview/);
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
