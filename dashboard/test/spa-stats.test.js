import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush } from './dom-shim.js';

const SID = '33333333-3333-4333-8333-333333333333';
const { document, window } = installDom({ url: `https://dash.example.test/servers/${SID}/stats` });
document.documentElement = document.createElement('html');
const { ApiError } = await import('../web/js/api.js');
const { state } = await import('../web/js/state.js');
const { renderStats, statsPath, statsView, heatmap } = await import('../web/js/pages/stats.js');
const { normalizeStats, hourLabel, heatLevel } = await import('../web/js/community-data.js');

const HOUR = 3600000;

function hoursAgo(n, extra = {}) {
  const t = Math.floor(Date.now() / HOUR) * HOUR - n * HOUR;
  return { hour: new Date(t).toISOString(), messages: 0, joins: 0, leaves: 0, active: 0, ...extra };
}

function makeCtx(api) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const chrome = [];
  return { api, main, params: { sid: SID }, signal: ctrl.signal, setChrome: (c) => chrome.push(c), setLeaveGuard: () => {}, chrome, abort: () => ctrl.abort() };
}

test('stats helpers build the path and read hourly rows into days and a 7 by 24 grid', () => {
  assert.equal(statsPath(SID, 7), `/api/servers/${SID}/stats?days=7`);
  assert.equal(statsPath(SID, 30), `/api/servers/${SID}/stats?days=30`);
  assert.equal(statsPath(SID, 99), `/api/servers/${SID}/stats?days=7`);
  const now = Date.now();
  const rows = [hoursAgo(0, { messages: 10, joins: 2, leaves: 1, active: 4 }), hoursAgo(1, { messages: 5, active: 6 }), hoursAgo(24 * 40, { messages: 999 }), { hour: 'nope', messages: 50 }];
  const s = normalizeStats({ hours: rows }, { days: 7, now });
  assert.equal(s.days.length, 7);
  assert.equal(s.span, 7);
  assert.equal(s.totals.messages, 15);
  assert.equal(s.totals.joins, 2);
  assert.equal(s.totals.leaves, 1);
  assert.equal(s.heat.length, 7);
  assert.ok(s.heat.every((r) => r.length === 24));
  assert.equal(s.heat.flat().reduce((a, b) => a + b, 0), 15);
  const d = new Date(Date.parse(rows[0].hour));
  assert.deepEqual(s.peak, { day: d.getDay(), hour: d.getHours(), count: 10 });
  assert.equal(s.empty, false);
  assert.equal(normalizeStats({ hours: [] }).empty, true);
  assert.equal(normalizeStats(null, { days: 30 }).days.length, 30);
  assert.equal(hourLabel(0), '12 AM');
  assert.equal(hourLabel(13), '1 PM');
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(1, 100), 1);
  assert.equal(heatLevel(100, 100), 4);
});

test('the heatmap draws 168 cells with labels and a spoken summary', () => {
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  heat[2][21] = 40;
  heat[2][20] = 10;
  const el = heatmap(heat, { day: 2, hour: 21, count: 40 });
  const grid = el.querySelector('.heat');
  assert.equal(grid.querySelectorAll('.heat-cell').length, 168);
  assert.equal(grid.querySelectorAll('.heat-day').length, 7);
  assert.equal(grid.querySelectorAll('.heat-4').length, 1);
  assert.equal(grid.querySelectorAll('.heat-1').length, 1);
  assert.match(grid.getAttribute('aria-label'), /Tuesday around 9 PM with 40 messages/);
});

test('the stats view shows totals, bars, joins and leaves and a friendly empty state', () => {
  const s = normalizeStats({ hours: [hoursAgo(0, { messages: 70, joins: 1, leaves: 3 })] }, { days: 7 });
  const view = statsView(s);
  assert.match(view.textContent, /Messages per day/);
  assert.match(view.textContent, /Joins and leaves/);
  assert.match(view.textContent, /Busiest hours/);
  assert.match(view.textContent, /Joined · 1/);
  assert.match(view.textContent, /Left · 3/);
  assert.equal(view.querySelectorAll('.pulse-bar-col').length, 7);
  assert.equal(view.querySelectorAll('.flow-bar').length, 14);
  const last = view.querySelectorAll('.pulse-bar-col').at(-1);
  assert.equal(last.style.props['--h'], '100%');
  assert.ok(view.querySelector('.stat-danger'));
  const empty = statsView(normalizeStats({ hours: [] }));
  assert.match(empty.textContent, /No stats yet/);
});

test('the Stats page loads the last 7 days and switches to 30', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/stats`);
  const seen = [];
  const ctx = makeCtx({ get: async (path) => { seen.push(path); return { days: 7, hours: [hoursAgo(2, { messages: 12, joins: 1 })] }; }, job: async () => null });
  renderStats(ctx);
  await flush();
  assert.equal(seen[0], `/api/servers/${SID}/stats?days=7`);
  assert.equal(ctx.chrome.at(-1).section, 'stats');
  assert.match(ctx.main.textContent, /Only counts are kept/);
  assert.equal(ctx.main.querySelectorAll('.heat-cell').length, 168 + 5);
  ctx.main.querySelectorAll('button').find((b) => /Last 30 days/.test(b.textContent)).click();
  await flush();
  assert.equal(seen[1], `/api/servers/${SID}/stats?days=30`);
  assert.match(window.location.search, /days=30/);
  assert.equal(ctx.main.querySelectorAll('.pulse-bar-col').length, 30);
  ctx.abort();
});

test('the Stats page waits for the bot and shows no-access errors kindly', async () => {
  state.details.clear();
  window.history.replaceState(null, '', `/servers/${SID}/stats`);
  const ctx = makeCtx({ get: async () => ({ pending: true, job: 'j1' }), job: async () => ({ hours: [hoursAgo(1, { messages: 3 })] }) });
  renderStats(ctx);
  await flush();
  assert.match(ctx.main.textContent, /Messages per day/);
  ctx.abort();
  const denied = makeCtx({ get: async () => { throw new ApiError('You need to be an admin of this server.', { status: 403, code: 'forbidden' }); }, job: async () => null });
  renderStats(denied);
  await flush();
  assert.match(denied.main.textContent, /No access to this server/);
  denied.abort();
});
