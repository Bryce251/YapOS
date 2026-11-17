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

test('the dev server seeds a temp ban with time left, an unseen warning, blocked words and a mod log from two mods', async () => {
  const dev = await import('../dev.mjs');
  const { activeBan } = await import('../worker/party-mod.js');
  const { readModLog, modLogSentence } = await import('../web/js/pages/party-modlog.js');
  const h = party();
  for (let i = 0; i < 2; i += 1) {
    dev.seedPartyAdmins(h.db, IDS.owner, h.clock.t);
    dev.seedPartyReport(h.db, h.clock.t);
    dev.seedCheatAlerts(h.db, h.clock.t);
    dev.seedBlockedWords(h.db, h.clock.t);
    dev.seedPartyModeration(h.db, h.clock.t);
  }
  const ban = await activeBan(h.db, dev.DEV_TEMP_BANNED, h.clock.t);
  assert.ok(ban);
  assert.equal(ban.duration, 'day');
  assert.ok(Number(ban.until) > h.clock.t + 20 * 3_600_000);
  assert.equal(await activeBan(h.db, dev.DEV_EXPIRED_BAN, h.clock.t), null);
  const unseen = h.db.raw.prepare('SELECT * FROM party_warnings WHERE user_id = ? AND seen_at IS NULL').all(dev.DEV_WARNED);
  assert.equal(unseen.length, 1);
  assert.match(unseen[0].text, /drawings clean/);
  const words = await (await h.request('GET', '/api/activity/blocked')).json();
  assert.equal(words.n, 3);
  const rows = h.db.raw.prepare('SELECT * FROM party_mod_log ORDER BY created DESC, id DESC').all();
  assert.equal(rows.length, 15);
  const humans = new Set(rows.map((r) => r.actor_id).filter((id) => id !== 'yapos'));
  assert.deepEqual([...humans].sort(), [IDS.owner, dev.DEV_PARTY_ADMIN].sort());
  for (const a of ['ban', 'unban', 'ban_expire', 'warn', 'dismiss', 'note_add', 'word_add']) assert.ok(rows.some((r) => r.action === a), a);
  const view = readModLog({ entries: rows.map((r) => ({ id: r.id, action: r.action, actor: { id: r.actor_id, name: r.actor_name, system: r.actor_id === 'yapos' }, target: r.target_id ? { id: r.target_id, name: r.target_name } : null, detail: r.detail ? JSON.parse(r.detail) : null, created: r.created })) });
  for (const e of view.entries) {
    const s = modLogSentence(e);
    assert.ok(!s.includes('A mod') && !s.includes('someone') && !s.includes(':  '), s);
  }
  assert.ok(view.entries.some((e) => e.target && modLogSentence(e) === `${e.actor.name} banned ${e.target.name} for 1 day: Spamming the chat in Word Chain`));
  const alerts = h.db.raw.prepare("SELECT * FROM party_cheat_alerts WHERE name = 'XD' AND kind = 'daily_points' AND status = 'open'").all();
  assert.equal(alerts.length, 1);
  const reasons = h.db.raw.prepare('SELECT reason FROM party_report_reasons').all().map((r) => r.reason);
  for (const r of ['rude', 'spam', 'cheating']) assert.ok(reasons.includes(r), r);
});
