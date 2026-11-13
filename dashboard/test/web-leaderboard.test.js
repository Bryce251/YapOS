import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/p/global' });
document.documentElement = document.createElement('html');
const { renderPublic, leaderboardUrl, CURRENCY_NAME } = await import('../web/js/pages/public.js');
const { ApiError } = await import('../web/js/api.js');
const { renderLanding } = await import('../web/js/pages/landing.js');

const DATA = {
  name: 'Test Town',
  updatedAt: Date.now(),
  levels: [{ rank: 1, id: 'a', name: 'Al', level: 12, xp: 3000 }],
  economy: [{ rank: 1, id: 'a', name: 'Al', balance: 1500 }],
  wrapped: { month: '2026-10', messages: 12 },
};

function mount(get) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const ctx = { params: { slug: 'global' }, signal: ctrl.signal, api: { get }, title: '', setTitle(t) { ctx.title = t; }, abort: () => ctrl.abort() };
  renderPublic(root, ctx);
  return { root, ctx };
}

test('the leaderboard is global, with no server name and no Wrapped', async () => {
  const { root, ctx } = mount(async () => DATA);
  await flush();
  assert.equal(ctx.title, 'Global leaderboard');
  const text = root.textContent;
  assert.doesNotMatch(text, /Test Town/);
  assert.doesNotMatch(text, /Wrapped/i);
  assert.match(text, /Everyone on YapOS/);
  const tabs = root.querySelectorAll('button.tab');
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].textContent, /Levels/);
  assert.match(tabs[1].textContent, new RegExp(CURRENCY_NAME));
  ctx.abort();
});

test('the leaderboard shows levels first and switches to Shards', async () => {
  const { root, ctx } = mount(async () => DATA);
  await flush();
  assert.match(root.querySelector('.board-unit').textContent, /Level/);
  root.querySelectorAll('button.tab')[1].click();
  const unit = root.querySelector('.board-unit').textContent;
  assert.match(unit, /Shards/);
  assert.match(unit, /💎/);
  assert.equal(root.querySelector('.board').getAttribute('aria-label'), 'Shards leaderboard');
  ctx.abort();
});

test('an old server page points at the one leaderboard', async () => {
  const { root, ctx } = mount(async () => { throw new ApiError('gone', { status: 404, code: 'http_404' }); });
  await flush();
  assert.match(root.textContent, /every server/i);
  const link = root.querySelectorAll('a').find((a) => String(a.href || '').startsWith('/p/'));
  assert.equal(link.href, leaderboardUrl());
  assert.equal(leaderboardUrl(), '/p/global');
  ctx.abort();
});

test('an empty board still reads as a global one', async () => {
  const { root, ctx } = mount(async () => ({}));
  await flush();
  assert.match(root.textContent, /Nobody here yet/);
  root.querySelectorAll('button.tab')[1].click();
  assert.match(root.textContent, /Shards earned in any server/);
  ctx.abort();
});

test('an old ?tab=coins link opens the Shards board', async () => {
  window.location.search = '?tab=coins';
  const { root, ctx } = mount(async () => DATA);
  await flush();
  const tabs = root.querySelectorAll('button.tab');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.match(root.querySelector('.board-unit').textContent, /Shards/);
  window.location.search = '';
  ctx.abort();
});

test('the landing page promises one global board, not per-server pages or Wrapped', () => {
  const root = document.createElement('div');
  renderLanding(root, { user: null, search: '' });
  const text = root.textContent;
  assert.doesNotMatch(text, /Wrapped/i);
  assert.doesNotMatch(text, /Publish a public page/i);
  assert.match(text, /global leaderboard/i);
  assert.match(text, /Shards/);
});
