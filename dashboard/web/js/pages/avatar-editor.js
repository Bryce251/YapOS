import { focusFirst, h, nextId, replace, trapFocus } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, button, confirmDialog, setBusy, switchControl, toast } from '../ui.js';
import { CUT_MIN_SIDE, CUT_STRENGTH_MAX, CUT_STRENGTH_MIN, CUT_STRENGTH_START, backdropColours, encodeCutout, fitSide, runCutOut, verdictText } from '../avatar-cutout.js';
import { noteBackdrop, cleanColours } from '../avatar-backdrop.js';
import { ApiError } from '../api.js';
import { AnimError, animatedFrames, webpAnimated } from '../banner-anim.js';
import {
  AVATAR_API, AVATAR_FILE_MAX, AVATAR_SIDE, AVATAR_MIN_SIDE, AVATAR_STILL_MAX, AVATAR_ANIM_MAX, AVATAR_STILL_SIDE,
  centreSquare, readAvatarAnim,
} from '../avatar-rules.js';
import { dataUrlBytes, loadPicture, sniffFile } from './owner-badges.js';

export const AV_STAGE = 480;
export const AV_PREVIEW_BIG = 96;
export const AV_PREVIEW_SMALL = 32;
export const AV_MAX_ZOOM = 8;
export const AV_ZOOM_STEP = 1.1;
export const AV_PAN_STEP = 0.05;
export const AV_QUALITIES = Object.freeze([0.92, 0.85, 0.76, 0.66, 0.56]);

const num = (v, d = 0) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sizeOf = (src) => [Math.max(1, Math.floor(num(src.naturalWidth || src.width, 1))), Math.max(1, Math.floor(num(src.naturalHeight || src.height, 1)))];

export function avatarMaxZoom(width, height) {
  return clamp(Math.min(width, height) / AVATAR_MIN_SIDE, 1, AV_MAX_ZOOM);
}

export function avatarStartView(width, height) {
  return { zoom: 1, cx: width / 2, cy: height / 2 };
}

export function avatarClampView(width, height, view) {
  const zoom = clamp(num(view && view.zoom, 1), 1, avatarMaxZoom(width, height));
  const half = Math.min(width, height) / zoom / 2;
  return { zoom, cx: clamp(num(view && view.cx, width / 2), half, width - half), cy: clamp(num(view && view.cy, height / 2), half, height - half) };
}

export function avatarRect(width, height, view) {
  const v = avatarClampView(width, height, view);
  const side = Math.min(width, height) / v.zoom;
  return { sx: v.cx - side / 2, sy: v.cy - side / 2, sw: side, sh: side };
}

export function avatarPan(width, height, view, dx, dy, frame) {
  const r = avatarRect(width, height, view);
  const scale = r.sw / Math.max(1e-6, num(frame, 1));
  return avatarClampView(width, height, { ...view, cx: view.cx - dx * scale, cy: view.cy - dy * scale });
}

export function avatarZoom(width, height, view, factor, ax = 0.5, ay = 0.5) {
  const r = avatarRect(width, height, view);
  const px = r.sx + ax * r.sw;
  const py = r.sy + ay * r.sh;
  const zoom = clamp(view.zoom * factor, 1, avatarMaxZoom(width, height));
  const side = Math.min(width, height) / zoom;
  return avatarClampView(width, height, { zoom, cx: px - (ax - 0.5) * side, cy: py - (ay - 0.5) * side });
}

export function avatarOutSide(rect) {
  return clamp(Math.round(rect.sw), AVATAR_MIN_SIDE, AVATAR_SIDE);
}

function canvasOf(doc, side) {
  const canvas = doc.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) throw new Error("Your browser can't resize pictures here. Try another browser.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

export function encodeAvatar(src, rect, { doc = document, max = AVATAR_STILL_MAX, side = null } = {}) {
  const sides = [...new Set([side || avatarOutSide(rect), 384, 256, 128].filter((s) => s <= (side || avatarOutSide(rect)) && s >= AVATAR_MIN_SIDE))];
  const missing = new Set();
  for (const s of sides) {
    const { canvas, ctx } = canvasOf(doc, s);
    ctx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, s, s);
    for (const type of ['image/webp', 'image/png', 'image/jpeg']) {
      if (missing.has(type)) continue;
      for (const q of type === 'image/png' ? [1] : AV_QUALITIES) {
        const url = canvas.toDataURL(type, q);
        if (!url.startsWith(`data:${type}`)) {
          missing.add(type);
          break;
        }
        if (dataUrlBytes(url) <= max) return url;
      }
    }
  }
  throw new Error('That picture is too detailed to use. Try a simpler one.');
}

export function chooseAvatarCrop(src, { doc = document, moving = null } = {}) {
  const [width, height] = sizeOf(src);
  return new Promise((resolve) => {
    let view = avatarStartView(width, height);
    let done = false;
    const pointers = new Map();
    let gesture = null;
    const titleId = nextId('av-crop');
    const helpId = nextId('av-crop-help');
    const previous = doc.activeElement;
    const top = moving ? 1 : avatarMaxZoom(width, height);
    const stageBody = moving
      ? h('img', { class: 'av-crop-moving', src: moving, alt: '', attrs: { draggable: 'false', 'aria-hidden': 'true' } })
      : h('canvas', { class: 'av-crop-canvas', attrs: { width: String(AV_STAGE), height: String(AV_STAGE), 'aria-hidden': 'true' } });
    const stage = h('div', {
      class: ['av-crop-stage', moving ? 'is-moving' : ''],
      attrs: { tabindex: '0', role: 'group', 'aria-label': moving ? 'Your moving picture, centred' : 'Your picture. Drag to move it.', 'aria-describedby': helpId },
    }, stageBody, h('div', { class: 'av-crop-ring', attrs: { 'aria-hidden': 'true' } }));
    const previewOf = (size, label) => {
      const face = moving
        ? h('img', { class: 'av-crop-prev-img', src: moving, alt: '', attrs: { draggable: 'false' } })
        : h('canvas', { class: 'av-crop-prev-img', attrs: { width: String(size), height: String(size), 'aria-hidden': 'true' } });
      const fig = h('figure', { class: ['av-crop-prev', `is-${size === AV_PREVIEW_BIG ? 'big' : 'small'}`] }, h('span', { class: 'av-crop-prev-circle' }, face), h('figcaption', { class: 'av-crop-prev-label', text: label }));
      return { fig, ctx: !moving && typeof face.getContext === 'function' ? face.getContext('2d') : null, size };
    };
    const big = previewOf(AV_PREVIEW_BIG, 'On your profile');
    const small = previewOf(AV_PREVIEW_SMALL, 'In lists');
    const stageCtx = !moving && typeof stageBody.getContext === 'function' ? stageBody.getContext('2d') : null;
    const range = h('input', { type: 'range', class: 'range av-crop-range', attrs: { min: '1', max: String(top), step: '0.01', 'aria-label': 'Zoom' } });
    const zoomOut = h('button', { type: 'button', class: 'icon-btn av-crop-out', attrs: { 'aria-label': 'Zoom out' } }, icon('minus', { size: 16 }));
    const zoomIn = h('button', { type: 'button', class: 'icon-btn av-crop-in', attrs: { 'aria-label': 'Zoom in' } }, icon('plus', { size: 16 }));
    const paint = () => {
      const r = avatarRect(width, height, view);
      if (stageCtx) {
        stageCtx.clearRect(0, 0, AV_STAGE, AV_STAGE);
        stageCtx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, AV_STAGE, AV_STAGE);
      }
      for (const p of [big, small]) if (p.ctx) {
        p.ctx.clearRect(0, 0, p.size, p.size);
        p.ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, p.size, p.size);
      }
    };
    const sync = () => {
      paint();
      const z = Math.round(view.zoom * 100) / 100;
      range.value = String(z);
      range.setAttribute('aria-valuetext', `${Math.round(z * 100)}%`);
      zoomOut.disabled = moving || z <= 1;
      zoomIn.disabled = moving || z >= top;
      range.disabled = Boolean(moving);
    };
    const set = (next) => {
      if (moving) return;
      view = avatarClampView(width, height, next);
      sync();
    };
    const frameSize = () => Math.max(1, stage.getBoundingClientRect().width || AV_STAGE);
    stage.addEventListener('pointerdown', (e) => {
      if (moving || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      if (doc.activeElement !== stage) stage.focus();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {}
      gesture = { view, pts: [...pointers.values()].map((p) => ({ ...p })) };
      stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!gesture || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = [...pointers.values()];
      const { pts } = gesture;
      if (now.length === 1 || pts.length === 1) {
        set(avatarPan(width, height, gesture.view, now[0].x - pts[0].x, now[0].y - pts[0].y, frameSize()));
        return;
      }
      const d0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const d1 = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y) || 1;
      set(avatarZoom(width, height, gesture.view, d1 / d0));
    });
    const lift = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      gesture = pointers.size ? { view, pts: [...pointers.values()].map((p) => ({ ...p })) } : null;
      stage.classList.toggle('is-dragging', pointers.size > 0);
    };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    stage.addEventListener('wheel', (e) => {
      if (moving) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      set(avatarZoom(width, height, view, Math.exp(-clamp(num(e.deltaY) * unit, -240, 240) * 0.002)));
    }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      if (moving) return;
      const step = AV_PAN_STEP * (e.shiftKey ? 4 : 1);
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      let next = null;
      if (moves[e.key]) next = avatarPan(width, height, view, moves[e.key][0], moves[e.key][1], 1);
      else if (e.key === '+' || e.key === '=') next = avatarZoom(width, height, view, AV_ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') next = avatarZoom(width, height, view, 1 / AV_ZOOM_STEP);
      else if (e.key === '0') next = avatarStartView(width, height);
      if (!next) return;
      e.preventDefault();
      set(next);
    });
    range.addEventListener('input', () => set({ ...view, zoom: Number(range.value) }));
    zoomOut.addEventListener('click', () => set(avatarZoom(width, height, view, 1 / AV_ZOOM_STEP)));
    zoomIn.addEventListener('click', () => set(avatarZoom(width, height, view, AV_ZOOM_STEP)));
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
    const reset = button({ label: 'Reset', icon: 'refresh', variant: 'ghost', className: 'av-crop-reset', onClick: () => set(avatarStartView(width, height)) });
    reset.hidden = Boolean(moving);
    const cancel = button({ label: 'Cancel', className: 'av-crop-cancel', onClick: () => finish(null) });
    const ok = button({ label: 'Use this picture', icon: 'check', variant: 'primary', className: 'av-crop-ok', onClick: () => finish(avatarRect(width, height, view)) });
    const help = moving
      ? 'Moving pictures are centred and cut to a circle. Your GIF keeps moving on your profile, the header and your Party card. Lists and people who prefer less motion see its first frame.'
      : 'Drag the picture to move it, and zoom with the slider, your mouse wheel or a pinch. On a keyboard, the arrow keys move it and + and - zoom.';
    const panel = h('div', { class: ['dialog-panel', 'av-crop-panel'], attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { class: 'dialog-title', id: titleId, text: moving ? 'Your moving picture' : 'Position your picture' }),
      h('p', { class: 'dialog-body', id: helpId, text: help }),
      stage,
      moving ? null : h('div', { class: 'av-crop-zoom' }, zoomOut, range, zoomIn),
      h('div', { class: 'av-crop-previews' }, big.fig, small.fig),
      h('div', { class: 'dialog-actions' }, reset, cancel, ok));
    const root = h('div', { class: ['dialog-root', 'av-crop'] }, h('div', { class: 'dialog-overlay', on: { click: () => finish(null) } }), panel);
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(root);
    doc.body.classList.add('has-modal');
    sync();
    focusFirst(panel);
    stage.focus();
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error("That file couldn't be read. Pick it again."));
    r.readAsDataURL(file);
  });
}

export function mbText(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1)} MB`;
}

export async function processMovingAvatar(file, bytes, { choose = chooseAvatarCrop, readUrl = readDataUrl, doc = document } = {}) {
  if (bytes.length > AVATAR_ANIM_MAX) throw new Error(`Moving profile pictures must be under ${Math.round(AVATAR_ANIM_MAX / 1024)} KB, and this one is ${mbText(bytes.length)}. Try a shorter or smaller GIF.`);
  let info;
  try {
    info = readAvatarAnim(bytes);
  } catch (err) {
    throw new Error(err instanceof AnimError ? err.message : "That GIF couldn't be read. Pick it again.");
  }
  const url = await readUrl(file);
  const src = await loadPicture(file);
  try {
    if (choose && !(await choose(src, { doc, moving: url }))) return null;
    const rect = centreSquare(info.width, info.height);
    return { image: url, still: encodeAvatar(src, rect, { doc, side: Math.min(AVATAR_STILL_SIDE, Math.max(AVATAR_MIN_SIDE, rect.sw)) }), frames: info.frames, width: info.width, height: info.height };
  } finally {
    if (typeof src.close === 'function') src.close();
  }
}

export async function processAvatar(file, { choose = chooseAvatarCrop, readUrl = readDataUrl, doc = document } = {}) {
  if (!file) throw new Error('Pick a picture first.');
  if (Number(file.size) > AVATAR_FILE_MAX) throw new Error(`That file is bigger than ${Math.round(AVATAR_FILE_MAX / 1024 / 1024)} MB. Pick a smaller picture.`);
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = sniffFile(head, file.type, file.name);
  if (kind === 'svg') throw new Error("SVG files can't be used for profile pictures. Save it as a PNG first.");
  if (!['png', 'jpeg', 'webp', 'gif'].includes(kind)) throw new Error("That file isn't a picture YapOS can use. Use a PNG, JPG, WebP or GIF.");
  if (kind === 'gif' || (kind === 'webp' && webpAnimated(head))) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frames = animatedFrames(bytes);
    if (frames > 1 || (kind === 'webp' && frames !== 1)) return processMovingAvatar(file, bytes, { choose, readUrl, doc });
    if (frames < 0 && kind === 'gif') throw new Error("That GIF couldn't be read. It may be damaged. Try saving it again.");
  }
  const src = await loadPicture(file);
  try {
    const [w, ht] = sizeOf(src);
    if (Math.min(w, ht) < 16) throw new Error('That picture is too small. Use one at least 64 pixels on each side.');
    const rect = choose ? await choose(src, { doc }) : avatarRect(w, ht, avatarStartView(w, ht));
    if (!rect) return null;
    return { image: encodeAvatar(src, rect, { doc }) };
  } finally {
    if (typeof src.close === 'function') src.close();
  }
}

export const CUT_DEBOUNCE_MS = 120;

export function cutPixels(src, { doc = document } = {}) {
  const [width, height] = sizeOf(src);
  const rect = centreSquare(width, height);
  const side = fitSide(width, height);
  if (side < CUT_MIN_SIDE) throw new Error(`That picture is too small. Use one at least ${CUT_MIN_SIDE} pixels on each side.`);
  const { canvas, ctx } = canvasOf(doc, side);
  ctx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, side, side);
  return { canvas, side, pixels: ctx.getImageData(0, 0, side, side).data };
}

export function removedText(removed) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(removed) || 0)) * 100);
  return `About ${pct}% of the picture is now see-through.`;
}

export function chooseCutout(src, { doc = document, colours = null, run = runCutOut, start = CUT_STRENGTH_START, makeImageData = null } = {}) {
  const { canvas: before, side, pixels } = cutPixels(src, { doc });
  return new Promise((resolve) => {
    let done = false;
    let seq = 0;
    let timer = null;
    let strength = start;
    let shown = start;
    let result = null;
    const history = [];
    const titleId = nextId('av-cut');
    const helpId = nextId('av-cut-help');
    const previous = doc.activeElement;
    const after = h('canvas', { attrs: { width: String(side), height: String(side), 'aria-hidden': 'true' } });
    const afterCtx = typeof after.getContext === 'function' ? after.getContext('2d') : null;
    before.setAttribute('aria-hidden', 'true');
    const faceOf = (small) => {
      const c = h('canvas', { attrs: { width: String(small ? 64 : 144), height: String(small ? 64 : 144), 'aria-hidden': 'true' } });
      const box = h('span', { class: ['av-cut-face', small ? 'is-small' : ''] }, c);
      const paint = cleanColours(colours);
      if (paint) {
        box.style.setProperty('--av-bd-1', paint.stops[0]);
        box.style.setProperty('--av-bd-2', paint.stops[1]);
        box.style.setProperty('--av-bd-3', paint.stops[2]);
      }
      return { box, c, ctx: typeof c.getContext === 'function' ? c.getContext('2d') : null };
    };
    const faces = [faceOf(false), faceOf(true)];
    const range = h('input', { type: 'range', class: 'range av-cut-range', attrs: { min: String(CUT_STRENGTH_MIN), max: String(CUT_STRENGTH_MAX), step: '1', 'aria-label': 'Strength' } });
    range.value = String(start);
    const out = h('output', { class: 'av-cut-out', text: String(start) });
    const note = h('p', { class: 'field-help av-cut-note', attrs: { 'aria-live': 'polite' } });
    const undo = button({ label: 'Undo', icon: 'rewind', variant: 'ghost', size: 'sm', className: 'av-cut-undo' });
    const cancel = button({ label: 'Cancel', className: 'av-cut-cancel', onClick: () => finish(null) });
    const ok = button({ label: 'Use this', icon: 'check', variant: 'primary', className: 'av-cut-ok', onClick: () => result && finish({ canvas: after, strength: shown, removed: result.removed, verdict: result.verdict }) });
    ok.disabled = true;
    undo.disabled = true;
    const view = (label, canvas, checker) => h('figure', { class: 'av-cut-view' }, h('div', { class: ['av-cut-box', checker ? 'av-checker' : ''] }, canvas), h('figcaption', { class: 'av-cut-cap', text: label }));
    const paintAfter = (res) => {
      if (!afterCtx) return;
      const data = makeImageData ? makeImageData(res.rgba, side, side) : new ImageData(res.rgba, side, side);
      afterCtx.clearRect(0, 0, side, side);
      afterCtx.putImageData(data, 0, 0);
      for (const f of faces) if (f.ctx) {
        f.ctx.clearRect(0, 0, f.c.width, f.c.height);
        f.ctx.drawImage(after, 0, 0, f.c.width, f.c.height);
      }
    };
    const compute = async () => {
      const token = ++seq;
      const want = strength;
      ok.disabled = true;
      note.classList.remove('is-warn');
      note.textContent = 'Removing the background...';
      try {
        const res = await run(pixels, side, side, { strength: want, feather: 1 });
        if (done || token !== seq) return;
        result = res;
        shown = want;
        paintAfter(res);
        const warn = verdictText(res.verdict);
        note.classList.toggle('is-warn', Boolean(warn));
        note.textContent = warn || removedText(res.removed);
        ok.disabled = res.verdict === 'everything';
      } catch (err) {
        if (done || token !== seq) return;
        note.classList.add('is-warn');
        note.textContent = err instanceof Error && err.message ? err.message : 'That did not work. Try again.';
      }
    };
    const setStrength = (value, { remember = true } = {}) => {
      const next = Math.round(Math.min(CUT_STRENGTH_MAX, Math.max(CUT_STRENGTH_MIN, Number(value))));
      if (!Number.isFinite(next) || next === strength) return;
      if (remember) history.push(strength);
      strength = next;
      range.value = String(next);
      out.textContent = String(next);
      undo.disabled = !history.length;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        compute();
      }, CUT_DEBOUNCE_MS);
    };
    range.addEventListener('input', () => setStrength(range.value));
    undo.addEventListener('click', () => {
      if (!history.length) return;
      setStrength(history.pop(), { remember: false });
      undo.disabled = !history.length;
    });
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else trapFocus(panel, e);
    }
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      doc.removeEventListener('keydown', onKey, true);
      root.remove();
      if (![...doc.querySelectorAll('.drawer-root')].some((r) => !r.classList.contains('is-closing'))) doc.body.classList.remove('has-modal');
      if (previous && previous.focus && previous.isConnected) previous.focus();
      resolve(value);
    };
    const panel = h('div', { class: ['dialog-panel', 'av-cut-panel'], attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': helpId } },
      h('h2', { class: 'dialog-title', id: titleId, text: 'Remove background' }),
      h('p', { class: 'dialog-body', id: helpId, text: 'YapOS looks at the colours around the edge of your picture and makes them see-through. Your profile colours then show behind you. Raise the strength if some background stays, lower it if parts of you vanish.' }),
      h('div', { class: 'av-cut-views' }, view('Before', before, false), view('After', after, true)),
      h('div', { class: 'av-cut-strength' }, h('span', { class: 'field-label', text: 'Strength' }), range, out),
      note,
      h('div', { class: 'av-cut-faces', attrs: { 'aria-hidden': 'true' } }, faces[0].box, faces[1].box),
      h('div', { class: 'dialog-actions' }, undo, cancel, ok));
    const root = h('div', { class: ['dialog-root', 'av-cut'] }, h('div', { class: 'dialog-overlay', on: { click: () => finish(null) } }), panel);
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(root);
    doc.body.classList.add('has-modal');
    focusFirst(panel);
    range.focus?.();
    compute();
  });
}

export function cutSourcePlan(state) {
  const s = state || {};
  if (s.cutout && s.cutout.source === 'upload') return { url: `${AVATAR_API}/original`, source: 'upload' };
  if (s.cutout && s.cutout.source === 'yapin') return { url: `${AVATAR_API}/yapin`, source: 'yapin' };
  if (s.custom && s.custom.animated) return null;
  if (s.custom) return { url: s.custom.url, source: 'upload' };
  if (s.yapin) return { url: `${AVATAR_API}/yapin`, source: 'yapin' };
  return null;
}

export function cutBlocked(state) {
  const s = state || {};
  if (!s.canUpload) return 'Your public profile is not set up yet, so the background cannot be removed.';
  if (s.custom && s.custom.animated) return 'Moving pictures keep their background. They get a ring in your profile colours instead.';
  if (!cutSourcePlan(s)) return 'Upload a picture first, then remove its background.';
  return '';
}

async function fetchPicture(url, { fetchImpl, signal }) {
  let res;
  try {
    res = await fetchImpl(url, { credentials: 'same-origin', signal, headers: { Accept: 'image/*' } });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error("Your picture couldn't be loaded. Check your connection and try again.");
  }
  if (!res || !res.ok) {
    let message = "Your picture couldn't be loaded. Try again in a moment.";
    try {
      const data = await res.json();
      if (data && typeof data.message === 'string' && data.message) message = data.message;
      else if (data && data.error && typeof data.error.message === 'string') message = data.error.message;
    } catch {}
    throw new Error(message);
  }
  return res.blob();
}

export function readAvatarState(data) {
  const d = data && typeof data === 'object' ? data : {};
  const c = d.custom && typeof d.custom === 'object' && typeof d.custom.url === 'string' ? d.custom : null;
  const cut = c && !c.animated && d.cutout && typeof d.cutout === 'object' && ['upload', 'yapin'].includes(d.cutout.source) ? d.cutout : null;
  return {
    custom: c ? { url: c.url, still: typeof c.still === 'string' ? c.still : null, animated: c.animated === true } : null,
    cutout: cut ? { source: cut.source, backdrop: cut.backdrop === 'clear' ? 'clear' : 'theme', canRestore: cut.canRestore !== false } : null,
    yapin: typeof d.yapin === 'string' ? d.yapin : null,
    avatar: typeof d.avatar === 'string' ? d.avatar : null,
    avatarStill: typeof d.avatarStill === 'string' ? d.avatarStill : null,
    canUpload: d.canUpload !== false,
    private: d.private === true,
  };
}

export function avatarControls({ api, signal = null, profile, onChange = null, process = processAvatar, look = null, cutout = chooseCutout, fetchImpl = null, load = loadPicture }) {
  let state = { custom: null, cutout: null, yapin: null, avatar: profile.avatar || null, avatarStill: profile.avatarStill || null, canUpload: true, private: false };
  let closed = false;
  let cutBusy = false;
  const getFetch = () => fetchImpl || ((...a) => fetch(...a));
  const colours = () => backdropColours(typeof look === 'function' ? look() : null);
  const cutNote = h('p', { class: 'field-help av-cut-state', attrs: { 'aria-live': 'polite' } });
  const cutId = nextId('av-cut-switch');
  const cutSwitch = switchControl({ id: cutId, label: 'Remove background', onChange: (on) => (on ? startCut() : stopCut()) });
  const adjustBtn = button({ label: 'Adjust', icon: 'sliders', size: 'sm', variant: 'ghost', className: 'av-cut-adjust', onClick: () => startCut() });
  const bdId = nextId('av-bd-switch');
  const bdSwitch = switchControl({ id: bdId, label: 'Show my profile colours behind it', onChange: (on) => setBackdrop(on) });
  const bdRow = h('div', { class: 'av-cut-row' }, bdSwitch.el, h('label', { class: 'field-label', htmlFor: bdId, text: 'Show my profile colours behind it' }));
  const cutRow = h('div', { class: 'av-cut-row' }, cutSwitch.el, h('label', { class: 'field-label', htmlFor: cutId, text: 'Remove background' }), adjustBtn);

  function markBackdrop() {
    const url = state.avatar;
    if (!url) return;
    const moving = Boolean(state.custom && state.custom.animated);
    const cut = Boolean(state.cutout);
    noteBackdrop(url, { cut, moving, clear: cut && state.cutout.backdrop === 'clear', ...colours() });
  }

  function syncCut() {
    const blocked = cutBlocked(state);
    const on = Boolean(state.cutout);
    cutSwitch.set(on);
    cutSwitch.setDisabled(cutBusy || (!on && Boolean(blocked)));
    cutSwitch.setBusy(cutBusy);
    adjustBtn.hidden = !on;
    adjustBtn.disabled = cutBusy;
    bdRow.hidden = !on;
    bdSwitch.set(on && state.cutout.backdrop !== 'clear');
    bdSwitch.setDisabled(cutBusy);
    cutNote.textContent = on
      ? state.cutout.backdrop === 'clear'
        ? 'Your background is removed and nothing is drawn behind you.'
        : 'Your background is removed and your profile colours show behind you. They follow your theme.'
      : blocked || 'Removes a plain background and puts your profile colours behind you.';
  }

  async function startCut() {
    if (cutBusy || closed) return;
    const plan = cutSourcePlan(state);
    if (!plan || (cutBlocked(state) && !state.cutout)) {
      syncCut();
      return;
    }
    cutBusy = true;
    syncCut();
    let src = null;
    try {
      const blob = await fetchPicture(plan.url, { fetchImpl: getFetch(), signal });
      if (closed) return;
      src = await load(blob);
      if (closed) return;
      const picked = await cutout(src, { colours: colours() });
      if (!picked || closed) return;
      const image = encodeCutout(picked.canvas, { max: AVATAR_STILL_MAX });
      const backdrop = state.cutout ? state.cutout.backdrop : 'theme';
      const data = await api.post(AVATAR_API, { image, cutout: true, source: plan.source, backdrop }, { signal });
      if (closed) return;
      apply(data);
      toast('Background removed.');
    } catch (err) {
      if (closed || (err && err.name === 'AbortError')) return;
      toast(err instanceof Error && err.message ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't remove the background" });
    } finally {
      if (src && typeof src.close === 'function') src.close();
      cutBusy = false;
      if (!closed) syncCut();
    }
  }

  async function stopCut() {
    if (cutBusy || closed || !state.cutout) {
      syncCut();
      return;
    }
    const fromYapin = state.cutout.source === 'yapin';
    const ok = await confirmDialog({
      title: 'Put the background back?',
      body: fromYapin ? 'Your cut-out picture is deleted and your Yapin picture shows again.' : 'Your picture goes back to how you uploaded it.',
      confirmLabel: 'Put it back',
      tone: 'primary',
    });
    if (!ok || closed) {
      syncCut();
      return;
    }
    cutBusy = true;
    syncCut();
    try {
      const data = await api.patch(AVATAR_API, { cutout: false }, { signal });
      if (closed) return;
      apply(data);
      toast('Background is back.');
    } catch (err) {
      if (closed) return;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't put the background back" });
    } finally {
      cutBusy = false;
      if (!closed) syncCut();
    }
  }

  async function setBackdrop(on) {
    if (cutBusy || closed || !state.cutout) return;
    cutBusy = true;
    syncCut();
    try {
      const data = await api.patch(AVATAR_API, { backdrop: on ? 'theme' : 'clear' }, { signal });
      if (closed) return;
      apply(data);
    } catch (err) {
      if (closed) return;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't change the backdrop" });
    } finally {
      cutBusy = false;
      if (!closed) syncCut();
    }
  }
  const face = h('div', { class: 'av-ctl-face' });
  const note = h('p', { class: 'field-help av-ctl-note', attrs: { 'aria-live': 'polite' } });
  const fileInput = h('input', { type: 'file', class: 'sr-only', attrs: { accept: 'image/png,image/jpeg,image/webp,image/gif', tabindex: '-1', 'aria-hidden': 'true' } });
  const uploadBtn = button({ label: 'Upload picture', icon: 'upload', size: 'sm', className: 'av-upload' });
  const yapinBtn = button({ label: 'Use my Yapin picture', icon: 'refresh', size: 'sm', variant: 'ghost', className: 'av-use-yapin' });
  signal?.addEventListener?.('abort', () => { closed = true; });

  function draw() {
    replace(face, avatar({ name: profile.name, url: state.avatar || '', still: state.avatarStill || '', id: profile.id || profile.username, healName: profile.id ? '' : profile.username || '', size: 'xl' }));
    yapinBtn.hidden = !state.custom;
    uploadBtn.disabled = !state.canUpload;
    note.textContent = !state.canUpload
      ? 'Your public profile is not set up yet. Use the YapOS bot in a server first.'
      : state.custom && state.private
        ? 'Your profile is private, so your uploaded picture only shows once your profile is public again.'
      : state.custom
        ? state.custom.animated ? 'You are using an uploaded moving picture.' : 'You are using an uploaded picture.'
        : 'You are using your Yapin picture.';
    syncCut();
  }

  function apply(data) {
    state = readAvatarState(data);
    profile.avatar = state.avatar;
    profile.avatarStill = state.avatarStill;
    markBackdrop();
    draw();
    onChange?.(state);
  }

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setBusy(uploadBtn, true, 'Uploading');
    try {
      const pic = await process(file);
      if (!pic || closed) return;
      const data = await api.post(AVATAR_API, pic.still ? { image: pic.image, still: pic.still } : { image: pic.image }, { signal });
      if (closed) return;
      apply(data);
      toast(pic.still ? 'Moving profile picture uploaded.' : 'Profile picture uploaded.');
    } catch (err) {
      if (closed) return;
      const text = err instanceof Error ? err.message : 'That did not work. Try again.';
      toast(text, { tone: 'danger', title: "Couldn't use that picture" });
    } finally {
      if (uploadBtn.isConnected) setBusy(uploadBtn, false);
    }
  });
  yapinBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Go back to your Yapin picture?', body: 'Your uploaded picture is deleted straight away. You can upload another one any time.', confirmLabel: 'Use my Yapin picture' });
    if (!ok || closed) return;
    setBusy(yapinBtn, true, 'Switching');
    try {
      const data = await api.request('DELETE', AVATAR_API, { signal });
      if (closed) return;
      apply(data);
      toast('Back to your Yapin picture.');
    } catch (err) {
      if (closed) return;
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', { tone: 'danger', title: "Couldn't switch back" });
    } finally {
      if (yapinBtn.isConnected) setBusy(yapinBtn, false);
    }
  });

  draw();
  Promise.resolve()
    .then(() => api.get(AVATAR_API, { signal }))
    .then((data) => {
      if (closed || !data) return;
      state = readAvatarState(data);
      markBackdrop();
      draw();
    })
    .catch(() => {});

  const el = h('div', { class: 'av-ctl' },
    face,
    h('div', { class: 'av-ctl-side' },
      h('div', { class: 'pe-actions-row' }, uploadBtn, yapinBtn, fileInput),
      note,
      cutRow,
      bdRow,
      cutNote,
      h('p', { class: 'field-help', text: `PNG, JPG, WebP or GIF up to ${Math.round(AVATAR_FILE_MAX / 1024 / 1024)} MB. You can drag and zoom to pick the part that shows. Moving GIFs and animated WebPs up to ${Math.round(AVATAR_ANIM_MAX / 1024)} KB keep moving. Uploads are saved straight away and everyone can see them, so keep it friendly.` })));
  return { el, get state() { return state; }, refresh: draw };
}
