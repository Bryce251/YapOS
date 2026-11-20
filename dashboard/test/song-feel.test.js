import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../web/js/beat-analyze.js';
import { detectFeel, feelPositions, makeGrid, snapHits, gridFit, layout, STRAIGHT_FEEL, SNAP_MS, RAW_MIN_S } from '../web/js/beat-grid.js';
import { makeCharts } from '../web/js/song-chart.js';
import { beatSummary } from '../web/js/song-editor.js';
import { decodeNotes } from '../web/activity/js/games/beatcodec.js';
import { drumLoop, shuffleLoop, RATE } from './song-synth.js';

const beatsAt = (bpm, n, start = 500) => Array.from({ length: n }, (_, i) => start + (i * 60000) / bpm);
const hitsAt = (beats, fracs, s = 0.6) => {
  const out = [];
  for (let i = 0; i + 1 < beats.length; i++) for (const f of fracs) out.push({ raw: beats[i] + f * (beats[i + 1] - beats[i]), band: 'H', kind: 'hat', s, pitch: 0 });
  return out;
};

test('a shuffled sixteenth groove is found and the grid follows it', () => {
  const beats = beatsAt(90, 40);
  const feel = detectFeel(hitsAt(beats, [0, 0.31, 0.5, 0.81]), beats);
  assert.deepEqual(feel, [0.5, 0.62]);
  const pos = feelPositions(feel).map((p) => Math.round(p[0] * 100) / 100);
  assert.deepEqual(pos, [0, 0.31, 0.5, 0.81]);
  const grid = makeGrid(beats, false, feel);
  assert.equal(grid.length, (beats.length - 1) * 4 + 1);
  assert.deepEqual(grid.slice(0, 4).map((g) => g.q), [4, 1, 2, 1]);
});

test('a swung eighth groove moves the offbeat and keeps straight songs straight', () => {
  const beats = beatsAt(78, 40);
  const feel = detectFeel(hitsAt(beats, [0, 0.58]), beats);
  assert.equal(feel[0], 0.58);
  assert.equal(detectFeel(hitsAt(beats, [0, 0.25, 0.5, 0.75]), beats), STRAIGHT_FEEL);
  assert.equal(detectFeel(hitsAt(beats, [0, 0.52]), beats), STRAIGHT_FEEL);
  assert.equal(detectFeel(hitsAt(beats.slice(0, 4), [0, 0.62]), beats.slice(0, 4)), STRAIGHT_FEEL);
});

test('a swing guess that does not fit the hits better is thrown away', () => {
  const beats = beatsAt(100, 40);
  const hits = hitsAt(beats, [0, 0.5]).concat(hitsAt(beats, [0.6], 0.05));
  assert.deepEqual(detectFeel(hits, beats), STRAIGHT_FEEL);
  const straight = makeGrid(beats);
  assert.ok(gridFit(hitsAt(beats, [0, 0.5]), straight) > 0);
  assert.equal(gridFit(hitsAt(beats, [0.37]), straight), 0);
});

test('a strong hit far from the grid keeps its real time and a weak one is snapped', () => {
  const beats = beatsAt(120, 8);
  const grid = makeGrid(beats);
  const g = grid[4];
  const strong = { raw: g.t + SNAP_MS + 30, band: 'L', kind: 'kick', s: 0.9, pitch: 0 };
  const weak = { raw: g.t + SNAP_MS + 30, band: 'H', kind: 'hat', s: RAW_MIN_S / 2, pitch: 0 };
  const close = { raw: g.t + 8, band: 'M', kind: 'snare', s: 0.9, pitch: 0 };
  const out = snapHits([strong, weak, close], grid);
  const by = Object.fromEntries(out.map((o) => [o.band, o]));
  assert.equal(by.L.t, Math.round(strong.raw));
  assert.equal(by.H.t, Math.round(grid[by.H.gi].t));
  assert.equal(by.M.t, Math.round(g.t));
});

test('a shuffled song is charted on its real hits at every difficulty', () => {
  const { pcm, hits, bpm } = shuffleLoop(90, 40, 0.62);
  const a = analyze(pcm, RATE);
  assert.ok(Math.abs(a.bpm - bpm) <= 1, `tempo ${a.bpm}`);
  assert.equal(a.swing, false);
  assert.ok(a.feel[1] > 0.56 && a.feel[1] < 0.68, `feel ${a.feel}`);
  assert.match(beatSummary(a), /light swing feel/);
  const truth = [...hits.kick, ...hits.snare, ...hits.hat].sort((x, y) => x - y);
  const off = (t) => truth.reduce((m, x) => Math.min(m, Math.abs(x - t)), Infinity);
  const charts = makeCharts(a, { start: 0, end: 40000, seed: 1 });
  for (const id of ['hard', 'expert']) {
    const notes = decodeNotes(charts.d[id]);
    const good = notes.filter((n) => off(n.t) <= 25).length;
    assert.ok(good / notes.length >= 0.97, `${id} ${good}/${notes.length} on real hits`);
    assert.ok(notes.some((n) => { const i = a.beats.findIndex((b, k) => b <= n.t && a.beats[k + 1] > n.t); return i >= 0 && Math.abs((n.t - a.beats[i]) / (a.beats[i + 1] - a.beats[i]) - 0.31) < 0.04; }), `${id} uses the shuffled sixteenths`);
  }
});

test('a straight song keeps the straight grid and summary', () => {
  const { pcm } = drumLoop(120, 40);
  const a = analyze(pcm, RATE);
  assert.deepEqual(a.feel, [0.5, 0.5]);
  assert.match(beatSummary(a), /straight feel/);
  const again = layout(a, a.beats, a.downbeat, a.meter);
  assert.deepEqual(again.feel, a.feel);
});

test('feel files have no comments and plain ASCII', () => {
  for (const f of ['../web/js/beat-grid.js', '../web/js/song-editor.js', './song-synth.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/(^|[^:'"])\/\/\s/.test(src) || src.includes('/*'), false, f);
    assert.deepEqual([...src].filter((c) => c.codePointAt(0) > 127), [], f);
  }
});
