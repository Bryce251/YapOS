import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS, settle } from '../harness.js';
import { createMessageCache, attachmentNames } from '../../engine/message-cache.js';

const S = IDS.server;
const G = IDS.channels.general;
const LOG = IDS.channels.modlog;
let evSeq = 900000;

const make = async ({ edits = false, deletes = false, channel = true } = {}) => {
  const h = await createHarness({ apps: ['mod'] });
  if (channel) h.engine.settings.patchCore(S, { logChannel: LOG });
  if (edits || deletes) h.engine.settings.patchApp(S, 'mod', { logEdits: edits, logDeletes: deletes });
  const svc = h.engine.service('mod').messageLogs;
  svc.setWindow(60_000);
  return { h, svc };
};

const fire = async (h, type, data) => {
  await h.bot.handle({ id: ++evSeq, type, data: { server_id: S, ...data }, created_at: new Date().toISOString() });
  await settle();
};

const logged = (h) => h.sent(LOG);
const logText = (h) => logged(h).map((m) => h.textOf(m)).join('\n---\n');
const flush = async (h, svc) => { await svc.flush(S); await settle(); };

test('cache keeps messages within count, per-channel and text limits', () => {
  let t = 0;
  const c = createMessageCache({ maxMessages: 5, perChannel: 3, maxChars: 10_000, now: () => t });
  const msg = (id, ch = 'c1', content = 'hi') => ({ id, channel_id: ch, server_id: 's', author_id: 'u', content });
  for (let i = 0; i < 4; i++) c.remember(msg(`a${i}`));
  assert.equal(c.get('a0'), null, 'per-channel cap drops the oldest in that channel');
  assert.ok(c.get('a3'));
  for (let i = 0; i < 4; i++) c.remember(msg(`b${i}`, `c${i + 2}`));
  assert.equal(c.stats().messages, 5);
  assert.equal(c.get('a1'), null, 'global cap drops the least recently used');

  const small = createMessageCache({ maxChars: 400, now: () => t });
  for (let i = 0; i < 10; i++) small.remember(msg(`x${i}`, 'c1', 'y'.repeat(100)));
  assert.ok(small.stats().chars <= 400);
  assert.ok(small.get('x9'));
  assert.equal(small.get('x0'), null);
});

test('cache entries expire after the TTL and edits refresh them', () => {
  let t = 0;
  const c = createMessageCache({ ttlMs: 1000, now: () => t });
  c.remember({ id: 'm1', channel_id: 'c', server_id: 's', author: { id: 'u', username: 'sam' }, content: 'one' });
  c.remember({ id: 'm2', channel_id: 'c', server_id: 's', author: 'riley', author_id: 'u2', content: 'two' });
  t = 800;
  const before = c.update('m1', 'one edited');
  assert.equal(before.content, 'one');
  assert.equal(before.authorName, 'sam');
  t = 1500;
  assert.equal(c.get('m2'), null, 'old entry expired');
  assert.equal(c.get('m1').content, 'one edited', 'edited entry was refreshed');
  c.prune();
  assert.equal(c.stats().messages, 1);
  t = 3000;
  assert.equal(c.take('m1'), null);
});

test('cache skips bots and webhooks, remembers bot ids, and clears per server', () => {
  const c = createMessageCache();
  assert.equal(c.remember({ id: 'b1', channel_id: 'c', server_id: 's', author_id: 'bot1', author_bot: true, content: 'x' }), null);
  assert.equal(c.remember({ id: 'w1', channel_id: 'c', server_id: 's', author_id: 'hook', webhook_id: 'h', content: 'x' }), null);
  assert.ok(c.isBot('bot1'));
  c.remember({ id: 'm1', channel_id: 'c', server_id: 's', author_id: 'u', content: 'a' });
  c.remember({ id: 'm2', channel_id: 'd', server_id: 's2', author_id: 'u', content: 'b' });
  c.clearServer('s');
  assert.equal(c.get('m1'), null);
  assert.ok(c.get('m2'));
  assert.deepEqual(attachmentNames({ attachments: [{ path: 'x/1/cat.png', name: 'cat.png' }], attachment: 'x/1/cat.png' }), ['cat.png']);
});

test('message logs are off by default and nothing is cached (privacy)', async () => {
  const { h, svc } = await make();
  const cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.logEdits, false);
  assert.equal(cfg.logDeletes, false);
  const m = await h.message('secret plans');
  assert.equal(svc.cache().stats().messages, 0, 'not cached while the feature is off');
  await fire(h, 'message_update', { id: m.id, channel_id: G, author_id: IDS.member, content: 'changed', edited_at: new Date().toISOString() });
  await fire(h, 'message_delete', { id: m.id, channel_id: G, author_id: IDS.member });
  assert.equal(svc.pending(S), 0);
  await flush(h, svc);
  assert.equal(logged(h).length, 0);
});

test('/mod log messages on turns both on, and the settings buttons toggle them', async () => {
  const { h } = await make();
  await h.slash('mod', 'log messages on', { user: IDS.admin });
  let cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.logEdits, true);
  assert.equal(cfg.logDeletes, true);
  await h.slash('mod', 'log edits off', { user: IDS.admin });
  cfg = h.engine.settings.appConfig(S, 'mod');
  assert.equal(cfg.logEdits, false);
  assert.equal(cfg.logDeletes, true);
  const ans = await h.slash('mod', 'settings', { user: IDS.admin });
  const btn = h.findButton('Log message edits', ans);
  assert.ok(btn, 'settings has an edits toggle');
  await h.click(btn.custom_id, { user: IDS.admin, messageId: btn.messageId });
  assert.equal(h.engine.settings.appConfig(S, 'mod').logEdits, true);
  const mod = await h.slash('mod', 'log messages on', { user: IDS.mod });
  assert.doesNotMatch(h.textOf(mod[mod.length - 1]), /Message logs on/);
});

test('settings say when Yapin has not sent any edit or delete events yet', async () => {
  const { h, svc } = await make({ edits: true, deletes: true });
  const ans = await h.slash('mod', 'log', { user: IDS.admin });
  assert.match(h.textOf(ans[ans.length - 1]), /hasn't sent any edit or delete events yet/);
  await fire(h, 'message_delete', { id: 'zzz', channel_id: G, author_id: IDS.member });
  assert.doesNotMatch(svc.status(S), /hasn't sent/);
  assert.match(svc.status(S), /Last edit or delete event/);
});

test('edit log shows before and after with a jump link', async () => {
  const { h, svc } = await make({ edits: true });
  const m = await h.message('hello wrld');
  await fire(h, 'message_update', { id: m.id, channel_id: G, author_id: IDS.member, content: 'hello world', edited_at: new Date().toISOString(), author_bot: false });
  assert.equal(svc.pending(S), 1);
  await flush(h, svc);
  const posts = logged(h);
  assert.equal(posts.length, 1);
  const text = logText(h);
  assert.match(text, /Message edited/);
  assert.match(text, /hello wrld/);
  assert.match(text, /hello world/);
  assert.match(text, new RegExp(`<@${IDS.member}>`));
  assert.match(text, new RegExp(`<#${G}>`));
  assert.match(posts[0].embeds[0].description, /Jump to message/);
});

test('edit of a message never seen says so, and unchanged text is skipped', async () => {
  const { h, svc } = await make({ edits: true });
  await fire(h, 'message_update', { id: 'unknown-1', channel_id: G, author_id: IDS.member, content: 'new text' });
  const m = await h.message('same');
  await fire(h, 'message_update', { id: m.id, channel_id: G, author_id: IDS.member, content: 'same' });
  assert.equal(svc.pending(S), 1);
  await flush(h, svc);
  assert.match(logText(h), /Not seen since the bot started/);
});

test('delete log shows cached text and files, or says it was not in memory', async () => {
  const { h, svc } = await make({ deletes: true });
  const m = await h.message('look at this', { attachment: 'up/1/cat.png' });
  await fire(h, 'message_delete', { id: m.id, channel_id: G, author_id: IDS.member });
  await flush(h, svc);
  let text = logText(h);
  assert.match(text, /Message deleted/);
  assert.match(text, /look at this/);
  assert.match(text, /cat\.png/);
  assert.equal(svc.cache().get(m.id), null, 'deleted message leaves the cache');

  await fire(h, 'message_delete', { id: 'gone-1', channel_id: G, author_id: IDS.member2 });
  await flush(h, svc);
  text = h.textOf(logged(h).at(-1));
  assert.match(text, /wasn't in memory/);
  assert.match(text, new RegExp(`<@${IDS.member2}>`));
});

test('a delete after an edit shows the latest text', async () => {
  const { h, svc } = await make({ edits: false, deletes: true });
  const m = await h.message('first');
  await fire(h, 'message_update', { id: m.id, channel_id: G, author_id: IDS.member, content: 'second' });
  await fire(h, 'message_delete', { id: m.id, channel_id: G, author_id: IDS.member });
  await flush(h, svc);
  assert.equal(logged(h).length, 1);
  assert.match(logText(h), /second/);
});

test('bulk deletes and bursts become one post', async () => {
  const { h, svc } = await make({ edits: true, deletes: true });
  const kept = [];
  for (let i = 0; i < 5; i++) kept.push((await h.message(`spam line ${i}`)).id);
  const ids = [...kept, ...Array.from({ length: 25 }, (_, i) => `x-${i}`)];
  await fire(h, 'message_delete_bulk', { ids, channel_id: G });
  await flush(h, svc);
  assert.equal(logged(h).length, 1, 'one summary for the bulk delete');
  let text = logText(h);
  assert.match(text, /30 messages deleted at once/);
  assert.match(text, /spam line 0/);
  assert.match(text, /25 weren't in memory/);

  for (let i = 0; i < 8; i++) await fire(h, 'message_delete', { id: `burst-${i}`, channel_id: G, author_id: IDS.member });
  await fire(h, 'message_update', { id: 'e-1', channel_id: G, author_id: IDS.member, content: 'edited' });
  assert.equal(svc.pending(S), 9);
  await flush(h, svc);
  assert.equal(logged(h).length, 2, 'the burst became a single post');
  text = h.textOf(logged(h).at(-1));
  assert.match(text, /1 edit, 8 deletes/);
});

test('bot messages, the bot itself and the log channel are ignored', async () => {
  const { h, svc } = await make({ edits: true, deletes: true });
  const b = await h.message('beep', { user: IDS.member2, authorBot: true });
  assert.equal(svc.cache().get(b.id), null);
  await fire(h, 'message_update', { id: b.id, channel_id: G, author_id: IDS.member2, content: 'boop', author_bot: true });
  await fire(h, 'message_delete', { id: b.id, channel_id: G, author_id: IDS.member2 });
  await fire(h, 'message_delete', { id: 'own', channel_id: G, author_id: IDS.bot });
  const inLog = await h.message('talking in the log', { channel: LOG });
  assert.equal(svc.cache().get(inLog.id), null);
  await fire(h, 'message_update', { id: inLog.id, channel_id: LOG, author_id: IDS.member, content: 'x' });
  await fire(h, 'message_delete', { id: inLog.id, channel_id: LOG, author_id: IDS.member });
  await fire(h, 'message_delete_bulk', { ids: ['a', 'b'], channel_id: LOG });
  const otherBot = 'b0000000-0000-4000-8000-0000000000aa';
  h.fake.state.members[S].push({ id: otherBot, username: 'helperbot', display_name: 'HelperBot', nickname: null, roles: [], joined_at: '2026-01-08T00:00:00Z', bot: true });
  h.engine.cache.invalidate(S);
  await fire(h, 'message_delete', { id: 'from-bot', channel_id: G, author_id: otherBot });
  assert.equal(svc.pending(S), 0);
});

test('without a log channel nothing is cached or queued', async () => {
  const { h, svc } = await make({ edits: true, deletes: true, channel: false });
  const m = await h.message('hi');
  assert.equal(svc.cache().get(m.id), null);
  await fire(h, 'message_delete', { id: m.id, channel_id: G, author_id: IDS.member });
  assert.equal(svc.pending(S), 0);
  assert.match(svc.status(S), /Pick a log channel first/);
});

test('turning logs off, uninstalling Mod or leaving the server clears memory', async () => {
  const { h, svc } = await make({ deletes: true });
  const m1 = await h.message('one');
  assert.ok(svc.cache().get(m1.id));
  await h.slash('mod', 'log deletes off', { user: IDS.admin });
  assert.equal(svc.cache().get(m1.id), null);

  await h.slash('mod', 'log deletes on', { user: IDS.admin });
  const m2 = await h.message('two');
  assert.ok(svc.cache().get(m2.id));
  await fire(h, 'server_remove', {});
  assert.equal(svc.cache().get(m2.id), null);

  const m3 = await h.message('three');
  assert.ok(svc.cache().get(m3.id));
  h.engine.settings.setEnabled(S, 'mod', false);
  await settle();
  assert.equal(svc.cache().get(m3.id), null);
});

test('queued logs post by themselves after the window', async () => {
  const { h, svc } = await make({ deletes: true });
  svc.setWindow(20);
  await fire(h, 'message_delete', { id: 'auto-1', channel_id: G, author_id: IDS.member });
  await new Promise((r) => setTimeout(r, 60));
  await settle();
  assert.equal(svc.pending(S), 0);
  assert.equal(logged(h).length, 1);
});

test('logged message text cannot ping anyone', async () => {
  const { h, svc } = await make({ edits: true, deletes: true });
  const m = await h.message(`hey @everyone and @here and <@${IDS.admin}> and <@&${IDS.roles.mod}>`);
  await fire(h, 'message_update', { id: m.id, channel_id: G, author_id: IDS.member, content: 'now @everyone again', edited_at: new Date().toISOString() });
  await fire(h, 'message_delete', { id: m.id, channel_id: G, author_id: IDS.member });
  await flush(h, svc);
  const text = logText(h);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /@everyone|@here/);
  assert.doesNotMatch(text, new RegExp(`<@${IDS.admin}>`));
  assert.doesNotMatch(text, new RegExp(`<@&${IDS.roles.mod}>`));
  for (const msg of logged(h)) assert.ok(!/@everyone|@here/.test(String(msg.content || '')));
});

test('turning logs off outside the bot (dashboard) drops what was cached on the next message', async () => {
  const { h, svc } = await make({ edits: true, deletes: true });
  await h.message('remember me');
  assert.equal(svc.cache().stats().messages, 1);
  h.engine.settings.patchApp(S, 'mod', { logEdits: false, logDeletes: false });
  await h.message('do not remember me');
  assert.equal(svc.cache().stats().messages, 0);
});

test('message log posts keep a gap so they never flood the channel budget', async () => {
  const { h, svc } = await make({ deletes: true });
  svc.setWindow(10);
  const a = await h.message('one');
  await fire(h, 'message_delete', { id: a.id, channel_id: G, author_id: IDS.member });
  await flush(h, svc);
  assert.equal(logged(h).length, 1);
  const b = await h.message('two');
  await fire(h, 'message_delete', { id: b.id, channel_id: G, author_id: IDS.member });
  await new Promise((r) => setTimeout(r, 80));
  await settle();
  assert.equal(svc.pending(S), 1, 'the second batch waits for the gap instead of posting at once');
  await flush(h, svc);
  assert.equal(logged(h).length, 2);
});
