import { focusFirst, h, nextId, replace, trapFocus } from '../dom.js';
import { icon } from '../icons.js';
import { badgeArt, button, confirmDialog, setBusy, switchControl, toast } from '../ui.js';
import { tabBar } from '../kit.js';
import { ApiError } from '../api.js';
import { formatNumber } from '../format.js';
import {
  BANNERS, BIO_MAX, CUSTOM_GRADIENT_START, DENSITIES, EFFECTS, FEATURED, FONT_CATEGORIES, NAME_FONTS, NAME_GRADIENTS, NAME_PALETTE, PIN_MAX, PRONOUNS_MAX, RINGS, SECTIONS, STATUS_EMOJI_MAX, STATUS_MAX, GRADIENT_ANGLES, THEMES, THEME_MODES, THEME_PATTERNS,
  cleanStatusEmoji, defaultLook, fontById, lookBody, mixHex, moveItem, nameContrast, rawGradientCss, readCrop, readLook, readMotion, sameLook, textLength, themeById, themeColours, themeShades,
} from '../profile-look.js';
import { ANIM_MAX_BYTES, AnimError, animatedFrames, checkAnimSize, readAnimated, sizeText, webpAnimated } from '../banner-anim.js';
import { effectThumb } from '../profile-fx.js';
import { allBadges, cropVars, isSpecial, nameGradientClass, openAllBadges, paintNameGradient } from './profile.js';
import { colourRow, createColourPicker, parseColour } from '../colour-picker.js';
import { dataUrlBytes, loadPicture, sniffFile } from './owner-badges.js';
import { avatarControls } from './avatar-editor.js';

export const LOOK_API = '/api/me/profile-look';
export const BANNER_API = '/api/me/profile-banner';
export const BANNER_W = 1500;
export const BANNER_H = 500;
export const BANNER_RATIO = 3;
export const BANNER_MIN_OUT_W = 600;
export const BANNER_MAX_OUT_W = 3000;
export const BANNER_BYTES = 1400 * 1024;
export const BANNER_FILE_MAX = 10 * 1024 * 1024;
export const BANNER_STEP_WIDTHS = Object.freeze([2400, 1800, 1500]);
export const TOP_QUALITIES = Object.freeze([0.92, 0.86, 0.8]);
export const LOW_QUALITIES = Object.freeze([0.72, 0.64, 0.56]);
export const CROP_MAX_ZOOM = 4;
export const CROP_ZOOM_LIMIT = 8;
export const CROP_ZOOM_STEP = 1.1;
export const CROP_PAN_STEP = 0.05;
export const CROP_STAGE_W = 1200;
export const CROP_STAGE_H = 600;
export const CROP_FRAME = Object.freeze({ x: 0.05, y: 0.2, w: 0.9, h: 0.6 });
export const CROP_PREVIEW_W = 600;
export const CROP_PREVIEW_H = 200;
export const PRONOUN_IDEAS = Object.freeze(['she/her', 'he/him', 'they/them', 'any pronouns']);
export const PICK_SEARCH_AT = 12;
export const STILL_MAX_W = 1500;
export const STILL_BYTES = 280 * 1024;
export const STILL_WIDTHS = Object.freeze([1500, 1000, 700]);
export const STILL_QUALITIES = Object.freeze([0.86, 0.76, 0.66, 0.56]);
export const CUSTOM_THEME_START = Object.freeze({ base: '#7c5cff', alt: '#0ea5e9', accent: '#f2613f' });

const TABS = Object.freeze([
  Object.freeze({ id: 'badges', label: 'Badges', icon: 'star' }),
  Object.freeze({ id: 'name', label: 'Name', icon: 'palette' }),
  Object.freeze({ id: 'card', label: 'Card', icon: 'sparkles' }),
  Object.freeze({ id: 'theme', label: 'Theme', icon: 'sun' }),
  Object.freeze({ id: 'about', label: 'About', icon: 'user' }),
  Object.freeze({ id: 'layout', label: 'Layout', icon: 'list' }),
]);

const num = (v, d = 0) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const dims = (width, height) => [Math.max(1, Math.floor(num(width, 1))), Math.max(1, Math.floor(num(height, 1)))];

export function coverSize(width, height, ratio = BANNER_RATIO) {
  const [w, ht] = dims(width, height);
  return w / ht > ratio ? { sw: ht * ratio, sh: ht } : { sw: w, sh: w / ratio };
}

export function maxZoom(width, height) {
  return round2(clamp(coverSize(width, height).sw / BANNER_W, CROP_MAX_ZOOM, CROP_ZOOM_LIMIT));
}

export function startView(width, height) {
  const [w, ht] = dims(width, height);
  return { zoom: 1, cx: w / 2, cy: ht / 2 };
}

export function clampView(width, height, view) {
  const [w, ht] = dims(width, height);
  const base = coverSize(w, ht);
  const zoom = clamp(num(view && view.zoom, 1), 1, maxZoom(w, ht));
  const sw = base.sw / zoom;
  const sh = sw / BANNER_RATIO;
  return {
    zoom,
    cx: clamp(num(view && view.cx, w / 2), sw / 2, w - sw / 2),
    cy: clamp(num(view && view.cy, ht / 2), sh / 2, ht - sh / 2),
  };
}

export function cropRect(width, height, view) {
  const [w, ht] = dims(width, height);
  const v = clampView(w, ht, view);
  const sw = coverSize(w, ht).sw / v.zoom;
  const sh = sw / BANNER_RATIO;
  return { sx: round2(clamp(v.cx - sw / 2, 0, w - sw)), sy: round2(clamp(v.cy - sh / 2, 0, ht - sh)), sw: round2(sw), sh: round2(sh) };
}

export function panView(width, height, view, dx, dy, frameWidth) {
  const v = clampView(width, height, view);
  const scale = cropRect(width, height, v).sw / Math.max(1e-6, num(frameWidth, 1));
  return clampView(width, height, { zoom: v.zoom, cx: v.cx - num(dx) * scale, cy: v.cy - num(dy) * scale });
}

export function zoomView(width, height, view, factor, ax = 0.5, ay = 0.5) {
  const v = clampView(width, height, view);
  const r = cropRect(width, height, v);
  const px = r.sx + num(ax, 0.5) * r.sw;
  const py = r.sy + num(ay, 0.5) * r.sh;
  const zoom = clamp(v.zoom * (num(factor, 1) > 0 ? num(factor, 1) : 1), 1, maxZoom(width, height));
  const sw = coverSize(width, height).sw / zoom;
  const sh = sw / BANNER_RATIO;
  return clampView(width, height, { zoom, cx: px - num(ax, 0.5) * sw + sw / 2, cy: py - num(ay, 0.5) * sh + sh / 2 });
}

export function setZoom(width, height, view, zoom) {
  const v = clampView(width, height, view);
  return zoomView(width, height, v, num(zoom, v.zoom) / v.zoom);
}

export function outputSize(rect) {
  const width = clamp(Math.round(num(rect && rect.sw, BANNER_W)), BANNER_MIN_OUT_W, BANNER_MAX_OUT_W);
  return { width, height: Math.round(width / BANNER_RATIO) };
}

export function downscaleSteps(from, to) {
  const target = Math.max(1, Math.round(num(to, 1)));
  const out = [];
  let w = Math.max(1, num(from, 1));
  while (w / 2 > target) {
    w = Math.round(w / 2);
    out.push(w);
  }
  out.push(target);
  return out;
}

export function encodePlan(width) {
  const widths = [width];
  for (const w of BANNER_STEP_WIDTHS) if (w < widths[widths.length - 1]) widths.push(w);
  const plan = [];
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const w of widths) for (const q of TOP_QUALITIES) plan.push({ type, w, q });
    for (const q of LOW_QUALITIES) plan.push({ type, w: widths[widths.length - 1], q });
  }
  return plan;
}

export function softNote(width, height, rect) {
  const used = Math.round(num(rect && rect.sw, BANNER_W));
  if (used >= BANNER_W) return '';
  if (coverSize(width, height).sw < BANNER_W) return 'This picture is smaller than 1500 by 500, so your banner will look a little soft. A bigger picture looks sharper.';
  return `Zoomed in this far, only ${used} pixels of your picture fill the banner, so it will look soft. Zoom out a little for a sharper banner.`;
}

export const zoomText = (zoom) => `${Math.round(num(zoom, 1) * 100)}%`;

function freshCanvas(doc, width, height) {
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) throw new Error("Your browser can't resize pictures here. Try another browser.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

export function drawBanner(src, rect, width, { doc = document } = {}) {
  let from = src;
  let box = [rect.sx, rect.sy, rect.sw, rect.sh];
  let last = null;
  for (const w of downscaleSteps(rect.sw, width)) {
    const ht = Math.round(w / BANNER_RATIO);
    const { canvas, ctx } = freshCanvas(doc, w, ht);
    ctx.drawImage(from, ...box, 0, 0, w, ht);
    from = canvas;
    box = [0, 0, w, ht];
    last = canvas;
  }
  return last;
}

export function encodeBanner(src, { doc = document, max = BANNER_BYTES, rect = null } = {}) {
  const width = src.naturalWidth || src.width;
  const height = src.naturalHeight || src.height;
  const r = rect || cropRect(width, height, startView(width, height));
  const made = new Map();
  const missing = new Set();
  for (const step of encodePlan(outputSize(r).width)) {
    if (missing.has(step.type)) continue;
    if (!made.has(step.w)) made.set(step.w, drawBanner(src, r, step.w, { doc }));
    const url = made.get(step.w).toDataURL(step.type, step.q);
    if (!url.startsWith(`data:${step.type}`)) {
      missing.add(step.type);
      continue;
    }
    if (dataUrlBytes(url) <= max) return url;
  }
  throw new Error('That picture is too detailed to use as a banner. Try a simpler one.');
}

export function viewToCrop(width, height, view) {
  const [w, ht] = dims(width, height);
  const v = clampView(w, ht, view);
  return readCrop({ zoom: clamp(v.zoom, 1, 8), x: clamp(v.cx / w, 0, 1), y: clamp(v.cy / ht, 0, 1) });
}

export function cropToView(width, height, crop) {
  const [w, ht] = dims(width, height);
  const c = readCrop(crop);
  return c ? clampView(w, ht, { zoom: c.zoom, cx: c.x * w, cy: c.y * ht }) : startView(w, ht);
}

export function chooseBannerCrop(src, { doc = document, moving = null, crop = null } = {}) {
  const width = src.naturalWidth || src.width;
  const height = src.naturalHeight || src.height;
  return new Promise((resolve) => {
    let view = moving && crop ? cropToView(width, height, crop) : startView(width, height);
    let done = false;
    const pointers = new Map();
    let gesture = null;
    const titleId = nextId('crop');
    const helpId = nextId('crop-help');
    const rangeId = nextId('crop-zoom');
    const previous = doc.activeElement;
    const top = maxZoom(width, height);
    const motion = moving ? { width, height, still: moving } : null;
    const movingImg = (cls) => h('img', { class: ['pe-crop-moving', cls, 'is-crop'], src: moving, alt: '', attrs: { draggable: 'false', 'aria-hidden': 'true' } });
    const stageImg = motion ? movingImg('pe-crop-moving-stage') : null;
    const canvas = motion ? h('div', { class: 'pe-crop-window', attrs: { 'aria-hidden': 'true' } }, stageImg) : h('canvas', { class: 'pe-crop-canvas', attrs: { width: String(CROP_STAGE_W), height: String(CROP_STAGE_H), 'aria-hidden': 'true' } });
    const stage = h('div', {
      class: ['pe-crop-stage', motion ? 'is-moving' : ''],
      attrs: { tabindex: '0', role: 'group', 'aria-label': 'Banner picture. Drag to move it.', 'aria-describedby': helpId },
    }, canvas, h('div', { class: 'pe-crop-frame', attrs: { 'aria-hidden': 'true' } }));
    const range = h('input', { type: 'range', id: rangeId, class: 'range pe-crop-range', attrs: { min: '1', max: String(top), step: '0.01', 'aria-label': 'Zoom' } });
    const level = h('span', { class: 'pe-crop-level', attrs: { 'aria-hidden': 'true' } });
    const zoomOut = h('button', { type: 'button', class: 'icon-btn pe-crop-out', attrs: { 'aria-label': 'Zoom out' } }, icon('minus', { size: 16 }));
    const zoomIn = h('button', { type: 'button', class: 'icon-btn pe-crop-in', attrs: { 'aria-label': 'Zoom in' } }, icon('plus', { size: 16 }));
    const note = h('p', { class: 'pe-crop-note', attrs: { role: 'status', 'aria-live': 'polite' } });
    const preview = (kind, label) => {
      const img = motion ? movingImg('pe-crop-moving-prev') : null;
      const c = img ? h('span', { class: 'pe-crop-prev-clip' }, img) : h('canvas', { class: 'pe-crop-prev-canvas', attrs: { width: String(CROP_PREVIEW_W), height: String(CROP_PREVIEW_H), 'aria-hidden': 'true' } });
      const fig = h('figure', { class: ['pe-crop-prev', `is-${kind}`] },
        h('div', { class: 'pe-crop-prev-box' }, c, h('span', { class: 'pe-crop-prev-avatar', attrs: { 'aria-hidden': 'true' } })),
        h('figcaption', { class: 'pe-crop-prev-label', text: label }));
      return { fig, img, ctx: !img && typeof c.getContext === 'function' ? c.getContext('2d') : null };
    };
    const onProfile = preview('profile', 'On your profile');
    const onParty = preview('party', 'On the Party card');
    const stageCtx = !motion && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    const fx = CROP_FRAME.x * CROP_STAGE_W;
    const fy = CROP_FRAME.y * CROP_STAGE_H;
    const fw = CROP_FRAME.w * CROP_STAGE_W;
    const paint = () => {
      const r = cropRect(width, height, view);
      if (motion) {
        const c = viewToCrop(width, height, view);
        for (const img of [stageImg, onProfile.img, onParty.img]) cropVars(img, motion, c);
        return r;
      }
      if (stageCtx) {
        const scale = fw / r.sw;
        const x0 = Math.max(0, r.sx - fx / scale);
        const y0 = Math.max(0, r.sy - fy / scale);
        const x1 = Math.min(width, r.sx + (CROP_STAGE_W - fx) / scale);
        const y1 = Math.min(height, r.sy + (CROP_STAGE_H - fy) / scale);
        stageCtx.imageSmoothingEnabled = true;
        stageCtx.imageSmoothingQuality = 'high';
        stageCtx.clearRect(0, 0, CROP_STAGE_W, CROP_STAGE_H);
        if (x1 > x0 && y1 > y0) stageCtx.drawImage(src, x0, y0, x1 - x0, y1 - y0, fx + (x0 - r.sx) * scale, fy + (y0 - r.sy) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
      }
      for (const p of [onProfile, onParty]) {
        if (!p.ctx) continue;
        p.ctx.imageSmoothingEnabled = true;
        p.ctx.imageSmoothingQuality = 'high';
        p.ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, CROP_PREVIEW_W, CROP_PREVIEW_H);
      }
      return r;
    };
    const sync = () => {
      const r = paint();
      const z = round2(view.zoom);
      range.value = String(z);
      range.setAttribute('aria-valuetext', zoomText(z));
      range.style.setProperty('--fill', `${top > 1 ? Math.round(((z - 1) / (top - 1)) * 100) : 0}%`);
      level.textContent = zoomText(z);
      zoomOut.disabled = z <= 1;
      zoomIn.disabled = z >= top;
      const soft = motion ? '' : softNote(width, height, r);
      note.textContent = soft;
      note.hidden = !soft;
    };
    const set = (next) => {
      view = clampView(width, height, next);
      sync();
    };
    const box = () => {
      const b = stage.getBoundingClientRect();
      return { left: b.left, top: b.top, width: Math.max(1, b.width || 0), height: Math.max(1, b.height || 0) };
    };
    const anchor = (b, x, y) => [((x - b.left) / b.width - CROP_FRAME.x) / CROP_FRAME.w, ((y - b.top) / b.height - CROP_FRAME.y) / CROP_FRAME.h];
    const begin = () => {
      gesture = pointers.size ? { view, b: box(), pts: [...pointers.values()].map((p) => ({ ...p })) } : null;
      stage.classList.toggle('is-dragging', pointers.size > 0);
    };
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      if (doc.activeElement !== stage) stage.focus();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {}
      begin();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!gesture || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = [...pointers.values()];
      const { b, pts } = gesture;
      const frameW = b.width * CROP_FRAME.w;
      if (now.length === 1 || pts.length === 1) {
        set(panView(width, height, gesture.view, now[0].x - pts[0].x, now[0].y - pts[0].y, frameW));
        return;
      }
      const d0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const d1 = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y) || 1;
      const m0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const m1 = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 };
      const [ax, ay] = anchor(b, m0.x, m0.y);
      const zoomed = zoomView(width, height, gesture.view, d1 / d0, ax, ay);
      set(panView(width, height, zoomed, m1.x - m0.x, m1.y - m0.y, frameW));
    });
    const lift = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      begin();
    };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unitPx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const b = box();
      const [ax, ay] = anchor(b, num(e.clientX, b.left + b.width / 2), num(e.clientY, b.top + b.height / 2));
      set(zoomView(width, height, view, Math.exp(-clamp(num(e.deltaY) * unitPx, -240, 240) * 0.002), clamp(ax, 0, 1), clamp(ay, 0, 1)));
    }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const step = CROP_PAN_STEP * (e.shiftKey ? 4 : 1);
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      let next = null;
      if (moves[e.key]) next = panView(width, height, view, moves[e.key][0], moves[e.key][1], 1);
      else if (e.key === '+' || e.key === '=') next = zoomView(width, height, view, CROP_ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') next = zoomView(width, height, view, 1 / CROP_ZOOM_STEP);
      else if (e.key === '0') next = startView(width, height);
      if (!next) return;
      e.preventDefault();
      set(next);
    });
    range.addEventListener('input', () => set(setZoom(width, height, view, Number(range.value))));
    zoomOut.addEventListener('click', () => set(zoomView(width, height, view, 1 / CROP_ZOOM_STEP)));
    zoomIn.addEventListener('click', () => set(zoomView(width, height, view, CROP_ZOOM_STEP)));
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else trapFocus(panel, e);
    }
    const finish = (value) => {
      if (done) return;
      done = true;
      doc.removeEventListener('keydown', onKey, true);
      root.remove();
      if (![...doc.querySelectorAll('.drawer-root')].some((r) => !r.classList.contains('is-closing'))) doc.body.classList.remove('has-modal');
      if (previous && previous.focus && previous.isConnected) previous.focus();
      resolve(value);
    };
    const reset = button({ label: 'Reset', icon: 'refresh', variant: 'ghost', className: 'pe-crop-reset', onClick: () => set(startView(width, height)) });
    const cancel = button({ label: 'Cancel', className: 'pe-crop-cancel', onClick: () => finish(null) });
    const ok = button({ label: 'Use this banner', icon: 'check', variant: 'primary', className: 'pe-crop-ok', onClick: () => finish(motion ? viewToCrop(width, height, view) : cropRect(width, height, view)) });
    const panel = h('div', { class: ['dialog-panel', 'pe-crop-panel'], attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { class: 'dialog-title', id: titleId, text: motion ? 'Position your moving banner' : 'Position your banner' }),
      h('p', { class: 'dialog-body', id: helpId, text: `Drag the picture to move it, and zoom with the slider, your mouse wheel or a pinch. On a keyboard, the arrow keys move it and + and - zoom.${motion ? ' Your GIF keeps moving on your profile and Party card. People who prefer less motion see its first frame.' : ''}` }),
      stage,
      h('div', { class: 'pe-crop-zoom' }, zoomOut, range, zoomIn, level),
      note,
      h('div', { class: 'pe-crop-previews' }, onProfile.fig, onParty.fig),
      h('div', { class: 'dialog-actions' }, reset, cancel, ok));
    const root = h('div', { class: ['dialog-root', 'pe-crop'] }, h('div', { class: 'dialog-overlay', on: { click: () => finish(null) } }), panel);
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(root);
    doc.body.classList.add('has-modal');
    sync();
    focusFirst(panel);
    stage.focus();
  });
}

export function stillPlan(width, height) {
  const [w, ht] = dims(width, height);
  const plan = [];
  for (const max of STILL_WIDTHS) {
    const sw = Math.min(max, w, STILL_MAX_W);
    if (plan.some((p) => p.w === sw)) continue;
    plan.push({ w: sw, h: Math.max(1, Math.round((sw * ht) / w)) });
  }
  return plan;
}

export function encodeStill(src, { doc = document, max = STILL_BYTES } = {}) {
  const width = src.naturalWidth || src.width;
  const height = src.naturalHeight || src.height;
  const missing = new Set();
  for (const size of stillPlan(width, height)) {
    const { canvas, ctx } = freshCanvas(doc, size.w, size.h);
    ctx.drawImage(src, 0, 0, width, height, 0, 0, size.w, size.h);
    for (const type of ['image/webp', 'image/jpeg']) {
      if (missing.has(type)) continue;
      for (const q of STILL_QUALITIES) {
        const url = canvas.toDataURL(type, q);
        if (!url.startsWith(`data:${type}`)) {
          missing.add(type);
          break;
        }
        if (dataUrlBytes(url) <= max) return url;
      }
    }
  }
  throw new Error("That GIF couldn't be turned into a banner. Try a smaller one.");
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error("That file couldn't be read. Pick it again."));
    r.readAsDataURL(file);
  });
}

export function movingSizeText(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(2)} MB`;
}

export async function processMoving(file, bytes, { choose = chooseBannerCrop, readUrl = readDataUrl, doc = document } = {}) {
  if (bytes.length > ANIM_MAX_BYTES) throw new Error(`Moving banners can be up to ${sizeText(ANIM_MAX_BYTES)}, and this one is ${movingSizeText(bytes.length)}. Try a shorter or smaller GIF.`);
  let info;
  try {
    info = readAnimated(bytes);
    checkAnimSize(info);
  } catch (err) {
    throw new Error(err instanceof AnimError ? err.message : "That GIF couldn't be read. Pick it again.");
  }
  const url = await readUrl(file);
  const src = await loadPicture(file);
  try {
    const crop = choose ? await choose({ width: info.width, height: info.height }, { moving: url }) : { zoom: 1, x: 0.5, y: 0.5 };
    if (!crop) return null;
    return { image: url, still: encodeStill(src, { doc }), crop, width: info.width, height: info.height, frames: info.frames };
  } finally {
    if (typeof src.close === 'function') src.close();
  }
}

export async function processBanner(file, { choose = chooseBannerCrop, readUrl = readDataUrl, doc = document } = {}) {
  if (!file) throw new Error('Pick a picture first.');
  if (Number(file.size) > BANNER_FILE_MAX) throw new Error(`That file is bigger than ${sizeText(BANNER_FILE_MAX)}. Pick a smaller picture.`);
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = sniffFile(head, file.type, file.name);
  if (kind === 'svg') throw new Error("SVG files can't be used for banners. Save it as a PNG first.");
  if (!['png', 'jpeg', 'webp', 'gif'].includes(kind)) throw new Error("That file isn't a picture YapOS can use. Use a PNG, JPG, WebP or GIF.");
  if (kind === 'gif' || (kind === 'webp' && webpAnimated(head))) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frames = animatedFrames(bytes);
    if (frames > 1 || (kind === 'webp' && frames !== 1)) return processMoving(file, bytes, { choose, readUrl, doc });
    if (frames < 0 && kind === 'gif') throw new Error("That GIF couldn't be read. It may be damaged. Try saving it again.");
  }
  const src = await loadPicture(file);
  try {
    const rect = choose ? await choose(src) : null;
    if (choose && !rect) return null;
    return encodeBanner(src, { rect, doc });
  } finally {
    if (typeof src.close === 'function') src.close();
  }
}

export function currentScheme(doc = globalThis.document, win = globalThis.window) {
  const forced = doc && doc.documentElement && typeof doc.documentElement.getAttribute === 'function' ? doc.documentElement.getAttribute('data-theme') : null;
  if (forced === 'dark' || forced === 'light') return forced;
  try {
    return win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function themeTile(t, label) {
  const thumb = h('span', { class: ['pe-theme-thumb', t ? `pat-${t.pattern}` : ''], attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'pe-theme-card' }, h('span', { class: 'pe-theme-line' }), h('span', { class: 'pe-theme-line is-short' }), h('span', { class: 'pe-theme-dot' })));
  if (t) {
    const s = themeShades(t, t.mode === 'auto' ? currentScheme() : t.mode);
    thumb.style.setProperty('--tt-bg', s.bg);
    thumb.style.setProperty('--tt-bg2', s.bg2);
    thumb.style.setProperty('--tt-glow', s.glow);
    thumb.style.setProperty('--tt-surface', s.surface);
    thumb.style.setProperty('--tt-border', s.border);
    thumb.style.setProperty('--tt-text', s.text2);
    thumb.style.setProperty('--tt-accent', s.accent);
  }
  return [thumb, h('span', { class: 'pe-theme-name', text: label })];
}

export function effectTile(e) {
  const box = h('span', { class: 'pe-effect-thumb', attrs: { 'aria-hidden': 'true' } });
  if (e.id !== 'none') {
    const c = effectThumb(e.id, { width: 96, height: 60 });
    if (c) {
      c.classList?.add?.('pe-effect-canvas');
      box.appendChild(c);
    }
  } else box.appendChild(icon('x', { size: 18 }));
  return [box, h('span', { class: 'pe-effect-name', text: e.label })];
}

function choiceGroup({ label, options, value, onPick, className = '' }) {
  let current = value;
  const buttons = new Map();
  const group = h('div', { class: ['pe-choices', className], attrs: { role: 'radiogroup', 'aria-label': label } });
  const set = (id) => {
    current = id;
    for (const [key, b] of buttons) {
      const on = key === id;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
      b.tabIndex = on ? 0 : -1;
    }
  };
  options.forEach((o) => {
    const b = h('button', {
      type: 'button',
      class: ['pe-choice', o.className || ''],
      title: o.label,
      disabled: Boolean(o.disabled),
      attrs: { 'data-choice': o.id, role: 'radio', 'aria-label': o.label },
    }, 'body' in o ? o.body : h('span', { class: 'pe-choice-text', text: o.label }));
    if (o.vars) for (const [k, v] of Object.entries(o.vars)) b.style.setProperty(k, v);
    b.addEventListener('click', () => {
      if (b.disabled) return;
      set(o.id);
      onPick(o.id);
    });
    b.addEventListener('keydown', (e) => {
      const ids = options.filter((x) => !x.disabled).map((x) => x.id);
      const i = ids.indexOf(o.id);
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = ids[(i + 1) % ids.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = ids[(i - 1 + ids.length) % ids.length];
      if (next === null) return;
      e.preventDefault();
      set(next);
      onPick(next);
      buttons.get(next)?.focus();
    });
    buttons.set(o.id, b);
    group.appendChild(b);
  });
  set(current);
  return { el: group, set, get value() { return current; } };
}

export function fontPicker({ fonts = NAME_FONTS, categories = FONT_CATEGORIES, value, sample = '', onPick }) {
  let current = fontById(value).id;
  let shown = fontById(current).category;
  const buttons = new Map();
  const chips = new Map();
  const samples = [];
  const cats = categories.filter((c) => fonts.some((f) => f.category === c.id));
  const chipRow = h('div', { class: 'pe-font-cats', attrs: { role: 'group', 'aria-label': 'Font groups' } });
  const grid = h('div', { class: 'pe-font-grid', attrs: { role: 'radiogroup', 'aria-label': 'Name font' } });
  const note = h('p', { class: 'field-help pe-font-current', attrs: { 'aria-live': 'polite' } });
  const visible = () => fonts.filter((f) => f.category === shown).map((f) => f.id);
  const roving = () => {
    const ids = visible();
    const focusId = ids.includes(current) ? current : ids[0];
    for (const [id, b] of buttons) b.tabIndex = id === focusId ? 0 : -1;
  };
  const paint = () => {
    for (const [id, b] of buttons) {
      const on = id === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
      b.hidden = fontById(id).category !== shown;
    }
    const pickedCat = fontById(current).category;
    for (const [id, c] of chips) {
      c.setAttribute('aria-pressed', id === shown ? 'true' : 'false');
      c.classList.toggle('is-on', id === shown);
      c.classList.toggle('has-pick', id === pickedCat);
    }
    note.textContent = `Font: ${fontById(current).label}`;
    roving();
  };
  const show = (cat) => {
    if (!cats.some((c) => c.id === cat)) return;
    shown = cat;
    paint();
  };
  const choose = (id, focus = false) => {
    current = id;
    paint();
    if (focus) buttons.get(id)?.focus();
    onPick(id);
  };
  for (const c of cats) {
    const chip = h('button', { type: 'button', class: 'pe-font-cat', text: c.label, attrs: { 'data-font-cat': c.id, 'aria-pressed': 'false' } });
    chip.addEventListener('click', () => show(c.id));
    chips.set(c.id, chip);
    chipRow.appendChild(chip);
  }
  for (const f of fonts) {
    const text = h('span', { class: ['pe-font-sample', f.id !== 'default' ? `name-font-${f.id}` : ''], text: sample || f.label });
    samples.push([text, f.label]);
    const b = h('button', {
      type: 'button',
      class: 'pe-font',
      title: f.label,
      attrs: { 'data-choice': f.id, 'data-font-cat': f.category, role: 'radio', 'aria-label': f.label, 'aria-checked': 'false' },
    }, text, h('span', { class: 'pe-font-label', text: f.label, attrs: { 'aria-hidden': 'true' } }));
    b.addEventListener('click', () => choose(f.id));
    b.addEventListener('keydown', (e) => {
      const ids = visible();
      const i = ids.indexOf(f.id);
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = ids[(i + 1) % ids.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = ids[(i - 1 + ids.length) % ids.length];
      else if (e.key === 'Home') next = ids[0];
      else if (e.key === 'End') next = ids[ids.length - 1];
      if (next === null || next === undefined) return;
      e.preventDefault();
      choose(next, true);
    });
    buttons.set(f.id, b);
    grid.appendChild(b);
  }
  paint();
  return {
    el: h('div', { class: 'pe-font-picker' }, chipRow, grid, note),
    set(id) {
      current = fontById(id).id;
      paint();
    },
    show,
    setSample(value) {
      for (const [el, label] of samples) el.textContent = value || label;
    },
    get value() {
      return current;
    },
    get category() {
      return shown;
    },
  };
}

function sortable({ label, items, keyOf, nameOf, row, onMove, className = '' }) {
  let dragFrom = -1;
  const list = h('ol', { class: ['pe-sort', className], attrs: { 'aria-label': label } });
  items.forEach((item, i) => {
    const name = nameOf(item);
    const up = h('button', { type: 'button', class: 'icon-btn pe-move', disabled: i === 0, attrs: { 'data-move': 'up', 'data-key': keyOf(item), 'aria-label': `Move ${name} up` } }, icon('chevron-up', { size: 16 }));
    const down = h('button', { type: 'button', class: 'icon-btn pe-move', disabled: i === items.length - 1, attrs: { 'data-move': 'down', 'data-key': keyOf(item), 'aria-label': `Move ${name} down` } }, icon('chevron-down', { size: 16 }));
    up.addEventListener('click', () => onMove(i, i - 1, 'up', keyOf(item)));
    down.addEventListener('click', () => onMove(i, i + 1, 'down', keyOf(item)));
    const li = h('li', { class: 'pe-sort-row', attrs: { draggable: 'true', 'data-key': keyOf(item) } },
      h('span', { class: 'pe-grip', attrs: { 'aria-hidden': 'true' } }, icon('chevrons-up-down', { size: 14 })),
      ...row(item, i),
      h('span', { class: 'pe-move-pair' }, up, down));
    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('is-dragging');
      try {
        e.dataTransfer?.setData('text/plain', keyOf(item));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      } catch {}
    });
    li.addEventListener('dragend', () => {
      dragFrom = -1;
      li.classList.remove('is-dragging');
      for (const n of list.querySelectorAll('.is-drop')) n.classList.remove('is-drop');
    });
    li.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      li.classList.add('is-drop');
    });
    li.addEventListener('dragleave', () => li.classList.remove('is-drop'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('is-drop');
      if (dragFrom < 0 || dragFrom === i) return;
      const from = dragFrom;
      dragFrom = -1;
      onMove(from, i, 'drag', keyOf(items[from]));
    });
    list.appendChild(li);
  });
  return list;
}

function field({ label, control, help = '', counter = null, id }) {
  return h('div', { class: 'pe-field' },
    h('div', { class: 'pe-field-head' }, h('label', { class: 'field-label', htmlFor: id, text: label }), counter),
    control,
    help ? h('p', { class: 'field-help', text: help }) : null);
}

function colourField({ id, label, placeholder, errorEl, errorText, onSet }) {
  const hexEl = h('input', { type: 'text', id, class: 'input input-mono pe-hex', maxLength: 24, placeholder, autocomplete: 'off', spellcheck: false });
  const apply = (raw) => {
    const hex = parseColour(raw);
    if (!hex) {
      errorEl.textContent = errorText;
      hexEl.classList.add('is-invalid');
      return;
    }
    errorEl.textContent = '';
    hexEl.classList.remove('is-invalid');
    onSet(hex);
  };
  const picker = createColourPicker({ value: placeholder, label, onInput: apply });
  hexEl.addEventListener('change', () => apply(hexEl.value));
  hexEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply(hexEl.value);
    }
  });
  return {
    row: colourRow(picker, hexEl),
    hexEl,
    picker,
    sync(hex, shown = hex) {
      if (document.activeElement !== hexEl) hexEl.value = shown || '';
      picker.set(hex || placeholder);
    },
  };
}

function heading(text, extra = null) {
  return h('div', { class: 'pe-head' }, h('h3', { class: 'pe-title', text }), extra);
}

function counterFor(input, max) {
  const el = h('span', { class: 'pe-counter', attrs: { 'aria-live': 'polite' } });
  const sync = () => {
    const n = textLength(input.value);
    el.textContent = `${n}/${max}`;
    el.classList.toggle('is-over', n > max);
  };
  input.addEventListener('input', sync);
  sync();
  return { el, sync };
}

export function openProfileEditor({ mount, profile, look, bannerImage = null, bannerMotion = null, hints = {}, api, signal = null, renderCard, onLook = null, onDone }) {
  let saved = readLook({ ...look, bannerImage }).look;
  let draft = readLook({ ...look, bannerImage }).look;
  let banner = bannerImage;
  let motion = banner ? readMotion(bannerMotion) : null;
  let bannerTouched = false;
  let busy = false;
  let closed = false;
  const owned = allBadges(profile, hints);
  const ownedKeys = new Set(owned.map((b) => b.key));
  saved.pins = saved.pins.filter((k) => ownedKeys.has(k));
  draft.pins = [...saved.pins];

  const preview = h('div', { class: 'pe-preview', attrs: { 'aria-label': 'Live preview of your profile' } });
  const errorBox = h('div', { class: 'pe-error', attrs: { role: 'alert' }, hidden: true });
  const dirtyNote = h('span', { class: 'pe-dirty muted', attrs: { 'aria-live': 'polite' } });
  const saveBtn = button({ label: 'Save changes', icon: 'check', variant: 'primary', className: 'pe-save' });
  const cancelBtn = button({ label: 'Cancel', className: 'pe-cancel' });
  const resetBtn = button({ label: 'Reset to default', icon: 'refresh', variant: 'ghost', size: 'sm', className: 'pe-reset' });
  const panels = {};
  const syncers = [];
  const pickers = [];
  const trackColour = (opts) => {
    const f = colourField(opts);
    pickers.push(f.picker);
    return f;
  };
  const closePickers = (destroy = false) => {
    for (const p of pickers) {
      if (destroy) p.destroy();
      else p.close({ focus: false });
    }
  };

  const isDirty = () => !sameLook(draft, saved);

  function refresh() {
    replace(preview, renderCard(draft, banner, motion));
    if (!closed) onLook?.(draft);
    if (draft.accent) bannerWrap.style.setProperty('--ac-base', themeColours(draft.accent).base);
    else bannerWrap.style.removeProperty('--ac-base');
    const dirty = isDirty();
    dirtyNote.textContent = dirty ? 'Unsaved changes' : 'Everything is saved';
    saveBtn.disabled = !dirty || busy;
    resetBtn.disabled = busy || sameLook(draft, defaultLook());
  }

  function update(patch, { resync = false } = {}) {
    draft = { ...draft, ...patch };
    showError('');
    if (resync) for (const s of syncers) s();
    refresh();
  }

  function showError(text) {
    errorBox.hidden = !text;
    errorBox.textContent = text || '';
  }

  function refocus(container, selector) {
    const el = container.querySelector(selector);
    if (el && !el.disabled) el.focus();
    else container.querySelector('.pe-move:not([disabled])')?.focus();
  }

  const pinCount = h('span', { class: 'pe-count' });
  const pinList = h('div', { class: 'pe-pin-wrap' });
  const pickList = h('div', { class: 'pe-pick-wrap' });
  const pickStatus = h('p', { class: 'pe-status muted', attrs: { 'aria-live': 'polite' } });
  const pickSearchId = nextId('pe-pick-q');
  const pickSearch = h('input', { type: 'search', id: pickSearchId, class: 'input pe-search', placeholder: 'Find a badge', autocomplete: 'off' });
  pickSearch.addEventListener('input', () => drawPicks());

  function drawPins() {
    pinCount.textContent = `${draft.pins.length} of ${PIN_MAX}`;
    const items = draft.pins.map((k) => owned.find((b) => b.key === k)).filter(Boolean);
    replace(pinList, items.length
      ? sortable({
        label: 'Pinned badges, in order',
        items,
        keyOf: (b) => b.key,
        nameOf: (b) => b.label,
        className: 'pe-pins',
        row: (b) => [
          h('span', { class: 'pe-art' }, badgeArt(b, 'pe-emoji', 'pe-img')),
          h('span', { class: 'pe-row-label', text: b.label }),
          h('button', { type: 'button', class: 'icon-btn pe-unpin', attrs: { 'aria-label': `Unpin ${b.label}` }, on: { click: () => togglePin(b.key) } }, icon('x', { size: 14 })),
        ],
        onMove: (from, to, how, key) => {
          update({ pins: moveItem(draft.pins, from, to - from) });
          drawPins();
          drawPicks();
          if (how !== 'drag') refocus(pinList, `.pe-move[data-key="${key}"][data-move="${how}"]`);
        },
      })
      : h('p', { class: 'pe-empty muted', text: owned.length ? 'Nothing pinned yet. Pick up to 5 badges below.' : 'You have no badges to pin yet. Play YapOS Party to earn some.' }));
  }

  function togglePin(key) {
    if (draft.pins.includes(key)) {
      update({ pins: draft.pins.filter((k) => k !== key) });
      pickStatus.textContent = 'Unpinned.';
    } else if (draft.pins.length >= PIN_MAX) {
      pickStatus.textContent = `You can pin up to ${PIN_MAX} badges. Unpin one first.`;
      return;
    } else {
      update({ pins: [...draft.pins, key] });
      pickStatus.textContent = 'Pinned.';
    }
    drawPins();
    drawPicks();
  }

  function drawPicks() {
    const q = pickSearch.value.trim().toLowerCase();
    const shown = owned.filter((b) => !q || b.label.toLowerCase().includes(q));
    const full = draft.pins.length >= PIN_MAX;
    replace(pickList, shown.length
      ? h('ul', { class: 'pe-pick' }, ...shown.map((b) => {
        const on = draft.pins.includes(b.key);
        const btn = h('button', {
          type: 'button',
          class: ['pe-pick-btn', on ? 'is-on' : '', !on && full ? 'is-full' : '', isSpecial(b) ? 'is-special' : ''],
          title: b.about ? `${b.label}: ${b.about}` : b.label,
          attrs: { 'data-key': b.key, 'aria-pressed': on ? 'true' : 'false', 'aria-disabled': !on && full ? 'true' : null },
        },
        h('span', { class: 'pe-art' }, badgeArt(b, 'pe-emoji', 'pe-img')),
        h('span', { class: 'pe-pick-label', text: b.label }),
        on ? h('span', { class: 'pe-pick-mark', attrs: { 'aria-hidden': 'true' } }, icon('check', { size: 12 })) : null);
        btn.addEventListener('click', () => {
          togglePin(b.key);
          pickList.querySelector(`.pe-pick-btn[data-key="${b.key}"]`)?.focus();
        });
        return h('li', null, btn);
      }))
      : h('p', { class: 'pe-empty muted', text: q ? `No badge matches “${pickSearch.value.trim()}”.` : 'No badges yet.' }));
  }

  panels.badges = h('div', { class: 'pe-panel' },
    heading('Pinned badges', pinCount),
    h('p', { class: 'field-help', text: 'Pinned badges sit right under your name. Drag them, or use the arrows, to change the order.' }),
    pinList,
    heading('Your badges', button({ label: 'View all', icon: 'list', size: 'sm', variant: 'ghost', className: 'pe-view-all', onClick: () => openAllBadges(profile, { pins: draft.pins, hints }) })),
    owned.length > PICK_SEARCH_AT ? h('div', { class: 'pe-field' }, h('label', { class: 'sr-only', htmlFor: pickSearchId, text: 'Find a badge' }), pickSearch) : null,
    pickList,
    pickStatus);
  syncers.push(() => {
    drawPins();
    drawPicks();
  });

  let gradMemo = draft.nameGradientCustom ? { ...draft.nameGradientCustom } : { ...CUSTOM_GRADIENT_START };
  const nameOptions = [
    { id: 'default', label: 'Default', className: 'pe-swatch is-default', body: h('span', { class: 'pe-swatch-text', text: 'Aa' }) },
    ...NAME_PALETTE.map((c) => ({ id: c.hex, label: c.label, className: 'pe-swatch', body: null, vars: { '--sw': c.hex } })),
    ...NAME_GRADIENTS.map((g) => ({ id: `g:${g.id}`, label: `${g.label} gradient`, className: `pe-swatch is-gradient swatch-grad-${g.id}`, body: null })),
    { id: 'g:custom', label: 'Custom gradient', className: 'pe-swatch is-gradient swatch-grad-custom', body: h('span', { class: 'pe-swatch-plus', text: '+', attrs: { 'aria-hidden': 'true' } }) },
  ];
  const nameValue = () => (draft.nameGradientCustom ? 'g:custom' : draft.nameGradient ? `g:${draft.nameGradient}` : draft.nameColour && NAME_PALETTE.some((c) => c.hex === draft.nameColour) ? draft.nameColour : draft.nameColour ? 'custom' : 'default');
  const nameColourId = nextId('pe-name-hex');
  const nameHexError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const contrastNote = h('p', { class: 'field-help pe-contrast-note' });
  const contrastWarn = h('p', { class: 'pe-contrast-warn', attrs: { role: 'status' }, hidden: true });
  const demoLight = h('span', { class: 'pe-demo-name' });
  const demoDark = h('span', { class: 'pe-demo-name' });
  const useGradient = (g) => {
    gradMemo = { ...g };
    update({ nameColour: null, nameGradient: null, nameGradientCustom: { ...g } });
    syncName();
  };
  const nameGroup = choiceGroup({
    label: 'Name color',
    options: nameOptions,
    value: nameValue(),
    className: 'pe-swatches',
    onPick: (id) => {
      if (id === 'default') update({ nameColour: null, nameGradient: null, nameGradientCustom: null });
      else if (id === 'g:custom') update({ nameColour: null, nameGradient: null, nameGradientCustom: { ...gradMemo } });
      else if (id.startsWith('g:')) update({ nameColour: null, nameGradient: id.slice(2), nameGradientCustom: null });
      else update({ nameColour: id, nameGradient: null, nameGradientCustom: null });
      syncName();
    },
  });
  const customSwatch = [...nameGroup.el.querySelectorAll('.pe-choice')].find((b) => b.getAttribute('data-choice') === 'g:custom') || null;
  const nameField = trackColour({
    id: nameColourId,
    label: 'Name color',
    placeholder: '#7c5cff',
    errorEl: nameHexError,
    errorText: 'Use a color like #7c5cff.',
    onSet: (hex) => {
      update({ nameColour: hex, nameGradient: null, nameGradientCustom: null });
      syncName();
    },
  });

  const gradError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const gradStop = (k, label) => {
    const id = nextId(`pe-grad-${k}`);
    const f = trackColour({
      id,
      label,
      placeholder: k === 'c' ? '#e5487f' : CUSTOM_GRADIENT_START[k],
      errorEl: gradError,
      errorText: 'Use a color like #7c5cff.',
      onSet: (hex) => useGradient({ ...gradMemo, [k]: hex }),
    });
    f.hexEl.classList.add('pe-grad-hex');
    return { k, f, el: h('div', { class: 'pe-custom pe-grad-stop', attrs: { 'data-stop': k } }, h('label', { class: 'field-label', htmlFor: id, text: label }), f.row) };
  };
  const gradA = gradStop('a', 'Start color');
  const gradB = gradStop('b', 'End color');
  const gradC = gradStop('c', 'Middle color');
  const middleId = nextId('pe-grad-mid');
  const middleSwitch = h('input', { type: 'checkbox', id: middleId, class: 'pe-grad-mid' });
  middleSwitch.addEventListener('change', () => {
    const next = { a: gradMemo.a, b: gradMemo.b, angle: gradMemo.angle };
    if (middleSwitch.checked) next.c = gradMemo.c || lastMiddle || mixHex(gradMemo.a, gradMemo.b, 0.5);
    useGradient(next);
  });
  let lastMiddle = gradMemo.c || null;
  const angleId = nextId('pe-grad-angle');
  const angleInput = h('input', { type: 'range', id: angleId, class: 'pe-angle', min: '0', max: '360', step: '1' });
  const angleOut = h('span', { class: 'pe-angle-out', attrs: { 'aria-hidden': 'true' } });
  const angleSet = (raw) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    useGradient({ ...gradMemo, angle: clamp(n, 0, 360) });
  };
  angleInput.addEventListener('input', () => angleSet(angleInput.value));
  angleInput.addEventListener('change', () => angleSet(angleInput.value));
  const angleChips = GRADIENT_ANGLES.map((a) => {
    const b = h('button', { type: 'button', class: 'pe-choice pe-chip pe-angle-chip', text: a.label, attrs: { 'data-angle': String(a.angle), 'aria-pressed': 'false' } });
    b.addEventListener('click', () => angleSet(a.angle));
    return b;
  });
  const gradBox = h('div', { class: 'pe-grad-custom' },
    h('div', { class: 'pe-grad-stops' }, gradA.el, gradB.el),
    h('label', { class: 'pe-grad-toggle', htmlFor: middleId }, middleSwitch, h('span', { text: 'Add a middle color' })),
    gradC.el,
    gradError,
    h('div', { class: 'pe-custom' },
      h('div', { class: 'pe-field-head' }, h('label', { class: 'field-label', htmlFor: angleId, text: 'Direction' }), angleOut),
      angleInput,
      h('div', { class: 'pe-angle-chips', attrs: { role: 'group', 'aria-label': 'Direction ideas' } }, ...angleChips)));

  function paintDemo(el) {
    const grad = nameGradientClass(draft);
    el.className = ['pe-demo-name', grad, draft.nameFont !== 'default' ? `name-font-${draft.nameFont}` : ''].filter(Boolean).join(' ');
    paintNameGradient(el, draft);
    el.textContent = profile.name;
  }

  function contrastText(list) {
    if (!list.length) return '';
    const where = list.length > 1 ? 'in light and dark mode' : `in ${list[0].mode} mode`;
    const on = draft.theme !== 'none' ? 'your profile theme' : 'the page';
    return `Heads up: your name may be hard to read on ${on} ${where}. You can still keep it, or try a ${list[0].mode === 'dark' ? 'lighter' : 'darker'} color.`;
  }

  function syncName() {
    nameGroup.set(nameValue());
    nameField.sync(draft.nameColour || '#7c5cff', draft.nameColour || '');
    const g = draft.nameGradientCustom || gradMemo;
    if (g.c) lastMiddle = g.c;
    gradBox.hidden = !draft.nameGradientCustom;
    gradA.f.sync(g.a);
    gradB.f.sync(g.b);
    gradC.f.sync(g.c || lastMiddle || mixHex(g.a, g.b, 0.5));
    gradC.el.hidden = !g.c;
    middleSwitch.checked = Boolean(g.c);
    if (document.activeElement !== angleInput) angleInput.value = String(g.angle);
    angleInput.setAttribute('aria-valuetext', `${g.angle} degrees`);
    angleOut.textContent = `${g.angle} degrees`;
    for (const b of angleChips) {
      const on = Number(b.getAttribute('data-angle')) === g.angle;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
    }
    const raw = rawGradientCss(g);
    if (customSwatch && raw) customSwatch.style.setProperty('--sw-grad', raw);
    paintDemo(demoLight);
    paintDemo(demoDark);
    const c = draft.nameColour && !draft.nameGradient && !draft.nameGradientCustom ? themeColours(draft.nameColour) : null;
    for (const [el, k] of [[demoLight, 'light'], [demoDark, 'dark']]) {
      if (c) el.style.setProperty('--demo', c[k]);
      else el.style.removeProperty('--demo');
      el.classList.toggle('has-demo', Boolean(c));
    }
    contrastNote.textContent = c && c.adjusted
      ? `Your color is tweaked a little where it would be hard to read${c.light !== c.base && c.dark !== c.base ? ' in both themes' : c.light !== c.base ? ' on light mode' : ' on dark mode'}, so your name always stays clear.`
      : draft.nameGradientCustom ? 'Custom gradients use a slightly lighter or darker shade where a color would be hard to read.'
      : draft.nameGradient ? 'Gradients use lighter shades in dark mode so they stay easy to read.' : 'Your name is shown like this in light and dark mode.';
    const warn = contrastText(nameContrast(draft));
    contrastWarn.textContent = warn;
    contrastWarn.hidden = !warn;
    fontGroup.set(draft.nameFont);
  }

  const fontGroup = fontPicker({
    value: draft.nameFont,
    sample: profile.name,
    onPick: (id) => {
      update({ nameFont: id });
      syncName();
    },
  });

  panels.name = h('div', { class: 'pe-panel' },
    heading('Name color'),
    nameGroup.el,
    h('div', { class: 'pe-custom' },
      h('label', { class: 'field-label', htmlFor: nameColourId, text: 'Custom color' }),
      nameField.row),
    nameHexError,
    gradBox,
    h('div', { class: 'pe-demo' },
      h('div', { class: 'pe-demo-box is-light' }, h('span', { class: 'pe-demo-cap', text: 'Light mode' }), demoLight),
      h('div', { class: 'pe-demo-box is-dark' }, h('span', { class: 'pe-demo-cap', text: 'Dark mode' }), demoDark)),
    contrastNote,
    contrastWarn,
    heading('Name style'),
    fontGroup.el,
    h('p', { class: 'field-help', text: 'Pick a group, then a font. Letters a font does not have, like emoji, use your device font.' }));
  syncers.push(syncName);

  const bannerOptions = () => BANNERS.filter((b) => b.id !== 'image' || banner).map((b) => ({
    id: b.id,
    label: b.label,
    className: ['pe-banner-swatch', `banner-${b.id}`].join(' '),
    body: b.id === 'image' ? h('img', { class: 'pe-banner-thumb', src: motion ? motion.still : banner, alt: '', attrs: { draggable: 'false' } }) : h('span', { class: 'pe-choice-text', text: b.id === 'none' ? 'None' : '' }),
  }));
  const bannerWrap = h('div', { class: 'pe-banner-wrap' });
  let bannerGroup = null;
  function drawBanners() {
    bannerGroup = choiceGroup({ label: 'Banner', options: bannerOptions(), value: draft.banner, className: 'pe-banners', onPick: (id) => update({ banner: id }) });
    replace(bannerWrap, bannerGroup.el);
  }
  const fileInput = h('input', { type: 'file', class: 'sr-only', attrs: { accept: 'image/png,image/jpeg,image/webp,image/gif', tabindex: '-1', 'aria-hidden': 'true' } });
  const uploadBtn = button({ label: 'Upload a picture', icon: 'upload', size: 'sm', className: 'pe-upload' });
  const removeBtn = button({ label: 'Remove picture', icon: 'trash', size: 'sm', variant: 'ghost', className: 'pe-remove-banner' });
  const moveBtn = button({ label: 'Reposition', icon: 'sliders', size: 'sm', variant: 'ghost', className: 'pe-move-banner', onClick: () => reposition() });
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setBusy(uploadBtn, true, 'Uploading');
    try {
      const image = await processBanner(file);
      if (!image || closed) return;
      const body = typeof image === 'string' ? { image } : { image: image.image, still: image.still, crop: image.crop };
      const data = await api.post(BANNER_API, body, { signal });
      if (closed) return;
      const url = data && data.banner && typeof data.banner.url === 'string' ? data.banner.url : null;
      if (!url) throw new Error('The banner could not be saved. Try again.');
      bannerUploaded(url, readMotion(data.banner.motion), readCrop(data.banner.crop));
      toast(typeof image === 'string' ? 'Banner picture uploaded.' : 'Moving banner uploaded.');
    } catch (err) {
      if (closed) return;
      const text = err instanceof Error ? err.message : 'That did not work. Try again.';
      showError(text);
      toast(text, { tone: 'danger', title: "Couldn't use that picture" });
    } finally {
      if (uploadBtn.isConnected) setBusy(uploadBtn, false);
    }
  });
  removeBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Remove your banner picture?', body: 'It is deleted straight away. You can upload a new one any time.', confirmLabel: 'Remove picture' });
    if (!ok || closed) return;
    setBusy(removeBtn, true, 'Removing');
    try {
      await api.request('DELETE', BANNER_API, { signal });
      if (closed) return;
      bannerRemoved();
      toast('Banner picture removed.');
    } catch (err) {
      if (closed) return;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't remove it" });
    } finally {
      if (removeBtn.isConnected) setBusy(removeBtn, false);
    }
  });

  function bannerUploaded(url, nextMotion = null, crop = null) {
    banner = url;
    motion = nextMotion;
    bannerTouched = true;
    saved = { ...saved, banner: 'image', bannerCrop: motion ? crop : null };
    draft = { ...draft, banner: 'image', bannerCrop: motion ? crop : null };
    syncBanner();
    refresh();
  }

  function bannerRemoved() {
    banner = null;
    motion = null;
    bannerTouched = true;
    saved = { ...saved, banner: saved.banner === 'image' ? 'none' : saved.banner, bannerCrop: null };
    draft = { ...draft, banner: draft.banner === 'image' ? 'none' : draft.banner, bannerCrop: null };
    syncBanner();
    refresh();
  }

  function syncBanner() {
    drawBanners();
    removeBtn.hidden = !banner;
    moveBtn.hidden = !(banner && motion);
  }

  async function reposition() {
    if (!banner || !motion) return;
    const crop = await chooseBannerCrop({ width: motion.width, height: motion.height }, { moving: banner, crop: draft.bannerCrop });
    if (!crop || closed) return;
    update({ bannerCrop: crop, banner: 'image' });
    bannerGroup?.set('image');
  }

  const accentId = nextId('pe-accent-hex');
  const accentError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const accentValue = () => (!draft.accent ? 'default' : NAME_PALETTE.some((c) => c.hex === draft.accent) ? draft.accent : 'custom');
  const accentGroup = choiceGroup({
    label: 'Accent color',
    options: [
      { id: 'default', label: 'Default', className: 'pe-swatch is-default', body: h('span', { class: 'pe-swatch-text', text: 'Aa' }) },
      ...NAME_PALETTE.map((c) => ({ id: c.hex, label: c.label, className: 'pe-swatch', body: null, vars: { '--sw': c.hex } })),
    ],
    value: accentValue(),
    className: 'pe-swatches',
    onPick: (id) => {
      update({ accent: id === 'default' ? null : id });
      syncAccent();
    },
  });
  const accentField = trackColour({
    id: accentId,
    label: 'Accent color',
    placeholder: '#f2613f',
    errorEl: accentError,
    errorText: 'Use a color like #f2613f.',
    onSet: (hex) => {
      update({ accent: hex });
      syncAccent();
    },
  });
  function syncAccent() {
    accentGroup.set(accentValue());
    accentField.sync(draft.accent || '#f2613f', draft.accent || '');
  }

  const ringGroup = choiceGroup({ label: 'Avatar ring', options: RINGS.map((r) => ({ id: r.id, label: r.label, className: `pe-chip pe-ring-${r.id}` })), value: draft.ring, onPick: (id) => update({ ring: id }) });
  const densityGroup = choiceGroup({ label: 'Card layout', options: DENSITIES.map((d) => ({ id: d.id, label: d.label, className: 'pe-chip' })), value: draft.density, onPick: (id) => update({ density: id }) });
  const featuredGroup = choiceGroup({
    label: 'Big number',
    options: FEATURED.map((f) => ({ id: f.id, label: f.label, className: 'pe-chip', disabled: f.id === 'shards' && profile.shards === null })),
    value: draft.featured,
    onPick: (id) => update({ featured: id }),
  });

  const avatarCtl = avatarControls({ api, signal, profile, look: () => draft, onChange: () => { if (!closed) refresh(); } });

  panels.card = h('div', { class: 'pe-panel' },
    heading('Profile picture'),
    avatarCtl.el,
    heading('Banner'),
    bannerWrap,
    h('div', { class: 'pe-actions-row' }, uploadBtn, moveBtn, removeBtn, fileInput),
    h('p', { class: 'field-help', text: `Best size 3000 x 1000, and at least 1500 x 500. PNG, JPG, WebP or GIF up to ${sizeText(BANNER_FILE_MAX)}. Moving GIFs and animated WebPs up to ${sizeText(ANIM_MAX_BYTES)} keep moving on your profile and Party card. After you pick a picture you can drag and zoom it to choose what shows. Uploads are saved straight away and everyone can see them, so keep it friendly.` }),
    heading('Accent color'),
    accentGroup.el,
    h('div', { class: 'pe-custom' },
      h('label', { class: 'field-label', htmlFor: accentId, text: 'Custom accent' }),
      accentField.row),
    accentError,
    h('p', { class: 'field-help', text: 'Colors the level ring, icons and highlights on your card. It is tweaked where needed so it stays readable.' }),
    heading('Avatar ring'),
    ringGroup.el,
    heading('Card layout'),
    densityGroup.el,
    heading('Big number'),
    featuredGroup.el,
    h('p', { class: 'field-help', text: profile.shards === null ? 'The number shown largest on your card. Shards can only be picked when you show them on your profile.' : 'The number shown largest on your card.' }));
  syncers.push(() => {
    syncBanner();
    syncAccent();
    ringGroup.set(draft.ring);
    densityGroup.set(draft.density);
    featuredGroup.set(draft.featured);
  });

  const themeGroup = choiceGroup({
    label: 'Profile theme',
    options: [
      { id: 'none', label: 'No theme', className: 'pe-theme is-none', body: themeTile(null, 'None') },
      ...THEMES.map((t) => ({ id: t.id, label: `${t.label} theme`, className: 'pe-theme', body: themeTile(t, t.label) })),
      { id: 'custom', label: 'Custom theme', className: 'pe-theme is-custom', body: themeTile(null, 'Custom') },
    ],
    value: draft.theme,
    className: 'pe-themes',
    onPick: (id) => {
      if (id === 'custom') update({ theme: 'custom', themeCustom: draft.themeCustom || customStart() });
      else if (id === 'none') update({ theme: 'none', themeCustom: null, themeMode: 'auto', themePattern: 'glow' });
      else {
        const t = themeById(id);
        update({ theme: id, themeCustom: null, themeMode: t.mode, themePattern: t.pattern });
      }
      syncTheme();
    },
  });
  function customStart() {
    const t = themeById(draft.theme);
    if (t) return { base: t.base, alt: t.alt, accent: t.accent };
    return { ...CUSTOM_THEME_START, accent: draft.accent || CUSTOM_THEME_START.accent };
  }
  const themeError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const customFields = ['base', 'alt', 'accent'].map((k) => {
    const id = nextId(`pe-theme-${k}`);
    const label = { base: 'Main color', alt: 'Second color', accent: 'Highlight' }[k];
    const f = trackColour({
      id,
      label: `Theme ${label.toLowerCase()}`,
      placeholder: CUSTOM_THEME_START[k],
      errorEl: themeError,
      errorText: 'Use a color like #7c5cff.',
      onSet: (hex) => {
        update({ theme: 'custom', themeCustom: { ...(draft.themeCustom || customStart()), [k]: hex } });
        syncTheme();
      },
    });
    const el = h('div', { class: 'pe-custom pe-theme-colour' }, h('label', { class: 'field-label', htmlFor: id, text: label }), f.row);
    return { k, el, f, hexEl: f.hexEl };
  });
  const customBox = h('div', { class: 'pe-theme-custom' }, ...customFields.map((f) => f.el));
  const modeGroup = choiceGroup({ label: 'Light or dark', options: THEME_MODES.map((m) => ({ id: m.id, label: m.label, className: 'pe-chip' })), value: draft.themeMode, onPick: (id) => update({ themeMode: id }) });
  const patternGroup = choiceGroup({
    label: 'Background pattern',
    options: THEME_PATTERNS.map((p) => ({ id: p.id, label: p.label, className: `pe-chip pe-pattern pat-${p.id}`, body: h('span', { class: 'pe-choice-text', text: p.label }) })),
    value: draft.themePattern,
    onPick: (id) => update({ themePattern: id }),
  });
  const themeOptions = h('div', { class: 'pe-theme-options' },
    heading('Light or dark'),
    modeGroup.el,
    h('p', { class: 'field-help', text: 'Match follows each visitor’s light or dark mode. Always dark or always light keeps your theme the same for everyone.' }),
    heading('Background pattern'),
    patternGroup.el);
  const effectGroup = choiceGroup({
    label: 'Profile effect',
    options: EFFECTS.map((e) => ({ id: e.id, label: e.label, className: ['pe-effect', `fx-${e.id}`].join(' '), body: effectTile(e) })),
    value: draft.effect,
    className: 'pe-effects',
    onPick: (id) => update({ effect: id }),
  });
  function syncTheme() {
    themeGroup.set(draft.theme);
    customBox.hidden = draft.theme !== 'custom';
    themeOptions.hidden = draft.theme === 'none';
    for (const f of customFields) {
      const v = draft.themeCustom ? draft.themeCustom[f.k] : CUSTOM_THEME_START[f.k];
      f.f.sync(v, draft.themeCustom ? v : '');
    }
    modeGroup.set(draft.themeMode);
    patternGroup.set(draft.themePattern);
    effectGroup.set(draft.effect);
  }
  panels.theme = h('div', { class: 'pe-panel' },
    heading('Profile theme'),
    h('p', { class: 'field-help', text: 'Colors your whole profile page: the background, cards, buttons and badges. Text is tuned so it always stays easy to read.' }),
    themeGroup.el,
    customBox,
    themeError,
    themeOptions,
    heading('Profile effect'),
    h('p', { class: 'field-help', text: 'Effects drift over your whole profile page. Visitors can switch them off, and they stay still for people who prefer less motion.' }),
    effectGroup.el);
  syncers.push(syncTheme);

  const emojiId = nextId('pe-emoji');
  const statusId = nextId('pe-status');
  const pronounsId = nextId('pe-pronouns');
  const bioId = nextId('pe-bio');
  const emojiInput = h('input', { type: 'text', id: emojiId, class: 'input pe-emoji-input', maxLength: STATUS_EMOJI_MAX * 2, placeholder: '\u{1F3AE}', autocomplete: 'off', spellcheck: false });
  const emojiError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const statusInput = h('input', { type: 'text', id: statusId, class: 'input', maxLength: STATUS_MAX, placeholder: 'What are you up to?', autocomplete: 'off' });
  const pronounsInput = h('input', { type: 'text', id: pronounsId, class: 'input', maxLength: PRONOUNS_MAX, placeholder: 'they/them', autocomplete: 'off' });
  const bioInput = h('textarea', { id: bioId, class: 'input textarea pe-bio', rows: 4, maxLength: BIO_MAX, placeholder: 'Say hi, share your favorite game, or what you are into.' });
  const statusCount = counterFor(statusInput, STATUS_MAX);
  const pronounsCount = counterFor(pronounsInput, PRONOUNS_MAX);
  const bioCount = counterFor(bioInput, BIO_MAX);
  emojiInput.addEventListener('input', () => {
    const e = cleanStatusEmoji(emojiInput.value);
    if (e === null) {
      emojiError.textContent = 'Use one emoji, like \u{1F3AE}.';
      return;
    }
    emojiError.textContent = '';
    update({ statusEmoji: e });
  });
  statusInput.addEventListener('input', () => update({ status: statusInput.value }));
  pronounsInput.addEventListener('input', () => update({ pronouns: pronounsInput.value }));
  bioInput.addEventListener('input', () => update({ bio: bioInput.value }));
  const ideas = h('div', { class: 'pe-ideas' }, ...PRONOUN_IDEAS.map((p) => h('button', { type: 'button', class: 'pe-idea', text: p, on: { click: () => { pronounsInput.value = p; pronounsCount.sync(); update({ pronouns: p }); } } })));

  panels.about = h('div', { class: 'pe-panel' },
    heading('Status'),
    h('div', { class: 'pe-status-row' },
      h('div', { class: 'pe-field pe-emoji-field' }, h('label', { class: 'field-label', htmlFor: emojiId, text: 'Emoji' }), emojiInput),
      field({ label: 'Status text', id: statusId, control: statusInput, counter: statusCount.el })),
    emojiError,
    field({ label: 'Pronouns', id: pronounsId, control: pronounsInput, counter: pronounsCount.el }),
    ideas,
    field({ label: 'About me', id: bioId, control: bioInput, counter: bioCount.el, help: 'Up to 4 short lines. Everyone can see this, and words blocked on YapOS are not allowed.' }));
  syncers.push(() => {
    if (document.activeElement !== emojiInput) emojiInput.value = draft.statusEmoji;
    if (document.activeElement !== statusInput) statusInput.value = draft.status;
    if (document.activeElement !== pronounsInput) pronounsInput.value = draft.pronouns;
    if (document.activeElement !== bioInput) bioInput.value = draft.bio;
    statusCount.sync();
    pronounsCount.sync();
    bioCount.sync();
  });

  const layoutList = h('div', { class: 'pe-layout-wrap' });
  function drawLayout() {
    const items = draft.order.map((id) => SECTIONS.find((s) => s.id === id)).filter(Boolean);
    replace(layoutList, sortable({
      label: 'Profile sections, in order',
      items,
      keyOf: (s) => s.id,
      nameOf: (s) => s.label,
      className: 'pe-sections',
      row: (s) => {
        const on = !draft.hidden.includes(s.id);
        const sw = switchControl({
          checked: on,
          label: `Show ${s.label}`,
          onChange: (next) => {
            const hidden = next ? draft.hidden.filter((x) => x !== s.id) : [...draft.hidden, s.id];
            update({ hidden: SECTIONS.map((x) => x.id).filter((x) => hidden.includes(x)) });
            row.classList.toggle('is-off', !next);
          },
        });
        const row = h('span', { class: ['pe-section-name', on ? '' : 'is-off'] }, icon(s.icon, { size: 14 }), h('span', { text: s.label }));
        return [row, h('span', { class: 'pe-section-switch' }, sw.el)];
      },
      onMove: (from, to, how, key) => {
        update({ order: moveItem(draft.order, from, to - from) });
        drawLayout();
        if (how !== 'drag') refocus(layoutList, `.pe-move[data-key="${key}"][data-move="${how}"]`);
      },
    }));
  }
  panels.layout = h('div', { class: 'pe-panel' },
    heading('Sections'),
    h('p', { class: 'field-help', text: 'Drag sections, or use the arrows, to change the order. Switch one off to hide it. Sections with nothing in them stay hidden anyway.' }),
    layoutList);
  syncers.push(drawLayout);

  const panelBox = h('div', { class: 'pe-body' });
  const tabs = tabBar({ items: TABS, value: 'badges', label: 'Profile settings', idPrefix: 'pe-tab', onChange: (id) => showTab(id) });
  function showTab(id) {
    closePickers();
    replace(panelBox, panels[id]);
    panels[id].setAttribute('role', 'tabpanel');
    panels[id].setAttribute('aria-labelledby', `pe-tab-${id}`);
  }

  async function save() {
    if (busy || !isDirty()) return;
    busy = true;
    setBusy(saveBtn, true, 'Saving');
    showError('');
    try {
      const data = await api.post(LOOK_API, lookBody(draft), { signal });
      if (closed) return;
      const next = readLook({ ...(data && data.look ? data.look : draft), bannerImage: data?.look?.bannerImage ?? banner, bannerMotion: data?.look ? data.look.bannerMotion : motion });
      saved = next.look;
      draft = { ...next.look };
      busy = false;
      finish({ look: saved, bannerImage: next.bannerImage, bannerMotion: next.bannerMotion });
      toast('Your profile is saved.');
    } catch (err) {
      if (closed) return;
      busy = false;
      const text = err instanceof ApiError ? err.message : 'That did not work. Try again.';
      showError(text);
      toast(text, { tone: 'danger', title: "Couldn't save your profile" });
      const fields = err instanceof ApiError && Array.isArray(err.data?.fields) ? err.data.fields : [];
      if (fields.length) {
        tabs.set('about');
        ({ bio: bioInput, pronouns: pronounsInput, status: statusInput })[fields[0]]?.focus();
      }
    } finally {
      if (saveBtn.isConnected) setBusy(saveBtn, false);
      refresh();
    }
  }

  function finish(result) {
    if (closed) return;
    closed = true;
    closePickers(true);
    onDone?.(result);
  }

  async function cancel() {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Discard your changes?', body: 'Your profile goes back to how it was when you last saved.', confirmLabel: 'Discard changes' });
      if (!ok) return;
    }
    finish(bannerTouched ? { look: saved, bannerImage: banner, bannerMotion: motion } : null);
  }

  function reset() {
    draft = defaultLook();
    for (const s of syncers) s();
    refresh();
    toast('Back to the default look. Save to keep it.');
  }

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', cancel);
  resetBtn.addEventListener('click', reset);

  const jump = (el) => () => el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const previewCol = h('div', { class: 'pe-preview-col' });
  const panel = h('aside', { class: 'pe-side', attrs: { 'aria-labelledby': 'pe-heading' } },
    h('div', { class: 'pe-side-head' },
      h('div', { class: 'pe-side-top' },
        h('h2', { class: 'pe-heading', id: 'pe-heading', text: 'Customize your profile' }),
        button({ label: 'Preview', icon: 'eye', size: 'sm', variant: 'ghost', className: 'pe-jump', onClick: jump(previewCol) })),
      h('p', { class: 'muted pe-sub', text: `Changes show in the preview straight away. ${formatNumber(owned.length)} ${owned.length === 1 ? 'badge' : 'badges'} to choose from.` })),
    errorBox,
    tabs.el,
    panelBox,
    h('div', { class: 'pe-bar' }, resetBtn, h('span', { class: 'pe-bar-gap' }), dirtyNote, cancelBtn, saveBtn));

  previewCol.append(
    h('div', { class: 'pe-preview-top' },
      h('p', { class: 'pe-preview-label' }, icon('eye', { size: 14 }), h('span', { text: 'Live preview' })),
      button({ label: 'Back to settings', icon: 'chevron-up', size: 'sm', variant: 'ghost', className: 'pe-jump', onClick: jump(panel) })),
    preview);
  const layout = h('div', { class: 'pe-layout' }, previewCol, panel);
  for (const s of syncers) s();
  showTab('badges');
  refresh();
  replace(mount, layout);
  signal?.addEventListener?.('abort', () => {
    closed = true;
    closePickers(true);
  });
  return {
    el: layout,
    isDirty: () => !closed && isDirty(),
    get draft() { return draft; },
    save,
    cancel,
    reset,
    showTab: (id) => tabs.set(id),
    destroy: () => closePickers(true),
  };
}
