import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS, advance } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { makeGif, makeAnimWebp } from './motion-fixtures.js';
import {
  AnimError, readGif, readAnimWebp, readAnimated, checkAnimSize, animatedFrames, webpAnimated,
  ANIM_MAX_BYTES, ANIM_MAX_FRAMES, ANIM_MAX_W, ANIM_MAX_H, ANIM_MIN_W,
} from '../web/js/banner-anim.js';
import {
  cleanLook, cleanPalette, contrast, cropBox, cropRectFor, readCrop, readLook, themePalette, themeShades, LookError,
  THEMES, THEME_IDS, THEME_KEYS, EFFECTS, EFFECT_IDS, MIN_CONTRAST, defaultLook, isDefaultLook,
} from '../web/js/profile-look.js';
import { decodeAnimated, decodeStill, isAnimatedUpload, resetPlan, RESET_PARTS, RESET_ACTIONS, BANNER_BODY_LIMIT, STILL_MAX } from '../worker/profile-custom.js';
import { buildCard, clearPartyProfileCache } from '../worker/party-profile.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const LOOK = '/api/me/profile-look';
const BANNER = '/api/me/profile-banner';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const code = (c) => (e) => e instanceof AnimError && e.code === c;
const profileUrl = (id, ...rest) => `/api/party/profile/${id}${rest.map((r) => `/${r}`).join('')}`;

function seed(h, user) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 3, 400, NULL, '[\"vip\"]', '[]', '[]', NULL, 0, ?)")
    .run(user.id, user.username, user.username, user.display_name, h.clock.t);
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, '{}', '{}', ?)").run(user.id, h.clock.t);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO NOTHING').run(user.id, user.username, user.display_name, h.clock.t);
}

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: BOB.id });
  seed(h, ALICE);
  seed(h, BOB);
  const alice = (await h.login(ALICE)).cookie;
  const bob = (await h.login(BOB)).cookie;
  return { h, alice, bob };
}

async function view(h, name) {
  const res = await h.request('GET', `/api/u/${name}`, { ip: '203.0.113.91' });
  return res.status === 200 ? (await res.json()).profile.custom : null;
}

function moving(gif = makeGif({ width: 600, height: 200, frames: 3 }), still = devBannerPng(600, 200), crop = { zoom: 1.5, x: 0.4, y: 0.6 }) {
  return { image: b64(gif), still: b64(still), crop };
}

test('a good animated GIF is read, its frames counted, and comments and unknown blocks are stripped', () => {
  const gif = makeGif({ width: 900, height: 300, frames: 5, full: false, comment: '<script>alert(1)</script>', xmp: true });
  const out = readGif(gif);
  assert.deepEqual([out.mime, out.width, out.height, out.frames], ['image/gif', 900, 300, 5]);
  const text = Buffer.from(out.bytes).toString('latin1');
  assert.equal(text.includes('<script>'), false, 'comment blocks are removed');
  assert.equal(text.includes('XMP Data'), false, 'XMP blocks are removed');
  assert.equal(text.includes('NETSCAPE2.0'), true, 'the loop block is kept so the GIF keeps looping');
  assert.equal(out.bytes[out.bytes.length - 1], 0x3b);
  assert.equal(readGif(out.bytes).frames, 5, 'the cleaned GIF still reads the same');
  assert.equal(readGif(makeGif({ version: 'GIF87a', frames: 2 })).frames, 2);
  assert.equal(readGif(makeGif({ full: true, width: 300, height: 100, frames: 2 })).frames, 2);
  assert.equal(animatedFrames(gif), 5);
  assert.equal(animatedFrames(devBannerPng(600, 200)), 0);
  assert.equal(readAnimated(gif).frames, 5);
});

test('malformed GIFs are refused', () => {
  const good = makeGif({ frames: 2 });
  assert.throws(() => readGif(good.subarray(0, good.length - 1)), code('bad_image'), 'no trailer');
  assert.throws(() => readGif(good.subarray(0, 40)), code('bad_image'), 'cut short');
  assert.throws(() => readGif(new TextEncoder().encode('GIF89')), code('bad_image'));
  assert.throws(() => readGif(new TextEncoder().encode('GIF90a\x10\x00\x10\x00\x00\x00\x00;')), code('bad_image'), 'unknown version');
  assert.throws(() => readGif(makeGif({ width: 0, frames: 1 })), code('bad_image'), 'zero width');
  assert.throws(() => readGif(makeGif({ frames: 0 })), code('bad_image'), 'no frames');
  assert.throws(() => readGif(makeGif({ frames: 2, globalTable: false })), code('bad_image'), 'no colour table');
  const badBlock = Uint8Array.from(good);
  const at = Buffer.from(badBlock).indexOf(Buffer.from([0x2c, 0, 0, 0, 0]));
  badBlock[at + 10] = 12;
  assert.throws(() => readGif(badBlock), code('bad_image'), 'impossible LZW code size');
  const stray = Uint8Array.from([...good.subarray(0, good.length - 1), 0x99, 0x3b]);
  assert.throws(() => readGif(stray), code('bad_image'), 'unknown block');
  assert.throws(() => readGif(new Uint8Array(0)), code('bad_image'));
  assert.throws(() => readGif(null), code('bad_image'));
});

test('GIFs with too many frames, extra data or the wrong size are refused', () => {
  assert.equal(readGif(makeGif({ frames: ANIM_MAX_FRAMES })).frames, ANIM_MAX_FRAMES);
  assert.throws(() => readGif(makeGif({ frames: ANIM_MAX_FRAMES + 1 })), code('too_many_frames'));
  const html = new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>');
  assert.throws(() => readGif(makeGif({ frames: 2, tail: [...html] })), code('bad_image'), 'a GIF and HTML polyglot is refused');
  assert.equal(readGif(makeGif({ frames: 2, tail: [0, 0, 0] })).frames, 2, 'a little zero padding is fine');
  assert.throws(() => readGif(makeGif({ frames: 2, tail: new Array(100).fill(0) })), code('bad_image'), 'lots of padding is not');
  const js = makeGif({ frames: 2 });
  js[6] = 0x2f;
  js[7] = 0x2a;
  const info = readGif(js);
  assert.throws(() => checkAnimSize(info), code('bad_image_size'), 'the GIF89a/* script polyglot has an impossible width');
  const sizes = (w, ht, f = 2) => () => checkAnimSize({ width: w, height: ht, frames: f });
  assert.doesNotThrow(sizes(600, 200));
  assert.doesNotThrow(sizes(ANIM_MIN_W, ANIM_MIN_W));
  assert.doesNotThrow(sizes(3000, 1000));
  assert.throws(sizes(ANIM_MAX_W + 1, 1000), code('bad_image_size'));
  assert.throws(sizes(3000, ANIM_MAX_H + 1), code('bad_image_size'));
  assert.throws(sizes(ANIM_MIN_W - 1, 100), code('bad_image_size'));
  assert.throws(sizes(400, 500), code('bad_image_size'), 'taller than wide');
  assert.throws(sizes(2800, 400), code('bad_image_size'), 'more than 6 times as wide');
  assert.throws(sizes(3000, 1000, 400), code('too_many_frames'), 'too many big frames');
});

test('animated WebP is checked chunk by chunk and stripped of EXIF and XMP', () => {
  const webp = makeAnimWebp({ frames: 3, exif: true, xmp: true, unknown: true });
  assert.equal(webpAnimated(webp), true);
  const out = readAnimWebp(webp);
  assert.deepEqual([out.mime, out.width, out.height, out.frames], ['image/webp', 600, 200, 3]);
  const text = Buffer.from(out.bytes).toString('latin1');
  assert.equal(text.includes('Exif'), false);
  assert.equal(text.includes('<x:xmpmeta'), false);
  assert.equal(text.includes('<script>'), false, 'unknown chunks are dropped');
  assert.equal(out.bytes[20] & 0x0c, 0, 'the EXIF and XMP flags are cleared');
  assert.equal(out.bytes[20] & 0x02, 0x02, 'the animation flag stays');
  assert.equal(Buffer.from(out.bytes).readUInt32LE(4) + 8, out.bytes.length, 'the RIFF size matches');
  assert.equal(readAnimWebp(out.bytes).frames, 3);
  assert.equal(readAnimWebp(makeAnimWebp({ iccFirst: true })).frames, 2);
  assert.throws(() => readAnimWebp(makeAnimWebp({ animFlag: false })), code('not_animated'));
  assert.throws(() => readAnimWebp(makeAnimWebp({ anim: false })), code('bad_image'), 'frames without an ANIM chunk');
  assert.throws(() => readAnimWebp(makeAnimWebp({ frame: { x: 400, y: 0, w: 300, h: 200, image: 'VP8L' } })), code('bad_image'), 'a frame outside the canvas');
  assert.throws(() => readAnimWebp(makeAnimWebp({ frame: { x: 0, y: 0, w: 600, h: 200, image: null } })), code('bad_image'), 'a frame with no picture');
  assert.throws(() => readAnimWebp(makeAnimWebp({ frames: 0 })), code('bad_image'));
  const cut = makeAnimWebp();
  assert.throws(() => readAnimWebp(cut.subarray(0, cut.length - 4)), code('bad_image'), 'size mismatch');
  assert.throws(() => readAnimWebp(makeAnimWebp({ frames: ANIM_MAX_FRAMES + 1, width: 300, height: 100 })), code('too_many_frames'));
  assert.equal(animatedFrames(makeAnimWebp({ frames: 4 })), 4);
  assert.throws(() => readAnimated(devBannerPng(600, 200)), code('bad_image'));
});

test('the upload body fits a full moving banner and its still, and oversize ones are refused', () => {
  assert.ok(BANNER_BODY_LIMIT >= Math.ceil(((ANIM_MAX_BYTES + STILL_MAX) * 4) / 3));
  assert.equal(ANIM_MAX_BYTES, 10 * 1024 * 1024, 'moving banners can be up to 10 MB');
  const big = new Uint8Array(ANIM_MAX_BYTES + 10);
  big.set(makeGif({ frames: 2 }));
  assert.throws(() => decodeAnimated(b64(big)), (e) => e.status === 413);
  assert.throws(() => decodeAnimated(b64(makeGif({ frames: 1 }))), (e) => e.code === 'not_animated');
  assert.throws(() => decodeAnimated(b64(makeGif({ width: 3200, height: 1000, frames: 2 }))), (e) => e.code === 'bad_image_size');
  assert.equal(isAnimatedUpload(b64(makeGif())), true);
  assert.equal(isAnimatedUpload(`data:image/gif;base64,${b64(makeGif())}`), true);
  assert.equal(isAnimatedUpload(b64(makeAnimWebp())), true);
  assert.equal(isAnimatedUpload(b64(devBannerPng(600, 200))), false);
  assert.equal(isAnimatedUpload(5), false);
  const anim = { width: 600, height: 200 };
  assert.equal(decodeStill(b64(devBannerPng(600, 200)), anim).width, 600);
  assert.throws(() => decodeStill(b64(devBannerPng(600, 300)), anim), (e) => e.code === 'bad_still', 'wrong shape');
  assert.throws(() => decodeStill(b64(makeAnimWebp()), anim), (e) => e.code === 'bad_still' || e.code === 'bad_image');
  assert.throws(() => decodeStill(undefined, anim), (e) => e.code === 'bad_image');
});

test('moving banners upload with a still and a crop, are served safely, and hide with the profile', async () => {
  const { h, alice } = await setup();
  const gif = makeGif({ width: 600, height: 200, frames: 3, comment: 'made with <b>love</b>' });
  const up = await h.api('POST', BANNER, alice, moving(gif));
  assert.equal(up.status, 201, await up.clone().text());
  const { banner } = await up.json();
  assert.match(banner.url, /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}\.gif$/);
  assert.equal(banner.animated, true);
  assert.equal(banner.frames, 3);
  assert.match(banner.motion.still, /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}-still\.png$/);
  assert.deepEqual([banner.motion.width, banner.motion.height], [600, 200]);
  assert.deepEqual(banner.crop, { zoom: 1.5, x: 0.4, y: 0.6 });
  const img = await h.request('GET', banner.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/gif');
  assert.equal(img.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(img.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.match(img.headers.get('Cache-Control'), /immutable/);
  const served = new Uint8Array(await img.arrayBuffer());
  assert.equal(Buffer.from(served).toString('latin1').includes('<b>love'), false, 'the stored GIF is the cleaned one');
  assert.equal(readGif(served).frames, 3);
  const still = await h.request('GET', banner.motion.still);
  assert.equal(still.status, 200);
  assert.equal(still.headers.get('Content-Type'), 'image/png');
  assert.equal(still.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.equal((await h.request('GET', banner.motion.still.replace('-still.png', '-still.webp'))).status, 404);
  assert.equal((await h.request('GET', banner.url.replace('.gif', '.png'))).status, 404);
  const c = await view(h, 'alice');
  assert.equal(c.banner, 'image');
  assert.equal(c.bannerImage, banner.url);
  assert.deepEqual(c.bannerMotion, banner.motion);
  assert.deepEqual(c.bannerCrop, { zoom: 1.5, x: 0.4, y: 0.6 });
  const read = readLook(c);
  assert.deepEqual(read.bannerMotion, banner.motion);
  assert.deepEqual(read.look.bannerCrop, { zoom: 1.5, x: 0.4, y: 0.6 });
  const moved = await h.api('PUT', LOOK, alice, { ...read.look, bannerCrop: { zoom: 2, x: 0.5, y: 0.5 } });
  assert.equal(moved.status, 200);
  assert.deepEqual((await view(h, 'alice')).bannerCrop, { zoom: 2, x: 0.5, y: 0.5 }, 'moving banners can be repositioned without uploading again');
  assert.equal((await h.api('PUT', LOOK, alice, { bannerCrop: { zoom: 9, x: 0.5, y: 0.5 } })).status, 400);
  assert.equal((await h.api('PUT', LOOK, alice, { bannerCrop: { zoom: 2, x: 0.5, y: 0.5, z: 1 } })).status, 400);
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: true });
  assert.equal((await h.request('GET', banner.url)).status, 404);
  assert.equal((await h.request('GET', banner.motion.still)).status, 404, 'the still is hidden with the profile too');
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: false });
  assert.equal((await h.request('GET', banner.motion.still)).status, 200);
  advance(h, 61_000);
  const plain = await h.api('POST', BANNER, alice, { image: b64(devBannerPng(1500, 500)) });
  assert.equal(plain.status, 201);
  const p = (await plain.json()).banner;
  assert.equal(p.animated, false);
  assert.equal(p.motion, null);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_banner_stills WHERE user_id = ?').get(ALICE.id).n, 0, 'a still picture replaces the moving one and its still');
  assert.equal((await h.request('GET', banner.motion.still)).status, 404);
  const after = await view(h, 'alice');
  assert.equal(after.bannerMotion, null);
  assert.equal(after.bannerCrop, null);
  await h.api('POST', BANNER, alice, moving(makeAnimWebp({ frames: 2 }), devBannerPng(600, 200)));
  const w = await view(h, 'alice');
  assert.match(w.bannerImage, /\.webp$/);
  assert.ok(w.bannerMotion);
  assert.equal((await h.api('DELETE', BANNER, alice)).status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_banner_stills WHERE user_id = ?').get(ALICE.id).n, 0);
  assert.equal((await view(h, 'alice')).bannerCrop, null);
});

test('moving banner uploads need a matching still and a valid crop', async () => {
  const { h, alice } = await setup();
  const gif = makeGif({ width: 600, height: 200, frames: 2 });
  const send = async (body) => {
    const res = await h.api('POST', BANNER, alice, body);
    advance(h, 11_000);
    return { status: res.status, error: (await res.json()).error };
  };
  assert.deepEqual(await send({ image: b64(gif) }), { status: 400, error: 'bad_image' }, 'no still');
  assert.deepEqual(await send({ ...moving(gif), still: b64(devBannerPng(600, 300)) }), { status: 400, error: 'bad_still' });
  assert.deepEqual(await send({ ...moving(gif), crop: { zoom: 0, x: 0.5, y: 0.5 } }), { status: 400, error: 'bad_crop' });
  assert.deepEqual(await send({ ...moving(gif), crop: 'center' }), { status: 400, error: 'bad_crop' });
  assert.deepEqual(await send({ image: b64(devBannerPng(1500, 500)), crop: { zoom: 1, x: 0.5, y: 0.5 } }), { status: 400, error: 'bad_request' }, 'still pictures send no crop');
  assert.deepEqual(await send({ image: b64(makeAnimWebp()), still: b64(devBannerPng(600, 200)), extra: 1 }), { status: 400, error: 'bad_request' });
  assert.deepEqual(await send({ image: b64(makeGif({ frames: 2, tail: [...new TextEncoder().encode('<html>')] })), still: b64(devBannerPng(600, 200)) }), { status: 400, error: 'bad_image' });
  const ok = await send({ image: b64(gif), still: b64(devBannerPng(600, 200)) });
  assert.equal(ok.status, 201);
  assert.deepEqual((await view(h, 'alice')).bannerCrop, { zoom: 1, x: 0.5, y: 0.5 }, 'a missing crop means centred');
});

test('the crop shown on the page matches the crop picked in the cropper', async () => {
  const { cropRect, viewToCrop, cropToView, clampView } = await import('../web/js/pages/profile-editor.js');
  for (const [w, ht] of [[600, 200], [498, 280], [3000, 1000], [1200, 300], [800, 800]]) {
    for (const v of [{ zoom: 1 }, { zoom: 1.7, cx: w * 0.3, cy: ht * 0.7 }, { zoom: 4, cx: 0, cy: ht }, { zoom: 2.5, cx: w, cy: 0 }]) {
      const view = clampView(w, ht, v);
      const want = cropRect(w, ht, view);
      const crop = viewToCrop(w, ht, view);
      const got = cropRectFor(w, ht, crop);
      for (const k of ['sx', 'sy', 'sw', 'sh']) assert.ok(Math.abs(got[k] - want[k]) < 0.6, `${w}x${ht} ${JSON.stringify(v)} ${k}: ${got[k]} vs ${want[k]}`);
      const box = cropBox(w, ht, crop);
      const frameW = 900;
      const frameH = 300;
      assert.ok(Math.abs((-box.left / 100) * frameW / (frameW / got.sw) - got.sx) < 0.01, 'left edge');
      assert.ok(Math.abs((-box.top / 100) * frameH / (frameH / got.sh) - got.sy) < 0.01, 'top edge');
      assert.ok(Math.abs((box.width / 100) * frameW - (w * frameW) / got.sw) < 0.05, 'scaled width');
      assert.ok(Math.abs((box.height / 100) * frameH - (ht * frameH) / got.sh) < 0.05, 'scaled height');
      assert.ok(box.left <= 0 && box.top <= 0 && box.width >= 100 && box.height >= 99.99, 'the picture always covers the box');
      const back = cropToView(w, ht, crop);
      assert.ok(Math.abs(back.zoom - view.zoom) < 0.01);
    }
  }
  assert.deepEqual(cropBox(600, 200, null), { width: 100, height: 100, left: 0, top: 0 });
  assert.deepEqual(cropBox(600, 200, { zoom: 2, x: 0, y: 0 }), { width: 200, height: 200, left: 0, top: 0 });
  assert.deepEqual(cropBox(600, 200, { zoom: 2, x: 1, y: 1 }), { width: 200, height: 200, left: -100, top: -100 });
  assert.deepEqual(cropBox(600, 400, { zoom: 1, x: 0.5, y: 0.5 }), { width: 100, height: 200, left: 0, top: -50 });
  assert.equal(readCrop({ zoom: 1.23456, x: 0.123456, y: 1 }).x, 0.1235);
  assert.equal(readCrop({ zoom: '2', x: 0.5, y: 0.5 }), null);
  assert.throws(() => readCrop({ zoom: Infinity, x: 0.5, y: 0.5 }, true), (e) => e instanceof LookError && e.code === 'bad_crop');
  assert.throws(() => readCrop([], true), (e) => e.code === 'bad_crop');
});

test('themes are strictly validated and keep every text colour readable in light and dark', () => {
  const strict = (raw) => () => cleanLook(raw, { strict: true });
  const err = (c) => (e) => e instanceof LookError && e.code === c;
  assert.equal(THEMES.length, 12);
  assert.deepEqual(THEME_IDS.slice(0, 1), ['none']);
  assert.equal(THEME_IDS[THEME_IDS.length - 1], 'custom');
  assert.throws(strict({ theme: 'hacker' }), err('bad_theme'));
  assert.throws(strict({ theme: 'custom' }), err('bad_theme'), 'custom needs its colours');
  for (const bad of [{ base: 'red', alt: '#000000', accent: '#ffffff' }, { base: '#FFFFFF', alt: '#000000', accent: '#ffffff' }, { base: '#000000', alt: '#000000' }, { base: '#000000', alt: '#000000', accent: '#000000', bg: 'url(x)' }, { base: '#000000;}body{', alt: '#000000', accent: '#000000' }, ['#000000']]) {
    assert.throws(strict({ theme: 'custom', themeCustom: bad }), err('bad_theme'), JSON.stringify(bad));
  }
  assert.throws(strict({ theme: 'ocean', themeMode: 'sepia' }), err('bad_theme_mode'));
  assert.throws(strict({ theme: 'ocean', themePattern: 'url(x)' }), err('bad_theme_pattern'));
  const ok = cleanLook({ theme: 'custom', themeCustom: { base: '#112233', alt: '#445566', accent: '#ff00aa' }, themeMode: 'dark', themePattern: 'stars' }, { strict: true });
  assert.deepEqual([ok.theme, ok.themeMode, ok.themePattern], ['custom', 'dark', 'stars']);
  assert.deepEqual(cleanLook({ theme: 'ocean', themeCustom: { base: '#112233', alt: '#445566', accent: '#ff00aa' } }).themeCustom, null, 'custom colours only stay with the custom theme');
  const none = cleanLook({ theme: 'none', themeMode: 'dark', themePattern: 'stars' });
  assert.deepEqual([none.themeMode, none.themePattern], ['auto', 'glow']);
  assert.equal(isDefaultLook(none), true);
  assert.equal(cleanLook({ theme: 'nope' }).theme, 'none', 'loose reads fall back');
  assert.equal(themePalette(defaultLook()), null);
  const check = (colours, label) => {
    for (const mode of ['light', 'dark']) {
      const s = themeShades(colours, mode);
      for (const k of THEME_KEYS) assert.match(s[k], /^#[0-9a-f]{6}$/, `${label} ${mode} ${k}`);
      const backs = [s.surface, s.surface2, s.surface3, s.bg, s.bg2];
      for (const k of ['text', 'text2', 'text3', 'accentText']) for (const b of backs) assert.ok(contrast(s[k], b) >= MIN_CONTRAST, `${label} ${mode} ${k} on ${b}: ${contrast(s[k], b).toFixed(2)}`);
      assert.ok(contrast(s.onAccent, s.accent) >= MIN_CONTRAST, `${label} ${mode} button text`);
      assert.ok(contrast(s.onAccent, s.accentHover) >= MIN_CONTRAST, `${label} ${mode} hovered button text`);
    }
  };
  for (const t of THEMES) check(t, t.id);
  let seedN = 7;
  const rand = () => {
    seedN = (seedN * 1103515245 + 12345) % 2147483648;
    return seedN / 2147483648;
  };
  const hex = () => `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`;
  for (let i = 0; i < 150; i++) check({ base: hex(), alt: hex(), accent: hex() }, `random ${i}`);
  for (const c of ['#000000', '#ffffff', '#ffff00', '#808080']) check({ base: c, alt: c, accent: c }, c);
});

test('palettes sent to the Party card are re-checked so no colour can carry CSS', () => {
  const pal = themePalette(cleanLook({ theme: 'neon', themeMode: 'dark', themePattern: 'grid' }));
  assert.deepEqual([pal.id, pal.mode, pal.pattern], ['neon', 'dark', 'grid']);
  assert.deepEqual(cleanPalette(pal), pal);
  assert.equal(cleanPalette({ ...pal, light: { ...pal.light, text: 'red;background:url(x)' } }), null);
  assert.equal(cleanPalette({ ...pal, id: 'none' }), null);
  assert.equal(cleanPalette({ ...pal, id: '<b>' }), null);
  assert.equal(cleanPalette({ ...pal, dark: null }), null);
  assert.equal(cleanPalette({ ...pal, mode: 'sideways' }).mode, 'auto');
  assert.equal(cleanPalette('x'), null);
});

test('effects are a fixed list and unknown ones are refused', () => {
  assert.deepEqual(EFFECT_IDS, ['none', 'snow', 'snowflakes', 'sakura', 'stars', 'fireflies', 'confetti', 'hearts', 'bubbles', 'rain', 'embers', 'sparkles']);
  assert.equal(EFFECTS.length, 12);
  for (const id of EFFECT_IDS) assert.equal(cleanLook({ effect: id }, { strict: true }).effect, id);
  for (const bad of ['fire', 'SNOW', '', 3, null]) assert.throws(() => cleanLook({ effect: bad }, { strict: true }), (e) => e.code === 'bad_effect', String(bad));
  assert.equal(cleanLook({ effect: 'lava' }).effect, 'none');
});

test('themes and effects save, show on the profile, and the Party card carries everything it needs', async () => {
  const { h, alice } = await setup();
  const up = await h.api('POST', BANNER, alice, moving());
  assert.equal(up.status, 201);
  const motion = (await up.json()).banner.motion;
  const look = { ...readLook(await view(h, 'alice')).look, theme: 'aurora', themeMode: 'dark', themePattern: 'stars', effect: 'snowflakes', nameGradient: 'gold', nameFont: 'serif', ring: 'glow', accent: '#7c5cff', pins: ['vip'] };
  const put = await h.api('PUT', LOOK, alice, look);
  assert.equal(put.status, 200, await put.clone().text());
  const c = await view(h, 'alice');
  assert.deepEqual([c.theme, c.themeMode, c.themePattern, c.effect, c.themeCustom], ['aurora', 'dark', 'stars', 'snowflakes', null]);
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id);
  const l = card.look;
  assert.equal(l.theme, 'aurora');
  assert.equal(l.effect, 'snowflakes');
  assert.deepEqual(cleanPalette(l.palette), l.palette);
  assert.equal(l.palette.mode, 'dark');
  assert.equal(l.palette.pattern, 'stars');
  assert.deepEqual(Object.keys(l.palette.dark), [...THEME_KEYS]);
  assert.match(l.bannerImage, /\.gif$/);
  assert.deepEqual(l.bannerMotion, motion);
  assert.deepEqual(l.bannerCrop, { zoom: 1.5, x: 0.4, y: 0.6 });
  assert.deepEqual([l.nameGradient, l.nameFont, l.ring, l.featured], ['gold', 'serif', 'glow', 'level']);
  assert.equal(l.accent.base, '#7c5cff');
  assert.deepEqual(l.pins, ['vip']);
  const res = await h.request('GET', `/api/activity/profile/${ALICE.id}`, { ip: '203.0.113.92' });
  assert.equal(res.status, 200);
  const served = (await res.json()).profile.look;
  assert.equal(served.theme, 'aurora');
  assert.equal(served.bannerMotion.still, motion.still);
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: true });
  clearPartyProfileCache(h.db);
  const hidden = await buildCard(h.db, ALICE.id);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.look, undefined, 'a hidden profile shares no theme, effect or banner');
  assert.equal(JSON.stringify(hidden).includes('aurora'), false);
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: false });
  const custom = await h.api('PUT', LOOK, alice, { theme: 'custom', themeCustom: { base: '#101010', alt: '#ff0000', accent: '#00ff00' } });
  assert.equal(custom.status, 200);
  clearPartyProfileCache(h.db);
  const c2 = await buildCard(h.db, ALICE.id);
  assert.equal(c2.look.theme, 'custom');
  assert.equal(c2.look.bannerMotion, null, 'the banner choice went back to none in that save');
  assert.equal(c2.look.effect, 'none');
  for (const s of [c2.look.palette.light, c2.look.palette.dark]) assert.ok(contrast(s.text, s.surface) >= MIN_CONTRAST);
});

test('staff can reset a theme and turn off an effect, and both go to the mod log', async () => {
  const { h, alice, bob } = await setup();
  assert.ok(RESET_PARTS.includes('theme') && RESET_PARTS.includes('effect'));
  assert.ok(RESET_ACTIONS.includes('profile_theme_reset') && RESET_ACTIONS.includes('profile_effect_clear'));
  await h.api('PUT', LOOK, alice, { theme: 'ember', themeMode: 'dark', effect: 'embers', bio: 'hi' });
  const staffView = await (await h.api('GET', profileUrl(ALICE.id), bob)).json();
  assert.equal(staffView.look.theme, 'ember');
  assert.equal(staffView.look.effect, 'embers');
  const t = await h.api('DELETE', profileUrl(ALICE.id, 'look', 'theme'), bob);
  assert.equal(t.status, 200, await t.clone().text());
  let c = await view(h, 'alice');
  assert.deepEqual([c.theme, c.themeMode, c.effect, c.bio], ['none', 'auto', 'embers', 'hi'], 'only the theme is reset');
  assert.equal((await h.api('DELETE', profileUrl(ALICE.id, 'look', 'theme'), bob)).status, 404);
  const e = await h.api('DELETE', profileUrl(ALICE.id, 'look', 'effect'), bob);
  assert.equal(e.status, 200);
  c = await view(h, 'alice');
  assert.deepEqual([c.effect, c.bio], ['none', 'hi']);
  assert.equal((await h.api('DELETE', profileUrl(ALICE.id, 'look', 'effect'), bob)).status, 404);
  const log = h.db.raw.prepare('SELECT action, detail FROM party_mod_log WHERE target_id = ? ORDER BY created, rowid').all(ALICE.id);
  assert.deepEqual(log.map((r) => r.action), ['profile_theme_reset', 'profile_effect_clear']);
  assert.equal(JSON.parse(log[0].detail).theme, 'ember');
  assert.equal(JSON.parse(log[1].detail).effect, 'embers');
  const notices = await (await h.api('GET', '/api/me/profile-notices', alice)).json();
  assert.deepEqual(notices.resets.map((r) => r.action).sort(), ['profile_effect_clear', 'profile_theme_reset']);
  advance(h, 61_000);
  await h.api('POST', BANNER, alice, moving());
  const all = await h.api('DELETE', profileUrl(ALICE.id, 'look', 'all'), bob);
  assert.equal(all.status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_banner_stills WHERE user_id = ?').get(ALICE.id).n, 0, 'reset everything removes the still too');
  assert.equal(resetPlan(null, ALICE.id, 'theme', { look: defaultLook(), banner: null }, 'A', 1), null);
  assert.equal(resetPlan(null, ALICE.id, 'effect', { look: defaultLook(), banner: null }, 'A', 1), null);
});
