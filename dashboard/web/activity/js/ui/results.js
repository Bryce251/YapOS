import { h, memo, button } from './dom.js';
import { board, standings } from './board.js';

export const FRESH_MS = 8000;

export function resultsModel(snap, games) {
  const last = snap.room.last || null;
  const game = games.find((g) => last && g.id === last.game) || null;
  const winners = last ? snap.players.filter((p) => last.winners.includes(p.slot)) : [];
  const keep = (p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar, pts: p.pts, place: p.place, isMe: p.isMe, present: p.present, slot: p.slot });
  return {
    at: last ? last.at : 0,
    game: game ? { id: game.id, name: game.name, emoji: game.emoji } : null,
    winners: winners.map((p) => p.name),
    iWon: winners.some((p) => p.isMe),
    isHost: snap.isHost,
    hostName: snap.hostName,
    round: standings(snap.players, 'game').map(keep),
    totals: standings(snap.players, 'total').map(keep),
  };
}

export function headline(m) {
  if (!m.winners.length) return 'No winner this time';
  if (m.iWon && m.winners.length === 1) return 'You win!';
  if (m.winners.length === 1) return `${m.winners[0]} wins!`;
  if (m.winners.length === 2) return `${m.winners[0]} and ${m.winners[1]} tie!`;
  return `${m.winners.length}-way tie!`;
}

export function createResults({ engine, fx }) {
  const el = h('section', { class: 'screen results', attrs: { 'aria-label': 'Results' } });
  const paint = memo(render);
  let celebrated = 0;

  function render(m) {
    const actions = m.isHost
      ? h(
          'div',
          { class: 'start-row' },
          button('Play again', { variant: 'primary', size: 'xl', key: 'again', on: () => engine.lobby.start() }),
          button('Back to lobby', { variant: 'secondary', size: 'lg', key: 'lobby', on: () => engine.lobby.toLobby() }),
        )
      : h('p', { class: 'waiting', attrs: { role: 'status' } }, h('span', { class: 'pulse-dot', attrs: { 'aria-hidden': 'true' } }), `Waiting for ${m.hostName} to pick what's next`);
    return h(
      'div',
      { class: 'results-wrap' },
      h(
        'div',
        { class: ['card', 'glass', 'winner-card', m.iWon ? 'is-me' : null] },
        h('span', { class: 'trophy', text: m.winners.length ? '🏆' : '🤝', attrs: { 'aria-hidden': 'true' } }),
        m.game ? h('span', { class: 'eyebrow', text: `${m.game.emoji} ${m.game.name}` }) : null,
        h('h2', { class: 'winner-title', text: headline(m) }),
        actions,
      ),
      h('div', { class: 'card glass' }, h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'This game' })), board(m.round, { empty: 'Nobody scored this time.', label: 'This game' })),
      h('div', { class: 'card glass' }, h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'All games' })), board(m.totals, { empty: 'No points yet.', label: 'All games' })),
    );
  }

  return {
    el,
    update(snap) {
      const m = resultsModel(snap, engine.games);
      paint(el, m);
      if (m.at && m.at !== celebrated) {
        celebrated = m.at;
        if (m.winners.length && Math.abs(snap.now - m.at) < FRESH_MS) fx.confetti(m.iWon ? 220 : 90);
      }
    },
    destroy() {},
  };
}
