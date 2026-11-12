import zlib from 'node:zlib';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export class PngError extends Error {
  constructor(message, code = 'decode') {
    super(message);
    this.code = code;
  }
}

export function readPngChunks(buf) {
  if (buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) throw new PngError('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const start = pos + 8;
    if (start + len > buf.length) {
      if (type === 'IDAT') idat.push(buf.subarray(start));
      break;
    }
    const body = buf.subarray(start, start + len);
    if (!header && type !== 'IHDR') throw new PngError('the header is not first');
    if (type === 'IHDR') {
      if (header) throw new PngError('more than one header');
      if (len < 13) throw new PngError('bad header');
      header = { width: view.getUint32(start), height: view.getUint32(start + 4), depth: buf[start + 8], colorType: buf[start + 9], interlace: buf[start + 12] };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos = start + len + 4;
  }
  if (!header) throw new PngError('no header');
  if (!CHANNELS[header.colorType] || !DEPTHS[header.colorType].includes(header.depth)) throw new PngError('unsupported PNG format', 'unsupported');
  if (!idat.length) throw new PngError('no picture data');
  return { ...header, palette, trns, idat };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(type, cur, prev, bpp, n) {
  if (type === 0) return;
  if (type === 1) {
    for (let i = bpp + 1; i <= n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255;
  } else if (type === 2) {
    for (let i = 1; i <= n; i++) cur[i] = (cur[i] + prev[i]) & 255;
  } else if (type === 3) {
    for (let i = 1; i <= n; i++) cur[i] = (cur[i] + ((i > bpp ? cur[i - bpp] : 0) + prev[i] >> 1)) & 255;
  } else if (type === 4) {
    for (let i = 1; i <= n; i++) {
      const a = i > bpp ? cur[i - bpp] : 0;
      const c = i > bpp ? prev[i - bpp] : 0;
      cur[i] = (cur[i] + paeth(a, prev[i], c)) & 255;
    }
  } else {
    throw new PngError('bad row filter');
  }
}

function makeConverter(info) {
  const { width, depth, colorType, palette, trns } = info;
  const u16 = (b, i) => (b[i] << 8) | b[i + 1];
  let tGray = -1;
  let tRgb = null;
  if (trns && colorType === 0 && trns.length >= 2) tGray = u16(trns, 0);
  if (trns && colorType === 2 && trns.length >= 6) tRgb = [u16(trns, 0), u16(trns, 2), u16(trns, 4)];
  const pal = new Uint8Array(256 * 4);
  if (colorType === 3) {
    for (let i = 0; i < 256; i++) {
      if (palette && i * 3 + 2 < palette.length) {
        pal[i * 4] = palette[i * 3];
        pal[i * 4 + 1] = palette[i * 3 + 1];
        pal[i * 4 + 2] = palette[i * 3 + 2];
      }
      pal[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
    }
  }
  const max = (1 << depth) - 1;
  return (src, out) => {
    let alpha = false;
    if (depth < 8) {
      const perByte = 8 / depth;
      for (let x = 0; x < width; x++) {
        const byte = src[1 + Math.floor(x / perByte)];
        const v = (byte >> (8 - depth * ((x % perByte) + 1))) & max;
        const o = x * 4;
        if (colorType === 3) {
          out[o] = pal[v * 4]; out[o + 1] = pal[v * 4 + 1]; out[o + 2] = pal[v * 4 + 2]; out[o + 3] = pal[v * 4 + 3];
        } else {
          const g = Math.round((v * 255) / max);
          out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = v === tGray ? 0 : 255;
        }
        if (out[o + 3] < 255) alpha = true;
      }
      return alpha;
    }
    const step = depth === 16 ? 2 : 1;
    const ch = CHANNELS[colorType];
    for (let x = 0; x < width; x++) {
      const i = 1 + x * ch * step;
      const o = x * 4;
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 3) {
        const v = src[i];
        r = pal[v * 4]; g = pal[v * 4 + 1]; b = pal[v * 4 + 2]; a = pal[v * 4 + 3];
      } else if (colorType === 0) {
        r = g = b = src[i];
        if (tGray >= 0 && (step === 2 ? u16(src, i) : src[i]) === tGray) a = 0;
      } else if (colorType === 4) {
        r = g = b = src[i];
        a = src[i + step];
      } else {
        r = src[i]; g = src[i + step]; b = src[i + 2 * step];
        if (colorType === 6) a = src[i + 3 * step];
        else if (tRgb && (step === 2 ? u16(src, i) === tRgb[0] && u16(src, i + 2) === tRgb[1] && u16(src, i + 4) === tRgb[2] : r === tRgb[0] && g === tRgb[1] && b === tRgb[2])) a = 0;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      if (a < 255) alpha = true;
    }
    return alpha;
  };
}

export async function decodePng(buf, { maxPixels = Infinity, maxSide = 4096, maxInterlacedPixels = 4 * 1024 * 1024, expectWidth = null, expectHeight = null, onRow, onSize = null }) {
  const info = readPngChunks(buf);
  const { width, height } = info;
  if (!width || !height) throw new PngError('empty picture');
  if (width > maxSide || height > maxSide || width * height > maxPixels) throw new PngError('too many pixels', 'pixels');
  if ((expectWidth != null && width !== expectWidth) || (expectHeight != null && height !== expectHeight)) throw new PngError('PNG sizes disagree', 'pixels');
  onSize?.(width, height);
  if (info.interlace) {
    if (width * height > maxInterlacedPixels) throw new PngError('interlaced picture is too big', 'memory');
    const img = PNG.sync.read(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    let alpha = false;
    for (let y = 0; y < height; y++) {
      const row = img.data.subarray(y * width * 4, (y + 1) * width * 4);
      for (let x = 3; x < row.length && !alpha; x += 4) if (row[x] < 255) alpha = true;
      onRow(row, y);
    }
    return { width, height, alpha };
  }
  const bitsPerPixel = CHANNELS[info.colorType] * info.depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let cur = new Uint8Array(rowBytes + 1);
  let prev = new Uint8Array(rowBytes + 1);
  const out = new Uint8Array(width * 4);
  const convert = makeConverter(info);
  let filled = 0;
  let y = 0;
  let alpha = false;
  const inflate = zlib.createInflate({ chunkSize: 64 * 1024 });
  const feed = (async () => {
    for (const part of info.idat) {
      if (!inflate.write(part)) await new Promise((r) => inflate.once('drain', r));
    }
    inflate.end();
  })();
  feed.catch(() => {});
  try {
    for await (const chunk of inflate) {
      let i = 0;
      while (i < chunk.length && y < height) {
        const take = Math.min(chunk.length - i, cur.length - filled);
        cur.set(chunk.subarray(i, i + take), filled);
        filled += take;
        i += take;
        if (filled === cur.length) {
          unfilter(cur[0], cur, prev, bpp, rowBytes);
          if (convert(cur, out)) alpha = true;
          onRow(out, y);
          y++;
          filled = 0;
          const t = prev;
          prev = cur;
          cur = t;
        }
      }
      if (y >= height) break;
    }
  } catch (e) {
    if (y === 0) throw new PngError(`could not unpack the picture: ${e.message}`);
  } finally {
    inflate.destroy();
  }
  if (y === 0) throw new PngError('no rows');
  if (y < height) {
    alpha = true;
    out.fill(0);
    for (; y < height; y++) onRow(out, y);
  }
  return { width, height, alpha };
}
