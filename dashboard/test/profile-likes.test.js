import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { cleanup } from '../worker/cron.js';
import { buildCard } from '../worker/party-profile.js';
import { LIKE_LIMITS, LIKE_BATCH_WINDOW, LIKE_PING_COOLDOWN, likeTitle, likeCount } from '../worker/profile-likes.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const CAROL = { id: '55555555-5555-4555-8555-555555555555', username: 'carol', display_name: 'Carol', avatar_url: 'https://files.yapper.website/c.png' };
const DAVE = { id: '55555555-5555-4555-8555-000000000004', username: 'dave', display_name: 'Dave', avatar_url: 'https://files.yapper.website/d.png' };
const MIN = 60 * 1000;

function seedPublic(h, user, { hidden = 0, name = user.display_name } = {}) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 5, 400, NULL, '[]', '[]', '[]', NULL, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hidden = excluded.hidden")
    .run(user.id.toLowerCase(), user.username, user.username.toLowerCase(), name, hidden, h.clock.t);
}

async function setup() {
  const h = createHarness();
  for (const u of [ALICE, BOB, CAROL, DAVE]) seedPublic(h, u);
  const cookies = {};
  for (const [k, u] of Object.entries({ alice: ALICE, bob: BOB, carol: CAROL, dave: DAVE })) cookies[k] = (await h.login(u)).cookie;
  return { h, ...cookies };
}

async function like(h, cookie, name, liked = true, extra = {}) {
  const res = await h.api('POST', `/api/likes/${name}`, cookie, { liked }, extra);
  return { status: res.status, body: await res.json() };
}

async function state(h, cookie, name) {
  const res = await h.api('GET', `/api/likes/${name}`, cookie);
  return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
}

const notes = (h, user) => h.db.raw.prepare("SELECT id, title, data, read_at, created FROM notifications WHERE user_id = ? AND kind = 'profile_like' ORDER BY created DESC").all(user.id.toLowerCase());

test('signed out people see the count but cannot like', async () => {
  const { h, bob } = await setup();
  await like(h, bob, 'alice');
  const seen = await state(h, null, 'alice');
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body, { count: 1, liked: false, own: false, signedIn: false, canLike: false });
  assert.match(seen.cache, /no-store/);
  const res = await like(h, null, 'alice');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'signed_out');
});

test('writes need the CSRF headers', async () => {
  const { h, bob } = await setup();
  const noOrigin = await like(h, bob, 'alice', true, { Origin: null });
  assert.equal(noOrigin.status, 403);
  const noHeader = await like(h, bob, 'alice', true, { 'X-YapOS': null });
  assert.equal(noHeader.status, 403);
  const evil = await like(h, bob, 'alice', true, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(await likeCount(h.db, ALICE.id, h.clock.t), 0);
});

test('like, duplicate like and unlike', async () => {
  const { h, bob } = await setup();
  const first = await like(h, bob, 'alice');
  assert.equal(first.status, 200);
  assert.equal(first.body.liked, true);
  assert.equal(first.body.count, 1);
  const again = await like(h, bob, 'Alice');
  assert.equal(again.body.count, 1);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_likes').get().n, 1);
  assert.equal((await state(h, bob, '@alice')).body.liked, true);
  const off = await like(h, bob, 'alice', false);
  assert.equal(off.body.liked, false);
  assert.equal(off.body.count, 0);
  const offAgain = await like(h, bob, 'alice', false);
  assert.equal(offAgain.status, 200);
  assert.equal(offAgain.body.count, 0);
});

test('you cannot like your own profile', async () => {
  const { h, alice } = await setup();
  const res = await like(h, alice, 'alice');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'is_self');
  const mine = await state(h, alice, 'alice');
  assert.equal(mine.body.own, true);
  assert.equal(mine.body.canLike, false);
});

test('private, hidden and missing profiles cannot be liked and show no count', async () => {
  const { h, bob, carol } = await setup();
  await like(h, carol, 'alice');
  seedPublic(h, ALICE, { hidden: 1 });
  assert.equal((await like(h, bob, 'alice')).status, 404);
  assert.equal((await state(h, bob, 'alice')).status, 404);
  seedPublic(h, ALICE, { hidden: 0 });
  h.db.raw.prepare('INSERT INTO profile_settings (user_id, hidden, show_shards, updated, given, claimed) VALUES (?, 1, 0, ?, 0, 0)').run(ALICE.id.toLowerCase(), h.clock.t + 1);
  assert.equal((await state(h, bob, 'alice')).status, 404);
  assert.equal((await like(h, bob, 'nobody-here')).status, 404);
  assert.equal((await like(h, bob, 'bad/name')).status, 404);
  assert.equal((await state(h, null, 'nobody-here')).status, 404);
});

test('bad bodies are refused', async () => {
  const { h, bob } = await setup();
  const res = await h.api('POST', '/api/likes/alice', bob, { liked: 'yes' });
  assert.equal(res.status, 400);
  const extra = await h.api('POST', '/api/likes/alice', bob, { liked: true, x: 1 });
  assert.equal(extra.status, 400);
  const put = await h.api('PUT', '/api/likes/alice', bob, { liked: true });
  assert.equal(put.status, 405);
});

test('toggles are rate limited per person', async () => {
  const { h, bob } = await setup();
  let last = null;
  for (let i = 0; i <= LIKE_LIMITS.user; i++) last = await like(h, bob, 'alice', i % 2 === 0);
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
  advance(h, MIN);
  assert.equal((await like(h, bob, 'alice')).status, 200);
});

test('likes from Party-banned accounts do not count and do not notify', async () => {
  const { h, bob, carol } = await setup();
  h.db.raw.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?, ?)').run(BOB.id.toLowerCase(), 'Bob', 'bob', 'spam', ALICE.id, h.clock.t);
  const res = await like(h, bob, 'alice');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.equal(notes(h, ALICE).length, 0);
  await like(h, carol, 'alice');
  assert.equal((await state(h, null, 'alice')).body.count, 1);
  h.db.raw.prepare('DELETE FROM party_bans').run();
  assert.equal((await state(h, null, 'alice')).body.count, 2);
});

test('likes batch into one unread note and unlikes never notify', async () => {
  const { h, bob, carol, dave } = await setup();
  await like(h, bob, 'alice');
  let list = notes(h, ALICE);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Bob liked your profile');
  advance(h, MIN);
  await like(h, carol, 'alice');
  advance(h, MIN);
  await like(h, dave, 'alice');
  list = notes(h, ALICE);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Dave and 2 others liked your profile');
  const data = JSON.parse(list[0].data);
  assert.equal(data.count, 3);
  assert.equal(data.person, DAVE.id.toLowerCase());
  assert.equal(data.link, '/u/alice');
  await like(h, carol, 'alice', false);
  assert.equal(notes(h, ALICE).length, 1);
  assert.equal(notes(h, ALICE)[0].title, 'Dave and 2 others liked your profile');
  const inbox = await (await h.api('GET', '/api/me/inbox', (await h.login(ALICE)).cookie)).json();
  const item = inbox.items.find((x) => x.kind === 'profile_like');
  assert.equal(item.link, '/u/alice');
  assert.equal(item.person.id, DAVE.id.toLowerCase());
});

test('a read note starts a new one, and re-liking within the cooldown does not re-notify', async () => {
  const { h, bob, carol } = await setup();
  await like(h, bob, 'alice');
  h.db.raw.prepare('UPDATE notifications SET read_at = ?').run(h.clock.t);
  advance(h, MIN);
  await like(h, bob, 'alice', false);
  const back = await like(h, bob, 'alice');
  assert.equal(back.body.notified, false);
  assert.equal(notes(h, ALICE).length, 1);
  await like(h, carol, 'alice');
  const list = notes(h, ALICE);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Carol liked your profile');
  advance(h, LIKE_PING_COOLDOWN + MIN);
  await like(h, bob, 'alice', false);
  const later = await like(h, bob, 'alice');
  assert.equal(later.body.notified, true);
  assert.equal(notes(h, ALICE).length, 3);
});

test('the batch window closes after a while', async () => {
  const { h, bob, carol } = await setup();
  await like(h, bob, 'alice');
  advance(h, LIKE_BATCH_WINDOW + MIN);
  await like(h, carol, 'alice');
  assert.equal(notes(h, ALICE).length, 2);
});

test('a private liker is named Someone in the note', async () => {
  const { h, bob } = await setup();
  seedPublic(h, BOB, { hidden: 1 });
  await like(h, bob, 'alice');
  const [n] = notes(h, ALICE);
  assert.equal(n.title, 'Someone liked your profile');
  assert.equal(JSON.parse(n.data).person, undefined);
  assert.equal(likeTitle('Sam', 5), 'Sam and 4 others liked your profile');
  assert.equal(likeTitle('Sam', 2), 'Sam and 1 other liked your profile');
});

test('liked by list is newest first, paged, and hides private likers', async () => {
  const { h, alice, bob, carol, dave } = await setup();
  await like(h, bob, 'alice');
  advance(h, 1000);
  await like(h, carol, 'alice');
  advance(h, 1000);
  await like(h, dave, 'alice');
  seedPublic(h, CAROL, { hidden: 1 });
  const first = await (await h.api('GET', '/api/me/likes?limit=2', alice)).json();
  assert.equal(first.count, 3);
  assert.equal(first.more, true);
  assert.deepEqual(first.people.map((p) => p.name), ['Dave', 'Private profile']);
  assert.equal(first.people[0].username, 'dave');
  assert.equal(first.people[1].private, true);
  assert.equal(first.people[1].username, null);
  assert.equal(first.people[1].avatar, null);
  const second = await (await h.api('GET', `/api/me/likes?limit=2&before=${encodeURIComponent(first.next)}`, alice)).json();
  assert.deepEqual(second.people.map((p) => p.name), ['Bob']);
  assert.equal(second.more, false);
  assert.equal((await h.api('GET', '/api/me/likes', null)).status, 401);
});

test('the Party card carries the like count', async () => {
  const { h, bob, carol } = await setup();
  await like(h, bob, 'alice');
  await like(h, carol, 'alice');
  const card = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(card.likes, 2);
  seedPublic(h, ALICE, { hidden: 1 });
  const hidden = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(hidden.likes, undefined);
});

test('cleanup drops likes pointing at gone profiles and deleted accounts', async () => {
  const { h, bob, carol } = await setup();
  await like(h, bob, 'alice');
  await like(h, carol, 'alice');
  await like(h, carol, 'bob');
  h.db.raw.prepare('DELETE FROM public_profiles WHERE user_id = ?').run(BOB.id.toLowerCase());
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 1, ?) ON CONFLICT (id) DO UPDATE SET missing = 1').run(CAROL.id, h.clock.t);
  assert.equal(await likeCount(h.db, ALICE.id, h.clock.t), 1);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.profileLikes, 2);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_likes').get().n, 1);
  advance(h, LIKE_PING_COOLDOWN + MIN);
  const later = await cleanup(h.db, h.clock.t);
  assert.ok(later.profileLikePings >= 1);
});

test('the owner path that finds a deleted account removes its likes', async () => {
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  for (const u of [ALICE, BOB, CAROL]) seedPublic(h, u);
  const bob = (await h.login(BOB)).cookie;
  await like(h, bob, 'carol');
  h.db.raw.prepare("INSERT INTO owner_actions (id, user_id, kind, value, ref, created, status, updated) VALUES ('act-1', ?, 'shards.give', '5', NULL, ?, 'sent', ?)").run(BOB.id.toLowerCase(), h.clock.t, h.clock.t);
  const res = await h.bot('POST', '/bot/owner/results', { results: [{ id: 'act-1', ok: false, noAccount: true, message: 'No account' }] });
  assert.equal(res.status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_likes').get().n, 0);
});
