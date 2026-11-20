import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, fft, mixDown } from '../web/js/beat-analyze.js';
import { makeCharts, chartStats, bestPart, snapToDownbeat, legalize, CHART_DIFFS } from '../web/js/song-chart.js';
import { handleAnalyzeMessage } from '../web/js/beat-analyze-worker.js';
import { validateCharts, decodeNotes, DIFF_IDS, NPS_CAPS, LANE_REST_MS } from '../web/activity/js/games/beatcodec.js';
import { clickTrack, drumLoop } from './song-synth.js';

const near = (list, t) => list.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);

const loop = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    const bpm = 128;
    const p = 60 / bpm;
    const track = drumLoop(bpm, 64, { loudFrom: 32, sustains: [[0.5 + p * 32, 2], [0.5 + p * 80, 1.5]] });
    cached = { ...track, bpm, analysis: analyze(track.pcm) };
    return cached;
  };
})();

test('the FFT finds a pure tone in the right bin', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 32 * i) / n);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = Float64Array.from({ length: n / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / n));
  const sin = Float64Array.from({ length: n / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / n));
  fft(re, im, { n, rev, cos, sin });
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.equal(best, 32);
  assert.deepEqual(Array.from(mixDown([Float32Array.of(1, 0), Float32Array.of(0, 1)])), [0.5, 0.5]);
});

for (const bpm of [100, 128, 150]) {
  test(`a click track at ${bpm} BPM gives the right tempo, beats and onsets`, () => {
    const { pcm, beats } = clickTrack(bpm);
    const a = analyze(pcm);
    assert.ok(Math.abs(a.bpm - bpm) <= 0.5, `tempo ${a.bpm}`);
    for (const b of beats.slice(2, -2)) assert.ok(Math.abs(near(a.beats, b) - b) <= 15, `beat near ${b}`);
    const hits = a.onsets.filter((o) => o.band === 'M').map((o) => o.raw);
    for (const b of beats.slice(1, -1)) assert.ok(Math.abs(near(hits, b) - b) <= 15, `onset near ${b}`);
    assert.ok(a.b0 >= 0 && a.b0 <= 5000);
  });
}

test('kick, snare and hats land in their own bands', () => {
  const { hits, analysis } = loop();
  const inBand = (band, list) => {
    const got = analysis.onsets.filter((o) => o.band === band).map((o) => o.raw);
    return list.filter((t) => Math.abs(near(got, t) - t) <= 20).length / list.length;
  };
  assert.ok(inBand('L', hits.kick) >= 0.9, 'kicks in L');
  assert.ok(inBand('M', hits.snare) >= 0.9, 'snares in M');
  assert.ok(inBand('H', hits.hat) >= 0.9, 'hats in H');
  assert.ok(Math.abs(analysis.bpm - 128) <= 0.5);
  const kicks = analysis.onsets.filter((o) => o.band === 'L' && o.q === 4);
  assert.ok(kicks.length >= hits.kick.length * 0.9);
});

test('a held tone is found as a sustain', () => {
  const { analysis, p } = loop();
  const at = (0.5 + p * 32) * 1000;
  const s = analysis.sustains.find((x) => Math.abs(x.t - at) <= 30);
  assert.ok(s, 'sustain found');
  assert.ok(s.end - s.t >= 1500 && s.end - s.t <= 3000);
  assert.ok(analysis.sustains.every((x) => x.band !== 'H'));
});

test('charts get denser with difficulty and follow every rule', () => {
  const { analysis } = loop();
  const charts = makeCharts(analysis, { start: 0, end: 60000, seed: 5 });
  assert.deepEqual(validateCharts(charts, 60000), charts);
  const stats = chartStats(charts);
  const counts = DIFF_IDS.map((id) => stats[id].objects);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `counts ${counts}`);
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    assert.ok(stats[id].peak <= NPS_CAPS[id]);
    const free = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (const n of notes) {
      assert.ok(n.l >= 0 && n.l <= 3);
      assert.ok(n.t >= free[n.l], `${id} lane ${n.l} at ${n.t}`);
      free[n.l] = (n.e ?? n.t) + LANE_REST_MS;
    }
    const used = new Set(notes.map((n) => n.l));
    assert.equal(used.size, 4, `${id} uses all four lanes`);
  }
  assert.equal(stats.easy.holds + stats.normal.holds, 0);
  assert.ok(stats.expert.holds >= 1, 'expert has a hold');
  const ex = decodeNotes(charts.d.expert);
  const chords = ex.filter((n, i) => i > 0 && ex[i - 1].t === n.t).length;
  assert.ok(chords >= 3, `expert chords ${chords}`);
  const easyT = decodeNotes(charts.d.easy).map((n) => n.t);
  const normalT = new Set(decodeNotes(charts.d.normal).map((n) => n.t));
  assert.ok(easyT.filter((t) => normalT.has(t)).length / easyT.length >= 0.8);
});

test('the expert hold sits on the held tone', () => {
  const { analysis, p } = loop();
  const charts = makeCharts(analysis, { start: 0, end: 60000, seed: 5 });
  const at = (0.5 + p * 32) * 1000;
  const holds = decodeNotes(charts.d.expert).filter((n) => n.e !== undefined);
  assert.ok(holds.some((n) => Math.abs(n.t - at) <= 30 && n.e - n.t >= 400));
  for (const h of holds) {
    const during = decodeNotes(charts.d.expert).filter((n) => n.l === h.l && n.t > h.t && n.t < h.e + LANE_REST_MS);
    assert.equal(during.length, 0);
  }
});

test('charts are the same for the same seed and change with a new one', () => {
  const { analysis } = loop();
  const a = makeCharts(analysis, { start: 0, end: 60000, seed: 9 });
  const b = makeCharts(analysis, { start: 0, end: 60000, seed: 9 });
  const c = makeCharts(analysis, { start: 0, end: 60000, seed: 10 });
  assert.deepEqual(a, b);
  assert.equal(c.v, 1);
  assert.equal(JSON.stringify(a.d.easy.filter((_, i) => i % 2 === 0)), JSON.stringify(c.d.easy.filter((_, i) => i % 2 === 0)));
});

test('a later section is rebased to zero and fits inside its length', () => {
  const { analysis } = loop();
  const start = snapToDownbeat(analysis, 20000);
  const charts = makeCharts(analysis, { start, end: start + 30000, seed: 2 });
  assert.equal(charts.len, 30000);
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    assert.ok(notes[0].t >= 1500);
    assert.ok(notes.every((n) => (n.e ?? n.t) <= 29500));
  }
  assert.ok(charts.b0 >= 0 && charts.b0 < 1000);
});

test('finding the best part picks the loud half', () => {
  const { analysis } = loop();
  const s = bestPart(analysis, 30000);
  assert.ok(s >= 26000, `start ${s}`);
  assert.ok(s + 30000 <= analysis.dur);
  assert.equal(bestPart({ ...analysis, dur: 20000 }, 30000), 0);
});

test('legalize enforces the rules on any input', () => {
  const messy = [
    { t: 100, l: 0 }, { t: 2000, l: 0 }, { t: 2000, l: 1 }, { t: 2000, l: 2 }, { t: 2010, l: 0 },
    { t: 3000, l: 1, e: 4000 }, { t: 3500, l: 1 }, { t: 3500, l: 2 }, { t: 3500, l: 3 }, { t: 59900, l: 0 },
  ];
  const easy = legalize(messy, 'easy', 60000);
  assert.ok(easy.every((n) => n.e === undefined));
  assert.equal(easy.some((n) => n.t === 100 || n.t === 59900), false);
  const hard = legalize(messy, 'hard', 60000);
  assert.equal(hard.filter((n) => n.t === 2000).length, 2);
  assert.equal(hard.some((n) => n.t === 2010), false);
  assert.ok(hard.some((n) => n.e === 4000));
  assert.equal(hard.filter((n) => n.t === 3500).length, 1);
  assert.equal(CHART_DIFFS.easy.grid, 4);
});

test('the analyzer worker reports progress and its result', () => {
  const { pcm } = clickTrack(120, 31);
  const posts = [];
  handleAnalyzeMessage({ id: 4, pcm, sr: 22050 }, (m) => posts.push(m));
  const done = posts.find((m) => m.type === 'done');
  assert.ok(posts.some((m) => m.type === 'progress' && m.p > 0 && m.p < 1));
  assert.equal(done.id, 4);
  assert.ok(Math.abs(done.analysis.bpm - 120) <= 0.5);
  const bad = [];
  handleAnalyzeMessage({ id: 5, pcm: null }, (m) => bad.push(m));
  assert.equal(bad[0].type, 'error');
});

test('analyzer and chart files have no comments', () => {
  for (const f of ['../web/js/beat-analyze.js', '../web/js/beat-analyze-worker.js', '../web/js/song-chart.js', '../web/activity/js/games/beatcodec.js', '../worker/songs.js', './song-synth.js', './song-fixtures.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/(^|[^:'"])\/\/\s/.test(src) || src.includes('/*'), false, f);
  }
});
