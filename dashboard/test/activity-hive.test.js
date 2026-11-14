import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { room, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import hive, {
  KEY,
  MISS_KEY,
  REVEAL_PREFIX,
  REVEAL_MS,
  FAIL_MS,
  LOAD_MAX_MS,
  MIN_WORDS,
  MAX_WORDS,
  PANGRAM_BONUS,
  loadWords,
  wordsReady,
  wordsFailed,
  knownWord,
  hiveWords,
  pickPuzzle,
  checkWord,
  problemText,
  wordPoints,
  isPangram,
  lettersOf,
  maskOf,
  rankOf,
  packReveal,
  veil,
  unveil,
  candidates,
  RANKS,
} from '../web/activity/js/games/hive.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import { createHiveView, footText, hiveMoments, shuffled } from '../web/activity/js/views/hive.js';
import { SEEDS, WORDS } from '../web/activity/data/hive.js';
import { shiftEnd } from '../web/activity/js/engine.js';
import { jsonBytes, MAX_VALUE_BYTES, MAX_KEYS, MAX_STATE_BYTES, stateBytes } from '../web/activity/js/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(here, '..', 'web', 'activity', 'data', 'words.txt'), 'utf8');
const DICT = new Set(RAW.split('\n'));
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

await dictionary.load(() => Promise.resolve(RAW));

async function restoreWords() {
  dictionary.reset();
  await dictionary.load(() => Promise.resolve(RAW));
}

function st(r) {
  return r.engines[0].snapshot().state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startHive(n = 3, opts = {}) {
  const r = room(n, { games: [hive], seed: opts.seed });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('hive'), true);
  if (opts.timer) assert.equal(host.lobby.setting('timer', opts.timer), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function answers(s) {
  return hiveWords(s.l, s.c);
}

function word(w, id, q = 1) {
  return { type: 'word', x: veil(w, id), q, id };
}

async function say(r, slot, w, q = 1) {
  bySlot(r, slot).act(word(w, st(r).id, q));
  await r.clock.advance(400);
}

function resOf(r, slot) {
  const res = st(r).r || {};
  return res[slot] || [];
}

function checkLimits(state) {
  for (const [k, v] of Object.entries(state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, `${k} is ${jsonBytes(v)} bytes`);
  assert.ok(Object.keys(state).length <= MAX_KEYS);
  assert.ok(stateBytes(state) <= MAX_STATE_BYTES);
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

function fakeApi(opts = {}) {
  const state = {};
  const api = {
    t: 1_000_000,
    finished: null,
    points: {},
    dl: null,
    slots: opts.slots || [0, 1, 2],
    now: () => api.t,
    random: seeded(opts.seed || 5),
    settings: { timer: opts.timer || 120 },
    memory: {},
    players: () => api.slots.map((slot) => ({ slot, id: `p${slot}`, name: `P${slot}` })),
    nameOf: (s) => `P${s}`,
    get: (k) => (state[k] === undefined ? null : JSON.parse(JSON.stringify(state[k]))),
    put: (k, v) => {
      if (v === null) delete state[k];
      else state[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(state),
    get deadline() {
      return api.dl;
    },
    setDeadline: (at) => {
      api.dl = at;
    },
    clearDeadline: () => {
      api.dl = null;
    },
    shift: (ends, ms) => shiftEnd(ends, ms, api.t),
    addPoints: (slot, n) => {
      api.points[slot] = (api.points[slot] || 0) + n;
    },
    finish: (w) => {
      api.finished = w || true;
    },
    state,
  };
  return api;
}

test('the seed list has about 220 everyday words with exactly seven different letters', () => {
  assert.ok(SEEDS.length >= 200 && SEEDS.length <= 260, String(SEEDS.length));
  assert.equal(new Set(SEEDS).size, SEEDS.length);
  const masks = new Set();
  for (const s of SEEDS) {
    assert.match(s, /^[a-z]+$/);
    assert.equal(lettersOf(s).length, 7, s);
    assert.ok(DICT.has(s), `${s} is in the word list`);
    masks.add(maskOf(s));
  }
  assert.equal(masks.size, SEEDS.length, 'no two seeds share the same letters');
  assert.ok(WORDS.length > 3000);
  assert.deepEqual(WORDS, [...new Set(WORDS)].sort(), 'the word list is sorted with no repeats');
  for (const w of WORDS) {
    assert.match(w, /^[a-z]{4,}$/);
    assert.ok(DICT.has(w), `${w} is in the dictionary`);
  }
  for (const s of SEEDS) assert.ok(WORDS.includes(s), `${s} is an everyday word`);
});

test('every seed has fair puzzles: 20 to 150 words with the middle letter, and a pangram', () => {
  let combos = 0;
  for (const seed of SEEDS) {
    const letters = lettersOf(seed);
    let fair = 0;
    for (const centre of letters) {
      const words = hiveWords(letters, centre);
      assert.deepEqual(words, words.slice().sort());
      assert.ok(words.every((w) => w.length >= 4 && w.includes(centre) && [...w].every((ch) => letters.includes(ch))));
      if (words.length >= MIN_WORDS && words.length <= MAX_WORDS && words.some((w) => isPangram(w, letters))) fair += 1;
    }
    assert.ok(fair >= 1, `${seed} has a fair middle letter`);
    combos += fair;
  }
  assert.ok(combos > SEEDS.length * 3, `${combos} different puzzles`);
});

test('scoring: four letters is one point, longer words score their length, pangrams get a bonus', () => {
  const letters = lettersOf('kitchen');
  assert.equal(wordPoints('kite', letters), 1);
  assert.equal(wordPoints('niche', letters), 5);
  assert.equal(wordPoints('thicken', letters), 7 + PANGRAM_BONUS);
  assert.equal(wordPoints('kitchen', letters), 7 + PANGRAM_BONUS);
  assert.equal(isPangram('kitchen', letters), true);
  assert.equal(isPangram('kitten', letters), false);
  assert.equal(wordPoints('kit', letters), 0);
});

test('words are checked for length, hive letters, the middle letter and repeats', () => {
  const puzzle = { letters: lettersOf('kitchen'), centre: 'k' };
  assert.equal(checkWord('', puzzle, []), 'empty');
  assert.equal(checkWord('ki te', puzzle, []), 'letters');
  assert.equal(checkWord('kin', puzzle, []), 'short');
  assert.equal(checkWord('kites', puzzle, []), 'outside');
  assert.equal(checkWord('niche', puzzle, []), 'centre');
  assert.equal(checkWord('kite', puzzle, ['kite']), 'found');
  assert.equal(checkWord('Kitten', puzzle, []), null);
  assert.equal(checkWord('kittne', puzzle, []), 'unknown');
  assert.equal(checkWord('kittne', puzzle, [], { dictionary: false }), null);
  assert.equal(checkWord('kitten', puzzle, [], { answers: new Set(['kite']) }), 'unknown');
  assert.match(problemText('centre', 'k'), /needs K/);
  for (const code of ['empty', 'letters', 'short', 'long', 'outside', 'centre', 'found', 'unknown', 'late', 'x']) {
    const t = problemText(code, 'k');
    assert.ok(t.length > 5);
    for (const re of BANNED) assert.equal(re.test(t), false, t);
  }
});

test('hive words use only the hive letters and always the middle letter', () => {
  const letters = lettersOf('kitchen');
  const words = hiveWords(letters, 'k');
  assert.ok(words.length > 0);
  for (const w of words) {
    assert.ok(w.length >= 4);
    assert.ok(w.includes('k'));
    assert.ok([...w].every((ch) => letters.includes(ch)));
  }
  assert.ok(words.includes('kitten'));
  assert.equal(words.includes('kinnikinnick'), false, 'rare dictionary oddities are left out');
  assert.equal(knownWord('kitten', letters, 'k'), true);
  assert.equal(knownWord('kittne', letters, 'k'), false);
  assert.equal(knownWord('kitten', 'abc', 'a'), null);
  assert.equal(knownWord('kitten', letters, 'z'), null);
  assert.ok(candidates(letters, 'k').includes('kitten'));
});

test('words travel veiled, so they never show up in plain text', () => {
  for (const id of [0, 7, 123456789, 999999999]) {
    for (const w of ['kitchen', 'kite', 'zzzz', 'abcdefghijklmnopqrstuvwxyz']) {
      const v = veil(w, id);
      assert.match(v, /^[a-z]+$/);
      assert.equal(v.length, w.length);
      assert.equal(unveil(v, id), w);
    }
  }
  assert.notEqual(veil('kitchen', 123456789), 'kitchen');
});

test('puzzles are re-rolled until they have 20 to 150 words', () => {
  const random = seeded(3);
  for (let i = 0; i < 30; i += 1) {
    const p = pickPuzzle(random);
    assert.ok(p);
    assert.ok(p.words.length >= MIN_WORDS && p.words.length <= MAX_WORDS, `${p.seed}/${p.centre}: ${p.words.length}`);
    assert.equal(p.letters.length, 7);
    assert.ok(p.letters.includes(p.centre));
    assert.ok(p.words.some((w) => isPangram(w, p.letters)));
  }
  const loose = pickPuzzle(seeded(4), { seeds: ['kitchen'], words: ['kite', 'kitten', 'kitchen'], tries: 5 });
  assert.ok(loose, 'falls back to the closest puzzle when none fit');
  assert.deepEqual(loose.words, ['kitchen', 'kite', 'kitten']);
  assert.equal(pickPuzzle(seeded(4), { seeds: [] }), null);
  const centres = new Set();
  for (let i = 0; i < 40; i += 1) centres.add(pickPuzzle(random).centre);
  assert.ok(centres.size > 5, 'the middle letter changes from game to game');
});

test('ranks climb with points', () => {
  assert.equal(rankOf(0, 200).name, RANKS[0].name);
  assert.equal(rankOf(200, 200).name, RANKS[RANKS.length - 1].name);
  assert.equal(rankOf(200, 200).pct, 100);
  assert.equal(rankOf(200, 200).next, null);
  const r = rankOf(5, 200);
  assert.equal(r.next, RANKS[r.step + 1].name);
  assert.ok(r.need > 0);
  assert.equal(rankOf(0, 0).name, RANKS[0].name);
});

test('a full game: everyone plays at once, scores live, words stay private, then a reveal', async () => {
  const r = await startHive(3, { timer: 90 });
  let s = st(r);
  assert.equal(s.phase, 'play');
  assert.equal(s.ends - s.starts, 90000);
  assert.equal(s.l.length, 7);
  assert.ok(s.total >= MIN_WORDS && s.total <= MAX_WORDS);
  assert.deepEqual(Object.keys(s.b).map(Number).sort(), [0, 1, 2]);
  const list = answers(s);
  assert.equal(list.length, s.total);
  assert.equal(s.max, list.reduce((a, w) => a + wordPoints(w, s.l), 0));
  const pangram = list.find((w) => isPangram(w, s.l));
  const four = list.find((w) => w.length === 4 && !isPangram(w, s.l));
  const others = list.filter((w) => w !== pangram && w !== four);
  await say(r, 0, pangram, 1);
  await say(r, 0, others[0], 2);
  await say(r, 1, others[0], 1);
  await say(r, 2, others[1], 1);
  if (four) await say(r, 2, four, 2);
  s = st(r);
  const p0 = wordPoints(pangram, s.l) + wordPoints(others[0], s.l);
  assert.deepEqual(s.b[0], [p0, 2, 1]);
  assert.deepEqual(s.b[1], [wordPoints(others[0], s.l), 1, 0]);
  assert.equal(s.b[2][1], four ? 2 : 1);
  assert.equal(s.last.s, 0);
  assert.equal(r.engines[0].snapshot().scores.g[0], p0);
  assert.deepEqual(resOf(r, 0).map((x) => x[1]), ['ok', 'ok']);
  for (const e of r.engines) {
    const flat = JSON.stringify(e.snapshot().state);
    for (const w of [pangram, others[0], others[1]]) assert.equal(flat.includes(`"${w}"`), false, `${w} leaked during play`);
    checkLimits(e.snapshot().state);
  }
  const m1 = hive.model(bySlot(r, 1).snapshot());
  assert.equal(m1.canPlay, true);
  assert.equal(m1.me.count, 1);
  assert.equal(m1.board[0].slot, 0);
  assert.equal(m1.last.slot, 0);
  await r.clock.advance(90000);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.ends - s.starts, REVEAL_MS);
  const state = r.engines[1].snapshot().state;
  assert.ok(s.chunks >= 1);
  const rows = state[`${REVEAL_PREFIX}0`].p;
  const row0 = rows.find((x) => x[0] === 0);
  assert.equal(row0[1][0], pangram, 'the best word comes first');
  assert.ok(row0[1].includes(others[0]));
  const miss = state[MISS_KEY];
  assert.equal(miss.n, list.length - (four ? 4 : 3));
  assert.ok(!miss.w.includes(pangram));
  assert.ok(miss.w.length <= 18);
  assert.deepEqual(s.r, {});
  const m = hive.model(r.engines[2].snapshot());
  assert.equal(m.phase, 'reveal');
  assert.equal(m.reveal.pangramBy.map((p) => p.slot).join(), '0');
  const p1 = m.reveal.players.find((p) => p.slot === 1);
  assert.equal(p1.words[0].only, false, 'shared words are not marked as unique');
  const p2 = m.reveal.players.find((p) => p.slot === 2);
  assert.equal(p2.words.find((x) => x.w === others[1]).only, true);
  checkLimits(state);
  await r.clock.advance(REVEAL_MS + 300);
  const room0 = r.engines[0].snapshot().room;
  assert.equal(room0.phase, 'results');
  assert.deepEqual(room0.last.winners, [0]);
  assert.deepEqual(r.hub.violations, []);
});

test('the host refuses bad words and tells only the sender why', async () => {
  const r = await startHive(2);
  const s = st(r);
  const outer = s.l.replace(s.c, '');
  const missing = 'abcdefghijklmnopqrstuvwxyz'.split('').find((ch) => !s.l.includes(ch));
  const list = answers(s);
  await say(r, 1, s.c.repeat(2), 1);
  await say(r, 1, `${s.c}${missing}${s.c}${s.c}`, 2);
  await say(r, 1, outer.slice(0, 4), 3);
  await say(r, 1, `${s.c}${s.c}${s.c}${s.c}${s.c}`, 4);
  assert.deepEqual(resOf(r, 1).map((x) => x[1]), ['outside', 'centre', 'unknown']);
  await say(r, 1, list[0], 5);
  await say(r, 1, list[0], 6);
  assert.deepEqual(resOf(r, 1).slice(-2).map((x) => [x[0], x[1]]), [[5, 'ok'], [6, 'found']]);
  assert.equal(st(r).b[1][1], 1);
  bySlot(r, 0).act(word(list[1], 12345));
  await r.clock.advance(400);
  assert.equal(st(r).b[0][1], 0, 'words for an old puzzle are ignored');
  bySlot(r, 0).act({ type: 'word', x: 42, q: 'x', id: s.id });
  bySlot(r, 0).act({ type: 'word', w: list[1], q: 7, id: s.id });
  bySlot(r, 0).act({ type: 'word', x: veil(list[1], s.id), q: 8 });
  await r.clock.advance(400);
  assert.equal(st(r).b[0][1], 0, 'plain, broken or unlabelled words are ignored');
  assert.deepEqual(r.hub.violations, []);
});

test('someone who joins late gets a spot on the board and can play', async () => {
  const r = await startHive(2);
  r.add(3);
  await r.clock.advance(800);
  const late = r.engines[2];
  const slot = late.snapshot().meSlot;
  assert.equal(slot, 2);
  assert.deepEqual(st(r).b[slot], [0, 0, 0]);
  const m = hive.model(late.snapshot());
  assert.equal(m.canPlay, true);
  const w = answers(st(r))[0];
  late.act(word(w, st(r).id));
  await r.clock.advance(400);
  assert.equal(st(r).b[slot][1], 1);
  assert.deepEqual(r.hub.violations, []);
});

test('admins can skip to the reveal, skip the reveal, and add or remove time', () => {
  const api = fakeApi();
  hive.start(api);
  let s = api.get(KEY);
  assert.equal(s.phase, 'play');
  assert.equal(api.dl, s.ends);
  assert.equal(hive.admin(api, { type: 'time', ms: 30000 }), true);
  assert.equal(api.get(KEY).ends, s.ends + 30000);
  assert.equal(api.dl, s.ends + 30000);
  assert.equal(hive.admin(api, { type: 'time', ms: -600000 }), true);
  assert.equal(api.get(KEY).ends, api.t + 3000);
  assert.equal(hive.admin(api, { type: 'nope' }), false);
  const w = hiveWords(s.l, s.c)[0];
  hive.intent(api, 1, word(w, s.id));
  assert.equal(api.points[1], wordPoints(w, s.l));
  assert.equal(hive.admin(api, { type: 'skip' }), true);
  s = api.get(KEY);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'skip');
  assert.equal(api.state[`${REVEAL_PREFIX}0`].p.find((x) => x[0] === 1)[1][0], w);
  assert.equal(hive.admin(api, { type: 'time', ms: 10000 }), true);
  assert.equal(api.get(KEY).ends, s.ends + 10000);
  assert.equal(hive.admin(api, { type: 'skip' }), true);
  assert.equal(api.finished, true);
});

test('words sent after time runs out do not count', () => {
  const api = fakeApi();
  hive.start(api);
  const s = api.get(KEY);
  api.t = s.ends + 1;
  hive.intent(api, 0, word(hiveWords(s.l, s.c)[0], s.id, 9));
  assert.deepEqual(api.get(KEY).r[0], [[9, 'late', 0]]);
  assert.equal(api.points[0], undefined);
});

test('when the host leaves mid-game the round ends gracefully and scores still count', async () => {
  const r = await startHive(3);
  const [host, a] = r.engines;
  const list = answers(st(r));
  await say(r, 1, list[0], 1);
  await say(r, 2, list[1], 1);
  const pts1 = st(r).b[1][0];
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(800);
  assert.equal(a.isHost(), true);
  const s = a.snapshot().state[KEY];
  assert.equal(s.phase, 'reveal');
  assert.equal(s.lost, true);
  assert.equal(s.note, 'host');
  assert.equal(s.b[1][0], pts1);
  assert.equal(a.snapshot().scores.g[1], pts1);
  const m = hive.model(a.snapshot());
  assert.equal(m.reveal.lost, true);
  assert.equal(m.reveal.players.length, 0);
  assert.ok(m.reveal.missed.length > 0, 'the new host shows some great words from the hive');
  assert.match(footText(m), /host changed/);
  await r.clock.advance(REVEAL_MS + 300);
  assert.equal(a.snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('resume copes with every phase and missing memory', () => {
  const api = fakeApi();
  hive.resume(api);
  assert.equal(api.get(KEY).phase, 'play', 'no state means a fresh start');
  api.memory = {};
  hive.resume(api);
  assert.equal(api.get(KEY).phase, 'reveal');
  api.dl = null;
  hive.resume(api);
  assert.equal(api.dl, api.get(KEY).ends);
  hive.deadline(api);
  assert.equal(api.finished, true);
  const empty = fakeApi();
  hive.deadline(empty);
  assert.equal(empty.finished, true);
});

test('state stays well under the limits with 16 busy players', async () => {
  const r = await startHive(16, { timer: 180 });
  const s = st(r);
  const list = answers(s);
  for (let round = 0; round < 6; round += 1) {
    for (let slot = 0; slot < 16; slot += 1) {
      const w = list[(slot * 3 + round) % list.length];
      bySlot(r, slot).act(word(w, s.id, round + 1));
    }
    await r.clock.advance(1200);
    checkLimits(r.engines[0].snapshot().state);
  }
  for (const slot of [0, 1]) {
    for (let i = 0; i < list.length; i += 4) bySlot(r, slot).act(word(list[i], s.id, 100 + i));
    await r.clock.advance(3000);
  }
  assert.ok(st(r).b[0][1] > 6);
  const before = r.engines[3].snapshot().state;
  const flat = JSON.stringify(before);
  for (const w of list) assert.equal(flat.includes(`"${w}"`), false);
  await r.clock.advance(180000);
  assert.equal(st(r).phase, 'reveal');
  const state = r.engines[5].snapshot().state;
  checkLimits(state);
  const m = hive.model(r.engines[5].snapshot());
  assert.equal(m.reveal.players.length, 16);
  assert.deepEqual(r.hub.violations, []);
});

test('a solo game: one player can find every word and the reveal comes early', async () => {
  const r = await startHive(1);
  const s = st(r);
  assert.equal(s.phase, 'play');
  const list = answers(s);
  let q = 1;
  for (const w of list) {
    r.engines[0].act(word(w, s.id, q));
    q += 1;
  }
  await r.clock.advance(600);
  const done = st(r);
  assert.equal(done.phase, 'reveal');
  assert.equal(done.note, 'all');
  assert.equal(done.b[0][0], s.max);
  assert.equal(r.engines[0].snapshot().scores.g[0], s.max);
  const m = hive.model(r.engines[0].snapshot());
  assert.equal(m.reveal.missed.length, 0);
  assert.equal(m.reveal.players[0].words.length + m.reveal.players[0].more, list.length);
  assert.ok(m.reveal.players[0].words.every((x) => !x.only), 'nobody to compare with means no highlights');
  await r.clock.advance(REVEAL_MS + 300);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('twelve players and a watcher play a full round to the results', async () => {
  const r = room(13, { games: [hive], join: false });
  for (const e of r.engines.slice(0, 12)) e.join();
  await r.clock.advance(800);
  const host = r.engines[0];
  host.lobby.pick('hive');
  host.lobby.setting('timer', 120);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const s = st(r);
  const list = answers(s);
  const watcher = r.engines[12];
  assert.equal(watcher.snapshot().meJoined, false);
  assert.equal(st(r).b[watcher.snapshot().meSlot], undefined);
  const wm = hive.model(watcher.snapshot());
  assert.equal(wm.playing, false);
  assert.equal(wm.canPlay, false);
  assert.match(footText(wm), /watching/);
  assert.equal(watcher.act(word(list[0], s.id)), false, 'watchers cannot play');
  for (let slot = 0; slot < 12; slot += 1) {
    for (let k = 0; k <= slot % 4; k += 1) bySlot(r, slot).act(word(list[(slot + k * 5) % list.length], s.id, k + 1));
    await r.clock.advance(250);
  }
  await r.clock.advance(2000);
  const mid = st(r);
  for (let slot = 0; slot < 12; slot += 1) assert.equal(mid.b[slot][1], (slot % 4) + 1, `slot ${slot}`);
  checkLimits(host.snapshot().state);
  await r.clock.advance(120000);
  assert.equal(st(r).phase, 'reveal');
  const m = hive.model(watcher.snapshot());
  assert.equal(m.reveal.players.length, 12);
  checkLimits(watcher.snapshot().state);
  await r.clock.advance(REVEAL_MS + 300);
  const room0 = host.snapshot().room;
  assert.equal(room0.phase, 'results');
  const best = Math.max(...Object.values(mid.b).map((x) => x[0]));
  const top = Object.keys(mid.b).map(Number).filter((k) => mid.b[k][0] === best);
  assert.deepEqual(room0.last.winners.slice().sort((a, b) => a - b), top);
  assert.deepEqual(r.hub.violations, []);
});

test('reveal packing splits big lists across keys and trims to fit', () => {
  const long = (n) => Array.from({ length: n }, (_, i) => `word${String(i).padStart(4, 'x')}abcdefg`);
  const entries = Array.from({ length: 36 }, (_, s) => [s, long(150)]);
  const chunks = packReveal(entries);
  assert.ok(chunks.length <= 8);
  for (const c of chunks) assert.ok(jsonBytes(c) <= MAX_VALUE_BYTES);
  const rows = chunks.flatMap((c) => c.p);
  assert.equal(rows.length, 36);
  assert.ok(rows.every((x) => x[2] > 0 && x[1].length + x[2] === 150));
  const small = packReveal([[0, ['kite']], [1, []]]);
  assert.deepEqual(small, [{ p: [[0, ['kite'], 0], [1, [], 0]] }]);
});

test('if the word list cannot load the game says so and ends', async () => {
  dictionary.reset();
  try {
    await loadWords(() => Promise.reject(new Error('offline')));
    assert.equal(wordsFailed(), true);
    assert.equal(knownWord('kitten', lettersOf('kitchen'), 'k'), true, 'the client can still check words from the puzzle list');
    const r = await startHive(2);
    assert.equal(st(r).phase, 'load', 'the host tries the word list once more');
    await r.clock.advance(1000);
    const s = st(r);
    assert.equal(s.phase, 'fail');
    const m = hive.model(r.engines[1].snapshot());
    assert.match(footText(m), /didn't load/);
    await r.clock.advance(FAIL_MS + 300);
    assert.equal(r.engines[0].snapshot().room.phase, 'results');
  } finally {
    await restoreWords();
  }
  assert.equal(wordsReady(), true);
});

test('the host waits for the word list, then starts or gives up', async () => {
  dictionary.reset();
  let release = null;
  try {
    const slow = loadWords(() => new Promise((ok) => (release = ok)));
    await Promise.resolve();
    await Promise.resolve();
    const api = fakeApi();
    hive.start(api);
    assert.equal(api.get(KEY).phase, 'load');
    api.t += 500;
    hive.deadline(api);
    assert.equal(api.get(KEY).phase, 'load');
    release(RAW);
    await slow;
    api.t += 500;
    hive.deadline(api);
    assert.equal(api.get(KEY).phase, 'play');
    dictionary.reset();
    loadWords(() => new Promise(() => {}));
    const stuck = fakeApi();
    hive.start(stuck);
    stuck.t += LOAD_MAX_MS + 1;
    hive.deadline(stuck);
    assert.equal(stuck.get(KEY).phase, 'fail');
    stuck.t += FAIL_MS;
    hive.deadline(stuck);
    assert.equal(stuck.finished, true);
  } finally {
    await restoreWords();
  }
});

test('cues fire once per moment and never on the first render', () => {
  const play = { phase: 'play', id: 1, last: null };
  assert.deepEqual(hiveMoments(null, { ...play, phase: 'reveal' }).cues, []);
  const a = hiveMoments(null, play).now;
  assert.deepEqual(hiveMoments(a, { ...play, phase: 'reveal' }).cues, ['reveal']);
  const b = hiveMoments(a, { ...play, last: { n: 1, isMe: false } });
  assert.deepEqual(b.cues, ['pop']);
  assert.deepEqual(hiveMoments(b.now, { ...play, last: { n: 1, isMe: false } }).cues, []);
  assert.deepEqual(hiveMoments(a, { ...play, last: { n: 1, isMe: true } }).cues, []);
  assert.deepEqual(hiveMoments({ ...a, phase: 'load' }, play).cues, ['turn']);
  const s = shuffled(['a', 'b', 'c', 'd', 'e', 'f'], seeded(2));
  assert.deepEqual(s.slice().sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('the view: honeycomb typing, instant feedback, scores, reveal, all without inline styles', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [hive] });
  await r.clock.advance(500);
  const played = r.engines.map(() => []);
  const views = r.engines.map((engine, i) => {
    const cues = { play: (name) => played[i].push(name), burst() {}, float() {} };
    const v = createHiveView({ engine, fx: { confetti() {} }, toast() {}, cues });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  r.engines[0].lobby.pick('hive');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const s = st(r);
  const mine = views[0];
  noInlineStyles(mine.el);
  assert.equal(played[0].includes('start'), false);
  assert.ok(text(mine.el).includes(`Make words with ${s.c.toUpperCase()}`));
  assert.ok(byKey(mine.el, 'hive-centre'));
  for (let i = 0; i < 6; i += 1) assert.ok(byKey(mine.el, `hive-cell-${i}`), `cell ${i}`);
  const fill = all(mine.el).find((el) => el.classList.contains('hive-rank-fill'));
  assert.equal(fill.style.props['--pct'], '0');
  const input = byKey(mine.el, 'hive-input');
  assert.equal(input.disabled, false);
  byKey(mine.el, 'hive-centre').click();
  byKey(mine.el, 'hive-centre').click();
  assert.equal(input.value, s.c + s.c);
  byKey(mine.el, 'hive-delete').click();
  assert.equal(input.value, s.c);
  const key = (k) => {
    const e = new FakeEvent('keydown', { bubbles: true, key: k });
    byKey(mine.el, 'hive-cell-0').dispatchEvent(e);
    return e;
  };
  assert.equal(key(s.c.toUpperCase()).defaultPrevented, true);
  assert.equal(input.value, s.c + s.c);
  key('Backspace');
  assert.equal(input.value, s.c);
  byKey(mine.el, 'hive-enter').click();
  assert.match(text(mine.el), /Too short/);
  assert.equal(played[0].filter((x) => x === 'error').length, 1);
  const outerOnly = s.l.replace(s.c, '').slice(0, 4);
  input.value = outerOnly;
  byKey(mine.el, 'hive-enter').click();
  assert.match(text(mine.el), /Missing the middle letter/);
  input.value = `${s.c}${s.c}${s.c}${s.c}`;
  byKey(mine.el, 'hive-enter').click();
  assert.match(text(mine.el), /not in this hive's word list/);
  const before = byKey(mine.el, 'hive-cell-0').dataset.letter;
  const order = () => [0, 1, 2, 3, 4, 5].map((i) => byKey(mine.el, `hive-cell-${i}`).dataset.letter).join('');
  const was = order();
  byKey(mine.el, 'hive-shuffle').click();
  assert.equal(order().split('').sort().join(''), was.split('').sort().join(''));
  assert.ok(before);
  const list = answers(s);
  const w = list.find((x) => !isPangram(x, s.l)) || list[0];
  input.value = w;
  byKey(mine.el, 'hive-enter').click();
  assert.ok(played[0].includes('send'));
  assert.equal(input.value, '');
  assert.match(text(mine.el), /You found 1 word/);
  input.value = w;
  byKey(mine.el, 'hive-enter').click();
  assert.match(text(mine.el), /already found/);
  await r.clock.advance(500);
  assert.match(text(views[1].el), new RegExp(`1 word · ${wordPoints(w, s.l)}`));
  assert.doesNotMatch(text(views[1].el), new RegExp(`\\b${w}\\b`), 'others cannot see my words');
  noInlineStyles(mine.el);
  noInlineStyles(views[1].el);
  const pangram = list.find((x) => isPangram(x, s.l));
  bySlot(r, 1).act(word(pangram, s.id));
  await r.clock.advance(500);
  assert.match(text(mine.el), /found a pangram/);
  assert.ok(played[0].includes('pop'));
  await r.clock.advance(s.ends - r.clock.now() + 300);
  assert.equal(st(r).phase, 'reveal');
  const rv = text(mine.el);
  assert.match(rv, /Time’s up/);
  assert.match(rv, /Pangram found by/);
  assert.match(rv, new RegExp(w));
  assert.match(rv, /Best words nobody found/);
  assert.equal(played[0].filter((x) => x === 'reveal').length, 1);
  assert.ok(all(mine.el).some((el) => el.classList.contains('is-hidden') && el.classList.contains('hive-entry')));
  noInlineStyles(mine.el);
  for (const n of played.flat()) assert.notEqual(n, 'win');
  for (const n of played.flat()) assert.notEqual(n, 'coin');
  for (const v of views) v.destroy();
});

test('the view shows loading and failure messages', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  dictionary.reset();
  try {
    await loadWords(() => Promise.reject(new Error('offline')));
    const r = room(1, { games: [hive] });
    await r.clock.advance(500);
    const v = createHiveView({ engine: r.engines[0], fx: { confetti() {} }, toast() {}, cues: null });
    r.engines[0].on('change', (s) => v.update(s));
    r.engines[0].lobby.pick('hive');
    r.engines[0].lobby.start();
    await r.clock.advance(300);
    assert.match(text(v.el), /Gathering letters/);
    noInlineStyles(v.el);
    await r.clock.advance(1000);
    assert.match(text(v.el), /didn't load/);
    noInlineStyles(v.el);
  } finally {
    await restoreWords();
  }
  const m = { phase: 'load' };
  assert.match(footText(m), /Gathering letters/);
  const watch = { phase: 'play', playing: false };
  assert.match(footText(watch), /watching/);
});

test('the game definition fits the lobby', () => {
  assert.equal(hive.id, 'hive');
  assert.equal(hive.category, 'words');
  assert.equal(hive.minPlayers, 1);
  assert.equal(hive.emoji, '🐝');
  const timer = hive.settings.find((x) => x.id === 'timer');
  assert.deepEqual(timer.options.map((o) => o.value), [90, 120, 180]);
  for (const t of [hive.name, hive.blurb, ...timer.options.map((o) => o.label)]) for (const re of BANNED) assert.equal(re.test(t), false, t);
});
