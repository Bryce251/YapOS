import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGif, makeAnimWebp } from './motion-fixtures.js';
import { AnimError, readGif, readAnimWebp, pngAnimated } from '../web/js/banner-anim.js';
import { decodeBanner, decodeStill } from '../worker/profile-custom.js';
import { devBannerPng } from '../dev.mjs';

const code = (c) => (e) => e instanceof AnimError && e.code === c;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function withFrameRect(gif, { x = 0, y = 0, w, h }) {
  const out = Uint8Array.from(gif);
  for (let i = 13 + 12; i < out.length - 10; i++) {
    if (out[i] === 0x2c && out[i - 1] === 0 && out[i - 7] === 0xf9) {
      out[i + 1] = x & 255;
      out[i + 2] = x >> 8;
      out[i + 3] = y & 255;
      out[i + 4] = y >> 8;
      out[i + 5] = w & 255;
      out[i + 6] = w >> 8;
      out[i + 7] = h & 255;
      out[i + 8] = h >> 8;
      return out;
    }
  }
  throw new Error('no frame');
}

test('GIF frames larger than the canvas are refused so browsers cannot grow the picture', () => {
  const gif = makeGif({ width: 600, height: 200, frames: 2 });
  assert.equal(readGif(gif).frames, 2);
  assert.throws(() => readGif(withFrameRect(gif, { w: 65535, h: 65535 })), code('bad_image'));
  assert.throws(() => readGif(withFrameRect(gif, { x: 600, w: 1, h: 1 })), code('bad_image'));
  assert.throws(() => readGif(withFrameRect(gif, { y: 200, w: 1, h: 1 })), code('bad_image'));
  assert.equal(readGif(withFrameRect(gif, { x: 599, y: 199, w: 1, h: 1 })).frames, 2);
});

test('GIF loop blocks are rebuilt so nothing can hide inside them', () => {
  const base = Array.from(makeGif({ width: 600, height: 200, frames: 2, loop: false }));
  const head = 13 + 12;
  const payload = [...Buffer.from('<script>alert(1)</script>', 'ascii')];
  const loop = [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, 0, 0, payload.length, ...payload, 0];
  const twice = [...loop, ...loop];
  const gif = Uint8Array.from([...base.slice(0, head), ...twice, ...base.slice(head)]);
  const out = readGif(gif);
  const text = Buffer.from(out.bytes).toString('latin1');
  assert.equal(text.includes('<script>'), false);
  assert.equal(text.split('NETSCAPE2.0').length - 1, 1, 'only one loop block is kept');
  const at = text.indexOf('NETSCAPE2.0') - 3;
  assert.deepEqual(Array.from(out.bytes.subarray(at, at + 19)), [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, 0, 0, 0]);
  const odd = [0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'ascii'), 5, 9, 9, 9, 9, 9, 0];
  const dropped = readGif(Uint8Array.from([...base.slice(0, head), ...odd, ...base.slice(head)]));
  assert.equal(Buffer.from(dropped.bytes).toString('latin1').includes('NETSCAPE'), false);
});

test('animated WebP frame pictures must match their frame size', () => {
  assert.equal(readAnimWebp(makeAnimWebp({ frames: 2 })).frames, 2);
  assert.throws(() => readAnimWebp(makeAnimWebp({ frame: { x: 0, y: 0, w: 10, h: 10, bw: 16384, bh: 16384, image: 'VP8L' } })), code('bad_image'));
  assert.throws(() => readAnimWebp(makeAnimWebp({ frame: { x: 0, y: 0, w: 600, h: 200, bw: 600, bh: 201, image: 'VP8L' } })), code('bad_image'));
  assert.throws(() => readAnimWebp(makeAnimWebp({ frame: { x: 0, y: 0, w: 600, h: 200, image: 'VP8 ' } })), code('bad_image'), 'a lossy frame without a key frame header');
});

function apng(png) {
  const b = Array.from(png);
  const actl = [0, 0, 0, 8, ...Buffer.from('acTL', 'ascii'), 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...b.slice(0, 33), ...actl, ...b.slice(33)]);
}

test('moving PNGs are refused as banners and as stills', () => {
  const png = devBannerPng();
  assert.equal(pngAnimated(png), false);
  const moving = apng(png);
  assert.equal(pngAnimated(moving), true);
  assert.doesNotThrow(() => decodeBanner(b64(png)));
  assert.throws(() => decodeBanner(b64(moving)), (e) => e.code === 'bad_image' && /PNG/.test(e.message));
  const anim = { width: 1500, height: 500 };
  assert.throws(() => decodeStill(b64(moving), anim), (e) => e.code === 'bad_still');
});
