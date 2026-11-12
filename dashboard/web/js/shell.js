import { h, replace } from './dom.js';
import { icon, logoMark } from './icons.js';
import { avatar } from './ui.js';
import { themeToggle } from './theme.js';
import { serverPath } from './router.js';
import { levelLabel } from './format.js';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'overview', sub: '' },
  { id: 'apps', label: 'Apps', icon: 'apps', sub: 'apps' },
  { id: 'cases', label: 'Cases', icon: 'shield', sub: 'cases' },
  { id: 'public-settings', label: 'Public page', icon: 'globe', sub: 'public' },
];

export function brand({ href = '/', size = 28 } = {}) {
  return h('a', { href, class: 'brand', dataset: { link: '' }, attrs: { 'aria-label': 'YapOS home' } },
    logoMark({ size, label: '' }),
    h('span', { class: 'brand-name' }, h('span', { text: 'YapOS' }), h('span', { class: 'brand-sub', text: 'Dashboard' })));
}

function userBlock(user, onLogout) {
  const name = user?.display_name || user?.username || 'You';
  return h('div', { class: 'user-block' },
    avatar({ name, url: user?.avatar_url, id: user?.id, size: 'sm' }),
    h('div', { class: 'user-text' },
      h('span', { class: 'user-name', text: name }),
      user?.username && user.username !== name ? h('span', { class: 'user-handle', text: `@${user.username}` }) : null),
    h('button', { type: 'button', class: 'icon-btn', title: 'Log out', attrs: { 'aria-label': 'Log out' }, on: { click: onLogout } }, icon('logout', { size: 16 })));
}

export function createShell({ onLogout }) {
  const sidebarNav = h('nav', { class: 'sidebar-nav', attrs: { 'aria-label': 'Server sections' } });
  const serverSlot = h('div', { class: 'server-switch-slot' });
  const userSlot = h('div', { class: 'sidebar-footer' });
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', attrs: { 'aria-label': 'Sidebar' } },
    h('div', { class: 'sidebar-top' }, brand({ href: '/servers' }),
      h('button', { type: 'button', class: 'icon-btn sidebar-close', attrs: { 'aria-label': 'Close menu' } }, icon('x', { size: 18 }))),
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
  const root = h('div', { class: 'app-shell' }, skip, sidebar, overlay, h('div', { class: 'app-main' }, topbar, main));

  let open = false;
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
    update({ variant, section, server, user, crumbs: trail }) {
      root.classList.toggle('shell-plain', variant === 'plain');
      replace(topRight, themeToggle(), variant === 'plain' ? userBlock(user, onLogout) : null);
      replace(root.querySelector('.topbar-brand'), variant === 'plain' ? brand({ href: '/servers' }) : null);
      replace(userSlot, userBlock(user, onLogout));
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
