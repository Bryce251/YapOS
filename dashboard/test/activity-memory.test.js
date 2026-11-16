import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import memory, { KEY, PADS, MAX_LEN, RESULT_MS, SURVIVOR_POINTS, stepMs, maskSeq, unmaskSeq, cleanTry, pointsFor } from '../web/activity/js/games/memory.js';
import { createMemoryView, footText, memoryMoment, litAt, PAD_PITCH } from '../web/activity/js/views/memory.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot);
}

function answer(r) {
  const s = st(r);
  return unmaskSeq(s.sq, s.k).join('');
}

function wrongOf(seq) {
  return `${(Number(seq[0]) + 1) % PADS}${seq.slice(1)}`;
}

async function startGame(n = 3, settings = {}) {
  const r = room(n, { games: [memory] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('memory'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function toInput(r) {
  await r.clock.advance(st(r).ends - r.clock.now() + 600);
  assert.equal(st(r).phase, 'input');
}

async function send(r, slot, s) {
  bySlot(r, slot).act({ type: 'try', r: st(r).r, s });
  await r.clock.advance(600);
}

test('the game is a quick game with short defaults', () => {
  assert.equal(memory.id, 'memory');
  assert.equal(memory.category, 'quick');
  assert.equal(memory.emoji, '💡');
  assert.equal(memory.minPlayers, 1);
  assert.deepEqual(memory.cards, ['swap', 'double']);
  assert.equal(memory.settings.find((s) => s.id === 'lives').default, 2);
  assert.equal(memory.settings.find((s) => s.id === 'start').default, 3);
  assert.equal(memory.settings.find((s) => s.id === 'speed').default, 'normal');
  for (const re of BANNED) assert.doesNotMatch(`${memory.name} ${memory.blurb}`, re);
});

test('helpers mask the chain, clean attempts and speed up as the chain grows', () => {
  const seq = [0, 3, 2, 1, 1, 0, 2];
  const code = maskSeq(seq, 4242);
  assert.equal(code.length, seq.length);
  assert.deepEqual(unmaskSeq(code, 4242), seq);
  assert.deepEqual(unmaskSeq(maskSeq(seq.slice(0, 3), 4242), 4242), seq.slice(0, 3), 'a longer chain keeps the same start');
  assert.equal(cleanTry('0123', 4), '0123');
  assert.equal(cleanTry('01234', 5), null);
  assert.equal(cleanTry('0123', 3), null);
  assert.equal(cleanTry('', 3), null);
  assert.ok(stepMs(10, 'normal') < stepMs(3, 'normal'));
  assert.ok(stepMs(3, 'fast') < stepMs(3, 'normal'));
  assert.equal(stepMs(MAX_LEN, 'normal'), 320);
  assert.equal(pointsFor(5, 1), 50 + 50 + 30);
  assert.equal(PAD_PITCH.length, PADS);
});

test('everyone repeats the same chain, a slip or a timeout costs a life and the chain grows by one', async () => {
  const r = await startGame(3);
  const [a, b, c] = slotsOf(r);
  let s = st(r);
  assert.equal(s.phase, 'show');
  assert.equal(s.len, 3);
  assert.equal(s.sq.length, 3);
  const first = answer(r);
  await toInput(r);
  await send(r, a, first);
  await send(r, b, wrongOf(first));
  s = st(r);
  assert.equal(s.ps[a][1], 1);
  assert.equal(s.ps[b][1], 2);
  assert.equal(s.phase, 'input');
  await r.clock.advance(s.ends - r.clock.now() + 600);
  s = st(r);
  assert.equal(s.phase, 'result');
  assert.equal(s.ps[a][0], 2);
  assert.equal(s.ps[b][0], 1);
  assert.equal(s.ps[c][0], 1, 'no answer in time costs a life');
  assert.deepEqual([...s.lost].sort(), [b, c].sort());
  assert.equal(s.gained[a], pointsFor(3, 1));
  assert.equal(r.engines[0].snapshot().scores.g[a], s.gained[a]);
  const m = memory.model(bySlot(r, b).snapshot());
  assert.equal(m.myLost, true);
  assert.match(footText(m), /cost you a life/);
  await r.clock.advance(RESULT_MS + 600);
  s = st(r);
  assert.equal(s.phase, 'show');
  assert.equal(s.len, 4);
  assert.equal(answer(r).slice(0, 3), first, 'the chain keeps its start');
  assert.ok(s.step <= stepMs(3, 'normal'));
});

test('the last one standing wins and gets the survivor bonus', async () => {
  const r = await startGame(2, { lives: 1 });
  const [a, b] = slotsOf(r);
  await toInput(r);
  const seq = answer(r);
  await send(r, a, seq);
  await send(r, b, wrongOf(seq));
  assert.equal(st(r).phase, 'result');
  assert.deepEqual(st(r).outs, [b]);
  await r.clock.advance(RESULT_MS + 600);
  assert.equal(r.hub.state.room.phase, 'results');
  assert.deepEqual(r.hub.state.room.last.winners, [a]);
  assert.equal(r.engines[0].snapshot().scores.t[a], pointsFor(3, 1) + SURVIVOR_POINTS);
});

test('a solo game keeps going until the lives run out', async () => {
  const r = await startGame(1, { lives: 1 });
  const [a] = slotsOf(r);
  for (let i = 0; i < 3; i += 1) {
    await toInput(r);
    await send(r, a, answer(r));
    assert.equal(st(r).phase, 'result');
    await r.clock.advance(RESULT_MS + 600);
  }
  assert.equal(st(r).len, 6);
  await toInput(r);
  await send(r, a, wrongOf(answer(r)));
  await r.clock.advance(RESULT_MS + 600);
  assert.equal(r.hub.state.room.phase, 'results');
});

test('a late joiner plays from the next chain with full lives', async () => {
  const r = await startGame(2);
  await toInput(r);
  const late = r.add(3);
  await r.clock.advance(800);
  const slot = late.snapshot().meSlot;
  assert.ok(st(r).wait.includes(slot));
  assert.equal(memory.model(late.snapshot()).waiting, true);
  await r.clock.advance(st(r).ends - r.clock.now() + 600);
  await r.clock.advance(RESULT_MS + 600);
  assert.equal(st(r).phase, 'show');
  assert.ok(st(r).in.includes(slot));
  assert.equal(st(r).ps[slot][0], 2);
});

test('the host leaving keeps the chain, the lives and the answers', async () => {
  const r = await startGame(3);
  const slots = slotsOf(r);
  await toInput(r);
  const seq = answer(r);
  await send(r, slots[1], seq);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  assert.equal(st(r).ps[slots[1]][1], 1);
  await send(r, slots[2], seq);
  assert.equal(st(r).phase, 'result', 'the new host settles once everyone left has answered');
  assert.equal(st(r).gained[slots[2]], pointsFor(3, 2));
});

test('state stays under the value limit with a long chain and a full room', async () => {
  const r = await startGame(16);
  const s = st(r);
  s.sq = '3'.repeat(MAX_LEN);
  s.len = MAX_LEN;
  for (let i = 0; i < 24; i += 1) s.ps[i] = [3, 2, 24, MAX_LEN];
  s.in = Object.keys(s.ps).map(Number);
  s.gained = Object.fromEntries(s.in.map((k) => [k, 999]));
  s.lost = s.in.slice();
  s.outs = s.in.slice();
  s.was = s.in.slice();
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES, `${jsonBytes(s)} bytes`);
});

test('moments and the light schedule follow the phases', () => {
  const was = memoryMoment(null, { r: 1, phase: 'show' }).now;
  assert.deepEqual(memoryMoment(was, { r: 1, phase: 'input' }).cues, ['turn']);
  const inp = memoryMoment(null, { r: 1, phase: 'input' }).now;
  assert.deepEqual(memoryMoment(inp, { r: 1, phase: 'result', myOut: true }).cues, ['lose']);
  assert.deepEqual(memoryMoment(inp, { r: 1, phase: 'result', myGain: 90 }).cues, ['correct']);
  const m = { phase: 'show', seq: [2, 0, 1], step: 500, starts: 1000 };
  assert.equal(litAt(m, 900), null);
  assert.deepEqual(litAt(m, 1100), { i: 0, pad: 2 });
  assert.equal(litAt(m, 1400), null);
  assert.deepEqual(litAt(m, 2050), { i: 2, pad: 1 });
  assert.equal(litAt(m, 2600), null);
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

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function fakeWin() {
  const due = [];
  return {
    due,
    setTimeout(fn, ms) {
      due.push({ fn, ms });
      return due.length;
    },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    run() {
      const list = due.splice(0).sort((x, y) => x.ms - y.ms);
      for (const t of list) t.fn();
    },
  };
}

test('the view lights the pads with tones, then taps send one attempt', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(2);
  const played = [];
  const win = fakeWin();
  const views = r.engines.map((engine, i) => {
    const v = createMemoryView({ engine, fx: { confetti() {} }, win: i === 0 ? win : {}, cues: { play: (n, o) => i === 0 && played.push([n, o]), burst() {}, float() {} } });
    engine.on('change', (s) => v.update(s));
    v.update(engine.snapshot());
    return v;
  });
  const el = views[0].el;
  for (const n of all(el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  const faces = all(el).filter((n) => n.classList && n.classList.contains('avatar-btn') && n.getAttribute('data-profile-id'));
  assert.equal(faces.length, 2);
  const seq = answer(r);
  assert.ok(win.due.length >= seq.length);
  win.run();
  const tones = played.filter(([n]) => n === 'tick');
  assert.ok(tones.length >= seq.length);
  assert.equal(tones[0][1].pitch, PAD_PITCH[Number(seq[0])]);
  for (let p = 0; p < PADS; p += 1) assert.equal(byKey(el, `pad-${p}`).disabled, true, 'pads stay locked while the chain plays');
  await toInput(r);
  views[0].update(r.engines[0].snapshot());
  assert.ok(played.some(([n]) => n === 'turn'));
  const me = r.engines[0].snapshot().meSlot;
  for (const ch of seq.slice(0, 2)) byKey(el, `pad-${ch}`).click();
  await r.clock.advance(600);
  assert.equal(st(r).ps[me][1], 0, 'nothing is sent until the chain is complete');
  byKey(el, `pad-${seq[2]}`).click();
  await r.clock.advance(600);
  assert.equal(st(r).ps[me][1], 1);
  assert.equal(byKey(el, 'pad-0').disabled, true);
  const other = r.engines[1].snapshot().meSlot;
  let v2key = null;
  const ev = new FakeEvent('keydown', { bubbles: true, key: String(((Number(seq[0]) + 1) % PADS) + 1) });
  const v2 = createMemoryView({ engine: r.engines[1], fx: null, win: { addEventListener: (t, fn) => (v2key = fn), removeEventListener() {} }, cues: null });
  v2.update(r.engines[1].snapshot());
  v2key(ev);
  await r.clock.advance(600);
  assert.equal(st(r).ps[other][1], 2, 'a wrong first key is sent straight away');
  assert.equal(st(r).phase, 'result');
  for (const v of views) v.destroy();
  v2.destroy();
});
