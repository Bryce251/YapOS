import { HttpError, ID_RE, USER_BODY_LIMIT, json, fail, readJson, clientIp, parseJsonSafe, randomToken } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText, cleanUsername } from './profiles.js';
import { normalizeCode } from './party-packs.js';
import { getSession } from './sessions.js';
import { partyRole } from './reports.js';
import { findBlocked } from '../web/activity/js/filter.js';

export const BROWSE_PAGE = 24;
export const BROWSE_MAX_PAGE = 20;
export const BROWSE_SORTS = Object.freeze(['top', 'new']);
export const REPORT_REASON_MAX = 300;
export const PACK_REPORTS_PAGE = 50;
export const MAX_OPEN_REPORTS = 20;
const Q_MAX = 40;
const STATUSES = new Set(['open', 'dismissed', 'all']);
const BLOCKED_MESSAGE = 'This pack was taken off the pack browser by the YapOS Party team, so it can only be shared by code.';
const MISSING = "We couldn't find that word pack. It may have been deleted.";
const cache = new WeakMap();

function bad(code, message) {
  return new HttpError(400, code, message);
}

function clean(text) {
  return typeof text === 'string' && findBlocked(text).length === 0;
}

function counts(row) {
  const words = parseJsonSafe(row.words, []);
  const trivia = parseJsonSafe(row.trivia, []);
  return { wordCount: Array.isArray(words) ? words.length : 0, triviaCount: Array.isArray(trivia) ? trivia.length : 0 };
}

function wordsOf(row) {
  const words = parseJsonSafe(row.words, []);
  return Array.isArray(words) ? words.filter((w) => typeof w === 'string') : [];
}

function escapeLike(q) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function parseBrowse(url) {
  const sort = url.searchParams.get('sort') || 'top';
  if (!BROWSE_SORTS.includes(sort)) throw bad('bad_sort', 'Sort by top or new.');
  const q = (cleanText(url.searchParams.get('q') || '', Q_MAX) || '').toLowerCase();
  const rawPage = url.searchParams.get('page');
  const page = rawPage ? Number(rawPage) : 1;
  if (!Number.isInteger(page) || page < 1 || page > BROWSE_MAX_PAGE) throw bad('bad_page', `The page must be a number from 1 to ${BROWSE_MAX_PAGE}.`);
  return { sort, q, page };
}

async function browseList(db, { sort, q, page }) {
  const where = ['pp.public = 1', 'pp.blocked = 0'];
  const args = [];
  if (q) {
    where.push("LOWER(p.name) LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(q)}%`);
  }
  const order = sort === 'new' ? 'pp.published DESC, p.code ASC' : 'likes DESC, pp.published DESC, p.code ASC';
  const sql = `SELECT p.code, p.owner_id, p.name, p.words, p.trivia, p.updated, pp.published, (SELECT COUNT(*) FROM pack_likes l WHERE l.code = p.code) AS likes, pr.username AS owner_username FROM party_packs p JOIN pack_public pp ON pp.code = p.code LEFT JOIN profiles pr ON pr.id = p.owner_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const res = await db.prepare(sql).bind(...args, BROWSE_PAGE + 1, (page - 1) * BROWSE_PAGE).all();
  const rows = ((res && res.results) || []).filter((r) => clean(r.name));
  const more = rows.length > BROWSE_PAGE;
  const packs = rows.slice(0, BROWSE_PAGE).map((r) => ({
    code: r.code,
    name: r.name,
    ...counts(r),
    likes: Number(r.likes) || 0,
    by: cleanUsername(r.owner_username),
    published: Number(r.published) || null,
    updated: Number(r.updated) || null,
  }));
  return { packs, more };
}

export async function browsePacks(request, env, url, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('browse', clientIp(request)), LIMITS.browse, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const params = parseBrowse(url);
  const key = `${params.sort}|${params.page}|${params.q}`;
  let store = cache.get(env.DB);
  if (!store) {
    store = new Map();
    cache.set(env.DB, store);
  }
  let entry = store.get(key);
  if (!entry || entry.at + 30_000 < t || entry.at > t) {
    entry = { at: t, ...(await browseList(env.DB, params)) };
    store.set(key, entry);
    while (store.size > 200) store.delete(store.keys().next().value);
  }
  const body = { packs: entry.packs, sort: params.sort, q: params.q, page: params.page, more: entry.more, liked: [] };
  const session = await getSession(env.DB, request, t);
  if (!session || !entry.packs.length) {
    return json(body, 200, { 'Cache-Control': session ? 'private, no-store' : 'public, max-age=30' });
  }
  const codes = entry.packs.map((p) => p.code);
  const res = await env.DB.prepare(`SELECT code FROM pack_likes WHERE user_id = ? AND code IN (${codes.map(() => '?').join(', ')})`).bind(String(session.user_id).toLowerCase(), ...codes).all();
  body.liked = ((res && res.results) || []).map((r) => r.code);
  return json(body, 200, { 'Cache-Control': 'private, no-store' });
}

function dropCache(db) {
  cache.delete(db);
}

async function packRow(db, raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  return db.prepare('SELECT p.code, p.owner_id, p.name, pp.public, pp.blocked FROM party_packs p LEFT JOIN pack_public pp ON pp.code = p.code WHERE p.code = ?').bind(code).first();
}

async function likePack(env, session, raw, t) {
  const userId = String(session.user_id).toLowerCase();
  const limit = await hit(env.DB, `packLikes:u:${userId}`, LIMITS.packLikes, t);
  if (!limit.ok) return tooMany(limit.retryAfter, 'That is a lot of likes at once. Wait a minute and try again.');
  const row = await packRow(env.DB, raw);
  if (!row) return fail(404, 'not_found', MISSING);
  const had = await env.DB.prepare('SELECT 1 AS y FROM pack_likes WHERE code = ? AND user_id = ?').bind(row.code, userId).first();
  if (had) {
    await env.DB.prepare('DELETE FROM pack_likes WHERE code = ? AND user_id = ?').bind(row.code, userId).run();
  } else {
    if (!Number(row.public) || Number(row.blocked)) return fail(409, 'not_public', "That pack isn't on the pack browser, so it can't be liked.");
    if (String(row.owner_id).toLowerCase() === userId) return fail(400, 'own_pack', "That's your own pack, so it can't be liked by you.");
    await env.DB.prepare('INSERT INTO pack_likes (code, user_id, at) VALUES (?, ?, ?) ON CONFLICT (code, user_id) DO NOTHING').bind(row.code, userId, t).run();
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM pack_likes WHERE code = ?').bind(row.code).first();
  dropCache(env.DB);
  return json({ ok: true, code: row.code, liked: !had, likes: Number(n && n.n) || 0 });
}

async function reportPack(request, env, session, raw, t) {
  const userId = String(session.user_id).toLowerCase();
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (k !== 'reason') throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw bad('bad_reason', "The reason doesn't look right.");
  const limit = await hit(env.DB, `packReports:u:${userId}`, LIMITS.packReports, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "You've sent a few reports already. Wait a minute and try again.");
  const row = await packRow(env.DB, raw);
  if (!row) return fail(404, 'not_found', MISSING);
  if (String(row.owner_id).toLowerCase() === userId) return fail(400, 'own_pack', "That's your own pack. You can edit or delete it instead.");
  const open = await env.DB.prepare("SELECT id FROM pack_reports WHERE code = ? AND reporter_id = ? AND status = 'open'").bind(row.code, userId).first();
  if (open) return json({ ok: true, reported: false, already: true });
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM pack_reports WHERE reporter_id = ? AND status = 'open'").bind(userId).first();
  if ((Number(mine && mine.n) || 0) >= MAX_OPEN_REPORTS) return tooMany(3600, "You have lots of reports waiting already. The YapOS Party team will look at them soon.");
  const reason = cleanText(body.reason, REPORT_REASON_MAX);
  await env.DB
    .prepare("INSERT INTO pack_reports (id, code, reporter_id, reporter_name, reason, created, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
    .bind(randomToken(12), row.code, userId, cleanText(session.display_name || session.username, 64), reason, t)
    .run();
  return json({ ok: true, reported: true }, 201);
}

export function packSocialRoute(request, env, session, route, t) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route[2] === 'like') return likePack(env, session, route[1], t);
  if (route[2] === 'report') return reportPack(request, env, session, route[1], t);
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export async function publicInfo(db, codes) {
  const out = new Map();
  if (!codes.length) return out;
  const marks = codes.map(() => '?').join(', ');
  const [flags, likes] = await Promise.all([
    db.prepare(`SELECT code, public, blocked FROM pack_public WHERE code IN (${marks})`).bind(...codes).all(),
    db.prepare(`SELECT code, COUNT(*) AS n FROM pack_likes WHERE code IN (${marks}) GROUP BY code`).bind(...codes).all(),
  ]);
  for (const code of codes) out.set(code, { public: false, blocked: false, likes: 0 });
  for (const r of (flags && flags.results) || []) Object.assign(out.get(r.code), { public: Boolean(Number(r.public)), blocked: Boolean(Number(r.blocked)) });
  for (const r of (likes && likes.results) || []) out.get(r.code).likes = Number(r.n) || 0;
  return out;
}

export async function setPublic(db, code, value, t) {
  const row = await db.prepare('SELECT public, blocked, published FROM pack_public WHERE code = ?').bind(code).first();
  if (value && row && Number(row.blocked)) throw new HttpError(403, 'blocked', BLOCKED_MESSAGE);
  const before = row && row.published !== null && row.published !== undefined ? Number(row.published) : null;
  const published = value ? before || t : before;
  await db
    .prepare('INSERT INTO pack_public (code, public, blocked, published, updated) VALUES (?, ?, 0, ?, ?) ON CONFLICT (code) DO UPDATE SET public = excluded.public, published = excluded.published, updated = excluded.updated')
    .bind(code, value ? 1 : 0, published, t)
    .run();
  dropCache(db);
}

export function deletePackStatements(db, code) {
  dropCache(db);
  return [
    db.prepare('DELETE FROM pack_public WHERE code = ?').bind(code),
    db.prepare('DELETE FROM pack_likes WHERE code = ?').bind(code),
    db.prepare('DELETE FROM pack_reports WHERE code = ?').bind(code),
  ];
}

async function listPackReports(env, url, role) {
  const status = url.searchParams.get('status') || 'open';
  if (!STATUSES.has(status)) throw bad('bad_status', 'Pick open, dismissed or all reports.');
  const where = status === 'all' ? '' : 'WHERE r.status = ?';
  const args = status === 'all' ? [] : [status];
  const res = await env.DB
    .prepare(`SELECT r.id, r.code, r.reporter_id, r.reporter_name, r.reason, r.created, r.status, r.dismissed_at, r.dismissed_by, p.name, p.owner_id, p.words, p.trivia, pp.public, pp.blocked, pr.username AS owner_username FROM pack_reports r LEFT JOIN party_packs p ON p.code = r.code LEFT JOIN pack_public pp ON pp.code = r.code LEFT JOIN profiles pr ON pr.id = p.owner_id ${where} ORDER BY r.created DESC, r.id DESC LIMIT ?`)
    .bind(...args, PACK_REPORTS_PAGE)
    .all();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM pack_reports WHERE status = 'open'").first();
  const reports = ((res && res.results) || []).map((r) => ({
    id: r.id,
    code: r.code,
    reason: r.reason || null,
    created: Number(r.created),
    status: r.status,
    dismissed_at: r.dismissed_at === null || r.dismissed_at === undefined ? null : Number(r.dismissed_at),
    dismissed_by: r.dismissed_by || null,
    reporter: { id: r.reporter_id, name: r.reporter_name || null },
    pack: r.name === null || r.name === undefined ? null : {
      code: r.code,
      name: r.name,
      owner: { id: r.owner_id, username: cleanUsername(r.owner_username) },
      ...counts(r),
      words: wordsOf(r).slice(0, 60),
      public: Boolean(Number(r.public)),
      blocked: Boolean(Number(r.blocked)),
    },
  }));
  return json({ reports, open: Number(open && open.n) || 0, status, role });
}

async function reportById(env, raw) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That report id doesn't look right.");
  return env.DB.prepare('SELECT id, code, status FROM pack_reports WHERE id = ?').bind(raw).first();
}

async function staffAction(env, session, raw, action, t) {
  const report = await reportById(env, raw);
  if (!report) return fail(404, 'not_found', 'That report is gone. Someone may have deleted it.');
  const db = env.DB;
  if (action === 'dismiss') {
    const res = await db.prepare("UPDATE pack_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE id = ? AND status = 'open'").bind(t, session.user_id, report.id).run();
    return json({ ok: true, dismissed: Boolean(res && res.meta && res.meta.changes) });
  }
  if (action === 'hide') {
    await db.batch([
      db.prepare('INSERT INTO pack_public (code, public, blocked, published, updated) VALUES (?, 0, 1, NULL, ?) ON CONFLICT (code) DO UPDATE SET blocked = 1, updated = excluded.updated').bind(report.code, t),
      db.prepare("UPDATE pack_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE code = ? AND status = 'open'").bind(t, session.user_id, report.code),
    ]);
    dropCache(db);
    return json({ ok: true, hidden: true, code: report.code });
  }
  if (action === 'restore') {
    await db.prepare('UPDATE pack_public SET blocked = 0, updated = ? WHERE code = ?').bind(t, report.code).run();
    dropCache(db);
    return json({ ok: true, restored: true, code: report.code });
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export async function packReportsRoute(request, env, session, route, url, t) {
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', 'Only the YapOS Party team can see pack reports.');
  const method = request.method;
  if (route.length === 2) {
    if (method === 'GET' || method === 'HEAD') return listPackReports(env, url, role);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (route.length === 4) {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return staffAction(env, session, route[2], route[3], t);
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export function packReportsCleanupStatements(db, t) {
  return [db.prepare("DELETE FROM pack_reports WHERE status = 'dismissed' AND dismissed_at < ?").bind(t - 30 * 24 * 60 * 60 * 1000)];
}
