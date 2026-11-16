import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, copyButton, emptyState, errorState, linkButton, loadingRegion, skeleton } from '../ui.js';
import { formatNumber, relativeTime } from '../format.js';
import { ApiError, isAbort } from '../api.js';
import { profilePath } from '../router.js';
import { publicFrame } from '../public-frame.js';
import { levelProgress, normalizeProfile, SEASON_KINDS } from '../community-data.js';
import { medalFor } from '../public-data.js';

export const PROFILE_API = '/api/u';
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function levelRing(level, xp) {
  const prog = levelProgress(level, xp);
  const pct = Math.round(prog.frac * 100);
  const fill = svg('circle', { class: 'level-ring-fill', cx: 50, cy: 50, r: 44, pathLength: 100 });
  fill.style.setProperty('--p', String(pct));
  const ring = svg('svg', { class: 'level-ring-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
  ring.append(svg('circle', { class: 'level-ring-track', cx: 50, cy: 50, r: 44, pathLength: 100 }), fill);
  const label = prog.known
    ? `Level ${formatNumber(prog.level)}, ${formatNumber(prog.into)} of ${formatNumber(prog.need)} XP to the next level`
    : `Level ${formatNumber(prog.level)}`;
  return h('div', { class: 'level-ring', attrs: { role: 'img', 'aria-label': label } },
    ring,
    h('span', { class: 'level-ring-text' },
      h('span', { class: 'level-ring-num', text: formatNumber(prog.level) }),
      h('span', { class: 'level-ring-cap', text: 'Level' })));
}

function stat(label, value, iconName) {
  return h('div', { class: 'profile-stat' },
    h('span', { class: 'profile-stat-icon' }, icon(iconName, { size: 16 })),
    h('span', { class: 'profile-stat-value', text: value }),
    h('span', { class: 'profile-stat-label', text: label }));
}

function clanTag(clan) {
  if (!clan) return null;
  const el = h('span', { class: 'clan-tag', title: clan.name },
    clan.tag ? h('span', { class: 'clan-tag-code', text: `[${clan.tag}]` }) : null,
    h('span', { class: 'clan-tag-name', text: clan.name }));
  if (clan.colour) el.style.setProperty('--clan', clan.colour);
  return el;
}

function tileGrid(items, label) {
  return h('ul', { class: 'badge-grid', attrs: { 'aria-label': label } },
    ...items.map((b) => h('li', { class: 'badge-tile', title: b.label },
      h('span', { class: 'badge-tile-emoji', attrs: { 'aria-hidden': 'true' }, text: b.emoji }),
      h('span', { class: 'badge-tile-label', text: b.label }))));
}

function section(title, iconName, body) {
  return h('section', { class: 'profile-section' },
    h('h2', { class: 'profile-section-title' }, icon(iconName, { size: 16 }), h('span', { text: title })),
    body);
}

export function placingText(s) {
  const kind = SEASON_KINDS[s.kind] || SEASON_KINDS.xp;
  return `#${s.rank} for ${kind.long} in ${s.label}`;
}

function placingRow(s) {
  const medal = medalFor(s.rank);
  return h('li', { class: 'placing-row' },
    medal
      ? h('span', { class: ['medal', `medal-${medal}`], attrs: { 'aria-hidden': 'true' } }, h('span', { text: String(s.rank) }))
      : h('span', { class: 'rank-num', attrs: { 'aria-hidden': 'true' }, text: String(s.rank) }),
    h('span', { class: 'placing-text', text: placingText(s) }));
}

export function profileCard(p, { own = false } = {}) {
  const share = `${window.location.origin}${profilePath(p.username || p.name)}`;
  const stats = [
    stat('Party games', formatNumber(p.games), 'sparkles'),
    stat('Party wins', formatNumber(p.wins), 'trophy'),
  ];
  if (p.shards !== null) stats.push(stat('💎 Shards', formatNumber(p.shards), 'coins'));
  const sections = [
    section('Badges', 'star', p.badges.length ? tileGrid(p.badges, 'Badges') : h('p', { class: 'muted', text: 'No badges yet. They come from playing YapOS Party.' })),
  ];
  if (p.achievements.length) sections.push(section('Achievements', 'trophy', tileGrid(p.achievements, 'Achievements')));
  sections.push(section('Favourite games', 'smile', p.favourites.length
    ? h('ul', { class: 'fav-list' }, ...p.favourites.map((g) => h('li', { class: 'fav-row' },
      h('span', { class: 'fav-emoji', attrs: { 'aria-hidden': 'true' }, text: g.emoji }),
      h('span', { class: 'fav-name', text: g.name }),
      g.plays !== null ? h('span', { class: 'fav-plays', text: `${formatNumber(g.plays)} ${g.plays === 1 ? 'game' : 'games'}${g.won ? ` · ${formatNumber(g.won)} ${g.won === 1 ? 'win' : 'wins'}` : ''}` }) : null)))
    : h('p', { class: 'muted', text: 'No Party games played yet.' })));
  sections.push(section('Season placings', 'activity', p.season.length
    ? h('ol', { class: 'placing-list' }, ...p.season.slice(0, 12).map(placingRow))
    : h('p', { class: 'muted', text: 'No top 10 finishes yet.' })));
  return h('article', { class: 'profile-card' },
    h('div', { class: 'profile-hero' },
      h('div', { class: 'profile-avatar-wrap' }, avatar({ name: p.name, url: p.avatar, id: p.id || p.username, size: 'xl' })),
      h('div', { class: 'profile-who' },
        h('h1', { class: 'profile-name', text: p.name }),
        h('div', { class: 'profile-sub' },
          p.username ? h('span', { class: 'profile-handle', text: `@${p.username}` }) : null,
          clanTag(p.clan)),
        p.updatedAt ? h('p', { class: 'public-meta' }, icon('clock', { size: 14 }), h('span', { text: `Updated ${relativeTime(p.updatedAt)}` })) : null),
      h('div', { class: 'profile-actions' },
        copyButton({ getText: () => share, label: 'Copy link', size: 'sm' }),
        own ? linkButton({ label: 'Privacy', href: '/account', icon: 'lock', size: 'sm' }) : null)),
    h('div', { class: 'profile-stats' }, levelRing(p.level, p.xp), ...stats),
    h('div', { class: 'profile-sections' }, ...sections));
}

function profileSkeleton() {
  return loadingRegion('Loading profile', h('div', { class: 'profile-card' },
    h('div', { class: 'profile-hero' }, skeleton('skeleton-avatar-xl'), h('div', { class: 'profile-who' }, skeleton('skeleton-title skeleton-w-50'), skeleton('skeleton-text skeleton-w-30')))));
}

export function renderProfile(root, ctx) {
  const { api, params, signal } = ctx;
  const frame = publicFrame(root);
  const { content } = frame;
  frame.setUser(null);
  let user = null;
  let shown = null;
  ctx.getUser?.().then((u) => {
    if (signal.aborted) return;
    user = u || null;
    frame.setUser(user);
    if (shown) draw(shown);
  }).catch(() => {});

  function isOwn(p) {
    return Boolean(user && ((p.id && user.id === p.id) || (p.username && String(user.username || '').toLowerCase() === p.username.toLowerCase())));
  }

  function draw(p) {
    shown = p;
    ctx.setTitle(p.name);
    replace(content, profileCard(p, { own: isOwn(p) }));
  }

  const load = async () => {
    replace(content, profileSkeleton());
    try {
      const data = await api.get(`${PROFILE_API}/${encodeURIComponent(params.name || '')}`, { signal, allow401: true });
      if (signal.aborted) return;
      const p = normalizeProfile(data);
      if (!p) throw new ApiError("We couldn't find that.", { status: 404, code: 'not_found' });
      draw(p);
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        ctx.setTitle('Profile not found');
        replace(content, emptyState({
          icon: 'eye-off',
          title: "This profile isn't available",
          body: "Either nobody has this name on YapOS yet, or they've chosen to keep their profile private.",
          action: linkButton({ label: 'Open the leaderboard', href: '/p/global' }),
        }));
        return;
      }
      replace(content, errorState({ title: "Couldn't load this profile", body: err.message, onRetry: load }));
    }
  };
  load();
}
