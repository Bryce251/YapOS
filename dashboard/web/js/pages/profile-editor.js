import { focusFirst, h, nextId, replace, trapFocus } from '../dom.js';
import { icon } from '../icons.js';
import { badgeArt, button, confirmDialog, setBusy, switchControl, toast } from '../ui.js';
import { tabBar } from '../kit.js';
import { ApiError } from '../api.js';
import { formatNumber } from '../format.js';
import {
  BANNERS, BIO_MAX, DENSITIES, FEATURED, NAME_FONTS, NAME_GRADIENTS, NAME_PALETTE, PIN_MAX, PRONOUNS_MAX, RINGS, SECTIONS, STATUS_EMOJI_MAX, STATUS_MAX,
  cleanStatusEmoji, defaultLook, lookBody, moveItem, normalHex, readLook, sameLook, textLength, themeColours,
} from '../profile-look.js';
import { allBadges, isSpecial, openAllBadges } from './profile.js';
import { dataUrlBytes, loadPicture, sniffFile } from './owner-badges.js';

export const LOOK_API = '/api/me/profile-look';
export const BANNER_API = '/api/me/profile-banner';
export const BANNER_W = 1500;
export const BANNER_H = 500;
export const BANNER_BYTES = 400 * 1024;
export const CROP_PREVIEW_W = 750;
export const CROP_PREVIEW_H = 250;
export const CROP_STEP = 0.05;
export const BANNER_FILE_MAX = 15 * 1024 * 1024;
export const PRONOUN_IDEAS = Object.freeze(['she/her', 'he/him', 'they/them', 'any pronouns']);
export const PICK_SEARCH_AT = 12;

const TABS = Object.freeze([
  Object.freeze({ id: 'badges', label: 'Badges', icon: 'star' }),
  Object.freeze({ id: 'name', label: 'Name', icon: 'palette' }),
  Object.freeze({ id: 'card', label: 'Card', icon: 'sparkles' }),
  Object.freeze({ id: 'about', label: 'About', icon: 'user' }),
  Object.freeze({ id: 'layout', label: 'Layout', icon: 'list' }),
]);

const unit = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
};

export function cleanFocus(focus) {
  return { x: unit(focus && focus.x), y: unit(focus && focus.y) };
}

export function bannerCrop(width, height, { focus = null, ratio = BANNER_W / BANNER_H } = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const ht = Math.max(1, Math.floor(Number(height) || 1));
  const f = cleanFocus(focus);
  if (w / ht > ratio) {
    const sw = Math.min(w, Math.round(ht * ratio));
    return { sx: Math.floor((w - sw) * f.x), sy: 0, sw, sh: ht };
  }
  const sh = Math.min(ht, Math.round(w / ratio));
  return { sx: 0, sy: Math.floor((ht - sh) * f.y), sw: w, sh };
}

export function cropAxis(width, height, ratio = BANNER_W / BANNER_H) {
  const r = bannerCrop(width, height, { ratio });
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const ht = Math.max(1, Math.floor(Number(height) || 1));
  if (w - r.sw >= Math.max(4, w * 0.01)) return 'x';
  if (ht - r.sh >= Math.max(4, ht * 0.01)) return 'y';
  return null;
}

export function moveFocus(focus, axis, delta) {
  const f = cleanFocus(focus);
  if (axis === 'x') f.x = unit(f.x + delta);
  if (axis === 'y') f.y = unit(f.y + delta);
  return f;
}

export function dragDelta(axis, dx, dy, frameWidth, width, height) {
  const r = bannerCrop(width, height);
  const scale = r.sw / Math.max(1, Number(frameWidth) || 1);
  if (axis === 'x') return -((Number(dx) || 0) * scale) / Math.max(1, Math.floor(Number(width) || 1) - r.sw);
  if (axis === 'y') return -((Number(dy) || 0) * scale) / Math.max(1, Math.floor(Number(height) || 1) - r.sh);
  return 0;
}

export function focusText(focus, axis) {
  const v = Math.round((axis === 'x' ? focus.x : focus.y) * 100);
  if (v === 50) return 'Centred';
  if (axis === 'x') return v < 50 ? `${50 - v}% toward the left` : `${v - 50}% toward the right`;
  return v < 50 ? `${50 - v}% toward the top` : `${v - 50}% toward the bottom`;
}

export function chooseBannerCrop(src, { doc = document } = {}) {
  const width = src.naturalWidth || src.width;
  const height = src.naturalHeight || src.height;
  const axis = cropAxis(width, height);
  if (!axis) return Promise.resolve(cleanFocus(null));
  return new Promise((resolve) => {
    let focus = cleanFocus(null);
    let done = false;
    let drag = null;
    const titleId = nextId('crop');
    const helpId = nextId('crop-help');
    const previous = doc.activeElement;
    const canvas = h('canvas', { class: 'pe-crop-canvas', attrs: { width: String(CROP_PREVIEW_W), height: String(CROP_PREVIEW_H), 'aria-hidden': 'true' } });
    const frame = h('div', {
      class: ['pe-crop-frame', `is-${axis}`],
      attrs: { tabindex: '0', role: 'slider', 'aria-label': axis === 'x' ? 'Banner position, left to right' : 'Banner position, top to bottom', 'aria-describedby': helpId, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-orientation': axis === 'x' ? 'horizontal' : 'vertical' },
    }, canvas);
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    const paint = () => {
      frame.setAttribute('aria-valuenow', String(Math.round((axis === 'x' ? focus.x : focus.y) * 100)));
      frame.setAttribute('aria-valuetext', focusText(focus, axis));
      if (!ctx) return;
      const r = bannerCrop(width, height, { focus });
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, CROP_PREVIEW_W, CROP_PREVIEW_H);
    };
    const set = (next) => {
      focus = cleanFocus(next);
      paint();
    };
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
    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, from: focus, w: frame.getBoundingClientRect().width };
      frame.classList.add('is-dragging');
      try {
        frame.setPointerCapture(e.pointerId);
      } catch {}
    });
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      set(moveFocus(drag.from, axis, dragDelta(axis, e.clientX - drag.x, e.clientY - drag.y, drag.w, width, height)));
    });
    const endDrag = () => {
      drag = null;
      frame.classList.remove('is-dragging');
    };
    frame.addEventListener('pointerup', endDrag);
    frame.addEventListener('pointercancel', endDrag);
    frame.addEventListener('keydown', (e) => {
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      let next = null;
      if (e.key === back) next = moveFocus(focus, axis, -CROP_STEP);
      else if (e.key === fwd) next = moveFocus(focus, axis, CROP_STEP);
      else if (e.key === 'Home') next = moveFocus(focus, axis, -1);
      else if (e.key === 'End') next = moveFocus(focus, axis, 1);
      if (!next) return;
      e.preventDefault();
      set(next);
    });
    const cancel = button({ label: 'Cancel', className: 'pe-crop-cancel', onClick: () => finish(null) });
    const centre = button({ label: 'Centre', icon: 'refresh', variant: 'ghost', className: 'pe-crop-centre', onClick: () => set(null) });
    const ok = button({ label: 'Use this banner', icon: 'check', variant: 'primary', className: 'pe-crop-ok', onClick: () => finish(focus) });
    const panel = h('div', { class: ['dialog-panel', 'pe-crop-panel'], attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { class: 'dialog-title', id: titleId, text: 'Choose what your banner shows' }),
      h('p', { class: 'dialog-body', id: helpId, text: `Banners are 1500 by 500. Your picture is ${axis === 'x' ? 'wider' : 'taller'} than that, so drag it, or use the arrow keys, to pick which part shows.` }),
      frame,
      h('div', { class: 'dialog-actions' }, centre, cancel, ok));
    const root = h('div', { class: ['dialog-root', 'pe-crop'] }, h('div', { class: 'dialog-overlay', on: { click: () => finish(null) } }), panel);
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(root);
    doc.body.classList.add('has-modal');
    paint();
    focusFirst(panel);
    frame.focus();
  });
}

export function encodeBanner(src, { doc = document, max = BANNER_BYTES, focus = null } = {}) {
  const canvas = doc.createElement('canvas');
  canvas.width = BANNER_W;
  canvas.height = BANNER_H;
  const c = canvas.getContext('2d');
  if (!c) throw new Error("Your browser can't resize pictures here. Try another browser.");
  const r = bannerCrop(src.naturalWidth || src.width, src.naturalHeight || src.height, { focus });
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, BANNER_W, BANNER_H);
  for (const [type, qualities] of [['image/webp', [0.9, 0.8, 0.7, 0.6, 0.5]], ['image/jpeg', [0.85, 0.72, 0.6, 0.5]]]) {
    for (const q of qualities) {
      const url = canvas.toDataURL(type, q);
      if (!url.startsWith(`data:${type}`)) break;
      if (dataUrlBytes(url) <= max) return url;
    }
  }
  throw new Error('That picture is too detailed to use as a banner. Try a simpler one.');
}

export async function processBanner(file, { choose = chooseBannerCrop } = {}) {
  if (!file) throw new Error('Pick a picture first.');
  if (Number(file.size) > BANNER_FILE_MAX) throw new Error('That file is bigger than 15 MB. Pick a smaller picture.');
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = sniffFile(head, file.type, file.name);
  if (kind === 'svg') throw new Error("SVG files can't be used for banners. Save it as a PNG first.");
  if (!['png', 'jpeg', 'webp', 'gif'].includes(kind)) throw new Error("That file isn't a picture YapOS can use. Use a PNG, JPG, WebP or GIF.");
  const src = await loadPicture(file);
  try {
    const focus = choose ? await choose(src) : null;
    if (choose && !focus) return null;
    return encodeBanner(src, { focus });
  } finally {
    if (typeof src.close === 'function') src.close();
  }
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

export function openProfileEditor({ mount, profile, look, bannerImage = null, hints = {}, api, signal = null, renderCard, onDone }) {
  let saved = readLook({ ...look, bannerImage }).look;
  let draft = readLook({ ...look, bannerImage }).look;
  let banner = bannerImage;
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

  const isDirty = () => !sameLook(draft, saved);

  function refresh() {
    replace(preview, renderCard(draft, banner));
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

  const nameOptions = [
    { id: 'default', label: 'Default', className: 'pe-swatch is-default', body: h('span', { class: 'pe-swatch-text', text: 'Aa' }) },
    ...NAME_PALETTE.map((c) => ({ id: c.hex, label: c.label, className: 'pe-swatch', body: null, vars: { '--sw': c.hex } })),
    ...NAME_GRADIENTS.map((g) => ({ id: `g:${g.id}`, label: `${g.label} gradient`, className: `pe-swatch is-gradient swatch-grad-${g.id}`, body: null })),
  ];
  const nameValue = () => (draft.nameGradient ? `g:${draft.nameGradient}` : draft.nameColour && NAME_PALETTE.some((c) => c.hex === draft.nameColour) ? draft.nameColour : draft.nameColour ? 'custom' : 'default');
  const nameColourId = nextId('pe-name-hex');
  const namePicker = h('input', { type: 'color', class: 'pe-colour', attrs: { 'aria-label': 'Pick any name colour' } });
  const nameHex = h('input', { type: 'text', id: nameColourId, class: 'input input-mono pe-hex', maxLength: 7, placeholder: '#7c5cff', autocomplete: 'off', spellcheck: false });
  const nameHexError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const contrastNote = h('p', { class: 'field-help pe-contrast-note' });
  const demoLight = h('span', { class: 'pe-demo-name' });
  const demoDark = h('span', { class: 'pe-demo-name' });
  const nameGroup = choiceGroup({
    label: 'Name colour',
    options: nameOptions,
    value: nameValue(),
    className: 'pe-swatches',
    onPick: (id) => {
      if (id === 'default') update({ nameColour: null, nameGradient: null });
      else if (id.startsWith('g:')) update({ nameColour: null, nameGradient: id.slice(2) });
      else update({ nameColour: id, nameGradient: null });
      syncName();
    },
  });
  const setCustomName = (raw) => {
    const hex = normalHex(raw);
    if (!hex) {
      nameHexError.textContent = 'Use a colour like #7c5cff.';
      nameHex.classList.add('is-invalid');
      return;
    }
    nameHexError.textContent = '';
    nameHex.classList.remove('is-invalid');
    update({ nameColour: hex, nameGradient: null });
    syncName();
  };
  namePicker.addEventListener('input', () => setCustomName(namePicker.value));
  nameHex.addEventListener('change', () => setCustomName(nameHex.value));
  nameHex.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setCustomName(nameHex.value);
    }
  });

  function paintDemo(el) {
    el.className = ['pe-demo-name', draft.nameGradient ? `name-grad-${draft.nameGradient}` : '', draft.nameFont !== 'default' ? `name-font-${draft.nameFont}` : ''].filter(Boolean).join(' ');
    el.textContent = profile.name;
  }

  function syncName() {
    nameGroup.set(nameValue());
    if (document.activeElement !== nameHex) nameHex.value = draft.nameColour || '';
    namePicker.value = draft.nameColour || '#7c5cff';
    paintDemo(demoLight);
    paintDemo(demoDark);
    const c = draft.nameColour && !draft.nameGradient ? themeColours(draft.nameColour) : null;
    for (const [el, k] of [[demoLight, 'light'], [demoDark, 'dark']]) {
      if (c) el.style.setProperty('--demo', c[k]);
      else el.style.removeProperty('--demo');
      el.classList.toggle('has-demo', Boolean(c));
    }
    contrastNote.textContent = c && c.adjusted
      ? `Your colour is tweaked a little where it would be hard to read${c.light !== c.base && c.dark !== c.base ? ' in both themes' : c.light !== c.base ? ' on light mode' : ' on dark mode'}, so your name always stays clear.`
      : draft.nameGradient ? 'Gradients use lighter shades in dark mode so they stay easy to read.' : 'Your name is shown like this in light and dark mode.';
    fontGroup.set(draft.nameFont);
  }

  const fontGroup = choiceGroup({
    label: 'Name style',
    options: NAME_FONTS.map((f) => ({ id: f.id, label: f.label, className: 'pe-font', body: h('span', { class: ['pe-font-sample', f.id !== 'default' ? `name-font-${f.id}` : ''], text: f.label }) })),
    value: draft.nameFont,
    onPick: (id) => {
      update({ nameFont: id });
      syncName();
    },
  });

  panels.name = h('div', { class: 'pe-panel' },
    heading('Name colour'),
    nameGroup.el,
    h('div', { class: 'pe-custom' },
      h('label', { class: 'field-label', htmlFor: nameColourId, text: 'Custom colour' }),
      h('div', { class: 'pe-custom-row' }, namePicker, nameHex)),
    nameHexError,
    h('div', { class: 'pe-demo' },
      h('div', { class: 'pe-demo-box is-light' }, h('span', { class: 'pe-demo-cap', text: 'Light mode' }), demoLight),
      h('div', { class: 'pe-demo-box is-dark' }, h('span', { class: 'pe-demo-cap', text: 'Dark mode' }), demoDark)),
    contrastNote,
    heading('Name style'),
    fontGroup.el,
    h('p', { class: 'field-help', text: 'Styles use fonts already on your device, so they look a little different on each one.' }));
  syncers.push(syncName);

  const bannerOptions = () => BANNERS.filter((b) => b.id !== 'image' || banner).map((b) => ({
    id: b.id,
    label: b.label,
    className: ['pe-banner-swatch', `banner-${b.id}`].join(' '),
    body: b.id === 'image' ? h('img', { class: 'pe-banner-thumb', src: banner, alt: '', attrs: { draggable: 'false' } }) : h('span', { class: 'pe-choice-text', text: b.id === 'none' ? 'None' : '' }),
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
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setBusy(uploadBtn, true, 'Uploading');
    try {
      const image = await processBanner(file);
      if (!image || closed) return;
      const data = await api.post(BANNER_API, { image }, { signal });
      if (closed) return;
      const url = data && data.banner && typeof data.banner.url === 'string' ? data.banner.url : null;
      if (!url) throw new Error('The banner could not be saved. Try again.');
      bannerUploaded(url);
      toast('Banner picture uploaded.');
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

  function bannerUploaded(url) {
    banner = url;
    bannerTouched = true;
    saved = { ...saved, banner: 'image' };
    draft = { ...draft, banner: 'image' };
    syncBanner();
    refresh();
  }

  function bannerRemoved() {
    banner = null;
    bannerTouched = true;
    if (saved.banner === 'image') saved = { ...saved, banner: 'none' };
    if (draft.banner === 'image') draft = { ...draft, banner: 'none' };
    syncBanner();
    refresh();
  }

  function syncBanner() {
    drawBanners();
    removeBtn.hidden = !banner;
  }

  const accentId = nextId('pe-accent-hex');
  const accentPicker = h('input', { type: 'color', class: 'pe-colour', attrs: { 'aria-label': 'Pick any accent colour' } });
  const accentHex = h('input', { type: 'text', id: accentId, class: 'input input-mono pe-hex', maxLength: 7, placeholder: '#f2613f', autocomplete: 'off', spellcheck: false });
  const accentError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const accentValue = () => (!draft.accent ? 'default' : NAME_PALETTE.some((c) => c.hex === draft.accent) ? draft.accent : 'custom');
  const accentGroup = choiceGroup({
    label: 'Accent colour',
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
  const setCustomAccent = (raw) => {
    const hex = normalHex(raw);
    if (!hex) {
      accentError.textContent = 'Use a colour like #f2613f.';
      accentHex.classList.add('is-invalid');
      return;
    }
    accentError.textContent = '';
    accentHex.classList.remove('is-invalid');
    update({ accent: hex });
    syncAccent();
  };
  accentPicker.addEventListener('input', () => setCustomAccent(accentPicker.value));
  accentHex.addEventListener('change', () => setCustomAccent(accentHex.value));
  function syncAccent() {
    accentGroup.set(accentValue());
    if (document.activeElement !== accentHex) accentHex.value = draft.accent || '';
    accentPicker.value = draft.accent || '#f2613f';
  }

  const ringGroup = choiceGroup({ label: 'Avatar ring', options: RINGS.map((r) => ({ id: r.id, label: r.label, className: `pe-chip pe-ring-${r.id}` })), value: draft.ring, onPick: (id) => update({ ring: id }) });
  const densityGroup = choiceGroup({ label: 'Card layout', options: DENSITIES.map((d) => ({ id: d.id, label: d.label, className: 'pe-chip' })), value: draft.density, onPick: (id) => update({ density: id }) });
  const featuredGroup = choiceGroup({
    label: 'Big number',
    options: FEATURED.map((f) => ({ id: f.id, label: f.label, className: 'pe-chip', disabled: f.id === 'shards' && profile.shards === null })),
    value: draft.featured,
    onPick: (id) => update({ featured: id }),
  });

  panels.card = h('div', { class: 'pe-panel' },
    heading('Banner'),
    bannerWrap,
    h('div', { class: 'pe-actions-row' }, uploadBtn, removeBtn, fileInput),
    h('p', { class: 'field-help', text: 'Best size 1500 x 500. PNG, JPG, WebP or GIF. Other sizes are cropped to fit, and you can drag to choose which part shows. Uploads are saved straight away and everyone can see them, so keep it friendly.' }),
    heading('Accent colour'),
    accentGroup.el,
    h('div', { class: 'pe-custom' },
      h('label', { class: 'field-label', htmlFor: accentId, text: 'Custom accent' }),
      h('div', { class: 'pe-custom-row' }, accentPicker, accentHex)),
    accentError,
    h('p', { class: 'field-help', text: 'Colours the level ring, icons and highlights on your card. It is tweaked where needed so it stays readable.' }),
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

  const emojiId = nextId('pe-emoji');
  const statusId = nextId('pe-status');
  const pronounsId = nextId('pe-pronouns');
  const bioId = nextId('pe-bio');
  const emojiInput = h('input', { type: 'text', id: emojiId, class: 'input pe-emoji-input', maxLength: STATUS_EMOJI_MAX * 2, placeholder: '\u{1F3AE}', autocomplete: 'off', spellcheck: false });
  const emojiError = h('p', { class: 'field-error', attrs: { 'aria-live': 'polite' } });
  const statusInput = h('input', { type: 'text', id: statusId, class: 'input', maxLength: STATUS_MAX, placeholder: 'What are you up to?', autocomplete: 'off' });
  const pronounsInput = h('input', { type: 'text', id: pronounsId, class: 'input', maxLength: PRONOUNS_MAX, placeholder: 'they/them', autocomplete: 'off' });
  const bioInput = h('textarea', { id: bioId, class: 'input textarea pe-bio', rows: 4, maxLength: BIO_MAX, placeholder: 'Say hi, share your favourite game, or what you are into.' });
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
      const next = readLook({ ...(data && data.look ? data.look : draft), bannerImage: data?.look?.bannerImage ?? banner });
      saved = next.look;
      draft = { ...next.look };
      busy = false;
      finish({ look: saved, bannerImage: next.bannerImage });
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
    onDone?.(result);
  }

  async function cancel() {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Discard your changes?', body: 'Your profile goes back to how it was when you last saved.', confirmLabel: 'Discard changes' });
      if (!ok) return;
    }
    finish(bannerTouched ? { look: saved, bannerImage: banner } : null);
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
  });
  return {
    el: layout,
    isDirty: () => !closed && isDirty(),
    get draft() { return draft; },
    save,
    cancel,
    reset,
    showTab: (id) => tabs.set(id),
  };
}
