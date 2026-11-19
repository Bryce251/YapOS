import { DAY, USER_BODY_LIMIT, json, fail, readJson, isPlainObject, parseJsonSafe, randomToken } from './util.js';
import { cleanText } from './profiles.js';
import { avatarsFor } from './avatar-store.js';

export const INBOX_MAX = 200;
export const INBOX_KEEP = 90 * DAY;
export const INBOX_PAGE = 30;
export const INBOX_NEWEST = 5;
export const NOTE_KINDS = Object.freeze(['clan_invite', 'clan_joined', 'clan_left', 'clan_kicked', 'clan_leader', 'clan_closed', 'clan_declined', 'clan_refused', 'clan_done', 'gift', 'badge', 'achievement', 'profile_like']);
const KIND_SET = new Set(NOTE_KINDS);
const NOTE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const TITLE_MAX = 120;
const BODY_MAX = 300;
const READ_IDS_MAX = 100;
const WARNINGS_SHOWN = 10;

const lower = (v) => String(v ?? '').toLowerCase();

export function noteId(prefix = 'n') {
  return `${prefix}-${randomToken(12)}`;
}

export function cleanNote(n) {
  if (!isPlainObject(n) || typeof n.user !== 'string' || !n.user || !KIND_SET.has(n.kind)) return null;
  const title = cleanText(typeof n.title === 'string' ? n.title : '', TITLE_MAX);
  if (!title) return null;
  const id = typeof n.id === 'string' && NOTE_ID_RE.test(n.id) ? n.id : noteId();
  const body = cleanText(typeof n.body === 'string' ? n.body : '', BODY_MAX) || null;
  const data = isPlainObject(n.data) ? JSON.stringify(n.data) : null;
  return { id, user: lower(n.user), kind: n.kind, title, body, data };
}

export function noteStatements(db, notes, t) {
  const stmts = [];
  const users = new Set();
  for (const raw of notes) {
    const n = cleanNote(raw);
    if (!n) continue;
    users.add(n.user);
    stmts.push(db.prepare('INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, data, created, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').bind(n.id, n.user, n.kind, n.title, n.body, n.data, t));
  }
  for (const u of users) {
    stmts.push(db.prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT ?)').bind(u, u, INBOX_MAX));
  }
  return stmts;
}

export async function addNotes(db, notes, t) {
  const stmts = noteStatements(db, notes, t);
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

export function inboxCleanupStatements(db, t) {
  return [db.prepare('DELETE FROM notifications WHERE created < ?').bind(t - INBOX_KEEP)];
}

async function unreadCount(db, me) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(me).first();
  return Number((row && row.n) || 0);
}

function actionStatus(a) {
  if (!a) return null;
  const open = a.status === 'queued' || a.status === 'sent';
  return { id: a.id, status: open ? 'pending' : a.status === 'done' ? 'done' : 'refused', message: open ? 'Waiting for YapOS…' : a.result || null };
}

export function noteOut(r, { live = null, action = null } = {}) {
  const data = parseJsonSafe(r.data, null) || {};
  const out = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body || null,
    created: Number(r.created),
    read: r.read_at !== null && r.read_at !== undefined,
    link: null,
    clan: typeof data.tag === 'string' ? { id: typeof data.clan === 'string' ? data.clan : null, tag: data.tag } : null,
    canAnswer: false,
    answer: actionStatus(action),
  };
  if (typeof data.person === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.person)) out.person = { id: lower(data.person) };
  if (r.kind === 'clan_invite') out.canAnswer = Boolean(live && live.has(data.clan)) && !out.answer;
  if (r.kind.startsWith('clan_')) out.link = '/clans';
  if (r.kind === 'badge' || r.kind === 'achievement' || r.kind === 'gift') out.link = '/account';
  if (r.kind === 'profile_like' && typeof data.link === 'string' && /^\/u\/[^/?#]{1,200}$/.test(data.link)) out.link = data.link;
  return out;
}

async function withPeople(db, items) {
  const ids = [...new Set(items.filter((x) => x.person).map((x) => x.person.id))];
  if (!ids.length) return items;
  const found = await avatarsFor(db, ids).catch(() => new Map());
  return items.map((x) => {
    if (!x.person) return x;
    const pic = found.get(x.person.id);
    return { ...x, person: { id: x.person.id, avatar: (pic && pic.avatar) || null, ...(pic && pic.avatarStill ? { avatarStill: pic.avatarStill } : {}) } };
  });
}

async function listItems(db, me, url, t) {
  const before = Number(url.searchParams.get('before'));
  const limit = Math.max(1, Math.min(INBOX_PAGE, Math.floor(Number(url.searchParams.get('limit')) || INBOX_PAGE)));
  const res = Number.isFinite(before) && before > 0
    ? await db.prepare('SELECT rowid AS seq, id, kind, title, body, data, created, read_at FROM notifications WHERE user_id = ? AND created < ? ORDER BY created DESC, rowid DESC LIMIT ?').bind(me, before, limit + 1).all()
    : await db.prepare('SELECT rowid AS seq, id, kind, title, body, data, created, read_at FROM notifications WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT ?').bind(me, limit + 1).all();
  const rows = (res && res.results) || [];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const live = new Set((((await db.prepare('SELECT clan_id FROM clan_invites WHERE user_id = ?').bind(me).all()) || {}).results || []).map((x) => x.clan_id));
  const actionIds = page.map((r) => parseJsonSafe(r.data, null)?.action).filter((x) => typeof x === 'string');
  const actions = new Map();
  for (const id of actionIds) {
    const a = await db.prepare('SELECT id, status, result FROM clan_actions WHERE id = ? AND user_id = ?').bind(id, me).first();
    if (a) actions.set(id, a);
  }
  const items = await withPeople(db, page.map((r) => noteOut(r, { live, action: actions.get(parseJsonSafe(r.data, null)?.action) || null })));
  const warn = await db.prepare('SELECT id, author_name, text, created, seen_at FROM party_warnings WHERE user_id = ? ORDER BY created DESC LIMIT ?').bind(me, WARNINGS_SHOWN).all();
  const warnings = ((warn && warn.results) || []).map((w) => ({ id: w.id, by: w.author_name || 'Staff', text: w.text, created: Number(w.created), seen: w.seen_at !== null && w.seen_at !== undefined }));
  return json({ items, unread: await unreadCount(db, me), more, next: more && page.length ? Number(page[page.length - 1].created) : null, warnings });
}

async function countOnly(db, me) {
  const res = await db.prepare('SELECT id, kind, title, body, data, created, read_at FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created DESC, rowid DESC LIMIT ?').bind(me, INBOX_NEWEST).all();
  const newest = ((res && res.results) || []).map((r) => noteOut(r));
  return json({ unread: await unreadCount(db, me), newest });
}

async function markRead(request, db, me, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  if (body.all === true) {
    const r = await db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(t, me).run();
    return json({ ok: true, changed: Number((r && r.meta && r.meta.changes) || 0), unread: await unreadCount(db, me) });
  }
  if (!Array.isArray(body.ids) || !body.ids.length) return fail(400, 'bad_ids', 'Say which notifications to mark as read.');
  if (body.ids.length > READ_IDS_MAX) return fail(413, 'too_many', `Mark at most ${READ_IDS_MAX} at once.`);
  const ids = [...new Set(body.ids.filter((x) => typeof x === 'string' && NOTE_ID_RE.test(x)))];
  const unread = body.unread === true;
  const stmts = ids.map((id) => db.prepare(`UPDATE notifications SET read_at = ${unread ? 'NULL' : '?'} WHERE id = ? AND user_id = ?`).bind(...(unread ? [id, me] : [t, id, me])));
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, changed: stmts.length, unread: await unreadCount(db, me) });
}

async function deleteOne(db, me, id) {
  if (!NOTE_ID_RE.test(id)) return fail(400, 'bad_id', "That notification id doesn't look right.");
  const r = await db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').bind(id, me).run();
  if (!Number((r && r.meta && r.meta.changes) || 0)) return fail(404, 'not_found', 'That notification is already gone.');
  return json({ ok: true, unread: await unreadCount(db, me) });
}

async function clearRead(db, me) {
  const r = await db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').bind(me).run();
  return json({ ok: true, removed: Number((r && r.meta && r.meta.changes) || 0), unread: await unreadCount(db, me) });
}

export async function inboxRoute(request, env, session, route, url, t, { answer } = {}) {
  const db = env.DB;
  const me = lower(session.user_id);
  const method = request.method;
  const n = route.length;
  const readOnly = method === 'GET' || method === 'HEAD';
  if (n === 2) {
    if (readOnly) return listItems(db, me, url, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3 && route[2] === 'count') {
    if (readOnly) return countOnly(db, me);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3 && route[2] === 'read') {
    if (method === 'POST') return markRead(request, db, me, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3 && route[2] === 'clear') {
    if (method === 'POST') return clearRead(db, me);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3) {
    if (method === 'DELETE') return deleteOne(db, me, route[2]);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 4 && route[3] === 'answer') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    if (!NOTE_ID_RE.test(route[2])) return fail(400, 'bad_id', "That notification id doesn't look right.");
    const row = await db.prepare('SELECT id, kind, title, body, data, created, read_at FROM notifications WHERE id = ? AND user_id = ?').bind(route[2], me).first();
    if (!row) return fail(404, 'not_found', 'That notification is gone.');
    if (row.kind !== 'clan_invite') return fail(400, 'not_invite', "There's nothing to answer on that one.");
    const body = await readJson(request, USER_BODY_LIMIT);
    const choice = body.answer === 'accept' || body.answer === 'decline' ? body.answer : null;
    if (!choice) return fail(400, 'bad_answer', 'Choose accept or decline.');
    const data = parseJsonSafe(row.data, null) || {};
    if (data.action) return fail(409, 'answered', 'You already answered this invite.');
    return answer(request, env, session, { note: row, data, choice }, t);
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
