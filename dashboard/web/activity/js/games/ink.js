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

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VAL = new Map(Array.from(ABC).map((c, i) => [c, i]));
const NEAR = 31;

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
  let out = ABC[clampInt(stroke.c, COLORS.length - 1)] + ABC[clampInt(stroke.z, SIZES.length - 1)];
  let [px, py] = quantise(pts[0][0], pts[0][1]);
  out += big(px) + big(py);
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
  const z = at(1);
  if (c === undefined || z === undefined || c >= COLORS.length || z >= SIZES.length) return null;
  const read2 = (i) => {
    const a = at(i);
    const b = at(i + 1);
    return a === undefined || b === undefined ? null : a * 64 + b;
  };
  let x = read2(2);
  let y = read2(4);
  if (x === null || y === null || x > GRID_W || y > GRID_H) return null;
  const pts = [[x, y]];
  let i = 6;
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
  return { c, z, pts };
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
  const pts = simplify(dedupe(stroke.pts || []), eps);
  if (!pts.length) return [];
  const parts = [];
  let start = 0;
  while (start < pts.length) {
    let end = start + 1;
    let text = encodeStroke({ c: stroke.c, z: stroke.z, pts: pts.slice(start, end) });
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

export function fitInk(strokes, k, level = 0) {
  for (let lvl = Math.max(0, level); lvl < LEVELS.length; lvl += 1) {
    const parts = [];
    for (const s of strokes) parts.push(...encodeParts(s, LEVELS[lvl]));
    const chunks = pack(parts, k);
    if (chunks.length <= MAX_CHUNKS && inkBytes(chunks) <= INK_BYTES) return { chunks, level: lvl, count: parts.length };
  }
  return null;
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
  return { t: 'ink', k, si, o, s: encodeStroke({ c: stroke.c, z: stroke.z, pts: pts.slice(from) }) };
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
  if (!cur || cur.pts.length !== msg.o) return false;
  cur.pts.push(...d.pts.slice(1));
  return true;
}

export function pruneLive(live, committed) {
  for (const si of [...live.keys()]) if (si < committed) live.delete(si);
}
