import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { room, seeded, person } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import odd, {
  KEY,
  INTRO_MS,
  TURN_MS,
  VOTE_MS,
  GUESS_MS,
  REVEAL_MS,
  VOTE_POINTS,
  CREW_BONUS,
  ESCAPE_POINTS,
  STEAL_POINTS,
  CHOICES,
  CAP_MIN,
  CAP_MAX,
  INK_MAX,
  tally,
  award,
  fitStroke,
  joinParts,
  strokeCap,
  capFor,
  compact,
  squeeze,
  STROKE_POINTS,
  pickOdd,
  pickWord,
  guessChoices,
  secretWord,
  secretOdd,
  wordKey,
} from '../web/activity/js/games/odd.js';
import { createOddView, oddMoments, headline, footText, roleText } from '../web/activity/js/views/odd.js';
import { TOPICS, WORDS, wordById, wordsOf } from '../web/activity/data/odd.js';
import { readInk, inkBytes, GRID_W, GRID_H, MAX_CHUNKS } from '../web/activity/js/games/ink.js';
import { unmask } from '../web/activity/js/games/draw.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import { jsonBytes, MAX_VALUE_BYTES, MAX_STATE_BYTES, MAX_KEYS, stateBytes } from '../web/activity/js/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const activity = path.join(here, '..', 'web', 'activity');
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function squiggle(n, random, x0 = 100, y0 = 100, step = 8) {
  const pts = [];
  let x = x0;
  let y = y0;
  for (let i = 0; i < n; i += 1) {
    x = Math.min(GRID_W, Math.max(0, x + (random() - 0.5) * step));
    y = Math.min(GRID_H, Math.max(0, y + (random() - 0.5) * step));
    pts.push([Math.round(x), Math.round(y)]);
  }
  return pts;
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function hostOf(r) {
  return r.engines.find((e) => e.isHost());
}

function st(r) {
  return hostOf(r).snapshot().state[KEY];
}

async function startOdd(n = 4, settings = {}, seed = 11) {
  const r = room(n, { games: [odd], seed });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('odd'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function drawLine(r, random, size = 60) {
  const s = st(r);
  const parts = fitStroke(squiggle(size, random, 60 + (s.n % 8) * 40, 60 + (s.n % 5) * 50), 1, 1, s.cap);
  bySlot(r, s.turn).act({ type: 'stroke', n: s.n, s: parts });
  await r.clock.advance(400);
  return st(r);
}

async function drawAll(r, random) {
  let s = st(r);
  let guard = 0;
  while (s.phase === 'draw' && guard < 100) {
    s = await drawLine(r, random);
    guard += 1;
  }
  return s;
}

function checkLimits(r) {
  for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, `${k} is ${jsonBytes(v)} bytes`);
  assert.ok(stateBytes(r.hub.state) < MAX_STATE_BYTES, `state is ${stateBytes(r.hub.state)} bytes`);
  assert.ok(Object.keys(r.hub.state).length < MAX_KEYS);
  assert.deepEqual(r.hub.violations, []);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

test('the topic list has about 30 family friendly topics of common drawable words', () => {
  assert.ok(TOPICS.length >= 30, String(TOPICS.length));
  const seen = new Set();
  const ids = new Set();
  for (const t of TOPICS) {
    assert.equal(ids.has(t.id), false, t.id);
    ids.add(t.id);
    assert.ok(t.name && t.emoji, t.id);
    assert.ok(t.words.length >= 10, `${t.id} has ${t.words.length}`);
    assert.ok(t.words.length >= CHOICES, t.id);
    for (const w of t.words) {
      assert.match(w, /^[a-z]+( [a-z]+)*$/, w);
      assert.ok(w.length <= 20, w);
      assert.equal(seen.has(w), false, `${w} is in two topics`);
      seen.add(w);
      for (const re of BANNED) assert.equal(re.test(w), false, w);
    }
  }
  for (const w of WORDS) assert.equal(wordById(w.id), w);
  assert.ok(WORDS.length < 65536);
});

test('Odd One Out is a drawing game for three or more with laps, rounds and topic settings', () => {
  assert.equal(odd.id, 'odd');
  assert.equal(odd.category, 'drawing');
  assert.equal(odd.minPlayers, 3);
  assert.equal(odd.emoji, '🕵️');
  assert.deepEqual(odd.prefixes, ['ink.']);
  assert.equal(odd.open, undefined, 'only the host writes ink');
  const laps = odd.settings.find((s) => s.id === 'laps');
  assert.deepEqual(laps.options.map((o) => o.value), [1, 2, 3]);
  const topic = odd.settings.find((s) => s.id === 'topic');
  assert.equal(topic.default, 'mix');
  assert.equal(topic.options.length, TOPICS.length + 1);
  for (const re of BANNED) assert.equal(re.test(`${odd.name} ${odd.blurb}`), false);
  for (const hook of ['start', 'intent', 'deadline', 'admin', 'resume', 'join', 'roster', 'model']) assert.equal(typeof odd[hook], 'function', hook);
});

test('votes are tallied and ties never catch anyone', () => {
  assert.deepEqual(tally({ 1: 3, 2: 3, 3: 1 }), { counts: { 3: 2, 1: 1 }, top: 3, best: 2, tied: false });
  assert.equal(tally({ 1: 2, 2: 1 }).top, null);
  assert.equal(tally({}).top, null);
});

test('scoring rewards sharp voters, a sneaky escape and a stolen win', () => {
  const order = [1, 2, 3, 4];
  const votes = { 1: 3, 2: 3, 3: 1, 4: 2 };
  assert.deepEqual(award({ order, odd: 3, votes, caught: true, stole: false }), { 1: VOTE_POINTS + CREW_BONUS, 2: VOTE_POINTS + CREW_BONUS, 4: CREW_BONUS });
  assert.deepEqual(award({ order, odd: 3, votes, caught: true, stole: true }), { 1: VOTE_POINTS, 2: VOTE_POINTS, 3: STEAL_POINTS });
  assert.deepEqual(award({ order, odd: 4, votes, caught: false, stole: false }), { 4: ESCAPE_POINTS });
  assert.ok(ESCAPE_POINTS > STEAL_POINTS && STEAL_POINTS > VOTE_POINTS);
});

test('strokes are squeezed to fit a per turn budget that keeps the whole drawing under the limits', () => {
  assert.equal(strokeCap(1), CAP_MAX);
  assert.equal(strokeCap(1000), CAP_MIN);
  assert.ok(strokeCap(48) * 48 <= INK_MAX);
  const random = seeded(3);
  const pts = squiggle(1500, random, 200, 150, 30);
  for (const cap of [CAP_MIN, 500, CAP_MAX]) {
    const parts = fitStroke(pts, 3, 1, cap);
    assert.ok(parts && parts.length, String(cap));
    assert.ok(parts.reduce((a, s) => a + s.length, 0) <= cap, String(cap));
    assert.ok(joinParts(parts).length >= 1);
  }
  assert.equal(fitStroke([], 1, 1, 500), null);
  assert.equal(joinParts(['garbage!']), null);
  assert.equal(joinParts('nope'), null);
  assert.equal(joinParts(Array(20).fill('BBAAAA')), null);
});

test('the faker rotates fairly and words avoid repeats and come from the chosen topic', () => {
  const random = seeded(5);
  assert.equal(pickOdd([1, 2, 3], [1, 2], random), 3);
  const counts = { 1: 0, 2: 0, 3: 0 };
  const past = [];
  for (let i = 0; i < 9; i += 1) {
    const o = pickOdd([1, 2, 3], past, random);
    counts[o] += 1;
    past.push(o);
  }
  assert.deepEqual(counts, { 1: 3, 2: 3, 3: 3 });
  const used = [];
  for (let i = 0; i < 10; i += 1) {
    const w = pickWord('food', used, random);
    assert.equal(w.topic, 'food');
    assert.equal(used.includes(w.id), false);
    used.push(w.id);
  }
  const mixed = pickWord('mix', [], random);
  const next = pickWord('mix', [mixed.id], random);
  assert.notEqual(next.topic, mixed.topic, 'mixed mode changes topic between rounds');
  const choices = guessChoices(mixed, random);
  assert.equal(choices.length, CHOICES);
  assert.ok(choices.includes(mixed.id));
  assert.equal(new Set(choices).size, CHOICES);
  for (const id of choices) assert.equal(wordById(id).topic, mixed.topic);
});

test('a full game: roles, one line each per lap, voting, a caught faker stealing the win, then an escape on time', async () => {
  const r = await startOdd(4, { rounds: 2, laps: 2 });
  const random = seeded(21);
  let s = st(r);
  assert.equal(s.phase, 'intro');
  const word = secretWord(s);
  const o = secretOdd(s);
  assert.ok(word && word.w);
  assert.ok(slotsOf(r).includes(o));
  assert.notEqual(s.order[0], o, 'the faker never has to draw first');
  for (const e of r.engines) {
    const m = odd.model(e.snapshot());
    if (e.snapshot().meSlot === o) {
      assert.equal(m.role, 'odd');
      assert.equal(m.word, null);
      assert.match(roleText(m).title, /Odd One Out/);
    } else {
      assert.equal(m.role, 'crew');
      assert.equal(m.word, word.w);
    }
    assert.equal(m.topic.name, TOPICS.find((t) => t.id === word.topic).name);
  }
  await r.clock.advance(INTRO_MS + 100);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.turn, s.order[0]);
  const wrong = bySlot(r, s.order[1]);
  wrong.act({ type: 'stroke', n: s.n, s: fitStroke(squiggle(20, random), 1, 1, s.cap) });
  await r.clock.advance(400);
  assert.equal(st(r).turn, s.order[0], 'only the current player can draw');
  s = await drawLine(r, random);
  assert.equal(s.turn, s.order[1]);
  const seenBy = readInk(r.engines[2].snapshot().state, s.k);
  assert.ok(seenBy.strokes.length >= 1);
  assert.equal(seenBy.strokes[0].c, s.cols[0], 'each player draws in their own color');
  s = await drawAll(r, random);
  assert.equal(s.phase, 'vote');
  assert.equal(s.marks.length, 8);
  assert.deepEqual([...new Set(s.marks)].sort(), [...s.order].sort());
  for (const slot of s.order) assert.equal(s.marks.filter((x) => x === slot).length, 2);
  const crew = s.order.filter((x) => x !== o);
  bySlot(r, crew[0]).act({ type: 'vote', target: crew[0], r: s.r });
  bySlot(r, crew[0]).act({ type: 'vote', target: 99, r: s.r });
  await r.clock.advance(300);
  assert.deepEqual(st(r).voted, []);
  for (const c of crew) bySlot(r, c).act({ type: 'vote', target: o, r: s.r });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.voted.length, 3);
  assert.equal(s.votes, null, 'votes stay hidden until everyone is in');
  bySlot(r, crew[1]).act({ type: 'vote', target: crew[2], r: s.r });
  await r.clock.advance(300);
  assert.equal(st(r).voted.length, 3, 'one vote each');
  bySlot(r, o).act({ type: 'vote', target: crew[0], r: s.r });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'guess');
  assert.equal(s.odd, o);
  assert.equal(s.opts.length, CHOICES);
  const right = s.opts.findIndex((code) => unmask(code, wordKey(s.k)) === word.id);
  assert.ok(right >= 0);
  bySlot(r, crew[0]).act({ type: 'guess', i: right, r: s.r });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'guess', 'only the faker guesses');
  const view = odd.model(bySlot(r, crew[1]).snapshot());
  assert.equal(view.canGuess, false);
  assert.equal(odd.model(bySlot(r, o).snapshot()).canGuess, true);
  bySlot(r, o).act({ type: 'guess', i: right, r: s.r });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.caught, true);
  assert.equal(s.stole, true);
  assert.equal(s.word, word.w);
  assert.equal(s.guess, word.w);
  let pts = hostOf(r).snapshot().scores.g;
  for (const c of crew) assert.equal(pts[c], VOTE_POINTS);
  assert.equal(pts[o], STEAL_POINTS);
  const reveal = odd.model(bySlot(r, crew[0]).snapshot());
  assert.match(headline(reveal), /guessed the word/);
  assert.equal(reveal.tally[0].slot, o);
  assert.equal(reveal.tally[0].count, 3);
  await r.clock.advance(REVEAL_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'intro');
  assert.equal(s.r, 2);
  const o2 = secretOdd(s);
  assert.notEqual(o2, o, 'someone new fakes it next round');
  assert.notEqual(secretWord(s).id, word.id);
  assert.deepEqual(Object.keys(r.hub.state).filter((k) => k.startsWith('ink.')), [], 'the old drawing is cleared');
  await r.clock.advance(INTRO_MS + 8 * TURN_MS + 1000);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.deepEqual(s.marks, [-1, -1, -1, -1, -1, -1, -1, -1]);
  await r.clock.advance(VOTE_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.caught, false);
  pts = hostOf(r).snapshot().scores.g;
  assert.equal(pts[o2], (o2 === o ? STEAL_POINTS : VOTE_POINTS) + ESCAPE_POINTS * 2, 'the final round counts double');
  assert.match(footText(odd.model(bySlot(r, o2).snapshot())), /\+600/);
  await r.clock.advance(REVEAL_MS + 200);
  assert.equal(hostOf(r).snapshot().room.phase, 'results');
  checkLimits(r);
});

test('a caught faker who runs out of time loses, and the whole crew gets a team bonus', async () => {
  const r = await startOdd(3, { rounds: 1, laps: 1 });
  let s = st(r);
  const o = secretOdd(s);
  const crew = s.order.filter((x) => x !== o);
  await r.clock.advance(INTRO_MS + 3 * TURN_MS + 600);
  s = st(r);
  assert.equal(s.phase, 'vote');
  bySlot(r, crew[0]).act({ type: 'vote', target: o, r: s.r });
  bySlot(r, crew[1]).act({ type: 'vote', target: o, r: s.r });
  await r.clock.advance(VOTE_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'guess');
  await r.clock.advance(GUESS_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.stole, false);
  assert.equal(s.guess, null);
  const pts = hostOf(r).snapshot().scores.g;
  assert.equal(pts[crew[0]], VOTE_POINTS + CREW_BONUS);
  assert.equal(pts[crew[1]], VOTE_POINTS + CREW_BONUS);
  assert.equal(pts[o] || 0, 0);
  assert.match(headline(odd.model(bySlot(r, crew[0]).snapshot())), /Caught!/);
});

test('someone who joins mid-round watches, cannot vote, and plays from the next round', async () => {
  const r = await startOdd(3, { rounds: 2, laps: 1 });
  await r.clock.advance(INTRO_MS + 200);
  const late = r.add(4);
  await r.clock.advance(800);
  let s = st(r);
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  assert.ok(s.wait.includes(slot));
  assert.equal(s.order.includes(slot), false);
  const m = odd.model(late.snapshot());
  assert.equal(m.role, 'watch');
  assert.equal(m.waiting, true);
  assert.equal(m.word, null);
  assert.match(roleText(m).title, /next round/);
  await r.clock.advance(3 * TURN_MS + 600);
  s = st(r);
  assert.equal(s.phase, 'vote');
  late.act({ type: 'vote', target: s.order[0], r: s.r });
  await r.clock.advance(400);
  assert.deepEqual(st(r).voted, []);
  await r.clock.advance(VOTE_MS + REVEAL_MS + 600);
  s = st(r);
  assert.equal(s.r, 2);
  assert.ok(s.order.includes(slot));
  assert.notEqual(odd.model(late.snapshot()).role, 'watch');
  checkLimits(r);
});

test('admins can skip each phase and add or take away time', async () => {
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
  const r = room(4, { games: [odd], seed: 9 });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await r.clock.advance(300);
  const [host, owner] = r.engines;
  host.lobby.pick('odd');
  host.lobby.setting('laps', 1);
  host.lobby.setting('rounds', 1);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  let s = st(r);
  assert.equal(s.phase, 'intro');
  owner.admin.run({ type: 'time', ms: 10000 });
  await r.clock.advance(300);
  assert.equal(st(r).ends, s.ends + 10000);
  assert.equal(host.snapshot().room.deadline, s.ends + 10000);
  owner.admin.run({ type: 'skip' });
  await r.clock.advance(300);
  s = st(r);
  assert.equal(s.phase, 'draw');
  const first = s.turn;
  owner.admin.run({ type: 'skip' });
  await r.clock.advance(300);
  s = st(r);
  assert.notEqual(s.turn, first);
  assert.deepEqual(s.marks, [-1]);
  owner.admin.run({ type: 'time', ms: -20000 });
  await r.clock.advance(300);
  assert.ok(st(r).ends - r.clock.now() < 6000);
  for (let i = 0; i < 3; i += 1) {
    owner.admin.run({ type: 'skip' });
    await r.clock.advance(300);
  }
  s = st(r);
  assert.equal(s.phase, 'vote');
  owner.admin.run({ type: 'skip' });
  await r.clock.advance(300);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.caught, false);
  owner.admin.run({ type: 'skip' });
  await r.clock.advance(300);
  assert.equal(host.snapshot().room.phase, 'results');
  resetAdmins();
});

async function startWithCrewHost(n, settings) {
  for (let seed = 1; seed < 40; seed += 1) {
    const r = await startOdd(n, settings, seed);
    const s = st(r);
    if (![r.engines[0], r.engines[1]].map((e) => e.snapshot().meSlot).includes(secretOdd(s))) return r;
    for (const e of r.engines) e.destroy();
  }
  throw new Error('no seed found');
}

test('the round carries on when the host leaves mid-drawing, and the vote restarts kindly if it leaves mid-vote', async () => {
  const r = await startWithCrewHost(5, { rounds: 1, laps: 1 });
  const random = seeded(4);
  await r.clock.advance(INTRO_MS + 200);
  let s = await drawLine(r, random);
  const word = secretWord(s);
  const o = secretOdd(s);
  const host = r.engines[0];
  r.hub.leave(host.snapshot().me);
  host.destroy();
  r.engines.shift();
  await r.clock.advance(800);
  const next = hostOf(r);
  assert.ok(next);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(secretWord(s).id, word.id);
  assert.equal(secretOdd(s), o);
  s = await drawAll(r, random);
  assert.equal(s.phase, 'vote');
  const crew = s.order.filter((x) => x !== o && bySlot(r, x));
  bySlot(r, crew[0]).act({ type: 'vote', target: o, r: s.r });
  await r.clock.advance(400);
  assert.equal(st(r).voted.length, 1);
  const host2 = hostOf(r);
  assert.notEqual(host2.snapshot().meSlot, o);
  r.hub.leave(host2.snapshot().me);
  host2.destroy();
  r.engines.splice(r.engines.indexOf(host2), 1);
  await r.clock.advance(800);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.note, 'host');
  assert.deepEqual(s.voted, []);
  for (const e of r.engines) {
    const me = e.snapshot().meSlot;
    if (!s.order.includes(me)) continue;
    e.act({ type: 'vote', target: me === o ? s.order.find((x) => x !== o && x !== me) : o, r: s.r });
  }
  await r.clock.advance(600);
  s = st(r);
  assert.ok(s.phase === 'guess' || s.phase === 'reveal', s.phase);
  checkLimits(r);
});

test('if the faker leaves, the round ends and the word is shown with no points', async () => {
  const r = await startWithCrewHost(4, { rounds: 1, laps: 2 });
  await r.clock.advance(INTRO_MS + 200);
  let s = st(r);
  const o = secretOdd(s);
  const gone = bySlot(r, o);
  r.hub.leave(gone.snapshot().me);
  gone.destroy();
  await r.clock.advance(800);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'left');
  assert.equal(s.word, secretWord(s).w);
  assert.deepEqual(s.gained, {});
  assert.match(headline(odd.model(r.engines[0].snapshot())), /left/);
});

test('16 players with three laps of long lines stay inside every shared state limit', async () => {
  const r = await startOdd(16, { rounds: 1, laps: 3 });
  const random = seeded(77);
  await r.clock.advance(INTRO_MS + 200);
  let s = st(r);
  assert.equal(s.order.length, 16);
  let guard = 0;
  while (s.phase === 'draw' && guard < 60) {
    const pts = squiggle(1500, random, 40 + random() * 400, 40 + random() * 280, 40);
    const parts = fitStroke(pts, 1, 1, s.cap);
    assert.ok(jsonBytes({ t: 'g', g: 'odd', a: { type: 'stroke', n: s.n, s: parts } }) < MAX_VALUE_BYTES);
    bySlot(r, s.turn).act({ type: 'stroke', n: s.n, s: parts });
    await r.clock.advance(1500);
    s = st(r);
    guard += 1;
  }
  assert.equal(s.phase, 'vote');
  assert.equal(s.marks.length, 48);
  assert.equal(s.marks.filter((x) => x >= 0).length, 48, 'every line made it onto the canvas');
  const chunks = Object.entries(r.hub.state).filter(([k]) => k.startsWith('ink.')).map(([, v]) => v);
  assert.ok(chunks.length <= MAX_CHUNKS);
  assert.ok(inkBytes(chunks) <= INK_MAX);
  assert.ok(jsonBytes(s) < 2048, `${jsonBytes(s)} bytes of game state`);
  for (const e of r.engines) {
    const me = e.snapshot().meSlot;
    e.act({ type: 'vote', target: s.order.find((x) => x !== me), r: s.r });
  }
  await r.clock.advance(800);
  s = st(r);
  assert.ok(s.phase === 'guess' || s.phase === 'reveal');
  checkLimits(r);
});

test('the secret word and the faker never show up in plain text before the reveal', async () => {
  for (const seed of [3, 8, 15]) {
    const r = await startOdd(4, { rounds: 1, laps: 1 }, seed);
    const random = seeded(seed);
    let s = st(r);
    const word = secretWord(s);
    const o = secretOdd(s);
    const check = () => {
      const cur = r.hub.state[KEY];
      const text = JSON.stringify(cur);
      assert.equal(text.includes(`"${word.w}"`), false, `${word.w} leaked`);
      assert.equal(cur.odd, null);
      assert.equal(cur.word, null);
      assert.equal(cur.votes, null);
      assert.equal((cur.used || []).includes(word.id), false);
      assert.equal((cur.past || []).includes(o), false);
      assert.notEqual(cur.w, word.id);
    };
    check();
    await r.clock.advance(INTRO_MS + 200);
    s = await drawAll(r, random);
    check();
    for (const e of r.engines) {
      const me = e.snapshot().meSlot;
      e.act({ type: 'vote', target: s.order.find((x) => x !== me), r: s.r });
      await r.clock.advance(200);
      if (st(r).phase === 'vote') check();
    }
  }
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

function noInlineStyles(root) {
  for (const el of all(root)) assert.equal(el.getAttribute('style'), null, el.className);
}

test('the view shows each role, lets the current player draw one line, vote, guess and see the reveal', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3, { games: [odd], seed: 11 });
  await r.clock.advance(500);
  const calls = [];
  const make2d = document.createElement.bind(document);
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, args])), set: (t, k, v) => ((t[k] = v), true) });
  document.createElement = (tag) => {
    const el = make2d(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout };
  const played = r.engines.map(() => []);
  const views = r.engines.map((engine, i) => {
    const v = createOddView({ engine, fx: { confetti() {} }, toast() {}, win, cues: { play: (n) => played[i].push(n), burst() {}, float() {} } });
    const canvas = all(v.el).find((x) => x.localName === 'canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 360 });
    engine.on('change', (s) => v.update(s));
    return { v, canvas, engine };
  });
  const host = r.engines[0];
  host.lobby.pick('odd');
  host.lobby.setting('laps', 1);
  host.lobby.setting('rounds', 1);
  host.lobby.start();
  for (const x of views) x.v.update(x.engine.snapshot());
  await r.clock.advance(400);
  let s = st(r);
  const word = secretWord(s);
  const o = secretOdd(s);
  const viewOf = (slot) => views.find((x) => x.engine.snapshot().meSlot === slot);
  const oddView = viewOf(o);
  const crewViews = views.filter((x) => x !== oddView);
  assert.match(text(oddView.v.el), /You're the Odd One Out!/);
  assert.match(text(oddView.v.el), new RegExp(`The topic is ${TOPICS.find((t) => t.id === word.topic).name}`));
  assert.equal(text(oddView.v.el).includes(word.w), false, 'the faker never sees the word');
  for (const c of crewViews) assert.match(text(c.v.el), new RegExp(`The word is\\s+${word.w}`));
  noInlineStyles(oddView.v.el);
  byKey(crewViews[0].v.el, 'odd-hide').click();
  assert.equal(text(crewViews[0].v.el).includes(word.w), false, 'a hidden card hides the word');
  byKey(crewViews[0].v.el, 'odd-hide').click();
  assert.ok(text(crewViews[0].v.el).includes(word.w));
  await r.clock.advance(INTRO_MS);
  s = st(r);
  assert.equal(s.phase, 'draw');
  const drawer = viewOf(s.turn);
  const other = views.find((x) => x !== drawer);
  assert.match(text(drawer.v.el), /Your turn! Draw ONE line/);
  assert.match(drawer.v.el.querySelector('.odd-board').className, /is-drawing/);
  assert.doesNotMatch(other.v.el.querySelector('.odd-board').className, /is-drawing/);
  assert.ok(played[views.indexOf(drawer)].includes('turn'));
  other.canvas.dispatchEvent(pointer('pointerdown', 10, 10));
  other.canvas.dispatchEvent(pointer('pointerup', 10, 10));
  drawer.canvas.dispatchEvent(pointer('pointerdown', 20, 20));
  for (let i = 1; i <= 20; i += 1) drawer.canvas.dispatchEvent(pointer('pointermove', 20 + i * 6, 20 + i * 4));
  await r.clock.advance(300);
  drawer.canvas.dispatchEvent(pointer('pointerup', 140, 100));
  await r.clock.advance(600);
  let ink = readInk(other.engine.snapshot().state, s.k);
  assert.equal(ink.strokes.length, 1);
  assert.equal(ink.strokes[0].c, s.cols[0]);
  assert.ok(calls.some(([k]) => k === 'lineTo'));
  drawer.canvas.dispatchEvent(pointer('pointerdown', 200, 200));
  drawer.canvas.dispatchEvent(pointer('pointerup', 220, 220));
  await r.clock.advance(600);
  assert.equal(readInk(other.engine.snapshot().state, s.k).strokes.length, 1, 'one line per turn');
  s = st(r);
  assert.notEqual(s.turn, drawer.engine.snapshot().meSlot);
  while (st(r).phase === 'draw') {
    const cur = viewOf(st(r).turn);
    cur.canvas.dispatchEvent(pointer('pointerdown', 300, 200));
    cur.canvas.dispatchEvent(pointer('pointermove', 340, 240));
    cur.canvas.dispatchEvent(pointer('pointerup', 340, 240));
    await r.clock.advance(600);
  }
  s = st(r);
  assert.equal(s.phase, 'vote');
  noInlineStyles(drawer.v.el);
  for (const x of views) {
    const me = x.engine.snapshot().meSlot;
    assert.equal(byKey(x.v.el, `vote-${me}`), null, 'you cannot vote for yourself');
    assert.match(text(x.v.el), /0 of 3 players voted/);
  }
  for (const c of crewViews) byKey(c.v.el, `vote-${o}`).click();
  await r.clock.advance(400);
  assert.match(text(crewViews[0].v.el), /Your vote/);
  const scapegoat = s.order.find((x) => x !== o);
  byKey(oddView.v.el, `vote-${scapegoat}`).click();
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'guess');
  noInlineStyles(oddView.v.el);
  assert.match(text(oddView.v.el), /You got caught! Pick the secret word/);
  assert.match(text(crewViews[0].v.el), /got caught! They get one guess/);
  assert.equal(byKey(crewViews[0].v.el, 'guess-0').disabled, true);
  const wrongI = s.opts.findIndex((code) => unmask(code, wordKey(s.k)) !== word.id);
  byKey(oddView.v.el, `guess-${wrongI}`).click();
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  for (const x of views) {
    assert.match(text(x.v.el), new RegExp(`The word was\\s+${word.w}`));
    noInlineStyles(x.v.el);
  }
  assert.match(text(crewViews[0].v.el), /Caught!/);
  assert.match(text(crewViews[0].v.el), /Team win!/);
  assert.match(text(oddView.v.el), /You were the Odd One Out/);
  assert.ok(played[views.indexOf(crewViews[0])].includes('correct'));
  assert.ok(played[views.indexOf(oddView)].includes('wrong'));
  for (const list of played) {
    assert.equal(list.includes('start'), false);
    assert.equal(list.includes('win'), false);
    assert.equal(list.includes('coin'), false);
  }
  for (const x of views) x.v.destroy();
  assert.deepEqual(r.hub.violations, []);
});

test('sounds fire once per moment and never on the first render', () => {
  const base = { r: 1, phase: 'draw', n: 2, myTurn: true, role: 'crew', gained: 0, note: null, canGuess: false, seats: [{ isMe: false, lines: 1 }] };
  assert.deepEqual(oddMoments(null, base).cues, []);
  const { now } = oddMoments(null, { ...base, n: 1, myTurn: false });
  const turn = oddMoments(now, base);
  assert.deepEqual(turn.cues.map((c) => c.name), ['turn']);
  assert.deepEqual(oddMoments(turn.now, base).cues, []);
  const more = oddMoments(turn.now, { ...base, seats: [{ isMe: false, lines: 2 }] });
  assert.deepEqual(more.cues.map((c) => c.name), ['pop']);
  const rev = oddMoments(more.now, { ...base, phase: 'reveal', myTurn: false, gained: 150, seats: [{ isMe: false, lines: 2 }] });
  assert.deepEqual(rev.cues.map((c) => c.name), ['reveal', 'correct']);
  assert.deepEqual(oddMoments(rev.now, { ...base, phase: 'reveal', myTurn: false, gained: 150, seats: [{ isMe: false, lines: 2 }] }).cues, []);
});

test('Odd One Out files have no comments, inline styles or outside resources, and use only odd- classes in its stylesheet', () => {
  const files = ['js/games/odd.js', 'js/views/odd.js', 'data/odd.js', 'css/odd.css'].map((f) => path.join(activity, f));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, `${f} has a block comment`);
    assert.equal(/(^|[^:'"`])\/\/(?![^\n]*['"`])/m.test(src), false, `${f} has a line comment`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, f);
    assert.equal(/https?:\/\//.test(src), false, f);
    assert.equal(/\beval\(|new Function/.test(src), false, f);
    for (const re of BANNED) assert.equal(re.test(src.replace(/aria-|tail/g, '')), false, `${f} ${re}`);
  }
  const css = readFileSync(path.join(activity, 'css', 'odd.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(/url\(|@import|@font-face/.test(css), false);
  const classes = [...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  const own = classes.filter((c) => c.startsWith('odd-'));
  assert.ok(own.length > 20);
  const reused = new Set(classes.filter((c) => !c.startsWith('odd-')));
  for (const c of reused) assert.ok(['is-crew', 'is-odd', 'is-hidden', 'is-up', 'is-me', 'is-away', 'is-mine', 'is-caught', 'is-escaped', 'play', 'game-odd', 'strip', 'strip-list', 'strip-empty'].includes(c), c);
});

test('a full 12 player game plays every round to the results with fair roles, scores and limits', async () => {
  const r = await startOdd(12, { rounds: 3, laps: 2 });
  const random = seeded(5);
  const fakers = [];
  for (let round = 1; round <= 3; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'intro');
    assert.equal(s.r, round);
    assert.equal(s.order.length, 12);
    const o = secretOdd(s);
    fakers.push(o);
    const roles = r.engines.map((e) => odd.model(e.snapshot()).role);
    assert.equal(roles.filter((x) => x === 'odd').length, 1);
    assert.equal(roles.filter((x) => x === 'crew').length, 11);
    await r.clock.advance(INTRO_MS + 100);
    s = await drawAll(r, random);
    assert.equal(s.phase, 'vote');
    assert.equal(s.marks.filter((x) => x >= 0).length, 24);
    const before = hostOf(r).snapshot().scores.g;
    const crew = s.order.filter((x) => x !== o);
    const catchIt = round !== 2;
    for (const c of crew) bySlot(r, c).act({ type: 'vote', target: catchIt ? o : crew.find((x) => x !== c), r: s.r });
    bySlot(r, o).act({ type: 'vote', target: crew[0], r: s.r });
    await r.clock.advance(600);
    s = st(r);
    if (catchIt) {
      assert.equal(s.phase, 'guess');
      const wrong = s.opts.findIndex((code) => unmask(code, wordKey(s.k)) !== secretWord(s).id);
      bySlot(r, o).act({ type: 'guess', i: wrong, r: s.r });
      await r.clock.advance(400);
      s = st(r);
      assert.equal(s.phase, 'reveal');
      assert.equal(s.stole, false);
      const after = hostOf(r).snapshot().scores.g;
      for (const c of crew) assert.equal((after[c] || 0) - (before[c] || 0), (VOTE_POINTS + CREW_BONUS) * (round === 3 ? 2 : 1));
      assert.equal((after[o] || 0) - (before[o] || 0), 0);
    } else {
      assert.equal(s.phase, 'reveal');
      assert.equal(s.caught, false);
      const after = hostOf(r).snapshot().scores.g;
      assert.equal((after[o] || 0) - (before[o] || 0), ESCAPE_POINTS * (round === 3 ? 2 : 1));
    }
    checkLimits(r);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(new Set(fakers).size, 3, 'a different faker every round');
  assert.equal(hostOf(r).snapshot().room.phase, 'results');
});

test('strokes without a turn number are ignored, and a caught faker keeps their guess if a crew member leaves', async () => {
  const r = await startWithCrewHost(3, { rounds: 1, laps: 1 });
  const random = seeded(9);
  await r.clock.advance(INTRO_MS + 100);
  let s = st(r);
  bySlot(r, s.turn).act({ type: 'stroke', s: fitStroke(squiggle(20, random), 1, 1, s.cap) });
  await r.clock.advance(400);
  assert.equal(st(r).n, s.n, 'a stroke with no turn number does nothing');
  s = await drawAll(r, random);
  const o = secretOdd(s);
  const crew = s.order.filter((x) => x !== o);
  for (const c of crew) bySlot(r, c).act({ type: 'vote', target: o, r: s.r });
  bySlot(r, o).act({ type: 'vote', target: crew[0], r: s.r });
  await r.clock.advance(500);
  assert.equal(st(r).phase, 'guess');
  const host = hostOf(r).snapshot().meSlot;
  const gone = bySlot(r, crew.find((x) => x !== host));
  r.hub.leave(gone.snapshot().me);
  gone.destroy();
  await r.clock.advance(800);
  s = st(r);
  assert.equal(s.phase, 'guess');
  const right = s.opts.findIndex((code) => unmask(code, wordKey(s.k)) === secretWord(s).id);
  bySlot(r, o).act({ type: 'guess', i: right, r: s.r });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.stole, true);
  assert.equal(s.note, null);
});

test('a line longer than the point limit is thinned along its whole length, never cut short', () => {
  const random = seeded(12);
  const pts = squiggle(6000, random, 240, 180, 30);
  const small = compact(pts);
  assert.ok(small.length <= STROKE_POINTS, `${small.length} points`);
  assert.deepEqual(small[0], pts[0]);
  assert.deepEqual(small[small.length - 1], pts[pts.length - 1]);
  for (const cap of [CAP_MIN, CAP_MAX]) {
    const joined = joinParts(fitStroke(pts, 3, 1, cap));
    assert.ok(joined, String(cap));
    assert.deepEqual(joined[0], pts[0], 'starts where the finger started');
    assert.deepEqual(joined[joined.length - 1], pts[pts.length - 1], 'ends where the finger lifted');
  }
});

test('each turn gets a fair share of what is left, and a full canvas re-simplifies old lines instead of losing a new one', () => {
  const st = { order: [1, 2, 3], laps: 2, marks: [], cap: strokeCap(6) };
  assert.ok(capFor(st, 0) >= strokeCap(6));
  assert.ok(capFor(st, 0) <= CAP_MAX);
  assert.equal(capFor({ ...st, marks: [1, 2, 3, 1, 2] }, INK_MAX - 100), Math.max(CAP_MIN, st.cap));
  const random = seeded(21);
  const raw = [];
  while (raw.join('').length < INK_MAX * 0.97) raw.push(...fitStroke(squiggle(1500, random, 40 + random() * 400, 40 + random() * 280, 30), 1 + (raw.length % 9), 1, 1400));
  const extra = fitStroke(squiggle(1500, random, 200, 200, 30), 2, 1, 1400);
  const chunks = squeeze(raw, extra, 9);
  assert.ok(chunks, 'room was made');
  assert.ok(chunks.length <= MAX_CHUNKS && inkBytes(chunks) <= INK_MAX);
  const all = chunks.flatMap((c) => c.s);
  assert.equal(all.length, raw.length + extra.length, 'every line keeps its place, so authors still line up');
  assert.deepEqual(all.slice(-extra.length), extra, 'the new line lands whole');
});
