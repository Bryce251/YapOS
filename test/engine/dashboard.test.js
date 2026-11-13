import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard, publicSchema, jsonSafe, accept, reject } from '../../engine/dashboard.js';
import { createLogger } from '../../engine/log.js';
import { HARD_CAP, UNLIMITED, parseLimit, storeLimit } from '../../engine/limits.js';

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

test('casino bet limits save from the web like the typed command, checking min against max in the same change', async () => {
  const a = await createHarness({ apps: ['casino'] });
  a.engine.settings.setEnabled(S, 'casino', true);
  await a.slash('casino', 'maxbet 500', { user: IDS.admin });
  const { h, change } = await setup({ harness: { apps: ['casino'] } });
  const r = await change(IDS.admin, 'casino', { enabled: true, settings: { maxBet: 500 } });
  assert.deepEqual(r.result.errors, {});
  assert.deepEqual(h.engine.settings.appConfig(S, 'casino'), a.engine.settings.appConfig(S, 'casino'));
  const bad = await change(IDS.admin, 'casino', { settings: { minBet: 600 } });
  assert.equal(bad.result.errors.minBet, "The smallest bet can't be bigger than the biggest bet (500).");
  const both = await change(IDS.admin, 'casino', { settings: { minBet: 2000, maxBet: 5000, crashMax: 101 } });
  assert.deepEqual(Object.keys(both.result.errors), ['crashMax']);
  assert.equal(h.engine.settings.appConfig(S, 'casino').minBet, 2000);
  assert.equal(h.engine.settings.appConfig(S, 'casino').maxBet, 5000);
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
  const filters = snap.settings.automod.schema.find((f) => f.key === 'filters');
  assert.equal(filters.editor, 'toggles');
  assert.equal(filters.labels.raid, '🛡️ Raid shield');
  const actions = snap.settings.automod.schema.find((f) => f.key === 'actions');
  assert.equal(actions.labels.raid, undefined);
  assert.ok(actions.options.every((o) => /^\S+ \S/.test(o.label)));
  assert.equal(snap.settings.levels.schema.find((f) => f.key === 'rewards').editor, 'rewards');
  assert.equal(snap.settings.mod.schema.find((f) => f.key === 'escalation').editor, 'steps');
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

const NEW_TYPES = ['members', 'member', 'modaction', 'tickets', 'ticket', 'ticketaction'];

function seedTickets(h, count) {
  const t = h.now();
  h.engine.store.set('tickets', S, {
    seq: count,
    tickets: Object.fromEntries(Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const closed = n % 3 === 0;
      return [n, {
        id: `${S}:${n}`, number: n, channelId: closed ? null : `c-${n}`, roleId: null, openerId: n % 2 ? IDS.member : IDS.member2, typeId: 'support',
        claimedBy: null, status: closed ? 'closed' : 'open', createdAt: t - 10 * 86_400_000 + n, closedAt: closed ? (n === 3 ? t - 30 * 86_400_000 : t - 3_600_000) : null,
        closedBy: closed ? IDS.mod : null, reason: closed ? 'sorted' : null, answers: [{ q: 'What happened?', a: `case ${n}` }], topic: n === 7 ? 'Printer on fire' : `topic ${n}`,
        members: [], mode: 'role', name: `ticket-${String(n).padStart(4, '0')}`, cardId: null, lastActivityAt: t, rating: closed ? { stars: 4 } : null,
      }];
    })),
  });
}

function addMembers(h, count, extra = {}) {
  const list = h.fake.state.members[S];
  for (let i = 0; i < count; i++) {
    const n = String(i + 1).padStart(4, '0');
    list.push({ id: `f0000000-0000-4000-8000-00000000${n}`, username: `user${n}`, display_name: `User ${n}`, nickname: null, roles: [R.member], joined_at: new Date(Date.parse('2026-02-01T00:00:00Z') + i * 60_000).toISOString(), ...extra });
  }
  h.engine.cache.invalidate(S);
}

test('jobs go through one handler map and unknown or sneaky types are refused', async () => {
  const { w, dash, h } = await setup({ harness: { apps: ['mod'] } });
  assert.deepEqual([...dash.jobTypes].sort(), ['access', 'change', 'member', 'members', 'modaction', 'servers', 'ticket', 'ticketaction', 'tickets']);
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'MEMBERS', '']) w.queue.push({ id: `j-${type || 'blank'}`, type, user_id: IDS.admin, server_id: S, data: {} });
  w.queue.push({ id: 'j-num', type: 7, user_id: IDS.admin, server_id: S, data: {} });
  await dash.tick();
  await h.settle();
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'MEMBERS', 'blank', 'num']) {
    const r = w.result(`j-${type}`);
    assert.equal(r.ok, false, type);
    assert.equal(r.error, "I don't know that job.", type);
  }
});

test('every new job refuses members and mods, and marks the server as used for admins', async () => {
  const { run, dash, w } = await setup({ harness: { apps: ['mod', 'tickets'] } });
  const data = { user_id: IDS.member2, action: 'warn', number: 1 };
  for (const type of NEW_TYPES) {
    for (const who of [IDS.member, IDS.mod]) {
      const r = await run(type, who, data);
      assert.equal(r.ok, true, type);
      assert.equal(r.result.grant, false, type);
      assert.equal(r.result.error, 'You need to be an admin of this server.', type);
      assert.equal(r.error, 'You need to be an admin of this server.', type);
    }
  }
  assert.equal(Object.keys(w.snapshots).length, 0, 'refusals never push a snapshot');
  const ok = await run('members', IDS.admin);
  assert.equal(ok.result.grant, true);
  assert.equal(ok.result.level, 'admin');
  const owner = await run('members', IDS.owner);
  assert.equal(owner.result.level, 'owner');
  assert.ok(dash, 'still running');
});

test('the members job lists, searches, filters, sorts and pages the member list', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  const all = await run('members', IDS.admin);
  const r = all.result;
  assert.equal(r.total, 6);
  assert.equal(r.page, 1);
  assert.equal(r.pages, 1);
  assert.equal(r.pageSize, 50);
  assert.equal(r.capped, false);
  assert.deepEqual(r.members.map((m) => m.id), [IDS.member2, IDS.member, IDS.mod, IDS.admin, IDS.bot, IDS.owner]);
  const mo = r.members.find((m) => m.id === IDS.mod);
  assert.deepEqual(Object.keys(mo).sort(), ['avatar_url', 'bot', 'cases', 'id', 'joined_at', 'name', 'roles', 'username', 'warnings']);
  assert.equal(mo.name, 'Mo');
  assert.equal(mo.username, 'morgan');
  assert.equal(mo.joined_at, '2026-01-04T00:00:00Z');
  assert.deepEqual(mo.roles, [R.mod, R.member]);
  assert.equal(mo.bot, false);
  assert.equal(r.members.find((m) => m.id === IDS.bot).bot, true);
  assert.deepEqual(r.members.find((m) => m.id === IDS.admin).roles, [R.admin, R.member]);

  const old = await run('members', IDS.admin, { sort: 'joined_old' });
  assert.equal(old.result.members[0].id, IDS.owner);
  const byName = await run('members', IDS.admin, { sort: 'name' });
  assert.deepEqual(byName.result.members.map((m) => m.name), ['Alex', 'Jolli', 'Mo', 'Riley', 'Sam', 'YapOS']);

  assert.deepEqual((await run('members', IDS.admin, { q: 'RILEY' })).result.members.map((m) => m.id), [IDS.member2]);
  assert.deepEqual((await run('members', IDS.admin, { q: 'morg' })).result.members.map((m) => m.id), [IDS.mod]);
  assert.deepEqual((await run('members', IDS.admin, { q: IDS.member.slice(-6) })).result.members.map((m) => m.id), [IDS.member]);
  assert.equal((await run('members', IDS.admin, { q: 'nobody-like-this' })).result.total, 0);
  assert.deepEqual((await run('members', IDS.admin, { role: R.mod })).result.members.map((m) => m.id), [IDS.mod]);
  assert.deepEqual((await run('members', IDS.admin, { role: `<@&${R.admin}>` })).result.members.map((m) => m.id), [IDS.admin]);

  await h.engine.service('mod').act(S, { actorId: IDS.admin, kind: 'warn', targetId: IDS.member, reason: 'spam' });
  const after = await run('members', IDS.admin, { q: 'sam' });
  assert.equal(after.result.members[0].warnings, 1);
  assert.equal(after.result.members[0].cases, 1);

  addMembers(h, 120);
  const p1 = await run('members', IDS.admin, { sort: 'joined_old' });
  assert.equal(p1.result.total, 126);
  assert.equal(p1.result.pages, 3);
  assert.equal(p1.result.members.length, 50);
  const p3 = await run('members', IDS.admin, { sort: 'joined_old', page: '3' });
  assert.equal(p3.result.page, 3);
  assert.equal(p3.result.members.length, 26);
  const past = await run('members', IDS.admin, { page: 99 });
  assert.equal(past.result.page, 3, 'a page past the end lands on the last one');
});

test('the members job refuses bad input with a plain error and an empty list', async () => {
  const { run } = await setup({ harness: { apps: ['mod'] } });
  const cases = [
    [{ q: 'x'.repeat(101) }, /too long/],
    [{ q: 5 }, /too long/],
    [{ role: 'not a role!' }, /role id/],
    [{ role: ['r'] }, /role id/],
    [{ sort: 'random' }, /Sort by/],
    [{ sort: { a: 1 } }, /Sort by/],
    [{ page: 0 }, /page from 1 to 100/],
    [{ page: 101 }, /page from 1 to 100/],
    [{ page: 1.5 }, /page from 1 to 100/],
    [{ page: 'two' }, /page from 1 to 100/],
    [{ page: -1 }, /page from 1 to 100/],
  ];
  for (const [data, re] of cases) {
    const r = await run('members', IDS.admin, data);
    assert.equal(r.ok, true, JSON.stringify(data));
    assert.equal(r.result.grant, true);
    assert.match(r.result.error, re, JSON.stringify(data));
    assert.deepEqual(r.result.members, []);
    assert.equal(r.result.total, 0);
  }
  const fine = await run('members', IDS.admin, { q: 'x'.repeat(100), role: null, sort: '', page: null });
  assert.equal(fine.result.error, undefined);
});

test('the members job stays under 500 KB with a full member cache', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  addMembers(h, 1994, { username: 'u'.repeat(200), display_name: 'D'.repeat(200), avatar_path: 'avatars/a.png' });
  const r = await run('members', IDS.admin);
  assert.equal(r.ok, true);
  assert.equal(r.result.total, 2000);
  assert.equal(r.result.capped, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 500 * 1024);
  assert.ok(r.result.members.every((m) => m.username.length <= 64 && m.name.length <= 64));
});

test('the member job adds roles, status, notes and what the admin can do', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  h.fake.clock.t = Date.now();
  const mod = h.engine.service('mod');
  await mod.act(S, { actorId: IDS.admin, kind: 'note', targetId: IDS.member, note: 'first' });
  await mod.act(S, { actorId: IDS.admin, kind: 'note', targetId: IDS.member, note: 'second' });
  await mod.act(S, { actorId: IDS.admin, kind: 'timeout', targetId: IDS.member, durationMs: 600_000 });
  const r = await run('member', IDS.admin, { user_id: IDS.member });
  const m = r.result.member;
  for (const k of ['id', 'name', 'avatar_url', 'warnings', 'cases', 'levels', 'economy']) assert.ok(k in m, k);
  assert.equal(m.username, 'sam');
  assert.equal(m.nickname, null);
  assert.equal(m.joined_at, '2026-01-05T00:00:00Z');
  assert.deepEqual(m.roles.map((x) => x.id), [R.member]);
  assert.deepEqual(Object.keys(m.roles[0]).sort(), ['color', 'id', 'manageable', 'name', 'position']);
  assert.equal(m.banned, false);
  assert.equal(m.tempBan, null);
  assert.ok(m.timeout && typeof m.timeout.until === 'string');
  assert.deepEqual(m.notes.map((n) => n.text), ['second', 'first']);
  assert.deepEqual(m.can, { warn: true, unwarn: true, timeout: true, kick: true, ban: true, unban: false, role: true, nick: false, note: true }, 'YapOS has no Manage Nicknames here');
  assert.equal(m.bot, false);
  assert.ok(Array.isArray(m.assignable));
  assert.equal(m.cases[0].type, 'timeout');

  const owner = await run('member', IDS.admin, { user_id: IDS.owner });
  assert.equal(owner.result.member.can.kick, false, 'nobody can kick the owner');

  await mod.act(S, { actorId: IDS.admin, kind: 'ban', targetId: IDS.member2 });
  const gone = await run('member', IDS.admin, { user_id: IDS.member2 });
  assert.equal(gone.result.member.banned, true);
  assert.equal(gone.result.member.name, 'riley', 'the last known name from their cases');
  assert.notEqual(gone.result.member.name, 'Banned member');
  const stranger = await run('member', IDS.admin, { user_id: 'a0000000-0000-4000-8000-0000000000fe' });
  assert.equal(stranger.result.member.name, 'Not in the server');
  assert.equal(gone.result.member.can.unban, true);
  assert.equal(gone.result.member.can.ban, false);

  h.engine.settings.setEnabled(S, 'mod', false);
  const off = await run('member', IDS.admin, { user_id: IDS.member });
  assert.ok(Object.values(off.result.member.can).every((v) => v === false), 'no actions while Mod is uninstalled');

  for (const bad of [undefined, '', '../etc', 42, { id: IDS.member }]) {
    const x = await run('member', IDS.admin, { user_id: bad });
    assert.equal(x.result.member, null);
    assert.match(x.result.error, /doesn't look right/);
  }
});

test('modaction warns exactly like /mod warn, returns the case and fresh member, and pushes a snapshot', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod'] } });
  h.engine.settings.patchCore(S, { logChannel: C.modlog });
  const r = await run('modaction', IDS.admin, { user_id: IDS.member, action: 'warn', reason: 'spam links' });
  assert.equal(r.ok, true);
  const out = r.result;
  assert.equal(out.grant, true);
  assert.equal(out.ok, true);
  assert.equal(out.action, 'warn');
  assert.equal(out.case.n, 1);
  assert.equal(out.case.type, 'warn');
  assert.equal(out.case.reason, 'spam links');
  assert.equal(out.case.mod.id, IDS.admin);
  assert.match(out.message, /Warned/);
  assert.ok(!/\*\*/.test(out.message));
  assert.equal(out.member.id, IDS.member);
  assert.equal(out.member.warnings.length, 1);
  assert.equal(out.member.warnings[0].case, 1);
  const stored = h.engine.store.get('mod', S, null).cases[0];
  assert.equal(stored.source, 'dashboard');
  assert.ok(w.snapshots[S], 'a fresh snapshot went out');
  assert.equal(w.snapshots[S].cases[0].n, 1);
  const order = w.requests.map((r) => r.path);
  assert.ok(order.lastIndexOf('/bot/results') < order.lastIndexOf(`/bot/snapshot/${S}`), 'the answer goes out before the snapshot');
  assert.ok(h.fake.state.messages[C.modlog]?.length, 'the case went to the mod log');

  const typed = await createHarness({ apps: ['mod'] });
  await typed.slash('mod', `warn <@${IDS.member}> spam links`, { user: IDS.admin });
  const viaCommand = typed.engine.store.get('mod', S, null).cases[0];
  assert.equal(viaCommand.id, stored.id);
  assert.equal(viaCommand.action, stored.action);
  assert.equal(viaCommand.reason, stored.reason);
});

test('modaction runs timeouts, bans, unbans, unwarns, roles, nicknames and notes', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  h.fake.clock.t = Date.now();
  const act = (action, extra = {}, user = IDS.member) => run('modaction', IDS.admin, { user_id: user, action, ...extra }).then((r) => r.result);

  const to = await act('timeout', { duration: '10m', reason: 'cool off' });
  assert.equal(to.ok, true, to.error);
  assert.equal(to.case.duration, 600_000);
  assert.ok(h.fake.state.timeouts[`${S}:${IDS.member}`]);
  assert.ok(to.member.timeout);
  const unto = await act('untimeout');
  assert.equal(unto.ok, true);
  assert.equal(h.fake.state.timeouts[`${S}:${IDS.member}`], undefined);

  const temp = await act('ban', { duration: '2d' }, IDS.member2);
  assert.equal(temp.ok, true, temp.error);
  assert.equal(temp.case.type, 'ban');
  assert.equal(temp.case.duration, 2 * 86_400_000);
  assert.equal(temp.member.banned, true);
  assert.ok(temp.member.tempBan?.until);
  const unban = await act('unban', {}, IDS.member2);
  assert.equal(unban.ok, true, unban.error);
  assert.equal(unban.member.banned, false);

  const warn = await act('warn', { reason: 'rude' });
  const unwarn = await act('unwarn', { case: String(warn.case.n) });
  assert.equal(unwarn.ok, true, unwarn.error);
  assert.equal(unwarn.case.type, 'unwarn');
  assert.equal(unwarn.member.warnings.length, 0);
  const again = await act('unwarn', { case: warn.case.n });
  assert.equal(again.ok, false);
  assert.match(again.error, /already removed/);

  const give = await act('role_add', { role_id: R.vip });
  assert.equal(give.ok, true, give.error);
  assert.equal(give.case, null);
  assert.ok(h.fake.memberOf(S, IDS.member).roles.includes(R.vip));
  assert.ok(give.member.roles.some((x) => x.id === R.vip));
  const take = await act('role_remove', { role_id: R.vip });
  assert.equal(take.ok, true, take.error);
  assert.ok(!h.fake.memberOf(S, IDS.member).roles.includes(R.vip));
  const high = await act('role_add', { role_id: R.top });
  assert.equal(high.ok, false);
  assert.ok(high.error.length > 5);

  h.fake.state.roles[S].find((x) => x.id === R.bot).perms.manage_nicknames = true;
  h.engine.perms.invalidate();
  const nick = await act('nick', { nickname: 'Sammy' });
  assert.equal(nick.ok, true, nick.error);
  assert.equal(h.fake.memberOf(S, IDS.member).nickname, 'Sammy');
  const clear = await act('nick', { nickname: '' });
  assert.equal(clear.ok, true);
  assert.equal(h.fake.memberOf(S, IDS.member).nickname, null);

  const note = await act('note', { note: 'keeps asking for free roles' });
  assert.equal(note.ok, true);
  assert.equal(note.case, null);
  assert.equal(note.member.notes[0].text, 'keeps asking for free roles');

  const kick = await act('kick');
  assert.equal(kick.ok, true, kick.error);
  assert.equal(h.fake.memberOf(S, IDS.member), null);
});

test('modaction refusals answer ok:false with a plain sentence and change nothing', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  const act = (data) => run('modaction', IDS.admin, { user_id: IDS.member, ...data }).then((r) => {
    assert.equal(r.ok, true, 'the job itself is done');
    assert.equal(r.result.grant, true);
    return r.result;
  });
  const bad = [
    [{ action: 'explode' }, /don't know that action/],
    [{ action: ['warn'] }, /don't know that action/],
    [{ action: 'warn', user_id: 'not an id!' }, /member id/],
    [{ action: 'warn', user_id: null }, /member id/],
    [{ action: 'warn', reason: 'r'.repeat(501) }, /under 500/],
    [{ action: 'warn', reason: 7 }, /under 500/],
    [{ action: 'timeout' }, /how long/],
    [{ action: 'timeout', duration: 'soon' }, /couldn't read that length/],
    [{ action: 'timeout', duration: '1'.repeat(21) }, /couldn't read that length/],
    [{ action: 'timeout', duration: '30d' }, /28 days/],
    [{ action: 'timeout', duration: '10s' }, /at least 1 minute/],
    [{ action: 'ban', duration: '2y' }, /up to 1 year/],
    [{ action: 'ban', duration: 'forever' }, /couldn't read that length/],
    [{ action: 'nick', nickname: 'n'.repeat(33) }, /up to 32/],
    [{ action: 'note', note: 'n'.repeat(501) }, /under 500/],
    [{ action: 'note', note: '   ' }, /empty/],
    [{ action: 'role_add' }, /Pick a role/],
    [{ action: 'role_add', role_id: '<bad role>' }, /role id/],
    [{ action: 'role_add', role_id: 'r0000000-0000-4000-8000-0000000000ff' }, /couldn't find that role/],
    [{ action: 'unwarn' }, /Pick the warning/],
    [{ action: 'unwarn', case: 0 }, /case number/],
    [{ action: 'unwarn', case: 1.5 }, /case number/],
    [{ action: 'unwarn', case: 2_000_000_000 }, /case number/],
    [{ action: 'unwarn', case: 9 }, /couldn't find a warning/],
    [{ action: 'kick', user_id: IDS.owner }, /owner/],
  ];
  for (const [data, re] of bad) {
    const out = await act(data);
    assert.equal(out.ok, false, JSON.stringify(data));
    assert.equal(typeof out.error, 'string');
    assert.match(out.error, re, JSON.stringify(data));
    assert.ok(!/\*\*|`|<@/.test(out.error), out.error);
    assert.equal(out.case, undefined);
  }
  assert.equal(h.engine.store.get('mod', S, null)?.cases?.length ?? 0, 0, 'no cases were recorded');
  assert.ok(h.fake.memberOf(S, IDS.owner));

  h.engine.settings.setEnabled(S, 'mod', false);
  const off = await act({ action: 'warn' });
  assert.equal(off.ok, false);
  assert.match(off.error, /Mod isn't installed/);
});

test('modaction turns raw API failures into a plain sentence', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod'] } });
  const mod = h.engine.service('mod');
  const real = mod.act;
  mod.act = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  try {
    const r = await run('modaction', IDS.admin, { user_id: IDS.member, action: 'kick' });
    assert.equal(r.result.ok, false);
    assert.ok(r.result.error.length > 10);
    assert.ok(!/403|Forbidden/.test(r.result.error), r.result.error);
  } finally {
    mod.act = real;
  }
});

test('the tickets job lists tickets through the tickets service', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod', 'tickets'] } });
  seedTickets(h, 120);
  const open = await run('tickets', IDS.admin);
  assert.equal(open.result.grant, true);
  assert.equal(open.result.total, 80);
  assert.equal(open.result.pages, 2);
  assert.equal(open.result.pageSize, 50);
  assert.deepEqual(open.result.counts, { open: 80, closed: 40 });
  assert.equal(open.result.rating.count, 40);
  assert.equal(open.result.tickets[0].number, 119);
  const row = open.result.tickets[0];
  for (const k of ['number', 'status', 'name', 'topic', 'type', 'opener', 'claimedBy', 'members', 'createdAt', 'closedAt', 'lastActivityAt', 'rating', 'channelId']) assert.ok(k in row, k);
  const closed = await run('tickets', IDS.admin, { status: 'closed', page: '2' });
  assert.equal(closed.result.page, 1, 'one page of closed tickets');
  assert.ok(closed.result.tickets.every((t) => t.status === 'closed'));
  const all = await run('tickets', IDS.admin, { status: 'all' });
  assert.equal(all.result.total, 120);
  const found = await run('tickets', IDS.admin, { q: 'PRINTER' });
  assert.deepEqual(found.result.tickets.map((t) => t.number), [7]);

  for (const [data, re] of [[{ status: 'pending' }, /open, closed or all/], [{ q: 'q'.repeat(101) }, /too long/], [{ page: 0 }, /page from/], [{ page: 'x' }, /page from/]]) {
    const r = await run('tickets', IDS.admin, data);
    assert.match(r.result.error, re);
    assert.deepEqual(r.result.tickets, []);
    assert.deepEqual(r.result.counts, { open: 0, closed: 0 });
  }
  h.engine.settings.setEnabled(S, 'tickets', false);
  const off = await run('tickets', IDS.admin);
  assert.match(off.result.error, /Tickets isn't installed/);
  assert.deepEqual(off.result.tickets, []);
});

test('the ticket job gives details and the right transcript, trimmed to fit', async () => {
  const { h, run } = await setup({ harness: { apps: ['mod', 'tickets'] } });
  seedTickets(h, 9);
  const open = await run('ticket', IDS.admin, { number: 1 });
  assert.equal(open.result.ticket.number, 1);
  assert.deepEqual(open.result.ticket.answers, [{ q: 'What happened?', a: 'case 1' }]);
  assert.ok(Array.isArray(open.result.ticket.people));
  assert.ok('closedBy' in open.result.ticket && 'reason' in open.result.ticket);
  assert.ok(open.result.transcript === null || open.result.transcript.live === true);

  const none = await run('ticket', IDS.admin, { number: '3' });
  assert.equal(none.result.ticket.status, 'closed');
  assert.equal(none.result.transcript, null, 'old closed tickets have no stored copy');

  h.engine.store.update('tickets', S, (d) => {
    d.tickets[6].hasTranscript = true;
    return d;
  });
  h.engine.store.set('ticket-transcripts', `${S}-6`, { text: `start\n${'€'.repeat(199_990)}\nthe end`, count: 42, at: 1 });
  const big = await run('ticket', IDS.admin, { number: 6 });
  assert.equal(big.ok, true, big.error);
  assert.equal(big.result.transcript.live, false);
  assert.equal(big.result.transcript.count, 42);
  assert.ok(big.result.transcript.text.endsWith('\nthe end'), 'the end is kept');
  assert.ok(!big.result.transcript.text.startsWith('start'), 'the start was cut to fit');
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 500 * 1024);

  for (const bad of [undefined, 0, -1, 'abc', 1.5, 2_000_000_000, { n: 1 }]) {
    const r = await run('ticket', IDS.admin, { number: bad });
    assert.match(r.result.error, /ticket number/, String(bad));
    assert.equal(r.result.ticket, null);
    assert.equal(r.result.transcript, null);
  }
  const missing = await run('ticket', IDS.admin, { number: 500 });
  assert.match(missing.result.error, /couldn't find that ticket/);
  h.engine.settings.setEnabled(S, 'tickets', false);
  const off = await run('ticket', IDS.admin, { number: 1 });
  assert.match(off.result.error, /Tickets isn't installed/);
});

test('ticketaction claims, unclaims and refuses closing a closed ticket', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod', 'tickets'] } });
  seedTickets(h, 6);
  const claim = await run('ticketaction', IDS.admin, { number: 1, action: 'claim' });
  assert.equal(claim.result.grant, true);
  assert.equal(claim.result.ok, true, claim.result.error);
  assert.match(claim.result.message, /claimed ticket #0001/);
  assert.equal(claim.result.ticket.claimedBy.id, IDS.admin);
  assert.equal(claim.result.error, undefined);
  assert.ok(w.snapshots[S], 'a fresh snapshot went out');
  const unclaim = await run('ticketaction', IDS.admin, { number: '1', action: 'unclaim' });
  assert.equal(unclaim.result.ok, true, unclaim.result.error);
  assert.equal(unclaim.result.ticket.claimedBy, null);
  const twice = await run('ticketaction', IDS.admin, { number: 1, action: 'unclaim' });
  assert.equal(twice.result.ok, false);
  assert.match(twice.result.error, /Nobody has claimed/);

  const closed = await run('ticketaction', IDS.admin, { number: 3, action: 'close', reason: 'done' });
  assert.equal(closed.result.ok, false);
  assert.match(closed.result.error, /already closed/);
  assert.equal(closed.result.ticket.status, 'closed');

  const bad = [
    [{ number: 1, action: 'delete' }, /claim, unclaim or close/],
    [{ number: 1 }, /claim, unclaim or close/],
    [{ number: 0, action: 'claim' }, /ticket number/],
    [{ number: 'one', action: 'claim' }, /ticket number/],
    [{ number: 1, action: 'close', reason: 'r'.repeat(501) }, /under 500/],
    [{ number: 999, action: 'claim' }, /couldn't find that ticket/],
  ];
  for (const [data, re] of bad) {
    const r = await run('ticketaction', IDS.admin, data);
    assert.equal(r.result.ok, false, JSON.stringify(data));
    assert.match(r.result.error, re, JSON.stringify(data));
    assert.equal(r.result.message, r.result.error);
  }
  h.engine.settings.setEnabled(S, 'tickets', false);
  const off = await run('ticketaction', IDS.admin, { number: 1, action: 'claim' });
  assert.match(off.result.error, /Tickets isn't installed/);
});

test('the overview has mod, ticket and member stats', async () => {
  const { h, w, run } = await setup({ harness: { apps: ['mod', 'tickets'] } });
  await run('access', IDS.admin);
  const empty = w.snapshots[S].overview.stats;
  assert.equal(empty.casesByDay.length, 14);
  assert.ok(empty.casesByDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && d.count === 0));
  assert.deepEqual(empty.casesByType, {});
  assert.equal(empty.activeWarns, 0);
  assert.equal(empty.tempBans, 0);
  assert.deepEqual(empty.tickets, { open: 0, closed7d: 0 });
  assert.equal(empty.newMembers7d, 0);

  const mod = h.engine.service('mod');
  await mod.act(S, { actorId: IDS.admin, kind: 'warn', targetId: IDS.member, reason: 'a' });
  await mod.act(S, { actorId: IDS.admin, kind: 'warn', targetId: IDS.member2, reason: 'b' });
  await mod.act(S, { actorId: IDS.admin, kind: 'ban', targetId: IDS.member2, durationMs: 86_400_000 });
  seedTickets(h, 6);
  h.fake.state.members[S].push({ id: IDS.admin2, username: 'casey', display_name: 'Casey', nickname: null, roles: [], joined_at: new Date(h.now() - 86_400_000).toISOString() });
  h.engine.cache.invalidate(S);
  await run('access', IDS.admin);
  const s = w.snapshots[S].overview.stats;
  assert.equal(s.casesByDay.reduce((a, d) => a + d.count, 0), 3);
  assert.equal(s.casesByDay.at(-1).count, 3, 'today is last');
  assert.deepEqual(s.casesByType, { warn: 2, ban: 1 });
  assert.equal(s.activeWarns, 2);
  assert.equal(typeof s.activeTimeouts, 'number');
  assert.equal(s.tempBans, 1);
  assert.deepEqual(s.tickets, { open: 4, closed7d: 1 });
  assert.equal(s.newMembers7d, 1);
  h.engine.store.update('tickets', S, (d) => { d.tickets[1].status = 'closing'; return d; });
  await run('access', IDS.admin);
  assert.equal(w.snapshots[S].overview.counts.openTickets, w.snapshots[S].overview.stats.tickets.open, 'both open counts include closing tickets');
  assert.equal(w.snapshots[S].overview.counts.openTickets, 4);

  h.engine.settings.setEnabled(S, 'mod', false);
  await run('access', IDS.admin);
  assert.equal(w.snapshots[S].overview.stats.casesByDay.length, 14);
});

test('a setting that takes "inf" keeps its flag and its value on the way to the web', async () => {
  const { h, w, run, change } = await setup({ harness: { apps: ['mod'] } });
  h.engine.apps.register(
    { id: 'limits', name: 'Limits', icon: '🔢', category: 'fun', description: 'A test app', defaults: { maxBet: 500, reward: 50 } },
    {
      dashboard: [
        {
          key: 'maxBet',
          label: 'Biggest bet',
          type: 'number',
          web: true,
          min: 1,
          max: HARD_CAP,
          unlimited: true,
          validate: (ctx, v) => {
            const n = parseLimit(v, { min: 1 });
            return n === null ? reject('Use a whole number or inf.') : accept(storeLimit(n));
          },
        },
        { key: 'reward', label: 'Daily reward', type: 'number', web: true, min: 1, max: HARD_CAP, validate: (ctx, v) => accept(Number(v)) },
        { key: 'raw', label: 'Raw cap', type: 'number', web: true, min: 1, max: HARD_CAP, unlimited: true, validate: (ctx, v) => accept(parseLimit(v, { min: 1 })) },
      ],
    },
  );

  await run('access', IDS.admin);
  const schema = w.snapshots[S].settings.limits.schema;
  const bet = schema.find((f) => f.key === 'maxBet');
  const reward = schema.find((f) => f.key === 'reward');
  assert.equal(bet.unlimited, true);
  assert.equal(bet.max, HARD_CAP);
  assert.equal(Object.hasOwn(reward, 'unlimited'), false);
  assert.equal(reward.max, HARD_CAP);
  assert.equal(w.snapshots[S].settings.limits.values.maxBet, 500);

  const saved = await change(IDS.admin, 'limits', { settings: { maxBet: 'inf' } });
  assert.deepEqual(saved.result.errors, {});
  assert.equal(saved.result.applied.maxBet, 'inf');
  assert.equal(h.engine.settings.appConfig(S, 'limits').maxBet, 'inf');
  assert.equal(saved.result.snapshot.settings.limits.values.maxBet, 'inf');

  await run('access', IDS.admin);
  assert.equal(w.snapshots[S].settings.limits.values.maxBet, 'inf');

  const big = await change(IDS.admin, 'limits', { settings: { maxBet: '2b' } });
  assert.deepEqual(big.result.errors, {});
  assert.equal(h.engine.settings.appConfig(S, 'limits').maxBet, 2_000_000_000);
  await run('access', IDS.admin);
  assert.equal(w.snapshots[S].settings.limits.values.maxBet, 2_000_000_000);

  const raw = await change(IDS.admin, 'limits', { settings: { raw: 'unlimited' } });
  assert.deepEqual(raw.result.errors, {});
  assert.equal(raw.result.applied.raw, 'inf');
  assert.equal(h.engine.settings.appConfig(S, 'limits').raw, 'inf');
  assert.equal(JSON.parse(JSON.stringify(h.engine.settings.appConfig(S, 'limits'))).raw, 'inf');
});

test('no setting ever reaches the web as Infinity', () => {
  const unlimited = publicSchema({ key: 'cap', label: 'Cap', type: 'number', unlimited: true, min: 0, max: UNLIMITED, default: UNLIMITED, web: true });
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.max, HARD_CAP);
  assert.equal(unlimited.default, 'inf');
  assert.equal(JSON.parse(JSON.stringify(unlimited)).default, 'inf');

  const plain = publicSchema({ key: 'pay', label: 'Pay', type: 'number', min: 1, max: HARD_CAP, default: 100, web: true });
  assert.equal(Object.hasOwn(plain, 'unlimited'), false);
  assert.equal(plain.max, HARD_CAP);

  assert.deepEqual(jsonSafe({ a: UNLIMITED, b: [1, UNLIMITED], c: 'inf', d: null }), { a: 'inf', b: [1, 'inf'], c: 'inf', d: null });
  assert.deepEqual(jsonSafe({ a: NaN, b: -Infinity }), { a: null, b: null });
});
