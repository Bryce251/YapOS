import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import {
  GRID_W,
  GRID_H,
  COLORS,
  FILL,
  FILL_CHARS,
  SIZES,
  encodeStroke,
  decodeStroke,
  encodeParts,
  fitInk,
  readInk,
  pack,
  inkKey,
  isFill,
  floodFill,
  rgbaOf,
  applyLive,
  liveMessage,
  createPainter,
  fillOn,
  paintInk,
  FILL_TOLERANCE,
} from '../web/activity/js/games/ink.js';
import draw from '../web/activity/js/games/draw.js';
import odd, { KEY as ODD_KEY, INTRO_MS, fitStroke as oddFit } from '../web/activity/js/games/odd.js';
import telephone, { KEY as TEL_KEY, MAX_SEATS, inkKey as telKey, validInk, inkChars } from '../web/activity/js/games/telephone.js';
import { seatBudget } from '../web/activity/js/games/ink.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { createOddView } from '../web/activity/js/views/odd.js';
import { createTelephoneView } from '../web/activity/js/views/telephone.js';

const ROOT = new URL('../web/activity/', import.meta.url);
const W = GRID_W * 2;
const H = GRID_H * 2;

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

function set(d, w, x, y, rgb) {
  const i = (y * w + x) * 4;
  d[i] = rgb[0];
  d[i + 1] = rgb[1];
  d[i + 2] = rgb[2];
  d[i + 3] = 255;
}

function square(d, w, x0, y0, x1, y1, rgb = [0, 0, 0], thick = 2) {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const edge = x < x0 + thick || x > x1 - thick || y < y0 + thick || y > y1 - thick;
      if (edge) set(d, w, x, y, rgb);
    }
  }
}

class FakeCtx {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.data = buffer(w, h);
    this.calls = [];
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
  }

  count(name) {
    return this.calls.filter((c) => c === name).length;
  }

  fillRect(x, y, w, h) {
    this.calls.push('fillRect');
    const [r, g, b] = rgbaOf(this.fillStyle);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx += 1) set(this.data, this.w, xx, yy, [r, g, b]);
    }
  }

  getImageData(x, y, w, h) {
    this.calls.push('getImageData');
    assert.equal(x, 0);
    assert.equal(y, 0);
    return { width: w, height: h, data: this.data.slice() };
  }

  putImageData(img) {
    this.calls.push('putImageData');
    this.data.set(img.data);
  }

  beginPath() {}
  moveTo() {}
  lineTo() {
    this.calls.push('lineTo');
  }
  stroke() {
    this.calls.push('stroke');
  }
  arc() {}
  fill() {}

  at(x, y) {
    return px(this.data, this.w, x, y);
  }
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

function pointer(type, x, y) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  return e;
}

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function fakeCanvases() {
  const made = [];
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') {
      const ctx = new FakeCtx();
      made.push(ctx);
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

test('a flood fill paints inside a closed shape and nothing outside it', () => {
  const w = 100;
  const h = 100;
  const d = buffer(w, h);
  square(d, w, 20, 20, 80, 80);
  const n = floodFill(d, w, h, 50, 50, [255, 0, 0, 255]);
  assert.equal(n, 57 * 57);
  assert.deepEqual(px(d, w, 50, 50), [255, 0, 0, 255]);
  assert.deepEqual(px(d, w, 22, 22), [255, 0, 0, 255]);
  assert.deepEqual(px(d, w, 78, 78), [255, 0, 0, 255]);
  assert.deepEqual(px(d, w, 20, 50), [0, 0, 0, 255], 'the outline stays');
  assert.deepEqual(px(d, w, 5, 5), [255, 255, 255, 255], 'outside stays white');
  assert.deepEqual(px(d, w, 90, 50), [255, 255, 255, 255]);
  const out = floodFill(d, w, h, 5, 5, [0, 0, 255, 255]);
  assert.equal(out, w * h - 61 * 61);
  assert.deepEqual(px(d, w, 50, 50), [255, 0, 0, 255], 'the inside is untouched by an outside fill');
});

test('a gap in the outline lets the fill leak out, like real paint', () => {
  const w = 60;
  const h = 60;
  const d = buffer(w, h);
  square(d, w, 10, 10, 50, 50);
  set(d, w, 30, 10, [255, 255, 255]);
  set(d, w, 30, 11, [255, 255, 255]);
  floodFill(d, w, h, 30, 30, [0, 200, 0, 255]);
  assert.deepEqual(px(d, w, 2, 2), [0, 200, 0, 255]);
});

test('the colour tolerance soaks up near colours but stops at real edges', () => {
  const w = 40;
  const h = 40;
  const d = buffer(w, h);
  for (let x = 0; x < w; x += 1) set(d, w, x, 10, [235, 235, 235]);
  for (let x = 0; x < w; x += 1) set(d, w, x, 20, [120, 120, 120]);
  const loose = d.slice();
  floodFill(loose, w, h, 5, 5, [255, 0, 0, 255]);
  assert.deepEqual(px(loose, w, 5, 10), [255, 0, 0, 255], 'a slightly off white line is soaked up');
  assert.deepEqual(px(loose, w, 5, 15), [255, 0, 0, 255]);
  assert.deepEqual(px(loose, w, 5, 20), [120, 120, 120, 255], 'a real line stops it');
  assert.deepEqual(px(loose, w, 5, 30), [255, 255, 255, 255]);
  const strict = d.slice();
  floodFill(strict, w, h, 5, 5, [255, 0, 0, 255], 0);
  assert.notDeepEqual(px(strict, w, 5, 10).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(px(strict, w, 5, 15), [255, 255, 255, 255], 'with no tolerance the off white line is a wall');
});

test('filling inside an anti-aliased ring leaves no light halo against the line', () => {
  const w = 120;
  const h = 120;
  const d = buffer(w, h);
  const cov = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const r = Math.hypot(x + 0.5 - 60, y + 0.5 - 60);
      const c = Math.max(0, Math.min(1, 2.5 - Math.abs(r - 40)));
      cov.push(c);
      const v = Math.round(255 * (1 - c));
      set(d, w, x, y, [v, v, v]);
    }
  }
  const before = d.slice();
  const n = floodFill(d, w, h, 60, 60, [239, 68, 68, 255]);
  assert.ok(n > 4000);
  let checked = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const r = Math.hypot(x + 0.5 - 60, y + 0.5 - 60);
      const [pr, pg, pb] = px(d, w, x, y);
      if (r < 40) {
        assert.ok(pg <= 130 && pb <= 130, `pixel ${x},${y} at r=${r.toFixed(2)} is still light: ${pr},${pg},${pb}`);
        checked += 1;
      }
      if (r > 43) assert.deepEqual(px(d, w, x, y), [255, 255, 255, 255], 'outside the ring is untouched');
      if (cov[y * w + x] >= 0.5) assert.deepEqual(px(d, w, x, y), px(before, w, x, y), 'the line itself is untouched');
    }
  }
  assert.ok(checked > 4000);
  const grown = [];
  for (let i = 0; i < cov.length; i += 1) {
    const c = cov[i];
    const was = before[i * 4 + 1];
    if (c > 0 && c < 0.5 && was < 255 - 40 && Math.hypot((i % w) + 0.5 - 60, Math.floor(i / w) + 0.5 - 60) < 40) grown.push(i);
  }
  assert.ok(grown.length > 0, 'the test ring really has soft edge pixels outside the tolerance');
  for (const i of grown) assert.ok(d[i * 4] > d[i * 4 + 1] + 60, 'soft edge pixels take on the fill colour');
});

test('filling a pixel that is already that exact colour does nothing', () => {
  const d = buffer(30, 30, [239, 68, 68]);
  const copy = d.slice();
  assert.equal(floodFill(d, 30, 30, 4, 4, rgbaOf('#ef4444')), 0);
  assert.deepEqual(d, copy);
  assert.equal(floodFill(d, 30, 30, -1, 4, [0, 0, 0, 255]), 0);
  assert.equal(floodFill(d, 30, 30, 4, 30, [0, 0, 0, 255]), 0);
  assert.equal(floodFill(null, 30, 30, 4, 4, [0, 0, 0, 255]), 0);
  assert.equal(floodFill(d, 30, 30, 4, 4, [0, 0, 0, 255]), 900);
});

test('a fill over the whole full size canvas is fast', () => {
  const times = [];
  for (let run = 0; run < 3; run += 1) {
    const d = buffer(W, H);
    for (let k = 0; k < 40; k += 1) square(d, W, 10 + k * 22, 10 + (k % 7) * 90, 30 + k * 22, 60 + (k % 7) * 90);
    const t = performance.now();
    const n = floodFill(d, W, H, W - 2, H - 2, [59, 130, 246, 255]);
    times.push(performance.now() - t);
    assert.ok(n > W * H * 0.8);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[1] < 50, `median fill took ${times[1].toFixed(1)} ms`);
});

test('a fill is one tiny op that round trips, and old strokes decode exactly as before', () => {
  const fill = { c: 3, z: FILL, pts: [[120, 80]] };
  const text = encodeStroke(fill);
  assert.equal(text.length, FILL_CHARS);
  assert.deepEqual(decodeStroke(text), fill);
  assert.equal(isFill(decodeStroke(text)), true);
  assert.equal(encodeStroke({ c: 3, z: FILL, pts: [[120, 80], [130, 90]] }), text, 'a fill only keeps its first point');
  assert.deepEqual(encodeParts({ c: 3, z: FILL, pts: [[120, 80], [5, 5]] }), [text]);
  assert.equal(decodeStroke(`${text}gg`), null, 'a fill never carries extra points');
  assert.equal(decodeStroke('DFAKAU'), null, 'sizes past the fill marker stay invalid');
  assert.deepEqual(decodeStroke(encodeStroke({ c: 0, z: FILL, pts: [[GRID_W, GRID_H]] })), { c: 0, z: FILL, pts: [[GRID_W, GRID_H]] });
  assert.equal(encodeStroke({ c: 3, z: 1, pts: [[1, 1], [5, 5]] }), 'DBABABkk');
  assert.deepEqual(decodeStroke('DBABABkk'), { c: 3, z: 1, pts: [[1, 1], [5, 5]] });
  assert.deepEqual(decodeStroke('BAABAB'), { c: 1, z: 0, pts: [[1, 1]] });
  for (let z = 0; z < SIZES.length; z += 1) {
    const s = { c: 5, z, pts: [[10, 10], [40, 12], [400, 300], [0, 0]] };
    assert.deepEqual(decodeStroke(encodeStroke(s)), s);
    assert.equal(isFill(s), false);
  }
  const fit = fitInk([{ c: 1, z: 2, pts: [[10, 10], [100, 100]] }, fill], 42);
  const back = readInk({ [inkKey(0)]: fit.chunks[0] }, 42);
  assert.equal(back.strokes.length, 2);
  assert.deepEqual(back.strokes[1], fill);
});

test('live ops carry a fill and never grow it', () => {
  const live = new Map();
  const msg = liveMessage(9, 0, 0, [[50, 60]], { c: 6, z: FILL });
  assert.ok(msg.s.length <= 8);
  assert.equal(applyLive(live, msg), true);
  assert.deepEqual(live.get(0), { c: 6, z: FILL, pts: [[50, 60]] });
  const more = { t: 'ink', k: 9, si: 0, o: 1, s: encodeStroke({ c: 6, z: 1, pts: [[50, 60], [70, 80]] }) };
  assert.equal(applyLive(live, more), false);
  assert.deepEqual(live.get(0).pts, [[50, 60]]);
});

test('the painter replays fills in order and reuses its snapshots on a redraw', () => {
  const ctx = new FakeCtx();
  const painter = createPainter(2);
  const a = { c: 3, z: FILL, pts: [[10, 10]] };
  const line = { c: 1, z: 1, pts: [[0, 0], [20, 20]] };
  const b = { c: 8, z: FILL, pts: [[200, 200]] };
  painter.paint(ctx, [a, line, b]);
  assert.deepEqual(ctx.at(5, 5), [59, 130, 246, 255], 'the later fill covers the earlier one');
  assert.equal(ctx.count('getImageData'), 2);
  ctx.calls = [];
  painter.paint(ctx, [a, line, b]);
  assert.equal(ctx.count('getImageData'), 0, 'a redraw with the same ops reuses the snapshot');
  assert.equal(ctx.count('putImageData'), 1);
  assert.deepEqual(ctx.at(5, 5), [59, 130, 246, 255]);
  ctx.calls = [];
  painter.paint(ctx, [a, line]);
  assert.equal(ctx.count('getImageData'), 0, 'undoing the last fill falls back to the earlier snapshot');
  assert.equal(ctx.count('lineTo'), 1);
  assert.deepEqual(ctx.at(5, 5), [239, 68, 68, 255]);
  ctx.calls = [];
  painter.paint(ctx, []);
  assert.deepEqual(ctx.at(5, 5), [255, 255, 255, 255], 'clear wipes the fill');
  assert.equal(painter.size, 0);
  assert.equal(fillOn(ctx, { c: 0, z: FILL, pts: [[5, 5]] }, 2), 0, 'an eraser fill on white is a no-op');
  assert.equal(fillOn({}, a, 2), -1, 'a canvas that cannot be read reports unknown');
});

async function startDraw() {
  const r = room(2);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('draw'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const st = host.snapshot().state.draw;
  bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await r.clock.advance(400);
  return r;
}

test('Draw & Guess takes a fill from the drawer and refuses it from a guesser', async () => {
  const r = await startDraw();
  const st = r.engines[0].snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  const drawer = bySlot(r, st.drawer);
  const guesser = r.engines.find((e) => e !== drawer);
  const fill = encodeStroke({ c: 4, z: FILL, pts: [[100, 100]] });
  const [chunk] = pack([fill], st.nonce);
  assert.equal(draw.writer((k) => (k === 'draw' ? st : null), inkKey(0), guesser.snapshot().meSlot, chunk), false);
  assert.equal(draw.writer((k) => (k === 'draw' ? st : null), inkKey(0), st.drawer, chunk), true);
  assert.equal(guesser.direct(inkKey(0), chunk), false);
  assert.equal(drawer.direct(inkKey(0), chunk), true);
  await r.clock.advance(400);
  const ink = readInk(guesser.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 1);
  assert.equal(isFill(ink.strokes[0]), true);
});

test('Odd One Out counts one fill as the turn, in the player colour, only from the current player', async () => {
  const r = room(3, { games: [odd], seed: 11 });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('odd'), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300 + INTRO_MS);
  let s = host.snapshot().state[ODD_KEY];
  assert.equal(s.phase, 'draw');
  const cur = bySlot(r, s.turn);
  const other = r.engines.find((e) => e !== cur);
  other.act({ type: 'fill', n: s.n, x: 100, y: 100 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[ODD_KEY].n, s.n, 'the wrong player cannot fill');
  assert.equal(readInk(host.snapshot().state, s.k).strokes.length, 0);
  for (const bad of [{ x: -1, y: 5 }, { x: 5, y: GRID_H + 1 }, { x: 1.5, y: 2 }, { x: '3', y: 4 }, {}]) cur.act({ type: 'fill', n: s.n, ...bad });
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[ODD_KEY].n, s.n, 'bad points are refused');
  cur.act({ type: 'stroke', n: s.n, s: [encodeStroke({ c: 3, z: FILL, pts: [[9, 9]] })] });
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[ODD_KEY].n, s.n, 'a fill cannot sneak in as a line');
  cur.act({ type: 'fill', n: s.n, x: 100, y: 100, c: 0 });
  await r.clock.advance(400);
  const ink = readInk(host.snapshot().state, s.k);
  assert.equal(ink.strokes.length, 1);
  assert.deepEqual(ink.strokes[0], { c: s.cols[s.pos], z: FILL, pts: [[100, 100]] }, 'the host paints it in the player colour');
  const after = host.snapshot().state[ODD_KEY];
  assert.equal(after.marks.length, s.marks.length + 1);
  assert.equal(after.marks[after.marks.length - 1], s.turn);
  assert.notEqual(after.turn, s.turn, 'the turn moves on after one fill');
  cur.act({ type: 'fill', n: s.n, x: 200, y: 200 });
  cur.act({ type: 'fill', n: after.n, x: 200, y: 200 });
  await r.clock.advance(400);
  assert.equal(readInk(host.snapshot().state, s.k).strokes.length, 1, 'no second move');
  const line = oddFit([[10, 10], [60, 60]], 1, 1, after.cap);
  bySlot(r, after.turn).act({ type: 'stroke', n: after.n, s: line });
  await r.clock.advance(400);
  s = host.snapshot().state[ODD_KEY];
  assert.equal(readInk(host.snapshot().state, s.k).strokes.length, 2, 'lines still work after a fill');
});

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

test('Draw Telephone takes a fill on your own page only, for a tiny fixed bit of ink', async () => {
  const r = await startTelephone();
  const s = r.engines[0].snapshot().state[TEL_KEY];
  assert.equal(s.phase, 'draw');
  const fill = encodeStroke({ c: 0, z: FILL, pts: [[240, 180]] });
  const ink = { k: s.k, s: [fill] };
  assert.equal(validInk(ink, s.k), true);
  assert.equal(inkChars(ink.s), FILL_CHARS);
  assert.ok(FILL_CHARS / seatBudget(MAX_SEATS) < 0.01);
  const mine = bySlot(r, s.seats[1]);
  const theirs = bySlot(r, s.seats[0]);
  assert.equal(telephone.writer((k) => (k === TEL_KEY ? s : null), telKey(1), s.seats[0], ink), false);
  assert.equal(telephone.writer((k) => (k === TEL_KEY ? s : null), telKey(1), s.seats[1], ink), true);
  assert.equal(theirs.direct(telKey(1), ink), false);
  assert.equal(mine.direct(telKey(1), ink), true);
});

test('the Draw & Guess toolbar has a bucket that fills on tap and live previews it to guessers', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const ctxs = fakeCanvases();
  const r = room(2);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const views = r.engines.map((engine) => {
    const v = VIEWS.draw({ engine, fx: { confetti() {} }, toast() {}, win });
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
  const st = r.engines[0].snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  const tool = byKey(drawer.v.el, 'tool-fill');
  assert.ok(tool);
  assert.equal(tool.localName, 'button');
  assert.equal(tool.getAttribute('aria-pressed'), 'false');
  assert.match(tool.textContent, /🪣/);
  tool.click();
  assert.equal(tool.getAttribute('aria-pressed'), 'true');
  assert.equal(byKey(drawer.v.el, 'size-1').getAttribute('aria-pressed'), 'false');
  byKey(drawer.v.el, 'color-6').click();
  assert.equal(tool.getAttribute('aria-pressed'), 'true', 'picking a colour keeps the bucket');
  const canvas = canvasOf(drawer.v);
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  canvas.dispatchEvent(pointer('pointerup', 100, 100));
  assert.deepEqual(drawer.ctx.at(10, 10), [34, 197, 94, 255], 'the drawer sees the fill right away');
  await r.clock.advance(400);
  assert.deepEqual(guesser.ctx.at(600, 600), [34, 197, 94, 255], 'guessers see it live');
  await r.clock.advance(1500);
  let ink = readInk(guesser.engine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 1);
  assert.deepEqual(ink.strokes[0], { c: 6, z: FILL, pts: [[100, 100]] });
  canvas.dispatchEvent(pointer('pointerdown', 300, 300));
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 1, 'filling the same colour again sends nothing');
  byKey(drawer.v.el, 'eraser').click();
  canvas.dispatchEvent(pointer('pointerdown', 300, 300));
  await r.clock.advance(1500);
  ink = readInk(guesser.engine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 2);
  assert.deepEqual(ink.strokes[1], { c: 0, z: FILL, pts: [[300, 300]] });
  assert.deepEqual(drawer.ctx.at(10, 10), [255, 255, 255, 255], 'an eraser fill paints the background back');
  byKey(drawer.v.el, 'undo').click();
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 1, 'undo removes a fill');
  byKey(drawer.v.el, 'redo').click();
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 2, 'redo brings the fill back');
  byKey(drawer.v.el, 'undo').click();
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 1);
  assert.deepEqual(drawer.ctx.at(10, 10), [34, 197, 94, 255]);
  byKey(drawer.v.el, 'size-2').click();
  assert.equal(tool.getAttribute('aria-pressed'), 'false', 'tapping a pen size goes back to drawing');
  assert.equal(byKey(drawer.v.el, 'size-2').getAttribute('aria-pressed'), 'true');
  canvas.dispatchEvent(pointer('pointerdown', 20, 20));
  canvas.dispatchEvent(pointer('pointermove', 60, 60));
  canvas.dispatchEvent(pointer('pointerup', 60, 60));
  await r.clock.advance(1500);
  ink = readInk(guesser.engine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 2);
  assert.equal(isFill(ink.strokes[1]), false);
  byKey(drawer.v.el, 'clear').click();
  await r.clock.advance(1500);
  assert.equal(readInk(guesser.engine.snapshot().state, st.nonce).strokes.length, 0, 'clear wipes fills too');
  assert.deepEqual(guesser.ctx.at(600, 600), [255, 255, 255, 255]);
  noInlineStyles(drawer.v.el);
  for (const x of views) x.v.destroy();
});

test('the Odd One Out board has a pen and bucket, and a tap fills as the whole turn', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const ctxs = fakeCanvases();
  const r = room(3, { games: [odd], seed: 11 });
  await r.clock.advance(500);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout };
  const sent = r.engines.map(() => []);
  const views = r.engines.map((engine, i) => {
    const v = createOddView({ engine, fx: { confetti() {} }, toast() {}, win, cues: { play: (n) => sent[i].push(n), burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    return { v, engine, ctx: ctxs[ctxs.length - 1] };
  });
  const host = r.engines[0];
  host.lobby.pick('odd');
  host.lobby.start();
  for (const x of views) x.v.update(x.engine.snapshot());
  await r.clock.advance(400 + INTRO_MS);
  const s = host.snapshot().state[ODD_KEY];
  assert.equal(s.phase, 'draw');
  const me = views.find((x) => x.engine.snapshot().meSlot === s.turn);
  const other = views.find((x) => x !== me);
  const pen = byKey(me.v.el, 'tool-pen');
  const tool = byKey(me.v.el, 'tool-fill');
  assert.equal(pen.getAttribute('aria-pressed'), 'true');
  assert.equal(tool.getAttribute('aria-pressed'), 'false');
  assert.ok(me.v.el.querySelector('.odd-board [role="toolbar"]'));
  byKey(other.v.el, 'tool-fill').click();
  canvasOf(other.v).dispatchEvent(pointer('pointerdown', 50, 50));
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[ODD_KEY].n, s.n, 'only the current player can fill');
  tool.click();
  assert.equal(tool.getAttribute('aria-pressed'), 'true');
  assert.equal(pen.getAttribute('aria-pressed'), 'false');
  assert.match(me.v.el.textContent, /One fill only/);
  canvasOf(me.v).dispatchEvent(pointer('pointerdown', 50, 50));
  canvasOf(me.v).dispatchEvent(pointer('pointerup', 50, 50));
  const color = rgbaOf(COLORS[s.cols[s.pos]]);
  assert.deepEqual(me.ctx.at(4, 4), color);
  await r.clock.advance(600);
  const ink = readInk(host.snapshot().state, s.k);
  assert.equal(ink.strokes.length, 1);
  assert.deepEqual(ink.strokes[0], { c: s.cols[s.pos], z: FILL, pts: [[50, 50]] });
  assert.notEqual(host.snapshot().state[ODD_KEY].turn, s.turn);
  assert.deepEqual(other.ctx.at(900, 700), color, 'everyone replays the fill');
  pen.click();
  assert.equal(pen.getAttribute('aria-pressed'), 'true');
  noInlineStyles(me.v.el);
  for (const x of views) x.v.destroy();
});

test('the Draw Telephone toolbar has a bucket that fills on tap and saves a six character op', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
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
  const tool = byKey(v.el, 'tool-fill');
  assert.ok(tool);
  assert.equal(tool.getAttribute('aria-pressed'), 'false');
  tool.click();
  assert.equal(tool.getAttribute('aria-pressed'), 'true');
  byKey(v.el, 'color-3').click();
  canvasOf(v).dispatchEvent(pointer('pointerdown', 240, 180));
  assert.deepEqual(ctx.at(0, 0), [239, 68, 68, 255]);
  await r.clock.advance(1000);
  const saved = r.hub.state[telKey(1)];
  assert.equal(validInk(saved, s.k), true);
  assert.deepEqual(saved.s, [encodeStroke({ c: 3, z: FILL, pts: [[240, 180]] })]);
  assert.equal(inkChars(saved.s), FILL_CHARS);
  canvasOf(v).dispatchEvent(pointer('pointerdown', 10, 10));
  await r.clock.advance(1000);
  assert.equal(r.hub.state[telKey(1)].s.length, 1, 'the same colour again sends nothing');
  byKey(v.el, 'undo').click();
  await r.clock.advance(1000);
  assert.equal(r.hub.state[telKey(1)] ?? null, null, 'undoing the only fill empties the page');
  assert.deepEqual(ctx.at(0, 0), [255, 255, 255, 255]);
  byKey(v.el, 'size-0').click();
  assert.equal(tool.getAttribute('aria-pressed'), 'false');
  noInlineStyles(v.el);
  v.destroy();
});

test('the fill code has no comments, inline styles or outside resources', () => {
  for (const f of ['js/games/ink.js', 'js/games/odd.js', 'js/views/draw.js', 'js/views/odd.js', 'js/views/telephone.js', 'css/games.css', 'css/odd.css']) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, `${f} has a block comment`);
    assert.equal(/(^|[^:'"`])\/\/(?![^\n]*['"`])/m.test(src), false, `${f} has a line comment`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, f);
    assert.equal(/https?:\/\//.test(src), false, f);
  }
  const css = readFileSync(new URL('css/games.css', ROOT), 'utf8');
  assert.match(css, /\.tool-fill/);
});

class RasterCtx {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.data = buffer(w, h);
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.path = [];
    this.arcs = [];
  }

  fillRect(x, y, w, h) {
    const [r, g, b] = rgbaOf(this.fillStyle);
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx += 1) set(this.data, this.w, xx, yy, [r, g, b]);
    }
  }

  getImageData() {
    return { width: this.w, height: this.h, data: this.data.slice() };
  }

  putImageData(img) {
    this.data.set(img.data);
  }

  beginPath() {
    this.path = [];
    this.arcs = [];
  }

  moveTo(x, y) {
    this.path.push([x, y]);
  }

  lineTo(x, y) {
    this.path.push([x, y]);
  }

  arc(x, y, r) {
    this.arcs.push([x, y, r]);
  }

  cover(segs, rad, rgb) {
    const pad = rad + 2;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [a, b] of segs) {
      x0 = Math.min(x0, a[0], b[0]);
      y0 = Math.min(y0, a[1], b[1]);
      x1 = Math.max(x1, a[0], b[0]);
      y1 = Math.max(y1, a[1], b[1]);
    }
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(this.w - 1, Math.ceil(x1 + pad));
    y1 = Math.min(this.h - 1, Math.ceil(y1 + pad));
    const bw = x1 - x0 + 1;
    const dist = new Float32Array(bw * (y1 - y0 + 1)).fill(Infinity);
    for (const [a, b] of segs) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = dx * dx + dy * dy;
      const sx0 = Math.max(x0, Math.floor(Math.min(a[0], b[0]) - pad));
      const sx1 = Math.min(x1, Math.ceil(Math.max(a[0], b[0]) + pad));
      const sy0 = Math.max(y0, Math.floor(Math.min(a[1], b[1]) - pad));
      const sy1 = Math.min(y1, Math.ceil(Math.max(a[1], b[1]) + pad));
      for (let y = sy0; y <= sy1; y += 1) {
        for (let x = sx0; x <= sx1; x += 1) {
          const qx = x + 0.5 - a[0];
          const qy = y + 0.5 - a[1];
          const t = len ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / len)) : 0;
          const d = Math.hypot(qx - t * dx, qy - t * dy);
          const k = (y - y0) * bw + (x - x0);
          if (d < dist[k]) dist[k] = d;
        }
      }
    }
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const al = Math.max(0, Math.min(1, rad + 0.5 - dist[(y - y0) * bw + (x - x0)]));
        if (!al) continue;
        const i = (y * this.w + x) * 4;
        for (let c = 0; c < 3; c += 1) this.data[i + c] = Math.round(this.data[i + c] * (1 - al) + rgb[c] * al);
      }
    }
  }

  stroke() {
    const segs = [];
    for (let i = 1; i < this.path.length; i += 1) segs.push([this.path[i - 1], this.path[i]]);
    if (segs.length) this.cover(segs, this.lineWidth / 2, rgbaOf(this.strokeStyle));
  }

  fill() {
    for (const [x, y, r] of this.arcs) this.cover([[[x, y], [x, y]]], r, rgbaOf(this.fillStyle));
  }
}

function ring(cx, cy, r, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => [Math.round(cx + r * Math.cos((i / n) * 2 * Math.PI)), Math.round(cy + r * Math.sin((i / n) * 2 * Math.PI))]);
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mixedOps(count = 50, seed = 7) {
  const rnd = seeded(seed);
  const ops = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 5 === 4) {
      ops.push({ c: Math.floor(rnd() * COLORS.length), z: FILL, pts: [[Math.floor(rnd() * GRID_W), Math.floor(rnd() * GRID_H)]] });
    } else if (i % 3 === 0) {
      ops.push({ c: 1 + Math.floor(rnd() * (COLORS.length - 1)), z: Math.floor(rnd() * SIZES.length), pts: ring(40 + rnd() * 400, 40 + rnd() * 280, 15 + rnd() * 50, 12 + Math.floor(rnd() * 12)) });
    } else {
      const pts = [];
      let x = rnd() * GRID_W;
      let y = rnd() * GRID_H;
      for (let k = 0; k < 8; k += 1) {
        x = Math.max(0, Math.min(GRID_W, x + (rnd() - 0.5) * 120));
        y = Math.max(0, Math.min(GRID_H, y + (rnd() - 0.5) * 120));
        pts.push([x, y]);
      }
      ops.push({ c: Math.floor(rnd() * COLORS.length), z: Math.floor(rnd() * SIZES.length), pts });
    }
  }
  const wire = fitInk(ops, 5);
  const state = {};
  for (const ch of wire.chunks) state[inkKey(ch.i)] = ch;
  return readInk(state, 5).strokes;
}

function fresh(list) {
  const ctx = new RasterCtx();
  paintInk(ctx, list, 2);
  return ctx.data;
}

function same(a, b) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

test('every client paints the same picture from the same ops, whatever order they redrew in', () => {
  const ops = mixedOps();
  assert.equal(ops.filter(isFill).length, 10);
  assert.ok(ops.length >= 50);
  const reference = fresh(ops);
  assert.ok(same(fresh(ops), reference), 'two late joiners replaying the whole list agree');
  const ctx = new RasterCtx();
  const painter = createPainter(2);
  for (let i = 1; i <= ops.length; i += 1) painter.paint(ctx, ops.slice(0, i));
  assert.ok(same(ctx.data, reference), 'a player who watched every op arrive live matches a late joiner');
  const cut = ops.length - 7;
  painter.paint(ctx, ops.slice(0, cut));
  assert.ok(same(ctx.data, fresh(ops.slice(0, cut))), 'undo through a fill matches a fresh replay of the shorter list');
  painter.paint(ctx, ops);
  assert.ok(same(ctx.data, reference), 'redoing gets back to the same picture');
  const moved = {};
  for (const ch of pack(ops.map(encodeStroke), 6)) moved[inkKey(ch.i)] = ch;
  const rehosted = readInk(moved, 6).strokes;
  assert.deepEqual(rehosted, ops, 'a new host repacking the same ops keeps them exactly');
  const other = new RasterCtx();
  createPainter(2).paint(other, rehosted);
  assert.ok(same(other.data, reference), 'a client after a host change matches too');
  painter.paint(ctx, []);
  assert.ok(same(ctx.data, buffer(W, H)), 'clear goes back to a blank page');
});

test('the tolerance never lets a fill run through a line in the nearest palette colour', () => {
  let closest = 255;
  for (let i = 0; i < COLORS.length; i += 1) {
    for (let j = i + 1; j < COLORS.length; j += 1) {
      const a = rgbaOf(COLORS[i]);
      const b = rgbaOf(COLORS[j]);
      closest = Math.min(closest, Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] - b[k]))));
    }
  }
  assert.ok(FILL_TOLERANCE < closest, `tolerance ${FILL_TOLERANCE} must stay under the closest colour gap ${closest}`);
  for (const [ground, line] of [[4, 3], [3, 4], [8, 9], [6, 7]]) {
    const ctx = new RasterCtx();
    paintInk(ctx, [{ c: ground, z: FILL, pts: [[5, 5]] }, { c: line, z: 0, pts: ring(240, 180, 80) }, { c: 2, z: FILL, pts: [[5, 5]] }], 2);
    assert.deepEqual(px(ctx.data, W, 480, 360), rgbaOf(COLORS[ground]), `a fine ${COLORS[line]} ring holds back a fill on ${COLORS[ground]}`);
    assert.deepEqual(px(ctx.data, W, 10, 10), rgbaOf(COLORS[2]));
  }
});

test('real brush rings at every size and colour leave no halo and no leak', () => {
  const fillRgb = rgbaOf(COLORS[8]);
  for (let z = 0; z < SIZES.length; z += 1) {
    for (const lc of [1, 2, 5, 10]) {
      const ctx = new RasterCtx();
      paintInk(ctx, [{ c: lc, z, pts: ring(240, 180, 60, 17) }, { c: 8, z: FILL, pts: [[240, 180]] }], 2);
      const line = rgbaOf(COLORS[lc]);
      let halo = 0;
      let leak = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const r = Math.hypot(x + 0.5 - 480, y + 0.5 - 360);
          const p = px(ctx.data, W, x, y);
          if (r > 150) {
            if (p[0] !== 255 || p[1] !== 255 || p[2] !== 255) leak += 1;
            continue;
          }
          if (r > 120 - SIZES[z] - 3) continue;
          const toFill = Math.hypot(p[0] - fillRgb[0], p[1] - fillRgb[1], p[2] - fillRgb[2]);
          const toLine = Math.hypot(p[0] - line[0], p[1] - line[1], p[2] - line[2]);
          const toWhite = Math.hypot(p[0] - 255, p[1] - 255, p[2] - 255);
          if (toWhite < toFill && toWhite < toLine) halo += 1;
        }
      }
      assert.equal(leak, 0, `size ${z} colour ${lc} leaked ${leak} pixels`);
      assert.equal(halo, 0, `size ${z} colour ${lc} left ${halo} light pixels inside the ring`);
    }
  }
});

test('a redraw of about 40 strokes and 10 fills on the full canvas stays quick', () => {
  const ops = mixedOps();
  const ctx = new FakeCtx();
  const painter = createPainter(2);
  let t = performance.now();
  painter.paint(ctx, ops);
  const cold = performance.now() - t;
  assert.equal(ctx.count('getImageData'), 10);
  ctx.calls = [];
  t = performance.now();
  painter.paint(ctx, ops);
  painter.paint(ctx, ops.concat([{ c: 1, z: 1, pts: [[1, 1], [9, 9]] }]));
  const warm = (performance.now() - t) / 2;
  assert.equal(ctx.count('getImageData'), 0, 'redraws after the cold one reuse the last fill');
  assert.ok(cold < 500, `a cold replay with ten fills took ${cold.toFixed(1)} ms`);
  assert.ok(warm < 50, `a warm redraw took ${warm.toFixed(1)} ms`);
});
