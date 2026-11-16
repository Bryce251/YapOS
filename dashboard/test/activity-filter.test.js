import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { room } from './activity-kit.test.js';
import { normalizeForFilter, findBlocked, isBlockedWord, isBlockedGameWord, censor, encodeTerm, decodeTerm, HIDDEN_NOTE, BLOCKED_NOTE } from '../web/activity/js/filter.js';
import { cleanText, cleanShared, hidesWords } from '../web/activity/js/text.js';
import { cleanAdminAction, cleanText as cleanAnnounceText } from '../web/activity/js/engine.js';
import hottakes, { KEY as HOT, ANSWER_PREFIX, seal } from '../web/activity/js/games/hottakes.js';
import truths, { KEY as TRUTHS, cleanSet, problemOf, mask as truthMask } from '../web/activity/js/games/truths.js';
import telephone, { KEY as PHONE, fitText } from '../web/activity/js/games/telephone.js';
import { wordById } from '../web/activity/data/draw.js';
import { unmask } from '../web/activity/js/games/draw.js';
import chain, { checkWord as chainCheck, PROBLEMS as CHAIN_PROBLEMS } from '../web/activity/js/games/chain.js';
import { checkWord as hiveCheck, problemText, pickPuzzle, hiveWords, lettersOf } from '../web/activity/js/games/hive.js';
import { judgeGuess, scrambleWord, blocked as scrambleBlocked } from '../web/activity/js/games/scramble.js';
import * as dictionary from '../web/activity/js/dictionary.js';

const T = Object.fromEntries(
  Object.entries({
    n: 'ustwxn',
    na: 'ustwt',
    ns: 'ustwxnr',
    sn: 'zkatgefijz',
    f: 'mktwhp',
    fag: 'mkt',
    k: 'rsxu',
    ks: 'rsxul',
    sp: 'zzvs',
    ch: 'jrvdd',
    co: 'jybd',
    cos: 'jybdl',
    r: 'yogqkz',
    rd: 'yogqkzdf',
    tr: 'abndgu',
    dy: 'kixu',
    kys: 'rif',
    ky: 'rsyb rkttxmwt',
    kur: 'rsyb nn rgqn',
    hh: 'oovb aesnjz',
    sh: 'zsrw aahn',
    gj: 'nkf jaa igba',
    wb: 'dogrtyj',
    pk: 'wkxy',
    gk: 'nyba',
    wp: 'drvjx lnyjz',
    hd: 'osgbxn cki vzhyckg zxxzv',
    be: 'iondxn',
  }).map(([k, v]) => [k, decodeTerm(v)]),
);

const MARK = '■';
const SWEARS = ['fuck', 'fucking', 'shit', 'bullshit', 'damn', 'hell', 'ass', 'asshole', 'bitch', 'bastard', 'crap', 'piss', 'pissed', 'dick', 'cock', 'wtf', 'goddamn', 'motherfucker', 'twat', 'bollocks', 'bloody'];
const INNOCENT = [
  'snigger', 'sniggering', 'niggle', 'niggling', 'niggardly', 'Scunthorpe', 'spicy', 'spice', 'conspicuous', 'chinkapin', 'cocktail', 'analysis',
  'therapist', 'raccoon', 'cocoon', 'tycoon', 'Niger', 'Nigeria', 'night', 'Pakistan', 'Japan', 'japanese', 'squawk', 'retardant', 'tardy',
  'dike', 'grape', 'kitten', 'honky-tonk', 'spick and span', 'woops', 'pollack', 'darkle', 'niggun', 'renege', 'shoot yourself in the foot',
  'red skins', 'wet back', 'go ok', 'is it ok', 'kill your self-esteem', 'Hitler was a dictator', 'the Holocaust happened', 'Nazi Germany lost the war',
];

function spaced(word, sep) {
  return Array.from(word).join(sep);
}

test('the blocklist is stored encoded, never as plain words', () => {
  const src = readFileSync(new URL('../web/activity/js/filter.js', import.meta.url), 'utf8');
  for (const word of Object.values(T)) {
    if (word.includes(' ')) continue;
    assert.equal(new RegExp(`\\b${word}\\b`).test(src.toLowerCase()), false, 'a blocked word is readable in the source');
  }
  const me = readFileSync(new URL(import.meta.url), 'utf8');
  for (const word of [T.n, T.f, T.k, T.sp, T.ch, T.tr, T.wb]) assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(me), false);
  assert.equal(new RegExp(`\\b${T.n}\\b`).test(`a ${T.n} b`), true);
  for (const word of ['hello', 'abc', 'kill your self', 'x-y z']) assert.equal(decodeTerm(encodeTerm(word)), word);
  assert.notEqual(encodeTerm('hello'), 'hello');
});

test('slurs, hate slogans and self harm pushes are found', () => {
  for (const key of ['n', 'na', 'ns', 'sn', 'f', 'fag', 'k', 'ks', 'sp', 'ch', 'co', 'cos', 'r', 'rd', 'tr', 'dy', 'kys', 'ky', 'kur', 'hh', 'sh', 'gj', 'wb', 'pk', 'gk', 'wp', 'hd', 'be']) {
    assert.ok(findBlocked(`you ${T[key]} lol`).length > 0, `term ${key}`);
  }
  assert.ok(findBlocked('1488').length > 0);
  assert.ok(findBlocked('just 14/88 things').length > 0);
});

test('swears and ordinary words stay untouched', () => {
  for (const w of SWEARS) {
    assert.deepEqual(findBlocked(w), [], w);
    assert.equal(isBlockedWord(w), false, w);
  }
  const line = `${SWEARS.join(' ')}, what the hell, this shit is fucking great`;
  assert.deepEqual(censor(line), { text: line, changed: false });
  for (const w of INNOCENT) assert.deepEqual(findBlocked(w), [], w);
  for (const w of ['snigger', 'niggle', 'niggardly', 'spicy', 'chinkapin', 'raccoon', 'retardant', 'squawk', 'japan', 'grape', 'cocktail', 'analysis']) {
    assert.equal(isBlockedWord(w), false, w);
  }
});

test('common dodges are still caught', () => {
  const n = T.n;
  const dodges = [
    n.toUpperCase(),
    spaced(n, ' '),
    spaced(n, '.'),
    spaced(n, '_'),
    spaced(n, '-'),
    n.replace('i', '1'),
    n.replace('i', '!'),
    n.replace('i', '|'),
    n.replace('e', '3'),
    n.replace('i', 'l'),
    n.replace('i', 'iiii').replace('g', 'ggg'),
    n.replace('i', 'і'),
    n.replace('e', 'е'),
    n.replace('i', 'ι'),
    n.replace('g', 'g​'),
    n.replace('i', 'í'),
    Array.from(n).map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''),
    `${n}!!`,
    `${n}'s`,
    `hello,${n}`,
    'n_1_g',
    spaced(T.na, ' '),
  ];
  for (const d of dodges) assert.ok(findBlocked(d).length > 0, `dodge ${JSON.stringify(encodeTerm(d))}`);
  assert.ok(findBlocked(T.f.replace('a', '@')).length > 0);
  assert.ok(findBlocked(T.sp.replace('s', '$')).length > 0);
  assert.ok(findBlocked(`${spaced(T.kys, ' ')}`).length > 0);
  assert.ok(findBlocked(`${T.kys}!`).length > 0);
  assert.ok(findBlocked(T.ky.replace(/ /g, '')).length > 0);
  assert.ok(findBlocked(T.ky.replace('ll', '11')).length > 0);
  assert.ok(findBlocked(`just go ${T.ky} now`).length > 0);
  assert.ok(findBlocked(T.hh.toUpperCase()).length > 0);
});

test('normalizing maps look-alikes, drops hidden characters and squeezes repeats', () => {
  assert.deepEqual(normalizeForFilter('Hеllooo  W0rld'), { text: 'helo world', compact: 'heloworld' });
  assert.equal(normalizeForFilter('c​a​t').compact, 'cat');
  assert.equal(normalizeForFilter('Ⓒⓐⓣ').compact, 'cat');
  assert.equal(normalizeForFilter('ｃａｔ').compact, 'cat');
  assert.equal(normalizeForFilter('café').text, 'cafe');
  assert.equal(normalizeForFilter('$h0p').compact, 'shop');
  assert.equal(normalizeForFilter('c a t').compact, 'cat');
  assert.deepEqual(normalizeForFilter(''), { text: '', compact: '' });
});

test('censoring keeps the rest readable and the same length', () => {
  const line = `well you ${T.n} and a ${T.sp}, damn`;
  const out = censor(line);
  assert.equal(out.changed, true);
  assert.equal(Array.from(out.text).length, Array.from(line).length);
  assert.equal(out.text, `well you ${MARK.repeat(T.n.length)} and a ${MARK.repeat(T.sp.length)}, damn`);
  const spacedOut = censor(`ok ${spaced(T.n, ' ')} ok`);
  assert.equal(spacedOut.text, `ok ${MARK.repeat(T.n.length * 2 - 1)} ok`);
  assert.equal(censor(`${T.kys}!`).text, `${MARK.repeat(3)}!`);
  assert.deepEqual(censor('a normal sentence'), { text: 'a normal sentence', changed: false });
  assert.deepEqual(censor(''), { text: '', changed: false });
  assert.deepEqual(censor(null), { text: '', changed: false });
  const spans = findBlocked(`hi ${T.k}`);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 3);
  assert.equal(spans[0].end, 3 + T.k.length);
});

test('single words: blocked terms and their simple forms', () => {
  for (const key of ['n', 'na', 'ns', 'f', 'fag', 'k', 'ks', 'sp', 'ch', 'co', 'cos', 'r', 'rd', 'tr', 'dy', 'kys', 'wb', 'pk', 'gk', 'be']) assert.equal(isBlockedWord(T[key]), true, key);
  assert.equal(isBlockedWord(`${T.k}s`), true);
  assert.equal(isBlockedWord(`${T.dy}s`), true);
  assert.equal(isBlockedWord(`${T.tr.slice(0, -1)}ies`), true);
  assert.equal(isBlockedWord(T.n.toUpperCase()), true);
  assert.equal(isBlockedWord(''), false);
  assert.equal(isBlockedWord(null), false);
});

test('shared text is cleaned and censored before it is clipped', () => {
  assert.equal(cleanShared(`  hey   ${T.n}  `), `hey ${MARK.repeat(T.n.length)}`);
  assert.equal(cleanShared('hello there'), cleanText('hello there'));
  const long = `${'x'.repeat(76)} ${T.n}`;
  const clipped = cleanShared(long, 80);
  assert.equal(Array.from(clipped).length, 80);
  assert.equal(clipped.endsWith(MARK.repeat(3)), true);
  assert.equal(hidesWords(`yo ${T.co}`), true);
  assert.equal(hidesWords('yo dude'), false);
  assert.equal(HIDDEN_NOTE, 'Some words were hidden.');
  assert.match(BLOCKED_NOTE, /isn.t allowed here/);
});

test('clipping an innocent word at the limit never leaves a slur behind', () => {
  const word = `${T.sp}y`;
  assert.equal(censor(word).changed, false);
  const shared = cleanShared(`${'x'.repeat(75)} ${word}`, 80);
  assert.equal(shared.includes(T.sp), false);
  assert.equal(shared.endsWith(MARK.repeat(T.sp.length)), true);
  const ann = cleanAnnounceText(`${'x'.repeat(135)} ${word}`);
  assert.equal(Array.from(ann).length, 140);
  assert.equal(ann.includes(T.sp), false);
  assert.equal(fitText(`${'x'.repeat(75)} ${word}`).includes(T.sp), false);
  const wide = `${'😀'.repeat(38)}xxx ${word}`;
  assert.equal(new TextEncoder().encode(wide).length, 161);
  const fit = fitText(wide);
  assert.equal(fit.includes(T.sp), false);
  assert.equal(new TextEncoder().encode(fit).length <= 160, true);
  assert.equal(cleanShared(`${'x'.repeat(10)} ${word}`, 80).endsWith(word), true);
});

test('admin announcements are censored on the host and when shown', () => {
  const a = cleanAdminAction({ type: 'announce', text: `listen up ${T.f}` });
  assert.equal(a.text, `listen up ${MARK.repeat(T.f.length)}`);
  assert.equal(cleanAnnounceText(`ok ${T.gj}`).includes(T.gj), false);
  assert.equal(cleanAdminAction({ type: 'announce', text: 'damn good game' }).text, 'damn good game');
});

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

async function started(games, id, n = 3) {
  const r = room(n, { games });
  await r.clock.advance(500);
  const host = r.engines[0];
  assert.equal(host.lobby.pick(id), true);
  assert.equal(host.lobby.start().ok, true);
  await r.clock.advance(400);
  return r;
}

function stateText(r) {
  return JSON.stringify(r.hub.state).toLowerCase();
}

test('hot takes: answers are censored by the host before anyone sees them', async () => {
  const r = await started([hottakes], 'hottakes');
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  const lines = [`what a ${T.n} move`, 'a fucking great answer', 'pizza'];
  slots.forEach((slot, i) => {
    const e = bySlot(r, slot);
    const s = e.snapshot().state[HOT];
    e.act({ type: 'answer', n: s.n, code: seal(lines[i], s.nonce) });
  });
  await r.clock.advance(600);
  const s = r.hub.state[HOT];
  const texts = [];
  for (let i = 0; i < s.chunks; i += 1) for (const row of r.hub.state[`${ANSWER_PREFIX}${i}`] || []) texts.push(row[1]);
  assert.equal(texts.length, 3);
  assert.ok(texts.includes(`what a ${MARK.repeat(T.n.length)} move`));
  assert.ok(texts.includes('a fucking great answer'), 'swears stay');
  assert.equal(stateText(r).includes(T.n), false);
  const mine = hottakes.model(bySlot(r, slots[0]).snapshot());
  assert.equal(mine.cards.filter((c) => c.isMine).length <= 1, true);
});

test('two truths: statements are censored by the host and checked the same way on the client', async () => {
  const raw = [`I met a ${T.k} once`, 'I hate damn mondays', 'I can juggle'];
  const set = cleanSet(raw);
  assert.equal(set[0], `I met a ${MARK.repeat(T.k.length)} once`);
  assert.equal(set[1], 'I hate damn mondays');
  assert.equal(problemOf([T.k, T.k.toUpperCase(), 'fine'], 0), 'same');
  assert.equal(cleanSet([T.k, T.k.toUpperCase(), 'fine']), null);
  const r = await started([truths], 'truths');
  const slots = r.engines.map((e) => e.snapshot().meSlot);
  for (const slot of slots) {
    const e = bySlot(r, slot);
    const n = e.snapshot().state[TRUTHS].n;
    const s = slot === slots[1] ? raw : [`Slot ${slot} has a bike`, `Slot ${slot} met a goat`, `Slot ${slot} can whistle`];
    e.act({ type: 'set', n, s, c: truthMask(2, n) });
  }
  const seen = [];
  for (let i = 0; i < 30; i += 1) {
    await r.clock.advance(3000);
    const st = r.hub.state[TRUTHS];
    if (st && Array.isArray(st.s)) seen.push(...st.s);
    assert.equal(stateText(r).includes(T.k), false);
  }
  assert.ok(seen.includes(`I met a ${MARK.repeat(T.k.length)} once`), 'the censored statement is shown');
});

test('draw telephone: phrases and descriptions are censored before they are passed on', async () => {
  assert.equal(fitText(`a ${T.ch} on a boat`), `a ${MARK.repeat(T.ch.length)} on a boat`);
  const r = await started([telephone], 'telephone');
  const [host, a, b] = r.engines;
  host.act({ type: 'text', step: 0, text: `A ${T.tr} juggling` });
  a.act({ type: 'text', step: 0, text: 'A damn whale' });
  b.act({ type: 'text', step: 0, text: 'A robot baking bread' });
  await r.clock.advance(500);
  assert.equal(r.hub.state[PHONE].phase, 'draw');
  const prompts = r.engines.map((e) => telephone.model(e.snapshot()).prompt);
  assert.ok(prompts.includes(`A ${MARK.repeat(T.tr.length)} juggling`), JSON.stringify(prompts.map(encodeTerm)));
  assert.ok(prompts.includes('A damn whale'));
  for (const p of prompts) assert.equal(String(p).toLowerCase().includes(T.tr), false);
});

test('draw and guess: guesses in the feed are censored for everyone', async () => {
  const r = room(3);
  await r.clock.advance(500);
  for (const e of r.engines) e.join();
  await r.clock.advance(400);
  assert.equal(r.engines[0].lobby.pick('draw'), true);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  let st = r.engines[0].snapshot().state.draw;
  bySlot(r, st.drawer).act({ type: 'pick', i: 0, n: st.n });
  await r.clock.advance(400);
  st = r.engines[0].snapshot().state.draw;
  assert.equal(st.phase, 'draw');
  const word = wordById(unmask(st.w, st.nonce)).w;
  assert.equal(findBlocked(word).length, 0);
  const guesser = r.engines.find((e) => e.snapshot().meSlot !== st.drawer);
  guesser.act({ type: 'guess', text: `is it a ${T.sp}` });
  await r.clock.advance(800);
  st = r.engines[0].snapshot().state.draw;
  const last = st.feed[st.feed.length - 1];
  assert.equal(last[2], `is it a ${MARK.repeat(T.sp.length)}`);
  assert.equal(stateText(r).includes(T.sp), false);
});

test('word chain: blocked words are refused with a clear reason', async () => {
  assert.equal(chainCheck(T.co, 'c', []), 'blocked');
  assert.equal(chainCheck(T.co, 'c', [], { dictionary: false }), 'blocked');
  assert.equal(chainCheck('cocoon', 'c', []), null);
  assert.equal(chainCheck('dandy', 'd', []), null);
  assert.equal(CHAIN_PROBLEMS.blocked, BLOCKED_NOTE);
  const r = room(3, { games: [chain] });
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.pick('chain'), true);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  let st = r.engines[0].snapshot().state.chain;
  bySlot(r, st.cur).act({ type: 'word', text: `${st.letter}aank`, t: st.t });
  await r.clock.advance(400);
  st = r.engines[0].snapshot().state.chain;
  assert.equal(st.letter, 'k');
  bySlot(r, st.cur).act({ type: 'word', text: T.ks, t: st.t });
  await r.clock.advance(400);
  st = r.engines[0].snapshot().state.chain;
  assert.equal(st.bad.why, 'blocked');
  assert.equal(st.words.some((w) => w[2] === T.ks), false);
  assert.equal(stateText(r).includes(T.ks), false);
});

test('letter hive: blocked words are never in the list, never revealed and refused', () => {
  const extra = [T.ch, `${T.ch}s`];
  dictionary.useText(['kite', 'kitten', 'kitchen', 'thick', 'chin', ...extra].sort().join('\n'));
  try {
    const puzzle = pickPuzzle(() => 0.1, { seeds: ['kitchen'], words: ['kite', 'kitten', 'kitchen', 'thick', ...extra], tries: 3, min: 1 });
    assert.ok(puzzle);
    for (const w of extra) assert.equal(puzzle.words.includes(w), false);
    assert.ok(puzzle.words.includes('kitchen'));
    const letters = lettersOf('kitchen');
    assert.equal(hiveWords(letters, 'k').some((w) => extra.includes(w)), false);
    assert.equal(hiveCheck(T.ch, { letters, centre: 'k' }, [], { answers: new Set([T.ch]) }), 'blocked');
    assert.equal(hiveCheck(T.ch, { letters, centre: 'k' }, []), 'blocked');
    assert.equal(hiveCheck('kitchen', { letters, centre: 'k' }, [], { answers: new Set(['kitchen']) }), null);
    assert.equal(problemText('blocked', 'k'), BLOCKED_NOTE);
  } finally {
    dictionary.reset();
  }
});

test('scramble: blocked words are never accepted, revealed or used as a scramble', () => {
  const target = Array.from(T.cos).reverse().join('');
  dictionary.useText([T.cos, 'other'].sort().join('\n'));
  try {
    assert.equal(scrambleBlocked(T.cos), true);
    assert.equal(judgeGuess(T.cos, target, { dictionary: true }), 'unknown');
    for (let i = 0; i < 200; i += 1) assert.notEqual(scrambleWord(target, Math.random, () => false), T.cos);
    assert.equal(scrambleBlocked('apple'), false);
  } finally {
    dictionary.reset();
  }
});

test('the private note and refusal copy stay plain and friendly', () => {
  for (const t of [HIDDEN_NOTE, BLOCKED_NOTE]) {
    assert.doesNotMatch(t, /\b(claude|anthropic)\b/i);
    assert.doesNotMatch(t, /\bAI\b/);
  }
});

const DICTIONARY_HITS = ["abndged","akvw","dogrtyj","dogrtyju","drbhx","drbhxo","dstwxn","dyc","dyci","dyt","fsq","fsqi","iondxn","iondxnr","iybdz","iyukgg","iyukggr","jksvka","jrvdd","jrvddedt","jrvddeduy","jrvddo","jrvddu","jrvdtidp","jrvdtizp","jrvdxa","jybbba","jybbbar","jybd","jybdl","kixu","kixul","kkeaba","kkeabar","kkear","kkeaxu","kkeaxur","kkte","kktel","kktexo","mkt","mkti","mktwhp","mktwhpdf","mktwhpqa","mktwhpr","mktwhpx","mktwr","mktwxn","mktwxnx","nicfh","nsaph","nscfh","nyba","nybal","nyybbsni","nyybbsnil","nyybbsnix","nyybrsni","oyaaba","oyaabar","oyaar","oyaaxu","oyaaxur","pxwkg","qkc","qstqukn","qstquknu","rixu","rksvbn","rksvbnr","rksyk","rksyko","rsxu","rsxul","tyawhhhqnl","tyawhhnki","tyawhhnkia","tyyulp","tyyulpdf","tyyulpdt","tyyulpdtx","tyyulphpl","tyyulpr","ust","ustwbjf","ustwhp","ustwkw","ustwxn","ustwxncqr","ustwxndf","ustwxnekxp","ustwxnekxppg","ustwxnfqtap","ustwxnggfl","ustwxnhum","ustwxnhur","ustwxnkkso","ustwxnr","ustwxnsqj","ustwxnvgjl","ustwxnx","ustwxp","ustwxz","woqeidhnj","woqeidhnni","wspatjhpsg","wspatjhpsqpg","wspqgempd","wspqgempnmd","wspstjhp","wspstjhpsg","wspstjhpsqpg","wsxur","wybvmwg","wyyqvg","ykcu","ykcul","ykcuw","ykcygc","ykcylp","ykcylpr","yogqkz","yogqkzdf","yogqkzr","yoqidem","yoqidemu","zahqp","zahqpo","zvhj","zvhjl","zvhjmu","zzva","zzval","zzvs","zzvsd","zzvsdo","zzvsl","zzvw"];

test('the full word list only loses slurs and their forms', () => {
  const words = readFileSync(new URL('../web/activity/data/words.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
  const hits = words.filter((w) => isBlockedWord(w));
  assert.deepEqual(hits.map(encodeTerm).sort(), DICTIONARY_HITS.slice().sort());
  for (const w of ['mktem', 'mktemo', 'mktemp', 'mktwhphpl'].map(decodeTerm)) {
    assert.equal(isBlockedWord(w), false, w);
    assert.equal(words.includes(w), true, w);
  }
  for (const w of ['muzzle', 'muzzles', 'snigger', 'niggle', 'niggard', 'chinkapin', 'spicy', 'scunthorpe', 'cocktail', 'analysis', 'raccoon', 'retardant', 'tardy', 'dike', 'japan']) {
    assert.equal(isBlockedWord(w), false, w);
  }
});

test('everyday sentences with swears or look-alike words pass untouched', () => {
  const lines = [
    "I can't believe that analysis", 'pass the cocktail sauce', 'Scunthorpe United', 'what the fuck is this shit', 'damn it, hell yeah',
    'you absolute bastard', 'bitch please', 'piss off', 'dick move bro', 'the raccoon ate my snacks', 'big tycoon energy',
    'Niger and Nigeria', 'a nightingale sang', 'I am a spicy boi', 'a japanese garden', 'the kids are tardy', 'fire retardant spray',
    'go ok', 'goo k thanks', 'he is a cook', 'honk honk', 'Mongolia is huge', 'my mongoose', 'Pakistan and India', 'spa zone',
    'it is a wet back road', 'shoot yourself in the foot', 'kill your darlings', 'end your turn', 'hang your coat', 'kill all the zombies',
    'death to the robots', 'the holocaust was terrible', 'hitler was evil', 'it costs 14.88', 'n e v e r', 'Nigel', 'go co on', 'coonhound',
    'spice girls', 'yiddish', 'Jackson Pollock', 'Santiago', 'darkly', 'dark yellow', 'injury', 'red skin', 'mustard', 'custard',
    'leotards', 'retardants', 'tea bag', 'wiggle', 'sofa gg', 'the gg ez', 'uni gg wp', 'skys the limit', 'keys', 'hail hydra', 'muzzle it',
  ];
  for (const line of lines) assert.deepEqual(censor(line), { text: line, changed: false }, line);
  for (const key of ['jrvdd em vmm lfdirr', 'jrvddo nh qqrvk', 'oyaar pnpp', 'oyaarpnpp', 'mktem', 'mktemo', 'mktemp', 'mktwhphpl']) {
    const line = decodeTerm(key);
    assert.deepEqual(censor(`well ${line} there`), { text: `well ${line} there`, changed: false }, key);
  }
  assert.equal(censor(`${T.ch} go home`).changed, true);
  assert.equal(censor(`you ${T.ch}`).changed, true);
});

test('words split across spaces are hidden whole, not half', () => {
  for (const key of ['ust wxn', 'us twxn', 'ustw xn', 'mk twhp']) {
    const line = decodeTerm(key);
    assert.equal(censor(`ok ${line} ok`).text, `ok ${MARK.repeat(Array.from(line).length)} ok`, key);
  }
  assert.equal(censor(`${T.na} please`).text, `${MARK.repeat(T.na.length)} please`);
});

test('more dodges are caught', () => {
  for (const key of ['wrnwzks', 'mkdghp', 'rsy ohqqujtq', 'usort', '6 tsybbkm yfayh vhlujn']) {
    assert.ok(findBlocked(decodeTerm(key)).length > 0, key);
  }
  const n = T.n;
  for (const d of [
    n.replace('i', '!').replace('e', '3'),
    n.replace(/g/g, 'q'),
    `${n}5`,
    `${n}z`,
    spaced(n, '/'),
    spaced(n, '*'),
    spaced(n, ','),
    `lol${n}`,
    `ugly-${n}`,
    n.replace('n', 'ñ'),
    n.replace('i', 'ï'),
    spaced(n, '​'),
    `${T.f.replace('a', '4').replace('o', '0')}`,
    `${T.f}s`,
    `${T.k.replace('i', '1')}`,
    T.tr.replace('a', '@'),
    T.co.replace(/o/g, '0'),
    T.r.replace('e', '3'),
    T.kys.toUpperCase(),
    spaced(T.kys, '.'),
    spaced(T.kys, '-'),
    `${T.kys}!!!`,
    T.ky.replace('yourself', 'urself'),
    T.ky.replace('yourself', 'yourselfff'),
    T.ky.replace(' ', ''),
    T.hh.replace('i', '1').replace('e', '3'),
  ]) {
    assert.ok(findBlocked(d).length > 0, `dodge ${JSON.stringify(encodeTerm(d))}`);
  }
});

const VARIANTS = ['rixu', 'rixul', 'rilax', 'rsvyda', 'zzva', 'zzval', 'zzvsd', 'zzvsdo', 'nyybrsni', 'wspstjhpsg', 'kkeaxu', 'oyaaba', 'jrvdxa', 'rksvbn', 'jybbba', 'dstwxn', 'wybvmwg', 'nscfh', 'uitwxn', 'uitwxnr', 'rixus', 'jybds', 'wrnwhp'].map(decodeTerm);
const VARIANT_OK = ['ksxu', 'ksxul', 'kkesr', 'kkesb', 'rsfi', 'jsf', 'ssq', 'jkxu', 'rspaxa', 'zzvsr', 'zzvsx', 'jybaba', 'roli', 'jya', 'wyybtyj'].map(decodeTerm);
const GAME_WORDS = [
  'kspa', 'kspal', 'jypa', 'jypal', 'asgi', 'asg', 'asgjbar', 'wefir', 'mepa', 'mepabjf', 'tygxxnewhspf', 'zrvj', 'ieybldhv', 'jeaj', 'woayl',
  'cktygw', 'iybrl', 'jez', 'ksyth', 'wyed', 'wyedhcqcupj', 'oyedr', 'zvhj', 'drbhx', 'zoko', 'zok', 'ykcu', 'agnj', 'dkaaxn', 'isgsa',
  'hcfxhhd', 'jvvjhnhu', 'vbtqli', 'aofjbykgx', 'lbbjby', 'uotuk', 'zxbw', 'iyetxhkq', 'ykhdvdhgw', 'woeytjzn', 'iybwxnlcs',
  'hcf', 'ikfjtnc', 'jbnf', 'uequ', 'uscfear', 'oybaxn', 'wszf', 'mogyld', 'oizyx', 'sofrh', 'nyqttim', 'kkzd', 'areuxonoj',
].map(decodeTerm);
const GAME_OK = [
  'jypaies', 'zrhjmhdetkv', 'jypakkzem', 'jypatpnq', 'jypar', 'okashyj', 'kspaxjr', 'kspaxu', 'kspar', 'kspaxn', 'asgjxn', 'asgxx', 'asgchqrg',
  'wefiryzv', 'wefirbnqy', 'wefi', 'hxaqeo', 'jezyg', 'jepkfxdt', 'jezkeqr', 'zokjtjs', 'zokjxp', 'zokjhj', 'lcfuq', 'zmhdmdntum', 'woaylpnpj',
  'pxiqzemcym', 'tsfxbp', 'jefxbpd', 'zrvjmwg', 'zrvymwjg', 'zgndd', 'zgnddu', 'dbvimszvhp', 'zkyjpwsgw', 'hcfqlohp', 'wkfibkm', 'arrhtlhuy',
  'zmeqia', 'kbnfx', 'oyedxp', 'zrbhg', 'hxnbros', 'iegjhj', 'kypkfamv', 'jyaimeswyqzb',
].map(decodeTerm).concat(['cocktail', 'peacock', 'title', 'analysis', 'grape', 'dickens', 'hello', 'pimple', 'shaggy', 'craps', 'naked', 'public', 'testy', 'assess', 'class', 'nickname', 'snicker', 'knickers', 'panicky', 'quiz']);
const G = Object.fromEntries(Object.entries({ d: 'kspa', ds: 'kspal', t: 'asgi', s: 'zrvj', ss: 'zrvjl' }).map(([k, v]) => [k, decodeTerm(v)]));
const STRICT_COUNT = 614;

test('slur spelling variants are caught everywhere without touching look-alike words', () => {
  for (const w of VARIANTS) {
    assert.equal(isBlockedWord(w), true, encodeTerm(w));
    assert.ok(findBlocked(`you ${w} lol`).length > 0, encodeTerm(w));
  }
  for (const w of VARIANT_OK) {
    assert.equal(isBlockedWord(w), false, encodeTerm(w));
    assert.deepEqual(findBlocked(`a ${w} here`), [], encodeTerm(w));
  }
  for (const key of ['zzvsd wmf xxlb', 'zzvsd-wmf-xxlb']) {
    const line = decodeTerm(key);
    assert.deepEqual(censor(`so ${line} now`), { text: `so ${line} now`, changed: false }, key);
  }
  for (const key of ['fyh argd', 'drnj t ookp', 'ny x o d a']) assert.equal(censor(decodeTerm(key)).changed, true, key);
});

test('strict mode blocks crude and sexual words on top of slurs', () => {
  for (const w of GAME_WORDS) {
    assert.equal(isBlockedWord(w, { strict: true }), true, encodeTerm(w));
    assert.equal(isBlockedGameWord(w), true, encodeTerm(w));
    assert.equal(isBlockedGameWord(w.toUpperCase()), true, encodeTerm(w));
  }
  for (const w of [...VARIANTS, T.n, T.k, T.f]) assert.equal(isBlockedGameWord(w), true, encodeTerm(w));
  for (const w of GAME_OK) assert.equal(isBlockedGameWord(w), false, encodeTerm(w));
  assert.equal(isBlockedGameWord(''), false);
  assert.equal(isBlockedGameWord(null), false);
});

const HIDDEN_EVERYWHERE = new Set(["ykcu","ykcul","ykcuw","ykcygc","ykcylp","ykcylpr","tyyulp","tyyulpr","tyyulpdf","tyyulpdt","tyyulpdtx","tyyulphpl","woqe","woqel","woqeidhnj","woqeidhnja","woqeidhnni","wkrth","wkrtho","wkrthlgkqm","wkrthlgkqmd","drbhx","drbhxo","zvhj","zvhjl","zvhjmu","zundd","zunddo","zunddu"].map(decodeTerm));

test('strict mode leaves free text alone: swears still pass in chat and answers', () => {
  for (const w of GAME_WORDS) {
    if (HIDDEN_EVERYWHERE.has(w)) continue;
    assert.equal(isBlockedWord(w), false, encodeTerm(w));
    assert.deepEqual(censor(`well ${w} then`), { text: `well ${w} then`, changed: false }, encodeTerm(w));
  }
  for (const w of SWEARS) assert.equal(isBlockedWord(w), false, w);
});

test('the crude word list is stored encoded too', () => {
  const src = readFileSync(new URL('../web/activity/js/filter.js', import.meta.url), 'utf8').toLowerCase();
  for (const w of [...GAME_WORDS, ...VARIANTS]) assert.equal(new RegExp(`\\b${w}\\b`).test(src), false, encodeTerm(w));
  const scramble = readFileSync(new URL('../web/activity/js/games/scramble.js', import.meta.url), 'utf8').toLowerCase();
  for (const w of GAME_WORDS) assert.equal(new RegExp(`'${w}'`).test(scramble), false, encodeTerm(w));
});

test('strict mode over the full word list blocks a reviewed set and spares everyday words', () => {
  const words = readFileSync(new URL('../web/activity/data/words.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
  const strict = new Set(words.filter((w) => isBlockedGameWord(w)));
  assert.equal(strict.size, STRICT_COUNT);
  for (const w of words.filter((x) => isBlockedWord(x))) assert.equal(strict.has(w), true, encodeTerm(w));
  for (const w of GAME_OK) assert.equal(strict.has(w), false, encodeTerm(w));
});

test('word chain refuses crude words with the friendly message but keeps innocent ones', async () => {
  assert.equal(chainCheck(G.d, 'd', []), 'blocked');
  assert.equal(chainCheck(G.d, 'd', [], { dictionary: false }), 'blocked');
  assert.equal(chainCheck(G.t, G.t[0], [], { dictionary: false }), 'blocked');
  assert.equal(chainCheck(VARIANTS[0], VARIANTS[0][0], [], { dictionary: false }), 'blocked');
  for (const w of ['cocktail', 'dickens', 'title', 'peacock', 'dandy']) assert.equal(chainCheck(w, w[0], [], { dictionary: false }), null, w);
  const r = room(3, { games: [chain] });
  await r.clock.advance(500);
  assert.equal(r.engines[0].lobby.pick('chain'), true);
  assert.equal(r.engines[0].lobby.start().ok, true);
  await r.clock.advance(300);
  let st = r.engines[0].snapshot().state.chain;
  bySlot(r, st.cur).act({ type: 'word', text: `${st.letter}aad`, t: st.t });
  await r.clock.advance(400);
  st = r.engines[0].snapshot().state.chain;
  assert.equal(st.letter, 'd');
  bySlot(r, st.cur).act({ type: 'word', text: G.d, t: st.t });
  await r.clock.advance(400);
  st = r.engines[0].snapshot().state.chain;
  assert.equal(st.bad.why, 'blocked');
  assert.equal(CHAIN_PROBLEMS[st.bad.why], BLOCKED_NOTE);
  assert.equal(st.words.some((w) => w[2] === G.d), false);
});

test('letter hive never lists, accepts or reveals crude words', () => {
  const list = ['dickens', 'snide', 'kind', 'skid', 'nice', 'dine', 'send', G.d, G.ds];
  dictionary.useText(list.slice().sort().join('\n'));
  try {
    const puzzle = pickPuzzle(() => 0.1, { seeds: ['dickens'], words: list, tries: 3, min: 1 });
    assert.ok(puzzle);
    assert.equal(puzzle.words.includes(G.d), false);
    assert.equal(puzzle.words.includes(G.ds), false);
    assert.ok(puzzle.words.includes('dickens'));
    const letters = lettersOf('dickens');
    const all = hiveWords(letters, 'd');
    assert.equal(all.includes(G.d) || all.includes(G.ds), false);
    assert.equal(hiveCheck(G.d, { letters, centre: 'd' }, [], { answers: new Set([G.d]) }), 'blocked');
    assert.equal(hiveCheck(G.ds, { letters, centre: 'd' }, []), 'blocked');
    assert.equal(hiveCheck('dickens', { letters, centre: 'd' }, [], { answers: new Set(['dickens']) }), null);
  } finally {
    dictionary.reset();
  }
});

test('scramble never uses, accepts or shows crude words', async () => {
  const { SHORT, MEDIUM, LONG } = await import('../web/activity/data/scramble.js');
  for (const w of [...SHORT, ...MEDIUM, ...LONG]) assert.equal(scrambleBlocked(w), false, w);
  const { SEEDS } = await import('../web/activity/data/hive.js');
  for (const w of SEEDS) assert.equal(isBlockedGameWord(w), false, w);
  for (const w of GAME_WORDS) assert.equal(scrambleBlocked(w), true, encodeTerm(w));
  for (const w of ['apple', 'title', 'cocktail', 'dickens']) assert.equal(scrambleBlocked(w), false, w);
  dictionary.useText([G.s, 'hist', 'this'].sort().join('\n'));
  try {
    assert.equal(judgeGuess(G.s, 'hist', { dictionary: true }), 'unknown');
    assert.equal(judgeGuess('this', 'hist', { dictionary: true }), 'other');
    for (let i = 0; i < 200; i += 1) assert.notEqual(scrambleWord('hist', Math.random, () => false), G.s);
  } finally {
    dictionary.reset();
  }
});

test('sexual violence terms and sexual insults are hidden everywhere, swears and look-alike words stay', () => {
  const blocked = ['ykcu', 'ykcylp', 'tyyulpdt', 'woqeidhnj', 'wkrth', 'drbhx', 'zvhj', 'zundd'].map(decodeTerm);
  for (const term of blocked) {
    assert.equal(censor(`well ${term} then`).changed, true, encodeTerm(term));
    assert.equal(isBlockedWord(term), true, encodeTerm(term));
    assert.equal(isBlockedGameWord(term), true, encodeTerm(term));
  }
  for (const fine of ['grape juice', 'close the drape', 'scrape it', 'trapeze artist', 'rapeseed oil', 'my pedometer', 'he was rapping', 'she rapped the beat', 'my favorite rapper', 'what a fucking day']) {
    assert.equal(censor(fine).text, fine, fine);
  }
});
