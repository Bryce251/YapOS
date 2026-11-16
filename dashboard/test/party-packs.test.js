import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { MAX_PACKS, MAX_PACK_WORDS, MAX_PACK_TRIVIA, PACK_CODE_RE, newPackCode, normalizeCode, cleanPack } from '../worker/party-packs.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { installDom, type, fire, flush } from './dom-shim.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const SLUR = decodeTerm('yogqkz');

function q(i, over = {}) {
  return { q: `What is question number ${i}?`, a: `Answer ${i}`, w: [`Wrong ${i}a`, `Wrong ${i}b`, `Wrong ${i}c`], ...over };
}

function pack(over = {}) {
  return { name: 'Movie night', words: ['popcorn', 'Ticket', 'popcorn', ' red carpet ', ''], trivia: [q(1)], ...over };
}

async function signedIn() {
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  const { cookie } = await h.login(ALICE);
  const bob = (await h.login(BOB)).cookie;
  return { h, cookie, bob };
}

test('pack codes are 8 clear characters and are matched without caring about case', () => {
  for (let i = 0; i < 200; i += 1) assert.match(newPackCode(), PACK_CODE_RE);
  assert.equal(normalizeCode(' devpack2 '), 'DEVPACK2');
  assert.equal(normalizeCode('DEVPACK0'), null);
  assert.equal(normalizeCode('DEVPACKI'), null);
  assert.equal(normalizeCode('SHORT'), null);
});

test('a signed-in user can make, read, change and delete a pack', async () => {
  const { h, cookie } = await signedIn();
  const made = await h.api('POST', '/api/packs', cookie, pack());
  assert.equal(made.status, 201);
  const { pack: p } = await made.json();
  assert.match(p.code, PACK_CODE_RE);
  assert.equal(p.name, 'Movie night');
  assert.deepEqual(p.words, ['popcorn', 'ticket', 'red carpet']);
  assert.equal(p.wordCount, 3);
  assert.equal(p.triviaCount, 1);
  const list = await (await h.api('GET', '/api/packs', cookie)).json();
  assert.equal(list.max, MAX_PACKS);
  assert.deepEqual(list.limits, { words: MAX_PACK_WORDS, trivia: MAX_PACK_TRIVIA, name: 40 });
  assert.equal(list.packs.length, 1);
  assert.equal(list.packs[0].words, undefined);
  const one = await (await h.api('GET', `/api/packs/${p.code.toLowerCase()}`, cookie)).json();
  assert.deepEqual(one.pack.trivia, [q(1)]);
  const changed = await h.api('PUT', `/api/packs/${p.code}`, cookie, { name: 'Film night', words: ['camera'], trivia: [] });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).pack.words, ['camera']);
  const pub = await h.request('GET', `/api/activity/pack/${p.code.toLowerCase()}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(await pub.json(), { code: p.code, name: 'Film night', words: ['camera'], trivia: [] });
  const gone = await h.api('DELETE', `/api/packs/${p.code}`, cookie);
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).deleted, true);
  assert.equal((await h.request('GET', `/api/activity/pack/${p.code}`)).status, 404);
});

test('packs belong to whoever made them', async () => {
  const { h, cookie, bob } = await signedIn();
  const { pack: p } = await (await h.api('POST', '/api/packs', cookie, pack())).json();
  assert.equal((await h.api('GET', `/api/packs/${p.code}`, bob)).status, 404);
  assert.equal((await h.api('PUT', `/api/packs/${p.code}`, bob, pack({ name: 'Mine now' }))).status, 404);
  assert.equal((await h.api('DELETE', `/api/packs/${p.code}`, bob)).status, 404);
  assert.equal((await (await h.api('GET', '/api/packs', bob)).json()).packs.length, 0);
  assert.equal((await h.api('GET', '/api/packs', null)).status, 401);
  assert.equal((await h.api('POST', '/api/packs', cookie, pack(), { Origin: 'https://evil.example' })).status, 403);
});

test('each person can keep up to ten packs', async () => {
  const { h, cookie } = await signedIn();
  for (let i = 0; i < MAX_PACKS; i += 1) {
    assert.equal((await h.api('POST', '/api/packs', cookie, pack({ name: `Pack ${i}` }))).status, 201);
  }
  const extra = await h.api('POST', '/api/packs', cookie, pack());
  assert.equal(extra.status, 409);
  assert.equal((await extra.json()).error, 'too_many');
});

test('pack text is checked and limited', async () => {
  const { h, cookie } = await signedIn();
  const cases = [
    [{ name: '' }, 'bad_name'],
    [{ name: 'x'.repeat(41) }, 'bad_name'],
    [{ words: [], trivia: [] }, 'empty_pack'],
    [{ words: 'popcorn' }, 'bad_words'],
    [{ words: ['a'] }, 'bad_words'],
    [{ words: ['x'.repeat(31)] }, 'bad_words'],
    [{ words: ['<script>'] }, 'bad_words'],
    [{ words: Array.from({ length: MAX_PACK_WORDS + 1 }, (_, i) => `word${i}`) }, 'too_many_words'],
    [{ trivia: Array.from({ length: MAX_PACK_TRIVIA + 1 }, (_, i) => q(i)) }, 'too_many_trivia'],
    [{ trivia: [q(1, { w: ['one', 'two'] })] }, 'bad_trivia'],
    [{ trivia: [q(1, { a: '' })] }, 'bad_trivia'],
    [{ trivia: [q(1, { q: 'x'.repeat(201) })] }, 'bad_trivia'],
    [{ trivia: [q(1, { w: ['Answer 1', 'b', 'c'] })] }, 'bad_trivia'],
    [{ colour: 'red' }, 'bad_request'],
  ];
  for (const [over, code] of cases) {
    const res = await h.api('POST', '/api/packs', cookie, pack(over));
    assert.equal(res.status, 400, code);
    assert.equal((await res.json()).error, code);
  }
});

test('crude game words and slurs are refused on save', () => {
  assert.throws(() => cleanPack(pack({ words: ['popcorn', 'shit'] })), (err) => err.code === 'blocked_words');
  assert.throws(() => cleanPack(pack({ trivia: [q(1, { q: `Who is the ${SLUR} here?` })] })), (err) => err.code === 'blocked_trivia');
  assert.throws(() => cleanPack(pack({ name: `${SLUR} pack` })), (err) => err.code === 'blocked_name');
  assert.deepEqual(cleanPack(pack()).words, ['popcorn', 'ticket', 'red carpet']);
});

test('the public pack lookup is rate limited and friendly about bad codes', async () => {
  const { h, cookie } = await signedIn();
  const { pack: p } = await (await h.api('POST', '/api/packs', cookie, pack())).json();
  const nope = await h.request('GET', '/api/activity/pack/NOTACODE');
  assert.equal(nope.status, 404);
  assert.match((await nope.json()).message, /code/);
  assert.equal((await h.request('GET', '/api/activity/pack/bad!')).status, 404);
  const ok = await h.request('GET', `/api/activity/pack/${p.code}`);
  assert.match(ok.headers.get('Cache-Control'), /max-age=60/);
  assert.equal((await h.request('POST', `/api/activity/pack/${p.code}`, { headers: { Origin: h.base } })).status, 405);
  let last;
  for (let i = 0; i < 61; i += 1) last = await h.request('GET', `/api/activity/pack/${p.code}`, { ip: '198.51.100.77' });
  assert.equal(last.status, 429);
});

test('words that a stricter filter blocks later are dropped from the public pack', async () => {
  const { h, cookie } = await signedIn();
  const { pack: p } = await (await h.api('POST', '/api/packs', cookie, pack())).json();
  h.db.raw.prepare('UPDATE party_packs SET words = ?, updated = updated + 1 WHERE code = ?').run(JSON.stringify(['popcorn', 'shit']), p.code);
  const body = await (await h.request('GET', `/api/activity/pack/${p.code}`)).json();
  assert.deepEqual(body.words, ['popcorn']);
});

test('the packs page is served by the single page app', async () => {
  const h = createHarness();
  const res = await h.request('GET', '/packs');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>YapOS<\/title>/);
});

const { document } = installDom({ url: 'https://dash.example.test/packs' });
document.documentElement = document.createElement('html');
const { renderPacks, parseWords, readPacks, packSummary } = await import('../web/js/pages/packs.js');
const { matchRoute } = await import('../web/js/router.js');
const { createShell } = await import('../web/js/shell.js');

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const chrome = [];
  return { api, main, signal: ctrl.signal, params: {}, setChrome: (c) => chrome.push(c), setLeaveGuard: () => {}, chrome, abort: () => ctrl.abort() };
}

const buttons = (root, re) => root.querySelectorAll('button').filter((b) => re.test(b.textContent));
const LIST = { packs: [{ code: 'DEVPACK2', name: 'Sample pack', wordCount: 12, triviaCount: 1 }], max: 10, limits: { words: 500, trivia: 200, name: 40 } };

test('the packs page helpers read words and summaries kindly', () => {
  assert.deepEqual(parseWords('Popcorn\n popcorn ,red   carpet\n\n,'), ['popcorn', 'red carpet']);
  assert.equal(packSummary({ wordCount: 1, triviaCount: 2 }), '1 word · 2 questions');
  assert.equal(readPacks(null).max, 10);
  assert.deepEqual(readPacks({ packs: [{ nope: 1 }, LIST.packs[0]] }).packs.map((p) => p.code), ['DEVPACK2']);
  const r = matchRoute('/packs');
  assert.equal(r.name, 'packs');
  assert.equal(r.private, true);
});

test('every signed-in user gets a word packs link in the account area', () => {
  const shell = createShell({ onLogout: () => {} });
  shell.update({ variant: 'plain', section: 'packs', user: { id: ALICE.id, username: 'alice', display_name: 'Alice' } });
  const link = shell.root.querySelectorAll('a').find((a) => String(a.getAttribute('href') || a.href).endsWith('/packs'));
  assert.ok(link);
  assert.equal(link.getAttribute('aria-current'), 'page');
});

test('the packs page lists packs with their code and a copy button', async () => {
  const ctx = makeCtx({ get: async (path) => {
    assert.equal(path, '/api/packs');
    return LIST;
  } });
  renderPacks(ctx);
  await flush();
  assert.match(ctx.main.textContent, /Word packs/);
  assert.match(ctx.main.textContent, /Sample pack/);
  assert.match(ctx.main.textContent, /DEVPACK2/);
  assert.match(ctx.main.textContent, /12 words · 1 question/);
  assert.match(ctx.main.textContent, /1 of 10/);
  assert.equal(buttons(ctx.main, /Copy code/).length, 1);
  ctx.abort();
});

test('the editor counts words, adds trivia rows and saves the pack', async () => {
  const sent = [];
  const ctx = makeCtx({
    get: async () => ({ ...LIST, packs: [] }),
    post: async (path, body) => {
      sent.push([path, body]);
      return { pack: { code: 'ABCD2345', name: body.name } };
    },
  });
  renderPacks(ctx);
  await flush();
  buttons(ctx.main, /New pack/)[0].click();
  await flush();
  const name = ctx.main.querySelector('input');
  type(name, 'Space night');
  const area = ctx.main.querySelector('textarea');
  type(area, 'rocket\nplanet, rocket\nmoon');
  assert.match(ctx.main.textContent, /3 of 500/);
  buttons(ctx.main, /Add question/)[0].click();
  const row = ctx.main.querySelector('.trivia-row');
  const inputs = row.querySelectorAll('input');
  ['Closest star?', 'The Sun', 'Sirius', 'Vega', 'Polaris'].forEach((v, i) => type(inputs[i], v));
  assert.match(ctx.main.textContent, /1 of 200/);
  fire(ctx.main.querySelector('form'), 'submit');
  await flush();
  assert.deepEqual(sent, [['/api/packs', { name: 'Space night', words: ['rocket', 'planet', 'moon'], trivia: [{ q: 'Closest star?', a: 'The Sun', w: ['Sirius', 'Vega', 'Polaris'] }] }]]);
  ctx.abort();
});

test('the editor explains a half-filled question before saving', async () => {
  let posted = 0;
  const ctx = makeCtx({ get: async () => LIST, post: async () => { posted += 1; return {}; } });
  renderPacks(ctx);
  await flush();
  buttons(ctx.main, /New pack/)[0].click();
  await flush();
  type(ctx.main.querySelector('input'), 'Half');
  buttons(ctx.main, /Add question/)[0].click();
  type(ctx.main.querySelector('.trivia-row').querySelector('input'), 'Only a question');
  fire(ctx.main.querySelector('form'), 'submit');
  await flush();
  assert.equal(posted, 0);
  assert.match(ctx.main.textContent, /Question 1 needs a question, a right answer and three wrong answers/);
  ctx.abort();
});

test('sending many new packs together still stops at ten', async () => {
  const { h, cookie } = await signedIn();
  const all = await Promise.all(Array.from({ length: MAX_PACKS + 5 }, (_, i) => h.api('POST', '/api/packs', cookie, pack({ name: `Pack ${i}` }))));
  assert.equal(all.filter((r) => r.status === 201).length <= MAX_PACKS, true);
  const n = h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_packs WHERE owner_id = ?').get(ALICE.id).n;
  assert.ok(n <= MAX_PACKS);
});
