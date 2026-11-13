import { h } from '../dom.js';
import { icon } from '../icons.js';
import { card, copyButton, linkButton, pageHeader } from '../ui.js';
import { serverChrome } from './overview.js';
import { CURRENCY_EMOJI, CURRENCY_NAME, leaderboardUrl } from './public.js';

export function renderPublicSettings(ctx) {
  const { main } = ctx;
  serverChrome(ctx, 'public-settings', 'Public page');
  ctx.setTitle?.('Public page');
  const path = leaderboardUrl();
  const full = `${window.location.origin}${path}`;
  main.replaceChildren(h('div', { class: 'page page-narrow' },
    pageHeader({ title: 'Public page', description: 'There is one leaderboard for every server, and it is always open to anyone with the link.' }),
    h('div', { class: 'page-body' },
      card({ title: 'The leaderboard', icon: 'trophy' },
        h('p', { class: 'card-intro', text: `Levels and ${CURRENCY_EMOJI} ${CURRENCY_NAME} count the same everywhere, so the board is shared. Nothing here is per server and there is nothing to switch on.` }),
        h('div', { class: 'share-row' },
          h('div', { class: 'share-live' },
            h('span', { class: 'live-pill' }, h('span', { class: 'status-dot status-success' }), 'Live'),
            h('a', { href: path, class: 'share-url', target: '_blank', rel: 'noopener', text: `${window.location.host}${path}` }),
            h('div', { class: 'share-actions' },
              copyButton({ getText: () => full, size: 'sm' }),
              linkButton({ label: 'Open', href: path, icon: 'external', size: 'sm', external: true }))))),
      card({ title: 'What it shows', icon: 'list' },
        h('ul', { class: 'plain-list' },
          h('li', null, icon('trophy', { size: 14 }), h('span', { text: 'Levels, earned in every server at the same rate.' })),
          h('li', null, icon('coins', { size: 14 }), h('span', { text: `${CURRENCY_EMOJI} ${CURRENCY_NAME}, one balance that travels with each person.` })),
          h('li', null, icon('lock', { size: 14 }), h('span', { text: 'Names and avatars only. Nothing private, and no login needed to look.' })))))));
}
