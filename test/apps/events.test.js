import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, IDS } from '../harness.js';
import { eventLimits, boostName, EVENT_DEFAULTS } from '../../apps/economy.js';
import { boostXp } from '../../apps/levels.js';
import { GLOBAL_KEY } from '../../engine/global.js';

const S = IDS.server;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const make = () => createHarness({ apps: ['economy', 'levels'], fakeClock: true });
const lastText = (h, ans) => h.textOf(ans[ans.length - 1]);
const eco = (h) => h.engine.service('economy');
const xpOf = (h, uid) => h.engine.service('levels').getUser(null, uid).xp;

test('event limits default to 2x, 48 hours and 30 days, and clamp bad values', () => {
  assert.deepEqual(eventLimits({}), { ...EVENT_DEFAULTS });
  assert.deepEqual(EVENT_DEFAULTS, { mult: 2, hours: 48, cooldownDays: 30 });
  assert.deepEqual(eventLimits({ eventLimits: { mult: 99, hours: 9999, cooldownDays: -4 } }), { mult: 5, hours: 168, cooldownDays: 0 });
  assert.equal(boostName('xp', 2), 'Double XP');
  assert.equal(boostName('shards', 3), 'Triple Shards');
  assert.equal(boostName('xp', 1.5), '1.5x XP');
});

test('only admins start events, and a Double XP event boosts chat XP in that server only', async () => {
  const h = await make();
  const denied = await h.slash('event', 'xp 24h', { user: IDS.member });
  assert.doesNotMatch(lastText(h, denied), /is on!/);
  assert.equal(eco(h).activeEvent(S), null);

  const started = await h.slash('event', 'xp 24h', { user: IDS.admin });
  assert.match(lastText(h, started), /Double XP is on!/);
  assert.match(lastText(h, started), /next \*\*1d\*\*/);
  assert.equal(eco(h).eventMultiplier(S, 'xp'), 2);
  assert.equal(eco(h).eventMultiplier(S, 'shards'), 1);
  assert.equal(eco(h).eventMultiplier('5e000000-0000-4000-8000-0000000000ff', 'xp'), 1, 'other servers are not boosted');
  assert.equal(boostXp(h.engine, S, IDS.member, 20), 40);
  assert.equal(boostXp(h.engine, null, IDS.member, 20), 20, 'XP with no server (like Party XP) is never boosted');

  await h.message('hello everyone, how are you', { user: IDS.member });
  const xp = xpOf(h, IDS.member);
  assert.ok(xp >= 30 && xp <= 50, `chat XP doubled (got ${xp})`);

  const rank = await h.slash('rank', '', { user: IDS.member });
  assert.match(lastText(h, rank), /Double XP\*\* is on in this server/);

  const status = await h.slash('event', '', { user: IDS.member });
  assert.match(lastText(h, status), /Server events/);
  assert.match(lastText(h, status), /Double XP/);
  assert.ok(!h.findButton('End event', status), 'members get no controls');
});

test('events end on their own and the banner goes away', async () => {
  const h = await make();
  await h.slash('event', 'shards 2h', { user: IDS.admin });
  assert.equal(eco(h).eventMultiplier(S, 'shards'), 2);
  await h.advance(2 * HOUR + 1000);
  assert.equal(eco(h).eventMultiplier(S, 'shards'), 1);
  assert.equal(eco(h).activeEvent(S), null);
  const daily = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, daily), /\+110 Shards/);
  assert.doesNotMatch(lastText(h, daily), /is on in this server/);
});

test('Double Shards doubles /daily and quests here but never casino winnings', async () => {
  const h = await make();
  await h.slash('event', 'shards 24h', { user: IDS.admin });
  const daily = await h.slash('daily', '', { user: IDS.member });
  assert.match(lastText(h, daily), /\+220 Shards/);
  assert.match(lastText(h, daily), /Double Shards\*\* is on in this server/);
  assert.match(lastText(h, daily), /Boosted ×2/);
  assert.equal(eco(h).balance(S, IDS.member), 220);

  eco(h).add(S, IDS.member2, 50, 'Daily quest: Send 30 messages');
  assert.equal(eco(h).balance(S, IDS.member2), 100, 'quest rewards earned in the server double');
  eco(h).add(S, IDS.member2, 50, 'Slots win');
  assert.equal(eco(h).balance(S, IDS.member2), 150, 'casino wins stay the same');
  eco(h).add(GLOBAL_KEY, IDS.member2, 10, 'YapOS Party');
  assert.equal(eco(h).balance(S, IDS.member2), 160, 'Shards with no server stay the same');
  eco(h).add(S, IDS.member2, 100, 'Game win');
  assert.equal(eco(h).balance(S, IDS.member2), 260, 'a pot of the players own bets is never doubled');
  eco(h).add(S, IDS.member2, 30, 'Trivia win');
  assert.equal(eco(h).balance(S, IDS.member2), 320, 'trivia prizes double');
});

test('one event at a time, a 30 day cooldown, and the owner sets the limits', async () => {
  const h = await make();
  const tooLong = await h.slash('event', 'xp 72h', { user: IDS.admin });
  assert.match(lastText(h, tooLong), /up to \*\*48 hours\*\*/);
  const tooBig = await h.slash('event', 'xp 24h 3x', { user: IDS.admin });
  assert.match(lastText(h, tooBig), /up to ×2/);
  assert.equal(eco(h).activeEvent(S), null);

  await h.slash('event', 'xp 24h', { user: IDS.admin });
  const second = await h.slash('event', 'shards 24h', { user: IDS.admin });
  assert.match(lastText(h, second), /already running/);

  const stop = await h.slash('event', 'stop', { user: IDS.admin });
  assert.match(lastText(h, stop), /Event ended/);
  assert.equal(eco(h).activeEvent(S), null);
  const again = await h.slash('event', 'shards 24h', { user: IDS.admin });
  assert.match(lastText(h, again), /one event every 30 days/);

  const adminLimits = await h.slash('economy', 'events 3 72 7', { user: IDS.admin });
  assert.match(lastText(h, adminLimits), /Only the bot owner/);
  const ownerLimits = await h.slash('economy', 'events 3 72 7', { user: IDS.owner });
  assert.match(lastText(h, ownerLimits), /Event limits saved/);
  assert.deepEqual(eventLimits(h.engine.settings.appConfig(GLOBAL_KEY, 'economy')), { mult: 3, hours: 72, cooldownDays: 7 });

  await h.advance(7 * DAY + HOUR);
  const triple = await h.slash('event', 'shards 72h 3x', { user: IDS.admin });
  assert.match(lastText(h, triple), /Triple Shards is on!/);
  assert.equal(eco(h).eventMultiplier(S, 'shards'), 3);

  await h.slash('economy', 'events 1', { user: IDS.owner });
  await h.advance(8 * DAY);
  const off = await h.slash('event', 'xp 1h', { user: IDS.admin });
  assert.match(lastText(h, off), /switched server events off/);
});

test('the event panel offers start buttons to admins and a form picks the length', async () => {
  const h = await make();
  const panel = await h.slash('event', '', { user: IDS.admin });
  const btn = h.findButton('Start Double XP', panel);
  assert.ok(btn, 'admins can start from the panel');
  const ans = await h.submit(btn.custom_id.replace(':evform:', ':evsave:'), { hours: '6h' }, { user: IDS.admin });
  assert.match(lastText(h, ans), /Double XP is on!/);
  assert.ok(eco(h).activeEvent(S).endsAt - h.clock.t <= 6 * HOUR);
});
