import { MINUTE, ID_RE, redirect, json, fail, randomToken, publicOrigin, clipString, safeHttpsUrl, clientIp, safeEqual } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { STATE_COOKIE, cookie, readToken, createSession, sessionCookie, deleteSession, clearSessionCookie } from './sessions.js';

export const STATE_TTL = 10 * MINUTE;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_NEXT = '/servers';

export function safeNext(raw, env) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return DEFAULT_NEXT;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return DEFAULT_NEXT;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_NEXT;
  const base = publicOrigin(env) || 'https://dashboard.invalid';
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return DEFAULT_NEXT;
  }
  if (u.origin !== base) return DEFAULT_NEXT;
  if (u.pathname.startsWith('/auth/') || u.pathname.startsWith('/bot/') || u.pathname.startsWith('/api/')) return DEFAULT_NEXT;
  return u.pathname + u.search + u.hash;
}

function yapinBase(env) {
  return String(env.YAPIN_BASE || 'https://www.yapin.gg').replace(/\/+$/, '');
}

function redirectUri(env) {
  return `${publicOrigin(env)}/auth/callback`;
}

function clearStateCookie(env) {
  return cookie(env, STATE_COOKIE, '', 0, '/auth');
}

export async function login(request, env, deps) {
  const t = deps.now();
  const limit = await hit(env.DB, await ipKey('auth', clientIp(request)), LIMITS.auth, t);
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many sign-in attempts. Wait a minute and try again.');
  if (!env.YAPIN_CLIENT_ID || !publicOrigin(env)) {
    return fail(503, 'not_configured', 'Sign-in is not set up yet on this dashboard.');
  }
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'), env);
  const state = randomToken(32);
  await env.DB.prepare('INSERT INTO oauth_states (state, next, created) VALUES (?, ?, ?)').bind(state, next, t).run();
  const target = new URL(`${yapinBase(env)}/oauth/authorize`);
  target.searchParams.set('client_id', env.YAPIN_CLIENT_ID);
  target.searchParams.set('redirect_uri', redirectUri(env));
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', 'identify');
  target.searchParams.set('state', state);
  return redirect(target.href, 302, { 'Set-Cookie': cookie(env, STATE_COOKIE, state, Math.floor(STATE_TTL / 1000), '/auth') });
}

function loginFailed(env, reason, step) {
  console.log(`login ${reason}${step ? ` at ${step}` : ""}`);
  return redirect(`/?login=${reason}`, 302, { 'Set-Cookie': clearStateCookie(env) });
}

async function exchangeCode(env, deps, code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env),
    client_id: String(env.YAPIN_CLIENT_ID || ''),
    client_secret: String(env.YAPIN_CLIENT_SECRET || '').trim(),
  });
  const res = await deps.fetch(`${yapinBase(env)}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    console.log(`login token answer ${res.status} ${String(err?.error || "").slice(0, 40)}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  const token = data && typeof data.access_token === 'string' ? data.access_token : null;
  return token && token.length <= 4096 ? token : null;
}

async function fetchMe(env, deps, token) {
  const res = await deps.fetch(`${yapinBase(env)}/api/oauth/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    console.log(`login me answer ${res.status}`);
    return null;
  }
  const me = await res.json().catch(() => null);
  if (!me || typeof me !== 'object') return null;
  const id = typeof me.id === 'string' ? me.id : null;
  const username = clipString(me.username, 64);
  if (!id || !ID_RE.test(id) || !username) {
    console.log(`login me shape id:${typeof me.id} username:${typeof me.username}`);
    return null;
  }
  return {
    id,
    username,
    display_name: clipString(me.display_name, 64) || username,
    avatar_url: safeHttpsUrl(me.avatar_url),
  };
}

export async function callback(request, env, deps) {
  const t = deps.now();
  const url = new URL(request.url);
  const params = url.searchParams;
  const state = params.get('state');
  const error = params.get('error');
  if (error) {
    if (state && STATE_RE.test(state)) {
      await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    }
    return loginFailed(env, error === 'access_denied' ? 'cancelled' : 'failed');
  }
  const code = params.get('code');
  if (!state || !STATE_RE.test(state) || !code || code.length > 2048) return loginFailed(env, 'failed', 'params');
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING next, created').bind(state).first();
  if (!row) return loginFailed(env, 'expired');
  if (Number(row.created) + STATE_TTL < t) return loginFailed(env, 'expired');
  const browserState = readToken(request, STATE_COOKIE);
  if (!browserState || !(await safeEqual(browserState, state))) return loginFailed(env, 'failed', browserState ? 'cookie mismatch' : 'no cookie');
  let user = null;
  try {
    const token = await exchangeCode(env, deps, code);
    if (token) user = await fetchMe(env, deps, token);
  } catch (e) {
    console.log(`login error ${e?.name || "Error"}`);
    user = null;
  }
  if (!user) return loginFailed(env, 'failed', 'yapin');
  const id = await createSession(env.DB, user, t);
  const headers = new Headers();
  headers.append('Set-Cookie', sessionCookie(env, id));
  headers.append('Set-Cookie', clearStateCookie(env));
  return redirect(safeNext(row.next, env), 302, headers);
}

export async function logout(request, env) {
  await deleteSession(env.DB, request);
  const headers = { 'Set-Cookie': clearSessionCookie(env) };
  if (request.headers.get('X-YapOS') === '1') return json({ ok: true }, 200, headers);
  return redirect('/', 303, headers);
}
