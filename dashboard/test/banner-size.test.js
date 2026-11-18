import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { decodeBanner, BANNER_MAX, BANNER_BODY_LIMIT, BANNER_MIN_W, BANNER_MAX_W, BANNER_MIN_H, BANNER_MAX_H } from '../worker/profile-custom.js';
import { badgeTier, specialBadgesFirst } from '../worker/party-badges.js';
import { badgeKindOf, specialFirst } from '../web/js/profile-look.js';
import { buildCard, clearPartyProfileCache } from '../worker/party-profile.js';

const ALICE = USERS.alice;
const BANNER = '/api/me/profile-banner';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function setup(badges = ['first-game', 'vip', 'games-10', 'supporter', 'season-xp-1-2026-09']) {
  const h = createHarness();
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 3, 400, NULL, ?, '[\"msgs1k\"]', '[]', NULL, 0, ?)")
    .run(ALICE.id, ALICE.username, ALICE.username, ALICE.display_name, JSON.stringify(badges), h.clock.t);
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 12, 4, '{}', '{}', ?)").run(ALICE.id, h.clock.t);
  const alice = (await h.login(ALICE)).cookie;
  return { h, alice };
}

test('banners can be 1500 by 500 up to 3000 by 1000, older 4:1 banners still pass, and odd shapes are refused', async () => {
  assert.equal(BANNER_MIN_W, 600);
  assert.equal(BANNER_MAX_W, 3000);
  assert.equal(BANNER_MIN_H, 200);
  assert.equal(BANNER_MAX_H, 1000);
  const sharp = decodeBanner(b64(devBannerPng(3000, 1000)));
  assert.deepEqual([sharp.width, sharp.height], [3000, 1000]);
  assert.ok(decodeBanner(b64(devBannerPng(2400, 800))));
  const best = decodeBanner(b64(devBannerPng(1500, 500)));
  assert.deepEqual([best.width, best.height, best.mime], [1500, 500, 'image/png']);
  const old = decodeBanner(b64(devBannerPng(1200, 300)));
  assert.deepEqual([old.width, old.height], [1200, 300]);
  assert.ok(decodeBanner(b64(devBannerPng(1200, 600))), '2:1 is the tallest shape allowed');
  const bad = (w, ht) => assert.throws(() => decodeBanner(b64(devBannerPng(w, ht))), (e) => e.status === 400 && e.code === 'bad_image_size', `${w}x${ht}`);
  bad(900, 600);
  bad(1500, 800);
  bad(1600, 300);
  bad(500, 200);
  bad(3100, 1000);
  bad(3000, 1100);
  bad(2000, 1100);
  bad(640, 160);
});

test('banner pictures can be up to 800 KB, well under the database row limit, and bigger ones are refused', async () => {
  assert.equal(BANNER_MAX, 800 * 1024);
  assert.ok(BANNER_MAX < 900 * 1024, 'a stored banner stays well under the 1 MB row limit');
  assert.ok(BANNER_BODY_LIMIT >= Math.ceil((BANNER_MAX * 4) / 3) + 1024, 'the request body fits a full size picture as base64');
  assert.ok(BANNER_BODY_LIMIT < 1.25 * 1024 * 1024);
  const huge = new Uint8Array(BANNER_MAX + 1);
  huge.set(devBannerPng(1500, 500));
  assert.throws(() => decodeBanner(b64(huge)), (e) => e.status === 413);
  const full = devBannerPng(1500, 500);
  assert.ok(full.length > 150 * 1024 && full.length <= BANNER_MAX, 'a detailed 1500 by 500 picture fits');
  assert.equal(decodeBanner(b64(full)).width, 1500);
});

test('a 1500 by 500 banner uploads, a sharp 3000 by 1000 one uploads, and an older 1200 by 300 one still uploads', async () => {
  const { h, alice } = await setup();
  const up = await h.api('POST', BANNER, alice, { image: b64(devBannerPng(1500, 500)) });
  assert.equal(up.status, 201);
  const { banner } = await up.json();
  assert.deepEqual([banner.width, banner.height], [1500, 500]);
  assert.equal((await h.request('GET', banner.url)).status, 200);
  const png = devBannerPng(3000, 1000);
  const padded = new Uint8Array(600 * 1024);
  const at = png.length - 12;
  padded.set(png.subarray(0, at));
  new DataView(padded.buffer).setUint32(at, padded.length - png.length - 12);
  padded.set(Buffer.from('tEXt'), at + 4);
  padded.set(png.subarray(at), padded.length - 12);
  const sharp = await h.api('POST', BANNER, alice, { image: b64(padded) });
  assert.equal(sharp.status, 201);
  const big = (await sharp.json()).banner;
  assert.deepEqual([big.width, big.height], [3000, 1000]);
  assert.equal(big.bytes, 600 * 1024, 'bigger than the old 450 KB cap');
  const served = await h.request('GET', big.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('Content-Length'), String(big.bytes));
  const over = new Uint8Array(BANNER_MAX + 1);
  over.set(devBannerPng(3000, 1000));
  assert.equal((await h.api('POST', BANNER, alice, { image: b64(over) })).status, 413, 'one byte over the cap is refused');
  const again = await h.api('POST', BANNER, alice, { image: b64(devBannerPng(1200, 300)) });
  assert.equal(again.status, 201);
  const tall = await h.api('POST', BANNER, alice, { image: b64(devBannerPng(800, 600)) });
  assert.equal(tall.status, 400);
  assert.match((await tall.json()).message, /1500 by 500/);
});

test('badge kinds: one-of-a-kind, special, party, season and achievements', () => {
  assert.equal(badgeTier('c-abcdefgh'), 'custom');
  assert.equal(badgeTier('einstein'), 'special');
  assert.equal(badgeTier('yapos-team'), 'special');
  assert.equal(badgeTier('first-game'), 'party');
  assert.equal(badgeTier('season-xp-1-2026-09'), 'season');
  assert.equal(badgeKindOf('ach:msgs1k'), 'achievement');
  assert.deepEqual(specialBadgesFirst(['first-game', 'einstein', 'season-xp-1-2026-09', 'c-abcdefgh', 'games-10', 'yapos-team', 'c-zzzzzzzz']),
    ['c-abcdefgh', 'c-zzzzzzzz', 'einstein', 'yapos-team', 'first-game', 'season-xp-1-2026-09', 'games-10']);
  assert.deepEqual(specialFirst([], () => 'party'), []);
  assert.deepEqual(specialFirst(null, () => 'party'), []);
});

test('public profiles and the Party card list pins first, then special badges, then the rest', async () => {
  const { h, alice } = await setup();
  const prof = await (await h.request('GET', '/api/u/alice', { ip: '203.0.113.91' })).json();
  assert.deepEqual(prof.profile.badges.slice(0, 2), ['vip', 'supporter']);
  assert.ok(prof.profile.badges.indexOf('first-game') > 1);
  assert.equal((await h.api('PUT', '/api/me/profile-look', alice, { pins: ['games-10'] })).status, 200);
  clearPartyProfileCache(h.db);
  const card = await buildCard(h.db, ALICE.id);
  assert.deepEqual(card.badges.slice(0, 3).map((b) => b.id), ['games-10', 'vip', 'supporter']);
  assert.equal(card.badges[1].rare, 'special');
  assert.equal(card.badges[0].rare, undefined);
  assert.ok(card.achievements.every((a) => a.rare === undefined), 'achievements are never marked as special badges');
});
