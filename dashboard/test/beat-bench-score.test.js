import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmeasure, merge, scoreBeats, scoreTempo, scoreOnsets, scoreSong } from './beat-bench/score.js';
import { resample } from './beat-bench/resample.js';
import { Song } from './beat-bench/song.js';
import { SONGS } from './beat-bench/songs.js';

const grid = (p, n, t0 = 0.5) => Array.from({ length: n }, (_, i) => t0 + i * p);

test('beat f-measure counts hits inside 70 ms only once', () => {
  const ref = grid(0.5, 20);
  assert.equal(fmeasure(ref, ref.map((t) => t + 0.06), 0.07).f, 1);
  assert.equal(fmeasure(ref, ref.map((t) => t + 0.08), 0.07).f, 0);
  const dup = fmeasure(ref, [...ref, ...ref.map((t) => t + 0.01)], 0.07);
  assert.equal(dup.r, 1);
  assert.equal(dup.p, 0.5);
});

test('metrical level errors score zero strict but full at any level', () => {
  const ref = grid(0.5, 40);
  const dbl = scoreBeats(ref, grid(0.25, 79));
  assert.ok(dbl.f < 0.7);
  assert.equal(dbl.anyF, 1);
  assert.equal(dbl.anyLevel, 'double');
  const off = scoreBeats(ref, ref.slice(0, -1).map((t) => t + 0.25));
  assert.equal(off.f, 0);
  assert.equal(off.anyLevel, 'offbeat');
});

test('tempo accuracy flags octave and ternary errors separately', () => {
  assert.equal(scoreTempo([120], 123).flag, 'ok');
  assert.equal(scoreTempo([120], 240).flag, 'x2');
  assert.equal(scoreTempo([120], 240).acc2, 1);
  assert.equal(scoreTempo([120], 240).acc1, 0);
  assert.equal(scoreTempo([165], 110).flag, 'x2/3');
  assert.equal(scoreTempo([165], 110).acc2, 0);
  assert.equal(scoreTempo([100, 128], 127).flag, 'ok');
  assert.equal(scoreTempo([120], 130).flag, 'wrong');
});

test('onset scoring merges chords and ignores detections on soft onsets', () => {
  const truth = [
    { t: 1, band: 'L', soft: false },
    { t: 1.005, band: 'H', soft: false },
    { t: 2, band: 'M', soft: true },
    { t: 3, band: 'M', soft: false },
  ];
  assert.deepEqual(merge([1, 1.005, 1.04, 1.2]), [1, 1.04, 1.2]);
  const s = scoreOnsets(truth, [{ t: 1.01, band: 'L' }, { t: 2.02, band: 'M' }, { t: 3.04, band: 'M' }, { t: 4, band: 'H' }]);
  assert.equal(s.tp, 2);
  assert.equal(s.ignored, 1);
  assert.equal(s.nEst, 3);
  assert.equal(s.nRef, 2);
});

test('a perfect detector scores 100', () => {
  const truth = { beats: grid(0.5, 16), downbeats: grid(2, 4), meter: 4, tempos: [120], onsets: grid(0.25, 32).map((t) => ({ t, band: 'H', soft: false })) };
  const s = scoreSong(truth, { bpm: 120, beats: truth.beats, downbeats: truth.downbeats, onsets: truth.onsets }, 8);
  assert.ok(Math.abs(s.score - 1) < 1e-9);
});

test('resampler keeps a tone at the same frequency and level', () => {
  const sr = 44100;
  const x = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 441 * i) / sr));
  const y = resample(x, sr, 22050);
  assert.equal(y.length, 22050);
  let err = 0;
  for (let i = 100; i < 22000; i++) err = Math.max(err, Math.abs(y[i] - Math.sin((2 * Math.PI * 441 * i) / 22050)));
  assert.ok(err < 0.02);
});

test('song beat maps follow tempo changes and the bench has 16 songs', () => {
  assert.equal(SONGS.length, 16);
  const s = new Song({ id: 'x', genre: 'x', bpm: 100, secs: 30, seed: 1, tempo: (i) => (i < 16 ? 100 : 150) });
  assert.ok(Math.abs(s.beats[1] - s.beats[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(s.beats[17] - s.beats[16] - 0.4) < 1e-9);
  assert.ok(Math.abs(s.at(16.5) - (s.beats[16] + 0.2)) < 1e-9);
  const t = s.truth();
  assert.deepEqual(t.tempos.sort(), [100, 150]);
});
