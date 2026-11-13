import { MINUTE, HOUR, DAY, ID_RE, HttpError, json, fail, readJson, isPlainObject, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';

export const MAX_PROFILE_IDS = 40;
export const PROFILE_STALE = 6 * HOUR;
export const PROFILE_KEEP = 30 * DAY;
export const WANTED_CAP = 500;
export const WANTED_PER_POLL = 25;
export const WANTED_RETRY = MINUTE;
export const WANTED_TTL = 10 * MINUTE;
export const AVATAR_HOSTS = new Set(['files.yapper.website', 'www.yapin.gg']);
const MAX_UPLOAD = 100;
const UPLOAD_LIMIT = 64 * 1024;
const USERNAME_MAX = 64;
const DISPLAY_MAX = 64;
const AVATAR_MAX = 1024;
const IDS_TEXT_MAX = MAX_PROFILE_IDS * 66;
const CONTROL_RE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

export function cleanAvatar(value) {
  if (typeof value !== 'string' || !value || value.length > AVATAR_MAX) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !AVATAR_HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

function cleanUsername(value) {
  const text = cleanText(value, USERNAME_MAX + 1);
  if (!text) return null;
  const bare = text.replace(/^@+/, '').replace(/\s+/g, '');
  if (!bare) return null;
  const chars = Array.from(bare);
  return chars.length > USERNAME_MAX ? chars.slice(0, USERNAME_MAX).join('') : bare;
}

export function parseIds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'bad_ids', 'Say which people to look up.');
  if (raw.length > IDS_TEXT_MAX) throw new HttpError(400, 'too_many', `Ask for at most ${MAX_PROFILE_IDS} people at once.`);
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'bad_ids', 'Say which people to look up.');
  if (parts.length > MAX_PROFILE_IDS) throw new HttpError(400, 'too_many', `Ask for at most ${MAX_PROFILE_IDS} people at once.`);
  for (const id of parts) {
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad_id', "One of those user ids doesn't look right.");
  }
  return [...new Set(parts)];
}

function outProfile(row) {
  if (Number(row.missing)) return { id: row.id, username: null, display_name: null, avatar: null };
  return {
    id: row.id,
    username: cleanUsername(row.username),
    display_name: cleanText(row.display_name, DISPLAY_MAX),
    avatar: cleanAvatar(row.avatar_url),
  };
}

async function want(db, ids, t) {
  if (!ids.length) return;
  const stmts = ids.map((id) =>
    db.prepare('INSERT INTO profile_wanted (id, asked, given) VALUES (?, ?, 0) ON CONFLICT (id) DO UPDATE SET asked = excluded.asked').bind(id, t),
  );
  stmts.push(
    db
      .prepare('DELETE FROM profile_wanted WHERE id IN (SELECT id FROM profile_wanted ORDER BY asked DESC, id DESC LIMIT -1 OFFSET ?)')
      .bind(WANTED_CAP),
  );
  await db.batch(stmts);
}

async function freshAsks(db, ids, t) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT id FROM profile_wanted WHERE asked >= ? AND id IN (${marks})`)
    .bind(t - WANTED_TTL, ...ids)
    .all();
  return new Set(((res && res.results) || []).map((r) => r.id));
}

export async function getProfiles(request, env, url, t) {
  const ip = clientIp(request);
  const limit = await hit(env.DB, await ipKey('profiles', ip), LIMITS.profiles, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const ids = parseIds(url.searchParams.get('ids'));
  const marks = ids.map(() => '?').join(', ');
  const res = await env.DB
    .prepare(`SELECT id, username, display_name, avatar_url, missing, fetched FROM profiles WHERE id IN (${marks})`)
    .bind(...ids)
    .all();
  const rows = new Map(((res && res.results) || []).map((r) => [r.id, r]));
  const profiles = [];
  const wanted = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row) profiles.push(outProfile(row));
    if (!row || Number(row.fetched) < t - PROFILE_STALE) wanted.push(id);
  }
  const asked = await freshAsks(env.DB, wanted, t);
  const fresh = wanted.filter((id) => !asked.has(id));
  if (fresh.length) {
    const budget = await hit(env.DB, await ipKey('profileAsks', ip), LIMITS.profileAsks, t, fresh.length);
    if (budget.ok) await want(env.DB, fresh, t);
  }
  const pending = wanted.filter((id) => !rows.has(id));
  const cache = pending.length ? 'no-store' : 'public, max-age=60';
  return json({ profiles, pending }, 200, { 'Cache-Control': cache });
}

export async function claimWanted(db, t) {
  const res = await db
    .prepare(
      'UPDATE profile_wanted SET given = ? WHERE id IN (SELECT id FROM profile_wanted WHERE given < ? AND asked >= ? ORDER BY asked ASC, id ASC LIMIT ?) RETURNING id, asked',
    )
    .bind(t, t - WANTED_RETRY, t - WANTED_TTL, WANTED_PER_POLL)
    .all();
  const rows = (res && res.results) || [];
  rows.sort((a, b) => Number(a.asked) - Number(b.asked) || String(a.id).localeCompare(String(b.id)));
  return rows.map((r) => r.id);
}

export async function hasWanted(db, t) {
  const row = await db.prepare('SELECT 1 AS w FROM profile_wanted WHERE asked >= ? LIMIT 1').bind(t - 2 * MINUTE).first();
  return Boolean(row);
}

export async function putProfiles(request, env, t) {
  const body = await readJson(request, UPLOAD_LIMIT);
  const list = body.profiles === undefined ? [] : body.profiles;
  const gone = body.missing === undefined ? [] : body.missing;
  if (!Array.isArray(list)) throw new HttpError(400, 'bad_profiles', '"profiles" must be a list.');
  if (!Array.isArray(gone)) throw new HttpError(400, 'bad_missing', '"missing" must be a list.');
  if (list.length > MAX_UPLOAD || gone.length > MAX_UPLOAD) {
    throw new HttpError(413, 'too_many', `Send at most ${MAX_UPLOAD} profiles at once.`);
  }
  const db = env.DB;
  const stmts = [];
  const done = new Set();
  const ignored = [];
  let stored = 0;
  let missing = 0;
  for (const p of list) {
    if (!isPlainObject(p) || typeof p.id !== 'string' || !ID_RE.test(p.id) || done.has(p.id)) {
      ignored.push(isPlainObject(p) && typeof p.id === 'string' ? p.id.slice(0, 64) : null);
      continue;
    }
    done.add(p.id);
    stmts.push(
      db
        .prepare(
          'INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar_url = excluded.avatar_url, missing = 0, fetched = excluded.fetched',
        )
        .bind(p.id, cleanUsername(p.username), cleanText(p.display_name, DISPLAY_MAX), cleanAvatar(p.avatar_url), t),
    );
    stored += 1;
  }
  for (const id of gone) {
    if (typeof id !== 'string' || !ID_RE.test(id) || done.has(id)) {
      ignored.push(typeof id === 'string' ? id.slice(0, 64) : null);
      continue;
    }
    done.add(id);
    stmts.push(
      db
        .prepare(
          'INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 1, ?) ON CONFLICT (id) DO UPDATE SET username = NULL, display_name = NULL, avatar_url = NULL, missing = 1, fetched = excluded.fetched',
        )
        .bind(id, t),
    );
    missing += 1;
  }
  for (const id of done) stmts.push(db.prepare('DELETE FROM profile_wanted WHERE id = ?').bind(id));
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, stored, missing, ignored });
}

export function profileRoute(request, env, segs, url, t) {
  if (segs.length !== 3 || segs[2] !== 'profiles') return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  return getProfiles(request, env, url, t);
}
