import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness as createWorkerHarness, advance, USERS } from './helpers.js';
import { createHarness as createBotHarness } from '../../test/harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GLOBAL_KEY } from '../../engine/global.js';
import { setPrivacy } from '../../engine/profile-data.js';

const OWNER = USERS.alice;
const PIP = '77777777-7777-4777-8777-000000000001';
const MIN = 60 * 1000;

async function setup() {
  const w = createWorkerHarness({ PARTY_OWNER_ID: OWNER.id });
  const cookie = (await w.login(OWNER)).cookie;
  const b = await createBotHarness({ apps: ['levels', 'economy', 'quests', 'achievements'], fakeClock: true });
  const lookup = b.engine.bot.user.bind(b.engine.bot);
  b.engine.bot.user = async (id) => (id === PIP ? { id: PIP, username: 'pip', display_name: 'Pip', avatar_path: null } : lookup(id));
  const failPosts = { results: 0 };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/bot/owner/results' && failPosts.results > 0) {
      failPosts.results -= 1;
      return new Response('{"error":"down"}', { status: 503 });
    }
    const headers = new Headers(init.headers || {});
    headers.set('CF-Connecting-IP', '203.0.113.9');
    return w.worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), w.env, { waitUntil() {} });
  };
  const dash = () => createDashboard({ engine: b.engine, url: w.base, secret: w.env.BOT_SECRET, fetch, now: () => w.clock.t });
  const bot = dash();
  const give = async (body) => {
    const res = await w.api('POST', '/api/owner/actions', cookie, { user: PIP, ...body });
    return { status: res.status, body: await res.json() };
  };
  const cycle = async (d = bot) => {
    const { owner } = await w.poll();
    await d.syncOwner(owner);
    return owner;
  };
  const detail = async () => (await w.api('GET', `/api/owner/users/${PIP}`, cookie)).json();
  const bal = () => b.engine.service('economy').balance(GLOBAL_KEY, PIP);
  return { w, b, cookie, bot, dash, give, cycle, detail, bal, failPosts };
}

test('every body the Worker queues is accepted and applied by the real bot', async () => {
  const s = await setup();
  const res = await s.w.bot('POST', '/bot/owner/catalog', s.bot.ownerCatalog());
  assert.equal(res.status, 200);
  const catalog = (await s.detail()).catalog;
  assert.ok(catalog.achievements.some((a) => a.id === 'msgs1k'));
  const season = catalog.badges.find((x) => x.source === 'season');
  assert.ok(season, 'past season badges can be given');
  const gifts = [
    { kind: 'shards.add', value: '1,000', notify: true },
    { kind: 'shards.remove', value: 250 },
    { kind: 'xp.add', value: 5000 },
    { kind: 'level.set', value: 3 },
    { kind: 'achievement.grant', id: 'msgs1k' },
    { kind: 'badge.grant', id: 'supporter' },
    { kind: 'badge.grant', id: season.id },
    { kind: 'giver.grant' },
    { kind: 'giver.revoke' },
    { kind: 'quests.reset' },
    { kind: 'streak.set', value: 12 },
    { kind: 'achievement.revoke', id: 'msgs1k' },
    { kind: 'badge.revoke', id: 'supporter' },
  ];
  for (const g of gifts) assert.equal((await s.give(g)).status, 201, g.kind);
  const sent = await s.cycle();
  assert.equal(sent.length, gifts.length);
  const d = await s.detail();
  const failed = d.actions.filter((a) => a.status !== 'done');
  assert.deepEqual(failed.map((a) => `${a.kind}: ${a.result}`), []);
  assert.equal(s.bal(), 750);
  assert.equal(d.user.shards, 750, 'the owner sees Shards even when they are not public');
  assert.equal(s.b.engine.service('levels').getUser(null, PIP).level, 3);
  assert.equal(d.user.level, 3);
  assert.equal((await s.cycle()).length, 0);
});

test('a lost results post and a bot restart still apply each action exactly once', async () => {
  const s = await setup();
  assert.equal((await s.give({ kind: 'shards.add', value: 40 })).status, 201);
  s.failPosts.results = 2;
  await s.cycle();
  assert.equal(s.bal(), 40);
  assert.equal((await s.detail()).actions[0].status, 'sent');
  const restarted = s.dash();
  assert.equal((await s.cycle(restarted)).length, 0, 'not re-sent before two minutes');
  assert.equal((await s.detail()).actions[0].status, 'sent');
  advance(s.w, 2 * MIN + 1);
  assert.equal((await s.cycle(restarted)).length, 1, 're-sent after two minutes');
  assert.equal(s.bal(), 40, 'applied once');
  const d = await s.detail();
  assert.equal(d.actions[0].status, 'done');
  assert.match(d.actions[0].result, /Gave 40/);
});

test('removals never push a balance below zero', async () => {
  const s = await setup();
  await s.give({ kind: 'shards.add', value: 10 });
  await s.give({ kind: 'shards.remove', value: 500 });
  await s.give({ kind: 'xp.remove', value: 500 });
  await s.cycle();
  assert.equal(s.bal(), 0);
  assert.equal(s.b.engine.service('levels').getUser(null, PIP).xp, 0);
  const d = await s.detail();
  assert.match(d.actions.find((a) => a.kind === 'shards.remove').result, /all they had/);
  assert.equal(d.user.shards, 0);
});

test('a hidden profile stays hidden after an owner change', async () => {
  const s = await setup();
  s.w.db.raw.prepare("INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, 'pip', 'pip', 'Pip', 0, 0, NULL, '[]', '[]', '[]', NULL, 1, ?)").run(PIP, s.w.clock.t);
  setPrivacy(s.b.engine, PIP, { hidden: true });
  await s.give({ kind: 'shards.add', value: 77 });
  await s.give({ kind: 'xp.add', value: 900 });
  await s.cycle();
  const row = s.w.db.raw.prepare('SELECT level, xp, shards FROM public_profiles WHERE user_id = ?').get(PIP);
  assert.deepEqual({ ...row }, { level: 0, xp: 0, shards: null });
  const d = await s.detail();
  assert.equal(d.user.shards, 77);
  assert.equal(d.user.xp, 900);
});

test('ids the bot does not know are refused on both sides', async () => {
  const s = await setup();
  await s.w.bot('POST', '/bot/owner/catalog', s.bot.ownerCatalog());
  assert.equal((await s.give({ kind: 'achievement.grant', id: 'not-real' })).status, 400);
  assert.equal((await s.give({ kind: 'badge.grant', id: 'season-xp-1-2999-01' })).status, 400);
  assert.equal((await s.give({ kind: 'shards.add', value: 'inf' })).status, 400);
  assert.equal((await s.give({ kind: 'shards.add', value: -5 })).status, 400);
  assert.equal(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM owner_actions').get().n, 0);
});
