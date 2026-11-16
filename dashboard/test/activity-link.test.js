import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHarness, advance, USERS, ORIGIN } from './helpers.js';
import { normalizeCode, formatCode, newCode, CODE_ALPHABET, LINK_TTL, LINK_LIMITS, ACTIVITY_SESSION_TTL, MAX_PARTY_SESSIONS } from '../worker/activity-auth.js';
import { cleanup } from '../worker/cron.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function start(h, body = {}, ip) {
  const res = await h.request('POST', '/api/activity/link/start', { body, ip });
  return { res, data: await res.json() };
}

async function poll(h, token, ip) {
  const res = await h.request('POST', '/api/activity/link/poll', { body: { token }, ip });
  return { res, data: await res.json() };
}

async function approve(h, cookie, code, extra = {}) {
  const res = await h.api('POST', '/api/link/approve', cookie, { code, ...extra });
  return { res, data: await res.json() };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

test('codes use an unambiguous alphabet, about 40 bits, and forgive case, spaces and look-alike letters', () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(/[ILOU]/.test(CODE_ALPHABET), false);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const c = newCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 195);
  assert.equal(formatCode('K7QM2XPA'), 'K7QM-2XPA');
  assert.equal(normalizeCode(' k7qm-2xpa '), 'K7QM2XPA');
  assert.equal(normalizeCode('ABCD-EFGO'), 'ABCDEFG0');
  assert.equal(normalizeCode('ABCD-EFGI'), 'ABCDEFG1');
  assert.equal(normalizeCode('ABCD-EFGL'), 'ABCDEFG1');
  for (const bad of ['', 'ABC', 'ABCD-EFGU', 'ABCD-EFGHJ', null, 42, 'x'.repeat(40)]) assert.equal(normalizeCode(bad), null, String(bad));
});

test('start makes a code and a poll token, and stores only hashes that expire in 10 minutes', async () => {
  const h = createHarness();
  const { res, data } = await start(h, { expect: USERS.alice.id });
  assert.equal(res.status, 201);
  assert.match(data.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(data.expires, h.clock.t + LINK_TTL);
  assert.equal(data.link, `${ORIGIN}/link`);
  assert.ok(data.interval >= 2000);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const rows = h.db.raw.prepare('SELECT * FROM activity_links').all();
  assert.equal(rows.length, 1);
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(data.token), false);
  assert.equal(dump.includes(data.code.replace('-', '')), false);
  assert.equal(rows[0].expect, USERS.alice.id);
  assert.equal(rows[0].approved, null);
  const bad = await start(h, { expect: 'not a valid id!' });
  assert.equal(bad.res.status, 201);
  assert.equal(h.db.raw.prepare('SELECT expect FROM activity_links WHERE expect IS NULL').all().length, 1);
  const noBody = await h.request('POST', '/api/activity/link/start');
  assert.equal(noBody.status, 201);
  const wrongMethod = await h.request('GET', '/api/activity/link/start');
  assert.equal(wrongMethod.status, 405);
});

test('starting codes is rate limited per IP', async () => {
  const h = createHarness();
  for (let i = 0; i < LINK_LIMITS.start; i += 1) assert.equal((await start(h, {}, '198.51.100.9')).res.status, 201);
  const { res, data } = await start(h, {}, '198.51.100.9');
  assert.equal(res.status, 429);
  assert.match(data.message, /Wait a minute/);
  assert.equal((await start(h, {}, '198.51.100.10')).res.status, 201);
  advance(h, 61_000);
  assert.equal((await start(h, {}, '198.51.100.9')).res.status, 201);
});

test('the full sign-in: pending, approve, then the poll hands out a 30 day session exactly once', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const link = (await start(h, { expect: USERS.alice.id })).data;
  let p = await poll(h, link.token);
  assert.equal(p.res.status, 200);
  assert.deepEqual(p.data, { status: 'pending', expires: link.expires });
  const ok = await approve(h, cookie, link.code.toLowerCase());
  assert.equal(ok.res.status, 200);
  assert.equal(ok.data.user.id, USERS.alice.id);
  p = await poll(h, link.token);
  assert.equal(p.data.status, 'approved');
  assert.match(p.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(p.data.token, link.token);
  assert.equal(p.data.expires, h.clock.t + ACTIVITY_SESSION_TTL);
  assert.deepEqual(p.data.user, { id: USERS.alice.id, username: 'alice', display_name: 'Alice', avatar_url: USERS.alice.avatar_url });
  assert.equal(p.data.matches, true);
  const again = await poll(h, link.token);
  assert.deepEqual(again.data, { status: 'expired' });
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM activity_links').get().n, 0);
  const rows = h.db.raw.prepare('SELECT * FROM activity_sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id_hash, createHash('sha256').update(`party-session:${p.data.token}`).digest('hex'));
  assert.equal(JSON.stringify(rows).includes(p.data.token), false);
  assert.equal(rows[0].expires - rows[0].created, 30 * 24 * 3600 * 1000);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(rows[0].id_hash).n, 0, 'party sessions are not dashboard sessions');
  const dash = await h.request('GET', '/api/me', { headers: { Cookie: `yapos_session=${p.data.token}` } });
  assert.equal(dash.status, 401, 'a party token never opens the dashboard');
  const reuse = await approve(h, cookie, link.code);
  assert.equal(reuse.res.status, 404);
});

test('a code cannot be approved twice and a second approver cannot take it over', async () => {
  const h = createHarness();
  const alice = (await h.login(USERS.alice)).cookie;
  const bob = (await h.login(USERS.bob)).cookie;
  const link = (await start(h)).data;
  assert.equal((await approve(h, alice, link.code)).res.status, 200);
  const second = await approve(h, bob, link.code);
  assert.equal(second.res.status, 409);
  assert.equal(second.data.error, 'used');
  const p = await poll(h, link.token);
  assert.equal(p.data.user.id, USERS.alice.id);
  assert.equal(p.data.matches, null);
});

test('codes expire after 10 minutes with a friendly message, and approved codes wait a little for the poll', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const old = (await start(h)).data;
  advance(h, LINK_TTL + 1);
  const late = await approve(h, cookie, old.code);
  assert.equal(late.res.status, 410);
  assert.equal(late.data.error, 'expired');
  assert.match(late.data.message, /expired/);
  assert.deepEqual((await poll(h, old.token)).data, { status: 'expired' });
  const edge = (await start(h)).data;
  advance(h, LINK_TTL - 1000);
  assert.equal((await approve(h, cookie, edge.code)).res.status, 200);
  advance(h, 30_000);
  assert.equal((await poll(h, edge.token)).data.status, 'approved');
  const removed = await cleanup(h.db, h.clock.t + 365 * 24 * 3600 * 1000);
  assert.equal(removed.activitySessions, 1);
});

test('wrong codes get a friendly message and approving is limited per user and per IP', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const shape = await approve(h, cookie, 'nope');
  assert.equal(shape.res.status, 400);
  assert.equal(shape.data.error, 'bad_code');
  assert.match(shape.data.message, /8 letters and numbers/);
  const wrong = await approve(h, cookie, 'ZZZZ-ZZZZ');
  assert.equal(wrong.res.status, 404);
  assert.match(wrong.data.message, /didn't work/);
  for (let i = 2; i < LINK_LIMITS.approveUser; i += 1) await approve(h, cookie, 'ZZZZ-ZZZZ');
  const link = (await start(h)).data;
  const blocked = await approve(h, cookie, link.code);
  assert.equal(blocked.res.status, 429);
  assert.match(blocked.data.message, /Too many tries/);
  advance(h, 61_000);
  assert.equal((await approve(h, cookie, link.code)).res.status, 200);
  const h2 = createHarness();
  let n = 0;
  for (const u of ['alice', 'bob']) {
    const c = (await h2.login(USERS[u])).cookie;
    for (let i = 0; i < LINK_LIMITS.approveUser && n < LINK_LIMITS.approveIp; i += 1, n += 1) await approve(h2, c, 'ZZZZ-ZZZZ');
  }
  const third = (await h2.login({ id: '55555555-5555-4555-8555-555555555555', username: 'cara', display_name: 'Cara', avatar_url: null })).cookie;
  const ipBlocked = await approve(h2, third, 'ZZZZ-ZZZZ');
  assert.equal(ipBlocked.res.status, 429);
});

test('approve needs a dashboard session and passes the same CSRF checks as other changes', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const link = (await start(h)).data;
  const noOrigin = await h.api('POST', '/api/link/approve', cookie, { code: link.code }, { Origin: null });
  assert.equal(noOrigin.status, 403);
  const evil = await h.api('POST', '/api/link/approve', cookie, { code: link.code }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const noHeader = await h.api('POST', '/api/link/approve', cookie, { code: link.code }, { 'X-YapOS': null });
  assert.equal(noHeader.status, 403);
  const signedOut = await h.api('POST', '/api/link/approve', null, { code: link.code });
  assert.equal(signedOut.status, 401);
  const asGet = await h.api('GET', '/api/link/approve', cookie);
  assert.equal(asGet.status, 405);
  assert.equal((await poll(h, link.token)).data.status, 'pending');
});

test('a code from a call with a different Yapin account asks before it signs in', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.bob);
  const link = (await start(h, { expect: USERS.alice.id })).data;
  const first = await approve(h, cookie, link.code);
  assert.equal(first.res.status, 409);
  assert.equal(first.data.error, 'other_account');
  assert.match(first.data.message, /different Yapin' account/);
  assert.equal((await poll(h, link.token)).data.status, 'pending');
  const sure = await approve(h, cookie, link.code, { confirm: true });
  assert.equal(sure.res.status, 200);
  const p = await poll(h, link.token);
  assert.equal(p.data.user.id, USERS.bob.id);
  assert.equal(p.data.matches, false);
});

test('the bearer token signs in /api/activity/me and logout ends it', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const link = (await start(h)).data;
  await approve(h, cookie, link.code);
  const { token } = (await poll(h, link.token)).data;
  const me = await h.request('GET', '/api/activity/me', { headers: bearer(token) });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: { id: USERS.alice.id, username: 'alice', display_name: 'Alice', avatar_url: USERS.alice.avatar_url }, via: 'code' });
  const nobody = await h.request('GET', '/api/activity/me');
  assert.equal(nobody.status, 401);
  const junk = await h.request('GET', '/api/activity/me', { headers: bearer('x'.repeat(43)) });
  assert.equal(junk.status, 401);
  const viaCookie = await h.request('GET', '/api/activity/me', { headers: { Cookie: cookie } });
  assert.equal((await viaCookie.json()).via, 'dashboard');
  const out = await h.request('POST', '/api/activity/logout', { headers: bearer(token) });
  assert.equal(out.status, 200);
  assert.equal((await out.json()).ended, 1);
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(token) })).status, 401);
  assert.equal((await h.request('POST', '/api/activity/logout')).status, 401);
  advance(h, 1);
  const link2 = (await start(h)).data;
  await approve(h, cookie, link2.code);
  const t2 = (await poll(h, link2.token)).data.token;
  advance(h, ACTIVITY_SESSION_TTL + 1);
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(t2) })).status, 401);
});

test('the account page can count and end every YapOS Party sign-in', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const tokens = [];
  for (let i = 0; i < 2; i += 1) {
    const link = (await start(h)).data;
    await approve(h, cookie, link.code);
    tokens.push((await poll(h, link.token)).data.token);
  }
  const count = await h.api('GET', '/api/me/party-signins', cookie);
  assert.equal((await count.json()).count, 2);
  const blocked = await h.api('DELETE', '/api/me/party-signins', cookie, undefined, { Origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  const end = await h.api('DELETE', '/api/me/party-signins', cookie);
  assert.equal((await end.json()).ended, 2);
  for (const t of tokens) assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(t) })).status, 401);
});

test('polling rejects bad tokens and is rate limited', async () => {
  const h = createHarness();
  const bad = await h.request('POST', '/api/activity/link/poll', { body: { token: 'short' } });
  assert.equal(bad.status, 400);
  const unknown = await poll(h, 'a'.repeat(43));
  assert.deepEqual(unknown.data, { status: 'expired' });
  const link = (await start(h)).data;
  let last = null;
  for (let i = 0; i <= LINK_LIMITS.pollToken; i += 1) last = await poll(h, link.token);
  assert.equal(last.res.status, 429);
  const get = await h.request('GET', `/api/activity/link/poll?token=${link.token}`, { headers: JSON_HEADERS });
  assert.equal(get.status, 405);
});

test('the /link page is served by the single page app', async () => {
  const h = createHarness();
  const res = await h.request('GET', '/link?code=ABCD-EFGH');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>YapOS<\/title>/);
});

async function signIn(h, cookie) {
  const link = (await start(h)).data;
  await approve(h, cookie, link.code);
  return (await poll(h, link.token)).data.token;
}

test('a Party token only works on the Party sign-in routes, never on dashboard or owner routes', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const token = await signIn(h, cookie);
  for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/me/party-signins'], ['DELETE', '/api/me/party-signins'], ['GET', '/api/servers'], ['GET', '/api/owner'], ['GET', '/api/owner/overview'], ['GET', '/api/me/profile-visibility']]) {
    const res = await h.request(method, path, { headers: { ...bearer(token), Origin: ORIGIN, 'X-YapOS': '1' } });
    assert.ok(res.status === 401 || res.status === 403 || res.status === 404, `${method} ${path} gave ${res.status}`);
  }
  const link = (await start(h)).data;
  const viaBearer = await h.request('POST', '/api/link/approve', { headers: { ...bearer(token), Origin: ORIGIN, 'X-YapOS': '1' }, body: { code: link.code } });
  assert.equal(viaBearer.status, 401, 'a Party token cannot approve new codes');
  assert.equal((await poll(h, link.token)).data.status, 'pending');
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(token) })).status, 200);
});

test('two polls racing after one approval hand out only one session', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const link = (await start(h)).data;
  await approve(h, cookie, link.code);
  const both = await Promise.all([poll(h, link.token), poll(h, link.token)]);
  assert.equal(both.filter((p) => p.data.status === 'approved').length, 1);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM activity_sessions').get().n, 1);
});

test('each account keeps at most a few Party sign-ins, dropping the oldest', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const tokens = [];
  for (let i = 0; i < MAX_PARTY_SESSIONS + 3; i += 1) {
    if (i && i % LINK_LIMITS.approveUser === 0) advance(h, 61_000);
    tokens.push(await signIn(h, cookie));
    advance(h, 1);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?').get(USERS.alice.id).n, MAX_PARTY_SESSIONS);
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(tokens[0]) })).status, 401);
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(tokens.at(-1)) })).status, 200);
  const bob = (await h.login(USERS.bob)).cookie;
  const bobToken = await signIn(h, bob);
  assert.equal((await h.request('GET', '/api/activity/me', { headers: bearer(bobToken) })).status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?').get(USERS.alice.id).n, MAX_PARTY_SESSIONS);
});

test('the Authorization header must be a well formed bearer token', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const token = await signIn(h, cookie);
  for (const value of [`Basic ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Bearer ${token} extra`, 'Bearer ']) {
    assert.equal((await h.request('GET', '/api/activity/me', { headers: { Authorization: value } })).status, 401, value);
  }
  const both = await h.request('GET', '/api/activity/me', { headers: { Authorization: `Bearer ${'z'.repeat(43)}`, Cookie: cookie } });
  assert.equal(both.status, 401, 'a bad bearer token never falls back to the dashboard cookie');
});
