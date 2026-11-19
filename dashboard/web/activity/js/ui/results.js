import { h, memo, button, avatar } from './dom.js';
import { joinButton } from './lobby.js';
import { board, standings, fmt } from './board.js';
import { burstFrom } from './juice.js';
import { createDailyBox, finishDaily } from './daily.js';
import { partyXp, PARTY_XP_DAY, partyShards, PARTY_SHARDS_PREDICTION } from '../admin.js';
import { tourModel, tourCard } from './tournament.js';
import { predictResultsModel, predictResults } from './predict.js';
import { createReplayStrip, REPLAY_GAMES } from './replay.js';
import { awardsModel, awardsCard, reelCard, upsetLine } from './awards.js';
import { boardButton } from './party.js';
import { pfp } from './pfp.js';
import { fxLevel } from './fxmode.js';

export const SAME_TEAMS_LABEL = 'Same teams again';
export const SAME_TEAMS_TITLE = 'Play again with the same teams';

export const WIN_EMOJI = ['🏆', '⭐', '✨', '🎉', '👑'];
export const BURST_DELAY_MS = 900;
export const REVEAL_MS = 2400;
export const PODIUM_MIN = 2;
export const PODIUM_ORDER = [2, 1, 3];

export const FRESH_MS = 8000;
export const CHAMP_FACES = 5;
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

export const SHARDS_TITLE = 'Shards go to your YapOS wallet. There is no daily limit, so every game with 2 or more players pays.';

export function shardsEarned(last, players, predict = null) {
  if (!last || !Array.isArray(last.ps) || last.ps.length < 2) return 0;
  const me = (players || []).find((p) => p.isMe);
  if (!me) return 0;
  if (Number.isInteger(me.slot) && last.ps.includes(me.slot)) {
    return partyShards(Array.isArray(last.winners) && last.winners.includes(me.slot), Number.isInteger(last.champ) && last.champ === me.slot);
  }
  if (!predict || !Array.isArray(predict.picks)) return 0;
  const mine = predict.picks.find((x) => x.id === me.id);
  const wins = Array.isArray(predict.winners) ? predict.winners : Array.isArray(last.winners) ? last.winners : [];
  return mine && wins.includes(mine.slot) && last.ps.includes(mine.slot) ? PARTY_SHARDS_PREDICTION : 0;
}

export function shardsText(n) {
  return n > 0 ? `+${n} 💎` : '';
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
    champs: winners.slice(0, CHAMP_FACES).map(keep),
    iWon: winners.some((p) => p.isMe),
    isHost: snap.isHost,
    hostName: snap.hostName,
    meJoined: Boolean(snap.meJoined),
    joining: snap.joining || null,
    playing: snap.players.filter((p) => p.joined).length,
    round: standings(snap.players, 'game').map(keep),
    totals: standings(snap.players, 'total').map(keep),
    xp: xpEarned(last, snap.players),
    shards: shardsEarned(last, snap.players, snap.predict),
    tour: tourModel(snap, games),
    picks: predictResultsModel(snap),
    note: last && typeof last.note === 'string' && last.note ? last.note : null,
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

export function podiumRows(rows) {
  const top = (Array.isArray(rows) ? rows : []).filter((r) => r && r.pts > 0).slice(0, 3);
  if (top.length < PODIUM_MIN) return [];
  return PODIUM_ORDER.map((n) => (top[n - 1] ? { ...top[n - 1], step: n } : null)).filter(Boolean);
}

export function podiumCard(rows) {
  const list = podiumRows(rows);
  if (!list.length) return null;
  return h(
    'div',
    { class: ['podium', `has-${list.length}`], attrs: { 'aria-hidden': 'true' } },
    list.map((r) =>
      h(
        'div',
        { class: ['podium-step', `step-${r.step}`, `place-${r.place}`, r.isMe ? 'is-me' : null], vars: { '--i': String(3 - r.step) } },
        h('span', { class: 'podium-who' }, avatar(r, r.step === 1 ? 'md' : 'sm'), h('span', { class: 'podium-name', text: r.name })),
        h('span', { class: 'podium-block' }, h('span', { class: 'podium-rank', text: String(r.place) }), h('span', { class: 'podium-pts fx-num', text: fmt(r.pts) })),
      ),
    ),
  );
}

export function announce(m) {
  const top = m.round && m.round[0];
  if (!m.winners.length) return 'No winner this time.';
  if (m.winners.length > 1) return `${headline(m)} ${m.winners.join(', ')}.`;
  const who = m.iWon ? 'You win' : `${m.winners[0]} wins`;
  return top && top.pts > 0 ? `${who} with ${fmt(top.pts)} points.` : `${who}.`;
}

export function createResults({ engine, fx, replays = null, win = globalThis, toast = null, boardLink = null }) {
  const el = h('section', { class: 'screen results', attrs: { 'aria-label': 'Results' } });
  const paint = memo(render);
  let celebrated = 0;
  let podium = 0;
  let pending = 0;
  const daily = createDailyBox();
  const strip = createReplayStrip({ win });
  const live = h('p', { class: 'results-sr', attrs: { 'aria-live': 'polite', role: 'status' } });
  let revealTimer = 0;

  function revealed() {
    if (revealTimer) globalThis.clearTimeout(revealTimer);
    revealTimer = 0;
    const wrap = el.querySelector('.results-wrap');
    if (wrap && wrap.classList.contains('is-cinema')) wrap.classList.add('is-revealed');
  }

  el.addEventListener('pointerdown', revealed);
  el.addEventListener('keydown', revealed);

  function cheerWinner(iWon) {
    const spot = el.querySelector('.winner-face') || el.querySelector('.board-top .place-1') || el.querySelector('.trophy');
    if (!spot || !spot.isConnected) return;
    burstFrom(spot, { count: iWon ? 18 : 12, spread: iWon ? 180 : 130, size: 9, emoji: WIN_EMOJI });
    const trophy = el.querySelector('.trophy');
    if (trophy && trophy !== spot && fxLevel() === 'full') burstFrom(trophy, { count: 8, spread: 90, size: 7, colors: ['var(--amber)', '#ffd76a', 'var(--accent-text)'] });
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
    const midTour = m.tour && !m.tour.done && m.tour.next;
    const cta = (b) => {
      b.classList.add('btn-cta');
      return b;
    };
    let hostButtons = null;
    if (m.isHost && midTour) {
      hostButtons = [
        cta(button(`Next: ${m.tour.next.emoji} ${m.tour.next.name}`, { variant: 'primary', size: 'xl', key: 'next', on: () => engine.lobby.next() })),
        button('End tournament', { variant: 'secondary', size: 'lg', key: 'lobby', on: () => engine.lobby.toLobby() }),
      ];
    } else if (m.isHost) {
      hostButtons = [
        cta(button(m.tour ? 'New tournament' : 'Play again', { variant: 'primary', size: 'xl', key: 'again', on: () => engine.lobby.start() })),
        m.sameTeams && !m.tour ? button(SAME_TEAMS_LABEL, { variant: 'secondary', size: 'lg', key: 'again-teams', attrs: { title: SAME_TEAMS_TITLE }, on: () => engine.lobby.start({ sameTeams: true }) }) : null,
        button('Back to lobby', { variant: 'secondary', size: 'lg', key: 'lobby', on: () => engine.lobby.toLobby() }),
      ];
    }
    const actions = hostButtons
      ? h('div', { class: 'start-row' }, hostButtons)
      : h('p', { class: 'waiting results-waiting', attrs: { role: 'status' } }, h('span', { class: 'pulse-dot', attrs: { 'aria-hidden': 'true' } }), midTour ? `Waiting for ${m.hostName} to start the next game` : `Waiting for ${m.hostName} to pick what's next`);
    return h(
      'div',
      { class: ['results-wrap', fresh ? 'juice-podium' : null, fresh ? 'is-cinema' : null] },
      h(
        'div',
        { class: ['card', 'glass', 'winner-card', m.iWon ? 'is-me' : null, m.winners.length ? 'has-winner' : 'is-draw', m.champs.length > 1 ? 'is-tie' : null] },
        h('span', { class: 'winner-glow', attrs: { 'aria-hidden': 'true' } }),
        h(
          'div',
          { class: 'winner-top' },
          h('span', { class: 'trophy', text: m.winners.length ? '🏆' : '🤝', attrs: { 'aria-hidden': 'true' } }),
          m.game ? h('span', { class: 'eyebrow', text: `${m.game.emoji} ${m.game.name}` }) : h('span', { class: 'eyebrow', text: 'Game over' }),
        ),
        podiumCard(m.round),
        m.champs.length
          ? h(
              'div',
              { class: ['winner-faces', `has-${Math.min(m.champs.length, CHAMP_FACES)}`] },
              m.champs.map((p, i) => h('span', { class: ['winner-face', i === 0 && m.champs.length === 1 ? 'fx-spotlight' : null], vars: { '--i': String(i) } }, pfp(p, m.champs.length > 2 ? 'lg' : 'xl', { crown: true, ring: 'glow' }))),
            )
          : null,
        h('h2', { class: ['winner-title', 'fx-display', m.winners.length ? 'is-lit' : null], text: headline(m) }),
        m.note ? h('p', { class: 'results-note', text: m.note }) : null,
        upsetLine(m.upset),
        m.xp || m.shards
          ? h(
              'div',
              { class: 'earn-row', attrs: { role: 'group', 'aria-label': 'What you earned' } },
              m.xp ? h('span', { class: 'xp-chip', text: xpText(m.xp), attrs: { title: XP_TITLE } }) : null,
              m.shards ? h('span', { class: 'shard-chip', text: shardsText(m.shards), attrs: { title: SHARDS_TITLE } }) : null,
            )
          : null,
        actions,
        join ? h('div', { class: 'join-row is-results' }, join, h('p', { class: 'join-hint', text: 'Join to play in the next game.' })) : null,
        m.lb ? h('div', { class: 'board-link-row' }, boardButton(boardLink, 'leaderboard-results')) : null,
      ),
      awardsCard(m.awards),
      reelCard(m.reel, { engine, toast }),
      m.tour && m.tour.done ? tourCard(m.tour) : null,
      m.daily ? h('div', { class: 'card glass daily-card results-card' }, daily.el) : null,
      m.tour && !m.tour.done ? tourCard(m.tour) : null,
      predictResults(m.picks),
      m.replays ? h('div', { class: 'card glass replay-card results-card' }, strip.el) : null,
      h('div', { class: 'card glass results-card results-board is-round' }, h('div', { class: 'card-head' }, h('span', { class: 'card-icon', text: m.game ? m.game.emoji : '🎮', attrs: { 'aria-hidden': 'true' } }), h('h3', { class: 'card-title', text: 'This game' })), board(m.round, { empty: 'Nobody scored this time.', label: 'This game' })),
      h('div', { class: 'card glass results-card results-board is-total' }, h('div', { class: 'card-head' }, h('span', { class: 'card-icon', text: '📊', attrs: { 'aria-hidden': 'true' } }), h('h3', { class: 'card-title', text: 'All games' })), board(m.totals, { empty: 'No points yet.', label: 'All games' })),
    );
  }

  return {
    el,
    update(snap) {
      const m = resultsModel(snap, engine.games);
      const fun = awardsModel(snap);
      m.awards = fun.awards;
      m.reel = fun.highlights;
      m.upset = fun.upset;
      m.sameTeams = fun.sameTeams;
      m.lb = Boolean(boardLink && typeof boardLink.ready === 'function' && boardLink.ready());
      const last = snap.room.last;
      const list = replays && last && REPLAY_GAMES.includes(last.game) ? replays.list(snap.room.round, last.game) : [];
      strip.show(list);
      m.replays = list.length;
      if (m.daily) finishDaily(m.daily.kind, m.daily.date);
      daily.show(m.daily ? m.daily.kind : null, { date: m.daily ? m.daily.date : null });
      const painted = paint(el, m);
      if (live.parentNode !== el) el.append(live);
      if (m.at && m.at !== celebrated) {
        celebrated = m.at;
        live.textContent = announce(m);
        if (painted && fxLevel() !== 'static') {
          if (revealTimer) globalThis.clearTimeout(revealTimer);
          revealTimer = globalThis.setTimeout(revealed, REVEAL_MS);
        }
        if (m.winners.length && Math.abs(snap.now - m.at) < FRESH_MS) {
          if (pending) globalThis.clearTimeout(pending);
          pending = globalThis.setTimeout(() => {
            pending = 0;
            fx.confetti(m.iWon ? 60 : 30);
            cheerWinner(m.iWon);
          }, BURST_DELAY_MS);
        }
      }
    },
    destroy() {
      if (pending) globalThis.clearTimeout(pending);
      pending = 0;
      if (revealTimer) globalThis.clearTimeout(revealTimer);
      revealTimer = 0;
      el.removeEventListener('pointerdown', revealed);
      el.removeEventListener('keydown', revealed);
      strip.destroy();
      daily.destroy();
    },
  };
}
