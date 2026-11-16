import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, FakeEvent } from './dom-shim.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';
import { PIXEL_CELLS } from '../web/activity/js/games/replayformat.js';
import {
  SPEEDS, GAP_MS, GAP_KEEP_MS, LEGACY_STEP_MS, LEGACY_NOTE, CREDIT_NOTE, ALL,
  readReplay, legacyReplay, replayOf, plan, progressAt, stepTime, retime, speedFromKey, nextSpeed,
  cycleFilter, artistView, filterText, nowDrawing, visibleAt, gridAt, formatClock, countLabel, notesOf, durationOf,
} from '../web/js/replay-model.js';

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
const { createReplayPlayer } = await import('../web/js/pages/party-replay.js');
const { renderPartyReports, REPORTS_PATH, BANS_PATH } = await import('../web/js/pages/party-reports.js');
const { state } = await import('../web/js/state.js');

const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const S1 = encodeStroke({ c: 3, z: 1, pts: [[10, 10], [40, 40], [60, 80]] });
const S2 = encodeStroke({ c: 8, z: 1, pts: [[100, 100], [140, 120]] });
const S3 = encodeStroke({ c: 6, z: 2, pts: Array.from({ length: 40 }, (_, i) => [100 + i * 3, 50 + (i % 5)]) });
const FILL = encodeStroke({ c: 9, z: 4, pts: [[300, 300]] });

const RAW = {
  v: 1,
  kind: 'ink',
  authors: [{ id: uid(1), name: 'Rex', profile: null, banned: false, role: null }, { id: uid(3), name: 'Juno', profile: { display_name: 'Real Juno', username: 'juno', avatar: null }, banned: false, role: null }],
  events: [[1, 0, S1], [0, 1000, S2], [1, 1100, 1], [0, 30000, S3], [1, 30500, FILL]],
};

test('replays are read safely and old reports get an evenly spaced fallback', () => {
  const r = readReplay(RAW);
  assert.equal(r.kind, 'ink');
  assert.deepEqual(r.events.map((e) => e.type), ['add', 'add', 'cut', 'add', 'add']);
  assert.deepEqual(r.authors.map((a) => [a.name, a.count, a.tone]), [['Rex', 2], ['Juno', 2]].map(([n, c], i) => [n, c, i]));
  assert.equal(readReplay(null), null);
  assert.equal(readReplay({ kind: 'ink', authors: [], events: [] }), null);
  assert.equal(readReplay({ kind: 'ink', authors: [{ id: 'a' }], events: [[5, 0, S1], [0, 0, 'bad'], 'x'] }), null);
  const old = legacyReplay([S1, 'junk', S2], { id: uid(1), name: 'Rex' });
  assert.equal(old.legacy, true);
  assert.deepEqual(old.events.map((e) => [e.a, e.t]), [[0, 0], [0, LEGACY_STEP_MS]]);
  assert.deepEqual(notesOf(old), [LEGACY_NOTE]);
  assert.equal(replayOf({ ink: [], replay: null }), null);
  assert.equal(replayOf({ ink: [S1], replay: RAW }).legacy, false);
  assert.equal(replayOf({ ink: [S1], drawer: { id: uid(1), name: 'Rex' } }).legacy, true);
  const px = readReplay({ kind: 'pixel', authors: [{ id: 'a', name: 'A' }], events: [[0, 5, 3, '4'], [0, 6, PIXEL_CELLS, '4'], [0, 7, 4, 'q']], grid: '0'.repeat(PIXEL_CELLS) });
  assert.equal(px.events.length, 1);
  assert.equal(px.grid, '0'.repeat(PIXEL_CELLS));
});

test('the timeline squashes idle gaps, keeps order and never overlaps steps', () => {
  const r = readReplay(RAW);
  const real = plan(r.events, { skipGaps: false });
  const quick = plan(r.events, { skipGaps: true });
  assert.ok(real.total > 30000);
  assert.ok(quick.total < real.total - (30000 - GAP_MS));
  for (const p of [real, quick]) {
    for (let i = 1; i < r.events.length; i += 1) assert.ok(p.starts[i] >= p.starts[i - 1] + p.durs[i - 1]);
  }
  assert.equal(quick.starts[3] - (quick.starts[2] + quick.durs[2]) <= GAP_KEEP_MS, true);
  assert.ok(durationOf(r.events[3]) > durationOf(r.events[1]), 'longer lines take longer to draw');
  assert.deepEqual(progressAt(quick, 0), { done: 0, active: 0, frac: 0 });
  assert.equal(progressAt(quick, quick.total).done, r.events.length);
  const mid = quick.starts[3] + quick.durs[3] / 2;
  const at = progressAt(quick, mid);
  assert.equal(at.active, 3);
  assert.ok(at.frac > 0.4 && at.frac < 0.6);
  assert.equal(stepTime(quick, mid, 1), quick.starts[3] + quick.durs[3]);
  assert.equal(stepTime(quick, mid, -1), quick.starts[2] + quick.durs[2]);
  assert.equal(stepTime(quick, 0, -1), 0);
  const back = retime(quick, real, mid);
  assert.equal(progressAt(real, back).active, 3);
  assert.equal(retime(quick, real, quick.total), real.total);
  assert.equal(nowDrawing(quick, r.events, mid), 0);
  assert.equal(nowDrawing(quick, r.events, quick.starts[0] + 1), 1);
  assert.equal(formatClock(61000), '1:01');
});

test('speeds, artist filters, undo and pixel grids follow the rules', () => {
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4, 8, 16]);
  assert.equal(speedFromKey('1'), 0.5);
  assert.equal(speedFromKey('6'), 16);
  assert.equal(speedFromKey('7'), null);
  assert.equal(nextSpeed(16, 1), 16);
  assert.equal(nextSpeed(1, -1), 0.5);
  let f = ALL;
  assert.equal(artistView(f, 1), 'on');
  f = cycleFilter(f, 1);
  assert.deepEqual([artistView(f, 1), artistView(f, 0)], ['on', 'dim']);
  assert.match(filterText(f, [{ name: 'Rex' }, { name: 'Juno' }]), /Highlighting Juno/);
  f = cycleFilter(f, 1);
  assert.deepEqual([artistView(f, 1), artistView(f, 0)], ['on', 'off']);
  assert.deepEqual(cycleFilter(f, 0), { mode: 'focus', a: 0 });
  assert.equal(cycleFilter(f, 1), ALL);
  const r = readReplay(RAW);
  assert.deepEqual(visibleAt(r.events, 2), [0, 1]);
  assert.deepEqual(visibleAt(r.events, 3), [0]);
  assert.deepEqual(visibleAt(r.events, 5), [0, 3, 4]);
  const px = readReplay({ kind: 'pixel', authors: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], events: [[0, 1, 3, '4'], [1, 2, 3, '9'], [1, 3, 4, '0']] });
  const g = gridAt(px.events, 3);
  assert.deepEqual([g.color[3], g.owner[3], g.color[4], g.owner[4]], ['9', 1, '0', -1]);
  assert.equal(countLabel('pixel', 1), '1 pixel');
  assert.equal(countLabel('ink', 3), '3 lines');
});

function recordingCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'getImageData' || k === 'putImageData' ? undefined : (...a) => calls.push([k, ...a])),
    set: (_, k, v) => {
      calls.push([`set:${String(k)}`, v]);
      return true;
    },
  });
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  return { calls, ctx, restore: () => { document.createElement = make; } };
}

function fakeWin() {
  let t = 0;
  const frames = [];
  return {
    devicePixelRatio: 2,
    performance: { now: () => t },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    run(ms) {
      t += ms;
      const list = frames.splice(0);
      for (const fn of list) fn(t);
    },
  };
}

const press = (el, key) => el.dispatchEvent(new FakeEvent('keydown', { key, bubbles: true }));

test('the player plays, pauses, steps, changes speed by keyboard and draws lines bit by bit', () => {
  const canvas = recordingCanvas();
  const win = fakeWin();
  const bans = [];
  const p = createReplayPlayer({ replay: readReplay(RAW), drawerId: uid(1), label: 'drawing by Rex', win, onBan: (a) => bans.push(a.id) });
  canvas.restore();
  assert.equal(p.time, p.total, 'starts on the finished drawing');
  assert.equal(p.el.querySelectorAll('canvas')[0].width, 480 * 4, 'crisp on high-DPI screens');
  assert.equal(p.el.querySelectorAll('.replay-artist').length, 2);
  assert.match(p.el.textContent, /Juno/);
  assert.match(p.el.textContent, /2 lines · reported/);
  const ban = p.el.querySelectorAll('button').filter((b) => /^Ban$/.test(b.textContent.trim()));
  assert.equal(ban.length, 1, 'other artists can be banned from the legend');
  ban[0].click();
  assert.deepEqual(bans, [uid(3)]);
  press(p.el, ' ');
  assert.equal(p.playing, true);
  assert.equal(p.time, 0);
  canvas.calls.length = 0;
  win.run(16);
  win.run(60);
  assert.ok(p.time > 0 && p.time < p.total);
  assert.ok(canvas.calls.some(([k]) => k === 'lineTo'), 'a line is being drawn');
  assert.match(p.el.querySelector('.replay-now').textContent, /Now drawing\s*Juno/);
  press(p.el, '5');
  assert.equal(p.speed, 8);
  press(p.el, ' ');
  assert.equal(p.playing, false);
  const before = p.time;
  press(p.el, 'ArrowRight');
  assert.ok(p.time > before);
  press(p.el, 'ArrowLeft');
  press(p.el, 'ArrowLeft');
  assert.ok(p.time < before + 1);
  press(p.el, 'End');
  assert.equal(p.time, p.total);
  canvas.calls.length = 0;
  p.pickArtist(1);
  assert.deepEqual(p.filter, { mode: 'focus', a: 1 });
  assert.ok(canvas.calls.some(([k, v]) => k === 'set:globalAlpha' && v < 1), 'other artists are dimmed');
  assert.match(p.el.textContent, /Highlighting Juno/);
  p.destroy();
});

test('dragging the scrubber moves the replay to that spot, even while it plays', () => {
  const canvas = recordingCanvas();
  const win = fakeWin();
  const p = createReplayPlayer({ replay: readReplay(RAW), drawerId: uid(1), label: 'drawing by Rex', win });
  canvas.restore();
  const scrub = p.el.querySelector('.replay-scrub');
  scrub.value = '300';
  scrub.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  assert.ok(Math.abs(p.time - p.total * 0.3) < 1, 'paused replay jumps to 30%');
  assert.equal(String(scrub.value), '300');
  p.play();
  win.run(16);
  win.run(40);
  assert.equal(p.playing, true);
  scrub.value = '800';
  scrub.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  assert.equal(p.playing, false, 'scrubbing pauses playback');
  assert.ok(Math.abs(p.time - p.total * 0.8) < 1, 'and lands where the thumb was dropped');
  p.destroy();
});

test('playing forward draws only the new steps instead of redrawing everything', () => {
  const canvas = recordingCanvas();
  const win = fakeWin();
  const events = Array.from({ length: 600 }, (_, i) => [0, i * 50, encodeStroke({ c: 1, z: 1, pts: [[i % 480, 10], [i % 480, 60]] })]);
  const p = createReplayPlayer({ replay: readReplay({ kind: 'ink', authors: [{ id: 'a', name: 'A' }], events }), win });
  canvas.restore();
  p.seek(0, true);
  p.setSpeed(16);
  p.play();
  let blanks = 0;
  for (let i = 0; i < 60; i += 1) {
    canvas.calls.length = 0;
    win.run(16);
    blanks += canvas.calls.filter(([k]) => k === 'fillRect').length;
  }
  assert.equal(blanks, 0, 'no full repaint while playing forward');
  assert.ok(p.drawn > 20);
  p.destroy();
});

test('Pixel Art replays pop cells in one by one with the painter shown', () => {
  const canvas = recordingCanvas();
  const win = fakeWin();
  const p = createReplayPlayer({ replay: readReplay({ kind: 'pixel', authors: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' }], events: [[0, 100, 0, '4'], [1, 200, 30, '9'], [1, 250, 31, '9']], grid: '0'.repeat(PIXEL_CELLS) }), win });
  canvas.restore();
  assert.match(p.el.textContent, /2 pixels/);
  p.seek(0, true);
  p.play();
  win.run(16);
  win.run(70);
  assert.match(p.el.querySelector('.replay-now').textContent, /Now painting/);
  assert.ok(canvas.calls.some(([k, v]) => k === 'set:fillStyle' && v === '#ef4444'));
  p.destroy();
});

test('Pixel Art cells painted before recording start show from the first frame and end on the reported picture', () => {
  const grid = Array(PIXEL_CELLS).fill('0');
  grid[7] = 'c';
  grid[3] = '9';
  const r = readReplay({ kind: 'pixel', authors: [{ id: 'a', name: 'A' }], events: [[0, 1, 3, '4'], [0, 2, 3, '9']], grid: grid.join(''), late: true });
  const start = gridAt(r.events, 0, r.base);
  assert.deepEqual([start.color[7], start.owner[7], start.color[3]], ['c', -1, '0']);
  const end = gridAt(r.events, r.events.length, r.base);
  assert.equal(end.color.join(''), grid.join(''));
  assert.equal(readReplay({ kind: 'pixel', authors: [{ id: 'a', name: 'A' }], events: [[0, 1, 3, '4']], grid: '0'.repeat(PIXEL_CELLS) }).base, null);
});

test('multi-artist replays warn that the credit is unverified and Space toggles the checkbox, not playback', () => {
  const r = readReplay(RAW);
  assert.ok(notesOf(r).includes(CREDIT_NOTE));
  assert.equal(notesOf(readReplay({ ...RAW, authors: [RAW.authors[0]], events: [[0, 0, S1]] })).includes(CREDIT_NOTE), false);
  const canvas = recordingCanvas();
  const p = createReplayPlayer({ replay: r, win: fakeWin() });
  canvas.restore();
  assert.match(p.el.textContent, /can't be double-checked/);
  const box = p.el.querySelector('.replay-skip-box');
  press(box, ' ');
  assert.equal(p.playing, false);
  p.destroy();
});

test('the reports page shows the player, a note for older reports and keeps ban and dismiss', async () => {
  state.user = { id: uid(9), username: 'alice', display_name: 'Alice', avatar_url: '' };
  state.partyOwner = true;
  state.partyAdmin = true;
  const reports = [
    { id: 'new1', game: 'odd', word: 'lighthouse', created: Date.now(), status: 'open', ink: [S2], replay: RAW, drawer: { id: uid(1), name: 'Rex', username: null, profile: null, banned: false, role: null }, reporter: { id: uid(2), name: 'Mila', profile: null } },
    { id: 'old1', game: 'draw', word: 'cat', created: Date.now() - 1000, status: 'open', ink: [S1, S2], drawer: { id: uid(4), name: 'Zed', username: null, profile: null, banned: false, role: null }, reporter: { id: uid(2), name: 'Mila', profile: null } },
    { id: 'px1', game: 'pixel', word: 'a castle', created: Date.now() - 2000, status: 'open', ink: [], replay: { v: 1, kind: 'pixel', authors: [{ id: uid(5), name: 'Pia' }], events: [[0, 1, 0, '4']], grid: '0'.repeat(PIXEL_CELLS) }, drawer: { id: uid(5), name: 'Pia', username: null, profile: null, banned: false, role: null }, reporter: { id: uid(2), name: 'Mila', profile: null } },
  ];
  const calls = [];
  const api = {
    get: async (path) => (path.startsWith(REPORTS_PATH) ? { reports, next: null, open: 3, role: 'owner' } : { bans: [], max: 1000 }),
    post: async (path, body) => {
      calls.push([path, body]);
      return path === BANS_PATH ? { bans: [], banned: true } : { ok: true, dismissed: true };
    },
    request: async () => ({ ok: true }),
  };
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  renderPartyReports({ api, main, signal: ctrl.signal, params: {}, setChrome() {} });
  await flush();
  const items = main.querySelectorAll('.report-item');
  assert.equal(items.length, 3);
  assert.equal(items[0].querySelectorAll('.replay-player').length, 1);
  assert.equal(items[0].querySelectorAll('.replay-artist').length, 2);
  assert.match(items[1].textContent, /Older report: timing and per-line artists weren't recorded/);
  assert.doesNotMatch(items[0].textContent, /Older report/);
  assert.match(items[2].textContent, /Pixel Art/);
  assert.match(items[2].querySelector('canvas').getAttribute('aria-label'), /picture by Pia/);
  for (const it of items) {
    assert.equal(it.querySelectorAll('button').filter((b) => /Ban from Party/.test(b.textContent)).length, 1);
    assert.equal(it.querySelectorAll('button').filter((b) => /Dismiss/.test(b.textContent)).length, 1);
  }
  ctrl.abort();
});
