import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHarness, advance, USERS } from './helpers.js';
import { devBannerPng } from '../dev.mjs';
import { createWorker } from '../worker/app.js';
import { fetchYapinPicture, YAPIN_FETCH_MS } from '../worker/avatars.js';
import { monthOf, LEADERBOARD_GAMES, LEADERBOARD_BOARDS } from '../worker/party-leaderboard.js';
import { accountGroups } from '../web/js/shell.js';

const ALICE = USERS.alice;
const BOB = USERS.bob;
const CAROL = { id: '55555555-5555-4555-8555-555555555555', username: 'carol', display_name: 'Carol', avatar_url: 'https://files.yapper.website/c.png' };
const DAVE = { id: '55555555-5555-4555-8555-000000000004', username: 'dave', display_name: 'Dave', avatar_url: 'https://files.yapper.website/d.png' };
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
let ipN = 10;
const nextIp = () => `203.0.113.${(ipN = (ipN % 200) + 1)}`;

function seedPublic(h, user, { hidden = 0 } = {}) {
  h.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, 5, 400, NULL, '[]', '[]', '[]', NULL, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hidden = excluded.hidden")
    .run(user.id.toLowerCase(), user.username, user.username.toLowerCase(), user.display_name, hidden, h.clock.t);
}

async function likeSetup() {
  const h = createHarness();
  for (const u of [ALICE, BOB, CAROL, DAVE]) seedPublic(h, u);
  const c = {};
  for (const [k, u] of Object.entries({ alice: ALICE, bob: BOB, carol: CAROL, dave: DAVE })) c[k] = (await h.login(u)).cookie;
  return { h, ...c };
}

const like = (h, cookie, name, liked = true) => h.api('POST', `/api/likes/${name}`, cookie, { liked });

test('the liked-by cursor never carries a liker id, even for private likers on the same millisecond', async () => {
  const { h, alice, bob, carol, dave } = await likeSetup();
  await like(h, bob, 'alice');
  await like(h, carol, 'alice');
  await like(h, dave, 'alice');
  seedPublic(h, CAROL, { hidden: 1 });
  const seen = [];
  let next = null;
  for (let i = 0; i < 5; i++) {
    const q = next ? `?limit=1&before=${encodeURIComponent(next)}` : '?limit=1';
    const res = await h.api('GET', `/api/me/likes${q}`, alice);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const u of [BOB, CAROL, DAVE]) assert.equal(text.toLowerCase().includes(u.id.toLowerCase()), false, 'no liker id in the page');
    const page = JSON.parse(text);
    seen.push(...page.people.map((p) => p.name));
    if (page.next) assert.match(page.next, /^[0-9]+\.[0-9]+$/);
    next = page.next;
    if (!page.more) break;
  }
  assert.deepEqual(seen.sort(), ['Bob', 'Dave', 'Private profile']);
  const old = await h.api('GET', `/api/me/likes?limit=1&before=${encodeURIComponent(`${h.clock.t + 1}.${BOB.id}`)}`, alice);
  assert.equal(old.status, 200, 'an old style cursor is ignored, not an error');
});

test('a liker whose name staff hid shows as Someone with no picture in the note', async () => {
  const { h, bob } = await likeSetup();
  h.db.raw.prepare('INSERT INTO party_hidden_names (user_id, kind, reason, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?)').run(BOB.id.toLowerCase(), 'name', 'rude', 'staff', 'Staff', h.clock.t);
  assert.equal((await like(h, bob, 'alice')).status, 200);
  const n = h.db.raw.prepare("SELECT title, data FROM notifications WHERE user_id = ? AND kind = 'profile_like'").get(ALICE.id.toLowerCase());
  assert.equal(n.title, 'Someone liked your profile');
  assert.equal(JSON.parse(n.data).person, undefined);
});

test('likes cannot be used to probe private profiles or like through another account', async () => {
  const { h, alice, bob } = await likeSetup();
  seedPublic(h, CAROL, { hidden: 1 });
  const priv = await h.api('GET', '/api/likes/carol', bob);
  const none = await h.api('GET', '/api/likes/nobody-here', bob);
  assert.equal(priv.status, 404);
  assert.equal(none.status, 404);
  assert.deepEqual(await priv.json(), await none.json(), 'private and missing look the same');
  assert.equal((await like(h, bob, 'carol')).status, 404);
  const extra = await h.api('POST', '/api/likes/alice', bob, { liked: true, liker: DAVE.id });
  assert.equal(extra.status, 400);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_likes').get().n, 0);
  const notes = await (await h.api('GET', '/api/inbox', alice)).text();
  assert.equal(notes.includes('likers'), false);
});

function seedPoints(h, id, points) {
  h.db.raw.prepare('INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'N', 'n', points, points, points, points, 'trivia', 1000);
  for (const g of LEADERBOARD_GAMES) h.db.raw.prepare('INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, g, points, points, points, points, 1000);
  h.db.raw.prepare('INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, monthOf(h.clock.t), points, points, points, points, 'trivia', 1000);
}

test('no leaderboard parameter brings the owner back', async () => {
  const OWNER = ALICE.id;
  const h = createHarness({ PARTY_OWNER_ID: OWNER.toUpperCase() });
  seedPoints(h, OWNER.toUpperCase(), 99_000);
  seedPoints(h, uid(1), 10);
  seedPoints(h, uid(2), 5);
  const queries = [];
  for (const board of LEADERBOARD_BOARDS) {
    queries.push(`board=${board}`, `board=${board}&period=month`);
    for (const g of LEADERBOARD_GAMES) queries.push(`board=${board}&game=${g}`);
  }
  for (const extra of ['limit=1', 'limit=100000', 'limit=-3', 'offset=1&page=2', `me=${OWNER.toUpperCase()}`, `me=${OWNER}&limit=0`]) queries.push(`board=points&${extra}`);
  for (const q of queries) {
    const res = await h.request('GET', `/api/activity/leaderboard?${q}&me=${OWNER.toUpperCase()}`, { ip: nextIp() });
    assert.equal(res.status, 200, q);
    const text = await res.text();
    assert.equal(text.toLowerCase().includes(OWNER.toLowerCase()), false, q);
    const body = JSON.parse(text);
    assert.equal(body.me, null, q);
    assert.equal(body.meHidden, true, q);
    assert.ok(body.rows.length > 0 && body.rows[0].rank === 1, q);
  }
  const bad = await h.request('GET', `/api/activity/leaderboard?board=points&game=${encodeURIComponent("trivia' OR 1=1 --")}`, { ip: nextIp() });
  assert.equal(bad.status, 400);
});

test('global and season boards drop the owner whatever the case of the stored id', async () => {
  const OWNER = ALICE.id;
  const h = createHarness({ PARTY_OWNER_ID: ` ${OWNER.toUpperCase()} ` });
  const levels = [{ id: OWNER.toUpperCase(), rank: 1, name: 'Jolli', level: 99, xp: 9e6 }, { id: uid(1), rank: 2, name: 'A', level: 1, xp: 1 }];
  h.db.raw.prepare('INSERT INTO global_board (id, data, updated) VALUES (?, ?, ?)').run('global', JSON.stringify({ levels, economy: levels, updatedAt: 1 }), 1);
  for (const path of ['/api/public/global', '/api/public/global?limit=500&offset=0', '/api/public/GLOBAL']) {
    const res = await h.request('GET', path, { ip: nextIp() });
    if (res.status !== 200) continue;
    const text = await res.text();
    assert.equal(text.toLowerCase().includes(OWNER.toLowerCase()), false, path);
  }
  const entry = (id, rank, name) => ({ id, rank, name, username: name.toLowerCase(), value: 100 - rank });
  assert.equal((await h.bot('POST', '/bot/seasons', { month: '2026-09', boards: { xp: [entry(OWNER.toUpperCase(), 1, 'Jolli'), entry(uid(1), 2, 'Ann')], shards: [] } })).status, 200);
  for (const path of ['/api/seasons', '/api/seasons?month=2026-09&limit=100']) {
    const res = await h.request('GET', path, { ip: nextIp() });
    assert.equal(res.status, 200);
    const { seasons } = await res.json();
    const xp = seasons.find((s) => s.month === '2026-09').boards.xp;
    assert.deepEqual(xp.map((r) => [r.name, r.rank]), [['Ann', 1]], path);
  }
});

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const b of body) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function rgbaPng(w, fn) {
  const rows = [];
  for (let y = 0; y < w; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.set(fn(x, y), 1 + x * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('cut-out uploads still go through every picture check', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  const post = async (body) => {
    advance(h, 61_000);
    const res = await h.api('POST', '/api/me/profile-avatar', alice, body);
    return [res.status, (await res.json()).error];
  };
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><script>alert(1)</script></svg>');
  assert.equal((await post({ image: b64(svg), cutout: true, source: 'yapin' }))[0], 400, 'SVG is refused');
  assert.equal((await post({ image: `data:image/png;base64,${b64(svg)}`, cutout: true, source: 'yapin' }))[0], 400, 'a PNG label does not make SVG a PNG');
  const clear = (x, y) => (Math.hypot(x - 48, y - 48) < 30 ? [10, 200, 90, 255] : [0, 0, 0, 0]);
  const wide = rgbaPng(96, clear);
  const tooSmall = rgbaPng(8, () => [0, 0, 0, 0]);
  assert.equal((await post({ image: b64(tooSmall), cutout: true, source: 'yapin' }))[0], 400, 'size rules still apply');
  assert.deepEqual(await post({ image: b64(devBannerPng(96, 96)), cutout: true, source: 'yapin' }), [400, 'bad_cutout'], 'opaque pictures are not cut-outs');
  assert.deepEqual(await post({ image: b64(wide), cutout: true, source: 'elsewhere' }), [400, 'bad_cutout']);
  assert.deepEqual(await post({ image: b64(wide), cutout: true, source: 'upload' }), [400, 'no_original'], 'an upload-source cut-out needs a kept original');
  const huge = Buffer.concat([wide, Buffer.alloc(300 * 1024)]);
  assert.equal((await post({ image: b64(huge), cutout: true, source: 'yapin' }))[0], 413);
  advance(h, 61_000);
  const ok = await h.api('POST', '/api/me/profile-avatar', alice, { image: b64(wide), cutout: true, source: 'yapin', backdrop: 'clear' });
  assert.equal(ok.status, 201);
  const patch = await h.api('PATCH', '/api/me/profile-avatar', alice, { backdrop: 'url(javascript:1)' });
  assert.equal(patch.status, 400);
  const orig = await h.api('GET', '/api/me/profile-avatar/original', alice);
  assert.equal(orig.status, 404, 'a Yapin-source cut-out has no stored original to read back');
  assert.equal((await h.api('GET', '/api/me/profile-avatar/original', null)).status, 401);
});

function streamOf(total, chunkSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= total) return ctrl.close();
      const n = Math.min(chunkSize, total - sent);
      sent += n;
      ctrl.enqueue(new Uint8Array(n));
    },
  });
}

test('the Yapin picture copy is not an open proxy and has size and time limits', async () => {
  const png = devBannerPng(96, 96);
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return new Response(png, { status: 200 });
  };
  for (const url of [
    'http://files.yapper.website/avatars/a.png',
    'https://evil.example/a.png',
    'https://files.yapper.website.evil.example/a.png',
    'https://files.yapper.website:8443/a.png',
    'https://user:pw@files.yapper.website/a.png',
    'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '',
    null,
  ]) {
    await assert.rejects(fetchYapinPicture(url, ok), (err) => err.status === 404, String(url));
  }
  assert.equal(calls.length, 0, 'nothing outside the Yapin hosts is ever fetched');
  const got = await fetchYapinPicture('https://files.yapper.website/avatars/a.png', ok);
  assert.equal(got.mime, 'image/png');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal, 'the fetch can be cut off');
  const unsized = async () => new Response(streamOf(5 * 1024 * 1024), { status: 200 });
  await assert.rejects(fetchYapinPicture('https://www.yapin.gg/a.png', unsized), (err) => err.status === 413, 'a body with no length is still capped');
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const t0 = Date.now();
  await assert.rejects(fetchYapinPicture('https://www.yapin.gg/a.png', hang, { timeoutMs: 50 }), (err) => err.status === 502);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(YAPIN_FETCH_MS > 0 && YAPIN_FETCH_MS <= 10_000);
  const svg = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200, headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(fetchYapinPicture('https://www.yapin.gg/a.png', svg), (err) => err.status === 502, 'only real image bytes pass');
  const moved = async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } });
  await assert.rejects(fetchYapinPicture('https://www.yapin.gg/a.png', moved), (err) => err.status === 502);
});

test('the Yapin copy route only ever fetches the signed-in person’s own picture', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  const seen = [];
  const worker = createWorker({
    now: () => h.clock.t,
    log: () => {},
    fetch: async (url) => {
      seen.push(String(url));
      return new Response(devBannerPng(96, 96), { status: 200 });
    },
  });
  const get = (p) => worker.fetch(new Request(`${h.base}${p}`, { headers: { Cookie: alice, 'CF-Connecting-IP': nextIp() } }), h.env, { waitUntil() {} });
  for (const p of ['/api/me/profile-avatar/yapin?url=https://evil.example/x.png', `/api/me/profile-avatar/yapin?user=${BOB.id}`]) {
    const res = await get(p);
    assert.equal(res.status, 200);
  }
  assert.deepEqual([...new Set(seen)], [ALICE.avatar_url]);
  const post = await worker.fetch(new Request(`${h.base}/api/me/profile-avatar/yapin`, { method: 'POST', headers: { Cookie: alice, 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://evil.example/x.png' }) }), h.env, { waitUntil() {} });
  assert.notEqual(post.status, 200);
});

test('picture looks only hand out checked hex colours', async () => {
  const h = createHarness();
  seedPublic(h, ALICE);
  const alice = (await h.login(ALICE)).cookie;
  const clear = (x, y) => (Math.hypot(x - 48, y - 48) < 30 ? [10, 200, 90, 255] : [0, 0, 0, 0]);
  const up = await (await h.api('POST', '/api/me/profile-avatar', alice, { image: b64(rgbaPng(96, clear)), cutout: true, source: 'yapin' })).json();
  const id = /a-[a-z0-9]{10}/.exec(up.custom.url)[0];
  const evil = 'red;background:url(https://evil.example/x)';
  h.db.raw.prepare('INSERT INTO profile_custom (user_id, v, data, updated) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data').run(ALICE.id.toLowerCase(), JSON.stringify({ v: 1, accent: evil, nameColour: evil, nameGradientCustom: { a: evil, b: evil } }), h.clock.t);
  const res = await h.request('GET', `/api/avatars/looks?ids=${id},${encodeURIComponent('../x')},a-zzzzzzzzzz`, { ip: nextIp() });
  assert.equal(res.status, 200);
  const { looks } = await res.json();
  assert.deepEqual(Object.keys(looks), [id]);
  for (const c of [...looks[id].stops, looks[id].ring]) assert.match(c, /^#[0-9a-f]{6}$/);
  seedPublic(h, ALICE, { hidden: 1 });
  advance(h, 61_000);
  const hidden = await (await h.request('GET', `/api/avatars/looks?ids=${id}`, { ip: nextIp() })).json();
  assert.deepEqual(hidden.looks, {}, 'private profiles give nothing away');
});

test('staff and owner menu items follow the server roles, and their routes are still checked', async () => {
  const user = { username: 'sam' };
  const ids = (o) => accountGroups(o).flatMap((g) => g.items.map((i) => i.id));
  assert.equal(ids({ user }).some((i) => ['party-reports', 'party-modlog', 'owner', 'party'].includes(i)), false);
  assert.deepEqual(ids({ user, partyAdmin: true }).filter((i) => ['party-reports', 'party-modlog', 'owner', 'party'].includes(i)), ['party-reports', 'party-modlog']);
  assert.deepEqual(ids({ user, partyOwner: true, partyAdmin: true }).filter((i) => ['owner', 'party'].includes(i)), ['owner', 'party']);
  assert.deepEqual(accountGroups({ user: null, partyOwner: true }), []);
  const h = createHarness({ PARTY_OWNER_ID: ALICE.id });
  const bob = (await h.login(BOB)).cookie;
  const me = await (await h.api('GET', '/api/me', bob)).json();
  assert.equal(me.partyOwner, false);
  assert.equal(me.partyAdmin, false);
  for (const p of ['/api/party/reports', '/api/party/modlog', '/api/party/admins', '/api/owner/users']) {
    const res = await h.api('GET', p, bob);
    assert.ok([403, 404].includes(res.status), `${p} -> ${res.status}`);
  }
  assert.ok([403, 404].includes((await h.api('POST', '/api/party/admins', bob, { id: BOB.id })).status));
  assert.ok([401, 403, 404].includes((await h.api('GET', '/api/party/reports', null)).status));
});
