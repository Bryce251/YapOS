import { prefersReducedMotion } from './ui.js';

export const SPOTLIGHT_SELECTOR = '.card, .stat-card, .server-card, .feature, .app-tile, .member-row, .ticket-row';

const bound = new WeakSet();

export function spotlitChain(start, root) {
  const out = [];
  let el = start && typeof start.closest === 'function' ? start.closest(SPOTLIGHT_SELECTOR) : null;
  while (el && el !== root && root.contains(el)) {
    out.push(el);
    const parent = el.parentNode;
    el = parent && typeof parent.closest === 'function' ? parent.closest(SPOTLIGHT_SELECTOR) : null;
  }
  return out;
}

export function paintSpotlight(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.setProperty('--spotlight-x', `${Math.round(x - r.left)}px`);
  el.style.setProperty('--spotlight-y', `${Math.round(y - r.top)}px`);
}

export function spotlight(root, { schedule = (fn) => requestAnimationFrame(fn) } = {}) {
  if (!root || bound.has(root)) return root;
  bound.add(root);
  let targets = [];
  let x = 0;
  let y = 0;
  let queued = false;
  const flush = () => {
    queued = false;
    for (const el of targets) if (el.isConnected !== false) paintSpotlight(el, x, y);
  };
  root.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || prefersReducedMotion()) return;
    targets = spotlitChain(e.target, root);
    if (!targets.length) return;
    x = e.clientX;
    y = e.clientY;
    if (queued) return;
    queued = true;
    schedule(flush);
  }, { passive: true });
  return root;
}
