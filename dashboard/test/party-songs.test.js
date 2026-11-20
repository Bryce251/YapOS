import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance } from './helpers.js';
import { cleanup } from '../worker/cron.js';
import { sniffAudio } from '../worker/songs.js';
import { SONG_CHUNK, SONG_CAP_COUNT, encodeNotes } from '../web/activity/js/games/beatcodec.js';
import { OWNER, ADMIN, songsHarness, cookies, makeMp3, makeOgg, splitParts, wholeHash, putBytes, begin, upload, finishBody, makeCharts } from './song-fixtures.js';

const MIN = 60 * 1000;
const SIZE = 2000000;

async function setup(overrides) {
  const h = songsHarness(overrides);
  return { h, ...(await cookies(h)) };
}

function seedSong(h, i, { bytes = 2000000, hidden = 0, uploader = OWNER.id.toLowerCase() } = {}) {
  const id = `s-${String(i).padStart(16, '0')}`;
  h.db.raw.prepare("INSERT INTO party_songs (id, hash, mime, ext, bytes, parts, duration_ms, title, artist, credit, bpm, offset_ms, start_ms, end_ms, preview_ms, charts, chart_v, counts, hidden, uploader, rights_confirmed_at, created, updated) VALUES (?, ?, 'audio/mpeg', 'mp3', ?, 1, 60000, 'Seed', 'Seed', '', 120, 0, 0, 60000, 0, ?, 1, '[1,1,1,1]', ?, ?, 1, ?, 1)")
    .run(id, id.padEnd(64, '0'), bytes, JSON.stringify(makeCharts(60000)), hidden, uploader, i);
  return id;
}

const count = (h, sql, ...args) => Number(h.db.raw.prepare(sql).get(...args).n);

test('only signed in Party staff can use the song shelf', async () => {
  const { h, owner, admin, carol } = await setup();
  assert.equal((await h.api('GET', '/api/party/songs', null)).status, 401);
  const plain = await h.api('GET', '/api/party/songs', carol);
  assert.equal(plain.status, 403);
  assert.match((await plain.json()).message, /Only YapOS Party staff/);
  const a = await h.api('GET', '/api/party/songs', admin);
  assert.equal(a.status, 200);
  const body = await a.json();
  assert.equal(body.role, 'admin');
  assert.deepEqual(body.usage, { count: 0, bytes: 0, capCount: SONG_CAP_COUNT, capBytes: 200 * 1048576 });
  assert.match(a.headers.get('Cache-Control'), /no-store/);
  assert.equal((await (await h.api('GET', '/api/party/songs', owner)).json()).role, 'owner');
});

test('song changes need the CSRF headers', async () => {
  const { h, owner } = await setup();
  const bytes = makeMp3(SIZE);
  const body = { bytes: bytes.length, parts: 2, hash: wholeHash(bytes) };
  assert.equal((await h.api('POST', '/api/party/songs/uploads', owner, body, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', '/api/party/songs/uploads', owner, body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('POST', '/api/party/songs/uploads', owner, body, { Origin: null })).status, 403);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_uploads'), 0);
});

test('starting an upload checks the size and the parts', async () => {
  const { h, owner } = await setup();
  const hash = 'a'.repeat(64);
  const post = (b) => h.api('POST', '/api/party/songs/uploads', owner, b);
  assert.equal((await post({ bytes: 0, parts: 0, hash })).status, 400);
  assert.equal((await post({ bytes: 9000000, parts: 7, hash })).status, 413);
  assert.equal((await post({ bytes: SIZE, parts: 1, hash })).status, 400);
  assert.equal((await post({ bytes: SIZE, parts: 2, hash: 'nope' })).status, 400);
  const ok = await post({ bytes: SIZE, parts: 2, hash });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.match(body.upload, /^u-[0-9a-z]{16}$/);
  assert.equal(body.chunk, SONG_CHUNK);
  assert.equal(body.parts, 2);
});

test('a full shelf says so in plain words', async () => {
  const { h, owner } = await setup();
  for (let i = 1; i <= SONG_CAP_COUNT; i++) seedSong(h, i, { bytes: 1000 });
  const res = await begin(h, owner, makeMp3(SIZE));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'store_full');
  assert.equal(res.body.message, 'The song shelf is full (40 songs or 200 MB). Delete a song to make room.');
});

test('the byte cap counts songs and pending uploads and can be changed', async () => {
  const { h, owner, admin } = await setup({ SONG_STORE_MB: '50' });
  seedSong(h, 1, { bytes: 50 * 1048576 - 3000000 });
  const first = await begin(h, admin, makeMp3(SIZE, 5));
  assert.equal(first.status, 201);
  const second = await begin(h, owner, makeMp3(SIZE, 6));
  assert.equal(second.status, 409);
  assert.match(second.body.message, /50 MB/);
  const tiny = await setup({ SONG_STORE_MB: '1' });
  assert.equal((await (await tiny.h.api('GET', '/api/party/songs', tiny.owner)).json()).usage.capBytes, 50 * 1048576);
});

test('each person can only have two uploads going at once', async () => {
  const { h, owner } = await setup();
  assert.equal((await begin(h, owner, makeMp3(SIZE, 1))).status, 201);
  assert.equal((await begin(h, owner, makeMp3(SIZE, 2))).status, 201);
  const third = await begin(h, owner, makeMp3(SIZE, 3));
  assert.equal(third.status, 409);
  assert.equal(third.body.error, 'too_many_uploads');
  const again = await begin(h, owner, makeMp3(SIZE, 1));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.have, []);
});

test('pieces must be the exact size, in range, yours and in time', async () => {
  const { h, owner, admin } = await setup();
  const bytes = makeMp3(SIZE);
  const parts = splitParts(bytes);
  const { body } = await begin(h, owner, bytes);
  const at = (i) => `/api/party/songs/uploads/${body.upload}/${i}`;
  assert.equal((await putBytes(h, owner, at(0), parts[0].subarray(0, 1000))).status, 400);
  assert.equal((await putBytes(h, owner, at(1), parts[0])).status, 400);
  assert.equal((await putBytes(h, owner, at(2), parts[1])).status, 400);
  assert.equal((await putBytes(h, owner, at('x'), parts[1])).status, 400);
  assert.equal((await putBytes(h, owner, at(0), parts[0], { type: 'audio/mpeg' })).status, 415);
  assert.equal((await putBytes(h, admin, at(0), parts[0])).status, 404);
  const ok = await putBytes(h, owner, at(1), parts[1]);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).idx, 1);
  advance(h, 61 * MIN);
  assert.equal((await putBytes(h, owner, at(0), parts[0])).status, 404);
});

test('the first piece must really be a song', async () => {
  const { h, owner } = await setup();
  const enc = new TextEncoder();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(100).fill(0)]);
  const html = enc.encode('<!doctype html><script>alert(1)</script>'.padEnd(200, ' '));
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(100).fill(1)]);
  for (const bad of [png, html, zip]) {
    const b = await begin(h, owner, bad);
    const res = await putBytes(h, owner, `/api/party/songs/uploads/${b.body.upload}/0`, bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, 'That file is not an MP3, OGG or M4A song.');
    await h.api('DELETE', `/api/party/songs/uploads/${b.body.upload}`, owner);
  }
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks'), 0);
});

test('the sniffer knows MP3, OGG and M4A and nothing else', () => {
  assert.deepEqual(sniffAudio(makeMp3(100)), { mime: 'audio/mpeg', ext: 'mp3' });
  const id3 = new Uint8Array(200);
  id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20], 0);
  id3.set([0xff, 0xfb, 0x90, 0x64], 30);
  assert.equal(sniffAudio(id3).ext, 'mp3');
  id3.set([0, 0, 0, 0], 30);
  assert.equal(sniffAudio(id3), null);
  assert.deepEqual(sniffAudio(makeOgg(200)), { mime: 'audio/ogg', ext: 'ogg' });
  const theora = makeOgg(200);
  theora.set(new TextEncoder().encode('xxxxxxxx'), 28);
  assert.equal(sniffAudio(theora), null);
  const m4a = new Uint8Array(64);
  m4a.set([0, 0, 0, 24], 0);
  m4a.set(new TextEncoder().encode('ftypM4A \u0000\u0000\u0000\u0000isom'), 4);
  assert.deepEqual(sniffAudio(m4a), { mime: 'audio/mp4', ext: 'm4a' });
  m4a.set(new TextEncoder().encode('qt  '), 8);
  assert.equal(sniffAudio(m4a), null);
  m4a.set(new TextEncoder().encode('3gp4'), 8);
  assert.equal(sniffAudio(m4a), null);
});

test('sending a piece again replaces it', async () => {
  const { h, owner } = await setup();
  const bytes = makeMp3(SIZE);
  const parts = splitParts(bytes);
  const { body } = await begin(h, owner, bytes);
  const wrong = makeMp3(parts[1].length, 99);
  await putBytes(h, owner, `/api/party/songs/uploads/${body.upload}/1`, wrong);
  await putBytes(h, owner, `/api/party/songs/uploads/${body.upload}/1`, parts[1]);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks WHERE owner = ?', body.upload), 1);
  const resumed = await begin(h, owner, bytes);
  assert.equal(resumed.body.upload, body.upload);
  assert.deepEqual(resumed.body.have.map((x) => x.idx), [1]);
});

test('a finished upload becomes a song with the type from its bytes', async () => {
  const { h, owner } = await setup();
  const res = await upload(h, owner, makeMp3(SIZE));
  assert.equal(res.status, 201);
  const s = res.body.song;
  assert.match(s.id, /^s-[0-9a-f]{16}$/);
  assert.equal(s.id, `s-${wholeHash(makeMp3(SIZE)).slice(0, 16)}`);
  assert.equal(s.url, `/song-audio/${s.id}.mp3`);
  assert.equal(s.cv, 1);
  assert.equal(s.counts.length, 4);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks WHERE owner = ?', s.id), 2);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_uploads'), 0);
  const row = h.db.raw.prepare('SELECT mime, rights_confirmed_at, uploader FROM party_songs WHERE id = ?').get(s.id);
  assert.equal(row.mime, 'audio/mpeg');
  assert.equal(row.rights_confirmed_at, h.clock.t);
  assert.equal(row.uploader, OWNER.id.toLowerCase());
  const log = h.db.raw.prepare("SELECT action FROM party_mod_log WHERE action = 'song_add'").all();
  assert.equal(log.length, 1);
  const ogg = await upload(h, owner, makeOgg(SIZE));
  assert.equal(ogg.status, 201);
  assert.equal(ogg.body.song.url.endsWith('.ogg'), true);
});

test('finish checks the hash, every part and the rights box', async () => {
  const { h, owner } = await setup();
  const bytes = makeMp3(SIZE);
  const parts = splitParts(bytes);
  const b = await begin(h, owner, bytes, { hash: 'b'.repeat(64) });
  for (let i = 0; i < parts.length; i++) await putBytes(h, owner, `/api/party/songs/uploads/${b.body.upload}/${i}`, parts[i]);
  const mismatch = await h.api('POST', `/api/party/songs/uploads/${b.body.upload}/finish`, owner, finishBody());
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, 'bad_hash');
  await h.api('DELETE', `/api/party/songs/uploads/${b.body.upload}`, owner);
  const c = await begin(h, owner, bytes);
  await putBytes(h, owner, `/api/party/songs/uploads/${c.body.upload}/0`, parts[0]);
  const missing = await h.api('POST', `/api/party/songs/uploads/${c.body.upload}/finish`, owner, finishBody());
  assert.equal((await missing.json()).error, 'missing_part');
  await putBytes(h, owner, `/api/party/songs/uploads/${c.body.upload}/1`, parts[1]);
  const noRights = await h.api('POST', `/api/party/songs/uploads/${c.body.upload}/finish`, owner, finishBody({ rights: false }));
  assert.equal(noRights.status, 400);
  assert.equal((await noRights.json()).message, 'Tick the box to confirm you own this song or have permission to use it.');
});

test('finish checks words, byte rate, the section and the chart', async () => {
  const { h, owner } = await setup();
  const bytes = makeMp3(SIZE);
  const b = await begin(h, owner, bytes);
  const parts = splitParts(bytes);
  for (let i = 0; i < parts.length; i++) await putBytes(h, owner, `/api/party/songs/uploads/${b.body.upload}/${i}`, parts[i]);
  const fin = async (extra) => {
    const res = await h.api('POST', `/api/party/songs/uploads/${b.body.upload}/finish`, owner, finishBody(extra));
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await fin({ title: 'Song 1488' })).body.error, 'blocked_word');
  assert.equal((await fin({ title: '   ' })).status, 400);
  assert.equal((await fin({ title: 'x'.repeat(61) })).status, 400);
  assert.equal((await fin({ duration_ms: 20000 })).body.error, 'bad_length');
  assert.equal((await fin({ duration_ms: 400000, end_ms: 60000 })).body.error, 'bad_length');
  assert.equal((await fin({ duration_ms: 30000, end_ms: 30000 })).body.error, 'bad_length');
  assert.equal((await fin({ start_ms: 0, end_ms: 20000 })).body.error, 'bad_section');
  assert.equal((await fin({ start_ms: 10000, end_ms: 70000, charts: makeCharts(60000) })).body.error, 'bad_section');
  assert.equal((await fin({ offset_ms: 400 })).body.error, 'bad_offset');
  const broken = makeCharts(60000);
  broken.d.easy = encodeNotes([{ t: 2000, l: 0, e: 2500 }]);
  const chart = await fin({ charts: broken });
  assert.equal(chart.body.error, 'bad_chart');
  assert.match(chart.body.message, /Only Hard and Expert/);
  assert.equal((await fin({ charts: makeCharts(50000) })).body.error, 'bad_chart');
  assert.equal((await fin({ extra: 1 })).body.error, 'bad_field');
  const ok = await fin({ title: '  Night\u0000 Tone  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.song.title, 'Night Tone');
});

test('the same file twice points at the song already on the shelf', async () => {
  const { h, owner, admin } = await setup();
  const first = await upload(h, owner, makeMp3(SIZE));
  const again = await upload(h, admin, makeMp3(SIZE));
  assert.equal(again.status, 200);
  assert.equal(again.body.exists, first.body.song.id);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_songs'), 1);
});

test('editing notes or timing bumps the chart version and hiding keeps the chart loadable', async () => {
  const { h, owner } = await setup();
  const { body } = await upload(h, owner, makeMp3(SIZE));
  const id = body.song.id;
  const meta = await h.api('PATCH', `/api/party/songs/${id}`, owner, { title: 'Renamed' });
  assert.equal((await meta.json()).song.cv, 1);
  const off = await h.api('PATCH', `/api/party/songs/${id}`, owner, { offset_ms: 25 });
  assert.equal((await off.json()).song.cv, 2);
  const moved = await h.api('PATCH', `/api/party/songs/${id}`, owner, { start_ms: 10000, end_ms: 55000, charts: makeCharts(45000) });
  const ms = await moved.json();
  assert.equal(ms.song.cv, 3);
  assert.equal(ms.song.start_ms, 10000);
  assert.equal((await h.api('PATCH', `/api/party/songs/${id}`, owner, { start_ms: 5000 })).status, 400);
  const list = async () => (await (await h.request('GET', '/api/activity/songs')).json()).songs;
  assert.equal((await list()).length, 1);
  assert.equal((await list())[0][1], 'Renamed');
  await h.api('PATCH', `/api/party/songs/${id}`, owner, { hidden: true });
  assert.equal((await list()).length, 0);
  const chart = await h.request('GET', `/api/activity/songs/${id}?v=3`);
  assert.equal(chart.status, 200);
  assert.equal((await chart.json()).charts.len, 45000);
  const log = h.db.raw.prepare("SELECT action FROM party_mod_log WHERE action LIKE 'song_%' ORDER BY created, rowid").all().map((r) => r.action);
  assert.deepEqual(log, ['song_add', 'song_edit', 'song_edit', 'song_edit', 'song_hide']);
});

test('admins can hide any song but only the uploader or owner can change notes or delete', async () => {
  const { h, owner, admin, admin2 } = await setup();
  const mine = (await upload(h, admin, makeMp3(SIZE))).body.song.id;
  assert.equal((await h.api('PATCH', `/api/party/songs/${mine}`, admin2, { hidden: true })).status, 200);
  assert.equal((await h.api('PATCH', `/api/party/songs/${mine}`, admin2, { charts: makeCharts(60000) })).status, 403);
  assert.equal((await h.api('DELETE', `/api/party/songs/${mine}`, admin2)).status, 403);
  assert.equal((await h.api('PATCH', `/api/party/songs/${mine}`, admin, { charts: makeCharts(60000) })).status, 200);
  const del = await h.api('DELETE', `/api/party/songs/${mine}`, owner);
  assert.equal(del.status, 200);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks'), 0);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_songs'), 0);
  assert.equal((await h.request('GET', `/api/activity/songs/${mine}`)).status, 404);
  assert.equal((await h.api('DELETE', `/api/party/songs/${mine}`, owner)).status, 404);
});

test('the public song list and charts need no sign-in and cache well', async () => {
  const { h, owner } = await setup();
  const id = (await upload(h, owner, makeMp3(SIZE))).body.song.id;
  const list = await h.request('GET', '/api/activity/songs');
  assert.equal(list.headers.get('Cache-Control'), 'public, max-age=60');
  const lb = await list.json();
  assert.deepEqual(lb.diffs, ['easy', 'normal', 'hard', 'expert']);
  const [sid, title, artist, dur, bpm, cv, counts, credit, len] = lb.songs[0];
  assert.deepEqual([sid, title, artist, dur, bpm, cv, credit, len], [id, 'Test Tone', 'Made by me', 60000, 120, 1, 'Made by me', 60000]);
  assert.equal(counts.length, 4);
  const fresh = await h.request('GET', `/api/activity/songs/${id}?v=1`);
  assert.equal(fresh.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  const full = await fresh.json();
  assert.equal(full.url, `/song-audio/${id}.mp3`);
  assert.deepEqual(Object.keys(full.charts.d), ['easy', 'normal', 'hard', 'expert']);
  const stale = await h.request('GET', `/api/activity/songs/${id}?v=9`);
  assert.equal(stale.headers.get('Cache-Control'), 'public, max-age=60');
  const one = await h.request('GET', `/api/activity/songs/${id}/chart?d=expert&v=1`);
  const ob = await one.json();
  assert.equal(ob.d, 'expert');
  assert.deepEqual(ob.notes, full.charts.d.expert);
  assert.equal(one.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await h.request('GET', `/api/activity/songs/${id}/chart?d=insane`)).status, 400);
  assert.equal((await h.request('GET', '/api/activity/songs/s-zz')).status, 404);
  assert.equal((await h.request('POST', '/api/activity/songs', { body: {} })).status, 405);
});

test('song edits are rate limited', async () => {
  const { h, owner } = await setup();
  const id = seedSong(h, 1);
  let last;
  for (let i = 0; i < 21; i++) last = await h.api('PATCH', `/api/party/songs/${id}`, owner, { hidden: i % 2 === 0 });
  assert.equal(last.status, 429);
  advance(h, MIN);
  assert.equal((await h.api('PATCH', `/api/party/songs/${id}`, owner, { hidden: false })).status, 200);
  let pub;
  for (let i = 0; i < 121; i++) pub = await h.request('GET', '/api/activity/songs', { ip: '198.51.100.9' });
  assert.equal(pub.status, 429);
});

test('the nightly clean up removes old uploads and stray pieces', async () => {
  const { h, owner } = await setup();
  const keep = (await upload(h, owner, makeMp3(SIZE))).body.song.id;
  const bytes = makeMp3(SIZE, 7);
  const b = await begin(h, owner, bytes);
  await putBytes(h, owner, `/api/party/songs/uploads/${b.body.upload}/0`, splitParts(bytes)[0]);
  h.db.raw.prepare("INSERT INTO party_song_chunks (owner, idx, data, bytes, hash) VALUES ('u-strayxxxxxxxxxxxx', 0, x'00', 1, 'x'), ('s-0000000000000bad', 0, x'00', 1, 'x')").run();
  advance(h, 2 * 60 * MIN);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.songUploads, 1);
  assert.equal(removed.songChunks, 3);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks'), 2);
  assert.equal(count(h, 'SELECT COUNT(*) AS n FROM party_song_chunks WHERE owner = ?', keep), 2);
});

test('a file far too small for its length is refused', async () => {
  const { h, owner } = await setup();
  const res = await upload(h, owner, makeMp3(200000, 8));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad_length');
});
