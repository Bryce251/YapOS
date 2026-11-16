import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import name5, { KEY, ANS, VOTES, SLOTS, RUSH_MS, GRACE_MS, REVEAL_MS, UNIQUE_POINTS, SHARED_POINTS, LONE_VETO_MAX, OK, BLANK, LETTER, HIDDEN, normAnswer, startsWith, judge, dealLetter, dealCats, needed, scoreRound } from '../web/activity/js/games/name5.js';
import { createName5View, footText, codeNote, n5Moment } from '../web/activity/js/views/name5.js';
import { CATEGORIES, EASY_LETTERS, HARD_LETTERS } from '../web/activity/data/name5.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { VIEWS } from '../web/activity/js/views/index.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const RUDE = decodeTerm('jybd');

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [name5] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('namefive'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function words(letter, list) {
  return list.map((w) => (w ? `${letter}${w}` : ''));
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

test('there are 80+ distinct categories and sensible letters', () => {
  assert.ok(CATEGORIES.length >= 80, `${CATEGORIES.length}`);
  assert.equal(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length);
  assert.equal(new Set(CATEGORIES.map((c) => c.name)).size, CATEGORIES.length);
  for (const c of CATEGORIES) {
    assert.match(c.id, /^[a-z0-9-]+$/);
    assert.ok(c.name.length <= 40, c.name);
    for (const re of BANNED) assert.doesNotMatch(c.name, re);
  }
  for (const l of ['Q', 'X', 'Z', 'Y']) {
    assert.equal(EASY_LETTERS.includes(l), false, l);
    assert.ok(HARD_LETTERS.includes(l), l);
  }
});

test('the game is a words game with short defaults and is registered with a view', () => {
  assert.equal(name5.id, 'namefive');
  assert.equal(name5.category, 'words');
  assert.equal(name5.emoji, '🖐️');
  assert.equal(name5.settings.find((s) => s.id === 'rounds').default, 3);
  assert.equal(name5.settings.find((s) => s.id === 'timer').default, 60);
  assert.equal(name5.settings.find((s) => s.id === 'hard').default, false);
  assert.ok(GAMES.includes(name5));
  assert.equal(typeof VIEWS.namefive, 'function');
  assert.equal(name5.cards.includes('freeze'), false);
  for (const re of BANNED) assert.doesNotMatch(`${name5.name} ${name5.blurb}`, re);
});

test('answers are matched ignoring case, spaces, articles and plurals', () => {
  assert.equal(normAnswer('Apples'), normAnswer('apple'));
  assert.equal(normAnswer(' The  Beatles '), normAnswer('beatle'));
  assert.equal(normAnswer('Cherries'), normAnswer('cherry'));
  assert.equal(normAnswer('Boxes'), normAnswer('box'));
  assert.equal(normAnswer('Ice Cream'), normAnswer('icecream'));
  assert.notEqual(normAnswer('Glass'), normAnswer('Glas'));
  assert.equal(startsWith('The Beatles', 'B'), true);
  assert.equal(startsWith('apple', 'A'), true);
  assert.equal(startsWith('banana', 'A'), false);
});

test('answers are judged for the letter and run through the word filter', () => {
  assert.deepEqual(judge('Apple', 'A'), { a: 'Apple', k: OK });
  assert.deepEqual(judge('Banana', 'A'), { a: 'Banana', k: LETTER });
  assert.deepEqual(judge('   ', 'A'), { a: '', k: BLANK });
  assert.deepEqual(judge(null, 'A'), { a: '', k: BLANK });
  const bad = judge(`${RUDE}`, RUDE[0].toUpperCase());
  assert.equal(bad.k, HIDDEN);
  assert.equal(bad.a, '');
  assert.equal(judge('x'.repeat(80), 'X').a.length <= 30, true);
});

test('letters skip hard ones unless asked, avoid repeats, and categories do not repeat', () => {
  for (let i = 0; i < 50; i += 1) assert.ok(EASY_LETTERS.includes(dealLetter('', false, Math.random)));
  assert.notEqual(dealLetter('A', false, () => 0), 'A');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(dealLetter('', true, Math.random));
  assert.ok([...seen].some((l) => HARD_LETTERS.includes(l)));
  const cats = dealCats([], () => 0.3);
  assert.equal(cats.length, SLOTS);
  assert.equal(new Set(cats.map((c) => c.id)).size, SLOTS);
  const again = dealCats(cats.map((c) => c.id), () => 0.3);
  assert.equal(again.some((c) => cats.some((x) => x.id === c.id)), false);
});

test('scoring: unique answers 10, shared 5, vetoed and invalid 0', () => {
  assert.equal(needed(1), 1);
  assert.equal(needed(2), 2);
  assert.equal(needed(3), 2);
  const sheets = {
    0: { a: ['Apple', 'Ant', 'Austria', '', 'Banana'], k: [OK, OK, OK, BLANK, LETTER] },
    1: { a: ['apples', 'Aardvark', 'Angola', 'Axe', ''], k: [OK, OK, OK, OK, BLANK] },
    2: { a: ['Avocado', 'ant', 'Austria', 'Anvil', ''], k: [OK, OK, OK, OK, BLANK] },
  };
  const out = scoreRound(sheets, { '1.3': [0, 2] }, { 0: 2, 1: 2, 2: 2 });
  assert.deepEqual(out[0].p, [SHARED_POINTS, SHARED_POINTS, SHARED_POINTS, 0, 0]);
  assert.deepEqual(out[1].p, [SHARED_POINTS, UNIQUE_POINTS, UNIQUE_POINTS, 0, 0]);
  assert.deepEqual(out[1].x, [0, 0, 0, 1, 0]);
  assert.deepEqual(out[2].p, [UNIQUE_POINTS, SHARED_POINTS, SHARED_POINTS, UNIQUE_POINTS, 0]);
  const one = scoreRound(sheets, { '1.3': [0] }, { 0: 2, 1: 2, 2: 2 });
  assert.equal(one[1].p[3], UNIQUE_POINTS, 'one vote of two is not a majority');
});

test('answers stay private while writing, then the review shows them and a majority veto removes one', async () => {
  const r = await startGame(3, { rounds: 2, timer: 60, review: 25 });
  const s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.cats.length, SLOTS);
  assert.ok(EASY_LETTERS.includes(s.l));
  const L = s.l;
  const [a, b, c] = r.engines.map((e) => e.snapshot().meSlot);
  bySlot(r, a).act({ type: 'save', n: s.n, a: words(L, ['ardvark', 'oo', 'ip', 'ex', 'ail']), done: false });
  await r.clock.advance(300);
  assert.equal(JSON.stringify(r.hub.state).includes(`${L}ardvark`), false, 'drafts are not shared');
  bySlot(r, a).act({ type: 'save', n: s.n, a: words(L, ['ardvark', 'oo', 'ip', 'ex', 'ail']), done: true });
  bySlot(r, b).act({ type: 'save', n: s.n, a: words(L, ['ardvarks', 'umble', '', 'ex', '']).concat([]), done: true });
  bySlot(r, c).act({ type: 'save', n: s.n, a: ['Wrongletter', `${L}izzle`, `${RUDE}`, '', ''], done: true });
  await r.clock.advance(400);
  let now = st(r);
  assert.equal(now.phase, 'review');
  const sheetC = r.hub.state[`${ANS}${c}`];
  assert.equal(JSON.stringify(sheetC).includes(RUDE), false, 'filtered words never reach shared state');
  assert.equal(sheetC.k[0], L === 'W' ? OK : LETTER);
  assert.equal(sheetC.k[2], L === RUDE[0].toUpperCase() ? HIDDEN : sheetC.k[2]);
  bySlot(r, b).act({ type: 'veto', n: now.n, s: a, c: 4, on: true });
  bySlot(r, c).act({ type: 'veto', n: now.n, s: a, c: 4, on: true });
  bySlot(r, a).act({ type: 'veto', n: now.n, s: a, c: 4, on: true });
  bySlot(r, a).act({ type: 'veto', n: now.n, s: b, c: 3, on: true });
  bySlot(r, a).act({ type: 'veto', n: now.n, s: b, c: 3, on: false });
  await r.clock.advance(300);
  const votes = r.hub.state[VOTES].v;
  assert.deepEqual(votes[`${a}.4`].sort(), [b, c].sort());
  assert.equal(votes[`${b}.3`], undefined);
  const m = name5.model(bySlot(r, b).snapshot());
  assert.equal(m.phase, 'review');
  const row = m.grid[4].rows.find((x) => x.slot === a);
  assert.equal(row.iVoted, true);
  assert.equal(row.votes, 2);
  assert.equal(m.grid[0].rows.find((x) => x.slot === a).shared, true);
  for (const e of r.engines) e.act({ type: 'ok', n: now.n });
  await r.clock.advance(400);
  now = st(r);
  assert.equal(now.phase, 'reveal');
  const sa = r.hub.state[`${ANS}${a}`];
  assert.deepEqual(sa.p, [SHARED_POINTS, UNIQUE_POINTS, UNIQUE_POINTS, SHARED_POINTS, 0]);
  assert.equal(sa.x[4], 1);
  assert.equal(now.gained[a], UNIQUE_POINTS * 2 + SHARED_POINTS * 2);
  const mm = name5.model(bySlot(r, a).snapshot());
  assert.equal(mm.myTotal, UNIQUE_POINTS * 2 + SHARED_POINTS * 2);
  await r.clock.advance(REVEAL_MS + 300);
  assert.equal(st(r).phase, 'write');
  assert.notEqual(st(r).l, L);
  assert.deepEqual(r.hub.violations, []);
});

test('in a two player game one person can only vote out a couple of answers each round', async () => {
  const r = await startGame(2, { timer: 60, review: 25 });
  const s = st(r);
  const L = s.l;
  const [a, b] = r.engines.map((e) => e.snapshot().meSlot);
  bySlot(r, a).act({ type: 'save', n: s.n, a: words(L, ['one', 'two', 'three', 'four', 'five']), done: true });
  bySlot(r, b).act({ type: 'save', n: s.n, a: words(L, ['x', '', '', '', '']), done: true });
  await r.clock.advance(400);
  const now = st(r);
  assert.equal(now.phase, 'review');
  for (let c = 0; c < SLOTS; c += 1) bySlot(r, b).act({ type: 'veto', n: now.n, s: a, c, on: true });
  await r.clock.advance(300);
  const votes = r.hub.state[VOTES].v;
  assert.equal(Object.keys(votes).filter((k) => k.startsWith(`${a}.`)).length, LONE_VETO_MAX);
  const forged = {};
  for (let c = 0; c < SLOTS; c += 1) forged[`${a}.${c}`] = [b];
  const out = scoreRound({ [a]: r.hub.state[`${ANS}${a}`] }, forged, { [a]: 1 });
  assert.equal(out[a].x.filter(Boolean).length, LONE_VETO_MAX);
  for (const e of r.engines) e.act({ type: 'ok', n: now.n });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'reveal');
  assert.equal(r.hub.state[`${ANS}${a}`].x.filter(Boolean).length, LONE_VETO_MAX);
});

test('the first to fill all five starts a short countdown for everyone else', async () => {
  const r = await startGame(3, { timer: 60 });
  const s = st(r);
  const [a] = r.engines.map((e) => e.snapshot().meSlot);
  bySlot(r, a).act({ type: 'save', n: s.n, a: words(s.l, ['a', 'b', 'c', 'd', 'e']), done: true });
  await r.clock.advance(300);
  const now = st(r);
  assert.equal(now.rush, a);
  assert.ok(now.ends - r.clock.now() <= RUSH_MS);
  await r.clock.advance(RUSH_MS + GRACE_MS + 200);
  assert.notEqual(st(r).phase, 'write');
});

test('a whole game runs to the results when nobody writes anything', async () => {
  const r = await startGame(2, { rounds: 2, timer: 30 });
  for (let i = 0; i < 2; i += 1) {
    await r.clock.advance(30000 + GRACE_MS + 200);
    assert.equal(st(r).phase, 'reveal');
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(r.hub.state.room.phase, 'results');
});

test('late joiners write this round when there is time and the host hand-off asks for answers again', async () => {
  const r = await startGame(2, { timer: 60 });
  r.add(3);
  await r.clock.advance(800);
  const late = r.engines[2];
  late.act({ type: 'save', n: st(r).n, a: words(st(r).l, ['x', '', '', '', '']), done: false });
  await r.clock.advance(300);
  assert.ok(st(r).in.includes(late.snapshot().meSlot));
  const before = st(r);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.equal(after.phase, 'write');
  assert.equal(after.n, before.n);
  assert.equal(after.note, 'host');
  assert.equal(after.rq, (before.rq || 0) + 1);
});

test('footer text, notes and moments', () => {
  assert.match(footText({ phase: 'write', done: 0, players: 3, letter: 'B', waiting: false, watching: false, iDone: false }), /starting with B/);
  assert.match(footText({ phase: 'review', playing: true, iOk: false, okCount: 0, players: 3 }), /vote it out/);
  assert.match(footText({ phase: 'reveal', playing: true, myGain: 35 }), /\+35/);
  assert.equal(codeNote(LETTER), 'Wrong letter');
  assert.equal(codeNote(HIDDEN), 'Hidden');
  const was = n5Moment(null, { n: 1, phase: 'write' }).now;
  assert.equal(n5Moment(was, { n: 1, phase: 'review' }).cue, 'reveal');
});

test('the view has five inputs, autosaves, locks in and shows review chips with profile faces', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2, { timer: 60 });
  const engine = r.engines[0];
  const timers = [];
  const win = {
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
  };
  const view = createName5View({ engine, fx: { confetti() {} }, cues: { play() {}, burst() {}, float() {} }, win });
  engine.on('change', (snap) => view.update(snap));
  view.update(engine.snapshot());
  const inputs = all(view.el).filter((n) => n.dataset && /^n5-input-\d$/.test(n.dataset.key || ''));
  assert.equal(inputs.length, SLOTS);
  const L = st(r).l;
  inputs.forEach((input, i) => {
    input.value = `${L}${'abcde'[i]}word`;
    input.dispatchEvent(new FakeEvent('input'));
  });
  assert.ok(timers.length >= 1, 'a save is queued');
  all(view.el).find((n) => n.dataset && n.dataset.key === 'n5-lock').click();
  await r.clock.advance(300);
  assert.ok(st(r).done.includes(engine.snapshot().meSlot));
  r.engines[1].act({ type: 'save', n: st(r).n, a: words(L, ['aword', 'zzz', '', '', '']), done: true });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'review');
  view.update(engine.snapshot());
  const chips = all(view.el).filter((n) => n.classList && n.classList.contains('n5-chip'));
  assert.ok(chips.length >= 6);
  assert.ok(all(view.el).some((n) => n.getAttribute && n.getAttribute('data-profile-id')));
  const votable = all(view.el).find((n) => n.dataset && /^veto-/.test(n.dataset.key || ''));
  assert.ok(votable, 'the other player answers can be voted on');
  votable.click();
  await r.clock.advance(300);
  assert.equal(Object.keys(r.hub.state[VOTES].v).length, 1);
  view.destroy();
});

test('the Name 5 files stay free of comments and inline styles', () => {
  for (const f of ['../web/activity/js/games/name5.js', '../web/activity/js/views/name5.js', '../web/activity/data/name5.js', '../web/activity/css/name5.css']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/^\s*\/\/|\/\*/m.test(src), false, f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'cssText']) assert.equal(src.includes(bad), false, `${f} ${bad}`);
  }
  const css = readFileSync(new URL('../web/activity/css/name5.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-fx="static"\]/);
});
