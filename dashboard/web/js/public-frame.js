import { h, replace } from './dom.js';
import { linkButton } from './ui.js';
import { brand } from './shell.js';
import { themeToggle } from './theme.js';
import { loginUrl } from './router.js';

const LINKS = [
  { href: '/p/global', label: 'Leaderboard' },
  { href: '/party/leaderboard', label: 'Party top' },
  { href: '/seasons', label: 'Seasons' },
  { href: '/packs/browse', label: 'Word packs' },
];

export function publicFrame(root, { current = '' } = {}) {
  const account = h('span', { class: 'public-account' });
  const nav = h('nav', { class: 'public-nav', attrs: { 'aria-label': 'Explore' } },
    ...LINKS.map((l) => h('a', { href: l.href, class: ['public-nav-link', current === l.href ? 'is-active' : ''], dataset: { link: '' }, attrs: { 'aria-current': current === l.href ? 'page' : null }, text: l.label })));
  const content = h('div', { class: 'public-content' });
  const site = h('div', { class: 'public-site' },
    h('header', { class: 'site-header' }, h('div', { class: 'site-header-inner' }, brand({ href: '/' }), nav, h('div', { class: 'site-header-actions' }, account, themeToggle()))),
    h('main', { class: 'public-main', id: 'main', tabIndex: -1 }, content),
    h('footer', { class: 'site-footer' }, h('span', { text: 'Powered by YapOS' })));
  root.replaceChildren(site);
  return {
    content,
    site,
    setUser(user) {
      const here = `${window.location.pathname}${window.location.search}`;
      replace(account, user
        ? linkButton({ label: 'Dashboard', href: '/servers', size: 'sm', icon: 'overview' })
        : linkButton({ label: 'Log in', href: loginUrl(here), size: 'sm', icon: 'user' }));
    },
  };
}
