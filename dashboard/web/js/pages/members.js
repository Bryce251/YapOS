import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, emptyState, loadingRegion, pageHeader, skeleton } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { openMemberDrawer } from './member.js';
import { formatDate, formatNumber, relativeTime } from '../format.js';
import { latestSearch, normalizeMember, pager, readJob, readPage, roleChips, roleList, rolesIndex, serverApi, sortRoles, withQuery } from '../kit.js';

const SORTS = [
  { value: 'joined_new', label: 'Newest members' },
  { value: 'joined_old', label: 'Oldest members' },
  { value: 'name', label: 'Name A to Z' },
];

export function readMembersQuery(search) {
  const p = new URLSearchParams(search || '');
  const sort = SORTS.some((s) => s.value === p.get('sort')) ? p.get('sort') : 'joined_new';
  const page = Math.min(100, Math.max(1, Number.parseInt(p.get('page') || '1', 10) || 1));
  return { q: (p.get('q') || '').slice(0, 100), role: p.get('role') || '', sort, page };
}

export function membersQueryString(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.role) p.set('role', s.role);
  if (s.sort && s.sort !== 'joined_new') p.set('sort', s.sort);
  if (s.page > 1) p.set('page', String(s.page));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

function listSkeleton() {
  return loadingRegion('Loading members', h('ul', { class: 'member-list' }, ...Array.from({ length: 8 }, () => h('li', { class: 'member-row is-skeleton' },
    skeleton('skeleton-avatar'),
    h('span', { class: 'member-row-main' }, skeleton('skeleton-text skeleton-w-40'), skeleton('skeleton-text skeleton-w-30')),
    skeleton('skeleton-text skeleton-w-10')))));
}

export function memberRow(m, roleMap, onOpen) {
  const roles = sortRoles(roleList(m.roles, roleMap));
  const joined = m.joined_at;
  const btn = h('button', { type: 'button', class: 'member-row', attrs: { 'aria-label': `Open ${m.name}'s record` } },
    avatar({ name: m.name, url: m.avatar_url, id: m.id, size: 'md' }),
    h('span', { class: 'member-row-main' },
      h('span', { class: 'member-row-name' }, h('span', { class: 'member-row-title', text: m.name }), m.bot ? h('span', { class: 'bot-tag', text: 'BOT' }) : null),
      h('span', { class: 'member-row-sub', text: m.username ? `@${m.username}` : `ID ${m.id}` })),
    h('span', { class: 'member-row-roles' }, roles.length ? roleChips(roles, { max: 3 }) : h('span', { class: 'muted', text: 'No roles' })),
    h('span', { class: 'member-row-meta' },
      joined ? h('time', { class: 'member-row-joined', attrs: { datetime: new Date(joined).toISOString() }, title: formatDate(joined), text: `Joined ${relativeTime(joined)}` }) : h('span', { class: 'member-row-joined muted', text: 'Join date unknown' }),
      h('span', { class: 'member-row-badges' },
        m.warnings ? badge(`${formatNumber(m.warnings)} warn${m.warnings === 1 ? '' : 's'}`, 'caution', 'alert') : null,
        m.cases ? badge(`${formatNumber(m.cases)} case${m.cases === 1 ? '' : 's'}`, 'neutral', 'shield') : null)),
    icon('chevron-right', { size: 16, className: 'member-row-caret' }));
  btn.addEventListener('click', () => onOpen(m));
  return h('li', null, btn);
}

export function renderMembers(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'members', 'Members');
  const s = readMembersQuery(window.location.search);
  let roleMap = new Map();
  let rolesFilled = false;
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search by name, username or ID', value: s.q, maxLength: 100, attrs: { 'aria-label': 'Search members' } });
  const roleSelect = h('select', { class: 'input select', attrs: { 'aria-label': 'Filter by role' } }, h('option', { value: '', text: 'Any role' }));
  if (s.role) roleSelect.appendChild(h('option', { value: s.role, text: 'Selected role' }));
  roleSelect.value = s.role;
  const sortSelect = h('select', { class: 'input select', attrs: { 'aria-label': 'Sort members' } }, ...SORTS.map((o) => h('option', { value: o.value, text: o.label })));
  sortSelect.value = s.sort;
  const count = h('p', { class: 'toolbar-count', attrs: { 'aria-live': 'polite' } });
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', size: 'sm' });
  const notice = h('div');
  const list = h('div', { class: 'members-body' });
  main.replaceChildren(h('div', { class: 'page page-members' },
    pageHeader({ title: 'Members', description: 'Find anyone in the server, see their roles and history, and moderate from one place.', actions: refreshBtn }),
    h('div', { class: 'toolbar toolbar-wrap' },
      h('div', { class: 'input-shell has-lead toolbar-search' }, icon('search', { size: 14, className: 'input-lead' }), search),
      h('div', { class: 'select-shell' }, roleSelect, icon('chevron-down', { size: 14, className: 'select-caret' })),
      h('div', { class: 'select-shell' }, sortSelect, icon('chevron-down', { size: 14, className: 'select-caret' })),
      count),
    notice,
    list));

  function writeQuery() {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${membersQueryString(s)}`);
  }

  function fillRoles(detail) {
    roleMap = rolesIndex(detail?.settings?.lookups?.roles);
    if (rolesFilled) return;
    rolesFilled = true;
    const roles = sortRoles(Array.from(roleMap.values()).filter((r) => r.name !== '@everyone'));
    replace(roleSelect, h('option', { value: '', text: 'Any role' }), ...roles.map((r) => h('option', { value: r.id, text: r.name })));
    roleSelect.value = roles.some((r) => r.id === s.role) ? s.role : '';
    if (!roleSelect.value && s.role) {
      s.role = '';
      writeQuery();
    }
  }

  const open = (m) => openMemberDrawer(ctx, { id: m.id, name: m.name }, { onChange: () => reload() });

  const reload = mountAsync(list, {
    signal: ctx.signal,
    skeleton: listSkeleton,
    load: async (opts) => {
      const detail = await loadServer(ctx, opts);
      fillRoles(detail);
      const path = withQuery(serverApi(params.sid, 'members'), { q: s.q, role: s.role, sort: s.sort === 'joined_new' ? '' : s.sort, page: s.page > 1 ? s.page : '' });
      return readJob(ctx, path, opts);
    },
    render: (data) => {
      serverChrome(ctx, 'members', 'Members');
      const page = readPage(data, 'members');
      const members = page.list.map(normalizeMember);
      count.textContent = page.total === members.length && page.pages <= 1 ? `${formatNumber(page.total)} member${page.total === 1 ? '' : 's'}` : `${formatNumber(page.total)} members · page ${formatNumber(page.page)} of ${formatNumber(page.pages)}`;
      replace(notice, page.capped ? h('div', { class: 'notice notice-info' }, icon('info', { size: 16 }), h('span', { text: 'This server is big, so YapOS only keeps part of the member list in memory. Search by name or ID to find someone who is not listed.' })) : null);
      if (!members.length) {
        const filtered = s.q || s.role;
        replace(list, emptyState({
          icon: filtered ? 'search' : 'users',
          title: filtered ? 'No members match' : 'No members yet',
          body: filtered ? 'Try a different search or clear the filters.' : "YapOS hasn't seen any members in this server yet.",
          action: filtered ? button({ label: 'Clear filters', size: 'sm', onClick: () => {
            search.value = '';
            roleSelect.value = '';
            s.q = '';
            s.role = '';
            s.page = 1;
            writeQuery();
            reload();
          } }) : null,
        }));
        return;
      }
      replace(list,
        h('ul', { class: 'member-list', attrs: { 'aria-label': 'Members' } }, ...members.map((m) => memberRow(m, roleMap, open))),
        pager({ page: page.page, pages: page.pages, label: 'Member pages', onChange: (p) => {
          s.page = p;
          writeQuery();
          reload();
          window.scrollTo(0, 0);
        } }));
    },
  });

  const searcher = latestSearch(async (q) => {
    if (q === s.q) return;
    s.q = q;
    s.page = 1;
    writeQuery();
    await reload();
  });
  const typed = () => search.value.trim().slice(0, 100);
  search.addEventListener('input', () => searcher.push(typed()));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searcher.now(typed());
    }
  });
  roleSelect.addEventListener('change', () => {
    s.role = roleSelect.value;
    s.page = 1;
    writeQuery();
    reload();
  });
  sortSelect.addEventListener('change', () => {
    s.sort = sortSelect.value;
    s.page = 1;
    writeQuery();
    reload();
  });
  refreshBtn.addEventListener('click', () => reload());
  ctx.signal?.addEventListener?.('abort', () => searcher.cancel(), { once: true });
}
