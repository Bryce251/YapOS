import { h } from '../dom.js';
import { icon } from '../icons.js';
import { appGlyph, avatar, badge, button, card, dot, emptyState, loadingRegion, pageHeader, skeleton, skeletonBlock, statCard, statCardSkeleton } from '../ui.js';
import { loadServer, mountAsync } from './common.js';
import { serverPath } from '../router.js';
import { caseTone, caseTypeLabel, formatCompact, formatNumber, formatUptime, relativeTime, truncate } from '../format.js';
import { serverSummary } from '../state.js';
import { normalizeCase } from '../cases.js';

export function serverChrome(ctx, section, label) {
  const server = serverSummary(ctx.params.sid);
  const crumbs = [{ label: 'Servers', href: '/servers' }, { label: server.name, href: serverPath(server.id) }];
  if (label) crumbs.push({ label });
  ctx.setChrome({ variant: 'server', section, server, crumbs });
  return server;
}

function overviewSkeleton() {
  return loadingRegion('Loading server overview',
    h('div', { class: 'stat-grid' }, ...Array.from({ length: 5 }, statCardSkeleton)),
    h('div', { class: 'overview-grid' },
      h('section', { class: 'card' }, h('div', { class: 'card-header' }, skeleton('skeleton-text skeleton-w-30')), h('div', { class: 'card-body' }, skeletonBlock(5))),
      h('section', { class: 'card' }, h('div', { class: 'card-header' }, skeleton('skeleton-text skeleton-w-40')), h('div', { class: 'card-body' }, skeletonBlock(4)))));
}

function kv(label, value, extra = null) {
  return h('div', { class: 'kv-row' }, h('dt', { class: 'kv-key', text: label }), h('dd', { class: 'kv-value' }, extra, h('span', { text: value })));
}

function botCard(bot) {
  if (!bot || typeof bot !== 'object') {
    return card({ title: 'Bot status', icon: 'cpu' }, h('p', { class: 'muted', text: 'No status reported yet.' }));
  }
  const gateway = bot.gateway === true || bot.gateway === 'gateway' || bot.gateway === 'connected';
  const latency = Number(bot.latencyMs);
  const latencyTone = !Number.isFinite(latency) ? 'neutral' : latency < 250 ? 'success' : latency < 800 ? 'warning' : 'danger';
  return card({ title: 'Bot status', icon: 'cpu' },
    h('dl', { class: 'kv' },
      kv('Version', bot.version ? String(bot.version) : 'Unknown'),
      kv('Uptime', formatUptime(bot.uptimeSec)),
      kv('Connection', gateway ? 'Live gateway' : (typeof bot.gateway === 'string' && bot.gateway ? bot.gateway : 'Polling'), dot(gateway ? 'success' : 'warning')),
      kv('Latency', Number.isFinite(latency) ? `${Math.round(latency)} ms` : '–', dot(latencyTone)),
      kv('Verified', bot.verified ? 'Yes' : 'No')));
}

function recentCard(sid, recent) {
  const list = Array.isArray(recent) ? recent.slice(0, 10).map(normalizeCase) : [];
  const viewAll = h('a', { href: serverPath(sid, 'cases'), class: 'link-subtle', dataset: { link: '' } }, 'View all', icon('arrow-right', { size: 14 }));
  if (!list.length) {
    return card({ title: 'Recent mod actions', icon: 'shield', actions: viewAll }, emptyState({ icon: 'shield', title: 'No cases yet', body: 'Warnings, timeouts, kicks and bans will show up here.', compact: true }));
  }
  return card({ title: 'Recent mod actions', icon: 'shield', actions: viewAll, bodyClass: 'card-body-flush' },
    h('ul', { class: 'activity-list' }, ...list.map((c) => h('li', { class: 'activity-item' },
      avatar({ name: c.user.name, id: c.user.id, size: 'sm' }),
      h('div', { class: 'activity-text' },
        h('div', { class: 'activity-line' },
          h('span', { class: 'activity-strong', text: c.user.name }),
          badge(c.typeLabel || caseTypeLabel(c.type), caseTone(c.type)),
          h('span', { class: 'activity-case', text: `#${c.n}` })),
        h('div', { class: 'activity-meta', text: [c.reason ? truncate(c.reason, 90) : 'No reason given', c.mod.name ? `by ${c.mod.name}` : ''].filter(Boolean).join(' · ') })),
      h('time', { class: 'activity-time', text: relativeTime(c.at), attrs: { datetime: c.at ? new Date(c.at).toISOString() : null } })))));
}

function appsCard(sid, apps) {
  const list = Array.isArray(apps) ? apps : [];
  const on = list.filter((a) => a.enabled);
  const manage = h('a', { href: serverPath(sid, 'apps'), class: 'link-subtle', dataset: { link: '' } }, 'Manage apps', icon('arrow-right', { size: 14 }));
  if (!list.length) return card({ title: 'Installed apps', icon: 'apps', actions: manage }, h('p', { class: 'muted', text: 'No apps reported yet.' }));
  return card({ title: 'Installed apps', icon: 'apps', actions: manage },
    on.length
      ? h('ul', { class: 'app-chips' }, ...on.map((a) => h('li', null, h('a', { href: serverPath(sid, `apps/${a.id}`), class: 'app-chip', dataset: { link: '' } }, appGlyph(a, 'sm'), h('span', { text: a.name || a.id })))))
      : h('p', { class: 'muted', text: 'No apps are installed. Turn some on from the Apps page.' }));
}

function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function dayLabel(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime())) return day || '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function casesChart(byDay) {
  const days = (Array.isArray(byDay) ? byDay : []).slice(-14)
    .map((d) => ({ day: String(d?.day ?? ''), count: countOf(d?.count) ?? 0 }));
  if (!days.length) return null;
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  return h('div', { class: 'pulse-chart' },
    h('div', { class: 'pulse-summary' },
      h('span', { class: 'pulse-total', text: formatNumber(total) }),
      h('span', { class: 'pulse-caption', text: total === 1 ? 'case in the last 14 days' : 'cases in the last 14 days' })),
    h('ol', { class: 'pulse-bars', attrs: { role: 'img', 'aria-label': `Cases per day for the last ${days.length} days, ${formatNumber(total)} in total` } },
      ...days.map((d, i) => h('li', {
        class: ['pulse-bar-col', d.count ? '' : 'is-zero'],
        title: `${dayLabel(d.day)}: ${formatNumber(d.count)} ${d.count === 1 ? 'case' : 'cases'}`,
        style: { '--h': `${Math.round((d.count / max) * 100)}%`, '--i': String(i) },
      }, h('span', { class: 'pulse-bar' })))),
    h('div', { class: 'pulse-axis' }, h('span', { text: dayLabel(days[0].day) }), h('span', { text: 'Today' })));
}

function typeChips(byType) {
  if (!byType || typeof byType !== 'object') return null;
  const rows = Object.entries(byType)
    .map(([type, n]) => [type, countOf(n) ?? 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (!rows.length) return null;
  return h('div', { class: 'pulse-types', attrs: { 'aria-label': 'Cases by type in the last 30 days' } },
    ...rows.map(([type, n]) => badge(`${caseTypeLabel(type)} · ${formatNumber(n)}`, caseTone(type))));
}

function metric(label, value) {
  const n = countOf(value);
  if (n === null) return null;
  return h('div', { class: 'pulse-metric' },
    h('span', { class: 'pulse-metric-value', text: formatCompact(n) }),
    h('span', { class: 'pulse-metric-label', text: label }));
}

function pulseCard(sid, stats) {
  if (!stats || typeof stats !== 'object') return null;
  const tickets = stats.tickets && typeof stats.tickets === 'object' ? stats.tickets : {};
  const metrics = [
    metric('Active warnings', stats.activeWarns),
    metric('Timed out now', stats.activeTimeouts),
    metric('Temp bans', stats.tempBans),
    metric('Tickets closed this week', tickets.closed7d),
    metric('New members this week', stats.newMembers7d),
  ].filter(Boolean);
  const chart = casesChart(stats.casesByDay);
  if (!chart && !metrics.length) return null;
  const more = h('a', { href: serverPath(sid, 'mod'), class: 'link-subtle', dataset: { link: '' } }, 'Moderation', icon('arrow-right', { size: 14 }));
  return card({ title: 'Last 14 days', icon: 'activity', actions: more, className: 'card-pulse' },
    h('div', null, chart || h('p', { class: 'muted', text: 'No daily numbers yet.' }), typeChips(stats.casesByType)),
    metrics.length ? h('div', { class: 'pulse-metrics' }, ...metrics) : null);
}

export function renderOverview(ctx) {
  const { main, params } = ctx;
  serverChrome(ctx, 'overview', 'Overview');
  const header = h('div');
  const body = h('div', { class: 'page-body' });
  main.replaceChildren(h('div', { class: 'page' }, header, body));
  const drawHeader = (detail, reload) => {
    const ov = detail?.overview || {};
    const name = ov.name || serverSummary(params.sid).name;
    header.replaceChildren(pageHeader({
      title: name,
      eyebrow: h('span', { class: 'eyebrow-row' }, avatar({ name, url: ov.icon_url, id: params.sid, size: 'xs', shape: 'square' }), h('span', { text: 'Overview' })),
      description: detail?.updatedAt ? `Snapshot updated ${relativeTime(detail.updatedAt)}` : 'Live data from YapOS',
      actions: reload ? button({ label: 'Refresh', icon: 'refresh', size: 'sm', onClick: () => reload(true) }) : null,
    }));
  };
  drawHeader(null, null);
  let force = false;
  const reload = mountAsync(body, {
    signal: ctx.signal,
    skeleton: overviewSkeleton,
    load: ({ onPending, signal }) => {
      const f = force;
      force = false;
      return loadServer(ctx, { force: f, onPending, signal });
    },
    render: (detail) => {
      serverChrome(ctx, 'overview', 'Overview');
      drawHeader(detail, () => {
        force = true;
        reload();
      });
      const ov = detail.overview;
      if (!ov) {
        body.replaceChildren(emptyState({ icon: 'cpu', title: 'No overview yet', body: 'YapOS has not sent a snapshot for this server yet. It usually arrives within a few seconds.' }));
        return;
      }
      const counts = ov.counts || {};
      const appsInfo = ov.apps || {};
      const enabledApps = appsInfo.enabled ?? detail.apps.filter((a) => a.enabled).length;
      const totalApps = appsInfo.total ?? detail.apps.length;
      body.replaceChildren(...[
        h('div', { class: 'stat-grid' },
          statCard({ label: 'Members', value: formatCompact(ov.member_count), icon: 'users', hint: ov.online_count !== undefined && ov.online_count !== null ? `${formatNumber(ov.online_count)} online` : '' }),
          statCard({ label: 'Apps installed', value: `${formatNumber(enabledApps)}`, icon: 'apps', hint: `of ${formatNumber(totalApps)} available` }),
          statCard({ label: 'Mod cases', value: formatCompact(counts.cases ?? 0), icon: 'shield', hint: 'All time' }),
          statCard({ label: 'Open tickets', value: formatCompact(counts.openTickets ?? ov.stats?.tickets?.open ?? 0), icon: 'ticket' }),
          statCard({ label: 'Starboard posts', value: formatCompact(counts.starboardPosts ?? 0), icon: 'star' })),
        pulseCard(params.sid, ov.stats),
        h('div', { class: 'overview-grid' },
          recentCard(params.sid, ov.recent),
          h('div', { class: 'stack' }, botCard(ov.bot), appsCard(params.sid, detail.apps))),
      ].filter(Boolean));
    },
  });
}
