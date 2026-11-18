import { HttpError, json, fail, readJson, isPlainObject, parseJsonSafe } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { badgesFor, partySeasonBadges } from './party-badges.js';
import { liveBadges, base64Bytes, imageHash, sniffImage, toBytes, IMAGE_EXT, BADGE_IMG_CACHE } from './custom-badges.js';
import { readCatalog } from './owner.js';
import { blockedIn } from './party-blocked.js';
import { logModAction, personName } from './party-mod.js';
import { clearPartyProfileCache } from './party-profile.js';
import { isBannerImagePath } from './security.js';
import { cleanLook, defaultLook, isDefaultLook, lookTexts, themeColours, LookError, LOOK_VERSION, LOOK_BODY_MAX, ACH_PREFIX, PIN_MAX, BIO_MAX, PRONOUNS_MAX, STATUS_MAX } from '../web/js/profile-look.js';

export const BANNER_MAX = 450 * 1024;
export const BANNER_BODY_LIMIT = 640 * 1024;
export const BANNER_MIN_W = 600;
export const BANNER_MAX_W = 1600;
export const BANNER_MIN_H = 200;
export const BANNER_MAX_H = 600;
export const BANNER_MIN_RATIO = 2;
export const BANNER_MAX_RATIO = 4;
export const BANNER_PREFIX = '/banner-img/';
export const BANNER_ID_RE = /^b-[a-z0-9]{10}$/;

const MAX_BADGES = 64;
const MAX_ACHIEVEMENTS = 100;
const BADGE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const BANNER_PATH_RE = /^\/banner-img\/(b-[a-z0-9]{10})-([0-9a-f]{16})\.(png|webp|jpg)$/;
const BANNER_COLUMNS = 'user_id, id, mime, hash, width, height, bytes, updated';
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
  if (!row || !BANNER_ID_RE.test(String(row.id)) || !IMAGE_EXT[row.mime]) return null;
  return `${BANNER_PREFIX}${row.id}-${row.hash}.${IMAGE_EXT[row.mime]}`;
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
  const [row, banner] = await Promise.all([
    db.prepare('SELECT v, data, updated FROM profile_custom WHERE user_id = ?').bind(id).first().catch(() => null),
    db.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(id).first().catch(() => null),
  ]);
  const look = row ? cleanLook(parseJsonSafe(row.data, {})) : defaultLook();
  return { look, banner: banner || null, updated: row ? Number(row.updated) || 0 : 0 };
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

export function publicLook(look, banner, owned) {
  const l = look || defaultLook();
  const pins = owned ? l.pins.filter((p) => owned.has(p)) : [...l.pins];
  const bannerImage = l.banner === 'image' ? bannerUrl(banner) : null;
  return {
    v: LOOK_VERSION,
    pins,
    order: [...l.order],
    hidden: [...l.hidden],
    nameColour: l.nameColour,
    nameGradient: l.nameGradient,
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
    colours: {
      name: l.nameColour ? themeColours(l.nameColour) : null,
      accent: l.accent ? themeColours(l.accent) : null,
    },
  };
}

export async function lookForProfile(db, userId, owned, t) {
  const { look, banner } = await readCustom(db, userId);
  return publicLook(await safeTexts(db, look, t), banner, owned);
}

function limits() {
  return { pins: PIN_MAX, bio: BIO_MAX, pronouns: PRONOUNS_MAX, status: STATUS_MAX, bannerBytes: BANNER_MAX, bannerMinWidth: BANNER_MIN_W, bannerMaxWidth: BANNER_MAX_W, bannerMinHeight: BANNER_MIN_H, bannerMaxHeight: BANNER_MAX_H };
}

async function readOwn(env, userId, t) {
  const owned = await ownedFor(env.DB, userId);
  const { look, banner } = await readCustom(env.DB, userId);
  return json({ look: publicLook(await safeTexts(env.DB, look, t), banner, owned), owned: [...owned], limits: limits() });
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
  const banner = await env.DB.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(userId).first();
  if (look.banner === 'image' && !banner) throw new HttpError(400, 'no_banner', 'Upload a banner picture first, or pick another banner.');
  if (isDefaultLook(look)) await env.DB.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(userId).run();
  else await saveStatement(env.DB, userId, look, t).run();
  clearPartyProfileCache(env.DB);
  return json({ ok: true, look: publicLook(look, banner, owned) });
}

export function decodeBanner(raw) {
  const img = base64Bytes(raw, BANNER_MAX, { missing: 'Pick a picture for your banner.' });
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
  for (const k of Object.keys(body)) if (k !== 'image') throw new HttpError(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  const slow = await lookLimit(env, userId, 'banner', LIMITS.profileBanner, t);
  if (slow) return slow;
  const db = env.DB;
  const pub = await db.prepare('SELECT 1 AS x FROM public_profiles WHERE user_id = ?').bind(userId).first();
  if (!pub) throw new HttpError(403, 'no_profile', 'Your public profile is not set up yet. Use the YapOS bot in a server first, then try again.');
  const img = decodeBanner(body.image);
  const hash = await imageHash(img.bytes);
  const old = await db.prepare('SELECT id FROM profile_banners WHERE user_id = ?').bind(userId).first();
  let id = old ? old.id : newBannerId();
  for (let i = 0; !old && i < 4 && (await db.prepare('SELECT 1 AS x FROM profile_banners WHERE id = ?').bind(id).first()); i++) id = newBannerId();
  const { look } = await readCustom(db, userId);
  const next = { ...look, banner: 'image' };
  await db.batch([
    db.prepare('INSERT INTO profile_banners (user_id, id, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET image = excluded.image, mime = excluded.mime, hash = excluded.hash, width = excluded.width, height = excluded.height, bytes = excluded.bytes, updated = excluded.updated')
      .bind(userId, id, img.bytes, img.mime, hash, img.width, img.height, img.bytes.length, t),
    saveStatement(db, userId, next, t),
  ]);
  clearPartyProfileCache(db);
  const row = await db.prepare(`SELECT ${BANNER_COLUMNS} FROM profile_banners WHERE user_id = ?`).bind(userId).first();
  return json({ ok: true, banner: { url: bannerUrl(row), width: Number(row.width), height: Number(row.height), bytes: Number(row.bytes) } }, 201);
}

export function removeBannerStatements(db, userId, look, t) {
  const stmts = [db.prepare('DELETE FROM profile_banners WHERE user_id = ?').bind(userId)];
  if (look && look.banner === 'image') {
    const next = { ...look, banner: 'none' };
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

export const RESET_PARTS = Object.freeze(['banner', 'bio', 'status', 'pronouns', 'text', 'name-style', 'pins', 'all']);
export const RESET_ACTIONS = Object.freeze(['profile_banner_remove', 'profile_text_clear', 'profile_name_style_reset', 'profile_pins_clear', 'profile_reset']);
const TEXT_PARTS = Object.freeze({ bio: ['bio'], status: ['status', 'statusEmoji'], pronouns: ['pronouns'] });
const FIELD_NAMES = Object.freeze({ bio: 'about me', status: 'status', pronouns: 'pronouns' });

export async function staffLookView(db, userId) {
  const { look, banner } = await readCustom(db, userId);
  return {
    banner: bannerUrl(banner),
    bannerChoice: look.banner,
    bio: look.bio,
    pronouns: look.pronouns,
    status: look.status,
    statusEmoji: look.statusEmoji,
    nameColour: look.nameColour,
    nameGradient: look.nameGradient,
    nameFont: look.nameFont,
    pins: [...look.pins],
    custom: !isDefaultLook(look),
  };
}

function hasNameStyle(look) {
  return Boolean(look.nameColour || look.nameGradient || (look.nameFont && look.nameFont !== 'default'));
}

function textFields(look, part) {
  const keys = part === 'text' ? ['bio', 'status', 'pronouns'] : [part];
  return keys.filter((k) => TEXT_PARTS[k].some((f) => look[f]));
}

function possessive(name) {
  return name ? `${name}'s` : 'their';
}

export function resetPlan(db, id, part, current, name, t) {
  const { look, banner } = current;
  const who = possessive(name);
  const store = (next) => (isDefaultLook(next) ? db.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(id) : saveStatement(db, id, next, t));
  if (part === 'banner') {
    if (!banner) return null;
    return { action: 'profile_banner_remove', stmts: removeBannerStatements(db, id, look, t), detail: { part, summary: `Removed ${who} profile banner picture` } };
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
    return { action: 'profile_name_style_reset', stmts: [store({ ...look, nameColour: null, nameGradient: null, nameFont: 'default' })], detail: { part, summary: `Reset ${who} name colour and style` } };
  }
  if (part === 'pins') {
    if (!look.pins.length) return null;
    return { action: 'profile_pins_clear', stmts: [store({ ...look, pins: [] })], detail: { part, count: look.pins.length, summary: `Cleared ${who} pinned badges` } };
  }
  if (part === 'all') {
    if (!banner && isDefaultLook(look)) return null;
    return {
      action: 'profile_reset',
      stmts: [db.prepare('DELETE FROM profile_custom WHERE user_id = ?').bind(id), db.prepare('DELETE FROM profile_banners WHERE user_id = ?').bind(id)],
      detail: { part, banner: Boolean(banner) || undefined, bio: look.bio || undefined, status: look.status || undefined, summary: `Reset ${who} whole profile look` },
    };
  }
  return null;
}

export const NOTHING_TO_RESET = Object.freeze({
  banner: "They don't have a banner picture.",
  bio: 'There is no about me to clear.',
  status: 'There is no status to clear.',
  pronouns: 'There are no pronouns to clear.',
  text: 'There is no profile text to clear.',
  'name-style': 'Their name already uses the default colour and style.',
  pins: 'They have no pinned badges.',
  all: 'Their profile already uses the default look.',
});

export async function resetLook(db, { id, part, actor, t }) {
  const current = await readCustom(db, id);
  const name = await personName(db, id);
  const plan = resetPlan(db, id, part, current, name, t);
  if (!plan) return { done: false, message: NOTHING_TO_RESET[part] || 'There is nothing to reset.' };
  await db.batch([...plan.stmts, logModAction(db, { actorId: actor.id, actorName: actor.name, action: plan.action, targetId: id, targetName: name, detail: plan.detail, t })]);
  clearPartyProfileCache(db);
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
  const row = await env.DB.prepare('SELECT user_id, image, mime, hash FROM profile_banners WHERE id = ?').bind(m[1]).first().catch(() => null);
  if (!row || row.hash !== m[2] || IMAGE_EXT[row.mime] !== m[3]) return missingImage();
  if (isHidden && (await isHidden(env.DB, row.user_id))) return missingImage();
  const bytes = toBytes(row.image);
  const kind = sniffImage(bytes);
  if (!kind || kind.mime !== row.mime || bytes.length > BANNER_MAX) return missingImage();
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

export function cardLook(look, owned, banner = null) {
  const l = look || defaultLook();
  const name = l.nameColour ? themeColours(l.nameColour) : null;
  const accent = l.accent ? themeColours(l.accent) : null;
  const bannerImage = l.banner === 'image' ? bannerUrl(banner) : null;
  return {
    pins: owned ? l.pins.filter((p) => owned.has(p)) : [...l.pins],
    nameGradient: l.nameGradient,
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
