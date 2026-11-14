import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { installDom, type, fire, flush } from './dom-shim.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const uid = (i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;

function party(overrides = {}) {
  return createHarness({ PARTY_OWNER_ID: OWNER.id, ...overrides });
}

async function admins(h, ids, ip) {
  return h.request('GET', `/api/activity/admins?ids=${encodeURIComponent(ids.join(','))}`, { ip });
}

function addRow(h, id, at = 1) {
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(id, OWNER.id, at);
}

test('the activity admin check needs no sign-in and says who is an admin', async () => {
  const h = party();
  addRow(h, uid(1));
  const res = await admins(h, [uid(1), uid(2), OWNER.id]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, max-age=30');
  assert.deepEqual(await res.json(), { admins: [uid(1), OWNER.id], owner: OWNER.id });
});

test('the owner is always an admin, even with an empty table and different letter case', async () => {
  const h = party();
  const upper = OWNER.id.toUpperCase();
  const body = await (await admins(h, [upper, uid(5)])).json();
  assert.deepEqual(body, { admins: [upper], owner: upper });
  const none = await (await admins(h, [uid(5)])).json();
  assert.deepEqual(none, { admins: [], owner: null });
});

test('without an owner configured nobody is the owner, but added admins still count', async () => {
  const h = createHarness();
  addRow(h, uid(3));
  const body = await (await admins(h, [OWNER.id, uid(3)])).json();
  assert.deepEqual(body, { admins: [uid(3)], owner: null });
});

test('the activity admin check refuses bad, missing and too many ids', async () => {
  const h = party();
  assert.equal((await h.request('GET', '/api/activity/admins')).status, 400);
  assert.equal((await h.request('GET', '/api/activity/admins?ids=')).status, 400);
  const bad = await h.request('GET', `/api/activity/admins?ids=${encodeURIComponent("x'; DROP TABLE party_admins; --")}`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_id');
  const many = Array.from({ length: 41 }, (_, i) => uid(i + 1));
  assert.equal((await admins(h, many)).status, 400);
  assert.equal((await admins(h, many.slice(0, 40))).status, 200);
  assert.equal((await h.request('POST', `/api/activity/admins?ids=${uid(1)}`)).status, 405);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'party_admins'").get().n, 1);
});

test('the activity admin check is rate limited per address', async () => {
  const h = party();
  for (let i = 0; i < 60; i++) assert.equal((await admins(h, [uid(1)], '198.51.100.1')).status, 200);
  const blocked = await admins(h, [uid(1)], '198.51.100.1');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) >= 1);
  assert.equal((await admins(h, [uid(1)], '198.51.100.2')).status, 200);
  advance(h, MIN);
  assert.equal((await admins(h, [uid(1)], '198.51.100.1')).status, 200);
});

test('/api/me tells only the owner that they own YapOS Party', async () => {
  const h = party();
  const a = await h.login(OWNER);
  const b = await h.login(BOB);
  const mine = await (await h.api('GET', '/api/me', a.cookie)).json();
  assert.equal(mine.partyOwner, true);
  assert.equal(mine.user.id, OWNER.id);
  assert.equal((await (await h.api('GET', '/api/me', b.cookie)).json()).partyOwner, false);
  const unset = createHarness();
  const c = await unset.login(OWNER);
  assert.equal((await (await unset.api('GET', '/api/me', c.cookie)).json()).partyOwner, false);
});

test('the party admin page api is only for the owner', async () => {
  const h = party();
  const b = await h.login(BOB);
  for (const [method, path, body] of [['GET', '/api/party/admins'], ['POST', '/api/party/admins', { id: uid(1) }], ['DELETE', `/api/party/admins/${uid(1)}`]]) {
    const res = await h.api(method, path, b.cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    const data = await res.json();
    assert.equal(data.error, 'owner_only');
    assert.match(data.message, /Only the owner/);
  }
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins').get().n, 0);
  assert.equal((await h.api('GET', '/api/party/admins')).status, 401);
  const a = await h.login(OWNER);
  const csrf = await h.api('POST', '/api/party/admins', a.cookie, { id: uid(1) }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).error, 'forbidden');
  const noHeader = await h.api('POST', '/api/party/admins', a.cookie, { id: uid(1) }, { 'X-YapOS': null });
  assert.equal(noHeader.status, 403);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins').get().n, 0);
});

test('the owner can add, list and remove party admins', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const empty = await (await h.api('GET', '/api/party/admins', cookie)).json();
  assert.deepEqual(empty.admins, []);
  assert.equal(empty.max, 50);
  assert.equal(empty.owner.id, OWNER.id);
  assert.equal(empty.owner.display_name, 'Alice');
  assert.equal(empty.owner.avatar, OWNER.avatar_url);

  const added = await h.api('POST', '/api/party/admins', cookie, { id: `  ${BOB.id.toUpperCase()}  ` });
  assert.equal(added.status, 200);
  const list = await added.json();
  assert.equal(list.added, true);
  assert.deepEqual(list.admins.map((a) => [a.id, a.display_name, a.added_by]), [[BOB.id, null, OWNER.id]]);
  assert.deepEqual(list.pending, [BOB.id]);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM profile_wanted WHERE id = ?').get(BOB.id).n, 1);

  h.db.raw.prepare('INSERT INTO profiles (id, username, display_name, avatar_url, missing, fetched) VALUES (?, ?, ?, ?, 0, ?)').run(BOB.id, 'bob', 'Bob', 'https://files.yapper.website/b.png', h.clock.t);
  const named = await (await h.api('GET', '/api/party/admins', cookie)).json();
  assert.deepEqual(named.admins.map((a) => [a.id, a.username, a.display_name, a.avatar]), [[BOB.id, 'bob', 'Bob', 'https://files.yapper.website/b.png']]);
  assert.deepEqual(named.pending, []);

  const twice = await (await h.api('POST', '/api/party/admins', cookie, { id: BOB.id })).json();
  assert.equal(twice.added, false);
  assert.equal(twice.admins.length, 1);

  const check = await (await admins(h, [BOB.id, uid(9)])).json();
  assert.deepEqual(check.admins, [BOB.id]);

  const gone = await h.api('DELETE', `/api/party/admins/${BOB.id}`, cookie);
  assert.equal(gone.status, 200);
  const after = await gone.json();
  assert.equal(after.removed, true);
  assert.deepEqual(after.admins, []);
  assert.equal((await (await h.api('DELETE', `/api/party/admins/${BOB.id}`, cookie)).json()).removed, false);
  assert.deepEqual((await (await admins(h, [BOB.id])).json()).admins, []);
});

test('the owner cannot add or remove themselves and bad ids are refused politely', async () => {
  const h = party();
  const { cookie } = await h.login(OWNER);
  const self = await h.api('POST', '/api/party/admins', cookie, { id: OWNER.id.toUpperCase() });
  assert.equal(self.status, 400);
  assert.match((await self.json()).message, /you're always an admin/);
  const removeSelf = await h.api('DELETE', `/api/party/admins/${OWNER.id}`, cookie);
  assert.equal(removeSelf.status, 400);
  assert.match((await removeSelf.json()).message, /can't be removed/);
  for (const id of ['', 'nope', 'abc-123', 42, null, `${uid(1)}x`, "x'; DROP TABLE party_admins; --"]) {
    const res = await h.api('POST', '/api/party/admins', cookie, { id });
    assert.equal(res.status, 400, JSON.stringify(id));
    assert.equal((await res.json()).error, 'bad_id');
  }
  assert.equal((await h.api('POST', '/api/party/admins', cookie, { id: uid(1), role: 'owner' })).status, 400);
  assert.equal((await h.api('DELETE', `/api/party/admins/${encodeURIComponent('bad id!')}`, cookie)).status, 400);
  assert.equal((await h.api('PATCH', '/api/party/admins', cookie, { id: uid(1) })).status, 405);
  assert.equal((await h.api('GET', '/api/party/nope', cookie)).status, 404);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_admins').get().n, 0);
  for (const sql of h.db.queries) assert.ok(!sql.includes('DROP'), sql);
});

test('the party admin list is capped at 50', async () => {
  const h = party();
  for (let i = 1; i <= 50; i++) addRow(h, uid(i), i);
  const { cookie } = await h.login(OWNER);
  const res = await h.api('POST', '/api/party/admins', cookie, { id: uid(51) });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /50 party admins/);
  const again = await h.api('POST', '/api/party/admins', cookie, { id: uid(7) });
  assert.equal(again.status, 200);
  const list = await (await h.api('GET', '/api/party/admins', cookie)).json();
  assert.equal(list.admins.length, 50);
  assert.equal(list.admins[0].id, uid(1));
});

test('/party opens the dashboard page', async () => {
  const h = party();
  assert.equal((await h.request('GET', '/party')).status, 200);
  assert.equal((await h.request('GET', '/party/x')).status, 404);
});

const { document } = installDom({ url: 'https://dash.example.test/party' });
document.documentElement = document.createElement('html');
const { state } = await import('../web/js/state.js');
const { renderParty, pickUserId, readAdmins } = await import('../web/js/pages/party.js');
const { createShell } = await import('../web/js/shell.js');
const { matchRoute } = await import('../web/js/router.js');
const { ApiError } = await import('../web/js/api.js');

const ME = { id: OWNER.id, username: 'alice', display_name: 'Alice', avatar_url: '' };

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const chrome = [];
  return { api, main, signal: ctrl.signal, params: {}, setChrome: (c) => chrome.push(c), chrome, abort: () => ctrl.abort() };
}

function listData(admins, extra = {}) {
  return { owner: { id: OWNER.id, username: 'alice', display_name: 'Alice', avatar: null }, admins, max: 50, pending: [], ...extra };
}

const buttons = (root, re) => root.querySelectorAll('button').filter((b) => re.test(b.textContent));

test('the party route is private and only the page id shape matches', () => {
  const r = matchRoute('/party');
  assert.equal(r.name, 'party');
  assert.equal(r.private, true);
  assert.equal(matchRoute('/party/x').name, 'not-found');
  assert.equal(pickUserId(`  <@${BOB.id.toUpperCase()}>  `), BOB.id);
  assert.equal(pickUserId('nope'), '');
  assert.deepEqual(readAdmins(null).admins, []);
});

test('someone who is not the owner sees a polite owner-only page and nothing is fetched', async () => {
  state.user = { ...ME, id: BOB.id };
  state.partyOwner = false;
  let calls = 0;
  const ctx = makeCtx({ get: async () => { calls++; return listData([]); } });
  renderParty(ctx);
  await flush();
  assert.equal(calls, 0);
  assert.match(ctx.main.textContent, /Only the owner can open this/);
  assert.equal(ctx.main.querySelector('input'), null);
  ctx.abort();
});

test('the owner sees themselves first and every admin with a name or raw id', async () => {
  state.user = ME;
  state.partyOwner = true;
  const ctx = makeCtx({
    get: async (path) => {
      assert.equal(path, '/api/party/admins');
      return listData([
        { id: BOB.id, username: 'bob', display_name: 'Bob', avatar: null },
        { id: uid(2), username: null, display_name: null, avatar: null },
      ]);
    },
  });
  renderParty(ctx);
  await flush();
  const rows = ctx.main.querySelectorAll('.party-row');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Alice/);
  assert.match(rows[0].textContent, /Owner/);
  assert.equal(buttons(rows[0], /Remove/).length, 0);
  assert.match(rows[1].textContent, /Bob/);
  assert.match(rows[1].textContent, /@bob/);
  assert.match(rows[2].textContent, new RegExp(uid(2)));
  assert.equal(buttons(rows[2], /Remove/).length, 1);
  assert.match(ctx.main.textContent, /2 of 50/);
  assert.match(ctx.main.textContent, /ADMIN panel/);
  assert.match(ctx.main.textContent, /Copy User ID/);
  assert.equal(ctx.chrome[0].section, 'party');
  ctx.abort();
});

test('adding checks the id first, then posts it and shows the new list', async () => {
  state.user = ME;
  state.partyOwner = true;
  const posts = [];
  const ctx = makeCtx({
    get: async () => listData([{ id: uid(2), username: 'juno', display_name: 'Juno', avatar: null }]),
    post: async (path, body) => {
      posts.push([path, body]);
      return listData([{ id: uid(2), username: 'juno', display_name: 'Juno', avatar: null }, { id: BOB.id, username: 'bob', display_name: 'Bob', avatar: null }], { added: true });
    },
  });
  renderParty(ctx);
  await flush();
  const form = ctx.main.querySelector('form');
  const input = form.querySelector('input');
  const error = form.querySelector('.field-error');
  fire(form, 'submit');
  assert.match(error.textContent, /Paste a user id/);
  type(input, 'not an id');
  fire(form, 'submit');
  assert.match(error.textContent, /doesn't look like/);
  type(input, OWNER.id);
  fire(form, 'submit');
  assert.match(error.textContent, /That's you/);
  type(input, uid(2));
  fire(form, 'submit');
  assert.match(error.textContent, /already a party admin/);
  assert.equal(posts.length, 0);
  type(input, ` ${BOB.id.toUpperCase()} `);
  fire(form, 'submit');
  await flush();
  assert.deepEqual(posts, [['/api/party/admins', { id: BOB.id }]]);
  assert.equal(input.value, '');
  assert.equal(error.textContent, '');
  assert.equal(ctx.main.querySelectorAll('.party-row').length, 3);
  ctx.abort();
});

test('a refused add shows the reason under the box', async () => {
  state.user = ME;
  state.partyOwner = true;
  const ctx = makeCtx({
    get: async () => listData([]),
    post: async () => { throw new ApiError('You already have 50 party admins. Remove someone first.', { status: 409 }); },
  });
  renderParty(ctx);
  await flush();
  const form = ctx.main.querySelector('form');
  type(form.querySelector('input'), uid(4));
  fire(form, 'submit');
  await flush();
  assert.match(form.querySelector('.field-error').textContent, /50 party admins/);
  ctx.abort();
});

test('removing asks first and then deletes', async () => {
  state.user = ME;
  state.partyOwner = true;
  const deletes = [];
  const ctx = makeCtx({
    get: async () => listData([{ id: BOB.id, username: 'bob', display_name: 'Bob', avatar: null }]),
    request: async (method, path) => {
      deletes.push([method, path]);
      return listData([], { removed: true });
    },
  });
  renderParty(ctx);
  await flush();
  buttons(ctx.main.querySelectorAll('.party-row')[1], /Remove/)[0].click();
  await flush();
  let dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Remove Bob\?/);
  buttons(dialog, /^Cancel$/)[0].click();
  await flush();
  assert.equal(deletes.length, 0);
  buttons(ctx.main.querySelectorAll('.party-row')[1], /Remove/)[0].click();
  await flush();
  dialog = document.body.querySelector('.dialog-panel');
  buttons(dialog, /^Remove$/)[0].click();
  await flush();
  assert.deepEqual(deletes, [['DELETE', `/api/party/admins/${BOB.id}`]]);
  assert.equal(ctx.main.querySelectorAll('.party-row').length, 1);
  assert.match(ctx.main.textContent, /No extra admins yet/);
  ctx.abort();
});

test('if the server says no, the page falls back to the owner-only view', async () => {
  state.user = ME;
  state.partyOwner = true;
  const ctx = makeCtx({ get: async () => { throw new ApiError('Only the owner of YapOS Party can manage party admins.', { status: 403 }); } });
  renderParty(ctx);
  await flush();
  assert.match(ctx.main.textContent, /Only the owner can open this/);
  assert.equal(state.partyOwner, false);
  ctx.abort();
});

test('the Party admins link shows in the account area only for the owner', () => {
  for (const variant of ['plain', 'server']) {
    const shell = createShell({ onLogout() {} });
    const server = variant === 'server' ? { id: 'srv', name: 'Test Town' } : null;
    shell.update({ variant: variant === 'plain' ? 'plain' : undefined, server, user: ME, partyOwner: false });
    assert.equal(shell.root.querySelectorAll('a').filter((a) => a.href === '/party').length, 0, variant);
    shell.update({ variant: variant === 'plain' ? 'plain' : undefined, server, user: ME, partyOwner: true, section: 'party' });
    const links = shell.root.querySelectorAll('a').filter((a) => a.href === '/party');
    assert.ok(links.length >= 1, variant);
    assert.equal(links[0].getAttribute('aria-label'), 'Party admins');
  }
});
