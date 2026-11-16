import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room, seeded } from './activity-kit.test.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import { configureAdmins } from '../web/activity/js/admin.js';
import { FUN, ROOM, SCORES } from '../web/activity/js/engine.js';
import { MAX_STATE_BYTES, MAX_KEYS, MAX_VALUE_BYTES, stateBytes, jsonBytes } from '../web/activity/js/limits.js';
import { unmask } from '../web/activity/js/games/draw.js';
import { questionById, YEAR } from '../web/activity/data/closest.js';
import { STYLES, DIFFS, STEPS, JACK_SECS, TAIL_SECS, buildSong, stepTime, songFor, createRun, lastNoteAt } from '../web/activity/js/games/beatchart.js';
import typerace, { KEY as TR, IDLE_AFTER_MS, IDLE_CALL_MS } from '../web/activity/js/games/typerace.js';
import memory, { KEY as MEM, MAX_ROUNDS, unmaskSeq } from '../web/activity/js/games/memory.js';
import closest from '../web/activity/js/games/closest.js';
import name5, { UNIQUE_POINTS, SHARED_POINTS } from '../web/activity/js/games/name5.js';
import beatdrop, { POINT_DIV } from '../web/activity/js/games/beatdrop.js';

const WORDS_TXT = readFileSync(new URL('../web/activity/data/words.txt', import.meta.url), 'utf8');
await dictionary.load(() => Promise.resolve(WORDS_TXT));
configureAdmins({ win: null, refreshMs: 0, fetch: async () => ({ ok: false, json: async () => ({}) }) });

const BY_LETTER = {};
for (const w of WORDS_TXT.split(/\r?\n/)) if (/^[a-z]{3,10}$/.test(w)) (BY_LETTER[w[0]] = BY_LETTER[w[0]] || []).push(w);
const KEYS = { typerace: 'typerace', memory: 'memory', closest: 'closest', namefive: 'name5', beatdrop: 'beatdrop' };
const SKILL = { good: { wpm: 80, mem: 0.99, spread: 0.25, fill: 0.95, sig: 0.02, miss: 0.02 }, avg: { wpm: 50, mem: 0.965, spread: 0.6, fill: 0.75, sig: 0.05, miss: 0.08 }, slow: { wpm: 28, mem: 0.93, spread: 1.2, fill: 0.5, sig: 0.08, miss: 0.2 } };

function gauss(R) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, R()))) * Math.cos(2 * Math.PI * R());
}

function step(p, game, now, R) {
  if (p.skill === 'afk') return;
  const snap = p.e.snapshot();
  const st = snap.state[KEYS[game.id]];
  const me = snap.meSlot;
  if (!st || snap.room.phase !== 'game' || !Number.isInteger(me)) return;
  const sk = SKILL[p.skill];
  const m = p.m;
  if (game.id === 'typerace') {
    if (st.phase !== 'race' || !st.ps[me] || st.ps[me][1] !== 0 || m.sent === st.n || now < st.go) return;
    if (m.n !== st.n) Object.assign(m, { n: st.n, start: now, dur: (st.text.length / 5 / sk.wpm) * 60000, prog: 0 });
    if (now - m.start >= m.dur) {
      m.sent = st.n;
      p.e.act({ type: 'done', n: st.n, t: st.text, ms: now - st.go, e: 1 });
    } else if (now - m.prog >= 500) {
      m.prog = now;
      p.e.act({ type: 'prog', n: st.n, c: Math.floor(((now - m.start) / m.dur) * (st.text.length - 1)) });
    }
  } else if (game.id === 'memory') {
    const row = st.ps[me];
    if (st.phase !== 'input' || !row || row[0] <= 0 || row[1] !== 0 || m.sent === st.r) return;
    if (m.r !== st.r) Object.assign(m, { r: st.r, at: now + 500 + 280 * st.len });
    if (now < m.at) return;
    m.sent = st.r;
    const seq = unmaskSeq(st.sq, st.k);
    if (seq.some(() => R() > sk.mem)) seq[0] = (seq[0] + 1) % 4;
    p.e.act({ type: 'try', r: st.r, s: seq.join('') });
  } else if (game.id === 'closest') {
    if (st.phase !== 'guess' || m.sent === st.n) return;
    if (m.n !== st.n) Object.assign(m, { n: st.n, at: now + 2000 + R() * 8000 });
    if (now < m.at) return;
    m.sent = st.n;
    const q = questionById(unmask(st.deck[st.i], st.k));
    const v = q.unit === YEAR || q.span ? Math.round(q.a + gauss(R) * sk.spread * (q.span || 50)) : Math.max(0, Math.round(q.a * Math.exp(gauss(R) * sk.spread)));
    p.e.act({ type: 'guess', n: st.n, v });
  } else if (game.id === 'namefive') {
    if (st.phase === 'write') {
      if (m.n !== st.n) {
        const pool = BY_LETTER[st.l.toLowerCase()] || ['x'];
        Object.assign(m, { n: st.n, at: now + (p.skill === 'good' ? 18000 : 30000) + R() * 15000, last: now, done: false, rq: st.rq || 0 });
        m.a = [0, 1, 2, 3, 4].map((c) => (R() < sk.fill ? pool[(c * 7 + Math.floor(R() * 6)) % pool.length] : ''));
      }
      if ((st.rq || 0) !== m.rq) {
        m.rq = st.rq || 0;
        p.e.act({ type: 'save', n: st.n, a: m.done ? m.a : ['', '', '', '', ''], done: m.done });
      }
      if (m.done) return;
      if (now >= m.at) {
        m.done = true;
        p.e.act({ type: 'save', n: st.n, a: m.a, done: true });
      } else if (now - m.last >= 2500) {
        m.last = now;
        p.e.act({ type: 'save', n: st.n, a: m.a.map((x, c) => (c < 2 ? x : '')), done: false });
      }
    } else if (st.phase === 'review' && m.ok !== st.n) {
      if (m.rv !== st.n) Object.assign(m, { rv: st.n, at: now + 4000 + R() * 10000 });
      if (now < m.at) return;
      m.ok = st.n;
      p.e.act({ type: 'ok', n: st.n });
    }
  } else if (game.id === 'beatdrop') {
    if (st.phase === 'ready') {
      if (m.rd !== st.n) Object.assign(m, { rd: st.n, at: now + 1000 + R() * 4000 });
      if (now >= m.at && !(st.rd || []).includes(me) && m.rs !== st.n) {
        m.rs = st.n;
        p.e.act({ type: 'ready', n: st.n });
      }
      return;
    }
    if (st.phase !== 'play' || !(st.in || []).includes(me) || m.sent === st.n || st.at === null) return;
    if (m.n !== st.n) {
      const song = songFor(st.seed, st.sty, st.df, st.len);
      const presses = song.notes.filter(() => R() >= sk.miss).map((x) => ({ t: x.t + gauss(R) * sk.sig, l: x.l })).sort((a, b) => a.t - b.t);
      Object.assign(m, { n: st.n, song, run: createRun(song, { from: (Number(st.jt && st.jt[me]) || 0) / 1000 }), presses, pi: 0, prog: now });
    }
    const t = (now - st.at) / 1000;
    while (m.pi < m.presses.length && m.presses[m.pi].t <= t) {
      const x = m.presses[m.pi++];
      m.run.press(x.l, x.t);
    }
    m.run.tick(t);
    if (now - m.prog >= 3000 && t > 0) {
      m.prog = now;
      p.e.act({ type: 'prog', n: st.n, s: m.run.stats.s, c: m.run.stats.c, j: m.run.judged });
    }
    if (m.run.done && t > lastNoteAt(m.song) + 0.2) {
      m.sent = st.n;
      p.e.act({ type: 'done', n: st.n, ...m.run.final() });
    }
  }
}

function junk(R, game, st) {
  const types = { typerace: ['prog', 'done'], memory: ['try'], closest: ['guess'], namefive: ['save', 'veto', 'ok'], beatdrop: ['ready', 'prog', 'done'] }[game.id];
  const n = st && R() < 0.7 ? st.n : Math.floor(R() * 5);
  return { type: types[Math.floor(R() * types.length)], n, r: st ? st.r : 0, c: Math.floor(R() * 900) - 50, t: 'nope', ms: Math.floor(R() * 9000), e: 3, s: String(Math.floor(R() * 4000)), v: R() < 0.5 ? Math.floor(R() * 1e6) : 'lots', a: ['x'.repeat(80), 7, '', 'ok', 'ok'], done: R() < 0.5, on: true, j: Math.floor(R() * 900), p: 99, g: 0, o: 0, m: 0, k: 40 };
}

async function playtest(game, n, opts = {}) {
  const skills = ['good', 'avg', 'slow', 'avg', 'good', 'slow', 'avg', 'good'];
  const r = room(n, { games: [game], seed: opts.seed || 5 });
  const R = seeded((opts.seed || 5) + 9);
  const players = r.engines.map((e, i) => ({ e, skill: skills[i % skills.length], m: {} }));
  if (opts.afk) players[players.length - 1].skill = 'afk';
  await r.clock.advance(600);
  const host = players.find((p) => p.e.isHost()).e;
  assert.equal(host.lobby.pick(game.id), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  const t0 = r.clock.now();
  const key = KEYS[game.id];
  let finals = 0;
  let flagged = 0;
  let left = false;
  let joined = false;
  let spam = 0;
  while (r.clock.now() - t0 < 20 * 60000 && r.hub.state[ROOM].phase !== 'results') {
    const now = r.clock.now();
    for (const p of players) {
      step(p, game, now, R);
      if (!opts.chaos) continue;
      if (R() < 0.04) p.e.react(Math.floor(R() * 6));
      const s = p.e.snapshot();
      if (s.fun && s.fun.card && !s.fun.used && R() < 0.01) p.e.play(s.fun.card.id, null);
      if (R() < 0.01) p.e.act(junk(R, game, s.state[key]));
    }
    if (opts.chaos && now - spam > 7000) {
      spam = now;
      const p = players[players.length - 1];
      for (let j = 0; j < 40; j += 1) p.e.act(junk(R, game, p.e.snapshot().state[key]));
    }
    if (opts.late && !joined && now - t0 > 15000) {
      joined = true;
      players.push({ e: r.add(n + 1), skill: 'avg', m: {} });
    }
    if (opts.swap && !left && now - t0 > 40000) {
      left = true;
      const old = players.find((p) => p.e.isHost());
      r.hub.leave(old.e.snapshot().me);
      old.e.destroy();
      players.splice(players.indexOf(old), 1);
    }
    await r.clock.advance(100);
    const f = r.hub.state[FUN];
    const on = f && f.f ? 1 : 0;
    if (on && !flagged) finals += 1;
    flagged = on;
  }
  const label = `${game.id} x${n}`;
  assert.deepEqual(players.flatMap((p) => p.e.stats.errors), [], `${label}: engine errors`);
  assert.deepEqual(r.hub.violations.slice(0, 3), [], `${label}: op, size and key limits`);
  assert.ok(stateBytes(r.hub.state) <= MAX_STATE_BYTES && Object.keys(r.hub.state).length <= MAX_KEYS, label);
  for (const [k, v] of Object.entries(r.hub.state)) assert.ok(jsonBytes(v) <= MAX_VALUE_BYTES, `${label} ${k}`);
  assert.equal(r.hub.state[ROOM].phase, 'results', `${label} reached the results`);
  const f = r.hub.state[FUN];
  assert.ok(f && Array.isArray(f.aw) && f.aw.length > 0, `${label} hands out awards`);
  const g = r.hub.state[SCORES].g;
  const score = (p) => g[p.e.snapshot().meSlot] || 0;
  return { mins: (r.clock.now() - t0) / 60000, finals, players, score, state: r.hub.state[key] };
}

const QUICK = [typerace, memory, closest, name5, beatdrop];

for (const game of QUICK) {
  test(`${game.name} plays a full default game with 2 and 3 players in a few minutes`, async () => {
    for (const n of [2, 3]) {
      const out = await playtest(game, n, { seed: 3 + n });
      assert.ok(out.mins <= 4.5, `${game.id} x${n} took ${out.mins.toFixed(2)} min`);
      if (game.id !== 'memory') {
        assert.ok(out.mins >= 1.25, `${game.id} x${n} was over in ${out.mins.toFixed(2)} min`);
        assert.equal(out.finals, 1, `${game.id} x${n} flags the final round once`);
      }
      const best = Math.max(...out.players.map(out.score));
      assert.ok(best >= 300 && best <= 25000, `${game.id} x${n} top score ${best} sits on the usual scale`);
    }
  });

  test(`${game.name} survives 8 players with chaos, spam, an idle player, a host change and a late joiner`, async () => {
    const out = await playtest(game, 8, { seed: 17, chaos: true, afk: true, swap: true, late: true });
    assert.ok(out.mins <= 4.5, `${game.id} took ${out.mins.toFixed(2)} min`);
    assert.ok(out.finals <= 2);
  });
}

test('an idle racer does not hold up a Typing Race once everyone else is done', async () => {
  const out = await playtest(typerace, 3, { seed: 8, afk: true });
  assert.ok(out.mins < 3.5, `took ${out.mins.toFixed(2)} min`);
  assert.equal(out.score(out.players[2]), 0);
  const r = room(3, { games: [typerace] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('typerace');
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const st = () => r.hub.state[TR];
  const [a, b] = r.engines;
  await r.clock.advance(st().go - r.clock.now() + 4000);
  const s0 = st();
  b.act({ type: 'prog', n: s0.n, c: 5 });
  await r.clock.advance(300);
  const longEnds = st().ends;
  a.act({ type: 'done', n: s0.n, t: s0.text, ms: r.clock.now() - s0.go, e: 0 });
  await r.clock.advance(300);
  assert.equal(st().ends, longEnds, 'a slow typist still gets the whole clock');
  b.act({ type: 'done', n: s0.n, t: s0.text, ms: r.clock.now() - s0.go, e: 0 });
  await r.clock.advance(300);
  assert.equal(st().phase, 'race');
  assert.ok(st().ends < longEnds, 'only the idle racer is left, so the clock is cut short');
  assert.ok(st().ends <= Math.max(r.clock.now(), s0.go + IDLE_AFTER_MS) + IDLE_CALL_MS);
  await r.clock.advance(st().ends - r.clock.now() + 300);
  assert.equal(st().phase, 'show');
});

test('Memory Chain stops after its last chain, flags it as the final round and lets every survivor win', async () => {
  const r = room(2, { games: [memory] });
  await r.clock.advance(500);
  r.engines[0].lobby.pick('memory');
  r.engines[0].lobby.start();
  await r.clock.advance(300);
  const st = () => r.hub.state[MEM];
  let finals = 0;
  for (let i = 0; i < MAX_ROUNDS + 2 && r.hub.state[ROOM].phase === 'game'; i += 1) {
    await r.clock.advance(st().ends - r.clock.now() + 300);
    const s = st();
    assert.equal(s.phase, 'input');
    const f = r.hub.state[FUN];
    if (f && f.f) finals += 1;
    for (const e of r.engines) e.act({ type: 'try', r: s.r, s: unmaskSeq(s.sq, s.k).join('') });
    await r.clock.advance(600);
    assert.equal(st().phase, 'result');
    await r.clock.advance(st().ends - r.clock.now() + 300);
  }
  assert.equal(r.hub.state[ROOM].phase, 'results');
  assert.equal(st().r, MAX_ROUNDS);
  assert.equal(finals, 1);
  assert.deepEqual([...r.hub.state[ROOM].last.winners].sort(), r.engines.map((e) => e.snapshot().meSlot).sort());
});

test('Name 5 and Beat Drop points sit on the same scale as the other games', () => {
  assert.equal(UNIQUE_POINTS, 100);
  assert.equal(SHARED_POINTS * 2, UNIQUE_POINTS);
  assert.equal(POINT_DIV, 20);
  assert.equal(beatdrop.settings.find((s) => s.id === 'songs').default, 2);
  assert.equal(typerace.settings.find((s) => s.id === 'rounds').default, 5);
});

test('Beat Drop charts are playable for every style, difficulty and length across many seeds', () => {
  for (const style of STYLES) {
    for (const diff of DIFFS) {
      for (const len of [45, 90]) {
        for (let s = 1; s <= 25; s += 1) {
          const seed = (s * 2654435761) % 2147483646 || 1;
          const song = buildSong(seed, style.id, diff.id, len);
          const label = `${style.id}/${diff.id}/${len}/${seed}`;
          const grid = new Set();
          for (let k = 0; k < song.bars * STEPS; k += 1) grid.add(Math.round(stepTime(song, k) * 10000) / 10000);
          assert.ok(song.notes.length > 20, label);
          const last = [-Infinity, -Infinity, -Infinity, -Infinity];
          let prevT = -Infinity;
          let same = 0;
          for (const n of song.notes) {
            assert.ok(grid.has(n.t), `${label}: note at ${n.t} is on the beat grid`);
            assert.ok(n.t <= song.dur - TAIL_SECS, label);
            assert.ok(n.t - last[n.l] >= JACK_SECS - 1e-6, `${label}: lane ${n.l} repeats ${(n.t - last[n.l]).toFixed(3)} s apart at ${n.t}`);
            last[n.l] = n.t;
            if (n.t === prevT) {
              same += 1;
              assert.ok(same <= 1, `${label}: more than two notes at ${n.t}`);
            } else {
              assert.ok(n.t - prevT >= diff.gap - 1e-6, `${label}: notes ${(n.t - prevT).toFixed(3)} s apart at ${n.t}`);
              same = 0;
            }
            prevT = n.t;
          }
        }
      }
    }
  }
});
