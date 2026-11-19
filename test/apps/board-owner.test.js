import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { levelFor, boardRanked } from '../../apps/levels.js';
import { richList } from '../../apps/economy.js';
import { hiddenFromBoards, onBoards, BOARD_HIDDEN_TEXT, addSeason, seasonBadges, seasonBoard, SEASON_NS, GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const seedLevels = (h, users) => h.engine.store.set('levels', 'global', { users: Object.fromEntries(Object.entries(users).map(([id, u]) => [id, { xp: 0, level: levelFor(u.xp || 0), voiceSeconds: 0, messages: 0, lastXpAt: 0, ...u }])) });
const far = (n) => `f0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

test('the bot owner is matched by id, any case, and only by id', async () => {
  const h = await createHarness({ apps: ['levels'] });
  assert.equal(hiddenFromBoards(h.engine, IDS.owner), true);
  assert.equal(hiddenFromBoards(h.engine, IDS.owner.toUpperCase()), true);
  assert.equal(hiddenFromBoards(h.engine, IDS.member), false);
  assert.equal(hiddenFromBoards(h.engine, ''), false);
  assert.equal(hiddenFromBoards({}, IDS.owner), false);
  assert.deepEqual(onBoards(h.engine, [{ id: IDS.owner }, { id: IDS.member }]).map((x) => x.id), [IDS.member]);
  assert.equal(BOARD_HIDDEN_TEXT, 'Hidden from leaderboards');
});

test('/leaderboard leaves the owner out, others move up, and the owner sees Hidden', async () => {
  const h = await createHarness({ apps: ['levels'] });
  seedLevels(h, { [IDS.owner]: { xp: 90000, voiceSeconds: 9000 }, [IDS.member]: { xp: 5000, voiceSeconds: 60 }, [IDS.member2]: { xp: 400 } });
  assert.deepEqual(boardRanked(h.engine).map((u) => u.id), [IDS.member, IDS.member2]);
  const sam = lastText(h, await h.slash('leaderboard', '', { user: IDS.member }));
  assert.match(sam, /🥇 \*\*Sam\*\* · Level \d+ · 5,000 XP  ◂ you/);
  assert.match(sam, /🥈 \*\*Riley\*\*/);
  assert.doesNotMatch(sam, /Jolli/);
  assert.match(sam, /2 ranked/);
  const mine = lastText(h, await h.slash('leaderboard', '', { user: IDS.owner }));
  assert.doesNotMatch(mine, /Jolli/);
  assert.match(mine, /You: Hidden from leaderboards/);
  const voice = lastText(h, await h.slash('leaderboard', 'voice', { user: IDS.member }));
  assert.match(voice, /🥇 \*\*Sam\*\*/);
  assert.doesNotMatch(voice, /Jolli/);
  const rank = lastText(h, await h.slash('rank', '', { user: IDS.owner }));
  assert.match(rank, /Hidden from leaderboards/);
  assert.match(rank, /90,000/, 'the owner keeps their XP');
  const svc = h.engine.service('levels');
  assert.ok(svc.ranked().some((u) => u.id === IDS.owner), 'the levels service still knows the owner for clans and profiles');
});

test('the season board hides the owner and month end gives the owner no top 10 slot', async () => {
  const h = await createHarness({ apps: ['levels', 'economy'], fakeClock: true });
  addSeason(h.engine, 'xp', IDS.owner, 999);
  addSeason(h.engine, 'xp', IDS.member, 50);
  addSeason(h.engine, 'xp', IDS.member2, 20);
  const text = lastText(h, await h.slash('leaderboard', 'season', { user: IDS.owner }));
  assert.match(text, /🥇 \*\*Sam\*\*/);
  assert.doesNotMatch(text, /Jolli/);
  assert.match(text, /You: Hidden from leaderboards/);
  assert.ok(seasonBoard(h.engine, 'xp').list.some((x) => x.id === IDS.owner), 'the stored season keeps the owner score');
  h.engine.store.update(SEASON_NS, GLOBAL_KEY, (d) => {
    d.badges[IDS.owner] = [{ month: '2026-10', kind: 'xp', rank: 1, score: 5 }];
  }, {});
  await h.advanceTo('2026-12-01T00:00:30Z');
  assert.deepEqual(seasonBadges(h.engine, IDS.member).map((b) => [b.month, b.rank]), [['2026-11', 1]]);
  assert.deepEqual(seasonBadges(h.engine, IDS.member2).map((b) => [b.month, b.rank]), [['2026-11', 2]]);
  assert.deepEqual(seasonBadges(h.engine, IDS.owner).map((b) => b.month), ['2026-10'], 'old prizes are kept');
});

test('the rich list and Shards season leave the owner out but keep their wallet', async () => {
  const h = await createHarness({ apps: ['economy'], fakeClock: true });
  const eco = h.engine.service('economy');
  eco.add(S, IDS.owner, 50000, 'x');
  eco.add(S, IDS.member, 300, 'x');
  eco.add(S, IDS.member2, 900, 'x');
  eco.add(S, far(1), 100, 'x');
  assert.deepEqual(richList(h.engine).map((x) => x.id), [IDS.member2, IDS.member, far(1)]);
  const top = lastText(h, await h.slash('balance', 'top', { user: IDS.member }));
  assert.match(top, /🥇 Riley · 900 💎/);
  assert.match(top, /🥈 Sam · 300 💎/);
  assert.doesNotMatch(top, /Jolli|50,000/);
  assert.match(top, /You: \*\*#2\*\* of 3/);
  const own = lastText(h, await h.slash('balance', 'top', { user: IDS.owner }));
  assert.match(own, /You: Hidden from leaderboards/);
  const wallet = lastText(h, await h.slash('balance', '', { user: IDS.owner }));
  assert.match(wallet, /Hidden from leaderboards/);
  assert.match(wallet, /50,000/);
  assert.equal(eco.balance(S, IDS.owner), 50000);
  addSeason(h.engine, 'shards', IDS.owner, 5000);
  addSeason(h.engine, 'shards', IDS.member, 10);
  const season = lastText(h, await h.clickButton('This season', { user: IDS.owner, in: await h.slash('balance', 'top', { user: IDS.owner }) }));
  assert.match(season, /🥇 Sam · 10/);
  assert.doesNotMatch(season, /5,000/);
  assert.match(season, /You: Hidden from leaderboards/);
});

test('the casino board leaves the owner out', async () => {
  const h = await createHarness({ apps: ['casino'] });
  h.engine.settings.setEnabled(S, 'casino', true);
  h.engine.store.set('casino', S, { open: {}, stats: { [IDS.owner]: { n: 5, wagered: 10, returned: 9000, best: 8000 }, [IDS.member]: { n: 2, wagered: 100, returned: 150, best: 90 } }, totals: { n: 7, wagered: 110, returned: 9150 } });
  const text = lastText(h, await h.slash('casino', 'top', { user: IDS.member }));
  assert.match(text, /🥇 <@a0000000-0000-4000-8000-000000000004>/);
  assert.doesNotMatch(text, new RegExp(IDS.owner));
  const big = lastText(h, await h.slash('casino', 'top biggest', { user: IDS.member }));
  assert.doesNotMatch(big, new RegExp(IDS.owner));
});
