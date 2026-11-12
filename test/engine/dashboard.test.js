import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { createLogger } from '../../engine/log.js';

const SECRET = 'test-secret-value-for-the-dashboard';
const S = IDS.server;
const R = IDS.roles;
const C = IDS.channels;
const OTHER = '5e000000-0000-4000-8000-0000000000aa';

function fakeWorker() {
  const w = { queue: [], results: [], snapshots: {}, publics: {}, slugs: new Map(), requests: [], hot: false, fail: 0, failWith: null, inFlight: 0, maxInFlight: 0, resultPosts: [], resultsStatus: [] };
  let seq = 0;
  w.add = (type, user, data = {}, server = S) => {
    const id = `job-${++seq}`;
    w.queue.push({ id, type, user_id: user, server_id: type === 'servers' ? null : server, data, created: Date.now() });
    return id;
  };
  w.result = (id) => w.results.find((r) => r.id === id) || null;
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    w.inFlight++;
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
    try {
      await new Promise((r) => setImmediate(r));
      const u = new URL(url);
      w.requests.push({ method: init.method, path: u.pathname, auth: init.headers?.authorization, signal: !!init.signal });
      if (w.fail > 0) { w.fail--; throw w.failWith || new Error('network down'); }
      if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (init.method === 'GET' && u.pathname === '/bot/poll') return reply(200, { jobs: w.queue.splice(0, 25), hot: w.hot });
      if (init.method === 'POST' && u.pathname === '/bot/results') {
        w.resultPosts.push({ bytes: Buffer.byteLength(init.body), ids: body.results.map((r) => r.id) });
        if (w.resultsStatus.length) return reply(w.resultsStatus.shift(), { error: 'refused' });
        if (Buffer.byteLength(init.body) > 2 * 1024 * 1024) return reply(413, { error: 'too_large' });
        w.results.push(...body.results);
        return reply(200, { ok: true });
      }
      let m = /^\/bot\/snapshot\/([^/]+)$/.exec(u.pathname);
      if (m && init.method === 'PUT') { w.snapshots[decodeURIComponent(m[1])] = body; return reply(200, { ok: true }); }
      m = /^\/bot\/public\/([^/]+)$/.exec(u.pathname);
      if (m && init.method === 'PUT') {
        const sid = decodeURIComponent(m[1]);
        const owner = w.slugs.get(body.slug);
        if (owner && owner !== sid) return reply(409, { error: 'taken' });
        for (const [slug, s] of [...w.slugs]) if (s === sid) w.slugs.delete(slug);
        w.slugs.set(body.slug, sid);
        w.publics[sid] = body;
        return reply(200, { ok: true });
      }
      if (m && init.method === 'DELETE') {
        const sid = decodeURIComponent(m[1]);
        delete w.publics[sid];
        for (const [slug, s] of [...w.slugs]) if (s === sid) w.slugs.delete(slug);
        return reply(200, { ok: true });
      }
      return reply(404, { error: 'no route' });
    } finally {
      w.inFlight--;
    }
  };
  return w;
}

async function setup(opts = {}) {
  const h = await createHarness(opts.harness || {});
  const w = fakeWorker();
  const timers = [];
  const cleared = [];
  const lines = [];
  const log = opts.captureLog ? createLogger({ level: 'debug', sink: (lvl, line) => lines.push(line) }) : h.engine.log;
  const dash = createDashboard({
    engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now, log,
    setTimeout: (fn, ms) => { const t = { fn, ms, unrefd: false, unref() { t.unrefd = true; return t; } }; timers.push(t); return t; },
    clearTimeout: (t) => cleared.push(t),
  });
  h.engine.dashboard = dash;
  const run = async (type, user, data = {}, server = S) => {
    const id = w.add(type, user, data, server);
    await dash.tick();
    await h.settle();
    return w.result(id);
  };
  const change = (user, app, body) => run('change', user, { app, ...body });
  return { h, w, dash, run, change, timers, cleared, lines };
}

test('the dashboard client stays off when it is not configured', async () => {
  const h = await createHarness({ apps: ['mod'] });
  assert.equal(h.engine.dashboard.enabled, false);
  const lines = [];
  const log = createLogger({ level: 'info', sink: (lvl, line) => lines.push(line) });
  let called = 0;
  const off = createDashboard({ engine: h.engine, url: '', secret: '', fetch: async () => { called++; return null; }, log });
  assert.equal(off.enabled, false);
  assert.equal(off.start(), false);
  assert.equal(await off.tick(), null);
  assert.equal(called, 0);
  assert.equal(lines.filter((l) => /dashboard/.test(l)).length, 1);
  const plain = createDashboard({ engine: h.engine, url: 'http://dash.example.test', secret: SECRET, fetch: async () => null, log });
  assert.equal(plain.enabled, false);
  const local = createDashboard({ engine: h.engine, url: 'http://localhost:8787', secret: SECRET, fetch: async () => null, log });
  assert.equal(local.enabled, true);
  const noSecret = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: '', fetch: async () => null, log });
  assert.equal(noSecret.enabled, false);
});

test('every request carries the bot secret and a timeout', async () => {
  const { w, run } = await setup({ harness: { apps: ['mod'] } });
  await run('access', IDS.admin);
  assert.ok(w.requests.length >= 3);
  for (const r of w.requests) {
    assert.equal(r.auth, `Bearer ${SECRET}`);
    assert.equal(r.signal, true);
  }
});

test('the servers job lists only servers where the user is an admin, and the bot owner only where they are a member', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  const st = h.fake.state;
  st.servers[OTHER] = { id: OTHER, name: 'Elsewhere', icon_path: null, owner_id: IDS.member2, member_count: 1 };
  st.roles[OTHER] = [];
  st.members[OTHER] = [{ id: IDS.member2, username: 'riley', display_name: 'Riley', roles: [] }];
  st.channels[OTHER] = [];

  const admin = await run('servers', IDS.admin);
  assert.equal(admin.ok, true);
  assert.deepEqual(admin.result.servers.map((s) => [s.id, s.level]), [[S, 'admin']]);
  assert.equal(admin.result.servers[0].name, 'Test Town');

  const owner = await run('servers', IDS.owner);
  assert.deepEqual(owner.result.servers.map((s) => [s.id, s.level]), [[S, 'owner']]);

  const member = await run('servers', IDS.member);
  assert.deepEqual(member.result.servers, []);

  const mod = await run('servers', IDS.mod);
  assert.deepEqual(mod.result.servers, []);
});

test('the access job grants admins, pushes a snapshot, and refuses members', async () => {
  const { w, run } = await setup({ harness: { apps: ['mod'] } });
  const yes = await run('access', IDS.admin);
  assert.deepEqual(yes.result, { grant: true, level: 'admin' });
  assert.ok(w.snapshots[S], 'a snapshot was pushed');
  const no = await run('access', IDS.member);
  assert.equal(no.result.grant, false);
  const mod = await run('access', IDS.mod);
  assert.equal(mod.result.grant, false);
});

test('bad jobs are answered with errors instead of crashing', async () => {
  const { w, dash, h } = await setup({ harness: { apps: ['mod'] } });
  w.queue.push({ id: 'j-bad-type', type: 'explode', user_id: IDS.admin, server_id: S, data: {} });
  w.queue.push({ id: 'j-no-user', type: 'access', user_id: '../../etc', server_id: S, data: {} });
  w.queue.push({ id: 'j-no-server', type: 'access', user_id: IDS.admin, server_id: null, data: {} });
  w.queue.push({ id: 'j-bad-data', type: 'change', user_id: IDS.admin, server_id: S, data: '{not json' });
  w.queue.push({ id: 'j-string-data', type: 'change', user_id: IDS.admin, server_id: S, data: JSON.stringify({ app: 'mod', settings: { dmOnAction: false } }) });
  await dash.tick();
  await h.settle();
  for (const id of ['j-bad-type', 'j-no-user', 'j-no-server', 'j-bad-data']) assert.equal(w.result(id).ok, false, id);
  assert.equal(w.result('j-string-data').ok, true);
  assert.deepEqual(w.result('j-string-data').result.applied, { dmOnAction: false });
});

async function typedThenWeb(apps, typed, web, appId) {
  const a = await createHarness({ apps });
  await a.slash(typed[0], typed[1], { user: IDS.admin });
  const viaCommand = a.engine.settings.appConfig(S, appId);
  const { h, change } = await setup({ harness: { apps } });
  const r = await change(IDS.admin, appId, { settings: web });
  assert.deepEqual(r.result.errors, {});
  const viaWeb = h.engine.settings.appConfig(S, appId);
  assert.deepEqual(viaWeb, viaCommand);
  return r;
}

test('a change saves valid settings exactly like the typed command does', async () => {
  await typedThenWeb(['levels'], ['levels', 'rate 1.5'], { rate: 1.5 }, 'levels');
  await typedThenWeb(['levels'], ['levels', 'cooldown 90'], { cooldownSeconds: '90' }, 'levels');
  await typedThenWeb(['levels'], ['levels', 'message GG {user}, level {level}!'], { message: 'GG {user}, level {level}!' }, 'levels');
  await typedThenWeb(['starboard'], ['starboard', '7'], { threshold: 7 }, 'starboard');
  await typedThenWeb(['starboard'], ['starboard', 'emoji 🌟'], { emoji: '🌟' }, 'starboard');
  await typedThenWeb(['welcome'], ['welcome', 'text Hi {user}, glad you are here!'], { joinText: 'Hi {user}, glad you are here!' }, 'welcome');
  await typedThenWeb(['welcome'], ['welcome', 'image https://i.imgur.com/abc.png'], { imageUrl: 'https://i.imgur.com/abc.png' }, 'welcome');
  await typedThenWeb(['automod'], ['automod', 'strictness high'], { strictness: 'high' }, 'automod');
  await typedThenWeb(['automod'], ['automod', 'links on'], { filters: { links: true } }, 'automod');
  await typedThenWeb(['automod'], ['automod', 'links allow https://www.Example.com/page'], { 'links.allow': ['https://www.Example.com/page'] }, 'automod');
  await typedThenWeb(['automod'], ['automod', 'action links timeout'], { actions: { links: 'timeout' } }, 'automod');
  await typedThenWeb(['automod'], ['automod', 'words add b4dword'], { 'words.list': ['b4dword'] }, 'automod');
  await typedThenWeb(['economy'], ['economy', 'work 90 30'], { workMin: 90, workMax: 30 }, 'economy');
  await typedThenWeb(['economy'], ['economy', 'daily 1.5k'], { dailyAmount: '1.5k' }, 'economy');
  await typedThenWeb(['games'], ['game', 'maxbet 500'], { maxBet: 500 }, 'games');
  await typedThenWeb(['tickets'], ['tickets', 'limit 3'], { limit: 3 }, 'tickets');
  await typedThenWeb(['voice'], ['voice', 'limit 12'], { maxRooms: 12 }, 'voice');
  await typedThenWeb(['mod'], ['mod', 'log #mod-log'], { 'core.logChannel': C.modlog }, 'mod');
});

test('a change refuses invalid values with the same message the command gives', async () => {
  const a = await createHarness({ apps: ['levels', 'starboard', 'welcome'] });
  const typedRate = a.textOf((await a.slash('levels', 'rate 9', { user: IDS.admin }))[0]);
  const typedStars = a.textOf((await a.slash('starboard', 'stars 500', { user: IDS.admin }))[0]);
  const typedText = a.textOf((await a.slash('welcome', 'text Hi {usr}', { user: IDS.admin }))[0]);

  const { h, change } = await setup({ harness: { apps: ['levels', 'starboard', 'welcome'] } });
  const before = h.engine.settings.appConfig(S, 'levels');
  const lv = await change(IDS.admin, 'levels', { settings: { rate: 9, cooldownSeconds: 1.5 } });
  assert.equal(lv.result.errors.rate, 'Use a number from 0 to 5.');
  assert.ok(typedRate.includes(lv.result.errors.rate));
  assert.equal(lv.result.errors.cooldownSeconds, 'Use a whole number from 0 to 3600.');
  assert.deepEqual(h.engine.settings.appConfig(S, 'levels'), before);

  const sb = await change(IDS.admin, 'starboard', { settings: { threshold: 500 } });
  assert.ok(typedStars.includes(sb.result.errors.threshold.split('\n')[0]));

  const wl = await change(IDS.admin, 'welcome', { settings: { joinText: 'Hi {usr}' } });
  assert.ok(wl.result.errors.joinText.startsWith('{usr} isn\'t a placeholder I know.'));
  assert.ok(typedText.includes('{usr} isn\'t a placeholder I know.'));
});

test('a change reports unknown settings, read-only settings and oversized values per key', async () => {
  const { h, change } = await setup({ harness: { apps: ['welcome', 'mod', 'tickets'] } });
  const r = await change(IDS.admin, 'welcome', { settings: { nope: 1, joinText: 'x'.repeat(5000), leave: true } });
  assert.equal(r.result.errors.nope, "That setting doesn't exist.");
  assert.equal(r.result.errors.joinText, 'That value is too long.');
  assert.deepEqual(r.result.applied, { leave: true });
  assert.equal(h.engine.settings.appConfig(S, 'welcome').leave, true);
  const ro = await change(IDS.admin, 'mod', { settings: { 'core.modRoles': [R.gamer] } });
  assert.match(ro.result.errors['core.modRoles'], /\/mod modrole add/);
  assert.deepEqual(h.engine.settings.core(S).modRoles, []);
  const types = await change(IDS.admin, 'tickets', { settings: { types: [] } });
  assert.match(types.result.errors.types, /\/tickets types/);
  const app = await change(IDS.admin, 'not-an-app', { settings: { x: 1 } });
  assert.equal(app.result.errors.app, "That app doesn't exist.");
  const shape = await change(IDS.admin, 'welcome', { settings: ['join'] });
  assert.ok(shape.result.errors.settings);
});

test('a change is refused for members and for an admin who lost the role', async () => {
  const { h, change } = await setup({ harness: { apps: ['levels'] } });
  const member = await change(IDS.member, 'levels', { settings: { rate: 2 } });
  assert.equal(member.result.grant, false);
  assert.equal(member.error, 'You need to be an admin of this server.');
  assert.equal(h.engine.settings.appConfig(S, 'levels').rate, 1);

  const ok = await change(IDS.admin, 'levels', { settings: { rate: 2 } });
  assert.equal(ok.result.grant, true);
  assert.equal(h.engine.settings.appConfig(S, 'levels').rate, 2);

  const alex = h.fake.memberOf(S, IDS.admin);
  alex.roles = [R.member];
  const demoted = await change(IDS.admin, 'levels', { settings: { rate: 3 } });
  assert.equal(demoted.result.grant, false);
  assert.equal(h.engine.settings.appConfig(S, 'levels').rate, 2);
});

test('installing and uninstalling an app goes through setEnabled so its hooks run', async () => {
  const { h, change } = await setup({ harness: { apps: ['mod', 'games', 'levels'] } });
  const toggles = [];
  const stop = h.engine.settings.onToggle((sid, app, on) => toggles.push([app, on]));
  const off = await change(IDS.admin, 'games', { enabled: false });
  assert.deepEqual(off.result.applied, { enabled: false });
  assert.equal(h.engine.settings.isEnabled(S, 'games'), false);
  const refused = await change(IDS.admin, 'games', { settings: { maxBet: 50 } });
  assert.match(refused.result.errors.maxBet, /isn't installed here/);
  const on = await change(IDS.admin, 'games', { enabled: true, settings: { maxBet: 50 } });
  assert.deepEqual(on.result.applied, { enabled: true, maxBet: 50 });
  assert.equal(h.engine.settings.isEnabled(S, 'games'), true);
  assert.deepEqual(toggles, [['games', false], ['games', true]]);
  const snapApp = on.result.snapshot.apps.find((a) => a.id === 'games');
  assert.equal(snapApp.enabled, true);
  stop();
});

test('system apps cannot be uninstalled from the dashboard', async () => {
  const { h, change } = await setup({ harness: { apps: ['mod'] } });
  const r = await change(IDS.admin, 'system', { enabled: false });
  assert.equal(r.result.errors.enabled, 'System apps are always on.');
  assert.equal(h.engine.settings.isEnabled(S, 'system'), true);
  const bad = await change(IDS.admin, 'mod', { enabled: 'nope' });
  assert.ok(bad.result.errors.enabled);
});

test('role fields apply the same checks as the commands', async () => {
  const { h, change } = await setup({ harness: { apps: ['welcome', 'levels', 'tickets'] } });
  const above = await change(IDS.admin, 'welcome', { settings: { autoroles: [R.admin] } });
  assert.match(above.result.errors.autoroles, /My role must be above \*\*Admin\*\*/);
  assert.deepEqual(h.engine.settings.appConfig(S, 'welcome').autoroles, []);
  const ok = await change(IDS.admin, 'welcome', { settings: { autoroles: [R.gamer] } });
  assert.deepEqual(ok.result.applied, { autoroles: [R.gamer] });
  const tooMany = await change(IDS.admin, 'welcome', { settings: { autoroles: [R.gamer, R.vip, R.member, R.mod, R.bot, R.top] } });
  assert.match(tooMany.result.errors.autoroles, /up to 5 starter roles/);
  const ghost = await change(IDS.admin, 'welcome', { settings: { autoroles: ['r0000000-0000-4000-8000-0000000000ff'] } });
  assert.ok(ghost.result.errors.autoroles);

  const staff = await change(IDS.admin, 'levels', { settings: { rewards: { 5: R.mod } } });
  assert.match(staff.result.errors.rewards, /staff permissions/);
  const reward = await change(IDS.admin, 'levels', { settings: { rewards: { 5: R.gamer } } });
  assert.deepEqual(h.engine.settings.appConfig(S, 'levels').rewards, { 5: R.gamer });
  assert.deepEqual(reward.result.errors, {});

  const typeStaff = await change(IDS.admin, 'tickets', { settings: { typeStaff: { support: [R.vip] } } });
  assert.deepEqual(typeStaff.result.errors, {});
  assert.deepEqual(h.engine.settings.appConfig(S, 'tickets').types[0].staffRoles, [R.vip]);
  const everyone = await change(IDS.admin, 'tickets', { settings: { typeStaff: { support: [S] } } });
  assert.ok(everyone.result.errors.typeStaff);
});

test('channel fields need a channel of the right kind in this server', async () => {
  const { h, change } = await setup({ harness: { apps: ['starboard', 'levels'] } });
  const voice = await change(IDS.admin, 'starboard', { settings: { channelId: C.voice } });
  assert.ok(voice.result.errors.channelId);
  const missing = await change(IDS.admin, 'starboard', { settings: { channelId: 'c0000000-0000-4000-8000-0000000000ff' } });
  assert.ok(missing.result.errors.channelId);
  const ok = await change(IDS.admin, 'starboard', { settings: { channelId: C.general } });
  assert.deepEqual(ok.result.applied, { channelId: C.general });
  const off = await change(IDS.admin, 'starboard', { settings: { channelId: null } });
  assert.deepEqual(off.result.applied, { channelId: null });
  assert.equal(h.engine.settings.appConfig(S, 'starboard').channelId, null);
  const needs = await change(IDS.admin, 'levels', { settings: { announce: 'channel' } });
  assert.ok(needs.result.errors.announce);
  const both = await change(IDS.admin, 'levels', { settings: { channelId: C.news, announce: 'channel' } });
  assert.deepEqual(both.result.errors, {});
  assert.equal(h.engine.settings.appConfig(S, 'levels').announce, 'channel');
});

test('the snapshot has the overview, apps, settings with schema and lookups, and cases', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod', 'levels', 'welcome', 'automod'] } });
  await run('access', IDS.admin);
  const snap = w.snapshots[S];
  assert.deepEqual(Object.keys(snap).sort(), ['apps', 'cases', 'overview', 'settings', 'updatedAt']);
  const o = snap.overview;
  assert.equal(o.id, S);
  assert.equal(o.name, 'Test Town');
  assert.equal(typeof o.member_count, 'number');
  assert.deepEqual(Object.keys(o.bot).sort(), ['gateway', 'latencyMs', 'uptimeSec', 'verified', 'version']);
  assert.deepEqual(o.apps, { enabled: 5, total: 5 });
  assert.ok(Array.isArray(o.recent));
  assert.deepEqual(Object.keys(o.counts).sort(), ['cases', 'openTickets', 'starboardPosts']);
  const sys = snap.apps.find((a) => a.id === 'system');
  assert.equal(sys.canDisable, false);
  const lv = snap.apps.find((a) => a.id === 'levels');
  assert.deepEqual(Object.keys(lv).sort(), ['canDisable', 'category', 'description', 'enabled', 'icon', 'id', 'name', 'settingsCount']);
  assert.ok(lv.settingsCount > 5);
  const rate = snap.settings.levels.schema.find((f) => f.key === 'rate');
  assert.deepEqual(rate, { key: 'rate', label: 'XP rate', help: rate.help, type: 'number', default: 1, min: 0, max: 5, step: 0.1, web: true });
  assert.equal(snap.settings.levels.values.rate, 1);
  const modRoles = snap.settings.mod.schema.find((f) => f.key === 'core.modRoles');
  assert.equal(modRoles.web, false);
  assert.ok(modRoles.note);
  for (const app of Object.keys(snap.settings).filter((k) => k !== 'lookups')) {
    for (const f of snap.settings[app].schema) {
      assert.equal(typeof f.validate, 'undefined');
      assert.ok(f.web === true || f.note, `${app}.${f.key} needs a note`);
      assert.ok(Object.hasOwn(snap.settings[app].values, f.key), `${app}.${f.key} has a value`);
    }
  }
  const { channels, roles } = snap.settings.lookups;
  assert.ok(channels.some((c) => c.id === C.voice && c.kind === 'voice'));
  assert.equal(roles.find((r) => r.id === R.gamer).manageable, true);
  assert.equal(roles.find((r) => r.id === R.admin).manageable, false);
  assert.deepEqual(snap.cases, []);
  assert.equal(h.engine.dashboard.enabled, true);
});

test('cases come newest first, capped at 2000', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod'] } });
  const mod = h.engine.service('mod');
  await mod.addCase(S, { action: 'warn', targetId: IDS.member, actorId: IDS.mod, reason: 'first' });
  await mod.addCase(S, { action: 'timeout', targetId: IDS.member, actorId: IDS.mod, reason: 'second', durationMs: 600000 });
  await mod.addCase(S, { action: 'kick', targetId: IDS.member2, actorId: IDS.admin, reason: 'third' });
  await run('access', IDS.admin);
  const cases = w.snapshots[S].cases;
  assert.deepEqual(cases.map((c) => c.n), [3, 2, 1]);
  assert.deepEqual(Object.keys(cases[0]).sort(), ['at', 'mod', 'n', 'reason', 'type', 'user']);
  assert.equal(cases[0].type, 'kick');
  assert.equal(cases[1].duration, 600000);
  assert.equal(typeof cases[1].active, 'boolean');
  assert.equal(w.snapshots[S].overview.recent[0].n, 3);

  const many = Array.from({ length: 2050 }, (_, i) => ({ id: i + 1, action: 'warn', targetId: IDS.member, targetName: '@sam', actorId: IDS.mod, actorName: '@mo', reason: `r${i + 1}`, at: 1000 + i, source: 'mod' }));
  h.engine.store.set('mod', S, { seq: 2050, cases: many, warns: [], locks: {}, noteSeq: 0, notes: [] });
  await run('access', IDS.admin);
  const capped = w.snapshots[S].cases;
  assert.equal(capped.length, 2000);
  assert.equal(capped[0].n, 2050);

  const member = await run('member', IDS.admin, { user_id: IDS.member });
  assert.equal(member.result.grant, true);
  assert.equal(member.result.member.id, IDS.member);
  assert.equal(member.result.member.cases.length, 50);
  const refused = await run('member', IDS.member, { user_id: IDS.member2 });
  assert.equal(refused.result.grant, false);
});

test('the public page is off by default and publishes levels and coins once turned on', async () => {
  const { h, w, run, change } = await setup({ harness: { apps: ['levels', 'economy', 'wrapped'] } });
  await run('access', IDS.admin);
  assert.deepEqual(w.publics, {});
  assert.ok(!w.requests.some((r) => r.path.startsWith('/bot/public')));
  assert.deepEqual(w.snapshots[S].settings.system.values.publicPage, { enabled: false, slug: null });

  await h.engine.service('levels').addXp(S, IDS.member, 500, 'test');
  await h.engine.service('levels').addXp(S, IDS.member2, 900, 'test');
  h.engine.service('economy').add(S, IDS.member, 250, 'test');

  const shortSlug = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true, slug: 'ab' } } });
  assert.match(shortSlug.result.errors.publicPage, /3 to 32 lowercase/);
  const badSlug = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true, slug: 'Test Town!' } } });
  assert.ok(badSlug.result.errors.publicPage);
  const noSlug = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true } } });
  assert.ok(noSlug.result.errors.publicPage);
  assert.deepEqual(w.publics, {});

  const on = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true, slug: 'test-town' } } });
  assert.deepEqual(on.result.errors, {});
  const page = w.publics[S];
  assert.equal(page.enabled, true);
  assert.equal(page.slug, 'test-town');
  assert.equal(page.name, 'Test Town');
  assert.deepEqual(page.levels.map((u) => [u.rank, u.id]), [[1, IDS.member2], [2, IDS.member]]);
  assert.equal(page.levels[0].name, 'Riley');
  assert.equal(page.economy[0].id, IDS.member);
  assert.equal(page.economy[0].balance, 250);
  assert.equal(page.economy[0].name, 'Sam');
  assert.ok(page.wrapped && page.wrapped.card && page.wrapped.month);
  assert.deepEqual(h.engine.settings.core(S).publicPage, { enabled: true, slug: 'test-town' });

  w.slugs.set('taken-name', OTHER);
  const taken = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true, slug: 'taken-name' } } });
  assert.match(taken.result.errors.publicPage, /taken/);
  assert.deepEqual(h.engine.settings.core(S).publicPage, { enabled: true, slug: 'test-town' });

  const off = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: false } } });
  assert.deepEqual(off.result.errors, {});
  assert.equal(w.publics[S], undefined);
  assert.deepEqual(h.engine.settings.core(S).publicPage, { enabled: false, slug: 'test-town' });
});

test('a dashboard change posts one line in the mod log', async () => {
  const { h, change } = await setup({ harness: { apps: ['mod', 'welcome'] } });
  h.engine.settings.patchCore(S, { logChannel: C.modlog });
  await change(IDS.admin, 'welcome', { settings: { join: false, leave: true, nope: 1 } });
  await h.settle();
  const lines = h.sent(C.modlog).map((m) => m.content);
  assert.deepEqual(lines, ['⚙️ Alex changed Welcome: Join messages, Leave messages on the dashboard']);
  await change(IDS.admin, 'welcome', { settings: { nope: 1 } });
  await h.settle();
  assert.equal(h.sent(C.modlog).length, 1);
});

test('polling waits 15 s when idle, 2 s when hot, backs off to 60 s on errors, and keeps one request in flight', async () => {
  const { dash, w, timers, cleared } = await setup({ harness: { apps: ['mod'], fakeClock: true } });
  assert.equal(dash.start(), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefd, true);
  assert.equal(await dash.tick(), 15000);
  w.hot = true;
  assert.equal(await dash.tick(), 2000);
  w.hot = false;
  w.fail = 6;
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await dash.tick());
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(await dash.tick(), 15000);

  w.maxInFlight = 0;
  w.queue.length = 0;
  const before = w.requests.length;
  const [a, b] = await Promise.all([dash.tick(), dash.tick()]);
  assert.equal(a, 15000);
  assert.equal(b, 15000);
  assert.equal(w.requests.length - before, 1);
  assert.equal(w.maxInFlight, 1);

  await timers[0].fn();
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 15000);
  dash.stop();
  assert.equal(cleared.at(-1), timers[1]);
  assert.equal(dash.running, false);
  await timers[1].fn();
  assert.equal(timers.length, 2);
});

test('snapshots refresh every 10 minutes for servers used in the last hour', async () => {
  const { h, w, run, dash } = await setup({ harness: { apps: ['mod'], fakeClock: true } });
  await run('access', IDS.admin);
  const count = () => w.requests.filter((r) => r.path === `/bot/snapshot/${S}`).length;
  assert.equal(count(), 1);
  await dash.tick();
  assert.equal(count(), 1);
  h.clock.t += 10 * 60_000;
  await dash.tick();
  assert.equal(count(), 2);
  h.clock.t += 9 * 60_000;
  await dash.tick();
  assert.equal(count(), 2);
  h.clock.t += 2 * 60_000;
  await dash.tick();
  assert.equal(count(), 3);
  h.clock.t += 61 * 60_000;
  await dash.tick();
  h.clock.t += 10 * 60_000;
  await dash.tick();
  assert.equal(count(), 3);
});

test('an enabled public page is republished every 15 minutes', async () => {
  const { h, w, dash } = await setup({ harness: { apps: ['levels'], fakeClock: true } });
  const count = () => w.requests.filter((r) => r.method === 'PUT' && r.path === `/bot/public/${S}`).length;
  await dash.tick();
  assert.equal(count(), 0);
  h.engine.settings.patchCore(S, { publicPage: { enabled: true, slug: 'test-town' } });
  await dash.tick();
  assert.equal(count(), 1);
  h.clock.t += 14 * 60_000;
  await dash.tick();
  assert.equal(count(), 1);
  h.clock.t += 60_000;
  await dash.tick();
  assert.equal(count(), 2);
  h.engine.settings.patchCore(S, { publicPage: { enabled: false, slug: 'test-town' } });
  h.clock.t += 15 * 60_000;
  await dash.tick();
  assert.equal(count(), 2);
});

test('the bot secret never shows up in the logs', async () => {
  const { w, dash, lines, h } = await setup({ harness: { apps: ['mod'] }, captureLog: true });
  w.fail = 2;
  w.failWith = new Error(`connection refused for Bearer ${SECRET}`);
  await dash.tick();
  await dash.tick();
  await dash.tick();
  h.engine.log.warn(`oops ${SECRET}`);
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => /couldn't reach the dashboard/.test(l)));
  for (const l of [...lines, ...h.lines]) assert.ok(!l.includes(SECRET), l);
});

function countCalls(h) {
  const calls = { roles: 0, server: 0 };
  const bot = h.engine.bot;
  const roles = bot.roles.bind(bot);
  const server = bot.server.bind(bot);
  bot.roles = async (...a) => { calls.roles++; return roles(...a); };
  bot.server = async (...a) => { calls.server++; return server(...a); };
  return calls;
}

test('the level check refreshes only the member, and short server ids never reach the cache', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  await run('access', IDS.admin);
  const calls = countCalls(h);
  for (const sid of ['5', '5e', 'a', S.slice(0, 35)]) {
    const r = await run('access', IDS.admin, {}, sid);
    assert.equal(r.ok, false, sid);
    assert.equal(r.result, undefined, sid);
  }
  await run('access', IDS.admin);
  await run('change', IDS.admin, { app: 'mod', settings: { dmOnAction: false } });
  assert.deepEqual(calls, { roles: 0, server: 0 });
  assert.equal(typeof h.engine.perms.invalidateKey, 'function');
});

test('a failed role lookup answers try again and leaves the grant alone', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod'] } });
  const bot = h.engine.bot;
  const member = bot.member.bind(bot);
  let failNext = 0;
  bot.member = async (...a) => {
    if (failNext > 0) { failNext--; throw Object.assign(new Error('rate limited'), { status: 429 }); }
    return member(...a);
  };
  for (const [type, data] of [['access', {}], ['change', { app: 'mod', settings: { dmOnAction: false } }], ['member', { user_id: IDS.member }]]) {
    failNext = 1;
    const r = await run(type, IDS.admin, data);
    assert.equal(r.ok, false, type);
    assert.ok(!('result' in r), type);
    assert.match(r.error, /Try again in a minute/, type);
  }
  assert.equal(h.engine.settings.appConfig(S, 'mod').dmOnAction, true);
  const missing = await run('access', IDS.outsider || '0f000000-0000-4000-8000-000000000099');
  assert.equal(missing.ok, true);
  assert.equal(missing.result.grant, false);
  const ok = await run('access', IDS.admin);
  assert.deepEqual(ok.result, { grant: true, level: 'admin' });
  assert.ok(w.results.length >= 5);
});

test('a slow mod log line never holds up the job loop', async () => {
  const { h, w, dash } = await setup({ harness: { apps: ['mod', 'welcome'] } });
  h.engine.settings.patchCore(S, { logChannel: C.modlog });
  let sends = 0;
  h.engine.budget.send = () => { sends++; return new Promise(() => {}); };
  const a = w.add('change', IDS.admin, { app: 'welcome', settings: { join: false } });
  const b = w.add('access', IDS.admin);
  const outcome = await Promise.race([dash.tick().then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 3000))]);
  assert.equal(outcome, 'done');
  assert.equal(sends, 1);
  assert.equal(w.result(a).ok, true);
  assert.deepEqual(w.result(a).result.applied, { join: false });
  assert.equal(w.result(b).result.grant, true);
});

test('results go out in size-bounded batches, and a refused batch is dropped instead of retried forever', async () => {
  const { h, w, dash } = await setup({ harness: { apps: ['mod'] } });
  const st = h.fake.state;
  for (let i = 0; i < 1400; i++) {
    st.channels[S].push({ id: `c1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `room-${i}-${'x'.repeat(200)}`, type: 'text', kind: 'text', server_id: S, position: 100 + i, category: null, category_id: null, private: false, read_only: false, slowmode: 0 });
  }
  h.engine.cache.invalidate(S);
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(w.add('change', IDS.admin, { app: 'mod', settings: { dmOnAction: i % 2 === 0 } }));
  w.resultsStatus.push(503);
  assert.equal(await dash.tick(), 5000);
  assert.equal(w.results.length, 0);
  assert.equal(await dash.tick(), 15000);
  for (const id of ids) assert.equal(w.result(id)?.ok, true, id);
  assert.ok(w.resultPosts.length >= 3);
  for (const p of w.resultPosts) assert.ok(p.bytes <= 1_600_000, `a results post was ${p.bytes} bytes`);
  for (const id of ids) assert.ok(Buffer.byteLength(JSON.stringify(w.result(id))) <= 512 * 1024);

  const refused = w.add('access', IDS.admin);
  w.resultsStatus.push(400);
  await dash.tick();
  assert.equal(w.result(refused), null);
  const posts = w.resultPosts.length;
  const next = w.add('access', IDS.admin);
  assert.equal(await dash.tick(), 15000);
  assert.deepEqual(w.resultPosts.slice(posts).flatMap((p) => p.ids), [next]);
  assert.equal(w.result(next).result.grant, true);
});

test('the public page comes down when YapOS leaves a server, and is never republished there', async () => {
  const { h, w, dash, change } = await setup({ harness: { apps: ['levels'], fakeClock: true } });
  const puts = (sid) => w.requests.filter((r) => r.method === 'PUT' && r.path === `/bot/public/${sid}`).length;
  const dels = (sid) => w.requests.filter((r) => r.method === 'DELETE' && r.path === `/bot/public/${sid}`).length;

  h.engine.settings.patchCore(OTHER, { publicPage: { enabled: true, slug: 'old-town' } });
  w.publics[OTHER] = { enabled: true, slug: 'old-town' };
  await dash.tick();
  assert.equal(puts(OTHER), 0);
  assert.equal(dels(OTHER), 1);
  assert.equal(w.publics[OTHER], undefined);
  h.clock.t += 16 * 60_000;
  await dash.tick();
  assert.equal(puts(OTHER), 0);
  assert.equal(dels(OTHER), 1);

  const on = await change(IDS.admin, 'system', { settings: { publicPage: { enabled: true, slug: 'test-town' } } });
  assert.deepEqual(on.result.errors, {});
  assert.ok(w.publics[S]);
  if (!h.engine.bot.me) h.engine.bot.me = { id: IDS.bot };
  await h.leave(IDS.bot);
  await h.settle();
  assert.equal(w.publics[S], undefined);
  assert.equal(dels(S), 1);
});

test('a web save cannot set level-ups to a channel that does not exist', async () => {
  const { h, change } = await setup({ harness: { apps: ['levels'] } });
  const before = h.engine.settings.appConfig(S, 'levels');
  const r = await change(IDS.admin, 'levels', { settings: { announce: 'channel', channelId: 'c0000000-0000-4000-8000-0000000000ff' } });
  assert.ok(r.result.errors.announce);
  assert.ok(r.result.errors.channelId);
  const after = h.engine.settings.appConfig(S, 'levels');
  assert.equal(after.announce, before.announce);
  assert.equal(after.channelId ?? null, before.channelId ?? null);
  const good = await change(IDS.admin, 'levels', { settings: { announce: 'channel', channelId: C.general } });
  assert.deepEqual(good.result.errors, {});
  assert.equal(h.engine.settings.appConfig(S, 'levels').announce, 'channel');
  assert.equal(h.engine.settings.appConfig(S, 'levels').channelId, C.general);
});
