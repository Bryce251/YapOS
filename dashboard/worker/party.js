import { ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { parseIds, lookupProfiles, cleanAvatar, cleanText } from './profiles.js';

export const MAX_PARTY_ADMINS = 50;
export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_ONLY = 'Only the owner of YapOS Party can manage party admins.';

export function partyOwnerId(env) {
  const raw = typeof env.PARTY_OWNER_ID === 'string' ? env.PARTY_OWNER_ID.trim() : '';
  return raw && ID_RE.test(raw) ? raw : null;
}

export function isPartyOwner(env, userId) {
  const owner = partyOwnerId(env);
  return Boolean(owner && typeof userId === 'string' && userId.toLowerCase() === owner.toLowerCase());
}

export async function getActivityAdmins(request, env, url, t) {
  const limit = await hit(env.DB, await ipKey('partyAdmins', clientIp(request)), LIMITS.partyAdmins, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const ids = parseIds(url.searchParams.get('ids'));
  const lower = [...new Set(ids.map((id) => id.toLowerCase()))];
  const marks = lower.map(() => '?').join(', ');
  const res = await env.DB.prepare(`SELECT id FROM party_admins WHERE id IN (${marks})`).bind(...lower).all();
  const stored = new Set(((res && res.results) || []).map((r) => String(r.id).toLowerCase()));
  const owner = ids.find((id) => isPartyOwner(env, id)) || null;
  const admins = ids.filter((id) => id === owner || stored.has(id.toLowerCase()));
  return json({ admins, owner }, 200, { 'Cache-Control': 'private, max-age=30' });
}

export function activityAdminsRoute(request, env, url, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  return getActivityAdmins(request, env, url, t);
}

function person(id, profile) {
  return {
    id,
    username: profile ? profile.username : null,
    display_name: profile ? profile.display_name : null,
    avatar: profile ? profile.avatar : null,
  };
}

async function listAdmins(request, env, session, t, extra = {}) {
  const res = await env.DB.prepare('SELECT id, added_by, added_at FROM party_admins ORDER BY added_at ASC, id ASC').all();
  const rows = (res && res.results) || [];
  const found = await lookupProfiles(env, rows.map((r) => r.id), t, clientIp(request));
  const owner = {
    id: session.user_id,
    username: cleanText(session.username, 64),
    display_name: cleanText(session.display_name, 64),
    avatar: cleanAvatar(session.avatar_url),
  };
  const admins = rows.map((r) => ({ ...person(r.id, found.profiles.get(r.id)), added_by: r.added_by, added_at: Number(r.added_at) }));
  return json({ owner, admins, max: MAX_PARTY_ADMINS, pending: found.pending, ...extra });
}

function cleanUserId(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'bad_id', 'Paste a user id first.');
  const id = value.trim().toLowerCase();
  if (!id) throw new HttpError(400, 'bad_id', 'Paste a user id first.');
  if (!USER_ID_RE.test(id)) throw new HttpError(400, 'bad_id', "That doesn't look like a Yapin' user id. It should look like 1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f.");
  return id;
}

async function addAdmin(request, env, session, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (k !== 'id') throw new HttpError(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  const id = cleanUserId(body.id);
  if (isPartyOwner(env, id)) return fail(400, 'is_owner', "That's you! You're the owner, so you're always an admin.");
  const existing = await env.DB.prepare('SELECT id FROM party_admins WHERE id = ?').bind(id).first();
  if (existing) return listAdmins(request, env, session, t, { added: false });
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_admins').first();
  if (Number(count && count.n) >= MAX_PARTY_ADMINS) {
    return fail(409, 'too_many', `You already have ${MAX_PARTY_ADMINS} party admins. Remove someone first.`);
  }
  await env.DB.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(id, session.user_id, t).run();
  return listAdmins(request, env, session, t, { added: true });
}

async function removeAdmin(request, env, session, raw, t) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw new HttpError(400, 'bad_id', "That user id doesn't look right.");
  const id = raw.toLowerCase();
  if (isPartyOwner(env, id)) return fail(400, 'is_owner', "You're the owner, so you can't be removed.");
  const res = await env.DB.prepare('DELETE FROM party_admins WHERE id = ?').bind(id).run();
  const removed = Boolean(res && res.meta && res.meta.changes);
  return listAdmins(request, env, session, t, { removed });
}

export function partyRoute(request, env, session, route, t) {
  if (!isPartyOwner(env, session.user_id)) return fail(403, 'owner_only', OWNER_ONLY);
  const n = route.length;
  const method = request.method;
  if (n === 2 && route[1] === 'admins') {
    if (method === 'GET' || method === 'HEAD') return listAdmins(request, env, session, t);
    if (method === 'POST') return addAdmin(request, env, session, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3 && route[1] === 'admins') {
    if (method === 'DELETE') return removeAdmin(request, env, session, route[2], t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
