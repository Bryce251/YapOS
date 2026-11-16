import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { installDom, flush } from './dom-shim.js';
import { encodeStroke, decodeStroke } from '../web/activity/js/games/ink.js';
import { MAX_REPORTS, MAX_STROKES, ipBucket, reportIpHash } from '../worker/reports.js';
import { sha256Hex } from '../worker/util.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const STROKE = encodeStroke({ c: 1, z: 1, pts: [[10, 10], [40, 40], [80, 20]] });

function party(overrides = {}) {
  return createHarness({ PARTY_OWNER_ID: OWNER.id, ...overrides });
}

function report(over = {}) {
  return {
    game: 'draw',
    drawer: { id: uid(1), name: 'Rex', username: 'rexplorer' },
    reporter: { id: uid(2), name: 'Mila' },
    ink: [STROKE],
    word: 'cactus',
    at: Date.UTC(2026, 10, 12, 11, 59),
    ...over,
  };
}

function send(h, body, { ip = '198.51.100.9', origin } = {}) {
  const headers = { Origin: origin === undefined ? h.base : origin };
  if (headers.Origin === null) delete headers.Origin;
  return h.request('POST', '/api/activity/reports', { headers, body, ip });
}

const rows = (h) => h.db.raw.prepare('SELECT * FROM party_reports ORDER BY created ASC, id ASC').all();

function addAdmin(h, id) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(id, OWNER.id, 1);
}

function seed(h, i, { created, status = 'open', drawer = uid(100 + i), reporter = uid(200 + i), dismissedAt = null } = {}) {
  h.db.raw.prepare("INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status, dismissed_at) VALUES (?, 'odd', ?, 'Drawer', NULL, ?, 'Reporter', ?, NULL, 1, ?, 'seed', ?, ?)")
    .run(`seed${String(i).padStart(4, '0')}`, drawer, reporter, JSON.stringify([STROKE]), created ?? h.clock.t - i * 1000, status, dismissedAt);
}

test('anyone in a call can send a report without signing in and it is stored cleaned up', async () => {
  const h = party();
  const res = await send(h, report({ drawer: { id: uid(1).toUpperCase(), name: '  Rex\u0000  the   Drawer ', username: '@@rexplorer' }, reporter: { id: uid(2), name: 'x'.repeat(200) } }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
  const [row] = rows(h);
  assert.equal(row.drawer_id, uid(1));
  assert.equal(row.drawer_name, 'Rex the Drawer');
  assert.equal(row.drawer_username, 'rexplorer');
  assert.equal(row.reporter_name.length, 64);
  assert.deepEqual(JSON.parse(row.ink), [STROKE]);
  assert.equal(row.word, 'cactus');
  assert.equal(row.status, 'open');
  assert.equal(row.created, h.clock.t);
  assert.match(row.ip_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes('198.51.100.9'));
});

test('reports must come from the YapOS page itself', async () => {
  const h = party();
  assert.equal((await send(h, report(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(h, report(), { origin: null })).status, 403);
  assert.equal((await h.request('GET', '/api/activity/reports')).status, 405);
  const plain = await h.request('POST', '/api/activity/reports', { headers: { Origin: h.base, 'Content-Type': 'text/plain' }, body: JSON.stringify(report()) });
  assert.equal(plain.status, 415);
  assert.equal(rows(h).length, 0);
});

test('every report field is checked and bad ones get a friendly 400', async () => {
  const h = party();
  const big = 'A'.repeat(4000);
  const cases = [
    [{ game: 'trivia' }, 'bad_game'],
    [{ game: 1 }, 'bad_game'],
    [{ drawer: null }, 'bad_person'],
    [{ drawer: { id: 'nope nope', name: 'Rex' } }, 'bad_id'],
    [{ drawer: { id: "x'; DROP TABLE party_reports; --", name: 'Rex' } }, 'bad_id'],
    [{ reporter: { id: 42, name: 'Mila' } }, 'bad_id'],
    [{ drawer: { id: uid(1), name: 'Rex', username: 5 } }, 'bad_username'],
    [{ reporter: { id: uid(1), name: 'Rex' } }, 'own_drawing'],
    [{ ink: 'abc' }, 'bad_ink'],
    [{ ink: ['ABCDE'] }, 'bad_ink'],
    [{ ink: ['ABCDEF!'] }, 'bad_ink'],
    [{ ink: [42] }, 'bad_ink'],
    [{ ink: Array.from({ length: MAX_STROKES + 1 }, () => STROKE) }, 'bad_ink'],
    [{ ink: [big, big, big, big, big] }, 'bad_ink'],
    [{ word: 7 }, 'bad_word'],
    [{ at: 'soon' }, 'bad_time'],
    [{ at: -5 }, 'bad_time'],
  ];
  let ip = 0;
  for (const [over, code] of cases) {
    ip += 1;
    const res = await send(h, report(over), { ip: `192.0.2.${ip}` });
    assert.equal(res.status, 400, JSON.stringify(over).slice(0, 80));
    const data = await res.json();
    assert.equal(data.error, code, JSON.stringify(over).slice(0, 80));
    assert.ok(data.message.length > 5);
  }
  assert.equal(rows(h).length, 0);
  assert.equal((await send(h, report({ ink: [], word: null, drawer: { id: uid(1), name: '', username: null } }), { ip: '192.0.2.200' })).status, 201);
  assert.equal(rows(h)[0].drawer_name, 'Player');
  assert.equal(rows(h)[0].word, null);
  assert.equal((await send(h, report({ ink: Array.from({ length: MAX_STROKES }, () => STROKE), reporter: { id: uid(3), name: 'Bo' } }), { ip: '192.0.2.201' })).status, 201);
  for (const sql of h.db.queries) assert.ok(!sql.includes('DROP'), sql);
});

test('the same person reporting the same drawer twice in 10 minutes is only stored once', async () => {
  const h = party();
  assert.equal((await send(h, report())).status, 201);
  const again = await send(h, report({ word: 'other' }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, duplicate: true });
  assert.equal((await send(h, report({ reporter: { id: uid(3), name: 'Bo' } }))).status, 201);
  assert.equal(rows(h).length, 2);
  advance(h, 10 * MIN + 1);
  assert.equal((await send(h, report())).status, 201);
  assert.equal(rows(h).length, 3);
});

test('reports are rate limited per address, per minute and per 10 minutes', async () => {
  const h = party();
  const from = (i) => report({ reporter: { id: uid(300 + i), name: 'R' } });
  for (let i = 0; i < 5; i++) assert.equal((await send(h, from(i))).status, 201);
  const fast = await send(h, from(5));
  assert.equal(fast.status, 429);
  assert.ok(Number(fast.headers.get('Retry-After')) >= 1);
  assert.match((await fast.json()).message, /a lot of reports/);
  assert.equal((await send(h, from(6), { ip: '198.51.100.77' })).status, 201);
  advance(h, MIN);
  for (let i = 10; i < 15; i++) assert.equal((await send(h, from(i))).status, 201);
  advance(h, MIN);
  const slow = await send(h, from(20));
  assert.equal(slow.status, 429);
  assert.ok(Number(slow.headers.get('Retry-After')) > 60);
  advance(h, 9 * MIN);
  assert.equal((await send(h, from(21))).status, 201);
});

test('one IPv6 network shares a single report budget and stored address hashes are salted', async () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:db8::7'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('::ffff:198.51.100.9'), '198.51.100.9');
  assert.equal(ipBucket('198.51.100.9'), '198.51.100.9');
  const h = party();
  const from = (i) => report({ reporter: { id: uid(400 + i), name: 'R' } });
  for (let i = 0; i < 5; i++) assert.equal((await send(h, from(i), { ip: `2001:db8:1:2:${i}::${i + 1}` })).status, 201);
  assert.equal((await send(h, from(9), { ip: '2001:db8:1:2:beef::9' })).status, 429);
  assert.equal((await send(h, from(10), { ip: '2001:db8:1:3::1' })).status, 201);
  const salted = await reportIpHash({ BOT_SECRET: 'pepper' }, '198.51.100.9');
  assert.notEqual(salted, await reportIpHash({}, '198.51.100.9'));
  assert.notEqual(salted, (await sha256Hex('ip:198.51.100.9')).slice(0, 32));
});

test('a flood of reports from many addresses is capped across the whole site', async () => {
  const h = party();
  let ok = 0;
  let last = null;
  for (let i = 0; i < 70; i++) {
    last = await send(h, report({ reporter: { id: uid(500 + i), name: 'R' } }), { ip: `203.0.113.${i}` });
    if (last.status === 201) ok += 1;
  }
  assert.equal(ok, 60);
  assert.equal(last.status, 429);
  assert.match((await last.json()).message, /Lots of reports/);
  advance(h, MIN);
  assert.equal((await send(h, report({ reporter: { id: uid(600), name: 'R' } }), { ip: '203.0.113.200' })).status, 201);
});

test('stored reports are capped and dismissed ones go first', async () => {
  const h = party();
  for (let i = 1; i <= MAX_REPORTS; i++) seed(h, i, { status: i <= 3 ? 'dismissed' : 'open', dismissedAt: i <= 3 ? h.clock.t : null });
  assert.equal((await send(h, report())).status, 201);
  const n = h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_reports').get().n;
  assert.equal(n, MAX_REPORTS);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE status = 'dismissed'").get().n, 2);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE id = 'seed0003'").get().n, 0);
});

test('cleanup removes dismissed reports after 30 days and trims extra reports', async () => {
  const h = party();
  seed(h, 1, { status: 'dismissed', dismissedAt: h.clock.t - 31 * DAY });
  seed(h, 2, { status: 'dismissed', dismissedAt: h.clock.t - 29 * DAY });
  seed(h, 3, { created: h.clock.t - 400 * DAY });
  await h.worker.scheduled({}, h.env, {});
  assert.deepEqual(rows(h).map((r) => r.id).sort(), ['seed0002', 'seed0003']);
  for (let i = 10; i < 10 + MAX_REPORTS; i++) seed(h, i, { created: h.clock.t - i });
  await h.worker.scheduled({}, h.env, {});
  const left = rows(h);
  assert.equal(left.length, MAX_REPORTS);
  assert.ok(!left.some((r) => r.id === 'seed0002'));
  assert.ok(!left.some((r) => r.id === 'seed0003'));
  assert.ok(left.some((r) => r.id === 'seed0010'));
});

test('the activity admin check says who is banned and never bans the owner', async () => {
  const h = party();
  h.db.raw.prepare("INSERT INTO party_bans (id, banned_by, banned_at) VALUES (?, 'x', 1), (?, 'x', 1)").run(uid(5), OWNER.id);
  const res = await h.request('GET', `/api/activity/admins?ids=${[uid(5).toUpperCase(), uid(6), OWNER.id].join(',')}`);
  assert.deepEqual(await res.json(), { admins: [OWNER.id], owner: OWNER.id, banned: [uid(5).toUpperCase()] });
});

test('/api/me tells the owner and party admins that they are party staff', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const a = await h.login(OWNER);
  const b = await h.login(BOB);
  assert.deepEqual(await (await h.api('GET', '/api/me', a.cookie)).json().then((d) => [d.partyOwner, d.partyAdmin]), [true, true]);
  assert.deepEqual(await (await h.api('GET', '/api/me', b.cookie)).json().then((d) => [d.partyOwner, d.partyAdmin]), [false, true]);
  const other = party();
  const c = await other.login(BOB);
  assert.equal((await (await other.api('GET', '/api/me', c.cookie)).json()).partyAdmin, false);
});

test('report and ban pages are only for the owner and party admins', async () => {
  const h = party();
  const b = await h.login(BOB);
  const tries = [['GET', '/api/party/reports'], ['POST', '/api/party/reports/seed0001/dismiss', {}], ['DELETE', '/api/party/reports/seed0001'], ['GET', '/api/party/bans'], ['POST', '/api/party/bans', { id: uid(1) }], ['DELETE', `/api/party/bans/${uid(1)}`]];
  seed(h, 1);
  for (const [method, path, body] of tries) {
    const res = await h.api(method, path, b.cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json()).error, 'staff_only');
  }
  assert.equal((await h.api('GET', '/api/party/reports')).status, 401);
  const a = await h.login(OWNER);
  assert.equal((await h.api('POST', '/api/party/bans', a.cookie, { id: uid(1) }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.api('POST', '/api/party/reports/seed0001/dismiss', a.cookie, {}, { 'X-YapOS': null })).status, 403);
  assert.equal(rows(h)[0].status, 'open');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 0);
  assert.equal((await h.api('PATCH', '/api/party/reports', a.cookie, {})).status, 405);
  assert.equal((await h.api('GET', '/api/party/reports/x/y/z', a.cookie)).status, 404);
  assert.equal((await h.request('GET', '/party/reports')).status, 200);
});

test('staff see reports newest first, page by page, with the drawing and who is who', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, NULL, 0, ?)').run(uid(1), 'realrex', 'Real Rex', h.clock.t);
  await send(h, report());
  for (let i = 1; i <= 25; i++) seed(h, i, { created: h.clock.t - i * 1000 });
  seed(h, 99, { status: 'dismissed', dismissedAt: h.clock.t, created: h.clock.t - 500, drawer: BOB.id });
  const { cookie } = await h.login(BOB);
  const first = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal(first.role, 'admin');
  assert.equal(first.open, 26);
  assert.equal(first.reports.length, 20);
  const top = first.reports[0];
  assert.equal(top.game, 'draw');
  assert.equal(top.word, 'cactus');
  assert.deepEqual(top.ink, [STROKE]);
  assert.deepEqual(decodeStroke(top.ink[0]).pts, [[10, 10], [40, 40], [80, 20]]);
  assert.deepEqual([top.drawer.id, top.drawer.name, top.drawer.username, top.drawer.banned, top.drawer.role], [uid(1), 'Rex', 'rexplorer', false, null]);
  assert.equal(top.drawer.profile.username, 'realrex');
  assert.deepEqual([top.reporter.id, top.reporter.name, top.reporter.profile], [uid(2), 'Mila', null]);
  assert.equal(first.reports[1].id, 'seed0001');
  assert.ok(first.next);
  const second = await (await h.api('GET', `/api/party/reports?before=${encodeURIComponent(first.next)}`, cookie)).json();
  assert.equal(second.reports.length, 6);
  assert.equal(second.next, null);
  assert.equal(second.reports[5].id, 'seed0025');
  const dismissed = await (await h.api('GET', '/api/party/reports?status=dismissed', cookie)).json();
  assert.deepEqual(dismissed.reports.map((r) => [r.id, r.status, r.drawer.role]), [['seed0099', 'dismissed', 'admin']]);
  const all = await (await h.api('GET', '/api/party/reports?status=all', cookie)).json();
  assert.equal(all.reports[1].id, 'seed0099');
  assert.equal((await h.api('GET', '/api/party/reports?status=nope', cookie)).status, 400);
  assert.equal((await h.api('GET', `/api/party/reports?before=${encodeURIComponent("1' OR 1=1")}`, cookie)).status, 400);
});

test('staff can dismiss and delete reports', async () => {
  const h = party();
  seed(h, 1);
  seed(h, 2);
  const { cookie } = await h.login(OWNER);
  const d = await h.api('POST', '/api/party/reports/seed0001/dismiss', cookie, {});
  assert.deepEqual(await d.json(), { ok: true, dismissed: true });
  const row = h.db.raw.prepare("SELECT * FROM party_reports WHERE id = 'seed0001'").get();
  assert.deepEqual([row.status, row.dismissed_at, row.dismissed_by], ['dismissed', h.clock.t, OWNER.id]);
  assert.deepEqual(await (await h.api('POST', '/api/party/reports/seed0001/dismiss', cookie, {})).json(), { ok: true, dismissed: false });
  assert.equal((await h.api('POST', '/api/party/reports/missing1/dismiss', cookie, {})).status, 404);
  assert.equal((await h.api('GET', '/api/party/reports/seed0001/dismiss', cookie)).status, 405);
  assert.deepEqual(await (await h.api('DELETE', '/api/party/reports/seed0002', cookie)).json(), { ok: true, deleted: true });
  assert.deepEqual(await (await h.api('DELETE', '/api/party/reports/seed0002', cookie)).json(), { ok: true, deleted: false });
  assert.equal((await h.api('DELETE', `/api/party/reports/${encodeURIComponent('bad id!')}`, cookie)).status, 400);
  assert.deepEqual(rows(h).map((r) => r.id), ['seed0001']);
});

test('the owner can ban and unban, and bans reach the activity', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const res = await h.api('POST', '/api/party/bans', cookie, { id: ` ${uid(1).toUpperCase()} `, reason: '  Drew  something nasty ', name: 'Rex', username: '@rexplorer' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.banned, true);
  assert.equal(data.removedAdmin, false);
  assert.deepEqual(data.bans.map((b) => [b.id, b.name, b.username, b.reason, b.banned_at]), [[uid(1), 'Rex', 'rexplorer', 'Drew something nasty', h.clock.t]]);
  assert.equal(h.db.raw.prepare('SELECT banned_by FROM party_bans').get().banned_by, OWNER.id);
  const again = await (await h.api('POST', '/api/party/bans', cookie, { id: uid(1) })).json();
  assert.equal(again.banned, false);
  assert.equal(again.bans.length, 1);
  await send(h, report());
  const list = await (await h.api('GET', '/api/party/reports', cookie)).json();
  assert.equal(list.reports[0].drawer.banned, true);
  const check = await (await h.request('GET', `/api/activity/admins?ids=${uid(1)},${uid(2)}`)).json();
  assert.deepEqual(check.banned, [uid(1)]);
  const gone = await (await h.api('DELETE', `/api/party/bans/${uid(1)}`, cookie)).json();
  assert.equal(gone.unbanned, true);
  assert.deepEqual(gone.bans, []);
  assert.equal((await (await h.api('DELETE', `/api/party/bans/${uid(1)}`, cookie)).json()).unbanned, false);
  assert.deepEqual((await (await h.request('GET', `/api/activity/admins?ids=${uid(1)}`)).json()).banned, []);
});

test('nobody can ban the owner, admins cannot ban admins, and the owner banning an admin removes their panel', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  addAdmin(h, uid(9));
  const b = await h.login(BOB);
  const a = await h.login(OWNER);
  for (const cookie of [a.cookie, b.cookie]) {
    const res = await h.api('POST', '/api/party/bans', cookie, { id: OWNER.id.toUpperCase() });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'is_owner');
  }
  const peer = await h.api('POST', '/api/party/bans', b.cookie, { id: uid(9) });
  assert.equal(peer.status, 403);
  assert.equal((await peer.json()).error, 'is_admin');
  const self = await h.api('POST', '/api/party/bans', b.cookie, { id: BOB.id });
  assert.equal(self.status, 400);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 0);
  assert.equal((await h.api('POST', '/api/party/bans', b.cookie, { id: uid(20) })).status, 200);
  const res = await (await h.api('POST', '/api/party/bans', a.cookie, { id: uid(9) })).json();
  assert.equal(res.banned, true);
  assert.equal(res.removedAdmin, true);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins WHERE id = ?').get(uid(9)).n, 0);
  for (const body of [{}, { id: '' }, { id: 'bad id!' }, { id: 42 }, { id: uid(30), reason: 5 }, { id: uid(30), role: 'x' }]) {
    const r = await h.api('POST', '/api/party/bans', a.cookie, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await h.api('DELETE', `/api/party/bans/${encodeURIComponent('bad id!')}`, a.cookie)).status, 400);
});

const { document } = installDom({ url: 'https://dash.example.test/party/reports' });
document.documentElement = document.createElement('html');
const { state } = await import('../web/js/state.js');
const { renderPartyReports, readReports, readBans, decodeInk, gameName, paintReport, REPORTS_PATH, BANS_PATH } = await import('../web/js/pages/party-reports.js');
const { matchRoute } = await import('../web/js/router.js');
const { createShell } = await import('../web/js/shell.js');
const { ApiError } = await import('../web/js/api.js');

const ME = { id: OWNER.id, username: 'alice', display_name: 'Alice', avatar_url: '' };

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const chrome = [];
  return { api, main, signal: ctrl.signal, params: {}, setChrome: (c) => chrome.push(c), chrome, abort: () => ctrl.abort() };
}

const buttons = (root, re) => root.querySelectorAll('button').filter((b) => re.test(b.textContent));

function item(over = {}) {
  return {
    id: 'rep1',
    game: 'draw',
    word: 'cactus',
    created: Date.now() - 60000,
    status: 'open',
    ink: [STROKE],
    drawer: { id: uid(1), name: 'Rex', username: 'rexplorer', profile: { username: 'realrex', display_name: 'Real Rex', avatar: null }, banned: false, role: null },
    reporter: { id: uid(2), name: 'Mila', profile: null },
    ...over,
  };
}

function api({ reports = [item()], next = null, open = 1, role = 'owner', bans = [] } = {}, extra = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => {
      calls.push(['GET', path]);
      if (path.startsWith(REPORTS_PATH)) return { reports, next, open, role };
      return { bans, max: 1000 };
    },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      if (path === BANS_PATH) return { bans: [{ id: body.id, name: body.name, username: body.username, display_name: null, avatar: null, reason: body.reason, banned_at: Date.now() }], banned: true };
      return { ok: true, dismissed: true };
    },
    request: async (method, path) => {
      calls.push([method, path]);
      if (path.startsWith(BANS_PATH)) return { bans: [], unbanned: true };
      return { ok: true, deleted: true };
    },
    ...extra,
  };
}

async function confirmWith(label) {
  await flush();
  const dialog = document.body.querySelector('.dialog-panel');
  assert.ok(dialog, 'dialog open');
  const text = dialog.textContent;
  buttons(dialog, new RegExp(`^${label}$`))[0].click();
  await flush();
  return text;
}

test('the reports route is private and the helpers read data safely', () => {
  const r = matchRoute('/party/reports');
  assert.equal(r.name, 'party-reports');
  assert.equal(r.private, true);
  assert.equal(matchRoute('/party/reports/x').name, 'not-found');
  assert.deepEqual(readReports(null), { reports: [], next: null, open: 0, role: 'admin' });
  assert.deepEqual(readBans({ bans: [null, { id: 5 }] }).bans, []);
  assert.equal(decodeInk([STROKE, 'bad', 7]).length, 1);
  assert.equal(gameName('telephone'), 'Draw Telephone');
  assert.equal(gameName('odd'), 'Odd One Out');
  assert.equal(gameName('x'), 'Drawing game');
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === 'getImageData' || k === 'putImageData' ? undefined : (...a) => calls.push([k, ...a])), set: () => true });
  assert.equal(paintReport({ getContext: () => ctx }, [STROKE]), true);
  assert.ok(calls.some(([k]) => k === 'fillRect'));
  assert.ok(calls.some(([k]) => k === 'lineTo'));
  assert.equal(paintReport({}, [STROKE]), false);
});

test('people who are not party staff see a polite page and nothing is fetched', async () => {
  state.user = { ...ME, id: BOB.id };
  state.partyOwner = false;
  state.partyAdmin = false;
  const a = api();
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  assert.equal(a.calls.length, 0);
  assert.match(ctx.main.textContent, /Only party staff can open this/);
  ctx.abort();
});

test('staff see each report with the drawing, the drawer and the reporter', async () => {
  state.user = ME;
  state.partyOwner = true;
  state.partyAdmin = true;
  const a = api({ reports: [item(), item({ id: 'rep2', game: 'telephone', word: null, ink: [], status: 'dismissed', drawer: { id: uid(3), name: 'Juno', username: null, profile: null, banned: true, role: null } })], open: 1, bans: [{ id: uid(3), name: 'Juno', username: null, display_name: 'Juno', avatar: null, reason: 'Reported drawing', banned_at: Date.now() }] });
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  assert.deepEqual(a.calls.map((c) => c[1]).sort(), [BANS_PATH, `${REPORTS_PATH}?status=open`]);
  assert.equal(ctx.chrome[0].section, 'party-reports');
  const items = ctx.main.querySelectorAll('.report-item');
  assert.equal(items.length, 2);
  const [one, two] = items;
  assert.equal(one.querySelectorAll('canvas').length, 1);
  assert.match(one.querySelector('canvas').getAttribute('aria-label'), /Rex/);
  assert.match(one.textContent, /Draw & Guess/);
  assert.match(one.textContent, /@rexplorer/);
  assert.match(one.textContent, new RegExp(uid(1)));
  assert.match(one.textContent, /Yapin' knows this id as Real Rex @realrex/);
  assert.match(one.textContent, /Mila/);
  assert.match(one.textContent, /cactus/);
  assert.match(one.textContent, /treat them as claims/);
  assert.equal(buttons(one, /Ban from Party/).length, 1);
  assert.equal(buttons(one, /Dismiss/).length, 1);
  assert.equal(buttons(one, /Delete/).length, 1);
  assert.match(two.textContent, /Draw Telephone/);
  assert.match(two.textContent, /No drawing was sent/);
  assert.match(two.textContent, /Banned/);
  assert.match(two.textContent, /Dismissed/);
  assert.equal(buttons(two, /Ban from Party/).length, 0);
  assert.equal(buttons(two, /Dismiss/).length, 0);
  assert.match(ctx.main.textContent, /1 open/);
  assert.match(ctx.main.textContent, /1 banned/);
  assert.equal(buttons(ctx.main, /Unban/).length, 1);
  ctx.abort();
});

test('the owner and admins cannot be banned from a report, except admins by the owner', async () => {
  state.partyOwner = false;
  state.partyAdmin = true;
  const reports = [item({ id: 'o', drawer: { ...item().drawer, role: 'owner' } }), item({ id: 'a', drawer: { ...item().drawer, id: uid(4), role: 'admin' } })];
  const ctx = makeCtx(api({ reports, role: 'admin' }));
  renderPartyReports(ctx);
  await flush();
  assert.equal(buttons(ctx.main, /Ban from Party/).length, 0);
  assert.match(ctx.main.textContent, /Only the owner can ban a party admin/);
  ctx.abort();
  state.partyOwner = true;
  const owned = makeCtx(api({ reports, role: 'owner' }));
  renderPartyReports(owned);
  await flush();
  assert.equal(buttons(owned.main, /Ban from Party/).length, 1);
  owned.abort();
});

test('banning asks first, sends the drawer and a reason, and updates both lists', async () => {
  state.partyOwner = true;
  const a = api();
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  buttons(ctx.main, /Ban from Party/)[0].click();
  await flush();
  buttons(document.body.querySelector('.dialog-panel'), /^Cancel$/)[0].click();
  await flush();
  assert.equal(a.calls.filter((c) => c[0] === 'POST').length, 0);
  buttons(ctx.main, /Ban from Party/)[0].click();
  const text = await confirmWith('Ban');
  assert.match(text, /Ban Rex from YapOS Party\?/);
  assert.match(text, /still watch/);
  const post = a.calls.find((c) => c[0] === 'POST');
  assert.deepEqual(post, ['POST', BANS_PATH, { id: uid(1), reason: 'Reported drawing in Draw & Guess (word: cactus)', name: 'Rex', username: 'rexplorer' }]);
  assert.equal(buttons(ctx.main, /Ban from Party/).length, 0);
  assert.match(ctx.main.querySelector('.report-item').textContent, /Banned/);
  assert.match(ctx.main.textContent, /1 banned/);
  ctx.abort();
});

test('dismiss and delete ask first and then update the list', async () => {
  state.partyOwner = true;
  const a = api({ reports: [item(), item({ id: 'rep2' })], open: 2 });
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  buttons(ctx.main.querySelectorAll('.report-item')[0], /Dismiss/)[0].click();
  assert.match(await confirmWith('Dismiss'), /Dismiss this report\?/);
  assert.deepEqual(a.calls.find((c) => c[0] === 'POST'), ['POST', `${REPORTS_PATH}/rep1/dismiss`, {}]);
  assert.equal(ctx.main.querySelectorAll('.report-item').length, 1);
  assert.match(ctx.main.textContent, /1 open/);
  buttons(ctx.main.querySelectorAll('.report-item')[0], /Delete/)[0].click();
  assert.match(await confirmWith('Delete'), /gone for good/);
  assert.deepEqual(a.calls.find((c) => c[0] === 'DELETE'), ['DELETE', `${REPORTS_PATH}/rep2`]);
  assert.equal(ctx.main.querySelectorAll('.report-item').length, 0);
  assert.match(ctx.main.textContent, /No open reports/);
  ctx.abort();
});

test('unban asks first and older reports load on demand', async () => {
  state.partyOwner = true;
  let page = 0;
  const a = api({ bans: [{ id: uid(7), name: 'Kit', username: 'kitkatz', display_name: null, avatar: null, reason: null, banned_at: 1 }] });
  a.get = async (path) => {
    a.calls.push(['GET', path]);
    if (!path.startsWith(REPORTS_PATH)) return { bans: [{ id: uid(7), name: 'Kit', username: 'kitkatz', display_name: null, avatar: null, reason: null, banned_at: 1 }] };
    page += 1;
    return page === 1 ? { reports: [item()], next: '5.rep1', open: 2, role: 'owner' } : { reports: [item({ id: 'rep0' })], next: null, open: 2, role: 'owner' };
  };
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  buttons(ctx.main, /Show older reports/)[0].click();
  await flush();
  assert.ok(a.calls.some((c) => c[1] === `${REPORTS_PATH}?status=open&before=5.rep1`));
  assert.equal(ctx.main.querySelectorAll('.report-item').length, 2);
  assert.equal(buttons(ctx.main, /Show older reports/).length, 0);
  buttons(ctx.main, /Unban/)[0].click();
  assert.match(await confirmWith('Unban'), /Unban Kit\?/);
  assert.deepEqual(a.calls.find((c) => c[0] === 'DELETE'), ['DELETE', `${BANS_PATH}/${uid(7)}`]);
  assert.match(ctx.main.textContent, /Nobody is banned/);
  ctx.abort();
});

test('switching to Dismissed reloads the list and a 403 falls back to the staff-only page', async () => {
  state.partyOwner = true;
  const a = api();
  const ctx = makeCtx(a);
  renderPartyReports(ctx);
  await flush();
  buttons(ctx.main, /^Dismissed$/)[0].click();
  await flush();
  assert.ok(a.calls.some((c) => c[1] === `${REPORTS_PATH}?status=dismissed`));
  ctx.abort();
  state.partyOwner = false;
  state.partyAdmin = true;
  const denied = makeCtx(api({}, { get: async () => { throw new ApiError('Only the owner of YapOS Party and party admins can see reports.', { status: 403, code: 'staff_only' }); } }));
  renderPartyReports(denied);
  await flush();
  assert.match(denied.main.textContent, /Only party staff can open this/);
  assert.equal(state.partyAdmin, false);
  denied.abort();
});

test('the Party reports link shows for the owner and party admins only', () => {
  const shell = createShell({ onLogout() {} });
  const links = () => shell.root.querySelectorAll('a').filter((x) => x.href === '/party/reports');
  shell.update({ variant: 'plain', user: ME, partyOwner: false, partyAdmin: false });
  assert.equal(links().length, 0);
  shell.update({ variant: 'plain', user: ME, partyOwner: false, partyAdmin: true, section: 'party-reports' });
  assert.ok(links().length >= 1);
  assert.equal(links()[0].getAttribute('aria-label'), 'Party reports');
  assert.equal(shell.root.querySelectorAll('a').filter((x) => x.href === '/party').length, 0);
  shell.update({ variant: 'plain', user: ME, partyOwner: true, partyAdmin: true });
  assert.ok(links().length >= 1);
});
