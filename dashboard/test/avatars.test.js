import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { makeGif, makeAnimWebp } from './motion-fixtures.js';
import { cleanup } from '../worker/cron.js';
import { BADGE_IMG_CSP } from '../worker/security.js';
import { AVATAR_BODY_LIMIT, decodeAvatarImage, decodeAvatarMoving, decodeAvatarStill, isMovingUpload } from '../worker/avatars.js';
import { avatarsFor } from '../worker/avatar-store.js';
import { AVATAR_STILL_MAX, AVATAR_ANIM_MAX, AVATAR_ANIM_MAX_FRAMES, AVATAR_IMG_RE, checkAvatarAnim } from '../web/js/avatar-rules.js';
import { PROFILE_KEEP, PROFILE_STALE } from '../worker/profiles.js';
import { LIMITS } from '../worker/rate.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const API = '/api/me/profile-avatar';
const MIN = 60 * 1000;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const png = (w, ht = w) => devBannerPng(w, ht);
let ipN = 20;
const nextIp = () => `198.51.100.${(ipN = (ipN % 200) + 1)}`;

function seedPublic(h, user, { username = user.username } = {}) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 5, 400, NULL, '[]', '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO NOTHING")
    .run(user.id.toLowerCase(), username, username.toLowerCase(), user.display_name, h.clock.t);
}

async function setup() {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  return { h, alice };
}

async function upload(h, cookie, body) {
  return h.api('POST', API, cookie, body);
}

function wanted(h) {
  return h.db.raw.prepare('SELECT id FROM profile_wanted ORDER BY id').all().map((r) => r.id);
}

test('a square picture uploads, is served from the site with a strict policy, and shows on the public profile, Party card, profiles and header', async () => {
  const { h, alice } = await setup();
  const res = await upload(h, alice, { image: b64(png(256)) });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.match(body.custom.url, AVATAR_IMG_RE);
  assert.equal(body.avatar, body.custom.url);
  assert.equal(body.custom.animated, false);
  assert.equal(body.avatarStill, null);
  assert.equal(body.yapin, ALICE.avatar_url, 'the Yapin picture is remembered for going back');
  const img = await h.request('GET', body.custom.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/png');
  assert.equal(img.headers.get('Content-Security-Policy'), BADGE_IMG_CSP);
  assert.equal(img.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(img.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, png(256).length);
  assert.equal((await h.request('POST', body.custom.url)).status, 405);
  assert.equal((await h.request('GET', body.custom.url.replace(/-[0-9a-f]{16}\./, '-0000000000000000.'))).status, 404, 'an old or guessed hash is not served');
  assert.equal((await h.request('GET', body.custom.url.replace('.png', '.gif'))).status, 404, 'the extension must match the stored type');
  const pub = (await (await h.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile;
  assert.equal(pub.avatar, body.custom.url);
  const card = (await (await h.request('GET', `/api/activity/profile/${ALICE.id}`, { ip: nextIp() })).json()).profile;
  assert.equal(card.avatar, body.custom.url);
  const looked = await (await h.request('GET', `/api/activity/profiles?ids=${ALICE.id}`, { ip: nextIp() })).json();
  assert.equal(looked.profiles[0].avatar, body.custom.url);
  const me = (await (await h.api('GET', '/api/me', alice)).json()).user;
  assert.equal(me.avatar_url, body.custom.url, 'the header uses the uploaded picture');
  assert.equal(me.avatar_custom, true);
  const state = await (await h.api('GET', API, alice)).json();
  assert.equal(state.custom.url, body.custom.url);
  assert.equal(state.canUpload, true);
});

test('"Use my Yapin picture" deletes the upload and everything goes back to the Yapin picture', async () => {
  const { h, alice } = await setup();
  const up = await (await upload(h, alice, { image: b64(png(128)) })).json();
  const del = await h.api('DELETE', API, alice);
  assert.equal(del.status, 200);
  const out = await del.json();
  assert.equal(out.custom, null);
  assert.equal(out.avatar, ALICE.avatar_url);
  assert.equal((await h.request('GET', up.custom.url)).status, 404);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 0);
  const me = (await (await h.api('GET', '/api/me', alice)).json()).user;
  assert.equal(me.avatar_url, ALICE.avatar_url);
  assert.equal('avatar_custom' in me, false);
});

test('a moving GIF keeps its frames, gets a still first frame, and the still is used for lists', async () => {
  const { h, alice } = await setup();
  const gif = makeGif({ width: 200, height: 200, frames: 4 });
  const res = await upload(h, alice, { image: `data:image/gif;base64,${b64(gif)}`, still: b64(png(128)) });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.match(body.custom.url, /\.gif$/);
  assert.match(body.custom.still, /-still\.png$/);
  assert.equal(body.custom.animated, true);
  assert.equal(body.custom.frames, 4);
  const gifRes = await h.request('GET', body.custom.url);
  assert.equal(gifRes.headers.get('Content-Type'), 'image/gif');
  const stillRes = await h.request('GET', body.custom.still);
  assert.equal(stillRes.headers.get('Content-Type'), 'image/png');
  assert.equal(stillRes.headers.get('Content-Security-Policy'), BADGE_IMG_CSP);
  const pub = (await (await h.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile;
  assert.equal(pub.avatarStill, body.custom.still);
  h.db.raw.prepare("INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, 'Alice', 'alice', 500, 3, 1, 200, 'trivia', ?)").run(ALICE.id, h.clock.t);
  const board = await (await h.request('GET', '/api/activity/leaderboard', { ip: nextIp() })).json();
  assert.equal(board.rows[0].avatar, body.custom.url);
  assert.equal(board.rows[0].avatarStill, body.custom.still, 'leaderboard rows carry the still for lists');
  const card = (await (await h.request('GET', `/api/activity/profile/${ALICE.id}`, { ip: nextIp() })).json()).profile;
  assert.equal(card.avatarStill, body.custom.still);
  const webp = makeAnimWebp({ width: 300, height: 300, frames: 3 });
  const again = await upload(h, alice, { image: b64(webp), still: b64(png(256)) });
  assert.equal(again.status, 201, await again.clone().text());
  const two = await again.json();
  assert.match(two.custom.url, /\.webp$/);
  assert.equal((await h.request('GET', body.custom.still)).status, 404, 'the old still goes when a new picture replaces it');
  const plain = await upload(h, alice, { image: b64(png(200)) });
  assert.equal(plain.status, 201);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_stills').get().n, 0, 'a still picture replaces the moving one and its still');
});

test('uploads are checked: square, sensible sizes, real pictures only, no SVG, and moving pictures need their still', async () => {
  const { h, alice } = await setup();
  const code = async (body, status, want) => {
    advance(h, MIN);
    const res = await upload(h, alice, body);
    assert.equal(res.status, status, JSON.stringify(Object.keys(body)));
    const out = await res.json();
    if (want) assert.equal(out.error, want);
    return out;
  };
  await code({ image: b64(png(300, 200)) }, 400, 'bad_image_size');
  await code({ image: b64(png(32)) }, 400, 'bad_image_size');
  await code({ image: b64(png(600)) }, 400, 'bad_image_size');
  await code({ image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64') }, 400, 'bad_image');
  await code({ image: 'not base64!!' }, 400, 'bad_image');
  await code({}, 400, 'bad_image');
  await code({ image: b64(png(128)), still: b64(png(128)) }, 400, 'bad_request');
  await code({ image: b64(png(128)), extra: 1 }, 400, 'bad_request');
  const gif = makeGif({ width: 200, height: 200, frames: 3 });
  await code({ image: b64(gif) }, 400, 'bad_image');
  await code({ image: b64(gif), still: b64(png(300, 200)) }, 400, 'bad_still');
  await code({ image: b64(gif), still: b64(makeGif({ width: 128, height: 128, frames: 2 })) }, 400, 'bad_image');
  const big = new Uint8Array(AVATAR_STILL_MAX + 10);
  big.set(png(128));
  await code({ image: b64(big) }, 413, 'image_too_big');
  assert.ok(AVATAR_BODY_LIMIT >= Math.ceil(((AVATAR_ANIM_MAX + AVATAR_STILL_MAX) * 4) / 3), 'a full moving picture and its still fit in one request');
  assert.ok(AVATAR_ANIM_MAX < 1000 * 1024 && AVATAR_STILL_MAX < 1000 * 1024, 'each stored row stays under the 1 MB row limit');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 0);
});

test('GIF safety: hidden data, frames outside the picture, too many frames, giant frame counts and odd shapes are refused', () => {
  const err = (fn, want) => assert.throws(fn, (e) => e.status === 400 && e.code === want, want);
  err(() => decodeAvatarMoving(b64(makeGif({ width: 200, height: 200, frames: 3, tail: [1, 2, 3, 4] }))), 'bad_image');
  const outside = makeGif({ width: 64, height: 64, frames: 2, full: true });
  outside[6] = 32;
  err(() => decodeAvatarMoving(b64(outside)), 'bad_image');
  err(() => decodeAvatarMoving(b64(makeGif({ width: 100, height: 100, frames: AVATAR_ANIM_MAX_FRAMES + 1 }))), 'too_many_frames');
  err(() => decodeAvatarMoving(b64(makeGif({ width: 1024, height: 1024, frames: 150 }))), 'too_many_frames');
  err(() => decodeAvatarMoving(b64(makeGif({ width: 900, height: 300, frames: 3 }))), 'bad_image_size');
  err(() => decodeAvatarMoving(b64(makeGif({ width: 16, height: 16, frames: 3 }))), 'bad_image_size');
  err(() => decodeAvatarMoving(b64(makeGif({ width: 200, height: 200, frames: 1 }))), 'not_animated');
  err(() => decodeAvatarMoving(b64(makeAnimWebp({ width: 200, height: 200, frames: 2, animFlag: false }))), 'not_animated');
  const clean = decodeAvatarMoving(b64(makeGif({ width: 200, height: 200, frames: 3, comment: 'secret', xmp: true })));
  assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('secret')), false, 'comments and XMP are stripped');
  assert.equal(clean.frames, 3);
  assert.throws(() => decodeAvatarMoving(b64(new Uint8Array(AVATAR_ANIM_MAX + 1))), (e) => e.status === 413);
  assert.throws(() => checkAvatarAnim({ width: 500, height: 200, frames: 3 }), /close to square/);
  assert.equal(isMovingUpload(b64(makeGif({ width: 200, height: 200, frames: 2 }))), true);
  assert.equal(isMovingUpload(b64(png(64))), false);
  assert.equal(decodeAvatarImage(b64(png(512))).width, 512);
  assert.equal(decodeAvatarStill(b64(png(100))).width, 100);
});

test('only a signed-in owner with a public profile can upload, with CSRF checks and a rate limit', async () => {
  const { h, alice } = await setup();
  assert.equal((await h.api('POST', API, null, { image: b64(png(128)) })).status, 401);
  assert.equal((await h.api('POST', API, alice, { image: b64(png(128)) }, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', API, alice, { image: b64(png(128)) }, { Origin: 'https://evil.example' })).status, 403);
  const bob = (await h.login(BOB)).cookie;
  const noProfile = await h.api('POST', API, bob, { image: b64(png(128)) });
  assert.equal(noProfile.status, 403);
  assert.equal((await noProfile.json()).error, 'no_profile');
  assert.equal((await (await h.api('GET', API, bob)).json()).canUpload, false);
  for (let i = 0; i < LIMITS.profileAvatar; i++) assert.equal((await upload(h, alice, { image: b64(png(64 + i)) })).status, 201);
  const slow = await upload(h, alice, { image: b64(png(100)) });
  assert.equal(slow.status, 429);
  assert.ok(Number(slow.headers.get('Retry-After')) > 0);
  advance(h, MIN);
  assert.equal((await upload(h, alice, { image: b64(png(100)) })).status, 201);
});

test('staff can remove an uploaded picture as its own reset part, logged like the other resets, and "reset everything" removes it too', async () => {
  const h = createHarness({ PARTY_OWNER_ID: BOB.id });
  seedPublic(h, ALICE);
  seedPublic(h, BOB);
  const alice = (await h.login(ALICE)).cookie;
  const owner = (await h.login(BOB)).cookie;
  const up = await (await upload(h, alice, { image: b64(png(128)) })).json();
  const view = await (await h.api('GET', `/api/party/profile/${ALICE.id}`, owner)).json();
  assert.equal(view.look.avatar, up.custom.url);
  const reset = await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/avatar`, owner);
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal((await reset.json()).action, 'profile_avatar_remove');
  assert.equal((await h.request('GET', up.custom.url)).status, 404);
  const log = h.db.raw.prepare('SELECT action, target_id, detail FROM party_mod_log ORDER BY created').all();
  assert.equal(log.at(-1).action, 'profile_avatar_remove');
  assert.equal(log.at(-1).target_id, ALICE.id.toLowerCase());
  const again = await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/avatar`, owner);
  assert.equal(again.status, 404);
  assert.match((await again.json()).message, /haven't uploaded/);
  const notes = await (await h.api('GET', '/api/me/profile-notices', alice)).json();
  assert.equal(notes.resets[0].action, 'profile_avatar_remove');
  await upload(h, alice, { image: b64(png(128)) });
  const all = await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/all`, owner);
  assert.equal(all.status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 0);
});

test('a person who only exists as a bot snapshot gets their Yapin picture on /u without ever joining Party', async () => {
  const h = createHarness();
  const id = 'c0000000-0000-4000-8000-0000000000b1';
  const pic = 'https://files.yapper.website/avatars/c0000000/r2-1-abc.webp';
  const up = await h.bot('POST', '/bot/profiles', { profiles: [{ id, name: 'Bleed', username: 'bleeed', level: 5, xp: 100, shards: null, badges: [], achievements: [], season: [], clan: null, hidden: false, avatar_url: pic }] });
  assert.equal(up.status, 200);
  const pub = (await (await h.request('GET', '/api/u/bleeed', { ip: nextIp() })).json()).profile;
  assert.equal(pub.avatar, pic);
  await h.bot('POST', '/bot/profiles', { profiles: [{ id, name: 'Bleed', username: 'bleeed', level: 5, xp: 100, hidden: false, avatar_url: 'https://evil.example/x.png' }] });
  assert.equal((await (await h.request('GET', '/api/u/bleeed', { ip: nextIp() })).json()).profile.avatar, pic, 'a bad link from the bot never replaces a good picture');
  const next = 'https://files.yapper.website/avatars/c0000000/r2-2-def.png';
  await h.bot('POST', '/bot/profiles', { profiles: [{ id, name: 'Bleed', username: 'bleeed', level: 6, xp: 200, hidden: false, avatar_url: next }] });
  assert.equal((await (await h.request('GET', '/api/u/bleeed', { ip: nextIp() })).json()).profile.avatar, next, 'a new picture replaces the old one on the next push');
  await h.bot('POST', '/bot/profiles', { profiles: [{ id, name: 'Bleed', username: 'bleeed', level: 6, xp: 200, hidden: false, avatar_url: null }] });
  assert.equal((await (await h.request('GET', '/api/u/bleeed', { ip: nextIp() })).json()).profile.avatar, null, 'someone who removed their picture gets initials');
  await h.bot('POST', '/bot/profiles', { profiles: [{ id, name: 'Bleed', username: 'bleeed', level: 6, xp: 200, hidden: false }] });
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profiles WHERE id = ?').get(id).n, 1, 'snapshots without a picture field leave the picture alone');
});

test('reading /u, the Party card and the leaderboard asks the bot to look up missing or stale pictures', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  await h.request('GET', '/api/u/alice', { ip: nextIp() });
  assert.deepEqual(wanted(h), [ALICE.id.toLowerCase()]);
  h.db.raw.prepare('DELETE FROM profile_wanted').run();
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(ALICE.id, 'alice', 'Alice', 'https://files.yapper.website/avatars/a/1.png', h.clock.t);
  await h.request('GET', '/api/u/alice', { ip: nextIp() });
  assert.deepEqual(wanted(h), [], 'a fresh picture is not looked up again');
  advance(h, PROFILE_STALE + MIN);
  await h.request('GET', `/api/activity/profile/${ALICE.id}`, { ip: nextIp() });
  assert.deepEqual(wanted(h), [ALICE.id.toLowerCase()], 'a stale picture is refreshed from the Party card');
  h.db.raw.prepare('DELETE FROM profile_wanted').run();
  const other = 'c0000000-0000-4000-8000-0000000000c2';
  h.db.raw.prepare("INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, 'Cat', 'cat', 500, 3, 1, 200, 'trivia', ?)").run(other, h.clock.t);
  await h.request('GET', '/api/activity/leaderboard', { ip: nextIp() });
  assert.ok(wanted(h).includes(other), 'leaderboard people without a picture are looked up');
});

test('ids in different case still find the saved picture', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  const upper = ALICE.id.toUpperCase();
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(upper, 'alice', 'Alice', 'https://files.yapper.website/avatars/a/up.png', h.clock.t);
  assert.equal((await (await h.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile.avatar, 'https://files.yapper.website/avatars/a/up.png');
  const found = await avatarsFor(h.db, [ALICE.id]);
  assert.equal(found.get(ALICE.id.toLowerCase()).avatar, 'https://files.yapper.website/avatars/a/up.png');
});

test('signing in always refreshes the saved picture from Yapin, and a signed-in person with no saved row still gets one', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(ALICE.id, 'alice', 'Alice', 'https://files.yapper.website/avatars/a/old.png', h.clock.t - 40 * 24 * 60 * MIN);
  await h.login(ALICE);
  const row = h.db.raw.prepare('SELECT avatar_url, fetched, missing FROM profiles WHERE id = ?').get(ALICE.id);
  assert.equal(row.avatar_url, ALICE.avatar_url);
  assert.equal(row.fetched, h.clock.t);
  assert.equal(row.missing, 0);
  const pic = (await (await h.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile.avatar;
  assert.equal(pic, ALICE.avatar_url);
  await h.login({ ...ALICE, avatar_url: null });
  assert.equal(h.db.raw.prepare('SELECT avatar_url FROM profiles WHERE id = ?').get(ALICE.id).avatar_url, null, 'removing the picture on Yapin removes it here after sign-in');
  await h.login({ ...ALICE, avatar_url: 'https://evil.example/x.png' });
  assert.equal(h.db.raw.prepare('SELECT avatar_url FROM profiles WHERE id = ?').get(ALICE.id).avatar_url, null, 'a picture from an unknown host is never saved');
  const h2 = createHarness();
  seedPublic(h2, ALICE);
  h2.db.raw.prepare("INSERT INTO sessions (id_hash, user_id, username, display_name, avatar_url, created, expires, last_seen) VALUES ('x', ?, 'alice', 'Alice', 'https://files.yapper.website/avatars/a/sess.png', ?, ?, 0)").run(ALICE.id, h2.clock.t, h2.clock.t + 60 * MIN);
  assert.equal((await (await h2.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile.avatar, 'https://files.yapper.website/avatars/a/sess.png', 'the sign-in picture is the fallback when nothing else is saved');
});

test('a "not found" answer from the bot keeps the last known picture, and cleanup keeps pictures for people with a public profile', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  const keep = 'https://files.yapper.website/avatars/a/keep.png';
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(ALICE.id, 'alice', 'Alice', keep, h.clock.t);
  await h.bot('POST', '/bot/profiles', { profiles: [], missing: [ALICE.id] });
  assert.equal(h.db.raw.prepare('SELECT avatar_url FROM profiles WHERE id = ?').get(ALICE.id).avatar_url, keep);
  assert.equal((await (await h.request('GET', '/api/u/alice', { ip: nextIp() })).json()).profile.avatar, keep);
  const gone = 'c0000000-0000-4000-8000-0000000000d3';
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 0, ?)').run(gone, h.clock.t);
  advance(h, PROFILE_KEEP + MIN);
  h.db.raw.prepare('UPDATE public_profiles SET updated = ?').run(h.clock.t);
  await cleanup(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profiles WHERE id = ?').get(ALICE.id).n, 1, 'a public profile keeps its picture');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profiles WHERE id = ?').get(gone).n, 0, 'unknown people are still cleaned up');
});

test('a broken Yapin picture can be reported so the bot looks it up again, rate limited and skipped when fresh', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(ALICE.id, 'alice', 'Alice', 'https://files.yapper.website/avatars/a/1.png', h.clock.t);
  const ask = (body, ip = '198.51.100.250') => h.request('POST', '/api/avatars/refresh', { body, ip });
  const fresh = await ask({ ids: [ALICE.id] });
  assert.equal(fresh.status, 202);
  assert.equal((await fresh.json()).queued, 0, 'a picture looked up in the last few minutes is not asked again');
  advance(h, 11 * MIN);
  assert.equal((await (await ask({ names: ['@Alice'] })).json()).queued, 1, 'the profile page can report by username');
  assert.deepEqual(wanted(h), [ALICE.id.toLowerCase()]);
  assert.equal((await (await ask({ ids: [ALICE.id] })).json()).queued, 0, 'a lookup that is already waiting is not queued twice');
  assert.equal((await ask({ ids: [] })).status, 400);
  assert.equal((await ask({ ids: Array.from({ length: 11 }, (_, i) => `id${i}`) })).status, 413);
  assert.equal((await h.request('GET', '/api/avatars/refresh')).status, 405);
  let last;
  for (let i = 0; i < LIMITS.avatarRefresh + 1; i++) last = await ask({ ids: ['zz'] }, '198.51.100.251');
  assert.equal(last.status, 429);
  const { alice } = await (async () => {
    const cookie = (await h.login(ALICE)).cookie;
    return { alice: cookie };
  })();
  await upload(h, alice, { image: b64(png(128)) });
  h.db.raw.prepare('DELETE FROM profile_wanted').run();
  advance(h, 11 * MIN);
  assert.equal((await (await ask({ ids: [ALICE.id] }, '198.51.100.252')).json()).queued, 0, 'uploaded pictures never need a Yapin lookup');
});

test('clan member lists and inbox items carry profile pictures', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  seedPublic(h, BOB);
  const alice = (await h.login(ALICE)).cookie;
  const up = await (await upload(h, alice, { image: b64(png(128)) })).json();
  const clanId = 'clan-1';
  h.db.raw.prepare("INSERT INTO clan_directory (id, tag, tag_key, name, colour, banner, members, join_mode, leader_id, created, updated) VALUES (?, 'OWL', 'owl', 'Night Owls', NULL, NULL, 2, 'open', ?, 1, ?)").run(clanId, ALICE.id.toLowerCase(), h.clock.t);
  h.db.raw.prepare('INSERT INTO clan_members (user_id, clan_id, updated) VALUES (?, ?, ?), (?, ?, ?)').run(ALICE.id.toLowerCase(), clanId, h.clock.t, BOB.id.toLowerCase(), clanId, h.clock.t);
  const clan = await (await h.request('GET', '/api/clans/owl', { ip: nextIp() })).json();
  const top = clan.clan || clan;
  assert.equal(top.leader.avatar, up.custom.url);
  assert.equal(top.top.find((m) => m.leader).avatar, up.custom.url);
  const mine = await (await h.api('GET', '/api/me/clan', alice)).json();
  assert.equal(mine.clan.members.find((m) => m.id === ALICE.id.toLowerCase()).avatar, up.custom.url);
  h.db.raw.prepare("INSERT INTO notifications (id, user_id, kind, title, body, data, created, read_at) VALUES ('n-1', ?, 'clan_invite', 'Clan invite from [OWL] Night Owls', NULL, ?, ?, NULL)").run(BOB.id.toLowerCase(), JSON.stringify({ clan: clanId, tag: 'OWL', by: ALICE.id.toLowerCase(), person: ALICE.id.toLowerCase() }), h.clock.t);
  const bob = (await h.login(BOB)).cookie;
  const inbox = await (await h.api('GET', '/api/me/inbox', bob)).json();
  assert.deepEqual(inbox.items[0].person, { id: ALICE.id.toLowerCase(), avatar: up.custom.url });
});

test('a private profile keeps its uploaded picture off every public page and image link, while the owner and staff can still manage it', async () => {
  const h = createHarness({ PARTY_OWNER_ID: BOB.id });
  seedPublic(h, ALICE);
  seedPublic(h, BOB);
  const alice = (await h.login(ALICE)).cookie;
  const owner = (await h.login(BOB)).cookie;
  const up = await (await upload(h, alice, { image: b64(makeGif({ width: 64, height: 64, frames: 3 })), still: b64(png(64)) })).json();
  assert.equal((await h.request('GET', up.custom.url)).status, 200);
  assert.equal((await h.request('GET', up.custom.still)).status, 200);
  h.db.raw.prepare('UPDATE public_profiles SET hidden = 1 WHERE user_id = ?').run(ALICE.id.toLowerCase());
  assert.equal((await h.request('GET', up.custom.url)).status, 404, 'the moving picture is not served for a private profile');
  assert.equal((await h.request('GET', up.custom.still)).status, 404, 'nor is its still');
  const looked = await (await h.request('GET', `/api/activity/profiles?ids=${ALICE.id}`, { ip: nextIp() })).json();
  assert.notEqual(looked.profiles[0]?.avatar, up.custom.url, 'lookups by id fall back to the Yapin picture');
  const found = await avatarsFor(h.db, [ALICE.id]);
  assert.equal(found.get(ALICE.id.toLowerCase()).custom, false);
  assert.equal((await avatarsFor(h.db, [ALICE.id], { hidden: true })).get(ALICE.id.toLowerCase()).custom, true);
  const me = (await (await h.api('GET', '/api/me', alice)).json()).user;
  assert.notEqual(me.avatar_url, up.custom.url);
  assert.ok(!me.avatar_custom);
  const state = await (await h.api('GET', API, alice)).json();
  assert.equal(state.private, true);
  assert.equal(state.custom.url, up.custom.url, 'the owner can still see and remove what they uploaded');
  assert.equal(state.avatar, state.yapin);
  const view = await (await h.api('GET', `/api/party/profile/${ALICE.id}`, owner)).json();
  assert.equal(view.look.avatar, up.custom.url, 'staff still see it');
  assert.equal((await h.api('DELETE', `/api/party/profile/${ALICE.id}/look/avatar`, owner)).status, 200, 'and can remove it');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 0);
});

test('a private profile set in the visibility settings also hides the uploaded picture', async () => {
  const { h, alice } = await setup();
  const up = await (await upload(h, alice, { image: b64(png(128)) })).json();
  const vis = await h.api('POST', '/api/me/profile-visibility', alice, { hidden: true });
  assert.ok(vis.status < 300, await vis.clone().text());
  assert.equal((await h.request('GET', up.custom.url)).status, 404);
  const looked = await (await h.request('GET', `/api/activity/profiles?ids=${ALICE.id}`, { ip: nextIp() })).json();
  assert.notEqual(looked.profiles[0]?.avatar, up.custom.url);
  await h.api('POST', '/api/me/profile-visibility', alice, { hidden: false });
  assert.equal((await h.request('GET', up.custom.url)).status, 200, 'making it public again brings the picture back');
});

test('the refresh endpoint does not resolve the username of a private profile', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  h.db.raw.prepare('UPDATE public_profiles SET hidden = 1 WHERE user_id = ?').run(ALICE.id.toLowerCase());
  const res = await h.request('POST', '/api/avatars/refresh', { body: { names: ['alice'] }, ip: nextIp() });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).queued, 0);
  assert.deepEqual(wanted(h), []);
});

test('cleanup removes uploaded pictures once their public profile is gone, and leftover stills', async () => {
  const { h, alice } = await setup();
  await upload(h, alice, { image: b64(png(128)) });
  h.db.raw.prepare("INSERT INTO profile_avatar_stills (user_id, avatar_hash, image, mime, hash, width, height, bytes, updated) VALUES ('nobody', 'x', x'00', 'image/png', 'y', 1, 1, 1, 0)").run();
  await cleanup(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 1, 'a public profile keeps its picture');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatar_stills').get().n, 0, 'stills with no matching picture are removed');
  h.db.raw.prepare('DELETE FROM public_profiles').run();
  await cleanup(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 1, 'a short grace period first');
  advance(h, 25 * 60 * MIN);
  await cleanup(h.db, h.clock.t);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_avatars').get().n, 0);
});
