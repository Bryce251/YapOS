import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';
import typerace, { KEY as TR } from '../web/activity/js/games/typerace.js';
import memory, { KEY as MEM, PADS } from '../web/activity/js/games/memory.js';
import closest, { KEY as CG } from '../web/activity/js/games/closest.js';
import name5, { KEY as N5, SLOTS } from '../web/activity/js/games/name5.js';

const CALL_MAX = 64 * 1024;

async function start(game, settings = {}) {
  const r = room(8, { games: [game] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(game.id), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function fits(r, label) {
  assert.deepEqual(r.hub.violations, [], label);
  let total = 0;
  for (const [k, v] of Object.entries(r.hub.state)) {
    const n = jsonBytes(v);
    total += n + k.length;
    assert.ok(n <= MAX_VALUE_BYTES, `${label}: ${k} is ${n} bytes`);
  }
  assert.ok(Object.keys(r.hub.state).length <= 256, label);
  assert.ok(total <= CALL_MAX, `${label}: ${total} bytes in the call`);
}

test('Typing Race with 8 players typing at once stays inside the limits', async () => {
  const r = await start(typerace);
  const s = r.hub.state[TR];
  await r.clock.advance(s.go - r.engines[0].now() + 100);
  for (let tick = 0; tick < 40; tick += 1) {
    for (const e of r.engines) e.act({ type: 'prog', n: s.n, c: tick * 3 });
    await r.clock.advance(250);
  }
  fits(r, 'race');
  const st = r.hub.state[TR];
  assert.ok(Object.values(st.ps).every((row) => row[0] <= Math.min(s.text.length - 1, 40 * 3)));
  for (const e of r.engines) e.act({ type: 'done', n: s.n, t: s.text, ms: 9000, e: 0 });
  await r.clock.advance(2000);
  fits(r, 'show');
});

test('Memory Chain with 8 players stays inside the limits', async () => {
  const r = await start(memory);
  for (let round = 0; round < 6; round += 1) {
    const st = r.hub.state[MEM];
    if (!st) break;
    if (st.phase === 'input') {
      for (const e of r.engines) e.act({ type: 'try', r: st.r, s: String(PADS - 1).repeat(st.len) });
    }
    await r.clock.advance(3000);
  }
  fits(r, 'memory');
});

test('Closest Guess with 8 players keeps every guess off shared state until the reveal', async () => {
  const r = await start(closest);
  const st = r.hub.state[CG];
  assert.equal(st.a, null);
  r.engines.slice(0, 7).forEach((e, i) => e.act({ type: 'guess', n: st.n, v: String(123456789 + i) }));
  await r.clock.advance(500);
  const mid = r.hub.state[CG];
  assert.equal(mid.phase, 'guess');
  assert.equal(mid.answered.length, 7);
  assert.equal(JSON.stringify(r.hub.state).includes('12345678'), false);
  r.engines[7].act({ type: 'guess', n: st.n, v: '5' });
  await r.clock.advance(1000);
  assert.equal(r.hub.state[CG].phase, 'reveal');
  fits(r, 'closest');
});

test('Name 5 with 8 players, long answers and vote spam stays inside the limits', async () => {
  const r = await start(name5, { timer: 60, review: 25 });
  const s = r.hub.state[N5];
  const long = (i, c) => `${s.l}${String.fromCharCode(97 + i)}${'x'.repeat(26)}${c}`;
  r.engines.forEach((e, i) => e.act({ type: 'save', n: s.n, a: Array.from({ length: SLOTS }, (x, c) => long(i, c)), done: true }));
  await r.clock.advance(500);
  const now = r.hub.state[N5];
  assert.equal(now.phase, 'review');
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const e of r.engines) {
      for (const target of slots) for (let c = 0; c < SLOTS; c += 1) e.act({ type: 'veto', n: now.n, s: target, c, on: pass % 2 === 0 });
    }
    await r.clock.advance(1500);
  }
  fits(r, 'review');
  for (const e of r.engines) e.act({ type: 'ok', n: now.n });
  await r.clock.advance(1000);
  fits(r, 'reveal');
});
