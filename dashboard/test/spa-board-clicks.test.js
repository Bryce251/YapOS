import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, FakeEvent } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/party/leaderboard' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPartyLeaderboard, normalizeLeaderboard, meText, boardFacts, boardPerson } = await import('../web/js/pages/party-leaderboard.js');
const { renderSeasons, seasonPerson, seasonFacts } = await import('../web/js/pages/seasons.js');
const { boardRowLabel, PRIVATE_TITLE, BOARD_HIDDEN_TEXT } = await import('../web/js/pages/board-person.js');
const { state } = await import('../web/js/state.js');
const { OWNER_USERS_PATH } = await import('../web/js/pages/owner.js');

const ANN = '66666666-6666-4666-8666-000000000001';
const BEN = '66666666-6666-4666-8666-000000000002';

const BOARD = {
  board: 'points',
  game: 'all',
  rows: [
    { rank: 1, id: ANN, name: 'Ann', username: 'ann', avatar: null, value: 5000, games: 9, wins: 4, best: 2000, bestGame: 'trivia', link: true },
    { rank: 2, id: BEN, name: 'Ben', username: null, avatar: null, value: 4000, games: 1, wins: 1, best: 4000, bestGame: 'draw', link: false, private: true },
  ],
  me: null,
  meHidden: true,
  total: 2,
};

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function mount(render, get) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const calls = [];
  const ctx = {
    params: {},
    signal: ctrl.signal,
    api: { get: async (p, o) => { calls.push(p); return get(p, o); }, post: async () => ({}) },
    setTitle() {},
    getUser: async () => null,
  };
  render(root, ctx);
  return { root, ctrl, calls };
}

async function closeAll(ctrl) {
  ctrl.abort();
  for (const b of document.querySelectorAll('.drawer-panel button[aria-label="Close panel"]')) click(b);
  await new Promise((r) => setTimeout(r, 200));
}

test('row helpers', () => {
  assert.equal(boardRowLabel('Ann', 3), "Rank 3: open Ann's profile");
  assert.equal(boardRowLabel('', null), "Open this player's profile");
  assert.equal(meText('points', null, true), BOARD_HIDDEN_TEXT);
  const v = normalizeLeaderboard(BOARD);
  assert.equal(v.meHidden, true);
  assert.equal(v.rows[1].private, true);
  assert.deepEqual(boardPerson(v.rows[0]), { id: ANN, name: 'Ann', avatar: '', avatarStill: '', handle: 'ann', private: false });
  assert.equal(boardPerson(v.rows[1]).handle, '');
  const facts = boardFacts('wins', v.rows[0]);
  assert.deepEqual(facts.map((f) => f.key), ['rank', 'value', 'games', 'best']);
  assert.equal(seasonPerson({ id: '', name: 'X', username: 'x', linked: true }).handle, 'x');
  assert.equal(seasonFacts({ label: 'October 2026' }, 'shards', { rank: 2, value: 5 })[1].value, '#2');
});

test('party board rows are buttons whose picture and name open the profile popup', async () => {
  state.partyOwner = false;
  state.partyAdmin = false;
  const { root, ctrl } = mount(renderPartyLeaderboard, async () => BOARD);
  await flush();
  await flush();
  const rows = root.querySelectorAll('button.plb-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('aria-haspopup'), 'dialog');
  assert.match(rows[0].getAttribute('aria-label'), /Rank 1: open Ann's profile/);
  assert.ok(rows[0].querySelector('.avatar'), 'the picture sits inside the button');
  assert.ok(rows[0].querySelector('.plb-name'), 'so does the name');
  assert.match(root.querySelector('.plb-me').textContent, /Hidden from leaderboards/);
  click(rows[0].querySelector('.plb-name'));
  await flush();
  let panel = document.querySelector('.drawer-panel');
  assert.ok(panel, 'the popup opens');
  assert.match(panel.textContent, /Party leaderboard/);
  assert.match(panel.textContent, /Points rank#1/);
  assert.ok([...panel.querySelectorAll('a')].some((a) => (a.getAttribute('href') || a.href) === '/u/ann'));
  assert.equal(panel.querySelector('.bp-mod'), null, 'visitors get no mod view');
  assert.equal(panel.querySelector('.bp-staff'), null);
  click(document.querySelector('.drawer-panel button[aria-label="Close panel"]'));
  await new Promise((r) => setTimeout(r, 200));
  click(rows[1]);
  await flush();
  panel = document.querySelector('.drawer-panel');
  assert.ok(panel.querySelector('.bp-private'));
  assert.match(panel.textContent, new RegExp(PRIVATE_TITLE));
  await closeAll(ctrl);
});

test('party staff get a mod view button and the owner gets the mod view', async () => {
  state.partyOwner = true;
  state.partyAdmin = true;
  const { root, ctrl, calls } = mount(renderPartyLeaderboard, async (p) => {
    if (p.startsWith(OWNER_USERS_PATH)) return { user: { id: BEN, name: 'Ben', level: 2, xp: 10, shards: 3, globalHidden: false }, actions: [], catalog: {} };
    return BOARD;
  });
  await flush();
  await flush();
  click(root.querySelectorAll('button.plb-row')[1]);
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.ok(panel.querySelector('.bp-mod'), 'the owner keeps the mod view');
  assert.ok(panel.querySelector('.bp-staff'), 'staff can jump to the party mod view');
  assert.ok(calls.some((c) => c === `${OWNER_USERS_PATH}/${BEN}`));
  state.partyOwner = false;
  state.partyAdmin = false;
  await closeAll(ctrl);
});

test('past season rows open the same popup', async () => {
  const seasons = { seasons: [{ month: '2026-10', boards: { xp: [{ rank: 1, name: 'Ann', username: 'ann', value: 900, profile: true }, { rank: 2, name: 'Ben', username: null, value: 800, profile: false }], shards: [] } }] };
  const { root, ctrl } = mount(renderSeasons, async () => seasons);
  await flush();
  const rows = root.querySelectorAll('button.season-row');
  assert.equal(rows.length, 2);
  click(rows[0].querySelector('.season-name'));
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, /Past season/);
  assert.ok([...panel.querySelectorAll('a')].some((a) => (a.getAttribute('href') || a.href) === '/u/ann'));
  click(document.querySelector('.drawer-panel button[aria-label="Close panel"]'));
  await new Promise((r) => setTimeout(r, 200));
  click(rows[1]);
  await flush();
  assert.ok(document.querySelector('.drawer-panel .bp-private'));
  await closeAll(ctrl);
});
