import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, fft, mixDown, classify, SR } from '../web/js/beat-analyze.js';
import { makeCharts, chartStats, bestPart, snapToDownbeat, legalize, candidates, CHART_DIFFS } from '../web/js/song-chart.js';
import { handleAnalyzeMessage } from '../web/js/beat-analyze-worker.js';
import { validateCharts, decodeNotes, DIFF_IDS, NPS_CAPS, LANE_REST_MS } from '../web/activity/js/games/beatcodec.js';
import { clickTrack, drumLoop, swingLoop, RATE } from './song-synth.js';

const near = (list, t) => list.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);

const loop = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    const bpm = 128;
    const p = 60 / bpm;
    const track = drumLoop(bpm, 64, { loudFrom: 32, sustains: [[0.5 + p * 32, 2], [0.5 + p * 80, 1.5]] });
    cached = { ...track, bpm, analysis: analyze(track.pcm, RATE) };
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
  assert.equal(SR, 44100);
});

for (const bpm of [100, 128]) {
  test(`a click track at ${bpm} BPM gives the right tempo, beats and onsets`, () => {
    const { pcm, beats } = clickTrack(bpm);
    const a = analyze(pcm, RATE);
    assert.ok(Math.abs(a.bpm - bpm) <= 0.5, `tempo ${a.bpm}`);
    for (const b of beats.slice(2, -2)) assert.ok(Math.abs(near(a.beats, b) - b) <= 15, `beat near ${b}`);
    const hits = a.onsets.map((o) => o.raw);
    for (const b of beats.slice(1, -1)) assert.ok(Math.abs(near(hits, b) - b) <= 15, `onset near ${b}`);
    assert.ok(a.b0 >= 0 && a.b0 <= 5000);
    assert.equal(a.swing, false);
    assert.ok(a.onsets.every((o) => o.t === Math.round(a.grid[o.gi].t)), 'every onset sits on the grid');
  });
}

test('a fast click track may read at half tempo but always on the real beats', () => {
  const { pcm, beats } = clickTrack(150);
  const a = analyze(pcm, RATE);
  assert.ok(Math.abs(a.bpm - 150) <= 0.5 || Math.abs(a.bpm - 75) <= 0.5, `tempo ${a.bpm}`);
  for (const b of a.beats.filter((t) => t > 1000 && t < 38000)) assert.ok(Math.abs(near(beats, b) - b) <= 15, `beat ${b} on a click`);
});

test('kicks, hi-hats and held notes get their own kind', () => {
  const { hits, analysis } = loop();
  const share = (kind, list) => {
    const got = analysis.onsets.filter((o) => o.kind === kind).map((o) => o.raw);
    return list.filter((t) => Math.abs(near(got, t) - t) <= 20).length / list.length;
  };
  const hatOnly = hits.hat.filter((t) => !hits.kick.some((k) => Math.abs(k - t) < 5) && !hits.snare.some((k) => Math.abs(k - t) < 5));
  assert.ok(share('kick', hits.kick) >= 0.9, 'kicks');
  assert.ok(share('hat', hatOnly) >= 0.9, 'hats');
  assert.ok(Math.abs(analysis.bpm - 128) <= 0.5);
  assert.ok([2, 4].includes(analysis.meter));
  assert.equal(classify({ low: 0.05, mid: 0.1, high: 0.85, flat: 0.15, len: 0, rise: 0.3 }), 'hat');
  assert.equal(classify({ low: 0.05, mid: 0.1, high: 0.85, flat: 0.45, len: 100, rise: 1.2 }), 'snare');
  assert.equal(classify({ low: 0.7, mid: 0.2, high: 0.1, flat: 0.3, len: 60, rise: 4 }), 'kick');
  assert.equal(classify({ low: 0.3, mid: 0.45, high: 0.25, flat: 0.3, len: 500, rise: 1.8 }), 'tonal');
});

test('a held tone is found as a sustain with its pitch', () => {
  const { analysis, p } = loop();
  const at = (0.5 + p * 32) * 1000;
  const s = analysis.sustains.find((x) => Math.abs(x.t - at) <= 30);
  assert.ok(s, 'sustain found');
  assert.ok(s.end - s.t >= 1500 && s.end - s.t <= 3000);
  assert.equal(s.pitch, 69);
});

test('quiet and loud parts are told apart and the loud part starts with a drop', () => {
  const { analysis } = loop();
  const quiet = analysis.energy.filter((w) => w.end <= 12000);
  const loud = analysis.energy.filter((w) => w.t >= 33000);
  assert.ok(quiet.every((w) => w.rank < 0.5));
  assert.ok(loud.filter((w) => w.rank >= 0.5).length >= loud.length * 0.6);
  assert.equal(analysis.energy[0].label, 'intro');
  assert.ok(analysis.marks.some(([t]) => Math.abs(t - 32000) < 3000), 'the loud part is marked');
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
  const chords = ex.filter((n, i) => i > 0 && ex[i - 1].t === n.t);
  assert.ok(chords.length >= 3, `expert chords ${chords.length}`);
  const easyT = decodeNotes(charts.d.easy).map((n) => n.t);
  const normalT = new Set(decodeNotes(charts.d.normal).map((n) => n.t));
  assert.ok(easyT.filter((t) => normalT.has(t)).length / easyT.length >= 0.8);
});

test('every note sits on a real hit snapped to the grid for its difficulty', () => {
  const { analysis } = loop();
  const charts = makeCharts(analysis, { start: 0, end: 60000, seed: 5 });
  const raw = analysis.onsets.map((o) => o.raw);
  const byT = new Map(analysis.grid.map((g) => [Math.round(g.t), g]));
  const want = { easy: 4, normal: 2 };
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    for (const n of notes) {
      assert.ok(Math.abs(near(raw, n.t) - n.t) <= 40, `${id} note at ${n.t} is on a hit`);
      const g = byT.get(n.t);
      assert.ok(g, `${id} note at ${n.t} is on the grid`);
      if (want[id]) assert.ok(g.q >= want[id], `${id} note at ${n.t} has grid level ${g.q}`);
    }
  }
});

test('quiet parts get fewer notes than loud parts', () => {
  const { analysis } = loop();
  const charts = makeCharts(analysis, { start: 0, end: 60000, seed: 5 });
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    const quiet = notes.filter((n) => n.t < 12000).length / 10.5;
    const loud = notes.filter((n) => n.t >= 33000 && n.t < 59500).length / 26.5;
    assert.ok(loud > quiet * 1.15, `${id} quiet ${quiet.toFixed(2)} loud ${loud.toFixed(2)}`);
  }
});

test('lanes follow the drums and repeated bars repeat their lanes', () => {
  const { analysis } = loop();
  const charts = makeCharts(analysis, { start: 0, end: 60000, seed: 5 });
  const cands = candidates(analysis, 0, 60000);
  const kindAt = new Map(cands.map((c) => [Math.round(c.t), c.kind]));
  const notes = decodeNotes(charts.d.normal).filter((n, i, all) => !all.some((m, j) => j !== i && m.t === n.t));
  const kicks = notes.filter((n) => kindAt.get(n.t) === 'kick');
  const phrase = (t) => Math.floor((t - analysis.b0) / ((60000 / analysis.bpm) * analysis.meter * 4));
  const sameHand = kicks.filter((n, i) => i > 0 && phrase(kicks[i - 1].t) === phrase(n.t) && (kicks[i - 1].l < 2) === (n.l < 2)).length;
  const pairs = kicks.filter((n, i) => i > 0 && phrase(kicks[i - 1].t) === phrase(n.t)).length;
  assert.ok(sameHand / pairs >= 0.8, `kicks keep their hand ${sameHand}/${pairs}`);
  const downs = analysis.beats.filter((_, i) => (((i - analysis.downbeat) % analysis.meter) + analysis.meter) % analysis.meter === 0);
  const bars = new Map();
  for (const n of decodeNotes(charts.d.hard)) {
    let bar = 0;
    while (bar + 1 < downs.length && downs[bar + 1] <= n.t) bar += 1;
    if (!bars.has(bar)) bars.set(bar, []);
    bars.get(bar).push([Math.round((n.t - downs[bar]) / 10), n.l]);
  }
  const seen = new Map();
  const keys = [];
  for (const list of bars.values()) {
    const flip = list[0][1] >= 2;
    const k = list.map(([t, l]) => `${t}:${flip ? 3 - l : l}`).join(',');
    keys.push(k);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const repeats = keys.filter((k) => seen.get(k) > 1).length;
  assert.ok(repeats / keys.length >= 0.3, `repeated bars ${repeats}/${keys.length}`);
});

test('a swung song is charted on triplets', () => {
  const { pcm, bpm } = swingLoop(96, 40);
  const a = analyze(pcm, RATE);
  assert.ok(Math.abs(a.bpm - bpm) <= 1 || Math.abs(a.bpm - bpm / 2) <= 1, `tempo ${a.bpm}`);
  assert.equal(a.swing, true);
  const charts = makeCharts(a, { start: 0, end: 40000, seed: 1 });
  const byT = new Map(a.grid.map((g) => [Math.round(g.t), g]));
  const normal = decodeNotes(charts.d.normal);
  assert.ok(normal.some((n) => byT.get(n.t) && byT.get(n.t).k === 2), 'swung eighths are used');
  for (const n of normal) assert.ok(byT.get(n.t), `on the triplet grid ${n.t}`);
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
  assert.notDeepEqual(a.d.expert, c.d.expert);
});

test('a later section is rebased to zero, fits inside its length and starts on a bar', () => {
  const { analysis } = loop();
  const start = snapToDownbeat(analysis, 20000);
  const charts = makeCharts(analysis, { start, end: start + 30000, seed: 2 });
  assert.equal(charts.len, 30000);
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    assert.ok(notes[0].t >= 1500);
    assert.ok(notes.every((n) => (n.e ?? n.t) <= 29500));
  }
  assert.ok(charts.b0 >= 0 && charts.b0 < 2000);
  assert.ok(Math.abs(charts.bpm - 128) <= 0.5);
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
  assert.equal(CHART_DIFFS.easy.q, 4);
  assert.equal(CHART_DIFFS.normal.q, 2);
});

test('silence gives no beat instead of a made up tempo', () => {
  const a = analyze(new Float32Array(RATE * 35), RATE);
  assert.equal(a.bpm, 0);
  assert.deepEqual(a.beats, []);
  assert.deepEqual(a.onsets, []);
});

test('the analyzer worker reports progress, passes the tempo hint and returns its result', () => {
  const { pcm } = clickTrack(120, 31);
  const posts = [];
  handleAnalyzeMessage({ id: 4, pcm, sr: RATE }, (m) => posts.push(m));
  const done = posts.find((m) => m.type === 'done');
  assert.ok(posts.some((m) => m.type === 'progress' && m.p > 0 && m.p < 1));
  assert.equal(done.id, 4);
  assert.ok(Math.abs(done.analysis.bpm - 120) <= 0.5);
  const hinted = [];
  handleAnalyzeMessage({ id: 6, pcm, sr: RATE, hint: 240 }, (m) => hinted.push(m));
  assert.ok(Math.abs(hinted.find((m) => m.type === 'done').analysis.bpm - 240) <= 2);
  const bad = [];
  handleAnalyzeMessage({ id: 5, pcm: null }, (m) => bad.push(m));
  assert.equal(bad[0].type, 'error');
});

test('analyzer and chart files have no comments', () => {
  for (const f of ['../web/js/beat-analyze.js', '../web/js/beat-analyze-worker.js', '../web/js/beat-grid.js', '../web/js/song-chart.js', '../web/activity/js/games/beatcodec.js', '../worker/songs.js', './song-synth.js', './song-fixtures.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/(^|[^:'"])\/\/\s/.test(src) || src.includes('/*'), false, f);
    if (!f.includes('worker/')) assert.deepEqual([...src].filter((c) => c.codePointAt(0) > 127), [], f);
  }
});
