import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { BROWSE_PAGE } from '../worker/pack-browse.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const CAROL = { id: '99999999-9999-4999-8999-999999999999', username: 'carol', display_name: 'Carol', avatar_url: null };

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  const alice = (await h.login(ALICE)).cookie;
  const bob = (await h.login(BOB)).cookie;
  const carol = (await h.login(CAROL)).cookie;
  return { h, alice, bob, carol };
}

async function make(h, cookie, name, extra = {}) {
  const res = await h.api('POST', '/api/packs', cookie, { name, words: ['rocket', 'planet', 'comet'], ...extra });
  assert.equal(res.status, 201, name);
  return (await res.json()).pack;
}

function browse(h, query = '', cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  return h.request('GET', `/api/packs/browse${query}`, { headers, ip: '203.0.113.80' });
}

test('only public packs show in the browser, newest or most liked first', async () => {
  const { h, alice, bob, carol } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  assert.equal(space.public, true);
  assert.equal(space.likes, 0);
  advance(h, 1000);
  const food = await make(h, bob, 'Food fight');
  assert.equal(food.public, false);
  advance(h, 1000);
  const ocean = await make(h, carol, 'Ocean deep');
  const pub = await h.api('PUT', `/api/packs/${ocean.code}/public`, carol, { public: true });
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).pack.public, true);
  const anon = await browse(h, '?sort=new');
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('Cache-Control'), 'public, max-age=30');
  const listNew = await anon.json();
  assert.deepEqual(listNew.packs.map((p) => p.code), [ocean.code, space.code]);
  assert.deepEqual(Object.keys(listNew.packs[0]).sort(), ['by', 'code', 'likes', 'name', 'published', 'triviaCount', 'updated', 'wordCount']);
  assert.equal(listNew.packs[0].wordCount, 3);
  assert.deepEqual(listNew.liked, []);
  const like = await h.api('POST', `/api/packs/${space.code}/like`, alice);
  assert.deepEqual(await like.json(), { ok: true, code: space.code, liked: true, likes: 1 });
  const top = await (await browse(h, '?sort=top', alice)).json();
  assert.deepEqual(top.packs.map((p) => p.code), [space.code, ocean.code]);
  assert.equal(top.packs[0].likes, 1);
  assert.deepEqual(top.liked, [space.code]);
  const unlike = await h.api('POST', `/api/packs/${space.code}/like`, alice);
  assert.deepEqual(await unlike.json(), { ok: true, code: space.code, liked: false, likes: 0 });
  const notPublic = await h.api('POST', `/api/packs/${food.code}/like`, alice);
  assert.equal(notPublic.status, 409);
  const search = await (await browse(h, '?q=OCEAN')).json();
  assert.deepEqual(search.packs.map((p) => p.code), [ocean.code]);
  const sneaky = await (await browse(h, '?q=%25')).json();
  assert.deepEqual(sneaky.packs, []);
});

test('the browse query is checked and pages through results', async () => {
  const { h } = await setup();
  assert.equal((await browse(h, '?sort=hot')).status, 400);
  assert.equal((await browse(h, '?page=0')).status, 400);
  assert.equal((await browse(h, '?page=99')).status, 400);
  const t = h.clock.t;
  const ins = h.db.raw.prepare("INSERT INTO party_packs (code, owner_id, name, words, trivia, created, updated) VALUES (?, ?, ?, '[\"moon\"]', '[]', ?, ?)");
  const pub = h.db.raw.prepare('INSERT INTO pack_public (code, public, blocked, published, updated) VALUES (?, 1, 0, ?, ?)');
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < BROWSE_PAGE + 3; i += 1) {
    const code = `PACK${letters[Math.floor(i / 32)]}${letters[i % 32]}AA`;
    ins.run(code, CAROL.id, `Pack ${i}`, t, t);
    pub.run(code, t + i, t);
  }
  const one = await (await browse(h, '?sort=new')).json();
  assert.equal(one.packs.length, BROWSE_PAGE);
  assert.equal(one.more, true);
  const two = await (await browse(h, '?sort=new&page=2')).json();
  assert.equal(two.packs.length, 3);
  assert.equal(two.more, false);
});

test('likes and reports need a signed-in user and the safety header', async () => {
  const { h, bob, alice } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  assert.equal((await h.api('POST', `/api/packs/${space.code}/like`, null)).status, 401);
  assert.equal((await h.api('POST', `/api/packs/${space.code}/like`, alice, undefined, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('GET', `/api/packs/${space.code}/like`, alice)).status, 405);
  assert.equal((await h.api('POST', '/api/packs/ZZZZZZZZ/like', alice)).status, 404);
  assert.equal((await h.api('POST', `/api/packs/${space.code}/report`, bob, { reason: 'mine' })).status, 400);
});

test('a reported pack shows up for the party team, who can hide it from the browser', async () => {
  const { h, alice, bob, carol } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  const report = await h.api('POST', `/api/packs/${space.code}/report`, carol, { reason: '  Rude words in   the list ' });
  assert.equal(report.status, 201);
  assert.deepEqual(await report.json(), { ok: true, reported: true });
  const again = await h.api('POST', `/api/packs/${space.code}/report`, carol, { reason: 'again' });
  assert.deepEqual(await again.json(), { ok: true, reported: false, already: true });
  assert.equal((await h.api('POST', `/api/packs/${space.code}/report`, carol, { nope: 1 })).status, 400);
  assert.equal((await h.api('GET', '/api/party/pack-reports', carol)).status, 403);
  const list = await (await h.api('GET', '/api/party/pack-reports', alice)).json();
  assert.equal(list.open, 1);
  assert.equal(list.role, 'owner');
  const r = list.reports[0];
  assert.equal(r.reason, 'Rude words in the list');
  assert.equal(r.reporter.id, CAROL.id);
  assert.equal(r.pack.code, space.code);
  assert.equal(r.pack.public, true);
  assert.deepEqual(r.pack.words, ['rocket', 'planet', 'comet']);
  const hide = await h.api('POST', `/api/party/pack-reports/${r.id}/hide`, alice);
  assert.deepEqual(await hide.json(), { ok: true, hidden: true, code: space.code });
  assert.deepEqual((await (await browse(h)).json()).packs, []);
  const after = await (await h.api('GET', '/api/party/pack-reports', alice)).json();
  assert.equal(after.open, 0);
  const mine = await (await h.api('GET', `/api/packs/${space.code}`, bob)).json();
  assert.equal(mine.pack.blocked, true);
  const republish = await h.api('PUT', `/api/packs/${space.code}/public`, bob, { public: true });
  assert.equal(republish.status, 403);
  assert.equal((await republish.json()).error, 'blocked');
  const played = await h.request('GET', `/api/activity/pack/${space.code}`);
  assert.equal(played.status, 200, 'a hidden pack still works by code');
  const restore = await h.api('POST', `/api/party/pack-reports/${r.id}/restore`, alice);
  assert.equal(restore.status, 200);
  assert.equal((await (await browse(h)).json()).packs.length, 1);
  const all = await (await h.api('GET', '/api/party/pack-reports?status=all', alice)).json();
  assert.equal(all.reports.length, 1);
  assert.equal((await h.api('GET', '/api/party/pack-reports?status=weird', alice)).status, 400);
  assert.equal((await h.api('POST', '/api/party/pack-reports/nope/dismiss', alice)).status, 404);
});

test('a report can be dismissed and deleting a pack clears its likes and reports', async () => {
  const { h, alice, bob, carol } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  await h.api('POST', `/api/packs/${space.code}/like`, carol);
  await h.api('POST', `/api/packs/${space.code}/report`, carol, {});
  const list = await (await h.api('GET', '/api/party/pack-reports', alice)).json();
  const dismissed = await h.api('POST', `/api/party/pack-reports/${list.reports[0].id}/dismiss`, alice);
  assert.deepEqual(await dismissed.json(), { ok: true, dismissed: true });
  assert.equal((await h.api('DELETE', `/api/packs/${space.code}`, bob)).status, 200);
  for (const table of ['pack_public', 'pack_likes', 'pack_reports']) {
    assert.equal(h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test('the owner list shows the public flag and like count', async () => {
  const { h, bob, carol } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  await h.api('POST', `/api/packs/${space.code}/like`, carol);
  const list = await (await h.api('GET', '/api/packs', bob)).json();
  assert.equal(list.packs[0].public, true);
  assert.equal(list.packs[0].likes, 1);
  const off = await h.api('PUT', `/api/packs/${space.code}`, bob, { name: 'Space night', words: ['rocket'], public: false });
  assert.equal((await off.json()).pack.public, false);
  assert.equal((await h.api('PUT', `/api/packs/${space.code}/public`, bob, { public: 'yes' })).status, 400);
  assert.equal((await h.api('PUT', `/api/packs/${space.code}/public`, carol, { public: true })).status, 404);
  assert.equal((await h.api('POST', '/api/packs', bob, { name: 'X', words: ['moon'], public: 1 })).status, 400);
});

test('the pack browser page is served by the SPA', async () => {
  const { h } = await setup();
  assert.equal((await h.request('GET', '/packs/browse')).status, 200);
});

test('owners cannot like their own pack and one person can only keep so many reports open', async () => {
  const { h, alice, bob } = await setup();
  const space = await make(h, bob, 'Space night', { public: true });
  const own = await h.api('POST', `/api/packs/${space.code}/like`, bob);
  assert.equal(own.status, 400);
  const now = h.clock.t;
  for (let i = 0; i < 20; i += 1) {
    h.db.raw.prepare("INSERT INTO pack_reports (id, code, reporter_id, reporter_name, reason, created, status) VALUES (?, ?, ?, 'A', NULL, ?, 'open')").run(`seed${i}`, `CODE${i}`, ALICE.id.toLowerCase(), now);
  }
  const more = await h.api('POST', `/api/packs/${space.code}/report`, alice, { reason: 'spam' });
  assert.equal(more.status, 429);
});
