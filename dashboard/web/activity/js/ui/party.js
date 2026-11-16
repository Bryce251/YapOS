import { h, memo } from './dom.js';
import { REACTIONS, LINE_SHOW_MS, PARTY_SETTINGS } from '../fun.js';
import { fxLevel, sharedLoop } from './fxmode.js';
import { burstFrom } from './juice.js';

export const FLOAT_MAX = 28;
export const LITE_FLOAT_MAX = 10;
export const STILL_FLOAT_MS = 600;
export const CARD_FX_MS = 900;
export const STREAK_MS = 1200;
export const FLOAT_MS = 2600;
export const SPLASH_MS = 2600;
export const HINT_MS = 8000;
export const WIDE_PX = 560;
export const CARD_FAIL = "That card can't be played right now.";
export const LINE_SOUNDS = Object.freeze({ lead: 'turn', swap: 'pop', freeze: 'pop', double: 'pop', peek: 'pop', streak: 'coin', out: 'leave' });

function play(sfx, name) {
  try {
    if (sfx && typeof sfx.play === 'function') sfx.play(name);
  } catch {
    return;
  }
}

export function targetsOf(snap) {
  const fun = snap && snap.fun;
  const frozen = fun && Array.isArray(fun.frozen) ? fun.frozen : [];
  return (snap && Array.isArray(snap.players) ? snap.players : [])
    .filter((p) => p.joined && p.present !== false && !p.isMe && Number.isInteger(p.slot) && !frozen.includes(p.slot))
    .map((p) => ({ slot: p.slot, name: p.name }));
}

export function dockModel(snap, { open = false, cardOpen = false } = {}) {
  if (!snap || !snap.ready || !snap.room) return null;
  const phase = snap.room.phase;
  const party = snap.party || {};
  const fun = phase === 'game' ? snap.fun : null;
  const reactions = Boolean(party.reactions) && (phase === 'lobby' || phase === 'game' || phase === 'results');
  let card = null;
  if (fun && snap.meJoined && party.cards && fun.card) {
    if (!fun.used) {
      card = { id: fun.card.id, emoji: fun.card.emoji, name: fun.card.name, text: fun.card.text, target: fun.card.target, open: Boolean(cardOpen), targets: cardOpen && fun.card.target ? targetsOf(snap) : [] };
    } else if (fun.double) {
      card = { id: 'double', live: true };
    }
  }
  const frozen = Boolean(fun && Number.isInteger(snap.meSlot) && fun.frozen.includes(snap.meSlot));
  const final = Boolean(fun && fun.final && party.final !== false);
  if (!reactions && !card && !frozen && !final) return null;
  return { reactions, open: Boolean(open), card, frozen, final };
}

export function lineModel(snap, now) {
  if (!snap || !snap.ready || !snap.room || snap.room.phase !== 'game') return null;
  const fun = snap.fun;
  const line = fun && fun.line;
  if (!line || !line.text) return null;
  const at = Number(line.at) || 0;
  if (now - at > LINE_SHOW_MS || at - now > LINE_SHOW_MS) return null;
  return { key: `${fun.round}:${line.i}`, text: line.text, kind: line.kind, banner: Boolean(line.banner), until: at + LINE_SHOW_MS };
}

export function splashKey(snap) {
  if (!snap || !snap.ready || !snap.room || snap.room.phase !== 'game') return null;
  const fun = snap.fun;
  return fun && fun.final ? `${fun.round}` : null;
}

export function partyBlock(m, { isHost = false, onToggle = null } = {}) {
  const party = m || {};
  return h(
    'div',
    { class: 'party-extras' },
    h('h3', { class: 'group-title', text: 'Party extras' }),
    h(
      'div',
      { class: 'party-extras-list' },
      PARTY_SETTINGS.map((s) => {
        const on = party[s.id] !== false;
        return h(
          'button',
          {
            class: ['chip', 'party-chip', on ? 'is-on' : null, 'spot'],
            type: 'button',
            disabled: !isHost,
            dataset: { key: `party-${s.id}` },
            attrs: { 'aria-pressed': on ? 'true' : 'false', title: s.title },
            on: { click: () => (onToggle ? onToggle(s.id, !on) : null) },
          },
          h('span', { class: 'party-chip-label', text: s.label }),
          h('span', { class: 'party-chip-state', text: on ? 'On' : 'Off' }),
        );
      }),
    ),
  );
}

export function createBoardLink({ engine, host, loader = null }) {
  let open = null;
  const subs = new Set();
  const ready = () => typeof open === 'function';
  const done = (fn) => {
    open = typeof fn === 'function' ? fn : null;
    for (const cb of [...subs]) {
      try {
        cb(ready());
      } catch {
        continue;
      }
    }
  };
  let wait = null;
  if (typeof loader === 'function') {
    try {
      wait = loader();
    } catch {
      wait = null;
    }
  } else if (loader !== false) {
    wait = import('./leaderboard.js');
  }
  Promise.resolve(wait).then(
    (mod) => done(mod && mod.openLeaderboard),
    () => done(null),
  );
  return {
    ready,
    onReady(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    open() {
      if (!ready()) return false;
      let me = null;
      try {
        me = engine.snapshot().me || null;
      } catch {
        me = null;
      }
      try {
        open(host, { engine, me });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function boardButton(board, key = 'leaderboard') {
  if (!board || typeof board.ready !== 'function' || !board.ready()) return null;
  return h(
    'button',
    { class: ['btn', 'btn-ghost', 'btn-sm', 'btn-board', 'spot'], type: 'button', dataset: { key }, attrs: { title: 'Top party points ever, everywhere' }, on: { click: () => board.open() } },
    h('span', { class: 'btn-label', text: '🏆 Leaderboard' }),
  );
}

export function createParty({ engine, win = globalThis, sfx = null, toast = null }) {
  const lineSlot = h('div', { class: 'party-line-slot', attrs: { 'aria-live': 'polite' } });
  const splashSlot = h('div', { class: 'party-splash-slot', attrs: { 'aria-live': 'assertive' } });
  const floats = h('div', { class: 'react-layer', attrs: { 'aria-hidden': 'true' } });
  const hintSlot = h('div', { class: 'party-hint-slot', attrs: { 'aria-live': 'polite' } });
  const dock = h('div', { class: 'party-dock' });
  const cardFx = h('div', { class: 'card-fx-slot', attrs: { 'aria-hidden': 'true' } });
  const el = h('div', { class: 'party-layer' }, floats, cardFx, lineSlot, splashSlot, hintSlot, dock);
  let streak = { i: -1, n: 0, at: 0 };
  let nextScale = 1;
  let open = (Number(win.innerWidth) || 0) >= WIDE_PX;
  let cardOpen = false;
  let shownLine = null;
  let lineTimer = null;
  let shownSplash = null;
  let splashTimer = null;
  let hintTimer = null;
  let live = 0;
  let last = null;
  let destroyed = false;
  const timers = new Set();

  function later(fn, ms) {
    const id = win.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function cancel(id) {
    if (id === null || id === undefined) return;
    win.clearTimeout(id);
    timers.delete(id);
  }

  function say(text) {
    if (typeof toast === 'function') toast(text);
  }

  function repaint() {
    if (last) update(last);
  }

  function showCardFx(face) {
    if (!face || fxLevel() === 'static') return;
    const box = h('div', { class: 'card-fx' }, h('span', { class: 'card-fx-emoji', text: face.emoji || '🃏' }), h('strong', { class: 'card-fx-name fx-display', text: face.name || '' }));
    cardFx.replaceChildren(box);
    later(() => {
      if (box.parentNode === cardFx) cardFx.replaceChildren();
    }, CARD_FX_MS);
    try {
      burstFrom(box, { count: fxLevel() === 'lite' ? 6 : 10, spread: 90, size: 7 });
    } catch {
      return;
    }
  }

  function playCard(id, target, face = null) {
    let ok = false;
    try {
      ok = Boolean(engine.play(id, target));
    } catch {
      ok = false;
    }
    if (!ok) {
      say(CARD_FAIL);
      play(sfx, 'error');
      return;
    }
    cardOpen = false;
    play(sfx, 'fx');
    showCardFx(face);
    repaint();
  }

  function popButton(i) {
    const btn = dock.querySelector(`[data-key="react-${i}"]`);
    if (!btn || fxLevel() === 'static') return;
    btn.classList.remove('fx-pop');
    sharedLoop().add(() => {
      btn.classList.add('fx-pop');
      return false;
    });
  }

  function sendReact(i) {
    let ok = false;
    try {
      ok = Boolean(engine.react(i));
    } catch {
      ok = false;
    }
    if (ok) {
      const t = Date.now();
      streak = streak.i === i && t - streak.at < STREAK_MS ? { i, n: streak.n + 1, at: t } : { i, n: 1, at: t };
      nextScale = streak.n >= 3 ? 1.4 : streak.n === 2 ? 1.2 : 1;
      popButton(i);
    }
    if (!ok) {
      const btn = dock.querySelector(`[data-key="react-${i}"]`);
      if (btn) {
        btn.classList.remove('is-cool');
        void btn.offsetWidth;
        btn.classList.add('is-cool');
      }
    }
  }

  function cardTray(c) {
    if (c.live) return h('span', { class: 'party-pill is-double', text: '🎯 Next points ×2', attrs: { role: 'status' } });
    const toggle = h(
      'button',
      {
        class: ['chaos-card', c.open ? 'is-open' : null, 'spot'],
        type: 'button',
        dataset: { key: 'chaos-card' },
        attrs: { 'aria-expanded': c.open ? 'true' : 'false', 'aria-label': `Chaos card: ${c.name}`, title: c.text },
        on: {
          click: () => {
            cardOpen = !cardOpen;
            repaint();
          },
        },
      },
      h('span', { class: 'chaos-card-emoji', text: c.emoji, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'chaos-card-name', text: c.name }),
    );
    if (!c.open) return h('div', { class: 'card-tray' }, toggle);
    const actions = c.target
      ? c.targets.length
        ? h(
            'div',
            { class: 'card-targets', attrs: { role: 'group', 'aria-label': 'Pick who to freeze' } },
            c.targets.map((t) =>
              h(
                'button',
                { class: ['chip', 'card-target', 'spot'], type: 'button', dataset: { key: `card-to-${t.slot}` }, on: { click: () => playCard(c.id, t.slot, c) } },
                `${c.emoji} ${t.name}`,
              ),
            ),
          )
        : h('p', { class: 'card-empty', text: 'Nobody to pick right now.' })
      : h('button', { class: ['btn', 'btn-primary', 'btn-sm', 'spot'], type: 'button', dataset: { key: 'card-play' }, on: { click: () => playCard(c.id, null, c) } }, h('span', { class: 'btn-label', text: `Play ${c.name}` }));
    return h(
      'div',
      { class: 'card-tray is-open' },
      toggle,
      h('div', { class: 'card-pop', attrs: { role: 'dialog', 'aria-label': `${c.name} card` } }, h('p', { class: 'card-pop-text', text: c.text }), h('p', { class: 'card-pop-note', text: 'One card per game. Use it wisely!' }), actions),
    );
  }

  function reactBar(on) {
    if (!on) {
      return h(
        'button',
        {
          class: ['react-toggle', 'spot'],
          type: 'button',
          dataset: { key: 'react-open', nojuice: '' },
          attrs: { 'aria-expanded': 'false', 'aria-label': 'Send a reaction', title: 'Reactions' },
          on: {
            click: () => {
              open = true;
              repaint();
            },
          },
        },
        '😀',
      );
    }
    return h(
      'div',
      { class: 'react-bar', attrs: { role: 'group', 'aria-label': 'Reactions' } },
      REACTIONS.map((e, i) =>
        h('button', { class: ['react-btn'], type: 'button', dataset: { key: `react-${i}`, nojuice: '' }, attrs: { 'aria-label': `React ${e}` }, on: { click: () => sendReact(i) } }, e),
      ),
      h(
        'button',
        {
          class: ['react-btn', 'react-close'],
          type: 'button',
          dataset: { key: 'react-close', nojuice: '' },
          attrs: { 'aria-label': 'Hide reactions', 'aria-expanded': 'true' },
          on: {
            click: () => {
              open = false;
              repaint();
            },
          },
        },
        '✕',
      ),
    );
  }

  const paintDock = memo((m) => {
    if (!m) return null;
    return h(
      'div',
      { class: 'party-dock-inner' },
      h(
        'div',
        { class: 'party-dock-left' },
        m.card ? cardTray(m.card) : null,
        m.frozen ? h('span', { class: 'party-pill is-frozen', text: "❄️ You're frozen", attrs: { role: 'status', title: 'Your next turn gets skipped' } }) : null,
        m.final ? h('span', { class: 'party-pill is-final', text: '🎯 Final round ×2' }) : null,
      ),
      h('div', { class: 'party-dock-right' }, m.reactions ? reactBar(m.open) : null),
    );
  });

  function showLine(m) {
    cancel(lineTimer);
    lineTimer = null;
    const box = h('div', { class: ['party-line', m.banner ? 'is-banner' : null, `is-${m.kind}`], attrs: { role: 'status' } }, h('span', { class: 'party-line-text', text: m.text }));
    lineSlot.replaceChildren(box);
    const sound = LINE_SOUNDS[m.kind];
    if (sound) play(sfx, sound);
    lineTimer = later(() => {
      lineTimer = null;
      box.classList.add('is-out');
      later(() => box.remove(), 320);
    }, Math.max(600, LINE_SHOW_MS - 300));
  }

  function showSplash() {
    cancel(splashTimer);
    const box = h(
      'div',
      { class: ['final-splash', 'fx-shine', 'is-shining'], attrs: { role: 'status' } },
      h('span', { class: 'final-splash-kicker fx-screen-in', text: '🎯' }),
      h('strong', { class: 'final-splash-title fx-display is-lit fx-slam', text: 'FINAL ROUND' }),
      h('span', { class: 'final-splash-sub', text: 'Double points' }),
    );
    splashSlot.replaceChildren(box);
    play(sfx, 'start');
    splashTimer = later(() => {
      splashTimer = null;
      splashSlot.replaceChildren();
    }, SPLASH_MS);
  }

  function update(snap) {
    if (destroyed) return false;
    last = snap;
    const m = dockModel(snap, { open, cardOpen });
    if (!m || !m.card || m.card.live) cardOpen = false;
    paintDock(dock, m);
    const now = Number(snap && snap.now) || Date.now();
    const line = lineModel(snap, now);
    if (line && line.key !== shownLine) {
      shownLine = line.key;
      showLine(line);
    }
    if (!snap || !snap.room || snap.room.phase !== 'game') {
      if (lineSlot.childNodes.length) lineSlot.replaceChildren();
      if (splashSlot.childNodes.length) splashSlot.replaceChildren();
    }
    const key = splashKey(snap);
    if (key && key !== shownSplash) {
      shownSplash = key;
      showSplash();
    }
    return Boolean(m);
  }

  function onReact(ev) {
    const level = fxLevel();
    if (destroyed || !ev || typeof ev.emoji !== 'string' || live >= (level === 'lite' ? LITE_FLOAT_MAX : FLOAT_MAX)) return;
    const bit = h(
      'span',
      { class: ['react-float', ev.mine ? 'is-mine' : null] },
      h('span', { class: 'react-float-emoji', text: ev.emoji }),
      h('span', { class: 'react-float-name', text: ev.mine ? 'You' : String(ev.name || '').slice(0, 14) }),
    );
    const r = Math.random;
    bit.style.setProperty('--x', `${Math.round(6 + r() * 78)}%`);
    bit.style.setProperty('--drift', `${Math.round((r() - 0.5) * 80)}px`);
    bit.style.setProperty('--tilt', `${Math.round((r() - 0.5) * 30)}deg`);
    bit.style.setProperty('--dur', `${level === 'static' ? STILL_FLOAT_MS : Math.round(FLOAT_MS * (0.85 + r() * 0.3))}ms`);
    if (ev.mine && nextScale > 1) bit.style.setProperty('--s', String(nextScale));
    if (ev.mine) nextScale = 1;
    live += 1;
    floats.append(bit);
    let gone = false;
    const end = () => {
      if (gone) return;
      gone = true;
      live = Math.max(0, live - 1);
      bit.remove();
    };
    bit.addEventListener('animationend', end);
    later(end, FLOAT_MS + 600);
  }

  function onHint(ev) {
    if (destroyed || !ev || typeof ev.text !== 'string' || !ev.text) return;
    cancel(hintTimer);
    const close = h('button', { class: ['party-hint-close'], type: 'button', dataset: { key: 'hint-close' }, attrs: { 'aria-label': 'Close hint' }, on: { click: () => hintSlot.replaceChildren() } }, '✕');
    hintSlot.replaceChildren(
      h('div', { class: 'party-hint', attrs: { role: 'status' } }, h('span', { class: 'party-hint-kicker', text: '👀 Only you can see this' }), h('span', { class: 'party-hint-text', text: ev.text }), close),
    );
    play(sfx, 'reveal');
    hintTimer = later(() => {
      hintTimer = null;
      hintSlot.replaceChildren();
    }, HINT_MS);
  }

  function onNo(ev) {
    if (!ev || typeof ev.text !== 'string' || !ev.text) return;
    say(ev.text);
    play(sfx, 'error');
  }

  const offs = [];
  if (engine && typeof engine.on === 'function') {
    offs.push(engine.on('react', onReact), engine.on('hint', onHint), engine.on('cardno', onNo));
  }

  return {
    el,
    update,
    get floats() {
      return live;
    },
    destroy() {
      destroyed = true;
      for (const off of offs) if (typeof off === 'function') off();
      for (const id of [...timers]) win.clearTimeout(id);
      timers.clear();
    },
  };
}
