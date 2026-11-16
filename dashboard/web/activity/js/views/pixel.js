import pixel, { SIZE, CELLS, PALETTE, EMPTY, MAX_BATCH, encodeCells } from '../games/pixel.js';
import { h, memo, timer, button, plural } from '../ui/dom.js';
import { flagModel, flagLabel, FLAG_ICON } from './draw.js';

const QUIET = { play() {}, burst() {}, float() {} };
export const PAINT_MS = 250;
export const OVERLAY_MS = 4000;
export const FLAG_HELP = 'Flag this picture if it breaks the rules. If half the players flag it, the canvas gets wiped.';
export const FLAG_SENT = 'Thanks for flagging. If half the players agree, the canvas gets wiped.';
export const FLAG_FAIL = "That didn't go through. Try again in a moment.";
export const ERASER = EMPTY;

export function cellFromPoint(rect, x, y) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const col = Math.floor(((x - rect.left) / rect.width) * SIZE);
  const row = Math.floor(((y - rect.top) / rect.height) * SIZE);
  if (col < 0 || row < 0 || col >= SIZE || row >= SIZE) return null;
  return row * SIZE + col;
}

export function lineCells(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return Number.isInteger(to) ? [to] : [];
  let x0 = from % SIZE;
  let y0 = Math.floor(from / SIZE);
  const x1 = to % SIZE;
  const y1 = Math.floor(to / SIZE);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out = [];
  for (let guard = 0; guard < SIZE * 2 + 2; guard += 1) {
    out.push(y0 * SIZE + x0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

export function footText(m) {
  if (!m) return '';
  if (m.phase === 'paint') {
    if (m.watching) return 'Join the game to paint along.';
    const mine = m.myCells ? `You painted ${plural(m.myCells, 'pixel', 'pixels')}.` : 'Tap or drag on the canvas to paint.';
    return `${mine} ${plural(m.painters, 'painter', 'painters')} so far.`;
  }
  if (m.phase === 'cheer') {
    if (!m.filled) return 'The canvas is empty this time.';
    if (m.cheered) return `Cheer sent! ${plural(m.cheers, 'cheer', 'cheers')} so far.`;
    return `Do you like it? ${plural(m.cheers, 'cheer', 'cheers')} so far.`;
  }
  if (m.myGain) return `${plural(m.cheers, 'cheer', 'cheers')} for this one! +${m.myGain} for your painting.`;
  return `${plural(m.cheers, 'cheer', 'cheers')} for this one!`;
}

export function pixelMoment(was, m) {
  const now = { n: m.n, w: m.w, phase: m.phase };
  if (!was) return { now, cues: [] };
  if (was.n === m.n && was.w !== m.w) return { now, cues: ['whoosh'] };
  if (was.n === m.n && was.phase === m.phase) return { now, cues: [] };
  if (m.phase === 'paint') return { now, cues: ['start'] };
  if (m.phase === 'cheer') return { now, cues: ['reveal'] };
  return { now, cues: m.myGain ? ['coin'] : ['pop'] };
}

export function createPixelView({ engine, fx, cues, toast, win }) {
  const cue = cues && typeof cues.play === 'function' ? cues : QUIET;
  const confetti = fx && typeof fx.confetti === 'function' ? fx.confetti : () => {};
  const tell = typeof toast === 'function' ? toast : () => {};
  const w = win || globalThis;
  const clock = () => (engine && typeof engine.now === 'function' ? engine.now() : Date.now());
  const el = h('section', { class: 'game game-pixel', attrs: { 'aria-label': 'Pixel Art' } });
  const head = h('div', { class: 'pixel-headwrap' });
  const title = h('div', { class: 'pixel-titlewrap' });
  const cells = [];
  for (let i = 0; i < CELLS; i += 1) cells.push(h('span', { class: 'pixel-cell pixel-c0', dataset: { i } }));
  const grid = h('div', { class: 'pixel-grid', attrs: { role: 'img', 'aria-label': 'Shared pixel canvas' } }, cells);
  const frame = h('div', { class: 'pixel-frame' }, grid);
  const tools = h('div', { class: 'pixel-tools', attrs: { role: 'toolbar', 'aria-label': 'Colours' } });
  const actions = h('div', { class: 'pixel-actions' });
  const foot = h('div', { class: 'game-foot', attrs: { role: 'status', 'aria-live': 'polite' } });
  el.append(head, title, frame, tools, actions, foot);

  const shown = new Array(CELLS).fill(EMPTY);
  const overlay = new Map();
  const pending = new Map();
  const flagged = new Set();
  let colour = PALETTE[0].code;
  let painting = false;
  let last = null;
  let flushTimer = null;
  let model = null;
  let snap = null;
  let heard = null;
  let round = null;
  let cheerSent = null;
  let celebrated = null;

  function swatch(code, name) {
    const active = colour === code;
    return h(
      'button',
      {
        class: ['pixel-swatch', `pixel-c${code}`, active ? 'is-active' : null, code === ERASER ? 'is-eraser' : null],
        type: 'button',
        dataset: { key: `swatch-${code}`, code },
        attrs: { 'aria-label': name, title: name, 'aria-pressed': active ? 'true' : 'false' },
        on: { click: () => pickColour(code) },
      },
      code === ERASER ? h('span', { class: 'pixel-eraser-icon', text: '⌫', attrs: { 'aria-hidden': 'true' } }) : null,
    );
  }

  const paintTools = memo((on) => {
    if (!on) return null;
    return [PALETTE.map((p) => swatch(p.code, p.name)), swatch(ERASER, 'Eraser')];
  });

  function pickColour(code) {
    colour = code;
    cue.play('tap');
    paintTools(tools, { on: true, colour });
  }

  function stopFlush() {
    if (flushTimer !== null && typeof w.clearTimeout === 'function') w.clearTimeout(flushTimer);
    flushTimer = null;
  }

  function flush() {
    flushTimer = null;
    const m = model;
    if (!m || !m.canPaint || !pending.size) {
      pending.clear();
      return;
    }
    const batch = [...pending.entries()].slice(0, MAX_BATCH);
    for (const [i] of batch) pending.delete(i);
    engine.act({ type: 'paint', n: m.n, c: encodeCells(batch) });
    if (pending.size) schedule();
  }

  function schedule() {
    if (flushTimer !== null) return;
    if (typeof w.setTimeout !== 'function') {
      flush();
      return;
    }
    flushTimer = w.setTimeout(flush, PAINT_MS);
  }

  function setCell(i, c) {
    if (!Number.isInteger(i) || i < 0 || i >= CELLS) return;
    const node = cells[i];
    if (shown[i] === c) return;
    node.classList.remove(`pixel-c${shown[i]}`);
    node.classList.add(`pixel-c${c}`);
    shown[i] = c;
  }

  function paintCell(i) {
    const m = model;
    if (!m || !m.canPaint || !Number.isInteger(i)) return;
    if (shown[i] === colour && !pending.has(i)) return;
    overlay.set(i, { c: colour, at: clock() });
    pending.set(i, colour);
    setCell(i, colour);
    schedule();
  }

  function cellOf(e) {
    const t = e && e.target;
    if (t && t.dataset && t.dataset.i !== undefined && t !== grid) {
      const i = Number(t.dataset.i);
      if (Number.isInteger(i)) return i;
    }
    return cellFromPoint(typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null, e && e.clientX, e && e.clientY);
  }

  function stroke(e) {
    const i = cellOf(e);
    if (i === null) return;
    for (const c of lineCells(last, i)) paintCell(c);
    last = i;
  }

  grid.addEventListener('pointerdown', (e) => {
    if (!model || !model.canPaint) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    painting = true;
    last = null;
    if (e && e.pointerId !== undefined && typeof grid.setPointerCapture === 'function') {
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        painting = true;
      }
    }
    stroke(e);
  });
  grid.addEventListener('pointermove', (e) => {
    if (painting) stroke(e);
  });
  const stop = () => {
    painting = false;
    last = null;
  };
  grid.addEventListener('pointerup', stop);
  grid.addEventListener('pointercancel', stop);
  grid.addEventListener('lostpointercapture', stop);

  function syncGrid(m) {
    const at = clock();
    for (const [i, o] of overlay) {
      if (m.grid[i] === o.c || at - o.at > OVERLAY_MS) overlay.delete(i);
    }
    for (let i = 0; i < CELLS; i += 1) {
      const o = overlay.get(i);
      setCell(i, o && m.phase === 'paint' ? o.c : m.grid[i]);
    }
  }

  const paintHead = memo((m) => {
    if (!m) return null;
    const label = m.phase === 'paint' ? 'Time left to paint' : m.phase === 'cheer' ? 'Time left to cheer' : 'Next up in';
    return h(
      'div',
      { class: 'game-head' },
      h('span', { class: 'chip chip-static', text: m.phase === 'paint' ? 'Paint' : m.phase === 'cheer' ? 'Cheer' : 'Done' }),
      h('span', { class: 'game-count', text: m.total > 1 ? `Picture ${m.number} of ${m.total}` : 'One big picture' }),
      timer(m.starts, m.ends, label),
    );
  });

  const paintTitle = memo((m) => {
    if (!m) return h('p', { class: 'waiting', text: 'Setting up the canvas…' });
    return [
      h('span', { class: 'eyebrow', text: m.phase === 'paint' ? 'Paint together' : 'You all made' }),
      h('h2', { class: 'question pixel-theme', text: m.theme }),
      m.note === 'wiped' ? h('p', { class: 'notice', text: 'Enough players flagged the picture, so the canvas was wiped. Start fresh!' }) : null,
    ];
  });

  function flag(f) {
    if (!f || f.mine) return;
    if (!engine || typeof engine.flag !== 'function' || !engine.flag(f.d)) {
      tell(FLAG_FAIL);
      return;
    }
    flagged.add(f.d);
    tell(FLAG_SENT);
    if (snap) update(snap);
  }

  function cheer(m) {
    if (!m.canCheer || cheerSent === m.n) return;
    cheerSent = m.n;
    cue.play('pop');
    engine.act({ type: 'cheer', n: m.n });
    if (snap) update(snap);
  }

  const paintActions = memo(({ m, f }) => {
    if (!m) return null;
    const cheerBtn =
      m.phase === 'cheer' && m.filled
        ? button(m.cheered || cheerSent === m.n ? `Cheered! 👏 ${m.cheers}` : `Looks great! 👏 ${m.cheers}`, {
            variant: m.cheered || cheerSent === m.n ? 'ghost' : 'primary',
            key: 'pixel-cheer',
            disabled: !m.canCheer || cheerSent === m.n,
            on: () => cheer(model),
            attrs: { 'aria-label': `Cheer for the picture. ${plural(m.cheers, 'cheer', 'cheers')} so far` },
          })
        : null;
    const flagBtn = f
      ? button(flagLabel(f), {
          variant: 'ghost',
          size: 'sm',
          key: 'pixel-flag',
          disabled: f.mine,
          on: () => flag(f),
          attrs: { title: FLAG_HELP, 'aria-label': f.mine ? flagLabel(f) : `${flagLabel(f)}: report this picture`, 'aria-pressed': f.mine ? 'true' : 'false' },
          kids: h('span', { class: 'btn-icon flag-icon', text: FLAG_ICON, attrs: { 'aria-hidden': 'true' } }),
        })
      : null;
    if (!cheerBtn && !flagBtn) return null;
    return h('div', { class: 'pixel-actions-row' }, cheerBtn, flagBtn);
  });

  const paintFoot = memo((m) => (m ? h('span', { class: 'foot-text', text: footText(m) }) : null));

  function update(next) {
    snap = next;
    const m = pixel.model(next);
    model = m;
    paintHead(head, m);
    paintTitle(title, m);
    if (!m) {
      paintTools(tools, null);
      paintActions(actions, { m: null, f: null });
      paintFoot(foot, null);
      return;
    }
    const key = `${m.n}.${m.w}`;
    if (round !== key) {
      round = key;
      overlay.clear();
      pending.clear();
      stopFlush();
    }
    if (m.phase !== 'paint') {
      painting = false;
      pending.clear();
    }
    syncGrid(m);
    frame.classList.toggle('is-big', m.phase !== 'paint');
    frame.classList.toggle('is-live', m.canPaint);
    paintTools(tools, m.canPaint ? { on: true, colour } : null);
    const item = m.filled ? pixel.drawingOf(next) : null;
    const f = item ? flagModel(next, item, flagged) : null;
    paintActions(actions, { m, f });
    paintFoot(foot, m);
    const { now, cues: list } = pixelMoment(heard, m);
    heard = now;
    list.forEach((name, i) => cue.play(name, i ? { at: 320 } : undefined));
    if (m.phase === 'show' && m.cheers >= 3 && celebrated !== m.n) {
      celebrated = m.n;
      cue.burst(frame, { count: 18, emoji: ['👏', '🎨', '✨'] });
      confetti(40);
    }
  }

  return {
    el,
    update,
    destroy() {
      stopFlush();
    },
  };
}
