import { sharedLoop, fxLevel, particleCap, PARTICLE_CAP } from './fxmode.js';
import { liveParticles } from './juice.js';

export const CONFETTI_MAX = PARTICLE_CAP;
export const BURST_GAP_MS = 3000;
export const LITE_DPR = 1.5;

const COLORS = ['#f2613f', '#ff8a6b', '#e5487f', '#f472b6', '#7c5cff', '#a78bfa', '#fbbf24', '#4ade80'];

export function reducedMotion(win) {
  try {
    return Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function spawnParticle(p, i, width, height, random = Math.random) {
  const fromLeft = i % 2 === 0;
  p.x = fromLeft ? width * (0.05 + random() * 0.2) : width * (0.75 + random() * 0.2);
  p.y = height * (0.55 + random() * 0.2);
  p.vx = (fromLeft ? 1 : -1) * (2 + random() * 5);
  p.vy = -(9 + random() * 7);
  p.size = 5 + random() * 6;
  p.spin = random() * Math.PI;
  p.vspin = (random() - 0.5) * 0.3;
  p.color = COLORS[Math.floor(random() * COLORS.length)];
  p.shape = random() < 0.35 ? 'dot' : 'bit';
  return p;
}

export function makeParticles(count, width, height, random = Math.random) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(spawnParticle({}, i, width, height, random));
  return out;
}

export function stepParticles(list, dt = 1, n = list.length) {
  for (let i = 0; i < n; i += 1) {
    const p = list[i];
    p.vy += 0.32 * dt;
    p.vx *= 0.992;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.spin += p.vspin * dt;
  }
  return list;
}

export function confettiRoom(level, alive, dom = 0) {
  return Math.max(0, Math.min(CONFETTI_MAX, particleCap(level)) - alive - Math.max(0, dom));
}

export function createFx(win, { loop = null, now = () => Date.now() } = {}) {
  const doc = win.document;
  const pool = [];
  let canvas = null;
  let alive = 0;
  let dims = '';
  let off = null;
  let lastBurst = -Infinity;

  for (let i = 0; i < CONFETTI_MAX; i += 1) pool.push({ x: 0, y: 0, vx: 0, vy: 0, size: 0, spin: 0, vspin: 0, color: COLORS[0], shape: 'bit' });

  function runner() {
    return loop || sharedLoop();
  }

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = doc.createElement('canvas');
    canvas.className = 'confetti';
    canvas.setAttribute('aria-hidden', 'true');
    doc.body.append(canvas);
    return canvas;
  }

  function size() {
    const c = ensureCanvas();
    const cap = fxLevel() === 'lite' ? LITE_DPR : 2;
    const dpr = Math.min(cap, win.devicePixelRatio || 1);
    const w = win.innerWidth || 360;
    const hgt = win.innerHeight || 640;
    const ctx = c.getContext('2d');
    const next = `${w}x${hgt}x${dpr}`;
    if (next !== dims) {
      dims = next;
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
      c.style.setProperty('width', `${w}px`);
      c.style.setProperty('height', `${hgt}px`);
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { w, h: hgt, ctx };
  }

  function stop() {
    if (off) off();
    off = null;
  }

  function draw(ts, ms) {
    if (!canvas || reducedMotion(win) || fxLevel() === 'static') {
      clear();
      return false;
    }
    const { w, h: hgt, ctx } = size();
    if (!ctx) return false;
    const dt = Math.min(3, (Number(ms) || 16.7) / 16.7);
    stepParticles(pool, dt, alive);
    for (let i = 0; i < alive; ) {
      if (pool[i].y < hgt + 40) {
        i += 1;
        continue;
      }
      alive -= 1;
      const dead = pool[i];
      pool[i] = pool[alive];
      pool[alive] = dead;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = canvas.width / w || 1;
    for (let i = 0; i < alive; i += 1) {
      const p = pool[i];
      const c = Math.cos(p.spin) * dpr;
      const s = Math.sin(p.spin) * dpr;
      ctx.setTransform(c, s, -s, c, p.x * dpr, p.y * dpr);
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (alive) return true;
    ctx.clearRect(0, 0, w, hgt);
    canvas.classList.remove('is-on');
    off = null;
    return false;
  }

  function confetti(amount = 60) {
    if (reducedMotion(win) || typeof win.requestAnimationFrame !== 'function') return false;
    const level = fxLevel();
    if (level === 'static') return false;
    const t = now();
    if (t - lastBurst < BURST_GAP_MS) return alive > 0;
    let dom = 0;
    try {
      dom = liveParticles();
    } catch {
      dom = 0;
    }
    const n = Math.min(confettiRoom(level, alive, dom), Math.max(0, Math.round(Number(amount) || 0)));
    if (!n) return alive > 0;
    lastBurst = t;
    const { w, h: hgt } = size();
    for (let i = 0; i < n; i += 1) {
      spawnParticle(pool[alive], i, w, hgt);
      alive += 1;
    }
    canvas.classList.add('is-on');
    if (!off) off = runner().add(draw);
    return true;
  }

  function spotlight(root) {
    let pending = null;
    let offSpot = null;
    const paint = () => {
      offSpot = null;
      const e = pending;
      pending = null;
      if (!e) return false;
      const el = e.target && e.target.closest ? e.target.closest('.spot') : null;
      if (!el || el.isConnected === false) return false;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
      return false;
    };
    const onMove = (e) => {
      if (fxLevel() !== 'full' || (e && e.pointerType === 'touch')) return;
      pending = e;
      if (!offSpot) offSpot = runner().add(paint);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      root.removeEventListener('pointermove', onMove);
      if (offSpot) offSpot();
      offSpot = null;
      pending = null;
    };
  }

  function clear() {
    stop();
    alive = 0;
    if (!canvas) return;
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dims = '';
    }
    canvas.classList.remove('is-on');
  }

  function destroy() {
    stop();
    if (canvas) canvas.remove();
    canvas = null;
    dims = '';
    alive = 0;
  }

  function live() {
    return alive;
  }

  return { confetti, clear, spotlight, destroy, live };
}
