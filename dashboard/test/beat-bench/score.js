export const BEAT_WINDOW = 0.07;
export const ONSET_WINDOW = 0.05;
export const MERGE = 0.03;
export const TEMPO_TOL = 0.04;
export const WEIGHTS = Object.freeze({ beat: 0.35, beatAny: 0.1, tempo: 0.15, onset: 0.3, downbeat: 0.1 });

const sorted = (a) => [...a].filter(Number.isFinite).sort((x, y) => x - y);

export function merge(times, tol = MERGE) {
  const out = [];
  for (const t of sorted(times)) if (!out.length || t - out[out.length - 1] > tol) out.push(t);
  return out;
}

export function match(ref, est, win) {
  const r = sorted(ref);
  const e = sorted(est);
  const pairs = [];
  let lo = 0;
  for (let i = 0; i < r.length; i++) {
    while (lo < e.length && e[lo] < r[i] - win) lo += 1;
    for (let j = lo; j < e.length && e[j] <= r[i] + win; j++) pairs.push([Math.abs(e[j] - r[i]), i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const ur = new Uint8Array(r.length);
  const ue = new Uint8Array(e.length);
  const hits = [];
  for (const [d, i, j] of pairs) {
    if (ur[i] || ue[j]) continue;
    ur[i] = 1;
    ue[j] = 1;
    hits.push({ ref: r[i], est: e[j], d });
  }
  return { hits, ref: r, est: e, usedRef: ur, usedEst: ue };
}

export function fmeasure(ref, est, win) {
  const { hits, ref: r, est: e } = match(ref, est, win);
  return prf(hits.length, e.length, r.length);
}

function prf(tp, nEst, nRef) {
  const p = nEst ? tp / nEst : nRef ? 0 : 1;
  const r = nRef ? tp / nRef : 1;
  const f = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { f, p, r, tp, nEst, nRef };
}

function mids(b) {
  const out = [];
  for (let i = 0; i + 1 < b.length; i++) out.push((b[i] + b[i + 1]) / 2);
  return out;
}

function thirds(b) {
  const out = [];
  for (let i = 0; i + 1 < b.length; i++) {
    const d = b[i + 1] - b[i];
    out.push(b[i] + d / 3, b[i] + (2 * d) / 3);
  }
  return out;
}

export function beatVariants(ref, meter = 4) {
  const r = sorted(ref);
  const v = {
    same: r,
    double: sorted([...r, ...mids(r)]),
    halfOdd: r.filter((_, i) => i % 2 === 0),
    halfEven: r.filter((_, i) => i % 2 === 1),
    offbeat: mids(r),
  };
  if (meter % 2 === 1 || meter === 2 || meter === 6) {
    v.triple = sorted([...r, ...thirds(r)]);
    for (let k = 0; k < 3; k++) v[`third${k}`] = r.filter((_, i) => i % 3 === k);
  }
  return v;
}

export function scoreBeats(ref, est, meter = 4, win = BEAT_WINDOW) {
  const base = fmeasure(ref, est, win);
  let any = { level: 'same', ...base };
  for (const [level, r] of Object.entries(beatVariants(ref, meter))) {
    const s = fmeasure(r, est, win);
    if (s.f > any.f) any = { level, ...s };
  }
  const { hits } = match(ref, est, win);
  const meanAbsMs = hits.length ? (1000 * hits.reduce((a, h) => a + h.d, 0)) / hits.length : null;
  const bias = hits.length ? (1000 * hits.reduce((a, h) => a + (h.est - h.ref), 0)) / hits.length : null;
  return { f: base.f, p: base.p, r: base.r, anyF: any.f, anyLevel: any.level, meanAbsMs, biasMs: bias };
}

const RATIOS = [[1, 'ok'], [2, 'x2'], [0.5, '/2'], [3, 'x3'], [1 / 3, '/3'], [1.5, 'x3/2'], [2 / 3, 'x2/3']];

export function scoreTempo(tempos, est) {
  const list = (Array.isArray(tempos) ? tempos : [tempos]).filter(Number.isFinite);
  if (!Number.isFinite(est) || est <= 0 || !list.length) return { acc1: 0, acc2: 0, flag: 'none', err: null, score: 0 };
  let best = { flag: 'wrong', err: Infinity };
  for (const t of list) {
    for (const [k, flag] of RATIOS) {
      const err = Math.abs(est / (t * k) - 1);
      if (err <= TEMPO_TOL && (best.flag === 'wrong' || RATIOS.findIndex((x) => x[1] === flag) < RATIOS.findIndex((x) => x[1] === best.flag))) best = { flag, err };
    }
  }
  const nearest = Math.min(...list.map((t) => Math.abs(est / t - 1)));
  const acc1 = best.flag === 'ok' ? 1 : 0;
  const acc2 = ['ok', 'x2', '/2', 'x3', '/3'].includes(best.flag) ? 1 : 0;
  return { acc1, acc2, flag: best.flag, err: Math.round(nearest * 1000) / 10, score: acc1 ? 1 : acc2 ? 0.5 : 0 };
}

export function scoreOnsets(truth, est, win = ONSET_WINDOW) {
  const hard = merge(truth.filter((o) => !o.soft).map((o) => o.t));
  const soft = merge(truth.filter((o) => o.soft).map((o) => o.t));
  const e = merge(est.map((o) => (typeof o === 'number' ? o : o.t)));
  const m = match(hard, e, win);
  let ignored = 0;
  let si = 0;
  for (let j = 0; j < m.est.length; j++) {
    if (m.usedEst[j]) continue;
    const t = m.est[j];
    while (si < soft.length && soft[si] < t - win) si += 1;
    if (si < soft.length && Math.abs(soft[si] - t) <= win) ignored += 1;
  }
  const all = prf(m.hits.length, m.est.length - ignored, hard.length);
  const bands = {};
  for (const b of ['L', 'M', 'H']) {
    const rb = merge(truth.filter((o) => !o.soft && o.band === b).map((o) => o.t));
    const eb = merge(est.filter((o) => typeof o === 'object' && o.band === b).map((o) => o.t));
    if (!rb.length && !eb.length) continue;
    const s = match(rb, eb, win);
    bands[b] = { recall: rb.length ? s.hits.length / rb.length : null, precisionVsAll: eb.length ? match(hard, eb, win).hits.length / eb.length : null };
  }
  return { ...all, ignored, bands };
}

export function scoreSong(truth, result, seconds) {
  const beats = scoreBeats(truth.beats, result.beats || [], truth.meter);
  const tempo = scoreTempo(truth.tempos, result.bpm);
  const onsets = scoreOnsets(truth.onsets, result.onsets || []);
  const raw = result.onsets && result.onsets.some((o) => Number.isFinite(o.raw)) ? scoreOnsets(truth.onsets, result.onsets.map((o) => ({ t: o.raw, band: o.band }))) : null;
  const down = Array.isArray(result.downbeats) ? fmeasure(truth.downbeats, result.downbeats, BEAT_WINDOW) : null;
  const score = WEIGHTS.beat * beats.f + WEIGHTS.beatAny * beats.anyF + WEIGHTS.tempo * tempo.score + WEIGHTS.onset * onsets.f + WEIGHTS.downbeat * (down ? down.f : 0);
  return { beats, tempo, onsets, onsetsRaw: raw, downbeats: down, score, seconds };
}

export function summarize(rows) {
  const mean = (f) => {
    const v = rows.map(f).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const audio = rows.reduce((a, r) => a + r.duration, 0);
  const time = rows.reduce((a, r) => a + r.ms, 0);
  return {
    songs: rows.length,
    beatF: mean((r) => r.s.beats.f),
    beatAnyF: mean((r) => r.s.beats.anyF),
    tempoAcc1: mean((r) => r.s.tempo.acc1),
    tempoAcc2: mean((r) => r.s.tempo.acc2),
    onsetF: mean((r) => r.s.onsets.f),
    onsetP: mean((r) => r.s.onsets.p),
    onsetR: mean((r) => r.s.onsets.r),
    onsetRawF: mean((r) => (r.s.onsetsRaw ? r.s.onsetsRaw.f : NaN)),
    downbeatF: mean((r) => (r.s.downbeats ? r.s.downbeats.f : NaN)),
    msPerMinute: audio ? (time / audio) * 60 : null,
    overall: mean((r) => r.s.score),
  };
}
