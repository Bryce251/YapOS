import { h as defaultH } from './dom.js';
import { profileAvatar } from '../profiles.js';
import { gameById } from '../games/index.js';

export const PROFILE_CARD_ENDPOINT = '/api/activity/profile/';
export const CARD_CACHE_MS = 3 * 60 * 1000;
export const CARD_CACHE_MAX = 100;
export const DRAG_PX = 8;
export const CLOSE_MS = 220;
export const BADGES_SHOWN = 6;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FOCUSABLE = 'button, a, input, select, textarea, [tabindex]';
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="link"], [contenteditable]';

function num(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString('en-US');
}

function text(value, max = 64) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const second = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + second).toUpperCase() || '?';
}

export function cleanCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.hidden === true) return { hidden: true, name: text(raw.name), avatar: profileAvatar(raw.avatar) };
  const list = (v) => (Array.isArray(v) ? v : []).filter((b) => b && typeof b.id === 'string').map((b) => ({ id: b.id.slice(0, 40), label: text(b.label, 48) || b.id.slice(0, 40), emoji: text(b.emoji, 16) }));
  const party = raw.party && typeof raw.party === 'object' ? raw.party : {};
  const prog = raw.progress && typeof raw.progress === 'object' ? { into: Math.max(0, Number(raw.progress.into) || 0), need: Math.max(1, Number(raw.progress.need) || 1) } : null;
  const rank = raw.rank && typeof raw.rank === 'object' && Number(raw.rank.rank) > 0 ? { rank: Math.floor(Number(raw.rank.rank)), points: Math.max(0, Number(raw.rank.points) || 0) } : null;
  const clan = raw.clan && typeof raw.clan === 'object' && text(raw.clan.name, 32) ? { name: text(raw.clan.name, 32), tag: text(raw.clan.tag, 6) } : null;
  return {
    hidden: false,
    name: text(raw.name),
    username: text(raw.username),
    avatar: profileAvatar(raw.avatar),
    level: raw.level === null || raw.level === undefined ? null : Math.max(0, Math.floor(Number(raw.level) || 0)),
    progress: prog,
    shards: raw.shards === null || raw.shards === undefined ? null : Math.max(0, Number(raw.shards) || 0),
    badges: list(raw.badges),
    badgeCount: Math.max(0, Math.floor(Number(raw.badgeCount) || 0)),
    achievements: list(raw.achievements),
    clan,
    party: {
      games: Math.max(0, Math.floor(Number(party.games) || 0)),
      wins: Math.max(0, Math.floor(Number(party.wins) || 0)),
      bestStreak: Math.max(0, Math.floor(Number(party.bestStreak) || 0)),
      favourites: (Array.isArray(party.favourites) ? party.favourites : []).filter((f) => f && typeof f.game === 'string').slice(0, 3).map((f) => ({ game: f.game, played: Math.max(0, Math.floor(Number(f.played) || 0)) })),
    },
    rank,
    page: raw.page === true,
  };
}

function resolve(value) {
  try {
    return typeof value === 'function' ? value() : value;
  } catch {
    return null;
  }
}

export function createProfileCard({ win, h = defaultH, engine = null, me = null, alone = false, now = () => Date.now() } = {}) {
  const cache = new Map();
  let state = null;
  let opener = null;
  let token = 0;
  let closeTimer = null;
  let boundRoot = null;
  let down = null;
  const unbinders = [];

  const closeBtn = h('button', { class: 'pcard-close', type: 'button', attrs: { 'aria-label': 'Close' }, on: { click: () => close() } }, h('span', { text: '✕', attrs: { 'aria-hidden': 'true' } }));
  const body = h('div', { class: 'pcard-body' });
  const panel = h(
    'section',
    { class: 'pcard', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pcard-name', tabindex: '-1' } },
    h('span', { class: 'pcard-grab', attrs: { 'aria-hidden': 'true' } }),
    closeBtn,
    body,
  );
  const backdrop = h('div', { class: 'pcard-backdrop', attrs: { 'aria-hidden': 'true' }, on: { click: () => close() } });
  const el = h('div', { class: 'pcard-layer', attrs: { hidden: true } }, backdrop, panel);
  el.hidden = true;
  el.addEventListener('keydown', onKey);

  function snapshot() {
    try {
      return engine && typeof engine.snapshot === 'function' ? engine.snapshot() : null;
    } catch {
      return null;
    }
  }

  function myId() {
    const v = resolve(me);
    if (v !== null && v !== undefined && v !== '') return String(v);
    const snap = snapshot();
    return snap && snap.me ? String(snap.me) : null;
  }

  function known(id, hint) {
    const snap = snapshot();
    const players = snap && Array.isArray(snap.players) ? snap.players : [];
    const p = players.find((x) => x && String(x.id) === id) || null;
    const base = { ...(hint || {}), ...(p || {}) };
    const name = text(base.name) || 'Player';
    return {
      name,
      username: text(base.username),
      avatar: typeof base.avatar === 'string' ? base.avatar : null,
      initials: text(base.initials, 3) || initialsOf(name),
      hue: Number.isFinite(Number(base.hue)) ? Number(base.hue) : 20,
      isMe: Boolean(base.isMe) || id === myId(),
      isHost: Boolean(p ? p.isHost : base.isHost),
      watching: Boolean(p && p.present && !p.joined && snap.room && snap.room.phase === 'game'),
      away: Boolean(p && p.present === false),
    };
  }

  function cached(id) {
    const hit = cache.get(id);
    if (!hit) return undefined;
    if (now() - hit.at > CARD_CACHE_MS || hit.at > now()) {
      cache.delete(id);
      return undefined;
    }
    return hit.card;
  }

  function remember(id, card) {
    cache.delete(id);
    cache.set(id, { at: now(), card });
    while (cache.size > CARD_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function load(id) {
    const fetcher = win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
    if (!fetcher || !ID_RE.test(id)) throw new Error('offline');
    const res = await fetcher(`${PROFILE_CARD_ENDPOINT}${encodeURIComponent(id)}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res.status === 404) return { none: true };
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const card = cleanCard(data && data.profile);
    if (!card) throw new Error('bad data');
    return card;
  }

  function fetchFor(id) {
    const mine = ++token;
    load(id)
      .then((card) => {
        remember(id, card);
        if (mine !== token || !state || state.id !== id) return;
        state = { ...state, card, status: card.none ? 'none' : card.hidden ? 'hidden' : 'ready' };
        paint();
      })
      .catch(() => {
        if (mine !== token || !state || state.id !== id) return;
        state = { ...state, status: 'error' };
        paint();
      });
  }

  function heroAvatar(who, card) {
    const pic = (card && card.avatar) || profileAvatar(who.avatar) || null;
    const box = h('div', { class: ['pcard-avatar', who.isMe ? 'is-me' : null, who.away ? 'is-away' : null, pic ? 'has-img' : null], vars: { '--hue': who.hue } });
    const face = h('span', { class: 'pcard-face' });
    const letters = () => face.replaceChildren(h('span', { class: 'pcard-initials', text: who.initials }));
    if (pic) {
      const img = h('img', { alt: '', attrs: { decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' } });
      img.addEventListener('error', () => {
        box.classList.remove('has-img');
        letters();
      });
      img.src = pic;
      face.append(img);
    } else letters();
    box.append(face);
    if (who.isHost) box.append(h('span', { class: 'pcard-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }));
    return box;
  }

  function tags(who, card) {
    const out = [];
    if (card && card.level !== null && card.level !== undefined) out.push(h('span', { class: 'pcard-level', text: `Level ${num(card.level)}` }));
    if (who.isHost) out.push(h('span', { class: ['pcard-tag', 'is-host'], text: 'Host' }));
    if (who.isMe) out.push(h('span', { class: ['pcard-tag', 'is-you'], text: 'You' }));
    if (who.watching) out.push(h('span', { class: 'pcard-tag', text: 'Watching' }));
    if (card && card.clan) out.push(h('span', { class: ['pcard-tag', 'is-clan'], text: card.clan.tag ? `[${card.clan.tag}] ${card.clan.name}` : card.clan.name }));
    return out.length ? h('div', { class: 'pcard-meta' }, out) : null;
  }

  function xpBar(card) {
    if (!card || !card.progress) return null;
    const pct = Math.max(0, Math.min(100, Math.round((card.progress.into / card.progress.need) * 100)));
    return h(
      'div',
      { class: 'pcard-xp' },
      h('div', { class: 'pcard-xp-track', vars: { '--p': `${pct}%` }, attrs: { role: 'progressbar', 'aria-label': 'XP to the next level', 'aria-valuemin': '0', 'aria-valuemax': String(card.progress.need), 'aria-valuenow': String(card.progress.into) } }, h('span', { class: 'pcard-xp-fill' })),
      h('span', { class: 'pcard-xp-text', text: `${num(card.progress.into)} / ${num(card.progress.need)} XP` }),
    );
  }

  function stat(value, label, extra) {
    return h('li', { class: ['pcard-stat', extra] }, h('span', { class: 'pcard-stat-value', text: value }), h('span', { class: 'pcard-stat-label', text: label }));
  }

  function skeleton() {
    return [
      h('ul', { class: 'pcard-stats', attrs: { 'aria-hidden': 'true' } }, [0, 1, 2].map(() => h('li', { class: ['pcard-stat', 'is-skeleton'] }, h('span', { class: 'pcard-bone' }), h('span', { class: ['pcard-bone', 'is-short'] })))),
      h('div', { class: 'pcard-badges', attrs: { 'aria-hidden': 'true' } }, h('ul', { class: 'pcard-badge-list' }, [0, 1, 2, 3].map(() => h('li', { class: ['pcard-badge', 'is-skeleton'] })))),
      h('p', { class: 'pcard-status', attrs: { role: 'status' }, text: 'Loading profile…' }),
    ];
  }

  function stats(card) {
    const p = card.party;
    const rate = p.games ? `${Math.round((p.wins / p.games) * 100)}%` : '–';
    return h('ul', { class: 'pcard-stats', attrs: { 'aria-label': 'Party stats' } }, stat(num(p.games), p.games === 1 ? 'Game' : 'Games'), stat(num(p.wins), p.wins === 1 ? 'Win' : 'Wins'), stat(rate, 'Win rate'));
  }

  function rankRow(card) {
    const bits = [];
    if (card.rank) {
      bits.push(
        h(
          'p',
          { class: ['pcard-rank', card.rank.rank <= 3 ? `is-top-${card.rank.rank}` : null] },
          h('span', { class: 'pcard-rank-num', text: `#${num(card.rank.rank)}` }),
          h('span', { class: 'pcard-rank-text', text: ` on the Party leaderboard · ${num(card.rank.points)} ${card.rank.points === 1 ? 'point' : 'points'}` }),
        ),
      );
    }
    const extras = [];
    if (card.party.bestStreak > 0) extras.push(h('span', { class: 'pcard-chip', text: `📅 Best daily streak ${num(card.party.bestStreak)}` }));
    if (card.shards !== null) extras.push(h('span', { class: 'pcard-chip', text: `💎 ${num(card.shards)} Shards` }));
    const favs = card.party.favourites
      .map((f) => {
        const g = gameById(f.game);
        return g ? h('span', { class: 'pcard-chip', attrs: { title: `${num(f.played)} played` } }, h('span', { text: g.emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text: ` ${g.name}` })) : null;
      })
      .filter(Boolean);
    if (favs.length) bits.push(h('div', { class: 'pcard-favs' }, h('h3', { class: 'pcard-section-title', text: 'Favourite games' }), h('div', { class: 'pcard-chips' }, favs)));
    if (extras.length) bits.push(h('div', { class: 'pcard-chips' }, extras));
    return bits;
  }

  function badges(card) {
    const all = [...card.badges, ...card.achievements];
    const total = Math.max(card.badgeCount, card.badges.length) + card.achievements.length;
    const shown = all.slice(0, total > BADGES_SHOWN ? BADGES_SHOWN - 1 : BADGES_SHOWN);
    const more = total - shown.length;
    return h(
      'section',
      { class: 'pcard-badges', attrs: { 'aria-labelledby': 'pcard-badges-title' } },
      h('h3', { class: 'pcard-section-title', text: 'Badges', attrs: { id: 'pcard-badges-title' } }),
      shown.length
        ? h(
            'ul',
            { class: 'pcard-badge-list' },
            shown.map((b) => h('li', { class: 'pcard-badge', attrs: { title: b.label, 'aria-label': b.label } }, h('span', { class: 'pcard-badge-emoji', text: b.emoji || '🏅', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'pcard-badge-label', text: b.label, attrs: { 'aria-hidden': 'true' } }))),
            more > 0 ? h('li', { class: ['pcard-badge', 'is-more'], attrs: { 'aria-label': `${more} more` } }, h('span', { class: 'pcard-badge-emoji', text: `+${more}`, attrs: { 'aria-hidden': 'true' } })) : null,
          )
        : h('p', { class: 'pcard-empty', text: 'No badges yet. Play a few games to earn some.' }),
    );
  }

  function note(card, who) {
    const handle = (card && card.page && card.username) || null;
    if (!handle) return null;
    if (alone) return h('div', { class: 'pcard-note' }, h('a', { class: 'btn btn-ghost btn-sm pcard-link', attrs: { href: `/u/${encodeURIComponent(handle)}` } }, h('span', { class: 'btn-label', text: who.isMe ? 'Open your full profile' : 'Open full profile' })));
    return h('p', { class: 'pcard-note', text: `Full profile at yapos.dev/u/${handle}` });
  }

  function paint() {
    if (!state) return;
    const who = known(state.id, state.hint);
    const card = state.status === 'ready' ? state.card : null;
    const hiddenCard = state.status === 'hidden' ? state.card : null;
    const name = (card && card.name) || who.name;
    const handle = (card && card.username) || who.username;
    panel.classList.toggle('is-loading', state.status === 'loading');
    panel.classList.toggle('is-error', state.status === 'error');
    const parts = [
      h(
        'div',
        { class: 'pcard-hero' },
        heroAvatar(who, card || (hiddenCard && hiddenCard.avatar ? hiddenCard : null)),
        h('h2', { class: 'pcard-name', text: name, attrs: { id: 'pcard-name' } }),
        handle ? h('p', { class: 'pcard-handle', text: `@${handle}` }) : null,
        tags(who, card),
      ),
    ];
    if (state.status === 'loading') parts.push(...skeleton());
    else if (card) {
      parts.push(xpBar(card), stats(card), ...rankRow(card), badges(card), note(card, who));
    } else if (state.status === 'hidden') {
      parts.push(h('p', { class: 'pcard-empty', text: 'This player keeps their profile private.' }));
    } else if (state.status === 'none') {
      parts.push(h('p', { class: 'pcard-empty', text: "Stats aren't available for this player yet. They show up after a finished game." }));
    } else {
      parts.push(
        h('div', { class: 'pcard-error' },
          h('p', { class: 'pcard-empty', attrs: { role: 'status' }, text: "We couldn't load this profile right now." }),
          h('button', { class: 'btn btn-secondary btn-sm pcard-retry', type: 'button', on: { click: retry } }, h('span', { class: 'btn-label', text: 'Try again' }))),
      );
    }
    body.replaceChildren(...parts.filter(Boolean));
  }

  function retry() {
    if (!state) return;
    state = { ...state, status: 'loading' };
    paint();
    fetchFor(state.id);
    closeBtn.focus();
  }

  function focusables() {
    return [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.getAttribute('tabindex') !== '-1' && !n.hidden);
  }

  function onKey(e) {
    if (!state) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const doc = win && win.document ? win.document : globalThis.document;
    const active = doc ? doc.activeElement : null;
    const i = list.indexOf(active);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === list.length - 1)) {
      e.preventDefault();
      list[0].focus();
    }
  }

  function open(rawId, hint = null, from = null) {
    const id = rawId === null || rawId === undefined ? '' : String(rawId);
    if (!id) return false;
    if (closeTimer !== null && win) win.clearTimeout(closeTimer);
    closeTimer = null;
    el.classList.remove('is-closing');
    if (!state) {
      const doc = win && win.document ? win.document : globalThis.document;
      opener = from || (doc ? doc.activeElement : null);
    }
    const hit = cached(id);
    state = { id, hint, card: hit || null, status: hit === undefined ? 'loading' : hit.none ? 'none' : hit.hidden ? 'hidden' : 'ready' };
    paint();
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.add('is-open');
    if (boundRoot) boundRoot.classList.add('has-modal');
    closeBtn.focus();
    if (hit === undefined) fetchFor(id);
    return true;
  }

  function finish() {
    closeTimer = null;
    if (state) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
    el.classList.remove('is-closing');
  }

  function close() {
    if (!state) return false;
    const id = state.id;
    state = null;
    token += 1;
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    if (boundRoot) boundRoot.classList.remove('has-modal');
    if (win && typeof win.setTimeout === 'function') closeTimer = win.setTimeout(finish, CLOSE_MS);
    else finish();
    let back = opener;
    opener = null;
    if ((!back || !back.isConnected) && boundRoot) back = boundRoot.querySelector(`[data-profile-id="${id.replace(/["\\]/g, '')}"][tabindex]`);
    if (back && typeof back.focus === 'function') back.focus();
    return true;
  }

  function nestedIn(node) {
    const up = node.parentNode;
    if (!up || typeof up.closest !== 'function') return false;
    const outer = up.closest(INTERACTIVE);
    return Boolean(outer && (!boundRoot || boundRoot.contains(outer)));
  }

  function scan(root = boundRoot) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    let n = 0;
    for (const node of root.querySelectorAll('[data-profile-id]')) {
      if (node.getAttribute('data-pc')) continue;
      if (el.contains(node) || nestedIn(node)) {
        node.setAttribute('data-pc', 'off');
        continue;
      }
      node.setAttribute('data-pc', 'on');
      if (node.hasAttribute('tabindex')) continue;
      const name = node.getAttribute('data-profile-name');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-haspopup', 'dialog');
      node.setAttribute('aria-label', name ? `View ${name}'s profile` : 'View profile');
      node.removeAttribute('aria-hidden');
      node.classList.add('pcard-trigger');
      n += 1;
    }
    return n;
  }

  function triggerOf(e) {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return null;
    let node = t.closest('[data-profile-id]');
    if (!node || el.contains(node)) return null;
    if (boundRoot && !boundRoot.contains(node)) return null;
    if (nestedIn(node)) {
      const outer = node.parentNode.closest(INTERACTIVE);
      if (!outer || !outer.hasAttribute('data-profile-id') || outer.getAttribute('data-profile-id') !== node.getAttribute('data-profile-id') || nestedIn(outer)) return null;
      node = outer;
    }
    return node;
  }

  function hintFrom(node) {
    const face = node.hasAttribute('data-profile-name') || !node.querySelector ? node : node.querySelector('[data-profile-name]') || node;
    const img = face.querySelector ? face.querySelector('img') : null;
    const st = face.style || null;
    const hue = st && typeof st.getPropertyValue === 'function' ? st.getPropertyValue('--hue') : st && st.props ? st.props['--hue'] : null;
    return {
      name: face.getAttribute('data-profile-name') || null,
      avatar: img && img.src ? img.src : null,
      initials: img ? null : text(face.textContent, 3),
      hue: hue === null || hue === undefined || hue === '' ? null : Number(hue),
    };
  }

  function onDown(e) {
    down = { at: now(), x: Number(e.clientX), y: Number(e.clientY), canvas: Boolean(e.target && typeof e.target.closest === 'function' && e.target.closest('canvas')) };
  }

  function dragged(e) {
    if (!down) return false;
    const was = down;
    down = null;
    if (e.detail === 0 || now() - was.at > 5000) return false;
    if (was.canvas) return true;
    const x = Number(e.clientX);
    const y = Number(e.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(was.x) || !Number.isFinite(was.y)) return false;
    return Math.hypot(x - was.x, y - was.y) > DRAG_PX;
  }

  function onClick(e) {
    const moved = dragged(e);
    const node = triggerOf(e);
    if (!node || moved) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    open(node.getAttribute('data-profile-id'), hintFrom(node), node);
  }

  function onKeyOpen(e) {
    if (state && (e.key === 'Escape' || e.key === 'Esc')) {
      close();
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (e.defaultPrevented) return;
    const node = triggerOf(e);
    if (!node || e.target !== node) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    open(node.getAttribute('data-profile-id'), hintFrom(node), node);
  }

  function bind(root) {
    if (!root || typeof root.addEventListener !== 'function') return () => {};
    boundRoot = root;
    if (el.parentNode !== root) root.append(el);
    root.addEventListener('pointerdown', onDown, true);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyOpen);
    scan(root);
    const off = () => {
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyOpen);
      if (boundRoot === root) boundRoot = null;
    };
    unbinders.push(off);
    return off;
  }

  function destroy() {
    if (state) close();
    if (closeTimer !== null && win) win.clearTimeout(closeTimer);
    closeTimer = null;
    for (const off of unbinders.splice(0)) off();
    el.removeEventListener('keydown', onKey);
    el.remove();
  }

  return {
    el,
    open,
    close,
    bind,
    scan,
    destroy,
    get isOpen() {
      return Boolean(state);
    },
    get openId() {
      return state ? state.id : null;
    },
  };
}
