import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS, SERVER, OTHER_SERVER } from './helpers.js';

const MIN = 60 * 1000;

test('api needs a session', async () => {
  const h = createHarness();
  const res = await h.api('GET', '/api/me');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'signed_out');
  assert.equal(typeof body.message, 'string');
});

test('mutating api calls need same Origin and X-YapOS', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.grant(cookie);
  const body = { enabled: false };
  const cases = [
    { Origin: null },
    { Origin: 'https://evil.example' },
    { Origin: 'https://dash.example.test.evil.example' },
    { 'X-YapOS': null },
    { 'X-YapOS': '0' },
  ];
  for (const extra of cases) {
    const res = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, body, extra);
    assert.equal(res.status, 403, JSON.stringify(extra));
    assert.equal((await res.json()).error, 'forbidden');
  }
  const noSession = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, null, body, { Origin: 'https://evil.example' });
  assert.equal(noSession.status, 403);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'change'").get().n, 0);
  const ok = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, body);
  assert.equal(ok.status, 202);
});

test('servers list: job flow, cache for 2 minutes, then refresh', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const first = await h.api('GET', '/api/servers', cookie);
  assert.equal(first.status, 202);
  const p = await first.json();
  assert.equal(p.pending, true);
  const again = await (await h.api('GET', '/api/servers', cookie)).json();
  assert.equal(again.job, p.job, 'duplicate pending jobs are reused');
  assert.deepEqual(await (await h.api('GET', `/api/jobs/${p.job}`, cookie)).json(), { status: 'pending' });
  const polled = await h.poll();
  assert.equal(polled.jobs.length, 1);
  assert.equal(polled.jobs[0].type, 'servers');
  assert.equal(polled.jobs[0].user_id, USERS.alice.id);
  assert.deepEqual(polled.jobs[0].data, {});
  assert.equal(polled.hot, true);
  const servers = [
    { id: SERVER, name: 'Test', icon_url: 'https://files.yapper.website/i.png', member_count: 12, level: 'owner' },
    { id: '../../etc', name: 'bad' },
  ];
  const r = await h.answer([{ id: p.job, ok: true, result: { servers } }]);
  assert.equal(r.status, 200);
  const done = await (await h.api('GET', `/api/jobs/${p.job}`, cookie)).json();
  assert.equal(done.status, 'done');
  assert.equal(done.result.servers.length, 2);
  const cached = await h.api('GET', '/api/servers', cookie);
  assert.equal(cached.status, 200);
  const list = await cached.json();
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0].id, SERVER);
  advance(h, 2 * MIN + 1);
  const stale = await (await h.api('GET', '/api/servers', cookie)).json();
  assert.equal(stale.pending, true);
  assert.notEqual(stale.job, p.job);
});

test('jobs time out after 2 minutes with a friendly error', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const { job } = await (await h.api('GET', '/api/servers', cookie)).json();
  advance(h, 2 * MIN + 1);
  const res = await (await h.api('GET', `/api/jobs/${job}`, cookie)).json();
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'timeout');
  assert.match(res.message, /hasn't answered/);
  assert.equal((await h.poll()).jobs.length, 0);
});

test("a user cannot read another user's job", async () => {
  const h = createHarness();
  const a = await h.login(USERS.alice);
  const b = await h.login(USERS.bob);
  const { job } = await (await h.api('GET', '/api/servers', a.cookie)).json();
  const res = await h.api('GET', `/api/jobs/${job}`, b.cookie);
  assert.equal(res.status, 404);
  const weird = await h.api('GET', `/api/jobs/${encodeURIComponent("x' OR '1'='1")}`, b.cookie);
  assert.equal(weird.status, 404);
});

test('server pages need a grant confirmed by the bot within 5 minutes', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const res = await h.api('GET', `/api/servers/${SERVER}`, cookie);
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const { jobs } = await h.poll();
  assert.equal(jobs[0].type, 'access');
  assert.equal(jobs[0].server_id, SERVER);
  await h.pushSnapshot();
  await h.answer([{ id: job, ok: true, result: { grant: true, level: 'admin' } }]);
  const view = await h.api('GET', `/api/servers/${SERVER}`, cookie);
  assert.equal(view.status, 200);
  const data = await view.json();
  assert.equal(data.overview.name, 'Test Server');
  assert.equal(data.apps[0].id, 'mod');
  assert.equal(data.settings.mod.values.dmOnAction, true);
  assert.equal(data.level, 'admin');
  assert.ok(data.updatedAt);
  assert.ok(!('cases' in data));
  advance(h, 5 * MIN + 1);
  const expired = await h.api('GET', `/api/servers/${SERVER}`, cookie);
  assert.equal(expired.status, 202);
  assert.equal((await expired.json()).pending, true);
});

test('a refused access result gives a clear error and no grant', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const { job } = await (await h.api('GET', `/api/servers/${SERVER}`, cookie)).json();
  await h.poll();
  await h.answer([{ id: job, ok: true, result: { grant: false, level: 'member' } }]);
  const res = await (await h.api('GET', `/api/jobs/${job}`, cookie)).json();
  assert.equal(res.status, 'error');
  assert.match(res.error, /admin/);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE level != 'none'").get().n, 0);
});

test('IDOR: grants are per user and per server', async () => {
  const h = createHarness();
  const a = await h.login(USERS.alice);
  const b = await h.login(USERS.bob);
  await h.pushSnapshot();
  await h.grant(a.cookie);
  const bobView = await h.api('GET', `/api/servers/${SERVER}`, b.cookie);
  assert.equal(bobView.status, 202);
  const bobCases = await h.api('GET', `/api/servers/${SERVER}/cases`, b.cookie);
  assert.equal(bobCases.status, 403);
  assert.equal((await bobCases.json()).error, 'grant_required');
  const bobMember = await h.api('GET', `/api/servers/${SERVER}/members/${USERS.alice.id}`, b.cookie);
  assert.equal(bobMember.status, 403);
  const bobChange = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, b.cookie, { enabled: false });
  assert.equal(bobChange.status, 403);
  const aliceOther = await h.api('GET', `/api/servers/${OTHER_SERVER}/cases`, a.cookie);
  assert.equal(aliceOther.status, 403);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type IN ('change', 'member')").get().n, 0);
});

test('member and change job results are only readable with a fresh grant', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.pushSnapshot();
  await h.grant(cookie);
  const m = await h.api('GET', `/api/servers/${SERVER}/members/${USERS.bob.id}`, cookie);
  assert.equal(m.status, 202);
  const { job } = await m.json();
  const { jobs } = await h.poll();
  const mj = jobs.find((j) => j.id === job);
  assert.equal(mj.type, 'member');
  assert.deepEqual(mj.data, { user_id: USERS.bob.id });
  await h.answer([{ id: job, ok: true, result: { grant: true, member: { id: USERS.bob.id, name: 'Bob', warnings: [] } } }]);
  const ok = await (await h.api('GET', `/api/jobs/${job}`, cookie)).json();
  assert.equal(ok.status, 'done');
  assert.equal(ok.result.member.name, 'Bob');
  advance(h, 5 * MIN + 1);
  const late = await h.api('GET', `/api/jobs/${job}`, cookie);
  assert.equal(late.status, 403);
});

test('change jobs: validation, enqueue, bot result, grant refresh and snapshot update', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.pushSnapshot();
  await h.grant(cookie);
  const bad = [
    [{}, 400],
    [{ enabled: 'yes' }, 400],
    [{ settings: [] }, 400],
    [{ settings: { 'bad key!': 1 } }, 400],
    [{ settings: { __proto__: 1 } }, 400],
    [{ extra: 1, enabled: true }, 400],
  ];
  for (const [body, status] of bad) {
    const res = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, body);
    assert.equal(res.status, status, JSON.stringify(body));
  }
  const raw = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, '{"settings":{"__proto__":{"x":1}}}');
  assert.equal(raw.status, 400);
  assert.equal((await h.api('PATCH', `/api/servers/${SERVER}/apps/Bad.App`, cookie, { enabled: true })).status, 400);
  const notJson = await h.request('PATCH', `/api/servers/${SERVER}/apps/mod`, {
    headers: { Cookie: cookie, Origin: h.base, 'X-YapOS': '1', 'Content-Type': 'text/plain' },
    body: '{"enabled":true}',
  });
  assert.equal(notJson.status, 415);
  const broken = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, '{"enabled":');
  assert.equal(broken.status, 400);
  const big = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, { settings: { text: 'x'.repeat(64 * 1024) } });
  assert.equal(big.status, 413);
  const res = await h.api('PATCH', `/api/servers/${SERVER}/apps/welcome`, cookie, { enabled: true, settings: { joinText: 'Hi {user}', 'core.logChannel': '5555' } });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const { jobs } = await h.poll();
  const cj = jobs.find((j) => j.id === job);
  assert.deepEqual(cj.data, { app: 'welcome', enabled: true, settings: { joinText: 'Hi {user}', 'core.logChannel': '5555' } });
  advance(h, 4 * MIN);
  await h.answer([{ id: job, ok: true, result: { grant: true, applied: { joinText: 'Hi {user}' }, errors: { 'core.logChannel': 'That channel does not exist.' }, snapshot: { apps: [{ id: 'welcome', enabled: true }], settings: { welcome: { values: { joinText: 'Hi {user}' } } } } } }]);
  advance(h, 2 * MIN);
  const done = await (await h.api('GET', `/api/jobs/${job}`, cookie)).json();
  assert.equal(done.status, 'done', 'grant was refreshed by the change result');
  assert.equal(done.result.errors['core.logChannel'], 'That channel does not exist.');
  const view = await (await h.api('GET', `/api/servers/${SERVER}`, cookie)).json();
  assert.equal(view.apps[0].id, 'welcome');
  assert.equal(view.settings.welcome.values.joinText, 'Hi {user}');
});

test('a change refused by the bot removes the grant', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.pushSnapshot();
  await h.grant(cookie);
  const { job } = await (await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, { enabled: false })).json();
  await h.poll();
  await h.answer([{ id: job, ok: false, result: { grant: false }, error: 'You need to be an admin of this server.' }]);
  const res = await (await h.api('GET', `/api/jobs/${job}`, cookie)).json();
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'You need to be an admin of this server.');
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE level != 'none'").get().n, 0);
  assert.equal((await h.api('GET', `/api/servers/${SERVER}/cases`, cookie)).status, 403);
});

test('cases are filtered and paged in the worker', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const cases = [];
  for (let n = 120; n >= 1; n--) {
    cases.push({ n, type: n % 3 === 0 ? 'ban' : 'warn', user: { id: n % 2 ? 'u-odd' : 'u-even', name: n % 2 ? 'Oddly' : 'Evenly' }, mod: { id: 'm1', name: 'Mod' }, reason: n === 7 ? 'spamming links' : 'rude', at: n });
  }
  await h.pushSnapshot(SERVER, { cases });
  await h.grant(cookie);
  let r = await (await h.api('GET', `/api/servers/${SERVER}/cases`, cookie)).json();
  assert.equal(r.total, 120);
  assert.equal(r.cases.length, 50);
  assert.equal(r.pages, 3);
  assert.equal(r.cases[0].n, 120);
  r = await (await h.api('GET', `/api/servers/${SERVER}/cases?page=3`, cookie)).json();
  assert.equal(r.cases.length, 20);
  r = await (await h.api('GET', `/api/servers/${SERVER}/cases?q=spamming`, cookie)).json();
  assert.equal(r.total, 1);
  assert.equal(r.cases[0].n, 7);
  r = await (await h.api('GET', `/api/servers/${SERVER}/cases?q=%2342`, cookie)).json();
  assert.equal(r.cases[0].n, 42);
  r = await (await h.api('GET', `/api/servers/${SERVER}/cases?user=u-odd&type=ban`, cookie)).json();
  assert.ok(r.cases.every((c) => c.user.id === 'u-odd' && c.type === 'ban'));
  assert.equal(r.total, 20);
  r = await (await h.api('GET', `/api/servers/${SERVER}/cases?page=-5`, cookie)).json();
  assert.equal(r.page, 1);
  assert.equal((await h.api('GET', `/api/servers/${SERVER}/cases?user=${encodeURIComponent('a b')}`, cookie)).status, 400);
});

test('public page change: validation, slug conflict and job', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.pushSnapshot();
  await h.grant(cookie);
  await h.bot('PUT', `/bot/public/${OTHER_SERVER}`, { enabled: true, slug: 'taken-slug', name: 'Other', levels: [], economy: [], wrapped: null, updatedAt: h.clock.t });
  assert.equal((await h.api('PATCH', `/api/servers/${SERVER}/public`, cookie, { enabled: 'on' })).status, 400);
  assert.equal((await h.api('PATCH', `/api/servers/${SERVER}/public`, cookie, { enabled: true, slug: 'no' })).status, 400);
  assert.equal((await h.api('PATCH', `/api/servers/${SERVER}/public`, cookie, { enabled: true, slug: 'Bad Slug!' })).status, 400);
  const conflict = await h.api('PATCH', `/api/servers/${SERVER}/public`, cookie, { enabled: true, slug: 'taken-slug' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'slug_taken');
  const res = await h.api('PATCH', `/api/servers/${SERVER}/public`, cookie, { enabled: true, slug: 'My-Server' });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const { jobs } = await h.poll();
  assert.deepEqual(jobs.find((j) => j.id === job).data, { app: 'system', settings: { publicPage: { enabled: true, slug: 'my-server' } } });
});

test('rate limits: 60 api requests and 20 changes per minute per session', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  for (let i = 0; i < 60; i++) assert.equal((await h.api('GET', '/api/me', cookie)).status, 200);
  const blocked = await h.api('GET', '/api/me', cookie);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'rate_limited');
  advance(h, MIN);
  await h.pushSnapshot();
  await h.grant(cookie);
  let accepted = 0;
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, { enabled: i % 2 === 0 });
    if (r.status === 202) {
      accepted++;
      const { job } = await r.json();
      await h.poll();
      await h.answer([{ id: job, ok: true, result: { grant: true, level: 'admin', applied: {}, errors: {} } }]);
    }
    if (r.status === 429) limited++;
  }
  assert.equal(accepted, 20);
  assert.equal(limited, 5);
  const other = await h.login(USERS.bob);
  assert.equal((await h.api('GET', '/api/me', other.cookie)).status, 200);
});

test('unknown api routes and methods answer with friendly JSON', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const nf = await h.api('GET', '/api/nope', cookie);
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).error, 'not_found');
  assert.equal((await h.api('GET', '/api/servers/bad%20id', cookie)).status, 400);
  assert.equal((await h.request('OPTIONS', '/api/me', { headers: { Cookie: cookie } })).status, 405);
});

const uuid = (i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
const jobCount = (h) => h.db.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;

test('server ids must be full UUIDs, so short ids cannot reach the bot', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  for (const sid of ['0', 'a', '5', 'abc', SERVER.slice(0, 35), `${SERVER}0`]) {
    assert.equal((await h.api('GET', `/api/servers/${sid}`, cookie)).status, 400, sid);
  }
  assert.equal(jobCount(h), 0);
  assert.equal((await h.api('GET', `/api/servers/${SERVER}`, cookie)).status, 202);
});

test('one user can only have a few open jobs at once', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  for (let i = 0; i < 5; i++) assert.equal((await h.api('GET', `/api/servers/${uuid(i)}`, cookie)).status, 202);
  const busy = await h.api('GET', `/api/servers/${uuid(5)}`, cookie);
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error, 'busy');
  assert.equal(jobCount(h), 5);
  const again = await h.api('GET', `/api/servers/${uuid(0)}`, cookie);
  assert.equal(again.status, 202, 'a repeat of an open access job is still answered with that job');
  const bob = await h.login(USERS.bob);
  assert.equal((await h.api('GET', `/api/servers/${uuid(9)}`, bob.cookie)).status, 202);
  const { jobs } = await h.poll();
  await h.answer(jobs.map((j) => ({ id: j.id, ok: true, result: { grant: false, level: 'member' } })));
  assert.equal((await h.api('GET', `/api/servers/${uuid(6)}`, cookie)).status, 202);
});

test('api limits also count per user, across sessions', async () => {
  const h = createHarness();
  const a = await h.login(USERS.alice);
  const b = await h.login(USERS.alice);
  for (let i = 0; i < 60; i++) assert.equal((await h.api('GET', '/api/me', a.cookie)).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await h.api('GET', '/api/me', b.cookie)).status, 200);
  assert.equal((await h.api('GET', '/api/me', b.cookie)).status, 429);
  const bob = await h.login(USERS.bob);
  assert.equal((await h.api('GET', '/api/me', bob.cookie)).status, 200);
});

test('a refused access check is remembered for 5 minutes instead of asking the bot again', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const { job } = await (await h.api('GET', `/api/servers/${SERVER}`, cookie)).json();
  await h.poll();
  await h.answer([{ id: job, ok: true, result: { grant: false, level: 'member' } }]);
  const before = jobCount(h);
  for (const path of [`/api/servers/${SERVER}`, `/api/servers/${SERVER}/cases`]) {
    const res = await h.api('GET', path, cookie);
    assert.equal(res.status, 403, path);
    const body = await res.json();
    assert.equal(body.error, 'no_access');
    assert.match(body.message, /admin/);
    assert.equal(body.result.grant, false);
  }
  assert.equal((await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, { enabled: true })).status, 403);
  assert.equal(jobCount(h), before);
  advance(h, 5 * MIN + 1);
  assert.equal((await h.api('GET', `/api/servers/${SERVER}`, cookie)).status, 202);
  assert.equal(jobCount(h), before + 1);
  const { jobs } = await h.poll();
  await h.answer([{ id: jobs[0].id, ok: true, result: { grant: true, level: 'admin' } }]);
  const g = h.db.raw.prepare('SELECT level FROM grants WHERE user_id = ? AND server_id = ?').get(USERS.alice.id, SERVER);
  assert.equal(g.level, 'admin');
});
