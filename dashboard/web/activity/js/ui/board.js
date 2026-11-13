import { h, avatar } from './dom.js';

const MEDALS = ['🥇', '🥈', '🥉'];
export const COUNT_MS = 650;
export const TOP_COUNT = 3;
const seen = new Map();
const SEEN_MAX = 400;

export function standings(players, field) {
  const rows = players
    .filter((p) => p.slot !== null && ((p.present && p.joined !== false) || p[field] > 0))
    .map((p) => ({ ...p, pts: p[field] || 0 }))
    .sort((a, b) => b.pts - a.pts || a.slot - b.slot);
  let place = 0;
  let prev = null;
  return rows.map((p, i) => {
    if (p.pts !== prev) {
      place = i + 1;
      prev = p.pts;
    }
    return { ...p, place };
  });
}

export function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

export function quiet(win = globalThis) {
  try {
    return Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function badgeFor(r, badge) {
  if (r.badge && r.badge.icon) return r.badge;
  if (!badge || !badge.icon) return null;
  const bySlot = badge.slot !== undefined && badge.slot !== null && r.slot === badge.slot;
  const byId = badge.id !== undefined && badge.id !== null && r.id === badge.id;
  return bySlot || byId ? badge : null;
}

export function gainFor(r, gains) {
  const g = Number(r.gain ?? (gains && r.slot !== null && r.slot !== undefined ? gains[r.slot] : 0)) || 0;
  return g > 0 ? Math.round(g) : 0;
}

export function split(rows, max = 12) {
  const list = rows.slice(0, max);
  const top = list.filter((r) => r.pts > 0 && r.place <= TOP_COUNT).slice(0, TOP_COUNT);
  const rest = list.filter((r) => !top.includes(r));
  return { top, rest };
}

function remember(key, pts) {
  const before = seen.has(key) ? seen.get(key) : null;
  seen.delete(key);
  seen.set(key, pts);
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return before;
}

function countUp(el, from, to) {
  const win = globalThis;
  if (from === null || from === to || quiet(win) || typeof win.requestAnimationFrame !== 'function') {
    el.textContent = fmt(to);
    return;
  }
  el.textContent = fmt(from);
  let t0 = 0;
  const step = (ts) => {
    if (!t0) t0 = ts;
    const k = Math.min(1, (ts - t0) / COUNT_MS);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * eased);
    if (k < 1 && el.isConnected !== false) win.requestAnimationFrame(step);
    else el.textContent = fmt(to);
  };
  win.requestAnimationFrame(step);
}

function points(r, scope, cls) {
  const num = h('span', { class: cls, attrs: { 'aria-label': `${fmt(r.pts)} points` } });
  const before = remember(`${scope}:${r.id}`, r.pts);
  const up = before !== null && r.pts > before;
  countUp(num, up ? before : null, r.pts);
  return { num, up };
}

function face(r, size, mark) {
  return h(
    'span',
    { class: 'board-face' },
    avatar(r, size),
    mark ? h('span', { class: 'board-badge', text: mark.icon, dataset: { badge: mark.label || 'marked' }, attrs: { title: mark.label || '', 'aria-label': mark.label || '' } }) : null,
  );
}

function nameOf(r) {
  return r.isMe ? `${r.name} (you)` : r.name;
}

function card(r, opts, scope) {
  const mark = badgeFor(r, opts.badge);
  const gain = gainFor(r, opts.gains);
  const pts = points(r, scope, 'board-num');
  return h(
    'li',
    {
      class: ['board-card', `place-${r.place}`, r.isMe ? 'is-me' : null, r.present === false ? 'is-away' : null, pts.up ? 'is-up' : null, mark ? 'has-badge' : null],
      dataset: { id: r.id, badge: mark ? mark.label || 'marked' : null },
      attrs: { title: r.username ? `${r.name} (@${r.username})` : r.name },
    },
    h('span', { class: 'board-medal', text: MEDALS[r.place - 1] || String(r.place), attrs: { 'aria-label': `Place ${r.place}` } }),
    face(r, 'md', mark),
    h(
      'span',
      { class: 'board-who' },
      h('span', { class: 'board-name', text: nameOf(r) }),
      h('span', { class: 'board-score' }, pts.num, gain ? h('span', { class: 'board-gain', text: `+${fmt(gain)}` }) : null),
    ),
  );
}

function row(r, opts, scope) {
  const mark = badgeFor(r, opts.badge);
  const gain = gainFor(r, opts.gains);
  const pts = points(r, scope, 'board-pts');
  const scored = r.pts > 0;
  return h(
    'li',
    {
      class: ['board-row', r.isMe ? 'is-me' : null, r.present === false ? 'is-away' : null, pts.up ? 'is-up' : null, mark ? 'has-badge' : null],
      dataset: { id: r.id, badge: mark ? mark.label || 'marked' : null },
      attrs: { title: r.username ? `${r.name} (@${r.username})` : r.name },
    },
    h('span', { class: 'board-place', text: scored ? String(r.place) : '–', attrs: { 'aria-label': scored ? `Place ${r.place}` : 'No points yet' } }),
    face(r, 'sm', mark),
    h(
      'span',
      { class: 'board-who' },
      h('span', { class: 'board-name', text: nameOf(r) }),
      r.username ? h('span', { class: 'board-user', text: `@${r.username}` }) : null,
    ),
    gain ? h('span', { class: 'board-gain', text: `+${fmt(gain)}` }) : null,
    pts.num,
  );
}

export function board(rows, opts = {}) {
  const { empty = 'No points yet.', max = 12, label = 'Scoreboard', zero = false, layout = null } = opts;
  if (!rows.length || (!zero && rows.every((r) => !r.pts))) return h('p', { class: 'board-empty', text: empty, dataset: { scoreboard: 'empty' } });
  const scope = label;
  const { top, rest } = split(rows, max);
  return h(
    'div',
    {
      class: ['board', layout ? `board-${layout}` : null, top.length ? 'has-top' : null, rest.length ? 'has-rest' : null, `top-${top.length}`],
      dataset: { scoreboard: 'list' },
      attrs: { role: 'group', 'aria-label': label },
    },
    top.length ? h('ol', { class: 'board-top' }, top.map((r) => card(r, opts, scope))) : null,
    rest.length ? h('ol', { class: 'board-rest' }, rest.map((r) => row(r, opts, scope))) : null,
  );
}
