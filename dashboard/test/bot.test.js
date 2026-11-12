import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS, SERVER, OTHER_SERVER, BOT_SECRET } from './helpers.js';

const MIN = 60 * 1000;

test('bot endpoints refuse a missing or wrong secret', async () => {
  const h = createHarness();
  for (const secret of [null, 'wrong', BOT_SECRET.slice(0, -1), `${BOT_SECRET}x`, '']) {
    const res = await h.bot('GET', '/bot/poll', undefined, secret);
    assert.equal(res.status, 401, String(secret));
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
    assert.ok(!JSON.stringify(body).includes(BOT_SECRET));
  }
  const basic = await h.request('GET', '/bot/poll', { headers: { Authorization: `Basic ${BOT_SECRET}` } });
  assert.equal(basic.status, 401);
  assert.equal((await h.bot('PUT', `/bot/snapshot/${SERVER}`, { overview: {} }, 'wrong')).status, 401);
  assert.equal((await h.bot('POST', '/bot/results', { results: [] }, 'wrong')).status, 401);
  assert.equal((await h.bot('DELETE', `/bot/public/${SERVER}`, undefined, 'wrong')).status, 401);
});

test('bot endpoints are off when BOT_SECRET is missing or too short', async () => {
  for (const BOT_SECRET_VALUE of [undefined, 'short']) {
    const h = createHarness({ BOT_SECRET: BOT_SECRET_VALUE });
    const res = await h.bot('GET', '/bot/poll', undefined, BOT_SECRET_VALUE || 'anything');
    assert.equal(res.status, 503);
  }
});

test('bot calls over plain http are refused except on localhost', async () => {
  const h = createHarness();
  const res = await h.request('GET', 'http://dash.example.test/bot/poll', { headers: { Authorization: `Bearer ${BOT_SECRET}` } });
  assert.equal(res.status, 403);
  const local = await h.request('GET', 'http://localhost:8787/bot/poll', { headers: { Authorization: `Bearer ${BOT_SECRET}` } });
  assert.equal(local.status, 200);
});

test('poll claims at most 25 jobs, oldest first, and never twice', async () => {
  const h = createHarness();
  for (let i = 0; i < 30; i++) {
    h.db.raw
      .prepare("INSERT INTO jobs (id, type, user_id, server_id, data, status, created, updated) VALUES (?, 'member', ?, ?, ?, 'pending', ?, ?)")
      .run(`job-${String(i).padStart(2, '0')}`, USERS.alice.id, SERVER, JSON.stringify({ user_id: 'x' }), h.clock.t + i, h.clock.t + i);
  }
  advance(h, 100);
  const first = await h.poll();
  assert.equal(first.jobs.length, 25);
  assert.equal(first.jobs[0].id, 'job-00');
  assert.equal(first.jobs[24].id, 'job-24');
  assert.deepEqual(first.jobs[0].data, { user_id: 'x' });
  assert.equal(first.hot, false);
  const second = await h.poll();
  assert.equal(second.jobs.length, 5);
  assert.equal((await h.poll()).jobs.length, 0);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'claimed'").get().n, 30);
});

test('poll expires jobs older than 2 minutes', async () => {
  const h = createHarness();
  h.db.raw.prepare("INSERT INTO jobs (id, type, user_id, data, status, created, updated) VALUES ('old', 'servers', ?, '{}', 'pending', ?, ?)").run(USERS.alice.id, h.clock.t, h.clock.t);
  advance(h, 2 * MIN + 1);
  const { jobs } = await h.poll();
  assert.equal(jobs.length, 0);
  const row = h.db.raw.prepare("SELECT status, error FROM jobs WHERE id = 'old'").get();
  assert.deepEqual({ ...row }, { status: 'error', error: 'timeout' });
});

test('hot is true only when a session used the api in the last 2 minutes', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  assert.equal((await h.poll()).hot, false);
  await h.api('GET', '/api/me', cookie);
  assert.equal((await h.poll()).hot, true);
  advance(h, 2 * MIN + 1);
  assert.equal((await h.poll()).hot, false);
});

test('results ignore unknown jobs and validate the body', async () => {
  const h = createHarness();
  const r = await h.answer([{ id: 'missing', ok: true }, { nope: 1 }, 'x']);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.stored, 0);
  assert.equal(body.ignored.length, 3);
  assert.equal((await h.bot('POST', '/bot/results', { results: 'x' })).status, 400);
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `j${i}`, ok: true }));
  assert.equal((await h.bot('POST', '/bot/results', { results: many })).status, 413);
});

test('results for timed out jobs still land', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const { job } = await (await h.api('GET', `/api/servers/${SERVER}`, cookie)).json();
  await h.poll();
  advance(h, 2 * MIN + 1);
  await h.poll();
  await h.answer([{ id: job, ok: true, result: { grant: true, level: 'owner' } }]);
  const g = h.db.raw.prepare('SELECT level FROM grants WHERE user_id = ? AND server_id = ?').get(USERS.alice.id, SERVER);
  assert.equal(g.level, 'owner');
});

test('snapshot parts over 512 KB are refused with 413', async () => {
  const h = createHarness();
  const big = 'x'.repeat(512 * 1024);
  const res = await h.bot('PUT', `/bot/snapshot/${SERVER}`, { overview: { id: SERVER }, settings: { blob: big } });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'too_large');
  assert.equal(body.part, 'settings');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
  const huge = await h.bot('PUT', `/bot/snapshot/${SERVER}`, { overview: { a: big }, apps: [big], settings: { b: big }, cases: [big], extra: big });
  assert.equal(huge.status, 413);
  const ok = await h.bot('PUT', `/bot/snapshot/${SERVER}`, { overview: { id: SERVER, blob: 'y'.repeat(500 * 1024) }, cases: [] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).parts, ['overview', 'cases']);
  assert.equal((await h.bot('PUT', `/bot/snapshot/${SERVER}`, { apps: {} })).status, 400);
  assert.equal((await h.bot('PUT', `/bot/snapshot/${SERVER}`, {})).status, 400);
  assert.equal((await h.bot('PUT', '/bot/snapshot/bad%20id', { apps: [] })).status, 400);
  const tooMany = Array.from({ length: 2001 }, (_, n) => ({ n }));
  assert.equal((await h.bot('PUT', `/bot/snapshot/${SERVER}`, { cases: tooMany })).status, 413);
});

test('public pages: publish, read, conflict, unpublish', async () => {
  const h = createHarness();
  const page = {
    enabled: true,
    slug: 'cool-server',
    name: 'Cool Server',
    icon: 'https://files.yapper.website/i.png',
    levels: [{ rank: 1, id: 'u1', name: 'A', level: 5, xp: 100, messages: 20 }],
    economy: [{ rank: 1, id: 'u1', name: 'A', balance: 50 }],
    wrapped: { month: '2026-10' },
    updatedAt: h.clock.t,
  };
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, page)).status, 200);
  const res = await h.request('GET', '/api/public/cool-server');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  const data = await res.json();
  assert.equal(data.name, 'Cool Server');
  assert.equal(data.levels[0].xp, 100);
  assert.equal(data.economy[0].balance, 50);
  assert.deepEqual(data.wrapped, { month: '2026-10' });
  assert.ok(!('server_id' in data));
  const clash = await h.bot('PUT', `/bot/public/${OTHER_SERVER}`, { ...page, name: 'Other' });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).error, 'slug_taken');
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, slug: 'Cool' })).status, 400);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, slug: 'ab' })).status, 400);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, enabled: 'yes' })).status, 400);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, levels: 'x' })).status, 400);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, levels: [{ big: 'x'.repeat(520 * 1024) }] })).status, 413);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, slug: 'renamed' })).status, 200);
  assert.equal((await h.request('GET', '/api/public/cool-server')).status, 404);
  assert.equal((await h.request('GET', '/api/public/renamed')).status, 200);
  assert.equal((await h.bot('PUT', `/bot/public/${OTHER_SERVER}`, { ...page, name: 'Other' })).status, 200);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, slug: 'renamed', enabled: false })).status, 200);
  const hidden = await h.request('GET', '/api/public/renamed');
  assert.equal(hidden.status, 404);
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, { ...page, slug: 'renamed' })).status, 200);
  const del = await h.bot('DELETE', `/bot/public/${SERVER}`);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, removed: true });
  assert.equal((await h.request('GET', '/api/public/renamed')).status, 404);
  assert.equal((await h.request('GET', '/api/public/cool%2Fserver')).status, 404);
  assert.equal((await h.request('GET', '/api/public/cool-server/extra')).status, 404);
  assert.equal((await h.request('POST', '/api/public/cool-server')).status, 405);
});

test('public reads are rate limited per IP', async () => {
  const h = createHarness();
  for (let i = 0; i < 120; i++) await h.request('GET', '/api/public/none-here', { ip: '192.0.2.9' });
  assert.equal((await h.request('GET', '/api/public/none-here', { ip: '192.0.2.9' })).status, 429);
});

test('poll shares a batch fairly between users so one user cannot starve the others', async () => {
  const h = createHarness();
  for (let i = 0; i < 30; i++) {
    h.db.raw
      .prepare("INSERT INTO jobs (id, type, user_id, server_id, data, status, created, updated) VALUES (?, 'access', ?, ?, '{}', 'pending', ?, ?)")
      .run(`flood-${String(i).padStart(2, '0')}`, USERS.bob.id, SERVER, h.clock.t + i, h.clock.t + i);
  }
  h.db.raw
    .prepare("INSERT INTO jobs (id, type, user_id, server_id, data, status, created, updated) VALUES ('real-admin', 'change', ?, ?, '{}', 'pending', ?, ?)")
    .run(USERS.alice.id, SERVER, h.clock.t + 50, h.clock.t + 50);
  advance(h, 100);
  const { jobs } = await h.poll();
  assert.equal(jobs.length, 25);
  assert.ok(jobs.some((j) => j.id === 'real-admin'));
  assert.equal(jobs.filter((j) => j.user_id === USERS.bob.id).length, 24);
});

test('bot routes refuse server ids that are not full UUIDs', async () => {
  const h = createHarness();
  for (const sid of ['0', 'abc', SERVER.slice(0, 35)]) {
    assert.equal((await h.bot('PUT', `/bot/snapshot/${sid}`, { apps: [] })).status, 400, sid);
    assert.equal((await h.bot('DELETE', `/bot/public/${sid}`)).status, 400, sid);
  }
});

test('a public page the bot stopped refreshing goes offline after 2 hours', async () => {
  const h = createHarness();
  const page = { enabled: true, slug: 'left-server', name: 'Left', levels: [], economy: [], wrapped: null, updatedAt: h.clock.t };
  assert.equal((await h.bot('PUT', `/bot/public/${SERVER}`, page)).status, 200);
  advance(h, 119 * MIN);
  assert.equal((await h.request('GET', '/api/public/left-server')).status, 200);
  advance(h, 2 * MIN);
  assert.equal((await h.request('GET', '/api/public/left-server')).status, 404);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM public_pages').get().n, 0);
});
