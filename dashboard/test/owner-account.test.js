import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness as createWorkerHarness, USERS } from './helpers.js';
import { createHarness as createBotHarness } from '../../test/harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GLOBAL_KEY } from '../../engine/global.js';
import { NOT_REAL, STILL_CHECKING } from '../worker/owner-account.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const REAL = '88888888-8888-4888-8888-000000000001';
const FAKE = '88888888-8888-4888-8888-00000000dead';
const UNSEEN = '88888888-8888-4888-8888-000000000002';

async function worker() {
  const h = createWorkerHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  await h.bot('POST', '/bot/owner/catalog', { achievements: [], badges: [{ id: 'einstein', label: 'Einstein', emoji: '🧠' }] });
  return { h, owner };
}

function knownProfile(h, id, { missing = 0, username = 'juno', name = 'Juno', avatar = 'https://files.yapper.website/j.png' } = {}) {
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, missing ? null : username, missing ? null : name, missing ? null : avatar, missing, h.clock.t);
}

async function give(h, cookie, body) {
  const res = await h.api('POST', '/api/owner/actions', cookie, body);
  return { status: res.status, body: await res.json() };
}

async function detail(h, cookie, id) {
  return (await (await h.api('GET', `/api/owner/users/${id}`, cookie)).json()).user;
}

const actionCount = (h) => h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n;

test('an id Yapin says has no account is refused before anything is queued', async () => {
  const { h, owner } = await worker();
  knownProfile(h, FAKE, { missing: 1 });
  for (const body of [
    { user: FAKE, kind: 'shards.add', value: 50000 },
    { user: FAKE, kind: 'xp.add', value: 10 },
    { user: FAKE, kind: 'badge.grant', id: 'einstein' },
    { user: FAKE, kind: 'party.points.set', value: 5 },
  ]) {
    const r = await give(h, owner, body);
    assert.equal(r.status, 400, body.kind);
    assert.equal(r.body.error, 'not_a_user');
    assert.equal(r.body.message, NOT_REAL);
  }
  assert.equal(NOT_REAL, "That isn't a real Yapin' account. Check the id.");
  assert.equal(actionCount(h), 0);
  assert.equal((await h.poll()).owner.length, 0);
  const u = await detail(h, owner, FAKE);
  assert.equal(u.account, 'fake');
  const search = await (await h.api('GET', `/api/owner/users?q=${FAKE}`, owner)).json();
  assert.equal(search.users[0].account, 'fake');
});

test('a fake id can still be hidden from the global leaderboard so it can be cleaned up', async () => {
  const { h, owner } = await worker();
  knownProfile(h, FAKE, { missing: 1 });
  const r = await give(h, owner, { user: FAKE, kind: 'global.hide' });
  assert.equal(r.status, 201);
  assert.equal(r.body.action.status, 'done');
});

test('real accounts work and the owner sees their name and avatar first', async () => {
  const { h, owner } = await worker();
  knownProfile(h, REAL);
  const u = await detail(h, owner, REAL);
  assert.equal(u.account, 'real');
  assert.equal(u.name, 'Juno');
  assert.equal(u.username, 'juno');
  assert.equal(u.avatar, 'https://files.yapper.website/j.png');
  const r = await give(h, owner, { user: REAL, kind: 'shards.add', value: 50 });
  assert.equal(r.status, 201);
  assert.equal(r.body.action.status, 'queued');
  const party = await give(h, owner, { user: REAL, kind: 'party.points.set', value: 5 });
  assert.equal(party.status, 201);
  await h.login(BOB);
  assert.equal((await detail(h, owner, BOB.id)).account, 'real', 'signing in proves the account');
  assert.equal((await give(h, owner, { user: BOB.id, kind: 'party.points.set', value: 5 })).status, 201);
});

test('an id nobody has checked yet is sent to YapOS to check, and instant edits wait for it', async () => {
  const { h, owner } = await worker();
  const u = await detail(h, owner, UNSEEN);
  assert.equal(u.account, 'checking');
  assert.ok(h.db.raw.prepare('SELECT 1 FROM profile_wanted WHERE id = ?').get(UNSEEN));
  const party = await give(h, owner, { user: UNSEEN, kind: 'party.points.set', value: 5 });
  assert.equal(party.status, 409);
  assert.equal(party.body.message, STILL_CHECKING);
  const queued = await give(h, owner, { user: UNSEEN, kind: 'shards.add', value: 5 });
  assert.equal(queued.status, 201);
  assert.equal(queued.body.action.status, 'queued');
  const polled = await h.poll();
  assert.ok(polled.wanted.includes(UNSEEN));
  assert.equal(polled.owner[0].user, UNSEEN);
});

test('when YapOS reports no account the action fails clearly and the id is remembered as fake', async () => {
  const { h, owner } = await worker();
  const queued = await give(h, owner, { user: UNSEEN, kind: 'shards.add', value: 5 });
  const { owner: rows } = await h.poll();
  assert.equal(rows[0].id, queued.body.action.id);
  const res = await h.bot('POST', '/bot/owner/results', { results: [{ id: rows[0].id, ok: false, noAccount: true, message: "No Yapin' account has this id, so nothing was changed. Check the id." }] });
  assert.equal(res.status, 200);
  const row = h.db.raw.prepare('SELECT status, result FROM owner_actions WHERE id = ?').get(rows[0].id);
  assert.equal(row.status, 'failed');
  assert.match(row.result, /^No Yapin' account has this id/);
  assert.equal((await detail(h, owner, UNSEEN)).account, 'fake');
  assert.equal((await give(h, owner, { user: UNSEEN, kind: 'shards.add', value: 5 })).status, 400);
});

test('end to end: the real bot refuses a made-up id and makes no wallet, and checks a real one', async () => {
  const w = createWorkerHarness({ PARTY_OWNER_ID: OWNER.id });
  const cookie = (await w.login(OWNER)).cookie;
  const b = await createBotHarness({ apps: ['levels', 'economy', 'quests', 'achievements'], fakeClock: true });
  const lookup = b.engine.bot.user.bind(b.engine.bot);
  b.engine.bot.user = async (id) => (id === REAL ? { id: REAL, username: 'juno', display_name: 'Juno', avatar_path: null } : lookup(id));
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('CF-Connecting-IP', '203.0.113.9');
    return w.worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), w.env, { waitUntil() {} });
  };
  const bot = createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  await w.bot('POST', '/bot/owner/catalog', bot.ownerCatalog());

  const fake = await w.api('POST', '/api/owner/actions', cookie, { user: FAKE, kind: 'shards.add', value: 50000 });
  assert.equal(fake.status, 201);
  const { owner } = await w.poll();
  await bot.syncOwner(owner);
  const act = (await (await w.api('GET', `/api/owner/users/${FAKE}`, cookie)).json());
  assert.equal(act.actions[0].status, 'failed');
  assert.match(act.actions[0].result, /^No Yapin' account has this id/);
  assert.equal(act.user.account, 'fake');
  assert.equal(b.engine.service('economy').balance(GLOBAL_KEY, FAKE), 0);
  assert.equal(FAKE in (b.engine.store.get('economy', GLOBAL_KEY, {}).users || {}), false);
  assert.equal((await w.api('POST', '/api/owner/actions', cookie, { user: FAKE, kind: 'shards.add', value: 5 })).status, 400);

  assert.equal((await (await w.api('GET', `/api/owner/users/${REAL}`, cookie)).json()).user.account, 'checking');
  const polled = await w.poll();
  assert.ok(polled.wanted.includes(REAL));
  await bot.lookupProfiles(polled.wanted);
  const seen = (await (await w.api('GET', `/api/owner/users/${REAL}`, cookie)).json()).user;
  assert.equal(seen.account, 'real');
  assert.equal(seen.name, 'Juno');
  const ok = await w.api('POST', '/api/owner/actions', cookie, { user: REAL, kind: 'shards.add', value: 40 });
  assert.equal(ok.status, 201);
  await bot.syncOwner((await w.poll()).owner);
  assert.equal(b.engine.service('economy').balance(GLOBAL_KEY, REAL), 40);
});
