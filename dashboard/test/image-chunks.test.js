import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createHarness, advance, USERS } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { makeGif } from './motion-fixtures.js';
import { cleanup } from '../worker/cron.js';
import { BADGE_IMG_CSP } from '../worker/security.js';
import { decodeAnimated, resetPlan, BANNER_BODY_LIMIT, BANNER_MAX, STILL_MAX } from '../worker/profile-custom.js';
import { decodeAvatarMoving, AVATAR_BODY_LIMIT } from '../worker/avatars.js';
import { fromBase64 } from '../worker/custom-badges.js';
import { defaultLook } from '../web/js/profile-look.js';
import { IMAGE_SPLIT_AT, IMAGE_CHUNK_BYTES, IMAGE_CHUNK_GRACE, splitImage, readRange, readWholeImage } from '../worker/image-chunks.js';
import { ANIM_MAX_BYTES, ANIM_MAX_PIXELS, ANIM_MAX_FRAMES, sizeText } from '../web/js/banner-anim.js';
import { AVATAR_ANIM_MAX, AVATAR_FILE_MAX, AVATAR_STILL_MAX, AVATAR_FRAME_MAX } from '../web/js/avatar-rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALICE = USERS.alice;
const BANNER = '/api/me/profile-banner';
const AVATAR = '/api/me/profile-avatar';
const MB = 1024 * 1024;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const shortHash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function gifSize(head, frames, p) {
  const blocks = (n) => n + Math.ceil(n / 255) + 1;
  return head + frames * (8 + 10 + 1) + (frames - 1) * blocks(p.base) + blocks(p.last) + 1;
}

function bigGif(target, { width = 600, height = 200, frames = 4, seed = 1 } = {}) {
  const head = 13 + 6 + 19;
  let base = Math.floor(((target - head - frames * 20) * 255) / 256 / frames);
  let last = base;
  for (let i = 0; i < 64 && gifSize(head, frames, { base, last }) !== target; i++) {
    const diff = target - gifSize(head, frames, { base, last });
    last += diff > 0 ? Math.max(1, Math.floor((diff * 255) / 256)) : Math.min(-1, Math.ceil((diff * 255) / 256));
  }
  const total = gifSize(head, frames, { base, last });
  const out = new Uint8Array(total);
  let i = 0;
  const put = (...xs) => {
    for (const x of xs) out[i++] = x;
  };
  put(...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0xf0, 0, 0);
  put(0, 0, 0, 255, 255, 255);
  put(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  let s = seed * 2654435761;
  for (let f = 0; f < frames; f++) {
    put(0x21, 0xf9, 4, 0x04, 8, 0, 0, 0);
    put(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0);
    put(8);
    let left = f === frames - 1 ? last : base;
    while (left > 0) {
      const n = Math.min(255, left);
      out[i++] = n;
      for (let k = 0; k < n; k++) {
        s = (s * 1103515245 + 12345) >>> 0;
        out[i++] = s >>> 24;
      }
      left -= n;
    }
    put(0);
  }
  put(0x3b);
  assert.equal(i, total);
  return out;
}

function seedPublic(h, user) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 5, 400, NULL, '[]', '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(user.id.toLowerCase(), user.username, user.username.toLowerCase(), user.display_name, h.clock.t);
}

async function setup() {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  return { h, alice };
}

const chunkRows = (h, kind) => h.db.raw.prepare('SELECT owner_id, version, idx, bytes, hash, length(data) AS len FROM image_chunks WHERE kind = ? ORDER BY version, idx').all(kind);

test('limits: banners up to 10 MB, profile pictures up to 5 MB, and the size text reads plainly', () => {
  assert.equal(ANIM_MAX_BYTES, 10 * MB);
  assert.equal(AVATAR_ANIM_MAX, 5 * MB);
  assert.equal(AVATAR_FILE_MAX, 5 * MB);
  assert.equal(AVATAR_STILL_MAX, 600 * 1024);
  assert.equal(AVATAR_FRAME_MAX, 200 * 1024);
  assert.equal(BANNER_MAX, 1536 * 1024);
  assert.ok(BANNER_MAX <= IMAGE_SPLIT_AT && AVATAR_STILL_MAX <= IMAGE_SPLIT_AT && STILL_MAX <= IMAGE_SPLIT_AT, 'still pictures always fit one row');
  assert.ok(IMAGE_CHUNK_BYTES < 2_000_000 && IMAGE_SPLIT_AT < 2_000_000, 'every row stays under the 2 MB D1 row limit');
  assert.ok(BANNER_BODY_LIMIT >= Math.ceil(((ANIM_MAX_BYTES + STILL_MAX) * 4) / 3));
  assert.ok(AVATAR_BODY_LIMIT >= Math.ceil(((AVATAR_ANIM_MAX + AVATAR_FRAME_MAX) * 4) / 3));
  assert.equal(sizeText(10 * MB), '10 MB');
  assert.equal(sizeText(5 * MB), '5 MB');
  assert.equal(sizeText(1536 * 1024), '1.5 MB');
  assert.equal(sizeText(600 * 1024), '600 KB');
  const editor = readFileSync(path.join(here, '..', 'web', 'js', 'pages', 'profile-editor.js'), 'utf8');
  const avatarEditor = readFileSync(path.join(here, '..', 'web', 'js', 'pages', 'avatar-editor.js'), 'utf8');
  assert.match(editor, /PNG, JPG, WebP or GIF up to \$\{sizeText\(BANNER_FILE_MAX\)\}\. Moving GIFs and animated WebPs up to \$\{sizeText\(ANIM_MAX_BYTES\)\} keep moving/);
  assert.match(avatarEditor, /PNG, JPG, WebP or GIF up to \$\{sizeText\(AVATAR_FILE_MAX\)\}\. .* Moving GIFs and animated WebPs up to \$\{sizeText\(AVATAR_ANIM_MAX\)\} keep moving/);
  assert.doesNotMatch(editor + avatarEditor, /900 KB|15 MB/);
});

test('server size checks: just under 10 MB and 5 MB pass, just over is refused', () => {
  const under = bigGif(10 * MB - 10);
  assert.equal(under.length, 10 * MB - 10);
  assert.equal(decodeAnimated(b64(under)).bytes.length, under.length);
  const exact = bigGif(10 * MB);
  assert.equal(decodeAnimated(b64(exact)).frames, 4);
  assert.throws(() => decodeAnimated(b64(bigGif(10 * MB + 1))), (e) => e.status === 413 && /Keep it under 10 MB/.test(e.message));
  const pic = bigGif(5 * MB, { width: 200, height: 200 });
  assert.equal(decodeAvatarMoving(b64(pic)).bytes.length, 5 * MB);
  assert.throws(() => decodeAvatarMoving(b64(bigGif(5 * MB + 1, { width: 200, height: 200 }))), (e) => e.status === 413 && /Keep it under 5 MB/.test(e.message));
});

test('a 10 MB moving banner is stored in parts with hashes and comes back byte for byte, with ETag and ranges', async () => {
  const { h, alice } = await setup();
  const gif = bigGif(10 * MB - 4096);
  const res = await h.api('POST', BANNER, alice, { image: b64(gif), still: b64(devBannerPng(600, 200)) });
  assert.equal(res.status, 201, await res.clone().text());
  const { banner } = await res.json();
  assert.equal(banner.animated, true);
  assert.equal(banner.bytes, gif.length);
  const hash = shortHash(gif);
  assert.ok(banner.url.endsWith(`-${hash}.gif`), 'the link carries the content hash, so it changes per version');
  const row = h.db.raw.prepare('SELECT length(image) AS len, bytes, hash FROM profile_banners').get();
  assert.equal(row.len, 0, 'the big picture is not kept in the single row');
  assert.equal(row.bytes, gif.length);
  const parts = chunkRows(h, 'banner');
  assert.equal(parts.length, Math.ceil(gif.length / IMAGE_CHUNK_BYTES));
  assert.ok(parts.every((p, i) => p.idx === i && p.version === hash && p.len === p.bytes && p.len <= IMAGE_CHUNK_BYTES));
  const pieces = splitImage(gif);
  assert.ok(parts.every((p, i) => p.hash === shortHash(pieces[i])), 'each part has its own content hash');
  const whole = await h.request('GET', banner.url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Content-Type'), 'image/gif');
  assert.equal(whole.headers.get('Content-Length'), String(gif.length));
  assert.equal(whole.headers.get('ETag'), `"${hash}"`);
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.match(whole.headers.get('Cache-Control'), /immutable/);
  assert.equal(whole.headers.get('Content-Security-Policy'), BADGE_IMG_CSP);
  assert.equal(whole.headers.get('X-Content-Type-Options'), 'nosniff');
  const got = new Uint8Array(await whole.arrayBuffer());
  assert.equal(got.length, gif.length);
  assert.ok(Buffer.from(got).equals(Buffer.from(gif)), 'every byte comes back in order');
  assert.equal(shortHash(got), hash);
  const same = await h.request('GET', banner.url, { headers: { 'If-None-Match': `"${hash}"` } });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('ETag'), `"${hash}"`);
  const from = IMAGE_CHUNK_BYTES - 6;
  const span = await h.request('GET', banner.url, { headers: { Range: `bytes=${from}-${from + 15}` } });
  assert.equal(span.status, 206);
  assert.equal(span.headers.get('Content-Range'), `bytes ${from}-${from + 15}/${gif.length}`);
  assert.equal(span.headers.get('Content-Length'), '16');
  assert.ok(Buffer.from(await span.arrayBuffer()).equals(Buffer.from(gif.subarray(from, from + 16))), 'a range across two parts is joined');
  const tail = await h.request('GET', banner.url, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(Buffer.from(gif.subarray(gif.length - 10))));
  const open = await h.request('GET', banner.url, { headers: { Range: `bytes=${gif.length - 3}-` } });
  assert.equal((await open.arrayBuffer()).byteLength, 3);
  const past = await h.request('GET', banner.url, { headers: { Range: `bytes=${gif.length}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${gif.length}`);
  const stale = await h.request('GET', banner.url, { headers: { Range: 'bytes=0-9', 'If-Range': '"0000000000000000"' } });
  assert.equal(stale.status, 200, 'a stale If-Range gets the whole picture');
  await stale.arrayBuffer();
  const head = await h.request('HEAD', banner.url);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(gif.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const back = await readWholeImage(h.db, 'banner', ALICE.id, hash, null);
  assert.equal(shortHash(back), hash);
  const motion = (await (await h.request('GET', '/api/u/alice', { ip: '198.51.100.40' })).json());
  assert.ok(JSON.stringify(motion).includes(banner.motion.still), 'the profile carries the small still for reduced motion');
});

test('a 5 MB moving profile picture is stored in parts and lists keep using the small still', async () => {
  const { h, alice } = await setup();
  const gif = bigGif(5 * MB - 100, { width: 200, height: 200, frames: 3, seed: 7 });
  const res = await h.api('POST', AVATAR, alice, { image: b64(gif), still: b64(devBannerPng(128, 128)) });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.equal(body.custom.animated, true);
  assert.equal(body.custom.bytes, gif.length);
  assert.ok(body.custom.still && body.custom.still !== body.custom.url);
  const parts = chunkRows(h, 'avatar');
  assert.equal(parts.length, 5);
  assert.equal(h.db.raw.prepare('SELECT length(image) AS len FROM profile_avatars').get().len, 0);
  const pic = await h.request('GET', body.custom.url);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('Content-Type'), 'image/gif');
  assert.ok(Buffer.from(await pic.arrayBuffer()).equals(Buffer.from(gif)));
  const still = await h.request('GET', body.custom.still);
  assert.equal(still.status, 200);
  assert.ok(Number(still.headers.get('Content-Length')) <= AVATAR_FRAME_MAX, 'lists get the small still frame');
  h.db.raw.prepare("INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, 'Alice', 'alice', 500, 3, 1, 200, 'trivia', ?)").run(ALICE.id, h.clock.t);
  const board = await (await h.request('GET', '/api/activity/leaderboard', { ip: '198.51.100.41' })).json();
  assert.equal(board.rows[0].avatarStill, body.custom.still);
  const over = bigGif(5 * MB + 1, { width: 200, height: 200, frames: 3 });
  advance(h, 61_000);
  assert.equal((await h.api('POST', AVATAR, alice, { image: b64(over), still: b64(devBannerPng(128, 128)) })).status, 413);
  advance(h, 61_000);
  const gone = await h.api('DELETE', AVATAR, alice);
  assert.equal(gone.status, 200);
  assert.equal(chunkRows(h, 'avatar').length, 0, 'removing the picture removes its parts');
  assert.equal((await h.request('GET', body.custom.url)).status, 404);
});

test('replacing a banner removes the old parts, a still banner keeps one row, and deleting removes everything', async () => {
  const { h, alice } = await setup();
  const first = bigGif(3 * MB, { seed: 2 });
  const one = (await (await h.api('POST', BANNER, alice, { image: b64(first), still: b64(devBannerPng(600, 200)) })).json()).banner;
  assert.equal(chunkRows(h, 'banner').length, 3);
  advance(h, 61_000);
  const second = bigGif(2 * MB + 5, { seed: 3 });
  const two = (await (await h.api('POST', BANNER, alice, { image: b64(second), still: b64(devBannerPng(600, 200)) })).json()).banner;
  const rows = chunkRows(h, 'banner');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.version === shortHash(second)), 'only the new version is kept');
  assert.equal((await h.request('GET', one.url)).status, 404, 'the old link stops working');
  assert.equal((await h.request('GET', two.url)).status, 200);
  advance(h, 61_000);
  const small = bigGif(IMAGE_SPLIT_AT - 10, { seed: 4 });
  const three = (await (await h.api('POST', BANNER, alice, { image: b64(small), still: b64(devBannerPng(600, 200)) })).json()).banner;
  assert.equal(chunkRows(h, 'banner').length, 0, 'a picture under the split size lives in its single row');
  assert.equal(h.db.raw.prepare('SELECT length(image) AS len FROM profile_banners').get().len, small.length);
  const served = await h.request('GET', three.url);
  assert.equal(served.headers.get('ETag'), `"${shortHash(small)}"`);
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(small)));
  advance(h, 61_000);
  const again = (await (await h.api('POST', BANNER, alice, { image: b64(first), still: b64(devBannerPng(600, 200)) })).json()).banner;
  assert.equal(chunkRows(h, 'banner').length, 3);
  advance(h, 61_000);
  assert.equal((await h.api('DELETE', BANNER, alice)).status, 200);
  assert.equal(chunkRows(h, 'banner').length, 0);
  assert.equal((await h.request('GET', again.url)).status, 404);
});

test('cleanup removes leftover parts, keeps live ones, and broken parts are never served', async () => {
  const { h, alice } = await setup();
  const gif = bigGif(2 * MB, { seed: 5 });
  const banner = (await (await h.api('POST', BANNER, alice, { image: b64(gif), still: b64(devBannerPng(600, 200)) })).json()).banner;
  const add = h.db.raw.prepare('INSERT INTO image_chunks (kind, owner_id, version, idx, data, bytes, hash, updated) VALUES (?, ?, ?, 0, ?, 3, ?, 0)');
  add.run('banner', ALICE.id.toLowerCase(), '0123456789abcdef', Buffer.from([1, 2, 3]), shortHash(Buffer.from([1, 2, 3])));
  add.run('avatar', 'nobody', 'fedcba9876543210', Buffer.from([1, 2, 3]), shortHash(Buffer.from([1, 2, 3])));
  add.run('mystery', 'nobody', 'fedcba9876543210', Buffer.from([1, 2, 3]), shortHash(Buffer.from([1, 2, 3])));
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.imageChunks, 3);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM image_chunks').get().n, 2, 'the live banner keeps its parts');
  assert.equal((await h.request('GET', banner.url)).status, 200);
  h.db.raw.prepare("UPDATE image_chunks SET data = zeroblob(bytes) WHERE idx = 1").run();
  const bad = await h.request('GET', banner.url, { headers: { Range: `bytes=${IMAGE_CHUNK_BYTES}-${IMAGE_CHUNK_BYTES + 9}` } });
  await assert.rejects(bad.arrayBuffer(), 'a part whose hash does not match is not sent');
  h.db.raw.prepare('DELETE FROM image_chunks WHERE idx = 1').run();
  assert.equal((await h.request('GET', banner.url)).status, 404, 'a missing part means no picture rather than a cut-off one');
});

test('older banners and pictures kept in a single row are still served, with ETag and ranges', async () => {
  const { h } = await setup();
  const gif = makeGif({ width: 600, height: 200, frames: 3 });
  const hash = shortHash(gif);
  h.db.raw.prepare('INSERT INTO profile_banners (user_id, id, image, mime, hash, width, height, bytes, updated) VALUES (?, ?, ?, ?, ?, 600, 200, ?, 0)').run(ALICE.id.toLowerCase(), 'b-legacy0001', gif, 'image/gif', hash, gif.length);
  const url = `/banner-img/b-legacy0001-${hash}.gif`;
  const res = await h.request('GET', url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), `"${hash}"`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(gif)));
  const part = await h.request('GET', url, { headers: { Range: 'bytes=0-5' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString('ascii'), 'GIF89a');
  const png = devBannerPng(128, 128);
  const phash = shortHash(png);
  h.db.raw.prepare('INSERT INTO profile_avatars (user_id, id, image, mime, hash, width, height, bytes, frames, updated) VALUES (?, ?, ?, ?, ?, 128, 128, ?, 1, 0)').run(ALICE.id.toLowerCase(), 'a-legacy0001', png, 'image/png', phash, png.length);
  const pic = await h.request('GET', `/avatar-img/a-legacy0001-${phash}.png`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('Content-Type'), 'image/png');
  assert.ok(Buffer.from(await pic.arrayBuffer()).equals(Buffer.from(png)));
});

test('big animations cannot be decompression bombs: frame, pixel and hidden data limits still hold at 10 MB', () => {
  const err = (fn, want) => assert.throws(fn, (e) => e.status === 400 && e.code === want, want);
  err(() => decodeAnimated(b64(bigGif(4 * MB, { width: 3000, height: 1000, frames: Math.ceil(ANIM_MAX_PIXELS / 3_000_000) + 1 }))), 'too_many_frames');
  err(() => decodeAnimated(b64(makeGif({ width: 300, height: 100, frames: ANIM_MAX_FRAMES + 1 }))), 'too_many_frames');
  err(() => decodeAnimated(b64(bigGif(4 * MB, { width: 3200, height: 1000, frames: 2 }))), 'bad_image_size');
  err(() => decodeAvatarMoving(b64(bigGif(4 * MB, { width: 1024, height: 1024, frames: 150 }))), 'too_many_frames');
  const hidden = bigGif(2 * MB, { seed: 9 });
  const tailed = new Uint8Array(hidden.length + 100);
  tailed.set(hidden);
  tailed.fill(7, hidden.length);
  err(() => decodeAnimated(b64(tailed)), 'bad_image');
  const outside = bigGif(2 * MB, { width: 600, height: 200 });
  outside[6] = 0;
  err(() => decodeAnimated(b64(outside)), 'bad_image');
});

test('only big faces animate by default: small avatars in lists and menus use the still', async () => {
  const { installDom } = await import('./dom-shim.js');
  installDom({ url: 'https://dash.example.test/' });
  const { avatar } = await import('../web/js/ui.js');
  const url = '/avatar-img/a-abcdefghij-0123456789abcdef.gif';
  const still = '/avatar-img/a-abcdefghij-fedcba9876543210-still.webp';
  for (const size of ['xs', 'sm', 'md']) assert.equal(avatar({ name: 'Bea', url, still, id: 'x', size }).querySelector('img').src, still, size);
  for (const size of ['lg', 'xl']) {
    const el = avatar({ name: 'Bea', url, still, id: 'x', size });
    assert.equal(el.querySelector('img').src, url, size);
    assert.equal(el.querySelector('source').getAttribute('srcset'), still, 'reduced motion gets the still');
  }
  assert.equal(avatar({ name: 'Bea', url, still, id: 'x', size: 'sm', animate: true }).querySelector('img').src, url);
  const shell = readFileSync(path.join(here, '..', 'web', 'js', 'shell.js'), 'utf8');
  assert.equal(shell.split("still: user.avatar_still, animate: true, id: user.id, size: 'sm'").length - 1, 2, 'the header keeps moving, as the picture help text promises');
});

test('ranges are read strictly', () => {
  assert.deepEqual(readRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(readRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(readRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(readRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.deepEqual(readRange('bytes=100-', 100), { unsatisfiable: true });
  assert.equal(readRange('bytes=9-1', 100), null);
  assert.equal(readRange('bytes=0-1,4-5', 100), null);
  assert.equal(readRange('items=0-1', 100), null);
  assert.equal(readRange(null, 100), null);
});

function meter(db) {
  const calls = [];
  const blobBytes = (s) => (s.params || []).reduce((n, v) => n + (v instanceof Uint8Array ? v.length : 0), 0);
  const batch = db.batch.bind(db);
  db.batch = async (stmts) => {
    calls.push({ kind: 'batch', bytes: stmts.reduce((n, s) => n + blobBytes(s), 0) });
    return batch(stmts);
  };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    const wrap = (s) => {
      const bind = s.bind.bind(s);
      s.bind = (...v) => wrap(bind(...v));
      const run = s.run.bind(s);
      s.run = async () => {
        calls.push({ kind: 'run', bytes: blobBytes(s) });
        return run();
      };
      return s;
    };
    return wrap(stmt);
  };
  return calls;
}

test('a 10 MB upload reaches D1 one part per call, never as one huge batch', async () => {
  const { h, alice } = await setup();
  const calls = meter(h.db);
  const gif = bigGif(10 * MB - 4096, { seed: 11 });
  const res = await h.api('POST', BANNER, alice, { image: b64(gif), still: b64(devBannerPng(600, 200)) });
  assert.equal(res.status, 201, await res.clone().text());
  const heavy = calls.filter((c) => c.bytes > 0);
  assert.ok(heavy.length >= 10, 'every part is its own write');
  assert.ok(heavy.every((c) => c.bytes <= IMAGE_CHUNK_BYTES), `no single D1 call carries more than one part: ${JSON.stringify(heavy.map((c) => c.bytes))}`);
  assert.ok(calls.length < 40, `the upload stays well inside the D1 query budget: ${calls.length}`);
});

test('if the parts vanish before the picture is saved, nothing changes and the person is asked to try again', async () => {
  const { h, alice } = await setup();
  const first = bigGif(2 * MB, { seed: 12 });
  const one = (await (await h.api('POST', BANNER, alice, { image: b64(first), still: b64(devBannerPng(600, 200)) })).json()).banner;
  advance(h, 61_000);
  const batch = h.db.batch.bind(h.db);
  h.db.batch = async (stmts) => {
    h.db.raw.prepare("DELETE FROM image_chunks WHERE version <> ?").run(shortHash(first));
    h.db.batch = batch;
    return batch(stmts);
  };
  const second = bigGif(3 * MB, { seed: 13 });
  const res = await h.api('POST', BANNER, alice, { image: b64(second), still: b64(devBannerPng(600, 200)) });
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await res.json()).error, 'image_changed');
  assert.equal(h.db.raw.prepare('SELECT hash FROM profile_banners').get().hash, shortHash(first), 'the old banner is untouched');
  assert.ok(chunkRows(h, 'banner').every((r) => r.version === shortHash(first)));
  const still = await h.request('GET', one.url);
  assert.equal(still.status, 200);
  assert.ok(Buffer.from(await still.arrayBuffer()).equals(Buffer.from(first)));
});

test('parts of an upload still in progress survive cleanup, old leftovers do not', async () => {
  const { h, alice } = await setup();
  const gif = bigGif(2 * MB, { seed: 14 });
  await h.api('POST', BANNER, alice, { image: b64(gif), still: b64(devBannerPng(600, 200)) });
  const add = h.db.raw.prepare('INSERT INTO image_chunks (kind, owner_id, version, idx, data, bytes, hash, updated) VALUES (?, ?, ?, 0, ?, 3, ?, ?)');
  add.run('banner', ALICE.id.toLowerCase(), '1111111111111111', Buffer.from([1, 2, 3]), shortHash(Buffer.from([1, 2, 3])), h.clock.t - 60_000);
  add.run('banner', ALICE.id.toLowerCase(), '2222222222222222', Buffer.from([1, 2, 3]), shortHash(Buffer.from([1, 2, 3])), h.clock.t - IMAGE_CHUNK_GRACE - 1);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.imageChunks, 1);
  const versions = new Set(chunkRows(h, 'banner').map((r) => r.version));
  assert.ok(versions.has('1111111111111111') && versions.has(shortHash(gif)) && !versions.has('2222222222222222'));
});

test('hidden profiles do not leak big pictures, not even through a matching ETag', async () => {
  const { h, alice } = await setup();
  const gif = bigGif(2 * MB, { seed: 15 });
  const banner = (await (await h.api('POST', BANNER, alice, { image: b64(gif), still: b64(devBannerPng(600, 200)) })).json()).banner;
  const pic = bigGif(2 * MB, { width: 200, height: 200, seed: 16 });
  const custom = (await (await h.api('POST', AVATAR, alice, { image: b64(pic), still: b64(devBannerPng(128, 128)) })).json()).custom;
  assert.equal((await h.request('GET', banner.url)).status, 200);
  assert.equal((await h.request('GET', custom.url)).status, 200);
  h.db.raw.prepare('UPDATE public_profiles SET hidden = 1').run();
  for (const url of [banner.url, custom.url]) {
    assert.equal((await h.request('GET', url)).status, 404, url);
    assert.equal((await h.request('GET', url, { headers: { 'If-None-Match': `"${url.match(/-([0-9a-f]{16})\./)[1]}"` } })).status, 404);
    assert.equal((await h.request('GET', url, { headers: { Range: 'bytes=0-9' } })).status, 404);
  }
});

test('staff resets remove the big parts too', async () => {
  const { h, alice } = await setup();
  await h.api('POST', BANNER, alice, { image: b64(bigGif(2 * MB, { seed: 17 })), still: b64(devBannerPng(600, 200)) });
  advance(h, 61_000);
  await h.api('POST', AVATAR, alice, { image: b64(bigGif(2 * MB, { width: 200, height: 200, seed: 18 })), still: b64(devBannerPng(128, 128)) });
  const id = ALICE.id.toLowerCase();
  const look = defaultLook();
  assert.equal(chunkRows(h, 'banner').length, 2);
  await h.db.batch(resetPlan(h.db, id, 'banner', { look, banner: true, avatar: true }, 'Alice', h.clock.t).stmts);
  assert.equal(chunkRows(h, 'banner').length, 0);
  assert.equal(chunkRows(h, 'avatar').length, 2);
  await h.db.batch(resetPlan(h.db, id, 'avatar', { look, banner: false, avatar: true }, 'Alice', h.clock.t).stmts);
  assert.equal(chunkRows(h, 'avatar').length, 0);
  advance(h, 61_000);
  await h.api('POST', BANNER, alice, { image: b64(bigGif(2 * MB, { seed: 19 })), still: b64(devBannerPng(600, 200)) });
  advance(h, 61_000);
  await h.api('POST', AVATAR, alice, { image: b64(bigGif(2 * MB, { width: 200, height: 200, seed: 20 })), still: b64(devBannerPng(128, 128)) });
  await h.db.batch(resetPlan(h.db, id, 'all', { look, banner: true, avatar: true }, 'Alice', h.clock.t).stmts);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM image_chunks').get().n, 0);
});

test('base64 is read the same with or without the built-in decoder', () => {
  const bytes = bigGif(70_000, { seed: 21 });
  assert.ok(Buffer.from(fromBase64(b64(bytes))).equals(Buffer.from(bytes)));
  assert.equal(fromBase64('@@@@'), null);
});
