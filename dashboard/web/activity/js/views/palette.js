import { COLORS, COLOR_NAMES, ERASER, CUSTOM, hexOf, tintOf, rgbaOf } from '../games/ink.js';
import { h, button } from '../ui/dom.js';

export const RECENT_KEY = 'yapos.party.colors';
export const RECENT_MAX = 6;
export const SV_STEP = 0.02;
export const SV_JUMP = 0.1;
export const HUE_STEP = 2;
export const HUE_JUMP = 15;

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function wrapHue(v) {
  const n = Number(v) || 0;
  return ((n % 360) + 360) % 360;
}

export function hsvToRgb(hue, sat, val) {
  const hh = wrapHue(hue) / 60;
  const s = clamp01(sat);
  const v = clamp01(val);
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const seg = Math.floor(hh) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsv(r, g, b) {
  const rr = clamp01(r / 255);
  const gg = clamp01(g / 255);
  const bb = clamp01(b / 255);
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === rr) hue = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) hue = 60 * ((bb - rr) / d + 2);
    else hue = 60 * ((rr - gg) / d + 4);
  }
  return [wrapHue(hue), max === 0 ? 0 : d / max, max];
}

export function rgbHex(rgb) {
  return `#${rgb.slice(0, 3).map((v) => Math.min(255, Math.max(0, Math.round(Number(v) || 0))).toString(16).padStart(2, '0')).join('')}`;
}

export function defaultStore() {
  try {
    return typeof window !== 'undefined' && window ? window.localStorage || null : null;
  } catch {
    return null;
  }
}

export function readRecent(store) {
  try {
    const raw = store ? store.getItem(RECENT_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const v of list) {
      const t = tintOf(v);
      if (t && t.c === CUSTOM && !out.includes(t.rgb)) out.push(t.rgb);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function saveRecent(store, list) {
  try {
    if (store) store.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    return true;
  } catch {
    return false;
  }
}

export function pushRecent(list, hex) {
  const t = tintOf(hex);
  if (!t || t.c !== CUSTOM) return list.slice(0, RECENT_MAX);
  return [t.rgb].concat(list.filter((x) => x !== t.rgb)).slice(0, RECENT_MAX);
}

export function pixelAt(ctx, x, y) {
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const cx = Math.floor(Number(x));
  const cy = Math.floor(Number(y));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0) return null;
  const w = ctx.canvas && ctx.canvas.width;
  const ht = ctx.canvas && ctx.canvas.height;
  if ((w && cx >= w) || (ht && cy >= ht)) return null;
  try {
    const img = ctx.getImageData(cx, cy, 1, 1);
    const d = img && img.data;
    if (!d || d.length < 4) return null;
    if (d[3] === 0) return COLORS[ERASER];
    return rgbHex([d[0], d[1], d[2]]);
  } catch {
    return null;
  }
}

export function canvasPixel(canvas, e) {
  const r = canvas && typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  if (!r || !r.width || !r.height) return null;
  const w = Number(canvas.width) || 0;
  const ht = Number(canvas.height) || 0;
  if (!w || !ht) return null;
  const x = Math.floor(((e.clientX - r.left) / r.width) * w);
  const y = Math.floor(((e.clientY - r.top) / r.height) * ht);
  return [Math.min(w - 1, Math.max(0, x)), Math.min(ht - 1, Math.max(0, y))];
}

export function dropTool(on, toggle) {
  return h(
    'button',
    {
      class: ['size', 'tool-drop', on ? 'is-on' : null],
      type: 'button',
      dataset: { key: 'tool-drop' },
      attrs: { 'aria-label': 'Eyedropper', 'aria-pressed': on ? 'true' : 'false', title: 'Eyedropper: tap the drawing to pick up a color' },
      on: { click: () => toggle() },
    },
    h('span', { class: 'tool-drop-icon', text: '💧', attrs: { 'aria-hidden': 'true' } }),
  );
}

function ratio(el, e) {
  const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (!r || !r.width || !r.height) return null;
  return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
}

function dragOn(el, move) {
  let id = null;
  const stop = (e) => {
    if (id === null) return;
    if (e && e.pointerId !== undefined && id !== -1 && e.pointerId !== id) return;
    const was = id;
    id = null;
    if (was !== -1 && typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(was);
      } catch {
        return;
      }
    }
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    id = e.pointerId === undefined ? -1 : e.pointerId;
    if (id !== -1 && typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(id);
      } catch {
        id = -1;
      }
    }
    if (typeof el.focus === 'function') el.focus();
    move(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (id === null) return;
    if (e.pointerId !== undefined && id !== -1 && e.pointerId !== id) return;
    e.preventDefault();
    move(e);
  });
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
}

export function createPalette({ pen, onPick, store = defaultStore() }) {
  const hsv = { h: 0, s: 1, v: 1 };
  let recent = readRecent(store);
  let opened = false;
  const swatches = COLORS.map((col, i) =>
    h('button', {
      class: ['swatch', i === ERASER ? 'is-eraser' : null, i === pen.c ? 'is-on' : null],
      type: 'button',
      dataset: { key: i === ERASER ? 'eraser' : `color-${i}` },
      vars: { '--sw': col },
      attrs: { 'aria-label': COLOR_NAMES[i], 'aria-pressed': i === pen.c ? 'true' : 'false', title: COLOR_NAMES[i] },
      on: { click: () => choose({ c: i }) },
    }, i === ERASER ? h('span', { class: 'swatch-icon', text: '🧽', attrs: { 'aria-hidden': 'true' } }) : null),
  );
  const recentBox = h('div', { class: 'swatch-recent', attrs: { role: 'group', 'aria-label': 'Your colors' } });
  const more = h(
    'button',
    {
      class: ['swatch', 'swatch-more'],
      type: 'button',
      dataset: { key: 'color-more' },
      attrs: { 'aria-label': 'More colors', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', title: 'More colors' },
      on: { click: () => (opened ? close() : open()) },
    },
    h('span', { class: 'swatch-plus', text: '+', attrs: { 'aria-hidden': 'true' } }),
  );
  const svKnob = h('span', { class: 'color-knob color-sv-knob', attrs: { 'aria-hidden': 'true' } });
  const sv = h('div', {
    class: 'color-sv',
    dataset: { key: 'color-sv' },
    attrs: { role: 'slider', tabindex: '0', 'aria-label': 'Shade', 'aria-valuemin': '0', 'aria-valuemax': '100' },
  }, svKnob);
  const hueKnob = h('span', { class: 'color-knob color-hue-knob', attrs: { 'aria-hidden': 'true' } });
  const hue = h('div', {
    class: 'color-hue',
    dataset: { key: 'color-hue' },
    attrs: { role: 'slider', tabindex: '0', 'aria-label': 'Hue', 'aria-valuemin': '0', 'aria-valuemax': '360' },
  }, hueKnob);
  const preview = h('span', { class: 'color-preview', attrs: { 'aria-hidden': 'true' } });
  const hexText = h('span', { class: 'color-hex', attrs: { 'aria-live': 'polite' } });
  const useBtn = button('Use', { variant: 'primary', size: 'sm', key: 'color-use', on: () => use() });
  const cancelBtn = button('Cancel', { variant: 'ghost', size: 'sm', key: 'color-cancel', on: () => close() });
  const pop = h(
    'div',
    { class: 'color-pop', dataset: { key: 'color-pop' }, attrs: { role: 'dialog', 'aria-label': 'Pick a color', 'aria-hidden': 'true' } },
    sv,
    hue,
    h('div', { class: 'color-pop-foot' }, preview, hexText, h('div', { class: 'color-pop-actions' }, cancelBtn, useBtn)),
  );
  const el = h('div', { class: 'swatches' }, swatches, recentBox, more);

  function choose(t) {
    close(false);
    onPick(t);
  }

  function current() {
    return rgbHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
  }

  function render() {
    const hex = current();
    pop.style.setProperty('--hue-color', rgbHex(hsvToRgb(hsv.h, 1, 1)));
    sv.style.setProperty('--x', `${(hsv.s * 100).toFixed(2)}%`);
    sv.style.setProperty('--y', `${((1 - hsv.v) * 100).toFixed(2)}%`);
    sv.setAttribute('aria-valuenow', String(Math.round(hsv.v * 100)));
    sv.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    hue.style.setProperty('--h', `${((hsv.h / 360) * 100).toFixed(2)}%`);
    hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    hue.setAttribute('aria-valuetext', `Hue ${Math.round(hsv.h)} degrees`);
    pop.style.setProperty('--pick', hex);
    hexText.textContent = hex.toUpperCase();
  }

  function paintRecent() {
    recentBox.replaceChildren(
      ...recent.map((hex, i) =>
        h('button', {
          class: ['swatch', 'is-custom'],
          type: 'button',
          dataset: { key: `recent-${i}`, rgb: hex },
          vars: { '--sw': hex },
          attrs: { 'aria-label': `Your color ${hex.toUpperCase()}`, 'aria-pressed': 'false', title: hex.toUpperCase() },
          on: { click: () => choose({ c: CUSTOM, rgb: hex }) },
        }),
      ),
    );
    recentBox.classList.toggle('is-empty', !recent.length);
    mark(pen);
  }

  function mark(p) {
    swatches.forEach((b, i) => {
      b.classList.toggle('is-on', i === p.c);
      b.setAttribute('aria-pressed', i === p.c ? 'true' : 'false');
    });
    for (const b of recentBox.children) {
      const on = p.c === CUSTOM && b.dataset.rgb === p.rgb;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function take(hex) {
    const t = tintOf(hex);
    if (!t) return null;
    if (t.c === CUSTOM) {
      recent = pushRecent(recent, t.rgb);
      saveRecent(store, recent);
    }
    onPick(t);
    paintRecent();
    return t;
  }

  function setHex(hex) {
    const v = hexOf(hex);
    if (!v) return;
    const [r, g, b] = rgbaOf(v);
    const [hh, s, vv] = rgbToHsv(r, g, b);
    hsv.s = s;
    hsv.v = vv;
    if (s > 0 && vv > 0) hsv.h = hh;
    render();
  }

  function open() {
    if (opened) return;
    opened = true;
    setHex(pen.c === CUSTOM ? pen.rgb : COLORS[pen.c] || COLORS[1]);
    pop.classList.add('is-open');
    pop.setAttribute('aria-hidden', 'false');
    more.setAttribute('aria-expanded', 'true');
    more.classList.add('is-open');
    if (typeof sv.focus === 'function') sv.focus();
  }

  function close(back = true) {
    if (!opened) return;
    opened = false;
    pop.classList.remove('is-open');
    pop.setAttribute('aria-hidden', 'true');
    more.setAttribute('aria-expanded', 'false');
    more.classList.remove('is-open');
    if (back && typeof more.focus === 'function') more.focus();
  }

  function use() {
    const t = take(current());
    close();
    return t;
  }

  dragOn(sv, (e) => {
    const at = ratio(sv, e);
    if (!at) return;
    hsv.s = at[0];
    hsv.v = 1 - at[1];
    render();
  });
  dragOn(hue, (e) => {
    const at = ratio(hue, e);
    if (!at) return;
    hsv.h = Math.min(359.9, at[0] * 360);
    render();
  });

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      close();
      return;
    }
    const onSv = e.target === sv;
    const onHue = e.target === hue;
    if (!onSv && !onHue) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      use();
      return;
    }
    const big = Boolean(e.shiftKey);
    let hit = true;
    if (onSv) {
      const step = big ? SV_JUMP : SV_STEP;
      if (e.key === 'ArrowLeft') hsv.s = clamp01(hsv.s - step);
      else if (e.key === 'ArrowRight') hsv.s = clamp01(hsv.s + step);
      else if (e.key === 'ArrowUp') hsv.v = clamp01(hsv.v + step);
      else if (e.key === 'ArrowDown') hsv.v = clamp01(hsv.v - step);
      else hit = false;
    } else {
      const step = big ? HUE_JUMP : HUE_STEP;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') hsv.h = wrapHue(hsv.h - step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') hsv.h = wrapHue(hsv.h + step);
      else hit = false;
    }
    if (!hit) return;
    e.preventDefault();
    render();
  });

  render();
  paintRecent();

  return {
    el,
    pop,
    more,
    mark,
    take,
    open,
    close,
    use,
    setHex,
    current,
    get isOpen() {
      return opened;
    },
    get recent() {
      return recent.slice();
    },
    get hsv() {
      return { ...hsv };
    },
  };
}
