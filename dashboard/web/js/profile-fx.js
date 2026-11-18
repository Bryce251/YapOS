export const FX_KEY = 'yapos.profileEffects';
export const FX_MAX = 64;
export const FX_MIN = 12;
export const FX_AREA = 26000;
export const FX_FPS = 30;
export const FX_DPR_MAX = 2;
export const FX_SPRITE = 48;

const TAU = Math.PI * 2;
const DENSITY = Object.freeze({ snow: 1.3, snowflakes: 0.5, sakura: 0.55, stars: 1, fireflies: 0.45, confetti: 0.75, hearts: 0.4, bubbles: 0.45, rain: 1.5, embers: 0.7, sparkles: 0.45 });
const CONFETTI = Object.freeze(['#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff8c42']);

export function fxCount(id, width, height) {
  const d = DENSITY[id];
  if (!d) return 0;
  const area = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  return Math.round(Math.min(FX_MAX, Math.max(FX_MIN, (area / FX_AREA) * d)));
}

function storeOf(store) {
  if (store) return store;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function effectsAllowed(store) {
  try {
    const s = storeOf(store);
    return !s || s.getItem(FX_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setEffectsAllowed(on, store) {
  try {
    const s = storeOf(store);
    if (!s) return;
    if (on) s.removeItem(FX_KEY);
    else s.setItem(FX_KEY, 'off');
  } catch {}
}

export function prefersReducedMotion(win = globalThis.window) {
  try {
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function sprite(doc, paint) {
  const c = doc.createElement('canvas');
  c.width = FX_SPRITE;
  c.height = FX_SPRITE;
  const g = typeof c.getContext === 'function' ? c.getContext('2d') : null;
  if (!g) return null;
  g.translate(FX_SPRITE / 2, FX_SPRITE / 2);
  paint(g, FX_SPRITE / 2);
  return c;
}

function glowDot(colour, core = 0.35) {
  return (g, r) => {
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, colour);
    grad.addColorStop(core, colour);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.fill();
  };
}

function snowDot(g, r) {
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.62, 'rgba(150,180,225,0.6)');
  grad.addColorStop(1, 'rgba(150,180,225,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();
}

function flake(g, r) {
  flakeArms(g, r, 'rgba(70,105,160,0.5)', r * 0.19);
  flakeArms(g, r, 'rgba(255,255,255,0.97)', r * 0.09);
}

function flakeArms(g, r, colour, width) {
  g.strokeStyle = colour;
  g.lineCap = 'round';
  g.lineWidth = width;
  for (let i = 0; i < 6; i++) {
    g.save();
    g.rotate((i * TAU) / 6);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -r * 0.9);
    g.moveTo(0, -r * 0.45);
    g.lineTo(-r * 0.22, -r * 0.65);
    g.moveTo(0, -r * 0.45);
    g.lineTo(r * 0.22, -r * 0.65);
    g.moveTo(0, -r * 0.7);
    g.lineTo(-r * 0.14, -r * 0.84);
    g.moveTo(0, -r * 0.7);
    g.lineTo(r * 0.14, -r * 0.84);
    g.stroke();
    g.restore();
  }
}

function petal(light, deep) {
  return (g, r) => {
    const grad = g.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, light);
    grad.addColorStop(1, deep);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -r * 0.85);
    g.bezierCurveTo(r * 0.75, -r * 0.55, r * 0.6, r * 0.55, 0, r * 0.85);
    g.bezierCurveTo(-r * 0.6, r * 0.55, -r * 0.75, -r * 0.55, 0, -r * 0.85);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.ellipse(-r * 0.15, -r * 0.2, r * 0.12, r * 0.4, 0.3, 0, TAU);
    g.fill();
  };
}

function star(colour, glow) {
  return (g, r) => {
    if (glow) {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0, glow);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fill();
    }
    g.fillStyle = colour;
    g.beginPath();
    const a = r * 0.9;
    const b = r * 0.16;
    g.moveTo(0, -a);
    g.quadraticCurveTo(b, -b, a, 0);
    g.quadraticCurveTo(b, b, 0, a);
    g.quadraticCurveTo(-b, b, -a, 0);
    g.quadraticCurveTo(-b, -b, 0, -a);
    g.fill();
  };
}

function heart(colour) {
  return (g, r) => {
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(0, r * 0.75);
    g.bezierCurveTo(-r * 1.1, 0, -r * 0.6, -r * 0.95, 0, -r * 0.4);
    g.bezierCurveTo(r * 0.6, -r * 0.95, r * 1.1, 0, 0, r * 0.75);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath();
    g.ellipse(-r * 0.38, -r * 0.32, r * 0.14, r * 0.08, -0.6, 0, TAU);
    g.fill();
  };
}

function bubble(g, r) {
  g.strokeStyle = 'rgba(200,235,255,0.8)';
  g.lineWidth = r * 0.07;
  g.fillStyle = 'rgba(160,220,255,0.12)';
  g.beginPath();
  g.arc(0, 0, r * 0.85, 0, TAU);
  g.fill();
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.beginPath();
  g.ellipse(-r * 0.32, -r * 0.36, r * 0.16, r * 0.09, -0.7, 0, TAU);
  g.fill();
}

const between = (rand, lo, hi) => lo + rand() * (hi - lo);

const KINDS = Object.freeze({
  snow: {
    sprites: (doc) => [sprite(doc, snowDot)],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : -8;
      p.s = between(rand, 4, 11);
      p.vy = between(rand, 18, 46);
      p.a = between(rand, 0.45, 0.9);
      p.ph = rand() * TAU;
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += Math.sin(t * 0.7 + p.ph) * 14 * dt;
      return p.y < h + 10;
    },
  },
  snowflakes: {
    sprites: (doc) => [sprite(doc, flake)],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : -24;
      p.s = between(rand, 12, 26);
      p.vy = between(rand, 14, 32);
      p.vr = between(rand, -0.6, 0.6);
      p.r = rand() * TAU;
      p.a = between(rand, 0.5, 0.85);
      p.ph = rand() * TAU;
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += Math.sin(t * 0.5 + p.ph) * 12 * dt;
      p.r += p.vr * dt;
      return p.y < h + 30;
    },
  },
  sakura: {
    sprites: (doc) => [sprite(doc, petal('#ffd6e5', '#f48fb1')), sprite(doc, petal('#ffe4ee', '#f8a5c2'))],
    spawn(p, w, h, first, rand) {
      p.x = first ? rand() * w : between(rand, -w * 0.3, w);
      p.y = first ? rand() * h : -20;
      p.s = between(rand, 10, 18);
      p.vy = between(rand, 24, 50);
      p.vx = between(rand, 12, 34);
      p.vr = between(rand, -1.2, 1.2);
      p.r = rand() * TAU;
      p.a = between(rand, 0.65, 0.95);
      p.ph = rand() * TAU;
      p.k = rand() < 0.5 ? 0 : 1;
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += (p.vx + Math.sin(t * 1.1 + p.ph) * 18) * dt;
      p.r += p.vr * dt;
      p.sx = Math.cos(t * 1.8 + p.ph);
      return p.y < h + 24 && p.x < w + 30;
    },
  },
  stars: {
    sprites: (doc) => [sprite(doc, star('rgba(255,255,255,0.95)', 'rgba(190,210,255,0.35)')), sprite(doc, star('rgba(255,236,170,0.95)', 'rgba(255,220,120,0.3)'))],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = rand() * h;
      p.s = between(rand, 6, 14);
      p.sp = between(rand, 0.8, 2.2);
      p.ph = rand() * TAU;
      p.k = rand() < 0.75 ? 0 : 1;
      p.base = between(rand, 0.35, 0.85);
    },
    step(p, dt, w, h, t) {
      p.a = p.base * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * p.sp + p.ph)));
      return true;
    },
  },
  fireflies: {
    sprites: (doc) => [sprite(doc, glowDot('rgba(220,255,120,0.95)', 0.18))],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = rand() * h;
      p.s = between(rand, 10, 20);
      p.dir = rand() * TAU;
      p.v = between(rand, 10, 26);
      p.ph = rand() * TAU;
      p.sp = between(rand, 0.6, 1.6);
    },
    step(p, dt, w, h, t, rand) {
      p.dir += between(rand, -1.5, 1.5) * dt;
      p.x += Math.cos(p.dir) * p.v * dt;
      p.y += Math.sin(p.dir) * p.v * dt;
      if (p.x < -20) p.x = w + 10;
      if (p.x > w + 20) p.x = -10;
      if (p.y < -20) p.y = h + 10;
      if (p.y > h + 20) p.y = -10;
      p.a = 0.15 + 0.8 * Math.max(0, Math.sin(t * p.sp + p.ph));
      return true;
    },
  },
  confetti: {
    sprites: () => [],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : -12;
      p.s = between(rand, 6, 10);
      p.vy = between(rand, 40, 90);
      p.vx = between(rand, -15, 15);
      p.vr = between(rand, -4, 4);
      p.r = rand() * TAU;
      p.ph = rand() * TAU;
      p.a = between(rand, 0.75, 1);
      p.c = CONFETTI[Math.floor(rand() * CONFETTI.length)];
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += (p.vx + Math.sin(t * 2 + p.ph) * 20) * dt;
      p.r += p.vr * dt;
      p.sy = Math.cos(t * 5 + p.ph);
      return p.y < h + 16;
    },
  },
  hearts: {
    sprites: (doc) => [sprite(doc, heart('#ff5d8f')), sprite(doc, heart('#ff8fb3')), sprite(doc, heart('#e5487f'))],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : h + 20;
      p.s = between(rand, 12, 22);
      p.vy = -between(rand, 22, 48);
      p.ph = rand() * TAU;
      p.r = between(rand, -0.3, 0.3);
      p.k = Math.floor(rand() * 3);
      p.base = between(rand, 0.55, 0.9);
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += Math.sin(t * 1.3 + p.ph) * 16 * dt;
      p.a = p.base * Math.min(1, Math.max(0, p.y / (h * 0.35)));
      return p.y > -24;
    },
  },
  bubbles: {
    sprites: (doc) => [sprite(doc, bubble)],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : h + 24;
      p.s = between(rand, 10, 28);
      p.vy = -between(rand, 18, 40);
      p.ph = rand() * TAU;
      p.a = between(rand, 0.5, 0.85);
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += Math.sin(t * 1.6 + p.ph) * 14 * dt;
      return p.y > -30;
    },
  },
  rain: {
    sprites: () => [],
    lines: true,
    spawn(p, w, h, first, rand) {
      p.x = between(rand, 0, w + 120);
      p.y = first ? rand() * h : -30;
      p.s = between(rand, 12, 24);
      p.vy = between(rand, 520, 820);
      p.vx = -p.vy * 0.12;
      p.a = between(rand, 0.18, 0.4);
    },
    step(p, dt, w, h) {
      p.y += p.vy * dt;
      p.x += p.vx * dt;
      return p.y < h + 30;
    },
  },
  embers: {
    sprites: (doc) => [sprite(doc, glowDot('rgba(255,170,70,0.95)', 0.22)), sprite(doc, glowDot('rgba(255,110,50,0.95)', 0.22))],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = first ? rand() * h : h + 10;
      p.s = between(rand, 6, 14);
      p.vy = -between(rand, 26, 64);
      p.ph = rand() * TAU;
      p.k = rand() < 0.5 ? 0 : 1;
      p.base = between(rand, 0.55, 0.95);
    },
    step(p, dt, w, h, t) {
      p.y += p.vy * dt;
      p.x += Math.sin(t * 2.2 + p.ph) * 18 * dt;
      p.a = p.base * (0.6 + 0.4 * Math.sin(t * 9 + p.ph)) * Math.min(1, Math.max(0, p.y / (h * 0.45)));
      return p.y > -16;
    },
  },
  sparkles: {
    sprites: (doc) => [sprite(doc, star('rgba(255,255,255,0.98)', 'rgba(255,255,255,0.3)')), sprite(doc, star('rgba(255,224,130,0.98)', 'rgba(255,210,90,0.3)'))],
    spawn(p, w, h, first, rand) {
      p.x = rand() * w;
      p.y = rand() * h;
      p.life = between(rand, 1.2, 2.6);
      p.age = first ? rand() * p.life : 0;
      p.max = between(rand, 10, 22);
      p.r = rand() * TAU;
      p.k = rand() < 0.6 ? 0 : 1;
    },
    step(p, dt) {
      p.age += dt;
      const k = Math.sin(Math.PI * Math.min(1, p.age / p.life));
      p.s = p.max * k;
      p.a = k;
      p.r += dt * 0.8;
      return p.age < p.life;
    },
  },
});

export const FX_KINDS = Object.freeze(Object.keys(KINDS));

export function makeParticles(id, count, w, h, rand = Math.random) {
  const kind = KINDS[id];
  if (!kind) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = { x: 0, y: 0, s: 8, a: 1, r: 0, sx: 1, sy: 1, k: 0 };
    kind.spawn(p, w, h, true, rand);
    out.push(p);
  }
  return out;
}

export function stepParticles(id, list, dt, w, h, t, rand = Math.random) {
  const kind = KINDS[id];
  if (!kind) return list;
  for (const p of list) {
    if (!kind.step(p, dt, w, h, t, rand)) kind.spawn(p, w, h, false, rand);
  }
  return list;
}

function paint(ctx, id, list, sprites, scale, fade) {
  const kind = KINDS[id];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (kind.lines) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.2 * scale;
    ctx.strokeStyle = 'rgba(190,215,255,1)';
    ctx.globalAlpha = 0.32 * fade;
    ctx.beginPath();
    for (const p of list) {
      ctx.moveTo(p.x * scale, p.y * scale);
      ctx.lineTo((p.x - p.vx * 0.03) * scale, (p.y - p.s) * scale);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  for (const p of list) {
    const a = Math.max(0, Math.min(1, p.a)) * fade;
    if (a <= 0.01 || p.s <= 0.2) continue;
    const cos = Math.cos(p.r || 0) * scale;
    const sin = Math.sin(p.r || 0) * scale;
    const sx = p.sx === undefined ? 1 : p.sx;
    const sy = p.sy === undefined ? 1 : p.sy;
    ctx.globalAlpha = a;
    ctx.setTransform(cos * sx, sin * sx, -sin * sy, cos * sy, p.x * scale, p.y * scale);
    if (p.c) {
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      continue;
    }
    const img = sprites[p.k || 0] || sprites[0];
    if (img) ctx.drawImage(img, -p.s / 2, -p.s / 2, p.s, p.s);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

export function effectThumb(id, { doc = globalThis.document, width = 96, height = 60, rand = Math.random } = {}) {
  const kind = KINDS[id];
  if (!kind || !doc) return null;
  const canvas = doc.createElement('canvas');
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return canvas;
  const sprites = kind.sprites(doc).filter(Boolean);
  const list = makeParticles(id, Math.max(6, Math.round(fxCount(id, width * 4, height * 4) / 3)), width, height, rand);
  stepParticles(id, list, 0.016, width, height, 1.3, rand);
  paint(ctx, id, list, sprites, scale, 1);
  return canvas;
}

export function startEffect(host, id, opts = {}) {
  const win = opts.win || globalThis.window;
  const doc = opts.doc || globalThis.document;
  const rand = opts.rand || Math.random;
  const kind = KINDS[id];
  const handle = { running: false, canvas: null, stop() {} };
  if (!kind || !host || !doc || !win) return handle;
  const canvas = doc.createElement('canvas');
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return handle;
  canvas.className = ['pfx-canvas', opts.className || ''].filter(Boolean).join(' ');
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  const sprites = kind.sprites(doc).filter(Boolean);
  const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(() => fn(Date.now()), 1000 / FX_FPS);
  const unraf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : clearTimeout;
  const box = typeof opts.box === 'function' ? opts.box : () => ({ width: win.innerWidth || 0, height: win.innerHeight || 0 });
  let mq = null;
  try {
    mq = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {}
  let w = 0;
  let h = 0;
  let scale = 1;
  let list = [];
  let frame = 0;
  let last = 0;
  let clock = 0;
  let stopped = false;
  let dirty = true;
  const still = () => Boolean(opts.reduced) || Boolean(mq && mq.matches);
  function fit() {
    const b = box();
    const nw = Math.max(1, Math.round(b.width || 0));
    const nh = Math.max(1, Math.round(b.height || 0));
    scale = Math.min(FX_DPR_MAX, Math.max(1, Number(win.devicePixelRatio) || 1));
    canvas.width = Math.round(nw * scale);
    canvas.height = Math.round(nh * scale);
    const want = fxCount(id, nw, nh);
    if (!list.length || nw !== w || nh !== h) {
      if (list.length > want) list.length = want;
      while (list.length < want) list.push(...makeParticles(id, 1, nw, nh, rand));
      if (w && h && (nw !== w || nh !== h)) for (const p of list) {
        p.x = (p.x / w) * nw;
        p.y = (p.y / h) * nh;
      }
    }
    w = nw;
    h = nh;
    dirty = false;
  }
  function tick(now) {
    frame = 0;
    if (stopped) return;
    const ms = typeof now === 'number' ? now : Date.now();
    if (dirty) fit();
    if (!last) last = ms;
    const gap = ms - last;
    if (gap >= 1000 / FX_FPS - 2) {
      const dt = Math.min(0.1, gap / 1000);
      last = ms;
      clock += dt;
      stepParticles(id, list, dt, w, h, clock, rand);
      paint(ctx, id, list, sprites, scale, 1);
    }
    frame = raf(tick);
  }
  function drawStill() {
    if (dirty) fit();
    stepParticles(id, list, 0.016, w, h, 1.3, rand);
    paint(ctx, id, list, sprites, scale, 0.55);
  }
  function play() {
    if (stopped || frame) return;
    if (still()) {
      drawStill();
      return;
    }
    if (doc.hidden) return;
    last = 0;
    frame = raf(tick);
  }
  function pause() {
    if (frame) unraf(frame);
    frame = 0;
  }
  const onResize = () => {
    dirty = true;
    if (still()) drawStill();
  };
  const onVisible = () => (doc.hidden ? pause() : play());
  const onMotion = () => {
    pause();
    play();
  };
  win.addEventListener?.('resize', onResize);
  doc.addEventListener?.('visibilitychange', onVisible);
  mq?.addEventListener?.('change', onMotion);
  fit();
  play();
  handle.running = true;
  handle.canvas = canvas;
  handle.particles = () => list.length;
  handle.stop = () => {
    if (stopped) return;
    stopped = true;
    handle.running = false;
    pause();
    win.removeEventListener?.('resize', onResize);
    doc.removeEventListener?.('visibilitychange', onVisible);
    mq?.removeEventListener?.('change', onMotion);
    canvas.remove?.();
  };
  return handle;
}
