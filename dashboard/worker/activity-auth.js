import { MINUTE, DAY, ID_RE, USER_BODY_LIMIT, json, fail, readJson, randomToken, sha256Hex, clientIp, publicOrigin } from './util.js';
import { hit, ipKey, tooMany } from './rate.js';
import { getSession, publicUser } from './sessions.js';

export const LINK_TTL = 10 * MINUTE;
export const LINK_GRACE = 2 * MINUTE;
export const ACTIVITY_SESSION_TTL = 30 * DAY;
export const POLL_INTERVAL = 2500;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const MAX_PARTY_SESSIONS = 10;
export const LINK_LIMITS = { start: 10, poll: 90, pollToken: 40, approveUser: 10, approveIp: 20, me: 120, logout: 30 };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY = MINUTE;
const BODY_LIMIT = Math.min(USER_BODY_LIMIT, 4096);

export function newCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function formatCode(raw) {
  const s = String(raw || '');
  return s.length === CODE_LENGTH ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return s;
}

function codeHash(code) {
  return sha256Hex(`link-code:${code}`);
}

function pollHash(token) {
  return sha256Hex(`link-poll:${token}`);
}

function sessionHash(token) {
  return sha256Hex(`party-session:${token}`);
}

export function bearer(request) {
  const raw = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec(raw.trim());
  return m ? m[1] : null;
}

function userOf(row) {
  return { id: row.user_id, username: row.username, display_name: row.display_name || row.username, avatar_url: row.avatar_url || null };
}

async function limited(db, key, limit, t, message) {
  const r = await hit(db, key, limit, t);
  return r.ok ? null : tooMany(r.retryAfter, message);
}

async function readBodySafe(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) return {};
  return readJson(request, BODY_LIMIT);
}

async function startLink(request, env, t) {
  const stop = await limited(env.DB, await ipKey('lstart', clientIp(request)), LINK_LIMITS.start, t, 'Too many new codes at once. Wait a minute and try again.');
  if (stop) return stop;
  const body = await readBodySafe(request);
  const expect = typeof body.expect === 'string' && ID_RE.test(body.expect) ? body.expect : null;
  const token = randomToken(32);
  const pHash = await pollHash(token);
  for (let i = 0; i < 4; i += 1) {
    const code = newCode();
    const res = await env.DB
      .prepare('INSERT INTO activity_links (code_hash, poll_hash, expect, created, expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT (code_hash) DO NOTHING')
      .bind(await codeHash(code), pHash, expect, t, t + LINK_TTL)
      .run();
    if (res && res.meta && res.meta.changes) {
      const origin = publicOrigin(env);
      return json({ code: formatCode(code), token, expires: t + LINK_TTL, ttl: LINK_TTL, interval: POLL_INTERVAL, link: origin ? `${origin}/link` : '/link' }, 201);
    }
  }
  return fail(503, 'busy', 'Could not make a code right now. Try again in a moment.');
}

export async function createActivitySession(db, user, t) {
  const token = randomToken(32);
  const idHash = await sessionHash(token);
  await db.batch([
    db
      .prepare('INSERT INTO activity_sessions (id_hash, user_id, username, display_name, avatar_url, created, expires, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(idHash, user.id, user.username, user.display_name || null, user.avatar_url || null, t, t + ACTIVITY_SESSION_TTL, t),
    db
      .prepare('DELETE FROM activity_sessions WHERE user_id = ? AND id_hash != ? AND id_hash NOT IN (SELECT id_hash FROM activity_sessions WHERE user_id = ? AND id_hash != ? ORDER BY last_seen DESC, created DESC LIMIT ?)')
      .bind(user.id, idHash, user.id, idHash, MAX_PARTY_SESSIONS - 1),
  ]);
  return token;
}

async function pollLink(request, env, t) {
  const stop = await limited(env.DB, await ipKey('lpoll', clientIp(request)), LINK_LIMITS.poll, t);
  if (stop) return stop;
  const body = await readBodySafe(request);
  const token = typeof body.token === 'string' && TOKEN_RE.test(body.token) ? body.token : null;
  if (!token) return fail(400, 'bad_token', "That sign-in code isn't valid. Get a new code.");
  const pHash = await pollHash(token);
  const tokenStop = await limited(env.DB, `lpoll:t:${pHash.slice(0, 32)}`, LINK_LIMITS.pollToken, t);
  if (tokenStop) return tokenStop;
  const row = await env.DB.prepare('SELECT code_hash, expires, approved FROM activity_links WHERE poll_hash = ?').bind(pHash).first();
  if (!row) return json({ status: 'expired' });
  if (Number(row.expires) <= t) {
    await env.DB.prepare('DELETE FROM activity_links WHERE poll_hash = ?').bind(pHash).run();
    return json({ status: 'expired' });
  }
  if (row.approved === null || row.approved === undefined) return json({ status: 'pending', expires: Number(row.expires) });
  const taken = await env.DB
    .prepare('DELETE FROM activity_links WHERE poll_hash = ? AND approved IS NOT NULL RETURNING user_id, username, display_name, avatar_url, expect')
    .bind(pHash)
    .first();
  if (!taken || !taken.user_id) return json({ status: 'expired' });
  const user = userOf(taken);
  const session = await createActivitySession(env.DB, user, t);
  return json({ status: 'approved', token: session, expires: t + ACTIVITY_SESSION_TTL, user, matches: taken.expect ? taken.expect === user.id : null });
}

export async function getActivityUser(db, request, t) {
  const token = bearer(request);
  if (token) {
    const idHash = await sessionHash(token);
    const row = await db
      .prepare('SELECT id_hash, user_id, username, display_name, avatar_url, last_seen FROM activity_sessions WHERE id_hash = ? AND expires > ?')
      .bind(idHash, t)
      .first();
    if (!row) return null;
    if (t - Number(row.last_seen || 0) >= TOUCH_EVERY) {
      await db.prepare('UPDATE activity_sessions SET last_seen = ? WHERE id_hash = ?').bind(t, idHash).run();
    }
    return { user: userOf(row), via: 'code' };
  }
  const session = await getSession(db, request, t);
  return session ? { user: publicUser(session), via: 'dashboard' } : null;
}

async function activityMe(request, env, t) {
  const stop = await limited(env.DB, await ipKey('lme', clientIp(request)), LINK_LIMITS.me, t);
  if (stop) return stop;
  const found = await getActivityUser(env.DB, request, t);
  if (!found) return fail(401, 'signed_out', 'Sign in to YapOS Party to play.');
  return json({ user: found.user, via: found.via });
}

async function activityLogout(request, env, t) {
  const stop = await limited(env.DB, await ipKey('lout', clientIp(request)), LINK_LIMITS.logout, t);
  if (stop) return stop;
  const token = bearer(request);
  if (!token) return fail(401, 'signed_out', 'You are already signed out.');
  const res = await env.DB.prepare('DELETE FROM activity_sessions WHERE id_hash = ?').bind(await sessionHash(token)).run();
  return json({ ok: true, ended: Number((res && res.meta && res.meta.changes) || 0) });
}

export function activityAuthRoute(request, env, segs, t) {
  const method = request.method;
  if (segs[2] === 'link' && segs.length === 4 && (segs[3] === 'start' || segs[3] === 'poll')) {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return segs[3] === 'start' ? startLink(request, env, t) : pollLink(request, env, t);
  }
  if (segs[2] === 'me' && segs.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return activityMe(request, env, t);
  }
  if (segs[2] === 'logout' && segs.length === 3) {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return activityLogout(request, env, t);
  }
  return null;
}

export function isActivityAuthPath(segs) {
  return segs[2] === 'link' || ((segs[2] === 'me' || segs[2] === 'logout') && segs.length === 3);
}

export async function approveCode(db, rawCode, user, t, { confirm = false } = {}) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, status: 400, error: 'bad_code', message: "That code doesn't look right. It has 8 letters and numbers, like K7QM-2XPA." };
  const cHash = await codeHash(code);
  const row = await db.prepare('SELECT expect, expires, approved FROM activity_links WHERE code_hash = ?').bind(cHash).first();
  if (!row) return { ok: false, status: 404, error: 'bad_code', message: "That code didn't work. Check it and try again, or get a new code in YapOS Party." };
  if (Number(row.expires) <= t) return { ok: false, status: 410, error: 'expired', message: 'That code has expired. Tap "Get a new code" in YapOS Party and try again.' };
  if (row.approved !== null && row.approved !== undefined) return { ok: false, status: 409, error: 'used', message: 'That code was already used. Get a new code in YapOS Party.' };
  if (row.expect && row.expect !== user.id && !confirm) {
    return { ok: false, status: 409, error: 'other_account', message: "This code came from a call where you're using a different Yapin' account. Your Party wins would go to this account instead." };
  }
  const res = await db
    .prepare('UPDATE activity_links SET user_id = ?, username = ?, display_name = ?, avatar_url = ?, approved = ?, expires = MAX(expires, ?) WHERE code_hash = ? AND approved IS NULL AND expires > ?')
    .bind(user.id, user.username, user.display_name || null, user.avatar_url || null, t, t + LINK_GRACE, cHash, t)
    .run();
  if (!res || !res.meta || !res.meta.changes) return { ok: false, status: 409, error: 'used', message: 'That code was already used. Get a new code in YapOS Party.' };
  return { ok: true, user };
}

async function postApprove(request, env, session, t) {
  const userStop = await limited(env.DB, `lapp:u:${session.user_id}`, LINK_LIMITS.approveUser, t, 'Too many tries. Wait a minute, then check the code and try again.');
  if (userStop) return userStop;
  const ipStop = await limited(env.DB, await ipKey('lapp', clientIp(request)), LINK_LIMITS.approveIp, t, 'Too many tries. Wait a minute, then check the code and try again.');
  if (ipStop) return ipStop;
  const body = await readJson(request, BODY_LIMIT);
  const result = await approveCode(env.DB, body.code, publicUser(session), t, { confirm: body.confirm === true });
  if (!result.ok) return fail(result.status, result.error, result.message);
  return json({ ok: true, user: result.user });
}

async function partySignins(request, env, session, t) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const row = await env.DB
      .prepare('SELECT COUNT(*) AS n, MAX(last_seen) AS seen FROM activity_sessions WHERE user_id = ? AND expires > ?')
      .bind(session.user_id, t)
      .first();
    return json({ count: Number((row && row.n) || 0), lastSeen: row && row.seen ? Number(row.seen) : null });
  }
  if (request.method === 'DELETE') {
    const res = await env.DB.prepare('DELETE FROM activity_sessions WHERE user_id = ?').bind(session.user_id).run();
    return json({ ok: true, ended: Number((res && res.meta && res.meta.changes) || 0) });
  }
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}

export function linkSessionRoute(request, env, session, route, t) {
  if (route.length === 2 && route[0] === 'link' && route[1] === 'approve') {
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return postApprove(request, env, session, t);
  }
  if (route.length === 2 && route[0] === 'me' && route[1] === 'party-signins') return partySignins(request, env, session, t);
  return null;
}

export function linkCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM activity_links WHERE expires <= ?').bind(t - LINK_GRACE),
    db.prepare('DELETE FROM activity_sessions WHERE expires <= ?').bind(t),
  ];
}
