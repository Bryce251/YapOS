import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, USERS } from './helpers.js';
import { LEADERBOARD_GAMES } from '../worker/party-leaderboard.js';
import { IDS } from '../../test/harness.js';

const OWNER = USERS.alice;
const party = () => createHarness({ PARTY_OWNER_ID: OWNER.id });

test('the dev leaderboard seed covers every leaderboard game', async () => {
  const { DEV_LEADERBOARD_GAMES } = await import('../dev.mjs');
  assert.deepEqual([...DEV_LEADERBOARD_GAMES].sort(), [...LEADERBOARD_GAMES].sort());
});

test('the dev server seeds a Party month board and last month top 3 badges', async () => {
  const { seedPartyLeaderboard, seedPublicProfile } = await import('../dev.mjs');
  const h = party();
  seedPartyLeaderboard(h.db, h.clock.t);
  seedPublicProfile(h.db, h.clock.t);
  const res = await h.request('GET', '/api/activity/leaderboard?board=points&period=month&limit=10', { ip: '198.51.100.90' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rows.length, 10);
  assert.ok(body.month && body.month.month);
  for (let i = 1; i < body.rows.length; i += 1) assert.ok(body.rows[i - 1].value >= body.rows[i].value);
  const awards = h.db.raw.prepare('SELECT rank, user_id FROM party_season_awards ORDER BY rank').all();
  assert.deepEqual(awards.map((a) => a.rank), [1, 2, 3]);
  assert.ok(awards.some((a) => a.user_id === IDS.owner));
  const card = await h.request('GET', `/api/activity/profile/${IDS.owner}`, { ip: '198.51.100.91' });
  assert.equal(card.status, 200);
  const text = JSON.stringify(await card.json());
  for (const id of ['streak-3', 'steals-10', 'perfect-trivia', 'comeback', 'season-party-2-']) assert.ok(text.includes(id), id);
});

test('the dev server seeds a person with several reports, a past replay and ban history', async () => {
  const { seedPartyReport, DEV_REPORT_DRAWER, DEV_PAST_REPORT_IDS } = await import('../dev.mjs');
  const h = party();
  seedPartyReport(h.db, h.clock.t);
  seedPartyReport(h.db, h.clock.t);
  const { cookie } = await h.login(OWNER);
  const res = await h.api('GET', `/api/party/reports/person/${DEV_REPORT_DRAWER}`, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = JSON.stringify(body);
  for (const id of DEV_PAST_REPORT_IDS) assert.ok(text.includes(id), id);
  assert.ok((body.reports || []).length >= 4);
  assert.ok((body.reports || []).some((r) => r.id === DEV_PAST_REPORT_IDS[0] && r.replay));
  assert.ok((body.bans || []).length >= 2);
});
