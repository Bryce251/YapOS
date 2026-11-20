export const RATE = 44100;

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export const hz = (m) => 440 * 2 ** ((m - 69) / 12);

const len = (secs) => Math.max(1, Math.ceil(secs * RATE));

export function svf(x, fc, q = 0.707, mode = 'lp') {
  const k = 1 / q;
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  const fixed = typeof fc === 'number';
  const coef = (f) => {
    const g = Math.tan((Math.PI * Math.min(Math.max(f, 10), RATE * 0.45)) / RATE);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  if (fixed) coef(fc);
  for (let i = 0; i < x.length; i++) {
    if (!fixed && (i & 15) === 0) coef(fc(i / RATE));
    const v0 = x[i];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    x[i] = mode === 'lp' ? v2 : mode === 'bp' ? v1 : v0 - k * v1 - v2;
  }
  return x;
}

function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function osc(wave, ph, dt) {
  if (wave === 'sine') return Math.sin(2 * Math.PI * ph);
  if (wave === 'tri') return 1 - 4 * Math.abs(ph - 0.5);
  const saw = 2 * ph - 1 - blep(ph, dt);
  if (wave === 'saw') return saw;
  const p2 = (ph + 0.5) % 1;
  return saw - (2 * p2 - 1 - blep(p2, dt));
}

function adsr(x, dur, a, d, s, rel) {
  if (x < a) return x / a;
  if (x < a + d) return 1 - (1 - s) * ((x - a) / d);
  if (x < dur) return s;
  return s * Math.max(0, 1 - (x - dur) / rel);
}

export function kick(r, o = {}) {
  const f0 = o.f0 ?? 160;
  const f1 = o.f1 ?? 50;
  const pd = o.pitchDecay ?? 0.035;
  const dec = o.decay ?? 0.3;
  const click = o.click ?? 0.3;
  const out = new Float32Array(len(dec * 5));
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    ph += (f1 + (f0 - f1) * Math.exp(-x / pd)) / RATE;
    let v = Math.sin(2 * Math.PI * ph) * Math.exp(-x / dec) * Math.min(1, i / 20);
    if (x < 0.006) v += click * (r() * 2 - 1) * (1 - x / 0.006);
    out[i] = Math.tanh(1.4 * v);
  }
  return o.lp ? svf(out, o.lp) : out;
}

export function snare(r, o = {}) {
  const tone = o.tone ?? 190;
  const nd = o.noiseDecay ?? 0.16;
  const out = new Float32Array(len(nd * 5));
  const nz = new Float32Array(out.length);
  for (let i = 0; i < nz.length; i++) nz[i] = r() * 2 - 1;
  svf(nz, o.bright ?? 1800, 0.7, 'hp');
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    const body = (Math.sin(2 * Math.PI * tone * x) + 0.5 * Math.sin(2 * Math.PI * tone * 1.6 * x)) * Math.exp(-x / 0.06);
    out[i] = (0.6 * body + (o.noise ?? 0.9) * nz[i] * Math.exp(-x / nd)) * Math.min(1, i / (o.attack ?? 8));
  }
  return o.lp ? svf(out, o.lp) : out;
}

export function clap(r, o = {}) {
  const out = new Float32Array(len(0.35));
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    let e = Math.exp(-x / 0.12) * 0.6;
    for (const b of [0, 0.011, 0.022]) if (x >= b && x < b + 0.012) e = Math.max(e, Math.exp(-(x - b) / 0.004));
    out[i] = (r() * 2 - 1) * e;
  }
  svf(out, o.center ?? 1300, 1.2, 'bp');
  return out;
}

const METAL = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

export function hat(r, o = {}) {
  const dec = o.decay ?? (o.open ? 0.28 : 0.045);
  const out = new Float32Array(len(dec * 6));
  const ratio = o.ratio ?? 1;
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    let m = 0;
    for (const f of METAL) m += Math.sign(Math.sin(2 * Math.PI * f * ratio * 4 * x));
    out[i] = (0.4 * m / METAL.length + 0.8 * (r() * 2 - 1)) * Math.exp(-x / dec) * Math.min(1, i / 6);
  }
  svf(out, o.hp ?? 7000, 0.8, 'hp');
  return out;
}

export function shaker(r, o = {}) {
  const out = new Float32Array(len(0.12));
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    out[i] = (r() * 2 - 1) * Math.min(1, x / 0.012) * Math.exp(-x / 0.03);
  }
  svf(out, o.hp ?? 5000, 0.7, 'hp');
  return out;
}

export function crash(r, o = {}) {
  const dec = o.decay ?? 1.4;
  const out = new Float32Array(len(dec * 4));
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    let m = 0;
    for (const f of METAL) m += Math.sin(2 * Math.PI * f * 7.3 * x + f);
    out[i] = (0.25 * m / METAL.length + (r() * 2 - 1)) * Math.exp(-x / dec) * Math.min(1, i / 10);
  }
  svf(out, 4500, 0.6, 'hp');
  return out;
}

export function tom(r, o = {}) {
  return kick(r, { f0: (o.f ?? 140) * 1.6, f1: o.f ?? 140, pitchDecay: 0.05, decay: 0.22, click: 0.15 });
}

export function riser(r, secs) {
  const out = new Float32Array(len(secs));
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * (i / out.length) ** 2;
  return svf(out, (x) => 300 + 8000 * (x / secs) ** 2, 2.5, 'bp');
}

export function note(r, dur, freq, o = {}) {
  const wave = o.wave ?? 'saw';
  const a = o.attack ?? 0.005;
  const d = o.decay ?? 0.15;
  const s = o.sustain ?? 0.7;
  const rel = o.release ?? 0.08;
  const voices = o.voices ?? 1;
  const det = o.detune ?? 12;
  const out = new Float32Array(len(dur + rel + 0.01));
  const vib = o.vibrato;
  const glide = o.glideFrom;
  const gt = o.glideTime ?? 0.06;
  for (let v = 0; v < voices; v++) {
    const cents = voices === 1 ? 0 : det * ((2 * v) / (voices - 1) - 1);
    const mul = 2 ** (cents / 1200);
    let ph = r();
    for (let i = 0; i < out.length; i++) {
      const x = i / RATE;
      let f = freq;
      if (glide) f = freq * (glide / freq) ** Math.exp(-x / gt);
      if (vib && x > (vib.delay ?? 0.15)) f *= 2 ** ((vib.depth ?? 0.3) / 12 * Math.sin(2 * Math.PI * (vib.rate ?? 5.5) * x));
      f *= mul;
      const dt = f / RATE;
      ph += dt;
      if (ph >= 1) ph -= 1;
      out[i] += osc(wave, ph, dt) / voices;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= adsr(i / RATE, dur, a, d, s, rel);
  if (o.drive) for (let i = 0; i < out.length; i++) out[i] = Math.tanh(o.drive * out[i]) / Math.tanh(o.drive);
  if (o.cutoff) {
    const c0 = o.cutoff;
    const env = o.filterEnv ?? 0;
    const fd = o.filterDecay ?? 0.12;
    svf(out, env ? (x) => c0 + env * Math.exp(-x / fd) : c0, o.q ?? 0.9, 'lp');
  }
  return out;
}

export function piano(r, dur, freq, o = {}) {
  const rel = 0.25;
  const total = Math.min(dur + rel, 6);
  const out = new Float32Array(len(total));
  const B = 0.0004;
  const bright = o.bright ?? 1;
  for (let k = 1; k <= 12; k++) {
    const fk = freq * k * Math.sqrt(1 + B * k * k);
    if (fk > 9000) break;
    const amp = (1 / k ** 1.3) * (k > 1 ? bright : 1);
    const dk = 1 / (0.6 + 0.5 * k * (freq / 300));
    const ph = r() * 6.28;
    for (let i = 0; i < out.length; i++) {
      const x = i / RATE;
      out[i] += amp * Math.sin(2 * Math.PI * fk * x + ph) * Math.exp(-x / (dk * 2.5));
    }
  }
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    const relEnv = x < dur ? 1 : Math.max(0, 1 - (x - dur) / rel);
    let v = out[i] * relEnv * Math.min(1, i / (o.attack ?? 30));
    if (x < 0.004 && !o.soft) v += 0.15 * (r() * 2 - 1) * (1 - x / 0.004);
    out[i] = v;
  }
  return o.lp ? svf(out, o.lp) : out;
}

const VOWELS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240] };

export function vocal(r, dur, freq, o = {}) {
  const fm = VOWELS[o.vowel ?? 'a'];
  const rel = 0.12;
  const out = new Float32Array(len(dur + rel));
  const glide = o.glideFrom;
  const gt = o.glideTime ?? 0.08;
  const weights = [];
  for (let k = 1; k * freq < 5000; k++) {
    let w = 0.03;
    fm.forEach((F, j) => {
      const bw = 80 + 40 * j;
      w += (j === 0 ? 1 : 0.6 / j) * Math.exp(-0.5 * ((k * freq - F) / bw) ** 2);
    });
    weights.push(w / Math.sqrt(k));
  }
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const x = i / RATE;
    let f = freq;
    if (glide) f = freq * (glide / freq) ** Math.exp(-x / gt);
    if (x > 0.18) f *= 2 ** ((0.35 / 12) * Math.sin(2 * Math.PI * 5.3 * x) * Math.min(1, (x - 0.18) / 0.3));
    ph += f / RATE;
    if (ph > 1e6) ph -= 1e6;
    let v = 0;
    for (let k = 0; k < weights.length; k++) v += weights[k] * Math.sin(2 * Math.PI * (k + 1) * ph);
    v += 0.02 * (r() * 2 - 1);
    out[i] = v * adsr(x, dur, o.attack ?? 0.06, 0.1, 0.85, rel);
  }
  return out;
}

export function reverb(x, wet = 0.3, size = 1) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => Math.round(d * size));
  const out = new Float32Array(x.length);
  for (const d of combs) {
    const buf = new Float32Array(d);
    let idx = 0;
    let lp = 0;
    for (let i = 0; i < x.length; i++) {
      const y = buf[idx];
      lp = y * 0.75 + lp * 0.25;
      buf[idx] = x[i] + lp * 0.84;
      idx = idx + 1 === d ? 0 : idx + 1;
      out[i] += y / combs.length;
    }
  }
  for (const d of [225, 556, 441, 341]) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const b = buf[idx];
      const y = -out[i] + b;
      buf[idx] = out[i] + b * 0.5;
      out[i] = y;
      idx = idx + 1 === d ? 0 : idx + 1;
    }
  }
  for (let i = 0; i < x.length; i++) out[i] *= wet;
  return out;
}

export function vinyl(r, n, level = 0.01, rate = 8) {
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.997 * b0 + 0.03 * w;
    b1 = 0.6 * b1 + 0.4 * w;
    out[i] = level * (0.7 * b0 + 0.3 * b1);
    if (r() < rate / RATE) {
      const amp = level * (2 + 10 * r() ** 3);
      const l = 2 + Math.floor(r() * 30);
      for (let j = 0; j < l && i + j < n; j++) out[i + j] += amp * (r() * 2 - 1) * Math.exp(-j / 6);
    }
  }
  return out;
}

export function crowd(r, n, level = 0.02) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  svf(out, 900, 0.5, 'bp');
  let env = 1;
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0) env = 0.6 + 0.4 * r();
    out[i] *= level * env * 3;
  }
  return out;
}
