import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded, person } from './activity-kit.test.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import { installDom } from './dom-shim.js';
import higherlower, { KEY, REVEAL_MS, BASE_POINTS, STREAK_STEP, STREAK_CAP, pointsFor, fairPair, buildDeck, higherSide, score } from '../web/activity/js/games/higherlower.js';
import { createHigherlowerView, footText, higherlowerMoment } from '../web/activity/js/views/higherlower.js';
import { ITEMS, KINDS, itemById, showValue } from '../web/activity/data/higherlower.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r) {
  return r.hub.state[KEY];
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

async function startGame(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [higherlower], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('higherlower'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function text(node) {
  if (node.data !== undefined && !node.localName) return node.data;
  return (node.childNodes || []).map(text).join(' ');
}

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

test('the items are plenty, unique, and every kind can make fair pairs', () => {
  assert.ok(ITEMS.length >= 200, `${ITEMS.length} items`);
  assert.equal(new Set(ITEMS.map((x) => x.id)).size, ITEMS.length);
  assert.equal(new Set(ITEMS.map((x) => `${x.kind}|${x.name}`)).size, ITEMS.length);
  for (const x of ITEMS) {
    assert.ok(KINDS[x.kind], x.name);
    assert.ok(Number.isFinite(x.value) && x.value > 0, x.name);
    assert.ok(x.name.length <= 60, x.name);
    assert.ok(x.emoji, x.name);
    for (const re of BANNED) assert.doesNotMatch(x.name, re);
    assert.ok(showValue(x).length > 0);
  }
  for (const kind of Object.keys(KINDS)) assert.ok(ITEMS.filter((x) => x.kind === kind).length >= 10, kind);
  assert.equal(itemById('nope'), null);
});

test('values show metric and US units where they matter', () => {
  const everest = ITEMS.find((x) => x.name === 'Mount Everest');
  assert.equal(showValue(everest), '8,849 m (29,032 ft)');
  const cheetah = ITEMS.find((x) => x.name === 'A cheetah at top speed');
  assert.match(showValue(cheetah), /^about 110 km\/h \(68 mph\)$/);
  const moon = ITEMS.find((x) => x.name === 'People first walk on the Moon');
  assert.equal(showValue(moon), '1969');
  assert.match(showValue(ITEMS.find((x) => x.kind === 'people' && x.name === 'India')), /billion people/);
  assert.match(showValue(ITEMS.find((x) => x.kind === 'area' && x.name === 'Russia')), /km² \(.* sq mi\)/);
  assert.match(showValue(ITEMS.find((x) => x.kind === 'weight' && x.name.includes('blue whale'))), /kg \(.* lb\)/);
});

test('fair pairs never tie and keep fuzzy numbers far apart', () => {
  const a = { id: 'x', kind: 'people', value: 130 };
  assert.equal(fairPair(a, { id: 'y', kind: 'people', value: 130 }), false);
  assert.equal(fairPair(a, { id: 'y', kind: 'people', value: 140 }), false);
  assert.equal(fairPair(a, { id: 'y', kind: 'people', value: 200 }), true);
  assert.equal(fairPair(a, { id: 'y', kind: 'height', value: 400 }), false);
  assert.equal(fairPair({ id: 'p', kind: 'year', value: 1991 }, { id: 'q', kind: 'year', value: 1992 }), true);
  assert.equal(fairPair({ id: 'p', kind: 'year', value: 1886 }, { id: 'q', kind: 'year', value: 1886 }), false);
  for (let seed = 1; seed < 30; seed += 1) {
    const deck = buildDeck(15, seeded(seed));
    assert.equal(deck.length, 15);
    const used = deck.flat();
    assert.equal(new Set(used).size, used.length, 'no item twice in a game');
    for (const [x, y] of deck) {
      assert.ok(fairPair(itemById(x), itemById(y)), `${x} ${y}`);
      assert.ok(['a', 'b'].includes(higherSide(x, y)));
    }
    assert.ok(new Set(deck.map(([x]) => itemById(x).kind)).size >= 5, 'mixes the kinds');
  }
});

test('streaks grow the points up to a cap and reset on a miss', () => {
  assert.equal(pointsFor(1), BASE_POINTS);
  assert.equal(pointsFor(2), BASE_POINTS + STREAK_STEP);
  assert.equal(pointsFor(50), BASE_POINTS + STREAK_STEP * STREAK_CAP);
  const s = score({ 0: 'a', 1: 'b' }, 'a', { 0: 2, 1: 4, 2: 3 }, [0, 1, 2]);
  assert.deepEqual(s.streaks, { 0: 3, 1: 0, 2: 0 });
  assert.deepEqual(s.gained, { 0: pointsFor(3) });
});

test('the game is a quick game with rounds and a 10 s default timer', () => {
  assert.equal(higherlower.id, 'higherlower');
  assert.equal(higherlower.category, 'quick');
  assert.equal(higherlower.emoji, '📈');
  assert.equal(higherlower.settings.find((s) => s.id === 'rounds').default, 10);
  assert.equal(higherlower.settings.find((s) => s.id === 'timer').default, 10);
  for (const re of BANNED) assert.doesNotMatch(`${higherlower.name} ${higherlower.blurb}`, re);
});

test('a full game: everyone picks at once, streaks score, the game finishes', async () => {
  const r = await startGame(3, { rounds: 5 });
  const slots = slotsOf(r);
  const totals = {};
  for (let round = 1; round <= 5; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'guess');
    assert.equal(s.vals, null, 'numbers stay hidden while guessing');
    assert.ok(jsonBytes(s) < MAX_VALUE_BYTES);
    const right = higherSide(s.a.id, s.b.id);
    const wrong = right === 'a' ? 'b' : 'a';
    bySlot(r, slots[0]).act({ type: 'pick', side: right, r: s.r });
    bySlot(r, slots[1]).act({ type: 'pick', side: round === 3 ? wrong : right, r: s.r });
    bySlot(r, slots[2]).act({ type: 'pick', side: wrong, r: s.r });
    bySlot(r, slots[2]).act({ type: 'pick', side: right, r: s.r });
    await r.clock.advance(400);
    s = st(r);
    assert.equal(s.phase, 'reveal', 'reveals once everyone picked');
    assert.equal(s.right, right);
    assert.ok(s.vals.a && s.vals.b);
    assert.equal(s.streaks[slots[0]], round);
    assert.equal(s.streaks[slots[2]], 0, 'the first pick counts');
    assert.equal(s.gained[slots[0]], pointsFor(round));
    for (const [slot, pts] of Object.entries(s.gained)) totals[slot] = (totals[slot] || 0) + pts;
    assert.deepEqual(r.engines[1].snapshot().scores.g, totals);
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.equal(st(r).best[slots[1]], 2);
  const roomState = r.engines[0].snapshot().room;
  assert.equal(roomState.phase, 'results');
  assert.deepEqual(roomState.last.winners, [slots[0]]);
  assert.deepEqual(r.hub.violations, []);
});

test('time running out resets the streak of anyone who did not pick', async () => {
  const r = await startGame(2, { rounds: 5, timer: 7 });
  const slots = slotsOf(r);
  const s = st(r);
  bySlot(r, slots[0]).act({ type: 'pick', side: higherSide(s.a.id, s.b.id), r: s.r });
  await r.clock.advance(7500);
  const after = st(r);
  assert.equal(after.phase, 'reveal');
  assert.equal(after.streaks[slots[0]], 1);
  assert.equal(after.streaks[slots[1]], 0);
  assert.equal(after.gained[slots[1]], undefined);
});

const OWNER = person(2).id;

function fakeFetch() {
  return async (url) => {
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null }) };
  };
}

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

test('admin skip and time work, and junk picks are ignored', async () => {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(), refreshMs: 0, win: null });
  const r = room(2, { games: [higherlower] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('higherlower');
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  const s = st(r);
  bySlot(r, 0).act({ type: 'pick', side: 'c', r: s.r });
  bySlot(r, 0).act({ type: 'pick', side: 'a', r: s.r + 5 });
  await settle(r.clock);
  assert.deepEqual(st(r).done, []);
  owner.admin.run({ type: 'time', ms: 5000 });
  await settle(r.clock);
  assert.equal(st(r).ends, s.ends + 5000);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'reveal');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'guess');
  assert.equal(st(r).i, 1);
  resetAdmins();
});

test('the view hides numbers, sends one pick, and shows the reveal', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [higherlower] });
  await r.clock.advance(500);
  const played = [];
  const cues = { play: (n) => played.push(n), burst: () => played.push('*burst'), float: (el, t) => played.push(`*float ${t}`) };
  const views = r.engines.map((engine) => {
    const v = createHigherlowerView({ engine, fx: { confetti() {} }, cues });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  views[0].update(r.engines[0].snapshot());
  assert.match(text(views[0].el), /Getting the first pair ready/);
  r.engines[0].lobby.pick('higherlower');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const s = st(r);
  const right = higherSide(s.a.id, s.b.id);
  for (const v of views) {
    assert.match(text(v.el), /Round 1 of 10/);
    assert.equal(v.el.querySelectorAll('.hl-value.is-hidden').length, 2);
    for (const node of [v.el, ...all(v.el)]) assert.equal(node.hasAttribute('style'), false);
  }
  const i0 = r.engines.findIndex((e) => e.snapshot().meSlot === 0);
  const i1 = 1 - i0;
  views[i0].el.querySelector(`.hl-card-${right}`).click();
  views[i0].el.querySelector(`.hl-card-${right === 'a' ? 'b' : 'a'}`).click();
  await r.clock.advance(300);
  assert.deepEqual(st(r).done, [0]);
  assert.match(text(views[i0].el), /Locked in!/);
  views[i1].el.querySelector(`.hl-card-${right === 'a' ? 'b' : 'a'}`).click();
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'reveal');
  assert.match(text(views[i0].el), /Right! \+100/);
  assert.match(text(views[i1].el), /Not this time/);
  assert.equal(views[i0].el.querySelectorAll('.hl-value.is-hidden').length, 0);
  assert.ok(views[i0].el.querySelector('.hl-card.is-win'));
  assert.ok(played.includes('correct'));
  assert.ok(played.includes('wrong'));
  for (const v of views) v.destroy();
});

test('foot text and moments read well', () => {
  assert.equal(footText(null), '');
  assert.match(footText({ phase: 'guess', done: 1, players: 3, myPick: 'a' }), /Locked in! 1 of 3 players picked/);
  assert.match(footText({ phase: 'reveal', myPick: 'a', correct: true, streak: 4, myGain: 175 }), /4 in a row/);
  assert.match(footText({ phase: 'reveal', myPick: null }), /streak starts again/);
  const one = higherlowerMoment(null, { r: 1, phase: 'guess' });
  assert.deepEqual(one.cues, []);
  const two = higherlowerMoment(one.now, { r: 1, phase: 'reveal', myPick: 'a', correct: true });
  assert.deepEqual(two.cues, ['reveal', 'correct']);
  assert.deepEqual(higherlowerMoment(two.now, { r: 1, phase: 'reveal', myPick: 'a', correct: true }).cues, []);
});
