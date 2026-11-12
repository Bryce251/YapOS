import test from 'node:test';
import assert from 'node:assert/strict';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import chain, { checkWord, cleanWord, wordPoints, votesNeeded, nextUp, standing, lastLetter, PROBLEMS, WIN_BONUS, MIN_LETTERS } from '../web/activity/js/games/chain.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { eventText, turnText } from '../web/activity/js/views/chain.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function startChain(n = 3, settings = {}) {
  const r = room(n);
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick('chain'), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
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
  assert.equal(checkWord('a'.repeat(25), 'a', []), 'long');
  assert.equal(checkWord('ice cream', 'i', []), 'letters');
  assert.equal(checkWord('abc1', 'a', []), 'letters');
  assert.equal(checkWord('café', 'c', []), 'letters');
  assert.equal(checkWord('banana', 'a', []), 'start');
  assert.equal(checkWord('apple', 'a', ['apple']), 'used');
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
  assert.deepEqual(s.used, [w1]);
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
  assert.deepEqual(s.used, []);
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

test('the used-word list stays small even in a very long game', async () => {
  const r = await startChain(2, { timer: 20 });
  let s = st(r);
  for (let i = 0; i < 260; i += 1) {
    const w = `${s.letter}${'bcdfghjklmnpqrstvwxyz'[i % 21]}${'bcdfghjklmnpqrstvwxyz'[Math.floor(i / 21) % 21]}${'aeiou'[i % 5]}ster${i % 2 ? 'x' : 'n'}`;
    s = await play(r, w);
  }
  assert.ok(s.count >= 250, String(s.count));
  assert.ok(s.used.length < s.count, 'the oldest words drop off the used list');
  assert.ok(jsonBytes(s) <= MAX_VALUE_BYTES, String(jsonBytes(s)));
  assert.deepEqual(r.hub.violations, []);
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
