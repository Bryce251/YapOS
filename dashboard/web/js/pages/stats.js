import { h, replace } from '../dom.js';
import { button, card, emptyState, loadingRegion, pageHeader, skeleton, skeletonBlock, statCard, statCardSkeleton } from '../ui.js';
import { formatCompact, formatNumber } from '../format.js';
import { readJob, serverApi, withQuery } from '../kit.js';
import { mountAsync } from './common.js';
import { serverChrome } from './overview.js';
import { heatLevel, hourLabel, normalizeStats, WEEKDAYS } from '../community-data.js';

export const RANGES = Object.freeze([[7, 'Last 7 days'], [30, 'Last 30 days']]);
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function statsPath(sid, days) {
  return withQuery(serverApi(sid, 'stats'), { days: days === 30 ? 30 : 7 });
}

function dayLabel(day, long = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

export function messagesChart(days) {
  const max = Math.max(1, ...days.map((d) => d.messages));
  const total = days.reduce((s, d) => s + d.messages, 0);
  return h('div', { class: 'pulse-chart' },
    h('ol', { class: 'pulse-bars stats-bars', attrs: { role: 'img', 'aria-label': `Messages per day for the last ${days.length} days, ${formatNumber(total)} in total` } },
      ...days.map((d, i) => h('li', {
        class: ['pulse-bar-col', d.messages ? '' : 'is-zero'],
        title: `${dayLabel(d.day, true)}: ${formatNumber(d.messages)} ${d.messages === 1 ? 'message' : 'messages'}`,
        style: { '--h': `${Math.round((d.messages / max) * 100)}%`, '--i': String(i) },
      }, h('span', { class: 'pulse-bar' })))),
    h('div', { class: 'pulse-axis' }, h('span', { text: dayLabel(days[0].day) }), h('span', { text: 'Today' })));
}

export function joinsChart(days) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.joins, d.leaves)));
  const joins = days.reduce((s, d) => s + d.joins, 0);
  const leaves = days.reduce((s, d) => s + d.leaves, 0);
  return h('div', { class: 'flow-chart' },
    h('div', { class: 'flow-legend', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'flow-key is-join' }, h('span', { class: 'flow-swatch' }), h('span', { text: `Joined · ${formatNumber(joins)}` })),
      h('span', { class: 'flow-key is-leave' }, h('span', { class: 'flow-swatch' }), h('span', { text: `Left · ${formatNumber(leaves)}` }))),
    h('ol', { class: 'flow-bars', attrs: { role: 'img', 'aria-label': `${formatNumber(joins)} joined and ${formatNumber(leaves)} left in the last ${days.length} days` } },
      ...days.map((d, i) => h('li', { class: 'flow-col', title: `${dayLabel(d.day, true)}: ${formatNumber(d.joins)} joined, ${formatNumber(d.leaves)} left` },
        h('span', { class: ['flow-bar', 'is-join', d.joins ? '' : 'is-zero'], style: { '--h': `${Math.round((d.joins / max) * 100)}%`, '--i': String(i) } }),
        h('span', { class: ['flow-bar', 'is-leave', d.leaves ? '' : 'is-zero'], style: { '--h': `${Math.round((d.leaves / max) * 100)}%`, '--i': String(i) } })))),
    h('div', { class: 'pulse-axis' }, h('span', { text: dayLabel(days[0].day) }), h('span', { text: 'Today' })));
}

export function heatmap(heat, peak) {
  const max = Math.max(0, ...heat.flat());
  const summary = peak
    ? `Busiest hours. The busiest is ${FULL_DAYS[peak.day]} around ${hourLabel(peak.hour)} with ${formatNumber(peak.count)} messages.`
    : 'Busiest hours. No messages yet.';
  return h('div', { class: 'heat-wrap' },
    h('div', { class: 'heat', attrs: { role: 'img', 'aria-label': summary } },
      h('span', { class: 'heat-corner' }),
      ...Array.from({ length: 24 }, (_, hr) => h('span', { class: 'heat-hour', text: hr % 6 === 0 ? hourLabel(hr) : '' })),
      ...heat.flatMap((row, day) => [
        h('span', { class: 'heat-day', text: WEEKDAYS[day] }),
        ...row.map((n, hr) => h('span', { class: ['heat-cell', `heat-${heatLevel(n, max)}`], title: `${FULL_DAYS[day]} ${hourLabel(hr)}: ${formatNumber(n)} ${n === 1 ? 'message' : 'messages'}` })),
      ])),
    h('div', { class: 'heat-scale', attrs: { 'aria-hidden': 'true' } },
      h('span', { text: 'Quiet' }),
      ...[0, 1, 2, 3, 4].map((l) => h('span', { class: ['heat-cell', `heat-${l}`] })),
      h('span', { text: 'Busy' })));
}

function statsSkeleton() {
  return loadingRegion('Loading server stats',
    h('div', { class: 'stat-grid' }, ...Array.from({ length: 4 }, statCardSkeleton)),
    h('section', { class: 'card' }, h('div', { class: 'card-header' }, skeleton('skeleton-text skeleton-w-30')), h('div', { class: 'card-body' }, skeletonBlock(4))));
}

export function statsView(s) {
  if (s.empty) {
    return emptyState({ icon: 'chart', title: 'No stats yet', body: 'YapOS counts messages, joins and leaves every hour. The first numbers show up here within an hour or so.' });
  }
  const net = s.totals.joins - s.totals.leaves;
  return h('div', { class: 'stack stats-stack' },
    h('div', { class: 'stat-grid' },
      statCard({ label: 'Messages', value: formatCompact(s.totals.messages), icon: 'message', hint: `${formatNumber(Math.round(s.totals.messages / s.span))} a day on average` }),
      statCard({ label: 'Joined', value: formatCompact(s.totals.joins), icon: 'users' }),
      statCard({ label: 'Left', value: formatCompact(s.totals.leaves), icon: 'logout' }),
      statCard({ label: 'Growth', value: `${net > 0 ? '+' : ''}${formatNumber(net)}`, icon: 'activity', tone: net > 0 ? 'success' : net < 0 ? 'danger' : '', hint: s.peak ? `Busiest: ${WEEKDAYS[s.peak.day]} ${hourLabel(s.peak.hour)}` : '' })),
    card({ title: 'Messages per day', icon: 'chart' }, messagesChart(s.days)),
    card({ title: 'Joins and leaves', icon: 'users' }, joinsChart(s.days)),
    card({ title: 'Busiest hours', icon: 'clock' },
      heatmap(s.heat, s.peak),
      h('p', { class: 'field-help', text: 'Shown in your local time. Darker squares had more messages.' })));
}

export function renderStats(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'stats', 'Stats');
  const asked = Number(new URLSearchParams(window.location.search).get('days'));
  let days = asked === 30 ? 30 : 7;
  const rangeBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Time range' } });
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page' },
    pageHeader({
      title: 'Stats',
      description: 'How busy the server is. Only counts are kept, never what anyone said.',
      actions: rangeBar,
    }),
    body));

  function drawRange() {
    replace(rangeBar, ...RANGES.map(([value, label]) => {
      const b = button({ label, size: 'sm', variant: days === value ? 'segment-active' : 'segment', onClick: () => {
        if (days === value) return;
        days = value;
        const url = new URL(window.location.href);
        if (days === 7) url.searchParams.delete('days');
        else url.searchParams.set('days', String(days));
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
        drawRange();
        reload();
      } });
      b.setAttribute('aria-pressed', days === value ? 'true' : 'false');
      return b;
    }));
  }

  drawRange();
  const reload = mountAsync(body, {
    signal: ctx.signal,
    skeleton: statsSkeleton,
    load: ({ signal, onPending }) => readJob(ctx, statsPath(params.sid, days), { signal, onPending }),
    render: (data) => {
      serverChrome(ctx, 'stats', 'Stats');
      body.replaceChildren(statsView(normalizeStats(data, { days })));
    },
  });
}
