import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { devBadgePng } from '../dev.mjs';
import { cleanName } from '../worker/custom-badges.js';
import { FOUNDER_BADGE, FOUNDER_ONLY, withoutFounder, specialBadgesFirst, badgeTier } from '../worker/party-badges.js';
import { readUser } from '../web/js/pages/owner.js';
import { BADGES, ACHIEVEMENTS } from '../web/js/community-data.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;

const CATALOG = {
  achievements: [{ id: 'clanfound', label: 'Clan founder', emoji: '\u{1F6E1}\u{FE0F}', reward: 50 }],
  badges: [{ id: 'founder', label: 'Founder', emoji: '\u{1F531}' }, { id: 'vip', label: 'VIP', emoji: '\u{1F3A9}' }],
};

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  const bob = (await h.login(BOB)).cookie;
  await h.bot('POST', '/bot/owner/catalog', CATALOG);
  return { h, owner, bob };
}

async function give(h, cookie, body) {
  const res = await h.api('POST', '/api/owner/actions', cookie, body);
  return { status: res.status, body: await res.json() };
}

const snap = (id, username, badges) => ({ id, username, name: username, level: 1, xp: 10, shards: null, badges, achievements: [], season: [], clan: null, hidden: false });

test('the clan achievement reads Clan founder and the Founder badge is special and sorted first', () => {
  assert.equal(ACHIEVEMENTS.clanfound.label, 'Clan founder');
  assert.deepEqual(BADGES.founder, { label: 'Founder', emoji: '\u{1F531}', note: 'The owner of YapOS. Only Jolli has it' });
  assert.equal(badgeTier('founder'), 'special');
  assert.deepEqual(specialBadgesFirst(['first-game', 'c-abcdefgh', 'einstein', 'founder']), ['founder', 'c-abcdefgh', 'einstein', 'first-game']);
  assert.equal(FOUNDER_BADGE, 'founder');
  assert.deepEqual(withoutFounder(['founder', 'vip'], false), ['vip']);
  assert.deepEqual(withoutFounder(['founder', 'vip'], true), ['founder', 'vip']);
});

test('the owner panel refuses to give the Founder badge to anyone but the owner', async () => {
  const { h, owner } = await setup();
  const res = await give(h, owner, { user: BOB.id, kind: 'badge.grant', id: 'founder' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /Only Jolli can have the Founder badge\./);
  assert.equal(FOUNDER_ONLY, 'Only Jolli can have the Founder badge.');
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM owner_actions WHERE ref = 'founder'").get().n, 0);
  const vip = await give(h, owner, { user: BOB.id, kind: 'badge.grant', id: 'vip' });
  assert.equal(vip.status, 201);
  const take = await give(h, owner, { user: BOB.id, kind: 'badge.revoke', id: 'founder' });
  assert.equal(take.status, 201, 'taking it away from someone else still works');
});

test('the owner can give the Founder badge to their own account', async () => {
  const { h, owner } = await setup();
  const res = await give(h, owner, { user: OWNER.id, kind: 'badge.grant', id: 'founder' });
  assert.equal(res.status, 201);
  assert.equal(res.body.action.ref, 'founder');
  const me = await (await h.api('GET', `/api/owner/users/${OWNER.id}`, owner)).json();
  assert.equal(me.user.isOwner, true);
  assert.equal(readUser(me.user).isOwner, true);
  const bob = await (await h.api('GET', `/api/owner/users/${BOB.id}`, owner)).json();
  assert.equal(bob.user.isOwner, false);
  assert.equal(readUser(bob.user).isOwner, false);
});

test('the Founder badge is stripped from anyone else when profiles or results come in', async () => {
  const { h, owner } = await setup();
  const up = await h.bot('POST', '/bot/profiles', { profiles: [snap(OWNER.id, 'jolli', ['founder', 'vip']), snap(BOB.id, 'bob', ['founder', 'vip'])] });
  assert.equal(up.status, 200);
  const stored = (id) => JSON.parse(h.db.raw.prepare('SELECT badges FROM public_profiles WHERE user_id = ?').get(id.toLowerCase()).badges);
  assert.deepEqual(stored(OWNER.id), ['founder', 'vip']);
  assert.deepEqual(stored(BOB.id), ['vip']);
  const a = await give(h, owner, { user: BOB.id, kind: 'xp.add', value: 5 });
  await h.poll();
  await h.bot('POST', '/bot/owner/results', { results: [{ id: a.body.action.id, ok: true, message: 'Added 5 XP.', after: { badges: ['founder', 'supporter'] } }] });
  assert.deepEqual(stored(BOB.id), ['supporter']);
});

test('a custom badge can never be named Founder', async () => {
  for (const name of ['Founder', 'founder', 'FOUNDER', ' Found er! ']) {
    assert.throws(() => cleanName(name), (e) => e.status === 400 && e.code === 'reserved_name', name);
  }
  assert.equal(cleanName('Clan founder'), 'Clan founder');
  const { h, owner } = await setup();
  const image = `data:image/png;base64,${Buffer.from(devBadgePng(32)).toString('base64')}`;
  const made = await h.api('POST', '/api/owner/badges', owner, { name: 'founder', image });
  assert.equal(made.status, 400);
  assert.match(JSON.stringify(await made.json()), /Founder is only for Jolli/);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM custom_badges').get().n, 0);
});

const LOOKALIKE_NAMES = ['F0under', 'Fоunder', 'Ｆｏｕｎｄｅｒ', '\u{1D405}\u{1D428}\u{1D42E}\u{1D427}\u{1D41D}\u{1D41E}\u{1D42B}', 'Fóunder', 'Foun​der', 'ꜰᴏᴜɴᴅᴇʀ', 'Founder ', 'F o u n d e r', 'The Founder', 'Founders', 'Fooounder', 'FOUNDΕR', 'F0UND3R'];

test('a custom badge can not use a look-alike of Founder when made or renamed', async () => {
  for (const name of LOOKALIKE_NAMES) {
    assert.throws(() => cleanName(name), (e) => e.status === 400 && e.code === 'reserved_name', name);
  }
  for (const name of ['Clan founder', 'Co-founder', 'Foundry', 'Sounder', 'Fund']) assert.equal(cleanName(name), name);
  const { h, owner } = await setup();
  const image = `data:image/png;base64,${Buffer.from(devBadgePng(32)).toString('base64')}`;
  const made = await h.api('POST', '/api/owner/badges', owner, { name: 'Fоunder', image });
  assert.equal(made.status, 400);
  const ok = await h.api('POST', '/api/owner/badges', owner, { name: 'Builder', image });
  assert.equal(ok.status, 201);
  const { badge } = await ok.json();
  const renamed = await h.api('PATCH', `/api/owner/badges/${badge.id}`, owner, { name: 'F0under' });
  assert.equal(renamed.status, 400);
  assert.match(JSON.stringify(await renamed.json()), /Founder is only for Jolli/);
  assert.equal(h.db.raw.prepare('SELECT name FROM custom_badges WHERE id = ?').get(badge.id).name, 'Builder');
});
