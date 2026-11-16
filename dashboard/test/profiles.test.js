import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { MAX_SNAPSHOTS } from '../worker/public-profiles.js';
import { decodeTerm } from '../web/activity/js/filter.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const SLUR = decodeTerm('yogqkz');
const MIN = 60 * 1000;

function snap(over = {}) {
  return {
    id: ALICE.id,
    name: 'Alice',
    username: 'Alice',
    level: 12,
    xp: 3400,
    shards: null,
    badges: ['first-game', 'chatterbox'],
    achievements: ['messages-10k'],
    season: [{ month: '2026-09', rank: 3, kind: 'xp' }, { month: '2026-10', rank: 1, kind: 'shards' }],
    clan: { name: 'Night Owls', tag: 'OWL', colour: '#AA33FF' },
    hidden: false,
    ...over,
  };
}

function push(h, profiles) {
  return h.bot('POST', '/bot/profiles', { profiles });
}

function view(h, name, ip = '203.0.113.50') {
  return h.request('GET', `/api/u/${encodeURIComponent(name)}`, { ip });
}

test('the bot pushes a public profile and anyone can read it by username', async () => {
  const h = createHarness();
  const up = await push(h, [snap()]);
  assert.equal(up.status, 200);
  const out = await up.json();
  assert.equal(out.snapshots, 1);
  assert.equal(out.stored, 0);
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, ?, '{}', 0)").run(ALICE.id, JSON.stringify({ draw: { p: 7, w: 3 }, trivia: { p: 5, w: 1 } }));
  const res = await view(h, '@ALICE');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=30');
  const { profile, partyBadges } = await res.json();
  assert.equal(profile.name, 'Alice');
  assert.equal(profile.username, 'Alice');
  assert.equal(profile.level, 12);
  assert.equal(profile.xp, 3400);
  assert.equal(profile.shards, null);
  assert.deepEqual(profile.badges, ['first-game', 'games-10', 'chatterbox']);
  assert.deepEqual(profile.achievements, ['messages-10k']);
  assert.deepEqual(profile.season, [{ month: '2026-10', rank: 1, kind: 'shards' }, { month: '2026-09', rank: 3, kind: 'xp' }]);
  assert.deepEqual(profile.clan, { name: 'Night Owls', tag: 'OWL', colour: '#aa33ff' });
  assert.deepEqual(profile.party, { games: 12, wins: 4, favourites: [{ game: 'draw', played: 7, won: 3 }, { game: 'trivia', played: 5, won: 1 }] });
  assert.ok(Array.isArray(partyBadges) && partyBadges.length > 0);
  assert.equal('id' in profile, false, 'user ids are not shown');
  assert.equal(JSON.stringify(profile).includes(ALICE.id), false);
});

test('hidden and unknown profiles look the same: not found', async () => {
  const h = createHarness();
  await push(h, [snap({ hidden: true })]);
  for (const name of ['alice', 'nobody', 'a/b', 'x'.repeat(80)]) {
    const res = await view(h, name);
    assert.equal(res.status, 404, name);
    assert.equal((await res.json()).message, "This profile is private or doesn't exist.");
  }
});

test('Shards only show when the bot sends them and the user has not turned them off', async () => {
  const h = createHarness();
  await push(h, [snap({ shards: 4200 })]);
  assert.equal((await (await view(h, 'alice')).json()).profile.shards, 4200);
});

test('the bot input is cleaned: names go through the filter, junk is dropped, legacy rows still work', async () => {
  const h = createHarness();
  const res = await push(h, [
    snap({ name: `${SLUR} king`, clan: { name: `${SLUR}s`, tag: 'OK', colour: 'red' }, badges: ['ok', 'bad id!', 5, 'ok'], season: [{ month: '2026-13', rank: 1, kind: 'xp' }, { month: '2026-01', rank: 0, kind: 'xp' }, { month: '2026-02', rank: 2, kind: 'gold' }], level: 1e12, xp: -5 }),
    { id: 'bad id', level: 1, hidden: false },
    { id: BOB.id, username: 'bob', display_name: 'Bob', avatar_url: null },
    snap(),
  ]);
  const out = await res.json();
  assert.equal(out.snapshots, 1);
  assert.equal(out.snapshotsIgnored, 2);
  assert.equal(out.stored, 1);
  const row = h.db.raw.prepare('SELECT * FROM public_profiles WHERE user_id = ?').get(ALICE.id);
  assert.equal(row.name, 'Alice');
  h.db.raw.exec('DELETE FROM public_profiles');
  await push(h, [snap({ name: `${SLUR} king`, clan: { name: `${SLUR}s`, tag: 'OK' }, badges: ['ok', 'bad id!', 5, 'ok'], season: [{ month: '2026-13', rank: 1, kind: 'xp' }], level: 1e12, xp: -5 })]);
  const { profile } = await (await view(h, 'alice')).json();
  assert.equal(profile.name, 'Alice');
  assert.equal(profile.clan, null);
  assert.deepEqual(profile.badges, ['ok']);
  assert.deepEqual(profile.season, []);
  assert.equal(profile.level, 100000);
  assert.equal(profile.xp, 0);
  const cached = await (await h.request('GET', `/api/activity/profiles?ids=${BOB.id}`)).json();
  assert.equal(cached.profiles[0].username, 'bob');
});

test('big public profile uploads are allowed but capped at 50 per call', async () => {
  const h = createHarness();
  const id = (i) => `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`;
  const list = Array.from({ length: MAX_SNAPSHOTS }, (_, i) => snap({ id: id(i), username: `user${i}`, achievements: Array.from({ length: 100 }, (_, j) => `achievement-${j}`) }));
  assert.ok(JSON.stringify({ profiles: list }).length > 64 * 1024);
  const ok = await push(h, list);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).snapshots, MAX_SNAPSHOTS);
  const tooMany = await push(h, [...list, snap({ id: id(99) })]);
  assert.equal(tooMany.status, 413);
  assert.equal((await h.bot('POST', '/bot/profiles', { profiles: [snap()] }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
});

test('a signed-in user can hide their profile on the website and the bot is told', async () => {
  const h = createHarness();
  await push(h, [snap({ shards: 900 })]);
  assert.equal((await h.api('GET', '/api/me/profile-visibility', null)).status, 401);
  const { cookie } = await h.login(ALICE);
  const before = await (await h.api('GET', '/api/me/profile-visibility', cookie)).json();
  assert.deepEqual(before, { hidden: false, showShards: true, pending: false, username: 'Alice', exists: true });
  const blocked = await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: true }, { Origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  const set = await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: true, showShards: false });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { ok: true, hidden: true, showShards: false, pending: true, username: 'Alice', exists: true });
  assert.equal((await view(h, 'alice')).status, 404, 'hiding works straight away');
  await push(h, [snap({ shards: 900, hidden: false })]);
  assert.equal((await view(h, 'alice')).status, 404, 'an older bot snapshot does not undo it before the bot has seen the change');
  const polled = await h.poll();
  assert.deepEqual(polled.profileSettings, [{ user: ALICE.id, hidden: true, showShards: false }]);
  const ack = await h.bot('POST', '/bot/party/ack', { profileIds: [ALICE.id] });
  assert.deepEqual(await ack.json(), { ok: true, acked: 0, profilesAcked: 1 });
  assert.deepEqual((await h.poll()).profileSettings, []);
  await push(h, [snap({ shards: null, hidden: true })]);
  assert.equal((await view(h, 'alice')).status, 404);
  assert.equal((await h.api('POST', '/api/me/profile-visibility', cookie, {})).status, 400);
  assert.equal((await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: 'yes' })).status, 400);
  assert.equal((await h.api('POST', '/api/me/profile-visibility', cookie, { other: 1 })).status, 400);
});

test('a change made after the bot polled is not lost by an ack', async () => {
  const h = createHarness();
  await push(h, [snap()]);
  const { cookie } = await h.login(ALICE);
  await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: true });
  const first = await h.poll();
  assert.equal(first.profileSettings[0].hidden, true);
  advance(h, 1000);
  await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: false, showShards: true });
  const ack = await (await h.bot('POST', '/bot/party/ack', { profileIds: [ALICE.id] })).json();
  assert.equal(ack.profilesAcked, 0);
  const second = await h.poll();
  assert.deepEqual(second.profileSettings, [{ user: ALICE.id, hidden: false, showShards: true }]);
  assert.equal((await view(h, 'alice')).status, 200);
});

test('someone with no profile yet gets the defaults', async () => {
  const h = createHarness();
  const { cookie } = await h.login(BOB);
  const me = await (await h.api('GET', '/api/me/profile-visibility', cookie)).json();
  assert.deepEqual(me, { hidden: false, showShards: false, pending: false, username: null, exists: false });
});

test('public profile reads are rate limited per address', async () => {
  const h = createHarness();
  await push(h, [snap()]);
  let last;
  for (let i = 0; i < 121; i += 1) last = await view(h, 'alice', '198.51.100.99');
  assert.equal(last.status, 429);
  assert.equal((await view(h, 'alice', '198.51.100.98')).status, 200);
});

test('the SPA serves profile pages and cleanup drops stale snapshots', async () => {
  const h = createHarness();
  const page = await h.request('GET', '/u/alice');
  assert.equal(page.status, 200);
  await push(h, [snap()]);
  advance(h, 181 * 24 * 60 * MIN);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM public_profiles').get().n, 0);
});
