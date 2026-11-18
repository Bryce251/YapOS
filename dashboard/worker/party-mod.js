import { HOUR, DAY, ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, clientIp, publicOrigin, randomToken, parseJsonSafe, isPlainObject } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { lookupProfiles, cleanText, MAX_PROFILE_IDS } from './profiles.js';
import { getActivityUser } from './activity-auth.js';
import { censor } from '../web/activity/js/filter.js';
import { staffHiddenFlags } from './hidden-names.js';

export const BAN_DURATIONS = Object.freeze({ hour: HOUR, day: DAY, week: 7 * DAY, forever: 0 });
export const BAN_DURATION_NAMES = Object.freeze({ hour: '1 hour', day: '1 day', week: '1 week', forever: 'forever' });
export const WARNING_MAX = 200;
export const WARNINGS_SHOWN = 50;
export const WARNINGS_PER_PERSON = 100;
export const WARNINGS_PER_TARGET_HOUR = 5;
export const WARNINGS_DELIVERED = 5;
export const WARNING_KEEP = 365 * DAY;
export const MODLOG_PAGE = 30;
export const MODLOG_KEEP = 365 * DAY;
export const MODLOG_MAX = 20000;
export const MODLOG_ACTORS = 60;
export const DETAIL_MAX = 1000;
export const SYSTEM_ACTOR = 'yapos';
export const NOTE_ACTIONS = Object.freeze(['note_add', 'note_delete']);
export const OWNER_ACTION_PREFIX = 'owner_';
export const ACTION_RE = /^[a-z][a-z0-9_]{1,31}$/;
const CURSOR_RE = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/;
const NAME_MAX = 64;
const WARNING_FIELDS = new Set(['text']);

function bad(code, message) {
  return new HttpError(400, code, message);
}

function stamp(t) {
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lower(id) {
  return String(id || '').toLowerCase();
}

export function cleanDuration(value) {
  if (value === undefined || value === null || value === '') return 'forever';
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(BAN_DURATIONS, value)) throw bad('bad_duration', 'Pick 1 hour, 1 day, 1 week or forever.');
  return value;
}

export function banUntilFor(duration, t) {
  const ms = BAN_DURATIONS[duration];
  return ms ? stamp(t) + ms : null;
}

export function banLive(alias, t) {
  return `NOT EXISTS (SELECT 1 FROM party_ban_terms bt WHERE bt.user_id = ${alias}.id AND bt.until <= ${stamp(t)})`;
}

export function activeBanSql(idExpr, t) {
  return `EXISTS (SELECT 1 FROM party_bans b WHERE b.id = ${idExpr} AND ${banLive('b', t)})`;
}

export async function activeBans(db, ids, t) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x).map(lower))];
  const out = new Map();
  if (!list.length) return out;
  const marks = list.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT b.id AS id, bt.until AS until FROM party_bans b LEFT JOIN party_ban_terms bt ON bt.user_id = b.id WHERE b.id IN (${marks}) AND (bt.until IS NULL OR bt.until > ?)`).bind(...list, stamp(t)).all();
  for (const r of (res && res.results) || []) out.set(lower(r.id), r.until === null || r.until === undefined ? null : Number(r.until));
  return out;
}

export async function activeBanIds(db, ids, t) {
  return new Set((await activeBans(db, ids, t)).keys());
}

export async function activeBan(db, id, t) {
  return db.prepare('SELECT b.id, b.name, b.username, b.reason, b.banned_by, b.banned_at, bt.until, bt.duration FROM party_bans b LEFT JOIN party_ban_terms bt ON bt.user_id = b.id WHERE b.id = ? AND (bt.until IS NULL OR bt.until > ?)').bind(lower(id), stamp(t)).first();
}

export function banTermStatements(db, id, duration, t) {
  const until = banUntilFor(duration, t);
  if (!until) return [db.prepare('DELETE FROM party_ban_terms WHERE user_id = ?').bind(lower(id))];
  return [db.prepare('INSERT INTO party_ban_terms (user_id, until, duration, set_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET until = excluded.until, duration = excluded.duration, set_at = excluded.set_at').bind(lower(id), until, duration, stamp(t))];
}

function clipDetail(value, depth = 0) {
  if (typeof value === 'string') return Array.from(value).slice(0, 200).join('');
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return depth > 1 ? null : value.slice(0, 10).map((v) => clipDetail(v, depth + 1));
  if (isPlainObject(value) && depth <= 1) {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 12)) {
      if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) && v !== undefined) out[k] = clipDetail(v, depth + 1);
    }
    return out;
  }
  return null;
}

export function ownerLogAction(kind) {
  const tail = String(kind || '').replace(/^party\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${OWNER_ACTION_PREFIX}${tail || 'edit'}`.slice(0, 32);
}

export function detailJson(detail) {
  if (detail === null || detail === undefined) return null;
  const clean = clipDetail(isPlainObject(detail) ? detail : { value: detail });
  const text = JSON.stringify(clean);
  if (text.length <= DETAIL_MAX) return text;
  const summary = typeof clean.summary === 'string' ? clean.summary : '';
  return JSON.stringify(summary ? { summary } : {});
}

export function actorName(session) {
  return cleanText(session && (session.display_name || session.username), NAME_MAX) || 'Staff';
}

export function logModAction(db, entry, guard = null) {
  const e = entry || {};
  const action = String(e.action || '');
  if (!ACTION_RE.test(action)) throw new TypeError('logModAction: bad action');
  const actor = lower(e.actorId);
  if (!actor) throw new TypeError('logModAction: actorId is required');
  const row = [
    randomToken(12),
    actor,
    cleanText(e.actorName, NAME_MAX) || 'Staff',
    action,
    e.targetId ? lower(e.targetId) : null,
    e.targetName ? cleanText(e.targetName, NAME_MAX) || null : null,
    detailJson(e.detail),
    stamp(e.t),
  ];
  const cols = 'INSERT INTO party_mod_log (id, actor_id, actor_name, action, target_id, target_name, detail, created)';
  if (!guard || !guard.sql) return db.prepare(`${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(...row);
  return db.prepare(`${cols} SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`).bind(...row, ...(guard.args || []));
}

export async function personName(db, id) {
  const key = lower(id);
  const row = await db.prepare('SELECT COALESCE((SELECT display_name FROM profiles WHERE id = ?), (SELECT username FROM profiles WHERE id = ?), (SELECT drawer_name FROM party_reports WHERE drawer_id = ? ORDER BY created DESC LIMIT 1), (SELECT name FROM party_bans WHERE id = ?)) AS name').bind(key, key, key, key).first();
  return row && row.name ? cleanText(row.name, NAME_MAX) || null : null;
}

export function banCleanupStatements(db, t) {
  const now = stamp(t);
  const expired = 'SELECT bt.user_id FROM party_ban_terms bt JOIN party_bans b ON b.id = bt.user_id WHERE bt.until <= ?';
  return [
    db.prepare(`INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) SELECT lower(hex(randomblob(12))), bt.user_id, 'unban', 'The ban ran out', '${SYSTEM_ACTOR}', bt.until FROM party_ban_terms bt JOIN party_bans b ON b.id = bt.user_id WHERE bt.until <= ?`).bind(now),
    db.prepare(`INSERT INTO party_mod_log (id, actor_id, actor_name, action, target_id, target_name, detail, created) SELECT lower(hex(randomblob(12))), '${SYSTEM_ACTOR}', 'YapOS', 'ban_expire', bt.user_id, b.name, json_object('duration', bt.duration), bt.until FROM party_ban_terms bt JOIN party_bans b ON b.id = bt.user_id WHERE bt.until <= ?`).bind(now),
    db.prepare(`DELETE FROM party_bans WHERE id IN (${expired})`).bind(now),
    db.prepare('DELETE FROM party_ban_terms WHERE until <= ? OR user_id NOT IN (SELECT id FROM party_bans)').bind(now),
    db.prepare('DELETE FROM party_warnings WHERE created < ?').bind(now - WARNING_KEEP),
    db.prepare('DELETE FROM party_warnings WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created DESC, id DESC) AS n FROM party_warnings) WHERE n > ?)').bind(WARNINGS_PER_PERSON),
    db.prepare('DELETE FROM party_mod_log WHERE created < ?').bind(now - MODLOG_KEEP),
    db.prepare('DELETE FROM party_mod_log WHERE id IN (SELECT id FROM party_mod_log ORDER BY created DESC, id DESC LIMIT -1 OFFSET ?)').bind(MODLOG_MAX),
  ];
}

export const BAN_CLEANUP_NAMES = Object.freeze(['banExpireLog', 'banExpireModLog', 'expiredBans', 'banTerms', 'oldWarnings', 'extraWarnings', 'oldModLog', 'extraModLog']);

export function cleanWarning(value) {
  if (typeof value !== 'string') throw bad('bad_text', 'Write the warning first.');
  const text = cleanText(value, WARNING_MAX + 1);
  if (!text) throw bad('bad_text', 'Write the warning first.');
  if (Array.from(text).length > WARNING_MAX) throw bad('too_long', `Keep warnings under ${WARNING_MAX} characters.`);
  return censor(text).text;
}

export async function warningRows(db, id, limit = WARNINGS_SHOWN) {
  const res = await db.prepare('SELECT id, user_id, author_id, author_name, text, created, seen_at FROM party_warnings WHERE user_id = ? ORDER BY created DESC, id DESC LIMIT ?').bind(lower(id), limit).all();
  return (res && res.results) || [];
}

export function warningsOut(rows, profiles = new Map()) {
  return rows.map((w) => {
    const p = profiles.get(w.author_id) || null;
    return {
      id: w.id,
      text: w.text,
      created: Number(w.created),
      seen: w.seen_at !== null && w.seen_at !== undefined,
      seen_at: w.seen_at === null || w.seen_at === undefined ? null : Number(w.seen_at),
      author: { id: w.author_id, name: (p && p.display_name) || w.author_name, avatar: (p && p.avatar) || null },
    };
  });
}

export async function sendWarning(request, env, session, role, id, t, { isOwnerId, isAdminId }) {
  const viewer = lower(session.user_id);
  if (id === viewer) return fail(403, 'is_self', "You can't warn yourself.");
  if (isOwnerId(id)) return fail(400, 'is_owner', "The owner of YapOS Party can't be warned.");
  if (role !== 'owner' && (await isAdminId(id))) return fail(403, 'is_admin', "Party admins can't warn other party admins. Ask the owner.");
  const limit = await hit(env.DB, `warn:u:${viewer}`, LIMITS.modWarnings, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "That's a lot of warnings at once. Wait a minute and try again.");
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (!WARNING_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  const text = cleanWarning(body.text);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(created) AS first FROM party_warnings WHERE user_id = ? AND created > ?').bind(id, t - HOUR).first();
  if (Number(recent && recent.n) >= WARNINGS_PER_TARGET_HOUR) {
    const wait = Math.max(1, Math.ceil((Number(recent.first) + HOUR - t) / 1000));
    return tooMany(wait, 'They already got a lot of warnings this hour. Give them time to read them.');
  }
  const name = actorName(session);
  const warnId = randomToken(12);
  const target = await personName(env.DB, id);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO party_warnings (id, user_id, author_id, author_name, text, created, seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)').bind(warnId, id, viewer, name, text, t),
    logModAction(env.DB, { actorId: viewer, actorName: name, action: 'warn', targetId: id, targetName: target, detail: { text }, t }),
  ]);
  const rows = await warningRows(env.DB, id);
  const found = await lookupProfiles(env, [...new Set(rows.map((w) => w.author_id))].slice(0, MAX_PROFILE_IDS), t, clientIp(request));
  return json({ ok: true, sent: warnId, warnings: warningsOut(rows, found.profiles), max: WARNING_MAX }, 201);
}

function activityWarningOut(w) {
  return { id: w.id, text: w.text, created: Number(w.created) };
}

async function activityWarnings(request, env, url, t) {
  const limit = await hit(env.DB, await ipKey('warnings', clientIp(request)), LIMITS.activityWarnings, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const found = await getActivityUser(env.DB, request, t);
  if (!found) return fail(401, 'signed_out', 'Sign in to YapOS Party to see messages from mods.');
  const me = lower(found.user.id);
  const want = url.searchParams.get('for');
  if (want !== null && (!ID_RE.test(want) || lower(want) !== me)) return json({ warnings: [], mismatch: true });
  const res = await env.DB.prepare('SELECT id, text, created FROM party_warnings WHERE user_id = ? AND seen_at IS NULL ORDER BY created ASC, id ASC LIMIT ?').bind(me, WARNINGS_DELIVERED).all();
  return json({ warnings: ((res && res.results) || []).map(activityWarningOut) });
}

async function seenWarning(request, env, raw, t) {
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  if (!origin || !expected || origin !== expected) return fail(403, 'forbidden', 'This request was blocked for your safety. Reload the game and try again.');
  const limit = await hit(env.DB, await ipKey('warnSeen', clientIp(request)), LIMITS.activityWarnings, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That message id doesn't look right.");
  const found = await getActivityUser(env.DB, request, t);
  if (!found) return fail(401, 'signed_out', 'Sign in to YapOS Party to see messages from mods.');
  const res = await env.DB.prepare('UPDATE party_warnings SET seen_at = ? WHERE id = ? AND user_id = ? AND seen_at IS NULL').bind(t, raw, lower(found.user.id)).run();
  return json({ ok: true, seen: Boolean(res && res.meta && res.meta.changes) });
}

export function activityWarningsRoute(request, env, segs, url, t) {
  const method = request.method;
  if (segs.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return activityWarnings(request, env, url, t);
  }
  if (segs.length === 5 && segs[4] === 'seen') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return seenWarning(request, env, segs[3], t);
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

function hiddenWhere(role, viewer) {
  const where = [];
  const args = [];
  if (role !== 'owner') {
    where.push(`substr(action, 1, ${OWNER_ACTION_PREFIX.length}) != ?`);
    args.push(OWNER_ACTION_PREFIX);
    where.push(`NOT (target_id = ? AND action IN (${NOTE_ACTIONS.map(() => '?').join(', ')}))`);
    args.push(viewer, ...NOTE_ACTIONS);
  }
  return { where, args };
}

export function modLogEntry(r, profiles = new Map(), hiddenNames = new Map()) {
  const actor = profiles.get(r.actor_id) || null;
  const target = r.target_id ? profiles.get(r.target_id) || null : null;
  const detail = parseJsonSafe(r.detail, null);
  return {
    id: r.id,
    action: r.action,
    actor: { id: r.actor_id, name: (actor && actor.display_name) || r.actor_name, avatar: (actor && actor.avatar) || null, system: r.actor_id === SYSTEM_ACTOR },
    target: r.target_id ? { id: r.target_id, name: (target && target.display_name) || r.target_name || null, username: (target && target.username) || null, avatar: (target && target.avatar) || null, ...(hiddenNames.has(String(r.target_id).toLowerCase()) ? { hiddenNames: hiddenNames.get(String(r.target_id).toLowerCase()) } : {}) } : null,
    detail: isPlainObject(detail) ? detail : null,
    created: Number(r.created),
  };
}

export async function listModLog(request, env, session, role, url, t) {
  const viewer = lower(session.user_id);
  const actor = url.searchParams.get('actor');
  const action = url.searchParams.get('action');
  const target = url.searchParams.get('target');
  const before = url.searchParams.get('before');
  if (actor && !ID_RE.test(actor)) throw bad('bad_id', "That mod id doesn't look right.");
  if (target && !ID_RE.test(target)) throw bad('bad_id', "That player id doesn't look right.");
  if (action && !ACTION_RE.test(action)) throw bad('bad_action', "That kind of action doesn't exist.");
  let cursor = null;
  if (before) {
    const m = CURSOR_RE.exec(before);
    if (!m) throw bad('bad_cursor', 'That page of the log does not exist.');
    cursor = { created: Number(m[1]), id: m[2] };
  }
  const base = hiddenWhere(role, viewer);
  const where = [...base.where];
  const args = [...base.args];
  if (actor) {
    where.push('actor_id = ?');
    args.push(lower(actor));
  }
  if (action) {
    where.push('action = ?');
    args.push(action);
  }
  if (target) {
    where.push('target_id = ?');
    args.push(lower(target));
  }
  if (cursor) {
    where.push('(created < ? OR (created = ? AND id < ?))');
    args.push(cursor.created, cursor.created, cursor.id);
  }
  const clause = (list) => (list.length ? ` WHERE ${list.join(' AND ')}` : '');
  const db = env.DB;
  const [res, actors, actions] = await Promise.all([
    db.prepare(`SELECT id, actor_id, actor_name, action, target_id, target_name, detail, created FROM party_mod_log${clause(where)} ORDER BY created DESC, id DESC LIMIT ?`).bind(...args, MODLOG_PAGE + 1).all(),
    db.prepare(`SELECT actor_id, MAX(actor_name) AS actor_name, COUNT(*) AS n, MAX(created) AS last FROM party_mod_log${clause(base.where)} GROUP BY actor_id ORDER BY last DESC LIMIT ?`).bind(...base.args, MODLOG_ACTORS).all(),
    db.prepare(`SELECT action, COUNT(*) AS n FROM party_mod_log${clause(base.where)} GROUP BY action ORDER BY action ASC`).bind(...base.args).all(),
  ]);
  const rows = (res && res.results) || [];
  const page = rows.slice(0, MODLOG_PAGE);
  const actorRows = (actors && actors.results) || [];
  const ids = [...new Set(page.flatMap((r) => [r.actor_id, r.target_id]).concat(actorRows.map((a) => a.actor_id)).filter((x) => x && x !== SYSTEM_ACTOR))].slice(0, MAX_PROFILE_IDS);
  const [found, hiddenNames] = await Promise.all([lookupProfiles(env, ids, t, clientIp(request)), staffHiddenFlags(db, page.map((r) => r.target_id).filter(Boolean))]);
  const last = page[page.length - 1];
  return json({
    entries: page.map((r) => modLogEntry(r, found.profiles, hiddenNames)),
    next: rows.length > MODLOG_PAGE && last ? `${Number(last.created)}.${last.id}` : null,
    actors: actorRows.map((a) => {
      const p = found.profiles.get(a.actor_id) || null;
      return { id: a.actor_id, name: (p && p.display_name) || a.actor_name, avatar: (p && p.avatar) || null, count: Number(a.n) || 0, system: a.actor_id === SYSTEM_ACTOR };
    }),
    actions: ((actions && actions.results) || []).map((a) => ({ action: a.action, count: Number(a.n) || 0 })),
    filter: { actor: actor ? lower(actor) : null, action: action || null, target: target ? lower(target) : null },
    role,
    pending: found.pending,
  });
}

