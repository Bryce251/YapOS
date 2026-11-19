import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { cleanup } from '../worker/cron.js';
import { CLAN_ACTION_GIVE_UP, CLAN_ACTIONS_OPEN, CLAN_INVITE_TTL } from '../worker/clan-manage.js';
import { INBOX_MAX, INBOX_KEEP } from '../worker/inbox.js';
import { LIMITS } from '../worker/rate.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const CAROL = { id: '66666666-6666-4666-8666-666666666666', username: 'carol', display_name: 'Carol', avatar_url: null };
const DAVE = { id: '77777777-7777-4777-8777-777777777777', username: 'dave', display_name: 'Dave', avatar_url: null };
const SECRET = '88888888-8888-4888-8888-888888888888';

const owl = (extra = {}) => ({ id: 'c1', tag: 'OWL', name: 'Night Owls', colour: '#ff8800', banner: 'Night owls never sleep', join: 'open', leader: ALICE.id, created: 1000, count: 2, members: [ALICE.id, CAROL.id], bank: 2000, style: false, boost: false, deposits: { [ALICE.id]: 1500, [CAROL.id]: 500 }, invites: [], ...extra });
const lark = (extra = {}) => ({ id: 'c2', tag: 'LARK', name: 'Day Larks', colour: null, banner: null, join: 'open', leader: BOB.id, created: 2000, count: 1, members: [BOB.id], bank: 0, style: false, boost: false, deposits: {}, invites: [], ...extra });

async function profile(h, user, level, hidden = 0) {
  await h.db.prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?)')
    .bind(user.id, user.username, user.username.toLowerCase(), user.display_name, level, '[]', '[]', '[]', hidden, h.clock.t).run();
}

const read = async (res) => ({ status: res.status, body: await res.json() });

async function setup(env = {}) {
  const h = createHarness(env);
  await profile(h, ALICE, 30);
  await profile(h, BOB, 20);
  await profile(h, CAROL, 12);
  await profile(h, DAVE, 5);
  await profile(h, { id: SECRET, username: 'secret', display_name: 'Secret' }, 9, 1);
  const push = (body) => h.bot('POST', '/bot/clans', body);
  assert.equal((await push({ clans: [owl(), lark()], full: true, known: ['c1', 'c2'] })).status, 200);
  const cookies = {};
  for (const [k, u] of Object.entries({ alice: ALICE, bob: BOB, carol: CAROL, dave: DAVE })) cookies[k] = (await h.login(u)).cookie;
  const act = (who, body, extra) => h.api('POST', '/api/me/clan/actions', cookies[who], body, extra);
  const view = async (who) => (await read(await h.api('GET', '/api/me/clan', cookies[who]))).body;
  const inbox = async (who, q = '') => (await read(await h.api('GET', `/api/me/inbox${q}`, cookies[who]))).body;
  return { h, push, cookies, act, view, inbox };
}

test('your clan page shows members with roles, the bank, upgrades and pending invites only to the leader', async () => {
  const { h, push, view } = await setup();
  assert.equal((await h.api('GET', '/api/me/clan', null)).status, 401);
  await push({ clans: [owl({ invites: [{ user: DAVE.id, by: ALICE.id, at: h.clock.t }] })] });
  const lead = await view('alice');
  assert.equal(lead.clan.tag, 'OWL');
  assert.equal(lead.clan.leader, true);
  assert.equal(lead.clan.bank, 2000);
  assert.deepEqual(lead.clan.members.map((m) => [m.name, m.leader, m.you]), [['Alice', true, true], ['Carol', false, false]]);
  assert.deepEqual(lead.clan.deposits, [{ name: 'Alice', amount: 1500 }, { name: 'Carol', amount: 500 }]);
  assert.deepEqual(lead.clan.invites.map((p) => p.name), ['Dave']);
  assert.deepEqual(lead.settings, { createCost: 500, stylePrice: 1500, boostPrice: 5000, boost: 0.05 });
  const member = await view('carol');
  assert.equal(member.clan.leader, false);
  assert.equal(member.clan.leaderName, 'Alice');
  assert.deepEqual(member.clan.invites, [], 'members do not see who was invited');
  const dave = await view('dave');
  assert.equal(dave.clan, null);
  assert.deepEqual(dave.invites.map((x) => [x.clan.tag, x.by]), [['OWL', 'Alice']]);
  await push({ clans: [owl()], settings: { createCost: 250, stylePrice: 1500, boostPrice: 5000, boost: 0.05 } });
  assert.equal((await view('dave')).settings.createCost, 250);
  assert.deepEqual((await view('dave')).invites, [], 'an invite the bot no longer has is gone');
});

test('clan changes need a session and CSRF and are validated before they are queued', async () => {
  const { h, act, cookies } = await setup();
  assert.equal((await h.request('POST', '/api/me/clan/actions', { body: { kind: 'leave' } })).status, 403);
  assert.equal((await act('alice', { kind: 'leave' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await act('alice', { kind: 'leave' }, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', '/api/me/clan/actions', null, { kind: 'leave' })).status, 401);
  const cases = [
    ['dave', { kind: 'nope' }, 400, 'bad_kind'],
    ['dave', { kind: 'create', name: 'Night Owls', tag: 'OWL', extra: 1 }, 400, 'bad_request'],
    ['dave', { kind: 'create', name: 'x', tag: 'NEW' }, 400, 'bad_name'],
    ['dave', { kind: 'create', name: 'Staff Room', tag: 'NEW' }, 400, 'bad_name'],
    ['dave', { kind: 'create', name: 'Fine Folks', tag: 'MOD' }, 400, 'bad_tag'],
    ['dave', { kind: 'create', name: 'Fine Folks', tag: '0WL' }, 409, 'tag_taken'],
    ['dave', { kind: 'create', name: 'night  owls', tag: 'NEW' }, 409, 'name_taken'],
    ['alice', { kind: 'create', name: 'Fine Folks', tag: 'NEW' }, 409, 'in_clan'],
    ['carol', { kind: 'tag', tag: 'NEW' }, 403, 'not_leader'],
    ['carol', { kind: 'kick', target: ALICE.id }, 403, 'not_leader'],
    ['dave', { kind: 'leave' }, 409, 'no_clan'],
    ['dave', { kind: 'invite', who: '@bob' }, 409, 'no_clan'],
    ['alice', { kind: 'invite', who: '@nobody' }, 404, 'no_person'],
    ['alice', { kind: 'invite', who: '@secret' }, 404, 'no_person'],
    ['alice', { kind: 'invite', who: '@alice' }, 400, 'self'],
    ['alice', { kind: 'invite', who: '@carol' }, 409, 'already_member'],
    ['alice', { kind: 'kick', target: BOB.id }, 409, 'not_member'],
    ['alice', { kind: 'leader', target: ALICE.id }, 400, 'self'],
    ['alice', { kind: 'tag', tag: 'LARK' }, 409, 'tag_taken'],
    ['alice', { kind: 'tag', tag: 'IARK' }, 409, 'tag_taken'],
    ['alice', { kind: 'colour', colour: '#123456' }, 409, 'locked'],
    ['alice', { kind: 'privacy', mode: 'secret' }, 400, 'bad_mode'],
    ['alice', { kind: 'upgrade', upgrade: 'members' }, 400, 'bad_upgrade'],
    ['alice', { kind: 'disband' }, 400, 'confirm'],
    ['dave', { kind: 'accept', clan: 'c1' }, 409, 'no_invite'],
    ['dave', { kind: 'accept', clan: 'nope' }, 400, 'bad_clan'],
  ];
  for (const [who, body, status, code] of cases) {
    const res = await read(await act(who, body));
    assert.equal(res.status, status, `${who} ${JSON.stringify(body)}`);
    assert.equal(res.body.error, code, `${who} ${JSON.stringify(body)}`);
  }
  const n = await h.db.prepare('SELECT COUNT(*) AS n FROM clan_actions').first();
  assert.equal(Number(n.n), 0, 'nothing bad was queued');
  assert.equal((await h.api('POST', '/api/me/clan/actions', cookies.alice, { kind: 'tag', tag: 'OW!' })).status, 400);
});

test('the clan owner can use reserved names on the website, nobody else can', async () => {
  const { act } = await setup({ PARTY_OWNER_ID: DAVE.id });
  const res = await read(await act('dave', { kind: 'create', name: 'YapOS Staff', tag: 'YAP' }));
  assert.equal(res.status, 202);
  assert.equal(res.body.action.status, 'pending');
  const { act: other } = await setup();
  assert.equal((await read(await other('dave', { kind: 'create', name: 'YapOS Staff', tag: 'YAP' }))).body.error, 'bad_name');
});

test('queued changes go to the bot once, results come back, and they give up after a day', async () => {
  const { h, act, view } = await setup();
  const sent = await read(await act('alice', { kind: 'invite', who: '@dave' }));
  assert.equal(sent.status, 202);
  const byId = await read(await act('alice', { kind: 'invite', who: BOB.id.toUpperCase() }));
  assert.equal(byId.status, 202);
  const third = await read(await act('alice', { kind: 'privacy', mode: 'invite' }));
  assert.equal(third.status, 202);
  const busy = await read(await act('alice', { kind: 'privacy', mode: 'open' }));
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'busy');
  assert.match(busy.body.message, new RegExp(String(CLAN_ACTIONS_OPEN)));
  const poll = await h.poll();
  assert.equal(poll.hot, true);
  assert.deepEqual(poll.clanActions.map((a) => [a.kind, a.user, a.clan, a.payload]), [
    ['invite', ALICE.id, 'c1', { target: DAVE.id }],
    ['invite', ALICE.id, 'c1', { target: BOB.id }],
    ['privacy', ALICE.id, 'c1', { mode: 'invite' }],
  ]);
  assert.deepEqual((await h.poll()).clanActions, [], 'sent actions are not handed out again right away');
  advance(h, 3 * 60 * 1000);
  assert.equal((await h.poll()).clanActions.length, 3, 'unanswered actions are sent again');
  const ids = poll.clanActions.map((a) => a.id);
  const posted = await read(await h.bot('POST', '/bot/clans/actions', { results: [
    { id: ids[0], ok: true, code: 'done', message: 'Invite sent to their DMs and their YapOS inbox.' },
    { id: ids[1], ok: false, code: 'refused', message: 'They said no thanks.' },
    { id: 'not-a-real-one', ok: true },
  ] }));
  assert.deepEqual(posted.body, { ok: true, stored: 2, ignored: ['not-a-real-one'] });
  assert.equal((await h.bot('POST', '/bot/clans/actions', { results: [] }, null)).status, 401);
  const v = await view('alice');
  assert.deepEqual(v.actions.map((a) => [a.kind, a.status]), [['privacy', 'pending'], ['invite', 'refused'], ['invite', 'done']]);
  assert.equal(v.actions[1].message, 'They said no thanks.');
  advance(h, 50 * 1000);
  assert.equal((await view('alice')).actions[0].waiting, true);
  advance(h, CLAN_ACTION_GIVE_UP);
  await h.poll();
  const gone = await view('alice');
  assert.equal(gone.actions.length, 0, 'old actions drop off the page after a day');
  const row = await h.db.prepare('SELECT status FROM clan_actions WHERE id = ?').bind(ids[2]).first();
  assert.equal(row.status, 'failed');
  advance(h, 8 * 86_400_000);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.clanActions, 3);
});

test('clan changes are rate limited per person', async () => {
  const { h, act } = await setup();
  for (let i = 0; i < LIMITS.clanActions; i++) assert.notEqual((await act('dave', { kind: 'nope' })).status, 429);
  assert.equal((await act('dave', { kind: 'nope' })).status, 429);
  advance(h, 61 * 1000);
  assert.equal((await act('dave', { kind: 'nope' })).status, 400);
});

test('people search finds public profiles by name without leaking ids, and the clan list can be browsed', async () => {
  const { h, cookies } = await setup();
  const found = await read(await h.api('GET', '/api/me/clan/people?q=@ca', cookies.alice));
  assert.deepEqual(found.body.people, [{ name: 'Carol', username: 'carol', level: 12, clan: 'OWL' }]);
  assert.equal(JSON.stringify(found.body).includes(CAROL.id), false);
  assert.deepEqual((await read(await h.api('GET', '/api/me/clan/people?q=se', cookies.alice))).body.people, [], 'hidden profiles are not found');
  assert.deepEqual((await read(await h.api('GET', '/api/me/clan/people?q=a', cookies.alice))).body.people, []);
  const all = await read(await h.request('GET', '/api/clans'));
  assert.deepEqual(all.body.clans.map((c) => c.tag), ['OWL', 'LARK']);
  assert.equal(JSON.stringify(all.body).includes(ALICE.id), false);
  assert.deepEqual((await read(await h.request('GET', '/api/clans?q=lar'))).body.clans.map((c) => c.tag), ['LARK']);
  assert.deepEqual((await read(await h.request('GET', '/api/clans?q=owls'))).body.clans.map((c) => c.tag), ['OWL']);
  await h.bot('POST', '/bot/clans', { clans: [owl({ join: 'invite' })] });
  assert.deepEqual((await read(await h.request('GET', '/api/clans?open=1'))).body.clans.map((c) => c.tag), ['LARK']);
  assert.equal((await h.request('POST', '/api/clans')).status, 405);
});

test('clan events from the bot become inbox notifications once, with names and invite answers', async () => {
  const { h, push, inbox, cookies } = await setup();
  const ev = (seq, kind, extra) => ({ seq, kind, clan: 'c1', tag: 'OWL', name: 'Night Owls', at: h.clock.t, ...extra });
  const events = [
    ev(1, 'invite', { user: DAVE.id, by: ALICE.id }),
    ev(2, 'joined', { user: BOB.id, leader: ALICE.id, via: 'web' }),
    ev(3, 'left', { user: BOB.id, leader: ALICE.id }),
    ev(4, 'kicked', { user: CAROL.id, by: ALICE.id }),
    ev(5, 'leader', { user: CAROL.id, by: ALICE.id }),
    ev(6, 'declined', { user: BOB.id, leader: ALICE.id }),
    ev(7, 'joined', { user: ALICE.id, leader: ALICE.id }),
    ev(8, 'left', { user: ALICE.id, leader: null, next: CAROL.id }),
    ev(9, 'disbanded', { by: CAROL.id, members: [CAROL.id, BOB.id, SECRET] }),
    { seq: 10, kind: 'weird', clan: 'c1', tag: 'OWL' },
  ];
  const first = await read(await push({ clans: [owl({ invites: [{ user: DAVE.id, by: ALICE.id, at: h.clock.t }] })], feed: 'feedA', events }));
  assert.equal(first.body.notes, 9);
  const titles = async (who) => (await inbox(who)).items.map((x) => x.title).reverse();
  assert.deepEqual(await titles('dave'), ['Clan invite from [OWL] Night Owls']);
  assert.deepEqual(await titles('alice'), ['Bob joined [OWL] Night Owls', 'Bob left [OWL] Night Owls', 'Bob said no thanks']);
  assert.deepEqual(await titles('carol'), ['You were removed from [OWL] Night Owls', 'You lead [OWL] Night Owls now', 'You lead [OWL] Night Owls now']);
  assert.deepEqual(await titles('bob'), ['[OWL] Night Owls was closed']);
  const secretNote = await h.db.prepare('SELECT title FROM notifications WHERE user_id = ?').bind(SECRET).first();
  assert.equal(secretNote.title, '[OWL] Night Owls was closed');
  const dave = await inbox('dave');
  assert.equal(dave.items[0].body, 'Alice invited you to join. Invites last 7 days.');
  assert.equal(dave.items[0].canAnswer, true);
  assert.equal(dave.items[0].link, '/clans');
  assert.equal(dave.unread, 1);
  const again = await read(await push({ clans: [], feed: 'feedA', events }));
  assert.equal(again.body.notes, 0, 'events already seen are skipped');
  assert.equal((await inbox('alice')).items.length, 3);
  const fresh = await read(await push({ clans: [], feed: 'feedB', events: [ev(1, 'kicked', { user: BOB.id, by: ALICE.id })] }));
  assert.equal(fresh.body.notes, 1, 'a new feed id starts counting again');
  const hidden = await read(await push({ clans: [], feed: 'feedB', events: [ev(2, 'joined', { user: SECRET, leader: ALICE.id })] }));
  assert.equal(hidden.body.notes, 1);
  assert.equal((await inbox('alice')).items[0].title, 'Someone joined [OWL] Night Owls', 'hidden profiles stay hidden in notifications');
  assert.equal((await h.api('GET', '/api/me/inbox', null)).status, 401);
  assert.equal((await h.api('GET', '/api/me/inbox', cookies.bob)).status, 200);
});

test('inbox items can be read, marked, deleted and cleared, only by their owner', async () => {
  const { h, push, inbox, cookies } = await setup();
  const events = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, kind: 'kicked', user: DAVE.id, by: ALICE.id, clan: 'c1', tag: 'OWL', name: 'Night Owls' }));
  await push({ clans: [], feed: 'f1', events });
  const list = await inbox('dave');
  assert.equal(list.unread, 5);
  const count = await read(await h.api('GET', '/api/me/inbox/count', cookies.dave));
  assert.equal(count.body.unread, 5);
  assert.equal(count.body.newest.length, 5);
  const [a, b] = list.items;
  assert.equal((await h.api('POST', '/api/me/inbox/read', cookies.dave, { ids: [a.id] }, { 'X-YapOS': null })).status, 403);
  assert.equal((await read(await h.api('POST', '/api/me/inbox/read', cookies.alice, { ids: [a.id] }))).body.unread, 0, "someone else's ids do nothing");
  const one = await read(await h.api('POST', '/api/me/inbox/read', cookies.dave, { ids: [a.id] }));
  assert.equal(one.body.unread, 4);
  assert.equal((await read(await h.api('POST', '/api/me/inbox/read', cookies.dave, { ids: [a.id], unread: true }))).body.unread, 5);
  assert.equal((await h.api('POST', '/api/me/inbox/read', cookies.dave, {})).status, 400);
  assert.equal((await h.api('DELETE', `/api/me/inbox/${b.id}`, cookies.alice)).status, 404);
  const del = await read(await h.api('DELETE', `/api/me/inbox/${b.id}`, cookies.dave));
  assert.equal(del.body.unread, 4);
  assert.equal((await h.api('DELETE', `/api/me/inbox/${b.id}`, cookies.dave)).status, 404);
  const all = await read(await h.api('POST', '/api/me/inbox/read', cookies.dave, { all: true }));
  assert.equal(all.body.unread, 0);
  assert.equal((await inbox('dave')).items.every((x) => x.read), true);
  const cleared = await read(await h.api('POST', '/api/me/inbox/clear', cookies.dave, {}));
  assert.equal(cleared.body.removed, 4);
  assert.equal((await inbox('dave')).items.length, 0);
  assert.equal((await h.api('PUT', '/api/me/inbox', cookies.dave, {})).status, 405);
});

test('the inbox is paged, keeps at most 200 items per person and forgets them after 90 days', async () => {
  const { h, push, inbox } = await setup();
  for (let round = 0; round < 3; round++) {
    const events = Array.from({ length: 90 }, (_, i) => ({ seq: round * 90 + i + 1, kind: 'kicked', user: DAVE.id, by: ALICE.id, clan: 'c1', tag: 'OWL', name: 'Night Owls' }));
    await push({ clans: [], feed: 'f1', events });
    advance(h, 1000);
  }
  const n = await h.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').bind(DAVE.id).first();
  assert.equal(Number(n.n), INBOX_MAX);
  const page = await inbox('dave');
  assert.equal(page.items.length, 30);
  assert.equal(page.more, true);
  const next = await inbox('dave', `?before=${page.next}`);
  assert.ok(next.items.length > 0);
  assert.ok(next.items.every((x) => x.created < page.next));
  advance(h, INBOX_KEEP + 1);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.notifications, INBOX_MAX);
});

test('answering an invite in the inbox queues it for the bot once', async () => {
  const { h, push, inbox, cookies, view } = await setup();
  await push({ clans: [owl({ invites: [{ user: DAVE.id, by: ALICE.id, at: h.clock.t }] })], feed: 'f1', events: [{ seq: 1, kind: 'invite', user: DAVE.id, by: ALICE.id, clan: 'c1', tag: 'OWL', name: 'Night Owls' }] });
  const item = (await inbox('dave')).items[0];
  assert.equal((await h.api('POST', `/api/me/inbox/${item.id}/answer`, cookies.alice, { answer: 'accept' })).status, 404);
  assert.equal((await h.api('POST', `/api/me/inbox/${item.id}/answer`, cookies.dave, { answer: 'maybe' })).status, 400);
  const ok = await read(await h.api('POST', `/api/me/inbox/${item.id}/answer`, cookies.dave, { answer: 'accept' }));
  assert.equal(ok.status, 202);
  assert.equal((await h.api('POST', `/api/me/inbox/${item.id}/answer`, cookies.dave, { answer: 'decline' })).status, 409);
  const after = (await inbox('dave')).items[0];
  assert.equal(after.read, true);
  assert.equal(after.canAnswer, false);
  assert.equal(after.answer.status, 'pending');
  const { clanActions } = await h.poll();
  assert.deepEqual(clanActions.map((a) => [a.kind, a.user, a.clan, a.payload]), [['accept', DAVE.id, 'c1', { clan: 'c1' }]]);
  await h.bot('POST', '/bot/clans/actions', { results: [{ id: clanActions[0].id, ok: true, message: 'You joined [OWL] Night Owls!' }] });
  const done = (await inbox('dave')).items[0];
  assert.deepEqual(done.answer, { id: clanActions[0].id, status: 'done', message: 'You joined [OWL] Night Owls!' });
  assert.deepEqual((await view('dave')).invites, [], 'the accepted invite is cleared');
  const notInvite = await h.db.prepare("INSERT INTO notifications (id, user_id, kind, title, body, data, created, read_at) VALUES ('n-gift-1', ?, 'gift', 'Gift', NULL, NULL, ?, NULL)").bind(DAVE.id, h.clock.t).run();
  assert.ok(notInvite);
  assert.equal((await h.api('POST', '/api/me/inbox/n-gift-1/answer', cookies.dave, { answer: 'accept' })).status, 400);
  advance(h, CLAN_INVITE_TTL + 1);
  await cleanup(h.db, h.clock.t);
  assert.equal(Number((await h.db.prepare('SELECT COUNT(*) AS n FROM clan_invites').first()).n), 0);
});

test('refused web joins and owner gifts, badges and achievements land in the inbox', async () => {
  const { h, cookies, inbox, push } = await setup({ PARTY_OWNER_ID: BOB.id });
  await push({ clans: [owl({ join: 'open' })] });
  const sent = await read(await h.api('POST', '/api/clans/LARK/join', cookies.dave));
  const { clanJoins } = await h.poll();
  await h.bot('POST', '/bot/clans/joins', { results: [{ id: clanJoins[0].id, ok: false, code: 'invite_only', message: '[LARK] Day Larks is invite only now.' }] });
  assert.ok(sent.body.request.id);
  const refused = (await inbox('dave')).items[0];
  assert.equal(refused.kind, 'clan_refused');
  assert.equal(refused.title, "You couldn't join [LARK]");
  assert.equal(refused.body, '[LARK] Day Larks is invite only now.');
  await h.bot('POST', '/bot/owner/catalog', { achievements: [{ id: 'chat100', label: 'Chatterbox', emoji: '💬' }], badges: [{ id: 'vip', label: 'VIP', emoji: '⭐' }] });
  const give = async (body) => (await read(await h.api('POST', '/api/owner/actions', cookies.bob, { user: DAVE.id, ...body }))).body.action.id;
  const ids = [await give({ kind: 'shards.add', value: 2500 }), await give({ kind: 'badge.grant', id: 'vip' }), await give({ kind: 'achievement.grant', id: 'chat100' }), await give({ kind: 'shards.remove', value: 5 })];
  await h.poll();
  await h.bot('POST', '/bot/owner/results', { results: ids.map((id) => ({ id, ok: true, message: 'Done.' })) });
  const items = (await inbox('dave')).items.filter((x) => x.kind !== 'clan_refused');
  assert.deepEqual(items.map((x) => [x.kind, x.title]).sort(), [
    ['achievement', 'New achievement: 💬 Chatterbox'],
    ['badge', 'New badge: ⭐ VIP'],
    ['gift', 'You got 2,500 💎 Shards'],
  ]);
  await h.bot('POST', '/bot/owner/results', { results: ids.map((id) => ({ id, ok: true })) });
  assert.equal((await inbox('dave')).items.length, 4, 'a repeated result does not notify twice');
});

test('party warnings show on the inbox page', async () => {
  const { h, inbox } = await setup();
  await h.db.prepare('INSERT INTO party_warnings (id, user_id, author_id, author_name, text, created, seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)').bind('w1', DAVE.id, ALICE.id, 'Staff Sam', 'Please keep it friendly.', h.clock.t).run();
  const body = await inbox('dave');
  assert.deepEqual(body.warnings.map((w) => [w.by, w.text]), [['Staff Sam', 'Please keep it friendly.']]);
  assert.equal(body.unread, 0, 'warnings are listed but not counted as unread notifications');
});

test('YapOS Party learns the unread inbox count with its warnings poll and shows a notice', async () => {
  const { createActivitySession } = await import('../worker/activity-auth.js');
  const { inboxNotice } = await import('../web/activity/js/ui/warning.js');
  const { h, push } = await setup();
  await push({ clans: [], feed: 'f1', events: [{ seq: 1, kind: 'kicked', user: DAVE.id, by: ALICE.id, clan: 'c1', tag: 'OWL', name: 'Night Owls' }] });
  const token = await createActivitySession(h.db, DAVE, h.clock.t);
  const res = await read(await h.request('GET', `/api/activity/warnings?for=${DAVE.id}`, { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.inbox, 1);
  assert.match(inboxNotice(null, 1), /1 unread in your YapOS inbox/);
  assert.equal(inboxNotice(1, 1), null);
  assert.match(inboxNotice(1, 2), /Something new/);
  assert.equal(inboxNotice(null, 0), null);
});
