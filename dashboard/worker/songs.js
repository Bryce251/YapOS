import { HOUR, json, fail, readJson, readBytes, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { getSession } from './sessions.js';
import { getActivityUser } from './activity-auth.js';
import { partyRole } from './reports.js';
import { logModAction, actorName, personName } from './party-mod.js';
import { toBytes } from './custom-badges.js';
import { findBlocked } from '../web/activity/js/filter.js';
import {
  SONG_MAX_BYTES, SONG_CHUNK, SONG_MAX_PARTS, SONG_MIN_MS, SONG_MAX_MS, SECTION_MIN_MS, SECTION_MAX_MS,
  SONG_CAP_COUNT, SONG_KBPS_MIN, SONG_KBPS_MAX, SONG_ID_RE, UPLOAD_ID_RE, HASH_RE, TITLE_MAX, ARTIST_MAX, CREDIT_MAX,
  OFFSET_MIN, OFFSET_MAX, DIFF_IDS, CHART_MAX_BYTES, ChartError, validateCharts, chartCounts, songCapBytes, partsFor, partSize,
  sha256HexBytes, songHash, songIdOf,
} from '../web/activity/js/games/beatcodec.js';

export const SONG_AUDIO_PREFIX = '/song-audio/';
export const SONG_AUDIO_CACHE = 'public, max-age=31536000, immutable';
export const SONG_LIST_CACHE = 'public, max-age=60';
export const SONG_PRIVATE_CACHE = 'private, no-store';
export const MATURE_SIGNED_OUT = 'Sign in to YapOS Party to play this song.';
export const UPLOAD_TTL = HOUR;
export const PENDING_MAX = 2;
export const FINISH_BODY_LIMIT = CHART_MAX_BYTES + 64 * 1024;
export const BEGIN_BODY_LIMIT = 4096;
export const HIDDEN_GRACE = 15 * 60 * 1000;

export function hiddenGone(row, t) {
  return Boolean(row) && Number(row.hidden) === 1 && t - Number(row.updated) > HIDDEN_GRACE;
}

const AUDIO_PATH_RE = /^\/song-audio\/(s-[0-9a-f]{16})\.(mp3|ogg|m4a)$/;
const IDX_RE = /^[0-9]{1,2}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_TEXT = 'This request was blocked for your safety. Reload the page and try again.';
const STAFF_ONLY = 'Only YapOS Party staff can manage Beat Drop songs.';
const NOT_AUDIO = 'That file is not an MP3, OGG or M4A song.';
const MISSING_SONG = 'That song is not on the shelf any more.';
const MISSING_UPLOAD = 'That upload has run out of time. Start it again.';
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const EDIT_FIELDS = new Set(['title', 'artist', 'credit', 'hidden', 'mature', 'offset_ms', 'start_ms', 'end_ms', 'preview_ms', 'bpm', 'charts']);
const FINISH_FIELDS = new Set(['title', 'artist', 'credit', 'rights', 'duration_ms', 'bpm', 'offset_ms', 'start_ms', 'end_ms', 'preview_ms', 'charts']);
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'mp42', 'isom', 'iso2']);
const SONG_COLUMNS = 'id, hash, mime, ext, bytes, parts, duration_ms, title, artist, credit, bpm, offset_ms, start_ms, end_ms, preview_ms, charts, chart_v, counts, hidden, uploader, rights_confirmed_at, created, updated';
const MATURE_COLUMN = 'COALESCE((SELECT f.mature FROM party_song_flags f WHERE f.id = party_songs.id), 0) AS mature';
const SONG_SELECT = `${SONG_COLUMNS}, ${MATURE_COLUMN}`;

class SongError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badReq = (message, code = 'bad_request') => new SongError(400, code, message);
const nope = () => new Response(JSON.stringify({ error: 'method_not_allowed', message: 'That action is not allowed here.' }), { status: 405, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const lower = (v) => String(v ?? '').toLowerCase();
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function mp3Frame(b, i) {
  if (i + 4 > b.length) return false;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return false;
  const version = (b[i + 1] >> 3) & 3;
  const layer = (b[i + 1] >> 1) & 3;
  const rate = b[i + 2] >> 4;
  const sample = (b[i + 2] >> 2) & 3;
  return version !== 1 && layer !== 0 && rate !== 0 && rate !== 15 && sample !== 3;
}

function sniffMp3(b) {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    if (b[3] < 2 || b[3] > 4 || b[4] === 0xff) return false;
    for (let i = 6; i < 10; i++) if (b[i] >= 0x80) return false;
    const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
    const start = 10 + size + (b[5] & 0x10 ? 10 : 0);
    if (start + 4 > b.length) return true;
    const stop = Math.min(b.length - 4, start + 4096);
    for (let i = start; i <= stop; i++) if (mp3Frame(b, i)) return true;
    return false;
  }
  return mp3Frame(b, 0);
}

function sniffOgg(b) {
  if (b.length < 36 || ascii(b, 0, 4) !== 'OggS') return false;
  const head = ascii(b, 0, Math.min(b.length, 512));
  return head.includes('OpusHead') || head.includes('\u0001vorbis');
}

function sniffM4a(b) {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return false;
  const size = Math.min(b.length, ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]);
  const major = ascii(b, 8, 4);
  if (major === 'qt  ' || major.startsWith('3g')) return false;
  if (M4A_BRANDS.has(major)) return true;
  for (let i = 16; i + 4 <= size; i += 4) {
    const brand = ascii(b, i, 4);
    if (brand === 'qt  ' || brand.startsWith('3g')) return false;
    if (M4A_BRANDS.has(brand)) return true;
  }
  return false;
}

export function sniffAudio(bytes) {
  const b = toBytes(bytes);
  if (sniffOgg(b)) return { mime: 'audio/ogg', ext: 'ogg' };
  if (sniffM4a(b)) return { mime: 'audio/mp4', ext: 'm4a' };
  if (sniffMp3(b)) return { mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

export function isSongAudioPath(pathname) {
  return String(pathname).startsWith(SONG_AUDIO_PREFIX);
}

export function songAudioUrl(row) {
  return `${SONG_AUDIO_PREFIX}${row.id}.${row.ext}`;
}

function newUploadId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = 'u-';
  for (const b of bytes) out += '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36];
  return out;
}

export function cleanSongText(raw, max, what, { required = false } = {}) {
  if (raw === undefined || raw === null) raw = '';
  if (typeof raw !== 'string') throw badReq(`The ${what} must be text.`);
  const text = raw.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (required && !text) throw badReq(`Add the ${what}.`);
  if ([...text].length > max) throw badReq(`Keep the ${what} under ${max + 1} characters.`);
  if (text && findBlocked(text).length) throw badReq(`The ${what} has a word that is not allowed in YapOS Party.`, 'blocked_word');
  return text;
}

function parseCounts(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((n) => Number(n) || 0) : [];
  } catch {
    return [];
  }
}

function parseCharts(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function checkTiming(v, bytes) {
  const { duration_ms: dur, start_ms: start, end_ms: end, offset_ms: off, preview_ms: preview } = v;
  if (!isInt(dur) || dur < SONG_MIN_MS || dur > SONG_MAX_MS) throw badReq(`Songs must be between ${SONG_MIN_MS / 1000} seconds and ${SONG_MAX_MS / 60000} minutes long.`, 'bad_length');
  const kbps = bytes / 1024 / (dur / 1000);
  if (kbps < SONG_KBPS_MIN || kbps > SONG_KBPS_MAX) throw badReq('The song length does not match the file. Pick the file again.', 'bad_length');
  if (!isInt(start) || !isInt(end) || start < 0 || end <= start || end > dur) throw badReq('Pick a part of the song that fits inside it.', 'bad_section');
  const len = end - start;
  if (len < SECTION_MIN_MS || len > SECTION_MAX_MS) throw badReq(`The part of the song you play must be between ${SECTION_MIN_MS / 1000} seconds and ${SECTION_MAX_MS / 60000} minutes.`, 'bad_section');
  if (!isInt(off) || off < OFFSET_MIN || off > OFFSET_MAX) throw badReq(`The offset must be between ${OFFSET_MIN} and ${OFFSET_MAX} ms.`, 'bad_offset');
  if (!isInt(preview) || preview < start || preview >= end) throw badReq('The best part must start inside the part of the song you play.', 'bad_preview');
  return len;
}

function checkCharts(raw, len) {
  try {
    return validateCharts(raw, len);
  } catch (err) {
    if (err instanceof ChartError) throw badReq(err.message, 'bad_chart');
    throw err;
  }
}

function songOut(row, names = new Map()) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    credit: row.credit,
    duration_ms: Number(row.duration_ms),
    bytes: Number(row.bytes),
    bpm: Number(row.bpm),
    offset_ms: Number(row.offset_ms),
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
    preview_ms: Number(row.preview_ms),
    cv: Number(row.chart_v),
    counts: parseCounts(row.counts),
    hidden: Number(row.hidden) === 1,
    mature: isMature(row),
    uploader: row.uploader,
    uploaderName: names.get(row.uploader) || null,
    url: songAudioUrl(row),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

export function isMature(row) {
  return Boolean(row) && Number(row.mature) === 1;
}

export async function songUsage(db) {
  const songs = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM party_songs').first();
  return { count: Number(songs.n) || 0, bytes: Number(songs.b) || 0 };
}

async function pendingUsage(db, t) {
  const row = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM party_song_uploads WHERE expires > ?').bind(t).first();
  return { count: Number(row.n) || 0, bytes: Number(row.b) || 0 };
}

function usageOut(env, used) {
  return { count: used.count, bytes: used.bytes, capCount: SONG_CAP_COUNT, capBytes: songCapBytes(env) };
}

async function listSongs(env, role, t) {
  const res = await env.DB.prepare(`SELECT ${SONG_SELECT} FROM party_songs ORDER BY created DESC, id ASC`).all();
  const rows = (res && res.results) || [];
  const names = new Map();
  for (const id of new Set(rows.map((r) => r.uploader))) names.set(id, await personName(env.DB, id));
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_song_uploads WHERE expires > ?').bind(t).first();
  return json({ songs: rows.map((r) => songOut(r, names)), usage: usageOut(env, await songUsage(env.DB)), pending: Number(mine.n) || 0, role });
}

async function getSong(db, id) {
  if (!SONG_ID_RE.test(id)) return null;
  return db.prepare(`SELECT ${SONG_SELECT} FROM party_songs WHERE id = ?`).bind(id).first();
}

async function songDetail(env, id) {
  const row = await getSong(env.DB, id);
  if (!row) return fail(404, 'not_found', MISSING_SONG);
  return json({ song: { ...songOut(row), charts: parseCharts(row.charts) } });
}

async function haveParts(db, uid) {
  const res = await db.prepare('SELECT idx, bytes, hash FROM party_song_chunks WHERE owner = ? ORDER BY idx ASC').bind(uid).all();
  return (res && res.results) || [];
}

async function beginUpload(request, env, me, t) {
  const body = await readJson(request, BEGIN_BODY_LIMIT);
  const { bytes, parts, hash } = body;
  if (!isInt(bytes) || bytes < 1) throw badReq('Pick a song file first.', 'bad_size');
  if (bytes > SONG_MAX_BYTES) throw new SongError(413, 'too_large', `Songs can be up to ${SONG_MAX_BYTES / 1048576} MB.`);
  if (!isInt(parts) || parts !== partsFor(bytes) || parts > SONG_MAX_PARTS) throw badReq('The upload was split up wrong. Reload the page and try again.', 'bad_parts');
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw badReq('The upload was split up wrong. Reload the page and try again.', 'bad_hash');
  const same = await env.DB.prepare('SELECT id FROM party_songs WHERE hash = ?').bind(hash).first();
  if (same) return json({ exists: same.id });
  const resume = await env.DB.prepare('SELECT id, bytes, parts FROM party_song_uploads WHERE user_id = ? AND hash = ? AND expires > ?').bind(me, hash, t).first();
  if (resume && Number(resume.bytes) === bytes) {
    const have = (await haveParts(env.DB, resume.id)).map((c) => ({ idx: Number(c.idx), hash: c.hash }));
    await env.DB.prepare('UPDATE party_song_uploads SET expires = ? WHERE id = ?').bind(t + UPLOAD_TTL, resume.id).run();
    return json({ upload: resume.id, chunk: SONG_CHUNK, parts, have });
  }
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_song_uploads WHERE user_id = ? AND expires > ?').bind(me, t).first();
  if (Number(mine.n) >= PENDING_MAX) throw new SongError(409, 'too_many_uploads', `You already have ${PENDING_MAX} uploads going. Finish or cancel one first.`);
  const used = await songUsage(env.DB);
  const pending = await pendingUsage(env.DB, t);
  const capBytes = songCapBytes(env);
  if (used.count + pending.count + 1 > SONG_CAP_COUNT || used.bytes + pending.bytes + bytes > capBytes) {
    throw new SongError(409, 'store_full', `The song shelf is full (${SONG_CAP_COUNT} songs or ${Math.round(capBytes / 1048576)} MB). Delete a song to make room.`);
  }
  const id = newUploadId();
  await env.DB.prepare('INSERT INTO party_song_uploads (id, user_id, hash, bytes, parts, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, me, hash, bytes, parts, t, t + UPLOAD_TTL).run();
  return json({ upload: id, chunk: SONG_CHUNK, parts, have: [] }, 201);
}

async function myUpload(db, uid, me, t) {
  if (!UPLOAD_ID_RE.test(uid)) return null;
  const row = await db.prepare('SELECT id, user_id, hash, bytes, parts, expires FROM party_song_uploads WHERE id = ?').bind(uid).first();
  if (!row || row.user_id !== me || Number(row.expires) <= t) return null;
  return row;
}

async function putPart(request, env, me, uid, rawIdx, t) {
  const up = await myUpload(env.DB, uid, me, t);
  if (!up) return fail(404, 'not_found', MISSING_UPLOAD);
  if (!IDX_RE.test(rawIdx) || Number(rawIdx) >= Number(up.parts)) throw badReq('That piece of the song does not exist.', 'bad_part');
  const idx = Number(rawIdx);
  const type = lower(request.headers.get('Content-Type'));
  if (!type.startsWith('application/octet-stream')) return fail(415, 'bad_type', 'Send the song as raw file data.');
  const data = await readBytes(request, SONG_CHUNK);
  if (data.length !== partSize(Number(up.bytes), idx)) throw badReq('That piece of the song is the wrong size. Try again.', 'bad_size');
  if (idx === 0 && !sniffAudio(data)) throw badReq(NOT_AUDIO, 'not_audio');
  const hash = await sha256HexBytes(data);
  await env.DB.prepare('INSERT INTO party_song_chunks (owner, idx, data, bytes, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, idx) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, hash = excluded.hash')
    .bind(uid, idx, data, data.length, hash)
    .run();
  return json({ idx, hash });
}

function dropUploadStatements(db, uid) {
  return [
    db.prepare('DELETE FROM party_song_chunks WHERE owner = ?').bind(uid),
    db.prepare('DELETE FROM party_song_uploads WHERE id = ?').bind(uid),
  ];
}

function checkFields(body, allowed) {
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw badReq(`"${k}" can't be changed here.`, 'bad_field');
}

async function finishUpload(request, env, session, me, uid, t) {
  const up = await myUpload(env.DB, uid, me, t);
  if (!up) return fail(404, 'not_found', MISSING_UPLOAD);
  const body = await readJson(request, FINISH_BODY_LIMIT);
  checkFields(body, FINISH_FIELDS);
  const chunks = await haveParts(env.DB, uid);
  const parts = Number(up.parts);
  if (chunks.length !== parts || chunks.some((c, i) => Number(c.idx) !== i)) throw badReq('Part of the song did not arrive. Upload it again.', 'missing_part');
  if (chunks.reduce((s, c) => s + Number(c.bytes), 0) !== Number(up.bytes)) throw badReq('Part of the song did not arrive. Upload it again.', 'missing_part');
  const whole = await songHash(chunks.map((c) => c.hash));
  if (whole !== up.hash) throw badReq('The song did not arrive in one piece. Upload it again.', 'bad_hash');
  const first = await env.DB.prepare('SELECT data FROM party_song_chunks WHERE owner = ? AND idx = 0').bind(uid).first();
  const kind = first ? sniffAudio(first.data) : null;
  if (!kind) throw badReq(NOT_AUDIO, 'not_audio');
  if (body.rights !== true) throw badReq('Tick the box to confirm you own this song or have permission to use it.', 'rights');
  const title = cleanSongText(body.title, TITLE_MAX, 'song title', { required: true });
  const artist = cleanSongText(body.artist, ARTIST_MAX, 'artist name', { required: true });
  const credit = cleanSongText(body.credit, CREDIT_MAX, 'credit');
  const timing = {
    duration_ms: body.duration_ms,
    start_ms: body.start_ms,
    end_ms: body.end_ms,
    offset_ms: body.offset_ms === undefined ? 0 : body.offset_ms,
    preview_ms: body.preview_ms === undefined ? body.start_ms : body.preview_ms,
  };
  const len = checkTiming(timing, Number(up.bytes));
  const charts = checkCharts(body.charts, len);
  const id = songIdOf(whole);
  const clash = await env.DB.prepare('SELECT id FROM party_songs WHERE id = ? OR hash = ?').bind(id, whole).first();
  if (clash) {
    await env.DB.batch(dropUploadStatements(env.DB, uid));
    return json({ exists: clash.id });
  }
  const counts = JSON.stringify(chartCounts(charts));
  const gone = await env.DB.prepare('SELECT chart_v FROM party_song_gone WHERE id = ?').bind(id).first();
  const cv = gone ? Number(gone.chart_v) + 1 : 1;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO party_songs (${SONG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .bind(id, whole, kind.mime, kind.ext, Number(up.bytes), parts, timing.duration_ms, title, artist, credit, charts.bpm, timing.offset_ms, timing.start_ms, timing.end_ms, timing.preview_ms, JSON.stringify(charts), cv, counts, me, t, t, t),
      env.DB.prepare('UPDATE party_song_chunks SET owner = ? WHERE owner = ?').bind(id, uid),
      env.DB.prepare('DELETE FROM party_song_uploads WHERE id = ?').bind(uid),
      logModAction(env.DB, { actorId: me, actorName: actorName(session), action: 'song_add', detail: { song: id, title, artist, summary: `Added the Beat Drop song "${title}" by ${artist}` }, t }),
    ]);
  } catch (err) {
    const raced = await env.DB.prepare('SELECT id FROM party_songs WHERE id = ?').bind(id).first();
    if (!raced) throw err;
    await env.DB.batch(dropUploadStatements(env.DB, uid));
    return json({ exists: id });
  }
  return json({ song: songOut(await getSong(env.DB, id)) }, 201);
}

async function cancelUpload(env, me, uid, t) {
  const up = await myUpload(env.DB, uid, me, t);
  if (!up) return fail(404, 'not_found', MISSING_UPLOAD);
  await env.DB.batch(dropUploadStatements(env.DB, uid));
  return json({ ok: true });
}

const SONG_SUMMARY = {
  song_hide: (title) => `Hid the Beat Drop song "${title}"`,
  song_show: (title) => `Showed the Beat Drop song "${title}"`,
  song_mature: (title) => `Marked the Beat Drop song "${title}" as 18+`,
  song_all_ages: (title) => `Marked the Beat Drop song "${title}" as fine for everyone`,
  song_edit: (title) => `Edited the Beat Drop song "${title}"`,
};

function songAction(changed, next) {
  if (changed.length !== 1) return 'song_edit';
  if (changed[0] === 'hidden' || changed[0] === 'shown') return next.hidden ? 'song_hide' : 'song_show';
  if (changed[0] === 'mature' || changed[0] === 'all_ages') return next.mature ? 'song_mature' : 'song_all_ages';
  return 'song_edit';
}

async function patchSong(request, env, session, role, me, id, t, url) {
  const row = await getSong(env.DB, id);
  if (!row) return fail(404, 'not_found', MISSING_SONG);
  const body = await readJson(request, FINISH_BODY_LIMIT);
  checkFields(body, EDIT_FIELDS);
  const notesTouched = 'charts' in body || 'start_ms' in body || 'end_ms' in body;
  if (notesTouched && role !== 'owner' && row.uploader !== me) {
    return fail(403, 'not_yours', 'Only the owner or the person who uploaded this song can change its notes.');
  }
  if (('start_ms' in body || 'end_ms' in body) && !('charts' in body)) throw badReq('Send new notes when you move the part of the song that plays.', 'bad_chart');
  if ('hidden' in body && typeof body.hidden !== 'boolean') throw badReq('Hidden must be on or off.');
  if ('mature' in body && typeof body.mature !== 'boolean') throw badReq('18+ must be on or off.');
  if ('bpm' in body && (typeof body.bpm !== 'number' || !Number.isFinite(body.bpm))) throw badReq('The tempo must be a number.');
  const next = {
    title: 'title' in body ? cleanSongText(body.title, TITLE_MAX, 'song title', { required: true }) : row.title,
    artist: 'artist' in body ? cleanSongText(body.artist, ARTIST_MAX, 'artist name', { required: true }) : row.artist,
    credit: 'credit' in body ? cleanSongText(body.credit, CREDIT_MAX, 'credit') : row.credit,
    hidden: 'hidden' in body ? (body.hidden ? 1 : 0) : Number(row.hidden),
    mature: 'mature' in body ? (body.mature ? 1 : 0) : isMature(row) ? 1 : 0,
  };
  const wasMature = isMature(row) ? 1 : 0;
  const timing = {
    duration_ms: Number(row.duration_ms),
    start_ms: 'start_ms' in body ? body.start_ms : Number(row.start_ms),
    end_ms: 'end_ms' in body ? body.end_ms : Number(row.end_ms),
    offset_ms: 'offset_ms' in body ? body.offset_ms : Number(row.offset_ms),
    preview_ms: 'preview_ms' in body ? body.preview_ms : Number(row.preview_ms),
  };
  if (!('preview_ms' in body) && (timing.preview_ms < timing.start_ms || timing.preview_ms >= timing.end_ms)) timing.preview_ms = timing.start_ms;
  const len = checkTiming(timing, Number(row.bytes));
  const charts = 'charts' in body ? checkCharts(body.charts, len) : parseCharts(row.charts);
  const chartText = JSON.stringify(charts);
  const bump = chartText !== row.charts || timing.start_ms !== Number(row.start_ms) || timing.end_ms !== Number(row.end_ms) || timing.offset_ms !== Number(row.offset_ms);
  const cv = Number(row.chart_v) + (bump ? 1 : 0);
  const changed = [];
  for (const k of ['title', 'artist', 'credit']) if (next[k] !== row[k]) changed.push(k);
  if (next.hidden !== Number(row.hidden)) changed.push(next.hidden ? 'hidden' : 'shown');
  if (next.mature !== wasMature) changed.push(next.mature ? 'mature' : 'all_ages');
  if (bump) changed.push('notes');
  const action = songAction(changed, next);
  const summary = SONG_SUMMARY[action](next.title);
  const stmts = [
    env.DB.prepare('UPDATE party_songs SET title = ?, artist = ?, credit = ?, hidden = ?, bpm = ?, offset_ms = ?, start_ms = ?, end_ms = ?, preview_ms = ?, charts = ?, chart_v = ?, counts = ?, updated = ? WHERE id = ?')
      .bind(next.title, next.artist, next.credit, next.hidden, charts.bpm, timing.offset_ms, timing.start_ms, timing.end_ms, timing.preview_ms, chartText, cv, JSON.stringify(chartCounts(charts)), t, id),
  ];
  if (next.mature !== wasMature) stmts.push(env.DB.prepare('INSERT INTO party_song_flags (id, mature) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET mature = excluded.mature').bind(id, next.mature));
  if (changed.length) stmts.push(logModAction(env.DB, { actorId: me, actorName: actorName(session), action, detail: { song: id, title: next.title, changed, summary }, t }));
  await env.DB.batch(stmts);
  if ((next.hidden === 1 && Number(row.hidden) !== 1) || (next.mature === 1 && wasMature !== 1)) await dropAudioCache(url, row);
  return json({ song: songOut(await getSong(env.DB, id)) });
}

async function deleteSong(env, session, role, me, id, t, url) {
  const row = await getSong(env.DB, id);
  if (!row) return fail(404, 'not_found', MISSING_SONG);
  if (role !== 'owner' && row.uploader !== me) return fail(403, 'not_yours', 'Only the owner or the person who uploaded this song can delete it.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO party_song_gone (id, chart_v, gone_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET chart_v = MAX(party_song_gone.chart_v, excluded.chart_v), gone_at = excluded.gone_at').bind(id, Number(row.chart_v) || 1, t),
    env.DB.prepare('DELETE FROM party_song_chunks WHERE owner = ?').bind(id),
    env.DB.prepare('DELETE FROM party_songs WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_song_flags WHERE id = ?').bind(id),
    logModAction(env.DB, { actorId: me, actorName: actorName(session), action: 'song_delete', detail: { song: id, title: row.title, artist: row.artist, summary: `Deleted the Beat Drop song "${row.title}"` }, t }),
  ]);
  await dropAudioCache(url, row);
  return json({ ok: true, usage: usageOut(env, await songUsage(env.DB)) });
}

async function dropAudioCache(url, row) {
  const cache = globalThis.caches && globalThis.caches.default ? globalThis.caches.default : null;
  if (!cache || !url || !row) return;
  await cache.delete(new Request(`${url.origin}${songAudioUrl(row)}`, { method: 'GET' })).catch(() => false);
}

function errorResponse(err) {
  if (err instanceof SongError) return fail(err.status, err.code, err.message);
  throw err;
}

export async function songsRoute(request, env, segs, url, t, { csrf = false } = {}) {
  try {
    return await staffRoute(request, env, segs, t, csrf, url);
  } catch (err) {
    return errorResponse(err);
  }
}

async function staffRoute(request, env, segs, t, csrf, url) {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  if (!read && !MUTATING.has(method)) return nope();
  const session = await getSession(env.DB, request, t);
  if (!session) return fail(401, 'signed_out', 'Please sign in again.');
  if (!read && !csrf) return fail(403, 'forbidden', CSRF_TEXT);
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', STAFF_ONLY);
  const me = lower(session.user_id);
  const all = await hit(env.DB, `songs:u:${me}`, LIMITS.songsStaff, t);
  if (!all.ok) return tooMany(all.retryAfter);
  if (method === 'PUT') {
    const parts = await hit(env.DB, `songparts:u:${me}`, LIMITS.songParts, t);
    if (!parts.ok) return tooMany(parts.retryAfter, 'That is a lot of uploading at once. Wait a minute and try again.');
  } else if (!read) {
    const edits = await hit(env.DB, `songedit:u:${me}`, LIMITS.songEdit, t);
    if (!edits.ok) return tooMany(edits.retryAfter, 'That is a lot of changes at once. Wait a minute and try again.');
  }
  const rest = segs.slice(3);
  const n = rest.length;
  if (n === 0) return read ? listSongs(env, role, t) : nope();
  if (rest[0] === 'uploads') {
    if (n === 1) return method === 'POST' ? beginUpload(request, env, me, t) : nope();
    if (n === 2) return method === 'DELETE' ? cancelUpload(env, me, rest[1], t) : nope();
    if (n === 3 && rest[2] === 'finish') return method === 'POST' ? finishUpload(request, env, session, me, rest[1], t) : nope();
    if (n === 3) return method === 'PUT' ? putPart(request, env, me, rest[1], rest[2], t) : nope();
    return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  }
  if (n === 1 && SONG_ID_RE.test(rest[0])) {
    if (read) return songDetail(env, rest[0]);
    if (method === 'PATCH') return patchSong(request, env, session, role, me, rest[0], t, url);
    if (method === 'DELETE') return deleteSong(env, session, role, me, rest[0], t, url);
    return nope();
  }
  if (n === 1) return fail(404, 'not_found', MISSING_SONG);
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

function publicCache(url, cv) {
  const v = url.searchParams.get('v');
  return v !== null && v === String(cv) ? SONG_AUDIO_CACHE : SONG_LIST_CACHE;
}

export async function activitySongsRoute(request, env, segs, url, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return nope();
  const limit = await hit(env.DB, await ipKey('songs', clientIp(request)), LIMITS.songsPublic, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const n = segs.length;
  if (n === 3) {
    const res = await env.DB.prepare(`SELECT id, title, artist, credit, duration_ms, bpm, chart_v, counts, start_ms, end_ms, preview_ms, ${MATURE_COLUMN} FROM party_songs WHERE hidden = 0 ORDER BY created DESC, id ASC LIMIT ?`).bind(SONG_CAP_COUNT).all();
    const songs = ((res && res.results) || []).map((r) => [r.id, r.title, r.artist, Number(r.duration_ms), Number(r.bpm), Number(r.chart_v), parseCounts(r.counts), r.credit, Number(r.end_ms) - Number(r.start_ms), Math.max(0, Number(r.preview_ms) - Number(r.start_ms)), isMature(r) ? 1 : 0]);
    return json({ songs, diffs: DIFF_IDS }, 200, { 'Cache-Control': SONG_LIST_CACHE });
  }
  const id = segs[3];
  if (!SONG_ID_RE.test(id) || n > 5 || (n === 5 && segs[4] !== 'chart')) return fail(404, 'not_found', MISSING_SONG);
  const row = await getSong(env.DB, id);
  if (!row || hiddenGone(row, t)) return fail(404, 'not_found', MISSING_SONG, null, { 'Cache-Control': SONG_LIST_CACHE });
  const mature = isMature(row);
  if (mature && !(await getActivityUser(env.DB, request, t))) return fail(401, 'signed_out', MATURE_SIGNED_OUT, null, { 'Cache-Control': SONG_PRIVATE_CACHE, Vary: 'Authorization, Cookie' });
  const charts = parseCharts(row.charts);
  const cv = Number(row.chart_v);
  const headers = mature ? { 'Cache-Control': SONG_PRIVATE_CACHE, Vary: 'Authorization, Cookie' } : { 'Cache-Control': publicCache(url, cv) };
  if (n === 5) {
    const d = url.searchParams.get('d') || 'normal';
    if (!DIFF_IDS.includes(d)) return fail(400, 'bad_difficulty', 'That difficulty does not exist.');
    return json({ id, cv, d, bpm: charts.bpm, b0: charts.b0, len: charts.len, marks: charts.marks, notes: charts.d[d], off: Number(row.offset_ms), start: Number(row.start_ms), end: Number(row.end_ms), preview: Number(row.preview_ms), url: songAudioUrl(row), adult: mature }, 200, headers);
  }
  return json({
    id,
    title: row.title,
    artist: row.artist,
    credit: row.credit,
    url: songAudioUrl(row),
    dur: Number(row.duration_ms),
    bpm: Number(row.bpm),
    off: Number(row.offset_ms),
    start: Number(row.start_ms),
    end: Number(row.end_ms),
    preview: Number(row.preview_ms),
    cv,
    adult: mature,
    charts,
  }, 200, headers);
}

function plain(status, text, extra = {}) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60', ...extra } });
}

export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const tail = Number(m[2]);
    if (tail === 0) return 'unsatisfiable';
    return { a: Math.max(0, size - tail), b: size - 1 };
  }
  const a = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < a) return null;
  if (a >= size) return 'unsatisfiable';
  return { a, b: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

function chunkStream(db, id, a, b) {
  let idx = Math.floor(a / SONG_CHUNK);
  const last = Math.floor(b / SONG_CHUNK);
  return new ReadableStream({
    async pull(controller) {
      if (idx > last) {
        controller.close();
        return;
      }
      const row = await db.prepare('SELECT data FROM party_song_chunks WHERE owner = ? AND idx = ?').bind(id, idx).first();
      if (!row) {
        controller.error(new Error('song chunk missing'));
        return;
      }
      const bytes = toBytes(row.data);
      const from = idx === Math.floor(a / SONG_CHUNK) ? a - idx * SONG_CHUNK : 0;
      const to = idx === last ? b - idx * SONG_CHUNK + 1 : bytes.length;
      controller.enqueue(bytes.slice(from, to));
      idx += 1;
    },
  });
}

function sized(stream, length) {
  if (typeof globalThis.FixedLengthStream !== 'function') return stream;
  const fixed = new globalThis.FixedLengthStream(length);
  stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

export async function serveSongAudio(request, env, url, ctx, t = Date.now()) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const m = AUDIO_PATH_RE.exec(url.pathname);
  if (!m || !env.DB) return plain(404, 'Song not found');
  const id = m[1];
  const etag = `"${id}"`;
  const base = { ETag: etag, 'Cache-Control': SONG_AUDIO_CACHE, 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': 'inline' };
  const match = request.headers.get('If-None-Match');
  const rangeHeader = request.headers.get('Range');
  const row = await env.DB.prepare(`SELECT mime, ext, bytes, parts, hidden, updated, ${MATURE_COLUMN} FROM party_songs WHERE id = ?`).bind(id).first().catch(() => null);
  if (!row || row.ext !== m[2] || hiddenGone(row, t)) return plain(404, 'Song not found');
  const mature = isMature(row);
  if (mature) {
    base['Cache-Control'] = SONG_PRIVATE_CACHE;
    base.Vary = 'Authorization, Cookie';
    if (!(await getActivityUser(env.DB, request, t))) return plain(401, MATURE_SIGNED_OUT, { 'Cache-Control': SONG_PRIVATE_CACHE, Vary: 'Authorization, Cookie' });
  }
  const cache = !mature && globalThis.caches && globalThis.caches.default ? globalThis.caches.default : null;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const plainGet = request.method === 'GET' && !rangeHeader;
  if (cache && plainGet && !match) {
    const hitRes = await cache.match(cacheKey).catch(() => null);
    if (hitRes) return hitRes;
  }
  if (match && match.split(',').some((x) => x.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers: base });
  }
  const limit = await hit(env.DB, await ipKey('songaudio', clientIp(request)), LIMITS.songAudio, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const size = Number(row.bytes);
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
  }
  const a = range ? range.a : 0;
  const b = range ? range.b : size - 1;
  const length = b - a + 1;
  const headers = { ...base, 'Content-Type': row.mime, 'Content-Length': String(length) };
  if (range) headers['Content-Range'] = `bytes ${a}-${b}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const res = new Response(sized(chunkStream(env.DB, id, a, b), length), { status, headers });
  if (cache && plainGet && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  }
  return res;
}

export function songCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM party_song_chunks WHERE owner IN (SELECT id FROM party_song_uploads WHERE expires < ?)').bind(t),
    db.prepare('DELETE FROM party_song_uploads WHERE expires < ?').bind(t),
    db.prepare("DELETE FROM party_song_chunks WHERE owner LIKE 'u-%' AND owner NOT IN (SELECT id FROM party_song_uploads)"),
    db.prepare("DELETE FROM party_song_chunks WHERE owner LIKE 's-%' AND owner NOT IN (SELECT id FROM party_songs)"),
  ];
}

