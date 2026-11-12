import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHarness, advance, USERS, ORIGIN, YAPIN, CLIENT_SECRET } from './helpers.js';
import { safeNext } from '../worker/auth.js';

test('login start redirects to Yapin with a stored state and a state cookie', async () => {
  const h = createHarness();
  const { res, location, state, stateCookie } = await h.startLogin('/servers/abc');
  assert.equal(res.status, 302);
  assert.equal(location.origin + location.pathname, `${YAPIN}/oauth/authorize`);
  assert.equal(location.searchParams.get('client_id'), h.env.YAPIN_CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('scope'), 'identify');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const row = h.db.raw.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  assert.equal(row.next, '/servers/abc');
  assert.equal(stateCookie, `yapos_oauth=${state}`);
  const flags = res.headers.get('Set-Cookie');
  assert.match(flags, /HttpOnly/);
  assert.match(flags, /Secure/);
  assert.match(flags, /SameSite=Lax/);
  assert.match(flags, /Path=\/auth/);
});

test('next is sanitised against open redirects', () => {
  const env = { PUBLIC_URL: ORIGIN };
  assert.equal(safeNext('/servers/1?x=2#y', env), '/servers/1?x=2#y');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', '', '/\u0000x', '/a\\b', '/auth/logout', '/api/me', null, '/'.padEnd(600, 'a')]) {
    assert.equal(safeNext(bad, env), '/servers', `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(safeNext('/%2F%2Fevil.example', env), '/%2F%2Fevil.example');
});

test('callback creates a hashed session, sets strict cookie flags and redirects to next', async () => {
  const h = createHarness();
  const { res, cookie, cookies } = await h.login(USERS.alice, '/servers');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), '/servers');
  const session = cookies.find((c) => c.startsWith('yapos_session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Path=\//);
  assert.match(session, /Max-Age=2592000/);
  assert.ok(cookies.some((c) => c.startsWith('yapos_oauth=;') && /Max-Age=0/.test(c)));
  const id = cookie.split('=')[1];
  const rows = h.db.raw.prepare('SELECT * FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id_hash, createHash('sha256').update(id).digest('hex'));
  assert.notEqual(rows[0].id_hash, id);
  assert.equal(rows[0].user_id, USERS.alice.id);
  assert.equal(rows[0].expires - rows[0].created, 30 * 24 * 3600 * 1000);
  const tokenCall = h.calls.find((c) => c.url.endsWith('/api/oauth/token'));
  assert.equal(new URLSearchParams(tokenCall.init.body).get('client_secret'), CLIENT_SECRET);
  const me = await h.api('GET', '/api/me', cookie);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, { id: USERS.alice.id, username: 'alice', display_name: 'Alice', avatar_url: USERS.alice.avatar_url });
  const all = JSON.stringify(rows) + JSON.stringify(await (await h.api('GET', '/api/me', cookie)).text());
  assert.ok(!all.includes('tok-'), 'access token must not be stored or returned');
});

test('unsafe avatar urls are dropped', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.bob);
  const me = await (await h.api('GET', '/api/me', cookie)).json();
  assert.equal(me.user.avatar_url, null);
});

test('state cannot be replayed', async () => {
  const h = createHarness();
  h.codes.set('c1', USERS.alice);
  h.codes.set('c2', USERS.alice);
  const { state, stateCookie } = await h.startLogin('/servers');
  const first = await h.request('GET', `/auth/callback?code=c1&state=${state}`, { headers: { Cookie: stateCookie } });
  assert.equal(first.headers.get('Location'), '/servers');
  const second = await h.request('GET', `/auth/callback?code=c2&state=${state}`, { headers: { Cookie: stateCookie } });
  assert.equal(second.status, 302);
  assert.equal(second.headers.get('Location'), '/?login=expired');
  assert.ok(!second.headers.getSetCookie().some((c) => c.startsWith('yapos_session=') && !c.startsWith('yapos_session=;')));
});

test('expired state is refused', async () => {
  const h = createHarness();
  h.codes.set('c1', USERS.alice);
  const { state, stateCookie } = await h.startLogin('/servers');
  advance(h, 10 * 60 * 1000 + 1);
  const res = await h.request('GET', `/auth/callback?code=c1&state=${state}`, { headers: { Cookie: stateCookie } });
  assert.equal(res.headers.get('Location'), '/?login=expired');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('unknown, missing or mismatched state is refused', async () => {
  const h = createHarness();
  h.codes.set('c1', USERS.alice);
  const fake = 'A'.repeat(43);
  let res = await h.request('GET', `/auth/callback?code=c1&state=${fake}`, { headers: { Cookie: `yapos_oauth=${fake}` } });
  assert.equal(res.headers.get('Location'), '/?login=expired');
  res = await h.request('GET', '/auth/callback?code=c1');
  assert.equal(res.headers.get('Location'), '/?login=failed');
  const { state } = await h.startLogin('/servers');
  res = await h.request('GET', `/auth/callback?code=c1&state=${state}`, { headers: { Cookie: `yapos_oauth=${'B'.repeat(43)}` } });
  assert.equal(res.headers.get('Location'), '/?login=failed');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('denied consent goes back to the landing page', async () => {
  const h = createHarness();
  const { state, stateCookie } = await h.startLogin('/servers');
  const res = await h.request('GET', `/auth/callback?error=access_denied&state=${state}`, { headers: { Cookie: stateCookie } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), '/?login=cancelled');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM oauth_states').get().n, 0);
  const other = await h.request('GET', '/auth/callback?error=server_error');
  assert.equal(other.headers.get('Location'), '/?login=failed');
});

test('token or profile failures do not create a session', async () => {
  const h = createHarness();
  h.yapin.tokenStatus = 500;
  let r = await h.login(USERS.alice);
  assert.equal(r.res.headers.get('Location'), '/?login=failed');
  h.yapin.tokenStatus = 200;
  h.yapin.meStatus = 500;
  r = await h.login(USERS.alice);
  assert.equal(r.res.headers.get('Location'), '/?login=failed');
  const bad = await h.request('GET', `/auth/callback?code=nope&state=${(await h.startLogin()).state}`);
  assert.equal(bad.headers.get('Location'), '/?login=failed');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('Secure is omitted only for http://localhost', async () => {
  const h = createHarness({ PUBLIC_URL: 'http://localhost:8787' });
  const { cookies } = await h.login(USERS.alice);
  const session = cookies.find((c) => c.startsWith('yapos_session='));
  assert.ok(!/Secure/.test(session));
  assert.match(session, /HttpOnly/);
  const h2 = createHarness({ PUBLIC_URL: 'http://dash.example.test' });
  const { res } = await h2.startLogin('/servers');
  assert.match(res.headers.get('Set-Cookie'), /Secure/);
});

test('logout deletes the session and clears the cookie; needs same origin', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  const blocked = await h.request('POST', '/auth/logout', { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  const missing = await h.request('POST', '/auth/logout', { headers: { Cookie: cookie } });
  assert.equal(missing.status, 403);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  const res = await h.request('POST', '/auth/logout', { headers: { Cookie: cookie, Origin: ORIGIN, 'X-YapOS': '1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(res.headers.get('Set-Cookie'), /^yapos_session=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0$/);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal((await h.api('GET', '/api/me', cookie)).status, 401);
  const form = await h.request('POST', '/auth/logout', { headers: { Origin: ORIGIN } });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('Location'), '/');
  assert.equal((await h.request('GET', '/auth/logout')).status, 405);
});

test('expired sessions are refused', async () => {
  const h = createHarness();
  const { cookie } = await h.login(USERS.alice);
  advance(h, 30 * 24 * 3600 * 1000 + 1);
  assert.equal((await h.api('GET', '/api/me', cookie)).status, 401);
});

test('malformed session cookies are ignored', async () => {
  const h = createHarness();
  for (const c of ['yapos_session=abc', "yapos_session=' OR 1=1 --", 'yapos_session=' + 'x'.repeat(43)]) {
    assert.equal((await h.api('GET', '/api/me', c)).status, 401);
  }
});

test('auth starts are limited to 30 per minute per IP', async () => {
  const h = createHarness();
  for (let i = 0; i < 30; i++) {
    const r = await h.request('GET', '/auth/login', { ip: '198.51.100.1' });
    assert.equal(r.status, 302);
  }
  const blocked = await h.request('GET', '/auth/login', { ip: '198.51.100.1' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) >= 1);
  const other = await h.request('GET', '/auth/login', { ip: '198.51.100.2' });
  assert.equal(other.status, 302);
  advance(h, 60 * 1000);
  assert.equal((await h.request('GET', '/auth/login', { ip: '198.51.100.1' })).status, 302);
  const keys = h.db.raw.prepare('SELECT key FROM rate').all().map((r) => r.key).join(' ');
  assert.ok(!keys.includes('198.51.100.1'), 'raw IPs are not stored');
});
