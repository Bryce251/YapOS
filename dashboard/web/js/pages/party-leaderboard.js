import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { avatar, button, emptyState, errorState, linkButton, loadingRegion, skeleton } from '../ui.js';
import { formatNumber } from '../format.js';
import { isAbort } from '../api.js';
import { profilePath } from '../router.js';
import { publicFrame } from '../public-frame.js';
import { PARTY_GAMES, gameInfo } from '../community-data.js';
import { medalFor } from '../public-data.js';

export const LEADERBOARD_API = '/api/activity/leaderboard';
export const LEADERBOARD_PATH = '/party/leaderboard';

export const BOARDS = Object.freeze([
  { id: 'points', label: 'Points', unit: ['point', 'points'], blurb: 'Every point scored in YapOS Party games, all time.' },
  { id: 'wins', label: 'Wins', unit: ['win', 'wins'], blurb: 'Games won, all time.' },
  { id: 'games', label: 'Games', unit: ['game', 'games'], blurb: 'Games played to the end, all time.' },
  { id: 'best', label: 'Best game', unit: ['point', 'points'], blurb: 'The highest score anyone got in a single game.' },
]);

const BOARD_IDS = BOARDS.map((b) => b.id);
const GAME_IDS = Object.keys(PARTY_GAMES);

export function boardInfo(id) {
  return BOARDS.find((b) => b.id === id) || BOARDS[0];
}

export function readQuery(search) {
  const q = new URLSearchParams(search || '');
  const board = BOARD_IDS.includes(q.get('board')) ? q.get('board') : 'points';
  const game = GAME_IDS.includes(q.get('game')) ? q.get('game') : 'all';
  return { board, game };
}

export function leaderboardUrl({ board, game, me = null }) {
  const q = new URLSearchParams({ board, game, limit: '20' });
  if (me) q.set('me', me);
  return `${LEADERBOARD_API}?${q}`;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function normalizeLeaderboard(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).filter((r) => r && typeof r === 'object').map((r, i) => {
    const username = str(r.username).replace(/^@+/, '') || null;
    return {
      rank: num(r.rank) || i + 1,
      id: str(r.id),
      name: str(r.name) || username || 'Player',
      username,
      avatar: str(r.avatar) || null,
      value: num(r.value),
      games: num(r.games),
      wins: num(r.wins),
      best: num(r.best),
      bestGame: GAME_IDS.includes(r.bestGame) ? r.bestGame : null,
      link: r.link === true && Boolean(username),
    };
  });
  const me = raw.me && typeof raw.me === 'object' && num(raw.me.rank) > 0 ? { rank: num(raw.me.rank), value: num(raw.me.value) } : null;
  return { rows, me, total: num(raw.total) };
}

export function valueText(board, value) {
  const unit = boardInfo(board).unit;
  return `${formatNumber(value)} ${value === 1 ? unit[0] : unit[1]}`;
}

export function meText(board, me) {
  if (!me) return '';
  return `You're #${formatNumber(me.rank)} with ${valueText(board, me.value)}`;
}

function rankMark(rank) {
  const medal = medalFor(rank);
  if (medal) return h('span', { class: ['medal', `medal-${medal}`], attrs: { role: 'img', 'aria-label': `Rank ${rank}` } }, h('span', { text: String(rank) }));
  return h('span', { class: 'rank-num', attrs: { 'aria-label': `Rank ${rank}` }, text: String(rank) });
}

function detail(board, r) {
  const bits = [];
  if (board !== 'games') bits.push(`${formatNumber(r.games)} ${r.games === 1 ? 'game' : 'games'}`);
  if (board !== 'wins') bits.push(`${formatNumber(r.wins)} ${r.wins === 1 ? 'win' : 'wins'}`);
  if (r.bestGame) {
    const g = gameInfo(r.bestGame);
    bits.push(board === 'best' ? `in ${g.emoji} ${g.name}` : `best ${formatNumber(r.best)} in ${g.emoji} ${g.name}`);
  }
  return bits.join(' · ');
}

export function boardRows(board, rows, meId = null) {
  return h('ol', { class: 'plb-list', attrs: { 'aria-label': `${boardInfo(board).label} leaderboard` } },
    ...rows.map((r) => h('li', { class: ['plb-row', r.rank <= 3 ? `is-top-${r.rank}` : '', meId && r.id === meId ? 'is-me' : ''] },
      rankMark(r.rank),
      avatar({ name: r.name, url: r.avatar || '', id: r.id, size: 'sm' }),
      h('span', { class: 'plb-who' },
        r.link
          ? h('a', { href: profilePath(r.username), class: 'plb-name', dataset: { link: '' }, text: r.name })
          : h('span', { class: 'plb-name', text: r.name }),
        h('span', { class: 'plb-meta', text: detail(board, r) })),
      h('span', { class: 'plb-value', text: valueText(board, r.value) }))));
}

function boardSkeleton() {
  return loadingRegion('Loading the leaderboard', h('div', { class: 'plb-list' }, ...Array.from({ length: 8 }, () => skeleton('skeleton-text skeleton-w-80'))));
}

export function renderPartyLeaderboard(root, ctx) {
  const { api, signal } = ctx;
  const frame = publicFrame(root, { current: LEADERBOARD_PATH });
  frame.setUser(null);
  ctx.setTitle('Party leaderboard');
  let user = null;
  let { board, game } = readQuery(window.location.search);
  let token = 0;

  const boardBar = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Leaderboard' } });
  const gamePick = h('select', { class: 'input select plb-game', attrs: { 'aria-label': 'Game' } },
    h('option', { value: 'all', text: '🎮 All games' }),
    ...GAME_IDS.map((id) => h('option', { value: id, text: `${PARTY_GAMES[id].emoji} ${PARTY_GAMES[id].name}` })));
  gamePick.value = game;
  const lead = h('p', { class: 'plb-blurb muted' });
  const list = h('div', { class: 'plb-wrap' });
  const mine = h('div', { class: 'plb-me', attrs: { 'aria-live': 'polite' } });

  replace(frame.content,
    h('div', { class: 'public-hero' },
      h('span', { class: 'public-crest', attrs: { 'aria-hidden': 'true' } }, icon('trophy', { size: 30 })),
      h('div', { class: 'public-hero-text' },
        h('p', { class: 'public-eyebrow', text: 'YapOS Party' }),
        h('h1', { class: 'public-title', text: 'Party leaderboard' }),
        h('p', { class: 'public-lead', text: 'The top players of all time across every YapOS Party game. Play a game with friends in a call to get on the board.' })),
      h('div', { class: 'public-hero-actions' }, linkButton({ label: 'Past seasons', href: '/seasons', size: 'sm', icon: 'trophy' }))),
    h('div', { class: 'public-card plb-card' },
      h('div', { class: 'plb-tools' }, boardBar, gamePick),
      lead,
      list,
      mine));

  function syncUrl() {
    const url = new URL(window.location.href);
    if (board === 'points') url.searchParams.delete('board');
    else url.searchParams.set('board', board);
    if (game === 'all') url.searchParams.delete('game');
    else url.searchParams.set('game', game);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }

  function drawBoards() {
    replace(boardBar, ...BOARDS.map((b) => {
      const btn = button({ label: b.label, size: 'sm', variant: board === b.id ? 'segment-active' : 'segment', onClick: () => {
        if (board === b.id) return;
        board = b.id;
        syncUrl();
        drawBoards();
        load();
      } });
      btn.setAttribute('aria-pressed', board === b.id ? 'true' : 'false');
      return btn;
    }));
  }

  gamePick.addEventListener('change', () => {
    game = GAME_IDS.includes(gamePick.value) ? gamePick.value : 'all';
    syncUrl();
    load();
  });

  async function load() {
    const mineToken = ++token;
    const info = boardInfo(board);
    lead.textContent = game === 'all' ? info.blurb : `${info.blurb.replace(/\.$/, '')} in ${gameInfo(game).emoji} ${gameInfo(game).name}.`;
    replace(list, boardSkeleton());
    replace(mine);
    try {
      const data = await api.get(leaderboardUrl({ board, game, me: user?.id || null }), { signal, allow401: true });
      if (signal.aborted || mineToken !== token) return;
      const view = normalizeLeaderboard(data);
      if (!view.rows.length) {
        replace(list, emptyState({ icon: 'trophy', title: 'Nobody here yet', body: game === 'all' ? 'Finish a YapOS Party game with at least one friend to be the first on the board.' : `Nobody has scored in ${gameInfo(game).name} yet. Be the first!` }));
        return;
      }
      replace(list, boardRows(board, view.rows, user?.id ? String(user.id).toLowerCase() : null), h('p', { class: 'plb-total muted', text: `${formatNumber(view.total)} ${view.total === 1 ? 'player' : 'players'} on this board` }));
      if (view.me) replace(mine, h('span', { class: 'plb-me-rank', text: `#${formatNumber(view.me.rank)}` }), h('span', { text: meText(board, view.me) }));
      else if (user) replace(mine, h('span', { class: 'muted', text: "You're not on this board yet. Play a game to get on it!" }));
    } catch (err) {
      if (isAbort(err) || signal.aborted || mineToken !== token) return;
      replace(list, errorState({ title: "Couldn't load the leaderboard", body: err.message, onRetry: load }));
    }
  }

  drawBoards();
  load();
  ctx.getUser?.().then((u) => {
    if (signal.aborted) return;
    frame.setUser(u || null);
    if (u && u.id && (!user || user.id !== u.id)) {
      user = u;
      load();
    }
  }).catch(() => {});
}
