import { createHash } from 'node:crypto';
import { createHarness, USERS } from './helpers.js';
import { SONG_CHUNK, encodeNotes } from '../web/activity/js/games/beatcodec.js';

export const OWNER = USERS.alice;
export const ADMIN = USERS.bob;
export const CAROL = { id: '55555555-5555-4555-8555-555555555555', username: 'carol', display_name: 'Carol', avatar_url: 'https://files.yapper.website/c.png' };
export const ADMIN2 = { id: '55555555-5555-4555-8555-000000000009', username: 'dana', display_name: 'Dana', avatar_url: 'https://files.yapper.website/d.png' };

export const hex = (buf) => createHash('sha256').update(buf).digest('hex');

export function makeMp3(size, seed = 1) {
  const b = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  b.set([0xff, 0xfb, 0x90, 0x64], 0);
  return b;
}

export function makeOgg(size, seed = 3) {
  const b = makeMp3(size, seed);
  const head = new TextEncoder().encode('OggS');
  b.set(head, 0);
  b.set(new TextEncoder().encode('OpusHead'), 28);
  return b;
}

export function splitParts(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += SONG_CHUNK) out.push(bytes.subarray(i, Math.min(bytes.length, i + SONG_CHUNK)));
  return out;
}

export function wholeHash(bytes) {
  return hex(splitParts(bytes).map((p) => hex(p)).join(''));
}

export function makeCharts(len, { bpm = 120 } = {}) {
  const lane = (i) => i % 4;
  const row = (step, hold = false) => {
    const notes = [];
    let i = 0;
    for (let t = 2000; t <= len - 1000; t += step, i++) {
      const n = { t, l: lane(i) };
      if (hold && i % 10 === 5) n.e = t + 500;
      notes.push(n);
    }
    return encodeNotes(notes);
  };
  return { v: 1, bpm, b0: 500, len, marks: [[8000, 'build'], [16000, 'drop']], d: { easy: row(1000), normal: row(500), hard: row(400, true), expert: row(300, true) } };
}

export function songsHarness(overrides = {}) {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id, ...overrides });
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(ADMIN.id.toLowerCase(), OWNER.id, 1);
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(ADMIN2.id.toLowerCase(), OWNER.id, 1);
  return h;
}

export async function cookies(h) {
  return {
    owner: (await h.login(OWNER)).cookie,
    admin: (await h.login(ADMIN)).cookie,
    admin2: (await h.login(ADMIN2)).cookie,
    carol: (await h.login(CAROL)).cookie,
  };
}

export function putBytes(h, cookie, path, bytes, { type = 'application/octet-stream', origin = h.base } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.7', 'Content-Type': type, 'X-YapOS': '1' });
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('Origin', origin);
  return h.worker.fetch(new Request(`${h.base}${path}`, { method: 'PUT', headers, body: bytes }), h.env, { waitUntil() {} });
}

export async function begin(h, cookie, bytes, extra = {}) {
  const res = await h.api('POST', '/api/party/songs/uploads', cookie, { bytes: bytes.length, parts: splitParts(bytes).length, hash: wholeHash(bytes), ...extra });
  return { status: res.status, body: await res.json() };
}

export function finishBody(extra = {}) {
  const start = extra.start_ms ?? 0;
  const end = extra.end_ms ?? 60000;
  return { title: 'Test Tone', artist: 'Made by me', credit: 'Made by me', rights: true, duration_ms: 60000, bpm: 120, offset_ms: 0, start_ms: start, end_ms: end, preview_ms: start, charts: makeCharts(end - start), ...extra };
}

export async function upload(h, cookie, bytes, extra = {}) {
  const b = await begin(h, cookie, bytes);
  if (b.body.exists) return { status: b.status, body: b.body };
  const uid = b.body.upload;
  const parts = splitParts(bytes);
  for (let i = 0; i < parts.length; i++) {
    const res = await putBytes(h, cookie, `/api/party/songs/uploads/${uid}/${i}`, parts[i]);
    if (res.status !== 200) return { status: res.status, body: await res.json(), uid };
  }
  const res = await h.api('POST', `/api/party/songs/uploads/${uid}/finish`, cookie, finishBody(extra));
  return { status: res.status, body: await res.json(), uid };
}
