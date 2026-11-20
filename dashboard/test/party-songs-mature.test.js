import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createActivitySession } from '../worker/activity-auth.js';
import { SONG_PRIVATE_CACHE } from '../worker/songs.js';
import { songsHarness, cookies, makeMp3, upload, CAROL } from './song-fixtures.js';

const SIZE = 2000000;

async function withSong() {
  const h = songsHarness();
  const c = await cookies(h);
  const bytes = makeMp3(SIZE);
  const res = await upload(h, c.owner, bytes);
  return { h, c, bytes, id: res.body.song.id, path: res.body.song.url };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const mark = (h, cookie, id, mature) => h.api('PATCH', `/api/party/songs/${id}`, cookie, { mature });
const log = (h) => h.db.raw.prepare("SELECT action, detail FROM party_mod_log WHERE action LIKE 'song_%' ORDER BY created, rowid").all();
const flagRows = (h) => Number(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_song_flags').get().n);

test('the schema adds the 18+ flag in its own side table so old databases only gain a table', () => {
  const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS party_song_flags \(\n  id TEXT PRIMARY KEY,\n  mature INTEGER NOT NULL DEFAULT 0\n\);/);
  assert.doesNotMatch(sql, /ALTER TABLE party_songs/);
});

test('any Party staff member can mark a song 18+, it shows on the shelf and it is logged', async () => {
  const { h, c, id } = await withSong();
  assert.equal((await (await h.api('GET', '/api/party/songs', c.owner)).json()).songs[0].mature, false);
  const on = await mark(h, c.admin2, id, true);
  assert.equal(on.status, 200, 'an admin who did not upload the song can still mark it');
  assert.equal((await on.json()).song.mature, true);
  assert.equal((await (await h.api('GET', '/api/party/songs', c.admin)).json()).songs[0].mature, true);
  assert.equal((await mark(h, c.carol, id, false)).status, 403, 'players who are not staff cannot touch it');
  assert.equal((await mark(h, c.owner, id, 'yes')).status, 400);
  const again = await mark(h, c.owner, id, true);
  assert.equal(again.status, 200);
  const off = await mark(h, c.owner, id, false);
  assert.equal((await off.json()).song.mature, false);
  const rows = log(h);
  assert.deepEqual(rows.map((r) => r.action), ['song_add', 'song_mature', 'song_all_ages'], 'saving the same value twice logs nothing');
  assert.match(JSON.parse(rows[1].detail).summary, /as 18\+/);
  const both = await h.api('PATCH', `/api/party/songs/${id}`, c.owner, { mature: true, title: 'Late Night' });
  assert.equal(both.status, 200);
  assert.equal(log(h).pop().action, 'song_edit', 'a change to more than the flag is a normal edit');
});

test('the public list stays open to everyone and carries the 18+ flag per song', async () => {
  const { h, c, id } = await withSong();
  const before = await h.request('GET', '/api/activity/songs');
  assert.equal((await before.json()).songs[0][10], 0);
  await mark(h, c.owner, id, true);
  const list = await h.request('GET', '/api/activity/songs');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('Cache-Control'), 'public, max-age=60');
  const row = (await list.json()).songs[0];
  assert.equal(row[0], id);
  assert.equal(row[10], 1);
});

test('charts of an 18+ song need a Party sign-in and are never cached publicly', async () => {
  const { h, c, id } = await withSong();
  await mark(h, c.owner, id, true);
  for (const path of [`/api/activity/songs/${id}?v=1`, `/api/activity/songs/${id}/chart?d=normal&v=1`]) {
    const out = await h.request('GET', path);
    assert.equal(out.status, 401, path);
    assert.equal(out.headers.get('Cache-Control'), SONG_PRIVATE_CACHE);
    assert.match((await out.json()).message, /Sign in to YapOS Party/);
    assert.equal((await h.request('GET', path, { headers: bearer('x'.repeat(43)) })).status, 401, 'a made up token does not work');
    const token = await createActivitySession(h.db, CAROL, h.clock.t);
    const viaCode = await h.request('GET', path, { headers: bearer(token) });
    assert.equal(viaCode.status, 200, `${path} with a Party sign-in code session`);
    assert.equal(viaCode.headers.get('Cache-Control'), SONG_PRIVATE_CACHE);
    assert.match(viaCode.headers.get('Vary'), /Authorization/);
    assert.equal((await viaCode.json()).adult, true);
    const viaSite = await h.request('GET', path, { headers: { Cookie: c.carol } });
    assert.equal(viaSite.status, 200, `${path} with a site session`);
  }
  await mark(h, c.owner, id, false);
  const open = await h.request('GET', `/api/activity/songs/${id}?v=1`);
  assert.equal(open.status, 200, 'a song that is fine for everyone needs no sign-in again');
  assert.equal(open.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await open.json()).adult, false);
});

test('audio of an 18+ song needs a Party sign-in, skips the shared cache and keeps ranges working', async () => {
  const { h, c, id, path, bytes } = await withSong();
  const stored = new Map();
  const puts = [];
  const prev = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = stored.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        puts.push(req.url);
        stored.set(req.url, res);
      },
      async delete(req) {
        return stored.delete(req.url);
      },
    },
  };
  try {
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const fetchWith = (headers = {}) => h.worker.fetch(new Request(`${h.base}${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } }), h.env, ctx);
    const open = await fetchWith();
    assert.equal(open.status, 200);
    await Promise.all(waits);
    assert.equal(puts.length, 1, 'songs for everyone still use the shared cache');
    await mark(h, c.owner, id, true);
    assert.equal(stored.size, 0, 'marking a song 18+ drops its shared cache copy');
    stored.set(`${h.base}${path}`, new Response('stale'));
    const out = await fetchWith();
    assert.equal(out.status, 401, 'a cached copy is never handed to someone signed out');
    assert.equal(out.headers.get('Cache-Control'), SONG_PRIVATE_CACHE);
    stored.clear();
    const token = await createActivitySession(h.db, CAROL, h.clock.t);
    const res = await fetchWith(bearer(token));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), SONG_PRIVATE_CACHE);
    assert.match(res.headers.get('Vary'), /Authorization/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    await Promise.all(waits);
    assert.equal(puts.length, 1, 'an 18+ song is never put in the shared cache');
    const part = await fetchWith({ ...bearer(token), Range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.subarray(0, 10));
    const etag = await fetchWith({ 'If-None-Match': `"${id}"` });
    assert.equal(etag.status, 401, 'an ETag check does not skip the sign-in');
    assert.equal((await fetchWith({ Cookie: c.carol })).status, 200);
  } finally {
    globalThis.caches = prev;
  }
});

test('deleting a song removes its 18+ flag too', async () => {
  const { h, c, id } = await withSong();
  await mark(h, c.owner, id, true);
  assert.equal(flagRows(h), 1);
  assert.equal((await h.api('DELETE', `/api/party/songs/${id}`, c.owner)).status, 200);
  assert.equal(flagRows(h), 0);
});
