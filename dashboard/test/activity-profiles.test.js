import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, BOT_SECRET } from './helpers.js';
import { WANTED_CAP, PROFILE_STALE } from '../worker/profiles.js';
import { configureProfiles, resetProfiles, wantProfiles, flush, profileOf, rememberProfiles, profileAvatar, waitingFor, RETRY_MS, GIVE_UP_MS, PROFILES_EVENT } from '../web/activity/js/profiles.js';
import { person, people } from '../web/activity/js/players.js';

const A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const C = '33333333-3333-4333-8333-cccccccccccc';
const MIN = 60 * 1000;

function idList(n, prefix = 'u') {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
}

function wantedIds(h) {
  return h.db.raw.prepare('SELECT id FROM profile_wanted ORDER BY id').all().map((r) => r.id);
}

async function lookup(h, ids, ip) {
  const q = Array.isArray(ids) ? ids.join(',') : ids;
  return h.request('GET', `/api/activity/profiles?ids=${encodeURIComponent(q)}`, { ip });
}

test('profiles endpoint validates ids and needs no sign-in', async () => {
  const h = createHarness();
  const ok = await lookup(h, [A, B]);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.profiles, []);
  assert.deepEqual(body.pending.sort(), [A, B].sort());
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');

  for (const bad of ['', ',,,', 'abc def', 'x'.repeat(65), `${A},<script>`, '../etc', 'a%2Fb']) {
    const res = await h.request('GET', `/api/activity/profiles?ids=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    const err = await res.json();
    assert.match(err.error, /bad_id|too_many/);
    assert.ok(err.message);
  }
  assert.equal((await h.request('GET', '/api/activity/profiles')).status, 400);
  assert.equal((await lookup(h, idList(41))).status, 400);
  assert.equal((await lookup(h, idList(40))).status, 200);
  assert.equal((await h.request('POST', '/api/activity/profiles?ids=abc', { body: {} })).status, 405);
  assert.equal((await h.request('GET', '/api/activity/other')).status, 404);
  const dupes = await (await lookup(h, [A, A, A])).json();
  assert.deepEqual(dupes.pending, [A]);
});

test('profiles endpoint is rate limited per IP', async () => {
  const h = createHarness();
  let last;
  for (let i = 0; i < 61; i++) last = await lookup(h, [A], '198.51.100.9');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('Retry-After')) >= 1);
  assert.equal((await lookup(h, [A], '198.51.100.10')).status, 200);
  advance(h, MIN);
  assert.equal((await lookup(h, [A], '198.51.100.9')).status, 200);
});

test('wanted ids are capped so the table cannot be flooded', async () => {
  const h = createHarness();
  for (let i = 0; i < 14; i++) {
    await lookup(h, idList(40, `w${String(i).padStart(2, '0')}x`), `203.0.113.${i + 1}`);
    advance(h, 10);
  }
  const rows = h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_wanted').get().n;
  assert.equal(rows, WANTED_CAP);
  const ids = wantedIds(h);
  assert.ok(ids.includes('w13x0039'), 'the newest ask is kept');
  assert.ok(!ids.includes('w00x0000'), 'the oldest ask is dropped');
});

test('one IP can only queue so many new ids a minute and retries do not count again', async () => {
  const h = createHarness();
  const ip = '192.0.2.77';
  for (let i = 0; i < 5; i++) await lookup(h, idList(40, `q${i}x`), ip);
  assert.equal(wantedIds(h).length, 200);
  for (let i = 0; i < 5; i++) await lookup(h, idList(40, `q${i}x`), ip);
  assert.equal(wantedIds(h).length, 200);
  const over = await (await lookup(h, idList(40, 'q9x'), ip)).json();
  assert.equal(over.pending.length, 40);
  assert.equal(wantedIds(h).length, 200);
  assert.equal(wantedIds(h).filter((id) => id.startsWith('q9x')).length, 0);
  await lookup(h, idList(40, 'r0x'), '192.0.2.78');
  assert.equal(wantedIds(h).filter((id) => id.startsWith('r0x')).length, 40);
  advance(h, MIN);
  await lookup(h, idList(40, 'q9x'), ip);
  assert.equal(wantedIds(h).filter((id) => id.startsWith('q9x')).length, 40);
});

test('the bot poll carries wanted ids, stays hot while they wait, and hands each out once a minute', async () => {
  const h = createHarness();
  const cold = await h.poll();
  assert.deepEqual(cold.wanted, []);
  assert.equal(cold.hot, false);
  await lookup(h, idList(30, 'p'));
  const first = await h.poll();
  assert.equal(first.wanted.length, 25);
  assert.equal(first.hot, true);
  const second = await h.poll();
  assert.equal(second.wanted.length, 5);
  assert.equal(second.hot, true);
  const third = await h.poll();
  assert.equal(third.wanted.length, 0);
  assert.equal(third.hot, true);
  advance(h, MIN + 1);
  const again = await h.poll();
  assert.equal(again.wanted.length, 25, 'unanswered ids are handed out again after a minute');
  advance(h, 10 * MIN);
  const old = await h.poll();
  assert.deepEqual(old.wanted, []);
  assert.equal(old.hot, false);
});

test('the bot uploads profiles, which fill the cache, clear wanted and filter avatar hosts', async () => {
  const h = createHarness();
  await lookup(h, [A, B, C, 'gone1']);
  const up = await h.bot('POST', '/bot/profiles', {
    profiles: [
      { id: A, username: '@jolli', display_name: 'Jolli\u0000 ', avatar_url: 'https://files.yapper.website/avatars/a.png' },
      { id: B, username: 'x'.repeat(200), display_name: 'Deepend', avatar_url: 'https://evil.example/a.png' },
      { id: C, username: 'shi', display_name: null, avatar_url: 'http://files.yapper.website/a.png' },
      { id: 'bad id', username: 'nope' },
      { id: A, username: 'twice' },
      'junk',
    ],
    missing: ['gone1', 'bad id!', 42],
  });
  assert.equal(up.status, 200);
  const out = await up.json();
  assert.equal(out.stored, 3);
  assert.equal(out.missing, 1);
  assert.equal(out.ignored.length, 5);
  assert.deepEqual(wantedIds(h), []);

  const res = await lookup(h, [A, B, C, 'gone1']);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  const body = await res.json();
  assert.deepEqual(body.pending, []);
  const by = Object.fromEntries(body.profiles.map((p) => [p.id, p]));
  assert.deepEqual(by[A], { id: A, username: 'jolli', display_name: 'Jolli', avatar: 'https://files.yapper.website/avatars/a.png' });
  assert.equal(by[B].username.length, 64);
  assert.equal(by[B].avatar, null);
  assert.equal(by[C].avatar, null);
  assert.equal(by[C].display_name, null);
  assert.deepEqual(by.gone1, { id: 'gone1', username: null, display_name: null, avatar: null });
  assert.deepEqual(wantedIds(h), [], 'fresh profiles and tombstones are not asked for again');
  assert.equal((await h.poll()).wanted.length, 0);

  h.db.raw.prepare("UPDATE profiles SET avatar_url = 'https://evil.example/x.png' WHERE id = ?").run(A);
  const sneaky = await (await lookup(h, [A])).json();
  assert.equal(sneaky.profiles[0].avatar, null, 'avatars are filtered again on the way out');

  advance(h, PROFILE_STALE + 1);
  const stale = await (await lookup(h, [A, 'gone1'])).json();
  assert.equal(stale.profiles.length, 2, 'stale profiles are still answered');
  assert.deepEqual(stale.pending, []);
  assert.deepEqual(wantedIds(h), [A, 'gone1'].sort(), 'stale ones are asked for again');
});

test('the bot upload route needs the bot secret and checks its shape', async () => {
  const h = createHarness();
  assert.equal((await h.bot('POST', '/bot/profiles', { profiles: [] }, 'wrong')).status, 401);
  assert.equal((await h.bot('POST', '/bot/profiles', { profiles: [] }, null)).status, 401);
  assert.equal((await h.bot('GET', '/bot/profiles')).status, 405);
  assert.equal((await h.bot('POST', '/bot/profiles', { profiles: 'nope' })).status, 400);
  assert.equal((await h.bot('POST', '/bot/profiles', { missing: {} })).status, 400);
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `id${i}` }));
  assert.equal((await h.bot('POST', '/bot/profiles', { profiles: many })).status, 413);
  const big = await h.bot('POST', '/bot/profiles', { profiles: [{ id: A, username: 'x'.repeat(70 * 1024) }] });
  assert.equal(big.status, 413);
  assert.equal(BOT_SECRET.length >= 32, true);
});

test('cleanup drops old wanted ids and month-old profiles', async () => {
  const h = createHarness();
  await lookup(h, [A]);
  await h.bot('POST', '/bot/profiles', { profiles: [{ id: B, username: 'b' }] });
  advance(h, 31 * 24 * 60 * MIN);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_wanted').get().n, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 0);
});

function fakeClient({ href = 'https://yapos.dev/activity/' } = {}) {
  const c = { calls: [], events: 0, timers: [], t: 1_000_000, answers: new Map(), fail: false };
  c.win = {
    location: { href },
    CustomEvent: class { constructor(type) { this.type = type; } },
    dispatchEvent(e) { if (e.type === PROFILES_EVENT) c.events += 1; return true; },
  };
  c.fetch = async (url, init) => {
    const u = new URL(url);
    c.calls.push({ path: u.pathname, ids: u.searchParams.get('ids').split(','), init });
    if (c.fail) throw new TypeError('offline');
    const profiles = u.searchParams.get('ids').split(',').filter((id) => c.answers.has(id)).map((id) => c.answers.get(id));
    return { ok: true, json: async () => ({ profiles }) };
  };
  c.setTimeout = (fn, ms) => { const t = { fn, ms }; c.timers.push(t); return t; };
  c.clearTimeout = (t) => { c.timers = c.timers.filter((x) => x !== t); };
  c.runTimers = async () => {
    const list = c.timers.splice(0);
    for (const t of list) { c.t += t.ms; t.fn(); }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  configureProfiles({ win: c.win, fetch: c.fetch, now: () => c.t, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  return c;
}

beforeEach(() => resetProfiles());

test('profiles.js batches, de-duplicates and fills person() with username and avatar', async () => {
  const c = fakeClient();
  c.answers.set(A, { id: A, username: 'greninjite', display_name: 'Someone Else', avatar: 'https://files.yapper.website/avatars/g.png' });
  c.answers.set(B, { id: B, username: 'shisho', display_name: 'Shi-sho', avatar: 'https://evil.example/x.png' });
  const before = person({ id: A, display_name: 'Deepend' });
  assert.equal(before.username, null);
  assert.equal(before.avatar, null);
  assert.equal(before.initials, 'D');

  assert.equal(wantProfiles([{ id: A }, A, B, 'not ok!', null]), 2);
  assert.equal(wantProfiles([A]), 0);
  assert.equal(c.timers.length, 1);
  await c.runTimers();
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].ids.sort(), [A, B].sort());
  assert.equal(c.calls[0].path, '/api/activity/profiles');
  assert.equal(c.calls[0].init.credentials, 'omit');
  assert.equal(c.events, 1, 'one re-render signal for the whole batch');

  const p = person({ id: A, display_name: 'Deepend' });
  assert.equal(p.name, 'Deepend', "Yapin's display name still wins");
  assert.equal(p.username, 'greninjite');
  assert.equal(p.avatar, 'https://files.yapper.website/avatars/g.png');
  assert.equal(p.initials, 'D');
  const q = person({ id: B, display_name: 'Shi-sho' });
  assert.equal(q.username, 'shisho');
  assert.equal(q.avatar, null, 'avatars on other hosts are dropped');
  assert.equal(person(A).name, 'Someone Else', 'the profile name fills in when Yapin gave none');
  assert.deepEqual(people([{ id: A, name: 'Deepend' }, { id: A }]).map((x) => x.username), ['greninjite']);

  assert.equal(wantProfiles([A, B]), 0, 'cached ids are not asked again');
  assert.equal(c.timers.length, 0);
});

test('profiles.js retries ids the server has not got yet and gives up after about a minute', async () => {
  const c = fakeClient();
  wantProfiles([A, B]);
  c.answers.set(A, { id: A, username: 'a', display_name: 'A', avatar: null });
  await c.runTimers();
  assert.equal(c.calls.length, 1);
  assert.deepEqual(waitingFor(), [B]);
  assert.equal(c.timers.length, 1);
  assert.ok(c.timers[0].ms >= RETRY_MS - 100);
  await c.runTimers();
  assert.deepEqual(c.calls[1].ids, [B], 'only the missing id is asked again');
  c.answers.set(B, { id: B, username: 'bee', display_name: 'B', avatar: null });
  await c.runTimers();
  assert.equal(person({ id: B, name: 'B' }).username, 'bee');
  assert.deepEqual(waitingFor(), []);
  assert.equal(c.timers.length, 0);

  wantProfiles([C]);
  let rounds = 0;
  while (c.timers.length && rounds < 100) {
    await c.runTimers();
    rounds += 1;
  }
  assert.ok(rounds < 100);
  const asked = c.calls.filter((x) => x.ids.includes(C)).length;
  assert.ok(asked >= 10 && asked <= Math.ceil(GIVE_UP_MS / RETRY_MS) + 2, `asked ${asked} times`);
  assert.deepEqual(waitingFor(), []);
});

test('profiles.js fails quietly with no network and keeps initials', async () => {
  configureProfiles({ win: null });
  assert.equal(wantProfiles([A]), 0);
  assert.equal(person({ id: A, display_name: 'Jolli' }).initials, 'J');
  resetProfiles();
  const c = fakeClient();
  c.fail = true;
  wantProfiles([A]);
  await c.runTimers();
  assert.equal(c.calls.length, 1);
  assert.equal(c.events, 0);
  const p = person({ id: A, display_name: 'Jolli' });
  assert.equal(p.avatar, null);
  assert.equal(p.username, null);
  assert.equal(p.initials, 'J');
});

test('profiles.js cleans what it stores and only allows local avatars on the dev page', () => {
  const c = fakeClient({ href: 'https://yapos.dev/activity/?dev=1' });
  assert.equal(profileAvatar('/activity-dev/avatars/3.svg'), null);
  assert.equal(profileAvatar('javascript:alert(1)'), null);
  assert.equal(profileAvatar('https://user:pw@files.yapper.website/a.png'), null);
  assert.equal(profileAvatar('https://www.yapin.gg/a.png'), 'https://www.yapin.gg/a.png');
  rememberProfiles([{ id: A, username: '@@bad‮name', display_name: 'X', avatar: 'data:image/png;base64,AAAA' }]);
  assert.deepEqual(profileOf(A), { username: 'badname', displayName: 'X', avatar: null });
  assert.equal(c.events, 1);
  assert.equal(rememberProfiles([{ id: A, username: 'badname', display_name: 'X', avatar: null }]), 0, 'no change, no event');
  assert.equal(c.events, 1);

  resetProfiles();
  fakeClient({ href: 'http://localhost:8787/activity/?dev=1' });
  assert.equal(profileAvatar('/activity-dev/avatars/3.svg'), 'http://localhost:8787/activity-dev/avatars/3.svg');
  assert.equal(profileAvatar('/activity-dev/avatars/../x.svg'), null);
  assert.equal(profileAvatar('http://localhost:9999/activity-dev/avatars/3.svg'), null);
  resetProfiles();
  fakeClient({ href: 'http://localhost:8787/activity/' });
  assert.equal(profileAvatar('/activity-dev/avatars/3.svg'), null, 'needs the dev flag');
});
