import { h, swap, memo, button, tickTimers } from './dom.js';
import { createFx } from './fx.js';
import { createLobby, joinButton } from './lobby.js';
import { createResults } from './results.js';
import { board, standings } from './board.js';
import { viewFor } from '../views/index.js';

export function headerModel(snap, { alone = false } = {}) {
  const phase = snap.ready ? snap.room.phase : 'connecting';
  const game = snap.game;
  let status = alone ? 'Not in a call' : 'Connecting';
  if (phase === 'lobby') status = 'Lobby';
  else if (phase === 'game') status = game ? `${game.emoji} ${game.name}` : 'Playing';
  else if (phase === 'results') status = 'Results';
  return {
    phase,
    status,
    host: snap.ready ? (snap.isHost ? "You're the host" : `Host: ${snap.hostName}`) : null,
    hostShort: snap.ready ? (snap.isHost ? 'You' : snap.hostName) : null,
    isHost: snap.isHost,
    canEnd: snap.isHost && phase === 'game',
  };
}

export const STRIP_MAX = 12;
export const PROFILES_MS = 120;
export const PROFILES_EVENT = 'yapos:profiles';

export function stripModel(snap, extra = null) {
  const rows = standings(snap.players, 'game')
    .filter((p) => (p.present && p.joined) || p.pts > 0)
    .slice(0, STRIP_MAX)
    .map((p) => ({ id: p.id, slot: p.slot, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, pts: p.pts, isMe: p.isMe, place: p.place, present: p.present }));
  const opts = extra && typeof extra === 'object' ? extra : {};
  return { rows, badge: opts.badge || null, gains: opts.gains || null };
}

export function spectateModel(snap) {
  if (!snap.ready || snap.room.phase !== 'game' || snap.meJoined) return null;
  return { meJoined: false, joining: snap.joining || null };
}

export function mountApp({ root, engine, bridge, win }) {
  const alone = !win.parent || win.parent === win;
  let account = alone ? { state: 'loading', name: '' } : null;
  const fx = createFx(win);
  const toastRoot = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } });
  const head = h('header', { class: 'top' });
  const stage = h('main', { class: 'stage', attrs: { id: 'stage' } });
  root.replaceChildren(h('div', { class: 'aurora', attrs: { 'aria-hidden': 'true' } }), head, stage, toastRoot);

  function toast(text) {
    const t = h('div', { class: 'toast', text, attrs: { role: 'status' } });
    toastRoot.append(t);
    win.setTimeout(() => t.classList.add('is-out'), 2600);
    win.setTimeout(() => t.remove(), 3000);
  }

  const lobby = createLobby({ engine, toast });
  const results = createResults({ engine, fx });
  const gameWrap = h('div', { class: 'screen play' });
  const spectate = h('div', { class: 'spectate-slot' });
  const gameCard = h('div', { class: 'card glass play-card' });
  const strip = h('div', { class: 'strip' });
  gameWrap.append(spectate, gameCard, strip);
  const now = () => (typeof engine.now === 'function' ? engine.now() : Date.now());
  let renders = 0;
  let profileTimer = null;
  let view = null;
  let viewKey = '';
  let screen = '';

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'top-inner' },
      h('span', { class: 'brand' }, h('span', { class: 'brand-mark', text: '🎉', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'brand-name', text: 'YapOS Party' })),
      h('span', { class: 'status-pill', text: m.status }),
      m.host
        ? h(
            'span',
            { class: ['host-pill', m.isHost ? 'is-me' : null], attrs: { title: m.host } },
            h('span', { text: '👑 ', attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'host-long', text: m.host }),
            h('span', { class: 'host-short', text: m.hostShort, attrs: { 'aria-hidden': 'true' } }),
          )
        : null,
      h(
        'span',
        { class: 'top-actions' },
        m.canEnd ? button('End game', { variant: 'ghost', size: 'sm', key: 'end', on: () => engine.lobby.end(), attrs: { 'aria-label': 'End game', title: 'End game' }, kids: h('span', { class: 'btn-icon', text: '⏹', attrs: { 'aria-hidden': 'true' } }) }) : null,
        button('Close', { variant: 'ghost', size: 'sm', key: 'leave', on: leave, attrs: { 'aria-label': 'Close YapOS Party', title: 'Close YapOS Party' }, kids: h('span', { class: 'btn-icon', text: '🚪', attrs: { 'aria-hidden': 'true' } }) }),
      ),
    ),
  );

  const paintStrip = memo((m) =>
    m
      ? board(m.rows, { empty: 'Points show up here as you score.', label: 'Points this game', layout: 'bar', max: STRIP_MAX, badge: m.badge, gains: m.gains })
      : null,
  );

  const paintSpectate = memo((m) => {
    if (!m) return null;
    const btn = joinButton(m, { size: 'sm', key: 'join-late' });
    btn.addEventListener('click', () => engine.join());
    return h(
      'div',
      { class: 'spectate', attrs: { role: 'status' } },
      h('span', { class: 'spectate-label' }, h('span', { class: 'spectate-eye', text: '👀', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'Watching' })),
      h('span', { class: 'spectate-hint', text: 'Hop in any time.' }),
      btn,
    );
  });

  function viewBoard(snap) {
    if (!view || typeof view.board !== 'function') return null;
    try {
      return view.board(snap);
    } catch {
      return null;
    }
  }

  function ownsBoard() {
    return Boolean(view && view.el && typeof view.el.querySelector === 'function' && view.el.querySelector('[data-scoreboard]'));
  }

  function onProfiles() {
    if (profileTimer !== null) return;
    profileTimer = win.setTimeout(() => {
      profileTimer = null;
      render(engine.snapshot());
    }, PROFILES_MS);
  }

  const paintConnect = memo((m) => {
    if (m.lost) {
      return h(
        'div',
        { class: 'card glass hello-card' },
        h('span', { class: 'trophy', text: '🎉', attrs: { 'aria-hidden': 'true' } }),
        h('h1', { class: 'winner-title', text: 'YapOS Party' }),
        h('p', { class: 'muted', text: "Start it from a voice call in Yapin' to play with everyone in the call." }),
        accountBlock(m.account),
      );
    }
    return h(
      'div',
      { class: 'card glass hello-card' },
      h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      h('p', { class: 'muted', attrs: { role: 'status' }, text: m.ready ? 'Setting up the room…' : 'Joining the party…' }),
    );
  });

  function connectModel(snap) {
    return { lost: alone, ready: Boolean(snap && snap.ready), account: account ? `${account.state}:${account.name}` : '' };
  }

  function accountBlock(key) {
    if (!key) return null;
    const [state, ...rest] = key.split(':');
    const name = rest.join(':');
    if (state === 'loading') return h('p', { class: 'muted account-line', text: 'Checking your account…' });
    if (state === 'in') {
      return h('div', { class: 'account' },
        h('p', { class: 'account-line' }, h('span', { text: 'Signed in as ' }), h('strong', { text: name || 'you' }), h('span', { text: '.' })),
        h('a', { class: 'btn btn-ghost spot', attrs: { href: '/servers' } }, h('span', { class: 'btn-label', text: 'Open the dashboard' })));
    }
    return h('div', { class: 'account' },
      h('p', { class: 'account-line', text: "You're not signed in. Authorize YapOS with your Yapin' account to use it." }),
      h('a', { class: 'btn btn-primary spot', attrs: { href: '/auth/login?next=%2Factivity%2F' } }, h('span', { class: 'btn-label', text: "Log in with Yapin'" })));
  }

  function leave() {
    if (alone) {
      win.location.assign('/');
      return;
    }
    if (!engine.snapshot().ready) toast('Use the call controls to close the activity.');
    bridge.close();
  }

  if (alone && typeof win.fetch === 'function') {
    win.fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (r) => {
        const data = r.ok ? await r.json() : null;
        const u = data && data.user;
        account = u ? { state: 'in', name: String(u.display_name || u.username || '').slice(0, 64) } : { state: 'out', name: '' };
      })
      .catch(() => { account = { state: 'out', name: '' }; })
      .finally(() => render(engine.snapshot()));
  } else if (alone) {
    account = { state: 'out', name: '' };
  }

  function render(snap) {
    renders += 1;
    const hm = headerModel(snap, { alone });
    paintHead(head, hm);
    root.dataset.phase = hm.phase;
    if (screen === 'results' && hm.phase !== 'results') fx.clear();
    if (hm.phase === 'connecting') {
      screen = 'connecting';
      paintConnect(stage, connectModel(snap));
      return;
    }
    if (hm.phase === 'lobby') {
      if (screen !== 'lobby') swap(stage, lobby.el);
      screen = 'lobby';
      lobby.update(snap);
      tickTimers(stage, now());
      return;
    }
    if (hm.phase === 'results') {
      if (screen !== 'results') swap(stage, results.el);
      screen = 'results';
      results.update(snap);
      return;
    }
    const key = `${snap.room.game}:${snap.room.round}`;
    if (key !== viewKey) {
      if (view) view.destroy();
      const make = viewFor(snap.room.game);
      view = make ? make({ engine, fx, toast, win }) : null;
      viewKey = key;
      swap(gameCard, view ? view.el : h('p', { class: 'waiting', text: 'This game needs a newer version of YapOS Party. Reopen the activity to update.' }));
    }
    if (screen !== 'game') swap(stage, gameWrap);
    screen = 'game';
    if (view) view.update(snap);
    paintSpectate(spectate, spectateModel(snap));
    paintStrip(strip, ownsBoard() ? null : stripModel(snap, viewBoard(snap)));
    tickTimers(stage, now());
  }

  const stopSpot = fx.spotlight(root);
  const offChange = engine.on('change', render);
  if (typeof win.addEventListener === 'function') win.addEventListener(PROFILES_EVENT, onProfiles);
  const ticker = win.setInterval(() => {
    tickTimers(stage, now());
    if (screen === 'connecting') render(engine.snapshot());
  }, 200);
  render(engine.snapshot());

  return {
    render,
    toast,
    get renders() {
      return renders;
    },
    destroy() {
      offChange();
      if (typeof win.removeEventListener === 'function') win.removeEventListener(PROFILES_EVENT, onProfiles);
      if (profileTimer !== null) win.clearTimeout(profileTimer);
      profileTimer = null;
      stopSpot();
      win.clearInterval(ticker);
      if (view) view.destroy();
      fx.destroy();
    },
  };
}
