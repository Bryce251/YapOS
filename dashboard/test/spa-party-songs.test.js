import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { installDom, flush, type, FakeEvent } from './dom-shim.js';
import { clickTrack, RATE } from './song-synth.js';

const { document } = installDom({ url: 'https://dash.example.test/party/songs' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartySongs, readSongs, canChangeNotes, RIGHTS_TEXT } = await import('../web/js/pages/owner-songs.js');
const { uploadSong, hashParts, fileProblem, usageText, putPart, TOO_BIG } = await import('../web/js/song-upload.js');
const { createSongEditor, clampOffset, defaultLength, beatSummary, NO_BEAT } = await import('../web/js/song-editor.js');
const { stripModel } = await import('../web/js/beat-grid.js');
const { analyze } = await import('../web/js/beat-analyze.js');
const { matchRoute } = await import('../web/js/router.js');
const { state } = await import('../web/js/state.js');
const { SONG_CHUNK } = await import('../web/activity/js/games/beatcodec.js');

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const digest = async (b) => createHash('sha256').update(b).digest().buffer;
const noSleep = async () => {};
const analysis = analyze(clickTrack(120, 40).pcm, RATE);

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

function song(over = {}) {
  return { id: 's-00000000000000aa', title: 'Night Tone', artist: 'Me', credit: 'Made by me', duration_ms: 90000, bytes: 2000000, bpm: 120, offset_ms: 0, start_ms: 0, end_ms: 60000, cv: 1, counts: [10, 20, 30, 40], hidden: false, uploader: ME, url: '/song-audio/s-00000000000000aa.mp3', ...over };
}

function fakeApi(data) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      return data;
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      return {};
    },
    async patch(path, body) {
      calls.push(['PATCH', path, body]);
      return {};
    },
    async request(method, path) {
      calls.push([method, path]);
      return {};
    },
  };
}

function mount(api, deps = {}) {
  const main = document.createElement('main');
  document.body.appendChild(main);
  const page = renderPartySongs({ api, main, setChrome() {}, signal: null }, { digest, sleep: noSleep, ...deps });
  return { main, page };
}

test('the songs page is for Party staff only and is linked from the staff pages', async () => {
  state.partyAdmin = false;
  state.partyOwner = false;
  const { main } = mount(fakeApi({ songs: [] }));
  assert.match(main.textContent, /Only party staff can open this/);
  assert.equal(matchRoute('/party/songs').name, 'party-songs');
  assert.equal(matchRoute('/party/songs').private, true);
  const party = readFileSync(new URL('../web/js/pages/party.js', import.meta.url), 'utf8');
  const owner = readFileSync(new URL('../web/js/pages/owner.js', import.meta.url), 'utf8');
  assert.match(party, /href: '\/party\/songs'/);
  assert.match(owner, /href: '\/party\/songs'/);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/css\/songs.css"/);
});

test('the file is checked in the browser before anything is sent', () => {
  assert.equal(fileProblem(null), 'Pick a song file first.');
  assert.equal(fileProblem({ name: 'x.wav', size: 10 }), 'Pick an MP3, OGG or M4A song.');
  assert.equal(fileProblem({ name: 'x.mp3', size: 9 * 1048576 }), '');
  assert.equal(fileProblem({ name: 'x.mp3', size: 10 * 1048576 }), '', 'a 10 MB song is fine');
  assert.equal(fileProblem({ name: 'x.mp3', size: 10 * 1048576 + 1 }), TOO_BIG);
  assert.equal(TOO_BIG, 'Songs can be up to 10 MB. Try a smaller MP3.');
  assert.equal(fileProblem({ name: 'x.MP3', size: 100 }), '');
  assert.equal(usageText({ count: 12, capCount: 40, bytes: 96 * 1048576, capBytes: 200 * 1048576 }), '12 of 40 songs, 96 MB of 200 MB');
});

test('Upload stays off until the song is read, named and the rights box is ticked', async () => {
  state.partyAdmin = true;
  state.user = { id: ME };
  const api = fakeApi({ songs: [], usage: { count: 0, bytes: 0, capCount: 40, capBytes: 200 * 1048576 }, role: 'admin' });
  const { main, page } = mount(api, { decode: async () => ({ pcm: new Float32Array(10), sr: 22050, duration_ms: 40000 }), analyze: async () => analysis });
  await flush();
  assert.match(main.textContent, /0 of 40 songs, 0 MB of 200 MB/);
  assert.match(main.textContent, new RegExp(RIGHTS_TEXT.replace(/[.]/g, '\\.')));
  const upload = buttons(main, /Upload song/)[0];
  assert.equal(upload.disabled, true);
  await page.openFile({ name: 'my_song.mp3', size: 3000, arrayBuffer: async () => new ArrayBuffer(3000) });
  await flush();
  assert.ok(page.editor, 'editor open');
  assert.equal(upload.disabled, true);
  const inputs = main.querySelectorAll('input');
  const title = inputs.find((i) => i.maxLength === 60 && i.placeholder === '');
  assert.equal(title.value, 'my song');
  const artist = inputs.filter((i) => i.maxLength === 60)[1];
  type(artist, 'Me');
  assert.equal(upload.disabled, true);
  const rights = inputs.find((i) => i.type === 'checkbox');
  rights.checked = true;
  rights.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  assert.equal(upload.disabled, false);
  rights.checked = false;
  rights.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  assert.equal(upload.disabled, true);
  assert.match(main.textContent, /up to 10 MB and 30 seconds to 6 minutes long/);
  await page.openFile({ name: 'big.mp3', size: 11 * 1048576, arrayBuffer: async () => new ArrayBuffer(1) });
  assert.match(main.textContent, /Songs can be up to 10 MB/);
  assert.equal(page.editor, null);
});

test('chunks go up in order, a failed chunk is retried and finish carries the rights', async () => {
  const bytes = new Uint8Array(SONG_CHUNK + 500).map((_, i) => i % 251);
  const posts = [];
  const api = { async post(path, body) { posts.push([path, body]); return path.endsWith('/finish') ? { song: { id: 's-1', title: 'T' } } : { upload: 'u-abc', chunk: SONG_CHUNK, parts: 2, have: [] }; } };
  const puts = [];
  let failOnce = true;
  const fetchImpl = async (url, init) => {
    puts.push(url);
    if (url.endsWith('/1') && failOnce) {
      failOnce = false;
      return new Response('{"error":"server_error","message":"oops"}', { status: 503 });
    }
    return Response.json({ idx: Number(url.split('/').pop()), hash: createHash('sha256').update(init.body).digest('hex') });
  };
  const progress = [];
  const out = await uploadSong({ buf: bytes.buffer, meta: { rights: true, title: 'T' }, api, fetchImpl, sleep: noSleep, digest, onProgress: (p) => progress.push(p.step) });
  assert.deepEqual(puts, ['/api/party/songs/uploads/u-abc/0', '/api/party/songs/uploads/u-abc/1', '/api/party/songs/uploads/u-abc/1']);
  assert.equal(out.song.id, 's-1');
  assert.equal(posts[0][1].parts, 2);
  assert.equal(posts[0][1].bytes, SONG_CHUNK + 500);
  assert.match(posts[0][1].hash, /^[0-9a-f]{64}$/);
  const { whole } = await hashParts(bytes.buffer, digest);
  assert.equal(posts[0][1].hash, whole);
  assert.equal(posts[1][1].rights, true);
  assert.deepEqual(progress, ['begin', 'part', 'part', 'finish']);
});

test('a song already on the shelf stops the upload early', async () => {
  const api = { async post() { return { exists: 's-00000000000000aa' }; } };
  let called = false;
  const out = await uploadSong({ buf: new Uint8Array(100).buffer, meta: {}, api, fetchImpl: async () => { called = true; }, sleep: noSleep, digest });
  assert.deepEqual(out, { exists: 's-00000000000000aa' });
  assert.equal(called, false);
});

test('a refused chunk is not retried and gives the plain message', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response('{"error":"not_audio","message":"That file is not an MP3, OGG or M4A song."}', { status: 400 });
  };
  await assert.rejects(putPart({ fetchImpl, sleep: noSleep, url: '/x/0', part: new Uint8Array(1), hash: 'h' }), /not an MP3/);
  assert.equal(n, 1);
});

test('the offset clamps and the section chips follow the song length', () => {
  assert.equal(clampOffset(500), 300);
  assert.equal(clampOffset(-999), -300);
  assert.equal(clampOffset('12.4'), 12);
  assert.equal(defaultLength(40000), 40000);
  assert.equal(defaultLength(200000), 200000);
  assert.equal(defaultLength(360000), 360000);
  const ed = createSongEditor({ analysis, buf: new ArrayBuffer(10) });
  for (let i = 0; i < 40; i++) ed.nudge(10);
  assert.equal(ed.state.offset, 300);
  assert.equal(ed.value().offset_ms, 300);
  const chips = ed.chips();
  assert.deepEqual(chips.map((c) => c.textContent), ['45 s', '60 s', '90 s', '120 s', '150 s', 'Full song']);
  assert.ok(chips.slice(0, 5).every((c) => c.disabled), 'a 40 second song cannot pick longer parts');
  assert.equal(chips[5].disabled, false);
  assert.equal(chips[5].getAttribute('aria-pressed'), 'true', 'Full song is picked for a new song');
  assert.equal(ed.value().start_ms, 0);
  assert.equal(ed.value().end_ms, 40000);
  ed.destroy();
});

const long = (() => {
  let cached = null;
  return () => {
    cached = cached || analyze(clickTrack(120, 200).pcm, RATE);
    return cached;
  };
})();

test('Full song is the default, the best part sets where shorter games start and shorter parts work like before', () => {
  const a = long();
  const ed = createSongEditor({ analysis: a, buf: new ArrayBuffer(10) });
  const chips = ed.chips();
  assert.deepEqual(chips.map((c) => [c.textContent, c.disabled]), [['45 s', false], ['60 s', false], ['90 s', false], ['120 s', false], ['150 s', false], ['Full song', false]]);
  let v = ed.value();
  assert.equal(v.start_ms, 0);
  assert.equal(v.end_ms, a.dur);
  assert.equal(v.preview_ms, 0);
  assert.equal(v.charts.len, a.dur);
  assert.match(ed.el.textContent, /Plays the whole song \(3:20\)\. Shorter games start at 0:00\./);
  const best = buttons(ed.el, /Find the best part/)[0];
  click(best);
  v = ed.value();
  assert.equal(v.start_ms, 0, 'the whole song still plays');
  assert.equal(v.end_ms, a.dur);
  assert.ok(v.preview_ms >= 0 && v.preview_ms < a.dur);
  assert.equal(v.preview_ms, ed.state.preview);
  const range = ed.el.querySelectorAll('input').find((i) => i.type === 'range');
  range.value = '90000';
  range.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  v = ed.value();
  assert.ok(Math.abs(v.preview_ms - 90000) <= 2000, `slider moves the best part ${v.preview_ms}`);
  assert.equal(v.start_ms, 0);
  const calls = [];
  ed.strip.getContext = () => ({ fillRect: (...r) => calls.push(r), set fillStyle(c) { calls.push(['style', c]); } });
  ed.state.view = v.preview_ms - 1000;
  ed.redraw();
  assert.ok(calls.some((c) => c[0] === 'style' && c[1] === '#34d399'), 'the best part shows on the waveform');
  const at = v.preview_ms;
  click(ed.chips()[1]);
  v = ed.value();
  assert.equal(v.start_ms, at, 'a shorter part starts at the best part');
  assert.equal(v.end_ms - v.start_ms, 60000);
  assert.equal(v.preview_ms, v.start_ms);
  assert.equal(v.charts.len, 60000);
  click(ed.chips()[4]);
  assert.equal(ed.value().end_ms - ed.value().start_ms, 150000);
  click(ed.chips()[5]);
  v = ed.value();
  assert.equal(v.start_ms, 0);
  assert.equal(v.end_ms, a.dur);
  ed.destroy();
  const old = createSongEditor({ analysis: a, buf: new ArrayBuffer(10), initial: { start_ms: 20000, end_ms: 110000, offset_ms: 5, preview_ms: 20000 } });
  assert.deepEqual([old.value().start_ms, old.value().end_ms, old.value().preview_ms], [20000, 110000, 20000]);
  assert.equal(old.chips()[2].getAttribute('aria-pressed'), 'true');
  old.destroy();
  const whole = createSongEditor({ analysis: a, buf: new ArrayBuffer(10), initial: { start_ms: 0, end_ms: a.dur, offset_ms: 0, preview_ms: 30000 } });
  assert.deepEqual([whole.value().start_ms, whole.value().end_ms, whole.value().preview_ms], [0, a.dur, 30000]);
  assert.equal(whole.chips()[5].getAttribute('aria-pressed'), 'true');
  whole.destroy();
});

test('the beat map shows beats, bar starts and hits, and half, double, shift and bar fix the grid', () => {
  const ed = createSongEditor({ analysis, buf: new ArrayBuffer(10) });
  assert.match(ed.el.textContent, /Beat map/);
  assert.match(beatSummary(ed.analysis), /Tempo 120 BPM, 4 beats a bar, straight feel/);
  const calls = [];
  ed.strip.getContext = () => ({ fillRect: (...a) => calls.push(a), set fillStyle(v) { calls.push(['style', v]); } });
  ed.redraw();
  assert.ok(calls.filter((c) => c[0] === 'style' && c[1] === '#ffffff').length >= 2, 'bar lines drawn');
  const m = stripModel(ed.analysis, 0, 8000);
  assert.ok(m.beats.length >= 14 && m.beats.length <= 17);
  assert.equal(m.beats.filter((b) => b.down).length, Math.round(m.beats.length / 4));
  assert.ok(m.onsets.length >= 14 && m.env.length > 100);
  const beats0 = ed.analysis.beats.slice();
  click(ed.controls.half);
  assert.ok(Math.abs(ed.analysis.bpm - 60) <= 0.5, `half ${ed.analysis.bpm}`);
  assert.ok(Math.abs(ed.value().charts.bpm - 60) <= 0.5);
  assert.match(beatSummary(ed.analysis), /found 120/);
  click(ed.controls.double);
  assert.ok(Math.abs(ed.analysis.bpm - 120) <= 0.5, `double ${ed.analysis.bpm}`);
  const near = (t) => ed.analysis.beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);
  for (const t of beats0.slice(4, 20)) assert.ok(Math.abs(near(t) - t) <= 10, `beat ${t} back in place`);
  click(ed.controls.later);
  for (const t of beats0.slice(4, 20)) assert.ok(Math.abs(near(t + 125) - (t + 125)) <= 10, `beat ${t} moved a quarter beat later`);
  click(ed.controls.earlier);
  for (const t of beats0.slice(4, 20)) assert.ok(Math.abs(near(t) - t) <= 10, `beat ${t} moved back`);
  const down = ed.analysis.downbeat;
  click(ed.controls.bar);
  assert.equal(ed.analysis.downbeat, (down + 1) % 4);
  assert.ok(ed.value().charts);
  ed.destroy();
});

test('tap tempo sets the grid from the taps and Re-detect follows that tempo', async () => {
  let clock = 1000;
  const asked = [];
  const fast = analyze(clickTrack(150, 40).pcm, RATE);
  const ed = createSongEditor({ analysis, buf: new ArrayBuffer(10), now: () => clock, redetect: async (hint) => { asked.push(hint); return fast; } });
  for (let i = 0; i < 3; i++) {
    click(ed.controls.tap);
    clock += 400;
  }
  assert.match(ed.el.textContent, /1 more/);
  assert.ok(Math.abs(ed.analysis.bpm - 120) <= 0.5);
  click(ed.controls.tap);
  assert.ok(Math.abs(ed.analysis.bpm - 150) <= 0.5, `tapped ${ed.analysis.bpm}`);
  assert.equal(ed.controls.tap.getAttribute('aria-pressed'), 'true');
  clock += 5000;
  click(ed.controls.tap);
  assert.match(ed.el.textContent, /3 more/);
  click(ed.controls.redetect);
  await flush();
  assert.deepEqual(asked, [150]);
  assert.equal(ed.analysis, fast);
  assert.ok(ed.value().charts);
  ed.destroy();
});

test('a song with no beat stops before the editor opens', async () => {
  state.partyAdmin = true;
  state.user = { id: ME };
  const api = fakeApi({ songs: [], usage: { count: 0, bytes: 0, capCount: 40, capBytes: 200 * 1048576 }, role: 'admin' });
  const silent = analyze(new Float32Array(RATE * 31), RATE);
  const { main, page } = mount(api, { decode: async () => ({ pcm: new Float32Array(10), sr: RATE, duration_ms: 40000 }), analyze: async () => silent });
  await flush();
  await page.openFile({ name: 'quiet.mp3', size: 3000, arrayBuffer: async () => new ArrayBuffer(3000) });
  await flush();
  assert.equal(page.editor, null);
  assert.match(main.textContent, new RegExp(NO_BEAT.replace(/[.]/g, '\.')));
});

test('delete asks first, and only the uploader or owner sees it', async () => {
  state.partyAdmin = true;
  state.user = { id: ME };
  const api = fakeApi({ songs: [song(), song({ id: 's-00000000000000bb', title: 'Not mine', uploader: OTHER })], usage: { count: 2, bytes: 4000000, capCount: 40, capBytes: 200 * 1048576 }, role: 'admin' });
  const { main } = mount(api);
  await flush();
  const rows = main.querySelectorAll('li').filter((li) => li.dataset.song);
  assert.equal(rows.length, 2);
  assert.equal(buttons(rows[1], /Delete/).length, 0);
  assert.equal(buttons(rows[1], /Hide/).length, 1);
  click(buttons(rows[0], /Delete/)[0]);
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Delete Night Tone\?/);
  assert.match(dialog.textContent, /will skip it/);
  assert.doesNotMatch(dialog.textContent, /built-in/);
  click(buttons(dialog, /Cancel/)[0]);
  await flush();
  assert.equal(api.calls.some((c) => c[0] === 'DELETE'), false);
  click(buttons(rows[0], /Delete/)[0]);
  await flush();
  click(buttons(document.body.querySelector('.dialog-panel'), /Delete song/)[0]);
  await flush();
  assert.ok(api.calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/party/songs/s-00000000000000aa'));
});

test('song rows read safely', () => {
  const v = readSongs({ songs: [song({ url: 'https://evil.example/x.mp3' }), { nope: 1 }], role: 'owner' });
  assert.equal(v.songs.length, 1);
  assert.equal(v.songs[0].url, '');
  assert.equal(v.role, 'owner');
  assert.equal(canChangeNotes(v.songs[0], 'admin', ME.toUpperCase()), true);
  assert.equal(canChangeNotes(v.songs[0], 'admin', OTHER), false);
  assert.equal(canChangeNotes(v.songs[0], 'owner', OTHER), true);
});

test('the uploader page files have no comments, inline styles or unsafe DOM', () => {
  for (const f of ['../web/js/pages/owner-songs.js', '../web/js/song-upload.js', '../web/js/song-editor.js', '../web/css/songs.css']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(src.includes('/*'), false, f);
    assert.equal(/(^|[^:'"])\/\/\s/.test(src), false, f);
    for (const bad of f.endsWith('.css') ? [] : ['innerHTML', 'style:', '.style.', 'localStorage', 'eval(']) assert.equal(src.includes(bad), false, `${f} ${bad}`);
    assert.deepEqual([...src].filter((c) => c.codePointAt(0) > 127), [], f);
  }
});
