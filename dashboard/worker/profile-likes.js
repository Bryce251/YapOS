import { HOUR, DAY, USER_BODY_LIMIT, json, fail, readJson, isPlainObject, clientIp } from './util.js';
import { hit, ipKey, tooMany } from './rate.js';
import { getSession } from './sessions.js';
import { cleanUsername } from './profiles.js';
import { applySettings, safeName } from './public-profiles.js';
import { activeBanSql, activeBanIds } from './party-mod.js';
import { hiddenNameMap, flagsFor } from './hidden-names.js';
import { avatarsFor } from './avatar-store.js';
import { noteStatements, noteId } from './inbox.js';

export const LIKE_KIND = 'profile_like';
export const LIKE_LIMITS = Object.freeze({ user: 30, ip: 60, read: 120 });
export const LIKE_BATCH_WINDOW = 12 * HOUR;
export const LIKE_PING_COOLDOWN = DAY;
export const LIKE_PAGE = 20;
export const LIKE_PAGE_MAX = 50;
export const LIKE_NOTE_LIKERS = 50;
export const PRIVATE_LIKER = 'Private profile';
export const SOMEONE = 'Someone';

const MISSING = "This profile is private or doesn't exist.";
const LOOKUP_RE = /^[^\s/\\?#]{1,64}$/;
const CURSOR_RE = /^([0-9]{1,16})\.([0-9]{1,16})$/;
const NAME_MAX = 64;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const lower = (v) => String(v ?? '').toLowerCase();

function countSql(t) {
  return `SELECT COUNT(*) AS n FROM profile_likes l WHERE l.target_id = ? AND NOT ${activeBanSql('l.liker_id', t)} AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE LOWER(pr.id) = l.liker_id AND pr.missing = 1)`;
}

export async function likeCount(db, targetId, t = Date.now()) {
  const row = await db.prepare(countSql(t)).bind(lower(targetId)).first();
  return Number((row && row.n) || 0);
}

export async function findTarget(db, raw) {
  const name = typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
  if (!LOOKUP_RE.test(name)) return null;
  const row = await db
    .prepare('SELECT user_id, username, name, hidden, shards, updated FROM public_profiles WHERE username_key = ? ORDER BY updated DESC LIMIT 1')
    .bind(name.toLowerCase())
    .first();
  if (!row || !row.username) return null;
  const settings = await db.prepare('SELECT hidden, show_shards, claimed, updated FROM profile_settings WHERE user_id = ?').bind(row.user_id).first();
  if (applySettings(row, settings).hidden) return null;
  const gone = await db.prepare('SELECT 1 AS x FROM profiles WHERE LOWER(id) = ? AND missing = 1 LIMIT 1').bind(lower(row.user_id)).first();
  if (gone) return null;
  return { id: lower(row.user_id), username: cleanUsername(row.username) || row.username, name: safeName(row.name, NAME_MAX, null) };
}

async function visibleRows(db, ids) {
  const list = [...new Set(ids.map(lower))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const marks = part.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT p.user_id, p.username, p.name, p.hidden, p.shards, p.updated, s.hidden AS s_hidden, s.show_shards AS s_show_shards, s.claimed AS s_claimed, s.updated AS s_updated FROM public_profiles p LEFT JOIN profile_settings s ON s.user_id = p.user_id WHERE p.user_id IN (${marks})`)
      .bind(...part)
      .all();
    for (const r of (res && res.results) || []) {
      const settings = r.s_updated === null || r.s_updated === undefined ? null : { hidden: r.s_hidden, show_shards: r.s_show_shards, claimed: r.s_claimed, updated: r.s_updated };
      const username = cleanUsername(r.username);
      if (!username || applySettings(r, settings).hidden) continue;
      out.set(lower(r.user_id), { username, name: safeName(r.name, NAME_MAX, null) || username });
    }
  }
  return out;
}

function shownPerson(row, flags) {
  if (!row) return null;
  if (flags && flags.username) return null;
  return { username: row.username, name: flags && flags.name ? null : row.name };
}

export function likeTitle(name, count) {
  const who = name || SOMEONE;
  const others = Math.max(0, count - 1);
  if (!others) return `${who} liked your profile`;
  return `${who} and ${others} ${others === 1 ? 'other' : 'others'} liked your profile`;
}

async function notifyLike(db, liker, target, t) {
  const ping = await db.prepare('SELECT at FROM profile_like_pings WHERE liker_id = ? AND target_id = ?').bind(liker, target.id).first();
  if (ping && Number(ping.at) > t - LIKE_PING_COOLDOWN) return false;
  const rows = await visibleRows(db, [liker]);
  const flags = flagsFor(await hiddenNameMap(db, t), liker);
  const person = shownPerson(rows.get(liker), flags);
  const name = person && person.name ? person.name : null;
  const open = await db
    .prepare('SELECT id, data FROM notifications WHERE user_id = ? AND kind = ? AND read_at IS NULL AND created > ? ORDER BY created DESC, rowid DESC LIMIT 1')
    .bind(target.id, LIKE_KIND, t - LIKE_BATCH_WINDOW)
    .first();
  const link = `/u/${encodeURIComponent(target.username)}`;
  const pingStmt = db.prepare('INSERT INTO profile_like_pings (liker_id, target_id, at) VALUES (?, ?, ?) ON CONFLICT (liker_id, target_id) DO UPDATE SET at = excluded.at').bind(liker, target.id, t);
  if (open) {
    let data = {};
    try {
      data = JSON.parse(open.data || '{}');
    } catch {
      data = {};
    }
    const before = Array.isArray(data.likers) ? data.likers.filter((x) => typeof x === 'string') : [];
    const count = before.includes(liker) ? Math.max(1, Number(data.count) || before.length) : (Number(data.count) || before.length) + 1;
    const likers = [liker, ...before.filter((x) => x !== liker)].slice(0, LIKE_NOTE_LIKERS);
    const next = { likers, count, link, ...(name ? { person: liker } : {}) };
    await db.batch([
      db.prepare('UPDATE notifications SET title = ?, data = ?, created = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').bind(likeTitle(name, count), JSON.stringify(next), t, open.id, target.id),
      pingStmt,
    ]);
    return true;
  }
  const note = { id: noteId('like'), user: target.id, kind: LIKE_KIND, title: likeTitle(name, 1), data: { likers: [liker], count: 1, link, ...(name ? { person: liker } : {}) } };
  await db.batch([...noteStatements(db, [note], t), pingStmt]);
  return true;
}

async function stateFor(db, target, me, t) {
  const count = await likeCount(db, target.id, t);
  const own = Boolean(me && me === target.id);
  let liked = false;
  if (me && !own) liked = Boolean(await db.prepare('SELECT 1 AS x FROM profile_likes WHERE liker_id = ? AND target_id = ?').bind(me, target.id).first());
  return { count, liked, own, signedIn: Boolean(me), canLike: Boolean(me) && !own };
}

async function readLike(request, env, raw, t) {
  const limit = await hit(env.DB, await ipKey('profileLikesRead', clientIp(request)), LIKE_LIMITS.read, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const target = await findTarget(env.DB, raw);
  if (!target) return fail(404, 'not_found', MISSING, undefined, NO_STORE);
  const session = await getSession(env.DB, request, t);
  return json(await stateFor(env.DB, target, session ? lower(session.user_id) : null, t), 200, NO_STORE);
}

async function writeLike(request, env, raw, t, csrf) {
  if (!csrf) return fail(403, 'forbidden', 'This request was blocked for your safety. Reload the page and try again.');
  const session = await getSession(env.DB, request, t);
  if (!session) return fail(401, 'signed_out', 'Sign in to like profiles.');
  const me = lower(session.user_id);
  const ipLimit = await hit(env.DB, await ipKey('profileLikes', clientIp(request)), LIKE_LIMITS.ip, t);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter, 'That is a lot of likes at once. Wait a minute and try again.');
  const userLimit = await hit(env.DB, `profileLikes:u:${me}`, LIKE_LIMITS.user, t);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter, 'That is a lot of likes at once. Wait a minute and try again.');
  const body = await readJson(request, USER_BODY_LIMIT);
  if (!isPlainObject(body) || typeof body.liked !== 'boolean') return fail(400, 'bad_request', '"liked" must be true or false.');
  for (const k of Object.keys(body)) {
    if (k !== 'liked') return fail(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  const target = await findTarget(env.DB, raw);
  if (!target) return fail(404, 'not_found', MISSING, undefined, NO_STORE);
  if (target.id === me) return fail(400, 'is_self', "You can't like your own profile.");
  let notified = false;
  if (body.liked) {
    const res = await env.DB.prepare('INSERT INTO profile_likes (liker_id, target_id, at) VALUES (?, ?, ?) ON CONFLICT (liker_id, target_id) DO NOTHING').bind(me, target.id, t).run();
    const added = Number((res && res.meta && res.meta.changes) || 0) > 0;
    if (added && !(await activeBanIds(env.DB, [me], t)).has(me)) notified = await notifyLike(env.DB, me, target, t).catch(() => false);
  } else {
    await env.DB.prepare('DELETE FROM profile_likes WHERE liker_id = ? AND target_id = ?').bind(me, target.id).run();
  }
  return json({ ok: true, notified, ...(await stateFor(env.DB, target, me, t)) }, 200, NO_STORE);
}

export async function likesRoute(request, env, segs, t, { csrf = false } = {}) {
  if (segs.length !== 3) return fail(404, 'not_found', MISSING);
  if (request.method === 'GET' || request.method === 'HEAD') return readLike(request, env, segs[2], t);
  if (request.method === 'POST') return writeLike(request, env, segs[2], t, csrf);
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}

function readCursor(raw) {
  const m = typeof raw === 'string' ? CURSOR_RE.exec(raw) : null;
  return m ? { at: Number(m[1]), seq: Number(m[2]) } : null;
}

export async function likedBy(db, targetId, t, { before = null, limit = LIKE_PAGE } = {}) {
  const me = lower(targetId);
  const size = Math.max(1, Math.min(LIKE_PAGE_MAX, Math.floor(Number(limit) || LIKE_PAGE)));
  const cursor = readCursor(before);
  const base = `SELECT l.rowid AS seq, l.liker_id, l.at FROM profile_likes l WHERE l.target_id = ? AND NOT ${activeBanSql('l.liker_id', t)} AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE LOWER(pr.id) = l.liker_id AND pr.missing = 1)`;
  const res = cursor
    ? await db.prepare(`${base} AND (l.at < ? OR (l.at = ? AND l.rowid < ?)) ORDER BY l.at DESC, l.rowid DESC LIMIT ?`).bind(me, cursor.at, cursor.at, cursor.seq, size + 1).all()
    : await db.prepare(`${base} ORDER BY l.at DESC, l.rowid DESC LIMIT ?`).bind(me, size + 1).all();
  const rows = (res && res.results) || [];
  const more = rows.length > size;
  const page = rows.slice(0, size);
  const ids = page.map((r) => lower(r.liker_id));
  const [visible, map, pics] = await Promise.all([
    visibleRows(db, ids),
    hiddenNameMap(db, t),
    avatarsFor(db, ids, { sessions: false }).catch(() => new Map()),
  ]);
  const people = page.map((r) => {
    const id = lower(r.liker_id);
    const person = shownPerson(visible.get(id), flagsFor(map, id));
    if (!person) return { private: true, name: PRIVATE_LIKER, username: null, avatar: null, at: Number(r.at) };
    const pic = pics.get(id);
    return {
      private: false,
      name: person.name || person.username,
      username: person.username,
      avatar: (pic && pic.avatar) || null,
      ...(pic && pic.avatarStill ? { avatarStill: pic.avatarStill } : {}),
      at: Number(r.at),
    };
  });
  const last = page[page.length - 1];
  return { people, count: await likeCount(db, me, t), more, next: more && last ? `${Number(last.at)}.${Number(last.seq)}` : null };
}

export async function likedByRoute(request, env, session, route, url, t) {
  if (route.length !== 2) return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const out = await likedBy(env.DB, session.user_id, t, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') });
  return json(out, 200, NO_STORE);
}

export function likesForgetStatements(db, userId) {
  const id = lower(userId);
  return [
    db.prepare('DELETE FROM profile_likes WHERE liker_id = ? OR target_id = ?').bind(id, id),
    db.prepare('DELETE FROM profile_like_pings WHERE liker_id = ? OR target_id = ?').bind(id, id),
  ];
}

export function likesCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM profile_likes WHERE NOT EXISTS (SELECT 1 FROM public_profiles p WHERE p.user_id = profile_likes.target_id) OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.missing = 1 AND (LOWER(pr.id) = profile_likes.target_id OR LOWER(pr.id) = profile_likes.liker_id))'),
    db.prepare('DELETE FROM profile_like_pings WHERE at < ?').bind(t - LIKE_PING_COOLDOWN),
  ];
}
