import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import typerace, { KEY, LEAD_MS, SHOW_MS, LATE_MIN_MS, TEXT_MAX, WORD_COUNT, PLACE_POINTS, ACC_POINTS, FLAGGED, wpmOf, accuracyOf, correctPrefix, scoreRow, textFor, buildDeck, minMsFor, cleanTyped } from '../web/activity/js/games/typerace.js';
import { createTyperaceView, footText, typeraceMoment, splitText, PROG_MS } from '../web/activity/js/views/typerace.js';
import { SENTENCES, WORDS } from '../web/activity/data/typerace.js';
import { findBlocked, isBlockedGameWord } from '../web/activity/js/filter.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [typerace] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('typerace'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function finish(r, e, { ms = 6000, errors = 0 } = {}) {
  const s = st(r);
  e.act({ type: 'done', n: s.n, t: s.text, ms, e: errors });
  await r.clock.advance(600);
}

test('the game is a quick game with short defaults and clean text', () => {
  assert.equal(typerace.id, 'typerace');
  assert.equal(typerace.category, 'quick');
  assert.equal(typerace.emoji, '⌨️');
  assert.equal(typerace.minPlayers, 1);
  assert.deepEqual(typerace.cards, ['swap', 'double']);
  assert.equal(typerace.settings.find((s) => s.id === 'rounds').default, 5);
  assert.equal(typerace.settings.find((s) => s.id === 'timer').default, 45);
  for (const re of BANNED) assert.doesNotMatch(`${typerace.name} ${typerace.blurb}`, re);
  assert.ok(SENTENCES.length >= 50);
  assert.equal(new Set(SENTENCES).size, SENTENCES.length);
  for (const s of SENTENCES) {
    assert.ok(s.length <= TEXT_MAX, s);
    assert.match(s, /^[A-Za-z ,.!?']+$/, s);
    assert.equal(findBlocked(s).length, 0, s);
  }
  for (const w of WORDS) {
    assert.match(w, /^[a-z]+$/);
    assert.equal(isBlockedGameWord(w), false, w);
  }
});

test('helpers work out speed, accuracy, progress and points', () => {
  assert.equal(wpmOf(50, 60000), 10);
  assert.equal(wpmOf(0, 1000), 0);
  assert.equal(accuracyOf(90, 10), 90);
  assert.equal(accuracyOf(50, 0), 100);
  assert.equal(correctPrefix('hello world', 'hello wq'), 7);
  assert.equal(cleanTyped('  a   b \n'), 'a b');
  assert.equal(minMsFor('x'.repeat(44)), 2000);
  assert.equal(scoreRow([50, 1, 9000, 0], 50), PLACE_POINTS[0] + ACC_POINTS);
  assert.equal(scoreRow([50, 2, 9000, 50], 50), PLACE_POINTS[1] + Math.round(ACC_POINTS * 0.25));
  assert.equal(scoreRow([25, 0, 0, 0], 50), 40);
  assert.equal(scoreRow([50, FLAGGED, 0, 0], 50), 0);
  assert.deepEqual(splitText('abcdef', 'abx'), { good: 'ab', bad: 'c', rest: 'def', c: 2 });
});

test('decks pick sentences or word lists the same way on every host', () => {
  const deck = buildDeck(5, 'sentences', () => 0.3);
  assert.equal(deck.length, 5);
  assert.equal(new Set(deck).size, 5);
  for (const id of deck) assert.ok(SENTENCES.includes(textFor('sentences', id)));
  const words = buildDeck(3, 'words', () => 0.42);
  const a = textFor('words', words[0]);
  assert.equal(a, textFor('words', words[0]));
  assert.ok(a.split(' ').length <= WORD_COUNT && a.length <= TEXT_MAX);
  assert.ok(a.split(' ').every((w) => WORDS.includes(w)));
});

test('everyone races the same sentence and finish order sets the points', async () => {
  const r = await startGame(3);
  const [a, b, c] = slotsOf(r);
  let s = st(r);
  assert.equal(s.phase, 'race');
  assert.equal(s.total, 5);
  assert.ok(SENTENCES.includes(s.text));
  assert.equal(s.go - s.starts, LEAD_MS);
  assert.equal(JSON.stringify(s.deck).includes(s.text), false);
  await r.clock.advance(LEAD_MS + 6000);
  bySlot(r, c).act({ type: 'prog', n: s.n, c: 10 });
  await r.clock.advance(600);
  assert.equal(st(r).ps[c][0], 10);
  await finish(r, bySlot(r, a), { ms: 6000, errors: 0 });
  await finish(r, bySlot(r, b), { ms: 6100, errors: 5 });
  s = st(r);
  assert.equal(s.ps[a][1], 1);
  assert.equal(s.ps[b][1], 2);
  assert.equal(s.phase, 'race');
  await r.clock.advance(s.ends - r.clock.now() + 300);
  s = st(r);
  assert.equal(s.phase, 'show');
  const len = s.text.length;
  assert.equal(s.gained[a], scoreRow([len, 1, 6000, 0], len));
  assert.equal(s.gained[b], scoreRow([len, 2, 6100, 5], len));
  assert.equal(s.gained[c], Math.round((80 * 10) / len));
  assert.equal(r.engines[0].snapshot().scores.g[a], s.gained[a]);
  assert.ok(s.best[a] > 0);
  const m = typerace.model(bySlot(r, a).snapshot());
  assert.equal(m.place, 1);
  assert.equal(m.racers[0].slot, a);
  assert.ok(m.wpm > 0 && m.acc === 100);
  await r.clock.advance(SHOW_MS + 200);
  assert.equal(st(r).phase, 'race');
  assert.equal(st(r).i, 1);
  assert.notEqual(st(r).text, s.text);
});

test('the round ends early once everyone has finished, and the game ends after the last round', async () => {
  const r = await startGame(2, { rounds: 3 });
  for (let i = 0; i < 3; i += 1) {
    await r.clock.advance(LEAD_MS + 5000);
    for (const e of r.engines) await finish(r, e, { ms: 5000 });
    assert.equal(st(r).phase, 'show');
    await r.clock.advance(SHOW_MS + 200);
  }
  assert.equal(r.hub.state.room.phase, 'results');
});

test('the host checks the text and the time: wrong text, impossible speed and stale times do not count', async () => {
  const r = await startGame(2);
  const [a, b] = slotsOf(r);
  const s = st(r);
  await r.clock.advance(LEAD_MS + 4000);
  bySlot(r, a).act({ type: 'done', n: s.n, t: `${s.text}x`, ms: 4000, e: 0 });
  await r.clock.advance(600);
  assert.equal(st(r).ps[a][1], 0, 'a different text is ignored');
  bySlot(r, a).act({ type: 'done', n: s.n, t: s.text, ms: 60000, e: 0 });
  await r.clock.advance(600);
  assert.equal(st(r).ps[a][1], 0, 'a time from the future is ignored');
  bySlot(r, a).act({ type: 'prog', n: s.n, c: 9999 });
  await r.clock.advance(600);
  assert.ok(st(r).ps[a][0] < s.text.length, 'progress is capped below the finish');
  const fast = await startGame(2);
  const fs = st(fast);
  const [x] = slotsOf(fast);
  await fast.clock.advance(LEAD_MS + 300);
  bySlot(fast, x).act({ type: 'done', n: fs.n, t: fs.text, ms: 300, e: 0 });
  await fast.clock.advance(600);
  assert.equal(st(fast).ps[x][1], FLAGGED);
  assert.ok(minMsFor(fs.text) > 300);
  await fast.clock.advance(46000);
  assert.equal(st(fast).gained[x], undefined);
  assert.equal(st(r).ps[b][1], 0);
});

test('a late joiner races right away, and a very late one waits for the next round', async () => {
  const r = room(2, { games: [typerace] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('typerace');
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const late = r.add(3);
  await r.clock.advance(800);
  const slot = late.snapshot().meSlot;
  assert.ok(st(r).in.includes(slot));
  assert.deepEqual(st(r).ps[slot], [0, 0, 0, 0]);
  await r.clock.advance(st(r).ends - r.clock.now() - LATE_MIN_MS + 1000);
  const later = r.add(4);
  await r.clock.advance(500);
  const s4 = later.snapshot().meSlot;
  assert.ok(st(r).wait.includes(s4));
  assert.equal(typerace.model(later.snapshot()).waiting, true);
  await r.clock.advance(20000);
  await r.clock.advance(SHOW_MS + 200);
  assert.ok(st(r).in.includes(s4), 'they race from the next round');
});

test('the host leaving keeps the race going', async () => {
  const r = await startGame(3);
  const slots = slotsOf(r);
  await r.clock.advance(LEAD_MS + 5000);
  await finish(r, bySlot(r, slots[1]), { ms: 5000 });
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  assert.equal(st(r).phase, 'race');
  assert.equal(st(r).ps[slots[1]][1], 1);
  await finish(r, bySlot(r, slots[2]), { ms: 7000 });
  assert.equal(st(r).ps[slots[2]][1], 2);
  assert.equal(st(r).phase, 'show', 'the new host ends the round when everyone left has finished');
});

test('state stays under the value limit with a full room', async () => {
  const r = await startGame(16, { rounds: 7 });
  const s = st(r);
  s.text = 'x'.repeat(TEXT_MAX);
  for (let i = 0; i < 24; i += 1) s.ps[i] = [TEXT_MAX, 24, 99999, 999];
  for (let i = 0; i < 24; i += 1) s.best[i] = 250;
  s.gained = Object.fromEntries(Object.keys(s.ps).map((k) => [k, 999]));
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES, `${jsonBytes(s)} bytes`);
});

test('moments cue the start, finishing and the reveal', () => {
  const base = { n: 1, phase: 'race', place: 0, finished: 0 };
  assert.deepEqual(typeraceMoment(null, base).cues, ['start']);
  const was = typeraceMoment(null, base).now;
  assert.deepEqual(typeraceMoment(was, { ...base, place: 1, finished: 1 }).cues, ['win']);
  assert.deepEqual(typeraceMoment(was, { ...base, place: 2, finished: 2 }).cues, ['correct']);
  assert.deepEqual(typeraceMoment(was, { ...base, finished: 1 }).cues, ['pop']);
  assert.deepEqual(typeraceMoment(was, { ...base, phase: 'show' }).cues, ['reveal']);
  assert.match(footText({ phase: 'show', place: 1, wpm: 80, acc: 97, myGain: 390 }, 0), /80 WPM/);
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

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function fakeWin() {
  const ticks = [];
  return {
    ticks,
    setInterval(fn) {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval() {
      ticks.length = 0;
    },
  };
}

test('the view shows the sentence and live bars, blocks paste, throttles progress and sends the finish', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2);
  const played = [];
  const toasts = [];
  const wins = [];
  const views = r.engines.map((engine, i) => {
    const win = fakeWin();
    wins.push(win);
    const v = createTyperaceView({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win, cues: { play: (n) => i === 0 && played.push(n), burst() {}, float() {} } });
    engine.on('change', (s) => v.update(s));
    v.update(engine.snapshot());
    return v;
  });
  const el = views[0].el;
  const input = byKey(el, 'typerace-input');
  assert.equal(input.disabled, true, 'locked during the countdown');
  for (const n of all(el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  const faces = all(el).filter((n) => n.classList && n.classList.contains('avatar-btn') && n.getAttribute('data-profile-id'));
  assert.equal(faces.length, 2);
  await r.clock.advance(LEAD_MS + 4000);
  views[0].update(r.engines[0].snapshot());
  assert.equal(input.disabled, false);
  const paste = new FakeEvent('paste', { bubbles: true });
  input.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  const drop = new FakeEvent('beforeinput', { bubbles: true });
  drop.inputType = 'insertFromPaste';
  input.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.ok(toasts.some((t) => /pasting/i.test(t)));
  const text = st(r).text;
  input.value = text;
  input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  assert.equal(input.value, '', 'a big jump is treated as a paste');
  const me = r.engines[0].snapshot().meSlot;
  for (let i = 1; i <= 10; i += 1) {
    input.value = text.slice(0, i);
    input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  }
  assert.equal(PROG_MS, 500);
  wins[0].ticks[0]();
  wins[0].ticks[0]();
  await r.clock.advance(600);
  assert.equal(st(r).ps[me][0], 10);
  assert.ok(el.textContent.includes(text.slice(10)));
  for (let i = 11; i <= text.length; i += 1) {
    input.value = text.slice(0, i);
    input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  }
  await r.clock.advance(300);
  assert.equal(st(r).ps[me][1], 1);
  assert.equal(input.disabled, true);
  assert.ok(played.includes('win'));
  assert.match(el.textContent, /Round 1 of 5/);
  for (const v of views) v.destroy();
  assert.equal(wins[0].ticks.length, 0, 'the progress pump stops');
});
