import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import emoji, { KEY, judge, mask, unmask, scramble, unscramble, speedPoints, hintLevel, pattern, patternText, letterCount, buildDeck, puzzleOf, MIN_POINTS, MAX_POINTS, REVEAL_MS } from '../web/activity/js/games/emoji.js';
import { CATEGORIES, PUZZLES, puzzleByN } from '../web/activity/data/emoji.js';
import { plainKey } from '../web/activity/js/text.js';
import { createEmojiView, emojiMoment, footText, tiles } from '../web/activity/js/views/emoji.js';
import { cueKit } from '../web/activity/js/views/index.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const ROOT = new URL('../web/activity/', import.meta.url);

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r, i = 0) {
  return r.engines[i].snapshot().state[KEY];
}

async function startEmoji(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [emoji], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('emoji'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function answerOf(s) {
  return puzzleOf(s).a;
}

async function solve(r, slot, text) {
  const s = st(r);
  bySlot(r, slot).act({ type: 'guess', x: scramble(text ?? answerOf(s), s.k), i: s.i });
  await r.clock.advance(400);
  return st(r);
}

function fakeApi(state, { slots = [0, 1, 2], now = 1000, settings = { rounds: 5, timer: 30, cats: CATEGORIES.map((c) => c.id) } } = {}) {
  const api = {
    t: now,
    store: { [KEY]: state ? JSON.parse(JSON.stringify(state)) : null },
    pts: {},
    finished: false,
    deadline: null,
    memory: {},
    settings,
    random: seeded(3),
    now: () => api.t,
    players: () => slots.map((slot) => ({ slot, id: `p${slot}`, name: `P${slot}` })),
    get: (k) => (api.store[k] ? JSON.parse(JSON.stringify(api.store[k])) : null),
    put: (k, v) => {
      api.store[k] = v === null ? null : JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(api.store),
    setDeadline: (at) => {
      api.deadline = at;
    },
    clearDeadline: () => {
      api.deadline = null;
    },
    shift: (ends, ms) => Math.max(api.t, ends + ms),
    addPoints: (slot, n) => {
      api.pts[slot] = (api.pts[slot] || 0) + n;
    },
    points: () => ({ ...api.pts }),
    finish: () => {
      api.finished = true;
    },
  };
  return api;
}

test('the puzzle list is big, original-looking and well formed', () => {
  assert.ok(PUZZLES.length >= 1150, `only ${PUZZLES.length} puzzles`);
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const cats = new Set(CATEGORIES.map((c) => c.id));
  const ids = new Set();
  const answers = new Set();
  for (const p of PUZZLES) {
    assert.ok(cats.has(p.cat), p.id);
    const n = [...seg.segment(p.e)].length;
    assert.ok(n >= 2 && n <= 6, `${p.id} has ${n} emoji`);
    assert.ok(!/[a-z]/i.test(p.e), `${p.id} emoji only`);
    if (p.n > 210) assert.ok(!/[0-9⃣]/.test(p.e), `${p.id} has a digit or keycap`);
    assert.ok(p.a && typeof p.a === 'string');
    assert.ok(Array.isArray(p.alt));
    assert.equal(ids.has(p.id), false);
    ids.add(p.id);
    assert.equal(answers.has(p.a.toLowerCase()), false, `duplicate ${p.a}`);
    answers.add(p.a.toLowerCase());
    assert.equal(judge(p.a, p), 'right', p.a);
    for (const a of p.alt) assert.equal(judge(a, p), 'right', a);
    assert.equal(puzzleByN(p.n), p);
    for (const re of BANNED) assert.equal(re.test(p.a), false, p.a);
  }
  for (const c of CATEGORIES) assert.ok(PUZZLES.filter((p) => p.cat === c.id).length >= 18, c.id);
});

test('there are twelve categories and no two puzzles share an answer or a typed alternate', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.id), ['movies', 'books', 'animals', 'food', 'places', 'jobs', 'sports', 'sayings', 'things', 'tv', 'games', 'characters']);
  const owner = new Map();
  for (const p of PUZZLES) {
    for (const k of new Set([p.a, ...p.alt].map(plainKey))) {
      assert.equal(owner.has(k), false, `${p.id} ${k} clashes with ${owner.get(k)}`);
      owner.set(k, p.id);
    }
  }
});

test('the first 210 puzzles keep their numbers, ids and answers', () => {
  assert.equal(puzzleByN(1).a, 'The Lion King');
  assert.equal(puzzleByN(1).id, 'e001');
  assert.equal(puzzleByN(210).a, 'Window shopping');
  assert.equal(puzzleByN(210).id, 'e210');
  assert.equal(puzzleByN(211).id, 'e211');
  const first = PUZZLES.slice(0, 210).map((p) => [p.n, p.id, p.cat, p.e, p.a, p.alt]);
  const hash = createHash('sha256').update(JSON.stringify(first)).digest('hex');
  assert.equal(hash, 'ae3e5e40a0ec6a30ffa5048f1308bb54683f3c955d9619a60dbacbb3ccfb3fa5');
});

test('guesses are forgiving but fair', () => {
  const lion = PUZZLES.find((p) => p.a === 'The Lion King');
  assert.equal(judge('lion king', lion), 'right');
  assert.equal(judge('  THE LION KING!! ', lion), 'right');
  assert.equal(judge('the lion kng', lion), 'right');
  assert.equal(judge('the loin king', lion), 'close');
  assert.equal(judge('lion', lion), 'part');
  assert.equal(judge('tiger queen', lion), 'miss');
  assert.equal(judge('', lion), 'empty');
  const up = PUZZLES.find((p) => p.a === 'Up');
  assert.equal(judge('up', up), 'right');
  assert.equal(judge('us', up), 'close');
  const web = PUZZLES.find((p) => p.a === "Charlotte's Web");
  assert.equal(judge('charlottes web', web), 'right');
  const et = PUZZLES.find((p) => p.a === 'E.T.');
  assert.equal(judge('et', et), 'right');
  const zebra = PUZZLES.find((p) => p.a === 'Zebra');
  assert.equal(judge('zebar', zebra), 'close');
  assert.equal(judge('horse', zebra), 'miss');
});

test('points, hints and the letter pattern', () => {
  assert.equal(speedPoints(0, 0, 30000), MAX_POINTS);
  assert.equal(speedPoints(30000, 0, 30000), MIN_POINTS);
  assert.equal(speedPoints(15000, 0, 30000), 700);
  assert.equal(hintLevel(0, 30000, 9999), 0);
  assert.equal(hintLevel(0, 30000, 10000), 1);
  assert.equal(hintLevel(0, 30000, 20000), 2);
  assert.equal(patternText('Time is money'), '_ _ _ _   _ _   _ _ _ _ _');
  assert.equal(patternText('Spider-Man'), '_ _ _ _ _ _ - _ _ _');
  assert.deepEqual(pattern('Up'), [['_', '_']]);
  assert.equal(letterCount("Charlotte's Web"), 13);
  assert.equal(unmask(mask(123, 4567), 4567), 123);
  assert.equal(unscramble(scramble('Hot dog 🌭', 999), 999), 'Hot dog 🌭');
  assert.notEqual(scramble('hot dog', 999), 'hot dog');
});

test('decks follow the chosen categories and mix them up', () => {
  const deck = buildDeck(['food', 'sports'], 10, seeded(5));
  assert.equal(deck.length, 10);
  assert.equal(new Set(deck).size, 10);
  const cats = deck.map((n) => puzzleByN(n).cat);
  assert.ok(cats.every((c) => c === 'food' || c === 'sports'));
  for (let i = 1; i < cats.length; i += 1) assert.notEqual(cats[i], cats[i - 1]);
  assert.equal(buildDeck([], 15, seeded(1)).length, 15);
  assert.equal(buildDeck(['nope'], 5, seeded(1)).length, 5);
});

test('a full game with three players runs from start to finish with speed scoring', async () => {
  const r = await startEmoji(3, { rounds: 5, timer: 20 });
  let s = st(r);
  assert.equal(s.phase, 'guess');
  assert.equal(s.total, 5);
  assert.equal(s.ends - s.starts, 20000);
  assert.deepEqual(s.in, [0, 1, 2]);
  for (let round = 0; round < 5; round += 1) {
    s = st(r);
    assert.equal(s.i, round);
    assert.equal(s.phase, 'guess');
    await solve(r, 0);
    await r.clock.advance(2000);
    await solve(r, 1);
    s = st(r);
    assert.equal(s.got.length, 2);
    assert.ok(s.got[0][1] > s.got[1][1], 'faster is worth more');
    const mult = round === 4 ? 2 : 1;
    assert.ok(s.got[0][1] <= MAX_POINTS * mult && s.got[1][1] >= MIN_POINTS * mult, 'the final puzzle counts double');
    await solve(r, 2);
    s = st(r);
    assert.equal(s.phase, 'reveal', 'the round ends when everyone has it');
    assert.equal(s.why, 'all');
    assert.equal(s.a, answerOf(s));
    if (round < 4) {
      await r.clock.advance(REVEAL_MS + 200);
    }
  }
  await r.clock.advance(REVEAL_MS + 200);
  const snap = r.engines[1].snapshot();
  assert.equal(snap.room.phase, 'results');
  const g = snap.scores.t;
  assert.ok(g[0] > g[1] && g[1] > g[2]);
  assert.ok(g[0] <= 6 * MAX_POINTS && g[2] >= 6 * MIN_POINTS);
  assert.deepEqual(r.hub.violations, []);
});

test('wrong guesses are ignored and never shared, and solving twice scores once', async () => {
  const r = await startEmoji(3, { rounds: 5 });
  let s = st(r);
  bySlot(r, 1).act({ type: 'guess', text: 'definitely not it', i: s.i });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.got.length, 0);
  assert.equal(JSON.stringify(r.hub.state).includes('definitely'), false);
  await solve(r, 1);
  await solve(r, 1);
  s = st(r);
  assert.equal(s.got.length, 1);
  bySlot(r, 2).act({ type: 'guess', x: scramble(answerOf(s), s.k), i: s.i + 1 });
  await r.clock.advance(400);
  assert.equal(st(r).got.length, 1, 'a guess for another round is ignored');
});

test('when time runs out the answer is revealed and the game moves on', async () => {
  const r = await startEmoji(3, { rounds: 5, timer: 30 });
  let s = st(r);
  await solve(r, 0);
  await r.clock.advance(30000);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.why, 'time');
  assert.equal(s.got.length, 1);
  assert.equal(s.a, answerOf(s));
  await r.clock.advance(REVEAL_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'guess');
  assert.equal(s.i, 1);
  assert.equal(s.got.length, 0);
});

test('hints unlock over the round: category, then the letter pattern', async () => {
  const r = await startEmoji(2, { rounds: 5, timer: 30 });
  const s = st(r);
  const p = puzzleOf(s);
  const at = (ms) => emoji.model({ ...r.engines[1].snapshot(), now: s.starts + ms });
  assert.equal(at(1000).category, null);
  assert.equal(at(1000).pattern, null);
  assert.ok(at(11000).category);
  assert.equal(at(11000).pattern, null);
  assert.deepEqual(at(21000).pattern, pattern(p.a));
  assert.equal(at(21000).answer, null);
  await solve(r, 1);
  const solved = emoji.model({ ...r.engines[1].snapshot(), now: s.starts + 21000 });
  assert.equal(solved.pattern, null);
  assert.equal(solved.answer, p.a);
  assert.equal(emoji.model({ ...r.engines[0].snapshot(), now: s.starts + 21000 }).answer, null);
});

test('a late joiner can play the current puzzle or waits when it is nearly over', async () => {
  const r = await startEmoji(2, { rounds: 5, timer: 30 });
  const late = r.add(3);
  await r.clock.advance(800);
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  let s = st(r);
  assert.ok(s.in.includes(slot));
  await solve(r, slot);
  assert.ok(st(r).got.some((g) => g[0] === slot));
  await r.clock.advance(26000);
  const later = r.add(4);
  await r.clock.advance(400);
  const slot4 = later.snapshot().meSlot;
  s = st(r);
  assert.ok(s.wait.includes(slot4));
  assert.equal(emoji.model(later.snapshot()).waiting, true);
  assert.equal(emoji.model(later.snapshot()).canGuess, false);
  await r.clock.advance(4000 + REVEAL_MS + 400);
  s = st(r);
  assert.equal(s.i, 1);
  assert.ok(s.in.includes(slot4), 'they are in from the next puzzle');
  assert.deepEqual(r.hub.violations, []);
});

test('admin skip and time work in both phases', () => {
  const api = fakeApi(null);
  emoji.start(api);
  let s = api.get(KEY);
  assert.equal(s.phase, 'guess');
  assert.equal(api.deadline, s.ends);
  assert.equal(emoji.admin(api, { type: 'time', ms: 15000 }), true);
  assert.equal(api.get(KEY).ends, s.ends + 15000);
  assert.equal(api.deadline, s.ends + 15000);
  assert.equal(emoji.admin(api, { type: 'time', ms: -600000 }), true);
  assert.equal(api.get(KEY).ends, api.t);
  assert.equal(emoji.admin(api, { type: 'skip' }), true);
  s = api.get(KEY);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.why, 'skip');
  assert.equal(s.a, puzzleOf(s).a);
  assert.equal(emoji.admin(api, { type: 'skip' }), true);
  s = api.get(KEY);
  assert.equal(s.phase, 'guess');
  assert.equal(s.i, 1);
  assert.equal(emoji.admin(api, { type: 'lock' }), false);
  for (let i = 0; i < 8; i += 1) emoji.admin(api, { type: 'skip' });
  assert.equal(api.finished, true);
});

test('resume carries on after the host changes, with empty memory', async () => {
  const api = fakeApi(null);
  emoji.start(api);
  api.addPoints(0, 500);
  const before = api.get(KEY);
  before.got.push([0, 500]);
  api.put(KEY, before);
  api.memory = {};
  api.deadline = null;
  emoji.resume(api);
  let s = api.get(KEY);
  assert.equal(s.phase, 'guess');
  assert.equal(api.deadline, s.ends);
  emoji.intent(api, 1, { type: 'guess', text: puzzleOf(s).a, i: s.i });
  s = api.get(KEY);
  assert.equal(s.got.length, 2);
  const broken = fakeApi({ ...s, c: mask(60000, s.k) });
  emoji.resume(broken);
  assert.equal(broken.finished, true, 'a broken round ends the game instead of crashing');
  const late = fakeApi(s, { now: s.ends + 10 });
  emoji.resume(late);
  assert.equal(late.get(KEY).phase, 'reveal');
});

test('the game keeps going when the host leaves mid-puzzle', async () => {
  const r = await startEmoji(3, { rounds: 5, timer: 30 });
  const host = r.engines[0];
  await solve(r, 1);
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(600);
  const a = r.engines[1];
  assert.equal(a.isHost(), true);
  let s = a.snapshot().state[KEY];
  assert.equal(s.phase, 'guess');
  assert.equal(s.got.length, 1);
  const p = puzzleOf(s);
  r.engines[2].act({ type: 'guess', x: scramble(p.a, s.k), i: s.i });
  await r.clock.advance(400);
  s = a.snapshot().state[KEY];
  assert.equal(s.phase, 'reveal', 'everyone still here has it');
  await r.clock.advance(REVEAL_MS + 200);
  assert.equal(a.snapshot().state[KEY].i, 1, 'the new host runs the clock');
  assert.deepEqual(r.hub.violations, []);
});

test('state stays small with 16 players and the answer never appears in plain text', async () => {
  const r = await startEmoji(16, { rounds: 15, timer: 45 });
  for (let round = 0; round < 3; round += 1) {
    const s = st(r);
    const p = puzzleOf(s);
    const plain = JSON.stringify(r.hub.state);
    assert.equal(plain.toLowerCase().includes(p.a.toLowerCase()), false, 'answer hidden while guessing');
    for (const alt of p.alt) if (alt.length > 3) assert.equal(plain.toLowerCase().includes(alt.toLowerCase()), false);
    assert.equal(s.deck.includes(p.n), false, 'the deck is masked too');
    for (let slot = 0; slot < 16; slot += 1) {
      bySlot(r, slot).act({ type: 'guess', x: scramble(p.a, s.k), i: s.i });
      await r.clock.advance(50);
    }
    await r.clock.advance(400);
    const after = st(r);
    assert.equal(after.got.length, 16);
    assert.equal(after.phase, 'reveal');
    for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
    assert.ok(jsonBytes(r.hub.state) < 64 * 1024);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.deepEqual(r.hub.violations, []);
});

function all(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes || []) {
      if (c.localName) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInline(root) {
  for (const el of all(root)) assert.equal(el.hasAttribute('style'), false, el.className);
}

test('the view renders each phase, keeps wrong guesses private and cues once', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3, { games: [emoji] });
  await r.clock.advance(500);
  const played = r.engines.map(() => []);
  const views = r.engines.map((engine, i) => {
    const cues = { play: (name) => played[i].push(name), burst() {}, float() {} };
    const v = createEmojiView({ engine, fx: { confetti() {} }, cues, win: {} });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  const viewOf = (slot) => views[r.engines.findIndex((e) => e.snapshot().meSlot === slot)];
  const playedOf = (slot) => played[r.engines.findIndex((e) => e.snapshot().meSlot === slot)];
  r.engines[0].lobby.pick('emoji');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  let s = st(r);
  const p = puzzleOf(s);
  for (const v of views) {
    noInline(v.el);
    assert.match(text(v.el), /Puzzle 1 of/);
    assert.match(text(v.el), /Type what the emoji stand for/);
    assert.equal(all(v.el).filter((el) => el.classList.contains('emoji-tile')).length, tiles(p.e).length);
  }
  for (const list of played) assert.equal(list.length, 0, 'no cue on first render');
  const me = viewOf(1);
  const input = byKey(me.el, 'emoji-input');
  input.value = 'zzzz nothing';
  byKey(me.el, 'emoji-send').click();
  assert.match(text(me.el), /Not it/);
  assert.match(text(me.el), /zzzz nothing/);
  assert.doesNotMatch(text(viewOf(0).el), /zzzz/);
  assert.deepEqual(playedOf(1), ['wrong']);
  await r.clock.advance(400);
  assert.equal(JSON.stringify(r.hub.state).includes('zzzz'), false);
  noInline(me.el);
  input.value = p.a;
  byKey(me.el, 'emoji-send').click();
  await r.clock.advance(400);
  assert.match(text(me.el), /You cracked it!/);
  assert.match(text(me.el), new RegExp(p.a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text(viewOf(0).el), /Cracked it:/);
  assert.doesNotMatch(text(viewOf(0).el), new RegExp(`The answer was`));
  assert.equal(playedOf(1).filter((x) => x === 'correct').length, 1);
  assert.equal(playedOf(1).includes('coin'), false);
  assert.equal(byKey(me.el, 'emoji-input').disabled, true);
  noInline(me.el);
  r.engines[0].snapshot();
  views[0].update({ ...r.engines[0].snapshot(), now: s.starts + 25000 });
  assert.match(text(views[0].el), /letters in total/);
  assert.ok(all(views[0].el).some((el) => el.classList.contains('emoji-blanks')));
  noInline(views[0].el);
  await r.clock.advance(26000);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  for (const v of views) {
    assert.match(text(v.el), /The answer was/);
    noInline(v.el);
  }
  assert.equal(playedOf(1).filter((x) => x === 'reveal').length, 1);
  assert.equal(playedOf(1).filter((x) => x === 'correct').length, 1);
  assert.match(text(viewOf(1).el), /Nice decoding!/);
  await r.clock.advance(REVEAL_MS + 200);
  assert.equal(st(r).i, 1);
  assert.match(text(me.el), /Puzzle 2 of/);
  assert.doesNotMatch(text(me.el), /zzzz/);
  assert.equal(byKey(me.el, 'emoji-input').disabled, false);
  assert.equal(playedOf(1).filter((x) => x === 'whoosh').length, 1);
  for (const list of played) for (const name of list) assert.ok(!['start', 'win', 'coin'].includes(name), name);
  for (const v of views) v.destroy();
});

test('moments fire once and the footer reads plainly', () => {
  const base = { rid: 'a', phase: 'guess', level: 0, solved: 0, gotMe: false };
  assert.deepEqual(emojiMoment(null, base).cues, []);
  const { now } = emojiMoment(null, base);
  assert.deepEqual(emojiMoment(now, { ...base, level: 1 }).cues, ['pop']);
  assert.deepEqual(emojiMoment(now, { ...base, solved: 1, gotMe: true }).cues, ['correct']);
  assert.deepEqual(emojiMoment(now, { ...base, solved: 1 }).cues, ['tap']);
  assert.deepEqual(emojiMoment(now, { ...base, phase: 'reveal' }).cues, ['reveal']);
  const again = emojiMoment(now, { ...base, phase: 'reveal' }).now;
  assert.deepEqual(emojiMoment(again, { ...base, phase: 'reveal' }).cues, []);
  const m = { phase: 'reveal', solved: 0, players: 3, gotMe: false, why: 'time' };
  assert.match(footText(m), /Nobody cracked this one/);
  for (const re of BANNED) assert.equal(re.test(footText(m)), false);
  assert.equal(typeof cueKit, 'function');
});

test('the files have no comments, inline styles or outside links', () => {
  const files = ['js/games/emoji.js', 'js/views/emoji.js', 'css/emoji.css', 'data/emoji.js', 'data/emoji-more.js'];
  for (const f of files) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    assert.equal(/^\s*\/\//m.test(src), false, `${f} has a line comment`);
    assert.equal(/\/\*/.test(src), false, `${f} has a block comment`);
    assert.equal(/style\s*=/.test(src), false, `${f} sets a style attribute`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, `${f} sets inline styles`);
    assert.equal(/https?:\/\//.test(src), false, `${f} links outside`);
    assert.equal(/\beval\(|new Function/.test(src), false, f);
    for (const re of BANNED) assert.equal(re.test(src), false, `${f} ${re}`);
  }
  const css = readFileSync(new URL('css/emoji.css', ROOT), 'utf8');
  for (const m of css.matchAll(/^\.([a-z-]+)/gm)) assert.ok(m[1].startsWith('emoji-') || ['got-item'].includes(m[1]), m[1]);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(emoji.category, 'quiz');
  assert.equal(emoji.minPlayers, 1);
});

test('a solo player plays a whole game and each puzzle ends as soon as it is cracked', async () => {
  const r = await startEmoji(1, { rounds: 5, timer: 20 });
  for (let round = 0; round < 5; round += 1) {
    let s = st(r);
    assert.equal(s.i, round);
    assert.equal(s.phase, 'guess');
    if (round === 2) {
      await r.clock.advance(21000);
      s = st(r);
      assert.equal(s.phase, 'reveal');
      assert.equal(s.why, 'time');
    } else {
      s = await solve(r, 0);
      assert.equal(s.phase, 'reveal');
      assert.equal(s.why, 'all');
    }
    await r.clock.advance(REVEAL_MS + 200);
  }
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.ok(snap.scores.t[0] >= 5 * MIN_POINTS && snap.scores.t[0] <= 5 * MAX_POINTS, 'the final puzzle counts double');
  assert.deepEqual(r.hub.violations, []);
});

test('twelve players finish a game, some miss puzzles, and nobody gets points they did not earn', async () => {
  const r = await startEmoji(12, { rounds: 5, timer: 30 });
  const earned = {};
  for (let round = 0; round < 5; round += 1) {
    let s = st(r);
    assert.equal(s.in.length, 12);
    const solvers = Array.from({ length: 12 }, (_, i) => i).filter((slot) => (slot + round) % 3 !== 0);
    for (const slot of solvers) {
      s = await solve(r, slot);
      const mine = s.got.find((g) => g[0] === slot);
      earned[slot] = (earned[slot] || 0) + mine[1];
    }
    bySlot(r, 0).act({ type: 'guess', x: scramble('definitely wrong', s.k), i: s.i });
    await r.clock.advance(400);
    s = st(r);
    assert.equal(s.phase, 'guess');
    assert.ok(jsonBytes(s) < MAX_VALUE_BYTES / 4);
    await r.clock.advance(s.ends - r.engines[0].snapshot().now + 200);
    assert.equal(st(r).phase, 'reveal');
    assert.equal(st(r).why, 'time');
    await r.clock.advance(REVEAL_MS + 200);
  }
  const snap = r.engines[3].snapshot();
  assert.equal(snap.room.phase, 'results');
  for (let slot = 0; slot < 12; slot += 1) assert.equal(snap.scores.t[slot] || 0, earned[slot] || 0, `slot ${slot}`);
  assert.deepEqual(r.hub.violations, []);
});

test('hints already shown stay shown when an admin adds time', async () => {
  const r = await startEmoji(2, { rounds: 5, timer: 30 });
  await r.clock.advance(21000);
  assert.ok(emoji.model(r.engines[1].snapshot()).pattern);
  assert.equal(hintLevel(0, 45000, 21000, 30000), 2);
  assert.equal(hintLevel(0, 15000, 6000, 30000), 1);
  const s = st(r);
  const api = fakeApi(s, { now: s.starts + 21000 });
  api.shift = (ends, ms) => ends + ms;
  assert.equal(emoji.admin(api, { type: 'time', ms: 15000 }), true);
  const after = api.store[KEY];
  assert.equal(after.ends, s.ends + 15000);
  assert.equal(after.h, s.ends);
  assert.equal(hintLevel(after.starts, after.ends, s.starts + 21000, after.h), 2);
});

test('the view does not throw confetti when it first opens on a puzzle you already cracked', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startEmoji(2, { rounds: 5 });
  await solve(r, 1);
  const engine = bySlot(r, 1);
  let thrown = 0;
  const played = [];
  const v = createEmojiView({ engine, fx: { confetti: () => (thrown += 1) }, cues: { play: (n) => played.push(n), burst() {}, float() {} }, win: {} });
  v.update(engine.snapshot());
  v.update(engine.snapshot());
  assert.equal(thrown, 0);
  assert.deepEqual(played, []);
  v.destroy();
});

test('players cannot forge a skip, score an old puzzle, or score as a spectator', async () => {
  const r = await startEmoji(3, { rounds: 5 });
  const s = st(r);
  const p = bySlot(r, 1);
  p.act({ type: 'skip' });
  p.act({ type: 'reveal' });
  p.act({ type: 'points', slot: 1, n: 5000 });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'guess');
  assert.equal(st(r).got.length, 0);
  p.act({ type: 'guess', x: scramble(answerOf(s), s.k), i: s.i + 1 });
  await r.clock.advance(400);
  assert.equal(st(r).got.length, 0);
  const api = fakeApi(s, { slots: [0, 1] });
  emoji.intent(api, 2, { type: 'guess', text: answerOf(s), i: s.i });
  assert.equal(api.store[KEY].got.length, 0);
  assert.deepEqual(api.pts, {});
});
