import test from 'node:test';
import assert from 'node:assert/strict';
import { room, Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine } from '../web/activity/js/engine.js';
import { resultsModel } from '../web/activity/js/ui/results.js';
import { GAMES } from '../web/activity/js/games/index.js';
import { installDom } from './dom-shim.js';
import chain, { checkWord, cleanWord, wordPoints, votesNeeded, nextUp, standing, lastLetter, usedFrom, wordHash, hashesIn, lateLives, seat, speedLap, timeWinners, timeNote, PROBLEMS, WIN_BONUS, MIN_LETTERS, MAX_LETTERS, MIN_TURN, USED_PREFIX, HASH_LEN } from '../web/activity/js/games/chain.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { eventText, turnText } from '../web/activity/js/views/chain.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

await dictionary.load(() => Promise.reject(new Error('offline')));

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startChain(n = 3, settings = {}) {
  const r = room(n);
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('chain'), true);
  for (const [k, v] of Object.entries({ bonus: false, cats: false, ...settings })) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  return r;
}

function st(r) {
  return r.engines[0].snapshot().state.chain;
}

function wordFor(letter, n) {
  return `${letter}${'abcdefghijklmnopqrstuvwxyz'[n % 26]}${'aeiou'[n % 5]}nk`;
}

async function play(r, word) {
  const s = st(r);
  bySlot(r, s.cur).act({ type: 'word', text: word, t: s.t });
  await r.clock.advance(400);
  return st(r);
}

test('words are checked for letters, length, start letter and repeats', () => {
  assert.equal(checkWord('Apple', 'a', []), null);
  assert.equal(checkWord('  apple ', 'a', []), null);
  assert.equal(checkWord('', 'a', []), 'empty');
  assert.equal(checkWord('ab', 'a', []), 'short');
  assert.equal(checkWord('a'.repeat(25), 'a', []), null);
  assert.equal(checkWord('a'.repeat(60), 'a', []), null);
  assert.equal(checkWord('a'.repeat(61), 'a', []), 'long');
  assert.equal(MAX_LETTERS, 60);
  assert.match(PROBLEMS.long, /60 letters/);
  assert.equal(checkWord('ice cream', 'i', []), 'letters');
  assert.equal(checkWord('abc1', 'a', []), 'letters');
  assert.equal(checkWord('café', 'c', []), 'letters');
  assert.equal(checkWord('banana', 'a', []), 'start');
  assert.equal(checkWord('apple', 'a', ['apple']), 'used');
  const state = { [`${USED_PREFIX}0`]: wordHash('apple') + wordHash('kiosk') };
  assert.equal(checkWord('Apple', 'a', usedFrom(state)), 'used');
  assert.equal(checkWord('acorn', 'a', usedFrom(state)), null);
  assert.equal(usedFrom(state).size, 2);
  assert.equal(cleanWord(' HeLLo '), 'hello');
  assert.equal(lastLetter('Tiger'), 'r');
  assert.equal(MIN_LETTERS, 3);
  for (const text of Object.values(PROBLEMS)) for (const re of BANNED) assert.equal(re.test(text), false, text);
});

test('turn order skips people who are out or away', () => {
  const lives = { 0: 3, 1: 0, 2: 2, 3: 1 };
  assert.equal(nextUp([0, 1, 2, 3], lives, [0, 1, 2, 3], 0), 2);
  assert.equal(nextUp([0, 1, 2, 3], lives, [0, 1, 3], 0), 3);
  assert.equal(nextUp([0, 1, 2, 3], lives, [0, 1, 2, 3], 3), 0);
  assert.equal(nextUp([0, 1, 2, 3], lives, [0, 1, 2, 3], 2), 3);
  assert.equal(nextUp([0, 1], { 0: 0, 1: 0 }, [0, 1], 0), null);
  assert.deepEqual(standing([0, 1, 2, 3], lives, [0, 2]), [0, 2]);
});

test('a majority means more than half of the other players', () => {
  assert.equal(votesNeeded(1), 1);
  assert.equal(votesNeeded(2), 2);
  assert.equal(votesNeeded(3), 2);
  assert.equal(votesNeeded(4), 3);
  assert.equal(wordPoints('cat'), 30);
  assert.equal(wordPoints('a'.repeat(20)), 150);
});

test('players take turns, the chain follows last letters and repeats are refused', async () => {
  const r = await startChain(3, { timer: 15, lives: 3 });
  let s = st(r);
  assert.equal(s.phase, 'turn');
  assert.equal(s.ends - s.starts, 15000);
  assert.deepEqual(s.order, [0, 1, 2]);
  assert.ok(/^[a-z]$/.test(s.letter));
  const first = s.cur;
  const w1 = wordFor(s.letter, 1);
  s = await play(r, w1);
  assert.equal(s.count, 1);
  assert.equal(s.letter, 'k');
  assert.equal(s.cur, (first + 1) % 3);
  assert.equal(s.n, 1);
  assert.equal(usedFrom(r.engines[1].snapshot().state).has(w1), true);
  const wrongPlayer = bySlot(r, (s.cur + 1) % 3);
  wrongPlayer.act({ type: 'word', text: 'kite', t: s.t });
  await r.clock.advance(400);
  assert.equal(st(r).count, 1, 'only the current player can play');
  bySlot(r, s.cur).act({ type: 'word', text: 'apple', t: s.t });
  await r.clock.advance(400);
  assert.equal(st(r).count, 1, 'wrong start letter is ignored');
  bySlot(r, s.cur).act({ type: 'word', text: 'k1te', t: s.t });
  await r.clock.advance(400);
  assert.equal(st(r).count, 1, 'letters only');
  s = await play(r, 'kiosk');
  assert.equal(s.count, 2);
  assert.equal(s.letter, 'k');
  s = await play(r, 'kiosk');
  assert.equal(s.count, 2, 'no repeats');
  assert.equal(s.bad.why, 'used');
  assert.equal(chain.model(bySlot(r, s.cur).snapshot()).bad.why, 'used');
  s = await play(r, 'kayak');
  assert.equal(s.count, 3);
  assert.equal(s.cur, first);
  const g = r.engines[0].snapshot().scores.g;
  assert.equal(g[(first + 1) % 3], wordPoints('kiosk'));
  const m = chain.model(bySlot(r, s.cur).snapshot());
  assert.equal(m.myTurn, true);
  assert.equal(m.words.length, 3);
  assert.equal(m.words[2].latest, true);
  assert.deepEqual(r.hub.violations, []);
});

test('running out of time costs a life and the last one standing wins', async () => {
  const r = await startChain(2, { timer: 10, lives: 2 });
  let s = st(r);
  const slow = s.cur;
  await r.clock.advance(10000 + 200);
  s = st(r);
  assert.equal(s.lives[slow], 1);
  assert.equal(s.last.kind, 'miss');
  assert.notEqual(s.cur, slow);
  const letter = s.letter;
  const fast = s.cur;
  s = await play(r, wordFor(letter, 3));
  assert.equal(s.cur, slow);
  assert.equal(chain.model(bySlot(r, fast).snapshot()).last.kind, 'word');
  await r.clock.advance(10000 + 200);
  const snap = r.engines[0].snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [fast]);
  assert.equal(snap.state.chain.lives[slow], 0);
  assert.equal(snap.scores.g[fast], wordPoints(wordFor(letter, 3)) + WIN_BONUS);
});

test('a majority "Not a word" vote strikes the word and costs a life', async () => {
  const r = await startChain(4, { lives: 3 });
  let s = st(r);
  const author = s.cur;
  const before = s.letter;
  s = await play(r, `${before}zzq`);
  assert.equal(s.vote.w, `${before}zzq`);
  assert.equal(s.vote.s, author);
  const next = s.cur;
  const voters = [0, 1, 2, 3].filter((x) => x !== author && x !== next);
  bySlot(r, author).act({ type: 'nope', n: s.vote.n });
  await r.clock.advance(400);
  assert.equal(st(r).vote.no.length, 0, 'you cannot vote on your own word');
  bySlot(r, next).act({ type: 'nope', n: s.vote.n });
  await r.clock.advance(400);
  assert.equal(st(r).vote.no.length, 0, 'the player on the clock cannot vote');
  assert.equal(chain.model(bySlot(r, next).snapshot()).vote.canVote, false);
  bySlot(r, voters[0]).act({ type: 'nope', n: s.vote.n });
  bySlot(r, voters[0]).act({ type: 'nope', n: s.vote.n });
  await r.clock.advance(400);
  s = st(r);
  assert.deepEqual(s.vote.no, [voters[0]]);
  const m = chain.model(bySlot(r, voters[1]).snapshot());
  assert.equal(m.vote.need, 2);
  assert.equal(m.vote.canVote, true);
  assert.equal(chain.model(bySlot(r, voters[0]).snapshot()).vote.canVote, false);
  bySlot(r, voters[1]).act({ type: 'nope', n: s.vote.n });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.vote, null);
  assert.equal(s.letter, before);
  assert.equal(s.lives[author], 2);
  assert.equal(s.n, 0);
  assert.equal(usedFrom(r.engines[0].snapshot().state).size, 0);
  assert.equal(s.words.length, 0);
  assert.equal(s.cur, next, 'the next player keeps the turn');
  assert.equal(s.note, 'again');
  assert.equal(s.last.kind, 'reject');
  assert.equal(r.engines[0].snapshot().scores.g[author] || 0, 0);
  assert.match(eventText(chain.model(r.engines[0].snapshot())), /voted not a word/);
  s = await play(r, `${before}zzq`);
  assert.equal(s.count, 2, 'a struck word can be tried again');
});

test('voting needs two players who are neither the author nor on the clock', async () => {
  const r = await startChain(3);
  let s = st(r);
  s = await play(r, wordFor(s.letter, 5));
  const third = [0, 1, 2].find((x) => x !== s.vote.s && x !== s.cur);
  const m = chain.model(bySlot(r, third).snapshot());
  assert.equal(m.vote.open, false);
  assert.equal(m.vote.canVote, false);
  bySlot(r, third).act({ type: 'nope', n: s.vote.n });
  await r.clock.advance(400);
  assert.deepEqual(st(r).vote.no, []);
  assert.equal(st(r).words.length, 1);
});

test('a word stays if the vote falls short, and a new word closes the old vote', async () => {
  const r = await startChain(4);
  let s = st(r);
  s = await play(r, wordFor(s.letter, 5));
  const oldN = s.vote.n;
  const voter = [0, 1, 2, 3].find((x) => x !== s.vote.s && x !== s.cur);
  bySlot(r, voter).act({ type: 'nope', n: oldN });
  await r.clock.advance(400);
  assert.equal(st(r).vote.no.length, 1);
  s = await play(r, 'knack');
  assert.equal(s.vote.n, oldN + 1);
  assert.deepEqual(s.vote.no, []);
  bySlot(r, voter).act({ type: 'nope', n: oldN });
  await r.clock.advance(400);
  assert.equal(st(r).count, 2);
  assert.equal(st(r).words.length, 2);
});

test('Word Chain carries on when the host leaves mid-turn', async () => {
  const r = await startChain(3, { timer: 15 });
  const host = r.engines[0];
  let s = st(r);
  s = await play(r, wordFor(s.letter, 7));
  s = await play(r, 'knot');
  const [, a] = r.engines;
  const hostSlot = host.snapshot().meSlot;
  const wasCur = s.cur;
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(600);
  assert.equal(a.isHost(), true);
  s = a.snapshot().state.chain;
  assert.equal(s.count, 2);
  assert.equal(s.letter, 't');
  if (wasCur === hostSlot) {
    assert.notEqual(s.cur, hostSlot, 'the leaving host loses the turn');
    assert.equal(s.last.kind, 'left');
  } else {
    assert.equal(s.cur, wasCur);
  }
  const cur = s.cur;
  bySlot({ engines: r.engines.slice(1) }, cur).act({ type: 'word', text: 'tulip', t: s.t });
  await r.clock.advance(400);
  s = a.snapshot().state.chain;
  assert.equal(s.count, 3);
  await r.clock.advance(15000 + 300);
  s = a.snapshot().state.chain;
  assert.equal(s.last.kind, 'miss', 'the new host runs the clock');
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES);
  assert.deepEqual(r.hub.violations, []);
});

test('the game ends with a winner when everyone else leaves', async () => {
  const r = await startChain(2);
  const [host, guest] = r.engines;
  r.hub.leave(guest.snapshot().me);
  guest.destroy();
  await r.clock.advance(600);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [snap.meSlot]);
});

test('no word can be played twice, even after hundreds of words', async () => {
  const r = await startChain(2, { timer: 20, length: 0 });
  let s = st(r);
  const played = [];
  for (let i = 0; i < 620; i += 1) {
    const w = `${s.letter}${'bcdfghjklmnpqrstvwxyz'[i % 21]}${'bcdfghjklmnpqrstvwxyz'[Math.floor(i / 21) % 21]}${'aeiou'[i % 5]}ster${i % 2 ? 'x' : 'n'}`;
    const before = s.count;
    s = await play(r, w);
    if (s.count > before) played.push(w);
  }
  assert.ok(s.count >= 600, String(s.count));
  assert.equal(s.n, s.count);
  await r.clock.advance(1000);
  const snap = r.engines[1].snapshot();
  const used = usedFrom(snap.state);
  assert.equal(used.size, played.length);
  for (const w of played) assert.equal(used.has(w), true, w);
  const keys = Object.keys(snap.state).filter((k) => k.startsWith(USED_PREFIX));
  assert.equal(keys.length, 2);
  for (const k of keys) assert.ok(jsonBytes(snap.state[k]) <= MAX_VALUE_BYTES, k);
  const old = played.find((w) => w[0] === s.letter);
  const count = s.count;
  s = await play(r, old);
  assert.equal(s.count, count, 'an early word is still refused');
  assert.equal(s.bad.why, 'used');
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES, String(jsonBytes(s)));
  assert.deepEqual(r.hub.violations, []);
});

test('hashes are short, stable and spread out', () => {
  assert.equal(wordHash('Apple'), wordHash('apple'));
  assert.equal(wordHash('apple').length, HASH_LEN);
  assert.notEqual(wordHash('apple'), wordHash('appel'));
  assert.deepEqual([...hashesIn([wordHash('a') + wordHash('b'), 5, null])], [wordHash('a'), wordHash('b')]);
});

function fakeApi(st, slots) {
  const store = { chain: st };
  return {
    store,
    players: () => slots.map((slot) => ({ slot, id: `u${slot}`, name: `P${slot}` })),
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    put: (k, v) => {
      store[k] = v;
    },
    keys: () => Object.keys(store),
  };
}

test('late joiners slot in after the current player with 1 life', () => {
  assert.deepEqual(seat([0, 1, 2], 5, 1), [0, 1, 5, 2]);
  assert.deepEqual(seat([0, 1, 2], 5, 2), [0, 1, 2, 5]);
  assert.deepEqual(seat([0, 1, 2], 1, 0), [0, 1, 2]);
  assert.deepEqual(seat([0, 1], 4, null), [0, 1, 4]);
  assert.equal(lateLives({ order: [0, 1, 2], lives: { 0: 3, 1: 2, 2: 0 } }, [0, 1, 2]), 1);
  assert.equal(lateLives({ order: [0, 1, 2], lives: { 0: 3, 1: 1, 2: 2 } }, [0, 2]), 1);
  assert.equal(lateLives({ order: [0, 1], lives: { 0: 0, 1: 0 } }, [0, 1]), 1);
  const st = { phase: 'turn', order: [0, 1, 2], lives: { 0: 3, 1: 1, 2: 2 }, cur: 1, max: 3 };
  const api = fakeApi(st, [0, 1, 2, 3]);
  chain.join(api, 3);
  assert.deepEqual(api.store.chain.order, [0, 1, 3, 2]);
  assert.equal(api.store.chain.lives[3], 1);
  chain.join(api, 3);
  assert.deepEqual(api.store.chain.order, [0, 1, 3, 2], 'joining twice changes nothing');
  const over = fakeApi({ ...st, phase: 'over' }, [0, 1, 2, 4]);
  chain.join(over, 4);
  assert.deepEqual(over.store.chain.order, [0, 1, 2]);
});

test('a late joiner takes turns in a running game', async () => {
  const r = await startChain(2, { lives: 3 });
  let s = st(r);
  const first = s.cur;
  await r.clock.advance(15000 + 200);
  s = st(r);
  assert.equal(s.lives[first], 2);
  const late = r.add(3);
  await r.clock.advance(800);
  const slot = late.snapshot().meSlot;
  s = st(r);
  assert.ok(Number.isInteger(slot), 'the late joiner gets a slot');
  assert.ok(s.order.includes(slot), 'the late joiner is seated');
  assert.equal(s.lives[slot], 1);
  assert.equal(s.order.indexOf(slot), s.order.indexOf(s.cur) + 1);
  const before = s.t;
  while (st(r).cur !== slot) {
    const now = st(r);
    bySlot(r, now.cur).act({ type: 'word', text: wordFor(now.letter, now.t), t: now.t });
    await r.clock.advance(400);
    assert.ok(st(r).t > now.t, 'the turn moves on');
    assert.ok(st(r).t - before < 6, 'the late joiner gets a turn soon');
  }
  const mine = st(r);
  late.act({ type: 'word', text: wordFor(mine.letter, 99), t: mine.t });
  await r.clock.advance(400);
  assert.notEqual(st(r).cur, slot, 'the late joiner played a word');
  assert.deepEqual(r.hub.violations, []);
});

test('a spectator cannot play a word or seat themselves', async () => {
  const r = await startChain(2, { lives: 3 });
  const watcher = r.add(3);
  watcher.leave();
  await r.clock.advance(800);
  const s = st(r);
  const slot = watcher.snapshot().meSlot;
  assert.ok(slot === null || !s.order.includes(slot), 'a spectator is not seated');
  watcher.act({ type: 'word', text: wordFor(s.letter, 3), t: s.t });
  await r.clock.advance(400);
  assert.equal(st(r).t, s.t, 'nothing moved');
  assert.equal(st(r).count, s.count);
  assert.deepEqual(r.hub.violations, []);
});

test('without the dictionary the game says so and falls back to voting', async () => {
  assert.equal(dictionary.ready, false);
  assert.equal(dictionary.failed, true);
  const r = await startChain(4);
  let s = st(r);
  assert.equal(s.dict, 0);
  assert.equal(chain.model(r.engines[0].snapshot()).dict, false);
  s = await play(r, `${s.letter}zzq`);
  assert.equal(s.count, 1, 'made-up words go through when the dictionary is missing');
  assert.ok(s.vote, 'and the others can vote them out');
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

function byKey(root, key) {
  return all(root).find((el) => el.dataset && el.dataset.key === key) || null;
}

test('the chain view shows whose turn it is, checks words and votes', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = VIEWS.chain({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win: {} });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  r.engines[0].lobby.pick('chain');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  let s = st(r);
  const upIdx = r.engines.findIndex((e) => e.snapshot().meSlot === s.cur);
  const up = views[upIdx];
  const other = views[1 - upIdx];
  assert.match(text(up.el), /Your turn!/);
  assert.match(text(other.el), /needs a word that starts with/);
  assert.equal(byKey(other.el, 'chain-input').disabled, true);
  const input = byKey(up.el, 'chain-input');
  assert.equal(input.disabled, false);
  input.value = 'no';
  byKey(up.el, 'chain-send').click();
  assert.match(text(up.el), /at least 3 letters/);
  input.value = `${s.letter === 'z' ? 'y' : 'z'}ebra`;
  byKey(up.el, 'chain-send').click();
  assert.match(text(up.el), /wrong letter/);
  input.value = `${s.letter}oom`;
  byKey(up.el, 'chain-send').click();
  await r.clock.advance(500);
  s = st(r);
  assert.equal(s.count, 1);
  assert.match(text(other.el), /Your turn!/);
  assert.match(text(other.el), /needs 4 or more players/);
  assert.equal(byKey(other.el, 'nope'), null);
  for (const v of views) v.destroy();
  assert.equal(toasts.length, 0);
});

test('the chain view lets the others vote and tells the next player their clock restarted', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(4);
  await r.clock.advance(500);
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = VIEWS.chain({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win: {} });
    engine.on('change', (s) => v.update(s));
    return v;
  });
  r.engines[0].lobby.pick('chain');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  let s = st(r);
  const viewOf = (slot) => views[r.engines.findIndex((e) => e.snapshot().meSlot === slot)];
  const author = s.cur;
  const input = byKey(viewOf(author).el, 'chain-input');
  input.value = `${s.letter}oom`;
  byKey(viewOf(author).el, 'chain-send').click();
  await r.clock.advance(500);
  s = st(r);
  const next = s.cur;
  const rest = [0, 1, 2, 3].filter((x) => x !== author && x !== next);
  assert.match(text(viewOf(author).el), /Others can vote/);
  assert.match(text(viewOf(next).el), /Your turn!/);
  assert.match(text(viewOf(next).el), /can vote while it's your turn/);
  assert.equal(byKey(viewOf(next).el, 'nope'), null);
  for (const slot of rest) {
    assert.match(text(viewOf(slot).el), /Not a word\?/);
    byKey(viewOf(slot).el, 'nope').click();
    await r.clock.advance(500);
  }
  s = st(r);
  assert.equal(s.count, 1);
  assert.equal(s.words.length, 0);
  assert.equal(s.cur, next);
  const nextText = text(viewOf(next).el);
  assert.match(nextText, /voted not a word/);
  assert.match(nextText, /The last word was voted out, so it's back to/);
  assert.match(nextText, /Your clock restarted/);
  assert.doesNotMatch(nextText, /Try another/);
  assert.match(turnText(chain.model(bySlot(r, author).snapshot())), /needs a word/);
  for (const v of views) v.destroy();
  assert.equal(toasts.length, 0);
});

function uniqueWord(letter, i) {
  const c = 'bcdfghjklmnpqrstvwxyz';
  return `${letter}${c[i % 21]}${c[Math.floor(i / 21) % 21]}${'aeiou'[i % 5]}ster${i % 2 ? 'x' : 'n'}`;
}

function lap(st, cur, left, base = 15) {
  st.cur = cur;
  return speedLap(st, left, base);
}

test('a lap ends once everyone still in has had a turn, with 2, 3 and 5 players', () => {
  const two = { fast: 1, span: 15, lap: [], t: 4 };
  assert.equal(lap(two, 0, [0, 1]), false);
  assert.deepEqual(two.lap, [0]);
  assert.equal(lap(two, 1, [0, 1]), true);
  assert.equal(two.span, 14);
  assert.equal(two.up, 5);
  assert.deepEqual(two.lap, []);
  assert.equal(two.laps, 1);
  const three = { fast: 1, span: 15, lap: [], t: 0 };
  assert.equal(lap(three, 2, [0, 1, 2]), false);
  assert.equal(lap(three, 0, [0, 1, 2]), false);
  assert.equal(lap(three, 1, [0, 1, 2]), true);
  assert.equal(three.span, 14);
  const five = { fast: 1, span: 15, lap: [], t: 0 };
  assert.equal(lap(five, 0, [0, 1, 2, 3, 4]), false);
  assert.equal(lap(five, 1, [0, 2, 3, 4]), false, 'player 1 went out on their turn');
  assert.deepEqual(five.lap, [0]);
  assert.equal(lap(five, 2, [0, 2, 3, 4]), false);
  assert.equal(lap(five, 3, [0, 2, 4]), false, 'player 4 left the call');
  assert.equal(lap(five, 0, [0, 2, 4, 7]), false, 'a late joiner has to get their turn first');
  assert.equal(lap(five, 7, [0, 2, 4, 7]), false);
  assert.equal(lap(five, 4, [0, 2, 4, 7]), true);
  assert.equal(five.span, 14);
  const gone = { fast: 1, span: 15, lap: [0, 1], t: 0 };
  assert.equal(lap(gone, 2, [2]), true, 'only the last player left still closes a lap');
});

test('turns never get shorter than 5 seconds, and the setting can turn speeding up off', () => {
  const st = { fast: 1, span: 6, lap: [], t: 0 };
  assert.equal(lap(st, 0, [0]), true);
  assert.equal(st.span, MIN_TURN);
  assert.equal(lap(st, 0, [0]), false);
  assert.equal(st.span, 5);
  const off = { fast: 0, span: 15, lap: [], t: 0 };
  assert.equal(lap(off, 0, [0, 1]), false);
  assert.equal(lap(off, 1, [0, 1]), false);
  assert.equal(off.span, 15);
  assert.equal(off.laps, 1);
  const old = { fast: 1, lap: [], t: 0 };
  assert.equal(lap(old, 0, [0], 10), true);
  assert.equal(old.span, 9);
});

test('the turn clock drops a second every lap down to 5 seconds in a real game', async () => {
  const r = await startChain(2, { timer: 10, lives: 3 });
  let s = st(r);
  assert.equal(s.span, 10);
  assert.equal(s.ends - s.starts, 10000);
  const spans = [];
  for (let i = 0; i < 14; i += 1) {
    s = await play(r, uniqueWord(s.letter, i));
    spans.push(s.ends - s.starts);
  }
  assert.deepEqual(spans, [10000, 9000, 9000, 8000, 8000, 7000, 7000, 6000, 6000, 5000, 5000, 5000, 5000, 5000]);
  assert.equal(s.span, 5);
  const m = chain.model(r.engines[1].snapshot());
  assert.equal(m.span, 5);
  assert.equal(m.fast, true);
  const slow = s.cur;
  await r.clock.advance(5000 + 200);
  assert.equal(st(r).lives[slow], 2, 'the 5 second turn really runs out');
  assert.deepEqual(r.hub.violations, []);
});

test('with speeding up off the turn clock stays the same', async () => {
  const r = await startChain(3, { timer: 15, speedup: false });
  let s = st(r);
  for (let i = 0; i < 9; i += 1) {
    s = await play(r, uniqueWord(s.letter, i));
    assert.equal(s.ends - s.starts, 15000);
  }
  assert.equal(s.span, 15);
  assert.equal(s.laps, 3);
  assert.equal(chain.model(r.engines[0].snapshot()).sped, false);
});

test('when time runs out the most lives win, then points, then words', () => {
  assert.deepEqual(timeWinners([0, 1, 2], { 0: 1, 1: 3, 2: 2 }, { 0: 900 }, {}), { w: [1], why: 'lives' });
  assert.deepEqual(timeWinners([0, 1, 2], { 0: 2, 1: 2, 2: 1 }, { 0: 100, 1: 140, 2: 900 }, {}), { w: [1], why: 'points' });
  assert.deepEqual(timeWinners([0, 1], { 0: 2, 1: 2 }, { 0: 100, 1: 100 }, { 0: 3, 1: 4 }), { w: [1], why: 'words' });
  assert.deepEqual(timeWinners([0, 1, 2], { 0: 2, 1: 2, 2: 1 }, { 0: 100, 1: 100, 2: 5 }, { 0: 3, 1: 3 }), { w: [0, 1], why: 'tie' });
  assert.deepEqual(timeWinners([4], { 4: 1 }, {}, {}), { w: [4], why: 'lives' });
  assert.deepEqual(timeWinners([], {}, {}, {}), { w: [], why: 'none' });
  const name = (s) => `P${s}`;
  assert.equal(timeNote({ w: [1], why: 'lives' }, name), "Time's up! P1 had the most lives left.");
  assert.match(timeNote({ w: [1], why: 'points' }, name), /Lives were tied, so P1 won with the most points/);
  assert.match(timeNote({ w: [1], why: 'words' }, name), /most words/);
  assert.equal(timeNote({ w: [0, 1, 2], why: 'tie' }, name), "Time's up! P0, P1 and P2 tied on lives, points and words.");
  for (const why of ['lives', 'points', 'words', 'tie', 'none']) for (const re of BANNED) assert.equal(re.test(timeNote({ w: [0, 1], why }, name)), false);
});

function clockApi(st, { now, points = {}, slots = [0, 1, 2] }) {
  const api = fakeApi(st, slots);
  api.added = {};
  api.done = null;
  api.deadlines = [];
  api.now = () => now;
  api.random = () => 0;
  api.settings = { timer: 15, lives: 3, speedup: true, length: 5 };
  api.points = () => ({ ...points });
  api.addPoints = (s, n) => {
    api.added[s] = (api.added[s] || 0) + n;
  };
  api.finish = (w) => {
    api.done = w;
  };
  api.nameOf = (s) => `P${s}`;
  api.setDeadline = (at) => api.deadlines.push(at);
  return api;
}

test('time running out ends the turn without costing a life and picks the right winners', () => {
  const base = { phase: 'turn', order: [0, 1, 2], lives: { 0: 2, 1: 2, 2: 1 }, max: 3, out: [], cur: 0, t: 9, starts: 1000, ends: 16000, until: 9000, span: 15, fast: 1, lap: [], words: [], wc: { 0: 4, 1: 4, 2: 9 }, vote: null, bad: null };
  const copy = (over = {}) => JSON.parse(JSON.stringify({ ...base, ...over }));
  const tie = clockApi(copy(), { now: 9000, points: { 0: 300, 1: 300, 2: 900 } });
  chain.deadline(tie);
  assert.deepEqual(tie.done, [0, 1]);
  assert.equal(tie.store.chain.lives[0], 2, 'nobody loses a life when the game clock ends');
  assert.equal(tie.store.chain.phase, 'over');
  assert.deepEqual(tie.store.chain.fin, { w: [0, 1], why: 'tie' });
  assert.deepEqual(tie.added, { 0: WIN_BONUS, 1: WIN_BONUS });
  assert.equal(chain.results(tie).note, "Time's up! P0 and P1 tied on lives, points and words.");
  const pts = clockApi(copy(), { now: 9100, points: { 0: 300, 1: 310, 2: 900 } });
  chain.deadline(pts);
  assert.deepEqual(pts.done, [1]);
  assert.match(chain.results(pts).note, /P1 won with the most points/);
  const away = clockApi(copy(), { now: 9100, points: { 0: 300, 1: 310 }, slots: [0, 2] });
  chain.deadline(away);
  assert.deepEqual(away.done, [0], 'people who left the call cannot win on time');
  const early = clockApi(copy({ ends: 5000 }), { now: 5000 });
  chain.deadline(early);
  assert.equal(early.done, null, 'a normal turn timeout before the game clock still costs a life');
  assert.equal(early.store.chain.lives[0], 1);
  assert.equal(early.store.chain.cur, 1);
  assert.deepEqual(early.deadlines, [9000], 'the next turn is cut short by the game clock');
  const late = clockApi(copy(), { now: 9200, points: { 0: 300, 1: 310 } });
  chain.intent(late, 0, { type: 'word', text: 'kiwi', t: 9 });
  assert.deepEqual(late.done, [1], 'a word sent after the game clock ran out does not count');
  const close = clockApi(copy(), { now: 8700, points: { 0: 300, 1: 310 } });
  chain.intent(close, 0, { type: 'word', text: 'kiwi', t: 9 });
  assert.equal(close.done, null, 'a word in the last half second still counts');
  assert.equal(close.store.chain.count, 1);
  assert.equal(close.store.chain.cur, 1);
  assert.deepEqual(close.deadlines, [9000]);
  assert.equal(chain.results(fakeApi(copy({ phase: 'over' }), [0])).note, undefined);
});

function chainParty(players, watchers, posts) {
  const clock = new Clock();
  const hub = new Hub(clock);
  const random = seeded(11);
  const engines = [];
  for (let i = 1; i <= players + watchers; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: GAMES, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random, postResults: (b) => posts.push(b) });
    if (i <= players) e.join();
    engines.push(e);
  }
  return { clock, hub, engines };
}

test('a timed game finishes on the game clock with results, Party XP and watcher picks', async () => {
  const posts = [];
  const r = chainParty(2, 1, posts);
  await r.clock.advance(500);
  const [host, , watcher] = r.engines;
  assert.equal(host.lobby.pick('chain'), true);
  assert.equal(host.lobby.setting('length', 3), true);
  for (const [k, v] of Object.entries({ timer: 15, bonus: false, cats: false })) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  let s = st(r);
  assert.ok(Math.abs(s.until - (s.starts + 180000)) < 1000);
  assert.equal(host.snapshot().room.deadline, s.ends);
  const slow = s.cur;
  const fast = 1 - slow;
  assert.equal(watcher.predict(fast), true);
  await r.clock.advance(15000 + 200);
  assert.equal(st(r).lives[slow], 2);
  let i = 0;
  while (host.snapshot().room.phase === 'game' && i < 1000) {
    s = st(r);
    bySlot(r, s.cur).act({ type: 'word', text: uniqueWord(s.letter, i), t: s.t });
    await r.clock.advance(400);
    i += 1;
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.deepEqual(snap.room.last.winners, [fast]);
  assert.equal(snap.state.chain.lives[slow], 2, 'the last turn did not cost a life');
  assert.equal(snap.state.chain.fin.why, 'lives');
  assert.match(snap.room.last.note, /^Time's up! .+ had the most lives left\.$/);
  assert.deepEqual(snap.room.last.ps.slice().sort(), [0, 1]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].game, 'chain');
  assert.deepEqual(posts[0].predictions.map((p) => p.right), [true]);
  assert.equal(posts[0].players.find((p) => p.won).id, person(fast + 1).id);
  await r.clock.advance(400);
  const m = resultsModel(watcher.snapshot(), GAMES);
  assert.match(m.note, /Time's up!/);
  assert.equal(m.winners.length, 1);
  assert.ok(snap.state.chain.span >= MIN_TURN);
  assert.deepEqual(r.hub.violations, []);
});

test('a new host keeps the game clock and the current turn speed, and late joiners see the same clock', async () => {
  const r = await startChain(3, { timer: 15, length: 8 });
  let s = st(r);
  const until = s.until;
  assert.ok(until > s.starts + 470000);
  for (let i = 0; i < 6; i += 1) s = await play(r, uniqueWord(s.letter, i));
  assert.equal(s.span, 13);
  const host = r.engines[0];
  r.hub.leave(host.snapshot().me);
  host.destroy();
  await r.clock.advance(600);
  const a = r.engines[1];
  assert.equal(a.isHost(), true);
  s = a.snapshot().state.chain;
  assert.equal(s.until, until);
  assert.equal(s.span, 13);
  assert.equal(s.ends - s.starts, 13000);
  const late = r.add(4);
  await r.clock.advance(800);
  const lm = chain.model(late.snapshot());
  assert.equal(lm.until, until);
  assert.equal(lm.span, 13);
  const rest = { engines: r.engines.slice(1) };
  s = a.snapshot().state.chain;
  bySlot(rest, s.cur).act({ type: 'word', text: uniqueWord(s.letter, 50), t: s.t });
  await r.clock.advance(400);
  s = a.snapshot().state.chain;
  assert.equal(s.ends - s.starts, 13000);
  assert.equal(a.snapshot().room.deadline, s.ends);
  assert.deepEqual(r.hub.violations, []);
});

test('the chain view shows the game clock, the turn length and says when turns speed up', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  const toasts = [];
  const views = r.engines.map((engine) => {
    const v = VIEWS.chain({ engine, fx: { confetti() {} }, toast: (t) => toasts.push(t), win: {} });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  r.engines[0].lobby.pick('chain');
  r.engines[0].lobby.setting('timer', 10);
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  const page = text(views[0].el);
  assert.match(page, /Game ends in/);
  assert.match(page, /5:00/);
  assert.match(page, /10 s turns/);
  let s = st(r);
  s = await play(r, uniqueWord(s.letter, 1));
  assert.equal(toasts.length, 0);
  s = await play(r, uniqueWord(s.letter, 2));
  assert.deepEqual(toasts, ['Speeding up! Turns are now 9 s', 'Speeding up! Turns are now 9 s']);
  assert.match(text(views[1].el), /9 s turns/);
  assert.match(text(views[1].el), /Speeding up! Turns are now 9 s\./);
  s = await play(r, uniqueWord(s.letter, 3));
  assert.doesNotMatch(text(views[1].el), /Speeding up!/);
  assert.equal(toasts.length, 2);
  for (const v of views) v.destroy();
});

test('Word Chain lists the new lobby settings with friendly defaults', () => {
  const ids = chain.settings.map((x) => x.id);
  assert.deepEqual(ids, ['timer', 'lives', 'speedup', 'length', 'bonus', 'cats']);
  assert.equal(chain.settings.find((x) => x.id === 'timer').default, 12);
  for (const id of ['bonus', 'cats']) {
    const t = chain.settings.find((x) => x.id === id);
    assert.equal(t.type, 'toggle');
    assert.equal(t.default, true);
  }
  const speed = chain.settings.find((x) => x.id === 'speedup');
  assert.equal(speed.type, 'toggle');
  assert.equal(speed.default, true);
  const length = chain.settings.find((x) => x.id === 'length');
  assert.deepEqual(length.options.map((o) => o.label), ['No limit', '3 min', '5 min', '8 min']);
  assert.equal(length.default, 5);
});

test('a player who leaves Word Chain loses all their lives and stays out', async () => {
  const r = await startChain(3, { timer: 15 });
  const [host, a, b] = r.engines;
  const gone = b.snapshot().meSlot;
  r.hub.leave(b.snapshot().me);
  b.destroy();
  await r.clock.advance(600);
  const s = host.snapshot().state.chain;
  assert.equal(s.lives[gone], 0, 'all lives gone');
  assert.ok(s.out.includes(gone), 'marked out');
  assert.equal(s.phase, 'turn', 'the other two keep playing');
  assert.ok(a.snapshot().state.chain);
});
