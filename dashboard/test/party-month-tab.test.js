import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, fire } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/leaderboard?board=month' });
document.documentElement = document.createElement('html');
const ui = await import('../web/activity/js/ui/leaderboard.js');
const spa = await import('../web/js/pages/party-leaderboard.js');

const ME = '88888888-8888-4888-8888-000000000001';
const MONTH = { month: '2026-11', ends: Date.UTC(2026, 11, 1), daysLeft: 15, prizes: 3 };
const ROWS = [{ rank: 1, id: ME, name: 'Bea', username: 'bea', avatar: null, value: 5200, games: 4, wins: 2, best: 2000, bestGame: 'trivia' }];

test('the in-call board has a This month tab that asks for the monthly period', async () => {
  assert.ok(ui.LEADERBOARD_TABS.some((t) => t.id === 'month' && t.label === 'This month'));
  assert.equal(ui.boardUrl('month', 'hive', ME), `/api/activity/leaderboard?board=points&game=all&limit=20&period=month&me=${ME}`);
  assert.equal(ui.monthLine(MONTH), '🏅 Top 3 win a profile badge · 15 days left');
  assert.equal(ui.monthLine({ ...MONTH, daysLeft: 1 }), '🏅 Top 3 win a profile badge · Last day');
  assert.deepEqual(ui.readBoard({ rows: [], month: { month: 'nope' } }).month, null);
  ui.resetLeaderboard();
  const calls = [];
  ui.configureLeaderboard({ fetch: async (url) => {
    calls.push(url);
    const monthly = url.includes('period=month');
    return { ok: true, status: 200, json: async () => ({ rows: ROWS, me: { rank: 1, value: 5200 }, total: 1, ...(monthly ? { month: MONTH } : {}) }) };
  }, now: () => 1000 });
  const view = ui.openLeaderboard(document.body, { me: ME });
  await flush();
  const prize = view.el.querySelector('.lb-prize');
  assert.equal(prize.hidden, true);
  fire(view.el.querySelectorAll('.lb-tab').find((b) => b.textContent === 'This month'), 'click');
  await flush();
  assert.match(calls.at(-1), /period=month/);
  assert.equal(prize.hidden, false);
  assert.equal(prize.textContent, '🏅 Top 3 win a profile badge · 15 days left');
  assert.equal(view.el.querySelector('.lb-game').disabled, true);
  assert.equal(view.el.querySelectorAll('.lb-row').length, 1);
  fire(view.el.querySelectorAll('.lb-tab').find((b) => b.textContent === 'Wins'), 'click');
  await flush();
  assert.equal(prize.hidden, true);
  assert.equal(view.el.querySelector('.lb-game').disabled, false);
  view.close();
  ui.resetLeaderboard();
});

test('the site leaderboard has a This month board with days left and the prize', async () => {
  assert.deepEqual(spa.readQuery('?board=month'), { board: 'month', game: 'all' });
  assert.equal(spa.leaderboardUrl({ board: 'month', game: 'draw', me: ME }), `${spa.LEADERBOARD_API}?board=points&game=all&limit=20&period=month&me=${ME}`);
  assert.equal(spa.monthText(MONTH), '🏅 Top 3 win a badge · 15 days left');
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const calls = [];
  spa.renderPartyLeaderboard(root, {
    params: {},
    signal: ctrl.signal,
    api: { get: async (path) => {
      calls.push(path);
      return { rows: ROWS, me: null, total: 1, month: MONTH };
    } },
    setTitle() {},
    getUser: async () => null,
  });
  await flush();
  assert.match(calls[0], /period=month/);
  const prize = root.querySelector('.plb-prize');
  assert.equal(prize.hidden, false);
  assert.equal(prize.textContent, '🏅 Top 3 win a badge · 15 days left');
  assert.equal(root.querySelector('.plb-game').disabled, true);
  ctrl.abort();
});
