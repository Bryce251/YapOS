import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installDom, flush, FakeEvent, type } from './dom-shim.js';

const { document } = installDom({ url: 'https://dash.example.test/p/global' });
document.documentElement = document.createElement('html');
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { renderPublic } = await import('../web/js/pages/public.js');
const { actionBody, askFirst, canManage, expectedAfter, QUEUED_NOTE } = await import('../web/js/pages/board-person.js');
const { boardPeople, normalizeBoard } = await import('../web/js/public-data.js');
const { OWNER_ACTIONS_PATH, OWNER_USERS_PATH } = await import('../web/js/pages/owner.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const TEARYU = '66666666-6666-4666-8666-000000000002';
const MWA = '66666666-6666-4666-8666-000000000001';
const BUNNY = '66666666-6666-4666-8666-000000000003';

const DATA = {
  updatedAt: Date.now(),
  levels: [
    { rank: 1, id: TEARYU, name: 'Tearyu', level: 30, xp: 30000, messages: 900, handle: 'tearyu' },
    { rank: 2, id: MWA, name: 'mwa', level: 1, xp: 50, messages: 2 },
  ],
  economy: [
    { rank: 1, id: TEARYU, name: 'Tearyu', balance: 74633, handle: 'tearyu' },
    { rank: 2, id: MWA, name: 'mwa', balance: 50000 },
    { rank: 3, id: BUNNY, name: 'bunny', balance: 25205 },
  ],
};

function click(el) {
  el.dispatchEvent(new FakeEvent('click', { bubbles: true }));
}

function key(name) {
  const e = new FakeEvent('keydown', { bubbles: true, key: name });
  document.dispatchEvent(e);
  return e;
}

function buttons(root, re) {
  return [...root.querySelectorAll('button')].filter((b) => re.test(b.textContent) || re.test(b.getAttribute('aria-label') || ''));
}

function mount({ owner = false, onPost = null, detail = null } = {}) {
  const calls = [];
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const ctrl = new AbortController();
  const api = {
    get: async (p) => {
      calls.push(['GET', p]);
      if (p.startsWith(OWNER_USERS_PATH)) {
        if (!owner) throw new Error('not for you');
        if (detail) return detail;
        return { user: { id: MWA, name: 'mwa', username: null, level: 1, xp: 50, shards: 50000, globalHidden: false }, actions: [], catalog: {} };
      }
      return DATA;
    },
    post: async (p, body) => {
      calls.push(['POST', p, body]);
      if (onPost) return onPost(p, body);
      return { action: { id: `act${calls.length}`, user: body.user, kind: body.kind, value: body.value ?? null, status: 'queued', created: Date.now() } };
    },
  };
  const ctx = { params: { slug: 'global' }, signal: ctrl.signal, api, setTitle() {}, getViewer: async () => ({ user: owner ? { id: 'o' } : null, partyOwner: owner }) };
  renderPublic(root, ctx);
  return { root, calls, ctrl };
}

function cleanup(ctrl) {
  ctrl.abort();
  for (const r of document.querySelectorAll('.drawer-root')) r.remove();
  for (const r of document.querySelectorAll('.dialog-root')) r.remove();
  document.body.classList.remove('has-modal');
}

test('every leaderboard row is a real button that says it opens a dialog', async () => {
  const { root, ctrl } = mount();
  await flush();
  const rows = root.querySelectorAll('.board button.board-row');
  assert.equal(rows.length, 2);
  for (const b of rows) {
    assert.equal(b.tagName.toLowerCase(), 'button');
    assert.equal(b.type, 'button');
    assert.equal(b.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(b.parentNode.tagName.toLowerCase(), 'li');
  }
  click(buttons(root, /^Shards$|Shards/).find((b) => b.classList.contains('tab')));
  assert.equal(root.querySelectorAll('.board button.board-row').length, 3);
  cleanup(ctrl);
});

test('clicking a row opens their profile for anyone, with no mod view for non-owners', async () => {
  const { root, calls, ctrl } = mount({ owner: false });
  await flush();
  const row = root.querySelector('.board button.board-row');
  row.focus();
  click(row);
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.ok(panel, 'a profile window opened');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.ok(panel.querySelector('.avatar-xl'));
  const text = panel.textContent;
  assert.match(text, /Tearyu/);
  assert.match(text, /@tearyu/);
  assert.match(text, /Levels rank#1/);
  assert.match(text, /Level30/);
  assert.match(text, /XP30,000/);
  assert.match(text, /Shards rank#1/);
  assert.match(text, /74,633/);
  const full = [...panel.querySelectorAll('a')].find((a) => /View full profile/.test(a.textContent));
  assert.equal(full.href, '/u/tearyu');
  assert.equal(panel.querySelector('.bp-mod'), null);
  assert.equal(buttons(panel, /Set to 0|Take|Give|Hide/).length, 0);
  assert.ok(!calls.some((c) => c[1].startsWith('/api/owner')), 'non-owners never call owner routes');
  await new Promise((r) => setTimeout(r, 10));
  const esc = key('Escape');
  assert.equal(esc.defaultPrevented, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(document.querySelector('.drawer-root'), null, 'Escape closes it');
  assert.equal(document.activeElement, row, 'focus goes back to the row');
  cleanup(ctrl);
});

test('the close button and backdrop close the window', async () => {
  const { root, ctrl } = mount();
  await flush();
  click(root.querySelector('.board button.board-row'));
  await flush();
  click(document.querySelector('.drawer-panel button[aria-label="Close panel"]'));
  assert.ok(document.querySelector('.drawer-root').classList.contains('is-closing'));
  await new Promise((r) => setTimeout(r, 200));
  click(root.querySelectorAll('.board button.board-row')[1]);
  await flush();
  const panel = document.querySelector('.drawer-panel');
  assert.match(panel.textContent, /mwa/);
  assert.match(panel.textContent, /don't have a public profile/);
  click(document.querySelector('.drawer-overlay'));
  assert.ok(document.querySelector('.drawer-root').classList.contains('is-closing'));
  cleanup(ctrl);
});

test('the owner gets a mod view and Set to 0 asks first, then posts the right body', async () => {
  const { root, calls, ctrl } = mount({ owner: true });
  await flush();
  click(buttons(root, /Shards/).find((b) => b.classList.contains('tab')));
  click(root.querySelectorAll('.board button.board-row')[1]);
  await flush();
  await flush();
  const panel = document.querySelector('.drawer-panel');
  const mod = panel.querySelector('.bp-mod');
  assert.ok(mod, 'the owner sees the mod view');
  assert.equal(mod.getAttribute('aria-label'), 'Mod view');
  assert.deepEqual(calls.filter((c) => c[1].startsWith(OWNER_USERS_PATH)).map((c) => c[1]), [`${OWNER_USERS_PATH}/${MWA}`]);
  for (const re of [/^Set to 0$/, /^Set Shards$/, /^Take$/, /^Give$/, /^Set level$/, /^Take XP$/, /Hide from leaderboards/]) assert.equal(buttons(mod, re).length, 1, String(re));
  const ownerLink = [...mod.querySelectorAll('a')].find((a) => /Open in owner panel/.test(a.textContent));
  assert.equal(ownerLink.href, `/owner/${MWA}`);

  click(buttons(mod, /^Set to 0$/)[0]);
  await flush();
  const dlg = document.querySelector('.dialog-root');
  assert.ok(dlg, 'setting Shards to 0 asks first');
  assert.match(dlg.textContent, /Set mwa's Shards to 0\?/);
  assert.match(dlg.textContent, /50,000/);
  click(buttons(dlg, /^Cancel$/)[0]);
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'POST').length, 0, 'cancel sends nothing');

  click(buttons(mod, /^Set to 0$/)[0]);
  await flush();
  click(buttons(document.querySelector('.dialog-root'), /Yes, do it/)[0]);
  await flush();
  await flush();
  const posts = calls.filter((c) => c[0] === 'POST');
  assert.deepEqual(posts, [['POST', OWNER_ACTIONS_PATH, { user: MWA, kind: 'shards.set', value: 0 }]]);
  const shards = [...panel.querySelectorAll('.bp-stat')].find((el) => el.dataset.stat === 'shards');
  assert.ok(shards.classList.contains('is-pending'));
  assert.match(shards.textContent, /0 .*Pending/);
  const toastText = document.querySelector('.toast-root').textContent;
  assert.match(toastText, /sent to YapOS/);
  assert.match(toastText, /leaderboard/);
  cleanup(ctrl);
});

test('owner amount buttons post Give, Take, Set level and Take XP bodies', async () => {
  const { root, calls, ctrl } = mount({ owner: true });
  await flush();
  click(root.querySelectorAll('.board button.board-row')[1]);
  await flush();
  await flush();
  const mod = document.querySelector('.bp-mod');
  const inputs = mod.querySelectorAll('input');
  const yes = async () => {
    await flush();
    const dlg = document.querySelector('.dialog-root');
    if (dlg) click(buttons(dlg, /Yes, do it/)[0]);
    await flush();
    await flush();
  };
  type(inputs[0], '1,000');
  click(buttons(mod, /^Give$/)[0]);
  await yes();
  type(inputs[0], '250');
  click(buttons(mod, /^Take$/)[0]);
  await yes();
  type(inputs[1], '0');
  click(buttons(mod, /^Set level$/)[0]);
  await yes();
  type(inputs[2], '40');
  click(buttons(mod, /^Take XP$/)[0]);
  await yes();
  type(inputs[0], 'lots');
  click(buttons(mod, /^Set Shards$/)[0]);
  await yes();
  const posts = calls.filter((c) => c[0] === 'POST').map((c) => c[2]);
  assert.deepEqual(posts, [
    { user: MWA, kind: 'shards.add', value: 1000 },
    { user: MWA, kind: 'shards.remove', value: 250 },
    { user: MWA, kind: 'level.set', value: 0 },
    { user: MWA, kind: 'xp.remove', value: 40 },
  ], 'a bad number never posts');
  cleanup(ctrl);
});

test('hiding a fake account takes it off the board on the page straight away', async () => {
  const { root, calls, ctrl } = mount({
    owner: true,
    onPost: (p, body) => ({ action: { id: 'h1', user: body.user, kind: body.kind, value: null, status: 'done', result: 'Hid them from the global leaderboard.', created: Date.now() } }),
  });
  await flush();
  click(buttons(root, /Shards/).find((b) => b.classList.contains('tab')));
  click(root.querySelectorAll('.board button.board-row')[1]);
  await flush();
  await flush();
  const mod = document.querySelector('.bp-mod');
  click(buttons(mod, /Hide from leaderboards/)[0]);
  await flush();
  const dlg = document.querySelector('.dialog-root');
  assert.match(dlg.textContent, /Hide mwa from the leaderboard\?/);
  click(buttons(dlg, /Yes, do it/)[0]);
  await flush();
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'POST').map((c) => c[2]), [{ user: MWA, kind: 'global.hide' }]);
  const names = [...root.querySelectorAll('.board .board-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['Tearyu', 'bunny']);
  assert.equal(root.querySelectorAll('.board .board-row')[1].textContent.trim().startsWith('2'), true);
  assert.match(document.querySelector('.drawer-panel').textContent, /Hidden from the leaderboard/);
  assert.equal(buttons(mod, /Show on leaderboards/)[0].hidden, false);
  cleanup(ctrl);
});

test('helpers: who can be managed, bodies, confirmations and expected numbers', () => {
  assert.equal(canManage({ id: MWA }), true);
  assert.equal(canManage({ id: 'u1' }), false);
  assert.deepEqual(actionBody(MWA.toUpperCase(), 'shards.set', 0), { user: MWA, kind: 'shards.set', value: 0 });
  assert.deepEqual(actionBody(MWA, 'global.hide'), { user: MWA, kind: 'global.hide' });
  assert.equal(expectedAfter('shards.set', 0, 50000), 0);
  assert.equal(expectedAfter('shards.remove', 60000, 50000), 0);
  assert.equal(expectedAfter('shards.add', 5, 10), 15);
  assert.equal(expectedAfter('shards.add', 5, null), null);
  const p = { name: 'mwa', shards: 50000, level: 3 };
  assert.ok(askFirst('shards.set', 0, p));
  assert.ok(askFirst('shards.set', 10, p));
  assert.equal(askFirst('shards.set', 60000, p), null);
  assert.ok(askFirst('shards.remove', 1, p));
  assert.ok(askFirst('xp.remove', 1, p));
  assert.ok(askFirst('level.set', 0, p));
  assert.ok(askFirst('global.hide', undefined, p));
  assert.equal(askFirst('shards.add', 5, p), null);
  assert.match(QUEUED_NOTE, /leaderboard/);
  const people = boardPeople(normalizeBoard(DATA.levels, 'levels'), normalizeBoard(DATA.economy, 'economy'));
  assert.deepEqual({ ...people.get(TEARYU) }, { id: TEARYU, name: 'Tearyu', avatar: '', handle: 'tearyu', levelRank: 1, level: 30, xp: 30000, messages: 900, shardsRank: 1, shards: 74633 });
  assert.equal(people.get(BUNNY).levelRank, null);
  assert.equal(normalizeBoard([{ id: 'x', name: 'x', handle: '../evil' }], 'economy')[0].handle, '');
});

test('the board row styles keep a visible focus ring and plain ASCII', () => {
  const css = readFileSync(path.join(here, '..', 'web', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.board-row-btn:focus-visible \{[^}]*outline: 2px solid/);
  assert.match(css, /\.board-row-btn:hover \{/);
});

test('the profile window hides whichever of Hide and Show does not apply and lays its numbers out with no gaps', () => {
  const css = readFileSync(path.join(here, '..', 'web', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.bp-row > \[hidden\] \{\s*display: none;/);
  for (const area of ['level', 'xp', 'lrank', 'shards', 'srank']) assert.match(css, new RegExp(`grid-area: ${area};`));
  assert.match(css, /"level xp lrank"\s*"shards shards srank"/);
  assert.match(css, /"level xp"\s*"lrank srank"\s*"shards shards"/);
});

test('the owner only gets a full profile link when that profile is public', async () => {
  for (const [hidden, expected] of [[true, false], [false, true]]) {
    const { root, ctrl } = mount({ owner: true, detail: { user: { id: MWA, name: 'mwa', username: 'mwa', hidden, level: 1, xp: 50, shards: 50000, globalHidden: false }, actions: [], catalog: {} } });
    await flush();
    click(root.querySelectorAll('.board button.board-row')[1]);
    await flush();
    await flush();
    await flush();
    const links = [...document.querySelector('.drawer-panel .bp-links').querySelectorAll('a')];
    assert.equal(links.some((a) => a.href === '/u/mwa'), expected, `hidden ${hidden}`);
    cleanup(ctrl);
  }
});
