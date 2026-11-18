export function lzw(indices, minCode) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let buf = 0;
  let len = 0;
  const emit = (code) => {
    buf |= code << len;
    len += size;
    while (len >= 8) {
      out.push(buf & 255);
      buf >>>= 8;
      len -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << size) size += 1;
      dict.set(key, next);
      next += 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (len > 0) out.push(buf & 255);
  return out;
}

function blocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const part = data.slice(i, i + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

const u16 = (v) => [v & 255, (v >> 8) & 255];

export const GIF_COLOURS = Object.freeze([[255, 93, 143], [255, 209, 102], [6, 214, 160], [76, 201, 240]]);

export function makeGif({ width = 600, height = 200, frames = 3, full = false, comment = null, xmp = false, loop = true, tail = null, version = 'GIF89a', globalTable = true } = {}) {
  const out = [...Buffer.from(version, 'ascii'), ...u16(width), ...u16(height), globalTable ? 0xf1 : 0x00, 0, 0];
  if (globalTable) for (const c of GIF_COLOURS) out.push(...c);
  if (loop) out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, 0, 0, 0);
  if (comment !== null) {
    out.push(0x21, 0xfe);
    for (const b of blocks([...Buffer.from(comment, 'utf8')])) out.push(b);
  }
  if (xmp) out.push(0x21, 0xff, 11, ...Buffer.from('XMP DataXMP', 'ascii'), ...blocks([...Buffer.from('<x:xmpmeta/>', 'ascii')]));
  for (let f = 0; f < frames; f++) {
    out.push(0x21, 0xf9, 4, 0x04, ...u16(8), 0, 0);
    const fw = full ? width : 1;
    const fh = full ? height : 1;
    out.push(0x2c, 0, 0, 0, 0, ...u16(fw), ...u16(fh), 0);
    const pixels = new Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) pixels[y * fw + x] = Math.floor((x / Math.max(1, fw)) * 4 + f) % 4;
    out.push(2, ...blocks(lzw(pixels, 2)));
  }
  out.push(0x3b);
  if (tail) out.push(...tail);
  return Uint8Array.from(out);
}

function chunk(id, data) {
  const body = [...data];
  const out = [...Buffer.from(id, 'ascii'), body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, (body.length >>> 24) & 255, ...body];
  if (body.length & 1) out.push(0);
  return out;
}

const u24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];

export function makeAnimWebp({ width = 600, height = 200, frames = 2, exif = false, xmp = false, animFlag = true, anim = true, frame = null, unknown = false, iccFirst = false } = {}) {
  const flags = (animFlag ? 0x02 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0) | (iccFirst ? 0x20 : 0) | 0x10;
  const body = [...Buffer.from('WEBP', 'ascii'), ...chunk('VP8X', [flags, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)])];
  if (iccFirst) body.push(...chunk('ICCP', [1, 2, 3, 4]));
  if (anim) body.push(...chunk('ANIM', [0, 0, 0, 0, 0, 0]));
  for (let f = 0; f < frames; f++) {
    const fr = frame || { x: 0, y: 0, w: width, h: height, image: 'VP8L' };
    const bw = fr.bw || fr.w;
    const bh = fr.bh || fr.h;
    const bits = ((bw - 1) | ((bh - 1) << 14)) >>> 0;
    const sub = fr.image ? chunk(fr.image, [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]) : chunk('ALPH', [1, 2, 3]);
    body.push(...chunk('ANMF', [...u24(fr.x / 2), ...u24(fr.y / 2), ...u24(fr.w - 1), ...u24(fr.h - 1), ...u24(80), 0, ...sub]));
  }
  if (exif) body.push(...chunk('EXIF', [...Buffer.from('Exif secret gps', 'ascii')]));
  if (xmp) body.push(...chunk('XMP ', [...Buffer.from('<x:xmpmeta/>', 'ascii')]));
  if (unknown) body.push(...chunk('ZZZZ', [...Buffer.from('<script>', 'ascii')]));
  const size = body.length;
  return Uint8Array.from([...Buffer.from('RIFF', 'ascii'), size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, ...body]);
}
