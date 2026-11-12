import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { D1Database } from './d1-shim.js';
import { createWorker } from '../worker/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');

export const ORIGIN = 'https://dash.example.test';
export const YAPIN = 'https://yapin.example.test';
export const BOT_SECRET = 'test-bot-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
export const CLIENT_SECRET = 'test-secret';
export const INDEX_HTML = '<!doctype html><html><head><title>YapOS</title></head><body>app</body></html>';

export const USERS = {
  alice: { id: '11111111-1111-4111-8111-111111111111', username: 'alice', display_name: 'Alice', avatar_url: 'https://files.yapper.website/a.png' },
  bob: { id: '22222222-2222-4222-8222-222222222222', username: 'bob', display_name: 'Bob', avatar_url: 'javascript:alert(1)' },
};

export const SERVER = '33333333-3333-4333-8333-333333333333';
export const OTHER_SERVER = '44444444-4444-4444-8444-444444444444';

export function createHarness(overrides = {}) {
  const db = new D1Database();
  db.raw.exec(schema);
  const clock = { t: Date.UTC(2026, 10, 12, 12, 0, 0) };
  const calls = [];
  const codes = new Map();
  const tokens = new Map();
  const yapin = { tokenStatus: 200, meStatus: 200 };
  const fakeFetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${YAPIN}/api/oauth/token`) {
      const form = new URLSearchParams(init.body);
      if (yapin.tokenStatus !== 200) return new Response('{"error":"nope"}', { status: yapin.tokenStatus });
      if (form.get('client_secret') !== CLIENT_SECRET || form.get('grant_type') !== 'authorization_code') {
        return new Response('{"error":"invalid_client"}', { status: 401 });
      }
      if (form.get('redirect_uri') !== `${new URL(env.PUBLIC_URL).origin}/auth/callback`) return new Response('{"error":"bad_redirect"}', { status: 400 });
      const user = codes.get(form.get('code'));
      if (!user) return new Response('{"error":"invalid_grant"}', { status: 400 });
      codes.delete(form.get('code'));
      const token = `tok-${user.id}`;
      tokens.set(token, user);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (url === `${YAPIN}/api/oauth/me`) {
      if (yapin.meStatus !== 200) return new Response('{}', { status: yapin.meStatus });
      const auth = new Headers(init.headers).get('Authorization') || '';
      const user = tokens.get(auth.replace(/^Bearer /, ''));
      if (!user) return new Response('{}', { status: 401 });
      return Response.json(user);
    }
    return new Response('not found', { status: 404 });
  };
  const assets = {
    requests: [],
    async fetch(request) {
      const u = new URL(request.url);
      this.requests.push(u.pathname);
      if (u.pathname === '/' || u.pathname === '/index.html') {
        return new Response(INDEX_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('missing', { status: 404 });
    },
  };
  const env = {
    DB: db,
    ASSETS: assets,
    YAPIN_CLIENT_ID: 'b21fe402-0f20-43df-867b-8b346029fd8d',
    PUBLIC_URL: ORIGIN,
    YAPIN_BASE: YAPIN,
    YAPIN_CLIENT_SECRET: CLIENT_SECRET,
    BOT_SECRET,
    ...overrides,
  };
  const logs = [];
  const worker = createWorker({ fetch: fakeFetch, now: () => clock.t, log: (...a) => logs.push(a.join(' ')) });
  const base = new URL(env.PUBLIC_URL).origin;

  async function request(method, pathname, { headers = {}, body, ip = '203.0.113.7' } = {}) {
    const h = new Headers(headers);
    if (!h.has('CF-Connecting-IP')) h.set('CF-Connecting-IP', ip);
    const init = { method, headers: h };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
    }
    const url = pathname.startsWith('http') ? pathname : `${base}${pathname}`;
    return worker.fetch(new Request(url, init), env, { waitUntil() {} });
  }

  async function startLogin(next, ip) {
    const res = await request('GET', `/auth/login${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`, { ip });
    const location = new URL(res.headers.get('Location'));
    const state = location.searchParams.get('state');
    const setCookie = res.headers.get('Set-Cookie') || '';
    const stateCookie = setCookie.split(';')[0];
    return { res, location, state, stateCookie };
  }

  async function login(user, next) {
    const code = `code-${user.username}-${Math.random().toString(36).slice(2)}`;
    codes.set(code, user);
    const { state, stateCookie } = await startLogin(next);
    const res = await request('GET', `/auth/callback?code=${code}&state=${state}`, { headers: { Cookie: stateCookie } });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('yapos_session='));
    return { res, cookies, cookie: session ? session.split(';')[0] : null };
  }

  function api(method, pathname, cookie, body, extra = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...extra };
    if (method !== 'GET' && method !== 'HEAD') {
      if (!('Origin' in extra)) headers.Origin = base;
      if (!('X-YapOS' in extra)) headers['X-YapOS'] = '1';
    }
    for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
    return request(method, pathname, { headers, body });
  }

  function bot(method, pathname, body, secret = BOT_SECRET) {
    const headers = secret === null ? {} : { Authorization: `Bearer ${secret}` };
    return request(method, pathname, { headers, body });
  }

  async function poll() {
    const res = await bot('GET', '/bot/poll?wait=0');
    return res.json();
  }

  async function answer(results) {
    return bot('POST', '/bot/results', { results });
  }

  async function grant(cookie, sid = SERVER, level = 'admin') {
    const res = await api('GET', `/api/servers/${sid}`, cookie);
    const body = await res.json();
    if (!body.pending) return body;
    const { jobs } = await poll();
    const job = jobs.find((j) => j.id === body.job);
    await answer([{ id: job.id, ok: true, result: { grant: true, level } }]);
    return body;
  }

  async function pushSnapshot(sid = SERVER, parts = {}) {
    return bot('PUT', `/bot/snapshot/${sid}`, {
      overview: { id: sid, name: 'Test Server', member_count: 12 },
      apps: [{ id: 'mod', name: 'Mod', enabled: true }],
      settings: { mod: { values: { dmOnAction: true }, schema: [] } },
      cases: [],
      updatedAt: clock.t,
      ...parts,
    });
  }

  return { db, env, clock, calls, codes, yapin, worker, request, startLogin, login, api, bot, poll, answer, grant, pushSnapshot, assets, logs, base };
}

export function advance(h, ms) {
  h.clock.t += ms;
}
