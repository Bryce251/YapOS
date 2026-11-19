import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, button, drawer, linkButton } from '../ui.js';
import { formatNumber } from '../format.js';
import { ApiError } from '../api.js';
import { loginUrl, profilePath } from '../router.js';
import { createClanJoin, joinState, clanParts } from '../../activity/js/clanjoin.js';

export function apiTransport(api, signal) {
  return async (method, path) => {
    try {
      const data = method === 'POST'
        ? await api.post(path, {}, { signal, allow401: true })
        : await api.get(path, { signal, allow401: true });
      return { status: 200, data };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status || 0, data: err.data || null };
      return { status: 0, data: null };
    }
  };
}

function fact(label, value, iconName) {
  return h('div', { class: 'clan-sheet-fact' },
    h('dt', { class: 'clan-sheet-fact-label' }, icon(iconName, { size: 14 }), h('span', { text: label })),
    h('dd', { class: 'clan-sheet-fact-value', text: value }));
}

function personLine(m) {
  const kids = [
    avatar({ name: m.name, url: m.avatar || '', still: m.avatarStill || '', animate: false, id: m.username || m.name, size: 'xs' }),
    h('span', { class: 'clan-sheet-member-name', text: m.name }),
    m.username ? h('span', { class: 'clan-sheet-member-handle', text: `@${m.username}` }) : null,
    m.leader ? h('span', { class: 'clan-sheet-member-tag' }, icon('crown', { size: 12 }), h('span', { text: 'Leader' })) : null,
    h('span', { class: 'clan-sheet-member-level', text: `Lv ${formatNumber(m.level)}` }),
  ];
  const cls = ['clan-sheet-member', m.leader ? 'is-leader' : ''];
  if (!m.username) return h('li', { class: 'clan-sheet-item' }, h('span', { class: cls }, ...kids));
  return h('li', { class: 'clan-sheet-item' }, h('a', {
    href: profilePath(m.username),
    class: [...cls, 'clan-sheet-member-btn'],
    attrs: { 'aria-label': `Open ${m.name}'s profile` },
  }, ...kids));
}

export function clanSheetBody(st, { onJoin, onRetry, here = '/' } = {}) {
  const s = joinState(st);
  const status = h('p', { class: ['clan-sheet-status', `is-${s.tone}`], attrs: { role: 'status', 'aria-live': 'polite' }, text: s.text });
  let action = null;
  if (s.action === 'join') action = button({ label: s.label, icon: s.busy ? 'clock' : 'plus', variant: 'primary', className: 'clan-sheet-join', disabled: Boolean(s.busy), onClick: onJoin });
  else if (s.action === 'signin') action = linkButton({ label: s.label, href: loginUrl(here), icon: 'user', variant: 'primary', className: 'clan-sheet-join' });
  else if (s.action === 'retry') action = button({ label: s.label, icon: 'refresh', className: 'clan-sheet-join', onClick: onRetry });
  const joinBox = h('div', { class: 'clan-sheet-actions' }, status, action);
  if (st.phase !== 'ready' || !st.clan) {
    return h('div', { class: ['clan-sheet', `is-${st.phase}`], attrs: { 'aria-busy': st.phase === 'loading' ? 'true' : null } }, joinBox);
  }
  const c = st.clan;
  const parts = clanParts(c);
  const root = h('div', { class: ['clan-sheet', 'is-ready', c.join === 'invite' ? 'is-invite' : 'is-open'] },
    h('div', { class: 'clan-sheet-hero' },
      h('span', { class: 'clan-sheet-crest', attrs: { 'aria-hidden': 'true' }, text: c.tag }),
      h('div', { class: 'clan-sheet-who' },
        h('p', { class: 'clan-sheet-name' }, h('span', { class: 'clan-sheet-code', text: parts.code }), parts.name ? h('span', { text: parts.name }) : null),
        c.banner ? h('p', { class: 'clan-sheet-motto', text: c.banner }) : null,
        h('span', { class: ['clan-sheet-mode', c.join === 'invite' ? 'is-invite' : 'is-open'] }, icon(c.join === 'invite' ? 'lock' : 'users', { size: 12 }), h('span', { text: c.join === 'invite' ? 'Invite only' : 'Open to everyone' })))),
    h('dl', { class: 'clan-sheet-facts' },
      fact('Members', formatNumber(c.members), 'users'),
      fact('Leader', c.leader ? c.leader.name : 'Hidden', 'crown'),
      fact('Joining', c.join === 'invite' ? 'Invite only' : 'Open', c.join === 'invite' ? 'lock' : 'check')),
    c.top.length ? h('section', { class: 'clan-sheet-top' },
      h('h3', { class: 'clan-sheet-subtitle', text: 'Top members' }),
      h('ol', { class: 'clan-sheet-members' }, ...c.top.map(personLine))) : null,
    joinBox);
  if (c.colour) root.style.setProperty('--clan', c.colour);
  return root;
}

export function openClanSheet(tag, { api, signal = null, clan = null, win = globalThis.window } = {}) {
  const parts = clanParts(clan);
  let ctl = null;
  const d = drawer({ title: parts ? parts.full : `[${String(tag).toUpperCase()}]`, subtitle: 'Clan', onClose: () => ctl && ctl.stop() });
  d.root.classList.add('clan-drawer');
  d.body.addEventListener('click', (e) => {
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('a.clan-sheet-member-btn')) d.close();
  });
  const here = win && win.location ? `${win.location.pathname}${win.location.search || ''}` : '/';
  const paint = (st) => {
    if (st.clan) d.setTitle(clanParts(st.clan).full);
    const hadFocus = d.body.contains(document.activeElement) && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('clan-sheet-join');
    replace(d.body, clanSheetBody(st, { onJoin: () => ctl.join(), onRetry: () => ctl.load(), here }));
    if (hadFocus) {
      const next = d.body.querySelector('.clan-sheet-join');
      if (next && !next.disabled) next.focus();
      else d.root.querySelector('.drawer-panel')?.focus();
    }
  };
  ctl = createClanJoin({
    tag,
    request: apiTransport(api, signal),
    onChange: paint,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
  });
  signal?.addEventListener?.('abort', () => {
    ctl.stop();
    d.close();
  });
  paint(ctl.state);
  ctl.load();
  return { drawer: d, controller: ctl };
}
