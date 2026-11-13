import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { customId } from '../../engine/router.js';

const S = IDS.server;
const G = IDS.channels.general;
const LOG = IDS.channels.modlog;
const R = IDS.roles;

const REPORT = { id: 'report', name: 'Report', emoji: '🚩', questions: ['Who are you reporting?', 'What happened?'] };
const SUPPORT = { id: 'support', name: 'Support', emoji: '🎫', questions: [] };

async function make({ features = {}, config = { logChannelId: LOG } } = {}) {
  const h = await createHarness({ apps: ['tickets'], features });
  if (config) h.engine.settings.patchApp(S, 'tickets', config);
  return h;
}

const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const allTexts = (h, ans) => ans.map((a) => h.textOf(a)).join('\n');
const tickets = (h) => Object.values(h.store.get('tickets', S, { tickets: {} }).tickets);
const ticketOf = (h, user) => tickets(h).filter((t) => t.openerId === user).pop() || null;
const channel = (h, id) => h.fake.channelById(id);
const roleExists = (h, id) => h.fake.state.roles[S].some((r) => r.id === id);
const hasRole = (h, user, role) => h.fake.memberOf(S, user).roles.includes(role);

async function waitFor(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function drive(promise) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let i = 0; !done && i < 20000; i++) {
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
  }
  if (error) throw error;
  return value;
}

async function flushMocked(rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
  }
}

async function openTicketFor(h, user = IDS.member, args = '') {
  const ans = await h.slash('ticket', args, { user });
  return { ans, t: ticketOf(h, user) };
}

async function closeWithTimers(h, t, { user = IDS.member, reason = 'all good' } = {}) {
  const ask = await h.slash('ticket', `close ${reason}`, { user, channel: t.channelId });
  const btn = h.findButton('Close ticket', ask);
  assert.ok(btn, 'confirm button shown');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await drive(h.click(btn.custom_id, { user, channel: t.channelId, messageId: btn.messageId }));
    const mid = { channel: !!channel(h, t.channelId), role: t.roleId ? roleExists(h, t.roleId) : null };
    mock.timers.tick(10_000);
    await flushMocked();
    return mid;
  } finally {
    mock.timers.reset();
  }
}

test('tickets commands stay few and fit Yapin limits', async () => {
  const h = await make();
  for (const name of ['ticket', 'tickets']) {
    const c = h.bot.commands.get(name);
    assert.ok(c, `/${name} exists`);
    assert.ok(c.description.length > 0 && c.description.length <= 100);
  }
  const mine = [...h.bot.commands.keys()].filter((n) => /^ticket/.test(n));
  assert.equal(mine.length, 2);
});

test('full open flow from the posted panel button', async () => {
  const h = await make();
  const posted = await h.slash('tickets', `panel <#${G}>`, { user: IDS.admin });
  assert.match(lastText(h, posted), /Panel posted/);
  const panelMsg = h.lastSent(G);
  assert.ok(h.findButton('Open a ticket', panelMsg), 'panel has an open button');
  assert.equal(h.engine.settings.appConfig(S, 'tickets').panelMessageId, panelMsg.id);

  const before = h.fake.calls.length;
  const ans = await h.clickButton('Open a ticket', { user: IDS.member, in: panelMsg });
  const calls = h.fake.calls.slice(before);
  const firstAnswer = calls.findIndex((c) => /\/callback$/.test(c.path));
  const roleCall = calls.findIndex((c) => c.method === 'POST' && /\/roles$/.test(c.path));
  assert.ok(firstAnswer >= 0 && roleCall > firstAnswer, 'the click is answered before any slow API call');
  assert.equal(ans[0].type, 'ephemeral');
  assert.match(h.textOf(ans[0]), /Opening your ticket/);

  const t = ticketOf(h, IDS.member);
  assert.ok(t, 'ticket saved');
  assert.equal(t.number, 1);
  assert.equal(t.status, 'open');
  assert.equal(t.typeId, 'support');
  const role = h.fake.state.roles[S].find((r) => r.id === t.roleId);
  assert.equal(role.name, '🎫 0001');
  assert.equal(t.access[IDS.member], 'role');
  assert.equal(role.mentionable, false);
  assert.ok(hasRole(h, IDS.member, t.roleId), 'opener got the ticket role');
  const ch = channel(h, t.channelId);
  assert.equal(ch.name, 'ticket-0001-sam');
  assert.equal(ch.private, true);
  assert.ok(ch.role_ids.includes(t.roleId), 'ticket role can see it');
  assert.ok(ch.role_ids.includes(R.bot), "the bot's own top role keeps access");
  assert.ok(ch.role_ids.includes(R.mod), 'mods can see it');
  assert.ok(!ch.role_ids.includes(R.member), 'regular members cannot');

  const welcome = h.sent(t.channelId)[0];
  assert.ok(welcome.content.includes(`<@${IDS.member}>`), 'opener pinged');
  for (const label of ['Claim', 'Close', 'Add person']) assert.ok(h.findButton(label, welcome), `${label} button`);
  assert.equal(t.cardId, welcome.id);
  assert.match(lastText(h, ans), new RegExp(`<#${t.channelId}>`));
  assert.ok(h.sent(LOG).some((m) => /Ticket #0001 opened/.test(h.textOf(m))), 'logged');
});

test('open with /ticket and a topic, numbers keep counting', async () => {
  const h = await make();
  const { ans, t } = await openTicketFor(h, IDS.member, 'open my game keeps crashing');
  assert.equal(t.topic, 'my game keeps crashing');
  assert.match(h.textOf(h.sent(t.channelId)[0]), /my game keeps crashing/);
  assert.match(lastText(h, ans), /Your ticket is open/);
  const second = await openTicketFor(h, IDS.member2, 'billing');
  assert.equal(second.t.number, 2);
  assert.equal(channel(h, second.t.channelId).name, 'ticket-0002-riley');
});

test('the open limit stops a second ticket', async () => {
  const h = await make();
  const first = await openTicketFor(h, IDS.member, 'one');
  const channelsBefore = h.fake.state.channels[S].length;
  const again = await h.slash('ticket', 'two', { user: IDS.member });
  assert.match(allTexts(h, again), /already have a ticket open/);
  assert.match(allTexts(h, again), new RegExp(`<#${first.t.channelId}>`));
  assert.equal(h.fake.state.channels[S].length, channelsBefore);
  assert.equal(tickets(h).length, 1);
  h.engine.settings.patchApp(S, 'tickets', { limit: 2 });
  await h.slash('ticket', 'two', { user: IDS.member });
  assert.equal(tickets(h).length, 2);
});

test('a type with questions asks them in a modal and puts answers on the card', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const ans = await h.click(customId('tickets', 'open', 'report'), { user: IDS.member });
  assert.equal(ans[0].type, 'modal');
  assert.match(h.textOf(ans[0]), /Who are you reporting/);
  assert.equal(tickets(h).length, 0, 'nothing made before the answers');
  const sub = await h.submit(ans[0].modal.custom_id, { q0: 'a spam bot', q1: 'it posted links everywhere' }, { user: IDS.member });
  assert.match(h.textOf(sub[0]), /Opening your ticket/);
  const t = ticketOf(h, IDS.member);
  assert.equal(t.typeId, 'report');
  assert.deepEqual(t.answers.map((a) => a.a), ['a spam bot', 'it posted links everywhere']);
  const cardText = h.textOf(h.sent(t.channelId)[0]);
  assert.match(cardText, /Report/);
  assert.match(cardText, /it posted links everywhere/);
});

test('questions fall back to chat when modals are off', async () => {
  const h = await make({ features: { modals: false }, config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const done = h.click(customId('tickets', 'open', 'report'), { user: IDS.member });
  const replies = ['riley', 'was rude'];
  for (let i = 0; i < replies.length; i++) {
    assert.ok(await waitFor(() => h.sent(G).filter((m) => m.content.startsWith(`<@${IDS.member}>`)).length === i + 1), `question ${i + 1} asked`);
    await h.message(replies[i], { user: IDS.member });
  }
  await done;
  assert.ok(await waitFor(() => !!ticketOf(h, IDS.member)), 'ticket opened after the chat answers');
  const t = ticketOf(h, IDS.member);
  assert.deepEqual(t.answers.map((a) => a.a), ['riley', 'was rude']);
  assert.ok(await waitFor(() => h.sent(G).some((m) => new RegExp(`<#${t.channelId}>`).test(h.textOf(m)))), 'told where the ticket is');
});

test('type picker uses a select menu, with buttons when selects are off', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const ans = await h.slash('ticket', '', { user: IDS.member });
  const sel = h.allButtons(ans).find((b) => b.isSelect);
  assert.ok(sel, 'select menu shown');
  await h.pick(sel.custom_id, ['support'], { user: IDS.member2 });
  assert.equal(ticketOf(h, IDS.member2)?.typeId, 'support', 'the person who picked gets the ticket');

  const h2 = await make({ features: { selects: false }, config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const ans2 = await h2.slash('ticket', 'need a hand', { user: IDS.member });
  assert.ok(!h2.allButtons(ans2).some((b) => b.isSelect), 'no select when they are off');
  const btn = h2.findButton('Support', ans2);
  assert.ok(btn && h2.findButton('Report', ans2), 'one button per type');
  await h2.click(btn.custom_id, { user: IDS.member });
  const t = ticketOf(h2, IDS.member);
  assert.equal(t.topic, 'need a hand', 'topic carried through the picker');
  assert.equal(h2.engine.caps.state(S, 'selects'), false);
});

test('claim works for staff, members are refused, unclaim restores the card', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const cardMsg = h.sent(t.channelId)[0];
  const refused = await h.clickButton('Claim', { user: IDS.member, in: cardMsg });
  assert.match(lastText(h, refused), /Only staff/);
  assert.equal(ticketOf(h, IDS.member).claimedBy, null);

  await h.clickButton('Claim', { user: IDS.mod, in: cardMsg });
  assert.equal(ticketOf(h, IDS.member).claimedBy, IDS.mod);
  const updated = h.fake.messagesIn(t.channelId).find((m) => m.id === cardMsg.id);
  const claimed = h.allButtons(updated).find((b) => b.label === 'Claimed');
  assert.ok(claimed?.disabled, 'claim button frozen');
  assert.ok(h.findButton('Unclaim', updated));
  assert.match(h.textOf(updated), new RegExp(`<@${IDS.mod}>`));

  const other = await h.slash('ticket', 'claim', { user: IDS.admin, channel: t.channelId });
  assert.match(lastText(h, other), /Already claimed/);
  const noUnclaim = await h.clickButton('Unclaim', { user: IDS.member, in: updated });
  assert.match(lastText(h, noUnclaim), /Only the person who claimed/);
  await h.clickButton('Unclaim', { user: IDS.mod, in: updated });
  assert.equal(ticketOf(h, IDS.member).claimedBy, null);
  const back = h.fake.messagesIn(t.channelId).find((m) => m.id === cardMsg.id);
  assert.ok(h.allButtons(back).some((b) => b.label === 'Claim'));
});

test('add and remove people changes the ticket role, with an undo', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const added = await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  assert.ok(hasRole(h, IDS.member2, t.roleId), 'riley can see it');
  assert.match(lastText(h, added), /Added to the ticket/);
  assert.deepEqual(ticketOf(h, IDS.member).members, [IDS.member2]);

  const outsider = await h.slash('ticket', 'remove riley', { user: IDS.member2, channel: t.channelId });
  assert.match(lastText(h, outsider), /Only staff or the person who opened/);
  const removed = await h.slash('ticket', 'remove riley', { user: IDS.mod, channel: t.channelId });
  assert.ok(!hasRole(h, IDS.member2, t.roleId), 'riley removed');
  const notMine = await h.clickButton('Undo', { user: IDS.member2, in: removed, channel: t.channelId });
  assert.match(lastText(h, notMine), /Not your panel/);
  const undoBtn = h.findButton('Undo', removed);
  const forged = await h.click(undoBtn.custom_id, { user: IDS.member2, channel: t.channelId });
  assert.match(lastText(h, forged), /Only staff or the person who opened/);
  assert.ok(!hasRole(h, IDS.member2, t.roleId), 'still removed');
  await h.clickButton('Undo', { user: IDS.mod, in: removed, channel: t.channelId });
  assert.ok(hasRole(h, IDS.member2, t.roleId), 'undo added riley back');

  const opener = await h.slash('ticket', 'remove sam', { user: IDS.mod, channel: t.channelId });
  assert.match(lastText(h, opener), /opened this ticket/);
});

test('Add person button opens a form and adds them', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const ans = await h.clickButton('Add person', { user: IDS.member, in: h.sent(t.channelId)[0] });
  assert.equal(ans[0].type, 'modal');
  await h.submit(ans[0].modal.custom_id, { who: 'riley' }, { user: IDS.member, channel: t.channelId });
  assert.ok(hasRole(h, IDS.member2, t.roleId));
});

test('close by the opener: transcript file in the log, then channel and role are deleted', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'printer on fire');
  await h.message('hello, my printer is on fire', { user: IDS.member, channel: t.channelId });
  await h.message('try turning it off and on', { user: IDS.mod, channel: t.channelId });
  const mid = await closeWithTimers(h, t, { user: IDS.member, reason: 'fixed it' });
  assert.equal(mid.channel, true, 'channel kept during the 10 second delay');
  assert.equal(mid.role, true);

  const logMsg = h.sent(LOG).find((m) => m.files?.length);
  assert.ok(logMsg, 'transcript posted to the log');
  const file = logMsg.files[0];
  assert.equal(file.name, 'ticket-0001-transcript.txt');
  assert.deepEqual([...file.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a UTF-8 byte order mark');
  assert.match(file.bytes.toString('utf8'), /^\uFEFFTicket #0001 \(Support\)/);
  assert.match(file.text, /\[2026-11-07 12:00\] Sam: hello, my printer is on fire/);
  assert.match(file.text, /\] Mo: try turning it off and on/);
  assert.match(file.text, /\] YapOS: @Sam \[card: 🎫 Ticket #0001: Support\]/);
  assert.doesNotMatch(file.text, /<@|<#/);
  assert.match(file.text, /Reason: fixed it/);
  assert.match(h.textOf(logMsg), /Ticket #0001 closed/);
  assert.match(h.textOf(logMsg), /Sent a copy/);

  const dmChannel = `d${IDS.member.slice(1)}`;
  assert.ok((h.fake.state.messages[dmChannel] || []).some((m) => m.files?.length), 'opener got a DM copy');
  assert.equal(channel(h, t.channelId), null, 'channel deleted after the delay');
  assert.equal(roleExists(h, t.roleId), false, 'ticket role deleted');
  const done = ticketOf(h, IDS.member);
  assert.equal(done.status, 'closed');
  assert.equal(done.closedBy, IDS.member);
  assert.equal(done.reason, 'fixed it');
  assert.ok(done.closedAt);
  assert.equal(done.cleanup, null);
});

test('close needs staff or the opener, and Keep it open cancels', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const nope = await h.slash('ticket', 'close', { user: IDS.member2, channel: t.channelId });
  assert.match(lastText(h, nope), /Only staff or the person who opened/);
  const ask = await h.slash('ticket', 'close', { user: IDS.member, channel: t.channelId });
  const stranger = await h.clickButton('Close ticket', { user: IDS.member2, in: ask, channel: t.channelId });
  assert.match(lastText(h, stranger), /Not your panel/);
  const yes = h.findButton('Close ticket', ask);
  const no = h.findButton('Keep it open', ask);
  for (const b of [yes, no]) {
    const forged = await h.click(b.custom_id, { user: IDS.member2, channel: t.channelId });
    assert.match(lastText(h, forged), /Only staff or the person who opened/);
    const borrowed = await h.click(b.custom_id, { user: IDS.mod, channel: t.channelId });
    assert.match(lastText(h, borrowed), /Not your panel/);
  }
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  await h.clickButton('Keep it open', { user: IDS.member, in: ask, channel: t.channelId });
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  assert.ok(channel(h, t.channelId));
});

test('with files off the transcript is posted as text chunks', async () => {
  const h = await make({ features: { files: false } });
  const { t } = await openTicketFor(h, IDS.member, 'long story');
  for (let i = 0; i < 3; i++) await h.message(`line ${i} ${'x'.repeat(900)}`, { user: IDS.member, channel: t.channelId });
  await closeWithTimers(h, t, { user: IDS.mod, reason: 'done' });
  const chunks = h.sent(LOG).filter((m) => m.content.startsWith('```'));
  assert.ok(chunks.length >= 2, 'split into several parts');
  for (const c of chunks) assert.ok(c.content.length <= 2000);
  assert.match(chunks.map((c) => c.content).join('\n'), /Sam: line 0/);
  assert.ok(h.sent(LOG).some((m) => /Ticket #0001 closed/.test(h.textOf(m))), 'summary posted');
  assert.equal(h.engine.caps.state(S, 'files'), false);
  assert.equal(channel(h, t.channelId), null);
});

test('very long transcripts stop after 10 parts', async () => {
  const h = await make({ features: { files: false } });
  const { t } = await openTicketFor(h, IDS.member, 'long');
  for (let i = 0; i < 14; i++) h.fake.addUserMessage(t.channelId, IDS.member, `${i} ${'y'.repeat(1800)}`);
  await closeWithTimers(h, t, { user: IDS.mod });
  const chunks = h.sent(LOG).filter((m) => m.content.startsWith('```'));
  assert.equal(chunks.length, 10);
  assert.ok(h.sent(LOG).some((m) => /truncated/.test(m.content)));
});

test('DMs off is fine but noted in the log', async () => {
  const h = await make({ features: { dms: false } });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await closeWithTimers(h, t, { user: IDS.member });
  const logMsg = h.sent(LOG).find((m) => m.files?.length);
  assert.match(h.textOf(logMsg), /Couldn't DM a copy/);
  assert.equal(ticketOf(h, IDS.member).status, 'closed');
});

test('roles API off: staff-only channel and clear messages everywhere', async () => {
  const h = await make({ features: { roles: false } });
  const rolesBefore = h.fake.state.roles[S].length;
  const ans = await h.slash('ticket', 'my account is locked', { user: IDS.member });
  assert.equal(h.fake.state.roles[S].length, rolesBefore, 'no role made');
  const t = ticketOf(h, IDS.member);
  assert.equal(t.mode, 'staff');
  assert.equal(t.roleId, null);
  const ch = channel(h, t.channelId);
  assert.equal(ch.private, true);
  assert.ok(ch.role_ids.includes(R.bot) && ch.role_ids.includes(R.mod));
  const text = allTexts(h, ans);
  assert.match(text, /role management/i);
  assert.match(text, /contact you/);
  assert.match(h.textOf(h.sent(t.channelId)[0]), /can't see this channel/);
  assert.ok(!h.findButton('Add person', h.sent(t.channelId)[0]), 'no add button without roles');
  const logNote = h.sent(LOG).find((m) => /needs a staff member/.test(h.textOf(m)));
  assert.ok(logNote, 'staff told in the log');
  assert.match(h.textOf(logNote), /my account is locked/);
  assert.equal(h.engine.caps.state(S, 'roles'), false);

  const add = await h.slash('ticket', 'add riley', { user: IDS.mod, channel: t.channelId });
  assert.match(lastText(h, add), /Role management isn't switched on/);
  const setupPanel = await h.slash('tickets', '', { user: IDS.admin });
  assert.match(lastText(h, setupPanel), /Role management is off/);
  assert.match(lastText(h, setupPanel), /🔴 Role management/);
});

test('a failure midway cleans up the role and channel', async () => {
  const h = await make();
  h.fake.fail('PATCH', /^\/channels\//, { status: 403, error: 'Missing permission' });
  const rolesBefore = h.fake.state.roles[S].length;
  const channelsBefore = h.fake.state.channels[S].length;
  const ans = await h.slash('ticket', 'help', { user: IDS.member });
  assert.equal(h.fake.state.roles[S].length, rolesBefore, 'role removed again');
  assert.equal(h.fake.state.channels[S].length, channelsBefore, 'channel removed again');
  assert.ok(!h.fake.memberOf(S, IDS.member).roles.some((r) => !Object.values(R).includes(r)));
  const text = lastText(h, ans);
  assert.match(text, /private/);
  assert.match(text, /removed anything/);
  assert.doesNotMatch(text, /403/);
  h.fake.clearFailures();
  await h.slash('ticket', 'help', { user: IDS.member });
  assert.equal(ticketOf(h, IDS.member).status, 'open', 'works once fixed');
});

test('rename by staff cleans the name; members cannot', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const nope = await h.slash('ticket', 'rename mine', { user: IDS.member, channel: t.channelId });
  assert.match(lastText(h, nope), /Only staff/);
  const ok = await h.slash('ticket', 'rename Billing Question!!', { user: IDS.mod, channel: t.channelId });
  assert.equal(channel(h, t.channelId).name, 'billing-question');
  await h.clickButton('Undo', { user: IDS.mod, in: ok, channel: t.channelId });
  assert.equal(channel(h, t.channelId).name, 'ticket-0001-sam');
  await h.slash('ticket', `rename ${'a'.repeat(50)}`, { user: IDS.mod, channel: t.channelId });
  assert.equal(channel(h, t.channelId).name.length, 32);
});

test('ticket commands outside a ticket channel say so plainly', async () => {
  const h = await make();
  for (const sub of ['claim', 'close', 'add @riley', 'rename x', 'transcript']) {
    const ans = await h.slash('ticket', sub, { user: IDS.mod });
    assert.match(lastText(h, ans), /This isn't a ticket channel/, sub);
  }
});

test('transcript command posts the conversation so far', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.message('first words', { user: IDS.member, channel: t.channelId });
  await h.slash('ticket', 'transcript', { user: IDS.member, channel: t.channelId });
  const m = h.sent(t.channelId).find((x) => x.files?.length);
  assert.match(m.files[0].text, /Sam: first words/);
});

test('admin setup is refused for members, including old panel buttons', async () => {
  const h = await make();
  const refused = await h.slash('tickets', '', { user: IDS.member });
  assert.match(lastText(h, refused), /Only admins/);
  const panel = await h.slash('tickets', '', { user: IDS.admin });
  assert.match(lastText(h, panel), /Ticket setup/);
  const labels = ['Post panel', 'Edit types', 'Staff roles', 'Log channel', 'Category', 'Limit', 'Ping staff', 'Tidy up', 'Refresh'];
  for (const label of labels) {
    for (const user of [IDS.member, IDS.mod]) {
      const onPanel = await h.clickButton(label, { user, in: panel });
      assert.match(lastText(h, onPanel), /Not your panel/, label);
      const forged = await h.click(h.findButton(label, panel).custom_id, { user });
      assert.match(lastText(h, forged), /Only admins/, label);
    }
  }
  for (const action of ['panelhere', 'savetypes', 'savestaff', 'savelog', 'savecategory', 'savelimit']) {
    const forged = await h.click(customId('tickets', action), { user: IDS.member });
    assert.match(lastText(h, forged), /Only admins/, action);
  }
  const forgedTo = await h.click(customId('tickets', 'panelto', G), { user: IDS.member });
  assert.match(lastText(h, forgedTo), /Only admins/);
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.equal(cfg.pingStaff, false);
  assert.equal(cfg.panelChannelId, null);
  assert.equal(cfg.limit, 1);
});

test('admin settings: staff, log, limit, category, types and the panel picker', async () => {
  const h = await make({ config: null });
  await h.slash('tickets', 'staff @Moderator', { user: IDS.admin });
  assert.deepEqual(h.engine.settings.appConfig(S, 'tickets').staffRoles, [R.mod]);
  await h.slash('tickets', `log <#${LOG}>`, { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'tickets').logChannelId, LOG);
  const bad = await h.slash('tickets', 'limit 99', { user: IDS.admin });
  assert.match(lastText(h, bad), /1 to 10/);
  await h.slash('tickets', 'limit 2', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'tickets').limit, 2);
  const cat = await h.slash('tickets', 'category Support', { user: IDS.admin });
  assert.match(lastText(h, cat), /no channel categories/);
  await h.slash('tickets', 'ping on', { user: IDS.admin });

  const form = await h.slash('tickets', 'types', { user: IDS.admin });
  assert.equal(form[0].type, 'modal');
  await h.submit(form[0].modal.custom_id, { t1: '🎫 Support', t2: '⚖️ Appeal: What happened?; Why change it?', t3: '', t4: '', t5: '' }, { user: IDS.admin });
  const types = h.engine.settings.appConfig(S, 'tickets').types;
  assert.deepEqual(types.map((t) => t.name), ['Support', 'Appeal']);
  assert.equal(types[1].emoji, '⚖️');
  assert.deepEqual(types[1].questions, ['What happened?', 'Why change it?']);
  const memberSubmit = await h.submit(form[0].modal.custom_id, { t1: 'Hacked' }, { user: IDS.member });
  assert.match(lastText(h, memberSubmit), /Only admins/);

  const picker = await h.slash('tickets', 'panel', { user: IDS.admin });
  const sel = h.allButtons(picker).find((b) => b.isSelect);
  assert.ok(sel, 'channel select shown');
  await h.pick(sel.custom_id, [IDS.channels.roles], { user: IDS.admin });
  const posted = h.lastSent(IDS.channels.roles);
  assert.ok(h.findButton('Support', posted) && h.findButton('Appeal', posted), 'panel has one button per type');

  const { t } = await openTicketFor(h, IDS.member, 'support help');
  assert.ok(h.sent(t.channelId)[0].content.includes(`<@&${R.mod}>`), 'staff role pinged');
  assert.deepEqual(channel(h, t.channelId).role_ids.sort(), [t.roleId, R.mod, R.bot].sort());
});

test('panel picker falls back to buttons when selects are off', async () => {
  const h = await make({ features: { selects: false } });
  const picker = await h.slash('tickets', 'panel', { user: IDS.admin });
  assert.ok(!h.allButtons(picker).some((b) => b.isSelect));
  await h.clickButton('#announcements', { user: IDS.admin, in: picker });
  assert.ok(h.findButton('Open a ticket', h.lastSent(IDS.channels.news)));
});

test('close works when the channel was deleted by hand', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  const ask = await h.slash('ticket', 'close 1 channel vanished', { user: IDS.mod });
  const ans = await h.clickButton('Close ticket', { user: IDS.mod, in: ask });
  assert.match(lastText(h, ans), /cleaned up the role/);
  const done = ticketOf(h, IDS.member);
  assert.equal(done.status, 'closed');
  assert.equal(done.reason, 'channel vanished');
  assert.equal(roleExists(h, t.roleId), false);
  assert.ok(h.sent(LOG).some((m) => /already deleted/.test(h.textOf(m))));
  const member = await h.slash('ticket', 'close 1', { user: IDS.member });
  assert.match(lastText(h, member), /This isn't a ticket channel/);
});

test('a ticket whose channel vanished does not block a new one', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  await h.slash('ticket', 'again', { user: IDS.member });
  const all = tickets(h);
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.number === 1).status, 'closed');
  assert.equal(roleExists(h, t.roleId), false);
  assert.equal(all.find((x) => x.number === 2).status, 'open');
});

test('tidy up closes tickets that lost their channel', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await openTicketFor(h, IDS.member2, 'other');
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  const panel = await h.slash('tickets', '', { user: IDS.admin });
  const ans = await h.clickButton('Tidy up', { user: IDS.admin, in: panel });
  assert.match(lastText(h, ans), /1 ticket/);
  assert.equal(ticketOf(h, IDS.member).status, 'closed');
  assert.equal(ticketOf(h, IDS.member2).status, 'open');
});

test('menu panel: admins get setup, members get an open prompt; yap words route', async () => {
  const h = await make();
  const admin = await h.click(customId('system', 'open', 'tickets'), { user: IDS.admin });
  assert.match(lastText(h, admin), /Ticket setup/);
  const member = await h.click(customId('system', 'open', 'tickets'), { user: IDS.member });
  assert.match(lastText(h, member), /Open a ticket/);
  const other = await h.clickButton('Open a ticket', { user: IDS.member2, in: member });
  assert.match(lastText(h, other), /Not your panel/);
  assert.equal(ticketOf(h, IDS.member2), null);
  await h.slash('yap', 'support my stuff broke', { user: IDS.member });
  assert.equal(ticketOf(h, IDS.member)?.topic, 'my stuff broke');
  const modMenu = await h.click(customId('system', 'open', 'tickets'), { user: IDS.mod });
  assert.doesNotMatch(lastText(h, modMenu), /Ticket setup/);
  const yapAdmin = await h.slash('yap', 'tickets', { user: IDS.admin });
  assert.match(lastText(h, yapAdmin), /Ticket setup/);
});

test('presets set types and the log channel without posting anything', async () => {
  const h = await createHarness({ apps: ['tickets'] });
  const app = h.engine.apps.get('tickets');
  const sentBefore = h.sent().length;
  const line = await app.def.applyPreset(h.engine, S, { preset: 'community', channels: { logs: { id: LOG, name: 'mod-log' } } });
  assert.equal(typeof line, 'string');
  assert.ok(!line.includes('\n'));
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.equal(cfg.logChannelId, LOG);
  assert.deepEqual(cfg.types.map((t) => t.name), ['Support', 'Report']);
  assert.equal(h.sent().length, sentBefore);
  assert.equal(app.def.presets.friends.enabled, false);
  assert.deepEqual(app.def.presets.study.config.types.map((t) => t.name), ['Question']);
  assert.deepEqual(app.def.presets.roleplay.config.types.map((t) => t.name), ['Support', 'Character approval']);
  assert.deepEqual(app.def.presets.gaming.config.types.map((t) => t.name), ['Support', 'Appeal']);
});

test('a passing lookup error never closes a ticket that is still there', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.fake.fail('GET', new RegExp(`^/channels/${t.channelId}$`), { status: 503, error: 'busy' });
  const again = await h.slash('ticket', 'second', { user: IDS.member });
  assert.match(allTexts(h, again), /already have a ticket open/);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  assert.equal(tickets(h).length, 1);
  assert.ok(roleExists(h, t.roleId), 'ticket role kept');
  assert.ok(hasRole(h, IDS.member, t.roleId));
  h.fake.clearFailures();
  const panel = await h.slash('tickets', '', { user: IDS.admin });
  h.fake.fail('GET', new RegExp(`^/channels/${t.channelId}$`), { status: 503, error: 'busy' });
  const tidy = await h.clickButton('Tidy up', { user: IDS.admin, in: panel });
  assert.match(lastText(h, tidy), /still have their channels/);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
});

test('a click is answered before a vanished ticket is cleaned up', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  const before = h.fake.calls.length;
  await h.click(customId('tickets', 'open', 'support'), { user: IDS.member });
  const calls = h.fake.calls.slice(before);
  const firstAnswer = calls.findIndex((c) => /\/callback$/.test(c.path));
  const roleDelete = calls.findIndex((c) => c.method === 'DELETE' && new RegExp(`/roles/${t.roleId}$`).test(c.path));
  assert.ok(firstAnswer >= 0 && roleDelete > firstAnswer, 'answered before the old ticket is cleaned up');
  assert.equal(tickets(h).find((x) => x.number === 1).status, 'closed');
  assert.equal(tickets(h).find((x) => x.number === 2).status, 'open');
});

test('two staff pressing Claim at once leaves exactly one claimer', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const cardMsg = h.sent(t.channelId)[0];
  const [a, b] = await Promise.all([
    h.clickButton('Claim', { user: IDS.mod, in: cardMsg }),
    h.clickButton('Claim', { user: IDS.admin, in: cardMsg }),
  ]);
  const claimer = ticketOf(h, IDS.member).claimedBy;
  assert.ok([IDS.mod, IDS.admin].includes(claimer));
  const loser = claimer === IDS.mod ? b : a;
  assert.match(allTexts(h, loser), /Already claimed/);
  const notes = h.sent(t.channelId).filter((m) => /claimed this ticket/.test(m.content));
  assert.equal(notes.length, 1, 'one claim note');
});

test('the transcript command has a short cooldown', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.slash('ticket', 'transcript', { user: IDS.member, channel: t.channelId });
  const again = await h.slash('ticket', 'transcript', { user: IDS.member, channel: t.channelId });
  assert.match(lastText(h, again), /Just made one/);
  assert.equal(h.sent(t.channelId).filter((m) => m.files?.length).length, 1);
});

test('a close cut short by a restart can be closed again', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.store.update('tickets', S, (d) => { d.tickets[t.number].status = 'closing'; return d; });
  const inside = await h.slash('ticket', 'claim', { user: IDS.mod, channel: t.channelId });
  assert.match(lastText(h, inside), /This ticket is closed/);
  h.engine.apps.get('tickets').def.init(h.engine);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  const ask = await h.slash('ticket', 'close', { user: IDS.member, channel: t.channelId });
  assert.ok(h.findButton('Close ticket', ask));
});

test('tidy up answers first, then reports', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  const ans = await h.slash('tickets', 'tidy', { user: IDS.admin });
  assert.match(h.textOf(ans[0]), /Tidying up/);
  assert.match(lastText(h, ans), /1 ticket had lost its channel/);
});

test('roles API off: a second ticket is refused without a link the member cannot open', async () => {
  const h = await make({ features: { roles: false } });
  const { t } = await openTicketFor(h, IDS.member, 'locked out');
  const again = await h.slash('ticket', 'still locked out', { user: IDS.member });
  const text = allTexts(h, again);
  assert.match(text, /still handling your earlier ticket/);
  assert.doesNotMatch(text, new RegExp(`<#${t.channelId}>`));
});

test('the posted panel and the ticket card are open to everyone who should use them', async () => {
  const h = await make();
  await h.slash('tickets', `panel <#${G}>`, { user: IDS.admin });
  const panelMsg = h.lastSent(G);
  await h.clickButton('Open a ticket', { user: IDS.member, in: panelMsg });
  await h.clickButton('Open a ticket', { user: IDS.member2, in: panelMsg });
  assert.equal(ticketOf(h, IDS.member)?.status, 'open');
  assert.equal(ticketOf(h, IDS.member2)?.status, 'open');
  assert.notEqual(ticketOf(h, IDS.member).channelId, ticketOf(h, IDS.member2).channelId);

  const t = ticketOf(h, IDS.member);
  const cardMsg = h.sent(t.channelId)[0];
  await h.clickButton('Claim', { user: IDS.mod, in: cardMsg, channel: t.channelId });
  assert.equal(ticketOf(h, IDS.member).claimedBy, IDS.mod);
  const ask = await h.clickButton('Close', { user: IDS.member, in: cardMsg, channel: t.channelId });
  assert.ok(h.findButton('Close ticket', ask), 'the opener gets a confirmation after staff used the card');
  const staffAsk = await h.clickButton('Close', { user: IDS.admin, in: cardMsg, channel: t.channelId });
  assert.ok(h.findButton('Close ticket', staffAsk), 'staff get their own confirmation');
});

test('ticket card buttons only do what the presser may do', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const cardMsg = h.sent(t.channelId)[0];
  await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  const outsider = { user: IDS.member2, in: cardMsg, channel: t.channelId };
  assert.match(lastText(h, await h.clickButton('Claim', outsider)), /Only staff/);
  assert.match(lastText(h, await h.clickButton('Close', outsider)), /Only staff or the person who opened/);
  assert.match(lastText(h, await h.clickButton('Add person', outsider)), /Only staff or the person who opened/);
  const forgedAdd = await h.submit(customId('tickets', 'addsave'), { who: 'morgan' }, { user: IDS.member2, channel: t.channelId });
  assert.match(lastText(h, forgedAdd), /Only staff or the person who opened/);
  for (const action of ['claim', 'close', 'addp']) {
    const forged = await h.click(customId('tickets', action, t.number), { user: IDS.member2 });
    assert.match(lastText(h, forged), /Only staff/, action);
  }
  const readd = await h.click(customId('tickets', 'readd', t.number, IDS.owner), { user: IDS.member2 });
  assert.match(lastText(h, readd), /Only staff or the person who opened/);
  const unclaimEarly = await h.click(customId('tickets', 'unclaim', t.number), { user: IDS.member2 });
  assert.match(lastText(h, unclaimEarly), /Only the person who claimed/);

  await h.clickButton('Claim', { user: IDS.mod, in: cardMsg, channel: t.channelId });
  for (const user of [IDS.member, IDS.member2]) {
    const forged = await h.click(customId('tickets', 'unclaim', t.number), { user, channel: t.channelId });
    assert.match(lastText(h, forged), /Only the person who claimed/);
  }
  const open = ticketOf(h, IDS.member);
  assert.equal(open.status, 'open');
  assert.equal(open.claimedBy, IDS.mod);
  assert.deepEqual(open.members, [IDS.member2]);
});

test('rename undo is locked to the staff member and staff only when forged', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const ok = await h.slash('ticket', 'rename billing', { user: IDS.mod, channel: t.channelId });
  const onPanel = await h.clickButton('Undo', { user: IDS.member, in: ok, channel: t.channelId });
  assert.match(lastText(h, onPanel), /Not your panel/);
  const forged = await h.click(h.findButton('Undo', ok).custom_id, { user: IDS.member, channel: t.channelId });
  assert.match(lastText(h, forged), /Only staff/);
  assert.equal(channel(h, t.channelId).name, 'billing');
});

test('the type picker belongs to the person who asked for it', async () => {
  const h = await make({ features: { selects: false }, config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const ans = await h.slash('ticket', 'my secret topic', { user: IDS.member });
  const other = await h.clickButton('Support', { user: IDS.member2, in: ans });
  assert.match(lastText(h, other), /Not your panel/);
  assert.equal(ticketOf(h, IDS.member2), null);
  await h.click(h.findButton('Support', ans).custom_id, { user: IDS.member2 });
  assert.equal(ticketOf(h, IDS.member2)?.topic, '', 'a copied button never carries the topic of someone else');
});

test('settings handlers refuse non-admins even when called without the router', async () => {
  const h = await make();
  const run = (action, user, values) => h.engine.router.handlers.get(`tickets:${action}`).run(
    h.engine.contextFor({ id: 'm-direct', server_id: S, channel_id: G, user_id: user, username: 'x', content: '' }, { app: 'tickets', kind: 'modal_submit', args: [], values }),
  );
  for (const user of [IDS.member, IDS.mod]) {
    await run('savelimit', user, { value: '7' });
    await run('savestaff', user, { value: 'Member' });
    await run('savelog', user, { value: 'general' });
    await run('savetypes', user, { t1: 'Hacked' });
    await run('ping', user, null);
    await run('panelhere', user, null);
    await run('tidy', user, null);
    await run('edit', user, null);
  }
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.equal(cfg.limit, 1);
  assert.deepEqual(cfg.staffRoles, []);
  assert.equal(cfg.logChannelId, LOG);
  assert.deepEqual(cfg.types.map((x) => x.name), ['Support']);
  assert.equal(cfg.pingStaff, false);
  assert.equal(cfg.panelChannelId, null);
  assert.ok(h.sent(G).some((m) => /Only admins/.test(h.textOf(m))));
  await run('savelimit', IDS.admin, { value: '3' });
  assert.equal(h.engine.settings.appConfig(S, 'tickets').limit, 3);
});

const B = '5e000000-0000-4000-8000-0000000000b2';
const LOBBY = 'c0000000-0000-4000-8000-0000000000b1';
const BOSS = 'f0000000-0000-4000-8000-0000000000b9';
const BOT_B = 'f0000000-0000-4000-8000-0000000000b6';

function addSecondServer(h) {
  const st = h.fake.state;
  st.servers[B] = { id: B, name: 'Elsewhere', icon_path: null, owner_id: IDS.member, member_count: 2, online_count: 1 };
  st.roles[B] = [
    { id: BOSS, name: 'Boss', color: null, position: 9, perms: { administrator: true }, auto: null, mentionable: false },
    { id: BOT_B, name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, manage_channels: true, send_messages: true, read_history: true }, auto: null, mentionable: false },
  ];
  st.members[B] = [
    { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [BOSS], joined_at: '2026-01-05T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [BOT_B], joined_at: '2026-01-02T00:00:00Z' },
  ];
  st.channels[B] = [{ id: LOBBY, name: 'lobby', type: 'text', kind: 'text', server_id: B, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  st.bans[B] = [];
  st.everyone[B] = { send_messages: true, view_channel: true };
}

const ADMIN_ACTIONS = ['home', 'postpanel', 'panelhere', 'types', 'ping', 'tidy', 'savetypes', 'savestaff', 'savelog', 'savecategory', 'savelimit'];
const HOSTILE = { value: '9', t1: 'Hacked', who: 'sam' };
const isForm = (action) => /^(save|answers|addsave)/.test(action);
const formOpts = (action) => (isForm(action) ? { type: 'modal_submit', values: HOSTILE } : {});

function assertSetupUntouched(h, server = S) {
  const cfg = h.engine.settings.appConfig(server, 'tickets');
  assert.equal(cfg.limit, 1);
  assert.deepEqual(cfg.staffRoles, []);
  assert.equal(cfg.pingStaff, false);
  assert.equal(cfg.panelChannelId, null);
  assert.equal(cfg.categoryId, null);
  assert.deepEqual(cfg.types.map((x) => x.name), ['Support']);
}

async function ownPanel(h, t, user = IDS.member) {
  const ask = await h.slash('ticket', 'close', { user, channel: t.channelId });
  const btn = h.findButton('Close ticket', ask);
  assert.equal(h.engine.router.panelOwner(btn.messageId), user, 'the presser really owns this panel');
  return btn.messageId;
}

test('holding a panel of your own does not unlock staff or admin buttons', async () => {
  const h = await make();
  const { t: mine } = await openTicketFor(h, IDS.member, 'mine');
  const { t: theirs } = await openTicketFor(h, IDS.member2, 'private matter');
  const mid = await ownPanel(h, mine);
  const press = (id, extra = {}) => h.click(id, { user: IDS.member, channel: mine.channelId, messageId: mid, ...extra });

  for (const action of ADMIN_ACTIONS) {
    const ans = await press(customId('tickets', action), formOpts(action));
    assert.match(lastText(h, ans), /Only admins/, action);
    assert.ok(!ans.some((a) => a.type === 'modal'), `${action} shows no form`);
  }
  for (const what of ['staff', 'log', 'category', 'limit', 'constructor', '__proto__']) {
    const ans = await press(customId('tickets', 'edit', what));
    assert.match(lastText(h, ans), /Only admins/, what);
    assert.ok(!ans.some((a) => a.type === 'modal'));
  }
  assert.match(lastText(h, await press(customId('tickets', 'panelto', G))), /Only admins/);
  assert.match(lastText(h, await press(customId('tickets', 'panelpick'), { type: 'select', values: [G] })), /Only admins/);
  assertSetupUntouched(h);
  assert.equal(h.sent(G).filter((m) => /Need help/.test(h.textOf(m))).length, 0, 'no panel was posted');

  for (const num of [mine.number, theirs.number]) {
    assert.match(lastText(h, await press(customId('tickets', 'claim', num))), /Only staff/);
    assert.match(lastText(h, await press(customId('tickets', 'unrename', num, 'pwned'))), /Only staff/);
    assert.match(lastText(h, await press(customId('tickets', 'unclaim', num))), /Only the person who claimed/);
  }
  assert.match(lastText(h, await press(customId('tickets', 'close', theirs.number))), /Only staff or the person who opened/);
  assert.match(lastText(h, await press(customId('tickets', 'addp', theirs.number))), /Only staff or the person who opened/);
  assert.match(lastText(h, await press(customId('tickets', 'readd', theirs.number, IDS.member))), /Only staff or the person who opened/);
  const sneak = await h.submit(customId('tickets', 'addsave'), { who: 'sam' }, { user: IDS.member, channel: theirs.channelId, messageId: mid });
  assert.match(lastText(h, sneak), /Only staff or the person who opened/);
  await h.message(`!ticket add <@${IDS.member}>`, { user: IDS.member, channel: theirs.channelId });
  await h.message('!ticket transcript', { user: IDS.member, channel: theirs.channelId });
  await h.message('!ticket close', { user: IDS.member, channel: theirs.channelId });

  assert.ok(!hasRole(h, IDS.member, theirs.roleId), 'no way into the other ticket');
  const victim = ticketOf(h, IDS.member2);
  assert.equal(victim.status, 'open');
  assert.equal(victim.claimedBy, null);
  assert.deepEqual(victim.members, []);
  assert.equal(channel(h, theirs.channelId).name, 'ticket-0002-riley');
  assert.equal(channel(h, mine.channelId).name, 'ticket-0001-sam');
  assert.ok(!h.sent(theirs.channelId).some((m) => m.files?.length || h.findButton('Close ticket', m)), 'no transcript and no close prompt for the intruder');
});

test('typed chat commands get the same refusals as the slash menu', async () => {
  const h = await make({ features: { selects: false }, config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const { t } = await openTicketFor(h, IDS.member2, 'support help');
  for (const text of ['!tickets', '!tickets limit 9', '!tickets staff @Member', '!tickets panel here', '!tickets ping on', '!tickets tidy']) {
    for (const user of [IDS.member, IDS.mod]) {
      await h.message(text, { user });
      assert.match(h.textOf(h.lastSent(G)), /Only admins/, text);
    }
  }
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.equal(cfg.limit, 1);
  assert.deepEqual(cfg.staffRoles, []);
  assert.equal(cfg.pingStaff, false);
  assert.equal(cfg.panelChannelId, null);

  await h.message('!ticket close 1', { user: IDS.member });
  assert.match(h.textOf(h.lastSent(G)), /This isn't a ticket channel/);
  for (const text of ['!ticket claim', '!ticket rename pwned']) {
    for (const user of [IDS.member, IDS.member2]) {
      await h.message(text, { user, channel: t.channelId });
      assert.match(h.textOf(h.lastSent(t.channelId)), /Only staff/, text);
    }
  }
  for (const text of ['!ticket close', '!ticket remove riley', '!ticket add morgan', '!ticket transcript']) {
    await h.message(text, { user: IDS.member, channel: t.channelId });
    assert.match(h.textOf(h.lastSent(t.channelId)), /Only staff or the person who opened/, text);
  }
  const still = ticketOf(h, IDS.member2);
  assert.equal(still.status, 'open');
  assert.equal(still.claimedBy, null);
  assert.deepEqual(still.members, []);
  assert.equal(channel(h, t.channelId).name, 'ticket-0001-riley');

  await h.message('!ticket my private topic', { user: IDS.mod });
  const picker = h.lastSent(G);
  assert.ok(h.findButton('Support', picker), 'typed command shows the picker');
  const other = await h.clickButton('Support', { user: IDS.member, in: picker });
  assert.match(lastText(h, other), /Not your panel/);
  assert.equal(ticketOf(h, IDS.member), null);
});

test('yap words and the home tile give a member nothing the commands refuse', async () => {
  const h = await make();
  for (const text of ['tickets limit 9', 'tickets staff @Member', 'tickets panel here', 'tickets ping on', 'tickets constructor']) {
    await h.slash('yap', text, { user: IDS.member });
    await h.slash('yap', text, { user: IDS.mod });
  }
  assertSetupUntouched(h);
  assert.equal(h.sent(G).filter((m) => /Need help/.test(h.textOf(m))).length, 0);
  const menu = await h.slash('menu', '', { user: IDS.member });
  const mid = menu.find((a) => a.message)?.message.id;
  assert.ok(mid, 'the member has a home screen of their own');
  const tile = await h.click(customId('system', 'open', 'tickets'), { user: IDS.member, messageId: mid });
  assert.doesNotMatch(allTexts(h, tile), /Ticket setup/);
  assert.ok(!h.findButton('Post panel', tile));
  const yapMenu = await h.slash('yap', 'tickets', { user: IDS.mod });
  assert.doesNotMatch(allTexts(h, yapMenu), /Ticket setup/);
});

test('words like constructor are just a topic, never a hidden subcommand', async () => {
  const h = await make();
  const ans = await h.slash('ticket', 'constructor', { user: IDS.member });
  assert.match(lastText(h, ans), /Your ticket is open/);
  assert.equal(ticketOf(h, IDS.member).topic, 'constructor');
  const admin = await h.slash('tickets', 'constructor', { user: IDS.admin });
  assert.match(lastText(h, admin), /I didn't get that/);
});

test('being the owner of another server gives nothing here', async () => {
  const h = await make();
  addSecondServer(h);
  const there = { user: IDS.member, server: B, channel: LOBBY };
  const { t: victim } = await openTicketFor(h, IDS.member2, 'private matter');

  await h.slash('tickets', `log <#${LOG}>`, there);
  assert.equal(h.engine.settings.appConfig(B, 'tickets').logChannelId, null, 'a channel of another server is not accepted');
  await h.slash('tickets', `panel <#${G}>`, there);
  await h.click(customId('tickets', 'panelto', G), there);
  await h.pick(customId('tickets', 'panelpick'), [G], there);
  await h.click(customId('tickets', 'panelhere'), { ...there, channel: G });
  await h.slash('tickets', 'panel here', { ...there, channel: G });
  assert.equal(h.sent(G).filter((m) => /Need help/.test(h.textOf(m))).length, 0, 'no panel lands in the other server');
  assert.equal(h.engine.settings.appConfig(B, 'tickets').panelChannelId, null);
  await h.slash('tickets', `staff <@&${R.mod}>`, there);
  assert.deepEqual(h.engine.settings.appConfig(B, 'tickets').staffRoles, []);
  await h.slash('tickets', 'limit 5', there);
  assert.equal(h.engine.settings.appConfig(B, 'tickets').limit, 5);
  await h.slash('tickets', 'panel here', there);
  assert.equal(h.engine.settings.appConfig(B, 'tickets').panelChannelId, LOBBY, 'posting in their own server still works');
  assertSetupUntouched(h);

  for (const action of ADMIN_ACTIONS) {
    const ans = await h.click(customId('tickets', action), { user: IDS.member, ...formOpts(action) });
    assert.match(lastText(h, ans), /Only admins/, action);
  }
  assertSetupUntouched(h);

  await h.slash('ticket', 'mine over there', there);
  const mine = Object.values(h.store.get('tickets', B, { tickets: {} }).tickets)[0];
  assert.equal(mine.number, victim.number, 'same ticket number in both servers');
  const ask = await h.slash('ticket', 'close', { ...there, channel: mine.channelId });
  const yes = h.findButton('Close ticket', ask);
  const replay = await h.click(yes.custom_id, { user: IDS.member, channel: G });
  assert.match(lastText(h, replay), /expired/);
  await h.click(customId('tickets', 'claim', mine.number), { ...there, channel: mine.channelId });
  assert.equal(h.store.get('tickets', B).tickets[mine.number].claimedBy, IDS.member, 'they are staff in their own server');
  assert.match(lastText(h, await h.click(customId('tickets', 'claim', victim.number), { user: IDS.member })), /Only staff/);
  assert.match(lastText(h, await h.click(customId('tickets', 'readd', victim.number, IDS.member), { user: IDS.member })), /Only staff or the person who opened/);
  const here = ticketOf(h, IDS.member2);
  assert.equal(here.status, 'open');
  assert.equal(here.claimedBy, null);
  assert.ok(!hasRole(h, IDS.member, victim.roleId));
});

test('ticket buttons do nothing outside a server', async () => {
  const h = await make();
  for (const action of [...ADMIN_ACTIONS, 'open', 'answers', 'addsave', 'closeyes', 'closeno']) {
    const ans = await h.click(customId('tickets', action, 'support'), { user: IDS.admin, server: null, ...formOpts(action) });
    assert.match(lastText(h, ans), /Servers only/, action);
  }
  assert.deepEqual(h.store.keys('tickets').filter((k) => k !== S), []);
  assertSetupUntouched(h);
  assert.equal(tickets(h).length, 0);
});

test('after Tickets is uninstalled every old button, command and form is dead', async () => {
  const h = await make({ features: { modals: false }, config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  await h.slash('tickets', `panel <#${G}>`, { user: IDS.admin });
  const panelMsg = h.lastSent(G);
  const { t } = await openTicketFor(h, IDS.member2, 'support help');
  const cardMsg = h.sent(t.channelId)[0];
  const ask = await h.slash('ticket', 'close', { user: IDS.member2, channel: t.channelId });
  const setupPanel = await h.slash('tickets', '', { user: IDS.admin });

  const form = h.click(customId('tickets', 'open', 'report'), { user: IDS.member });
  const asked = () => h.sent(G).filter((m) => m.content.startsWith(`<@${IDS.member}>`)).length;
  assert.ok(await waitFor(() => asked() === 1), 'first question asked');
  h.engine.settings.setEnabled(S, 'tickets', false);
  await h.message('riley', { user: IDS.member });
  assert.ok(await waitFor(() => asked() === 2), 'second question asked');
  await h.message('was rude', { user: IDS.member });
  await form;
  await h.settle();
  assert.equal(ticketOf(h, IDS.member), null, 'a form started before the uninstall opens nothing');
  assert.ok(h.sent(G).some((m) => /isn't installed here/.test(h.textOf(m))));

  const dead = (ans, what) => assert.match(allTexts(h, ans), /isn't installed here/, what);
  dead(await h.clickButton('Support', { user: IDS.member, in: panelMsg }), 'posted panel');
  dead(await h.clickButton('Claim', { user: IDS.mod, in: cardMsg, channel: t.channelId }), 'claim');
  dead(await h.clickButton('Close ticket', { user: IDS.member2, in: ask, channel: t.channelId }), 'close confirm');
  dead(await h.clickButton('Ping staff', { user: IDS.admin, in: setupPanel }), 'setup panel');
  dead(await h.slash('ticket', 'hello', { user: IDS.member }), '/ticket');
  dead(await h.slash('tickets', 'limit 4', { user: IDS.admin }), '/tickets');
  dead(await h.slash('yap', 'support hello', { user: IDS.member }), 'yap');
  dead(await h.click(customId('system', 'open', 'tickets'), { user: IDS.member }), 'home tile');
  await h.message('!ticket hello', { user: IDS.member });
  await h.message('!ticket claim', { user: IDS.mod, channel: t.channelId });

  assert.equal(ticketOf(h, IDS.member), null);
  const kept = ticketOf(h, IDS.member2);
  assert.equal(kept.status, 'open');
  assert.equal(kept.claimedBy, null);
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.equal(cfg.limit, 1);
  assert.equal(cfg.pingStaff, false);
});

test('staff who lose their role lose their open buttons too', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  const asMod = { user: IDS.mod, channel: t.channelId };
  const renamed = await h.slash('ticket', 'rename billing', asMod);
  const removed = await h.slash('ticket', 'remove riley', asMod);
  const ask = await h.slash('ticket', 'close', asMod);
  await h.clickButton('Claim', { ...asMod, in: h.sent(t.channelId)[0] });

  const m = h.fake.memberOf(S, IDS.mod);
  m.roles = m.roles.filter((r) => r !== R.mod);
  h.engine.cache.invalidate(S);

  assert.match(lastText(h, await h.clickButton('Undo: back', { ...asMod, in: renamed })), /Only staff/);
  assert.match(lastText(h, await h.clickButton('Undo: add', { ...asMod, in: removed })), /Only staff or the person who opened/);
  assert.match(lastText(h, await h.clickButton('Close ticket', { ...asMod, in: ask })), /Only staff or the person who opened/);
  assert.match(lastText(h, await h.clickButton('Keep it open', { ...asMod, in: ask })), /Only staff or the person who opened/);
  assert.match(lastText(h, await h.click(customId('tickets', 'unclaim', t.number), asMod)), /Only the person who claimed/);
  const now = ticketOf(h, IDS.member);
  assert.equal(now.status, 'open');
  assert.equal(now.claimedBy, IDS.mod);
  assert.deepEqual(now.members, []);
  assert.equal(channel(h, t.channelId).name, 'billing');
});

test('hostile text in forms and topics stays harmless', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [REPORT] } });
  const loud = `@everyone <@&${R.mod}> <@${IDS.owner}>`;
  const started = await h.slash('ticket', loud, { user: IDS.member });
  assert.equal(started[0].type, 'modal');
  const stolen = await h.submit(started[0].modal.custom_id, { q0: 'x', q1: 'y' }, { user: IDS.member2 });
  assert.match(lastText(h, stolen), /form expired/);
  assert.equal(tickets(h).length, 0, 'a form answer only counts for the person who started it');
  await h.submit(started[0].modal.custom_id, { q0: `${loud} ${'z'.repeat(5000)}`, q1: [loud, loud] }, { user: IDS.member });
  const t = ticketOf(h, IDS.member);
  assert.ok(t, 'ticket opened');
  assert.ok(t.answers.every((a) => a.a.length <= 1000));
  const cardMsg = h.sent(t.channelId)[0];
  assert.equal(cardMsg.content, `<@${IDS.member}>`, 'only the opener is mentioned in plain text');
  for (const m of h.sent(LOG)) assert.equal(m.content, '', 'log notes carry no plain-text mentions');

  const inTicket = { user: IDS.member, channel: t.channelId };
  for (const who of ['@everyone', `<@&${R.mod}>`, `<@${IDS.bot}>`, '', '   ', 'x'.repeat(300), ['riley', 'morgan']]) {
    await h.submit(customId('tickets', 'addsave'), { who }, inTicket);
  }
  await h.submit(customId('tickets', 'addsave'), null, inTicket);
  assert.deepEqual(ticketOf(h, IDS.member).members, []);
  for (const m of h.fake.state.members[S]) {
    if (m.id !== IDS.member) assert.ok(!m.roles.includes(t.roleId), `${m.username} was not let in`);
  }
  const ownerIn = await h.click(customId('tickets', 'readd', t.number, IDS.owner), { user: IDS.member2, channel: t.channelId });
  assert.match(lastText(h, ownerIn), /Only staff or the person who opened/);
  assert.deepEqual(h.fake.memberOf(S, IDS.member).roles.filter((r) => Object.values(R).includes(r)), [R.member], 'the opener gained no server role');
});

test('/tickets panel finds the channel however it is written', async () => {
  const h = await make();
  const C = IDS.channels.roles;
  const forms = ['#get-roles', '# get-roles', `<#${C}>.`, `<#${C}>,`, C, 'get roles', `​#get-roles​`, `# get-roles!`];
  for (const form of forms) {
    const before = h.sent(C).length;
    const posted = await h.slash('tickets', `panel ${form}`, { user: IDS.admin });
    assert.match(lastText(h, posted), /Panel posted/, form);
    assert.equal(h.sent(C).length, before + 1, form);
    const panelMsg = h.lastSent(C);
    assert.ok(h.findButton('Open a ticket', panelMsg), form);
    assert.equal(h.engine.settings.appConfig(S, 'tickets').panelChannelId, C, form);
    assert.equal(h.engine.settings.appConfig(S, 'tickets').panelMessageId, panelMsg.id, form);
  }
  const missing = await h.slash('tickets', 'panel #no-such-place', { user: IDS.admin });
  assert.match(lastText(h, missing), /couldn't find that channel/);
});

test('/tickets panel finds a channel made after the channel list was cached', async () => {
  const h = await make();
  const cached = await h.engine.cache.channels(S);
  const id = 'c0000000-0000-4000-8000-0000000000aa';
  assert.ok(!cached.some((c) => c.id === id));
  h.fake.state.channels[S].push({ id, name: 'support-desk', type: 'text', kind: 'text', server_id: S, position: 9, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  assert.ok(!(await h.engine.cache.channels(S)).some((c) => c.id === id), 'the cache still has the old list');
  const posted = await h.slash('tickets', 'panel #support-desk', { user: IDS.admin });
  assert.match(lastText(h, posted), /Panel posted/);
  assert.ok(h.findButton('Open a ticket', h.lastSent(id)));
  assert.equal(h.engine.settings.appConfig(S, 'tickets').panelChannelId, id);
});

test('transcripts turn mention codes into names and start with a byte order mark', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'mentions');
  await h.message(`hey <@${IDS.member}>, ask <@&${R.mod}> in <#${G}> or <@!${IDS.member2}>, not <@a0000000-0000-4000-8000-0000000000ff>`, { user: IDS.mod, channel: t.channelId });
  await h.message(`thanks <@${IDS.bot}>`, { user: IDS.member, channel: t.channelId });
  await closeWithTimers(h, t, { user: IDS.member, reason: 'done' });
  const file = h.sent(LOG).find((m) => m.files?.length).files[0];
  assert.equal(file.bytes.toString('utf8').charCodeAt(0), 0xfeff);
  assert.deepEqual([...file.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(file.text, /\] Mo: hey @Sam, ask @Moderator in #general or @Riley, not @someone/);
  assert.match(file.text, /\] Sam: thanks @YapOS/);
  assert.match(file.text, /\] YapOS: @Sam \[card: /);
  assert.doesNotMatch(file.text, /<@|<#|a0000000-0000-4000-8000/);
});

test('in a transcript the bot is YapOS even with a server nickname, and cards and emoji read as words', async () => {
  const h = await make();
  h.fake.memberOf(S, IDS.bot).nickname = 'Helper Bot';
  h.engine.cache.invalidate(S);
  const { t } = await openTicketFor(h, IDS.member, 'nicknamed bot');
  await h.message(`ping <@${IDS.bot}> <:party:e0000000-0000-4000-8000-000000000001> <a:wave:e0000000-0000-4000-8000-000000000002>`, { user: IDS.member, channel: t.channelId });
  h.fake.state.messages[t.channelId].push({ id: 'd0000000-0000-4000-8000-0000000000c1', channel_id: t.channelId, author_id: IDS.bot, content: '', embeds: [{ title: `Claimed by <@${IDS.mod}> for <@&${R.mod}>` }], components: null, flags: 0, reply_to_id: null, created_at: new Date(Date.parse(h.fake.state.messages[t.channelId].at(-1).created_at) + 1).toISOString(), edited_at: null, deleted: false, files: null, attachment_name: null });
  await closeWithTimers(h, t, { user: IDS.member, reason: 'done' });
  const file = h.sent(LOG).find((m) => m.files?.length).files[0];
  assert.match(file.text, /\] Sam: ping @YapOS :party: :wave:/);
  assert.match(file.text, /\] YapOS: \[card: Claimed by @Mo for @Moderator\]/);
  assert.match(file.text, /\] YapOS: @Sam \[card: /);
  assert.doesNotMatch(file.text, /Helper Bot/);
  assert.doesNotMatch(file.text, /<@|<#|<:|<a:|e0000000-/);
});

const HOUR = 3_600_000;
const dmOf = (user) => `d${user.slice(1)}`;
const dmMessages = (h, user) => (h.fake.state.messages[dmOf(user)] || []).filter((m) => !m.deleted);
const ratingCard = (h, user) => dmMessages(h, user).find((m) => /How did we do/.test(h.textOf(m)));
const jobsOf = (h, kind) => h.engine.scheduler.list({ kind, serverId: S });
const VIP = R.vip;

async function makeClock({ features = {}, config = { logChannelId: LOG }, store } = {}) {
  const h = await createHarness({ apps: ['tickets'], features, fakeClock: true, ...(store ? { store } : {}) });
  if (config) h.engine.settings.patchApp(S, 'tickets', config);
  return h;
}

async function rateClick(h, user, stars, { messageId = null, sid = S, num = 1 } = {}) {
  return h.click(customId('tickets', 'rate', sid, num, stars), { user, server: null, channel: dmOf(user), messageId });
}

test('closing DMs the opener a 1 to 5 rating card; a rating and a comment reach the log', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'printer');
  await h.slash('ticket', 'claim', { user: IDS.mod, channel: t.channelId });
  await closeWithTimers(h, t, { user: IDS.member });
  const ask = ratingCard(h, IDS.member);
  assert.ok(ask, 'rating card sent in DMs');
  assert.match(h.textOf(ask), /ticket #0001 on \*\*Test Town\*\*/);
  const stars = h.allButtons(ask);
  assert.deepEqual(stars.map((b) => b.label), ['1', '2', '3', '4', '5']);
  assert.ok(stars.every((b) => b.custom_id.length <= 100));
  const summary = h.sent(LOG).find((m) => /Ticket #0001 closed/.test(h.textOf(m)));
  assert.match(h.textOf(summary), /Asked <@[^>]+> to rate the help in DMs/);

  const ans = await rateClick(h, IDS.member, 4, { messageId: ask.id });
  assert.equal(ans[0].type, 'update');
  assert.match(h.textOf(ask), /Thanks for rating[\s\S]*4\/5/);
  assert.ok(h.findButton('Add a comment', ask));
  assert.equal(ticketOf(h, IDS.member).rating.stars, 4);
  const logged = h.sent(LOG).find((m) => /rated 4\/5/.test(h.textOf(m)));
  assert.ok(logged, 'rating posted to the ticket log');
  assert.match(h.textOf(logged), new RegExp(`<@${IDS.mod}>`), 'shows who claimed it');

  const again = await rateClick(h, IDS.member, 1, { messageId: ask.id });
  assert.match(h.textOf(again[0]), /4\/5/);
  assert.equal(ticketOf(h, IDS.member).rating.stars, 4, 'one rating per ticket');
  const elsewhere = await rateClick(h, IDS.member, 1);
  assert.match(h.textOf(elsewhere[0]), /Already rated/);

  const form = await h.click(h.findButton('Add a comment', ask).custom_id, { user: IDS.member, server: null, channel: dmOf(IDS.member), messageId: ask.id });
  assert.equal(form[0].type, 'modal');
  const saved = await h.submit(form[0].modal.custom_id, { comment: '  quick and kind  ' }, { user: IDS.member, server: null, channel: dmOf(IDS.member) });
  assert.match(h.textOf(saved[0]), /Comment saved/);
  await h.settle();
  assert.equal(ticketOf(h, IDS.member).rating.comment, 'quick and kind');
  assert.match(h.textOf(logged), /quick and kind/, 'the log card is edited in place');
  assert.equal(h.sent(LOG).filter((m) => /rated 4\/5/.test(h.textOf(m))).length, 1);
  assert.equal(h.allButtons(ask).length, 0, 'the DM card has no buttons left');
  const twice = await h.submit(form[0].modal.custom_id, { comment: 'second' }, { user: IDS.member, server: null, channel: dmOf(IDS.member) });
  assert.match(h.textOf(twice[0]), /already saved/);
  assert.equal(ticketOf(h, IDS.member).rating.comment, 'quick and kind');
  const setup = await h.slash('tickets', '', { user: IDS.admin });
  assert.match(lastText(h, setup), /4\.0 average from 1 rating/);
});

test('only the opener can rate, and odd or forged rating buttons do nothing', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const early = await rateClick(h, IDS.member, 5);
  assert.match(h.textOf(early[0]), /still open/);
  await closeWithTimers(h, t, { user: IDS.member });
  for (const user of [IDS.member2, IDS.admin, IDS.owner]) {
    const ans = await rateClick(h, user, 1);
    assert.match(h.textOf(ans[0]), /Not your ticket/, user);
  }
  const inServer = await h.click(customId('tickets', 'rate', 'a0000000-0000-4000-8000-00000000abcd', 1, 5), { user: IDS.member });
  assert.match(h.textOf(inServer[0]), /another server/);
  for (const id of [customId('tickets', 'rate', S, 1, 9), customId('tickets', 'rate', S, 'x', 3), customId('tickets', 'rate', 'constructor', 1, 3), customId('tickets', 'rate', S, 1, '__proto__')]) {
    const ans = await h.click(id, { user: IDS.member, server: null, channel: dmOf(IDS.member) });
    assert.match(h.textOf(ans[0]), /too old/, id);
  }
  const gone = await rateClick(h, IDS.member, 3, { num: 99 });
  assert.match(h.textOf(gone[0]), /gone/);
  const comment = await h.submit(customId('tickets', 'ratesave', S, 1), { comment: 'sneaky' }, { user: IDS.member2, server: null, channel: dmOf(IDS.member2) });
  assert.match(h.textOf(comment[0]), /Not your ticket/);
  const noStars = await h.submit(customId('tickets', 'ratesave', S, 1), { comment: 'no stars yet' }, { user: IDS.member, server: null, channel: dmOf(IDS.member) });
  assert.match(h.textOf(noStars[0]), /stars first/);
  assert.equal(ticketOf(h, IDS.member).rating, null);
});

test('DMs off: no rating card, and the log says so', async () => {
  const h = await make({ features: { dms: false } });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await closeWithTimers(h, t, { user: IDS.member });
  const summary = h.sent(LOG).find((m) => /Ticket #0001 closed/.test(h.textOf(m)));
  assert.match(h.textOf(summary), /Couldn't ask <@[^>]+> for a rating/);
  assert.equal(ratingCard(h, IDS.member), undefined);
  assert.equal(ticketOf(h, IDS.member).status, 'closed');
});

test('comments say so plainly when pop-up forms are off', async () => {
  const h = await make({ features: { modals: false } });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await closeWithTimers(h, t, { user: IDS.member });
  const ask = ratingCard(h, IDS.member);
  await rateClick(h, IDS.member, 2, { messageId: ask.id });
  const ans = await h.clickButton('Add a comment', { user: IDS.member, in: ask, server: null, channel: dmOf(IDS.member) });
  assert.match(h.textOf(ans[ans.length - 1]), /Comments aren't available here/);
  assert.equal(ticketOf(h, IDS.member).rating.stars, 2);
});

test('ratings stop working once Tickets is uninstalled', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await closeWithTimers(h, t, { user: IDS.member });
  h.engine.settings.setEnabled(S, 'tickets', false);
  const ans = await rateClick(h, IDS.member, 5);
  assert.match(h.textOf(ans[0]), /isn't installed there/);
  assert.equal(ticketOf(h, IDS.member).rating, null);
});

test('a ticket type can have its own staff who see, claim and close only that type', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  h.fake.memberOf(S, IDS.member2).roles.push(VIP);
  h.engine.cache.invalidate(S);
  const set = await h.slash('tickets', `type report staff <@&${VIP}>`, { user: IDS.admin });
  assert.match(lastText(h, set), /Report: staff saved/);
  const cfg = h.engine.settings.appConfig(S, 'tickets');
  assert.deepEqual(cfg.types.find((x) => x.id === 'report').staffRoles, [VIP]);
  assert.deepEqual(cfg.types.find((x) => x.id === 'support').staffRoles || [], []);

  const form = await h.click(customId('tickets', 'open', 'report'), { user: IDS.member });
  await h.submit(form[0].modal.custom_id, { q0: 'someone', q1: 'something' }, { user: IDS.member });
  const report = ticketOf(h, IDS.member);
  assert.ok(channel(h, report.channelId).role_ids.includes(VIP), 'report staff can see report tickets');
  assert.ok(channel(h, report.channelId).role_ids.includes(R.mod), 'main staff still can');
  await h.slash('ticket', 'support printer', { user: IDS.admin });
  const support = ticketOf(h, IDS.admin);
  assert.ok(!channel(h, support.channelId).role_ids.includes(VIP), 'not on other types');

  const nope = await h.slash('ticket', 'claim', { user: IDS.member2, channel: support.channelId });
  assert.match(lastText(h, nope), /Needs Staff/);
  const claim = await h.slash('ticket', 'claim', { user: IDS.member2, channel: report.channelId });
  assert.match(allTexts(h, claim), /claimed this ticket/);
  assert.equal(ticketOf(h, IDS.member).claimedBy, IDS.member2);
  const fromAfar = await h.slash('ticket', 'close #2', { user: IDS.member2 });
  assert.match(lastText(h, fromAfar), /isn't a ticket channel/, 'cannot close another type from afar');
  const closeAsk = await h.slash('ticket', `close #${report.number} sorted`, { user: IDS.member2 });
  assert.ok(h.findButton('Close ticket', closeAsk), 'can close its own type from afar');
});

test('/tickets type: show, clear, typos, refusals and roles everyone has', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  await h.slash('tickets', `type report staff <@&${VIP}> <@&${R.gamer}>`, { user: IDS.admin });
  const show = await h.slash('tickets', 'type report', { user: IDS.admin });
  assert.match(lastText(h, show), new RegExp(`Extra staff: <@&${VIP}> <@&${R.gamer}>`));
  const typo = await h.slash('tickets', 'type reprot staff @VIP', { user: IDS.admin });
  assert.match(lastText(h, typo), /Did you mean \*\*report\*\*/);
  const member = await h.slash('tickets', `type report staff <@&${R.member}>`, { user: IDS.mod });
  assert.match(lastText(h, member), /Needs Admin/);
  const missing = await h.slash('tickets', 'type report staff @nobodyrole', { user: IDS.admin });
  assert.match(lastText(h, missing), /couldn't find some roles/);
  h.fake.state.roles[S].find((r) => r.id === R.member).auto = 'all';
  h.engine.perms.invalidate();
  const auto = await h.slash('tickets', `type report staff <@&${R.member}>`, { user: IDS.admin });
  assert.match(lastText(h, auto), /given to everyone/);
  const cfg = () => h.engine.settings.appConfig(S, 'tickets').types.find((x) => x.id === 'report');
  assert.deepEqual(cfg().staffRoles, [VIP, R.gamer]);
  await h.slash('tickets', 'type report staff off', { user: IDS.admin });
  assert.deepEqual(cfg().staffRoles, []);
  for (const text of ['type constructor staff @VIP', 'type __proto__', 'type report staff constructor']) {
    const ans = await h.slash('tickets', text, { user: IDS.admin });
    assert.doesNotMatch(allTexts(h, ans), /undefined/, text);
  }
});

test('Staff per type panel and the types editor keep the staff roles', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  const setup = await h.slash('tickets', '', { user: IDS.admin });
  const view = await h.clickButton('Staff per type', { user: IDS.admin, in: setup });
  const viewMsg = view[view.length - 1];
  assert.match(h.textOf(viewMsg), /Staff per ticket type/);
  const refused = await h.click(customId('tickets', 'tstaff', 'report'), { user: IDS.mod });
  assert.match(allTexts(h, refused), /Needs Admin/);
  const form = await h.clickButton('Report', { user: IDS.admin, in: viewMsg });
  assert.equal(form[0].type, 'modal');
  await h.submit(form[0].modal.custom_id, { value: 'VIP' }, { user: IDS.admin });
  const types = () => h.engine.settings.appConfig(S, 'tickets').types;
  assert.deepEqual(types().find((x) => x.id === 'report').staffRoles, [VIP]);
  const stolen = await h.submit(form[0].modal.custom_id, { value: 'Gamer' }, { user: IDS.admin });
  assert.match(allTexts(h, stolen), /expired/, 'a form only saves once');
  const editor = await h.slash('tickets', 'types', { user: IDS.admin });
  await h.submit(editor[0].modal.custom_id, { t1: '🎫 Support', t2: '🚩 Report: Who?; What?', t3: '❓ Question' }, { user: IDS.admin });
  assert.deepEqual(types().find((x) => x.id === 'report').staffRoles, [VIP], 'kept after editing types');
  assert.deepEqual(types().find((x) => x.id === 'question').staffRoles, []);
  const after = await h.slash('tickets', '', { user: IDS.admin });
  assert.match(lastText(h, after), new RegExp(`Extra staff: <@&${VIP}>`));
});

test('auto-close: warning after the quiet period, then a normal close with transcript', async () => {
  const h = await makeClock();
  const on = await h.slash('tickets', 'autoclose 48', { user: IDS.admin });
  assert.match(lastText(h, on), /Auto-close on/);
  const { t } = await openTicketFor(h, IDS.member, 'printer');
  assert.equal(jobsOf(h, 'tickets.quietwarn').length, 1);
  await h.advance(36 * HOUR - 60_000);
  assert.ok(!h.sent(t.channelId).some((m) => /gone quiet/.test(h.textOf(m))), 'no warning yet');
  await h.advance(60_000);
  const warning = h.sent(t.channelId).find((m) => /gone quiet/.test(h.textOf(m)));
  assert.ok(warning, 'warning posted');
  assert.match(h.textOf(warning), /This ticket will close in 12 hours because it's been quiet/);
  assert.ok(h.findButton('Keep open', warning));
  assert.equal(jobsOf(h, 'tickets.quietclose').length, 1);
  await h.advance(12 * HOUR);
  const done = ticketOf(h, IDS.member);
  assert.equal(done.status, 'closed');
  assert.equal(done.closedBy, null);
  assert.match(done.reason, /Closed automatically after 2 days with no messages/);
  const logMsg = h.sent(LOG).find((m) => m.files?.length);
  assert.ok(logMsg, 'transcript in the log');
  assert.match(h.textOf(logMsg), /Closed by YapOS|YapOS/);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length + jobsOf(h, 'tickets.quietclose').length, 0);
  assert.ok(ratingCard(h, IDS.member), 'still asks for a rating');
});

test('auto-close: a message pushes the warning back and a reply after it cancels the close', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 48', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.advance(30 * HOUR);
  await h.message('still here', { user: IDS.member, channel: t.channelId });
  assert.equal(ticketOf(h, IDS.member).lastActivityAt, h.now());
  await h.advance(10 * HOUR);
  assert.ok(!h.sent(t.channelId).some((m) => /gone quiet/.test(h.textOf(m))), 'pushed back');
  await h.advance(26 * HOUR);
  const warning = h.sent(t.channelId).find((m) => /gone quiet/.test(h.textOf(m)));
  assert.ok(warning);
  await h.advance(HOUR);
  await h.message('sorry, still need help', { user: IDS.mod, channel: t.channelId });
  await h.settle();
  assert.match(h.textOf(warning), /Someone replied, so this ticket stays open/);
  assert.equal(h.allButtons(warning).length, 0);
  assert.equal(jobsOf(h, 'tickets.quietclose').length, 0);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length, 1, 'jobs are replaced, not stacked');
  await h.advance(12 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
});

test('auto-close: messages are only saved once per 10 minutes but still count', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 48', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const opened = ticketOf(h, IDS.member).lastActivityAt;
  await h.advance(5 * 60_000);
  for (let i = 0; i < 5; i++) await h.message(`msg ${i}`, { user: IDS.member, channel: t.channelId });
  assert.equal(ticketOf(h, IDS.member).lastActivityAt, opened, 'not written again within 10 minutes');
  const lastMsgAt = h.now();
  await h.advanceTo(opened + 36 * HOUR);
  assert.ok(!h.sent(t.channelId).some((m) => /gone quiet/.test(h.textOf(m))), 'the unsaved message still counted');
  await h.advanceTo(lastMsgAt + 36 * HOUR);
  assert.ok(h.sent(t.channelId).some((m) => /gone quiet/.test(h.textOf(m))));
  await h.advance(11 * 60_000);
  await h.message('one more', { user: IDS.member, channel: t.channelId });
  assert.equal(ticketOf(h, IDS.member).lastActivityAt, h.now(), 'saved straight away after a warning');
});

test('Keep open resets the timer; only the opener or staff may press it', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 24', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.advance(12 * HOUR);
  const warning = h.sent(t.channelId).find((m) => /gone quiet/.test(h.textOf(m)));
  assert.match(h.textOf(warning), /close in 12 hours/);
  const stranger = await h.clickButton('Keep open', { user: IDS.member2, in: warning });
  assert.match(allTexts(h, stranger), /Needs Staff/);
  const ans = await h.clickButton('Keep open', { user: IDS.member, in: warning });
  assert.equal(ans[0].type, 'update');
  assert.match(h.textOf(warning), /kept this ticket open/);
  assert.equal(jobsOf(h, 'tickets.quietclose').length, 0);
  await h.advance(12 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  const second = h.sent(t.channelId).filter((m) => /gone quiet/.test(h.textOf(m)));
  assert.equal(second.length, 1, 'warned again after another quiet stretch');
  assert.notEqual(second[0].id, warning.id);
  await h.advance(12 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'closed');
});

test('auto-close survives a restart, and a long downtime still gives the full warning', async () => {
  const a = await makeClock();
  await a.slash('tickets', 'autoclose 48', { user: IDS.admin });
  const { t } = await openTicketFor(a, IDS.member, 'help');
  const ch = channel(a, t.channelId);
  const role = a.fake.state.roles[S].find((r) => r.id === t.roleId);
  const startedAt = a.now();
  a.engine.scheduler.stop();

  const b = await makeClock({ store: a.store, config: null });
  b.fake.state.channels[S].push(structuredClone(ch));
  b.fake.state.roles[S].push(structuredClone(role));
  b.fake.clock.t = startedAt + 60 * HOUR;
  await b.runDue();
  const warning = b.sent(t.channelId).find((m) => /gone quiet/.test(b.textOf(m)));
  assert.ok(warning, 'warning posted after the restart');
  assert.match(b.textOf(warning), /close in 12 hours/);
  assert.equal(ticketOf(b, IDS.member).status, 'open');
  await b.advance(12 * HOUR);
  assert.equal(ticketOf(b, IDS.member).status, 'closed');
  assert.ok(b.sent(LOG).some((m) => m.files?.length), 'transcript saved');
});

test('auto-close off, uninstalled, channel gone and closed by hand leave nothing behind', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 48', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  const off = await h.slash('tickets', 'autoclose off', { user: IDS.admin });
  assert.match(lastText(h, off), /Auto-close off/);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length, 0);
  await h.advance(60 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open');

  await h.slash('tickets', 'autoclose 2d', { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'tickets').autoCloseHours, 48);
  const warned = () => h.sent(t.channelId).filter((m) => /gone quiet/.test(h.textOf(m))).length;
  assert.equal(warned(), 1, 'an overdue open ticket is warned as soon as auto-close is turned on');
  assert.equal(jobsOf(h, 'tickets.quietclose').length, 1);
  h.engine.settings.setEnabled(S, 'tickets', false);
  await h.advance(60 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open', 'nothing happens while uninstalled');
  assert.equal(warned(), 1);
  h.engine.settings.setEnabled(S, 'tickets', true);

  h.fake.state.channels[S] = h.fake.state.channels[S].filter((c) => c.id !== t.channelId);
  await h.slash('tickets', 'autoclose 48', { user: IDS.admin });
  await h.settle();
  const gone = ticketOf(h, IDS.member);
  assert.equal(gone.status, 'closed', 'a ticket whose channel vanished is closed');
  assert.match(gone.reason, /deleted by hand/);

  await h.slash('ticket', 'second one', { user: IDS.member2 });
  const t2 = ticketOf(h, IDS.member2);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length, 1);
  await closeByHand(h, t2);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length + jobsOf(h, 'tickets.quietclose').length, 0);
});

async function closeByHand(h, t) {
  const ask = await h.slash('ticket', 'close done', { user: t.openerId, channel: t.channelId });
  const btn = h.findButton('Close ticket', ask);
  await h.click(btn.custom_id, { user: t.openerId, channel: t.channelId, messageId: btn.messageId });
}

test('/tickets autoclose: bad values, the setup panel form and admins only', async () => {
  const h = await makeClock();
  for (const bad of ['0.5', 'soon', '9999', '-3']) {
    const ans = await h.slash('tickets', `autoclose ${bad}`, { user: IDS.admin });
    assert.match(lastText(h, ans), /didn't work/, bad);
  }
  assert.equal(h.engine.settings.appConfig(S, 'tickets').autoCloseHours, 0);
  const show = await h.slash('tickets', 'autoclose', { user: IDS.admin });
  assert.match(lastText(h, show), /Off/);
  const mod = await h.slash('tickets', 'autoclose 24', { user: IDS.mod });
  assert.match(lastText(h, mod), /Needs Admin/);
  const setup = await h.slash('tickets', '', { user: IDS.admin });
  const form = await h.clickButton('Auto-close', { user: IDS.admin, in: setup });
  assert.equal(form[0].type, 'modal');
  await h.submit(form[0].modal.custom_id, { value: '24' }, { user: IDS.admin });
  assert.equal(h.engine.settings.appConfig(S, 'tickets').autoCloseHours, 24);
  const forged = await h.submit(form[0].modal.custom_id, { value: '1' }, { user: IDS.member });
  assert.match(allTexts(h, forged), /Needs Admin/);
  assert.equal(h.engine.settings.appConfig(S, 'tickets').autoCloseHours, 24);
  const after = await h.slash('tickets', '', { user: IDS.admin });
  assert.match(lastText(h, after), /After 1 day with no messages/);
  assert.equal(h.engine.apps.get('tickets').def.panelPerm, 'member');
});

test('turning auto-close off calms a warning that is already posted', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 24', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  await h.advance(12 * HOUR);
  const warning = h.sent(t.channelId).find((m) => /gone quiet/.test(h.textOf(m)));
  assert.ok(h.findButton('Keep open', warning));
  await h.slash('tickets', 'autoclose off', { user: IDS.admin });
  await h.settle();
  assert.match(h.textOf(warning), /Auto-close was turned off, so this ticket stays open/);
  assert.equal(h.allButtons(warning).length, 0);
  assert.equal(ticketOf(h, IDS.member).quietWarn, null);
  await h.advance(48 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
});

test('quiet checks dropped while Tickets was uninstalled come back after it is reinstalled', async () => {
  const h = await makeClock();
  await h.slash('tickets', 'autoclose 24', { user: IDS.admin });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.engine.settings.setEnabled(S, 'tickets', false);
  await h.advance(13 * HOUR);
  assert.equal(jobsOf(h, 'tickets.quietwarn').length + jobsOf(h, 'tickets.quietclose').length, 0, 'dropped while uninstalled');
  h.engine.settings.setEnabled(S, 'tickets', true);
  await h.message('anyone around?', { user: IDS.member2, channel: G });
  await h.runDue();
  assert.equal(jobsOf(h, 'tickets.quietwarn').length + jobsOf(h, 'tickets.quietclose').length, 1, 'picked up again on the next message anywhere');
  const warning = h.sent(t.channelId).find((m) => /gone quiet/.test(h.textOf(m)));
  assert.match(h.textOf(warning), /close in 12 hours/, 'overdue, so it warns now with the full lead time');
  await h.advance(11 * HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'open');
  await h.advance(HOUR);
  assert.equal(ticketOf(h, IDS.member).status, 'closed');
});

test('the setup panel keeps long staff lists per type short', async () => {
  const h = await make({ config: { logChannelId: LOG, types: [SUPPORT, REPORT] } });
  await h.slash('tickets', `type report staff <@&${R.vip}> <@&${R.gamer}> <@&${R.member}> <@&${R.mod}>`, { user: IDS.admin });
  const setup = await h.slash('tickets', '', { user: IDS.admin });
  const field = setup[setup.length - 1].embeds[0].fields.find((f) => /^Types/.test(f.name));
  assert.match(field.value, /Extra staff: (<@&[^>]+> ){3}\+1 more/);
});

const overrideOf = (h, cid, uid) => h.fake.state.overrides[`${cid}:${uid}`] || null;
const overridePuts = (h) => h.fake.calls.filter((c) => c.method === 'PUT' && /\/overrides\//.test(c.path)).length;

test('when Yapin lets bots add one person, tickets use no roles at all', async () => {
  const h = await make({ features: { memberOverrides: true } });
  const rolesBefore = h.fake.state.roles[S].length;
  const { t } = await openTicketFor(h, IDS.member, 'help');
  assert.equal(t.roleId, null);
  assert.equal(t.mode, 'direct');
  assert.equal(t.access[IDS.member], 'direct');
  assert.deepEqual(overrideOf(h, t.channelId, IDS.member).allow, ['view_channel', 'send_messages']);
  assert.equal(channel(h, t.channelId).private, true);
  const added = await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  assert.match(lastText(h, added), /Added to the ticket/);
  assert.ok(overrideOf(h, t.channelId, IDS.member2), 'riley was added straight to the channel');
  assert.equal(ticketOf(h, IDS.member).access[IDS.member2], 'direct');
  assert.equal(h.fake.state.roles[S].length, rolesBefore, 'no role was made');
  await h.slash('ticket', 'remove riley', { user: IDS.mod, channel: t.channelId });
  assert.equal(overrideOf(h, t.channelId, IDS.member2), null);
  assert.equal(ticketOf(h, IDS.member).access[IDS.member2], undefined);
  assert.deepEqual(ticketOf(h, IDS.member).members, []);
});

test('while Yapin says no to adding one person, a ticket role is used and the answer is remembered', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  assert.equal(t.mode, 'role');
  assert.ok(t.roleId);
  assert.equal(overrideOf(h, t.channelId, IDS.member), null);
  assert.ok(channel(h, t.channelId).role_ids.includes(t.roleId), 'the ticket role was let into the channel');
  assert.ok(hasRole(h, IDS.member, t.roleId));
  const tries = overridePuts(h);
  assert.equal(tries, 1);
  await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  assert.ok(hasRole(h, IDS.member2, t.roleId));
  assert.equal(overridePuts(h), tries, 'no second try while Yapin still says no');
});

test('an override that does not really let them in falls back to the ticket role', async () => {
  const h = await make({ features: { memberOverrides: true, memberOverridesWork: false } });
  const { t } = await openTicketFor(h, IDS.member, 'help');
  assert.equal(t.mode, 'role');
  assert.ok(hasRole(h, IDS.member, t.roleId));
  assert.equal(overrideOf(h, t.channelId, IDS.member), null, 'the useless override was taken back');
});

test('an older ticket made with a role keeps using it for adds and removes', async () => {
  const h = await make();
  const { t } = await openTicketFor(h, IDS.member, 'help');
  h.engine.store.update('tickets', S, (d) => { delete d.tickets[t.number].access; return d; }, { tickets: {} });
  h.fake.features.memberOverrides = true;
  await h.slash('ticket', `add <@${IDS.member2}>`, { user: IDS.member, channel: t.channelId });
  await h.slash('ticket', 'remove riley', { user: IDS.mod, channel: t.channelId });
  assert.ok(!hasRole(h, IDS.member2, t.roleId));
});
