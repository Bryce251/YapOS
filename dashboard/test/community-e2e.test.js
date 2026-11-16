import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, BOT_SECRET, USERS, SERVER } from './helpers.js';
import { resultsBody } from '../web/activity/js/admin.js';
import { createMemoryStore } from '../../engine/storage.js';
import { createDashboard } from '../../engine/dashboard.js';
import { profileSync, dropProfileSync } from '../../engine/profiles-sync.js';
import { seasonSync, dropSeasonSync } from '../../engine/seasons-sync.js';
import { createStats } from '../../engine/stats.js';
import { setPrivacy } from '../../engine/profile-data.js';
import { mutateGlobal, SEASON_NS } from '../../engine/global.js';

const uid = (i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
const HOUR = 3600 * 1000;

function botEngine(h, { paid = [] } = {}) {
  const handlers = {};
  const names = { [uid(1)]: 'pip', [uid(2)]: 'juno', [uid(3)]: 'watcher' };
  const services = new Map([
    ['economy', {
      add: async (key, user, n, reason) => { paid.push({ key, user, n, reason }); return n; },
      balance: () => 420,
      partyRates: () => ({ play: 6, win: 14, tournament: 30, prediction: 4, cap: 160 }),
    }],
    ['levels', {
      addXp: async () => 0,
      getUser: () => ({ xp: 1234, level: 7, into: 34, need: 400 }),
    }],
  ]);
  const engine = {
    config: { dashboardUrl: h.base, dashboardSecret: BOT_SECRET },
    store: createMemoryStore(),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    scheduler: { now: () => h.clock.t },
    service: (id) => services.get(id) || null,
    bot: {
      me: { id: uid(99) },
      handlers,
      on(ev, fn) { (handlers[ev] ||= []).push(fn); },
      async emit(ev, data) { for (const fn of handlers[ev] || []) await fn(data); },
      async user(id) { return names[id] ? { id, username: names[id], display_name: names[id].toUpperCase() } : null; },
    },
  };
  const fetch = (url, init = {}) => h.worker.fetch(new Request(url, { method: init.method, headers: init.headers, body: init.body }), h.env, { waitUntil() {} });
  return { engine, fetch };
}

function sendResults(h, body) {
  return h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body, ip: '198.51.100.40' });
}

test('activity results with a tournament and predictions become Party Shards the bot pays as earned', async () => {
  const h = createHarness({ PARTY_OWNER_ID: USERS.alice.id });
  const paid = [];
  const { engine, fetch } = botEngine(h, { paid });
  const dash = createDashboard({ engine, url: h.base, secret: BOT_SECRET, fetch, now: () => h.clock.t, setTimeout: () => ({}), clearTimeout: () => {} });
  dash.start();
  assert.equal(await dash.pushPartyRates(), true);
  const rates = await (await h.bot('GET', '/bot/party/rates')).json();
  assert.deepEqual(rates.rates, { play: 6, win: 14, tournament: 30, prediction: 4, cap: 160 });

  const body = resultsBody({
    game: 'hangman',
    at: h.clock.t,
    players: [
      { id: uid(1), name: 'Pip', username: 'pip', score: 30, won: true },
      { id: uid(2), name: 'Juno', username: 'juno', score: 10, won: false },
    ],
    extra: { tournament: { winner: uid(1) } },
    predictions: [
      { id: uid(3), name: 'Watcher', username: 'watcher', pick: uid(1), right: true },
      { id: uid(4), name: 'Wrong', username: null, pick: uid(2), right: false },
    ],
  });
  assert.ok(body, 'the activity builds a body');
  assert.deepEqual(body.extra.tournament, { winner: uid(1) });
  const res = await sendResults(h, body);
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.counted, true);

  const poll = await h.poll();
  const rows = poll.party.shards;
  const by = (u, r) => rows.find((x) => x.user === u && x.reason === r);
  assert.equal(by(uid(1), 'play').shards, 6);
  assert.equal(by(uid(1), 'win').shards, 14);
  assert.equal(by(uid(1), 'tournament').shards, 30);
  assert.equal(by(uid(3), 'prediction').shards, 4);
  assert.equal(by(uid(4), 'prediction'), undefined);
  for (const r of rows) assert.equal(r.game, 'hangman');

  const applied = await dash.applyParty(poll.party);
  assert.equal(applied.paid, rows.length);
  assert.ok(paid.every((p) => p.reason === 'YapOS Party' && p.key === 'global'));
  assert.equal(paid.filter((p) => p.user === uid(1)).reduce((n, p) => n + p.n, 0), 50);
  const again = await h.poll();
  assert.equal(again.party.shards.length, 0, 'acked rows are not sent again');
  await dash.applyParty(poll.party);
  assert.equal(paid.length, rows.length, 'a repeated row never pays twice');
  dash.stop();
});

test('profile snapshots, privacy settings, seasons and server stats from the bot land on yapos.dev', async () => {
  const h = createHarness({ PARTY_OWNER_ID: USERS.alice.id });
  const { engine, fetch } = botEngine(h);
  try {
    const sync = profileSync(engine, { fetch });
    sync.install();
    seasonSync(engine, { fetch }).install();
    setPrivacy(engine, uid(1), { showShards: true });
    sync.note(uid(1), { username: 'pip', display_name: 'Pip' });
    sync.note(uid(2), { username: 'juno', display_name: 'Juno' });
    setPrivacy(engine, uid(2), { hidden: true });
    const pushed = await sync.push();
    assert.equal(pushed.sent, 2);

    const pub = await h.request('GET', '/api/u/pip');
    assert.equal(pub.status, 200);
    const { profile } = await pub.json();
    assert.equal(profile.level, 7);
    assert.equal(profile.xp, 1234);
    assert.equal(profile.shards, 420);
    assert.equal(profile.name, 'Pip');
    assert.equal((await h.request('GET', '/api/u/juno')).status, 404);

    const { cookie } = await h.login(USERS.alice);
    const vis = await h.api('POST', '/api/me/profile-visibility', cookie, { hidden: true, showShards: false });
    assert.equal(vis.status, 200);
    const poll = await h.poll();
    assert.deepEqual(poll.profileSettings, [{ user: USERS.alice.id.toLowerCase(), hidden: true, showShards: false }]);
    const done = await sync.applySettings(poll.profileSettings);
    assert.equal(done.applied, 1);
    assert.equal(done.acked, 1);
    assert.deepEqual((await h.poll()).profileSettings, []);

    mutateGlobal(engine, SEASON_NS, (d) => {
      d.month = '2026-11';
      d.xp = {};
      d.shards = {};
      d.badges = {};
      d.history = {};
    }, {});
    await engine.bot.emit('season:closed', { month: '2026-10', boards: { xp: [[uid(1), 900], [uid(2), 300]], shards: [[uid(1), 120]] } });
    assert.equal(seasonSync(engine).waiting, 0);
    const seasons = await (await h.request('GET', '/api/seasons')).json();
    const oct = (seasons.seasons || []).find((s) => s.month === '2026-10');
    assert.ok(oct, JSON.stringify(seasons));

    const stats = createStats(engine, { now: () => h.clock.t - 2 * HOUR, fetch });
    stats.record('message', SERVER, uid(1));
    stats.record('message', SERVER, uid(2));
    stats.record('join', SERVER);
    const later = createStats(engine, { now: () => h.clock.t, fetch });
    stats.save();
    const flushed = await later.flush();
    assert.equal(flushed.sent, 1);
    assert.equal(flushed.failed, 0);
    await h.grant(cookie);
    const read = await h.api('GET', `/api/servers/${SERVER}/stats?days=7`, cookie);
    assert.equal(read.status, 200);
    const text = JSON.stringify(await read.json());
    assert.match(text, /"messages":2/);
  } finally {
    dropProfileSync(engine);
    dropSeasonSync(engine);
  }
});
