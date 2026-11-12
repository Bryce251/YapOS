const COLORS = ['#f2613f', '#ff8a6b', '#e5487f', '#f472b6', '#7c5cff', '#a78bfa', '#fbbf24', '#4ade80'];

export function reducedMotion(win) {
  try {
    return Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function makeParticles(count, width, height, random = Math.random) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const fromLeft = i % 2 === 0;
    out.push({
      x: fromLeft ? width * (0.05 + random() * 0.2) : width * (0.75 + random() * 0.2),
      y: height * (0.55 + random() * 0.2),
      vx: (fromLeft ? 1 : -1) * (2 + random() * 5),
      vy: -(9 + random() * 7),
      size: 5 + random() * 6,
      spin: random() * Math.PI,
      vspin: (random() - 0.5) * 0.3,
      color: COLORS[Math.floor(random() * COLORS.length)],
      shape: random() < 0.35 ? 'dot' : 'bit',
    });
  }
  return out;
}

export function stepParticles(list, dt = 1) {
  for (const p of list) {
    p.vy += 0.32 * dt;
    p.vx *= 0.992;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.spin += p.vspin * dt;
  }
  return list;
}

export function createFx(win) {
  const doc = win.document;
  let canvas = null;
  let frame = 0;
  let parts = [];
  let last = 0;
  let dims = '';

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
    const dpr = Math.min(2, win.devicePixelRatio || 1);
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

  function draw(ts) {
    const { w, h: hgt, ctx } = size();
    if (!ctx) return;
    const dt = last ? Math.min(3, (ts - last) / 16.7) : 1;
    last = ts;
    stepParticles(parts, dt);
    parts = parts.filter((p) => p.y < hgt + 40);
    ctx.clearRect(0, 0, w, hgt);
    for (const p of parts) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.fillStyle = p.color;
      if (p.shape === 'dot') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }
    if (parts.length) frame = win.requestAnimationFrame(draw);
    else {
      frame = 0;
      last = 0;
      ctx.clearRect(0, 0, w, hgt);
      canvas.classList.remove('is-on');
    }
  }

  function confetti(amount = 140) {
    if (reducedMotion(win) || typeof win.requestAnimationFrame !== 'function') return false;
    const { w, h: hgt } = size();
    parts = parts.concat(makeParticles(amount, w, hgt));
    canvas.classList.add('is-on');
    if (!frame) frame = win.requestAnimationFrame(draw);
    return true;
  }

  function spotlight(root) {
    const onMove = (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.spot') : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
      el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
    };
    root.addEventListener('pointermove', onMove, { passive: true });
    return () => root.removeEventListener('pointermove', onMove);
  }

  function clear() {
    if (frame && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    parts = [];
    if (!canvas) return;
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.classList.remove('is-on');
  }

  function destroy() {
    if (frame) win.cancelAnimationFrame(frame);
    if (canvas) canvas.remove();
    canvas = null;
    dims = '';
    parts = [];
  }

  return { confetti, clear, spotlight, destroy };
}
