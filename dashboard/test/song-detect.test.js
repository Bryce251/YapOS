import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, analyze, SR } from '../web/js/beat-analyze.js';
import { makeCharts, bestPart } from '../web/js/song-chart.js';
import { decodeNotes, DIFF_IDS, validateCharts } from '../web/activity/js/games/beatcodec.js';
import { SONGS, finishSong } from './beat-bench/songs.js';
import { scoreSong, fmeasure } from './beat-bench/score.js';
import { analyze as judged } from './beat-bench/candidates/final.js';

const JUDGED = Object.freeze({ 'pop-118': 1, 'rock-165': 0.98, 'funk-104': 1 });
const INDEX = Object.freeze({ 'pop-118': 0, 'rock-165': 3, 'funk-104': 10 });
const TOLERANCE = 0.03;

const songs = new Map();
function song(id) {
  if (!songs.has(id)) {
    const made = finishSong(SONGS[INDEX[id]]());
    assert.equal(made.truth.id, id);
    songs.set(id, made);
  }
  return songs.get(id);
}

test('the shipped detector is the judged one, number for number', () => {
  const s = song('pop-118');
  const want = judged(s.pcm, s.sampleRate);
  const got = detect(s.pcm, s.sampleRate);
  assert.deepEqual(got, want);
  assert.equal(s.sampleRate, SR);
});

for (const id of Object.keys(JUDGED)) {
  test(`${id} scores within ${TOLERANCE * 100} points of the judged result`, () => {
    const s = song(id);
    const t0 = performance.now();
    const r = detect(s.pcm, s.sampleRate);
    const ms = performance.now() - t0;
    const score = scoreSong(s.truth, r, s.pcm.length / s.sampleRate);
    assert.ok(score.score >= JUDGED[id] - TOLERANCE, `${id} scored ${(score.score * 100).toFixed(1)}`);
    assert.ok(Math.abs(r.bpm - s.truth.tempo) / s.truth.tempo < 0.02, `${id} tempo ${r.bpm}`);
    assert.ok(ms / (s.pcm.length / s.sampleRate / 60) < 3000, `${id} took ${Math.round(ms)} ms`);
  });
}

test('the product analysis keeps the judged beats, downbeats and tempo', () => {
  const s = song('pop-118');
  const a = analyze(s.pcm, s.sampleRate);
  assert.ok(Math.abs(a.bpm - 118) <= 0.3, `bpm ${a.bpm}`);
  assert.equal(a.meter, 4);
  assert.equal(a.swing, false);
  const beats = a.beats.map((t) => t / 1000);
  assert.ok(fmeasure(s.truth.beats, beats, 0.07).f >= 0.95);
  const downs = beats.filter((_, i) => (((i - a.downbeat) % a.meter) + a.meter) % a.meter === 0);
  assert.ok(fmeasure(s.truth.downbeats, downs, 0.07).f >= 0.9);
  assert.ok(a.env.length > 0 && a.env.every((v) => v >= 0 && v <= 100));
});

test('drums and notes in real-sounding songs are told apart', () => {
  const tally = {};
  for (const id of Object.keys(JUDGED)) {
    const s = song(id);
    const a = analyze(s.pcm, s.sampleRate);
    const on = s.truth.onsets.filter((o) => !o.soft);
    for (const o of on) {
      if (on.some((x) => x !== o && Math.abs(x.t - o.t) < 0.04)) continue;
      const group = ['kick', 'snare', 'hat'].includes(o.inst) ? o.inst : ['bass', 'lead', 'piano', 'chords', 'guitar', 'slap', 'horns'].includes(o.inst) ? 'tonal' : null;
      if (!group) continue;
      const hit = a.onsets.find((x) => Math.abs(x.raw / 1000 - o.t) <= 0.03);
      if (!hit) continue;
      tally[group] = tally[group] || { n: 0, ok: 0 };
      tally[group].n += 1;
      if (hit.kind === group || (group === 'tonal' && hit.kind !== 'hat')) tally[group].ok += 1;
    }
  }
  for (const [g, v] of Object.entries(tally)) assert.ok(v.ok / v.n >= 0.6, `${g} ${v.ok}/${v.n}`);
});

test('charts from a real-sounding song stay on its hits and grow with difficulty', () => {
  const s = song('funk-104');
  const a = analyze(s.pcm, s.sampleRate);
  const start = bestPart(a, 30000);
  const end = Math.min(a.dur, start + 30000);
  const charts = makeCharts(a, { start, end, seed: 4 });
  assert.deepEqual(validateCharts(charts, end - start), charts);
  const raw = a.onsets.map((o) => o.raw);
  const truth = s.truth.onsets.map((o) => o.t * 1000);
  let last = 0;
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    assert.ok(notes.length > last, `${id} has more notes`);
    last = notes.length;
    const onHit = notes.filter((n) => raw.some((r) => Math.abs(r - (n.t + start)) <= 40)).length;
    const onTruth = notes.filter((n) => truth.some((r) => Math.abs(r - (n.t + start)) <= 60)).length;
    assert.ok(onHit / notes.length >= 0.98, `${id} on detected hits ${onHit}/${notes.length}`);
    assert.ok(onTruth / notes.length >= 0.9, `${id} on real notes ${onTruth}/${notes.length}`);
  }
  assert.ok(Math.abs(charts.bpm - 104) <= 0.5);
});
