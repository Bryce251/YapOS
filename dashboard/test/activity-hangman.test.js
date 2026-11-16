import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import hangman, { KEY, LIVES, WORD_COST, SOLVE_POINTS, LIFE_POINTS, SPEED_BONUS, LETTER_POINTS, LATE_MIN_MS, patternOf, scoreRound, buildDeck, playable, cleanLetter, cleanGuess } from '../web/activity/js/games/hangman.js';
import { createHangmanView, footText, hangmanMoment } from '../web/activity/js/views/hangman.js';
import { unmask } from '../web/activity/js/games/draw.js';
import { WORDS, CATEGORIES, wordById } from '../web/activity/data/hangman.js';
import { isBlockedGameWord } from '../web/activity/js/filter.js';
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

function secret(r) {
  const s = st(r);
  return wordById(unmask(s.deck[s.i], s.k)).w;
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [hangman] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('hangman'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function guessAll(r, e, letters) {
  for (const l of letters) {
    e.act({ type: 'letter', n: st(r).n, l });
    await r.clock.advance(60);
  }
  await r.clock.advance(300);
}

test('the word list has about 400 clean, unique words in ten topics', () => {
  assert.ok(WORDS.length >= 380, `${WORDS.length} words`);
  assert.equal(new Set(WORDS.map((w) => w.w)).size, WORDS.length);
  assert.equal(CATEGORIES.length, 10);
  for (const c of CATEGORIES) assert.ok(WORDS.filter((w) => w.cat === c.id).length >= 30, c.id);
  for (const w of WORDS) {
    assert.match(w.w, /^[a-z]{3,14}$/);
    assert.equal(isBlockedGameWord(w.w), false, w.w);
  }
  assert.equal(playable('animals').every((w) => w.cat === 'animals'), true);
  assert.equal(buildDeck(5, 'mix', () => 0.4).length, 5);
});

test('the game is a words game with rounds, a timer and a topic setting', () => {
  assert.equal(hangman.id, 'hangman');
  assert.equal(hangman.category, 'words');
  assert.equal(hangman.emoji, '🪢');
  assert.equal(hangman.minPlayers, 1);
  assert.deepEqual(hangman.settings.find((s) => s.id === 'rounds').options.map((o) => o.value), [3, 5, 7]);
  assert.ok(hangman.settings.find((s) => s.id === 'cat').options.some((o) => o.value === 'food'));
  for (const re of BANNED) assert.doesNotMatch(`${hangman.name} ${hangman.blurb}`, re);
});

test('helpers clean letters and guesses, build patterns and score rounds', () => {
  assert.equal(cleanLetter('A'), 'a');
  assert.equal(cleanLetter('ab'), null);
  assert.equal(cleanLetter('1'), null);
  assert.equal(cleanGuess(' Pan-cake '), 'pancake');
  assert.equal(cleanGuess('a'), null);
  assert.equal(patternOf('banana', 'an'), '_anana');
  const gained = scoreRound('banana', { 1: ['abn', 4, 1, 900], 2: ['anz', 5, 2, 1200], 3: ['nzq', 0, 0, 0], 4: ['xyz', 3, 0, 0] });
  assert.equal(gained[1], SOLVE_POINTS + 4 * LIFE_POINTS + SPEED_BONUS[0]);
  assert.equal(gained[2], SOLVE_POINTS + 5 * LIFE_POINTS + SPEED_BONUS[1]);
  assert.equal(gained[3], LETTER_POINTS);
  assert.equal(gained[4], undefined);
});

test('everyone guesses the same word at once with their own six lives', async () => {
  const r = await startGame(3, { rounds: 3 });
  const [a, b, c] = slotsOf(r);
  let s = st(r);
  assert.equal(s.phase, 'guess');
  assert.equal(s.word, null, 'the word stays hidden');
  const word = secret(r);
  assert.equal(s.len, word.length);
  assert.equal(JSON.stringify(s).includes(`"${word}"`), false);
  const letters = [...new Set(word)];
  const wrong = Array.from('qxzjvkwy').filter((l) => !word.includes(l));
  await guessAll(r, bySlot(r, a), letters);
  s = st(r);
  assert.equal(s.ps[a][2], 1, 'first to solve');
  assert.equal(s.ps[a][4], word);
  await guessAll(r, bySlot(r, b), wrong.slice(0, 2));
  s = st(r);
  assert.equal(s.ps[b][1], LIVES - 2);
  assert.equal(s.ps[b][4], '_'.repeat(word.length));
  bySlot(r, b).act({ type: 'letter', n: s.n, l: wrong[0] });
  await r.clock.advance(300);
  assert.equal(st(r).ps[b][1], LIVES - 2, 'the same letter twice costs nothing');
  bySlot(r, b).act({ type: 'word', n: s.n, w: word });
  await r.clock.advance(300);
  assert.equal(st(r).ps[b][2], 2);
  const bad = word.split('').reverse().join('') === word ? `${word.slice(1)}q` : word.split('').reverse().join('');
  bySlot(r, c).act({ type: 'word', n: s.n, w: bad.length === word.length ? bad : 'q'.repeat(word.length) });
  await r.clock.advance(300);
  assert.equal(st(r).ps[c][1], LIVES - WORD_COST);
  await guessAll(r, bySlot(r, c), wrong.slice(0, 4));
  s = st(r);
  assert.equal(s.phase, 'reveal', 'everyone is solved or out');
  assert.equal(s.word, word);
  assert.equal(s.gained[a], SOLVE_POINTS + LIVES * LIFE_POINTS + SPEED_BONUS[0]);
  assert.equal(s.gained[b], SOLVE_POINTS + (LIVES - 2) * LIFE_POINTS + SPEED_BONUS[1]);
  assert.equal(s.gained[c], undefined);
  assert.equal(r.engines[0].snapshot().scores.g[a], s.gained[a]);
  await r.clock.advance(7000);
  assert.equal(st(r).phase, 'guess');
  assert.equal(st(r).i, 1);
});

test('time running out reveals the word, then the game ends after the last word', async () => {
  const r = await startGame(2, { rounds: 3, timer: 45 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(st(r).phase, 'guess');
    await r.clock.advance(46000);
    assert.equal(st(r).phase, 'reveal');
    await r.clock.advance(7000);
  }
  assert.equal(r.hub.state.room.phase, 'results');
});

test('a late joiner gets their own lives, and a very late one waits for the next word', async () => {
  const r = room(2, { games: [hangman], join: true });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('hangman');
  r.engines[0].lobby.setting('timer', 45);
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const late = r.add(3);
  await r.clock.advance(800);
  const slot = late.snapshot().meSlot;
  assert.ok(st(r).in.includes(slot));
  assert.equal(st(r).ps[slot][1], LIVES);
  await r.clock.advance(45000 - LATE_MIN_MS);
  const later = r.add(4);
  await r.clock.advance(500);
  const s4 = later.snapshot().meSlot;
  assert.ok(st(r).wait.includes(s4));
  assert.equal(st(r).ps[s4], undefined);
});

test('the host leaving keeps every player’s progress', async () => {
  const r = await startGame(3);
  const word = secret(r);
  const slots = slotsOf(r);
  await guessAll(r, bySlot(r, slots[1]), [word[0]]);
  const before = st(r).ps[slots[1]][0];
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  assert.equal(st(r).phase, 'guess');
  assert.equal(st(r).ps[slots[1]][0], before);
  await guessAll(r, bySlot(r, slots[2]), [...new Set(word)]);
  assert.ok(st(r).ps[slots[2]][2] > 0, 'the new host still knows the word');
});

test('state stays under the value limit with a full room', async () => {
  const r = await startGame(20);
  const s = st(r);
  for (const slot of Object.keys(s.ps)) s.ps[slot] = ['abcdefghijklmnopqrstuvwxyz', 6, 1, 99999, 'x'.repeat(14)];
  s.len = 14;
  for (let i = 20; i < 36; i += 1) s.ps[i] = ['abcdefghijklmnopqrstuvwxyz', 6, 1, 99999, 'x'.repeat(14)];
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES, `${jsonBytes(s)} bytes`);
});

test('moments cue hits, misses, solving and the reveal', () => {
  const base = { n: 1, phase: 'guess', guessed: '', solved: false, out: false, pattern: [{ c: 'a', shown: false }] };
  assert.deepEqual(hangmanMoment(null, base).cues, []);
  const was = hangmanMoment(null, base).now;
  assert.deepEqual(hangmanMoment(was, { ...base, guessed: 'a', pattern: [{ c: 'a', shown: true }] }).cues, ['correct']);
  assert.deepEqual(hangmanMoment(was, { ...base, guessed: 'z' }).cues, ['wrong']);
  assert.deepEqual(hangmanMoment(was, { ...base, guessed: 'a', solved: true, pattern: [{ c: 'a', shown: true }] }).cues, ['correct', 'win']);
  assert.deepEqual(hangmanMoment(was, { ...base, phase: 'reveal' }).cues, ['reveal']);
  assert.match(footText({ phase: 'reveal', solved: false, myGain: 0, word: 'cat' }), /CAT/);
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

function profileFaces(root, min) {
  const faces = all(root).filter((n) => n.classList && n.classList.contains('avatar-btn') && n.getAttribute('data-profile-id'));
  assert.ok(faces.length >= min, `expected at least ${min} profile avatars, got ${faces.length}`);
  for (const f of faces) {
    assert.equal(f.getAttribute('role'), 'button');
    assert.equal(f.getAttribute('tabindex'), '0');
    assert.match(f.getAttribute('aria-label'), /^View (your|.+'s) profile$/);
  }
  return faces;
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

test('the view shows tiles, a keyboard and the other players, and taps send letters', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2);
  const played = [];
  const views = r.engines.map((engine, i) => {
    const v = createHangmanView({ engine, fx: { confetti() {} }, toast() {}, win: {}, cues: { play: (n) => i === 0 && played.push(n), burst() {}, float() {} } });
    engine.on('change', (s) => v.update(s));
    v.update(engine.snapshot());
    return v;
  });
  const word = secret(r);
  const el = views[0].el;
  assert.equal(all(el).filter((n) => n.classList && n.classList.contains('hangman-tile')).length, word.length);
  for (const n of all(el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  profileFaces(el, 2);
  const key = byKey(el, `letter-${word[0]}`);
  assert.ok(key);
  key.click();
  await r.clock.advance(200);
  assert.ok(st(r).ps[r.engines[0].snapshot().meSlot][0].includes(word[0]));
  assert.equal(byKey(el, `letter-${word[0]}`).disabled, true);
  assert.ok(played.includes('correct'));
  assert.match(el.textContent, /Word 1 of 5/);
  for (const v of views) v.destroy();
});
