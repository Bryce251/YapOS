import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS, SERVER, INDEX_HTML } from './helpers.js';
import { CSP } from '../worker/security.js';
import worker from '../worker/index.js';

const DAY = 24 * 3600 * 1000;

function checkHeaders(res, label) {
  assert.equal(res.headers.get('Content-Security-Policy'), CSP, label);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(res.headers.get('Referrer-Policy'), 'same-origin', label);
  assert.match(res.headers.get('Permissions-Policy') || '', /camera=\(\)/, label);
}

test('the default export is a module worker with fetch and scheduled', () => {
  assert.equal(typeof worker.fetch, 'function');
  assert.equal(typeof worker.scheduled, 'function');
});

test('CSP matches the contract exactly', () => {
  assert.equal(CSP, "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
});

test('security headers are on every kind of response', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const responses = {
    me: await h.api('GET', '/api/me', cookie),
    signedOut: await h.api('GET', '/api/me'),
    csrf: await h.api('PATCH', `/api/servers/${SERVER}/apps/mod`, cookie, { enabled: true }, { Origin: 'https://evil.example' }),
    login: await h.request('GET', '/auth/login'),
    callback: await h.request('GET', '/auth/callback?error=access_denied'),
    bot: await h.bot('GET', '/bot/poll', undefined, 'wrong'),
    spa: await h.request('GET', '/servers'),
    missing: await h.request('GET', '/nope'),
    publicPage: await h.request('GET', '/api/public/nothing'),
  };
  for (const [label, res] of Object.entries(responses)) checkHeaders(res, label);
  assert.equal(responses.me.headers.get('Cache-Control'), 'no-store');
  assert.match(responses.me.headers.get('Strict-Transport-Security'), /max-age=/);
});

test('SPA fallback serves index.html for /servers* and /p/* only', async () => {
  const h = createHarness();
  for (const p of ['/servers', `/servers/${SERVER}`, `/servers/${SERVER}/apps/mod`, '/p/cool-server', '/p/a/b']) {
    const res = await h.request('GET', p);
    assert.equal(res.status, 200, p);
    assert.equal(await res.text(), INDEX_HTML);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
  }
  for (const p of ['/serversx', '/p/', '/p', '/admin', '/auth/whatever']) {
    const res = await h.request('GET', p);
    assert.equal(res.status, 404, p);
  }
  const head = await h.request('HEAD', '/servers');
  assert.equal(head.status, 200);
  assert.equal((await h.request('POST', '/servers')).status, 404);
});

test('internal errors are friendly JSON without stack traces', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  h.db.raw.exec('DROP TABLE grants');
  const res = await h.api('GET', `/api/servers/${SERVER}`, cookie);
  assert.equal(res.status, 500);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.error, 'server_error');
  assert.ok(!/at |\.js|sqlite|grants/i.test(text));
  assert.equal(h.logs.length, 1);
  assert.ok(!h.logs[0].includes('test-secret'));
});

test('missing DB binding gives a friendly 503', async () => {
  const h = createHarness({ DB: undefined });
  const res = await h.request('GET', '/api/me');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

test('cleanup cron removes expired sessions, states, old jobs and old rate rows', async () => {
  const h = createHarness();
  const t0 = h.clock.t;
  const keep = await h.login(USERS.alice);
  h.db.raw.prepare("INSERT INTO sessions (id_hash, user_id, username, created, expires, last_seen) VALUES ('old', 'u', 'u', 0, ?, 0)").run(t0 - 1);
  h.db.raw.prepare("INSERT INTO oauth_states (state, next, created) VALUES ('s-old', '/', ?)").run(t0 - 11 * 60 * 1000);
  h.db.raw.prepare("INSERT INTO oauth_states (state, next, created) VALUES ('s-new', '/', ?)").run(t0);
  h.db.raw.prepare("INSERT INTO jobs (id, type, user_id, data, status, created, updated) VALUES ('j-old', 'servers', 'u', '{}', 'done', ?, ?)").run(t0 - 2 * 3600 * 1000, t0);
  h.db.raw.prepare("INSERT INTO jobs (id, type, user_id, data, status, created, updated) VALUES ('j-stuck', 'servers', 'u', '{}', 'claimed', ?, ?)").run(t0 - 5 * 60 * 1000, t0);
  h.db.raw.prepare("INSERT INTO jobs (id, type, user_id, data, status, created, updated) VALUES ('j-new', 'servers', 'u', '{}', 'pending', ?, ?)").run(t0, t0);
  h.db.raw.prepare('INSERT INTO rate (key, "window", count) VALUES (\'r-old\', ?, 5)').run(Math.floor(t0 / 60000) - 10);
  h.db.raw.prepare('INSERT INTO rate (key, "window", count) VALUES (\'r-new\', ?, 5)').run(Math.floor(t0 / 60000));
  h.db.raw.prepare("INSERT INTO grants (user_id, server_id, level, confirmed_at) VALUES ('u', 's', 'admin', ?)").run(t0 - 2 * DAY);
  let waited = null;
  await h.worker.scheduled({ cron: '*/15 * * * *', scheduledTime: t0 }, h.env, { waitUntil(p) { waited = p; } });
  assert.ok(waited);
  const ids = (sql) => h.db.raw.prepare(sql).all().map((r) => Object.values(r)[0]).sort();
  assert.deepEqual(ids('SELECT state FROM oauth_states'), ['s-new']);
  assert.deepEqual(ids('SELECT id FROM jobs'), ['j-new', 'j-stuck']);
  assert.equal(h.db.raw.prepare("SELECT status FROM jobs WHERE id = 'j-stuck'").get().status, 'error');
  assert.deepEqual(ids('SELECT key FROM rate').filter((k) => k.startsWith('r-')), ['r-new']);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  assert.equal((await h.api('GET', '/api/me', keep.cookie)).status, 200);
  advance(h, 31 * DAY);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('SQL is always parameterised', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  await h.api('GET', `/api/servers/${SERVER}/cases?q=${encodeURIComponent("'; DROP TABLE jobs; --")}`, cookie);
  await h.request('GET', `/api/public/${encodeURIComponent("x' OR 1=1 --")}`);
  for (const sql of h.db.queries) {
    assert.ok(!sql.includes('DROP'), sql);
    assert.ok(!sql.includes(USERS.alice.id), sql);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM jobs').get().n >= 0, true);
});

test('cleanup cron removes stale public pages and day-old snapshots', async () => {
  const h = createHarness();
  const t0 = h.clock.t;
  const add = h.db.raw.prepare('INSERT INTO public_pages (server_id, slug, data, updated) VALUES (?, ?, ?, ?)');
  add.run('p-old', 'old-page', '{"enabled":true}', t0 - 3 * 3600 * 1000);
  add.run('p-new', 'new-page', '{"enabled":true}', t0 - 30 * 60 * 1000);
  const snap = h.db.raw.prepare("INSERT INTO snapshots (server_id, part, data, updated) VALUES (?, 'cases', '[]', ?)");
  snap.run('s-old', t0 - 2 * DAY);
  snap.run('s-new', t0 - 3600 * 1000);
  await h.worker.scheduled({}, h.env, {});
  const ids = (sql) => h.db.raw.prepare(sql).all().map((r) => Object.values(r)[0]).sort();
  assert.deepEqual(ids('SELECT server_id FROM public_pages'), ['p-new']);
  assert.deepEqual(ids('SELECT server_id FROM snapshots'), ['s-new']);
});
