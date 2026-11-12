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

const NEW_ROUTES = [
  ['GET', `/api/servers/${SERVER}/members`],
  ['POST', `/api/servers/${SERVER}/members/${USERS.bob.id}/actions`, { action: 'kick' }],
  ['GET', `/api/servers/${SERVER}/tickets`],
  ['GET', `/api/servers/${SERVER}/tickets/7`],
  ['POST', `/api/servers/${SERVER}/tickets/7/actions`, { action: 'claim' }],
];
const NEW_TYPES = ['members', 'modaction', 'tickets', 'ticket', 'ticketaction'];

const typeCount = (h, types) => h.db.raw.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type IN (${types.map(() => '?').join(', ')})`).get(...types).n;

async function ready(h, user = USERS.alice) {
  const { cookie } = await h.login(user);
  await h.pushSnapshot();
  await h.grant(cookie);
  return cookie;
}

async function enqueued(h, cookie, method, path, body) {
  const res = await h.api(method, path, cookie, body);
  assert.equal(res.status, 202, `${method} ${path}`);
  const out = await res.json();
  assert.equal(out.pending, true);
  const job = await h.take(out.job);
  assert.ok(job, 'the bot gets the job');
  assert.equal(job.server_id, SERVER);
  assert.equal(job.user_id, USERS.alice.id);
  return job;
}

test('members list: query becomes a members job with defaults', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const plain = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/members`);
  assert.equal(plain.type, 'members');
  assert.deepEqual(plain.data, { sort: 'joined_new', page: 1 });
  const full = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/members?q=${encodeURIComponent('  Bob  ')}&role=role-1&sort=name&page=3`);
  assert.deepEqual(full.data, { q: 'Bob', role: 'role-1', sort: 'name', page: 3 });
  const empty = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/members?q=&role=&sort=&page=`);
  assert.deepEqual(empty.data, { sort: 'joined_new', page: 1 });
  const long = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/members?q=${'x'.repeat(300)}`);
  assert.equal(long.data.q.length, 100);
  const oldest = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/members?sort=joined_old&page=100`);
  assert.deepEqual(oldest.data, { sort: 'joined_old', page: 100 });
});

test('members list: bad filters are refused before any job', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const before = jobCount(h);
  for (const qs of ['sort=random', 'sort=JOINED_NEW', 'page=0', 'page=101', 'page=abc', 'page=1.5', 'page=-1', 'page=1e2', 'role=bad%20id', `role=${'a'.repeat(65)}`]) {
    const res = await h.api('GET', `/api/servers/${SERVER}/members?${qs}`, cookie);
    assert.equal(res.status, 400, qs);
    const body = await res.json();
    assert.ok(['bad_request', 'bad_id'].includes(body.error), qs);
    assert.equal(typeof body.message, 'string');
  }
  assert.equal(jobCount(h), before);
});

test('member actions: every action becomes a modaction job with only the allowed fields', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const path = `/api/servers/${SERVER}/members/${USERS.bob.id}/actions`;
  const cases = [
    [{ action: 'warn', reason: '  spam  ' }, { action: 'warn', reason: 'spam' }],
    [{ action: 'timeout', duration: '10m', reason: 'cool off' }, { action: 'timeout', duration: '10m', reason: 'cool off' }],
    [{ action: 'untimeout' }, { action: 'untimeout' }],
    [{ action: 'kick', reason: null }, { action: 'kick' }],
    [{ action: 'ban', duration: '7d', reason: 'raid' }, { action: 'ban', duration: '7d', reason: 'raid' }],
    [{ action: 'unban' }, { action: 'unban' }],
    [{ action: 'unwarn', case: 12 }, { action: 'unwarn', case: 12 }],
    [{ action: 'role_add', role_id: 'role-1' }, { action: 'role_add', role_id: 'role-1' }],
    [{ action: 'role_remove', role_id: 'role-1' }, { action: 'role_remove', role_id: 'role-1' }],
    [{ action: 'nick', nickname: 'Bobby' }, { action: 'nick', nickname: 'Bobby' }],
    [{ action: 'nick', nickname: '' }, { action: 'nick', nickname: '' }],
    [{ action: 'note', note: 'Asked nicely twice.' }, { action: 'note', note: 'Asked nicely twice.' }],
  ];
  for (const [body, data] of cases) {
    const job = await enqueued(h, cookie, 'POST', path, body);
    assert.equal(job.type, 'modaction');
    assert.deepEqual(job.data, { user_id: USERS.bob.id, ...data }, JSON.stringify(body));
    await h.answer([{ id: job.id, ok: true, result: { grant: true, level: 'admin', ok: true, action: data.action, case: null, message: 'Done.' } }]);
  }
});

test('member actions: strict body validation', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const path = `/api/servers/${SERVER}/members/${USERS.bob.id}/actions`;
  const before = jobCount(h);
  const bad = [
    {},
    { action: 'nuke' },
    { action: 'WARN' },
    { action: ['warn'] },
    { action: 'warn', extra: 1 },
    { action: 'warn', user_id: USERS.alice.id },
    { action: 'warn', reason: 'x'.repeat(501) },
    { action: 'warn', reason: 5 },
    { action: 'timeout' },
    { action: 'timeout', duration: '' },
    { action: 'timeout', duration: 'x'.repeat(21) },
    { action: 'nick' },
    { action: 'nick', nickname: 'x'.repeat(33) },
    { action: 'note' },
    { action: 'note', note: '   ' },
    { action: 'note', note: 'x'.repeat(501) },
    { action: 'role_add' },
    { action: 'role_add', role_id: 'bad id' },
    { action: 'role_remove', role_id: 7 },
    { action: 'unwarn' },
    { action: 'unwarn', case: 0 },
    { action: 'unwarn', case: 1.5 },
    { action: 'unwarn', case: '3' },
    { action: 'unwarn', case: 1e9 + 1 },
  ];
  for (const [i, body] of bad.entries()) {
    if (i % 15 === 14) advance(h, MIN);
    const res = await h.api('POST', path, cookie, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = await res.json();
    assert.ok(['bad_request', 'bad_id'].includes(out.error), JSON.stringify(body));
    assert.equal(typeof out.message, 'string');
  }
  advance(h, MIN);
  assert.equal((await h.api('POST', path, cookie, '{"action":"warn","__proto__":{"x":1}}')).status, 400);
  assert.equal((await h.api('POST', path, cookie, '["warn"]')).status, 400);
  assert.equal((await h.api('POST', path, cookie, { action: 'warn', reason: 'x'.repeat(70 * 1024) })).status, 413);
  for (const uid of ['bad%20id', 'a'.repeat(65)]) {
    assert.equal((await h.api('POST', `/api/servers/${SERVER}/members/${uid}/actions`, cookie, { action: 'kick' })).status, 400, uid);
  }
  assert.equal((await h.api('GET', path, cookie)).status, 404);
  assert.equal((await h.api('PATCH', path, cookie, { action: 'kick' })).status, 404);
  assert.equal(jobCount(h), before);
});

test('tickets list: query becomes a tickets job with defaults', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const plain = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets`);
  assert.equal(plain.type, 'tickets');
  assert.deepEqual(plain.data, { status: 'open', page: 1 });
  const full = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets?status=closed&q=refund&page=2`);
  assert.deepEqual(full.data, { status: 'closed', q: 'refund', page: 2 });
  const all = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets?status=all`);
  assert.equal(all.data.status, 'all');
  const before = jobCount(h);
  for (const qs of ['status=pending', 'status=OPEN', 'page=0', 'page=101', 'page=x']) {
    const res = await h.api('GET', `/api/servers/${SERVER}/tickets?${qs}`, cookie);
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.equal(jobCount(h), before);
});

test('ticket detail: the number must be a whole number from 1 to 1e9', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const job = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets/42`);
  assert.equal(job.type, 'ticket');
  assert.deepEqual(job.data, { number: 42 });
  const top = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets/1000000000`);
  assert.deepEqual(top.data, { number: 1e9 });
  const before = jobCount(h);
  for (const n of ['0', '-1', 'abc', '1e3', '1.5', '1000000001', '12345678901', '%20', '9'.repeat(30)]) {
    const res = await h.api('GET', `/api/servers/${SERVER}/tickets/${n}`, cookie);
    assert.equal(res.status, 400, n);
    assert.equal((await res.json()).error, 'bad_id');
  }
  assert.equal(jobCount(h), before);
});

test('ticket actions: enqueue and strict body validation', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const path = `/api/servers/${SERVER}/tickets/7/actions`;
  const good = [
    [{ action: 'claim' }, { action: 'claim' }],
    [{ action: 'unclaim' }, { action: 'unclaim' }],
    [{ action: 'close', reason: ' solved ' }, { action: 'close', reason: 'solved' }],
  ];
  for (const [body, data] of good) {
    const job = await enqueued(h, cookie, 'POST', path, body);
    assert.equal(job.type, 'ticketaction');
    assert.deepEqual(job.data, { number: 7, ...data });
    await h.answer([{ id: job.id, ok: true, result: { grant: true, level: 'admin', ok: true, message: 'Done.' } }]);
  }
  const before = jobCount(h);
  const bad = [{}, { action: 'delete' }, { action: 'close', reason: 'x'.repeat(501) }, { action: 'close', reason: 1 }, { action: 'claim', number: 8 }, { action: 'claim', user_id: USERS.bob.id }];
  for (const body of bad) {
    const res = await h.api('POST', path, cookie, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.equal((await h.api('POST', `/api/servers/${SERVER}/tickets/0/actions`, cookie, { action: 'claim' })).status, 400);
  assert.equal((await h.api('POST', `/api/servers/${SERVER}/tickets/x/actions`, cookie, { action: 'claim' })).status, 400);
  assert.equal((await h.api('GET', path, cookie)).status, 404);
  assert.equal(jobCount(h), before);
});

test('member and ticket actions need same Origin and X-YapOS', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const posts = NEW_ROUTES.filter((r) => r[0] === 'POST');
  for (const [method, path, body] of posts) {
    for (const extra of [{ Origin: null }, { Origin: 'https://evil.example' }, { 'X-YapOS': null }, { 'X-YapOS': '0' }]) {
      const res = await h.api(method, path, cookie, body, extra);
      assert.equal(res.status, 403, `${path} ${JSON.stringify(extra)}`);
      assert.equal((await res.json()).error, 'forbidden');
    }
  }
  assert.equal(typeCount(h, NEW_TYPES), 0);
});

test('new routes need a grant and never reach the bot without one', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  for (const [method, path, body] of NEW_ROUTES) {
    const res = await h.api(method, path, cookie, body);
    assert.equal(res.status, 403, path);
    const out = await res.json();
    assert.equal(out.error, 'grant_required');
    assert.ok(out.job);
  }
  assert.equal(typeCount(h, NEW_TYPES), 0);
  const { jobs } = await h.poll();
  assert.ok(jobs.length > 0);
  assert.ok(jobs.every((j) => j.type === 'access'));
  await h.answer(jobs.map((j) => ({ id: j.id, ok: true, result: { grant: false, level: 'member' } })));
  for (const [method, path, body] of NEW_ROUTES) {
    const res = await h.api(method, path, cookie, body);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).error, 'no_access');
  }
  assert.equal(typeCount(h, NEW_TYPES), 0);
});

test('IDOR: new routes are per user and per server', async () => {
  const h = createHarness();
  const a = await h.login(USERS.alice);
  const b = await h.login(USERS.bob);
  await h.pushSnapshot();
  await h.grant(a.cookie);
  for (const [method, path, body] of NEW_ROUTES) {
    const bob = await h.api(method, path, b.cookie, body);
    assert.equal(bob.status, 403, `bob ${path}`);
    const other = await h.api(method, path.replace(SERVER, OTHER_SERVER), a.cookie, body);
    assert.equal(other.status, 403, `other ${path}`);
  }
  assert.equal(typeCount(h, NEW_TYPES), 0);
  const { jobs: access } = await h.poll();
  await h.answer(access.map((j) => ({ id: j.id, ok: true, result: { grant: false, level: 'member' } })));
  const res = await h.api('POST', `/api/servers/${SERVER}/members/${USERS.bob.id}/actions`, a.cookie, { action: 'kick' });
  const { job } = await res.json();
  const taken = await h.take(job);
  await h.answer([{ id: taken.id, ok: true, result: { grant: true, level: 'admin', ok: true, action: 'kick', message: 'Kicked.' } }]);
  assert.equal((await h.api('GET', `/api/jobs/${job}`, b.cookie)).status, 404);
  assert.equal((await h.settle(a.cookie, job)).status, 'done');
});

test('new job results are only readable with a fresh grant', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const ids = [];
  for (const [method, path, body] of NEW_ROUTES) {
    const { job } = await (await h.api(method, path, cookie, body)).json();
    ids.push(job);
  }
  const { jobs } = await h.poll();
  assert.equal(jobs.length, NEW_ROUTES.length);
  assert.deepEqual(jobs.map((j) => j.type).sort(), [...NEW_TYPES].sort());
  await h.answer(jobs.map((j) => ({ id: j.id, ok: true, result: { grant: true, level: 'admin', ok: true } })));
  for (const job of ids) assert.equal((await h.settle(cookie, job)).status, 'done');
  advance(h, 5 * MIN + 1);
  for (const job of ids) {
    const res = await h.api('GET', `/api/jobs/${job}`, cookie);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'grant_required');
  }
});

test('new job results refresh the grant, and a refusal revokes it', async () => {
  const h = createHarness();
  const cookie = await ready(h);
  const path = `/api/servers/${SERVER}/members/${USERS.bob.id}/actions`;
  const first = await enqueued(h, cookie, 'POST', path, { action: 'warn', reason: 'spam' });
  advance(h, 4 * MIN);
  await h.answer([{ id: first.id, ok: true, result: { grant: true, level: 'owner', ok: false, error: 'I cannot act on the server owner.' } }]);
  advance(h, 2 * MIN);
  const done = await h.settle(cookie, first.id);
  assert.equal(done.status, 'done', 'a refused action is still a finished job');
  assert.equal(done.result.ok, false);
  assert.match(done.result.error, /owner/);
  const g = h.db.raw.prepare('SELECT level FROM grants WHERE user_id = ? AND server_id = ?').get(USERS.alice.id, SERVER);
  assert.equal(g.level, 'owner');
  const second = await enqueued(h, cookie, 'GET', `/api/servers/${SERVER}/tickets`);
  await h.answer([{ id: second.id, ok: false, result: { grant: false, level: 'mod' }, error: 'You need to be an admin of this server.' }]);
  const refused = await h.settle(cookie, second.id);
  assert.equal(refused.status, 'error');
  assert.equal(refused.result.grant, false);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE level != 'none'").get().n, 0);
  const after = await h.api('POST', path, cookie, { action: 'kick' });
  assert.equal(after.status, 403);
  assert.equal((await after.json()).error, 'no_access');
});

test('a new search replaces the same user\'s older pending search', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.grant(cookie, SERVER, 'admin');
  const first = await (await h.api('GET', `/api/servers/${SERVER}/members?q=al`, cookie)).json();
  const second = await (await h.api('GET', `/api/servers/${SERVER}/members?q=ali`, cookie)).json();
  assert.ok(first.job && second.job && first.job !== second.job);
  const old = await (await h.api('GET', `/api/jobs/${first.job}`, cookie)).json();
  assert.equal(old.status, 'error');
  assert.match(old.message, /newer request/);
  const fresh = await (await h.api('GET', `/api/jobs/${second.job}`, cookie)).json();
  assert.equal(fresh.status, 'pending');
});
