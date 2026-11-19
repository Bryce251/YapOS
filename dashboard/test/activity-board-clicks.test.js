import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, FakeEvent, flush } from './dom-shim.js';

const ANN = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';

const ROWS = [
  { rank: 1, id: ANN, name: 'Ann', username: 'ann', avatar: null, value: 5000, games: 4, wins: 2, best: 2000, bestGame: 'trivia' },
  { rank: 2, id: BEN, name: 'Ben', username: null, avatar: null, value: 400, games: 1, wins: 0, best: 400, bestGame: null },
];

function tap(el) {
  el.dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

async function setup(reply) {
  const { document } = installDom({ url: 'https://yapos.dev/activity/' });
  const ui = await import('../web/activity/js/ui/leaderboard.js');
  const { h } = await import('../web/activity/js/ui/dom.js');
  const { createProfileCard } = await import('../web/activity/js/ui/profilecard.js');
  const opened = [];
  const win = {
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    fetch: async (url) => {
      opened.push(url);
      return new Response(JSON.stringify({ profile: { hidden: false, name: 'Ann', username: 'ann', level: 1, xp: 1, badges: [], achievements: [], page: true } }), { status: 200 });
    },
  };
  const engine = { snapshot: () => ({ ready: true, me: ME, players: [], room: { phase: 'lobby' } }) };
  const root = h('div', { class: 'app' });
  const host = h('div', { class: 'leaderboard-host' });
  root.append(host);
  document.body.append(root);
  const pc = createProfileCard({ win, engine });
  pc.bind(root);
  ui.resetLeaderboard();
  ui.configureLeaderboard({ fetch: async () => ({ ok: true, status: 200, json: async () => reply }), now: () => 1000 });
  const view = ui.openLeaderboard(host, { me: ME });
  await flush();
  await flush();
  pc.scan();
  return { ui, view, pc, opened };
}

test('Party top pictures and names open the profile card', async () => {
  const { ui, view, pc } = await setup({ rows: ROWS, me: { rank: 9, value: 5 }, total: 2 });
  const rows = view.el.querySelectorAll('.lb-row');
  assert.equal(rows.length, 2);
  const face = rows[0].querySelector('[data-profile-id]');
  assert.equal(face.getAttribute('role'), 'button');
  assert.equal(face.getAttribute('tabindex'), '0', 'the picture is the keyboard stop for the row');
  const name = rows[1].querySelector('.lb-name');
  assert.equal(name.getAttribute('data-profile-id'), BEN);
  assert.equal(name.getAttribute('role'), 'button');
  assert.equal(name.getAttribute('tabindex'), '-1', 'the name does not add a second tab stop');
  tap(name);
  assert.equal(pc.isOpen, true);
  assert.equal(pc.openId, BEN);
  pc.close();
  tap(face);
  assert.equal(pc.openId, ANN);
  pc.close();
  assert.match(view.el.querySelector('.lb-me').textContent, /You're #9/);
  view.close();
  ui.resetLeaderboard();
});

test('the owner sees Hidden from leaderboards instead of a rank in the Party top', async () => {
  const { ui, view } = await setup({ rows: ROWS, me: null, meHidden: true, total: 2 });
  const mine = view.el.querySelector('.lb-me-text');
  assert.equal(mine.textContent, 'Hidden from leaderboards');
  assert.equal(mine.classList.contains('is-off'), false);
  assert.equal(ui.meLine('points', null, true), ui.BOARD_HIDDEN_TEXT);
  assert.equal(ui.readBoard({ rows: [], meHidden: true }).meHidden, true);
  view.close();
  ui.resetLeaderboard();
});
