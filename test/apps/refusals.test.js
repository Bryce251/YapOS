import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { customId } from '../../engine/router.js';
import { COLORS } from '../../engine/ui.js';

const S = IDS.server;
const G = IDS.channels.general;

const lastEmbed = (ans) => {
  const list = [].concat(ans).filter(Boolean);
  const last = list[list.length - 1];
  return (last?.embeds || [])[0] || null;
};

function assertDenied(embed, need, sentence) {
  assert.ok(embed, 'a refusal card is shown');
  assert.equal(embed.title, `🔒 Needs ${need}`);
  assert.equal(embed.color, COLORS.warn);
  assert.equal(embed.footer, undefined);
  if (sentence) assert.match(embed.description, sentence);
  assert.ok(!/\b40[0-9]\b/.test(embed.description));
}

test('a member running a mod command gets the shared Needs Mod card', async () => {
  const h = await createHarness({ apps: ['mod'] });
  const ans = await h.slash('ban', '@sam', { user: IDS.member });
  assertDenied(lastEmbed(ans), 'Mod', /Only moderators can use this/);
  assert.equal(h.fake.state.bans[S].length, 0);
});

test('a mod missing Ban Members gets the Needs Mod card with the exact reason', async () => {
  const h = await createHarness({ apps: ['mod'] });
  const ans = await h.slash('ban', '@sam', { user: IDS.mod });
  const embed = lastEmbed(ans);
  assertDenied(embed, 'Mod', /You need \*\*Ban Members\*\* to ban people\./);
  assert.match(embed.description, /\n-# Ask an admin/);
  assert.equal(h.fake.state.bans[S].length, 0);
});

test('a mod missing Manage Messages gets the same card for purge, typed or pressed', async () => {
  const h = await createHarness({ apps: ['mod'] });
  h.fake.state.roles[S].find((r) => r.id === IDS.roles.mod).perms.manage_messages = false;
  for (let i = 0; i < 3; i++) h.fake.addUserMessage(G, IDS.member, `hi ${i}`);
  assertDenied(lastEmbed(await h.slash('purge', '3', { user: IDS.mod })), 'Mod', /Manage Messages/);
  assertDenied(lastEmbed(await h.click('yo:mod:purge:100', { user: IDS.mod })), 'Mod', /Manage Messages/);
});

test('only the server owner may choose admin roles, shown as Needs Server owner', async () => {
  const h = await createHarness({ apps: ['mod'] });
  const ans = await h.slash('mod', 'adminrole add @VIP', { user: IDS.admin });
  assertDenied(lastEmbed(ans), 'Server owner', /Only the server owner can choose admin roles/);
  assert.ok(!(h.engine.settings.core(S).adminRoles || []).includes(IDS.roles.vip));
});

test('the system monitor refuses everyone but the bot owner with Needs Bot owner', async () => {
  const h = await createHarness({ apps: [] });
  h.engine.config.ownerId = IDS.admin;
  assertDenied(lastEmbed(await h.slash('status', '', { user: IDS.owner })), 'Bot owner', /Only YapOS's owner/);
  assertDenied(lastEmbed(await h.click('yo:system:status', { user: IDS.member })), 'Bot owner', /Only YapOS's owner/);
  const own = await h.slash('status', '', { user: IDS.admin });
  assert.match(h.textOf(own[own.length - 1]), /System monitor/);
});

test('admin-only system buttons and commands use the same card', async () => {
  const h = await createHarness({ apps: [] });
  assertDenied(lastEmbed(await h.slash('apps', '', { user: IDS.member })), 'Admin', /Only admins can use this/);
  assertDenied(lastEmbed(await h.click(customId('system', 'toggle', 'mod', 'off'), { user: IDS.mod })), 'Admin', /Only admins/);
});

test('ticket refusals use the shared card with their own reason', async () => {
  const h = await createHarness({ apps: ['tickets'] });
  await h.slash('ticket', 'help', { user: IDS.member });
  const t = Object.values(h.store.get('tickets', S, { tickets: {} }).tickets).find((x) => x.openerId === IDS.member);
  assert.ok(t, 'a ticket was opened');
  assertDenied(lastEmbed(await h.click(customId('tickets', 'claim', t.number), { user: IDS.member })), 'Staff', /Only staff/);
  assertDenied(lastEmbed(await h.slash('ticket', 'close', { user: IDS.member2, channel: t.channelId })), 'Staff', /Only staff or the person who opened this ticket can close it/);
  assertDenied(lastEmbed(await h.click(customId('tickets', 'unclaim', t.number), { user: IDS.member })), 'Admin', /Only the person who claimed this ticket/);
  assert.equal(h.store.get('tickets', S).tickets[t.number].claimedBy ?? null, null);
});

test('a typed command refused in chat shows the same card', async () => {
  const h = await createHarness({ apps: ['mod'] });
  await h.message(`!ban <@${IDS.member2}>`, { user: IDS.member });
  assertDenied(lastEmbed(h.lastSent(G)), 'Mod', /Only moderators/);
});
