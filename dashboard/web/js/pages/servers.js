import { h } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, emptyState, loadingRegion, pageHeader, skeleton } from '../ui.js';
import { mountAsync } from './common.js';
import { serverPath } from '../router.js';
import { formatCompact, levelLabel } from '../format.js';
import { state } from '../state.js';
import { isPending } from '../api.js';

const SERVERS_TTL = 60000;

export function readServers(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.servers) ? data.servers : [];
  return list.filter((s) => s && s.id).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? 'Unnamed server'),
    icon_url: s.icon_url ?? '',
    member_count: s.member_count ?? null,
    level: s.level ?? '',
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function skeletonGrid() {
  return loadingRegion('Loading your servers', h('ul', { class: 'server-grid' }, ...Array.from({ length: 6 }, () => h('li', { class: 'server-card is-skeleton' },
    skeleton('skeleton-avatar-lg'),
    h('div', { class: 'server-card-text' }, skeleton('skeleton-text skeleton-w-60'), skeleton('skeleton-text skeleton-w-40'))))));
}

function serverCard(s) {
  return h('li', null, h('a', { href: serverPath(s.id), class: 'server-card', dataset: { link: '' } },
    avatar({ name: s.name, url: s.icon_url, id: s.id, size: 'lg', shape: 'square' }),
    h('div', { class: 'server-card-text' },
      h('span', { class: 'server-card-name', text: s.name }),
      h('span', { class: 'server-card-meta' },
        icon('users', { size: 14 }),
        h('span', { text: s.member_count === null ? 'Members unknown' : `${formatCompact(s.member_count)} members` }))),
    h('div', { class: 'server-card-end' },
      badge(levelLabel(s.level), s.level === 'owner' ? 'accent' : 'neutral'),
      icon('chevron-right', { size: 16, className: 'server-card-arrow' }))));
}

export function renderServers(ctx) {
  const { api, main } = ctx;
  ctx.setChrome({ variant: 'plain', crumbs: [{ label: 'Servers' }] });
  const body = h('div', { class: 'page-body' });
  const refresh = button({ label: 'Refresh', icon: 'refresh', size: 'sm' });
  main.replaceChildren(h('div', { class: 'page page-narrow' },
    pageHeader({ title: 'Your servers', description: 'Servers where you are an admin or the owner and YapOS is installed.', actions: refresh }),
    body));
  let force = false;
  const reload = mountAsync(body, {
    signal: ctx.signal,
    skeleton: skeletonGrid,
    load: async ({ onPending, signal }) => {
      if (!force && state.servers && Date.now() - state.serversAt < SERVERS_TTL) return state.servers;
      force = false;
      const data = await api.get('/api/servers', { signal });
      let list = data;
      if (isPending(data)) {
        onPending(data.job);
        list = await api.job(data.job, { signal });
      }
      state.servers = readServers(list);
      state.serversAt = Date.now();
      return state.servers;
    },
    render: (servers) => {
      if (!servers.length) {
        body.replaceChildren(emptyState({
          icon: 'server',
          title: 'No servers to manage yet',
          body: "You'll see servers here where YapOS is installed and you are an admin or the owner. Invite YapOS to a server, then refresh.",
        }));
        return;
      }
      body.replaceChildren(h('ul', { class: 'server-grid' }, ...servers.map(serverCard)));
    },
  });
  refresh.addEventListener('click', () => {
    force = true;
    reload();
  });
}
