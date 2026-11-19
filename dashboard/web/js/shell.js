import { h, replace } from './dom.js';
import { icon, logoMark } from './icons.js';
import { avatar, linkButton } from './ui.js';
import { themeToggle } from './theme.js';
import { serverPath } from './router.js';
import { levelLabel } from './format.js';
import { ADD_BOT_URL } from './links.js';

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

export function partyLink(active = false) {
  return h('a', {
    href: '/party',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Party admins',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Party admins', 'aria-current': active ? 'page' : null },
  }, icon('crown', { size: 16 }));
}

export function reportsLink(active = false) {
  return h('a', {
    href: '/party/reports',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Party reports',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Party reports', 'aria-current': active ? 'page' : null },
  }, icon('flag', { size: 16 }));
}

export function packsLink(active = false) {
  return h('a', {
    href: '/packs',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Word packs',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Word packs', 'aria-current': active ? 'page' : null },
  }, icon('folder', { size: 16 }));
}

export function ownerLink(active = false) {
  return h('a', {
    href: '/owner',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Owner panel',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Owner panel', 'aria-current': active ? 'page' : null },
  }, icon('gift', { size: 16 }));
}

export function clansLink(active = false) {
  return h('a', {
    href: '/clans',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Your clan',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Your clan', 'aria-current': active ? 'page' : null },
  }, icon('shield', { size: 16 }));
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
  }, icon('bell', { size: 16 }), count);
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

export function accountLink(active = false) {
  return h('a', {
    href: '/account',
    class: ['icon-btn', 'party-link', active ? 'is-active' : ''],
    title: 'Your account',
    dataset: { link: '' },
    attrs: { 'aria-label': 'Your account', 'aria-current': active ? 'page' : null },
  }, icon('user', { size: 16 }));
}

function userBlock(user, onLogout, { partyOwner = false, partyAdmin = false, section = '', unread = 0 } = {}) {
  const name = user?.display_name || user?.username || 'You';
  return h('div', { class: 'user-block' },
    avatar({ name, url: user?.avatar_url, id: user?.id, size: 'sm' }),
    h('div', { class: 'user-text' },
      h('span', { class: 'user-name', text: name }),
      user?.username && user.username !== name ? h('span', { class: 'user-handle', text: `@${user.username}` }) : null),
    inboxLink(section === 'inbox', unread),
    clansLink(section === 'clans'),
    accountLink(section === 'account'),
    packsLink(section === 'packs' || section === 'packs-browse'),
    partyOwner ? ownerLink(section === 'owner') : null,
    partyOwner ? partyLink(section === 'party') : null,
    partyOwner || partyAdmin ? reportsLink(section === 'party-reports') : null,
    h('button', { type: 'button', class: 'icon-btn', title: 'Log out', attrs: { 'aria-label': 'Log out' }, on: { click: onLogout } }, icon('logout', { size: 16 })));
}

export function createShell({ onLogout }) {
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
  const menuBtn = h('button', { type: 'button', class: 'icon-btn menu-btn', attrs: { 'aria-label': 'Open menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false' } }, icon('menu', { size: 18 }));
  const crumbs = h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Breadcrumb' } });
  const topRight = h('div', { class: 'topbar-right' });
  const topbar = h('header', { class: 'topbar' }, menuBtn, h('div', { class: 'topbar-brand' }), crumbs, topRight);
  const main = h('main', { class: 'content', id: 'main', tabIndex: -1 });
  const skip = h('a', { href: '#main', class: 'skip-link', text: 'Skip to content' });
  const root = h('div', { class: 'app-shell' }, skip, sidebar, overlay, h('div', { class: 'app-main' }, appAurora(), topbar, main));

  let open = false;
  let unread = 0;
  function setOpen(v) {
    open = v;
    root.classList.toggle('sidebar-open', v);
    menuBtn.setAttribute('aria-expanded', v ? 'true' : 'false');
    document.body.classList.toggle('has-drawer', v);
    if (v) sidebar.querySelector('a, button')?.focus();
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
    close: () => setOpen(false),
    get unread() { return unread; },
    setUnread(n) {
      unread = Math.max(0, Math.floor(Number(n) || 0));
      paintBells(root, unread);
    },
    update({ variant, section, server, user, partyOwner = false, partyAdmin = false, crumbs: trail }) {
      const who = { partyOwner, partyAdmin, section, unread };
      root.classList.toggle('shell-plain', variant === 'plain');
      replace(topRight, variant === 'plain' ? null : h('span', { class: 'topbar-cta' }, addToServerButton({ compact: true })), themeToggle(), variant === 'plain' ? userBlock(user, onLogout, who) : null);
      replace(root.querySelector('.topbar-brand'), ...(variant === 'plain' ? [brand({ href: '/servers' }), addToServerButton()] : []));
      replace(userSlot, userBlock(user, onLogout, who));
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
