import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHarness, USERS } from './helpers.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { flaggedPeople, FLAG_GAMES, FLAG_REPORTERS } from '../worker/reports.js';
import { createActivitySession } from '../worker/activity-auth.js';
import { isOffBoard } from '../worker/party-leaderboard.js';
import { cleanup } from '../worker/cron.js';
import { BAN_DURATIONS, WARNING_MAX, WARNINGS_PER_TARGET_HOUR, MODLOG_PAGE, logModAction, activeBanIds, cleanDuration, banUntilFor, detailJson, ownerLogAction } from '../worker/party-mod.js';
import { LIMITS } from '../worker/rate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER = USERS.alice;
const BOB = USERS.bob;
const CARL = { id: '55555555-5555-4555-8555-555555555555', username: 'carl', display_name: 'Carl', avatar_url: null };
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const REX = uid(1);
const REX_USER = { id: REX, username: 'rex', display_name: 'Rex', avatar_url: null };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STROKE = encodeStroke({ c: 1, z: 1, pts: [[10, 10], [40, 40], [80, 20]] });
const SLUR = decodeTerm('mktwhp');

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function addAdmin(h, id) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(id, OWNER.id, 1);
}

let serial = 0;
function seed(h, { drawer = REX, reporter = uid(2), game = 'draw', ago = 0, ip = null } = {}) {
  serial += 1;
  const rid = `mc${String(serial).padStart(6, '0')}`;
  h.db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, ?, ?, 'Rex', 'rex', ?, 'Reporter', ?, NULL, 1, ?, ?, 'open')")
    .run(rid, game, drawer, reporter, JSON.stringify([STROKE]), h.clock.t - ago, ip || `ip-${reporter}`);
  return rid;
}

const modlog = (h) => h.db.raw.prepare('SELECT * FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
const warnings = (h) => h.db.raw.prepare('SELECT * FROM party_warnings ORDER BY created ASC, id ASC').all();

async function staff(h, user = OWNER) {
  return (await h.login(user)).cookie;
}

async function ban(h, cookie, body) {
  return h.api('POST', '/api/party/bans', cookie, { id: REX, name: 'Rex', ...body });
}

async function adminsSay(h, ids = [REX]) {
  return (await h.request('GET', `/api/activity/admins?ids=${ids.join(',')}`, { ip: `198.51.100.${(serial++ % 200) + 1}` })).json();
}

async function person(h, cookie, id = REX) {
  return (await h.api('GET', `/api/party/reports/person/${id}`, cookie)).json();
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

test('ban lengths are fixed and default to forever', () => {
  assert.deepEqual(Object.keys(BAN_DURATIONS), ['hour', 'day', 'week', 'forever']);
  assert.equal(BAN_DURATIONS.hour, HOUR);
  assert.equal(BAN_DURATIONS.day, DAY);
  assert.equal(BAN_DURATIONS.week, 7 * DAY);
  assert.equal(cleanDuration(undefined), 'forever');
  assert.equal(cleanDuration(null), 'forever');
  assert.throws(() => cleanDuration('month'), /1 hour, 1 day, 1 week or forever/);
  assert.throws(() => cleanDuration(3600000));
  assert.equal(banUntilFor('forever', 1000), null);
  assert.equal(banUntilFor('hour', 1000), 1000 + HOUR);
  assert.ok(LIMITS.modWarnings > 0 && LIMITS.modWarnings <= 20);
  assert.ok(LIMITS.activityWarnings > 0);
});

test('a 1 hour ban applies right up to its end and stops by itself on the dot', async () => {
  const h = party();
  const owner = await staff(h);
  const t0 = h.clock.t;
  const res = await ban(h, owner, { reason: 'Rude drawings', duration: 'hour' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.banned, true);
  assert.equal(body.duration, 'hour');
  assert.equal(body.bans[0].until, t0 + HOUR);
  assert.equal(body.bans[0].duration, 'hour');
  let admins = await adminsSay(h);
  assert.deepEqual(admins.banned, [REX]);
  assert.deepEqual(admins.until, { [REX]: t0 + HOUR });
  const p = await person(h, owner);
  assert.equal(p.person.banned.until, t0 + HOUR);
  assert.equal(p.person.banned.duration, 'hour');
  assert.equal(p.bans[0].duration, 'hour');
  assert.equal(await isOffBoard(h.db, REX, t0 + HOUR - 1), true);
  assert.equal((await activeBanIds(h.db, [REX], t0 + HOUR - 1)).has(REX), true);

  h.clock.t = t0 + HOUR - 1;
  admins = await adminsSay(h);
  assert.deepEqual(admins.banned, [REX], 'still banned one millisecond before the end');

  h.clock.t = t0 + HOUR;
  admins = await adminsSay(h);
  assert.deepEqual(admins.banned, [], 'free at the exact end time, before any cleanup ran');
  assert.equal(admins.until, undefined);
  assert.equal((await activeBanIds(h.db, [REX], h.clock.t)).size, 0);
  assert.equal(await isOffBoard(h.db, REX, h.clock.t), false);
  const list = await (await h.api('GET', '/api/party/bans', owner)).json();
  assert.deepEqual(list.bans, []);
  const after = await person(h, owner);
  assert.equal(after.person.banned, null);
});

test('forever bans keep the old behaviour and never end by themselves', async () => {
  const h = party();
  const owner = await staff(h);
  const body = await (await ban(h, owner, { reason: 'Spam' })).json();
  assert.equal(body.bans[0].until, null);
  assert.equal(body.bans[0].duration, 'forever');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_ban_terms').get().n, 0);
  assert.equal((await h.api('POST', '/api/party/bans', owner, { id: uid(6), duration: 'month' })).status, 400);
  h.clock.t += 400 * DAY;
  await cleanup(h.db, h.clock.t);
  assert.deepEqual((await adminsSay(h)).banned, [REX]);
});

test('expired bans stop counting for flags, results and daily puzzles everywhere', async () => {
  const h = party();
  const owner = await staff(h);
  for (let i = 0; i < FLAG_GAMES; i++) seed(h, { reporter: uid(200 + (i % FLAG_REPORTERS)), ago: HOUR + i * 3 * HOUR });
  assert.ok((await flaggedPeople(h.db, h.clock.t)).has(REX));
  await ban(h, owner, { duration: 'day' });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).has(REX), false, 'banned people are not flagged');
  h.clock.t += DAY;
  assert.ok((await flaggedPeople(h.db, h.clock.t)).has(REX), 'flagged again once the ban ran out');
  const src = ['party.js', 'party-daily.js', 'party-results.js', 'party-leaderboard.js', 'owner-party.js', 'reports.js'].map((f) => readFileSync(path.join(here, '..', 'worker', f), 'utf8'));
  for (const s of src) assert.equal(/SELECT (id|1 AS x) FROM party_bans WHERE id/.test(s), false, 'every ban check goes through the expiry-aware helpers');
});

test('cron removes ran-out bans, logs them, and leaves live ones alone', async () => {
  const h = party();
  const owner = await staff(h);
  await ban(h, owner, { duration: 'hour', reason: 'Spam' });
  await h.api('POST', '/api/party/bans', owner, { id: uid(5), name: 'Long', duration: 'week' });
  h.clock.t += 30 * MIN;
  let removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.expiredBans, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 2);
  h.clock.t += 31 * MIN;
  removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.expiredBans, 1);
  assert.equal(removed.banTerms, 1);
  assert.deepEqual(h.db.raw.prepare('SELECT id FROM party_bans').all().map((r) => r.id), [uid(5)]);
  assert.deepEqual(h.db.raw.prepare('SELECT user_id FROM party_ban_terms').all().map((r) => r.user_id), [uid(5)]);
  const logs = h.db.raw.prepare("SELECT * FROM party_ban_log WHERE user_id = ? ORDER BY at ASC").all(REX);
  assert.deepEqual(logs.map((l) => [l.action, l.by_id]), [['ban', OWNER.id], ['unban', 'yapos']]);
  const expire = modlog(h).find((r) => r.action === 'ban_expire');
  assert.equal(expire.target_id, REX);
  assert.equal(expire.actor_id, 'yapos');
  assert.deepEqual(JSON.parse(expire.detail), { duration: 'hour' });
  const p = await person(h, owner);
  assert.equal(p.bans[0].action, 'unban');
  assert.equal(p.bans[0].auto, true);
  removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.expiredBans, 0, 'running again changes nothing');
  assert.equal(modlog(h).filter((r) => r.action === 'ban_expire').length, 1);
});

test('unban still works early and a ran-out ban can be replaced by a new one', async () => {
  const h = party();
  const owner = await staff(h);
  await ban(h, owner, { duration: 'week' });
  h.clock.t += HOUR;
  const res = await (await h.api('DELETE', `/api/party/bans/${REX}`, owner)).json();
  assert.equal(res.unbanned, true);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_ban_terms').get().n, 0);
  assert.deepEqual((await adminsSay(h)).banned, []);
  const un = modlog(h).find((r) => r.action === 'unban');
  assert.equal(JSON.parse(un.detail).early, true);
  const again = await (await h.api('DELETE', `/api/party/bans/${REX}`, owner)).json();
  assert.equal(again.unbanned, false);
  assert.equal(modlog(h).filter((r) => r.action === 'unban').length, 1, 'a second unban writes nothing');

  await ban(h, owner, { duration: 'hour', reason: 'First' });
  h.clock.t += 2 * HOUR;
  const replaced = await (await ban(h, owner, { duration: 'day', reason: 'Second' })).json();
  assert.equal(replaced.banned, true, 'a ran-out ban that cron has not cleaned yet does not block a new ban');
  assert.equal(replaced.bans[0].reason, 'Second');
  assert.equal(replaced.bans[0].until, h.clock.t + DAY);
  const ranOut = await (await h.api('DELETE', `/api/party/bans/${uid(9)}`, owner)).json();
  assert.equal(ranOut.unbanned, false);
});

test('unbanning a ban that already ran out does not log a fake unban', async () => {
  const h = party();
  const owner = await staff(h);
  await ban(h, owner, { duration: 'hour' });
  h.clock.t += 2 * HOUR;
  const res = await (await h.api('DELETE', `/api/party/bans/${REX}`, owner)).json();
  assert.equal(res.unbanned, false);
  assert.equal(modlog(h).filter((r) => r.action === 'unban').length, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 0, 'the leftover row is cleared anyway');
});

test('staff send warnings that are filtered, length checked and logged in one batch', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const bob = await staff(h, BOB);
  const res = await h.api('POST', `/api/party/reports/person/${REX}/warnings`, bob, { text: `Keep drawings clean ${SLUR}` });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.warnings.length, 1);
  assert.equal(body.warnings[0].seen, false);
  assert.equal(body.warnings[0].author.id, BOB.id);
  const stored = warnings(h);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].user_id, REX);
  assert.equal(stored[0].seen_at, null);
  assert.equal(stored[0].text.includes(SLUR), false, 'custom text goes through the word filter');
  const log = modlog(h);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'warn');
  assert.equal(log[0].actor_id, BOB.id);
  assert.equal(log[0].target_id, REX);
  assert.equal(log[0].created, stored[0].created);
  assert.equal(JSON.parse(log[0].detail).text, stored[0].text);
  assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/warnings`, bob, { text: 'x'.repeat(WARNING_MAX + 1) })).status, 400);
  assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/warnings`, bob, { text: '   ' })).status, 400);
  assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/warnings`, bob, { text: 'ok', extra: 1 })).status, 400);
  const p = await person(h, bob);
  assert.equal(p.warnings.length, 1);
  assert.equal(p.counts.warnings, 1);
});

test('warnings check who is sending and to whom, and need the CSRF header', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  addAdmin(h, CARL.id);
  const owner = await staff(h);
  const bob = await staff(h, BOB);
  const outsider = (await h.login(REX_USER)).cookie;
  const url = (id) => `/api/party/reports/person/${id}/warnings`;
  assert.equal((await h.api('POST', url(BOB.id), bob, { text: 'Hi' })).status, 403, 'not yourself');
  assert.equal((await h.api('POST', url(OWNER.id), bob, { text: 'Hi' })).status, 400, 'not the owner');
  assert.equal((await h.api('POST', url(CARL.id), bob, { text: 'Hi' })).status, 403, 'admins cannot warn admins');
  assert.equal((await h.api('POST', url(CARL.id), owner, { text: 'Hi' })).status, 201, 'the owner can');
  assert.equal((await h.api('POST', url(uid(3)), outsider, { text: 'Hi' })).status, 403, 'players cannot');
  assert.equal((await h.api('GET', url(REX), outsider)).status, 403);
  assert.equal((await h.api('POST', url(REX), bob, { text: 'Hi' }, { 'X-YapOS': null })).status, 403, 'CSRF header required');
  assert.equal((await h.api('POST', url(REX), bob, { text: 'Hi' }, { Origin: 'https://evil.example' })).status, 403, 'other origins are blocked');
  assert.equal(warnings(h).filter((w) => w.user_id === REX).length, 0);
});

test('one person cannot be flooded with warnings', async () => {
  const h = party();
  const owner = await staff(h);
  for (let i = 0; i < WARNINGS_PER_TARGET_HOUR; i++) {
    assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: `Warning ${i}` })).status, 201);
    h.clock.t += 61 * 1000;
  }
  const res = await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: 'One more' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('Retry-After')) > 0);
  h.clock.t += HOUR;
  assert.equal((await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: 'Later' })).status, 201);
});

test('one mod cannot send a burst of warnings', async () => {
  const h = party();
  const owner = await staff(h);
  let last = null;
  for (let i = 0; i <= LIMITS.modWarnings; i++) last = await h.api('POST', `/api/party/reports/person/${uid(100 + i)}/warnings`, owner, { text: 'Be kind to others' });
  assert.equal(last.status, 429);
});

test('warnings reach only the signed-in player they are for, and only until seen', async () => {
  const h = party();
  const owner = await staff(h);
  await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: 'Keep drawings clean' });
  h.clock.t += 1000;
  await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: 'No spam' });
  const rex = await createActivitySession(h.db, REX_USER, h.clock.t);
  const carl = await createActivitySession(h.db, CARL, h.clock.t);
  const get = (q, headers = {}, ip = '198.51.100.9') => h.request('GET', `/api/activity/warnings${q}`, { headers, ip });

  assert.equal((await get(`?for=${REX}`)).status, 401, 'signed out players get nothing');
  const forged = await (await get(`?for=${REX}`, bearer(carl))).json();
  assert.deepEqual(forged, { warnings: [], mismatch: true }, 'asking for someone else returns nothing');
  const carlOwn = await (await get(`?for=${CARL.id}`, bearer(carl))).json();
  assert.deepEqual(carlOwn.warnings, []);
  const mine = await (await get(`?for=${REX.toUpperCase()}`, bearer(rex))).json();
  assert.deepEqual(mine.warnings.map((w) => w.text), ['Keep drawings clean', 'No spam']);
  assert.deepEqual(Object.keys(mine.warnings[0]).sort(), ['created', 'id', 'text'], 'the mod who sent it stays private');

  const seen = (id, token, headers = { Origin: h.base }) => h.request('POST', `/api/activity/warnings/${id}/seen`, { headers: { ...headers, ...bearer(token) }, body: {} });
  const first = mine.warnings[0].id;
  assert.equal((await seen(first, rex, {})).status, 403, 'needs the Origin header');
  assert.deepEqual(await (await seen(first, carl)).json(), { ok: true, seen: false }, 'nobody can mark someone else’s warning');
  assert.deepEqual(await (await seen(first, rex)).json(), { ok: true, seen: true });
  assert.deepEqual(await (await seen(first, rex)).json(), { ok: true, seen: false });
  const left = await (await get(`?for=${REX}`, bearer(rex))).json();
  assert.deepEqual(left.warnings.map((w) => w.text), ['No spam']);
  const panel = await person(h, owner);
  assert.deepEqual(panel.warnings.map((w) => [w.text, w.seen]), [['No spam', false], ['Keep drawings clean', true]]);
  assert.equal(h.db.raw.prepare('SELECT seen_at FROM party_warnings WHERE id = ?').get(first).seen_at, h.clock.t);
  assert.equal((await h.request('DELETE', '/api/activity/warnings', { headers: bearer(rex) })).status, 405);
});

test('the warnings poll is rate limited per network', async () => {
  const h = party();
  const rex = await createActivitySession(h.db, REX_USER, h.clock.t);
  let last = null;
  for (let i = 0; i <= LIMITS.activityWarnings; i++) last = await h.request('GET', `/api/activity/warnings?for=${REX}`, { headers: bearer(rex), ip: '198.51.100.77' });
  assert.equal(last.status, 429);
});

test('every staff action writes a mod log row in the same batch', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const bob = await staff(h, BOB);
  const r1 = seed(h);
  const r2 = seed(h, { reporter: uid(3) });
  const r3 = seed(h, { reporter: uid(4) });
  await h.api('POST', `/api/party/reports/${r1}/dismiss`, bob);
  await h.api('POST', `/api/party/reports/${r1}/dismiss`, bob);
  await h.api('DELETE', `/api/party/reports/${r2}`, bob);
  await h.api('DELETE', `/api/party/reports/${r2}`, bob);
  await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, bob);
  await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, bob);
  const note = await (await h.api('POST', `/api/party/reports/person/${REX}/notes`, bob, { text: 'Watch them' })).json();
  await h.api('DELETE', `/api/party/reports/person/${REX}/notes/${note.added}`, bob);
  await ban(h, bob, { duration: 'day', reason: 'Rude drawings' });
  await h.api('DELETE', `/api/party/bans/${REX}`, bob);
  const log = modlog(h);
  assert.deepEqual(log.map((r) => r.action), ['dismiss', 'report_delete', 'dismiss_all', 'note_add', 'note_delete', 'ban', 'unban'], 'repeats that changed nothing are not logged');
  for (const r of log) {
    assert.equal(r.actor_id, BOB.id);
    assert.equal(r.actor_name, 'Bob');
    assert.equal(r.target_id, REX);
  }
  assert.equal(log[0].target_name, 'Rex');
  assert.deepEqual(JSON.parse(log[2].detail), { count: 1 });
  assert.deepEqual(JSON.parse(log[5].detail), { duration: 'day', reason: 'Rude drawings' });
  assert.equal(r3.length > 0, true);
});

test('if the log cannot be written, the action is not done either', async () => {
  const h = party();
  const owner = await staff(h);
  h.db.raw.exec('DROP TABLE party_mod_log');
  const res = await ban(h, owner, { duration: 'hour' });
  assert.equal(res.status, 500);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_ban_terms').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_ban_log').get().n, 0);
  const w = await h.api('POST', `/api/party/reports/person/${REX}/warnings`, owner, { text: 'No spam' });
  assert.equal(w.status, 500);
  assert.equal(warnings(h).length, 0);
});

test('admins see each other in the mod log, but not owner panel changes or notes about themselves', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  addAdmin(h, CARL.id);
  const owner = await staff(h);
  const bob = await staff(h, BOB);
  const carl = await staff(h, CARL);
  const outsider = (await h.login(REX_USER)).cookie;
  await ban(h, bob, { duration: 'hour' });
  h.clock.t += 1000;
  await h.api('POST', `/api/party/reports/person/${BOB.id}/notes`, carl, { text: 'Bob is new' });
  h.clock.t += 1000;
  h.db.raw.prepare("INSERT INTO party_points (user_id, points, games, wins, updated) VALUES (?, 10, 1, 0, 1)").run(uid(7));
  const give = await h.api('POST', '/api/owner/actions', owner, { user: uid(7), kind: 'party.points.set', value: 50 });
  assert.equal(give.status, 201);
  h.clock.t += 1000;
  await h.api('POST', `/api/party/reports/person/${REX}/warnings`, carl, { text: 'No cheating' });

  const ownerView = await (await h.api('GET', '/api/party/modlog', owner)).json();
  assert.deepEqual(ownerView.entries.map((e) => e.action), ['warn', 'owner_points_set', 'note_add', 'ban']);
  const ownerRow = ownerView.entries[1];
  assert.equal(ownerRow.actor.id, OWNER.id);
  assert.equal(ownerRow.target.id, uid(7));
  assert.match(ownerRow.detail.summary, /all-time Party points to 50/);
  assert.equal(ownerView.role, 'owner');

  const bobView = await (await h.api('GET', '/api/party/modlog', bob)).json();
  assert.deepEqual(bobView.entries.map((e) => e.action), ['warn', 'ban'], 'no owner actions, no notes about Bob');
  assert.equal(bobView.entries[0].actor.id, CARL.id);
  assert.equal(bobView.actions.some((a) => a.action.startsWith('owner_')), false);
  const carlView = await (await h.api('GET', '/api/party/modlog', carl)).json();
  assert.deepEqual(carlView.entries.map((e) => e.action), ['warn', 'note_add', 'ban']);
  assert.equal((await h.api('GET', '/api/party/modlog', outsider)).status, 403);
  assert.equal((await h.api('GET', '/api/party/modlog')).status, 401);
  assert.equal((await h.api('POST', '/api/party/modlog', owner, {})).status, 405);
});

test('the mod log filters by mod, action and player, and pages newest first', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const owner = await staff(h);
  const bob = await staff(h, BOB);
  const total = MODLOG_PAGE + 5;
  for (let i = 0; i < total; i++) {
    h.db.raw.prepare("INSERT INTO party_mod_log (id, actor_id, actor_name, action, target_id, target_name, detail, created) VALUES (?, ?, ?, ?, ?, 'P', NULL, ?)")
      .run(`log${String(i).padStart(4, '0')}`, i % 2 ? BOB.id : OWNER.id, i % 2 ? 'Bob' : 'Alice', i % 3 ? 'dismiss' : 'warn', uid(i % 4), 1000 + i);
  }
  const first = await (await h.api('GET', '/api/party/modlog', owner)).json();
  assert.equal(first.entries.length, MODLOG_PAGE);
  assert.equal(first.entries[0].id, `log${String(total - 1).padStart(4, '0')}`);
  assert.ok(first.next);
  const second = await (await h.api('GET', `/api/party/modlog?before=${encodeURIComponent(first.next)}`, owner)).json();
  assert.equal(second.entries.length, 5);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.id)).size, total);
  const byBob = await (await h.api('GET', `/api/party/modlog?actor=${BOB.id}`, owner)).json();
  assert.ok(byBob.entries.every((e) => e.actor.id === BOB.id));
  const warns = await (await h.api('GET', '/api/party/modlog?action=warn', bob)).json();
  assert.ok(warns.entries.length > 0 && warns.entries.every((e) => e.action === 'warn'));
  const one = await (await h.api('GET', `/api/party/modlog?target=${uid(2)}`, owner)).json();
  assert.ok(one.entries.length > 0 && one.entries.every((e) => e.target.id === uid(2)));
  assert.deepEqual(first.actors.map((a) => a.id).sort(), [OWNER.id, BOB.id].sort());
  assert.equal((await h.api('GET', '/api/party/modlog?action=DROP%20TABLE', owner)).status, 400);
  assert.equal((await h.api('GET', '/api/party/modlog?before=nope', owner)).status, 400);
  assert.equal((await h.api('GET', '/api/party/modlog?actor=..%2F..', owner)).status, 400);
});

test('logModAction is a prepared statement other features can batch', async () => {
  const h = party();
  const stmt = logModAction(h.db, { actorId: OWNER.id.toUpperCase(), actorName: 'Alice', action: 'word_add', detail: { word: 'bad', summary: 'x'.repeat(5000) }, t: 42 });
  await h.db.batch([stmt]);
  const row = modlog(h)[0];
  assert.equal(row.actor_id, OWNER.id);
  assert.equal(row.target_id, null);
  assert.equal(row.created, 42);
  assert.ok(row.detail.length <= 1000);
  assert.equal(JSON.parse(row.detail).word, 'bad');
  assert.throws(() => logModAction(h.db, { actorId: OWNER.id, action: 'Bad Action', t: 1 }));
  assert.throws(() => logModAction(h.db, { action: 'warn', t: 1 }));
  const guarded = logModAction(h.db, { actorId: OWNER.id, action: 'cheat_clear', t: 2 }, { sql: '0', args: [] });
  await h.db.batch([guarded]);
  assert.equal(modlog(h).length, 1, 'a false guard writes nothing');
  assert.equal(detailJson(null), null);
  assert.equal(ownerLogAction('party.board.hide'), 'owner_board_hide');
  assert.equal(ownerLogAction('party.reset'), 'owner_reset');
});

test('old warnings and log rows are trimmed by cron', async () => {
  const h = party();
  h.db.raw.prepare("INSERT INTO party_warnings (id, user_id, author_id, author_name, text, created, seen_at) VALUES ('w1', ?, ?, 'Alice', 'old', 1, NULL)").run(REX, OWNER.id);
  h.db.raw.prepare("INSERT INTO party_mod_log (id, actor_id, actor_name, action, target_id, target_name, detail, created) VALUES ('l1', ?, 'Alice', 'warn', ?, 'Rex', NULL, 1)").run(OWNER.id, REX);
  const removed = await cleanup(h.db, h.clock.t);
  assert.equal(removed.oldWarnings, 1);
  assert.equal(removed.oldModLog, 1);
});

test('the new moderation files have no comments and no inline styles', () => {
  for (const f of ['../worker/party-mod.js', '../web/js/pages/party-modlog.js', '../web/activity/js/ui/warning.js']) {
    const src = readFileSync(path.join(here, f), 'utf8');
    assert.equal(/\/\*[\s\S]*?\*\//.test(src), false, f);
    assert.equal(/^\s*\/\/(?!\/)/m.test(src), false, f);
    assert.equal(/style=|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, f);
    assert.equal(/\b(claude|anthropic)\b/i.test(src), false, f);
  }
  for (const f of ['../web/css/replay.css', '../web/activity/css/signin.css']) {
    assert.equal(/[^\x00-\x7F]/.test(readFileSync(path.join(here, f), 'utf8')), false, f);
  }
  const schema = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  for (const table of ['party_ban_terms', 'party_warnings', 'party_mod_log']) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} `));
  assert.equal(/ALTER\s+TABLE/i.test(schema), false);
});
