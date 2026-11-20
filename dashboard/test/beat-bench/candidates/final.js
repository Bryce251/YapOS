export const name = 'final';

const FPS = 100;
const LAMBDA = 2;

function fftTables(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return { rev, cos, sin };
}

function fft(re, im, t) {
  const n = re.length;
  const { rev, cos, sin } = t;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let x = re[i]; re[i] = re[j]; re[j] = x;
      x = im[i]; im[i] = im[j]; im[j] = x;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = s + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function filterbank(n, sr, lo, hi, perOct) {
  const nb = n / 2 + 1;
  const count = Math.floor(Math.log2(hi / lo) * perOct);
  const centers = [];
  for (let i = 0; i <= count + 1; i++) centers.push(lo * 2 ** (i / perOct));
  const bins = centers.map((f) => (f * n) / sr);
  const bands = [];
  let last = -1;
  for (let b = 1; b <= count; b++) {
    let a = bins[b - 1];
    let c = bins[b];
    let e = bins[b + 1];
    let start = Math.floor(a);
    let stop = Math.ceil(e);
    if (stop - start < 2 || Math.round(c) <= last) {
      const ci = Math.max(last + 1, Math.round(c));
      if (ci >= nb) break;
      bands.push({ start: ci, w: Float32Array.of(1), f: centers[b] });
      last = ci;
      continue;
    }
    stop = Math.min(stop, nb - 1);
    const w = new Float32Array(stop - start + 1);
    let sum = 0;
    for (let k = start; k <= stop; k++) {
      const v = k <= c ? (k - a) / (c - a) : (e - k) / (e - c);
      w[k - start] = Math.max(0, v);
      sum += w[k - start];
    }
    if (sum <= 0) continue;
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    bands.push({ start, w, f: centers[b] });
    last = Math.round(c);
  }
  return bands;
}

function spectrogram(mono, sr) {
  const hop = sr / FPS;
  let n = 1;
  while (n < sr * 0.046) n <<= 1;
  const frames = Math.max(1, Math.ceil(mono.length / hop));
  const bands = filterbank(n, sr, 29.1352, Math.min(16000, sr / 2 - 1), 12);
  const nbands = bands.length;
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const t = fftTables(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float32Array(n / 2 + 1);
  const spec = new Float32Array(frames * nbands);
  const half = n / 2;
  for (let f = 0; f < frames; f++) {
    const c = Math.round(f * hop) - half;
    for (let i = 0; i < n; i++) {
      const j = c + i;
      re[i] = j >= 0 && j < mono.length ? mono[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im, t);
    for (let k = 0; k <= half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const row = f * nbands;
    for (let b = 0; b < nbands; b++) {
      const { start, w } = bands[b];
      let s = 0;
      for (let k = 0; k < w.length; k++) s += mag[start + k] * w[k];
      spec[row + b] = Math.log1p(s * LAMBDA);
    }
  }
  return { spec, frames, nbands, freqs: bands.map((b) => b.f) };
}

function movingMean(x, r) {
  const n = x.length;
  const out = new Float32Array(n);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r);
    const b = Math.min(n - 1, i + r);
    while (hi < b) s += x[++hi];
    while (lo < a) s -= x[lo++];
    out[i] = s / (b - a + 1);
  }
  return out;
}

function movingMedian(x, r, step = 4) {
  const n = x.length;
  const out = new Float32Array(n);
  const pts = [];
  for (let i = 0; i < n; i += step) {
    const a = Math.max(0, i - r);
    const b = Math.min(n, i + r + 1);
    const w = Array.from(x.subarray(a, b)).sort((p, q) => p - q);
    pts.push([i, w[w.length >> 1]]);
  }
  for (let k = 0; k < pts.length; k++) {
    const [i0, v0] = pts[k];
    const [i1, v1] = pts[Math.min(k + 1, pts.length - 1)];
    for (let i = i0; i < Math.min(n, i0 + step); i++) out[i] = i1 > i0 ? v0 + ((v1 - v0) * (i - i0)) / (i1 - i0) : v0;
  }
  return out;
}

function flux(sp, lag = 2, wid = 1) {
  const { spec, frames, nbands, freqs } = sp;
  const odf = new Float32Array(frames);
  const bandIdx = freqs.map((f) => (f < 200 ? 0 : f < 2000 ? 1 : 2));
  const bandOdf = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  for (let f = lag; f < frames; f++) {
    const cur = f * nbands;
    const prev = (f - lag) * nbands;
    let s = 0;
    for (let b = 0; b < nbands; b++) {
      let p = spec[prev + b];
      for (let k = Math.max(0, b - wid); k <= Math.min(nbands - 1, b + wid); k++) if (spec[prev + k] > p) p = spec[prev + k];
      const d = spec[cur + b] - p;
      if (d > 0) {
        s += d;
        bandOdf[bandIdx[b]][f] += d;
      }
    }
    odf[f] = s;
  }
  return { odf, bandOdf };
}

function peaks(x, pf, pa, pm) {
  const n = x.length;
  const mean = movingMean(x, 10);
  const med = movingMedian(x, 50);
  let mx = 0;
  for (let i = 0; i < n; i++) if (x[i] > mx) mx = x[i];
  const floor = mx * pf;
  const out = [];
  let lastT = -1e9;
  for (let i = 1; i < n - 1; i++) {
    const v = x[i];
    if (v < floor || v <= 0) continue;
    let isMax = true;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (x[k] > v || (x[k] === v && k < i)) { isMax = false; break; }
    if (!isMax) continue;
    const th = Math.max(mean[i] * pa + floor * 0.5, med[i] * pm + floor);
    if (v < th) continue;
    if (i - lastT < 3) continue;
    out.push({ i, v, c: v / (th || 1e-9) });
    lastT = i;
  }
  return out;
}

function pickOnsets(odf, bandOdf) {
  const cands = [];
  for (const p of peaks(odf, 0.02, 1, 3)) {
    let band = 0;
    let best = -1;
    const scale = [1.6, 1, 1];
    for (let b = 0; b < 3; b++) {
      const bv = bandOdf[b][p.i] * scale[b];
      if (bv > best) { best = bv; band = b; }
    }
    cands.push({ ...p, band: 'LMH'[band], full: 1 });
  }
  for (let b = 0; b < 3; b++) for (const p of peaks(bandOdf[b], 0.02, 1.5, 4)) cands.push({ ...p, v: odf[p.i], band: 'LMH'[b], full: 0 });
  cands.sort((x, y) => x.i - y.i);
  const out = [];
  for (const c of cands) {
    const last = out[out.length - 1];
    if (last && c.i - last.i < 3) {
      if (c.c > last.c && !last.full) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

function autocorr(x, minLag, maxLag) {
  const n = x.length;
  const ac = new Float32Array(maxLag + 1);
  for (let L = minLag; L <= maxLag; L++) {
    let s = 0;
    for (let i = L; i < n; i++) s += x[i] * x[i - L];
    ac[L] = s / (n - L);
  }
  return ac;
}

function interpPeak(ac, L) {
  const a = ac[L - 1];
  const b = ac[L];
  const c = ac[L + 1];
  const d = a - 2 * b + c;
  return d < 0 ? L + (0.5 * (a - c)) / d : L;
}

function acMax(ac, L, tol = 0.04) {
  const a = Math.max(1, Math.floor(L * (1 - tol)));
  const b = Math.min(ac.length - 1, Math.ceil(L * (1 + tol)));
  let m = 0;
  for (let i = a; i <= b; i++) if (ac[i] > m) m = ac[i];
  return m;
}

function centered(odf) {
  const m = movingMean(odf, 50);
  const out = new Float32Array(odf.length);
  for (let i = 0; i < odf.length; i++) out[i] = Math.max(0, odf[i] - m[i]);
  return out;
}

function tempoEstimate(ac) {
  const minLag = Math.round((60 * FPS) / 240);
  const maxLag = Math.round((60 * FPS) / 40);
  const score = new Float32Array(maxLag + 1);
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * FPS) / L;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 130) / 1.3) ** 2);
    const harm = ac[L] + 0.5 * acMax(ac, 2 * L) + 0.5 * acMax(ac, L / 2);
    score[L] = harm * prior;
  }
  let best = minLag;
  for (let L = minLag + 1; L < maxLag; L++) if (score[L] > score[best]) best = L;
  const lag = interpPeak(score, best);
  return { lag, bpm: (60 * FPS) / lag, score };
}

function localPeriods(oenv, lag0, frames) {
  const W = 600;
  const step = 50;
  const minL = Math.max(10, Math.floor(lag0 * 0.7));
  const maxL = Math.ceil(lag0 * 1.4);
  const cands = [];
  for (let c = 0; c < frames; c += step) {
    const a = Math.max(0, c - W / 2);
    const b = Math.min(frames, c + W / 2);
    const row = [];
    for (let L = minL; L <= maxL; L++) {
      let s = 0;
      for (let i = a + L; i < b; i++) s += oenv[i] * oenv[i - L];
      row.push(s / Math.max(1, b - a - L));
    }
    let mx = 0;
    for (const v of row) if (v > mx) mx = v;
    cands.push(row.map((v) => (mx > 0 ? v / mx : 0)));
  }
  const nL = maxL - minL + 1;
  const T = cands.length;
  const dp = new Float32Array(T * nL);
  const bp = new Int32Array(T * nL);
  for (let j = 0; j < nL; j++) dp[j] = cands[0][j] - 0.5 * Math.log2((minL + j) / lag0) ** 2 * 20;
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < nL; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let k = 0; k < nL; k++) {
        const d = Math.log2((minL + j) / (minL + k));
        const v = dp[(t - 1) * nL + k] - 1600 * d * d;
        if (v > best) { best = v; arg = k; }
      }
      dp[t * nL + j] = best + cands[t][j];
      bp[t * nL + j] = arg;
    }
  }
  let j = 0;
  for (let k = 1; k < nL; k++) if (dp[(T - 1) * nL + k] > dp[(T - 1) * nL + j]) j = k;
  const path = new Float32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = minL + j;
    j = bp[t * nL + j];
  }
  const per = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const x = f / step;
    const i = Math.min(T - 1, Math.floor(x));
    const k = Math.min(T - 1, i + 1);
    const fr = Math.min(1, x - i);
    per[f] = path[i] * (1 - fr) + path[k] * fr;
  }
  return per;
}

function trackBeats(oenv, per, tight = 100) {
  const n = oenv.length;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += oenv[i] * oenv[i];
  sd = Math.sqrt(sd / n) || 1;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = oenv[i] / sd;
  const C = new Float32Array(n);
  const B = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const P = per[t];
    const a = Math.max(0, Math.round(t - 2 * P));
    const b = Math.round(t - P / 2);
    let best = 0;
    let arg = -1;
    for (let s = a; s <= b; s++) {
      const r = Math.log((t - s) / P);
      const v = C[s] - tight * r * r;
      if (v > best) { best = v; arg = s; }
    }
    C[t] = o[t] + best;
    B[t] = arg;
  }
  const tailP = per[n - 1];
  let end = n - 1;
  let mx = -Infinity;
  for (let t = Math.max(0, Math.round(n - 1 - tailP * 1.5)); t < n; t++) if (C[t] > mx) { mx = C[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = B[t]) {
    beats.push(t);
    if (B[t] < 0) break;
  }
  return beats.reverse();
}

function activeRange(odf) {
  const n = odf.length;
  let mx = 0;
  for (let i = 0; i < n; i++) if (odf[i] > mx) mx = odf[i];
  const thr = mx * 0.1;
  let a = 0;
  while (a < n && odf[a] < thr) a++;
  let b = n - 1;
  while (b > a && odf[b] < thr) b--;
  return [a, b];
}

function chroma(sp, a, b) {
  const { spec, frames, nbands, freqs } = sp;
  const c = new Float64Array(12);
  for (let f = Math.max(0, a); f < Math.min(frames, b); f++) {
    const row = f * nbands;
    for (let k = 0; k < nbands; k++) {
      const hz = freqs[k];
      if (hz < 200 || hz > 2500) continue;
      c[(((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12)] += spec[row + k];
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

function barPhase(sp, beats, low) {
  if (beats.length < 8) return { meter: 4, phase: 0 };
  const lowN = centered(low);
  const bass = beats.map((f) => {
    let m = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(lowN.length - 1, f + 4); k++) if (lowN[k] > m) m = lowN[k];
    return m;
  });
  const hc = beats.map((f, i) => {
    if (i === 0) return 0;
    const per = i + 1 < beats.length ? beats[i + 1] - f : f - beats[i - 1];
    const x = chroma(sp, beats[Math.max(0, i - 2)], f);
    const y = chroma(sp, f, i + 2 < beats.length ? beats[i + 2] : f + 2 * per);
    let d = 0;
    for (let k = 0; k < 12; k++) d += x[k] * y[k];
    return 1 - d;
  });
  const zb = zscore(bass);
  const zh = zscore(hc);
  const clip = (v) => Math.max(-2.5, Math.min(2.5, v));
  const score = zb.map((v, i) => (i === 0 ? 0 : 0.6 * clip(v) + clip(zh[i])));
  let best = { meter: 4, phase: 0, c: -Infinity };
  for (const M of [4, 3, 2]) {
    for (let p = 0; p < M; p++) {
      let on = 0;
      let cn = 0;
      let off = 0;
      let co = 0;
      for (let i = 0; i < score.length; i++) {
        if ((i - p) % M === 0) { on += score[i]; cn++; } else { off += score[i]; co++; }
      }
      const c = ((cn ? on / cn : 0) - (co ? off / co : 0)) * (M === 4 ? 1 : 0.85);
          if (c > best.c) best = { meter: M, phase: p, c };
    }
  }
  if (best.meter === 4) {
    const m = [0, 0, 0, 0];
    const c = [0, 0, 0, 0];
    score.forEach((v, i) => { m[i % 4] += v; c[i % 4] += 1; });
    const a = m.map((v, i) => v / (c[i] || 1));
    const p = best.phase;
    const off = (a[(p + 1) % 4] + a[(p + 3) % 4]) / 2;
    if (a[(p + 2) % 4] - off > 0.75 * (a[p] - off)) return { meter: 2, phase: p % 2 };
  }
  return best;
}

function bandEnergy(sp, lo, hi) {
  const { spec, frames, nbands, freqs } = sp;
  const e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let b = 0; b < nbands; b++) {
      if (freqs[b] < lo || freqs[b] >= hi) continue;
      const v = Math.expm1(spec[f * nbands + b]);
      s += v * v;
    }
    e[f] = s;
  }
  return e;
}

function peakAt(e, f) {
  let m = 0;
  for (let k = Math.max(0, f - 2); k <= Math.min(e.length - 1, f + 5); k++) if (e[k] > m) m = e[k];
  return m;
}

function gridScore(frames, envs) {
  let s = 0;
  for (const e of envs) {
    let a = 0;
    for (const f of frames) a += peakAt(e, f);
    s += Math.log((a + 1e-9) / Math.max(1, frames.length));
  }
  return s;
}

function midpoints(beats, n) {
  const out = [];
  for (let i = 0; i + 1 < beats.length; i++) out.push(Math.round((beats[i] + beats[i + 1]) / 2));
  if (beats.length > 1) {
    const last = beats[beats.length - 1] + Math.round((beats[beats.length - 1] - beats[beats.length - 2]) / 2);
    if (last < n) out.push(last);
    const first = beats[0] - Math.round((beats[1] - beats[0]) / 2);
    if (first >= 0) out.unshift(first);
  }
  return out;
}

function gridMask(beats, n) {
  const m = new Uint8Array(n);
  const mark = (x) => {
    const c = Math.round(x);
    for (let k = Math.max(0, c - 2); k <= Math.min(n - 1, c + 2); k++) m[k] = 1;
  };
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = beats[i];
    const d = beats[i + 1] - a;
    for (const q of [0, 0.25, 0.5, 0.75, 1 / 3, 2 / 3]) mark(a + q * d);
  }
  if (beats.length) mark(beats[beats.length - 1]);
  return m;
}

function beatEnv(bandOdf) {
  const n = bandOdf[0].length;
  const out = new Float32Array(n);
  for (let b = 0; b < 3; b++) {
    const c = centered(bandOdf[b]);
    let s = 0;
    for (let i = 0; i < n; i++) s += c[i] * c[i];
    s = Math.sqrt(s / n) || 1;
    for (let i = 0; i < n; i++) out[i] += c[i] / s;
  }
  return out;
}

export function analyze(mono, sampleRate) {
  const sp = spectrogram(mono, sampleRate);
  const { odf, bandOdf } = flux(sp);
  const frames = sp.frames;
  let peak = 0;
  for (let i = 0; i < frames; i++) if (odf[i] > peak) peak = odf[i];
  if (frames < 2 * FPS || peak < 1e-3) return { bpm: 0, beats: [], downbeats: [], meter: 4, onsets: [] };
  const oenv = beatEnv(bandOdf);
  const ac = autocorr(oenv, 1, Math.round((2 * 60 * FPS) / 40) + 4);
  const tempo = tempoEstimate(ac);
  const per = localPeriods(oenv, tempo.lag, frames);
  const sub = bandEnergy(sp, 30, 90);
  const high = bandEnergy(sp, 2000, 20000);
  const benv = Float32Array.from(oenv);
  let r = 0;
  for (let i = 0; i < frames; i++) r += oenv[i] * oenv[i];
  r = Math.sqrt(r / frames) || 1;
  for (const e of [sub, high]) {
    const d = new Float32Array(frames);
    for (let i = 1; i < frames; i++) d[i] = Math.max(0, Math.sqrt(e[i]) - Math.sqrt(e[i - 1]));
    const c = centered(d);
    let q = 0;
    for (let i = 0; i < frames; i++) q += c[i] * c[i];
    q = Math.sqrt(q / frames) || 1;
    for (let i = 0; i < frames; i++) benv[i] += (r * c[i]) / q;
  }
  let raw = trackBeats(benv, per);
  const mids = midpoints(raw, frames);
  if (gridScore(mids, [sub, high]) > gridScore(raw, [sub, high])) raw = mids;
  const [a, b] = activeRange(odf);
  const kept = raw.filter((f) => f >= a - per[f] * 0.25 && f <= b + per[f] * 0.25);
  const beats = kept.map((f) => f / FPS);
  const grid = gridMask(raw, frames);
  const picks = pickOnsets(odf, bandOdf).filter((p) => p.full || grid[p.i]);
  const onsets = picks.map((p) => ({ t: p.i / FPS, raw: p.i / FPS, band: p.band, strength: p.v }));
  const { meter, phase } = barPhase(sp, kept, bandOdf[0]);
  const downbeats = beats.filter((_, i) => i >= phase && (i - phase) % meter === 0);
  return { bpm: tempo.bpm, beats, downbeats, meter, onsets };
}
