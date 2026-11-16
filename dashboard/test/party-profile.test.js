import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { LIMITS } from '../worker/rate.js';
import { levelProgress, CARD_TTL } from '../worker/party-profile.js';
import { decodeTerm } from '../web/activity/js/filter.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const CAROL = '55555555-5555-4555-8555-555555555555';
const SLUR = decodeTerm('yogqkz');

function snap(over = {}) {
  return {
    id: ALICE.id,
    name: 'Alice',
    username: 'alice',
    level: 3,
    xp: 500,
    shards: 4200,
    badges: ['first-game', 'chatterbox'],
    achievements: ['messages-10k'],
    season: [],
    clan: { name: 'Night Owls', tag: 'OWL', colour: '#AA33FF' },
    hidden: false,
    ...over,
  };
}

async function seed(h, over = {}) {
  await h.bot('POST', '/bot/profiles', { profiles: [snap(over), { id: ALICE.id, username: 'alice', display_name: 'Alice Call', avatar_url: ALICE.avatar_url }] });
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, ?, '{}', 0)").run(ALICE.id, JSON.stringify({ draw: { p: 7, w: 3 }, trivia: { p: 5, w: 1 }, nope: { p: 99, w: 9 } }));
  const add = h.db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, 1, 0, 0, NULL, 0)');
  add.run(ALICE.id, 'Alice', 'alice', 900);
  add.run(BOB.id, 'Bob', 'bob', 1500);
  add.run(CAROL, 'Carol', 'carol', 2000);
}

function card(h, id, ip = '203.0.113.60') {
  return h.request('GET', `/api/activity/profile/${encodeURIComponent(id)}`, { ip });
}

test('the Party profile card shows level, badges, Party stats, rank and clan by Yapin user id', async () => {
  const h = createHarness();
  await seed(h);
  const res = await card(h, ALICE.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=30');
  const { profile } = await res.json();
  assert.equal(profile.hidden, false);
  assert.equal(profile.name, 'Alice');
  assert.equal(profile.username, 'alice');
  assert.equal(profile.avatar, ALICE.avatar_url);
  assert.equal(profile.level, 3);
  assert.equal(profile.xp, 500);
  assert.deepEqual(profile.progress, levelProgress(3, 500));
  assert.equal(profile.shards, 4200);
  const first = profile.badges.find((b) => b.id === 'first-game');
  assert.equal(first.emoji, '🎈');
  assert.equal(first.label, 'First game');
  assert.ok(profile.badges.some((b) => b.id === 'games-10'));
  assert.ok(profile.badges.some((b) => b.id === 'chatterbox' && b.label === 'Chatterbox'));
  assert.deepEqual(profile.achievements.map((a) => a.id), ['messages-10k']);
  assert.deepEqual(profile.clan, { name: 'Night Owls', tag: 'OWL', colour: '#aa33ff' });
  assert.deepEqual(profile.party.favourites, [{ game: 'draw', played: 7, won: 3 }, { game: 'trivia', played: 5, won: 1 }]);
  assert.equal(profile.party.games, 12);
  assert.equal(profile.party.wins, 4);
  assert.deepEqual(profile.rank, { rank: 3, points: 900 });
  assert.equal(profile.page, true);
});

test('the Party profile card never leaks user ids', async () => {
  const h = createHarness();
  await seed(h);
  const text = await (await card(h, ALICE.id)).text();
  for (const id of [ALICE.id, BOB.id, CAROL]) assert.equal(text.includes(id), false, id);
  assert.equal(text.includes('"id":"1111'), false);
});

test('banned players drop out of the rank count and get no rank themselves', async () => {
  const h = createHarness();
  await seed(h);
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'Carol', 'carol', NULL, 'x', 0)").run(CAROL);
  assert.deepEqual((await (await card(h, ALICE.id)).json()).profile.rank, { rank: 2, points: 900 });
  const h2 = createHarness();
  await seed(h2);
  h2.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'Alice', 'alice', NULL, 'x', 0)").run(ALICE.id);
  assert.equal((await (await card(h2, ALICE.id)).json()).profile.rank, null);
});

test('a hidden profile only returns the call name and avatar', async () => {
  const h = createHarness();
  await seed(h, { hidden: true });
  const res = await card(h, ALICE.id);
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.deepEqual(profile, { hidden: true, name: 'Alice Call', avatar: ALICE.avatar_url });
});

test('hiding the profile on the website takes effect before the bot syncs it', async () => {
  const h = createHarness();
  await seed(h);
  const { cookie } = await h.login(ALICE);
  await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: true });
  advance(h, CARD_TTL + 1);
  assert.equal((await (await card(h, ALICE.id)).json()).profile.hidden, true);
});

test('Shards only show when the person allows it', async () => {
  const h = createHarness();
  await seed(h);
  const { cookie } = await h.login(ALICE);
  await h.api('POST', '/api/me/profile-visibility', cookie, { showShards: false });
  const { profile } = await (await card(h, ALICE.id, '203.0.113.61')).json();
  assert.equal(profile.shards, null);
  const h2 = createHarness();
  await seed(h2, { shards: null });
  assert.equal((await (await card(h2, ALICE.id)).json()).profile.shards, null);
});

test('unknown and malformed ids are not found', async () => {
  const h = createHarness();
  await seed(h);
  for (const id of ['99999999-9999-4999-8999-999999999999', 'bad id', 'x'.repeat(80)]) {
    const res = await card(h, id);
    assert.equal(res.status, 404, id);
    assert.equal((await res.json()).error, 'not_found');
  }
  assert.equal((await h.request('POST', `/api/activity/profile/${ALICE.id}`, { body: {} })).status, 405);
});

test('a player with only Party points still gets a card, with the name run through the filter', async () => {
  const h = createHarness();
  h.db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, 50, 1, 0, 0, NULL, 0)').run(CAROL, `${SLUR} king`, SLUR);
  const { profile } = await (await card(h, CAROL)).json();
  assert.equal(profile.name, 'Player');
  assert.equal(profile.username, null);
  assert.equal(profile.level, null);
  assert.equal(profile.progress, null);
  assert.deepEqual(profile.rank, { rank: 1, points: 50 });
});

test('the Party profile card is rate limited per IP and cached for 30 seconds', async () => {
  const h = createHarness();
  await seed(h);
  assert.equal((await (await card(h, ALICE.id)).json()).profile.level, 3);
  h.db.raw.prepare('UPDATE public_profiles SET level = 9').run();
  assert.equal((await (await card(h, ALICE.id)).json()).profile.level, 3);
  advance(h, CARD_TTL + 1);
  assert.equal((await (await card(h, ALICE.id)).json()).profile.level, 9);
  advance(h, 60_000);
  let last = null;
  for (let i = 0; i <= LIMITS.partyProfile; i++) last = await card(h, ALICE.id, '198.51.100.9');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('Retry-After')) >= 1);
  assert.equal((await card(h, ALICE.id, '198.51.100.10')).status, 200);
});
