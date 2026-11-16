import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { room } from './activity-kit.test.js';
import { createHarness } from './helpers.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import { configureAdmins, resetAdmins, RESULTS_ENDPOINT, PACK_ENDPOINT, loadDaily, cachedDaily, sendDaily, dailyTop, sendResults, utcDay } from '../web/activity/js/admin.js';
import { OPS_MAX, OPS_WINDOW_MS, MAX_STATE_BYTES, MAX_KEYS, MAX_VALUE_BYTES, stateBytes, jsonBytes } from '../web/activity/js/limits.js';
import { decodeTerm, findBlocked } from '../web/activity/js/filter.js';
import bluff, { KEY as BLUFF, seal, optionsFrom, revealMs } from '../web/activity/js/games/bluff.js';
import { factById } from '../web/activity/data/bluff.js';
import pixel, { KEY as PIXEL, COUNTS, CELLS, PALETTE, CHEER_MS, SHOW_MS, encodeCells, readGrid } from '../web/activity/js/games/pixel.js';
import higherlower, { KEY as HL, REVEAL_MS, higherSide } from '../web/activity/js/games/higherlower.js';
import trivia from '../web/activity/js/games/trivia.js';
import draw, { codeWord } from '../web/activity/js/games/draw.js';
import hive, { KEY as HIVE, veil, useTimers } from '../web/activity/js/games/hive.js';
import { teamTotals, teamWinners, teamBoard, evenOut, finalText } from '../web/activity/js/games/teams.js';
import { boostText, teamBar } from '../web/activity/js/views/teams.js';
import { questionById } from '../web/activity/data/trivia.js';
import { installDom } from './dom-shim.js';
import { myLine } from '../web/activity/js/ui/daily.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACT = path.join(here, '..', 'web', 'activity');
const WORDS_TXT = readFileSync(path.join(ACT, 'data', 'words.txt'), 'utf8');
await dictionary.load(() => Promise.resolve(WORDS_TXT));

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function slotsOf(r) {
  return r.engines.map((e) => e.snapshot().meSlot).filter(Number.isInteger);
}

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else e.join();
}

function quietNet() {
  const posts = [];
  configureAdmins({
    win: null,
    refreshMs: 0,
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  return posts;
}

async function startGame(game, n, settings = {}) {
  const r = room(n, { games: [game] });
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(game.id), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  const res = host.lobby.start();
  if (!res.ok) return { r, res };
  await r.clock.advance(400);
  return { r, res };
}

function checkLimits(r) {
  assert.deepEqual(r.hub.violations, [], 'no op, size or key limit was hit');
  assert.ok(stateBytes(r.hub.state) <= MAX_STATE_BYTES);
  assert.ok(Object.keys(r.hub.state).length <= MAX_KEYS);
  for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, k);
  const ids = [...new Set(r.hub.ops.map((o) => o.id))];
  const end = r.clock.now();
  for (const id of ids) {
    for (let t = r.hub.ops[0].at; t < end; t += 1000) assert.ok(r.hub.opsBy(id, t, t + OPS_WINDOW_MS) <= OPS_MAX, `ops for ${id}`);
  }
}

async function swapHost(r) {
  const old = r.engines[0];
  const id = old.snapshot().me;
  r.hub.leave(id);
  if (typeof old.destroy === 'function') old.destroy();
  r.engines.splice(0, 1);
  await r.clock.advance(1500);
  return r.engines[0];
}

function stB(r) {
  return r.hub.state[BLUFF];
}

function fake(e, text) {
  const s = e.snapshot().state[BLUFF];
  return e.act({ type: 'fake', n: s.n, code: seal(text, s.nonce) });
}

async function bluffRound(r, round, { pickTruth = () => true } = {}) {
  const s = stB(r);
  assert.equal(s.phase, 'write');
  const f = factById(s.f.id);
  for (const slot of slotsOf(r)) fake(bySlot(r, slot), `zorp ${round} ${slot}`);
  await r.clock.advance(800);
  const p = stB(r);
  assert.equal(p.phase, 'pick', `round ${round} reaches the pick phase`);
  const opts = optionsFrom((k) => r.hub.state[k], p);
  const truth = opts.find((o) => o.text === f.a);
  assert.ok(truth);
  for (const slot of slotsOf(r)) {
    const other = opts.find((o) => o.text !== f.a && o.text !== `zorp ${round} ${slot}`);
    bySlot(r, slot).act({ type: 'pick', n: p.n, id: pickTruth(slot) ? truth.id : other.id });
  }
  await r.clock.advance(800);
  const v = stB(r);
  assert.equal(v.phase, 'reveal');
  await r.clock.advance(revealMs(v.count) + 400);
}

test('Bluff needs 3 players, and a full 8-player game stays inside every limit', async (t) => {
  const posts = quietNet();
  t.after(resetAdmins);
  const one = await startGame(bluff, 1, { rounds: 5 });
  assert.equal(one.res.ok, false, 'one player cannot start Bluff');
  for (const n of [3, 8]) {
    const { r } = await startGame(bluff, n, { rounds: 5 });
    assert.equal(stB(r).in.length, n);
    for (let round = 1; round <= 5; round += 1) await bluffRound(r, round, { pickTruth: (slot) => slot % 2 === 0 });
    const snap = r.engines[0].snapshot();
    assert.equal(snap.room.phase, 'results');
    assert.ok(snap.room.last.winners.length >= 1);
    checkLimits(r);
  }
  await new Promise((done) => setImmediate(done));
  const sent = posts.filter((p) => p.url === RESULTS_ENDPOINT);
  assert.equal(sent.length, 2, 'the 3 and 8 player games post results, the 1 player attempt does not');
  assert.equal(sent[1].body.players.length, 8);
  assert.equal(sent[1].body.game, 'bluff');
});

test('Bluff survives the host leaving while writing and while picking', async (t) => {
  quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(bluff, 4, { rounds: 5 });
  const first = stB(r);
  const slots = slotsOf(r);
  fake(bySlot(r, slots[1]), 'pickled socks');
  await r.clock.advance(400);
  const host = await swapHost(r);
  let s = stB(r);
  assert.equal(s.phase, 'write');
  assert.ok(s.n > first.n, 'the round restarts so nobody loses a hidden fake');
  assert.equal(s.note, 'host');
  assert.equal(s.done.length, 0);
  for (const slot of slotsOf(r)) fake(bySlot(r, slot), `fib ${slot}`);
  await r.clock.advance(800);
  s = stB(r);
  assert.equal(s.phase, 'pick');
  await swapHost(r);
  s = stB(r);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.lost, true);
  assert.ok(s.truth !== null, 'the truth is still shown');
  const m = bluff.model(r.engines[0].snapshot(), {});
  assert.equal(m.lost, true);
  await r.clock.advance(revealMs(s.count) + 400);
  assert.equal(stB(r).phase, 'write');
  assert.ok(host);
  checkLimits(r);
});

test('a late Bluff joiner writes when there is time, or waits and still picks', async (t) => {
  quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(bluff, 3, { rounds: 5, timer: 60 });
  const late = r.add(4);
  joinIn(late);
  await r.clock.advance(1000);
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  assert.ok(stB(r).in.includes(slot), 'early in the round the newcomer can write');
  for (const s of slotsOf(r)) fake(bySlot(r, s), `bluffing ${s}`);
  await r.clock.advance(800);
  assert.equal(stB(r).phase, 'pick');
  assert.equal(optionsFrom((k) => r.hub.state[k], stB(r)).length, 5);
  await r.clock.advance(40000);
  await r.clock.advance(revealMs(5) + 400);
  const s = stB(r);
  assert.equal(s.phase, 'write');
  await r.clock.advance(s.ends - r.clock.now() - 4000);
  const later = r.add(5);
  joinIn(later);
  await r.clock.advance(1000);
  const slot5 = later.snapshot().meSlot;
  const w = stB(r);
  assert.ok(w.wait.includes(slot5), 'joining in the last seconds waits for the pick phase');
  assert.equal(bluff.model(later.snapshot(), {}).waiting, true);
  await r.clock.advance(6000);
  const p = stB(r);
  assert.ok(p.phase === 'pick' || p.phase === 'reveal');
  if (p.phase === 'pick') assert.ok(p.in.includes(slot5), 'the waiting player can pick');
  checkLimits(r);
});

test('Bluff fakes with slurs are hidden, and every fake can be flagged', async (t) => {
  const posts = quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(bluff, 3, { rounds: 5 });
  const slots = slotsOf(r);
  const slur = decodeTerm('iondxn');
  assert.ok(findBlocked(slur).length > 0);
  fake(bySlot(r, slots[0]), `a ${slur} parade`);
  fake(bySlot(r, slots[1]), 'a tiny hat');
  fake(bySlot(r, slots[2]), 'a big spoon');
  await r.clock.advance(800);
  const s = stB(r);
  assert.equal(s.phase, 'pick');
  const opts = optionsFrom((k) => r.hub.state[k], s);
  assert.ok(opts.every((o) => !findBlocked(o.text).length), 'no slur reaches shared state');
  assert.ok(!JSON.stringify(r.hub.state).toLowerCase().includes(slur.toLowerCase()));
  const texts = bluff.texts({ get: (k) => r.engines[0].snapshot().state[k] ?? null, memory: {}, keys: () => [] });
  assert.ok(Array.isArray(texts));
  const reporter = bySlot(r, slots[1]);
  const hostTexts = [];
  for (const o of opts) if (o.text === 'a big spoon') hostTexts.push(o);
  assert.equal(hostTexts.length, 1);
  const ref = `bluff.${s.n}.${s.nonce}.${hostTexts[0].id}`;
  assert.equal(reporter.report(ref), 'sent');
  await r.clock.advance(800);
  await new Promise((done) => setImmediate(done));
  const rep = posts.find((p) => p.body && p.body.kind === 'text');
  assert.ok(rep, 'the flag reaches yapos.dev');
  assert.equal(rep.body.game, 'bluff');
  assert.equal(rep.body.text, 'a big spoon');
  assert.match(rep.body.context, /^Fact: /);
  assert.equal(rep.body.author.id, bySlot(r, slots[2]).snapshot().me);
});

function paint(e, cells) {
  const s = e.snapshot().state[PIXEL];
  return e.act({ type: 'paint', n: s.n, c: encodeCells(cells) });
}

test('Pixel Art plays with 1, 3 and 8 painters and never breaks the op or state limits', async (t) => {
  const posts = quietNet();
  t.after(resetAdmins);
  for (const n of [1, 3, 8]) {
    const { r } = await startGame(pixel, n, { timer: 120 });
    assert.equal(r.hub.state[PIXEL].phase, 'paint');
    for (let tick = 0; tick < 120; tick += 1) {
      for (const e of r.engines) {
        const slot = e.snapshot().meSlot;
        const base = (tick * 17 + slot * 71) % CELLS;
        paint(e, Array.from({ length: 16 }, (_, i) => [(base + i * 5) % CELLS, PALETTE[(tick + i + slot) % PALETTE.length].code]));
      }
      await r.clock.advance(250);
    }
    await r.clock.advance(3000);
    const counts = r.hub.state[COUNTS];
    for (const slot of slotsOf(r)) assert.ok(counts[slot] > 0, `slot ${slot} painted`);
    const g = readGrid((k) => r.hub.state[k]);
    assert.equal(g.length, CELLS);
    assert.ok(/[1-9a-c]/.test(g));
    for (let i = 0; i < 300 && r.hub.state[PIXEL].phase === 'paint'; i += 1) await r.clock.advance(1000);
    const c = r.hub.state[PIXEL];
    assert.equal(c.phase, 'cheer');
    for (const e of r.engines) e.act({ type: 'cheer', n: c.n });
    await r.clock.advance(CHEER_MS + 400);
    assert.equal(r.hub.state[PIXEL].phase, 'show');
    await r.clock.advance(SHOW_MS + 400);
    assert.equal(r.engines[0].snapshot().room.phase, 'results');
    checkLimits(r);
  }
  await new Promise((done) => setImmediate(done));
  const sent = posts.filter((p) => p.url === RESULTS_ENDPOINT);
  assert.deepEqual(sent.map((p) => p.body.players.length), [3, 8]);
});

test('Pixel Art keeps the picture through a host change and lets late joiners paint', async (t) => {
  quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(pixel, 3, { timer: 120 });
  const slots = slotsOf(r);
  paint(bySlot(r, slots[1]), Array.from({ length: 30 }, (_, i) => [i, '4']));
  await r.clock.advance(600);
  const before = readGrid((k) => r.hub.state[k]);
  await swapHost(r);
  const s = r.hub.state[PIXEL];
  assert.equal(s.phase, 'paint');
  assert.equal(readGrid((k) => r.hub.state[k]), before, 'the canvas is untouched');
  const late = r.add(4);
  joinIn(late);
  await r.clock.advance(1000);
  assert.equal(pixel.model(late.snapshot()).canPaint, true);
  paint(late, [[300, '9'], [301, '9'], [302, '9'], [303, '9'], [304, '9']]);
  await r.clock.advance(800);
  assert.equal(readGrid((k) => r.hub.state[k])[300], '9');
  assert.equal(r.hub.state[COUNTS][late.snapshot().meSlot], 5);
  await r.clock.advance(120000 + CHEER_MS + SHOW_MS + 2000);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  checkLimits(r);
});

function stH(r) {
  return r.hub.state[HL];
}

test('Higher or Lower plays full games with 1, 3 and 8 players', async (t) => {
  quietNet();
  t.after(resetAdmins);
  for (const n of [1, 3, 8]) {
    const { r } = await startGame(higherlower, n, { rounds: 5, timer: 10 });
    for (let round = 0; round < 5; round += 1) {
      const s = stH(r);
      assert.equal(s.phase, 'guess');
      assert.equal(s.vals, null, 'the numbers stay hidden while guessing');
      const right = higherSide(s.a.id, s.b.id);
      for (const slot of slotsOf(r)) bySlot(r, slot).act({ type: 'pick', side: slot % 3 === 0 ? (right === 'a' ? 'b' : 'a') : right, r: s.r });
      await r.clock.advance(600);
      assert.equal(stH(r).phase, 'reveal', 'everyone picked, so it reveals early');
      await r.clock.advance(REVEAL_MS + 400);
    }
    assert.equal(r.engines[0].snapshot().room.phase, 'results');
    checkLimits(r);
  }
});

test('Higher or Lower re-asks the round after a host change and admits late joiners', async (t) => {
  quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(higherlower, 3, { rounds: 5, timer: 15 });
  const s0 = stH(r);
  bySlot(r, slotsOf(r)[1]).act({ type: 'pick', side: 'a', r: s0.r });
  await r.clock.advance(300);
  await swapHost(r);
  const s1 = stH(r);
  assert.equal(s1.phase, 'guess');
  assert.equal(s1.note, 'host');
  assert.deepEqual(s1.done, []);
  const late = r.add(4);
  joinIn(late);
  await r.clock.advance(1000);
  const slot = late.snapshot().meSlot;
  assert.ok(stH(r).in.includes(slot));
  for (const sl of slotsOf(r)) bySlot(r, sl).act({ type: 'pick', side: 'a', r: stH(r).r });
  await r.clock.advance(600);
  assert.equal(stH(r).phase, 'reveal');
  await r.clock.advance(120000);
  assert.equal(r.engines[0].snapshot().room.phase, 'results');
  checkLimits(r);
});

test('uneven teams are evened out so the bigger team does not win just by size', () => {
  const tm = { 1: 'r', 2: 'r', 3: 'b' };
  assert.deepEqual(teamTotals(tm, { 1: 500, 2: 500, 3: 500 }), { r: 1000, b: 1000 });
  assert.equal(teamWinners(tm, { 1: 500, 2: 500, 3: 500 }).win, null);
  assert.equal(teamWinners(tm, { 1: 500, 2: 500, 3: 600 }).win, 'b');
  assert.deepEqual(teamWinners(tm, { 1: 500, 2: 500, 3: 600 }).slots, [3]);
  assert.equal(evenOut(100, 2, 3), 150);
  assert.equal(evenOut(100, 3, 3), 100);
  const players = [1, 2, 3].map((slot) => ({ slot, id: `p${slot}`, name: `P${slot}`, present: true, isMe: slot === 3, game: 0 }));
  const board = teamBoard(tm, players, { g: { 1: 300, 2: 300, 3: 400 } }, 3);
  assert.equal(board[1].pts, 800);
  assert.deepEqual(board[1].boost, { size: 1, of: 2 });
  assert.equal(board[0].boost, null);
  assert.equal(finalText(board), '🟦 Blue team wins!');
  assert.equal(boostText(board[1]), 'Smaller team, so points count ×2');
  assert.equal(boostText(board[0]), '');
  assert.equal(boostText({ boost: { size: 2, of: 3 } }), 'Smaller team, so points count ×1.5');
  installDom({ url: 'https://yapos.dev/activity/' });
  const el = teamBar(board);
  assert.match(el.textContent, /Smaller team, so points count ×2/);
});

test('team Trivia with 3 and 8 players: balanced teams and fair team winners', async (t) => {
  const posts = quietNet();
  t.after(resetAdmins);
  for (const n of [3, 8]) {
    const { r } = await startGame(trivia, n, { teams: 'two', rounds: 5, timer: 10 });
    const host = r.engines[0];
    const tm = host.snapshot().state.trivia.tm;
    const sizes = ['r', 'b'].map((id) => Object.values(tm).filter((x) => x === id).length);
    assert.ok(Math.abs(sizes[0] - sizes[1]) <= 1);
    assert.equal(sizes[0] + sizes[1], n);
    for (let q = 0; q < 5; q += 1) {
      const st = host.snapshot().state.trivia;
      const right = st.q.options.indexOf(questionById(st.q.id).a);
      for (const slot of slotsOf(r)) bySlot(r, slot).act({ type: 'answer', i: right, q: st.q.id });
      await r.clock.advance(400);
      await r.clock.advance(5200);
    }
    assert.equal(host.snapshot().state.trivia.phase, 'final');
    const m = trivia.model(host.snapshot());
    const [a, b] = m.teams.map((x) => x.pts);
    assert.ok(Math.abs(a - b) / Math.max(a, b) < 0.03, `everyone answered alike, so the teams end level (${a} vs ${b})`);
    assert.equal(m.teams.some((x) => x.boost), n % 2 === 1);
    await r.clock.advance(7000);
    const snap = host.snapshot();
    assert.equal(snap.room.phase, 'results');
    assert.ok(snap.room.last.winners.length >= Math.floor(n / 2));
    checkLimits(r);
  }
  await new Promise((done) => setImmediate(done));
  assert.equal(posts.filter((p) => p.url === RESULTS_ENDPOINT).length, 2);
});

test('team Draw & Guess with 3 players plays through to a team result', async (t) => {
  quietNet();
  t.after(resetAdmins);
  const { r } = await startGame(draw, 3, { teams: 'two', rounds: 1 });
  const host = r.engines[0];
  for (let turn = 0; turn < 3; turn += 1) {
    let st = host.snapshot().state.draw;
    if (st.phase !== 'pick') break;
    bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
    await r.clock.advance(500);
    st = host.snapshot().state.draw;
    assert.equal(st.phase, 'draw');
    const word = codeWord(st.w, st.nonce);
    for (const slot of slotsOf(r)) if (slot !== st.drawer) bySlot(r, slot).act({ type: 'guess', text: word });
    await r.clock.advance(800);
    for (let i = 0; i < 40 && host.snapshot().state.draw.phase === 'reveal'; i += 1) await r.clock.advance(500);
  }
  for (let i = 0; i < 40 && host.snapshot().state.draw && host.snapshot().state.draw.phase !== 'final'; i += 1) await r.clock.advance(1000);
  const view = draw.model(host.snapshot());
  assert.equal(view.phase, 'final');
  assert.ok(view.teams.some((t2) => t2.boost), 'the 1-player team is evened out');
  await r.clock.advance(8000);
  assert.equal(host.snapshot().room.phase, 'results');
  checkLimits(r);
});

test('a Trivia pack that fails to load falls back to built-in questions', async (t) => {
  configureAdmins({
    win: null,
    refreshMs: 0,
    fetch: async (url) => {
      if (String(url).startsWith(PACK_ENDPOINT)) throw new Error('offline');
      return { ok: false, json: async () => ({}) };
    },
  });
  t.after(resetAdmins);
  const { r } = await startGame(trivia, 3, { pack: 'ZZZZ9999', rounds: 5 });
  await r.clock.advance(7000);
  const st = r.hub.state.trivia;
  assert.equal(st.phase, 'question');
  assert.equal(st.pk, null);
  assert.equal(st.pm, 'ZZZZ9999');
  assert.ok(questionById(st.q.id), 'a built-in question is asked');
  assert.match(trivia.model(r.engines[1].snapshot()).packMiss, /ZZZZ9999/);
});

function workerNet(h, r) {
  Object.defineProperty(h.clock, 't', { get: () => r.clock.now(), set() {}, configurable: true });
  const seen = [];
  configureAdmins({
    win: null,
    refreshMs: 0,
    now: () => r.clock.now(),
    fetch: async (url, init = {}) => {
      seen.push(`${init.method || 'GET'} ${url}`);
      const headers = { ...(init.headers || {}), Origin: h.base };
      return h.request(init.method || 'GET', String(url), { headers, body: init.body, ip: '198.51.100.44' });
    },
  });
  return seen;
}

function dailyWorker() {
  const assets = {
    async fetch(request) {
      const u = new URL(request.url);
      if (u.pathname === '/activity/data/words.txt') return new Response(WORDS_TXT, { status: 200 });
      return new Response('missing', { status: 404 });
    },
  };
  return createHarness({ ASSETS: assets, PARTY_OWNER_ID: '2c416a35-eac2-4e0e-a310-8648b5ecd7af' });
}

test('daily Letter Hive end to end: the puzzle comes from the Worker, and the Worker scores it like the game', async (t) => {
  const h = dailyWorker();
  const r = room(3, { games: [hive] });
  useTimers(r.clock);
  t.after(() => useTimers(null));
  const seen = workerNet(h, r);
  t.after(resetAdmins);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('hive'), true);
  assert.equal(host.lobby.setting('daily', true), true);
  const day = utcDay(r.clock.now());
  await loadDaily(day);
  assert.ok(cachedDaily(day), 'the Worker served today’s puzzle');
  assert.ok(seen.some((s) => s.startsWith('GET /api/activity/daily')));
  assert.equal(host.lobby.start().ok, true);
  for (let i = 0; i < 20 && (!r.hub.state[HIVE] || r.hub.state[HIVE].phase !== 'play'); i += 1) {
    await r.clock.advance(600);
    await new Promise((done) => setImmediate(done));
  }
  const st = r.hub.state[HIVE];
  assert.equal(st.phase, 'play');
  assert.equal(st.daily, day);
  const puzzle = cachedDaily(day);
  assert.equal(st.l, puzzle.hive.letters);
  assert.equal(st.c, puzzle.hive.centre);
  const { hiveWords } = await import('../web/activity/js/games/hive.js');
  const words = hiveWords(st.l, st.c);
  assert.ok(words.length > 3);
  const plan = { 0: words.slice(0, 3), 1: words.slice(1, 2), 2: [] };
  const slots = slotsOf(r);
  slots.forEach((slot, i) => {
    plan[i].forEach((w, k) => bySlot(r, slot).act({ type: 'word', id: st.id, x: veil(w, st.id), q: k + 1 }));
  });
  await r.clock.advance(1500);
  const b = r.hub.state[HIVE].b;
  for (const [i, slot] of slots.entries()) {
    const me = bySlot(r, slot).snapshot().me;
    const list = plan[i];
    const res = await sendDaily({ date: day, kind: 'hive', user: { id: me, name: `Player ${i + 1}`, username: null }, words: list, ms: 5000 });
    if (!list.length) {
      assert.equal(res, null, 'an empty daily play is not sent');
      continue;
    }
    assert.ok(res, `the Worker accepted player ${i}`);
    assert.equal(res.score, b[slot][0], 'the Worker scores the same as the game');
    assert.equal(res.streak, 1);
  }
  const top = await dailyTop('hive', { force: true });
  assert.equal(top.length, 2);
  assert.ok(top[0].score >= top[1].score);
  const again = await sendDaily({ date: day, kind: 'hive', user: { id: bySlot(r, slots[1]).snapshot().me, name: 'Player 2', username: null }, words: ['zzzzzz'], ms: 100 });
  assert.equal(again.score, 0);
  assert.equal(again.best, b[slots[1]][0], 'a worse second try never lowers the best');
  assert.match(myLine({ state: 'done', kind: 'hive', result: again }).text, new RegExp(`your best today is ${b[slots[1]][0]} points`));
});

test('results posted by the activity land in the Worker’s Party stats and XP queue', async (t) => {
  const h = dailyWorker();
  const r = room(3, { games: [higherlower] });
  workerNet(h, r);
  t.after(resetAdmins);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  host.lobby.pick('higherlower');
  host.lobby.setting('rounds', 5);
  host.lobby.start();
  await r.clock.advance(400);
  for (let round = 0; round < 5; round += 1) {
    const s = stH(r);
    const right = higherSide(s.a.id, s.b.id);
    const slots = slotsOf(r);
    bySlot(r, slots[0]).act({ type: 'pick', side: right, r: s.r });
    bySlot(r, slots[1]).act({ type: 'pick', side: right === 'a' ? 'b' : 'a', r: s.r });
    bySlot(r, slots[2]).act({ type: 'pick', side: right === 'a' ? 'b' : 'a', r: s.r });
    await r.clock.advance(600);
    await r.clock.advance(REVEAL_MS + 400);
  }
  assert.equal(host.snapshot().room.phase, 'results');
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
  const rows = h.db.raw.prepare('SELECT user_id, games, wins FROM party_stats').all();
  assert.equal(rows.length, 3);
  const winner = bySlot(r, slotsOf(r)[0]).snapshot().me;
  assert.equal(rows.find((x) => x.user_id === winner).wins, 1);
  assert.ok(rows.every((x) => x.games === 1));
  const xp = h.db.raw.prepare('SELECT user_id, xp FROM party_xp').all();
  assert.equal(xp.find((x) => x.user_id === winner).xp, 25);
  assert.equal(xp.filter((x) => x.xp === 10).length, 2);
  assert.equal(await sendResults({ game: 'higherlower', at: r.clock.now(), players: [{ id: winner, name: 'Solo', score: 1, won: true }], extra: {} }), false, 'a one-player game is never sent');
});

function sources(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) sources(p, out);
    else if (/\.(js|css|html)$/.test(name.name)) out.push(p);
  }
  return out;
}

test('the activity has no comments, no inline styles and no outside resources', () => {
  for (const file of sources(ACT)) {
    const raw = readFileSync(file, 'utf8');
    const rel = path.relative(ACT, file);
    if (file.endsWith('.css')) assert.doesNotMatch(raw, /\/\*/, `${rel} has a comment`);
    if (file.endsWith('.html')) {
      assert.doesNotMatch(raw, /<!--/, `${rel} has a comment`);
      assert.doesNotMatch(raw, /\sstyle=/, `${rel} has an inline style`);
      assert.doesNotMatch(raw, /(src|href)=["']https?:/, `${rel} loads something from outside`);
    }
    if (file.endsWith('.js')) {
      assert.ok(!/^\s*\/\/|^\s*\/\*/m.test(raw), `${rel} has a comment`);
      assert.ok(!/\.style\.(?!setProperty|removeProperty|getPropertyValue)[a-zA-Z]+\s*=|cssText|setAttribute\(\s*['"]style['"]/.test(raw), `${rel} sets an inline style`);
      assert.ok(!/https?:\/\/(?!yapos\.dev|www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw), `${rel} reaches an outside site`);
    }
  }
});
