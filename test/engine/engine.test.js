import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDuration, takeDuration, formatDuration, tokenize, normalizeName, fuzzyFind, didYouMean, resolveUser, resolveRole, resolveChannel, userId, authorName, fillTemplate, ordinal } from '../../engine/parse.js';
import { createBudget } from '../../engine/budget.js';
import { explain, friendly } from '../../engine/errors.js';
import { redact, loadConfig } from '../../engine/config.js';
import { customId, parseCustomId } from '../../engine/router.js';
import { detectChannels } from '../../engine/index.js';
import { teeConsoleToFile } from '../../engine/logfile.js';
import { row, button } from '../../engine/ui.js';
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
test('only one copy of the bot can hold the lock, and it frees when that copy stops', async () => {
  const { takeLock } = await import('../../engine/lock.js');
  const port = 47000 + (process.pid % 900);
  const first = await takeLock({ port });
  assert.equal(first.ok, true);
  const second = await takeLock({ port });
  assert.equal(second.ok, false, 'a second copy is refused');
  await first.release();
  const third = await takeLock({ port });
  assert.equal(third.ok, true, 'free again once the first copy is gone');
  await third.release();
});

test('a second bot.js exits straight away with code 3 and a plain message', async () => {
  const { spawnSync } = await import('node:child_process');
  const { takeLock } = await import('../../engine/lock.js');
  const port = 47000 + ((process.pid + 7) % 900);
  const held = await takeLock({ port });
  assert.equal(held.ok, true);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-lock-'));
  const run = spawnSync(process.execPath, ['bot.js'], { encoding: 'utf8', env: { ...process.env, YAPPER_BOT_TOKEN: 'yb_lock_test_only', YAPOS_LOCK_PORT: String(port), YAPOS_DATA_DIR: dataDir }, timeout: 20000 });
  await held.release();
  assert.equal(run.status, 3, run.stderr + run.stdout);
  assert.match(run.stdout + run.stderr, /already running/);
  const logFile = path.join(dataDir, 'logs', 'yapos.log');
  assert.ok(fs.existsSync(logFile), 'bot.js writes its output to data/logs/yapos.log');
  const logged = fs.readFileSync(logFile, 'utf8');
  assert.match(logged, /YapOS starting/);
  assert.match(logged, /already running/);
  assert.doesNotMatch(logged, /lock_test_only/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test('a panel locked to the bot is never locked', async () => {
  const h = await createHarness();
  const pressed = [];
  h.engine.router.register('sys', 'probe', async (ctx) => { pressed.push(ctx.userId); await ctx.ephemeral('probe ok'); });
  const probe = customId('sys', 'probe');
  const botMsg = 'b0000000-0000-4000-8000-0000000000b1';
  h.engine.router.claimPanel(botMsg, IDS.bot, 60_000);
  const byMember = await h.click(probe, { user: IDS.member, messageId: botMsg });
  assert.doesNotMatch(h.textOf(byMember[0]), /Not your panel/);
  assert.match(h.textOf(byMember[0]), /probe ok/);
  assert.deepEqual(pressed, [IDS.member]);

  const adminMsg = 'b0000000-0000-4000-8000-0000000000b2';
  h.engine.router.claimPanel(adminMsg, IDS.admin, 60_000);
  const locked = await h.click(probe, { user: IDS.member, messageId: adminMsg });
  assert.match(h.textOf(locked[0]), /Not your panel/);
  assert.deepEqual(pressed, [IDS.member]);
});

test('context code never locks a panel to the bot itself', async () => {
  const h = await createHarness();
  const claims = [];
  const real = h.engine.router.claimPanel;
  h.engine.router.claimPanel = (messageId, userId, ttl) => { claims.push(userId); return real(messageId, userId, ttl); };
  try {
    const comps = [row(button('Press', customId('sys', 'probe')))];
    for (const user of [IDS.bot, IDS.member]) {
      const source = { id: `m-${user}`, server_id: IDS.server, channel_id: IDS.channels.general, user_id: user, author_id: user, content: 'x' };
      const ctx = h.engine.contextFor(source, { kind: 'message' });
      await ctx.reply({ content: 'reply', components: comps });
      await ctx.panel({ content: 'panel', components: comps });
      await ctx.ephemeral({ content: 'ephemeral', components: comps });
    }
    await settle();
    assert.ok(!claims.includes(IDS.bot), 'no lock is ever taken for the bot');
    assert.ok(claims.length >= 3 && claims.every((u) => u === IDS.member), 'a person still gets their lock');
  } finally {
    h.engine.router.claimPanel = real;
  }
});

test('the bot owner is owner level everywhere and skips the role order as actor', async () => {
  const h = await createHarness({ loadApps: false });
  const p = h.engine.perms;
  assert.equal(await p.level(IDS.server, IDS.member2), 'member');
  assert.equal((await p.canActOn(IDS.server, IDS.mod, { actorId: IDS.member2 })).ok, false);
  h.engine.config.ownerId = IDS.member2;
  p.invalidate();
  assert.equal(h.engine.isBotOwner(IDS.member2), true);
  assert.equal(h.engine.isBotOwner(IDS.owner), false);
  assert.equal(await p.level(IDS.server, IDS.member2), 'owner', 'bot owner without owning the server');
  assert.equal(await p.isOwner(IDS.server, IDS.member2), true);
  assert.equal(await p.level(IDS.server, IDS.owner), 'owner', 'the server owner is still owner');
  assert.equal(await p.level(IDS.server, IDS.member), 'member');
  assert.equal((await p.canActOn(IDS.server, IDS.mod, { actorId: IDS.member2 })).ok, true, 'role order skipped for the bot owner');
  assert.equal((await p.canActOn(IDS.server, IDS.mod, { actorId: IDS.member })).ok, false, 'still enforced for everyone else');
  const owner = await p.canActOn(IDS.server, IDS.owner, { actorId: IDS.member2 });
  assert.equal(owner.ok, false);
  assert.match(owner.reason, /server owner/);
  assert.equal((await p.canActOn(IDS.server, IDS.admin, { actorId: IDS.member2 })).ok, false, 'roles above the bot stay out of reach');
  assert.equal((await p.canActOn(IDS.server, IDS.bot, { actorId: IDS.member2 })).ok, false);
  assert.equal((await p.canActOn(IDS.server, IDS.member2, { actorId: IDS.member2 })).ok, false);
});

test('the log file gets every console line, hides tokens and rolls over', () => {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapos-log-'));
  try {
    for (const m of ['log', 'info', 'warn', 'error']) console[m] = () => {};
    const file = teeConsoleToFile(dir, { maxBytes: 600 });
    assert.equal(file, path.join(dir, 'yapos.log'));
    console.log('hello from log');
    console.info('an info line');
    console.warn('careful %s', 'now');
    console.error('token yb_abcDEF123456.secret leaked');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /YapOS starting/);
    assert.match(text, /INFO\s+hello from log/);
    assert.match(text, /INFO\s+an info line/);
    assert.match(text, /WARN\s+careful now/);
    assert.match(text, /ERROR\s+token yb_\[hidden\] leaked/);
    assert.doesNotMatch(text, /abcDEF123456/);
    assert.ok(!fs.existsSync(path.join(dir, 'yapos.old.log')));
    for (let i = 0; i < 12; i++) console.log(`filler line number ${i} ${'x'.repeat(40)}`);
    const old = path.join(dir, 'yapos.old.log');
    assert.ok(fs.existsSync(old), 'rolled over to yapos.old.log');
    assert.ok(fs.statSync(file).size <= 600);
    assert.ok(fs.statSync(old).size <= 600);
    assert.match(fs.readFileSync(file, 'utf8'), /filler line number 10[^\n]*\n[^\n]*filler line number 11/, 'after rolling over, new lines keep collecting in yapos.log');
    assert.doesNotMatch(fs.readFileSync(old, 'utf8') + fs.readFileSync(file, 'utf8'), /abcDEF123456/);
  } finally {
    Object.assign(console, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(console.log, saved.log);
  assert.equal(console.error, saved.error);
});

test('the second admin is opt-in and is a real admin who does not own anything', async () => {
  const h = await createHarness();
  const count = h.fake.state.members[IDS.server].length;
  assert.equal(h.fake.memberOf(IDS.server, IDS.admin2), null, 'not there until a test asks');
  assert.equal(h.addSecondAdmin(), IDS.admin2);
  h.addSecondAdmin();
  assert.equal(h.fake.state.members[IDS.server].length, count + 1, 'added once');
  assert.ok((await h.engine.cache.members(IDS.server)).some((m) => m.id === IDS.admin2), 'the member cache sees them');
  assert.equal(await h.engine.perms.level(IDS.server, IDS.admin2), 'admin');
  assert.equal(await h.engine.perms.isOwner(IDS.server, IDS.admin2), false);
  assert.equal(h.engine.isBotOwner(IDS.admin2), false);
});
