import { SONG_CHUNK, SONG_MAX_BYTES, SONG_MAX_PARTS, hexOf } from '../activity/js/games/beatcodec.js';
import { ApiError, errorMessage, defaultSleep } from './api.js';

export const SONGS_PATH = '/api/party/songs';
export const UPLOADS_PATH = `${SONGS_PATH}/uploads`;
export const PART_RETRIES = 3;
export const SONG_EXT_RE = /\.(mp3|ogg|m4a)$/i;
export const SONG_ACCEPT = '.mp3,.ogg,.m4a,audio/mpeg,audio/ogg,audio/mp4';
export const TOO_BIG = `Songs can be up to ${SONG_MAX_BYTES / 1048576} MB. Try a smaller MP3.`;
export const WRONG_KIND = 'Pick an MP3, OGG or M4A song.';
export const ALREADY = 'This song is already on the shelf.';

export function fileProblem(file) {
  if (!file) return 'Pick a song file first.';
  if (!SONG_EXT_RE.test(String(file.name || ''))) return WRONG_KIND;
  if (!(file.size > 0)) return 'That file is empty.';
  if (file.size > SONG_MAX_BYTES) return TOO_BIG;
  return '';
}

const subtle = () => globalThis.crypto && globalThis.crypto.subtle;

export async function hashParts(buf, digest = (b) => subtle().digest('SHA-256', b)) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parts = [];
  const hashes = [];
  for (let i = 0; i < bytes.length; i += SONG_CHUNK) {
    const part = bytes.slice(i, Math.min(bytes.length, i + SONG_CHUNK));
    parts.push(part);
    hashes.push(hexOf(await digest(part)));
  }
  const whole = hexOf(await digest(new TextEncoder().encode(hashes.join(''))));
  return { parts, hashes, whole };
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function putPart({ fetchImpl, sleep = defaultSleep, url, part, hash, retries = PART_RETRIES, signal }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1), signal);
    let res;
    try {
      res = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-YapOS': '1' }, body: part, credentials: 'same-origin', cache: 'no-store', signal });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastError = new ApiError("Can't reach the dashboard. Check your connection and try again.", { code: 'network' });
      continue;
    }
    const data = await readJsonSafe(res);
    if (res.ok && data && data.hash === hash) return data;
    if (res.ok) {
      lastError = new ApiError('A piece of the song arrived broken. Try again.', { code: 'bad_hash' });
      continue;
    }
    lastError = new ApiError(errorMessage(res.status, data), { status: res.status, code: data && data.error, data });
    if (res.status !== 429 && res.status !== 408 && res.status < 500) throw lastError;
  }
  throw lastError;
}

export async function uploadSong({ buf, meta, api, fetchImpl = (...a) => globalThis.fetch(...a), sleep = defaultSleep, digest, onProgress = () => {}, signal } = {}) {
  const { parts, hashes, whole } = await hashParts(buf, digest);
  if (parts.length > SONG_MAX_PARTS) throw new ApiError(TOO_BIG, { code: 'too_large' });
  onProgress({ step: 'begin', done: 0, of: parts.length });
  const begun = await api.post(UPLOADS_PATH, { bytes: parts.reduce((s, p) => s + p.length, 0), parts: parts.length, hash: whole }, { signal });
  if (begun && begun.exists) return { exists: begun.exists };
  const upload = begun.upload;
  const have = new Map((Array.isArray(begun.have) ? begun.have : []).map((x) => [x.idx, x.hash]));
  for (let i = 0; i < parts.length; i++) {
    if (have.get(i) !== hashes[i]) {
      await putPart({ fetchImpl, sleep, url: `${UPLOADS_PATH}/${encodeURIComponent(upload)}/${i}`, part: parts[i], hash: hashes[i], signal });
    }
    onProgress({ step: 'part', done: i + 1, of: parts.length });
  }
  onProgress({ step: 'finish', done: parts.length, of: parts.length });
  const done = await api.post(`${UPLOADS_PATH}/${encodeURIComponent(upload)}/finish`, meta, { signal });
  if (done && done.exists) return { exists: done.exists };
  return { song: done.song, upload };
}

export function cancelUpload(api, upload) {
  return api.request('DELETE', `${UPLOADS_PATH}/${encodeURIComponent(upload)}`).catch(() => null);
}

export function formatMb(bytes) {
  const mb = bytes / 1048576;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

export function usageText(u) {
  if (!u) return '';
  return `${u.count} of ${u.capCount} songs, ${formatMb(u.bytes)} of ${formatMb(u.capBytes)}`;
}

export function formatLength(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
