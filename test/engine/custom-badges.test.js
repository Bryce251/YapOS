import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { createDashboard } from '../../engine/dashboard.js';
import { customBadges, customBadgeInfo, customBadgeVersion, setCustomBadges, grantBadge, withGiftBadges, badgeGifts, isCustomBadge } from '../../engine/global.js';
import { partyBadgeName, partyText } from '../../apps/levels.js';
import { badgeNames, badgeNotes, cardView, embedView } from '../../apps/profile.js';

const SECRET = 'test-secret-value-for-custom-badges';
const BRAIN = { id: 'c-brain123', label: 'Galaxy brain', emoji: '\u{1F30C}', note: 'Only from Jolli' };

function fakeWorker() {
  const w = { owner: [], results: [], catalogs: [], polls: [], custom: { version: 'v1', badges: [BRAIN] } };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.headers?.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'unauthorized' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'GET' && u.pathname === '/bot/poll') {
      const known = u.searchParams.get('badges');
      w.polls.push(known);
      const out = { jobs: [], hot: false, owner: w.owner.slice(0, 50) };
      if (known !== null && known !== w.custom.version) out.customBadges = w.custom;
      return reply(200, out);
    }
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
    if (init.method === 'GET' && u.pathname.startsWith('/bot/users/')) return reply(200, { id: u.pathname.split('/').pop() });
    return reply(200, { ok: true });
  };
  w.result = (id) => w.results.filter((r) => r.id === id).at(-1) || null;
  return w;
}

async function setup() {
  const h = await createHarness({ apps: ['levels', 'economy', 'achievements', 'profile'], fakeClock: true });
  const w = fakeWorker();
  const dash = createDashboard({ engine: h.engine, url: 'https://dash.example.test', secret: SECRET, fetch: w.fetch, now: h.now });
  h.engine.dashboard = dash;
  return { h, w, dash };
}

test('the bot asks for custom badges with its version and only stores a fresh list', async () => {
  const { h, w, dash } = await setup();
  setCustomBadges(h.engine, [], '');
  await dash.tick();
  assert.equal(w.polls[0], '', 'a bot with no list asks with an empty version');
  assert.equal(customBadgeVersion(h.engine), 'v1');
  assert.deepEqual(customBadges(h.engine), [BRAIN]);
  assert.deepEqual(customBadgeInfo(BRAIN.id), BRAIN);
  await dash.tick();
  assert.equal(w.polls[1], 'v1');
  assert.ok(isCustomBadge('c-brain123'));
  assert.equal(isCustomBadge('supporter'), false);
  const cleaned = setCustomBadges(h.engine, [{ id: 'C-BAD', label: 'x' }, { id: 'c-ok000001', label: '  <b>Hi</b>  ', emoji: '' }, { id: 'c-ok000002' }], 'v9');
  assert.deepEqual(cleaned.badges, [{ id: 'c-ok000001', label: '<b>Hi</b>', emoji: '\u{1F3C5}' }]);
});

test('custom badges are given and taken through owner actions, shown in bot text, and vanish when deleted', async () => {
  const { h, w, dash } = await setup();
  setCustomBadges(h.engine, [], '');
  w.owner = [{ id: 'cb1', user: IDS.member, kind: 'badge.grant', ref: BRAIN.id }];
  await dash.tick();
  assert.equal(w.result('cb1').ok, true, w.result('cb1').message);
  assert.match(w.result('cb1').message, /Gave the \u{1F30C} Galaxy brain badge/u);
  assert.deepEqual(w.result('cb1').after.badges, [BRAIN.id]);
  assert.ok(badgeGifts(h.engine, IDS.member).gift.includes(BRAIN.id));
  assert.ok(!w.catalogs.some((c) => c.badges.some((b) => b.id === BRAIN.id)), 'custom badges are never sent back in the bot catalog');

  assert.equal(partyBadgeName(BRAIN.id), '\u{1F30C} Galaxy brain');
  assert.deepEqual(badgeNames([BRAIN.id, 'first-game']), ['\u{1F30C} Galaxy brain', '\u{1F388} First game']);
  assert.deepEqual(badgeNotes([BRAIN.id]), ['\u{1F30C} Galaxy brain: Only from Jolli']);
  assert.match(partyText({ games: 2, wins: 1, badges: [BRAIN.id] }), /Galaxy brain/);
  const data = { id: IDS.member, level: { xp: 10, level: 1, into: 10, need: 100, frac: 0.1 }, shards: 0, privacy: { hidden: false, showShards: false }, party: { games: 1, wins: 0, fav: null, badges: [BRAIN.id] }, season: [], quests: null, clan: null, achievements: [] };
  const view = cardView(data, { name: 'Sam', username: 'sam', viewerIsOwner: true });
  assert.match(view.footer, /Galaxy brain/);
  const embed = JSON.stringify(embedView(data, view));
  assert.match(embed, /Galaxy brain/);
  assert.match(embed, /Only from Jolli/);

  w.owner = [{ id: 'cb2', user: IDS.member, kind: 'badge.grant', ref: 'c-unknown1' }];
  await dash.tick();
  assert.equal(w.result('cb2').ok, false);
  assert.match(w.result('cb2').message, /deleted|reached/);

  w.custom = { version: 'v2', badges: [] };
  await dash.tick();
  assert.deepEqual(customBadges(h.engine), []);
  assert.equal(badgeGifts(h.engine, IDS.member).gift.includes(BRAIN.id), false, 'a deleted badge is taken off everyone who had it');
  assert.equal(partyBadgeName(BRAIN.id), null);
  assert.deepEqual(badgeNames([BRAIN.id]), []);
  grantBadge(h.engine, IDS.member2, BRAIN.id);
  assert.deepEqual(withGiftBadges(h.engine, IDS.member2, []), [], 'an unknown custom badge is never shown');

  w.owner = [{ id: 'cb3', user: IDS.member, kind: 'badge.revoke', ref: BRAIN.id }];
  await dash.tick();
  assert.equal(w.result('cb3').ok, true);
  assert.match(w.result('cb3').message, /deleted/);
});
