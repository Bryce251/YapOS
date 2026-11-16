import { h, avatar, swap } from './dom.js';
import { GAMES } from '../games/index.js';
import { initials, hueOf } from '../players.js';

export const LEADERBOARD_ENDPOINT = '/api/activity/leaderboard';
export const LEADERBOARD_SHOW = 20;
export const LEADERBOARD_CACHE_MS = 30000;
export const LEADERBOARD_TABS = Object.freeze([
  Object.freeze({ id: 'points', label: 'Points', unit: ['point', 'points'] }),
  Object.freeze({ id: 'wins', label: 'Wins', unit: ['win', 'wins'] }),
  Object.freeze({ id: 'games', label: 'Games', unit: ['game', 'games'] }),
  Object.freeze({ id: 'best', label: 'Best game', unit: ['point', 'points'] }),
]);

const TAB_IDS = LEADERBOARD_TABS.map((t) => t.id);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEDALS = ['🥇', '🥈', '🥉'];
const AVATAR_HOSTS = new Set(['files.yapper.website', 'www.yapin.gg']);

let env = defaults();
let cache = new Map();

function defaults() {
  return {
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    now: () => Date.now(),
  };
}

export function configureLeaderboard(opts = {}) {
  const next = { ...env };
  for (const k of Object.keys(opts)) if (opts[k] !== undefined) next[k] = opts[k];
  env = next;
}

export function resetLeaderboard() {
  env = defaults();
  cache = new Map();
}

export function leaderboardGames() {
  return GAMES.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji || '🎮' }));
}

function gameMeta(id) {
  return leaderboardGames().find((g) => g.id === id) || null;
}

function tabMeta(id) {
  return LEADERBOARD_TABS.find((t) => t.id === id) || LEADERBOARD_TABS[0];
}

export function fmt(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function valueText(board, value) {
  const unit = tabMeta(board).unit;
  return `${fmt(value)} ${Number(value) === 1 ? unit[0] : unit[1]}`;
}

export function meLine(board, me) {
  if (!me) return "You're not on this board yet. Finish a game with friends to get on it!";
  return `You're #${fmt(me.rank)} with ${valueText(board, me.value)}`;
}

function safeAvatar(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !AVATAR_HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
    return u.href;
  } catch {
    return null;
  }
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function text(v, max = 64) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, max).join('');
}

export function readBoard(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const ids = new Set(leaderboardGames().map((g) => g.id));
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, 50).filter((r) => r && typeof r === 'object').map((r, i) => {
    const id = typeof r.id === 'string' ? r.id : '';
    const username = text(r.username).replace(/^@+/, '').replace(/\s+/g, '') || null;
    const name = text(r.name) || username || 'Player';
    return {
      rank: count(r.rank) || i + 1,
      id,
      name,
      username,
      avatar: safeAvatar(r.avatar),
      initials: initials(name),
      hue: hueOf(id || name),
      value: count(r.value),
      games: count(r.games),
      wins: count(r.wins),
      best: count(r.best),
      bestGame: ids.has(r.bestGame) ? r.bestGame : null,
    };
  });
  const me = raw.me && typeof raw.me === 'object' && count(raw.me.rank) > 0 ? { rank: count(raw.me.rank), value: count(raw.me.value) } : null;
  return { rows, me, total: count(raw.total) };
}

export function boardUrl(board, game, me) {
  const q = new URLSearchParams({ board, game, limit: String(LEADERBOARD_SHOW) });
  if (me && ID_RE.test(me)) q.set('me', me);
  return `${LEADERBOARD_ENDPOINT}?${q}`;
}

export async function fetchBoard(board, game, me) {
  const url = boardUrl(board, game, me);
  const hitCache = cache.get(url);
  const now = env.now();
  if (hitCache && hitCache.at + LEADERBOARD_CACHE_MS > now) return hitCache.data;
  if (typeof env.fetch !== 'function') throw new Error('offline');
  const res = await env.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!res || !res.ok) throw new Error(res && res.status === 429 ? 'busy' : 'failed');
  const data = readBoard(await res.json());
  cache.set(url, { at: now, data });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return data;
}

function resolveMe(engine, me) {
  const pick = (v) => {
    if (typeof v === 'string' && ID_RE.test(v)) return v.toLowerCase();
    if (v && typeof v === 'object' && typeof v.id === 'string' && ID_RE.test(v.id)) return v.id.toLowerCase();
    return null;
  };
  const direct = pick(me);
  if (direct) return direct;
  try {
    const snap = engine && typeof engine.snapshot === 'function' ? engine.snapshot() : null;
    return snap ? pick(snap.me) : null;
  } catch {
    return null;
  }
}

function detail(board, r) {
  const bits = [];
  if (board !== 'games') bits.push(`${fmt(r.games)} ${r.games === 1 ? 'game' : 'games'}`);
  if (board !== 'wins') bits.push(`${fmt(r.wins)} ${r.wins === 1 ? 'win' : 'wins'}`);
  const g = r.bestGame ? gameMeta(r.bestGame) : null;
  if (g) bits.push(board === 'best' ? `in ${g.emoji} ${g.name}` : `best ${fmt(r.best)} ${g.emoji}`);
  return bits.join(' · ');
}

function rowEl(board, r, meId) {
  const top = r.rank <= 3;
  return h('li', { class: ['lb-row', top ? `is-top-${r.rank}` : null, meId && r.id.toLowerCase() === meId ? 'is-me' : null] },
    h('span', { class: 'lb-rank', attrs: { 'aria-label': `Rank ${r.rank}` }, text: top ? MEDALS[r.rank - 1] : `#${r.rank}` }),
    avatar(r, 'sm'),
    h('span', { class: 'lb-who' },
      h('strong', { class: 'lb-name', text: r.name }),
      h('span', { class: 'lb-meta', text: detail(board, r) })),
    h('span', { class: 'lb-value', text: valueText(board, r.value) }));
}

export function openLeaderboard(container, { engine = null, me = null } = {}) {
  const host = container || (typeof document !== 'undefined' ? document.body : null);
  if (!host) return null;
  const meId = resolveMe(engine, me);
  const before = typeof document !== 'undefined' ? document.activeElement : null;
  let board = 'points';
  let game = 'all';
  let token = 0;
  let closed = false;

  const titleId = `lb-title-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { class: ['btn', 'btn-ghost', 'btn-sm', 'lb-close', 'spot'], type: 'button', attrs: { 'aria-label': 'Close leaderboard' }, on: { click: () => close() } }, h('span', { class: 'btn-label', text: '✕' }));
  const tabs = h('div', { class: 'lb-tabs', attrs: { role: 'tablist', 'aria-label': 'Leaderboard' } });
  const select = h('select', { class: 'lb-game', attrs: { 'aria-label': 'Game' } },
    h('option', { attrs: { value: 'all' }, text: '🎮 All games' }),
    leaderboardGames().map((g) => h('option', { attrs: { value: g.id }, text: `${g.emoji} ${g.name}` })));
  const body = h('div', { class: 'lb-body', attrs: { role: 'tabpanel', 'aria-live': 'polite' } });
  const mine = h('div', { class: 'lb-me' });
  const card = h('div', { class: 'lb-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
    h('div', { class: 'lb-head' },
      h('span', { class: 'lb-crest', attrs: { 'aria-hidden': 'true' }, text: '🏆' }),
      h('h2', { class: 'lb-title', attrs: { id: titleId }, text: 'Party leaderboard' }),
      closeBtn),
    h('div', { class: 'lb-tools' }, tabs, select),
    body,
    mine);
  const backdrop = h('div', { class: 'lb-backdrop', attrs: { 'aria-hidden': 'true' }, on: { click: () => close() } });
  const el = h('div', { class: 'lb-sheet' }, backdrop, card);

  function drawTabs() {
    swap(tabs, LEADERBOARD_TABS.map((t) => h('button', {
      class: ['lb-tab', 'spot', board === t.id ? 'is-on' : null],
      type: 'button',
      dataset: { key: `lb-${t.id}` },
      attrs: { role: 'tab', 'aria-selected': board === t.id ? 'true' : 'false', tabindex: board === t.id ? '0' : '-1' },
      on: { click: () => pick(t.id) },
    }, t.label)));
  }

  function pick(id) {
    if (!TAB_IDS.includes(id) || id === board) return;
    board = id;
    drawTabs();
    load();
  }

  function loading() {
    swap(body, h('ol', { class: 'lb-list is-loading', attrs: { 'aria-busy': 'true', 'aria-label': 'Loading the leaderboard' } },
      Array.from({ length: 6 }, () => h('li', { class: 'lb-row lb-ghost' }, h('span', { class: 'lb-ghost-bar' })))));
    swap(mine);
  }

  async function load() {
    const mineToken = ++token;
    loading();
    try {
      const data = await fetchBoard(board, game, meId);
      if (closed || mineToken !== token) return;
      if (!data.rows.length) {
        const g = game === 'all' ? null : gameMeta(game);
        swap(body, h('div', { class: 'lb-state' },
          h('span', { class: 'lb-state-icon', attrs: { 'aria-hidden': 'true' }, text: '🌱' }),
          h('strong', { text: 'Nobody here yet' }),
          h('span', { text: g ? `Nobody has scored in ${g.name} yet. Be the first!` : 'Finish a game with at least one friend to be first on the board.' })));
      } else {
        swap(body, h('ol', { class: 'lb-list', attrs: { 'aria-label': `${tabMeta(board).label} leaderboard` } }, data.rows.map((r) => rowEl(board, r, meId))),
          data.total ? h('p', { class: 'lb-total', text: `${fmt(data.total)} ${data.total === 1 ? 'player' : 'players'} on this board` }) : null);
      }
      if (meId) swap(mine, h('span', { class: ['lb-me-text', data.me ? null : 'is-off'], text: meLine(board, data.me) }));
    } catch (err) {
      if (closed || mineToken !== token) return;
      const busy = err && err.message === 'busy';
      swap(body, h('div', { class: 'lb-state is-error' },
        h('span', { class: 'lb-state-icon', attrs: { 'aria-hidden': 'true' }, text: busy ? '⏳' : '📡' }),
        h('strong', { text: busy ? 'Lots of people are looking right now' : "Couldn't load the leaderboard" }),
        h('span', { text: busy ? 'Give it a few seconds and try again.' : 'Check your connection and try again.' }),
        h('button', { class: ['btn', 'btn-ghost', 'btn-sm', 'spot'], type: 'button', on: { click: () => load() } }, h('span', { class: 'btn-label', text: 'Try again' }))));
    }
  }

  function onKey(e) {
    if (closed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target && e.target.classList && e.target.classList.contains('lb-tab')) {
      const i = TAB_IDS.indexOf(board);
      const next = TAB_IDS[(i + (e.key === 'ArrowRight' ? 1 : TAB_IDS.length - 1)) % TAB_IDS.length];
      e.preventDefault();
      pick(next);
      const btn = tabs.querySelector(`[data-key="lb-${next}"]`);
      if (btn && typeof btn.focus === 'function') btn.focus();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    token += 1;
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true);
    el.remove();
    if (before && typeof before.focus === 'function' && before.isConnected !== false) before.focus();
  }

  select.addEventListener('change', () => {
    const v = select.value;
    game = v === 'all' || gameMeta(v) ? v : 'all';
    load();
  });
  if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true);
  drawTabs();
  host.append(el);
  if (typeof closeBtn.focus === 'function') closeBtn.focus();
  load();

  return {
    el,
    close,
    get closed() {
      return closed;
    },
    reload: load,
    show(nextBoard, nextGame) {
      if (nextGame && (nextGame === 'all' || gameMeta(nextGame))) {
        game = nextGame;
        select.value = nextGame;
      }
      if (TAB_IDS.includes(nextBoard)) board = nextBoard;
      drawTabs();
      return load();
    },
  };
}
