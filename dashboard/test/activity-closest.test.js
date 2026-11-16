import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import closest, { KEY, REVEAL_MS, NEAR_POINTS, CLOSEST_POINTS, EXACT_POINTS, parseGuess, closeness, isExact, scoreGuesses, buildDeck, showNumber, withUnit, hintRange, numberLine } from '../web/activity/js/games/closest.js';
import { createClosestView, footText, previewText, closestMoment } from '../web/activity/js/views/closest.js';
import { QUESTIONS, CATS, YEAR, questionById } from '../web/activity/data/closest.js';
import { unmask } from '../web/activity/js/games/draw.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { VIEWS } from '../web/activity/js/views/index.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function questionOf(r) {
  const s = st(r);
  return questionById(unmask(s.deck[s.i], s.k));
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [closest] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('closest'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
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

test('there are at least 200 questions with answers, units and fun facts across every category', () => {
  assert.ok(QUESTIONS.length >= 200, `${QUESTIONS.length} questions`);
  assert.equal(new Set(QUESTIONS.map((q) => q.q)).size, QUESTIONS.length);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length);
  for (const c of CATS) assert.ok(QUESTIONS.filter((q) => q.cat === c.id).length >= 18, c.id);
  for (const q of QUESTIONS) {
    assert.ok(Number.isFinite(q.a), q.q);
    assert.equal(typeof q.unit, 'string', q.q);
    assert.ok(q.fact.length >= 10 && q.fact.length <= 120, q.q);
    assert.ok(q.q.length <= 110 && q.q.endsWith('?'), q.q);
    assert.ok(q.a > 0 || Number.isFinite(q.span), `${q.q} needs a span for a zero or negative answer`);
    if (q.unit === YEAR) assert.ok(Number.isInteger(q.a) && q.a > 0 && q.a <= 2030 && q.span > 0, q.q);
    for (const re of BANNED) assert.doesNotMatch(`${q.q} ${q.fact}`, re);
  }
});

test('the game is a quiz with short defaults and is registered with a view', () => {
  assert.equal(closest.category, 'quiz');
  assert.equal(closest.emoji, '🎯');
  assert.equal(closest.settings.find((s) => s.id === 'rounds').default, 8);
  assert.equal(closest.settings.find((s) => s.id === 'timer').default, 15);
  assert.ok(GAMES.includes(closest));
  assert.equal(typeof VIEWS.closest, 'function');
  assert.deepEqual(closest.cards, ['swap', 'double', 'peek']);
  for (const fn of ['awards', 'highlights', 'hint', 'join', 'roster', 'admin']) assert.equal(typeof closest[fn], 'function', fn);
  for (const re of BANNED) assert.doesNotMatch(`${closest.name} ${closest.blurb}`, re);
});

test('guesses are parsed forgivingly', () => {
  assert.equal(parseGuess('230'), 230);
  assert.equal(parseGuess(' 1,200 '), 1200);
  assert.equal(parseGuess('1.5k'), 1500);
  assert.equal(parseGuess('2 million'), 2000000);
  assert.equal(parseGuess('3bn'), 3000000000);
  assert.equal(parseGuess('-40'), -40);
  assert.equal(parseGuess('9.58'), 9.58);
  assert.equal(parseGuess('lots'), null);
  assert.equal(parseGuess('5 bananas'), null);
  assert.equal(parseGuess(''), null);
  assert.equal(parseGuess('1e99'), null);
  assert.equal(parseGuess(Infinity), null);
});

test('closer guesses score more, the closest gets a bonus and exact gets another', () => {
  const q = { a: 230, unit: 'bones' };
  assert.equal(closeness(q, 230), 1);
  assert.ok(closeness(q, 200) > closeness(q, 150));
  assert.ok(closeness(q, 260) > closeness(q, 400));
  assert.equal(closeness(q, 230 * 5), 0);
  assert.equal(closeness(q, -3), 0);
  assert.equal(isExact(q, 230), true);
  assert.equal(isExact(q, 229), false);
  assert.equal(isExact({ a: 384400 }, 384000), true);
  const s = scoreGuesses(q, { 0: 230, 1: 200, 2: 9000 });
  assert.equal(s[0].pts, NEAR_POINTS + CLOSEST_POINTS + EXACT_POINTS);
  assert.equal(s[0].top, true);
  assert.ok(s[1].pts > 0 && s[1].pts < NEAR_POINTS);
  assert.equal(s[2].pts, 0);
  const tie = scoreGuesses(q, { 0: 220, 1: 220 });
  assert.equal(tie[0].top && tie[1].top, true);
  const year = { a: 1969, unit: YEAR, span: 50 };
  assert.ok(closeness(year, 1965) > 0.9);
  assert.equal(closeness(year, 1900), 0);
  assert.equal(isExact(year, 1968), false);
  const cold = { a: -273.15, unit: '°C', span: 100 };
  assert.ok(closeness(cold, -270) > 0.9);
});

test('helpers: decks, numbers, hints and the number line', () => {
  const deck = buildDeck(10, 'space', () => 0.4);
  assert.equal(deck.length, 10);
  assert.ok(deck.every((id) => questionById(id).cat === 'space'));
  assert.equal(buildDeck(8, 'mix', Math.random).length, 8);
  assert.equal(showNumber(1969, { unit: YEAR }), '1969');
  assert.equal(showNumber(1500000, { unit: 'km' }), '1,500,000');
  assert.equal(withUnit(78, { unit: '%' }), '78%');
  assert.equal(withUnit(206, { unit: 'bones' }), '206 bones');
  for (const q of QUESTIONS) {
    const [lo, hi] = hintRange(q, () => 0.5);
    assert.ok(lo <= q.a && hi >= q.a, q.q);
  }
  const line = numberLine([{ id: 'a', name: 'A', isMe: false, guess: 10, top: false }, { id: 'b', name: 'B', isMe: true, guess: 1000, top: true }], 100, { unit: 'x' });
  assert.equal(line.marks[0].at, 0);
  assert.equal(line.marks[1].at, 100);
  assert.equal(line.answer, 50);
});

test('a round hides the answer until everyone guesses, then reveals and scores the closest', async () => {
  const r = await startGame(3, { rounds: 5, timer: 20 });
  const s = st(r);
  assert.equal(s.phase, 'guess');
  assert.equal(s.a, null);
  assert.equal(s.f, null);
  assert.equal(s.g, null);
  const q = questionOf(r);
  assert.equal(s.q, q.q);
  const shared = JSON.stringify(r.hub.state);
  assert.equal(shared.includes(q.fact), false, 'the fact stays secret');
  const [a, b, c] = r.engines.map((e) => e.snapshot().meSlot);
  bySlot(r, a).act({ type: 'guess', n: s.n, v: q.a });
  await r.clock.advance(300);
  assert.equal(JSON.stringify(r.hub.state[KEY]).includes(`"g":{`), false);
  assert.equal(st(r).answered.length, 1);
  bySlot(r, a).act({ type: 'guess', n: s.n, v: 1 });
  const far = q.span ? q.a + q.span * 3 : q.a * 50;
  bySlot(r, b).act({ type: 'guess', n: s.n, v: far });
  bySlot(r, c).act({ type: 'guess', n: s.n, v: 'not a number' });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'guess');
  bySlot(r, c).act({ type: 'guess', n: s.n, v: q.span ? q.a + 1 : q.a * 1.2 });
  await r.clock.advance(400);
  const after = st(r);
  assert.equal(after.phase, 'reveal');
  assert.equal(after.a, q.a);
  assert.equal(after.f, q.fact);
  assert.equal(after.g[a], q.a, 'the first guess is locked');
  assert.equal(after.sc[a].x, 1);
  assert.equal(after.sc[a].t, 1);
  assert.equal(after.sc[b].p, 0);
  assert.ok(after.sc[c].p > 0 && after.sc[c].p < after.sc[a].p);
  const m = closest.model(bySlot(r, a).snapshot());
  assert.equal(m.myExact, true);
  assert.equal(m.rows[0].slot, a);
  assert.ok(m.answer);
  assert.ok(r.hub.state.fun && r.hub.state.fun.l, 'commentary fires');
  await r.clock.advance(REVEAL_MS + 300);
  assert.equal(st(r).phase, 'guess');
  assert.equal(st(r).i, 1);
  assert.deepEqual(r.hub.violations, []);
});

test('a wild guess gets roasted and becomes the wildest guess award', async () => {
  const r = await startGame(2, { rounds: 5 });
  const s = st(r);
  const q = questionOf(r);
  const [a, b] = r.engines.map((e) => e.snapshot().meSlot);
  const far = q.span ? q.a + q.span * 5 : q.a * 1000;
  bySlot(r, a).act({ type: 'guess', n: s.n, v: far });
  bySlot(r, b).act({ type: 'guess', n: s.n, v: q.span ? q.a + 2 : q.a * 1.5 });
  await r.clock.advance(400);
  const line = r.hub.state.fun && r.hub.state.fun.l;
  assert.ok(line && /Player 1/.test(line.t || line.text || JSON.stringify(line)), JSON.stringify(line));
  for (let i = 0; i < 5; i += 1) await r.clock.advance(30000);
  assert.equal(r.hub.state.room.phase, 'results');
});

test('five questions play through to the results when nobody guesses', async () => {
  const r = await startGame(2, { rounds: 5, timer: 10 });
  for (let i = 0; i < 5; i += 1) {
    await r.clock.advance(10200);
    assert.equal(st(r).phase, 'reveal');
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(r.hub.state.room.phase, 'results');
});

test('late joiners play the current question when there is time, otherwise the next', async () => {
  const r = await startGame(2, { timer: 15 });
  r.add(3);
  await r.clock.advance(800);
  const slot3 = r.engines[2].snapshot().meSlot;
  if (slot3 !== null) assert.ok(st(r).in.includes(slot3) || st(r).wait.includes(slot3));
  r.engines[2].act({ type: 'guess', n: st(r).n, v: 5 });
  await r.clock.advance(300);
  const now = r.engines[2].snapshot().meSlot;
  assert.ok(st(r).in.includes(now));
  assert.ok(st(r).answered.includes(now));
});

test('the host leaving mid-question asks the same question again', async () => {
  const r = await startGame(3);
  const s = st(r);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'guess');
  assert.equal(after.i, s.i);
  assert.equal(after.note, 'host');
  assert.ok(after.n > s.n);
});

test('peek gives a range that contains the answer', async () => {
  const r = await startGame(2);
  const slot = r.engines[1].snapshot().meSlot;
  const api = { get: () => st(r), memory: { cur: { n: st(r).n, picks: {} } }, random: () => 0.3 };
  const hint = closest.hint(api, slot);
  assert.match(hint, /^It's between .+ and .+\.$/);
});

test('footer text, preview and moments', () => {
  assert.match(footText({ phase: 'guess', answered: 1, players: 3, waiting: false, watching: false, myGuess: null }), /best guess/);
  assert.match(footText({ phase: 'guess', answered: 1, players: 3, waiting: false, watching: false, myGuess: 5, myText: '5' }), /Locked in at 5/);
  assert.match(footText({ phase: 'reveal', myExact: true, myGain: 1100, myGuess: 3 }), /Spot on/);
  assert.equal(previewText('1.5k', false), '= 1,500');
  assert.equal(previewText('1500', false), '');
  assert.match(previewText('lots', false), /Type a number/);
  const was = closestMoment(null, { n: 1, phase: 'guess', myGuess: 3 }).now;
  assert.equal(closestMoment(was, { n: 1, phase: 'reveal', myGuess: 3, myTop: true }).cue, 'correct');
  assert.equal(closestMoment(was, { n: 1, phase: 'reveal', myGuess: null }).cue, null);
});

test('the view takes a typed guess, then reveals rows with profile faces and a number line', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { timer: 20 });
  const engine = r.engines[0];
  const view = createClosestView({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} } });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  const input = all(view.el).find((n) => n.dataset && n.dataset.key === 'closest-input');
  const send = all(view.el).find((n) => n.dataset && n.dataset.key === 'closest-send');
  assert.ok(input && send);
  input.value = '42';
  send.click();
  await r.clock.advance(300);
  assert.ok(st(r).answered.includes(engine.snapshot().meSlot));
  r.engines[1].act({ type: 'guess', n: st(r).n, v: 7 });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'reveal');
  view.update(engine.snapshot());
  const rows = all(view.el).filter((n) => n.classList && n.classList.contains('closest-row'));
  assert.equal(rows.length, 2);
  assert.ok(all(view.el).some((n) => n.getAttribute && n.getAttribute('data-profile-id')), 'rows carry profile faces');
  assert.equal(all(view.el).filter((n) => n.classList && n.classList.contains('closest-mark')).length, 2);
  for (const n of all(view.el)) assert.equal(n.hasAttribute && n.hasAttribute('style') && !/^--/.test(n.getAttribute('style') || '--'), false);
  view.destroy();
});

test('the closest files stay free of comments and inline styles', () => {
  for (const f of ['../web/activity/js/games/closest.js', '../web/activity/js/views/closest.js', '../web/activity/data/closest.js', '../web/activity/css/closest.css']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText']) assert.equal(src.includes(bad), false, `${f} ${bad}`);
  }
  const css = readFileSync(new URL('../web/activity/css/closest.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-fx="static"\]/);
});
