import { h } from './dom.js';
import { siteHeader } from './shell.js';

export function publicFrame(root, { current = '' } = {}) {
  const header = siteHeader({ current });
  const content = h('div', { class: 'public-content' });
  const site = h('div', { class: 'public-site' },
    header.el,
    h('main', { class: 'public-main', id: 'main', tabIndex: -1 }, content),
    h('footer', { class: 'site-footer' }, h('span', { text: 'Powered by YapOS' })));
  root.replaceChildren(site);
  return {
    content,
    site,
    header,
    setUser(user) {
      header.setUser(user || null);
    },
  };
}
