import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHarness, USERS } from './helpers.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';
import { decodeTerm } from '../web/activity/js/filter.js';
import { FLAG_GAMES, FLAG_REPORTERS, FLAG_WINDOW, FLAG_SESSION, NOTE_MAX, NOTES_PER_PERSON, NOTES_TOTAL, flaggedPeople, cleanNote } from '../worker/reports.js';
import { LIMITS } from '../worker/rate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER = USERS.alice;
const BOB = USERS.bob;
const CARL = { id: '55555555-5555-4555-8555-555555555555', username: 'carl', display_name: 'Carl', avatar_url: null };
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STROKE = encodeStroke({ c: 1, z: 1, pts: [[10, 10], [40, 40], [80, 20]] });
const REX = uid(1);
const SLUR = decodeTerm('mktwhp');

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function addAdmin(h, id) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(id, OWNER.id, 1);
}

let serial = 0;
function seed(h, { drawer = REX, reporter = uid(2), game = 'draw', ago = 0, status = 'open', id = null, text = null, ip = null } = {}) {
  serial += 1;
  const rid = id || `fl${String(serial).padStart(6, '0')}`;
  const created = h.clock.t - ago;
  h.db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status, dismissed_at) VALUES (?, ?, ?, 'Drawer', NULL, ?, 'Reporter', ?, NULL, 1, ?, ?, ?, ?)")
    .run(rid, game, drawer, reporter, text ? '[]' : JSON.stringify([STROKE]), created, ip || `ip-${reporter}`, status, status === 'dismissed' ? h.clock.t : null);
  if (text) h.db.raw.prepare("INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES (?, ?, NULL, 'seed', ?)").run(rid, text, created);
  return rid;
}

function flagRex(h, { drawer = REX, games = FLAG_GAMES, reporters = FLAG_REPORTERS, ago = DAY } = {}) {
  const ids = [];
  for (let i = 0; i < games; i++) ids.push(seed(h, { drawer, reporter: uid(200 + (i % reporters)), game: 'draw', ago: ago + i * 3 * HOUR }));
  return ids;
}

const notes = (h) => h.db.raw.prepare('SELECT * FROM party_mod_notes ORDER BY created ASC, id ASC').all();

test('the flag thresholds are constants and sensible', () => {
  assert.equal(FLAG_GAMES, 3);
  assert.equal(FLAG_REPORTERS, 2);
  assert.equal(FLAG_WINDOW, 7 * DAY);
  assert.equal(FLAG_SESSION, 30 * MIN);
  assert.equal(NOTE_MAX, 500);
  assert.ok(LIMITS.modNotes > 0 && LIMITS.modNotes <= 20);
});

test('someone reported in 3 games by 2 people this week is flagged, fewer games is not', async () => {
  const h = party();
  seed(h, { reporter: uid(200), game: 'draw', ago: HOUR });
  seed(h, { reporter: uid(201), game: 'odd', ago: 2 * DAY });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0, 'two games is not enough');
  seed(h, { reporter: uid(200), game: 'draw', ago: 3 * DAY, text: 'mean words' });
  const flags = await flaggedPeople(h.db, h.clock.t);
  assert.deepEqual(flags.get(REX), { games: 3, reporters: 2, reports: 3 });
});

test('one person spamming reports can never flag someone alone', async () => {
  const h = party();
  for (let i = 0; i < 12; i++) seed(h, { reporter: uid(200), game: ['draw', 'odd', 'telephone', 'pixel'][i % 4], ago: i * 5 * HOUR });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  seed(h, { reporter: uid(201), game: 'draw', ago: HOUR });
  assert.ok((await flaggedPeople(h.db, h.clock.t)).has(REX), 'a second reporter makes it count');
});

test('made-up reporter ids sent from one network can never flag someone', async () => {
  const h = party();
  for (let i = 0; i < 9; i++) seed(h, { reporter: uid(600 + i), game: ['draw', 'odd', 'telephone'][i % 3], ago: i * 5 * HOUR, ip: 'one-attacker' });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  seed(h, { reporter: uid(600), game: 'draw', ago: HOUR, ip: 'second-network' });
  const flag = (await flaggedPeople(h.db, h.clock.t)).get(REX);
  assert.ok(flag);
  assert.equal(flag.reporters, 2, 'reporters count networks, not made-up ids');
});

test('real reports with made-up reporters from one address do not flag, a second address does', async () => {
  const h = party();
  const send = (reporter, game, ip) => h.request('POST', '/api/activity/reports', { headers: { Origin: h.base }, ip, body: { game, drawer: { id: REX, name: 'Rex' }, reporter: { id: reporter, name: 'R' }, ink: [STROKE], at: 1 } });
  for (const [i, game] of ['draw', 'odd', 'telephone'].entries()) {
    assert.equal((await send(uid(700 + i), game, '198.51.100.7')).status, 201);
    h.clock.t += HOUR;
  }
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  assert.equal((await send(uid(710), 'sketchduel', '203.0.113.9')).status, 201);
  assert.ok((await flaggedPeople(h.db, h.clock.t)).has(REX));
});

test('many reports from one game session count as one game', async () => {
  const h = party();
  for (let i = 0; i < 6; i++) seed(h, { reporter: uid(200 + i), game: 'draw', ago: HOUR + i * 10 * MIN });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  seed(h, { reporter: uid(200), game: 'draw', ago: 10 * HOUR });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  seed(h, { reporter: uid(201), game: 'odd', ago: HOUR + 2 * MIN });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).get(REX).games, 3);
});

test('old reports, dismissed reports and reports someone sent do not count', async () => {
  const h = party();
  seed(h, { reporter: uid(200), game: 'draw', ago: HOUR });
  seed(h, { reporter: uid(201), game: 'odd', ago: 2 * HOUR });
  seed(h, { reporter: uid(200), game: 'telephone', ago: 8 * DAY });
  seed(h, { reporter: uid(201), game: 'pixel', ago: 3 * HOUR, status: 'dismissed' });
  seed(h, { drawer: uid(300), reporter: REX, game: 'pixel', ago: 4 * HOUR });
  assert.equal((await flaggedPeople(h.db, h.clock.t)).size, 0);
  seed(h, { reporter: uid(201), game: 'pixel', ago: 5 * HOUR });
  assert.ok((await flaggedPeople(h.db, h.clock.t)).has(REX));
});

test('flagged people sort to the top with counts, and the Flagged filter shows only them', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const old = flagRex(h, { ago: 2 * DAY });
  for (let i = 0; i < 25; i++) seed(h, { drawer: uid(400 + i), reporter: uid(500 + i), ago: i * MIN });
  seed(h, { drawer: REX, reporter: uid(201), status: 'dismissed', ago: 3 * DAY });
  const { cookie } = await h.login(BOB);
  const first = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.deepEqual(first.flagged, { people: 1, reports: 3 });
  assert.deepEqual(first.reports.slice(0, 3).map((r) => r.id), [old[0], old[1], old[2]]);
  for (const r of first.reports.slice(0, 3)) assert.deepEqual(r.drawer.flag, { games: 3, reporters: 2, reports: 3 });
  assert.equal(first.reports[3].drawer.flag, null);
  assert.equal(first.reports.length, 23);
  assert.ok(first.next);
  const second = await (await h.api('GET', `/api/party/reports?before=${encodeURIComponent(first.next)}`, cookie)).json();
  const seen = first.reports.concat(second.reports).map((r) => r.id);
  assert.equal(new Set(seen).size, seen.length, 'no report shows twice');
  assert.equal(seen.length, 28);
  const only = await (await h.api('GET', '/api/party/reports?kind=flagged', cookie)).json();
  assert.deepEqual(only.reports.map((r) => r.id), old);
  assert.equal(only.next, null);
  const theirAll = await (await h.api('GET', '/api/party/reports?kind=flagged&status=all', cookie)).json();
  assert.equal(theirAll.reports.length, 4);
  const drawings = await (await h.api('GET', '/api/party/reports?kind=drawing', cookie)).json();
  assert.deepEqual(drawings.reports.slice(0, 3).map((r) => r.id), old);
  const text = await (await h.api('GET', '/api/party/reports?kind=text', cookie)).json();
  assert.equal(text.reports.length, 0);
  const dismissed = await (await h.api('GET', '/api/party/reports?status=dismissed', cookie)).json();
  assert.equal(dismissed.reports.length, 1);
  assert.equal((await h.api('GET', '/api/party/reports?kind=bogus', cookie)).status, 400);
  const person = await (await h.api('GET', `/api/party/reports/person/${REX}`, cookie)).json();
  assert.deepEqual(person.person.flag, { games: 3, reporters: 2, reports: 3 });
  const plain = await (await h.api('GET', `/api/party/reports/person/${uid(401)}`, cookie)).json();
  assert.equal(plain.person.flag, null);
});

test('the person flagged most sorts first', async () => {
  const h = party();
  flagRex(h, { drawer: uid(10), games: 3 });
  flagRex(h, { drawer: uid(11), games: 5 });
  const { cookie } = await h.login(OWNER);
  const data = await (await h.api('GET', '/api/party/reports?kind=flagged', cookie)).json();
  assert.equal(data.flagged.people, 2);
  assert.deepEqual(data.reports.map((r) => r.drawer.id), [...Array(5).fill(uid(11)), ...Array(3).fill(uid(10))]);
});

test('a banned person shows as banned, not flagged', async () => {
  const h = party();
  flagRex(h);
  const { cookie } = await h.login(OWNER);
  assert.equal((await h.api('POST', '/api/party/bans', cookie, { id: REX })).status, 200);
  const data = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.deepEqual(data.flagged, { people: 0, reports: 0 });
  for (const r of data.reports) {
    assert.equal(r.drawer.banned, true);
    assert.equal(r.drawer.flag, null);
  }
  assert.equal((await (await h.api('GET', '/api/party/reports?kind=flagged', cookie)).json()).reports.length, 0);
  const person = await (await h.api('GET', `/api/party/reports/person/${REX}`, cookie)).json();
  assert.equal(person.person.flag, null);
  assert.ok(person.person.banned);
  await h.api('DELETE', `/api/party/bans/${REX}`, cookie);
  assert.equal((await (await h.api('GET', '/api/party/reports', cookie)).json()).flagged.people, 1);
});

test('dismissing their reports clears the flag', async () => {
  const h = party();
  flagRex(h);
  const { cookie } = await h.login(OWNER);
  await h.api('POST', `/api/party/reports/person/${REX}/dismiss`, cookie, {});
  assert.equal((await (await h.api('GET', '/api/party/reports', cookie)).json()).flagged.people, 0);
});

test('the flag query uses an index', () => {
  const h = party();
  const plan = h.db.raw.prepare("EXPLAIN QUERY PLAN SELECT drawer_id, COUNT(DISTINCT reporter_id) FROM party_reports r WHERE r.status = 'open' AND r.created > 0 GROUP BY drawer_id").all();
  assert.ok(plan.some((p) => /USING (COVERING )?INDEX party_reports_(flag|status)/.test(p.detail)), JSON.stringify(plan));
});

test('staff add, list and delete notes, newest first, and only the author or the owner can delete', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  addAdmin(h, CARL.id);
  const owner = await h.login(OWNER);
  const bob = await h.login(BOB);
  const carl = await h.login(CARL);
  const url = `/api/party/reports/person/${REX}/notes`;
  const first = await h.api('POST', url, bob.cookie, { text: '  Warned   on Nov 16 for spam  ' });
  assert.equal(first.status, 201);
  const a = await first.json();
  assert.equal(a.notes.length, 1);
  assert.equal(a.notes[0].text, 'Warned on Nov 16 for spam');
  assert.deepEqual([a.notes[0].author.id, a.notes[0].author.name, a.notes[0].canDelete, a.notes[0].mine], [BOB.id, 'Bob', true, true]);
  h.clock.t += MIN;
  await h.api('POST', url, carl.cookie, { text: 'Watch: rude again' });
  h.clock.t += MIN;
  await h.api('POST', url, owner.cookie, { text: 'Ban appeal denied' });
  const list = await (await h.api('GET', url, bob.cookie)).json();
  assert.deepEqual(list.notes.map((n) => n.text), ['Ban appeal denied', 'Watch: rude again', 'Warned on Nov 16 for spam']);
  assert.deepEqual(list.notes.map((n) => n.canDelete), [false, false, true]);
  assert.equal(list.max, NOTE_MAX);
  const [ownerNote, carlNote, bobNote] = list.notes.map((n) => n.id);
  const nope = await h.api('DELETE', `${url}/${carlNote}`, bob.cookie);
  assert.equal(nope.status, 403);
  assert.equal((await nope.json()).error, 'not_yours');
  assert.equal((await h.api('DELETE', `${url}/${ownerNote}`, bob.cookie)).status, 403);
  const mine = await (await h.api('DELETE', `${url}/${bobNote}`, bob.cookie)).json();
  assert.equal(mine.deleted, true);
  assert.equal(mine.notes.length, 2);
  const asOwner = await (await h.api('GET', url, owner.cookie)).json();
  assert.ok(asOwner.notes.every((n) => n.canDelete));
  assert.equal((await h.api('DELETE', `${url}/${carlNote}`, owner.cookie)).status, 200);
  assert.equal((await h.api('DELETE', `${url}/${carlNote}`, owner.cookie)).status, 404);
  assert.equal((await h.api('DELETE', `/api/party/reports/person/${uid(9)}/notes/${ownerNote}`, owner.cookie)).status, 404, 'a note id only works with its person');
  assert.equal((await h.api('DELETE', `${url}/${encodeURIComponent('bad id!')}`, owner.cookie)).status, 400);
  assert.equal((await h.api('PUT', url, owner.cookie, { text: 'x' })).status, 405);
  assert.deepEqual(notes(h).map((n) => n.text), ['Ban appeal denied']);
});

test('notes show in the person view and as a count on report cards', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  seed(h, { reporter: uid(200), ago: MIN });
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(OWNER.id, 'alice', 'Alice', 'https://files.yapper.website/alice.png', h.clock.t);
  const { cookie } = await h.login(OWNER);
  await h.api('POST', `/api/party/reports/person/${REX}/notes`, cookie, { text: 'One' });
  h.clock.t += MIN;
  await h.api('POST', `/api/party/reports/person/${REX}/notes`, cookie, { text: 'Two' });
  const list = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal(list.reports[0].drawer.notes, 2);
  assert.equal(list.reports[0].drawer.flag, null);
  const person = await (await h.api('GET', `/api/party/reports/person/${REX}`, cookie)).json();
  assert.deepEqual(person.notes.map((n) => n.text), ['Two', 'One']);
  assert.equal(person.notes[0].author.name, 'Alice');
  assert.equal(person.notes[0].author.avatar, OWNER.avatar_url, 'signing in refreshes the saved picture from Yapin');
  assert.equal(person.reports[0].drawer.notes, 2);
});

test('note posts need the CSRF header and the right origin', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const url = `/api/party/reports/person/${REX}/notes`;
  assert.equal((await h.api('POST', url, cookie, { text: 'hi' }, { 'X-YapOS': null })).status, 403);
  assert.equal((await h.api('POST', url, cookie, { text: 'hi' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('POST', url, cookie, { text: 'hi' }, { Origin: null })).status, 403);
  assert.equal(notes(h).length, 0);
  await h.api('POST', url, cookie, { text: 'hi' });
  const [n] = notes(h);
  assert.equal((await h.api('DELETE', `${url}/${n.id}`, cookie, undefined, { 'X-YapOS': null })).status, 403);
  assert.equal(notes(h).length, 1);
});

test('notes are checked: length, empty, unknown fields, slurs and a cap per person', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const url = `/api/party/reports/person/${REX}/notes`;
  const long = await h.api('POST', url, cookie, { text: 'x'.repeat(NOTE_MAX + 1) });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error, 'too_long');
  for (const [body, code] of [[{ text: '   ' }, 'bad_text'], [{ text: 5 }, 'bad_text'], [{}, 'bad_text'], [{ text: 'hi', extra: 1 }, 'bad_request']]) {
    const res = await h.api('POST', url, cookie, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, code);
  }
  assert.equal((await h.api('POST', `/api/party/reports/person/${encodeURIComponent('no way')}/notes`, cookie, { text: 'hi' })).status, 400);
  assert.equal((await h.api('POST', url, cookie, { text: 'é'.repeat(NOTE_MAX) })).status, 201);
  h.clock.t += MIN;
  const slur = await (await h.api('POST', url, cookie, { text: `called someone a ${SLUR} in chat` })).json();
  assert.ok(!slur.notes[0].text.includes(SLUR));
  assert.match(slur.notes[0].text, /^called someone a \S+ in chat$/);
  assert.equal(cleanNote('ok\u0000 note'), 'ok note');
  const insert = h.db.raw.prepare("INSERT INTO party_mod_notes (id, user_id, author_id, author_name, text, created) VALUES (?, ?, ?, 'Alice', 'old', 1)");
  for (let i = notes(h).length; i < NOTES_PER_PERSON; i++) insert.run(`cap${i}`, REX, OWNER.id);
  h.clock.t += 2 * MIN;
  const full = await h.api('POST', url, cookie, { text: 'one more' });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'too_many');
});

test('adding notes is rate limited', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const url = `/api/party/reports/person/${REX}/notes`;
  let last;
  for (let i = 0; i <= LIMITS.modNotes; i++) last = await h.api('POST', url, cookie, { text: `note ${i}` });
  assert.equal(last.status, 429);
  assert.equal(notes(h).length, LIMITS.modNotes);
});

test('people who are not party staff cannot read, add or delete notes', async () => {
  const h = party();
  const owner = await h.login(OWNER);
  await h.api('POST', `/api/party/reports/person/${REX}/notes`, owner.cookie, { text: 'secret note' });
  const [n] = notes(h);
  const bob = await h.login(BOB);
  for (const [method, url, body] of [
    ['GET', `/api/party/reports/person/${REX}/notes`],
    ['POST', `/api/party/reports/person/${REX}/notes`, { text: 'mine' }],
    ['DELETE', `/api/party/reports/person/${REX}/notes/${n.id}`],
    ['GET', `/api/party/reports/person/${REX}`],
  ]) {
    const res = await h.api(method, url, bob.cookie, body);
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal((await res.json()).error, 'staff_only');
  }
  assert.equal((await h.api('GET', `/api/party/reports/person/${REX}/notes`)).status, 401);
  assert.equal(notes(h).length, 1);
});

test('admins never see or write notes about themselves, the owner can read and delete theirs', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const owner = await h.login(OWNER);
  const bob = await h.login(BOB);
  await h.api('POST', `/api/party/reports/person/${BOB.id}/notes`, owner.cookie, { text: 'about bob' });
  await h.api('POST', `/api/party/reports/person/${OWNER.id}/notes`, bob.cookie, { text: 'about alice' });
  seed(h, { drawer: BOB.id, reporter: uid(200), ago: MIN });
  const list = await h.api('GET', `/api/party/reports/person/${BOB.id}/notes`, bob.cookie);
  assert.equal(list.status, 403);
  assert.equal((await list.json()).error, 'is_self');
  assert.equal((await h.api('POST', `/api/party/reports/person/${BOB.id}/notes`, bob.cookie, { text: 'hi me' })).status, 403);
  const [about] = notes(h).filter((n) => n.user_id === BOB.id);
  assert.equal((await h.api('DELETE', `/api/party/reports/person/${BOB.id}/notes/${about.id}`, bob.cookie)).status, 403);
  const person = await (await h.api('GET', `/api/party/reports/person/${BOB.id}`, bob.cookie)).json();
  assert.equal(person.notes, null);
  assert.ok(!JSON.stringify(person).includes('about bob'));
  const reports = await (await h.api('GET', '/api/party/reports', bob.cookie)).json();
  assert.equal(reports.reports[0].drawer.notes, 0);
  assert.equal((await (await h.api('GET', `/api/party/reports/person/${BOB.id}/notes`, owner.cookie)).json()).notes.length, 1);
  const own = await (await h.api('GET', `/api/party/reports/person/${OWNER.id}/notes`, owner.cookie)).json();
  assert.deepEqual(own.notes.map((n) => n.text), ['about alice'], 'the owner can read notes about themselves');
  assert.equal((await h.api('POST', `/api/party/reports/person/${OWNER.id}/notes`, owner.cookie, { text: 'hi me' })).status, 403);
  assert.equal((await h.api('DELETE', `/api/party/reports/person/${OWNER.id}/notes/${own.notes[0].id}`, owner.cookie)).status, 200, 'the owner can delete notes about themselves');
});

test('staff can not write more notes than the global cap', async () => {
  const h = party();
  const owner = await h.login(OWNER);
  const put = h.db.raw.prepare("INSERT INTO party_mod_notes (id, user_id, author_id, author_name, text, created) VALUES (?, ?, ?, 'Staff', 'x', 1)");
  h.db.raw.exec('BEGIN');
  for (let i = 0; i < NOTES_TOTAL; i++) put.run(`cap${i}`, uid(10000 + Math.floor(i / 50)), OWNER.id);
  h.db.raw.exec('COMMIT');
  const res = await h.api('POST', `/api/party/reports/person/${REX}/notes`, owner.cookie, { text: 'one more' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'notes_full');
  assert.equal(notes(h).length, NOTES_TOTAL);
});

test('notes never reach public profiles, the activity or anything outside the staff reports code', async () => {
  const h = party();
  const owner = await h.login(OWNER);
  await h.api('POST', `/api/party/reports/person/${BOB.id}/notes`, owner.cookie, { text: 'zebra-secret-note' });
  const bob = await h.login(BOB);
  const urls = [
    `/api/activity/profile/${BOB.id}`,
    `/api/activity/admins?ids=${BOB.id}`,
    `/api/u/${BOB.username}`,
    '/api/me',
    `/api/party/reports/person/${BOB.id}`,
  ];
  for (const u of urls) {
    for (const cookie of [null, bob.cookie]) {
      const res = await h.api('GET', u, cookie);
      assert.ok(!(await res.text()).includes('zebra-secret-note'), u);
    }
  }
  const worker = path.join(here, '..', 'worker');
  const users = readdirSync(worker).filter((f) => f.endsWith('.js') && readFileSync(path.join(worker, f), 'utf8').includes('party_mod_notes'));
  assert.deepEqual(users, ['reports.js']);
  const web = path.join(here, '..', 'web', 'activity');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(web).filter((f) => f.endsWith('.js'))) assert.ok(!readFileSync(f, 'utf8').includes('/notes'), f);
});

test('the dev server seeds a flagged person and a person with a couple of notes', async () => {
  const { seedPartyReport, DEV_REPORT_DRAWER, DEV_ARTISTS } = await import('../dev.mjs');
  const h = party();
  seedPartyReport(h.db, h.clock.t);
  seedPartyReport(h.db, h.clock.t);
  const { cookie } = await h.login(OWNER);
  const data = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal(data.flagged.people, 1);
  assert.equal(data.reports[0].drawer.id, DEV_REPORT_DRAWER);
  assert.ok(data.reports[0].drawer.flag.games >= FLAG_GAMES);
  const artist = await (await h.api('GET', `/api/party/reports/person/${DEV_ARTISTS[0]}`, cookie)).json();
  assert.equal(artist.notes.length, 2);
  assert.equal(artist.person.flag, null);
  const rex = await (await h.api('GET', `/api/party/reports/person/${DEV_REPORT_DRAWER}`, cookie)).json();
  assert.equal(rex.notes.length, 1);
});
