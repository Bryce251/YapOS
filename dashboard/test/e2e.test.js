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
  assert.deepEqual(levels.result.errors, {});
  const cfg = dev.harness.engine.settings.appConfig(S, 'levels');
  assert.equal(cfg.messageXp, false);
  assert.equal(cfg.cooldownSeconds, 30);
  assert.equal(cfg.channelId, C.general);
  assert.equal(cfg.announce, 'channel');
  assert.equal(cfg.message, 'GG {user}, you reached level {level}!');
  assert.deepEqual(cfg.noXpRoles, [R.vip]);
  assert.equal(levels.result.snapshot.settings.levels.values.cooldownSeconds, 30);

  const bad = await change(b, 'levels', { settings: { cooldownSeconds: 99999, channelId: C.voice } });
  assert.ok(bad.result.errors.cooldownSeconds);
  assert.ok(bad.result.errors.channelId);
  assert.equal(dev.harness.engine.settings.appConfig(S, 'levels').cooldownSeconds, 30);

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

  const money = await change(b, 'economy', { settings: { currencyName: 'Shells', dailyAmount: 250 } });
  assert.deepEqual(money.result.errors, {});
  assert.equal(dev.harness.engine.settings.appConfig(S, 'economy').currencyName, 'Shells');

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
  assert.equal(fresh.settings.levels.values.cooldownSeconds, 30);
  assert.equal(fresh.settings.economy.values.currencyName, 'Shells');

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

test('the public page is published, readable without a login, refuses a taken name and goes away when turned off', async () => {
  const b = await login('alex');
  await openServer(b);
  const missing = browser(dev.url);
  assert.equal((await missing.req('GET', '/api/public/test-town')).status, 404);

  const on = await settle(b, await b.mutate('PATCH', `/api/servers/${S}/public`, { enabled: true, slug: 'Test-Town' }));
  assert.equal(on.status, 'done');
  assert.deepEqual(on.result.errors, {});
  assert.deepEqual(on.result.applied.publicPage, { enabled: true, slug: 'test-town' });
  assert.deepEqual(dev.harness.engine.settings.core(S).publicPage, { enabled: true, slug: 'test-town' });

  const res = await missing.req('GET', '/api/public/test-town');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  const page = await res.json();
  assert.equal(page.name, 'Test Town');
  assert.equal(page.serverId, undefined);
  assert.deepEqual(page.levels.slice(0, 2).map((r) => [r.rank, r.name]), [[1, 'Sam'], [2, 'Riley']]);
  assert.deepEqual(page.economy[0].name, 'Sam');
  assert.ok(page.wrapped && page.wrapped.card);
  const text = JSON.stringify(page.wrapped);
  assert.equal(/<[@#][!&]?[\w-]+>/.test(text), false, 'no raw mention tokens');
  const fields = Object.fromEntries(page.wrapped.card.fields.map((f) => [f.name.replace(/^[^\p{L}]+/u, ''), f.value]));
  assert.match(fields['Messages'], /277/);
  assert.match(fields['Top chatters'], /Sam · 121/);
  assert.match(fields['Top channels'], /#general · 190/);
  assert.match(fields['Member of the month'], /^Sam/);

  const other = '5e000000-0000-4000-8000-0000000000bb';
  const claim = await fetch(`${dev.url}/bot/public/${other}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${dev.env.BOT_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, slug: 'other-place', name: 'Other', levels: [], economy: [], wrapped: null }),
  });
  assert.equal(claim.status, 200);
  const taken = await b.mutate('PATCH', `/api/servers/${S}/public`, { enabled: true, slug: 'other-place' });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, 'slug_taken');
  assert.equal(dev.harness.engine.settings.core(S).publicPage.slug, 'test-town');

  const bad = await b.mutate('PATCH', `/api/servers/${S}/public`, { enabled: true, slug: 'x' });
  assert.equal(bad.status, 400);

  const offJob = await settle(b, await b.mutate('PATCH', `/api/servers/${S}/public`, { enabled: false }));
  assert.deepEqual(offJob.result.errors, {});
  assert.equal(dev.harness.engine.settings.core(S).publicPage.enabled, false);
  assert.equal((await missing.req('GET', '/api/public/test-town')).status, 404);
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
