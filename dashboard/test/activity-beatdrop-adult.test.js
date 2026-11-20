import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded, person } from './activity-kit.test.js';
import { installDom, flush } from './dom-shim.js';
import beatdrop, { KEY, RANDOM, SKIP_ADULT, ADULT_SKIP_TEXT, DROPPED, lineup, songChoices, cleanLineup, allowedSongs } from '../web/activity/js/games/beatdrop.js';
import { setSongFetch, setSongAuth, resetSongs, loadCatalog, readCatalog, readSong, songAdult, songFetch, songMeta, encodeNotes, putChart } from '../web/activity/js/games/beatsongs.js';
import { lobbyModel, songOptions, staffHostOk } from '../web/activity/js/ui/lobby.js';
import { gateToken } from '../web/activity/js/ui/app.js';

const SAFE = 's-0000000000000a01';
const SAFE2 = 's-0000000000000a02';
const ADULT = 's-0000000000000b01';
const ADMIN_ID = person(1).id;
const TOKEN = 'T'.repeat(43);

const adminsWith = (ids) => ({ isAdmin: (id) => ids.includes(id), knows: () => true, ownerId: () => null, banned: () => false, refresh: null, onChange: null });
const NONE = adminsWith([]);
const ONE = adminsWith([ADMIN_ID]);

function makeNotes(len, step) {
  const out = [];
  let k = 0;
  for (let t = 2000; t <= len - 1000; t += step) out.push({ t, l: k++ % 4 });
  return out;
}

function makeChart(len) {
  return { v: 1, bpm: 120, b0: 500, len, marks: [], d: { easy: encodeNotes(makeNotes(len, 1000)), normal: encodeNotes(makeNotes(len, 500)), hard: encodeNotes(makeNotes(len, 400)), expert: encodeNotes(makeNotes(len, 250)) } };
}

const TITLES = { [SAFE]: 'Day Song', [SAFE2]: 'Noon Song', [ADULT]: 'Late Song' };

function body(id) {
  return { id, title: TITLES[id], artist: 'Band', credit: 'Made by me', url: `/song-audio/${id}.mp3`, dur: 200000, bpm: 120, off: 0, start: 0, end: 45000, cv: 1, adult: id === ADULT, charts: makeChart(45000) };
}

function catRow(id) {
  return [id, TITLES[id], 'Band', 200000, 120, 1, [1, 2, 3, 4], '', 45000, 0, id === ADULT ? 1 : 0];
}

async function useSongs(ids = [SAFE, SAFE2, ADULT], log = []) {
  resetSongs();
  setSongFetch(async (url, init) => {
    log.push({ url, init });
    if (url === '/api/activity/songs') return { ok: true, json: async () => ({ songs: ids.map(catRow) }) };
    const m = /^\/api\/activity\/songs\/(s-[0-9a-f]{16})\?v=1$/.exec(url);
    if (m && ids.includes(m[1])) return { ok: true, json: async () => body(m[1]) };
    return { ok: false, status: 404, json: async () => ({}) };
  }, { timer: () => 0, clear() {} });
  await loadCatalog({ force: true });
}

async function settle(r, ms = 50) {
  await flush(20);
  await r.clock.advance(ms);
  await flush(5);
}

const st = (r) => r.hub.state[KEY];

async function startGame({ admins = NONE, settings = {}, ids, n = 3 } = {}) {
  await useSongs(ids);
  const r = room(n, { games: [beatdrop], admins });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('beatdrop'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await settle(r, 300);
  return r;
}

async function allReady(r) {
  const s = st(r);
  for (const e of r.engines) e.act({ type: 'loaded', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
}

async function until(r, pred, max = 200000, step = 250) {
  const end = r.clock.now() + max;
  while (!pred() && r.clock.now() < end) await r.clock.advance(step);
  return pred();
}

const CAT = () => readCatalog({ songs: [SAFE, SAFE2, ADULT].map(catRow) });

test('the song list carries the 18+ flag and the client reads it from both row shapes', () => {
  const cat = CAT();
  assert.deepEqual(cat.map((r) => r.adult), [false, false, true]);
  const obj = readCatalog({ songs: [{ id: ADULT, title: 'X', artist: '', dur: 1, bpm: 120, cv: 1, counts: [], adult: true }, { id: SAFE, title: 'Y', cv: 1, mature: 'yes' }] });
  assert.deepEqual(obj.map((r) => r.adult), [true, false], 'only a real true or 1 counts');
  const old = readCatalog({ songs: [[SAFE, 'Old', 'Band', 1, 120, 1, []]] });
  assert.equal(old[0].adult, false, 'rows from before the flag are fine for everyone');
  const e = readSong(body(ADULT), ADULT, 1);
  assert.equal(e.adult, true);
  assert.equal(readSong({ ...body(SAFE), adult: 'true' }, SAFE, 1).adult, false);
});

test('a host who is not a Party admin never sees or gets 18+ songs, and a saved 18+ pick falls back to Random', () => {
  const cat = CAT();
  assert.deepEqual(songChoices(cat).map((o) => o.value), [RANDOM, SAFE, SAFE2]);
  assert.deepEqual(allowedSongs(cat).map((r) => r.id), [SAFE, SAFE2]);
  for (let k = 0; k < 30; k += 1) {
    for (const settings of [{ song: RANDOM }, { song: RANDOM, mature: true }, { song: ADULT }, { song: ADULT, mature: true }]) {
      const out = lineup(settings, 3, seeded(k + 1), cat, false);
      assert.equal(out.length, 3);
      assert.ok(out.every((p) => p[0] !== ADULT), JSON.stringify(settings));
    }
  }
  assert.deepEqual(lineup({ song: ADULT }, 2, seeded(1), readCatalog({ songs: [catRow(ADULT)] }), false), [], 'only 18+ songs means nothing to play');
});

test('an admin host sees 18+ songs labeled in the picker, can pick one, and Random only uses them when the toggle is on', () => {
  const cat = CAT();
  const opts = songChoices(cat, { adult: true });
  assert.deepEqual(opts.map((o) => o.value), [RANDOM, SAFE, SAFE2, ADULT]);
  assert.equal(opts[3].label, 'Late Song - Band (18+)');
  assert.equal(opts[3].adult, true);
  assert.deepEqual(lineup({ song: ADULT }, 2, seeded(2), cat, true), [[ADULT, 1], [ADULT, 1]]);
  for (let k = 0; k < 30; k += 1) {
    const off = lineup({ song: RANDOM }, 3, seeded(k + 1), cat, true);
    assert.ok(off.every((p) => p[0] !== ADULT), 'the toggle is off by default');
    const on = lineup({ song: RANDOM, mature: true }, 3, seeded(k + 1), cat, true);
    assert.deepEqual(new Set(on.map((p) => p[0])), new Set([SAFE, SAFE2, ADULT]), 'with the toggle on Random can pick 18+ songs');
  }
});

test('cleaning a lineup for a new host swaps upcoming 18+ songs for safe ones or marks them to skip', async () => {
  await useSongs();
  const list = [[ADULT, 1], [ADULT, 1], [SAFE, 1]];
  assert.deepEqual(cleanLineup(list, 0, true, seeded(1)), list, 'an admin host keeps the lineup');
  const out = cleanLineup(list, 1, false, seeded(1));
  assert.deepEqual(out[0], [ADULT, 1], 'songs already played are left alone');
  assert.ok([SAFE, SAFE2].includes(out[1][0]));
  assert.deepEqual(out[2], [SAFE, 1]);
  await useSongs([ADULT]);
  assert.deepEqual(cleanLineup(list.slice(0, 2), 0, false, seeded(1)), [DROPPED, DROPPED]);
  resetSongs();
});

test('the lobby shows the Include 18+ toggle only to an admin host and the picker follows the host', async () => {
  await useSongs();
  const spec = beatdrop.settings.find((s) => s.id === 'mature');
  assert.equal(spec.type, 'toggle');
  assert.equal(spec.default, false);
  assert.equal(staffHostOk(spec, { isHost: true, hostAdmin: true }), true);
  assert.equal(staffHostOk(spec, { isHost: true, hostAdmin: false }), false);
  assert.equal(staffHostOk(spec, { isHost: false, hostAdmin: true }), false);
  const songSpec = beatdrop.settings.find((s) => s.id === 'song');
  assert.equal(songOptions(songSpec, { hostAdmin: false }).some((o) => o.value === ADULT), false);
  assert.equal(songOptions(songSpec, { hostAdmin: true }).some((o) => o.value === ADULT), true);
  const r = room(2, { games: [beatdrop], admins: ONE });
  await r.clock.advance(500);
  assert.equal(r.engines[0].snapshot().hostAdmin, true);
  assert.equal(r.engines[1].snapshot().hostAdmin, true, 'everyone in the room knows the host is staff');
  assert.equal(lobbyModel(r.engines[0].snapshot(), [beatdrop]).hostAdmin, true);
  const plain = room(2, { games: [beatdrop], admins: NONE });
  await plain.clock.advance(500);
  assert.equal(plain.engines[0].snapshot().hostAdmin, false);

  installDom({ url: 'https://yapos.dev/activity/' });
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const store = { getItem: () => null, setItem() {} };
  const keys = (el) => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes || []) {
        if (c.dataset && c.dataset.key) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  };
  const show = (engine) => {
    const lobby = createLobby({ engine, toast() {}, sfx: { play() {} }, store });
    document.body.append(lobby.el);
    engine.lobby.pick('beatdrop');
    lobby.update(engine.snapshot());
    return lobby.el;
  };
  const adminEl = show(r.engines[0]);
  await r.clock.advance(200);
  assert.ok(keys(adminEl).some((n) => n.dataset.key === 'set-mature'), 'the admin host gets the toggle');
  const select = keys(adminEl).find((n) => n.dataset.key === 'set-song');
  assert.ok((select.childNodes || []).some((o) => /\(18\+\)/.test(o.textContent)), 'the picker labels 18+ songs');
  const guestEl = show(r.engines[1]);
  assert.equal(keys(guestEl).some((n) => n.dataset.key === 'set-mature'), false, 'players who are not hosting do not get the toggle');
  const plainEl = show(plain.engines[0]);
  assert.equal(keys(plainEl).some((n) => n.dataset.key === 'set-mature'), false, 'a host who is not staff does not get the toggle');
  const plainSelect = keys(plainEl).find((n) => n.dataset.key === 'set-song');
  assert.equal((plainSelect.childNodes || []).some((o) => /18\+/.test(o.textContent)), false);
  resetSongs();
});

test('an admin host can start a game on an 18+ song and the ready card and results tag it', async () => {
  const r = await startGame({ admins: ONE, settings: { song: ADULT, songs: 2 } });
  const s = st(r);
  assert.equal(s.phase, 'ready');
  assert.equal(s.sid, ADULT);
  assert.deepEqual(s.lineup, [[ADULT, 1], [ADULT, 1]]);
  const m = beatdrop.model(r.engines[1].snapshot());
  assert.equal(m.song.adult, true);
  assert.equal(songMeta(ADULT, 1).adult, true);
  await allReady(r);
  assert.equal(st(r).phase, 'play');
  assert.ok(await until(r, () => st(r).phase === 'show'));
  assert.equal(beatdrop.model(r.engines[0].snapshot()).song.adult, true);
  assert.deepEqual(st(r).tt.slice(2), [1]);
  resetSongs();
});

test('a host who is not staff with a saved 18+ pick plays a safe song instead', async () => {
  const r = await startGame({ admins: NONE, settings: { song: ADULT, songs: 3, mature: true } });
  const s = st(r);
  assert.equal(s.lineup.length, 3);
  assert.ok(s.lineup.every((p) => p[0] !== ADULT));
  assert.notEqual(s.sid, ADULT);
  assert.equal(beatdrop.model(r.engines[0].snapshot()).song.adult, false);
  resetSongs();
});

test('when hosting passes to someone who is not staff mid-song, the next 18+ song is swapped for a safe one', async () => {
  const r = await startGame({ admins: ONE, settings: { song: ADULT, songs: 2 } });
  await allReady(r);
  const s = st(r);
  assert.equal(s.phase, 'play');
  assert.equal(s.sid, ADULT);
  r.hub.leave(ADMIN_ID);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'play', 'the song already playing finishes');
  assert.equal(after.sid, ADULT);
  assert.ok([SAFE, SAFE2].includes(after.lineup[1][0]), 'the upcoming song is safe');
  const m = beatdrop.model(r.engines[1].snapshot());
  assert.equal(m.next.title === TITLES[SAFE] || m.next.title === TITLES[SAFE2], true);
  assert.ok(await until(r, () => st(r).phase === 'ready' && st(r).i === 1));
  assert.ok([SAFE, SAFE2].includes(st(r).sid));
  resetSongs();
});

test('when hosting passes on during the ready card of an 18+ song, a safe song replaces it', async () => {
  const r = await startGame({ admins: ONE, settings: { song: ADULT, songs: 1 } });
  const s = st(r);
  assert.equal(s.sid, ADULT);
  r.hub.leave(ADMIN_ID);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'ready');
  assert.ok(after.n > s.n, 'everyone gets a fresh ready card');
  assert.ok([SAFE, SAFE2].includes(after.sid));
  resetSongs();
});

test('with no safe songs left, upcoming 18+ songs are skipped with a plain message', async () => {
  const r = await startGame({ admins: ONE, settings: { song: ADULT, songs: 2 }, ids: [ADULT] });
  await allReady(r);
  r.hub.leave(ADMIN_ID);
  await r.clock.advance(2000);
  assert.deepEqual(st(r).lineup[1], DROPPED);
  assert.ok(await until(r, () => st(r).phase === 'show' && st(r).i === 1));
  assert.equal(st(r).sk, SKIP_ADULT);
  assert.equal(beatdrop.model(r.engines[1].snapshot()).skipped, ADULT_SKIP_TEXT);
  resetSongs();
});

test('song requests carry the Party sign-in so 18+ charts and audio load for signed in players', async () => {
  const log = [];
  await useSongs([SAFE, ADULT], log);
  setSongAuth(gateToken({ state: () => ({ status: 'in', token: TOKEN }) }));
  await songFetch(`/api/activity/songs/${ADULT}?v=1`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const last = log[log.length - 1].init;
  assert.equal(last.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(last.headers.Accept, 'application/json');
  assert.equal(last.credentials, 'same-origin');
  await songFetch(`/song-audio/${ADULT}.mp3`, { credentials: 'same-origin' });
  assert.equal(log[log.length - 1].init.headers.Authorization, `Bearer ${TOKEN}`);
  setSongAuth(gateToken({ state: () => ({ status: 'out', token: TOKEN }) }));
  await songFetch(`/song-audio/${ADULT}.mp3`, { credentials: 'same-origin' });
  assert.equal(log[log.length - 1].init.headers, undefined, 'signed out sends no token');
  setSongAuth(() => 'not a token');
  await songFetch(`/song-audio/${ADULT}.mp3`, { credentials: 'same-origin' });
  assert.equal(log[log.length - 1].init.headers, undefined);
  setSongAuth(() => {
    throw new Error('boom');
  });
  await songFetch(`/song-audio/${ADULT}.mp3`);
  assert.equal(log[log.length - 1].init, undefined);
  setSongAuth(null);
  resetSongs();
});

test('the 18+ flag also comes from a loaded chart when the song list has not arrived', async () => {
  resetSongs();
  assert.equal(songAdult(ADULT), false);
  putChart(readSong(body(ADULT), ADULT, 1));
  assert.equal(songAdult(ADULT), true);
  assert.equal(songAdult(SAFE), false);
  assert.equal(songAdult(null), false);
  resetSongs();
});

test('the ready card and per-song results show a small 18+ tag', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const { adultTag } = await import('../web/activity/js/views/beatdrop.js');
  const tag = adultTag({ adult: true });
  assert.equal(tag.textContent, '18+');
  assert.equal(tag.className, 'bd-adult');
  assert.equal(adultTag({ adult: false }), null);
  assert.equal(adultTag(null), null);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/activity/js/views/beatdrop.js', import.meta.url), 'utf8');
  assert.match(src, /beatdrop-title fx-display' \}, `Song: \$\{songLine\(r\.song\)\}`, adultTag\(r\.song\)\)/);
  assert.match(src, /bd-songline' \}, songLine\(r\.song\), adultTag\(r\.song\)\)/);
  const css = readFileSync(new URL('../web/activity/css/beatdrop-songs.css', import.meta.url), 'utf8');
  assert.match(css, /\.bd-adult \{/);
  assert.equal(/[^\x00-\x7f]/.test(css), false, 'the stylesheet stays plain ASCII');
});
