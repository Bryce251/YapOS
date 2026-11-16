import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-shim.js';
import draw from '../web/activity/js/games/draw.js';
import telephone, { entryKey } from '../web/activity/js/games/telephone.js';
import { encodeStroke, inkKey } from '../web/activity/js/games/ink.js';
import { createRecorder, partialAt, decodeInk, inkLength, createReplayStrip, REPLAY_KEEP, REPLAY_MS, REPLAY_TICK_MS } from '../web/activity/js/ui/replay.js';
import { jsonBytes } from '../web/activity/js/limits.js';

const players = [
  { slot: 0, id: 'a', name: 'Ada', hue: 10, joined: true, present: true },
  { slot: 1, id: 'b', name: 'Bo', hue: 200, joined: true, present: true },
];

function byKey(node, key) {
  for (const c of node.childNodes || []) {
    if (c.dataset && c.dataset.key === key) return c;
    const hit = byKey(c, key);
    if (hit) return hit;
  }
  return null;
}

function line(c, pts) {
  return encodeStroke({ c, z: 1, pts });
}

function drawSnap(round, n, strokes, extra = {}) {
  const nonce = 100 + n;
  const st = { v: 1, phase: 'draw', drawer: n % 2, nonce, n, w: null, got: [], feed: [], ...extra };
  const state = { draw: st };
  if (strokes.length) state[inkKey(0)] = { k: nonce, i: 0, s: strokes };
  return { ready: true, room: { phase: 'game', round, game: 'draw' }, players, state };
}

test('the recorder keeps each Draw & Guess drawing in stroke order from what was already shared', () => {
  const rec = createRecorder();
  const a = line(3, [[10, 10], [40, 40], [80, 20]]);
  const b = line(8, [[100, 100], [120, 140]]);
  assert.equal(rec.record(drawSnap(4, 1, [a]), draw), true);
  assert.equal(rec.record(drawSnap(4, 1, [a, b]), draw), true);
  assert.equal(rec.record(drawSnap(4, 1, [a, b]), draw), false, 'nothing new, nothing changes');
  assert.equal(rec.record(drawSnap(4, 2, [b]), draw), true);
  const list = rec.list(4, 'draw');
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].ink, [a, b]);
  assert.equal(list[0].drawer, 'Bo');
  assert.equal(list[1].drawer, 'Ada');
  assert.deepEqual(rec.list(5, 'draw'), []);
  assert.deepEqual(rec.list(4, 'telephone'), []);
  rec.record(drawSnap(5, 1, [a]), draw);
  assert.equal(rec.list(4, 'draw').length, 0, 'a new game starts a fresh strip');
  assert.equal(rec.list(5, 'draw').length, 1);
});

test('hidden drawings leave the replay strip and never come back', () => {
  const rec = createRecorder();
  const a = line(3, [[10, 10], [40, 40]]);
  rec.record(drawSnap(1, 1, [a]), draw);
  assert.equal(rec.size, 1);
  rec.record(drawSnap(1, 1, [], { hid: 1, phase: 'reveal' }), draw);
  assert.equal(rec.size, 0);
  rec.record(drawSnap(1, 1, [a]), draw);
  assert.equal(rec.size, 0);
  const st = { v: 1, run: 3, seats: [0, 1], phase: 'reveal', rv: { c: 0, at: 1, pos: 0, total: 1, len: 2, owner: 0 }, hid: ['tel.3.1.0'] };
  const snap = { ready: true, room: { phase: 'game', round: 2, game: 'telephone' }, players, state: { tel: st, [entryKey(0)]: { c: 0, i: 0, k: 't', t: 'a cat', by: 0 }, [entryKey(1)]: { c: 0, i: 1, k: 'd', s: [a], by: 1, hid: 1 } } };
  assert.deepEqual(telephone.hiddenDrawings(snap).sort(), ['tel.3.0.1', 'tel.3.1.0']);
  const rec2 = createRecorder();
  rec2.record(snap, telephone);
  assert.equal(rec2.size, 0);
  delete snap.state[entryKey(1)].hid;
  rec2.record({ ...snap, room: { ...snap.room, round: 3 } }, telephone);
  const got = rec2.list(3, 'telephone');
  assert.equal(got.length, 1);
  assert.equal(got[0].word, 'a cat');
  assert.equal(got[0].drawer, 'Bo');
});

test('the recorder stays small and only records games that have replays', () => {
  const rec = createRecorder();
  for (let n = 1; n <= REPLAY_KEEP + 6; n += 1) rec.record(drawSnap(1, n, [line(3, [[n, n], [n + 5, n + 5]])]), draw);
  assert.equal(rec.size, REPLAY_KEEP);
  const big = Array.from({ length: 60 }, (_, i) => line(3, Array.from({ length: 120 }, (_, k) => [(k * 3 + i) % 480, (k * 2) % 360])));
  rec.record(drawSnap(1, 99, big), draw);
  const last = rec.list(1, 'draw').pop();
  assert.ok(last.ink.join('').length <= 16000);
  assert.equal(rec.record(drawSnap(1, 1, [line(3, [[1, 1], [2, 2]])]), { id: 'trivia' }), false);
  assert.equal(rec.record({ ready: true, room: { phase: 'results', round: 1 } }, draw), false);
});

test('a replay redraws the drawing point by point and fills in one step', () => {
  const strokes = decodeInk([line(3, [[0, 0], [10, 10], [20, 20], [30, 30]]), encodeStroke({ c: 5, z: 4, pts: [[50, 50]] }), line(8, [[1, 1], [2, 2]])]);
  assert.equal(inkLength(strokes), 7);
  assert.deepEqual(partialAt(strokes, 0), []);
  const half = partialAt(strokes, 0.5);
  assert.equal(half.length, 1);
  assert.equal(half[0].pts.length, 3);
  const most = partialAt(strokes, 5 / 7);
  assert.equal(most.length, 2);
  assert.equal(most[1].z, 4);
  assert.equal(partialAt(strokes, 1).length, 3);
  assert.equal(partialAt(strokes, 2).length, 3);
  assert.deepEqual(partialAt([], 0.5), []);
});

test('the replay strip renders thumbnails and plays one on tap, with no new shared state', async () => {
  installDom();
  const timers = [];
  let t = 0;
  const win = { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} };
  const strip = createReplayStrip({ win, now: () => t });
  const a = line(3, [[10, 10], [40, 40]]);
  strip.show([{ d: 'x', ink: [a], word: 'cat', drawer: 'Ada', hue: 10 }, { d: 'y', ink: [a, a], word: null, drawer: 'Bo', hue: 50 }]);
  assert.equal(strip.count, 2);
  assert.match(strip.el.textContent, /Replays/);
  assert.match(strip.el.textContent, /Tap a drawing/);
  const thumb = byKey(strip.el, 'replay-0');
  assert.ok(thumb);
  thumb.click();
  assert.equal(strip.playing, true);
  assert.match(strip.el.textContent, /Ada drew cat/);
  t = REPLAY_MS + REPLAY_TICK_MS;
  while (timers.length) timers.shift()();
  assert.equal(strip.playing, false);
  byKey(strip.el, 'replay-close').click();
  assert.doesNotMatch(strip.el.textContent, /Ada drew cat/);
  strip.show([]);
  assert.equal(strip.el.textContent, '');
  assert.ok(jsonBytes({ s: [a] }) < 4096);
});
