import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeNotes, decodeNotes, objectCount, objTimes, validateCharts, chartCounts, songCapBytes, partsFor, partSize, songHash, songIdOf, ChartError, SONG_CHUNK, SONG_MAX_BYTES, SONG_MAX_PARTS, SONG_MAX_MS, SECTION_MAX_MS, OBJECT_CAPS, NPS_CAPS, CHART_MAX_BYTES, SONG_CAP_COUNT, SONG_CAP_MB } from '../web/activity/js/games/beatcodec.js';
import { makeCharts as chartFrom, chartStats, CHART_DIFFS } from '../web/js/song-chart.js';
import { analyze } from '../web/js/beat-analyze.js';
import { drumLoop, RATE } from './song-synth.js';
import { makeCharts } from './song-fixtures.js';

const LEN = 60000;

function withDiff(id, notes) {
  const c = makeCharts(LEN);
  c.d[id] = encodeNotes(notes);
  return c;
}

const rejects = (charts, re, len = LEN) => assert.throws(() => validateCharts(charts, len), (err) => err instanceof ChartError && re.test(err.message));

test('notes survive an encode and decode round trip', () => {
  const notes = [{ t: 2000, l: 0 }, { t: 2000, l: 3 }, { t: 2500, l: 1, e: 3500 }, { t: 4000, l: 2 }];
  const arr = encodeNotes(notes);
  assert.deepEqual(arr, [2000, 0, 0, 3, 500, 1 + 4 * 100, 1500, 2]);
  assert.deepEqual(decodeNotes(arr), notes);
  assert.equal(objectCount(notes), 5);
  assert.deepEqual(objTimes(notes), [2000, 2000, 2500, 3500, 4000]);
});

test('a good chart passes and is cleaned', () => {
  const c = makeCharts(LEN);
  const out = validateCharts({ ...c, extra: 1 }, LEN);
  assert.equal(out.extra, undefined);
  assert.deepEqual(chartCounts(out).length, 4);
});

test('every chart rule is checked', () => {
  rejects(null, /missing/);
  rejects({ ...makeCharts(LEN), v: 2 }, /older version/);
  rejects({ ...makeCharts(LEN), bpm: 300 }, /tempo/);
  rejects({ ...makeCharts(LEN), b0: 6000 }, /first beat/);
  rejects(makeCharts(LEN), /does not match/, 50000);
  rejects({ ...makeCharts(LEN), marks: [[5000, 'drop'], [1000, 'build']] }, /out of order/);
  rejects({ ...makeCharts(LEN), marks: Array.from({ length: 17 }, (_, i) => [i * 100, 'drop']) }, /too many section marks/);
  rejects({ ...makeCharts(LEN), marks: [[100, 'boom']] }, /broken/);
  const noExpert = makeCharts(LEN);
  delete noExpert.d.expert;
  rejects(noExpert, /Expert chart is missing/);
  rejects(withDiff('normal', []), /fewer notes/);
  const odd = makeCharts(LEN);
  odd.d.hard = [2000];
  rejects(odd, /broken/);
  const unsorted = makeCharts(LEN);
  unsorted.d.hard = [3000, 0, -500, 1];
  rejects(unsorted, /broken/);
  const lane4 = makeCharts(LEN);
  lane4.d.hard = [2000, 4 * 100 + 0, 0, 4];
  rejects(lane4, /lane|chart/);
  rejects(withDiff('expert', [{ t: 2000, l: 0 }, { t: 2000, l: 1 }, { t: 2000, l: 2 }]), /more than 2 notes/);
  rejects(withDiff('easy', [{ t: 2000, l: 0, e: 2500 }]), /Only Hard and Expert/);
  rejects(withDiff('expert', [{ t: 2000, l: 0, e: 2500 }, { t: 2550, l: 0 }]), /too close together/);
  rejects(withDiff('expert', [{ t: 2000, l: 0, e: 3000 }, { t: 2500, l: 1 }, { t: 2500, l: 2 }]), /more than 2 keys/);
  rejects(withDiff('easy', Array.from({ length: 401 }, (_, i) => ({ t: 2000 + i * 120, l: i % 4 }))), /too many notes|too dense|past the end/);
  rejects(withDiff('easy', [{ t: 2000, l: 0 }, { t: 2100, l: 1 }, { t: 2200, l: 2 }, { t: 2300, l: 3 }, { t: 2400, l: 0 }]), /too dense/);
  rejects(withDiff('expert', [{ t: 59600, l: 0 }]), /past the end/);
  rejects(withDiff('expert', [{ t: 1400, l: 0 }]), /too early/);
  const huge = makeCharts(LEN);
  huge.marks = [];
  huge.pad = 'x'.repeat(CHART_MAX_BYTES);
  rejects(huge, /too big/);
});

test('songs can be 10 MB in 7 parts, sections can be the whole song and the shelf rules stay the same', () => {
  assert.equal(SONG_MAX_BYTES, 10 * 1048576);
  assert.equal(SONG_MAX_PARTS, 7);
  assert.equal(SONG_MAX_PARTS, Math.ceil(SONG_MAX_BYTES / SONG_CHUNK));
  assert.equal(partsFor(SONG_MAX_BYTES), SONG_MAX_PARTS);
  assert.equal(partSize(SONG_MAX_BYTES, SONG_MAX_PARTS - 1), SONG_MAX_BYTES - SONG_CHUNK * 6);
  assert.equal(SONG_MAX_MS, 360000);
  assert.equal(SECTION_MAX_MS, SONG_MAX_MS);
  assert.equal(SONG_CAP_COUNT, 40);
  assert.equal(SONG_CAP_MB, 200);
  assert.deepEqual({ ...OBJECT_CAPS }, { easy: 1200, normal: 2100, hard: 3300, expert: 4800 });
  assert.deepEqual({ ...NPS_CAPS }, { easy: 4, normal: 6, hard: 9, expert: 13 });
  for (const [id, cfg] of Object.entries(CHART_DIFFS)) assert.ok(OBJECT_CAPS[id] >= cfg.nps * 1.5 * (SECTION_MAX_MS / 1000), `${id} cap fits a 6 minute section at its busiest`);
});

test('a 6 minute Expert chart fits every cap with room to spare', () => {
  const track = drumLoop(174, 359, { loudFrom: 20 });
  const a = analyze(track.pcm, RATE);
  const c = chartFrom(a, { start: 0, end: a.dur, seed: 1 });
  assert.equal(c.len, a.dur);
  const out = validateCharts(c, a.dur);
  const stats = chartStats(out);
  for (const id of Object.keys(OBJECT_CAPS)) assert.ok(stats[id].objects > 0 && stats[id].objects <= OBJECT_CAPS[id]);
  assert.ok(stats.expert.objects > 1600, 'longer than the old 2 minute cap allowed');
  assert.ok(JSON.stringify(out).length * 3 < CHART_MAX_BYTES, `chart is ${JSON.stringify(out).length} bytes`);
  const worst = Object.keys(OBJECT_CAPS).reduce((n, id) => n + OBJECT_CAPS[id], 0);
  assert.ok(worst * 2 * 8 < CHART_MAX_BYTES, 'notes at every cap still fit');
});

test('counts never go down from Chill to Expert', () => {
  const c = makeCharts(LEN);
  const counts = chartCounts(validateCharts(c, LEN));
  for (let i = 1; i < 4; i++) assert.ok(counts[i] >= counts[i - 1]);
});

test('store sizes, parts and ids', async () => {
  assert.equal(songCapBytes({}), 200 * 1048576);
  assert.equal(songCapBytes({ SONG_STORE_MB: '300' }), 300 * 1048576);
  assert.equal(songCapBytes({ SONG_STORE_MB: '5000' }), 1000 * 1048576);
  assert.equal(songCapBytes({ SONG_STORE_MB: 'nope' }), 200 * 1048576);
  assert.equal(partsFor(SONG_CHUNK), 1);
  assert.equal(partsFor(SONG_CHUNK + 1), 2);
  assert.equal(partSize(SONG_CHUNK + 10, 1), 10);
  assert.equal(partSize(SONG_CHUNK + 10, 2), 0);
  const h = await songHash(['ab', 'cd']);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(songIdOf(h), `s-${h.slice(0, 16)}`);
});
