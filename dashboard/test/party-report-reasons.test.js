import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHarness, USERS } from './helpers.js';
import { encodeStroke } from '../web/activity/js/games/ink.js';
import { cleanReason, REPORT_REASONS, REASON_NOTE_MAX } from '../worker/reports.js';
import { CHEAT_KINDS } from '../worker/party-cheats.js';
import { reportBody, textReportBody, resetAdmins, configureAdmins, REPORT_REASONS as CLIENT_REASONS } from '../web/activity/js/admin.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `78787878-7878-4787-8787-${String(i).padStart(12, '0')}`;
const STROKE = encodeStroke({ c: 1, z: 1, pts: [[10, 10], [40, 40], [80, 20]] });
const here = path.dirname(fileURLToPath(import.meta.url));

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function drawing(over = {}) {
  return { game: 'draw', drawer: { id: uid(1), name: 'Rex', username: 'rexplorer' }, reporter: { id: uid(2), name: 'Mila' }, ink: [STROKE], word: 'cactus', at: 5, ...over };
}

function words(over = {}) {
  return { kind: 'text', game: 'hottakes', author: { id: uid(1), name: 'Rex', username: null }, reporter: { id: uid(3), name: 'Juno' }, text: 'some mean words', context: null, at: 6, ...over };
}

function send(h, body, ip = '198.51.100.9') {
  return h.request('POST', '/api/activity/reports', { headers: { Origin: h.base }, body, ip });
}

const reasons = (h) => h.db.raw.prepare('SELECT report_id, reason, note FROM party_report_reasons ORDER BY created ASC, report_id ASC').all();

test('the client and the Worker agree on the four report reasons', () => {
  assert.deepEqual([...REPORT_REASONS], ['rude', 'spam', 'cheating', 'other']);
  assert.deepEqual([...CLIENT_REASONS], [...REPORT_REASONS]);
  assert.equal(REASON_NOTE_MAX, 100);
  assert.deepEqual(cleanReason({}), { reason: null, reasonNote: null });
  assert.deepEqual(cleanReason({ reason: 'spam' }), { reason: 'spam', reasonNote: null });
  assert.deepEqual(cleanReason({ reason: 'other', reasonNote: '   ' }), { reason: 'other', reasonNote: null });
  assert.throws(() => cleanReason({ reason: 'hacking' }), /rude, spam, cheating or something else/);
  assert.throws(() => cleanReason({ reason: 7 }), /rude, spam/);
  assert.throws(() => cleanReason({ reasonNote: 'no reason' }), /Pick why/);
  assert.throws(() => cleanReason({ reason: 'other', reasonNote: 'x'.repeat(101) }), /under 100/);
  assert.throws(() => cleanReason({ reason: 'other', reasonNote: 5 }), /note/);
});

test('the activity adds the reason to drawing and text report bodies and filters the note', () => {
  resetAdmins();
  configureAdmins({ now: () => 1 });
  const d = reportBody({ ...drawing(), reason: 'cheating' });
  assert.equal(d.reason, 'cheating');
  assert.equal('reasonNote' in d, false);
  const t = textReportBody({ ...words(), reason: 'other', reasonNote: `  hello\u0000   there ${'z'.repeat(200)}` });
  assert.equal(t.reason, 'other');
  assert.equal(Array.from(t.reasonNote).length, 100);
  assert.ok(t.reasonNote.startsWith('hello there'));
  const old = reportBody(drawing());
  assert.equal('reason' in old, false, 'no reason means no field, like before');
  assert.equal('reason' in reportBody({ ...drawing(), reason: 'nope' }), false);
  resetAdmins();
});

test('reports store their reason next to them, old ones have none and bad reasons get a 400', async () => {
  const h = party();
  assert.equal((await send(h, drawing({ reason: 'rude' }))).status, 201);
  assert.equal((await send(h, words({ reason: 'other', reasonNote: '  they   spammed the chat  ' }))).status, 201);
  assert.equal((await send(h, drawing({ reporter: { id: uid(4), name: 'Old' } }))).status, 201);
  const bad = await send(h, drawing({ reporter: { id: uid(5), name: 'Bad' }, reason: 'because' }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_reason');
  const long = await send(h, words({ reporter: { id: uid(6), name: 'Long' }, reason: 'other', reasonNote: 'y'.repeat(101) }));
  assert.equal(long.status, 400);
  const rows = reasons(h);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.reason, r.note]).sort(), [['other', 'they spammed the chat'], ['rude', null]]);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_reports').get().n, 3);
});

test('staff see the reason on each report and can filter by it', async () => {
  const h = party();
  await send(h, drawing({ reason: 'rude' }));
  await send(h, words({ reason: 'spam' }));
  await send(h, words({ reporter: { id: uid(7), name: 'Kai' }, text: 'other words', reason: 'other', reasonNote: 'weird' }));
  await send(h, drawing({ reporter: { id: uid(8), name: 'Old' } }));
  const { cookie } = await h.login(OWNER);
  const all = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal(all.reason, 'all');
  assert.deepEqual(all.reports.map((r) => r.reason).sort(), [null, 'other', 'rude', 'spam'].sort());
  const other = all.reports.find((r) => r.reason === 'other');
  assert.equal(other.reasonNote, 'weird');
  assert.equal(all.reports.find((r) => r.reason === null).reasonNote, null);
  const spam = await (await h.api('GET', '/api/party/reports?reason=spam', cookie)).json();
  assert.deepEqual(spam.reports.map((r) => [r.kind, r.reason]), [['text', 'spam']]);
  const rudeText = await (await h.api('GET', '/api/party/reports?reason=rude&kind=text', cookie)).json();
  assert.equal(rudeText.reports.length, 0);
  const rude = await (await h.api('GET', '/api/party/reports?reason=rude&kind=drawing', cookie)).json();
  assert.equal(rude.reports.length, 1);
  assert.equal((await h.api('GET', '/api/party/reports?reason=angry', cookie)).status, 400);
});

test('the person page counts reports by reason', async () => {
  const h = party();
  await send(h, drawing({ reason: 'rude' }));
  await send(h, words({ reason: 'rude' }));
  await send(h, words({ reporter: { id: uid(9), name: 'Kai' }, text: 'x y z', reason: 'cheating' }));
  await send(h, drawing({ reporter: { id: uid(10), name: 'Old' } }));
  const { cookie } = await h.login(OWNER);
  const data = await (await h.api('GET', `/api/party/reports/person/${uid(1)}`, cookie)).json();
  assert.deepEqual(data.counts.reasons, { rude: 2, spam: 0, cheating: 1, other: 0 });
  assert.equal(data.counts.total, 4);
});

test('cheating reports from two different players raise a cheat alert', async () => {
  const h = party();
  assert.ok(CHEAT_KINDS.reported);
  await send(h, words({ reason: 'cheating' }), '198.51.100.1');
  const alerts = () => h.db.raw.prepare("SELECT user_id, kind, detail, status FROM party_cheat_alerts WHERE kind = 'reported'").all();
  assert.equal(alerts().length, 0, 'one report is not enough');
  await send(h, words({ reporter: { id: uid(11), name: 'Kai' }, reason: 'cheating' }), '198.51.100.1');
  assert.equal(alerts().length, 0, 'two reporters from one address count once');
  await send(h, drawing({ reporter: { id: uid(12), name: 'Ivy' }, reason: 'cheating' }), '203.0.113.7');
  const [a] = alerts();
  assert.ok(a);
  assert.equal(a.user_id, uid(1));
  assert.equal(a.status, 'open');
  assert.match(a.detail, /Reported for cheating by 2 different players/);
  await send(h, drawing({ reporter: { id: uid(13), name: 'Zed' }, reason: 'rude' }), '203.0.113.9');
  assert.equal(alerts().length, 1);
});

test('deleting, trimming and cleanup never leave a reason behind', async () => {
  const h = party();
  await send(h, drawing({ reason: 'spam' }));
  const { cookie } = await h.login(OWNER);
  const list = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal((await h.api('DELETE', `/api/party/reports/${list.reports[0].id}`, cookie)).status, 200);
  assert.equal(reasons(h).length, 0);
  h.db.raw.prepare("INSERT INTO party_report_reasons (report_id, reason, note, created) VALUES ('gone', 'rude', NULL, 1)").run();
  const { cleanupStatements } = await import('../worker/reports.js');
  await h.db.batch(cleanupStatements(h.db, Date.now()));
  assert.equal(reasons(h).length, 0);
});

test('the schema keeps reasons in their own table and the new code has no comments', () => {
  const schema = readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS party_report_reasons \(/);
  assert.doesNotMatch(schema, /ALTER TABLE/i);
  for (const f of ['web/activity/js/ui/report.js', 'worker/reports.js', 'web/js/pages/party-reports.js', 'web/js/pages/party-person.js']) {
    const src = readFileSync(path.join(here, '..', f), 'utf8');
    assert.doesNotMatch(src, /^\s*\/\/|\/\*/m, f);
  }
  const css = readFileSync(path.join(here, '..', 'web', 'activity', 'css', 'games.css'), 'utf8');
  assert.match(css, /\.reason-grid \{/);
  assert.ok(/^[\x00-\x7f]*$/.test(css), 'games.css stays plain ASCII');
});
