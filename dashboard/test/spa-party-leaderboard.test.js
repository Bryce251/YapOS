import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, fire } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/leaderboard' });
document.documentElement = document.createElement('html');
const { matchRoute } = await import('../web/js/router.js');
const { renderPartyLeaderboard, normalizeLeaderboard, readQuery, leaderboardUrl, meText, valueText, LEADERBOARD_API } = await import('../web/js/pages/party-leaderboard.js');
const { renderSeasons } = await import('../web/js/pages/seasons.js');

const EVIL = '<img src=x onerror=alert(1)>';
const ME = '66666666-6666-4666-8666-000000000005';

function mount(render, { get, user = null } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const calls = [];
  const ctx = {
    params: {},
    signal: ctrl.signal,
    api: { get: async (path, opts) => {
      calls.push(path);
      return get(path, opts);
    } },
    title: '',
    setTitle(t) { ctx.title = t; },
    getUser: async () => user,
    abort: () => ctrl.abort(),
  };
  render(root, ctx);
  return { root, ctx, calls };
}

const BOARD = {
  board: 'points',
  game: 'all',
  rows: [
    { rank: 1, id: 'a', name: 'Bea', username: 'bea', avatar: null, value: 52000, games: 40, wins: 12, best: 9000, bestGame: 'trivia', link: true },
    { rank: 2, id: 'b', name: EVIL, username: 'sneaky', avatar: 'javascript:alert(1)', value: 41000, games: 30, wins: 3, best: 2000, bestGame: 'nope', link: false },
    { rank: 3, id: 'c', name: 'Cy', username: null, avatar: null, value: 1, games: 1, wins: 0, best: 1, bestGame: null, link: true },
    { rank: 4, id: ME, name: 'Me', username: 'me', avatar: null, value: 100, games: 1, wins: 0, best: 100, bestGame: 'draw', link: false },
  ],
  me: { rank: 4, value: 100 },
  total: 143,
  updated: Date.now(),
};

test('the party leaderboard page is public', () => {
  const r = matchRoute('/party/leaderboard');
  assert.equal(r.name, 'party-leaderboard');
  assert.equal(r.private, false);
  assert.equal(matchRoute('/party').private, true);
});

test('query, url and text helpers', () => {
  assert.deepEqual(readQuery('?board=wins&game=hive'), { board: 'wins', game: 'hive' });
  assert.deepEqual(readQuery('?board=xp&game=chess'), { board: 'points', game: 'all' });
  assert.equal(leaderboardUrl({ board: 'best', game: 'draw', me: ME }), `${LEADERBOARD_API}?board=best&game=draw&limit=20&me=${ME}`);
  assert.equal(meText('points', { rank: 143, value: 12400 }), "You're #143 with 12,400 points");
  assert.equal(valueText('wins', 1), '1 win');
  const v = normalizeLeaderboard(BOARD);
  assert.equal(v.rows[1].bestGame, null);
  assert.equal(v.rows[2].link, false);
  assert.equal(normalizeLeaderboard(null).rows.length, 0);
});

test('the page lists players, links only open profiles and pins your rank', async () => {
  const { root, ctx, calls } = mount(renderPartyLeaderboard, { get: async () => BOARD, user: { id: ME.toUpperCase() } });
  await flush();
  await flush();
  assert.equal(ctx.title, 'Party leaderboard');
  assert.ok(calls.some((c) => c.includes(`me=${ME.toUpperCase()}`)));
  const rows = root.querySelectorAll('.plb-row');
  assert.equal(rows.length, 4);
  assert.equal(root.querySelectorAll('a.plb-name').length, 0);
  assert.ok(rows.every((r) => r.localName === 'button' && r.getAttribute('aria-haspopup') === 'dialog'));
  assert.ok(root.textContent.includes(EVIL));
  assert.equal(root.querySelector('.plb-list').querySelectorAll('img').length, 0);
  assert.match(root.textContent, /52,000 points/);
  assert.match(root.textContent, /🧠 Trivia/);
  assert.match(root.querySelector('.plb-me').textContent, /You're #4 with 100 points/);
  assert.ok(rows[3].className.includes('is-me'));
  assert.match(root.textContent, /143 players on this board/);
  const wins = root.querySelectorAll('button').find((b) => b.textContent === 'Wins');
  fire(wins, 'click');
  await flush();
  assert.ok(calls.at(-1).includes('board=wins'));
  ctx.abort();
});

test('the page has friendly empty and error states', async () => {
  const empty = mount(renderPartyLeaderboard, { get: async () => ({ rows: [], me: null, total: 0 }) });
  await flush();
  assert.match(empty.root.textContent, /Nobody here yet/);
  empty.ctx.abort();
  const broken = mount(renderPartyLeaderboard, { get: async () => { throw new Error('Offline for a bit'); } });
  await flush();
  assert.match(broken.root.textContent, /Couldn't load the leaderboard/);
  broken.ctx.abort();
});

test('seasons and the public nav link to the party leaderboard', async () => {
  const { root, ctx } = mount(renderSeasons, { get: async () => ({ seasons: [] }) });
  await flush();
  const hrefs = root.querySelectorAll('a').map((a) => a.href);
  assert.ok(hrefs.filter((x) => x === '/party/leaderboard').length >= 2);
  ctx.abort();
});
