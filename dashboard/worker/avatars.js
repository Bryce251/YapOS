import { ID_RE, MINUTE, HttpError, json, fail, readJson, isPlainObject, clientIp, parseJsonSafe } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanAvatar, requestRefresh } from './profiles.js';
import { base64Bytes, imageHash, sniffImage, toBytes, BADGE_IMG_CACHE } from './custom-badges.js';
import { AnimError, isGif, isWebp, webpAnimated, pngAnimated } from '../web/js/banner-anim.js';
import {
  AVATAR_PREFIX, AVATAR_SIDE, AVATAR_MIN_SIDE, AVATAR_STILL_MAX, AVATAR_ANIM_MAX, AVATAR_ANIM_MAX_FRAMES, AVATAR_ANIM_MIN_SIDE, AVATAR_ANIM_MAX_SIDE, AVATAR_ANIM_MAX_RATIO, AVATAR_REFRESH_MAX, AVATAR_FILE_MAX,
  isAvatarImagePath, readAvatarAnim, isYapinAvatar,
} from '../web/js/avatar-rules.js';
import { CUT_SOURCES, BACKDROP_MODES, imageHasAlpha, backdropColours, cleanBackdrop } from '../web/js/avatar-cutout.js';
import { LOOKS_MAX } from '../web/js/avatar-backdrop.js';
import { cleanLook, defaultLook } from '../web/js/profile-look.js';
import { AVATAR_ID_RE, STILL_EXT, AVATAR_EXT, avatarImageUrl, avatarStillUrl, customAvatarOut, customAvatars, removeAvatarStatements, idList, avatarsFor, staleIds, refreshStale, picOf, withAvatar, profileShown } from './avatar-store.js';
import { clearPartyProfileCache } from './party-profile.js';
import { applySettings } from './public-profiles.js';
import { clearLeaderboardCache } from './party-leaderboard.js';

export { AVATAR_PREFIX, AVATAR_STILL_MAX, AVATAR_ANIM_MAX, isAvatarImagePath, AVATAR_ID_RE, STILL_EXT, AVATAR_EXT, avatarImageUrl, avatarStillUrl, customAvatarOut, customAvatars, removeAvatarStatements, avatarsFor, staleIds, refreshStale, picOf, withAvatar };
export const AVATAR_BODY_LIMIT = Math.ceil(((AVATAR_ANIM_MAX + AVATAR_STILL_MAX) * 4) / 3) + 4096;
export const REFRESH_GAP = 10 * MINUTE;

const PATH_RE = /^\/avatar-img\/(a-[a-z0-9]{10})-([0-9a-f]{16})(-still)?\.(png|webp|jpg|gif)$/;
const UPLOAD_FIELDS = new Set(['image', 'still', 'cutout', 'source', 'backdrop']);
const PATCH_FIELDS = new Set(['cutout', 'backdrop']);
const NO_CUTOUT = 'Your picture still has its background, so there is nothing to change.';
const DATA_URL_RE = /^data:[a-z0-9.+/-]{0,40}(;[a-z0-9=.-]{0,40})*;base64,/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NOT_FOUND_TEXT = 'Picture not found';
const NO_PROFILE = 'Your public profile is not set up yet. Use the YapOS bot in a server first, then try again.';

const lower = (v) => String(v ?? '').toLowerCase();

function bad(code, message) {
  return new HttpError(400, code, message);
}

function tooBig(max) {
  return new HttpError(413, 'image_too_big', `The picture is too big. Keep it under ${Math.round(max / 1024)} KB.`);
}

const NAME_RE = /^[^\s/\\?#]{1,64}$/;

export async function refreshRoute(request, env, t) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const ip = clientIp(request);
  const limit = await hit(env.DB, await ipKey('avatarRefresh', ip), LIMITS.avatarRefresh, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const body = await readJson(request, 4096);
  const rawIds = body.ids === undefined ? [] : body.ids;
  const rawNames = body.names === undefined ? [] : body.names;
  if (!Array.isArray(rawIds) || !Array.isArray(rawNames) || !(rawIds.length + rawNames.length)) throw bad('bad_ids', 'Say whose pictures to check.');
  if (rawIds.length + rawNames.length > AVATAR_REFRESH_MAX) throw new HttpError(413, 'too_many', `Ask about at most ${AVATAR_REFRESH_MAX} people at once.`);
  const names = [...new Set(rawNames.filter((n) => typeof n === 'string' && NAME_RE.test(n.replace(/^@+/, ''))).map((n) => n.replace(/^@+/, '').toLowerCase()))];
  const ids = new Set(idList(rawIds).map(lower));
  if (names.length) {
    const res = await env.DB.prepare(`SELECT p.user_id, p.hidden, p.shards, p.updated, st.hidden AS st_hidden, st.show_shards, st.claimed, st.updated AS st_updated FROM public_profiles p LEFT JOIN profile_settings st ON st.user_id = p.user_id WHERE p.username_key IN (${names.map(() => '?').join(', ')})`).bind(...names).all();
    for (const r of (res && res.results) || []) {
      const settings = r.claimed === null || r.claimed === undefined ? null : { hidden: r.st_hidden, show_shards: r.show_shards, claimed: r.claimed, updated: r.st_updated };
      if (applySettings(r, settings).hidden) continue;
      if (typeof r.user_id === 'string' && ID_RE.test(r.user_id)) ids.add(lower(r.user_id));
    }
  }
  if (!ids.size) return json({ ok: true, queued: 0 }, 202, { 'Cache-Control': 'no-store' });
  const list = [...ids];
  const found = await avatarsFor(env.DB, list, { sessions: false });
  const due = list.filter((id) => {
    const cur = found.get(id);
    return !cur.custom && (!cur.known || cur.fetched < t - REFRESH_GAP);
  });
  const queued = due.length ? await requestRefresh(env, due, t, ip) : 0;
  return json({ ok: true, queued }, 202, { 'Cache-Control': 'no-store' });
}

function decodeRaw(raw, max, missing) {
  if (typeof raw !== 'string' || !raw) throw bad('bad_image', missing);
  const text = raw.replace(DATA_URL_RE, '').replace(/\s+/g, '');
  if (text.length > Math.ceil((max * 4) / 3) + 8) throw tooBig(max);
  if (!B64_RE.test(text) || text.length % 4 !== 0) throw bad('bad_image', "That picture couldn't be read. Pick it again.");
  let bin;
  try {
    bin = atob(text);
  } catch {
    throw bad('bad_image', "That picture couldn't be read. Pick it again.");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > max) throw tooBig(max);
  return bytes;
}

export function isMovingUpload(raw) {
  if (typeof raw !== 'string') return false;
  const text = raw.replace(DATA_URL_RE, '').replace(/\s+/g, '').slice(0, 64);
  try {
    const bin = atob(text.slice(0, text.length - (text.length % 4)));
    const head = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return isGif(head) || (isWebp(head) && head.length >= 30 && webpAnimated(head));
  } catch {
    return false;
  }
}

function squareOk(width, height) {
  return Math.abs(width - height) <= 1;
}

export function decodeAvatarImage(raw) {
  const img = base64Bytes(raw, AVATAR_STILL_MAX, { missing: 'Pick a picture first.' });
  if (pngAnimated(img.bytes) || webpAnimated(img.bytes)) throw bad('bad_image', 'Moving pictures are uploaded as GIFs or animated WebPs. Pick the file again.');
  if (!squareOk(img.width, img.height)) throw bad('bad_image_size', 'Profile pictures must be square. Pick the picture again and crop it.');
  if (img.width < AVATAR_MIN_SIDE || img.width > AVATAR_SIDE) throw bad('bad_image_size', `Profile pictures must be ${AVATAR_MIN_SIDE} to ${AVATAR_SIDE} pixels on each side.`);
  return img;
}

export function decodeAvatarMoving(raw) {
  const bytes = decodeRaw(raw, AVATAR_ANIM_MAX, 'Pick a GIF first.');
  try {
    return readAvatarAnim(bytes);
  } catch (err) {
    if (err instanceof AnimError) throw bad(err.code, err.message);
    throw err;
  }
}

export function decodeAvatarStill(raw) {
  const img = base64Bytes(raw, AVATAR_STILL_MAX, { missing: 'The still picture for your moving picture is missing. Pick the GIF again.' });
  if (pngAnimated(img.bytes) || webpAnimated(img.bytes)) throw bad('bad_still', 'The still picture must not move.');
  if (!squareOk(img.width, img.height) || img.width < AVATAR_ANIM_MIN_SIDE || img.width > AVATAR_SIDE) throw bad('bad_still', 'The still picture is the wrong size. Pick the GIF again.');
  return img;
}

function newAvatarId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `a-${Array.from(bytes, (x) => abc[x % 36]).join('')}`;
}

async function readOwnAvatar(db, userId) {
  const [row, still] = await Promise.all([
    db.prepare('SELECT user_id, id, mime, hash, width, height, bytes, frames FROM profile_avatars WHERE user_id = ?').bind(userId).first().catch(() => null),
    db.prepare('SELECT avatar_hash, mime, hash FROM profile_avatar_stills WHERE user_id = ?').bind(userId).first().catch(() => null),
  ]);
  return row ? customAvatarOut(row, still) : null;
}

export async function hasCustomAvatar(db, userId) {
  return Boolean(await db.prepare('SELECT 1 AS x FROM profile_avatars WHERE user_id = ?').bind(lower(userId)).first().catch(() => null));
}

export function clearAvatarCaches(db) {
  clearPartyProfileCache(db);
  clearLeaderboardCache(db);
}

function limitsOut() {
  return { fileBytes: AVATAR_FILE_MAX, stillBytes: AVATAR_STILL_MAX, animBytes: AVATAR_ANIM_MAX, side: AVATAR_SIDE, minSide: AVATAR_MIN_SIDE, animMinSide: AVATAR_ANIM_MIN_SIDE, animMaxSide: AVATAR_ANIM_MAX_SIDE, animMaxRatio: AVATAR_ANIM_MAX_RATIO, animFrames: AVATAR_ANIM_MAX_FRAMES };
}

async function stateOf(env, userId, session) {
  const [mine, found, pub, cut] = await Promise.all([
    readOwnAvatar(env.DB, userId),
    avatarsFor(env.DB, [userId]),
    env.DB.prepare('SELECT p.hidden, p.shards, p.updated, st.hidden AS st_hidden, st.show_shards, st.claimed, st.updated AS st_updated FROM public_profiles p LEFT JOIN profile_settings st ON st.user_id = p.user_id WHERE p.user_id = ?').bind(userId).first(),
    readCutout(env.DB, userId),
  ]);
  const cur = found.get(userId);
  const yapin = (cur && cur.yapin) || cleanAvatar(session && session.avatar_url);
  const settings = pub && pub.claimed !== null && pub.claimed !== undefined ? { hidden: pub.st_hidden, show_shards: pub.show_shards, claimed: pub.claimed, updated: pub.st_updated } : null;
  const shown = Boolean(pub) && !applySettings(pub, settings).hidden;
  const live = mine && shown;
  return {
    custom: mine ? { url: mine.avatar, still: mine.avatarStill, animated: mine.animated, width: mine.width, height: mine.height, frames: mine.frames, bytes: mine.bytes } : null,
    cutout: mine && cut ? { source: cut.source, backdrop: cleanBackdrop(cut.backdrop), canRestore: cut.source === 'yapin' || Number(cut.has_original) === 1 } : null,
    yapin,
    avatar: live ? mine.avatar : yapin,
    avatarStill: live ? mine.avatarStill : null,
    private: Boolean(pub) && !shown,
    canUpload: Boolean(pub),
    limits: limitsOut(),
  };
}

async function slowDown(env, userId, t) {
  const limit = await hit(env.DB, `avatar:u:${userId}`, LIMITS.profileAvatar, t);
  return limit.ok ? null : tooMany(limit.retryAfter, 'That is a lot of picture changes in one minute. Wait a moment and try again.');
}

async function uploadAvatar(request, env, session, userId, t) {
  const body = await readJson(request, AVATAR_BODY_LIMIT);
  if (!isPlainObject(body)) throw bad('bad_request', 'Send a picture.');
  for (const k of Object.keys(body)) if (!UPLOAD_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  const slow = await slowDown(env, userId, t);
  if (slow) return slow;
  const db = env.DB;
  const pub = await db.prepare('SELECT 1 AS x FROM public_profiles WHERE user_id = ?').bind(userId).first();
  if (!pub) throw new HttpError(403, 'no_profile', NO_PROFILE);
  const moving = isMovingUpload(body.image);
  if (!moving && body.still !== undefined) throw bad('bad_request', 'Only moving pictures send a still picture.');
  const cut = readCut(body, moving);
  const img = moving ? decodeAvatarMoving(body.image) : decodeAvatarImage(body.image);
  if (cut && !imageHasAlpha(img.bytes, img.mime)) throw bad('bad_cutout', 'A picture with its background removed must be a see-through PNG or WebP. Try removing the background again.');
  const original = cut && cut.source === 'upload' ? await originalFor(db, userId) : null;
  if (cut && cut.source === 'upload' && !original) throw bad('no_original', 'Upload a picture first, then remove its background.');
  const still = moving ? decodeAvatarStill(body.still) : null;
  const hash = await imageHash(img.bytes);
  const stillHash = still ? await imageHash(still.bytes) : null;
  const old = await db.prepare('SELECT id FROM profile_avatars WHERE user_id = ?').bind(userId).first();
  let id = old ? old.id : newAvatarId();
  for (let i = 0; !old && i < 4 && (await db.prepare('SELECT 1 AS x FROM profile_avatars WHERE id = ?').bind(id).first()); i++) id = newAvatarId();
  await db.batch([
    db.prepare('INSERT INTO profile_avatars (user_id, id, image, mime, hash, width, height, bytes, frames, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET image = excluded.image, mime = excluded.mime, hash = excluded.hash, width = excluded.width, height = excluded.height, bytes = excluded.bytes, frames = excluded.frames, updated = excluded.updated')
      .bind(userId, id, img.bytes, img.mime, hash, img.width, img.height, img.bytes.length, moving ? img.frames : 1, t),
    still
      ? db.prepare('INSERT INTO profile_avatar_stills (user_id, avatar_hash, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET avatar_hash = excluded.avatar_hash, image = excluded.image, mime = excluded.mime, hash = excluded.hash, width = excluded.width, height = excluded.height, bytes = excluded.bytes, updated = excluded.updated')
        .bind(userId, hash, still.bytes, still.mime, stillHash, still.width, still.height, still.bytes.length, t)
      : db.prepare('DELETE FROM profile_avatar_stills WHERE user_id = ?').bind(userId),
    cut
      ? db.prepare('INSERT INTO profile_avatar_cutouts (user_id, avatar_hash, source, backdrop, original, original_mime, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET avatar_hash = excluded.avatar_hash, source = excluded.source, backdrop = excluded.backdrop, original = excluded.original, original_mime = excluded.original_mime, updated = excluded.updated')
        .bind(userId, hash, cut.source, cut.backdrop, original ? original.bytes : null, original ? original.mime : null, t)
      : db.prepare('DELETE FROM profile_avatar_cutouts WHERE user_id = ?').bind(userId),
  ]);
  clearAvatarCaches(db);
  return json({ ok: true, ...(await stateOf(env, userId, session)) }, 201);
}

async function deleteAvatar(env, session, userId, t) {
  const slow = await slowDown(env, userId, t);
  if (slow) return slow;
  await env.DB.batch(removeAvatarStatements(env.DB, userId));
  clearAvatarCaches(env.DB);
  return json({ ok: true, ...(await stateOf(env, userId, session)) });
}

export function avatarRoute(request, env, session, t) {
  const userId = lower(session.user_id);
  const method = request.method;
  if (method === 'GET' || method === 'HEAD') return stateOf(env, userId, session).then((s) => json(s, 200, { 'Cache-Control': 'no-store' }));
  if (method === 'POST' || method === 'PUT') return uploadAvatar(request, env, session, userId, t);
  if (method === 'PATCH') return patchAvatar(request, env, session, userId, t);
  if (method === 'DELETE') return deleteAvatar(env, session, userId, t);
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}

export function readCut(body, moving) {
  const on = body.cutout;
  if (on === undefined || on === false) {
    if (body.source !== undefined || body.backdrop !== undefined) throw bad('bad_request', 'Only pictures with their background removed send a source or a backdrop.');
    return null;
  }
  if (on !== true) throw bad('bad_cutout', 'Say if the background was removed with true or false.');
  if (moving) throw bad('bad_cutout', 'Moving pictures keep their background. They get a ring in your colours instead.');
  if (!CUT_SOURCES.includes(body.source)) throw bad('bad_cutout', 'Say where the picture came from: your upload or your Yapin picture.');
  if (body.backdrop !== undefined && !BACKDROP_MODES.includes(body.backdrop)) throw bad('bad_backdrop', 'Pick a backdrop of theme or clear.');
  return { source: body.source, backdrop: cleanBackdrop(body.backdrop) };
}

function readCutout(db, userId) {
  return db
    .prepare('SELECT c.source, c.backdrop, c.original IS NOT NULL AS has_original FROM profile_avatar_cutouts c JOIN profile_avatars a ON a.user_id = c.user_id AND a.hash = c.avatar_hash WHERE c.user_id = ?')
    .bind(userId)
    .first()
    .catch(() => null);
}

function currentCutout(db, userId) {
  return db
    .prepare('SELECT a.hash, c.source, c.backdrop, c.original, c.original_mime FROM profile_avatars a JOIN profile_avatar_cutouts c ON c.user_id = a.user_id AND c.avatar_hash = a.hash WHERE a.user_id = ?')
    .bind(userId)
    .first()
    .catch(() => null);
}

function originalBytes(row) {
  if (!row || !row.original) return null;
  const bytes = toBytes(row.original);
  const kind = sniffImage(bytes);
  if (!kind || kind.mime !== row.original_mime || bytes.length > AVATAR_STILL_MAX) return null;
  return { bytes, ...kind };
}

async function originalFor(db, userId) {
  const [row, cut] = await Promise.all([
    db.prepare('SELECT image, mime, hash, frames FROM profile_avatars WHERE user_id = ?').bind(userId).first().catch(() => null),
    db.prepare('SELECT avatar_hash, source, original, original_mime FROM profile_avatar_cutouts WHERE user_id = ?').bind(userId).first().catch(() => null),
  ]);
  if (!row) return null;
  if (cut && cut.avatar_hash === row.hash) {
    const kept = cut.source === 'upload' ? originalBytes(cut) : null;
    return kept ? { bytes: kept.bytes, mime: kept.mime } : null;
  }
  if (Number(row.frames) > 1) return null;
  const bytes = toBytes(row.image);
  const kind = sniffImage(bytes);
  if (!kind || kind.mime !== row.mime || bytes.length > AVATAR_STILL_MAX) return null;
  return { bytes, mime: kind.mime };
}

async function patchAvatar(request, env, session, userId, t) {
  const body = await readJson(request, 1024);
  if (!isPlainObject(body) || !Object.keys(body).length) throw bad('bad_request', 'Say what to change.');
  for (const k of Object.keys(body)) if (!PATCH_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  if (body.cutout !== undefined && body.cutout !== false) throw bad('bad_cutout', 'To remove a background, upload the picture with its background removed.');
  if (body.cutout === false && body.backdrop !== undefined) throw bad('bad_request', 'Change one thing at a time.');
  if (body.backdrop !== undefined && !BACKDROP_MODES.includes(body.backdrop)) throw bad('bad_backdrop', 'Pick a backdrop of theme or clear.');
  const slow = await slowDown(env, userId, t);
  if (slow) return slow;
  const db = env.DB;
  const cur = await currentCutout(db, userId);
  if (!cur) throw new HttpError(404, 'no_cutout', NO_CUTOUT);
  if (body.cutout === false) {
    if (cur.source === 'upload') {
      const img = originalBytes(cur);
      if (!img) throw new HttpError(409, 'no_original', 'The picture with its background is missing. Upload it again.');
      const hash = await imageHash(img.bytes);
      await db.batch([
        db.prepare('UPDATE profile_avatars SET image = ?, mime = ?, hash = ?, width = ?, height = ?, bytes = ?, frames = 1, updated = ? WHERE user_id = ?').bind(img.bytes, img.mime, hash, img.width, img.height, img.bytes.length, t, userId),
        db.prepare('DELETE FROM profile_avatar_stills WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM profile_avatar_cutouts WHERE user_id = ?').bind(userId),
      ]);
    } else await db.batch(removeAvatarStatements(db, userId));
  } else {
    await db.prepare('UPDATE profile_avatar_cutouts SET backdrop = ?, updated = ? WHERE user_id = ?').bind(body.backdrop, t, userId).run();
  }
  clearAvatarCaches(db);
  return json({ ok: true, ...(await stateOf(env, userId, session)) });
}

function pictureResponse(bytes, mime) {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin' },
  });
}

async function originalPicture(env, userId) {
  const cur = await currentCutout(env.DB, userId);
  const img = cur && cur.source === 'upload' ? originalBytes(cur) : null;
  if (!img) throw new HttpError(404, 'no_original', 'There is no picture with its background to go back to.');
  return pictureResponse(img.bytes, img.mime);
}

const yapinFail = () => new HttpError(502, 'yapin_picture', "Your Yapin picture couldn't be fetched right now. Try again in a moment, or upload a picture instead.");

async function yapinPicture(env, session, userId, t, deps) {
  const limit = await hit(env.DB, `avatar:y:${userId}`, LIMITS.profileAvatar, t);
  if (!limit.ok) return tooMany(limit.retryAfter, 'That is a lot of picture changes in one minute. Wait a moment and try again.');
  const found = await avatarsFor(env.DB, [userId]).catch(() => new Map());
  const cur = found.get(userId);
  const url = (cur && cur.yapin) || cleanAvatar(session && session.avatar_url);
  if (!url || !isYapinAvatar(url)) throw new HttpError(404, 'no_yapin_picture', 'You have no Yapin picture to copy. Upload a picture instead.');
  const doFetch = deps && typeof deps.fetch === 'function' ? deps.fetch : (...a) => fetch(...a);
  const got = await fetchYapinPicture(url, doFetch);
  return pictureResponse(got.bytes, got.mime);
}

export const YAPIN_FETCH_MS = 8000;

async function readCapped(res, max) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > max) throw tooBig(max);
    return whole;
  }
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try {
        await reader.cancel();
      } catch {}
      throw tooBig(max);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function fetchYapinPicture(url, doFetch, { timeoutMs = YAPIN_FETCH_MS, max = AVATAR_FILE_MAX } = {}) {
  if (!isYapinAvatar(url)) throw new HttpError(404, 'no_yapin_picture', 'You have no Yapin picture to copy. Upload a picture instead.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await doFetch(url, { redirect: 'error', signal: ctrl.signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    } catch {
      throw yapinFail();
    }
    if (!res || !res.ok) throw yapinFail();
    const declared = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > max) throw tooBig(max);
    let bytes;
    try {
      bytes = await readCapped(res, max);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw yapinFail();
    }
    const kind = sniffImage(bytes) || (isGif(bytes) ? { mime: 'image/gif' } : null);
    if (!kind) throw yapinFail();
    return { bytes, mime: kind.mime };
  } finally {
    clearTimeout(timer);
  }
}

export function avatarPartRoute(request, env, session, part, t, deps) {
  const userId = lower(session.user_id);
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (part === 'original') return originalPicture(env, userId);
  if (part === 'yapin') return yapinPicture(env, session, userId, t, deps);
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export function lookOfRow(r) {
  const parsed = r && typeof r.look === 'string' ? parseJsonSafe(r.look, null) : null;
  return parsed && typeof parsed === 'object' ? cleanLook(parsed) : defaultLook();
}

export async function looksRoute(request, env, url, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('avatarLooks', clientIp(request)), LIMITS.publicProfile, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const raw = String(url.searchParams.get('ids') || '');
  if (raw.length > LOOKS_MAX * 14) throw new HttpError(413, 'too_many', `Ask about at most ${LOOKS_MAX} pictures at once.`);
  const ids = [...new Set(raw.split(',').filter((x) => AVATAR_ID_RE.test(x)))].slice(0, LOOKS_MAX);
  const looks = {};
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    const res = await env.DB
      .prepare(`SELECT a.id, a.hash, a.frames, c.avatar_hash AS c_hash, c.backdrop, pc.data AS look, p.user_id AS p_user, p.hidden AS p_hidden, p.shards AS p_shards, p.updated AS p_updated, st.user_id AS st_user, st.hidden AS st_hidden, st.show_shards AS st_show, st.claimed AS st_claimed, st.updated AS st_updated FROM profile_avatars a LEFT JOIN profile_avatar_cutouts c ON c.user_id = a.user_id LEFT JOIN profile_custom pc ON pc.user_id = a.user_id LEFT JOIN public_profiles p ON p.user_id = a.user_id LEFT JOIN profile_settings st ON st.user_id = a.user_id WHERE a.id IN (${marks})`)
      .bind(...ids)
      .all()
      .catch(() => null);
    for (const r of (res && res.results) || []) {
      if (!profileShown(r)) continue;
      const cut = Boolean(r.c_hash) && r.c_hash === r.hash;
      const moving = !cut && Number(r.frames) > 1;
      if (!cut && !moving) continue;
      const colours = backdropColours(lookOfRow(r));
      looks[r.id] = { cut, moving, clear: cut && r.backdrop === 'clear', stops: colours.stops, ring: colours.ring };
    }
  }
  return json({ looks }, 200, { 'Cache-Control': 'public, max-age=60' });
}

function missingImage() {
  return new Response(NOT_FOUND_TEXT, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}

export async function serveAvatarImage(request, env, url, isHidden) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const m = PATH_RE.exec(url.pathname);
  if (!m || !env.DB) return missingImage();
  const isStill = Boolean(m[3]);
  const row = isStill
    ? await env.DB.prepare('SELECT s.user_id, s.image, s.mime, s.hash, s.avatar_hash, a.hash AS current, a.frames FROM profile_avatar_stills s JOIN profile_avatars a ON a.user_id = s.user_id WHERE a.id = ?').bind(m[1]).first().catch(() => null)
    : await env.DB.prepare('SELECT user_id, image, mime, hash, frames FROM profile_avatars WHERE id = ?').bind(m[1]).first().catch(() => null);
  if (!row || row.hash !== m[2]) return missingImage();
  if (isStill ? row.avatar_hash !== row.current || Number(row.frames) < 2 || STILL_EXT[row.mime] !== m[4] : AVATAR_EXT[row.mime] !== m[4]) return missingImage();
  if (isHidden && (await isHidden(env.DB, row.user_id))) return missingImage();
  const bytes = toBytes(row.image);
  const kind = row.mime === 'image/gif' ? (isGif(bytes) ? { mime: 'image/gif' } : null) : sniffImage(bytes);
  const cap = !isStill && (row.mime === 'image/gif' || webpAnimated(bytes)) ? AVATAR_ANIM_MAX : AVATAR_STILL_MAX;
  if (!kind || kind.mime !== row.mime || bytes.length > cap) return missingImage();
  return new Response(request.method === 'HEAD' ? null : bytes, {
    status: 200,
    headers: {
      'Content-Type': kind.mime,
      'Content-Length': String(bytes.length),
      'Cache-Control': BADGE_IMG_CACHE,
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

