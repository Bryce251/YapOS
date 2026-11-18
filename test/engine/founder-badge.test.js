import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { GIFT_BADGES, BADGE_NOTES, FOUNDER_BADGE, FOUNDER_ONLY, badgeGifts, grantBadge, withGiftBadges, cleanCustomBadges, isFounderName } from '../../engine/global.js';
import { PARTY_BADGES } from '../../apps/levels.js';
import { ACHIEVEMENTS } from '../../apps/achievements.js';
import { badgeNotes } from '../../apps/profile.js';

const SECRET = 'test-secret-value-for-the-founder-badge';
const APPS = ['levels', 'economy', 'quests', 'achievements'];

function fakeWorker() {
  const w = { owner: [], results: [], catalogs: [], stats: {} };
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
    if (init.method === 'GET' && u.pathname === '/bot/party/stats') return reply(200, { stats: w.stats });
    return reply(200, { ok: true });
  };
  w.result = (id) => w.results.filter((r) => r.id === id).at(-1) || null;
  return w;
}

async function setup() {
  const h = await createHarness({ apps: APPS, fakeClock: true });
  h.engine.config.ownerId = IDS.owner;
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  return { h, w, dash };
}

test('the clan achievement is called Clan founder and keeps its id', () => {
  const clan = ACHIEVEMENTS.find((a) => a.id === 'clanfound');
  assert.equal(clan.name, 'Clan founder');
  assert.equal(ACHIEVEMENTS.some((a) => /^founder$/i.test(a.name)), false);
});

test('the Founder badge is a gift badge only Jolli has', () => {
  const founder = GIFT_BADGES.find((b) => b.id === FOUNDER_BADGE);
  assert.deepEqual({ ...founder }, { id: 'founder', label: 'Founder', emoji: '🔱', note: 'The owner of YapOS. Only Jolli has it' });
  assert.equal(GIFT_BADGES.filter((b) => b.emoji === '🔱').length, 1);
  assert.equal(PARTY_BADGES.founder, '🔱 Founder');
  assert.equal(BADGE_NOTES.founder, 'The owner of YapOS. Only Jolli has it');
  assert.deepEqual(badgeNotes(['founder']), ['🔱 Founder: The owner of YapOS. Only Jolli has it']);
  assert.equal(FOUNDER_ONLY, 'Only Jolli can have the Founder badge.');
});

test('the bot refuses to give the Founder badge to anyone but the owner', async () => {
  const { h, w, dash } = await setup();
  await dash.tick();
  assert.ok(w.catalogs.at(-1).badges.some((b) => b.id === 'founder' && b.label === 'Founder'));
  w.owner = [{ id: 'f1', user: IDS.member, kind: 'badge.grant', ref: 'founder' }];
  await dash.tick();
  assert.equal(w.result('f1').ok, false);
  assert.equal(w.result('f1').message, FOUNDER_ONLY);
  assert.equal(badgeGifts(h.engine, IDS.member).gift.includes('founder'), false);
  assert.equal(grantBadge(h.engine, IDS.member, 'founder'), null);
  assert.equal(badgeGifts(h.engine, IDS.member).gift.includes('founder'), false);
});

test('the owner can give the Founder badge to their own account and it shows first', async () => {
  const { h, w, dash } = await setup();
  grantBadge(h.engine, IDS.owner, 'einstein');
  w.owner = [{ id: 'o1', user: IDS.owner, kind: 'badge.grant', ref: 'founder' }];
  await dash.tick();
  assert.equal(w.result('o1').ok, true, w.result('o1').message);
  assert.ok(badgeGifts(h.engine, IDS.owner).gift.includes('founder'));
  assert.deepEqual(withGiftBadges(h.engine, IDS.owner, ['first-game']), ['founder', 'first-game', 'einstein']);
});

test('anyone else who somehow has the Founder badge never shows it', async () => {
  const { h, w, dash } = await setup();
  h.engine.store.update('badges', 'global', (d) => { d.gift = { [IDS.member]: ['founder', 'vip'] }; d.hide = {}; return d; }, {});
  w.stats = { [IDS.member2]: { games: 1, wins: 0, badges: ['first-game', 'founder'] } };
  assert.deepEqual(withGiftBadges(h.engine, IDS.member, []), ['vip']);
  const stats = await dash.partyStats([IDS.member2]);
  assert.deepEqual(stats[IDS.member2].badges, ['first-game']);
});

test('a custom badge can never be called Founder', () => {
  for (const name of ['Founder', 'founder', ' FOUNDER ', 'Found-er!']) assert.equal(isFounderName(name), true, name);
  assert.equal(isFounderName('Clan founder'), false);
  const list = cleanCustomBadges([{ id: 'c-aaaaaaaa', label: 'Founder' }, { id: 'c-bbbbbbbb', label: 'Shizu' }]);
  assert.deepEqual(list.map((b) => b.id), ['c-bbbbbbbb']);
});

test('a custom badge with a look-alike of Founder never reaches anyone', () => {
  const fakes = ['F0under', 'Fоunder', 'Ｆｏｕｎｄｅｒ', '\u{1D405}\u{1D428}\u{1D42E}\u{1D427}\u{1D41D}\u{1D41E}\u{1D42B}', 'Fóunder', 'Foun​der', 'ꜰᴏᴜɴᴅᴇʀ', 'The Founder', 'Founders', 'Fooounder', 'FOUNDΕR', 'F0UND3R'];
  for (const name of fakes) assert.equal(isFounderName(name), true, name);
  for (const name of ['Clan founder', 'Co-founder', 'Foundry', 'Sounder', 'Fund']) assert.equal(isFounderName(name), false, name);
  const list = cleanCustomBadges(fakes.map((label, i) => ({ id: `c-fake${String(i).padStart(4, '0')}`, label })).concat({ id: 'c-realbdge', label: 'Builder' }));
  assert.deepEqual(list.map((b) => b.id), ['c-realbdge']);
});
