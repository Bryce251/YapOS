import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { OWNER_KINDS } from '../worker/owner.js';
import { withoutHidden } from '../worker/owner-global.js';
import { devGlobalBoard, seedGlobalBoard, DEV_FAKE_ACCOUNT } from '../dev.mjs';
import { D1Database } from './d1-shim.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const FAKE = '66666666-6666-4666-8666-000000000001';
const REAL = '66666666-6666-4666-8666-000000000002';
const QUIET = '66666666-6666-4666-8666-000000000003';
let ipSeq = 0;

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  const bob = (await h.login(BOB)).cookie;
  const board = {
    levels: [
      { rank: 1, id: REAL, name: 'Tearyu', level: 30, xp: 30000 },
      { rank: 2, id: FAKE, name: 'mwa', level: 1, xp: 50 },
      { rank: 3, id: QUIET, name: 'bunny', level: 1, xp: 10 },
    ],
    economy: [
      { rank: 1, id: REAL, name: 'Tearyu', balance: 74633 },
      { rank: 2, id: FAKE, name: 'mwa', balance: 50000 },
      { rank: 3, id: QUIET, name: 'bunny', balance: 25205 },
    ],
    updatedAt: h.clock.t,
  };
  assert.equal((await h.bot('PUT', '/bot/global', board)).status, 200);
  const pub = h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 1, 0, NULL, '[]', '[]', '[]', NULL, ?, ?)");
  pub.run(REAL, 'Tearyu', 'tearyu', 'Tearyu', 0, h.clock.t);
  pub.run(QUIET, 'bunny', 'bunny', 'bunny', 1, h.clock.t);
  return { h, owner, bob };
}

async function board(h) {
  ipSeq += 1;
  const res = await h.request('GET', '/api/public/global', { ip: `198.51.100.${(ipSeq % 200) + 1}` });
  assert.equal(res.status, 200);
  return res.json();
}

async function give(h, cookie, body, headers) {
  const res = await h.api('POST', '/api/owner/actions', cookie, body, headers);
  return { status: res.status, body: await res.json() };
}

test('board rows carry a profile handle only when the profile is public', async () => {
  const { h } = await setup();
  const data = await board(h);
  const byId = Object.fromEntries(data.economy.map((r) => [r.id, r]));
  assert.equal(byId[REAL].handle, 'Tearyu');
  assert.equal(byId[FAKE].handle, undefined);
  assert.equal(byId[QUIET].handle, undefined, 'a private profile gets no link');
  h.db.raw.prepare('INSERT INTO profile_settings (user_id, hidden, show_shards, updated, given, claimed) VALUES (?, 1, 0, ?, 0, 0)').run(REAL, h.clock.t + 1);
  assert.equal((await board(h)).levels[0].handle, undefined, 'hiding the profile in settings removes the link straight away');
});

test('the owner can hide a fake account from the global board and show it again', async () => {
  const { h, owner } = await setup();
  assert.equal(OWNER_KINDS['global.hide'].instant, true);
  const r = await give(h, owner, { user: FAKE, kind: 'global.hide' });
  assert.equal(r.status, 201);
  assert.equal(r.body.action.status, 'done');
  assert.match(r.body.action.result, /Hid them from the global leaderboard/);
  const data = await board(h);
  assert.deepEqual(data.economy.map((x) => [x.rank, x.name]), [[1, 'Tearyu'], [2, 'bunny']]);
  assert.deepEqual(data.levels.map((x) => [x.rank, x.name]), [[1, 'Tearyu'], [2, 'bunny']]);
  assert.deepEqual((await h.poll()).owner, [], 'hiding never waits for the bot');
  const log = h.db.raw.prepare('SELECT actor_id, action, target_id FROM party_mod_log').all();
  assert.deepEqual(log.map((x) => [x.actor_id, x.action, x.target_id]), [[OWNER.id, 'owner_global_hide', FAKE]]);
  const detail = (await (await h.api('GET', `/api/owner/users/${FAKE}`, owner)).json()).user;
  assert.equal(detail.globalHidden, true);
  const again = await give(h, owner, { user: FAKE, kind: 'global.hide' });
  assert.match(again.body.action.result, /already hidden/);
  const back = await give(h, owner, { user: FAKE, kind: 'global.show' });
  assert.equal(back.body.action.status, 'done');
  assert.equal((await board(h)).economy[1].name, 'mwa');
  assert.equal((await (await h.api('GET', `/api/owner/users/${FAKE}`, owner)).json()).user.globalHidden, false);
});

test('setting Shards to 0 from the board is queued for the bot with the exact body', async () => {
  const { h, owner } = await setup();
  const r = await give(h, owner, { user: FAKE, kind: 'shards.set', value: 0 });
  assert.equal(r.status, 201);
  assert.equal(r.body.action.status, 'queued');
  const sent = (await h.poll()).owner;
  assert.deepEqual(sent.map((a) => [a.user, a.kind, a.value]), [[FAKE, 'shards.set', 0]]);
  assert.equal((await h.bot('POST', '/bot/owner/results', { results: [{ id: sent[0].id, ok: true, message: 'Set their wallet to 0.', after: { shards: 0 } }] })).status, 200);
  const detail = (await (await h.api('GET', `/api/owner/users/${FAKE}`, owner)).json());
  assert.equal(detail.user.shards, 0);
  assert.equal(detail.actions[0].status, 'done');
});

test('non-owners, party admins, missing CSRF headers and other origins can never change Shards or hide people', async () => {
  const { h, owner, bob } = await setup();
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(BOB.id, OWNER.id, 1);
  for (const body of [
    { user: FAKE, kind: 'shards.set', value: 0 },
    { user: FAKE, kind: 'shards.remove', value: 100 },
    { user: FAKE, kind: 'xp.remove', value: 10 },
    { user: FAKE, kind: 'level.set', value: 0 },
    { user: FAKE, kind: 'global.hide' },
  ]) {
    assert.equal((await give(h, bob, body)).status, 404, `party admin ${body.kind}`);
    assert.equal((await give(h, null, body)).status, 404, `signed out ${body.kind}`);
  }
  assert.equal((await give(h, owner, { user: FAKE, kind: 'shards.set', value: 0 }, { 'X-YapOS': null })).status, 403);
  assert.equal((await give(h, owner, { user: FAKE, kind: 'global.hide' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('GET', `/api/owner/users/${FAKE}`, bob)).status, 404);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM global_board_hidden').get().n, 0);
  assert.deepEqual((await h.poll()).owner, []);
  assert.equal((await board(h)).economy.length, 3);
});

test('hidden rows are dropped and the ranks close up', () => {
  const rows = [{ rank: 1, id: 'A' }, { rank: 2, id: 'b' }, { rank: 3, id: 'c' }];
  assert.deepEqual(withoutHidden(rows, new Set(['a'])).map((r) => [r.rank, r.id]), [[1, 'b'], [2, 'c']]);
  assert.equal(withoutHidden(rows, new Set()), rows);
  assert.deepEqual(withoutHidden(null, new Set(['a'])), []);
});

test('the local dev board has a fake account to try the mod view on', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const db = new D1Database(':memory:');
  db.raw.exec(readFileSync(path.join(here, '..', 'schema.sql'), 'utf8'));
  seedGlobalBoard(db, 1000);
  const row = db.raw.prepare("SELECT data FROM global_board WHERE id = 'global'").get();
  const data = JSON.parse(row.data);
  assert.ok(data.levels.length >= 5);
  assert.equal(data.economy[0].id, DEV_FAKE_ACCOUNT.id);
  assert.equal(data.economy[0].balance, 50000);
  assert.deepEqual(devGlobalBoard(5).economy.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(db.raw.prepare('SELECT username FROM public_profiles WHERE user_id = ?').get(DEV_FAKE_ACCOUNT.id).username, 'mwa');
  db.close();
});
