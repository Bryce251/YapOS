export const ANIM_MAX_BYTES = 900 * 1024;
export const ANIM_MAX_FRAMES = 600;
export const ANIM_MIN_W = 300;
export const ANIM_MAX_W = 3000;
export const ANIM_MIN_H = 100;
export const ANIM_MAX_H = 1000;
export const ANIM_MAX_RATIO = 6;
export const ANIM_MAX_PIXELS = 500_000_000;
export const ANIM_TRAILING_MAX = 64;

export class AnimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BROKEN = "That moving picture couldn't be read. It may be damaged. Try saving it again.";
const broken = () => new AnimError('bad_image', BROKEN);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + b[i + 3] * 0x1000000;

function outside() {
  return new AnimError('bad_image', 'That moving picture has frames bigger than the picture itself. Save it again with an image editor.');
}

function tooMany(max = ANIM_MAX_FRAMES, noun = 'banners') {
  return new AnimError('too_many_frames', `Animated ${noun} can have up to ${max} frames. Make the GIF shorter and try again.`);
}

function join(parts, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function subBlocks(b, j) {
  let i = j;
  for (;;) {
    if (i >= b.length) throw broken();
    const n = b[i];
    i += 1;
    if (n === 0) return i;
    i += n;
  }
}

function zeroTail(b, from) {
  if (b.length - from > ANIM_TRAILING_MAX) return false;
  for (let i = from; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

export function isGif(b) {
  return b instanceof Uint8Array && b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a');
}

export function readGif(bytes, { maxFrames = ANIM_MAX_FRAMES, noun = 'banners' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (!isGif(b) || b.length < 14) throw broken();
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  if (!width || !height) throw broken();
  const packed = b[10];
  let i = 13;
  if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
  if (i > b.length) throw broken();
  const keep = [b.subarray(0, i)];
  let total = i;
  let frames = 0;
  let looped = false;
  let end = -1;
  while (end < 0) {
    if (i >= b.length) throw broken();
    const c = b[i];
    if (c === 0x3b) {
      end = i + 1;
      break;
    }
    if (c === 0x21) {
      if (i + 2 > b.length) throw broken();
      const label = b[i + 1];
      if (label === 0xf9) {
        if (i + 8 > b.length || b[i + 2] !== 4 || b[i + 7] !== 0) throw broken();
        keep.push(b.subarray(i, i + 8));
        total += 8;
        i += 8;
        continue;
      }
      const next = subBlocks(b, i + 2);
      if (label === 0xff && b[i + 2] === 11) {
        const app = ascii(b, i + 3, 11);
        if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && !looped && b[i + 14] === 3 && b[i + 15] === 1) {
          const loop = new Uint8Array(19);
          loop.set(b.subarray(i, i + 18));
          keep.push(loop);
          total += 19;
          looped = true;
        }
      }
      i = next;
      continue;
    }
    if (c === 0x2c) {
      if (i + 10 > b.length) throw broken();
      const fw = u16le(b, i + 5);
      const fh = u16le(b, i + 7);
      if (!fw || !fh) throw broken();
      if (u16le(b, i + 1) + fw > width || u16le(b, i + 3) + fh > height) throw outside();
      const lp = b[i + 9];
      let j = i + 10;
      if (lp & 0x80) j += 3 * (1 << ((lp & 7) + 1));
      if (j >= b.length) throw broken();
      const code = b[j];
      if (code < 1 || code > 8) throw broken();
      if (!(packed & 0x80) && !(lp & 0x80)) throw broken();
      const next = subBlocks(b, j + 1);
      frames += 1;
      if (frames > maxFrames) throw tooMany(maxFrames, noun);
      keep.push(b.subarray(i, next));
      total += next - i;
      i = next;
      continue;
    }
    throw broken();
  }
  if (!frames) throw broken();
  if (!zeroTail(b, end)) throw new AnimError('bad_image', 'That GIF has extra data hidden after the picture, so it was not used. Save it again with an image editor.');
  keep.push(b.subarray(end - 1, end));
  total += 1;
  return { mime: 'image/gif', width, height, frames, bytes: join(keep, total) };
}

export function isWebp(b) {
  return b instanceof Uint8Array && b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
}

export function webpAnimated(b) {
  return isWebp(b) && b.length >= 30 && ascii(b, 12, 4) === 'VP8X' && (b[20] & 0x02) !== 0;
}

function bitstreamSize(b, id, at, size) {
  if (id === 'VP8L') {
    if (size < 5 || b[at] !== 0x2f) return null;
    const bits = u32le(b, at + 1);
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (size < 10 || b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return null;
  return { w: u16le(b, at + 6) & 0x3fff, h: u16le(b, at + 8) & 0x3fff };
}

function frameChunks(b, from, to, fw, fh) {
  let i = from;
  let image = false;
  while (i < to) {
    if (i + 8 > to) throw broken();
    const id = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const stop = i + 8 + size + (size & 1);
    if (i + 8 + size > to) throw broken();
    if (id === 'VP8 ' || id === 'VP8L') {
      if (image) throw broken();
      const dims = bitstreamSize(b, id, i + 8, size);
      if (!dims || dims.w !== fw || dims.h !== fh) throw outside();
      image = true;
    } else if (id !== 'ALPH' || image) throw broken();
    i = Math.min(stop, to);
  }
  if (!image) throw broken();
}

export function readAnimWebp(bytes, { maxFrames = ANIM_MAX_FRAMES, noun = 'banners' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (!isWebp(b) || b.length < 30) throw broken();
  if (u32le(b, 4) + 8 !== b.length) throw broken();
  if (ascii(b, 12, 4) !== 'VP8X' || u32le(b, 16) !== 10) throw broken();
  if (!(b[20] & 0x02)) throw new AnimError('not_animated', `That WebP doesn't move. Upload it as a normal ${noun === 'banners' ? 'banner' : 'picture'}.`);
  const width = 1 + u24le(b, 24);
  const height = 1 + u24le(b, 27);
  const head = new Uint8Array(30);
  head.set(b.subarray(0, 30));
  head[20] = b[20] & ~0x0c & 0x3e;
  const keep = [head];
  let total = 30;
  let frames = 0;
  let anim = false;
  let icc = false;
  let i = 30;
  while (i < b.length) {
    if (i + 8 > b.length) throw broken();
    const id = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const end = i + 8 + size;
    const padded = end + (size & 1);
    if (end > b.length || padded > b.length) throw broken();
    if (id === 'ANIM') {
      if (size !== 6 || anim || frames) throw broken();
      anim = true;
      keep.push(b.subarray(i, padded));
      total += padded - i;
    } else if (id === 'ICCP') {
      if (icc || anim || frames) throw broken();
      icc = true;
      keep.push(b.subarray(i, padded));
      total += padded - i;
    } else if (id === 'ANMF') {
      if (!anim || size < 24) throw broken();
      const p = i + 8;
      const fx = 2 * u24le(b, p);
      const fy = 2 * u24le(b, p + 3);
      const fw = 1 + u24le(b, p + 6);
      const fh = 1 + u24le(b, p + 9);
      if (fx + fw > width || fy + fh > height) throw broken();
      frameChunks(b, p + 16, end, fw, fh);
      frames += 1;
      if (frames > maxFrames) throw tooMany(maxFrames, noun);
      keep.push(b.subarray(i, padded));
      total += padded - i;
    } else if (id === 'VP8 ' || id === 'VP8L' || id === 'ALPH' || id === 'VP8X') {
      throw broken();
    }
    i = padded;
  }
  if (!anim || !frames) throw broken();
  if (!icc) head[20] &= ~0x20;
  const out = join(keep, total);
  const size = total - 8;
  out[4] = size & 255;
  out[5] = (size >>> 8) & 255;
  out[6] = (size >>> 16) & 255;
  out[7] = (size >>> 24) & 255;
  return { mime: 'image/webp', width, height, frames, bytes: out };
}

export function pngAnimated(b) {
  if (!(b instanceof Uint8Array) || b.length < 16 || b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG') return false;
  let i = 8;
  while (i + 8 <= b.length) {
    const size = b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const id = ascii(b, i + 4, 4);
    if (id === 'acTL' || id === 'fcTL' || id === 'fdAT') return true;
    if (id === 'IEND') return false;
    i += 12 + size;
  }
  return false;
}

export function readAnimated(bytes, opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (isGif(b)) return readGif(b, opts);
  if (isWebp(b)) return readAnimWebp(b, opts);
  throw new AnimError('bad_image', `Animated ${opts.noun || 'banners'} must be a GIF or an animated WebP.`);
}

export function checkAnimSize({ width, height, frames }) {
  if (width < ANIM_MIN_W || width > ANIM_MAX_W || height < ANIM_MIN_H || height > ANIM_MAX_H) {
    throw new AnimError('bad_image_size', `Animated banners must be ${ANIM_MIN_W} to ${ANIM_MAX_W} pixels wide and ${ANIM_MIN_H} to ${ANIM_MAX_H} pixels tall.`);
  }
  if (width < height || width > height * ANIM_MAX_RATIO) {
    throw new AnimError('bad_image_size', `Animated banners must be at least as wide as they are tall, and up to ${ANIM_MAX_RATIO} times as wide.`);
  }
  if (width * height * frames > ANIM_MAX_PIXELS) {
    throw new AnimError('too_many_frames', 'That GIF has too many big frames to play smoothly. Make it shorter or smaller and try again.');
  }
}

export function animatedFrames(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  try {
    if (isGif(b)) return readGif(b).frames;
    if (webpAnimated(b)) return readAnimWebp(b).frames;
  } catch {
    return -1;
  }
  return 0;
}
