import { h, avatar } from './dom.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export function standings(players, field) {
  const rows = players
    .filter((p) => p.slot !== null && (p.present || p[field] > 0))
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

export function board(rows, { empty = 'No points yet.', max = 12, label = 'Scoreboard' } = {}) {
  if (!rows.length || rows.every((r) => !r.pts)) return h('p', { class: 'board-empty', text: empty });
  return h(
    'ol',
    { class: 'board', attrs: { 'aria-label': label } },
    rows.slice(0, max).map((r) =>
      h(
        'li',
        { class: ['board-row', r.isMe ? 'is-me' : null, r.place === 1 && r.pts > 0 ? 'is-top' : null, r.present ? null : 'is-away'] },
        h('span', { class: 'board-place', text: r.pts > 0 && r.place <= 3 ? MEDALS[r.place - 1] : String(r.place) }),
        avatar(r, 'sm'),
        h('span', { class: 'board-name', text: r.isMe ? `${r.name} (you)` : r.name }),
        h('span', { class: 'board-pts', text: r.pts.toLocaleString('en-US') }),
      ),
    ),
  );
}
