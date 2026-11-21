import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../web/js/beat-analyze.js';
import { makeGrid, snapHits, SNAP_KEEP_MS, SPLIT_MS, RAW_MIN_S } from '../web/js/beat-grid.js';
import { makeChartsInfo, candidates, legalize, faint, tunedConfig, CHART_DIFFS, CHORD_WEIGHT, FAINT } from '../web/js/song-chart.js';
import { decodeNotes, objectCount, DIFF_IDS, NPS_CAPS } from '../web/activity/js/games/beatcodec.js';
import { SONGS, finishSong } from './beat-bench/songs.js';
import { merge } from './beat-bench/score.js';

const WIN = 50;
const PICK = Object.freeze({ 'pop-118': 0, 'edm-128': 1, 'funk-104': 10 });
const FLOORS = Object.freeze({
  'pop-118': { easy: 0.4, normal: 0.65, hard: 0.72, expert: 0.97 },
  'edm-128': { easy: 0.17, normal: 0.3, hard: 0.55, expert: 0.88 },
  'funk-104': { easy: 0.26, normal: 0.5, hard: 0.8, expert: 0.95 },
});

const made = new Map();
function song(id) {
  if (!made.has(id)) {
    const s = finishSong(SONGS[PICK[id]]());
    const a = analyze(s.pcm, s.sampleRate);
    const lo = 1500;
    const hi = a.dur - 500;
    const hard = merge(s.truth.onsets.filter((o) => !o.soft).map((o) => o.t)).map((t) => t * 1000).filter((t) => t >= lo && t <= hi);
    const any = s.truth.onsets.map((o) => o.t * 1000).sort((x, y) => x - y);
    made.set(id, { s, a, hard, any });
  }
  return made.get(id);
}

function nearest(sorted, t) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = Infinity;
  for (const k of [lo - 1, lo]) if (k >= 0 && k < sorted.length) best = Math.min(best, Math.abs(sorted[k] - t));
  return best;
}

function coverage(id, notes) {
  const { hard, any } = song(id);
  const times = [...new Set(notes.map((n) => n.t))].sort((x, y) => x - y);
  const errs = [];
  for (const t of hard) {
    const d = nearest(times, t);
    if (d <= WIN) errs.push(d);
  }
  errs.sort((x, y) => x - y);
  return {
    recall: errs.length / hard.length,
    fake: times.filter((t) => nearest(any, t) > WIN).length,
    notes: times.length,
    median: errs[errs.length >> 1],
    p95: errs[Math.floor(errs.length * 0.95)],
  };
}

for (const id of Object.keys(PICK)) {
  test(`${id} Auto charts cover the song's hits at every level`, () => {
    const { a } = song(id);
    const info = makeChartsInfo(a, { start: 0, end: a.dur, seed: 1 });
    let prev = 0;
    for (const lid of DIFF_IDS) {
      const c = coverage(id, decodeNotes(info.charts.d[lid]));
      assert.ok(c.recall >= FLOORS[id][lid], `${id} ${lid} covers ${(c.recall * 100).toFixed(1)}% of hits`);
      assert.ok(c.recall >= prev, `${id} ${lid} covers at least as much as the level below`);
      prev = c.recall;
    }
  });
}

test('chart notes stay on the real time of each hit', () => {
  for (const id of Object.keys(PICK)) {
    const { a } = song(id);
    const info = makeChartsInfo(a, { start: 0, end: a.dur, seed: 1 });
    for (const lid of DIFF_IDS) {
      const c = coverage(id, decodeNotes(info.charts.d[lid]));
      assert.ok(c.median <= 6, `${id} ${lid} median timing error ${c.median} ms`);
      assert.ok(c.p95 <= 15, `${id} ${lid} 95th percentile timing error ${c.p95} ms`);
    }
  }
});

test('denser charts do not add notes where the song has no hit', () => {
  for (const id of Object.keys(PICK)) {
    const { a } = song(id);
    const info = makeChartsInfo(a, { start: 0, end: a.dur, seed: 1 });
    for (const lid of DIFF_IDS) {
      const c = coverage(id, decodeNotes(info.charts.d[lid]));
      assert.ok(c.fake <= Math.max(1, Math.floor(c.notes * 0.01)), `${id} ${lid} has ${c.fake} notes with no hit near them out of ${c.notes}`);
    }
  }
});

test('quiet sixteenth notes under the drums are still found', () => {
  const { a, hard } = song('edm-128');
  const raw = a.hits.map((h) => h.raw).sort((x, y) => x - y);
  const found = hard.filter((t) => nearest(raw, t) <= WIN).length / hard.length;
  assert.ok(found >= 0.9, `edm-128 detector finds ${(found * 100).toFixed(1)}% of hits`);
  const { any } = song('edm-128');
  const real = raw.filter((t) => t >= 1500 && t <= a.dur - 500);
  const kept = real.filter((t) => nearest(any, t) <= WIN).length / real.length;
  assert.ok(kept >= 0.98, `edm-128 detector hits on real notes ${(kept * 100).toFixed(1)}%`);
});

test('Expert steps still change how many notes there are', () => {
  const { a } = song('edm-128');
  const cache = {};
  const at = (s) => objectCount(decodeNotes(makeChartsInfo(a, { start: 0, end: a.dur, seed: 1, tune: [0, 0, 0, s], cache }).charts.d.expert));
  const row = [-3, -2, -1, 0, 1, 2, 3].map(at);
  for (let k = 1; k < row.length; k++) assert.ok(row[k] >= row[k - 1], `expert ${row}`);
  assert.ok(row[2] < row[3], `easier Expert has fewer notes ${row}`);
  assert.ok(row[4] > row[3], `harder Expert has more notes ${row}`);
});

test('two hits in one grid slot both stay when they are far enough apart to play', () => {
  const beats = Array.from({ length: 8 }, (_, i) => 500 + i * 1000);
  const grid = makeGrid(beats);
  const g = grid[4];
  const first = { raw: g.t + 2, band: 'H', kind: 'hat', s: 0.8, pitch: 0 };
  const second = { raw: g.t + 2 + SPLIT_MS + 20, band: 'H', kind: 'hat', s: 0.6, pitch: 0 };
  const flam = { raw: g.t + 2 + SPLIT_MS / 2, band: 'H', kind: 'hat', s: 0.3, pitch: 0 };
  const out = snapHits([first, second, flam], grid);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, Math.round(g.t));
  assert.equal(out[1].t, Math.round(second.raw));
  const analysis = { onsets: out, grid, beats, downbeat: 0, meter: 4, energy: [] };
  const c = candidates(analysis, -2000, 10000);
  assert.equal(c.length, 2);
  assert.notEqual(c[0].gi, c[1].gi);
  assert.ok(c[1].q === 1);
});

test('a strong hit just off the grid keeps its time and a close one snaps', () => {
  const beats = Array.from({ length: 8 }, (_, i) => 500 + i * 500);
  const grid = makeGrid(beats);
  const g = grid[6];
  const off = { raw: g.t + SNAP_KEEP_MS + 4, band: 'L', kind: 'kick', s: 0.9, pitch: 0 };
  const close = { raw: g.t + SNAP_KEEP_MS - 4, band: 'M', kind: 'snare', s: 0.9, pitch: 0 };
  const weak = { raw: g.t + SNAP_KEEP_MS + 4, band: 'H', kind: 'hat', s: RAW_MIN_S / 2, pitch: 0 };
  const by = Object.fromEntries(snapHits([off, close, weak], grid).map((o) => [o.band, o]));
  assert.equal(by.L.t, Math.round(off.raw));
  assert.equal(by.M.t, Math.round(g.t));
  assert.equal(by.H.t, Math.round(g.t));
});

test('caps drop the second note of a chord before any single hit', () => {
  const notes = [];
  for (let i = 0; i < 20; i++) {
    const t = 2000 + i * 110;
    notes.push({ t, l: i % 4, w: 1 });
    if (i % 2 === 0) notes.push({ t, l: (i + 2) % 4, w: 1 - CHORD_WEIGHT });
  }
  const out = legalize(notes, 'expert', 10000);
  const times = new Set(out.map((n) => n.t));
  assert.ok(out.length < notes.length);
  for (let i = 0; i < 20; i++) assert.ok(times.has(2000 + i * 110), `single hit ${i} kept`);
  let j = 0;
  for (let i = 0; i < out.length; i++) {
    while (out[i].t - out[j].t >= 1000) j += 1;
    assert.ok(i - j + 1 <= NPS_CAPS.expert);
  }
});

test('a faint hit off the beat is not charted but a faint hit on the beat is', () => {
  assert.equal(faint({ s: FAINT.s / 2, q: 1, off: 0 }), true);
  assert.equal(faint({ s: FAINT.s / 2, q: 4, off: FAINT.off + 0.05 }), true);
  assert.equal(faint({ s: FAINT.edgeS - 0.005, q: 2, off: FAINT.edgeOff + 0.02 }), true);
  assert.equal(faint({ s: FAINT.s / 2, q: 4, off: 0 }), false);
  assert.equal(faint({ s: 0.5, q: 1, off: 0.4 }), false);
});

test('Expert aims to cover nearly every hit and steps scale it', () => {
  assert.ok(CHART_DIFFS.expert.cover >= 0.95);
  for (const id of ['easy', 'normal', 'hard']) assert.equal(CHART_DIFFS[id].cover, undefined);
  assert.ok(tunedConfig('expert', -1).cover < tunedConfig('expert', 0).cover);
  assert.ok(tunedConfig('expert', -3).cover < tunedConfig('expert', -1).cover);
  assert.equal(tunedConfig('expert', 2).cover, 1);
});

test('coverage test file has no comments', () => {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const slash = String.fromCharCode(47);
  assert.ok(!src.includes(slash + slash + ' ') && !src.includes(slash + '*'));
});
