import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { customId, markUndoneIn } from '../../engine/router.js';
import { dialog, denied, row, button, COLORS } from '../../engine/ui.js';
import { explain } from '../../engine/errors.js';

const S = IDS.server;
const G = IDS.channels.general;

const make = () => createHarness({ apps: [] });

async function postUndo(h, { run, manual, ttlMs, label = 'the thing' } = {}) {
  const calls = { count: 0 };
  const u = h.engine.router.addUndo({
    serverId: S, actorId: IDS.mod, label, manual, ttlMs,
    run: run || (async () => { calls.count++; }),
  });
  const other = button('Keep me', customId('sys', 'keepme'), 'primary');
  const msg = await h.bot.send(G, 'Did a thing.', { components: [row(u.button, other)] });
  return { u, msg, calls };
}

const stored = (h, msg) => h.fake.messagesIn(G).find((m) => m.id === msg.id);
const buttonsOf = (m) => (m.components || []).flatMap((r) => r.components || []);
const firstEmbed = (answers) => answers.find((a) => a.embeds?.length)?.embeds[0];

test('a used Undo turns into a disabled "Undone by" button and keeps the other buttons', async () => {
  const h = await make();
  const { u, msg, calls } = await postUndo(h);
  const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(calls.count, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'update');
  const [undone, kept] = buttonsOf(stored(h, msg));
  assert.equal(undone.label, 'Undone by Mo');
  assert.equal(undone.disabled, true);
  assert.equal(undone.emoji, '↩️');
  assert.equal(kept.label, 'Keep me');
  assert.ok(!kept.disabled);
});

test('a second click on a used Undo says who already undid it', async () => {
  const h = await make();
  const { u, msg, calls } = await postUndo(h);
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  const again = await h.click(u.button.custom_id, { user: IDS.admin, messageId: msg.id });
  assert.equal(calls.count, 1);
  assert.match(h.textOf(again[0]), /Already undone by Mo/);
  assert.equal(again[0].type, 'ephemeral');
});

test('an expired Undo says it is too late and shows the by-hand hint', async () => {
  const h = await make();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const { u, msg, calls } = await postUndo(h, { manual: '/mod untimeout @riley' });
    assert.match(u.button.custom_id, /\/mod untimeout @riley$/);
    assert.ok(u.button.custom_id.length <= 100);
    mock.timers.tick(11 * 60_000);
    const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
    const text = h.textOf(out[0]);
    assert.match(text, /Too late to undo/);
    assert.match(text, /Undo works for 10 minutes\./);
    assert.match(text, /\/mod untimeout @riley/);
    assert.equal(calls.count, 0);
  } finally {
    mock.timers.reset();
  }
});

test('an Undo from before a restart says so, with the hint carried on the button', async () => {
  const before = await make();
  const { u } = await postUndo(before, { manual: '/mod unban @sam' });
  const after = await make();
  assert.notEqual(before.engine.router.bootMarker, after.engine.router.bootMarker);
  const msg = await after.bot.send(G, 'Old message.', { components: [row(u.button)] });
  const out = await after.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  const text = after.textOf(out[0]);
  assert.match(text, /Too late to undo/);
  assert.match(text, /I restarted since then, so this can't be undone any more\./);
  assert.match(text, /\/mod unban @sam/);
});

test('an unknown Undo id uses the restart wording', async () => {
  const h = await make();
  const out = await h.click(customId('sys', 'undo', 'zzzzzz'), { user: IDS.mod });
  assert.match(h.textOf(out[0]), /I restarted since then/);
});

test('a hint too long for the button is left off the id but still shown while the bot is up', async () => {
  const h = await make();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const manual = `/mod untimeout ${'x'.repeat(120)}`;
    const { u, msg } = await postUndo(h, { manual });
    assert.ok(u.button.custom_id.length <= 100);
    mock.timers.tick(11 * 60_000);
    const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
    assert.match(h.textOf(out[0]), /xxxxxxxx/);
  } finally {
    mock.timers.reset();
  }
});

test('when the message cannot be fetched the private Undone note is shown instead', async () => {
  const h = await make();
  const { u, msg, calls } = await postUndo(h);
  h.fake.fail('GET', /\/messages\/[^/?]+$/, { status: 404, error: 'No such message' });
  const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(calls.count, 1);
  assert.equal(out[0].type, 'ephemeral');
  assert.match(h.textOf(out[0]), /Undone/);
  assert.match(h.textOf(out[0]), /Reverted: the thing/);
  h.fake.clearFailures();
  assert.match(h.textOf((await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id }))[0]), /Already undone by Mo/);
});

test('when the undo answered itself, the button is still marked by an edit', async () => {
  const h = await make();
  const { u, msg } = await postUndo(h, { run: async (i) => { await i.ephemeral('', { embeds: [dialog.ok('Unbanned', 'Sam is unbanned.')] }); } });
  const out = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(out.length, 1);
  assert.match(h.textOf(out[0]), /unbanned/);
  assert.equal(buttonsOf(stored(h, msg))[0].label, 'Undone by Mo');
});

test('an undo that reports a problem stays available and the button is untouched', async () => {
  const h = await make();
  let tries = 0;
  const { u, msg } = await postUndo(h, {
    run: async (i) => {
      tries++;
      if (tries === 1) await i.ephemeral('', { embeds: [dialog.error("I couldn't unban Sam", 'My role needs Ban Members.')] });
    },
  });
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(buttonsOf(stored(h, msg))[0].label, 'Undo: the thing');
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(tries, 2);
  assert.equal(buttonsOf(stored(h, msg))[0].label, 'Undone by Mo');
});

test('an undo that returns false or throws is not used up', async () => {
  const h = await make();
  let mode = 'false';
  const { u, msg } = await postUndo(h, {
    run: async () => {
      if (mode === 'false') return false;
      if (mode === 'throw') throw new Error('boom');
      return undefined;
    },
  });
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  mode = 'throw';
  const thrown = await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.match(h.textOf(thrown[0]), /Something went wrong/);
  mode = 'ok';
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(buttonsOf(stored(h, msg))[0].label, 'Undone by Mo');
});

test('a member pressing a mod Undo gets the denied card and the undo stays', async () => {
  const h = await make();
  const { u, msg, calls } = await postUndo(h);
  const out = await h.click(u.button.custom_id, { user: IDS.member, messageId: msg.id });
  const e = firstEmbed(out);
  assert.equal(e.title, '🔒 Needs Mod');
  assert.equal(calls.count, 0);
  await h.click(u.button.custom_id, { user: IDS.mod, messageId: msg.id });
  assert.equal(calls.count, 1);
});

test('markUndoneIn handles Components V2 buttons and returns null when the button is missing', () => {
  const layout = [{ type: 17, components: [{ type: 9, components: [{ type: 10, content: 'hi' }], accessory: { type: 2, style: 2, label: 'Undo', custom_id: 'yo:sys:undo:a:b' } }, { type: 1, components: [{ type: 2, style: 1, label: 'Other', custom_id: 'yo:x:y' }] }] }];
  const next = markUndoneIn(layout, 'yo:sys:undo:a:b', 'Undone by Mo');
  assert.equal(next[0].components[0].accessory.label, 'Undone by Mo');
  assert.equal(next[0].components[0].accessory.disabled, true);
  assert.deepEqual(next[0].components[0].accessory.emoji, { name: '↩️' });
  assert.equal(next[0].components[1].components[0].label, 'Other');
  assert.equal(markUndoneIn(layout, 'yo:sys:undo:zz:b', 'x'), null);
  assert.equal(markUndoneIn(null, 'yo:sys:undo:zz:b', 'x'), null);
});

test('the denied card: lock title, warn colour, one sentence, hint as a second line, no footer', () => {
  const e = denied('mod', { hint: 'Ask an admin.' });
  assert.equal(e.title, '🔒 Needs Mod');
  assert.equal(e.color, COLORS.warn);
  assert.equal(e.description, 'Only moderators can use this.\n-# Ask an admin.');
  assert.equal(e.footer, undefined);
  assert.equal(dialog.denied('admin').title, '🔒 Needs Admin');
  assert.equal(dialog.denied('admin').description, 'Only admins can use this.');
  assert.equal(denied('owner').title, '🔒 Needs Server owner');
  assert.equal(denied('botowner').title, '🔒 Needs Bot owner');
  assert.equal(denied(null, { title: 'Not your panel', body: 'Someone else opened this one.' }).title, '🔒 Not your panel');
});

test('perms.require refusals explain as the denied card', async () => {
  const h = await make();
  const err = await h.engine.perms.require(S, IDS.member, 'admin').then(() => null, (e) => e);
  assert.ok(err?.friendly);
  assert.equal(err.denied, true);
  assert.equal(err.need, 'admin');
  const out = explain(err);
  assert.equal(out.embed.title, '🔒 Needs Admin');
  assert.equal(out.embed.color, COLORS.warn);
  assert.equal(out.embed.footer, undefined);
  assert.match(out.embed.description, /^Only admins can use this\.$/);
  const modErr = await h.engine.perms.require(S, IDS.member, 'mod').then(() => null, (e) => e);
  assert.match(explain(modErr).embed.description, /^Only moderators can use this\.\n-# Mods are people/);
});

test('a refused component press shows the denied card', async () => {
  const h = await make();
  let ran = 0;
  h.engine.router.register('sys', 'admintest', { perm: 'admin', run: async (ctx) => { ran++; await ctx.ack(); } });
  const out = await h.click(customId('sys', 'admintest'), { user: IDS.mod });
  const e = firstEmbed(out);
  assert.equal(e.title, '🔒 Needs Admin');
  assert.equal(e.color, COLORS.warn);
  assert.equal(e.footer, undefined);
  assert.match(h.textOf(out[0]), /Only admins/);
  assert.equal(ran, 0);
  await h.click(customId('sys', 'admintest'), { user: IDS.admin });
  assert.equal(ran, 1);
});

test('Not your panel uses the denied card, and the owner bypass still works', async () => {
  const h = await make();
  let ran = 0;
  h.engine.router.register('sys', 'paneltest', { run: async (ctx) => { ran++; await ctx.ack(); } });
  const msg = await h.bot.send(G, 'Panel', { components: [row(button('Go', customId('sys', 'paneltest')))] });
  h.engine.router.claimPanel(msg.id, IDS.mod, 60_000, S);
  const out = await h.click(customId('sys', 'paneltest'), { user: IDS.member, messageId: msg.id });
  const e = firstEmbed(out);
  assert.equal(e.title, '🔒 Not your panel');
  assert.equal(e.description, `<@${IDS.mod}> opened this one. Run the command yourself to get your own.`);
  assert.equal(e.color, COLORS.warn);
  assert.equal(e.footer, undefined);
  assert.equal(ran, 0);
  await h.click(customId('sys', 'paneltest'), { user: IDS.mod, messageId: msg.id });
  await h.click(customId('sys', 'paneltest'), { user: IDS.owner, messageId: msg.id });
  assert.equal(ran, 2);
});

test('owner-arg panels use the same Not your panel card', async () => {
  const h = await make();
  h.engine.router.register('sys', 'mineonly', { owner: true, run: async (ctx) => ctx.ack() });
  const out = await h.click(customId('sys', 'mineonly', IDS.mod), { user: IDS.member });
  const e = firstEmbed(out);
  assert.equal(e.title, '🔒 Not your panel');
  assert.match(e.description, new RegExp(`<@${IDS.mod}> opened this one`));
});
