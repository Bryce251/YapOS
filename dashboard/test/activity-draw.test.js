import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import draw, { judge, distance, guessPoints, drawerShare, drawerGain, handleOf, AUTO_START, DRAWER_STEP, nextSeat, chooseWords, hintSpots, hintCount, blanks, mask, unmask, GUESS_MAX, GUESS_MIN, PICK_MS, REVEAL_MS } from '../web/activity/js/games/draw.js';
import { WORDS, TIERS, wordById } from '../web/activity/data/draw.js';
import {
  encodeStroke,
  decodeStroke,
  encodeParts,
  pack,
  fitInk,
  readInk,
  inkBytes,
  inkKey,
  liveMessage,
  applyLive,
  pruneLive,
  simplify,
  GRID_W,
  GRID_H,
  CHUNK_BYTES,
  MAX_CHUNKS,
  INK_BYTES,
  PIECE_CHARS,
  LEVELS,
} from '../web/activity/js/games/ink.js';
import { jsonBytes, MAX_VALUE_BYTES, MAX_STATE_BYTES, stateBytes } from '../web/activity/js/limits.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { VIEWS } from '../web/activity/js/views/index.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function squiggle(n, random, x0 = 100, y0 = 100) {
  const pts = [];
  let x = x0;
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    x = Math.min(GRID_W, Math.max(0, x + (random() - 0.5) * 8));
    y = Math.min(GRID_H, Math.max(0, y + (random() - 0.5) * 8));
    pts.push([x, y]);
  }
  return pts;
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function secret(st) {
  return wordById(unmask(st.w, st.nonce)).w;
}

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

async function startDraw(n = 3, settings = {}) {
  const r = room(n);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('draw'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function pickWord(r, i = 0) {
  const st = r.engines[0].snapshot().state.draw;
  bySlot(r, st.drawer).act({ type: 'pick', i, n: st.n });
  await r.clock.advance(400);
  return r.engines[0].snapshot().state.draw;
}

test('the word list has about 200 fresh, drawable words in three tiers', () => {
  assert.ok(WORDS.length >= 190 && WORDS.length <= 230, String(WORDS.length));
  const seen = new Set();
  for (const w of WORDS) {
    assert.match(w.w, /^[a-z]+( [a-z]+)*$/, w.w);
    assert.equal(seen.has(w.w), false, w.w);
    seen.add(w.w);
    assert.ok(w.w.length <= 24, w.w);
    for (const re of BANNED) assert.equal(re.test(w.w), false, w.w);
    assert.equal(wordById(w.id), w);
  }
  for (const t of TIERS) assert.ok(WORDS.filter((w) => w.tier === t.id).length >= 55, t.id);
});

test('Draw & Guess and Word Chain are in the game picker with views', () => {
  for (const id of ['draw', 'chain']) {
    const g = GAMES.find((x) => x.id === id);
    assert.ok(g, id);
    assert.equal(typeof VIEWS[id], 'function', id);
    assert.equal(g.minPlayers, 2);
  }
  assert.deepEqual(draw.prefixes, ['ink.']);
  assert.deepEqual(draw.open, ['ink.']);
});

test('strokes round trip through the quantised delta encoding', () => {
  const random = seeded(5);
  const pts = squiggle(300, random);
  pts.push([0, 0], [GRID_W, GRID_H], [GRID_W, 0], [3, 359]);
  const stroke = { c: 4, z: 2, pts };
  const text = encodeStroke(stroke);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  const back = decodeStroke(text);
  assert.equal(back.c, 4);
  assert.equal(back.z, 2);
  assert.equal(back.pts.length, pts.length);
  for (let i = 0; i < pts.length; i += 1) {
    assert.equal(back.pts[i][0], Math.round(pts[i][0]));
    assert.equal(back.pts[i][1], Math.round(pts[i][1]));
  }
  const smooth = encodeStroke({ c: 1, z: 1, pts: squiggle(500, seeded(9)) });
  assert.ok(smooth.length <= 6 + 2 * 499, `${smooth.length} chars for 500 small steps`);
});

test('bad stroke text is rejected instead of drawn', () => {
  assert.equal(decodeStroke(''), null);
  assert.equal(decodeStroke(42), null);
  assert.equal(decodeStroke('zzAAAA'), null);
  assert.equal(decodeStroke('BB!!AAAA'), null);
  assert.equal(decodeStroke('BBHgAAAA'), null);
  assert.equal(decodeStroke('BBAAAAA'), null);
  assert.equal(decodeStroke('BBAAAAAA'), null);
  assert.ok(decodeStroke(encodeStroke({ c: 1, z: 0, pts: [[5, 5]] })));
});

test('simplify keeps the shape and drops points on straight runs', () => {
  const line = Array.from({ length: 100 }, (_, i) => [i, i * 2]);
  assert.deepEqual(simplify(line, 1), [[0, 0], [99, 198]]);
  const corner = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  assert.deepEqual(simplify(corner, 1), [[0, 0], [100, 0], [100, 100]]);
});

test('long strokes split into joined pieces and chunks stay under 3.5 KB', () => {
  const random = seeded(2);
  const pts = [];
  for (let i = 0; i < 4000; i += 1) pts.push([Math.floor(random() * GRID_W), Math.floor(random() * GRID_H)]);
  const parts = encodeParts({ c: 2, z: 1, pts }, LEVELS[0]);
  assert.ok(parts.length > 2);
  for (let i = 0; i < parts.length; i += 1) {
    assert.ok(parts[i].length <= PIECE_CHARS);
    if (i) {
      const a = decodeStroke(parts[i - 1]).pts;
      const b = decodeStroke(parts[i]).pts;
      assert.deepEqual(a[a.length - 1], b[0]);
    }
  }
  const chunks = pack(parts, 77);
  chunks.forEach((c, i) => {
    assert.equal(c.i, i);
    assert.equal(c.k, 77);
    assert.ok(jsonBytes(c) <= CHUNK_BYTES, String(jsonBytes(c)));
    assert.ok(jsonBytes(c) <= MAX_VALUE_BYTES);
  });
  assert.equal(chunks.flatMap((c) => c.s).length, parts.length);
});

test('a busy drawing simplifies to fit the chunk and state limits, and a hopeless one is refused', () => {
  const random = seeded(4);
  const strokes = [];
  for (let i = 0; i < 160; i += 1) strokes.push({ c: 1 + (i % 11), z: i % 4, pts: squiggle(220, random, 40 + (i % 40) * 10, 40 + (i % 28) * 10) });
  const fit = fitInk(strokes, 9, 0);
  assert.ok(fit, 'it fits after simplifying');
  assert.ok(fit.level > 0, 'it needed a coarser level');
  assert.ok(fit.chunks.length <= MAX_CHUNKS);
  assert.ok(inkBytes(fit.chunks) <= INK_BYTES);
  for (const c of fit.chunks) assert.ok(jsonBytes(c) <= CHUNK_BYTES);
  const state = {};
  for (const c of fit.chunks) state[inkKey(c.i)] = c;
  assert.ok(stateBytes(state) + 12000 < MAX_STATE_BYTES, 'room is left for the other keys');
  assert.equal(readInk(state, 9).strokes.length, fit.count);
  const noise = [];
  const r2 = seeded(8);
  for (let i = 0; i < 7000; i += 1) noise.push({ c: 1, z: 0, pts: [[Math.floor(r2() * GRID_W), Math.floor(r2() * GRID_H)], [Math.floor(r2() * GRID_W), Math.floor(r2() * GRID_H)]] });
  assert.equal(fitInk(noise, 9, 0), null);
});

test('reading ink skips other turns and broken chunks', () => {
  const a = encodeStroke({ c: 3, z: 1, pts: [[1, 1], [5, 5]] });
  const state = {
    'ink.0': { k: 5, i: 0, s: [a, 'garbage!'] },
    'ink.1': { k: 4, i: 1, s: [a] },
    'ink.2': { k: 5, i: 7, s: [a] },
    'ink.3': { k: 5, i: 3, s: [a] },
    draw: { k: 5 },
  };
  const ink = readInk(state, 5);
  assert.equal(ink.strokes.length, 2);
  assert.notEqual(readInk({ ...state, 'ink.3': null }, 5).sig, ink.sig);
});

test('live stroke messages append in order and get cut on undo', () => {
  const live = new Map();
  const stroke = { c: 1, z: 1, pts: [[10, 10], [12, 12], [15, 13]] };
  assert.equal(applyLive(live, liveMessage(3, 2, 0, stroke.pts, stroke)), true);
  stroke.pts.push([20, 20], [25, 22]);
  assert.equal(applyLive(live, liveMessage(3, 2, 3, stroke.pts, stroke)), true);
  assert.deepEqual(live.get(2).pts, stroke.pts);
  assert.equal(applyLive(live, liveMessage(3, 2, 9, stroke.pts, stroke)), false);
  assert.ok(jsonBytes(liveMessage(3, 2, 0, stroke.pts, stroke)) < 200);
  applyLive(live, liveMessage(3, 4, 0, stroke.pts, stroke));
  applyLive(live, { t: 'ink', k: 3, cut: 3 });
  assert.deepEqual([...live.keys()], [2]);
  pruneLive(live, 3);
  assert.equal(live.size, 0);
  assert.equal(applyLive(live, { t: 'ink', si: 1, o: 0, s: 'nope' }), false);
});

test('guesses are judged right, close, hidden or a miss', () => {
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(distance('cat', 'cats'), 1);
  assert.equal(judge('Pizza', 'pizza'), 'right');
  assert.equal(judge('  ice-cream ', 'ice cream'), 'right');
  assert.equal(judge('is it a cat?', 'cat'), 'right');
  assert.equal(judge('a hot air balloon', 'hot air balloon'), 'right');
  assert.equal(judge('piza', 'pizza'), 'close');
  assert.equal(judge('pizzas', 'pizza'), 'close');
  assert.equal(judge('pozza', 'pizza'), 'close');
  assert.equal(judge('catalog', 'cat'), 'hidden');
  assert.equal(judge('dog', 'cat'), 'miss');
  assert.equal(judge('!!!', 'cat'), 'miss');
});

test('speed scoring rewards fast guessers', () => {
  assert.equal(guessPoints(0, 0, 80000), GUESS_MAX);
  assert.equal(guessPoints(80000, 0, 80000), GUESS_MIN);
  assert.equal(guessPoints(40000, 0, 80000), 300);
  assert.ok(guessPoints(10000, 0, 80000) > guessPoints(20000, 0, 80000));
});

test('the drawer earns about an average guesser, never more than the best one', () => {
  assert.equal(drawerShare([], 4), 0);
  assert.equal(drawerShare([420], 1), 420);
  assert.equal(drawerShare([500, 300], 2), 400);
  assert.equal(drawerShare([500, 300], 4), 200);
  assert.equal(drawerShare([300], 8), 35);
  assert.equal(drawerShare([500], 0), 500);
  for (const n of [1, 2, 3, 4, 5, 7, 8, 11]) {
    const random = seeded(30 + n);
    for (let trial = 0; trial < 300; trial += 1) {
      const pts = [];
      for (let i = 0; i < n; i += 1) if (random() < 0.8) pts.push(guessPoints(Math.floor(random() * 80000), 0, 80000));
      const share = drawerShare(pts, n);
      assert.equal(share % DRAWER_STEP, 0);
      assert.ok(share <= (pts.length ? Math.max(...pts) : 0), `${n} guessers: ${share} > best of ${pts}`);
      assert.ok(share * n <= pts.reduce((a, b) => a + b, 0));
    }
  }
  for (const players of [2, 4, 8]) {
    const guessers = players - 1;
    const fast = Array.from({ length: guessers }, () => GUESS_MAX);
    assert.ok(drawerShare(fast, guessers) <= GUESS_MAX, `${players} players, everyone fast`);
    assert.ok(drawerShare(fast, guessers) >= GUESS_MAX - DRAWER_STEP);
    const mixed = Array.from({ length: guessers }, (_, i) => GUESS_MAX - i * 50);
    assert.ok(drawerShare(mixed, guessers) <= Math.max(...mixed), `${players} players, mixed speeds`);
    assert.ok(drawerShare([GUESS_MAX], guessers) <= GUESS_MAX / guessers, `${players} players, one guesser`);
  }
  const got = [];
  let given = 0;
  for (const [slot, pts, guessers] of [[1, 480, 3], [2, 300, 3], [3, 200, 4], [4, 500, 4]]) {
    got.push([slot, pts]);
    const extra = drawerGain(got, guessers, given);
    assert.ok(extra >= 0);
    given += extra;
  }
  assert.ok(given <= 500, String(given));
  assert.equal(given, 370);
});

test('Draw & Guess counts down 90 seconds once two people join', () => {
  assert.deepEqual(draw.autoStart, { min: 2, ms: 90000 });
  assert.deepEqual(AUTO_START, { min: 2, ms: 90000 });
});

test('a late joiner is added to the end of the drawing order once', () => {
  let st = { order: [0, 1, 2], drawer: 1, pos: 1, round: 1, rounds: 2, got: [] };
  const api = { get: () => JSON.parse(JSON.stringify(st)), put: (k, v) => { assert.equal(k, 'draw'); st = v; } };
  draw.join(api, 5);
  assert.deepEqual(st.order, [0, 1, 2, 5]);
  draw.join(api, 5);
  draw.join(api, 1);
  draw.join(api, 'x');
  assert.deepEqual(st.order, [0, 1, 2, 5]);
  assert.deepEqual(nextSeat(st.order, [0, 1, 2, 5], 1, 2, 2), { round: 1, pos: 2, slot: 2 });
  assert.deepEqual(nextSeat(st.order, [0, 1, 2, 5], 1, 3, 2), { round: 1, pos: 3, slot: 5 });
  let wrote = false;
  draw.join({ get: () => null, put: () => { wrote = true; } }, 3);
  assert.equal(wrote, false);
});

test('usernames are cleaned so a missing one never shows as @null', () => {
  assert.equal(handleOf('@Greninjite'), 'Greninjite');
  assert.equal(handleOf('  '), null);
  assert.equal(handleOf(null), null);
  assert.equal(handleOf(undefined), null);
  assert.equal(handleOf('a\u202eb c'), 'abc');
  assert.equal(Array.from(handleOf('x'.repeat(80))).length, 32);
});

test('someone who pressed Leave keeps their seat number but only watches and cannot guess', () => {
  const st = { phase: 'draw', round: 1, rounds: 2, n: 1, nonce: 7, drawer: 0, w: mask(WORDS[0].id, 7), opts: [], got: [], feed: [], gained: {}, starts: 0, ends: 60000 };
  const players = [0, 1, 2].map((slot) => ({ id: 'u' + slot, slot, name: 'P' + slot, initials: 'P', hue: 1, avatar: null, isMe: slot === 2 }));
  const base = { state: { draw: st }, players, now: 1000, meSlot: 2 };
  const left = draw.model({ ...base, meJoined: false });
  assert.equal(left.canGuess, false);
  assert.equal(left.spectator, true);
  assert.equal(left.word, null);
  const playing = draw.model({ ...base, meJoined: true });
  assert.equal(playing.canGuess, true);
  assert.equal(playing.spectator, false);
  const watcher = draw.model({ ...base, meSlot: null, meJoined: false });
  assert.equal(watcher.canGuess, false);
  assert.equal(watcher.spectator, true);
});

test('drawers rotate, skip people who left and stop after the last round', () => {
  assert.deepEqual(nextSeat([0, 1, 2], [0, 1, 2], 1, 0, 2), { round: 1, pos: 0, slot: 0 });
  assert.deepEqual(nextSeat([0, 1, 2], [0, 2], 1, 1, 2), { round: 1, pos: 2, slot: 2 });
  assert.deepEqual(nextSeat([0, 1, 2], [0, 1, 2], 1, 3, 2), { round: 2, pos: 0, slot: 0 });
  assert.equal(nextSeat([0, 1, 2], [0, 1, 2], 2, 3, 2), null);
  assert.equal(nextSeat([0, 1], [], 1, 0, 3), null);
});

test('word choices come from the picked tier and avoid repeats', () => {
  const mix = chooseWords('mix', [], seeded(1));
  assert.deepEqual(mix.map((id) => wordById(id).tier), ['easy', 'medium', 'hard']);
  const hard = chooseWords('hard', [], seeded(2));
  assert.equal(hard.length, 3);
  assert.ok(hard.every((id) => wordById(id).tier === 'hard'));
  const used = WORDS.filter((w) => w.tier === 'easy').slice(0, 60).map((w) => w.id);
  const easy = chooseWords('easy', used, seeded(3));
  assert.ok(easy.every((id) => !used.includes(id)));
  assert.equal(unmask(mask(123, 40000), 40000), 123);
});

test('letter hints open up late in the turn', () => {
  assert.equal(hintCount('pizza', 0, 100, 10), 0);
  assert.equal(hintCount('pizza', 0, 100, 60), 1);
  assert.equal(hintCount('pizza', 0, 100, 90), 1);
  assert.equal(hintCount('pancake', 0, 100, 90), 2);
  assert.equal(hintCount('cat', 0, 100, 99), 0);
  assert.deepEqual(blanks('ice cream', 0, 7), ['_', '_', '_', ' ', '_', '_', '_', '_', '_']);
  const one = blanks('ice cream', 1, 7);
  assert.equal(one.filter((c) => c !== '_' && c !== ' ').length, 1);
  assert.deepEqual(hintSpots('ice cream', 7).sort((a, b) => a - b), [0, 1, 2, 4, 5, 6, 7, 8]);
});

test('a full Draw & Guess turn: pick, guess, close hint, speed points and reveal', async () => {
  const r = await startDraw(3, { rounds: 1, time: 60, words: 'easy' });
  const [host, a, b] = r.engines;
  let st = host.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  assert.equal(st.drawer, 0);
  assert.equal(st.opts.length, 3);
  const guestModel = draw.model(a.snapshot());
  assert.deepEqual(guestModel.choices, []);
  assert.equal(guestModel.word, null);
  const hostModel = draw.model(host.snapshot());
  assert.equal(hostModel.choices.length, 3);
  assert.ok(hostModel.choices.every((c) => c.tier === 'easy'));
  a.act({ type: 'pick', i: 1, n: st.n });
  await r.clock.advance(300);
  assert.equal(host.snapshot().state.draw.phase, 'pick', 'only the drawer can pick');
  st = await pickWord(r, 1);
  assert.equal(st.phase, 'draw');
  assert.equal(st.ends - st.starts, 60000);
  const word = secret(st);
  assert.equal(word, hostModel.choices[1].word);
  assert.equal(JSON.stringify(a.snapshot().state.draw).includes(`"${word}"`), false, 'the word is not in plain sight');
  const gm = draw.model(a.snapshot());
  assert.equal(gm.word, null);
  assert.equal(gm.hint.filter((c) => c === '_').length, word.replace(/ /g, '').length);
  assert.equal(gm.canGuess, true);
  a.act({ type: 'guess', text: 'definitely not it' });
  await r.clock.advance(800);
  const close = word.slice(0, -1) + (word.endsWith('z') ? 'y' : 'z');
  a.act({ type: 'guess', text: close });
  await r.clock.advance(800);
  st = host.snapshot().state.draw;
  assert.deepEqual(st.feed.map((f) => f[3]), ['guess', 'close']);
  const am = draw.model(a.snapshot());
  assert.equal(am.feed[1].text, close);
  assert.equal(draw.model(b.snapshot()).feed[1].text, '', 'others do not see the near miss');
  await r.clock.advance(5000);
  a.act({ type: 'guess', text: word.toUpperCase() });
  await r.clock.advance(400);
  st = host.snapshot().state.draw;
  assert.equal(st.got.length, 1);
  const aPts = st.got[0][1];
  assert.ok(aPts > GUESS_MIN && aPts <= GUESS_MAX);
  host.act({ type: 'guess', text: word });
  await r.clock.advance(300);
  assert.equal(host.snapshot().state.draw.got.length, 1, 'the drawer cannot guess');
  a.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  assert.equal(host.snapshot().state.draw.got.length, 1, 'no double points');
  await r.clock.advance(10000);
  b.act({ type: 'guess', text: word });
  await r.clock.advance(400);
  st = b.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.note, 'all');
  assert.equal(st.word, word);
  const bPts = st.got[1][1];
  assert.ok(aPts > bPts, 'faster guessers score more');
  const g = b.snapshot().scores.g;
  assert.equal(g[1], aPts);
  assert.equal(g[2], bPts);
  assert.equal(g[0], drawerShare([aPts, bPts], 2));
  assert.ok(g[0] <= Math.max(aPts, bPts), 'the drawer never beats the best guesser');
  assert.equal(st.gained[0], g[0]);
  assert.equal(draw.model(b.snapshot()).word, word);
  await r.clock.advance(REVEAL_MS + 300);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  assert.equal(st.drawer, 1);
  assert.equal(st.n, 2);
  assert.deepEqual(r.hub.violations, []);
});

test('the drawer auto-picks when time runs out and the turn ends on time', async () => {
  const r = await startDraw(2, { rounds: 1, time: 60 });
  const [host] = r.engines;
  await r.clock.advance(PICK_MS + 300);
  let st = host.snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  assert.ok(secret(st));
  await r.clock.advance(60000 + 300);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.note, 'time');
  await r.clock.advance(REVEAL_MS + 300);
  st = host.snapshot().state.draw;
  assert.equal(st.drawer, 1);
  await r.clock.advance(PICK_MS + 60000 + REVEAL_MS + 1000);
  assert.equal(host.snapshot().room.phase, 'results');
});

test('strokes sync through ink chunks so late joiners see the drawing, inside the op limits', async () => {
  const r = await startDraw(3, { rounds: 2 });
  const host = r.engines[0];
  await pickWord(r, 0);
  await r.clock.advance(80000 + REVEAL_MS + 600);
  let st = host.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  assert.equal(st.drawer, 1);
  st = await pickWord(r, 0);
  const drawer = bySlot(r, 1);
  const random = seeded(12);
  const strokes = [];
  const start = r.clock.now();
  for (let i = 0; i < 40; i += 1) {
    strokes.push({ c: 1 + (i % 10), z: i % 4, pts: squiggle(120, random, 60 + i * 9, 80 + (i % 7) * 30) });
    const fit = fitInk(strokes, st.nonce, 0);
    for (let j = 0; j < MAX_CHUNKS; j += 1) drawer.direct(inkKey(j), fit.chunks[j] || null);
    if (i % 3 === 0) drawer.broadcast(liveMessage(st.nonce, i, 0, strokes[i].pts.slice(0, 30), strokes[i]));
    await r.clock.advance(250);
  }
  await r.clock.advance(3000);
  const late = r.add(4);
  await r.clock.advance(800);
  const want = fitInk(strokes, st.nonce, 0);
  const seen = readInk(late.snapshot().state, st.nonce);
  assert.equal(seen.strokes.length, want.count);
  assert.ok(seen.strokes.length >= strokes.length);
  for (const [k, v] of Object.entries(r.hub.state)) {
    assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
    if (k.startsWith('ink.')) assert.ok(jsonBytes(v) <= CHUNK_BYTES, k);
  }
  assert.ok(stateBytes(r.hub.state) < MAX_STATE_BYTES);
  const id = drawer.snapshot().me;
  assert.ok(r.hub.opsBy(id, start, r.clock.now() + 1) <= 100 * Math.ceil((r.clock.now() - start) / 10000));
  assert.deepEqual(r.hub.violations, []);
  const m = draw.model(late.snapshot());
  assert.equal(m.canGuess, true);
  await r.clock.advance(70000);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  await r.clock.advance(REVEAL_MS + 300);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  assert.deepEqual(Object.keys(r.hub.state).filter((k) => k.startsWith('ink.')), [], 'old ink is cleared for the next turn');
});

test('the game carries on when the host leaves mid-turn', async () => {
  const r = await startDraw(3, { rounds: 1, time: 80 });
  const [host, a, b] = r.engines;
  await r.clock.advance(PICK_MS + 300);
  await r.clock.advance(80000 + REVEAL_MS + 600);
  let st = a.snapshot().state.draw;
  assert.equal(st.drawer, 1);
  st = await pickWord(r, 2);
  const word = secret(st);
  b.act({ type: 'guess', text: 'nope' });
  await r.clock.advance(800);
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(600);
  assert.equal(a.isHost(), true);
  st = a.snapshot().state.draw;
  assert.equal(st.phase, 'draw', 'the turn keeps going');
  assert.equal(secret(st), word);
  b.act({ type: 'guess', text: word });
  await r.clock.advance(600);
  st = b.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.note, 'all');
  assert.ok(b.snapshot().scores.g[2] > 0);
  await r.clock.advance(REVEAL_MS + 300);
  st = a.snapshot().state.draw;
  assert.equal(st.phase, 'pick');
  assert.equal(st.drawer, 2);
  assert.deepEqual(r.hub.violations, []);
});

test('if the drawer leaves, the turn ends and the word is shown', async () => {
  const r = await startDraw(3, { rounds: 2 });
  const [host] = r.engines;
  await pickWord(r, 0);
  await r.clock.advance(80000 + REVEAL_MS + 600);
  let st = host.snapshot().state.draw;
  assert.equal(st.drawer, 1);
  st = await pickWord(r, 0);
  const gone = bySlot(r, 1);
  r.hub.leave(gone.snapshot().me);
  gone.destroy();
  await r.clock.advance(600);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.note, 'left');
  assert.equal(st.word, secret(st));
  await r.clock.advance(REVEAL_MS + 300);
  assert.equal(host.snapshot().state.draw.drawer, 2);
});

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

function pointer(type, x, y) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  return e;
}

test('the draw view lets the drawer pick and draw, and shows guessers the blanks and the drawing', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const [hostEngine, guestEngine] = r.engines;
  const calls = [];
  const make2d = document.createElement.bind(document);
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, args])), set: (t, k, v) => ((t[k] = v), true) });
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const toasts = [];
  document.createElement = (tag) => {
    const el = make2d(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  const make = (engine) => {
    const v = VIEWS.draw({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win });
    const canvas = all(v.el).find((x) => x.localName === 'canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 360 });
    engine.on('change', (s) => v.update(s));
    return { v, canvas };
  };
  hostEngine.lobby.pick('draw');
  hostEngine.lobby.start();
  const hostView = make(hostEngine);
  const guestView = make(guestEngine);
  hostView.v.update(hostEngine.snapshot());
  guestView.v.update(guestEngine.snapshot());
  await r.clock.advance(400);
  assert.match(text(guestView.v.el), /Player 1\s+is picking a word/);
  assert.equal(byKey(guestView.v.el, 'word-0'), null);
  byKey(hostView.v.el, 'word-2').click();
  await r.clock.advance(400);
  const st = hostEngine.snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  const word = secret(st);
  assert.match(text(hostView.v.el), new RegExp(`Draw this:\\s+${word}`));
  assert.equal(text(guestView.v.el).includes(word), false);
  assert.match(hostView.v.el.querySelector('.draw-board').className, /is-drawing/);
  byKey(hostView.v.el, 'color-3').click();
  byKey(hostView.v.el, 'size-2').click();
  hostView.canvas.dispatchEvent(pointer('pointerdown', 10, 10));
  for (let i = 1; i <= 20; i += 1) hostView.canvas.dispatchEvent(pointer('pointermove', 10 + i * 5, 10 + i * 3));
  await r.clock.advance(300);
  hostView.canvas.dispatchEvent(pointer('pointerup', 110, 70));
  await r.clock.advance(1500);
  let ink = readInk(guestEngine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 1);
  assert.equal(ink.strokes[0].c, 3);
  assert.equal(ink.strokes[0].z, 2);
  assert.ok(calls.some(([k]) => k === 'lineTo'));
  hostView.canvas.dispatchEvent(pointer('pointerdown', 200, 200));
  hostView.canvas.dispatchEvent(pointer('pointermove', 220, 210));
  hostView.canvas.dispatchEvent(pointer('pointerup', 220, 210));
  await r.clock.advance(1500);
  assert.equal(readInk(guestEngine.snapshot().state, st.nonce).strokes.length, 2);
  byKey(hostView.v.el, 'undo').click();
  await r.clock.advance(1500);
  ink = readInk(guestEngine.snapshot().state, st.nonce);
  assert.equal(ink.strokes.length, 1);
  byKey(hostView.v.el, 'clear').click();
  await r.clock.advance(1500);
  assert.equal(readInk(guestEngine.snapshot().state, st.nonce).strokes.length, 0);
  const input = byKey(guestView.v.el, 'guess-input');
  assert.equal(input.disabled, false);
  input.value = word.slice(0, -1) + (word.endsWith('q') ? 'x' : 'q');
  byKey(guestView.v.el, 'guess-send').click();
  await r.clock.advance(800);
  assert.match(text(guestView.v.el), /so close!/);
  assert.ok(toasts.some((t) => /So close/.test(t)));
  input.value = word;
  byKey(guestView.v.el, 'guess-send').click();
  await r.clock.advance(800);
  assert.match(text(guestView.v.el), /The word was\s+/);
  assert.match(text(guestView.v.el), /Everyone got it!/);
  hostView.v.destroy();
  guestView.v.destroy();
  assert.deepEqual(r.hub.violations, []);
});

test('someone who joins mid-turn can guess right away, never sees the word, and gets a turn to draw', async () => {
  const r = await startDraw(3, { rounds: 1, time: 80 });
  const [host, a, b] = r.engines;
  let st = await pickWord(r, 0);
  const word = secret(st);
  a.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  const late = r.add(4);
  await r.clock.advance(600);
  joinIn(late);
  await r.clock.advance(800);
  b.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  st = host.snapshot().state.draw;
  const lateSlot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(lateSlot), 'the late joiner has a seat');
  assert.equal(st.phase, 'draw', 'the turn waits for the new guesser');
  assert.ok(st.order.includes(lateSlot));
  assert.ok(st.order.indexOf(lateSlot) > st.pos, 'they draw later in the rotation');
  const m = draw.model(late.snapshot());
  assert.equal(m.word, null);
  assert.equal(m.canGuess, true);
  assert.equal(m.hint.filter((c) => c === '_').length, word.replace(/ /g, '').length);
  installDom({ url: 'https://yapos.dev/activity/' });
  const view = VIEWS.draw({ engine: late, fx: { confetti() {} }, toast() {}, win: { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} } });
  view.update(late.snapshot());
  assert.equal(text(view.el).toLowerCase().includes(word), false, 'the word stays hidden from the late joiner');
  view.destroy();
  late.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.note, 'all');
  assert.equal(st.got.length, 3);
  const best = Math.max(...st.got.map((g) => g[1]));
  assert.equal(st.gained[0], drawerShare(st.got.map((g) => g[1]), 3));
  assert.ok(st.gained[0] <= best);
  const drawers = [st.drawer];
  for (let i = 0; i < 6 && host.snapshot().room.phase === 'game'; i += 1) {
    await r.clock.advance(REVEAL_MS + 300);
    const now = host.snapshot().state.draw;
    if (!now) break;
    if (!drawers.includes(now.drawer)) drawers.push(now.drawer);
    await r.clock.advance(PICK_MS + 80000 + 600);
  }
  assert.ok(drawers.includes(lateSlot), `late joiner drew: ${drawers}`);
  assert.deepEqual(r.hub.violations, []);
});

test('the drawer shows with their picture, name and @username so they can be reported', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startDraw(3, { rounds: 1 });
  const [host, a] = r.engines;
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const pic = 'https://files.yapper.website/avatars/p1.png';
  const dress = (snap, named = true) => ({
    ...snap,
    players: snap.players.map((p) => ({ ...p, username: named ? `handle${p.slot}` : null, avatar: p.slot === 0 ? pic : p.avatar })),
  });
  const view = VIEWS.draw({ engine: a, fx: { confetti() {} }, toast() {}, win });
  view.update(dress(a.snapshot()));
  let shown = text(view.el);
  assert.match(shown, /Player 1\s+is picking a word/);
  assert.match(shown, /@handle0/);
  const pics = all(view.el).filter((x) => x.localName === 'img' && x.src === pic);
  assert.ok(pics.length >= 1, 'the real avatar is used');
  let st = await pickWord(r, 0);
  view.update(dress(a.snapshot()));
  shown = text(view.el);
  assert.match(shown, /Player 1\s+is drawing/);
  assert.match(shown, /@handle0/);
  const word = secret(st);
  a.act({ type: 'guess', text: word });
  await r.clock.advance(800);
  r.engines[2].act({ type: 'guess', text: word });
  await r.clock.advance(800);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'reveal');
  view.update(dress(a.snapshot()));
  shown = text(view.el);
  assert.match(shown, /Player 1\s+drew this/);
  assert.match(shown, /@handle0/);
  assert.ok(shown.includes(`+${st.gained[0]} for the drawing`), shown);
  const pencil = all(view.el).find((x) => x.classList && (x.classList.contains('draw-pencil') || x.classList.contains('board-badge')));
  assert.ok(pencil || all(view.el).some((x) => x.dataset && x.dataset.badge), 'the drawer is marked on the scoreboard');
  view.update(dress(a.snapshot(), false));
  shown = text(view.el);
  assert.equal(shown.includes('@'), false, 'no handle when the username is unknown');
  assert.equal(shown.includes('null'), false);
  view.destroy();
  const mine = VIEWS.draw({ engine: host, fx: { confetti() {} }, toast() {}, win });
  mine.update(dress(host.snapshot()));
  assert.match(text(mine.el), /You drew this/);
  assert.match(text(mine.el), /for your drawing/);
  mine.destroy();
});
