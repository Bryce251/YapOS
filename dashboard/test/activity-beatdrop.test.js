import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, seeded } from './activity-kit.test.js';
import { installDom, fire, flush, FakeEvent } from './dom-shim.js';
import { FUN, ROOM, cleanSetting, settingsFor, pickTourGames, blockedNote } from '../web/activity/js/engine.js';
import { GAMES } from '../web/activity/js/games/index.js';
import beatdrop, { KEY, V, READY_MS, READY_NEXT_MS, READY_MAX_MS, LOAD_WAIT_MS, LEAD_MS, SHOW_MS, SKIP_MS, END_GRACE_MS, PROG_GAP_MS, CHECK_MS, BLURB, GOAL, FLAG_PLAYED, FLAG_SAT, FLAG_LEFT, DIFF_PAY, NEED_TEXT, WAIT_TEXT, SKIP_TEXT, LOAD_FAIL_TEXT, SKIP_LOAD, SKIP_NONE, SKIP_WAIT, WAIT_TRIES, lineup, songChoices, songsNote, usableSongs, checkProgress, checkFinal, songOfState, pointsFor, standings } from '../web/activity/js/games/beatdrop.js';
import { DIFFS, LANES, lanesFor, windowsFor, lookFor, createJudge, judge, scoreOf, accOf, tierOf, gradeOf, objectsBefore, objectCount, objTimes, countOf, prepSong, releaseKind, lastNoteAt, STRAY_MAX, STRAY_MS, MAX_SCORE, HOLD_GOOD_MS, HOLD_OK_MS } from '../web/activity/js/games/beatchart.js';
import { setSongFetch, resetSongs, loadCatalog, catalog, catalogTried, loadChart, chartSong, chartEntry, putChart, encodeNotes, decodeNotes, validateChart, readSong, readCatalog, checkNotes, songWindow, songLength, lengthLabel, CHART_TIMEOUT_MS, CHART_MAX_BYTES, CHART_CAPS, CHART_PEAK, SECTION_MAX_MS, LENGTH_CHOICES, FULL_SONG } from '../web/activity/js/games/beatsongs.js';import { createBeatdropView, createSongClock, eventTime, readPrefs, writePrefs, laneOfKey, keyLabels, heightFor, widthFor, rivalLine, tendencyOf, footText, songLine, loadText, OFFSET_KEY, PLAY_SHEET, SONG_SHEET, LANE_KEYS, SPEEDS, cleanSpeed, stepSpeed, speedLabel, cleanKeys, bindsFor, keyName } from '../web/activity/js/views/beatdrop.js';
import { createSongAudio, songSpan } from '../web/activity/js/views/beatsong.js';
import { createBeatPlayer, soundNote } from '../web/activity/js/views/beatsynth.js';
import { timingFrom, tutorialNotes, clampOffset, createTutorial, TIMING_MAX } from '../web/activity/js/views/beattut.js';
import { createBeatDraw, laneStyle, noteY, judgeY, gemSize, gemScale, laneGapMs, GEM_MIN_SCALE, HIT_Y } from '../web/activity/js/views/beatdraw.js';
import { lobbyModel, offText } from '../web/activity/js/ui/lobby.js';
import { jsonBytes } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const JS_FILES = ['js/games/beatchart.js', 'js/games/beatdrop.js', 'js/games/beatsongs.js', 'js/views/beatdrop.js', 'js/views/beatsynth.js', 'js/views/beatdraw.js', 'js/views/beattut.js', 'js/views/beatsong.js'];
const CSS_FILES = ['css/beatdrop.css', 'css/beatdrop-play.css', 'css/beatdrop-songs.css'];
const NET_FILES = ['js/games/beatsongs.js'];
const ACT = new URL('../web/activity/', import.meta.url);
const SID = 's-0123456789abcdef';
const SID2 = 's-fedcba9876543210';
const SID3 = 's-00000000000000aa';
const SIDX = 's-00000000000000ff';

function makeNotes(len, step, from = 2000, every = 0, holdMs = 0, chordEvery = 0) {
  const out = [];
  let k = 0;
  for (let t = from; t <= len - 1000; t += step) {
    const l = k % 4;
    const n = { t, l };
    if (every && k % every === 3 && holdMs) n.e = t + holdMs;
    out.push(n);
    if (chordEvery && k % chordEvery === 1) out.push({ t, l: (l + 2) % 4 });
    k += 1;
  }
  return out.sort((a, b) => a.t - b.t || a.l - b.l);
}

function makeChart(len = 40000) {
  return {
    v: 1,
    bpm: 120,
    b0: 500,
    len,
    marks: [[8000, 'build'], [16000, 'drop']],
    d: {
      easy: encodeNotes(makeNotes(len, 1000)),
      normal: encodeNotes(makeNotes(len, 500)),
      hard: encodeNotes(makeNotes(len, 400, 2000, 8, 300)),
      expert: encodeNotes(makeNotes(len, 250, 2000, 16, 400, 16)),
    },
  };
}

function songBody(id = SID, over = {}) {
  const len = over.len || 40000;
  return { id, title: 'Night Test', artist: 'The Testers', credit: 'Made by me', url: `/song-audio/${id}.mp3`, dur: 200000, bpm: 120, off: 0, start: 10000, end: 10000 + len, cv: 1, charts: makeChart(len), ...over };
}

function testSong(df = 1, len = 60) {
  if (!chartEntry(SIDX, 1)) putChart(readSong(songBody(SIDX, { len: 90000 }), SIDX, 1));
  return chartSong(SIDX, 1, df, len);
}

function songServer(opts = {}) {
  const { songs = [SID, SID2], broken = [], log = [] } = opts;
  const fetchFn = async (url) => {
    log.push(url);
    if (opts.down) return { ok: false, status: 503, json: async () => ({}) };
    if (url === '/api/activity/songs') return { ok: true, json: async () => ({ songs: songs.map((id, i) => [id, i ? 'Second Test' : 'Night Test', 'The Testers', 200000, 120, 1, [36, 72, 94, 160]]) }) };
    const m = /^\/api\/activity\/songs\/(s-[0-9a-f]{16})\?v=(\d+)$/.exec(url);
    if (m && songs.includes(m[1]) && !broken.includes(m[1])) return { ok: true, json: async () => songBody(m[1], { ...(opts.len ? { len: opts.len } : {}), ...titleFor(m[1]) }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return fetchFn;
}

function titleFor(id) {
  return id === SID2 ? { title: 'Second Test' } : {};
}

async function useSongs(opts = {}) {
  resetSongs();
  const timers = [];
  setSongFetch(songServer(opts), { timer: (fn) => timers.push(fn), clear() {} });
  await loadCatalog({ force: true });
  return timers;
}

function noSongs() {
  resetSongs();
  setSongFetch(null);
}

async function settle(r, ms = 50) {
  await flush(20);
  await r.clock.advance(ms);
  await flush(5);
}

function read(rel) {
  return readFileSync(new URL(rel, ACT), 'utf8');
}

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function slots(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

async function startGame(n = 3, settings = {}, games = [beatdrop], songOpts = {}) {
  await useSongs(songOpts);
  const r = room(n, { games });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('beatdrop'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await settle(r, 300);
  return r;
}

async function loadAll(r) {
  const s = st(r);
  for (const e of r.engines) e.act({ type: 'loaded', n: s.n });
  await settle(r, 50);
}

async function allReady(r) {
  const s = st(r);
  for (const e of r.engines) e.act({ type: 'loaded', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
}

async function playAlong(r, s, untilMs, plan) {
  const song = songOfState(s);
  while (r.clock.now() < untilMs && st(r).phase === 'play' && st(r).n === s.n) {
    const sec = (r.clock.now() - s.at) / 1000;
    const due = Math.max(0, objectsBefore(song, sec - 0.2));
    for (const [slot, how] of Object.entries(plan)) {
      const e = bySlot(r, Number(slot));
      if (!e || how === 'none') continue;
      const p = how === 'all' ? due : Math.floor(due / (how === 'half' ? 2 : 3));
      const b = how === 'all' ? due : Math.min(p, how === 'half' ? 2 : 1);
      e.act({ type: 'prog', n: s.n, v: [due, p, 0, 0, due - p, b, b] });
    }
    await r.clock.advance(Math.max(1, Math.min(1500, untilMs - r.clock.now())));
  }
}

async function until(r, pred, max = 120000, step = 250) {
  const end = r.clock.now() + max;
  while (!pred() && r.clock.now() < end) await r.clock.advance(step);
  return pred();
}

async function playView(r, view, s, song, dt, stopAt = Infinity) {
  let last = r.clock.now();
  for (const n of song.notes) {
    const at = s.at + n.t;
    if (n.t > stopAt) break;
    if (view.judge && view.judge.mark[song.notes.indexOf(n)]) continue;
    if (at + dt > r.clock.now()) await r.clock.advance(at + dt - r.clock.now());
    view.press(n.l, at + dt);
    if (r.clock.now() - last >= 1000) {
      last = r.clock.now();
      view.frame();
    }
  }
}

function endOf(s) {
  return s.at + Math.ceil(lastNoteAt(songOfState(s)) * 1000) + 400;
}

function perfectRun(song) {
  const j = createJudge(song);
  const evs = [];
  for (const n of song.notes) {
    evs.push({ t: n.t + 5, l: n.l, up: false });
    if (n.e) evs.push({ t: n.e, l: n.l, up: true });
  }
  evs.sort((a, b) => a.t - b.t || a.up - b.up);
  for (const e of evs) {
    if (e.up) j.release(e.l, e.t);
    else j.press(e.l, e.t);
  }
  j.sweep(song.dur * 1000 + 5000);
  return j;
}

function fakeAudio(state = 'running') {
  const made = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(), Q: param() });
  const ctx = {
    state,
    currentTime: 5,
    sampleRate: 8000,
    destination: node(),
    createGain: () => node(),
    createBiquadFilter: () => ({ ...node(), type: 'lowpass' }),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {} }),
    createOscillator: () => {
      const o = { type: 'sine', frequency: { ...param(), setValueAtTime(v, t) { o.hz = v; o.at = t; } }, connect() {}, start() {}, stop() {} };
      made.push(o);
      return o;
    },
    resume() {
      ctx.state = 'running';
      return Promise.resolve();
    },
  };
  return { ctx, made };
}

function fakeSfx(ctx, on = true) {
  const subs = new Set();
  return {
    enabled: on,
    volume: 0.5,
    context: ctx,
    unlock() {
      return true;
    },
    on(type, fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    fire() {
      for (const fn of subs) fn({ enabled: this.enabled });
    },
  };
}

function fakeWin(perf = () => 1000, reduced = false) {
  const timers = [];
  return { timers, innerHeight: 700, devicePixelRatio: 2, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, performance: { now: perf }, matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }), addEventListener() {}, removeEventListener() {} };
}

function memStore(init = {}) {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function byKey(view, key) {
  return all(view.el).find((n) => n.dataset && n.dataset.key === key) || null;
}

function fakeSongAudio({ fail = false } = {}) {
  const fake = {
    fail,
    loads: [],
    plays: [],
    resyncs: [],
    stops: 0,
    entry: null,
    load(url, o) {
      fake.loads.push({ url, from: o.from, len: o.len });
      if (typeof o.onProgress === 'function') o.onProgress(0.5);
      if (fake.fail) return Promise.reject(new Error('nope'));
      fake.entry = { buf: {}, base: 0, url, from: o.from, len: o.len };
      return Promise.resolve(fake.entry);
    },
    ready(url, from, len) {
      return fake.entry && fake.entry.url === url && fake.entry.from === from && fake.entry.len === len ? fake.entry : null;
    },
    play(o) {
      fake.plays.push(o);
      return true;
    },
    resync(z) {
      fake.resyncs.push(z);
      return false;
    },
    stop() {
      fake.stops += 1;
    },
    destroy() {
      fake.gone = true;
    },
  };
  return fake;
}

function makeView(engine, win, opts = {}) {
  return createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win, storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }), songAudio: fakeSongAudio(), ...opts });
}

function spyGame(log) {
  const wrap = (api) => {
    let pending = null;
    return new Proxy(api, {
      get(t, k) {
        if (k === 'round') return (n, total) => {
          pending = { n, total };
          return t.round(n, total);
        };
        if (k === 'put') return (key, val) => {
          if (pending && key === KEY) {
            log.push({ ...pending, phase: val && val.phase });
            pending = null;
          }
          return t.put(key, val);
        };
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
  const out = { ...beatdrop };
  for (const k of ['start', 'intent', 'deadline', 'roster', 'join', 'resume', 'admin']) out[k] = (api, ...rest) => beatdrop[k](wrap(api), ...rest);
  return out;
}

test('the game is a quick rhythm game with a one-line pitch and clean text', () => {
  assert.equal(beatdrop.id, 'beatdrop');
  assert.equal(beatdrop.category, 'quick');
  assert.equal(beatdrop.emoji, '🥁');
  const def = (id) => beatdrop.settings.find((s) => s.id === id).default;
  assert.equal(def('difficulty'), 'normal');
  assert.equal(def('length'), 60);
  assert.equal(def('songs'), 2);
  assert.equal(def('song'), 'random');
  assert.deepEqual(beatdrop.settings.map((s) => s.id), ['difficulty', 'song', 'mature', 'length', 'songs'], 'no built-in beat or tempo settings');
  assert.equal(def('mature'), false, '18+ songs stay out of Random unless an admin host turns them on');
  assert.equal(beatdrop.settings.find((s) => s.id === 'song').type, 'song');
  assert.equal(beatdrop.blurb, BLURB);
  assert.equal(BLURB, 'Tap notes on the beat. Long streaks score big.');
  assert.ok(BLURB.length <= 60);
  assert.match(GOAL, /Tap each note as it lands on its ring/);
  assert.deepEqual(beatdrop.settings.find((s) => s.id === 'difficulty').options.map((o) => o.label), ['Chill', 'Normal', 'Hard', 'Expert']);
  assert.deepEqual(beatdrop.settings.find((s) => s.id === 'difficulty').options.map((o) => o.value), ['easy', 'normal', 'hard', 'expert']);
  assert.equal(/\d lanes/.test(JSON.stringify(beatdrop.settings.map((s) => s.options || []))), false, 'no lane counts in the settings');
  for (const re of BANNED) assert.doesNotMatch(`${beatdrop.name} ${beatdrop.blurb} ${GOAL} ${NEED_TEXT} ${SKIP_TEXT} ${LOAD_FAIL_TEXT}`, re);
  assert.equal(NEED_TEXT, 'Needs a song. Party staff can add one at yapos.dev/party/songs');
  assert.equal(LOAD_FAIL_TEXT, "That song wouldn't load for you, you'll join the next one");
});

test('the source files have no comments, inline styles, html injection, frame loops, recordings or built-in music', () => {
  for (const f of JS_FILES.concat(CSS_FILES)) {
    const src = read(f);
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, `${f} has a comment`);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText', 'style=', 'requestAnimationFrame', 'url(', '<audio', 'fetch(']) {
      if (bad === 'fetch(' && NET_FILES.includes(f)) continue;
      assert.equal(src.includes(bad), false, `${f}: ${bad}`);
    }
    assert.equal(/https?:\/\//.test(src), false, `${f} names another site`);
    assert.doesNotMatch(src, /\.(mp3|ogg|wav|m4a|flac)\b/i, `${f} loads a recording`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, `${f} sets a style directly`);
    for (const re of BANNED) assert.doesNotMatch(src, re, f);
    if (f !== 'js/views/beatdrop.js') assert.equal(/localStorage|setItem\(/.test(src), false, `${f} touches storage`);
    assert.doesNotMatch(src, /built-in/i, `${f} still mentions built-in music`);
    assert.doesNotMatch(src, /\b(STYLES|stepAt|buildSong|songFor|synthLineup|chordRoot|bpmFor|fellBack|FALLBACK_TEXT|HINT_TEXT|EMPTY_TEXT)\b|bd-hint/, `${f} still has built-in music`);
  }
  for (const f of CSS_FILES) {
    const css = read(f);
    assert.equal(/[^\x00-\x7f]/.test(css), false, `${f} is plain ASCII`);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/, `${f} turns transitions off for reduced motion`);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)) {
      for (const p of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity'].includes(p[1]), `${f} keyframes animate ${p[1]}`);
    }
  }
  assert.equal(/infinite/.test(read('css/beatdrop-play.css')), false);
  assert.equal(/infinite/.test(read('css/beatdrop-songs.css')), false);
  assert.ok(read('css/beatdrop.css').length <= 3000, `beatdrop.css is ${read('css/beatdrop.css').length} bytes`);
  assert.ok(read('css/beatdrop-play.css').length <= 11000);
  assert.ok(read('css/beatdrop-songs.css').length <= 2500);
  assert.ok(read('js/views/beatdrop.js').includes('/activity/css/beatdrop-play.css'));
  assert.ok(read('js/views/beatdrop.js').includes('/activity/css/beatdrop-songs.css'));
  assert.equal(PLAY_SHEET, '/activity/css/beatdrop-play.css');
  assert.equal(SONG_SHEET, '/activity/css/beatdrop-songs.css');
  assert.equal(read('index.html').includes('beatdrop-play.css'), false, 'the play sheet is not in the first load');
  assert.equal(read('index.html').includes('beatdrop-songs.css'), false, 'the songs sheet is not in the first load');
  assert.equal(/foldLane|LANE_SETS\[[23]\]|lanes === [23]|[23]: Object\.freeze/.test(JS_FILES.map(read).join('\n')), false, 'the old 2 and 3 lane code is gone');
  assert.equal(/'Space'/.test(read('js/views/beatdrop.js')) && /\['Space'/.test(read('js/views/beatdrop.js')), false);
  assert.match(read('js/views/beatdrop.js'), /sharedLoop\(\)/);
});

test('lineups only use uploaded songs: random never repeats, a picked song repeats and the picker has no built-in option', () => {
  const rnd = seeded(3);
  assert.deepEqual(lineup({ song: 'random' }, 2, rnd, []), [], 'no songs means no lineup');
  const cat = [{ id: SID, cv: 2, title: 'Night Test', artist: 'The Testers' }, { id: SID2, cv: 1, title: 'Second Test', artist: '' }, { id: SID3, cv: 4, title: 'Third', artist: 'X' }];
  for (let k = 0; k < 20; k += 1) {
    const picked = lineup({ song: 'random' }, 3, seeded(k + 1), cat);
    assert.equal(picked.length, 3);
    assert.ok(picked.every((x) => x.length === 2 && [SID, SID2, SID3].includes(x[0])));
    assert.equal(new Set(picked.map((x) => x[0])).size, 3, 'random songs never repeat in one game');
  }
  for (let k = 0; k < 20; k += 1) {
    const two = lineup({ song: 'random' }, 3, seeded(k + 1), cat.slice(0, 2));
    assert.equal(two.length, 3, 'too few songs still fill the game from the uploaded songs');
    for (let i = 1; i < two.length; i += 1) assert.notEqual(two[i][0], two[i - 1][0], 'never the same song twice in a row');
  }
  assert.deepEqual(lineup({ song: 'random' }, 2, rnd, cat.slice(0, 1)), [[SID, 2], [SID, 2]], 'one song plays every round');
  assert.deepEqual(lineup({ song: SID3 }, 3, rnd, cat), [[SID3, 4], [SID3, 4], [SID3, 4]], 'a picked song repeats');
  assert.ok(lineup({ song: 's-ffffffffffffffff' }, 2, rnd, cat).every((x) => [SID, SID2, SID3].includes(x[0])), 'a deleted song falls back to random');
  assert.ok(lineup({ song: 'beats' }, 2, rnd, cat).every((x) => [SID, SID2, SID3].includes(x[0])), 'an old built-in pick plays uploaded songs');
  assert.deepEqual(usableSongs([{ id: 'nope', cv: 1 }, { id: SID, cv: 'x' }, { id: SID2, cv: 3 }]).map((r) => r.id), [SID2]);
  const spec = beatdrop.settings.find((s) => s.id === 'song');
  assert.equal(cleanSetting(spec, SID), SID);
  assert.equal(cleanSetting(spec, 'random'), 'random');
  assert.equal(cleanSetting(spec, 'beats'), undefined, 'the built-in pick is gone');
  for (const bad of ['s-XYZ', 'https://x', 7, null, 's-0123456789abcdef0']) assert.equal(cleanSetting(spec, bad), undefined);
  assert.deepEqual(songChoices([]).map((o) => o.label), ['Random song']);
  assert.deepEqual(songChoices(cat).map((o) => o.label), ['Random song', 'Night Test - The Testers', 'Second Test', 'Third - X']);
  assert.equal(songChoices(cat).some((o) => /built-in|beats/i.test(`${o.value} ${o.label}`)), false, 'no built-in option');
  const bd = { ...settingsFor(beatdrop, { opts: { beatdrop: { song: 'beats', style: 'funk', difficulty: 'hard' } } }) };
  assert.deepEqual(bd, { difficulty: 'hard', song: 'random', mature: false, length: 60, songs: 2 }, 'old rooms with built-in settings load cleanly');
  const lenSpec = beatdrop.settings.find((s) => s.id === 'length');
  assert.deepEqual(lenSpec.options.map((o) => [o.value, o.label]), [[45, '45 s'], [60, '60 s'], [90, '90 s'], [120, '120 s'], [150, '150 s'], [0, 'Full song']]);
  assert.equal(lenSpec.default, 60);
  for (const v of [45, 60, 90, 120, 150, 0]) assert.equal(cleanSetting(lenSpec, v), v);
  for (const v of [30, 180, '60', null, undefined, 'full']) assert.equal(cleanSetting(lenSpec, v), undefined);
  for (const v of [45, 60, 90]) assert.equal(settingsFor(beatdrop, { opts: { beatdrop: { length: v } } }).length, v, `an old saved ${v} s still works`);
  assert.equal(settingsFor(beatdrop, { opts: { beatdrop: { length: 0 } } }).length, 0);
  assert.equal(settingsFor(beatdrop, { opts: { beatdrop: { length: 75 } } }).length, 60);
  assert.deepEqual([songLength(0), songLength(150), songLength(null), songLength(undefined), songLength('x'), songLength(30)], [0, 150, 60, 60, 60, 60]);
  assert.deepEqual(LENGTH_CHOICES.map(lengthLabel), ['45 s', '60 s', '90 s', '120 s', '150 s', 'Full song']);
  assert.equal(songsNote([], false), WAIT_TEXT);
  assert.equal(songsNote([], true), NEED_TEXT);
  assert.equal(songsNote(cat, true), '');
});

test('scoreOf is bounded, order-free and rewards accuracy and streaks', () => {
  for (const n of [1, 37, 118, 640]) {
    assert.equal(scoreOf(n, 0, 0, n, n), MAX_SCORE);
    assert.equal(scoreOf(0, 0, 0, 0, n), 0);
  }
  assert.equal(scoreOf(0, 0, 0, 0, 0), 0);
  const rnd = seeded(5);
  for (let i = 0; i < 400; i += 1) {
    const n = 20 + Math.floor(rnd() * 300);
    const p = Math.floor(rnd() * n);
    const g = Math.floor(rnd() * (n - p));
    const o = Math.floor(rnd() * (n - p - g));
    const b = Math.floor(rnd() * (p + g + o + 1));
    const s = scoreOf(p, g, o, b, n);
    assert.ok(s >= 0 && s <= MAX_SCORE);
    if (p + g + o < n) {
      assert.ok(scoreOf(p + 1, g, o, b, n) >= s);
      assert.ok(scoreOf(p, g + 1, o, b, n) >= s);
      assert.ok(scoreOf(p, g, o + 1, b, n) >= s);
    }
    if (g > 0) assert.ok(scoreOf(p + 1, g - 1, o, b, n) >= s, 'a Perfect beats a Great');
    if (b < p + g + o) assert.ok(scoreOf(p, g, o, b + 1, n) >= s);
  }
  assert.equal(scoreOf(5, 0, 0, 999, 10), scoreOf(5, 0, 0, 5, 10), 'the streak bonus can not exceed the hits');
  assert.deepEqual([0, 9, 10, 24, 25, 50, 99, 100, 400].map(tierOf), [0, 0, 1, 1, 2, 3, 3, 4, 4]);
  assert.deepEqual([1000, 950, 949, 850, 700, 500, 499, 0].map(gradeOf), ['S', 'S', 'A', 'A', 'B', 'C', 'D', 'D']);
  assert.equal(accOf(10, 0, 0, 10), 1);
  assert.ok(Math.abs(accOf(0, 10, 0, 10) - 0.7) < 1e-9);
  assert.ok(Math.abs(accOf(0, 0, 10, 10) - 0.4) < 1e-9);
});

test('judging windows per difficulty, early and late, auto misses and stray taps', () => {
  const [easy, normal, hard, expert] = DIFFS;
  assert.equal(easy.id, 'easy');
  assert.equal(easy.name, 'Chill');
  assert.equal(expert.id, 'expert');
  for (let i = 0; i < 3; i += 1) {
    assert.ok(expert.win[i] < hard.win[i] && hard.win[i] < normal.win[i] && normal.win[i] < easy.win[i], 'each level judges tighter');
  }
  assert.ok(expert.look < hard.look && hard.look < normal.look && normal.look < easy.look, 'each level scrolls faster');
  assert.equal(windowsFor('expert').p, 30);
  DIFFS.forEach((d, df) => {
    assert.equal(lanesFor(df), 4);
    assert.equal(d.lanes, LANES);
    const w = windowsFor(df);
    assert.deepEqual([w.p, w.g, w.o], d.win);
    const song = testSong(df);
    const n = song.notes[10];
    const state = { win: w, byLane: Array.from({ length: d.lanes }, () => []), mark: new Uint8Array(song.notes.length), ptr: new Array(d.lanes).fill(0) };
    song.notes.forEach((x, i) => state.byLane[x.l].push(i));
    const k = (dt) => judge(song.notes, n.l, n.t + dt, state);
    assert.equal(k(0).k, 'p');
    assert.equal(k(-w.p).k, 'p');
    assert.equal(k(w.p + 1).k, 'g');
    assert.equal(k(-(w.g + 1)).k, 'o');
    assert.equal(k(w.o + 1).idx === song.notes.indexOf(n), false);
    assert.equal(k(w.p + 1).dt, w.p + 1);
    assert.equal(k(-(w.g + 1)).dt, -(w.g + 1));
    assert.ok(lookFor(df, true) - lookFor(df) > 0.39);
  });
  const song = testSong(1);
  const fin = perfectRun(song);
  assert.equal(fin.stats.p, song.notes.length);
  assert.equal(fin.stats.b, song.notes.length);
  assert.equal(fin.score, MAX_SCORE);
  assert.deepEqual(fin.final(), [song.notes.length, 0, 0, 0, song.notes.length]);
  const run = createJudge(song);
  const [a, b] = song.notes;
  const ev = run.press(a.l, a.t + 70);
  assert.equal(ev[ev.length - 1].k, 'g');
  assert.equal(ev[ev.length - 1].dt, 70);
  assert.equal(run.stats.c, 1);
  const missed = run.sweep(b.t + 500);
  assert.ok(missed.some((x) => x.k === 'm'));
  assert.equal(run.stats.c, 0);
  const streaky = createJudge(song);
  for (const n of song.notes.slice(0, 12)) streaky.press(n.l, n.t);
  assert.equal(streaky.stats.c, 12);
  const gapAt = song.notes[11].t + 1;
  const strayLane = (song.notes[12].l + 1) % LANES;
  let out = [];
  for (let i = 0; i < STRAY_MAX; i += 1) out = out.concat(streaky.press(strayLane, gapAt + i * 10));
  assert.equal(out.some((x) => x.reset), false, `${STRAY_MAX} stray taps do not break the streak`);
  assert.equal(streaky.stats.c, 12);
  out = streaky.press(strayLane, gapAt + STRAY_MAX * 10);
  assert.ok(out.some((x) => x.k === 'x' && x.reset && x.lost === 12), 'one more inside the window resets it');
  assert.equal(streaky.stats.c, 0);
  const spread = createJudge(song);
  for (let i = 0; i < 6; i += 1) out = spread.press(0, -5000 + i * (STRAY_MS / 4 + 5));
  assert.equal(out.some((x) => x.reset), false, 'strays spread out over time are fine');
  const counted = createJudge(song);
  counted.press(a.l, a.t);
  counted.sweep(song.notes[5].t + 1000);
  const [j, p, g, o, m, c, best] = counted.prog();
  assert.equal(p + g + o + m, j);
  assert.ok(c <= best && best <= p + g + o);
});

test('the host only accepts progress that adds up, has arrived and never goes backwards', () => {
  const song = testSong(1, 60);
  const n = song.notes.length;
  const due = objectsBefore(song, 30);
  const good = [10, 8, 1, 0, 1, 2, 9];
  assert.ok(checkProgress(song, 30, good));
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 0, 2, 9]), null, 'counts must add up');
  assert.equal(checkProgress(song, 0, [due, due, 0, 0, 0, due, due]), null, 'cannot judge notes that have not arrived');
  assert.ok(checkProgress(song, 30, [due, due, 0, 0, 0, due, due]));
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 9, 2]), null, 'streak above best');
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 2, 10]), null, 'best above hits');
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 2, 9], { j: 11, p: 0, g: 0, o: 0, m: 0, b: 0 }), null, 'judged went down');
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 2, 9], { j: 0, p: 9, g: 0, o: 0, m: 0, b: 0 }), null, 'perfects went down');
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 2, 9], { j: 0, p: 0, g: 0, o: 0, m: 0, b: 10 }), null, 'best went down');
  assert.equal(checkProgress(song, 30, 'lots'), null);
  assert.equal(checkProgress(song, 30, [10, 8, 1, 0, 1, 2, 9.5]), null);
  assert.equal(checkProgress(song, 30, good).score, scoreOf(8, 1, 0, 9, n));
  const fin = checkFinal(song, 70, [n, 0, 0, 0, n, 999999]);
  assert.equal(fin.score, MAX_SCORE);
  const short = checkFinal(song, 70, [10, 5, 0, 0, 7]);
  assert.equal(short.m, n - 15, 'a short final is filled up with misses');
  assert.equal(short.score, scoreOf(10, 5, 0, 7, n));
  assert.equal(checkFinal(song, 70, [n, 1, 0, 0, n]), null);
  assert.equal(checkFinal(song, 70, [5, 0, 0, 0, 6]), null);
  assert.equal(checkFinal(song, 5, [n, 0, 0, 0, n]), null, 'cannot finish notes that have not arrived');
  assert.equal(checkFinal(song, 70, [5, 0, 0, 0, 5], { p: 6, g: 0, o: 0, m: 0, b: 0 }), null, 'final below the last progress');
});

test('a forged progress or final is ignored and the last good row stays', async () => {
  const r = await startGame(2, { length: 45, songs: 1 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  const [a, b] = slots(r);
  await playAlong(r, s, s.at + 20000, { [a]: 'all', [b]: 'some' });
  const due = objectsBefore(song, 19.5);
  bySlot(r, a).act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
  await r.clock.advance(1000);
  const row = st(r).sc[a];
  assert.equal(row[0], scoreOf(due, 0, 0, due, song.notes.length));
  bySlot(r, a).act({ type: 'prog', n: s.n, v: [due + 400, due + 400, 0, 0, 0, due, due + 400] });
  await r.clock.advance(1000);
  bySlot(r, a).act({ type: 'prog', n: s.n, v: [due, due - 2, 0, 0, 2, 0, due - 2] });
  await r.clock.advance(1000);
  bySlot(r, a).act({ type: 'prog', n: s.n, s: 999999, c: 50, j: 3 });
  await r.clock.advance(1000);
  assert.deepEqual(st(r).sc[a], row, 'bad packets keep the last good row');
  await playAlong(r, s, endOf(s), { [a]: 'all', [b]: 'some' });
  const n = song.notes.length;
  bySlot(r, a).act({ type: 'done', n: s.n, v: [n, 0, 0, 0, n], s: 1 });
  const third = Math.floor(n / 3);
  bySlot(r, b).act({ type: 'done', n: s.n, v: [third, 0, 0, 0, 1], s: 999999 });
  await r.clock.advance(400);
  const res = st(r).res;
  assert.equal(st(r).phase, 'show');
  assert.equal(res[a][1], MAX_SCORE, 'the score is recomputed, never read');
  assert.equal(res[b][1], scoreOf(third, 0, 0, 1, n));
  assert.equal(res[b][8], n - third, 'a short final is filled up with misses');
  noSongs();
});

test('points: placement plus accuracy plus a full streak bonus, with fair ties, sit-outs and leavers', () => {
  assert.equal(pointsFor(1, 1, true), 500);
  assert.equal(pointsFor(1, 0, false), 300);
  assert.equal(pointsFor(9, 0, false), 90);
  assert.equal(pointsFor(20, 0.5, false), 90 + Math.round(150 * 0.25));
  assert.ok(pointsFor(1, 1, true) * 3 < 2000);
  assert.deepEqual(DIFF_PAY, [0.9, 1, 1.1, 1.2]);
  assert.equal(pointsFor(1, 1, true, 'expert'), 530, 'the best Expert run is the top pay');
  assert.equal(pointsFor(1, 1, true, 0), 300 + 135 + 50);
  assert.equal(pointsFor(1, 0, false, 3), 300, 'only the accuracy part scales');
  for (let df = 0; df < 4; df += 1) for (const a of [0, 0.3, 0.8, 1]) assert.ok(pointsFor(1, a, true, df) <= 530 && pointsFor(9, a, false, df) >= 90);
  assert.ok(pointsFor(1, 1, true, 3) * 3 < 2000);
  const song = testSong(1, 45);
  const n = song.notes.length;
  const st0 = { n: 1, in: [0, 1, 2, 3, 4], sc: {}, f: { 0: [n, 0, 0, 0, n], 1: [n - 4, 0, 0, 4, 30], 2: [n - 4, 0, 0, 4, 30], 3: [0, 0, 0, n, 0], 4: [40, 0, 0, n - 40, 40] } };
  const rows = standings(st0, song, null, [0, 1, 2, 3]);
  const by = Object.fromEntries(rows.map((r) => [r.s, r]));
  assert.equal(by[0].place, 1);
  assert.equal(by[0].fc, true);
  assert.equal(by[1].place, 2);
  assert.equal(by[2].place, 2, 'ties share a place');
  assert.equal(by[3].flag, FLAG_SAT);
  assert.equal(by[3].place, 0);
  assert.equal(by[4].flag, FLAG_LEFT);
  assert.equal(by[4].place, 0);
  assert.equal(rows[rows.length - 1].s, 3, 'sat-out rows go last');
});

test('a full song: ready, play, results, then Party points from the placement', async () => {
  const r = await startGame(3, { length: 45, songs: 1 });
  assert.equal(st(r).phase, 'ready');
  assert.equal(st(r).v, 4);
  assert.ok([SID, SID2].includes(st(r).sid), 'an uploaded song is picked');
  assert.equal(st(r).src, undefined);
  assert.equal(st(r).sty, undefined);
  assert.ok(st(r).ends - r.engines[0].now() <= READY_MS);
  assert.equal(beatdrop.model(r.engines[1].snapshot()).playing, true);
  await allReady(r);
  const s = st(r);
  assert.equal(s.phase, 'play');
  assert.ok(Math.abs(s.at - r.engines[0].now() - LEAD_MS) < 400);
  const song = songOfState(s);
  const n = song.notes.length;
  const [a, b, c] = slots(r);
  await playAlong(r, s, endOf(s), { [a]: 'all', [b]: 'half', [c]: 'some' });
  const half = Math.floor(n / 2);
  const third = Math.floor(n / 3);
  assert.equal(st(r).phase, 'play');
  bySlot(r, a).act({ type: 'done', n: s.n, v: perfectRun(song).final() });
  bySlot(r, b).act({ type: 'done', n: s.n, v: [half, 0, 0, n - half, 2] });
  bySlot(r, b).act({ type: 'done', n: s.n, v: [n, 0, 0, 0, n] });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'play');
  bySlot(r, c).act({ type: 'done', n: s.n, v: [third, 0, 0, n - third, 1] });
  await r.clock.advance(300);
  const after = st(r);
  assert.equal(after.phase, 'show');
  const res = after.res;
  assert.equal(res[a][0], 1);
  assert.equal(res[a][1], MAX_SCORE);
  assert.equal(res[a][2], 'S');
  assert.equal(res[a][9], 500);
  assert.equal(res[b][0], 2);
  assert.equal(res[b][1], scoreOf(half, 0, 0, 2, n), 'the second report was ignored');
  assert.equal(res[c][0], 3);
  assert.equal(res[c][9], 200 + Math.round(150 * accOf(third, 0, 0, n) ** 2));
  assert.ok(r.hub.state.scores.g[a] >= 500);
  const m = beatdrop.model(bySlot(r, a).snapshot());
  assert.equal(m.mine.place, 1);
  assert.equal(m.mine.fc, true);
  assert.ok(m.mine.badges.includes('Full streak'));
  assert.equal(m.results[0].isMe, true);
  assert.equal(m.skipped, '');
  assert.deepEqual(beatdrop.results({ get: () => after }).extra.fullCombo, [a]);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state[ROOM].phase, 'results');
  noSongs();
});

test('every song gets a ready step, the final round splash fires on it, and ready ends early', async () => {
  const log = [];
  const game = spyGame(log);
  const r = await startGame(2, { songs: 2, length: 45 }, [game]);
  assert.deepEqual(log.map((x) => [x.n, x.phase]), [[1, 'ready']]);
  assert.equal(st(r).lineup.length, 2);
  await allReady(r);
  const s = st(r);
  assert.equal(s.phase, 'play');
  const both = Object.fromEntries(slots(r).map((x) => [x, 'all']));
  await playAlong(r, s, s.ends + 300, both);
  assert.equal(st(r).phase, 'show');
  assert.equal(log.length, 1, 'nothing fires during play');
  await r.clock.advance(SHOW_MS + 300);
  await settle(r);
  const two = st(r);
  assert.equal(two.phase, 'ready', 'song 2 has its own ready step');
  assert.equal(two.i, 1);
  assert.ok([SID, SID2].includes(two.sid));
  assert.notEqual(two.sid, s.sid, 'the second song is a different upload');
  assert.ok(two.ends - r.engines[0].now() <= READY_NEXT_MS);
  assert.deepEqual(log.map((x) => [x.n, x.phase]), [[1, 'ready'], [2, 'ready']]);
  assert.equal(r.hub.state[FUN].f, 1, 'the final round is flagged before song 2 plays');
  await allReady(r);
  assert.equal(st(r).phase, 'play', 'everyone ready skips the wait');
  await until(r, () => st(r).phase === 'show');
  assert.equal(log.length, 2);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state[ROOM].phase, 'results');
  noSongs();
});

test('opening the tutorial buys a little more ready time, once per player, up to a cap', async () => {
  const r = await startGame(2, { songs: 1, length: 45 });
  await loadAll(r);
  const s = st(r);
  await r.clock.advance(15000);
  r.engines[1].act({ type: 'learn', n: s.n });
  await r.clock.advance(300);
  const ends = st(r).ends;
  assert.ok(ends - r.engines[0].now() > 20000, 'time to finish the tutorial');
  assert.ok(ends <= s.starts + READY_MAX_MS);
  r.engines[1].act({ type: 'learn', n: s.n });
  await r.clock.advance(300);
  assert.equal(st(r).ends, ends, 'only once per player');
  await r.clock.advance(ends - r.engines[0].now() + 300);
  assert.equal(st(r).phase, 'play');
  noSongs();
});

test('nobody pressing ready still starts the song after the timer', async () => {
  const r = await startGame(2, { songs: 1, length: 45 });
  await loadAll(r);
  await r.clock.advance(READY_MS + 300);
  assert.equal(st(r).phase, 'play');
  noSongs();
});

test('people who join mid-song watch, then play from the next ready', async () => {
  const r = await startGame(2, { length: 45, songs: 2 });
  await allReady(r);
  const s = st(r);
  const both = Object.fromEntries(slots(r).map((x) => [x, 'all']));
  await playAlong(r, s, s.at + 8000, both);
  const e = r.add(3);
  await r.clock.advance(800);
  const slot = e.snapshot().meSlot;
  assert.ok(st(r).w.includes(slot));
  assert.equal(st(r).in.includes(slot), false);
  const m = beatdrop.model(e.snapshot());
  assert.equal(m.waiting, true);
  assert.equal(m.watching, true);
  assert.equal(m.noLoad, false, 'a late joiner is not told the song failed');
  e.act({ type: 'prog', n: s.n, v: [0, 0, 0, 0, 0, 0, 0] });
  await r.clock.advance(1000);
  assert.equal(st(r).sc[slot], undefined, 'watchers cannot score');
  await playAlong(r, s, s.ends + 300, both);
  assert.equal(st(r).phase, 'show');
  assert.equal(st(r).res[slot], undefined);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(st(r).phase, 'ready');
  assert.ok(st(r).in.includes(slot), 'they play the next song');
  assert.deepEqual(st(r).w, []);
  noSongs();
});

test('idle players are flagged, never paid, and do not hold up the song', async () => {
  const r = await startGame(2, { length: 60, songs: 3 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  assert.ok(await until(r, () => st(r).phase !== 'play'));
  const after = st(r);
  assert.equal(after.phase, 'show', 'only idle players left after 60% ends the song early');
  assert.ok(after.starts >= s.at + song.dur * 1000 * 0.6 - 10);
  assert.ok(after.starts < s.ends - END_GRACE_MS - 10000);
  for (const slot of slots(r)) {
    assert.equal(after.res[slot][10], FLAG_SAT);
    assert.equal(after.res[slot][9], 0);
  }
  assert.equal(beatdrop.model(r.engines[0].snapshot()).satOut.length, 2);
  assert.ok(await until(r, () => st(r).phase === 'ready'));
  await loadAll(r);
  const s2 = st(r);
  r.engines[0].act({ type: 'ready', n: s2.n });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'ready', 'after one sat-out song everyone is still waited for');
  assert.ok(await until(r, () => st(r).phase === 'play'));
  assert.ok(await until(r, () => st(r).phase === 'ready' && st(r).i === 2));
  await loadAll(r);
  const s3 = st(r);
  r.engines[0].act({ type: 'ready', n: s3.n });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'play', 'two sat-out songs in a row means nobody waits for them');
  noSongs();
});

test('one player done and the rest idle ends the song right away', async () => {
  const r = await startGame(3, { length: 45, songs: 1 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  const [a, b, c] = slots(r);
  const n = song.notes.length;
  for (let t = 2000; t < lastNoteAt(song) * 1000; t += 1500) {
    await r.clock.advance(s.at + t - r.engines[0].now());
    const due = objectsBefore(song, t / 1000 - 0.2);
    bySlot(r, a).act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
    if (t < 12000) {
      const dueB = objectsBefore(song, t / 1000 - 0.2);
      bySlot(r, b).act({ type: 'prog', n: s.n, v: [dueB, 0, 0, 0, dueB, 0, 0] });
    }
    if (st(r).phase !== 'play') break;
  }
  assert.equal(st(r).phase, 'play');
  await r.clock.advance(Math.max(1, endOf(s) - r.engines[0].now()));
  bySlot(r, a).act({ type: 'done', n: s.n, v: [n, 0, 0, 0, n] });
  await r.clock.advance(300);
  const after = st(r);
  assert.equal(after.phase, 'show');
  assert.ok(after.starts < s.ends - END_GRACE_MS, 'it did not wait for the clock');
  assert.equal(after.res[a][10], FLAG_PLAYED);
  assert.equal(after.res[b][10], FLAG_SAT);
  assert.equal(after.res[c][10], FLAG_SAT);
  noSongs();
});

test('the host leaving mid-song keeps the song, its clock and the live rows', async () => {
  const r = await startGame(3, { length: 45 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  const [, b, c] = slots(r);
  await playAlong(r, s, s.at + 6000, { [b]: 'all', [c]: 'all' });
  const due = objectsBefore(song, 5.5);
  bySlot(r, b).act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
  await r.clock.advance(1200);
  const row = st(r).sc[b];
  assert.ok(row);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'play');
  assert.equal(after.n, s.n);
  assert.equal(after.at, s.at);
  assert.equal(after.ends, s.ends);
  assert.equal(after.sid, s.sid);
  assert.deepEqual(after.sc[b], row);
  bySlot(r, b).act({ type: 'prog', n: s.n, v: [due - 1, due - 1, 0, 0, 0, 0, due - 1] });
  await r.clock.advance(1200);
  assert.deepEqual(st(r).sc[b], row, 'the new host seeds its baselines from the room');
  await playAlong(r, after, after.ends + 500, { [b]: 'all', [c]: 'all' });
  assert.equal(st(r).phase, 'show');
  assert.equal(st(r).res[b][10], FLAG_PLAYED);
  noSongs();
});

test('shared state stays tiny with 12 players and never carries the chart', async () => {
  const big = { v: 4, n: 9, phase: 'show', i: 2, total: 3, lineup: [[SID, 9999], [SID2, 9999], [SID3, 9999]], sid: SID3, cv: 9999, df: 3, len: 90, sk: 1, on: 1600, du: 91500, tt: ['x'.repeat(60), 'y'.repeat(60)], at: 1700000123456, starts: 1700000123456, ends: 1700000133456, in: [], w: [12, 13], rd: [], lr: [], ld: [], lf: [], lw: 1, nl: [], idle: [], so: {}, sc: {}, f: {}, ev: [], evn: 999, res: {} };
  for (let s = 0; s < 12; s += 1) {
    big.in.push(s);
    big.rd.push(s);
    big.lr.push(s);
    big.ld.push(s);
    big.nl.push(s);
    big.idle.push(s);
    big.so[s] = 1;
    const most = CHART_CAPS.expert;
    big.sc[s] = [1000, most, most, 1, most, 100, most, 0, 0];
    big.f[s] = [most, 0, 0, 0, most];
    big.res[s] = [12, 1000, 'S', 100, most, most, most, most, most, 530, 2];
  }
  big.ev = [[11, 't', 100, 996], [11, 'l', 1000, 997], [10, 'f', 1000, 998], [9, 'l', 1000, 999]];
  assert.ok(jsonBytes(big) <= 4096, `${jsonBytes(big)} bytes`);
  const r = await startGame(8, { length: 90, difficulty: 'expert' });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  await playAlong(r, s, endOf(s), Object.fromEntries(slots(r).map((x) => [x, 'all'])));
  assert.ok(jsonBytes(st(r)) <= 3500);
  for (const e of r.engines) e.act({ type: 'done', n: s.n, v: perfectRun(song).final() });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'show');
  assert.ok(jsonBytes(st(r)) <= 3500);
  assert.equal(JSON.stringify(r.hub.state).includes('"notes"'), false);
  const f = await startGame(4, { length: 0, difficulty: 'expert' }, [beatdrop], { len: 300000 });
  await allReady(f);
  const fs = st(f);
  assert.equal(fs.len, 0);
  const whole = songOfState(fs);
  assert.equal(whole.full, true);
  assert.equal(whole.cut, 300000, 'Full song plays the whole saved part');
  await playAlong(f, fs, endOf(fs), Object.fromEntries(slots(f).map((x) => [x, 'all'])));
  assert.ok(jsonBytes(st(f)) <= 3500);
  for (const e of f.engines) e.act({ type: 'done', n: fs.n, v: perfectRun(whole).final() });
  await f.clock.advance(400);
  assert.equal(st(f).phase, 'show');
  assert.ok(jsonBytes(st(f)) <= 3500);
  const res = Object.values(st(f).res);
  assert.ok(res.length === 4 && res.every((x) => x[1] === 1000 && x[10] === FLAG_PLAYED), 'perfect full song runs are accepted with full marks');
  noSongs();
});

test('progress from 12 players is written at most once every 900 ms', async () => {
  const r = await startGame(12, { length: 45, songs: 1 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  const hostId = r.engines[0].snapshot().me;
  await r.clock.advance(s.at - r.engines[0].now() + 1000);
  const from = r.clock.now();
  const counts = r.engines.map(() => 0);
  for (let t = 0; t < 15000; t += 125) {
    r.engines.forEach((e, i) => {
      if ((t + i * 125) % 1500 !== 0) return;
      const sec = (r.clock.now() - s.at) / 1000;
      const due = Math.max(counts[i], objectsBefore(song, sec - 0.2));
      counts[i] = due;
      e.act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
    });
    await r.clock.advance(125);
  }
  const writes = r.hub.ops.filter((o) => o.id === hostId && o.what === `set:${KEY}` && o.at >= from).map((o) => o.at);
  assert.ok(writes.length >= 8, `${writes.length} writes`);
  for (let i = 1; i < writes.length; i += 1) assert.ok(writes[i] - writes[i - 1] >= PROG_GAP_MS, `writes ${writes[i] - writes[i - 1]} ms apart`);
  assert.deepEqual(r.hub.violations, []);
  assert.equal(Object.keys(st(r).sc).length, 12);
  noSongs();
});

test('the song clock: drawing and judging share one game time and the offset moves both', () => {
  let p = 1000;
  let host = 50000;
  const clock = createSongClock({ perf: () => p, hostNow: () => host });
  clock.reset(53000);
  assert.equal(clock.anchor, 4000);
  p += 3000;
  host += 3000;
  assert.equal(clock.songT(), 0);
  assert.equal(clock.gameT(), clock.judgeT(p));
  clock.offset = 40;
  assert.ok(Math.abs(clock.gameT() - -0.04) < 1e-9);
  assert.ok(Math.abs(clock.judgeT(p) - clock.gameT()) < 1e-9, 'a note that looks on the ring is judged on the ring');
  assert.ok(Math.abs(clock.judgeT(p + 100) - 0.06) < 1e-9);
  clock.offset = 999;
  assert.equal(clock.offset, TIMING_MAX);
  clock.offset = 0;
  const skew = host - p;
  const tickAt = (ms, lag = 0, hold = false) => {
    p += ms;
    host = p + skew - lag;
    return clock.step({ hold });
  };
  for (let i = 0; i < 6; i += 1) tickAt(120, i % 2 ? 60 : -60);
  assert.equal(clock.frozen, true);
  const settled = clock.anchor;
  assert.equal(settled, 4000);
  assert.equal(tickAt(2100, 60), 'ok', 'jitter under 80 ms is ignored');
  assert.equal(tickAt(2100, -400), 'ok', 'one late room update does not move the notes');
  assert.equal(clock.anchor, settled);
  assert.equal(tickAt(2100, 150), 'ok', 'a drift has to last before it counts');
  assert.equal(tickAt(2100, 150, true), 'slew', 'a lasting drift is slewed');
  assert.equal(clock.anchor, settled, 'no slewing right before a drop');
  tickAt(16);
  assert.ok(Math.abs(clock.anchor - settled) <= 1 + 1e-9, 'drift is slewed at most 1 ms a frame');
  tickAt(2100, 150);
  const before = clock.anchor;
  assert.notEqual(tickAt(2100, 700), 'jump', 'one far-off sample is not enough to jump');
  assert.equal(tickAt(2100, 700), 'jump');
  assert.ok(Math.abs(clock.anchor - before) > 250, 'a lasting big gap re-anchors at once');
  clock.reanchor();
  assert.equal(tickAt(2100, 700), 'ok', 'after a re-anchor the old samples are forgotten');
  const { ctx: c2 } = fakeAudio();
  let p2 = 0;
  const kinds = [];
  const bc = createSongClock({ perf: () => p2, hostNow: () => p2 + 1000, audio: () => c2, onShift: (z, kind) => kinds.push(kind) });
  bc.reset(6000);
  for (let i = 0; i < 6; i += 1) {
    p2 += 150;
    bc.step();
  }
  assert.equal(bc.frozen, true);
  c2.currentTime = 20;
  assert.ok(Math.abs(bc.mapAudio() - 24.1) < 1e-9);
  c2.state = 'suspended';
  p2 += 3000;
  assert.ok(Math.abs(bc.songT() - (p2 - 5000) / 1000) < 1e-9, 'a paused audio clock falls back to the steady clock');
  c2.state = 'running';
  assert.equal(bc.step(), 'audio', 'the audio clock is re-mapped when it comes back');
  assert.ok(Math.abs(bc.songT() - (p2 - 5000) / 1000) < 1e-9, 'notes do not jump back after the audio was paused');
  assert.equal(kinds[kinds.length - 1], 'jump', 'the song re-syncs to the song time');
  c2.currentTime += 0.5;
  p2 += 500;
  assert.equal(bc.step(), 'ok', 'a healthy audio clock is left alone');
  const { ctx } = fakeAudio();
  let shifted = null;
  const ac = createSongClock({ perf: () => p, hostNow: () => host, audio: () => ctx, outLat: () => 0.02, onShift: (z) => (shifted = z) });
  ac.reset(host + 2000);
  ctx.currentTime = 10;
  const zero = ac.mapAudio();
  assert.ok(Math.abs(zero - 12) < 1e-9);
  ctx.currentTime = 13;
  assert.ok(Math.abs(ac.songT() - 0.98) < 1e-9, 'with audio the song follows the audio clock minus output latency');
  ac.reanchor();
  assert.ok(shifted !== null);
});

test('prefs, keys, layout and the little helpers', () => {
  const store = memStore();
  const p = readPrefs(store);
  assert.deepEqual([p.tapOffset, p.seen, p.slow, p.calm, p.music], [0, false, null, false, true]);
  assert.equal('taps' in p, false, 'there is no tap sound switch any more');
  p.tapOffset = 5000;
  p.seen = true;
  p.best[`${SID}.2`] = 812;
  assert.equal(writePrefs(store, p), true);
  const back = readPrefs(store);
  assert.equal(back.tapOffset, TIMING_MAX);
  assert.equal(back.seen, true);
  assert.equal(back.best[`${SID}.2`], 812);
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: '35' })).tapOffset, 35, 'the old number-only value carries over');
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: '{bad' })).tapOffset, 0);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readPrefs(broken).tapOffset, 0);
  assert.equal(writePrefs(broken, p), false);
  assert.equal(readPrefs(null).music, true);
  assert.deepEqual(keyLabels(), ['D', 'F', 'J', 'K']);
  assert.deepEqual(keyLabels(2), ['D', 'F', 'J', 'K'], 'old lane counts still give 4 keys');
  assert.equal(laneOfKey({ code: 'KeyD' }), 0);
  assert.equal(laneOfKey({ code: 'KeyF' }), 1);
  assert.equal(laneOfKey({ code: 'ArrowRight' }), 3);
  assert.equal(laneOfKey({ code: 'Space' }), -1);
  assert.equal(laneOfKey({ code: 'ArrowUp' }), 2);
  assert.equal(laneOfKey({ key: 'k' }), 3);
  assert.equal(laneOfKey({ code: 'KeyX' }), -1);
  assert.deepEqual(Object.keys(LANE_KEYS), ['4']);
  for (const [lanes, keys] of Object.entries(LANE_KEYS)) assert.equal(keys.length, Number(lanes));
  assert.equal(widthFor(), 560);
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: JSON.stringify({ best: { [`${SID}.3`]: 900, 'pop.3': 800, '../x.1': 5 } }) })).best[`${SID}.3`], 900, 'song bests are kept');
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: JSON.stringify({ best: { '../x.1': 5 } }) })).best['../x.1'], undefined);
  assert.equal(heightFor(700, 0), 700 - 44 - 28 - 52 - 12 - 8);
  assert.equal(heightFor(700, 0, true, false), 700 - 44 - 12 - 8, 'keyboard players get the pad row as extra highway');
  assert.equal(heightFor(400, 0), 320);
  assert.equal(eventTime(990, 1000), 990, 'real event times are used');
  assert.equal(eventTime(90000, 1000), 1000, 'an event time from another clock falls back to now');
  assert.equal(eventTime(-5, 1000), 1000);
  assert.equal(eventTime(undefined, 1000), 1000);
  assert.equal(heightFor(2000, 0), 760);
  assert.equal(heightFor(800, 0, true), 800 - 44 - 52 - 12 - 8);
  const rows = [{ slot: 1, name: 'Juno', score: 655 }, { slot: 2, isMe: true, name: 'Me', score: 0 }, { slot: 3, name: 'Kim', score: 300 }, { slot: 4, name: 'Lee', score: 100 }, { slot: 5, name: 'Max', score: 50 }, { slot: 6, name: 'Ola', score: 20 }];
  assert.equal(rivalLine(rows, 2, 612).text, "You're 2nd of 6 - 43 behind Juno");
  assert.equal(rivalLine(rows, 2, 700).text, "You're 1st of 6 - 45 ahead of Juno");
  assert.match(rivalLine([], 2, 10).text, /Solo run/);
  assert.deepEqual(tendencyOf(Array(25).fill(40)), { label: 'Mostly late', ms: 40, fix: 40, n: 25 });
  assert.equal(tendencyOf(Array(25).fill(-30)).label, 'Mostly early');
  assert.equal(tendencyOf(Array(10).fill(40)).fix, 0, 'too few hits to suggest a fix');
  assert.equal(tendencyOf(Array(30).fill(5)).label, 'On time');
  assert.equal(timingFrom([30, 32, 28, 31, 29, 30]).ms, 30);
  assert.equal(timingFrom([30, 30, 30, 30, 30]).ok, false, 'needs 6 taps');
  assert.equal(timingFrom([0, 100, -100, 150, -150, 50, -50]).ok, false, 'uneven taps are not trusted');
  assert.equal(timingFrom([300, 300, 300, 300, 300, 300]).ok, false, 'taps outside 200 ms do not count');
  assert.equal(clampOffset(-500), -TIMING_MAX);
  assert.equal(noteY(1000, 1, 1.7, 500), 500);
  assert.ok(noteY(2000, 1, 1.7, 500) < 500);
  assert.equal(gemSize(20), 36);
  assert.equal(gemSize(400), 60);
  assert.ok(judgeY(500, 500 * HIT_Y) > 500 * HIT_Y, 'judgements sit below the ring');
  assert.deepEqual(laneStyle(2), [0, 1, 2, 3]);
  assert.deepEqual(laneStyle(), [0, 1, 2, 3]);
  const notes = tutorialNotes();
  assert.equal(notes.length, 8);
  assert.equal(new Set(notes.map((n) => n.l)).size, 4, 'the tutorial uses all 4 lanes');
  assert.equal(songLine({ title: 'Night Test', artist: 'The Testers' }), 'Night Test - The Testers');
  assert.equal(songLine({ title: 'Solo', artist: '' }), 'Solo');
  assert.equal(songLine(null), '');
  assert.equal(loadText('fail'), `${LOAD_FAIL_TEXT}.`);
});

test('the sound player makes no tap, miss or streak sounds and only keeps the music bus and a tutorial click', () => {
  const { ctx, made } = fakeAudio();
  const s = fakeSfx(ctx);
  const win = fakeWin();
  const p = createBeatPlayer({ sfx: s, win });
  for (const k of ['start', 'seek', 'stop', 'setZero', 'playing', 'hit', 'miss', 'stray', 'tierUp', 'swell']) assert.equal(k in p, false, `no ${k}`);
  assert.equal(p.status(), 'ok');
  assert.equal(p.ensure(), 'ok');
  assert.equal(made.length, 0, 'nothing plays on its own');
  assert.equal(win.timers.length, 0, 'no music loop is scheduled');
  assert.ok(p.bus(), 'the uploaded song has a bus to play through');
  assert.equal(p.duck(), true);
  assert.equal(made.length, 0, 'ducking the music makes no sound of its own');
  assert.equal(p.click(0.1, true), true);
  assert.equal(made.length, 1, 'the tutorial metronome is a single click');
  p.setMix({ music: false, taps: true });
  assert.deepEqual(p.mix, { music: false });
  p.mute(true);
  p.mute(false);
  s.enabled = false;
  s.fire();
  assert.equal(p.status(), 'off');
  assert.equal(p.bus(), null);
  assert.equal(p.click(0, false), false);
  assert.match(soundNote('off'), /Turn sound on/);
  assert.equal(soundNote('blocked'), null, 'no misleading tap anywhere note');
  const none = createBeatPlayer({ sfx: { enabled: true, volume: 0.5, context: null, unlock() {} }, win: {} });
  assert.equal(none.status(), 'none');
  assert.equal(none.outLat(), 0);
  p.destroy();
  s.enabled = true;
  assert.equal(p.status(), 'none', 'a destroyed player makes no more sound');
  assert.equal(ctx.closed, undefined, 'the shared sound context is left open');
  const cut = [];
  let closed = 0;
  class OwnCtx {
    constructor() {
      Object.assign(this, fakeAudio().ctx);
      const mk = this.createGain;
      this.createGain = () => {
        const n = mk();
        n.disconnect = () => cut.push(n);
        return n;
      };
    }
    close() {
      closed += 1;
      return Promise.resolve();
    }
  }
  const own = createBeatPlayer({ sfx: { enabled: true, volume: 0.5, context: null, unlock() {} }, win: { AudioContext: OwnCtx, setTimeout: () => 0, clearTimeout() {} } });
  assert.equal(own.ensure(), 'ok');
  own.destroy();
  assert.ok(cut.length >= 2, 'the gain nodes are disconnected');
  assert.equal(closed, 1, 'a context the player made itself is closed');
  assert.equal(own.bus(), null);
});

test('the view lets go of everything when the game ends', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1 });
  const engine = r.engines[0];
  const win = fakeWin(() => r.clock.now());
  const live = new Map();
  win.addEventListener = (type, fn) => live.set(type, fn);
  win.removeEventListener = (type, fn) => {
    if (live.get(type) === fn) live.delete(type);
  };
  let observed = 0;
  win.ResizeObserver = class {
    constructor(fn) {
      this.fn = fn;
    }
    observe() {
      observed += 1;
    }
    disconnect() {
      observed -= 1;
    }
  };
  const media = [];
  win.matchMedia = (q) => {
    media.push(q);
    return { matches: false };
  };
  const fake = fakeSongAudio();
  const view = makeView(engine, win, { songAudio: fake });
  await allReady(r);
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'play');
  assert.equal(observed, 1);
  assert.ok(live.has('resize') && live.has('blur'));
  const asked = media.length;
  for (let i = 0; i < 30; i += 1) {
    await r.clock.advance(16);
    view.frame();
  }
  assert.ok(media.length - asked <= 4, `media queries are cached, not asked every frame (${media.length - asked})`);
  view.press(0);
  assert.ok(view.local.pressAt[0] > 0);
  view.local.down[1] = true;
  live.get('blur')();
  assert.deepEqual(view.local.down, [false, false, false, false], 'leaving the window lets go of held lanes');
  view.destroy();
  assert.equal(observed, 0, 'the resize watcher is stopped');
  assert.equal(live.size, 0, 'window listeners are removed');
  assert.equal(fake.gone, true, 'the song player is closed');
  assert.equal(view.frame(), false);
  noSongs();
});

test('mashing keys until the streak resets makes no sound', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1 });
  const engine = r.engines[0];
  const played = [];
  const view = makeView(engine, fakeWin(() => r.clock.now()), { cues: { play: (name) => played.push(name), burst() {}, float() {} } });
  await allReady(r);
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'play');
  await r.clock.advance(Math.max(0, st(r).at + 300 - r.clock.now()));
  view.frame();
  const before = played.length;
  for (let i = 0; i < STRAY_MAX * 3; i += 1) {
    assert.equal(view.press(i % LANES), true);
    await r.clock.advance(20);
  }
  assert.match(view.el.textContent, /Too many extra taps - streak reset/);
  assert.deepEqual(played.slice(before), [], 'stray taps and the streak reset play nothing');
  view.destroy();
  noSongs();
});

test('a drawing error does not stop the game for good', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1 });
  const engine = r.engines[0];
  const view = makeView(engine, fakeWin(() => r.clock.now()));
  await allReady(r);
  view.update(engine.snapshot());
  assert.equal(view.looping, true);
  view.local.frames = null;
  assert.equal(view.tick(0, 16), false, 'a frame that throws is dropped from the loop');
  assert.equal(view.looping, false);
  view.local.frames = [];
  view.update(engine.snapshot());
  assert.equal(view.looping, true, 'the next update starts the loop again');
  assert.equal(view.tick(0, 16), true);
  view.destroy();
  noSongs();
});

test('the renderer is safe without a canvas and caps particles', () => {
  const noCanvas = createBeatDraw({});
  assert.equal(noCanvas.ok, false);
  assert.equal(noCanvas.draw({ now: 0, t: 0 }), false);
  const calls = [];
  const ctx2 = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get: (t, k) => (k in t ? t[k] : () => calls.push(k)), set: (t, k, v) => ((t[k] = v), true) });
  const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx2 });
  const draw = createBeatDraw(fakeCanvas(), { doc: { createElement: fakeCanvas } });
  assert.equal(draw.resize({ width: 400, height: 500, dpr: 3, lanes: 4 }), true);
  assert.equal(draw.view.dpr, 2, 'device pixel ratio is capped at 2');
  assert.equal(draw.view.lanes, 4);
  for (let i = 0; i < 20; i += 1) draw.burst(i % 4, 0, 6);
  assert.equal(draw.particles, 60);
  const song = testSong(3, 45);
  assert.ok(song.notes.some((n) => n.e), 'an Expert chart has holds to draw');
  const holdAt = song.notes.find((n) => n.e);
  const tail = new Uint8Array(song.notes.length);
  tail[song.notes.indexOf(holdAt)] = 9;
  calls.length = 0;
  assert.equal(draw.draw({ now: 10, t: holdAt.t / 1000 + 0.1, look: 1.7, song, mark: new Uint8Array(song.notes.length), hold: tail, judge: [{ k: 'p', at: 0, tag: '' }, null, null, null], labels: ['D', 'F', 'J', 'K'], countdown: '3', dropSoon: true, marks: [{ t: 10, sec: 'drop' }], tier: 2 }), true);
  assert.ok(calls.includes('drawImage'));
  assert.ok(calls.includes('fillText'));
  assert.ok(calls.includes('fillRect'), 'hold tails are drawn');
  assert.equal(calls.includes('shadowBlur'), false);
  draw.draw({ now: 10, t: 5, look: 1.7, song, still: true });
  assert.equal(draw.particles, 0, 'no particles in calm view');
});

test('the tutorial teaches one lane at a time, then tunes timing with an undo and a click track', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  let now = 1000;
  let offset = 0;
  let done = null;
  const clicks = [];
  let tapSounds = 0;
  const synth = { hit: () => (tapSounds += 1), stray: () => (tapSounds += 1), click: (d, accent) => clicks.push(accent) };
  const t = createTutorial({ lanes: 2, perf: () => now, loop: null, synth, labels: () => ['D', 'F', 'J', 'K'], offset: () => offset, onOffset: (ms) => (offset = ms), onDone: (r) => (done = r) });
  assert.equal(t.step, 1);
  assert.equal(t.press(2, now), false, 'the wrong lane does nothing');
  now += 2500;
  assert.equal(t.press(0, now), true);
  now += 800;
  t.frame();
  assert.equal(t.step, 2);
  now += 2500;
  assert.equal(t.press(2, now), false, 'step two teaches the far right lane');
  assert.equal(t.press(3, now), true);
  now += 800;
  t.frame();
  assert.equal(t.step, 3);
  const start = now;
  for (const n of tutorialNotes()) {
    now = start + n.t + 30;
    t.press(n.l, now);
    t.frame();
  }
  assert.equal(t.streak, 8);
  assert.ok(clicks.length >= 8 && clicks.slice(0, 2).every(Boolean), 'a click metronome counts the notes in');
  t.press(0, now + 5000);
  assert.equal(tapSounds, 0, 'hits and stray taps in the tutorial make no sound');
  now = start + tutorialNotes()[7].t + 1000;
  t.frame();
  assert.equal(t.step, 4);
  assert.equal(offset, 30, 'you tap 30 ms late, so it is fixed');
  const undo = all(t.el).find((n) => n.dataset && n.dataset.key === 'bd-tut-undo');
  undo.click();
  assert.equal(offset, 0);
  all(t.el).find((n) => n.dataset && n.dataset.key === 'bd-tut-done').click();
  assert.deepEqual(done.skipped, false);
  const skip = createTutorial({ lanes: 2, perf: () => now, onDone: (r) => (done = r) });
  all(skip.el).find((n) => n.dataset && n.dataset.key === 'bd-tut-skip').click();
  assert.equal(done.skipped, true);
  assert.equal(skip.gone, true);
});

test('the view: tutorial first, a ready card, lanes you can play and a results card with the song credit', async () => {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { length: 45, songs: 2 });
  const engine = r.engines[0];
  const store = memStore();
  const view = createBeatdropView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r.clock.now()), storage: store, songAudio: fakeSongAudio() });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  await settle(r, 300);
  assert.ok(document.body.querySelector('link[data-bd-play]'), 'the play sheet loads with the view');
  assert.equal(document.body.querySelector('link[data-bd-play]').getAttribute('href'), PLAY_SHEET);
  assert.ok(view.tut, 'first timers get the tutorial');
  assert.ok(byKey(view, 'bd-tut-skip'));
  byKey(view, 'bd-tut-skip').click();
  assert.equal(view.tut, null);
  assert.equal(readPrefs(store).seen, true);
  for (const k of ['bd-ready', 'bd-how', 'bd-timing', 'bd-slow', 'bd-calm']) assert.ok(byKey(view, k), k);
  assert.ok(all(view.el).some((n) => n.textContent === 'Song 1 of 2 - NEXT UP'));
  assert.ok(all(view.el).some((n) => n.textContent === '4 lanes ● ◆ ■ ▲'), 'the ready card says 4 lanes once');
  assert.equal(all(view.el).some((n) => /[0-35-9] lanes/.test(n.textContent || '')), false);
  assert.equal(document.body.querySelector('link[data-bd-songs]').getAttribute('href'), SONG_SHEET);
  assert.ok(st(r).ld.includes(engine.snapshot().meSlot), 'the view loaded the song');
  byKey(view, 'bd-ready').click();
  r.engines[1].act({ type: 'loaded', n: st(r).n });
  r.engines[1].act({ type: 'ready', n: st(r).n });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'play');
  view.update(engine.snapshot());
  const s = st(r);
  const song = songOfState(s);
  assert.equal(view.local.lanes, 4);
  assert.ok(all(view.el).filter((n) => n.classList && n.classList.contains('bd-pad')).length === 4);
  assert.equal(byKey(view, 'bd-lane-1').getAttribute('aria-label'), 'Lane 2 (F)');
  assert.equal(view.el.querySelector('.bd-stage').style.props['--bd-w'], `${widthFor(4)}px`);
  await r.clock.advance(s.at - engine.now() - 1000);
  view.frame();
  await playView(r, view, s, song, 3, 20000);
  await r.clock.advance(400);
  assert.ok(st(r).sc[engine.snapshot().meSlot], 'progress was sent');
  await playView(r, view, s, song, 3);
  assert.equal(view.judge.stats.p, song.notes.length, 'every press lands Perfect');
  await r.clock.advance(s.at + lastNoteAt(song) * 1000 + 800 - engine.now());
  view.frame();
  await r.clock.advance(400);
  assert.ok(await until(r, () => st(r).phase === 'show'));
  assert.equal(st(r).res[engine.snapshot().meSlot][5], song.notes.length, 'the final counts were sent');
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'show');
  const card = all(view.el).find((n) => n.classList && n.classList.contains('bd-me'));
  assert.ok(card, 'a personal results card');
  assert.ok(all(card).some((n) => n.textContent === '1000 / 1000'));
  const bar = all(card).find((n) => n.classList && n.classList.contains('bd-bar'));
  assert.equal(bar.style.props['--bd-p'], '1.0000');
  assert.ok(all(view.el).some((n) => n.classList && n.classList.contains('bd-upnext')));
  assert.ok(all(view.el).some((n) => n.classList && n.classList.contains('bd-res-row')));
  const texts = all(view.el).map((n) => n.textContent || '');
  assert.ok(texts.includes(`${st(r).tt[0]} - The Testers`), 'the results name the song');
  assert.ok(texts.includes('Credit: Made by me'), 'and credit it');
  assert.equal(texts.some((x) => /built-in/i.test(x)), false, 'nothing mentions built-in beats');
  assert.equal(readPrefs(store).best[`${s.sid}.${s.df}`], 1000, 'a new best is remembered per song');
  assert.match(footText(beatdrop.model(engine.snapshot())), /topped the song/);
  for (const n of all(view.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  view.destroy();
  noSongs();
});

test('the view: watchers get a demo highway and late taps can be fixed in one tap', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { length: 45, songs: 2, difficulty: 'hard' });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  await r.clock.advance(s.at - r.engines[0].now() + 3000);
  const late = r.add(3);
  await r.clock.advance(800);
  const watcher = makeView(late, fakeWin(() => late.now()));
  watcher.update(late.snapshot());
  assert.equal(watcher.judge, null);
  assert.equal(watcher.local.demo, true);
  assert.ok(all(watcher.el).some((n) => n.textContent === "Watching - you're in next song"));
  watcher.frame();
  assert.ok(watcher.local.mark.some((x) => x === 5), 'notes auto-hit as ghosts');
  assert.equal(watcher.press(0), false);
  watcher.destroy();
  const engine = r.engines[0];
  const pstore = memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) });
  const view = makeView(engine, fakeWin(() => r.clock.now()), { storage: pstore });
  view.update(engine.snapshot());
  view.frame();
  await playView(r, view, s, song, 60);
  assert.ok(view.judge.stats.g > 20);
  await r.clock.advance(s.at + lastNoteAt(song) * 1000 + 800 - engine.now());
  view.frame();
  await r.clock.advance(st(r).ends - engine.now() + 300);
  view.update(engine.snapshot());
  const fix = byKey(view, 'bd-fix');
  assert.ok(fix, 'a Fix it button for late tappers');
  assert.ok(all(view.el).some((n) => /You hit about 60 ms late/.test(n.textContent || '')));
  fix.click();
  assert.equal(view.offset, 60);
  assert.equal(readPrefs(pstore).tapOffset, 60);
  assert.equal(view.clock.offset, 60);
  view.destroy();
  noSongs();
});

test('reduced motion turns on slower notes and the calm view by default', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1, difficulty: 'easy' });
  const engine = r.engines[0];
  const view = makeView(engine, fakeWin(() => r.clock.now(), true));
  view.update(engine.snapshot());
  assert.equal(byKey(view, 'bd-slow').getAttribute('aria-pressed'), 'true');
  await allReady(r);
  view.update(engine.snapshot());
  assert.equal(view.local.lanes, 4, 'Chill is 4 lanes too');
  assert.equal(all(view.el).filter((n) => n.classList && n.classList.contains('bd-pad')).length, 4);
  assert.ok(Math.abs(view.local.look - lookFor(0, true)) < 1e-9);
  view.destroy();
  const r2 = await startGame(1, { length: 45, songs: 1, difficulty: 'easy' });
  const plain = makeView(r2.engines[0], fakeWin(() => r2.clock.now(), false));
  await allReady(r2);
  plain.update(r2.engines[0].snapshot());
  assert.ok(Math.abs(plain.local.look - lookFor(0, false)) < 1e-9);
  plain.destroy();
  noSongs();
});

test('an old Beat Drop room key from before the update is replaced safely', async () => {
  await useSongs();
  const old = { v: 3, n: 3, phase: 'play', i: 0, total: 1, lineup: [['s', 'pop', 112]], seed: 5, src: 's', sty: 'pop', bpm: 112, df: 1, len: 45, in: [0, 1], sc: {}, at: 0, starts: 0, ends: 1, hint: 1, fb: 1 };
  assert.equal(beatdrop.model({ state: { [KEY]: old }, meSlot: 0, players: [] }), null);
  assert.equal(songOfState(old), null);
  assert.equal(songOfState({ ...old, src: 'u', sid: SID, cv: 1 }), null, 'an old uploaded song key is not played either');
  let put = null;
  const api = { get: () => old, put: (k, v) => (put = v), now: () => 1000, players: () => [{ slot: 0 }], settings: { song: 'beats', style: 'funk' }, random: seeded(1), memory: {}, setDeadline() {}, round() {}, deadline: null, finish() {} };
  beatdrop.resume(api);
  assert.equal(put.v, 4);
  assert.equal(V, 4);
  assert.equal(put.phase, 'ready');
  assert.ok([SID, SID2].includes(put.sid), 'it restarts on an uploaded song');
  assert.ok(put.lineup.every((x) => x.length === 2 && [SID, SID2].includes(x[0])));
  for (const k of ['seed', 'sty', 'bpm', 'src', 'hint', 'fb']) assert.equal(k in put, false, `no ${k} key`);
  put = null;
  beatdrop.deadline({ ...api, finish: () => (put = 'finished') });
  assert.equal(put, 'finished', 'a deadline on an old key ends the game cleanly');
  noSongs();
});

test('the renderer shrinks notes so close notes in one lane never overlap on short screens', () => {
  const notes = [{ t: 0, l: 0 }, { t: 150, l: 1 }, { t: 400, l: 1 }, { t: 600, l: 0 }];
  assert.equal(laneGapMs(notes), 250);
  assert.equal(laneGapMs([]), Infinity);
  assert.equal(gemScale(Infinity, 1.7, 400, 50), 1);
  assert.equal(gemScale(300, 1.7, 600, 50), 1, 'tall screens keep full size notes');
  for (const [gap, look, hitY, gem] of [[150, 1.35, 300, 48], [220, 1.7, 260, 58], [267, 1.7, 384, 58]]) {
    const k = gemScale(gap, look, hitY, gem);
    const room = (gap / 1000 / look) * hitY;
    assert.ok(k >= GEM_MIN_SCALE && k <= 1);
    assert.ok(k === GEM_MIN_SCALE || gem * k < room, `${gap} ms notes fit in ${room.toFixed(1)} px`);
  }
});

test('holds: held through is Perfect, early releases grade down, tails count as objects', () => {
  const song = prepSong({ df: 3, notes: [{ t: 2000, l: 0, e: 3000 }, { t: 2500, l: 1 }, { t: 4000, l: 2, e: 5000 }, { t: 6000, l: 3, e: 7000 }], dur: 9 });
  assert.equal(countOf(song), 7);
  assert.equal(objectCount(song.notes), 7);
  assert.deepEqual(objTimes(song.notes), [2000, 2500, 3000, 4000, 5000, 6000, 7000]);
  assert.equal(objectsBefore(song, 2.001), 2, 'a tail can be judged once its head arrives');
  assert.equal(objectsBefore(song, 4.5), 5);
  const w = windowsFor(3);
  assert.equal(releaseKind(3000, 3000 - w.g, w), 'p');
  assert.equal(releaseKind(3000, 3000 - HOLD_GOOD_MS, w), 'g');
  assert.equal(releaseKind(3000, 3000 - HOLD_OK_MS, w), 'o');
  assert.equal(releaseKind(3000, 3000 - HOLD_OK_MS - 1, w), 'm');
  const j = createJudge(song, 3);
  assert.equal(j.n, 7);
  j.press(0, 2000);
  assert.equal(j.holding[0], 0);
  assert.equal(j.tail[0], 9);
  j.press(1, 2500);
  let out = j.release(0, 2995);
  assert.ok(out.some((e) => e.tail && e.k === 'p'), 'held to the end is Perfect');
  assert.equal(j.holding[0], -1);
  j.press(2, 4000);
  out = j.sweep(5000);
  assert.ok(out.some((e) => e.tail && e.k === 'p' && e.idx === 2), 'a tail still held when it ends completes itself');
  j.press(3, 6000);
  assert.equal(j.stats.c, 6);
  out = j.release(3, 6500);
  assert.ok(out.some((e) => e.tail && e.k === 'm' && e.lost === 6), 'letting go far too early is a miss and breaks the streak');
  assert.equal(j.stats.c, 0);
  assert.equal(j.done, true);
  assert.deepEqual(j.final(), [6, 0, 0, 1, 6]);
  const g = createJudge(song, 3);
  g.press(0, 2000);
  assert.ok(g.release(0, 2880).some((e) => e.tail && e.k === 'g'));
  const o = createJudge(song, 3);
  o.press(0, 2000);
  assert.ok(o.release(0, 2750).some((e) => e.tail && e.k === 'o'));
  const miss = createJudge(song, 3);
  miss.sweep(2500);
  assert.equal(miss.stats.m, 2, 'a missed head misses its tail too');
  assert.equal(miss.stats.j, 2);
  const song2 = testSong(3, 60);
  assert.ok(song2.notes.some((n) => n.e));
  const full = perfectRun(song2);
  assert.equal(full.score, MAX_SCORE, 'a perfect run with holds still scores 1000');
  assert.equal(full.stats.j, full.n);
  const fin = full.final();
  assert.ok(checkFinal(song2, 70, fin));
  assert.equal(checkFinal(song2, 70, fin).score, MAX_SCORE);
  assert.equal(checkProgress(song2, 1, [countOf(song2), countOf(song2), 0, 0, 0, 1, 1]), null, 'tails can not arrive before their heads');
});

test('client chart codec: round trip, every validator rule and the length cut', () => {
  const notes = [{ t: 2000, l: 0 }, { t: 2000, l: 2 }, { t: 2500, l: 1, e: 3500 }, { t: 3000, l: 3 }];
  assert.deepEqual(decodeNotes(encodeNotes(notes)), notes);
  assert.ok(encodeNotes(notes).length / notes.length <= 2);
  const len = 40000;
  const good = makeChart(len);
  const ok = validateChart(good, len);
  for (let i = 1; i < ok.counts.length; i += 1) assert.ok(ok.counts[i] >= ok.counts[i - 1]);
  assert.ok(ok.d.hard.some((n) => n.e) && ok.d.expert.some((n) => n.e));
  assert.deepEqual(validateChart(JSON.stringify(good), len).counts, ok.counts, 'a JSON string chart works too');
  const bad = (mut, re, label) => {
    const c = JSON.parse(JSON.stringify(good));
    mut(c);
    assert.throws(() => validateChart(c, len), re, label);
  };
  bad((c) => (c.v = 2), /version/);
  bad((c) => (c.bpm = 300), /tempo/);
  bad((c) => (c.b0 = 9000), /first beat/);
  bad((c) => (c.len = 39000), /length/);
  bad((c) => (c.marks = [[9000, 'drop'], [8000, 'build']]), /mark/, 'unsorted marks');
  bad((c) => (c.marks = Array.from({ length: 17 }, (_, i) => [i * 100, 'drop'])), /too many marks/);
  bad((c) => delete c.d.expert, /missing Expert/);
  bad((c) => (c.d.easy = [1, 2, 3]), /broken note list/);
  bad((c) => (c.d.easy = [2000, 0, -5, 1]), /broken note/, 'unsorted notes');
  bad((c) => (c.d.easy = [2000, 4]), /hold that is too short/, 'a fifth lane is not a lane');
  bad((c) => (c.d.easy = encodeNotes([{ t: 2000, l: 0 }, { t: 2000, l: 1 }, { t: 2000, l: 2 }])), /more than two/);
  bad((c) => (c.d.easy = encodeNotes([{ t: 2000, l: 0 }, { t: 2000, l: 0 }])), /one lane twice/);
  bad((c) => (c.d.easy = encodeNotes([{ t: 2000, l: 0, e: 2500 }])), /only allowed on Hard/);
  bad((c) => (c.d.hard = encodeNotes([{ t: 2000, l: 0, e: 3000 }, { t: 3050, l: 0 }])), /too close/, 'a note right after a hold in the same lane');
  bad((c) => (c.d.hard = encodeNotes([{ t: 2000, l: 0, e: 4000 }, { t: 2500, l: 1, e: 4000 }, { t: 3000, l: 2 }])), /held at once/);
  assert.equal(checkNotes(Array.from({ length: CHART_CAPS.easy }, (_, i) => ({ t: 2000 + i * 260, l: i % 4 })), 'easy', SECTION_MAX_MS), CHART_CAPS.easy);
  assert.throws(() => checkNotes(Array.from({ length: CHART_CAPS.easy + 1 }, (_, i) => ({ t: 2000 + i * 260, l: i % 4 })), 'easy', SECTION_MAX_MS), /too many notes/);
  bad((c) => (c.d.easy = encodeNotes(Array.from({ length: 15 }, (_, i) => ({ t: 2000 + i * 200, l: i % 4 })))), /too dense/);
  bad((c) => (c.d.easy = encodeNotes([{ t: 39800, l: 0 }])), /past the end/);
  bad((c) => (c.d.easy = encodeNotes([{ t: 1000, l: 0 }])), /too early/);
  bad((c) => (c.d.expert = c.d.easy), /fewer notes/, 'counts never go down');
  assert.throws(() => validateChart('x'.repeat(CHART_MAX_BYTES + 1), len), /too big/);
  assert.throws(() => validateChart({ ...good, pad: 'x'.repeat(CHART_MAX_BYTES) }, len), /too big/);
  const body = songBody(SID);
  assert.equal(readSong(body, SID, 1).title, 'Night Test');
  for (const [over, re] of [[{ url: 'https://elsewhere.example/a.mp3' }, /no audio/], [{ url: `/song-audio/${SID2}.mp3` }, /no audio/], [{ url: `/song-audio/${SID}.wav` }, /no audio/], [{ off: 400 }, /offset/], [{ cv: 2 }, /changed/], [{ id: SID2 }, /did not match/], [{ end: 5000 }, /section/]]) {
    assert.throws(() => readSong({ ...body, ...over }, SID, 1), re, JSON.stringify(over));
  }
  assert.equal(readSong({ ...body, url: `/media/songs/${SID}.m4a` }, SID, 1).url, `/media/songs/${SID}.m4a`);
  assert.equal(readSong({ ...body, title: 'Tab\tName\u0000 ' }, SID, 1).title, 'TabName');
  assert.deepEqual(readCatalog({ songs: [[SID, 'A', 'B', 1000, 120, 1, [1, 2, 3, 4]], ['bad', 'x', '', 0, 0, 1, []], [SID, 'dupe', '', 0, 0, 1, []], { id: SID2, title: 'Obj', artist: 'C', dur: 2, bpm: 99.6, cv: 3, counts: [] }] }).map((x) => [x.id, x.title, x.cv, x.bpm]), [[SID, 'A', 1, 120], [SID2, 'Obj', 3, 100]]);
  assert.equal(readCatalog({}), null);
});

test('client chart loading: one request per song, a timeout, bad charts are refused and the length cut is the same everywhere', async () => {
  const log = [];
  const timers = await useSongs({ log, songs: [SID, SID2, SID3] });
  assert.equal(catalog().length, 3);
  assert.equal(catalogTried(), true);
  const before = log.length;
  const [a, b] = await Promise.all([loadChart(SID, 1), loadChart(SID, 1)]);
  assert.equal(a, b);
  assert.equal(log.length - before, 1, 'two asks share one request');
  await loadChart(SID, 1);
  assert.equal(log.length - before, 1, 'a loaded chart is cached');
  assert.deepEqual(log.slice(-1), [`/api/activity/songs/${SID}?v=1`]);
  const s45 = chartSong(SID, 1, 3, 45);
  assert.equal(s45.lanes, 4);
  assert.equal(s45.cut, 40000, 'a short section plays whole');
  assert.ok(Math.abs(s45.dur - 41.5) < 1e-9);
  assert.equal(s45.meta.url, `/song-audio/${SID}.mp3`);
  assert.equal(chartSong(SID, 1, 3, 45), s45, 'built songs are cached');
  assert.ok(s45.notes.some((n) => n.e) && s45.notes.some((n) => n.c));
  assert.equal(chartSong(SID, 1, 0, 45).notes.some((n) => n.e), false);
  assert.deepEqual(s45.marks, [{ t: 8, sec: 'build' }, { t: 16, sec: 'drop' }]);
  assert.equal(chartSong(SID, 2, 3, 45), null, 'another chart version is not loaded');
  resetSongs();
  const long = { ...songBody(SID3, { len: 100000 }) };
  setSongFetch(async () => ({ ok: true, json: async () => long }), { timer: (fn) => timers.push(fn), clear() {} });
  await loadChart(SID3, 1);
  const cut = chartSong(SID3, 1, 2, 45);
  assert.equal(cut.cut, 45000, 'the song length setting cuts a long section');
  assert.ok(cut.notes.every((n) => n.t <= 44000 && (!n.e || n.e <= 44500)));
  assert.ok(chartSong(SID3, 1, 2, 90).notes.length > cut.notes.length);
  assert.deepEqual(chartSong(SID3, 1, 2, 45).notes, cut.notes, 'every client cuts the same way');
  const bad = songBody(SID2);
  bad.charts = { ...bad.charts, d: { ...bad.charts.d, easy: [2000, 4] } };
  setSongFetch(async () => ({ ok: true, json: async () => bad }), { timer: (fn) => timers.push(fn), clear() {} });
  await assert.rejects(loadChart(SID2, 1), /hold/);
  assert.equal(chartEntry(SID2, 1), null, 'a bad chart is never cached');
  let fire = null;
  setSongFetch(() => new Promise(() => {}), { timer: (fn, ms) => ((fire = fn), assert.equal(ms, CHART_TIMEOUT_MS)), clear() {} });
  const slow = loadChart(SID2, 1);
  fire();
  await assert.rejects(slow, /too long/);
  await assert.rejects(loadChart('nope', 1), /not valid/);
  setSongFetch(null);
  await assert.rejects(loadChart(SID2, 1), /offline/);
  noSongs();
});

test('Full song plays the whole section and shorter lengths play a window from the best part', () => {
  resetSongs();
  const ID = 's-00000000000000bb';
  const entry = putChart(readSong(songBody(ID, { len: 300000, preview: 110000 }), ID, 1));
  assert.equal(entry.pre, 100000, 'the best part is read relative to the section start');
  const all = entry.d.expert;
  const full = chartSong(ID, 1, 3, FULL_SONG);
  assert.equal(full.cut, 300000);
  assert.equal(full.skip, 0);
  assert.equal(full.full, true);
  assert.equal(full.meta.start, 10000);
  assert.deepEqual(songSpan(full), { url: `/song-audio/${ID}.mp3`, from: 10, len: 300 });
  assert.equal(full.notes.length, all.filter((n) => n.t <= 299000).length);
  assert.ok(Math.abs(full.dur - 301.5) < 1e-9);
  const w = chartSong(ID, 1, 3, 60);
  assert.equal(w.skip, 100000);
  assert.equal(w.cut, 60000);
  assert.equal(w.full, false);
  assert.equal(w.meta.start, 110000, 'the audio starts at the best part');
  assert.deepEqual(songSpan(w), { url: `/song-audio/${ID}.mp3`, from: 110, len: 60 });
  assert.ok(w.notes.length > 0);
  for (const n of w.notes) {
    assert.ok(n.t >= 1500 && n.t <= 59000, `note at ${n.t}`);
    if (n.e) assert.ok(n.e <= 59500 && n.e - n.t >= 200);
    assert.ok(all.some((x) => x.t === n.t + 100000 && x.l === n.l), 'every note is shifted by the skip');
  }
  assert.deepEqual(w.marks, [], 'marks outside the window are dropped');
  assert.equal(w.b0, 0);
  assert.equal(chartSong(ID, 1, 3, 60), w, 'windows are cached');
  assert.deepEqual(songWindow(entry, 150), { skip: 100000, cut: 150000 });
  assert.deepEqual(songWindow(entry, 0), { skip: 0, cut: 300000 });
  const late = putChart(readSong(songBody(ID, { len: 300000, preview: 300000, cv: 2 }), ID, 2));
  assert.equal(late.pre, 290000);
  const end = chartSong(ID, 2, 3, 60);
  assert.equal(end.skip, 240000, 'a best part near the end slides back so the window fits');
  assert.equal(end.cut, 60000);
  assert.equal(end.meta.start, 250000);
  assert.ok(end.notes.every((n) => n.t <= 59000));
  const ID2 = 's-00000000000000cc';
  const short = putChart(readSong(songBody(ID2, { len: 40000, preview: 30000 }), ID2, 1));
  assert.equal(short.pre, 20000);
  const s60 = chartSong(ID2, 1, 2, 60);
  assert.equal(s60.cut, 40000, 'a section shorter than the length plays whole');
  assert.equal(s60.skip, 0);
  assert.equal(s60.meta.start, 10000);
  const s45 = chartSong(ID2, 1, 2, 45);
  assert.equal(s45.cut, 40000);
  const ID3 = 's-00000000000000dd';
  putChart(readSong(songBody(ID3, { len: 100000, preview: 15000 }), ID3, 1));
  const m45 = chartSong(ID3, 1, 3, 45);
  assert.equal(m45.skip, 5000);
  assert.deepEqual(m45.marks, [{ t: 3, sec: 'build' }, { t: 11, sec: 'drop' }], 'marks shift with the skip');
  const ID4 = 's-00000000000000ee';
  const old = putChart(readSong(songBody(ID4, { len: 100000 }), ID4, 1));
  assert.equal(old.pre, 0, 'songs without a best part start at the section start');
  assert.equal(chartSong(ID4, 1, 3, 60).skip, 0);
  const outside = putChart(readSong(songBody(ID4, { len: 100000, preview: 500000, cv: 2 }), ID4, 2));
  assert.equal(outside.pre, 0, 'a best part outside the section is ignored');
  resetSongs();
});

test('the song catalog is retried after a failure, but not on every lobby update', async () => {
  resetSongs();
  let now = 1000;
  let calls = 0;
  let down = true;
  setSongFetch(async () => {
    calls += 1;
    return down ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ songs: [[SID, 'Night Test', '', 1000, 120, 1, []]] }) };
  }, { now: () => now, timer: () => 0, clear() {} });
  assert.equal(catalogTried(), false);
  assert.equal(songsNote(), WAIT_TEXT, 'the lobby says it is checking before the first answer');
  await loadCatalog();
  assert.equal(catalogTried(), true);
  assert.equal(songsNote(), NEED_TEXT);
  await loadCatalog();
  await loadCatalog();
  assert.equal(calls, 1, 'a failed check is not repeated right away');
  down = false;
  now += 11000;
  await loadCatalog();
  assert.equal(calls, 2);
  assert.equal(songsNote(), '');
  setSongFetch(null, { now: () => Date.now() });
  noSongs();
});

async function songGame(n, settings = {}, opts = {}) {
  return startGame(n, { songs: 1, length: 45, ...settings }, [beatdrop], opts);
}

async function loadedReady(r, slotsToLoad = slots(r)) {
  const s = st(r);
  for (const slot of slotsToLoad) bySlot(r, slot).act({ type: 'loaded', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
}

test('uploaded songs: a random lineup without repeats, ready waits for everyone to load, then the song plays and results show the credit', async () => {
  const r = await songGame(2, { songs: 2 });
  const s = st(r);
  assert.equal(s.v, 4);
  assert.ok([SID, SID2].includes(s.sid));
  assert.equal(s.cv, 1);
  assert.equal(s.lineup.length, 2);
  assert.ok(s.lineup.every((x) => x.length === 2));
  assert.notEqual(s.lineup[0][0], s.lineup[1][0], 'no repeats');
  assert.ok(chartEntry(s.sid, s.cv), 'the host loads the chart during ready');
  assert.equal(/"charts"|"notes"|"url"/.test(JSON.stringify(r.hub.state)), false, 'charts never go into state');
  const [a, b] = slots(r);
  const m0 = beatdrop.model(bySlot(r, a).snapshot());
  assert.equal(m0.sid, s.sid);
  assert.deepEqual(m0.loading, { mine: 'wait', done: 0, of: 2 });
  assert.equal(m0.song.title, s.sid === SID ? 'Night Test' : 'Second Test');
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
  assert.equal(st(r).phase, 'ready', 'ready alone is not enough');
  bySlot(r, a).act({ type: 'loaded', n: s.n });
  await settle(r, 300);
  assert.equal(st(r).phase, 'ready');
  assert.deepEqual(st(r).ld, [a]);
  assert.equal(beatdrop.model(bySlot(r, a).snapshot()).loading.mine, 'ok');
  assert.ok(beatdrop.model(bySlot(r, a).snapshot()).dots.some((d) => d.slot === a && d.ld));
  bySlot(r, b).act({ type: 'loaded', n: s.n });
  await settle(r, 300);
  const p = st(r);
  assert.equal(p.phase, 'play');
  assert.deepEqual(p.in.slice().sort(), [a, b].sort());
  assert.deepEqual(p.nl, []);
  const song = songOfState(p);
  assert.equal(p.on, countOf(song));
  assert.equal(p.du, Math.round(song.dur * 1000));
  assert.ok(jsonBytes(p) < 4096);
  await playAlong(r, p, endOf(p), { [a]: 'all', [b]: 'half' });
  bySlot(r, a).act({ type: 'done', n: p.n, v: perfectRun(song).final() });
  const half = Math.floor(countOf(song) / 2);
  bySlot(r, b).act({ type: 'done', n: p.n, v: [half, 0, 0, countOf(song) - half, 2] });
  await settle(r, 400);
  const show = st(r);
  assert.equal(show.phase, 'show');
  assert.equal(show.res[a][1], MAX_SCORE);
  assert.deepEqual(show.tt, [s.sid === SID ? 'Night Test' : 'Second Test', 'The Testers']);
  const m = beatdrop.model(bySlot(r, a).snapshot());
  assert.deepEqual(m.song, { title: show.tt[0], artist: 'The Testers', credit: 'Made by me', adult: false }, 'results carry only the song and its credit');
  assert.equal(m.track.emoji, '🎵');
  assert.equal(songLine(m.song), `${m.song.title} - The Testers`);
  assert.equal(m.next.title, s.lineup[1][0] === SID ? 'Night Test' : 'Second Test');
  assert.deepEqual(beatdrop.results({ get: () => show }).extra.song, { t: show.tt[0], a: 'The Testers' });
  noSongs();
});

test('uploaded songs: slow loaders get one extension, then the song starts and they watch it, late joiners load too', async () => {
  const r = await songGame(3);
  const s = st(r);
  const [a, b, c] = slots(r);
  for (const slot of [a, b]) bySlot(r, slot).act({ type: 'loaded', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
  const late = r.add(4);
  await settle(r, 300);
  const d = late.snapshot().meSlot;
  assert.ok(st(r).in.includes(d), 'someone joining during ready is in');
  assert.equal(st(r).phase, 'ready');
  await r.clock.advance(s.ends - r.clock.now() + 100);
  await settle(r);
  const ext = st(r);
  assert.equal(ext.phase, 'ready', 'one extension while songs load');
  assert.equal(ext.lw, 1);
  assert.ok(ext.ends <= s.starts + READY_MAX_MS + LOAD_WAIT_MS);
  assert.ok(ext.ends > r.clock.now());
  late.act({ type: 'loaded', n: s.n });
  await settle(r, 300);
  assert.equal(st(r).phase, 'ready');
  await r.clock.advance(ext.ends - r.clock.now() + 100);
  await settle(r);
  const p = st(r);
  assert.equal(p.phase, 'play', 'no second extension');
  assert.deepEqual(p.in.slice().sort(), [a, b, d].sort());
  assert.ok(p.w.includes(c), 'the slow loader watches this song');
  const mc = beatdrop.model(bySlot(r, c).snapshot());
  assert.equal(mc.watching, true);
  assert.equal(mc.playing, false);
  noSongs();
});

test('uploaded songs: a failed load means spectating that song, Try again counts, and nobody loading skips the round', async () => {
  const r = await songGame(2);
  const s = st(r);
  const [a, b] = slots(r);
  bySlot(r, b).act({ type: 'nolo', n: s.n });
  await settle(r, 300);
  assert.deepEqual(st(r).lf, [b]);
  assert.equal(beatdrop.model(bySlot(r, b).snapshot()).loading.mine, 'fail');
  bySlot(r, b).act({ type: 'loaded', n: s.n });
  await settle(r, 300);
  assert.deepEqual(st(r).lf, [], 'Try again moves them to loaded');
  assert.deepEqual(st(r).ld, [b]);
  bySlot(r, b).act({ type: 'nolo', n: s.n });
  bySlot(r, a).act({ type: 'nolo', n: s.n });
  bySlot(r, a).act({ type: 'loaded', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
  const p = st(r);
  assert.equal(p.phase, 'play');
  assert.ok(p.in.includes(a) && p.in.includes(b), 'a late nolo after loading is ignored');
  const r1 = await songGame(2, { songs: 2 });
  const s1 = st(r1);
  const [x, y] = slots(r1);
  bySlot(r1, x).act({ type: 'loaded', n: s1.n });
  bySlot(r1, y).act({ type: 'nolo', n: s1.n });
  for (const e of r1.engines) e.act({ type: 'ready', n: s1.n });
  await settle(r1, 300);
  const p1 = st(r1);
  assert.equal(p1.phase, 'play', 'one failed load does not stop the round');
  assert.deepEqual(p1.in, [x]);
  assert.ok(p1.w.includes(y), 'they spectate this song');
  assert.deepEqual(p1.nl, [y]);
  const my = beatdrop.model(bySlot(r1, y).snapshot());
  assert.equal(my.noLoad, true);
  assert.equal(my.watching, true);
  assert.equal(beatdrop.model(bySlot(r1, x).snapshot()).noLoad, false);
  await playAlong(r1, p1, p1.ends + 300, { [x]: 'all' });
  await r1.clock.advance(SHOW_MS + 300);
  await settle(r1);
  assert.equal(st(r1).phase, 'ready');
  assert.ok(st(r1).in.includes(y), 'and join the next one');
  assert.deepEqual(st(r1).nl, []);
  const r2 = await songGame(2);
  const s2 = st(r2);
  for (const e of r2.engines) {
    e.act({ type: 'nolo', n: s2.n });
    e.act({ type: 'ready', n: s2.n });
  }
  await settle(r2, 300);
  const p2 = st(r2);
  assert.equal(p2.phase, 'show', 'nobody could load it, so the round is skipped');
  assert.equal(p2.sk, SKIP_LOAD);
  assert.deepEqual(p2.res, {});
  assert.equal(p2.tt, undefined);
  const m2 = beatdrop.model(r2.engines[0].snapshot());
  assert.equal(m2.skipped, SKIP_TEXT);
  assert.equal(footText(m2), m2.last ? '' : 'Moving on to the next song.', 'the footer does not repeat the skip note');
  assert.equal(footText({ ...m2, last: false }), 'Moving on to the next song.');
  assert.equal(footText({ ...m2, last: true }), '');
  assert.deepEqual(beatdrop.results({ get: () => p2 }).extra, {}, 'a skipped round has no song to credit');
  bySlot(r2, slots(r2)[0]).act({ type: 'loaded', n: s2.n });
  await settle(r2, 300);
  assert.equal(st(r2).phase, 'show', 'load reports after the skip are ignored');
  await r2.clock.advance(SKIP_MS + 300);
  assert.equal(r2.hub.state[ROOM].phase, 'results', 'the game ends cleanly');
  noSongs();
});

test('uploaded songs: when the host can not load the chart it waits, then skips the round and moves on', async () => {
  const r = await songGame(2, { songs: 2 }, { broken: [SID, SID2] });
  const s = st(r);
  assert.equal(chartEntry(s.sid, s.cv), null);
  await loadedReady(r);
  const hold = st(r);
  assert.equal(hold.phase, 'ready', 'the host waits for its own chart');
  await r.clock.advance(LOAD_WAIT_MS - 2000);
  await settle(r);
  assert.equal(st(r).phase, 'ready');
  await r.clock.advance(3000);
  await settle(r);
  const p = st(r);
  assert.equal(p.phase, 'show');
  assert.equal(p.sk, SKIP_LOAD);
  assert.equal(p.at, null, 'nothing played');
  assert.equal(beatdrop.model(r.engines[0].snapshot()).skipped, SKIP_TEXT);
  await r.clock.advance(SKIP_MS + 300);
  await settle(r);
  const two = st(r);
  assert.equal(two.phase, 'ready', 'the game moves on to the next song');
  assert.equal(two.i, 1);
  await loadedReady(r);
  await r.clock.advance(LOAD_WAIT_MS + 1500);
  await settle(r);
  assert.equal(st(r).phase, 'show');
  assert.equal(st(r).sk, SKIP_LOAD);
  await r.clock.advance(SKIP_MS + 300);
  assert.equal(r.hub.state[ROOM].phase, 'results', 'and ends cleanly after the last song');
  noSongs();
});

test('uploaded songs: a new host without the chart queues progress and checks it once the chart loads', async () => {
  const opts = {};
  const r = await songGame(3, { length: 45 }, opts);
  await loadedReady(r);
  const s = st(r);
  assert.equal(s.phase, 'play');
  const song = songOfState(s);
  const [, b, c] = slots(r);
  await playAlong(r, s, s.at + 6000, { [b]: 'all', [c]: 'all' });
  await settle(r, 1200);
  const row = st(r).sc[b];
  assert.ok(row);
  opts.down = true;
  resetSongs();
  r.hub.leave(r.engines[0].snapshot().me);
  await settle(r, 2000);
  assert.equal(songOfState(st(r)), null, 'the new host has no chart yet');
  const due = objectsBefore(song, (r.clock.now() - s.at) / 1000 - 0.3);
  bySlot(r, b).act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
  await settle(r, 1200);
  assert.deepEqual(st(r).sc[b], row, 'nothing is trusted before the chart is there');
  assert.equal(st(r).phase, 'play');
  opts.down = false;
  await r.clock.advance(CHECK_MS + 200);
  await settle(r);
  await r.clock.advance(CHECK_MS + 200);
  await settle(r);
  assert.ok(songOfState(st(r)), 'the chart came back');
  assert.equal(st(r).sc[b][2], due, 'the queued progress was checked and kept');
  bySlot(r, c).act({ type: 'prog', n: s.n, v: [999, 999, 0, 0, 0, 999, 999] });
  await settle(r, 1200);
  assert.notEqual(st(r).sc[c] && st(r).sc[c][2], 999, 'and forged rows are still refused');
  noSongs();
});

test('with no songs uploaded Beat Drop can not start and the lobby shows it as unavailable', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  noSongs();
  assert.equal(beatdrop.blocked(), WAIT_TEXT);
  setSongFetch(songServer({ songs: [] }), { timer: () => 0, clear() {} });
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const r = room(2, { join: true });
  await r.clock.advance(500);
  const host = r.engines[0];
  const lobby = createLobby({ engine: host, toast() {}, sfx: { play() {} }, store: memStore({ 'yapos.party.tab': 'all' }) });
  lobby.update(host.snapshot());
  await flush(20);
  assert.equal(beatdrop.blocked(), NEED_TEXT, 'the lobby checks for songs by itself');
  assert.equal(blockedNote(beatdrop), NEED_TEXT);
  const tile = all(lobby.el).find((n) => n.dataset && n.dataset.key === 'pick-beatdrop');
  assert.ok(tile, 'Beat Drop stays in the list');
  assert.equal(tile.disabled, true, 'but can not be picked');
  assert.equal(tile.getAttribute('aria-disabled'), 'true');
  assert.ok(all(tile).some((n) => n.textContent === 'Needs a song.'), 'players see a short note');
  assert.equal(offText(NEED_TEXT, false), 'Needs a song.');
  assert.equal(offText(NEED_TEXT, true), NEED_TEXT);
  const staff = lobbyModel({ ...host.snapshot(), admin: { ...host.snapshot().admin, me: true } }, GAMES);
  assert.equal(staff.games.find((g) => g.id === 'beatdrop').off, NEED_TEXT, 'staff see where to add one');
  assert.equal(staff.games.find((g) => g.id === 'trivia').off, '');
  assert.equal(host.lobby.pick('beatdrop'), true);
  await r.clock.advance(200);
  const res = host.lobby.start();
  assert.deepEqual(res, { ok: false, reason: 'blocked', note: NEED_TEXT });
  assert.equal(r.hub.state[ROOM].phase, 'lobby');
  lobby.update(host.snapshot());
  await flush(20);
  assert.ok(all(lobby.el).some((n) => n.classList && n.classList.contains('start-off') && (n.textContent || '').includes('Needs a song.')), 'the host sees the note instead of a start button');
  assert.equal(all(lobby.el).some((n) => n.dataset && n.dataset.key === 'start'), false);
  const tour = pickTourGames(GAMES, ['beatdrop', 'trivia'], 2, seeded(2));
  assert.equal(tour.includes('beatdrop'), false, 'random and picked tournaments skip it');
  await useSongs();
  assert.equal(beatdrop.blocked(), '');
  assert.equal(host.lobby.start().ok, true, 'once a song exists it starts');
  await settle(r, 300);
  assert.equal(st(r).phase, 'ready');
  lobby.destroy();
  setSongFetch(songServer({ songs: [] }), { timer: () => 0, clear() {} });
  await loadCatalog({ force: true });
  assert.equal(beatdrop.blocked(), NEED_TEXT, 'deleting the last song blocks the next game');
  const r2 = room(1);
  await r2.clock.advance(500);
  r2.engines[0].lobby.pick('beatdrop');
  assert.equal(r2.engines[0].lobby.start().reason, 'blocked');
  let put = null;
  const api = { get: () => put, put: (k, v) => (put = v), now: () => 1000, players: () => [{ slot: 0 }], settings: {}, random: seeded(1), memory: {}, setDeadline() {}, round() {}, deadline: null, finish: () => (put = 'finished') };
  beatdrop.start(api);
  assert.equal(put.phase, 'show', 'a start with no songs never plays anything');
  assert.equal(put.sk, SKIP_NONE);
  assert.equal(put.total, 1);
  assert.equal(beatdrop.model({ state: { [KEY]: put }, meSlot: 0, players: [] }).skipped, NEED_TEXT);
  beatdrop.deadline(api);
  assert.equal(put, 'finished');
  noSongs();
});

test('an old room resumed before the song list loads waits for it, then plays the uploaded songs', async () => {
  noSongs();
  const log = [];
  setSongFetch(songServer({ log }), { timer: () => 0, clear() {} });
  let put = { v: V - 1, phase: 'play', seed: 5, src: 's', sty: 'disco', lineup: [['s', 'disco', 120]], i: 0, total: 2 };
  let now = 1000;
  let finished = false;
  const api = { get: () => put, put: (k, v) => (put = v), now: () => now, players: () => [{ slot: 0 }, { slot: 1 }], settings: { songs: 2 }, random: seeded(3), memory: {}, setDeadline() {}, round() {}, deadline: null, finish: () => (finished = true) };
  beatdrop.resume(api);
  assert.equal(put.v, V, 'old saved state starts over on the new version');
  assert.equal(put.phase, 'show');
  assert.equal(put.sk, SKIP_WAIT, 'it waits for the song list instead of giving up');
  assert.equal(beatdrop.model({ state: { [KEY]: put }, meSlot: 0, players: [] }).skipped, WAIT_TEXT);
  await flush(20);
  assert.ok(log.includes('/api/activity/songs'), 'the host asks for the song list');
  now += SKIP_MS;
  beatdrop.deadline(api);
  assert.equal(finished, false);
  assert.equal(put.phase, 'ready', 'once the list is in, the first song gets its ready step');
  assert.equal(put.total, 2);
  assert.equal(put.lineup.length, 2);
  assert.ok([SID, SID2].includes(put.sid));
  noSongs();
  setSongFetch(songServer({ songs: [] }), { timer: () => 0, clear() {} });
  put = null;
  finished = false;
  beatdrop.resume(api);
  assert.equal(put.sk, SKIP_WAIT);
  await flush(20);
  now += SKIP_MS;
  beatdrop.deadline(api);
  assert.equal(put.sk, SKIP_NONE, 'with no songs after checking it says a song is needed');
  now += SKIP_MS;
  beatdrop.deadline(api);
  assert.equal(finished, true, 'and then ends');
  noSongs();
  setSongFetch(async () => new Promise(() => {}), { timer: () => 0, clear() {} });
  put = null;
  finished = false;
  beatdrop.resume(api);
  for (let i = 0; i < WAIT_TRIES; i += 1) {
    now += SKIP_MS;
    beatdrop.deadline(api);
    assert.equal(finished, false);
    assert.equal(put.sk, SKIP_WAIT);
  }
  now += SKIP_MS;
  beatdrop.deadline(api);
  assert.equal(finished, true, 'a song list that never answers gives up after a few checks');
  noSongs();
});

function trackedAudio(r) {
  const sources = [];
  const gains = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const ctx = {
    state: 'running',
    sampleRate: 8000,
    destination: { connect() {}, disconnect() {} },
    createGain() {
      const g = { gain: param(), cut: false, connect() {}, disconnect() { g.cut = true; } };
      gains.push(g);
      return g;
    },
    createBiquadFilter: () => ({ type: 'lowpass', frequency: param(), connect() {}, disconnect() {} }),
    createOscillator: () => ({ type: 'sine', frequency: param(), connect() {}, start() {}, stop() {} }),
    createBufferSource() {
      const s = { started: null, stopped: false, cut: false, connect() {}, disconnect() { s.cut = true; }, start(...a) { s.started = a; }, stop() { s.stopped = true; } };
      sources.push(s);
      return s;
    },
    resume() {
      return Promise.resolve();
    },
  };
  Object.defineProperty(ctx, 'currentTime', { get: () => r.clock.now() / 1000 + 7, configurable: true });
  class Offline {
    createBuffer(ch, n) {
      return { getChannelData: () => new Float32Array(n) };
    }
    decodeAudioData() {
      const length = 8000 * 70;
      return Promise.resolve({ sampleRate: 8000, length, numberOfChannels: 1, getChannelData: () => new Float32Array(length) });
    }
  }
  const get = async () => ({ ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(64) });
  const songAudio = createSongAudio({ win: { OfflineAudioContext: Offline }, get });
  const live = () => sources.filter((s) => s.started && !s.stopped);
  return { ctx, sources, gains, songAudio, live };
}

async function playingSong(r, audio, opts = {}) {
  const engine = r.engines[0];
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(audio.ctx), win: fakeWin(() => r.clock.now()), storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }), songAudio: audio.songAudio, ...opts });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  await settle(r, 300);
  byKey(view, 'bd-ready').click();
  await settle(r, 400);
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'play');
  await r.clock.advance(st(r).at + 3000 - r.clock.now());
  view.frame();
  assert.equal(audio.live().length, 1, 'the song is playing');
  return view;
}

test('ending the game mid-song stops the music at once and every source is stopped and disconnected', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(1);
  const audio = trackedAudio(r);
  const view = await playingSong(r, audio);
  assert.equal(r.engines[0].lobby.end(), true, 'the host presses End game');
  await settle(r, 50);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  view.update(r.engines[0].snapshot());
  assert.equal(audio.live().length, 0, 'no song keeps playing after End game');
  assert.ok(audio.sources.every((s) => s.stopped && s.cut), 'every song source is stopped and disconnected');
  view.frame();
  assert.equal(audio.live().length, 0, 'nothing starts again');
  view.destroy();
  assert.ok(audio.gains.every((g) => g.cut), 'every gain node is disconnected');
  noSongs();
});

test('the party app closes the Beat Drop view as soon as the host ends the game', async () => {
  const { window } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(1);
  let watching = 0;
  let made = 0;
  const tops = [];
  const root = document.createElement('div');
  document.body.append(root);
  const win = Object.assign(window, {
    document,
    parent: window,
    innerWidth: 1100,
    innerHeight: 700,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }),
    scrollTo: (x, y) => tops.push([x, y]),
    ResizeObserver: class {
      constructor() {
        made += 1;
      }
      observe() {
        watching += 1;
      }
      disconnect() {
        watching -= 1;
      }
    },
  });
  const { mountApp } = await import('../web/activity/js/ui/app.js');
  const app = mountApp({ root, engine: r.engines[0], bridge: { close() {} }, win, juice: false });
  await allReady(r);
  await settle(r, 100);
  assert.equal(r.engines[0].snapshot().room.phase, 'game');
  assert.ok(root.querySelector('.game-beatdrop'), 'the Beat Drop view is on screen');
  assert.ok(made >= 1 && watching >= 1, 'the view is alive');
  assert.equal(r.engines[0].lobby.end(), true);
  await settle(r, 100);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.equal(watching, 0, 'the view was destroyed, so its song and listeners are gone');
  assert.deepEqual(tops.at(-1), [0, 0], 'the results open at the top, not scrolled down to where the highway was');
  app.destroy();
  noSongs();
});

test('hiding the tab, going back to the lobby and closing the activity all stop the music', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(1);
  const audio = trackedAudio(r);
  const view = await playingSong(r, audio);
  document.hidden = true;
  document.visibilityState = 'hidden';
  fire(document, 'visibilitychange');
  assert.equal(audio.live().length, 0, 'a hidden tab stops the song');
  document.hidden = false;
  document.visibilityState = 'visible';
  fire(document, 'visibilitychange');
  await r.clock.advance(16);
  view.frame();
  assert.equal(audio.live().length, 1, 'coming back picks the song up again in time');
  assert.ok(audio.sources.at(-1).started[1] > 2, 'it resumes where the song is now, not from the start');
  assert.equal(r.engines[0].lobby.toLobby(), true, 'the host sends everyone back to the lobby');
  await settle(r, 50);
  assert.equal(r.engines[0].snapshot().room.phase, 'lobby');
  view.update(r.engines[0].snapshot());
  assert.equal(audio.live().length, 0, 'going back to the lobby stops the song');
  view.destroy();
  noSongs();
  const r2 = await songGame(1);
  const audio2 = trackedAudio(r2);
  const view2 = await playingSong(r2, audio2);
  view2.destroy();
  assert.equal(audio2.live().length, 0, 'closing the activity mid-song stops it');
  assert.ok(audio2.sources.every((s) => s.stopped && s.cut));
  assert.ok(audio2.gains.every((g) => g.cut));
  noSongs();
});

test('the view: uploaded songs load on the ready card, play on the shared clock and the results show the credit', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(1, { difficulty: 'expert' });
  const engine = r.engines[0];
  const s = st(r);
  const { ctx } = fakeAudio();
  Object.defineProperty(ctx, 'currentTime', { get: () => r.clock.now() / 1000 + 7, configurable: true });
  const fake = fakeSongAudio();
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(ctx), win: fakeWin(() => r.clock.now()), storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }), songAudio: fake });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  await settle(r, 300);
  assert.equal(fake.loads.length, 1);
  assert.deepEqual(fake.loads[0], { url: `/song-audio/${s.sid}.mp3`, from: 10, len: 40 });
  assert.ok(st(r).ld.includes(engine.snapshot().meSlot), 'the view reports the song as loaded');
  const text = () => all(view.el).map((n) => n.textContent || '');
  assert.ok(text().includes(`Song: ${s.sid === SID ? 'Night Test' : 'Second Test'} - The Testers`));
  assert.ok(text().includes('Credit: Made by me'));
  assert.ok(text().some((x) => x.startsWith('Song loaded.')));
  assert.ok(view.el.querySelector('.bd-load-fill'));
  byKey(view, 'bd-ready').click();
  await settle(r, 400);
  const p = st(r);
  assert.equal(p.phase, 'play');
  view.update(engine.snapshot());
  assert.ok(view.local.song);
  assert.equal(fake.plays.length, 1, 'the song is scheduled on the audio clock');
  assert.equal(fake.plays[0].len, 40);
  assert.equal(fake.plays[0].ctx, ctx);
  assert.equal(typeof fake.plays[0].zero, 'number');
  assert.equal('start' in view.player, false, 'no built-in music under a real song');
  const song = songOfState(p);
  const hold = song.notes.find((n) => n.e && n.t > 3000);
  assert.ok(hold, 'Expert has a hold to play');
  await r.clock.advance(p.at + hold.t - r.clock.now());
  view.press(hold.l, p.at + hold.t);
  assert.equal(view.judge.holding[hold.l], song.notes.indexOf(hold));
  view.frame();
  assert.ok(all(view.el).find((n) => n.dataset && n.dataset.key === `bd-lane-${hold.l}`).classList.contains('is-hold'), 'the held pad glows');
  await r.clock.advance(hold.e - hold.t);
  assert.equal(view.release(hold.l, p.at + hold.e), true, 'letting go judges the tail');
  assert.equal(view.judge.holding[hold.l], -1);
  assert.equal(view.judge.tail[song.notes.indexOf(hold)], 1, 'held to the end is Perfect');
  await r.clock.advance(endOf(p) - r.clock.now());
  engine.act({ type: 'done', n: p.n, v: perfectRun(song).final() });
  await settle(r, 400);
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'show');
  assert.ok(fake.stops > 0, 'the song stops when the round ends');
  assert.ok(text().includes(`${st(r).tt[0]} - The Testers`));
  assert.ok(text().includes('Credit: Made by me'));
  view.destroy();
  assert.equal(fake.gone, true);
  noSongs();
});

test('the view: a song that will not load says so, offers Try again, reports both ways and spectates with a clear message', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(2);
  const engine = r.engines[0];
  const me = engine.snapshot().meSlot;
  const fake = fakeSongAudio({ fail: true });
  const view = makeView(engine, fakeWin(() => r.clock.now()), { songAudio: fake });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  await settle(r, 300);
  assert.deepEqual(st(r).lf, [me]);
  assert.ok(all(view.el).some((n) => (n.textContent || '').startsWith(`${LOAD_FAIL_TEXT}.`)));
  const retry = byKey(view, 'bd-load-retry');
  assert.ok(retry);
  fake.fail = false;
  retry.click();
  await settle(r, 300);
  assert.deepEqual(st(r).ld, [me]);
  assert.deepEqual(st(r).lf, []);
  assert.equal(byKey(view, 'bd-load-retry'), null);
  view.destroy();
  const r2 = await songGame(2, { songs: 2 });
  const host = r2.engines[0];
  const other = r2.engines[1];
  const sad = makeView(host, fakeWin(() => r2.clock.now()), { songAudio: fakeSongAudio({ fail: true }) });
  host.on('change', (snap) => sad.update(snap));
  sad.update(host.snapshot());
  await settle(r2, 300);
  const s2 = st(r2);
  other.act({ type: 'loaded', n: s2.n });
  other.act({ type: 'ready', n: s2.n });
  host.act({ type: 'ready', n: s2.n });
  await settle(r2, 300);
  assert.equal(st(r2).phase, 'play');
  sad.update(host.snapshot());
  assert.equal(sad.judge, null, 'they do not play this song');
  assert.equal(sad.local.demo, true);
  assert.ok(all(sad.el).some((n) => n.textContent === LOAD_FAIL_TEXT), 'and are told why');
  sad.destroy();
  noSongs();
});

test('the view: a skipped round says so and moves on', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(1, { songs: 2 });
  const engine = r.engines[0];
  const view = makeView(engine, fakeWin(() => r.clock.now()), { songAudio: fakeSongAudio({ fail: true }) });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  await settle(r, 300);
  engine.act({ type: 'ready', n: st(r).n });
  await settle(r, 300);
  assert.equal(st(r).phase, 'show');
  view.update(engine.snapshot());
  const texts = all(view.el).map((n) => n.textContent || '');
  assert.ok(texts.includes(SKIP_TEXT));
  assert.ok(all(view.el).some((n) => n.classList && n.classList.contains('bd-upnext')), 'and shows what is next');
  assert.equal(all(view.el).some((n) => n.classList && n.classList.contains('bd-me')), false);
  view.destroy();
  noSongs();
});

test('the song player decodes a short slice, schedules it with a fade and only re-syncs on real drift', async () => {
  const made = [];
  const buf = (ch, n, rate) => {
    const data = Array.from({ length: ch }, () => new Float32Array(n));
    return { sampleRate: rate, length: n, numberOfChannels: ch, getChannelData: (c) => data[c], copyToChannel(src, c) { data[c].set(src); } };
  };
  class Offline {
    constructor(ch, len, rate) {
      made.push(rate);
      this.rate = rate;
    }
    decodeAudioData() {
      return Promise.resolve(buf(2, this.rate * 120, this.rate));
    }
    createBuffer(ch, n, rate) {
      return buf(ch, n, rate);
    }
  }
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const chunks = [new Uint8Array(1000), new Uint8Array(500)];
    return { ok: true, headers: { get: () => '1500' }, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
  };
  const audio = createSongAudio({ win: { OfflineAudioContext: Offline }, get });
  const seen = [];
  const entry = await audio.load(`/song-audio/${SID}.mp3`, { from: 30, len: 45, onProgress: (p) => seen.push(p) });
  assert.deepEqual(made, [32000], 'decoded at a low rate to save memory');
  assert.equal(entry.buf.length, 32000 * 47, 'only the section plus a little is kept');
  assert.ok(Math.abs(entry.base) < 1e-9);
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(seen.some((p) => p > 0 && p < 1));
  assert.equal(await audio.load(`/song-audio/${SID}.mp3`, { from: 30, len: 45 }), entry);
  assert.equal(asked.length, 1, 'a loaded slice is cached');
  assert.equal(audio.ready(`/song-audio/${SID}.mp3`, 30, 45), entry);
  await audio.load(`/song-audio/${SID2}.mp3`, { from: 0, len: 45 });
  await audio.load(`/song-audio/${SID3}.mp3`, { from: 0, len: 45 });
  assert.equal(audio.cached, 2, 'at most two songs stay in memory');
  const starts = [];
  const ramps = [];
  const ctx = { currentTime: 100, destination: {}, createBufferSource: () => ({ connect() {}, disconnect() {}, stop() {}, start: (...a) => starts.push(a) }), createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime: (v, t) => ramps.push([v, t]) }, connect() {}, disconnect() {} }) };
  const e2 = audio.ready(`/song-audio/${SID3}.mp3`, 0, 45);
  assert.equal(audio.play({ ctx, entry: e2, zero: 103, len: 45 }), true);
  assert.deepEqual(starts[0], [103, 0, 45], 'starts exactly on the song clock');
  assert.deepEqual(ramps[0], [0.0001, 148], 'and fades out at the end');
  ctx.currentTime = 110;
  assert.equal(audio.resync(103.1), false, 'small drift is left alone');
  assert.equal(audio.resync(103.5), true);
  assert.deepEqual(starts[1], [110, 6.5, 38.5], 'big drift restarts at the right spot');
  audio.destroy();
  assert.equal(audio.cached, 0);
  await assert.rejects(audio.load(`/song-audio/${SID}.mp3`), /closed/);
  assert.deepEqual(songSpan({ cut: 60000, meta: { url: 'u', start: 20000, off: -150 } }), { url: 'u', from: 19.85, len: 60 });
  const none = createSongAudio({ win: {}, get });
  await assert.rejects(none.load(`/song-audio/${SID}.mp3`), /can not play/);
  const big = createSongAudio({ win: { OfflineAudioContext: Offline }, get: async () => ({ ok: true, headers: { get: () => String(11e6) }, body: null }) });
  await assert.rejects(big.load(`/song-audio/${SID}.mp3`), /too big/);
});

test('the lobby shows a song picker built only from the uploaded songs', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  await useSongs();
  const { createLobby } = await import('../web/activity/js/ui/lobby.js');
  const r = room(2, { join: false });
  await r.clock.advance(500);
  const [host, guest] = r.engines;
  const hostLobby = createLobby({ engine: host, toast() {}, sfx: { play() {} }, store: memStore() });
  const guestLobby = createLobby({ engine: guest, toast() {}, sfx: { play() {} }, store: memStore() });
  host.lobby.pick('beatdrop');
  await r.clock.advance(300);
  hostLobby.update(host.snapshot());
  guestLobby.update(guest.snapshot());
  await flush(20);
  const pick = all(hostLobby.el).find((n) => n.dataset && n.dataset.key === 'set-song');
  assert.ok(pick, 'the host gets a song picker');
  assert.equal(pick.localName, 'select');
  const labels = all(pick).filter((n) => n.localName === 'option').map((n) => n.textContent);
  assert.deepEqual(labels, ['Random song', 'Night Test - The Testers', 'Second Test - The Testers'], 'no built-in option');
  assert.equal(all(hostLobby.el).some((n) => n.dataset && /^set-style/.test(n.dataset.key || '')), false, 'no built-in beat setting');
  const tile = all(hostLobby.el).find((n) => n.dataset && n.dataset.key === 'pick-beatdrop');
  assert.equal(tile.disabled, false, 'the tile is playable');
  assert.ok(all(tile).some((n) => n.textContent === BLURB));
  pick.value = SID2;
  fire(pick, 'change');
  await r.clock.advance(300);
  assert.equal(host.snapshot().settings.song, SID2);
  guestLobby.update(guest.snapshot());
  assert.ok(all(guestLobby.el).some((n) => n.textContent === 'Second Test - The Testers'), 'guests see the pick as text');
  assert.equal(all(guestLobby.el).some((n) => n.dataset && n.dataset.key === 'set-song' && n.localName === 'select'), false);
  assert.equal(host.lobby.setting('song', 'beats'), false, 'the old built-in pick is refused');
  assert.equal(host.lobby.setting('song', 'https://elsewhere'), false);
  noSongs();
});

test('scroll speed is a per player setting that only changes how fast notes fall', async () => {
  assert.equal(cleanSpeed(undefined), 1);
  assert.equal(cleanSpeed('2'), 2);
  assert.equal(cleanSpeed(9), 1);
  assert.equal(stepSpeed(1, 1), 1.25);
  assert.equal(stepSpeed(SPEEDS[0], -1), SPEEDS[0]);
  assert.equal(stepSpeed(SPEEDS[SPEEDS.length - 1], 1), SPEEDS[SPEEDS.length - 1]);
  assert.equal(speedLabel(1.5), '1.5x');
  const mem = new Map();
  const pstore = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(readPrefs(pstore).speed, 1);
  writePrefs(pstore, { ...readPrefs(pstore), speed: 2.5 });
  assert.equal(readPrefs(pstore).speed, 2.5);
  writePrefs(pstore, { ...readPrefs(pstore), speed: 7 });
  assert.equal(readPrefs(pstore).speed, 1);
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1, difficulty: 'hard' });
  const engine = r.engines[0];
  const view = makeView(engine, fakeWin(() => r.clock.now(), false));
  view.update(engine.snapshot());
  const up = byKey(view, 'bd-speed-up');
  assert.ok(up && byKey(view, 'bd-speed-down'));
  fire(up, 'click');
  fire(byKey(view, 'bd-speed-up'), 'click');
  await allReady(r);
  view.update(engine.snapshot());
  assert.ok(Math.abs(view.local.look - lookFor(2, false) / 1.5) < 1e-9);
  view.destroy();
  noSongs();
});

test('players can set their own four lane keys', async () => {
  assert.equal(cleanKeys(['KeyA', 'KeyS', 'KeyK', 'KeyL']).join(), 'KeyA,KeyS,KeyK,KeyL');
  assert.equal(cleanKeys(['KeyA', 'KeyA', 'KeyK', 'KeyL']), null, 'no duplicates');
  assert.equal(cleanKeys(['KeyA', 'Escape', 'KeyK', 'KeyL']), null, 'no blocked keys');
  assert.equal(cleanKeys(['KeyA', 'KeyS']), null);
  assert.deepEqual(bindsFor(null), LANE_KEYS[LANES]);
  assert.equal(keyName('ArrowLeft'), '←');
  assert.equal(keyName('Digit3'), '3');
  assert.equal(laneOfKey({ code: 'KeyS' }, ['KeyA', 'KeyS', 'KeyK', 'KeyL']), 1);
  assert.equal(laneOfKey({ code: 'KeyD' }, ['KeyA', 'KeyS', 'KeyK', 'KeyL']), -1);
  assert.deepEqual(keyLabels(['KeyA', 'Space', 'ArrowUp', 'Semicolon']), ['A', 'Space', '↑', 'Semicolon']);
  const mem = new Map();
  const pstore = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  writePrefs(pstore, { ...readPrefs(pstore), keys: ['KeyA', 'KeyS', 'KeyK', 'KeyL'] });
  assert.deepEqual(readPrefs(pstore).keys, ['KeyA', 'KeyS', 'KeyK', 'KeyL']);
  writePrefs(pstore, { ...readPrefs(pstore), keys: ['KeyA', 'KeyA', 'KeyK', 'KeyL'] });
  assert.equal(readPrefs(pstore).keys, null);
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1, difficulty: 'normal' });
  const engine = r.engines[0];
  const view = makeView(engine, fakeWin(() => r.clock.now(), false));
  view.update(engine.snapshot());
  fire(byKey(view, 'bd-keys-change'), 'click');
  for (const key of ['q', 'w', 'o', 'p']) document.dispatchEvent(new FakeEvent('keydown', { bubbles: true, key }));
  assert.ok(all(view.el).some((n) => n.classList && n.classList.contains('bd-keys-value') && n.textContent === 'Q W O P'), 'the new keys show');
  assert.ok(byKey(view, 'bd-keys-reset'), 'reset shows once keys are custom');
  fire(byKey(view, 'bd-keys-reset'), 'click');
  assert.equal(byKey(view, 'bd-keys-reset'), null);
  view.destroy();
  noSongs();
});

test('How to play opened while watching closes on Skip and on finishing', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await songGame(2);
  const s = st(r);
  const [x, y] = slots(r);
  bySlot(r, x).act({ type: 'loaded', n: s.n });
  bySlot(r, y).act({ type: 'nolo', n: s.n });
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await settle(r, 300);
  assert.equal(st(r).phase, 'play');
  const engine = bySlot(r, y);
  const view = makeView(engine, fakeWin(() => r.clock.now(), false));
  view.update(engine.snapshot());
  const tuts = () => all(view.el).filter((n) => n.classList && n.classList.contains('bd-tut')).length;
  fire(byKey(view, 'bd-spec-how'), 'click');
  assert.equal(tuts(), 1, 'the tutorial opens while watching');
  fire(byKey(view, 'bd-tut-skip'), 'click');
  assert.equal(tuts(), 0, 'Skip closes it');
  view.update(engine.snapshot());
  assert.equal(tuts(), 0, 'and it stays closed');
  view.destroy();
  noSongs();
});
