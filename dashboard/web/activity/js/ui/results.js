import { h, memo, button } from './dom.js';
import { joinButton } from './lobby.js';
import { board, standings } from './board.js';
import { burstFrom } from './juice.js';
import { createDailyBox, finishDaily } from './daily.js';
import { partyXp, PARTY_XP_DAY } from '../admin.js';

export const WIN_EMOJI = ['🏆', '⭐', '✨', '🎉', '👑'];
export const BURST_DELAY_MS = 640;

export const FRESH_MS = 8000;
export const XP_TITLE = `Party XP goes toward your YapOS level, up to ${PARTY_XP_DAY} a day.`;

export function xpEarned(last, players) {
  if (!last || !Array.isArray(last.ps) || last.ps.length < 2) return 0;
  const me = (players || []).find((p) => p.isMe);
  if (!me || !Number.isInteger(me.slot) || !last.ps.includes(me.slot)) return 0;
  return partyXp(Array.isArray(last.winners) && last.winners.includes(me.slot));
}

export function xpText(n) {
  return n > 0 ? `+${n} Party XP` : '';
}

export function resultsModel(snap, games) {
  const last = snap.room.last || null;
  const game = games.find((g) => last && g.id === last.game) || null;
  const winners = last ? snap.players.filter((p) => last.winners.includes(p.slot)) : [];
  const keep = (p) => ({ id: p.id, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar, pts: p.pts, place: p.place, isMe: p.isMe, present: p.present, slot: p.slot });
  return {
    at: last ? last.at : 0,
    game: game ? { id: game.id, name: game.name, emoji: game.emoji } : null,
    winners: winners.map((p) => p.name),
    iWon: winners.some((p) => p.isMe),
    isHost: snap.isHost,
    hostName: snap.hostName,
    meJoined: Boolean(snap.meJoined),
    joining: snap.joining || null,
    playing: snap.players.filter((p) => p.joined).length,
    round: standings(snap.players, 'game').map(keep),
    totals: standings(snap.players, 'total').map(keep),
    xp: xpEarned(last, snap.players),
    daily: last && typeof last.daily === 'string' && (last.game === 'hive' || last.game === 'scramble') ? { kind: last.game, date: last.daily } : null,
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
  let podium = 0;
  let pending = 0;
  const daily = createDailyBox();

  function cheerWinner(iWon) {
    const spot = el.querySelector('.board-top .place-1') || el.querySelector('.trophy');
    if (!spot || !spot.isConnected) return;
    burstFrom(spot, { count: iWon ? 34 : 22, spread: iWon ? 180 : 130, size: 9, emoji: WIN_EMOJI });
    const trophy = el.querySelector('.trophy');
    if (trophy && trophy !== spot) burstFrom(trophy, { count: 12, spread: 90, size: 7, colors: ['var(--amber)', '#ffd76a', 'var(--accent-text)'] });
  }

  function onJoinTap(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : '';
    if (key === 'leave-game') engine.leave();
    else engine.join();
  }

  function render(m) {
    const fresh = Boolean(m.at) && m.at !== podium;
    podium = m.at;
    const join = m.meJoined ? null : joinButton(m, { size: 'lg', key: 'join' });
    if (join) join.addEventListener('click', onJoinTap);
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
      { class: ['results-wrap', fresh ? 'juice-podium' : null] },
      h(
        'div',
        { class: ['card', 'glass', 'winner-card', m.iWon ? 'is-me' : null] },
        h('span', { class: 'trophy', text: m.winners.length ? '🏆' : '🤝', attrs: { 'aria-hidden': 'true' } }),
        m.game ? h('span', { class: 'eyebrow', text: `${m.game.emoji} ${m.game.name}` }) : null,
        h('h2', { class: 'winner-title', text: headline(m) }),
        m.xp ? h('span', { class: 'xp-chip', text: xpText(m.xp), attrs: { title: XP_TITLE } }) : null,
        actions,
        join ? h('div', { class: 'join-row is-results' }, join, h('p', { class: 'join-hint', text: 'Join to play in the next game.' })) : null,
      ),
      m.daily ? h('div', { class: 'card glass daily-card' }, daily.el) : null,
      h('div', { class: 'card glass' }, h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'This game' })), board(m.round, { empty: 'Nobody scored this time.', label: 'This game' })),
      h('div', { class: 'card glass' }, h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'All games' })), board(m.totals, { empty: 'No points yet.', label: 'All games' })),
    );
  }

  return {
    el,
    update(snap) {
      const m = resultsModel(snap, engine.games);
      if (m.daily) finishDaily(m.daily.kind, m.daily.date);
      daily.show(m.daily ? m.daily.kind : null, { date: m.daily ? m.daily.date : null });
      paint(el, m);
      if (m.at && m.at !== celebrated) {
        celebrated = m.at;
        if (m.winners.length && Math.abs(snap.now - m.at) < FRESH_MS) {
          fx.confetti(m.iWon ? 220 : 90);
          if (pending) globalThis.clearTimeout(pending);
          pending = globalThis.setTimeout(() => {
            pending = 0;
            cheerWinner(m.iWon);
          }, BURST_DELAY_MS);
        }
      }
    },
    destroy() {
      if (pending) globalThis.clearTimeout(pending);
      pending = 0;
      daily.destroy();
    },
  };
}
