import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS, advance } from './helpers.js';
import { devBannerPng, devBadgePng, DEV_LOOKS } from '../dev.mjs';
import { cleanLook, themeColours, contrast, readableOn, cleanBio, LookError, NAME_PALETTE, LIGHT_SURFACE, DARK_SURFACE, MIN_CONTRAST, PIN_MAX, BIO_MAX, SECTION_IDS, defaultLook, isDefaultLook } from '../web/js/profile-look.js';
import { decodeBanner, BANNER_MAX } from '../worker/profile-custom.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { buildCard, clearPartyProfileCache } from '../worker/party-profile.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const LOOK = '/api/me/profile-look';
const BANNER = '/api/me/profile-banner';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function seedProfile(h, user, { badges = ['vip', 'supporter'], achievements = ['msgs1k'], hidden = 0 } = {}) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 3, 400, NULL, ?, ?, '[]', NULL, ?, ?)")
    .run(user.id, user.username, user.username, user.display_name, JSON.stringify(badges), JSON.stringify(achievements), hidden, h.clock.t);
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, '{}', '{}', ?)").run(user.id, h.clock.t);
}

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  seedProfile(h, ALICE);
  seedProfile(h, BOB, { badges: ['early-bird'], achievements: [] });
  const alice = (await h.login(ALICE)).cookie;
  const bob = (await h.login(BOB)).cookie;
  return { h, alice, bob };
}

async function put(h, cookie, body, extra) {
  const res = await h.api('PUT', LOOK, cookie, body, extra);
  return { status: res.status, body: await res.json() };
}

async function view(h, name) {
  const res = await h.request('GET', `/api/u/${name}`, { ip: '203.0.113.90' });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

test('every palette colour and any custom colour stays readable on light and dark cards', () => {
  for (const c of NAME_PALETTE) {
    const t = themeColours(c.hex);
    assert.ok(contrast(t.light, LIGHT_SURFACE) >= MIN_CONTRAST, `${c.label} on light`);
    assert.ok(contrast(t.dark, DARK_SURFACE) >= MIN_CONTRAST, `${c.label} on dark`);
  }
  for (const hex of ['#ffffff', '#000000', '#ffff00', '#0000ff', '#777777', '#121215']) {
    const t = themeColours(hex);
    assert.ok(contrast(t.light, LIGHT_SURFACE) >= MIN_CONTRAST, hex);
    assert.ok(contrast(t.dark, DARK_SURFACE) >= MIN_CONTRAST, hex);
  }
  assert.equal(themeColours('#ffffff').dark, '#ffffff', 'already readable colours are left alone');
  assert.notEqual(themeColours('#ffffff').light, '#ffffff', 'white is darkened on light cards');
  assert.equal(readableOn('nope', LIGHT_SURFACE), null);
});

test('the look is validated strictly: colours, pins, sections, text and emoji', () => {
  const strict = (raw, owned = null) => () => cleanLook(raw, { strict: true, owned });
  const code = (c) => (e) => e instanceof LookError && e.code === c;
  for (const bad of ['red', '#fff', '#FFFFFF', '#12345g', 'url(x)', '#1234567', 5]) assert.throws(strict({ nameColour: bad }), code('bad_colour'), String(bad));
  assert.throws(strict({ accent: 'javascript:alert(1)' }), code('bad_accent'));
  assert.throws(strict({ pins: ['a', 'b', 'c', 'd', 'e', 'f'] }), code('too_many_pins'));
  assert.throws(strict({ pins: ['vip'] }, new Set(['supporter'])), code('not_owned'));
  assert.throws(strict({ pins: ['<b>'] }), code('bad_pins'));
  assert.throws(strict({ order: ['badges', 'badges'] }), code('bad_order'));
  assert.throws(strict({ order: ['secret'] }), code('bad_order'));
  assert.throws(strict({ hidden: ['nope'] }), code('bad_hidden'));
  assert.throws(strict({ bio: 'x'.repeat(BIO_MAX + 1) }), code('bad_bio'));
  assert.throws(strict({ pronouns: 'x'.repeat(25) }), code('bad_pronouns'));
  assert.throws(strict({ status: 'x'.repeat(61) }), code('bad_status'));
  assert.throws(strict({ statusEmoji: 'hi' }), code('bad_emoji'));
  assert.throws(strict({ banner: 'url(evil)' }), code('bad_banner'));
  assert.throws(strict({ nameGradient: 'rainbow-ish' }), code('bad_gradient'));
  assert.throws(strict({ nameFont: 'Comic Sans' }), code('bad_font'));
  assert.throws(strict({ ring: 'x' }), code('bad_ring'));
  assert.throws(strict({ density: 'x' }), code('bad_density'));
  assert.throws(strict({ featured: 'secret' }), code('bad_featured'));
  assert.throws(strict({ evil: 1 }), code('bad_request'));
  assert.throws(strict({ v: 99 }), code('bad_version'));
  const ok = cleanLook({ pins: ['vip', 'ach:msgs1k'], order: ['badges', 'about'], hidden: ['placings', 'about'], nameGradient: 'aurora', nameColour: '#112233', statusEmoji: '\u{1F3AE}', bio: '  hi\n\n\n\nthere  ' }, { strict: true, owned: new Set(['vip', 'ach:msgs1k']) });
  assert.deepEqual(ok.order, ['badges', 'about', ...SECTION_IDS.filter((s) => s !== 'badges' && s !== 'about')], 'missing sections are added at the end');
  assert.deepEqual(ok.hidden, ['about', 'placings']);
  assert.equal(ok.nameColour, null, 'a gradient wins over a colour');
  assert.equal(ok.bio, 'hi\n\nthere');
  assert.equal(cleanBio('a\nb\nc\nd\ne\nf'), 'a\nb\nc\nd e f', 'extra lines are joined, not dropped');
  const loose = cleanLook({ nameColour: 'red', pins: Array(9).fill('vip'), order: 'x', bio: 5 });
  assert.equal(loose.nameColour, null);
  assert.deepEqual(loose.pins, ['vip']);
  assert.ok(isDefaultLook(defaultLook()));
  assert.ok(PIN_MAX === 5);
});

test('only you can change your own look, writes need sign-in and the CSRF header', async () => {
  const { h, alice, bob } = await setup();
  const body = { nameColour: '#e0a100', bio: 'Hi there' };
  assert.equal((await put(h, null, body)).status, 401);
  assert.equal((await put(h, alice, body, { 'X-YapOS': null })).status, 403);
  assert.equal((await put(h, alice, body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('DELETE', LOOK, alice)).status, 405);
  const saved = await put(h, alice, body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.look.nameColour, '#e0a100');
  assert.equal((await put(h, bob, { bio: 'Bob was here', pins: ['vip'] })).status, 400, "bob can't pin alice's badge");
  assert.equal((await put(h, bob, { bio: 'Bob was here' })).status, 200);
  const a = await view(h, 'alice');
  const b = await view(h, 'bob');
  assert.equal(a.body.profile.custom.bio, 'Hi there', "bob's save never touched alice");
  assert.equal(b.body.profile.custom.bio, 'Bob was here');
  const mine = await (await h.api('GET', LOOK, alice)).json();
  assert.equal(mine.look.bio, 'Hi there');
  assert.ok(mine.owned.includes('vip') && mine.owned.includes('ach:msgs1k') && mine.owned.includes('first-game'));
  assert.equal(mine.limits.pins, 5);
});

test('pins must be badges you own, at most 5, and lost badges drop off quietly', async () => {
  const { h, alice } = await setup();
  assert.equal((await put(h, alice, { pins: ['wins-50'] })).body.error, 'not_owned');
  assert.equal((await put(h, alice, { pins: ['vip', 'supporter', 'first-game', 'games-10', 'ach:msgs1k', 'x'] })).body.error, 'too_many_pins');
  const ok = await put(h, alice, { pins: ['ach:msgs1k', 'vip', 'first-game'] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await view(h, 'alice')).body.profile.custom.pins, ['ach:msgs1k', 'vip', 'first-game']);
  h.db.raw.prepare("UPDATE public_profiles SET badges = '[\"supporter\"]' WHERE user_id = ?").run(ALICE.id);
  assert.deepEqual((await view(h, 'alice')).body.profile.custom.pins, ['ach:msgs1k', 'first-game'], 'the badge that was taken away is no longer pinned');
});

test('section order, hidden sections and every other choice are saved and come back the same', async () => {
  const { h, alice } = await setup();
  const look = { ...DEV_LOOKS.owner, pins: ['vip'], banner: 'stripes', order: ['placings', 'badges', 'stats', 'about', 'favourites', 'achievements'], hidden: ['favourites'] };
  assert.equal((await put(h, alice, look)).status, 200);
  const c = (await view(h, 'alice')).body.profile.custom;
  for (const k of ['order', 'hidden', 'pins', 'nameGradient', 'accent', 'banner', 'bio', 'status', 'statusEmoji', 'ring', 'density', 'featured']) assert.deepEqual(c[k], look[k], k);
  assert.equal(c.colours.accent.base, '#7c5cff');
  assert.equal((await put(h, alice, defaultLook())).status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_custom').get().n, 0, 'going back to default removes the row');
});

test('about me, pronouns and status are checked against built-in and custom blocked words', async () => {
  const { h, alice } = await setup();
  const builtIn = await put(h, alice, { bio: `you are a ${decodeTerm('mktwhp')} lol` });
  assert.equal(builtIn.status, 400);
  assert.equal(builtIn.body.error, 'blocked_words');
  assert.deepEqual(builtIn.body.fields, ['bio']);
  assert.match(builtIn.body.message, /about me/);
  assert.equal((await h.api('POST', '/api/party/blocked-words', alice, { word: 'pineapple pizza' })).status, 201);
  const custom = await put(h, alice, { status: 'eating pineapple pizza', pronouns: 'she/her' });
  assert.equal(custom.status, 400);
  assert.deepEqual(custom.body.fields, ['status']);
  assert.equal((await put(h, alice, { status: 'eating pizza', pronouns: 'she/her' })).status, 200);
  h.db.raw.prepare('INSERT INTO profile_custom (user_id, v, data, updated) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data').run(ALICE.id, JSON.stringify({ bio: 'I love pineapple pizza', status: 'ok' }), h.clock.t);
  const c = (await view(h, 'alice')).body.profile.custom;
  assert.equal(c.bio, '', 'text that became blocked later is hidden when shown');
  assert.equal(c.status, 'ok');
});

test('profile look writes are size capped and rate limited', async () => {
  const { h, alice } = await setup();
  const big = await h.api('PUT', LOOK, alice, { bio: 'x'.repeat(9000) });
  assert.equal(big.status, 413);
  let last = null;
  for (let i = 0; i < 25; i++) last = await put(h, alice, { bio: `hello ${i}` });
  assert.equal(last.status, 429);
  advance(h, 61_000);
  assert.equal((await put(h, alice, { bio: 'later' })).status, 200);
});

test('a hidden profile shows nothing, not even its look or banner', async () => {
  const { h, alice } = await setup();
  const up = await h.api('POST', BANNER, alice, { image: b64(devBannerPng()) });
  assert.equal(up.status, 201);
  const url = (await up.json()).banner.url;
  assert.equal((await h.request('GET', url)).status, 200);
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: true });
  assert.equal((await view(h, 'alice')).status, 404);
  assert.equal((await h.request('GET', url)).status, 404, 'the banner picture is not served while the profile is hidden');
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id);
  assert.equal(card.hidden, true);
  assert.equal(card.look, undefined);
});

test('banner pictures are checked by their bytes and served safely with an immutable hashed url', async () => {
  const { h, alice } = await setup();
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(svg) })).status, 400);
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(devBadgePng(64)) })).status, 400, 'too small');
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(devBannerPng(400, 300)) })).status, 400, 'not wide enough');
  assert.throws(() => decodeBanner(b64(devBannerPng(1700, 400))), (e) => e.code === 'bad_image_size');
  const huge = new Uint8Array(BANNER_MAX + 10);
  huge.set(devBannerPng());
  assert.throws(() => decodeBanner(b64(huge)), (e) => e.status === 413);
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(devBannerPng()), extra: 1 })).status, 400);
  assert.equal((await h.api('POST', BANNER, null, { image: b64(devBannerPng()) })).status, 401);
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(devBannerPng()) }, { 'X-YapOS': null })).status, 403);
  const up = await h.api('POST', BANNER, alice, { image: `data:image/png;base64,${b64(devBannerPng())}` });
  assert.equal(up.status, 201);
  const { banner } = await up.json();
  assert.match(banner.url, /^\/banner-img\/b-[a-z0-9]{10}-[0-9a-f]{16}\.png$/);
  const img = await h.request('GET', banner.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/png');
  assert.equal(img.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(img.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.match(img.headers.get('Cache-Control'), /immutable/);
  assert.equal((await h.request('GET', banner.url.replace(/-[0-9a-f]{16}\./, '-0000000000000000.'))).status, 404, 'an old hash is never served');
  assert.equal((await h.request('POST', banner.url)).status, 405);
  const c = (await view(h, 'alice')).body.profile.custom;
  assert.equal(c.banner, 'image');
  assert.equal(c.bannerImage, banner.url);
  const again = await (await h.api('POST', BANNER, alice, { image: b64(devBannerPng(800, 200)) })).json();
  assert.notEqual(again.banner.url, banner.url, 'a new picture gets a new url');
  assert.equal((await h.request('GET', banner.url)).status, 404);
  assert.equal((await h.api('DELETE', BANNER, alice)).status, 200);
  assert.equal((await h.request('GET', again.banner.url)).status, 404);
  assert.equal((await view(h, 'alice')).body.profile.custom.banner, 'none');
  assert.equal((await put(h, alice, { banner: 'image' })).body.error, 'no_banner');
});

test('staff remove banners and profile text through the shared staff route, and it is written to the mod log', async () => {
  const { h, alice, bob } = await setup();
  assert.equal((await put(h, bob, { bio: 'Bob bio', status: 'Hi', statusEmoji: '\u{1F44B}' })).status, 200);
  const up = await (await h.api('POST', BANNER, bob, { image: b64(devBannerPng()) })).json();
  const detail = await (await h.api('GET', `/api/owner/users/${BOB.id}`, alice)).json();
  assert.equal(detail.user.look.banner, up.banner.url);
  assert.equal(detail.user.look.bio, 'Bob bio');
  assert.equal((await h.api('DELETE', `/api/owner/users/${BOB.id}/banner`, alice)).status, 404, 'the old owner-only route is gone');
  assert.equal((await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/banner`, bob)).status, 403, 'only staff can do this');
  assert.equal((await h.api('DELETE', `/api/party/profile/${BOB.id}/look/banner`, alice, undefined, { 'X-YapOS': null })).status, 403);
  const gone = await h.api('DELETE', `/api/party/profile/${BOB.id}/look/banner`, alice);
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).look.banner, null);
  assert.equal((await h.request('GET', up.banner.url)).status, 404);
  assert.equal((await view(h, 'bob')).body.profile.custom.banner, 'none');
  assert.equal((await h.api('DELETE', `/api/party/profile/${BOB.id}/look/banner`, alice)).status, 404);
  const cleared = await h.api('DELETE', `/api/party/profile/${BOB.id}/look/text`, alice);
  assert.equal(cleared.status, 200);
  const c = (await view(h, 'bob')).body.profile.custom;
  assert.equal(c.bio, '');
  assert.equal(c.status, '');
  const log = h.db.raw.prepare('SELECT action, actor_id, target_id FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['profile_banner_remove', 'profile_text_clear']);
  assert.ok(log.every((r) => r.actor_id === ALICE.id && r.target_id === BOB.id));
});

test('the Party profile card puts pinned badges first and carries the readable name colour', async () => {
  const { h, alice } = await setup();
  assert.equal((await put(h, alice, { pins: ['supporter', 'ach:msgs1k'], nameColour: '#ffffff' })).status, 200);
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id);
  assert.equal(card.badges[0].id, 'supporter');
  assert.deepEqual(card.look.pins, ['supporter', 'ach:msgs1k']);
  assert.equal(card.look.nameColour.dark, '#ffffff');
  assert.ok(contrast(card.look.nameColour.light, LIGHT_SURFACE) >= MIN_CONTRAST);
  const res = await h.request('GET', `/api/activity/profile/${ALICE.id}`);
  assert.equal((await res.json()).profile.look.pins[0], 'supporter');
});

test('the Party profile card carries the banner, ring, accent, pronouns and status, with blocked text hidden', async () => {
  const { h, alice } = await setup();
  assert.equal((await put(h, alice, { banner: 'ocean', ring: 'gold', accent: '#7c5cff', nameFont: 'serif', pronouns: 'she/her', status: 'Playing', statusEmoji: '\u{1F3AE}' })).status, 200);
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(card.look.banner, 'ocean');
  assert.equal(card.look.bannerImage, null);
  assert.equal(card.look.ring, 'gold');
  assert.equal(card.look.nameFont, 'serif');
  assert.equal(card.look.accent.base, '#7c5cff');
  assert.ok(contrast(card.look.accent.dark, DARK_SURFACE) >= MIN_CONTRAST);
  assert.equal(card.look.pronouns, 'she/her');
  assert.equal(card.look.status, 'Playing');
  assert.equal(card.look.statusEmoji, '\u{1F3AE}');
  assert.equal(card.look.bio, undefined, 'the card never carries the about me text');
  const up = await (await h.api('POST', BANNER, alice, { image: b64(devBannerPng()) })).json();
  clearPartyProfileCache(h.db);
  const pic = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(pic.look.banner, 'image');
  assert.equal(pic.look.bannerImage, up.banner.url);
  assert.equal((await h.api('POST', '/api/party/blocked-words', alice, { word: 'pineapple pizza' })).status, 201);
  h.db.raw.prepare('UPDATE profile_custom SET data = ? WHERE user_id = ?').run(JSON.stringify({ status: 'eating pineapple pizza', pronouns: 'she/her' }), ALICE.id);
  clearPartyProfileCache(h.db);
  const safe = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(safe.look.status, '', 'status text that became blocked later is hidden on the card');
  assert.equal(safe.look.pronouns, 'she/her');
  await h.api('DELETE', BANNER, alice);
  clearPartyProfileCache(h.db);
  const gone = await buildCard(h.db, ALICE.id, h.clock.t);
  assert.equal(gone.look.bannerImage, null);
});

test('a banner picture needs a public profile, so the site is never a picture host for anyone signed in', async () => {
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  const carol = { id: '55555555-5555-4555-8555-555555555555', username: 'carol', display_name: 'Carol', avatar_url: null };
  const cookie = (await h.login(carol)).cookie;
  const res = await h.api('POST', BANNER, cookie, { image: b64(devBannerPng()) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'no_profile');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_banners').get().n, 0);
  h.db.raw.prepare("INSERT INTO profile_banners (user_id, id, image, mime, hash, width, height, bytes, updated) VALUES (?, 'b-abcdefghij', ?, 'image/png', '0123456789abcdef', 600, 150, 10, 0)")
    .run(carol.id, Buffer.from(devBannerPng()));
  assert.equal((await h.request('GET', '/banner-img/b-abcdefghij-0123456789abcdef.png')).status, 404, 'a banner without a public profile is never served');
});
