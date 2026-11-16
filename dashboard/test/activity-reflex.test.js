import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import reflex, { KEY, greenOf, amberOf, rankRound, bestAfter, plan, pointsFor, SHOW_MS, TAP_WINDOW, MIN_WINDOW, MIN_DELAY, MAX_DELAY, LATE_GAP } from '../web/activity/js/games/reflex.js';
import { createReflexView, padState, lightAt, reflexMoment, ordinal, kindText } from '../web/activity/js/views/reflex.js';
import * as content from '../web/activity/data/reflex.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r, i = 0) {
  return r.engines[i].snapshot().state[KEY];
}

async function startReflex(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [reflex], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('reflex'), true);
  for (const [k, v] of Object.entries({ knockout: false, ...settings })) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function toGreen(r, extra = 60, i = 0) {
  const s = st(r, i);
  const wait = greenOf(s) - r.engines[i].now();
  if (wait + extra > 0) await r.clock.advance(wait + extra);
}

async function tap(r, slot, ms, i = 0) {
  const s = st(r, i);
  bySlot(r, slot).act({ type: 'tap', r: s.r, ms });
  await r.clock.advance(300);
}

async function early(r, slot, on = 'red', i = 0) {
  const s = st(r, i);
  bySlot(r, slot).act({ type: 'early', r: s.r, on });
  await r.clock.advance(300);
}

test('round plans stay inside the window and fake-outs turn amber before green', () => {
  const rnd = seeded(5);
  let fakes = 0;
  for (let i = 0; i < 400; i += 1) {
    const p = plan(rnd, true);
    assert.ok(p.green >= MIN_DELAY && p.green <= MAX_DELAY, `green ${p.green}`);
    assert.ok(p.amber <= p.green);
    if (p.amber < p.green) {
      fakes += 1;
      assert.ok(p.green - p.amber >= 900);
      assert.ok(p.amber >= 1000);
    }
    const q = plan(rnd, false);
    assert.equal(q.amber, q.green);
  }
  assert.ok(fakes > 100 && fakes < 300, `fakes ${fakes}`);
});

test('rounds are ranked by time with shared places for ties', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(pointsFor), [100, 70, 50, 30, 20, 10, 10]);
  const taps = { 0: { k: 'ok', ms: 300 }, 1: { k: 'ok', ms: 210 }, 2: { k: 'ok', ms: 300 }, 3: { k: 'early' }, 4: { k: 'slow', ms: 1800 }, 5: { k: 'fooled' } };
  const { res, gained } = rankRound(taps, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(res.map((x) => [x.s, x.k, x.n, x.p]), [
    [1, 'ok', 1, 100],
    [0, 'ok', 2, 70],
    [2, 'ok', 2, 70],
    [4, 'slow', 0, 0],
    [5, 'fooled', 0, 0],
    [3, 'early', 0, 0],
    [6, 'none', 0, 0],
  ]);
  assert.deepEqual(gained, { 1: 100, 0: 70, 2: 70 });
  assert.deepEqual(bestAfter({ 1: 190, 0: 400 }, res), { 1: 190, 0: 300, 2: 300 });
  assert.deepEqual(rankRound({}, []), { res: [], gained: {} });
});

test('the written lines are friendly and the ratings cover every time', () => {
  for (const list of [content.EARLY, content.FOOLED, content.GUESS, content.SLOW, content.NONE, content.TIPS, content.FAKE_TIPS]) {
    assert.ok(list.length >= 3);
    for (const line of list) {
      assert.ok(line.length > 5 && line.length < 90, line);
      for (const re of BANNED) assert.equal(re.test(line), false, line);
    }
  }
  assert.equal(content.rating(90).label, 'Lightning');
  assert.equal(content.rating(250).label, 'Super quick');
  assert.equal(content.rating(5000).label, 'Snail mode');
  assert.equal(content.rating(NaN), null);
  assert.equal(content.pickLine(['a', 'b'], 3), 'b');
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(23), '23rd');
  assert.equal(reflex.category, 'quick');
  assert.equal(reflex.minPlayers, 1);
  assert.equal(reflex.emoji, '⚡');
});

test('a full game of Reflex from start to finish with three players', async () => {
  const r = await startReflex(3, { rounds: 5, fakeouts: 'off' });
  for (let round = 0; round < 5; round += 1) {
    let s = st(r);
    assert.equal(s.phase, 'wait');
    assert.equal(s.i, round);
    assert.equal(s.total, 5);
    assert.deepEqual(s.in, [0, 1, 2]);
    assert.equal(amberOf(s), null);
    assert.ok(greenOf(s) - s.at >= MIN_DELAY && greenOf(s) - s.at <= MAX_DELAY);
    await early(r, 2);
    assert.deepEqual(st(r).done, [2]);
    await toGreen(r);
    await tap(r, 1, 300 + round);
    await tap(r, 0, 200 + round);
    s = st(r);
    assert.equal(s.phase, 'show', 'everyone is done so the round ends right away');
    const x2 = round === 4 ? 2 : 1;
    assert.deepEqual(s.res.map((x) => [x.s, x.k, x.p]), [
      [0, 'ok', 100 * x2],
      [1, 'ok', 70 * x2],
      [2, 'early', 0],
    ]);
    assert.equal(s.best[0], 200);
    assert.equal(s.best[1], 300);
    const m = reflex.model(bySlot(r, 0).snapshot());
    assert.equal(m.mine.fastest, true);
    assert.equal(m.results[0].isMe, true);
    assert.equal(m.best[0].ms, 200);
    assert.equal(reflex.model(bySlot(r, 2).snapshot()).mine.kind, 'early');
    await r.clock.advance(SHOW_MS + 200);
  }
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [0]);
  assert.deepEqual(snap.scores.t, { 0: 600, 1: 420 }, 'the final round counts double');
  assert.deepEqual(r.hub.violations, []);
});

test('when nobody taps the round ends at the deadline and moves on', async () => {
  const r = await startReflex(3, { rounds: 5, fakeouts: 'off' });
  const s = st(r);
  assert.equal(r.engines[0].snapshot().room.deadline, s.ends);
  assert.equal(s.ends, greenOf(s) + TAP_WINDOW);
  await r.clock.advance(s.ends - r.engines[0].now() - 200);
  assert.equal(st(r).phase, 'wait');
  await r.clock.advance(400);
  const shown = st(r);
  assert.equal(shown.phase, 'show');
  assert.deepEqual(shown.res.map((x) => x.k), ['none', 'none', 'none']);
  assert.match(reflex.model(r.engines[1].snapshot()).mine.kind, /none/);
  await r.clock.advance(SHOW_MS + 100);
  const nx = st(r);
  assert.equal(nx.phase, 'wait');
  assert.equal(nx.i, 1);
  assert.equal(nx.r, s.r + 1);
  assert.deepEqual(r.engines[0].snapshot().scores.g, {});
});

test('fake-out rounds turn amber first and tapping on amber is a false start', async () => {
  const r = await startReflex(2, { rounds: 15, fakeouts: 'on' });
  let s = st(r);
  let guard = 0;
  while (amberOf(s) === null) {
    assert.ok((guard += 1) < 15, 'a fake-out round turns up');
    await r.clock.advance(s.ends - r.engines[0].now() + 100);
    await r.clock.advance(SHOW_MS + 100);
    s = st(r);
  }
  assert.equal(s.fake, 1);
  const m = reflex.model(r.engines[1].snapshot());
  assert.equal(lightAt(m, m.amberAt - 1), 'red');
  assert.equal(lightAt(m, m.amberAt), 'amber');
  assert.equal(lightAt(m, m.greenAt), 'go');
  await r.clock.advance(amberOf(s) - r.engines[0].now() + 50);
  await early(r, 1, 'amber');
  await toGreen(r);
  await tap(r, 0, 260);
  const shown = st(r);
  assert.equal(shown.phase, 'show');
  assert.equal(shown.fk, 1);
  assert.deepEqual(shown.res.map((x) => [x.s, x.k, x.p]), [
    [0, 'ok', 100],
    [1, 'fooled', 0],
  ]);
  assert.equal(reflex.model(r.engines[1].snapshot()).wasFake, true);
});

test('impossible times are ignored, slow ones score nothing and taps count once', async () => {
  const r = await startReflex(3, { rounds: 5, fakeouts: 'off' });
  const s = st(r);
  await tap(r, 0, 250);
  assert.deepEqual(st(r).done, [], 'a tap long before green is ignored');
  await toGreen(r, 1700);
  for (const ms of [10, 79, -5, 'abc', null, Infinity, 9000]) bySlot(r, 0).act({ type: 'tap', r: s.r, ms });
  bySlot(r, 0).act({ type: 'tap', r: s.r - 1, ms: 300 });
  bySlot(r, 0).act({ type: 'nap', r: s.r, ms: 300 });
  await r.clock.advance(300);
  assert.deepEqual(st(r).done, [], 'tiny, broken, too long and old taps are ignored');
  bySlot(r, 0).act({ type: 'tap', r: s.r, ms: 1600 });
  await r.clock.advance(200);
  bySlot(r, 0).act({ type: 'tap', r: s.r, ms: 120 });
  bySlot(r, 1).act({ type: 'tap', r: s.r, ms: 240 });
  bySlot(r, 2).act({ type: 'tap', r: s.r, ms: 400 });
  await r.clock.advance(300);
  const shown = st(r);
  assert.equal(shown.phase, 'show');
  assert.deepEqual(shown.res.map((x) => [x.s, x.k, x.ms, x.p]), [
    [1, 'ok', 240, 100],
    [2, 'ok', 400, 70],
    [0, 'slow', 1600, 0],
  ]);
  assert.equal(shown.best[0], undefined);
});

test('a late joiner plays this round when there is time, or the next one', async () => {
  const r = await startReflex(2, { rounds: 5, fakeouts: 'off' });
  const late = r.add(3);
  await r.clock.advance(400);
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  let s = st(r);
  assert.ok(s.in.includes(slot) || s.wait.includes(slot), 'the late joiner is seen');
  assert.equal(s.in.includes(slot), greenOf(s) - (r.engines[0].now() - 400) >= LATE_GAP || s.in.includes(slot));
  if (s.in.includes(slot)) {
    assert.equal(reflex.model(late.snapshot()).canPlay, true);
  } else {
    assert.equal(reflex.model(late.snapshot()).waiting, true);
    await toGreen(r);
    await tap(r, 0, 300);
    await tap(r, 1, 320);
    assert.equal(st(r).phase, 'show', 'the waiting player does not hold up the round');
    await r.clock.advance(SHOW_MS + 100);
    s = st(r);
    assert.ok(s.in.includes(slot));
  }
  await toGreen(r);
  await tap(r, 0, 300);
  await tap(r, 1, 320);
  assert.equal(st(r).phase, 'wait', 'the late joiner is still to tap');
  await tap(r, slot, 180);
  s = st(r);
  assert.equal(s.phase, 'show');
  assert.equal(s.res[0].s, slot);
  assert.ok(r.engines[0].snapshot().scores.g[slot] >= 100);
  assert.deepEqual(r.hub.violations, []);
});

test('joining near green waits for the next round', () => {
  const store = {
    [KEY]: { r: 1, i: 0, total: 5, phase: 'wait', nonce: 77, at: 1000, g: 2000 ^ 77, a: 2000 ^ 77, in: [0, 1], wait: [], done: [], best: {}, ends: 6000 },
  };
  let now = 2500;
  const api = {
    now: () => now,
    players: () => [0, 1, 2, 3].map((slot) => ({ slot })),
    get: (k) => JSON.parse(JSON.stringify(store[k])),
    put: (k, v) => {
      store[k] = v;
    },
  };
  reflex.join(api, 2);
  assert.deepEqual(store[KEY].wait, [2]);
  now = 1500;
  reflex.join(api, 3);
  assert.deepEqual(store[KEY].in, [0, 1, 3]);
  reflex.join(api, 3);
  assert.deepEqual(store[KEY].in, [0, 1, 3], 'joining twice changes nothing');
});

const OWNER = person(2).id;

async function settle(clock, ms = 600) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setImmediate(res));
    await clock.advance(ms / 6);
  }
}

test('admins can skip and move the clock', async () => {
  resetAdmins();
  const fetch = async (url) => {
    const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
    return { ok: true, status: 200, json: async () => ({ admins: ids.filter((id) => id === OWNER), owner: ids.includes(OWNER) ? OWNER : null }) };
  };
  configureAdmins({ fetch, refreshMs: 0, win: null });
  const r = room(3, { games: [reflex] });
  await r.clock.advance(500);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await settle(r.clock);
  const [host, owner] = r.engines;
  host.lobby.pick('reflex');
  host.lobby.setting('fakeouts', 'off');
  assert.equal(host.lobby.start().ok, true);
  await settle(r.clock, 300);
  const before = st(r);
  owner.admin.run({ type: 'time', ms: 10000 });
  await settle(r.clock);
  let s = st(r);
  assert.equal(s.ends, before.ends + 10000);
  assert.equal(host.snapshot().room.deadline, s.ends);
  owner.admin.run({ type: 'time', ms: -600000 });
  await settle(r.clock);
  s = st(r);
  assert.ok(s.ends >= greenOf(s) + MIN_WINDOW, 'there is always time to tap after green');
  assert.ok(s.ends < before.ends);
  assert.ok(s.ends - host.now() >= 2000);
  assert.equal(host.snapshot().room.deadline, s.ends);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'show');
  const showEnds = s.ends;
  owner.admin.run({ type: 'time', ms: 5000 });
  await settle(r.clock);
  assert.equal(st(r).ends, showEnds + 5000);
  owner.admin.run({ type: 'skip' });
  await settle(r.clock);
  s = st(r);
  assert.equal(s.phase, 'wait');
  assert.equal(s.i, 1);
  resetAdmins();
});

test('a new host restarts the round in play and carries on', async () => {
  const r = await startReflex(3, { rounds: 5, fakeouts: 'off' });
  const host = r.engines[0];
  await toGreen(r);
  await tap(r, 1, 250);
  const before = st(r);
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(600);
  const a = r.engines[1];
  assert.equal(a.isHost(), true);
  let s = st(r, 1);
  assert.equal(s.phase, 'wait');
  assert.equal(s.i, before.i);
  assert.equal(s.r, before.r + 1);
  assert.equal(s.note, 'host');
  assert.deepEqual(s.done, []);
  assert.equal(reflex.model(a.snapshot()).note, 'host');
  const rest = { engines: r.engines.slice(1) };
  bySlot(rest, 1).act({ type: 'tap', r: before.r, ms: 250 });
  await r.clock.advance(300);
  assert.deepEqual(st(r, 1).done, [], 'taps for the old round are ignored');
  await toGreen(r, 60, 1);
  bySlot(rest, 1).act({ type: 'tap', r: s.r, ms: 250 });
  bySlot(rest, 2).act({ type: 'tap', r: s.r, ms: 330 });
  await r.clock.advance(400);
  s = st(r, 1);
  assert.equal(s.phase, 'show');
  assert.deepEqual(s.res.map((x) => x.s), [1, 2], 'the leaver is not waited for or ranked when gone');
  const b = r.engines[2];
  r.hub.leave(a.snapshot().me);
  a.destroy();
  await r.clock.advance(600);
  assert.equal(b.isHost(), true);
  await r.clock.advance(SHOW_MS + 200);
  s = b.snapshot().state[KEY];
  assert.equal(s.phase, 'wait', 'the show phase carries on under the next host');
  assert.equal(s.i, before.i + 1);
  assert.deepEqual(r.hub.violations, []);
});

test('resume with nothing saved starts fresh and an unknown phase gets a deadline', () => {
  const store = {};
  let deadline = null;
  const api = {
    now: () => 1000,
    random: seeded(3),
    settings: { rounds: 5, fakeouts: 'off' },
    memory: {},
    players: () => [{ slot: 0 }],
    get: (k) => (store[k] ? JSON.parse(JSON.stringify(store[k])) : null),
    put: (k, v) => {
      store[k] = v;
    },
    get deadline() {
      return deadline;
    },
    setDeadline: (at) => {
      deadline = at;
    },
  };
  reflex.resume(api);
  assert.equal(store[KEY].phase, 'wait');
  store[KEY] = { ...store[KEY], phase: 'show', res: [] };
  deadline = null;
  reflex.resume(api);
  assert.equal(deadline, 1000);
  assert.equal(reflex.admin(api, { type: 'nope' }), false);
});

function hasNumber(json, n) {
  return new RegExp(`[:,\\[]${n}[,\\]}]`).test(json);
}

test('fourteen players stay inside the shared state limits and the green time stays masked', async () => {
  const r = await startReflex(14, { rounds: 5, fakeouts: 'on' });
  for (let round = 0; round < 3; round += 1) {
    const s = st(r);
    const offset = greenOf(s) - s.at;
    const raw = JSON.stringify(s);
    assert.equal(raw.includes(String(greenOf(s))), false, 'the green time is not in plain text');
    assert.notEqual(s.g, offset);
    if (amberOf(s) !== null) assert.notEqual(s.a, amberOf(s) - s.at);
    await toGreen(r);
    const msOf = (slot) => 300 + round * 7 + slot * 13;
    for (let slot = 0; slot < 13; slot += 1) bySlot(r, slot).act({ type: 'tap', r: s.r, ms: msOf(slot) });
    await r.clock.advance(400);
    const mid = st(r);
    assert.equal(mid.phase, 'wait');
    assert.equal(mid.done.length, 13);
    const vals = JSON.stringify(mid);
    assert.equal(hasNumber('{"a":[1,' + msOf(0) + ']}', msOf(0)), true);
    for (let slot = 0; slot < 13; slot += 1) assert.equal(hasNumber(vals, msOf(slot)), false, 'times stay hidden until the reveal');
    bySlot(r, 13).act({ type: 'tap', r: s.r, ms: msOf(13) });
    await r.clock.advance(600);
    const shown = st(r);
    assert.equal(shown.phase, 'show');
    assert.equal(shown.res.length, 14);
    assert.equal(shown.res[0].ms, 300 + round * 7);
    const snap = r.engines[0].snapshot();
    assert.ok(jsonBytes(shown) <= MAX_VALUE_BYTES, `reflex ${jsonBytes(shown)}`);
    assert.ok(jsonBytes(snap.scores) <= MAX_VALUE_BYTES);
    await r.clock.advance(SHOW_MS + 100);
  }
  assert.deepEqual(r.hub.violations, []);
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

function noInlineStyles(root) {
  for (const el of [root, ...all(root)]) assert.equal(el.hasAttribute('style'), false, `${el.localName}.${el.className} has a style attribute`);
}

function recorder() {
  const played = [];
  return { played, cues: { play: (n) => played.push(n), burst: () => played.push('*burst'), float: (el, t) => played.push(`*float ${t}`) } };
}

test('the view shows red, then green, measures the tap locally and shows the results', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2, { games: [reflex] });
  await r.clock.advance(500);
  let perfNow = 5000;
  const recs = r.engines.map(() => recorder());
  const views = r.engines.map((engine, i) => {
    const v = createReflexView({ engine, fx: { confetti() {} }, cues: recs[i].cues, win: {}, perf: () => perfNow });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  views[0].update(r.engines[0].snapshot());
  assert.match(text(views[0].el), /Getting the first round ready/);
  r.engines[0].lobby.pick('reflex');
  r.engines[0].lobby.setting('fakeouts', 'off');
  r.engines[0].lobby.setting('knockout', false);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  for (const v of views) {
    const pad = v.el.querySelector('.reflex-pad');
    assert.ok(pad.classList.contains('is-red'));
    assert.match(text(v.el), /Wait for it…/);
    assert.match(text(v.el), /Round 1 of 10/);
    assert.equal(pad.disabled, false);
    assert.equal(v.el.querySelector('.timer'), null, 'no timer gives the green time away');
    noInlineStyles(v.el);
  }
  const s = st(r);
  const p0 = views[r.engines.findIndex((e) => e.snapshot().meSlot === 0)];
  const p1 = views[r.engines.findIndex((e) => e.snapshot().meSlot === 1)];
  const rec0 = recs[r.engines.findIndex((e) => e.snapshot().meSlot === 0)];
  const rec1 = recs[r.engines.findIndex((e) => e.snapshot().meSlot === 1)];
  p0.el.querySelector('.reflex-pad').click();
  await r.clock.advance(300);
  assert.match(text(p0.el), /Too soon!/);
  assert.equal(p0.el.querySelector('.reflex-pad').disabled, true);
  assert.deepEqual(st(r).done, [0]);
  await r.clock.advance(greenOf(s) - r.engines[0].now() + 80);
  p1.update(bySlot(r, 1).snapshot());
  const pad1 = p1.el.querySelector('.reflex-pad');
  assert.ok(pad1.classList.contains('is-go'));
  assert.match(text(p1.el), /TAP!/);
  assert.deepEqual(rec1.played.filter((x) => x === 'turn'), ['turn']);
  assert.equal(rec0.played.includes('turn'), false, 'no green cue for someone who already jumped');
  perfNow += 234;
  pad1.click();
  pad1.click();
  assert.match(text(p1.el), /234 ms/);
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'show');
  assert.deepEqual(st(r).res.map((x) => [x.s, x.k, x.ms ?? null]), [
    [1, 'ok', 234],
    [0, 'early', null],
  ]);
  for (const v of views) {
    assert.match(text(v.el), /Best times this game/);
    assert.match(text(v.el), /234 ms/);
    assert.match(text(v.el), /Too soon/);
    assert.ok(v.el.querySelector('.timer'));
    assert.ok(v.el.querySelector('.reflex-row.is-fast'));
    noInlineStyles(v.el);
  }
  assert.match(text(p1.el), /You were fastest with 234 ms/);
  assert.match(text(p1.el), /1st place, \+100/);
  assert.ok(rec1.played.includes('tap'));
  assert.ok(rec1.played.includes('*float 234 ms'));
  assert.ok(rec1.played.includes('correct'));
  assert.ok(rec1.played.includes('*burst'));
  assert.deepEqual(rec0.played.filter((x) => !x.startsWith('*')), ['wrong', 'reveal']);
  for (const rec of recs) for (const bad of ['start', 'win', 'coin']) assert.equal(rec.played.includes(bad), false, bad);
  const counts = rec1.played.reduce((acc, x) => ({ ...acc, [x]: (acc[x] || 0) + 1 }), {});
  assert.equal(counts.reveal, 1);
  assert.equal(counts.tap, 1);
  for (const v of views) v.update(r.engines[0].snapshot());
  assert.equal(rec1.played.filter((x) => x === 'reveal').length, 1, 'cues fire once per moment');
  for (const v of views) v.destroy();
});

test('Space taps and a view opened mid-round stays quiet until something happens', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(1, { games: [reflex] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('reflex');
  r.engines[0].lobby.setting('fakeouts', 'off');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  await toGreen(r, 20);
  let perfNow = 100;
  const rec = recorder();
  const v = createReflexView({ engine: r.engines[0], fx: { confetti() {} }, cues: rec.cues, win: {}, perf: () => perfNow });
  r.engines[0].on('change', (s) => v.update(s));
  v.update(r.engines[0].snapshot());
  assert.ok(v.el.querySelector('.reflex-pad').classList.contains('is-go'));
  assert.deepEqual(rec.played, [], 'nothing plays on first render');
  perfNow += 400;
  const repeat = new FakeEvent('keydown', { bubbles: true });
  repeat.key = ' ';
  repeat.repeat = true;
  document.dispatchEvent(repeat);
  const input = document.createElement('input');
  document.body.append(input);
  const typed = new FakeEvent('keydown', { bubbles: true });
  typed.key = ' ';
  input.dispatchEvent(typed);
  assert.equal(typed.defaultPrevented, false, 'typing a space in a box is left alone');
  assert.match(text(v.el), /TAP!/);
  const space = new FakeEvent('keydown', { bubbles: true });
  space.key = ' ';
  document.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true);
  assert.match(text(v.el), /400 ms/);
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'show');
  assert.equal(st(r).res[0].ms, 400);
  v.destroy();
  const after = new FakeEvent('keydown', { bubbles: true });
  after.key = ' ';
  document.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false, 'the key listener is removed');
});

test('the pad has the right words for every state', () => {
  const base = { r: 3, key: '3', phase: 'wait', fakeouts: true, greenAt: 2000, amberAt: 1500, canPlay: true, iDone: false, waiting: false, watching: false, results: [], best: [] };
  assert.equal(padState(null).tone, 'idle');
  assert.equal(padState(base, null, 'red', 0).tone, 'red');
  assert.match(padState(base, null, 'red', 0).big, /Wait for it/);
  assert.equal(padState(base, null, 'amber', 0).big, 'Not yet…');
  assert.equal(padState(base, null, 'go', 0).big, 'TAP!');
  assert.equal(padState(base, { k: 'early' }, 'red', 0).big, 'Too soon!');
  assert.match(padState(base, { k: 'fooled' }, 'amber', 0).big, /Not yet meant not yet/);
  assert.equal(padState(base, { k: 'guess' }, 'go', 0).big, 'Too quick!');
  assert.equal(padState(base, { k: 'ok', ms: 222 }, 'go', 0).big, '222 ms');
  assert.match(padState(base, { k: 'slow', ms: 1700 }, 'go', 0).small, /Waiting for the others/);
  assert.equal(padState({ ...base, iDone: true }, null, 'go', 0).big, 'Locked in');
  assert.equal(padState({ ...base, watching: true, canPlay: false }, null, 'go', 0).watch, true);
  assert.match(padState({ ...base, waiting: true, canPlay: false }, null, 'red', 0).small, /next round/);
  const show = { ...base, phase: 'show', wasFake: true };
  assert.equal(padState(show, null, null, 0).big, 'Fake-out round!');
  assert.equal(padState({ ...show, mine: { kind: 'ok', ms: 199, place: 1, pts: 100, fastest: true } }).tone, 'best');
  assert.equal(padState({ ...show, mine: { kind: 'none' } }).big, 'No tap');
  assert.equal(kindText({ kind: 'fooled' }), 'Fooled by amber');
  assert.equal(kindText({ kind: 'slow', ms: 1600 }), '1600 ms, too slow');
  assert.deepEqual(reflexMoment(null, { key: '1', phase: 'show', results: [] }).cues, []);
  assert.deepEqual(reflexMoment({ key: '1', phase: 'wait' }, { key: '1', phase: 'show', results: [], mine: null }).cues, ['reveal']);
  assert.deepEqual(reflexMoment({ key: '1', phase: 'wait' }, { key: '2', phase: 'wait', results: [] }).cues, []);
});

test('a solo player can play a whole game with fake-outs', async () => {
  const r = await startReflex(1, { rounds: 15, fakeouts: 'on' });
  let fakes = 0;
  for (let round = 0; round < 15; round += 1) {
    const s = st(r);
    assert.equal(s.phase, 'wait');
    assert.equal(s.i, round);
    assert.deepEqual(s.in, [0]);
    if (amberOf(s) !== null) fakes += 1;
    const m = reflex.model(r.engines[0].snapshot());
    assert.equal(m.canPlay, true);
    assert.equal(m.watching, false);
    if (round % 5 === 4) {
      await early(r, 0);
    } else {
      await toGreen(r);
      await tap(r, 0, 200 + round);
    }
    assert.equal(st(r).phase, 'show', 'a lone player ends the round as soon as they tap');
    await r.clock.advance(SHOW_MS + 100);
  }
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.scores.t, { 0: 1200 });
  assert.ok(fakes > 0, 'some rounds were fake-outs');
  assert.deepEqual(r.hub.violations, []);
});

test('twelve players play a whole game with taps, false starts, a leaver and a full leaderboard', async () => {
  const r = await startReflex(12, { rounds: 5, fakeouts: 'off' });
  const totals = {};
  for (let round = 0; round < 5; round += 1) {
    const s = st(r);
    assert.equal(s.phase, 'wait');
    const live = s.in.slice();
    if (round === 0) assert.equal(live.length, 12);
    for (const slot of live) if (slot % 4 === 3) bySlot(r, slot).act({ type: 'early', r: s.r, on: 'red' });
    await r.clock.advance(300);
    assert.equal(st(r).phase, 'wait');
    await toGreen(r);
    for (const slot of live) if (slot % 4 !== 3 && slot !== 10) bySlot(r, slot).act({ type: 'tap', r: s.r, ms: 180 + slot * 11 + round });
    await r.clock.advance(400);
    if (round === 2) {
      const leaver = bySlot(r, 10);
      r.hub.leave(leaver.snapshot().me);
      r.engines.splice(r.engines.indexOf(leaver), 1);
      await r.clock.advance(600);
      assert.equal(st(r).phase, 'show', 'the round ends once only the leaver was left');
    } else if (round < 2) {
      assert.equal(st(r).phase, 'wait', 'slot 10 still has to tap');
      bySlot(r, 10).act({ type: 'tap', r: s.r, ms: 1400 });
      await r.clock.advance(400);
    }
    const shown = st(r);
    assert.equal(shown.phase, 'show');
    assert.equal(shown.res[0].s, 0);
    assert.equal(shown.res[0].p, round === 4 ? 200 : 100);
    for (const x of shown.res) if (x.p) totals[x.s] = (totals[x.s] || 0) + x.p;
    assert.ok(jsonBytes(shown) <= MAX_VALUE_BYTES);
    const m = reflex.model(bySlot(r, 3).snapshot());
    assert.equal(m.mine.kind, 'early');
    assert.ok(m.best.length >= 8);
    await r.clock.advance(SHOW_MS + 100);
  }
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [0]);
  for (const [slot, pts] of Object.entries(totals)) assert.equal(snap.scores.t[slot], pts);
  assert.deepEqual(r.hub.violations, []);
});

test('a player cannot claim they were fooled by amber in a round with no amber', async () => {
  const r = await startReflex(2, { rounds: 5, fakeouts: 'off' });
  await early(r, 1, 'amber');
  await toGreen(r);
  await tap(r, 0, 250);
  assert.deepEqual(st(r).res.map((x) => [x.s, x.k]), [
    [0, 'ok'],
    [1, 'early'],
  ]);
});

test('thirty-six players still fit in one shared value with slow times and best lists', async () => {
  const r = await startReflex(36, { rounds: 5, fakeouts: 'on' });
  for (let round = 0; round < 2; round += 1) {
    const s = st(r);
    await toGreen(r, 1600);
    for (const slot of s.in) bySlot(r, slot).act({ type: 'tap', r: s.r, ms: slot % 2 ? 1555 + slot : 1000 + slot * 13 });
    await r.clock.advance(800);
    const shown = st(r);
    assert.equal(shown.phase, 'show');
    assert.ok(jsonBytes(shown) <= MAX_VALUE_BYTES, `reflex ${jsonBytes(shown)}`);
    await r.clock.advance(SHOW_MS + 100);
  }
  assert.deepEqual(r.hub.violations, []);
});

test('Space is left alone inside a dialog or on another button', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(1, { games: [reflex] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('reflex');
  r.engines[0].lobby.setting('fakeouts', 'off');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  await toGreen(r, 20);
  const v = createReflexView({ engine: r.engines[0], cues: recorder().cues, win: {}, perf: () => 0 });
  v.update(r.engines[0].snapshot());
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inner = document.createElement('span');
  dialog.append(inner);
  const other = document.createElement('button');
  document.body.append(dialog, other);
  for (const t of [inner, other]) {
    const e = new FakeEvent('keydown', { bubbles: true });
    e.key = ' ';
    t.dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
  }
  assert.match(text(v.el), /TAP!/);
  v.destroy();
});
