import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { configureAdmins, resetAdmins, refreshAdmins, isBanned, banUntil } from '../web/activity/js/admin.js';
import { setCustomTerms, censor, isBlockedWord } from '../web/activity/js/filter.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const REX = '77777777-7777-4777-8777-000000000001';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function party() {
  return createHarness({ PARTY_OWNER_ID: OWNER.id });
}

function addAdmin(h, id) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').run(id, OWNER.id, 1);
}

test('a party admin who is banned cannot lift their own ban', async () => {
  const h = party();
  addAdmin(h, BOB.id);
  const bob = (await h.login(BOB)).cookie;
  h.db.raw.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, NULL, NULL, ?, ?)').run(BOB.id.toLowerCase(), 'Bob', OWNER.id, h.clock.t);
  const res = await h.api('DELETE', `/api/party/bans/${BOB.id}`, bob);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'is_self');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_bans').get().n, 1);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM party_mod_log WHERE action = 'unban'").get().n, 0);
});

test('the owner cannot make someone a party admin while they are banned', async () => {
  const h = party();
  const owner = (await h.login(OWNER)).cookie;
  const ban = await h.api('POST', '/api/party/bans', owner, { id: REX, name: 'Rex', duration: 'hour' });
  assert.equal(ban.status, 200);
  const res = await h.api('POST', '/api/party/admins', owner, { id: REX });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'is_banned');
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins').get().n, 0);
  h.clock.t += HOUR;
  const later = await h.api('POST', '/api/party/admins', owner, { id: REX });
  assert.equal(later.status, 200);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins').get().n, 1);
});

test('the admin check sends the server time with timed bans', async () => {
  const h = party();
  const owner = (await h.login(OWNER)).cookie;
  await h.api('POST', '/api/party/bans', owner, { id: REX, name: 'Rex', duration: 'hour' });
  const body = await (await h.request('GET', `/api/activity/admins?ids=${REX}`, { ip: '198.51.100.77' })).json();
  assert.equal(body.now, h.clock.t);
  assert.equal(body.until[REX], h.clock.t + HOUR);
});

test('a timed ban in the call ends on server time even when the host clock is wrong', async () => {
  resetAdmins();
  const server = 50_000_000;
  let clock = server + 3 * HOUR;
  configureAdmins({
    now: () => clock,
    refreshMs: 0,
    fetch: async () => ({ ok: true, json: async () => ({ admins: [], owner: null, banned: [REX], until: { [REX]: server + HOUR }, now: server }) }),
  });
  await refreshAdmins([REX]);
  assert.equal(isBanned(REX), true, 'a host clock 3 hours fast does not end a 1 hour ban early');
  assert.equal(banUntil(REX), server + 4 * HOUR);
  clock = server + 4 * HOUR - 1;
  assert.equal(isBanned(REX), true);
  clock = server + 4 * HOUR;
  assert.equal(isBanned(REX), false);
  resetAdmins();
});

test('a small clock difference does not move the ban end', async () => {
  resetAdmins();
  const server = 50_000_000;
  configureAdmins({
    now: () => server + 20_000,
    refreshMs: 0,
    fetch: async () => ({ ok: true, json: async () => ({ admins: [], owner: null, banned: [REX], until: { [REX]: server + HOUR }, now: server }) }),
  });
  await refreshAdmins([REX]);
  assert.equal(banUntil(REX), server + HOUR);
  resetAdmins();
});

test('custom blocked words stay fast on long spammy text and still match inside words', () => {
  const terms = [];
  for (let i = 0; i < 500; i += 1) terms.push(`zq${i.toString(36).padStart(4, 'x')}${'blorpwidget'.slice(0, (i % 30) + 1)}`);
  terms.unshift('snorkelbad');
  terms.length = 500;
  setCustomTerms(terms, { encoded: false });
  try {
    assert.equal(isBlockedWord('mysnorkelbadthing'), true);
    assert.equal(censor('hello snorkelbad there').changed, true);
    assert.equal(censor('hello friend').changed, false);
    const spam = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join(' ');
    const start = performance.now();
    for (let r = 0; r < 20; r += 1) censor(spam);
    const each = (performance.now() - start) / 20;
    assert.ok(each < 60, `censor took ${each.toFixed(1)} ms`);
  } finally {
    setCustomTerms([]);
  }
});
