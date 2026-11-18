import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS, advance } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { dayKey } from '../web/activity/js/daily.js';
import { monthOf, prevMonth, pointsStatements } from '../worker/party-leaderboard.js';
import { HIDDEN_NAME, maskEntry, hintOf, hiddenNameMap } from '../worker/hidden-names.js';
import { staffBlock } from '../worker/staff-profile.js';
import { resetPlan } from '../worker/profile-custom.js';

const OWNER = USERS.alice;
const ADMIN = USERS.bob;
const ADMIN2 = { id: '55555555-5555-4555-8555-555555555555', username: 'cleo', display_name: 'Cleo', avatar_url: null };
const REX = { id: '66666666-6666-4666-8666-666666666666', username: 'rexy', display_name: 'Rex Realname', avatar_url: null };
const NOBODY = { id: '88888888-8888-4888-8888-888888888888', username: 'nina', display_name: 'Nina', avatar_url: null };
const LOOK = '/api/me/profile-look';
const BANNER = '/api/me/profile-banner';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const profileUrl = (id, ...rest) => `/api/party/profile/${id}${rest.map((r) => `/${r}`).join('')}`;
let ipN = 10;
const ip = () => `203.0.113.${(ipN = (ipN % 200) + 1)}`;

function seedPerson(h, user, { level = 5 } = {}) {
  const t = h.clock.t;
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, 400, NULL, ?, '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(user.id, user.username, user.username.toLowerCase(), user.display_name, level, JSON.stringify(['vip', 'supporter']), t);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT (id) DO NOTHING').run(user.id, user.username, user.display_name, t);
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, '{}', '{}', ?) ON CONFLICT (user_id) DO NOTHING").run(user.id, t);
}

function seedBoards(h, user) {
  const t = h.clock.t;
  h.db.raw.prepare("INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, 900, 5, 2, 300, 'trivia', ?)").run(user.id, user.display_name, user.username, t);
  h.db.raw.prepare("INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) VALUES (?, 'trivia', 900, 5, 2, 300, ?)").run(user.id, t);
  h.db.raw.prepare("INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) VALUES (?, ?, 400, 2, 1, 300, 'trivia', ?)").run(user.id, monthOf(t), t);
  h.db.raw.prepare("INSERT INTO party_daily_scores (day, kind, user_id, name, username, score, ms, at) VALUES (?, 'hive', ?, ?, ?, 40, 90000, ?)").run(dayKey(t), user.id, user.display_name, user.username, t);
  h.db.raw.prepare('INSERT INTO season_history (month, boards, updated) VALUES (?, ?, ?)').run(prevMonth(monthOf(t)), JSON.stringify({ xp: [{ id: user.id, rank: 1, name: user.display_name, username: user.username, value: 5000 }], shards: [] }), t);
  h.db.raw.prepare("INSERT INTO global_board (id, data, updated) VALUES ('global', ?, ?)").run(JSON.stringify({ levels: [{ id: user.id, rank: 1, name: user.display_name, username: user.username, level: 9, xp: 9000 }], economy: [{ id: user.id, rank: 1, name: user.display_name, balance: 50 }], updatedAt: t }), t);
  h.db.raw.prepare("INSERT INTO party_packs (code, owner_id, name, words, trivia, created, updated) VALUES ('REXPACK1', ?, 'Rex words', ?, '[]', ?, ?)").run(user.id, JSON.stringify(['apple', 'banana', 'cherry', 'grape', 'lemon', 'mango', 'melon', 'peach', 'pear', 'plum']), t, t);
  h.db.raw.prepare("INSERT INTO pack_public (code, public, blocked, published, updated) VALUES ('REXPACK1', 1, 0, ?, ?)").run(t, t);
}

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  for (const u of [OWNER, ADMIN, ADMIN2, REX, NOBODY]) seedPerson(h, u);
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, 1), (?, ?, 1)').run(ADMIN.id, OWNER.id, ADMIN2.id, OWNER.id);
  const owner = (await h.login(OWNER)).cookie;
  const admin = (await h.login(ADMIN)).cookie;
  const admin2 = (await h.login(ADMIN2)).cookie;
  const rex = (await h.login(REX)).cookie;
  const nobody = (await h.login(NOBODY)).cookie;
  return { h, owner, admin, admin2, rex, nobody };
}

async function fullLook(h, cookie) {
  const put = await h.api('PUT', LOOK, cookie, { bio: 'Rex bio', status: 'Drawing', statusEmoji: '\u{1F3A8}', pronouns: 'he/him', nameColour: '#ff3366', nameFont: 'serif', pins: ['vip'], accent: '#7c5cff', ring: 'gold' });
  assert.equal(put.status, 200, await put.clone().text());
  const up = await h.api('POST', BANNER, cookie, { image: b64(devBannerPng()) });
  assert.equal(up.status, 201);
  return (await up.json()).banner.url;
}

async function own(h, cookie) {
  return (await (await h.api('GET', LOOK, cookie)).json()).look;
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

test('only signed-in staff reach the staff profile tools, with CSRF and the admin rules', async () => {
  const { h, owner, admin, admin2, nobody } = await setup();
  assert.equal((await h.api('GET', profileUrl(REX.id))).status, 401, 'signed out');
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'))).status, 401, 'signed out mutating');
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), undefined, undefined, { Origin: null })).status, 403, 'signed out without the right origin');
  assert.equal((await h.api('GET', profileUrl(REX.id), nobody)).status, 403, 'not staff');
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), nobody)).status, 403);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), nobody, { what: 'name' })).status, 403);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), admin, undefined, { 'X-YapOS': null })).status, 403, 'CSRF header missing');
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name' }, { Origin: 'https://evil.example' })).status, 403, 'wrong origin');
  const view = await json(await h.api('GET', profileUrl(REX.id), admin));
  assert.equal(view.status, 200);
  assert.equal(view.body.canAct, true);
  assert.equal(view.body.person.name, 'Rex Realname');
  const onOwner = await json(await h.api('DELETE', profileUrl(OWNER.id, 'look', 'bio'), admin));
  assert.deepEqual([onOwner.status, onOwner.body.error], [403, 'is_owner']);
  const onAdmin = await json(await h.api('POST', profileUrl(ADMIN2.id, 'hide'), admin, { what: 'name' }));
  assert.deepEqual([onAdmin.status, onAdmin.body.error], [403, 'is_admin']);
  const onSelf = await json(await h.api('DELETE', profileUrl(ADMIN.id, 'hide', 'name'), admin));
  assert.deepEqual([onSelf.status, onSelf.body.error], [403, 'is_self']);
  const adminView = await json(await h.api('GET', profileUrl(ADMIN2.id), admin));
  assert.equal(adminView.body.canAct, false, 'admins can look but not act on other admins');
  assert.match(adminView.body.why, /Ask the owner/);
  assert.equal((await h.api('POST', profileUrl(ADMIN2.id, 'hide'), owner, { what: 'username' })).status, 200, 'the owner can act on admins');
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin2, { what: 'nope' })).status, 400);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin2, { what: 'name', extra: 1 })).status, 400);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'everything'), admin2)).status, 404);
  assert.equal((await h.api('GET', profileUrl(REX.id, 'look', 'bio'), admin2)).status, 405);
  assert.equal(staffBlock('owner', OWNER.id, OWNER.id, 'owner'), null);
  assert.equal(staffBlock(null, NOBODY.id, REX.id, null).code, 'staff_only');
});

test('each reset clears exactly its own part of the look', async () => {
  const { h, rex, admin } = await setup();
  const parts = {
    bio: (l) => ({ ...l, bio: '' }),
    status: (l) => ({ ...l, status: '', statusEmoji: '' }),
    pronouns: (l) => ({ ...l, pronouns: '' }),
    'name-style': (l) => ({ ...l, nameColour: null, nameGradient: null, nameFont: 'default', colours: { ...l.colours, name: null } }),
    pins: (l) => ({ ...l, pins: [] }),
  };
  for (const [part, expect] of Object.entries(parts)) {
    await fullLook(h, rex);
    const before = await own(h, rex);
    const res = await json(await h.api('DELETE', profileUrl(REX.id, 'look', part), admin));
    assert.equal(res.status, 200, part);
    assert.equal(res.body.reset, part);
    assert.deepEqual(await own(h, rex), expect(before), part);
    assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', part), admin)).status, 404, `${part} twice has nothing left`);
    advance(h, 61_000);
  }
  const url = await fullLook(h, rex);
  const before = await own(h, rex);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'banner'), admin)).status, 200);
  assert.deepEqual(await own(h, rex), { ...before, banner: 'none', bannerImage: null });
  assert.equal((await h.request('GET', url)).status, 404, 'the picture is gone');
  advance(h, 61_000);
  await fullLook(h, rex);
  const all = await json(await h.api('DELETE', profileUrl(REX.id, 'look', 'all'), admin));
  assert.equal(all.status, 200);
  assert.equal(all.body.look.custom, false);
  assert.equal(all.body.look.banner, null);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_custom WHERE user_id = ?').get(REX.id).n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_banners WHERE user_id = ?').get(REX.id).n, 0);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'all'), admin)).status, 404);
  assert.equal(resetPlan(null, REX.id, 'bogus', { look: {}, banner: null }, 'Rex', 1), null);
});

test('resets are written to the mod log under shared names that admins can read, the owner included', async () => {
  const { h, rex, admin, owner, admin2 } = await setup();
  await fullLook(h, rex);
  const steps = [
    ['DELETE', profileUrl(REX.id, 'look', 'banner'), owner],
    ['DELETE', profileUrl(REX.id, 'look', 'status'), admin],
    ['DELETE', profileUrl(REX.id, 'look', 'name-style'), admin],
    ['DELETE', profileUrl(REX.id, 'look', 'pins'), owner],
    ['DELETE', profileUrl(REX.id, 'look', 'all'), owner],
    ['POST', profileUrl(REX.id, 'hide'), owner, { what: 'name', reason: 'Rude name' }],
  ];
  for (const [method, path, cookie, body] of steps) {
    advance(h, 1000);
    assert.equal((await h.api(method, path, cookie, body)).status, 200, path);
  }
  const log = (await json(await h.api('GET', '/api/party/modlog', admin2))).body;
  const actions = log.entries.map((e) => e.action).reverse();
  assert.deepEqual(actions, ['profile_banner_remove', 'profile_text_clear', 'profile_name_style_reset', 'profile_pins_clear', 'profile_reset', 'name_hide']);
  assert.ok(actions.every((a) => !a.startsWith('owner_')));
  const text = log.entries.find((e) => e.action === 'profile_text_clear');
  assert.deepEqual(text.detail.fields, ['status']);
  assert.equal(text.target.name, 'Rex Realname', 'staff see the real name in the mod log');
  assert.deepEqual(text.target.hiddenNames, { name: true, username: false });
  assert.equal(log.entries.find((e) => e.action === 'name_hide').detail.reason, 'Rude name');
});

test('every reset is rate limited per staff member', async () => {
  const { h, admin, admin2 } = await setup();
  let last = null;
  for (let i = 0; i < 31; i += 1) last = await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), admin);
  assert.equal(last.status, 429);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), admin2)).status, 404, 'another admin has their own budget');
});

const PUBLIC_ENDPOINTS = Object.freeze([
  ['public profile', () => `/api/u/${REX.username}`],
  ['global leaderboard', () => '/api/public/global'],
  ['party leaderboard', () => '/api/activity/leaderboard'],
  ['party wins board', () => '/api/activity/leaderboard?board=wins'],
  ['party trivia board', () => '/api/activity/leaderboard?game=trivia'],
  ['monthly board', () => '/api/activity/leaderboard?period=month'],
  ['party profile card', () => `/api/activity/profile/${REX.id}`],
  ['daily top', () => '/api/activity/daily/top?kind=hive'],
  ['season history', () => '/api/seasons'],
  ['profile lookup', () => `/api/activity/profiles?ids=${REX.id}`],
  ['pack browser', () => '/api/packs/browse'],
]);

async function publicBodies(h) {
  const out = {};
  for (const [label, path] of PUBLIC_ENDPOINTS) {
    const res = await h.request('GET', path(), { ip: ip() });
    assert.equal(res.status, 200, `${label}: ${res.status}`);
    out[label] = await res.text();
  }
  return out;
}

test('a hidden display name is replaced on every public endpoint, and unhiding brings it back', async () => {
  const { h, admin } = await setup();
  seedBoards(h, REX);
  const shown = await publicBodies(h);
  for (const [label, text] of Object.entries(shown)) {
    if (label === 'pack browser') assert.ok(text.includes(REX.username), label);
    else assert.ok(text.includes(REX.display_name), `${label} shows the name before hiding`);
  }
  const hid = await json(await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name', reason: 'Rude' }));
  assert.equal(hid.status, 200);
  assert.equal(hid.body.hidden.name.reason, 'Rude');
  advance(h, 31_000);
  const hidden = await publicBodies(h);
  for (const [label, text] of Object.entries(hidden)) {
    assert.ok(!text.includes('Realname'), `${label} hides the display name`);
    if (label !== 'pack browser') assert.ok(text.includes(HIDDEN_NAME), `${label} says Hidden name`);
  }
  const prof = JSON.parse(hidden['public profile']).profile;
  assert.equal(prof.name, HIDDEN_NAME);
  assert.equal(prof.username, REX.username, 'the handle stays when only the name is hidden');
  assert.equal(prof.nameHidden, true);
  assert.equal(prof.hint, hintOf(REX.id));
  const board = JSON.parse(hidden['party leaderboard']).rows.find((r) => r.id === REX.id);
  assert.equal(board.name, HIDDEN_NAME);
  assert.equal(board.hint, REX.id.slice(0, 6));
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'hide', 'name'), admin)).status, 200);
  advance(h, 31_000);
  const back = await publicBodies(h);
  for (const [label, text] of Object.entries(back)) {
    if (label !== 'pack browser') assert.ok(text.includes(REX.display_name), `${label} shows the name again`);
    assert.ok(!text.includes(HIDDEN_NAME), `${label} no longer says Hidden name`);
  }
});

test('a hidden username disappears from every public endpoint but the /u link still opens', async () => {
  const { h, owner } = await setup();
  seedBoards(h, REX);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), owner, { what: 'username' })).status, 200);
  advance(h, 31_000);
  const bodies = await publicBodies(h);
  for (const [label, text] of Object.entries(bodies)) {
    const rest = text.replaceAll(REX.id, '').replaceAll('REXPACK1', '');
    assert.ok(!/rexy/i.test(rest), `${label} hides the username`);
  }
  const prof = JSON.parse(bodies['public profile']).profile;
  assert.equal(prof.username, null);
  assert.equal(prof.usernameHidden, true);
  assert.equal(prof.name, REX.display_name);
  const card = JSON.parse(bodies['party profile card']).profile;
  assert.equal(card.username, null);
  assert.equal(card.page, false);
  const row = JSON.parse(bodies['party leaderboard']).rows.find((r) => r.id === REX.id);
  assert.equal(row.link, false);
  const pack = JSON.parse(bodies['pack browser']).packs.find((p) => p.code === 'REXPACK1');
  assert.equal(pack.by, null);
});

test('when only the username is hidden, a name that is just the username is hidden too', () => {
  const out = maskEntry({ name: 'rexy', username: 'rexy' }, { name: false, username: true }, REX.id);
  assert.equal(out.name, HIDDEN_NAME);
  assert.equal(out.username, null);
  const kept = maskEntry({ name: 'Rex', username: 'rexy' }, { name: false, username: true }, REX.id);
  assert.equal(kept.name, 'Rex');
});

test('staff views keep the real name with a hidden tag', async () => {
  const { h, admin } = await setup();
  h.db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES ('rep00001', 'hottakes', ?, 'Rex Realname', 'rexy', ?, 'Nina', '[]', NULL, 1, ?, 'x', 'open')").run(REX.id, NOBODY.id, h.clock.t);
  h.db.raw.prepare("INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES ('rep00001', 'mean words', NULL, 'x', ?)").run(h.clock.t);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name' })).status, 200);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'username' })).status, 200);
  const person = (await json(await h.api('GET', `/api/party/reports/person/${REX.id}`, admin))).body.person;
  assert.equal(person.name, 'Rex Realname');
  assert.equal(person.username, 'rexy');
  assert.deepEqual(person.hiddenNames, { name: true, username: true });
  const list = (await json(await h.api('GET', '/api/party/reports', admin))).body;
  assert.deepEqual(list.reports[0].drawer.hiddenNames, { name: true, username: true });
  assert.equal(list.reports[0].drawer.profile.display_name, 'Rex Realname');
  const view = (await json(await h.api('GET', profileUrl(REX.id), admin))).body;
  assert.equal(view.person.name, 'Rex Realname');
  assert.ok(view.hidden.name && view.hidden.username);
  const again = await json(await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name' }));
  assert.equal(again.body.hid, false, 'hiding twice changes nothing');
});

test('the person sees what staff changed without a staff name, and re-saving cannot show a hidden name again', async () => {
  const { h, admin, rex } = await setup();
  await fullLook(h, rex);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'bio'), admin)).status, 200);
  advance(h, 1000);
  assert.equal((await h.api('DELETE', profileUrl(REX.id, 'look', 'banner'), admin)).status, 200);
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name', reason: 'secret staff reason' })).status, 200);
  const notes = await json(await h.api('GET', '/api/me/profile-notices', rex));
  assert.equal(notes.status, 200);
  assert.ok(notes.body.hidden.name);
  assert.equal(notes.body.hidden.username, null);
  assert.deepEqual(notes.body.resets.map((r) => r.action), ['profile_banner_remove', 'profile_text_clear']);
  assert.deepEqual(notes.body.resets[1].fields, ['bio']);
  const raw = JSON.stringify(notes.body);
  assert.ok(!raw.includes('Bob') && !raw.includes(ADMIN.id) && !raw.includes('secret staff reason'), 'no staff name, id or reason');
  assert.equal((await h.api('GET', '/api/me/profile-notices')).status, 401);
  assert.equal((await h.api('POST', '/api/me/profile-notices', rex, {})).status, 405);
  advance(h, 61_000);
  const blocked = await h.api('PUT', LOOK, rex, { bio: 'Rex bio again', status: 'still here' });
  assert.equal(blocked.status, 200);
  advance(h, 31_000);
  const profile = (await json(await h.request('GET', `/api/u/${REX.username}`, { ip: ip() }))).body.profile;
  assert.equal(profile.name, HIDDEN_NAME, 'saving the profile does not bring the name back');
  advance(h, 31 * 24 * 3600_000);
  const fresh = (await h.login(REX)).cookie;
  const later = (await json(await h.api('GET', '/api/me/profile-notices', fresh))).body;
  assert.deepEqual(later.resets, [], 'reset notes fade after a month');
  assert.ok(later.hidden.name, 'a hidden name stays until staff unhide it');
});

test('the activity admin check tells hosts which names are hidden, only for the ids asked about', async () => {
  const { h, admin } = await setup();
  assert.equal((await h.api('POST', profileUrl(REX.id, 'hide'), admin, { what: 'name' })).status, 200);
  assert.equal((await h.api('POST', profileUrl(NOBODY.id, 'hide'), admin, { what: 'username' })).status, 200);
  const res = await json(await h.request('GET', `/api/activity/admins?ids=${REX.id},${OWNER.id}`, { ip: ip() }));
  assert.deepEqual(res.body.hiddenNames, [REX.id]);
  assert.equal(res.body.hiddenUsernames, undefined, 'ids nobody asked about are never listed');
  const both = await json(await h.request('GET', `/api/activity/admins?ids=${NOBODY.id}`, { ip: ip() }));
  assert.deepEqual(both.body.hiddenUsernames, [NOBODY.id]);
  assert.equal(both.body.hiddenNames, undefined);
});

test('Party results sent with a hidden name never overwrite the real stored name', async () => {
  const { h } = await setup();
  seedBoards(h, REX);
  const day = dayKey(h.clock.t);
  await h.db.batch(pointsStatements(h.db, { game: 'trivia', players: [{ id: REX.id, name: HIDDEN_NAME, username: null, score: 50, won: true }] }, null, day, h.clock.t));
  const row = h.db.raw.prepare('SELECT name, username, points FROM party_points WHERE user_id = ?').get(REX.id);
  assert.deepEqual([row.name, row.username, row.points], [REX.display_name, REX.username, 950]);
});

test('the dev server seeds a person with a hidden display name and a look to reset', async () => {
  const { seedHiddenName, DEV_HIDDEN_PERSON } = await import('../dev.mjs');
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const rex = seedHiddenName(h.db, h.clock.t);
  assert.equal(rex.id, DEV_HIDDEN_PERSON);
  const pub = await json(await h.request('GET', `/api/u/${rex.username}`, { ip: ip() }));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.profile.name, HIDDEN_NAME);
  assert.ok(!JSON.stringify(pub.body).includes(rex.name));
  const owner = (await h.login(OWNER)).cookie;
  const view = (await json(await h.api('GET', profileUrl(rex.id), owner))).body;
  assert.equal(view.person.name, rex.name);
  assert.ok(view.hidden.name);
  assert.ok(view.look.banner && view.look.bio && view.look.status && view.look.pronouns && view.look.nameColour && view.look.pins.length);
  const log = (await json(await h.api('GET', `/api/party/modlog?target=${rex.id}`, owner))).body;
  assert.equal(log.entries[0].action, 'name_hide');
  seedHiddenName(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_hidden_names').get().n, 1, 'seeding twice is harmless');
});

test('a failed hidden-name read keeps the last good list and is not cached as empty', async () => {
  let fail = false;
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (fail) throw new Error('db down');
          return { results: [{ user_id: REX.id, kind: 'name' }] };
        },
      }),
    }),
  };
  assert.equal((await hiddenNameMap(db, 1000)).get(REX.id).name, true);
  fail = true;
  assert.equal((await hiddenNameMap(db, 40_000)).get(REX.id).name, true, 'the last good list is kept');
  const fresh = { prepare: db.prepare };
  assert.equal((await hiddenNameMap(fresh, 1000)).size, 0);
  fail = false;
  assert.equal((await hiddenNameMap(fresh, 2000)).get(REX.id).name, true, 'the next read tries again');
});
