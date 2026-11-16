import { h, profileButton, swap } from './dom.js';
import { GRID_W, GRID_H, createPainter } from '../games/ink.js';
import { canvasesOf } from '../games/replaylog.js';
import draw from '../games/draw.js';
import { KEY as ODD_KEY } from '../games/odd.js';
import { KEY as TEL_KEY, seatInk as telInk, chainAt, drawingId as telId, entryKey, entryInk } from '../games/telephone.js';
import { KEY as DUEL_KEY, seatInk as duelInk, drawingId as duelId } from '../games/sketchduel.js';
import { KEY as PIXEL_KEY, SIZE as PIXEL_SIZE, PALETTE, EMPTY, readGrid, drawingId as pixelId } from '../games/pixel.js';
import { decodeInk } from './replay.js';

export const HOLD_KEEP = 24;
export const HOLD_SCALE = 0.3;
export const HOLD_TAG = 'Hidden after a report';
export const HOLD_MOD = 'Hidden for others';
export const HOLD_TITLE_MOD = 'Hidden for others';
export const HOLD_TITLE_MINE = 'Your drawing was hidden';
export const HOLD_NOTE_MOD = 'Players see a blank page. Only Party mods can see these.';
export const HOLD_NOTE_MINE = 'Someone reported it, so it is hidden for everyone else. Only you and Party mods can see it.';
export const HOLD_GAMES = Object.freeze(['draw', 'odd', 'telephone', 'sketchduel', 'pixel']);

function stateOf(snap, key) {
  return snap && snap.state && snap.state[key] && typeof snap.state[key] === 'object' ? snap.state[key] : null;
}

function inkList(list) {
  return (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s);
}

function oddDrawings(snap) {
  const st = stateOf(snap, ODD_KEY);
  if (!st || !Number.isInteger(st.k)) return [];
  const c = canvasesOf(snap).find((x) => x.game === 'odd');
  if (!c) return [];
  const by = new Map();
  for (const x of c.items) {
    if (!Number.isInteger(x.slot) || x.slot < 0) continue;
    if (!by.has(x.slot)) by.set(x.slot, []);
    by.get(x.slot).push(x.s);
  }
  return [...by.entries()].map(([slot, ink]) => ({ d: `odd.${st.k}.${slot}`, drawer: slot, ink }));
}

function telDrawings(snap) {
  const st = stateOf(snap, TEL_KEY);
  if (!st || !Array.isArray(st.seats) || !st.seats.length) return [];
  const n = st.seats.length;
  const out = [];
  if (st.phase === 'text' && st.step > 0 && Array.isArray(st.dby)) {
    for (let q = 0; q < n; q += 1) {
      const ink = inkList(telInk(snap.state, q, st.dk).s);
      if (ink.length && Number.isInteger(st.dby[q])) out.push({ d: telId(st.run, chainAt(q, st.step - 1, n), st.step - 1), drawer: st.dby[q], ink });
    }
  }
  if (st.phase === 'reveal' && st.rv) {
    for (let i = 0; i <= st.rv.at; i += 1) {
      const e = snap.state[entryKey(i)];
      if (!e || e.c !== st.rv.c || e.i !== i || e.k !== 'd' || e.hid) continue;
      const ink = inkList(entryInk(snap.state, i));
      if (ink.length && Number.isInteger(e.by)) out.push({ d: telId(st.run, e.c, i), drawer: e.by, ink });
    }
  }
  return out;
}

function duelDrawings(snap) {
  const st = stateOf(snap, DUEL_KEY);
  if (!st || (st.phase !== 'vote' && st.phase !== 'result') || !Array.isArray(st.duels) || !Array.isArray(st.seats)) return [];
  const duel = st.duels[st.d];
  if (!Array.isArray(duel)) return [];
  const out = [];
  for (const seat of [duel[0], duel[1]]) {
    if (!Number.isInteger(seat)) continue;
    const ink = inkList(duelInk(snap.state, seat, st.k).s);
    if (ink.length && Number.isInteger(st.seats[seat])) out.push({ d: duelId(st.run, st.round, seat), drawer: st.seats[seat], ink });
  }
  return out;
}

function pixelDrawings(snap) {
  const st = stateOf(snap, PIXEL_KEY);
  if (!st || !Number.isInteger(st.n) || (st.phase !== 'paint' && st.phase !== 'cheer')) return [];
  const grid = readGrid((k) => snap.state[k]);
  if (!grid || !/[^0]/.test(grid)) return [];
  return [{ d: pixelId(st), drawer: -1, grid }];
}

export function visibleDrawings(snap) {
  const game = snap && snap.room ? snap.room.game : null;
  try {
    if (game === 'draw') {
      const item = draw.drawingOf(snap);
      const ink = item ? inkList(item.ink) : [];
      return ink.length ? [{ d: item.d, drawer: item.drawer, ink }] : [];
    }
    if (game === 'odd') return oddDrawings(snap);
    if (game === 'telephone') return telDrawings(snap);
    if (game === 'sketchduel') return duelDrawings(snap);
    if (game === 'pixel') return pixelDrawings(snap);
  } catch {
    return [];
  }
  return [];
}

export function hiddenIds(snap) {
  const game = snap && snap.room ? snap.room.game : null;
  const out = new Set();
  try {
    if (game === 'draw') {
      for (const d of draw.hiddenDrawings(snap) || []) out.add(d);
    } else if (game === 'odd') {
      const st = stateOf(snap, ODD_KEY);
      if (st && Number.isInteger(st.k) && Array.isArray(st.hid)) for (const s of st.hid) if (Number.isInteger(s)) out.add(`odd.${st.k}.${s}`);
    } else if (game === 'telephone' || game === 'sketchduel') {
      const st = stateOf(snap, game === 'telephone' ? TEL_KEY : DUEL_KEY);
      if (st && Array.isArray(st.hid)) for (const d of st.hid) if (typeof d === 'string') out.add(d);
      if (game === 'telephone' && st && st.phase === 'reveal' && st.rv) {
        for (let i = 0; i <= st.rv.at; i += 1) {
          const e = snap.state[entryKey(i)];
          if (e && e.c === st.rv.c && e.i === i && e.k === 'd' && e.hid) out.add(telId(st.run, e.c, i));
        }
      }
    } else if (game === 'pixel') {
      const st = stateOf(snap, PIXEL_KEY);
      const w = st && Number.isInteger(st.w) ? st.w : 0;
      if (st && Number.isInteger(st.n)) for (let j = 0; j < w; j += 1) out.add(`pixel-${st.n}-${j}`);
    }
  } catch {
    return out;
  }
  return out;
}

function inkSig(ink) {
  const last = ink.length ? ink[ink.length - 1] : '';
  return `${ink.length}:${ink[0] ? ink[0].length : 0}:${last.length}:${last.slice(-12)}`;
}

export function createHold({ keep = HOLD_KEEP } = {}) {
  let round = null;
  const items = new Map();

  function prune(hid) {
    while (items.size > keep) {
      let drop = null;
      for (const k of items.keys()) {
        if (!hid.has(k)) {
          drop = k;
          break;
        }
      }
      items.delete(drop === null ? items.keys().next().value : drop);
    }
  }

  function observe(snap) {
    const room = snap && snap.room;
    if (!room || room.phase !== 'game' || !HOLD_GAMES.includes(room.game)) return false;
    const key = `${room.game}:${room.round}`;
    if (key !== round) {
      round = key;
      items.clear();
    }
    const hid = hiddenIds(snap);
    let changed = false;
    for (const x of visibleDrawings(snap)) {
      if (hid.has(x.d)) continue;
      const prev = items.get(x.d);
      const size = x.grid ? x.grid : inkSig(x.ink);
      if (prev && prev.size === size) continue;
      items.delete(x.d);
      items.set(x.d, { d: x.d, drawer: x.drawer, ink: x.ink ? x.ink.slice() : null, grid: x.grid || null, size, game: room.game });
      changed = true;
    }
    prune(hid);
    return changed;
  }

  function held(snap) {
    const room = snap && snap.room;
    const none = { mod: false, list: [] };
    if (!room || room.phase !== 'game' || `${room.game}:${room.round}` !== round) return none;
    const players = Array.isArray(snap.players) ? snap.players : [];
    const me = players.find((p) => p.isMe) || null;
    if (!me) return none;
    const mod = Boolean(me.isAdmin);
    const hid = hiddenIds(snap);
    const out = [];
    for (const x of items.values()) {
      if (!hid.has(x.d)) continue;
      const mine = Number.isInteger(me.slot) && x.drawer === me.slot;
      if (!mod && !mine) continue;
      const p = players.find((q) => Number.isInteger(x.drawer) && q.slot === x.drawer) || null;
      out.push({ d: x.d, game: x.game, ink: x.ink, grid: x.grid, mine, drawer: p ? { id: p.id, name: p.name, initials: p.initials, hue: p.hue, avatar: p.avatar || null, isMe: Boolean(p.isMe) } : null });
    }
    return { mod, list: out };
  }

  return {
    observe,
    held,
    clear() {
      round = null;
      items.clear();
    },
    get size() {
      return items.size;
    },
  };
}

const PIXEL_HEX = new Map(PALETTE.map((p) => [p.code, p.hex]));

function thumbCanvas(item) {
  const scale = HOLD_SCALE;
  const w = item.grid ? PIXEL_SIZE * 4 : Math.round(GRID_W * scale);
  const ht = item.grid ? PIXEL_SIZE * 4 : Math.round(GRID_H * scale);
  const c = h('canvas', { class: 'modhold-canvas', attrs: { width: w, height: ht, role: 'img', 'aria-label': item.drawer ? `Hidden drawing by ${item.drawer.name}` : 'Hidden picture' } });
  const ctx = typeof c.getContext === 'function' ? c.getContext('2d') : null;
  if (!ctx) return c;
  try {
    if (item.grid) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, ht);
      for (let i = 0; i < item.grid.length; i += 1) {
        const code = item.grid[i];
        if (code === EMPTY || !PIXEL_HEX.has(code)) continue;
        ctx.fillStyle = PIXEL_HEX.get(code);
        ctx.fillRect((i % PIXEL_SIZE) * 4, Math.floor(i / PIXEL_SIZE) * 4, 4, 4);
      }
    } else {
      createPainter(scale, 0).paint(ctx, decodeInk(item.ink));
    }
  } catch {
    return c;
  }
  return c;
}

export function holdSig(model) {
  if (!model || !model.list || !model.list.length) return '';
  return `${model.mod ? 1 : 0}|${model.list.map((x) => `${x.d}:${x.grid ? x.grid.length : x.ink.length}:${x.drawer ? x.drawer.name : ''}`).join(',')}`;
}

export function holdCard(model) {
  if (!model || !model.list || !model.list.length) return null;
  const onlyMine = !model.mod;
  return h(
    'section',
    { class: ['card', 'modhold', onlyMine ? 'is-mine' : 'is-mod'], attrs: { 'aria-label': onlyMine ? HOLD_TITLE_MINE : HOLD_TITLE_MOD } },
    h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'card-icon', text: onlyMine ? '🙈' : '🛡️', attrs: { 'aria-hidden': 'true' } }),
      h('h3', { class: 'card-title', text: onlyMine ? HOLD_TITLE_MINE : HOLD_TITLE_MOD }),
      h('span', { class: 'count-pill', text: String(model.list.length) }),
    ),
    h('p', { class: 'modhold-note muted', text: onlyMine ? HOLD_NOTE_MINE : HOLD_NOTE_MOD }),
    h(
      'ul',
      { class: 'modhold-list' },
      model.list.map((x) =>
        h(
          'li',
          { class: 'modhold-item', dataset: { drawing: x.d } },
          h('div', { class: 'paper modhold-paper' }, thumbCanvas(x), h('span', { class: 'modhold-badge', text: HOLD_MOD })),
          x.drawer
            ? h('span', { class: 'modhold-by' }, profileButton(x.drawer, 'xs'), h('span', { class: 'modhold-name', text: x.drawer.isMe ? 'You' : x.drawer.name }))
            : h('span', { class: 'modhold-by' }, h('span', { class: 'modhold-name', text: 'Group picture' })),
        ),
      ),
    ),
  );
}

export function createModTray({ hold = createHold() } = {}) {
  const el = h('div', { class: 'modhold-slot' });
  let sig = '';
  return {
    el,
    hold,
    update(snap) {
      hold.observe(snap);
      const model = hold.held(snap);
      const next = holdSig(model);
      if (next === sig) return false;
      sig = next;
      swap(el, holdCard(model));
      return true;
    },
    clear() {
      hold.clear();
      sig = '';
      swap(el);
    },
  };
}
