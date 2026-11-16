import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import pixel, { KEY, PREFIX, COUNTS, SIZE, CELLS, BANDS, BAND_CELLS, MAX_BATCH, PALETTE, THEMES, CHEER_MS, SHOW_MS, PAINT_POINT, PAINT_CAP, CHEER_POINTS, MIN_CELLS, bandKey, encodeCells, decodeCells, readGrid, filled, award, buildDeck, drawingId, minutes } from '../web/activity/js/games/pixel.js';
import { createPixelView, footText, pixelMoment, cellFromPoint, lineCells, PAINT_MS } from '../web/activity/js/views/pixel.js';
import { jsonBytes, MAX_VALUE_BYTES, OPS_MAX } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r) {
  return r.hub.state[KEY];
}

function grid(r) {
  return readGrid((k) => r.hub.state[k]);
}

async function startGame(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [pixel], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('pixel'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function paint(e, cells) {
  const s = e.snapshot().state[KEY];
  return e.act({ type: 'paint', n: s.n, c: encodeCells(cells) });
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

test('the canvas, palette and themes fit the plan', () => {
  assert.equal(SIZE, 24);
  assert.equal(CELLS, 576);
  assert.equal(PALETTE.length, 12);
  assert.equal(new Set(PALETTE.map((p) => p.code)).size, 12);
  assert.equal(BANDS * BAND_CELLS, CELLS);
  assert.ok(THEMES.length >= 30);
  assert.ok(THEMES.includes('a cozy house'));
  for (const t of THEMES) for (const re of BANNED) assert.doesNotMatch(t, re);
  assert.equal(new Set(buildDeck(3, seeded(2))).size, 3);
  assert.equal(minutes(150), '2 min 30 s');
  assert.equal(minutes(180), '3 min');
  assert.ok(jsonBytes('x'.repeat(BAND_CELLS)) < MAX_VALUE_BYTES);
});

test('cells pack into 3 characters each and junk is refused', () => {
  const list = [[0, '1'], [575, 'c'], [300, '0']];
  const code = encodeCells(list);
  assert.equal(code.length, 9);
  assert.deepEqual(decodeCells(code), list);
  assert.equal(decodeCells(''), null);
  assert.equal(decodeCells('zz1'), null, 'index past the end');
  assert.equal(decodeCells('00d'), null, 'unknown colour');
  assert.equal(decodeCells('001'.repeat(MAX_BATCH + 1)), null, 'too many at once');
  assert.equal(decodeCells(42), null);
  assert.equal(encodeCells([[-1, '1'], [3, 'z'], [4, '2']]), '042');
  assert.equal(filled('0012000'), 2);
});

test('points reward painting and cheers, with a cap and a minimum', () => {
  const g = award({ 0: 3, 1: 10, 2: 500 }, 4);
  assert.equal(g[0], undefined, 'a couple of pixels is not enough');
  assert.equal(g[1], 10 * PAINT_POINT + 4 * CHEER_POINTS);
  assert.equal(g[2], PAINT_CAP + 4 * CHEER_POINTS);
  assert.ok(MIN_CELLS > 1);
});

test('the game is a drawing game with 2 to 3 minutes to paint', () => {
  assert.equal(pixel.id, 'pixel');
  assert.equal(pixel.category, 'drawing');
  assert.equal(pixel.emoji, '🟪');
  assert.deepEqual(pixel.settings.find((s) => s.id === 'timer').options.map((o) => o.value), [90, 120, 150, 180, 240, 300]);
  assert.deepEqual(pixel.prefixes, [PREFIX]);
  for (const re of BANNED) assert.doesNotMatch(`${pixel.name} ${pixel.blurb}`, re);
});

test('everyone paints at once, then cheers, scores and finishes', async () => {
  const r = await startGame(3, { timer: 120 });
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  let s = st(r);
  assert.equal(s.phase, 'paint');
  assert.ok(THEMES.includes(s.theme));
  paint(bySlot(r, slots[0]), Array.from({ length: 20 }, (_, i) => [i, '4']));
  paint(bySlot(r, slots[1]), Array.from({ length: 10 }, (_, i) => [CELLS - 1 - i, '9']));
  paint(bySlot(r, slots[2]), [[100, '7'], [101, '7']]);
  await r.clock.advance(500);
  let g = grid(r);
  assert.equal(g.slice(0, 20), '4'.repeat(20));
  assert.equal(g[CELLS - 1], '9');
  assert.equal(g[100], '7');
  assert.equal(filled(g), 32);
  assert.equal(r.hub.state[bandKey(1)], undefined, 'untouched bands are never written');
  assert.deepEqual(r.hub.state[COUNTS], { [slots[0]]: 20, [slots[1]]: 10, [slots[2]]: 2 });
  paint(bySlot(r, slots[2]), [[0, '0']]);
  paint(bySlot(r, slots[0]), [[1, '4']]);
  await r.clock.advance(400);
  g = grid(r);
  assert.equal(g[0], '0', 'erasing works');
  assert.equal(r.hub.state[COUNTS][slots[0]], 20, 'painting the same colour again does not count');
  assert.equal(r.hub.state[COUNTS][slots[2]], 3);
  await r.clock.advance(120000);
  s = st(r);
  assert.equal(s.phase, 'cheer');
  paint(bySlot(r, slots[0]), [[50, '1']]);
  await r.clock.advance(300);
  assert.equal(grid(r)[50], '0', 'no painting after time is up');
  for (const slot of slots) bySlot(r, slot).act({ type: 'cheer', n: s.n });
  bySlot(r, slots[0]).act({ type: 'cheer', n: s.n });
  await r.clock.advance(400);
  assert.equal(st(r).cheers.length, 3);
  await r.clock.advance(CHEER_MS);
  s = st(r);
  assert.equal(s.phase, 'show');
  assert.equal(s.gained[slots[0]], 20 * PAINT_POINT + 3 * CHEER_POINTS);
  assert.equal(s.gained[slots[1]], 10 * PAINT_POINT + 3 * CHEER_POINTS);
  assert.equal(s.gained[slots[2]], undefined);
  await r.clock.advance(SHOW_MS + 200);
  const roomState = r.engines[0].snapshot().room;
  assert.equal(roomState.phase, 'results');
  assert.deepEqual(roomState.last.winners, [slots[0]]);
  assert.equal(Object.keys(r.hub.state).some((k) => k.startsWith(PREFIX)), false, 'the canvas is cleaned up');
  assert.deepEqual(r.hub.violations, []);
});

test('a flood of paint stays inside the state and op limits', async () => {
  const r = await startGame(4, { timer: 120 });
  for (let tick = 0; tick < 40; tick += 1) {
    for (const e of r.engines) {
      const base = (tick * 13 + e.snapshot().meSlot * 151) % CELLS;
      paint(e, Array.from({ length: 12 }, (_, i) => [(base + i * 7) % CELLS, PALETTE[(tick + i) % 12].code]));
    }
    await r.clock.advance(PAINT_MS);
  }
  await r.clock.advance(3000);
  assert.deepEqual(r.hub.violations, []);
  for (const e of r.engines) assert.ok(r.hub.opsBy(e.snapshot().me.id, r.clock.now() - 10000, r.clock.now() + 1) <= OPS_MAX);
  assert.ok(filled(grid(r)) > 200);
});

test('half the players flagging wipes the canvas and starts it fresh', async () => {
  const r = await startGame(4, { timer: 120 });
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  paint(bySlot(r, slots[0]), [[5, '4'], [6, '4']]);
  await r.clock.advance(400);
  const s = st(r);
  const d = drawingId(s);
  assert.deepEqual(pixel.drawingOf({ state: r.hub.state }), { d, drawer: -1 });
  assert.equal(bySlot(r, slots[1]).flag(d), true);
  await r.clock.advance(400);
  assert.equal(filled(grid(r)), 2, 'one flag of four is not enough');
  assert.equal(bySlot(r, slots[2]).flag(d), true);
  await r.clock.advance(400);
  assert.equal(filled(grid(r)), 0);
  assert.equal(st(r).w, 1);
  assert.equal(st(r).note, 'wiped');
  assert.notEqual(drawingId(st(r)), d);
  paint(bySlot(r, slots[0]), [[7, '2']]);
  await r.clock.advance(400);
  assert.equal(grid(r)[7], '2', 'painting carries on after a wipe');
});

const OWNER = person(2).id;

function fakeFetch() {
  return async (url) => {
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

test('admins can clear the picture, skip and add time', async () => {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(), refreshMs: 0, win: null });
  const r = room(3, { games: [pixel] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('pixel');
  host.lobby.setting('rounds', 2);
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  paint(r.engines[2], [[9, '3']]);
  await settle(r.clock);
  assert.equal(grid(r)[9], '3');
  owner.admin.run({ type: 'clearDrawing' });
  await settle(r.clock);
  assert.equal(filled(grid(r)), 0);
  const s = st(r);
  owner.admin.run({ type: 'time', ms: 30000 });
  await settle(r.clock);
  assert.equal(st(r).ends, s.ends + 30000);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'cheer');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'show');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'paint');
  assert.equal(st(r).i, 1);
  resetAdmins();
});

test('pointer maths maps to cells and fills gaps in fast strokes', () => {
  const rect = { left: 0, top: 0, width: 240, height: 240 };
  assert.equal(cellFromPoint(rect, 5, 5), 0);
  assert.equal(cellFromPoint(rect, 235, 235), CELLS - 1);
  assert.equal(cellFromPoint(rect, 245, 5), null);
  assert.equal(cellFromPoint({ width: 0, height: 0 }, 1, 1), null);
  assert.deepEqual(lineCells(null, 5), [5]);
  assert.deepEqual(lineCells(0, 3), [0, 1, 2, 3]);
  const diag = lineCells(0, 3 * SIZE + 3);
  assert.equal(diag.length, 4);
  assert.equal(diag[3], 3 * SIZE + 3);
});

test('the view paints locally right away, batches sends and shows the cheer', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [pixel] });
  await r.clock.advance(500);
  const toasts = [];
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout };
  const views = r.engines.map((engine) => {
    const v = createPixelView({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  views[0].update(r.engines[0].snapshot());
  assert.match(text(views[0].el), /Setting up the canvas/);
  r.engines[0].lobby.pick('pixel');
  r.engines[0].lobby.setting('timer', 120);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const v = views[0];
  assert.equal(v.el.querySelectorAll('.pixel-cell').length, CELLS);
  assert.equal(v.el.querySelectorAll('.pixel-swatch').length, 13);
  assert.match(text(v.el), new RegExp(st(r).theme));
  v.el.querySelectorAll('.pixel-swatch')[3].click();
  const cells = v.el.querySelectorAll('.pixel-cell');
  cells[10].dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
  cells[12].dispatchEvent(new FakeEvent('pointermove', { bubbles: true }));
  cells[12].dispatchEvent(new FakeEvent('pointerup', { bubbles: true }));
  cells[40].dispatchEvent(new FakeEvent('pointermove', { bubbles: true }));
  assert.ok(cells[10].classList.contains('pixel-c4'), 'shows right away');
  assert.ok(cells[11].classList.contains('pixel-c4'), 'fills the gap');
  assert.ok(cells[12].classList.contains('pixel-c4'));
  assert.ok(cells[40].classList.contains('pixel-c0'), 'no painting after letting go');
  await r.clock.advance(PAINT_MS + 400);
  assert.equal(grid(r).slice(10, 13), '444');
  const other = views[1].el.querySelectorAll('.pixel-cell');
  assert.ok(other[11].classList.contains('pixel-c4'), 'others see it');
  for (const view of views) for (const node of [view.el, ...all(view.el)]) assert.equal(node.hasAttribute('style'), false);
  await r.clock.advance(120000);
  assert.equal(st(r).phase, 'cheer');
  assert.equal(views[1].el.querySelectorAll('.pixel-swatch').length, 0);
  assert.ok(views[1].el.querySelector('.pixel-frame').classList.contains('is-big'));
  const cheer = views[1].el.querySelector('.pixel-actions-row').querySelector('.btn-primary');
  assert.match(text(cheer), /Looks great!/);
  cheer.click();
  await r.clock.advance(400);
  assert.equal(st(r).cheers.length, 1);
  assert.match(text(views[1].el), /Cheered!/);
  await r.clock.advance(CHEER_MS);
  assert.equal(st(r).phase, 'show');
  for (const view of views) view.destroy();
});

test('foot text and moments read well', () => {
  assert.equal(footText(null), '');
  assert.match(footText({ phase: 'paint', myCells: 0, painters: 2 }), /Tap or drag/);
  assert.match(footText({ phase: 'paint', myCells: 12, painters: 3 }), /You painted 12 pixels\. 3 painters so far\./);
  assert.match(footText({ phase: 'cheer', filled: 0 }), /empty/);
  assert.match(footText({ phase: 'show', cheers: 4, myGain: 140 }), /4 cheers for this one! \+140/);
  const a = pixelMoment(null, { n: 1, w: 0, phase: 'paint' });
  assert.deepEqual(a.cues, []);
  assert.deepEqual(pixelMoment(a.now, { n: 1, w: 1, phase: 'paint' }).cues, ['whoosh']);
  assert.deepEqual(pixelMoment(a.now, { n: 1, w: 0, phase: 'cheer' }).cues, ['reveal']);
});
