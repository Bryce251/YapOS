import { h, nextId, replace } from './dom.js';
import { icon, logoMark } from './icons.js';
import { avatar, linkButton } from './ui.js';
import { clearTheme, setTheme, themeChoice, themeToggle } from './theme.js';
import { loginUrl, normalizePath, profilePath, serverPath } from './router.js';
import { levelLabel } from './format.js';
import { ADD_BOT_URL } from './links.js';
import { forgetAll, state } from './state.js';
import { createApi } from './api.js';
import { inboxUnread, watchInboxCount } from './inbox-watch.js';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'overview', sub: '' },
  { id: 'stats', label: 'Stats', icon: 'chart', sub: 'stats' },
  { id: 'members', label: 'Members', icon: 'users', sub: 'members' },
  { id: 'mod', label: 'Moderation', icon: 'shield', sub: 'mod' },
  { id: 'tickets', label: 'Tickets', icon: 'ticket', sub: 'tickets' },
  { id: 'cases', label: 'Cases', icon: 'list', sub: 'cases' },
  { id: 'apps', label: 'Apps', icon: 'apps', sub: 'apps' },
  { id: 'public-settings', label: 'Public page', icon: 'globe', sub: 'public' },
];

export const LEADERBOARD_HREF = '/p/global';
export const PHONE_QUERY = '(max-width: 719.98px)';

export const SITE_NAV = [
  { id: 'servers', label: 'Servers', href: '/servers', icon: 'server', title: 'Your servers', who: 'member', paths: ['/servers', '/servers/'] },
  { id: 'clans', label: 'Clans', href: '/clans', icon: 'shield', title: 'Your clan', who: 'member', paths: ['/clans'] },
  { id: 'leaderboard', label: 'Leaderboard', href: LEADERBOARD_HREF, icon: 'trophy', title: 'Global leaderboard', paths: ['/p/'] },
  { id: 'party', label: 'Party', href: '/party/leaderboard', icon: 'sparkles', title: 'YapOS Party top players', paths: ['/party/leaderboard'], also: ['/seasons'] },
  { id: 'seasons', label: 'Seasons', href: '/seasons', icon: 'clock', title: 'Past Party seasons', who: 'guest', paths: ['/seasons'] },
  { id: 'packs-browse', label: 'Word packs', href: '/packs/browse', icon: 'folder', title: 'Browse word packs', who: 'guest', paths: ['/packs/browse'] },
];

export const SECTION_PATH = {
  servers: '/servers',
  clans: '/clans',
  inbox: '/inbox',
  account: '/account',
  packs: '/packs',
  'packs-browse': '/packs/browse',
  owner: '/owner',
  party: '/party',
  'party-reports': '/party/reports',
  'party-modlog': '/party/modlog',
};

const THEMES = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'cpu' },
];

export function brand({ href = '/', size = 28 } = {}) {
  return h('a', { href, class: 'brand', dataset: { link: '' }, attrs: { 'aria-label': 'YapOS home' } },
    logoMark({ size, label: '' }),
    h('span', { class: 'brand-name' }, h('span', { text: 'YapOS' }), h('span', { class: 'brand-sub', text: 'Dashboard' })));
}

export function addToServerButton({ compact = false, wide = false } = {}) {
  const el = linkButton({ label: 'Add to your server', href: ADD_BOT_URL, icon: 'plus', variant: 'glow', external: true, className: compact ? 'btn-glow-compact' : wide ? 'btn-glow-wide' : '' });
  el.title = 'Add YapOS to your server';
  el.append(h('span', { class: 'btn-glow-dots', attrs: { 'aria-hidden': 'true' } }));
  return el;
}

function appAurora() {
  return h('div', { class: 'aurora aurora-app', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'aurora-light aurora-light-a' }),
    h('span', { class: 'aurora-light aurora-light-b' }),
    h('span', { class: 'aurora-light aurora-light-c' }));
}

export function bellLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return count ? `Inbox, ${count} unread` : 'Inbox';
}

export function bellText(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return count > 99 ? '99+' : count ? String(count) : '';
}

export function inboxLink(active = false, unread = 0) {
  const count = h('span', { class: 'bell-count', attrs: { 'aria-hidden': 'true' }, text: bellText(unread) });
  count.hidden = !bellText(unread);
  return h('a', {
    href: '/inbox',
    class: ['icon-btn', 'party-link', 'bell-link', active ? 'is-active' : '', bellText(unread) ? 'has-unread' : ''],
    title: bellLabel(unread),
    dataset: { link: '', bell: '' },
    attrs: { 'aria-label': bellLabel(unread), 'aria-current': active ? 'page' : null },
  }, icon('bell', { size: 18 }), count);
}

export function paintBells(root, unread) {
  const text = bellText(unread);
  for (const a of root.querySelectorAll('.bell-link')) {
    a.classList.toggle('has-unread', Boolean(text));
    a.setAttribute('aria-label', bellLabel(unread));
    a.title = bellLabel(unread);
    const c = a.querySelector('.bell-count');
    if (c) {
      c.textContent = text;
      c.hidden = !text;
    }
  }
}

function pathNow() {
  try {
    return normalizePath(globalThis.window?.location?.pathname || '/');
  } catch {
    return '/';
  }
}

function isPhone() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(PHONE_QUERY)?.matches);
  } catch {
    return false;
  }
}

function hits(path, pattern) {
  const p = String(path || '').toLowerCase();
  const want = String(pattern || '').toLowerCase();
  if (!want) return 0;
  if (want.endsWith('/')) return p.startsWith(want) ? want.length : 0;
  return p === want ? want.length + 1 : 0;
}

function score(item, path) {
  let best = 0;
  for (const p of item.paths || []) best = Math.max(best, hits(path, p) * 4);
  for (const p of item.also || []) best = Math.max(best, hits(path, p));
  return best;
}

export function activeItem(items, path) {
  let pick = null;
  let top = 0;
  for (const item of items) {
    const s = score(item, path);
    if (s > top) {
      top = s;
      pick = item;
    }
  }
  return pick ? pick.id : '';
}

export function navFor(user) {
  return SITE_NAV.filter((item) => (user ? item.who !== 'guest' : item.who !== 'member'));
}

export function accountGroups({ user = null, partyOwner = false, partyAdmin = false } = {}) {
  if (!user) return [];
  const handle = user.username ? String(user.username) : '';
  const mine = [
    handle ? { id: 'profile', label: 'View profile', href: profilePath(handle), icon: 'user', paths: [profilePath(handle)] } : null,
    handle ? { id: 'edit-profile', label: 'Edit profile', href: `${profilePath(handle)}?edit=1`, icon: 'palette' } : null,
    { id: 'inbox', label: 'Inbox', href: '/inbox', icon: 'inbox', paths: ['/inbox'], bell: true },
    { id: 'account', label: 'Your account', href: '/account', icon: 'sliders', paths: ['/account', '/link'] },
    { id: 'packs', label: 'Word packs', href: '/packs', icon: 'folder', paths: ['/packs'] },
    { id: 'add', label: 'Add YapOS to a server', href: ADD_BOT_URL, icon: 'plus', external: true },
  ].filter(Boolean);
  const groups = [{ id: 'you', label: 'Your account', items: mine }];
  if (partyOwner || partyAdmin) {
    groups.push({ id: 'staff', label: 'Staff', items: [
      { id: 'party-reports', label: 'Party reports', href: '/party/reports', icon: 'flag', paths: ['/party/reports'] },
      { id: 'party-modlog', label: 'Party mod log', href: '/party/modlog', icon: 'list', paths: ['/party/modlog'] },
    ] });
  }
  if (partyOwner) {
    groups.push({ id: 'owner', label: 'Owner', items: [
      { id: 'owner', label: 'Owner panel', href: '/owner', icon: 'gift', paths: ['/owner', '/owner/'] },
      { id: 'party', label: 'Party admins', href: '/party', icon: 'crown', paths: ['/party'] },
    ] });
  }
  return groups;
}

export function currentPath({ section = '', server = null } = {}) {
  if (section && SECTION_PATH[section]) return SECTION_PATH[section];
  if (server && server.id) return serverPath(server.id);
  return pathNow();
}

function linkItem(item, active, unread) {
  const internal = !item.external;
  const count = item.bell ? h('span', { class: 'bell-count', attrs: { 'aria-hidden': 'true' }, text: bellText(unread) }) : null;
  if (count) count.hidden = !bellText(unread);
  return h('a', {
    href: item.href,
    class: ['bar-item', active ? 'is-active' : '', item.bell ? 'bell-link' : '', item.bell && bellText(unread) ? 'has-unread' : ''],
    tabIndex: -1,
    target: internal ? null : '_blank',
    rel: internal ? null : 'noopener noreferrer',
    dataset: { link: internal ? '' : null, item: item.id },
    attrs: { role: 'menuitem', 'aria-label': item.bell ? bellLabel(unread) : item.label, 'aria-current': active ? 'page' : null },
  }, icon(item.icon, { size: 18 }), h('span', { class: 'bar-item-label', text: item.label }), item.external ? icon('external', { size: 14, className: 'bar-item-end' }) : null, count);
}

async function defaultLogout() {
  try {
    await createApi().post('/auth/logout', {}, { allow401: true });
  } catch {
    forgetAll();
  }
  forgetAll();
  state.userChecked = false;
  globalThis.window?.location?.assign('/');
}

export function createSiteBar({ onLogout = defaultLogout } = {}) {
  const menuId = nextId('bar-menu');
  const nav = h('nav', { class: 'bar-nav', attrs: { 'aria-label': 'Main' } });
  const actions = h('div', { class: 'bar-actions' });
  const panel = h('div', { class: 'bar-menu', id: menuId, hidden: true, attrs: { role: 'menu', 'aria-label': 'Menu' } });
  const accountBtn = h('button', { type: 'button', class: 'bar-account', attrs: { 'aria-haspopup': 'menu', 'aria-controls': menuId, 'aria-expanded': 'false' } });
  const burger = h('button', { type: 'button', class: 'icon-btn bar-burger', title: 'Menu', attrs: { 'aria-label': 'Open menu', 'aria-haspopup': 'menu', 'aria-controls': menuId, 'aria-expanded': 'false' } }, icon('menu', { size: 20 }));
  let view = { user: null, partyOwner: false, partyAdmin: false, current: '/', unread: 0, variant: 'plain' };
  let openedBy = null;
  let keyed = false;

  function menuItems() {
    const phone = isPhone();
    return Array.from(panel.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter((el) => !el.hidden && (phone || !el.closest('.bar-only-phone')));
  }

  function focusAt(index) {
    const list = menuItems();
    if (!list.length) return;
    const i = ((index % list.length) + list.length) % list.length;
    list[i].focus();
  }

  function move(step) {
    const list = menuItems();
    const at = list.indexOf(globalThis.document.activeElement);
    focusAt(at < 0 ? (step > 0 ? 0 : -1) : at + step);
  }

  function onDoc(e) {
    const t = e.target;
    if (panel.contains(t) || accountBtn.contains(t) || burger.contains(t)) return;
    close(false);
  }

  function paintTriggers() {
    accountBtn.setAttribute('aria-expanded', openedBy === accountBtn ? 'true' : 'false');
    burger.setAttribute('aria-expanded', openedBy === burger ? 'true' : 'false');
    const label = openedBy === burger ? 'Close menu' : 'Open menu';
    burger.setAttribute('aria-label', label);
    burger.title = label;
    burger.replaceChildren(icon(openedBy === burger ? 'x' : 'menu', { size: 20 }));
    actions.classList.toggle('is-open', Boolean(openedBy));
  }

  function open(trigger, where = 'first') {
    if (openedBy && openedBy !== trigger) close(false);
    openedBy = trigger;
    panel.hidden = false;
    panel.dataset.from = trigger === burger ? 'sheet' : 'menu';
    paintTheme();
    paintTriggers();
    globalThis.document.addEventListener('click', onDoc);
    focusAt(where === 'last' ? -1 : 0);
  }

  function close(returnFocus = true) {
    if (!openedBy) return;
    const was = openedBy;
    openedBy = null;
    panel.hidden = true;
    globalThis.document.removeEventListener('click', onDoc);
    paintTriggers();
    if (returnFocus) was.focus();
  }

  function triggerKeys(trigger) {
    return (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (e.key !== 'ArrowDown') keyed = true;
        if (openedBy === trigger && e.key !== 'ArrowDown') close(true);
        else open(trigger, 'first');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        open(trigger, 'last');
      } else if (e.key === 'Escape' && openedBy) {
        e.preventDefault();
        close(true);
      }
    };
  }

  function triggerClick(trigger) {
    return () => {
      if (keyed) {
        keyed = false;
        return;
      }
      if (openedBy === trigger) close(false);
      else open(trigger, 'first');
    };
  }

  const releaseKey = () => setTimeout(() => {
    keyed = false;
  }, 0);

  for (const trigger of [accountBtn, burger]) {
    trigger.addEventListener('keydown', triggerKeys(trigger));
    trigger.addEventListener('keyup', releaseKey);
    trigger.addEventListener('click', triggerClick(trigger));
  }

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    } else if ((e.key === ' ' || e.key === 'Spacebar') && e.target?.getAttribute?.('role') === 'menuitem' && e.target.localName === 'a') {
      e.preventDefault();
      e.target.click();
    }
  });

  panel.addEventListener('click', (e) => {
    const item = e.target?.closest?.('[role="menuitem"]');
    if (item) close(false);
  });

  function paintTheme() {
    const choice = themeChoice();
    for (const b of panel.querySelectorAll('[role="menuitemradio"]')) {
      const on = b.dataset.theme === choice;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }
  }

  function chooseTheme(id) {
    if (id === 'system') clearTheme();
    else setTheme(id);
    paintTheme();
  }

  function themeGroup() {
    return h('div', { class: 'bar-group bar-theme', attrs: { role: 'group', 'aria-label': 'Theme' } },
      h('div', { class: 'bar-group-label', attrs: { 'aria-hidden': 'true' }, text: 'Theme' }),
      h('div', { class: 'bar-theme-row' }, ...THEMES.map((t) => h('button', {
        type: 'button',
        class: 'bar-item bar-theme-item',
        tabIndex: -1,
        dataset: { theme: t.id },
        attrs: { role: 'menuitemradio', 'aria-checked': 'false' },
        on: { click: () => chooseTheme(t.id) },
      }, icon(t.icon, { size: 16 }), h('span', { class: 'bar-item-label', text: t.label })))));
  }

  function sep(extra = '') {
    return h('div', { class: ['bar-sep', extra], attrs: { role: 'separator' } });
  }

  function render() {
    const { user, current, unread, variant } = view;
    const navItems = navFor(user);
    const navActive = activeItem(navItems, current);
    replace(nav, h('ul', { class: 'bar-nav-list' }, ...navItems.map((item) => {
      const on = item.id === navActive;
      return h('li', null, h('a', {
        href: item.href,
        class: ['bar-link', on ? 'is-active' : ''],
        title: item.title,
        dataset: { link: '', nav: item.id },
        attrs: { 'aria-current': on ? 'page' : null },
      }, icon(item.icon, { size: 16 }), h('span', { text: item.label })));
    })));

    const groups = accountGroups(view);
    const allItems = groups.flatMap((g) => g.items);
    const acctActive = activeItem(allItems, current);
    const name = user ? user.display_name || user.username || 'You' : '';

    panel.setAttribute('aria-label', user ? 'Account menu' : 'Menu');
    panel.dataset.variant = variant;
    actions.dataset.variant = variant;
    actions.dataset.signed = user ? 'in' : 'out';

    const navGroup = h('div', { class: 'bar-group bar-only-phone', attrs: { role: 'group', 'aria-label': 'Pages' } },
      ...navItems.map((item) => linkItem({ ...item }, item.id === navActive, unread)));

    const parts = [navGroup, sep('bar-only-phone')];
    if (user) {
      const who = h('div', { class: 'bar-who', attrs: { 'aria-hidden': 'true' } },
        avatar({ name, url: user.avatar_url, still: user.avatar_still, id: user.id, size: 'sm' }),
        h('span', { class: 'bar-who-text' },
          h('span', { class: 'bar-who-name', text: name }),
          user.username && user.username !== name ? h('span', { class: 'bar-who-handle', text: `@${user.username}` }) : null));
      parts.push(who);
      groups.forEach((g, i) => {
        if (i > 0) parts.push(sep());
        parts.push(h('div', { class: ['bar-group', `bar-group-${g.id}`], attrs: { role: 'group', 'aria-label': g.label } },
          i > 0 ? h('div', { class: 'bar-group-label', attrs: { 'aria-hidden': 'true' }, text: g.label }) : null,
          ...g.items.map((item) => linkItem(item, item.id === acctActive, unread))));
      });
      parts.push(sep(), themeGroup(), sep(),
        h('button', { type: 'button', class: 'bar-item bar-signout', tabIndex: -1, dataset: { item: 'signout' }, attrs: { role: 'menuitem' }, on: { click: () => onLogout() } },
          icon('logout', { size: 18 }), h('span', { class: 'bar-item-label', text: 'Sign out' })));
    } else {
      parts.push(themeGroup());
    }
    replace(panel, ...parts);
    paintTheme();

    if (user) {
      replace(accountBtn,
        avatar({ name, url: user.avatar_url, still: user.avatar_still, id: user.id, size: 'sm' }),
        h('span', { class: 'bar-account-name', text: name }),
        icon('chevron-down', { size: 14, className: 'bar-account-caret' }));
      accountBtn.setAttribute('aria-label', `Account menu for ${name}`);
      accountBtn.title = 'Account menu';
      const bell = inboxLink(current === '/inbox', unread);
      bell.classList.add('bar-bell');
      replace(actions,
        variant === 'server' ? h('span', { class: 'topbar-cta' }, addToServerButton({ compact: true })) : null,
        bell,
        accountBtn,
        burger);
    } else {
      const here = `${pathNow()}${globalThis.window?.location?.search || ''}`;
      const toggle = themeToggle();
      toggle.classList.add('bar-theme-toggle');
      const signIn = linkButton({ label: 'Sign in', href: loginUrl(here === '/' ? '/servers' : here), size: 'sm', icon: 'user', className: 'bar-signin' });
      replace(actions, toggle, signIn, burger);
    }
    paintTriggers();
  }

  return {
    nav,
    actions,
    panel,
    accountBtn,
    burger,
    open: (which = 'account', where = 'first') => open(which === 'sheet' ? burger : accountBtn, where),
    close,
    get isOpen() { return Boolean(openedBy); },
    update(next = {}) {
      close(false);
      view = {
        user: next.user || null,
        partyOwner: Boolean(next.user) && next.partyOwner === true,
        partyAdmin: Boolean(next.user) && (next.partyAdmin === true || next.partyOwner === true),
        current: normalizePath(next.current || pathNow()),
        unread: Math.max(0, Math.floor(Number(next.unread ?? view.unread) || 0)),
        variant: next.variant || 'plain',
      };
      render();
    },
    setUnread(n) {
      view.unread = Math.max(0, Math.floor(Number(n) || 0));
      paintBells(actions, view.unread);
      paintBells(panel, view.unread);
    },
    get unread() { return view.unread; },
  };
}

export function siteHeader({ current = '', viewer = null, onLogout } = {}) {
  const bar = createSiteBar(onLogout ? { onLogout } : {});
  const el = h('header', { class: 'site-header site-bar' },
    h('div', { class: 'site-header-inner bar-inner' }, brand({ href: '/' }), bar.nav, bar.actions),
    bar.panel);
  const here = () => current || pathNow();
  let seen = false;
  let off = null;
  function setUser(user) {
    bar.update({ user, partyOwner: Boolean(user) && state.partyOwner === true, partyAdmin: Boolean(user) && state.partyAdmin === true, current: here(), variant: 'public', unread: user ? inboxUnread() : 0 });
    if (user && !off) {
      off = watchInboxCount((n) => {
        if (el.isConnected) seen = true;
        else if (seen) {
          off?.();
          return;
        }
        bar.setUnread(n);
      });
    }
  }
  setUser(null);
  if (typeof viewer === 'function') {
    Promise.resolve().then(() => viewer()).then((v) => {
      const user = v && typeof v === 'object' && 'user' in v ? v.user : v;
      if (user) setUser(user);
    }).catch(() => {});
  }
  return { el, bar, setUser };
}

function siteLinks(user, current) {
  const items = navFor(user);
  const on = activeItem(items, current);
  return h('nav', { class: 'sidebar-site', attrs: { 'aria-label': 'Site' } },
    h('ul', { class: 'nav-list' }, ...items.map((item) => h('li', null, h('a', {
      href: item.href,
      class: ['nav-item', item.id === on ? 'is-active' : ''],
      dataset: { link: '' },
      attrs: { 'aria-current': item.id === on ? 'page' : null },
    }, icon(item.icon, { size: 16 }), h('span', { text: item.label }))))));
}

export function createShell({ onLogout }) {
  const bar = createSiteBar({ onLogout });
  const sidebarNav = h('nav', { class: 'sidebar-nav', attrs: { 'aria-label': 'Server sections' } });
  const serverSlot = h('div', { class: 'server-switch-slot' });
  const userSlot = h('div', { class: 'sidebar-footer' });
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', attrs: { 'aria-label': 'Sidebar' } },
    h('div', { class: 'sidebar-top' },
      h('div', { class: 'sidebar-brand-row' }, brand({ href: '/servers' })),
      h('button', { type: 'button', class: 'icon-btn sidebar-close', attrs: { 'aria-label': 'Close menu' } }, icon('x', { size: 18 }))),
    h('div', { class: 'sidebar-cta' }, addToServerButton({ wide: true })),
    serverSlot,
    sidebarNav,
    userSlot);
  const overlay = h('div', { class: 'sidebar-overlay' });
  const menuBtn = h('button', { type: 'button', class: 'icon-btn menu-btn', title: 'Server menu', attrs: { 'aria-label': 'Open server menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false' } }, icon('menu', { size: 18 }));
  const crumbs = h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Breadcrumb' } });
  const navSlot = h('div', { class: 'topbar-nav' });
  const topRight = h('div', { class: 'topbar-right' });
  const topbar = h('header', { class: 'topbar site-bar' }, menuBtn, h('div', { class: 'topbar-brand' }), navSlot, crumbs, topRight, bar.panel);
  const main = h('main', { class: 'content', id: 'main', tabIndex: -1 });
  const skip = h('a', { href: '#main', class: 'skip-link', text: 'Skip to content' });
  const root = h('div', { class: 'app-shell' }, skip, sidebar, overlay, h('div', { class: 'app-main' }, appAurora(), topbar, main));

  let open = false;
  function setOpen(v) {
    open = v;
    root.classList.toggle('sidebar-open', v);
    menuBtn.setAttribute('aria-expanded', v ? 'true' : 'false');
    document.body.classList.toggle('has-drawer', v);
    if (v) {
      bar.close(false);
      sidebar.querySelector('a, button')?.focus();
    }
  }
  menuBtn.addEventListener('click', () => setOpen(!open));
  overlay.addEventListener('click', () => setOpen(false));
  sidebar.querySelector('.sidebar-close').addEventListener('click', () => {
    setOpen(false);
    menuBtn.focus();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      setOpen(false);
      menuBtn.focus();
    }
  });
  skip.addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });

  return {
    root,
    main,
    bar,
    close: () => {
      setOpen(false);
      bar.close(false);
    },
    get unread() { return bar.unread; },
    setUnread(n) {
      bar.setUnread(n);
    },
    update({ variant, section, server, user, partyOwner = false, partyAdmin = false, crumbs: trail }) {
      const plain = variant === 'plain';
      const here = currentPath({ section, server });
      root.classList.toggle('shell-plain', plain);
      bar.update({ user, partyOwner, partyAdmin, current: here, variant: plain ? 'plain' : 'server' });
      replace(root.querySelector('.topbar-brand'), ...(plain ? [brand({ href: '/servers' })] : []));
      replace(navSlot, plain ? bar.nav : null);
      replace(topRight, bar.actions);
      replace(userSlot, siteLinks(user, here));
      if (server) {
        replace(serverSlot,
          h('a', { href: '/servers', class: 'server-switch', dataset: { link: '' }, attrs: { 'aria-label': `${server.name}. Switch server` } },
            avatar({ name: server.name, url: server.icon_url, id: server.id, size: 'sm', shape: 'square' }),
            h('span', { class: 'server-switch-text' },
              h('span', { class: 'server-switch-name', text: server.name }),
              h('span', { class: 'server-switch-role', text: server.level ? levelLabel(server.level) : 'Switch server' })),
            icon('chevrons-up-down', { size: 14 })));
        replace(sidebarNav, h('ul', { class: 'nav-list' }, ...NAV.map((item) => {
          const current = section === item.id;
          return h('li', null, h('a', {
            href: serverPath(server.id, item.sub),
            class: ['nav-item', current ? 'is-active' : ''],
            dataset: { link: '' },
            attrs: { 'aria-current': current ? 'page' : null },
          }, icon(item.icon, { size: 16 }), h('span', { text: item.label })));
        })));
      } else {
        replace(serverSlot);
        replace(sidebarNav);
      }
      const parts = trail || [];
      replace(crumbs, h('ol', { class: 'crumb-list' }, ...parts.map((c, i) => {
        const last = i === parts.length - 1;
        return h('li', { class: 'crumb' },
          i > 0 ? icon('chevron-right', { size: 14, className: 'crumb-sep' }) : null,
          last || !c.href
            ? h('span', { class: 'crumb-current', text: c.label, attrs: { 'aria-current': last ? 'page' : null } })
            : h('a', { href: c.href, dataset: { link: '' }, text: c.label }));
      })));
    },
  };
}
