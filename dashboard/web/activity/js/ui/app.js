import { h, swap, memo, button, tickTimers, avatar } from './dom.js';
import { createFx } from './fx.js';
import { createLobby } from './lobby.js';
import { createResults } from './results.js';
import { standings } from './board.js';
import { viewFor } from '../views/index.js';

export function headerModel(snap) {
  const phase = snap.ready ? snap.room.phase : 'connecting';
  const game = snap.game;
  let status = 'Connecting';
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

function stripModel(snap) {
  return standings(snap.players, 'game')
    .filter((p) => p.present || p.pts > 0)
    .slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar, pts: p.pts, isMe: p.isMe, place: p.place }));
}

export function mountApp({ root, engine, bridge, win }) {
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
  const gameCard = h('div', { class: 'card glass play-card' });
  const strip = h('div', { class: 'strip' });
  gameWrap.append(gameCard, strip);
  let view = null;
  let viewKey = '';
  let screen = '';
  const firstSeen = Date.now();

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
        button('Leave', { variant: 'ghost', size: 'sm', key: 'leave', on: () => bridge.close(), attrs: { 'aria-label': 'Leave', title: 'Leave' }, kids: h('span', { class: 'btn-icon', text: '🚪', attrs: { 'aria-hidden': 'true' } }) }),
      ),
    ),
  );

  const paintStrip = memo((rows) =>
    rows.length && rows.some((r) => r.pts > 0)
      ? h(
          'ol',
          { class: 'strip-list', attrs: { 'aria-label': 'Points this game' } },
          rows.map((r) => h('li', { class: ['strip-item', r.isMe ? 'is-me' : null] }, avatar(r, 'xs'), h('span', { class: 'strip-name', text: r.name }), h('span', { class: 'strip-pts', text: r.pts.toLocaleString('en-US') }))),
        )
      : h('p', { class: 'strip-empty', text: 'Points show up here as you score.' }),
  );

  const paintConnect = memo((m) => {
    if (m.lost) {
      return h(
        'div',
        { class: 'card glass hello-card' },
        h('span', { class: 'trophy', text: '🎉', attrs: { 'aria-hidden': 'true' } }),
        h('h1', { class: 'winner-title', text: 'YapOS Party' }),
        h('p', { class: 'muted', text: "Start it from a voice call in Yapin' to play with everyone in the call." }),
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
    const alone = !win.parent || win.parent === win;
    return { lost: alone && Date.now() - firstSeen > 4000, ready: Boolean(snap && snap.ready) };
  }

  function render(snap) {
    const hm = headerModel(snap);
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
    paintStrip(strip, stripModel(snap));
    tickTimers(stage, Date.now());
  }

  const stopSpot = fx.spotlight(root);
  const offChange = engine.on('change', render);
  const ticker = win.setInterval(() => {
    tickTimers(stage, Date.now());
    if (screen === 'connecting') render(engine.snapshot());
  }, 200);
  render(engine.snapshot());

  return {
    render,
    toast,
    destroy() {
      offChange();
      stopSpot();
      win.clearInterval(ticker);
      if (view) view.destroy();
      fx.destroy();
    },
  };
}
