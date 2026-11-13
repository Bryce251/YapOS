import { h, memo, avatar, button, plural, who, countdown } from './dom.js';
import { board, standings } from './board.js';

function slim(p) {
  return { id: p.id, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isHost: p.isHost, isMe: p.isMe };
}

export function needText(n) {
  if (n <= 0) return '';
  return n === 1 ? 'Waiting for one more player' : `Waiting for ${n} more players`;
}

export function lobbyModel(snap, games) {
  const present = snap.players.filter((p) => p.present);
  const playing = present.filter((p) => p.joined).map(slim);
  const watching = present.filter((p) => !p.joined).map(slim);
  const spec = snap.autoStart || null;
  const pick = snap.pick ? snap.pick.id : null;
  const live = snap.room && snap.room.auto && spec && snap.room.auto.g === pick ? snap.room.auto : null;
  return {
    isHost: snap.isHost,
    hostName: snap.hostName,
    pick,
    settings: snap.settings,
    meJoined: Boolean(snap.meJoined),
    joining: snap.joining || null,
    playing,
    watching,
    auto: spec ? { min: spec.min, ms: spec.ms } : null,
    need: spec ? Math.max(0, spec.min - playing.length) : 0,
    countdown: live ? { from: live.from, at: live.at } : null,
    totals: standings(snap.players, 'total').map((p) => ({ id: p.id, name: p.name, username: p.username || null, initials: p.initials, hue: p.hue, avatar: p.avatar || null, pts: p.pts, place: p.place, isMe: p.isMe, present: p.present, slot: p.slot })),
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
    who(p, { size: 'md' }),
    p.isHost ? h('span', { class: 'tag tag-host', text: '👑 Host' }) : null,
  );
}

function watcher(p) {
  return h(
    'li',
    { class: ['watcher', p.isMe ? 'is-me' : null], attrs: { title: p.username ? `${p.name} (@${p.username})` : p.name } },
    avatar(p, 'xs'),
    h('span', { class: 'watcher-name', text: p.isMe ? `${p.name} (you)` : p.name }),
    p.isHost ? h('span', { class: 'watcher-host', text: '👑', attrs: { title: 'Host', 'aria-label': 'Host' } }) : null,
  );
}

export function joinButton(m, { size = 'xl', key = 'join' } = {}) {
  if (m.meJoined) {
    const busy = m.joining === 'out';
    return button(busy ? 'Leaving…' : 'Leave game', { variant: 'ghost', size: 'sm', key: 'leave-game', disabled: busy });
  }
  const busy = m.joining === 'in';
  return button(busy ? 'Joining…' : 'Join game', {
    variant: 'primary',
    size,
    key,
    disabled: busy,
    kids: h('span', { class: 'btn-icon-inline', text: '🎮', attrs: { 'aria-hidden': 'true' } }),
  });
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

function waiting(text) {
  return h('p', { class: 'waiting', attrs: { role: 'status' } }, h('span', { class: 'pulse-dot', attrs: { 'aria-hidden': 'true' } }), text);
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
      if (res.reason === 'players') toast(`This game needs at least ${plural(res.need, 'player', 'players')}. Ask people to tap Join game.`);
      else toast('That did not start. Try again in a moment.');
    }
  }

  function onJoinTap(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.key : '';
    if (key === 'leave-game') engine.leave();
    else engine.join();
  }

  function joinBlock(m) {
    const btn = joinButton(m);
    btn.addEventListener('click', onJoinTap);
    const hint = m.meJoined ? "You're in! Have fun." : "You're watching. Join to play in the next game.";
    return h('div', { class: ['join-row', m.meJoined ? 'is-in' : null] }, btn, h('p', { class: 'join-hint', text: hint }));
  }

  function actionRow(m, gameMeta) {
    if (m.auto && m.countdown) {
      return h(
        'div',
        { class: 'auto-row' },
        countdown(m.countdown.from, m.countdown.at, { lead: 'Starting in', label: `${gameMeta.name} starts soon` }),
        m.isHost ? button('Start now', { variant: 'primary', size: 'lg', key: 'start', on: start }) : null,
      );
    }
    if (m.auto && m.need > 0) return waiting(needText(m.need));
    if (m.isHost) return button(`Start ${gameMeta.name}`, { variant: 'primary', size: 'xl', key: 'start', on: start });
    return waiting(`Waiting for ${m.hostName} to start`);
  }

  function render(m) {
    const game = games.find((g) => g.id === m.pick) || games[0];
    const gameMeta = m.games.find((g) => g.id === game.id);
    const playersCard = h(
      'div',
      { class: 'card glass players-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Players' }), h('span', { class: 'count-pill', text: `${m.playing.length} playing` })),
      joinBlock(m),
      h('h3', { class: 'group-title', text: 'Playing' }),
      m.playing.length
        ? h('ul', { class: 'players' }, m.playing.map(playerRow))
        : h('p', { class: 'group-empty', text: 'Nobody has joined yet. Tap Join game to play.' }),
      m.watching.length
        ? h('div', { class: 'watchers' }, h('h3', { class: 'group-title', text: `Watching · ${m.watching.length}` }), h('ul', { class: 'watcher-list' }, m.watching.map(watcher)))
        : null,
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
    const gameCard = h(
      'div',
      { class: 'card glass game-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: m.isHost ? 'Pick a game' : 'Up next' })),
      picker,
      settings,
      h('div', { class: 'start-row' }, actionRow(m, gameMeta)),
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
