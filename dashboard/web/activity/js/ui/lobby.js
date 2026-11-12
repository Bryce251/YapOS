import { h, memo, avatar, button, plural } from './dom.js';
import { board, standings } from './board.js';

export function lobbyModel(snap, games) {
  const present = snap.players.filter((p) => p.present);
  const me = snap.players.find((p) => p.isMe) || null;
  return {
    isHost: snap.isHost,
    hostName: snap.hostName,
    pick: snap.pick ? snap.pick.id : null,
    settings: snap.settings,
    meReady: Boolean(me && me.ready),
    readyCount: present.filter((p) => p.ready).length,
    players: present.map((p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar, ready: p.ready, isHost: p.isHost, isMe: p.isMe, total: p.total, slot: p.slot, present: true })),
    totals: standings(snap.players, 'total').map((p) => ({ id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar, pts: p.pts, place: p.place, isMe: p.isMe, present: p.present, slot: p.slot })),
    games: games.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, blurb: g.blurb, min: g.minPlayers || 1 })),
    rounds: snap.room.round || 0,
  };
}

export const RESET_LABEL = 'New game (reset scores)';
export const RESET_CONFIRM = 'Tap again to reset';
export const RESET_MS = 3000;

function playerRow(p) {
  return h(
    'li',
    { class: ['player', p.isMe ? 'is-me' : null] },
    h('span', { class: 'player-face' }, avatar(p, 'md'), h('span', { class: ['ready-dot', p.ready ? 'is-ready' : null], attrs: { title: p.ready ? 'Ready' : 'Not ready yet' } })),
    h('span', { class: 'player-name', text: p.name }),
    p.isMe ? h('span', { class: 'tag', text: 'you' }) : null,
    p.isHost ? h('span', { class: 'tag tag-host', text: '👑 Host' }) : null,
  );
}

function settingControl(spec, value, isHost, onSet) {
  const opts = spec.options || [];
  if (spec.type === 'multi') {
    const picked = Array.isArray(value) ? value : [];
    return h(
      'div',
      { class: 'chips', attrs: { role: 'group', 'aria-label': spec.label } },
      opts.map((o) => {
        const on = picked.includes(o.value);
        return h(
          'button',
          {
            class: ['chip', on ? 'is-on' : null, 'spot'],
            type: 'button',
            disabled: !isHost,
            dataset: { key: `set-${spec.id}-${o.value}` },
            attrs: { 'aria-pressed': on ? 'true' : 'false' },
            on: { click: () => onSet(spec.id, on ? picked.filter((v) => v !== o.value) : picked.concat([o.value])) },
          },
          o.label,
        );
      }),
    );
  }
  if (spec.type === 'toggle') {
    return h(
      'button',
      {
        class: ['chip', value ? 'is-on' : null, 'spot'],
        type: 'button',
        disabled: !isHost,
        dataset: { key: `set-${spec.id}` },
        attrs: { 'aria-pressed': value ? 'true' : 'false' },
        on: { click: () => onSet(spec.id, !value) },
      },
      value ? 'On' : 'Off',
    );
  }
  return h(
    'div',
    { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': spec.label } },
    opts.map((o) =>
      h(
        'button',
        {
          class: ['seg', o.value === value ? 'is-on' : null],
          type: 'button',
          disabled: !isHost,
          dataset: { key: `set-${spec.id}-${o.value}` },
          attrs: { role: 'radio', 'aria-checked': o.value === value ? 'true' : 'false' },
          on: { click: () => onSet(spec.id, o.value) },
        },
        o.label,
      ),
    ),
  );
}

export function createLobby({ engine, toast }) {
  const el = h('section', { class: 'screen lobby', attrs: { 'aria-label': 'Lobby' } });
  const games = engine.games;
  const paint = memo(render);
  let armed = null;

  function disarm() {
    if (!armed) return;
    globalThis.clearTimeout(armed.timer);
    armed.btn.classList.remove('is-armed');
    const label = armed.btn.querySelector('.btn-label');
    if (label) label.textContent = RESET_LABEL;
    armed = null;
  }

  function resetTap(e) {
    const btn = e && e.currentTarget;
    if (armed && armed.btn === btn) {
      disarm();
      engine.lobby.reset();
      return;
    }
    disarm();
    if (!btn) return;
    btn.classList.add('is-armed');
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = RESET_CONFIRM;
    armed = { btn, timer: globalThis.setTimeout(disarm, RESET_MS) };
  }

  function setSetting(id, value) {
    if (!engine.lobby.setting(id, value) && toast) toast('Keep at least one option picked.');
  }

  function start() {
    const res = engine.lobby.start();
    if (!res.ok && toast) {
      if (res.reason === 'players') toast(`This game needs at least ${plural(res.need, 'player', 'players')}.`);
      else toast('That did not start. Try again in a moment.');
    }
  }

  function render(m) {
    const game = games.find((g) => g.id === m.pick) || games[0];
    const gameMeta = m.games.find((g) => g.id === game.id);
    const playersCard = h(
      'div',
      { class: 'card glass players-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Players' }), h('span', { class: 'count-pill', text: `${m.readyCount}/${m.players.length} ready` })),
      h('ul', { class: 'players' }, m.players.map(playerRow)),
      button(m.meReady ? 'Ready!' : "I'm ready", {
        variant: m.meReady ? 'ready' : 'secondary',
        size: 'lg',
        key: 'ready',
        attrs: { 'aria-pressed': m.meReady ? 'true' : 'false' },
        on: () => engine.ready(!m.meReady),
      }),
    );
    const picker = h(
      'div',
      { class: 'game-picker', attrs: { role: 'radiogroup', 'aria-label': 'Pick a game' } },
      m.games.map((g) =>
        h(
          'button',
          {
            class: ['game-tile', 'spot', g.id === game.id ? 'is-on' : null],
            type: 'button',
            disabled: !m.isHost,
            dataset: { key: `pick-${g.id}` },
            attrs: { role: 'radio', 'aria-checked': g.id === game.id ? 'true' : 'false' },
            on: { click: () => engine.lobby.pick(g.id) },
          },
          h('span', { class: 'game-emoji', text: g.emoji, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'game-name', text: g.name }),
          h('span', { class: 'game-blurb', text: g.blurb }),
        ),
      ),
    );
    const settings = h(
      'div',
      { class: 'settings' },
      (game.settings || []).map((spec) =>
        h('div', { class: 'setting' }, h('span', { class: 'setting-label', text: spec.label }), settingControl(spec, m.settings[spec.id], m.isHost, setSetting)),
      ),
    );
    const action = m.isHost
      ? button(`Start ${gameMeta.name}`, { variant: 'primary', size: 'xl', key: 'start', on: start })
      : h('p', { class: 'waiting', attrs: { role: 'status' } }, h('span', { class: 'pulse-dot', attrs: { 'aria-hidden': 'true' } }), `Waiting for ${m.hostName} to start`);
    const gameCard = h(
      'div',
      { class: 'card glass game-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: m.isHost ? 'Pick a game' : 'Up next' })),
      picker,
      settings,
      h('div', { class: 'start-row' }, action),
    );
    const scoreCard = h(
      'div',
      { class: 'card glass score-card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Scoreboard' }),
        m.rounds ? h('span', { class: 'count-pill', text: plural(m.rounds, 'game', 'games') }) : null,
      ),
      board(m.totals, { empty: 'Play a game to get on the board.', label: 'Session scores' }),
      m.isHost && m.totals.some((t) => t.pts > 0) ? button(RESET_LABEL, { variant: 'ghost', size: 'sm', key: 'reset', on: resetTap }) : null,
    );
    return h('div', { class: 'lobby-grid' }, gameCard, playersCard, scoreCard);
  }

  return {
    el,
    update(snap) {
      paint(el, lobbyModel(snap, games));
    },
    destroy() {},
  };
}
