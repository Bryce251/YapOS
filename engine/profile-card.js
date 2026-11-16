import pngjs from 'pngjs';
import { bundledFontPath, loadFont, layoutLine, fillPath, Resampler, scaleImage } from './imaging.js';
import { decodePng } from './imaging-png.js';
import { decodeJpeg } from './imaging-jpeg.js';

const { PNG } = pngjs;

export const CARD_W = 900;
export const CARD_H = 360;
const AVATAR = 170;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

const hex = (h, fallback = [124, 92, 255]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgbOf = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

function flatten(commands, edges, ox, oy) {
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const line = (x0, y0, x1, y1) => { if (y0 !== y1) edges.push(x0 - ox, y0 - oy, x1 - ox, y1 - oy); };
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
      const n = Math.max(2, Math.min(16, Math.ceil((Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x - c.x1, c.y - c.y1)) / 2)));
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
      const n = Math.max(2, Math.min(24, Math.ceil((Math.hypot(c.x1 - cx, c.y1 - cy) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2)) / 2)));
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

export function createCanvas(w, h) {
  const data = new Uint8Array(w * h * 4);
  const blend = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
    const p = (y * w + x) * 4;
    const al = Math.min(1, a);
    data[p] = Math.round(data[p] + (rgb[0] - data[p]) * al);
    data[p + 1] = Math.round(data[p + 1] + (rgb[1] - data[p + 1]) * al);
    data[p + 2] = Math.round(data[p + 2] + (rgb[2] - data[p + 2]) * al);
    data[p + 3] = Math.max(data[p + 3], Math.round(al * 255));
  };
  const cornerCover = (x, y, x0, y0, x1, y1, r) => {
    const px = x + 0.5;
    const py = y + 0.5;
    let dx = 0;
    let dy = 0;
    if (px < x0 + r) dx = x0 + r - px;
    else if (px > x1 - r) dx = px - (x1 - r);
    if (py < y0 + r) dy = y0 + r - py;
    else if (py > y1 - r) dy = py - (y1 - r);
    if (!dx || !dy) return 1;
    return Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
  };
  const c = {
    w, h, data, blend,
    rect(x0, y0, rw, rh, rgb, { radius = 0, alpha = 1, gradient = null } = {}) {
      const x1 = x0 + rw;
      const y1 = y0 + rh;
      const r = Math.min(radius, rw / 2, rh / 2);
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
        const col = gradient ? gradient.map((g, i) => rgb[i] + (g - rgb[i]) * ((y - y0) / Math.max(1, rh))) : rgb;
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
          const cov = r ? cornerCover(x, y, x0, y0, x1, y1, r) : 1;
          blend(x, y, col, cov * alpha);
        }
      }
    },
    circle(cx, cy, r, rgb, alpha = 1) {
      for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(h - 1, Math.ceil(cy + r + 1)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(w - 1, Math.ceil(cx + r + 1)); x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          blend(x, y, rgb, Math.max(0, Math.min(1, r - d + 0.5)) * alpha);
        }
      }
    },
    image(rgba, size, x0, y0, { round = true } = {}) {
      const r = size / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const p = (y * size + x) * 4;
          const a = rgba[p + 3] / 255;
          const cov = round ? Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - r, y + 0.5 - r) + 0.5)) : 1;
          blend(x0 + x, y0 + y, [rgba[p], rgba[p + 1], rgba[p + 2]], a * cov);
        }
      }
    },
  };
  return c;
}

export function loadCardFont() {
  const file = bundledFontPath();
  return file ? loadFont(file) : null;
}

export function measure(font, text, size) {
  return (layoutLine(font, text).width * size) / font.unitsPerEm;
}

export function fitText(font, text, size, maxWidth) {
  const s = String(text ?? '');
  if (measure(font, s, size) <= maxWidth) return s;
  const dots = font.glyphFor('…') ? '…' : '...';
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(font, chars.slice(0, mid).join('').trimEnd() + dots, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join('').trimEnd() + dots : '';
}

export function drawText(canvas, font, text, x, baseline, size, rgb, { align = 'left', maxWidth = Infinity } = {}) {
  const s = maxWidth === Infinity ? String(text ?? '') : fitText(font, text, size, maxWidth);
  if (!s) return 0;
  const { placed, width: units } = layoutLine(font, s);
  if (!placed.length) return 0;
  const scale = size / font.unitsPerEm;
  const tw = units * scale;
  const left = align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x;
  const ox = Math.floor(left) - 2;
  const oy = Math.floor(baseline - size * 1.05);
  const bw = Math.ceil(tw) + 6;
  const bh = Math.ceil(size * 1.4) + 2;
  const edges = [];
  for (const p of placed) flatten(p.glyph.getPath(left + p.x * scale, baseline, size).commands, edges, ox, oy);
  const cover = fillPath(edges, bw, bh, 4);
  for (let y = 0; y < bh; y++) {
    for (let xx = 0; xx < bw; xx++) {
      const a = cover[y * bw + xx];
      if (a > 0) canvas.blend(ox + xx, oy + y, rgb, a);
    }
  }
  return tw;
}

export async function decodeAvatar(buf, size = AVATAR) {
  if (!buf || buf.length < 8 || buf.length > MAX_AVATAR_BYTES) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      let r = null;
      await decodePng(buf, {
        maxPixels: 2048 * 2048,
        maxSide: 2048,
        onSize: (w, h) => { r = new Resampler(w, h, size, size); },
        onRow: (row, y) => r.addRow(row, y, 4),
      });
      return r ? r.finish().data : null;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const img = decodeJpeg(buf, { maxPixels: 2048 * 2048, needWidth: size, needHeight: size });
      return scaleImage(img.data, img.width, img.height, size, size, 3).data;
    }
  } catch {
    return null;
  }
  return null;
}

const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');

const WHITE = [245, 246, 250];
const GREY = [160, 166, 186];
const DIM = [44, 46, 64];
const BG_TOP = [30, 31, 43];
const BG_BOTTOM = [22, 23, 33];

export function renderProfileCard(view, { font = loadCardFont(), avatar = null } = {}) {
  if (!font) return null;
  const c = createCanvas(CARD_W, CARD_H);
  const accent = view.accent ? hex(view.accent) : [124, 92, 255];
  c.rect(0, 0, CARD_W, CARD_H, BG_TOP, { radius: 28, gradient: BG_BOTTOM });
  c.rect(40, 0, CARD_W - 80, 6, accent, { radius: 3 });
  c.rect(0, 0, CARD_W, CARD_H, accent, { radius: 28, alpha: 0.06 });

  const cx = 125;
  const cy = 125;
  c.circle(cx, cy, AVATAR / 2 + 7, accent);
  c.circle(cx, cy, AVATAR / 2 + 2, BG_TOP);
  if (avatar && avatar.length === AVATAR * AVATAR * 4) {
    c.image(avatar, AVATAR, cx - AVATAR / 2, cy - AVATAR / 2);
  } else {
    c.circle(cx, cy, AVATAR / 2, DIM);
    const initial = Array.from(String(view.name || '?').trim()).find((ch) => font.glyphFor(ch)) || '?';
    drawText(c, font, initial.toUpperCase(), cx, cy + 30, 86, WHITE, { align: 'center' });
  }

  const left = 245;
  const right = CARD_W - 40;
  const levelText = num(view.level);
  const levelW = measure(font, levelText, 52);
  drawText(c, font, levelText, right, 94, 52, WHITE, { align: 'right' });
  drawText(c, font, 'LEVEL', right - levelW - 10, 94, 22, GREY, { align: 'right' });
  const nameRoom = right - levelW - measure(font, 'LEVEL', 22) - 30 - left;
  drawText(c, font, view.name || 'Someone', left, 92, 44, WHITE, { maxWidth: nameRoom });

  let sx = left;
  if (view.username) sx += drawText(c, font, `@${view.username}`, sx, 128, 24, GREY, { maxWidth: 300 }) + 16;
  if (view.clan) {
    const tag = view.clan.tag ? `[${view.clan.tag}] ` : '';
    drawText(c, font, `${tag}${view.clan.name}`, sx, 128, 24, view.clan.colour ? hex(view.clan.colour) : accent, { maxWidth: right - sx });
  }

  const barY = 148;
  const barW = right - left;
  c.rect(left, barY, barW, 24, DIM, { radius: 12 });
  const frac = Math.max(0, Math.min(1, Number(view.frac) || 0));
  if (frac > 0) c.rect(left, barY, Math.max(24, barW * frac), 24, accent, { radius: 12 });
  const progress = view.maxed ? 'Max level' : `${num(view.into)} / ${num(view.need)} XP`;
  drawText(c, font, progress, left, 200, 20, GREY, { maxWidth: barW / 2 });
  drawText(c, font, `${num(view.xp)} XP total`, right, 200, 20, GREY, { align: 'right', maxWidth: barW / 2 });

  const tiles = (view.tiles || []).slice(0, 4);
  if (tiles.length) {
    const gap = 14;
    const tx0 = 40;
    const tw = (CARD_W - 80 - gap * (tiles.length - 1)) / tiles.length;
    tiles.forEach((t, i) => {
      const x = tx0 + i * (tw + gap);
      c.rect(x, 222, tw, 78, DIM, { radius: 16 });
      drawText(c, font, String(t.label || '').toUpperCase(), x + 16, 248, 16, GREY, { maxWidth: tw - 32 });
      drawText(c, font, String(t.value ?? ''), x + 16, 286, 28, t.hidden ? GREY : WHITE, { maxWidth: tw - 32 });
    });
  }

  if (view.footer) drawText(c, font, view.footer, 40, 336, 18, GREY, { maxWidth: CARD_W - 80 });

  const png = new PNG({ width: CARD_W, height: CARD_H });
  png.data = Buffer.from(c.data.buffer, c.data.byteOffset, c.data.byteLength);
  return PNG.sync.write(png);
}
