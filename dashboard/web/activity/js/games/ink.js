import { jsonBytes } from '../limits.js';

export const GRID_W = 480;
export const GRID_H = 360;
export const COLORS = Object.freeze(['#ffffff', '#1c1c22', '#8d8d97', '#ef4444', '#f2613f', '#fbbf24', '#22c55e', '#14b8a6', '#3b82f6', '#7c5cff', '#f472b6', '#92400e']);
export const COLOR_NAMES = Object.freeze(['Eraser', 'Black', 'Gray', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Brown']);
export const ERASER = 0;
export const SIZES = Object.freeze([3, 6, 12, 24]);
export const SIZE_NAMES = Object.freeze(['Fine', 'Medium', 'Thick', 'Huge']);
export const INK_PREFIX = 'ink.';
export const CHUNK_BYTES = 3500;
export const MAX_CHUNKS = 24;
export const INK_BYTES = 36000;
export const PIECE_CHARS = 1500;
export const LEVELS = Object.freeze([0.6, 1.2, 2, 3.5, 5.5]);
export const COARSE = Object.freeze([8, 12, 18, 28, 44, 70, 110, 100000]);
export const TOP_LEVEL = LEVELS.length + COARSE.length - 1;
export const SEAT_POOL = 40960;
export const SEAT_MAX = 12000;
export const SEAT_CHUNKS = 8;
export const SEAT_CHUNK_BYTES = 3700;
export const G_MAX = 999999;
export const FILL = SIZES.length;
export const FILL_CHARS = 6;
export const FILL_TOLERANCE = 20;
export const SNAPSHOTS = 3;
export const CUSTOM = COLORS.length;
export const RGB_CHARS = 4;
export const CUSTOM_FILL_CHARS = FILL_CHARS + RGB_CHARS;

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VAL = new Map(Array.from(ABC).map((c, i) => [c, i]));
const NEAR = 31;
const REACH = 3;

export function hexOf(v) {
  const m = /^#?([0-9a-f]{6})$/i.exec(typeof v === 'string' ? v.trim() : '');
  return m ? `#${m[1].toLowerCase()}` : null;
}

export function paletteIndex(hex) {
  const v = hexOf(hex);
  return v ? COLORS.indexOf(v) : -1;
}

export function tintOf(hex) {
  const v = hexOf(hex);
  if (!v) return null;
  const i = COLORS.indexOf(v);
  return i >= 0 ? { c: i } : { c: CUSTOM, rgb: v };
}

export function colorOf(s) {
  if (!s) return COLORS[1];
  if (s.c === CUSTOM) return hexOf(s.rgb) || COLORS[1];
  return COLORS[s.c] || COLORS[1];
}

function tintKey(s) {
  if (s && s.c === CUSTOM) {
    const t = tintOf(s.rgb);
    if (t && t.c === CUSTOM) {
      const n = parseInt(t.rgb.slice(1), 16);
      return ABC[CUSTOM] + ABC[(n >> 18) & 63] + ABC[(n >> 12) & 63] + ABC[(n >> 6) & 63] + ABC[n & 63];
    }
    return ABC[t ? t.c : 1];
  }
  return ABC[clampInt(s ? s.c : 1, COLORS.length - 1)];
}

export function isFill(s) {
  return Boolean(s && s.z === FILL);
}

export function inkKey(i) {
  return `${INK_PREFIX}${i}`;
}

function clampInt(v, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, n));
}

export function quantise(x, y) {
  return [clampInt(x, GRID_W), clampInt(y, GRID_H)];
}

function big(v) {
  return ABC[(v >> 6) & 63] + ABC[v & 63];
}

function delta(d) {
  if (d >= -NEAR && d <= NEAR) return ABC[d + 32];
  return ABC[0] + big(d + 2048);
}

export function encodeStroke(stroke) {
  const pts = stroke.pts || [];
  if (!pts.length) return '';
  const fill = isFill(stroke);
  let out = tintKey(stroke) + ABC[fill ? FILL : clampInt(stroke.z, SIZES.length - 1)];
  let [px, py] = quantise(pts[0][0], pts[0][1]);
  out += big(px) + big(py);
  if (fill) return out;
  for (let i = 1; i < pts.length; i += 1) {
    const [x, y] = quantise(pts[i][0], pts[i][1]);
    out += delta(x - px) + delta(y - py);
    px = x;
    py = y;
  }
  return out;
}

export function decodeStroke(text) {
  if (typeof text !== 'string' || text.length < 6 || text.length > 4096) return null;
  const at = (i) => (i < text.length ? VAL.get(text[i]) : undefined);
  const c = at(0);
  if (c === undefined || c > CUSTOM) return null;
  let rgb = null;
  let o = 0;
  if (c === CUSTOM) {
    let n = 0;
    for (let k = 1; k <= RGB_CHARS; k += 1) {
      const v = at(k);
      if (v === undefined) return null;
      n = n * 64 + v;
    }
    if (n > 0xffffff) return null;
    rgb = `#${n.toString(16).padStart(6, '0')}`;
    if (COLORS.includes(rgb)) return null;
    o = RGB_CHARS;
  }
  const z = at(o + 1);
  if (z === undefined || z > FILL) return null;
  if (text.length < o + 6) return null;
  if (z === FILL && text.length !== FILL_CHARS + o) return null;
  const read2 = (i) => {
    const a = at(i);
    const b = at(i + 1);
    return a === undefined || b === undefined ? null : a * 64 + b;
  };
  let x = read2(o + 2);
  let y = read2(o + 4);
  if (x === null || y === null || x > GRID_W || y > GRID_H) return null;
  const pts = [[x, y]];
  let i = o + 6;
  const step = () => {
    const v = at(i);
    if (v === undefined) return null;
    if (v === 0) {
      const w = read2(i + 1);
      if (w === null) return null;
      i += 3;
      return w - 2048;
    }
    i += 1;
    return v - 32;
  };
  while (i < text.length) {
    const dx = step();
    const dy = step();
    if (dx === null || dy === null) return null;
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x > GRID_W || y > GRID_H) return null;
    pts.push([x, y]);
  }
  return rgb ? { c, rgb, z, pts } : { c, z, pts };
}

function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function simplify(pts, eps) {
  if (pts.length < 3 || !(eps > 0)) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1;
    let far = 0;
    for (let i = s + 1; i < e; i += 1) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best > 0 && far > eps) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = quantise(p[0], p[1]);
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

export function encodeParts(stroke, eps = LEVELS[0]) {
  if (isFill(stroke)) {
    const at = (stroke.pts || [])[0];
    return at ? [encodeStroke({ c: stroke.c, rgb: stroke.rgb, z: FILL, pts: [at] })] : [];
  }
  const pts = simplify(dedupe(stroke.pts || []), eps);
  if (!pts.length) return [];
  const parts = [];
  let start = 0;
  while (start < pts.length) {
    let end = start + 1;
    let text = encodeStroke({ c: stroke.c, rgb: stroke.rgb, z: stroke.z, pts: pts.slice(start, end) });
    while (end < pts.length) {
      const next = text + encodeStroke({ c: 0, z: 0, pts: [pts[end - 1], pts[end]] }).slice(6);
      if (next.length > PIECE_CHARS) break;
      text = next;
      end += 1;
    }
    parts.push(text);
    if (end >= pts.length) break;
    start = end - 1;
  }
  return parts;
}

export function pack(parts, k) {
  const chunks = [];
  let cur = null;
  for (const s of parts) {
    if (cur) {
      const trial = { ...cur, s: cur.s.concat([s]) };
      if (jsonBytes(trial) <= CHUNK_BYTES) {
        cur = trial;
        continue;
      }
      chunks.push(cur);
    }
    cur = { k, i: chunks.length, s: [s] };
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function inkBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += jsonBytes(c) + inkKey(c.i).length;
  return total;
}

export function levelEps(level) {
  const i = Math.max(0, Math.floor(Number(level) || 0));
  return i < LEVELS.length ? LEVELS[i] : COARSE[Math.min(COARSE.length - 1, i - LEVELS.length)];
}

export function fitLevels(strokes, level, fits) {
  const list = Array.isArray(strokes) ? strokes : [];
  for (let lvl = Math.max(0, Math.floor(Number(level) || 0)); lvl <= TOP_LEVEL; lvl += 1) {
    const eps = levelEps(lvl);
    const parts = [];
    for (const s of list) parts.push(...encodeParts(s, eps));
    const out = fits(parts);
    if (out) return { ...out, level: lvl, count: parts.length, strokes: list, thinned: false };
  }
  const per = list.map((s) => encodeParts(s, levelEps(TOP_LEVEL)));
  const order = list.map((s, i) => i).sort((a, b) => Number(isFill(list[a])) - Number(isFill(list[b])) || a - b);
  const without = (n) => {
    const gone = new Set(order.slice(0, n));
    const idx = list.map((s, i) => i).filter((i) => !gone.has(i));
    const parts = idx.flatMap((i) => per[i]);
    return { idx, parts, out: fits(parts) };
  };
  let lo = 1;
  let hi = list.length;
  let best = without(hi);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const got = without(mid);
    if (got.out) {
      best = got;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return { ...(best.out || {}), level: TOP_LEVEL, count: best.parts.length, strokes: best.idx.map((i) => list[i]), thinned: true };
}

export function fitInk(strokes, k, level = 0) {
  return fitLevels(strokes, level, (parts) => {
    const chunks = pack(parts, k);
    return chunks.length <= MAX_CHUNKS && inkBytes(chunks) <= INK_BYTES ? { chunks } : null;
  });
}

export function seatBudget(seats) {
  const n = Math.max(1, Math.floor(Number(seats) || 1));
  return Math.min(SEAT_MAX, Math.floor(SEAT_POOL / n));
}

export function seatKey(prefix, seat, i = 0) {
  return i ? `${prefix}${seat}.${i}` : `${prefix}${seat}`;
}

export function seatOf(prefix, key) {
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const m = /^(\d{1,3})(?:\.(\d))?$/.exec(key.slice(prefix.length));
  if (!m) return null;
  const seat = Number(m[1]);
  const i = m[2] === undefined ? 0 : Number(m[2]);
  if (i >= SEAT_CHUNKS || seatKey(prefix, seat, i) !== key) return null;
  return { seat, i };
}

function genOf(v) {
  return Number.isInteger(v.g) ? v.g : 0;
}

export function validChunk(v, k) {
  if (!v || typeof v !== 'object' || v.k !== k || !Array.isArray(v.s)) return false;
  if (v.g !== undefined && !(Number.isInteger(v.g) && v.g >= 0 && v.g <= G_MAX)) return false;
  if (jsonBytes(v) > SEAT_CHUNK_BYTES) return false;
  return v.s.every((s) => typeof s === 'string' && decodeStroke(s) !== null);
}

function getter(src) {
  if (typeof src === 'function') return src;
  return (key) => (src && Object.prototype.hasOwnProperty.call(src, key) ? src[key] : null);
}

export function readSeat(src, prefix, seat, k) {
  const get = getter(src);
  const first = get(seatKey(prefix, seat, 0));
  if (!validChunk(first, k)) return { s: [], g: 0, values: [], bytes: 0 };
  const g = genOf(first);
  const values = [first];
  for (let i = 1; i < SEAT_CHUNKS; i += 1) {
    const v = get(seatKey(prefix, seat, i));
    if (!validChunk(v, k) || genOf(v) !== g) break;
    values.push(v);
  }
  return { s: values.flatMap((v) => v.s), g, values, bytes: values.reduce((a, v) => a + jsonBytes(v), 0) };
}

export function seatRoom(src, prefix, seat, i, value, k, budget) {
  if (value === null) return true;
  if (!validChunk(value, k)) return false;
  const get = getter(src);
  const g = genOf(value);
  let total = jsonBytes(value);
  for (let j = 0; j < SEAT_CHUNKS; j += 1) {
    if (j === i) continue;
    const v = get(seatKey(prefix, seat, j));
    if (v && typeof v === 'object' && v.k === k && genOf(v) === g) total += jsonBytes(v);
  }
  return total <= budget;
}

export function fitSeat(strokes, k, level, budget) {
  return fitLevels(strokes, level, (parts) => {
    const chunks = pack(parts, k);
    if (chunks.length > SEAT_CHUNKS) return null;
    let bytes = 0;
    for (const ch of chunks) {
      const b = jsonBytes({ k, g: G_MAX, s: ch.s });
      if (b > SEAT_CHUNK_BYTES) return null;
      bytes += b;
    }
    return bytes <= budget ? { pieces: chunks.map((ch) => ch.s), bytes } : null;
  });
}

export function readInk(state, k) {
  const strokes = [];
  let sig = '';
  for (let i = 0; i < MAX_CHUNKS; i += 1) {
    const ch = state ? state[inkKey(i)] : null;
    if (!ch || typeof ch !== 'object' || ch.k !== k || ch.i !== i || !Array.isArray(ch.s)) continue;
    for (const s of ch.s) {
      const d = decodeStroke(s);
      if (d) strokes.push(d);
      sig += `${s}|`;
    }
    sig += '/';
  }
  return { strokes, sig };
}

export function liveMessage(k, si, o, pts, stroke) {
  const from = Math.max(0, o - 1);
  return { t: 'ink', k, si, o, s: encodeStroke({ c: stroke.c, rgb: stroke.rgb, z: stroke.z, pts: pts.slice(from) }) };
}

export function applyLive(live, msg) {
  if (!msg || msg.t !== 'ink' || !live) return false;
  if (Number.isInteger(msg.cut)) {
    let hit = false;
    for (const si of [...live.keys()]) {
      if (si >= msg.cut) {
        live.delete(si);
        hit = true;
      }
    }
    return hit;
  }
  if (!Number.isInteger(msg.si) || !Number.isInteger(msg.o) || msg.si < 0 || msg.o < 0) return false;
  const d = decodeStroke(msg.s);
  if (!d) return false;
  if (msg.o === 0) {
    live.set(msg.si, d);
    return true;
  }
  const cur = live.get(msg.si);
  if (!cur || cur.pts.length !== msg.o || isFill(cur) || isFill(d)) return false;
  cur.pts.push(...d.pts.slice(1));
  return true;
}

export function pruneLive(live, committed) {
  for (const si of [...live.keys()]) if (si < committed) live.delete(si);
}

export function rgbaOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function sameRegion(a, b, tolerance = FILL_TOLERANCE) {
  if (!a || !b) return false;
  const tol = Math.max(0, Number(tolerance) || 0);
  for (let k = 0; k < 4; k += 1) {
    const x = a[k] === undefined ? 255 : a[k];
    const y = b[k] === undefined ? 255 : b[k];
    if (Math.abs(x - y) > tol) return false;
  }
  return true;
}

export function floodFill(data, width, height, x, y, rgba, tolerance = FILL_TOLERANCE) {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!data || !(w > 0) || !(h > 0) || data.length < w * h * 4 || !rgba) return 0;
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) return 0;
  const nr = rgba[0] & 255;
  const ng = rgba[1] & 255;
  const nb = rgba[2] & 255;
  const na = rgba[3] === undefined ? 255 : rgba[3] & 255;
  const seed = (sy * w + sx) * 4;
  const r0 = data[seed];
  const g0 = data[seed + 1];
  const b0 = data[seed + 2];
  const a0 = data[seed + 3];
  if (r0 === nr && g0 === ng && b0 === nb && a0 === na) return 0;
  const tol = Math.max(0, Number(tolerance) || 0);
  const done = new Uint8Array(w * h);
  const open = (p) => {
    if (done[p] !== 0) return false;
    const i = p * 4;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol && Math.abs(data[i + 3] - a0) <= tol;
  };
  const stack = [sx, sy];
  let count = 0;
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  while (stack.length) {
    const cy = stack.pop();
    const cx = stack.pop();
    const row = cy * w;
    if (!open(row + cx)) continue;
    let lx = cx;
    while (lx > 0 && open(row + lx - 1)) lx -= 1;
    let rx = cx;
    while (rx < w - 1 && open(row + rx + 1)) rx += 1;
    done.fill(1, row + lx, row + rx + 1);
    count += rx - lx + 1;
    if (lx < minX) minX = lx;
    if (rx > maxX) maxX = rx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    for (let ny = cy - 1; ny <= cy + 1; ny += 2) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let run = false;
      for (let i = lx; i <= rx; i += 1) {
        if (open(nrow + i)) {
          if (!run) stack.push(i, ny);
          run = true;
        } else {
          run = false;
        }
      }
    }
  }
  const grow = [];
  const x0 = Math.max(0, minX - 1);
  const x1 = Math.min(w - 1, maxX + 1);
  const y0 = Math.max(0, minY - 1);
  const y1 = Math.min(h - 1, maxY + 1);
  const limit = tol * tol;
  for (let py = y0; py <= y1; py += 1) {
    for (let px = x0; px <= x1; px += 1) {
      const p = py * w + px;
      if (done[p]) continue;
      let far = -1;
      let j = -1;
      for (let dir = 0; dir < 4; dir += 1) {
        const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
        const dy = dir === 2 ? 1 : dir === 3 ? -1 : 0;
        const bx = px - dx;
        const by = py - dy;
        if (bx < 0 || by < 0 || bx >= w || by >= h || !done[by * w + bx]) continue;
        for (let k = 1; k <= REACH; k += 1) {
          const mx = px + dx * k;
          const my = py + dy * k;
          if (mx < 0 || my < 0 || mx >= w || my >= h) break;
          const m = my * w + mx;
          if (done[m]) break;
          const q = m * 4;
          const dr = data[q] - r0;
          const dg = data[q + 1] - g0;
          const db = data[q + 2] - b0;
          const dist = dr * dr + dg * dg + db * db;
          if (dist > far) {
            far = dist;
            j = q;
          }
        }
      }
      if (j < 0) continue;
      const i = p * 4;
      const vr = data[j] - r0;
      const vg = data[j + 1] - g0;
      const vb = data[j + 2] - b0;
      const vv = vr * vr + vg * vg + vb * vb;
      if (vv <= limit) continue;
      const t = ((data[i] - r0) * vr + (data[i + 1] - g0) * vg + (data[i + 2] - b0) * vb) / vv;
      if (t >= 0.5) continue;
      const a = Math.max(0, t);
      grow.push(i, Math.round(nr + a * (data[j] - nr)), Math.round(ng + a * (data[j + 1] - ng)), Math.round(nb + a * (data[j + 2] - nb)));
    }
  }
  for (let py = minY; py <= maxY; py += 1) {
    const row = py * w;
    for (let px = minX; px <= maxX; px += 1) {
      if (!done[row + px]) continue;
      const i = (row + px) * 4;
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
      data[i + 3] = na;
    }
  }
  for (let k = 0; k < grow.length; k += 4) {
    const i = grow[k];
    data[i] = grow[k + 1];
    data[i + 1] = grow[k + 2];
    data[i + 2] = grow[k + 3];
    data[i + 3] = na;
  }
  return count + grow.length / 4;
}

function blankOn(ctx, scale) {
  ctx.fillStyle = COLORS[ERASER];
  ctx.fillRect(0, 0, GRID_W * scale, GRID_H * scale);
}

function fillImage(ctx, s, scale) {
  if (!ctx || typeof ctx.getImageData !== 'function' || !s || !s.pts || !s.pts.length) return null;
  const w = GRID_W * scale;
  const h = GRID_H * scale;
  let img = null;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
  if (!img || !img.data || img.data.length < w * h * 4) return null;
  const x = Math.min(w - 1, Math.max(0, Math.round(s.pts[0][0] * scale)));
  const y = Math.min(h - 1, Math.max(0, Math.round(s.pts[0][1] * scale)));
  const n = floodFill(img.data, w, h, x, y, rgbaOf(colorOf(s)));
  if (n && typeof ctx.putImageData === 'function') ctx.putImageData(img, 0, 0);
  return { img, n };
}

export function fillOn(ctx, s, scale) {
  const out = fillImage(ctx, s, scale);
  return out ? out.n : -1;
}

export function strokeOn(ctx, s, scale, from = 0) {
  if (!ctx || !s || !s.pts || !s.pts.length) return;
  if (isFill(s)) {
    fillImage(ctx, s, scale);
    return;
  }
  const col = colorOf(s);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = (SIZES[s.z] || SIZES[1]) * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pts = s.pts;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * scale, pts[0][1] * scale, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, from - 1);
  ctx.beginPath();
  ctx.moveTo(pts[start][0] * scale, pts[start][1] * scale);
  for (let i = start + 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
  ctx.stroke();
}

function samePrefix(keys, all) {
  if (keys.length > all.length) return false;
  for (let i = 0; i < keys.length; i += 1) if (keys[i] !== all[i]) return false;
  return true;
}

export function createPainter(scale, keep = SNAPSHOTS) {
  let snaps = [];
  let owner = null;
  return {
    paint(ctx, list) {
      if (!ctx) return;
      if (ctx !== owner) {
        owner = ctx;
        snaps = [];
      }
      const strokes = (Array.isArray(list) ? list : []).filter((s) => s && s.pts && s.pts.length);
      let last = -1;
      for (let i = 0; i < strokes.length; i += 1) if (isFill(strokes[i])) last = i;
      const keys = [];
      for (let i = 0; i <= last; i += 1) keys.push(encodeStroke(strokes[i]));
      snaps = snaps.filter((x) => samePrefix(x.keys, keys));
      let best = null;
      for (const x of snaps) if (!best || x.n > best.n) best = x;
      let start = 0;
      if (best && typeof ctx.putImageData === 'function') {
        ctx.putImageData(best.img, 0, 0);
        start = best.n;
      } else {
        blankOn(ctx, scale);
      }
      for (let i = start; i < strokes.length; i += 1) {
        const s = strokes[i];
        if (!isFill(s)) {
          strokeOn(ctx, s, scale);
          continue;
        }
        const out = fillImage(ctx, s, scale);
        if (out && keep > 0) {
          snaps.push({ n: i + 1, keys: keys.slice(0, i + 1), img: out.img });
          if (snaps.length > keep) snaps.shift();
        }
      }
    },
    reset() {
      snaps = [];
    },
    get size() {
      return snaps.length;
    },
  };
}

export function paintInk(ctx, strokes, scale) {
  createPainter(scale, 0).paint(ctx, strokes);
}
