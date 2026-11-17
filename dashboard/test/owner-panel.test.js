import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { parseAmount, validateAction, cleanAfter, OWNER_KINDS } from '../worker/owner.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;

const CATALOG = {
  achievements: [
    { id: 'msgs1k', label: 'Chatterbox', emoji: '💬', reward: 100 },
    { id: 'level10', label: 'Rising star', emoji: '📈', reward: 100 },
    { id: 'bad id!', label: 'Nope' },
  ],
  badges: [{ id: 'founder', label: 'Founder', emoji: '🛡️' }],
};

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  const bob = (await h.login(BOB)).cookie;
  await h.bot('POST', '/bot/owner/catalog', CATALOG);
  return { h, owner, bob };
}

function profile(h, id, fields = {}) {
  const row = { username: 'pip', name: 'Pip', level: 4, xp: 900, shards: 250, badges: '[]', achievements: '[]', season: '[]', clan: null, hidden: 0, updated: h.clock.t, ...fields };
  h.db.raw.prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, row.username, row.username ? row.username.toLowerCase() : null, row.name, row.level, row.xp, row.shards, row.badges, row.achievements, row.season, row.clan, row.hidden, row.updated);
}

async function give(h, cookie, body) {
  const res = await h.api('POST', '/api/owner/actions', cookie, body);
  return { status: res.status, body: await res.json() };
}

test('only the owner can see the owner panel; everyone else gets a 404', async () => {
  const { h, owner, bob } = await setup();
  for (const path of ['/api/owner/users?q=a', `/api/owner/users/${uid(1)}`, '/api/owner/actions']) {
    assert.equal((await h.api('GET', path, bob)).status, 404, path);
    assert.equal((await h.api('GET', path, null)).status, 404, path);
    assert.equal((await h.api('GET', path, owner)).status, 200, path);
  }
  const post = await give(h, bob, { user: uid(1), kind: 'shards.add', value: 5 });
  assert.equal(post.status, 404);
  const noCsrf = await h.api('POST', '/api/owner/actions', owner, { user: uid(1), kind: 'shards.add', value: 5 }, { 'X-YapOS': null });
  assert.equal(noCsrf.status, 403);
  const badOrigin = await h.api('POST', '/api/owner/actions', owner, { user: uid(1), kind: 'shards.add', value: 5 }, { Origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
  assert.equal((await h.api('DELETE', '/api/owner/actions', owner)).status, 405);
});

test('without an owner configured nobody gets the panel', async () => {
  const h = createHarness();
  const cookie = (await h.login(OWNER)).cookie;
  assert.equal((await h.api('GET', '/api/owner/users', cookie)).status, 404);
});

test('search finds people across public profiles, the profile cache and dashboard sign-ins', async () => {
  const { h, owner } = await setup();
  profile(h, uid(1), { username: 'pipsqueak', name: 'Pip' });
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(uid(2), 'juno', 'Juno', 'https://files.yapper.website/j.png', h.clock.t);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(uid(3), 'percent%', 'Odd', null, h.clock.t);
  const byName = await (await h.api('GET', '/api/owner/users?q=pip', owner)).json();
  assert.equal(byName.users.length, 1);
  assert.deepEqual(Object.keys(byName.users[0]).sort(), ['account', 'avatar', 'id', 'level', 'name', 'seen', 'shards', 'username']);
  assert.equal(byName.users[0].account, 'checking');
  assert.equal(byName.users[0].username, 'pipsqueak');
  assert.equal(byName.users[0].level, 4);
  assert.equal(byName.users[0].shards, 250);
  const juno = await (await h.api('GET', '/api/owner/users?q=JUN', owner)).json();
  assert.equal(juno.users[0].id, uid(2));
  assert.equal(juno.users[0].avatar, 'https://files.yapper.website/j.png');
  assert.equal(juno.users[0].account, 'real');
  const bob = await (await h.api('GET', '/api/owner/users?q=%40bob', owner)).json();
  assert.equal(bob.users[0].id, BOB.id);
  assert.equal(bob.users[0].avatar, null);
  assert.ok(bob.users[0].seen > 0);
  const like = await (await h.api('GET', `/api/owner/users?q=${encodeURIComponent('%')}`, owner)).json();
  assert.deepEqual(like.users.map((u) => u.id), [uid(3)]);
  const unknown = await (await h.api('GET', `/api/owner/users?q=${uid(9).toUpperCase()}`, owner)).json();
  assert.deepEqual(unknown.users, [{ id: uid(9), username: null, name: null, avatar: null, level: null, shards: null, seen: null, account: 'checking' }]);
  assert.ok(h.db.raw.prepare('SELECT 1 FROM profile_wanted WHERE id = ?').get(uid(9)), 'a pasted id is sent to YapOS to check');
  const recent = await (await h.api('GET', '/api/owner/users', owner)).json();
  assert.ok(recent.users.length >= 4 && recent.users.length <= 20);
});

test('the user page shows their card, actions and the catalog', async () => {
  const { h, owner } = await setup();
  profile(h, uid(1), { badges: '["founder"]', achievements: '["msgs1k"]', clan: JSON.stringify({ name: 'Owls', tag: 'OWL', colour: '#7C5CFF' }), season: JSON.stringify([{ month: '2026-10', rank: 1, kind: 'xp' }]) });
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 3, '{}', '{}', ?)").run(uid(1), h.clock.t);
  const body = await (await h.api('GET', `/api/owner/users/${uid(1)}`, owner)).json();
  assert.equal(body.user.name, 'Pip');
  assert.deepEqual(body.user.party, { games: 12, wins: 3 });
  assert.deepEqual(body.user.badges, ['first-game', 'games-10', 'founder', 'season-xp-1-2026-10']);
  assert.deepEqual(body.user.earnedBadges, ['first-game', 'games-10']);
  assert.deepEqual(body.user.achievements, ['msgs1k']);
  assert.deepEqual(body.user.clan, { name: 'Owls', tag: 'OWL', colour: '#7c5cff' });
  assert.equal(body.user.season.length, 1);
  assert.deepEqual(body.actions, []);
  assert.deepEqual(body.catalog.achievements.map((a) => a.id), ['msgs1k', 'level10']);
  assert.equal(body.catalog.achievements[0].reward, 100);
  assert.ok(body.catalog.badges.some((b) => b.id === 'founder' && b.source === 'bot'));
  assert.ok(body.catalog.badges.some((b) => b.id === 'wins-10' && b.source === 'party'));
  assert.equal(body.catalog.kinds.length, Object.keys(OWNER_KINDS).length);
  const stranger = await (await h.api('GET', `/api/owner/users/${uid(8)}`, owner)).json();
  assert.equal(stranger.user.known, false);
  assert.equal(stranger.user.level, null);
  assert.equal((await h.api('GET', '/api/owner/users/not-a-user', owner)).status, 400);
});

test('actions are checked kind by kind with friendly messages', async () => {
  const { h, owner } = await setup();
  const cases = [
    [{ user: uid(1), kind: 'shards.add', value: 'inf' }, /Infinity/],
    [{ user: uid(1), kind: 'shards.add', value: Infinity }, /whole number/],
    [{ user: uid(1), kind: 'shards.add', value: 1e13 }, /too much/],
    [{ user: uid(1), kind: 'shards.add', value: 0 }, /at least 1/],
    [{ user: uid(1), kind: 'shards.add', value: 1.5 }, /decimals/],
    [{ user: uid(1), kind: 'shards.set', value: -1 }, /below zero/],
    [{ user: uid(1), kind: 'xp.add', value: 2e9 }, /too much/],
    [{ user: uid(1), kind: 'level.set', value: 100001 }, /too much/],
    [{ user: uid(1), kind: 'streak.set', value: 10001 }, /too much/],
    [{ user: uid(1), kind: 'achievement.grant', id: 'nope' }, /isn't in/],
    [{ user: uid(1), kind: 'badge.grant' }, /Pick a badge/],
    [{ user: uid(1), kind: 'party.stats.add', value: { games: 0, wins: 0 } }, /at least one/],
    [{ user: uid(1), kind: 'rm -rf' }, /isn't something/],
    [{ user: 'bob', kind: 'shards.add', value: 1 }, /user id/],
    [{ user: uid(1), kind: 'shards.add', value: 1, extra: 1 }, /Unknown field/],
    [{ user: uid(1), kind: 'shards.add', value: 1, note: 'x'.repeat(201) }, /note/],
  ];
  for (const [body, re] of cases) {
    const r = await give(h, owner, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.message, re, JSON.stringify(body));
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
  assert.equal(parseAmount('1,000', { min: 0, max: 1e12 }), 1000);
  const v = validateAction({ user: uid(1).toUpperCase(), kind: 'shards.remove', value: 5, notify: true }, { achievements: [], badges: [] });
  assert.equal(v.user, uid(1));
  assert.equal(v.notify, false);
  assert.throws(() => validateAction({ user: uid(1), kind: 'achievement.grant', id: 'msgs1k' }, { achievements: [], badges: [] }), /hasn't sent/);
});

test('a gift is queued, sent to the bot once, re-sent after two minutes and finished by its result', async () => {
  const { h, owner } = await setup();
  profile(h, uid(1));
  const made = await give(h, owner, { user: uid(1), kind: 'shards.add', value: '500', note: 'Thanks for testing', notify: true });
  assert.equal(made.status, 201);
  const a = made.body.action;
  assert.equal(a.status, 'queued');
  assert.equal(a.value, 500);
  assert.equal(a.notify, true);
  assert.equal(a.note, 'Thanks for testing');
  const g = await give(h, owner, { user: uid(1), kind: 'achievement.grant', id: 'MSGS1K' });
  assert.equal(g.body.action.ref, 'msgs1k');
  const first = await h.poll();
  assert.equal(first.hot, true);
  assert.deepEqual(first.owner, [
    { id: a.id, user: uid(1), kind: 'shards.add', value: 500, ref: null, notify: true },
    { id: g.body.action.id, user: uid(1), kind: 'achievement.grant', value: null, ref: 'msgs1k', notify: false },
  ]);
  assert.deepEqual((await h.poll()).owner, []);
  const listed = await (await h.api('GET', `/api/owner/users/${uid(1)}`, owner)).json();
  assert.equal(listed.actions.find((x) => x.id === a.id).status, 'sent');
  advance(h, 2 * MIN + 1);
  assert.equal((await h.poll()).owner.length, 2);
  const res = await h.bot('POST', '/bot/owner/results', { results: [
    { id: a.id, ok: true, message: 'Gave 500 💎 Shards.', after: { shards: 750, level: 5, xp: 1200, achievements: ['msgs1k'], badges: ['founder'] } },
    { id: g.body.action.id, ok: false, message: 'They already have that achievement.' },
    { id: 'missing-one', ok: true },
    { nope: true },
  ] });
  assert.deepEqual(await res.json(), { ok: true, stored: 2, ignored: ['missing-one', null] });
  const again = await h.bot('POST', '/bot/owner/results', { results: [{ id: a.id, ok: false, message: 'late' }] });
  assert.deepEqual((await again.json()).ignored, [a.id]);
  const after = await (await h.api('GET', `/api/owner/users/${uid(1)}`, owner)).json();
  const done = after.actions.find((x) => x.id === a.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Gave 500 💎 Shards.');
  assert.equal(after.actions.find((x) => x.id === g.body.action.id).status, 'failed');
  assert.equal(after.user.shards, 750);
  assert.equal(after.user.level, 5);
  assert.equal(after.user.xp, 1200);
  assert.deepEqual(after.user.achievements, ['msgs1k']);
  assert.ok(after.user.badges.includes('founder'));
  advance(h, 3 * MIN);
  assert.deepEqual((await h.poll()).owner, []);
});

test('results never reveal Shards a person hid, but the owner panel still knows them', async () => {
  const { h, owner } = await setup();
  profile(h, uid(1), { shards: null });
  const { body } = await give(h, owner, { user: uid(1), kind: 'shards.set', value: 42 });
  await h.poll();
  await h.bot('POST', '/bot/owner/results', { results: [{ id: body.action.id, ok: true, message: 'Set.', after: { shards: 42 } }] });
  assert.equal(h.db.raw.prepare('SELECT shards FROM public_profiles WHERE user_id = ?').get(uid(1)).shards, null);
  const detail = await (await h.api('GET', `/api/owner/users/${uid(1)}`, owner)).json();
  assert.equal(detail.user.shards, 42);
});

test('Party stats are added right away on the dashboard and never sent to the bot', async () => {
  const { h, owner } = await setup();
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?)').run(uid(2), 'juno', 'Juno', h.clock.t);
  const r = await give(h, owner, { user: uid(2), kind: 'party.stats.add', value: { games: 10, wins: 2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.action.status, 'done');
  assert.match(r.body.action.result, /10 games and 2 wins/);
  await give(h, owner, { user: uid(2), kind: 'party.stats.add', value: { games: 1 } });
  const row = h.db.raw.prepare('SELECT games, wins FROM party_stats WHERE user_id = ?').get(uid(2));
  assert.deepEqual({ ...row }, { games: 11, wins: 2 });
  assert.deepEqual((await h.poll()).owner, []);
});

test('the owner can make 120 changes a minute and then has to wait', async () => {
  const { h, owner } = await setup();
  for (let i = 0; i < 120; i += 1) {
    const r = await give(h, owner, { user: uid(1), kind: 'quests.reset' });
    assert.equal(r.status, 201, `action ${i}`);
  }
  const over = await give(h, owner, { user: uid(1), kind: 'quests.reset' });
  assert.equal(over.status, 429);
  advance(h, MIN);
  assert.equal((await give(h, owner, { user: uid(1), kind: 'quests.reset' })).status, 201);
  const polled = await h.poll();
  assert.equal(polled.owner.length, 50);
  const list = await (await h.api('GET', '/api/owner/actions?limit=500', owner)).json();
  assert.equal(list.actions.length, 121 > 200 ? 200 : 121);
  assert.ok('who' in list.actions[0]);
});

test('the activity log names people and is newest first', async () => {
  const { h, owner } = await setup();
  profile(h, uid(1));
  await give(h, owner, { user: uid(1), kind: 'giver.grant', notify: true });
  advance(h, 1000);
  await give(h, owner, { user: uid(3), kind: 'streak.set', value: 7 });
  const { actions } = await (await h.api('GET', '/api/owner/actions?limit=5', owner)).json();
  assert.deepEqual(actions.map((a) => a.kind), ['streak.set', 'giver.grant']);
  assert.deepEqual(actions[1].who, { username: 'pip', name: 'Pip' });
  assert.equal(actions[1].notify, true);
  assert.deepEqual(actions[0].who, { username: null, name: null });
});

test('actions nobody picks up for a week are cancelled', async () => {
  const { h, owner } = await setup();
  const { body } = await give(h, owner, { user: uid(1), kind: 'xp.add', value: 10 });
  advance(h, 8 * 24 * 60 * MIN);
  assert.deepEqual((await h.poll()).owner, []);
  const row = h.db.raw.prepare('SELECT status, result FROM owner_actions WHERE id = ?').get(body.action.id);
  assert.equal(row.status, 'failed');
  assert.match(row.result, /week/);
});

test('the bot catalog is cleaned and replaced, and bot endpoints need the bot secret', async () => {
  const { h } = await setup();
  assert.equal((await h.bot('POST', '/bot/owner/catalog', CATALOG, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  assert.equal((await h.bot('POST', '/bot/owner/results', { results: [] }, null)).status, 401);
  assert.equal((await h.bot('GET', '/bot/owner/catalog')).status, 405);
  const res = await h.bot('POST', '/bot/owner/catalog', { achievements: [{ id: 'one', label: '<b>One</b>', emoji: '1️⃣', reward: -5 }], badges: 'nope' });
  assert.equal(res.status, 400);
  const ok = await h.bot('POST', '/bot/owner/catalog', { achievements: [{ id: 'one', label: 'One', emoji: '1️⃣', reward: -5 }] });
  assert.deepEqual(await ok.json(), { ok: true, achievements: 1, badges: 0 });
  const data = JSON.parse(h.db.raw.prepare("SELECT data FROM owner_catalog WHERE id = 'bot'").get().data);
  assert.deepEqual(data, { achievements: [{ id: 'one', label: 'One', emoji: '1️⃣', reward: 0 }], badges: [] });
});

test('cleanAfter keeps only sane numbers and id lists', () => {
  assert.equal(cleanAfter(null), null);
  assert.equal(cleanAfter({}), null);
  assert.deepEqual(cleanAfter({ shards: -1, level: 3.7, xp: 'x', achievements: ['ok', 'not ok', 5], badges: [] }), { shards: null, level: 3, xp: null, achievements: ['ok'], badges: [], hidden: false, privateShards: false });
  assert.deepEqual(cleanAfter({ shards: 5, hidden: true, privateShards: true }), { shards: 5, level: null, xp: null, achievements: null, badges: null, hidden: true, privateShards: true });
});

test('the owner pages load the dashboard app shell', async () => {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  for (const path of ['/owner', `/owner/${uid(1)}`]) {
    const res = await h.request('GET', path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<body>app<\/body>/);
  }
  assert.equal((await h.request('GET', '/owner/nope')).status, 404);
});
