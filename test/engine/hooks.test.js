import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';
import { defineApp } from '../../engine/apps.js';
import { customId } from '../../engine/router.js';
import { createBudget } from '../../engine/budget.js';
import { row, button } from '../../engine/ui.js';

const S = IDS.server;
const G = IDS.channels.general;
const dmOf = (u) => `d${u.slice(1)}`;

async function waitFor(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

async function withProbe(h) {
  const seen = { install: [], uninstall: [], saved: [], dmSaved: [] };
  const probe = defineApp({
    id: 'probe',
    name: 'Probe',
    commands: {
      probeform: { description: 'Opens a form with an argument', run: (ctx) => ctx.form({ title: 'Probe', action: 'save', args: ['n42', ctx.userId], fields: [{ id: 'text', label: 'Text' }] }) },
    },
    components: {
      save: { perm: 'mod', owner: true, ownerArg: 1, run: async (ctx) => { seen.saved.push({ argv: ctx.argv, text: ctx.values?.text, user: ctx.userId }); return ctx.ok('Saved', 'Done.'); } },
      dmopen: { run: (ctx) => ctx.form({ title: 'Note', action: 'dmsave', args: ['k7'], fields: [{ id: 'text', label: 'Text' }] }) },
      dmsave: { run: async (ctx) => { seen.dmSaved.push({ argv: ctx.argv, text: ctx.values?.text }); return ctx.reply('Got it.'); } },
    },
    onInstall: (engine, sid) => { seen.install.push(sid); },
    onUninstall: (engine, sid) => { seen.uninstall.push(sid); },
  });
  await probe.setup(h.bot);
  return { seen, probe };
}

test('install and uninstall hooks run once per real change and stop after unload', async () => {
  const h = await createHarness({ apps: [] });
  const { seen, probe } = await withProbe(h);
  await h.click('yo:system:toggle:probe:off', { user: IDS.admin });
  await settle();
  assert.deepEqual(seen.uninstall, [S]);
  h.engine.settings.setEnabled(S, 'probe', false);
  await settle();
  assert.deepEqual(seen.uninstall, [S], 'no change, no hook');
  h.engine.settings.setEnabled(S, 'probe', true);
  await settle();
  assert.deepEqual(seen.install, [S]);
  await h.click('yo:system:toggle:probe:off', { user: IDS.member });
  await settle();
  assert.deepEqual(seen.uninstall, [S], 'a member cannot uninstall');
  await probe.teardown();
  h.engine.settings.setEnabled(S, 'probe', false);
  await settle();
  assert.deepEqual(seen.uninstall, [S], 'unloaded apps hear nothing');
  assert.throws(() => defineApp({ id: 'bad', onInstall: 'yes' }), /onInstall must be a function/);
});

test('a hook that throws is logged and never breaks the toggle', async () => {
  const h = await createHarness({ apps: [] });
  const bad = defineApp({ id: 'oops', name: 'Oops', onUninstall: () => { throw new Error('boom'); } });
  await bad.setup(h.bot);
  h.engine.settings.setEnabled(S, 'oops', false);
  await settle();
  assert.equal(h.engine.settings.isEnabled(S, 'oops'), false);
  assert.ok(h.lines.some((l) => /uninstall hook failed/.test(l)));
});

test('forms carry their arguments through a pop-up form', async () => {
  const h = await createHarness({ apps: [] });
  const { seen } = await withProbe(h);
  const ans = await h.slash('probeform', '', { user: IDS.mod });
  const modal = ans.find((a) => a.modal)?.modal;
  assert.equal(modal.custom_id, customId('probe', 'save', 'n42', IDS.mod));
  await h.submit(modal.custom_id, { text: 'hello' }, { user: IDS.mod });
  assert.deepEqual(seen.saved, [{ argv: ['n42', IDS.mod], text: 'hello', user: IDS.mod }]);
  await h.submit(modal.custom_id, { text: 'forged' }, { user: IDS.member });
  assert.equal(seen.saved.length, 1, 'perm and owner still apply to the submit');
});

test('chat forms keep their arguments and check the same rules as a click', async () => {
  const h = await createHarness({ apps: [], features: { modals: false } });
  const { seen } = await withProbe(h);
  const asked = (u) => h.sent(G).filter((m) => (m.content || '').startsWith(`<@${u}>`)).length;

  const done = h.slash('probeform', '', { user: IDS.mod });
  assert.ok(await waitFor(() => asked(IDS.mod) === 1));
  await h.message('typed answer', { user: IDS.mod });
  await done;
  assert.deepEqual(seen.saved, [{ argv: ['n42', IDS.mod], text: 'typed answer', user: IDS.mod }]);

  h.fake.state.members[S].find((m) => m.id === IDS.member).roles.push(IDS.roles.mod);
  h.engine.perms.invalidate();
  const second = h.slash('probeform', '', { user: IDS.member });
  assert.ok(await waitFor(() => asked(IDS.member) === 1));
  h.fake.state.members[S].find((m) => m.id === IDS.member).roles = [IDS.roles.member];
  h.engine.perms.invalidate();
  await h.message('sneaky', { user: IDS.member });
  await second;
  await settle();
  assert.equal(seen.saved.length, 1, 'losing the role while typing means the answer is refused');

  h.engine.settings.setEnabled(S, 'probe', true);
  const third = h.slash('probeform', '', { user: IDS.mod });
  assert.ok(await waitFor(() => asked(IDS.mod) === 2));
  h.engine.settings.setEnabled(S, 'probe', false);
  await h.message('too late', { user: IDS.mod });
  await third;
  await settle();
  assert.equal(seen.saved.length, 1, 'an app uninstalled mid-form does not save');
  assert.ok(h.sent(G).some((m) => /Probe isn't installed here/.test(h.textOf(m))));
});

test('chat forms work in DMs and the typed answer is not treated as a new DM', async () => {
  const h = await createHarness({ apps: ['pocket'], features: { modals: false } });
  const { seen } = await withProbe(h);
  const dm = dmOf(IDS.member);
  h.fake.state.dms[dm] = IDS.member;
  const asked = () => h.sent(dm).filter((m) => /\*\*Text\*\*/.test(m.content || '')).length;
  const done = h.click(customId('probe', 'dmopen'), { user: IDS.member, channel: dm, server: null });
  assert.ok(await waitFor(() => asked() === 1), `asked in the DM: ${h.sent(dm).map((m) => m.content).join(' | ')}`);
  const before = h.sent(dm).length;
  await h.dm('remind buy milk', { user: IDS.member });
  await done;
  await settle();
  assert.deepEqual(seen.dmSaved, [{ argv: ['k7'], text: 'remind buy milk' }]);
  const after = h.sent(dm).slice(before).map((m) => h.textOf(m)).join('\n');
  assert.match(after, /Got it\./);
  assert.doesNotMatch(after, /Reminder|didn't catch|What you can type here/, 'Pocket never saw the answer');
  assert.equal(h.engine.scheduler.list({ kind: 'pocket.remind', userId: IDS.member }).length, 0);
});

test('the edit memory stays bounded and a pending edit can be dropped', async () => {
  const edits = [];
  let t = 1_000_000;
  const bot = { edit: async (ch, id, content) => { edits.push([id, content]); return { id }; } };
  const budget = createBudget({ bot, now: () => t });
  await Promise.all(Array.from({ length: 2500 }, (_, i) => budget.edit({ channelId: 'c', messageId: `m${i}`, content: 'x' })));
  assert.equal(edits.length, 2500);
  assert.ok(budget.rememberedEdits <= 2000, `remembered ${budget.rememberedEdits}`);
  t += 500;
  await budget.edit({ channelId: 'c', messageId: 'live', content: 'first' });
  const pending = budget.edit({ channelId: 'c', messageId: 'live', content: 'old state' });
  assert.equal(budget.cancelEdit('live'), true);
  assert.equal(await pending, null);
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(!edits.some(([id, c]) => id === 'live' && c === 'old state'), 'the dropped edit never lands');
  assert.equal(budget.cancelEdit('live'), false);
});

test('a whole-message update from a click drops an older queued edit to the same message', async () => {
  const h = await createHarness({ apps: [] });
  const board = defineApp({
    id: 'board',
    name: 'Board',
    components: {
      press: { run: (ctx) => ctx.update({ content: 'newest', embeds: [], components: [row(button('Again', customId('board', 'press')))] }) },
      tweak: { run: (ctx) => ctx.update({ components: [row(button('Again', customId('board', 'press')))] }) },
    },
  });
  await board.setup(h.bot);
  const msg = await h.bot.send(G, 'start', { components: [row(button('Press', customId('board', 'press')))] });
  await h.engine.budget.edit({ channelId: G, messageId: msg.id, content: 'first' });
  const stale = h.engine.budget.edit({ channelId: G, messageId: msg.id, content: 'stale timer text' });
  await h.click(customId('board', 'press'), { messageId: msg.id });
  assert.equal(await stale, null);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(h.fake.state.messages[G].find((m) => m.id === msg.id).content, 'newest');

  const kept = h.engine.budget.edit({ channelId: G, messageId: msg.id, content: 'still wanted' });
  await h.click(customId('board', 'tweak'), { messageId: msg.id });
  await kept;
  assert.equal(h.fake.state.messages[G].find((m) => m.id === msg.id).content, 'still wanted', 'a buttons-only update keeps the queued edit');
});
