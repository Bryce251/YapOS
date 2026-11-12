import { h } from '../dom.js';
import { icon } from '../icons.js';
import { brand } from '../shell.js';
import { themeToggle } from '../theme.js';
import { linkButton } from '../ui.js';
import { loginUrl, safeNext } from '../router.js';
import { ADD_BOT_URL } from '../links.js';

const FEATURES = [
  { icon: 'apps', title: 'Every app in one place', body: 'Install or remove apps like Levels, Tickets and Automod with a single switch.' },
  { icon: 'sliders', title: 'Settings without commands', body: 'Pick channels and roles from a list. YapOS checks every change before it applies.' },
  { icon: 'shield', title: 'Moderation history', body: 'Search every case, filter by type and open a member to see their full record.' },
  { icon: 'trophy', title: 'Shareable leaderboards', body: 'Publish a public page with levels, coins and your monthly Wrapped.' },
];

function osPreview() {
  const tiles = [
    ['Mod', 'shield', true], ['Automod', 'activity', true], ['Levels', 'trophy', true],
    ['Economy', 'coins', false], ['Tickets', 'ticket', true], ['Welcome', 'users', true],
  ];
  return h('div', { class: 'hero-preview', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'preview-window' },
      h('div', { class: 'preview-bar' }, h('span', { class: 'preview-dot' }), h('span', { class: 'preview-dot' }), h('span', { class: 'preview-dot' }), h('span', { class: 'preview-title', text: 'Apps' })),
      h('div', { class: 'preview-grid' }, ...tiles.map(([name, ic, on]) => h('div', { class: ['preview-tile', on ? 'is-on' : ''] },
        h('span', { class: 'preview-tile-icon' }, icon(ic, { size: 16 })),
        h('span', { class: 'preview-tile-name', text: name }),
        h('span', { class: ['preview-switch', on ? 'is-on' : ''] }, h('span'))))))
  );
}

export function renderLanding(root, { user, search }) {
  const params = new URLSearchParams(search);
  const next = safeNext(params.get('next') || '', '/servers');
  const cancelled = params.get('login') === 'cancelled';
  const cta = user
    ? linkButton({ label: 'Open dashboard', href: '/servers', variant: 'primary', size: 'lg', iconRight: 'arrow-right' })
    : h('a', { href: loginUrl(next), class: 'btn btn-primary btn-lg' }, h('span', { class: 'btn-label', text: "Log in with Yapin'" }), icon('arrow-right', { size: 16 }));
  const header = h('header', { class: 'site-header' },
    h('div', { class: 'site-header-inner' },
      brand({ href: '/' }),
      h('div', { class: 'site-header-actions' },
        themeToggle(),
        user ? linkButton({ label: 'Dashboard', href: '/servers', size: 'sm' }) : h('a', { href: loginUrl(next), class: 'btn btn-secondary btn-sm' }, h('span', { class: 'btn-label', text: 'Log in' })))));
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'hero-copy' },
      h('span', { class: 'hero-eyebrow' }, h('span', { class: 'hero-eyebrow-dot' }), 'An operating system for your server'),
      h('h1', { class: 'hero-title', text: 'YapOS Dashboard' }),
      h('p', { class: 'hero-lead', text: 'Manage apps, settings and moderation for every server you run, from one calm place. Changes go straight to YapOS and apply in seconds.' }),
      cancelled ? h('p', { class: 'notice notice-info', attrs: { role: 'status' } }, icon('info', { size: 16 }), h('span', { text: 'Login was cancelled. You can try again whenever you like.' })) : null,
      h('div', { class: 'hero-actions' }, cta, linkButton({ label: 'Add to your server', href: ADD_BOT_URL, icon: 'plus', size: 'lg', external: true })),
      h('p', { class: 'hero-fine', text: 'We only ask for your basic profile. You can manage servers where you are an admin or the owner.' })),
    osPreview());
  const features = h('section', { class: 'features', attrs: { 'aria-labelledby': 'features-title' } },
    h('h2', { class: 'sr-only', id: 'features-title', text: 'Features' }),
    h('ul', { class: 'feature-grid' }, ...FEATURES.map((f) => h('li', { class: 'feature' },
      h('span', { class: 'feature-icon' }, icon(f.icon, { size: 18 })),
      h('h3', { class: 'feature-title', text: f.title }),
      h('p', { class: 'feature-body', text: f.body })))));
  const footer = h('footer', { class: 'site-footer' }, h('span', { text: `YapOS · ${new Date().getFullYear()}` }), h('span', { class: 'site-footer-sep', text: '·' }), h('span', { text: 'Run /setup in your server to get started.' }));
  root.replaceChildren(h('div', { class: 'site' }, header, h('main', { class: 'site-main', id: 'main', tabIndex: -1 }, hero, features), footer));
}
