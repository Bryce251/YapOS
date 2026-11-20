import { h, swap, memo, button, tickTimers, finalSeconds } from './dom.js';
import { createFx } from './fx.js';
import { createLobby, joinButton } from './lobby.js';
import { createResults } from './results.js';
import { board, standings, fmt } from './board.js';
import { viewFor } from '../views/index.js';
import { createAdminPanel } from './admin-panel.js';
import { banUntil } from '../admin.js';
import { createWarnings, inboxNotice } from './warning.js';
import { createTrolls, ALL_FX, seesFx } from './trolls.js';
import { sfx as defaultSfx } from './sfx.js';
import { createRecorder } from './replay.js';
import { replayLog } from '../games/replaylog.js';
import { predictModel, predictBox, predictWaitModel, predictWait } from './predict.js';
import { hostBarModel, hostBar, REMOVED_TEXT, LATE_LOCKED_TEXT } from './hosttools.js';
import { tourStatus } from './tournament.js';
import { createParty, createBoardLink } from './party.js';
import { createProfileCard } from './profilecard.js';
import { createSignin } from './signin.js';
import { startFxMode, mountBackdrop, fxLevel } from './fxmode.js';
import { createModTray } from './modhold.js';

export const SCREEN_IN_MS = 450;
export const ROUNDCARD_MS = 900;
export const RELIGHT_MS = 180;
export const SHINE_MS = 6000;

export function roundCardModel(snap) {
  if (!snap || !snap.ready || !snap.room || snap.room.phase !== 'game' || !snap.game) return null;
  const live = snap.tour ? snap.tour.live : null;
  const n = Number(snap.room.round) || 0;
  return { emoji: snap.game.emoji || '🎮', name: snap.game.name || 'Game', eyebrow: live ? tourStatus(live) : n > 0 ? `Game ${n}` : 'Get ready' };
}

function backdropFor(doc) {
  try {
    if (doc && typeof doc.createElement === 'function') return mountBackdrop(doc);
  } catch {
    return h('div', { class: 'fx-backdrop', attrs: { 'aria-hidden': 'true' } });
  }
  return h('div', { class: 'fx-backdrop', attrs: { 'aria-hidden': 'true' } });
}

export const ANNOUNCE_MS = 10000;
export const LEAVE_GRACE_MS = 6000;
export const KICKED_TEXT = 'An admin moved you to watching.';
export const BANNED_TEXT = "An admin moved you to watching. You can't rejoin until an admin lets you back in.";
export const PARTY_BANNED_TEXT = "You can't join YapOS Party games right now.";

export function banLeftText(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 2) return 'about a minute';
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 2) return '1 hour';
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function partyBanText(until, now = Date.now()) {
  const end = Number(until);
  if (!until || !Number.isFinite(end) || end <= now) return PARTY_BANNED_TEXT;
  const when = new Date(end);
  let clock = '';
  try {
    clock = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (new Date(now).toDateString() !== when.toDateString()) clock = `${when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${clock}`;
  } catch {
    clock = when.toISOString().slice(0, 16).replace('T', ' ');
  }
  return `You can't join games until ${clock} (in ${banLeftText(end - now)}).`;
}

export function partyBanned(snap) {
  return Boolean(snap && snap.ready && snap.admin && snap.admin.partyBanned);
}

export function isAdminSnap(snap) {
  return Boolean(snap && snap.ready && snap.admin && snap.admin.me);
}

export function announceModel(snap, now) {
  const a = snap && snap.ready ? snap.announce : null;
  if (!a || typeof a.text !== 'string' || !a.text.trim()) return null;
  const until = Number(a.until) || 0;
  if (until <= now) return null;
  return { text: a.text.slice(0, 140), until, from: until - ANNOUNCE_MS };
}

export const DIRECTOR_GAP_MS = 120;
export const JOIN_TAP_MS = 8000;
export const TICK_LAST_SECS = 3;

export function soundState(snap, at) {
  if (!snap || !snap.ready || !snap.room) return null;
  const players = Array.isArray(snap.players) ? snap.players : [];
  const mine = players.find((p) => p.isMe) || null;
  const last = snap.room.last || null;
  const slot = mine && mine.slot !== undefined && mine.slot !== null ? mine.slot : null;
  const ann = announceModel(snap, at);
  return {
    phase: snap.room.phase,
    others: players.filter((p) => !p.isMe && p.joined && p.present !== false).map((p) => String(p.id)),
    meJoined: Boolean(snap.meJoined),
    pts: mine ? Number(mine.game) || 0 : 0,
    iWon: Boolean(last && slot !== null && Array.isArray(last.winners) && last.winners.includes(slot)),
    announce: ann ? `${ann.until}:${ann.text}` : null,
  };
}

export function soundCues(prev, next) {
  if (!prev || !next) return [];
  const cues = [];
  const samePhase = prev.phase === next.phase;
  if (!samePhase && next.phase === 'game' && (prev.phase === 'lobby' || prev.phase === 'results')) cues.push({ sound: 'start' });
  if (!samePhase && next.phase === 'results' && prev.phase === 'game') cues.push({ sound: next.iWon ? 'win' : 'reveal' });
  if (!prev.meJoined && next.meJoined) cues.push({ sound: 'join', mine: true });
  else if (prev.meJoined && !next.meJoined) cues.push({ sound: 'leave', mine: true });
  if (next.pts > prev.pts) cues.push({ sound: 'coin', gain: next.pts - prev.pts });
  if (next.announce && next.announce !== prev.announce) cues.push({ sound: 'pop' });
  if (samePhase) {
    const before = new Set(prev.others);
    const after = new Set(next.others);
    if (next.others.some((id) => !before.has(id))) cues.push({ sound: 'join' });
    else if (prev.others.some((id) => !after.has(id))) cues.push({ sound: 'leave' });
  }
  return cues;
}

export const QUIT_ARM_MS = 3000;

export function headerModel(snap, { alone = false, adminOpen = false, sound = true, quitArmed = false } = {}) {
  const phase = snap.ready ? snap.room.phase : 'connecting';
  const game = snap.game;
  let status = alone ? 'Not in a call' : 'Connecting';
  if (phase === 'lobby') status = 'Lobby';
  else if (phase === 'game') status = game ? `${game.emoji} ${game.name}` : 'Playing';
  const live = snap.ready && snap.tour ? snap.tour.live : null;
  if (live && phase === 'game') status = `🏆 ${tourStatus(live)} · ${status}`;
  else if (phase === 'results') status = 'Results';
  return {
    phase,
    status,
    host: snap.ready ? (snap.isHost ? "You're the host" : `Host: ${snap.hostName}`) : null,
    hostShort: snap.ready ? (snap.isHost ? 'You' : snap.hostName) : null,
    isHost: snap.isHost,
    canEnd: snap.isHost && phase === 'game',
    canLeave: phase === 'game' && Boolean(snap.meJoined) && snap.joining !== 'out',
    quitArmed: phase === 'game' && Boolean(snap.meJoined) && Boolean(quitArmed),
    admin: isAdminSnap(snap),
    adminOpen: Boolean(adminOpen) && isAdminSnap(snap),
    sound: Boolean(sound),
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

export function gameTint(snap, phase) {
  if (!snap || !snap.ready || !snap.room) return null;
  let id = null;
  if (phase === 'game') id = snap.room.game;
  else if (phase === 'lobby') id = snap.pick ? snap.pick.id : null;
  else if (phase === 'results') id = snap.room.last ? snap.room.last.game : null;
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id) ? id : null;
}

export function spectateModel(snap) {
  if (!snap.ready || snap.room.phase !== 'game' || snap.meJoined) return null;
  const tools = snap.hostTools || {};
  const out = { meJoined: false, joining: snap.joining || null, banned: partyBanned(snap) };
  if (tools.removed) out.removed = true;
  else if (tools.lateLocked) out.locked = true;
  return out;
}

export function mountApp({ root, engine, bridge, win, sfx: sound = defaultSfx, juice = null, leaderboard = null, signin = null }) {
  const alone = !win.parent || win.parent === win;
  let account = alone ? { state: 'loading', name: '' } : null;
  const fx = createFx(win);
  let destroyed = false;
  let juiceMod = null;
  let detachJuice = null;
  let soundPrev = null;
  let lastCueAt = -Infinity;
  let joinTap = null;
  let unlocked = false;
  const toastRoot = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } });
  const head = h('header', { class: 'top' });
  const announceSlot = h('div', { class: 'announce-slot' });
  const banSlot = h('div', { class: 'party-ban-slot' });
  const stage = h('main', { class: 'stage', attrs: { id: 'stage' } });
  const shell = h('div', { class: 'shell' }, head, announceSlot, banSlot, stage);
  const fxLayer = h('div', { class: 'troll-layer' });
  let adminOpen = false;
  const panel = createAdminPanel({
    engine,
    toast,
    win,
    onToggle: (on) => {
      adminOpen = on;
      repaintHead();
    },
    focusBack: () => head.querySelector('.btn-admin'),
    sfx: sound,
  });
  const party = createParty({ engine, win, sfx: sound, toast });
  const boardHost = h('div', { class: 'leaderboard-host' });
  const boardLink = createBoardLink({ engine, host: boardHost, loader: leaderboard });
  const fxMode = startFxMode({ win });
  const backdrop = backdropFor(win.document || (typeof document !== 'undefined' ? document : null));
  let tintShown = null;
  let shineAt = 0;
  let shineArm = false;
  const fxTimers = new Set();
  root.replaceChildren(backdrop, shell, fxLayer, party.el, panel.el, boardHost, toastRoot);
  const offFxMode = fxMode.onChange(() => repaintHead());
  const profileCard = createProfileCard({ win, engine, alone, signin: () => gate });
  const offProfileCard = profileCard.bind(root);
  const gate = signin ? createSignin({ win, engine, toast, dev: Boolean(signin.dev), alone, host: root, onChange: () => repaintHead() }) : null;
  if (gate) root.append(gate.el);
  let inboxSeen = null;
  const warnings = gate ? createWarnings({ win, gate, onInbox: (n) => {
    const note = inboxNotice(inboxSeen, n);
    inboxSeen = n;
    if (note) toast(note);
  } }) : null;
  if (warnings) root.append(warnings.el);

  function withSignin(m) {
    const out = { ...m, fx: fxMode.button() };
    return gate && gate.needsLink() ? { ...out, signin: true } : out;
  }

  function fxButton(model) {
    const still = model.level === 'static';
    return h(
      'button',
      {
        class: ['btn', 'btn-ghost', 'btn-sm', 'btn-fx', 'spot'],
        type: 'button',
        dataset: { key: 'fx' },
        attrs: { 'aria-pressed': model.pressed ? 'true' : 'false', 'aria-label': model.label, title: model.title, 'aria-disabled': still ? 'true' : null },
        on: { click: () => {
          if (still) return;
          fxMode.cycle();
          repaintHead();
        } },
      },
      h('span', { class: 'btn-fx-icon', text: model.icon, attrs: { 'aria-hidden': 'true' } }),
    );
  }

  function signinButton() {
    const b = button('Sign in', { variant: 'ghost', size: 'sm', key: 'signin', on: () => gate.open(), attrs: { 'aria-haspopup': 'dialog', title: 'Sign in to YapOS Party' }, kids: h('span', { class: 'btn-icon', text: '👤', attrs: { 'aria-hidden': 'true' } }) });
    b.classList.add('btn-signin');
    return b;
  }

  function toast(text, kind = 'info') {
    const tone = kind === 'success' || kind === 'error' ? kind : 'info';
    const t = h('div', { class: ['toast', `toast-${tone}`], text, attrs: { role: 'status' } });
    toastRoot.append(t);
    win.setTimeout(() => t.classList.add('is-out'), 2600);
    win.setTimeout(() => t.remove(), 3000);
  }


  const trolls = createTrolls({ shell, layer: fxLayer, marks: root, win, engine, fx, sfx: sound });
  const lobby = createLobby({ engine, toast, boardLink });
  const replays = createRecorder();
  const results = createResults({ engine, fx, replays, win, toast, boardLink });
  const gameWrap = h('div', { class: 'screen play' });
  const hostSlot = h('div', { class: 'host-slot' });
  const spectate = h('div', { class: 'spectate-slot' });
  const predictSlot = h('div', { class: 'predict-slot' });
  const gameCard = h('div', { class: 'card glass play-card' });
  const strip = h('div', { class: 'strip' });
  const modTray = createModTray();
  const quitSlot = h('div', { class: 'quit-slot' });
  gameWrap.append(hostSlot, spectate, predictSlot, gameCard, modTray.el, strip, quitSlot);
  const paintQuit = memo((m) =>
    m.canLeave
      ? button(m.armed ? 'Tap again to leave' : 'Leave game', {
          variant: m.armed ? 'danger' : 'ghost',
          size: 'sm',
          key: 'quit-game',
          on: quitGame,
          attrs: { 'aria-label': m.armed ? 'Tap again to leave this game' : 'Leave this game and watch instead', title: 'Leave this game and watch instead' },
          kids: h('span', { class: 'btn-icon', text: '🚪', attrs: { 'aria-hidden': 'true' } }),
        })
      : null,
  );
  let hostOpen = false;
  let predictUntil = 0;
  const now = () => (typeof engine.now === 'function' ? engine.now() : Date.now());
  let renders = 0;
  let profileTimer = null;
  let view = null;
  let viewKey = '';
  let screen = '';
  let wasJoined = null;
  let selfLeaveAt = -Infinity;
  let announceLive = null;
  let quitArmedUntil = 0;
  let quitTimer = null;

  function quitArmed() {
    return now() < quitArmedUntil;
  }

  function quitGame() {
    if (quitTimer !== null) {
      win.clearTimeout(quitTimer);
      quitTimer = null;
    }
    if (!quitArmed()) {
      quitArmedUntil = now() + QUIT_ARM_MS;
      quitTimer = win.setTimeout(() => {
        quitTimer = null;
        quitArmedUntil = 0;
        render(engine.snapshot());
      }, QUIT_ARM_MS);
      render(engine.snapshot());
      return;
    }
    quitArmedUntil = 0;
    selfLeaveAt = now();
    if (engine.leave()) toast("You left the game. You're watching now and can join the next one.");
    render(engine.snapshot());
  }

  const paintHead = memo((m) =>
    h(
      'div',
      { class: 'top-inner' },
      h('span', { class: 'brand' }, h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }, h('img', { class: 'mark-img', alt: '', attrs: { src: '/logo.png', draggable: 'false', decoding: 'async' } })), h('span', { class: 'brand-name' }, 'YapOS ', h('span', { class: 'brand-sub', text: 'Party' }))),
      h('span', { class: ['status-pill', m.phase === 'connecting' ? null : 'is-live'] }, h('span', { class: 'status-dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'status-text', text: m.status })),
      m.host
        ? h(
            'span',
            { class: ['host-pill', m.isHost ? 'is-me' : null], attrs: { title: m.host } },
            m.isHost ? h('span', { class: 'host-crown', text: '👑', attrs: { 'aria-hidden': 'true' } }) : null,
            h('span', { class: 'host-long', text: m.host }),
            h('span', { class: 'host-short', text: m.hostShort, attrs: { 'aria-hidden': 'true' } }),
          )
        : null,
      h(
        'span',
        { class: 'top-actions' },
        m.signin ? signinButton() : null,
        soundButton(m.sound),
        m.fx ? fxButton(m.fx) : null,
        m.admin
          ? button('ADMIN', {
              variant: 'admin',
              size: 'sm',
              key: 'admin',
              on: () => panel.toggle(),
              attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': m.adminOpen ? 'true' : 'false', 'aria-controls': 'admin-panel', title: 'Open the admin panel' },
              kids: h('span', { class: 'btn-icon', text: '🛡️', attrs: { 'aria-hidden': 'true' } }),
            })
          : null,
        m.canEnd ? button('End game', { variant: 'ghost', size: 'sm', key: 'end', on: () => engine.lobby.end(), attrs: { 'aria-label': 'End game', title: 'End game' }, kids: h('span', { class: 'btn-icon', text: '■', attrs: { 'aria-hidden': 'true' } }) }) : null,
        button('Close', { variant: 'ghost', size: 'sm', key: 'leave', on: leave, attrs: { 'aria-label': 'Close YapOS Party', title: 'Close YapOS Party' }, kids: h('span', { class: 'btn-icon', text: '✕', attrs: { 'aria-hidden': 'true' } }) }),
      ),
    ),
  );

  function soundButton(on) {
    return h(
      'button',
      {
        class: ['btn', 'btn-ghost', 'btn-sm', 'btn-sound', on ? 'is-on' : 'is-off', 'spot'],
        type: 'button',
        dataset: { key: 'sound' },
        attrs: { 'aria-pressed': on ? 'true' : 'false', 'aria-label': 'Sound', title: on ? 'Sound on' : 'Sound off' },
        on: { click: toggleSound },
      },
      h('span', { class: 'btn-sound-icon', text: on ? '🔊' : '🔇', attrs: { 'aria-hidden': 'true' } }),
    );
  }

  function soundOn() {
    try {
      return Boolean(sound && sound.enabled);
    } catch {
      return false;
    }
  }

  function toggleSound() {
    if (!sound || typeof sound.setEnabled !== 'function') return;
    const next = !soundOn();
    sound.setEnabled(next);
    if (next) {
      if (typeof sound.unlock === 'function') sound.unlock();
      sound.play('toggle');
    }
    repaintHead();
  }

  function repaintHead() {
    if (destroyed) return;
    paintHead(head, withSignin(headerModel(engine.snapshot(), { alone, adminOpen, sound: soundOn(), quitArmed: quitArmed() })));
  }

  function stamp() {
    try {
      const p = win.performance;
      if (p && typeof p.now === 'function') return p.now();
    } catch {
      return Date.now();
    }
    return Date.now();
  }

  function cue(name) {
    const t = stamp();
    if (t - lastCueAt < DIRECTOR_GAP_MS && t >= lastCueAt) return false;
    lastCueAt = t;
    try {
      return Boolean(sound.play(name));
    } catch {
      return false;
    }
  }

  function juiceCall(fn, ...args) {
    if (!juiceMod || typeof juiceMod[fn] !== 'function') return false;
    try {
      juiceMod[fn](...args);
      return true;
    } catch {
      return false;
    }
  }

  function centerOf(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r && (r.width || r.height)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    } catch {
      return null;
    }
    return null;
  }

  function myScoreRow() {
    return stage.querySelector('.board-row.is-me') || stage.querySelector('.board-card.is-me') || null;
  }

  function direct(snap) {
    const next = soundState(snap, now());
    const cues = soundCues(soundPrev, next);
    soundPrev = next;
    if (!cues.length) return;
    cue(cues[0].sound);
    for (const c of cues) {
      if (c.mine && c.sound === 'join' && joinTap && stamp() - joinTap.at < JOIN_TAP_MS) {
        juiceCall('burst', joinTap.x, joinTap.y, { count: 18, emoji: ['🎮', '🎉'] });
        joinTap = null;
      }
      if (c.sound === 'coin') {
        const row = myScoreRow();
        if (row) juiceCall('floatText', row, `+${fmt(c.gain)}`);
      }
    }
  }

  const watchCountdown = finalSeconds((secs) => cue(secs <= TICK_LAST_SECS ? 'tickLast' : 'tick'));
  const timerHooks = { countdown: watchCountdown };

  function onFx(ev) {
    if (!ev || typeof ev !== 'object' || !ALL_FX.includes(ev.fx) || ev.fx === 'tacos') return;
    const snap = engine.snapshot();
    const me = snap ? snap.me : null;
    if (ev.by && me && ev.by === me) return;
    const target = ev.target === undefined || ev.target === '' ? null : ev.target;
    if (!seesFx(ev.fx, target, me)) return;
    cue('fx');
  }

  function unlockOnce() {
    if (unlocked) return;
    unlocked = true;
    if (sound && typeof sound.unlock === 'function') sound.unlock();
    offUnlock();
  }

  function unlockTarget() {
    return typeof win.addEventListener === 'function' ? win : root;
  }

  function offUnlock() {
    const t = unlockTarget();
    t.removeEventListener('pointerdown', unlockOnce, true);
    t.removeEventListener('keydown', unlockOnce, true);
  }

  function useJuice(mod) {
    if (destroyed || !mod || typeof mod !== 'object') return;
    juiceMod = mod;
    if (detachJuice || typeof mod.attachJuice !== 'function') return;
    try {
      const off = mod.attachJuice(root, { sfx: sound });
      detachJuice = typeof off === 'function' ? off : null;
    } catch {
      detachJuice = null;
    }
  }

  const paintStrip = memo((m) =>
    m
      ? board(m.rows, { empty: 'Points show up here as you score.', label: 'Points this game', layout: 'bar', max: STRIP_MAX, badge: m.badge, gains: m.gains })
      : null,
  );

  const banText = (snap) => partyBanText(snap && snap.me ? banUntil(snap.me) : null, now());
  const paintBan = memo((text) => (text ? h('p', { class: 'party-ban', attrs: { role: 'status' } }, h('span', { class: 'party-ban-icon', text: '🚫', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'party-ban-text', text })) : null));

  const paintSpectate = memo((m) => {
    if (!m) return null;
    if (m.banned || m.removed || m.locked) {
      return h(
        'div',
        { class: 'spectate', attrs: { role: 'status' } },
        h('span', { class: 'spectate-label' }, h('span', { text: 'Watching' })),
        h('span', { class: 'spectate-hint', text: m.banned ? banText(engine.snapshot()) : m.removed ? REMOVED_TEXT : LATE_LOCKED_TEXT }),
      );
    }
    const btn = joinButton(m, { size: 'sm', key: 'join-late' });
    btn.addEventListener('click', () => engine.join());
    return h(
      'div',
      { class: 'spectate', attrs: { role: 'status' } },
      h('span', { class: 'spectate-label' }, h('span', { text: 'Watching' })),
      h('span', { class: 'spectate-hint', text: 'Hop in any time.' }),
      btn,
    );
  });

  const paintPredict = memo((m) => (m ? (m.pick ? predictBox(m.pick, onPredict) : predictWait(m.wait)) : null));

  const paintHostBar = memo((m) =>
    hostBar(m, {
      onOpen: () => {
        hostOpen = !hostOpen;
        render(engine.snapshot());
      },
      onLate: (on) => {
        engine.lobby.lateLock(on);
        toast(on ? 'Late joins are locked for now.' : 'Late joins are open again.');
      },
      onRemove: (slot) => {
        if (engine.lobby.remove(slot)) toast('Moved to watching for this game.');
        else toast("That player can't be removed.");
      },
    }),
  );

  function onPredict(slot) {
    if (!engine.predict(slot)) {
      toast('Picks are closed for this round.');
      return;
    }
    cue('toggle');
  }

  const paintAnnounce = memo((m) =>
    m
      ? h(
          'div',
          { class: 'announce', attrs: { role: 'status', 'aria-live': 'polite' } },
          h('span', { class: 'announce-icon', text: '📣', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'announce-text', text: m.text }),
          h('span', { class: 'announce-secs', text: '' }),
          h('span', { class: 'announce-track', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'announce-fill' })),
        )
      : null,
  );

  function tickAnnounce(t) {
    if (!announceLive) return;
    if (t >= announceLive.until) {
      announceLive = null;
      paintAnnounce(announceSlot, null);
      return;
    }
    const box = announceSlot.querySelector('.announce');
    if (!box) return;
    const span = Math.max(1, announceLive.until - announceLive.from);
    box.style.setProperty('--left', Math.min(1, Math.max(0, (announceLive.until - t) / span)).toFixed(4));
    const secs = box.querySelector('.announce-secs');
    const text = `${Math.max(0, Math.ceil((announceLive.until - t) / 1000))}s`;
    if (secs && secs.textContent !== text) secs.textContent = text;
  }

  function watchKick(snap) {
    if (!snap.ready) return;
    const joined = Boolean(snap.meJoined);
    const mine = snap.players.find((p) => p.isMe);
    if (wasJoined && !joined && snap.admin && mine && mine.present && snap.joining !== 'out' && now() - selfLeaveAt > LEAVE_GRACE_MS) {
      const banned = Array.isArray(snap.admin.banned) && snap.admin.banned.includes(snap.me);
      toast(partyBanned(snap) ? banText(snap) : banned ? BANNED_TEXT : KICKED_TEXT);
    }
    if (snap.joining === 'out') selfLeaveAt = now();
    wasJoined = joined;
  }

  function onRootClick(e) {
    let n = e && e.target;
    while (n && n !== root) {
      if (n.dataset && n.dataset.key === 'leave-game') {
        selfLeaveAt = now();
        return;
      }
      if (n.dataset && (n.dataset.key === 'join' || n.dataset.key === 'join-late')) {
        if (gate && !gate.require('join')) {
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
          if (typeof e.preventDefault === 'function') e.preventDefault();
          return;
        }
        if (partyBanned(engine.snapshot())) {
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
          if (typeof e.preventDefault === 'function') e.preventDefault();
          toast(banText(engine.snapshot()));
          return;
        }
        const c = centerOf(n);
        const x = c ? c.x : Number(e.clientX) || (win.innerWidth || 360) / 2;
        const y = c ? c.y : Number(e.clientY) || (win.innerHeight || 640) / 2;
        joinTap = { x, y, at: stamp() };
        return;
      }
      n = n.parentNode;
    }
  }

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
        helloCrest(false),
        h('h1', { class: 'hello-title', text: 'YapOS Party' }),
        h('p', { class: 'muted', text: "Start it from a voice call in Yapin' to play with everyone in the call." }),
        accountBlock(m.account),
      );
    }
    return h(
      'div',
      { class: 'card glass hello-card is-busy' },
      helloCrest(true),
      h('h1', { class: 'hello-title', text: 'YapOS Party' }),
      h('p', { class: 'muted hello-status', attrs: { role: 'status' } }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text: m.ready ? 'Setting up the room…' : 'Joining the party…' })),
    );
  });

  function helloCrest(busy) {
    return h('span', { class: ['hello-crest', busy ? 'is-busy' : null], attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'hello-crest-mark' }, h('img', { class: 'mark-img', alt: '', attrs: { src: '/logo.png', draggable: 'false', decoding: 'async' } })));
  }

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
    const hm = headerModel(snap, { alone, adminOpen, sound: soundOn(), quitArmed: quitArmed() });
    paintHead(head, withSignin(hm));
    root.dataset.phase = hm.phase;
    const tint = gameTint(snap, hm.phase);
    if (tint) root.dataset.game = tint;
    else delete root.dataset.game;
    relight(tint, hm.phase);
    watchKick(snap);
    announceLive = announceModel(snap, now());
    paintAnnounce(announceSlot, announceLive ? { text: announceLive.text, until: announceLive.until } : null);
    paintBan(banSlot, partyBanned(snap) && hm.phase !== 'game' ? banText(snap) : null);
    tickAnnounce(now());
    panel.update(snap);
    if (gate) gate.update(snap);
    if (warnings) warnings.update();
    paintBody(snap, hm);
    if (party.update(snap)) root.dataset.dock = 'on';
    else delete root.dataset.dock;
    trolls.paint();
    profileCard.scan();
    direct(snap);
  }

  function watchInk(snap) {
    try {
      replayLog.observe(snap);
    } catch {
      return;
    }
  }

  function holdInk(snap) {
    try {
      modTray.update(snap);
    } catch {
      return;
    }
  }

  function hearInk(msg) {
    try {
      if (msg) replayLog.hear(msg.data, msg.by);
    } catch {
      return;
    }
  }

  function fxLater(fn, ms) {
    const id = win.setTimeout(() => {
      fxTimers.delete(id);
      if (!destroyed) fn();
    }, ms);
    fxTimers.add(id);
  }

  function enter(el) {
    if (!el || !el.classList || fxLevel() === 'static') return;
    el.classList.remove('fx-screen-in');
    el.classList.add('fx-screen-in');
    let done = false;
    const off = () => {
      if (done) return;
      done = true;
      el.classList.remove('fx-screen-in');
      el.removeEventListener('animationend', onEnd);
    };
    const onEnd = (e) => {
      if (!e || e.target === el) off();
    };
    el.addEventListener('animationend', onEnd);
    fxLater(off, SCREEN_IN_MS);
  }

  function roundCard(m) {
    const old = gameWrap.querySelector('.fx-roundcard');
    if (old) old.remove();
    if (!m || fxLevel() === 'static') return;
    const card = h(
      'div',
      { class: 'fx-roundcard', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'fx-roundcard-emoji fx-slam', text: m.emoji }),
      h('p', { class: 'eyebrow-caps', text: m.eyebrow }),
      h('p', { class: 'fx-roundcard-name fx-display is-lit fx-pop', text: m.name }),
    );
    gameWrap.append(card);
    fxLater(() => card.remove(), ROUNDCARD_MS);
  }

  function relight(tint, phase) {
    const was = tintShown;
    tintShown = tint;
    if (phase !== 'lobby' || was === null || was === tint || fxLevel() === 'static' || !backdrop.classList) return;
    backdrop.classList.add('is-relight');
    fxLater(() => backdrop.classList.remove('is-relight'), RELIGHT_MS);
  }

  function tickShine(t) {
    if ((screen !== 'lobby' && screen !== 'results') || fxLevel() !== 'full') return;
    if (shineArm) {
      shineArm = false;
      for (const b of stage.querySelectorAll('.fx-cta')) b.classList.add('is-shining');
      return;
    }
    if (t - shineAt < SHINE_MS) return;
    shineAt = t;
    shineArm = true;
    for (const b of stage.querySelectorAll('.fx-cta.is-shining')) b.classList.remove('is-shining');
  }

  function toTop() {
    try {
      if (win && typeof win.scrollTo === 'function') win.scrollTo(0, 0);
    } catch {
      return;
    }
  }

  function dropView() {
    if (!view) return;
    const old = view;
    view = null;
    viewKey = '';
    old.destroy();
  }

  function paintBody(snap, hm) {
    if (screen === 'results' && hm.phase !== 'results') fx.clear();
    if (hm.phase === 'game') replays.record(snap, snap.game);
    if (hm.phase === 'game') watchInk(snap);
    if (hm.phase === 'game') holdInk(snap);
    if (hm.phase === 'connecting') {
      screen = 'connecting';
      paintConnect(stage, connectModel(snap));
      return;
    }
    if (hm.phase === 'lobby') {
      dropView();
      if (screen !== 'lobby') {
        if (screen === 'game') toTop();
        swap(stage, lobby.el);
        enter(lobby.el);
      }
      screen = 'lobby';
      lobby.update(snap);
      tickTimers(stage, now(), timerHooks);
      return;
    }
    if (hm.phase === 'results') {
      dropView();
      if (screen !== 'results') {
        if (screen === 'game') toTop();
        swap(stage, results.el);
        enter(results.el);
      }
      screen = 'results';
      results.update(snap);
      return;
    }
    const key = `${snap.room.game}:${snap.room.round}`;
    if (key !== viewKey) {
      if (view) view.destroy();
      const make = viewFor(snap.room.game);
      view = make ? make({ engine, fx, toast, win, sfx: sound }) : null;
      viewKey = key;
      swap(gameCard, view ? view.el : h('p', { class: 'waiting', text: 'This game needs a newer version of YapOS Party. Reopen the activity to update.' }));
      roundCard(roundCardModel(snap));
    }
    if (screen !== 'game') {
      swap(stage, gameWrap);
      enter(gameWrap);
    }
    screen = 'game';
    if (view) view.update(snap);
    const pick = predictModel(snap);
    predictUntil = pick ? pick.until : 0;
    const wait = pick ? null : predictWaitModel(snap);
    paintPredict(predictSlot, pick || wait ? { pick, wait } : null);
    paintHostBar(hostSlot, hostBarModel(snap, hostOpen));
    paintSpectate(spectate, spectateModel(snap));
    paintStrip(strip, ownsBoard() ? null : stripModel(snap, viewBoard(snap)));
    const qm = headerModel(snap, { quitArmed: quitArmed() });
    paintQuit(quitSlot, { canLeave: qm.canLeave, armed: qm.quitArmed });
    tickTimers(stage, now(), timerHooks);
  }

  const stopSpot = fx.spotlight(root);
  const offChange = engine.on('change', render);
  const offBoard = boardLink.onReady(() => {
    if (destroyed) return;
    if (screen === 'lobby') lobby.update(engine.snapshot());
    else if (screen === 'results') results.update(engine.snapshot());
    profileCard.scan();
  });
  root.addEventListener('click', onRootClick, true);
  if (typeof win.addEventListener === 'function') win.addEventListener(PROFILES_EVENT, onProfiles);
  unlockTarget().addEventListener('pointerdown', unlockOnce, true);
  unlockTarget().addEventListener('keydown', unlockOnce, true);
  const offFx = typeof engine.on === 'function' ? engine.on('fx', onFx) : null;
  const offInk = typeof engine.on === 'function' ? engine.on('message', hearInk) : null;
  const offSound = sound && typeof sound.on === 'function' ? sound.on('change', repaintHead) : null;
  if (juice && typeof juice === 'object') useJuice(juice);
  else if (juice !== false) import('./juice.js').then(useJuice, () => null);
  const ticker = win.setInterval(() => {
    tickTimers(stage, now(), timerHooks);
    tickAnnounce(now());
    tickShine(now());
    if (screen === 'connecting' || (predictUntil && now() >= predictUntil)) render(engine.snapshot());
  }, 200);
  render(engine.snapshot());

  return {
    render,
    toast,
    panel,
    trolls,
    profileCard,
    signin: gate,
    get renders() {
      return renders;
    },
    destroy() {
      destroyed = true;
      offChange();
      offBoard();
      party.destroy();
      offProfileCard();
      profileCard.destroy();
      root.removeEventListener('click', onRootClick, true);
      offUnlock();
      if (typeof offFx === 'function') offFx();
      if (typeof offInk === 'function') offInk();
      if (typeof offSound === 'function') offSound();
      if (detachJuice) {
        try {
          detachJuice();
        } catch {
          detachJuice = null;
        }
      }
      detachJuice = null;
      juiceMod = null;
      panel.destroy();
      trolls.destroy();
      if (gate) gate.destroy();
      if (warnings) warnings.destroy();
      if (typeof win.removeEventListener === 'function') win.removeEventListener(PROFILES_EVENT, onProfiles);
      if (profileTimer !== null) win.clearTimeout(profileTimer);
      profileTimer = null;
      stopSpot();
      win.clearInterval(ticker);
      for (const id of fxTimers) win.clearTimeout(id);
      fxTimers.clear();
      offFxMode();
      fxMode.destroy();
      if (view) view.destroy();
      fx.destroy();
    },
  };
}
