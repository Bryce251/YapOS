import { DAY, ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, clientIp } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { partyRole } from './reports.js';
import { actorName, personName, logModAction } from './party-mod.js';
import { cleanText, lookupProfiles } from './profiles.js';
import { staffLookView, resetLook, RESET_PARTS, RESET_ACTIONS } from './profile-custom.js';
import { HIDE_KINDS, HIDDEN_NAMES_MAX, hiddenRows, clearHiddenNames } from './hidden-names.js';
import { clearPartyProfileCache } from './party-profile.js';
import { clearLeaderboardCache } from './party-leaderboard.js';

export const HIDE_REASON_MAX = 200;
export const NOTICE_DAYS = 30;
export const NOTICE_MAX = 10;
export const HIDE_ACTIONS = Object.freeze(['name_hide', 'name_unhide']);
const STAFF_ONLY = 'Only the owner of YapOS Party and party admins can do this.';
const HIDE_FIELDS = new Set(['what', 'reason']);

const lower = (v) => String(v ?? '').toLowerCase();

function personId(raw) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw new HttpError(400, 'bad_id', "That user id doesn't look right.");
  return raw.toLowerCase();
}

export function staffBlock(role, viewerId, targetId, targetRole) {
  if (role === 'owner') return null;
  if (role !== 'admin') return { status: 403, code: 'staff_only', message: STAFF_ONLY };
  if (targetRole === 'owner') return { status: 403, code: 'is_owner', message: "Party admins can't change the owner's profile." };
  if (lower(targetId) === lower(viewerId)) return { status: 403, code: 'is_self', message: "You can't use staff tools on your own profile. Change it yourself, or ask the owner." };
  if (targetRole === 'admin') return { status: 403, code: 'is_admin', message: "Party admins can't change other party admins' profiles. Ask the owner." };
  return null;
}

async function guard(env, session, role, id) {
  const block = staffBlock(role, session.user_id, id, await partyRole(env, id));
  return block ? fail(block.status, block.code, block.message) : null;
}

async function slowDown(env, session, t) {
  const limit = await hit(env.DB, `staffProfile:u:${lower(session.user_id)}`, LIMITS.staffProfile, t);
  return limit.ok ? null : tooMany(limit.retryAfter, "That's a lot of profile changes at once. Wait a minute and try again.");
}

async function viewReply(request, env, session, role, id, t, extra = {}) {
  const db = env.DB;
  const [look, hidden, targetRole, found, fallback] = await Promise.all([
    staffLookView(db, id),
    hiddenRows(db, id),
    partyRole(env, id),
    lookupProfiles(env, [id], t, clientIp(request)),
    personName(db, id),
  ]);
  const p = found.profiles.get(id) || null;
  const block = staffBlock(role, session.user_id, id, targetRole);
  return json({
    person: { id, name: (p && p.display_name) || fallback || (p && p.username) || 'Player', username: (p && p.username) || null, role: targetRole },
    look,
    hidden,
    canAct: !block,
    why: block ? block.message : null,
    role,
    ...extra,
  });
}

async function resetPart(request, env, session, role, id, part, t) {
  if (!RESET_PARTS.includes(part)) return fail(404, 'not_found', "That part of a profile can't be reset.");
  const blocked = await guard(env, session, role, id);
  if (blocked) return blocked;
  const slow = await slowDown(env, session, t);
  if (slow) return slow;
  const out = await resetLook(env.DB, { id, part, actor: { id: lower(session.user_id), name: actorName(session) }, t });
  if (!out.done) return fail(404, 'not_found', out.message);
  return viewReply(request, env, session, role, id, t, { ok: true, reset: part, action: out.action });
}

async function hideName(request, env, session, role, id, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) if (!HIDE_FIELDS.has(k)) throw new HttpError(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  if (!HIDE_KINDS.includes(body.what)) throw new HttpError(400, 'bad_what', 'Pick the display name or the username.');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw new HttpError(400, 'bad_reason', "The reason doesn't look right.");
  const reason = cleanText(body.reason, HIDE_REASON_MAX);
  const blocked = await guard(env, session, role, id);
  if (blocked) return blocked;
  const slow = await slowDown(env, session, t);
  if (slow) return slow;
  const db = env.DB;
  const existing = await db.prepare('SELECT 1 AS x FROM party_hidden_names WHERE user_id = ? AND kind = ?').bind(id, body.what).first();
  if (existing) return viewReply(request, env, session, role, id, t, { ok: true, hid: false });
  const count = await db.prepare('SELECT COUNT(*) AS n FROM party_hidden_names').first();
  if (Number(count && count.n) >= HIDDEN_NAMES_MAX) return fail(409, 'too_many', 'YapOS is already hiding as many names as it can. Unhide some first.');
  const viewer = lower(session.user_id);
  const by = actorName(session);
  const target = await personName(db, id);
  await db.batch([
    db.prepare('INSERT INTO party_hidden_names (user_id, kind, reason, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, kind) DO NOTHING').bind(id, body.what, reason, viewer, by, t),
    logModAction(db, { actorId: viewer, actorName: by, action: 'name_hide', targetId: id, targetName: target, detail: { what: body.what, reason: reason || null }, t }),
  ]);
  clearHiddenNames(db);
  clearPartyProfileCache(db);
  clearLeaderboardCache(db);
  return viewReply(request, env, session, role, id, t, { ok: true, hid: true });
}

async function unhideName(request, env, session, role, id, what, t) {
  if (!HIDE_KINDS.includes(what)) return fail(404, 'not_found', 'Pick the display name or the username.');
  const blocked = await guard(env, session, role, id);
  if (blocked) return blocked;
  const slow = await slowDown(env, session, t);
  if (slow) return slow;
  const db = env.DB;
  const viewer = lower(session.user_id);
  const target = await personName(db, id);
  const [log, res] = await db.batch([
    logModAction(db, { actorId: viewer, actorName: actorName(session), action: 'name_unhide', targetId: id, targetName: target, detail: { what }, t }, { sql: 'EXISTS (SELECT 1 FROM party_hidden_names WHERE user_id = ? AND kind = ?)', args: [id, what] }),
    db.prepare('DELETE FROM party_hidden_names WHERE user_id = ? AND kind = ?').bind(id, what),
  ]);
  clearHiddenNames(db);
  clearPartyProfileCache(db);
  clearLeaderboardCache(db);
  return viewReply(request, env, session, role, id, t, { ok: true, unhid: Boolean((res && res.meta && res.meta.changes) || (log && log.meta && log.meta.changes)) });
}

export async function staffProfileRoute(request, env, session, route, t) {
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', STAFF_ONLY);
  const n = route.length;
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  const nope = () => fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (n < 3) return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  const id = personId(route[2]);
  if (n === 3) return read ? viewReply(request, env, session, role, id, t) : nope();
  if (n === 5 && route[3] === 'look') return method === 'DELETE' ? resetPart(request, env, session, role, id, route[4], t) : nope();
  if (n === 4 && route[3] === 'hide') return method === 'POST' ? hideName(request, env, session, role, id, t) : nope();
  if (n === 5 && route[3] === 'hide') return method === 'DELETE' ? unhideName(request, env, session, role, id, route[4], t) : nope();
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

function noticeOut(r) {
  let detail = {};
  try {
    detail = JSON.parse(r.detail || '{}') || {};
  } catch {}
  const fields = Array.isArray(detail.fields) ? detail.fields.filter((f) => f === 'bio' || f === 'status' || f === 'pronouns') : [];
  const out = { action: r.action, at: Number(r.created) || 0 };
  if (typeof detail.part === 'string') out.part = detail.part;
  if (fields.length) out.fields = fields;
  return out;
}

export async function profileNotices(env, session, t) {
  const id = lower(session.user_id);
  const db = env.DB;
  const marks = RESET_ACTIONS.map(() => '?').join(', ');
  const [hidden, resets] = await Promise.all([
    hiddenRows(db, id),
    db.prepare(`SELECT action, detail, created FROM party_mod_log WHERE target_id = ? AND action IN (${marks}) AND created > ? ORDER BY created DESC, id DESC LIMIT ?`).bind(id, ...RESET_ACTIONS, t - NOTICE_DAYS * DAY, NOTICE_MAX).all(),
  ]);
  return json({
    hidden: {
      name: hidden.name ? { at: hidden.name.at } : null,
      username: hidden.username ? { at: hidden.username.at } : null,
    },
    resets: ((resets && resets.results) || []).map(noticeOut),
  });
}

export function noticesRoute(request, env, session, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  return profileNotices(env, session, t);
}
