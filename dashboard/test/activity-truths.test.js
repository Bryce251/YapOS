import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { checkProfileFaces } from './talk-faces.js';
import truths, { KEY, cleanSet, problemOf, score, best, mask, unmask, SPOT_POINTS, FOOL_POINTS, REVEAL_MS, END_MS, STATEMENT_MAX, RESUME_MIN_MS, PROBLEMS } from '../web/activity/js/games/truths.js';
import { createTruthsView, verdict, truthsMoment } from '../web/activity/js/views/truths.js';
import { IDEAS, SAMPLES } from '../web/activity/data/truths.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r, i = 0) {
  return r.engines[i].snapshot().state[KEY];
}

async function startTruths(n = 3, settings = {}, opts = {}) {
  const r = room(n, { games: [truths], ...opts });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('truths'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function setFor(slot) {
  return [`Slot ${slot} has a purple bike`, `Slot ${slot} once met a goat`, `Slot ${slot} can wiggle both ears`];
}

function lieFor(slot) {
  return slot % 3;
}

function submit(engine, n, slot, extra = {}) {
  engine.act({ type: 'set', n, s: setFor(slot), c: mask(lieFor(slot), n), ...extra });
}

function lieShown(s) {
  const slot = Number(/Slot (\d+)/.exec(s.s[0])[1]);
  const text = setFor(slot)[lieFor(slot)];
  return s.s.indexOf(text);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

function fakeApi(slots, settings = { write: 90, vote: 20 }) {
  const store = {};
  const scores = {};
  const clock = { t: 1000 };
  const api = {
    now: () => clock.t,
    random: seeded(7),
    settings,
    memory: {},
    list: slots.slice(),
    deadline: null,
    finished: false,
    players: () => api.list.map((slot) => ({ slot, id: `id-${slot}`, name: `Player ${slot + 1}` })),
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    put: (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
    },
    setDeadline: (at) => {
      api.deadline = at;
    },
    clearDeadline: () => {
      api.deadline = null;
    },
    shift: (ends, ms) => Math.max(clock.t + 3000, ends + ms),
    addPoints: (slot, n) => {
      scores[slot] = (scores[slot] || 0) + n;
    },
    points: () => ({ ...scores }),
    finish: () => {
      api.finished = true;
    },
  };
  return { api, store, scores, clock };
}

test('sets are cleaned, checked and scored fairly', () => {
  assert.deepEqual(cleanSet(['  I have   a cat ', 'I like rain', 'I can swim']), ['I have a cat', 'I like rain', 'I can swim']);
  assert.equal(cleanSet(['a', 'b']), null);
  assert.equal(cleanSet(['a', '', 'c']), null);
  assert.equal(cleanSet(['Same thing', 'same thing!', 'other']), null);
  assert.equal(cleanSet(['x'.repeat(200), 'b', 'c'])[0].length, STATEMENT_MAX);
  assert.equal(cleanSet(['see https://example.com', 'hi <@abc> there', 'third'])[0].includes('https'), false);
  assert.equal(problemOf(['a', '', 'c'], 1), 'empty');
  assert.equal(problemOf(['a', 'a', 'c'], 1), 'same');
  assert.equal(problemOf(['a', 'b', 'c'], null), 'lie');
  assert.equal(problemOf(['a', 'b', 'c'], 2), null);
  const r = score({ 1: 2, 2: 0, 3: 1, 0: 2 }, 2, 0);
  assert.deepEqual(r.spotted, [1]);
  assert.deepEqual(r.fooled.sort(), [2, 3]);
  assert.equal(r.gained[1], SPOT_POINTS);
  assert.equal(r.gained[0], FOOL_POINTS * 2);
  assert.equal(r.gained[2], undefined);
  assert.deepEqual(best({ 0: 2, 1: 3, 2: 3 }), { slots: [1, 2], n: 3 });
  assert.deepEqual(best({}), { slots: [], n: 0 });
  for (let i = 0; i < 3; i += 1) assert.equal(unmask(mask(i, 4242), 4242), i);
  assert.ok(IDEAS.length >= 30);
  for (const row of SAMPLES) assert.equal(row.length, 3);
  for (const text of Object.values(PROBLEMS).concat(IDEAS, SAMPLES.flat())) for (const re of BANNED) assert.equal(re.test(text), false, text);
  assert.equal(truths.category, 'party');
  assert.equal(truths.minPlayers, 3);
});

test('a full game: write, vote on each set, reveal, awards and results', async () => {
  const r = await startTruths(4, { write: 60, vote: 15 });
  let s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.ends - s.starts, 60000);
  assert.deepEqual(s.in.slice().sort(), [0, 1, 2, 3]);
  const slots = slotsOf(r);
  for (const slot of slots.slice(0, 3)) submit(bySlot(r, slot), s.n, slot);
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.done.length, 3);
  submit(bySlot(r, slots[3]), s.n, slots[3]);
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'vote', 'everyone ready ends writing early');
  assert.equal(s.total, 4);
  assert.deepEqual(s.order.slice().sort(), [0, 1, 2, 3]);
  const tally = { fooled: {}, spotted: {}, pts: {} };
  const add = (slot, n) => {
    tally.pts[slot] = (tally.pts[slot] || 0) + n;
  };
  const orders = new Set();
  for (let k = 0; k < 4; k += 1) {
    s = st(r);
    assert.equal(s.phase, 'vote');
    assert.equal(s.i, k);
    assert.equal(s.ends - s.starts, 15000);
    assert.equal(s.lie, null);
    const writer = s.writer;
    const lie = lieShown(s);
    orders.add(lie);
    assert.ok(lie >= 0);
    bySlot(r, writer).act({ type: 'vote', v: s.v, pick: lie });
    await r.clock.advance(300);
    assert.equal(st(r).voted.length, 0, 'the writer cannot vote on their own set');
    const voters = slots.filter((x) => x !== writer);
    const mult = k === 3 ? 2 : 1;
    voters.forEach((slot, j) => {
      const pick = j === 0 ? lie : (lie + 1) % 3;
      bySlot(r, slot).act({ type: 'vote', v: s.v, pick });
      bySlot(r, slot).act({ type: 'vote', v: s.v, pick: lie });
      if (pick === lie) {
        add(slot, SPOT_POINTS * mult);
        tally.spotted[slot] = (tally.spotted[slot] || 0) + 1;
      } else {
        add(writer, FOOL_POINTS * mult);
        tally.fooled[writer] = (tally.fooled[writer] || 0) + 1;
      }
    });
    await r.clock.advance(400);
    s = st(r);
    assert.equal(s.phase, 'reveal', 'everyone voted reveals early');
    assert.equal(s.lie, lie);
    assert.equal(s.votes[voters[0]], lie);
    assert.equal(s.votes[voters[1]], (lie + 1) % 3, 'only the first vote counts');
    assert.equal(s.gained[writer], FOOL_POINTS * 2 * mult, 'the last set counts double');
    const m = truths.model(bySlot(r, voters[0]).snapshot());
    assert.equal(m.spotted, true);
    assert.equal(m.myGain, SPOT_POINTS * mult);
    assert.match(verdict(m), /You spotted/);
    const wm = truths.model(bySlot(r, writer).snapshot());
    assert.equal(wm.fooled, 2);
    assert.match(verdict(wm), /You fooled 2 people/);
    assert.match(verdict(truths.model(bySlot(r, voters[1]).snapshot())), /fooled you/);
    await r.clock.advance(REVEAL_MS + 200);
  }
  s = st(r);
  assert.equal(s.phase, 'end');
  assert.equal(s.liar.n, 2);
  assert.equal(s.liar.slots.length, 4);
  assert.deepEqual(s.fooled, tally.fooled);
  assert.deepEqual(s.spotted, tally.spotted);
  const em = truths.model(r.engines[1].snapshot());
  assert.equal(em.liar.people.length, 4);
  assert.equal(em.detective.n, best(tally.spotted).n);
  assert.deepEqual(r.engines[0].snapshot().scores.g, Object.fromEntries(Object.entries(tally.pts).map(([k, v]) => [k, v])));
  await r.clock.advance(END_MS + 200);
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('timers move the game on: writing ends, unvoted sets reveal, and only finished writers get a set', async () => {
  const r = await startTruths(3, { write: 60, vote: 20 });
  let s = st(r);
  const slots = slotsOf(r);
  submit(bySlot(r, slots[0]), s.n, slots[0]);
  bySlot(r, slots[1]).act({ type: 'set', n: s.n, s: ['only one', '', ''], c: mask(0, s.n) });
  bySlot(r, slots[2]).act({ type: 'set', n: s.n + 1, s: setFor(slots[2]), c: mask(0, s.n + 1) });
  await r.clock.advance(400);
  assert.deepEqual(st(r).done, [slots[0]]);
  await r.clock.advance(60000);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.deepEqual(s.order, [slots[0]]);
  assert.equal(s.writer, slots[0]);
  await r.clock.advance(20000 + 200);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.votes, {});
  assert.equal(s.lie, lieShown(s));
  assert.match(verdict(truths.model(bySlot(r, slots[1]).snapshot())), /You didn't vote/);
  await r.clock.advance(REVEAL_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'end');
  assert.equal(truths.model(r.engines[0].snapshot()).liar.people.length, 0);
  await r.clock.advance(END_MS + 200);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
});

test('nobody writing ends the game gently', async () => {
  const r = await startTruths(3, { write: 60 });
  await r.clock.advance(60000 + 300);
  const s = st(r);
  assert.equal(s.phase, 'end');
  assert.equal(s.note, 'empty');
  assert.match(verdict(truths.model(r.engines[1].snapshot())), /Nobody finished writing/);
  await r.clock.advance(10000);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
});

test('players can change their answers until writing ends', async () => {
  const r = await startTruths(3);
  let s = st(r);
  const slots = slotsOf(r);
  const me = bySlot(r, slots[0]);
  submit(me, s.n, slots[0]);
  submit(bySlot(r, slots[1]), s.n, slots[1]);
  await r.clock.advance(300);
  me.act({ type: 'edit', n: s.n });
  await r.clock.advance(300);
  assert.deepEqual(st(r).done, [slots[1]]);
  submit(bySlot(r, slots[2]), s.n, slots[2]);
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'write', 'someone editing holds the early start');
  me.act({ type: 'set', n: s.n, s: ['New one', 'Second new', 'Third new'], c: mask(1, s.n) });
  await r.clock.advance(300);
  s = st(r);
  assert.equal(s.phase, 'vote');
  while (st(r).writer !== slots[0]) await r.clock.advance(s.ends - s.starts + REVEAL_MS + 400);
  s = st(r);
  assert.deepEqual(s.s.slice().sort(), ['New one', 'Second new', 'Third new']);
});

test('late joiners vote and score but do not get a set', async () => {
  const r = await startTruths(3);
  let s = st(r);
  const late = r.add(4);
  await r.clock.advance(600);
  const lateSlot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(lateSlot));
  s = st(r);
  assert.equal(s.in.includes(lateSlot), false);
  assert.ok(s.late.includes(lateSlot));
  const lm = truths.model(late.snapshot());
  assert.equal(lm.late, true);
  assert.match(verdict(lm), /detective/);
  submit(late, s.n, lateSlot);
  for (const slot of s.in) submit(bySlot(r, slot), s.n, slot);
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.order.includes(lateSlot), false);
  assert.equal(s.total, 3);
  const lie = lieShown(s);
  for (const slot of slotsOf(r).filter((x) => x !== s.writer && x !== lateSlot)) bySlot(r, slot).act({ type: 'vote', v: s.v, pick: lie });
  await r.clock.advance(300);
  assert.equal(st(r).phase, 'vote', 'the late joiner still counts toward everyone voting');
  late.act({ type: 'vote', v: s.v, pick: lie });
  await r.clock.advance(300);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.gained[lateSlot], SPOT_POINTS);
  assert.equal(r.engines[0].snapshot().scores.g[lateSlot], SPOT_POINTS);
  assert.deepEqual(r.hub.violations, []);
});

test('admin skip and time work in every phase', () => {
  const { api, store, clock } = fakeApi([0, 1, 2]);
  truths.start(api);
  const n = store.truths.n;
  assert.equal(truths.admin(api, { type: 'time', ms: 30000 }), true);
  assert.equal(store.truths.ends, 1000 + 90000 + 30000);
  assert.equal(api.deadline, store.truths.ends);
  truths.intent(api, 0, { type: 'set', n, s: setFor(0), c: mask(lieFor(0), n) });
  truths.intent(api, 1, { type: 'set', n, s: setFor(1), c: mask(lieFor(1), n) });
  assert.equal(truths.admin(api, { type: 'skip' }), true);
  assert.equal(store.truths.phase, 'vote');
  assert.equal(store.truths.total, 2);
  clock.t += 1000;
  assert.equal(truths.admin(api, { type: 'time', ms: -60000 }), true);
  assert.equal(store.truths.ends, clock.t + 3000);
  assert.equal(truths.admin(api, { type: 'skip' }), true);
  assert.equal(store.truths.phase, 'reveal');
  assert.equal(truths.admin(api, { type: 'skip' }), true);
  assert.equal(store.truths.phase, 'vote');
  assert.equal(store.truths.i, 1);
  truths.admin(api, { type: 'skip' });
  truths.admin(api, { type: 'skip' });
  assert.equal(store.truths.phase, 'end');
  assert.equal(truths.admin(api, { type: 'nope' }), false);
  assert.equal(truths.admin(api, { type: 'skip' }), true);
  assert.equal(api.finished, true);
});

test('the deadline and roster hooks are safe on odd state', () => {
  const { api, store } = fakeApi([0, 1, 2]);
  truths.deadline(api);
  assert.equal(api.finished, true);
  const b = fakeApi([0, 1, 2]);
  truths.start(b.api);
  b.api.list = [];
  truths.roster(b.api);
  assert.equal(b.store.truths.phase, 'end', 'everyone leaving ends writing');
  truths.join(b.api, 7);
  truths.join(b.api, 7);
  assert.deepEqual(b.store.truths.late, [7]);
  assert.equal(store.truths, undefined);
});

async function hostChange(seed) {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startTruths(4, { vote: 20 }, { seed });
  const views = r.engines.map((engine) => {
    const v = createTruthsView({ engine, fx: { confetti() {} }, cues: null });
    engine.on('change', (snap) => v.update(snap));
    v.update(engine.snapshot());
    return v;
  });
  let s = st(r);
  const slots = slotsOf(r);
  slots.forEach((slot, i) => {
    const v = views[i];
    const inputs = v.el.querySelectorAll('.truths-input');
    setFor(slot).forEach((t, k) => {
      inputs[k].value = t;
    });
    v.el.querySelectorAll('.truths-lie-btn')[lieFor(slot)].click();
    byKey(v.el, 'truths-lock').click();
  });
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.phase, 'vote');
  const host = r.engines[0];
  const hostSlot = host.snapshot().meSlot;
  const oldV = s.v;
  const writer = s.writer;
  const shown = s.s.slice();
  r.hub.leave(host.snapshot().me);
  host.destroy();
  views[0].destroy();
  await r.clock.advance(800);
  const rest = { engines: r.engines.slice(1) };
  assert.equal(r.engines[1].isHost(), true);
  s = r.engines[1].snapshot().state[KEY];
  const voters = slots.filter((x) => x !== writer && x !== hostSlot);
  if (writer === hostSlot) {
    assert.equal(s.phase, 'reveal', 'a set whose writer left reveals as lost right away');
    assert.equal(s.lie, null);
    assert.equal(s.note, 'lost');
    assert.match(verdict(truths.model(r.engines[1].snapshot())), /got lost/);
  } else {
    assert.equal(s.phase, 'vote');
    assert.equal(s.note, 'host');
    assert.equal(s.v, oldV + 1);
    assert.deepEqual(s.voted, []);
    assert.deepEqual(s.s, shown, 'the same statements stay up');
    assert.equal(s.ends - s.starts, 20000);
    assert.equal(s.lie, null);
    const lie = lieShown(s);
    for (const slot of voters) bySlot(rest, slot).act({ type: 'vote', v: s.v, pick: lie });
    await r.clock.advance(600);
    s = r.engines[1].snapshot().state[KEY];
    assert.equal(s.phase, 'reveal');
    assert.equal(s.lie, lie, 'the writer sent their set again');
    for (const slot of voters) assert.equal(s.gained[slot], SPOT_POINTS);
  }
  await r.clock.advance(REVEAL_MS + 200);
  const played = [];
  for (let guard = 0; guard < 6 && st(r, 1).phase === 'vote'; guard += 1) {
    const cur = st(r, 1);
    assert.notEqual(cur.writer, hostSlot, 'a set nobody can send again is skipped');
    await r.clock.advance(20000 + 200);
    const shownLie = st(r, 1);
    assert.equal(shownLie.phase, 'reveal');
    assert.equal(shownLie.lie, lieShown(shownLie), 'later sets were sent again and reveal properly');
    played.push(cur.writer);
    await r.clock.advance(REVEAL_MS + 200);
  }
  s = st(r, 1);
  assert.equal(s.phase, 'end');
  assert.equal(played.length, s.order.filter((x) => x !== hostSlot).length - (writer === hostSlot ? 0 : 1));
  assert.ok(played.length >= 2);
  for (const v of views.slice(1)) v.destroy();
  assert.deepEqual(r.hub.violations, []);
  return writer === hostSlot;
}

test('a host change mid-vote restarts the vote and the writers send their sets again', async () => {
  const seen = new Set();
  for (const seed of [11, 3, 5, 8, 13, 21]) seen.add(await hostChange(seed));
  assert.deepEqual([...seen].sort(), [false, true], 'both the writer leaving and a voter leaving are covered');
});

test('a host change without anyone to resend ends each lost set gracefully', () => {
  const { api, store, clock } = fakeApi([0, 1, 2]);
  truths.start(api);
  const n = store.truths.n;
  for (const slot of [0, 1, 2]) truths.intent(api, slot, { type: 'set', n, s: setFor(slot), c: mask(lieFor(slot), n) });
  assert.equal(store.truths.phase, 'vote');
  api.memory = {};
  truths.resume(api);
  assert.equal(store.truths.note, 'host');
  clock.t += 30000;
  truths.deadline(api);
  assert.equal(store.truths.phase, 'reveal');
  assert.equal(store.truths.lie, null);
  truths.deadline(api);
  assert.equal(store.truths.phase, 'end', 'sets nobody sent again are skipped');
  truths.deadline(api);
  assert.equal(api.finished, true);
  const w = fakeApi([0, 1, 2]);
  truths.start(w.api);
  w.clock.t += 85000;
  w.api.memory = {};
  truths.resume(w.api);
  assert.equal(w.store.truths.phase, 'write');
  assert.equal(w.store.truths.ends, w.clock.t + RESUME_MIN_MS, 'writers get a little extra time');
  const e = fakeApi([0, 1, 2]);
  e.api.memory = {};
  truths.resume(e.api);
  assert.equal(e.store.truths.phase, 'write', 'no state starts a fresh game');
});

test('secrets stay out of shared state until each reveal', async () => {
  const r = await startTruths(3, { vote: 20 });
  let s = st(r);
  const slots = slotsOf(r);
  const sent = [];
  const before = r.hub.send.bind(r.hub);
  r.hub.send = (id, data) => {
    sent.push(JSON.stringify(data));
    return before(id, data);
  };
  for (const slot of slots) submit(bySlot(r, slot), s.n, slot);
  await r.clock.advance(400);
  const all = (snap) => JSON.stringify(snap.state);
  for (let k = 0; k < 3; k += 1) {
    s = st(r);
    assert.equal(s.phase, 'vote');
    const text = all(r.engines[2].snapshot());
    for (const slot of slots) {
      if (slot === s.writer) continue;
      for (const line of setFor(slot)) assert.equal(text.includes(line), false, `${line} leaked`);
    }
    assert.equal(s.lie, null);
    assert.equal(s.votes, null);
    assert.equal(/lie(At)?":\s*\d/.test(JSON.stringify(s)), false);
    await r.clock.advance(20000 + 200);
    assert.equal(st(r).lie, lieShown(st(r)));
    await r.clock.advance(REVEAL_MS + 200);
  }
  const lies = sent.filter((x) => x.includes('"set"'));
  assert.ok(lies.length >= 2);
  for (const raw of lies) assert.equal(/"lie"/.test(raw), false);
});

test('state stays under the limits with 14 players writing long statements', async () => {
  const r = await startTruths(14, { write: 120 });
  let s = st(r);
  const long = (slot, k) => `${'🦄'.repeat(10)} ${slot}-${k} ${'w'.repeat(STATEMENT_MAX)}`;
  for (const slot of slotsOf(r)) bySlot(r, slot).act({ type: 'set', n: s.n, s: [0, 1, 2].map((k) => long(slot, k)), c: mask(1, s.n) });
  await r.clock.advance(1500);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.total, 14);
  let biggest = 0;
  for (let k = 0; k < 14; k += 1) {
    s = st(r);
    for (const slot of slotsOf(r).filter((x) => x !== s.writer)) bySlot(r, slot).act({ type: 'vote', v: s.v, pick: k % 3 });
    await r.clock.advance(1500);
    const snap = r.engines[5].snapshot();
    biggest = Math.max(biggest, jsonBytes(snap.state[KEY]));
    assert.ok(jsonBytes(snap.state) < 64 * 1024 * 0.5);
    assert.equal(snap.state[KEY].phase, 'reveal');
    await r.clock.advance(REVEAL_MS + 200);
  }
  assert.ok(biggest <= MAX_VALUE_BYTES, String(biggest));
  assert.equal(st(r).phase, 'end');
  assert.deepEqual(r.hub.violations, []);
});

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
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

test('the view renders every phase without inline styles and plays cues once', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startTruths(3, { vote: 15 });
  const played = r.engines.map(() => []);
  let confetti = 0;
  const views = r.engines.map((engine, i) => {
    const v = createTruthsView({ engine, fx: { confetti: () => (confetti += 1) }, cues: { play: (name) => played[i].push(name), burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    v.update(engine.snapshot());
    return v;
  });
  const noStyle = () => {
    for (const v of views) for (const node of all(v.el)) assert.equal(node.getAttribute('style'), null, node.className);
  };
  const slots = slotsOf(r);
  const v0 = views[0];
  assert.equal(v0.el.querySelector('.truths-form').classList.contains('truths-off'), false);
  assert.match(text(v0.el), /Two truths and one lie/i);
  assert.match(text(v0.el), /Stuck\? Try:/);
  assert.deepEqual(played[0], []);
  noStyle();
  byKey(v0.el, 'truths-lock').click();
  assert.match(text(v0.el), /Fill in all three/);
  const inputs = v0.el.querySelectorAll('.truths-input');
  setFor(slots[0]).forEach((t, k) => {
    inputs[k].value = t;
  });
  byKey(v0.el, 'truths-lock').click();
  assert.match(text(v0.el), /Tap “Lie”/);
  v0.el.querySelectorAll('.truths-lie-btn')[lieFor(slots[0])].click();
  assert.equal(v0.el.querySelectorAll('.truths-lie-btn')[lieFor(slots[0])].getAttribute('aria-pressed'), 'true');
  byKey(v0.el, 'truths-lock').click();
  await r.clock.advance(400);
  assert.match(text(v0.el), /Locked in!/);
  assert.equal(inputs[0].disabled, true);
  assert.equal(byKey(v0.el, 'truths-edit').classList.contains('truths-off'), false);
  assert.ok(played[1].includes('pop'), 'others hear someone lock in');
  assert.equal(played[0].includes('pop'), false);
  noStyle();
  for (let i = 1; i < 3; i += 1) {
    const ins = views[i].el.querySelectorAll('.truths-input');
    setFor(slots[i]).forEach((t, k) => {
      ins[k].value = t;
    });
    views[i].el.querySelectorAll('.truths-lie-btn')[lieFor(slots[i])].click();
    byKey(views[i].el, 'truths-lock').click();
  }
  await r.clock.advance(500);
  let s = st(r);
  assert.equal(s.phase, 'vote');
  const wIdx = slots.indexOf(s.writer);
  const writerView = views[wIdx];
  const voterIdx = [0, 1, 2].filter((i) => i !== wIdx);
  assert.equal(writerView.el.querySelector('.truths-form').classList.contains('truths-off'), true);
  assert.match(text(writerView.el), /Can they find your lie\?/);
  assert.equal(byKey(writerView.el, 'truths-pick-0').disabled, true);
  assert.ok(played[wIdx].includes('turn'));
  assert.match(text(views[voterIdx[0]].el), /Which one is the lie\?/);
  assert.ok(played[voterIdx[0]].includes('whoosh'));
  noStyle();
  const lie = lieShown(s);
  byKey(views[voterIdx[0]].el, `truths-pick-${lie}`).click();
  byKey(views[voterIdx[1]].el, `truths-pick-${(lie + 1) % 3}`).click();
  assert.equal(byKey(views[voterIdx[0]].el, `truths-pick-${lie}`).classList.contains('is-mine'), true);
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  const good = views[voterIdx[0]].el;
  assert.match(text(good), /You spotted/);
  assert.equal(good.querySelector('.truths-is-lie').dataset.key, `truths-pick-${lie}`);
  assert.equal(good.querySelectorAll('.truths-is-true').length, 2);
  checkProfileFaces(good, 3);
  assert.equal(good.querySelectorAll('.truths-voters').length, 3);
  checkProfileFaces(writerView.el, 3);
  assert.match(text(views[voterIdx[1]].el), /fooled you/);
  assert.match(text(writerView.el), /You fooled 1 person/);
  assert.equal(played[voterIdx[0]].filter((x) => x === 'reveal').length, 1);
  assert.ok(played[voterIdx[0]].includes('correct'));
  assert.ok(played[voterIdx[1]].includes('wrong'));
  assert.ok(played[wIdx].includes('correct'));
  noStyle();
  for (const v of views) v.update(r.engines[views.indexOf(v)].snapshot());
  assert.equal(played[voterIdx[0]].filter((x) => x === 'reveal').length, 1, 'cues fire once per moment');
  while (st(r).phase !== 'end') await r.clock.advance(15000 + REVEAL_MS + 300);
  assert.match(text(views[0].el), /Best liar/);
  assert.match(text(views[0].el), /Best detective/);
  assert.ok(confetti >= 1);
  noStyle();
  for (const p of played) {
    assert.equal(p.includes('start'), false);
    assert.equal(p.includes('win'), false);
    assert.equal(p.includes('coin'), false);
  }
  for (const v of views) for (const re of BANNED) assert.equal(re.test(text(v.el)), false);
  for (const v of views) v.destroy();
});

test('cue moments are quiet on first render and for a new game', () => {
  const m = { n: 5, phase: 'reveal', v: 2, doneCount: 0, myGain: 100, lost: false, fooledMe: false };
  assert.deepEqual(truthsMoment(null, m).cues, []);
  const was = truthsMoment(null, { ...m, phase: 'vote' }).now;
  assert.deepEqual(truthsMoment(was, m).cues, ['reveal', 'correct']);
  assert.deepEqual(truthsMoment({ ...was, n: 4 }, m).cues, []);
});

async function playAll(n) {
  const r = await startTruths(n);
  let s = st(r);
  const slots = slotsOf(r);
  for (const slot of slots) submit(bySlot(r, slot), s.n, slot);
  await r.clock.advance(800);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.total, n);
  const expect = {};
  const add = (slot, pts) => {
    expect[slot] = (expect[slot] || 0) + pts;
  };
  const fooled = {};
  const spotted = {};
  for (let k = 0; k < n; k += 1) {
    s = st(r);
    assert.equal(s.phase, 'vote');
    assert.equal(s.i, k);
    const lie = lieShown(s);
    const voters = slots.filter((x) => x !== s.writer);
    const mult = k === n - 1 ? 2 : 1;
    voters.forEach((slot, j) => {
      const pick = j % 2 === 0 ? lie : (lie + 1) % 3;
      if (pick === lie) {
        add(slot, SPOT_POINTS * mult);
        spotted[slot] = (spotted[slot] || 0) + 1;
      } else {
        add(s.writer, FOOL_POINTS * mult);
        fooled[s.writer] = (fooled[s.writer] || 0) + 1;
      }
      bySlot(r, slot).act({ type: 'vote', v: s.v, pick });
    });
    await r.clock.advance(800);
    s = st(r);
    assert.equal(s.phase, 'reveal');
    assert.equal(s.lie, lie);
    await r.clock.advance(REVEAL_MS + 200);
  }
  s = st(r);
  assert.equal(s.phase, 'end');
  assert.deepEqual(s.fooled, fooled);
  assert.deepEqual(s.spotted, spotted);
  assert.deepEqual(r.engines[0].snapshot().scores.g, expect);
  await r.clock.advance(END_MS + 200);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
}

test('full games play end to end with 3 and 12 players', async () => {
  await playAll(3);
  await playAll(12);
});

test('the game cannot start with fewer than 3 players', async () => {
  const r = room(2, { games: [truths] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('truths');
  assert.equal(r.engines[0].lobby.start().ok, false);
});

test('non-hosts cannot cheat with forged intents', () => {
  const { api, store, scores } = fakeApi([0, 1, 2, 3]);
  truths.start(api);
  const n = store.truths.n;
  truths.intent(api, 0, { type: 'vote', v: store.truths.v, pick: 0 });
  truths.intent(api, 9, { type: 'set', n, s: setFor(9), c: mask(0, n) });
  assert.equal(api.memory.sets[9], undefined, 'someone not writing cannot add a set');
  truths.intent(api, 1, { type: 'set', n, s: setFor(1), c: mask(7, n) });
  assert.equal(api.memory.sets[1], undefined, 'a bad lie number is refused');
  truths.intent(api, 1, { type: 'edit', n });
  assert.deepEqual(store.truths.done, []);
  for (const slot of [0, 1, 2, 3]) truths.intent(api, slot, { type: 'set', n, s: setFor(slot), c: mask(lieFor(slot), n) });
  const s = store.truths;
  assert.equal(s.phase, 'vote');
  const writer = s.writer;
  const lie = api.memory.cur.lieAt;
  truths.intent(api, writer, { type: 'vote', v: s.v, pick: lie });
  assert.deepEqual(store.truths.voted, [], 'the writer cannot vote on their own set');
  const other = [0, 1, 2, 3].find((x) => x !== writer);
  truths.intent(api, other, { type: 'vote', v: s.v + 1, pick: lie });
  truths.intent(api, other, { type: 'vote', v: s.v, pick: 5 });
  truths.intent(api, other, { type: 'vote', v: s.v, pick: '1' });
  assert.deepEqual(store.truths.voted, []);
  truths.intent(api, other, { type: 'vote', v: s.v, pick: (lie + 1) % 3 });
  truths.intent(api, other, { type: 'vote', v: s.v, pick: lie });
  assert.equal(api.memory.cur.votes[other], (lie + 1) % 3, 'only the first vote counts');
  truths.intent(api, other, { type: 'set', n, s: ['a', 'b', 'c'], c: mask(0, n) });
  truths.intent(api, writer, { type: 'set', n, s: ['a', 'b', 'c'], c: mask(0, n) });
  assert.deepEqual(api.memory.sets[writer].s, setFor(writer), 'sets cannot be swapped after writing');
  truths.intent(api, other, { type: 'skip' });
  truths.intent(api, other, { type: 'points', n: 9999 });
  assert.equal(store.truths.phase, 'vote');
  assert.deepEqual(scores, {});
});

test('after a host change, votes wait for the writer to send their set again', () => {
  const { api, store } = fakeApi([0, 1, 2]);
  truths.start(api);
  const n = store.truths.n;
  for (const slot of [0, 1, 2]) truths.intent(api, slot, { type: 'set', n, s: setFor(slot), c: mask(lieFor(slot), n) });
  api.memory = {};
  truths.resume(api);
  const s = store.truths;
  assert.equal(s.phase, 'vote');
  const lie = lieShown(s);
  for (const slot of [0, 1, 2].filter((x) => x !== s.writer)) truths.intent(api, slot, { type: 'vote', v: s.v, pick: lie });
  assert.equal(store.truths.phase, 'vote', 'no early lost reveal while the writer is still here');
  truths.intent(api, s.writer, { type: 'set', n, s: setFor(s.writer), c: mask(lieFor(s.writer), n) });
  assert.equal(store.truths.phase, 'reveal');
  assert.equal(store.truths.lie, lie);
  const w = fakeApi([0, 1, 2]);
  truths.start(w.api);
  const wn = w.store.truths.n;
  for (const slot of [0, 1, 2]) truths.intent(w.api, slot, { type: 'set', n: wn, s: setFor(slot), c: mask(lieFor(slot), wn) });
  const gone = w.store.truths.writer;
  w.api.memory = {};
  w.api.list = [0, 1, 2].filter((x) => x !== gone);
  truths.resume(w.api);
  assert.equal(w.store.truths.phase, 'reveal', 'a writer who left takes the answer with them');
  assert.equal(w.store.truths.note, 'lost');
});
