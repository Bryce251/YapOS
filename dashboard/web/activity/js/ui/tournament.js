import { h, avatar, button, plural } from './dom.js';
import { TOUR_GAMES, PLACE_POINTS } from '../engine.js';

export const TOUR_BLURB = `Play ${TOUR_GAMES} games back to back. Each game hands out ${PLACE_POINTS.join('/')} points by place, and the most points wins.`;

function meta(games, id) {
  const g = games.find((x) => x.id === id);
  return g ? { id: g.id, name: g.name, emoji: g.emoji } : { id, name: 'Game', emoji: '🎮' };
}

export function tourSetupModel(snap, games) {
  const t = snap && snap.tour ? snap.tour.setup : null;
  if (!t) return { on: false, picks: [], random: TOUR_GAMES };
  const picks = t.g.map((id) => meta(games, id));
  return { on: true, picks, random: TOUR_GAMES - picks.length };
}

export function tourSetup(m, { isHost, games, onToggle, onPick, onRandom }) {
  const head = h(
    'div',
    { class: 'tour-head' },
    h('span', { class: 'tour-label' }, h('span', { class: 'tour-icon', text: '🏆', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Tournament' })),
    isHost
      ? h(
          'button',
          { class: ['chip', m.on ? 'is-on' : null, 'spot'], type: 'button', dataset: { key: 'tour-toggle' }, attrs: { 'aria-pressed': m.on ? 'true' : 'false' }, on: { click: () => onToggle(!m.on) } },
          m.on ? 'On' : 'Off',
        )
      : h('span', { class: 'code-value', text: m.on ? 'On' : 'Off' }),
  );
  if (!m.on) return h('div', { class: 'tour-setup' }, head, isHost ? h('p', { class: 'tour-blurb muted', text: TOUR_BLURB }) : null);
  const plan = [];
  for (let i = 0; i < TOUR_GAMES; i += 1) {
    const g = m.picks[i];
    plan.push(h('li', { class: ['tour-step', g ? null : 'is-random'] }, h('span', { class: 'tour-step-num', text: String(i + 1) }), h('span', { class: 'tour-step-name', text: g ? `${g.emoji} ${g.name}` : '🎲 Random' })));
  }
  const chooser = isHost
    ? h(
        'div',
        { class: 'tour-choose' },
        h('p', { class: 'tour-blurb muted', text: `Tap up to ${TOUR_GAMES} games in order. Empty spots get a random game.` }),
        h(
          'div',
          { class: 'chips tour-games', attrs: { role: 'group', 'aria-label': 'Tournament games' } },
          games.map((g) => {
            const at = m.picks.findIndex((p) => p.id === g.id);
            return h(
              'button',
              {
                class: ['chip', at >= 0 ? 'is-on' : null, 'spot'],
                type: 'button',
                dataset: { key: `tour-pick-${g.id}` },
                attrs: { 'aria-pressed': at >= 0 ? 'true' : 'false' },
                on: { click: () => onPick(g.id) },
              },
              at >= 0 ? `${at + 1}. ${g.emoji} ${g.name}` : `${g.emoji} ${g.name}`,
            );
          }),
        ),
        button(`Random ${TOUR_GAMES}`, { variant: 'ghost', size: 'sm', key: 'tour-random', on: onRandom }),
      )
    : null;
  return h('div', { class: 'tour-setup is-on' }, head, h('ol', { class: 'tour-plan' }, plan), chooser);
}

export function togglePick(picks, id) {
  const list = (Array.isArray(picks) ? picks : []).map((p) => (typeof p === 'string' ? p : p.id));
  if (list.includes(id)) return list.filter((x) => x !== id);
  return list.length >= TOUR_GAMES ? list : list.concat([id]);
}

export function tourModel(snap, games) {
  const live = snap && snap.tour ? snap.tour.live : null;
  if (!live) return null;
  const bySlot = new Map(snap.players.filter((p) => Number.isInteger(p.slot)).map((p) => [p.slot, p]));
  const rows = Object.entries(live.pts)
    .map(([slot, pts]) => {
      const p = bySlot.get(Number(slot));
      return { slot: Number(slot), pts: Number(pts) || 0, firsts: Number(live.f[slot]) || 0, gain: live.lp ? Number(live.lp[slot]) || 0 : 0, name: p ? p.name : 'Player', initials: p ? p.initials : 'P', hue: p ? p.hue : 20, avatar: p ? p.avatar : null, id: p ? p.id : null, username: p ? p.username : null, isMe: Boolean(p && p.isMe) };
    })
    .sort((a, b) => b.pts - a.pts || b.firsts - a.firsts || a.slot - b.slot);
  let place = 0;
  let prev = null;
  rows.forEach((r, i) => {
    if (r.pts !== prev) {
      place = i + 1;
      prev = r.pts;
    }
    r.place = place;
  });
  const champ = live.champ !== null ? bySlot.get(live.champ) || null : null;
  return {
    i: live.i,
    total: live.g.length,
    done: live.done,
    games: live.g.map((id) => meta(games, id)),
    next: !live.done && live.i + 1 < live.g.length ? meta(games, live.g[live.i + 1]) : null,
    rows,
    champ: champ ? { name: champ.name, isMe: Boolean(champ.isMe), slot: champ.slot } : live.champ !== null ? { name: 'Player', isMe: false, slot: live.champ } : null,
  };
}

export function tourStatus(m) {
  if (!m) return '';
  const total = Number.isInteger(m.total) ? m.total : Array.isArray(m.g) ? m.g.length : 0;
  return `Game ${Math.min(m.i + 1, total)} of ${total}`;
}

export function championTitle(m) {
  if (!m || !m.champ) return 'No champion this time';
  return m.champ.isMe ? "You're the champion!" : `${m.champ.name} is the champion!`;
}

function standings(m) {
  if (!m.rows.length) return h('p', { class: 'board-empty', text: 'No placement points yet.' });
  return h(
    'ol',
    { class: 'tour-table', attrs: { 'aria-label': 'Tournament standings' } },
    m.rows.map((r) =>
      h(
        'li',
        { class: ['tour-row', r.isMe ? 'is-me' : null, r.place === 1 ? 'is-top' : null] },
        h('span', { class: 'tour-place', text: String(r.place) }),
        avatar(r, 'xs'),
        h('span', { class: 'tour-name', text: r.isMe ? `${r.name} (you)` : r.name }),
        r.gain ? h('span', { class: 'tour-gain', text: `+${r.gain}` }) : null,
        h('strong', { class: 'tour-pts', text: plural(r.pts, 'pt', 'pts') }),
      ),
    ),
  );
}

export function tourCard(m) {
  if (!m) return null;
  const steps = h(
    'ol',
    { class: 'tour-plan is-live' },
    m.games.map((g, i) => h('li', { class: ['tour-step', i < m.i || (m.done && i === m.i) ? 'is-done' : null, i === m.i && !m.done ? 'is-now' : null] }, h('span', { class: 'tour-step-num', text: String(i + 1) }), h('span', { class: 'tour-step-name', text: `${g.emoji} ${g.name}` }))),
  );
  if (m.done) {
    return h(
      'div',
      { class: ['card', 'glass', 'tour-card', 'is-champion', m.champ && m.champ.isMe ? 'is-me' : null] },
      h('span', { class: 'tour-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'eyebrow', text: 'Tournament over' }),
      h('h2', { class: 'winner-title tour-champ', text: championTitle(m) }),
      steps,
      standings(m),
    );
  }
  return h(
    'div',
    { class: 'card glass tour-card' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: '🏆 Tournament' }), h('span', { class: 'count-pill', text: tourStatus(m) })),
    steps,
    standings(m),
    m.next ? h('p', { class: 'tour-next' }, h('span', { class: 'muted', text: 'Up next: ' }), h('strong', { text: `${m.next.emoji} ${m.next.name}` })) : null,
  );
}
