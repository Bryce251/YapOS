import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.js';
import { createHarness as createBotHarness, IDS } from '../../test/harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const read = async (res) => ({ status: res.status, body: await res.json() });
const person = (id, username) => ({ id, username, display_name: username[0].toUpperCase() + username.slice(1), avatar_url: null });

async function setup() {
  const w = createHarness({ PARTY_OWNER_ID: IDS.owner });
  const b = await createBotHarness({ apps: ['economy', 'levels', 'clans'], fakeClock: true });
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('CF-Connecting-IP', '203.0.113.9');
    return w.worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), w.env, { waitUntil() {} });
  };
  const dash = createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  const cookies = {};
  for (const [k, id] of Object.entries({ sam: IDS.member, kim: IDS.member2, ada: IDS.admin, own: IDS.owner })) cookies[k] = (await w.login(person(id, k))).cookie;
  const eco = b.engine.service('economy');
  const clans = b.engine.service('clans');
  const act = async (who, body) => read(await w.api('POST', '/api/me/clan/actions', cookies[who], body));
  const view = async (who) => (await read(await w.api('GET', '/api/me/clan', cookies[who]))).body;
  const inbox = async (who) => (await read(await w.api('GET', '/api/me/inbox', cookies[who]))).body;
  const cycle = async () => {
    const { clanActions } = await w.poll();
    const out = await dash.applyClanActions(clanActions);
    await dash.syncClans();
    return out;
  };
  return { w, b, dash, cookies, eco, clans, act, view, inbox, cycle };
}

test('a clan is created, run and closed from the website with the bot checking every step', async () => {
  const { w, b, cookies, eco, clans, act, view, inbox, cycle } = await setup();
  eco.add(GLOBAL_KEY, IDS.member, 600, 'Test funds');

  assert.equal((await act('sam', { kind: 'create', name: 'Night Owls', tag: 'OWL' })).status, 202);
  assert.equal((await act('kim', { kind: 'create', name: 'Sky Kites', tag: 'KITE' })).status, 202);
  assert.deepEqual(await cycle(), { applied: 2, posted: 2 });
  assert.equal(clans.of(IDS.member).tag, 'OWL');
  assert.equal(eco.balance(GLOBAL_KEY, IDS.member), 100, 'the bot took the create cost');
  assert.equal(clans.of(IDS.member2), null);
  const samView = await view('sam');
  assert.equal(samView.clan.tag, 'OWL');
  assert.equal(samView.clan.leader, true);
  assert.equal(samView.actions.find((a) => a.kind === 'create').status, 'done');
  const kimView = await view('kim');
  const refused = kimView.actions.find((a) => a.kind === 'create');
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /Not enough Shards/);

  assert.equal((await act('sam', { kind: 'invite', who: IDS.member2 })).status, 202);
  await cycle();
  const invite = (await inbox('kim')).items.find((x) => x.kind === 'clan_invite');
  assert.ok(invite, 'the invite reached the inbox');
  assert.equal(invite.title, 'Clan invite from [OWL] Night Owls');
  assert.equal(invite.canAnswer, true);
  assert.deepEqual((await view('kim')).invites.map((x) => x.clan.tag), ['OWL']);
  assert.deepEqual((await view('sam')).clan.invites.map((x) => x.id), [IDS.member2]);
  assert.equal((await w.api('POST', `/api/me/inbox/${invite.id}/answer`, cookies.kim, { answer: 'accept' })).status, 202);
  await cycle();
  assert.equal(clans.of(IDS.member2).tag, 'OWL');
  assert.equal((await inbox('kim')).items.find((x) => x.id === invite.id).answer.status, 'done');
  assert.ok((await inbox('sam')).items.some((x) => x.kind === 'clan_joined' && x.title.endsWith('joined [OWL] Night Owls')));

  eco.add(GLOBAL_KEY, IDS.admin, 600, 'Test funds');
  await b.slash('clan', 'create Day Larks LRK', { user: IDS.admin });
  assert.equal((await act('sam', { kind: 'tag', tag: 'IRK' })).status, 202, 'the Worker has not heard of [LRK] yet');
  await cycle();
  const tagTry = (await view('sam')).actions.find((a) => a.kind === 'tag');
  assert.equal(tagTry.status, 'refused');
  assert.match(tagTry.message, /tag is taken/);
  assert.equal(clans.of(IDS.member).tag, 'OWL');
  assert.equal((await act('sam', { kind: 'tag', tag: 'IRK' })).body.error, 'tag_taken', 'now the Worker knows the look-alike too');

  assert.equal((await act('sam', { kind: 'colour', colour: 'teal' })).body.error, 'locked');
  assert.equal((await act('sam', { kind: 'upgrade', upgrade: 'style' })).status, 202);
  await cycle();
  assert.match((await view('sam')).actions.find((a) => a.kind === 'upgrade').message, /not enough in the bank/i);
  eco.add(GLOBAL_KEY, IDS.member, 2000, 'Test funds');
  await b.slash('clan', 'deposit 1500', { user: IDS.member });
  assert.equal((await act('sam', { kind: 'upgrade', upgrade: 'style' })).status, 202);
  await cycle();
  const styled = await view('sam');
  assert.equal(styled.clan.style, true);
  assert.equal(styled.clan.bank, 0);
  assert.equal((await act('sam', { kind: 'colour', colour: 'teal' })).status, 202);
  assert.equal((await act('sam', { kind: 'banner', text: 'Hoot hoot' })).status, 202);
  assert.equal((await act('sam', { kind: 'privacy', mode: 'invite' })).status, 202);
  await cycle();
  const look = (await view('sam')).clan;
  assert.deepEqual([look.colour, look.banner, look.join], ['#1abc9c', 'Hoot hoot', 'invite']);
  assert.equal(b.engine.service('clans').get(clans.of(IDS.member).id).join, 'invite');

  assert.equal((await act('sam', { kind: 'leader', target: IDS.member2 })).status, 202);
  await cycle();
  assert.equal(clans.of(IDS.member2).leader, true);
  assert.ok((await inbox('kim')).items.some((x) => x.kind === 'clan_leader'));
  assert.equal((await act('sam', { kind: 'tag', tag: 'HOOT' })).body.error, 'not_leader');
  const sneaky = await clans.webAction(IDS.member, 'tag', clans.of(IDS.member).id, { tag: 'HOOT' });
  assert.equal(sneaky.ok, false, 'the bot checks the leader again');
  assert.equal(sneaky.code, 'not_leader');

  assert.equal((await act('kim', { kind: 'kick', target: IDS.member })).status, 202);
  await cycle();
  assert.equal(clans.of(IDS.member), null);
  assert.ok((await inbox('sam')).items.some((x) => x.kind === 'clan_kicked' && x.title === 'You were removed from [OWL] Night Owls'));

  assert.equal((await act('ada', { kind: 'leave' })).status, 202);
  assert.equal((await act('kim', { kind: 'disband', confirm: true })).status, 202);
  await cycle();
  assert.equal(clans.of(IDS.admin), null);
  assert.equal(clans.of(IDS.member2), null);
  assert.equal((await view('kim')).clan, null);
  assert.equal((await w.request('GET', '/api/clans/OWL')).status, 404);
  assert.equal((await w.request('GET', '/api/clans/LRK')).status, 404);
  assert.match((await view('ada')).actions.find((a) => a.kind === 'leave').message, /closed/i);
});

test('the bot refuses reserved names and stale web requests even if the Worker let them through', async () => {
  const { b, eco, clans } = await setup();
  eco.add(GLOBAL_KEY, IDS.member, 600, 'Test funds');
  const staff = await clans.webAction(IDS.member, 'create', null, { name: 'YapOS Staff', tag: 'YAP' });
  assert.equal(staff.ok, false);
  assert.match(staff.message, /isn't allowed/);
  b.engine.service('economy').add(GLOBAL_KEY, IDS.owner, 600, 'Test funds');
  const own = await clans.webAction(IDS.owner, 'create', null, { name: 'YapOS Staff', tag: 'YAP' });
  assert.equal(own.ok, true, own.message);
  assert.equal((await clans.webAction(IDS.member, 'accept', null, { clan: clans.of(IDS.owner).id })).ok, false, 'no invite, no join');
  assert.equal((await clans.webAction(IDS.member, 'leave', null, {})).code, 'no_clan');
  assert.equal((await clans.webAction(IDS.owner, 'kick', clans.of(IDS.owner).id, { target: IDS.member })).code, 'not_member');
  assert.equal((await clans.webAction(IDS.owner, 'tag', 'c999', { tag: 'NEW' })).code, 'changed');
  assert.equal((await clans.webAction(IDS.owner, 'explode', null, {})).ok, false);
  assert.equal((await clans.webAction('', 'leave', null, {})).ok, false);
  const invited = await clans.webAction(IDS.owner, 'invite', clans.of(IDS.owner).id, { target: IDS.member });
  assert.equal(invited.ok, true, invited.message);
  const no = await clans.webAction(IDS.member, 'decline', null, { clan: clans.of(IDS.owner).id });
  assert.equal(no.ok, true);
  const again = await clans.webAction(IDS.owner, 'invite', clans.of(IDS.owner).id, { target: IDS.member });
  assert.equal(again.ok, false, 'someone who said no thanks is not asked again this week');
  assert.match(again.message, /no thanks/i);
  const feed = clans.feed();
  assert.deepEqual(feed.events.map((e) => e.kind), ['invite', 'declined']);
  assert.ok(feed.id);
});

test('the clan feed survives a bot restart without notifying twice', async () => {
  const { w, b, eco, clans, inbox, cycle, act } = await setup();
  eco.add(GLOBAL_KEY, IDS.member, 600, 'Test funds');
  await act('sam', { kind: 'create', name: 'Night Owls', tag: 'OWL' });
  await cycle();
  await act('sam', { kind: 'invite', who: IDS.member2 });
  await cycle();
  assert.equal((await inbox('kim')).items.length, 1);
  const fetch = async (url, init = {}) => w.worker.fetch(new Request(url, { method: init.method, headers: new Headers(init.headers || {}), body: init.body }), w.env, { waitUntil() {} });
  const fresh = createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  await fresh.syncClans();
  assert.equal((await inbox('kim')).items.length, 1, 'events already sent are not sent as new notifications');
  assert.deepEqual(clans.feed().events.map((e) => e.kind), ['invite']);
});
