export const STRAIGHT = Object.freeze([[0, 4], [0.25, 1], [0.5, 2], [0.75, 1]]);
export const TRIPLET = Object.freeze([[0, 4], [1 / 3, 1], [2 / 3, 2]]);
export const SWING_NEAR = 0.05;
export const SWING_MIN = 12;
export const SWING_RATIO = 1.5;
export const FEEL_MIN = 0.05;
export const FEEL_MAX = 0.72;
export const STRAIGHT_FEEL = Object.freeze([0.5, 0.5]);
export const SNAP_MS = 25;
export const SNAP_KEEP_MS = 15;
export const SPLIT_MS = 40;
export const FEEL_GAIN = 1.1;
export const RAW_MIN_S = 0.15;
export const TAP_RESET_MS = 2000;
export const TAP_MIN = 4;
export const TAP_KEEP = 16;
export const WINDOW_BARS = 2;
export const METERS = Object.freeze([2, 3, 4]);

const r1 = (v) => Math.round(v * 10) / 10;

export function emptyAnalysis({ dur = 0, env = [], loud = [] } = {}) {
  return { v: 2, dur, bpm: 0, b0: 0, beats: [], downbeat: 0, meter: 4, swing: false, feel: [0.5, 0.5], grid: [], onsets: [], hits: [], tones: [], sustains: [], energy: [], marks: [], env, loud, detected: { bpm: 0, beats: [], downbeat: 0, meter: 4 } };
}

export function medianGap(beats, from = 0, to = Infinity) {
  const gaps = [];
  for (let i = 1; i < beats.length; i++) if (beats[i - 1] >= from && beats[i] <= to) gaps.push(beats[i] - beats[i - 1]);
  if (!gaps.length) for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

export function bpmOf(beats, from = 0, to = Infinity) {
  let list = beats.filter((b) => b >= from && b <= to);
  if (list.length < 4) list = beats;
  const g = medianGap(list);
  if (!(g > 0)) return 0;
  const n = list.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let i = 0;
  let prev = list[0];
  for (let k = 0; k < n; k++) {
    if (k > 0) i += Math.max(1, Math.round((list[k] - prev) / g));
    prev = list[k];
    sx += i;
    sy += list[k];
    sxx += i * i;
    sxy += i * list[k];
  }
  const den = n * sxx - sx * sx;
  const slope = den > 0 ? (n * sxy - sx * sy) / den : g;
  const p = slope > 0 && Math.abs(slope - g) / g < 0.1 ? slope : g;
  return Math.round((60000 / p) * 100) / 100;
}

function beatIndex(beats, t) {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function detectSwing(hits, beats) {
  if (beats.length < 4) return false;
  let trip = 0;
  let str = 0;
  for (const h of hits) {
    const i = beatIndex(beats, h.raw);
    if (i + 1 >= beats.length || h.raw < beats[i]) continue;
    const f = (h.raw - beats[i]) / (beats[i + 1] - beats[i]);
    if (f < 0.12 || f > 0.88) continue;
    const dt = Math.min(Math.abs(f - 1 / 3), Math.abs(f - 2 / 3));
    const ds = Math.min(Math.abs(f - 0.25), Math.abs(f - 0.5), Math.abs(f - 0.75));
    if (dt < SWING_NEAR && dt < ds) trip += 1;
    else if (ds < SWING_NEAR && ds < dt) str += 1;
  }
  return trip >= SWING_MIN && trip > SWING_RATIO * str;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export function detectFeel(hits, beats) {
  if (beats.length < 4) return STRAIGHT_FEEL;
  const fs = [];
  for (const h of hits) {
    const i = beatIndex(beats, h.raw);
    if (i + 1 >= beats.length || h.raw < beats[i]) continue;
    fs.push((h.raw - beats[i]) / (beats[i + 1] - beats[i]));
  }
  const eighths = fs.filter((f) => f > 0.42 && f < FEEL_MAX);
  let r8 = 0.5;
  if (eighths.length >= SWING_MIN) {
    const r = median(eighths);
    if (r - 0.5 >= FEEL_MIN) r8 = r;
  }
  const sixteenths = [];
  for (const f of fs) {
    const g = f < r8 ? f / r8 : (f - r8) / (1 - r8);
    if (g > 0.36 && g < FEEL_MAX) sixteenths.push(g);
  }
  let r16 = 0.5;
  if (sixteenths.length >= SWING_MIN) {
    const r = median(sixteenths);
    if (r - 0.5 >= FEEL_MIN) r16 = r;
  }
  if (r8 === 0.5 && r16 === 0.5) return STRAIGHT_FEEL;
  const feel = [Math.round(r8 * 1000) / 1000, Math.round(r16 * 1000) / 1000];
  return gridFit(hits, makeGrid(beats, false, feel)) > FEEL_GAIN * gridFit(hits, makeGrid(beats)) ? feel : STRAIGHT_FEEL;
}

export function gridFit(hits, grid) {
  let s = 0;
  for (const h of hits) {
    const gi = nearestGrid(grid, h.raw);
    if (gi >= 0 && Math.abs(grid[gi].t - h.raw) <= SNAP_MS) s += h.s || 0;
  }
  return s;
}

export function feelPositions(feel = STRAIGHT_FEEL) {
  const [r8, r16] = feel;
  return [[0, 4], [r8 * r16, 1], [r8, 2], [r8 + (1 - r8) * r16, 1]];
}

export function makeGrid(beats, swing = false, feel = STRAIGHT_FEEL) {
  const pos = swing ? TRIPLET : feel[0] === 0.5 && feel[1] === 0.5 ? STRAIGHT : feelPositions(feel);
  const grid = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = beats[i];
    const d = beats[i + 1] - a;
    for (let k = 0; k < pos.length; k++) grid.push({ t: a + pos[k][0] * d, q: pos[k][1], beat: i, k, step: d / pos.length });
  }
  if (beats.length) {
    const last = beats.length - 1;
    const d = beats.length > 1 ? beats[last] - beats[last - 1] : 500;
    grid.push({ t: beats[last], q: 4, beat: last, k: 0, step: d / pos.length });
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

export function sections(loud, beats, downbeat, meter, dur) {
  const bounds = [0];
  const per = meter * Math.max(WINDOW_BARS, Math.ceil(8 / meter));
  for (let i = downbeat; i < beats.length; i += per) if (beats[i] > 0 && beats[i] < dur) bounds.push(beats[i]);
  bounds.push(dur);
  const wins = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    if (b - a < 200) continue;
    const fa = Math.max(0, Math.floor(a / 100));
    const fb = Math.min(loud.length, Math.ceil(b / 100));
    let s = 0;
    for (let f = fa; f < fb; f++) s += loud[f] * loud[f];
    wins.push({ t: Math.round(a), end: Math.round(b), rms: Math.sqrt(s / Math.max(1, fb - fa)) });
  }
  const ranks = rankOf(wins.map((w) => w.rms));
  const energy = wins.map((w, i) => ({ t: w.t, end: w.end, rms: Math.round(w.rms * 1e4) / 1e4, rank: Math.round(ranks[i] * 1000) / 1000, label: 'main' }));
  const marks = [];
  for (let i = 1; i < energy.length; i++) {
    if (energy[i].rank - energy[i - 1].rank >= 0.35) {
      marks.push([energy[i].t, 'drop']);
      energy[i].label = 'drop';
    } else if (i >= 2 && energy[i].rms > energy[i - 1].rms * 1.05 && energy[i - 1].rms > energy[i - 2].rms * 1.05 && !(marks.length && marks[marks.length - 1][0] === energy[i - 1].t)) {
      marks.push([energy[i].t, 'build']);
      energy[i].label = 'build';
    }
  }
  for (let i = 0; i < energy.length; i++) {
    if (energy[i].label !== 'main') continue;
    if (i > 0 && energy[i - 1].label === 'drop' && energy[i].rank >= 0.6) energy[i].label = 'drop';
    else if (energy[i].rank < 0.25) energy[i].label = 'quiet';
  }
  for (let i = 0; i < energy.length && energy[i].rank < 0.5 && energy[i].label !== 'drop'; i++) energy[i].label = 'intro';
  return { energy, marks };
}

export function snapHits(hits, grid) {
  const best = new Map();
  for (const h of hits) {
    const gi = nearestGrid(grid, h.raw);
    if (gi < 0) continue;
    const g = grid[gi];
    const off = Math.abs(g.t - h.raw) / Math.max(1, g.step);
    const o = { t: Math.abs(g.t - h.raw) > SNAP_KEEP_MS && h.s >= RAW_MIN_S ? Math.round(h.raw) : Math.round(g.t), raw: h.raw, band: h.band, kind: h.kind, s: h.s, pitch: h.pitch, gi, q: g.q, off: Math.round(off * 100) / 100 };
    const key = `${gi}:${h.band}`;
    const list = best.get(key) || [];
    const clash = list.findIndex((x) => Math.abs(x.raw - o.raw) < SPLIT_MS);
    if (clash < 0) list.push(o);
    else if (list[clash].s < o.s) list[clash] = o;
    best.set(key, list);
  }
  return [...best.values()].flat().sort((a, b) => a.t - b.t || a.band.localeCompare(b.band));
}

export function snapTones(tones, grid) {
  const out = [];
  for (const s of tones) {
    const gi = nearestGrid(grid, s.t);
    if (gi < 0) continue;
    let gj = nearestGrid(grid, s.end);
    if (gj >= 0 && grid[gj].t > s.end && gj > 0) gj -= 1;
    const end = gj >= 0 ? grid[gj].t : s.end;
    if (end - grid[gi].t < 250) continue;
    out.push({ t: Math.round(grid[gi].t), end: Math.round(end), gi, pitch: s.pitch });
  }
  return out;
}

export function layout(base, beats, downbeat, meter) {
  const m = METERS.includes(meter) ? meter : 4;
  const list = beats.filter((b) => Number.isFinite(b) && b >= 0 && b <= base.dur).sort((a, b) => a - b);
  if (list.length < 4) return { ...emptyAnalysis(base), ...base, bpm: 0, beats: [], grid: [], onsets: [], sustains: [], energy: [], marks: [] };
  const db = ((Math.round(downbeat) % m) + m) % m;
  const swing = detectSwing(base.hits || [], list);
  const feel = swing ? STRAIGHT_FEEL : detectFeel(base.hits || [], list);
  const grid = makeGrid(list, swing, feel).map((g) => ({ ...g, t: r1(g.t) }));
  const { energy, marks } = sections(base.loud || [], list, db, m, base.dur);
  return {
    ...base,
    bpm: bpmOf(list),
    b0: Math.round(list[0]),
    beats: list.map(r1),
    downbeat: db,
    meter: m,
    swing,
    feel: [...feel],
    grid: grid.map((g) => ({ t: g.t, q: g.q, beat: g.beat, k: g.k })),
    onsets: snapHits(base.hits || [], grid),
    sustains: snapTones(base.tones || [], grid),
    energy,
    marks,
  };
}

function hitWeight(hits, t, tol) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].raw < t - tol) lo = mid + 1;
    else hi = mid;
  }
  let s = 0;
  for (let i = lo; i < hits.length && hits[i].raw <= t + tol; i++) s += hits[i].s * (1 - Math.abs(hits[i].raw - t) / (tol + 1));
  return s;
}

function sortedHits(a) {
  return [...(a.hits || [])].sort((x, y) => x.raw - y.raw);
}

function rebuild(a, beats, downbeat, meter = a.meter) {
  return layout(a, beats, downbeat, meter);
}

export function halfTempo(a) {
  if (a.beats.length < 8) return a;
  const hits = sortedHits(a);
  const gap = medianGap(a.beats);
  const parity = [0, 0];
  a.beats.forEach((t, i) => { parity[(((i - a.downbeat) % 2) + 2) % 2] += hitWeight(hits, t, gap * 0.1); });
  const keep = parity[1] > parity[0] * 1.25 ? 1 : 0;
  const idx = [];
  for (let i = 0; i < a.beats.length; i++) if ((((i - a.downbeat - keep) % 2) + 2) % 2 === 0) idx.push(i);
  const beats = idx.map((i) => a.beats[i]);
  const firstDown = idx.findIndex((i) => (((i - a.downbeat) % a.meter) + a.meter) % a.meter === 0);
  const meter = a.meter === 2 ? 4 : a.meter;
  return rebuild(a, beats, firstDown < 0 ? 0 : firstDown % meter, meter);
}

export function doubleTempo(a) {
  if (a.beats.length < 2) return a;
  const beats = [];
  for (let i = 0; i < a.beats.length; i++) {
    beats.push(a.beats[i]);
    if (i + 1 < a.beats.length) beats.push((a.beats[i] + a.beats[i + 1]) / 2);
  }
  const last = a.beats[a.beats.length - 1] + (a.beats[a.beats.length - 1] - a.beats[a.beats.length - 2]) / 2;
  if (last <= a.dur) beats.push(last);
  const first = a.beats[0] - (a.beats[1] - a.beats[0]) / 2;
  let down = (2 * a.downbeat) % a.meter;
  if (first >= 0) {
    beats.unshift(first);
    down = (down + 1) % a.meter;
  }
  return rebuild(a, beats, down, a.meter);
}

export function shiftGrid(a, frac) {
  if (a.beats.length < 2) return a;
  const f = Number(frac) || 0;
  const moved = a.beats.map((t, i) => {
    const d = i + 1 < a.beats.length ? a.beats[i + 1] - t : t - a.beats[i - 1];
    return t + f * d;
  });
  let down = a.downbeat;
  const p0 = moved[1] - moved[0];
  while (moved.length && moved[0] < 0) {
    moved.shift();
    down = (down - 1 + a.meter) % a.meter;
  }
  while (moved.length && moved[0] - p0 >= 0) {
    moved.unshift(moved[0] - p0);
    down = (down + 1) % a.meter;
  }
  const pN = moved[moved.length - 1] - moved[moved.length - 2];
  while (moved.length && moved[moved.length - 1] > a.dur) moved.pop();
  while (moved.length && moved[moved.length - 1] + pN <= a.dur) moved.push(moved[moved.length - 1] + pN);
  return rebuild(a, moved, down, a.meter);
}

export function shiftBar(a, n = 1) {
  if (!a.beats.length) return a;
  return rebuild(a, a.beats, a.downbeat + n, a.meter);
}

export function setMeter(a, meter) {
  if (!a.beats.length || !METERS.includes(meter)) return a;
  return rebuild(a, a.beats, a.downbeat % meter, meter);
}

export function tempoGrid(a, bpm) {
  const p = 60000 / Number(bpm);
  if (!(p > 0) || !Number.isFinite(p) || a.dur <= 0) return a;
  const hits = sortedHits(a);
  let best = 0;
  let bestScore = -1;
  for (let ph = 0; ph < p; ph += 2) {
    let s = 0;
    for (let t = ph; t <= a.dur; t += p) s += hitWeight(hits, t, Math.min(40, p * 0.08));
    if (s > bestScore) {
      bestScore = s;
      best = ph;
    }
  }
  const beats = [];
  for (let t = best; t <= a.dur; t += p) beats.push(t);
  const low = hits.filter((h) => h.band === 'L');
  let down = 0;
  let downScore = -1;
  for (let k = 0; k < a.meter; k++) {
    let s = 0;
    for (let i = k; i < beats.length; i += a.meter) s += hitWeight(low, beats[i], Math.min(40, p * 0.08));
    if (s > downScore) {
      downScore = s;
      down = k;
    }
  }
  return rebuild(a, beats, down, a.meter);
}

export function tapTempo(taps) {
  const list = [];
  for (const t of taps) {
    if (list.length && t - list[list.length - 1] > TAP_RESET_MS) list.length = 0;
    list.push(t);
  }
  const use = list.slice(-TAP_KEEP);
  if (use.length < TAP_MIN) return { bpm: 0, count: use.length };
  const n = use.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += use[i];
    sxx += i * i;
    sxy += i * use[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { bpm: slope > 0 ? Math.round((60000 / slope) * 10) / 10 : 0, count: n };
}

export function stripModel(a, from, to) {
  const span = Math.max(1, to - from);
  const x = (t) => (t - from) / span;
  const beats = [];
  for (let i = 0; i < a.beats.length; i++) {
    const t = a.beats[i];
    if (t < from || t > to) continue;
    beats.push({ x: x(t), down: (((i - a.downbeat) % a.meter) + a.meter) % a.meter === 0 });
  }
  const onsets = (a.onsets || []).filter((o) => o.raw >= from && o.raw <= to).map((o) => ({ x: x(o.raw), kind: o.kind, s: o.s }));
  const env = [];
  const rate = 50;
  const e = a.env || [];
  for (let k = Math.max(0, Math.floor((from / 1000) * rate)); k < Math.min(e.length, Math.ceil((to / 1000) * rate)); k++) env.push({ x: x((k * 1000) / rate), v: e[k] / 100 });
  return { beats, onsets, env };
}
