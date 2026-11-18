import { HttpError, json, fail, readJson, isPlainObject } from './util.js';
import { hit, tooMany } from './rate.js';
import { cleanText } from './profiles.js';
import { logModAction, actorName } from './party-mod.js';
import { BADGE_IMG_CSP, isBadgeImagePath } from './security.js';

export { BADGE_IMG_CSP, isBadgeImagePath };

export const CUSTOM_BADGE_RE = /^c-[a-z0-9]{8}$/;
export const MAX_CUSTOM_BADGES = 100;
export const BADGE_IMAGE_MAX = 60 * 1024;
export const BADGE_IMAGE_MIN_SIDE = 16;
export const BADGE_IMAGE_MAX_SIDE = 256;
export const BADGE_NAME_MAX = 32;
export const BADGE_NOTE_MAX = 100;
export const BADGE_EMOJI_MAX = 8;
export const BADGE_EMOJI_DEFAULT = '\u{1F3C5}';
export const BADGE_IMG_PREFIX = '/badge-img/';
export const IMAGE_EXT = Object.freeze({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' });
export const BADGE_IMG_CACHE = 'public, max-age=31536000, immutable';
export const BADGE_WRITES_PER_MIN = 30;
export const BADGE_BODY_LIMIT = 100 * 1024;

const FIELDS = new Set(['name', 'note', 'emoji', 'image']);
const EXT = IMAGE_EXT;
const IMG_PATH_RE = /^\/badge-img\/(c-[a-z0-9]{8})-([0-9a-f]{16})\.(png|webp|jpg)$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_RE = /^data:[a-z0-9.+/-]{0,40}(;[a-z0-9=.-]{0,40})*;base64,/i;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣/u;
const EMOJI_BAD_RE = /[\p{L}\s<>&"'`\\]/u;
const COLUMNS = 'id, name, note, emoji, mime, hash, width, height, bytes, created, updated';
const GONE = 'That badge was deleted, so this was cancelled.';
const MISSING_TEXT = 'Picture not found';

function bad(code, message) {
  return new HttpError(400, code, message);
}

function rowsOf(res) {
  return (res && res.results) || [];
}

const u32be = (b, i) => b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + b[i + 3] * 0x1000000;
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function sniffPng(b) {
  if (b.length < 45 || PNG_SIG.some((v, i) => b[i] !== v)) return null;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
  if (u32be(b, b.length - 12) !== 0 || ascii(b, b.length - 8, 4) !== 'IEND') return null;
  return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function sniffWebp(b) {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  if (u32le(b, 4) + 8 !== b.length) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    return { mime: 'image/webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

function sniffJpeg(b) {
  if (b.length < 16 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { mime: 'image/jpeg', width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
    }
    i += 2 + len;
  }
  return null;
}

export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  return sniffPng(bytes) || sniffWebp(bytes) || sniffJpeg(bytes);
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

export function base64Bytes(raw, max, { missing = 'Pick a picture for the badge.' } = {}) {
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
  const kind = sniffImage(bytes);
  if (!kind) throw bad('bad_image', 'Use a PNG, JPG or WebP picture. Other kinds of files, like SVG, are not allowed.');
  return { bytes, ...kind };
}

export function decodeImage(raw) {
  const img = base64Bytes(raw, BADGE_IMAGE_MAX);
  const { width, height } = img;
  if (width < BADGE_IMAGE_MIN_SIDE || height < BADGE_IMAGE_MIN_SIDE || width > BADGE_IMAGE_MAX_SIDE || height > BADGE_IMAGE_MAX_SIDE) {
    throw bad('bad_image_size', `The picture must be between ${BADGE_IMAGE_MIN_SIDE} and ${BADGE_IMAGE_MAX_SIDE} pixels on each side.`);
  }
  return img;
}

export async function imageHash(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
}

export function cleanName(raw) {
  if (typeof raw !== 'string') throw bad('bad_name', 'Give the badge a name.');
  const name = cleanText(raw, BADGE_NAME_MAX + 1);
  if (!name) throw bad('bad_name', 'Give the badge a name.');
  if (Array.from(name).length > BADGE_NAME_MAX) throw bad('bad_name', `Keep the name to ${BADGE_NAME_MAX} characters or fewer.`);
  if (isFounderName(name)) throw bad('reserved_name', 'Founder is only for Jolli. Pick another name.');
  return name;
}

const LOOKALIKES = Object.freeze({
  0: 'o', 3: 'e', 5: 's', 7: 't', $: 's', '€': 'e', '£': 'e', ƒ: 'f', ꜰ: 'f', ꝼ: 'f', ϝ: 'f', ғ: 'f',
  о: 'o', ο: 'o', օ: 'o', ø: 'o', ᴏ: 'o', σ: 'o', θ: 'o',
  у: 'u', υ: 'u', ս: 'u', ц: 'u', и: 'u', ᴜ: 'u', µ: 'u', μ: 'u', v: 'u', ν: 'u',
  п: 'n', ո: 'n', η: 'n', ɴ: 'n', ñ: 'n', ŋ: 'n', й: 'n',
  ԁ: 'd', ð: 'd', đ: 'd', ɗ: 'd', ᴅ: 'd', δ: 'd',
  е: 'e', ё: 'e', є: 'e', ε: 'e', ᴇ: 'e', ə: 'e', ɛ: 'e',
  г: 'r', ɾ: 'r', ʀ: 'r', ꞃ: 'r', ᴦ: 'r', я: 'r',
  ѕ: 's', т: 't', τ: 't', һ: 'h', н: 'h',
});

export function founderSkeleton(name) {
  const base = Array.from(String(name ?? '').normalize('NFKC').toLowerCase(), (c) => LOOKALIKES[c] ?? c).join('');
  return base.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '').replace(/(.)\1+/gu, '$1');
}

export function isFounderName(name) {
  return /^(the)?founders?$/.test(founderSkeleton(name));
}

export function cleanNote(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad('bad_note', 'The description must be text.');
  const note = cleanText(raw, BADGE_NOTE_MAX + 1);
  if (!note) return null;
  if (Array.from(note).length > BADGE_NOTE_MAX) throw bad('bad_note', `Keep the description to ${BADGE_NOTE_MAX} characters or fewer.`);
  return note;
}

export function cleanEmoji(raw) {
  if (raw === undefined || raw === null) return BADGE_EMOJI_DEFAULT;
  if (typeof raw !== 'string') throw bad('bad_emoji', 'The fallback emoji must be text.');
  const emoji = raw.trim();
  if (!emoji) return BADGE_EMOJI_DEFAULT;
  if (Array.from(emoji).length > BADGE_EMOJI_MAX || !EMOJI_RE.test(emoji) || EMOJI_BAD_RE.test(emoji) || /[\u0000-\u001f\u007f]/.test(emoji)) {
    throw bad('bad_emoji', 'Use one emoji, like \u{1F3C5}, for the fallback.');
  }
  return emoji;
}

export function newBadgeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `c-${Array.from(bytes, (x) => abc[x % 36]).join('')}`;
}

export function imageUrl(row) {
  return `${BADGE_IMG_PREFIX}${row.id}-${row.hash}.${EXT[row.mime] || 'png'}`;
}

export function isCustomBadge(id) {
  return typeof id === 'string' && CUSTOM_BADGE_RE.test(id);
}

export async function listCustomBadges(db) {
  try {
    const res = await db.prepare(`SELECT ${COLUMNS} FROM custom_badges ORDER BY created ASC, id ASC LIMIT ?`).bind(MAX_CUSTOM_BADGES).all();
    return rowsOf(res);
  } catch {
    return [];
  }
}

export function catalogEntry(row) {
  const out = { id: row.id, label: row.name, emoji: row.emoji || BADGE_EMOJI_DEFAULT, source: 'custom', image: imageUrl(row) };
  if (row.note) out.note = row.note;
  return out;
}

export function liveBadges(ids, catalogBadges) {
  const known = new Set((Array.isArray(catalogBadges) ? catalogBadges : []).filter((b) => b && b.source === 'custom').map((b) => b.id));
  return (Array.isArray(ids) ? ids : []).filter((id) => !isCustomBadge(id) || known.has(id));
}

export async function customBadgeVersion(db) {
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated), 0) AS m, COALESCE(SUM(updated % 1000003), 0) AS s FROM custom_badges').first();
    return `${Number(row && row.n) || 0}.${Number(row && row.m) || 0}.${Number(row && row.s) || 0}`;
  } catch {
    return null;
  }
}

export async function botCustomBadges(db, known) {
  if (known === null || known === undefined) return null;
  const version = await customBadgeVersion(db);
  if (version === null || version === known) return null;
  let rows;
  try {
    rows = rowsOf(await db.prepare(`SELECT ${COLUMNS} FROM custom_badges ORDER BY created ASC, id ASC LIMIT ?`).bind(MAX_CUSTOM_BADGES * 2).all());
  } catch {
    return null;
  }
  return { version, badges: rows.map((r) => ({ id: r.id, label: r.name, emoji: r.emoji || BADGE_EMOJI_DEFAULT, note: r.note || null })) };
}

export async function badgeHolders(db) {
  const [profiles, actions] = await Promise.all([
    db.prepare("SELECT user_id, badges FROM public_profiles WHERE badges LIKE '%\"c-%'").all().catch(() => null),
    db.prepare("SELECT user_id, kind, ref FROM owner_actions WHERE kind IN ('badge.grant', 'badge.revoke') AND status = 'done' AND ref LIKE 'c-%' ORDER BY created ASC, rowid ASC").all().catch(() => null),
  ]);
  const state = new Map();
  const key = (user, id) => `${String(user).toLowerCase()} ${id}`;
  for (const r of rowsOf(profiles)) {
    let list;
    try { list = JSON.parse(r.badges); } catch { list = []; }
    if (!Array.isArray(list)) continue;
    for (const id of list) if (isCustomBadge(id)) state.set(key(r.user_id, id), true);
  }
  for (const r of rowsOf(actions)) {
    if (isCustomBadge(r.ref)) state.set(key(r.user_id, r.ref), r.kind === 'badge.grant');
  }
  const counts = new Map();
  for (const [k, has] of state) {
    if (!has) continue;
    const id = k.slice(k.indexOf(' ') + 1);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function badgeOut(row, holders) {
  return {
    id: row.id,
    name: row.name,
    note: row.note || null,
    emoji: row.emoji || BADGE_EMOJI_DEFAULT,
    image: imageUrl(row),
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    bytes: Number(row.bytes) || 0,
    created: Number(row.created) || 0,
    updated: Number(row.updated) || 0,
    holders: holders.get(row.id) || 0,
  };
}

function checkFields(body) {
  if (!isPlainObject(body)) throw bad('bad_request', 'Send the badge as an object.');
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
}

async function nameTaken(db, name, except) {
  const row = await db.prepare('SELECT id FROM custom_badges WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1').bind(name, except || '').first();
  return Boolean(row);
}

async function listRoute(env) {
  const [rows, holders] = await Promise.all([listCustomBadges(env.DB), badgeHolders(env.DB)]);
  return json({
    badges: rows.map((r) => badgeOut(r, holders)),
    max: MAX_CUSTOM_BADGES,
    limits: { name: BADGE_NAME_MAX, note: BADGE_NOTE_MAX, imageBytes: BADGE_IMAGE_MAX, minSide: BADGE_IMAGE_MIN_SIDE, maxSide: BADGE_IMAGE_MAX_SIDE },
  });
}

async function writeLimit(env, session, t) {
  const limit = await hit(env.DB, `owner:badge:${String(session.user_id).toLowerCase()}`, BADGE_WRITES_PER_MIN, t);
  return limit.ok ? null : tooMany(limit.retryAfter, "That's a lot of badge changes in one minute. Wait a moment and try again.");
}

async function createBadge(request, env, session, t) {
  const body = await readJson(request, BADGE_BODY_LIMIT);
  checkFields(body);
  const slow = await writeLimit(env, session, t);
  if (slow) return slow;
  const name = cleanName(body.name);
  const note = cleanNote(body.note);
  const emoji = cleanEmoji(body.emoji);
  const img = decodeImage(body.image);
  const db = env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM custom_badges').first();
  if ((Number(count && count.n) || 0) >= MAX_CUSTOM_BADGES) {
    return fail(409, 'too_many_badges', `You already have ${MAX_CUSTOM_BADGES} badges. Delete one before making another.`);
  }
  if (await nameTaken(db, name, null)) return fail(409, 'name_taken', 'You already have a badge with that name. Pick another name.');
  const hash = await imageHash(img.bytes);
  let id = newBadgeId();
  for (let i = 0; i < 4 && (await db.prepare('SELECT 1 AS x FROM custom_badges WHERE id = ?').bind(id).first()); i++) id = newBadgeId();
  const actorId = String(session.user_id).toLowerCase();
  const put = await db.prepare('INSERT INTO custom_badges (id, name, note, emoji, image, mime, hash, width, height, bytes, created, updated, created_by) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM custom_badges) < ?')
    .bind(id, name, note, emoji, img.bytes, img.mime, hash, img.width, img.height, img.bytes.length, t, t, actorId, MAX_CUSTOM_BADGES).run();
  if (!put || !put.meta || !(Number(put.meta.changes) > 0)) {
    return fail(409, 'too_many_badges', `You already have ${MAX_CUSTOM_BADGES} badges. Delete one before making another.`);
  }
  await db.batch([
    logModAction(db, { actorId, actorName: actorName(session), action: 'owner_badge_create', detail: { badge: id, name, summary: `Made the badge “${name}”` }, t }),
  ]);
  const row = await db.prepare(`SELECT ${COLUMNS} FROM custom_badges WHERE id = ?`).bind(id).first();
  return json({ badge: badgeOut(row, new Map()) }, 201);
}

async function editBadge(request, env, session, id, t) {
  const body = await readJson(request, BADGE_BODY_LIMIT);
  checkFields(body);
  const slow = await writeLimit(env, session, t);
  if (slow) return slow;
  const db = env.DB;
  const old = await db.prepare(`SELECT ${COLUMNS} FROM custom_badges WHERE id = ?`).bind(id).first();
  if (!old) return fail(404, 'not_found', 'That badge is gone. Reload the page.');
  const sets = [];
  const args = [];
  const changed = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (name !== old.name) {
      if (await nameTaken(db, name, id)) return fail(409, 'name_taken', 'You already have a badge with that name. Pick another name.');
      sets.push('name = ?'); args.push(name); changed.push('name');
    }
  }
  if (body.note !== undefined) {
    const note = cleanNote(body.note);
    if (note !== (old.note || null)) { sets.push('note = ?'); args.push(note); changed.push('description'); }
  }
  if (body.emoji !== undefined) {
    const emoji = cleanEmoji(body.emoji);
    if (emoji !== old.emoji) { sets.push('emoji = ?'); args.push(emoji); changed.push('emoji'); }
  }
  if (body.image !== undefined && body.image !== null) {
    const img = decodeImage(body.image);
    const hash = await imageHash(img.bytes);
    if (hash !== old.hash) {
      sets.push('image = ?', 'mime = ?', 'hash = ?', 'width = ?', 'height = ?', 'bytes = ?');
      args.push(img.bytes, img.mime, hash, img.width, img.height, img.bytes.length);
      changed.push('picture');
    }
  }
  if (!sets.length) {
    const holders = await badgeHolders(db);
    return json({ badge: badgeOut(old, holders), changed: [] });
  }
  sets.push('updated = ?');
  args.push(Math.max(t, Number(old.updated) + 1));
  const newName = changed.includes('name') ? args[0] : old.name;
  const summary = changed.includes('name') ? `Renamed the badge “${old.name}” to “${newName}”` : `Changed the ${changed.join(', ')} of the badge “${old.name}”`;
  await db.batch([
    db.prepare(`UPDATE custom_badges SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id),
    logModAction(db, { actorId: session.user_id, actorName: actorName(session), action: 'owner_badge_edit', detail: { badge: id, name: newName, before: old.name, changed, summary }, t }),
  ]);
  const [row, holders] = await Promise.all([db.prepare(`SELECT ${COLUMNS} FROM custom_badges WHERE id = ?`).bind(id).first(), badgeHolders(db)]);
  return json({ badge: badgeOut(row, holders), changed });
}

async function deleteBadge(env, session, id, t) {
  const db = env.DB;
  const old = await db.prepare(`SELECT ${COLUMNS} FROM custom_badges WHERE id = ?`).bind(id).first();
  if (!old) return fail(404, 'not_found', 'That badge is already gone.');
  const holders = (await badgeHolders(db)).get(id) || 0;
  await db.batch([
    db.prepare('DELETE FROM custom_badges WHERE id = ?').bind(id),
    db.prepare("UPDATE owner_actions SET status = 'failed', result = ?, updated = ? WHERE ref = ? AND kind IN ('badge.grant', 'badge.revoke') AND status IN ('queued', 'sent')").bind(GONE, t, id),
    logModAction(db, { actorId: session.user_id, actorName: actorName(session), action: 'owner_badge_delete', detail: { badge: id, name: old.name, holders, summary: `Deleted the badge “${old.name}”` }, t }),
  ]);
  return json({ ok: true, deleted: id, holders });
}

export async function badgesRoute(request, env, session, route, t) {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  if (route.length === 2) {
    if (read) return listRoute(env);
    if (method === 'POST') return createBadge(request, env, session, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (route.length === 3) {
    const id = String(route[2] || '');
    if (!CUSTOM_BADGE_RE.test(id)) return fail(404, 'not_found', 'That badge is gone. Reload the page.');
    if (method === 'PATCH' || method === 'POST') return editBadge(request, env, session, id, t);
    if (method === 'DELETE') {
      const slow = await writeLimit(env, session, t);
      if (slow) return slow;
      return deleteBadge(env, session, id, t);
    }
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

function missingImage() {
  return new Response(MISSING_TEXT, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
}

export async function serveBadgeImage(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const m = IMG_PATH_RE.exec(url.pathname);
  if (!m || !env.DB) return missingImage();
  const row = await env.DB.prepare('SELECT image, mime, hash FROM custom_badges WHERE id = ?').bind(m[1]).first().catch(() => null);
  if (!row || row.hash !== m[2] || EXT[row.mime] !== m[3]) return missingImage();
  const bytes = toBytes(row.image);
  const kind = sniffImage(bytes);
  if (!kind || kind.mime !== row.mime || bytes.length > BADGE_IMAGE_MAX) return missingImage();
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
