export const BG = '#0c0a14';
export const PALETTE = Object.freeze([
  Object.freeze({ color: '#ff6b4a', rgb: '255,107,74', shape: 'circle' }),
  Object.freeze({ color: '#ffcc33', rgb: '255,204,51', shape: 'diamond' }),
  Object.freeze({ color: '#33d6f5', rgb: '51,214,245', shape: 'square' }),
  Object.freeze({ color: '#b48cff', rgb: '180,140,255', shape: 'triangle' }),
]);
export const LANE_SETS = Object.freeze({ 2: Object.freeze([0, 2]), 3: Object.freeze([0, 1, 2]), 4: Object.freeze([0, 1, 2, 3]) });
export const JUDGE_COLORS = Object.freeze({ p: '#ffe066', g: '#5eead4', o: '#93c5fd', m: '#f87171' });
export const JUDGE_TEXT = Object.freeze({ p: 'Perfect', g: 'Great', o: 'Good', m: 'Miss' });
export const MISS_GREY = '#6b7280';
export const HIT_Y = 0.8;
export const PARTICLE_CAP = 60;
export const PARTICLE_MS = 260;
export const FLASH_MS = 180;
export const PRESS_MS = 90;
export const JUDGE_HOLD_MS = 250;
export const JUDGE_FADE_MS = 150;
export const TINT_MS = 120;
export const GLOW = Object.freeze([0.25, 0.45, 0.65, 0.85, 1]);

export function laneStyle(lanes) {
  return LANE_SETS[lanes] || LANE_SETS[4];
}

export function noteY(noteMs, t, look, hitY) {
  return hitY - ((noteMs / 1000 - t) / look) * hitY;
}

export function gemSize(laneW) {
  return Math.max(36, Math.min(60, laneW * 0.6));
}

export const GEM_MIN_SCALE = 0.6;
const GAPS = new WeakMap();

export function laneGapMs(notes) {
  if (!Array.isArray(notes) || !notes.length) return Infinity;
  if (GAPS.has(notes)) return GAPS.get(notes);
  const last = new Map();
  let min = Infinity;
  for (const n of notes) {
    if (last.has(n.l)) min = Math.min(min, n.t - last.get(n.l));
    last.set(n.l, n.t);
  }
  GAPS.set(notes, min);
  return min;
}

export function gemScale(gapMs, look, hitY, gem) {
  if (!(gapMs > 0) || !Number.isFinite(gapMs) || !(look > 0) || !(gem > 0)) return 1;
  const room = ((gapMs / 1000) / look) * hitY;
  return clamp((0.9 * room) / gem, GEM_MIN_SCALE, 1);
}

export function judgeY(H, hitY, ring = 0) {
  return Math.min(H - 14, hitY + Math.max(0.45 * (H - hitY), ring + 18));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function shapePath(g, shape, cx, cy, r) {
  g.beginPath();
  if (shape === 'diamond') {
    g.moveTo(cx, cy - r * 1.08);
    g.lineTo(cx + r * 1.08, cy);
    g.lineTo(cx, cy + r * 1.08);
    g.lineTo(cx - r * 1.08, cy);
    g.closePath();
  } else if (shape === 'square') {
    const s = r * 0.86;
    if (typeof g.roundRect === 'function') g.roundRect(cx - s, cy - s, s * 2, s * 2, r * 0.3);
    else g.rect(cx - s, cy - s, s * 2, s * 2);
  } else if (shape === 'triangle') {
    g.moveTo(cx, cy - r * 1.02);
    g.lineTo(cx + r * 1.02, cy + r * 0.8);
    g.lineTo(cx - r * 1.02, cy + r * 0.8);
    g.closePath();
  } else g.arc(cx, cy, r, 0, Math.PI * 2);
}

export function createBeatDraw(canvas, { doc } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const g = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const view = { W: 0, H: 0, dpr: 1, lanes: 4, lw: 0, hitY: 0, gem: 0, ring: 0 };
  let sprites = [];
  let grey = null;
  let bg = null;
  let glow = null;
  let fade = null;
  let parts = [];

  function surface(w, h) {
    if (!d || typeof d.createElement !== 'function') return null;
    const c = d.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    const x = typeof c.getContext === 'function' ? c.getContext('2d') : null;
    return x ? { c, x } : null;
  }

  function gemSprite(pal, size, colour) {
    const dpr = view.dpr;
    const pad = 4 * dpr;
    const s = surface(size + pad * 2, size + pad * 2);
    if (!s) return null;
    const x = s.x;
    const cx = size / 2 + pad;
    const r = size / 2 - 2 * dpr;
    shapePath(x, pal.shape, cx, cx, r);
    x.fillStyle = colour;
    x.fill();
    x.lineWidth = 2 * dpr;
    x.strokeStyle = 'rgba(0,0,0,0.35)';
    shapePath(x, pal.shape, cx, cx, r - 2.5 * dpr);
    x.stroke();
    x.lineWidth = 3 * dpr;
    x.strokeStyle = 'rgba(255,255,255,0.9)';
    shapePath(x, pal.shape, cx, cx, r);
    x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.85)';
    shapePath(x, pal.shape, cx, cx, r * 0.34);
    x.fill();
    return s.c;
  }

  function ringSprite(pal, size, fillA) {
    const dpr = view.dpr;
    const pad = 6 * dpr;
    const s = surface(size + pad * 2, size + pad * 2);
    if (!s) return null;
    const x = s.x;
    const cx = size / 2 + pad;
    const r = size / 2 - 2 * dpr;
    shapePath(x, pal.shape, cx, cx, r);
    x.fillStyle = `rgba(${pal.rgb},${fillA})`;
    x.fill();
    x.lineWidth = 4 * dpr;
    x.strokeStyle = `rgba(${pal.rgb},0.8)`;
    x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.35)';
    shapePath(x, pal.shape, cx, cx, r * 0.3);
    x.fill();
    return s.c;
  }

  function prerender() {
    const { W, H, dpr, lanes, lw, hitY, gem, ring } = view;
    const set = laneStyle(lanes);
    sprites = set.map((pi) => {
      const pal = PALETTE[pi];
      return { pal, gem: gemSprite(pal, gem, pal.color), ring: ringSprite(pal, ring, 0.15), on: ringSprite(pal, ring, 0.7), grey: null };
    });
    grey = set.map((pi) => gemSprite(PALETTE[pi], gem, MISS_GREY));
    const b = surface(W, H);
    if (b) {
      const x = b.x;
      x.fillStyle = BG;
      x.fillRect(0, 0, W, H);
      for (let l = 0; l < lanes; l += 1) {
        const pal = sprites[l].pal;
        x.fillStyle = l % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)';
        x.fillRect(l * lw, 0, lw, H);
        if (typeof x.createLinearGradient === 'function') {
          const gr = x.createLinearGradient(0, 0, 0, hitY);
          gr.addColorStop(0, `rgba(${pal.rgb},0)`);
          gr.addColorStop(1, `rgba(${pal.rgb},0.10)`);
          x.fillStyle = gr;
          x.fillRect(l * lw, 0, lw, hitY);
        }
      }
      x.fillStyle = 'rgba(255,255,255,0.20)';
      for (let l = 1; l < lanes; l += 1) x.fillRect(l * lw - dpr, 0, 2 * dpr, H);
      x.fillStyle = 'rgba(255,255,255,0.45)';
      x.fillRect(0, hitY - 2 * dpr, W, 4 * dpr);
      bg = b.c;
    } else bg = null;
    const gl = surface(W, 12 * dpr);
    if (gl) {
      for (let l = 0; l < lanes; l += 1) {
        const pal = sprites[l].pal;
        if (typeof gl.x.createLinearGradient === 'function') {
          const gr = gl.x.createLinearGradient(0, 0, 0, 12 * dpr);
          gr.addColorStop(0, `rgba(${pal.rgb},0)`);
          gr.addColorStop(0.5, `rgba(${pal.rgb},0.55)`);
          gr.addColorStop(1, `rgba(${pal.rgb},0)`);
          gl.x.fillStyle = gr;
        } else gl.x.fillStyle = `rgba(${pal.rgb},0.3)`;
        gl.x.fillRect(l * lw, 0, lw, 12 * dpr);
      }
      glow = gl.c;
    } else glow = null;
    const fz = surface(W, H * 0.12);
    if (fz && typeof fz.x.createLinearGradient === 'function') {
      const gr = fz.x.createLinearGradient(0, 0, 0, H * 0.12);
      gr.addColorStop(0, 'rgba(12,10,20,0.95)');
      gr.addColorStop(1, 'rgba(12,10,20,0)');
      fz.x.fillStyle = gr;
      fz.x.fillRect(0, 0, W, H * 0.12);
      fade = fz.c;
    } else fade = null;
  }

  function resize({ width, height, dpr = 1, lanes = 4 }) {
    if (!g || !(width > 0) || !(height > 0)) return false;
    const r = clamp(dpr, 1, 2);
    const W = Math.round(width * r);
    const H = Math.round(height * r);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const lw = W / lanes;
    const gem = Math.round(gemSize(width / lanes) * r);
    Object.assign(view, { W, H, dpr: r, lanes, lw, hitY: H * HIT_Y, gem, ring: Math.round(gem * 1.15) });
    prerender();
    parts = [];
    return true;
  }

  function laneX(l) {
    return l * view.lw + view.lw / 2;
  }

  function burst(lane, now, count) {
    const n = Math.max(0, Math.min(count, PARTICLE_CAP - parts.length));
    const s = sprites[lane];
    if (!s) return;
    for (let i = 0; i < n; i += 1) {
      const a = (Math.PI * 2 * i) / n + (i % 2 ? 0.35 : -0.2);
      const v = (0.35 + (i % 3) * 0.12) * view.dpr;
      parts.push({ x: laneX(lane), y: view.hitY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.15 * view.dpr, at: now, col: s.pal.color });
    }
  }

  function centred(img, cx, cy, scale = 1) {
    if (!img) return;
    const w = img.width * scale;
    const h = img.height * scale;
    g.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }

  function text(str, x, y, size, fill, stroke = 4) {
    g.font = `800 ${Math.round(size)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (stroke) {
      g.lineWidth = stroke * view.dpr;
      g.strokeStyle = '#000';
      g.lineJoin = 'round';
      g.strokeText(str, x, y);
    }
    g.fillStyle = fill;
    g.fillText(str, x, y);
  }

  function firstIdx(notes, ms) {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].t < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function draw(f) {
    if (!g || !view.W) return false;
    const { W, H, dpr, lanes, hitY } = view;
    const now = f.now;
    const t = f.t;
    const look = f.look;
    const song = f.song;
    const calm = Boolean(f.still);
    const lite = Boolean(f.lite);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    const sAge = now - (f.shakeAt || -1e9);
    if (f.shake && !calm && sAge < 120) g.translate(Math.sin(now * 0.11) * 4 * dpr * (1 - sAge / 120), 0);
    if (bg) g.drawImage(bg, 0, 0);
    else {
      g.fillStyle = BG;
      g.fillRect(0, 0, W, H);
    }
    for (let l = 0; l < lanes; l += 1) {
      const pal = sprites[l] ? sprites[l].pal : PALETTE[0];
      const lit = (f.down && f.down[l]) || now - (f.pressAt ? f.pressAt[l] : -1e9) < 110;
      if (lit) {
        g.fillStyle = `rgba(${pal.rgb},0.16)`;
        g.fillRect(l * view.lw, 0, view.lw, H);
      }
      if (f.missAt && now - f.missAt[l] < TINT_MS) {
        g.fillStyle = 'rgba(248,113,113,0.16)';
        g.fillRect(l * view.lw, 0, view.lw, H);
      }
    }
    if (song && song.beat > 0) {
      const beat = song.beat;
      const b0 = Math.max(0, Math.floor((t - 0.5) / beat));
      for (let b = b0; b * beat <= t + look; b += 1) {
        const bar = b % 4 === 0;
        if (lite && !bar) continue;
        const y = noteY(b * beat * 1000, t, look, hitY);
        if (y < 0 || y > H) continue;
        g.fillStyle = bar ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.10)';
        const h = (bar ? 2 : 1) * dpr;
        g.fillRect(0, y - h / 2, W, h);
      }
    }
    if (glow && !lite) {
      g.globalAlpha = GLOW[clamp(f.tier || 0, 0, 4)];
      g.drawImage(glow, 0, hitY - 6 * dpr);
      g.globalAlpha = 1;
    }
    const beatLen = song && song.beat > 0 ? song.beat : 0.6;
    const phase = t >= 0 ? (t % beatLen) / beatLen : 1;
    const pulse = phase < 0.15 ? 1 - phase / 0.15 : 0;
    const jy = judgeY(H, hitY, view.ring / 2);
    for (let l = 0; l < lanes; l += 1) {
      const s = sprites[l];
      if (!s) continue;
      const cx = laneX(l);
      const pressed = now - (f.pressAt ? f.pressAt[l] : -1e9) < PRESS_MS;
      let scale = 1;
      let alpha = 1;
      if (calm || f.flatPulse) alpha = 0.72 + 0.28 * pulse;
      else scale = 1 + 0.05 * pulse;
      if (pressed && !calm) scale = 1.06;
      g.globalAlpha = alpha;
      centred(pressed ? s.on : s.ring, cx, hitY, scale);
      g.globalAlpha = 1;
      const fl = f.flash ? f.flash[l] : null;
      if (fl && now - fl.at < FLASH_MS) {
        const k = (now - fl.at) / FLASH_MS;
        g.globalAlpha = 0.9 * (1 - k);
        g.strokeStyle = s.pal.color;
        g.lineWidth = 4 * dpr;
        g.beginPath();
        g.arc(cx, hitY, (view.ring / 2) * (calm ? 1.1 : 1.05 + 0.3 * k), 0, Math.PI * 2);
        g.stroke();
        if (fl.k === 'p' && !calm) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2 * dpr;
          g.beginPath();
          g.arc(cx, hitY, (view.ring / 2) * (1 + 0.9 * k), 0, Math.PI * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
      const jd = f.judge ? f.judge[l] : null;
      const showing = jd && now - jd.at < JUDGE_HOLD_MS + JUDGE_FADE_MS;
      if (f.labels && f.labels[l] && !showing) {
        g.globalAlpha = 0.75;
        text(f.labels[l], cx, Math.min(H - 10 * dpr, hitY + view.ring / 2 + 14 * dpr), 13 * dpr, '#f4f4f5', 3);
        g.globalAlpha = 1;
      }
    }
    if (song && song.notes) {
      const notes = song.notes;
      const mark = f.mark || null;
      const from = firstIdx(notes, (t - 0.6) * 1000);
      const until = (t + look) * 1000;
      for (let i = from; i < notes.length && notes[i].t <= until; i += 1) {
        const n = notes[i];
        if (!n.c || i === 0 || notes[i - 1].t !== n.t) continue;
        const m = mark ? mark[i] : 0;
        if (m) continue;
        const y = noteY(n.t, t, look, hitY);
        const a = Math.min(laneX(n.l), laneX(notes[i - 1].l));
        const b = Math.max(laneX(n.l), laneX(notes[i - 1].l));
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillRect(a, y - 2 * dpr, b - a, 4 * dpr);
      }
      const gs = gemScale(laneGapMs(notes), look, hitY, view.gem);
      for (let i = from; i < notes.length && notes[i].t <= until; i += 1) {
        const n = notes[i];
        const m = mark ? mark[i] : 0;
        if ((m >= 1 && m <= 3) || m === 5) continue;
        const s = sprites[n.l];
        if (!s) continue;
        const y = noteY(n.t, t, look, hitY);
        if (m === 4) {
          const k = clamp((t - n.t / 1000) / 0.5, 0, 1);
          g.globalAlpha = 0.5 * (1 - k);
          centred(grey[n.l], laneX(n.l), y, gs);
          g.globalAlpha = 1;
          continue;
        }
        centred(s.gem, laneX(n.l), y, gs);
      }
    }
    if (fade) g.drawImage(fade, 0, 0);
    if (!lite && !calm && parts.length) {
      const keep = [];
      for (const p of parts) {
        const age = now - p.at;
        if (age >= PARTICLE_MS || age < 0) continue;
        keep.push(p);
        const k = age / PARTICLE_MS;
        g.globalAlpha = 1 - k;
        g.fillStyle = p.col;
        const sz = 5 * dpr * (1 - k * 0.5);
        g.fillRect(p.x + p.vx * age - sz / 2, p.y + p.vy * age + 0.0006 * dpr * age * age - sz / 2, sz, sz);
      }
      parts = keep;
      g.globalAlpha = 1;
    } else if (parts.length) parts = [];
    if (f.judge) {
      const size = clamp(view.lw * 0.22, 18 * dpr, 30 * dpr);
      for (let l = 0; l < lanes; l += 1) {
        const jd = f.judge[l];
        if (!jd) continue;
        const age = now - jd.at;
        if (age < 0 || age >= JUDGE_HOLD_MS + JUDGE_FADE_MS) continue;
        const k = age < JUDGE_HOLD_MS ? 0 : (age - JUDGE_HOLD_MS) / JUDGE_FADE_MS;
        const rise = calm ? 0 : 8 * dpr * Math.min(1, age / (JUDGE_HOLD_MS + JUDGE_FADE_MS));
        g.globalAlpha = 1 - k;
        text(JUDGE_TEXT[jd.k] || '', laneX(l), jy - rise, size, JUDGE_COLORS[jd.k] || '#fff');
        if (jd.tag) text(jd.tag, laneX(l), jy - rise + size * 0.8, 11 * dpr, '#e4e4e7', 3);
        g.globalAlpha = 1;
      }
    }
    if (song && song.dur > 0) {
      const prog = clamp(t / song.dur, 0, 1);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(0, 0, W, 6 * dpr);
      g.fillStyle = PALETTE[0].color;
      g.fillRect(0, 0, W * prog, 6 * dpr);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (const mk of f.marks || []) g.fillRect((mk.t / song.dur) * W - dpr, 0, 2 * dpr, 6 * dpr);
    }
    if (f.dropSoon) {
      const pop = calm ? 1 : 1 + 0.06 * pulse;
      text('DROP!', W / 2, H * 0.07, 26 * dpr * pop, '#ffe066', 4);
    }
    if (f.countdown) text(f.countdown, W / 2, H * 0.42, 72 * dpr, '#ffffff', 6);
    return true;
  }

  return {
    resize,
    draw,
    burst,
    get view() {
      return { ...view };
    },
    get particles() {
      return parts.length;
    },
    get ok() {
      return Boolean(g);
    },
  };
}
