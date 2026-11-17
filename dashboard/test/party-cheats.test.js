import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS } from './helpers.js';
import '../worker/index.js';
import { CHEAT_CAP_DAYS, CHEAT_WIN_GAMES, CHEAT_PAIR_GAMES, CHEAT_FAST_GAMES, CHEAT_FAST_MS, CHEAT_REOPEN_MS, CHEAT_DAYS_KEEP, cheatsCleanupStatements } from '../worker/party-cheats.js';
import { DAILY_POINTS_CAP, DAILY_GAMES_CAP } from '../worker/party-leaderboard.js';
import { utcDay } from '../worker/party-results.js';

const OWNER = USERS.alice;
const BOB = USERS.bob;
const ADMIN = { id: '66666666-6666-4666-8666-666666666666', username: 'mod', display_name: 'Mod Person', avatar_url: '' };
const uid = (i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
const XD = uid(1);
const PAL = uid(2);
const DAY = 86_400_000;
let ipSeq = 0;
let scoreSeq = 0;

function party() {
  const h = createHarness({ PARTY_OWNER_ID: OWNER.id });
  h.db.raw.prepare('INSERT INTO party_admins (id, added_by, added_at) VALUES (?, ?, ?)').run(ADMIN.id, OWNER.id, 1);
  return h;
}

function game(h, over = {}) {
  scoreSeq += 1;
  return {
    game: 'trivia',
    at: h.clock.t,
    players: [
      { id: XD, name: 'XD', username: 'xd', score: 900 + scoreSeq, won: true, team: null },
      { id: PAL, name: 'Pal', username: null, score: 100, won: false, team: null },
    ],
    extra: {},
    ...over,
  };
}

async function send(h, body) {
  ipSeq += 1;
  const res = await h.request('POST', '/api/activity/results', { headers: { Origin: h.base }, body, ip: `198.51.${Math.floor(ipSeq / 200) % 200}.${(ipSeq % 200) + 1}` });
  assert.ok(res.status === 201 || res.status === 200, `status ${res.status}`);
  return res.json();
}

const alerts = (h, id = XD) => h.db.raw.prepare('SELECT * FROM party_cheat_alerts WHERE user_id = ? ORDER BY kind ASC').all(id);
const alertOf = (h, kind, id = XD) => alerts(h, id).find((a) => a.kind === kind) || null;

function nearCap(h, id = XD) {
  const day = utcDay(h.clock.t);
  h.db.raw.prepare('INSERT INTO party_points_day (user_id, day, points) VALUES (?, ?, ?) ON CONFLICT (user_id, day) DO UPDATE SET points = excluded.points').run(id, day, DAILY_POINTS_CAP - 10);
}

test('hitting the daily points cap on 2 of 7 days raises one alert, once per day', async () => {
  const h = party();
  nearCap(h);
  await send(h, game(h));
  assert.equal(alertOf(h, 'daily_points'), null);
  advance(h, DAY);
  nearCap(h);
  await send(h, game(h));
  const a = alertOf(h, 'daily_points');
  assert.ok(a);
  assert.equal(CHEAT_CAP_DAYS, 2);
  assert.equal(a.detail, 'Hit the 100,000 daily points cap on 2 of the last 7 days');
  assert.equal(a.count, 1);
  assert.equal(a.status, 'open');
  assert.equal(a.name, 'XD');
  advance(h, 5 * 60_000);
  await send(h, game(h));
  await send(h, game(h, { at: h.clock.t - 1000 }));
  assert.equal(alertOf(h, 'daily_points').count, 1);
  advance(h, DAY);
  nearCap(h);
  await send(h, game(h));
  const b = alertOf(h, 'daily_points');
  assert.equal(b.count, 2);
  assert.equal(b.detail, 'Hit the 100,000 daily points cap on 3 of the last 7 days');
  assert.equal(alerts(h).filter((x) => x.kind === 'daily_points').length, 1);
  assert.equal(alertOf(h, 'daily_points', PAL), null);
});

test('one cap day a week is not enough, and old cap days fall out of the window', async () => {
  const h = party();
  nearCap(h);
  await send(h, game(h));
  advance(h, 8 * DAY);
  nearCap(h);
  await send(h, game(h));
  assert.equal(alertOf(h, 'daily_points'), null);
});

test('hitting the daily games cap on several days raises a games alert', async () => {
  const h = party();
  const seed = () => h.db.raw.prepare('INSERT INTO party_games_day (user_id, day, games) VALUES (?, ?, ?) ON CONFLICT (user_id, day) DO UPDATE SET games = excluded.games').run(XD, utcDay(h.clock.t), DAILY_GAMES_CAP - 1);
  seed();
  await send(h, game(h));
  advance(h, 2 * DAY);
  seed();
  await send(h, game(h));
  assert.equal(alertOf(h, 'daily_games').detail, `Hit the ${DAILY_GAMES_CAP} daily games cap on 2 of the last 7 days`);
});

test('a single score at the per-game cap is flagged with the evidence and counted', async () => {
  const h = party();
  const capped = game(h);
  capped.players[0].score = 50_000;
  await send(h, capped);
  const a = alertOf(h, 'game_cap');
  assert.equal(a.detail, '50,000 in one Trivia game = the cap');
  assert.equal(a.count, 1);
  const again = game(h, { game: 'chain' });
  again.players[0].score = 99_999;
  await send(h, again);
  const b = alertOf(h, 'game_cap');
  assert.equal(b.count, 2);
  assert.equal(b.detail, '99,999 in one Word Chain game = the cap');
  await send(h, game(h));
  assert.equal(alertOf(h, 'game_cap').count, 2);
});

test('an absurd win rate over enough games is flagged once and kept up to date', async () => {
  const h = party();
  h.db.raw.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, ?, ?, '{}', '{}', 1)").run(XD, CHEAT_WIN_GAMES - 2, CHEAT_WIN_GAMES - 2);
  await send(h, game(h));
  assert.equal(alertOf(h, 'win_rate'), null);
  await send(h, game(h));
  const a = alertOf(h, 'win_rate');
  assert.equal(a.detail, 'Won 20 of 20 Party games (100%)');
  await send(h, game(h));
  const b = alertOf(h, 'win_rate');
  assert.equal(b.count, 1);
  assert.equal(b.detail, 'Won 21 of 21 Party games (100%)');
  assert.equal(alertOf(h, 'win_rate', PAL), null);
});

test('farming the same second player and impossible timings are flagged', async () => {
  const h = party();
  for (let i = 0; i < CHEAT_PAIR_GAMES; i += 1) {
    advance(h, CHEAT_FAST_MS / 4);
    await send(h, game(h, { game: i % 2 ? 'chain' : 'trivia' }));
  }
  const farm = alertOf(h, 'farm');
  assert.equal(farm.detail, `Won ${CHEAT_PAIR_GAMES} of ${CHEAT_PAIR_GAMES} two-player games against the same person (Pal) today`);
  assert.equal(farm.count, 1);
  const fast = alertOf(h, 'fast');
  assert.ok(fast);
  assert.match(fast.detail, /two-player games with Pal finished under 20 seconds apart today/);
  assert.equal(fast.count, 1);
  assert.ok(CHEAT_PAIR_GAMES - 1 >= CHEAT_FAST_GAMES);
  assert.equal(alertOf(h, 'farm', PAL), null);
});

test('evenly matched friends playing at a normal pace are left alone', async () => {
  const h = party();
  for (let i = 0; i < CHEAT_PAIR_GAMES + 3; i += 1) {
    advance(h, 4 * 60_000);
    const g = game(h);
    g.players[0].won = i % 2 === 0;
    g.players[1].won = i % 2 === 1;
    await send(h, g);
  }
  assert.deepEqual(alerts(h).map((a) => a.kind), []);
  assert.deepEqual(alerts(h, PAL).map((a) => a.kind), []);
});

test('a second player with the same name is flagged on both people', async () => {
  const h = party();
  const g = game(h);
  g.players[1].name = 'xd';
  await send(h, g);
  assert.match(alertOf(h, 'same_name').detail, /same name/);
  assert.ok(alertOf(h, 'same_name', PAL));
});

test('banned players are never flagged', async () => {
  const h = party();
  h.db.raw.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, NULL, NULL, ?, 1)').run(XD, 'XD', OWNER.id);
  const capped = game(h);
  capped.players[0].score = 50_000;
  await send(h, capped);
  assert.equal(alertOf(h, 'game_cap'), null);
});

async function owner(h) {
  return {
    o: (await h.login(OWNER)).cookie,
    a: (await h.login(ADMIN)).cookie,
    b: (await h.login(BOB)).cookie,
  };
}

async function capAlert(h) {
  const capped = game(h);
  capped.players[0].score = 50_000;
  await send(h, capped);
  return alertOf(h, 'game_cap');
}

test('cheat alerts are owner-only', async () => {
  const h = party();
  const { a, b } = await owner(h);
  const alert = await capAlert(h);
  for (const cookie of [a, b, null]) {
    assert.equal((await h.api('GET', '/api/owner/cheats', cookie)).status, 404);
    assert.equal((await h.api('POST', `/api/owner/cheats/${alert.id}`, cookie, { do: 'dismiss' })).status, 404);
  }
  assert.equal(alertOf(h, 'game_cap').status, 'open');
});

test('the owner lists, dismisses, hides and resets from an alert', async () => {
  const h = party();
  const { o } = await owner(h);
  const alert = await capAlert(h);
  const list = await (await h.api('GET', '/api/owner/cheats', o)).json();
  assert.equal(list.open, 1);
  assert.equal(list.alerts.length, 1);
  assert.deepEqual({ user: list.alerts[0].user, detail: list.alerts[0].detail, label: list.alerts[0].label, status: list.alerts[0].status }, { user: XD, detail: '50,000 in one Trivia game = the cap', label: 'Score at the game cap', status: 'open' });
  assert.equal((await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'explode' })).status, 400);
  assert.equal((await h.api('POST', '/api/owner/cheats/nope', o, { do: 'dismiss' })).status, 404);
  assert.equal((await h.api('PUT', `/api/owner/cheats/${alert.id}`, o, { do: 'dismiss' })).status, 405);

  const hidden = await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'hide' });
  assert.equal(hidden.status, 200);
  const hb = await hidden.json();
  assert.equal(hb.alert.status, 'actioned');
  assert.match(hb.result, /Removed them from every Party leaderboard/);
  assert.ok(h.db.raw.prepare('SELECT 1 FROM party_board_hidden WHERE user_id = ?').get(XD));
  const action = h.db.raw.prepare("SELECT * FROM owner_actions WHERE user_id = ? AND kind = 'party.board.hide'").get(XD);
  assert.equal(action.status, 'done');
  assert.match(action.note, /Cheat alert/);
  assert.equal((await (await h.api('GET', '/api/owner/cheats', o)).json()).open, 0);

  assert.ok(h.db.raw.prepare('SELECT points FROM party_points WHERE user_id = ?').get(XD).points > 0);
  const reset = await (await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'reset' })).json();
  assert.match(reset.result, /Reset their Party leaderboard stats/);
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_points WHERE user_id = ?').get(XD).n, 0);

  const reopened = await (await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'reopen' })).json();
  assert.equal(reopened.alert.status, 'open');
  const dismissed = await (await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'dismiss' })).json();
  assert.equal(dismissed.alert.status, 'dismissed');
  assert.equal(dismissed.result, null);

  const log = h.db.raw.prepare('SELECT action, actor_id, target_id FROM party_mod_log ORDER BY created ASC, rowid ASC').all();
  assert.deepEqual(log.map((r) => r.action), ['owner_cheat_hide', 'owner_cheat_reset', 'owner_cheat_reopen', 'owner_cheat_dismiss']);
  assert.ok(log.every((r) => r.actor_id === OWNER.id && r.target_id === XD));
  const all = await (await h.api('GET', '/api/owner/cheats?status=all', o)).json();
  assert.equal(all.alerts.length, 1);
  const done = await (await h.api('GET', '/api/owner/cheats?status=dismissed', o)).json();
  assert.equal(done.alerts.length, 1);
});

test('a dismissed alert stays quiet for a week, then new evidence reopens it', async () => {
  const h = party();
  const { o } = await owner(h);
  const alert = await capAlert(h);
  await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'dismiss' });
  advance(h, DAY);
  await capAlert(h);
  const quiet = alertOf(h, 'game_cap');
  assert.equal(quiet.status, 'dismissed');
  assert.equal(quiet.count, 2);
  advance(h, CHEAT_REOPEN_MS);
  await capAlert(h);
  assert.equal(alertOf(h, 'game_cap').status, 'open');
  assert.equal(alerts(h).filter((a) => a.kind === 'game_cap').length, 1);
});

test('cleanup drops old tracking rows and long-handled alerts but keeps open ones', async () => {
  const h = party();
  const { o } = await owner(h);
  const alert = await capAlert(h);
  for (let i = 0; i < 3; i += 1) await send(h, game(h, { game: 'chain' }));
  const g = game(h);
  g.players[1].name = 'XD';
  await send(h, g);
  assert.ok(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_cheat_pairs').get().n > 0);
  await h.api('POST', `/api/owner/cheats/${alert.id}`, o, { do: 'dismiss' });
  advance(h, Math.max(CHEAT_DAYS_KEEP, 91 * DAY) + DAY);
  await h.db.batch(cheatsCleanupStatements(h.db, h.clock.t));
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM party_cheat_pairs').get().n, 0);
  assert.equal(alertOf(h, 'game_cap'), null);
  assert.ok(alertOf(h, 'same_name'));
});

test('the dev server seeds cheat alerts for XD and a few blocked words', async () => {
  const { seedCheatAlerts, seedBlockedWords, DEV_CHEATER_ID } = await import('../dev.mjs');
  const h = party();
  seedCheatAlerts(h.db, h.clock.t);
  seedBlockedWords(h.db, h.clock.t);
  seedCheatAlerts(h.db, h.clock.t);
  const { o } = await owner(h);
  const list = await (await h.api('GET', '/api/owner/cheats', o)).json();
  assert.equal(list.open, 3);
  assert.ok(list.alerts.every((a) => a.user === DEV_CHEATER_ID && a.name === 'XD'));
  assert.ok(list.alerts.some((a) => a.detail === 'Hit the 100,000 daily points cap on 3 of the last 7 days'));
  const words = await (await h.request('GET', '/api/activity/blocked')).json();
  assert.equal(words.n, 3);
});
