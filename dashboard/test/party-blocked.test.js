import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { BLOCKED_MAX, BLOCKED_CHARS, BLOCKED_TTL, cleanBlockedWord } from '../worker/party-blocked.js';
import { setCustomTerms, censor, isBlockedWord, isBlockedGameWord, findBlocked, decodeTerm, customKey, customTermCount, CUSTOM_MAX } from '../web/activity/js/filter.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const ADMIN = { id: '66666666-6666-4666-8666-666666666666', username: 'mod', display_name: 'Mod Person', avatar_url: '' };
const PATH = '/api/party/blocked-words';

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(ADMIN.id, OWNER.id, 1);
  const owner = (await h.login(OWNER)).cookie;
  const admin = (await h.login(ADMIN)).cookie;
  const bob = (await h.login(BOB)).cookie;
  return { h, owner, admin, bob };
}

async function call(h, method, path, cookie, body) {
  const res = await h.api(method, path, cookie, body);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function publicList(h) {
  const res = await h.request('GET', '/api/activity/blocked');
  assert.equal(res.status, 200);
  return { body: await res.json(), headers: res.headers };
}

test('custom words are normalised like the built-in filter and catch common tricks', () => {
  try {
    assert.equal(setCustomTerms(['Banana', 'go away', 'Pineapple'], { encoded: false }), 3);
    for (const t of ['banana', 'BANANA', 'b a n a n a', 'b.a.n.a.n.a', 'b-a-n-a-n-a', 'baaaannnaaana', 'b4n4n4', 'bananas', 'BаNаNа', 'go away', 'g0   aw4y', 'mypineapplepie', 'P1NEAPPLE']) {
      assert.ok(findBlocked(t).length > 0, t);
      assert.equal(censor(t).changed, true, t);
    }
    for (const t of ['a banal answer', 'bandana', 'go to the bay', 'hello there', 'pine trees and apples']) assert.equal(censor(t).changed, false, t);
    assert.equal(censor('I love banana bread').text, 'I love ■■■■■■ bread');
    assert.equal(isBlockedWord('banana'), true);
    assert.equal(isBlockedGameWord('bananas'), true);
    assert.equal(isBlockedWord('band'), false);
  } finally {
    setCustomTerms([]);
  }
  assert.equal(customTermCount(), 0);
  assert.equal(censor('banana').changed, false);
});

test('the custom list is capped and ignores junk', () => {
  try {
    const many = Array.from({ length: CUSTOM_MAX + 50 }, (_, i) => `word${'x'.repeat(i % 5)}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}`);
    assert.ok(setCustomTerms(many, { encoded: false }) <= CUSTOM_MAX);
    assert.equal(setCustomTerms([null, 5, '', ' ', 'a', '!!', 'x'.repeat(BLOCKED_CHARS + 1)], { encoded: false }), 0);
  } finally {
    setCustomTerms([]);
  }
});

test('cleanBlockedWord keeps the shown word and stores the normalised key', () => {
  assert.deepEqual(cleanBlockedWord('  Pine  Apple! '), { word: 'Pine Apple!', key: 'pine aple' });
  assert.equal(customKey('B4NANA'), 'banana');
  assert.throws(() => cleanBlockedWord(''), /Type a word/);
  assert.throws(() => cleanBlockedWord('x'.repeat(BLOCKED_CHARS + 1)), /under 40/);
  assert.throws(() => cleanBlockedWord('!'), /two letters/);
  assert.throws(() => cleanBlockedWord(7), /Type a word/);
});

test('only the owner and party admins can see and change blocked words', async () => {
  const { h, owner, admin, bob } = await setup();
  assert.equal((await call(h, 'GET', PATH, bob)).status, 403);
  assert.equal((await call(h, 'POST', PATH, bob, { word: 'banana' })).status, 403);
  assert.equal((await call(h, 'GET', PATH, null)).status, 401);
  const a = await call(h, 'GET', PATH, admin);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.words, []);
  assert.equal(a.body.max, BLOCKED_MAX);
  assert.equal(a.body.chars, BLOCKED_CHARS);
  const added = await call(h, 'POST', PATH, admin, { word: 'Banana' });
  assert.equal(added.status, 201);
  assert.equal(added.body.words.length, 1);
  assert.equal(added.body.words[0].word, 'Banana');
  assert.equal(added.body.words[0].added_name, 'Mod Person');
  const o = await call(h, 'GET', PATH, owner);
  assert.equal(o.body.count, 1);
  assert.equal((await call(h, 'DELETE', `${PATH}/${added.body.words[0].id}`, bob)).status, 403);
  const gone = await call(h, 'DELETE', `${PATH}/${added.body.words[0].id}`, owner);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.removed, true);
  assert.equal(gone.body.count, 0);
  const again = await call(h, 'DELETE', `${PATH}/${added.body.words[0].id}`, owner);
  assert.equal(again.body.removed, false);
});

test('adding checks for repeats, the built-in filter, bad input and the cap', async () => {
  const { h, owner } = await setup();
  assert.equal((await call(h, 'POST', PATH, owner, { word: 'banana' })).status, 201);
  const dupe = await call(h, 'POST', PATH, owner, { word: 'B A N A N A' });
  assert.equal(dupe.status, 201);
  const same = await call(h, 'POST', PATH, owner, { word: 'BANANA' });
  assert.equal(same.status, 409);
  assert.equal(same.body.error, 'exists');
  const leet = await call(h, 'POST', PATH, owner, { word: 'b4n4n4' });
  assert.equal(leet.status, 409);
  assert.equal((await call(h, 'POST', PATH, owner, { word: '' })).status, 400);
  assert.equal((await call(h, 'POST', PATH, owner, { word: 'x'.repeat(41) })).status, 400);
  assert.equal((await call(h, 'POST', PATH, owner, { word: 'ok', extra: 1 })).status, 400);
  const builtIn = await call(h, 'POST', PATH, owner, { word: decodeTerm('ustwea').slice(0, 4) });
  assert.equal(builtIn.status, 409);
  assert.equal(builtIn.body.error, 'built_in');
  const stmt = h.db.raw.prepare('INSERT INTO party_blocked_words (id, word, key, added_by, added_name, created) VALUES (?, ?, ?, ?, ?, ?)');
  const have = h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_blocked_words').get().n;
  for (let i = have; i < BLOCKED_MAX; i += 1) stmt.run(`seed${i}`, `w${i}`, `k${i}`, OWNER.id, 'Alice', i);
  const full = await call(h, 'POST', PATH, owner, { word: 'one more' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'too_many');
});

test('adding and removing words lands in the mod log', async () => {
  const { h, admin } = await setup();
  const added = await call(h, 'POST', PATH, admin, { word: 'Pineapple pizza' });
  await call(h, 'DELETE', `${PATH}/${added.body.added}`, admin);
  const log = h.db.raw.prepare('SELECT actor_id, actor_name, action, detail FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['word_add', 'word_remove']);
  assert.ok(log.every((r) => r.actor_id === ADMIN.id && r.actor_name === 'Mod Person'));
  assert.equal(JSON.parse(log[0].detail).word, 'Pineapple pizza');
});

test('the public list is encoded, cached for a minute and refreshed after changes', async () => {
  const { h, owner } = await setup();
  const empty = await publicList(h);
  assert.deepEqual(empty.body, { v: 'none', n: 0, t: [], p: [] });
  assert.match(empty.headers.get('Cache-Control'), /max-age=60/);
  await call(h, 'POST', PATH, owner, { word: 'Pineapple pizza' });
  await call(h, 'POST', PATH, owner, { word: 'banana' });
  const first = await publicList(h);
  assert.equal(first.body.n, 2);
  assert.equal(first.body.t.length, 2);
  const raw = JSON.stringify(first.body);
  assert.doesNotMatch(raw, /banana|pineap|pizza/i);
  assert.deepEqual(first.body.t.map(decodeTerm).sort(), ['banana', 'pineaple piza']);
  h.db.raw.prepare("INSERT INTO party_blocked_words (id, word, key, added_by, added_name, created) VALUES ('sneaky', 'Sneaky', 'sneaky', ?, 'x', 1)").run(OWNER.id);
  assert.equal((await publicList(h)).body.n, 2);
  advance(h, BLOCKED_TTL + 1);
  const later = await publicList(h);
  assert.equal(later.body.n, 3);
  assert.notEqual(later.body.v, first.body.v);
  await call(h, 'DELETE', `${PATH}/sneaky`, owner);
  assert.equal((await publicList(h)).body.n, 2);
  try {
    assert.equal(setCustomTerms(later.body.t), 3);
    assert.equal(censor('I want pineapple   pizza now').changed, true);
    assert.equal(censor('sneeeaky').changed, true);
  } finally {
    setCustomTerms([]);
  }
  const post = await h.request('POST', '/api/activity/blocked', { headers: { Origin: h.base } });
  assert.equal(post.status, 405);
});
