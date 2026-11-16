import { h, button } from './dom.js';
import { GRID_W, GRID_H, decodeStroke, isFill, createPainter } from '../games/ink.js';

export const REPLAY_KEEP = 24;
export const REPLAY_CHARS = 16000;
export const REPLAY_MS = 4000;
export const REPLAY_TICK_MS = 33;
export const THUMB_SCALE = 0.3;
export const BIG_SCALE = 1;
export const REPLAY_GAMES = Object.freeze(['draw', 'telephone']);

function cleanInk(list) {
  const out = [];
  let chars = 0;
  for (const s of Array.isArray(list) ? list : []) {
    if (typeof s !== 'string' || !s) continue;
    if (chars + s.length > REPLAY_CHARS) break;
    out.push(s);
    chars += s.length;
  }
  return out;
}

export function createRecorder(keep = REPLAY_KEEP) {
  let round = null;
  let game = null;
  const items = new Map();
  const gone = new Set();

  function reset(r, g) {
    round = r;
    game = g;
    items.clear();
    gone.clear();
  }

  return {
    record(snap, def) {
      if (!snap || !snap.ready || !snap.room || snap.room.phase !== 'game' || !def || !def.replays) return false;
      const r = snap.room.round;
      if (r !== round || def.id !== game) reset(r, def.id);
      let changed = false;
      if (typeof def.hiddenDrawings === 'function') {
        let hid = [];
        try {
          hid = def.hiddenDrawings(snap) || [];
        } catch {
          hid = [];
        }
        for (const d of hid) {
          if (typeof d !== 'string') continue;
          gone.add(d);
          if (items.delete(d)) changed = true;
        }
      }
      if (typeof def.drawingOf !== 'function') return changed;
      let got = null;
      try {
        got = def.drawingOf(snap);
      } catch {
        got = null;
      }
      if (!got || typeof got.d !== 'string' || gone.has(got.d)) return changed;
      const ink = cleanInk(got.ink);
      if (!ink.length) return changed;
      const drawer = (snap.players || []).find((p) => p.slot === got.drawer) || null;
      const prev = items.get(got.d);
      const word = typeof got.word === 'string' && got.word ? got.word.slice(0, 80) : prev ? prev.word : null;
      const next = { d: got.d, ink, word, drawer: drawer ? drawer.name : prev ? prev.drawer : 'Player', hue: drawer ? drawer.hue : prev ? prev.hue : 20 };
      if (prev && prev.ink.join('|') === ink.join('|') && prev.word === next.word) return changed;
      if (prev) items.delete(got.d);
      items.set(got.d, next);
      while (items.size > keep) items.delete(items.keys().next().value);
      return true;
    },
    list(r, g) {
      if (r !== round || g !== game) return [];
      return [...items.values()].map((x) => ({ ...x, ink: x.ink.slice() }));
    },
    get size() {
      return items.size;
    },
    clear() {
      reset(null, null);
    },
  };
}

export function decodeInk(ink) {
  return (Array.isArray(ink) ? ink : []).map(decodeStroke).filter((s) => s && s.pts && s.pts.length);
}

export function inkLength(strokes) {
  return strokes.reduce((a, s) => a + (isFill(s) ? 1 : Math.max(1, s.pts.length)), 0);
}

export function partialAt(strokes, t) {
  const list = Array.isArray(strokes) ? strokes : [];
  const total = inkLength(list);
  if (!total) return [];
  const want = Math.max(0, Math.min(1, Number(t) || 0)) * total;
  const out = [];
  let used = 0;
  for (const s of list) {
    const size = isFill(s) ? 1 : Math.max(1, s.pts.length);
    if (used + size <= want) {
      out.push(s);
      used += size;
      continue;
    }
    const left = Math.floor(want - used);
    if (!isFill(s) && left >= 1) out.push({ ...s, pts: s.pts.slice(0, left) });
    break;
  }
  return out;
}

function canvasOf(scale, label) {
  const c = h('canvas', { class: 'replay-canvas', attrs: { width: Math.round(GRID_W * scale), height: Math.round(GRID_H * scale), role: 'img', 'aria-label': label } });
  const ctx = typeof c.getContext === 'function' ? c.getContext('2d', { willReadFrequently: true }) : null;
  return { c, ctx };
}

function labelOf(item) {
  return item.word ? `${item.drawer} drew ${item.word}` : `Drawing by ${item.drawer}`;
}

export function createReplayStrip({ win = globalThis, now = () => Date.now() } = {}) {
  const el = h('div', { class: 'replay', attrs: { 'aria-label': 'Replays' } });
  let items = [];
  let sig = '';
  let playing = null;
  let open = -1;

  function stop() {
    if (playing && playing.t !== null) win.clearTimeout(playing.t);
    playing = null;
  }

  function play(i) {
    stop();
    open = i;
    const item = items[i];
    if (!item) return paint();
    paint();
    const stage = el.querySelector('.replay-stage');
    const { c, ctx } = canvasOf(BIG_SCALE, labelOf(item));
    if (stage) stage.replaceChildren(c);
    const strokes = decodeInk(item.ink);
    const painter = createPainter(BIG_SCALE);
    const started = now();
    const run = { t: null };
    playing = run;
    const step = () => {
      if (playing !== run) return;
      const t = Math.min(1, (now() - started) / REPLAY_MS);
      if (ctx) painter.paint(ctx, partialAt(strokes, t));
      if (t >= 1) {
        run.t = null;
        playing = null;
        el.classList.remove('is-playing');
        return;
      }
      run.t = win.setTimeout(step, REPLAY_TICK_MS);
    };
    el.classList.add('is-playing');
    step();
  }

  function thumb(item, i) {
    const { c, ctx } = canvasOf(THUMB_SCALE, labelOf(item));
    if (ctx) createPainter(THUMB_SCALE, 0).paint(ctx, decodeInk(item.ink));
    return h(
      'button',
      {
        class: ['replay-thumb', 'spot', i === open ? 'is-on' : null],
        type: 'button',
        dataset: { key: `replay-${i}` },
        vars: { '--hue': item.hue },
        attrs: { 'aria-label': `Watch ${labelOf(item)}`, 'aria-pressed': i === open ? 'true' : 'false' },
        on: { click: () => play(i) },
      },
      c,
      h('span', { class: 'replay-name', text: item.word || item.drawer }),
      item.word ? h('span', { class: 'replay-by', text: item.drawer }) : null,
    );
  }

  function paint() {
    if (!items.length) {
      el.replaceChildren();
      return;
    }
    const item = items[open] || null;
    const kids = [
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title', text: 'Replays' }), h('span', { class: 'count-pill', text: `${items.length} drawing${items.length === 1 ? '' : 's'}` })),
      h('p', { class: 'replay-hint muted', text: 'Tap a drawing to watch it being made.' }),
      h('div', { class: 'replay-strip', attrs: { role: 'list' } }, items.map((x, i) => thumb(x, i))),
      item
        ? h(
            'div',
            { class: 'replay-big' },
            h('div', { class: 'replay-stage paper' }),
            h('div', { class: 'replay-bar' }, h('span', { class: 'replay-title', text: labelOf(item) }), button('Watch again', { variant: 'ghost', size: 'sm', key: 'replay-again', on: () => play(open) }), button('Close', { variant: 'ghost', size: 'sm', key: 'replay-close', on: close })),
          )
        : null,
    ].filter(Boolean);
    el.replaceChildren(...kids);
  }

  function close() {
    stop();
    open = -1;
    el.classList.remove('is-playing');
    paint();
  }

  return {
    el,
    show(list) {
      const next = Array.isArray(list) ? list : [];
      const s = next.map((x) => `${x.d}:${x.ink.length}`).join(',');
      if (s === sig) return;
      sig = s;
      items = next;
      stop();
      open = -1;
      paint();
    },
    play,
    close,
    get count() {
      return items.length;
    },
    get playing() {
      return Boolean(playing);
    },
    destroy() {
      stop();
    },
  };
}
