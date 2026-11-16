import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import { Clock, Hub, person, seeded } from './activity-kit.test.js';
import { createEngine } from '../web/activity/js/engine.js';
import { resultsBody } from '../web/activity/js/admin.js';
import { skillsOf, PERFECT_MIN } from '../web/activity/js/games/trivia.js';
import { cleanSkills } from '../worker/party-results.js';
import { PARTY_BADGES, applySkills, badgesFor, partySeasonBadgeId, partySeasonBadges, seasonBadgeInfo, SKILL_DAILY_CAPS, SKILL_GAME_CAPS } from '../worker/party-badges.js';
import { awardMonth, monthInfo, parseLeaderboardQuery, MONTH_GRACE } from '../worker/party-leaderboard.js';
import { readCatalog } from '../worker/owner.js';
import { buildCard } from '../worker/party-profile.js';
import { cleanup } from '../worker/cron.js';
import { BADGES, badgeInfo, seasonBadge } from '../web/js/community-data.js';

const uid = (i) => `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`;
const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;

function party() {
  return createHarness({ PARTY_OWNER_ID: USERS.alice.id });
}

function p(i, score, won = false) {
  return { id: uid(i), name: `Player ${i}`, username: `player${i}`, score, won, team: null };
}

function body(h, players, over = {}) {
  return { game: 'trivia', at: h.clock.t, players, extra: {}, ...over };
}

async function send(h, b, ip = '198.51.100.40') {
  const res = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: b, ip });
  advance(h, 3 * MIN);
  return res;
}

const counters = (h, id) => JSON.parse(h.db.raw.prepare('SELECT counters FROM party_stats WHERE user_id = ?').get(id).counters);
const monthRow = (h, id, month) => h.db.raw.prepare('SELECT * FROM party_points_month WHERE user_id = ? AND month = ?').get(id, month);

test('every new skill badge has its own emoji, label and hint, and shows on the site', () => {
  for (const id of ['streak-3', 'streak-5', 'steals-10', 'perfect-trivia', 'comeback', 'lightning-25']) {
    const b = PARTY_BADGES.find((x) => x.id === id);
    assert.ok(b && b.label && b.emoji && b.hint, id);
    assert.equal(BADGES[id].emoji, b.emoji, id);
    assert.equal(badgeInfo(id).emoji, b.emoji);
  }
  assert.equal(new Set(PARTY_BADGES.map((b) => b.emoji)).size, PARTY_BADGES.length);
});

test('skill payloads are checked: right game, right shape, tight caps', () => {
  const players = [{ ...p(1, 900, true) }, { ...p(2, 400) }];
  const ok = cleanSkills({ questions: 10, skills: { [uid(1)]: { s: 99, l: 3, p: 1, c: 1 }, [uid(2)]: { p: 1, c: 1 }, [uid(9)]: { s: 4 } } }, 'trivia', players);
  assert.deepEqual(ok[uid(1)], { s: SKILL_GAME_CAPS.s, l: 3, p: 1, c: 1 });
  assert.deepEqual(ok[uid(2)], { p: 1 });
  assert.equal(ok[uid(9)], undefined);
  const short = cleanSkills({ questions: 5, skills: { [uid(1)]: { p: 1 } } }, 'trivia', players);
  assert.deepEqual(short, {});
  const other = cleanSkills({ skills: { [uid(1)]: { s: 3, l: 2, c: 1 } } }, 'draw', players);
  assert.deepEqual(other, { [uid(1)]: { c: 1 } });
  for (const bad of [{ skills: [] }, { skills: { [uid(1)]: { s: -1 } } }, { skills: { [uid(1)]: { s: 1.5 } } }, { skills: { [uid(1)]: { s: '3' } } }, { skills: { [uid(1)]: 5 } }, { questions: 'ten', skills: {} }]) {
    assert.throws(() => cleanSkills(bad, 'trivia', players), /extra game info/);
  }
});

test('win streaks grow with wins, a loss resets the current one, and the best is kept', () => {
  let c = {};
  for (let i = 0; i < 3; i += 1) c = applySkills(c, { won: true, day: '2026-11-12' });
  assert.equal(c.winStreak, 3);
  assert.equal(c.bestWinStreak, 3);
  assert.ok(badgesFor({ counters: c }).includes('streak-3'));
  assert.ok(!badgesFor({ counters: c }).includes('streak-5'));
  c = applySkills(c, { won: false, day: '2026-11-12' });
  assert.equal(c.winStreak, 0);
  assert.equal(c.bestWinStreak, 3);
  c = applySkills(c, { won: true, day: '2026-11-12' });
  assert.equal(c.winStreak, 1);
  assert.ok(badgesFor({ counters: c }).includes('streak-3'));
});

test('skill counters stop at the daily caps and start again the next UTC day', () => {
  let c = {};
  for (let i = 0; i < 5; i += 1) c = applySkills(c, { won: false, skill: { s: 20, p: 1 }, day: '2026-11-12' });
  assert.equal(c.steals, SKILL_DAILY_CAPS.s);
  assert.equal(c.perfect, SKILL_DAILY_CAPS.p);
  c = applySkills(c, { won: false, skill: { s: 5 }, day: '2026-11-13' });
  assert.equal(c.steals, SKILL_DAILY_CAPS.s + 5);
  let g = {};
  for (let i = 0; i < SKILL_DAILY_CAPS.g + 5; i += 1) g = applySkills(g, { won: true, day: '2026-11-12' });
  assert.equal(g.winStreak, SKILL_DAILY_CAPS.g);
});

test('posted results build streaks and skill counters, and the badges show up for the bot', async () => {
  const h = party();
  for (let i = 0; i < 3; i += 1) {
    const b = body(h, [p(1, 900 + i, true), p(2, 100 + i)], { extra: { questions: 10, skills: { [uid(1)]: { s: 4, l: 5, p: 1 }, [uid(2)]: { c: 1 } } } });
    assert.equal((await send(h, b, `198.51.100.${50 + i}`)).status, 201);
  }
  const a = counters(h, uid(1));
  assert.equal(a.winStreak, 3);
  assert.equal(a.steals, 12);
  assert.equal(a.lightning, 15);
  assert.equal(a.perfect, 3);
  assert.equal(counters(h, uid(2)).comeback, undefined, 'a comeback needs a win');
  const twice = body(h, [p(1, 77, true), p(2, 7)], { extra: { skills: { [uid(1)]: { s: 4 } } } });
  assert.equal((await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: twice, ip: '198.51.100.58' })).status, 201);
  const dup = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body: twice, ip: '198.51.100.59' });
  assert.equal((await dup.json()).duplicate, true);
  assert.equal(counters(h, uid(1)).steals, 16);
  assert.equal(counters(h, uid(1)).winStreak, 4);
  advance(h, 3 * MIN);
  assert.equal((await send(h, body(h, [p(1, 5), p(2, 50, true)], { extra: { skills: { [uid(1)]: { s: 'x' } } } }))).status, 400);
  await send(h, body(h, [p(1, 5), p(2, 50, true)]));
  assert.equal(counters(h, uid(1)).winStreak, 0);
  const res = await h.bot('GET', `/bot/party/stats?ids=${uid(1)}`);
  const badges = (await res.json()).stats[uid(1)].badges;
  for (const id of ['streak-3', 'steals-10', 'perfect-trivia']) assert.ok(badges.includes(id), id);
  assert.equal(counters(h, uid(1)).bestWinStreak, 4);
  assert.ok(!badges.includes('lightning-25'));
});

test('trivia reports steals, lightning answers and perfect games from its fun state', () => {
  const fx = { s: { 0: 2 }, b: { 1: 4 }, r: { 0: 10, 1: 9 } };
  assert.deepEqual(skillsOf(fx, 10), { 0: { s: 2, p: 1 }, 1: { l: 4 } });
  assert.deepEqual(skillsOf({ s: {}, b: {}, r: { 0: 5 } }, 5), {});
  assert.equal(PERFECT_MIN, 8);
});

function stubGame() {
  return {
    id: 'trivia',
    name: 'Stub',
    emoji: '🧪',
    category: 'quiz',
    blurb: 'Stub game',
    minPlayers: 1,
    keys: ['stub'],
    settings: [],
    start(api) {
      api.put('stub', { on: 1 });
      api.round(1, 4);
      api.addPoints(0, 300);
      api.addPoints(1, 200);
      api.round(2, 4);
      api.round(3, 4);
      api.addPoints(2, 900);
    },
    intent() {},
    deadline(api) {
      api.finish();
    },
    resume() {},
    model() {
      return null;
    },
    results() {
      return { skills: { 0: { s: 3, l: 99 }, 7: { s: 1 } }, questions: 12 };
    },
  };
}

test('the host posts skill stats and spots a comeback from last at halfway', async () => {
  const posts = [];
  const clock = new Clock();
  const hub = new Hub(clock);
  const engines = [];
  for (let i = 1; i <= 3; i += 1) {
    const e = createEngine({ transport: hub.join(person(i)), games: [stubGame()], now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: seeded(3), postResults: (b) => posts.push(b) });
    e.join();
    engines.push(e);
  }
  await clock.advance(500);
  assert.equal(engines[0].lobby.start().ok, true);
  await clock.advance(300);
  assert.equal(engines[0].lobby.end(), true);
  await clock.advance(300);
  assert.equal(posts.length, 1);
  const extra = posts[0].extra;
  assert.deepEqual(extra.skills[person(1).id], { s: 3, l: 10 });
  assert.deepEqual(extra.skills[person(3).id], { c: 1 });
  assert.equal(extra.questions, 12);
  const sent = resultsBody(posts[0]);
  assert.deepEqual(sent.extra.skills, extra.skills);
  assert.equal(sent.extra.questions, 12);
});

test('monthly points follow the same caps and the month tab shows days left and prizes', async () => {
  const h = party();
  await send(h, body(h, [p(1, 900, true), p(2, 400)]));
  await send(h, body(h, [p(1, 100), p(2, 700, true)], { game: 'draw' }));
  const month = new Date(h.clock.t).toISOString().slice(0, 7);
  assert.equal(monthRow(h, uid(1), month).points, 1000);
  assert.equal(monthRow(h, uid(2), month).wins, 1);
  const res = await h.request('GET', `/api/activity/leaderboard?period=month&me=${uid(2)}`, { ip: '198.51.100.60' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.period, 'month');
  assert.equal(data.month.month, month);
  assert.equal(data.month.prizes, 3);
  assert.equal(data.month.daysLeft, 19);
  assert.deepEqual(data.rows.map((r) => r.id), [uid(2), uid(1)]);
  assert.equal(data.rows[0].value, 1100);
  assert.deepEqual(data.me, { rank: 1, value: 1100 });
  assert.equal((await h.request('GET', '/api/activity/leaderboard?period=month&game=draw', { ip: '198.51.100.61' })).status, 400);
  assert.equal((await h.request('GET', '/api/activity/leaderboard?period=year', { ip: '198.51.100.62' })).status, 400);
  assert.equal(parseLeaderboardQuery(new URL('https://x.test/?board=wins')).period, 'all');
  assert.equal(monthInfo(Date.UTC(2026, 10, 30, 12)).daysLeft, 1);
});

test('at month rollover the top 3 get a badge once, banned players are skipped', async () => {
  const h = party();
  for (let i = 1; i <= 5; i += 1) await send(h, body(h, [p(i, 1000 * i, true), p(10 + i, 10)]), `198.51.100.${70 + i}`);
  h.db.raw.prepare("INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, 'X', NULL, NULL, ?, 1)").run(uid(4), USERS.alice.id);
  assert.equal((await awardMonth(h.db, h.clock.t)).awarded, 0);
  assert.deepEqual(await awardMonth(h.db, Date.UTC(2026, 10, 1, 0, 1)), { month: null, awarded: 0 });
  const rollover = Date.UTC(2026, 11, 1);
  assert.equal((await awardMonth(h.db, rollover + MONTH_GRACE - 1)).awarded, 0);
  const first = await awardMonth(h.db, rollover + MONTH_GRACE);
  assert.deepEqual(first, { month: '2026-11', awarded: 3 });
  const rows = h.db.raw.prepare('SELECT rank, user_id FROM party_season_awards ORDER BY rank').all();
  assert.deepEqual(rows.map((r) => r.user_id), [uid(5), uid(3), uid(2)]);
  assert.equal((await awardMonth(h.db, rollover + DAY_MS)).awarded, 0);
  const removed = await cleanup(h.db, rollover + 2 * DAY_MS);
  assert.equal(removed.partySeasonAwards, 0);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_season_awards').get().n, 3);
  assert.deepEqual(await partySeasonBadges(h.db, uid(5)), ['season-party-1-2026-11']);
  assert.deepEqual(await partySeasonBadges(h.db, uid(4)), []);
  const catalog = await readCatalog(h.db);
  const gold = catalog.badges.find((b) => b.id === 'season-party-1-2026-11');
  assert.equal(gold.emoji, '🥇');
  assert.equal(gold.source, 'season');
  for (const b of PARTY_BADGES) assert.ok(catalog.badges.some((x) => x.id === b.id), b.id);
  const card = await buildCard(h.db, uid(3));
  assert.deepEqual(card.badges.find((b) => b.id === 'season-party-2-2026-11'), { id: 'season-party-2-2026-11', label: '#2 Party · November 2026', emoji: '🥈' });
});

test('party season badge ids read nicely everywhere', () => {
  assert.equal(partySeasonBadgeId(3, '2026-11'), 'season-party-3-2026-11');
  assert.deepEqual(seasonBadgeInfo('season-party-1-2026-11'), { id: 'season-party-1-2026-11', label: '#1 Party · November 2026', emoji: '🥇' });
  assert.equal(seasonBadgeInfo('season-party-1-2026-13'), null);
  assert.deepEqual(seasonBadge('season-party-3-2026-11'), { label: '#3 Party · November 2026', emoji: '🥉' });
  assert.deepEqual(seasonBadge('season-xp-1-2026-10'), { label: '#1 XP · October 2026', emoji: '🥇' });
  assert.equal(badgeInfo('season-party-2-2026-11').label, '#2 Party · November 2026');
});
