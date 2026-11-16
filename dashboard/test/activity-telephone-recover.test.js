import test from 'node:test';
import assert from 'node:assert/strict';
import { room, seeded } from './activity-kit.test.js';
import telephone, {
  KEY,
  IN_KEY,
  RECOVER_MS,
  RESUME_MIN_MS,
  RC_CHUNK_BYTES,
  GONE_TEXT,
  inkKey,
  entryKey,
  entryInk,
  chainAt,
  seatFor,
  createKeeper,
  rcChunks,
} from '../web/activity/js/games/telephone.js';
import { fitSeat, seatBudget, encodeParts } from '../web/activity/js/games/ink.js';
import { jsonBytes, MAX_VALUE_BYTES, MAX_KEYS, MAX_STATE_BYTES } from '../web/activity/js/limits.js';

function scribble(seed, count = 40) {
  const rand = seeded(seed);
  const pts = [];
  let x = 240;
  let y = 180;
  for (let i = 0; i < count; i += 1) {
    x = Math.max(0, Math.min(480, x + Math.round((rand() - 0.5) * 140)));
    y = Math.max(0, Math.min(360, y + Math.round((rand() - 0.5) * 140)));
    pts.push([x, y]);
  }
  return pts;
}

function pageFor(k, seed, seats) {
  const strokes = [];
  for (let n = 0; n < 300; n += 1) strokes.push({ c: 1 + (n % 11), z: n % 4, pts: scribble(seed * 1000 + n) });
  const fit = fitSeat(strokes, k, 0, seatBudget(seats));
  return fit.pieces.map((s) => ({ k, g: 1, s }));
}

async function begin(n, settings = {}) {
  const r = room(n, { games: [telephone] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('telephone'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const t = { r, live: r.engines.slice(), keepers: new Map(r.engines.map((e) => [e, createKeeper()])), wrote: new Map(), drew: new Map(), seen: new Map(), phases: [], nexts: new Set(), left: new Set() };
  tick(t);
  return t;
}

function shared(t) {
  return t.r.hub.state[KEY];
}

function engineOf(t, slot) {
  return t.live.find((e) => e.snapshot().meSlot === slot) || null;
}

function checkLimits(t) {
  const state = t.r.hub.state;
  assert.ok(Object.keys(state).length <= MAX_KEYS);
  assert.ok(jsonBytes(state) <= MAX_STATE_BYTES);
  assert.deepEqual(t.r.hub.violations, []);
}

function tick(t) {
  for (const e of t.live) {
    const snap = e.snapshot();
    const k = t.keepers.get(e);
    k.observe(snap);
    const st = snap.state[KEY];
    if (st && st.phase === 'recover') k.resend(snap, e);
    if (st && st.phase === 'reveal') {
      const m = telephone.model(snap);
      const mark = m && m.reveal ? `${st.run}.${m.reveal.c}.${m.reveal.at}` : null;
      if (mark && m.reveal.canNext && !m.reveal.early && !t.nexts.has(mark)) {
        t.nexts.add(mark);
        e.act({ type: 'next', c: m.reveal.c, at: m.reveal.at });
      }
    }
  }
  const st = shared(t);
  if (!st) return;
  if (t.phases[t.phases.length - 1] !== st.phase) t.phases.push(st.phase);
  if (st.phase === 'reveal' && st.rv) {
    const state = t.r.hub.state;
    for (let i = 0; i <= st.rv.at; i += 1) {
      const e = state[entryKey(i)];
      if (!e || e.c !== st.rv.c || e.i !== i) continue;
      t.seen.set(`${e.c}.${i}`, { k: e.k, by: e.by, t: e.t, gone: Boolean(e.gone), miss: Boolean(e.miss), hid: Boolean(e.hid), strokes: e.k === 'd' ? entryInk(state, i).length : 0 });
    }
  }
}

async function run(t, ms, step = 100) {
  for (let left = ms; left > 0; left -= step) {
    await t.r.clock.advance(Math.min(step, left));
    tick(t);
  }
}

async function until(t, test, limit = 30000, step = 50) {
  for (let left = limit; left > 0 && !test(); left -= step) {
    await t.r.clock.advance(step);
    tick(t);
  }
  assert.equal(Boolean(test()), true);
}

function seated(t) {
  const st = shared(t);
  return st.seats.map((slot, seat) => ({ seat, slot, e: engineOf(t, slot) })).filter((x) => x.e);
}

async function writeStep(t, skip = []) {
  const st = shared(t);
  assert.ok(st.phase === 'write' || st.phase === 'text', st.phase);
  const n = st.seats.length;
  for (const { seat, slot, e } of seated(t)) {
    if (skip.includes(seat)) continue;
    const text = `Silly phrase ${slot} at ${st.step}`;
    t.wrote.set(`${chainAt(seat, st.step, n)}.${st.step}`, { slot, text });
    t.keepers.get(e).act(e, e.snapshot(), { type: 'text', step: st.step, text });
  }
  await run(t, 400);
}

async function drawStep(t, { skip = [], partial = [], done = true } = {}) {
  const st = shared(t);
  assert.equal(st.phase, 'draw');
  const n = st.seats.length;
  const want = [];
  await until(t, () => t.live.every((e) => (e.snapshot().state[KEY] || {}).k === st.k));
  for (const { seat, slot, e } of seated(t)) {
    if (skip.includes(seat)) continue;
    const page = pageFor(st.k, slot * 31 + st.step, n);
    const take = partial.includes(seat) ? page.slice(0, 1) : page;
    take.forEach((v, i) => {
      assert.equal(e.direct(inkKey(seat, i), v), true);
      want.push([inkKey(seat, i), JSON.stringify(v)]);
    });
    t.drew.set(`${chainAt(seat, st.step, n)}.${st.step}`, { slot, page, strokes: page.reduce((a, v) => a + v.s.length, 0) });
  }
  await until(t, () => want.every(([key, v]) => JSON.stringify(t.r.hub.state[key]) === v));
  if (done) {
    for (const { seat, e } of seated(t)) if (!skip.includes(seat) && !partial.includes(seat)) e.act({ type: 'done', step: st.step });
  }
  await run(t, 400);
  if (done && !skip.length && !partial.length) await until(t, () => shared(t).phase !== 'draw' || shared(t).step !== st.step || shared(t).run !== st.run, 5000);
}

async function finishDraw(t, seat) {
  const st = shared(t);
  const n = st.seats.length;
  const key = `${chainAt(seat, st.step, n)}.${st.step}`;
  const d = t.drew.get(key);
  const e = engineOf(t, st.seats[seat]);
  d.page.forEach((v, i) => assert.equal(e.direct(inkKey(seat, i), v), true));
  await until(t, () => d.page.every((v, i) => JSON.stringify(t.r.hub.state[inkKey(seat, i)]) === JSON.stringify(v)));
  e.act({ type: 'done', step: st.step });
  await run(t, 400);
}

async function hostLeaves(t) {
  const host = t.live.find((e) => e.isHost());
  const slot = host.snapshot().meSlot;
  t.left.add(slot);
  t.r.hub.leave(host.snapshot().me);
  host.destroy();
  t.live = t.live.filter((e) => e !== host);
  return slot;
}

async function playerLeaves(t, slot) {
  const e = engineOf(t, slot);
  t.left.add(slot);
  t.r.hub.leave(e.snapshot().me);
  e.destroy();
  t.live = t.live.filter((x) => x !== e);
}

async function recovered(t, was) {
  await until(t, () => shared(t).phase === 'recover', 3000, 10);
  assert.equal(shared(t).was, was);
  await until(t, () => shared(t).phase !== 'recover', RECOVER_MS + 2000, 50);
}

async function playOut(t) {
  for (let guard = 0; guard < 40; guard += 1) {
    const st = shared(t);
    const room = t.live[0].snapshot().room;
    if (room.phase !== 'game' || !st) return;
    if (st.phase === 'write' || st.phase === 'text') await writeStep(t);
    else if (st.phase === 'draw') await drawStep(t);
    else break;
  }
  await until(t, () => t.live[0].snapshot().room.phase === 'results', 600000, 500);
}

function checkReveal(t) {
  const st = shared(t) || {};
  let gone = 0;
  for (const [key, e] of t.seen) {
    const wrote = t.wrote.get(key);
    const drew = t.drew.get(key);
    const away = !Number.isInteger(e.by) || t.left.has(e.by);
    if (e.gone) {
      gone += 1;
      assert.ok(away, `${key} is marked gone but its author is here`);
      continue;
    }
    if (wrote && !t.left.has(wrote.slot)) {
      assert.equal(e.by, wrote.slot, key);
      assert.equal(e.t, wrote.text, key);
    }
    if (drew && !t.left.has(drew.slot) && !e.hid) {
      assert.equal(e.by, drew.slot, key);
      assert.equal(e.strokes, drew.strokes, key);
    }
  }
  assert.ok(st);
  return gone;
}

test('3 players: the host leaves during a text step, the chains come back and the game finishes', async () => {
  const t = await begin(3);
  await writeStep(t);
  await drawStep(t);
  assert.equal(shared(t).phase, 'text');
  const st = shared(t);
  const n = st.seats.length;
  const hostSeat = st.seats.indexOf(t.live[0].snapshot().meSlot);
  await writeStep(t, [hostSeat]);
  const doneBefore = shared(t).done.slice().sort();
  const hostSlot = await hostLeaves(t);
  await recovered(t, 'text');
  assert.ok(t.phases.includes('recover'));
  await until(t, () => shared(t).phase === 'reveal', 20000);
  assert.equal(doneBefore.length, 2);
  await until(t, () => t.live[0].snapshot().room.phase === 'results', 600000, 500);
  assert.equal(t.seen.size, n * 3);
  const gone = checkReveal(t);
  assert.ok(gone >= 1);
  assert.equal(t.seen.get(`${hostSeat}.0`).gone, true);
  assert.equal(t.seen.get(`${chainAt(hostSeat, 2, n)}.2`).miss, true);
  const d = t.seen.get(`${chainAt(hostSeat, 1, n)}.1`);
  assert.equal(d.by, hostSlot);
  assert.equal(d.gone, false);
  assert.ok(d.strokes > 0);
  checkLimits(t);
});

test('3 players: done answers survive a host change in the middle of a text step', async () => {
  const t = await begin(3);
  await writeStep(t);
  await drawStep(t);
  const st = shared(t);
  const hostSeat = st.seats.indexOf(t.live[0].snapshot().meSlot);
  const others = [0, 1, 2].filter((p) => p !== hostSeat);
  await writeStep(t, [hostSeat, others[1]]);
  await hostLeaves(t);
  await recovered(t, 'text');
  const now = shared(t);
  assert.equal(now.phase, 'text');
  assert.equal(now.step, 2);
  assert.deepEqual(now.done, [others[0]]);
  assert.ok(now.ends - t.live[0].snapshot().now >= RESUME_MIN_MS - 500);
  await writeStep(t);
  await until(t, () => shared(t).phase === 'reveal');
  await until(t, () => t.live[0].snapshot().room.phase === 'results', 600000, 500);
  checkReveal(t);
  checkLimits(t);
});

test('8 players: the host leaves mid-drawing with a page half saved, and the big pages come back in pieces', async () => {
  const t = await begin(8);
  await writeStep(t);
  await drawStep(t);
  await writeStep(t);
  const st = shared(t);
  assert.equal(st.phase, 'draw');
  assert.equal(st.step, 3);
  const hostSeat = st.seats.indexOf(t.live[0].snapshot().meSlot);
  const half = (hostSeat + 2) % 8;
  const idle = (hostSeat + 3) % 8;
  assert.ok(t.drew.get(`${chainAt(half, 3, 8)}.3`) === undefined);
  await drawStep(t, { partial: [half], skip: [idle] });
  const page = t.drew.get(`${chainAt(half, 3, 8)}.3`).page;
  assert.ok(page.length >= 2);
  const doneBefore = shared(t).done.slice().sort();
  const from = t.r.clock.now();
  await hostLeaves(t);
  await recovered(t, 'draw');
  const now = shared(t);
  assert.equal(now.phase, 'draw');
  assert.equal(now.step, 3);
  assert.equal(now.k, st.k);
  assert.deepEqual(now.done.slice().sort(), doneBefore);
  assert.ok(t.r.hub.state[IN_KEY]);
  for (let p = 0; p < 8; p += 1) {
    const sent = t.keepers.get(engineOf(t, now.seats[p]) || t.live[0]);
    assert.ok(sent.size <= 10);
  }
  await finishDraw(t, half);
  const slot = now.seats[idle];
  const e = engineOf(t, slot);
  const page2 = pageFor(now.k, 999, 8);
  page2.forEach((v, i) => assert.equal(e.direct(inkKey(idle, i), v), true));
  t.drew.set(`${chainAt(idle, 3, 8)}.3`, { slot, page: page2, strokes: page2.reduce((a, v) => a + v.s.length, 0) });
  await run(t, 600);
  e.act({ type: 'done', step: 3 });
  await until(t, () => shared(t).phase === 'text' && shared(t).step === 4, 20000);
  await playOut(t);
  assert.equal(t.seen.size, 64);
  const gone = checkReveal(t);
  assert.ok(gone >= 2);
  assert.equal(t.seen.get(`${hostSeat}.0`).gone, true);
  assert.equal(t.seen.get(`${chainAt(hostSeat, 1, 8)}.1`).gone, true);
  assert.equal(t.seen.get(`${chainAt(hostSeat, 2, 8)}.2`).gone, false);
  assert.equal(t.seen.get(`${chainAt(half, 3, 8)}.3`).strokes, page.reduce((a, v) => a + v.s.length, 0));
  for (let c = 0; c < 8; c += 1) {
    const d = t.seen.get(`${c}.1`);
    if (d.by !== now.seats[seatFor(c, 1, 8)] || t.left.has(d.by)) continue;
    assert.equal(d.strokes, t.drew.get(`${c}.1`).strokes);
  }
  for (const p of t.live) assert.ok(t.r.hub.opsBy(p.snapshot().me, from, from + 10000) <= 100);
  checkLimits(t);
});

test('4 players: the host leaves during the reveal and the reveal picks up where it was', async () => {
  const t = await begin(4);
  await writeStep(t);
  await drawStep(t);
  await writeStep(t);
  await drawStep(t);
  await until(t, () => shared(t).phase === 'reveal' && shared(t).rv.pos === 1 && shared(t).rv.at === 1, 120000, 100);
  const before = shared(t).rv;
  const rx = shared(t).rx;
  await hostLeaves(t);
  await recovered(t, 'reveal');
  const after = shared(t);
  assert.equal(after.phase, 'reveal');
  assert.equal(after.rv.c, before.c);
  assert.equal(after.rv.pos, before.pos);
  assert.ok(after.rv.at >= before.at);
  assert.deepEqual(after.rx.slice(0, rx.length), rx);
  await until(t, () => t.live[0].snapshot().room.phase === 'results', 600000, 500);
  assert.equal(t.seen.size, 16);
  const gone = checkReveal(t);
  assert.ok(gone >= 2);
  assert.ok(t.phases.includes('awards'));
  checkLimits(t);
});

test('5 players: the host leaves, then the next host leaves during the reconnect, and the game still goes on', async () => {
  const t = await begin(5);
  await writeStep(t);
  await drawStep(t);
  await writeStep(t, [0]);
  assert.equal(shared(t).phase, 'text');
  await hostLeaves(t);
  await until(t, () => shared(t).phase === 'recover', 3000, 10);
  const rk = shared(t).rk;
  await hostLeaves(t);
  await until(t, () => shared(t).phase === 'recover' && shared(t).rk !== rk, 3000, 10);
  await until(t, () => shared(t).phase !== 'recover', RECOVER_MS + 2000);
  assert.ok(['text', 'draw'].includes(shared(t).phase));
  assert.ok(shared(t).step >= 2);
  await playOut(t);
  assert.equal(t.seen.size, 25);
  const gone = checkReveal(t);
  assert.ok(gone >= 2);
  checkLimits(t);
});

test('5 players: someone who left earlier becomes a gentle placeholder after the host leaves', async () => {
  const t = await begin(5);
  await writeStep(t);
  const st = shared(t);
  const hostSlot = t.live[0].snapshot().meSlot;
  const quitter = st.seats.find((s) => s !== hostSlot);
  const quitSeat = st.seats.indexOf(quitter);
  await playerLeaves(t, quitter);
  await run(t, 400);
  await drawStep(t);
  await until(t, () => shared(t).phase === 'text');
  await writeStep(t);
  await drawStep(t);
  assert.equal(shared(t).phase, 'text');
  assert.equal(shared(t).step, 4);
  await hostLeaves(t);
  await recovered(t, 'text');
  await playOut(t);
  const gone = checkReveal(t);
  assert.ok(gone >= 3);
  const first = t.seen.get(`${quitSeat}.0`);
  assert.equal(first.gone, true);
  assert.equal(first.by, quitter);
  const m = telephone.model({ ...t.live[0].snapshot(), state: { [KEY]: { ...shared(t), phase: 'reveal', rv: { c: quitSeat, at: 0, pos: 0, total: 5, len: 5, owner: quitter }, rx: [[0, 0, 0, 0, 0]] }, [entryKey(0)]: { c: quitSeat, i: 0, k: 'w', by: quitter, t: 'x', miss: 1, gone: 1 } } });
  assert.equal(m.reveal.entries[0].t, GONE_TEXT);
  assert.equal(m.reveal.entries[0].gone, true);
  checkLimits(t);
});

test('a forged resend for another seat, the wrong run, too much text or bad ink is ignored', async () => {
  const t = await begin(4);
  await writeStep(t);
  await drawStep(t);
  const st = shared(t);
  const n = st.seats.length;
  const hostSlot = t.live[0].snapshot().meSlot;
  const [bad, good] = t.live.filter((e) => e.snapshot().meSlot !== hostSlot);
  const badSeat = st.seats.indexOf(bad.snapshot().meSlot);
  const goodSeat = st.seats.indexOf(good.snapshot().meSlot);
  const goodKeeper = t.keepers.get(good);
  const badKeeper = t.keepers.get(bad);
  t.keepers.set(good, { observe: goodKeeper.observe, resend() {}, act: goodKeeper.act });
  t.keepers.set(bad, { observe() {}, resend() {}, act: badKeeper.act });
  await hostLeaves(t);
  await until(t, () => shared(t).phase === 'recover', 3000, 10);
  const rs = shared(t);
  const base = { type: 'rc', run: rs.run, r: rs.rk };
  const goodChain = chainAt(goodSeat, 0, n);
  const ownChain = chainAt(badSeat, 0, n);
  const strokes = encodeParts({ c: 3, z: 1, pts: scribble(5, 30) });
  const fat = [];
  while (jsonBytes(fat) <= RC_CHUNK_BYTES + 200) fat.push(...encodeParts({ c: 4, z: 2, pts: scribble(fat.length + 9, 60) }));
  const forged = [
    { ...base, c: goodChain, i: 0, t: 'FORGED other seat' },
    { ...base, run: rs.run + 1, c: ownChain, i: 0, t: 'FORGED wrong run' },
    { ...base, r: rs.rk + 1, c: ownChain, i: 0, t: 'FORGED wrong round' },
    { ...base, c: ownChain, i: 0, t: `FORGED ${'x'.repeat(300)}` },
    { ...base, c: chainAt(badSeat, 2, n), i: 2, t: 'FORGED future' },
    { ...base, c: chainAt(goodSeat, 1, n), i: 1, j: 0, n: 1, s: strokes },
    { ...base, c: chainAt(badSeat, 1, n), i: 1, j: 0, n: 1, s: ['@@not ink@@'] },
    { ...base, c: chainAt(badSeat, 1, n), i: 1, j: 0, n: 99, s: strokes },
    { ...base, c: 99, i: 0, t: 'FORGED bad chain' },
  ];
  assert.ok(jsonBytes({ t: 'g', g: 'telephone', a: { ...base, c: 0, i: 1, j: 0, n: 1, s: fat } }) < MAX_VALUE_BYTES);
  forged.push({ ...base, c: chainAt(badSeat, 1, n), i: 1, j: 0, n: 1, s: fat });
  for (const a of forged) bad.act(a);
  bad.act({ type: 'rc', ...base, c: ownChain, i: 0, t: t.wrote.get(`${ownChain}.0`).text });
  await run(t, 300);
  t.keepers.set(good, goodKeeper);
  goodKeeper.resend(good.snapshot(), good);
  await until(t, () => shared(t).phase !== 'recover', RECOVER_MS + 2000);
  assert.equal(shared(t).phase, 'text');
  t.keepers.set(bad, badKeeper);
  await playOut(t);
  const all = JSON.stringify([...t.seen.values()]);
  assert.equal(all.includes('FORGED'), false);
  assert.equal(t.seen.get(`${goodChain}.0`).t, t.wrote.get(`${goodChain}.0`).text);
  assert.equal(t.seen.get(`${ownChain}.0`).t, t.wrote.get(`${ownChain}.0`).text);
  const d = t.seen.get(`${chainAt(goodSeat, 1, n)}.1`);
  assert.equal(d.by, good.snapshot().meSlot);
  assert.equal(d.strokes, t.drew.get(`${chainAt(goodSeat, 1, n)}.1`).strokes);
  checkLimits(t);
});

test('resend pieces always fit one message and drawings hidden after a report stay hidden', async () => {
  const parts = pageFor(7, 3, 3).flatMap((v) => v.s);
  const pieces = rcChunks(parts);
  assert.ok(pieces.length >= 3);
  assert.deepEqual(pieces.flat(), parts);
  for (const s of pieces) {
    assert.ok(jsonBytes(s) <= RC_CHUNK_BYTES);
    assert.ok(jsonBytes({ t: 'g', g: 'telephone', a: { type: 'rc', run: 999999999, r: 65534, c: 9, i: 7, j: 15, n: 16, s } }) <= MAX_VALUE_BYTES);
  }
  const t = await begin(4);
  await writeStep(t);
  await drawStep(t);
  const st = shared(t);
  assert.equal(st.phase, 'text');
  const n = st.seats.length;
  const hostSlot = t.live[0].snapshot().meSlot;
  const hostSeat = st.seats.indexOf(hostSlot);
  const seat = (hostSeat + 1) % n;
  const viewer = engineOf(t, st.seats[(seat + 1) % n]);
  const d = `tel.${st.run}.${chainAt(seat, 1, n)}.1`;
  assert.equal(viewer.flag(d), true);
  await until(t, () => (shared(t).hid || []).includes(d), 3000, 50);
  await hostLeaves(t);
  await until(t, () => shared(t).phase === 'recover', 3000, 10);
  assert.ok(shared(t).hid.includes(d));
  await until(t, () => shared(t).phase !== 'recover', RECOVER_MS + 2000);
  assert.equal(shared(t).phase, 'text');
  await playOut(t);
  const e = t.seen.get(`${chainAt(seat, 1, n)}.1`);
  assert.equal(e.hid, true);
  assert.equal(e.strokes, 0);
  checkLimits(t);
});
