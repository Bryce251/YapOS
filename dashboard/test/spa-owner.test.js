import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, type } from './dom-shim.js';
import { createHarness, USERS } from './helpers.js';

const { document } = installDom({ url: 'https://dash.example.test/owner' });
document.documentElement = document.createElement('html');
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { matchRoute, ownerPath, sectionFor } = await import('../web/js/router.js');
const { createShell } = await import('../web/js/shell.js');
const { state } = await import('../web/js/state.js');
const owner = await import('../web/js/pages/owner.js');
const { simulateOne, createOwnerSim, seedOwnerPanel, DEV_OWNER_PEOPLE } = await import('../dev/owner-sim.js');

const ID = '77777777-7777-4777-8777-000000000001';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byLabel = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);

const DETAIL = {
  user: {
    id: ID, username: 'pip', name: 'Pip', avatar: null, level: 12, shards: 900, xp: 2650, seen: Date.now() - 60000,
    badges: ['first-game', 'founder'], earnedBadges: ['first-game'], achievements: ['msgs1k'],
    clan: { name: 'Owls', tag: 'OWL' }, party: { games: 3, wins: 1 }, known: true,
  },
  actions: [],
  catalog: {
    achievements: [{ id: 'msgs1k', label: 'Chatterbox', emoji: '💬', reward: 100 }, { id: 'level10', label: 'Rising star', emoji: '📈', reward: 100 }],
    badges: [{ id: 'first-game', label: 'First game', emoji: '🎈', source: 'party' }, { id: 'founder', label: 'Founder', emoji: '🛡️', source: 'bot' }, { id: 'bug-hunter', label: 'Bug hunter', emoji: '🐛', source: 'bot' }],
    kinds: [],
  },
};

function mount(render, { get, post, params = {} } = {}) {
  const main = document.createElement('main');
  document.body.replaceChildren(main);
  const ctrl = new AbortController();
  const posts = [];
  const ctx = {
    main,
    params,
    signal: ctrl.signal,
    api: {
      get: get || (async () => ({})),
      post: post || (async (path, body) => {
        posts.push({ path, body });
        return { action: { id: `a${posts.length}`, user: body.user, kind: body.kind, value: body.value ?? null, ref: body.id ?? null, notify: Boolean(body.notify), created: Date.now(), status: 'queued', result: null } };
      }),
    },
    chrome: null,
    title: '',
    setChrome(c) { ctx.chrome = c; },
    setTitle(t) { ctx.title = t; },
    navigate(href) { ctx.went = href; },
  };
  render(ctx);
  return { main, ctx, posts, stop: () => ctrl.abort() };
}

test('the owner pages are private routes and only owners get the nav link', () => {
  assert.deepEqual(matchRoute('/owner'), { name: 'owner', params: {}, private: true, path: '/owner' });
  const r = matchRoute(`/owner/${ID.toUpperCase()}`);
  assert.equal(r.name, 'owner-user');
  assert.equal(r.private, true);
  assert.equal(matchRoute('/owner/not-a-user').name, 'not-found');
  assert.equal(ownerPath(ID.toUpperCase()), `/owner/${ID}`);
  assert.equal(sectionFor('owner-user'), 'owner');
  const shell = createShell({ onLogout() {} });
  shell.update({ variant: 'plain', section: 'owner', user: { id: ID, username: 'jolli' }, partyOwner: false });
  assert.equal(walk(shell.root).some((n) => n.href === '/owner'), false);
  shell.update({ variant: 'plain', section: 'owner', user: { id: ID, username: 'jolli' }, partyOwner: true });
  const link = walk(shell.root).find((n) => n.href === '/owner');
  assert.ok(link);
  assert.equal(link.getAttribute('aria-current'), 'page');
});

test('people who are not the owner see a not-found page and nothing is loaded', async () => {
  state.partyOwner = false;
  let asked = 0;
  const { main } = mount(owner.renderOwner, { get: async () => { asked += 1; return {}; } });
  await flush();
  assert.match(main.textContent, /Page not found/);
  assert.equal(asked, 0);
  const user = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => { asked += 1; return {}; } });
  await flush();
  assert.match(user.main.textContent, /Page not found/);
  assert.equal(asked, 0);
});

test('search shows live results and the recent changes log with links to staff pages', async () => {
  state.partyOwner = true;
  const calls = [];
  const { main, stop } = mount(owner.renderOwner, {
    get: async (path) => {
      calls.push(path);
      if (path.startsWith(owner.OWNER_USERS_PATH)) {
        return { users: [{ id: ID, username: 'pip', name: '<b>Pip</b>', avatar: null, level: 4, shards: 250, seen: Date.now() }] };
      }
      return { actions: [{ id: 'x1', user: ID, kind: 'shards.add', value: 500, created: Date.now(), status: 'done', result: 'Gave 500.', who: { username: 'pip', name: 'Pip' } }] };
    },
  });
  await flush();
  assert.ok(calls.includes('/api/owner/users?q='));
  assert.ok(calls.includes('/api/owner/actions?limit=30'));
  assert.match(main.textContent, /<b>Pip<\/b>/);
  assert.equal(walk(main).some((n) => n.localName === 'b'), false);
  assert.match(main.textContent, /Give 500 💎 Shards/);
  assert.match(main.textContent, /Gave 500\./);
  assert.ok(walk(main).some((n) => n.href === '/party/reports'));
  assert.ok(walk(main).some((n) => n.href === '/party'));
  assert.ok(walk(main).some((n) => n.href === `/owner/${ID}`));
  const input = walk(main).find((n) => n.localName === 'input');
  type(input, '@pip');
  await new Promise((r) => setTimeout(r, owner.SEARCH_DELAY_MS + 20));
  await flush();
  assert.ok(calls.includes('/api/owner/users?q=%40pip'));
  stop();
});

test('the user page shows their card and sends gifts with Tell them, quick chips and a note', async () => {
  state.partyOwner = true;
  const { main, ctx, posts, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => structuredClone(DETAIL) });
  await flush();
  const text = main.textContent;
  for (const bit of ['Pip', '@pip', 'Owls [OWL]', '2,650', '900 💎', 'Chatterbox', 'Founder', 'Tell them']) assert.ok(text.includes(bit), bit);
  assert.equal(ctx.chrome.section, 'owner');
  assert.equal(ctx.title, 'Pip · Owner panel');
  const inputs = walk(main).filter((n) => n.localName === 'input');
  const tell = inputs.find((n) => n.type === 'checkbox');
  const shards = inputs.find((n) => n.classList.contains('owner-amount'));
  const noteInput = inputs.find((n) => n.placeholder === 'Why? Only you see this');
  byLabel(main, 'Add 1,000 to Shards').click();
  byLabel(main, 'Add 100 to Shards').click();
  assert.equal(shards.value, '1100');
  tell.checked = true;
  noteInput.value = 'Thanks for testing';
  byLabel(main, 'Give').click();
  await flush();
  assert.deepEqual(posts[0], { path: '/api/owner/actions', body: { user: ID, kind: 'shards.add', value: 1100, notify: true, note: 'Thanks for testing' } });
  assert.equal(shards.value, '');
  assert.match(main.textContent, /Waiting for YapOS/);
  byLabel(main, 'Give Rising star').click();
  await flush();
  assert.deepEqual(posts[1].body, { user: ID, kind: 'achievement.grant', id: 'level10', notify: true, note: 'Thanks for testing' });
  assert.equal(byLabel(main, 'Take First game').disabled, true);
  stop();
});

test('removals and set-to-lower ask first, and cancelling sends nothing', async () => {
  state.partyOwner = true;
  const { main, posts, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => structuredClone(DETAIL) });
  await flush();
  const shards = walk(main).find((n) => n.localName === 'input' && n.classList.contains('owner-amount'));
  shards.value = '50';
  byLabel(main, 'Set to this').click();
  await flush();
  let dialog = document.body.querySelector('.dialog-panel');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Lower Pip's Shards\?/);
  assert.match(dialog.textContent, /takes 850 away/);
  byLabel(dialog, 'Cancel').click();
  await flush();
  assert.equal(posts.length, 0);
  byLabel(main, 'Take Chatterbox').click();
  await flush();
  dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Take achievement 💬 Chatterbox\?/);
  byLabel(dialog, 'Yes, do it').click();
  await flush();
  assert.deepEqual(posts[0].body, { user: ID, kind: 'achievement.revoke', id: 'msgs1k' });
  shards.value = 'inf';
  byLabel(main, 'Give').click();
  await flush();
  assert.equal(posts.length, 1);
  assert.match(document.body.textContent, /Infinity is not allowed/);
  stop();
});

test('pending actions are polled until YapOS finishes them', async () => {
  state.partyOwner = true;
  let n = 0;
  const pendingDetail = structuredClone(DETAIL);
  pendingDetail.actions = [{ id: 'q1', user: ID, kind: 'xp.add', value: 10, created: Date.now(), status: 'sent' }];
  const doneDetail = structuredClone(DETAIL);
  doneDetail.user.xp = 2660;
  doneDetail.actions = [{ id: 'q1', user: ID, kind: 'xp.add', value: 10, created: Date.now(), status: 'done', result: 'Gave 10 XP.' }];
  const { main, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => { n += 1; return n === 1 ? pendingDetail : doneDetail; } });
  await flush();
  assert.match(main.textContent, /YapOS is on it/);
  await new Promise((r) => setTimeout(r, owner.POLL_MS + 50));
  await flush();
  assert.equal(n, 2);
  assert.match(main.textContent, /Gave 10 XP\./);
  assert.ok(main.textContent.includes('2,660'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, 2);
  stop();
});

test('helpers describe, parse and judge actions', () => {
  assert.equal(owner.describeAction({ kind: 'party.stats.add', value: { games: 1, wins: 2 } }), 'Add 1 Party game and 2 wins');
  assert.equal(owner.describeAction({ kind: 'level.set', value: 5 }), 'Set level to 5');
  assert.deepEqual(owner.parseWhole('10k'), { value: 10000 });
  assert.deepEqual(owner.parseWhole('1,500'), { value: 1500 });
  assert.ok(owner.parseWhole('Infinity').error);
  assert.ok(owner.parseWhole('-5').error);
  assert.ok(owner.parseWhole('2.5').error);
  assert.equal(owner.bumpAmount('', 100), '100');
  assert.equal(owner.confirmText('shards.add', 5, DETAIL.user), null);
  assert.equal(owner.confirmText('shards.set', 5000, DETAIL.user), null);
  assert.ok(owner.confirmText('level.set', 1, DETAIL.user));
  assert.ok(owner.confirmText('giver.revoke', null, DETAIL.user));
  assert.equal(owner.hasOpen(owner.readActions([{ id: 'a', kind: 'x', status: 'done' }])), false);
});

test('the local stand-in bot finishes queued actions through the real results endpoint', async () => {
  const h = createHarness({ PARTY_OWNER_ID: USERS.alice.id });
  seedOwnerPanel(h.db, h.clock.t);
  const cookie = (await h.login(USERS.alice)).cookie;
  const sam = DEV_OWNER_PEOPLE[0];
  const give = (body) => h.api('POST', '/api/owner/actions', cookie, { user: sam.id, ...body });
  assert.equal((await give({ kind: 'shards.add', value: 500 })).status, 201);
  assert.equal((await give({ kind: 'achievement.grant', id: 'casino50' })).status, 201);
  assert.equal((await give({ kind: 'achievement.grant', id: 'msgs1k' })).status, 201);
  const sim = createOwnerSim({ db: h.db, now: () => h.clock.t + 5000, send: (results) => h.bot('POST', '/bot/owner/results', { results }) });
  assert.equal(await sim.tick(), 3);
  assert.equal(await sim.tick(), 0);
  const detail = await (await h.api('GET', `/api/owner/users/${sam.id}`, cookie)).json();
  assert.equal(detail.user.shards, 500);
  assert.ok(detail.user.achievements.includes('casino50'));
  assert.deepEqual(detail.actions.map((a) => a.status), ['failed', 'done', 'done']);
  assert.deepEqual(simulateOne({ kind: 'shards.remove', value: '99', ref: null }, { pub: { shards: 10 }, known: null }).after, { shards: 0 });
});

test('names, notes, labels and results from the server are shown as plain text', async () => {
  state.partyOwner = true;
  const evil = '<img src=x onerror=alert(1)>';
  const data = {
    ...DETAIL,
    user: { ...DETAIL.user, name: evil, username: 'pip', clan: { name: evil, tag: 'X' } },
    actions: [{ id: 'e1', user: ID, kind: 'badge.grant', value: null, ref: 'evil', note: evil, notify: false, created: Date.now(), status: 'failed', result: evil, updated: Date.now() }],
    catalog: { ...DETAIL.catalog, badges: [...DETAIL.catalog.badges, { id: 'evil', label: evil, emoji: evil, source: 'bot' }] },
  };
  const { main, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => data });
  await flush();
  await flush();
  assert.ok(main.textContent.includes(evil));
  assert.equal(walk(main).some((n) => n.localName === 'img' && n.getAttribute('src') === 'x'), false);
  assert.equal(walk(main).some((n) => typeof n.getAttribute === 'function' && n.getAttribute('onerror') !== null), false);
  stop();
});

test('letting someone create Shards always asks first and says what it means', () => {
  const ask = owner.confirmText('giver.grant', null, DETAIL.user);
  assert.ok(ask);
  assert.match(ask.body, /out of nothing/);
  assert.equal(owner.describeAction({ kind: 'giver.grant' }), 'Let them create Shards');
});

const BOARD = {
  points: 100000, games: 11, wins: 4, best: 50000, bestGame: 'trivia', rank: 1,
  month: { month: '2026-11', points: 100000, rank: 1 }, today: { points: 100000, games: 11 },
  byGame: [{ game: 'trivia', points: 50000, games: 6, wins: 3, best: 50000 }, { game: 'namefive', points: 50000, games: 5, wins: 1, best: 20000 }],
  counters: { steals: 12, perfect: 1, bestWinStreak: 4 }, hidden: false, banned: false,
};

function boardDetail(over = {}) {
  const d = structuredClone(DETAIL);
  d.user.name = 'XD';
  d.user.partyBoard = { ...structuredClone(BOARD), ...over };
  return d;
}

function doneAction(path, body, n) {
  return { action: { id: `p${n}`, user: body.user, kind: body.kind, value: body.value ?? null, ref: null, notify: false, created: Date.now(), status: 'done', result: 'Done here.' } };
}

const inputByLabel = (root, text) => {
  const label = walk(root).find((n) => n.localName === 'label' && n.textContent.trim() === text);
  return label ? walk(root).find((n) => n.id === label.htmlFor) : null;
};

test('the Party leaderboard card shows current numbers prefilled and saves exact values', async () => {
  state.partyOwner = true;
  const posts = [];
  let gets = 0;
  const { main, stop } = mount(owner.renderOwnerUser, {
    params: { id: ID },
    get: async () => { gets += 1; return boardDetail(gets > 1 ? { points: 10 } : {}); },
    post: async (path, body) => { posts.push(body); return doneAction(path, body, posts.length); },
  });
  await flush();
  const text = main.textContent;
  for (const bit of ['Party leaderboard', 'On the leaderboards', '100,000', '#1', '50,000 · 🧠 Trivia', '🖐️ Name 5', 'Today: 100,000 points from 11 games.']) assert.ok(text.includes(bit), bit);
  const pts = inputByLabel(main, 'All-time points');
  assert.equal(pts.value, '100000');
  assert.equal(inputByLabel(main, 'Total games').value, '11');
  assert.equal(inputByLabel(main, 'Total wins').value, '4');
  assert.equal(inputByLabel(main, 'Best score').value, '50000');
  assert.equal(inputByLabel(main, "This month's points").value, '100000');
  assert.equal(inputByLabel(main, 'Trivia steals').value, '12');
  assert.equal(inputByLabel(main, 'Fakers caught').value, '0');
  const picker = walk(main).filter((n) => n.localName === 'select');
  assert.equal(picker.length, 2);
  assert.equal(walk(picker[1]).filter((n) => n.localName === 'option').length, owner.PARTY_GAME_IDS.length);
  assert.ok(owner.PARTY_GAME_IDS.includes('namefive') && owner.PARTY_GAME_IDS.includes('memory'));
  pts.value = '1,000';
  byLabel(main, 'Save points').click();
  await flush();
  assert.deepEqual(posts[0], { user: ID, kind: 'party.points.set', value: 1000 });
  await flush();
  assert.equal(gets, 2, 'a finished change reloads the numbers');
  await flush();
  assert.equal(pts.value, '10');
  inputByLabel(main, 'Total wins').value = '20';
  byLabel(main, 'Save games and wins').click();
  await flush();
  assert.equal(posts.length, 1);
  assert.match(document.body.textContent, /Wins can't be more than games/);
  inputByLabel(main, 'Total wins').value = '0';
  inputByLabel(main, 'Total games').value = '2';
  byLabel(main, 'Save games and wins').click();
  await flush();
  assert.deepEqual(posts[1].value, { games: 2, wins: 0 });
  byLabel(main, 'Edit Name 5 points').click();
  const gp = inputByLabel(main, 'Points in this game');
  assert.equal(gp.value, '50000');
  gp.value = '0';
  byLabel(main, 'Save game points').click();
  await flush();
  assert.deepEqual(posts[2].value, { game: 'namefive', points: 0 });
  inputByLabel(main, 'Best score').value = '800';
  picker[0].value = 'memory';
  byLabel(main, 'Save best game').click();
  await flush();
  assert.deepEqual(posts[3].value, { score: 800, game: 'memory' });
  byLabel(main, 'Clear').click();
  await flush();
  assert.deepEqual(posts[4].value, { score: 0 });
  inputByLabel(main, 'Trivia steals').value = '0';
  byLabel(main, 'Save counters').click();
  await flush();
  assert.deepEqual(posts[5].value, { steals: 0 });
  inputByLabel(main, "This month's points").value = '5';
  byLabel(main, 'Save month').click();
  await flush();
  assert.deepEqual(posts[6], { user: ID, kind: 'party.month.set', value: 5 });
  stop();
});

test('removing from leaderboards and resetting ask first; hidden people can be shown again', async () => {
  state.partyOwner = true;
  const posts = [];
  let hidden = false;
  const { main, stop } = mount(owner.renderOwnerUser, {
    params: { id: ID },
    get: async () => boardDetail({ hidden }),
    post: async (path, body) => { posts.push(body); if (body.kind === 'party.board.hide') hidden = true; return doneAction(path, body, posts.length); },
  });
  await flush();
  const hideButtons = buttons(main).filter((b) => b.textContent.trim() === 'Remove from leaderboards');
  assert.equal(hideButtons.length, 2);
  hideButtons[0].click();
  await flush();
  let dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Remove XD from the Party leaderboards\?/);
  byLabel(dialog, 'Cancel').click();
  await flush();
  assert.equal(posts.length, 0);
  hideButtons[0].click();
  await flush();
  byLabel(document.body.querySelector('.dialog-panel'), 'Yes, do it').click();
  await flush();
  await flush();
  assert.deepEqual(posts[0], { user: ID, kind: 'party.board.hide' });
  assert.match(main.textContent, /Hidden from leaderboards/);
  assert.ok(buttons(main).filter((b) => b.textContent.trim() === 'Remove from leaderboards').every((b) => b.hidden));
  byLabel(main, 'Show on leaderboards again').click();
  await flush();
  assert.deepEqual(posts[1], { user: ID, kind: 'party.board.show' });
  const check = inputByLabel(main, 'Also reset badge stats, counters and daily streak');
  check.checked = true;
  byLabel(main, 'Reset Party stats').click();
  await flush();
  dialog = document.body.querySelector('.dialog-panel');
  assert.match(dialog.textContent, /Reset XD's Party leaderboard stats\?/);
  assert.match(dialog.textContent, /badges they earned go away/);
  byLabel(dialog, 'Yes, do it').click();
  await flush();
  assert.deepEqual(posts[2], { user: ID, kind: 'party.reset', value: { badges: true } });
  assert.equal(owner.describeAction({ kind: 'party.game.set', value: { game: 'trivia', points: 0 } }), 'Set 🧠 Trivia points to 0');
  assert.equal(owner.describeAction({ kind: 'party.best.set', value: { score: 0 } }), 'Clear best Party game');
  assert.equal(owner.describeAction({ kind: 'party.counters.set', value: { steals: 3 } }), 'Set Party badge counters: Trivia steals 3');
  assert.equal(owner.readBoard({ bestGame: 'constructor', byGame: [{ game: '__proto__' }] }).bestGame, '');
  assert.deepEqual(owner.readBoard(null).byGame, []);
  stop();
});
