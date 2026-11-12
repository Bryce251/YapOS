import { DAY, parseCookies, randomToken, sha256Hex, isLocalHttp } from './util.js';

export const SESSION_COOKIE = 'yapos_session';
export const STATE_COOKIE = 'yapos_oauth';
export const SESSION_TTL = 30 * DAY;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY = 10 * 1000;

export function cookie(env, name, value, maxAge, path = '/') {
  const parts = [`${name}=${value}`, 'HttpOnly'];
  if (!isLocalHttp(env)) parts.push('Secure');
  parts.push('SameSite=Lax', `Path=${path}`, `Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function sessionCookie(env, id) {
  return cookie(env, SESSION_COOKIE, id, Math.floor(SESSION_TTL / 1000));
}

export function clearSessionCookie(env) {
  return cookie(env, SESSION_COOKIE, '', 0);
}

export function readToken(request, name) {
  const value = parseCookies(request.headers.get('Cookie'))[name];
  return value && TOKEN_RE.test(value) ? value : null;
}

export async function createSession(db, user, t) {
  const id = randomToken(32);
  const idHash = await sha256Hex(id);
  await db
    .prepare('INSERT INTO sessions (id_hash, user_id, username, display_name, avatar_url, created, expires, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(idHash, user.id, user.username, user.display_name, user.avatar_url, t, t + SESSION_TTL, 0)
    .run();
  return id;
}

export async function getSession(db, request, t) {
  const id = readToken(request, SESSION_COOKIE);
  if (!id) return null;
  const idHash = await sha256Hex(id);
  const row = await db
    .prepare('SELECT id_hash, user_id, username, display_name, avatar_url, created, expires, last_seen FROM sessions WHERE id_hash = ? AND expires > ?')
    .bind(idHash, t)
    .first();
  return row || null;
}

export async function touchSession(db, session, t) {
  if (t - Number(session.last_seen || 0) < TOUCH_EVERY) return;
  await db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').bind(t, session.id_hash).run();
}

export async function deleteSession(db, request) {
  const id = readToken(request, SESSION_COOKIE);
  if (!id) return false;
  const idHash = await sha256Hex(id);
  const res = await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
  return Boolean(res && res.meta && res.meta.changes);
}

export function publicUser(session) {
  return {
    id: session.user_id,
    username: session.username,
    display_name: session.display_name,
    avatar_url: session.avatar_url,
  };
}
