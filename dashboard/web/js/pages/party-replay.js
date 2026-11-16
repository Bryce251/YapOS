import { h, replace } from '../dom.js';
import { avatar, button } from '../ui.js';
import { icon } from '../icons.js';
import { GRID_W, GRID_H, COLORS, ERASER, isFill, strokeOn, fillOn } from '../../activity/js/games/ink.js';
import { PIXEL_SIZE, PIXEL_COLORS, PIXEL_BLANK } from '../../activity/js/games/replayformat.js';
import { SPEEDS, DEFAULT_SPEED, ALL, plan, progressAt, stepTime, retime, speedFromKey, speedLabel, cycleFilter, artistView, filterText, nowDrawing, visibleAt, gridAt, formatClock, countLabel, notesOf, endOf } from '../replay-model.js';

export const INK_SCALE = 2;
export const CELL_PX = 16;
export const DIM_ALPHA = 0.18;

function reduced(win) {
  try {
    return Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function ratioOf(win) {
  const r = Number(win && win.devicePixelRatio) || 1;
  return Math.max(1, Math.min(2, r));
}

function artistName(a) {
  return a.name || a.profile?.display_name || a.profile?.username || 'Player';
}

export function createReplayPlayer({ replay, drawerId = '', label = 'drawing', win = globalThis, onBan = null, canBan = null } = {}) {
  const r = replay;
  const pixel = r.kind === 'pixel';
  const ratio = ratioOf(win);
  const still = reduced(win);
  const scale = pixel ? CELL_PX * ratio : INK_SCALE * ratio;
  const width = pixel ? PIXEL_SIZE * scale : GRID_W * scale;
  const height = pixel ? PIXEL_SIZE * scale : GRID_H * scale;
  const canvas = h('canvas', { class: ['replay-canvas', pixel ? 'is-pixel' : ''], width: Math.round(width), height: Math.round(height), attrs: { role: 'img', 'aria-label': `Replay of the reported ${label}` } });
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: !pixel }) : null;
  const pen = h('span', { class: 'replay-pen', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'replay-pen-dot' }), h('span', { class: 'replay-pen-name' }));
  const nowBox = h('div', { class: 'replay-now', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
  const stage = h('div', { class: ['replay-stage', pixel ? 'is-pixel' : ''] }, canvas, pen, nowBox);
  const playBtn = button({ label: 'Play', icon: 'play', size: 'sm', variant: 'primary', className: 'replay-play', onClick: () => toggle() });
  const restartBtn = button({ icon: 'rewind', size: 'sm', variant: 'ghost', ariaLabel: 'Restart replay', onClick: () => restart() });
  const backBtn = button({ icon: 'skip-back', size: 'sm', variant: 'ghost', ariaLabel: pixel ? 'Back one pixel' : 'Back one line', onClick: () => step(-1) });
  const fwdBtn = button({ icon: 'skip-forward', size: 'sm', variant: 'ghost', ariaLabel: pixel ? 'Forward one pixel' : 'Forward one line', onClick: () => step(1) });
  for (const b of [restartBtn, backBtn, fwdBtn]) b.setAttribute('title', b.getAttribute('aria-label'));
  const clock = h('span', { class: 'replay-clock', attrs: { 'aria-hidden': 'true' } });
  const scrub = h('input', { class: 'replay-scrub', type: 'range', min: 0, max: 1000, step: 1, value: 1000, attrs: { 'aria-label': 'Replay position' } });
  const speedBar = h('div', { class: 'segmented replay-speeds', attrs: { role: 'group', 'aria-label': 'Replay speed' } });
  const skipBox = h('input', { type: 'checkbox', checked: true, class: 'replay-skip-box' });
  const skip = h('label', { class: 'replay-skip' }, skipBox, h('span', { text: 'Skip idle gaps' }));
  const legend = h('ul', { class: 'replay-legend', attrs: { 'aria-label': 'Artists' } });
  const legendNote = h('p', { class: 'replay-filter-note muted' });
  const notes = notesOf(r).map((t) => h('p', { class: 'replay-note', text: t }));
  const keys = h('p', { class: 'replay-keys muted', text: 'Space plays or pauses, arrow keys step, 1 to 6 set the speed.' });
  const el = h('div', { class: ['replay-player', pixel ? 'is-pixel' : ''], tabIndex: 0, attrs: { role: 'group', 'aria-label': `Replay of the reported ${label}` } },
    stage,
    h('div', { class: 'replay-controls' },
      h('div', { class: 'replay-buttons' }, restartBtn, backBtn, playBtn, fwdBtn, clock),
      scrub,
      h('div', { class: 'replay-options' }, speedBar, skip)),
    h('div', { class: 'replay-artists' }, legend, legendNote),
    ...notes,
    keys);

  let timing = plan(r.events, { skipGaps: true });
  let time = timing.total;
  let speed = DEFAULT_SPEED;
  let playing = false;
  let raf = null;
  let last = 0;
  let filter = ALL;
  let drawn = -1;
  let partial = null;
  let shownWho = -2;
  let pixels = null;
  let dead = false;

  function setPen(x, y, a) {
    if (a < 0) {
      pen.classList.remove('is-on');
      return;
    }
    pen.classList.add('is-on');
    for (let k = 0; k < 8; k += 1) pen.classList.toggle(`artist-${k}`, r.authors[a].tone === k);
    pen.style.setProperty('--x', `${(x * 100).toFixed(2)}%`);
    pen.style.setProperty('--y', `${(y * 100).toFixed(2)}%`);
    pen.classList.toggle('is-top', y < 0.14);
    pen.classList.toggle('is-right', x > 0.7);
    pen.lastChild.textContent = artistName(r.authors[a]);
  }

  function blank() {
    if (!ctx) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS[ERASER];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function inkEvent(e, from, to) {
    const view = artistView(filter, e.a);
    if (view === 'off' || !ctx) return;
    if (isFill(e.stroke)) {
      ctx.globalAlpha = 1;
      fillOn(ctx, e.stroke, scale);
      return;
    }
    const pts = e.stroke.pts;
    const end = Math.max(1, Math.min(pts.length, to));
    ctx.globalAlpha = view === 'dim' ? DIM_ALPHA : 1;
    strokeOn(ctx, end === pts.length && from === 0 ? e.stroke : { ...e.stroke, pts: pts.slice(0, end) }, scale, from);
    ctx.globalAlpha = 1;
  }

  function cellColor(code) {
    return code === PIXEL_BLANK ? null : PIXEL_COLORS[code] || null;
  }

  function paintCell(i, code, a, grow = 1) {
    if (!ctx) return;
    const x = (i % PIXEL_SIZE) * scale;
    const y = Math.floor(i / PIXEL_SIZE) * scale;
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS[ERASER];
    ctx.fillRect(x, y, scale, scale);
    const col = cellColor(code);
    const view = a >= 0 ? artistView(filter, a) : 'on';
    if (!col || view === 'off') return;
    ctx.globalAlpha = view === 'dim' ? DIM_ALPHA : 1;
    ctx.fillStyle = col;
    const g = Math.max(0.2, Math.min(1, grow));
    const pad = (scale * (1 - g)) / 2;
    ctx.fillRect(x + pad, y + pad, scale - pad * 2, scale - pad * 2);
    ctx.globalAlpha = 1;
  }

  function fullPixel(count) {
    pixels = gridAt(r.events, count, r.base || null);
    blank();
    for (let i = 0; i < pixels.color.length; i += 1) if (pixels.color[i] !== PIXEL_BLANK) paintCell(i, pixels.color[i], pixels.owner[i]);
  }

  function fullInk(count) {
    blank();
    for (const i of visibleAt(r.events, count)) inkEvent(r.events[i], 0, Infinity);
  }

  function render(force = false) {
    const at = progressAt(timing, time);
    const target = at.done;
    if (pixel) {
      if (force || drawn < 0 || target < drawn) {
        fullPixel(target);
      } else {
        for (let i = drawn; i < target; i += 1) {
          const e = r.events[i];
          pixels.color[e.i] = e.c;
          pixels.owner[e.i] = e.c === PIXEL_BLANK ? -1 : e.a;
          paintCell(e.i, e.c, e.a);
        }
      }
      drawn = target;
      if (at.active >= 0) {
        const e = r.events[at.active];
        paintCell(e.i, e.c, e.a, still ? 1 : 0.35 + 0.65 * at.frac);
        setPen(((e.i % PIXEL_SIZE) + 0.5) / PIXEL_SIZE, (Math.floor(e.i / PIXEL_SIZE) + 0.5) / PIXEL_SIZE, e.a);
      } else if (!playing) {
        setPen(0, 0, -1);
      }
    } else {
      let full = force || drawn < 0 || target < drawn || Boolean(partial && partial.i !== drawn);
      if (!full) {
        for (let i = drawn; i < target; i += 1) {
          const e = r.events[i];
          if (e.type === 'cut') {
            full = true;
            break;
          }
          const from = partial && partial.i === i ? partial.k : 0;
          inkEvent(e, from, Infinity);
        }
      }
      if (full) {
        fullInk(target);
        partial = null;
      }
      if (partial && partial.i < target) partial = null;
      drawn = target;
      if (at.active >= 0 && r.events[at.active].type === 'add' && !isFill(r.events[at.active].stroke)) {
        const e = r.events[at.active];
        const pts = e.stroke.pts;
        const k = Math.max(1, Math.ceil(at.frac * pts.length));
        const from = partial && partial.i === at.active ? partial.k : 0;
        if (k > from || from === 0) inkEvent(e, from, k);
        partial = { i: at.active, k: Math.max(from, k) };
        const p = pts[Math.min(pts.length, k) - 1];
        setPen(p[0] / GRID_W, p[1] / GRID_H, artistView(filter, e.a) === 'off' ? -1 : e.a);
      } else {
        partial = null;
        if (!playing) setPen(0, 0, -1);
      }
    }
    if (time >= timing.total) setPen(0, 0, -1);
    paintStatus();
  }

  function paintStatus() {
    const total = timing.total;
    scrub.value = String(total > 0 ? Math.round((time / total) * 1000) : 1000);
    scrub.setAttribute('aria-valuetext', `${formatClock(time)} of ${formatClock(total)}`);
    clock.textContent = `${formatClock(time)} / ${formatClock(total)}`;
    const who = playing || time < total ? nowDrawing(timing, r.events, time) : -1;
    if (who !== shownWho) {
      shownWho = who;
      if (who < 0) {
        replace(nowBox);
        nowBox.classList.remove('is-on');
      } else {
        const a = r.authors[who];
        nowBox.classList.add('is-on');
        replace(nowBox,
          h('span', { class: ['replay-now-chip', `artist-${a.tone}`] },
            avatar({ name: artistName(a), url: a.profile?.avatar || '', id: a.id, size: 'xs' }),
            h('span', { class: 'replay-now-label', text: pixel ? 'Now painting' : 'Now drawing' }),
            h('strong', { class: 'replay-now-name', text: artistName(a) })));
      }
      for (const li of legend.children) li.classList.toggle('is-now', Number(li.dataset.a) === who);
    }
    const label = playing ? 'Pause' : time >= total ? 'Replay' : 'Play';
    const lab = playBtn.querySelector('.btn-label');
    if (lab && lab.textContent !== label) {
      lab.textContent = label;
      playBtn.setAttribute('aria-label', label === 'Replay' ? 'Watch again from the start' : `${label} the replay`);
      const svg = playBtn.querySelector('svg');
      if (svg && svg.parentNode) {
        const parent = svg.parentNode;
        parent.insertBefore(icon(playing ? 'pause' : 'play', { size: 14 }), svg);
        parent.removeChild(svg);
      }
    }
    el.classList.toggle('is-playing', playing);
  }

  function tick(at) {
    raf = null;
    if (!playing || dead) return;
    const dt = Math.max(0, Math.min(250, at - last));
    last = at;
    time = Math.min(timing.total, time + dt * speed);
    if (time >= timing.total) playing = false;
    render();
    if (playing) raf = win.requestAnimationFrame(tick);
  }

  function play() {
    if (playing || !timing.total) return;
    if (time >= timing.total) {
      time = 0;
      render(true);
    }
    playing = true;
    last = typeof win.performance?.now === 'function' ? win.performance.now() : Date.now();
    if (typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(tick);
    paintStatus();
  }

  function pause() {
    playing = false;
    if (raf !== null && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(raf);
    raf = null;
    paintStatus();
  }

  function toggle() {
    if (playing) pause();
    else play();
  }

  function seek(t, force = false) {
    time = Math.max(0, Math.min(timing.total, t));
    render(force);
  }

  function restart() {
    pause();
    seek(0, true);
    play();
  }

  function step(dir) {
    pause();
    seek(stepTime(timing, time, dir));
  }

  function setSpeed(s) {
    if (!SPEEDS.includes(s)) return;
    speed = s;
    paintSpeeds();
  }

  function paintSpeeds() {
    replace(speedBar, ...SPEEDS.map((s, i) => {
      const b = button({ label: speedLabel(s), size: 'sm', variant: s === speed ? 'segment-active' : 'segment', ariaLabel: `${speedLabel(s)} speed, key ${i + 1}`, onClick: () => setSpeed(s) });
      b.setAttribute('aria-pressed', s === speed ? 'true' : 'false');
      return b;
    }));
  }

  function pickArtist(a) {
    filter = cycleFilter(filter, a);
    paintLegend();
    render(true);
  }

  function paintLegend() {
    replace(legend, ...r.authors.map((a, i) => {
      const view = artistView(filter, i);
      const chip = h('button', {
        type: 'button',
        class: ['replay-artist', `artist-${a.tone}`, `is-${view}`],
        attrs: { 'aria-pressed': filter.mode !== 'all' && filter.a === i ? 'true' : 'false', 'aria-label': `${artistName(a)}, ${countLabel(r.kind, a.count)}. ${filter.mode === 'all' || filter.a !== i ? 'Highlight their work' : filter.mode === 'focus' ? 'Show only their work' : 'Show everyone'}` },
        on: { click: () => pickArtist(i) },
      },
      h('span', { class: 'replay-swatch', attrs: { 'aria-hidden': 'true' } }),
      avatar({ name: artistName(a), url: a.profile?.avatar || '', id: a.id, size: 'sm' }),
      h('span', { class: 'replay-artist-main' },
        h('span', { class: 'replay-artist-name', text: artistName(a) }),
        h('span', { class: 'replay-artist-count', text: `${countLabel(r.kind, a.count)}${a.id && a.id.toLowerCase() === String(drawerId).toLowerCase() ? ' · reported' : ''}` })));
      const extra = typeof onBan === 'function' && (!canBan || canBan(a)) && a.id && a.id.toLowerCase() !== String(drawerId).toLowerCase()
        ? button({ label: 'Ban', icon: 'ban', size: 'sm', variant: 'ghost', className: 'replay-artist-ban', ariaLabel: `Ban ${artistName(a)} from YapOS Party`, onClick: (e) => onBan(a, e.currentTarget) })
        : a.banned ? h('span', { class: 'replay-artist-flag', text: 'Banned' }) : null;
      return h('li', { class: 'replay-artist-row', dataset: { a: i } }, chip, extra);
    }));
    legendNote.textContent = filterText(filter, r.authors.map((a) => ({ name: artistName(a) })));
    shownWho = -2;
  }

  scrub.addEventListener('input', () => {
    const at = (Number(scrub.value) / 1000) * timing.total;
    pause();
    seek(at);
  });
  skipBox.addEventListener('change', () => {
    const next = plan(r.events, { skipGaps: skipBox.checked });
    time = retime(timing, next, time);
    timing = next;
    render();
  });
  el.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    const onButton = tag === 'button';
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (onButton || tag === 'label' || (tag === 'input' && e.target.type === 'checkbox')) return;
      e.preventDefault();
      toggle();
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && tag !== 'input') {
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Home' && tag !== 'input') {
      e.preventDefault();
      pause();
      seek(0, true);
      return;
    }
    if (e.key === 'End' && tag !== 'input') {
      e.preventDefault();
      pause();
      seek(timing.total);
      return;
    }
    const s = speedFromKey(e.key);
    if (s !== null) {
      e.preventDefault();
      setSpeed(s);
    }
  });

  paintSpeeds();
  paintLegend();
  render(true);

  return {
    el,
    play,
    pause,
    seek,
    step,
    setSpeed,
    pickArtist,
    get time() {
      return time;
    },
    get total() {
      return timing.total;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get filter() {
      return filter;
    },
    get drawn() {
      return drawn;
    },
    lastEnd: () => endOf(timing, r.events.length - 1),
    destroy() {
      dead = true;
      pause();
    },
  };
}
