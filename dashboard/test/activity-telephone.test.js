import test from 'node:test';
import assert from 'node:assert/strict';
import { room, person, seeded } from './activity-kit.test.js';
import { installDom, FakeEvent } from './dom-shim.js';
import { configureAdmins, resetAdmins, refreshAdmins } from '../web/activity/js/admin.js';
import telephone, {
  KEY,
  IN_KEY,
  INK_PREFIX,
  ENTRY_PREFIX,
  INK_CHARS,
  INK_PARTS,
  TEXT_MAX,
  TEXT_BYTES,
  GRACE_MS,
  SETTLE_MS,
  AWARDS_MS,
  LOST_MS,
  END_SHOW_MS,
  NEXT_MIN_MS,
  REACT_POINTS,
  AWARD_POINTS,
  MAX_SEATS,
  REACTS,
  conceal,
  uncover,
  fitText,
  kindOf,
  stepsFor,
  chainAt,
  inkKey,
  entryKey,
  inkChars,
  validInk,
  likeness,
  pickAwards,
} from '../web/activity/js/games/telephone.js';
import { createTelephoneView, fitStroke, footText, telephoneMoments } from '../web/activity/js/views/telephone.js';
import { GRID_W, GRID_H, paintInk, decodeStroke, encodeParts } from '../web/activity/js/games/ink.js';
import { STARTERS, starterById } from '../web/activity/data/telephone.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';
import { readFileSync } from 'node:fs';

const GAMES = [telephone];
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];
const ROOT = new URL('../web/activity/', import.meta.url);

async function start(n = 3, settings = {}) {
  const r = room(n, { games: GAMES });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('telephone'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

function st(r, i = 0) {
  return r.engines[i].snapshot().state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function seatEngine(r, seat) {
  return bySlot(r, st(r).seats[seat]);
}

function scribble(seed, count = 50) {
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

function bigInk(k, seed = 1) {
  let used = 0;
  const parts = [];
  for (let n = 0; n < 400; n += 1) {
    const fit = fitStroke({ c: 1 + (n % 11), z: n % 4, pts: scribble(seed * 1000 + n) }, used, parts.length);
    if (!fit) break;
    parts.push(...fit.parts);
    used += inkChars(fit.parts);
    if (fit.cut) break;
  }
  return { k, s: parts };
}

function smallInk(k, seed = 1) {
  const fit = fitStroke({ c: 3, z: 1, pts: scribble(seed, 8) }, 0, 0);
  return { k, s: fit.parts };
}

async function writeAll(r, texts) {
  const s = st(r);
  s.seats.forEach((slot, seat) => {
    const e = bySlot(r, slot);
    if (texts[seat] === null) return;
    e.act({ type: 'text', step: s.step, text: texts[seat] });
  });
  await r.clock.advance(500);
}

async function drawAll(r, make = smallInk) {
  const s = st(r);
  assert.equal(s.phase, 'draw');
  s.seats.forEach((slot, seat) => {
    const e = bySlot(r, slot);
    assert.equal(e.direct(inkKey(seat), make(s.k, seat + 1)), true, `seat ${seat} can draw`);
  });
  await r.clock.advance(400);
  s.seats.forEach((slot) => bySlot(r, slot).act({ type: 'done', step: s.step }));
  await r.clock.advance(400);
}

function stateText(r) {
  return JSON.stringify(r.hub.state).toLowerCase();
}

function checkLimits(r) {
  const keys = Object.keys(r.hub.state);
  assert.ok(keys.length <= 256, `keys ${keys.length}`);
  for (const k of keys) assert.ok(jsonBytes(r.hub.state[k]) <= MAX_VALUE_BYTES, `${k} is ${jsonBytes(r.hub.state[k])} bytes`);
  let total = 0;
  for (const k of keys) total += k.length + jsonBytes(r.hub.state[k]);
  assert.ok(total <= 65536, `state is ${total} bytes`);
  return total;
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

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

function noInlineStyle(root) {
  for (const el of all(root)) assert.equal(el.getAttribute('style'), null, `${el.localName}.${el.className} has a style attribute`);
}

function pointer(type, x, y) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = 1;
  return e;
}

test('the game is registered as a drawing game for 3 to 10 players with fair settings', () => {
  assert.equal(telephone.id, 'telephone');
  assert.equal(telephone.name, 'Draw Telephone');
  assert.equal(telephone.emoji, '☎️');
  assert.equal(telephone.category, 'drawing');
  assert.equal(telephone.minPlayers, 3);
  assert.equal(telephone.maxPlayers, 10);
  const write = telephone.settings.find((s) => s.id === 'write');
  const draw = telephone.settings.find((s) => s.id === 'draw');
  assert.equal(write.default, 40);
  assert.equal(draw.default, 70);
  for (const re of BANNED) assert.equal(re.test(telephone.blurb), false);
});

test('there are about 120 original, unique, family friendly starter phrases', () => {
  assert.ok(STARTERS.length >= 110 && STARTERS.length <= 140, `${STARTERS.length}`);
  const seen = new Set();
  for (const s of STARTERS) {
    assert.ok(Number.isInteger(s.id));
    assert.equal(starterById(s.id), s);
    assert.ok(s.text.length >= 8 && s.text.length <= 48, s.text);
    assert.equal(fitText(s.text), s.text);
    assert.ok(!seen.has(s.text.toLowerCase()), s.text);
    seen.add(s.text.toLowerCase());
    assert.doesNotMatch(s.text, /\b(kill|blood|gun|war|god|church|president|beer|wine|drunk|sexy|stupid)\b/i, s.text);
  }
});

test('helpers hide text, cap length and bytes, and rotate the chains fairly', () => {
  const phrase = 'A penguin opening a bakery 🥐';
  const code = conceal(phrase, 1234);
  assert.notEqual(code, phrase);
  assert.equal(code.toLowerCase().includes('penguin'), false);
  assert.equal(uncover(code, 1234), phrase);
  assert.notEqual(uncover(code, 999), phrase);
  assert.equal(uncover('!!!', 1), '');
  assert.equal(fitText('  hi\u0000 there  https://x.example/y '), 'hi there 🔗');
  assert.equal(Array.from(fitText('a'.repeat(200))).length, TEXT_MAX);
  assert.ok(new TextEncoder().encode(fitText('🐧'.repeat(80))).length <= TEXT_BYTES);
  assert.deepEqual([0, 1, 2, 3, 4].map(kindOf), ['write', 'draw', 'text', 'draw', 'text']);
  assert.equal(stepsFor(3), 3);
  assert.equal(stepsFor(10), 8);
  for (const n of [3, 5, 10]) {
    for (let step = 0; step < stepsFor(n); step += 1) {
      const chains = new Set();
      for (let seat = 0; seat < n; seat += 1) chains.add(chainAt(seat, step, n));
      assert.equal(chains.size, n, 'every chain is worked on once per step');
    }
    for (let c = 0; c < n; c += 1) {
      const touched = new Set();
      for (let step = 0; step < stepsFor(n); step += 1) for (let seat = 0; seat < n; seat += 1) if (chainAt(seat, step, n) === c) touched.add(seat);
      assert.equal(touched.size, stepsFor(n), 'nobody works on the same chain twice');
    }
  }
  assert.ok(likeness('A cat on a boat', 'a cat in a boat') > 0.5);
  assert.equal(likeness('A cat on a boat', 'Volcano party'), 0);
});

test('the ink budget is tight enough that every drawing fits in one value', () => {
  const ink = bigInk(77, 3);
  assert.ok(inkChars(ink.s) > INK_CHARS * 0.9, `${inkChars(ink.s)}`);
  assert.ok(inkChars(ink.s) <= INK_CHARS);
  assert.equal(validInk(ink, 77), true);
  assert.equal(validInk(ink, 78), false);
  assert.ok(jsonBytes(ink) < MAX_VALUE_BYTES);
  assert.equal(fitStroke({ c: 1, z: 1, pts: scribble(9, 40) }, INK_CHARS, 0), null);
  assert.equal(validInk({ k: 1, s: ['x'.repeat(INK_CHARS + 1)] }, 1), false);
});

test('a full game: write, draw, describe, reveal with reactions, awards and results', async () => {
  const r = await start(3);
  const [host, a, b] = r.engines;
  let s = st(r);
  assert.equal(s.phase, 'write');
  assert.equal(s.steps, 3);
  assert.deepEqual(s.seats, [0, 1, 2]);
  const m0 = telephone.model(a.snapshot());
  assert.equal(m0.sugs.length, 3);
  for (const sug of STARTERS) assert.equal(stateText(r).includes(sug.text.toLowerCase()), false, 'suggestions are hidden');
  host.act({ type: 'text', step: 0, text: 'A whale juggling pancakes' });
  a.act({ type: 'pick', step: 0, i: 1 });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'write');
  assert.deepEqual(s.done.sort(), [0, 1]);
  const picked = telephone.model(a.snapshot()).sugs[1].text;
  b.act({ type: 'text', step: 0, text: 'A robot baking bread' });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.step, 1);
  const prompts = [0, 1, 2].map((seat) => telephone.model(seatEngine(r, seat).snapshot()).prompt);
  assert.deepEqual(prompts, ['A robot baking bread', 'A whale juggling pancakes', picked]);
  for (const p of ['whale juggling', 'robot baking', picked.toLowerCase()]) assert.equal(stateText(r).includes(p), false, `${p} stays hidden`);
  assert.equal(a.direct(inkKey(0), smallInk(s.k)), false, 'nobody can draw on another seat');
  await drawAll(r);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.pass, 1);
  await r.clock.advance(SETTLE_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'text');
  assert.equal(r.hub.state[IN_KEY], undefined);
  const mb = telephone.model(b.snapshot());
  assert.equal(mb.src.key, inkKey(1));
  assert.equal(mb.src.blank, false);
  assert.equal(validInk(r.hub.state[inkKey(1)], s.dk), true, 'the drawings stay in state to be described');
  host.act({ type: 'text', step: 2, text: 'Fish flipping waffles' });
  a.act({ type: 'text', step: 2, text: 'A toaster with arms' });
  b.act({ type: 'text', step: 2, text: 'Something with a crown' });
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(Object.keys(r.hub.state).some((k) => k.startsWith(INK_PREFIX)), false, 'step keys are cleared');
  assert.equal(r.hub.state[IN_KEY], undefined);
  const e0 = r.hub.state[entryKey(0)];
  assert.equal(e0.t, 'A whale juggling pancakes');
  assert.equal(e0.by, 0);
  assert.equal(r.hub.state[entryKey(1)], undefined, 'entries appear one at a time');
  a.act({ type: 'react', c: 0, i: 0, e: 0 });
  a.act({ type: 'react', c: 0, i: 0, e: 0 });
  b.act({ type: 'react', c: 0, i: 0, e: 1 });
  host.act({ type: 'react', c: 0, i: 0, e: 2 });
  await r.clock.advance(400);
  s = st(r);
  assert.deepEqual(s.rx[0], [1, 1, 0, 0, 0], 'one of each reaction per person, none on your own entry');
  assert.equal(host.snapshot().scores.g[0], 2 * REACT_POINTS);
  a.act({ type: 'next', c: 0, at: 0 });
  await r.clock.advance(NEXT_MIN_MS + 200);
  assert.equal(st(r).rv.at, 0, 'only the chain starter taps Next');
  host.act({ type: 'next', c: 0, at: 0 });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.rv.at, 1);
  assert.equal(r.hub.state[entryKey(1)].k, 'd');
  assert.equal(r.hub.state[entryKey(1)].by, 1);
  b.act({ type: 'react', c: 0, i: 1, e: 1 });
  await r.clock.advance(NEXT_MIN_MS + 200);
  host.act({ type: 'next', c: 0, at: 1 });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.rv.at, 2);
  assert.equal(r.hub.state[entryKey(2)].t, 'Something with a crown');
  const mm = telephone.model(host.snapshot());
  assert.equal(mm.reveal.last, true);
  assert.equal(mm.reveal.entries.length, 3);
  for (let i = 0; i < 12 && st(r).phase === 'reveal'; i += 1) await r.clock.advance(END_SHOW_MS + 100);
  s = st(r);
  assert.equal(s.phase, 'awards');
  assert.ok(s.aw.length >= 2, JSON.stringify(s.aw));
  const fav = s.aw.find((x) => x.id === 'fav');
  assert.equal(fav.slot, 0);
  const awarded = new Set(s.aw.map((x) => x.slot));
  assert.equal(awarded.size, s.aw.length, 'awards go to different people');
  const pts = host.snapshot().scores.g;
  assert.equal(pts[0], 2 * REACT_POINTS + AWARD_POINTS * s.aw.filter((x) => x.slot === 0).length);
  assert.equal(pts[1], REACT_POINTS + AWARD_POINTS * s.aw.filter((x) => x.slot === 1).length);
  await r.clock.advance(AWARDS_MS + 300);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [0]);
  assert.equal(Object.keys(r.hub.state).some((k) => k.startsWith('tel.')), false, 'the game cleans up after itself');
  assert.deepEqual(r.hub.violations, []);
});

test('when nobody does anything the timers keep the game moving and fill the gaps', async () => {
  const r = await start(4, { write: 30, draw: 50 });
  let s = st(r);
  assert.equal(s.steps, 4);
  const firstSugs = s.seats.map((slot) => telephone.model(bySlot(r, slot).snapshot()).sugs[0].text);
  await r.clock.advance(30000 + GRACE_MS + 300);
  s = st(r);
  assert.equal(s.phase, 'draw');
  for (let seat = 0; seat < 4; seat += 1) {
    const chain = chainAt(seat, 1, 4);
    assert.equal(telephone.model(seatEngine(r, seat).snapshot()).prompt, firstSugs[chain], 'an idle writer gets their first suggestion');
  }
  await r.clock.advance(50000 + GRACE_MS + 300);
  s = st(r);
  assert.equal(s.phase, 'text');
  assert.equal(telephone.model(seatEngine(r, 2).snapshot()).src.blank, true, 'an empty page is passed on as blank');
  await r.clock.advance(30000 + GRACE_MS + 300);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.step, 3);
  for (let seat = 0; seat < 4; seat += 1) {
    assert.equal(telephone.model(seatEngine(r, seat).snapshot()).prompt, firstSugs[chainAt(seat, 3, 4)], 'a missing description carries the last phrase forward');
  }
  await r.clock.advance(50000 + GRACE_MS + 300);
  s = st(r);
  assert.equal(s.phase, 'reveal');
  const first = r.hub.state[entryKey(0)];
  assert.equal(first.miss, 1);
  for (let i = 0; i < 40 && st(r) && st(r).phase === 'reveal'; i += 1) await r.clock.advance(END_SHOW_MS + 100);
  assert.equal(st(r).phase, 'awards');
  await r.clock.advance(AWARDS_MS + 300);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('late joiners wait, then take over the seat of someone who leaves', async () => {
  const r = await start(3);
  const late = r.add(4);
  await r.clock.advance(800);
  let s = st(r);
  const lateSlot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(lateSlot));
  assert.deepEqual(s.wait, [lateSlot]);
  let m = telephone.model(late.snapshot());
  assert.equal(m.playing, false);
  assert.equal(m.waiting, true);
  assert.match(footText(m, false), /seat/);
  r.engines[0].act({ type: 'text', step: 0, text: 'A cat on a cloud' });
  r.engines[1].act({ type: 'text', step: 0, text: 'A dog on a log' });
  await r.clock.advance(400);
  r.hub.leave(person(3).id);
  await r.clock.advance(800);
  s = st(r);
  assert.equal(s.seats[2], lateSlot, 'the late joiner takes the empty seat');
  assert.deepEqual(s.wait, []);
  m = telephone.model(late.snapshot());
  assert.equal(m.playing, true);
  assert.equal(m.sugs.length, 3);
  late.act({ type: 'text', step: 0, text: 'A frog in a hat' });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(telephone.model(late.snapshot()).prompt, 'A dog on a log');
  assert.deepEqual(r.hub.violations, []);
});

test('if too many people leave early, the game ends kindly', async () => {
  const r = await start(3);
  r.hub.leave(person(2).id);
  r.hub.leave(person(3).id);
  await r.clock.advance(600);
  const s = st(r);
  assert.equal(s.phase, 'lost');
  assert.equal(s.note, 'few');
  await r.clock.advance(LOST_MS + 300);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
});

test('admins can skip a step or add time', async () => {
  resetAdmins();
  configureAdmins({
    fetch: async (url) => {
      const ids = new URL(url, 'https://yapos.dev').searchParams.get('ids').split(',');
      return { ok: true, status: 200, json: async () => ({ admins: ids, owner: null }) };
    },
    refreshMs: 0,
    win: null,
  });
  const r = await start(3);
  await refreshAdmins(r.engines.map((e) => e.snapshot().me));
  await r.clock.advance(200);
  const host = r.engines[0];
  let s = st(r);
  const ends = s.ends;
  assert.equal(r.engines[1].admin.run({ type: 'time', ms: 20000 }), true);
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.ends, ends + 20000);
  assert.equal(host.snapshot().room.deadline, s.ends + GRACE_MS);
  assert.equal(host.admin.run({ type: 'skip' }), true);
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(host.admin.run({ type: 'time', ms: -600000 }), true);
  await r.clock.advance(400);
  assert.ok(st(r).ends - host.snapshot().now <= 3500);
  assert.equal(host.admin.run({ type: 'skip' }), true);
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'text');
  host.admin.run({ type: 'skip' });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'reveal');
  host.admin.run({ type: 'skip' });
  await r.clock.advance(400);
  assert.equal(st(r).rv.at, 1);
  resetAdmins();
  assert.deepEqual(r.hub.violations, []);
});

test('if the host leaves mid-game the chains are lost, so everyone is told and sent to the results', async () => {
  const r = await start(4);
  await writeAll(r, ['One', 'Two', 'Three', 'Four']);
  assert.equal(st(r, 1).phase, 'draw');
  r.hub.leave(person(1).id);
  await r.clock.advance(800);
  const s = st(r, 1);
  assert.equal(s.phase, 'lost');
  assert.equal(s.note, 'host');
  assert.equal(r.hub.state[IN_KEY], undefined);
  const m = telephone.model(r.engines[1].snapshot());
  assert.equal(m.phase, 'lost');
  await r.clock.advance(LOST_MS + 400);
  const snap = r.engines[1].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, []);
});

test('with 12 people in the call, 10 play and the state stays under every limit', async () => {
  const r = await start(12);
  let s = st(r);
  assert.equal(s.seats.length, MAX_SEATS);
  assert.equal(s.wait.length, 2);
  assert.equal(s.steps, 8);
  checkLimits(r);
  await writeAll(r, s.seats.map((_, i) => `🐧🎂🦄 ${'big silly phrase '.repeat(6)} ${i}`));
  s = st(r);
  assert.equal(s.phase, 'draw');
  checkLimits(r);
  for (let step = 1; step < s.steps; step += 1) {
    s = st(r);
    if (s.phase === 'draw') {
      await drawAll(r, bigInk);
      await r.clock.advance(SETTLE_MS + 300);
    } else {
      await writeAll(r, s.seats.map((_, i) => `${'🌀'.repeat(30)} described ${i} ${'x'.repeat(40)}`));
    }
    const bytes = checkLimits(r);
    assert.ok(bytes < 60000, `${bytes}`);
  }
  s = st(r);
  assert.equal(s.phase, 'reveal');
  for (let i = 0; i < 8; i += 1) {
    r.engines[0].act({ type: 'next', c: s.rv.c, at: st(r).rv.at });
    await r.clock.advance(NEXT_MIN_MS + 300);
    checkLimits(r);
  }
  assert.deepEqual(r.hub.violations, []);
});

test('awards spread around and skip empty categories', () => {
  const mem = {
    chains: [
      [{ k: 'w', by: 0, t: 'A cat on a boat' }, { k: 'd', by: 1, s: [] }, { k: 't', by: 2, t: 'A cat in a boat' }],
      [{ k: 'w', by: 1, t: 'A frog king' }, { k: 'd', by: 2, s: [] }, { k: 't', by: 0, t: 'Volcano party' }],
    ],
    got: { 0: { all: 5, r0: 1, w: 5 }, 1: { all: 2, r0: 2, d: 2 }, 2: { all: 1, d: 1 } },
    speed: { 0: [1000, 2000], 1: [5000, 6000], 2: [100, 200] },
    ink: { 1: 50, 2: 900 },
  };
  const aw = pickAwards(mem, [0, 1, 2]);
  assert.equal(aw[0].id, 'fav');
  assert.equal(aw[0].slot, 0);
  assert.equal(aw.find((a) => a.id === 'clown').slot, 1);
  assert.equal(new Set(aw.map((a) => a.slot)).size, aw.length);
  for (const a of aw) for (const re of BANNED) assert.equal(re.test(`${a.title} ${a.why}`), false);
  assert.deepEqual(pickAwards({ chains: [], got: {}, speed: {}, ink: {} }, [0, 1]), []);
});

test('sound cues fire once per moment and never on first render', () => {
  const base = { run: 1, phase: 'write', step: 0, playing: true, doneCount: 0, pass: false, reveal: null };
  const first = telephoneMoments(null, base);
  assert.deepEqual(first.cues, []);
  const same = telephoneMoments(first.now, base);
  assert.deepEqual(same.cues, []);
  const more = telephoneMoments(same.now, { ...base, doneCount: 1 });
  assert.deepEqual(more.cues.map((c) => c.name), ['tap']);
  const step = telephoneMoments(more.now, { ...base, phase: 'draw', step: 1 });
  assert.deepEqual(step.cues.map((c) => c.name), ['turn']);
  const names = [];
  for (const c of [...first.cues, ...more.cues, ...step.cues]) names.push(c.name);
  assert.equal(names.includes('start'), false);
  assert.equal(names.includes('win'), false);
  assert.equal(names.includes('coin'), false);
});

test('the view walks through every phase with no inline styles', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3);
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, args])), set: (t, k, v) => ((t[k] = v), true) });
  const make2d = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make2d(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const played = [];
  const cues = { play: (name) => played.push(name), burst() {}, float() {} };
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = createTelephoneView({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win, cues });
    engine.on('change', (s) => v.update(s));
    v.update(engine.snapshot());
    return v;
  });
  const check = () => {
    for (const v of views) {
      noInlineStyle(v.el);
      const shown = text(v.el);
      assert.equal(/\bundefined\b|\bnull\b|NaN/.test(shown), false, shown);
      for (const re of BANNED) assert.equal(re.test(shown), false, shown);
    }
  };
  const seatView = (seat) => views[r.engines.indexOf(seatEngine(r, seat))];
  assert.match(text(views[0].el), /Start a chain/);
  assert.ok(byKey(views[1].el, 'sug-0'));
  check();
  assert.equal(played.length, 0, 'no sounds on first render');
  const input = byKey(views[0].el, 'tel-input');
  byKey(views[0].el, 'tel-send').click();
  assert.ok(toasts.length >= 1, 'empty sends get a friendly nudge');
  input.value = 'A llama on a lighthouse';
  byKey(views[0].el, 'tel-send').click();
  byKey(views[1].el, 'sug-2').click();
  const third = byKey(views[2].el, 'tel-input');
  third.value = 'A sock with opinions';
  third.dispatchEvent(Object.assign(new FakeEvent('keydown', { bubbles: true }), { key: 'Enter' }));
  await r.clock.advance(600);
  assert.equal(st(r).phase, 'draw');
  check();
  assert.ok(played.includes('send'));
  assert.ok(played.includes('turn'));
  const drawer = seatView(1);
  assert.match(text(drawer.el), /Draw this phrase/);
  assert.match(text(drawer.el), /A llama on a lighthouse/);
  assert.match(text(drawer.el), /Ink left 100%/);
  assert.equal(text(seatView(0).el).includes('A llama on a lighthouse'), false, 'only the drawer sees the phrase');
  const canvas = all(drawer.el).find((x) => x.localName === 'canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 360 });
  canvas.dispatchEvent(pointer('pointerdown', 10, 10));
  for (let i = 1; i <= 30; i += 1) canvas.dispatchEvent(pointer('pointermove', 10 + i * 9, 10 + ((i * 37) % 300)));
  canvas.dispatchEvent(pointer('pointerup', 300, 200));
  await r.clock.advance(800);
  const k = st(r).k;
  assert.equal(validInk(r.hub.state[inkKey(1)], k), true);
  assert.ok(r.hub.state[inkKey(1)].s.length >= 1);
  assert.doesNotMatch(text(drawer.el), /Ink left 100%/);
  assert.ok(calls.some(([name]) => name === 'lineTo'));
  byKey(drawer.el, 'draw-done').click();
  for (const seat of [0, 2]) {
    const e = seatEngine(r, seat);
    e.direct(inkKey(seat), smallInk(k, seat + 3));
  }
  await r.clock.advance(400);
  for (const seat of [0, 2]) byKey(seatView(seat).el, 'draw-done').click();
  await r.clock.advance(SETTLE_MS + 400);
  assert.equal(st(r).phase, 'text');
  check();
  const describer = seatView(2);
  assert.match(text(describer.el), /What is this drawing/);
  assert.match(text(describer.el), /Drawn by/);
  for (let seat = 0; seat < 3; seat += 1) {
    const v = seatView(seat);
    byKey(v.el, 'tel-input').value = `Guess number ${seat}`;
    byKey(v.el, 'tel-send').click();
  }
  await r.clock.advance(600);
  assert.equal(st(r).phase, 'reveal');
  check();
  const owner = seatView(0);
  assert.match(text(owner.el), /started with/);
  assert.match(text(owner.el), /A llama on a lighthouse/);
  assert.ok(byKey(owner.el, 'tel-next'));
  assert.equal(byKey(seatView(1).el, 'tel-next'), null, 'only the starter gets the Next button');
  assert.equal(byKey(owner.el, 'react-0-0').disabled, true, 'no reacting to your own entry');
  byKey(seatView(1).el, 'react-0-0').click();
  await r.clock.advance(NEXT_MIN_MS + 300);
  assert.deepEqual(st(r).rx[0], [1, 0, 0, 0, 0]);
  assert.match(text(owner.el), /😂\s+1/);
  assert.ok(played.includes('pop'));
  byKey(owner.el, 'tel-next').click();
  await r.clock.advance(400);
  assert.equal(st(r).rv.at, 1);
  assert.equal(all(owner.el).filter((x) => x.localName === 'canvas' && x.dataset.draw === '1').length, 1);
  assert.match(text(owner.el), /drew/);
  check();
  for (let i = 0; i < 12 && st(r).phase === 'reveal'; i += 1) await r.clock.advance(END_SHOW_MS + 100);
  assert.equal(st(r).phase, 'awards');
  check();
  assert.match(text(views[0].el), /And the awards go to/);
  const aw = st(r).aw;
  for (const a of aw) assert.match(text(views[0].el), new RegExp(a.title));
  assert.equal(played.includes('win'), false);
  assert.equal(played.includes('start'), false);
  for (const v of views) v.destroy();
  assert.deepEqual(r.hub.violations, []);
});

test('the view explains a lost game and shows watchers what is going on', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(4);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const late = r.add(5);
  await r.clock.advance(800);
  const watch = createTelephoneView({ engine: late, fx: { confetti() {} }, toast() {}, win });
  watch.update(late.snapshot());
  assert.match(text(watch.el), /seat/);
  noInlineStyle(watch.el);
  r.hub.leave(person(1).id);
  await r.clock.advance(800);
  const v = createTelephoneView({ engine: r.engines[1], fx: { confetti() {} }, toast() {}, win });
  v.update(r.engines[1].snapshot());
  assert.match(text(v.el), /host left/);
  noInlineStyle(v.el);
  v.destroy();
  watch.destroy();
});

test('the files have no comments, no inline styles and only telephone- classes in the CSS', () => {
  const files = ['js/games/telephone.js', 'js/views/telephone.js', 'data/telephone.js', 'css/telephone.css'];
  for (const f of files) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, `${f} has a block comment`);
    assert.equal(/(^|\s)\/\//m.test(src), false, `${f} has a line comment`);
    assert.equal(/style=|\.style\.(?!setProperty)|innerHTML|eval\(|new Function/.test(src), false, f);
    for (const re of BANNED) assert.equal(re.test(src), false, `${f} matches ${re}`);
  }
  const css = readFileSync(new URL('css/telephone.css', ROOT), 'utf8');
  assert.equal(/url\(|@import/.test(css), false);
  for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)/g)) {
    if (m[1].startsWith('telephone-')) continue;
    assert.ok(['is-on', 'is-me', 'btn'].includes(m[1]), `css class ${m[1]}`);
  }
});

test('reactions are only counted during the reveal and only for shown entries', async () => {
  const r = await start(3);
  r.engines[1].act({ type: 'react', c: 0, i: 0, e: 0 });
  await r.clock.advance(300);
  assert.equal(st(r).rx, null);
  assert.equal(REACTS.length, 5);
  assert.ok(ENTRY_PREFIX.startsWith('tel.'));
});

test('players cannot write odd ink keys, other seats, or the round state', async () => {
  const r = await start(3);
  await writeAll(r, ['A cat', 'A dog', 'A frog']);
  const s = st(r);
  assert.equal(s.phase, 'draw');
  const slot = s.seats[1];
  const e = bySlot(r, slot);
  const ink = smallInk(s.k, 2);
  for (const key of [`${INK_PREFIX}01`, `${INK_PREFIX}1.0`, `${INK_PREFIX} 1`, `${INK_PREFIX}1e0`, INK_PREFIX, inkKey(0), inkKey(2)]) {
    assert.equal(e.direct(key, ink), false, key);
  }
  assert.equal(e.direct(inkKey(1), { k: s.k + 1, s: ink.s }), false);
  assert.equal(e.direct(inkKey(1), ink), true);
  assert.equal(e.direct(KEY, { ...s, phase: 'awards' }), false);
  e.act({ type: 'next', c: 0, at: 0 });
  e.act({ type: 'text', step: s.step, text: 'sneaky' });
  await r.clock.advance(400);
  assert.equal(st(r).phase, 'draw');
  assert.deepEqual(st(r).done, []);
  for (const k of Object.keys(r.hub.state)) assert.ok(!/^tel\.d\.(0\d|.*\D)/.test(k) || k === inkKey(1), k);
});

test('16 people in the call stay inside every limit and the budget through a whole game', async () => {
  const r = await start(16);
  let s = st(r);
  assert.equal(s.seats.length, MAX_SEATS);
  assert.equal(s.wait.length, 6);
  await writeAll(r, s.seats.map((_, i) => `${'🐙'.repeat(20)} ${'very long phrase '.repeat(4)} ${i}`));
  for (let step = 1; step < st(r).steps; step += 1) {
    s = st(r);
    if (s.phase === 'draw') {
      await drawAll(r, bigInk);
      await r.clock.advance(SETTLE_MS + 300);
    } else {
      await writeAll(r, s.seats.map((_, i) => `described ${i} ${'y'.repeat(60)}`));
    }
    checkLimits(r);
  }
  assert.equal(st(r).phase, 'reveal');
  for (let guard = 0; guard < 400 && st(r).phase === 'reveal'; guard += 1) {
    const rv = st(r).rv;
    for (const e of r.engines) for (let x = 0; x < REACTS.length; x += 1) e.act({ type: 'react', c: rv.c, i: rv.at, e: x });
    await r.clock.advance(300);
    r.engines[0].act({ type: 'next', c: rv.c, at: rv.at });
    await r.clock.advance(NEXT_MIN_MS + 300);
    checkLimits(r);
  }
  assert.equal(st(r).phase, 'awards');
  await r.clock.advance(AWARDS_MS + 500);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  assert.deepEqual(r.hub.violations, []);
});

test('opening the page during the awards plays no sound', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3);
  for (let guard = 0; guard < 200 && st(r).phase !== 'awards'; guard += 1) await r.clock.advance(5000);
  assert.equal(st(r).phase, 'awards');
  assert.ok(st(r).aw.length > 0);
  const win = { setTimeout: r.clock.setTimeout, clearTimeout: r.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const played = [];
  const cues = { play: (name) => played.push(name), burst: () => played.push('burst'), float() {} };
  const views = r.engines.map((engine) => {
    const v = createTelephoneView({ engine, fx: { confetti: () => played.push('confetti') }, toast() {}, win, cues });
    v.update(engine.snapshot());
    v.update(engine.snapshot());
    return v;
  });
  assert.deepEqual(played, []);
  for (const v of views) v.destroy();
});

class InkCtx {
  constructor() {
    this.scene = [];
    this.path = [];
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
  }

  fillRect(x, y, w, h) {
    if (x <= 0 && y <= 0 && w >= GRID_W * 2 && h >= GRID_H * 2) this.scene = [];
    else this.scene.push(`rect ${this.fillStyle} ${x},${y},${w},${h}`);
  }

  beginPath() {
    this.path = [];
  }

  moveTo(x, y) {
    this.path.push(`${x},${y}`);
  }

  lineTo(x, y) {
    this.path.push(`${x},${y}`);
  }

  arc(x, y) {
    this.path.push(`dot ${x},${y}`);
  }

  stroke() {
    this.scene.push(`${this.strokeStyle} ${this.lineWidth} ${this.path.join(' ')}`);
  }

  fill() {
    this.scene.push(`${this.fillStyle} ${this.lineWidth} ${this.path.join(' ')}`);
  }

  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(0), scene: this.scene.slice() };
  }

  putImageData(img) {
    if (img && Array.isArray(img.scene)) this.scene = img.scene.slice();
  }
}

function sceneOf(strokes) {
  const c = new InkCtx();
  paintInk(c, strokes, 2);
  return c.scene;
}

function inkCanvases() {
  const made = new Map();
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'canvas') {
      const c = new InkCtx();
      made.set(el, c);
      el.getContext = () => c;
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: GRID_W, height: GRID_H });
    }
    return el;
  };
  return made;
}

function clockWin(r) {
  return {
    setTimeout: r.clock.setTimeout,
    clearTimeout: r.clock.clearTimeout,
    setInterval(fn, ms) {
      const box = { id: 0, on: true };
      const tick = () => {
        if (!box.on) return;
        box.id = r.clock.setTimeout(tick, ms);
        fn();
      };
      box.id = r.clock.setTimeout(tick, ms);
      return box;
    },
    clearInterval(box) {
      if (box && typeof box === 'object') {
        box.on = false;
        r.clock.clearTimeout(box.id);
      }
    },
  };
}

function pen(type, x, y, id = 1, extra = {}) {
  const e = new FakeEvent(type, { bubbles: true });
  e.clientX = x;
  e.clientY = y;
  e.pointerId = id;
  Object.assign(e, extra);
  return e;
}

function lineFor(step, seat) {
  const y = 20 + seat * 36;
  const x0 = 16 + step * 6;
  return { c: 1 + ((step + seat) % 11), z: 1, pts: [[x0, y], [x0 + 260, y]] };
}

function heldFor(step, seat) {
  const x = 420 - step * 4;
  return { c: lineFor(step, seat).c, z: 1, pts: [[x, 40], [x, 220]] };
}

function mainCanvas(v) {
  return all(v.el).find((x) => x.localName === 'canvas' && !x.dataset.draw);
}

function boardOn(v) {
  const b = all(v.el).find((x) => x.classList && x.classList.contains('telephone-board'));
  return !b.classList.contains('telephone-off');
}

function drawLine(v, s, id = 1) {
  byKey(v.el, `color-${s.c}`).click();
  const cv = mainCanvas(v);
  const [a, b] = s.pts;
  cv.dispatchEvent(pen('pointerdown', a[0], a[1], id));
  for (let i = 1; i <= 4; i += 1) cv.dispatchEvent(pen('pointermove', a[0] + ((b[0] - a[0]) * i) / 4, a[1] + ((b[1] - a[1]) * i) / 4, id));
  cv.dispatchEvent(pen('pointerup', b[0], b[1], id));
}

function partsOf(ink) {
  return (ink && Array.isArray(ink.s) ? ink.s : []).map(decodeStroke);
}

function plain(s) {
  return { c: s.c, z: s.z, pts: s.pts.map((p) => [p[0], p[1]]) };
}

async function telephoneTable(r, players) {
  const canvases = inkCanvases();
  const toasts = [];
  const win = clockWin(r);
  const views = players.map((engine) => {
    const v = createTelephoneView({ engine, toast: (t) => toasts.push(t), win, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (s) => v.update(s));
    v.update(engine.snapshot());
    return v;
  });
  return { canvases, views, toasts };
}

async function playChecked(r, players, views, canvases) {
  const host = players.find((e) => e.isHost());
  const now = () => host.snapshot().state[KEY];
  const seatOf = (i) => now().seats.indexOf(players[i].snapshot().meSlot);
  const drawn = new Map();
  const screenOf = (i) => canvases.get(mainCanvas(views[i])).scene;
  let checks = 0;
  const n = now().seats.length;
  players.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Start phrase ${i}` }));
  await r.clock.advance(600);
  for (let step = 1; step < now().steps; step += 1) {
    const s = now();
    assert.equal(s.step, step);
    if (s.phase === 'draw') {
      players.forEach((_, i) => {
        const seat = seatOf(i);
        drawLine(views[i], lineFor(step, seat));
      });
      await r.clock.advance(800);
      players.forEach((_, i) => {
        const seat = seatOf(i);
        assert.equal(boardOn(views[i]), true);
        assert.deepEqual(screenOf(i), sceneOf([lineFor(step, seat)]), `n=${n} step ${step} drawer seat ${seat} sees only their own drawing`);
        checks += 1;
      });
      const holder = players.findIndex((_, i) => seatOf(i) === step % n);
      const held = heldFor(step, step % n);
      const hc = mainCanvas(views[holder]);
      hc.dispatchEvent(pen('pointerdown', held.pts[0][0], held.pts[0][1], 7));
      hc.dispatchEvent(pen('pointermove', held.pts[0][0], 130, 7));
      hc.dispatchEvent(pen('pointermove', held.pts[1][0], held.pts[1][1], 7));
      players.forEach((_, i) => {
        if (i !== holder) byKey(views[i].el, 'draw-done').click();
      });
      await r.clock.advance(now().ends - r.clock.now() + 500);
      players.forEach((_, i) => {
        const seat = seatOf(i);
        const want = [lineFor(step, seat)].concat(seat === step % n ? [held] : []);
        assert.deepEqual(partsOf(r.hub.state[inkKey(seat)]).map(plain), want, `n=${n} step ${step} seat ${seat} ink was saved, held line included`);
        drawn.set(`${step}:${seat}`, want);
      });
      await r.clock.advance(GRACE_MS + 400);
      hc.dispatchEvent(pen('pointermove', 470, 350, 7));
      hc.dispatchEvent(pen('pointerup', 470, 350, 7));
      await r.clock.advance(100);
    } else {
      assert.equal(s.phase, 'text');
      players.forEach((_, i) => {
        const seat = seatOf(i);
        const from = (seat - 1 + n) % n;
        assert.equal(boardOn(views[i]), true);
        assert.deepEqual(screenOf(i), sceneOf(drawn.get(`${step - 1}:${from}`)), `n=${n} step ${step} describer seat ${seat} sees seat ${from}'s drawing`);
        assert.notDeepEqual(screenOf(i), sceneOf(drawn.get(`${step - 1}:${seat}`)));
        checks += 1;
      });
      const send = (i) => {
        byKey(views[i].el, 'tel-input').value = `Guess ${step} ${i}`;
        byKey(views[i].el, 'tel-send').click();
      };
      players.forEach((_, i) => i && send(i));
      await r.clock.advance(600);
      assert.equal(now().step, step);
      players.forEach((_, i) => {
        const seat = seatOf(i);
        const from = (seat - 1 + n) % n;
        assert.deepEqual(screenOf(i), sceneOf(drawn.get(`${step - 1}:${from}`)), 'waiting after sending keeps the right drawing');
      });
      send(0);
      await r.clock.advance(600);
    }
  }
  if (now().phase !== 'reveal') await r.clock.advance(SETTLE_MS + 400);
  assert.equal(now().phase, 'reveal');
  players.forEach((_, i) => assert.equal(boardOn(views[i]), false));
  for (let guard = 0; guard < 200 && now().phase === 'reveal'; guard += 1) {
    const rv = now().rv;
    for (const [i, v] of views.entries()) {
      const shown = all(v.el).filter((x) => x.localName === 'canvas' && x.dataset.draw !== undefined);
      const want = [];
      for (let at = 1; at <= rv.at; at += 2) want.push(at);
      assert.deepEqual(shown.map((x) => Number(x.dataset.draw)), want, `player ${i} shows one canvas per drawing so far`);
      for (const cv of shown) {
        const at = Number(cv.dataset.draw);
        const seat = (rv.c + at) % n;
        assert.deepEqual(canvases.get(cv).scene, sceneOf(drawn.get(`${at}:${seat}`)), `n=${n} reveal chain ${rv.c} entry ${at} on player ${i}`);
        checks += 1;
      }
    }
    await r.clock.advance(NEXT_MIN_MS + 50);
    const owner = players.find((e) => e.snapshot().meSlot === now().seats[rv.c]);
    owner.act({ type: 'next', c: rv.c, at: rv.at });
    await r.clock.advance(600);
  }
  assert.equal(now().phase, 'awards');
  assert.deepEqual(r.hub.violations, []);
  return checks;
}

for (const n of [3, 5, 8]) {
  test(`every screen shows exactly the right chain's drawing at every step with ${n} players`, async () => {
    installDom({ url: 'https://yapos.dev/activity/' });
    const r = await start(n, { draw: 50 });
    const { canvases, views, toasts } = await telephoneTable(r, r.engines);
    const checks = await playChecked(r, r.engines, views, canvases);
    assert.ok(checks >= n * 3, `${checks}`);
    assert.equal(toasts.some((t) => /did not save/.test(t)), false);
    for (const v of views) v.destroy();
  });
}

test('after a host change the new host and everyone else still see the right drawings', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(6, { games: GAMES });
  await r.clock.advance(500);
  r.hub.leave(r.engines[0].snapshot().me);
  r.engines[0].destroy();
  await r.clock.advance(600);
  const players = r.engines.slice(1);
  const host = players[0];
  assert.equal(host.isHost(), true);
  assert.equal(host.lobby.pick('telephone'), true);
  assert.equal(host.lobby.setting('draw', 50), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const { canvases, views } = await telephoneTable(r, players);
  const checks = await playChecked(r, players, views, canvases);
  assert.ok(checks >= 15);
  for (const v of views) v.destroy();
});

test('when the host leaves mid-drawing nobody is left looking at a drawing', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(4, { draw: 50 });
  const { canvases, views } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  views.forEach((v, i) => drawLine(v, lineFor(1, i)));
  const cv = mainCanvas(views[2]);
  cv.dispatchEvent(pen('pointerdown', 300, 300, 3));
  cv.dispatchEvent(pen('pointermove', 340, 300, 3));
  await r.clock.advance(800);
  r.hub.leave(r.engines[0].snapshot().me);
  r.engines[0].destroy();
  await r.clock.advance(800);
  cv.dispatchEvent(pen('pointermove', 400, 300, 3));
  cv.dispatchEvent(pen('pointerup', 400, 300, 3));
  for (const v of views.slice(1)) {
    assert.equal(v.el.dataset.phase, 'lost');
    assert.equal(boardOn(v), false);
    assert.deepEqual(canvases.get(mainCanvas(v)).scene, []);
  }
  for (const v of views) v.destroy();
});

test('a player who reloads mid-drawing or joins late gets their own saved drawing, not a stale one', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { canvases, views } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const seatOf = (e) => st(r).seats.indexOf(e.snapshot().meSlot);
  views.forEach((v, i) => drawLine(v, lineFor(1, seatOf(r.engines[i]))));
  await r.clock.advance(900);
  views[1].destroy();
  const again = createTelephoneView({ engine: r.engines[1], toast() {}, win: clockWin(r), cues: { play() {}, burst() {}, float() {} } });
  again.update(r.engines[1].snapshot());
  const seat = seatOf(r.engines[1]);
  assert.deepEqual(canvases.get(mainCanvas(again)).scene, sceneOf([lineFor(1, seat)]));
  const more = { c: 4, z: 1, pts: [[30, 330], [300, 330]] };
  drawLine(again, more);
  await r.clock.advance(900);
  assert.deepEqual(partsOf(r.hub.state[inkKey(seat)]).map(plain), [lineFor(1, seat), more], 'the reloaded drawing keeps the earlier lines');
  for (const e of [r.engines[0], r.engines[2]]) byKey(views[r.engines.indexOf(e)].el, 'draw-done').click();
  byKey(again.el, 'draw-done').click();
  await r.clock.advance(SETTLE_MS + 600);
  assert.equal(st(r).phase, 'text');
  const late = createTelephoneView({ engine: r.engines[0], toast() {}, win: clockWin(r), cues: { play() {}, burst() {}, float() {} } });
  late.update(r.engines[0].snapshot());
  const from = (seatOf(r.engines[0]) + 2) % 3;
  const want = from === seat ? [lineFor(1, seat), more] : [lineFor(1, from)];
  assert.deepEqual(canvases.get(mainCanvas(late)).scene, sceneOf(want));
  for (const v of [views[0], views[2], again, late]) v.destroy();
});

test('the describer repaints when a drawing changes without changing its stroke count', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { canvases, views } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const k = st(r).k;
  const a = encodeParts(lineFor(1, 0));
  const b = encodeParts(lineFor(1, 2));
  r.engines.forEach((e) => {
    const seat = st(r).seats.indexOf(e.snapshot().meSlot);
    e.direct(inkKey(seat), { k, s: seat === 0 ? a : encodeParts(lineFor(1, seat)) });
  });
  await r.clock.advance(400);
  r.engines.forEach((e) => e.act({ type: 'done', step: 1 }));
  await r.clock.advance(SETTLE_MS + 600);
  assert.equal(st(r).phase, 'text');
  const viewer = r.engines.findIndex((e) => st(r).seats.indexOf(e.snapshot().meSlot) === 1);
  assert.deepEqual(canvases.get(mainCanvas(views[viewer])).scene, sceneOf([lineFor(1, 0)]));
  const fake = { ...r.engines[viewer].snapshot() };
  fake.state = { ...fake.state, [inkKey(0)]: { k, s: b } };
  views[viewer].update(fake);
  assert.deepEqual(canvases.get(mainCanvas(views[viewer])).scene, sceneOf([lineFor(1, 2)]));
  for (const v of views) v.destroy();
});

test('a stroke never leaks across pointers, released buttons or the Done button', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { canvases, views, toasts } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const v = views[0];
  const seat = st(r).seats.indexOf(r.engines[0].snapshot().meSlot);
  const cv = mainCanvas(v);
  byKey(v.el, 'color-1').click();
  cv.dispatchEvent(pen('pointerdown', 20, 20, 1));
  cv.dispatchEvent(pen('pointerdown', 200, 200, 2));
  cv.dispatchEvent(pen('pointermove', 200, 300, 2));
  cv.dispatchEvent(pen('pointermove', 120, 20, 1));
  cv.dispatchEvent(pen('pointerup', 200, 300, 2));
  cv.dispatchEvent(pen('pointermove', 220, 20, 1));
  cv.dispatchEvent(pen('pointerup', 220, 20, 1));
  cv.dispatchEvent(pen('pointerdown', 20, 100, 1, { pointerType: 'mouse', buttons: 1 }));
  cv.dispatchEvent(pen('pointermove', 220, 100, 1, { pointerType: 'mouse', buttons: 1 }));
  cv.dispatchEvent(pen('pointermove', 400, 300, 1, { pointerType: 'mouse', buttons: 0 }));
  cv.dispatchEvent(pen('pointermove', 400, 350, 1, { pointerType: 'mouse', buttons: 0 }));
  cv.dispatchEvent(pen('pointerdown', 20, 160, 1));
  cv.dispatchEvent(pen('pointermove', 220, 160, 1));
  byKey(v.el, 'draw-done').click();
  await r.clock.advance(900);
  const want = [
    { c: 1, z: 1, pts: [[20, 20], [220, 20]] },
    { c: 1, z: 1, pts: [[20, 100], [220, 100]] },
    { c: 1, z: 1, pts: [[20, 160], [220, 160]] },
  ];
  assert.deepEqual(partsOf(r.hub.state[inkKey(seat)]).map(plain), want);
  assert.deepEqual(canvases.get(cv).scene, sceneOf(want));
  cv.dispatchEvent(pen('pointermove', 300, 300, 1));
  cv.dispatchEvent(pen('pointerup', 300, 300, 1));
  assert.deepEqual(canvases.get(cv).scene, sceneOf(want), 'moves after Done never paint');
  assert.deepEqual(toasts, []);
  for (const x of views) x.destroy();
});

test('running out of ink or failing to save always tells the drawer', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { views, toasts } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const v = views[0];
  const cv = mainCanvas(v);
  for (let i = 0; i < INK_PARTS + 5; i += 1) {
    cv.dispatchEvent(pen('pointerdown', 10 + (i % 40) * 11, 10 + Math.floor(i / 40) * 40, 1));
    cv.dispatchEvent(pen('pointerup', 10 + (i % 40) * 11, 10 + Math.floor(i / 40) * 40, 1));
  }
  assert.ok(toasts.some((t) => /Out of ink/.test(t)), 'hitting the stroke cap says so');
  assert.match(text(v.el), /Ink left 0%/, 'the meter shows the real limit');
  const before = toasts.length;
  const real = r.engines[0].direct;
  r.engines[0].direct = () => false;
  byKey(v.el, 'undo').click();
  await r.clock.advance(900);
  r.engines[0].direct = real;
  assert.ok(toasts.slice(before).some((t) => /did not save/.test(t)), 'a refused save is reported');
  for (const x of views) x.destroy();
});

test('six to eight players scribbling nonstop stay inside the op budget and every drawing lands', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  for (const n of [6, 8]) {
    const r = await start(n, { draw: 50 });
    const { canvases, views } = await telephoneTable(r, r.engines);
    r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
    await r.clock.advance(600);
    const s = st(r);
    const t0 = r.clock.now();
    const count = new Array(n).fill(0);
    for (let tick = 0; r.clock.now() < s.ends - 2000; tick += 1) {
      views.forEach((v, i) => {
        const y = 10 + ((tick * 7 + i * 13) % 340);
        const x = 10 + ((tick * 3) % 200);
        const cv = mainCanvas(v);
        cv.dispatchEvent(pen('pointerdown', x, y, 1));
        cv.dispatchEvent(pen('pointermove', x + 60, y, 1));
        cv.dispatchEvent(pen('pointerup', x + 60, y, 1));
        count[i] += 1;
      });
      await r.clock.advance(250);
    }
    await r.clock.advance(s.ends - r.clock.now() + 300);
    for (const e of r.engines) {
      const id = e.snapshot().me;
      for (let at = t0; at < r.clock.now(); at += 1000) assert.ok(r.hub.opsBy(id, at, at + 10000) <= 100);
    }
    assert.deepEqual(r.hub.violations, []);
    r.engines.forEach((e, i) => {
      const seat = s.seats.indexOf(e.snapshot().meSlot);
      const ink = r.hub.state[inkKey(seat)];
      assert.equal(validInk(ink, s.k), true, `seat ${seat}`);
      assert.ok(ink.s.length > 0);
      assert.deepEqual(canvases.get(mainCanvas(views[i])).scene, sceneOf(partsOf(ink)), `seat ${seat} saved exactly what is on their screen`);
    });
    for (const v of views) v.destroy();
  }
});

test('a touch whose lift never reached the canvas does not freeze the next touch', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { canvases, views, toasts } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const v = views[0];
  const seat = st(r).seats.indexOf(r.engines[0].snapshot().meSlot);
  const cv = mainCanvas(v);
  const held = new Set();
  cv.setPointerCapture = (id) => held.add(id);
  cv.releasePointerCapture = (id) => held.delete(id);
  cv.hasPointerCapture = (id) => held.has(id);
  byKey(v.el, 'color-1').click();
  cv.dispatchEvent(pen('pointerdown', 20, 20, 5, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointermove', 220, 20, 5, { pointerType: 'touch' }));
  held.delete(5);
  cv.dispatchEvent(pen('pointerdown', 20, 100, 6, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointermove', 220, 100, 6, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointerdown', 300, 300, 7, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointermove', 400, 300, 7, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointerup', 220, 100, 6, { pointerType: 'touch' }));
  cv.setPointerCapture = () => {
    throw new Error('no capture');
  };
  cv.dispatchEvent(pen('pointerdown', 20, 160, 8, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointermove', 220, 160, 8, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointerdown', 20, 220, 9, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointermove', 220, 220, 9, { pointerType: 'touch' }));
  cv.dispatchEvent(pen('pointerup', 220, 220, 9, { pointerType: 'touch' }));
  await r.clock.advance(900);
  const want = [
    { c: 1, z: 1, pts: [[20, 20], [220, 20]] },
    { c: 1, z: 1, pts: [[20, 100], [220, 100]] },
    { c: 1, z: 1, pts: [[20, 160], [220, 160]] },
    { c: 1, z: 1, pts: [[20, 220], [220, 220]] },
  ];
  assert.deepEqual(partsOf(r.hub.state[inkKey(seat)]).map(plain), want);
  assert.deepEqual(canvases.get(cv).scene, sceneOf(want));
  assert.deepEqual(toasts, []);
  for (const x of views) x.destroy();
});

test('redo brings back an undone line, refills the meter and is cleared by a new line', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await start(3, { draw: 50 });
  const { views } = await telephoneTable(r, r.engines);
  r.engines.forEach((e, i) => e.act({ type: 'text', step: 0, text: `Phrase ${i}` }));
  await r.clock.advance(600);
  const v = views[0];
  const cv = mainCanvas(v);
  const line = (x) => {
    cv.dispatchEvent(pen('pointerdown', x, 40, 1));
    for (let k = 1; k <= 80; k += 1) cv.dispatchEvent(pen('pointermove', x + (k % 2) * 60, 40 + k * 6, 1));
    cv.dispatchEvent(pen('pointerup', x, 520, 1));
  };
  line(20);
  line(200);
  await r.clock.advance(900);
  const meter = () => text(v.el).match(/Ink left (\d+)%/)[1];
  const full = meter();
  byKey(v.el, 'undo').click();
  await r.clock.advance(900);
  assert.notEqual(meter(), full);
  assert.equal(byKey(v.el, 'redo').disabled, false);
  byKey(v.el, 'redo').click();
  await r.clock.advance(900);
  assert.equal(meter(), full, 'redo puts the ink back');
  assert.equal(byKey(v.el, 'redo').disabled, true);
  byKey(v.el, 'undo').click();
  await r.clock.advance(900);
  line(400);
  await r.clock.advance(900);
  assert.equal(byKey(v.el, 'redo').disabled, true, 'a new line clears redo');
  for (const x of views) x.destroy();
});
