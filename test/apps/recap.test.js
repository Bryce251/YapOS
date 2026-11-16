import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { parseDay, partyDeltas, topActive, recapTick } from '../../apps/recap.js';

const S = IDS.server;
const G = IDS.channels.general;
const NEWS = IDS.channels.news;
const START = Date.parse('2026-11-15T12:00:00Z');

async function make(opts = {}) {
  const h = await createHarness({ apps: ['levels', 'recap'], fakeClock: true, ...opts });
  h.clock.t = START;
  return h;
}

const recapPosts = (h) => h.sent(NEWS).filter((m) => /Weekly recap/.test(h.textOf(m)));
const allText = (h, ans) => [...ans, ...h.sent(G)].map((a) => h.textOf(a)).join('\n');

function stubParty(h, table) {
  h.engine.dashboard = {
    enabled: true, running: false, reportsOpen: 0, start() {}, stop() {},
    partyStats: async (ids) => Object.fromEntries(ids.filter((id) => table[id]).map((id) => [id, { ...table[id], byGame: {}, badges: [], fav: null }])),
  };
}

test('recap: days and rankings parse right', () => {
  assert.equal(parseDay('friday'), 5);
  assert.equal(parseDay('Fri'), 5);
  assert.equal(parseDay('thurs'), 4);
  assert.equal(parseDay('sundays'), 0);
  assert.equal(parseDay('fr'), null);
  assert.equal(parseDay('#general'), null);
  assert.deepEqual(topActive({ a: { n: 3 }, b: { n: 9 }, c: { n: 0 } }), [{ id: 'b', n: 9 }, { id: 'a', n: 3 }]);
  assert.deepEqual(partyDeltas({ a: { games: 2, wins: 1 }, b: { games: 5, wins: 0 } }, { a: { games: 6, wins: 4 }, b: { games: 7, wins: 0 }, c: { games: 3, wins: 3 } }), [
    { id: 'a', games: 4, wins: 3 },
    { id: 'b', games: 2, wins: 0 },
  ]);
});

test('recap: it is off by default and only admins can set it up', async () => {
  const h = await make();
  assert.equal(h.engine.settings.appConfig(S, 'recap').channelId, null);
  assert.equal(h.engine.scheduler.list({ kind: 'recap.post' }).length, 0);
  const ans = await h.slash('recap', '#announcements friday', { user: IDS.member });
  assert.match(allText(h, ans), /Needs Admin|Only admins/);
  assert.equal(h.engine.scheduler.list({ kind: 'recap.post' }).length, 0);
});

test('recap: /recap #channel day schedules a weekly post and /recap off stops it', async () => {
  const h = await make();
  const ans = await h.slash('recap', '#announcements friday', { user: IDS.admin });
  assert.match(allText(h, ans), /Weekly recap is on/);
  assert.match(allText(h, ans), /Friday at 18:00 UTC/);
  const [job] = h.engine.scheduler.list({ kind: 'recap.post', serverId: S });
  assert.ok(job);
  const at = new Date(job.at);
  assert.equal(at.getUTCDay(), 5);
  assert.equal(at.getUTCHours(), 18);
  assert.equal(h.engine.settings.appConfig(S, 'recap').channelId, NEWS);
  await h.slash('recap', 'day monday', { user: IDS.admin });
  assert.equal(new Date(h.engine.scheduler.list({ kind: 'recap.post', serverId: S })[0].at).getUTCDay(), 1);
  const off = await h.slash('recap', 'off', { user: IDS.admin });
  assert.match(allText(h, off), /Weekly recap is off/);
  assert.equal(h.engine.scheduler.list({ kind: 'recap.post', serverId: S }).length, 0);
  const bad = await h.slash('recap', 'nowhere-channel', { user: IDS.admin });
  assert.match(allText(h, bad), /couldn't find that channel/);
});

test('recap: the weekly post shows the most active, new members and level-ups, then starts a new week', async () => {
  const h = await make();
  await h.slash('recap', '#announcements friday', { user: IDS.admin });
  for (let i = 0; i < 4; i++) await h.message(`hello ${i}`, { user: IDS.member });
  await h.message('hey', { user: IDS.member2 });
  await h.join('a0000000-0000-4000-8000-0000000000aa', { username: 'newbie' });
  h.engine.service('levels').addXp(S, IDS.member, 2000, 'test');
  const preview = await h.slash('recap', 'preview', { user: IDS.admin });
  assert.match(allText(h, preview), /Preview/);
  assert.equal(recapPosts(h).length, 0, 'a preview is not posted');
  h.clock.t = Date.parse('2026-11-20T18:00:30Z');
  await h.runDue();
  const posts = recapPosts(h);
  assert.equal(posts.length, 1);
  const text = h.textOf(posts[0]);
  assert.match(text, /Weekly recap · Test Town/);
  assert.match(text, /Most active/);
  assert.match(text, /🥇 \*\*sam\*\* · 4 messages|🥇 \*\*Sam\*\* · 4 messages/);
  assert.match(text, /New members\n1/);
  assert.match(text, /Top level-ups/);
  assert.match(text, /level 0 → \*\*\d+\*\*/);
  assert.doesNotMatch(text, /hello 0/, 'no message content');
  assert.doesNotMatch(text, /Party/, 'Party is left out without stats');
  assert.ok(!(posts[0].components || []).length);
  h.clock.t = Date.parse('2026-11-27T18:00:30Z');
  await h.runDue();
  assert.equal(recapPosts(h).length, 1, 'a quiet week is not posted');
});

test('recap: top Party players come from this week\'s Party stats', async () => {
  const h = await make();
  const table = { [IDS.member]: { games: 10, wins: 2 }, [IDS.member2]: { games: 4, wins: 1 } };
  stubParty(h, table);
  await h.slash('recap', '#announcements friday', { user: IDS.admin });
  await h.message('hi', { user: IDS.member });
  await h.message('hi', { user: IDS.member2 });
  h.clock.t += 20 * 60_000;
  await recapTick(h.engine);
  table[IDS.member] = { games: 15, wins: 5 };
  table[IDS.member2] = { games: 5, wins: 1 };
  h.clock.t = Date.parse('2026-11-20T18:00:30Z');
  await h.runDue();
  const [post] = recapPosts(h);
  assert.ok(post);
  const text = h.textOf(post);
  assert.match(text, /Top YapOS Party players/);
  assert.match(text, /sam\*\* · 3 wins in 5 games/i);
  assert.match(text, /riley\*\* · 0 wins in 1 game/i);
});

test('recap: the server stats counter runs while the app is loaded', async () => {
  const h = await make();
  await h.message('hi', { user: IDS.member });
  assert.ok(h.engine.serverStats);
  assert.equal(h.engine.serverStats.totals(S, 0).messages, 1);
});
