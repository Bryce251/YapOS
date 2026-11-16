import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom, type } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import bluff, { KEY, OPTION_PREFIX, FAKE_MAX, PICK_MS, TRUTH_POINTS, FOOL_POINTS, seal, tally, groupFakes, isTruth, revealMs, factParts, buildDeck, optionsFrom, fakeRef } from '../web/activity/js/games/bluff.js';
import { createBluffView, footText, bluffMoment, TRUTH_REFUSAL } from '../web/activity/js/views/bluff.js';
import { FACTS, BLANK, factById } from '../web/activity/data/bluff.js';
import { isBlockedGameWord } from '../web/activity/js/filter.js';

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
  const r = room(n, { games: [bluff], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('bluff'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function fake(e, text) {
  const s = e.snapshot().state[KEY];
  return e.act({ type: 'fake', n: s.n, code: seal(text, s.nonce) });
}

function options(r) {
  return optionsFrom((k) => r.hub.state[k], st(r));
}

function textOf(slot, round) {
  return `zorp ${round} by ${slot}`;
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

test('about 150 original facts, each with one blank and a short answer', () => {
  assert.ok(FACTS.length >= 145, `${FACTS.length} facts`);
  assert.equal(new Set(FACTS.map((f) => f.id)).size, FACTS.length);
  assert.equal(new Set(FACTS.map((f) => f.t)).size, FACTS.length);
  for (const f of FACTS) {
    assert.equal(f.t.split(BLANK).length, 2, f.t);
    assert.ok(f.t.length <= 140, f.t);
    assert.ok(f.a.length >= 1 && f.a.length <= 24, f.a);
    assert.ok(isTruth(f, f.a));
    for (const alt of f.alts) assert.ok(isTruth(f, alt), alt);
    for (const re of BANNED) assert.doesNotMatch(`${f.t} ${f.a}`, re);
    for (const word of f.a.split(/\s+/)) assert.equal(isBlockedGameWord(word.replace(/[^\p{L}]/gu, '')), false, f.a);
  }
  assert.deepEqual(factParts('A ____ b'), { before: 'A ', after: ' b' });
  assert.equal(factById('b001').a, 'flamboyance');
  assert.equal(buildDeck(7, seeded(3)).length, 7);
});

test('the game is a quiz game for 3 or more with 5, 7 or 10 rounds', () => {
  assert.equal(bluff.id, 'bluff');
  assert.equal(bluff.category, 'quiz');
  assert.equal(bluff.emoji, '🃏');
  assert.equal(bluff.minPlayers, 3);
  assert.deepEqual(bluff.settings.find((s) => s.id === 'rounds').options.map((o) => o.value), [5, 7, 10]);
  assert.equal(bluff.settings.find((s) => s.id === 'timer').default, 60);
  for (const re of BANNED) assert.doesNotMatch(`${bluff.name} ${bluff.blurb}`, re);
});

test('fakes that match merge, and the tally pays finders and foolers', () => {
  const groups = groupFakes({ 0: 'Pickles', 2: 'pickles!', 1: 'Jam' });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((g) => g.text === 'Pickles').owners, [0, 2]);
  const t = tally({ 0: [0, 2], 2: [1] }, 1, { 0: 1, 1: 0, 2: 2, 3: 0 });
  assert.equal(t.gained[0], TRUTH_POINTS + FOOL_POINTS * 2);
  assert.equal(t.gained[2], FOOL_POINTS * 2);
  assert.equal(t.gained[1], FOOL_POINTS);
  assert.equal(t.res[0][0], 1, 'the truth comes first');
  assert.equal(t.res[0][3], 1);
  assert.ok(revealMs(40) <= 15000);
});

test('a full game: write fakes, spot the truth, score and finish', async () => {
  const r = await startGame(3, { rounds: 5 });
  const slots = slotsOf(r);
  const totals = {};
  for (let round = 1; round <= 5; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'write');
    assert.equal(s.answer, null, 'the answer is not in shared state while writing');
    const f = factById(s.f.id);
    fake(bySlot(r, slots[0]), f.a);
    await r.clock.advance(300);
    assert.deepEqual(st(r).done, [], 'the real answer is refused as a fake');
    for (const slot of slots) fake(bySlot(r, slot), textOf(slot, round));
    await r.clock.advance(500);
    s = st(r);
    assert.equal(s.phase, 'pick');
    const list = options(r);
    assert.equal(list.length, 4);
    const truth = list.find((o) => o.text === f.a);
    assert.ok(truth);
    const own = list.find((o) => o.text === textOf(slots[0], round));
    bySlot(r, slots[0]).act({ type: 'pick', n: s.n, id: own.id });
    await r.clock.advance(300);
    assert.deepEqual(st(r).picked, [], 'cannot pick your own fake');
    const fake2 = list.find((o) => o.text === textOf(slots[2], round));
    bySlot(r, slots[0]).act({ type: 'pick', n: s.n, id: truth.id });
    bySlot(r, slots[1]).act({ type: 'pick', n: s.n, id: fake2.id });
    bySlot(r, slots[2]).act({ type: 'pick', n: s.n, id: truth.id });
    await r.clock.advance(500);
    s = st(r);
    assert.equal(s.phase, 'reveal');
    assert.equal(s.answer, f.a);
    assert.equal(s.truth, truth.id);
    assert.equal(s.gained[slots[0]], TRUTH_POINTS);
    assert.equal(s.gained[slots[2]], TRUTH_POINTS + FOOL_POINTS);
    assert.equal(s.gained[slots[1]], undefined);
    for (const [slot, pts] of Object.entries(s.gained)) totals[slot] = (totals[slot] || 0) + pts;
    assert.deepEqual(r.engines[1].snapshot().scores.g, totals);
    const m = bluff.model(bySlot(r, slots[1]).snapshot(), {});
    assert.equal(m.fooledBy.length, 1);
    assert.equal(m.foundTruth, false);
    await r.clock.advance(revealMs(s.count) + 300);
  }
  const roomState = r.engines[0].snapshot().room;
  assert.equal(roomState.phase, 'results');
  assert.deepEqual(roomState.last.winners, [slots[2]]);
  assert.equal(Object.keys(r.hub.state).some((k) => k.startsWith(OPTION_PREFIX)), false, 'options are cleaned up');
  assert.deepEqual(r.hub.violations, []);
});

test('fakes are sealed on the wire and filtered for slurs', async () => {
  const r = await startGame(3, { rounds: 5 });
  const s = st(r);
  const code = seal('a secret fib', s.nonce);
  assert.equal(code.includes('secret'), false);
  fake(r.engines[1], 'x'.repeat(200));
  await r.clock.advance(400);
  const cur = r.engines[0].snapshot();
  assert.equal(cur.state[KEY].done.length, 1);
});

test('nobody writing a fake skips to the truth, and timeouts move things on', async () => {
  const r = await startGame(3, { rounds: 5, timer: 45 });
  await r.clock.advance(45500);
  let s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.note, 'nofakes');
  assert.equal(options(r).length, 1);
  await r.clock.advance(revealMs(1) + 300);
  s = st(r);
  assert.equal(s.phase, 'write');
  fake(r.engines[0], 'wibble');
  await r.clock.advance(45500);
  s = st(r);
  assert.equal(s.phase, 'pick');
  await r.clock.advance(PICK_MS + 300);
  assert.equal(st(r).phase, 'reveal');
});

test('texts lists fakes for the report flag with their authors', async () => {
  const r = await startGame(3, { rounds: 5 });
  const slots = slotsOf(r);
  for (const slot of slots) fake(bySlot(r, slot), textOf(slot, 1));
  await r.clock.advance(500);
  const host = r.engines[0];
  const s = st(r);
  const list = options(r);
  const one = list.find((o) => o.text === textOf(slots[1], 1));
  assert.equal(host.report(fakeRef(s.n, s.nonce, one.id)) !== 'no', true);
  const truth = list.find((o) => o.text === factById(s.f.id).a);
  assert.equal(host.report(fakeRef(s.n, s.nonce, truth.id)), 'no');
  const texts = bluff.texts({ get: (k) => r.hub.state[k] ?? null, keys: () => Object.keys(r.hub.state), memory: {} });
  assert.equal(texts.length, 0, 'no authors are known outside the host');
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

test('admins can skip each phase and add time', async () => {
  resetAdmins();
  configureAdmins({ fetch: fakeFetch(), refreshMs: 0, win: null });
  const r = room(3, { games: [bluff] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('bluff');
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock);
  const s = st(r);
  owner.admin.run({ type: 'time', ms: 30000 });
  await settle(r.clock);
  assert.equal(st(r).ends, s.ends + 30000);
  fake(r.engines[2], 'a little fib');
  await settle(r.clock);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'pick');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'reveal');
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  assert.equal(st(r).phase, 'write');
  assert.equal(st(r).i, 1);
  resetAdmins();
});

test('the view refuses the real answer, sends a fake and lets you pick', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3, { games: [bluff] });
  await r.clock.advance(500);
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = createBluffView({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win: {} });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  views[0].update(r.engines[0].snapshot());
  assert.match(text(views[0].el), /Digging up a strange fact/);
  r.engines[0].lobby.pick('bluff');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const s = st(r);
  const f = factById(s.f.id);
  const v0 = views[0];
  const input = v0.el.querySelector('.bluff-input');
  type(input, f.a);
  v0.el.querySelector('.bluff-entry').querySelector('.btn-primary').click();
  assert.match(text(v0.el), new RegExp(TRUTH_REFUSAL.slice(0, 20)));
  await r.clock.advance(300);
  assert.deepEqual(st(r).done, []);
  views.forEach((v, i) => {
    type(v.el.querySelector('.bluff-input'), `fib number ${i}`);
    v.el.querySelector('.bluff-entry').querySelector('.btn-primary').click();
  });
  await r.clock.advance(600);
  assert.equal(st(r).phase, 'pick');
  for (const v of views) {
    assert.equal(v.el.querySelectorAll('.bluff-pick').length, 4);
    assert.equal(v.el.querySelectorAll('.bluff-pick.is-own').length, 1);
    for (const node of [v.el, ...all(v.el)]) assert.equal(node.hasAttribute('style'), false);
  }
  const picks = views.map((v) => v.el.querySelectorAll('.bluff-pick').find((b) => !b.disabled && text(b).includes(f.a)));
  picks.forEach((b) => b.click());
  await r.clock.advance(600);
  assert.equal(st(r).phase, 'reveal');
  for (const v of views) {
    assert.match(text(v.el), /The truth/);
    assert.match(text(v.el), /You found the truth! \+100/);
    assert.ok(v.el.querySelector('.bluff-result.is-truth'));
  }
  for (const v of views) v.destroy();
});

test('foot text and moments read well', () => {
  assert.equal(footText(null), '');
  assert.match(footText({ phase: 'write', done: 1, players: 3, wrote: true }), /Fake in! 1 of 3 players/);
  assert.match(footText({ phase: 'pick', picked: 2, hasPicked: false }), /Which one is real/);
  assert.match(footText({ phase: 'reveal', foundTruth: false, fooledBy: [{ name: 'Sam', isMe: false }], fooledCount: 2, myGain: 100 }), /fell for Sam's fake\. Your fake fooled 2 players\. \+100/);
  const a = bluffMoment(null, { n: 1, phase: 'write' });
  assert.deepEqual(a.cues, []);
  assert.deepEqual(bluffMoment(a.now, { n: 1, phase: 'pick' }).cues, ['pop']);
  assert.deepEqual(bluffMoment({ n: 1, phase: 'pick' }, { n: 1, phase: 'reveal', foundTruth: true, fooledBy: [], fooledCount: 0 }).cues, ['reveal', 'correct']);
});
