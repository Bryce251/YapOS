import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { devBadgePng } from '../dev.mjs';
import { sniffImage, decodeImage, cleanEmoji, botCustomBadges, MAX_CUSTOM_BADGES, BADGE_IMAGE_MAX, CUSTOM_BADGE_RE } from '../worker/custom-badges.js';
import { buildCard } from '../worker/party-profile.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const png = (size = 32) => new Uint8Array(devBadgePng(size));

function webp(w = 128, h = 128) {
  const bits = (w - 1) | ((h - 1) << 14) | (1 << 28);
  const data = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, ...new Array(11).fill(0)];
  const out = Buffer.alloc(20 + data.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WEBP', 8, 'ascii');
  out.write('VP8L', 12, 'ascii');
  out.writeUInt32LE(data.length, 16);
  Buffer.from(data).copy(out, 20);
  return new Uint8Array(out);
}

function jpeg(w = 64, h = 64) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

async function setup() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  const owner = (await h.login(OWNER)).cookie;
  const bob = (await h.login(BOB)).cookie;
  return { h, owner, bob };
}

async function make(h, cookie, body) {
  const res = await h.api('POST', '/api/owner/badges', cookie, body);
  return { status: res.status, body: await res.json() };
}

test('pictures are checked by their bytes: PNG, WebP and JPEG pass, everything else is refused', () => {
  assert.deepEqual(sniffImage(png(32)), { mime: 'image/png', width: 32, height: 32 });
  assert.deepEqual(sniffImage(webp(128, 128)), { mime: 'image/webp', width: 128, height: 128 });
  assert.deepEqual(sniffImage(jpeg(64, 48)), { mime: 'image/jpeg', width: 64, height: 48 });
  assert.equal(decodeImage(`data:image/png;base64,${b64(png())}`).mime, 'image/png');
  assert.equal(decodeImage(`data:image/png;base64,${b64(webp())}`).mime, 'image/webp', 'the declared type is ignored');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = new TextEncoder().encode('<!doctype html><html><body>hi</body></html>');
  for (const bad of [svg, html, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])]) {
    assert.equal(sniffImage(bad), null);
    assert.throws(() => decodeImage(`data:image/png;base64,${b64(bad)}`), (e) => e.status === 400 && e.code === 'bad_image');
  }
  const cut = png().slice(0, -12);
  assert.equal(sniffImage(cut), null, 'a cut-off PNG is refused');
  const fakeWebp = webp();
  fakeWebp[4] += 1;
  assert.equal(sniffImage(fakeWebp), null, 'a WebP with the wrong size is refused');
  assert.throws(() => decodeImage(b64(png(8))), (e) => e.code === 'bad_image_size');
  assert.throws(() => decodeImage(b64(webp(1024, 1024))), (e) => e.code === 'bad_image_size');
  const big = new Uint8Array(BADGE_IMAGE_MAX + 10);
  big.set(png());
  assert.throws(() => decodeImage(b64(big)), (e) => e.status === 413);
  assert.throws(() => decodeImage('not base64 !!'), (e) => e.code === 'bad_image');
  assert.equal(cleanEmoji(''), '\u{1F3C5}');
  assert.equal(cleanEmoji('\u{1F9E0}'), '\u{1F9E0}');
  for (const bad of ['abc', '<b>', '\u{1F9E0} hi', 'x'.repeat(20)]) assert.throws(() => cleanEmoji(bad), (e) => e.code === 'bad_emoji');
});

test('only the owner can make, list, edit or delete badges, and writes need the CSRF header', async () => {
  const { h, owner, bob } = await setup();
  const body = { name: 'Galaxy brain', note: 'Can only be given by Jolli', emoji: '\u{1F30C}', image: `data:image/png;base64,${b64(png())}` };
  assert.equal((await h.api('GET', '/api/owner/badges', bob)).status, 404);
  assert.equal((await h.api('GET', '/api/owner/badges', null)).status, 404);
  assert.equal((await make(h, bob, body)).status, 404);
  assert.equal((await h.api('POST', '/api/owner/badges', owner, body, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', '/api/owner/badges', owner, body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM custom_badges').get().n, 0);

  const made = await make(h, owner, body);
  assert.equal(made.status, 201);
  const b = made.body.badge;
  assert.match(b.id, CUSTOM_BADGE_RE);
  assert.equal(b.name, 'Galaxy brain');
  assert.equal(b.note, 'Can only be given by Jolli');
  assert.equal(b.emoji, '\u{1F30C}');
  assert.match(b.image, new RegExp(`^/badge-img/${b.id}-[0-9a-f]{16}\\.png$`));
  assert.equal(b.holders, 0);

  assert.equal((await h.api('PATCH', `/api/owner/badges/${b.id}`, bob, { name: 'Mine' })).status, 404);
  assert.equal((await h.api('DELETE', `/api/owner/badges/${b.id}`, bob)).status, 404);
  assert.equal((await h.api('DELETE', `/api/owner/badges/${b.id}`, owner, undefined, { 'X-YapOS': null })).status, 403);

  const list = await (await h.api('GET', '/api/owner/badges', owner)).json();
  assert.equal(list.badges.length, 1);
  assert.equal(list.max, MAX_CUSTOM_BADGES);
  assert.equal('image' in list.badges[0] && typeof list.badges[0].image, 'string');

  const log = h.db.raw.prepare('SELECT action, detail FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['owner_badge_create']);
  assert.equal(JSON.parse(log[0].detail).name, 'Galaxy brain');
});

test('bad uploads are refused with plain reasons and nothing is stored', async () => {
  const { h, owner } = await setup();
  const svg = `data:image/svg+xml;base64,${b64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))}`;
  const html = `data:image/png;base64,${b64(new TextEncoder().encode('<html><script>alert(1)</script></html>'))}`;
  const cases = [
    [{ name: 'X', image: svg }, 400, /PNG, JPG or WebP/],
    [{ name: 'X', image: html }, 400, /PNG, JPG or WebP/],
    [{ name: '', image: `data:image/png;base64,${b64(png())}` }, 400, /name/],
    [{ name: 'x'.repeat(33), image: `data:image/png;base64,${b64(png())}` }, 400, /32 characters/],
    [{ name: 'X', note: 'n'.repeat(101), image: `data:image/png;base64,${b64(png())}` }, 400, /100 characters/],
    [{ name: 'X', emoji: 'hello', image: `data:image/png;base64,${b64(png())}` }, 400, /emoji/],
    [{ name: 'X' }, 400, /picture/],
    [{ name: 'X', image: `data:image/png;base64,${b64(new Uint8Array(BADGE_IMAGE_MAX + 100))}` }, 413, /too big/],
    [{ name: 'X', image: `data:image/png;base64,${b64(png())}`, extra: 1 }, 400, /Unknown field/],
  ];
  for (const [body, status, text] of cases) {
    const r = await make(h, owner, body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    assert.match(r.body.message, text);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM custom_badges').get().n, 0);
  const first = await make(h, owner, { name: 'Twin', image: b64(jpeg()) });
  assert.equal(first.status, 201);
  assert.match(first.body.badge.image, /\.jpg$/);
  const twin = await make(h, owner, { name: 'twin', image: b64(webp()) });
  assert.equal(twin.status, 409);
});

test('there is a cap on how many badges can exist', async () => {
  const { h, owner } = await setup();
  const ins = h.db.raw.prepare('INSERT INTO custom_badges (id, name, note, emoji, image, mime, hash, width, height, bytes, created, updated) VALUES (?, ?, NULL, ?, ?, ?, ?, 32, 32, 10, ?, ?)');
  for (let i = 0; i < MAX_CUSTOM_BADGES; i++) ins.run(`c-${String(i).padStart(8, '0')}`, `B${i}`, '\u{1F3C5}', png(), 'image/png', '0'.repeat(16), i, i);
  const r = await make(h, owner, { name: 'One more', image: b64(png()) });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /100 badges/);
});

test('pictures are served with their own type, nosniff, a locked-down CSP and long caching', async () => {
  const { h, owner } = await setup();
  const made = (await make(h, owner, { name: 'Served', image: b64(webp()) })).body.badge;
  const res = await h.request('GET', made.image);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.match(res.headers.get('Cache-Control'), /max-age=31536000/);
  assert.match(res.headers.get('Cache-Control'), /immutable/);
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(bytes, webp());
  const head = await h.request('HEAD', made.image);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const wrong of [made.image.replace(/-[0-9a-f]{16}\./, '-0000000000000000.'), made.image.replace('.webp', '.png'), '/badge-img/c-nothere1-0000000000000000.png', '/badge-img/', '/badge-img/c-nothere1.svg']) {
    const r = await h.request('GET', wrong);
    assert.equal(r.status, 404, wrong);
    assert.equal(r.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  }
  assert.equal((await h.request('POST', made.image)).status, 405);

  const edited = await (await h.api('PATCH', `/api/owner/badges/${made.id}`, owner, { image: b64(png()) })).json();
  assert.notEqual(edited.badge.image, made.image, 'a new picture gets a new address');
  assert.deepEqual(edited.changed, ['picture']);
  assert.equal((await h.request('GET', made.image)).status, 404);
  const fresh = await h.request('GET', edited.badge.image);
  assert.equal(fresh.headers.get('Content-Type'), 'image/png');
});

test('custom badges go through the owner actions path, reach the bot, and deleting takes them off everyone', async () => {
  const { h, owner } = await setup();
  const made = (await make(h, owner, { name: 'Galaxy brain', note: 'Only from Jolli', emoji: '\u{1F30C}', image: b64(png()) })).body.badge;
  const detail = await (await h.api('GET', `/api/owner/users/${BOB.id}`, owner)).json();
  const entry = detail.catalog.badges.find((x) => x.id === made.id);
  assert.deepEqual(entry, { id: made.id, label: 'Galaxy brain', emoji: '\u{1F30C}', source: 'custom', image: made.image, note: 'Only from Jolli' });

  const first = await h.poll();
  assert.equal(first.customBadges, undefined, 'a bot that does not ask gets nothing new');
  const asked = await (await h.bot('GET', '/bot/poll?wait=0&badges=')).json();
  assert.ok(asked.customBadges.version);
  assert.deepEqual(asked.customBadges.badges, [{ id: made.id, label: 'Galaxy brain', emoji: '\u{1F30C}', note: 'Only from Jolli' }]);
  const same = await (await h.bot('GET', `/bot/poll?wait=0&badges=${encodeURIComponent(asked.customBadges.version)}`)).json();
  assert.equal(same.customBadges, undefined, 'nothing is sent again until something changes');

  const give = await h.api('POST', '/api/owner/actions', owner, { user: BOB.id, kind: 'badge.grant', id: made.id.toUpperCase() });
  assert.equal(give.status, 201);
  const action = (await give.json()).action;
  assert.equal(action.ref, made.id);
  assert.equal(action.status, 'queued');
  const fake = '99999999-9999-4999-8999-999999999999';
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, NULL, NULL, NULL, 1, ?)').run(fake, h.clock.t);
  assert.equal((await h.api('POST', '/api/owner/actions', owner, { user: fake, kind: 'badge.grant', id: made.id })).status, 400, 'fake accounts are refused');
  const notAll = await h.api('POST', '/api/owner/actions', owner, { user: BOB.id, kind: 'badge.grant', id: 'c-zzzzzzzz' });
  assert.equal(notAll.status, 400);

  const rows = (await h.poll()).owner;
  assert.deepEqual(rows.map((r) => [r.kind, r.ref]), [['badge.grant', made.id]]);
  await h.bot('POST', '/bot/owner/results', { results: [{ id: action.id, ok: true, message: 'Gave the badge.', after: { badges: ['first-game', made.id] } }] });
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, 'bob', 'bob', 'Bob', 3, 300, NULL, ?, '[]', '[]', NULL, 0, ?) ON CONFLICT (user_id) DO UPDATE SET badges = excluded.badges")
    .run(BOB.id, JSON.stringify(['first-game', made.id]), h.clock.t);

  const profile = await (await h.request('GET', '/api/u/bob')).json();
  assert.ok(profile.profile.badges.includes(made.id));
  assert.deepEqual(profile.catalog.badges.find((x) => x.id === made.id), { id: made.id, label: 'Galaxy brain', emoji: '\u{1F30C}', image: made.image, note: 'Only from Jolli' });
  const card = await buildCard(h.db, BOB.id);
  assert.deepEqual(card.badges.find((x) => x.id === made.id), { id: made.id, label: 'Galaxy brain', emoji: '\u{1F30C}', image: made.image, note: 'Only from Jolli' });

  const list = await (await h.api('GET', '/api/owner/badges', owner)).json();
  assert.equal(list.badges[0].holders, 1);

  const queued = (await (await h.api('POST', '/api/owner/actions', owner, { user: OWNER.id, kind: 'badge.grant', id: made.id })).json()).action;
  const del = await h.api('DELETE', `/api/owner/badges/${made.id}`, owner);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, deleted: made.id, holders: 1 });
  const after = h.db.raw.prepare('SELECT status, result FROM owner_actions WHERE id = ?').get(queued.id);
  assert.equal(after.status, 'failed');
  assert.match(after.result, /deleted/);

  const gone = await (await h.bot('GET', `/bot/poll?wait=0&badges=${encodeURIComponent(asked.customBadges.version)}`)).json();
  assert.deepEqual(gone.customBadges.badges, [], 'the bot hears the badge is gone');
  const profileAfter = await (await h.request('GET', '/api/u/bob')).json();
  assert.equal(profileAfter.profile.badges.includes(made.id), false);
  assert.ok(profileAfter.profile.badges.includes('first-game'));
  const cardAfter = await buildCard(h.db, BOB.id);
  assert.equal(cardAfter.badges.some((x) => x.id === made.id), false);
  const ownerView = await (await h.api('GET', `/api/owner/users/${BOB.id}`, owner)).json();
  assert.equal(ownerView.user.badges.includes(made.id), false);
  assert.equal(ownerView.catalog.badges.some((x) => x.id === made.id), false);
  assert.equal((await h.request('GET', made.image)).status, 404);

  const log = h.db.raw.prepare('SELECT action, detail FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['owner_badge_create', 'owner_badge_delete']);
  assert.equal(JSON.parse(log[1].detail).holders, 1);
});

test('a stale bot catalog never brings a deleted custom badge back', async () => {
  const { h, owner } = await setup();
  await h.bot('POST', '/bot/owner/catalog', { achievements: [], badges: [{ id: 'c-oldoldol', label: 'Old', emoji: '\u{1F3C5}' }, { id: 'founder', label: 'Founder', emoji: '\u{1F6E1}' }] });
  const detail = await (await h.api('GET', `/api/owner/users/${BOB.id}`, owner)).json();
  assert.equal(detail.catalog.badges.some((x) => x.id === 'c-oldoldol'), false);
  assert.ok(detail.catalog.badges.some((x) => x.id === 'founder'));
  assert.equal((await h.api('POST', '/api/owner/actions', owner, { user: BOB.id, kind: 'badge.grant', id: 'c-oldoldol' })).status, 400);
});

test('if the badge list cannot be read, the bot is sent nothing instead of an empty list that would wipe everyone', async () => {
  const flaky = {
    prepare(sql) {
      const stmt = {
        bind: () => stmt,
        first: async () => ({ n: 2, m: 5, s: 9 }),
        all: async () => { if (/FROM custom_badges/.test(sql)) throw new Error('D1 hiccup'); return { results: [] }; },
      };
      return stmt;
    },
  };
  assert.equal(await botCustomBadges(flaky, ''), null);
  assert.equal(await botCustomBadges(flaky, 'old'), null);
});

test('the badge cap holds even when the count check is passed at the same time', async () => {
  const { h, owner } = await setup();
  const ins = h.db.raw.prepare('INSERT INTO custom_badges (id, name, note, emoji, image, mime, hash, width, height, bytes, created, updated) VALUES (?, ?, NULL, ?, ?, ?, ?, 32, 32, 10, ?, ?)');
  for (let i = 0; i < MAX_CUSTOM_BADGES - 1; i++) ins.run(`c-${String(i).padStart(8, '0')}`, `B${i}`, '\u{1F3C5}', png(), 'image/png', '0'.repeat(16), i, i);
  const both = await Promise.all([make(h, owner, { name: 'Race one', image: b64(png()) }), make(h, owner, { name: 'Race two', image: b64(png()) })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM custom_badges').get().n, MAX_CUSTOM_BADGES);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_mod_log WHERE action = 'owner_badge_create'").get().n, 1);
});

test('polyglot and smuggled pictures are refused or served so they can never run', async () => {
  const { h, owner } = await setup();
  const tail = new TextEncoder().encode('<html><script>alert(1)</script></html>');
  const glued = new Uint8Array([...png(), ...tail]);
  assert.equal(sniffImage(glued), null, 'markup glued after the PNG end is refused');
  const r = await make(h, owner, { name: 'Glued', image: b64(glued) });
  assert.equal(r.status, 400);
  const jpgTail = new Uint8Array([...jpeg(), ...tail]);
  assert.equal(sniffImage(jpgTail), null);
  const huge = png();
  huge.set([0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10], 16);
  assert.throws(() => decodeImage(b64(huge)), (e) => e.code === 'bad_image_size', 'a picture that claims to be huge is refused');
  const made = (await make(h, owner, { name: 'Fine', image: b64(png()) })).body.badge;
  for (const sneaky of [`/badge-img/${made.id}-${made.image.slice(-20, -4)}.png/..%2f..%2fapi`, `/badge-img/%2e%2e/${made.id}.png`, `${made.image}?x=<script>`, made.image.toUpperCase()]) {
    const res = await h.request('GET', sneaky);
    if (sneaky.includes('?x=')) {
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'image/png');
    } else {
      assert.equal(res.status, 404, sneaky);
    }
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
});
