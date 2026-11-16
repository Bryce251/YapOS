import { shuffle } from '../engine.js';

export const KEY = 'pixel';
export const PREFIX = 'pixel.';
export const COUNTS = 'pixel.k';
export const SIZE = 24;
export const CELLS = SIZE * SIZE;
export const BANDS = 4;
export const BAND_ROWS = SIZE / BANDS;
export const BAND_CELLS = BAND_ROWS * SIZE;
export const MAX_BATCH = 64;
export const CHEER_MS = 15000;
export const SHOW_MS = 6000;
export const PAINT_POINT = 2;
export const PAINT_CAP = 200;
export const CHEER_POINTS = 25;
export const MIN_CELLS = 5;
export const EMPTY = '0';
export const CODES = '0123456789abc';
export const PALETTE = Object.freeze([
  Object.freeze({ code: '1', name: 'Black', hex: '#1c1c22' }),
  Object.freeze({ code: '2', name: 'White', hex: '#f8fafc' }),
  Object.freeze({ code: '3', name: 'Gray', hex: '#8d8d97' }),
  Object.freeze({ code: '4', name: 'Red', hex: '#ef4444' }),
  Object.freeze({ code: '5', name: 'Orange', hex: '#f97316' }),
  Object.freeze({ code: '6', name: 'Yellow', hex: '#facc15' }),
  Object.freeze({ code: '7', name: 'Green', hex: '#22c55e' }),
  Object.freeze({ code: '8', name: 'Teal', hex: '#14b8a6' }),
  Object.freeze({ code: '9', name: 'Blue', hex: '#3b82f6' }),
  Object.freeze({ code: 'a', name: 'Purple', hex: '#8b5cf6' }),
  Object.freeze({ code: 'b', name: 'Pink', hex: '#f472b6' }),
  Object.freeze({ code: 'c', name: 'Brown', hex: '#92400e' }),
]);

export const THEMES = Object.freeze([
  'a cozy house',
  'a happy sun',
  'a pizza slice',
  'a rocket ship',
  'a cute cat',
  'a rainbow',
  'an ice cream cone',
  'a smiling frog',
  'a treasure chest',
  'a sailboat at sea',
  'a mushroom house',
  'a heart with wings',
  'a space alien',
  'a snowman',
  'a cactus in a pot',
  'a birthday cake',
  'a fish in a bowl',
  'a castle',
  'a dragon',
  'a robot friend',
  'a tree in autumn',
  'a night sky with a moon',
  'a hot air balloon',
  'a burger',
  'a tiny dinosaur',
  'a game controller',
  'a sleepy panda',
  'a beach day',
  'a flower garden',
  'a ghost saying hi',
  'a cup of hot cocoa',
  'a penguin',
  'a volcano',
  'a race car',
  'a giant donut',
  'a crown',
  'a city skyline',
  'a lighthouse',
  'a slice of watermelon',
  'a magic potion',
  'a sushi roll',
  'a superhero mask',
]);

export function bandKey(b) {
  return `${PREFIX}${b}`;
}

export function blankBand() {
  return EMPTY.repeat(BAND_CELLS);
}

export function validBand(v) {
  return typeof v === 'string' && v.length === BAND_CELLS && /^[0-9a-c]+$/.test(v);
}

export function readGrid(read) {
  let out = '';
  for (let b = 0; b < BANDS; b += 1) {
    const v = read(bandKey(b));
    out += validBand(v) ? v : blankBand();
  }
  return out;
}

export function encodeCells(list) {
  return list
    .filter(([i, c]) => Number.isInteger(i) && i >= 0 && i < CELLS && typeof c === 'string' && c.length === 1 && CODES.includes(c))
    .map(([i, c]) => `${i.toString(36).padStart(2, '0')}${c}`)
    .join('');
}

export function decodeCells(text) {
  if (typeof text !== 'string' || !text || text.length % 3 !== 0 || text.length > MAX_BATCH * 3) return null;
  if (!/^(?:[0-9a-z]{2}[0-9a-c])+$/.test(text)) return null;
  const out = [];
  for (let k = 0; k < text.length; k += 3) {
    const i = parseInt(text.slice(k, k + 2), 36);
    if (i >= CELLS) return null;
    out.push([i, text[k + 2]]);
  }
  return out;
}

export function filled(grid) {
  let n = 0;
  for (const ch of String(grid || '')) if (ch !== EMPTY) n += 1;
  return n;
}

export function buildDeck(count, random = Math.random) {
  const order = shuffle(THEMES.map((_, i) => i), random);
  return order.slice(0, Math.max(1, count));
}

export function award(counts, cheers) {
  const gained = {};
  const c = Math.max(0, Math.floor(cheers) || 0);
  for (const [slot, n] of Object.entries(counts || {})) {
    if (!Number.isInteger(n) || n < MIN_CELLS) continue;
    gained[slot] = Math.min(PAINT_CAP, n * PAINT_POINT) + c * CHEER_POINTS;
  }
  return gained;
}

export function minutes(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function drawingId(st) {
  return `pixel-${st.n}-${st.w || 0}`;
}

function clearGrid(api) {
  for (let b = 0; b < BANDS; b += 1) api.put(bandKey(b), null);
  api.put(COUNTS, null);
}

function begin(api, deck, i, note) {
  const theme = THEMES[deck[i]];
  if (theme === undefined) return next(api, deck, i);
  clearGrid(api);
  const prev = api.get(KEY);
  const starts = api.now();
  const ends = starts + api.settings.timer * 1000;
  api.put(KEY, {
    v: 1,
    deck,
    i,
    total: deck.length,
    n: (prev && prev.n ? prev.n : 0) + 1,
    w: 0,
    phase: 'paint',
    theme,
    cheers: [],
    gained: {},
    note: note || null,
    starts,
    ends,
  });
  api.setDeadline(ends);
  return undefined;
}

function next(api, deck, i) {
  if (i + 1 < deck.length && api.players().length) return begin(api, deck, i + 1);
  clearGrid(api);
  return api.finish();
}

function toCheer(api, st) {
  const starts = api.now();
  const ends = starts + CHEER_MS;
  api.put(KEY, { ...st, phase: 'cheer', note: st.note === 'wiped' ? 'wiped' : null, starts, ends });
  api.setDeadline(ends);
}

function toShow(api, st) {
  const counts = api.get(COUNTS) || {};
  const gained = award(counts, st.cheers.length);
  for (const [slot, pts] of Object.entries(gained)) api.addPoints(Number(slot), pts);
  const starts = api.now();
  const ends = starts + SHOW_MS;
  api.put(KEY, { ...st, phase: 'show', gained, starts, ends });
  api.setDeadline(ends);
}

function wipe(api, st) {
  clearGrid(api);
  api.put(KEY, { ...st, w: (st.w || 0) + 1, note: 'wiped' });
  return true;
}

function onPaint(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'paint' || action.n !== st.n) return;
  const cells = decodeCells(action.c);
  if (!cells) return;
  const bands = new Map();
  let changed = 0;
  for (const [i, c] of cells) {
    const b = Math.floor(i / BAND_CELLS);
    if (!bands.has(b)) {
      const v = api.get(bandKey(b));
      bands.set(b, (validBand(v) ? v : blankBand()).split(''));
    }
    const arr = bands.get(b);
    const at = i - b * BAND_CELLS;
    if (arr[at] === c) continue;
    arr[at] = c;
    changed += 1;
  }
  if (!changed) return;
  for (const [b, arr] of bands) {
    const v = arr.join('');
    api.put(bandKey(b), v === blankBand() ? null : v);
  }
  const counts = api.get(COUNTS) || {};
  counts[slot] = (Number.isInteger(counts[slot]) ? counts[slot] : 0) + changed;
  api.put(COUNTS, counts);
}

function onCheer(api, slot, action) {
  const st = api.get(KEY);
  if (!st || st.phase !== 'cheer' || action.n !== st.n) return;
  if (st.cheers.includes(slot) || !api.players().some((p) => p.slot === slot)) return;
  api.put(KEY, { ...st, cheers: st.cheers.concat([slot]) });
}

const pixel = {
  id: 'pixel',
  name: 'Pixel Art',
  emoji: '🟪',
  category: 'drawing',
  blurb: 'Paint one big pixel picture together, all at once. Then cheer for what you made.',
  minPlayers: 1,
  keys: [KEY],
  prefixes: [PREFIX],
  settings: [
    { id: 'rounds', label: 'Pictures', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 1 },
    { id: 'timer', label: 'Time to paint', type: 'choice', options: [120, 150, 180].map((v) => ({ value: v, label: minutes(v) })), default: 150 },
  ],

  start(api) {
    begin(api, buildDeck(api.settings.rounds, api.random), 0);
  },

  intent(api, slot, action) {
    if (action.type === 'paint') onPaint(api, slot, action);
    else if (action.type === 'cheer') onCheer(api, slot, action);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st) return api.finish();
    if (st.phase === 'paint') return toCheer(api, st);
    if (st.phase === 'cheer') return toShow(api, st);
    return next(api, st.deck, st.i);
  },

  drawings(api) {
    const st = api.get(KEY);
    if (!st || (st.phase !== 'paint' && st.phase !== 'cheer')) return [];
    if (!filled(readGrid((k) => api.get(k)))) return [];
    return [{ d: drawingId(st), drawer: -1 }];
  },

  drawingOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    if (!st || (st.phase !== 'paint' && st.phase !== 'cheer')) return null;
    return { d: drawingId(st), drawer: -1 };
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st) return false;
    if (action.type === 'hideDrawing') {
      if (st.phase !== 'paint' && st.phase !== 'cheer') return false;
      if (action.d && action.d !== drawingId(st)) return false;
      return wipe(api, st);
    }
    if (action.type === 'skip') {
      pixel.deadline(api);
      return true;
    }
    if (action.type === 'time') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st) return pixel.start(api);
    if (api.deadline === null) api.setDeadline(api.now());
    return undefined;
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st) return null;
    const mine = snap.meSlot;
    const grid = readGrid((k) => snap.state[k]);
    const counts = snap.state[COUNTS] && typeof snap.state[COUNTS] === 'object' ? snap.state[COUNTS] : {};
    const joined = Boolean(snap.meJoined) && Number.isInteger(mine);
    const painters = Object.values(counts).filter((n) => Number.isInteger(n) && n > 0).length;
    return {
      phase: st.phase,
      n: st.n,
      w: st.w || 0,
      d: drawingId(st),
      number: st.i + 1,
      total: st.total,
      theme: st.theme,
      starts: st.starts,
      ends: st.ends,
      note: st.note,
      grid,
      filled: filled(grid),
      painters,
      myCells: joined ? counts[mine] || 0 : 0,
      canPaint: st.phase === 'paint' && joined,
      canCheer: st.phase === 'cheer' && joined && !st.cheers.includes(mine) && filled(grid) > 0,
      cheered: joined && st.cheers.includes(mine),
      cheers: st.cheers.length,
      myGain: joined && st.gained ? st.gained[mine] || 0 : 0,
      watching: !joined,
    };
  },
};

export default pixel;
