import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { emptyState, errorState, linkButton, loadingRegion, skeleton } from '../ui.js';
import { formatNumber } from '../format.js';
import { isAbort } from '../api.js';
import { publicFrame } from '../public-frame.js';
import { normalizeSeasons, SEASON_KINDS } from '../community-data.js';
import { medalFor } from '../public-data.js';
import { state } from '../state.js';
import { boardRowLabel, openBoardPerson } from './board-person.js';

export const SEASONS_API = '/api/seasons';

function rankMark(rank) {
  const medal = medalFor(rank);
  if (medal) return h('span', { class: ['medal', `medal-${medal}`], attrs: { role: 'img', 'aria-label': `Rank ${rank}` } }, h('span', { text: String(rank) }));
  return h('span', { class: 'rank-num', attrs: { 'aria-label': `Rank ${rank}` }, text: String(rank) });
}

export function seasonValueText(kind, value) {
  return kind === 'shards' ? `💎 ${formatNumber(value)}` : `${formatNumber(value)} XP`;
}

export function seasonPerson(r) {
  return { id: r.id || '', name: r.name, avatar: '', handle: r.linked && r.username ? r.username : '', private: !(r.linked && r.username) };
}

export function seasonFacts(s, kind, r) {
  return [
    { label: 'Season', value: s.label, key: 'season' },
    { label: `${SEASON_KINDS[kind].label} rank`, value: `#${formatNumber(r.rank)}`, key: 'rank' },
    { label: kind === 'shards' ? 'Shards earned' : 'XP earned', value: seasonValueText(kind, r.value), key: 'value' },
  ];
}

function boardList(rows, kind, onOpen) {
  const meta = SEASON_KINDS[kind];
  if (!rows.length) return h('p', { class: 'muted season-none', text: 'Nobody placed here.' });
  return h('ol', { class: 'season-board', attrs: { 'aria-label': meta.long } },
    ...rows.map((r) => h('li', { class: 'season-item' }, h('button', {
      type: 'button',
      class: ['season-row', 'season-row-btn', r.rank <= 3 ? `is-top-${r.rank}` : ''],
      dataset: { id: r.id || null },
      attrs: { 'aria-haspopup': 'dialog', 'aria-label': `${boardRowLabel(r.name, r.rank)}, ${seasonValueText(kind, r.value)}` },
      on: { click: () => onOpen?.(r, kind) },
    },
    rankMark(r.rank),
    h('span', { class: 'season-name', text: r.name }),
    h('span', { class: 'season-value', text: seasonValueText(kind, r.value) })))));
}

export function seasonCard(s, onOpen = null) {
  return h('section', { class: 'season-card', id: `season-${s.month}` },
    h('h2', { class: 'season-title' }, icon('trophy', { size: 16 }), h('span', { text: s.label })),
    h('div', { class: 'season-boards' },
      ...['xp', 'shards'].map((kind) => h('div', { class: 'season-col' },
        h('h3', { class: 'season-col-title' }, h('span', { attrs: { 'aria-hidden': 'true' }, text: SEASON_KINDS[kind].emoji }), h('span', { text: SEASON_KINDS[kind].long.replace(`${SEASON_KINDS[kind].emoji} `, '') })),
        boardList(s[kind], kind, onOpen ? (r) => onOpen(s, kind, r) : null)))));
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
        h('p', { class: 'public-lead', text: 'Every month is a new season. When one ends, its top 10 for XP and for 💎 Shards earned stay here for good.' })),
      h('div', { class: 'public-hero-actions' }, linkButton({ label: 'Party leaderboard', href: '/party/leaderboard', size: 'sm', icon: 'trophy' }))),
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
      const open = (s, kind, r) => openBoardPerson({
        person: seasonPerson(r),
        api,
        signal,
        subtitle: `Past season · ${s.label}`,
        facts: seasonFacts(s, kind, r),
        owner: Promise.resolve(state.partyOwner === true),
      });
      replace(list, ...seasons.map((s) => seasonCard(s, open)));
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      replace(list, errorState({ title: "Couldn't load past seasons", body: err.message, onRetry: load }));
    }
  };
  load();
}
