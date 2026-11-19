import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeEvent, installDom, flush } from './dom-shim.js';

const { document, window } = installDom({ url: 'https://dash.example.test/' });
document.documentElement = document.createElement('html');
const store = new Map();
window.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const shellMod = await import('../web/js/shell.js');
const { createShell, siteHeader, accountGroups, navFor, activeItem, SITE_NAV } = shellMod;
const inbox = await import('../web/js/inbox-watch.js');
const { state } = await import('../web/js/state.js');

const ROOT = new URL('../web/', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const ME = { id: 'u-1', username: 'bea', display_name: 'Bea' };

function walk(node, out = []) {
  for (const c of node.childNodes || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

const els = (root) => walk(root).filter((n) => n.localName);
const key = (el, k) => el.dispatchEvent(new FakeEvent('keydown', { bubbles: true, key: k }));
const menuItems = (panel) => panel.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
const desktopItems = (panel) => menuItems(panel).filter((el) => !el.closest('.bar-only-phone'));
const byItem = (root, id) => els(root).find((e) => e.dataset && e.dataset.item === id) || null;
const labelOf = (el) => el.querySelector('.bar-item-label')?.textContent || '';
const navLabels = (bar) => bar.nav.querySelectorAll('a.bar-link').map((a) => a.textContent);
const hrefs = (root) => walk(root).filter((n) => n.localName === 'a').map((a) => a.href);

function mountShell(opts) {
  const shell = createShell({ onLogout() {} });
  document.body.replaceChildren(shell.root);
  shell.update({ variant: 'plain', crumbs: [], ...opts });
  return shell;
}

function asPhone(fn) {
  const before = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} });
  try {
    return fn();
  } finally {
    window.matchMedia = before;
  }
}

test('signed out visitors get the logo, the public pages, a theme toggle and Sign in', () => {
  const header = siteHeader({ current: '/p/global' });
  document.body.replaceChildren(header.el);
  const { bar } = header;
  assert.ok(header.el.querySelector('a.brand'));
  assert.deepEqual(navLabels(bar), ['Leaderboard', 'Party', 'Seasons', 'Word packs']);
  const signIn = bar.actions.querySelectorAll('a').find((a) => /Sign in/.test(a.textContent));
  assert.ok(signIn);
  assert.match(signIn.href, /^\/auth\/login\?next=/);
  assert.ok(bar.actions.querySelector('.theme-toggle'));
  assert.equal(bar.actions.querySelector('.bell-link'), null);
  assert.equal(bar.actions.querySelector('.bar-account'), null);
  assert.ok(bar.burger.isConnected);
  assert.equal(byItem(bar.panel, 'signout'), null);
  assert.deepEqual(desktopItems(bar.panel).map(labelOf), ['Light', 'Dark', 'System']);
  assert.deepEqual(accountGroups({ user: null }), []);
});

test('members get Servers, Clans, Leaderboard and Party, with the account menu behind their avatar', () => {
  const shell = mountShell({ user: ME });
  const { bar } = shell;
  assert.deepEqual(navLabels(bar), ['Servers', 'Clans', 'Leaderboard', 'Party']);
  assert.equal(bar.nav.querySelector('a[href]') && bar.nav.querySelectorAll('a').find((a) => a.textContent === 'Leaderboard').href, '/p/global');
  assert.equal(bar.nav.querySelectorAll('a').find((a) => a.textContent === 'Party').href, '/party/leaderboard');
  assert.ok(bar.actions.querySelector('.bell-link'));
  assert.equal(bar.accountBtn.getAttribute('aria-haspopup'), 'menu');
  assert.match(bar.accountBtn.getAttribute('aria-label'), /Account menu for Bea/);
  assert.ok(bar.accountBtn.title);
  assert.deepEqual(desktopItems(bar.panel).map(labelOf), ['View profile', 'Edit profile', 'Inbox', 'Your account', 'Word packs', 'Add YapOS to a server', 'Light', 'Dark', 'System', 'Sign out']);
  const groups = bar.panel.querySelectorAll('[role="group"]').map((g) => g.getAttribute('aria-label'));
  assert.ok(!groups.includes('Staff'));
  assert.ok(!groups.includes('Owner'));
  const all = hrefs(shell.root);
  for (const href of ['/servers', '/clans', '/p/global', '/party/leaderboard', '/inbox', '/account', '/packs', '/u/bea', '/u/bea?edit=1']) assert.ok(all.includes(href), href);
  for (const href of ['/party/reports', '/party/modlog', '/owner', '/party']) assert.ok(!all.includes(href), href);
  for (const item of desktopItems(bar.panel)) {
    assert.ok(item.querySelector('svg'), `${labelOf(item)} has an icon`);
    assert.ok(labelOf(item), 'every item has a label');
  }
});

test('staff get a Staff group with reports and the mod log, and only the owner gets the Owner group', () => {
  const staff = mountShell({ user: ME, partyAdmin: true });
  const groupNames = (s) => s.bar.panel.querySelectorAll('[role="group"]').map((g) => g.getAttribute('aria-label'));
  assert.ok(groupNames(staff).includes('Staff'));
  assert.ok(!groupNames(staff).includes('Owner'));
  const staffGroup = staff.bar.panel.querySelector('.bar-group-staff');
  assert.deepEqual(menuItems(staffGroup).map(labelOf), ['Party reports', 'Party mod log']);
  assert.equal(staffGroup.querySelector('.bar-group-label').textContent, 'Staff');
  assert.ok(!hrefs(staff.root).includes('/owner'));

  const owner = mountShell({ user: ME, partyOwner: true });
  assert.ok(groupNames(owner).includes('Staff'));
  assert.ok(groupNames(owner).includes('Owner'));
  const ownerGroup = owner.bar.panel.querySelector('.bar-group-owner');
  assert.deepEqual(menuItems(ownerGroup).map(labelOf), ['Owner panel', 'Party admins']);
  assert.deepEqual(menuItems(ownerGroup).map((a) => a.href), ['/owner', '/party']);
  const order = desktopItems(owner.bar.panel).map(labelOf);
  assert.ok(order.indexOf('Party mod log') < order.indexOf('Owner panel'));
  assert.ok(order.indexOf('Party admins') < order.indexOf('Light'));
  assert.equal(order.at(-1), 'Sign out');
});

test('the current page is highlighted with aria-current in the nav and the menu', () => {
  const clans = mountShell({ user: ME, section: 'clans' });
  const current = clans.bar.nav.querySelectorAll('[aria-current="page"]');
  assert.equal(current.length, 1);
  assert.equal(current[0].textContent, 'Clans');
  assert.ok(current[0].classList.contains('is-active'));

  const inboxPage = mountShell({ user: ME, section: 'inbox' });
  assert.equal(byItem(inboxPage.bar.panel, 'inbox').getAttribute('aria-current'), 'page');
  assert.equal(inboxPage.bar.actions.querySelector('.bell-link').getAttribute('aria-current'), 'page');
  assert.equal(inboxPage.bar.nav.querySelectorAll('[aria-current="page"]').length, 0);

  const server = createShell({ onLogout() {} });
  server.update({ variant: 'server', section: 'stats', server: { id: 'srv', name: 'Town' }, user: ME, crumbs: [] });
  assert.equal(server.root.querySelector('.sidebar-site').querySelector('[aria-current="page"]').textContent, 'Servers');

  const guestSeasons = navFor(null);
  assert.equal(activeItem(guestSeasons, '/seasons'), 'seasons');
  assert.equal(activeItem(navFor(ME), '/seasons'), 'party');
  assert.equal(activeItem(navFor(ME), '/p/global'), 'leaderboard');
  assert.equal(activeItem(navFor(ME), '/servers/abc/stats'), 'servers');
  assert.equal(activeItem(navFor(ME), '/party/leaderboard'), 'party');
  assert.equal(activeItem(navFor(ME), '/party/reports'), '');

  const pub = siteHeader({ current: '/p/global' });
  assert.equal(pub.bar.nav.querySelector('[aria-current="page"]').textContent, 'Leaderboard');
  assert.equal(SITE_NAV.find((n) => n.id === 'leaderboard').href, '/p/global');
});

test('the account menu opens from the keyboard, moves with arrows and closes with Escape', () => {
  const shell = mountShell({ user: ME, partyOwner: true });
  const { bar } = shell;
  const btn = bar.accountBtn;
  assert.equal(bar.panel.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(bar.panel.getAttribute('role'), 'menu');
  assert.equal(btn.getAttribute('aria-controls'), bar.panel.id);

  key(btn, 'ArrowDown');
  assert.equal(bar.panel.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const items = desktopItems(bar.panel);
  assert.equal(document.activeElement, items[0]);
  assert.equal(labelOf(document.activeElement), 'View profile');
  for (const item of items) assert.equal(item.tabIndex, -1);

  key(document.activeElement, 'ArrowDown');
  assert.equal(labelOf(document.activeElement), 'Edit profile');
  key(document.activeElement, 'ArrowUp');
  key(document.activeElement, 'ArrowUp');
  assert.equal(labelOf(document.activeElement), 'Sign out');
  key(document.activeElement, 'ArrowDown');
  assert.equal(labelOf(document.activeElement), 'View profile');
  key(document.activeElement, 'End');
  assert.equal(labelOf(document.activeElement), 'Sign out');
  key(document.activeElement, 'Home');
  assert.equal(labelOf(document.activeElement), 'View profile');

  key(document.activeElement, 'Escape');
  assert.equal(bar.panel.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, btn);

  key(btn, 'Enter');
  assert.equal(bar.panel.hidden, false);
  assert.equal(labelOf(document.activeElement), 'View profile');
  key(btn, 'Escape');
  assert.equal(bar.panel.hidden, true);

  key(btn, ' ');
  assert.equal(bar.panel.hidden, false);
  key(document.activeElement, 'Tab');
  assert.equal(bar.panel.hidden, true);

  key(btn, 'ArrowUp');
  assert.equal(labelOf(document.activeElement), 'Sign out');
  key(document.activeElement, 'Escape');
});

test('clicking outside or picking an item closes the menu, and Sign out calls the logout', async () => {
  let out = 0;
  const shell = createShell({ onLogout: () => { out += 1; } });
  document.body.replaceChildren(shell.root);
  shell.update({ variant: 'plain', user: ME, crumbs: [] });
  const { bar } = shell;
  await flush(1);
  bar.accountBtn.click();
  assert.equal(bar.panel.hidden, false);
  bar.panel.querySelector('.bar-who').click();
  assert.equal(bar.panel.hidden, false);
  document.body.click();
  assert.equal(bar.panel.hidden, true);

  bar.accountBtn.click();
  bar.accountBtn.click();
  assert.equal(bar.panel.hidden, true);

  bar.accountBtn.click();
  byItem(bar.panel, 'account').click();
  assert.equal(bar.panel.hidden, true);

  bar.accountBtn.click();
  byItem(bar.panel, 'signout').click();
  assert.equal(out, 1);
  assert.equal(bar.panel.hidden, true);
});

test('the theme choice in the menu covers Light, Dark and System', () => {
  store.clear();
  const shell = mountShell({ user: ME });
  const radios = () => shell.bar.panel.querySelectorAll('[role="menuitemradio"]');
  shell.bar.accountBtn.click();
  assert.deepEqual(radios().map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true']);
  radios()[1].click();
  assert.equal(store.get('yapos-theme'), 'dark');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.deepEqual(radios().map((r) => r.getAttribute('aria-checked')), ['false', 'true', 'false']);
  radios()[2].click();
  assert.equal(store.has('yapos-theme'), false);
  assert.equal(document.documentElement.getAttribute('data-theme'), null);
  assert.deepEqual(radios().map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true']);
  assert.equal(shell.bar.panel.querySelector('[role="group"][aria-label="Theme"]') !== null, true);
  shell.bar.close(false);
});

test('on phones the hamburger opens one sheet with the pages and every account item, labelled', () => {
  asPhone(() => {
    const shell = mountShell({ user: ME, partyOwner: true });
    const { bar } = shell;
    assert.equal(bar.burger.getAttribute('aria-haspopup'), 'menu');
    assert.ok(bar.burger.title);
    bar.burger.click();
    assert.equal(bar.panel.hidden, false);
    assert.equal(bar.panel.dataset.from, 'sheet');
    assert.equal(bar.burger.getAttribute('aria-expanded'), 'true');
    assert.equal(bar.burger.getAttribute('aria-label'), 'Close menu');
    assert.equal(bar.accountBtn.getAttribute('aria-expanded'), 'false');
    const labels = menuItems(bar.panel).map(labelOf);
    assert.deepEqual(labels.slice(0, 4), ['Servers', 'Clans', 'Leaderboard', 'Party']);
    for (const want of ['View profile', 'Edit profile', 'Inbox', 'Your account', 'Word packs', 'Party reports', 'Party mod log', 'Owner panel', 'Party admins', 'Light', 'Dark', 'System', 'Sign out']) assert.ok(labels.includes(want), want);
    assert.equal(labelOf(document.activeElement), 'Servers');
    key(document.activeElement, 'ArrowDown');
    assert.equal(labelOf(document.activeElement), 'Clans');
    assert.ok(bar.actions.querySelector('.bell-link'), 'the bell stays in the bar');
    key(document.activeElement, 'Escape');
    assert.equal(document.activeElement, bar.burger);
    assert.equal(bar.burger.getAttribute('aria-label'), 'Open menu');
  });

  asPhone(() => {
    const header = siteHeader({ current: '/seasons' });
    document.body.replaceChildren(header.el);
    header.bar.burger.click();
    const labels = menuItems(header.bar.panel).map(labelOf);
    assert.deepEqual(labels, ['Leaderboard', 'Party', 'Seasons', 'Word packs', 'Light', 'Dark', 'System']);
    assert.equal(byItem(header.bar.panel, 'seasons').getAttribute('aria-current'), 'page');
    header.bar.close(false);
  });

  const css = read('css/header.css');
  const phone = css.slice(css.indexOf('@media (max-width: 719.98px)'));
  assert.ok(phone.length > 30);
  assert.match(phone, /\.bar-burger \{\s*display: inline-grid;\s*width: 44px;\s*height: 44px;/);
  assert.match(phone, /\.bar-item \{\s*min-height: 48px;/);
  assert.match(phone, /\.bar-nav,\s*\.shell-plain \.topbar-nav \{\s*display: none;/);
  assert.match(phone, /left: 0;\s*width: auto;\s*max-width: 100vw;/);
  assert.match(phone, /\.bar-bell \{\s*width: 44px;\s*height: 44px;/);
});

test('the bell is always in the bar and follows the unread count, in the menu too', () => {
  for (const variant of ['plain', 'server']) {
    const shell = createShell({ onLogout() {} });
    shell.update({ variant, server: variant === 'server' ? { id: 's', name: 'Town' } : null, user: ME, crumbs: [] });
    const bell = shell.bar.actions.querySelector('.bell-link');
    assert.ok(bell, variant);
    assert.equal(bell.title, 'Inbox');
    shell.setUnread(5);
    assert.equal(shell.unread, 5);
    assert.equal(bell.querySelector('.bell-count').textContent, '5');
    assert.equal(bell.getAttribute('aria-label'), 'Inbox, 5 unread');
    const item = byItem(shell.bar.panel, 'inbox');
    assert.equal(item.getAttribute('aria-label'), 'Inbox, 5 unread');
    assert.equal(item.querySelector('.bell-count').textContent, '5');
    shell.update({ variant, server: variant === 'server' ? { id: 's', name: 'Town' } : null, user: ME, crumbs: [] });
    assert.equal(shell.bar.actions.querySelector('.bell-link .bell-count').textContent, '5');
    shell.setUnread(0);
    assert.equal(shell.bar.actions.querySelector('.bell-link .bell-count').hidden, true);
  }
});

test('public headers follow the inbox count once someone is signed in', async () => {
  const calls = [];
  const api = { get: async (path) => { calls.push(path); return { unread: 3, newest: [] }; } };
  const primary = [];
  inbox.startInboxWatch({ api, onCount: (n) => primary.push(n) });
  await flush();
  assert.equal(inbox.inboxUnread(), 3);
  state.partyAdmin = true;
  const header = siteHeader({ current: '/party/leaderboard' });
  document.body.replaceChildren(header.el);
  header.setUser(ME);
  assert.equal(header.bar.actions.querySelector('.bell-link .bell-count').textContent, '3');
  assert.ok(header.bar.panel.querySelector('.bar-group-staff'));
  inbox.inboxCountChanged(7);
  assert.equal(header.bar.actions.querySelector('.bell-link .bell-count').textContent, '7');
  inbox.startInboxWatch({ api });
  inbox.inboxCountChanged(2);
  assert.equal(primary.at(-1), 2);
  inbox.stopInboxWatch();
  state.partyAdmin = false;
  assert.equal(header.bar.actions.querySelector('.bell-link .bell-count').hidden, true);
});

test('the header uses no inline styles, no markup strings and no comments', () => {
  const shell = mountShell({ user: { ...ME, avatar_url: 'https://cdn.example.test/a.png' }, partyOwner: true });
  const header = siteHeader({ current: '/' });
  for (const root of [shell.root, header.el]) {
    for (const el of els(root)) {
      assert.equal(el.getAttribute('style'), null, el.localName);
      for (const prop of Object.keys(el.style.props)) assert.ok(prop.startsWith('--'), prop);
    }
  }
  for (const file of ['js/shell.js', 'js/public-frame.js', 'js/inbox-watch.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/, file);
    assert.doesNotMatch(src, /\.style\.(?!setProperty)/, file);
    assert.doesNotMatch(src, /^\s*\/\/|\/\*/m, file);
  }
  const css = read('css/header.css');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(css), 'header.css is plain ASCII');
  assert.doesNotMatch(css, /\/\*/);
  assert.match(read('index.html'), /<link rel="stylesheet" href="\/css\/header\.css">/);
});
