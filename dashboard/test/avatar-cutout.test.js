import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHarness, advance, USERS } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { makeGif } from './motion-fixtures.js';
import { createWorker } from '../worker/app.js';
import { cleanup } from '../worker/cron.js';
import {
  cutOut, backdropColours, pngHasAlpha, webpHasAlpha, imageHasAlpha, strengthTolerance, verdictText, encodeCutout,
  BACKDROP_DEFAULT, GRADIENT_BACKDROPS, CUT_EVERYTHING,
} from '../web/js/avatar-cutout.js';
import { handleCutMessage } from '../web/js/avatar-cutout-worker.js';
import { avatarIdOf, cleanColours, cleanInfo, paintBackdrop } from '../web/js/avatar-backdrop.js';
import { THEMES } from '../web/js/profile-look.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const ALICE = USERS.alice;
const API = '/api/me/profile-avatar';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
let ipN = 40;
const nextIp = () => `198.51.100.${(ipN = (ipN % 200) + 1)}`;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function rgbaPng(w, h, fn) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.set(fn(x, y), 1 + x * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function image(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 4);
  return px;
}

const alphaAt = (res, x, y) => res.rgba[(y * res.width + x) * 4 + 3];
const cutPng = (w = 96) => rgbaPng(w, w, (x, y) => (Math.hypot(x - w / 2, y - w / 2) < w / 3 ? [220, 60, 90, 255] : [0, 0, 0, 0]));

test('a flat background is removed while the subject stays solid, with soft edges', () => {
  const w = 64;
  const px = image(w, w, (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? [200, 40, 60, 255] : [250, 250, 248, 255]));
  const res = cutOut(px, w, w, { strength: 45 });
  assert.equal(alphaAt(res, 0, 0), 0);
  assert.equal(alphaAt(res, 63, 63), 0);
  assert.equal(alphaAt(res, 10, 32), 0);
  assert.equal(alphaAt(res, 32, 32), 255);
  assert.equal(alphaAt(res, 32, 20), 255);
  assert.equal(res.verdict, 'ok');
  assert.ok(Math.abs(res.removed - (1 - (Math.PI * 400) / 4096)) < 0.05, `removed ${res.removed}`);
  let soft = 0;
  for (let i = 3; i < res.rgba.length; i += 4) if (res.rgba[i] > 0 && res.rgba[i] < 255) soft += 1;
  assert.ok(soft > 10, 'the edge is feathered');
  assert.deepEqual(res.background[0], [250, 250, 248]);
});

test('a light subject on a light background keeps its face, even across soft edges', () => {
  const w = 96;
  const bgc = [246, 244, 238];
  const skin = [242, 199, 165];
  const px = image(w, w, (x, y) => {
    const d = Math.hypot(x - 48, y - 44) - 26;
    const t = Math.min(1, Math.max(0, 0.5 - d));
    return [0, 1, 2].map((i) => Math.round(bgc[i] + (skin[i] - bgc[i]) * t)).concat(255);
  });
  const res = cutOut(px, w, w, { strength: 45 });
  assert.equal(alphaAt(res, 48, 44), 255);
  assert.equal(alphaAt(res, 48, 22), 255);
  assert.equal(alphaAt(res, 3, 3), 0);
  assert.equal(res.verdict, 'ok');
});

test('a soft gradient background is followed across the picture', () => {
  const w = 80;
  const px = image(w, w, (x, y) => {
    if (x >= 28 && x < 52 && y >= 28 && y < 52) return [30, 30, 40, 255];
    const t = x / (w - 1);
    return [Math.round(150 + 90 * t), Math.round(190 + 50 * t), 255, 255];
  });
  const res = cutOut(px, w, w, { strength: 45 });
  for (const [x, y] of [[0, 0], [79, 0], [40, 2], [40, 77], [5, 40], [75, 40], [20, 20], [60, 60]]) assert.equal(alphaAt(res, x, y), 0, `${x},${y}`);
  assert.equal(alphaAt(res, 40, 40), 255);
  assert.equal(res.verdict, 'ok');
});

test('a subject touching the edge keeps the part on the edge', () => {
  const w = 64;
  const px = image(w, w, (x, y) => (x >= 16 && x < 48 && y >= 30 ? [40, 90, 200, 255] : Math.hypot(x - 32, y - 22) < 10 ? [240, 190, 160, 255] : [255, 255, 255, 255]));
  const res = cutOut(px, w, w, { strength: 45 });
  assert.equal(alphaAt(res, 32, 63), 255, 'the shoulders on the bottom edge stay');
  assert.equal(alphaAt(res, 20, 63), 255);
  assert.equal(alphaAt(res, 32, 22), 255, 'the face stays');
  assert.equal(alphaAt(res, 2, 2), 0);
  assert.equal(alphaAt(res, 60, 63), 0);
  const wide = cutOut(image(w, w, (x, y) => (y >= 44 ? [40, 90, 200, 255] : Math.hypot(x - 32, y - 26) < 12 ? [240, 190, 160, 255] : [255, 255, 255, 255])), w, w, { strength: 45 });
  assert.equal(alphaAt(wide, 0, 63), 255, 'shoulders across the whole bottom stay');
  assert.equal(alphaAt(wide, 32, 50), 255);
  assert.equal(alphaAt(wide, 2, 2), 0);
  assert.equal(alphaAt(wide, 5, 30), 0);
});

test('almost everything or almost nothing removed is reported with a friendly note', () => {
  const w = 64;
  const empty = cutOut(image(w, w, (x, y) => (x === 30 && y === 30 ? [0, 0, 0, 255] : [255, 255, 255, 255])), w, w, { strength: 45 });
  assert.equal(empty.verdict, 'everything');
  assert.ok(empty.removed >= CUT_EVERYTHING);
  assert.equal(alphaAt(empty, 30, 30), 0, 'a tiny island is cleaned away');
  const full = cutOut(image(w, w, (x, y) => [(x * 37 + y * 11) % 256, (x * 13 + y * 71) % 256, (x * 101 + y * 7) % 256, 255]), w, w, { strength: 0 });
  assert.equal(full.verdict, 'nothing');
  assert.match(verdictText('everything'), /strength down/);
  assert.match(verdictText('nothing'), /higher strength/);
  assert.equal(verdictText('ok'), '');
});

test('strength widens the colour tolerance and see-through pixels stay see-through', () => {
  assert.ok(strengthTolerance(0) < strengthTolerance(50));
  assert.ok(strengthTolerance(50) < strengthTolerance(100));
  assert.equal(strengthTolerance('junk'), strengthTolerance(45));
  const w = 64;
  const px = image(w, w, (x, y) => (Math.hypot(x - 32, y - 32) < 18 ? [120, 120, 120, 255] : x < 32 ? [250, 250, 250, 255] : [235, 235, 235, 255]));
  const low = cutOut(px, w, w, { strength: 0 });
  const high = cutOut(px, w, w, { strength: 100 });
  assert.ok(high.removed >= low.removed);
  const clear = cutOut(image(w, w, (x, y) => (Math.hypot(x - 32, y - 32) < 18 ? [10, 200, 10, 255] : [0, 0, 0, 0])), w, w);
  assert.equal(alphaAt(clear, 0, 0), 0);
  assert.equal(alphaAt(clear, 32, 32), 255);
  assert.throws(() => cutOut(new Uint8ClampedArray(4), 0, 0));
  assert.throws(() => cutOut(new Uint8ClampedArray(16), 4, 4 * 1000));
});

test('the worker wrapper answers with the cut-out or a readable error', () => {
  const w = 64;
  const px = image(w, w, (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? [200, 40, 60, 255] : [250, 250, 248, 255]));
  const sent = [];
  handleCutMessage({ id: 7, data: px.buffer.slice(0), width: w, height: w, options: { strength: 45 } }, (msg, transfer) => sent.push({ msg, transfer }));
  assert.equal(sent[0].msg.id, 7);
  assert.equal(sent[0].msg.ok, true);
  assert.equal(sent[0].transfer.length, 1);
  handleCutMessage({ id: 8, data: new ArrayBuffer(4), width: 0, height: 0 }, (msg) => sent.push({ msg }));
  assert.equal(sent[1].msg.ok, false);
  assert.ok(sent[1].msg.message);
});

test('alpha is read from PNG and WebP headers', () => {
  assert.equal(pngHasAlpha(new Uint8Array(cutPng())), true);
  assert.equal(pngHasAlpha(new Uint8Array(devBannerPng(64, 64))), false);
  assert.equal(imageHasAlpha(new Uint8Array(cutPng()), 'image/jpeg'), false);
  const vp8x = new Uint8Array(32);
  vp8x.set(Buffer.from('RIFF'), 0);
  vp8x.set(Buffer.from('WEBP'), 8);
  vp8x.set(Buffer.from('VP8X'), 12);
  vp8x[20] = 0x10;
  assert.equal(webpHasAlpha(vp8x), true);
  vp8x[20] = 0;
  assert.equal(webpHasAlpha(vp8x), false);
  const vp8l = new Uint8Array(32);
  vp8l.set(Buffer.from('RIFF'), 0);
  vp8l.set(Buffer.from('WEBP'), 8);
  vp8l.set(Buffer.from('VP8L'), 12);
  vp8l[20] = 0x2f;
  vp8l[24] = 0x10;
  assert.equal(webpHasAlpha(vp8l), true);
  vp8l[24] = 0;
  assert.equal(webpHasAlpha(vp8l), false);
});

test('backdrop colours come from the theme, then accent, then name gradient, then name colour, then a neutral default', () => {
  const midnight = THEMES.find((t) => t.id === 'midnight');
  assert.deepEqual(backdropColours({ theme: 'midnight', accent: '#ff0000', nameGradient: 'sunset' }), { from: 'theme', stops: [midnight.base, midnight.alt], ring: midnight.accent });
  assert.deepEqual(backdropColours({ theme: 'custom', themeCustom: { base: '#112233', alt: '#445566', accent: '#778899' }, accent: '#ff0000' }).stops, ['#112233', '#445566']);
  const accent = backdropColours({ theme: 'none', accent: '#2f8fe8', nameGradient: 'sunset' });
  assert.equal(accent.from, 'accent');
  assert.equal(accent.stops[0], '#2f8fe8');
  assert.equal(accent.ring, '#2f8fe8');
  assert.deepEqual(backdropColours({ nameGradientCustom: { a: '#ff0000', b: '#0000ff', c: '#00ff00', angle: 90 } }).stops, ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(backdropColours({ nameGradientCustom: { a: '#ff0000', b: '#0000ff', angle: 90 } }).stops, ['#ff0000', '#0000ff']);
  assert.deepEqual(backdropColours({ nameGradient: 'ocean' }).stops, [...GRADIENT_BACKDROPS.ocean]);
  assert.equal(backdropColours({ nameColour: '#e5487f' }).from, 'name');
  assert.deepEqual(backdropColours({}).stops, [...BACKDROP_DEFAULT]);
  assert.deepEqual(backdropColours(null).stops, [...BACKDROP_DEFAULT]);
  assert.equal(backdropColours({ accent: 'red; background: url(x)' }).from, 'default');
  assert.equal(backdropColours({ theme: 'custom', themeCustom: { base: 'nope', alt: '#445566', accent: '#778899' } }).from, 'default');
});

test('only checked hex colours reach the page, as custom properties and never inline style text', () => {
  assert.equal(avatarIdOf('/avatar-img/a-abcdefghij-0123456789abcdef.png'), 'a-abcdefghij');
  assert.equal(avatarIdOf('/avatar-img/a-abcdefghij-0123456789abcdef-still.webp'), 'a-abcdefghij');
  assert.equal(avatarIdOf('https://files.yapper.website/a.png'), null);
  assert.equal(avatarIdOf('/avatar-img/a-abcdefghij-0123456789abcdef.png?x=1'), null);
  assert.equal(cleanColours({ stops: ['#ff0000', 'red'] }), null);
  assert.equal(cleanColours({ stops: ['#ff0000'] }), null);
  assert.deepEqual(cleanColours({ stops: ['#ff0000', '#0000ff'], ring: 'javascript:' }), { stops: ['#ff0000', '#0000ff', '#800080'], ring: '#ff0000' });
  assert.equal(cleanInfo({ cut: false, moving: false }), null);
  assert.equal(cleanInfo({ cut: 'yes' }), null);
  const props = {};
  const classes = new Set();
  const el = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => delete props[k] } };
  assert.equal(paintBackdrop(el, cleanInfo({ cut: true, stops: ['#112233', '#445566'], ring: '#778899' })), true);
  assert.deepEqual([...classes], ['av-cut']);
  assert.deepEqual(props, { '--av-bd-1': '#112233', '--av-bd-2': '#445566', '--av-bd-3': '#2b3c4d', '--av-ring': '#778899' });
  assert.equal(paintBackdrop(el, cleanInfo({ moving: true, stops: ['#112233', '#445566'] })), true);
  assert.deepEqual([...classes], ['av-ring']);
  assert.equal(paintBackdrop(el, cleanInfo({ cut: true, stops: ['#112233', 'x'] })), false);
  assert.deepEqual([...classes], []);
  assert.deepEqual(props, {});
});

test('cut-outs are encoded with see-through formats only and shrink to fit the still limit', () => {
  const calls = [];
  const canvas = {
    width: 256,
    toDataURL(type) {
      calls.push([this.width, type]);
      return type === 'image/png' ? `data:image/png;base64,${'A'.repeat(this.width === 128 ? 100 : 400000)}` : 'data:image/png;base64,AAAA';
    },
  };
  const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: canvas.toDataURL }) };
  const url = encodeCutout(canvas, { doc, max: 200 * 1024 });
  assert.match(url, /^data:image\/png/);
  assert.ok(calls.every(([, type]) => type !== 'image/jpeg'), 'never JPEG, which loses the see-through parts');
  assert.throws(() => encodeCutout({ width: 64, toDataURL: () => `data:image/png;base64,${'A'.repeat(400000)}` }, { doc, max: 1000 }), /too detailed/);
});

function seedPublic(h, user) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 5, 400, NULL, '[]', '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(user.id.toLowerCase(), user.username, user.username.toLowerCase(), user.display_name, h.clock.t);
}

function setLook(h, user, look) {
  h.db.raw.prepare('INSERT INTO profile_custom (user_id, v, data, updated) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated').run(user.id.toLowerCase(), JSON.stringify({ v: 1, ...look }), h.clock.t);
}

async function setup() {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  return { h, alice };
}

const idOf = (url) => /a-[a-z0-9]{10}/.exec(url)[0];

async function looks(h, ids) {
  const res = await h.request('GET', `/api/avatars/looks?ids=${ids.join(',')}`, { ip: nextIp() });
  assert.equal(res.status, 200);
  return (await res.json()).looks;
}

test('a cut-out upload keeps the original, is flagged, and its backdrop follows the profile colours', async () => {
  const { h, alice } = await setup();
  const first = await (await h.api('POST', API, alice, { image: b64(devBannerPng(128, 128)) })).json();
  const id = idOf(first.custom.url);
  assert.equal(first.cutout, null);
  assert.deepEqual(await looks(h, [id]), {});
  const res = await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'upload' });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.cutout, { source: 'upload', backdrop: 'theme', canRestore: true });
  assert.equal(idOf(body.custom.url), id, 'the picture keeps its id so every page finds it');
  let got = await looks(h, [id]);
  assert.deepEqual(got[id], { cut: true, moving: false, clear: false, stops: [...BACKDROP_DEFAULT], ring: '#9aa1b5' });
  setLook(h, ALICE, { theme: 'sakura' });
  const sakura = THEMES.find((t) => t.id === 'sakura');
  got = await looks(h, [id]);
  assert.deepEqual(got[id].stops, [sakura.base, sakura.alt]);
  setLook(h, ALICE, { accent: '#2f8fe8' });
  got = await looks(h, [id]);
  assert.equal(got[id].stops[0], '#2f8fe8');
  const original = await h.api('GET', `${API}/original`, alice);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), devBannerPng(128, 128));
  const again = await h.api('POST', API, alice, { image: b64(cutPng(128)), cutout: true, source: 'upload', backdrop: 'clear' });
  assert.equal(again.status, 201);
  const kept = await h.api('GET', `${API}/original`, alice);
  assert.deepEqual(Buffer.from(await kept.arrayBuffer()), devBannerPng(128, 128), 'cutting again keeps the first original');
  got = await looks(h, [id]);
  assert.equal(got[id].clear, true);
});

test('the backdrop can be switched and the background put back from the kept original', async () => {
  const { h, alice } = await setup();
  await h.api('POST', API, alice, { image: b64(devBannerPng(128, 128)) });
  const cut = await (await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'upload' })).json();
  const id = idOf(cut.custom.url);
  const clear = await h.api('PATCH', API, alice, { backdrop: 'clear' });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).cutout.backdrop, 'clear');
  assert.equal((await looks(h, [id]))[id].clear, true);
  const back = await h.api('PATCH', API, alice, { cutout: false });
  assert.equal(back.status, 200, await back.clone().text());
  const state = await back.json();
  assert.equal(state.cutout, null);
  assert.notEqual(state.custom.url, cut.custom.url);
  const img = await h.request('GET', state.custom.url);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), devBannerPng(128, 128));
  assert.deepEqual(await looks(h, [id]), {});
  assert.equal((await h.api('PATCH', API, alice, { backdrop: 'theme' })).status, 404, 'nothing to change once the background is back');
  assert.equal((await h.api('GET', `${API}/original`, alice)).status, 404);
});

test('a cut-out of the Yapin picture goes away completely when the background is put back', async () => {
  const { h, alice } = await setup();
  const res = await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'yapin' });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.cutout, { source: 'yapin', backdrop: 'theme', canRestore: true });
  const back = await (await h.api('PATCH', API, alice, { cutout: false })).json();
  assert.equal(back.custom, null);
  assert.equal(back.avatar, ALICE.avatar_url);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_cutouts').get().n, 0);
});

test('cut-out uploads are checked and a plain upload clears the flag', async () => {
  const { h, alice } = await setup();
  const code = async (body, method = 'POST') => {
    advance(h, 61 * 1000);
    const r = await h.api(method, API, alice, body);
    return [r.status, (await r.json()).error];
  };
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: true, source: 'upload' }), [400, 'no_original']);
  assert.deepEqual(await code({ image: b64(devBannerPng(96, 96)), cutout: true, source: 'yapin' }), [400, 'bad_cutout'], 'an opaque picture is not a cut-out');
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: 'yes', source: 'yapin' }), [400, 'bad_cutout']);
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: true }), [400, 'bad_cutout']);
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: true, source: 'web' }), [400, 'bad_cutout']);
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: true, source: 'yapin', backdrop: 'rainbow' }), [400, 'bad_backdrop']);
  assert.deepEqual(await code({ image: b64(cutPng()), backdrop: 'theme' }), [400, 'bad_request']);
  assert.deepEqual(await code({ image: b64(cutPng()), cutout: true, source: 'yapin', extra: 1 }), [400, 'bad_request']);
  const gif = makeGif({ width: 64, height: 64, frames: 3 });
  assert.deepEqual(await code({ image: b64(gif), still: b64(devBannerPng(64, 64)), cutout: true, source: 'upload' }), [400, 'bad_cutout']);
  assert.deepEqual(await code({ cutout: true }, 'PATCH'), [400, 'bad_cutout']);
  assert.deepEqual(await code({ backdrop: 'dots' }, 'PATCH'), [400, 'bad_backdrop']);
  assert.deepEqual(await code({ nope: 1 }, 'PATCH'), [400, 'bad_request']);
  assert.deepEqual(await code({}, 'PATCH'), [400, 'bad_request']);
  assert.deepEqual(await code({ cutout: false }, 'PATCH'), [404, 'no_cutout']);
  advance(h, 61 * 1000);
  const cut = await (await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'yapin' })).json();
  const id = idOf(cut.custom.url);
  assert.equal((await looks(h, [id]))[id].cut, true);
  const plain = await (await h.api('POST', API, alice, { image: b64(devBannerPng(96, 96)) })).json();
  assert.equal(plain.cutout, null);
  assert.deepEqual(await looks(h, [id]), {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_cutouts').get().n, 0);
});

test('moving pictures get a ring in the profile colours, and private profiles share nothing', async () => {
  const { h, alice } = await setup();
  setLook(h, ALICE, { theme: 'ocean' });
  const gif = makeGif({ width: 64, height: 64, frames: 3 });
  const up = await (await h.api('POST', API, alice, { image: b64(gif), still: b64(devBannerPng(64, 64)) })).json();
  const id = idOf(up.custom.url);
  const ocean = THEMES.find((t) => t.id === 'ocean');
  assert.deepEqual((await looks(h, [id, 'a-zzzzzzzzzz', 'junk', '../x']))[id], { cut: false, moving: true, clear: false, stops: [ocean.base, ocean.alt], ring: ocean.accent });
  h.db.raw.prepare('UPDATE public_profiles SET hidden = 1 WHERE user_id = ?').run(ALICE.id.toLowerCase());
  assert.deepEqual(await looks(h, [id]), {});
  const many = Array.from({ length: 41 }, (_, i) => `a-${String(i).padStart(10, '0')}`);
  assert.deepEqual(await looks(h, many), {});
  const res = await h.request('GET', `/api/avatars/looks?ids=${'a-0000000000,'.repeat(60)}`, { ip: nextIp() });
  assert.equal(res.status, 413);
  assert.equal((await h.request('POST', '/api/avatars/looks', { ip: nextIp() })).status, 405);
});

test('removing the picture or cleanup removes the cut-out row too', async () => {
  const { h, alice } = await setup();
  await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'yapin' });
  await h.api('DELETE', API, alice);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_cutouts').get().n, 0);
  await h.api('POST', API, alice, { image: b64(cutPng()), cutout: true, source: 'yapin' });
  h.db.raw.prepare("UPDATE profile_avatar_cutouts SET avatar_hash = '0000000000000000'").run();
  await cleanup(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_cutouts').get().n, 0);
});

test('the Yapin picture is copied through the site so the browser can cut it out', async () => {
  const { h, alice } = await setup();
  const png = devBannerPng(96, 96);
  let mode = 'ok';
  const seen = [];
  const worker = createWorker({
    now: () => h.clock.t,
    log: () => {},
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      if (mode === 'down') throw new Error('offline');
      if (mode === 'html') return new Response('<html>', { status: 200 });
      if (mode === 'big') return new Response(new Uint8Array(10), { status: 200, headers: { 'Content-Length': String(3 * 1024 * 1024) } });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  });
  const get = (p) => worker.fetch(new Request(`${h.base}${p}`, { headers: { Cookie: alice, 'CF-Connecting-IP': nextIp() } }), h.env, { waitUntil() {} });
  const res = await get(`${API}/yapin`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  assert.equal(seen[0].url, ALICE.avatar_url, 'only the signed-in person’s own Yapin picture is fetched');
  assert.equal(seen[0].init.redirect, 'error');
  mode = 'down';
  assert.equal((await get(`${API}/yapin`)).status, 502);
  mode = 'html';
  assert.equal((await get(`${API}/yapin`)).status, 502);
  mode = 'big';
  assert.equal((await get(`${API}/yapin`)).status, 413);
  assert.equal((await get(`${API}/nothing`)).status, 404);
  assert.equal((await h.request('GET', `${API}/yapin`, { ip: nextIp() })).status, 401);
});

test('stylesheets: the site links the backdrop sheet and the Party loads its own lazily', () => {
  const html = readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/css\/avatar-backdrop.css">/);
  const site = readFileSync(path.join(web, 'css', 'avatar-backdrop.css'), 'utf8');
  assert.match(site, /\.avatar\.av-cut \{/);
  assert.match(site, /\.avatar\.av-ring::after \{/);
  const party = readFileSync(path.join(web, 'activity', 'css', 'avatar-backdrop.css'), 'utf8');
  assert.ok(party.length <= 2000);
  assert.equal(readFileSync(path.join(web, 'activity', 'index.html'), 'utf8').includes('avatar-backdrop.css'), false);
  assert.ok(readFileSync(path.join(web, 'activity', 'js', 'ui', 'cardlook.js'), 'utf8').includes('/activity/css/avatar-backdrop.css'));
  for (const f of ['js/avatar-backdrop.js', 'js/avatar-cutout.js', 'js/avatar-cutout-worker.js', 'js/pages/avatar-editor.js']) {
    const src = readFileSync(path.join(web, f), 'utf8');
    assert.equal(/\.style\.(?!setProperty|removeProperty)[a-zA-Z]/.test(src), false, `${f} only sets custom properties`);
    assert.equal(/\.style\s*=|cssText|setAttribute\(['"]style/.test(src), false, f);
  }
});
