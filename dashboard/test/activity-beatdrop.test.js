import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import beatdrop, { KEY, READY_MS, LEAD_MS, SHOW_MS, END_GRACE_MS, POINT_DIV, lineup, checkProgress, checkFinal, songOfState } from '../web/activity/js/games/beatdrop.js';
import { STYLES, DIFFS, LANES, WINDOWS, VALUES, MULT_MAX, buildSong, songFor, createRun, boundFor, prefixMax, maxScore, multOf, judgeOf, stepAt, accuracy, gradeOf, notesBefore, lastNoteAt, INTRO_BARS } from '../web/activity/js/games/beatchart.js';
import { createBeatdropView, calibrate, readOffset, writeOffset, laneOfKey, noteY, footText, OFFSET_KEY, OFFSET_MAX, CAL_BEATS } from '../web/activity/js/views/beatdrop.js';
import { createBeatPlayer, soundNote, midiHz } from '../web/activity/js/views/beatsynth.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const FILES = ['js/games/beatchart.js', 'js/games/beatdrop.js', 'js/views/beatdrop.js', 'js/views/beatsynth.js', 'css/beatdrop.css'];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function slots(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [beatdrop] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('beatdrop'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function allReady(r) {
  const s = st(r);
  for (const e of r.engines) e.act({ type: 'ready', n: s.n });
  await r.clock.advance(300);
}

function perfectRun(song) {
  const run = createRun(song);
  for (const n of song.notes) run.press(n.l, n.t + 0.01);
  run.tick(song.dur + 5);
  return run.final();
}

function fakeAudio() {
  const made = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(), Q: param() });
  const ctx = {
    state: 'running',
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

function fakeWin() {
  const timers = [];
  return { timers, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, performance: { now: () => 1000 } };
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

test('the game is a quick rhythm game with short defaults and clean text', () => {
  assert.equal(beatdrop.id, 'beatdrop');
  assert.equal(beatdrop.category, 'quick');
  assert.equal(beatdrop.emoji, '🥁');
  const def = (id) => beatdrop.settings.find((s) => s.id === id).default;
  assert.equal(def('difficulty'), 'normal');
  assert.equal(def('length'), 60);
  assert.equal(def('songs'), 2);
  assert.equal(def('style'), 'mix');
  for (const re of BANNED) assert.doesNotMatch(`${beatdrop.name} ${beatdrop.blurb} ${STYLES.map((s) => s.name).join(' ')}`, re);
  assert.ok(STYLES.length >= 4);
  assert.equal(new Set(STYLES.map((s) => s.bpm)).size, STYLES.length, 'every style has its own tempo');
});

test('the source files have no comments, inline styles, html injection or frame loops of their own', () => {
  for (const f of FILES) {
    const src = readFileSync(new URL(`../web/activity/${f}`, import.meta.url), 'utf8');
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, `${f} has a comment`);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText', 'style=', 'requestAnimationFrame', 'url(', '<audio', 'fetch(']) assert.equal(src.includes(bad), false, `${f}: ${bad}`);
    assert.doesNotMatch(src, /\.(mp3|ogg|wav|m4a|flac)\b/i, `${f} loads a recording`);
    for (const re of BANNED) assert.doesNotMatch(src, re, f);
  }
});

test('the same seed always builds the same chart, and harder songs have more notes', () => {
  for (const s of STYLES) {
    const counts = DIFFS.map((d) => buildSong(4242, s.id, d.id, 60).notes.length);
    assert.ok(counts[0] < counts[1] && counts[1] < counts[2], `${s.id}: ${counts}`);
    for (const d of DIFFS) {
      const a = buildSong(99, s.id, d.id, 60);
      const b = buildSong(99, s.id, d.id, 60);
      assert.deepEqual(a.notes, b.notes);
      assert.notDeepEqual(a.notes, buildSong(100, s.id, d.id, 60).notes);
      assert.ok(a.dur >= 55 && a.dur <= 75, `${s.id} ${a.dur}`);
      assert.ok(a.notes.every((n) => n.l >= 0 && n.l < LANES && n.t >= INTRO_BARS * a.bar - 1e-3 && n.t < a.dur));
      const times = [...new Set(a.notes.map((n) => n.t))];
      for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= d.gap - 1e-3, `${s.id}/${d.id} gap ${times[i] - times[i - 1]}`);
      const rate = a.notes.length / a.dur;
      assert.ok(rate > d.rate * 0.5 && rate < d.rate * 1.4, `${s.id}/${d.id} rate ${rate}`);
    }
  }
  assert.ok(buildSong(5, 'pop', 'normal', 90).notes.length > buildSong(5, 'pop', 'normal', 45).notes.length);
  assert.equal(songFor(5, 'pop', 'normal', 60), songFor(5, 'pop', 'normal', 60));
});

test('the music steps follow the chart: kick, snare, bass and chords from the style patterns', () => {
  const song = buildSong(17, 'house', 'normal', 60);
  const verse = INTRO_BARS * 16;
  const evs = Array.from({ length: 16 }, (_, i) => stepAt(song, verse + i));
  assert.deepEqual(evs.filter((e) => e.kick).map((e) => e.k % 16), [0, 4, 8, 12]);
  assert.deepEqual(evs.filter((e) => e.snare).map((e) => e.k % 16), [4, 12]);
  assert.ok(evs[0].chord && evs[0].chord.length === 3);
  assert.ok(evs.some((e) => e.bass !== null));
  assert.equal(stepAt(song, 0).snare, false, 'the intro has no snare');
  assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
});

test('judging: windows, combo multiplier and the perfect score', () => {
  assert.equal(judgeOf(0), 'perfect');
  assert.equal(judgeOf(WINDOWS.perfect + 0.01), 'great');
  assert.equal(judgeOf(-WINDOWS.great - 0.01), 'good');
  assert.equal(judgeOf(WINDOWS.good + 0.01), null);
  assert.deepEqual([0, 9, 10, 25, 30, 500].map(multOf), [1, 1, 2, 3, 4, MULT_MAX]);
  const song = buildSong(321, 'pop', 'normal', 60);
  const fin = perfectRun(song);
  assert.equal(fin.p, song.notes.length);
  assert.equal(fin.c, song.notes.length);
  assert.equal(fin.s, maxScore(song));
  assert.equal(boundFor(fin.p, 0, 0, fin.c), fin.s);
  const run = createRun(song);
  const [a, b] = song.notes;
  const ev = run.press(a.l, a.t + 0.07);
  assert.equal(ev[ev.length - 1].k, 'great');
  assert.equal(run.stats.s, VALUES.great);
  const missed = run.tick(b.t + 0.5);
  assert.ok(missed.some((x) => x.k === 'miss'));
  assert.equal(run.stats.cur, 0);
  const mash = createRun(song);
  let out = [];
  for (let i = 0; i < 5; i += 1) out = out.concat(mash.press(0, 0.1 + i * 0.05));
  assert.ok(out.some((x) => x.k === 'mash'), 'mashing with no notes resets the combo');
  const late = createRun(song, { from: 20 });
  assert.equal(late.stats.k, notesBefore(song, 20));
  assert.equal(accuracy([10, 0, 0, 0]), 100);
  assert.equal(accuracy([0, 0, 0, 4]), 0);
  assert.equal(gradeOf(99, true), 'S');
  assert.equal(gradeOf(99, false), 'A');
});

test('the score bound is never below a real run, so honest players are never clamped', () => {
  const song = buildSong(77, 'rush', 'hard', 60);
  const rnd = seeded(9);
  for (let trial = 0; trial < 30; trial += 1) {
    const run = createRun(song);
    for (const n of song.notes) {
      const roll = rnd();
      if (roll < 0.15) continue;
      run.press(n.l, n.t + (rnd() - 0.5) * 0.24);
    }
    run.tick(song.dur + 5);
    const f = run.final();
    assert.equal(f.p + f.g + f.o + f.m + f.k, song.notes.length);
    assert.ok(f.s <= boundFor(f.p, f.g, f.o, f.c), `trial ${trial}`);
    assert.ok(boundFor(f.p, f.g, f.o, f.c) <= maxScore(song));
  }
});

test('the host clamps progress and rejects impossible final stats', () => {
  const song = buildSong(55, 'pop', 'normal', 60);
  const n = song.notes.length;
  assert.equal(checkProgress(song, 0, { s: 10, c: 0, j: 50 }), null, 'cannot judge notes that have not arrived');
  const row = checkProgress(song, 30, { s: 99999999, c: 3, j: 5 });
  assert.equal(row[0], prefixMax(5));
  assert.equal(checkProgress(song, 30, { s: 10, c: 9, j: 5 }), null, 'combo longer than notes judged');
  assert.equal(checkFinal(song, 0, { s: 1, c: 1, p: 1, g: 0, o: 0, m: 0, k: 0 }), null, 'counts must add up');
  assert.equal(checkFinal(song, 0, { s: 1, c: 5, p: 2, g: 0, o: 0, m: n - 2, k: 0 }), null);
  assert.equal(checkFinal(song, 0, { s: -5, c: 0, p: 0, g: 0, o: 0, m: n, k: 0 }), null);
  assert.equal(checkFinal(song, 0, { s: 1.5, c: 0, p: 0, g: 0, o: 0, m: n, k: 0 }), null);
  const fin = checkFinal(song, 0, { s: 10_000_000, c: n, p: n, g: 0, o: 0, m: 0, k: 0 });
  assert.equal(fin.sc[0], maxScore(song));
  const lazy = checkFinal(song, 0, { s: 0, c: 0, p: 0, g: 0, o: 0, m: 0, k: n });
  assert.equal(lazy.hs[4], notesBefore(song, 3), 'skips are only allowed before joining');
  assert.equal(lazy.hs[3], n - notesBefore(song, 3));
  const gone = notesBefore(song, 27);
  assert.ok(gone > 0);
  assert.equal(checkFinal(song, 30, { s: 10_000_000, c: n, p: n, g: 0, o: 0, m: 0, k: 0 }), null, 'a late joiner cannot claim notes from before they joined');
  const late = checkFinal(song, 30, { s: 10_000_000, c: n - gone, p: n - gone, g: 0, o: 0, m: gone, k: 0 });
  assert.equal(late.sc[0], boundFor(n - gone, 0, 0, n - gone));
  const prog = checkProgress(song, 40, { s: 99999999, c: 3, j: notesBefore(song, 40) }, 30);
  assert.equal(prog[0], prefixMax(notesBefore(song, 40) - gone));
});

test('a song runs ready, play and results, with points from the score', async () => {
  const r = await startGame(3, { length: 45, songs: 1 });
  assert.equal(st(r).phase, 'ready');
  assert.ok(st(r).ends - r.engines[0].now() <= READY_MS);
  const m0 = beatdrop.model(r.engines[1].snapshot());
  assert.equal(m0.playing, true);
  await allReady(r);
  const s = st(r);
  assert.equal(s.phase, 'play');
  assert.ok(Math.abs(s.at - r.engines[0].now() - LEAD_MS) < 400);
  const song = songOfState(s);
  const [a, b, c] = slots(r);
  await r.clock.advance(s.at - r.engines[0].now() + 20000);
  bySlot(r, a).act({ type: 'prog', n: s.n, s: 999999, c: 2, j: 3 });
  await r.clock.advance(200);
  assert.equal(st(r).sc[a][0], prefixMax(3));
  await r.clock.advance(Math.ceil(lastNoteAt(song) * 1000) - 20000 + 500);
  const fin = perfectRun(song);
  bySlot(r, a).act({ type: 'done', n: s.n, ...fin });
  const half = { s: 500, c: 5, p: 10, g: 0, o: 0, m: song.notes.length - 10, k: 0 };
  bySlot(r, b).act({ type: 'done', n: s.n, ...half });
  bySlot(r, b).act({ type: 'done', n: s.n, ...fin });
  await r.clock.advance(200);
  assert.equal(st(r).phase, 'play');
  bySlot(r, c).act({ type: 'done', n: s.n, s: 0, c: 0, p: 0, g: 0, o: 0, m: song.notes.length, k: 0 });
  await r.clock.advance(300);
  const after = st(r);
  assert.equal(after.phase, 'show');
  assert.deepEqual(after.res.map((x) => x.s), [a, b, c]);
  assert.equal(after.res[0].fc, 1);
  assert.equal(after.res[0].gr, 'S');
  assert.equal(after.res[1].sc, 500, 'the second, worse report was ignored');
  assert.equal(after.res[0].p, Math.round(maxScore(song) / POINT_DIV));
  assert.ok(r.hub.state.scores.g[a] >= after.res[0].p);
  const m = beatdrop.model(bySlot(r, a).snapshot());
  assert.equal(m.mine.place, 1);
  assert.equal(m.results[0].isMe, true);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state.room.phase, 'results');
});

test('nobody reporting still ends the song and multi-song games roll on', async () => {
  const r = await startGame(2, { songs: 2, length: 45, style: 'chill' });
  assert.equal(st(r).ls.length, 2);
  await r.clock.advance(READY_MS + 300);
  const s = st(r);
  assert.equal(s.phase, 'play');
  await r.clock.advance(s.ends - r.engines[0].now() + 300);
  assert.equal(st(r).phase, 'show');
  await r.clock.advance(SHOW_MS + 300);
  const two = st(r);
  assert.equal(two.phase, 'play');
  assert.equal(two.i, 1);
  assert.equal(two.sty, 'chill');
  assert.notEqual(two.seed, s.seed);
  await r.clock.advance(two.ends - r.engines[0].now() + 300);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state.room.phase, 'results');
});

test('late joiners play the rest of the song, very late ones wait for the next', async () => {
  const r = await startGame(2, { length: 60, songs: 2 });
  await allReady(r);
  const s = st(r);
  await r.clock.advance(s.at - r.engines[0].now() + 10000);
  const e = r.add(3);
  await r.clock.advance(800);
  const slot = e.snapshot().meSlot;
  assert.ok(st(r).in.includes(slot));
  assert.ok(st(r).jt[slot] >= 10000);
  const song = songOfState(st(r));
  const lazy = checkFinal(song, st(r).jt[slot] / 1000, { s: 0, c: 0, p: 0, g: 0, o: 0, m: 0, k: song.notes.length });
  assert.ok(lazy.hs[4] > 0);
  await r.clock.advance(st(r).ends - END_GRACE_MS - r.engines[0].now() - 5000);
  const e2 = r.add(4);
  await r.clock.advance(800);
  const s2 = e2.snapshot().meSlot;
  assert.ok(st(r).wait.includes(s2));
  assert.equal(beatdrop.model(e2.snapshot()).waiting, true);
  await r.clock.advance(st(r).ends - r.engines[0].now() + 300);
  await r.clock.advance(SHOW_MS + 300);
  assert.ok(st(r).in.includes(s2), 'they play the next song');
});

test('the host leaving mid-song keeps the same song going', async () => {
  const r = await startGame(3, { length: 45 });
  await allReady(r);
  const s = st(r);
  await r.clock.advance(5000);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'play');
  assert.equal(after.n, s.n);
  assert.equal(after.at, s.at);
  assert.equal(after.seed, s.seed);
  const host = r.engines[1];
  await r.clock.advance(after.ends - host.now() + 500);
  assert.equal(st(r).phase, 'show');
});

test('shared state stays small with a full room', async () => {
  const r = await startGame(8, { length: 90, difficulty: 'hard' });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  await r.clock.advance(s.at - r.engines[0].now() + Math.ceil(lastNoteAt(song) * 1000) + 300);
  const fin = perfectRun(song);
  for (const e of r.engines.slice(0, 7)) e.act({ type: 'done', n: s.n, ...fin, s: fin.s - 1 });
  await r.clock.advance(300);
  assert.ok(jsonBytes(st(r)) < MAX_VALUE_BYTES / 2, `${jsonBytes(st(r))} bytes`);
  r.engines[7].act({ type: 'done', n: s.n, ...fin });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'show');
  assert.ok(jsonBytes(st(r)) < MAX_VALUE_BYTES / 2, `${jsonBytes(st(r))} bytes`);
});

test('lineups shuffle every style before repeating', () => {
  const rnd = seeded(3);
  const ls = lineup('mix', STYLES.length, rnd);
  assert.equal(new Set(ls).size, STYLES.length);
  assert.deepEqual(lineup('funk', 3, rnd), ['funk', 'funk', 'funk']);
});

test('the synth plays original loops locally and follows the sound switch', () => {
  const { ctx, made } = fakeAudio();
  const s = fakeSfx(ctx);
  const win = fakeWin();
  const p = createBeatPlayer({ sfx: s, win });
  const song = buildSong(8, 'funk', 'normal', 45);
  assert.equal(p.start(song, 10_000, 10_000), true);
  assert.equal(p.playing, true);
  assert.ok(made.length > 0, 'the first beats are scheduled');
  assert.ok(made.every((o) => o.at >= 5 - 1e-9 && o.at <= 5 + 0.4));
  assert.ok(win.timers.length > 0, 'it keeps scheduling ahead');
  s.enabled = false;
  s.fire();
  assert.equal(p.playing, false, 'muting stops the music');
  assert.equal(p.start(song, 0, 0), false);
  assert.equal(p.status(), 'off');
  assert.match(soundNote('off'), /Turn sound on to play to the music/);
  assert.equal(soundNote('ok'), null);
  s.enabled = true;
  made.length = 0;
  assert.equal(p.start(song, 0, 30_000), true, 'joining mid-song picks up where the song is');
  assert.ok(made.length > 0);
  assert.equal(p.click(0.1), true);
  const none = createBeatPlayer({ sfx: { enabled: true, volume: 0.5, context: null, unlock() {} }, win: {} });
  assert.equal(none.status(), 'none');
  assert.equal(none.start(song, 0, 0), false);
  p.destroy();
});

test('calibration takes the median tap offset and storage failures are harmless', () => {
  const beats = Array.from({ length: CAL_BEATS }, (_, i) => 1000 + i * 600);
  assert.deepEqual(calibrate(beats.map((b) => b + 40), beats), { ms: 40, n: CAL_BEATS });
  assert.equal(calibrate(beats.slice(0, 3).map((b) => b + 40), beats), null, 'too few taps');
  assert.equal(calibrate(beats.map((b) => b + 300), beats), null);
  const odd = beats.map((b, i) => b + (i === 2 ? 250 : 30));
  assert.equal(calibrate(odd, beats).ms, 30);
  const store = memStore();
  assert.equal(writeOffset(store, 5000), OFFSET_MAX);
  assert.equal(readOffset(store), OFFSET_MAX);
  assert.equal(readOffset(memStore({ [OFFSET_KEY]: 'abc' })), 0);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readOffset(broken), 0);
  assert.equal(writeOffset(broken, 20), 20);
  assert.equal(readOffset(null), 0);
  assert.equal(laneOfKey({ code: 'KeyJ', key: 'j' }), 2);
  assert.equal(laneOfKey({ key: 'K' }), 3);
  assert.equal(laneOfKey({ key: 'x' }), -1);
  assert.equal(noteY(10, 10, 1.4, 500), 500);
  assert.ok(noteY(11, 10, 1.4, 500) < 500);
});

test('the view: ready card, lanes you can play, a live board and results', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { length: 45 });
  const { ctx } = fakeAudio();
  const engine = r.engines[0];
  const store = memStore({ [OFFSET_KEY]: '0' });
  const view = createBeatdropView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(ctx), win: fakeWin(), storage: store });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  const keys = () => all(view.el).map((n) => n.dataset && n.dataset.key).filter(Boolean);
  assert.ok(keys().includes('bd-ready'));
  assert.ok(keys().includes('bd-cal-open'));
  all(view.el).find((n) => n.dataset && n.dataset.key === 'bd-ready').click();
  r.engines[1].act({ type: 'ready', n: st(r).n });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'play');
  view.update(engine.snapshot());
  const s = st(r);
  const song = songOfState(s);
  await r.clock.advance(s.at - engine.now());
  for (const n of song.notes) {
    const wait = s.at + n.t * 1000 - engine.now();
    if (wait > 0) await r.clock.advance(wait);
    view.press(n.l);
    if (engine.now() - (s.at + n.t * 1000) > WINDOWS.perfect * 1000) break;
  }
  assert.ok(view.run.stats.p > 0, 'hits land');
  await r.clock.advance(s.at + lastNoteAt(song) * 1000 + 600 - engine.now());
  view.frame();
  await r.clock.advance(300);
  assert.ok(Array.isArray(st(r).sc[engine.snapshot().meSlot]) && st(r).sc[engine.snapshot().meSlot][3] === 1, 'the final score was sent');
  assert.ok(all(view.el).some((n) => n.getAttribute && n.getAttribute('data-profile-id')), 'the board shows faces');
  await r.clock.advance(st(r).ends - engine.now() + 300);
  view.update(engine.snapshot());
  assert.equal(st(r).phase, 'show');
  assert.ok(all(view.el).some((n) => n.classList && n.classList.contains('beatdrop-res-row')));
  assert.match(footText(beatdrop.model(engine.snapshot())), /topped the song/);
  for (const n of all(view.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  view.destroy();
});

test('calibrating in the view saves the offset', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1);
  const engine = r.engines[0];
  const store = memStore();
  let t = 1000;
  const win = { ...fakeWin(), performance: { now: () => t } };
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win, storage: store });
  view.update(engine.snapshot());
  view.calOpen();
  view.calStart();
  for (let i = 0; i < 10; i += 1) {
    t = 1000 + 700 + i * 600 + 25;
    if (i >= 2) view.calTap();
  }
  const got = view.calFinish();
  assert.equal(got.ms, 25);
  assert.equal(store.data.get(OFFSET_KEY), '25');
  assert.equal(view.offset, 25);
  view.destroy();
});
