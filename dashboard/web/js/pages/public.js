import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, copyButton, emptyState, errorState, linkButton, loadingRegion, skeleton } from '../ui.js';
import { brand } from '../shell.js';
import { themeToggle } from '../theme.js';
import { medalFor, normalizeBoard, normalizeWrapped } from '../public-data.js';
import { formatNumber, relativeTime } from '../format.js';
import { ApiError, isAbort } from '../api.js';
import { publicPath } from '../router.js';

const TABS = [
  { id: 'levels', label: 'Levels', icon: 'trophy' },
  { id: 'coins', label: 'Coins', icon: 'coins' },
  { id: 'wrapped', label: 'Wrapped', icon: 'gift' },
];

function rankBadge(rank) {
  const medal = medalFor(rank);
  if (medal) return h('span', { class: ['medal', `medal-${medal}`], attrs: { role: 'img', 'aria-label': `Rank ${rank}` } }, h('span', { text: String(rank) }));
  return h('span', { class: 'rank-num', attrs: { 'aria-label': `Rank ${rank}` }, text: String(rank) });
}

function boardView(rows, kind) {
  if (!rows.length) {
    return emptyState({ icon: kind === 'economy' ? 'coins' : 'trophy', title: 'Nobody here yet', body: kind === 'economy' ? 'Coins earned in the server will rank people here.' : 'Chatting earns XP. The most active members show up here.' });
  }
  const filter = h('input', { type: 'search', class: 'input', placeholder: 'Find a member', attrs: { 'aria-label': 'Find a member' } });
  const list = h('ol', { class: 'board', attrs: { 'aria-label': kind === 'economy' ? 'Coins leaderboard' : 'Levels leaderboard' } });
  const none = h('p', { class: 'muted board-none', hidden: true, text: 'No one matches that name.' });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const visible = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
    none.hidden = visible.length > 0;
    replace(list, ...visible.map((r) => h('li', { class: ['board-row', r.rank <= 3 ? `is-top is-top-${r.rank}` : ''] },
      rankBadge(r.rank),
      avatar({ name: r.name, url: r.avatar, id: r.id, size: 'md' }),
      h('div', { class: 'board-who' },
        h('span', { class: 'board-name', text: r.name }),
        r.secondary ? h('span', { class: 'board-sub', text: r.secondary }) : null),
      h('div', { class: 'board-score' },
        h('span', { class: 'board-value', text: formatNumber(r.primary) }),
        h('span', { class: 'board-unit', text: r.primaryLabel === 'level' ? 'Level' : 'Coins' })))));
  };
  filter.addEventListener('input', draw);
  draw();
  return h('div', { class: 'board-wrap' },
    rows.length > 10 ? h('div', { class: 'input-shell has-lead board-filter' }, icon('search', { size: 14, className: 'input-lead' }), filter) : null,
    list, none);
}

function wrappedView(raw) {
  const w = normalizeWrapped(raw);
  if (!w || w.empty) {
    return emptyState({ icon: 'gift', title: 'No Wrapped yet', body: w?.note || 'Once a month has passed, the server recap shows up here: messages, top channels, busiest times and more.' });
  }
  return h('div', { class: 'wrapped' },
    h('div', { class: 'wrapped-head' },
      h('span', { class: 'wrapped-icon' }, icon('gift', { size: 18 })),
      h('div', null,
        h('h2', { class: 'wrapped-title', text: w.title || (w.month ? `${w.month} Wrapped` : 'Server Wrapped') }),
        h('p', { class: 'wrapped-sub', text: w.note || 'Counts from public channels only. Message text is never stored.' }))),
    w.stats.length ? h('dl', { class: 'wrapped-stats' }, ...w.stats.map((s) => h('div', { class: 'wrapped-stat' }, h('dt', { text: s.label }), h('dd', { text: s.value })))) : null,
    w.highlights.length ? h('div', { class: 'wrapped-highlights' }, ...w.highlights.map((x) => h('div', { class: 'wrapped-highlight' },
      avatar({ name: x.label, url: x.avatar, size: 'md' }),
      h('div', null, h('p', { class: 'wrapped-hl-title', text: x.title }), h('p', { class: 'wrapped-hl-name', text: x.label }), x.value ? h('p', { class: 'wrapped-hl-sub', text: x.value }) : null)))) : null,
    w.lists.length ? h('div', { class: 'wrapped-lists' }, ...w.lists.map((l) => h('section', { class: 'wrapped-list' },
      h('h3', { class: 'wrapped-list-title', text: l.title }),
      h('ol', null, ...l.items.map((it, i) => h('li', null,
        h('span', { class: 'wrapped-rank', text: String(i + 1) }),
        h('span', { class: 'wrapped-item', text: it.label }),
        it.value ? h('span', { class: 'wrapped-item-value', text: it.value }) : null)))))) : null);
}

function publicSkeleton() {
  return loadingRegion('Loading leaderboard',
    h('div', { class: 'public-hero' }, skeleton('skeleton-avatar-xl'), h('div', { class: 'public-hero-text' }, skeleton('skeleton-title skeleton-w-50'), skeleton('skeleton-text skeleton-w-30'))),
    h('div', { class: 'public-card' }, h('ol', { class: 'board' }, ...Array.from({ length: 8 }, () => h('li', { class: 'board-row' }, skeleton('skeleton-rank'), skeleton('skeleton-avatar'), h('div', { class: 'board-who' }, skeleton('skeleton-text skeleton-w-40')), skeleton('skeleton-text skeleton-w-10'))))));
}

export function renderPublic(root, ctx) {
  const { params, signal, api } = ctx;
  const content = h('div', { class: 'public-content' });
  root.replaceChildren(h('div', { class: 'public-site' },
    h('header', { class: 'site-header' }, h('div', { class: 'site-header-inner' }, brand({ href: '/' }), h('div', { class: 'site-header-actions' }, themeToggle()))),
    h('main', { class: 'public-main', id: 'main', tabIndex: -1 }, content),
    h('footer', { class: 'site-footer' }, h('span', { text: 'Powered by YapOS' }))));
  replace(content, publicSkeleton());

  const load = async () => {
    replace(content, publicSkeleton());
    try {
      const data = await api.get(`/api/public/${encodeURIComponent(params.slug)}`, { signal, allow401: true });
      if (signal.aborted) return;
      draw(data || {});
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        ctx.setTitle('Page not found');
        replace(content, emptyState({ icon: 'eye-off', title: "This page isn't available", body: 'The link may be wrong, or the server has turned its public page off.', action: linkButton({ label: 'Go to YapOS', href: '/' }) }));
        return;
      }
      replace(content, errorState({ title: "Couldn't load this page", body: err.message, onRetry: load }));
    }
  };

  function draw(data) {
    const name = String(data.name || 'Server');
    ctx.setTitle(`${name} leaderboard`);
    const levels = normalizeBoard(data.levels, 'levels');
    const economy = normalizeBoard(data.economy, 'economy');
    const initial = new URLSearchParams(window.location.search).get('tab');
    let current = TABS.some((t) => t.id === initial) ? initial : 'levels';
    const panel = h('div', { class: 'tab-panel', attrs: { role: 'tabpanel' }, tabIndex: 0 });
    const tabButtons = TABS.map((t) => h('button', {
      type: 'button',
      class: 'tab',
      id: `tab-${t.id}`,
      attrs: { role: 'tab', 'aria-controls': 'public-panel' },
    }, icon(t.icon, { size: 16 }), h('span', { text: t.label })));
    panel.id = 'public-panel';
    const select = (id, focus = false) => {
      current = id;
      tabButtons.forEach((b, i) => {
        const on = TABS[i].id === id;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        b.classList.toggle('is-active', on);
        if (on && focus) b.focus();
      });
      panel.setAttribute('aria-labelledby', `tab-${id}`);
      replace(panel, id === 'levels' ? boardView(levels, 'levels') : id === 'coins' ? boardView(economy, 'economy') : wrappedView(data.wrapped));
      const url = new URL(window.location.href);
      if (id === 'levels') url.searchParams.delete('tab');
      else url.searchParams.set('tab', id);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    };
    tabButtons.forEach((b, i) => {
      b.addEventListener('click', () => select(TABS[i].id));
      b.addEventListener('keydown', (e) => {
        let j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = TABS.length - 1;
        if (j >= 0) {
          e.preventDefault();
          select(TABS[j].id, true);
        }
      });
    });
    const shareUrl = `${window.location.origin}${publicPath(params.slug)}`;
    const shareBtn = copyButton({ getText: () => shareUrl, label: 'Copy link' });
    replace(content,
      h('div', { class: 'public-hero' },
        avatar({ name, url: data.icon || data.icon_url, id: params.slug, size: 'xl', shape: 'square' }),
        h('div', { class: 'public-hero-text' },
          h('p', { class: 'public-eyebrow', text: 'Leaderboard' }),
          h('h1', { class: 'public-title', text: name }),
          data.updatedAt ? h('p', { class: 'public-meta' }, icon('clock', { size: 14 }), h('span', { text: `Updated ${relativeTime(data.updatedAt)}` })) : null),
        h('div', { class: 'public-hero-actions' }, shareBtn)),
      h('div', { class: 'public-card' },
        h('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Leaderboards' } }, ...tabButtons),
        panel));
    select(current);
  }

  load();
}
