import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { createActivitySession } from '../worker/activity-auth.js';
import { cleanup } from '../worker/cron.js';
import { CLAN_JOIN_GIVE_UP, CLAN_JOIN_KEEP } from '../worker/clans.js';
import { createHarness as createBotHarness, IDS } from '../../test/harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const LEAD = '55555555-5555-4555-8555-555555555555';
const CAROL = { id: '66666666-6666-4666-8666-666666666666', username: 'carol', display_name: 'Carol', avatar_url: null };

const owl = (extra = {}) => ({ id: 'c1', tag: 'OWL', name: 'Night Owls', colour: '#ff8800', banner: 'Night owls never sleep', join: 'open', leader: LEAD, created: 1000, count: 2, members: [LEAD, CAROL.id], ...extra });
const lark = (extra = {}) => ({ id: 'c2', tag: 'LARK', name: 'Day Larks', colour: null, banner: null, join: 'open', leader: BOB.id, created: 2000, count: 1, members: [BOB.id], ...extra });

async function profile(h, id, name, username, level, hidden = 0) {
  await h.db.prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?)')
    .bind(id, username, username, name, level, '[]', '[]', '[]', hidden, h.clock.t).run();
}

async function setup() {
  const h = createHarness();
  await profile(h, LEAD, 'Lead Owl', 'leadowl', 40);
  await profile(h, CAROL.id, 'Carol', 'carol', 12);
  const push = (body) => h.bot('POST', '/bot/clans', body);
  assert.equal((await push({ clans: [owl(), lark()], full: true, known: ['c1', 'c2'] })).status, 200);
  const alice = (await h.login(ALICE)).cookie;
  return { h, push, alice };
}

const read = async (res) => ({ status: res.status, body: await res.json() });

test('the bot pushes a clan directory and anyone can read a clan by its tag', async () => {
  const { h } = await setup();
  assert.equal((await h.bot('POST', '/bot/clans', { clans: [] }, null)).status, 401);
  assert.equal((await h.bot('POST', '/bot/clans', { clans: [] }, 'wrong-secret-wrong-secret-wrong-secret-0')).status, 401);
  const { status, body } = await read(await h.request('GET', '/api/clans/owl'));
  assert.equal(status, 200);
  assert.deepEqual(body.clan, {
    tag: 'OWL', name: 'Night Owls', colour: '#ff8800', banner: 'Night owls never sleep', members: 2, join: 'open', created: 1000, updated: h.clock.t,
    leader: { name: 'Lead Owl', username: 'leadowl' },
    top: [{ name: 'Lead Owl', username: 'leadowl', level: 40, leader: true }, { name: 'Carol', username: 'carol', level: 12, leader: false }],
  });
  assert.deepEqual(body.viewer, { signedIn: false, status: 'signed_out', clan: null, request: null });
  assert.equal((await h.request('GET', '/api/clans/O')).status, 400);
  assert.equal((await h.request('GET', '/api/clans/OWL!x')).status, 400);
  assert.equal((await h.request('GET', '/api/clans/NOPE')).status, 404);
  assert.equal((await h.request('POST', '/api/clans/OWL')).status, 405);
  assert.equal((await h.request('GET', '/api/clans/OWL/join')).status, 405);
});

test('clans hold any number of members and directory pushes replace, remove and prune', async () => {
  const { h, push } = await setup();
  const many = Array.from({ length: 250 }, (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`);
  assert.equal((await push({ clans: [owl({ members: [LEAD, ...many], count: 251 })] })).status, 200);
  const n = await h.db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?').bind('c1').first();
  assert.equal(Number(n.n), 251);
  assert.equal((await read(await h.request('GET', '/api/clans/OWL'))).body.clan.members, 251);
  await push({ clans: [owl({ members: [LEAD], count: 1, join: 'invite' })] });
  const after = await read(await h.request('GET', '/api/clans/OWL'));
  assert.equal(after.body.clan.members, 1);
  assert.equal(after.body.clan.join, 'invite');
  assert.equal(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM clan_members').first()).n), 2);
  await push({ clans: [], removed: ['c2'] });
  assert.equal((await h.request('GET', '/api/clans/LARK')).status, 404);
  assert.equal(await h.db.prepare('SELECT user_id FROM clan_members WHERE user_id = ?').bind(BOB.id).first(), null);
  await push({ clans: [lark()] });
  const pruned = await read(await h.bot('POST', '/bot/clans', { clans: [], full: true, known: ['c2'] }));
  assert.equal(pruned.body.removed, 1);
  assert.equal((await h.request('GET', '/api/clans/OWL')).status, 404);
  assert.equal((await h.request('GET', '/api/clans/LARK')).status, 200);
  const junk = await read(await push({ clans: [{ id: 'x', tag: 'OWL', name: 'Bad' }, { id: 'c9', tag: 'TOOLONG', name: 'Fine' }, owl()] }));
  assert.equal(junk.body.stored, 1);
  assert.equal(junk.body.ignored, 2);
  assert.equal((await push({ clans: Array.from({ length: 201 }, (_, i) => owl({ id: `c${i + 10}` })) })).status, 413);
});

test('signed-in people on the website join an open clan with CSRF, then the bot answers', async () => {
  const { h, alice } = await setup();
  const viewer = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(viewer.body.viewer.status, 'can_join');
  assert.equal((await h.request('POST', '/api/clans/OWL/join')).status, 403, 'no CSRF and no session');
  assert.equal((await h.api('POST', '/api/clans/OWL/join', alice, undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('POST', '/api/clans/OWL/join', alice, undefined, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', '/api/clans/OWL/join', null)).status, 401);
  const sent = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(sent.status, 202);
  assert.equal(sent.body.request.status, 'pending');
  assert.equal(sent.body.request.waiting, false);
  assert.equal(sent.body.viewer.status, 'pending');
  const id = sent.body.request.id;
  const again = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(again.status, 200);
  assert.equal(again.body.request.id, id, 'asking twice does not queue twice');
  const other = await read(await h.api('POST', '/api/clans/LARK/join', alice));
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'pending_elsewhere');

  const poll = await h.poll();
  assert.equal(poll.hot, true);
  assert.deepEqual(poll.clanJoins, [{ id, user: ALICE.id, clan: 'c1', tag: 'OWL', via: 'web' }]);
  assert.deepEqual((await h.poll()).clanJoins, [], 'a sent request is not handed out again right away');
  const posted = await read(await h.bot('POST', '/bot/clans/joins', { results: [{ id, ok: true, code: 'joined', message: 'You joined [OWL] Night Owls!' }, { id: 'nope-nope-nope', ok: true }] }));
  assert.deepEqual(posted.body, { ok: true, stored: 1, ignored: ['nope-nope-nope'] });
  const done = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(done.body.viewer.status, 'member');
  assert.equal(done.body.viewer.request.status, 'joined');
  assert.equal(done.body.viewer.request.message, 'You joined [OWL] Night Owls!');
  assert.equal(done.body.clan.members, 3);
  const twice = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'already_member');
  const lark = await read(await h.api('GET', '/api/clans/LARK', alice));
  assert.equal(lark.body.viewer.status, 'other');
  assert.deepEqual(lark.body.viewer.clan, { tag: 'OWL', name: 'Night Owls' });
  const leave = await read(await h.api('POST', '/api/clans/LARK/join', alice));
  assert.equal(leave.status, 409);
  assert.equal(leave.body.error, 'in_other_clan');
});

test('invite-only clans refuse, and a refusal from the bot is shown to the requester', async () => {
  const { h, push, alice } = await setup();
  await push({ clans: [owl({ join: 'invite' })] });
  const view = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(view.body.viewer.status, 'invite_only');
  const refused = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'invite_only');
  assert.match(refused.body.message, /invite only/);
  assert.deepEqual((await h.poll()).clanJoins, []);

  await push({ clans: [owl()] });
  const sent = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  const { clanJoins } = await h.poll();
  assert.equal(clanJoins[0].id, sent.body.request.id);
  await h.bot('POST', '/bot/clans/joins', { results: [{ id: clanJoins[0].id, ok: false, code: 'invite_only', message: '[OWL] Night Owls is invite only now. Ask the leader for an invite.' }] });
  const after = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(after.body.viewer.status, 'invite_only');
  assert.equal(after.body.viewer.request.status, 'refused');
  assert.equal(after.body.viewer.request.code, 'invite_only');
  assert.equal(after.body.clan.join, 'invite', 'the refusal updates the directory right away');
});

test('YapOS Party joins with its bearer token and no CSRF header', async () => {
  const { h } = await setup();
  const token = await createActivitySession(h.db, ALICE, h.clock.t);
  const auth = { Authorization: `Bearer ${token}` };
  const view = await read(await h.request('GET', '/api/clans/OWL', { headers: auth }));
  assert.equal(view.body.viewer.status, 'can_join');
  const sent = await read(await h.request('POST', '/api/clans/OWL/join', { headers: auth }));
  assert.equal(sent.status, 202);
  const { clanJoins } = await h.poll();
  assert.equal(clanJoins[0].via, 'party');
  assert.equal(clanJoins[0].user, ALICE.id);
  const bad = await h.request('POST', '/api/clans/OWL/join', { headers: { Authorization: `Bearer ${'x'.repeat(43)}` } });
  assert.equal(bad.status, 401);
});

test('join requests are rate limited and wait politely while the bot is offline', async () => {
  const { h, alice } = await setup();
  const sent = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  advance(h, 50 * 1000);
  const waiting = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(waiting.body.viewer.request.waiting, true);
  assert.match(waiting.body.viewer.request.message, /offline/);
  for (let i = 0; i < 9; i++) assert.equal((await h.api('POST', '/api/clans/OWL/join', alice)).status, 200);
  const slow = await read(await h.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(slow.status, 429);
  advance(h, CLAN_JOIN_GIVE_UP + 1);
  const { clanJoins } = await h.poll();
  assert.deepEqual(clanJoins, []);
  const dropped = await read(await h.api('GET', '/api/clans/OWL', alice));
  assert.equal(dropped.body.viewer.status, 'can_join');
  const row = await h.db.prepare('SELECT status FROM clan_joins WHERE id = ?').bind(sent.body.request.id).first();
  assert.equal(row.status, 'failed');
  advance(h, CLAN_JOIN_KEEP);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.clanJoins, 1);
});

test('the leader comes first in the top members even with a lower level', async () => {
  const { h, push } = await setup();
  await h.db.prepare('UPDATE public_profiles SET level = 3 WHERE user_id = ?').bind(LEAD).run();
  await push({ clans: [owl()] });
  const { body } = await read(await h.request('GET', '/api/clans/OWL'));
  assert.deepEqual(body.clan.top.map((m) => [m.username, m.leader]), [['leadowl', true], ['carol', false]]);
  await h.db.prepare('UPDATE public_profiles SET hidden = 1 WHERE user_id = ?').bind(LEAD).run();
  await push({ clans: [owl({ name: 'Night Owls Two' })] });
  const hidden = await read(await h.request('GET', '/api/clans/OWL'));
  assert.deepEqual(hidden.body.clan.top.map((m) => m.username), ['carol']);
  assert.equal(hidden.body.clan.leader, null);
});

test('hidden profiles and hidden names stay hidden on the clan sheet', async () => {
  const { h, push } = await setup();
  await h.db.prepare("INSERT INTO party_hidden_names (user_id, kind, reason, by_id, by_name, at) VALUES (?, 'name', 'rude', ?, 'Staff', ?)").bind(LEAD, ALICE.id, h.clock.t).run();
  await h.db.prepare('UPDATE public_profiles SET hidden = 1 WHERE user_id = ?').bind(CAROL.id).run();
  await push({ clans: [owl()] });
  const { body } = await read(await h.request('GET', '/api/clans/OWL'));
  assert.equal(body.clan.leader.name, 'Hidden name');
  assert.equal(body.clan.top.length, 1);
  assert.ok(!JSON.stringify(body).includes('Carol'));
  assert.ok(!JSON.stringify(body).includes(CAROL.id));
  assert.ok(!JSON.stringify(body).includes(LEAD));
});

test('the real bot pushes its clans and applies web joins with fresh checks', async () => {
  const w = createHarness();
  const alice = (await w.login(ALICE)).cookie;
  const bob = (await w.login(BOB)).cookie;
  const b = await createBotHarness({ apps: ['economy', 'levels', 'clans'], fakeClock: true });
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('CF-Connecting-IP', '203.0.113.9');
    return w.worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), w.env, { waitUntil() {} });
  };
  const dash = createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  b.engine.service('economy').add(GLOBAL_KEY, IDS.member, 600, 'Test funds');
  await b.slash('clan', 'create Night Owls OWL', { user: IDS.member });
  assert.deepEqual(await dash.syncClans(), { sent: 1, removed: 0 });
  assert.deepEqual(await dash.syncClans(), { sent: 0, removed: 0 }, 'nothing is sent when nothing changed');
  const first = await read(await w.api('GET', '/api/clans/OWL', alice));
  assert.equal(first.body.clan.members, 1);
  assert.equal(first.body.clan.join, 'open');

  const sent = await read(await w.api('POST', '/api/clans/OWL/join', alice));
  assert.equal(sent.status, 202);
  const cycle = async () => {
    const { clanJoins } = await w.poll();
    const out = await dash.applyClanJoins(clanJoins);
    await dash.syncClans();
    return out;
  };
  assert.deepEqual(await cycle(), { applied: 1, posted: 1 });
  assert.equal(b.engine.service('clans').of(ALICE.id).tag, 'OWL');
  const joined = await read(await w.api('GET', '/api/clans/OWL', alice));
  assert.equal(joined.body.viewer.status, 'member');
  assert.equal(joined.body.clan.members, 2);

  const queued = await read(await w.api('POST', '/api/clans/OWL/join', bob));
  assert.equal(queued.status, 202);
  await b.slash('clan', 'privacy invite', { user: IDS.member });
  await cycle();
  assert.equal(b.engine.service('clans').of(BOB.id), null, 'the bot checks the join mode again');
  const refused = await read(await w.api('GET', '/api/clans/OWL', bob));
  assert.equal(refused.body.viewer.request.status, 'refused');
  assert.equal(refused.body.viewer.request.code, 'invite_only');
  assert.equal(refused.body.clan.join, 'invite');

  await b.slash('clan', 'privacy open', { user: IDS.member });
  await dash.syncClans();
  b.engine.service('economy').add(GLOBAL_KEY, BOB.id, 600, 'Test funds');
  await b.slash('clan', 'create Day Larks LARK', { user: BOB.id });
  await w.db.prepare('DELETE FROM clan_members WHERE user_id = ?').bind(BOB.id).run();
  const stale = await read(await w.api('POST', '/api/clans/OWL/join', bob));
  assert.equal(stale.status, 202, 'the Worker had an old view of Bob');
  await cycle();
  const inClan = await read(await w.api('GET', '/api/clans/OWL', bob));
  assert.equal(inClan.body.viewer.request.code, 'in_clan');
  assert.equal(inClan.body.viewer.status, 'other');
  assert.equal(b.engine.service('clans').of(BOB.id).tag, 'LARK');

  await b.slash('clan', 'disband', { user: BOB.id });
  const close = b.findButton('Close the clan');
  await b.click(close.custom_id, { user: BOB.id, messageId: close.messageId });
  assert.equal((await dash.syncClans()).removed, 1);
  assert.equal((await w.request('GET', '/api/clans/LARK')).status, 404);
});

test('a clan bigger than one push is sent in parts and the Worker keeps every member', async () => {
  const w = createHarness();
  const b = await createBotHarness({ apps: ['economy', 'levels', 'clans'], fakeClock: true });
  const posts = [];
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('CF-Connecting-IP', '203.0.113.9');
    if (String(url).endsWith('/bot/clans')) posts.push(JSON.parse(init.body));
    return w.worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), w.env, { waitUntil() {} });
  };
  const many = Array.from({ length: 12001 }, (_, i) => `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`);
  let rev = 1;
  const big = { id: 'c7', tag: 'HUGE', name: 'Huge Clan', colour: null, banner: null, join: 'open', leader: many[0], created: 5, count: many.length, members: many };
  const fake = { directory: () => [big], rev: () => rev, webJoin: async () => ({ ok: false, code: 'failed', message: '' }) };
  const real = b.engine.service.bind(b.engine);
  b.engine.service = (name) => (name === 'clans' ? fake : real(name));
  const dash = createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  assert.deepEqual(await dash.syncClans(), { sent: 1, removed: 0 });
  assert.equal(posts.length, 3);
  assert.equal(posts[0].full, true);
  assert.deepEqual(posts.map((p) => p.clans[0].append === true), [false, true, true]);
  assert.ok(posts.every((p) => p.clans[0].members.length <= 5000));
  const n = await w.db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?').bind('c7').first();
  assert.equal(Number(n.n), 12001);
  const row = await w.db.prepare('SELECT members FROM clan_directory WHERE id = ?').bind('c7').first();
  assert.equal(Number(row.members), 12001);
  big.members = many.slice(0, 3);
  big.count = 3;
  rev += 1;
  await dash.syncClans();
  const after = await w.db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?').bind('c7').first();
  assert.equal(Number(after.n), 3, 'a fresh push replaces the old member list');
});

test('two joins sent at once for different clans queue only one request', async () => {
  const { h, alice } = await setup();
  const [a, b] = await Promise.all([
    read(await h.api('POST', '/api/clans/OWL/join', alice)),
    read(await h.api('POST', '/api/clans/LARK/join', alice)),
  ]);
  const codes = [a.status, b.status].sort();
  assert.ok(codes[0] === 202 && (codes[1] === 409 || codes[1] === 202));
  const n = await h.db.prepare("SELECT COUNT(*) AS n FROM clan_joins WHERE user_id = ? AND status IN ('queued', 'sent')").bind(ALICE.id.toLowerCase()).first();
  assert.equal(Number(n.n), 1, 'only one open request per person');
});
