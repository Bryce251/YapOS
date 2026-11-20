export const SR = 22050;
export const FRAME = 1024;
export const HOP = 256;
export const BANDS = Object.freeze({ L: Object.freeze([30, 150]), M: Object.freeze([150, 2000]), H: Object.freeze([2000, 9000]) });
export const BAND_IDS = Object.freeze(['L', 'M', 'H']);
export const MIX = Object.freeze({ L: 1, M: 0.8, H: 0.6 });
export const TEMPO_MIN = 70;
export const TEMPO_MAX = 180;
export const FOLD_MIN = 85;
export const FOLD_MAX = 170;
export const PEAK_SPAN = 3;
export const MEAN_SPAN = 8;
export const PEAK_DELTA = 0.07;
export const PEAK_GAP_MS = 50;
export const MEDIAN_SECS = 0.25;
export const DP_ALPHA = 100;
export const SNAP = 0.3;
export const SUSTAIN_LEVEL = 0.6;
export const SUSTAIN_MIN_MS = 400;
export const SUSTAIN_RISE = 2;
export const SUSTAIN_MAX_MS = 3000;
export const ONSET_LAG_MS = 30;

function fftTables(n) {
  const bits = Math.log2(n);
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

export function fft(re, im, tab) {
  const { n, rev, cos, sin } = tab;
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
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
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

export function mixDown(channels) {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

function bandBins(sr) {
  const hz = sr / FRAME;
  const out = {};
  for (const id of BAND_IDS) {
    const [lo, hi] = BANDS[id];
    out[id] = [Math.max(1, Math.ceil(lo / hz)), Math.min(FRAME / 2, Math.floor(hi / hz))];
  }
  return out;
}

export function spectralFrames(pcm, sr = SR, onProgress = null) {
  const n = pcm.length < FRAME ? 0 : Math.floor((pcm.length - FRAME) / HOP) + 1;
  const tab = fftTables(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const half = FRAME / 2;
  const prev = new Float64Array(half + 1);
  const cur = new Float64Array(half + 1);
  const ranges = bandBins(sr);
  const flux = {};
  const energy = {};
  for (const id of BAND_IDS) {
    flux[id] = new Float32Array(n);
    energy[id] = new Float32Array(n);
  }
  const cent = new Float32Array(n);
  const hz = sr / FRAME;
  const [mLo, mHi] = ranges.M;
  const tick = Math.max(1, Math.floor(n / 50));
  for (let f = 0; f < n; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, tab);
    for (let k = 1; k <= half; k++) cur[k] = Math.hypot(re[k], im[k]) * (4 / FRAME);
    for (const id of BAND_IDS) {
      const [lo, hi] = ranges[id];
      let fl = 0;
      let en = 0;
      for (let k = lo; k <= hi; k++) {
        const c = Math.log1p(100 * cur[k]);
        const d = c - prev[k];
        if (d > 0) fl += d;
        en += cur[k] * cur[k];
      }
      flux[id][f] = f === 0 ? 0 : fl;
      energy[id][f] = en;
    }
    let num = 0;
    let den = 0;
    for (let k = mLo; k <= mHi; k++) {
      num += k * hz * cur[k];
      den += cur[k];
    }
    cent[f] = den > 1e-9 ? Math.log2(num / den) : 0;
    for (let k = 1; k <= half; k++) prev[k] = Math.log1p(100 * cur[k]);
    if (onProgress && f % tick === 0) onProgress(0.6 * (f / Math.max(1, n)));
  }
  return { n, fr: sr / HOP, flux, energy, cent };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

export function novelty(flux, fr) {
  const n = flux.length;
  const w = Math.max(1, Math.round(MEDIAN_SECS * fr));
  const out = new Float32Array(n);
  const buf = new Float32Array(2 * w + 1);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n - 1, i + w);
    const len = b - a + 1;
    for (let k = 0; k < len; k++) buf[k] = flux[a + k];
    const part = buf.subarray(0, len).sort();
    const med = part[len >> 1];
    out[i] = Math.max(0, flux[i] - med);
  }
  const top = percentile(out.filter((v) => v > 0), 0.95);
  if (top > 0) for (let i = 0; i < n; i++) out[i] /= top;
  return out;
}

function interp(arr, f) {
  if (f <= 0 || f >= arr.length - 1) return 0;
  const a = arr[f - 1];
  const b = arr[f];
  const c = arr[f + 1];
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-9) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}

export function frameMs(f, fr) {
  return (f * 1000) / fr + ONSET_LAG_MS;
}

export function pickPeaks(nov, fr) {
  const out = [];
  const gap = (PEAK_GAP_MS / 1000) * fr;
  let last = -Infinity;
  const n = nov.length;
  let sum = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum += nov[i];
    pre[i + 1] = sum;
  }
  for (let f = 1; f < n - 1; f++) {
    const v = nov[f];
    if (v <= 0) continue;
    let top = true;
    for (let k = Math.max(0, f - PEAK_SPAN); k <= Math.min(n - 1, f + PEAK_SPAN); k++) {
      if (nov[k] > v || (nov[k] === v && k < f)) {
        top = false;
        break;
      }
    }
    if (!top) continue;
    const a = Math.max(0, f - MEAN_SPAN);
    const b = Math.min(n - 1, f + MEAN_SPAN);
    const mean = (pre[b + 1] - pre[a]) / (b - a + 1);
    if (v <= mean + PEAK_DELTA) continue;
    const exact = f + interp(nov, f);
    if (exact - last < gap) continue;
    last = exact;
    out.push({ f, x: exact, s: v });
  }
  return out;
}

export function estimateTempo(c, fr) {
  const n = c.length;
  const lo = Math.max(2, Math.floor((60 * fr) / TEMPO_MAX));
  const hi = Math.min(n - 2, Math.ceil((60 * fr) / TEMPO_MIN));
  if (hi <= lo + 2) return 120;
  const score = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += c[i] * c[i + lag];
    const bpm = (60 * fr) / lag;
    const w = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    score[lag] = (s / Math.max(1, n - lag)) * w;
  }
  let best = lo;
  for (let lag = lo; lag <= hi; lag++) if (score[lag] > score[best]) best = lag;
  const exact = best + interp(score, best);
  let bpm = (60 * fr) / exact;
  while (bpm < FOLD_MIN) bpm *= 2;
  while (bpm > FOLD_MAX) bpm /= 2;
  return bpm;
}

export function trackBeats(c, fr, bpm) {
  const n = c.length;
  const P = (60 * fr) / bpm;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const minBack = Math.max(1, Math.round(P / 2));
  const maxBack = Math.round(2 * P);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let p = t - maxBack; p <= t - minBack; p++) {
      if (p < 0) continue;
      const pen = DP_ALPHA * Math.log((t - p) / P) ** 2;
      const v = score[p] - pen;
      if (v > best) {
        best = v;
        arg = p;
      }
    }
    score[t] = c[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  let end = Math.max(0, n - Math.ceil(P));
  for (let t = end; t < n; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();
  return frames.map((f) => {
    let at = f;
    for (let k = Math.max(1, f - 2); k <= Math.min(n - 2, f + 2); k++) if (c[k] > c[at]) at = k;
    return c[at] > 0 ? at + interp(c, at) : f;
  });
}

function regressBpm(times) {
  const n = times.length;
  if (n < 4) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += times[i];
    sxx += i * i;
    sxy += i * times[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope > 0 ? 60000 / slope : null;
}

function fillBeats(beats, dur) {
  if (beats.length < 2) return beats;
  const p0 = beats[1] - beats[0];
  const pre = [];
  for (let t = beats[0] - p0; t >= 0; t -= p0) pre.unshift(t);
  const pN = beats[beats.length - 1] - beats[beats.length - 2];
  const post = [];
  for (let t = beats[beats.length - 1] + pN; t <= dur; t += pN) post.push(t);
  return [...pre, ...beats, ...post];
}

export function makeGrid(beats) {
  const grid = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = beats[i];
    const step = (beats[i + 1] - a) / 4;
    for (let j = 0; j < 4; j++) grid.push({ t: a + j * step, q: j === 0 ? 4 : j === 2 ? 2 : 1, beat: i, step });
  }
  if (beats.length) {
    const last = beats.length - 1;
    const step = beats.length > 1 ? (beats[last] - beats[last - 1]) / 4 : 125;
    grid.push({ t: beats[last], q: 4, beat: last, step });
  }
  return grid;
}

export function nearestGrid(grid, t) {
  let lo = 0;
  let hi = grid.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(grid[lo - 1].t - t) <= Math.abs(grid[lo].t - t)) return lo - 1;
  return lo;
}

function rankOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const den = Math.max(1, sorted.length - 1);
  return values.map((v) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sorted[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo / den;
  });
}

export function analyze(pcm, sr = SR, { onProgress = null } = {}) {
  const dur = Math.round((pcm.length / sr) * 1000);
  const spec = spectralFrames(pcm, sr, onProgress);
  const { n, fr } = spec;
  const nov = {};
  for (const id of BAND_IDS) nov[id] = novelty(spec.flux[id], fr);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) for (const id of BAND_IDS) c[i] += MIX[id] * nov[id][i];
  if (onProgress) onProgress(0.7);
  const rough = estimateTempo(c, fr);
  const beatFrames = trackBeats(c, fr, rough);
  const tracked = beatFrames.map((f) => frameMs(f, fr));
  const fit = regressBpm(tracked);
  const bpm = Math.round((fit && fit >= TEMPO_MIN / 2 && fit <= TEMPO_MAX * 2 ? fit : rough) * 100) / 100;
  if (onProgress) onProgress(0.8);
  let down = 0;
  let downBest = -1;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = k; i < beatFrames.length; i += 4) s += nov.L[Math.round(beatFrames[i])] || 0;
    if (s > downBest) {
      downBest = s;
      down = k;
    }
  }
  const lead = tracked.length > 1 ? Math.ceil(tracked[0] / (tracked[1] - tracked[0])) : 0;
  const beats = fillBeats(tracked, dur);
  const downbeat = ((down + lead) % 4 + 4) % 4;
  const grid = makeGrid(beats);
  const onsets = [];
  for (const id of BAND_IDS) {
    const peaks = pickPeaks(nov[id], fr);
    const best = new Map();
    for (const p of peaks) {
      const t = frameMs(p.x, fr);
      const gi = nearestGrid(grid, t);
      if (gi < 0) continue;
      const g = grid[gi];
      if (Math.abs(g.t - t) > SNAP * g.step) continue;
      let pitch = 0;
      let cnt = 0;
      for (let k = p.f; k < Math.min(n, p.f + 3); k++) {
        if (spec.cent[k] > 0) {
          pitch += spec.cent[k];
          cnt += 1;
        }
      }
      const o = { t: Math.round(g.t), raw: Math.round(t), band: id, s: Math.round(p.s * 1000) / 1000, pitch: cnt ? Math.round((pitch / cnt) * 1000) / 1000 : 0, gi, q: g.q, f: p.f };
      const had = best.get(gi);
      if (!had || had.s < o.s) best.set(gi, o);
    }
    onsets.push(...best.values());
  }
  onsets.sort((a, b) => a.t - b.t || a.band.localeCompare(b.band));
  if (onProgress) onProgress(0.9);
  const total = new Float32Array(n);
  for (let i = 0; i < n; i++) for (const id of BAND_IDS) total[i] += spec.energy[id][i];
  const bounds = [0];
  for (let i = downbeat; i < beats.length; i += 8) if (beats[i] > 0) bounds.push(beats[i]);
  bounds.push(dur);
  const wins = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a < 200) continue;
    const fa = Math.max(0, Math.floor((a / 1000) * fr));
    const fb = Math.min(n, Math.ceil((b / 1000) * fr));
    let s = 0;
    for (let f = fa; f < fb; f++) s += total[f];
    wins.push({ t: Math.round(a), end: Math.round(b), rms: Math.sqrt(s / Math.max(1, fb - fa)) });
  }
  const ranks = rankOf(wins.map((w) => w.rms));
  const energy = wins.map((w, i) => ({ ...w, rms: Math.round(w.rms * 1e4) / 1e4, rank: Math.round(ranks[i] * 1000) / 1000 }));
  const marks = [];
  for (let i = 1; i < energy.length; i++) {
    if (energy[i].rank - energy[i - 1].rank >= 0.35) marks.push([energy[i].t, 'drop']);
    else if (i >= 2 && energy[i].rms > energy[i - 1].rms && energy[i - 1].rms > energy[i - 2].rms && !(marks.length && marks[marks.length - 1][0] === energy[i - 1].t)) marks.push([energy[i].t, 'build']);
  }
  const sustains = [];
  const busy = { L: -Infinity, M: -Infinity };
  for (const o of onsets) {
    if (o.band === 'H' || o.t < busy[o.band]) continue;
    const e = spec.energy[o.band];
    let peak = 0;
    const a = Math.min(n, o.f + 2);
    const b = Math.min(n, o.f + 6);
    for (let k = a; k < b; k++) peak += e[k] / Math.max(1, b - a);
    if (peak <= 0) continue;
    let before = 0;
    const p0 = Math.max(0, o.f - 10);
    const p1 = Math.max(p0 + 1, o.f - 2);
    for (let k = p0; k < p1; k++) before += e[k] / (p1 - p0);
    if (peak < SUSTAIN_RISE * before) continue;
    let g = a;
    while (g < n && e[g] >= SUSTAIN_LEVEL * peak) g += 1;
    const len = ((g - o.f) * 1000) / fr;
    if (len < SUSTAIN_MIN_MS) continue;
    const stop = o.t + Math.min(SUSTAIN_MAX_MS, len);
    const gi = nearestGrid(grid, stop);
    let end = gi >= 0 ? grid[gi].t : stop;
    if (end > stop) end = gi > 0 ? grid[gi - 1].t : stop;
    if (end - o.t < SUSTAIN_MIN_MS) continue;
    sustains.push({ t: o.t, end: Math.round(end), band: o.band, gi: o.gi });
    busy[o.band] = end;
  }
  if (onProgress) onProgress(1);
  return {
    bpm,
    b0: Math.round(beats.length ? beats[0] : 0),
    downbeat,
    beats: beats.map((b) => Math.round(b * 10) / 10),
    grid: grid.map((g) => ({ t: Math.round(g.t * 10) / 10, q: g.q, beat: g.beat })),
    onsets: onsets.map(({ f, ...rest }) => rest),
    energy,
    marks,
    sustains,
    dur,
  };
}
