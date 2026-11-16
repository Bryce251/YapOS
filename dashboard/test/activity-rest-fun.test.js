import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { CARD_IDS } from '../web/activity/js/fun.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { unmask } from '../web/activity/js/games/draw.js';
import scramble, { KEY as SCRAMBLE, scrambleHint } from '../web/activity/js/games/scramble.js';
import hive, { hiveHint } from '../web/activity/js/games/hive.js';
import emoji, { KEY as EMOJI, emojiHint, puzzleOf, scramble as seal } from '../web/activity/js/games/emoji.js';
import truths, { KEY as TRUTHS, truthsHint, mask as lieMask } from '../web/activity/js/games/truths.js';
import bluff, { bluffHint } from '../web/activity/js/games/bluff.js';
import story, { KEY as STORY } from '../web/activity/js/games/story.js';
import hangman, { KEY as HANGMAN, hangmanHint, LIVES } from '../web/activity/js/games/hangman.js';
import musicquiz, { musicHint } from '../web/activity/js/games/musicquiz.js';
import { wordById } from '../web/activity/data/scramble.js';
import { wordById as hangWord } from '../web/activity/data/hangman.js';
import { factById } from '../web/activity/data/bluff.js';
import { TUNES } from '../web/activity/data/musicquiz.js';
import { award, streak, keep, reel, funMem } from '../web/activity/js/games/funkit.js';

const SLICE = [scramble, hive, emoji, truths, bluff, story, hangman, musicquiz];
const TURN_BASED = new Set(['truths', 'story']);
const RUDE = decodeTerm('jybd');

function def(game, id) {
  return game.settings.find((s) => s.id === id).default;
}

async function begin(game, n, settings = {}, before = null) {
  const r = room(n, { games: [game] });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(game.id), true);
  for (const [k, v] of Object.entries(settings)) assert.equal(host.lobby.setting(k, v), true, k);
  if (before) before(host);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function only(game, cards) {
  return { ...game, cards };
}

test('every game in the slice declares the chaos cards it can support', () => {
  for (const g of SLICE) {
    assert.ok(Array.isArray(g.cards) && g.cards.length >= 2, g.id);
    for (const c of g.cards) assert.ok(CARD_IDS.includes(c), `${g.id} ${c}`);
    assert.equal(g.cards.includes('freeze'), TURN_BASED.has(g.id), `${g.id} freeze is only for turn based games`);
    if (g.cards.includes('peek')) assert.equal(typeof g.hint, 'function', `${g.id} needs a hint for peek`);
    assert.equal(typeof g.awards, 'function', g.id);
    assert.equal(typeof g.highlights, 'function', g.id);
  }
  assert.equal(story.cards.includes('peek'), false, 'there is no fair hint in a story');
});

test('default games are shorter, with longer options still there', () => {
  assert.equal(def(scramble, 'rounds'), 8);
  assert.equal(def(hive, 'timer'), 90);
  assert.equal(def(emoji, 'rounds'), 8);
  assert.equal(def(emoji, 'timer'), 25);
  assert.equal(def(truths, 'write'), 60);
  assert.equal(def(truths, 'vote'), 15);
  assert.equal(def(bluff, 'timer'), 45);
  assert.equal(def(story, 'timer'), 30);
  assert.equal(def(hangman, 'timer'), 45);
  assert.equal(def(musicquiz, 'rounds'), 8);
  assert.equal(def(musicquiz, 'timer'), 15);
  const top = (g, id) => Math.max(...g.settings.find((s) => s.id === id).options.map((o) => o.value));
  assert.equal(top(scramble, 'rounds'), 15);
  assert.equal(top(hive, 'timer'), 180);
  assert.equal(top(truths, 'write'), 120);
  assert.equal(top(bluff, 'timer'), 90);
  assert.equal(top(hangman, 'timer'), 90);
});

test('the score helper stores what was really awarded and works with older apis', () => {
  const calls = [];
  assert.equal(award({ addPoints: (s, n) => (calls.push([s, n]), n * 2) }, '3', 50), 100);
  assert.deepEqual(calls, [[3, 50]]);
  assert.equal(award({ addPoints: () => undefined }, 1, 70), 70);
  assert.equal(award({ addPoints: () => 5 }, 'x', 70), 0);
  const said = [];
  const api = { memory: {}, say: (k, d) => said.push([k, d.n]) };
  streak(api, 1, true);
  streak(api, 1, true);
  streak(api, 1, false);
  streak(api, 1, true);
  assert.deepEqual(said, [['streak', 1], ['streak', 2], ['streak', 1]]);
  assert.equal(funMem(api).best[1], 2);
});

test('the highlight reel keeps the best few, in order, and skips anything the filter hides', () => {
  const api = { memory: {} };
  assert.equal(keep(api, `a ${RUDE} answer`, 1, 9), false);
  for (let i = 0; i < 12; i += 1) keep(api, `answer ${i} https://x.example/y`, i % 3, i);
  const out = reel(api);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((x) => x.text.split(' ')[1]), ['7', '8', '9', '10', '11']);
  assert.ok(out.every((x) => x.text.includes('🔗') && !x.text.includes('example')));
});

test('peek hints are fair: they help a little and never hand over the answer', () => {
  const sst = { phase: 'play', got: [[2, 100]] };
  assert.equal(scrambleHint(sst, 'planet', 1), 'It starts with "PL" and has 6 letters.');
  assert.equal(scrambleHint(sst, 'planet', 2), null, 'no hint once you have it');
  assert.equal(scrambleHint({ ...sst, phase: 'reveal' }, 'planet', 1), null);
  const est = { phase: 'guess', got: [] };
  assert.equal(emojiHint(est, { a: 'Finding Nemo' }, 0), 'It\'s 2 words and starts with "F".');
  assert.equal(emojiHint(est, { a: 'Titanic' }, 0), 'It\'s one word and starts with "T".');
  const hst = { phase: 'guess', n: 1, ps: { 0: ['ab', LIVES, 0, 0, '____'], 1: ['', 0, 0, 0, '____'] } };
  const h = hangmanHint(hst, 'bark', 0);
  assert.match(h, /^The word has the letter "[RK]" in it\.$/);
  assert.equal(hangmanHint(hst, 'bark', 1), null, 'out of lives');
  const ids = TUNES.slice(0, 4).map((x) => x.id);
  const mst = { phase: 'listen', n: 2, c: ids };
  const mh = musicHint(mst, { n: 2, answer: 1, picks: {} }, 0);
  assert.ok(TUNES.slice(0, 4).some((x, i) => i !== 1 && mh === `It's not "${x.title}".`), mh);
  assert.equal(musicHint(mst, { n: 2, answer: 1, picks: { 0: { i: 1 } } }, 0), null);
  const tst = { phase: 'vote', v: 3, writer: 0 };
  const t = truthsHint(tst, { v: 3, lieAt: 2, votes: {} }, 1);
  assert.match(t, /^Statement [12] is true/);
  assert.equal(truthsHint(tst, { v: 3, lieAt: 2, votes: {} }, 0), null, 'the writer gets nothing');
  const bcur = { n: 4, owners: { 0: [1], 2: [2] }, truth: 1, picks: {} };
  const bst = { phase: 'pick', n: 4, chunks: 1 };
  const read = () => [[0, 'fake one'], [1, 'the truth'], [2, 'fake two']];
  assert.equal(bluffHint(bst, bcur, 1, read), '"fake two" is a fake.', 'never your own fake or the truth');
  const fact = factById('b001');
  const w = bluffHint({ phase: 'write', n: 4, f: { id: 'b001' } }, bcur, 1, read);
  assert.ok(w.includes(fact.a[0].toUpperCase()) && !w.includes(fact.a));
  const hv = hiveHint({ phase: 'play', id: 7, l: 'abelrst' }, { id: 7, all: ['stable', 'blast', 'bleats'], found: { 0: ['stable'] } }, 0);
  assert.match(hv, /^Try a 6-letter word starting with "BL"\.$/);
});

test('scramble: a double card and the final round stack, and the board shows real points', async () => {
  const r = await begin(only(scramble, ['double']), 1, { rounds: 5, length: 'short' });
  const [host] = r.engines;
  assert.equal(host.snapshot().fun.card.id, 'double');
  assert.equal(host.play('double'), true);
  await r.clock.advance(300);
  const want = [200, 100, 100, 100, 200];
  for (let i = 0; i < 5; i += 1) {
    let s = host.snapshot().state[SCRAMBLE];
    assert.equal(s.i, i);
    assert.equal(host.snapshot().fun.final, i === 4, `round ${i + 1}`);
    host.act({ type: 'guess', text: wordById(unmask(s.w, s.k)), i: s.i });
    await r.clock.advance(400);
    s = host.snapshot().state[SCRAMBLE];
    assert.deepEqual(s.got, [[0, want[i]]], `round ${i + 1}`);
    if (i < 4) await r.clock.advance(5400);
  }
  assert.equal(host.snapshot().scores.g[0], 700);
});

test('scramble: peek sends a private hint to the player who played it', async () => {
  const r = await begin(only(scramble, ['peek']), 2, { rounds: 5 });
  const [host, a] = r.engines;
  const got = [];
  const theirs = [];
  a.on('hint', (x) => got.push(x.text));
  host.on('hint', (x) => theirs.push(x.text));
  assert.equal(a.play('peek'), true);
  await r.clock.advance(500);
  assert.equal(got.length, 1);
  assert.match(got[0], /^It starts with "[A-Z]{2}"/);
  assert.deepEqual(theirs, []);
  assert.equal(JSON.stringify(r.hub.state).includes(got[0]), false);
});

test('scramble: three in a row earns a streak award and the reel shows the fastest solve', async () => {
  const r = await begin(scramble, 1, { rounds: 5 }, (h) => h.lobby.party('cards', false));
  const [host] = r.engines;
  assert.equal(host.snapshot().fun.card, null, 'no card when chaos is off');
  for (let i = 0; i < 5; i += 1) {
    const s = host.snapshot().state[SCRAMBLE];
    host.act({ type: 'guess', text: wordById(unmask(s.w, s.k)), i: s.i });
    await r.clock.advance(6000);
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  const titles = snap.fun.awards.map((a) => a.title);
  assert.ok(titles.includes('Unstoppable'), titles.join());
  assert.ok(titles.includes('Word wizard'));
  assert.ok(snap.fun.highlights.some((h) => /unscrambled [A-Z]+ in \d/.test(h.text)));
  assert.equal(snap.fun.card, null);
});

test('emoji: funny wrong guesses make the reel, rude ones never do, and the first solver gets an award', async () => {
  const r = await begin(emoji, 2, { rounds: 5, timer: 20 });
  const [host, a] = r.engines;
  const slotA = a.snapshot().meSlot;
  let s = host.snapshot().state[EMOJI];
  a.act({ type: 'guess', x: seal('a very confused banana', s.k), i: s.i });
  await r.clock.advance(400);
  a.act({ type: 'guess', x: seal(`${RUDE} stuff here`, s.k), i: s.i });
  await r.clock.advance(400);
  assert.equal(JSON.stringify(r.hub.state).includes('banana'), false, 'still private during the round');
  for (let i = 0; i < 5; i += 1) {
    s = host.snapshot().state[EMOJI];
    const answer = puzzleOf(s).a;
    a.act({ type: 'guess', x: seal(answer, s.k), i: s.i });
    await r.clock.advance(400);
    host.act({ type: 'guess', x: seal(answer, s.k), i: s.i });
    await r.clock.advance(400);
    await r.clock.advance(5200);
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  const reelText = snap.fun.highlights.map((h) => h.text).join('\n');
  assert.match(reelText, /a very confused banana/);
  assert.equal(reelText.includes(RUDE), false);
  const mine = snap.fun.highlights.find((h) => h.text.includes('banana'));
  assert.equal(mine.slot, slotA);
  assert.ok(snap.fun.awards.some((x) => x.title === 'Code cracker' && x.slots.includes(slotA)));
});

test('truths: a frozen player sits out the next vote and is thawed after it', async () => {
  const r = await begin(only(truths, ['freeze']), 3, { vote: 15 });
  const [host] = r.engines;
  let s = host.snapshot().state[TRUTHS];
  const slots = [0, 1, 2];
  for (const slot of slots) {
    bySlot(r, slot).act({ type: 'set', n: s.n, s: [`fact a ${slot}`, `fact b ${slot}`, `fib c ${slot}`], c: lieMask(2, s.n) });
  }
  const order = [];
  await r.clock.advance(100);
  s = host.snapshot().state[TRUTHS];
  if (s.phase === 'write') await r.clock.advance(400);
  s = host.snapshot().state[TRUTHS];
  assert.equal(s.phase, 'vote');
  order.push(...s.order);
  const writer = s.writer;
  const [x, y] = slots.filter((q) => q !== writer);
  const nextWriter = s.order[1];
  const target = nextWriter === x ? y : x;
  const by = slots.find((q) => q !== target);
  assert.equal(bySlot(r, by).play('freeze', target), true);
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().fun.frozen, [target]);
  for (const q of slots.filter((q) => q !== writer)) bySlot(r, q).act({ type: 'vote', v: s.v, pick: 0 });
  await r.clock.advance(400);
  assert.equal(host.snapshot().state[TRUTHS].phase, 'reveal', 'freezing mid vote does not change the current set');
  await r.clock.advance(7200);
  s = host.snapshot().state[TRUTHS];
  assert.equal(s.phase, 'vote');
  assert.equal(s.writer, nextWriter);
  assert.deepEqual(s.ice, [target]);
  const tm = truths.model(bySlot(r, target).snapshot());
  assert.equal(tm.frozen, true);
  assert.equal(tm.canVote, false);
  bySlot(r, target).act({ type: 'vote', v: s.v, pick: 1 });
  await r.clock.advance(300);
  assert.deepEqual(host.snapshot().state[TRUTHS].voted, [], 'a frozen vote is refused');
  const voter = slots.find((q) => q !== nextWriter && q !== target);
  bySlot(r, voter).act({ type: 'vote', v: s.v, pick: 1 });
  await r.clock.advance(400);
  s = host.snapshot().state[TRUTHS];
  assert.equal(s.phase, 'reveal', 'the round ends without waiting for the frozen player');
  assert.deepEqual(host.snapshot().fun.frozen, []);
  assert.deepEqual(s.ice, []);
});

test('truths: the reel remembers lies that fooled people', async () => {
  const r = await begin(truths, 3, {}, (h) => h.lobby.party('cards', false));
  const [host] = r.engines;
  let s = host.snapshot().state[TRUTHS];
  for (const slot of [0, 1, 2]) bySlot(r, slot).act({ type: 'set', n: s.n, s: [`I own ${slot} cats`, `I like soup ${slot}`, `I met a llama ${slot}`], c: lieMask(2, s.n) });
  await r.clock.advance(600);
  for (let k = 0; k < 3; k += 1) {
    s = host.snapshot().state[TRUTHS];
    assert.equal(s.phase, 'vote');
    const pick = s.s.findIndex((t) => /cats/.test(t));
    for (const q of [0, 1, 2].filter((q) => q !== s.writer)) bySlot(r, q).act({ type: 'vote', v: s.v, pick });
    await r.clock.advance(400);
    await r.clock.advance(7200);
  }
  await r.clock.advance(9200);
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.ok(snap.fun.highlights.some((h) => /lie "I met a llama \d" fooled 2 people/.test(h.text)));
  assert.ok(snap.fun.awards.some((a) => a.title === 'Best poker face'));
});

test('story: a frozen writer loses their next turn, and the vote is the final round', async () => {
  const r = await begin(only(story, ['freeze']), 3, { laps: 2 });
  const [host] = r.engines;
  let s = host.snapshot().state[STORY];
  const order = s.order.slice();
  assert.equal(s.writer, order[0]);
  const target = order[1];
  const by = order[2];
  assert.equal(bySlot(r, by).play('freeze', target), true);
  await r.clock.advance(400);
  assert.deepEqual(host.snapshot().fun.frozen, [target]);
  bySlot(r, order[0]).act({ type: 'line', t: s.turn, text: 'Once there was a duck.' });
  await r.clock.advance(400);
  s = host.snapshot().state[STORY];
  assert.equal(s.writer, order[2], 'the frozen writer was skipped');
  assert.equal(s.note, 'frozen');
  assert.deepEqual(host.snapshot().fun.frozen, []);
  const m = story.model(bySlot(r, target).snapshot());
  assert.equal(m.iced.isMe, true);
  assert.equal(host.snapshot().scores.g[order[0]], 25);
  while (host.snapshot().state[STORY].phase === 'write') {
    const w = host.snapshot().state[STORY];
    bySlot(r, w.writer).act({ type: 'line', t: w.turn, text: `Then ${w.turn} things happened.` });
    await r.clock.advance(400);
  }
  assert.equal(host.snapshot().state[STORY].phase, 'vote');
  assert.equal(host.snapshot().fun.final, true);
});

test('hangman: reveal gains match what the score board got, final word doubled', async () => {
  const r = await begin(hangman, 1, { rounds: 3 });
  const [host] = r.engines;
  let before = 0;
  let first = 0;
  for (let i = 0; i < 3; i += 1) {
    const s = host.snapshot().state[HANGMAN];
    const word = hangWord(unmask(s.deck[s.i], s.k)).w;
    host.act({ type: 'word', n: s.n, w: word });
    await r.clock.advance(400);
    const after = host.snapshot();
    const gain = after.state[HANGMAN].gained[0];
    assert.equal(after.scores.g[0] - before, gain);
    if (i === 0) first = gain;
    if (i === 2) {
      assert.equal(after.fun.final, true);
      assert.equal(gain, first * 2, 'the final word counts double');
    }
    before = after.scores.g[0];
    await r.clock.advance(6200);
  }
  const snap = host.snapshot();
  assert.equal(snap.room.phase, 'results');
  assert.ok(snap.fun.awards.some((a) => a.title === 'Flawless'));
  assert.ok(snap.fun.highlights.some((h) => /first without a single miss/.test(h.text)));
});

test('slice files keep the house rules', () => {
  const files = ['games/funkit.js', ...SLICE.map((g) => `games/${g.id}.js`), ...SLICE.map((g) => `views/${g.id}.js`)];
  for (const f of files) {
    const src = readFileSync(new URL(`../web/activity/js/${f}`, import.meta.url), 'utf8');
    assert.equal(/\/\*|(^|[^:'"`])\/\/(?!\S*['"`])/m.test(src.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")), false, `${f} has comments`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, f);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
    assert.equal(/\beval\(|new Function\(/.test(src), false, f);
  }
});
