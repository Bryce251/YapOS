import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../web/js/beat-analyze.js';
import { makeCharts, makeChartsInfo, chartStats, tunedConfig, readSteps, tuneNote, clearlyHarder, CHART_DIFFS, ORDER_RATIO, TUNE_MIN, TUNE_MAX } from '../web/js/song-chart.js';
import { validateCharts, decodeNotes, readTune, ChartError, DIFF_IDS, NPS_CAPS, OBJECT_CAPS, LANE_REST_MS, MAX_CHORD } from '../web/activity/js/games/beatcodec.js';
import { tuneOfRow } from '../worker/songs.js';
import { edgeText } from '../web/js/song-editor.js';
import { drumLoop, clickTrack, RATE } from './song-synth.js';
import { songsHarness, cookies, makeMp3, upload, makeCharts as fixtureCharts } from './song-fixtures.js';

const memo = (fn) => {
  let v = null;
  return () => (v = v || fn());
};

const loop = memo(() => {
  const bpm = 128;
  const p = 60 / bpm;
  return analyze(drumLoop(bpm, 64, { loudFrom: 32, sustains: [[0.5 + p * 32, 2], [0.5 + p * 80, 1.5]] }).pcm, RATE);
});
const sparse = memo(() => analyze(clickTrack(120, 40).pcm, RATE));
const fast = memo(() => analyze(drumLoop(174, 120, { loudFrom: 10 }).pcm, RATE));

const tuneAt = (i, step) => DIFF_IDS.map((_, k) => (k === i ? step : 0));
const counts = (charts) => DIFF_IDS.map((id) => chartStats(charts)[id].objects);

function playable(charts, len) {
  assert.deepEqual(validateCharts(charts, len), charts);
  const stats = chartStats(charts);
  for (const id of DIFF_IDS) {
    assert.ok(stats[id].objects <= OBJECT_CAPS[id], `${id} under the note cap`);
    assert.ok(stats[id].peak <= NPS_CAPS[id], `${id} under the density cap`);
    const notes = decodeNotes(charts.d[id]);
    const free = [-Infinity, -Infinity, -Infinity, -Infinity];
    const at = new Map();
    for (const n of notes) {
      assert.ok(n.t >= free[n.l], `${id} lane ${n.l} at ${n.t} has room`);
      free[n.l] = (n.e ?? n.t) + LANE_REST_MS;
      at.set(n.t, (at.get(n.t) || 0) + 1);
    }
    assert.ok([...at.values()].every((n) => n <= MAX_CHORD), `${id} chords fit two hands`);
  }
  const c = counts(charts);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1], `counts go up ${c}`);
}

test('step 0 is the old config and harder steps change the feel, not only the density', () => {
  for (const id of DIFF_IDS) assert.equal(tunedConfig(id, 0), CHART_DIFFS[id]);
  const up = tunedConfig('normal', 3);
  const down = tunedConfig('normal', -3);
  assert.equal(up.q, 1, 'the top step uses the 1/16 grid');
  assert.equal(down.q, 4, 'the bottom step keeps to the beat');
  assert.ok(up.nps > CHART_DIFFS.normal.nps && down.nps < CHART_DIFFS.normal.nps);
  assert.ok(up.space < CHART_DIFFS.normal.space && down.space > CHART_DIFFS.normal.space);
  assert.ok(up.chord.top > CHART_DIFFS.normal.chord.top && up.chord.per > CHART_DIFFS.normal.chord.per);
  assert.equal(up.trills, false, 'trills are allowed on harder steps');
  assert.equal(down.chord, null, 'easier Normal has no chords');
  assert.equal(tunedConfig('easy', 1).loud, 0.7, 'harder Chill lets in 1/8 notes in loud parts');
  assert.ok(tunedConfig('easy', 2).chord, 'harder Chill gets a few chords');
  assert.equal(tunedConfig('hard', 2).runs, true);
  assert.equal(tunedConfig('expert', -2).runs, false);
  assert.ok(tunedConfig('expert', 3).hold.min < CHART_DIFFS.expert.hold.min);
  assert.ok(tunedConfig('expert', 3).jack >= 120 && tunedConfig('expert', 3).space >= 60);
  for (const id of ['easy', 'normal']) for (let s = TUNE_MIN; s <= TUNE_MAX; s++) assert.equal(tunedConfig(id, s).hold, null, `${id} never holds`);
});

test('each step makes its level denser, and the ends are far apart', () => {
  const a = loop();
  DIFF_IDS.forEach((id, i) => {
    const row = [];
    for (let s = TUNE_MIN; s <= TUNE_MAX; s++) row.push(chartStats(makeCharts(a, { start: 0, end: 60000, seed: 5, tune: tuneAt(i, s) }))[id]);
    for (let k = 1; k < row.length; k++) assert.ok(row[k].objects >= row[k - 1].objects, `${id} ${row.map((r) => r.objects)}`);
    assert.ok(row[6].objects > row[0].objects * 1.8, `${id} +3 is much busier than -3: ${row[0].objects} to ${row[6].objects}`);
    assert.ok(row[6].peak >= row[0].peak, `${id} peak goes up`);
  });
  const normal = (s) => chartStats(makeCharts(a, { start: 0, end: 60000, seed: 5, tune: tuneAt(1, s) })).normal;
  assert.ok(normal(3).chords > normal(0).chords && normal(0).chords > normal(-3).chords, 'more chords on harder steps');
});

test('harder steps use the finer grid where the song has hits there', () => {
  const a = loop();
  const byT = new Map(a.grid.map((g) => [Math.round(g.t), g]));
  const finest = (charts, id) => Math.min(...decodeNotes(charts.d[id]).map((n) => byT.get(n.t).q));
  assert.equal(finest(makeCharts(a, { start: 0, end: 60000, seed: 5 }), 'easy'), 4);
  assert.equal(finest(makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [3, 0, 0, 0] }), 'easy'), 2, 'harder Chill uses eighths');
  assert.equal(finest(makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [0, 3, 0, 0] }), 'normal'), 1, 'harder Normal uses sixteenths');
  const calm = makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [0, -3, 0, 0] });
  assert.ok(finest(calm, 'normal') >= 4, 'easier Normal stays on the beat');
});

test('every level stays clearly harder than the one below and Expert is never easier than Hard', () => {
  const a = loop();
  const auto = makeChartsInfo(a, { start: 0, end: 60000, seed: 5 });
  const st = chartStats(auto.charts);
  for (let i = 1; i < DIFF_IDS.length; i++) {
    const lo = st[DIFF_IDS[i - 1]];
    const hi = st[DIFF_IDS[i]];
    assert.ok(hi.objects >= Math.ceil(lo.objects * ORDER_RATIO), `${DIFF_IDS[i]} ${hi.objects} vs ${lo.objects}`);
    assert.ok(clearlyHarder(lo, hi, DIFF_IDS[i]) || auto.used[i] === TUNE_MAX);
  }
  for (const tune of [[0, 0, 3, 0], [0, 0, 0, -3], [3, 3, 3, -3], [-3, 3, -3, 3], [0, 3, 0, 0], [3, 0, 0, 0]]) {
    const info = makeChartsInfo(a, { start: 0, end: 60000, seed: 5, tune });
    const c = counts(info.charts);
    assert.ok(c[3] >= c[2], `Expert ${c[3]} is not easier than Hard ${c[2]} for ${tune}`);
    for (let i = 1; i < 4; i++) assert.ok(c[i] >= Math.floor(c[i - 1] * ORDER_RATIO) - 1, `${tune} counts ${c}`);
  }
  const low = makeChartsInfo(a, { start: 0, end: 60000, seed: 5, tune: [0, 0, 0, -3] });
  assert.ok(low.trimmed.includes('hard'), 'an easier Expert pulls Hard down with it');
  assert.match(tuneNote(low), /Hard was made easier so it stays below Expert\./);
});

test('an Expert that comes out too easy for the song is raised automatically', () => {
  const a = sparse();
  const info = makeChartsInfo(a, { start: 0, end: 40000, seed: 1 });
  assert.ok(info.auto[3] > 0, `auto expert step ${info.auto}`);
  assert.deepEqual(info.used, info.auto);
  assert.deepEqual(info.steps, [0, 0, 0, 0], 'what is saved is still auto');
  assert.equal(info.charts.tune, undefined);
  assert.equal(tuneNote(info), '', 'auto needs no note');
  const c = counts(info.charts);
  for (let i = 1; i < 4; i++) assert.ok(c[i] >= Math.ceil(c[i - 1] * ORDER_RATIO) || info.used[i] === TUNE_MAX, `counts ${c}`);
  playable(info.charts, 40000);
  const plus = makeChartsInfo(a, { start: 0, end: 40000, seed: 1, tune: [0, 0, 0, 1] });
  assert.ok(counts(plus.charts)[3] > c[3], 'Harder starts from the raised auto, so it always adds notes');
  assert.ok(plus.used[3] > info.auto[3]);
  assert.equal(makeChartsInfo(a, { start: 0, end: 40000, seed: 1, tune: [0, 0, 0, -1] }).raised.includes('expert'), false, 'an Expert tuned easier is left easier');
  const hard = makeChartsInfo(a, { start: 0, end: 40000, seed: 1, tune: [0, 0, 2, 0] });
  if (hard.used[3] > info.auto[3]) {
    assert.ok(hard.raised.includes('expert'));
    assert.match(tuneNote(hard), /Expert was made harder automatically so it stays clearly above Hard\./);
  }
  assert.ok(counts(hard.charts)[3] > counts(hard.charts)[2]);
});

test('Harder keeps adding notes after every hit in the song is used, then says when it cannot go further', () => {
  const a = sparse();
  const opts = { start: 0, end: 40000, seed: 1 };
  const row = [];
  let s = 0;
  for (; s <= TUNE_MAX; s++) {
    const info = makeChartsInfo(a, { ...opts, tune: tuneAt(3, s) });
    row.push(chartStats(info.charts).expert);
    playable(info.charts, 40000);
    if (!info.room[3].harder) break;
  }
  for (let k = 1; k < row.length; k++) assert.ok(row[k].notes > row[k - 1].notes, `expert notes ${row.map((r) => r.notes)}`);
  assert.ok(row[row.length - 1].chords > row[0].chords, 'the extra notes come as chords on real hits');
  const down = [];
  for (let k = 0; k >= TUNE_MIN; k--) {
    const info = makeChartsInfo(a, { ...opts, tune: tuneAt(3, k) });
    down.push(chartStats(info.charts).expert.notes);
    if (!info.room[3].easier) break;
  }
  for (let k = 1; k < down.length; k++) assert.ok(down[k] < down[k - 1], `easier steps ${down}`);
  assert.equal(edgeText('Expert', 1, { harder: false, easier: true }), 'Expert is as hard as this part of the song allows.');
  assert.equal(edgeText('Chill', -1, { harder: true, easier: false }), 'Chill is as easy as this part of the song allows.');
  assert.equal(edgeText('Chill', 3, { harder: false, easier: true }), '');
  assert.equal(edgeText('Hard', 0, { harder: true, easier: true }), '');
});

test('an easier Expert never peaks below Hard', () => {
  for (const a of [loop(), fast(), sparse()]) {
    for (let s = TUNE_MIN; s < 0; s++) {
      const st = chartStats(makeCharts(a, { start: 0, end: Math.min(60000, a.dur), seed: 4, tune: tuneAt(3, s) }));
      assert.ok(st.expert.peak >= st.hard.peak, `expert ${s}: peak ${st.expert.peak} vs hard ${st.hard.peak}`);
      assert.ok(st.hard.peak >= st.normal.peak && st.normal.peak >= st.easy.peak);
    }
  }
});

test('extreme steps stay inside every cap and always validate', () => {
  const a = fast();
  for (const tune of [[3, 3, 3, 3], [-3, -3, -3, -3], [3, -3, 3, -3], [-3, 3, -3, 3]]) {
    const charts = makeCharts(a, { start: 0, end: a.dur, seed: 2, tune });
    playable(charts, a.dur);
    assert.deepEqual(charts.tune, tune);
  }
  const top = chartStats(makeCharts(a, { start: 0, end: a.dur, seed: 2, tune: [3, 3, 3, 3] }));
  assert.ok(top.expert.peak <= NPS_CAPS.expert && top.expert.peak >= 10, `expert peak ${top.expert.peak}`);
  playable(makeCharts(loop(), { start: 0, end: 60000, seed: 3, tune: [3, 3, 3, 3] }), 60000);
  playable(makeCharts(sparse(), { start: 0, end: 40000, seed: 3, tune: [-3, -3, -3, -3] }), 40000);
});

test('tuning one level remakes only that level', () => {
  const a = loop();
  const base = makeCharts(a, { start: 0, end: 60000, seed: 5 });
  for (const s of [1, 2, 3]) {
    const up = makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [0, 0, 0, s] });
    assert.notDeepEqual(up.d.expert, base.d.expert);
    for (const id of ['easy', 'normal', 'hard']) assert.deepEqual(up.d[id], base.d[id], `${id} untouched by Expert ${s}`);
  }
  const chill = makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [1, 0, 0, 0] });
  assert.notDeepEqual(chill.d.easy, base.d.easy);
  for (const id of ['normal', 'hard', 'expert']) assert.deepEqual(chill.d[id], base.d[id], `${id} untouched by Chill`);
  const cache = {};
  const first = makeChartsInfo(a, { start: 0, end: 60000, seed: 5, cache });
  const again = makeChartsInfo(a, { start: 0, end: 60000, seed: 5, tune: [0, 0, 1, 0], cache });
  assert.deepEqual(first.charts, base, 'the cache gives the same notes');
  assert.deepEqual(again.charts.d.normal, base.d.normal);
  assert.deepEqual(makeCharts(a, { start: 0, end: 60000, seed: 5, tune: [0, 0, 1, 0] }), again.charts, 'the cache never changes the result');
});

test('the tuning is saved inside the chart and old charts read as auto', () => {
  assert.deepEqual(readTune(undefined), [0, 0, 0, 0]);
  assert.deepEqual(readTune([1, 2, 3, 4]), [0, 0, 0, 0]);
  assert.deepEqual(readTune([1, -2, 3, 0]), [1, -2, 3, 0]);
  assert.deepEqual(readSteps([9, -9, '2', 'x']), [3, -3, 2, 0]);
  const len = 60000;
  const plain = fixtureCharts(len);
  assert.equal(validateCharts(plain, len).tune, undefined);
  assert.equal(validateCharts({ ...plain, tune: [0, 0, 0, 0] }, len).tune, undefined, 'all auto is not stored');
  assert.deepEqual(validateCharts({ ...plain, tune: [0, -1, 2, 3] }, len).tune, [0, -1, 2, 3]);
  for (const bad of [[0, 0, 0], [0, 0, 0, 4], [0, 0, 0, 1.5], 'up', { a: 1 }, [0, 0, 0, '1']]) {
    assert.throws(() => validateCharts({ ...plain, tune: bad }, len), (e) => e instanceof ChartError && /tuning/.test(e.message), JSON.stringify(bad));
  }
  assert.deepEqual(tuneOfRow(JSON.stringify(validateCharts({ ...plain, tune: [-3, 0, 1, 3] }, len))), [-3, 0, 1, 3]);
  assert.deepEqual(tuneOfRow(JSON.stringify(plain)), [0, 0, 0, 0]);
  assert.deepEqual(tuneOfRow(null), [0, 0, 0, 0]);
  assert.deepEqual(tuneOfRow('{"tune":[9,0,0,0]}'), [0, 0, 0, 0]);
});

test('the server keeps the tuning, sends it back with the shelf and refuses a broken one', async () => {
  const h = songsHarness();
  const { owner } = await cookies(h);
  const bad = await upload(h, owner, makeMp3(2000000, 7), { charts: { ...fixtureCharts(60000), tune: [0, 0, 0, 5] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_chart');
  const up = await upload(h, owner, makeMp3(2000000, 8), { charts: { ...fixtureCharts(60000), tune: [0, 1, -2, 3] } });
  assert.equal(up.status, 201);
  const old = await upload(h, owner, makeMp3(2000000, 9));
  assert.equal(old.status, 201);
  const list = await (await h.api('GET', '/api/party/songs', owner)).json();
  const by = new Map(list.songs.map((s) => [s.id, s]));
  assert.deepEqual(by.get(up.body.song.id).tune, [0, 1, -2, 3]);
  assert.deepEqual(by.get(old.body.song.id).tune, [0, 0, 0, 0], 'songs saved before tuning default to auto');
  const res = await h.api('PATCH', `/api/party/songs/${old.body.song.id}`, owner, { charts: { ...fixtureCharts(60000), tune: [2, 0, 0, 0] } });
  assert.equal(res.status, 200);
  const after = await (await h.api('GET', '/api/party/songs', owner)).json();
  assert.deepEqual(after.songs.find((s) => s.id === old.body.song.id).tune, [2, 0, 0, 0]);
});

test('tuning files have no comments', () => {
  for (const f of ['../web/js/song-chart.js', '../web/activity/js/games/beatcodec.js', '../worker/songs.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(src.includes('/*'), false, f);
    assert.equal(/(^|[^:'"])\/\/\s/.test(src), false, f);
  }
});
