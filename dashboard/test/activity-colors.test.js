import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import { pickIn } from './reason-pick.js';
import {
  GRID_W,
  GRID_H,
  COLORS,
  SIZES,
  FILL,
  FILL_CHARS,
  CUSTOM,
  CUSTOM_FILL_CHARS,
  RGB_CHARS,
  FILL_TOLERANCE,
  encodeStroke,
  decodeStroke,
  encodeParts,
  fitInk,
  readInk,
  pack,
  inkKey,
  liveMessage,
  applyLive,
  hexOf,
  tintOf,
  colorOf,
  paletteIndex,
  rgbaOf,
  floodFill,
  sameRegion,
  createPainter,
  paintInk,
} from '../web/activity/js/games/ink.js';
import draw from '../web/activity/js/games/draw.js';
import telephone, { KEY as TEL_KEY, MAX_SEATS, inkKey as telKey, validInk, inkChars } from '../web/activity/js/games/telephone.js';
import { fitSeat, seatBudget, SEAT_CHUNK_BYTES, G_MAX } from '../web/activity/js/games/ink.js';
import odd, { INTRO_MS } from '../web/activity/js/games/odd.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { createTelephoneView } from '../web/activity/js/views/telephone.js';
import { createOddView } from '../web/activity/js/views/odd.js';
import { configureAdmins, resetAdmins } from '../web/activity/js/admin.js';
import { FLAG_THANKS } from '../web/activity/js/views/draw.js';
import { createPalette, hsvToRgb, rgbToHsv, rgbHex, readRecent, saveRecent, pushRecent, pixelAt, canvasPixel, RECENT_KEY, RECENT_MAX } from '../web/activity/js/views/palette.js';

const ROOT = new URL('../web/activity/', import.meta.url);
const W = GRID_W * 2;
const H = GRID_H * 2;
const LEGACY_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function legacyEncode(stroke) {
  const big = (v) => LEGACY_ABC[(v >> 6) & 63] + LEGACY_ABC[v & 63];
  const delta = (d) => (d >= -31 && d <= 31 ? LEGACY_ABC[d + 32] : LEGACY_ABC[0] + big(d + 2048));
  const pts = stroke.pts;
  const fill = stroke.z === FILL;
  let out = LEGACY_ABC[stroke.c] + LEGACY_ABC[fill ? FILL : stroke.z];
  let [px, py] = pts[0];
  out += big(px) + big(py);
  if (fill) return out;
  for (let i = 1; i < pts.length; i += 1) {
    out += delta(pts[i][0] - px) + delta(pts[i][1] - py);
    [px, py] = pts[i];
  }
  return out;
}

function buffer(w, h, rgb = [255, 255, 255]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgb[0];
    d[i + 1] = rgb[1];
    d[i + 2] = rgb[2];
    d[i + 3] = 255;
  }
  return d;
}

function px(d, w, x, y) {
  const i = (y * w + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

class RasterCtx {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.canvas = { width: w, height: h };
    this.data = buffer(w, h);
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.path = [];
    this.reads = [];
  }

  dot(cx, cy, r, rgb) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
        const i = (y * this.w + x) * 4;
        this.data[i] = rgb[0];
        this.data[i + 1] = rgb[1];
        this.data[i + 2] = rgb[2];
        this.data[i + 3] = 255;
      }
    }
  }

  fillRect(x, y, w, h) {
    const rgb = rgbaOf(this.fillStyle);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx += 1) {
        const i = (yy * this.w + xx) * 4;
        this.data[i] = rgb[0];
        this.data[i + 1] = rgb[1];
        this.data[i + 2] = rgb[2];
        this.data[i + 3] = 255;
      }
    }
  }

  beginPath() {
    this.path = [];
  }

  moveTo(x, y) {
    this.path.push([x, y]);
  }

  lineTo(x, y) {
    this.path.push([x, y]);
  }

  arc(x, y, r) {
    this.path = [[x, y, r]];
  }

  fill() {
    const [x, y, r] = this.path[0] || [];
    if (r !== undefined) this.dot(x, y, r, rgbaOf(this.fillStyle));
  }

  stroke() {
    const rgb = rgbaOf(this.strokeStyle);
    const r = this.lineWidth / 2;
    for (let i = 1; i < this.path.length; i += 1) {
      const [ax, ay] = this.path[i - 1];
      const [bx, by] = this.path[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let k = 0; k <= n; k += 1) this.dot(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, r, rgb);
    }
  }

  getImageData(x, y, w, h) {
    this.reads.push([x, y, w, h]);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy += 1) {
      for (let xx = 0; xx < w; xx += 1) {
        const s = ((y + yy) * this.w + x + xx) * 4;
        const d = (yy * w + xx) * 4;
        out[d] = this.data[s];
        out[d + 1] = this.data[s + 1];
        out[d + 2] = this.data[s + 2];
        out[d + 3] = this.data[s + 3];
      }
    }
    return { width: w, height: h, data: out };
  }

  putImageData(img) {
    this.data.set(img.data);
  }

  at(x, y) {
    return px(this.data, this.w, x, y);
  }
}

function same(a, b) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function ring(cx, cy, r, n = 48) {
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push([Math.round(cx + r * Math.cos((i / n) * Math.PI * 2)), Math.round(cy + r * Math.sin((i / n) * Math.PI * 2))]);
  return out;
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInlineStyles(root) {
  for (const el of all(root)) assert.equal(el.getAttribute('style'), null, el.className);
}

function pointer(type, x, y, id = 1) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = id;
  return e;
}

function key(name, opts = {}) {
  const e = new FakeEvent('keydown', { bubbles: true, key: name });
  e.shiftKey = Boolean(opts.shift);
  return e;
}

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

function brokenStore() {
  return {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
}

function fakeCanvases() {
  const made = [];
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') {
      const ctx = new RasterCtx();
      made.push(ctx);
      el.width = W;
      el.height = H;
      el.getContext = () => ctx;
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: GRID_W, height: GRID_H });
    }
    return el;
  };
  return made;
}

function canvasOf(view) {
  return all(view.el).find((x) => x.localName === 'canvas');
}

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function clearStorage() {
  try {
    if (globalThis.window) globalThis.window.localStorage = memoryStore();
  } catch {
    return;
  }
}

async function startDraw(count = 2) {
  installDom({ url: 'https://yapos.dev/activity/' });
  clearStorage();
  const ctxs = fakeCanvases();
  const r = room(count);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = VIEWS.draw({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win });
    engine.on('change', (snap) => v.update(snap));
    return { v, engine, ctx: ctxs[ctxs.length - 1] };
  });
  r.engines[0].lobby.pick('draw');
  r.engines[0].lobby.start();
  for (const x of views) x.v.update(x.engine.snapshot());
  await r.clock.advance(400);
  const st0 = r.engines[0].snapshot().state.draw;
  const drawer = views.find((x) => x.engine.snapshot().meSlot === st0.drawer);
  const guesser = views.find((x) => x !== drawer);
  byKey(drawer.v.el, 'word-0').click();
  await r.clock.advance(400);
  return { r, views, drawer, guesser, toasts, st: r.engines[0].snapshot().state.draw };
}

async function startTelephone() {
  const r = room(3, { games: [telephone] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('telephone'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const s = host.snapshot().state[TEL_KEY];
  s.seats.forEach((slot, seat) => bySlot(r, slot).act({ type: 'text', step: s.step, text: ['A cat', 'A dog', 'A frog'][seat] }));
  await r.clock.advance(500);
  return r;
}

test('every old palette stroke and fill encodes and decodes exactly as before', () => {
  const samples = [];
  for (let c = 0; c < COLORS.length; c += 1) {
    for (let z = 0; z < SIZES.length; z += 1) samples.push({ c, z, pts: [[c * 30, z * 40 + 3], [c * 30 + 5, z * 40], [c * 20 + 200, z * 40 + 90], [0, 0]] });
    samples.push({ c, z: FILL, pts: [[c * 17, 300 - c]] });
  }
  for (const s of samples) {
    const text = encodeStroke(s);
    assert.equal(text, legacyEncode(s), 'the encoder writes the same text as before');
    assert.deepEqual(decodeStroke(text), { c: s.c, z: s.z, pts: s.pts });
    assert.equal(Object.hasOwn(decodeStroke(text), 'rgb'), false);
  }
  assert.deepEqual(decodeStroke('BBAoAo'), { c: 1, z: 1, pts: [[40, 40]] });
  assert.deepEqual(decodeStroke('GEBkCz'), { c: 6, z: FILL, pts: [[100, 179]] });
  const saved = { 'ink.0': { k: 9, i: 0, s: samples.map(legacyEncode) } };
  assert.deepEqual(readInk(saved, 9).strokes, samples);
});

test('a custom color stroke and fill carry 24 bit RGB in four extra ink characters', () => {
  assert.equal(CUSTOM, COLORS.length);
  assert.equal(RGB_CHARS, 4);
  assert.equal(CUSTOM_FILL_CHARS, FILL_CHARS + 4);
  const line = { c: CUSTOM, rgb: '#12abef', z: 2, pts: [[10, 10], [14, 9], [300, 200]] };
  const text = encodeStroke(line);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.equal(text[0], LEGACY_ABC[CUSTOM]);
  assert.equal(text.length, legacyEncode({ ...line, c: 1 }).length + RGB_CHARS);
  assert.deepEqual(decodeStroke(text), line);
  const fill = { c: CUSTOM, rgb: '#000001', z: FILL, pts: [[480, 360]] };
  const ftext = encodeStroke(fill);
  assert.equal(ftext.length, CUSTOM_FILL_CHARS);
  assert.deepEqual(decodeStroke(ftext), fill);
  for (const hex of ['#000000', '#fffffe', '#808080', '#ff00ff', '#010203']) {
    const d = decodeStroke(encodeStroke({ c: CUSTOM, rgb: hex, z: 0, pts: [[1, 2]] }));
    if (COLORS.includes(hex)) assert.equal(d.c, COLORS.indexOf(hex));
    else assert.equal(d.rgb, hex);
  }
  assert.deepEqual(decodeStroke(encodeStroke({ c: CUSTOM, rgb: '#EF4444', z: 1, pts: [[5, 5]] })), { c: 3, z: 1, pts: [[5, 5]] }, 'a palette color always encodes as its palette index');
  assert.deepEqual(decodeStroke('MAAAABAoAo'), { c: CUSTOM, rgb: '#000000', z: 1, pts: [[40, 40]] });
  const n = parseInt('ef4444', 16);
  const red = LEGACY_ABC[(n >> 18) & 63] + LEGACY_ABC[(n >> 12) & 63] + LEGACY_ABC[(n >> 6) & 63] + LEGACY_ABC[n & 63];
  const fake = `M${red}${encodeStroke({ c: 3, z: 1, pts: [[5, 5]] }).slice(1)}`;
  assert.equal(decodeStroke(fake), null, 'a palette color written the long way is refused, so there is one spelling per color');
  assert.equal(decodeStroke('MAAA'), null);
  assert.equal(decodeStroke('MAAAABAo'), null);
  assert.equal(decodeStroke('MAAAAEAoAoA'), null, 'a custom fill must be exactly ten characters');
  assert.equal(decodeStroke('NBAoAo'), null, 'indexes past the custom marker are still refused');
  assert.equal(decodeStroke('M!AAABAoAo'), null);
});

test('long custom strokes split into parts that all keep their color, live and packed', () => {
  const pts = [];
  for (let i = 0; i < 900; i += 1) pts.push([Math.round(240 + 200 * Math.cos(i / 9)), Math.round(180 + 150 * Math.sin(i / 7))]);
  const stroke = { c: CUSTOM, rgb: '#3355aa', z: 1, pts };
  const parts = encodeParts(stroke, 0);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.equal(decodeStroke(p).rgb, '#3355aa');
  const fit = fitInk([stroke, { c: 4, z: FILL, pts: [[1, 1]] }, { c: CUSTOM, rgb: '#0a0b0c', z: FILL, pts: [[2, 2]] }], 5);
  const state = {};
  for (const ch of fit.chunks) state[inkKey(ch.i)] = ch;
  const back = readInk(state, 5).strokes;
  assert.equal(back.filter((s) => s.rgb === '#3355aa').length, parts.length);
  assert.deepEqual(back[back.length - 1], { c: CUSTOM, rgb: '#0a0b0c', z: FILL, pts: [[2, 2]] });
  assert.deepEqual(back[back.length - 2], { c: 4, z: FILL, pts: [[1, 1]] });
  const live = new Map();
  const cur = { c: CUSTOM, rgb: '#3355aa', z: 1, pts: pts.slice(0, 3) };
  assert.equal(applyLive(live, liveMessage(1, 0, 0, cur.pts, cur)), true);
  cur.pts = pts.slice(0, 8);
  assert.equal(applyLive(live, liveMessage(1, 0, 3, cur.pts, cur)), true);
  assert.equal(live.get(0).rgb, '#3355aa');
  assert.equal(live.get(0).pts.length, 8);
});

test('color helpers turn any hex into a palette index or a custom tint', () => {
  assert.equal(hexOf('#ABCDEF'), '#abcdef');
  assert.equal(hexOf('abcdef'), '#abcdef');
  assert.equal(hexOf('#abc'), null);
  assert.equal(hexOf(null), null);
  assert.equal(paletteIndex('#22C55E'), 6);
  assert.equal(paletteIndex('#22c55f'), -1);
  assert.deepEqual(tintOf('#22c55e'), { c: 6 });
  assert.deepEqual(tintOf('#22c55f'), { c: CUSTOM, rgb: '#22c55f' });
  assert.deepEqual(tintOf('#FFFFFF'), { c: 0 });
  assert.equal(tintOf('nope'), null);
  assert.equal(colorOf({ c: CUSTOM, rgb: '#123456' }), '#123456');
  assert.equal(colorOf({ c: CUSTOM, rgb: 'bad' }), COLORS[1]);
  assert.equal(colorOf({ c: 5 }), COLORS[5]);
  assert.equal(colorOf({ c: 99 }), COLORS[1]);
});

test('hue, saturation and brightness convert to RGB and back', () => {
  assert.deepEqual(hsvToRgb(0, 1, 1), [255, 0, 0]);
  assert.deepEqual(hsvToRgb(120, 1, 1), [0, 255, 0]);
  assert.deepEqual(hsvToRgb(240, 1, 0.5), [0, 0, 128]);
  assert.deepEqual(hsvToRgb(360, 0, 1), [255, 255, 255]);
  assert.deepEqual(hsvToRgb(30, 1, 0), [0, 0, 0]);
  for (const hex of ['#f2613f', '#7c5cff', '#123456', '#fedcba', '#00ff7f']) {
    const [r, g, b] = rgbaOf(hex);
    const [hh, s, v] = rgbToHsv(r, g, b);
    assert.equal(rgbHex(hsvToRgb(hh, s, v)), hex);
  }
  assert.equal(rgbHex([300, -4, 15.6]), '#ff0010');
});

test('recent colors keep up to six custom colors per viewer and survive a blocked store', () => {
  let list = [];
  for (const hex of ['#111112', '#222223', '#333334', '#111112', '#ef4444', '#444445', '#555556', '#666667', '#777778']) list = pushRecent(list, hex);
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(list, ['#777778', '#666667', '#555556', '#444445', '#111112', '#333334']);
  const store = memoryStore();
  assert.equal(saveRecent(store, list), true);
  assert.deepEqual(readRecent(store), list);
  assert.deepEqual(readRecent(memoryStore({ [RECENT_KEY]: '{oops' })), []);
  assert.deepEqual(readRecent(memoryStore({ [RECENT_KEY]: JSON.stringify(['#ABCDEF', '#abcdef', 'red', '#ef4444', 4]) })), ['#abcdef']);
  assert.deepEqual(readRecent(brokenStore()), []);
  assert.equal(saveRecent(brokenStore(), list), false);
  assert.deepEqual(readRecent(null), []);
});

test('the color picker opens from the plus swatch, drags, takes arrow keys and picks with Enter', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const store = memoryStore();
  const pen = { c: 1, z: 1 };
  const picks = [];
  const pal = createPalette({ pen, store, onPick: (t) => {
    picks.push(t);
    Object.assign(pen, t);
  } });
  document.body.append(pal.el, pal.pop);
  const more = byKey(pal.el, 'color-more');
  assert.ok(more);
  assert.equal(pal.el.lastChild, more, 'the plus swatch sits at the end of the palette');
  assert.equal(byKey(pal.el, 'color-1').getAttribute('aria-pressed'), 'true');
  assert.equal(pal.isOpen, false);
  assert.equal(pal.pop.classList.contains('is-open'), false);
  more.click();
  assert.equal(pal.isOpen, true);
  assert.equal(pal.pop.classList.contains('is-open'), true);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  const sv = byKey(pal.pop, 'color-sv');
  const hue = byKey(pal.pop, 'color-hue');
  assert.equal(document.activeElement, sv, 'opening focuses the shade square');
  assert.equal(pal.current(), COLORS[1], 'it starts from the current color');
  sv.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 150 });
  hue.getBoundingClientRect = () => ({ left: 100, top: 220, width: 200, height: 20 });
  hue.dispatchEvent(pointer('pointerdown', 100 + 200 / 3, 230));
  assert.ok(Math.abs(pal.hsv.h - 120) < 0.01);
  hue.dispatchEvent(pointer('pointermove', 100 + 400 / 3, 230));
  assert.ok(Math.abs(pal.hsv.h - 240) < 0.01, 'dragging the hue bar follows the pointer');
  hue.dispatchEvent(pointer('pointerup', 100 + 400 / 3, 230));
  hue.dispatchEvent(pointer('pointermove', 120, 230));
  assert.ok(Math.abs(pal.hsv.h - 240) < 0.01, 'moving after letting go does nothing');
  sv.dispatchEvent(pointer('pointerdown', 300, 50));
  assert.equal(pal.current(), '#0000ff');
  sv.dispatchEvent(pointer('pointermove', 400, -20));
  assert.equal(pal.current(), '#0000ff', 'the knob stays inside the square');
  sv.dispatchEvent(pointer('pointermove', 200, 125));
  assert.deepEqual([pal.hsv.s, pal.hsv.v], [0.5, 0.5]);
  sv.dispatchEvent(pointer('pointerup', 200, 125));
  assert.equal(sv.style.props['--x'], '50.00%');
  assert.equal(sv.style.props['--y'], '50.00%');
  assert.equal(hue.style.props['--h'], '66.67%');
  assert.equal(pal.pop.style.props['--pick'], pal.current());
  assert.equal(pal.pop.style.props['--hue-color'], '#0000ff');
  sv.dispatchEvent(key('ArrowRight'));
  sv.dispatchEvent(key('ArrowUp', { shift: true }));
  assert.ok(Math.abs(pal.hsv.s - 0.52) < 1e-9);
  assert.ok(Math.abs(pal.hsv.v - 0.6) < 1e-9);
  sv.dispatchEvent(key('ArrowLeft'));
  sv.dispatchEvent(key('ArrowDown', { shift: true }));
  assert.ok(Math.abs(pal.hsv.s - 0.5) < 1e-9);
  assert.ok(Math.abs(pal.hsv.v - 0.5) < 1e-9);
  hue.dispatchEvent(key('ArrowRight', { shift: true }));
  assert.ok(Math.abs(pal.hsv.h - 255) < 1e-9);
  hue.dispatchEvent(key('ArrowLeft'));
  assert.ok(Math.abs(pal.hsv.h - 253) < 1e-9);
  const want = pal.current();
  assert.equal(want, rgbHex(hsvToRgb(253, 0.5, 0.5)));
  assert.match(pal.pop.textContent, new RegExp(want.slice(1).toUpperCase()));
  hue.dispatchEvent(key('Enter'));
  assert.deepEqual(picks.at(-1), { c: CUSTOM, rgb: want });
  assert.equal(pal.isOpen, false);
  assert.equal(document.activeElement, more, 'focus goes back to the plus swatch');
  assert.deepEqual(pal.recent, [want]);
  assert.deepEqual(JSON.parse(store.map.get(RECENT_KEY)), [want]);
  const chip = byKey(pal.el, 'recent-0');
  assert.ok(chip);
  assert.equal(chip.style.props['--sw'], want);
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(byKey(pal.el, 'color-1').getAttribute('aria-pressed'), 'false');
  more.click();
  assert.equal(pal.current(), want, 'reopening starts from the custom color');
  sv.dispatchEvent(key('ArrowUp'));
  sv.dispatchEvent(key('Escape'));
  assert.equal(pal.isOpen, false);
  assert.equal(picks.length, 1, 'Escape closes without picking');
  more.click();
  byKey(pal.pop, 'color-cancel').click();
  assert.equal(pal.isOpen, false);
  more.click();
  more.click();
  assert.equal(pal.isOpen, false, 'tapping plus again closes it');
  more.click();
  byKey(pal.el, 'color-6').click();
  assert.deepEqual(picks.at(-1), { c: 6 });
  assert.equal(pal.isOpen, false, 'picking a swatch closes the picker');
  pal.mark(pen);
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  more.click();
  pal.setHex('#7C5CFF');
  byKey(pal.pop, 'color-use').click();
  assert.deepEqual(picks.at(-1), { c: 9 }, 'a palette color picked in the square snaps to the swatch');
  assert.equal(pal.recent.length, 1);
  for (let i = 0; i < 8; i += 1) pal.take(rgbHex([10 + i, 20, 30]));
  assert.equal(pal.recent.length, RECENT_MAX);
  assert.equal(pal.el.querySelectorAll('.is-custom').length, RECENT_MAX);
  assert.equal(pal.recent[0], rgbHex([17, 20, 30]));
  noInlineStyles(pal.el);
  noInlineStyles(pal.pop);
  const again = createPalette({ pen: { c: 1 }, store, onPick() {} });
  assert.deepEqual(again.recent, pal.recent, 'recent colors come back for the same viewer');
  const blocked = createPalette({ pen: { c: 1 }, store: brokenStore(), onPick() {} });
  assert.deepEqual(blocked.recent, []);
  assert.deepEqual(blocked.take('#0a0a0a'), { c: CUSTOM, rgb: '#0a0a0a' });
  assert.deepEqual(blocked.recent, ['#0a0a0a'], 'a blocked store still keeps colors for this session');
});

test('the eyedropper reads a single pixel and snaps exact palette colors', () => {
  const ctx = new RasterCtx(20, 10);
  ctx.fillStyle = '#123456';
  ctx.fillRect(0, 0, 10, 10);
  ctx.fillStyle = COLORS[3];
  ctx.fillRect(10, 0, 10, 10);
  assert.equal(pixelAt(ctx, 3, 3), '#123456');
  assert.deepEqual(ctx.reads.at(-1), [3, 3, 1, 1], 'only one pixel is read');
  assert.equal(pixelAt(ctx, 15, 2), COLORS[3]);
  assert.deepEqual(tintOf(pixelAt(ctx, 15, 2)), { c: 3 });
  assert.equal(pixelAt(ctx, 25, 2), null);
  assert.equal(pixelAt(ctx, -1, 2), null);
  assert.equal(pixelAt(null, 1, 1), null);
  assert.equal(pixelAt({ getImageData() {
    throw new Error('tainted');
  } }, 1, 1), null);
  const canvas = { width: 960, height: 720, getBoundingClientRect: () => ({ left: 10, top: 20, width: 480, height: 360 }) };
  assert.deepEqual(canvasPixel(canvas, { clientX: 10, clientY: 20 }), [0, 0]);
  assert.deepEqual(canvasPixel(canvas, { clientX: 250, clientY: 200 }), [480, 360]);
  assert.deepEqual(canvasPixel(canvas, { clientX: 9999, clientY: 9999 }), [959, 719]);
});

test('Draw & Guess: the plus swatch, picker and eyedropper draw in any color and guessers see it', async () => {
  const { r, views, drawer, guesser, st } = await startDraw();
  assert.equal(st.phase, 'draw');
  const el = drawer.v.el;
  const tools = el.querySelector('.draw-tools');
  const more = byKey(el, 'color-more');
  const drop = byKey(el, 'tool-drop');
  const fill = byKey(el, 'tool-fill');
  assert.ok(more && drop && fill);
  assert.equal(drop.parentNode, fill.parentNode, 'the eyedropper sits with the bucket');
  assert.equal(fill.parentNode.children.indexOf(drop), fill.parentNode.children.indexOf(fill) + 1);
  assert.match(drop.textContent, /💧/);
  const kids = tools.parentNode.children;
  assert.equal(kids[kids.indexOf(tools) - 1].classList.contains('flag-slot'), true, 'the flag slot stays right above the toolbar');
  more.click();
  const pop = byKey(el, 'color-pop');
  assert.equal(pop.classList.contains('is-open'), true);
  const sv = byKey(pop, 'color-sv');
  const hue = byKey(pop, 'color-hue');
  sv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  hue.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 10 });
  hue.dispatchEvent(pointer('pointerdown', 200, 5));
  hue.dispatchEvent(pointer('pointerup', 200, 5));
  sv.dispatchEvent(pointer('pointerdown', 80, 30));
  sv.dispatchEvent(pointer('pointerup', 80, 30));
  const hex = rgbHex(hsvToRgb(200, 0.8, 0.7));
  byKey(pop, 'color-use').click();
  assert.equal(pop.classList.contains('is-open'), false);
  assert.equal(byKey(el, 'recent-0').getAttribute('aria-pressed'), 'true');
  const canvas = canvasOf(drawer.v);
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  canvas.dispatchEvent(pointer('pointermove', 200, 100));
  assert.deepEqual(drawer.ctx.at(300, 200), rgbaOf(hex), 'the drawer paints in the custom color');
  await r.clock.advance(600);
  assert.deepEqual(guesser.ctx.at(300, 200), rgbaOf(hex), 'guessers see the live line in the custom color');
  canvas.dispatchEvent(pointer('pointerup', 200, 100));
  await r.clock.advance(1500);
  let ink = readInk(guesser.engine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 1);
  assert.equal(ink.strokes[0].c, CUSTOM);
  assert.equal(ink.strokes[0].rgb, hex);
  byKey(el, 'color-3').click();
  canvas.dispatchEvent(pointer('pointerdown', 50, 300));
  canvas.dispatchEvent(pointer('pointermove', 90, 300));
  canvas.dispatchEvent(pointer('pointerup', 90, 300));
  byKey(el, 'size-2').click();
  fill.click();
  assert.equal(fill.getAttribute('aria-pressed'), 'true');
  drop.click();
  assert.equal(drop.getAttribute('aria-pressed'), 'true');
  assert.equal(fill.getAttribute('aria-pressed'), 'false', 'the dropper takes over from the bucket');
  assert.equal(drawer.v.el.querySelector('.draw-board').classList.contains('is-dropping'), true);
  canvas.dispatchEvent(pointer('pointerdown', 150, 100));
  canvas.dispatchEvent(pointer('pointerup', 150, 100));
  assert.equal(drop.getAttribute('aria-pressed'), 'false', 'after a pick it goes back to the pen');
  assert.equal(fill.getAttribute('aria-pressed'), 'false');
  assert.equal(byKey(el, 'size-2').getAttribute('aria-pressed'), 'true');
  assert.equal(byKey(el, 'recent-0').getAttribute('aria-pressed'), 'true', 'the picked color is the custom one');
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 2, 'picking a color sends nothing');
  drop.click();
  canvas.dispatchEvent(pointer('pointerdown', 70, 300));
  assert.equal(byKey(el, 'color-3').getAttribute('aria-pressed'), 'true', 'an exact palette pixel snaps to its swatch');
  drop.click();
  canvas.dispatchEvent(pointer('pointerdown', 400, 20));
  assert.equal(byKey(el, 'eraser').getAttribute('aria-pressed'), 'true', 'blank paper picks up the eraser white');
  drawer.ctx.data.set([1, 2, 3, 255], (10 * W + 10) * 4);
  drop.click();
  canvas.dispatchEvent(pointer('pointerdown', 5, 5));
  assert.equal(byKey(el, 'recent-0').dataset.rgb, '#010203');
  assert.equal(byKey(el, 'recent-1').dataset.rgb, hex);
  fill.click();
  canvas.dispatchEvent(pointer('pointerdown', 400, 300));
  await r.clock.advance(1500);
  ink = readInk(guesser.engine.snapshot().state, st.nonce);
  assert.deepEqual(ink.strokes.at(-1), { c: CUSTOM, rgb: '#010203', z: FILL, pts: [[400, 300]] });
  assert.deepEqual(guesser.ctx.at(900, 700), [1, 2, 3, 255]);
  assert.equal(byKey(guesser.v.el, 'tool-drop').closest('.draw-board').classList.contains('is-drawing'), false, 'guessers have no tools');
  assert.ok(draw.writer((k) => (k === 'draw' ? r.engines[0].snapshot().state.draw : null), inkKey(0), st.drawer, r.engines[0].snapshot().state[inkKey(0)]));
  noInlineStyles(el);
  for (const x of views) x.v.destroy();
});

test('Draw & Guess: guessers can still flag a drawing made with custom colors', async () => {
  const sent = [];
  resetAdmins();
  configureAdmins({ fetch: async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 201, json: async () => ({ ok: true }) };
  }, refreshMs: 0, win: null });
  const { r, views, drawer, guesser, st, toasts } = await startDraw(3);
  byKey(drawer.v.el, 'color-more').click();
  const sv = byKey(drawer.v.el, 'color-sv');
  sv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  sv.dispatchEvent(pointer('pointerdown', 70, 40));
  byKey(drawer.v.el, 'color-use').click();
  const canvas = canvasOf(drawer.v);
  canvas.dispatchEvent(pointer('pointerdown', 10, 10));
  canvas.dispatchEvent(pointer('pointermove', 60, 60));
  canvas.dispatchEvent(pointer('pointerup', 60, 60));
  await r.clock.advance(1500);
  guesser.v.update(guesser.engine.snapshot());
  const flag = byKey(guesser.v.el, 'flag');
  assert.ok(flag, 'the flag button is still under the canvas');
  assert.equal(byKey(drawer.v.el, 'flag'), null);
  const strokes = readInk(guesser.engine.snapshot().state, st.nonce).strokes;
  assert.ok(strokes.length >= 1);
  assert.equal(strokes[0].c, CUSTOM);
  flag.click();
  await pickIn('cheating');
  assert.ok(toasts.includes(FLAG_THANKS));
  await r.clock.advance(400);
  const again = byKey(guesser.v.el, 'flag');
  assert.ok(!again || again.getAttribute('aria-pressed') === 'true', 'the flag sticks');
  await new Promise((done) => setImmediate(done));
  const report = sent.find((x) => x.body && Array.isArray(x.body.ink));
  assert.ok(report, 'the report went out');
  assert.ok(report.body.ink.some((t) => decodeStroke(t) && decodeStroke(t).c === CUSTOM), 'the report keeps the custom colored ink');
  for (const x of views) x.v.destroy();
  resetAdmins();
});

test('Draw Telephone: custom colors and the eyedropper work and are saved with the page', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  clearStorage();
  const ctxs = fakeCanvases();
  const r = await startTelephone();
  const s = r.engines[0].snapshot().state[TEL_KEY];
  assert.equal(s.phase, 'draw');
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const engine = bySlot(r, s.seats[1]);
  const v = createTelephoneView({ engine, fx: { confetti() {} }, toast() {}, win, cues: { play() {}, burst() {}, float() {} } });
  engine.on('change', (snap) => v.update(snap));
  v.update(engine.snapshot());
  const ctx = ctxs[0];
  const more = byKey(v.el, 'color-more');
  const drop = byKey(v.el, 'tool-drop');
  assert.ok(more && drop);
  const row = drop.parentNode.children;
  assert.equal(row[row.indexOf(drop) - 1], byKey(v.el, 'tool-fill'));
  ctx.data.set([200, 100, 50, 255], (4 * W + 4) * 4);
  drop.click();
  canvasOf(v).dispatchEvent(pointer('pointerdown', 2, 2));
  assert.equal(drop.getAttribute('aria-pressed'), 'false');
  assert.equal(byKey(v.el, 'recent-0').dataset.rgb, '#c86432');
  byKey(v.el, 'tool-fill').click();
  canvasOf(v).dispatchEvent(pointer('pointerdown', 240, 180));
  assert.deepEqual(ctx.at(500, 400), [200, 100, 50, 255]);
  await r.clock.advance(1000);
  let saved = r.hub.state[telKey(1)];
  assert.equal(validInk(saved, s.k), true);
  assert.deepEqual(saved.s, [encodeStroke({ c: CUSTOM, rgb: '#c86432', z: FILL, pts: [[240, 180]] })]);
  assert.equal(inkChars(saved.s), CUSTOM_FILL_CHARS, 'a custom fill costs its four extra characters');
  byKey(v.el, 'size-1').click();
  canvasOf(v).dispatchEvent(pointer('pointerdown', 20, 20));
  canvasOf(v).dispatchEvent(pointer('pointermove', 80, 40));
  canvasOf(v).dispatchEvent(pointer('pointerup', 80, 40));
  await r.clock.advance(1000);
  saved = r.hub.state[telKey(1)];
  assert.equal(saved.s.length, 2);
  assert.equal(decodeStroke(saved.s[1]).rgb, '#c86432');
  assert.equal(inkChars(saved.s), CUSTOM_FILL_CHARS + encodeStroke({ c: 1, z: 1, pts: decodeStroke(saved.s[1]).pts }).length + RGB_CHARS);
  assert.equal(telephone.writer((k) => (k === TEL_KEY ? s : null), telKey(1), s.seats[1], saved), true, 'the host takes the custom ink');
  assert.equal(telephone.writer((k) => (k === TEL_KEY ? s : null), telKey(1), s.seats[0], saved), false);
  noInlineStyles(v.el);
  v.destroy();
});

test('the telephone page budget counts custom color characters and never refuses a line', () => {
  const stroke = { c: CUSTOM, rgb: '#abcdef', z: 1, pts: [[0, 0], [10, 10]] };
  const plain = { c: 1, z: 1, pts: [[0, 0], [10, 10]] };
  const budget = seatBudget(MAX_SEATS);
  const a = fitSeat([stroke], 3, 0, budget);
  const b = fitSeat([plain], 3, 0, budget);
  assert.equal(inkChars(a.pieces.flat()), inkChars(b.pieces.flat()) + RGB_CHARS);
  const many = [];
  for (let i = 0; i < 900; i += 1) many.push({ c: CUSTOM, rgb: '#010101', z: FILL, pts: [[i % 480, 7]] });
  const fit = fitSeat(many, 3, 0, budget);
  assert.ok(fit.bytes <= budget, `${fit.bytes} bytes`);
  assert.ok(fit.strokes.length > 0 && fit.strokes.length < many.length, 'an absurd page quietly keeps what fits');
  assert.deepEqual(fit.strokes[fit.strokes.length - 1], many[many.length - 1], 'the newest fill always lands');
  for (const s of fit.pieces) assert.ok(validInk({ k: 3, g: G_MAX, s }, 3));
  const huge = [];
  while (huge.join('').length < SEAT_CHUNK_BYTES) huge.push(encodeStroke({ c: CUSTOM, rgb: '#020202', z: FILL, pts: [[1, 1]] }));
  assert.equal(validInk({ k: 3, s: huge }, 3), false, 'one value can never pass the per key limit');
  assert.equal(validInk({ k: 3, s: ['MAAAAEAoAo'] }, 3), true);
  assert.equal(validInk({ k: 3, s: ['MAAAAEAoA'] }, 3), false);
  assert.equal(validInk({ k: 3, g: -1, s: ['MAAAAEAoAo'] }, 3), false);
});

function customOps() {
  const ops = [];
  const tints = ['#3a6ea5', '#3b6fa6', '#c0ffee', '#101010', '#ff8800', '#fe8801', '#7f7f80', '#00a0a0'];
  for (let i = 0; i < 24; i += 1) {
    const rgb = tints[i % tints.length];
    if (i % 4 === 3) {
      ops.push({ c: CUSTOM, rgb, z: FILL, pts: [[(i * 53) % 470 + 5, (i * 37) % 350 + 5]] });
      continue;
    }
    const pts = ring(60 + ((i * 71) % 360), 60 + ((i * 43) % 240), 20 + (i % 5) * 9);
    ops.push(i % 3 === 0 ? { c: i % COLORS.length, z: i % SIZES.length, pts } : { c: CUSTOM, rgb, z: i % SIZES.length, pts });
  }
  ops.push({ c: 5, z: FILL, pts: [[2, 2]] });
  ops.push({ c: CUSTOM, rgb: '#3a6ea6', z: FILL, pts: [[478, 358]] });
  return ops;
}

function fresh(ops) {
  const ctx = new RasterCtx();
  paintInk(ctx, ops, 2);
  return ctx.data;
}

test('custom color strokes and fills replay to the same pixels on every client, every time', () => {
  const ops = customOps();
  const wire = ops.map(encodeStroke);
  const decoded = wire.map(decodeStroke);
  assert.deepEqual(decoded, ops, 'the ops survive the wire exactly');
  const reference = fresh(decoded);
  assert.ok(same(fresh(decoded), reference), 'two late joiners agree');
  assert.ok(same(fresh(wire.map(decodeStroke)), reference), 'a second replay from the wire agrees');
  const ctx = new RasterCtx();
  const painter = createPainter(2);
  for (let i = 1; i <= decoded.length; i += 1) painter.paint(ctx, decoded.slice(0, i));
  assert.ok(same(ctx.data, reference), 'watching live matches a fresh replay');
  painter.paint(ctx, decoded.slice(0, 10));
  assert.ok(same(ctx.data, fresh(decoded.slice(0, 10))), 'undo through custom fills matches');
  painter.paint(ctx, decoded);
  assert.ok(same(ctx.data, reference));
  const swapped = decoded.map((s) => (s.c === CUSTOM && s.rgb === '#3b6fa6' ? { ...s, rgb: '#3b6fa7' } : s));
  const other = new RasterCtx();
  painter.paint(other, swapped);
  assert.ok(!same(other.data, reference), 'a different custom color is a different snapshot, never a stale one');
  const moved = {};
  for (const ch of pack(wire, 4)) moved[inkKey(ch.i)] = ch;
  const rehosted = readInk(moved, 4).strokes;
  assert.deepEqual(rehosted, ops);
  assert.ok(same(fresh(rehosted), reference), 'a new host repacking the ops paints the same picture');
});

test('fill regions use one rule everywhere: within the tolerance of the tapped pixel on every channel', () => {
  assert.equal(sameRegion([10, 10, 10, 255], [10 + FILL_TOLERANCE, 10, 10 - FILL_TOLERANCE, 255]), true);
  assert.equal(sameRegion([10, 10, 10, 255], [11 + FILL_TOLERANCE, 10, 10, 255]), false);
  assert.equal(sameRegion([10, 10, 10], [10, 10, 10, 255]), true);
  const w = 90;
  const h = 30;
  const base = [100, 120, 140];
  const near = [100 + FILL_TOLERANCE, 120 - 7, 140];
  const far = [100 + 2 * FILL_TOLERANCE, 120, 140];
  const page = () => {
    const d = buffer(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const rgb = x < 30 ? base : x < 60 ? near : far;
        const i = (y * w + x) * 4;
        d[i] = rgb[0];
        d[i + 1] = rgb[1];
        d[i + 2] = rgb[2];
      }
    }
    return d;
  };
  const a = page();
  const b = page();
  floodFill(a, w, h, 5, 5, [250, 0, 0, 255]);
  floodFill(b, w, h, 5, 5, [250, 0, 0, 255]);
  assert.ok(same(a, b), 'the same fill on the same page gives the same pixels');
  for (let x = 0; x < w; x += 1) {
    const got = px(a, w, x, 15);
    const want = sameRegion([...page().subarray((15 * w + x) * 4, (15 * w + x) * 4 + 4)], [...base, 255]);
    if (want) assert.deepEqual(got, [250, 0, 0, 255], `x ${x} is in the region`);
    else assert.notDeepEqual(got, [250, 0, 0, 255], `x ${x} is out of the region`);
  }
  assert.deepEqual(px(a, w, 45, 15), [250, 0, 0, 255], 'a custom color within tolerance is the same region');
  assert.deepEqual(px(a, w, 80, 15), [...far, 255], 'one past the tolerance never leaks, even though it is close to the middle band');
  const c = page();
  floodFill(c, w, h, 45, 5, [0, 0, 250, 255]);
  assert.deepEqual(px(c, w, 5, 15), [0, 0, 250, 255]);
  assert.deepEqual(px(c, w, 80, 15), [0, 0, 250, 255], 'regions are measured from the tapped pixel, so the middle reaches both sides');
  const ctx = new RasterCtx();
  const ops = [
    { c: CUSTOM, rgb: '#4060a0', z: FILL, pts: [[1, 1]] },
    { c: CUSTOM, rgb: '#4462a4', z: 0, pts: ring(240, 180, 80) },
    { c: CUSTOM, rgb: '#e0e0e0', z: FILL, pts: [[240, 180]] },
  ];
  paintInk(ctx, ops, 2);
  assert.deepEqual(ctx.at(10, 10), rgbaOf('#e0e0e0'), 'a ring within tolerance of its background does not hold a fill back');
  const ctx2 = new RasterCtx();
  const held = [ops[0], { ...ops[1], rgb: '#4060ff' }, ops[2]];
  paintInk(ctx2, held, 2);
  assert.deepEqual(ctx2.at(10, 10), rgbaOf('#4060a0'), 'a ring past the tolerance holds it back');
  assert.deepEqual(ctx2.at(480, 360), rgbaOf('#e0e0e0'));
  const ctx3 = new RasterCtx();
  paintInk(ctx3, held, 2);
  assert.ok(same(ctx2.data, ctx3.data));
  const noop = new RasterCtx();
  paintInk(noop, [{ c: CUSTOM, rgb: '#fefefe', z: FILL, pts: [[5, 5]] }], 2);
  assert.deepEqual(noop.at(0, 0), [254, 254, 254, 255], 'a near white custom fill still paints, the same on every client');
});

test('Odd One Out keeps its fixed player colors with no picker or eyedropper', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  fakeCanvases();
  const r = room(3, { games: [odd], seed: 11 });
  await r.clock.advance(500);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout };
  const views = r.engines.map((engine) => {
    const v = createOddView({ engine, fx: { confetti() {} }, toast() {}, win, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  r.engines[0].lobby.pick('odd');
  r.engines[0].lobby.start();
  await r.clock.advance(400 + INTRO_MS);
  for (const v of views) {
    assert.equal(byKey(v.el, 'color-more'), null);
    assert.equal(byKey(v.el, 'tool-drop'), null);
    assert.equal(v.el.querySelector('.color-pop'), null);
    v.destroy();
  }
  const src = readFileSync(new URL('js/games/odd.js', ROOT), 'utf8') + readFileSync(new URL('js/views/odd.js', ROOT), 'utf8');
  assert.equal(/palette\.js|CUSTOM|tintOf/.test(src), false);
});

test('the color code has no comments, inline styles or outside resources and fits a narrow sidebar', () => {
  for (const f of ['js/views/palette.js', 'js/games/ink.js', 'js/views/draw.js', 'js/views/telephone.js', 'css/games.css']) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, `${f} has a block comment`);
    assert.equal(/(^|[^:'"`])\/\/(?![^\n]*['"`])/m.test(src), false, `${f} has a line comment`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, f);
    assert.equal(/https?:\/\//.test(src), false, f);
    assert.equal(/type\s*[:=]\s*['"]color['"]/.test(src), false, `${f} uses the native color input`);
    assert.equal(/\b(AI|Claude|Anthropic)\b/.test(src), false, f);
  }
  const css = readFileSync(new URL('css/games.css', ROOT), 'utf8');
  for (const sel of ['.color-pop', '.color-pop.is-open', '.color-sv', '.color-hue', '.color-knob', '.swatch-more', '.tool-drop.is-on', '.swatch.is-custom']) assert.ok(css.includes(`${sel} {`) || css.includes(`${sel},`), sel);
  assert.match(css, /\.color-sv,\s*\.color-hue\s*\{[^}]*touch-action: none/);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.color-pop\s*\{[^}]*position: static/);
  assert.match(css, /\.swatches\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.sizes,\s*\.tool-actions\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.color-pop\s*\{[^}]*width: min\(280px/);
});
