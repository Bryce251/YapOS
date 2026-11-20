import { imageHash, toBytes, BADGE_IMG_CACHE } from './custom-badges.js';
import { HttpError } from './util.js';

export const IMAGE_SPLIT_AT = 1536 * 1024;
export const IMAGE_CHUNK_BYTES = 1024 * 1024;
export const IMAGE_CHUNK_KINDS = Object.freeze(['banner', 'avatar']);
export const IMAGE_CHUNK_GRACE = 60 * 60 * 1000;

const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;
const INSERT_SQL = 'INSERT INTO image_chunks (kind, owner_id, version, idx, data, bytes, hash, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, owner_id, version, idx) DO UPDATE SET data = excluded.data, bytes = excluded.bytes, hash = excluded.hash, updated = excluded.updated';
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM image_chunks WHERE kind = ? AND owner_id = ? AND version = ?';
const GUARD_SQL = `SELECT CASE WHEN c.n = ? THEN 1 ELSE json('image parts missing ' || c.n) END AS ok FROM (${COUNT_SQL}) c`;
const LIST_SQL = 'SELECT idx, bytes, hash FROM image_chunks WHERE kind = ? AND owner_id = ? AND version = ? ORDER BY idx';
const READ_SQL = 'SELECT data FROM image_chunks WHERE kind = ? AND owner_id = ? AND version = ? AND idx = ?';

const lower = (v) => String(v ?? '').toLowerCase();

export function needsChunks(bytes) {
  return Boolean(bytes) && bytes.length > IMAGE_SPLIT_AT;
}

export function splitImage(bytes, size = IMAGE_CHUNK_BYTES) {
  const out = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.slice(at, Math.min(bytes.length, at + size)));
  return out;
}

export function clearChunksStatement(db, kind, ownerId) {
  return db.prepare('DELETE FROM image_chunks WHERE kind = ? AND owner_id = ?').bind(kind, lower(ownerId));
}

export function chunkCount(bytes) {
  return needsChunks(bytes) ? Math.ceil(bytes.length / IMAGE_CHUNK_BYTES) : 0;
}

export async function writeChunks(db, kind, ownerId, version, bytes, t) {
  const owner = lower(ownerId);
  const count = chunkCount(bytes);
  for (let i = 0; i < count; i++) {
    const part = bytes.slice(i * IMAGE_CHUNK_BYTES, Math.min(bytes.length, (i + 1) * IMAGE_CHUNK_BYTES));
    await db.prepare(INSERT_SQL).bind(kind, owner, version, i, part, part.length, await imageHash(part), t).run();
  }
  return count;
}

export function commitChunkStatements(db, kind, ownerId, version, count) {
  const owner = lower(ownerId);
  if (!count) return [clearChunksStatement(db, kind, owner)];
  return [
    db.prepare(GUARD_SQL).bind(count, kind, owner, version),
    db.prepare('DELETE FROM image_chunks WHERE kind = ? AND owner_id = ? AND (version <> ? OR idx >= ?)').bind(kind, owner, version, count),
  ];
}

export async function chunkStatements(db, kind, ownerId, version, bytes, t) {
  const count = await writeChunks(db, kind, ownerId, version, bytes, t);
  return { chunked: count > 0, count, stmts: commitChunkStatements(db, kind, ownerId, version, count) };
}

export async function chunksReady(db, kind, ownerId, version, count) {
  const row = await db.prepare(COUNT_SQL).bind(kind, lower(ownerId), version).first().catch(() => null);
  return Boolean(row) && Number(row.n) === count;
}

export async function commitChunked(db, parts, kind, ownerId, version, stmts) {
  try {
    return await db.batch(stmts);
  } catch (err) {
    if (parts.chunked && !(await chunksReady(db, kind, ownerId, version, parts.count))) {
      throw new HttpError(409, 'image_changed', 'Your picture changed in another tab while this one was uploading. Try again.');
    }
    throw err;
  }
}

export function chunkCleanupStatements(db, t = Date.now()) {
  const before = t - IMAGE_CHUNK_GRACE;
  return [
    db.prepare("DELETE FROM image_chunks WHERE kind = 'banner' AND updated < ? AND NOT EXISTS (SELECT 1 FROM profile_banners b WHERE b.user_id = image_chunks.owner_id AND b.hash = image_chunks.version)").bind(before),
    db.prepare("DELETE FROM image_chunks WHERE kind = 'avatar' AND updated < ? AND NOT EXISTS (SELECT 1 FROM profile_avatars a WHERE a.user_id = image_chunks.owner_id AND a.hash = image_chunks.version)").bind(before),
    db.prepare(`DELETE FROM image_chunks WHERE kind NOT IN (${IMAGE_CHUNK_KINDS.map(() => '?').join(', ')})`).bind(...IMAGE_CHUNK_KINDS),
  ];
}

export async function chunkList(db, kind, ownerId, version) {
  const res = await db.prepare(LIST_SQL).bind(kind, lower(ownerId), version).all().catch(() => null);
  const rows = (res && res.results) || [];
  if (!rows.length) return null;
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const size = Number(rows[i].bytes);
    if (Number(rows[i].idx) !== i || !Number.isInteger(size) || size < 1 || size > IMAGE_CHUNK_BYTES) return { broken: true, rows, total: 0 };
    total += size;
  }
  return { broken: false, rows, total };
}

export async function readChunk(db, kind, ownerId, version, row) {
  const got = await db.prepare(READ_SQL).bind(kind, lower(ownerId), version, Number(row.idx)).first().catch(() => null);
  if (!got) return null;
  const bytes = toBytes(got.data);
  if (bytes.length !== Number(row.bytes) || (await imageHash(bytes)) !== row.hash) return null;
  return bytes;
}

export async function readWholeImage(db, kind, ownerId, version, legacy) {
  const list = await chunkList(db, kind, ownerId, version);
  if (!list) return toBytes(legacy);
  if (list.broken) return null;
  const out = new Uint8Array(list.total);
  let at = 0;
  for (const row of list.rows) {
    const part = await readChunk(db, kind, ownerId, version, row);
    if (!part) return null;
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function quoted(version) {
  return `"${version}"`;
}

function matchesTag(header, tag) {
  if (!header) return false;
  return String(header)
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((s) => s === '*' || s === tag);
}

export function readRange(header, total) {
  if (!header) return null;
  const m = RANGE_RE.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n || !total) return { unsatisfiable: true };
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= total) return { unsatisfiable: true };
  const end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  return { start, end };
}

function baseHeaders(mime, tag) {
  return {
    'Content-Type': mime,
    'Cache-Control': BADGE_IMG_CACHE,
    'Content-Disposition': 'inline',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': 'bytes',
    ETag: tag,
  };
}

function sized(stream, length) {
  if (typeof FixedLengthStream !== 'function') return stream;
  const fixed = new FixedLengthStream(length);
  stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

function chunkStream(parts, first, load, start, end) {
  const offsets = [];
  let o = 0;
  for (const p of parts) {
    offsets.push(o);
    o += Number(p.bytes);
  }
  let i = 0;
  while (i < parts.length && offsets[i] + Number(parts[i].bytes) <= start) i++;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length || offsets[i] > end) {
        controller.close();
        return;
      }
      const data = i === 0 ? first : await load(parts[i]);
      if (!data) {
        controller.error(new Error('Picture part missing'));
        return;
      }
      const from = Math.max(0, start - offsets[i]);
      const to = Math.min(data.length, end + 1 - offsets[i]);
      controller.enqueue(data.slice(from, to));
      i += 1;
    },
  });
}

export function imageResponse(request, { mime, version, total, whole = null, parts = null, first = null, load = null }) {
  const tag = quoted(version);
  const headers = baseHeaders(mime, tag);
  if (matchesTag(request.headers.get('If-None-Match'), tag)) {
    return new Response(null, { status: 304, headers: { ETag: tag, 'Cache-Control': BADGE_IMG_CACHE } });
  }
  const ifRange = request.headers.get('If-Range');
  const range = ifRange && ifRange.trim() !== tag ? null : readRange(request.headers.get('Range'), total);
  if (range && range.unsatisfiable) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${total}`, 'Content-Length': '0' } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const length = end - start + 1;
  const out = { ...headers, 'Content-Length': String(length) };
  if (range) out['Content-Range'] = `bytes ${start}-${end}/${total}`;
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers: out });
  if (whole) return new Response(range ? whole.slice(start, end + 1) : whole, { status, headers: out });
  return new Response(sized(chunkStream(parts, first, load, start, end), length), { status, headers: out });
}

export async function storedImageResponse(request, db, { kind, ownerId, version, image, mime, size, cap, sniff }) {
  const list = kind ? await chunkList(db, kind, ownerId, version) : null;
  if (list) {
    if (list.broken || list.total !== Number(size)) return null;
    const first = await readChunk(db, kind, ownerId, version, list.rows[0]);
    if (!first || sniff(first) !== mime || list.total > cap(first)) return null;
    return imageResponse(request, { mime, version, total: list.total, parts: list.rows, first, load: (row) => readChunk(db, kind, ownerId, version, row) });
  }
  const bytes = toBytes(image);
  if (!bytes.length || sniff(bytes) !== mime || bytes.length > cap(bytes)) return null;
  return imageResponse(request, { mime, version, total: bytes.length, whole: bytes });
}
