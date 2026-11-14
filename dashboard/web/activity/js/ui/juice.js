import { reducedMotion } from './fx.js';

export const MAX_LIVE = 120;
export const MAX_FLOATS = 24;
export const PRESS_CLASS = 'juice-press';
export const PRESS_MS = 280;
export const JUICE_TARGETS = 'button, [role=button], [role=tab], [role=radio], .chip';

export const PALETTE = ['var(--accent)', 'var(--accent-text)', 'var(--pink)', 'var(--violet)', 'var(--amber)', 'var(--success)'];

let layer = null;
let live = 0;
let floats = 0;
let gen = 0;

function winOf() {
  return globalThis.window || globalThis;
}

function docOf() {
  return globalThis.document || null;
}

export function quietMotion() {
  return reducedMotion(winOf());
}

export function liveParticles() {
  return live;
}

export function liveFloats() {
  return floats;
}

function ensureLayer() {
  const doc = docOf();
  if (!doc || !doc.body) return null;
  if (layer && layer.isConnected !== false && layer.parentNode) return layer;
  layer = doc.createElement('div');
  layer.className = 'juice-layer';
  layer.setAttribute('aria-hidden', 'true');
  doc.body.append(layer);
  return layer;
}

function later(fn, ms) {
  const set = globalThis.setTimeout;
  return typeof set === 'function' ? set(fn, ms) : null;
}

function finish(node, ms, done) {
  let gone = false;
  const end = () => {
    if (gone) return;
    gone = true;
    node.remove();
    done();
  };
  node.addEventListener('animationend', (e) => {
    if (!e || e.target === node || e.target === undefined || e.target === null) end();
  });
  later(end, ms);
  return end;
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

function px(n) {
  return `${Math.round(n * 10) / 10}px`;
}

export function centerOf(el) {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, width: r.width, height: r.height };
  } catch {
    return { x: 0, y: 0, top: 0, width: 0, height: 0 };
  }
}

export function burst(x, y, opts = {}) {
  if (quietMotion()) return 0;
  const host = ensureLayer();
  if (!host) return 0;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const want = Math.max(0, Math.min(48, Math.round(Number(opts.count ?? 10) || 0)));
  const n = Math.min(want, MAX_LIVE - live);
  if (n <= 0) return 0;
  const emoji = opts.emoji ? (Array.isArray(opts.emoji) ? opts.emoji.filter(Boolean) : [String(opts.emoji)]) : [];
  const colors = Array.isArray(opts.colors) && opts.colors.length ? opts.colors : PALETTE;
  const spread = Math.max(12, Number(opts.spread) || 60);
  const size = Math.max(3, Number(opts.size) || 7);
  const ox = Number.isFinite(x) ? x : 0;
  const oy = Number.isFinite(y) ? y : 0;
  const base = random() * Math.PI * 2;
  for (let i = 0; i < n; i += 1) {
    const angle = base + (i / n) * Math.PI * 2 + (random() - 0.5) * 0.9;
    const dist = spread * (0.55 + random() * 0.6);
    const dur = Math.round(520 + random() * 380 + (emoji.length ? 260 : 0));
    const bit = docOf().createElement('span');
    const useEmoji = emoji.length && (opts.mix === false || random() < 0.7);
    const kind = useEmoji ? 'is-emoji' : random() < 0.4 ? 'is-star' : 'is-dot';
    bit.className = `juice-bit ${kind}`;
    if (useEmoji) bit.textContent = pick(emoji, random);
    const s = useEmoji ? size * 2.4 + random() * size : size * (0.7 + random() * 0.8);
    bit.style.setProperty('--px', px(ox));
    bit.style.setProperty('--py', px(oy));
    bit.style.setProperty('--dx', px(Math.cos(angle) * dist));
    bit.style.setProperty('--dy', px(Math.sin(angle) * dist - spread * 0.15));
    bit.style.setProperty('--fall', px(spread * (0.2 + random() * 0.25)));
    bit.style.setProperty('--rot', `${Math.round((random() - 0.5) * 540)}deg`);
    bit.style.setProperty('--dur', `${dur}ms`);
    bit.style.setProperty('--delay', `${Math.round(random() * 60)}ms`);
    bit.style.setProperty('--s', px(s));
    bit.style.setProperty('--c', pick(colors, random));
    live += 1;
    host.append(bit);
    const g = gen;
    finish(bit, dur + 500, () => {
      if (g === gen) live = Math.max(0, live - 1);
    });
  }
  return n;
}

export function burstFrom(el, opts = {}) {
  if (!el) return 0;
  const c = centerOf(el);
  return burst(c.x, c.y, opts);
}

export function floatText(el, text, opts = {}) {
  if (!el || quietMotion() || floats >= MAX_FLOATS) return null;
  const host = ensureLayer();
  if (!host) return null;
  const c = centerOf(el);
  const label = docOf().createElement('span');
  label.className = ['juice-float', opts.tone ? `is-${opts.tone}` : null].filter(Boolean).join(' ');
  label.textContent = String(text);
  label.style.setProperty('--px', px(c.x));
  label.style.setProperty('--py', px(Number.isFinite(opts.y) ? opts.y : c.top));
  if (opts.color) label.style.setProperty('--c', opts.color);
  const ms = Math.max(400, Number(opts.ms) || 1100);
  label.style.setProperty('--dur', `${ms}ms`);
  floats += 1;
  host.append(label);
  const g = gen;
  finish(label, ms + 400, () => {
    if (g === gen) floats = Math.max(0, floats - 1);
  });
  return label;
}

function skipped(el, root) {
  if (!el) return true;
  if (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) return true;
  let n = el;
  while (n && n !== root && n.getAttribute) {
    if (n.hasAttribute('data-nojuice') || (n.dataset && n.dataset.nojuice !== undefined)) return true;
    n = n.parentNode;
  }
  return false;
}

export function soundFor(el) {
  const role = el.getAttribute ? el.getAttribute('role') : null;
  if (el.hasAttribute && (el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked'))) return 'toggle';
  if (role === 'tab') return 'toggle';
  return 'tap';
}

export function squish(el) {
  if (!el || !el.classList || quietMotion()) return false;
  el.classList.remove(PRESS_CLASS);
  void el.offsetWidth;
  el.classList.add(PRESS_CLASS);
  const prev = el.juiceTimer;
  if (prev && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(prev);
  el.juiceTimer = later(() => {
    el.classList.remove(PRESS_CLASS);
    el.juiceTimer = null;
  }, PRESS_MS);
  return true;
}

export function attachJuice(root, { sfx = null } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};

  function play(name) {
    try {
      if (sfx && typeof sfx.play === 'function') sfx.play(name);
    } catch {
      return;
    }
  }

  function press(el, x, y) {
    if (skipped(el, root)) return;
    play(soundFor(el));
    if (quietMotion()) return;
    squish(el);
    let px0 = x;
    let py0 = y;
    if (!Number.isFinite(px0) || !Number.isFinite(py0) || (px0 === 0 && py0 === 0)) {
      const c = centerOf(el);
      px0 = c.x;
      py0 = c.y;
    }
    burst(px0, py0, { count: 7, spread: 38, size: 6 });
  }

  function target(e) {
    const t = e && e.target && typeof e.target.closest === 'function' ? e.target.closest(JUICE_TARGETS) : null;
    if (!t || (typeof root.contains === 'function' && !root.contains(t))) return null;
    return t;
  }

  function onDown(e) {
    if (e && typeof e.button === 'number' && e.button !== 0) return;
    const t = target(e);
    if (t) press(t, Number(e.clientX), Number(e.clientY));
  }

  function onKey(e) {
    if (!e || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
    const t = target(e);
    if (t) press(t, NaN, NaN);
  }

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('keydown', onKey);
  };
}

export function resetJuice() {
  if (layer) layer.remove();
  layer = null;
  gen += 1;
  live = 0;
  floats = 0;
}
