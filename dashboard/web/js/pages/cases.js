import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, badge, button, emptyState, loadingRegion, pageHeader, setBusy, skeleton, toast } from '../ui.js';
import { forbiddenError, loadServer, mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { caseTypes, filterCases, normalizeCases, readCasesPage, sortCases } from '../cases.js';
import { caseTone, formatDate, formatDurationMs, formatNumber, relativeTime, toNumber } from '../format.js';
import { isAbort, isPending } from '../api.js';
import { openMemberDrawer } from './member.js';

const PAGE = 50;
const FIRST_PAGES = 6;
const MORE_PAGES = 4;
const cache = new Map();

const COLUMNS = [
  { key: 'n', label: 'Case', sortable: true, className: 'col-n' },
  { key: 'type', label: 'Type', sortable: true, className: 'col-type' },
  { key: 'user', label: 'Member', sortable: true, className: 'col-user' },
  { key: 'mod', label: 'Moderator', sortable: true, className: 'col-mod' },
  { key: 'reason', label: 'Reason', sortable: false, className: 'col-reason' },
  { key: 'at', label: 'Date', sortable: true, className: 'col-at' },
];

async function fetchPages(ctx, entry, count, { onPending, signal }) {
  const sid = ctx.params.sid;
  const seen = new Set(entry.cases.map((c) => `${c.n}:${c.type}:${c.at}`));
  for (let i = 0; i < count && !entry.complete; i++) {
    const page = entry.page + 1;
    const path = `/api/servers/${encodeURIComponent(sid)}/cases?page=${page}`;
    let data = await ctx.api.get(path, { signal });
    if (isPending(data)) {
      onPending?.(data.job);
      const result = await ctx.api.job(data.job, { signal });
      if (result && result.grant === false) throw forbiddenError();
      data = await ctx.api.get(path, { signal });
      if (isPending(data)) throw forbiddenError("YapOS hasn't confirmed your access yet. Try again in a moment.");
    }
    const { cases, more, total } = readCasesPage(data);
    entry.page = page;
    if (total !== null) entry.total = total;
    for (const c of normalizeCases(cases)) {
      const k = `${c.n}:${c.type}:${c.at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      entry.cases.push(c);
    }
    if (!more || !cases.length || entry.cases.length >= 2000) entry.complete = true;
  }
  if (entry.complete) entry.total = entry.cases.length;
  entry.at = Date.now();
  return entry;
}

async function loadCases(ctx, opts) {
  const sid = ctx.params.sid;
  const hit = cache.get(sid);
  if (hit && Date.now() - hit.at < 60000) return hit;
  await loadServer(ctx, opts);
  const entry = { at: 0, cases: [], page: 0, total: null, complete: false };
  await fetchPages(ctx, entry, FIRST_PAGES, opts);
  cache.set(sid, entry);
  return entry;
}

function tableSkeleton() {
  return loadingRegion('Loading cases', h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, ...COLUMNS.map((c) => h('th', { class: c.className, text: c.label })))),
    h('tbody', null, ...Array.from({ length: 8 }, () => h('tr', null, ...COLUMNS.map((c) => h('td', { class: c.className }, skeleton(c.key === 'reason' ? 'skeleton-text skeleton-w-90' : 'skeleton-text skeleton-w-60')))))))));
}

function readQuery() {
  const p = new URLSearchParams(window.location.search);
  return { q: p.get('q') || '', type: p.get('type') || '', status: p.get('status') || '', sort: p.get('sort') || 'n', dir: p.get('dir') === 'asc' ? 'asc' : 'desc' };
}

function writeQuery(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.type) p.set('type', s.type);
  if (s.status) p.set('status', s.status);
  if (s.sort !== 'n') p.set('sort', s.sort);
  if (s.dir !== 'desc') p.set('dir', s.dir);
  const qs = p.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

export function renderCases(ctx) {
  const { main } = ctx;
  serverChrome(ctx, 'cases', 'Cases');
  const s = readQuery();
  let all = [];
  let entry = null;
  let shown = PAGE;
  let loadingMore = false;
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search by member, moderator, reason or #case', value: s.q, attrs: { 'aria-label': 'Search cases' } });
  const typeSelect = h('select', { class: 'input select', attrs: { 'aria-label': 'Filter by type' } });
  const statusSelect = h('select', { class: 'input select', attrs: { 'aria-label': 'Filter by status' } },
    h('option', { value: '', text: 'Any status' }), h('option', { value: 'active', text: 'Active only' }), h('option', { value: 'ended', text: 'Ended or permanent' }));
  statusSelect.value = s.status;
  const count = h('p', { class: 'toolbar-count', attrs: { 'aria-live': 'polite' } });
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', size: 'sm' });
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page' },
    pageHeader({ title: 'Cases', description: 'Every moderation action YapOS has recorded in this server.', actions: refreshBtn }),
    h('div', { class: 'toolbar toolbar-wrap' },
      h('div', { class: 'input-shell has-lead toolbar-search' }, icon('search', { size: 14, className: 'input-lead' }), search),
      h('div', { class: 'select-shell' }, typeSelect, icon('chevron-down', { size: 14, className: 'select-caret' })),
      h('div', { class: 'select-shell' }, statusSelect, icon('chevron-down', { size: 14, className: 'select-caret' })),
      count),
    body));

  const tableWrap = h('div', { class: 'table-wrap', tabIndex: 0, attrs: { role: 'region', 'aria-label': 'Cases table' } });
  const more = h('div', { class: 'table-more' });

  function headerCell(col) {
    if (!col.sortable) return h('th', { class: col.className, attrs: { scope: 'col' }, text: col.label });
    const active = s.sort === col.key;
    const btn = h('button', { type: 'button', class: ['th-sort', active ? 'is-active' : ''] },
      h('span', { text: col.label }),
      icon(active ? (s.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort', { size: 12 }));
    btn.addEventListener('click', () => {
      if (s.sort === col.key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else {
        s.sort = col.key;
        s.dir = col.key === 'user' || col.key === 'mod' || col.key === 'type' ? 'asc' : 'desc';
      }
      writeQuery(s);
      draw();
      tableWrap.querySelector(`th.${col.className} .th-sort`)?.focus();
    });
    return h('th', { class: col.className, attrs: { scope: 'col', 'aria-sort': active ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none' } }, btn);
  }

  function personCell(p, clickable) {
    const inner = [avatar({ name: p.name, id: p.id, size: 'xs' }), h('span', { class: 'cell-name', text: p.name })];
    if (clickable && p.id) {
      const b = h('button', { type: 'button', class: 'person-btn', attrs: { 'aria-label': `Open ${p.name}'s record` } }, ...inner);
      b.addEventListener('click', () => openMemberDrawer(ctx, p));
      return b;
    }
    return h('span', { class: 'person' }, ...inner);
  }

  function row(c) {
    const dur = toNumber(c.duration);
    return h('tr', null,
      h('td', { class: 'col-n' }, h('span', { class: 'mono', text: `#${c.n}` })),
      h('td', { class: 'col-type' }, h('span', { class: 'type-cell' }, badge(c.typeLabel, caseTone(c.type)), c.active ? badge('Active', 'accent') : null, dur ? h('span', { class: 'cell-sub', text: formatDurationMs(dur) }) : (typeof c.duration === 'string' && c.duration ? h('span', { class: 'cell-sub', text: c.duration }) : null))),
      h('td', { class: 'col-user' }, personCell(c.user, true)),
      h('td', { class: 'col-mod' }, personCell(c.mod, false)),
      h('td', { class: 'col-reason' }, h('span', { class: ['cell-reason', c.reason ? '' : 'muted'], text: c.reason || 'No reason given', title: c.reason || '' })),
      h('td', { class: 'col-at' }, c.at ? h('time', { attrs: { datetime: new Date(c.at).toISOString() }, title: formatDate(c.at), text: relativeTime(c.at) }) : h('span', { class: 'muted', text: '–' })));
  }

  function draw() {
    if (!entry) return;
    const filtered = sortCases(filterCases(all, { q: search.value, type: typeSelect.value, status: statusSelect.value }), { key: s.sort, dir: s.dir });
    const totalText = entry && !entry.complete && entry.total ? ` · ${formatNumber(entry.total)} in total` : '';
    count.textContent = (filtered.length === all.length ? `${formatNumber(all.length)} cases` : `${formatNumber(filtered.length)} of ${formatNumber(all.length)} cases`) + totalText;
    if (!all.length) {
      replace(body, emptyState({ icon: 'shield', title: 'No cases yet', body: 'Warnings, timeouts, kicks and bans from YapOS will be listed here.' }));
      return;
    }
    const older = olderControl();
    if (!filtered.length) {
      const clearBtn = button({ label: 'Clear filters', size: 'sm', onClick: () => {
        search.value = '';
        typeSelect.value = '';
        statusSelect.value = '';
        s.q = '';
        s.type = '';
        s.status = '';
        writeQuery(s);
        draw();
      } });
      replace(body, emptyState({
        icon: 'search',
        title: 'No cases match',
        body: older ? 'Nothing in the cases loaded so far. Load older cases to search further back, or clear the filters.' : 'Try a different search or clear the filters.',
        action: h('div', { class: 'empty-actions' }, older, clearBtn),
      }));
      return;
    }
    const visible = filtered.slice(0, shown);
    replace(tableWrap, h('table', { class: 'table table-cases' },
      h('caption', { class: 'sr-only', text: 'Moderation cases' }),
      h('thead', null, h('tr', null, ...COLUMNS.map(headerCell))),
      h('tbody', null, ...visible.map(row))));
    if (filtered.length > shown) {
      replace(more, button({ label: `Show ${Math.min(PAGE, filtered.length - shown)} more`, size: 'sm', onClick: () => {
        shown += PAGE;
        draw();
      } }), h('span', { class: 'muted', text: `Showing ${formatNumber(visible.length)} of ${formatNumber(filtered.length)}` }));
    } else if (older) {
      replace(more, older, h('span', { class: 'muted', text: `Showing the newest ${formatNumber(all.length)} cases` }));
    } else replace(more);
    if (body.firstChild !== tableWrap) replace(body, tableWrap, more);
  }

  function olderControl() {
    if (!entry || entry.complete) return null;
    const btn = button({ label: 'Load older cases', icon: 'arrow-down', size: 'sm' });
    if (loadingMore) setBusy(btn, true, 'Loading…');
    btn.addEventListener('click', async () => {
      if (loadingMore) return;
      loadingMore = true;
      setBusy(btn, true, 'Loading…');
      try {
        await fetchPages(ctx, entry, MORE_PAGES, { signal: ctx.signal });
        all = entry.cases;
        refreshTypes();
        shown = Math.max(shown, PAGE);
      } catch (err) {
        if (!isAbort(err)) toast(err.message || 'Could not load older cases.', { tone: 'danger' });
      } finally {
        loadingMore = false;
        if (!ctx.signal.aborted) draw();
      }
    });
    return btn;
  }

  function refreshTypes() {
    const types = caseTypes(all);
    const keep = typeSelect.value || s.type;
    replace(typeSelect, h('option', { value: '', text: 'All types' }), ...types.map((t) => h('option', { value: t.value, text: t.label })));
    typeSelect.value = types.some((t) => t.value === keep) ? keep : '';
  }

  function onFilter() {
    s.q = search.value.trim();
    s.type = typeSelect.value;
    s.status = statusSelect.value;
    shown = PAGE;
    writeQuery(s);
    draw();
  }
  search.addEventListener('input', onFilter);
  typeSelect.addEventListener('change', onFilter);
  statusSelect.addEventListener('change', onFilter);

  const reload = mountAsync(body, {
    signal: ctx.signal,
    skeleton: tableSkeleton,
    load: (opts) => loadCases(ctx, opts),
    render: (loaded) => {
      serverChrome(ctx, 'cases', 'Cases');
      entry = loaded;
      all = entry.cases;
      refreshTypes();
      draw();
    },
  });
  refreshBtn.addEventListener('click', () => {
    cache.delete(ctx.params.sid);
    entry = null;
    all = [];
    reload();
  });
}
