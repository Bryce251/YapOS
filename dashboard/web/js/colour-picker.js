import { h, nextId } from './dom.js';
import { NAME_PALETTE } from './profile-look.js';

export const RECENT_KEY = 'yapos-recent-colours';
export const RECENT_MAX = 8;
export const STEP = 1;
export const BIG_STEP = 10;
export const HUE_MAX = 360;
export const FALLBACK = '#7c5cff';

const HEX6 = /^#[0-9a-f]{6}$/;
const NAMED_LIST = 'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';

let named = null;

function namedColours() {
  if (named) return named;
  named = new Map();
  const parts = NAMED_LIST.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) named.set(parts[i], `#${parts[i + 1]}`);
  return named;
}

export function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function hexToRgb(hex) {
  const c = parseColour(hex);
  if (!c) return null;
  const n = Number.parseInt(c.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

export function rgbToHsv({ r, g, b }) {
  const R = clamp(r, 0, 255) / 255;
  const G = clamp(g, 0, 255) / 255;
  const B = clamp(b, 0, 255) / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let hue = 0;
  if (d) {
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

export function hsvToRgb({ h: hue, s, v }) {
  const H = ((clamp(hue, 0, HUE_MAX) % 360) + 360) % 360;
  const S = clamp(s, 0, 100) / 100;
  const V = clamp(v, 0, 100) / 100;
  const c = V * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = V - c;
  let rgb;
  if (H < 60) rgb = [c, x, 0];
  else if (H < 120) rgb = [x, c, 0];
  else if (H < 180) rgb = [0, c, x];
  else if (H < 240) rgb = [0, x, c];
  else if (H < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) };
}

export function hexToHsv(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(hsv) {
  return rgbToHex(hsvToRgb(hsv));
}

export function clampHsv(hsv) {
  const src = hsv && typeof hsv === 'object' ? hsv : {};
  return { h: clamp(src.h, 0, HUE_MAX), s: clamp(src.s, 0, 100), v: clamp(src.v, 0, 100) };
}

function rgbText(v) {
  const m = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (!m) return null;
  const parts = m.slice(1, 4).map(Number);
  return parts.every((n) => n <= 255) ? rgbToHex({ r: parts[0], g: parts[1], b: parts[2] }) : null;
}

export function parseColour(text) {
  if (typeof text !== 'string') return null;
  const v = text.trim().toLowerCase();
  if (!v || v.length > 40) return null;
  let m = /^#?([0-9a-f]{3})$/.exec(v);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^#?([0-9a-f]{6})$/.exec(v);
  if (m) return `#${m[1]}`;
  if (v.startsWith('rgb')) return rgbText(v);
  return namedColours().get(v.replace(/[\s-]+/g, '')) || null;
}

export function moveArea(hsv, key, shift = false) {
  const step = shift ? BIG_STEP : STEP;
  const c = clampHsv(hsv);
  let { s, v } = c;
  if (key === 'ArrowLeft') s -= step;
  else if (key === 'ArrowRight') s += step;
  else if (key === 'ArrowUp') v += step;
  else if (key === 'ArrowDown') v -= step;
  else if (key === 'PageUp') v += BIG_STEP;
  else if (key === 'PageDown') v -= BIG_STEP;
  else if (key === 'Home') s = 0;
  else if (key === 'End') s = 100;
  else return null;
  return clampHsv({ h: c.h, s, v });
}

export function moveHue(hsv, key, shift = false) {
  const step = shift ? BIG_STEP : STEP;
  const c = clampHsv(hsv);
  let hue = c.h;
  if (key === 'ArrowLeft' || key === 'ArrowDown') hue -= step;
  else if (key === 'ArrowRight' || key === 'ArrowUp') hue += step;
  else if (key === 'PageDown') hue -= BIG_STEP;
  else if (key === 'PageUp') hue += BIG_STEP;
  else if (key === 'Home') hue = 0;
  else if (key === 'End') hue = HUE_MAX;
  else return null;
  return clampHsv({ ...c, h: hue });
}

export function areaFromPoint(rect, x, y) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return { s: clamp(((x - rect.left) / rect.width) * 100, 0, 100), v: clamp(100 - ((y - rect.top) / rect.height) * 100, 0, 100) };
}

export function hueFromPoint(rect, x) {
  if (!rect || !(rect.width > 0)) return null;
  return clamp(((x - rect.left) / rect.width) * HUE_MAX, 0, HUE_MAX);
}

const memory = { list: [], broken: false };

export function forgetRecent() {
  memory.list = [];
  memory.broken = false;
}

function cleanList(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const c = typeof x === 'string' && HEX6.test(x) ? x : null;
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

export function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readRecent(storage) {
  if (!storage || memory.broken) return [...memory.list];
  try {
    const raw = storage.getItem(RECENT_KEY);
    return raw ? cleanList(JSON.parse(raw)) : [];
  } catch {
    memory.broken = true;
    return [...memory.list];
  }
}

export function pushRecent(storage, hex) {
  const c = parseColour(hex);
  const now = readRecent(storage);
  if (!c) return now;
  const next = [c, ...now.filter((x) => x !== c)].slice(0, RECENT_MAX);
  memory.list = next;
  if (storage && !memory.broken) {
    try {
      storage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      memory.broken = true;
    }
  }
  return next;
}

function pct(n) {
  return `${Math.round(n * 100) / 100}%`;
}

function eyeDropperOf(win) {
  try {
    return win && typeof win.EyeDropper === 'function' ? win.EyeDropper : null;
  } catch {
    return null;
  }
}

export function createColourPicker({ value = FALLBACK, label = 'Colour', palette = NAME_PALETTE, onInput = null, onCommit = null, storage = defaultStorage(), doc = globalThis.document, win = globalThis.window, frame = null } = {}) {
  let hex = parseColour(value) || FALLBACK;
  let hsv = hexToHsv(hex);
  let opened = false;
  let dead = false;
  let startHex = hex;
  let drag = null;
  let pending = null;
  let queued = false;
  const id = nextId('cp');
  const lower = label.toLowerCase();
  const schedule = frame || (win && typeof win.requestAnimationFrame === 'function' ? (fn) => win.requestAnimationFrame(fn) : null);

  const swatch = h('span', { class: 'cp-swatch', attrs: { 'aria-hidden': 'true' } });
  const button = h('button', { type: 'button', class: 'cp-trigger', title: `Pick the ${lower}`, attrs: { 'aria-label': `Open the colour picker for the ${lower}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': id } }, swatch);
  const areaThumb = h('span', { class: 'cp-area-thumb', attrs: { 'aria-hidden': 'true' } });
  const area = h('div', { class: 'cp-area', attrs: { role: 'slider', tabindex: '0', 'aria-label': `${label} shade`, 'aria-valuemin': '0', 'aria-valuemax': '100' } }, areaThumb);
  const hueThumb = h('span', { class: 'cp-hue-thumb', attrs: { 'aria-hidden': 'true' } });
  const hue = h('div', { class: 'cp-hue', attrs: { role: 'slider', tabindex: '0', 'aria-label': `${label} hue`, 'aria-valuemin': '0', 'aria-valuemax': String(HUE_MAX), 'aria-orientation': 'horizontal' } }, hueThumb);
  const hexId = nextId('cp-hex');
  const hexInput = h('input', { type: 'text', id: hexId, class: 'input input-mono cp-hex', maxLength: 40, autocomplete: 'off', spellcheck: false, placeholder: '#7c5cff' });
  const note = h('p', { class: 'cp-note', attrs: { 'aria-live': 'polite' } });
  const chipText = h('span', { class: 'cp-chip-text' });
  const chip = h('span', { class: 'cp-chip' }, h('span', { class: 'cp-chip-dot', attrs: { 'aria-hidden': 'true' } }), chipText);
  const recentBox = h('div', { class: 'cp-swatches cp-recent', attrs: { role: 'group', 'aria-label': 'Recent colours' } });
  const recentWrap = h('div', { class: 'cp-group' }, h('p', { class: 'cp-label', text: 'Recent' }), recentBox);
  const paletteBox = h('div', { class: 'cp-swatches cp-palette', attrs: { role: 'group', 'aria-label': 'Colour ideas' } });
  const Dropper = eyeDropperOf(win);
  const dropBtn = Dropper ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm cp-drop', text: 'Pick from screen' }) : null;
  const doneBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm cp-done', text: 'Done' });
  const panel = h('div', { class: 'cp-pop', id, hidden: true, attrs: { role: 'dialog', 'aria-label': `${label} colour picker` } },
    area,
    hue,
    h('div', { class: 'cp-row' },
      chip,
      h('label', { class: 'sr-only', htmlFor: hexId, text: `${label} hex code or colour name` }),
      hexInput),
    note,
    recentWrap,
    h('div', { class: 'cp-group' }, h('p', { class: 'cp-label', text: 'Ideas' }), paletteBox),
    h('div', { class: 'cp-actions' }, dropBtn, doneBtn));

  function swatchButton(c, name, cls) {
    const b = h('button', { type: 'button', class: ['cp-pick', cls], title: name, attrs: { 'aria-label': name, 'data-colour': c } });
    b.style.setProperty('--sw', c);
    b.addEventListener('click', () => {
      setHex(c, true);
      note.textContent = '';
    });
    return b;
  }

  for (const p of Array.isArray(palette) ? palette : []) {
    const c = parseColour(p && p.hex);
    if (c) paletteBox.appendChild(swatchButton(c, `${p.label || c} (${c})`, 'is-palette'));
  }

  function drawRecent() {
    const list = readRecent(storage);
    recentBox.replaceChildren(...list.map((c) => swatchButton(c, `Recent colour ${c}`, 'is-recent')));
    recentWrap.hidden = !list.length;
  }

  function paint() {
    const c = clampHsv(hsv);
    const tint = hsvToHex({ h: c.h, s: 100, v: 100 });
    panel.style.setProperty('--cp-tint', tint);
    panel.style.setProperty('--cp-x', pct(c.s));
    panel.style.setProperty('--cp-y', pct(100 - c.v));
    panel.style.setProperty('--cp-h', pct((c.h / HUE_MAX) * 100));
    panel.style.setProperty('--cp-colour', hex);
    swatch.style.setProperty('--cp-colour', hex);
    area.setAttribute('aria-valuenow', String(Math.round(c.s)));
    area.setAttribute('aria-valuetext', `Saturation ${Math.round(c.s)}%, brightness ${Math.round(c.v)}%, ${hex}`);
    hue.setAttribute('aria-valuenow', String(Math.round(c.h)));
    hue.setAttribute('aria-valuetext', `Hue ${Math.round(c.h)} degrees, ${hex}`);
    chipText.textContent = hex;
    button.setAttribute('data-colour', hex);
    if (!doc || doc.activeElement !== hexInput) hexInput.value = hex;
  }

  function emit() {
    if (dead) return;
    if (typeof onInput === 'function') onInput(hex);
  }

  function setHsv(next, fire = true) {
    hsv = clampHsv(next);
    const was = hex;
    hex = hsvToHex(hsv);
    paint();
    if (fire && hex !== was) emit();
  }

  function setHex(raw, fire = false) {
    const c = parseColour(raw);
    if (!c) return false;
    const was = hex;
    hex = c;
    if (hsvToHex(hsv) !== c) hsv = hexToHsv(c);
    paint();
    if (fire && c !== was) emit();
    return true;
  }

  function flushPending() {
    queued = false;
    if (dead) {
      pending = null;
      return;
    }
    const p = pending;
    pending = null;
    if (!p) return;
    if (p.kind === 'area') {
      const at = areaFromPoint(area.getBoundingClientRect(), p.x, p.y);
      if (at) setHsv({ h: hsv.h, s: at.s, v: at.v });
    } else {
      const at = hueFromPoint(hue.getBoundingClientRect(), p.x);
      if (at !== null) setHsv({ ...hsv, h: at });
    }
  }

  function queue(kind, e) {
    pending = { kind, x: Number(e.clientX), y: Number(e.clientY) };
    if (!schedule) return flushPending();
    if (queued) return undefined;
    queued = true;
    schedule(flushPending);
    return undefined;
  }

  function bindDrag(el, kind) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      drag = kind;
      try {
        if (typeof el.setPointerCapture === 'function' && e.pointerId !== undefined) el.setPointerCapture(e.pointerId);
      } catch {}
      el.focus();
      pending = { kind, x: Number(e.clientX), y: Number(e.clientY) };
      flushPending();
    });
    el.addEventListener('pointermove', (e) => {
      if (drag !== kind) return;
      queue(kind, e);
    });
    const end = (e) => {
      if (drag !== kind) return;
      drag = null;
      flushPending();
      try {
        if (typeof el.releasePointerCapture === 'function' && e && e.pointerId !== undefined) el.releasePointerCapture(e.pointerId);
      } catch {}
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', () => {
      drag = null;
    });
  }

  bindDrag(area, 'area');
  bindDrag(hue, 'hue');

  area.addEventListener('keydown', (e) => {
    const next = moveArea(hsv, e.key, Boolean(e.shiftKey));
    if (!next) return;
    e.preventDefault();
    setHsv(next);
  });
  hue.addEventListener('keydown', (e) => {
    const next = moveHue(hsv, e.key, Boolean(e.shiftKey));
    if (!next) return;
    e.preventDefault();
    setHsv(next);
  });

  const typed = (strict) => {
    const raw = hexInput.value;
    if (setHex(raw, true)) {
      note.textContent = '';
      hexInput.classList.remove('is-invalid');
      return true;
    }
    if (strict) {
      note.textContent = 'Try a code like #7c5cff or a colour name like teal.';
      hexInput.classList.add('is-invalid');
    }
    return false;
  };
  hexInput.addEventListener('input', () => typed(false));
  hexInput.addEventListener('change', () => typed(true));
  hexInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (typed(true)) hexInput.value = hex;
  });
  hexInput.addEventListener('blur', () => {
    if (!hexInput.classList.contains('is-invalid')) hexInput.value = hex;
  });

  if (dropBtn) {
    dropBtn.addEventListener('click', async () => {
      try {
        const res = await new Dropper().open();
        if (dead) return;
        if (res && setHex(res.sRGBHex, true)) note.textContent = '';
      } catch {
        note.textContent = '';
      }
    });
  }

  doneBtn.addEventListener('click', () => close());

  function outside(e) {
    const t = e && e.target;
    if (!t || panel.contains(t) || button.contains(t)) return;
    close({ focus: false });
  }

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    close();
  });

  function open() {
    if (opened || dead) return;
    opened = true;
    startHex = hex;
    drawRecent();
    paint();
    note.textContent = '';
    hexInput.classList.remove('is-invalid');
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('is-open');
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('pointerdown', outside, true);
    if (typeof panel.scrollIntoView === 'function') {
      area.focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else area.focus();
  }

  function close({ focus = true } = {}) {
    if (!opened) return;
    opened = false;
    drag = null;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('is-open');
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('pointerdown', outside, true);
    if (hex !== startHex) {
      pushRecent(storage, hex);
      if (typeof onCommit === 'function') onCommit(hex);
    }
    if (focus) button.focus();
  }

  button.addEventListener('click', () => (opened ? close() : open()));
  paint();

  return {
    button,
    panel,
    open,
    close,
    set(raw) {
      setHex(raw, false);
    },
    get value() {
      return hex;
    },
    get hsv() {
      return { ...hsv };
    },
    get isOpen() {
      return opened;
    },
    destroy() {
      close({ focus: false });
      dead = true;
      drag = null;
      pending = null;
    },
    get destroyed() {
      return dead;
    },
  };
}

export function colourRow(picker, ...rest) {
  return h('div', { class: 'pe-custom-row cp-host' }, picker.button, ...rest, picker.panel);
}
