import { h, button, avatar } from './dom.js';

export const PRESETS_KEY = 'yapos.party.presets';
export const PRESETS_MAX = 5;
export const PRESET_NAME_MAX = 24;
export const REMOVED_TEXT = 'The host took you out of this game. You can play again in the next one.';
export const LATE_LOCKED_TEXT = 'The host locked late joins. You can join the next game.';

export function cleanPresetName(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, PRESET_NAME_MAX).join('').trim();
}

function cleanPreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanPresetName(raw.name);
  if (!name || typeof raw.game !== 'string' || !/^[a-z0-9-]{1,32}$/.test(raw.game)) return null;
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? raw.settings : {};
  const tour = raw.tour && typeof raw.tour === 'object' && Array.isArray(raw.tour.g) ? { g: raw.tour.g.filter((x) => typeof x === 'string').slice(0, 3) } : null;
  return { name, game: raw.game, settings, tour };
}

export function readPresets(store) {
  try {
    const raw = store ? store.getItem(PRESETS_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).map(cleanPreset).filter(Boolean).slice(0, PRESETS_MAX);
  } catch {
    return [];
  }
}

function writePresets(store, list) {
  try {
    if (!store) return false;
    store.setItem(PRESETS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function savePreset(store, preset) {
  const p = cleanPreset(preset);
  if (!p) return { ok: false, reason: 'name' };
  const list = readPresets(store);
  const at = list.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
  if (at < 0 && list.length >= PRESETS_MAX) return { ok: false, reason: 'full' };
  const next = at >= 0 ? list.map((x, i) => (i === at ? p : x)) : list.concat([p]);
  return writePresets(store, next) ? { ok: true, list: next } : { ok: false, reason: 'store' };
}

export function deletePreset(store, i) {
  const list = readPresets(store);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return list;
  const next = list.filter((_, k) => k !== i);
  writePresets(store, next);
  return next;
}

export function presetsBlock(list, { games, onSave, onLoad, onDelete, draft = '', onDraft }) {
  const input = h('input', {
    class: 'code-input preset-input',
    dataset: { key: 'preset-name' },
    attrs: { type: 'text', value: draft, maxlength: PRESET_NAME_MAX, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done', placeholder: 'Preset name', 'aria-label': 'Preset name' },
    on: {
      input: (e) => onDraft(e.currentTarget.value),
      keydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        onSave(e.currentTarget.value);
      },
    },
  });
  const save = button('Save settings', { variant: 'ghost', size: 'sm', key: 'preset-save', on: () => onSave(input.value) });
  return h(
    'div',
    { class: 'presets' },
    h('div', { class: 'presets-head' }, h('span', { class: 'setting-label', text: 'Presets' }), h('span', { class: 'presets-count muted', text: `${list.length} of ${PRESETS_MAX}` })),
    list.length
      ? h(
          'ul',
          { class: 'preset-list' },
          list.map((p, i) => {
            const g = games.find((x) => x.id === p.game);
            return h(
              'li',
              { class: 'preset' },
              h(
                'button',
                { class: ['chip', 'preset-load', 'spot'], type: 'button', dataset: { key: `preset-load-${i}` }, attrs: { title: g ? `${g.name}${p.tour ? ', tournament' : ''}` : p.name }, on: { click: () => onLoad(p) } },
                `${g ? g.emoji : '🎮'} ${p.name}`,
              ),
              h('button', { class: ['preset-del', 'spot'], type: 'button', dataset: { key: `preset-del-${i}` }, attrs: { 'aria-label': `Delete ${p.name}`, title: 'Delete' }, on: { click: () => onDelete(i) } }, '✕'),
            );
          }),
        )
      : h('p', { class: 'preset-empty muted', text: 'Save the game and settings you like to load them in one tap.' }),
    h('div', { class: 'preset-row' }, input, save),
  );
}

export function lateLockChip(on, onToggle) {
  return h(
    'div',
    { class: 'setting late-lock' },
    h('span', { class: 'setting-label', text: 'Lock late joins' }),
    h(
      'button',
      { class: ['chip', on ? 'is-on' : null, 'spot'], type: 'button', dataset: { key: 'late-lock' }, attrs: { 'aria-pressed': on ? 'true' : 'false', title: 'Stop people joining a game that has already started' }, on: { click: () => onToggle(!on) } },
      on ? 'On' : 'Off',
    ),
  );
}

export function hostBarModel(snap, open) {
  if (!snap || !snap.ready || !snap.isHost || snap.room.phase !== 'game') return null;
  const players = snap.players
    .filter((p) => p.joined && !p.isMe && Number.isInteger(p.slot))
    .map((p) => ({ slot: p.slot, id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar || null, username: p.username || null, safe: Boolean(p.isOwner && snap.admin && snap.admin.owner !== snap.me) }));
  return { open: Boolean(open), lateLocked: Boolean(snap.hostTools && snap.hostTools.lateLocked), players };
}

export function hostBar(m, { onOpen, onLate, onRemove }) {
  if (!m) return null;
  return h(
    'div',
    { class: ['host-tools', m.open ? 'is-open' : null] },
    h(
      'div',
      { class: 'host-tools-row' },
      button(m.open ? 'Hide host tools' : 'Host tools', { variant: 'ghost', size: 'sm', key: 'host-tools', on: onOpen, attrs: { 'aria-expanded': m.open ? 'true' : 'false' } }),
      lateLockChip(m.lateLocked, onLate),
    ),
    m.open
      ? m.players.length
        ? h(
            'ul',
            { class: 'host-players', attrs: { 'aria-label': 'Players in this game' } },
            m.players.map((p) =>
              h(
                'li',
                { class: 'host-player' },
                avatar(p, 'xs'),
                h('span', { class: 'host-player-name', text: p.name }),
                p.safe ? null : button('Remove', { variant: 'ghost', size: 'sm', key: `remove-${p.slot}`, on: () => onRemove(p.slot), attrs: { title: `Move ${p.name} to watching for this game` } }),
              ),
            ),
          )
        : h('p', { class: 'muted host-empty', text: 'Nobody else is playing right now.' })
      : null,
  );
}
