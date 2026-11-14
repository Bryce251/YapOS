import { h, memo, avatar, button, uidOf } from './dom.js';
import { fmt } from './board.js';
import { NEEDS_TARGET } from './trolls.js';

export const TABS = [
  { id: 'game', label: 'Game', icon: '🎛️' },
  { id: 'players', label: 'Players', icon: '👥' },
  { id: 'fun', label: 'Fun', icon: '🎉' },
  { id: 'troll', label: 'Troll', icon: '😈' },
];
export const ANNOUNCE_MAX = 140;
export const POINTS_MAX = 100000;
export const POINTS_STEP = 100;
export const TROLL_TIMES = [5000, 10000, 20000];
export const TIME_STEPS = [15000, 30000, -10000];
export const RAIN_EMOJI = ['🎉', '🔥', '😂', '💖', '⭐', '🍕', '👻', '🦆'];
export const FUN_MS = { confetti: 4000, 'emoji-rain': 6000, spotlight: 8000, hype: 4000 };
export const FUN = [
  { id: 'confetti', icon: '🎊', label: 'Confetti', blurb: 'A happy burst for everyone.' },
  { id: 'hype', icon: '🔥', label: 'Hype', blurb: "A big LET'S GO moment." },
];
export const TROLLS = [
  { id: 'flip', icon: '🙃', label: 'Flip', blurb: 'Turns the screen upside down.' },
  { id: 'mirror', icon: '🪞', label: 'Mirror', blurb: 'Everything reads backwards.' },
  { id: 'shake', icon: '🫨', label: 'Shake', blurb: 'A tiny earthquake.' },
  { id: 'spin', icon: '🌀', label: 'Spin', blurb: 'One slow lap around.' },
  { id: 'tiny', icon: '🐜', label: 'Tiny', blurb: 'Shrinks everything down.' },
  { id: 'comic', icon: '🖍️', label: 'Comic', blurb: 'Swaps in a silly font.' },
  { id: 'blur', icon: '👓', label: 'Blur', blurb: 'Like losing your glasses.' },
  { id: 'crash', icon: '💥', label: 'Fake crash', blurb: '"Stopped working"… then jk.' },
  { id: 'clown', icon: '🤡', label: 'Clown', blurb: 'A clown by their name for everyone.' },
  { id: 'fake-win', icon: '💰', label: 'Fake win', blurb: '"You won 1,000,000 Shards!"… then jk.' },
];

export function cleanAnnounce(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ANNOUNCE_MAX);
}

export function parsePoints(value) {
  const s = String(value ?? '').trim().replace(/[,\s]/g, '');
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n === 0 || Math.abs(n) > POINTS_MAX) return null;
  return n;
}

export function adminModel(snap, ui = {}) {
  const a = (snap && snap.admin) || {};
  const owner = a.owner || null;
  const amOwner = Boolean(owner) && snap.me === owner;
  const banned = new Set(Array.isArray(a.banned) ? a.banned : []);
  const phase = snap && snap.ready && snap.room ? snap.room.phase : 'connecting';
  const rows = ((snap && snap.players) || [])
    .filter((p) => p.present || banned.has(p.id))
    .map((p) => {
      const isOwner = Boolean(p.isOwner) || (Boolean(owner) && p.id === owner);
      return {
        id: p.id,
        slot: p.slot ?? null,
        name: p.name,
        username: p.username || null,
        initials: p.initials,
        hue: p.hue,
        avatar: p.avatar || null,
        present: Boolean(p.present),
        joined: Boolean(p.joined),
        isMe: Boolean(p.isMe),
        isAdmin: Boolean(p.isAdmin) || isOwner,
        isOwner,
        banned: banned.has(p.id),
        game: p.game || 0,
        total: p.total || 0,
        guarded: isOwner && !amOwner,
      };
    });
  const pickable = (id) => rows.some((r) => r.id === id && r.present && !r.guarded);
  return {
    me: Boolean(a.me),
    amOwner,
    owner,
    phase,
    gameName: snap && snap.game ? `${snap.game.emoji} ${snap.game.name}` : null,
    locked: Boolean(a.locked),
    rows,
    tab: TABS.some((t) => t.id === ui.tab) ? ui.tab : 'game',
    emoji: RAIN_EMOJI.includes(ui.emoji) ? ui.emoji : RAIN_EMOJI[0],
    spot: ui.spot && pickable(ui.spot) ? ui.spot : null,
    trollTarget: ui.trollTarget && pickable(ui.trollTarget) ? ui.trollTarget : null,
    trollMs: TROLL_TIMES.includes(ui.trollMs) ? ui.trollMs : TROLL_TIMES[1],
  };
}

function phaseText(m) {
  if (m.phase === 'lobby') return 'In the lobby';
  if (m.phase === 'game') return m.gameName ? `Playing ${m.gameName}` : 'A game is running';
  if (m.phase === 'results') return 'Showing results';
  return 'Connecting';
}

function secs(ms) {
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms) / 1000} s`;
}

export function createAdminPanel({ engine, toast, win, onToggle = () => {}, focusBack = () => null }) {
  const doc = win.document;
  const ui = { tab: 'game', emoji: RAIN_EMOJI[0], spot: null, trollTarget: null, trollMs: TROLL_TIMES[1] };
  let draft = '';
  const pointDrafts = new Map();
  let open = false;
  let last = null;
  const say = (text) => {
    if (typeof toast === 'function') toast(text);
  };

  const body = h('div', { class: 'admin-body' });
  const card = h(
    'section',
    { class: 'admin-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'admin-title' } },
    body,
  );
  const backdrop = h('div', { class: 'admin-backdrop', attrs: { 'aria-hidden': 'true' }, on: { click: () => close() } });
  const el = h('div', { class: 'admin-sheet', attrs: { id: 'admin-panel', hidden: true } }, backdrop, card);
  const paint = memo(render);

  function nameFor(id) {
    if (!id) return 'everyone';
    const r = last && last.rows.find((x) => x.id === id);
    return r ? (r.isMe ? 'you' : r.name) : 'them';
  }

  function run(action, done) {
    let ok = false;
    try {
      ok = Boolean(engine.admin && engine.admin.run(action));
    } catch {
      ok = false;
    }
    say(ok ? done : "That didn't go through. Try again in a moment.");
    return ok;
  }

  function fire(name, opts, done) {
    let ok = false;
    try {
      ok = Boolean(engine.admin && engine.admin.fx(name, opts));
    } catch {
      ok = false;
    }
    say(ok ? done : "That didn't go through. Try again in a moment.");
    return ok;
  }

  function setUi(patch) {
    Object.assign(ui, patch);
    refresh();
  }

  function refresh() {
    if (!open) return;
    const snap = engine.snapshot();
    last = adminModel(snap, ui);
    paint(body, last);
  }

  function tabBar(m) {
    return h(
      'div',
      { class: 'admin-tabs', attrs: { role: 'tablist', 'aria-label': 'Admin sections' } },
      TABS.map((t) =>
        h(
          'button',
          {
            class: ['admin-tab', t.id === m.tab ? 'is-on' : null, t.id === 'troll' ? 'is-troll' : null],
            type: 'button',
            dataset: { key: `admin-tab-${t.id}` },
            attrs: { role: 'tab', 'aria-selected': t.id === m.tab ? 'true' : 'false', 'aria-controls': 'admin-section' },
            on: { click: () => setUi({ tab: t.id }) },
          },
          h('span', { class: 'admin-tab-icon', text: t.icon, attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: t.label }),
        ),
      ),
    );
  }

  function section(title, ...kids) {
    return h('div', { class: 'admin-section' }, title ? h('h3', { class: 'admin-section-title', text: title }) : null, kids);
  }

  function gameTab(m) {
    const inGame = m.phase === 'game';
    const counter = h('span', { class: 'admin-count', text: `${draft.length}/${ANNOUNCE_MAX}` });
    const input = h('input', {
      class: 'admin-input',
      type: 'text',
      dataset: { key: 'adm-announce' },
      attrs: { maxlength: ANNOUNCE_MAX, placeholder: 'Say something to everyone', 'aria-label': 'Announcement text', autocomplete: 'off', enterkeyhint: 'send' },
      on: {
        input: (e) => {
          draft = String(e.currentTarget.value || '').slice(0, ANNOUNCE_MAX);
          counter.textContent = `${draft.length}/${ANNOUNCE_MAX}`;
        },
        keydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            sendAnnounce();
          }
        },
      },
    });
    input.value = draft;
    return h(
      'div',
      { class: 'admin-pane' },
      h('p', { class: 'admin-state' }, h('span', { class: 'admin-dot', attrs: { 'aria-hidden': 'true' } }), h('span', { text: phaseText(m) }), m.locked ? h('span', { class: 'admin-chip-lock', text: '🔒 Joining locked' }) : null),
      section(
        'Game',
        h(
          'div',
          { class: 'admin-grid' },
          button('Start now', { variant: 'primary', size: 'sm', key: 'adm-start', disabled: m.phase !== 'lobby', on: () => run({ type: 'start' }, 'Starting the game now.'), kids: h('span', { class: 'btn-icon-inline', text: '▶️', attrs: { 'aria-hidden': 'true' } }) }),
          button('End game', { variant: 'secondary', size: 'sm', key: 'adm-end', disabled: m.phase === 'lobby' || m.phase === 'connecting', on: () => run({ type: 'end' }, 'Ending the game.'), kids: h('span', { class: 'btn-icon-inline', text: '⏹', attrs: { 'aria-hidden': 'true' } }) }),
          button('Skip', { variant: 'secondary', size: 'sm', key: 'adm-skip', disabled: !inGame, on: () => run({ type: 'skip' }, 'Skipped ahead.'), kids: h('span', { class: 'btn-icon-inline', text: '⏭', attrs: { 'aria-hidden': 'true' } }) }),
        ),
      ),
      section(
        'Timer',
        h(
          'div',
          { class: 'admin-row' },
          TIME_STEPS.map((ms) => button(secs(ms), { variant: 'secondary', size: 'sm', key: `adm-time-${ms}`, disabled: !inGame, on: () => run({ type: 'time', ms }, ms > 0 ? `Added ${ms / 1000} seconds.` : `Took off ${Math.abs(ms) / 1000} seconds.`) })),
        ),
      ),
      section(
        'Joining',
        h(
          'button',
          {
            class: ['admin-toggle', m.locked ? 'is-on' : null, 'spot'],
            type: 'button',
            dataset: { key: 'adm-lock' },
            attrs: { 'aria-pressed': m.locked ? 'true' : 'false' },
            on: { click: () => run({ type: 'lock', on: !m.locked }, m.locked ? 'Joining is open again.' : 'Joining is locked. Admins can still hop in.') },
          },
          h('span', { class: 'admin-toggle-knob', attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: m.locked ? 'Joining is locked' : 'Lock joining' }),
        ),
      ),
      section(
        'Announce',
        h('div', { class: 'admin-announce' }, input, counter),
        h(
          'div',
          { class: 'admin-row' },
          button('Send', { variant: 'primary', size: 'sm', key: 'adm-announce-send', on: sendAnnounce, kids: h('span', { class: 'btn-icon-inline', text: '📣', attrs: { 'aria-hidden': 'true' } }) }),
          button('Clear', { variant: 'ghost', size: 'sm', key: 'adm-announce-clear', on: clearAnnounce }),
        ),
      ),
    );
  }

  function sendAnnounce() {
    const text = cleanAnnounce(draft);
    if (!text) {
      say('Type a message first.');
      return false;
    }
    const ok = run({ type: 'announce', text }, 'Announcement sent.');
    if (ok) {
      draft = '';
      refreshForce();
    }
    return ok;
  }

  function clearAnnounce() {
    draft = '';
    run({ type: 'announce', text: '' }, 'Announcement cleared.');
    refreshForce();
  }

  function refreshForce() {
    const input = body.querySelector('.admin-input');
    if (input) input.value = draft;
    const counter = body.querySelector('.admin-count');
    if (counter) counter.textContent = `${draft.length}/${ANNOUNCE_MAX}`;
  }

  function badge(r) {
    if (r.isOwner) return h('span', { class: 'admin-badge is-owner', text: '👑 Owner' });
    if (r.isAdmin) return h('span', { class: 'admin-badge', text: '🛡️ Admin' });
    return null;
  }

  function addPoints(r, n) {
    if (r.slot === null) return false;
    return run({ type: 'points', slot: r.slot, n }, `${n > 0 ? 'Gave' : 'Took'} ${fmt(Math.abs(n))} points ${n > 0 ? 'to' : 'from'} ${r.isMe ? 'you' : r.name}.`);
  }

  function customPoints(r) {
    const n = parsePoints(pointDrafts.get(r.id));
    if (n === null) {
      say(`Pick a whole number between -${fmt(POINTS_MAX)} and ${fmt(POINTS_MAX)}.`);
      return false;
    }
    pointDrafts.delete(r.id);
    const ok = addPoints(r, n);
    const input = body.querySelector(`.pts-input-${r.slot}`);
    if (input) input.value = '';
    return ok;
  }

  function playerRow(r) {
    const noSlot = r.slot === null;
    const off = r.guarded;
    const input = h('input', {
      class: ['admin-input', 'admin-pts-input', `pts-input-${r.slot}`],
      type: 'text',
      dataset: { key: `pts-in-${r.id}` },
      disabled: off || noSlot,
      attrs: { inputmode: 'numeric', placeholder: '±', 'aria-label': `Custom points for ${r.name}`, maxlength: 8, autocomplete: 'off' },
      on: {
        input: (e) => pointDrafts.set(r.id, String(e.currentTarget.value || '')),
        keydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            customPoints(r);
          }
        },
      },
    });
    input.value = pointDrafts.get(r.id) || '';
    const state = r.banned ? '🚫 Banned' : r.joined ? '🎮 Playing' : r.present ? '👀 Watching' : 'Away';
    return h(
      'li',
      { class: ['admin-player', r.isMe ? 'is-me' : null, r.banned ? 'is-banned' : null, off ? 'is-guarded' : null], dataset: { id: r.id } },
      h(
        'div',
        { class: 'admin-player-top' },
        avatar(r, 'sm'),
        h(
          'span',
          { class: 'admin-who' },
          h('span', { class: 'admin-name-line' }, h('strong', { class: 'admin-name', text: r.isMe ? `${r.name} (you)` : r.name, attrs: { 'data-uid': uidOf(r) } }), badge(r)),
          h('span', { class: 'admin-sub' }, r.username ? h('span', { class: 'admin-handle', text: `@${r.username}` }) : null, h('span', { class: 'admin-state-tag', text: state })),
        ),
        h('span', { class: 'admin-pts', attrs: { title: `${fmt(r.total)} in total` } }, h('strong', { text: fmt(r.game) }), h('span', { class: 'admin-pts-label', text: ' pts' })),
      ),
      off
        ? h('p', { class: 'admin-guard', text: "The owner can't be changed by other admins." })
        : h(
            'div',
            { class: 'admin-actions' },
            button(`+${POINTS_STEP}`, { variant: 'secondary', size: 'sm', key: `pts-up-${r.id}`, disabled: noSlot, on: () => addPoints(r, POINTS_STEP), attrs: { 'aria-label': `Give ${r.name} ${POINTS_STEP} points` } }),
            button(`−${POINTS_STEP}`, { variant: 'secondary', size: 'sm', key: `pts-down-${r.id}`, disabled: noSlot, on: () => addPoints(r, -POINTS_STEP), attrs: { 'aria-label': `Take ${POINTS_STEP} points from ${r.name}` } }),
            h('span', { class: 'admin-custom' }, input, button('Add', { variant: 'ghost', size: 'sm', key: `pts-go-${r.id}`, disabled: noSlot, on: () => customPoints(r), attrs: { 'aria-label': `Add custom points for ${r.name}` } })),
            button('Kick', { variant: 'ghost', size: 'sm', key: `kick-${r.id}`, disabled: noSlot || !r.joined, on: () => run({ type: 'kick', slot: r.slot }, `Moved ${r.isMe ? 'you' : r.name} to watching.`), attrs: { 'aria-label': `Move ${r.name} to watching` } }),
            r.banned
              ? button('Unban', { variant: 'secondary', size: 'sm', key: `unban-${r.id}`, disabled: noSlot, on: () => run({ type: 'unban', slot: r.slot }, `${r.isMe ? 'You' : r.name} can join again.`) })
              : button('Ban', { variant: 'danger', size: 'sm', key: `ban-${r.id}`, disabled: noSlot, on: () => run({ type: 'ban', slot: r.slot }, `${r.isMe ? 'You' : r.name} can't join until unbanned.`), attrs: { 'aria-label': `Ban ${r.name} from joining` } }),
          ),
    );
  }

  function playersTab(m) {
    return h(
      'div',
      { class: 'admin-pane' },
      m.rows.length
        ? h('ul', { class: 'admin-players' }, m.rows.map(playerRow))
        : h('p', { class: 'admin-empty', text: 'Nobody else is here yet.' }),
    );
  }

  function personChips(m, picked, keyBase, onPick, { everyone = false } = {}) {
    const chips = [];
    if (everyone) {
      chips.push(
        h(
          'button',
          { class: ['chip', 'admin-person', picked === null ? 'is-on' : null, 'spot'], type: 'button', dataset: { key: `${keyBase}-all` }, attrs: { 'aria-pressed': picked === null ? 'true' : 'false' }, on: { click: () => onPick(null) } },
          h('span', { class: 'admin-person-all', text: '🌍', attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: 'Everyone' }),
        ),
      );
    }
    for (const r of m.rows.filter((x) => x.present)) {
      chips.push(
        h(
          'button',
          {
            class: ['chip', 'admin-person', picked === r.id ? 'is-on' : null, 'spot'],
            type: 'button',
            disabled: r.guarded,
            dataset: { key: `${keyBase}-${r.id}` },
            attrs: { 'aria-pressed': picked === r.id ? 'true' : 'false', title: r.guarded ? "The owner can't be picked by other admins." : r.name },
            on: { click: () => onPick(r.id) },
          },
          avatar(r, 'xs'),
          h('span', { class: 'admin-person-name', text: r.isMe ? 'You' : r.name }),
        ),
      );
    }
    return h('div', { class: 'admin-people', attrs: { role: 'group' } }, chips);
  }

  function bigButton(item, key, onClick, disabled = false) {
    return h(
      'button',
      { class: ['admin-big', 'spot'], type: 'button', disabled, dataset: { key }, on: { click: onClick } },
      h('span', { class: 'admin-big-icon', text: item.icon, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'admin-big-text' }, h('strong', { text: item.label }), h('span', { class: 'admin-big-blurb', text: item.blurb })),
    );
  }

  function funTab(m) {
    return h(
      'div',
      { class: 'admin-pane' },
      section('Party moments', h('div', { class: 'admin-bigs' }, FUN.map((f) => bigButton(f, `fx-${f.id}`, () => fire(f.id, { target: null, ms: FUN_MS[f.id] }, `${f.icon} ${f.label} for everyone!`))))),
      section(
        'Emoji rain',
        h(
          'div',
          { class: 'admin-emoji', attrs: { role: 'radiogroup', 'aria-label': 'Pick an emoji' } },
          RAIN_EMOJI.map((e, i) =>
            h('button', {
              class: ['admin-emoji-pick', e === m.emoji ? 'is-on' : null],
              type: 'button',
              text: e,
              dataset: { key: `rain-${i}` },
              attrs: { role: 'radio', 'aria-checked': e === m.emoji ? 'true' : 'false', 'aria-label': `Rain ${e}` },
              on: { click: () => setUi({ emoji: e }) },
            }),
          ),
        ),
        button('Make it rain', { variant: 'primary', size: 'sm', key: 'fx-emoji-rain', on: () => fire('emoji-rain', { target: null, ms: FUN_MS['emoji-rain'], extra: { emoji: m.emoji } }, `It's raining ${m.emoji}!`) }),
      ),
      section(
        'Spotlight',
        personChips(m, m.spot, 'spot', (id) => setUi({ spot: id })),
        button(m.spot ? `Spotlight ${nameFor(m.spot)}` : 'Pick someone to spotlight', {
          variant: 'primary',
          size: 'sm',
          key: 'fx-spotlight',
          disabled: !m.spot,
          on: () => fire('spotlight', { target: m.spot, ms: FUN_MS.spotlight }, `✨ Spotlight on ${nameFor(m.spot)}.`),
        }),
      ),
    );
  }

  function trollTab(m) {
    return h(
      'div',
      { class: 'admin-pane is-troll' },
      h('p', { class: 'admin-hint', text: 'Harmless pranks that end by themselves. Keep it fun! Clown and Fake win need one person picked.' }),
      section('Who', personChips(m, m.trollTarget, 'troll-target', (id) => setUi({ trollTarget: id }), { everyone: true })),
      section(
        'How long',
        h(
          'div',
          { class: 'segmented admin-times', attrs: { role: 'radiogroup', 'aria-label': 'How long' } },
          TROLL_TIMES.map((ms) =>
            h('button', {
              class: ['seg', ms === m.trollMs ? 'is-on' : null],
              type: 'button',
              text: `${ms / 1000} s`,
              dataset: { key: `troll-ms-${ms}` },
              attrs: { role: 'radio', 'aria-checked': ms === m.trollMs ? 'true' : 'false' },
              on: { click: () => setUi({ trollMs: ms }) },
            }),
          ),
        ),
      ),
      section(
        'Pranks',
        h(
          'div',
          { class: 'admin-bigs is-trolls' },
          TROLLS.map((t) => bigButton(t, `troll-${t.id}`, () => fire(t.id, { target: m.trollTarget, ms: m.trollMs }, `${t.icon} ${t.label} sent to ${nameFor(m.trollTarget)}.`), NEEDS_TARGET.includes(t.id) && !m.trollTarget)),
        ),
      ),
    );
  }

  function render(m) {
    const pane = m.tab === 'players' ? playersTab(m) : m.tab === 'fun' ? funTab(m) : m.tab === 'troll' ? trollTab(m) : gameTab(m);
    return h(
      'div',
      { class: 'admin-inner' },
      h(
        'header',
        { class: 'admin-head' },
        h('span', { class: 'admin-shield', text: '🛡️', attrs: { 'aria-hidden': 'true' } }),
        h('h2', { class: 'admin-title', text: 'Admin', attrs: { id: 'admin-title' } }),
        h('span', { class: ['admin-role', m.amOwner ? 'is-owner' : null], text: m.amOwner ? 'Owner' : 'Admin' }),
        button('Close', { variant: 'ghost', size: 'sm', key: 'admin-close', on: () => close(), attrs: { 'aria-label': 'Close the admin panel' } }),
      ),
      tabBar(m),
      h('div', { class: 'admin-scroll', attrs: { id: 'admin-section', role: 'tabpanel' } }, pane),
    );
  }

  function focusables() {
    return Array.from(card.querySelectorAll('button, input, textarea, select, [tabindex]')).filter((x) => !x.disabled && x.getAttribute('tabindex') !== '-1');
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const end = list[list.length - 1];
    const at = doc.activeElement;
    const inside = at && card.contains(at);
    if (e.shiftKey && (at === first || !inside)) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && (at === end || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  function onWinKey(e) {
    if (open && e && e.key === 'Escape') onKey(e);
  }

  el.addEventListener('keydown', onKey);
  if (typeof win.addEventListener === 'function') win.addEventListener('keydown', onWinKey);

  function show() {
    if (open) return true;
    const snap = engine.snapshot();
    if (!snap || !snap.admin || !snap.admin.me) return false;
    open = true;
    el.removeAttribute('hidden');
    el.hidden = false;
    el.classList.add('is-open');
    refresh();
    const first = body.querySelector('.admin-tab.is-on') || focusables()[0];
    if (first && typeof first.focus === 'function') first.focus();
    onToggle(true);
    return true;
  }

  function close() {
    if (!open) return false;
    open = false;
    el.classList.remove('is-open');
    el.setAttribute('hidden', '');
    el.hidden = true;
    onToggle(false);
    const back = focusBack();
    if (back && typeof back.focus === 'function') back.focus();
    return true;
  }

  return {
    el,
    open: show,
    close,
    toggle() {
      return open ? close() : show();
    },
    get isOpen() {
      return open;
    },
    get model() {
      return last;
    },
    update(snap) {
      if (!open) return;
      if (!snap || !snap.admin || !snap.admin.me) {
        close();
        return;
      }
      last = adminModel(snap, ui);
      paint(body, last);
    },
    destroy() {
      el.removeEventListener('keydown', onKey);
      if (typeof win.removeEventListener === 'function') win.removeEventListener('keydown', onWinKey);
    },
  };
}
