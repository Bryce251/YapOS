import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const STROKE = encodeStroke({ c: 1, z: 1, pts: [[10, 10], [40, 40], [80, 20]] });
const REX = uid(1);

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function addAdmin(h, id) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(id, OWNER.id, 1);
}

function seed(h, i, { game = 'odd', drawer = REX, reporter = uid(200 + i), created, status = 'open', text = null, replay = null } = {}) {
  const id = `seed${String(i).padStart(4, '0')}`;
  h.db.raw
    .prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, ?, ?, 'Rex', 'rexplorer', ?, 'Reporter', ?, NULL, 1, ?, 'seed', ?)")
    .run(id, game, drawer, reporter, text ? '[]' : JSON.stringify([STROKE]), created ?? h.clock.t - i * 1000, status);
  if (text) h.db.raw.prepare("INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES (?, ?, NULL, 'seed', ?)").run(id, text, h.clock.t);
  if (replay) h.db.raw.prepare('INSERT INTO party_report_replays (report_id, data, created) VALUES (?, ?, ?)').run(id, JSON.stringify(replay), h.clock.t);
  return id;
}

test('the person view lists every report against someone with counts, replays and ban history', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const replay = { v: 1, kind: 'ink', authors: [{ id: REX, name: 'Rex' }], events: [[0, 0, STROKE]] };
  seed(h, 1, { game: 'draw', replay, created: h.clock.t - 1000 });
  seed(h, 2, { game: 'draw', status: 'dismissed', created: h.clock.t - 5000 });
  seed(h, 3, { game: 'hottakes', text: 'rude words', created: h.clock.t - 9000 });
  seed(h, 4, { drawer: uid(9), reporter: REX });
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?)').run(REX, 'realrex', 'Real Rex', h.clock.t);
  const { cookie } = await h.login(BOB);
  const ban = await h.api('POST', '/api/party/bans', cookie, { id: REX, reason: 'Drew rude stuff', name: 'Rex' });
  assert.equal(ban.status, 200);
  const res = await h.api('GET', `/api/party/reports/person/${REX.toUpperCase()}`, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, 'admin');
  assert.equal(body.person.id, REX);
  assert.equal(body.person.username, 'realrex');
  assert.equal(body.person.name, 'Real Rex');
  assert.equal(body.person.role, null);
  assert.equal(body.person.banned.reason, 'Drew rude stuff');
  assert.equal(body.person.banned.by, BOB.id);
  assert.deepEqual(body.reports.map((r) => r.id), ['seed0001', 'seed0002', 'seed0003']);
  assert.equal(body.reports[0].replay.authors[0].id, REX);
  assert.equal(body.reports[2].kind, 'text');
  assert.equal(body.reports[2].text, 'rude words');
  assert.deepEqual([body.counts.total, body.counts.open, body.counts.made], [3, 2, 1]);
  assert.equal(body.counts.first, h.clock.t - 9000);
  assert.equal(body.counts.last, h.clock.t - 1000);
  assert.deepEqual(body.counts.games, [{ game: 'draw', n: 2, drawings: 2 }, { game: 'hottakes', n: 1, drawings: 0 }]);
  assert.deepEqual(body.bans.map((b) => [b.action, b.reason, b.by]), [['ban', 'Drew rude stuff', BOB.id]]);
  assert.equal(body.more, false);
  assert.ok(!JSON.stringify(body).includes('ip_hash'));
  assert.equal((await h.api('DELETE', `/api/party/bans/${REX}`, cookie)).status, 200);
  const again = await (await h.api('GET', `/api/party/reports/person/${REX}`, cookie)).json();
  assert.equal(again.person.banned, null);
  assert.deepEqual(again.bans.map((b) => b.action), ['unban', 'ban']);
});

test('staff can dismiss every open report for one person at once', async () => {
  const h = party();
  seed(h, 1);
  seed(h, 2);
  seed(h, 3, { drawer: uid(9) });
  const { cookie } = await h.login(OWNER);
  const res = await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, cookie, {});
  assert.deepEqual(await res.json(), { ok: true, dismissed: 2 });
  const rows = h.db.raw.prepare('SELECT id, status, dismissed_by FROM party_reports ORDER BY id').all().map((r) => [r.id, r.status, r.dismissed_by]);
  assert.deepEqual(rows, [['seed0001', 'dismissed', OWNER.id], ['seed0002', 'dismissed', OWNER.id], ['seed0003', 'open', null]]);
  assert.deepEqual(await (await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, cookie, {})).json(), { ok: true, dismissed: 0 });
  assert.equal((await h.api('GET', `/api/party/reports/person/${REX}/dismiss`, cookie)).status, 405);
  assert.equal((await h.api('DELETE', `/api/party/reports/person/${REX}`, cookie)).status, 405);
  assert.equal((await h.api('GET', `/api/party/reports/person/${encodeURIComponent('bad id!')}`, cookie)).status, 400);
  assert.equal((await h.api('GET', `/api/party/reports/person/${REX}/x/y`, cookie)).status, 404);
});

test('the person view and dismiss-all are only for party staff', async () => {
  const h = party();
  seed(h, 1);
  const b = await h.login(BOB);
  for (const [method, path, body] of [['GET', `/api/party/reports/person/${REX}`], ['POST', `/api/party/reports/person/${REX}/dismiss`, {}]]) {
    const res = await h.api(method, path, b.cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'staff_only');
  }
  assert.equal((await h.api('GET', `/api/party/reports/person/${REX}`)).status, 401);
  const a = await h.login(OWNER);
  assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, a.cookie, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(h.db.raw.prepare("SELECT status FROM party_reports WHERE id = 'seed0001'").get().status, 'open');
});

test('an empty history still answers with the person and zero counts', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const body = await (await h.api('GET', `/api/party/reports/person/${uid(42)}`, cookie)).json();
  assert.equal(body.person.id, uid(42));
  assert.deepEqual(body.reports, []);
  assert.deepEqual([body.counts.total, body.counts.open, body.counts.first, body.counts.last], [0, 0, null, null]);
  assert.deepEqual(body.bans, []);
  assert.equal(body.role, 'owner');
});

test('a party admin cannot dismiss or delete reports about themselves, but the owner can', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const one = seed(h, 1, { drawer: BOB.id });
  const two = seed(h, 2, { drawer: BOB.id });
  const three = seed(h, 3, { drawer: BOB.id });
  const b = await h.login(BOB);
  for (const [method, path, body] of [['POST', `/api/party/reports/person/${BOB.id}/dismiss`, {}], ['POST', `/api/party/reports/${one}/dismiss`, {}], ['DELETE', `/api/party/reports/${two}`]]) {
    const res = await h.api(method, path, b.cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'is_self');
  }
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE status = 'open'").get().n, 3);
  const o = await h.login(OWNER);
  assert.equal((await h.api('DELETE', `/api/party/reports/${three}`, o.cookie)).status, 200);
  assert.deepEqual(await (await h.api('POST', `/api/party/reports/person/${BOB.id}/dismiss`, o.cookie, {})).json(), { ok: true, dismissed: 2 });
});
