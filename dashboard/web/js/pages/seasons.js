import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState, errorState, loadingRegion, skeleton } from '../ui.js';
import { formatNumber } from '../format.js';
import { isAbort } from '../api.js';
import { profilePath } from '../router.js';
import { publicFrame } from '../public-frame.js';
import { normalizeSeasons, SEASON_KINDS } from '../community-data.js';
import { medalFor } from '../public-data.js';

export const SEASONS_API = '/api/seasons';

function rankMark(rank) {
  const medal = medalFor(rank);
  if (medal) return h('span', { class: ['medal', `medal-${medal}`], attrs: { role: 'img', 'aria-label': `Rank ${rank}` } }, h('span', { text: String(rank) }));
  return h('span', { class: 'rank-num', attrs: { 'aria-label': `Rank ${rank}` }, text: String(rank) });
}

function boardList(rows, kind) {
  const meta = SEASON_KINDS[kind];
  if (!rows.length) return h('p', { class: 'muted season-none', text: 'Nobody placed here.' });
  return h('ol', { class: 'season-board', attrs: { 'aria-label': meta.long } },
    ...rows.map((r) => h('li', { class: ['season-row', r.rank <= 3 ? `is-top-${r.rank}` : ''] },
      rankMark(r.rank),
      r.linked
        ? h('a', { href: profilePath(r.username), class: 'season-name', dataset: { link: '' }, text: r.name })
        : h('span', { class: 'season-name', text: r.name }),
      h('span', { class: 'season-value', text: kind === 'shards' ? `💎 ${formatNumber(r.value)}` : `${formatNumber(r.value)} XP` }))));
}

export function seasonCard(s) {
  return h('section', { class: 'season-card', id: `season-${s.month}` },
    h('h2', { class: 'season-title' }, icon('trophy', { size: 16 }), h('span', { text: s.label })),
    h('div', { class: 'season-boards' },
      ...['xp', 'shards'].map((kind) => h('div', { class: 'season-col' },
        h('h3', { class: 'season-col-title' }, h('span', { attrs: { 'aria-hidden': 'true' }, text: SEASON_KINDS[kind].emoji }), h('span', { text: SEASON_KINDS[kind].long })),
        boardList(s[kind], kind)))));
}

function seasonsSkeleton() {
  return loadingRegion('Loading past seasons', h('div', { class: 'season-card' },
    skeleton('skeleton-title skeleton-w-30'),
    h('div', { class: 'season-boards' }, ...Array.from({ length: 2 }, () => h('div', { class: 'season-col' }, ...Array.from({ length: 5 }, () => skeleton('skeleton-text skeleton-w-60')))))));
}

export function renderSeasons(root, ctx) {
  const { api, signal } = ctx;
  const frame = publicFrame(root, { current: '/seasons' });
  frame.setUser(null);
  ctx.getUser?.().then((u) => {
    if (!signal.aborted) frame.setUser(u || null);
  }).catch(() => {});
  ctx.setTitle('Past seasons');
  const list = h('div', { class: 'season-list' });
  replace(frame.content,
    h('div', { class: 'public-hero' },
      h('span', { class: 'public-crest', attrs: { 'aria-hidden': 'true' } }, icon('trophy', { size: 30 })),
      h('div', { class: 'public-hero-text' },
        h('p', { class: 'public-eyebrow', text: 'Hall of fame' }),
        h('h1', { class: 'public-title', text: 'Past seasons' }),
        h('p', { class: 'public-lead', text: 'Every month is a new season. When one ends, its top 10 for XP and for 💎 Shards earned stay here for good.' }))),
    list);

  const load = async () => {
    replace(list, seasonsSkeleton());
    try {
      const data = await api.get(SEASONS_API, { signal, allow401: true });
      if (signal.aborted) return;
      const seasons = normalizeSeasons(data);
      if (!seasons.length) {
        replace(list, emptyState({ icon: 'trophy', title: 'No finished seasons yet', body: 'The first season shows up here as soon as the month ends.' }));
        return;
      }
      replace(list, ...seasons.map(seasonCard));
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      replace(list, errorState({ title: "Couldn't load past seasons", body: err.message, onRetry: load }));
    }
  };
  load();
}
