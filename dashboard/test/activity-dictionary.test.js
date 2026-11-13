import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { room } from './activity-kit.test.js';
import { installDom } from './dom-shim.js';
import * as dictionary from '../web/activity/js/dictionary.js';
import chain, { checkWord, usedFrom, PROBLEMS, MAX_LETTERS, USED_PREFIX } from '../web/activity/js/games/chain.js';
import { VIEWS } from '../web/activity/js/views/index.js';
import { jsonBytes, MAX_VALUE_BYTES } from '../web/activity/js/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS_FILE = path.join(here, '..', 'web', 'activity', 'data', 'words.txt');
const RAW = readFileSync(WORDS_FILE, 'utf8');
const BANNED = [/\b(claude|anthropic)\b/i, /\bAI\b/, /\bgenerated\b/i];

function bySlot(r, slot) {
  return r.engines.find((e) => e.snapshot().meSlot === slot);
}

function st(r) {
  return r.engines[0].snapshot().state.chain;
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

async function play(r, word) {
  const s = st(r);
  bySlot(r, s.cur).act({ type: 'word', text: word, t: s.t });
  await r.clock.advance(400);
  return st(r);
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

test('the word list is plain lowercase English words from 3 letters up', () => {
  const lines = RAW.split('\n').filter(Boolean);
  assert.ok(lines.length > 300000, String(lines.length));
  assert.equal(RAW.includes('\r'), false);
  for (const w of lines.slice(0, 2000)) assert.match(w, /^[a-z]{3,}$/);
  for (const w of lines.slice(-2000)) assert.match(w, /^[a-z]{3,}$/);
});

test('the dictionary waits until it is asked to load', async () => {
  assert.equal(dictionary.ready, false);
  assert.equal(dictionary.isWord('apple'), false);
  assert.equal(checkWord('aple', 'a', []), null, 'nothing is checked before the list is in');
  let calls = 0;
  const first = dictionary.load(() => {
    calls += 1;
    return RAW;
  });
  const second = dictionary.load(() => {
    calls += 1;
    return RAW;
  });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls, 1, 'the file is fetched once');
  assert.equal(dictionary.ready, true);
  assert.equal(dictionary.failed, false);
  assert.ok(dictionary.size > 300000);
  assert.equal(await dictionary.load(() => {
    calls += 1;
    return '';
  }), true);
  assert.equal(calls, 1);
});

test('real words pass and typos do not', () => {
  for (const w of ['apple', 'Kiosk', 'tulip', 'zyzzyva', 'aah', 'zebra']) assert.equal(dictionary.isWord(w), true, w);
  for (const w of ['aple', 'recieve', 'xbenk', 'teh', 'zzq', '', 'ice cream']) assert.equal(dictionary.isWord(w), false, w);
  assert.equal(checkWord('apple', 'a', []), null);
  assert.equal(checkWord('aple', 'a', []), 'unknown');
  assert.equal(checkWord('recieve', 'r', []), 'unknown');
  assert.equal(checkWord('aple', 'a', [], { dictionary: false }), null);
  assert.equal(PROBLEMS.unknown, "That's not a word in my English dictionary. Check the spelling.");
  for (const t of Object.values(PROBLEMS)) for (const re of BANNED) assert.equal(re.test(t), false, t);
});

test('long words up to 45 letters are fine and longer ones are refused', () => {
  assert.equal(MAX_LETTERS, 45);
  assert.equal(checkWord('hippopotomonstrosesquippedaliophobia', 'h', []), null);
  assert.equal(checkWord('supercalifragilisticexpialidocious', 's', []), null);
  assert.equal(checkWord('floccinaucinihilipilification', 'f', []), null);
  assert.equal(checkWord('pneumonoultramicroscopicsilicovolcanoconiosis', 'p', []), null);
  assert.equal(checkWord('pneumonoultramicroscopicsilicovolcanoconioses', 'p', []), null);
  assert.equal(checkWord(`a${'b'.repeat(44)}`, 'a', []), 'unknown');
  assert.equal(checkWord(`a${'b'.repeat(45)}`, 'a', []), 'long');
});

test('an unsorted list still works', async () => {
  const d = await import(`../web/activity/js/dictionary.js?unsorted=${Date.now()}`);
  assert.equal(d.useText('pear\r\napple\nzebra\n\nkiwi\n'), true);
  for (const w of ['apple', 'kiwi', 'pear', 'zebra']) assert.equal(d.isWord(w), true, w);
  assert.equal(d.isWord('plum'), false);
});

test('a failed download is reported and can be tried again', async () => {
  const d = await import(`../web/activity/js/dictionary.js?fail=${Date.now()}`);
  assert.equal(await d.load(() => Promise.reject(new Error('offline'))), false);
  assert.equal(d.ready, false);
  assert.equal(d.failed, true);
  assert.equal(await d.load(() => 'apple\nkiwi\n'), true);
  assert.equal(d.ready, true);
  assert.equal(d.failed, false);
  assert.equal(d.isWord('kiwi'), true);
});

test('the host refuses typos, explains why, and needs no vote for real words', async () => {
  const r = await startChain(4);
  let s = st(r);
  assert.equal(s.dict, 1);
  const author = s.cur;
  const typo = `${s.letter}zzqx`;
  s = await play(r, typo);
  assert.equal(s.count, 0, 'a typo never joins the chain');
  assert.equal(s.cur, author, 'the same player keeps the turn');
  assert.equal(s.bad.why, 'unknown');
  assert.equal(chain.model(bySlot(r, author).snapshot()).bad.why, 'unknown');
  assert.equal(chain.model(bySlot(r, (author + 1) % 4).snapshot()).bad, null);
  const real = RAW.split('\n').find((w) => w.length >= 4 && w.length <= 6 && w[0] === s.letter);
  s = await play(r, real);
  assert.equal(s.count, 1);
  assert.equal(s.vote, null, 'no vote when the dictionary checked the word');
  assert.equal(s.bad, null);
  const m = chain.model(r.engines[0].snapshot());
  assert.equal(m.vote, null);
  assert.equal(m.dict, true);
  assert.deepEqual(r.hub.violations, []);
});

test('no repeats across hundreds of real words', async () => {
  const pool = new Map();
  for (const w of RAW.split('\n')) {
    if (w.length < 4 || w.length > 7 || !'aeiost'.includes(w[w.length - 1])) continue;
    if (!pool.has(w[0])) pool.set(w[0], []);
    const list = pool.get(w[0]);
    if (list.length < 400) list.push(w);
  }
  const r = await startChain(2, { timer: 20 });
  let s = st(r);
  const played = [];
  const taken = new Set();
  for (let i = 0; i < 360; i += 1) {
    const w = (pool.get(s.letter) || []).find((x) => !taken.has(x));
    assert.ok(w, `ran out of words for ${s.letter}`);
    taken.add(w);
    s = await play(r, w);
    played.push(w);
    assert.equal(s.count, played.length, w);
  }
  await r.clock.advance(1000);
  const snap = r.engines[1].snapshot();
  const used = usedFrom(snap.state);
  for (const w of played) assert.equal(used.has(w), true, w);
  for (const k of Object.keys(snap.state).filter((x) => x.startsWith(USED_PREFIX))) assert.ok(jsonBytes(snap.state[k]) <= MAX_VALUE_BYTES, k);
  assert.ok(jsonBytes(snap.state.chain) <= MAX_VALUE_BYTES);
  const again = played.find((w) => w[0] === s.letter);
  assert.ok(again);
  const count = s.count;
  s = await play(r, again);
  assert.equal(s.count, count);
  assert.equal(s.bad.why, 'used');
  assert.equal(checkWord(again, s.letter, usedFrom(snap.state)), 'used');
  assert.deepEqual(r.hub.violations, []);
});

test('the view stops typos before they are sent', async () => {
  installDom({ url: 'https://yapos.dev/activity/' });
  const r = room(2);
  await r.clock.advance(500);
  const views = r.engines.map((engine) => {
    const v = VIEWS.chain({ engine, fx: { confetti() {} }, toast() {}, win: {} });
    engine.on('change', (snap) => v.update(snap));
    return v;
  });
  r.engines[0].lobby.pick('chain');
  r.engines[0].lobby.start();
  await r.clock.advance(400);
  let s = st(r);
  const up = views[r.engines.findIndex((e) => e.snapshot().meSlot === s.cur)];
  const input = byKey(up.el, 'chain-input');
  input.value = `${s.letter}zzqx`;
  byKey(up.el, 'chain-send').click();
  await r.clock.advance(400);
  assert.match(text(up.el), /not a word in my English dictionary/);
  assert.equal(st(r).bad, null, 'the typo never left the box');
  assert.equal(input.disabled, false);
  bySlot(r, s.cur).act({ type: 'word', text: `${s.letter}qqzv`, t: s.t });
  await r.clock.advance(400);
  s = st(r);
  assert.equal(s.bad.why, 'unknown');
  const real = RAW.split('\n').find((w) => w.length === 5 && w[0] === s.letter);
  input.value = real;
  byKey(up.el, 'chain-send').click();
  await r.clock.advance(400);
  assert.equal(st(r).count, 1);
  assert.doesNotMatch(text(up.el), /didn't load/);
  for (const v of views) v.destroy();
});
