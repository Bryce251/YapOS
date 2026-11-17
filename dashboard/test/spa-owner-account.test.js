import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/owner' });
document.documentElement = document.createElement('html');
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { state } = await import('../web/js/state.js');
const owner = await import('../web/js/pages/owner.js');
const { normalizeProfile, badgeInfo, BADGES } = await import('../web/js/community-data.js');
const { profileCard } = await import('../web/js/pages/profile.js');

const ID = '88888888-8888-4888-8888-00000000dead';

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const buttons = (root) => walk(root).filter((n) => n.localName === 'button');
const byLabel = (root, text) => buttons(root).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);

function detail(user) {
  return {
    user: { id: ID, username: '', name: '', avatar: null, level: null, shards: null, xp: null, seen: null, badges: [], earnedBadges: [], achievements: [], clan: null, party: { games: 0, wins: 0 }, known: false, ...user },
    actions: [],
    catalog: { achievements: [], badges: [{ id: 'einstein', label: 'Einstein', emoji: '🧠', source: 'bot' }], kinds: [] },
  };
}

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
      get,
      post: post || (async (path, body) => {
        posts.push({ path, body });
        return { action: { id: `a${posts.length}`, user: body.user, kind: body.kind, value: null, ref: null, notify: false, created: Date.now(), status: 'done', result: 'Hid them.' } };
      }),
    },
    setChrome() {},
    setTitle(t) { ctx.title = t; },
    navigate(href) { ctx.went = href; },
  };
  render(ctx);
  return { main, ctx, posts, stop: () => ctrl.abort() };
}

test('a made-up id shows a clear "not a real account" page with no way to give it anything', async () => {
  state.partyOwner = true;
  const { main, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => detail({ account: 'fake' }) });
  await flush();
  assert.match(main.textContent, /That isn't a real Yapin' account\. Check the id\./);
  assert.equal(byLabel(main, 'Give'), undefined);
  assert.equal(walk(main).some((n) => n.localName === 'input'), false);
  assert.equal(byLabel(main, 'Hide it from the global leaderboard'), undefined, 'nothing to clean up for an id that was never used');
  stop();
});

test('a made-up id that already sits on the board can be hidden from there', async () => {
  state.partyOwner = true;
  const { main, posts, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => detail({ account: 'fake', known: true, shards: 50000 }) });
  await flush();
  const hide = byLabel(main, 'Hide it from the global leaderboard');
  assert.ok(hide);
  hide.click();
  await flush();
  byLabel(document.body, 'Yes, do it').click();
  await flush();
  assert.deepEqual(posts.map((p) => p.body.kind), ['global.hide']);
  stop();
});

test('an id still being checked waits, then shows the real person with their name first', async () => {
  state.partyOwner = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let account = 'checking';
    const { main, stop } = mount(owner.renderOwnerUser, { params: { id: ID }, get: async () => detail({ account, name: 'Juno', username: 'juno', known: true }) });
    await flush();
    assert.match(main.textContent, /Checking this account with Yapin'/);
    assert.equal(byLabel(main, 'Give'), undefined);
    account = 'real';
    mock.timers.tick(owner.POLL_MS);
    await flush();
    assert.match(main.textContent, /Juno/);
    assert.match(main.textContent, /@juno/);
    assert.match(main.textContent, /Real Yapin' account/);
    assert.ok(byLabel(main, 'Give'));
    assert.match(main.textContent, /Can only be given by Jolli/);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('a send refused as not a real account switches the page to the warning', async () => {
  state.partyOwner = true;
  const { ApiError } = await import('../web/js/api.js');
  const { main, stop } = mount(owner.renderOwnerUser, {
    params: { id: ID },
    get: async () => detail({ account: 'real', name: 'Juno', known: true }),
    post: async () => { throw new ApiError("That isn't a real Yapin' account. Check the id.", { status: 400, code: 'not_a_user' }); },
  });
  await flush();
  byLabel(main, 'Give Einstein').click();
  await flush();
  assert.match(main.textContent, /That isn't a real Yapin' account/);
  assert.equal(byLabel(main, 'Give Einstein'), undefined);
  stop();
});

test('search marks a made-up id clearly', async () => {
  state.partyOwner = true;
  const { main, stop } = mount(owner.renderOwner, {
    get: async (path) => (path.startsWith(owner.OWNER_USERS_PATH) ? { users: [{ id: ID, account: 'fake' }] } : { actions: [] }),
  });
  await flush();
  assert.match(main.textContent, /Not a real Yapin' account/);
  stop();
});

test('readUser keeps the account state and older answers count as real', () => {
  assert.equal(owner.readUser({ id: ID, account: 'fake' }).account, 'fake');
  assert.equal(owner.readUser({ id: ID, account: 'checking' }).account, 'checking');
  assert.equal(owner.readUser({ id: ID }).account, 'real');
  assert.equal(owner.readUser({ id: ID, account: 'weird' }).account, 'real');
});

test('the Einstein badge shows on profiles with its brain and says only Jolli can give it', () => {
  assert.deepEqual(BADGES.einstein, { label: 'Einstein', emoji: '🧠', note: 'Can only be given by Jolli' });
  assert.deepEqual(badgeInfo('einstein'), { id: 'einstein', label: 'Einstein', emoji: '🧠', note: 'Can only be given by Jolli' });
  assert.equal(badgeInfo('first-game').note, undefined);
  const p = normalizeProfile({ profile: { name: 'Juno', username: 'juno', badges: ['first-game', 'einstein'] }, catalog: { badges: [{ id: 'einstein', label: 'Einstein', emoji: '🧠' }] } });
  const e = p.badges.find((b) => b.id === 'einstein');
  assert.equal(e.note, 'Can only be given by Jolli');
  const card = profileCard(p);
  assert.match(card.textContent, /Einstein/);
  assert.match(card.textContent, /Can only be given by Jolli/);
  const tile = walk(card).find((n) => n.className === 'badge-tile has-note');
  assert.ok(tile);
  assert.match(tile.getAttribute('title') || tile.title || '', /Can only be given by Jolli/);
});
