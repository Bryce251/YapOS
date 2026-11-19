import { HEX_RE, mixHex, readGradientCustom, themeColoursOf } from './profile-look.js';

export const CUT_MAX_SIDE = 512;
export const CUT_MIN_SIDE = 64;
export const CUT_STRENGTH_MIN = 0;
export const CUT_STRENGTH_MAX = 100;
export const CUT_STRENGTH_START = 45;
export const CUT_EVERYTHING = 0.92;
export const CUT_NOTHING = 0.03;
export const CUT_BUSY = 0.5;
export const CUT_SOURCES = Object.freeze(['upload', 'yapin']);
export const BACKDROP_MODES = Object.freeze(['theme', 'clear']);
export const BACKDROP_DEFAULT = Object.freeze(['#eceef4', '#d6dae6']);
export const BACKDROP_DEFAULT_RING = '#9aa1b5';
export const GRADIENT_BACKDROPS = Object.freeze({
  sunset: Object.freeze(['#ff9a6b', '#ff6f91', '#ffc46b']),
  ocean: Object.freeze(['#6bd3ff', '#8ab0ff', '#5ce1c8']),
  aurora: Object.freeze(['#7cf0b5', '#8ab4ff', '#d39bff']),
  candy: Object.freeze(['#ff8fd1', '#c59bff', '#8fd3ff']),
  forest: Object.freeze(['#8ee08a', '#4fd1a5', '#c6e36b']),
  gold: Object.freeze(['#ffd66b', '#ffb547', '#fff0a8']),
});

const hexOf = (v) => (typeof v === 'string' && HEX_RE.test(v) ? v : null);

export function backdropColours(look) {
  const l = look && typeof look === 'object' ? look : {};
  const theme = themeColoursOf(l);
  if (theme) return { from: 'theme', stops: [theme.base, theme.alt], ring: theme.accent };
  const accent = hexOf(l.accent);
  if (accent) return { from: 'accent', stops: [accent, mixHex(accent, '#ffffff', 0.45)], ring: accent };
  const custom = readGradientCustom(l.nameGradientCustom);
  if (custom) return { from: 'gradient', stops: custom.c ? [custom.a, custom.c, custom.b] : [custom.a, custom.b], ring: custom.a };
  const preset = typeof l.nameGradient === 'string' && Object.prototype.hasOwnProperty.call(GRADIENT_BACKDROPS, l.nameGradient) ? GRADIENT_BACKDROPS[l.nameGradient] : null;
  if (preset) return { from: 'gradient', stops: [...preset], ring: preset[0] };
  const name = hexOf(l.nameColour);
  if (name) return { from: 'name', stops: [name, mixHex(name, '#ffffff', 0.5)], ring: name };
  return { from: 'default', stops: [...BACKDROP_DEFAULT], ring: BACKDROP_DEFAULT_RING };
}

export function cleanBackdrop(value) {
  return BACKDROP_MODES.includes(value) ? value : 'theme';
}

const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

export function pngHasAlpha(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes[0] !== 0x89 || tag(bytes, 12) !== 'IHDR') return false;
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  let at = 8;
  for (let n = 0; n < 4096 && at + 8 <= bytes.length; n++) {
    const len = u32be(bytes, at);
    const kind = tag(bytes, at + 4);
    if (kind === 'tRNS') return true;
    if (kind === 'IDAT' || kind === 'IEND') return false;
    at += 12 + len;
  }
  return false;
}

export function webpHasAlpha(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 30 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return false;
  const first = tag(bytes, 12);
  if (first === 'VP8X') return (bytes[20] & 0x10) !== 0;
  if (first === 'VP8L') return bytes[20] === 0x2f && ((u32le(bytes, 21) >>> 28) & 1) === 1;
  return false;
}

export function imageHasAlpha(bytes, mime) {
  if (mime === 'image/png') return pngHasAlpha(bytes);
  if (mime === 'image/webp') return webpHasAlpha(bytes);
  return false;
}

const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

export function toOklab(r, g, b) {
  const R = LIN[r];
  const G = LIN[g];
  const B = LIN[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    100 * (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s),
    100 * (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s),
    100 * (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s),
  ];
}

export function strengthTolerance(strength) {
  const s = Math.min(CUT_STRENGTH_MAX, Math.max(CUT_STRENGTH_MIN, Number.isFinite(Number(strength)) ? Number(strength) : CUT_STRENGTH_START));
  return 1 + s * 0.13;
}

function borderIndexes(w, h) {
  const out = [];
  const part = [];
  for (let x = 0; x < w; x++) {
    out.push(x);
    part.push(0);
    if (h > 1) {
      out.push((h - 1) * w + x);
      part.push(1);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    const upper = y < h / 2;
    out.push(y * w);
    part.push(upper ? 2 : 4);
    if (w > 1) {
      out.push(y * w + w - 1);
      part.push(upper ? 3 : 4);
    }
  }
  return { idx: out, part };
}

function clusterBorder(lab, rgba, { idx, part }) {
  const clusters = [];
  const sideTotals = [0, 0, 0, 0, 0];
  let solid = 0;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    if (rgba[i * 4 + 3] < 16) continue;
    solid += 1;
    sideTotals[part[j]] += 1;
    const L = lab[i * 3];
    const A = lab[i * 3 + 1];
    const B = lab[i * 3 + 2];
    let best = null;
    let bestD = 5;
    for (const c of clusters) {
      const d = Math.hypot(c.L - L, c.A - A, c.B - B);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best && clusters.length >= 24) {
      bestD = Infinity;
      for (const c of clusters) {
        const d = Math.hypot(c.L - L, c.A - A, c.B - B);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (best) {
      const n = best.n + 1;
      best.L += (L - best.L) / n;
      best.A += (A - best.A) / n;
      best.B += (B - best.B) / n;
      best.r += (rgba[i * 4] - best.r) / n;
      best.g += (rgba[i * 4 + 1] - best.g) / n;
      best.b += (rgba[i * 4 + 2] - best.b) / n;
      best.n = n;
      best.sides[part[j]] += 1;
    } else {
      const sides = [0, 0, 0, 0, 0];
      sides[part[j]] = 1;
      clusters.push({ L, A, B, r: rgba[i * 4], g: rgba[i * 4 + 1], b: rgba[i * 4 + 2], n: 1, sides });
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  const spread = (c) => c.sides.slice(0, 4).filter((v, s) => v >= Math.max(2, sideTotals[s] * 0.03)).length;
  const keep = clusters.filter((c, k) => k === 0 || (c.n >= Math.max(2, solid * 0.06) && spread(c) >= 2)).slice(0, 5);
  const chosen = keep.length ? keep : clusters.slice(0, 3);
  const covered = solid ? chosen.reduce((t, c) => t + c.n, 0) / solid : 1;
  return { clusters: chosen, covered, solid };
}

export function cutOut(rgbaIn, width, height, { strength = CUT_STRENGTH_START, feather = 1 } = {}) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!(w > 0 && h > 0) || w > CUT_MAX_SIDE * 2 || h > CUT_MAX_SIDE * 2) throw new Error('That picture is the wrong size to cut out.');
  const n = w * h;
  if (!rgbaIn || rgbaIn.length < n * 4) throw new Error('That picture could not be read.');
  const rgba = rgbaIn;
  const tol = strengthTolerance(strength);
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = toOklab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    lab[i * 3] = o[0];
    lab[i * 3 + 1] = o[1];
    lab[i * 3 + 2] = o[2];
  }
  const border = borderIndexes(w, h);
  const { clusters, covered } = clusterBorder(lab, rgba, border);
  const dc = new Float32Array(n);
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    let k = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      const d = Math.hypot(cl.L - lab[i * 3], cl.A - lab[i * 3 + 1], cl.B - lab[i * 3 + 2]);
      if (d < best) {
        best = d;
        k = c;
      }
    }
    dc[i] = clusters.length ? best : Infinity;
    near[i] = k;
  }
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const clear = (i) => rgba[i * 4 + 3] < 16;
  for (const i of border.idx) {
    if (bg[i]) continue;
    if (clear(i) || dc[i] <= tol) {
      bg[i] = 1;
      queue[tail++] = i;
    }
  }
  const step = Math.max(1, tol * 0.18);
  const drift = tol * 2;
  while (head < tail) {
    const p = queue[head++];
    const px = p % w;
    const py = (p - px) / w;
    for (let k = 0; k < 4; k++) {
      const qx = k === 0 ? px - 1 : k === 1 ? px + 1 : px;
      const qy = k === 2 ? py - 1 : k === 3 ? py + 1 : py;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (bg[q]) continue;
      let ok = clear(q) || dc[q] <= tol;
      if (!ok && dc[q] <= drift) {
        const d = Math.hypot(lab[p * 3] - lab[q * 3], lab[p * 3 + 1] - lab[q * 3 + 1], lab[p * 3 + 2] - lab[q * 3 + 2]);
        ok = d <= step;
      }
      if (ok) {
        bg[q] = 1;
        queue[tail++] = q;
      }
    }
  }
  const minIsland = Math.max(6, Math.round(n * 0.0015));
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (bg[s] || seen[s]) continue;
    head = 0;
    tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const p = queue[head++];
      const px = p % w;
      const py = (p - px) / w;
      for (let k = 0; k < 4; k++) {
        const qx = k === 0 ? px - 1 : k === 1 ? px + 1 : px;
        const qy = k === 2 ? py - 1 : k === 3 ? py + 1 : py;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (bg[q] || seen[q]) continue;
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
    if (tail < minIsland) for (let j = 0; j < tail; j++) bg[queue[j]] = 1;
  }
  const alpha = new Float32Array(n);
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (bg[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const touches = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
    if (touches) {
      edge[i] = 1;
      alpha[i] = Math.min(1, Math.max(0.15, (dc[i] - tol * 0.6) / (tol * 1.6)));
    } else alpha[i] = 1;
  }
  const rounds = Math.min(2, Math.max(0, Math.round(Number(feather) || 0)));
  let band = edge;
  for (let r = 0; r < rounds; r++) {
    const grow = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!band[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) grow[yy * w + xx] = 1;
      }
    }
    const next = alpha.slice();
    for (let i = 0; i < n; i++) {
      if (!grow[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        sum += alpha[yy * w + xx];
        cnt += 1;
      }
      const soft = sum / cnt;
      next[i] = bg[i] ? Math.min(soft, 0.5) : Math.max(soft, alpha[i] * 0.5);
    }
    alpha.set(next);
    band = grow;
  }
  const out = new Uint8ClampedArray(n * 4);
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.min(1, Math.max(0, alpha[i])) * (rgba[i * 4 + 3] / 255);
    removed += 1 - a;
    const o = i * 4;
    if (a <= 0) continue;
    if (a < 0.999 && clusters.length) {
      const c = clusters[near[i]];
      out[o] = c.r + (rgba[o] - c.r) / Math.max(a, 0.2);
      out[o + 1] = c.g + (rgba[o + 1] - c.g) / Math.max(a, 0.2);
      out[o + 2] = c.b + (rgba[o + 2] - c.b) / Math.max(a, 0.2);
    } else {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
    }
    out[o + 3] = Math.round(a * 255);
  }
  const share = removed / n;
  const verdict = share >= CUT_EVERYTHING ? 'everything' : share <= CUT_NOTHING ? 'nothing' : covered < CUT_BUSY ? 'busy' : 'ok';
  return { rgba: out, width: w, height: h, removed: share, verdict, tolerance: tol, background: clusters.map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)]) };
}

export function verdictText(verdict) {
  if (verdict === 'everything') return 'That removes almost the whole picture. Turn the strength down so the person or character stays.';
  if (verdict === 'nothing') return 'Almost nothing was removed. The background may touch the same colours as the picture, so try a higher strength.';
  if (verdict === 'busy') return 'The background has lots of colours, so some bits may stay behind. Pictures on a plain background work best.';
  return '';
}

export function fitSide(width, height, max = CUT_MAX_SIDE) {
  const side = Math.max(1, Math.min(width, height));
  return Math.max(1, Math.min(max, side));
}

const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

let worker = null;
let workerBroken = false;
let jobId = 0;

function workerFor() {
  if (worker || workerBroken) return worker;
  try {
    if (typeof Worker !== 'function') throw new Error('no workers');
    worker = new Worker(new URL('./avatar-cutout-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function viaWorker(w, rgba, width, height, options) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const done = (e) => {
      const d = e && e.data;
      if (!d || d.id !== id) return;
      w.removeEventListener('message', done);
      w.removeEventListener('error', fail);
      if (d.ok) resolve(d.out);
      else reject(new Error(d.message || 'Cut-out failed.'));
    };
    const fail = () => {
      w.removeEventListener('message', done);
      w.removeEventListener('error', fail);
      workerBroken = true;
      worker = null;
      reject(new Error('worker'));
    };
    w.addEventListener('message', done);
    w.addEventListener('error', fail);
    const copy = new Uint8ClampedArray(rgba);
    w.postMessage({ id, data: copy.buffer, width, height, options }, [copy.buffer]);
  });
}

export async function runCutOut(rgba, width, height, options = {}, { useWorker = true } = {}) {
  const w = useWorker ? workerFor() : null;
  if (w) {
    try {
      return await viaWorker(w, rgba, width, height, options);
    } catch (err) {
      if (!workerBroken) throw err;
    }
  }
  await yieldNow();
  return cutOut(rgba, width, height, options);
}

export function encodeCutout(canvas, { doc = document, max, minSide = CUT_MIN_SIDE, sizeOf } = {}) {
  const bytesOf = sizeOf || ((url) => {
    const at = url.indexOf(',');
    const b64 = at < 0 ? '' : url.slice(at + 1);
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
  });
  const full = canvas.width;
  const sides = [...new Set([full, 384, 256, 192, 128].filter((s) => s <= full && s >= minSide))];
  const missing = new Set();
  for (const side of sides) {
    let src = canvas;
    if (side !== full) {
      src = doc.createElement('canvas');
      src.width = side;
      src.height = side;
      const ctx = src.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, side, side);
    }
    for (const type of ['image/webp', 'image/png']) {
      if (missing.has(type)) continue;
      for (const q of type === 'image/png' ? [1] : [0.92, 0.84, 0.74]) {
        const url = src.toDataURL(type, q);
        if (!url.startsWith(`data:${type}`)) {
          missing.add(type);
          break;
        }
        if (bytesOf(url) <= max) return url;
      }
    }
  }
  throw new Error('That cut-out is too detailed to save. Try a simpler picture.');
}
