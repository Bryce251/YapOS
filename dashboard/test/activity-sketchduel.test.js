import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import sketchduel, { KEY, INK_PREFIX, MAX_DUELS, VOTE_MS, RESULT_MS, GRACE_MS, VOTE_POINTS, WIN_BONUS, TIE_BONUS, inkKey, drawingId, pairKey, pickDrawers, pairUp, pickWords, wordPool, award } from '../web/activity/js/games/sketchduel.js';
import { createSketchduelView, footText, headline, duelMoments } from '../web/activity/js/views/sketchduel.js';
import { encodeParts } from '../web/activity/js/games/ink.js';
import { isBlockedGameWord } from '../web/activity/js/filter.js';
import { jsonBytes, MAX_VALUE_BYTES, stateBytes, MAX_STATE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function st(r) {
  return r.hub.state[KEY];
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function ink(k, seed = 1) {
  return { k, s: encodeParts({ c: 1 + (seed % 5), z: 1, pts: [[10 + seed, 10], [40 + seed, 30], [80, 60 + seed]] }) };
}

function bigInk(k) {
  const parts = [];
  for (let i = 0; i < 40; i += 1) parts.push(...encodeParts({ c: 2, z: 2, pts: Array.from({ length: 12 }, (_, j) => [(i * 7 + j * 13) % 470, (i * 11 + j * 5) % 350]) }));
  const out = [];
  let size = 0;
  for (const p of parts) {
    if (size + p.length > 2900 || out.length >= 150) break;
    out.push(p);
    size += p.length;
  }
  return { k, s: out };
}

async function startGame(n = 4, settings = {}) {
  const r = room(n, { games: [sketchduel] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('sketchduel'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

async function drawAll(r, finish = true) {
  const s = st(r);
  s.seats.forEach((slot, seat) => {
    const e = bySlot(r, slot);
    assert.equal(e.direct(inkKey(seat), ink(s.k, seat + 1)), true, `seat ${seat} can draw`);
  });
  await r.clock.advance(400);
  if (!finish) return;
  for (const slot of s.seats) bySlot(r, slot).act({ type: 'done', r: s.round });
  await r.clock.advance(1600);
}

test('the game is a drawing game for 3 or more with rounds, a draw timer and word level', () => {
  assert.equal(sketchduel.id, 'sketchduel');
  assert.equal(sketchduel.category, 'drawing');
  assert.equal(sketchduel.emoji, '⚔️');
  assert.equal(sketchduel.minPlayers, 3);
  assert.deepEqual(sketchduel.settings.find((s) => s.id === 'draw').options.map((o) => o.value), [60, 75, 90]);
  assert.ok(sketchduel.open.includes(INK_PREFIX));
  for (const re of BANNED) assert.doesNotMatch(`${sketchduel.name} ${sketchduel.blurb}`, re);
  assert.ok(wordPool('mix').length > 100);
  assert.ok(wordPool('mix').every((w) => !isBlockedGameWord(w.w)));
});

test('pairing is fair: fewest plays first, at most four duels, and repeat pairs are avoided', () => {
  const { drawers, out } = pickDrawers([1, 2, 3, 4, 5], { 1: 2, 2: 2, 3: 0, 4: 0, 5: 1 }, () => 0.5);
  assert.equal(drawers.length, 4);
  assert.equal(out.length, 1);
  assert.ok([1, 2].includes(out[0]));
  assert.ok(drawers.includes(3) && drawers.includes(4) && drawers.includes(5));
  assert.equal(pickDrawers(Array.from({ length: 20 }, (_, i) => i), {}).drawers.length, MAX_DUELS * 2);
  assert.equal(pickDrawers([1, 2, 3], {}).drawers.length, 2);
  const pairs = pairUp([1, 2, 3, 4], [pairKey(1, 2), pairKey(3, 4)], () => 0);
  for (const [a, b] of pairs) assert.ok(![pairKey(1, 2), pairKey(3, 4)].includes(pairKey(a, b)));
  const words = pickWords(4, 'easy', [], () => 0.2);
  assert.equal(new Set(words).size, 4);
});

test('award pays per vote, a bonus to the winner, half to each on a tie, and ignores hidden sides', () => {
  const r = award({ 1: 'a', 2: 'a', 3: 'b' });
  assert.equal(r.win, 'a');
  assert.equal(r.pts.a, 2 * VOTE_POINTS + WIN_BONUS);
  assert.equal(r.pts.b, VOTE_POINTS);
  const t = award({ 1: 'a', 2: 'b' });
  assert.equal(t.win, 'tie');
  assert.equal(t.pts.a, VOTE_POINTS + TIE_BONUS);
  const h = award({ 1: 'a', 2: 'a', 3: 'b' }, ['a']);
  assert.equal(h.win, 'b');
  assert.equal(h.a, 0);
  assert.equal(award({}).win, null);
});

test('with 4 players: two duels draw at once, each pair is judged by the other pair', async () => {
  const r = await startGame(4, { rounds: 2 });
  let s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.duels.length, 2);
  assert.equal(s.seats.length, 4);
  const outsider = s.seats.find((slot, seat) => seat !== 0);
  assert.equal(bySlot(r, outsider).direct(inkKey(0), ink(s.k)), false, 'nobody can draw on another seat');
  await drawAll(r);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.d, 0);
  const duel = s.duels[0];
  const a = s.seats[duel[0]];
  const b = s.seats[duel[1]];
  const judges = r.engines.map((e) => e.snapshot().meSlot).filter((x) => x !== a && x !== b);
  assert.equal(judges.length, 2);
  bySlot(r, a).act({ type: 'vote', r: s.round, d: 0, side: 'a' });
  await r.clock.advance(300);
  assert.equal(st(r).voted.length, 0, 'artists cannot vote in their own duel');
  assert.equal(bySlot(r, a).direct(inkKey(duel[0]), ink(s.k, 9)), false, 'no drawing after time');
  const items = sketchduel.drawingsOf(bySlot(r, judges[0]).snapshot());
  assert.equal(items.length, 2);
  assert.equal(items[0].d, drawingId(s.run, s.round, duel[0]));
  for (const j of judges) bySlot(r, j).act({ type: 'vote', r: s.round, d: 0, side: 'b' });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.phase, 'result');
  assert.equal(s.res.win, 'b');
  assert.equal(s.res.b, 2);
  const scores = r.engines[0].snapshot().scores.g;
  assert.equal(scores[b], 2 * VOTE_POINTS + WIN_BONUS);
  await r.clock.advance(RESULT_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'vote');
  assert.equal(s.d, 1);
  await r.clock.advance(VOTE_MS + 200);
  assert.equal(st(r).phase, 'result');
  await r.clock.advance(RESULT_MS + 200);
  s = st(r);
  assert.equal(s.phase, 'draw');
  assert.equal(s.round, 1);
  assert.equal(Object.keys(r.hub.state).filter((k) => k.startsWith(INK_PREFIX) && r.hub.state[k]).length, 0, 'old ink is cleared');
  assert.ok(Object.values(s.plays).every((n) => n === 2));
  assert.ok(sketchduel.results({ memory: { wins: { [b]: 1 } } }).extra.duelWins.includes(b));
});

test('with 3 players one sits out to judge, and the sit-out rotates', async () => {
  const r = await startGame(3, { rounds: 3, draw: 60 });
  const sat = [];
  for (let round = 0; round < 3; round += 1) {
    const s = st(r);
    assert.equal(s.phase, 'draw');
    assert.equal(s.seats.length, 2);
    const out = r.engines.map((e) => e.snapshot().meSlot).find((x) => !s.seats.includes(x));
    sat.push(out);
    await r.clock.advance(60000 + GRACE_MS + 100);
    assert.equal(st(r).phase, 'vote');
    bySlot(r, out).act({ type: 'vote', r: s.round, d: 0, side: 'a' });
    await r.clock.advance(400);
    assert.equal(st(r).phase, 'result');
    await r.clock.advance(RESULT_MS + 200);
  }
  assert.equal(new Set(sat).size, 3, 'everyone sat out once');
  assert.equal(r.hub.state.room.phase, 'results');
});

test('flagging hides a drawing, and its votes do not count', async () => {
  const r = await startGame(5);
  await drawAll(r);
  const s = st(r);
  const duel = s.duels[0];
  const target = drawingId(s.run, s.round, duel[0]);
  const judges = r.engines.map((e) => e.snapshot().meSlot).filter((x) => x !== s.seats[duel[0]] && x !== s.seats[duel[1]]);
  assert.ok(sketchduel.drawings({ get: (k) => r.hub.state[k] }).some((x) => x.d === target));
  for (const j of judges) bySlot(r, j).flag(target);
  await r.clock.advance(600);
  const after = st(r);
  assert.ok(after.hid.includes(target));
  assert.ok(!r.hub.state[inkKey(duel[0])], 'the ink is wiped');
  for (const j of judges) bySlot(r, j).act({ type: 'vote', r: after.round, d: 0, side: 'a' });
  await r.clock.advance(400);
  const res = st(r).res;
  assert.equal(res.a, 0);
  assert.notEqual(res.win, 'a');
});

test('the host leaving mid-vote restarts that vote, ink and all', async () => {
  const r = await startGame(4);
  await drawAll(r);
  const s = st(r);
  r.hub.leave(r.engines[0].snapshot().me);
  await r.clock.advance(2000);
  const after = st(r);
  assert.ok(after.phase === 'vote' || after.phase === 'result');
  if (after.phase === 'vote') assert.equal(after.note, 'host');
  assert.ok(Object.keys(r.hub.state).some((k) => k.startsWith(INK_PREFIX) && r.hub.state[k]));
  assert.equal(after.round, s.round);
});

test('too few players ends the game gracefully', async () => {
  const r = await startGame(3);
  r.hub.leave(r.engines[2].snapshot().me);
  r.hub.leave(r.engines[1].snapshot().me);
  await r.clock.advance(1000);
  assert.equal(st(r).phase, 'lost');
  await r.clock.advance(7000);
  assert.equal(r.hub.state.room.phase, 'results');
});

test('a full room of eight artists stays inside the value and state limits', async () => {
  const r = await startGame(12);
  const s = st(r);
  assert.equal(s.seats.length, MAX_DUELS * 2);
  for (const [seat, slot] of s.seats.entries()) {
    const v = bigInk(s.k);
    assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES);
    assert.equal(bySlot(r, slot).direct(inkKey(seat), v), true, `seat ${seat}`);
    await r.clock.advance(200);
  }
  await r.clock.advance(1000);
  assert.ok(stateBytes(r.hub.state) <= MAX_STATE_BYTES, `${stateBytes(r.hub.state)} bytes`);
  assert.ok(jsonBytes(st(r)) <= MAX_VALUE_BYTES);
});

test('text helpers and moments', () => {
  assert.match(headline({ phase: 'draw', drawing: true, mineDone: false }), /Draw this word/);
  assert.match(headline({ phase: 'draw', drawing: false }), /judge/);
  const d = { mySide: null, myVote: null, voted: 1, judges: 2, a: { who: { name: 'A', isMe: false }, pts: 0 }, b: { who: { name: 'B', isMe: false }, pts: 0 }, win: 'b', none: false };
  assert.match(footText({ phase: 'vote', duel: d }), /1 of 2 judges/);
  assert.match(footText({ phase: 'result', duel: d }), /B wins/);
  const was = duelMoments(null, { run: 1, round: 0, phase: 'draw', duel: null, doneCount: 0, drawing: true }).now;
  assert.deepEqual(duelMoments(was, { run: 1, round: 0, phase: 'vote', duel: { i: 0 }, doneCount: 0 }).cues, ['whoosh']);
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

test('the view shows the word to artists, the lineup to judges, and two vote buttons in the duel', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame(3);
  const views = r.engines.map((engine) => {
    const v = createSketchduelView({ engine, fx: { confetti() {} }, toast() {}, win: {}, cues: { play() {}, burst() {}, float() {} } });
    engine.on('change', (snap) => v.update(snap));
    v.update(engine.snapshot());
    return v;
  });
  const s = st(r);
  const judgeIx = r.engines.findIndex((e) => !s.seats.includes(e.snapshot().meSlot));
  const artistIx = r.engines.findIndex((e) => e.snapshot().meSlot === s.seats[0]);
  assert.ok(views[artistIx].el.querySelector('.sketchduel-word'));
  assert.equal(views[judgeIx].el.querySelector('.sketchduel-word'), null);
  assert.ok(views[judgeIx].el.querySelector('.sketchduel-lineup'));
  await drawAll(r);
  views[judgeIx].update(r.engines[judgeIx].snapshot());
  const btn = byKey(views[judgeIx].el, 'duel-vote-a');
  assert.ok(btn);
  assert.equal(btn.disabled, false);
  assert.equal(byKey(views[artistIx].el, 'duel-vote-a').disabled, true);
  btn.click();
  await r.clock.advance(500);
  assert.equal(st(r).phase, 'result');
  for (const v of views) for (const n of all(v.el)) assert.equal(n.hasAttribute && n.hasAttribute('style'), false);
  for (const v of views) v.destroy();
});
