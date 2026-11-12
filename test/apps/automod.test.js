import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createMemoryStore } from '../../engine/storage.js';
import { findBadWord, normalizeWord, cleanDomain } from '../../apps/automod.js';

const C = IDS.channels;

function modStub() {
  const calls = [];
  return {
    calls,
    async warn(sid, targetId, opts) { calls.push({ fn: 'warn', sid, targetId, ...opts }); return { case: { id: calls.length }, count: calls.filter((c) => c.fn === 'warn').length, escalated: null }; },
    async timeout(sid, targetId, opts) { calls.push({ fn: 'timeout', sid, targetId, ...opts }); return { id: calls.length }; },
    async addCase(sid, c) { calls.push({ fn: 'addCase', sid, ...c }); return { id: calls.length }; },
    async log(sid, embed) { calls.push({ fn: 'log', sid, embed }); },
  };
}

async function setup({ mod = true, features, store } = {}) {
  const h = await createHarness({ apps: ['automod'], features, ...(store ? { store } : {}) });
  const stub = mod ? modStub() : null;
  if (stub) h.engine.services.set('mod', stub);
  return { h, stub };
}

const notices = (h, cid = C.general) => h.sent(cid).filter((m) => m.content.startsWith(`<@${IDS.member}>,`));
const isDeleted = (h, cid, id) => h.fake.state.messages[cid].find((m) => m.id === id)?.deleted === true;
const config = (h) => h.engine.settings.appConfig(IDS.server, 'automod');

test('loads with one command and the right defaults', async () => {
  const { h } = await setup();
  assert.ok(h.bot.commands.has('automod'));
  const cfg = config(h);
  assert.deepEqual(cfg.filters, { spam: true, mentions: true, caps: false, links: false, invites: true, words: true, raid: false });
  assert.deepEqual(cfg.words.list, []);
});

test('flood triggers delete, notice and a timeout strike', async () => {
  const { h, stub } = await setup();
  const sent = [];
  for (let i = 0; i < 7; i++) sent.push(await h.message(`message number ${i}`));
  for (const m of sent) assert.ok(isDeleted(h, C.general, m.id), 'burst deleted');
  assert.equal(notices(h).length, 1);
  assert.match(notices(h)[0].content, /slow down/);
  const t = stub.calls.find((c) => c.fn === 'timeout');
  assert.ok(t, 'timed out through mod');
  assert.equal(t.targetId, IDS.member);
  assert.equal(t.source, 'automod');
  assert.equal(t.actorId, IDS.bot);
  assert.ok(stub.calls.some((c) => c.fn === 'log'));
});

test('six messages are fine', async () => {
  const { h, stub } = await setup();
  for (let i = 0; i < 6; i++) await h.message(`chat ${i}`);
  assert.equal(notices(h).length, 0);
  assert.equal(stub.calls.length, 0);
});

test('duplicate spam is caught and warned', async () => {
  const { h, stub } = await setup();
  const a = await h.message('buy my stuff');
  await h.message('buy my stuff');
  const c = await h.message('Buy my  stuff');
  assert.ok(isDeleted(h, C.general, a.id));
  assert.ok(isDeleted(h, C.general, c.id));
  assert.match(notices(h)[0].content, /repeat/);
  assert.ok(stub.calls.some((x) => x.fn === 'warn' && /Repeating/.test(x.reason)));
});

test('mass mentions and @everyone attempts are filtered', async () => {
  const { h, stub } = await setup();
  const ids = ['a0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000013'];
  const many = await h.message(`hi <@${IDS.owner}> <@${IDS.admin}> <@${IDS.mod}> <@${IDS.member2}> ${ids.map((i) => `<@${i}>`).join(' ')}`);
  assert.ok(isDeleted(h, C.general, many.id));
  assert.match(notices(h)[0].content, /mass-mention/);
  const few = await h.message(`hey <@${IDS.member2}> and <@${IDS.mod}>`);
  assert.ok(!isDeleted(h, C.general, few.id));
  const all = await h.message('@everyone look at this', { user: IDS.member2 });
  assert.ok(isDeleted(h, C.general, all.id));
  assert.ok(stub.calls.some((x) => x.fn === 'warn' && x.targetId === IDS.member2 && /everyone/.test(x.reason)));
});

test('invites are filtered but allowlisted links pass', async () => {
  const { h } = await setup();
  await h.slash('automod', 'links allow example.com', { user: IDS.admin });
  await h.slash('automod', 'links on', { user: IDS.admin });
  assert.deepEqual(config(h).links.allow, ['example.com']);
  assert.equal(config(h).filters.links, true);
  const ok = await h.message('look https://docs.example.com/page');
  assert.ok(!isDeleted(h, C.general, ok.id));
  const inv = await h.message('join us discord.gg/abc123');
  assert.ok(isDeleted(h, C.general, inv.id));
  const yinv = await h.message('come over https://yapin.gg/invite/xyz', { user: IDS.member2 });
  assert.ok(isDeleted(h, C.general, yinv.id));
  const bad = await h.message('free stuff https://evil.test/x', { user: IDS.member2 });
  assert.ok(isDeleted(h, C.general, bad.id));
});

test('links are not filtered by default', async () => {
  const { h } = await setup();
  const m = await h.message('see https://anything.org');
  assert.ok(!isDeleted(h, C.general, m.id));
});

test('leetspeak words are caught, Scunthorpe safe', async () => {
  const { h } = await setup();
  const ans = await h.slash('automod', 'words add ass, badword', { user: IDS.admin });
  assert.match(h.textOf(ans[0]), /Added 2 words/);
  const safe = await h.message('my class has a cool assistant, as usual');
  assert.ok(!isDeleted(h, C.general, safe.id));
  const leet = await h.message('you are an @$$');
  assert.ok(isDeleted(h, C.general, leet.id));
  const stretched = await h.message('B4DDDW0RRD!!', { user: IDS.member2 });
  assert.ok(isDeleted(h, C.general, stretched.id));
});

test('word normalizer handles separators and repeats', () => {
  assert.equal(normalizeWord('B@D'), 'bad');
  assert.equal(findBadWord('b.a.d.w.o.r.d', ['badword']), 'badword');
  assert.equal(findBadWord('b a d w o r d', ['badword']), 'badword');
  assert.equal(findBadWord('a55', ['ass']), 'ass');
  assert.equal(findBadWord('aaasssss', ['ass']), 'ass');
  assert.equal(findBadWord('class', ['ass']), null);
  assert.equal(findBadWord('as', ['ass']), null);
  assert.equal(findBadWord('Scunthorpe', ['cunt']), null);
  assert.equal(findBadWord('nothing here', []), null);
  assert.equal(cleanDomain('https://www.Example.com/x'), 'example.com');
  assert.equal(cleanDomain('nope'), null);
});

test('mods, admins, the owner and exempt channels or roles are never filtered', async () => {
  const { h, stub } = await setup();
  for (const user of [IDS.mod, IDS.admin, IDS.owner]) {
    const m = await h.message('@everyone big news', { user });
    assert.ok(!isDeleted(h, C.general, m.id));
  }
  await h.slash('automod', `exempt <#${C.news}>`, { user: IDS.admin });
  const inNews = await h.message('@everyone hi', { channel: C.news });
  assert.ok(!isDeleted(h, C.news, inNews.id));
  await h.slash('automod', `exempt <@&${IDS.roles.member}>`, { user: IDS.admin });
  const asMember = await h.message('@everyone again');
  assert.ok(!isDeleted(h, C.general, asMember.id));
  assert.equal(stub.calls.length, 0);
  await h.slash('automod', `unexempt <@&${IDS.roles.member}>`, { user: IDS.admin });
  assert.deepEqual(config(h).exempt.roles, []);
});

test('notices are rate limited to one per user per 30 seconds', async () => {
  const { h } = await setup();
  await h.slash('automod', 'words add badword', { user: IDS.admin });
  await h.message('badword');
  await h.message('@everyone');
  await h.message('badword again');
  assert.equal(notices(h).length, 1);
});

test('caps filter only when on and for long messages', async () => {
  const { h } = await setup();
  const off = await h.message('THIS IS VERY LOUD TEXT');
  assert.ok(!isDeleted(h, C.general, off.id));
  await h.slash('automod', 'caps on', { user: IDS.admin });
  const short = await h.message('OMG YES', { user: IDS.member2 });
  assert.ok(!isDeleted(h, C.general, short.id));
  const loud = await h.message('THIS IS VERY LOUD TEXT');
  assert.ok(isDeleted(h, C.general, loud.id));
});

test('works without the mod app, just logs', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', 'words add badword', { user: IDS.admin });
  const m = await h.message('such a badword');
  assert.ok(isDeleted(h, C.general, m.id));
  const log = h.lastSent(C.modlog);
  assert.ok(log, 'posted in the log channel');
  assert.match(h.textOf(log), /Logged only/);
});

test('missing Manage Messages warns admins once and skips deleting', async () => {
  const { h } = await setup({ mod: false });
  const botRole = h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.bot);
  delete botRole.perms.manage_messages;
  await h.slash('automod', 'words add badword', { user: IDS.admin });
  const a = await h.message('badword');
  const b = await h.message('badword', { user: IDS.member2 });
  assert.ok(!isDeleted(h, C.general, a.id));
  assert.ok(!isDeleted(h, C.general, b.id));
  const warns = h.sent(C.modlog).filter((m) => /can't delete messages/.test(h.textOf(m)));
  assert.equal(warns.length, 1);
  assert.equal(h.fake.callsTo('DELETE', /messages\//).length, 0);
});

test('raid triggers lockdown and Lift restores it', async () => {
  const { h, stub } = await setup();
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 9; i++) await h.join(`a0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, { username: `raider${i}` });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  const alert = h.lastSent(C.modlog);
  assert.match(h.textOf(alert), /Lockdown on/);
  const denied = await h.clickButton('Lift lockdown', { user: IDS.member });
  assert.match(h.textOf(denied[0]), /Only moderators/);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  const ans = await h.clickButton('Lift lockdown', { user: IDS.mod });
  assert.equal(ans[0].type, 'update');
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
  assert.ok(stub.calls.some((c) => c.fn === 'log' && /Lockdown lifted/.test(c.embed.title)));
});

test('eight joins do not trip the raid shield, and it is off by default', async () => {
  const { h } = await setup();
  for (let i = 0; i < 12; i++) await h.join(`a0000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 8; i++) await h.join(`a0000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('lockdown falls back to the general channel when setEveryonePerms 403s', async () => {
  const { h } = await setup();
  h.fake.fail('PATCH', /roles\/everyone/, { status: 403, error: 'Role management is in testing (flag bot_roles)' });
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 9; i++) await h.join(`a0000000-0000-4000-8000-0000000004${String(i).padStart(2, '0')}`);
  assert.deepEqual(h.fake.state.overrides[`${C.general}:everyone`], { allow: [], deny: ['send_messages'] });
  assert.match(h.textOf(h.lastSent(C.modlog)), /locked/);
  await h.clickButton('Lift lockdown', { user: IDS.mod });
  assert.equal(h.fake.state.overrides[`${C.general}:everyone`], undefined);
});

test('when both lock methods fail, mods get a clear alert', async () => {
  const { h } = await setup();
  h.fake.fail('PATCH', /roles\/everyone/, { status: 403 });
  h.fake.fail('PUT', /permissions/, { status: 403 });
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 9; i++) await h.join(`a0000000-0000-4000-8000-0000000005${String(i).padStart(2, '0')}`);
  const alert = h.lastSent(C.modlog);
  assert.match(h.textOf(alert), /could not lock/);
  assert.match(h.textOf(alert), /by hand/);
});

test('lockdown lifts by itself after the timer', async () => {
  const { h } = await setup();
  h.engine.settings.patchApp(IDS.server, 'automod', { raid: { joins: 2, seconds: 20, autoLiftMinutes: 0.01 } });
  await h.slash('automod', 'raid on', { user: IDS.admin });
  for (let i = 0; i < 3; i++) await h.join(`a0000000-0000-4000-8000-0000000006${String(i).padStart(2, '0')}`);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  await new Promise((r) => setTimeout(r, 900));
  await h.settle();
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('manual lockdown and lift by mods', async () => {
  const { h } = await setup();
  const no = await h.slash('automod', 'lockdown', { user: IDS.member });
  assert.match(h.textOf(no[0]), /Only moderators/);
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  const ans = await h.slash('automod', 'lift', { user: IDS.mod });
  assert.match(h.textOf(ans[0]), /lifted/);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('verify button grants the role', async () => {
  const { h } = await setup();
  const ans = await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  assert.match(h.textOf(ans[0]), /Verification is on/);
  const panel = h.lastSent(C.welcome);
  assert.match(h.textOf(panel), /Verify/);
  const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(h.textOf(got[0]), /verified/);
  assert.ok(h.fake.memberOf(IDS.server, IDS.member2).roles.includes(IDS.roles.vip));
  const again = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(h.textOf(again[0]), /already verified/);
});

test('verify refuses roles above the bot and reports role API failures', async () => {
  const { h, stub } = await setup();
  h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.gamer).position = 8;
  h.engine.perms.invalidate();
  const high = await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.gamer}>`, { user: IDS.admin });
  assert.match(h.textOf(high[0]), /can't hand out/);
  const admin = await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.admin}>`, { user: IDS.admin });
  assert.match(h.textOf(admin[0]), /too powerful/);
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  h.fake.fail('PUT', /\/roles\//, { status: 403, error: 'Role management is in testing (flag bot_roles)' });
  const got = await h.clickButton('Verify', { user: IDS.member2, in: h.lastSent(C.welcome) });
  assert.match(h.textOf(got[0]), /couldn't verify you/);
  assert.ok(stub.calls.some((c) => c.fn === 'log' && /Verification failed/.test(c.embed.title)));
});

test('panel: mods can view, admins toggle, select fallback to buttons', async () => {
  const { h } = await setup({ features: { selects: false } });
  const member = await h.slash('automod', '', { user: IDS.member });
  assert.match(h.textOf(member[0]), /Only moderators/);
  const asMod = await h.slash('automod', '', { user: IDS.mod });
  const last = asMod[asMod.length - 1];
  assert.match(h.textOf(last), /Automod/);
  assert.match(h.textOf(last), /Only admins/);
  assert.ok(!JSON.stringify(last.components).includes('"select"'));
  const asAdmin = await h.slash('automod', '', { user: IDS.admin });
  const panel = asAdmin[asAdmin.length - 1];
  const toggle = h.findButton('Caps lock', panel);
  const modClick = await h.click(toggle.custom_id, { user: IDS.mod });
  assert.match(h.textOf(modClick[0]), /Only admins/);
  await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.equal(config(h).filters.caps, true);
  const strict = h.findButton('Strict', panel);
  await h.click(strict.custom_id, { user: IDS.admin, messageId: strict.messageId });
  assert.equal(config(h).strictness, 'strict');
});

test('strictness select works when selects are on', async () => {
  const { h } = await setup();
  const ans = await h.slash('automod', '', { user: IDS.admin });
  const sel = h.allButtons(ans).find((b) => b.isSelect);
  assert.ok(sel);
  await h.pick(sel.custom_id, ['relaxed'], { user: IDS.admin });
  assert.equal(config(h).strictness, 'relaxed');
});

test('config changes have Undo and typos get suggestions', async () => {
  const { h } = await setup();
  await h.slash('automod', 'words add one, two', { user: IDS.admin });
  const cleared = await h.slash('automod', 'words clear', { user: IDS.admin });
  assert.deepEqual(config(h).words.list, []);
  const undo = h.findButton('Undo', cleared);
  await h.click(undo.custom_id, { user: IDS.admin });
  assert.deepEqual(config(h).words.list, ['one', 'two']);
  const typo = await h.slash('automod', 'wrds', { user: IDS.admin });
  assert.match(h.textOf(typo[0]), /Did you mean/);
  const notAdmin = await h.slash('automod', 'raid on', { user: IDS.mod });
  assert.match(h.textOf(notAdmin[0]), /Only admins/);
});

test('typed chat command works', async () => {
  const { h } = await setup();
  await h.message('/automod words add typedword', { user: IDS.admin });
  assert.deepEqual(config(h).words.list, ['typedword']);
});

test('presets apply and return a summary line', async () => {
  const { h } = await setup();
  const a = h.engine.apps.get('automod');
  const line = await a.def.applyPreset(h.engine, IDS.server, { preset: 'community', channels: {} });
  assert.match(line, /raid/);
  assert.equal(config(h).filters.raid, true);
  assert.equal(config(h).filters.caps, true);
  await a.def.applyPreset(h.engine, IDS.server, { preset: 'roleplay', channels: {} });
  assert.equal(config(h).filters.invites, false);
  assert.equal(config(h).filters.spam, true);
  for (const p of ['gaming', 'friends', 'study', 'community', 'roleplay']) assert.ok(a.def.presets[p]);
});

test('yap words route to automod', async () => {
  const { h } = await setup();
  for (const w of ['automod', 'filter', 'raid', 'lockdown']) assert.equal(h.engine.yap.find(w)?.app, 'automod');
  await h.slash('yap', 'filter add yapword', { user: IDS.admin });
  assert.deepEqual(config(h).words.list, ['yapword']);
  await h.slash('yap', 'lockdown', { user: IDS.mod });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  await h.slash('yap', 'lockdown off', { user: IDS.mod });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('bots and the bot itself are ignored', async () => {
  const { h, stub } = await setup();
  await h.slash('automod', 'words add badword', { user: IDS.admin });
  await h.message('badword', { authorBot: true });
  await h.message('badword', { user: IDS.bot });
  assert.equal(stub.calls.length, 0);
});

test('a long flood keeps deleting every new message', async () => {
  const { h } = await setup();
  const sent = [];
  for (let i = 0; i < 16; i++) sent.push(await h.message(`fast message ${i}`));
  for (const m of sent) assert.ok(isDeleted(h, C.general, m.id), `message ${m.content} deleted`);
  assert.equal(notices(h).length, 1);
});

test('email addresses are not treated as @here pings', async () => {
  const { h } = await setup();
  const mail = await h.message('mail me at sam@here.com or sam@everyone.org');
  assert.ok(!isDeleted(h, C.general, mail.id));
  const ping = await h.message('hey @here, look', { user: IDS.member2 });
  assert.ok(isDeleted(h, C.general, ping.id));
});

test('a failed lift alerts mods once and retries instead of spamming the log', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  h.fake.fail('PATCH', /roles\/everyone/, { status: 403 });
  h.engine.store.update('automod', IDS.server, (d) => { d.lockdown.until = Date.now() - 1000; }, {});
  for (let i = 0; i < 4; i++) await h.message(`hello ${i}`, { user: IDS.mod });
  const alerts = h.sent(C.modlog).filter((m) => /couldn't lift the lockdown/.test(h.textOf(m)));
  assert.equal(alerts.length, 1);
  assert.equal(h.fake.callsTo('PATCH', /roles\/everyone/).length, 2);
  assert.ok(h.engine.store.get('automod', IDS.server, {}).lockdown.until > Date.now());
  h.fake.clearFailures();
  const ans = await h.slash('automod', 'lift', { user: IDS.mod });
  assert.match(h.textOf(ans[0]), /lifted/);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('a lockdown saved before a restart is lifted once it is due', async () => {
  const store = createMemoryStore({ automod: { [IDS.server]: { lockdown: { mode: 'everyone', prior: true, at: Date.now() - 60_000, until: Date.now() - 1000, reason: 'raid', by: null } } } });
  const { h } = await setup({ store, mod: false });
  h.fake.state.everyone[IDS.server].send_messages = false;
  await h.join('a0000000-0000-4000-8000-000000000701');
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
  assert.equal(h.engine.store.get('automod', IDS.server, {}).lockdown, undefined);
  assert.ok(h.sent(C.modlog).some((m) => /Lockdown lifted/.test(h.textOf(m))));
});

test('two lockdowns at once only lock once and keep the real prior state', async () => {
  const { h } = await setup({ mod: false });
  const svc = h.engine.service('automod');
  const [a, b] = await Promise.all([svc.lockdown(IDS.server, { reason: 'manual', by: IDS.mod }), svc.lockdown(IDS.server, { reason: 'manual', by: IDS.mod })]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal(h.sent(C.modlog).filter((m) => /Lockdown on/.test(h.textOf(m))).length, 1);
  await svc.lift(IDS.server, { by: IDS.mod });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('lifting from the alert keeps the alert text for the record', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  const alert = h.lastSent(C.modlog);
  const ans = await h.clickButton('Lift lockdown', { user: IDS.mod, in: alert });
  assert.equal(ans[0].type, 'update');
  assert.equal(ans[0].embeds, undefined);
  const stored = h.fake.state.messages[C.modlog].find((m) => m.id === alert.id);
  assert.match(h.textOf(stored), /Lockdown on/);
  assert.match(stored.content, /lifting the lockdown/);
  assert.deepEqual(stored.components, []);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('verify setup refuses powerful roles and unknown channels', async () => {
  const { h } = await setup();
  const modRole = await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.mod}>`, { user: IDS.admin });
  assert.match(h.textOf(modRole[0]), /too powerful/);
  assert.equal(config(h).verify.enabled, false);
  const typo = await h.slash('automod', `verify setup #nope-channel <@&${IDS.roles.vip}>`, { user: IDS.admin });
  assert.match(h.textOf(typo[0]), /couldn't find/);
  assert.equal(config(h).verify.enabled, false);
});

test('verify button will not hand out a role that became powerful', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.vip).perms.ban_members = true;
  h.engine.perms.invalidate();
  const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(h.textOf(got[0]), /can't verify you/);
  assert.ok(!h.fake.memberOf(IDS.server, IDS.member2).roles.includes(IDS.roles.vip));
  assert.ok(h.sent(C.modlog).some((m) => /Verification paused/.test(h.textOf(m))));
});

test('settings panel buttons are locked to the admin who opened it', async () => {
  const { h } = await setup({ features: { selects: false } });
  h.addSecondAdmin();
  const opened = await h.slash('automod', '', { user: IDS.admin });
  const panel = opened[opened.length - 1];
  for (const label of ['Caps lock', 'Strict', 'Refresh']) {
    const b = h.findButton(label, panel);
    assert.ok(b.messageId, 'panel message id known');
    for (const user of [IDS.member, IDS.mod, IDS.admin2]) {
      const ans = await h.click(b.custom_id, { user, messageId: b.messageId });
      assert.match(h.textOf(ans[0]), /Not your panel/);
    }
  }
  assert.equal(config(h).filters.caps, false);
  assert.equal(config(h).strictness, 'normal');
  const byOwner = await h.click(h.findButton('Refresh', panel).custom_id, { user: IDS.owner, messageId: panel.message.id });
  assert.doesNotMatch(h.textOf(byOwner[0]), /Not your panel/);
  await h.click(h.findButton('Caps lock', panel).custom_id, { user: IDS.admin, messageId: panel.message.id });
  assert.equal(config(h).filters.caps, true);
});

test('forged or leftover settings buttons are refused by role', async () => {
  const { h } = await setup({ features: { selects: false } });
  const opened = await h.slash('automod', '', { user: IDS.admin });
  const panel = opened[opened.length - 1];
  const toggle = h.findButton('Caps lock', panel);
  const strict = h.findButton('Strict', panel);
  const refresh = h.findButton('Refresh', panel);
  for (const user of [IDS.member, IDS.mod]) {
    assert.match(h.textOf((await h.click(toggle.custom_id, { user }))[0]), /Only admins/);
    assert.match(h.textOf((await h.click(strict.custom_id, { user }))[0]), /Only admins/);
    assert.match(h.textOf((await h.pick('yo:automod:strictpick', ['strict'], { user }))[0]), /Only admins/);
  }
  const peek = await h.click(refresh.custom_id, { user: IDS.member });
  assert.match(h.textOf(peek[0]), /Only moderators/);
  assert.doesNotMatch(h.textOf(peek[0]), /Strictness/);
  assert.match(h.textOf((await h.click('yo:automod:lift', { user: IDS.member }))[0]), /Only moderators/);
  assert.equal(config(h).filters.caps, false);
  assert.equal(config(h).strictness, 'normal');
});

test('strictness select is locked to the opener and refused by role when forged', async () => {
  const { h } = await setup();
  const opened = await h.slash('automod', '', { user: IDS.admin });
  const panel = opened[opened.length - 1];
  const sel = h.allButtons(opened).find((b) => b.isSelect);
  h.addSecondAdmin();
  const other = await h.pick(sel.custom_id, ['strict'], { user: IDS.admin2, messageId: panel.message.id });
  assert.match(h.textOf(other[0]), /Not your panel/);
  const forged = await h.pick(sel.custom_id, ['strict'], { user: IDS.member });
  assert.match(h.textOf(forged[0]), /Only admins/);
  assert.equal(config(h).strictness, 'normal');
  const byOwner = await h.pick(sel.custom_id, ['relaxed'], { user: IDS.owner, messageId: panel.message.id });
  assert.doesNotMatch(h.textOf(byOwner[0]), /Not your panel/);
  assert.equal(config(h).strictness, 'relaxed');
  await h.pick(sel.custom_id, ['strict'], { user: IDS.admin, messageId: panel.message.id });
  assert.equal(config(h).strictness, 'strict');
});

test('the home screen Open button and /yap check the role of whoever used them', async () => {
  const { h } = await setup({ features: { selects: false } });
  const open = await h.click('yo:system:open:automod', { user: IDS.member });
  assert.match(h.textOf(open[0]), /Only moderators/);
  assert.equal(h.allButtons(open).length, 0);
  const asMod = await h.click('yo:system:open:automod', { user: IDS.mod });
  assert.match(h.textOf(asMod[asMod.length - 1]), /Only admins can change these/);
  for (const text of ['automod', 'filter list', 'raid', 'raid on', 'lockdown', 'lockdown off', 'automod strictness', 'automod wrds']) {
    const ans = await h.slash('yap', text, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /Only moderators/, text);
  }
  const asModYap = await h.slash('yap', 'raid on', { user: IDS.mod });
  assert.match(h.textOf(asModYap[0]), /Only admins/);
  assert.equal(config(h).filters.raid, false);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('plain members get a role refusal for every typed automod shortcut', async () => {
  const { h } = await setup();
  for (const text of ['', 'words list', 'words add x', 'links list', 'links allow example.com', 'exempt', 'strictness', 'strict', 'preset gaming', 'verify off', 'lift', 'caps on', 'on caps', 'nonsense']) {
    const ans = await h.slash('automod', text, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /Only moderators/, text);
  }
  assert.deepEqual(config(h).words.list, []);
  assert.equal(config(h).filters.caps, false);
});

test('Undo on a settings change is locked to the opener and admin only', async () => {
  const { h } = await setup();
  await h.slash('automod', 'words add one, two', { user: IDS.admin });
  const cleared = await h.slash('automod', 'words clear', { user: IDS.admin });
  const undo = h.findButton('Undo', cleared);
  const openBtn = h.findButton('Open Automod', cleared);
  assert.ok(undo.messageId);
  for (const user of [IDS.member, IDS.mod]) {
    const onPanel = await h.click(undo.custom_id, { user, messageId: undo.messageId });
    assert.match(h.textOf(onPanel[0]), /Not your panel/);
    const forged = await h.click(undo.custom_id, { user });
    assert.match(h.textOf(forged[0]), /Only admins/);
  }
  const peek = await h.click(openBtn.custom_id, { user: IDS.member, messageId: openBtn.messageId });
  assert.match(h.textOf(peek[0]), /Not your panel/);
  assert.deepEqual(config(h).words.list, []);
  await h.click(undo.custom_id, { user: IDS.admin, messageId: undo.messageId });
  assert.deepEqual(config(h).words.list, ['one', 'two']);
});

test('Lift lockdown inside a settings panel is locked, the alert stays open to staff only', async () => {
  const { h } = await setup({ mod: false, features: { selects: false } });
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  const alert = h.lastSent(C.modlog);
  const opened = await h.slash('automod', '', { user: IDS.mod });
  const panel = opened[opened.length - 1];
  const lift = h.findButton('Lift lockdown', panel);
  const otherStaff = await h.click(lift.custom_id, { user: IDS.admin, messageId: lift.messageId });
  assert.match(h.textOf(otherStaff[0]), /Not your panel/);
  const member = await h.clickButton('Lift lockdown', { user: IDS.member, in: alert });
  assert.match(h.textOf(member[0]), /Only moderators/);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  const admin = await h.clickButton('Lift lockdown', { user: IDS.admin, in: alert });
  assert.equal(admin[0].type, 'update');
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('the posted Verify button is public and only ever gives the presser the verify role', async () => {
  const { h } = await setup();
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  for (const user of [IDS.member, IDS.member2]) {
    const got = await h.clickButton('Verify', { user, in: panel });
    assert.match(h.textOf(got[0]), /verified/);
    assert.deepEqual(h.fake.memberOf(IDS.server, user).roles, [IDS.roles.member, IDS.roles.vip]);
  }
  const extra = await h.click(`yo:automod:verify:${IDS.roles.mod}:${IDS.mod}`, { user: IDS.member, messageId: panel.id });
  assert.match(h.textOf(extra[0]), /already verified/);
  assert.ok(!h.fake.memberOf(IDS.server, IDS.member).roles.includes(IDS.roles.mod));
  await h.slash('automod', 'verify off', { user: IDS.admin });
  const off = await h.click('yo:automod:verify', { user: IDS.member2, messageId: panel.id });
  assert.match(h.textOf(off[0]), /Verification is off/);
});

const S2 = '5e000000-0000-4000-8000-000000000002';
const G2 = 'c0000000-0000-4000-8000-000000000021';
const BOT_ROLE_2 = 'r0000000-0000-4000-8000-000000000026';

function addSecondServer(h, ownerId) {
  const s = h.fake.state;
  s.servers[S2] = { id: S2, name: 'Side Town', icon_path: null, owner_id: ownerId, member_count: 2, online_count: 1 };
  s.roles[S2] = [{ id: BOT_ROLE_2, name: 'YapOS', color: null, position: 6, perms: { manage_roles: true, manage_messages: true, manage_server: true }, auto: null, mentionable: false }];
  s.members[S2] = [
    { id: ownerId, username: 'sam', display_name: 'Sam', nickname: null, roles: [], joined_at: '2026-02-01T00:00:00Z' },
    { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [BOT_ROLE_2], joined_at: '2026-02-01T00:00:00Z' },
  ];
  s.channels[S2] = [{ id: G2, name: 'general', type: 'text', kind: 'text', server_id: S2, position: 0, category: null, category_id: null, private: false, read_only: false, slowmode: 0 }];
  s.bans[S2] = [];
  s.everyone[S2] = { send_messages: true, view_channel: true };
}

const STAFF_IDS = ['yo:automod:toggle:caps', 'yo:automod:toggle:raid', 'yo:automod:strict:relaxed', 'yo:automod:panel', 'yo:automod:lift', 'yo:system:open:automod'];

test('a member pressing staff ids on a menu they opened themselves is refused by role', async () => {
  const { h } = await setup({ mod: false, features: { selects: false } });
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  const before = structuredClone(config(h));
  await h.slash('menu', '', { user: IDS.member });
  const own = h.lastSent(C.general);
  assert.ok(own?.id, 'the member has a menu of their own');
  for (const id of STAFF_IDS) {
    const ans = await h.click(id, { user: IDS.member, messageId: own.id });
    assert.match(h.textOf(ans[0]), /Only moderators|Only admins/, id);
    assert.equal(h.allButtons(ans).length, 0, id);
    assert.doesNotMatch(h.textOf(ans[0]), /Strictness|\b40[0-9]\b/, id);
  }
  const picked = await h.pick('yo:automod:strictpick', ['strict'], { user: IDS.member, messageId: own.id });
  assert.match(h.textOf(picked[0]), /Only admins/);
  assert.deepEqual(config(h), before);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
});

test('pasted ids, extra arguments and hostile form values give a member nothing', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  const before = structuredClone(config(h));
  const pasted = [
    `yo:automod:toggle:caps:${IDS.owner}`, `yo:automod:toggle:${IDS.owner}`, `yo:automod:strict:strict:${IDS.admin}`,
    `yo:automod:lift:${IDS.owner}`, `yo:automod:lift:${IDS.server}`, `yo:automod:panel:${IDS.admin}`, 'yo:automod:toggle:__proto__', 'yo:automod:nothing',
  ];
  for (const id of pasted) {
    const ans = await h.click(id, { user: IDS.member });
    assert.match(h.textOf(ans[0]), /Only moderators|Only admins|older panel/, id);
  }
  const hostile = [{ user_id: IDS.owner, level: 'owner' }, ['strict'], { 0: 'strict' }, JSON.parse('{"__proto__":{"admin":true}}')];
  for (const values of hostile) {
    for (const id of ['yo:automod:toggle:caps', 'yo:automod:strict:strict', 'yo:automod:strictpick', 'yo:automod:panel', 'yo:automod:lift']) {
      const ans = await h.submit(id, values, { user: IDS.member });
      assert.match(h.textOf(ans[0]), /Only moderators|Only admins/, id);
    }
  }
  assert.deepEqual(config(h), before);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
});

test('owning another server gives no power over this one', async () => {
  const { h } = await setup({ mod: false, features: { selects: false } });
  addSecondServer(h, IDS.member);
  await h.slash('automod', 'words add one', { user: IDS.admin });
  const cleared = await h.slash('automod', 'words clear', { user: IDS.admin });
  const undo = h.findButton('Undo', cleared);
  const opened = await h.slash('automod', '', { user: IDS.admin });
  const panel = opened[opened.length - 1];
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  const alert = h.lastSent(C.modlog);
  const before = structuredClone(config(h));

  const onPanel = await h.click('yo:automod:toggle:caps', { user: IDS.member, messageId: panel.message.id });
  assert.match(h.textOf(onPanel[0]), /Not your panel/);
  const capsInS2 = h.engine.settings.appConfig(S2, 'automod').filters.caps;
  const onTheirs = await h.click('yo:automod:toggle:caps', { user: IDS.member, server: S2, channel: G2, messageId: panel.message.id });
  assert.match(h.textOf(onTheirs[0]), /Not your panel/, 'owning another server does not unlock a panel from this server');
  assert.equal(h.engine.settings.appConfig(S2, 'automod').filters.caps, capsInS2);
  assert.deepEqual(config(h), before);
  const undoFromAway = await h.click(undo.custom_id, { user: IDS.member, server: S2, channel: G2 });
  assert.match(h.textOf(undoFromAway[0]), /Only admins/);
  assert.deepEqual(config(h).words.list, []);

  await h.click('yo:automod:toggle:caps', { user: IDS.member, server: S2, channel: G2 });
  await h.slash('automod', 'words add theirs', { user: IDS.member, server: S2, channel: G2 });
  assert.equal(h.engine.settings.appConfig(S2, 'automod').filters.caps, !capsInS2, 'they still run their own server');
  assert.deepEqual(h.engine.settings.appConfig(S2, 'automod').words.list, ['theirs']);
  assert.deepEqual(config(h), before);

  const lift = await h.click('yo:automod:lift', { user: IDS.member, server: S2, channel: G2, messageId: alert.id });
  assert.doesNotMatch(h.textOf(lift[0]), /is lifting/);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, false);
  assert.ok(h.findButton('Lift lockdown', h.fake.state.messages[C.modlog].find((m) => m.id === alert.id)));

  const here = await h.click('yo:automod:toggle:caps', { user: IDS.member });
  assert.match(h.textOf(here[0]), /Only admins/);
  assert.deepEqual(config(h), before);
});

test('verify pressed from another server gives nothing here', async () => {
  const { h } = await setup({ mod: false });
  addSecondServer(h, IDS.member);
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  const away = await h.click('yo:automod:verify', { user: IDS.member, server: S2, channel: G2, messageId: panel.id });
  assert.match(h.textOf(away[0]), /Verification is off/);
  assert.deepEqual(h.fake.memberOf(IDS.server, IDS.member).roles, [IDS.roles.member]);
  assert.deepEqual(h.fake.memberOf(S2, IDS.member).roles, []);
});

test('a role with webhook, nickname or move powers cannot become or stay the verify role', async () => {
  const { h } = await setup({ mod: false });
  const gamer = h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.gamer);
  for (const perm of ['manage_webhooks', 'manage_nicknames', 'move_members']) {
    gamer.perms = { [perm]: true };
    h.engine.perms.invalidate();
    const ans = await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.gamer}>`, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /too powerful/, perm);
  }
  assert.equal(config(h).verify.enabled, false);
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.vip).perms.manage_webhooks = true;
  h.engine.perms.invalidate();
  const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(h.textOf(got[0]), /can't verify you/);
  assert.deepEqual(h.fake.memberOf(IDS.server, IDS.member2).roles, [IDS.roles.member]);
});

test('verify role moved above the bot after setup is not handed out', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  h.fake.state.roles[IDS.server].find((r) => r.id === IDS.roles.vip).position = 8;
  h.engine.perms.invalidate();
  const got = await h.clickButton('Verify', { user: IDS.member, in: panel });
  assert.match(h.textOf(got[0]), /can't verify you/);
  assert.deepEqual(h.fake.memberOf(IDS.server, IDS.member).roles, [IDS.roles.member]);
});

test('hammering a stuck Verify button alerts the mods once, not every press', async () => {
  const { h } = await setup({ mod: false });
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  h.fake.fail('PUT', /\/roles\//, { status: 403, error: 'Role management is in testing (flag bot_roles)' });
  for (let i = 0; i < 6; i++) {
    const got = await h.clickButton('Verify', { user: i % 2 ? IDS.member : IDS.member2, in: panel });
    assert.match(h.textOf(got[0]), /couldn't verify you|can't verify you/);
  }
  const alerts = h.sent(C.modlog).filter((m) => /Verification (failed|is stuck|paused)/.test(h.textOf(m)));
  assert.equal(alerts.length, 1);
});

test('staff buttons replayed after Automod is uninstalled do nothing', async () => {
  const { h } = await setup({ mod: false, features: { selects: false } });
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const verifyPanel = h.lastSent(C.welcome);
  await h.slash('automod', 'words add one', { user: IDS.admin });
  const cleared = await h.slash('automod', 'words clear', { user: IDS.admin });
  const undo = h.findButton('Undo', cleared);
  const before = structuredClone(config(h));
  h.engine.settings.setEnabled(IDS.server, 'automod', false);
  for (const user of [IDS.member, IDS.admin]) {
    for (const id of ['yo:automod:toggle:caps', 'yo:automod:strict:strict', 'yo:automod:panel', 'yo:automod:lift', 'yo:system:open:automod']) {
      const ans = await h.click(id, { user });
      assert.match(h.textOf(ans[0]), /isn't installed here/, id);
    }
  }
  const v = await h.clickButton('Verify', { user: IDS.member, in: verifyPanel });
  assert.match(h.textOf(v[0]), /isn't installed here/);
  assert.deepEqual(h.fake.memberOf(IDS.server, IDS.member).roles, [IDS.roles.member]);
  const memberUndo = await h.click(undo.custom_id, { user: IDS.member });
  assert.match(h.textOf(memberUndo[0]), /Only admins/);
  const adminUndo = await h.click(undo.custom_id, { user: IDS.admin, messageId: undo.messageId });
  assert.match(h.textOf(adminUndo[0]), /isn't installed here/);
  for (const text of ['words add late', 'caps on', 'lockdown']) {
    const ans = await h.slash('automod', text, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /isn't installed here/, text);
  }
  const yap = await h.slash('yap', 'filter add late', { user: IDS.admin });
  assert.match(h.textOf(yap[0]), /isn't installed here/);
  assert.deepEqual(config(h), before);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
});

test('typed chat commands refuse a member the same way the slash menu does', async () => {
  const { h } = await setup({ mod: false });
  h.engine.settings.patchApp(IDS.server, 'automod', { filters: { ...config(h).filters, spam: false } });
  const before = structuredClone(config(h));
  for (const text of ['!automod', '!automod words add typed', '/automod caps on', '!automod lockdown', '!automod strictness strict', `!automod verify setup <#${C.welcome}> <@&${IDS.roles.mod}>`, `!automod exempt <#${C.general}>`, '!yap filter add typed', '!yap lockdown', '!yap automod']) {
    const count = h.sent(C.general).length;
    await h.message(text, { user: IDS.member });
    const reply = h.sent(C.general).slice(count);
    assert.equal(reply.length, 1, text);
    assert.match(h.textOf(reply[0]), /Only moderators/, text);
    assert.doesNotMatch(h.textOf(reply[0]), /\b40[0-9]\b|Strictness/, text);
    assert.equal(h.allButtons(reply).length, 0, text);
  }
  await h.message('!automod words add typed', { user: IDS.member, authorAsString: true });
  assert.deepEqual(config(h), before);
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
  assert.equal(h.sent(C.welcome).length, 0);
});

test('an admin who lost the role cannot keep using the panel they opened', async () => {
  const { h } = await setup({ features: { selects: false } });
  const opened = await h.slash('automod', '', { user: IDS.admin });
  const panel = opened[opened.length - 1];
  await h.slash('automod', 'words add one', { user: IDS.admin });
  const cleared = await h.slash('automod', 'words clear', { user: IDS.admin });
  const undo = h.findButton('Undo', cleared);
  h.fake.memberOf(IDS.server, IDS.admin).roles = [IDS.roles.member];
  h.engine.perms.invalidate();
  const toggle = h.findButton('Caps lock', panel);
  const ans = await h.click(toggle.custom_id, { user: IDS.admin, messageId: toggle.messageId });
  assert.match(h.textOf(ans[0]), /Only admins/);
  const refresh = await h.click('yo:automod:panel', { user: IDS.admin, messageId: toggle.messageId });
  assert.match(h.textOf(refresh[0]), /Only moderators/);
  const undone = await h.click(undo.custom_id, { user: IDS.admin, messageId: undo.messageId });
  assert.match(h.textOf(undone[0]), /Only admins/);
  assert.equal(config(h).filters.caps, false);
  assert.deepEqual(config(h).words.list, []);
});

test('staff cannot repaint a public panel by pressing settings ids on it', async () => {
  const { h } = await setup({ mod: false, features: { selects: false } });
  await h.slash('automod', `verify setup <#${C.welcome}> <@&${IDS.roles.vip}>`, { user: IDS.admin });
  const panel = h.lastSent(C.welcome);
  const stored = () => h.fake.state.messages[C.welcome].find((m) => m.id === panel.id);
  for (const [user, id] of [[IDS.mod, 'yo:automod:panel'], [IDS.mod, 'yo:automod:lift'], [IDS.admin, 'yo:automod:toggle:caps'], [IDS.admin, 'yo:automod:strict:strict']]) {
    await h.click(id, { user, channel: C.welcome, messageId: panel.id });
    assert.ok(h.findButton('Verify', stored()), id);
    assert.equal(h.allButtons(stored()).length, 1, id);
    assert.match(h.textOf(stored()), /Verify to join in/, id);
  }
  await h.slash('automod', 'lockdown', { user: IDS.mod });
  await h.click('yo:automod:lift', { user: IDS.mod, channel: C.welcome, messageId: panel.id });
  assert.equal(h.fake.state.everyone[IDS.server].send_messages, true);
  assert.equal(h.allButtons(stored()).length, 1);
  const got = await h.clickButton('Verify', { user: IDS.member2, in: panel });
  assert.match(h.textOf(got[0]), /verified/);
});

test('made-up filter, strictness and preset names are not stored', async () => {
  const { h } = await setup();
  const before = structuredClone(config(h));
  for (const id of ['yo:automod:toggle:constructor', 'yo:automod:toggle:toString', 'yo:automod:toggle:__proto__', 'yo:automod:strict:constructor', 'yo:automod:strict:__proto__']) {
    const ans = await h.click(id, { user: IDS.admin });
    assert.match(h.textOf(ans[0]), /older panel/, id);
  }
  const picked = await h.pick('yo:automod:strictpick', ['constructor'], { user: IDS.admin });
  assert.match(h.textOf(picked[0]), /Pick a strictness/);
  for (const text of ['strictness constructor', 'constructor', 'preset constructor', 'preset __proto__', 'toString', 'hasOwnProperty on']) {
    const ans = await h.slash('automod', text, { user: IDS.admin });
    assert.doesNotMatch(h.textOf(ans[0]), /undefined/, text);
  }
  assert.deepEqual(config(h), before);
});
