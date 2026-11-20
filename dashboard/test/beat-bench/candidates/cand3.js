export const name = 'cand3 tempogram + PLP + SuperFlux';

const TARGET_SR = 22050;
const WIN_SECS = 0.0464;
const HOP_SECS = 0.0058;
const BANDS_PER_OCT = 24;
const F_MIN = 27.5;
const F_MAX = 10000;
const SPLIT_LM = 150;
const SPLIT_MH = 2000;
const WIDE_PER_OCT = 2;
const BPM_MIN = 40;
const BPM_MAX = 250;
const BPM_STEPS_PER_OCT = 48;
const TG_WIN = 8;
const TG_HOP = 0.25;
const TG_SIGMA = 1.5;
const TG_JUMP = 20;
const PRIOR_CENTER = 120;
const PRIOR_OCT = 1;
const LEVEL_MIN = 58;
const LEVEL_MAX = 185;
const DOUBLE_RATIO = 0.8;
const BEAT_BAND_W = [1, 1, 0.5];
const DP_TIGHT = 100;
const PLP_WEIGHT = 0.5;
const PRE_MAX = 0.03;
const POST_MAX = 0.03;
const PRE_AVG = 0.1;
const POST_AVG = 0.07;
const COMBINE = 0.03;
const DELTA = 0.12;
const ABS_ALL = 1.6;
const ABS_HAT = 0.25;
const HAT_DELTA = 0.06;
const MASK = 0.3;
const RATIO = 2;
const MASK_SECS = 0.15;
const DB_BASS = 1;
const DB_HC = 1;
const DB_PEN = 0.85;
const HC_BEATS = 2;

function decimate(x, sr) {
  const q = Math.max(1, Math.round(sr / TARGET_SR));
  if (q === 1) return { y: x, sr };
  const taps = 16 * q + 1;
  const h = new Float32Array(taps);
  const fc = 0.45 / q;
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const s = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    h[i] = s * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor(x.length / q);
  const y = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const c = o * q;
    let acc = 0;
    const a = c - mid;
    if (a >= 0 && a + taps <= x.length) {
      for (let i = 0; i < taps; i++) acc += h[i] * x[a + i];
    } else {
      for (let i = 0; i < taps; i++) {
        const j = a + i;
        if (j >= 0 && j < x.length) acc += h[i] * x[j];
      }
    }
    y[o] = acc;
  }
  return { y, sr: sr / q };
}

function fftPlan(n) {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { n, rev, cos, sin };
}

function fft(re, im, plan) {
  const { n, rev, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w];
        const wi = sin[w];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function filterbank(N, sr) {
  const nb = N / 2 + 1;
  const binHz = sr / N;
  const fmax = Math.min(F_MAX, sr / 2 - binHz);
  const centers = [];
  for (let f = F_MIN; f <= fmax; f *= 2 ** (1 / BANDS_PER_OCT)) {
    const b = Math.round(f / binHz);
    if (b >= 1 && b < nb - 1 && (!centers.length || b > centers[centers.length - 1])) centers.push(b);
  }
  const filters = [];
  for (let i = 1; i + 1 < centers.length; i++) {
    const lo = centers[i - 1];
    const c = centers[i];
    const hi = centers[i + 1];
    const w = [];
    let s = 0;
    for (let k = lo; k <= hi; k++) {
      let v = k <= c ? (k - lo + 1) / (c - lo + 1) : (hi - k + 1) / (hi - c + 1);
      if (c - lo <= 1 && k < c) v = 0;
      if (hi - c <= 1 && k > c) v = 0;
      w.push(v);
      s += v;
    }
    for (let j = 0; j < w.length; j++) w[j] /= s;
    filters.push({ lo, w: Float32Array.from(w), hz: c * binHz });
  }
  return filters;
}

function spectrogram(x, sr) {
  const N = 2 ** Math.round(Math.log2(WIN_SECS * sr));
  const H = Math.max(1, Math.round(HOP_SECS * sr));
  const n = Math.max(1, Math.floor(x.length / H) + 1);
  const plan = fftPlan(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const fb = filterbank(N, sr);
  const B = fb.length;
  const S = new Float32Array(n * B);
  const wide = fb.map((f) => (f.hz >= SPLIT_MH ? Math.floor(WIDE_PER_OCT * Math.log2(f.hz / SPLIT_MH)) : -1));
  const NW = Math.max(0, ...wide) + 1;
  const Wd = new Float32Array(n * NW);
  const rms = new Float32Array(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const magA = new Float64Array(N / 2 + 1);
  const magB = new Float64Array(N / 2 + 1);
  const half = N / 2;
  const fill = (buf, f) => {
    const start = f * H - half;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const v = j >= 0 && j < x.length ? x[j] : 0;
      buf[i] = v * win[i];
      e += v * v;
    }
    rms[f] = Math.sqrt(e / N);
  };
  const tmp = new Float64Array(N);
  const apply = (mag, f) => {
    const row = f * B;
    for (let b = 0; b < B; b++) {
      const { lo, w } = fb[b];
      let s = 0;
      for (let j = 0; j < w.length; j++) s += w[j] * mag[lo + j];
      S[row + b] = Math.log10(1 + s);
      if (wide[b] >= 0) Wd[f * NW + wide[b]] += s;
    }
  };
  for (let f = 0; f < n; f += 2) {
    fill(re, f);
    if (f + 1 < n) fill(tmp, f + 1);
    else tmp.fill(0);
    for (let i = 0; i < N; i++) im[i] = tmp[i];
    fft(re, im, plan);
    for (let k = 0; k <= half; k++) {
      const k2 = (N - k) % N;
      const ar = (re[k] + re[k2]) / 2;
      const ai = (im[k] - im[k2]) / 2;
      const br = (im[k] + im[k2]) / 2;
      const bi = (re[k2] - re[k]) / 2;
      magA[k] = Math.hypot(ar, ai);
      magB[k] = Math.hypot(br, bi);
    }
    apply(magA, f);
    if (f + 1 < n) apply(magB, f + 1);
  }
  for (let i = 0; i < Wd.length; i++) Wd[i] = Math.log10(1 + Wd[i]);
  return { S, n, B, fb, fr: sr / H, rms, N, H, Wd, NW };
}

function superflux(spec, mu) {
  const { S, n, B, fb } = spec;
  const groups = fb.map((f) => (f.hz < SPLIT_LM ? 0 : f.hz < SPLIT_MH ? 1 : 2));
  const band = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const total = new Float32Array(n);
  const peaky = new Float32Array(n);
  for (let f = mu; f < n; f++) {
    const cur = f * B;
    const prev = (f - mu) * B;
    let mMax = 0;
    let mSum = 0;
    for (let b = 0; b < B; b++) {
      let m = S[prev + b];
      if (b > 0 && S[prev + b - 1] > m) m = S[prev + b - 1];
      if (b + 1 < B && S[prev + b + 1] > m) m = S[prev + b + 1];
      const d = S[cur + b] - m;
      if (d > 0) {
        band[groups[b]][f] += d;
        if (groups[b] === 1) {
          mSum += d;
          if (d > mMax) mMax = d;
        }
      }
    }
    total[f] = band[0][f] + band[1][f] + band[2][f];
    peaky[f] = mSum > 0 ? mMax / mSum : 0;
  }
  return { band, total, peaky };
}

function movingMean(x, a, b) {
  const n = x.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - a);
    const hi = Math.min(n - 1, i + b);
    out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
  }
  return out;
}

function movingMax(x, a, b) {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - a); k <= Math.min(n - 1, i + b); k++) if (x[k] > m) m = x[k];
    out[i] = m;
  }
  return out;
}

function percentile(x, p) {
  const s = Float32Array.from(x).sort();
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function parabolic(a, b, c) {
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}

function bpmGrid() {
  const out = [];
  for (let b = BPM_MIN; b <= BPM_MAX * 1.0001; b *= 2 ** (1 / BPM_STEPS_PER_OCT)) out.push(b);
  return Float64Array.from(out);
}

function tempogram(nov, fr) {
  const bpms = bpmGrid();
  const K = bpms.length;
  const W = Math.round(TG_WIN * fr);
  const hop = Math.max(1, Math.round(TG_HOP * fr));
  const n = nov.length;
  const centers = [];
  for (let c = 0; c < n; c += hop) centers.push(c);
  if (!centers.length) centers.push(0);
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / W);
  const maxLag = Math.ceil((60 * fr) / BPM_MIN) + 2;
  const wacf = new Float64Array(maxLag + 1);
  for (let L = 0; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < W; i++) s += win[i] * win[i + L];
    wacf[L] = s;
  }
  const freqs = new Float64Array(K);
  for (let k = 0; k < K; k++) freqs[k] = bpms[k] / 60 / fr;
  const T = centers.length;
  const F = new Float32Array(T * K);
  const A = new Float32Array(T * K);
  const C = new Float32Array(T * K);
  const re = new Float32Array(T * K);
  const im = new Float32Array(T * K);
  const seg = new Float64Array(W);
  const acf = new Float64Array(maxLag + 1);
  const energy = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const start = centers[t] - (W >> 1);
    let e = 0;
    for (let i = 0; i < W; i++) {
      const j = start + i;
      seg[i] = j >= 0 && j < n ? nov[j] * win[i] : 0;
      e += seg[i] * seg[i];
    }
    energy[t] = e;
    let fMax = 1e-12;
    for (let k = 0; k < K; k++) {
      const w = 2 * Math.PI * freqs[k];
      const cr = Math.cos(w);
      const ci = -Math.sin(w);
      let pr = Math.cos(-w * start);
      let pi = Math.sin(-w * start);
      let sr = 0;
      let si = 0;
      for (let i = 0; i < W; i++) {
        const v = seg[i];
        if (v !== 0) {
          sr += v * pr;
          si += v * pi;
        }
        const nr = pr * cr - pi * ci;
        pi = pr * ci + pi * cr;
        pr = nr;
      }
      re[t * K + k] = sr;
      im[t * K + k] = si;
      const m = Math.hypot(sr, si);
      F[t * K + k] = m;
      if (m > fMax) fMax = m;
    }
    for (let L = 0; L <= maxLag; L++) {
      let s = 0;
      for (let i = 0; i + L < W; i++) s += seg[i] * seg[i + L];
      acf[L] = wacf[L] > 0 ? s / wacf[L] : 0;
    }
    let aMax = 1e-12;
    for (let k = 0; k < K; k++) {
      const lag = (60 * fr) / bpms[k];
      const l0 = Math.floor(lag);
      const fr0 = lag - l0;
      const v = Math.max(0, acf[l0] * (1 - fr0) + acf[Math.min(maxLag, l0 + 1)] * fr0);
      A[t * K + k] = v;
      if (v > aMax) aMax = v;
    }
    for (let k = 0; k < K; k++) {
      const f = F[t * K + k] / fMax;
      const a = A[t * K + k] / aMax;
      C[t * K + k] = Math.sqrt(f * a);
    }
  }
  return { bpms, K, T, centers, hop, W, F, A, C, re, im, energy };
}

function viterbi(tg, prior, active) {
  const { K, T, C } = tg;
  const sig = TG_SIGMA;
  const jump = TG_JUMP;
  const trans = new Float64Array(K * K);
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    const d = Math.abs(a - b);
    trans[a * K + b] = Math.max(-(d * d) / (2 * sig * sig), -jump);
  }
  let score = new Float64Array(K);
  let next = new Float64Array(K);
  const back = new Int16Array(T * K);
  const emit = (t, k) => {
    const w = active[t] ? 1 : 0.05;
    return w * Math.log(C[t * K + k] * prior[k] + 0.02);
  };
  for (let k = 0; k < K; k++) score[k] = emit(0, k);
  for (let t = 1; t < T; t++) {
    for (let b = 0; b < K; b++) {
      let best = -Infinity;
      let arg = 0;
      for (let a = 0; a < K; a++) {
        const v = score[a] + trans[a * K + b];
        if (v > best) {
          best = v;
          arg = a;
        }
      }
      next[b] = best + emit(t, b);
      back[t * K + b] = arg;
    }
    const s = score;
    score = next;
    next = s;
  }
  let end = 0;
  for (let k = 1; k < K; k++) if (score[k] > score[end]) end = k;
  const path = new Int32Array(T);
  path[T - 1] = end;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * K + path[t]];
  return path;
}

function pathBpm(tg, path) {
  const { K, C, bpms } = tg;
  const out = new Float64Array(path.length);
  const step = Math.log2(bpms[1] / bpms[0]);
  for (let t = 0; t < path.length; t++) {
    const k = path[t];
    const row = t * K;
    const d = k > 0 && k < K - 1 ? parabolic(C[row + k - 1], C[row + k], C[row + k + 1]) : 0;
    out[t] = bpms[k] * 2 ** (d * step);
  }
  return out;
}

function median(a) {
  const s = Float64Array.from(a).sort();
  return s.length ? s[s.length >> 1] : 0;
}

function framePeriod(tg, bpmPath, n, fr) {
  const P = new Float32Array(n);
  const { centers } = tg;
  let j = 0;
  for (let f = 0; f < n; f++) {
    while (j + 1 < centers.length && centers[j + 1] <= f) j++;
    let bpm;
    if (j + 1 < centers.length) {
      const a = centers[j];
      const b = centers[j + 1];
      const u = Math.min(1, Math.max(0, (f - a) / (b - a)));
      bpm = Math.exp(Math.log(bpmPath[j]) * (1 - u) + Math.log(bpmPath[j + 1]) * u);
    } else bpm = bpmPath[j];
    P[f] = (60 * fr) / bpm;
  }
  return P;
}

function plp(nov, fr, bpmPath, tg) {
  const n = nov.length;
  const W = tg.W;
  const out = new Float32Array(n);
  const norm = new Float32Array(n);
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / W);
  for (let t = 0; t < tg.centers.length; t++) {
    const start = tg.centers[t] - (W >> 1);
    const w = (2 * Math.PI * bpmPath[t]) / 60 / fr;
    let sr = 0;
    let si = 0;
    for (let i = 0; i < W; i++) {
      const j = start + i;
      if (j < 0 || j >= n) continue;
      const v = nov[j] * win[i];
      sr += v * Math.cos(w * j);
      si -= v * Math.sin(w * j);
    }
    const ph = Math.atan2(si, sr);
    for (let i = 0; i < W; i++) {
      const j = start + i;
      if (j < 0 || j >= n) continue;
      out[j] += win[i] * Math.cos(w * j + ph);
      norm[j] += win[i];
    }
  }
  for (let i = 0; i < n; i++) out[i] = norm[i] > 0 ? Math.max(0, out[i] / norm[i]) : 0;
  return out;
}

function trackBeats(env, P, lo, hi) {
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = lo; t <= hi; t++) {
    const p = P[t];
    const a = Math.max(lo, Math.round(t - 2 * p));
    const b = Math.round(t - p / 2);
    let best = -Infinity;
    let arg = -1;
    for (let q = a; q <= b; q++) {
      const r = Math.log((t - q) / p);
      const v = score[q] - DP_TIGHT * r * r;
      if (v > best) {
        best = v;
        arg = q;
      }
    }
    if (arg >= 0 && best > 0) {
      score[t] = env[t] + best;
      back[t] = arg;
    } else score[t] = env[t];
  }
  let end = hi;
  const tail = Math.max(lo, Math.round(hi - P[hi]));
  for (let t = tail; t <= hi; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  return frames.reverse();
}

function pickOnsets(sf, fr, rel, abs) {
  const n = sf.length;
  const mw = Math.round(MASK_SECS * fr);
  const pm = Math.round(PRE_MAX * fr);
  const qm = Math.round(POST_MAX * fr);
  const pa = Math.round(PRE_AVG * fr);
  const qa = Math.round(POST_AVG * fr);
  const comb = Math.round(COMBINE * fr);
  const mx = movingMax(sf, pm, qm);
  const mn = movingMean(sf, pa, qa);
  const out = [];
  let last = -Infinity;
  for (let f = 1; f < n - 1; f++) {
    const v = sf[f];
    if (v !== mx[f] || v < mn[f] + rel || v < abs || v < RATIO * mn[f]) continue;
    let pm2 = 0;
    for (let k = Math.max(0, f - mw); k < f - comb; k++) if (sf[k] > pm2) pm2 = sf[k];
    if (v < MASK * pm2) continue;
    if (f - last <= comb) continue;
    last = f;
    out.push(f);
  }
  return out;
}

function chromaOf(spec, a, b) {
  const { S, B, fb } = spec;
  const c = new Float64Array(12);
  for (let f = Math.max(0, a); f < Math.min(spec.n, b); f++) {
    const row = f * B;
    for (let k = 0; k < B; k++) {
      const hz = fb[k].hz;
      if (hz < 60 || hz > 2200) continue;
      const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12;
      c[pc] += S[row + k];
    }
  }
  let s = 0;
  for (let i = 0; i < 12; i++) s += c[i] * c[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < 12; i++) c[i] /= s;
  return c;
}

function zscore(x) {
  const n = x.length;
  if (!n) return x;
  let m = 0;
  for (const v of x) m += v;
  m /= n;
  let s = 0;
  for (const v of x) s += (v - m) ** 2;
  s = Math.sqrt(s / n) || 1;
  return x.map((v) => (v - m) / s);
}

function localPeak(x, f, r) {
  let m = 0;
  for (let k = Math.max(0, f - r); k <= Math.min(x.length - 1, f + r); k++) if (x[k] > m) m = x[k];
  return m;
}

export function analyze(mono, sampleRate) {
  const { y, sr } = decimate(mono, sampleRate);
  let e = 0;
  for (let i = 0; i < y.length; i++) e += y[i] * y[i];
  const g = 0.1 / Math.max(1e-6, Math.sqrt(e / Math.max(1, y.length)));
  const x = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) x[i] = y[i] * g;
  const spec = spectrogram(x, sr);
  const { n, fr } = spec;
  const mu = Math.max(1, Math.round(0.0116 * fr));
  const { band, total, peaky } = superflux(spec, mu);
  const sfTop = percentile(total, 0.98) || 1;
  const sf = total.map((v) => v / sfTop);
  const bandN = band.map((b) => {
    const t = percentile(b, 0.98) || 1;
    return b.map((v) => v / t);
  });
  const rmsMax = spec.rms.reduce((a, v) => (v > a ? v : a), 0) || 1;
  const live = new Uint8Array(n);
  for (let f = 0; f < n; f++) live[f] = spec.rms[f] > rmsMax * 0.003 ? 1 : 0;
  let first = 0;
  while (first < n && !live[first]) first++;
  let lastF = n - 1;
  while (lastF > 0 && !live[lastF]) lastF--;
  if (first >= lastF) return { bpm: 120, beats: [], downbeats: [], onsets: [] };

  const lm = movingMean(sf, Math.round(0.5 * fr), Math.round(0.5 * fr));
  const nov = new Float32Array(n);
  for (let f = 0; f < n; f++) nov[f] = Math.max(0, sf[f] - lm[f]);
  const tg = tempogram(nov, fr);
  const prior = Float64Array.from(tg.bpms, (b) => Math.exp(-0.5 * (Math.log2(b / PRIOR_CENTER) / PRIOR_OCT) ** 2));
  const eMax = tg.energy.reduce((a, v) => (v > a ? v : a), 0) || 1;
  const active = Array.from(tg.energy, (v) => v > eMax * 0.01);
  const path = viterbi(tg, prior, active);
  let bpmPath = pathBpm(tg, path);
  const mainOf = (p) => {
    const a = p.filter((_, t) => active[t]);
    return median(a.length ? a : p);
  };
  let fold = 1;
  while (mainOf(bpmPath) * fold > LEVEL_MAX) fold /= 2;
  while (mainOf(bpmPath) * fold < LEVEL_MIN) fold *= 2;
  bpmPath = bpmPath.map((b) => b * fold);
  {
    const main = mainOf(bpmPath);
    bpmPath = bpmPath.map((b) => {
      let v = b;
      while (v > main * Math.SQRT2) v /= 2;
      while (v < main / Math.SQRT2) v *= 2;
      return v;
    });
  }

  const snareN = bandN[1].map((v, i) => Math.sqrt(v * bandN[2][i]));
  const bnov = new Float32Array(n);
  {
    const w = Math.round(0.5 * fr);
    for (let b = 0; b < 3; b++) {
      const m = movingMean(bandN[b], w, w);
      for (let f = 0; f < n; f++) bnov[f] += BEAT_BAND_W[b] * Math.max(0, bandN[b][f] - m[f]);
    }
  }
  let sd = 0;
  for (let f = 0; f < n; f++) sd += bnov[f] * bnov[f];
  sd = Math.sqrt(sd / n) || 1;
  const lo = Math.max(0, first);
  const hi = Math.max(lo + 1, lastF);
  const track = (bp) => {
    const P = framePeriod(tg, bp, n, fr);
    const pl = plp(bnov, fr, bp, tg);
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) env[f] = bnov[f] / sd + PLP_WEIGHT * pl[f];
    return { P, frames: trackBeats(env, P, lo, hi).filter((f) => f >= first - 0.3 * P[f] && f <= lastF) };
  };
  const accent = (f) => localPeak(bandN[0], Math.round(f), 2) + localPeak(bandN[1], Math.round(f), 2);
  const onMid = (frames) => {
    let on = 0;
    let mid = 0;
    for (let i = 0; i + 1 < frames.length; i++) {
      on += accent(frames[i]);
      mid += accent((frames[i] + frames[i + 1]) / 2);
    }
    return { on, mid };
  };
  let tr = track(bpmPath);
  if (tr.frames.length > 8) {
    const { on, mid } = onMid(tr.frames);
    if (mainOf(bpmPath) * 2 <= LEVEL_MAX && mid >= DOUBLE_RATIO * on) {
      bpmPath = bpmPath.map((b) => b * 2);
      tr = track(bpmPath);
    }
    const pr = [0, 0, 0, 0];
    for (let i = 0; i + 1 < tr.frames.length; i++) {
      pr[(i % 2) * 2] += localPeak(snareN, tr.frames[i], 2);
      pr[(i % 2) * 2 + 1] += localPeak(snareN, Math.round((tr.frames[i] + tr.frames[i + 1]) / 2), 2);
    }
    if (Math.max(pr[1], pr[3]) > Math.max(pr[0], pr[2])) {
      const shifted = [];
      for (let i = 0; i + 1 < tr.frames.length; i++) shifted.push(Math.round((tr.frames[i] + tr.frames[i + 1]) / 2));
      tr = { P: tr.P, frames: shifted };
    }
  }
  const bpm = mainOf(bpmPath);
  const P = tr.P;
  const beatFrames = tr.frames;
  const beats = beatFrames.map((f) => f / fr);

  const bassAt = beatFrames.map((f) => localPeak(bandN[0], f, 2));
  const hc = beatFrames.map((f, i) => {
    if (i === 0) return 0;
    const w = HC_BEATS;
    const a = chromaOf(spec, beatFrames[Math.max(0, i - w)], f);
    const b = chromaOf(spec, f, i + w < beatFrames.length ? beatFrames[i + w] : f + Math.round(w * P[f]));
    let d = 0;
    for (let k = 0; k < 12; k++) d += a[k] * b[k];
    return 1 - d;
  });
  const zb = zscore(bassAt);
  const zh = zscore(hc);
  const dscore = zb.map((v, i) => DB_BASS * v + DB_HC * zh[i]);
  let bestM = 4;
  let bestP = 0;
  let bestC = -Infinity;
  for (const M of [4, 3, 2]) {
    for (let p = 0; p < M; p++) {
      let on = 0;
      let cn = 0;
      let off = 0;
      let co = 0;
      for (let i = 0; i < dscore.length; i++) {
        if ((i - p) % M === 0) {
          on += dscore[i];
          cn++;
        } else {
          off += dscore[i];
          co++;
        }
      }
      const c = (cn ? on / cn : 0) - (co ? off / co : 0);
      const adj = M === 4 ? c : c * DB_PEN;
      if (adj > bestC) {
        bestC = adj;
        bestM = M;
        bestP = p;
      }
    }
  }
  const downbeats = beats.filter((_, i) => i >= bestP && (i - bestP) % bestM === 0);

  const pAll = pickOnsets(total, fr, DELTA * sfTop, ABS_ALL);
  const wf = new Float32Array(n);
  for (let f = mu; f < n; f++) {
    let a = 0;
    for (let k = 0; k < spec.NW; k++) {
      const d = spec.Wd[f * spec.NW + k] - spec.Wd[(f - mu) * spec.NW + k];
      if (d > 0) a += d;
    }
    wf[f] = a;
  }
  const hTop = percentile(wf, 0.98) || 1;
  const pHat = pickOnsets(wf, fr, HAT_DELTA * hTop, ABS_HAT);
  const comb = Math.round(COMBINE * fr);
  const peaks = [];
  for (const f of [...pAll, ...pHat].sort((a, b) => a - b)) if (!peaks.length || f - peaks[peaks.length - 1] > comb) peaks.push(f);
  const onsets = peaks.map((f) => {
    const v = [bandN[0][f], bandN[1][f], bandN[2][f]];
    let bi = 0;
    if (v[1] > v[bi]) bi = 1;
    if (v[2] > v[bi]) bi = 2;
    const id = 'LMH'[bi];
    const kind = bi === 0 ? 'kick' : bi === 2 ? 'hat' : peaky[f] > 0.25 ? 'tonal' : 'snare';
    const t = f / fr;
    return { t, raw: t, band: id, kind, strength: Math.round(sf[f] * 1000) / 1000 };
  });
  return { bpm: Math.round(bpm * 100) / 100, beats, downbeats, onsets, tempoCurve: Array.from(tg.centers, (c, i) => [c / fr, Math.round(bpmPath[i] * 10) / 10]) };
}
