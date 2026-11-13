import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDev, OUTSIDER_ID } from '../dev.mjs';
import { IDS } from '../../test/harness.js';

const S = IDS.server;
const C = IDS.channels;
const R = IDS.roles;
let dev;

function browser(base) {
  const jar = new Map();
  async function req(method, url, { body, headers = {}, raw } = {}) {
    const u = new URL(url, base);
    const h = new Headers(headers);
    const cookies = [];
    for (const [key, c] of jar) {
      if (key.startsWith(`${u.host}|`) && u.pathname.startsWith(c.path)) cookies.push(`${c.name}=${c.value}`);
    }
    if (cookies.length) h.set('Cookie', cookies.join('; '));
    const init = { method, headers: h, redirect: 'manual' };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      h.set('Content-Type', 'application/json');
    }
    const res = await fetch(u, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const pathAttr = attrs.find((a) => /^path=/i.test(a));
      const key = `${u.host}|${name}`;
      if (!value || attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(key);
      else jar.set(key, { name, value, path: pathAttr ? pathAttr.slice(5) : '/', attrs });
    }
    return res;
  }
  const mutate = (method, url, body, extra = {}) => req(method, url, { body, headers: { Origin: base, 'X-YapOS': '1', ...extra } });
  return { req, mutate, jar };
}

async function login(userKey, next = '/servers') {
  const b = browser(dev.url);
  const start = await b.req('GET', `/auth/login?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('Location'));
  assert.equal(authorize.origin, dev.oauthUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'), `${dev.url}/auth/callback`);
  const page = await (await b.req('GET', authorize.href)).text();
  const m = new RegExp(`href="([^"]*user=${userKey}[^"]*)"`).exec(page);
  assert.ok(m, `the sign-in page lists ${userKey}`);
  const approve = await b.req('GET', new URL(m[1].replace(/&amp;/g, '&'), dev.oauthUrl).href);
  assert.equal(approve.status, 302);
  const callback = await b.req('GET', approve.headers.get('Location'));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('Location'), next);
  const session = [...b.jar.values()].find((c) => c.name === 'yapos_session');
  assert.ok(session, 'a session cookie is set');
  assert.ok(session.attrs.includes('HttpOnly'));
  return b;
}

async function settle(b, res) {
  assert.ok(res.status === 202 || res.status === 403, `expected a job, got ${res.status}`);
  const body = await res.json();
  assert.ok(body.job, 'the answer carries a job id');
  for (let i = 0; i < 5; i++) {
    await dev.dashboard.tick();
    const r = await b.req('GET', `/api/jobs/${body.job}`);
    const j = await r.json();
    if (j.status !== 'pending') return { first: body, ...j, httpStatus: r.status };
  }
  throw new Error('the job never finished');
}

async function openServer(b) {
  const first = await b.req('GET', `/api/servers/${S}`);
  if (first.status === 200) return first.json();
  const job = await settle(b, first);
  assert.equal(job.status, 'done');
  assert.equal(job.result.grant, true);
  const again = await b.req('GET', `/api/servers/${S}`);
  assert.equal(again.status, 200);
  return again.json();
}

const change = async (b, app, body) => settle(b, await b.mutate('PATCH', `/api/servers/${S}/apps/${app}`, body));

before(async () => {
  dev = await startDev({ port: 0, oauthPort: 0, dbFile: ':memory:', autoPoll: false, nudge: false, quiet: true });
});

after(async () => {
  await dev?.close();
});

test('the site is served with the production headers and SPA fallback', async () => {
  const b = browser(dev.url);
  for (const p of ['/', '/js/main.js', '/css/app.css', '/servers', `/servers/${S}/apps/levels`, '/p/test-town']) {
    const res = await b.req('GET', p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('Content-Security-Policy') || '', /default-src 'self'/, p);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', p);
    assert.equal(res.headers.get('Referrer-Policy'), 'same-origin', p);
    assert.ok(res.headers.get('Permissions-Policy'), p);
    assert.equal(res.headers.get('Strict-Transport-Security'), null, p);
    await res.arrayBuffer();
  }
  assert.match(await (await b.req('GET', '/servers/abc')).text(), /<div id="app"/);
  assert.match((await b.req('GET', '/js/main.js')).headers.get('Content-Type'), /javascript/);
  assert.equal((await b.req('GET', '/_headers')).status, 404);
  assert.equal((await b.req('GET', '/nope')).status, 404);
  assert.equal((await b.req('GET', '/api/me')).status, 401);
});

test('the bot endpoints need the bot secret', async () => {
  const res = await fetch(`${dev.url}/bot/poll?wait=0`, { headers: { Authorization: 'Bearer test-secret-that-is-wrong-0123456789abcdef' } });
  assert.equal(res.status, 401);
  assert.equal(dev.dashboard.enabled, true);
});

test('cancelling the sign-in comes back as cancelled', async () => {
  const b = browser(dev.url);
  const start = await b.req('GET', '/auth/login?next=/servers');
  const page = await (await b.req('GET', start.headers.get('Location'))).text();
  const href = /href="([^"]*\/oauth\/deny[^"]*)"/.exec(page)[1].replace(/&amp;/g, '&');
  const deny = await b.req('GET', new URL(href, dev.oauthUrl).href);
  const back = await b.req('GET', deny.headers.get('Location'));
  assert.equal(back.headers.get('Location'), '/?login=cancelled');
});

test('an admin logs in, lists servers, opens Test Town and changes settings of several types', async () => {
  const b = await login('alex');
  const me = await (await b.req('GET', '/api/me')).json();
  assert.equal(me.user.id, IDS.admin);
  assert.equal(me.user.display_name, 'Alex');

  const list = await settle(b, await b.req('GET', '/api/servers'));
  assert.equal(list.status, 'done');
  assert.deepEqual(list.result.servers.map((s) => [s.id, s.name, s.level]), [[S, 'Test Town', 'admin']]);
  const cached = await (await b.req('GET', '/api/servers')).json();
  assert.equal(cached.servers[0].name, 'Test Town');

  const server = await openServer(b);
  assert.equal(server.overview.name, 'Test Town');
  assert.equal(server.overview.counts.cases, 4);
  assert.equal(server.overview.recent[0].reason, 'posted an invite link');
  assert.ok(server.apps.some((a) => a.id === 'levels' && a.enabled));
  assert.ok(server.apps.some((a) => a.id === 'system' && a.canDisable === false));
  const lookups = server.settings.lookups;
  assert.ok(lookups.channels.some((c) => c.id === C.voice && c.kind === 'voice'));
  assert.equal(lookups.roles.find((r) => r.id === R.gamer).manageable, true);
  assert.equal(lookups.roles.find((r) => r.id === R.admin).manageable, false);
  const levelsSchema = server.settings.levels.schema;
  for (const key of ['messageXp', 'cooldownSeconds', 'channelId', 'announce', 'message', 'noXpRoles']) {
    assert.ok(levelsSchema.some((f) => f.key === key && f.web === true), key);
  }

  const levels = await change(b, 'levels', { settings: { messageXp: false, cooldownSeconds: 30, channelId: C.general, announce: 'channel', message: 'GG {user}, you reached level {level}!', noXpRoles: [R.vip] } });
  assert.equal(levels.status, 'done');
  assert.match(levels.result.errors.messageXp, /bot owner/i);
  assert.match(levels.result.errors.cooldownSeconds, /bot owner/i);
  const cfg = dev.harness.engine.settings.appConfig(S, 'levels');
  assert.equal(cfg.channelId, C.general);
  assert.equal(cfg.announce, 'channel');
  assert.equal(cfg.message, 'GG {user}, you reached level {level}!');
  assert.deepEqual(cfg.noXpRoles, [R.vip]);
  assert.equal(levels.result.snapshot.settings.levels.values.channelId, C.general);

  const bad = await change(b, 'levels', { settings: { channelId: C.voice } });
  assert.ok(bad.result.errors.channelId);
  assert.equal(dev.harness.engine.settings.appConfig(S, 'levels').channelId, C.general);

  const words = await change(b, 'automod', { settings: { 'words.list': ['badword', 'worseword'], 'links.allow': ['example.com'] } });
  assert.deepEqual(words.result.errors, {});
  const automod = dev.harness.engine.settings.appConfig(S, 'automod');
  assert.deepEqual(automod.words.list, ['badword', 'worseword']);
  assert.equal(automod.filters.words, true);
  assert.deepEqual(automod.links.allow, ['example.com']);

  const roles = await change(b, 'welcome', { settings: { autoroles: [R.gamer], joinText: 'Welcome {user} to {server}!' } });
  assert.deepEqual(roles.result.errors, {});
  assert.deepEqual(dev.harness.engine.settings.appConfig(S, 'welcome').autoroles, [R.gamer]);
  const tooHigh = await change(b, 'welcome', { settings: { autoroles: [R.admin] } });
  assert.ok(tooHigh.result.errors.autoroles);
  assert.deepEqual(dev.harness.engine.settings.appConfig(S, 'welcome').autoroles, [R.gamer]);

  const money = await change(b, 'economy', { settings: { dailyAmount: 250 } });
  assert.match(money.result.errors.dailyAmount, /bot owner/i);

  const off = await change(b, 'games', { enabled: false });
  assert.equal(off.result.applied.enabled, false);
  assert.equal(dev.harness.engine.settings.isEnabled(S, 'games'), false);
  const blocked = await change(b, 'games', { settings: { maxBet: 100 } });
  assert.match(blocked.result.errors.maxBet, /isn't installed/);
  const on = await change(b, 'games', { enabled: true });
  assert.equal(on.result.applied.enabled, true);
  const core = await change(b, 'system', { enabled: false });
  assert.ok(core.result.errors.enabled);

  const readOnly = await change(b, 'mod', { settings: { 'core.modRoles': [R.vip] } });
  assert.ok(readOnly.result.errors['core.modRoles']);

  await dev.harness.settle();
  const log = dev.harness.sent(C.modlog).map((m) => m.content).join('\n');
  assert.match(log, /⚙️ Alex changed Levels: .* on the dashboard/);
  assert.match(log, /⚙️ Alex changed Automod: /);

  const fresh = await (await b.req('GET', `/api/servers/${S}`)).json();
  assert.equal(fresh.settings.levels.values.channelId, C.general);
  assert.ok(fresh.settings.levels.schema.some((f) => f.key === 'cooldownSeconds' && f.owner === true));
  assert.ok(fresh.settings.economy.schema.every((f) => f.owner === true));
  assert.equal(fresh.settings.economy.schema.some((f) => f.key === 'currencyName'), false);

  const noCsrf = await b.req('PATCH', `/api/servers/${S}/apps/levels`, { body: { enabled: true }, headers: { Origin: dev.url } });
  assert.equal(noCsrf.status, 403);
  const wrongOrigin = await b.mutate('PATCH', `/api/servers/${S}/apps/levels`, { enabled: true }, { Origin: 'http://localhost:1' });
  assert.equal(wrongOrigin.status, 403);
});

test('a moderator and an outsider are refused and change nothing', async () => {
  const before = dev.harness.engine.settings.appConfig(S, 'levels').cooldownSeconds;
  for (const who of ['morgan', 'taylor']) {
    const b = await login(who);
    const list = await settle(b, await b.req('GET', '/api/servers'));
    assert.deepEqual(list.result.servers, [], who);
    const open = await settle(b, await b.req('GET', `/api/servers/${S}`));
    assert.equal(open.status, 'error', who);
    assert.equal(open.result.grant, false, who);
    assert.match(open.message, /admin/, who);
    const patch = await b.mutate('PATCH', `/api/servers/${S}/apps/levels`, { settings: { cooldownSeconds: 5 } });
    assert.equal(patch.status, 403, who);
    const refused = await patch.json();
    assert.equal(refused.error, 'no_access', who);
    assert.equal(refused.result.grant, false, who);
    assert.ok(!refused.job, 'a recent refusal is remembered instead of asking the bot again');
    assert.equal((await b.req('GET', `/api/servers/${S}/cases`)).status, 403, who);
    const member = await b.req('GET', `/api/servers/${S}/members/${IDS.member}`);
    assert.equal(member.status, 403, who);
    await member.arrayBuffer();
  }
  assert.equal(dev.harness.engine.settings.appConfig(S, 'levels').cooldownSeconds, before);
  assert.ok(OUTSIDER_ID);
});

test('cases search and the member job', async () => {
  const b = await login('jolli');
  await openServer(b);
  const all = await (await b.req('GET', `/api/servers/${S}/cases`)).json();
  assert.equal(all.total, 4);
  assert.deepEqual(all.cases.map((c) => c.n), [4, 3, 2, 1]);
  const invite = await (await b.req('GET', `/api/servers/${S}/cases?q=invite`)).json();
  assert.deepEqual(invite.cases.map((c) => c.n), [4]);
  const riley = await (await b.req('GET', `/api/servers/${S}/cases?user=${IDS.member2}`)).json();
  assert.deepEqual(riley.cases.map((c) => c.n), [3, 2]);
  const timeouts = await (await b.req('GET', `/api/servers/${S}/cases?type=timeout`)).json();
  assert.deepEqual(timeouts.cases.map((c) => [c.n, c.duration, c.active]), [[3, 600000, true]]);

  const job = await settle(b, await b.req('GET', `/api/servers/${S}/members/${IDS.member}`));
  assert.equal(job.status, 'done');
  const m = job.result.member;
  assert.equal(m.id, IDS.member);
  assert.equal(m.name, 'Sam');
  assert.equal(m.warnings.length, 2);
  assert.deepEqual(m.cases.map((c) => c.n), [4, 1]);
  assert.ok(m.levels.xp >= 2650);
  assert.ok(m.economy.balance >= 1250);
});

test('the public leaderboard is one global board and old server links lead to it', async () => {
  const visitor = browser(dev.url);
  const moved = await visitor.req('GET', '/api/public/test-town');
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get('Location'), '/api/public/global');

  const board = {
    levels: [{ rank: 1, id: IDS.member, name: 'Sam', level: 7, xp: 2650 }],
    economy: [{ rank: 1, id: IDS.member, name: 'Sam', balance: 1250 }],
    currency: { name: 'Shards', emoji: '\u{1F48E}' },
    updatedAt: Date.now(),
  };
  const push = await fetch(`${dev.url}/bot/global`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${dev.env.BOT_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(board),
  });
  assert.equal(push.status, 200);

  const res = await visitor.req('GET', '/api/public/global');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  const page = await res.json();
  assert.equal(page.global, true);
  assert.equal(page.serverId, undefined);
  assert.equal(page.wrapped, undefined);
  assert.equal(page.levels[0].name, 'Sam');
  assert.equal(page.economy[0].name, 'Sam');
  assert.deepEqual(page.currency, { name: 'Shards', emoji: '\u{1F48E}' });
});

test('the bot sees the dashboard as hot while people use it, and logging out ends the session', async () => {
  const b = await login('alex');
  await b.req('GET', '/api/me');
  await dev.dashboard.tick();
  assert.equal(dev.dashboard.hot, true);
  const out = await b.mutate('POST', '/auth/logout', {});
  assert.equal(out.status, 200);
  assert.equal((await b.req('GET', '/api/me')).status, 401);
});

const modlogText = () => dev.harness.sent(C.modlog).map((m) => JSON.stringify(m)).join('\n');
const act = async (b, uid, body) => settle(b, await b.mutate('POST', `/api/servers/${S}/members/${uid}/actions`, body));
const caseTotal = async (b) => (await (await b.req('GET', `/api/servers/${S}/cases`)).json()).total;

test('the members list searches by name and filters by role', async () => {
  const b = await login('alex');
  await openServer(b);
  const all = await settle(b, await b.req('GET', `/api/servers/${S}/members`));
  assert.equal(all.status, 'done');
  assert.equal(all.result.grant, true);
  assert.equal(all.result.pageSize, 50);
  assert.equal(all.result.capped, false);
  const ids = all.result.members.map((m) => m.id);
  for (const id of [IDS.owner, IDS.admin, IDS.mod, IDS.member, IDS.member2]) assert.ok(ids.includes(id), id);
  assert.equal(ids[ids.length - 1], IDS.owner, 'newest joins come first');
  const alex = all.result.members.find((m) => m.id === IDS.admin);
  assert.deepEqual(alex.roles.slice(0, 2), [R.admin, R.member]);
  assert.equal(all.result.members.find((m) => m.id === IDS.bot)?.bot, true);
  const sam = all.result.members.find((m) => m.id === IDS.member);
  assert.equal(sam.warnings, 2);
  assert.ok(sam.cases >= 2);

  const search = await settle(b, await b.req('GET', `/api/servers/${S}/members?q=RIL`));
  assert.deepEqual(search.result.members.map((m) => m.id), [IDS.member2]);
  assert.equal(search.result.total, 1);
  const byRole = await settle(b, await b.req('GET', `/api/servers/${S}/members?role=${R.mod}&sort=name`));
  assert.deepEqual(byRole.result.members.map((m) => m.id), [IDS.mod]);
  const both = await settle(b, await b.req('GET', `/api/servers/${S}/members?role=${R.member}&q=sam`));
  assert.deepEqual(both.result.members.map((m) => m.id), [IDS.member]);
  assert.equal((await b.req('GET', `/api/servers/${S}/members?sort=sideways`)).status, 400);
});

test('member detail carries the right can flags for each target', async () => {
  const b = await login('alex');
  await openServer(b);
  const sam = (await settle(b, await b.req('GET', `/api/servers/${S}/members/${IDS.member}`))).result.member;
  assert.equal(sam.username, 'sam');
  assert.equal(sam.banned, false);
  assert.equal(sam.timeout, null);
  assert.ok(sam.roles.some((r) => r.id === R.member && r.manageable === true));
  assert.equal(sam.notes.length, 2);
  assert.match(sam.notes[0].text, /calmer/);
  assert.deepEqual({ ...sam.can }, { warn: true, unwarn: true, timeout: true, kick: true, ban: true, unban: false, role: true, nick: false, note: true });

  const owner = (await settle(b, await b.req('GET', `/api/servers/${S}/members/${IDS.owner}`))).result.member;
  for (const k of ['warn', 'timeout', 'kick', 'ban', 'unban', 'role', 'nick']) assert.equal(owner.can[k], false, k);
});

test('a timeout and its removal through the dashboard get case numbers in the mod log', async () => {
  const b = await login('alex');
  await openServer(b);
  const start = await caseTotal(b);
  const on = await act(b, IDS.member2, { action: 'timeout', duration: '15m', reason: 'needs a short break' });
  assert.equal(on.status, 'done');
  assert.equal(on.result.ok, true);
  assert.equal(on.result.action, 'timeout');
  assert.equal(on.result.case.n, start + 1);
  assert.equal(on.result.case.duration, 15 * 60_000);
  assert.ok(on.result.member.timeout?.until);
  assert.match(on.result.message, /@riley/);

  const off = await act(b, IDS.member2, { action: 'untimeout', reason: 'all good now' });
  assert.equal(off.result.ok, true);
  assert.equal(off.result.case.n, start + 2);
  assert.equal(off.result.member.timeout, null);

  await dev.harness.settle();
  const log = modlogText();
  assert.match(log, new RegExp(`Case #${start + 1}\\b`));
  assert.match(log, new RegExp(`Case #${start + 2}\\b`));
  assert.equal(await caseTotal(b), start + 2);
  const cases = (await (await b.req('GET', `/api/servers/${S}/cases?user=${IDS.member2}`)).json()).cases;
  assert.equal(cases[0].n, start + 2);
});

test('an admin acting on the owner is refused in plain words and nothing changes', async () => {
  const b = await login('alex');
  await openServer(b);
  const start = await caseTotal(b);
  const refused = await act(b, IDS.owner, { action: 'warn', reason: 'testing' });
  assert.equal(refused.status, 'done');
  assert.equal(refused.result.grant, true);
  assert.equal(refused.result.ok, false);
  assert.ok(refused.result.error.length > 10);
  assert.doesNotMatch(refused.result.error, /\b(403|forbidden|undefined|null)\b/i);
  const kick = await act(b, IDS.owner, { action: 'kick' });
  assert.equal(kick.result.ok, false);
  assert.ok(dev.harness.fake.state.members[S].some((m) => m.id === IDS.owner));
  assert.equal(await caseTotal(b), start);

  const bad = await b.mutate('POST', `/api/servers/${S}/members/${IDS.member}/actions`, { action: 'explode' });
  assert.equal(bad.status, 400);
});

test('a warning from the dashboard can be removed again with unwarn', async () => {
  const b = await login('alex');
  await openServer(b);
  const start = await caseTotal(b);
  const warn = await act(b, IDS.member2, { action: 'warn', reason: 'rude in general' });
  assert.equal(warn.result.ok, true);
  const n = warn.result.case.n;
  assert.equal(n, start + 1);
  assert.ok(warn.result.member.warnings.some((w) => w.case === n));
  const mod = dev.harness.engine.service('mod');
  assert.ok(mod.activeWarns(S, IDS.member2).some((w) => w.caseId === n));

  const undo = await act(b, IDS.member2, { action: 'unwarn', case: n });
  assert.equal(undo.result.ok, true);
  assert.match(undo.result.message, new RegExp(`case #${n}`));
  assert.ok(!undo.result.member.warnings.some((w) => w.case === n));
  assert.ok(!mod.activeWarns(S, IDS.member2).some((w) => w.caseId === n));

  const again = await act(b, IDS.member2, { action: 'unwarn', case: n });
  assert.equal(again.result.ok, false);
  assert.match(again.result.error, /already removed/);
});

test('roles can be added and removed from the member drawer', async () => {
  const b = await login('alex');
  await openServer(b);
  const start = await caseTotal(b);
  const rolesOf = () => dev.harness.fake.state.members[S].find((m) => m.id === IDS.member).roles;
  const add = await act(b, IDS.member, { action: 'role_add', role_id: R.gamer });
  assert.equal(add.result.ok, true);
  assert.equal(add.result.case, null);
  assert.ok(rolesOf().includes(R.gamer));
  assert.ok(add.result.member.roles.some((r) => r.id === R.gamer));

  const remove = await act(b, IDS.member, { action: 'role_remove', role_id: R.gamer });
  assert.equal(remove.result.ok, true);
  assert.ok(!rolesOf().includes(R.gamer));
  assert.ok(!remove.result.member.roles.some((r) => r.id === R.gamer));

  const tooHigh = await act(b, IDS.member, { action: 'role_add', role_id: R.top });
  assert.equal(tooHigh.result.ok, false);
  assert.ok(!rolesOf().includes(R.top));
  assert.equal(await caseTotal(b), start);
  await dev.harness.settle();
  assert.match(modlogText(), /Gamer/);
});

test('the tickets list shows counts, ratings, filters and search', async () => {
  const b = await login('jolli');
  const server = await openServer(b);
  assert.equal(server.overview.stats.casesByDay.length, 14);
  assert.ok(server.overview.stats.tickets.open >= 2);
  assert.ok(server.overview.stats.activeWarns >= 2);
  const open = await settle(b, await b.req('GET', `/api/servers/${S}/tickets`));
  assert.equal(open.status, 'done');
  assert.equal(open.result.grant, true);
  assert.ok(open.result.counts.open >= 2);
  assert.ok(open.result.counts.closed >= 1);
  assert.equal(open.result.rating.average, 5);
  assert.ok(open.result.tickets.every((t) => t.status !== 'closed'));
  const numbers = open.result.tickets.map((t) => t.number);
  assert.deepEqual(numbers, [...numbers].sort((x, y) => y - x));

  const closed = await settle(b, await b.req('GET', `/api/servers/${S}/tickets?status=closed`));
  const refund = closed.result.tickets.find((t) => /Refund/.test(t.topic || ''));
  assert.ok(refund);
  assert.equal(refund.rating, 5);
  assert.equal(refund.opener.id, IDS.member);

  const search = await settle(b, await b.req('GET', `/api/servers/${S}/tickets?status=all&q=gamer`));
  assert.equal(search.result.tickets.length, 1);
  assert.equal(search.result.tickets[0].opener.id, IDS.member2);
  assert.equal(search.result.tickets[0].claimedBy?.id, IDS.mod);
  assert.equal((await b.req('GET', `/api/servers/${S}/tickets?status=lost`)).status, 400);
});

test('ticket detail comes with its transcript, stored or live', async () => {
  const b = await login('jolli');
  await openServer(b);
  const all = (await settle(b, await b.req('GET', `/api/servers/${S}/tickets?status=all`))).result.tickets;
  const refund = all.find((t) => /Refund/.test(t.topic || ''));
  const help = all.find((t) => /level/.test(t.topic || ''));

  const stored = await settle(b, await b.req('GET', `/api/servers/${S}/tickets/${refund.number}`));
  assert.equal(stored.status, 'done');
  assert.equal(stored.result.ticket.number, refund.number);
  assert.equal(stored.result.ticket.reason, 'Refunded');
  assert.equal(stored.result.ticket.closedBy?.id, IDS.admin);
  assert.equal(stored.result.transcript.live, false);
  assert.match(stored.result.transcript.text, /Thank you so much!/);

  const live = await settle(b, await b.req('GET', `/api/servers/${S}/tickets/${help.number}`));
  assert.equal(live.result.transcript.live, true);
  assert.match(live.result.transcript.text, /my level stayed the same/);
  assert.ok(live.result.transcript.count >= 1);

  const missing = await settle(b, await b.req('GET', `/api/servers/${S}/tickets/999999`));
  assert.equal(missing.result.ticket, null);
  assert.match(missing.result.error, /couldn't find/);
  assert.equal((await b.req('GET', `/api/servers/${S}/tickets/abc`)).status, 400);
});

test('a ticket can be claimed and then closed from the dashboard', async () => {
  const b = await login('jolli');
  await openServer(b);
  const all = (await settle(b, await b.req('GET', `/api/servers/${S}/tickets`))).result.tickets;
  const help = all.find((t) => /level/.test(t.topic || ''));
  assert.equal(help.claimedBy, null);
  const path = `/api/servers/${S}/tickets/${help.number}/actions`;

  const claim = await settle(b, await b.mutate('POST', path, { action: 'claim' }));
  assert.equal(claim.status, 'done');
  assert.equal(claim.result.ok, true);
  assert.equal(claim.result.ticket.claimedBy.id, IDS.owner);
  await dev.harness.settle();
  assert.ok(dev.harness.sent(help.channelId).length > 0);

  const close = await settle(b, await b.mutate('POST', path, { action: 'close', reason: 'Fixed the level role' }));
  assert.equal(close.result.ok, true);
  assert.match(close.result.message, /Closed ticket/);
  assert.equal(close.result.ticket.status, 'closed');
  assert.equal(close.result.ticket.reason, 'Fixed the level role');
  const stored = dev.harness.engine.store.get('tickets', S, null).tickets[help.number];
  assert.equal(stored.status, 'closed');
  assert.equal('transcript' in stored, false);
  assert.match(dev.harness.engine.store.get('ticket-transcripts', `${S}-${help.number}`, null).text, /my level stayed the same/);

  const twice = await settle(b, await b.mutate('POST', path, { action: 'close' }));
  assert.equal(twice.result.ok, false);
  assert.match(twice.result.error, /already/);
  const noCsrf = await b.req('POST', path, { body: { action: 'claim' }, headers: { Origin: dev.url } });
  assert.equal(noCsrf.status, 403);
});

test('the activity gets real profiles through the bot, and the test call gets fake ones', async () => {
  const fake = 'de7e0000-0000-4000-8000-000000000002';
  const quiet = 'de7e0000-0000-4000-8000-000000000004';
  const ask = async (ids) => {
    const res = await fetch(`${dev.url}/api/activity/profiles?ids=${ids.join(',')}`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const first = await ask([IDS.member2, 'nobody-at-all', fake, quiet]);
  const fakeOne = first.profiles.find((p) => p.id === fake);
  assert.deepEqual(fakeOne, { id: fake, username: 'junebug', display_name: 'Juno', avatar: '/activity-dev/avatars/2.svg' });
  assert.equal(first.profiles.find((p) => p.id === quiet).avatar, null);
  assert.deepEqual(first.pending.sort(), [IDS.member2, 'nobody-at-all'].sort());

  await dev.dashboard.tick();
  await dev.dashboard.profileWork;
  const second = await ask([IDS.member2, 'nobody-at-all']);
  assert.deepEqual(second.pending, []);
  const riley = second.profiles.find((p) => p.id === IDS.member2);
  assert.equal(riley.username, 'riley');
  assert.equal(riley.display_name, 'Riley');
  assert.deepEqual(second.profiles.find((p) => p.id === 'nobody-at-all'), { id: 'nobody-at-all', username: null, display_name: null, avatar: null });

  const pic = await fetch(`${dev.url}/activity-dev/avatars/2.svg`);
  assert.equal(pic.status, 200);
  assert.match(pic.headers.get('Content-Type'), /image\/svg\+xml/);
  assert.match(await pic.text(), /^<svg /);
  assert.equal((await fetch(`${dev.url}/activity-dev/avatars/x.svg`)).status, 404);
});
