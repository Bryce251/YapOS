import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { room, seeded } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import { isBlockedWord } from '../web/activity/js/filter.js';
import { CATEGORIES } from '../web/activity/data/categories.js';
import chain, { checkWord, inCategory, catOptions, categoryById, categoryWords, catProblem, isBonus, maskWord, wordPoints, roundAt, turnExtra, PROBLEMS, CAT_POINTS, CAT_EVERY, HARD_EXTRA, KEY as CHAIN } from '../web/activity/js/games/chain.js';
import wyr, { twinFor, soulmates, sideCounts, agreement, RECAP_MS as WYR_RECAP_MS, WIN_POINTS, KEY as WYR } from '../web/activity/js/games/wyr.js';
import hottakes, { seal, answerRef, fitRecap, biggestFan, RECAP_KEY, RECAP_BYTES, KEY as HOT } from '../web/activity/js/games/hottakes.js';
import { createChainView, skipText, problemText, eventText } from '../web/activity/js/views/chain.js';
import { createWyrView, twinText, pairText, verdict } from '../web/activity/js/views/wyr.js';
import { createHottakesView, footText } from '../web/activity/js/views/hottakes.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';
import { PROMPTS as WYR_PROMPTS } from '../web/activity/data/wyr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS = new Set(readFileSync(path.join(here, '..', 'web', 'activity', 'data', 'words.txt'), 'utf8').split(/\r?\n/));
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function fake(slots, settings = {}, clock = { now: 1000 }) {
  const store = {};
  const said = [];
  const rounds = [];
  const frozen = new Set();
  const scores = {};
  const api = {
    memory: {},
    settings,
    list: slots.slice(),
    now: () => clock.now,
    random: seeded(3),
    players: () => api.list.map((slot) => ({ slot, id: `id-${slot}`, name: `P${slot}` })),
    nameOf: (s) => `P${s}`,
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    put: (k, v) => {
      if (v === null) delete store[k];
      else store[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(store),
    deadline: null,
    setDeadline(at) {
      api.deadline = at;
    },
    clearDeadline() {
      api.deadline = null;
    },
    shift: (ends, ms) => ends + ms,
    mult: 1,
    addPoints(s, n, o) {
      const got = n > 0 && !(o && o.raw) ? n * api.mult : n;
      scores[s] = (scores[s] || 0) + got;
      return got;
    },
    round: (n, total) => rounds.push([n, total]),
    say: (kind, data) => said.push([kind, data]),
    frozen: (s) => frozen.has(s),
    thaw: (s) => frozen.delete(s),
    done: null,
    finish(w) {
      api.done = w || [];
    },
    points: () => ({ ...scores }),
  };
  return { api, store, said, rounds, frozen, scores, clock };
}

function snapOf(store, slots, me) {
  const players = slots.map((slot) => ({ slot, id: `id-${slot}`, name: `P${slot}`, initials: `P${slot}`, hue: 10, avatar: null, present: true, isMe: slot === me }));
  return { state: store, players, meSlot: me };
}

function chainSettings(over = {}) {
  return { timer: 12, lives: 3, speedup: true, length: 0, bonus: true, cats: true, ...over };
}

function fakeWord(letter, i, end = 'n') {
  const c = 'bdfghklmnprstv';
  return `${letter}${c[i % c.length]}${'aeiou'[i % 5]}${c[Math.floor(i / c.length) % c.length]}o${end}`;
}

function anyWord(st, i, end) {
  if (st.cat && !st.cx) {
    const list = catOptions(st.cat, st.letter, []);
    const w = list.find((x) => !end || x.endsWith(end)) || list[0];
    if (w) return w;
  }
  return fakeWord(st.letter, i, end);
}

function playChain(api, store, word) {
  const st = store[CHAIN];
  chain.intent(api, st.cur, { type: 'word', text: word, t: st.t });
  return store[CHAIN];
}

test('every category word is a real, clean dictionary word and each list is big enough', () => {
  assert.ok(CATEGORIES.length >= 6);
  assert.equal(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length);
  for (const c of CATEGORIES) {
    const words = categoryWords(c.id);
    assert.ok(words.length >= 40, `${c.id} has ${words.length}`);
    assert.equal(new Set(words).size, words.length, c.id);
    for (const w of words) {
      assert.match(w, /^[a-z]{3,}$/, w);
      assert.ok(WORDS.has(w), `${w} is in the dictionary`);
      assert.equal(isBlockedWord(w, { strict: true }), false, w);
      assert.equal(checkWord(w, w[0], [], { dictionary: false, cat: c.id }), null, w);
    }
    for (const field of [c.name, c.what, catProblem(c.id)]) for (const re of BANNED) assert.doesNotMatch(field, re);
    assert.ok(categoryById(c.id));
  }
  assert.equal(inCategory('lion', 'animals'), true);
  assert.equal(inCategory('Lions', 'animals'), true);
  assert.equal(inCategory('foxes', 'animals'), true);
  assert.equal(inCategory('table', 'animals'), false);
  assert.equal(checkWord('table', 't', [], { dictionary: false, cat: 'animals' }), 'cat');
  assert.equal(checkWord('table', 't', [], { dictionary: false }), null);
  assert.equal(checkWord('tiger', 't', ['tiger'], { dictionary: false, cat: 'animals' }), 'used');
  assert.match(PROBLEMS.cat, /category/);
  assert.equal(catProblem('animals'), "That's not on my list of animals. Try another!");
  assert.deepEqual(catOptions('animals', 'z', ['zebra']), []);
  assert.equal(isBonus('Box'), true);
  assert.equal(isBonus('quiz'), true);
  assert.equal(isBonus('quit'), false);
  assert.equal(maskWord('snake'), 'SNA__');
});

test('a word ending on Q, X or Z scores double, celebrates and buys the next player a little time', () => {
  const { api, store, said, scores } = fake([0, 1], chainSettings({ cats: false }));
  chain.start(api);
  store[CHAIN].letter = 'b';
  const who = store[CHAIN].cur;
  const st = playChain(api, store, 'box');
  assert.equal(scores[who], wordPoints('box') * 2);
  assert.equal(st.last.b, 1);
  assert.equal(st.last.p, wordPoints('box') * 2);
  assert.equal(st.letter, 'x');
  assert.equal(st.ends - st.starts, (12 + HARD_EXTRA) * 1000);
  assert.ok(said.some(([k, d]) => k === 'custom' && /ended on X! Double points!/.test(d.text)));
  const m = chain.model(snapOf(store, [0, 1], who));
  assert.equal(m.bonus, true);
  assert.equal(m.words[0].bonus, true);
  assert.equal(m.last.bonus, true);
  assert.equal(m.extra, HARD_EXTRA);
  assert.match(eventText({ ...m, vote: null }), /ending on X for double points/);
  const off = fake([0, 1], chainSettings({ cats: false, bonus: false }));
  chain.start(off.api);
  off.store[CHAIN].letter = 'b';
  const by = off.store[CHAIN].cur;
  const after = playChain(off.api, off.store, 'box');
  assert.equal(off.scores[by], wordPoints('box'));
  assert.equal(after.ends - after.starts, 12000);
  assert.equal(chain.model(snapOf(off.store, [0, 1], by)).words[0].bonus, false);
});

test('every third lap is a category round with its own words, a bonus and a fair way out', () => {
  const { api, store, said, scores } = fake([0, 1], chainSettings({ bonus: false }));
  chain.start(api);
  let st = store[CHAIN];
  for (let i = 0; i < 2 * (CAT_EVERY - 1); i += 1) {
    const last = i === 2 * (CAT_EVERY - 1) - 1;
    st = playChain(api, store, fakeWord(st.letter, i, last ? 'c' : 'n'));
    if (!last) assert.equal(st.cat, null);
  }
  assert.ok(st.cat, 'the third lap has a category');
  assert.equal(st.letter, 'c');
  assert.equal(st.cx, 0);
  const c = categoryById(st.cat);
  assert.ok(said.some(([k, d]) => k === 'custom' && d.text.includes(`Category round: ${c.name}`)));
  assert.equal(st.ends - st.starts, (st.span + 3) * 1000, 'category turns get a little longer');
  const m = chain.model(snapOf(store, [0, 1], st.cur));
  assert.deepEqual(m.cat, { id: c.id, name: c.name, emoji: c.emoji, what: c.what });
  assert.equal(m.catOn, true);
  const who = st.cur;
  st = playChain(api, store, 'cxqzzle');
  assert.equal(st.bad.why, 'cat');
  assert.equal(problemText('cat', m), catProblem(c.id));
  const word = catOptions(st.cat, 'c', [])[0];
  const before = scores[who] || 0;
  st = playChain(api, store, word);
  assert.equal(scores[who] - before, wordPoints(word) + CAT_POINTS);
  assert.equal(st.last.c, 1);
  st = playChain(api, store, anyWord(st, 40));
  assert.equal(st.cat, null, 'the category ends with the lap');
  assert.ok(said.some(([k, d]) => k === 'custom' && /Category round over/.test(d.text)));
  const off = fake([0, 1], chainSettings({ bonus: false, cats: false }));
  chain.start(off.api);
  for (let i = 0; i < 12; i += 1) assert.equal(playChain(off.api, off.store, fakeWord(off.store[CHAIN].letter, i)).cat, null);
});

test('a letter with no category words lets any word through that turn', () => {
  const { api, store } = fake([0, 1], chainSettings({ bonus: false }));
  chain.start(api);
  let st = store[CHAIN];
  for (let i = 0; i < 4; i += 1) st = playChain(api, store, fakeWord(st.letter, i, i === 3 ? 'q' : 'n'));
  assert.ok(st.cat);
  assert.equal(st.letter, 'q');
  if (catOptions(st.cat, 'q', []).length) return;
  assert.equal(st.cx, 1);
  const m = chain.model(snapOf(store, [0, 1], st.cur));
  assert.equal(m.catOn, false);
  st = playChain(api, store, 'qwertyn');
  assert.equal(st.count, 5);
});

test('a frozen player skips their next turn, is thawed and the lap still counts', () => {
  const { api, store, frozen } = fake([0, 1, 2], chainSettings({ cats: false, bonus: false }));
  chain.start(api);
  const st = store[CHAIN];
  const cur = st.cur;
  const next = st.order[(st.order.indexOf(cur) + 1) % 3];
  const after = st.order[(st.order.indexOf(cur) + 2) % 3];
  assert.equal(chain.cards.includes('freeze'), true);
  assert.equal(chain.canFreeze(api, next, cur), true);
  assert.equal(chain.canFreeze(api, cur, cur), false);
  assert.equal(chain.canFreeze(api, 9, cur), false);
  assert.equal(chain.freeze(api, next, cur), true);
  frozen.add(next);
  const s = playChain(api, store, fakeWord(st.letter, 0));
  assert.equal(s.cur, after);
  assert.equal(s.fz, next);
  assert.equal(frozen.has(next), false);
  assert.ok(s.lap.includes(next));
  const m = chain.model(snapOf(store, [0, 1, 2], next));
  assert.equal(m.skipped.isMe, true);
  assert.match(skipText(m), /You were frozen/);
  const s2 = playChain(api, store, fakeWord(s.letter, 1));
  assert.equal(s2.fz, null);
  assert.equal(s2.laps, 1);
});

test('peek gives the player on the clock a masked word, and nobody else', () => {
  const { api, store } = fake([0, 1], chainSettings({ cats: false }));
  chain.start(api);
  store[CHAIN].letter = 's';
  const st = store[CHAIN];
  const tip = chain.hint(api, st.cur);
  assert.match(tip, /^👀 Try this one: S[A-Z]*_+ \(\d+ letters\)$/);
  assert.equal(chain.hint(api, st.order.find((s) => s !== st.cur)), null);
  store[CHAIN].cat = 'animals';
  store[CHAIN].cx = 0;
  const pick = chain.hint(api, st.cur);
  const n = Number(pick.match(/\((\d+) letters\)/)[1]);
  assert.ok(catOptions('animals', 's', []).some((w) => w.length === n && maskWord(w) === pick.match(/: (\S+) /)[1]));
});

test('Word Chain reports rounds, streaks, awards and highlights', () => {
  const { api, store, said, rounds, clock } = fake([0, 1], chainSettings({ cats: false, length: 5 }));
  chain.start(api);
  assert.deepEqual(rounds[0], [1, 5]);
  let st = store[CHAIN];
  const first = st.cur;
  st = playChain(api, store, `${st.letter}oxbox`);
  for (let i = 0; i < 5; i += 1) st = playChain(api, store, i === 2 ? `${st.letter}${'a'.repeat(9)}n` : fakeWord(st.letter, i));
  assert.ok(said.some(([k, d]) => k === 'streak' && d.n === 3));
  clock.now += 4.5 * 60000;
  st = playChain(api, store, fakeWord(st.letter, 9));
  assert.deepEqual(rounds[rounds.length - 1], [5, 5]);
  assert.deepEqual(roundAt({ until: 0, laps: 2 }, 0), { n: 3, total: 0 });
  const awards = chain.awards(api);
  const bonus = awards.find((a) => a.title === 'Bonus hunter');
  assert.deepEqual(bonus.who, [first]);
  assert.ok(awards.find((a) => a.title === 'Wordsmith'));
  const reel = chain.highlights(api);
  assert.ok(reel.length >= 1 && reel.length <= 5);
  assert.ok(reel.every((x) => Number.isInteger(x.who) && typeof x.text === 'string'));
  assert.match(reel[0].text, /letters/);
  for (const a of awards) for (const re of BANNED) assert.doesNotMatch(`${a.title} ${a.why}`, re);
  assert.equal(turnExtra({ bonus: 1, letter: 'z' }, 'animals'), 6);
  const bare = { ...api, memory: undefined, say: undefined, round: undefined, frozen: undefined, nameOf: undefined };
  assert.deepEqual(chain.awards(bare), []);
});

test('the final minute of a timed Word Chain counts double in a real game', async () => {
  const r = room(2);
  await r.clock.advance(500);
  const host = r.engines[0];
  host.lobby.pick('chain');
  for (const [k, v] of Object.entries({ length: 3, timer: 20, lives: 5, bonus: false, cats: false, speedup: false })) assert.equal(host.lobby.setting(k, v), true, k);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(300);
  const by = (slot) => r.engines.find((e) => e.snapshot().meSlot === slot);
  let i = 0;
  while (host.snapshot().state[CHAIN].until - r.clock.t > 55000 && i < 40) {
    await r.clock.advance(14000);
    const s = host.snapshot().state[CHAIN];
    by(s.cur).act({ type: 'word', text: fakeWord(s.letter, i), t: s.t });
    await r.clock.advance(300);
    i += 1;
  }
  const s = host.snapshot().state[CHAIN];
  assert.equal(host.snapshot().fun.final, true);
  const before = host.snapshot().scores.g[s.cur] || 0;
  const word = fakeWord(s.letter, 99);
  by(s.cur).act({ type: 'word', text: word, t: s.t });
  await r.clock.advance(400);
  assert.equal(host.snapshot().scores.g[s.cur] - before, wordPoints(word) * 2);
  assert.deepEqual(r.hub.violations, []);
});

function wyrRound(api, store, picks) {
  for (const [slot, side] of Object.entries(picks)) wyr.intent(api, Number(slot), { type: 'vote', side });
  assert.equal(store[WYR].phase, 'reveal');
  wyr.deadline(api);
}

test('Would You Rather ends with who picked what, twins, soulmates and rebels', () => {
  const { api, store, said, rounds } = fake([0, 1, 2], { rounds: 4, timer: 12, mode: 'majority', recap: true });
  wyr.start(api);
  assert.deepEqual(rounds[0], [1, 4]);
  assert.equal(wyr.hint(api), null);
  wyr.intent(api, 0, { type: 'vote', side: 'a' });
  assert.equal(wyr.hint(api), '👀 So far 1 picked A and 0 picked B.');
  wyr.intent(api, 1, { type: 'vote', side: 'a' });
  wyr.intent(api, 2, { type: 'vote', side: 'b' });
  wyr.deadline(api);
  for (let i = 0; i < 2; i += 1) wyrRound(api, store, { 0: 'b', 1: 'b', 2: 'a' });
  api.mult = 2;
  wyrRound(api, store, { 0: 'a', 1: 'a', 2: 'a' });
  assert.deepEqual(rounds[rounds.length - 1], [4, 4]);
  assert.equal(store[WYR].phase, 'recap');
  assert.equal(api.done, null);
  assert.ok(said.some(([k, d]) => k === 'custom' && /Everyone picked A/.test(d.text)));
  assert.ok(said.some(([k, d]) => k === 'streak' && d.slot === 0 && d.n === 4));
  assert.equal(store[WYR].h.length, 4);
  const m = wyr.model(snapOf(store, [0, 1, 2], 0));
  assert.equal(m.phase, 'recap');
  assert.equal(m.rounds.length, 4);
  assert.deepEqual(m.rounds[0].votersA.map((p) => p.name), ['P0', 'P1']);
  assert.equal(m.rounds[0].mine, 'a');
  assert.equal(m.twin.name, 'P1');
  assert.equal(m.twin.same, 4);
  assert.match(twinText(m.twin), /You and P1 picked the same side 4 of 4 times/);
  assert.match(pairText(m.pair), /Soulmates/);
  assert.match(verdict(m), /who picked what/i);
  const awards = wyr.awards(api);
  assert.deepEqual(awards.find((a) => a.title === 'Soulmates').who, [0, 1]);
  assert.deepEqual(awards.find((a) => a.title === 'Rebel').who, [2]);
  assert.ok(wyr.highlights(api).some((x) => /Everyone would rather/.test(x.text)));
  wyr.deadline(api);
  assert.deepEqual(api.done, []);
  assert.deepEqual(agreement(store[WYR].h, 0, 2), { same: 1, both: 4 });
  assert.equal(twinFor(store[WYR].h, 2).slot, 0);
  assert.equal(soulmates([]), null);
  assert.deepEqual(sideCounts(store[WYR].h).rebel, { 2: 3 });
});

test('Would You Rather awards final round points through the score API and can skip the recap', () => {
  const { api, store, scores } = fake([0, 1], { rounds: 2, timer: 12, mode: 'majority', recap: false });
  wyr.start(api);
  wyrRound(api, store, { 0: 'a', 1: 'a' });
  api.mult = 2;
  wyr.intent(api, 0, { type: 'vote', side: 'b' });
  wyr.intent(api, 1, { type: 'vote', side: 'b' });
  assert.equal(store[WYR].gained[0], WIN_POINTS * 2);
  assert.equal(scores[0], WIN_POINTS * 3);
  wyr.deadline(api);
  assert.deepEqual(api.done, []);
  assert.equal(wyr.settings.find((s) => s.id === 'recap').default, true);
  assert.equal(wyr.settings.find((s) => s.id === 'timer').default, 12);
  assert.ok(!wyr.cards.includes('freeze'));
});

test('Would You Rather history stays small with fifteen prompts and twelve players', () => {
  const slots = Array.from({ length: 12 }, (_, i) => i);
  const { api, store } = fake(slots, { rounds: 15, timer: 12, mode: 'majority', recap: true });
  wyr.start(api);
  for (let i = 0; i < 15; i += 1) wyrRound(api, store, Object.fromEntries(slots.map((s) => [s, (s + i) % 3 ? 'a' : 'b'])));
  assert.equal(store[WYR].phase, 'recap');
  assert.ok(jsonBytes(store[WYR]) <= MAX_VALUE_BYTES, String(jsonBytes(store[WYR])));
  assert.ok(WYR_PROMPTS.length >= 15);
});

function hotGame(slots, settings = {}) {
  const f = fake(slots, { rounds: 2, timer: 45, recap: true, ...settings });
  hottakes.start(f.api);
  return f;
}

function hotWrite(api, store, texts) {
  const st = store[HOT];
  for (const [slot, text] of Object.entries(texts)) hottakes.intent(api, Number(slot), { type: 'answer', n: st.n, code: seal(text, st.nonce) });
  assert.equal(store[HOT].phase, 'vote');
}

function hotCards(store) {
  const out = [];
  for (let i = 0; i < store[HOT].chunks; i += 1) for (const row of store[`hottakes.${i}`] || []) out.push({ id: row[0], text: row[1] });
  return out;
}

test('Hot Takes peeks at the leader, recaps the hottest takes and hands out awards', () => {
  const { api, store, said, rounds } = hotGame([0, 1, 2]);
  assert.deepEqual(rounds[0], [1, 2]);
  for (let round = 1; round <= 2; round += 1) {
    hotWrite(api, store, { 0: `soup ${round}`, 1: `socks ${round}`, 2: `llama ${round}` });
    assert.equal(hottakes.hint(api), null);
    const list = hotCards(store);
    const llama = list.find((c) => c.text.startsWith('llama'));
    const socks = list.find((c) => c.text.startsWith('socks'));
    hottakes.intent(api, 0, { type: 'vote', n: store[HOT].n, id: llama.id });
    assert.match(hottakes.hint(api), /Leading so far with 1 vote: “llama/);
    hottakes.intent(api, 1, { type: 'vote', n: store[HOT].n, id: llama.id });
    hottakes.intent(api, 2, { type: 'vote', n: store[HOT].n, id: socks.id });
    assert.equal(store[HOT].phase, 'reveal');
    hottakes.deadline(api);
  }
  assert.equal(store[HOT].phase, 'recap');
  assert.equal(api.done, null);
  const recap = store[RECAP_KEY];
  assert.equal(recap.length, 2);
  assert.ok(said.some(([k, d]) => k === 'win' && d.slot === 2));
  assert.ok(said.some(([k, d]) => k === 'close' && d.slot === 1));
  assert.ok(said.some(([k, d]) => k === 'streak' && d.slot === 2 && d.n === 2));
  const m = hottakes.model(snapOf(store, [0, 1, 2], 0));
  assert.equal(m.phase, 'recap');
  assert.equal(m.rounds.length, 2);
  assert.equal(m.rounds[0].author.name, 'P2');
  assert.equal(m.rounds[0].iVoted, true);
  assert.deepEqual(m.rounds[0].voters.map((p) => p.name), ['P0', 'P1']);
  assert.match(footText(m), /hottest take of every round/);
  const texts = hottakes.texts(api);
  assert.equal(texts.length, 2);
  assert.equal(texts[0].r, answerRef(recap[0].n, recap[0].no, recap[0].id));
  assert.equal(texts[0].author, 2);
  const awards = hottakes.awards(api);
  assert.deepEqual(awards.find((a) => a.title === 'Hottest takes').who, [2]);
  assert.ok(awards.find((a) => a.title === 'Biggest fan'));
  const reel = hottakes.highlights(api);
  assert.equal(reel.length, 2);
  assert.equal(reel[0].who, 2);
  assert.match(reel[0].text, /llama/);
  assert.deepEqual(hottakes.results(api).extra, { topTake: [2] });
  hottakes.deadline(api);
  assert.deepEqual(api.done, []);
});

test('Hot Takes without the recap finishes after the last reveal and keeps the recap inside a value', () => {
  const { api, store } = hotGame([0, 1, 2], { rounds: 1, recap: false });
  hotWrite(api, store, { 0: 'a', 1: 'b', 2: 'c' });
  const list = hotCards(store);
  for (const s of [0, 1, 2]) hottakes.intent(api, s, { type: 'vote', n: store[HOT].n, id: list.find((c) => c.text !== 'abc'[s]).id });
  hottakes.deadline(api);
  assert.deepEqual(api.done, []);
  const big = Array.from({ length: 12 }, (_, i) => ({ n: i, no: 1, id: 0, p: 'h001', t: '🌶️'.repeat(80), a: i, v: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], k: 11, all: 11 }));
  const fit = fitRecap(big);
  assert.ok(fit.length >= 1);
  assert.ok(jsonBytes(fit) <= RECAP_BYTES);
  assert.ok(RECAP_BYTES < MAX_VALUE_BYTES);
  assert.deepEqual(biggestFan({ 1: { 2: 3, 3: 1 }, 4: { 2: 2 } }), { fan: 1, of: 2, n: 3 });
  assert.equal(biggestFan({ 1: { 2: 1 } }), null);
  const timer = hottakes.settings.find((s) => s.id === 'timer');
  assert.equal(timer.default, 45);
  assert.ok(timer.options.some((o) => o.value === 90), 'longer writing time is still there');
});

function profileFaces(root, min) {
  const faces = all(root).filter((n) => n.classList && n.classList.contains('avatar-btn') && n.getAttribute('data-profile-id'));
  assert.ok(faces.length >= min, `expected at least ${min} profile avatars, got ${faces.length}`);
  for (const f of faces) {
    assert.equal(f.getAttribute('role'), 'button');
    assert.equal(f.getAttribute('tabindex'), '0');
    assert.match(f.getAttribute('aria-label'), /^View (your|.+'s) profile$/);
  }
  return faces;
}

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

function noInlineStyle(root) {
  for (const el of all(root)) assert.equal(el.hasAttribute && el.hasAttribute('style'), false, `${el.className} has a style attribute`);
}

const QUIET = () => {
  const played = [];
  return { played, cues: { play: (n) => played.push(n), burst() {}, float() {} } };
};

test('the views show the category round, the bonus chip and both recaps', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(3);
  await r.clock.advance(500);
  const engine = r.engines[0];

  const c = fake([0, 1], chainSettings({ bonus: true }));
  chain.start(c.api);
  Object.assign(c.store[CHAIN], { cat: 'animals', cx: 0, letter: 'c' });
  const q = QUIET();
  const cv = createChainView({ engine, toast() {}, cues: q.cues, fx: { confetti() {} } });
  cv.update(snapOf(c.store, [0, 1], c.store[CHAIN].cur));
  const ctext = cv.el.textContent;
  assert.match(ctext, /Category round: Animals/);
  assert.match(ctext, /Every word must be an animal/);
  assert.match(ctext, /Q X Z ×2/);
  assert.match(ctext, /Your turn! Type an animal that starts with C/);
  noInlineStyle(cv.el);
  assert.deepEqual(profileFaces(cv.el, 2).map((f) => f.getAttribute('data-profile-id')), ['id-0', 'id-1']);

  const w = fake([0, 1, 2], { rounds: 2, timer: 12, mode: 'majority', recap: true });
  wyr.start(w.api);
  wyrRound(w.api, w.store, { 0: 'a', 1: 'a', 2: 'b' });
  wyrRound(w.api, w.store, { 0: 'b', 1: 'b', 2: 'b' });
  const wq = QUIET();
  const wv = createWyrView({ engine, fx: { confetti() {} }, cues: wq.cues });
  wv.update(snapOf(w.store, [0, 1, 2], 0));
  const wtext = wv.el.textContent;
  assert.match(wtext, /Who picked what/);
  assert.match(wtext, /You and P1 picked the same side 2 of 2 times/);
  assert.equal(wv.el.querySelectorAll('.wyr-recap-row').length, 2);
  noInlineStyle(wv.el);

  const h = hotGame([0, 1, 2], { rounds: 1 });
  hotWrite(h.api, h.store, { 0: 'soup', 1: 'socks', 2: 'llama' });
  const list = hotCards(h.store);
  for (const s of [0, 1, 2]) hottakes.intent(h.api, s, { type: 'vote', n: h.store[HOT].n, id: list.find((x) => x.text === (s === 2 ? 'soup' : 'llama')).id });
  hottakes.deadline(h.api);
  assert.equal(h.store[HOT].phase, 'recap');
  const hq = QUIET();
  const hv = createHottakesView({ engine, fx: { confetti() {} }, cues: hq.cues, toast() {}, win: {} });
  hv.update(snapOf(h.store, [0, 1, 2], 0));
  const htext = hv.el.textContent;
  assert.match(htext, /Who voted for what/);
  assert.match(htext, /llama/);
  assert.equal(hv.el.querySelectorAll('.hottakes-recap-card').length, 1);
  noInlineStyle(hv.el);
});

test('the new game files stay free of comments, inline styles and outside links', () => {
  const root = path.join(here, '..', 'web', 'activity');
  const files = ['js/games/chain.js', 'js/games/wyr.js', 'js/games/hottakes.js', 'js/views/chain.js', 'js/views/wyr.js', 'js/views/hottakes.js', 'data/categories.js', 'css/chain.css', 'css/wyr.css', 'css/hottakes.css'];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.equal(/\/\*/.test(src), false, `${f} has a block comment`);
    if (f.endsWith('.js')) assert.equal(/(^|[^:'"`])\/\/(?![^\n]*['"`])/m.test(src), false, `${f} has a line comment`);
    assert.equal(/https?:\/\//.test(src), false, `${f} links out`);
    assert.equal(/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(src), false, `${f} sets inline styles`);
    for (const re of BANNED) assert.doesNotMatch(src, re, f);
  }
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const id of ['chain', 'wyr']) assert.ok(html.includes(`/activity/css/${id}.css`), id);
});
