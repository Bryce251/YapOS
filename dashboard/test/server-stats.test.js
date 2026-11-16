import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, advance, USERS, SERVER, OTHER_SERVER } from './helpers.js';
import { summarize, MAX_STAT_HOURS } from '../worker/server-stats.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function hoursBack(h, count, make) {
  const end = Math.floor(h.clock.t / HOUR) * HOUR;
  return Array.from({ length: count }, (_, i) => {
    const at = end - (count - 1 - i) * HOUR;
    return { hour: new Date(at).toISOString(), ...make(at, i) };
  });
}

function push(h, hours, sid = SERVER) {
  return h.bot('POST', '/bot/stats', { server_id: sid, hours });
}

test('the bot pushes hourly counts and an admin reads a 7 day summary', async () => {
  const h = createHarness();
  const hours = hoursBack(h, 10 * 24, (at) => ({ messages: new Date(at).getUTCHours() === 20 ? 30 : 2, joins: 1, leaves: 0, active: 5 }));
  const res = await push(h, hours);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, stored: 240, ignored: 0 });
  const { cookie } = await h.login(USERS.alice);
  await h.grant(cookie);
  const out = await h.api('GET', `/api/servers/${SERVER}/stats?days=7`, cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get('Cache-Control'), 'private, max-age=60');
  const body = await out.json();
  assert.equal(body.days, 7);
  assert.equal(body.hours.length, 7 * 24);
  assert.equal(body.daily.length, 7);
  assert.equal(body.daily[6].day, new Date(h.clock.t).toISOString().slice(0, 10));
  assert.equal(body.totals.joins, 7 * 24);
  assert.equal(body.totals.leaves, 0);
  assert.equal(body.totals.net, 7 * 24);
  assert.equal(body.totals.peakActive, 5);
  assert.equal(body.busiestHour, 20);
  assert.equal(body.busiest.length, 24);
  assert.equal(body.busiest[20], 30);
  assert.deepEqual(Object.keys(body.hours[0]).sort(), ['active', 'hour', 'joins', 'leaves', 'messages']);
  const month = await (await h.api('GET', `/api/servers/${SERVER}/stats?days=30`, cookie)).json();
  assert.equal(month.daily.length, 30);
  assert.equal(month.hours.length, 240);
  const def = await (await h.api('GET', `/api/servers/${SERVER}/stats`, cookie)).json();
  assert.equal(def.days, 7);
  assert.equal((await h.api('GET', `/api/servers/${SERVER}/stats?days=9`, cookie)).status, 400);
});

test('stats need a signed-in admin of that server', async () => {
  const h = createHarness();
  await push(h, hoursBack(h, 3, () => ({ messages: 1 })));
  assert.equal((await h.api('GET', `/api/servers/${SERVER}/stats`, null)).status, 401);
  const { cookie } = await h.login(USERS.bob);
  const first = await h.api('GET', `/api/servers/${OTHER_SERVER}/stats`, cookie);
  assert.equal(first.status, 403);
  assert.equal((await first.json()).error, 'grant_required');
  const { jobs } = await h.poll();
  await h.answer([{ id: jobs[0].id, ok: true, result: { grant: false } }]);
  const denied = await h.api('GET', `/api/servers/${OTHER_SERVER}/stats`, cookie);
  assert.equal((await denied.json()).error, 'no_access');
  assert.equal((await h.api('GET', '/api/servers/not-a-server/stats', cookie)).status, 400);
});

test('stats from the bot are checked: no junk, no future, nothing older than 60 days', async () => {
  const h = createHarness();
  const now = Math.floor(h.clock.t / HOUR) * HOUR;
  const res = await push(h, [
    { hour: new Date(now).toISOString(), messages: 4, joins: 2, leaves: 1, active: 3 },
    { hour: new Date(now + 90 * 60 * 1000 + 5).toISOString(), messages: 1 },
    { hour: new Date(now - 61 * DAY).toISOString(), messages: 1 },
    { hour: 'yesterday', messages: 1 },
    { hour: new Date(now - HOUR + 125000).toISOString(), messages: -1 },
    { hour: new Date(now - HOUR + 125000).toISOString(), messages: '3' },
    { hour: new Date(now - 2 * HOUR + 125000).toISOString(), messages: 2.7, joins: 1e12 },
    'junk',
  ]);
  assert.deepEqual(await res.json(), { ok: true, stored: 2, ignored: 6 });
  const rows = h.db.raw.prepare('SELECT * FROM server_stats ORDER BY hour').all();
  assert.equal(rows[0].hour, now - 2 * HOUR, 'hours snap to the start of the hour');
  assert.equal(rows[0].messages, 2);
  assert.equal(rows[0].joins, 10_000_000);
  assert.equal((await push(h, [], 'bad')).status, 400);
  assert.equal((await h.bot('POST', '/bot/stats', { server_id: SERVER, hours: 'x' })).status, 400);
  assert.equal((await push(h, Array(MAX_STAT_HOURS + 1).fill({}))).status, 413);
  assert.equal((await h.bot('POST', '/bot/stats', { server_id: SERVER, hours: [] }, 'wrong-secret-wrong-secret-wrong-secret')).status, 401);
  const again = await push(h, [{ hour: new Date(now).toISOString(), messages: 9 }]);
  assert.equal((await again.json()).stored, 1);
  assert.equal(h.db.raw.prepare('SELECT messages, joins FROM server_stats WHERE hour = ?').get(now).messages, 9, 'a re-push replaces the hour');
});

test('cleanup keeps 90 days of stats', async () => {
  const h = createHarness();
  await push(h, hoursBack(h, 2, () => ({ messages: 1 })));
  advance(h, 91 * DAY);
  await h.worker.scheduled({}, h.env, {});
  assert.equal(h.db.raw.prepare('SELECT COUNT(*) AS n FROM server_stats').get().n, 0);
});

test('an empty summary has zero days and no busiest hour', () => {
  const s = summarize([], 7, Date.UTC(2026, 10, 12, 12));
  assert.equal(s.daily.length, 7);
  assert.equal(s.busiestHour, null);
  assert.equal(s.updatedAt, null);
  assert.deepEqual(s.totals, { messages: 0, joins: 0, leaves: 0, net: 0, peakActive: 0 });
});
