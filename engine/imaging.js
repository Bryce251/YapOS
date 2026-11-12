import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import opentype from 'opentype.js';
import gifenc from 'gifenc';
import omggif from 'omggif';
import { decodeJpeg } from './imaging-jpeg.js';
import { decodePng } from './imaging-png.js';

const { GIFEncoder, quantize } = gifenc;
const { GifReader } = omggif;
const require = createRequire(import.meta.url);

export const GREYS = 16;
export const TRANSPARENT = 0;
export const WHITE = GREYS;
export const BLACK = 1;
const COLOURS = 256 - GREYS - 1;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const DITHER = 10;
const SAMPLE_PER_FRAME = 8192;
const SAMPLE_FRAMES = 8;

export const LIMITS = {
  maxSide: 4096,
  maxPixels: 4096 * 4096,
  maxAnimatedPixels: 2048 * 2048,
  maxStillSide: 2880,
  maxStillGifPixels: 2880 * 2880,
  maxWebpPixels: 2880 * 2880,
  maxGifFrames: 3000,
  maxCoefBytes: 40 * 1024 * 1024,
  maxInterlacedPixels: 4 * 1024 * 1024,
  outputStop: Math.floor(9.5 * 1024 * 1024) + 1024 * 1024,
  maxSeconds: 12,
};

export class ImagingError extends Error {
  constructor(message, code = 'decode') {
    super(message);
    this.code = code;
  }
}

export function bundledFontPath() {
  try {
    const file = path.join(path.dirname(require.resolve('@expo-google-fonts/roboto-condensed/package.json')), '700Bold', 'RobotoCondensed_700Bold.ttf');
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

const fonts = new Map();
export function loadFont(file) {
  if (!file) return null;
  if (fonts.has(file)) return fonts.get(file);
  let info = null;
  try {
    const bytes = fs.readFileSync(file);
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const gpos = font.tables.gpos;
    const kernLookups = [];
    if (gpos?.features && gpos.lookups) {
      const seen = new Set();
      for (const f of gpos.features) {
        if (f.tag !== 'kern') continue;
        for (const i of f.feature?.lookupListIndexes || []) {
          if (!seen.has(i) && gpos.lookups[i]?.lookupType === 2) { seen.add(i); kernLookups.push(gpos.lookups[i]); }
        }
      }
    }
    const glyphs = new Map();
    const kerns = new Map();
    const glyphFor = (ch) => {
      let g = glyphs.get(ch);
      if (g === undefined) {
        g = font.charToGlyph(ch);
        if (!g || !g.index) g = null;
        glyphs.set(ch, g);
      }
      return g;
    };
    const kern = (a, b) => {
      const key = a.index * 65536 + b.index;
      let k = kerns.get(key);
      if (k === undefined) {
        try {
          k = kernLookups.length ? font.position.getKerningValue(kernLookups, a.index, b.index) : font.getKerningValue(a, b);
        } catch {
          k = 0;
        }
        k = Number(k) || 0;
        kerns.set(key, k);
      }
      return k;
    };
    info = { font, unitsPerEm: font.unitsPerEm || 1000, glyphFor, kern };
  } catch {
    info = null;
  }
  fonts.set(file, info);
  return info;
}

export function layoutLine(info, text) {
  const placed = [];
  let x = 0;
  let prev = null;
  for (const ch of String(text)) {
    const g = info.glyphFor(ch);
    if (!g) continue;
    if (prev) x += info.kern(prev, g);
    placed.push({ glyph: g, x });
    x += g.advanceWidth || 0;
    prev = g;
  }
  return { placed, width: x };
}

export function textMeasure(file) {
  const info = loadFont(file);
  if (!info) return null;
  const cache = new Map();
  return (s, size) => {
    let units = cache.get(s);
    if (units === undefined) {
      units = layoutLine(info, s).width;
      if (cache.size > 5000) cache.clear();
      cache.set(s, units);
    }
    return (units * size) / info.unitsPerEm;
  };
}

function flatten(commands, edges) {
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const line = (x0, y0, x1, y1) => { if (y0 !== y1) edges.push(x0, y0, x1, y1); };
  const close = () => { if (cx !== sx || cy !== sy) line(cx, cy, sx, sy); cx = sx; cy = sy; };
  for (const c of commands) {
    if (c.type === 'M') {
      close();
      sx = cx = c.x;
      sy = cy = c.y;
    } else if (c.type === 'L') {
      line(cx, cy, c.x, c.y);
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Q') {
      const len = Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x - c.x1, c.y - c.y1);
      const n = Math.max(1, Math.min(32, Math.ceil(len / 1.5)));
      let px = cx;
      let py = cy;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const x = u * u * cx + 2 * u * t * c.x1 + t * t * c.x;
        const y = u * u * cy + 2 * u * t * c.y1 + t * t * c.y;
        line(px, py, x, y);
        px = x;
        py = y;
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'C') {
      const len = Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2);
      const n = Math.max(1, Math.min(48, Math.ceil(len / 1.5)));
      let px = cx;
      let py = cy;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const x = u * u * u * cx + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x;
        const y = u * u * u * cy + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y;
        line(px, py, x, y);
        px = x;
        py = y;
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Z') {
      close();
    }
  }
  close();
}

export function fillPath(edgeList, width, height, samples = 5) {
  const cover = new Float32Array(width * height);
  const count = edgeList.length / 4;
  if (!count) return cover;
  const order = Array.from({ length: count }, (_, i) => i);
  const ymin = new Float64Array(count);
  const ymax = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    ymin[i] = Math.min(edgeList[i * 4 + 1], edgeList[i * 4 + 3]);
    ymax[i] = Math.max(edgeList[i * 4 + 1], edgeList[i * 4 + 3]);
  }
  order.sort((a, b) => ymin[a] - ymin[b]);
  let next = 0;
  let active = [];
  const xs = [];
  const ds = [];
  const w = 1 / samples;
  const span = (row, xa, xb) => {
    if (xa < 0) xa = 0;
    if (xb > width) xb = width;
    if (xb <= xa) return;
    const ia = Math.floor(xa);
    const ib = Math.floor(xb);
    if (ia === ib) { cover[row + ia] += (xb - xa) * w; return; }
    cover[row + ia] += (ia + 1 - xa) * w;
    for (let i = ia + 1; i < ib; i++) cover[row + i] += w;
    if (ib < width) cover[row + ib] += (xb - ib) * w;
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let s = 0; s < samples; s++) {
      const ys = y + (s + 0.5) / samples;
      while (next < count && ymin[order[next]] <= ys) active.push(order[next++]);
      active = active.filter((e) => ymax[e] > ys);
      xs.length = 0;
      ds.length = 0;
      for (const e of active) {
        if (ymin[e] > ys) continue;
        const x0 = edgeList[e * 4];
        const y0 = edgeList[e * 4 + 1];
        const x1 = edgeList[e * 4 + 2];
        const y1 = edgeList[e * 4 + 3];
        xs.push(x0 + ((ys - y0) * (x1 - x0)) / (y1 - y0));
        ds.push(y1 > y0 ? 1 : -1);
      }
      if (xs.length < 2) continue;
      const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
      let wind = 0;
      let start = 0;
      for (const i of idx) {
        const before = wind;
        wind += ds[i];
        if (before === 0 && wind !== 0) start = xs[i];
        else if (before !== 0 && wind === 0) span(row, start, xs[i]);
      }
    }
  }
  for (let i = 0; i < cover.length; i++) if (cover[i] > 1) cover[i] = 1;
  return cover;
}

export function renderCaption(info, layout, width) {
  const height = layout.barHeight;
  const edges = [];
  const scale = layout.fontSize / info.unitsPerEm;
  layout.lines.forEach((text, i) => {
    const { placed, width: units } = layoutLine(info, text);
    const left = (width - units * scale) / 2;
    for (const p of placed) flatten(p.glyph.getPath(left + p.x * scale, layout.baselines[i], layout.fontSize).commands, edges);
  });
  return fillPath(edges, width, height);
}

export function captionIndices(cover) {
  const out = new Uint8Array(cover.length);
  for (let i = 0; i < cover.length; i++) out[i] = 1 + Math.round((1 - cover[i]) * (GREYS - 1));
  return out;
}

function axisWeights(src, dst) {
  const starts = new Int32Array(dst);
  const counts = new Int32Array(dst);
  const weights = [];
  if (dst < src) {
    const ratio = src / dst;
    for (let i = 0; i < dst; i++) {
      const a = i * ratio;
      const b = Math.min(src, (i + 1) * ratio);
      const first = Math.floor(a);
      const last = Math.min(src - 1, Math.ceil(b) - 1);
      starts[i] = first;
      counts[i] = last - first + 1;
      for (let s = first; s <= last; s++) weights.push((Math.min(b, s + 1) - Math.max(a, s)) / ratio);
    }
  } else {
    for (let i = 0; i < dst; i++) {
      let sx = ((i + 0.5) * src) / dst - 0.5;
      if (sx < 0) sx = 0;
      if (sx > src - 1) sx = src - 1;
      const x0 = Math.floor(sx);
      const f = sx - x0;
      if (f > 0 && x0 + 1 < src) {
        starts[i] = x0; counts[i] = 2; weights.push(1 - f, f);
      } else {
        starts[i] = x0; counts[i] = 1; weights.push(1);
      }
    }
  }
  const offsets = new Int32Array(dst + 1);
  for (let i = 0; i < dst; i++) offsets[i + 1] = offsets[i] + counts[i];
  return { starts, counts, offsets, weights: Float32Array.from(weights) };
}

export class Resampler {
  constructor(srcW, srcH, dstW, dstH) {
    this.srcW = srcW;
    this.srcH = srcH;
    this.dstW = dstW;
    this.dstH = dstH;
    this.h = axisWeights(srcW, dstW);
    const v = axisWeights(srcH, dstH);
    this.byRow = Array.from({ length: srcH }, () => []);
    for (let i = 0; i < dstH; i++) {
      for (let k = 0; k < v.counts[i]; k++) this.byRow[v.starts[i] + k].push(i, v.weights[v.offsets[i] + k]);
    }
    this.acc = new Float32Array(dstW * dstH * 4);
    this.tmp = new Float32Array(dstW * 4);
  }

  addRow(row, y, channels = 4) {
    const targets = this.byRow[y];
    if (!targets || !targets.length) return;
    const { starts, counts, offsets, weights } = this.h;
    const tmp = this.tmp;
    for (let x = 0; x < this.dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const s0 = starts[x];
      const o = offsets[x];
      for (let k = 0; k < counts[x]; k++) {
        const w = weights[o + k];
        const p = (s0 + k) * channels;
        if (channels === 4) {
          const al = row[p + 3] * w;
          r += row[p] * al; g += row[p + 1] * al; b += row[p + 2] * al; a += al;
        } else {
          const al = 255 * w;
          r += row[p] * al; g += row[p + 1] * al; b += row[p + 2] * al; a += al;
        }
      }
      tmp[x * 4] = r; tmp[x * 4 + 1] = g; tmp[x * 4 + 2] = b; tmp[x * 4 + 3] = a;
    }
    const acc = this.acc;
    const n = this.dstW * 4;
    for (let t = 0; t < targets.length; t += 2) {
      const base = targets[t] * n;
      const w = targets[t + 1];
      for (let i = 0; i < n; i++) acc[base + i] += tmp[i] * w;
    }
  }

  finish(out = new Uint8Array(this.dstW * this.dstH * 4)) {
    const acc = this.acc;
    let alpha = false;
    for (let p = 0; p < acc.length; p += 4) {
      const a = acc[p + 3];
      if (a <= 0) { out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 0; alpha = true; continue; }
      out[p] = Math.min(255, Math.round(acc[p] / a));
      out[p + 1] = Math.min(255, Math.round(acc[p + 1] / a));
      out[p + 2] = Math.min(255, Math.round(acc[p + 2] / a));
      const av = Math.min(255, Math.round(a));
      out[p + 3] = av;
      if (av < 128) alpha = true;
    }
    acc.fill(0);
    return { data: out, alpha };
  }
}

export function scaleImage(src, srcW, srcH, dstW, dstH, channels = 4, out) {
  const r = new Resampler(srcW, srcH, dstW, dstH);
  const stride = srcW * channels;
  for (let y = 0; y < srcH; y++) r.addRow(src.subarray(y * stride, (y + 1) * stride), y, channels);
  return r.finish(out);
}

export function orient(data, w, h, o) {
  if (!o || o === 1) return { data, width: w, height: h };
  const turned = o >= 5;
  const W = turned ? h : w;
  const H = turned ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx;
      let sy;
      switch (o) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        default: sx = w - 1 - y; sy = x; break;
      }
      const s = (sy * w + sx) * 4;
      const d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: W, height: H };
}

export function basePalette() {
  const pal = [[0, 0, 0]];
  for (let i = 0; i < GREYS; i++) {
    const v = Math.round((i * 255) / (GREYS - 1));
    pal.push([v, v, v]);
  }
  return pal;
}

export function samplePixels(rgba, limit = SAMPLE_PER_FRAME) {
  const total = rgba.length / 4;
  const step = Math.max(1, Math.floor(total / limit));
  const out = [];
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if (rgba[i + 3] >= 128) out.push(rgba[i], rgba[i + 1], rgba[i + 2], 255);
  }
  return out;
}

export function buildPalette(sample) {
  const pal = basePalette();
  if (sample.length >= 4) {
    const data = Uint8Array.from(sample);
    for (const c of quantize(data, COLOURS, { format: 'rgb444' })) pal.push([c[0], c[1], c[2]]);
  }
  return pal;
}

export function makeMapper(palette) {
  const cache = new Int16Array(65536).fill(-1);
  const n = palette.length;
  const pr = new Int32Array(n);
  const pg = new Int32Array(n);
  const pb = new Int32Array(n);
  palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; });
  const index = (r, g, b) => {
    const key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    let hit = cache[key];
    if (hit >= 0) return hit;
    const R = ((key >> 11) << 3) | 4;
    const G = (((key >> 5) & 63) << 2) | 2;
    const B = ((key & 31) << 3) | 4;
    let best = 1;
    let bestD = Infinity;
    for (let i = 1; i < n; i++) {
      const dr = pr[i] - R;
      const dg = pg[i] - G;
      const db = pb[i] - B;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
  const error = (rgba) => {
    const total = rgba.length / 4;
    const step = Math.max(1, Math.floor(total / 4096));
    let sum = 0;
    let count = 0;
    for (let p = 0; p < total; p += step) {
      const i = p * 4;
      if (rgba[i + 3] < 128) continue;
      const k = index(rgba[i], rgba[i + 1], rgba[i + 2]);
      const dr = pr[k] - rgba[i];
      const dg = pg[k] - rgba[i + 1];
      const db = pb[k] - rgba[i + 2];
      sum += dr * dr + dg * dg + db * db;
      count++;
    }
    return count ? sum / count : 0;
  };
  return { index, error, pr, pg, pb, palette };
}

export class GifWriter {
  constructor({ width, imageHeight, barHeight = 0, barIndices = null, sample = [], transparent = false, animated = false, stopAt = LIMITS.outputStop }) {
    this.width = width;
    this.imageHeight = imageHeight;
    this.barHeight = barHeight;
    this.height = imageHeight + barHeight;
    this.transparent = transparent;
    this.animated = animated;
    this.stopAt = stopAt;
    this.gif = GIFEncoder();
    this.index = new Uint8Array(width * this.height);
    if (barIndices) this.index.set(barIndices);
    this.shared = makeMapper(buildPalette(sample));
    this.sharedError = Math.max(1, this.shared.error(Uint8Array.from(sample)));
    this.prev = null;
    this.global = null;
    this.frames = 0;
    this.localFrames = 0;
    this.stopped = false;
  }

  add(rgba, delayCs = 0) {
    if (this.stopped) return false;
    const { width, barHeight, index } = this;
    let mapper = this.shared;
    if (this.animated && mapper.error(rgba) > Math.max(this.sharedError * 2.5, 150)) {
      mapper = makeMapper(buildPalette(samplePixels(rgba, 16384)));
      this.localFrames++;
    }
    const base = width * barHeight;
    const total = rgba.length / 4;
    for (let p = 0; p < total; p++) {
      const i = p * 4;
      if (rgba[i + 3] < 128) { index[base + p] = TRANSPARENT; continue; }
      const x = p % width;
      const y = (p / width) | 0;
      const d = ((BAYER[((y & 3) << 2) | (x & 3)] - 7.5) * DITHER) / 16;
      let r = rgba[i] + d;
      let g = rgba[i + 1] + d;
      let b = rgba[i + 2] + d;
      r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      index[base + p] = mapper.index(r, g, b);
    }
    let frame = index;
    const diff = this.animated && !this.transparent;
    if (diff) {
      const { pr, pg, pb } = mapper;
      if (!this.prev) {
        this.prev = new Int32Array(index.length);
        for (let p = 0; p < index.length; p++) { const k = index[p]; this.prev[p] = (pr[k] << 16) | (pg[k] << 8) | pb[k]; }
      } else {
        frame = this.scratch || (this.scratch = new Uint8Array(index.length));
        const prev = this.prev;
        for (let p = 0; p < index.length; p++) {
          const k = index[p];
          const col = (pr[k] << 16) | (pg[k] << 8) | pb[k];
          if (prev[p] === col) frame[p] = TRANSPARENT;
          else { frame[p] = k; prev[p] = col; }
        }
      }
    }
    const first = this.frames === 0;
    if (first) this.global = mapper.palette;
    this.gif.writeFrame(frame, width, this.height, {
      palette: first || mapper.palette !== this.global ? mapper.palette : null,
      delay: delayCs * 10,
      transparent: this.transparent || (diff && !first),
      transparentIndex: TRANSPARENT,
      dispose: this.animated ? (this.transparent ? 2 : 1) : -1,
      repeat: this.animated ? 0 : -1,
    });
    this.frames++;
    if (this.gif.bytesView().length > this.stopAt) this.stopped = true;
    return !this.stopped;
  }

  finish() {
    this.gif.finish();
    return this.gif.bytes();
  }
}

function webpSizes(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let canvas = null;
  let bitstream = null;
  let animated = false;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const tag = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const len = view.getUint32(pos + 4, true);
    const d = pos + 8;
    if (tag === 'VP8X' && d + 10 <= buf.length) {
      animated = !!(buf[d] & 0x02);
      canvas = { width: (buf[d + 4] | (buf[d + 5] << 8) | (buf[d + 6] << 16)) + 1, height: (buf[d + 7] | (buf[d + 8] << 8) | (buf[d + 9] << 16)) + 1 };
    } else if (tag === 'VP8 ' && d + 10 <= buf.length) {
      bitstream = { width: view.getUint16(d + 6, true) & 0x3fff, height: view.getUint16(d + 8, true) & 0x3fff };
      break;
    } else if (tag === 'VP8L' && d + 5 <= buf.length) {
      const bits = view.getUint32(d + 1, true);
      bitstream = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      break;
    } else if (tag === 'ANMF') {
      animated = true;
      break;
    }
    pos = d + len + (len & 1);
  }
  return { canvas, bitstream, animated };
}

let webpDecoder = null;
async function decodeWebp(buf, maxPixels, expectWidth = null, expectHeight = null) {
  const sizes = webpSizes(buf);
  if (sizes.animated) throw new ImagingError('animated WebP', 'webp-animated');
  const s = sizes.bitstream;
  if (!s || !s.width || !s.height) throw new ImagingError('no WebP picture data');
  if (s.width > LIMITS.maxSide || s.height > LIMITS.maxSide || s.width * s.height > LIMITS.maxPixels) throw new ImagingError('too many pixels', 'pixels');
  if (s.width * s.height > maxPixels) throw new ImagingError('too many pixels', 'big-still');
  if (sizes.canvas && (sizes.canvas.width !== s.width || sizes.canvas.height !== s.height)) throw new ImagingError('WebP sizes disagree', 'pixels');
  if ((expectWidth != null && s.width !== expectWidth) || (expectHeight != null && s.height !== expectHeight)) throw new ImagingError('WebP sizes disagree', 'pixels');
  if (!webpDecoder) {
    const dir = path.dirname(require.resolve('@jsquash/webp/package.json'));
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(path.join(dir, 'decode.js')).href);
    const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dir, 'codec', 'dec', 'webp_dec.wasm')));
    await mod.init(wasm);
    webpDecoder = mod.default;
  }
  const img = await webpDecoder(buf);
  if (!img || img.width !== s.width || img.height !== s.height) throw new ImagingError('WebP decode gave the wrong size');
  return img;
}

async function decodeStill({ input, type, needW, needH, expectWidth = null, expectHeight = null }) {
  const max = LIMITS.maxPixels;
  if (type === 'jpg') {
    const img = decodeJpeg(input, { maxPixels: max, needWidth: needW, needHeight: needH, maxCoefBytes: LIMITS.maxCoefBytes, expectWidth, expectHeight });
    return scaleImage(img.data, img.width, img.height, needW, needH, 3);
  }
  if (type === 'png') {
    let r = null;
    const info = await decodePng(input, {
      maxPixels: max,
      maxSide: LIMITS.maxSide,
      expectWidth,
      expectHeight,
      maxInterlacedPixels: LIMITS.maxInterlacedPixels,
      onRow: (row, y) => {
        if (!r) throw new ImagingError('rows before size');
        r.addRow(row, y, 4);
      },
      onSize: (w, h) => { r = new Resampler(w, h, needW, needH); },
    });
    if (!r) throw new ImagingError('no rows');
    const out = r.finish();
    return { data: out.data, alpha: info.alpha && out.alpha };
  }
  if (type === 'webp') {
    const img = await decodeWebp(input, Math.min(max, LIMITS.maxWebpPixels), expectWidth, expectHeight);
    return scaleImage(img.data, img.width, img.height, needW, needH, 4);
  }
  throw new ImagingError('unsupported type', 'unsupported');
}

export function scanGif(buf, maxFrames = LIMITS.maxGifFrames) {
  if (buf.length < 13) throw new ImagingError('bad GIF: too short');
  const width = buf[6] | (buf[7] << 8);
  const height = buf[8] | (buf[9] << 8);
  let p = 13;
  if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
  const frames = [];
  let unionW = width;
  let unionH = height;
  let control = false;
  const skipBlocks = () => {
    for (;;) {
      if (p >= buf.length) throw new ImagingError('bad GIF: it ends early');
      const size = buf[p++];
      if (!size) return;
      p += size;
    }
  };
  while (p < buf.length) {
    const kind = buf[p++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) control = true;
      skipBlocks();
      continue;
    }
    if (kind !== 0x2c) throw new ImagingError('bad GIF: unknown block');
    if (p + 9 > buf.length) throw new ImagingError('bad GIF: it ends early');
    const x = buf[p] | (buf[p + 1] << 8);
    const y = buf[p + 2] | (buf[p + 3] << 8);
    const w = buf[p + 4] | (buf[p + 5] << 8);
    const h = buf[p + 6] | (buf[p + 7] << 8);
    const flags = buf[p + 8];
    p += 9;
    if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
    p++;
    skipBlocks();
    frames.push({ x, y, width: w, height: h, control });
    if (frames.length > maxFrames) throw new ImagingError('GIF has too many frames', 'frames');
    control = false;
    unionW = Math.max(unionW, x + w);
    unionH = Math.max(unionH, y + h);
  }
  return { width, height, unionWidth: unionW, unionHeight: unionH, frames };
}

function gifReader(input) {
  const scan = scanGif(input);
  const n = scan.frames.length;
  if (!n) throw new ImagingError('GIF has no frames');
  const { width, height, unionWidth, unionHeight } = scan;
  if (!width || !height) throw new ImagingError('GIF has no size');
  const area = unionWidth * unionHeight;
  if (width * height > LIMITS.maxPixels || unionWidth > 65535 || unionHeight > 65535 || area > LIMITS.maxPixels) throw new ImagingError('too many pixels', 'pixels');
  if (n > 1 && area > LIMITS.maxAnimatedPixels) throw new ImagingError('animated GIF is too large', 'animated-pixels');
  if (n === 1 && area > LIMITS.maxStillGifPixels) throw new ImagingError('still GIF is too large', 'big-still');
  const head = input.subarray(6, 10);
  const original = Uint8Array.from(head);
  let reader;
  try {
    head[0] = unionWidth & 255; head[1] = unionWidth >> 8; head[2] = unionHeight & 255; head[3] = unionHeight >> 8;
    reader = new GifReader(input);
  } catch (e) {
    throw new ImagingError(`bad GIF: ${e.message}`);
  } finally {
    head.set(original);
  }
  if (reader.numFrames() !== n) throw new ImagingError('bad GIF: the frames do not add up');
  for (let i = 0; i < n; i++) {
    if (scan.frames[i].control) continue;
    const f = reader.frameInfo(i);
    f.delay = 0;
    f.disposal = 0;
    f.transparent_index = null;
  }
  return { reader, width, height };
}

function walkGif(reader, onFrame) {
  const w = reader.width;
  const h = reader.height;
  const canvas = new Uint8Array(w * h * 4);
  let saved = null;
  const n = reader.numFrames();
  for (let i = 0; i < n; i++) {
    const f = reader.frameInfo(i);
    if (f.disposal === 3) {
      saved = new Uint8Array(f.width * f.height * 4);
      for (let y = 0; y < f.height; y++) saved.set(canvas.subarray(((f.y + y) * w + f.x) * 4, ((f.y + y) * w + f.x + f.width) * 4), y * f.width * 4);
    }
    reader.decodeAndBlitFrameRGBA(i, canvas);
    if (onFrame(i, canvas, f) === false) return;
    if (f.disposal === 2) {
      for (let y = 0; y < f.height; y++) canvas.fill(0, ((f.y + y) * w + f.x) * 4, ((f.y + y) * w + f.x + f.width) * 4);
    } else if (f.disposal === 3 && saved) {
      for (let y = 0; y < f.height; y++) canvas.set(saved.subarray(y * f.width * 4, (y + 1) * f.width * 4), ((f.y + y) * w + f.x) * 4);
      saved = null;
    }
  }
}

export function gifSchedule(delays, fps, maxSeconds = LIMITS.maxSeconds) {
  const cap = Math.round(maxSeconds * 100);
  const interval = 100 / fps;
  const picks = [];
  let t = 0;
  let nextAt = 0;
  for (let i = 0; i < delays.length; i++) {
    if (t >= cap) break;
    if (t >= nextAt - 0.5) {
      picks.push({ frame: i, at: t });
      while (nextAt <= t + 1e-9) nextAt += interval;
    }
    t += delays[i] <= 1 ? 10 : delays[i];
  }
  const end = Math.min(t, cap);
  return picks.map((p, k) => ({ frame: p.frame, delay: (k + 1 < picks.length ? picks[k + 1].at : end) - p.at }));
}

function hasClear(canvas, stride, w, h) {
  for (let y = 0; y < h; y++) {
    const end = (y * stride + w) * 4;
    for (let i = y * stride * 4 + 3; i < end; i += 4) if (canvas[i] < 128) return true;
  }
  return false;
}

function scaleRegion(resampler, canvas, stride, w, h, out) {
  for (let y = 0; y < h; y++) resampler.addRow(canvas.subarray(y * stride * 4, (y * stride + w) * 4), y, 4);
  return resampler.finish(out);
}

export async function renderGif(input, job, { onProgress = null } = {}) {
  const W = job.outWidth;
  const H = job.outHeight;
  const o = job.orientation || 1;
  const needW = o >= 5 ? H : W;
  const needH = o >= 5 ? W : H;
  let barHeight = 0;
  let barIndices = null;
  if (job.kind === 'caption' && job.layout) {
    const info = loadFont(job.fontPath);
    if (!info) throw new ImagingError('caption font is missing', 'font');
    barHeight = job.layout.barHeight;
    barIndices = captionIndices(renderCaption(info, job.layout, W));
  }
  const finishImage = (img) => orient(img.data, needW, needH, o).data;

  if (job.type === 'gif') {
    const { reader, width: gw, height: gh } = gifReader(input);
    const frames = reader.numFrames();
    if (job.srcWidth != null && job.srcHeight != null && (gw !== job.srcWidth || gh !== job.srcHeight)) throw new ImagingError('GIF sizes disagree', 'pixels');
    const cw = reader.width;
    if (frames > 1) {
      const delays = Array.from({ length: frames }, (_, i) => reader.frameInfo(i).delay);
      const schedule = gifSchedule(delays, job.fps, job.seconds || LIMITS.maxSeconds);
      const wanted = new Map(schedule.map((s, k) => [s.frame, k]));
      const stride = Math.max(1, Math.ceil(schedule.length / SAMPLE_FRAMES));
      const resampler = new Resampler(gw, gh, needW, needH);
      const scaled = new Uint8Array(needW * needH * 4);
      const scale = (canvas) => scaleRegion(resampler, canvas, cw, gw, gh, scaled);
      const last = schedule[schedule.length - 1].frame;
      let sample = [];
      let transparent = false;
      walkGif(reader, (i, canvas) => {
        const k = wanted.get(i);
        if (k === undefined) return i < last;
        if (!transparent && hasClear(canvas, cw, gw, gh)) transparent = true;
        if (k % stride === 0) {
          const img = scale(canvas);
          sample = sample.concat(samplePixels(img.data, SAMPLE_PER_FRAME));
        }
        return i < last;
      });
      const writer = new GifWriter({ width: W, imageHeight: H, barHeight, barIndices, sample, transparent, animated: true });
      walkGif(reader, (i, canvas) => {
        const k = wanted.get(i);
        if (k === undefined) return i < last;
        const img = scale(canvas);
        const ok = writer.add(finishImage(img), schedule[k].delay);
        onProgress?.(k + 1, schedule.length);
        return ok && i < last;
      });
      return { bytes: writer.finish(), frames: writer.frames, localPalettes: writer.localFrames, stopped: writer.stopped, width: W, height: H + barHeight };
    }
    let still = null;
    walkGif(reader, (i, canvas) => { still = scaleRegion(new Resampler(gw, gh, needW, needH), canvas, cw, gw, gh); return false; });
    return writeStill(still, finishImage, { W, H, barHeight, barIndices });
  }
  const still = await decodeStill({ input, type: job.type, needW, needH, expectWidth: job.srcWidth ?? null, expectHeight: job.srcHeight ?? null });
  return writeStill(still, finishImage, { W, H, barHeight, barIndices });
}

function writeStill(still, finishImage, { W, H, barHeight, barIndices }) {
  const data = finishImage(still);
  const writer = new GifWriter({ width: W, imageHeight: H, barHeight, barIndices, sample: samplePixels(data, 65536), transparent: still.alpha, animated: false });
  writer.add(data, 0);
  return { bytes: writer.finish(), frames: 1, localPalettes: 0, stopped: writer.stopped, width: W, height: H + barHeight };
}

let chain = Promise.resolve();
export function renderInWorker(input, job, { timeoutMs = 60_000, resourceLimits = { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 }, track = null } = {}) {
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./imaging-worker.js', import.meta.url), { resourceLimits });
    track?.add(worker);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      track?.delete(worker);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      const e = new Error('the render timed out');
      e.timedOut = true;
      finish(reject, e);
    }, timeoutMs);
    worker.on('message', (msg) => {
      if (msg?.ok) finish(resolve, msg);
      else {
        const e = new ImagingError(msg?.error?.message || 'the render failed', msg?.error?.code || 'decode');
        finish(reject, e);
      }
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => finish(reject, Object.assign(new Error(`the render stopped (${code})`), { code: 'exit' })));
    const copy = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength && !(input.buffer instanceof SharedArrayBuffer) ? input : new Uint8Array(input);
    const plain = { ...job };
    worker.postMessage({ input: copy.buffer, job: plain }, [copy.buffer]);
  });
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}
