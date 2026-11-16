import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import musicquiz, { KEY, LEAD_MS, MAX_POINTS, MIN_POINTS, CLIP_SECONDS, speedPoints, buildDeck, choicesFor, midiHz, schedule, clipLength } from '../web/activity/js/games/musicquiz.js';
import { createMusicquizView, createTunePlayer, footText, soundNote, musicMoment } from '../web/activity/js/views/musicquiz.js';
import { TUNES, KINDS, tuneById, parseNotes, midiOf } from '../web/activity/data/musicquiz.js';
import { unmask } from '../web/activity/js/games/draw.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const CUTOFF = new Date().getUTCFullYear() - 100;

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function answerOf(r) {
  const s = st(r);
  return s.c.indexOf(unmask(s.deck[s.i], s.k));
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [musicquiz] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('musicquiz'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function intervals(tune) {
  const pitched = tune.notes.filter((n) => n[0] > 0).map((n) => n[0]);
  return pitched.slice(1).map((m, i) => m - pitched[i]);
}

test('every tune is public domain: traditional, or by someone who died over 100 years ago', () => {
  assert.ok(TUNES.length >= 40, `${TUNES.length} tunes`);
  assert.equal(new Set(TUNES.map((t) => t.title)).size, TUNES.length);
  assert.equal(new Set(TUNES.map((t) => t.key)).size, TUNES.length);
  for (const t of TUNES) {
    assert.ok(KINDS.some((k) => k.id === t.kind), t.key);
    for (const re of BANNED) assert.doesNotMatch(`${t.title} ${t.by}`, re);
    const years = [...t.by.matchAll(/\b(1[0-9]{3})\b/g)].map((m) => Number(m[1]));
    const died = /–/.test(t.by) ? years[years.length - 1] : null;
    const old = /^Traditional|^Arranged by/.test(t.by);
    assert.ok(old || (died && died < CUTOFF), `${t.title}: ${t.by}`);
    if (!/^Traditional/.test(t.by)) assert.ok(died && died < CUTOFF, `${t.title} needs a death year before ${CUTOFF}`);
    assert.ok(t.bpm >= 50 && t.bpm <= 180, t.key);
    assert.ok(t.notes.length >= 8, t.key);
    for (const [midi, beats] of t.notes) {
      assert.ok(midi === 0 || (midi >= 43 && midi <= 96), `${t.key} note ${midi}`);
      assert.ok(beats > 0 && beats <= 6, `${t.key} length ${beats}`);
    }
    assert.ok(clipLength(t) >= 4 && clipLength(t) <= CLIP_SECONDS + 0.01, `${t.key} clip ${clipLength(t)}`);
  }
});

test('the notes really are the tunes: famous openings match their intervals', () => {
  const twinkle = tuneById(TUNES.find((t) => t.key === 'twinkle').id);
  assert.deepEqual(intervals(twinkle).slice(0, 6), [0, 7, 0, 2, 0, -2]);
  const ode = TUNES.find((t) => t.key === 'odetojoy');
  assert.deepEqual(intervals(ode).slice(0, 7), [0, 1, 2, 0, -2, -1, -2]);
  const birthday = TUNES.find((t) => t.key === 'birthday');
  assert.deepEqual(intervals(birthday).slice(0, 5), [0, 2, -2, 5, -1]);
  const fifth = TUNES.find((t) => t.key === 'beethoven5');
  assert.deepEqual(intervals(fifth), [0, 0, -4, 2, 0, 0, -3]);
  const elise = TUNES.find((t) => t.key === 'furelise');
  assert.deepEqual(intervals(elise).slice(0, 8), [-1, 1, -1, 1, -5, 3, -2, -3]);
  const jingle = TUNES.find((t) => t.key === 'jinglebells');
  assert.deepEqual(intervals(jingle).slice(0, 10), [0, 0, 0, 0, 0, 0, 3, -7, 2, 2]);
  const mary = TUNES.find((t) => t.key === 'marylamb');
  assert.deepEqual(intervals(mary).slice(0, 6), [-2, -2, 2, 2, 0, 0]);
  const king = TUNES.find((t) => t.key === 'mountainking');
  assert.deepEqual(intervals(king).slice(0, 6), [2, 1, 2, 2, -4, 4]);
  assert.equal(midiOf('A4'), 69);
  assert.equal(midiOf('C4'), 60);
  assert.equal(midiOf('F#4'), 66);
  assert.equal(midiOf('Bb3'), 58);
  assert.deepEqual(parseNotes('C4:1 R:0.5 G#4:2'), [[60, 1], [0, 0.5], [68, 2]]);
  assert.throws(() => parseNotes('H4:1'));
  assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiHz(60) - 261.6256) < 0.001);
});

test('the game is a quiz with tunes, a timer and a source setting', () => {
  assert.equal(musicquiz.id, 'musicquiz');
  assert.equal(musicquiz.category, 'quiz');
  assert.equal(musicquiz.emoji, '🎵');
  assert.equal(musicquiz.settings.find((s) => s.id === 'rounds').default, 8);
  assert.equal(musicquiz.settings.find((s) => s.id === 'timer').default, 15);
  assert.ok(musicquiz.settings.find((s) => s.id === 'kind').options.some((o) => o.value === 'classical'));
  for (const re of BANNED) assert.doesNotMatch(`${musicquiz.name} ${musicquiz.blurb}`, re);
});

test('helpers: speed points, decks, four distinct choices and a capped clip', () => {
  assert.equal(speedPoints(1000, 1000, 21000), MAX_POINTS);
  assert.equal(speedPoints(21000, 1000, 21000), MIN_POINTS);
  assert.ok(speedPoints(11000, 1000, 21000) < MAX_POINTS);
  assert.equal(buildDeck(10, 'mix', () => 0.3).length, 10);
  assert.ok(buildDeck(10, 'holiday', () => 0.3).every((id) => tuneById(id).kind === 'holiday'));
  for (const t of TUNES) {
    const c = choicesFor(t.id, () => 0.5);
    assert.equal(c.length, 4);
    assert.equal(new Set(c).size, 4);
    assert.ok(c.includes(t.id));
  }
  const long = TUNES.find((t) => t.key === 'canon');
  const notes = schedule(long);
  assert.ok(notes.every((n) => n.at < CLIP_SECONDS && n.at + n.dur <= CLIP_SECONDS + 1e-9));
  assert.equal(schedule(TUNES.find((t) => t.key === 'beethoven5'))[0].at, 0.5 * (60 / 108));
});

test('a round plays one tune, faster right answers score more, then it reveals the title', async () => {
  const r = await startGame(3, { rounds: 5, timer: 20 });
  const s = st(r);
  assert.equal(s.phase, 'listen');
  assert.equal(s.c.length, 4);
  assert.equal(s.starts - s.shown, LEAD_MS);
  const right = answerOf(r);
  const [a, b, c] = r.engines.map((e) => e.snapshot().meSlot);
  bySlot(r, a).act({ type: 'answer', n: s.n, i: right });
  await r.clock.advance(5000);
  bySlot(r, b).act({ type: 'answer', n: s.n, i: right });
  bySlot(r, b).act({ type: 'answer', n: s.n, i: (right + 1) % 4 });
  await r.clock.advance(300);
  bySlot(r, c).act({ type: 'answer', n: s.n, i: (right + 1) % 4 });
  await r.clock.advance(400);
  const after = st(r);
  assert.equal(after.phase, 'reveal');
  assert.equal(after.answer, right);
  assert.deepEqual(after.right, [a, b].sort((x, y) => x - y));
  assert.ok(after.gained[a] > after.gained[b], 'faster scores more');
  assert.equal(after.gained[a], MAX_POINTS);
  assert.equal(after.gained[c], undefined);
  const m = musicquiz.model(bySlot(r, a).snapshot());
  assert.equal(m.gotIt, true);
  assert.ok(m.title);
  await r.clock.advance(6500);
  assert.equal(st(r).phase, 'listen');
  assert.equal(st(r).i, 1);
});

test('ten tunes play through to the results when nobody answers', async () => {
  const r = await startGame(2, { timer: 15, rounds: 10 });
  assert.equal(st(r).total, 10);
  for (let i = 0; i < 10; i += 1) {
    await r.clock.advance(15000 + LEAD_MS + 200);
    assert.equal(st(r).phase, 'reveal');
    await r.clock.advance(6200);
  }
  assert.equal(r.hub.state.room.phase, 'results');
});

test('the host leaving mid-tune asks the same tune again', async () => {
  const r = await startGame(3);
  const s = st(r);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'listen');
  assert.equal(after.i, s.i);
  assert.equal(after.note, 'host');
  assert.ok(after.n > s.n);
});

function fakeAudio() {
  const made = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param() });
  const ctx = {
    state: 'running',
    currentTime: 10,
    destination: node(),
    createGain: () => node(),
    createOscillator: () => {
      const o = { type: 'sine', frequency: { ...param(), setValueAtTime(v, t) { o.hz = v; o.at = t; } }, connect() {}, start() {}, stop() { o.stopped = true; } };
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
      for (const fn of subs) fn({ enabled: this.enabled, volume: this.volume });
    },
  };
}

function fakeWin() {
  const timers = [];
  return { timers, setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length, clearTimeout() {} };
}

test('the player synthesises the notes locally and respects the sound switch', () => {
  const { ctx, made } = fakeAudio();
  const s = fakeSfx(ctx);
  const p = createTunePlayer({ sfx: s, win: fakeWin() });
  const tune = TUNES.find((t) => t.key === 'twinkle');
  assert.equal(p.play(tune, 0), true);
  assert.equal(p.playing, true);
  const expected = schedule(tune);
  assert.equal(made.length, expected.length);
  assert.ok(Math.abs(made[0].hz - midiHz(60)) < 1e-6);
  assert.ok(Math.abs(made[2].hz - midiHz(67)) < 1e-6);
  assert.ok(made[1].at > made[0].at);
  s.enabled = false;
  s.fire();
  assert.equal(p.playing, false, 'muting stops the tune');
  assert.equal(p.play(tune, 0), false, 'nothing plays while muted');
  assert.equal(p.status(), 'off');
  assert.match(soundNote('off'), /speaker button/);
  s.enabled = true;
  made.length = 0;
  assert.equal(p.play(tune, 4), true);
  assert.ok(made.length < expected.length, 'a late start skips ahead');
  const none = createTunePlayer({ sfx: { enabled: true, volume: 0.5, context: null, unlock() {} }, win: {} });
  assert.equal(none.status(), 'none');
  assert.equal(none.play(tune), false);
  p.destroy();
});

test('footer text and moments', () => {
  assert.match(footText({ phase: 'listen', answered: 1, players: 3, waiting: false, watching: false, iAnswered: false }), /Name that tune/);
  assert.match(footText({ phase: 'reveal', gotIt: true, myGain: 800, myPick: 1 }), /\+800/);
  const was = musicMoment(null, { n: 1, phase: 'listen', myPick: 0 }).now;
  assert.equal(musicMoment(was, { n: 1, phase: 'reveal', myPick: 0, gotIt: true }).cue, 'correct');
  assert.equal(musicMoment(was, { n: 1, phase: 'reveal', myPick: null }).cue, null);
});

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

test('the view shows four choices, schedules the tune at the shared start and locks in a pick', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2);
  const { ctx, made } = fakeAudio();
  const win = fakeWin();
  const engine = r.engines[0];
  const view = createMusicquizView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} }, sfx: fakeSfx(ctx), win });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  const opts = all(view.el).filter((n) => n.classList && n.classList.contains('option'));
  assert.equal(opts.length, 4);
  assert.ok(win.timers.some((t) => t.ms > 400 && t.ms <= LEAD_MS), 'waits for the shared start');
  win.timers.find((t) => t.ms > 400).fn();
  assert.ok(made.length > 0, 'the tune plays');
  opts[0].click();
  await r.clock.advance(300);
  assert.ok(st(r).answered.includes(engine.snapshot().meSlot));
  for (const n of all(view.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  view.destroy();
});
