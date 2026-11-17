import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { createOwnerActions, NO_ACCOUNT, OWNER_NS, OWNER_LOG_KEY } from '../../engine/owner-actions.js';
import { GLOBAL_KEY, GIFT_BADGES, BADGE_NOTES, badgeGifts } from '../../engine/global.js';
import { badgeNotes, cardView, embedView } from '../../apps/profile.js';
import { PARTY_BADGES } from '../../apps/levels.js';

const SECRET = 'test-secret-value-for-owner-accounts';
const APPS = ['levels', 'economy', 'quests', 'achievements'];
const FAKE = 'f0000000-0000-4000-8000-00000000dead';

function fakeWorker() {
  const w = { owner: [], results: [], catalogs: [] };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'GET' && u.pathname === '/bot/poll') return reply(200, { jobs: [], hot: false, owner: w.owner.slice(0, 50) });
    if (init.method === 'POST' && u.pathname === '/bot/owner/results') {
      w.results.push(...body.results);
      const done = new Set(body.results.map((r) => r.id));
      w.owner = w.owner.filter((a) => !done.has(a.id));
      return reply(200, { ok: true });
    }
    if (init.method === 'POST' && u.pathname === '/bot/owner/catalog') {
      w.catalogs.push(body);
      return reply(200, { ok: true });
    }
    if (init.method === 'GET' && u.pathname === '/bot/party/stats') return reply(200, { stats: {} });
    return reply(200, { ok: true });
  };
  w.result = (id) => w.results.filter((r) => r.id === id).at(-1) || null;
  return w;
}

async function setup() {
  const h = await createHarness({ apps: APPS, fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  return { h, w, dash };
}

const ecoUsers = (h) => h.engine.store.get('economy', GLOBAL_KEY, {}).users || {};

test('owner changes for an id with no Yapin account are refused and create no records', async () => {
  const { h, w, dash } = await setup();
  w.owner = [
    { id: 'f1', user: FAKE, kind: 'shards.add', value: 50000 },
    { id: 'f2', user: FAKE, kind: 'xp.add', value: 500 },
    { id: 'f3', user: FAKE, kind: 'level.set', value: 10 },
    { id: 'f4', user: FAKE, kind: 'badge.grant', ref: 'einstein' },
    { id: 'f5', user: FAKE, kind: 'streak.set', value: 5 },
    { id: 'r1', user: IDS.member, kind: 'shards.add', value: 50 },
  ];
  await dash.tick();
  await h.settle();
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) {
    const r = w.result(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.message, NO_ACCOUNT, id);
    assert.equal(r.noAccount, true, id);
    assert.equal(r.after, undefined, id);
  }
  assert.match(NO_ACCOUNT, /^No Yapin' account has this id/);
  assert.equal(FAKE in ecoUsers(h), false, 'no wallet was made');
  assert.equal(h.engine.service('economy').balance(GLOBAL_KEY, FAKE), 0);
  assert.equal(h.engine.service('levels').getUser(null, FAKE).xp, 0);
  assert.equal(badgeGifts(h.engine, FAKE).gift.length, 0);
  assert.equal(w.result('r1').ok, true, 'real people still work');
  assert.equal(h.engine.service('economy').balance(GLOBAL_KEY, IDS.member), 50);
});

test('when Yapin cannot be reached the change waits instead of being applied or refused', async () => {
  const { h } = await setup();
  const real = h.engine.bot.user.bind(h.engine.bot);
  let down = true;
  h.engine.bot.user = async (id) => {
    if (down) throw Object.assign(new Error('gateway hiccup'), { status: 502 });
    return real(id);
  };
  const owner = createOwnerActions(h.engine, { now: h.now, dm: false });
  const first = await owner.run([{ id: 'u1', user: IDS.member, kind: 'shards.add', value: 75 }]);
  assert.equal(first.length, 0);
  assert.equal(h.engine.store.get(OWNER_NS, OWNER_LOG_KEY, {}).u1, undefined);
  assert.equal(h.engine.service('economy').balance(GLOBAL_KEY, IDS.member), 0);
  down = false;
  const second = await owner.run([{ id: 'u1', user: IDS.member, kind: 'shards.add', value: 75 }]);
  assert.equal(second.find((r) => r.id === 'u1').ok, true);
  assert.equal(h.engine.service('economy').balance(GLOBAL_KEY, IDS.member), 75);
});

test('when Yapin is down one batch asks only once instead of waiting on every change', async () => {
  const { h } = await setup();
  let asks = 0;
  h.engine.bot.user = async () => {
    asks += 1;
    throw Object.assign(new Error('down'), { status: 503 });
  };
  const owner = createOwnerActions(h.engine, { now: h.now, dm: false });
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, user: i % 2 ? IDS.member : FAKE, kind: 'shards.add', value: 5 }));
  const out = await owner.run(rows);
  assert.equal(out.length, 0);
  assert.equal(asks, 1);
  assert.equal(h.engine.service('economy').balance(GLOBAL_KEY, IDS.member), 0);
  assert.equal(FAKE in ecoUsers(h), false);
  await owner.run(rows);
  assert.equal(asks, 2, 'the next batch tries again');
});

test('taking the Shard power away still works for any id', async () => {
  const { h } = await setup();
  const owner = createOwnerActions(h.engine, { now: h.now, dm: false });
  const out = await owner.run([{ id: 'v1', user: FAKE, kind: 'giver.revoke' }]);
  assert.equal(out.find((r) => r.id === 'v1').ok, true);
});

test('the Einstein badge is a brain, can only be given by Jolli, and is in the owner catalog', async () => {
  const einstein = GIFT_BADGES.find((b) => b.id === 'einstein');
  assert.deepEqual({ ...einstein }, { id: 'einstein', label: 'Einstein', emoji: '🧠', note: 'Can only be given by Jolli' });
  assert.equal(BADGE_NOTES.einstein, 'Can only be given by Jolli');
  assert.equal(PARTY_BADGES.einstein, '🧠 Einstein');
  const { h, w, dash } = await setup();
  await dash.tick();
  const sent = w.catalogs.at(-1);
  assert.ok(sent.badges.some((b) => b.id === 'einstein' && b.emoji === '🧠' && b.label === 'Einstein'));
  w.owner = [{ id: 'e1', user: IDS.member, kind: 'badge.grant', ref: 'einstein' }];
  await dash.tick();
  assert.equal(w.result('e1').ok, true, w.result('e1').message);
  assert.match(w.result('e1').message, /🧠 Einstein/);
  assert.ok(badgeGifts(h.engine, IDS.member).gift.includes('einstein'));
  const stats = await dash.partyStats([IDS.member]);
  assert.ok(stats[IDS.member].badges.includes('einstein'));
  w.owner = [{ id: 'e2', user: IDS.member, kind: 'badge.revoke', ref: 'einstein' }];
  await dash.tick();
  assert.equal(w.result('e2').ok, true);
  assert.equal(badgeGifts(h.engine, IDS.member).gift.includes('einstein'), false);
});

test('the profile card says Einstein can only be given by Jolli', () => {
  assert.deepEqual(badgeNotes(['first-game', 'einstein', 'einstein']), ['🧠 Einstein: Can only be given by Jolli']);
  assert.deepEqual(badgeNotes(['first-game', 'supporter']), []);
  const data = {
    id: IDS.member,
    level: { xp: 10, level: 0, into: 10, need: 100, frac: 0.1 },
    shards: 0,
    privacy: { hidden: false, showShards: false },
    party: { games: 0, wins: 0, fav: null, badges: ['einstein'] },
    season: [],
    quests: null,
    clan: null,
    achievements: [],
  };
  const view = cardView(data, { name: 'Sam', username: 'sam', viewerIsOwner: true });
  assert.match(view.footer, /Badges: Einstein/);
  const text = JSON.stringify(embedView(data, view));
  assert.match(text, /🧠 Einstein: Can only be given by Jolli/);
});
