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
  await h.click(toggle.custom_id, { user: IDS.admin });
  assert.equal(config(h).filters.caps, true);
  const strict = h.findButton('Strict', panel);
  await h.click(strict.custom_id, { user: IDS.admin });
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
