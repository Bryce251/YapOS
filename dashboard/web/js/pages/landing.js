import { h } from '../dom.js';
import { icon } from '../icons.js';
import { addToServerButton, brand } from '../shell.js';
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

const ACTIVITY = [
  ['trophy', 'Mia reached level 12', 'now'],
  ['ticket', 'Ticket #42 opened by Sam', '1m'],
  ['shield', 'Automod stopped a spam burst', '3m'],
  ['users', 'Ava joined the server', '4m'],
  ['coins', 'Leo claimed 250 daily coins', '6m'],
  ['star', 'A message hit the starboard', '9m'],
];

function tickerItem([ic, text, time]) {
  return h('li', { class: 'ticker-item' },
    h('span', { class: 'ticker-icon' }, icon(ic, { size: 13 })),
    h('span', { class: 'ticker-text', text }),
    h('span', { class: 'ticker-time', text: time }));
}

function osPreview() {
  const tiles = [
    ['Mod', 'shield', true], ['Automod', 'activity', true], ['Levels', 'trophy', true],
    ['Economy', 'coins', false], ['Tickets', 'ticket', true], ['Welcome', 'users', true],
  ];
  return h('div', { class: 'hero-preview reveal', style: { '--i': '3' }, attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'preview-float float-a' }, icon('sparkles', { size: 14 }), h('span', { text: 'Level up!' }), h('span', { class: 'preview-float-muted', text: 'Mia is now 12' })),
    h('div', { class: 'preview-float float-b' }, icon('shield', { size: 14 }), h('span', { text: 'Case #128' }), h('span', { class: 'preview-float-muted', text: 'Warn logged' })),
    h('div', { class: 'preview-window' },
      h('div', { class: 'preview-bar' }, h('span', { class: 'preview-dot' }), h('span', { class: 'preview-dot' }), h('span', { class: 'preview-dot' }), h('span', { class: 'preview-title', text: 'Apps' })),
      h('div', { class: 'preview-grid' }, ...tiles.map(([name, ic, on], i) => h('div', { class: ['preview-tile', on ? 'is-on' : ''], style: { '--i': String(i) } },
        h('span', { class: 'preview-tile-icon' }, icon(ic, { size: 16 })),
        h('span', { class: 'preview-tile-name', text: name }),
        h('span', { class: ['preview-switch', on ? 'is-on' : ''] }, h('span'))))),
      h('div', { class: 'preview-activity' },
        h('div', { class: 'preview-activity-head' }, h('span', { class: 'preview-live-dot' }), h('span', { text: 'Live activity' })),
        h('div', { class: 'ticker' }, h('ul', { class: 'ticker-track' }, ...ACTIVITY.map(tickerItem), ...ACTIVITY.map(tickerItem))))));
}

function aurora() {
  return h('div', { class: 'aurora aurora-hero', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'aurora-light aurora-light-a' }),
    h('span', { class: 'aurora-light aurora-light-b' }),
    h('span', { class: 'aurora-light aurora-light-c' }),
    h('span', { class: 'dot-grid' }));
}

function featureCard(f, i) {
  return h('li', { class: 'feature reveal', style: { '--i': String(i + 4) } },
    h('span', { class: 'feature-icon' }, icon(f.icon, { size: 18 })),
    h('h3', { class: 'feature-title', text: f.title }),
    h('p', { class: 'feature-body', text: f.body }));
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
      h('div', { class: 'site-header-start' }, brand({ href: '/' }), addToServerButton()),
      h('div', { class: 'site-header-actions' },
        themeToggle(),
        user ? linkButton({ label: 'Dashboard', href: '/servers', size: 'sm' }) : h('a', { href: loginUrl(next), class: 'btn btn-secondary btn-sm' }, h('span', { class: 'btn-label', text: 'Log in' })))));
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'hero-copy' },
      h('span', { class: 'hero-eyebrow reveal' }, h('span', { class: 'hero-eyebrow-dot' }), 'An operating system for your server'),
      h('h1', { class: 'hero-title reveal', style: { '--i': '1' }, text: 'YapOS Dashboard' }),
      h('p', { class: 'hero-lead reveal', style: { '--i': '2' }, text: 'Manage apps, settings and moderation for every server you run, from one calm place. Changes go straight to YapOS and apply in seconds.' }),
      cancelled ? h('p', { class: 'notice notice-info', attrs: { role: 'status' } }, icon('info', { size: 16 }), h('span', { text: 'Login was cancelled. You can try again whenever you like.' })) : null,
      h('div', { class: 'hero-actions reveal', style: { '--i': '3' } }, cta, linkButton({ label: 'Add to your server', href: ADD_BOT_URL, icon: 'plus', size: 'lg', external: true })),
      h('p', { class: 'hero-fine reveal', style: { '--i': '4' }, text: 'We only ask for your basic profile. You can manage servers where you are an admin or the owner.' })),
    osPreview());
  const features = h('section', { class: 'features', attrs: { 'aria-labelledby': 'features-title' } },
    h('h2', { class: 'sr-only', id: 'features-title', text: 'Features' }),
    h('ul', { class: 'feature-grid' }, ...FEATURES.map(featureCard)));
  const footer = h('footer', { class: 'site-footer' }, h('span', { text: `YapOS · ${new Date().getFullYear()}` }), h('span', { class: 'site-footer-sep', text: '·' }), h('span', { text: 'Run /setup in your server to get started.' }));
  root.replaceChildren(h('div', { class: 'site' }, aurora(), header, h('main', { class: 'site-main', id: 'main', tabIndex: -1 }, hero, features), footer));
}
