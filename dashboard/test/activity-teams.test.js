import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { TEAMS, TEAM_MS, splitTeams, placeLate, teamTotals, teamWinners, teamNames, teamBoard, finalText, wantsTeams, cleanTeams } from '../web/activity/js/games/teams.js';
import { hideWord, showWord, drawablePackWords, packTrivia, packNoteText, PACK_WAIT_MS } from '../web/activity/js/games/packs.js';
import draw, { teamOrder, wordChoices, pickPackWords, codeWord, judge, mask, USED_MAX, PACK_USED_MAX } from '../web/activity/js/games/draw.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';
import trivia, { hideAnswer, showAnswer, deckWithPack, isPackId, packDeck } from '../web/activity/js/games/trivia.js';
import { questionById } from '../web/activity/data/trivia.js';
import { wordById } from '../web/activity/data/draw.js';
import { configureAdmins, resetAdmins, resetParty, RESULTS_ENDPOINT, PACK_ENDPOINT } from '../web/activity/js/admin.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { seeded } from './activity-kit.test.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/];

const PACK = {
  code: 'SPACE234',
  name: 'Space night',
  words: ['rocket ship', 'alien', 'comet', 'nebula', 'asteroid', 'moon base', '12345', 'x'],
  trivia: [
    { q: 'Which planet has the most moons?', a: 'Saturn', w: ['Mars', 'Venus', 'Mercury'] },
    { q: 'What is the closest star to Earth?', a: 'The Sun', w: ['Sirius', 'Vega', 'Polaris'] },
    { q: 'What do you call a rock that hits the ground from space?', a: 'Meteorite', w: ['Comet', 'Nebula', 'Pulsar'] },
  ],
};

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

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function joinIn(e) {
  if (e.lobby && typeof e.lobby.join === 'function') e.lobby.join();
  else if (typeof e.join === 'function') e.join();
}

function fakeNet({ packs = {}, fail = false } = {}) {
  const posts = [];
  const asked = [];
  configureAdmins({
    win: null,
    refreshMs: 0,
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (String(url).startsWith(PACK_ENDPOINT)) {
        const code = decodeURIComponent(String(url).slice(PACK_ENDPOINT.length));
        asked.push(code);
        if (fail) throw new Error('offline');
        const p = packs[code];
        return p ? { ok: true, json: async () => p } : { ok: false, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  return { posts, asked };
}

function cleanNet() {
  resetParty();
  resetAdmins();
}

async function startGame(game, n, settings = {}) {
  const r = room(n);
  await r.clock.advance(500);
  for (const e of r.engines) joinIn(e);
  await r.clock.advance(400);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(game), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

async function settle(r, ms = 1500) {
  for (let i = 0; i < ms / 100; i += 1) {
    await r.clock.advance(100);
    await new Promise((done) => setImmediate(done));
  }
}

test('players split into two balanced teams and late joiners go to the smaller one', () => {
  const tm = splitTeams([1, 2, 3, 4, 5], seeded(3));
  const counts = TEAMS.map((t) => Object.values(tm).filter((x) => x === t.id).length);
  assert.deepEqual(counts.sort(), [2, 3]);
  const small = TEAMS.find((t) => Object.values(tm).filter((x) => x === t.id).length === 2).id;
  const next = placeLate(tm, [1, 2, 3, 4, 5, 6], {});
  assert.equal(next[6], small);
  assert.equal(placeLate(next, [1, 2, 3, 4, 5, 6], {}), null);
  const tie = placeLate({ 1: 'r', 2: 'b' }, [1, 2, 3], { 1: 500, 2: 100 });
  assert.equal(tie[3], 'b', 'on a tie the newcomer helps the team that is behind');
  const away = placeLate({ 1: 'r', 2: 'r', 3: 'b', 4: 'b' }, [1, 3, 4, 5], {});
  assert.equal(away[5], 'r', 'only players still here count toward team size');
  assert.equal(cleanTeams({ 1: 'r', x: 'b', 2: 'g' })[1], 'r');
  assert.equal(cleanTeams({ x: 'b' }), null);
  assert.equal(wantsTeams({ teams: 'two' }), true);
  assert.equal(wantsTeams({ teams: 'off' }), false);
});

test('team totals add up individual points and pick the winning team', () => {
  const tm = { 1: 'r', 2: 'b', 3: 'r', 4: 'b' };
  assert.deepEqual(teamTotals(tm, { 1: 100, 2: 300, 3: 50 }), { r: 150, b: 300 });
  const w = teamWinners(tm, { 1: 100, 2: 300, 3: 50 });
  assert.equal(w.win, 'b');
  assert.deepEqual(w.slots, [2, 4]);
  const tie = teamWinners(tm, { 1: 100, 2: 100 });
  assert.equal(tie.win, null);
  assert.deepEqual(tie.slots, [1, 2, 3, 4]);
  assert.deepEqual(teamNames(tm), { 1: 'Red', 2: 'Blue', 3: 'Red', 4: 'Blue' });
  const players = [1, 2, 3, 4].map((slot) => ({ slot, id: `p${slot}`, name: `P${slot}`, present: true, isMe: slot === 3, game: 0 }));
  const board = teamBoard(tm, players, { g: { 1: 100, 2: 300, 3: 50 } }, 3);
  assert.equal(board[0].pts, 150);
  assert.equal(board[0].mine, true);
  assert.equal(board[1].lead, true);
  assert.equal(finalText(board), '🟦 Blue team wins!');
  assert.equal(finalText(teamBoard(tm, players, { g: {} }, 1)), "It's a tie between the teams!");
  assert.deepEqual(teamOrder(tm), [1, 2, 3, 4]);
  assert.deepEqual(teamOrder({ 5: 'b', 2: 'r', 7: 'b', 9: 'b' }), [2, 5, 7, 9]);
});

test('pack words are hidden in state, cleaned for drawing and mixed with built-in words', () => {
  for (const w of ['rocket ship', 'alien', "jack-o'-lantern"]) assert.equal(showWord(hideWord(w, 4242), 4242), w);
  assert.notEqual(hideWord('alien', 1), hideWord('alien', 2));
  assert.equal(hideWord('alien', 7).includes('alien'), false);
  assert.equal(showWord('zz', 1), null);
  assert.equal(codeWord(hideWord('comet', 99), 99), 'comet');
  assert.equal(codeWord(mask(5, 99), 99), wordById(5).w);
  assert.deepEqual(drawablePackWords(PACK.words), ['rocket ship', 'alien', 'comet', 'nebula', 'asteroid', 'moon base']);
  assert.deepEqual(drawablePackWords(['Comet', 'comet', '  big   bang ']), ['Comet', 'big bang']);
  const words = drawablePackWords(PACK.words);
  const mixed = wordChoices('mix', [], words, [], false, seeded(5));
  assert.equal(mixed.picks.length, 2);
  assert.equal(mixed.ids.length, 1);
  const only = wordChoices('mix', [], words, [], true, seeded(5));
  assert.equal(only.picks.length, 3);
  assert.equal(only.ids.length, 0);
  const tiny = wordChoices('easy', [], ['alien'], [], true, seeded(5));
  assert.equal(tiny.picks.length, 1);
  assert.equal(tiny.ids.length, 2, 'a tiny pack is topped up with built-in words');
  const none = wordChoices('easy', [], [], [], true, seeded(5));
  assert.equal(none.ids.length, 3);
  const fresh = pickPackWords(words, [0, 1, 2], 3, seeded(2));
  assert.deepEqual(fresh.slice().sort(), [3, 4, 5]);
  assert.equal(judge('Rocket Ship', 'rocket ship'), 'right');
});

test('pack trivia questions go first and built-in ones fill the rest', () => {
  const qs = packTrivia(PACK.trivia.concat([{ q: 'Bad', a: 'x', w: ['x', 'y', 'z'] }, { q: 'Short', a: 'a', w: ['b'] }]));
  assert.equal(qs.length, 3);
  const deck = deckWithPack(qs, null, 5, seeded(4));
  assert.equal(deck.length, 5);
  assert.ok(deck.slice(0, 3).every(isPackId));
  assert.ok(deck.slice(3).every((id) => !isPackId(id) && questionById(id)));
  assert.equal(deckWithPack(qs, null, 2, seeded(4)).every(isPackId), true);
  assert.equal(packDeck([], 5).length, 0);
  for (let a = 0; a < 4; a += 1) for (const salt of [0, 3, 999]) assert.equal(showAnswer({ options: ['a', 'b', 'c', 'd'], s: salt, x: hideAnswer(a, salt, 4) }), a);
  assert.equal(packNoteText(null, 'ABCD1234', 'questions'), "📦 Couldn't find word pack ABCD1234, so we're using the built-in questions.");
  assert.equal(packNoteText({ c: 'X', n: 'Space night' }, null), '📦 Space night');
});

test('a full team Draw & Guess turn with a pack stays inside the per-value state limit', () => {
  const nonce = 65535;
  const long = 'abcdefghijklmnopqrstuvwxyzabcd';
  const st = {
    v: 1,
    rounds: 3,
    round: 3,
    pos: 15,
    order: Array.from({ length: 16 }, (_, i) => i + 1000),
    n: 48,
    drawer: 1015,
    phase: 'draw',
    nonce,
    opts: [hideWord(long, nonce), hideWord(long, nonce), hideWord(long, nonce)],
    w: hideWord(long, nonce),
    word: long,
    got: Array.from({ length: 15 }, (_, i) => [i + 1000, 500]),
    feed: Array.from({ length: 8 }, (_, i) => [9000 + i, 1000 + i, 'x'.repeat(40), 'guess']),
    fid: 9999,
    gained: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1000, 99999])),
    used: Array.from({ length: USED_MAX }, () => 3999),
    pu: Array.from({ length: PACK_USED_MAX }, () => 499),
    tm: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1000, i % 2 ? 'b' : 'r'])),
    pk: { c: 'ABCDEFGH2345', n: 'n'.repeat(64) },
    pm: null,
    hid: 1,
    note: 'hidden',
    starts: 1_700_000_000_000,
    ends: 1_700_000_100_000,
  };
  assert.ok(jsonBytes(st) < MAX_VALUE_BYTES, String(jsonBytes(st)));
});

test('Trivia and Draw & Guess have Teams, Word pack code and Pack words only settings', () => {
  for (const g of [trivia, draw]) {
    const teams = g.settings.find((s) => s.id === 'teams');
    assert.ok(teams, g.id);
    assert.equal(teams.default, 'off');
    assert.deepEqual(teams.options.map((o) => o.value), ['off', 'two']);
    const pack = g.settings.find((s) => s.id === 'pack');
    assert.equal(pack.type, 'code');
    assert.equal(pack.label, 'Word pack code');
  }
  const only = draw.settings.find((s) => s.id === 'packOnly');
  assert.equal(only.type, 'toggle');
  assert.equal(only.label, 'Pack words only');
  assert.equal(trivia.settings.some((s) => s.id === 'packOnly'), false);
});

test('team Trivia: balanced teams, a final team screen, team winners and results posted with teams', async (t) => {
  const net = fakeNet();
  t.after(cleanNet);
  const r = await startGame('trivia', 4, { teams: 'two', rounds: 5, timer: 10 });
  const host = r.engines[0];
  let st = host.snapshot().state.trivia;
  assert.ok(st.tm);
  const reds = Object.keys(st.tm).map(Number).filter((s) => st.tm[s] === 'r');
  const blues = Object.keys(st.tm).map(Number).filter((s) => st.tm[s] === 'b');
  assert.equal(reds.length, 2);
  assert.equal(blues.length, 2);
  for (let q = 0; q < 5; q += 1) {
    st = host.snapshot().state.trivia;
    assert.equal(st.phase, 'question');
    const right = st.q.options.indexOf(questionById(st.q.id).a);
    for (const s of reds) bySlot(r, s).act({ type: 'answer', i: right, q: st.q.id });
    for (const s of blues) bySlot(r, s).act({ type: 'answer', i: (right + 1) % 4, q: st.q.id });
    await r.clock.advance(400);
    assert.equal(host.snapshot().state.trivia.phase, 'reveal');
    await r.clock.advance(5200);
  }
  st = host.snapshot().state.trivia;
  assert.equal(st.phase, 'final');
  const guest = bySlot(r, reds[0]);
  const m = trivia.model(guest.snapshot());
  assert.equal(m.teams[0].id, 'r');
  assert.ok(m.teams[0].pts > 0);
  assert.equal(m.teams[0].mine, true);
  assert.equal(m.teams[0].lead, true);
  assert.equal(m.teams[1].pts, 0);
  await r.clock.advance(TEAM_MS + 200);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners.slice().sort(), reds.slice().sort());
  await new Promise((done) => setImmediate(done));
  const post = net.posts.find((p) => p.url === RESULTS_ENDPOINT);
  assert.ok(post, 'results were posted');
  assert.equal(post.body.game, 'trivia');
  for (const p of post.body.players) {
    const slot = snap.players.find((x) => x.id === p.id).slot;
    assert.equal(p.team, reds.includes(slot) ? 'Red' : 'Blue');
    assert.equal(p.won, reds.includes(slot));
  }
});

test('Trivia without teams finishes straight to results as before', async (t) => {
  fakeNet();
  t.after(cleanNet);
  const r = await startGame('trivia', 2, { rounds: 5, timer: 10 });
  const host = r.engines[0];
  assert.equal(host.snapshot().state.trivia.tm, null);
  await r.clock.advance(5 * 15500);
  assert.equal(host.snapshot().room.phase, 'results');
});

test('a late Trivia joiner lands on the smaller team', async (t) => {
  fakeNet();
  t.after(cleanNet);
  const r = await startGame('trivia', 3, { teams: 'two', rounds: 5, timer: 30 });
  const host = r.engines[0];
  const before = host.snapshot().state.trivia.tm;
  const sizes = (tm) => ['r', 'b'].map((id) => Object.values(tm).filter((x) => x === id).length);
  assert.deepEqual(sizes(before).sort(), [1, 2]);
  const small = sizes(before)[0] < sizes(before)[1] ? 'r' : 'b';
  const late = r.add(4);
  joinIn(late);
  await r.clock.advance(800);
  const after = host.snapshot().state.trivia.tm;
  const slot = late.snapshot().meSlot;
  assert.ok(Number.isInteger(slot));
  assert.equal(after[slot], small);
  assert.deepEqual(sizes(after), [2, 2]);
});

test('team Draw & Guess: drawers alternate teams and teammates guessing never pay the drawer', async (t) => {
  const net = fakeNet();
  t.after(cleanNet);
  const r = await startGame('draw', 4, { teams: 'two', rounds: 1 });
  const host = r.engines[0];
  let st = host.snapshot().state.draw;
  assert.ok(st.tm);
  assert.notEqual(st.tm[st.order[0]], st.tm[st.order[1]]);
  assert.notEqual(st.tm[st.order[1]], st.tm[st.order[2]]);
  bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await r.clock.advance(400);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  const word = codeWord(st.w, st.nonce);
  const mate = Object.keys(st.tm).map(Number).find((s) => s !== st.drawer && st.tm[s] === st.tm[st.drawer]);
  const foes = Object.keys(st.tm).map(Number).filter((s) => st.tm[s] !== st.tm[st.drawer]);
  const mateView = draw.model(bySlot(r, mate).snapshot());
  assert.equal(mateView.mate, true);
  assert.equal(mateView.canGuess, true);
  bySlot(r, mate).act({ type: 'guess', text: word });
  await r.clock.advance(500);
  st = host.snapshot().state.draw;
  assert.ok(st.gained[mate] > 0, 'the teammate still scores');
  assert.equal(st.gained[st.drawer] || 0, 0, 'the drawer gets nothing from a teammate');
  bySlot(r, foes[0]).act({ type: 'guess', text: word });
  await r.clock.advance(500);
  st = host.snapshot().state.draw;
  assert.ok(st.gained[st.drawer] > 0, 'a guess from the other team pays the drawer');
  for (let i = 0; i < 400 && host.snapshot().state.draw.phase !== 'final'; i += 1) await r.clock.advance(2000);
  st = host.snapshot().state.draw;
  assert.equal(st.phase, 'final');
  assert.equal(draw.drawings({ get: () => st }).length, 0);
  const view = draw.model(host.snapshot());
  assert.equal(view.phase, 'final');
  assert.equal(view.teams.length, 2);
  await r.clock.advance(TEAM_MS + 200);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  const w = teamWinners(st.tm, snap.scores.g);
  assert.deepEqual(snap.room.last.winners.slice().sort(), w.slots.slice().sort());
  await new Promise((done) => setImmediate(done));
  const post = net.posts.find((p) => p.url === RESULTS_ENDPOINT);
  assert.ok(post.body.players.every((p) => p.team === 'Red' || p.team === 'Blue'));
});

test('a Draw & Guess pack code loads before the first turn and Pack words only uses just pack words', async (t) => {
  const net = fakeNet({ packs: { SPACE234: PACK } });
  t.after(cleanNet);
  const r = await startGame('draw', 2, { pack: 'SPACE234', packOnly: true });
  await settle(r, 1200);
  const host = r.engines[0];
  let st = host.snapshot().state.draw;
  assert.ok(st, 'the first turn started once the pack arrived');
  assert.deepEqual(net.asked, ['SPACE234']);
  assert.deepEqual(st.pk, { c: 'SPACE234', n: 'Space night' });
  assert.equal(st.pm, null);
  assert.ok(st.opts.every((o) => typeof o === 'string'));
  const raw = JSON.stringify(st);
  for (const w of drawablePackWords(PACK.words)) assert.equal(raw.includes(w), false, `${w} is not readable in shared state`);
  const drawer = bySlot(r, st.drawer);
  const m = draw.model(drawer.snapshot());
  assert.equal(m.choices.length, 3);
  assert.ok(m.choices.every((c) => c.tier === 'pack' && drawablePackWords(PACK.words).includes(c.word)));
  assert.equal(m.pack.name, 'Space night');
  drawer.act({ type: 'pick', i: 1, n: st.n });
  await r.clock.advance(400);
  st = host.snapshot().state.draw;
  const word = codeWord(st.w, st.nonce);
  assert.equal(word, m.choices.find((c) => c.i === 1).word);
  const guesser = r.engines.find((e) => e.snapshot().meSlot !== st.drawer);
  const hint = draw.model(guesser.snapshot()).hint;
  assert.equal(hint.length, word.length);
  guesser.act({ type: 'guess', text: word.toUpperCase() });
  await r.clock.advance(500);
  assert.equal(host.snapshot().state.draw.phase, 'reveal');
  assert.equal(host.snapshot().state.draw.word, word);
});

test('a Draw & Guess pack mixes pack words with built-in ones when Pack words only is off', async (t) => {
  fakeNet({ packs: { SPACE234: PACK } });
  t.after(cleanNet);
  const r = await startGame('draw', 2, { pack: 'SPACE234' });
  await settle(r, 1200);
  const st = r.engines[0].snapshot().state.draw;
  assert.equal(st.opts.filter((o) => typeof o === 'string').length, 2);
  assert.equal(st.opts.filter((o) => Number.isInteger(o)).length, 1);
  assert.equal(st.pu.length, 2);
});

test('an unknown pack code or a failed fetch falls back to built-in words with a friendly note', async (t) => {
  fakeNet();
  t.after(cleanNet);
  const r = await startGame('draw', 2, { pack: 'NOPE2345', packOnly: true });
  await settle(r, 1200);
  const st = r.engines[0].snapshot().state.draw;
  assert.ok(st);
  assert.equal(st.pk, null);
  assert.equal(st.pm, 'NOPE2345');
  assert.ok(st.opts.every((o) => Number.isInteger(o)));
  const m = draw.model(r.engines[1].snapshot());
  assert.equal(m.packMiss, 'NOPE2345');
  cleanNet();
  fakeNet({ fail: true });
  const r2 = await startGame('trivia', 2, { pack: 'SPACE234', rounds: 5 });
  await settle(r2, 1200);
  const st2 = r2.engines[0].snapshot().state.trivia;
  assert.equal(st2.pm, 'SPACE234');
  assert.equal(st2.deck.some(isPackId), false);
});

test('a pack that never answers gives up after a few seconds instead of hanging', async (t) => {
  configureAdmins({ win: null, refreshMs: 0, fetch: () => new Promise(() => {}) });
  t.after(cleanNet);
  const r = await startGame('trivia', 2, { pack: 'SLOW2345' });
  assert.ok(!r.engines[0].snapshot().state.trivia, 'nothing starts while the pack loads');
  assert.equal(r.engines[0].snapshot().room.phase, 'game');
  await settle(r, PACK_WAIT_MS + 800);
  const st = r.engines[0].snapshot().state.trivia;
  assert.ok(st);
  assert.equal(st.pm, 'SLOW2345');
  assert.equal(st.phase, 'question');
});

test('Trivia pack questions come first, score like normal and survive a host change', async (t) => {
  fakeNet({ packs: { SPACE234: PACK } });
  t.after(cleanNet);
  const r = await startGame('trivia', 2, { pack: 'SPACE234', rounds: 5, timer: 10 });
  await settle(r, 1000);
  const host = r.engines[0];
  let st = host.snapshot().state.trivia;
  assert.equal(st.deck.length, 5);
  assert.ok(st.deck.slice(0, 3).every(isPackId));
  assert.equal(st.q.cat, 'pack');
  const q = PACK.trivia.find((x) => x.q === st.q.text);
  assert.ok(q);
  assert.equal(JSON.stringify(st.q).includes('"a"'), false);
  const m = trivia.model(r.engines[1].snapshot());
  assert.equal(m.category, 'Space night');
  assert.equal(m.emoji, '📦');
  assert.equal(m.tier, null);
  const right = st.q.options.indexOf(q.a);
  assert.equal(showAnswer(st.q), right);
  r.engines[1].act({ type: 'answer', i: right, q: st.q.id });
  host.act({ type: 'answer', i: (right + 1) % 4, q: st.q.id });
  await r.clock.advance(400);
  st = host.snapshot().state.trivia;
  assert.equal(st.phase, 'reveal');
  assert.equal(st.answer, right);
  assert.ok(Object.values(st.gained)[0] > 0);
  await r.clock.advance(5200);
  st = host.snapshot().state.trivia;
  assert.equal(st.phase, 'question');
  assert.equal(st.q.cat, 'pack');
  const asked = PACK.trivia.find((x) => x.q === st.q.text);
  const mem = { cur: null };
  const api = {
    memory: mem,
    get: () => JSON.parse(JSON.stringify(st)),
    put: (k, v) => {
      st = v;
    },
    now: () => r.clock.now(),
    random: Math.random,
    players: () => [],
    points: () => ({}),
    addPoints() {},
    setDeadline() {},
    deadline: null,
    settings: { timer: 10, rounds: 5, cats: null, level: 'mix' },
    finish() {},
  };
  trivia.resume(api);
  assert.equal(st.phase, 'reveal');
  assert.equal(st.skipped, true);
  assert.equal(st.q.options[st.answer], asked.a);
});

test('the trivia and draw views show the team bar, the pack note and the final team screen', async (t) => {
  fakeNet();
  t.after(cleanNet);
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = await startGame('trivia', 2, { teams: 'two', rounds: 5, timer: 10, pack: 'MISS2345' });
  await settle(r, 1000);
  const guest = r.engines[1];
  const v = VIEWS.trivia({ engine: guest, fx: { confetti() {} }, toast() {}, win: { setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} } });
  v.update(guest.snapshot());
  const page = text(v.el);
  assert.match(page, /🟥 Red/);
  assert.match(page, /🟦 Blue/);
  assert.match(page, /Your team/);
  assert.match(page, /Couldn't find word pack MISS2345/);
  assert.ok(all(v.el).some((n) => n.classList && n.classList.contains('team-bar')));
  for (let q = 0; q < 5; q += 1) await r.clock.advance(15500);
  assert.equal(guest.snapshot().state.trivia.phase, 'final');
  v.update(guest.snapshot());
  assert.match(text(v.el), /Final scores/);
  assert.match(text(v.el), /tie between the teams|team wins!/);
  for (const re of BANNED) assert.equal(re.test(text(v.el)), false);
  v.destroy();

  const make2d = document.createElement.bind(document);
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, val) => ((o[k] = val), true) });
  document.createElement = (tag) => {
    const el = make2d(tag);
    if (tag === 'canvas') el.getContext = () => ctx;
    return el;
  };
  cleanNet();
  fakeNet({ packs: { SPACE234: PACK } });
  const d = await startGame('draw', 2, { teams: 'two', pack: 'SPACE234' });
  await settle(d, 1000);
  const st = d.engines[0].snapshot().state.draw;
  const drawer = bySlot(d, st.drawer);
  const win = { setTimeout: d.clock.setTimeout, clearTimeout: d.clock.clearTimeout, setInterval: () => 0, clearInterval() {} };
  const dv = VIEWS.draw({ engine: drawer, fx: { confetti() {} }, toast() {}, win });
  dv.update(drawer.snapshot());
  const dt = text(dv.el);
  assert.match(dt, /📦 Space night/);
  assert.match(dt, /draws/);
  assert.match(dt, /📦 Pack/);
  assert.ok(all(dv.el).some((n) => n.classList && n.classList.contains('team-bar')));
  dv.destroy();
  document.createElement = make2d;
});
