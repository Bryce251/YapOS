import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, makeNonce } from '../../engine/budget.js';
import { looksLikeFeatureOff } from '../../engine/errors.js';
import { customId } from '../../engine/router.js';
import { buttonsOnly, EPHEMERAL_BUTTON_MS } from '../../engine/context.js';
import { createYapinApi } from '../../engine/yapin-api.js';
import { row, button } from '../../engine/ui.js';
import { createHarness, IDS, settle } from '../harness.js';

const S = IDS.server;
const G = IDS.channels.general;

function menuApp(h, { components } = {}) {
  const seen = [];
  h.engine.router.register('sys', 'eopen', async (ctx) => {
    await ctx.ephemeral({ content: 'menu page 1', components: components || [row(button('Next', customId('sys', 'enext'), 'primary'))] });
  });
  h.engine.router.register('sys', 'enext', async (ctx) => {
    seen.push({ onEphemeral: ctx.onEphemeral, canUpdate: ctx.canUpdate, replyId: ctx.replyId });
    await ctx.update({ content: 'menu page 2', components: [row(button('Back', customId('sys', 'eopen')))] });
  });
  return seen;
}

const ephemeralWithButtons = (h) => h.fake.callsTo('POST', /\/callback$/).filter((c) => c.body.type === 'ephemeral' && c.body.components?.length);

test('the new "isn\'t on" refusal counts as a feature that is off', () => {
  assert.equal(looksLikeFeatureOff(Object.assign(new Error("This isn't on for this server yet"), { status: 403 })), true);
  assert.equal(looksLikeFeatureOff(Object.assign(new Error('This isn’t on for this server yet'), { status: 400 })), true);
  assert.equal(looksLikeFeatureOff(Object.assign(new Error('Missing permission'), { status: 403 })), false);
});

test('buttonsOnly accepts up to 5 rows of buttons and nothing else', () => {
  assert.equal(buttonsOnly([row(button('A', 'a'))]), true);
  assert.equal(buttonsOnly([{ type: 1, components: [{ type: 2, label: 'x', custom_id: 'x' }] }]), true);
  assert.equal(buttonsOnly([{ type: 'row', components: [{ type: 'select', custom_id: 's', options: [] }] }]), false);
  assert.equal(buttonsOnly(Array.from({ length: 6 }, (_, i) => row(button(`b${i}`, `b${i}`)))), false);
  assert.equal(buttonsOnly([]), false);
});

test('ephemeral replies keep their buttons and a click edits them in place', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  const seen = menuApp(h);
  const first = await h.click(customId('sys', 'eopen'));
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'ephemeral');
  assert.ok(first[0].replyId, 'the fake gave the reply an id');
  assert.equal(h.sent(G).length, 0, 'nothing public was posted');
  assert.equal(h.engine.caps.state(S, 'ephemeral_buttons'), true);
  assert.ok(h.engine.ephemeralReplies.lastWrite(first[0].replyId));

  const next = await h.clickButton('Next', { in: first });
  assert.equal(next[0].type, 'update');
  assert.deepEqual(seen[0], { onEphemeral: true, canUpdate: true, replyId: first[0].replyId });
  const stored = h.fake.ephemeralReplies.get(first[0].replyId);
  assert.equal(stored.content, 'menu page 2');
  assert.equal(stored.components[0].components[0].label, 'Back');
});

test('select menus still go to a panel even with ephemeral buttons on', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  menuApp(h, { components: [{ type: 'row', components: [{ type: 'select', custom_id: customId('sys', 'pick'), options: [{ label: 'One', value: '1' }] }] }] });
  const out = await h.click(customId('sys', 'eopen'));
  assert.equal(out[0].type, 'reply');
  assert.equal(ephemeralWithButtons(h).length, 0);
});

test('a server without ephemeral buttons gets the panel at once and is remembered', async () => {
  const h = await createHarness({ loadApps: false });
  menuApp(h);
  const out = await h.click(customId('sys', 'eopen'));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'reply', 'retried through the panel in the same click');
  assert.match(h.textOf(out[0]), /menu page 1/);
  assert.equal(h.engine.caps.state(S, 'ephemeral_buttons'), false);
  await h.click(customId('sys', 'eopen'));
  assert.equal(ephemeralWithButtons(h).length, 1, 'no second try while it is marked off');
  const panel = h.findButton('Next');
  const after = await h.click(panel.custom_id, { messageId: panel.messageId });
  assert.equal(after[0].type, 'update');
});

test('the live "isn\'t on for this server yet" refusal falls back to the panel', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  menuApp(h);
  h.fake.fail('POST', /\/callback$/, { status: 403, error: "This isn't on for this server yet", times: 1 });
  const out = await h.click(customId('sys', 'eopen'));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'reply');
  assert.equal(h.engine.caps.state(S, 'ephemeral_buttons'), false);
});

test('a command event can answer with an ephemeral button reply, and falls back too', async () => {
  for (const on of [true, false]) {
    const h = await createHarness({ loadApps: false, features: { ephemeralButtons: on } });
    h.bot.command('eprobe', 'test only', async (msg) => {
      const ctx = h.engine.contextFor(msg, { app: 'sys' });
      await ctx.ephemeral({ content: 'pick one', components: [row(button('Go', customId('sys', 'go')))] });
    });
    const out = await h.slash('eprobe');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, on ? 'ephemeral' : 'reply');
    assert.equal(h.engine.caps.state(S, 'ephemeral_buttons'), on);
  }
});

test('a click on an ephemeral menu older than 15 minutes gets a friendly expired note', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  const seen = menuApp(h);
  const first = await h.click(customId('sys', 'eopen'));
  const realNow = h.engine.ephemeralReplies.now;
  h.engine.ephemeralReplies.now = () => realNow() + EPHEMERAL_BUTTON_MS + 1000;
  try {
    const out = await h.clickButton('Next', { in: first });
    assert.equal(seen.length, 0, 'the handler never ran');
    assert.equal(out[0].type, 'ephemeral');
    assert.match(h.textOf(out[0]), /This menu expired/);
    assert.match(h.textOf(out[0]), /Run the command again/);
  } finally {
    h.engine.ephemeralReplies.now = realNow;
  }
});

test('when Yapin\' says the reply expired, the click still gets a friendly note', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  menuApp(h);
  const first = await h.click(customId('sys', 'eopen'));
  h.fake.clock.t += EPHEMERAL_BUTTON_MS + 60_000;
  const out = await h.clickButton('Next', { in: first });
  const last = out[out.length - 1];
  assert.equal(last.type, 'ephemeral');
  assert.match(h.textOf(last), /This menu expired/);
});

test('nonces are 8-64 safe characters and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const n = makeNonce();
    assert.match(n, /^[A-Za-z0-9_-]{8,64}$/);
    seen.add(n);
  }
  assert.equal(seen.size, 500);
});

test('every budget send carries a nonce, and a retry after a 504 never double posts', async () => {
  const h = await createHarness({ loadApps: false });
  const budget = createBudget({ bot: h.bot, caps: h.engine.caps, retryDelays: [5, 5] });
  await budget.send({ serverId: S, channelId: G, content: 'hello' });
  const first = h.fake.callsTo('POST', /\/channels\/[^/]+\/messages$/).pop();
  assert.match(first.body.nonce, /^[A-Za-z0-9_-]{8,64}$/);

  const real = h.bot.api;
  let broke = 0;
  h.bot.api = async (method, p, body) => {
    const out = await real(method, p, body);
    if (method === 'POST' && /\/messages$/.test(p) && broke++ === 0) throw Object.assign(new Error('Bad gateway'), { status: 504 });
    return out;
  };
  try {
    const msg = await budget.send({ serverId: S, channelId: G, content: 'only once', priority: 'high' });
    assert.equal(msg.content, 'only once');
  } finally {
    h.bot.api = real;
  }
  const posts = h.fake.callsTo('POST', /\/channels\/[^/]+\/messages$/).slice(1);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.nonce, posts[1].body.nonce, 'the retry reused the nonce');
  assert.equal(h.sent(G).filter((m) => m.content === 'only once').length, 1);
  assert.equal(budget.stats.retried, 1);
  assert.equal(budget.stats.duplicates, 1);
});

test('a send that keeps failing with a 403 is not retried', async () => {
  const h = await createHarness({ loadApps: false });
  const budget = createBudget({ bot: h.bot, caps: h.engine.caps, retryDelays: [5, 5] });
  h.fake.fail('POST', /\/messages$/, { status: 403, error: 'Missing permission' });
  await assert.rejects(budget.send({ serverId: S, channelId: G, content: 'nope' }), /Missing permission/);
  assert.equal(h.fake.callsTo('POST', /\/messages$/).length, 1);
});

test('without nonce support the budget sends the old way and remembers', async () => {
  const h = await createHarness({ loadApps: false, features: { nonce: false } });
  const budget = createBudget({ bot: h.bot, caps: h.engine.caps, retryDelays: [5] });
  const m = await budget.send({ serverId: S, channelId: G, content: 'first' });
  assert.equal(m.content, 'first');
  assert.equal(h.engine.caps.state(S, 'nonce'), false);
  await budget.send({ serverId: S, channelId: G, content: 'second' });
  const posts = h.fake.callsTo('POST', /\/messages$/);
  assert.equal(posts.length, 3);
  assert.equal(posts[2].body.nonce, undefined);
  assert.equal(h.sent(G).length, 2);
});

test('files and layouts: files skip the nonce, layouts keep it', async () => {
  const h = await createHarness({ loadApps: false });
  const budget = createBudget({ bot: h.bot, caps: h.engine.caps });
  await budget.send({ serverId: S, channelId: G, content: 'file', opts: { files: [{ name: 'a.txt', data: 'hi' }] } });
  const filed = h.fake.callsTo('POST', /\/messages$/).pop();
  assert.equal(filed.body.nonce, undefined);
  assert.equal(filed.files.length, 1);
  await budget.send({ serverId: S, channelId: G, layout: [{ type: 17, components: [{ type: 10, content: 'hi' }] }] });
  const laid = h.fake.callsTo('POST', /\/messages$/).pop();
  assert.equal(laid.body.flags, 32768);
  assert.match(laid.body.nonce, /^[A-Za-z0-9_-]{8,64}$/);
});

test('server_add and server_remove reach engine hooks and unpublish once', async () => {
  const h = await createHarness({ loadApps: false });
  const added = [];
  const removed = [];
  const gone = [];
  h.engine.on('server_add', (e) => added.push(e));
  h.engine.on('server_remove', (e) => removed.push(e));
  h.engine.dashboard.serverGone = async (sid) => { gone.push(sid); };
  const other = '5e000000-0000-4000-8000-0000000000aa';
  await h.event('server_add', { server_id: other, name: 'New place', member_count: 12 });
  await h.event('server_add', { server_id: other, name: 'New place', member_count: 13 });
  assert.equal(added.length, 2);
  assert.deepEqual(added.map((e) => e.fresh), [true, false]);
  assert.equal(added[0].name, 'New place');
  assert.equal(h.engine.servers.seen.get(other).member_count, 13);

  await h.event('server_remove', { server_id: other });
  await h.bot.handle({ id: 999_999, type: 'member_leave', data: { server_id: other, user_id: IDS.bot } });
  await settle();
  assert.deepEqual(gone, [other], 'unpublished once even when both events arrive');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].via, 'server_remove');
  assert.equal(h.engine.servers.seen.has(other), false);
});

test('leaving through member_leave still works on its own', async () => {
  const h = await createHarness({ loadApps: false });
  const gone = [];
  h.engine.dashboard.serverGone = async (sid) => { gone.push(sid); };
  await h.leave(IDS.bot);
  assert.deepEqual(gone, [S]);
});

test('server_add drops cached lists for that server', async () => {
  const h = await createHarness({ loadApps: false });
  await h.engine.cache.channels(S);
  await h.engine.cache.channels(S);
  assert.equal(h.fake.callsTo('GET', /\/servers\/[^/]+\/channels/).length, 1);
  await h.event('server_add', { server_id: S, name: 'Test', member_count: 5 });
  await h.engine.cache.channels(S);
  assert.equal(h.fake.callsTo('GET', /\/servers\/[^/]+\/channels/).length, 2);
});

test('createPrivateChannel makes it private from the start when Yapin\' can', async () => {
  const h = await createHarness({ loadApps: false, features: { channelUsers: true } });
  const out = await h.engine.yapin.createPrivateChannel(S, 'ticket-1', { roleIds: [IDS.roles.mod], userIds: [IDS.member] });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'create');
  assert.equal(out.channel.private, true);
  assert.deepEqual(out.channel.user_ids, [IDS.member]);
  assert.equal(h.fake.callsTo('PATCH', /\/channels\//).length, 0);
  assert.equal(h.engine.caps.state(S, 'private_create'), true);
});

test('createPrivateChannel falls back to create then edit on an older Yapin\'', async () => {
  const h = await createHarness({ loadApps: false });
  const out = await h.engine.yapin.createPrivateChannel(S, 'ticket-2', { roleIds: [IDS.roles.mod], userIds: [IDS.member] });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'edit');
  assert.equal(out.private, true);
  assert.equal(out.usersSet, false, 'no member list on this server');
  const ch = h.fake.channelById(out.channel.id);
  assert.equal(ch.private, true);
  assert.deepEqual(ch.role_ids, [IDS.roles.mod]);
  assert.equal(h.engine.caps.state(S, 'private_create'), false);
  assert.equal(h.engine.caps.state(S, 'channel_users'), false);
  await h.engine.yapin.createPrivateChannel(S, 'ticket-3', { roleIds: [IDS.roles.mod] });
  assert.equal(h.fake.callsTo('POST', /\/servers\/[^/]+\/channels$/).filter((c) => c.body.private).length, 1, 'no second try while off');
});

test('createPrivateChannel explains a missing permission without raw codes', async () => {
  const h = await createHarness({ loadApps: false, features: { channelUsers: true } });
  h.fake.fail('POST', /\/servers\/[^/]+\/channels$/, { status: 403, error: 'Missing permission' });
  const out = await h.engine.yapin.createPrivateChannel(S, 'ticket-x', { roleIds: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'denied');
  assert.match(out.body, /Manage Channels/);
  assert.doesNotMatch(out.body + out.title, /403/);
});

test('setChannelUsers replaces the list and caps it at 50 people', async () => {
  const h = await createHarness({ loadApps: false, features: { channelUsers: true } });
  const out = await h.engine.yapin.setChannelUsers(G, [IDS.member, IDS.member2, IDS.member], { serverId: S });
  assert.equal(out.ok, true);
  assert.deepEqual(h.fake.channelById(G).user_ids, [IDS.member, IDS.member2]);
  const many = Array.from({ length: 51 }, (_, i) => `u${i}`);
  const big = await h.engine.yapin.setChannelUsers(G, many, { serverId: S });
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'too_many');
});

test('threads: create, list, edit and delete, with an off fallback and the rate limit explained', async () => {
  const off = await createHarness({ loadApps: false });
  const a = await off.engine.yapin.createThread(G, { name: 'Plans', content: 'Let us plan', serverId: S });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'off');
  assert.equal(off.engine.caps.state(S, 'threads'), false);
  const b = await off.engine.yapin.createThread(G, { name: 'Plans', content: 'again', serverId: S });
  assert.equal(b.reason, 'off');
  assert.equal(off.fake.callsTo('POST', /\/threads$/).length, 1, 'known off: no second call');

  const h = await createHarness({ loadApps: false, features: { threads: true } });
  const t = await h.engine.yapin.createThread(G, { name: 'Plans', content: 'Let us plan', serverId: S });
  assert.equal(t.ok, true);
  assert.equal(t.thread.name, 'Plans');
  const listed = await h.engine.yapin.listThreads(G, { serverId: S });
  assert.deepEqual(listed.threads.map((x) => x.id), [t.thread.id]);
  const e = await h.engine.yapin.editThread(t.thread.id, { locked: true, name: 'Locked plans' }, { serverId: S });
  assert.equal(e.thread.locked, true);
  assert.equal(e.thread.name, 'Locked plans');
  assert.equal((await h.engine.yapin.deleteThread(t.thread.id, { serverId: S })).ok, true);
  assert.equal((await h.engine.yapin.listThreads(G, { serverId: S })).threads.length, 0);

  h.fake.fail('POST', /\/threads$/, { status: 429, error: 'Too many threads', times: 1 });
  const limited = await h.engine.yapin.createThread(G, { name: 'More', content: 'x', serverId: S });
  assert.equal(limited.reason, 'limited');
  assert.match(limited.body, /10 new threads/);
  const empty = await h.engine.yapin.createThread(G, { name: '', content: 'x', serverId: S });
  assert.equal(empty.ok, false);
});

test('clearReactions clears all, one emoji, or one person, and explains protected messages', async () => {
  const h = await createHarness({ loadApps: false, features: { reactionClear: true } });
  const msg = h.fake.addUserMessage(G, IDS.member, 'react to me');
  const put = (emoji, user) => h.fake.state.reactions.push({ channel_id: G, message_id: msg.id, emoji, user_id: user });
  put('👍', IDS.member); put('👍', IDS.member2); put('🎉', IDS.member);
  const one = await h.engine.yapin.clearReactions(G, msg.id, { emoji: '👍', userId: IDS.member, serverId: S });
  assert.equal(one.ok, true);
  assert.equal(h.fake.state.reactions.filter((r) => r.message_id === msg.id).length, 2);
  await h.engine.yapin.clearReactions(G, msg.id, { emoji: '👍', serverId: S });
  assert.deepEqual(h.fake.state.reactions.filter((r) => r.message_id === msg.id).map((r) => r.emoji), ['🎉']);
  await h.engine.yapin.clearReactions(G, msg.id, { serverId: S });
  assert.equal(h.fake.state.reactions.filter((r) => r.message_id === msg.id).length, 0);
  assert.equal(h.engine.caps.state(S, 'reaction_clear'), true);

  h.fake.fail('DELETE', /\/reactions/, { status: 400, error: "Reactions on reaction role messages can't be cleared", times: 1 });
  const prot = await h.engine.yapin.clearReactions(G, msg.id, { serverId: S });
  assert.equal(prot.reason, 'protected');
  assert.match(prot.body, /reaction roles/);
  const noEmoji = await h.engine.yapin.clearReactions(G, msg.id, { userId: IDS.member, serverId: S });
  assert.equal(noEmoji.ok, false);
});

test('clearReactions marks the feature off when Yapin\' has no such route', async () => {
  const h = await createHarness({ loadApps: false });
  const msg = h.fake.addUserMessage(G, IDS.member, 'x');
  const out = await h.engine.yapin.clearReactions(G, msg.id, { serverId: S });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'missing');
  assert.equal(h.engine.caps.state(S, 'reaction_clear'), false);
  const again = await h.engine.yapin.clearReactions(G, msg.id, { serverId: S });
  assert.equal(again.reason, 'off');
});

test('clearReactions keeps calling while more is true and stays under 10 calls a minute', async () => {
  let t = 0;
  const waits = [];
  const paths = [];
  let left = 14;
  const bot = { api: async (m, p) => { paths.push(p); left--; return { removed: 100, more: left > 0 }; } };
  const caps = { state: () => null, mark: () => {} };
  const api = createYapinApi({ bot, caps, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  const out = await api.clearReactions('c1', 'm1', { emoji: '👍' });
  assert.equal(out.ok, true);
  assert.equal(out.rounds, 14);
  assert.equal(out.removed, 1400);
  assert.equal(out.more, false);
  assert.ok(paths.every((p) => p === '/channels/c1/messages/m1/reactions/%F0%9F%91%8D?all=true'));
  assert.equal(waits.length, 1, 'waited once after the 10th call');
  assert.equal(waits[0], 60_000);
});

test('memberCounts is live when it can be and falls back to the member list', async () => {
  const h = await createHarness({ loadApps: false });
  const live = await h.engine.yapin.memberCounts(S);
  assert.equal(live.live, true);
  assert.equal(live.member_count, h.fake.state.members[S].length);
  assert.equal(live.online_count, 3);

  const h2 = await createHarness({ loadApps: false });
  h2.fake.fail('GET', /\/counts$/, { status: 404, error: 'Not found' });
  const slow = await h2.engine.yapin.memberCounts(S);
  assert.equal(slow.live, false);
  assert.equal(slow.member_count, h2.fake.state.members[S].length);
  assert.equal(slow.online_count, null);
  assert.equal(h2.engine.caps.state(S, 'member_counts'), false);
  await h2.engine.yapin.memberCounts(S);
  assert.equal(h2.fake.callsTo('GET', /\/counts$/).length, 1);
});

test('permissionsOf returns null when the endpoint is off and the permissions when on', async () => {
  const off = await createHarness({ loadApps: false });
  assert.equal(await off.engine.yapin.permissionsOf(S, IDS.admin), null);
  assert.equal(off.engine.caps.state(S, 'permissions'), false);

  const h = await createHarness({ loadApps: false, features: { permissions: true } });
  const p = await h.engine.yapin.permissionsOf(S, IDS.admin);
  assert.equal(p.administrator, true);
  assert.equal(h.engine.caps.state(S, 'permissions'), true);
});

test('a click on someone else\'s ephemeral reply is refused before the handler runs', async () => {
  const h = await createHarness({ loadApps: false, features: { ephemeralButtons: true } });
  const seen = menuApp(h);
  const first = await h.click(customId('sys', 'eopen'), { user: IDS.member });
  const replyId = first[0].replyId;
  assert.equal(h.engine.ephemeralReplies.ownerOf(replyId), String(IDS.member));
  const other = await h.click(customId('sys', 'enext'), { user: IDS.member2, replyId });
  assert.equal(seen.length, 0, 'handler never ran for the other person');
  assert.match(JSON.stringify(other), /Not your panel/);
  await h.click(customId('sys', 'enext'), { user: IDS.member, replyId });
  assert.equal(seen.length, 1);
});

test('createPrivateChannel does not trust a private channel that lost its people list', async () => {
  const calls = [];
  const bot = {
    api: async (m, p, body) => {
      calls.push({ m, p, body });
      if (m === 'POST') return { channel: { id: 'c9', name: 'ticket', private: true, user_ids: [] } };
      if (m === 'PATCH') return { channel: { id: 'c9', private: true, user_ids: body.user_ids } };
      return {};
    },
    editChannel: async (id) => ({ id, private: true }),
  };
  const marks = {};
  const caps = { state: (sid, k) => marks[k] ?? null, mark: (sid, k, v) => { marks[k] = v; } };
  const api = createYapinApi({ bot, caps });
  const out = await api.createPrivateChannel(S, 'ticket', { roleIds: ['r1'], userIds: ['u1'] });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'edit');
  assert.ok(calls.some((c) => c.m === 'PATCH' && c.body.user_ids?.includes('u1')), 'the opener was put on the list');
});

test('createPrivateChannel deletes a channel it could not make private', async () => {
  const deleted = [];
  const bot = {
    api: async () => { throw Object.assign(new Error("This isn't on for this server yet"), { status: 403 }); },
    createChannel: async () => ({ id: 'pub1', name: 'ticket' }),
    editChannel: async () => { throw Object.assign(new Error('Missing permission'), { status: 403 }); },
    deleteChannel: async (id) => { deleted.push(id); },
  };
  const caps = { state: () => null, mark: () => {} };
  const out = await createYapinApi({ bot, caps }).createPrivateChannel(S, 'ticket', { roleIds: ['r1'] });
  assert.equal(out.ok, false);
  assert.deepEqual(deleted, ['pub1'], 'no public channel is left behind');
  assert.equal(out.channel, null);
});

test('createThread keeps under 10 new threads per 10 minutes per server without asking Yapin\'', async () => {
  let t = 0;
  const posts = [];
  const bot = { api: async (m, p) => { posts.push(p); return { thread: { id: `t${posts.length}` } }; } };
  const caps = { state: () => null, mark: () => {} };
  const api = createYapinApi({ bot, caps, now: () => t });
  for (let i = 0; i < 10; i++) assert.equal((await api.createThread('c1', { name: 'x', content: 'y', serverId: 's1' })).ok, true);
  const eleventh = await api.createThread('c1', { name: 'x', content: 'y', serverId: 's1' });
  assert.equal(eleventh.reason, 'limited');
  assert.match(eleventh.body, /10 new threads/);
  assert.equal(posts.length, 10);
  assert.equal((await api.createThread('c1', { name: 'x', content: 'y', serverId: 's2' })).ok, true, 'other servers are not affected');
  t = 10 * 60_000 + 1;
  assert.equal((await api.createThread('c1', { name: 'x', content: 'y', serverId: 's1' })).ok, true);
});

test('clearReactions with maxWaitMs 0 says it is limited instead of waiting', async () => {
  const waits = [];
  const bot = { api: async () => ({ removed: 1, more: false }) };
  const caps = { state: () => null, mark: () => {} };
  const api = createYapinApi({ bot, caps, now: () => 0, sleep: async (ms) => { waits.push(ms); } });
  for (let i = 0; i < 10; i++) assert.equal((await api.clearReactions('c', 'm', { maxWaitMs: 0 })).ok, true);
  const out = await api.clearReactions('c', 'm', { maxWaitMs: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'limited');
  assert.equal(waits.length, 0);
});
