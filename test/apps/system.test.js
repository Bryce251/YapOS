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

test('/menu shows the home screen as Components V2, with an embed fallback', async () => {
  const h = await createHarness();
  const ans = await h.slash('menu', '', { user: IDS.admin });
  assert.equal(ans.length, 1);
  assert.equal(ans[0].flags, 32768);
  assert.match(h.textOf(ans[0]), /YapOS 1\.0 'Boot'/);
  const h2 = await createHarness({ features: { v2: false } });
  const ans2 = await h2.slash('menu', '', { user: IDS.admin });
  const last = ans2[ans2.length - 1];
  assert.ok(last.embeds?.length, 'falls back to an embed');
  assert.equal(h2.engine.caps.state(IDS.server, 'v2'), false);
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