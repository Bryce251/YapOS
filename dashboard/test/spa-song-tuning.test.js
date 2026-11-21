import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installDom, flush, FakeEvent } from './dom-shim.js';
import { drumLoop, clickTrack, RATE } from './song-synth.js';

const { document } = installDom({ url: 'https://dash.example.test/party/songs' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartySongs, readSongs } = await import('../web/js/pages/owner-songs.js');
const { createSongEditor, stepText, statText } = await import('../web/js/song-editor.js');
const { analyze } = await import('../web/js/beat-analyze.js');
const { state } = await import('../web/js/state.js');
const { chartStats } = await import('../web/js/song-chart.js');
const { validateCharts, decodeNotes } = await import('../web/activity/js/games/beatcodec.js');

const ME = '11111111-1111-4111-8111-111111111111';
const analysis = analyze(drumLoop(128, 64, { loudFrom: 32 }).pcm, RATE);

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

test('step and stat text read plainly', () => {
  assert.equal(stepText(0), 'Auto');
  assert.equal(stepText(1), '1 step harder');
  assert.equal(stepText(-3), '3 steps easier');
  assert.equal(statText('Expert', { objects: 1, avg: 0.5, peak: 2, chords: 1, holds: 0 }, 128), 'Expert: 1 note, 0.5 a second on average, up to 2 a second, 1 chord, 0 holds. Tempo 128 BPM.');
});

test('picking a level and pressing Harder remakes only that level and the preview plays it', () => {
  const ed = createSongEditor({ analysis, buf: new ArrayBuffer(10) });
  assert.match(ed.el.textContent, /Difficulty tuning/);
  assert.deepEqual(ed.tabs().map((b) => b.textContent.replace(/ \d+$/, '')), ['Chill', 'Normal', 'Hard', 'Expert']);
  assert.equal(ed.tuning.step.textContent, 'Normal: Auto');
  assert.equal(ed.tuning.reset.disabled, true);
  click(ed.tabs()[3]);
  assert.equal(ed.state.diff, 'expert');
  assert.equal(ed.tabs()[3].getAttribute('aria-pressed'), 'true');
  const before = ed.value().charts;
  const was = chartStats(before).expert;
  assert.match(ed.tuning.stats.textContent, new RegExp(`^Expert: ${was.objects} notes, [0-9.]+ a second on average, up to ${was.peak} a second, \\d+ chords?, \\d+ holds?\\. Tempo`));
  click(ed.tuning.harder);
  click(ed.tuning.harder);
  assert.deepEqual(ed.state.tune, [0, 0, 0, 2]);
  assert.equal(ed.tuning.step.textContent, 'Expert: 2 steps harder');
  const after = ed.value().charts;
  assert.deepEqual(after.tune, [0, 0, 0, 2], 'the tuning goes out with the notes');
  assert.deepEqual(validateCharts(after, after.len), after);
  assert.ok(chartStats(after).expert.objects > was.objects, 'Expert got busier');
  for (const id of ['easy', 'normal', 'hard']) assert.deepEqual(after.d[id], before.d[id], `${id} is left alone`);
  assert.match(ed.tuning.stats.textContent, new RegExp(`^Expert: ${chartStats(after).expert.objects} notes`));
  const canvas = ed.el.querySelector('.song-canvas');
  let rects = [];
  canvas.getContext = () => ({ fillRect: (...r) => rects.push(r), set fillStyle(c) {}, set globalAlpha(v) {} });
  const drawn = (id) => {
    rects = [];
    click(ed.tabs()[['easy', 'normal', 'hard', 'expert'].indexOf(id)]);
    return JSON.stringify(rects.filter((r) => r[2] === canvas.width / 4 - 12));
  };
  const chillDrawn = drawn('easy');
  const expertDrawn = drawn('expert');
  assert.ok(decodeNotes(after.d.expert).length > 0);
  assert.notEqual(expertDrawn, chillDrawn, 'the preview shows the picked level');
  assert.notEqual(expertDrawn, '[]');
  click(ed.tuning.harder);
  assert.equal(ed.tuning.harder.disabled, true, 'Harder stops at the top step');
  click(ed.tuning.reset);
  assert.deepEqual(ed.state.tune, [0, 0, 0, 0]);
  assert.deepEqual(ed.value().charts, before, 'Reset to auto gives back the auto notes');
  assert.equal(ed.value().charts.tune, undefined);
  click(ed.tabs()[0]);
  for (let i = 0; i < 5; i++) click(ed.tuning.easier);
  assert.deepEqual(ed.state.tune, [-3, 0, 0, 0]);
  assert.equal(ed.tuning.easier.disabled, true, 'Easier stops at the bottom step');
  assert.ok(chartStats(ed.value().charts).easy.objects < chartStats(before).easy.objects);
  ed.destroy();
});

test('an automatic raise or trim is explained in the editor', () => {
  const ed = createSongEditor({ analysis, buf: new ArrayBuffer(10) });
  click(ed.tabs()[3]);
  for (let i = 0; i < 3; i++) click(ed.tuning.easier);
  assert.match(ed.tuning.note.textContent, /was made easier so it stays below/);
  click(ed.tuning.reset);
  assert.doesNotMatch(ed.tuning.note.textContent, /easier so it stays below Expert/);
  ed.destroy();
});

test('a saved tuning comes back when the notes are remade and is sent with the new notes', async () => {
  state.partyAdmin = true;
  state.user = { id: ME };
  const song = { id: 's-00000000000000aa', title: 'Night Tone', artist: 'Me', credit: 'Made by me', duration_ms: 64000, bytes: 2000000, bpm: 128, offset_ms: 0, start_ms: 0, end_ms: analysis.dur, preview_ms: 0, cv: 1, counts: [1, 2, 3, 4], tune: [0, 1, 0, 2], hidden: false, uploader: ME, url: '/song-audio/s-00000000000000aa.mp3' };
  assert.deepEqual(readSongs({ songs: [song] }).songs[0].tune, [0, 1, 0, 2]);
  assert.deepEqual(readSongs({ songs: [{ ...song, tune: undefined }] }).songs[0].tune, [0, 0, 0, 0], 'old songs start on auto');
  assert.deepEqual(readSongs({ songs: [{ ...song, tune: [7, 0, 0, 0] }] }).songs[0].tune, [0, 0, 0, 0]);
  const calls = [];
  const api = {
    async get() { return { songs: [song], usage: { count: 1, bytes: 2000000, capCount: 40, capBytes: 200 * 1048576 }, role: 'owner' }; },
    async patch(path, body) { calls.push([path, body]); return {}; },
    async post() { return {}; },
    async request() { return {}; },
  };
  const main = document.createElement('main');
  document.body.appendChild(main);
  renderPartySongs({ api, main, setChrome() {}, signal: null }, {
    digest: async (b) => createHash('sha256').update(b).digest().buffer,
    sleep: async () => {},
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    decode: async () => ({ pcm: new Float32Array(1), sr: RATE, duration_ms: analysis.dur }),
    analyze: async () => analysis,
  });
  await flush();
  const row = main.querySelectorAll('li').find((li) => li.dataset.song);
  click(buttons(row, /^Edit$/)[0]);
  await flush();
  click(buttons(row, /Remake notes/)[0]);
  await flush();
  await flush();
  assert.match(row.textContent, /Difficulty tuning/);
  assert.match(row.textContent, /Normal: 1 step harder/);
  click(buttons(row, /Save new notes/)[0]);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].charts.tune, [0, 1, 0, 2]);
  assert.equal('tune' in calls[0][1], false, 'the tuning travels inside the chart, not as its own field');
});

test('Harder switches off with a plain note when the song has no harder notes left', () => {
  const ed = createSongEditor({ analysis: analyze(clickTrack(120, 40).pcm, RATE), buf: new ArrayBuffer(10) });
  click(ed.tabs()[3]);
  let last = chartStats(ed.value().charts).expert.notes;
  let clicks = 0;
  while (!ed.tuning.harder.disabled && clicks < 5) {
    click(ed.tuning.harder);
    clicks += 1;
    const now = chartStats(ed.value().charts).expert.notes;
    assert.ok(now > last, `every click adds notes: ${last} to ${now}`);
    last = now;
  }
  assert.ok(clicks >= 1 && clicks <= 3, `clicks ${clicks}`);
  if (ed.state.tune[3] < 3) assert.match(ed.tuning.note.textContent, /Expert is as hard as this part of the song allows\./);
  click(ed.tuning.reset);
  assert.doesNotMatch(ed.tuning.note.textContent, /as hard as/);
  ed.destroy();
});
