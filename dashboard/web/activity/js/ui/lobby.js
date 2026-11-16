import { h, memo, avatar, button, plural, who, countdown, uidOf } from './dom.js';
import { board, standings } from './board.js';
import { sfx as defaultSfx } from './sfx.js';
import { burstFrom } from './juice.js';
import { CATEGORIES } from '../games/index.js';
import { createDailyBox } from './daily.js';
import { cleanCode, CODE_MAX } from '../engine.js';

export const TAB_KEY = 'yapos.party.tab';
export const DAILY_INTRO = 'Everyone everywhere gets the same puzzle today. Your best score goes on the daily board and keeps your streak going.';
export const ALL_TAB = 'all';

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
    games: games.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, blurb: g.blurb, min: g.minPlayers || 1, category: g.category || null })),
    rounds: snap.room.round || 0,
  };
}

export function dailyOf(game, settings) {
  const spec = ((game && game.settings) || []).find((s) => s && s.daily && s.type === 'toggle');
  return spec && settings && settings[spec.id] ? spec.daily : null;
}

export function codeText(spec, value) {
  const v = typeof value === 'string' ? value : '';
  if (v) return v;
  return spec.empty || 'None';
}

export function pickerTabs(list, categories = CATEGORIES) {
  const tabs = [{ id: ALL_TAB, name: 'All', emoji: '', count: list.length }];
  for (const c of categories) {
    const count = list.filter((g) => g.category === c.id).length;
    if (count) tabs.push({ id: c.id, name: c.name, emoji: c.emoji, count });
  }
  return tabs;
}

export function gamesInTab(list, tab) {
  return tab === ALL_TAB ? list.slice() : list.filter((g) => g.category === tab);
}

function defaultStore() {
  try {
    return typeof window !== 'undefined' && window ? window.localStorage || null : null;
  } catch {
    return null;
  }
}

export function readTab(store) {
  try {
    const v = store ? store.getItem(TAB_KEY) : null;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export function saveTab(store, tab) {
  try {
    if (store) store.setItem(TAB_KEY, tab);
  } catch {
    return;
  }
}

export const RESET_LABEL = 'New game (reset scores)';
export const RESET_CONFIRM = 'Tap again to reset';
export const RESET_MS = 3000;

function playerRow(p, fresh) {
  return h(
    'li',
    { class: ['player', p.isMe ? 'is-me' : null, fresh ? 'juice-in' : null] },
    who(p, { size: 'md' }),
    p.isHost ? h('span', { class: 'tag tag-host', text: 'Host' }) : null,
  );
}

function watcher(p) {
  return h(
    'li',
    { class: ['watcher', p.isMe ? 'is-me' : null], attrs: { title: p.username ? `${p.name} (@${p.username})` : p.name } },
    avatar(p, 'xs'),
    h('span', { class: 'watcher-name', text: p.isMe ? `${p.name} (you)` : p.name, attrs: { 'data-uid': uidOf(p) } }),
    p.isHost ? h('span', { class: 'watcher-host', text: 'Host' }) : null,
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
  });
}

function codeControl(spec, value, isHost, onSet, drafts) {
  const max = Number.isInteger(spec.max) ? Math.min(spec.max, CODE_MAX) : CODE_MAX;
  if (!isHost) return h('span', { class: ['code-value', value ? null : 'is-empty'], text: codeText(spec, value) });
  const draft = drafts && drafts.has(spec.id) ? drafts.get(spec.id) : typeof value === 'string' ? value : '';
  const commit = (el) => {
    const v = cleanCode(el.value, max) ?? '';
    el.value = v;
    if (drafts) drafts.delete(spec.id);
    if (v !== (value || '')) onSet(spec.id, v);
  };
  return h('input', {
    class: 'code-input',
    dataset: { key: `set-${spec.id}` },
    attrs: {
      type: 'text',
      value: draft,
      maxlength: max,
      autocomplete: 'off',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      placeholder: spec.placeholder || 'Code',
      'aria-label': spec.label,
    },
    on: {
      input: (e) => {
        const el = e.currentTarget;
        const v = cleanCode(el.value, max) ?? '';
        if (el.value !== v) el.value = v;
        if (drafts) drafts.set(spec.id, v);
      },
      change: (e) => commit(e.currentTarget),
      keydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commit(e.currentTarget);
      },
    },
  });
}

function settingControl(spec, value, isHost, onSet, drafts) {
  const opts = spec.options || [];
  if (spec.type === 'code') return codeControl(spec, value, isHost, onSet, drafts);
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

function cue(sound, name, opts) {
  try {
    if (sound && typeof sound.play === 'function') sound.play(name, opts);
  } catch {
    return;
  }
}

export function createLobby({ engine, toast, sfx = defaultSfx, store = defaultStore() }) {
  const el = h('section', { class: 'screen lobby', attrs: { 'aria-label': 'Lobby' } });
  const games = engine.games;
  const paint = memo(render);
  let armed = null;
  let known = null;
  let shownPick = null;
  let popPending = false;
  let tab = readTab(store);
  let tabPick = null;
  let last = null;
  const drafts = new Map();
  const daily = createDailyBox();
  let draftPick = null;

  function catOf(m, id) {
    const g = m.games.find((x) => x.id === id);
    return g && g.category ? g.category : ALL_TAB;
  }

  function settleTab(m) {
    const tabs = pickerTabs(m.games);
    const valid = tabs.some((t) => t.id === tab);
    const firstLook = tabPick === null;
    const moved = !firstLook && m.pick !== tabPick;
    tabPick = m.pick;
    if (!valid) tab = catOf(m, m.pick);
    else if (firstLook || moved) {
      const shows = gamesInTab(m.games, tab).some((g) => g.id === m.pick);
      if (!shows) tab = catOf(m, m.pick);
    }
    return tabs;
  }

  function chooseTab(id, focus) {
    if (!last || id === tab) return;
    tab = id;
    saveTab(store, id);
    cue(sfx, 'toggle');
    paint(el, { ...last, tab });
    if (focus) {
      const btn = el.querySelector(`[data-key="tab-${id}"]`);
      if (btn && typeof btn.focus === 'function') btn.focus();
    }
  }

  function tabKey(e, tabs) {
    const i = tabs.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    chooseTab(tabs[next].id, true);
  }

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
    if (!res.ok) cue(sfx, 'error');
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

  function freshPlayers(m) {
    const ids = new Set(m.playing.map((p) => String(p.id)));
    const fresh = known ? new Set([...ids].filter((id) => !known.has(id))) : new Set();
    known = ids;
    return fresh;
  }

  function pickPop(m) {
    const changed = shownPick !== null && m.pick !== shownPick;
    shownPick = m.pick;
    if (changed) popPending = true;
    return changed;
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
    const fresh = freshPlayers(m);
    const popped = pickPop(m);
    const game = games.find((g) => g.id === m.pick) || games[0];
    const gameMeta = m.games.find((g) => g.id === game.id);
    const playersCard = h(
      'div',
      { class: 'card glass players-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Players' }), h('span', { class: 'count-pill', text: `${m.playing.length} playing` })),
      joinBlock(m),
      h('h3', { class: 'group-title', text: 'Playing' }),
      m.playing.length
        ? h('ul', { class: 'players' }, m.playing.map((p) => playerRow(p, fresh.has(String(p.id)))))
        : h('p', { class: 'group-empty', text: 'Nobody has joined yet. Tap Join game to play.' }),
      m.watching.length
        ? h('div', { class: 'watchers' }, h('h3', { class: 'group-title', text: `Watching · ${m.watching.length}` }), h('ul', { class: 'watcher-list' }, m.watching.map(watcher)))
        : null,
    );
    const tabs = pickerTabs(m.games);
    const shown = gamesInTab(m.games, m.tab);
    const tabRow = h(
      'div',
      { class: 'picker-tabs', attrs: { role: 'tablist', 'aria-label': 'Game categories' } },
      tabs.map((t) => {
        const on = t.id === m.tab;
        return h(
          'button',
          {
            class: ['picker-tab', on ? 'is-on' : null],
            type: 'button',
            dataset: { key: `tab-${t.id}` },
            attrs: { role: 'tab', id: `picker-tab-${t.id}`, 'aria-selected': on ? 'true' : 'false', 'aria-controls': 'picker-panel', tabindex: on ? '0' : '-1' },
            on: { click: () => chooseTab(t.id, false), keydown: (e) => tabKey(e, tabs) },
          },
          h('span', { class: 'picker-tab-name', text: t.name }),
          h('span', { class: 'picker-tab-count', text: String(t.count), attrs: { 'aria-label': plural(t.count, 'game', 'games') } }),
        );
      }),
    );
    const picker = h(
      'div',
      { class: 'game-picker', attrs: { role: 'radiogroup', 'aria-label': 'Pick a game' } },
      shown.map((g) =>
        h(
          'button',
          {
            class: ['game-tile', 'spot', g.id === game.id ? 'is-on' : null, popped && g.id === game.id ? 'juice-pick' : null],
            type: 'button',
            disabled: !m.isHost,
            dataset: { key: `pick-${g.id}` },
            attrs: { role: 'radio', 'aria-checked': g.id === game.id ? 'true' : 'false', title: g.blurb },
            on: { click: () => engine.lobby.pick(g.id) },
          },
          h('span', { class: 'game-emoji', text: g.emoji, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'game-text' }, h('span', { class: 'game-name', text: g.name }), h('span', { class: 'game-blurb', text: g.blurb })),
        ),
      ),
    );
    const panel = h('div', { class: 'picker-panel', attrs: { role: 'tabpanel', id: 'picker-panel', 'aria-labelledby': `picker-tab-${m.tab}` } }, picker);
    const pickedHidden = !shown.some((g) => g.id === game.id);
    const upNext = h(
      'span',
      { class: ['picked-pill', pickedHidden ? 'is-away' : null], attrs: { 'aria-label': `Picked: ${gameMeta.name}` } },
      h('span', { class: 'picked-pill-emoji', text: gameMeta.emoji, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'picked-pill-name', text: gameMeta.name }),
    );
    const settings = h(
      'div',
      { class: 'settings' },
      (game.settings || []).map((spec) =>
        h('div', { class: ['setting', spec.type === 'code' ? 'is-code' : null] }, h('span', { class: 'setting-label', text: spec.label }), settingControl(spec, m.settings[spec.id], m.isHost, setSetting, drafts)),
      ),
    );
    const dailyKind = dailyOf(game, m.settings);
    daily.show(dailyKind, { intro: DAILY_INTRO, compact: true });
    const gameCard = h(
      'div',
      { class: 'card glass game-card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: m.isHost ? 'Pick a game' : 'Up next' }), upNext),
      tabRow,
      panel,
      settings,
      dailyKind ? daily.el : null,
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
      last = lobbyModel(snap, games);
      if (draftPick !== last.pick || !last.isHost) drafts.clear();
      draftPick = last.pick;
      settleTab(last);
      paint(el, { ...last, tab });
      if (!popPending) return;
      popPending = false;
      const tile = el.querySelector('.game-tile.juice-pick');
      if (!tile || !tile.isConnected) return;
      const emoji = tile.querySelector('.game-emoji');
      cue(sfx, 'pop');
      burstFrom(tile, { count: 10, spread: 70, size: 7, emoji: emoji && emoji.textContent ? [emoji.textContent] : null });
    },
    destroy() {
      daily.destroy();
    },
  };
}
