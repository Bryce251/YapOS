import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { FUN, ROOM } from '../web/activity/js/engine.js';
import beatdrop, { KEY, READY_MS, READY_NEXT_MS, READY_MAX_MS, LEAD_MS, SHOW_MS, END_GRACE_MS, PROG_GAP_MS, BLURB, GOAL, FLAG_PLAYED, FLAG_SAT, FLAG_LEFT, lineup, checkProgress, checkFinal, songOfState, pointsFor, standings } from '../web/activity/js/games/beatdrop.js';
import { STYLES, DIFFS, INTRO_BARS, STEPS, buildSong, songFor, bpmFor, lanesFor, windowsFor, lookFor, createJudge, judge, scoreOf, accOf, tierOf, gradeOf, notesBefore, lastNoteAt, sectionRate, stepAt, stepTime, STRAY_MAX, STRAY_MS, MAX_SCORE } from '../web/activity/js/games/beatchart.js';
import { createBeatdropView, createSongClock, eventTime, readPrefs, writePrefs, laneOfKey, keyLabels, heightFor, rivalLine, tendencyOf, footText, OFFSET_KEY, PLAY_SHEET, LANE_KEYS } from '../web/activity/js/views/beatdrop.js';
import { createBeatPlayer, soundNote, midiHz } from '../web/activity/js/views/beatsynth.js';
import { timingFrom, tutorialNotes, clampOffset, createTutorial, TIMING_MAX } from '../web/activity/js/views/beattut.js';
import { createBeatDraw, laneStyle, noteY, judgeY, gemSize, gemScale, laneGapMs, GEM_MIN_SCALE, HIT_Y } from '../web/activity/js/views/beatdraw.js';
import { jsonBytes } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const JS_FILES = ['js/games/beatchart.js', 'js/games/beatdrop.js', 'js/views/beatdrop.js', 'js/views/beatsynth.js', 'js/views/beatdraw.js', 'js/views/beattut.js'];
const CSS_FILES = ['css/beatdrop.css', 'css/beatdrop-play.css'];
const ACT = new URL('../web/activity/', import.meta.url);

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

async function startGame(n = 3, settings = {}, games = [beatdrop]) {
  const r = room(n, { games });
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

async function playAlong(r, s, untilMs, plan) {
  const song = songOfState(s);
  while (r.clock.now() < untilMs && st(r).phase === 'play' && st(r).n === s.n) {
    const sec = (r.clock.now() - s.at) / 1000;
    const due = Math.max(0, notesBefore(song, sec - 0.2));
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
  for (const n of song.notes) j.press(n.l, n.t + 5);
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
  assert.equal(def('style'), 'mix');
  assert.equal(beatdrop.blurb, BLURB);
  assert.equal(BLURB, 'Tap notes on the beat. Long streaks score big.');
  assert.ok(BLURB.length <= 60);
  assert.match(GOAL, /Tap each note as it lands on its ring/);
  assert.deepEqual(beatdrop.settings.find((s) => s.id === 'difficulty').options.map((o) => o.label), ['Chill - 2 lanes', 'Normal - 3 lanes', 'Hard - 4 lanes']);
  for (const re of BANNED) assert.doesNotMatch(`${beatdrop.name} ${beatdrop.blurb} ${GOAL} ${STYLES.map((s) => s.name).join(' ')}`, re);
  assert.equal(new Set(STYLES.map((s) => s.bpm)).size, STYLES.length, 'every style has its own tempo');
});

test('the source files have no comments, inline styles, html injection, frame loops or recordings', () => {
  for (const f of JS_FILES.concat(CSS_FILES)) {
    const src = read(f);
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, `${f} has a comment`);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText', 'style=', 'requestAnimationFrame', 'url(', '<audio', 'fetch(']) assert.equal(src.includes(bad), false, `${f}: ${bad}`);
    assert.doesNotMatch(src, /\.(mp3|ogg|wav|m4a|flac)\b/i, `${f} loads a recording`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, `${f} sets a style directly`);
    for (const re of BANNED) assert.doesNotMatch(src, re, f);
    if (f !== 'js/views/beatdrop.js') assert.equal(/localStorage|setItem\(/.test(src), false, `${f} touches storage`);
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
  assert.ok(read('css/beatdrop.css').length <= 3000, `beatdrop.css is ${read('css/beatdrop.css').length} bytes`);
  assert.ok(read('css/beatdrop-play.css').length <= 11000);
  assert.ok(read('js/views/beatdrop.js').includes('/activity/css/beatdrop-play.css'));
  assert.equal(PLAY_SHEET, '/activity/css/beatdrop-play.css');
  assert.equal(read('index.html').includes('beatdrop-play.css'), false, 'the play sheet is not in the first load');
  assert.match(read('js/views/beatdrop.js'), /sharedLoop\(\)/);
});

test('charts are deterministic and follow the lane, gap, chord, settle-in and density rules', () => {
  DIFFS.forEach((d, df) => {
    const lanes = lanesFor(df);
    assert.equal(lanes, d.lanes);
    let total = 0;
    let target = 0;
    for (let s = 1; s <= 200; s += 1) {
      const style = STYLES[s % STYLES.length];
      const seed = (s * 2654435761) % 2147483646 || 1;
      const song = buildSong(seed, style.id, df, 60, bpmFor(style.id, df));
      const label = `${d.id}/${style.id}/${seed}`;
      const last = new Array(lanes).fill(-Infinity);
      const chordBars = new Map();
      let runLane = -1;
      let run = 0;
      const barMs = song.bar * 1000;
      for (let i = 0; i < song.notes.length; i += 1) {
        const n = song.notes[i];
        assert.ok(Number.isInteger(n.t), label);
        assert.ok(n.l >= 0 && n.l < lanes, `${label} lane ${n.l}`);
        assert.ok(n.t - last[n.l] >= d.gap, `${label} gap ${n.t - last[n.l]}`);
        last[n.l] = n.t;
        const bar = Math.floor((n.t + 1) / barMs);
        assert.ok(bar < song.bars - 1, `${label} has a note in the final bar`);
        if (i > 0 && song.notes[i - 1].t === n.t) {
          assert.equal(df, 2, `${label} chords only on Hard`);
          assert.equal(song.plan[bar].sec, 'drop', `${label} chords only in drops`);
          assert.ok(Math.abs(n.t - bar * barMs) <= 1, `${label} chords sit on the downbeat`);
          chordBars.set(bar, (chordBars.get(bar) || 0) + 1);
          assert.ok(chordBars.get(bar) <= 1, `${label} at most one chord per bar`);
          continue;
        }
        if (n.l === runLane) run += 1;
        else {
          runLane = n.l;
          run = 1;
        }
        if (df < 2) assert.ok(run < 4, `${label} has 4 in a row`);
      }
      const settle = song.notes.filter((n) => n.t < INTRO_BARS * barMs - 1);
      assert.equal(settle.length, INTRO_BARS * 4, `${label} settle-in is one note per beat`);
      settle.forEach((n, q) => {
        assert.equal(n.t, Math.round(q * song.beat * 1000));
        assert.equal(n.l, q % 2 === 0 ? 0 : lanes - 1);
      });
      for (let b = INTRO_BARS; b < song.bars - 1; b += 1) target += d.rate * song.bar * sectionRate(song.plan[b]);
      total += song.notes.filter((n) => n.t >= INTRO_BARS * barMs - 1).length;
      if (s <= 10) {
        assert.deepEqual(buildSong(seed, style.id, df, 60, song.bpm).notes, song.notes);
        assert.notDeepEqual(buildSong(seed + 1, style.id, df, 60, song.bpm).notes, song.notes);
      }
      const r = song.notes.filter((n) => n.t >= INTRO_BARS * barMs - 1).length / Array.from({ length: song.bars - 1 - INTRO_BARS }, (_, k) => d.rate * song.bar * sectionRate(song.plan[k + INTRO_BARS])).reduce((a, b) => a + b, 0);
      assert.ok(r >= 0.8 && r <= 1.2, `${label} density ${r.toFixed(2)}`);
    }
    assert.ok(Math.abs(total / target - 1) < 0.1, `${d.id} average density ${(total / target).toFixed(2)}`);
  });
  assert.equal(songFor(5, 'pop', 1, 60), songFor(5, 'pop', 1, 60));
  assert.ok(buildSong(5, 'pop', 'normal', 90).notes.length > buildSong(5, 'pop', 'normal', 45).notes.length);
  assert.equal(buildSong(5, 'pop', 'normal', 60).df, 1, 'old string ids still map to an index');
});

test('tempos are clamped per difficulty and lineups climb in tempo', () => {
  for (const s of STYLES) {
    const chill = bpmFor(s.id, 0);
    assert.ok(chill >= 84 && chill <= 108, `${s.id} chill ${chill}`);
    const normal = bpmFor(s.id, 1);
    assert.ok(normal >= 96 && normal <= 132, `${s.id} normal ${normal}`);
    assert.equal(bpmFor(s.id, 2), s.bpm);
    assert.ok(s.bpms.includes(normal) || normal === 96 || normal === 132);
  }
  assert.equal(bpmFor('rush', 0), 108, 'a style with no tempo in range is scaled to the nearest edge');
  const song = buildSong(3, 'rush', 0, 60, bpmFor('rush', 0));
  assert.equal(song.bpm, 108);
  assert.ok(Math.abs(song.beat - 60 / 108) < 1e-9);
  const rnd = seeded(3);
  const ls = lineup('mix', 3, rnd, 2);
  assert.equal(ls.length, 3);
  for (let i = 1; i < ls.length; i += 1) assert.ok(ls[i][1] >= ls[i - 1][1], 'songs get faster');
  assert.deepEqual(lineup('funk', 3, rnd, 1).map((x) => x[0]), ['funk', 'funk', 'funk']);
  assert.equal(new Set(lineup('mix', STYLES.length, seeded(4), 2).map((x) => x[0])).size, STYLES.length);
});

test('the music steps follow the style patterns and the settle-in has a beat to tap to', () => {
  const song = buildSong(17, 'house', 1, 60);
  const verse = INTRO_BARS * STEPS;
  const evs = Array.from({ length: 16 }, (_, i) => stepAt(song, verse + i));
  assert.deepEqual(evs.filter((e) => e.kick).map((e) => e.k % 16), [0, 4, 8, 12]);
  assert.deepEqual(evs.filter((e) => e.snare).map((e) => e.k % 16), [4, 12]);
  assert.ok(evs[0].chord && evs[0].chord.length === 3);
  assert.equal(stepAt(song, 0).snare, false);
  for (let q = 0; q < INTRO_BARS * 4; q += 1) assert.ok(stepAt(song, q * 4).hat || stepAt(song, q * 4).kick, 'every settle-in beat is audible');
  assert.equal(stepTime(song, 4), song.beat);
  assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
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
  DIFFS.forEach((d, df) => {
    const w = windowsFor(df);
    assert.deepEqual([w.p, w.g, w.o], d.win);
    const song = buildSong(321, 'pop', df, 60);
    const n = song.notes[INTRO_BARS * 4 + 2];
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
  const song = buildSong(321, 'pop', 1, 60);
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
  const lanes = lanesFor(1);
  const streaky = createJudge(song);
  for (const n of song.notes.slice(0, 12)) streaky.press(n.l, n.t);
  assert.equal(streaky.stats.c, 12);
  const gapAt = song.notes[11].t + 1;
  const strayLane = (song.notes[12].l + 1) % lanes;
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
  const song = buildSong(55, 'pop', 1, 60);
  const n = song.notes.length;
  const due = notesBefore(song, 30);
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
  const due = notesBefore(song, 19.5);
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
});

test('points: placement plus accuracy plus a full streak bonus, with fair ties, sit-outs and leavers', () => {
  assert.equal(pointsFor(1, 1, true), 500);
  assert.equal(pointsFor(1, 0, false), 300);
  assert.equal(pointsFor(9, 0, false), 90);
  assert.equal(pointsFor(20, 0.5, false), 90 + Math.round(150 * 0.25));
  assert.ok(pointsFor(1, 1, true) * 3 < 2000);
  const song = buildSong(9, 'pop', 1, 45);
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
  assert.equal(st(r).v, 2);
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
  assert.deepEqual(beatdrop.results({ get: () => after }).extra.fullCombo, [a]);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state[ROOM].phase, 'results');
});

test('every song gets a ready step, the final round splash fires on it, and ready ends early', async () => {
  const log = [];
  const game = spyGame(log);
  const r = await startGame(2, { songs: 2, length: 45, style: 'chill' }, [game]);
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
  const two = st(r);
  assert.equal(two.phase, 'ready', 'song 2 has its own ready step');
  assert.equal(two.i, 1);
  assert.equal(two.sty, 'chill');
  assert.notEqual(two.seed, s.seed);
  assert.ok(two.ends - r.engines[0].now() <= READY_NEXT_MS);
  assert.deepEqual(log.map((x) => [x.n, x.phase]), [[1, 'ready'], [2, 'ready']]);
  assert.equal(r.hub.state[FUN].f, 1, 'the final round is flagged before song 2 plays');
  await allReady(r);
  assert.equal(st(r).phase, 'play', 'everyone ready skips the wait');
  await until(r, () => st(r).phase === 'show');
  assert.equal(log.length, 2);
  await r.clock.advance(SHOW_MS + 300);
  assert.equal(r.hub.state[ROOM].phase, 'results');
});

test('opening the tutorial buys a little more ready time, once per player, up to a cap', async () => {
  const r = await startGame(2, { songs: 1, length: 45 });
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
});

test('nobody pressing ready still starts the song after the timer', async () => {
  const r = await startGame(2, { songs: 1, length: 45 });
  await r.clock.advance(READY_MS + 300);
  assert.equal(st(r).phase, 'play');
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
  const s2 = st(r);
  r.engines[0].act({ type: 'ready', n: s2.n });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'ready', 'after one sat-out song everyone is still waited for');
  assert.ok(await until(r, () => st(r).phase === 'play'));
  assert.ok(await until(r, () => st(r).phase === 'ready' && st(r).i === 2));
  const s3 = st(r);
  r.engines[0].act({ type: 'ready', n: s3.n });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'play', 'two sat-out songs in a row means nobody waits for them');
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
    const due = notesBefore(song, t / 1000 - 0.2);
    bySlot(r, a).act({ type: 'prog', n: s.n, v: [due, due, 0, 0, 0, due, due] });
    if (t < 12000) {
      const dueB = notesBefore(song, t / 1000 - 0.2);
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
});

test('the host leaving mid-song keeps the song, its clock and the live rows', async () => {
  const r = await startGame(3, { length: 45 });
  await allReady(r);
  const s = st(r);
  const song = songOfState(s);
  const [, b, c] = slots(r);
  await playAlong(r, s, s.at + 6000, { [b]: 'all', [c]: 'all' });
  const due = notesBefore(song, 5.5);
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
  assert.equal(after.seed, s.seed);
  assert.deepEqual(after.sc[b], row);
  bySlot(r, b).act({ type: 'prog', n: s.n, v: [due - 1, due - 1, 0, 0, 0, 0, due - 1] });
  await r.clock.advance(1200);
  assert.deepEqual(st(r).sc[b], row, 'the new host seeds its baselines from the room');
  await playAlong(r, after, after.ends + 500, { [b]: 'all', [c]: 'all' });
  assert.equal(st(r).phase, 'show');
  assert.equal(st(r).res[b][10], FLAG_PLAYED);
});

test('shared state stays tiny with 12 players and never carries the chart', async () => {
  const big = { v: 2, n: 9, phase: 'show', i: 2, total: 3, lineup: [['chill', 104], ['house', 124], ['rush', 148]], seed: 2147483000, sty: 'rush', bpm: 148, df: 2, len: 90, at: 1700000123456, starts: 1700000123456, ends: 1700000133456, in: [], w: [12, 13], rd: [], idle: [], so: {}, sc: {}, f: {}, ev: [], evn: 999, res: {} };
  for (let s = 0; s < 12; s += 1) {
    big.in.push(s);
    big.rd.push(s);
    big.idle.push(s);
    big.so[s] = 1;
    big.sc[s] = [1000, 640, 640, 1, 640, 100, 640, 0, 0];
    big.f[s] = [640, 0, 0, 0, 640];
    big.res[s] = [12, 1000, 'S', 100, 640, 640, 640, 640, 640, 500, 2];
  }
  big.ev = [[11, 't', 100, 996], [11, 'l', 1000, 997], [10, 'f', 1000, 998], [9, 'l', 1000, 999]];
  assert.ok(jsonBytes(big) <= 3500, `${jsonBytes(big)} bytes`);
  const r = await startGame(8, { length: 90, difficulty: 'hard' });
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
      const due = Math.max(counts[i], notesBefore(song, sec - 0.2));
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
  assert.equal(kinds[kinds.length - 1], 'jump', 'the music re-seeks to the song time');
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
  assert.deepEqual([p.tapOffset, p.seen, p.slow, p.calm, p.music, p.taps], [0, false, null, false, true, true]);
  p.tapOffset = 5000;
  p.seen = true;
  p.best['rush.2'] = 812;
  assert.equal(writePrefs(store, p), true);
  const back = readPrefs(store);
  assert.equal(back.tapOffset, TIMING_MAX);
  assert.equal(back.seen, true);
  assert.equal(back.best['rush.2'], 812);
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: '35' })).tapOffset, 35, 'the old number-only value carries over');
  assert.equal(readPrefs(memStore({ [OFFSET_KEY]: '{bad' })).tapOffset, 0);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readPrefs(broken).tapOffset, 0);
  assert.equal(writePrefs(broken, p), false);
  assert.equal(readPrefs(null).music, true);
  assert.deepEqual(keyLabels(2), ['D', 'J']);
  assert.deepEqual(keyLabels(3), ['D', 'Space', 'J']);
  assert.deepEqual(keyLabels(4), ['D', 'F', 'J', 'K']);
  assert.equal(laneOfKey({ code: 'KeyF' }, 2), 0);
  assert.equal(laneOfKey({ code: 'ArrowRight' }, 2), 1);
  assert.equal(laneOfKey({ code: 'Space' }, 3), 1);
  assert.equal(laneOfKey({ key: ' ' }, 3), 1);
  assert.equal(laneOfKey({ code: 'ArrowUp' }, 4), 2);
  assert.equal(laneOfKey({ key: 'k' }, 4), 3);
  assert.equal(laneOfKey({ code: 'KeyX' }, 4), -1);
  for (const [lanes, keys] of Object.entries(LANE_KEYS)) assert.equal(keys.length, Number(lanes));
  assert.equal(heightFor(700, 0), 700 - 44 - 28 - 52 - 64 - 8);
  assert.equal(heightFor(400, 0), 320);
  assert.equal(eventTime(990, 1000), 990, 'real event times are used');
  assert.equal(eventTime(90000, 1000), 1000, 'an event time from another clock falls back to now');
  assert.equal(eventTime(-5, 1000), 1000);
  assert.equal(eventTime(undefined, 1000), 1000);
  assert.equal(heightFor(2000, 0), 760);
  assert.equal(heightFor(900, 0, true), 900 - 44 - 52 - 64 - 8);
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
  assert.deepEqual(laneStyle(2), [0, 2]);
  assert.deepEqual(laneStyle(3), [0, 1, 2]);
  const notes = tutorialNotes(3);
  assert.equal(notes.length, 8);
  assert.equal(new Set(notes.map((n) => n.l)).size, 3);
});

test('the synth plays original loops, taps, misses and follows the switches', () => {
  const { ctx, made } = fakeAudio();
  const s = fakeSfx(ctx);
  const win = fakeWin();
  const p = createBeatPlayer({ sfx: s, win });
  const song = buildSong(8, 'funk', 1, 45);
  assert.equal(p.status(), 'ok');
  assert.equal(p.start(song, 5), true);
  assert.equal(p.playing, true);
  assert.ok(made.length > 0);
  assert.ok(made.every((o) => o.at >= 5 - 1e-9 && o.at <= 5 + 0.4));
  assert.ok(win.timers.length > 0);
  made.length = 0;
  assert.equal(p.hit(1, 'p', 3), true);
  assert.ok(made.length >= 2, 'a perfect hit adds a shimmer');
  assert.equal(p.miss(), true);
  assert.equal(p.stray(), true);
  assert.equal(p.tierUp(3), true);
  assert.equal(p.duck(2), true);
  assert.equal(p.swell(3), true);
  p.setMix({ taps: false });
  made.length = 0;
  assert.equal(p.hit(0, 'g', 3), false, 'Taps off silences hits');
  assert.equal(made.length, 0);
  p.setMix({ taps: true, music: false });
  assert.deepEqual(p.mix, { music: false, taps: true });
  made.length = 0;
  assert.equal(p.seek(20), true, 'seeking jumps the music to the song time');
  p.mute(true);
  p.mute(false);
  s.enabled = false;
  s.fire();
  assert.equal(p.playing, false, 'muting stops the music');
  assert.equal(p.start(song, 0), false);
  assert.equal(p.status(), 'off');
  assert.match(soundNote('off'), /Turn sound on/);
  assert.equal(soundNote('blocked'), null, 'no misleading tap anywhere note');
  const none = createBeatPlayer({ sfx: { enabled: true, volume: 0.5, context: null, unlock() {} }, win: {} });
  assert.equal(none.status(), 'none');
  assert.equal(none.start(song, 0), false);
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
  assert.equal(own.start(song, 0), true);
  own.destroy();
  assert.ok(cut.length >= 2, 'the gain nodes are disconnected');
  assert.equal(closed, 1, 'a context the player made itself is closed');
  assert.equal(own.start(song, 0), false);
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
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win, storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }) });
  engine.act({ type: 'ready', n: st(r).n });
  await r.clock.advance(300);
  view.update(engine.snapshot());
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
  assert.equal(view.player.playing, false);
  assert.equal(view.frame(), false);
});

test('a drawing error does not stop the game for good', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1 });
  const engine = r.engines[0];
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r.clock.now()), storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }) });
  engine.act({ type: 'ready', n: st(r).n });
  await r.clock.advance(300);
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
});

test('the renderer is safe without a canvas and caps particles', () => {
  const noCanvas = createBeatDraw({});
  assert.equal(noCanvas.ok, false);
  assert.equal(noCanvas.draw({ now: 0, t: 0 }), false);
  const calls = [];
  const ctx2 = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get: (t, k) => (k in t ? t[k] : () => calls.push(k)), set: (t, k, v) => ((t[k] = v), true) });
  const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx2 });
  const draw = createBeatDraw(fakeCanvas(), { doc: { createElement: fakeCanvas } });
  assert.equal(draw.resize({ width: 400, height: 500, dpr: 3, lanes: 3 }), true);
  assert.equal(draw.view.dpr, 2, 'device pixel ratio is capped at 2');
  for (let i = 0; i < 20; i += 1) draw.burst(i % 3, 0, 6);
  assert.equal(draw.particles, 60);
  const song = buildSong(4, 'pop', 1, 45);
  assert.equal(draw.draw({ now: 10, t: 5, look: 1.7, song, mark: new Uint8Array(song.notes.length), judge: [{ k: 'p', at: 0, tag: '' }, null, null], labels: ['D', 'Space', 'J'], countdown: '3', dropSoon: true, marks: [{ t: 10, sec: 'drop' }], tier: 2 }), true);
  assert.ok(calls.includes('drawImage'));
  assert.ok(calls.includes('fillText'));
  assert.equal(calls.includes('shadowBlur'), false);
  draw.draw({ now: 10, t: 5, look: 1.7, song, still: true });
  assert.equal(draw.particles, 0, 'no particles in calm view');
});

test('the tutorial teaches one lane at a time, then tunes timing with an undo', () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  let now = 1000;
  let offset = 0;
  let done = null;
  const t = createTutorial({ lanes: 3, perf: () => now, loop: null, labels: () => ['D', 'Space', 'J'], offset: () => offset, onOffset: (ms) => (offset = ms), onDone: (r) => (done = r) });
  assert.equal(t.step, 1);
  assert.equal(t.press(2, now), false, 'the wrong lane does nothing');
  now += 2500;
  assert.equal(t.press(0, now), true);
  now += 800;
  t.frame();
  assert.equal(t.step, 2);
  now += 2500;
  assert.equal(t.press(2, now), true);
  now += 800;
  t.frame();
  assert.equal(t.step, 3);
  const start = now;
  for (const n of tutorialNotes(3)) {
    now = start + n.t + 30;
    t.press(n.l, now);
  }
  assert.equal(t.streak, 8);
  now = start + tutorialNotes(3)[7].t + 1000;
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

test('the view: tutorial first, a ready card, lanes you can play and a results card', async () => {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { length: 45, songs: 2 });
  const engine = r.engines[0];
  const store = memStore();
  const view = createBeatdropView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r.clock.now()), storage: store });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  assert.ok(document.body.querySelector('link[data-bd-play]'), 'the play sheet loads with the view');
  assert.equal(document.body.querySelector('link[data-bd-play]').getAttribute('href'), PLAY_SHEET);
  assert.ok(view.tut, 'first timers get the tutorial');
  assert.ok(byKey(view, 'bd-tut-skip'));
  byKey(view, 'bd-tut-skip').click();
  assert.equal(view.tut, null);
  assert.equal(readPrefs(store).seen, true);
  for (const k of ['bd-ready', 'bd-how', 'bd-timing', 'bd-slow', 'bd-calm']) assert.ok(byKey(view, k), k);
  assert.ok(all(view.el).some((n) => n.textContent === 'Song 1 of 2 - NEXT UP'));
  byKey(view, 'bd-ready').click();
  r.engines[1].act({ type: 'ready', n: st(r).n });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'play');
  view.update(engine.snapshot());
  const s = st(r);
  const song = songOfState(s);
  assert.equal(view.local.lanes, 3);
  assert.ok(all(view.el).filter((n) => n.classList && n.classList.contains('bd-pad')).length === 3);
  assert.equal(byKey(view, 'bd-lane-1').getAttribute('aria-label'), 'Lane 2 (Space)');
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
  assert.equal(readPrefs(store).best[`${s.sty}.${s.df}`], 1000, 'a new best is remembered');
  assert.match(footText(beatdrop.model(engine.snapshot())), /topped the song/);
  for (const n of all(view.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  view.destroy();
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
  const store = memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) });
  const watcher = createBeatdropView({ engine: late, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => late.now()), storage: store });
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
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r.clock.now()), storage: pstore });
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
});

test('reduced motion turns on slower notes and the calm view by default', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(1, { length: 45, songs: 1, difficulty: 'easy' });
  const engine = r.engines[0];
  const view = createBeatdropView({ engine, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r.clock.now(), true), storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }) });
  view.update(engine.snapshot());
  assert.equal(byKey(view, 'bd-slow').getAttribute('aria-pressed'), 'true');
  engine.act({ type: 'ready', n: st(r).n });
  await r.clock.advance(300);
  view.update(engine.snapshot());
  assert.equal(view.local.lanes, 2);
  assert.ok(Math.abs(view.local.look - lookFor(0, true)) < 1e-9);
  view.destroy();
  const r2 = await startGame(1, { length: 45, songs: 1, difficulty: 'easy' });
  const plain = createBeatdropView({ engine: r2.engines[0], cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(null, false), win: fakeWin(() => r2.clock.now(), false), storage: memStore({ [OFFSET_KEY]: JSON.stringify({ seen: true }) }) });
  r2.engines[0].act({ type: 'ready', n: st(r2).n });
  await r2.clock.advance(300);
  plain.update(r2.engines[0].snapshot());
  assert.ok(Math.abs(plain.local.look - lookFor(0, false)) < 1e-9);
  plain.destroy();
});

test('an old Beat Drop room key from before the update is replaced safely', async () => {
  const r = await startGame(2, { length: 45, songs: 1 });
  const engine = r.engines[0];
  const old = { v: 1, n: 3, phase: 'play', seed: 5, sty: 'pop', df: 'normal', len: 45, in: [0, 1], sc: {}, hs: {}, jt: {}, at: 0, ends: 0 };
  assert.equal(beatdrop.model({ state: { [KEY]: old }, meSlot: 0, players: [] }), null);
  assert.equal(songOfState(old), null);
  let put = null;
  const api = { get: () => old, put: (k, v) => (put = v), now: () => engine.now(), players: () => [{ slot: 0 }], settings: {}, random: seeded(1), memory: {}, setDeadline() {}, round() {}, deadline: null, finish() {} };
  beatdrop.resume(api);
  assert.equal(put.v, 2);
  assert.equal(put.phase, 'ready');
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
