import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import odd, { KEY as ODD_KEY, INTRO_MS, fitStroke, rawInk } from '../web/activity/js/games/odd.js';
import pixel, { KEY as PIXEL_KEY, encodeCells, readGrid, drawingId as pixelId } from '../web/activity/js/games/pixel.js';
import { encodeStroke, inkKey } from '../web/activity/js/games/ink.js';
import { createReplayLog, canvasesOf, pixelReport, topPainter } from '../web/activity/js/games/replaylog.js';
import { trimReplay, dropOldest, replayChars, REPLAY_EVENTS, REPLAY_CHARS, PIXEL_COLORS, PIXEL_CELLS } from '../web/activity/js/games/replayformat.js';
import { PALETTE } from '../web/activity/js/games/pixel.js';
import { reportBody, replayFits, REPORT_GAMES } from '../web/activity/js/admin.js';
import { cleanReplay, REPORT_GAMES as WORKER_GAMES } from '../worker/reports.js';

installDom({ url: 'https://yapos.example/activity/' });
const { reportOf } = await import('../web/activity/js/views/draw.js');

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function hostOf(r) {
  return r.engines.find((e) => e.isHost());
}

function watch(r, e) {
  const log = createReplayLog({ now: r.clock.now });
  e.on('change', () => log.observe(e.snapshot()));
  e.on('message', ({ data, by }) => log.hear(data, by));
  return log;
}

async function start(game, n, { record = true, seed = 11 } = {}) {
  const r = room(n, { games: [game], seed });
  const logs = record ? r.engines.map((e) => watch(r, e)) : [];
  const log = record ? logs[n - 1] : null;
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.pick(game.id), true);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  return { r, log, logs };
}

const line = (i) => [[40 + i * 30, 50], [60 + i * 30, 120], [90 + i * 30, 200]];

async function oddRound(record) {
  const { r, log, logs } = await start(odd, 4, { record });
  await r.clock.advance(INTRO_MS + 100);
  for (let i = 0; i < 6; i += 1) {
    const s = hostOf(r).snapshot().state[ODD_KEY];
    if (s.phase !== 'draw') break;
    bySlot(r, s.turn).act({ type: 'stroke', n: s.n, s: fitStroke(line(i), 1, 1, s.cap) });
    await r.clock.advance(400);
  }
  return { r, log, logs };
}

test('admin and worker agree that Pixel Art pictures can be reported', () => {
  assert.ok(REPORT_GAMES.includes('pixel'));
  for (const g of REPORT_GAMES) assert.ok(WORKER_GAMES.has(g), g);
});

test('the replay palette matches the Pixel Art palette', () => {
  for (const p of PALETTE) assert.equal(PIXEL_COLORS[p.code], p.hex);
});

test('a shared Odd One Out canvas records every line with who drew it and when', async () => {
  const { r, log } = await oddRound(true);
  const snap = r.engines[3].snapshot();
  const st = snap.state[ODD_KEY];
  const raw = rawInk(snap.state, st.k);
  assert.ok(raw.length >= 6);
  const item = odd.drawingOf(snap);
  const replay = log.replayFor('odd', item);
  assert.ok(replay, 'there is a replay');
  assert.equal(replay.kind, 'ink');
  assert.deepEqual(replay.events.map((e) => e[2]), raw, 'every line, in order');
  assert.ok(replay.authors.length >= 3, 'several artists');
  let at = 0;
  const ids = new Map(snap.players.map((p) => [p.slot, p.id]));
  st.marks.forEach((slot, i) => {
    const n = st.lens[i];
    for (let k = 0; k < n; k += 1) {
      const e = replay.events[at + k];
      assert.equal(replay.authors[e[0]].id, ids.get(slot), `line ${at + k} belongs to slot ${slot}`);
    }
    at += n;
  });
  for (let i = 1; i < replay.events.length; i += 1) assert.ok(replay.events[i][1] >= replay.events[i - 1][1]);
  assert.ok(replay.events[replay.events.length - 1][1] > replay.events[0][1] + 1000, 'times are spread out like the turns');
  assert.ok(!replay.late);
  const drawer = snap.players.find((p) => p.slot === item.drawer);
  const clean = cleanReplay(replay, 'odd', drawer.id);
  assert.equal(clean.events.length, replay.events.length);
});

test('recording a replay adds no shared-state or message traffic', async () => {
  const a = await oddRound(true);
  const b = await oddRound(false);
  assert.ok(a.log.size >= 1);
  assert.equal(a.r.hub.ops.length, b.r.hub.ops.length);
  assert.deepEqual(Object.keys(a.r.hub.state).sort(), Object.keys(b.r.hub.state).sort());
  assert.deepEqual(a.r.hub.violations, []);
});

test('the shared report body carries the replay through the drawing report path', async () => {
  const { r, logs } = await oddRound(true);
  const item = odd.drawingOf(r.engines[0].snapshot());
  const k = r.engines.findIndex((e) => e.snapshot().meSlot !== item.drawer);
  const snap = r.engines[k].snapshot();
  const body = reportOf(snap, 'odd', item, logs[k]);
  assert.ok(body.replay);
  const sent = reportBody(body);
  assert.deepEqual(sent.replay, body.replay);
  assert.ok(sent.replay.authors.some((x) => x.id === sent.drawer.id));
  assert.doesNotThrow(() => cleanReplay(sent.replay, 'odd', sent.drawer.id, sent.drawer, sent.ink), 'a real replay passes the server checks');
  const other = reportBody({ ...body, ink: body.ink.slice(0, -1) });
  assert.equal('replay' in other, false, 'a replay that ends in a different drawing is left out instead of failing the report');
});

test('the client leaves out replays the server would refuse', () => {
  const s1 = encodeStroke({ c: 3, z: 1, pts: [[1, 1], [50, 50]] });
  const s2 = encodeStroke({ c: 8, z: 1, pts: [[100, 100], [150, 150]] });
  const two = { v: 1, kind: 'ink', authors: [{ id: 'aaaa1', name: 'Ann' }, { id: 'bbbb2', name: 'Bo' }], events: [[0, 0, s1], [1, 10, s2]] };
  assert.equal(replayFits(two, 'odd', 'aaaa1', [s1]), true, "only the reported player's own lines are compared");
  assert.equal(replayFits(two, 'odd', 'bbbb2', [s2]), true);
  assert.equal(replayFits(two, 'draw', 'aaaa1', [s1]), false, 'one-artist games only credit the reported player');
  assert.equal(replayFits({ ...two, authors: [two.authors[0]], events: [[0, 0, s1], [0, 10, s2]] }, 'draw', 'aaaa1', [s1, s2]), true);
  assert.equal(replayFits(two, 'odd', 'aaaa1', [s2]), false);
  assert.equal(replayFits(two, 'odd', 'cccc3', [s1]), false);
  assert.equal(replayFits(two, 'pixel', 'aaaa1', []), false);
  const grid = '0'.repeat(PIXEL_CELLS - 2) + '44';
  const pic = trimReplay({ kind: 'pixel', authors: [{ id: 'aaaa1', name: 'Ann' }], events: [[0, 0, PIXEL_CELLS - 2, '4'], [0, 5, PIXEL_CELLS - 1, '4'], [0, 9, 3, '7']], grid });
  assert.deepEqual(pic.events.map((e) => e[2]), [PIXEL_CELLS - 2, PIXEL_CELLS - 1], 'steps that disagree with the final picture are dropped');
  assert.doesNotThrow(() => cleanReplay(pic, 'pixel', 'aaaa1'));
});

test('unmatched Pixel Art cells waiting for a painter never pile up', () => {
  let t = 0;
  const log = createReplayLog({ now: () => t });
  const players = [{ slot: 0, id: 'aaaa1', name: 'Ann' }];
  const band = PIXEL_CELLS / 4;
  const snap = (code) => ({
    room: { phase: 'game', game: 'pixel', round: 1 },
    players,
    state: { [PIXEL_KEY]: { n: 1, theme: 'x' }, 'pixel.0': code.repeat(4) + '0'.repeat(band - 4) },
  });
  for (let i = 0; i < 50; i += 1) {
    t += 10;
    log.observe(snap(i % 2 ? '4' : '7'));
  }
  const key = pixelId({ n: 1, theme: 'x' });
  assert.equal(log.logOf(key).loose, 4);
});

function oddSnap(round, marks, lens, ink, players) {
  return {
    room: { phase: 'game', game: 'odd', round },
    players,
    state: { [ODD_KEY]: { k: 4, n: 1, phase: 'draw', marks, lens, order: [], cols: [] }, [inkKey(0)]: { k: 4, i: 0, s: ink } },
  };
}

test('undo shrinks the canvas with a cut and re-encoded lines are patched in place', () => {
  let t = 1000;
  const log = createReplayLog({ now: () => t });
  const players = [{ slot: 0, id: 'aaaa1', name: 'Ann' }, { slot: 1, id: 'bbbb2', name: 'Bo' }];
  const a = encodeStroke({ c: 3, z: 1, pts: [[1, 1], [50, 50]] });
  const a2 = encodeStroke({ c: 3, z: 1, pts: [[1, 1], [51, 50]] });
  const b = encodeStroke({ c: 8, z: 1, pts: [[100, 100], [150, 150]] });
  const c = encodeStroke({ c: 8, z: 1, pts: [[200, 100], [250, 150]] });
  log.observe(oddSnap(1, [], [], [], players));
  t = 2000;
  log.observe(oddSnap(1, [0, 1], [1, 1], [a, b], players));
  t = 3000;
  log.observe(oddSnap(1, [0], [1], [a], players));
  t = 4000;
  log.observe(oddSnap(1, [0, 1], [1, 1], [a2, c], players));
  const got = log.logOf('odd.4');
  assert.deepEqual(got.events, [[0, 1000, a], [1, 1000, b], [1, 2000, 1], [1, 3000, c]].map((e, i) => (i === 0 ? [0, 1000, a2] : e)));
  assert.equal(got.late, false);
  t = 5000;
  log.observe(oddSnap(2, [1], [1], [b], players));
  assert.equal(log.size, 1, 'a new round clears the old canvases');
  assert.equal(log.logOf('odd.4').late, true);
});

test('pixel paints are attributed from intents and host paints from the counts', async () => {
  const { r, log } = await start(pixel, 3);
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  const paint = (e, cells) => e.act({ type: 'paint', n: e.snapshot().state[PIXEL_KEY].n, c: encodeCells(cells) });
  paint(r.engines[0], [[0, '4'], [1, '4'], [2, '4']]);
  await r.clock.advance(400);
  paint(r.engines[1], [[30, '9'], [31, '9']]);
  await r.clock.advance(400);
  paint(r.engines[2], [[60, '7']]);
  await r.clock.advance(400);
  paint(r.engines[1], [[0, '1']]);
  await r.clock.advance(400);
  const snap = r.engines[2].snapshot();
  const replay = log.replayFor('pixel', { d: pixelId(snap.state[PIXEL_KEY]) });
  const who = (slot) => snap.players.find((p) => p.slot === slot).id;
  const cells = replay.events.map((e) => [replay.authors[e[0]].id, e[2], e[3]]);
  assert.deepEqual(cells, [
    [who(slots[0]), 0, '4'], [who(slots[0]), 1, '4'], [who(slots[0]), 2, '4'],
    [who(slots[1]), 30, '9'], [who(slots[1]), 31, '9'],
    [who(slots[2]), 60, '7'],
    [who(slots[1]), 0, '1'],
  ]);
  assert.equal(replay.grid, readGrid((k) => snap.state[k]));
  const body = pixelReport(snap, log);
  assert.equal(body.game, 'pixel');
  assert.deepEqual(body.ink, []);
  assert.equal(body.drawer.id, who(slots[0]), 'the busiest other painter is the one reported');
  assert.ok(body.replay);
  assert.deepEqual(cleanReplay(body.replay, 'pixel', body.drawer.id).events, body.replay.events);
  assert.equal(topPainter(body.replay, who(slots[0])).id, who(slots[1]));
  assert.deepEqual(reportBody(body).replay, body.replay);
});

test('only drawing games make canvases and junk snapshots are ignored', () => {
  assert.deepEqual(canvasesOf(null), []);
  assert.deepEqual(canvasesOf({ room: { game: 'trivia' }, state: {} }), []);
  const log = createReplayLog();
  assert.equal(log.observe({ room: { phase: 'lobby' } }), false);
  assert.equal(log.hear({ t: 'g', g: 'pixel', a: { type: 'paint', n: 1, c: 'zz' } }, 'x'), 0);
  assert.equal(log.replayFor('odd', { d: 'odd.1.1', ink: ['AAAAAA'] }), null);
});

test('replays are capped by steps and size, newest kept, and undo counts stay right', () => {
  const s = (i) => encodeStroke({ c: 1, z: 1, pts: [[i % 400, 10], [(i % 400) + 5, 20]] });
  const authors = [{ id: 'aaaa1', name: 'Ann' }];
  const many = { kind: 'ink', authors, events: Array.from({ length: 700 }, (_, i) => [0, i * 10, s(i)]) };
  const out = trimReplay(many);
  assert.equal(out.events.length, REPLAY_EVENTS);
  assert.equal(out.truncated, true);
  assert.equal(out.events[out.events.length - 1][2], s(699));
  const fat = encodeStroke({ c: 1, z: 1, pts: Array.from({ length: 300 }, (_, i) => [i % 480, (i * 7) % 360]) });
  const big = trimReplay({ kind: 'ink', authors, events: Array.from({ length: 200 }, (_, i) => [0, i, fat]) });
  assert.ok(replayChars(big) <= REPLAY_CHARS);
  assert.equal(big.truncated, true);
  assert.deepEqual(dropOldest([[0, 1, 'a'], [0, 2, 'b'], [0, 3, 'c'], [0, 4, 1], [0, 5, 'd']], 2), [[0, 3, 'c'], [0, 4, 0], [0, 5, 'd']]);
  assert.deepEqual(dropOldest([[0, 1, 'a'], [0, 2, 'b'], [0, 3, 3], [0, 4, 'c'], [0, 5, 2]], 1), [[0, 2, 'b'], [0, 3, 1], [0, 4, 'c'], [0, 5, 1]]);
  const unused = trimReplay({ kind: 'ink', authors: [{ id: 'zz9', name: 'Nobody' }, ...authors], events: [[1, 0, s(1)], [1, -5, s(2)], [7, 9, s(3)]] });
  assert.deepEqual(unused.authors, authors);
  assert.equal(unused.events.length, 1);
  assert.equal(trimReplay({ kind: 'paint', authors, events: [] }), null);
});

test('Sketch Duel lines are matched to the reported drawing by their ink, even under a new key', () => {
  let t = 0;
  const log = createReplayLog({ now: () => t });
  const players = [{ slot: 4, id: 'aaaa1', name: 'Ann' }, { slot: 7, id: 'bbbb2', name: 'Bo' }];
  const a = encodeStroke({ c: 3, z: 1, pts: [[1, 1], [50, 50]] });
  const b = encodeStroke({ c: 9, z: 2, pts: [[10, 100], [80, 120]] });
  const snap = (phase, ink0, ink1) => ({
    room: { phase: 'game', game: 'sketchduel', round: 1 },
    players,
    state: { sketchduel: { run: 2, round: 1, k: 7, seats: [4, 7], phase }, 'sd.d.0': { k: 7, s: ink0 }, 'sd.d.1': { k: 7, s: ink1 } },
  });
  log.observe(snap('draw', [], []));
  t = 900;
  log.observe(snap('draw', [a], [b]));
  t = 1800;
  const same = snap('draw', [a, b], [b]);
  log.observe(same);
  t = 2700;
  assert.equal(log.observe({ ...same }), false, 'unchanged ink is skipped without decoding');
  const replay = log.replayFor('sketchduel', { d: 'sd.2.1.0', ink: [a, b] });
  assert.deepEqual(replay.authors, [{ id: 'aaaa1', name: 'Ann' }]);
  assert.deepEqual(replay.events, [[0, 900, a], [0, 1800, b]]);
  assert.equal(log.replayFor('sketchduel', { d: 'sd.2.1.1', ink: [b] }).authors[0].id, 'bbbb2');
});
