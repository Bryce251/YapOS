import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeNotes, decodeNotes, objectCount, objTimes, validateCharts, chartCounts, songCapBytes, partsFor, partSize, songHash, songIdOf, ChartError, SONG_CHUNK } from '../web/activity/js/games/beatcodec.js';
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
  huge.pad = 'x'.repeat(100000);
  rejects(huge, /too big/);
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
