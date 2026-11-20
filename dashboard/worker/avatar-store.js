import { ID_RE, clientIp } from './util.js';
import { AVATAR_PREFIX } from '../web/js/avatar-rules.js';
import { cleanAvatar, requestRefresh, PROFILE_STALE } from './profiles.js';
import { applySettings } from './public-profiles.js';
import { clearChunksStatement } from './image-chunks.js';

export const AVATAR_ID_RE = /^a-[a-z0-9]{10}$/;
export const STILL_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' });
export const AVATAR_EXT = Object.freeze({ ...STILL_EXT, 'image/gif': 'gif' });

const CHUNK = 90;
const lower = (v) => String(v ?? '').toLowerCase();
const rowsOf = (res) => (res && res.results) || [];

export function avatarImageUrl(row) {
  if (!row || !AVATAR_ID_RE.test(String(row.id)) || !AVATAR_EXT[row.mime] || !/^[0-9a-f]{16}$/.test(String(row.hash))) return null;
  return `${AVATAR_PREFIX}${row.id}-${row.hash}.${AVATAR_EXT[row.mime]}`;
}

export function avatarStillUrl(row, still) {
  if (!row || !still || Number(row.frames) < 2 || still.avatar_hash !== row.hash || !STILL_EXT[still.mime] || !AVATAR_ID_RE.test(String(row.id))) return null;
  return `${AVATAR_PREFIX}${row.id}-${still.hash}-still.${STILL_EXT[still.mime]}`;
}

export function customAvatarOut(row, still) {
  const avatar = avatarImageUrl(row);
  if (!avatar) return null;
  const avatarStill = avatarStillUrl(row, still);
  return { avatar, avatarStill, animated: Boolean(avatarStill), width: Number(row.width) || 0, height: Number(row.height) || 0, frames: Math.max(1, Number(row.frames) || 1), bytes: Number(row.bytes) || 0 };
}

export function profileShown(r) {
  if (!r || r.p_user === null || r.p_user === undefined) return false;
  const settings = r.st_user !== null && r.st_user !== undefined ? { hidden: r.st_hidden, show_shards: r.st_show, claimed: r.st_claimed, updated: r.st_updated } : null;
  return !applySettings({ hidden: r.p_hidden, shards: r.p_shards, updated: r.p_updated }, settings).hidden;
}

export async function customAvatars(db, ids, { hidden = false } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).map(lower))];
  const out = new Map();
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT a.user_id, a.id, a.mime, a.hash, a.width, a.height, a.bytes, a.frames, s.avatar_hash, s.mime AS s_mime, s.hash AS s_hash, p.user_id AS p_user, p.hidden AS p_hidden, p.shards AS p_shards, p.updated AS p_updated, st.user_id AS st_user, st.hidden AS st_hidden, st.show_shards AS st_show, st.claimed AS st_claimed, st.updated AS st_updated FROM profile_avatars a LEFT JOIN profile_avatar_stills s ON s.user_id = a.user_id LEFT JOIN public_profiles p ON p.user_id = a.user_id LEFT JOIN profile_settings st ON st.user_id = a.user_id WHERE a.user_id IN (${marks})`)
      .bind(...part)
      .all()
      .catch(() => null);
    for (const r of rowsOf(res)) {
      if (!hidden && !profileShown(r)) continue;
      const still = r.s_hash ? { avatar_hash: r.avatar_hash, mime: r.s_mime, hash: r.s_hash } : null;
      const pic = customAvatarOut(r, still);
      if (pic) out.set(lower(r.user_id), pic);
    }
  }
  return out;
}
export const AVATAR_ORPHAN_GRACE = 24 * 60 * 60 * 1000;

export function removeAvatarStatements(db, userId) {
  const id = lower(userId);
  return [db.prepare('DELETE FROM profile_avatars WHERE user_id = ?').bind(id), db.prepare('DELETE FROM profile_avatar_stills WHERE user_id = ?').bind(id), db.prepare('DELETE FROM profile_avatar_cutouts WHERE user_id = ?').bind(id), clearChunksStatement(db, 'avatar', id)];
}

export function avatarCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM profile_avatars WHERE updated < ? AND NOT EXISTS (SELECT 1 FROM public_profiles p WHERE p.user_id = profile_avatars.user_id)').bind(t - AVATAR_ORPHAN_GRACE),
    db.prepare('DELETE FROM profile_avatar_stills WHERE NOT EXISTS (SELECT 1 FROM profile_avatars a WHERE a.user_id = profile_avatar_stills.user_id AND a.hash = profile_avatar_stills.avatar_hash)'),
    db.prepare('DELETE FROM profile_avatar_cutouts WHERE NOT EXISTS (SELECT 1 FROM profile_avatars a WHERE a.user_id = profile_avatar_cutouts.user_id AND a.hash = profile_avatar_cutouts.avatar_hash)'),
  ];
}

export function idList(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== 'string' || !ID_RE.test(raw)) continue;
    const id = lower(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(raw);
  }
  return out;
}

async function newestBy(db, table, idCol, extra, part) {
  const marks = part.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT ${idCol} AS uid, avatar_url, ${extra} AS at FROM ${table} WHERE ${idCol} IN (${marks})`).bind(...part).all().catch(() => null);
  return rowsOf(res);
}

export async function avatarsFor(db, ids, { sessions = true, hidden = false } = {}) {
  const raw = idList(ids);
  const out = new Map();
  if (!raw.length) return out;
  const keys = [...new Set(raw.map(lower))];
  for (const id of keys) out.set(id, { avatar: null, avatarStill: null, custom: false, yapin: null, fetched: 0, known: false });
  const variants = [...new Set([...keys, ...raw])];
  const custom = await customAvatars(db, keys, { hidden });
  for (let i = 0; i < variants.length; i += CHUNK) {
    const part = variants.slice(i, i + CHUNK);
    for (const r of await newestBy(db, 'profiles', 'id', 'fetched', part)) {
      const cur = out.get(lower(r.uid));
      if (!cur || Number(r.at) < cur.fetched) continue;
      cur.fetched = Number(r.at) || 0;
      cur.known = true;
      cur.yapin = cleanAvatar(r.avatar_url);
    }
  }
  if (sessions) {
    const need = keys.filter((id) => !out.get(id).yapin);
    const all = [...new Set([...need, ...raw.filter((r) => need.includes(lower(r)))])];
    const best = new Map();
    for (let i = 0; i < all.length; i += CHUNK) {
      const part = all.slice(i, i + CHUNK);
      const rows = [...(await newestBy(db, 'sessions', 'user_id', 'created', part)), ...(await newestBy(db, 'activity_sessions', 'user_id', 'created', part))];
      for (const r of rows) {
        const url = cleanAvatar(r.avatar_url);
        if (!url) continue;
        const id = lower(r.uid);
        const prev = best.get(id);
        if (!prev || Number(r.at) > prev.at) best.set(id, { url, at: Number(r.at) || 0 });
      }
    }
    for (const [id, b] of best) out.get(id).yapin = b.url;
  }
  for (const [id, cur] of out) {
    const mine = custom.get(id);
    if (mine) {
      cur.avatar = mine.avatar;
      cur.avatarStill = mine.avatarStill;
      cur.custom = true;
    } else cur.avatar = cur.yapin;
  }
  return out;
}

export function staleIds(found, ids, t) {
  return idList(ids).filter((id) => {
    const cur = found.get(lower(id));
    return !cur || !cur.known || cur.fetched < t - PROFILE_STALE;
  });
}

export async function refreshStale(env, found, ids, t, ip) {
  const stale = staleIds(found, ids, t);
  if (!stale.length || !ip) return 0;
  return requestRefresh(env, stale.map(lower), t, ip).catch(() => 0);
}

export function picOf(found, id) {
  const cur = found && found.get(lower(id));
  return cur ? { avatar: cur.avatar, avatarStill: cur.avatarStill } : { avatar: null, avatarStill: null };
}

export async function picsWithRefresh(env, ids, t, request) {
  const found = await avatarsFor(env.DB, ids);
  if (request) await refreshStale(env, found, ids, t, clientIp(request));
  return found;
}

export async function withAvatar(db, user) {
  if (!user || typeof user.id !== 'string') return user;
  const found = await avatarsFor(db, [user.id], { sessions: false }).catch(() => null);
  const cur = found && found.get(lower(user.id));
  const own = cleanAvatar(user.avatar_url);
  if (!cur || !cur.custom) return { ...user, avatar_url: (cur && cur.yapin) || own };
  return { ...user, avatar_url: cur.avatar, ...(cur.avatarStill ? { avatar_still: cur.avatarStill } : {}), avatar_custom: true };
}
