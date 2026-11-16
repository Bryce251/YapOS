import test from 'node:test';
import assert from 'node:assert/strict';
import { configureAdmins, resetAdmins, cleanPackCode, cleanPack, loadPack, cachedPack, PACK_ENDPOINT, PACK_WORDS_MAX, PACK_TRIVIA_MAX } from '../web/activity/js/admin.js';

function fetcher(log, reply) {
  return async (url, init) => {
    log.push({ url, init });
    const r = typeof reply === 'function' ? reply(url) : reply;
    return { ok: r.ok !== false, json: async () => r.body };
  };
}

const PACK = {
  code: 'K7QX2M4P',
  name: 'Movie night',
  words: ['Popcorn', 'popcorn', 'Director', '  Red carpet  ', 'x'.repeat(60)],
  trivia: [
    { q: 'Which planet is red?', a: 'Mars', w: ['Venus', 'Jupiter', 'Saturn'] },
    { q: 'Only two wrong', a: 'Yes', w: ['No', 'Maybe'] },
    { q: 'Answer repeated', a: 'Cat', w: ['Cat', 'Dog', 'Cow'] },
    { q: 'Duplicate wrongs', a: 'One', w: ['Two', 'two', 'Three'] },
    'nonsense',
  ],
};

test('pack codes keep uppercase letters and digits only', () => {
  assert.equal(cleanPackCode(' k7qx-2m4p '), 'K7QX2M4P');
  assert.equal(cleanPackCode('a'.repeat(30)).length, 12);
  assert.equal(cleanPackCode(null), '');
});

test('pack contents are cleaned and capped on the way in', () => {
  const p = cleanPack(PACK);
  assert.equal(p.name, 'Movie night');
  assert.deepEqual(p.words.slice(0, 3), ['Popcorn', 'Director', 'Red carpet']);
  assert.equal(p.words[3].length, 40);
  assert.equal(p.trivia.length, 1);
  assert.deepEqual(p.trivia[0], { q: 'Which planet is red?', a: 'Mars', w: ['Venus', 'Jupiter', 'Saturn'] });
  const big = cleanPack({ words: Array.from({ length: 900 }, (_, i) => `word${i}`), trivia: Array.from({ length: 400 }, (_, i) => ({ q: `Q${i}?`, a: `A${i}`, w: [`B${i}`, `C${i}`, `D${i}`] })) });
  assert.equal(big.words.length, PACK_WORDS_MAX);
  assert.equal(big.trivia.length, PACK_TRIVIA_MAX);
  assert.equal(cleanPack({ words: [], trivia: [] }), null);
  assert.equal(cleanPack(null), null);
});

test('loadPack fetches a pack by code once and caches it', async () => {
  const log = [];
  configureAdmins({ fetch: fetcher(log, { body: PACK }), refreshMs: 0, win: null });
  try {
    const [a, b] = await Promise.all([loadPack('k7qx2m4p'), loadPack('K7QX-2M4P')]);
    assert.equal(a, b);
    assert.equal(log.length, 1);
    assert.equal(log[0].url, `${PACK_ENDPOINT}K7QX2M4P`);
    assert.deepEqual(Object.keys(a).sort(), ['code', 'name', 'trivia', 'words']);
    assert.equal(a.words[0], 'Popcorn');
    assert.equal(cachedPack('k7qx2m4p'), a);
    await loadPack('K7QX2M4P');
    assert.equal(log.length, 1);
  } finally {
    resetAdmins();
  }
});

test('short codes, missing packs and network errors give null', async () => {
  const log = [];
  configureAdmins({ fetch: fetcher(log, (url) => (url.endsWith('GONE1234') ? { ok: false, body: {} } : { body: { words: [] } })), refreshMs: 0, win: null });
  try {
    assert.equal(await loadPack(''), null);
    assert.equal(await loadPack('AB'), null);
    assert.equal(log.length, 0);
    assert.equal(await loadPack('GONE1234'), null);
    assert.equal(await loadPack('EMPTY123'), null);
  } finally {
    resetAdmins();
  }
  configureAdmins({ fetch: async () => { throw new Error('offline'); }, refreshMs: 0, win: null });
  try {
    assert.equal(await loadPack('K7QX2M4P'), null);
  } finally {
    resetAdmins();
  }
});
