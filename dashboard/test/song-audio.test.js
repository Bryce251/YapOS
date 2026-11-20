import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../worker/songs.js';
import { BADGE_IMG_CSP, CSP, ACTIVITY_CSP } from '../worker/security.js';
import { songsHarness, cookies, makeMp3, upload, begin, putBytes, splitParts } from './song-fixtures.js';

const SIZE = 2000000;

async function withSong() {
  const h = songsHarness();
  const c = await cookies(h);
  const bytes = makeMp3(SIZE);
  const res = await upload(h, c.owner, bytes);
  return { h, c, bytes, id: res.body.song.id, path: res.body.song.url };
}

const get = (h, path, headers = {}, method = 'GET') => h.request(method, path, { headers });
const bodyOf = async (res) => new Uint8Array(await res.arrayBuffer());

test('the whole song comes back with safe, long lived headers', async () => {
  const { h, bytes, path, id } = await withSong();
  const res = await get(h, path);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(res.headers.get('Content-Length'), String(SIZE));
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('Content-Security-Policy'), BADGE_IMG_CSP);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(res.headers.get('ETag'), `"${id}"`);
  assert.deepEqual(await bodyOf(res), bytes);
});

test('HEAD has no body and a matching ETag gets a 304', async () => {
  const { h, path, id } = await withSong();
  const head = await get(h, path, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(SIZE));
  assert.equal((await bodyOf(head)).length, 0);
  const same = await get(h, path, { 'If-None-Match': `"${id}"` });
  assert.equal(same.status, 304);
  assert.equal((await bodyOf(same)).length, 0);
});

test('byte ranges return the exact bytes', async () => {
  const { h, bytes, path } = await withSong();
  const r1 = await get(h, path, { Range: 'bytes=0-99' });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('Content-Range'), `bytes 0-99/${SIZE}`);
  assert.equal(r1.headers.get('Content-Length'), '100');
  assert.deepEqual(await bodyOf(r1), bytes.subarray(0, 100));
  const cross = await get(h, path, { Range: 'bytes=1499900-1500099' });
  assert.equal(cross.status, 206);
  assert.deepEqual(await bodyOf(cross), bytes.subarray(1499900, 1500100));
  const tail = await get(h, path, { Range: 'bytes=-500' });
  assert.equal(tail.headers.get('Content-Range'), `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
  assert.deepEqual(await bodyOf(tail), bytes.subarray(SIZE - 500));
  const open = await get(h, path, { Range: 'bytes=1499990-' });
  assert.deepEqual(await bodyOf(open), bytes.subarray(1499990));
  const multi = await get(h, path, { Range: 'bytes=0-1, 5-6' });
  assert.equal(multi.status, 200);
  assert.equal((await bodyOf(multi)).length, SIZE);
  const out = await get(h, path, { Range: `bytes=${SIZE}-` });
  assert.equal(out.status, 416);
  assert.equal(out.headers.get('Content-Range'), `bytes */${SIZE}`);
});

test('the range parser handles the odd cases', () => {
  assert.equal(parseRange(null, 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.deepEqual(parseRange('bytes=-50', 10), { a: 0, b: 9 });
  assert.deepEqual(parseRange('bytes=2-50', 10), { a: 2, b: 9 });
});

test('bad ids, wrong extensions, deleted songs and posts are refused', async () => {
  const { h, c, path, id } = await withSong();
  assert.equal((await get(h, '/song-audio/s-0000000000000000.mp3')).status, 404);
  assert.equal((await get(h, `/song-audio/${id}.ogg`)).status, 404);
  assert.equal((await get(h, `/song-audio/${id}.wav`)).status, 404);
  assert.equal((await get(h, '/song-audio/../config.json')).status, 404);
  const post = await h.request('POST', path, { body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  await h.api('DELETE', `/api/party/songs/${id}`, c.owner);
  assert.equal((await get(h, path)).status, 404);
});

test('half uploaded songs are never served', async () => {
  const h = songsHarness();
  const c = await cookies(h);
  const bytes = makeMp3(SIZE, 4);
  const b = await begin(h, c.owner, bytes);
  await putBytes(h, c.owner, `/api/party/songs/uploads/${b.body.upload}/0`, splitParts(bytes)[0]);
  assert.equal((await get(h, `/song-audio/${b.body.upload}.mp3`)).status, 404);
});

test('site and activity CSP strings are unchanged and only the audio path gets the sandbox', async () => {
  assert.equal(CSP, "default-src 'self'; img-src 'self' https://files.yapper.website https://www.yapin.gg data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.match(ACTIVITY_CSP, /^default-src 'self';/);
  const { h } = await withSong();
  const list = await h.request('GET', '/api/activity/songs');
  assert.equal(list.headers.get('Content-Security-Policy'), CSP);
  const page = await h.request('GET', '/party/songs');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Content-Security-Policy'), CSP);
});
