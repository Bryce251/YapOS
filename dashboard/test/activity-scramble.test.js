import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, person } from './activity-kit.test.js';
import { installDom, type } from './dom-shim.js';
import scramble, { KEY, ROUND_MS, REVEAL_MS, PLACE_POINTS, LATE_POINTS, scrambleWord, judgeGuess, buildDeck, placePoints, letterKey, sameLetters, hintFrom, cleanGuess } from '../web/activity/js/games/scramble.js';
import { createScrambleView, scrambleMoments, localCheck, footText, ordinal, PROBLEMS } from '../web/activity/js/views/scramble.js';
import { WORDS, TIERS, SHORT, MEDIUM, LONG, wordById, idsIn, tierOf } from '../web/activity/data/scramble.js';
import { unmask, mask } from '../web/activity/js/games/draw.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import { cueKit } from '../web/activity/js/views/index.js';
import { jsonBytes, MAX_VALUE_BYTES, MAX_STATE_BYTES, stateBytes, MAX_KEYS } from '../web/activity/js/limits.js';

const WORDS_TXT = new URL('../web/activity/data/words.txt', import.meta.url);
const SCRAMBLE_SRC = [
  new URL('../web/activity/js/games/scramble.js', import.meta.url),
  new URL('../web/activity/js/views/scramble.js', import.meta.url),
  new URL('../web/activity/css/scramble.css', import.meta.url),
  new URL('../web/activity/data/scramble.js', import.meta.url),
];

dictionary.reset();
assert.equal(dictionary.useText(readFileSync(WORDS_TXT, 'utf8')), true);

const GAMES = [scramble];
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r, i = 0) {
  return r.engines[i].snapshot().state[KEY];
}

function target(s) {
  return wordById(unmask(s.w, s.k));
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: GAMES });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('scramble'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function guess(r, engine, text, wait = 400) {
  const s = engine.snapshot().state[KEY];
  engine.act({ type: 'guess', text, i: s.i });
  await r.clock.advance(wait);
}

function fakeApi(state, slots, opts = {}) {
  const store = { [KEY]: JSON.parse(JSON.stringify(state)) };
  const points = {};
  let t = opts.now ?? 1000;
  const api = {
    store,
    points,
    finished: false,
    deadlineAt: null,
    memory: opts.memory || {},
    settings: { rounds: 5, length: 'mixed', ...(opts.settings || {}) },
    random: Math.random,
    now: () => t,
    tick(ms) {
      t += ms;
    },
    players: () => slots.map((slot) => ({ slot })),
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    put: (k, v) => {
      if (v === null) delete store[k];
      else store[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(store),
    get deadline() {
      return api.deadlineAt;
    },
    setDeadline(at) {
      api.deadlineAt = at;
    },
    clearDeadline() {
      api.deadlineAt = null;
    },
    shift: (ends, ms) => Math.max(t + 3000, ends + ms),
    addPoints(slot, n) {
      points[slot] = (points[slot] || 0) + n;
    },
    finish() {
      api.finished = true;
    },
  };
  return api;
}

function roundState(word, extra = {}) {
  const k = 4242;
  const id = WORDS.indexOf(word);
  assert.ok(id >= 0, word);
  return { v: 1, k, deck: [mask(id, k), mask(WORDS.indexOf('apple'), k)], i: 0, total: 2, len: 'mixed', phase: 'play', w: mask(id, k), s: scrambleWord(word, Math.random, dictionary.isWord), tier: tierOf(word), got: [], no: {}, found: null, word: null, note: null, starts: 1000, ends: 1000 + ROUND_MS, ...extra };
}

function all(node, out = []) {
  for (const c of node.childNodes || []) {
    if (c.localName) out.push(c);
    all(c, out);
  }
  return out;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInlineStyles(root) {
  for (const el of all(root)) assert.equal(el.getAttribute('style'), null, `${el.localName}.${el.className} has an inline style`);
}

test('the word list has about 450 everyday words, 150 per length, all real and unique', () => {
  assert.ok(WORDS.length >= 430 && WORDS.length <= 480, `${WORDS.length}`);
  assert.equal(new Set(WORDS).size, WORDS.length);
  for (const w of WORDS) {
    assert.match(w, /^[a-z]{4,9}$/, w);
    assert.equal(dictionary.isWord(w), true, `${w} is in the dictionary`);
  }
  for (const t of TIERS) {
    const ids = idsIn(t.id);
    assert.ok(ids.length >= 140, `${t.id} has ${ids.length}`);
    for (const id of ids) assert.ok(WORDS[id].length >= t.min && WORDS[id].length <= t.max);
  }
  assert.equal(SHORT.length + MEDIUM.length + LONG.length, WORDS.length);
  assert.equal(tierOf('kiwi'), 'short');
  assert.equal(tierOf('rainbow'), 'medium');
  assert.equal(tierOf('pineapple'), 'long');
  assert.equal(wordById(-1), null);
  assert.equal(wordById(WORDS.length), null);
});

test('scrambles are never the word itself and avoid spelling another real word', () => {
  let rnd = 1;
  const random = () => {
    rnd = (rnd * 16807) % 2147483647;
    return rnd / 2147483647;
  };
  let clean = 0;
  for (const w of WORDS) {
    const s = scrambleWord(w, random, dictionary.isWord);
    assert.notEqual(s, w);
    assert.equal(letterKey(s), letterKey(w));
    if (!dictionary.isWord(s)) clean += 1;
  }
  assert.equal(clean, WORDS.length, 'no scramble is a real word');
  assert.equal(scrambleWord('aaaa', random), 'aaaa');
  assert.notEqual(scrambleWord('ab', () => 0), 'ab');
});

test('guesses must use the same letters; other real words with those letters count too', () => {
  assert.equal(judgeGuess('Heart', 'heart'), 'right');
  assert.equal(judgeGuess(' h e a r t ', 'heart'), 'right');
  assert.equal(judgeGuess('earth', 'heart'), 'other');
  assert.equal(judgeGuess('hater', 'heart'), 'other');
  assert.equal(judgeGuess('rathe', 'heart'), dictionary.isWord('rathe') ? 'other' : 'unknown');
  assert.equal(judgeGuess('ahert', 'heart'), 'unknown');
  assert.equal(judgeGuess('hearts', 'heart'), 'letters');
  assert.equal(judgeGuess('heard', 'heart'), 'letters');
  assert.equal(judgeGuess('', 'heart'), 'empty');
  assert.equal(judgeGuess('x'.repeat(60), 'heart'), 'empty');
  assert.equal(judgeGuess('earth', 'heart', { dictionary: false }), 'unknown', 'without the dictionary only the target counts');
  assert.equal(judgeGuess('heart', 'heart', { dictionary: false }), 'right');
  assert.equal(sameLetters('melon', 'lemon'), true);
  assert.equal(cleanGuess('Ap-ple!'), 'apple');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(placePoints), [100, 70, 50, 30, LATE_POINTS, LATE_POINTS]);
  assert.deepEqual(PLACE_POINTS, [100, 70, 50, 30]);
  assert.equal(ROUND_MS, 25000);
  assert.equal(hintFrom(1000, 1000 + ROUND_MS), 1000 + ROUND_MS / 2);
  assert.equal(hintFrom(1000, 61000), 1000 + ROUND_MS / 2);
});

test('decks respect the length setting and mixed decks go from short to long', () => {
  let s = 5;
  const random = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  for (const t of TIERS) {
    const deck = buildDeck(t.id, 10, random);
    assert.equal(deck.length, 10);
    assert.equal(new Set(deck).size, 10);
    for (const id of deck) assert.equal(tierOf(WORDS[id]), t.id);
  }
  const mixed = buildDeck('mixed', 10, random);
  assert.equal(mixed.length, 10);
  const lengths = mixed.map((id) => WORDS[id].length);
  assert.deepEqual(lengths.slice().sort((a, b) => a - b).map((n) => tierOf('x'.repeat(n))), lengths.map((n) => tierOf('x'.repeat(n))));
  assert.equal(buildDeck('mixed', 5, random).length, 5);
  assert.equal(buildDeck('mixed', 15, random).length, 15);
});

test('a full game: fastest solves score most, wrong guesses cost nothing, and it ends with results', async () => {
  const r = await startGame(3, { rounds: 5, length: 'short' });
  const [host, a, b] = r.engines;
  let s = st(r);
  assert.equal(s.phase, 'play');
  assert.equal(s.total, 5);
  assert.equal(s.ends - s.starts, ROUND_MS);
  const word = target(s);
  assert.equal(tierOf(word), 'short');
  assert.notEqual(s.s, word);
  assert.equal(letterKey(s.s), letterKey(word));
  await guess(r, b, 'zzzz');
  s = st(r);
  assert.equal(s.no[b.snapshot().meSlot], 1);
  assert.equal(scramble.model(b.snapshot()).wrong, 1);
  await guess(r, a, word);
  await guess(r, b, word);
  s = st(r);
  assert.equal(s.phase, 'play', 'still waiting for the host');
  assert.deepEqual(s.got.map((g) => g[1]), [100, 70]);
  await guess(r, a, word);
  assert.equal(st(r).got.length, 2, 'solving twice changes nothing');
  await guess(r, host, word);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'all');
  assert.equal(s.word, word);
  const scores = host.snapshot().scores.g;
  assert.equal(scores[a.snapshot().meSlot], 100);
  assert.equal(scores[b.snapshot().meSlot], 70);
  assert.equal(scores[host.snapshot().meSlot], 50);
  const m = scramble.model(b.snapshot());
  assert.equal(m.answer, word);
  assert.equal(m.place, 2);
  assert.equal(m.myPts, 70);
  assert.equal(m.got[0].place, 1);
  for (let i = 1; i < 5; i += 1) {
    await r.clock.advance(REVEAL_MS + 200);
    s = st(r);
    assert.equal(s.i, i);
    assert.equal(s.phase, 'play');
    await guess(r, host, target(s));
    await guess(r, a, target(s));
    await guess(r, b, target(s));
    assert.equal(st(r).phase, 'reveal');
  }
  await r.clock.advance(REVEAL_MS + 400);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.equal(snap.scores.g[host.snapshot().meSlot], 50 + 3 * 100 + 200, 'the final word counts double');
  assert.deepEqual(r.hub.violations, []);
});

test('nobody solving it runs out the clock, shows a first-letter hint at half time and reveals the answer', async () => {
  const r = await startGame(2, { rounds: 5, length: 'medium' });
  const [host] = r.engines;
  let s = st(r);
  const word = target(s);
  let m = scramble.model(host.snapshot());
  assert.equal(m.hint, null);
  assert.equal(m.answer, null);
  await r.clock.advance(ROUND_MS / 2 + 100);
  m = scramble.model(host.snapshot());
  assert.equal(m.hint, word[0]);
  assert.equal(JSON.stringify(st(r)).includes(word), false, 'the hint does not publish the word');
  await r.clock.advance(ROUND_MS / 2 + 100);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'time');
  assert.equal(s.word, word);
  assert.deepEqual(s.got, []);
  assert.match(footText(scramble.model(host.snapshot())), /Nobody unscrambled/);
  await r.clock.advance(REVEAL_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'play');
  assert.equal(s.i, 1);
  assert.equal(host.snapshot().scores.g[0] || 0, 0);
});

test('a different real word with the same letters is accepted and only named at the reveal', () => {
  const api = fakeApi(roundState('heart'), [0, 1, 2], { memory: { cur: { i: 0, words: {} } } });
  scramble.intent(api, 1, { type: 'guess', text: 'earth', i: 0 });
  let s = api.store[KEY];
  assert.deepEqual(s.got, [[1, 100]]);
  assert.equal(JSON.stringify(s).includes('earth'), false, 'the found word stays private while playing');
  assert.equal(JSON.stringify(s).includes('heart'), false);
  api.tick(400);
  scramble.intent(api, 2, { type: 'guess', text: 'ahert', i: 0 });
  s = api.store[KEY];
  assert.equal(s.no[2], 1);
  assert.equal(api.points[2], undefined);
  api.tick(100);
  scramble.intent(api, 2, { type: 'guess', text: 'heart', i: 0 });
  assert.equal(api.store[KEY].got.length, 1, 'guesses too close together are dropped');
  api.tick(400);
  scramble.intent(api, 2, { type: 'guess', text: 'heart', i: 0 });
  scramble.intent(api, 0, { type: 'guess', text: 'heart', i: 0 });
  s = api.store[KEY];
  assert.equal(s.phase, 'reveal');
  assert.equal(s.word, 'heart');
  assert.deepEqual(s.found, [[1, 'earth']]);
  assert.deepEqual(api.points, { 1: 100, 2: 70, 0: 50 });
});

test('a late joiner can solve right away and the round waits for them', async () => {
  const r = await startGame(2, { rounds: 5 });
  const [host, a] = r.engines;
  const word = target(st(r));
  await guess(r, a, word);
  const late = r.add(3);
  await r.clock.advance(600);
  if (late.lobby && typeof late.lobby.join === 'function') late.lobby.join();
  await r.clock.advance(600);
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  await guess(r, host, word);
  assert.equal(st(r).phase, 'play', 'the round waits for the new player');
  const m = scramble.model(late.snapshot());
  assert.equal(m.canGuess, true);
  assert.equal(m.answer, null);
  await guess(r, late, word);
  const s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(host.snapshot().scores.g[slot], 50);
  assert.deepEqual(r.hub.violations, []);
});

test('late join hook is safe on any phase and closes a round that is already done', () => {
  const api = fakeApi(roundState('lemon', { got: [[0, 100], [1, 70]] }), [0, 1]);
  scramble.join(api, 1);
  assert.equal(api.store[KEY].phase, 'reveal');
  scramble.join(api, 5);
  assert.equal(api.store[KEY].phase, 'reveal');
  const empty = fakeApi(roundState('lemon'), [0, 1, 2]);
  scramble.join(empty, 2);
  assert.equal(empty.store[KEY].phase, 'play');
  scramble.join(empty, 'x');
});

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

test('admins can skip to the reveal, then to the next word, and move the clock', async () => {
  resetAdmins();
  const OWNER = person(2).id;
  configureAdmins({
    fetch: async (url) => {
      const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
      return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null }) };
    },
    refreshMs: 0,
    win: null,
  });
  const r = room(3, { games: GAMES });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('scramble');
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  const before = st(r);
  owner.admin.run({ type: 'time', ms: 10000 });
  await settle(r.clock);
  let s = st(r);
  assert.equal(s.ends, before.ends + 10000);
  assert.equal(host.snapshot().room.deadline, s.ends);
  owner.admin.run({ type: 'time', ms: -600000 });
  await settle(r.clock);
  s = st(r);
  assert.ok(s.ends - host.now() >= 2000);
  assert.equal(host.snapshot().room.deadline, s.ends);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'skip');
  assert.equal(s.i, before.i);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'play');
  assert.equal(s.i, before.i + 1);
  resetAdmins();
});

test('admin hook refuses unknown actions and works on the fake api', () => {
  const api = fakeApi(roundState('apple'), [0]);
  assert.equal(scramble.admin(api, { type: 'nope' }), false);
  assert.equal(scramble.admin(api, { type: 'time', ms: 5000 }), true);
  assert.equal(api.store[KEY].ends, 1000 + ROUND_MS + 5000);
  assert.equal(api.deadlineAt, api.store[KEY].ends);
  assert.equal(scramble.admin(api, { type: 'skip' }), true);
  assert.equal(api.store[KEY].phase, 'reveal');
  assert.equal(scramble.admin(api, { type: 'skip' }), true);
  assert.equal(api.store[KEY].i, 1);
  assert.equal(scramble.admin(fakeApi({ ...roundState('apple'), phase: 'over' }, [0]), { type: 'skip' }), false);
});

test('when the host leaves mid-word the round ends gracefully and the game carries on', async () => {
  const r = await startGame(3, { rounds: 5 });
  const [host, a, b] = r.engines;
  const word = target(st(r));
  await guess(r, a, word);
  const aScore = host.snapshot().scores.g[a.snapshot().meSlot];
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(800);
  assert.equal(a.isHost(), true);
  let s = a.snapshot().state[KEY];
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'host');
  assert.equal(s.word, word);
  assert.match(footText(scramble.model(b.snapshot())), /host changed/);
  assert.equal(a.snapshot().scores.g[a.snapshot().meSlot], aScore);
  await r.clock.advance(REVEAL_MS + 300);
  s = a.snapshot().state[KEY];
  assert.equal(s.phase, 'play');
  assert.equal(s.i, 1);
  await guess(r, b, target(s));
  await guess(r, a, target(s));
  assert.equal(a.snapshot().state[KEY].phase, 'reveal');
  assert.deepEqual(r.hub.violations, []);
});

test('resume with no memory reveals instead of crashing, and resume in reveal keeps the clock', () => {
  const api = fakeApi(roundState('melon', { got: [[1, 100]] }), [0, 1]);
  scramble.resume(api);
  assert.equal(api.store[KEY].phase, 'reveal');
  assert.equal(api.store[KEY].note, 'host');
  assert.deepEqual(api.store[KEY].found, []);
  const later = fakeApi({ ...roundState('melon'), phase: 'reveal', ends: 9000 }, [0, 1]);
  scramble.resume(later);
  assert.equal(later.deadlineAt, 9000);
  const none = fakeApi(roundState('melon'), [0]);
  delete none.store[KEY];
  scramble.resume(none);
  assert.equal(none.store[KEY].phase, 'play');
});

test('fourteen players stay well under the shared state limits and the word is never in plain text', async () => {
  const r = await startGame(14, { rounds: 5, length: 'long' });
  const host = r.engines[0];
  for (let round = 0; round < 2; round += 1) {
    const s = st(r);
    const word = target(s);
    const plain = JSON.stringify(host.snapshot().state);
    assert.equal(plain.includes(word), false, 'the answer is masked');
    assert.equal(plain.includes(String(WORDS.indexOf(word))) && s.w === WORDS.indexOf(word), false);
    for (const e of r.engines.slice(1)) await guess(r, e, 'q'.repeat(word.length), 0);
    await r.clock.advance(400);
    for (const e of r.engines) await guess(r, e, word, 0);
    await r.clock.advance(600);
    const now = st(r);
    assert.equal(now.phase, 'reveal');
    assert.equal(now.got.length, 14);
    assert.deepEqual(now.got.slice(0, 5).map((g) => g[1]), [100, 70, 50, 30, 20]);
    assert.ok(jsonBytes(now) < MAX_VALUE_BYTES / 2, `${jsonBytes(now)} bytes`);
    const state = host.snapshot().state;
    assert.ok(stateBytes(state) < MAX_STATE_BYTES);
    assert.ok(Object.keys(state).length < MAX_KEYS);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.deepEqual(r.hub.violations, []);
});

test('the moments hook plays each cue once and never on the first render', () => {
  const base = { i: 0, phase: 'play', got: [], wrong: 0, hint: null, gotMe: false };
  let r = scrambleMoments(null, base);
  assert.deepEqual(r.cues, []);
  r = scrambleMoments(r.now, { ...base, got: [{ slot: 2 }] });
  assert.deepEqual(r.cues, ['pop']);
  r = scrambleMoments(r.now, { ...base, got: [{ slot: 2 }] });
  assert.deepEqual(r.cues, []);
  r = scrambleMoments(r.now, { ...base, got: [{ slot: 2 }], wrong: 1 });
  assert.deepEqual(r.cues, ['error']);
  r = scrambleMoments(r.now, { ...base, got: [{ slot: 2 }], wrong: 1, hint: 'a' });
  assert.deepEqual(r.cues, ['toggle']);
  r = scrambleMoments(r.now, { ...base, got: [{ slot: 2 }, { slot: 0 }], wrong: 1, hint: 'a', gotMe: true });
  assert.deepEqual(r.cues, ['correct']);
  r = scrambleMoments(r.now, { ...base, phase: 'reveal', got: [{ slot: 2 }, { slot: 0 }], wrong: 1, gotMe: true });
  assert.deepEqual(r.cues, ['reveal']);
  r = scrambleMoments(r.now, { ...base, i: 1 });
  assert.deepEqual(r.cues, ['turn']);
  for (const list of [r.cues]) for (const c of list) assert.equal(['start', 'win', 'coin'].includes(c), false);
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(22), '22nd');
});

test('the client checks letters before sending and knows when the dictionary says no', () => {
  const m = { size: 5, letters: Array.from('traeh'), check: 'heart' };
  assert.equal(localCheck('heart', m), null);
  assert.equal(localCheck('earth', m), null);
  assert.equal(localCheck('hear', m), 'size');
  assert.equal(localCheck('heard', m), 'letters');
  assert.equal(localCheck('ahetr', m), 'unknown');
  assert.equal(localCheck('', m), 'empty');
  for (const t of Object.values(PROBLEMS)) for (const re of BANNED) assert.equal(re.test(t), false, t);
});

test('the view renders play, solved and reveal without inline styles or leaking the word', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: GAMES });
  await r.clock.advance(500);
  const played = [];
  const cues = { play: (n) => played.push(n), burst() {}, float() {} };
  const win = { setInterval: () => 0, clearInterval() {} };
  const confetti = [];
  const views = r.engines.map((engine) => {
    const v = createScrambleView({ engine, fx: { confetti: (n) => confetti.push(n) }, toast() {}, win, cues });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  const [hostView, guestView] = views;
  const [host, guest] = r.engines;
  hostView.update(host.snapshot());
  assert.match(text(hostView.el), /Mixing up/);
  host.lobby.pick('scramble');
  host.lobby.start();
  await r.clock.advance(400);
  let s = st(r);
  const word = target(s);
  const shown = text(guestView.el);
  assert.match(shown, /Unscramble this word/);
  assert.match(shown, new RegExp(`Word 1 of ${s.total}`));
  assert.equal(shown.toLowerCase().replace(/\s+/g, '').includes(word), false, 'the word is hidden');
  assert.equal(played.length, 0, 'no cues on first render');
  noInlineStyles(guestView.el);
  const tiles = all(guestView.el).filter((x) => x.classList && x.classList.contains('scramble-tile'));
  assert.equal(tiles.length, word.length);
  const input = byKey(guestView.el, 'scramble-input');
  assert.equal(input.disabled, false);
  type(input, 'q'.repeat(word.length));
  assert.match(text(guestView.el), /Use only the letters shown/);
  assert.ok(played.includes('error'));
  byKey(guestView.el, 'scramble-clear').click();
  assert.equal(input.value, '');
  byKey(guestView.el, 'scramble-shuffle').click();
  assert.ok(played.includes('whoosh'));
  const order = all(byKey(guestView.el, 'tile-0').parentNode).map((x) => x.textContent.toLowerCase());
  for (const ch of word) {
    const j = order.findIndex((c, k) => c === ch && !byKey(guestView.el, `tile-${k}`).classList.contains('is-used'));
    assert.ok(j >= 0, `tile for ${ch}`);
    byKey(guestView.el, `tile-${j}`).click();
  }
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.got.length, 1);
  assert.ok(played.includes('correct'));
  assert.match(text(guestView.el), /Solved in 1st place! \+100/);
  assert.match(text(hostView.el), /1 player has solved it/);
  assert.ok(played.includes('pop'));
  assert.equal(confetti.length, 1);
  noInlineStyles(guestView.el);
  const solver = all(hostView.el).find((x) => x.classList && x.classList.contains('scramble-solver'));
  assert.ok(solver);
  const face = all(solver).find((x) => x.classList && x.classList.contains('avatar-btn'));
  assert.equal(face.getAttribute('role'), 'button');
  assert.equal(face.getAttribute('tabindex'), '0');
  assert.ok(face.getAttribute('data-profile-id'));
  assert.match(face.getAttribute('aria-label'), /^View .+'s profile$/);
  assert.ok(all(solver).some((x) => x.classList && x.classList.contains('medal-1')));
  await r.clock.advance(ROUND_MS / 2);
  hostView.update(host.snapshot());
  assert.match(text(hostView.el), new RegExp(`Hint: it starts with ${word[0].toUpperCase()}`));
  await r.clock.advance(ROUND_MS / 2 + 200);
  assert.equal(st(r).phase, 'reveal');
  const rev = text(hostView.el);
  assert.match(rev, /The word was/);
  assert.equal(rev.replace(/\s+/g, '').toLowerCase().includes(word), true);
  assert.match(text(guestView.el), /You got it in 1st place for \+100/);
  assert.ok(played.includes('reveal'));
  noInlineStyles(hostView.el);
  assert.equal(byKey(hostView.el, 'scramble-input').disabled, true);
  for (const name of played) assert.equal(['start', 'win', 'coin'].includes(name), false, name);
  for (const v of views) v.destroy();
  assert.deepEqual(r.hub.violations, []);
});

test('the view tells watchers what is going on and cueKit wraps the view', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: GAMES, join: false });
  await r.clock.advance(500);
  r.engines[0].join();
  await r.clock.advance(400);
  r.engines[0].lobby.pick('scramble');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const view = createScrambleView({ engine: r.engines[1], fx: {}, toast() {}, win: {}, cues: cueKit({ sfx: { play() {} }, juice: {} }) });
  view.update(r.engines[1].snapshot());
  assert.match(text(view.el), /You're watching/);
  assert.match(byKey(view.el, 'scramble-input').parentNode.parentNode.className, /is-hidden/);
  noInlineStyles(view.el);
  view.destroy();
});

test('scramble files follow the house rules', () => {
  for (const url of SCRAMBLE_SRC) {
    const src = readFileSync(url, 'utf8');
    assert.equal(/\/\*|(^|[^:'"`])\/\/(?!\S*['"`])/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")), false, `${url.pathname} has comments`);
    for (const re of BANNED) assert.equal(re.test(src), false, `${url.pathname} ${re}`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false);
    assert.equal(/https?:\/\//.test(src), false);
    if (url.pathname.endsWith('.css')) {
      assert.match(src, /prefers-reduced-motion/);
      const classes = [...src.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((x) => x[1]);
      const own = new Set(classes.filter((c) => c.startsWith('scramble-')));
      assert.ok(own.size > 10);
    }
  }
  assert.equal(scramble.category, 'words');
  assert.equal(scramble.minPlayers, 1);
  assert.equal(scramble.emoji, '🔀');
  assert.deepEqual(scramble.settings.find((x) => x.id === 'rounds').options.map((o) => o.value), [5, 8, 10, 15]);
  assert.equal(scramble.settings.find((x) => x.id === 'rounds').default, 8);
  assert.deepEqual(scramble.settings.find((x) => x.id === 'length').options.map((o) => o.value), ['mixed', 'short', 'medium', 'long']);
});

test('rude words that share the letters are never accepted, shown or used as a scramble', () => {
  for (const [word, rude] of [['pear', 'rape'], ['green', 'neger'], ['airplane', 'perianal'], ['doorbell', 'bordello'], ['hurricane', 'raunchier'], ['boomerang', 'boogerman'], ['song', 'snog']]) {
    assert.ok(WORDS.includes(word), word);
    assert.equal(judgeGuess(rude, word, { dictionary: true }), 'unknown', rude);
    const m = { size: word.length, letters: Array.from(word), check: word };
    assert.equal(localCheck(rude, m), 'unknown', rude);
    for (let i = 0; i < 200; i += 1) assert.notEqual(scrambleWord(word, Math.random, () => true), rude);
  }
  const api = fakeApi(roundState('pear'), [0, 1], { memory: { cur: { i: 0, words: {} } } });
  scramble.intent(api, 1, { type: 'guess', text: 'rape', i: 0 });
  assert.equal(api.store[KEY].got.length, 0);
  assert.equal(api.store[KEY].no[1], 1);
  api.tick(400);
  scramble.intent(api, 1, { type: 'guess', text: 'reap', i: 0 });
  assert.deepEqual(api.store[KEY].got, [[1, 100]]);
});

test('adding time never moves or hides a hint that is already showing', () => {
  assert.equal(hintFrom(1000, 1000 + ROUND_MS + 30000), 1000 + ROUND_MS / 2);
  assert.equal(hintFrom(1000, 11000), 6000);
  const api = fakeApi(roundState('heart'), [0, 1], { now: 1000 + 20000 });
  scramble.admin(api, { type: 'time', ms: 30000 });
  const snap = { state: { [KEY]: api.store[KEY] }, meSlot: 0, meJoined: true, now: api.now(), players: [] };
  assert.equal(scramble.model(snap).hint, 'h');
});

test('a solo player can play a whole game and every word ends the moment it is solved', async () => {
  const r = await startGame(1, { rounds: 5, length: 'medium' });
  const [host] = r.engines;
  for (let i = 0; i < 5; i += 1) {
    const s = st(r);
    assert.equal(s.i, i);
    assert.equal(tierOf(target(s)), 'medium');
    await guess(r, host, target(s));
    assert.equal(st(r).phase, 'reveal');
    await r.clock.advance(REVEAL_MS + 200);
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.equal(snap.scores.g[snap.meSlot], 600, 'the final word counts double');
  assert.deepEqual(r.hub.violations, []);
});

test('twelve players get through fifteen mixed words with timeouts, solves and no limit problems', async () => {
  const r = await startGame(12, { rounds: 15, length: 'mixed' });
  const host = r.engines[0];
  const lengths = [];
  for (let i = 0; i < 15; i += 1) {
    const s = st(r);
    assert.equal(s.i, i);
    lengths.push(target(s).length);
    if (i % 3 === 2) {
      await r.clock.advance(ROUND_MS + 200);
    } else {
      for (const e of r.engines.slice(0, 6)) await guess(r, e, target(s), 0);
      await r.clock.advance(500);
      for (const e of r.engines.slice(6)) await guess(r, e, target(s), 0);
      await r.clock.advance(500);
    }
    const now = st(r);
    assert.equal(now.phase, 'reveal');
    assert.equal(now.got.length, i % 3 === 2 ? 0 : 12);
    assert.ok(stateBytes(host.snapshot().state) < MAX_STATE_BYTES);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.ok(lengths[0] <= 5 && lengths[14] >= 8, lengths.join(','));
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  const total = Object.values(snap.scores.t).reduce((a, b) => a + b, 0);
  assert.equal(total, 10 * (100 + 70 + 50 + 30 + 20 * 8));
  assert.deepEqual(r.hub.violations, []);
});

test('a guess the host turns down plays the error sound once', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: GAMES });
  await r.clock.advance(500);
  const played = [];
  const cues = { play: (n) => played.push(n), burst() {}, float() {} };
  const win = { setInterval: () => 0, clearInterval() {} };
  const [host, guest] = r.engines;
  const view = createScrambleView({ engine: guest, fx: {}, win, cues });
  guest.on('change', (s) => view.update(s));
  host.lobby.pick('scramble');
  host.lobby.start();
  await r.clock.advance(400);
  view.update(guest.snapshot());
  const realAct = guest.act.bind(guest);
  guest.act = (a) => realAct({ ...a, text: 'zz' + a.text.slice(2) });
  const word = target(st(r));
  type(byKey(view.el, 'scramble-input'), word);
  await r.clock.advance(600);
  view.update(guest.snapshot());
  assert.equal(scramble.model(guest.snapshot()).wrong, 1);
  assert.equal(played.filter((n) => n === 'error').length, 1, played.join(','));
  assert.match(text(view.el), /Not quite/);
  view.destroy();
});
