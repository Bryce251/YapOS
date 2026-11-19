import { HttpError, json, fail, readJson, isPlainObject, parseJsonSafe } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { badgesFor, partySeasonBadges } from './party-badges.js';
import { liveBadges, base64Bytes, imageHash, sniffImage, toBytes, IMAGE_EXT, BADGE_IMG_CACHE } from './custom-badges.js';
import { readCatalog } from './owner.js';
import { blockedIn } from './party-blocked.js';
import { logModAction, personName } from './party-mod.js';
import { clearPartyProfileCache } from './party-profile.js';
import { clearLeaderboardCache } from './party-leaderboard.js';
import { isBannerImagePath } from './security.js';
import { customAvatars, removeAvatarStatements } from './avatar-store.js';
import { cleanLook, defaultLook, isDefaultLook, lookTexts, readCrop, readGradientCustom, gradientStops, themeColours, themePalette, LookError, LOOK_VERSION, LOOK_BODY_MAX, ACH_PREFIX, PIN_MAX, BIO_MAX, PRONOUNS_MAX, STATUS_MAX, THEME_IDS, EFFECT_IDS } from '../web/js/profile-look.js';
import { AnimError, readAnimated, checkAnimSize, isGif, isWebp, webpAnimated, pngAnimated, ANIM_MAX_BYTES, ANIM_MAX_FRAMES, ANIM_MIN_W, ANIM_MAX_W, ANIM_MIN_H, ANIM_MAX_H } from '../web/js/banner-anim.js';

export const BANNER_MAX = 800 * 1024;
export const STILL_MAX = 300 * 1024;
export const STILL_MAX_W = 1500;
export const STILL_MIN_W = 100;
export const BANNER_BODY_LIMIT = 1800 * 1024;
export const BANNER_EXT = Object.freeze({ ...IMAGE_EXT, 'image/gif': 'gif' });
export const DEFAULT_CROP = Object.freeze({ zoom: 1, x: 0.5, y: 0.5 });
export { ANIM_MAX_BYTES, ANIM_MAX_FRAMES };
export const BANNER_MIN_W = 600;
export const BANNER_MAX_W = 3000;
export const BANNER_MIN_H = 200;
export const BANNER_MAX_H = 1000;
export const BANNER_MIN_RATIO = 2;
export const BANNER_MAX_RATIO = 4;
export const BANNER_PREFIX = '/banner-img/';
export const BANNER_ID_RE = /^b-[a-z0-9]{10}$/;

const MAX_BADGES = 64;
const MAX_ACHIEVEMENTS = 100;
const BADGE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const BANNER_PATH_RE = /^\/banner-img\/(b-[a-z0-9]{10})-([0-9a-f]{16})(-still)?\.(png|webp|jpg|gif)$/;
const BANNER_COLUMNS = 'user_id, id, mime, hash, width, height, bytes, updated';
const STILL_COLUMNS = 'user_id, banner_hash, mime, hash, width, height, bytes, updated';
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_RE = /^data:[a-z0-9.+/-]{0,40}(;[a-z0-9=.-]{0,40})*;base64,/i;
const UPLOAD_FIELDS = new Set(['image', 'still', 'crop']);
const NOT_FOUND_TEXT = 'Picture not found';

export { isBannerImagePath };

const lower = (v) => String(v ?? '').toLowerCase();

function idList(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !BADGE_RE.test(v)) continue;
    const id = v.toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

export function bannerUrl(row) {
  if (!row || !BANNER_ID_RE.test(String(row.id)) || !BANNER_EXT[row.mime]) return null;
  return `${BANNER_PREFIX}${row.id}-${row.hash}.${BANNER_EXT[row.mime]}`;
}

export function isMoving(banner, still) {
  return Boolean(banner && still && still.banner_hash === banner.hash && (banner.mime === 'image/gif' || banner.mime === 'image/webp') && IMAGE_EXT[still.mime]);
}

export function stillUrl(banner, still) {
  if (!isMoving(banner, still) || !BANNER_ID_RE.test(String(banner.id))) return null;
  return `${BANNER_PREFIX}${banner.id}-${still.hash}-still.${IMAGE_EXT[still.mime]}`;
}

export function bannerMotion(banner, still) {
  const url = stillUrl(banner, still);
  return url ? { still: url, width: Number(banner.width), height: Number(banner.height) } : null;
}

export function ownedSet(badges, achievements) {
  const out = new Set();
  for (const b of badges || []) if (typeof b === 'string') out.add(b);
  for (const a of achievements || []) if (typeof a === 'string') out.add(`${ACH_PREFIX}${a}`);
  return out;
}

export async function ownedFor(db, userId) {
  const id = lower(userId);
  const [pub, stats, streak, catalog, partySeason] = await Promise.all([
    db.prepare('SELECT badges, achievements FROM public_profiles WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT games, wins, counters FROM party_stats WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT best FROM party_daily_streaks WHERE user_id = ?').bind(id).first(),
    readCatalog(db).catch(() => ({ achievements: [], badges: [] })),
    partySeasonBadges(db, id).catch(() => []),
  ]);
  const counters = parseJsonSafe(stats && stats.counters, {});
  const earned = badgesFor({ games: Number(stats && stats.games) || 0, wins: Number(stats && stats.wins) || 0, counters: isPlainObject(counters) ? counters : {}, dailyBest: Number(streak && streak.best) || 0 });
  const badges = liveBadges([...new Set([...earned, ...partySeason, ...idList(parseJsonSafe(pub && pub.badges, []), MAX_BADGES)])], catalog.badges);
  return ownedSet(badges, idList(parseJsonSafe(pub && pub.achievements, []), MAX_ACHIEVEMENTS));
}

export async function readCustom(db, userId) {
  const id = lower(userId);
  const [row, banner, still] = await Promise.all([
    db.prepare('SELECT v, data, updated FROM profile_custom WHERE user_id = ?').bind(id).first().catch(() => null),
    db.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(id).first().catch(() => null),
    readStill(db, id),
  ]);
  const look = row ? cleanLook(parseJsonSafe(row.data, {})) : defaultLook();
  return { look, banner: banner || null, still: still || null, updated: row ? Number(row.updated) || 0 : 0 };
}

function readStill(db, id) {
  return db.prepare(`SELECT ${STILL_COLUMNS} FROM profile_banner_stills WHERE user_id = ?`).bind(id).first().catch(() => null);
}

export async function safeTexts(db, look, t) {
  const texts = lookTexts(look);
  if (!texts.length) return look;
  const hits = await blockedIn(db, texts.map(([, , v]) => v), t);
  const out = { ...look };
  texts.forEach(([key], i) => {
    if (hits[i]) out[key] = '';
  });
  return out;
}

export function publicLook(look, banner, owned, still = null) {
  const l = look || defaultLook();
  const pins = owned ? l.pins.filter((p) => owned.has(p)) : [...l.pins];
  const bannerImage = l.banner === 'image' ? bannerUrl(banner) : null;
  const motion = bannerImage ? bannerMotion(banner, still) : null;
  return {
    v: LOOK_VERSION,
    pins,
    order: [...l.order],
    hidden: [...l.hidden],
    nameColour: l.nameColour,
    nameGradient: l.nameGradient,
    nameGradientCustom: readGradientCustom(l.nameGradientCustom),
    nameFont: l.nameFont,
    accent: l.accent,
    banner: l.banner === 'image' && !bannerImage ? 'none' : l.banner,
    bannerImage,
    bio: l.bio,
    pronouns: l.pronouns,
    status: l.status,
    statusEmoji: l.statusEmoji,
    ring: l.ring,
    density: l.density,
    featured: l.featured,
    theme: l.theme,
    themeCustom: l.themeCustom ? { ...l.themeCustom } : null,
    themeMode: l.themeMode,
    themePattern: l.themePattern,
    effect: l.effect,
    bannerCrop: motion ? { ...(l.bannerCrop || DEFAULT_CROP) } : null,
    bannerMotion: motion,
    colours: {
      name: l.nameColour ? themeColours(l.nameColour) : null,
      accent: l.accent ? themeColours(l.accent) : null,
    },
  };
}

export async function lookForProfile(db, userId, owned, t) {
  const { look, banner, still } = await readCustom(db, userId);
  return publicLook(await safeTexts(db, look, t), banner, owned, still);
}

function limits() {
  return {
    pins: PIN_MAX, bio: BIO_MAX, pronouns: PRONOUNS_MAX, status: STATUS_MAX, bannerBytes: BANNER_MAX, bannerMinWidth: BANNER_MIN_W, bannerMaxWidth: BANNER_MAX_W, bannerMinHeight: BANNER_MIN_H, bannerMaxHeight: BANNER_MAX_H,
    animBytes: ANIM_MAX_BYTES, animFrames: ANIM_MAX_FRAMES, animMinWidth: ANIM_MIN_W, animMaxWidth: ANIM_MAX_W, animMinHeight: ANIM_MIN_H, animMaxHeight: ANIM_MAX_H, stillBytes: STILL_MAX,
  };
}

async function readOwn(env, userId, t) {
  const owned = await ownedFor(env.DB, userId);
  const { look, banner, still } = await readCustom(env.DB, userId);
  return json({ look: publicLook(await safeTexts(env.DB, look, t), banner, owned, still), owned: [...owned], limits: limits() });
}

async function lookLimit(env, userId, key, max, t) {
  const limit = await hit(env.DB, `${key}:u:${userId}`, max, t);
  return limit.ok ? null : tooMany(limit.retryAfter, 'That is a lot of profile changes in one minute. Wait a moment and try again.');
}

function saveStatement(db, userId, look, t) {
  return db
    .prepare('INSERT INTO profile_custom (user_id, v, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET v = excluded.v, data = excluded.data, updated = excluded.updated')
    .bind(userId, LOOK_VERSION, JSON.stringify(look), t);
}

async function saveLook(request, env, userId, t) {
  const body = await readJson(request, LOOK_BODY_MAX);
  const slow = await lookLimit(env, userId, 'look', LIMITS.profileLook, t);
  if (slow) return slow;
  const owned = await ownedFor(env.DB, userId);
  let look;
  try {
    look = cleanLook(body, { owned, strict: true });
  } catch (err) {
    if (err instanceof LookError) throw new HttpError(400, err.code, err.message);
    throw err;
  }
  const texts = lookTexts(look);
  if (texts.length) {
    const hits = await blockedIn(env.DB, texts.map(([, , v]) => v), t);
    const bad = texts.filter((_, i) => hits[i]).map(([, what]) => what);
    if (bad.length) {
      const which = bad.length === 1 ? `your ${bad[0]}` : `your ${bad.slice(0, -1).join(', ')} and ${bad[bad.length - 1]}`;
      return fail(400, 'blocked_words', `Some words in ${which} aren't allowed on YapOS. Change them and try again.`, { fields: texts.filter((_, i) => hits[i]).map(([k]) => k) });
    }
  }
  const [banner, still] = await Promise.all([
    env.DB.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(userId).first(),
    readStill(env.DB, userId),
  ]);
  if (look.banner === 'image' && !banner) throw new HttpError(400, 'no_banner', 'Upload a banner picture first, or pick another banner.');
  if (!isMoving(banner, still)) look.bannerCrop = null;
  if (isDefaultLook(look)) await env.DB.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(userId).run();
  else await saveStatement(env.DB, userId, look, t).run();
  clearPartyProfileCache(env.DB);
  return json({ ok: true, look: publicLook(look, banner, owned, still) });
}

function bad(code, message) {
  return new HttpError(400, code, message);
}

export function rawBytes(raw, max, missing = 'Pick a picture for your banner.') {
  if (typeof raw !== 'string' || !raw) throw bad('bad_image', missing);
  const tooBig = () => new HttpError(413, 'image_too_big', `The picture is too big. Keep it under ${Math.round(max / 1024)} KB.`);
  const text = raw.replace(DATA_URL_RE, '').replace(/\s+/g, '');
  if (text.length > Math.ceil((max * 4) / 3) + 8) throw tooBig();
  if (!B64_RE.test(text) || text.length % 4 !== 0) throw bad('bad_image', "That picture couldn't be read. Pick it again.");
  let bin;
  try {
    bin = atob(text);
  } catch {
    throw bad('bad_image', "That picture couldn't be read. Pick it again.");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > max) throw tooBig();
  return bytes;
}

function animFail(err) {
  if (err instanceof AnimError) return bad(err.code, err.message);
  return err;
}

export function isAnimatedUpload(raw) {
  if (typeof raw !== 'string') return false;
  const text = raw.replace(DATA_URL_RE, '').replace(/\s+/g, '').slice(0, 64);
  let head;
  try {
    const bin = atob(text.slice(0, text.length - (text.length % 4)));
    head = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return isGif(head) || (isWebp(head) && head.length >= 30 && webpAnimated(head));
}

export function decodeAnimated(raw) {
  const bytes = rawBytes(raw, ANIM_MAX_BYTES, 'Pick a GIF for your banner.');
  let img;
  try {
    img = readAnimated(bytes);
    checkAnimSize(img);
  } catch (err) {
    throw animFail(err);
  }
  if (img.frames < 2) throw bad('not_animated', "That GIF doesn't move. Upload it as a normal banner instead.");
  return img;
}

export function decodeStill(raw, anim) {
  const img = base64Bytes(raw, STILL_MAX, { missing: 'The still picture for your moving banner is missing. Pick the GIF again.' });
  if (webpAnimated(img.bytes) || pngAnimated(img.bytes)) throw bad('bad_still', 'The still picture for your banner must not move.');
  const { width, height } = img;
  if (width < STILL_MIN_W || width > STILL_MAX_W || height < 1 || height > anim.height) throw bad('bad_still', 'The still picture for your banner is the wrong size. Pick the GIF again.');
  const want = anim.width / anim.height;
  if (Math.abs(width / height - want) / want > 0.03) throw bad('bad_still', 'The still picture for your banner is the wrong shape. Pick the GIF again.');
  return img;
}

export function decodeBanner(raw) {
  const img = base64Bytes(raw, BANNER_MAX, { missing: 'Pick a picture for your banner.' });
  if (pngAnimated(img.bytes)) throw bad('bad_image', "Moving PNGs can't be banners. Use a GIF or an animated WebP instead.");
  if (webpAnimated(img.bytes)) throw bad('bad_image', 'Moving pictures are uploaded as animated banners. Pick the file again.');
  const { width, height } = img;
  if (width < BANNER_MIN_W || width > BANNER_MAX_W || height < BANNER_MIN_H || height > BANNER_MAX_H) {
    throw new HttpError(400, 'bad_image_size', `Banners must be ${BANNER_MIN_W} to ${BANNER_MAX_W} pixels wide and ${BANNER_MIN_H} to ${BANNER_MAX_H} pixels tall.`);
  }
  if (width < height * BANNER_MIN_RATIO || width > height * BANNER_MAX_RATIO) throw new HttpError(400, 'bad_image_size', 'Banners must be 2 to 4 times as wide as they are tall. The best size is 1500 by 500.');
  return img;
}

function newBannerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `b-${Array.from(bytes, (x) => abc[x % 36]).join('')}`;
}

async function uploadBanner(request, env, userId, t) {
  const body = await readJson(request, BANNER_BODY_LIMIT);
  for (const k of Object.keys(body)) if (!UPLOAD_FIELDS.has(k)) throw new HttpError(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  const slow = await lookLimit(env, userId, 'banner', LIMITS.profileBanner, t);
  if (slow) return slow;
  const db = env.DB;
  const pub = await db.prepare('SELECT 1 AS x FROM public_profiles WHERE user_id = ?').bind(userId).first();
  if (!pub) throw new HttpError(403, 'no_profile', 'Your public profile is not set up yet. Use the YapOS bot in a server first, then try again.');
  const moving = isAnimatedUpload(body.image);
  if (!moving && (body.still !== undefined || body.crop !== undefined)) throw new HttpError(400, 'bad_request', 'Only moving banners send a still picture and a position.');
  const img = moving ? decodeAnimated(body.image) : decodeBanner(body.image);
  let still = null;
  let crop = null;
  if (moving) {
    still = decodeStill(body.still, img);
    try {
      crop = readCrop(body.crop === undefined ? { ...DEFAULT_CROP } : body.crop, true) || { ...DEFAULT_CROP };
    } catch (err) {
      if (err instanceof LookError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  }
  const hash = await imageHash(img.bytes);
  const stillHash = still ? await imageHash(still.bytes) : null;
  const old = await db.prepare('SELECT id FROM profile_banners WHERE user_id = ?').bind(userId).first();
  let id = old ? old.id : newBannerId();
  for (let i = 0; !old && i < 4 && (await db.prepare('SELECT 1 AS x FROM profile_banners WHERE id = ?').bind(id).first()); i++) id = newBannerId();
  const { look } = await readCustom(db, userId);
  const next = { ...look, banner: 'image', bannerCrop: crop };
  await db.batch([
    db.prepare('INSERT INTO profile_banners (user_id, id, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET image = excluded.image, mime = excluded.mime, hash = excluded.hash, width = excluded.width, height = excluded.height, bytes = excluded.bytes, updated = excluded.updated')
      .bind(userId, id, img.bytes, img.mime, hash, img.width, img.height, img.bytes.length, t),
    still
      ? db.prepare('INSERT INTO profile_banner_stills (user_id, banner_hash, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET banner_hash = excluded.banner_hash, image = excluded.image, mime = excluded.mime, hash = excluded.hash, width = excluded.width, height = excluded.height, bytes = excluded.bytes, updated = excluded.updated')
        .bind(userId, hash, still.bytes, still.mime, stillHash, still.width, still.height, still.bytes.length, t)
      : db.prepare('DELETE FROM profile_banner_stills WHERE user_id = ?').bind(userId),
    saveStatement(db, userId, next, t),
  ]);
  clearPartyProfileCache(db);
  const [row, stillRow] = await Promise.all([
    db.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(userId).first(),
    readStill(db, userId),
  ]);
  const motion = bannerMotion(row, stillRow);
  return json({ ok: true, banner: { url: bannerUrl(row), width: Number(row.width), height: Number(row.height), bytes: Number(row.bytes), animated: Boolean(motion), frames: moving ? img.frames : 1, motion, crop: motion ? crop : null } }, 201);
}

export function removeBannerStatements(db, userId, look, t) {
  const stmts = [db.prepare('DELETE FROM profile_banners WHERE user_id = ?').bind(userId), db.prepare('DELETE FROM profile_banner_stills WHERE user_id = ?').bind(userId)];
  if (look && (look.banner === 'image' || look.bannerCrop)) {
    const next = { ...look, banner: look.banner === 'image' ? 'none' : look.banner, bannerCrop: null };
    stmts.push(isDefaultLook(next) ? db.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(userId) : saveStatement(db, userId, next, t));
  }
  return stmts;
}

async function deleteBanner(env, userId, t) {
  const slow = await lookLimit(env, userId, 'banner', LIMITS.profileBanner, t);
  if (slow) return slow;
  const { look } = await readCustom(env.DB, userId);
  await env.DB.batch(removeBannerStatements(env.DB, userId, look, t));
  clearPartyProfileCache(env.DB);
  return json({ ok: true, banner: null });
}

export function lookRoute(request, env, session, t) {
  const userId = lower(session.user_id);
  const method = request.method;
  if (method === 'GET' || method === 'HEAD') return readOwn(env, userId, t);
  if (method === 'PUT' || method === 'POST') return saveLook(request, env, userId, t);
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}

export function bannerRoute(request, env, session, t) {
  const userId = lower(session.user_id);
  if (request.method === 'POST' || request.method === 'PUT') return uploadBanner(request, env, userId, t);
  if (request.method === 'DELETE') return deleteBanner(env, userId, t);
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}

export const RESET_PARTS = Object.freeze(['banner', 'avatar', 'bio', 'status', 'pronouns', 'text', 'name-style', 'pins', 'theme', 'effect', 'all']);
export const RESET_ACTIONS = Object.freeze(['profile_banner_remove', 'profile_avatar_remove', 'profile_text_clear', 'profile_name_style_reset', 'profile_pins_clear', 'profile_theme_reset', 'profile_effect_clear', 'profile_reset']);
const NO_THEME = Object.freeze({ theme: 'none', themeCustom: null, themeMode: 'auto', themePattern: 'glow' });
const TEXT_PARTS = Object.freeze({ bio: ['bio'], status: ['status', 'statusEmoji'], pronouns: ['pronouns'] });
const FIELD_NAMES = Object.freeze({ bio: 'about me', status: 'status', pronouns: 'pronouns' });

export async function staffLookView(db, userId) {
  const [{ look, banner, still }, pics] = await Promise.all([readCustom(db, userId), customAvatars(db, [userId], { hidden: true }).catch(() => new Map())]);
  const pic = pics.get(lower(userId)) || null;
  return {
    avatar: pic ? pic.avatar : null,
    avatarStill: pic ? pic.avatarStill : null,
    avatarAnimated: Boolean(pic && pic.animated),
    banner: bannerUrl(banner),
    bannerStill: stillUrl(banner, still),
    bannerAnimated: isMoving(banner, still),
    bannerChoice: look.banner,
    theme: look.theme,
    themeCustom: look.themeCustom ? { ...look.themeCustom } : null,
    effect: look.effect,
    bio: look.bio,
    pronouns: look.pronouns,
    status: look.status,
    statusEmoji: look.statusEmoji,
    nameColour: look.nameColour,
    nameGradient: look.nameGradient,
    nameGradientCustom: readGradientCustom(look.nameGradientCustom),
    nameFont: look.nameFont,
    pins: [...look.pins],
    custom: !isDefaultLook(look),
  };
}

function hasNameStyle(look) {
  return Boolean(look.nameColour || look.nameGradient || look.nameGradientCustom || (look.nameFont && look.nameFont !== 'default'));
}

function textFields(look, part) {
  const keys = part === 'text' ? ['bio', 'status', 'pronouns'] : [part];
  return keys.filter((k) => TEXT_PARTS[k].some((f) => look[f]));
}

function possessive(name) {
  return name ? `${name}'s` : 'their';
}

export function resetPlan(db, id, part, current, name, t) {
  const { look, banner, avatar = false } = current;
  const who = possessive(name);
  const store = (next) => (isDefaultLook(next) ? db.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(id) : saveStatement(db, id, next, t));
  if (part === 'banner') {
    if (!banner) return null;
    return { action: 'profile_banner_remove', stmts: removeBannerStatements(db, id, look, t), detail: { part, summary: `Removed ${who} profile banner picture` } };
  }
  if (part === 'avatar') {
    if (!avatar) return null;
    return { action: 'profile_avatar_remove', stmts: removeAvatarStatements(db, id), detail: { part, summary: `Removed ${who} uploaded profile picture` } };
  }
  if (part === 'bio' || part === 'status' || part === 'pronouns' || part === 'text') {
    const fields = textFields(look, part);
    if (!fields.length) return null;
    const next = { ...look };
    for (const k of fields) for (const f of TEXT_PARTS[k]) next[f] = '';
    const names = fields.map((k) => FIELD_NAMES[k]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return { action: 'profile_text_clear', stmts: [store(next)], detail: { part, fields, bio: fields.includes('bio') ? look.bio || null : undefined, status: fields.includes('status') ? look.status || null : undefined, pronouns: fields.includes('pronouns') ? look.pronouns || null : undefined, summary: `Cleared ${who} ${list}` } };
  }
  if (part === 'name-style') {
    if (!hasNameStyle(look)) return null;
    return { action: 'profile_name_style_reset', stmts: [store({ ...look, nameColour: null, nameGradient: null, nameGradientCustom: null, nameFont: 'default' })], detail: { part, summary: `Reset ${who} name colour and style` } };
  }
  if (part === 'pins') {
    if (!look.pins.length) return null;
    return { action: 'profile_pins_clear', stmts: [store({ ...look, pins: [] })], detail: { part, count: look.pins.length, summary: `Cleared ${who} pinned badges` } };
  }
  if (part === 'theme') {
    if (look.theme === 'none') return null;
    return { action: 'profile_theme_reset', stmts: [store({ ...look, ...NO_THEME })], detail: { part, theme: THEME_IDS.includes(look.theme) ? look.theme : undefined, summary: `Reset ${who} profile theme` } };
  }
  if (part === 'effect') {
    if (look.effect === 'none') return null;
    return { action: 'profile_effect_clear', stmts: [store({ ...look, effect: 'none' })], detail: { part, effect: EFFECT_IDS.includes(look.effect) ? look.effect : undefined, summary: `Turned off ${who} profile effect` } };
  }
  if (part === 'all') {
    if (!banner && !avatar && isDefaultLook(look)) return null;
    return {
      action: 'profile_reset',
      stmts: [db.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(id), db.prepare('DELETE FROM profile_banners WHERE user_id = ?').bind(id), db.prepare('DELETE FROM profile_banner_stills WHERE user_id = ?').bind(id), ...(avatar ? removeAvatarStatements(db, id) : [])],
      detail: { part, banner: Boolean(banner) || undefined, avatar: avatar || undefined, bio: look.bio || undefined, status: look.status || undefined, theme: look.theme !== 'none' ? look.theme : undefined, effect: look.effect !== 'none' ? look.effect : undefined, summary: `Reset ${who} whole profile look` },
    };
  }
  return null;
}

export const NOTHING_TO_RESET = Object.freeze({
  banner: "They don't have a banner picture.",
  avatar: "They haven't uploaded a profile picture.",
  bio: 'There is no about me to clear.',
  status: 'There is no status to clear.',
  pronouns: 'There are no pronouns to clear.',
  text: 'There is no profile text to clear.',
  'name-style': 'Their name already uses the default colour and style.',
  pins: 'They have no pinned badges.',
  theme: 'Their profile already uses the default theme.',
  effect: 'They have no profile effect.',
  all:'Their profile already uses the default look.',
});

export async function resetLook(db, { id, part, actor, t }) {
  const [custom, pics] = await Promise.all([readCustom(db, id), customAvatars(db, [id], { hidden: true }).catch(() => new Map())]);
  const current = { ...custom, avatar: pics.has(lower(id)) };
  const name = await personName(db, id);
  const plan = resetPlan(db, id, part, current, name, t);
  if (!plan) return { done: false, message: NOTHING_TO_RESET[part] || 'There is nothing to reset.' };
  await db.batch([...plan.stmts, logModAction(db, { actorId: actor.id, actorName: actor.name, action: plan.action, targetId: id, targetName: name, detail: plan.detail, t })]);
  clearPartyProfileCache(db);
  if (current.avatar && (part === 'avatar' || part === 'all')) clearLeaderboardCache(db);
  return { done: true, action: plan.action };
}

function missingImage() {
  return new Response(NOT_FOUND_TEXT, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}

export async function serveBannerImage(request, env, url, isHidden) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const m = BANNER_PATH_RE.exec(url.pathname);
  if (!m || !env.DB) return missingImage();
  const isStill = Boolean(m[3]);
  const row = isStill
    ? await env.DB.prepare('SELECT s.user_id, s.image, s.mime, s.hash, s.banner_hash, b.hash AS banner FROM profile_banner_stills s JOIN profile_banners b ON b.user_id = s.user_id WHERE b.id = ?').bind(m[1]).first().catch(() => null)
    : await env.DB.prepare('SELECT user_id, image, mime, hash FROM profile_banners WHERE id = ?').bind(m[1]).first().catch(() => null);
  if (!row || row.hash !== m[2]) return missingImage();
  if (isStill ? row.banner_hash !== row.banner || IMAGE_EXT[row.mime] !== m[4] : BANNER_EXT[row.mime] !== m[4]) return missingImage();
  if (isHidden && (await isHidden(env.DB, row.user_id))) return missingImage();
  const bytes = toBytes(row.image);
  const kind = row.mime === 'image/gif' ? (isGif(bytes) ? { mime: 'image/gif' } : null) : sniffImage(bytes);
  const cap = isStill ? STILL_MAX : row.mime === 'image/gif' || webpAnimated(bytes) ? ANIM_MAX_BYTES : BANNER_MAX;
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

export function cardLook(look, owned, banner = null, still = null) {
  const l = look || defaultLook();
  const grad = readGradientCustom(l.nameGradientCustom);
  const name = l.nameColour && !grad ? themeColours(l.nameColour) : null;
  const accent = l.accent ? themeColours(l.accent) : null;
  const bannerImage = l.banner === 'image' ? bannerUrl(banner) : null;
  const motion = bannerImage ? bannerMotion(banner, still) : null;
  const palette = themePalette(l);
  return {
    theme: palette ? l.theme : 'none',
    palette,
    effect: l.effect,
    bannerMotion: motion,
    bannerCrop: motion ? { ...(l.bannerCrop || DEFAULT_CROP) } : null,
    featured: l.featured,
    pins: owned ? l.pins.filter((p) => owned.has(p)) : [...l.pins],
    nameGradient: grad ? null : l.nameGradient,
    nameGradientCustom: grad ? { angle: grad.angle, light: gradientStops(grad, 'light'), dark: gradientStops(grad, 'dark') } : null,
    nameColour: name ? { light: name.light, dark: name.dark } : null,
    nameFont: l.nameFont,
    accent: accent ? { base: accent.base, light: accent.light, dark: accent.dark } : null,
    banner: l.banner === 'image' && !bannerImage ? 'none' : l.banner,
    bannerImage,
    ring: l.ring,
    pronouns: l.pronouns || '',
    status: l.status || '',
    statusEmoji: l.statusEmoji || '',
  };
}
