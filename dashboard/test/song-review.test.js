import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance } from './helpers.js';
import { parseRange, HIDDEN_GRACE, hiddenGone, FINISH_BODY_LIMIT } from '../worker/songs.js';
import { validateCharts, encodeNotes, ChartError, SONG_CHUNK, SONG_MAX_PARTS, SONG_MAX_BYTES, CHART_MAX_BYTES } from '../web/activity/js/games/beatcodec.js';
import { createSongAudio, AUDIO_MAX_BYTES, CACHE_MAX } from '../web/activity/js/views/beatsong.js';
import { readCatalog, readSong, validateChart, AUDIO_RE, setSongFetch, resetSongs, loadChart, chartSong } from '../web/activity/js/games/beatsongs.js';
import { checkProgress, checkFinal } from '../web/activity/js/games/beatdrop.js';
import { countOf, objectsBefore } from '../web/activity/js/games/beatchart.js';
import { songsHarness, cookies, makeMp3, upload, makeCharts } from './song-fixtures.js';

const SIZE = 2000000;

async function withSong() {
  const h = songsHarness();
  const c = await cookies(h);
  const res = await upload(h, c.owner, makeMp3(SIZE));
  return { h, c, id: res.body.song.id, path: res.body.song.url };
}

test('a song deleted and uploaded again gets a new chart version so old cached charts are never reused', async () => {
  const { h, c, id } = await withSong();
  const first = await h.request('GET', `/api/activity/songs/${id}?v=1`);
  assert.match(first.headers.get('Cache-Control'), /immutable/);
  assert.equal((await h.api('DELETE', `/api/party/songs/${id}`, c.owner)).status, 200);
  const again = await upload(h, c.owner, makeMp3(SIZE), { start_ms: 10000, end_ms: 50000, preview_ms: 10000, charts: makeCharts(40000) });
  assert.equal(again.status, 201);
  assert.equal(again.body.song.id, id);
  assert.equal(again.body.song.cv, 2);
  const old = await h.request('GET', `/api/activity/songs/${id}?v=1`);
  assert.equal(old.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal((await old.json()).cv, 2);
  assert.equal((await h.api('DELETE', `/api/party/songs/${id}`, c.owner)).status, 200);
  const third = await upload(h, c.owner, makeMp3(SIZE));
  assert.equal(third.body.song.cv, 3);
});

test('a hidden song stays loadable for a running game, then stops playing', async () => {
  const { h, c, id, path } = await withSong();
  assert.equal((await h.api('PATCH', `/api/party/songs/${id}`, c.admin, { hidden: true })).status, 200);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}?v=1`)).status, 200);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}/chart?d=hard&v=1`)).status, 200);
  assert.equal((await h.request('GET', path)).status, 200);
  advance(h, HIDDEN_GRACE + 1000);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}?v=1`)).status, 404);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}/chart?d=hard&v=1`)).status, 404);
  const audio = await h.request('GET', path);
  assert.equal(audio.status, 404);
  assert.notEqual(audio.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal((await h.request('GET', path, { headers: { 'If-None-Match': `"${id}"` } })).status, 404);
  assert.equal((await h.request('GET', path, { headers: { Range: 'bytes=0-9' } })).status, 404);
  assert.equal((await h.api('PATCH', `/api/party/songs/${id}`, c.admin, { hidden: false })).status, 200);
  assert.equal((await h.request('GET', path)).status, 200);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}?v=1`)).status, 200);
  assert.equal(hiddenGone(null, 0), false);
  assert.equal(hiddenGone({ hidden: 0, updated: 0 }, HIDDEN_GRACE * 10), false);
});

test('the edge cache key ignores the query string and is dropped on delete and hide', async () => {
  const store = new Map();
  const fake = {
    async match(req) {
      return store.has(req.url) ? store.get(req.url).clone() : undefined;
    },
    async put(req, res) {
      store.set(req.url, res);
    },
    async delete(req) {
      return store.delete(req.url);
    },
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { value: { default: fake }, configurable: true, writable: true });
  try {
    const h = songsHarness();
    const c = await cookies(h);
    const waits = [];
    const hit = (p) => h.worker.fetch(new Request(`${h.base}${p}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), h.env, { waitUntil: (x) => waits.push(x) });
    const one = (await upload(h, c.owner, makeMp3(SIZE))).body.song;
    const two = (await upload(h, c.owner, makeMp3(SIZE, 7))).body.song;
    await (await hit(`${one.url}?junk=1`)).arrayBuffer();
    await (await hit(`${one.url}?junk=2`)).arrayBuffer();
    await (await hit(two.url)).arrayBuffer();
    await Promise.all(waits);
    assert.deepEqual([...store.keys()].sort(), [`${h.base}${one.url}`, `${h.base}${two.url}`].sort());
    assert.equal((await h.api('DELETE', `/api/party/songs/${one.id}`, c.owner)).status, 200);
    assert.equal(store.has(`${h.base}${one.url}`), false);
    assert.equal((await h.api('PATCH', `/api/party/songs/${two.id}`, c.owner, { hidden: true })).status, 200);
    assert.equal(store.has(`${h.base}${two.url}`), false);
  } finally {
    if (had) Object.defineProperty(globalThis, 'caches', had);
    else delete globalThis.caches;
  }
});

test('odd Range headers never crash and never read outside the file', async () => {
  const size = 100;
  const cases = [
    ['bytes=0-9,20-29', null],
    ['bytes=0-50,25-75', null],
    ['bytes= 0-9', null],
    ['bytes=0x10-20', null],
    ['bytes=1.5-3', null],
    ['bytes=-1-5', null],
    ['bytes=abc', null],
    ['', null],
    ['bytes=100-', 'unsatisfiable'],
    ['bytes=100-200', 'unsatisfiable'],
    ['bytes=99999999999999999999999-', 'unsatisfiable'],
    ['bytes=0-99999999999999999999999', { a: 0, b: 99 }],
    ['bytes=-99999999999999999999999', { a: 0, b: 99 }],
    ['bytes=99-99', { a: 99, b: 99 }],
    ['bytes=0-0', { a: 0, b: 0 }],
  ];
  for (const [header, want] of cases) assert.deepEqual(parseRange(header, size), want, header);
  const { h, path } = await withSong();
  const multi = await h.request('GET', path, { headers: { Range: 'bytes=0-9,5-20' } });
  assert.equal(multi.status, 200);
  assert.equal(multi.headers.get('Content-Length'), String(SIZE));
  await multi.arrayBuffer();
  const past = await h.request('GET', path, { headers: { Range: `bytes=${SIZE}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${SIZE}`);
  const tail = await h.request('GET', path, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('Content-Range'), `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
});

test('hostile charts are refused by both the server and the game', () => {
  const len = 60000;
  const good = makeCharts(len);
  const hostile = [
    { ...good, d: { ...good.d, easy: [2000, 4] } },
    { ...good, d: { ...good.d, easy: [2000, -1] } },
    { ...good, d: { ...good.d, easy: [2000.5, 0] } },
    { ...good, d: { ...good.d, easy: ['2000', 0] } },
    { ...good, d: { ...good.d, easy: [Infinity, 0] } },
    { ...good, d: { ...good.d, easy: [3000, 0, -500, 1] } },
    { ...good, d: { ...good.d, easy: [2000, 0, 0, 0] } },
    { ...good, d: { ...good.d, easy: [2000, 0, 0, 1, 0, 2] } },
    { ...good, d: { ...good.d, easy: [2000, 0, 1] } },
    { ...good, d: { ...good.d, easy: encodeNotes([{ t: 2000, l: 0, e: 3000 }]) } },
    { ...good, d: { ...good.d, expert: Array.from({ length: 40000 }, (_, i) => (i % 2 ? i % 4 : 1)) } },
    { ...good, d: { ...good.d, easy: [len, 0] } },
    { ...good, bpm: NaN },
    { ...good, bpm: 'fast' },
    { ...good, b0: -1 },
    { ...good, len: len + 1 },
    { ...good, v: 2 },
    { ...good, marks: Array.from({ length: 17 }, (_, i) => [i * 1000, 'drop']) },
    { ...good, marks: [[5000, 'drop'], [1000, 'build']] },
    { ...good, marks: [[5000, 'boom']] },
    { ...good, d: null },
    [],
    null,
  ];
  for (const [i, c] of hostile.entries()) {
    assert.throws(() => validateCharts(c, len), ChartError, `server ${i}`);
    assert.throws(() => validateChart(c, len), Error, `game ${i}`);
  }
  const extra = validateCharts({ ...good, d: { ...good.d, junk: [1, 2, 3] }, evil: 'x' }, len);
  assert.deepEqual(Object.keys(extra.d), ['easy', 'normal', 'hard', 'expert']);
  assert.equal(extra.evil, undefined);
  assert.equal(validateChart(extra, len).len, len);
});

test('what the server sends is exactly what the game reads', async () => {
  const { h, id, path } = await withSong();
  const cat = await (await h.request('GET', '/api/activity/songs')).json();
  const rows = readCatalog(cat);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].title, rows[0].artist, rows[0].cv], [id, 'Test Tone', 'Made by me', 1]);
  assert.match(path, AUDIO_RE);
  const detail = await (await h.request('GET', `/api/activity/songs/${id}?v=1`)).json();
  const entry = readSong(detail, id, 1);
  assert.equal(entry.url, path);
  assert.equal(entry.len, 60000);
  const chart = await (await h.request('GET', `/api/activity/songs/${id}/chart?d=expert&v=1`)).json();
  assert.deepEqual(chart.notes, detail.charts.d.expert);
  assert.equal(chart.url, path);
  assert.equal((await h.request('GET', `/api/activity/songs/${id}/chart?d=insane`)).status, 400);
  resetSongs();
  setSongFetch(async (url) => h.request('GET', url));
  try {
    await loadChart(id, 1);
    const song = chartSong(id, 1, 'expert', 60);
    assert.ok(song && countOf(song) > 0);
    assert.ok(song.notes.every((n) => n.l >= 0 && n.l < 4));
    await assert.rejects(loadChart(id, 2));
  } finally {
    setSongFetch(null);
    resetSongs();
  }
});

test('song pieces and charts fit inside a D1 row', () => {
  const D1_ROW = 2000000;
  assert.ok(SONG_CHUNK <= D1_ROW - 4096);
  assert.ok(SONG_MAX_PARTS * SONG_CHUNK >= SONG_MAX_BYTES);
  assert.ok(FINISH_BODY_LIMIT >= CHART_MAX_BYTES + 4096);
  assert.ok(CHART_MAX_BYTES < D1_ROW / 10);
});

test('the song player keeps only the played part, at most two songs, and lets go when closed', async () => {
  const RATE = 32000;
  const made = [];
  class FakeOffline {
    constructor(ch, len, rate) {
      this.rate = rate;
    }
    decodeAudioData(data) {
      const secs = 300;
      const chans = [new Float32Array(secs * this.rate), new Float32Array(secs * this.rate)];
      return Promise.resolve({ sampleRate: this.rate, length: secs * this.rate, numberOfChannels: 2, getChannelData: (c) => chans[c], bytes: data.byteLength });
    }
    createBuffer(ch, n, rate) {
      const chans = Array.from({ length: ch }, () => new Float32Array(n));
      const buf = { sampleRate: rate, length: n, numberOfChannels: ch, getChannelData: (c) => chans[c], copyToChannel: (src, c) => chans[c].set(src) };
      made.push(buf);
      return buf;
    }
  }
  const body = (n) => new Response(new Uint8Array(n), { headers: { 'Content-Length': String(n) } });
  const player = createSongAudio({ win: { OfflineAudioContext: FakeOffline }, get: async (url) => (url.includes('big') ? body(AUDIO_MAX_BYTES + 1) : body(1000)) });
  const a = await player.load('/song-audio/s-0000000000000001.mp3', { from: 30, len: 60 });
  assert.ok(Math.abs(a.buf.length - 62 * RATE) <= 2, 'only the section plus a short pad is kept');
  assert.equal(a.buf.sampleRate, RATE);
  await player.load('/song-audio/s-0000000000000002.mp3', { from: 0, len: 45 });
  await player.load('/song-audio/s-0000000000000003.mp3', { from: 0, len: 45 });
  assert.equal(player.cached, CACHE_MAX);
  assert.equal(player.ready('/song-audio/s-0000000000000001.mp3', 30, 60), null, 'the oldest song is let go');
  await assert.rejects(player.load('/song-audio/big.mp3', { from: 0, len: 45 }), /too big/);
  player.destroy();
  assert.equal(player.cached, 0);
  await assert.rejects(player.load('/song-audio/s-0000000000000002.mp3', { from: 0, len: 45 }));
});

test('the host refuses impossible scores on an uploaded song', async () => {
  const { h, id } = await withSong();
  resetSongs();
  setSongFetch(async (url) => h.request('GET', url));
  try {
    await loadChart(id, 1);
    const song = chartSong(id, 1, 'hard', 60);
    const n = countOf(song);
    const early = objectsBefore(song, 5);
    assert.ok(early < n);
    assert.equal(checkProgress(song, 5, [n, n, 0, 0, 0, n, n]), null);
    assert.equal(checkProgress(song, 999, [n + 1, n + 1, 0, 0, 0, 1, 1]), null);
    assert.equal(checkProgress(song, 999, [n, n, 0, 0, 0, n + 1, n + 1]), null);
    assert.equal(checkProgress(song, 999, [n, n - 1, 0, 0, 0, 0, 0]), null);
    assert.equal(checkProgress(song, 999, [-1, 0, 0, 0, 0, 0, 0]), null);
    assert.equal(checkProgress(song, 999, [1.5, 1.5, 0, 0, 0, 0, 0]), null);
    assert.equal(checkFinal(song, 5, [n, 0, 0, 0, n]), null);
    assert.equal(checkFinal(song, 999, [n + 1, 0, 0, 0, 0]), null);
    const fair = checkFinal(song, 999, [n, 0, 0, 0, n]);
    assert.ok(fair && fair.score <= 1000);
    const base = checkProgress(song, 999, [10, 10, 0, 0, 0, 10, 10]);
    assert.ok(base);
    assert.equal(checkProgress(song, 999, [5, 5, 0, 0, 0, 5, 5], base), null);
  } finally {
    setSongFetch(null);
    resetSongs();
  }
});
