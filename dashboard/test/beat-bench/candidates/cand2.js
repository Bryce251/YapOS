export const name = 'cand2 comb resonators + whitened superflux onsets';

const TARGET_RATE = 22050;
const TEMPO_MIN = 60;
const TEMPO_MAX = 200;
const ENV_FPS = 100;

function decimate(x, f) {
  if (f <= 1) return x;
  const taps = 8 * f + 1;
  const h = new Float32Array(taps);
  const c = (taps - 1) / 2;
  const cut = 0.9 / f;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - c;
    const s = t === 0 ? 1 : Math.sin(Math.PI * cut * t) / (Math.PI * cut * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = s * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor(x.length / f);
  const y = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const m = j * f;
    let acc = 0;
    const k0 = Math.max(0, c - m);
    const k1 = Math.min(taps, x.length - m + c);
    for (let k = k0; k < k1; k++) acc += h[k] * x[m + k - c];
    y[j] = acc;
  }
  return y;
}

function makeFft(n) {
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
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
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
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  };
}

function filterbank(nBins, sr, nfft, perOctave, fmin, fmax) {
  const binHz = sr / nfft;
  const bins = [];
  let last = -1;
  for (let f = fmin; f < fmax; f *= Math.pow(2, 1 / perOctave)) {
    const b = Math.round(f / binHz);
    if (b > last && b < nBins) {
      bins.push(b);
      last = b;
    }
  }
  const bands = [];
  for (let i = 1; i + 1 < bins.length; i++) {
    const lo = bins[i - 1];
    const mid = bins[i];
    const hi = bins[i + 1];
    const w = [];
    let s = 0;
    for (let k = lo; k <= hi; k++) {
      const v = k <= mid ? (k - lo + 1) / (mid - lo + 1) : (hi - k + 1) / (hi - mid + 1);
      w.push(v);
      s += v;
    }
    bands.push({ lo, hi, hz: mid * binHz, w: Float32Array.from(w, (v) => v / s) });
  }
  return bands;
}

function stft(x, sr) {
  const nfft = sr > 30000 ? 2048 : 1024;
  const hop = Math.max(1, Math.round(sr / 200));
  const nb = nfft / 2 + 1;
  const frames = Math.max(1, Math.floor((x.length - nfft) / hop) + 1);
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const fft = makeFft(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const mag = new Float32Array(frames * nb);
  const pr = new Float32Array(frames * nb);
  const pi = new Float32Array(frames * nb);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < nfft; i++) {
      re[i] = (x[o + i] || 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const base = f * nb;
    for (let k = 0; k < nb; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[base + k] = m;
      if (m > 1e-12) {
        pr[base + k] = re[k] / m;
        pi[base + k] = im[k] / m;
      } else {
        pr[base + k] = 1;
        pi[base + k] = 0;
      }
    }
  }
  return { mag, pr, pi, frames, nb, nfft, hop, fps: sr / hop, offset: nfft / 2 / sr };
}

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

function movingMean(x, before, after) {
  const n = x.length;
  const c = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - before);
    const b = Math.min(n, i + after + 1);
    out[i] = (c[b] - c[a]) / (b - a);
  }
  return out;
}

function movingMax(x, before, after) {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    const a = Math.max(0, i - before);
    const b = Math.min(n - 1, i + after);
    for (let j = a; j <= b; j++) if (x[j] > m) m = x[j];
    out[i] = m;
  }
  return out;
}

function normalize(x) {
  const p = percentile(x, 0.99) || 1;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] / p;
  return y;
}

function features(S, sr) {
  const { mag, pr, pi, frames, nb, nfft } = S;
  const bands = filterbank(nb, sr, nfft, 12, 40, Math.min(16000, sr / 2 - 100));
  const nbands = bands.length;
  const scale = 4 / nfft;
  const lin = new Float32Array(frames * nbands);
  const bandMean = new Float64Array(nbands);
  for (let f = 0; f < frames; f++) {
    const base = f * nb;
    for (let b = 0; b < nbands; b++) {
      const { lo, hi, w } = bands[b];
      let s = 0;
      for (let k = lo; k <= hi; k++) s += mag[base + k] * w[k - lo];
      lin[f * nbands + b] = s * scale;
      bandMean[b] += s * scale;
    }
  }
  for (let b = 0; b < nbands; b++) bandMean[b] = bandMean[b] / frames || 1e-9;
  const logb = new Float32Array(frames * nbands);
  const logw = new Float32Array(frames * nbands);
  for (let i = 0; i < lin.length; i++) {
    logb[i] = Math.log1p(1000 * lin[i]);
    logw[i] = Math.log1p((3 * lin[i]) / bandMean[i % nbands]);
  }
  const lag = Math.max(1, Math.round(S.fps * 0.012));
  const groups = [250, 5000];
  const gi = bands.map((b) => (b.hz < groups[0] ? 0 : b.hz < groups[1] ? 1 : 2));
  const tempoEdges = [0, 150, 300, 600, 1200, 2400, 4800, Infinity];
  const ti = bands.map((b) => tempoEdges.findIndex((e, i) => b.hz >= e && b.hz < tempoEdges[i + 1]));
  const sf = new Float32Array(frames);
  const sfBand = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  const tflux = Array.from({ length: tempoEdges.length - 1 }, () => new Float32Array(frames));
  for (let f = lag; f < frames; f++) {
    const cur = f * nbands;
    const prev = (f - lag) * nbands;
    let tot = 0;
    for (let b = 0; b < nbands; b++) {
      let m = logw[prev + b];
      if (b > 0 && logw[prev + b - 1] > m) m = logw[prev + b - 1];
      if (b + 1 < nbands && logw[prev + b + 1] > m) m = logw[prev + b + 1];
      const d = logw[cur + b] - m;
      if (d > 0) {
        tot += d;
        sfBand[gi[b]][f] += d;
      }
      const d2 = logb[cur + b] - logb[prev + b];
      if (d2 > 0) tflux[ti[b]][f] += d2;
    }
    sf[f] = tot;
  }
  const cd = new Float32Array(frames);
  const hfc = new Float32Array(frames);
  const kmin = Math.max(1, Math.floor((30 * nfft) / sr));
  for (let f = 2; f < frames; f++) {
    const a = f * nb;
    const b1 = (f - 1) * nb;
    const b2 = (f - 2) * nb;
    let s = 0;
    let h = 0;
    for (let k = kmin; k < nb; k++) {
      const m = mag[a + k] * scale;
      const m1 = mag[b1 + k] * scale;
      h += (k / nb) * m * m;
      if (m <= m1) continue;
      const ur = pr[b1 + k] * pr[b1 + k] - pi[b1 + k] * pi[b1 + k];
      const ui = 2 * pr[b1 + k] * pi[b1 + k];
      const vr = ur * pr[b2 + k] + ui * pi[b2 + k];
      const vi = ui * pr[b2 + k] - ur * pi[b2 + k];
      const er = m * pr[a + k] - m1 * vr;
      const ei = m * pi[a + k] - m1 * vi;
      s += Math.sqrt(er * er + ei * ei);
    }
    cd[f] = s;
    hfc[f] = h;
  }
  const dh = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const v = Math.log1p(1000 * hfc[f]) - Math.log1p(1000 * hfc[f - 1]);
    dh[f] = v > 0 ? v : 0;
  }
  return { sf, cd, dh, sfBand, tflux, logb, nbands, bandHz: bands.map((b) => b.hz) };
}

function pickPeaks(odf, fps, { delta, ratio, preMax = 0.03, postMax = 0.03, preAvg = 0.1, postAvg = 0.07, wait = 0.03 }) {
  const n = odf.length;
  const mx = movingMax(odf, Math.round(preMax * fps), Math.round(postMax * fps));
  const av = movingMean(odf, Math.round(preAvg * fps), Math.round(postAvg * fps));
  const peaks = [];
  let last = -Infinity;
  const w = Math.round(wait * fps);
  for (let i = 1; i < n - 1; i++) {
    const v = odf[i];
    if (v !== mx[i] || v < av[i] + delta || v < av[i] * ratio) continue;
    if (i - last < w) {
      if (peaks.length && v > peaks[peaks.length - 1].v) {
        peaks[peaks.length - 1] = { i, v };
        last = i;
      }
      continue;
    }
    peaks.push({ i, v });
    last = i;
  }
  for (const p of peaks) {
    const a = odf[p.i - 1];
    const b = odf[p.i];
    const c = odf[p.i + 1];
    const den = a - 2 * b + c;
    p.x = p.i + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
  }
  return peaks;
}

function strongOnly(peaks, frac) {
  if (!peaks.length) return peaks;
  const ref = percentile(peaks.map((p) => p.v), 0.9);
  return peaks.filter((p) => p.v >= frac * ref);
}

function resonators(env, fps, bpms, halfLife = 1.5) {
  const n = env.length;
  const out = new Float64Array(bpms.length);
  const y = new Float32Array(n);
  for (let t = 0; t < bpms.length; t++) {
    const L = (60 / bpms[t]) * fps;
    const alpha = Math.pow(0.5, L / (halfLife * fps));
    const L0 = Math.floor(L);
    const fr = L - L0;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const j = i - L0;
      let d = 0;
      if (j - 1 >= 0) d = (1 - fr) * y[j] + fr * y[j - 1];
      else if (j >= 0) d = (1 - fr) * y[j];
      const v = (1 - alpha) * env[i] + alpha * d;
      y[i] = v;
      e += v * v;
    }
    out[t] = e / ((1 - alpha) / (1 + alpha)) / Math.max(1, n);
  }
  return out;
}

function prepEnv(x, fps) {
  const n = x.length;
  const sm = movingMean(x, Math.round(0.01 * fps), Math.round(0.01 * fps));
  const loc = movingMean(sm, Math.round(fps), Math.round(fps));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = sm[i] - loc[i];
    y[i] = v > 0 ? v : 0;
  }
  const p = percentile(y, 0.98) || 1;
  for (let i = 0; i < n; i++) y[i] /= p;
  return y;
}

function downsampleEnv(x, k) {
  if (k <= 1) return x;
  const n = Math.floor(x.length / k);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[i * k + j];
    y[i] = s / k;
  }
  return y;
}

function tempoCurve(envs, fps, lo, hi, step = 1.006) {
  const bpms = [];
  for (let b = lo; b <= hi; b *= step) bpms.push(b);
  const tot = new Float64Array(bpms.length);
  for (const env of envs) {
    const r = resonators(env, fps, bpms);
    let mean = 0;
    for (const v of r) mean += v;
    mean /= r.length;
    for (let i = 0; i < r.length; i++) tot[i] += r[i] / (mean || 1);
  }
  return { bpms, tot };
}

function beatTrack(onset, period, tight = 25) {
  const n = onset.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const P = typeof period === 'function' ? period : () => period;
  for (let i = 0; i < n; i++) {
    const p = P(i);
    const a = Math.round(i - 2 * p);
    const b = Math.round(i - p / 2);
    let best = 0;
    let bi = -1;
    for (let j = Math.max(0, a); j <= b && j < i; j++) {
      const r = Math.log((i - j) / p);
      const v = score[j] - tight * r * r;
      if (bi < 0 || v > best) {
        best = v;
        bi = j;
      }
    }
    score[i] = onset[i] + (bi >= 0 ? best : 0);
    back[i] = bi;
  }
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, Math.floor(n - P(n - 1))); i < n; i++) {
    if (score[i] > bestEnd) {
      bestEnd = score[i];
      end = i;
    }
  }
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

function refine(bpms, tot, T) {
  let bi = -1;
  for (let i = 0; i < bpms.length; i++) if (Math.abs(Math.log(bpms[i] / T)) < 0.03 && (bi < 0 || tot[i] > tot[bi])) bi = i;
  return bi < 0 ? T : bpms[bi];
}

function accent(envs, beats, k) {
  const vals = envs.map((env) => {
    const sum = new Float64Array(k);
    const cnt = new Float64Array(k);
    for (let j = 0; j < beats.length; j++) {
      let m = 0;
      for (let q = Math.max(0, beats[j] - 3); q <= Math.min(env.length - 1, beats[j] + 3); q++) if (env[q] > m) m = env[q];
      sum[j % k] += m;
      cnt[j % k] += 1;
    }
    return Array.from(sum, (v, i) => v / Math.max(1, cnt[i]));
  });
  const tot = new Float64Array(k);
  for (const v of vals) {
    const mean = v.reduce((a, b) => a + b, 0) / k || 1;
    for (let i = 0; i < k; i++) tot[i] += v[i] / mean;
  }
  let s = 0;
  for (let i = 1; i < k; i++) if (tot[i] > tot[s]) s = i;
  let num = 0;
  let den = 0;
  for (const v of vals) {
    const st = v[s];
    const ot = (v.reduce((a, b) => a + b, 0) - st) / (k - 1);
    const wgt = (st + ot) / 2;
    num += wgt * ((st - ot) / (st + ot + 1e-9));
    den += wgt;
  }
  return den ? num / den : 0;
}

function chooseTempo(envs, obeat, fps, bpms, tot) {
  let ti = -1;
  for (let i = 0; i < tot.length; i++) if (bpms[i] >= TEMPO_MIN && bpms[i] <= TEMPO_MAX && (ti < 0 || tot[i] > tot[ti])) ti = i;
  let T = ti < 0 ? 120 : bpms[ti];
  for (let step = 0; step < 3; step++) {
    const bt = beatTrack(obeat, (60 / T) * fps);
    const a2 = accent(envs, bt, 2);
    const a3 = accent(envs, bt, 3);
    const k = a3 > a2 ? 3 : 2;
    if (T / k < TEMPO_MIN || Math.max(a2, a3) < 0.25) break;
    T = refine(bpms, tot, T / k);
  }
  return T;
}

function localTempo(env, fps, T) {
  const win = Math.round(6 * fps);
  const hop = Math.round(fps);
  const n = env.length;
  const cands = [];
  for (let b = T / 1.45; b <= T * 1.45; b *= 1.01) cands.push(b);
  const starts = [];
  for (let a = 0; a + win <= n || !starts.length; a += hop) starts.push(Math.max(0, Math.min(a, n - win)));
  const obs = starts.map((a) => {
    const r = resonators(env.subarray(a, Math.min(n, a + win)), fps, cands);
    let m = 0;
    for (const v of r) m = Math.max(m, v);
    return Array.from(r, (v) => (m > 0 ? v / m : 0));
  });
  const K = cands.length;
  const jump = 8;
  const prior = 0.5;
  const pen = cands.map((c) => prior * Math.abs(Math.log(c / T)));
  let score = cands.map((_, k) => Math.log(obs[0][k] + 1e-3) - pen[k]);
  const back = [];
  for (let w = 1; w < obs.length; w++) {
    const nx = new Array(K);
    const bk = new Int32Array(K);
    for (let k = 0; k < K; k++) {
      let best = -Infinity;
      let bi = 0;
      for (let j = 0; j < K; j++) {
        const v = score[j] - jump * Math.abs(Math.log(cands[k] / cands[j]));
        if (v > best) {
          best = v;
          bi = j;
        }
      }
      nx[k] = best + Math.log(obs[w][k] + 1e-3) - pen[k];
      bk[k] = bi;
    }
    back.push(bk);
    score = nx;
  }
  let k = 0;
  for (let j = 1; j < K; j++) if (score[j] > score[k]) k = j;
  const path = new Array(obs.length);
  path[obs.length - 1] = k;
  for (let w = obs.length - 1; w > 0; w--) {
    k = back[w - 1][k];
    path[w - 1] = k;
  }
  const centers = starts.map((a) => a + win / 2);
  const per = new Float64Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) {
    while (w + 1 < centers.length && centers[w + 1] < i) w += 1;
    let bpm;
    if (i <= centers[0]) bpm = cands[path[0]];
    else if (w + 1 >= centers.length) bpm = cands[path[path.length - 1]];
    else {
      const f = (i - centers[w]) / (centers[w + 1] - centers[w]);
      bpm = cands[path[w]] * (1 - f) + cands[path[w + 1]] * f;
    }
    per[i] = (60 / bpm) * fps;
  }
  return per;
}

function barFeatures(F, beatsF, lowEnv, ds) {
  const { logb, nbands, bandHz } = F;
  const sel = [];
  for (let b = 0; b < nbands; b++) if (bandHz[b] >= 60 && bandHz[b] <= 3000) sel.push(b);
  const frames = logb.length / nbands;
  const meanSpec = (a, b) => {
    const v = new Float64Array(sel.length);
    const lo = Math.max(0, a);
    const hi = Math.min(frames, b);
    for (let f = lo; f < hi; f++) for (let k = 0; k < sel.length; k++) v[k] += logb[f * nbands + sel[k]];
    const c = Math.max(1, hi - lo);
    for (let k = 0; k < sel.length; k++) v[k] /= c;
    return v;
  };
  const segs = beatsF.map((b, i) => {
    const next = i + 1 < beatsF.length ? beatsF[i + 1] : b + (i > 0 ? b - beatsF[i - 1] : 1);
    return meanSpec(b * ds, next * ds);
  });
  const nov = new Float64Array(beatsF.length);
  for (let i = 1; i < beatsF.length; i++) {
    let s = 0;
    let e = 0;
    for (let k = 0; k < sel.length; k++) {
      s += Math.abs(segs[i][k] - segs[i - 1][k]);
      e += segs[i][k] + segs[i - 1][k];
    }
    nov[i] = e > 0 ? s / e : 0;
  }
  const low = beatsF.map((b) => {
    let m = 0;
    for (let q = Math.max(0, b - 3); q <= Math.min(lowEnv.length - 1, b + 3); q++) if (lowEnv[q] > m) m = lowEnv[q];
    return m;
  });
  return { nov, low };
}

function barPhase({ nov, low }, meter) {
  const n = nov.length;
  const mn = nov.reduce((a, b) => a + b, 0) / Math.max(1, n) || 1;
  const ml = low.reduce((a, b) => a + b, 0) / Math.max(1, n) || 1;
  const sc = new Float64Array(meter);
  const ct = new Float64Array(meter);
  for (let i = 0; i < n; i++) {
    sc[i % meter] += nov[i] / mn + low[i] / ml;
    ct[i % meter] += 1;
  }
  for (let k = 0; k < meter; k++) sc[k] /= Math.max(1, ct[k]);
  let best = 0;
  for (let k = 1; k < meter; k++) if (sc[k] > sc[best]) best = k;
  return { phase: best, scores: sc };
}

function gridOnsets(onsets, beats, weak, toSec) {
  const slots = [0, 0.25, 0.5, 0.75, 1 / 3, 2 / 3];
  const tol = 0.025;
  const ts = onsets.map((o) => o.t);
  const nearest = (t) => {
    if (!ts.length) return Infinity;
    let lo = 0;
    let hi = ts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] < t) lo = m;
      else hi = m;
    }
    return Math.min(Math.abs(ts[lo] - t), Math.abs(ts[hi] - t));
  };
  const occ = slots.map(() => 0);
  for (let j = 0; j + 1 < beats.length; j++) {
    const d = beats[j + 1] - beats[j];
    slots.forEach((f, k) => {
      if (nearest(beats[j] + f * d) <= tol) occ[k] += 1;
    });
  }
  const nb = Math.max(1, beats.length - 1);
  const active = slots.filter((_, k) => occ[k] / nb >= 0.5);
  if (!active.length) return onsets;
  const add = [];
  let j = 0;
  for (const p of weak) {
    const t = toSec(p.x);
    if (nearest(t) < 0.03) continue;
    while (j + 2 < beats.length && beats[j + 1] <= t) j += 1;
    if (j + 1 >= beats.length || t < beats[j]) continue;
    const d = beats[j + 1] - beats[j];
    if (active.some((f) => Math.abs(beats[j] + f * d - t) <= tol || Math.abs(beats[j] + (f + 1) * d - t) <= tol)) add.push({ ...p, t });
  }
  return add;
}

function bandOf(F, i) {
  const e = [F.sfBand[0][i] * 1.5, F.sfBand[1][i], F.sfBand[2][i] * 1.2];
  return 'LMH'[e.indexOf(Math.max(...e))];
}

export function analyze(mono, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const x = decimate(mono, factor);
  const sr = sampleRate / factor;
  const S = stft(x, sr);
  const fps = S.fps;
  const F = features(S, sr);
  const toSec = (fr) => fr / fps + S.offset;

  const odf = normalize(F.sf);
  const main = strongOnly(pickPeaks(odf, fps, { delta: 0.1, ratio: 3.5 }), 0.15).map((p) => ({ ...p, band: bandOf(F, p.i) }));
  const high = pickPeaks(normalize(F.sfBand[2]), fps, { delta: 0.1, ratio: 5 }).map((p) => ({ ...p, band: 'H' }));
  const merged = [];
  for (const p of [...main, ...high].sort((a, b) => a.x - b.x)) {
    const q = merged[merged.length - 1];
    if (q && p.x - q.x < 0.03 * fps) {
      if (p.v > q.v) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  let onsets = merged.map((p) => ({ t: toSec(p.x), band: p.band, strength: p.v }));

  const ds = Math.max(1, Math.round(fps / ENV_FPS));
  const efps = fps / ds;
  const envs = F.tflux.map((e) => prepEnv(downsampleEnv(e, ds), efps));
  const cdN = normalize(F.cd);
  const dhN = normalize(F.dh);
  const mix = new Float32Array(S.frames);
  for (let i = 0; i < S.frames; i++) mix[i] = 0.6 * odf[i] + 0.25 * cdN[i] + 0.15 * dhN[i];
  const obeat = prepEnv(downsampleEnv(mix, ds), efps);

  const { bpms, tot } = tempoCurve(envs, efps, 40, 300);
  const bpm = chooseTempo(envs, obeat, efps, bpms, tot);
  const per = localTempo(obeat, efps, bpm);
  let bf = beatTrack(obeat, (i) => per[i]);
  if (onsets.length) {
    const first = onsets[0].t;
    const last = onsets[onsets.length - 1].t;
    const P = 60 / bpm;
    bf = bf.filter((i) => {
      const t = (i * ds) / fps + S.offset;
      return t >= first - P / 2 && t <= last + 1.5 * P;
    });
  }
  const beats = bf.map((i) => (i * ds) / fps + S.offset);

  if (onsets.length) {
    const ref = percentile(onsets.map((o) => o.strength), 0.9);
    const weak = pickPeaks(odf, fps, { delta: 0.03, ratio: 2 }).filter((p) => p.v >= 0.05 * ref);
    const extra = gridOnsets(onsets, beats, weak, toSec).map((p) => ({ t: p.t, band: bandOf(F, p.i), strength: p.v }));
    onsets = onsets.concat(extra).sort((a, b) => a.t - b.t);
  }

  const lowEnv = new Float32Array(envs[0].length);
  for (let i = 0; i < lowEnv.length; i++) lowEnv[i] = envs[0][i] + envs[1][i];
  const bfeat = barFeatures(F, bf, lowEnv, ds);
  const four = barPhase(bfeat, 4);
  const meter = four.scores[(four.phase + 2) % 4] >= 0.85 * four.scores[four.phase] ? 2 : 4;
  const phase = meter === 4 ? four.phase : barPhase(bfeat, 2).phase;
  const downbeats = beats.filter((_, i) => i % meter === phase);
  return { bpm, beats, downbeats, meter, onsets };
}
