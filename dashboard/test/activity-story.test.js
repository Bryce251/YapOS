import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import story, { KEY, LINE_PREFIX, LINE_MAX, MAX_LINES, LINE_POINTS, VOTE_POINTS, TOP_BONUS, VOTE_MS, lineKey, lineRef, fitLine, turnsFor, tally, revealMs } from '../web/activity/js/games/story.js';
import { createStoryView, footText, storyMoment } from '../web/activity/js/views/story.js';
import { STARTERS, starterById } from '../web/activity/data/story.js';
import { isBlockedWord } from '../web/activity/js/filter.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [story] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('story'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function lines(r) {
  const s = st(r);
  const out = [];
  for (let i = 0; i < s.lines; i += 1) out.push(r.hub.state[lineKey(i)]);
  return out;
}

async function write(r, text) {
  const s = st(r);
  bySlot(r, s.writer).act({ type: 'line', t: s.turn, text });
  await r.clock.advance(1500);
}

test('there are about 60 original, family-friendly openers', () => {
  assert.ok(STARTERS.length >= 55, `${STARTERS.length} openers`);
  assert.equal(new Set(STARTERS.map((s) => s.text)).size, STARTERS.length);
  for (const s of STARTERS) {
    assert.ok(s.text.length <= 120, s.text);
    assert.equal(starterById(s.id), s);
    for (const re of BANNED) assert.doesNotMatch(s.text, re);
    for (const word of s.text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) assert.equal(isBlockedWord(word), false, word);
  }
});

test('the game is a party game for 2 or more with laps and a timer', () => {
  assert.equal(story.id, 'story');
  assert.equal(story.category, 'party');
  assert.equal(story.emoji, '📖');
  assert.equal(story.minPlayers, 2);
  assert.deepEqual(story.settings.find((s) => s.id === 'laps').options.map((o) => o.value), [2, 3]);
  assert.deepEqual(story.settings.find((s) => s.id === 'timer').options.map((o) => o.value), [20, 30, 45, 60]);
  assert.equal(story.settings.find((s) => s.id === 'timer').default, 30);
  for (const re of BANNED) assert.doesNotMatch(`${story.name} ${story.blurb}`, re);
});

test('helpers clip and clean lines, cap turns and tally votes', () => {
  assert.equal(Array.from(fitLine('x'.repeat(300))).length, LINE_MAX);
  assert.equal(fitLine('  hi   there  '), 'hi there');
  assert.equal(fitLine('see https://example.com now'), 'see 🔗 now');
  assert.equal(turnsFor(3, 2), 6);
  assert.equal(turnsFor(20, 3), MAX_LINES);
  assert.ok(revealMs(100) <= 20000);
  const t = tally({ 0: 1, 1: 2, 2: 1 }, { 1: 1, 3: 1, 2: 0 });
  assert.deepEqual(t.top, [1]);
  assert.equal(t.gained[2], 2 * VOTE_POINTS + TOP_BONUS);
  assert.equal(t.gained[1], VOTE_POINTS);
  assert.equal(lineRef(9, 3), 'story.9.3');
});

test('players take turns, the writer adds a line, then everyone votes and the best line wins', async () => {
  const r = await startGame(3, { laps: 2 });
  let s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.turns, 6);
  assert.ok(starterById(s.start));
  const order = s.order.slice();
  for (let t = 0; t < 6; t += 1) {
    s = st(r);
    assert.equal(s.writer, order[t % 3], `turn ${t}`);
    const other = order[(t + 1) % 3];
    bySlot(r, other).act({ type: 'line', t: s.turn, text: 'not my turn' });
    await r.clock.advance(300);
    assert.equal(st(r).lines, t, 'only the writer can add');
    await write(r, `Line ${t} by ${s.writer}.`);
  }
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(lines(r).length, 6);
  const [a, b, c] = order;
  assert.equal(r.engines[0].snapshot().scores.g[a], 2 * LINE_POINTS, 'line points land as each line is written');
  assert.equal(r.engines[0].snapshot().fun.final, true, 'the vote is the final round');
  bySlot(r, a).act({ type: 'vote', i: 0 });
  await r.clock.advance(300);
  assert.equal(st(r).voted.length, 0, 'you cannot vote for your own line');
  bySlot(r, a).act({ type: 'vote', i: 1 });
  bySlot(r, b).act({ type: 'vote', i: 2 });
  bySlot(r, c).act({ type: 'vote', i: 1 });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.top, [1]);
  assert.equal(s.gained[b], 2 * (2 * VOTE_POINTS + TOP_BONUS), 'votes count double in the final round');
  assert.equal(s.gained[c], 2 * VOTE_POINTS);
  const scores = r.engines[0].snapshot().scores.g;
  assert.equal(scores[a], 2 * LINE_POINTS);
  assert.equal(scores[b], 2 * LINE_POINTS + 2 * (2 * VOTE_POINTS + TOP_BONUS));
  assert.deepEqual(story.results({ memory: { top: [b] } }), { extra: { topLine: [b] } });
  await r.clock.advance(revealMs(6) + 500);
  assert.equal(r.hub.state.room.phase, 'results');
  assert.equal(Object.keys(r.hub.state).filter((k) => k.startsWith(LINE_PREFIX) && r.hub.state[k]).length, 0);
});

test('a missed turn or a pass skips ahead, and lines are filtered', async () => {
  const r = await startGame(2, { timer: 30 });
  const s0 = st(r);
  bySlot(r, s0.writer).act({ type: 'pass', t: s0.turn });
  await r.clock.advance(300);
  assert.equal(st(r).turn, 1);
  assert.equal(st(r).lines, 0);
  await r.clock.advance(31000);
  assert.equal(st(r).turn, 2);
  await write(r, 'A link www.example.com/x and a plain ending.');
  assert.match(lines(r)[0][1], /🔗/);
  const ref = lineRef(st(r).run, 0);
  const listed = story.texts({ get: (k) => r.hub.state[k] });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].r, ref);
  assert.match(listed[0].context, /Story Builder/);
});

test('a writer who leaves is skipped and a newcomer gets turns later', async () => {
  const r = await startGame(3);
  const s = st(r);
  const writer = s.writer;
  r.hub.leave(bySlot(r, writer).snapshot().me);
  await r.clock.advance(800);
  assert.notEqual(st(r).writer, writer);
  const late = r.add(4);
  await r.clock.advance(800);
  assert.ok(st(r).order.includes(late.snapshot().meSlot));
});

test('the host leaving mid-vote restarts the vote and keeps the story', async () => {
  const r = await startGame(3, { laps: 2 });
  for (let t = 0; t < 6; t += 1) await write(r, `Line ${t}.`);
  assert.equal(st(r).phase, 'vote');
  const before = lines(r).length;
  const host = r.engines[0];
  const voter = r.engines[1];
  voter.act({ type: 'vote', i: lines(r).findIndex((l) => l[0] !== voter.snapshot().meSlot) });
  await r.clock.advance(300);
  r.hub.leave(host.snapshot().me);
  await r.clock.advance(2000);
  const s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.note, 'host');
  assert.equal(s.voted.length, 0);
  assert.equal(lines(r).length, before);
  await r.clock.advance(VOTE_MS + 500);
  assert.equal(st(r).phase, 'reveal');
});

test('a long story stays inside every value limit', async () => {
  const r = await startGame(8, { laps: 3 });
  assert.equal(st(r).turns, MAX_LINES);
  for (let t = 0; t < MAX_LINES; t += 1) await write(r, `${'🌟'.repeat(10)} ${'w'.repeat(100)}`);
  assert.equal(st(r).phase, 'vote');
  for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
  assert.ok(jsonBytes(st(r)) < 1500);
});

test('footer text and moments follow the phases', () => {
  const base = { run: 1, phase: 'write', turn: 0, lines: [], myTurn: false, writer: { name: 'Sam' }, upcoming: [], sent: false };
  assert.match(footText(base), /Sam is writing/);
  assert.match(footText({ ...base, myTurn: true }), /Your turn/);
  assert.match(footText({ ...base, phase: 'vote', voted: 1, onlyMine: false, hasVoted: false }), /favorite/);
  const was = storyMoment(null, base).now;
  assert.deepEqual(storyMoment(was, { ...base, myTurn: true }).cues, ['turn']);
  assert.deepEqual(storyMoment(was, { ...base, phase: 'vote' }).cues, ['whoosh']);
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

test('the view lets the writer type a line and others vote on it', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { laps: 2 });
  const views = r.engines.map((engine) => {
    const v = createStoryView({ engine, fx: { confetti() {} }, toast() {}, win: {}, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    v.update(engine.snapshot());
    return v;
  });
  const s = st(r);
  const wi = r.engines.findIndex((e) => e.snapshot().meSlot === s.writer);
  const el = views[wi].el;
  const input = byKey(el, 'story-input');
  assert.equal(input.disabled, false);
  assert.equal(byKey(views[1 - wi].el, 'story-input').disabled, true);
  input.value = 'The goat started to dance.';
  byKey(el, 'story-send').click();
  await r.clock.advance(400);
  assert.equal(st(r).lines, 1);
  assert.match(views[1 - wi].el.textContent, /The goat started to dance\./);
  profileFaces(views[1 - wi].el, 2);
  for (const v of views) for (const n of all(v.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  for (const v of views) v.destroy();
});
