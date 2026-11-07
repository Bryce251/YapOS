import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDuration, takeDuration, formatDuration, tokenize, normalizeName, fuzzyFind, didYouMean, resolveUser, resolveRole, resolveChannel, userId, authorName, fillTemplate, ordinal } from '../../engine/parse.js';
import { createMemoryStore, createJsonStore } from '../../engine/storage.js';
import { createBudget } from '../../engine/budget.js';
import { explain, friendly } from '../../engine/errors.js';
import { redact, loadConfig } from '../../engine/config.js';
import { customId, parseCustomId } from '../../engine/router.js';
import { detectChannels } from '../../engine/index.js';
import { createHarness, IDS, settle } from '../harness.js';

test('durations', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h30m'), 9_000_000);
  assert.equal(parseDuration('1d 12h'), 129_600_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('3 days'), 259_200_000);
  assert.equal(parseDuration('15'), 900_000);
  assert.equal(parseDuration('spam'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(parseDuration(''), null);
  const t = takeDuration(['2h', '30m', 'being', 'rude']);
  assert.equal(t.ms, 9_000_000);
  assert.deepEqual(t.rest, ['being', 'rude']);
  assert.equal(takeDuration(['spam']).ms, null);
  assert.equal(formatDuration(9_000_000), '2h 30m');
  assert.equal(formatDuration(45_000), '45s');
});

test('tokenize keeps quotes and mentions', () => {
  assert.deepEqual(tokenize('timeout <@abc-1> 10m "being very rude"'), ['timeout', '<@abc-1>', '10m', 'being very rude']);
  assert.deepEqual(tokenize(''), []);
});

test('names, fuzzy matching and did-you-mean', () => {
  assert.equal(normalizeName('👋・welcome-🎉'), 'welcome');
  assert.equal(normalizeName('📜┃Rules'), 'rules');
  const chans = [{ id: '1', name: 'general' }, { id: '2', name: '👋・welcome' }, { id: '3', name: 'mod-log' }];
  assert.equal(fuzzyFind('gen', chans).item.id, '1');
  assert.equal(fuzzyFind('welcome', chans).item.id, '2');
  assert.equal(fuzzyFind('modlog', chans)?.item.id, '3');
  assert.equal(fuzzyFind('zzzzzz', chans), null);
  assert.deepEqual(didYouMean('timout', ['timeout', 'kick', 'ban']), ['timeout']);
});

test('resolve users, roles, channels', () => {
  const members = [{ id: IDS.member, username: 'sam', display_name: 'Sam' }, { id: IDS.mod, username: 'morgan', display_name: 'Morgan', nickname: 'Mo' }];
  assert.equal(resolveUser(`<@${IDS.member}>`, members).id, IDS.member);
  assert.equal(resolveUser(`<@!${IDS.member}>`, members).id, IDS.member);
  assert.equal(resolveUser(IDS.mod, members).id, IDS.mod);
  assert.equal(resolveUser('@sam', members).id, IDS.member);
  assert.equal(resolveUser('morgn', members).id, IDS.mod);
  assert.equal(userId('hello'), null);
  const roles = [{ id: IDS.roles.mod, name: 'Moderator' }, { id: IDS.roles.vip, name: 'VIP' }];
  assert.equal(resolveRole('mods', roles)?.id, IDS.roles.mod);
  assert.equal(resolveRole(`<@&${IDS.roles.vip}>`, roles).id, IDS.roles.vip);
  assert.equal(resolveChannel('#gen', [{ id: 'g', name: 'general' }]).id, 'g');
});

test('author can be a string or an object', () => {
  assert.equal(authorName({ author: 'sam' }), 'sam');
  assert.equal(authorName({ author: { display_name: 'Sam', username: 'sam' } }), 'Sam');
  assert.equal(authorName({}), 'someone');
});

test('templates and ordinals', () => {
  assert.equal(fillTemplate('Hi {user}, you are {count} {missing}', { user: 'Sam', count: 5 }), 'Hi Sam, you are 5 {missing}');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
});

test('memory store returns copies', () => {
  const s = createMemoryStore();
  const v = s.set('x', 'a', { list: [1] });
  v.list.push(2);
  assert.deepEqual(s.get('x', 'a'), { list: [1] });
  s.update('x', 'a', (d) => { d.list.push(3); });
  assert.deepEqual(s.get('x', 'a').list, [1, 3]);
  assert.deepEqual(s.get('x', 'missing', { n: 0 }), { n: 0 });
  assert.throws(() => s.get('Bad NS!', 'a'));
});

test('json store writes atomically and reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-'));
  const a = createJsonStore({ dir, delay: 5 });
  a.set('mod', 'srv', { cases: [1, 2] });
  await a.flush();
  assert.ok(fs.existsSync(path.join(dir, 'mod.json')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  const b = createJsonStore({ dir });
  assert.deepEqual(b.get('mod', 'srv'), { cases: [1, 2] });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  const c = createJsonStore({ dir });
  assert.deepEqual(c.get('broken', 'k', 'fresh'), 'fresh');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('broken.json.broken-')));
});

test('budget keeps to 30 a minute per server and serves high priority first', async () => {
  let t = 0;
  const order = [];
  const bot = { send: async (cid, content) => { order.push(content); return { id: content }; } };
  const b = createBudget({ bot, now: () => t });
  const ps = [];
  for (let i = 0; i < 35; i++) ps.push(b.send({ serverId: 's', channelId: 'c', content: `low${i}`, priority: 'low' }));
  ps.push(b.send({ serverId: 's', channelId: 'c', content: 'urgent', priority: 'high' }));
  await settle();
  assert.equal(order.length, 24, 'low priority leaves 20% headroom');
  b._pump();
  await settle();
  assert.ok(order.includes('urgent'));
  assert.ok(order.length <= 30);
  t = 61_000;
  b._pump();
  await settle();
  assert.equal(order.length, 36);
});

test('budget coalesces sends with the same key', async () => {
  const sent = [];
  const b = createBudget({ bot: { send: async (c, content) => { sent.push(content); return { id: content }; } }, now: () => 0 });
  for (let i = 0; i < 31; i++) b.send({ serverId: 's', channelId: 'c', content: `fill${i}` });
  const first = b.send({ serverId: 's', channelId: 'c', content: 'count 1', key: 'counter' });
  const second = b.send({ serverId: 's', channelId: 'c', content: 'count 2', key: 'counter' });
  assert.equal(await first, null);
  assert.equal(b.stats.coalesced, 1);
  void second;
});

test('friendly errors never show raw codes', () => {
  const e403 = Object.assign(new Error('Missing permission'), { status: 403 });
  const x = explain(e403, { action: 'kick', perm: 'kick_members', target: '@sam' });
  assert.match(x.body, /Kick Members/);
  assert.match(x.body, /above @sam/);
  assert.doesNotMatch(x.title + x.body, /403/);
  const e429 = Object.assign(new Error('slow'), { status: 429, retryAfter: 7 });
  assert.match(explain(e429).body, /7 seconds/);
  assert.equal(explain(friendly('Nope.', { title: 'T' })).title, 'T');
});

test('tokens are redacted from logs', () => {
  assert.equal(redact('token yb_abc123.DEF-x here'), 'token yb_[hidden] here');
  assert.match(redact('POST /interactions/123/secrettok/callback'), /\/interactions\/123\/\[hidden\]/);
});

test('config prefers env over config.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'yb_fromfile', verified: true }));
  assert.equal(loadConfig({ root: dir, env: {} }).token, 'yb_fromfile');
  assert.equal(loadConfig({ root: dir, env: { YAPPER_BOT_TOKEN: 'yb_fromenv' } }).token, 'yb_fromenv');
  assert.equal(loadConfig({ root: dir, env: {} }).verified, true);
});

test('custom ids round-trip and stay under 100 chars', () => {
  const id = customId('mod', 'ban', 'abc', 'x:y');
  assert.deepEqual(parseCustomId(id), { app: 'mod', action: 'ban', args: ['abc', 'x_y'] });
  assert.equal(parseCustomId('vote:yes'), null);
  assert.throws(() => customId('a', 'b', 'x'.repeat(120)));
});

test('channel detection handles imported Discord names', () => {
  const found = detectChannels([
    { id: '1', name: '📜┃rules', type: 'text' }, { id: '2', name: '👋・welcome', type: 'text' },
    { id: '3', name: 'mod-log', type: 'text' }, { id: '4', name: 'general', type: 'text' }, { id: '5', name: 'welcome', type: 'voice' },
  ]);
  assert.equal(found.rules.id, '1');
  assert.equal(found.welcome.id, '2');
  assert.equal(found.logs.id, '3');
  assert.equal(found.general.id, '4');
});

test('permission levels from real roles', async () => {
  const h = await createHarness({ loadApps: false });
  const p = h.engine.perms;
  assert.equal(await p.level(IDS.server, IDS.owner), 'owner');
  assert.equal(await p.level(IDS.server, IDS.admin), 'admin');
  assert.equal(await p.level(IDS.server, IDS.mod), 'mod');
  assert.equal(await p.level(IDS.server, IDS.member), 'member');
  assert.equal((await p.canActOn(IDS.server, IDS.admin, { actorId: IDS.owner })).ok, false, 'admin role is above the bot');
  assert.equal((await p.canActOn(IDS.server, IDS.member, { actorId: IDS.mod })).ok, true);
  assert.equal((await p.canActOn(IDS.server, IDS.mod, { actorId: IDS.member })).ok, false);
  assert.equal((await p.canActOn(IDS.server, IDS.owner, { actorId: IDS.admin })).ok, false);
  assert.equal((await p.canManageRole(IDS.server, IDS.roles.gamer)).ok, true);
  assert.equal((await p.canManageRole(IDS.server, IDS.roles.admin)).ok, false);
  await assert.rejects(p.require(IDS.server, IDS.member, 'mod'), /Only moderators/);
});

test('the fake server takes file uploads like Yapin does', async () => {
  const h = await createHarness({ loadApps: false });
  await h.bot.send(IDS.channels.general, 'Here you go', { files: [{ name: 'transcript.txt', data: Buffer.from('hello world') }] });
  const m = h.lastSent(IDS.channels.general);
  assert.equal(m.files[0].name, 'transcript.txt');
  assert.equal(m.files[0].text, 'hello world');
  await assert.rejects(h.bot.send(IDS.channels.general, '', { files: [{ name: 'x.json', data: Buffer.from('{}') }] }), /isn't allowed/);
  h.fake.features.files = false;
  await assert.rejects(h.bot.send(IDS.channels.general, '', { files: [{ name: 'a.txt', data: Buffer.from('a') }] }), /testing/);
});

test('voice joins and leaves update who is in voice', async () => {
  const h = await createHarness({ loadApps: false });
  await h.voiceJoin(IDS.member);
  assert.deepEqual((await h.bot.voice(IDS.server))[0].user_ids, [IDS.member]);
  await h.voiceLeave(IDS.member);
  assert.deepEqual((await h.bot.voice(IDS.server))[0].user_ids, []);
});