import { encodeNotes, decodeNotes, validateCharts, objectCount, peakNps, DIFF_IDS, OBJECT_CAPS, NPS_CAPS, HOLD_DIFFS, LANES, LANE_REST_MS, FIRST_NOTE_MS, END_PAD_MS, HOLD_MIN_CS, HOLD_MAX_CS, MARKS_MAX, B0_MAX, BPM_MIN, BPM_MAX, MAX_CHORD, MAX_ACTIVE, CHART_V } from '../activity/js/games/beatcodec.js';

export const SECTION_CHOICES = Object.freeze([45000, 60000, 90000, 120000]);
export const CHART_DIFFS = Object.freeze({
  easy: Object.freeze({ grid: 4, base: 1.4, space: 300, gap: 280, chord: null, hold: null, runs: false, trills: true }),
  normal: Object.freeze({ grid: 2, base: 2.5, space: 180, gap: 200, chord: Object.freeze({ top: 0.03, bars: 2, per: 1, downbeat: true }), hold: null, runs: false, trills: true }),
  hard: Object.freeze({ grid: 1, loud: 0.5, base: 3.8, space: 110, gap: 140, chord: Object.freeze({ top: 0.08, bars: 1, per: 1, downbeat: false }), hold: Object.freeze({ min: 600, bars: 2 }), runs: false, trills: false }),
  expert: Object.freeze({ grid: 1, base: 5.4, space: 75, gap: 100, chord: Object.freeze({ top: 0.15, bars: 1, per: 2, downbeat: false, multi: true }), hold: Object.freeze({ min: 400, bars: 1 }), runs: true, trills: false }),
});
export const POS_BONUS = Object.freeze({ 4: 0.6, 2: 0.3, 1: 0.1 });
export const RUN_MIN = 4;
export const RUN_MAX = 8;
export const CONTOUR_STEP = 0.15;
export const HOLD_MAX_MS = 3000;
export const BAND_PITCH = Object.freeze({ L: 6, M: 9, H: 12 });

export function seeded(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rankAt(energy, t) {
  for (const w of energy) if (t >= w.t && t < w.end) return w.rank;
  return energy.length ? energy[energy.length - 1].rank : 0.5;
}

export function candidates(analysis, start, end) {
  const lo = start + FIRST_NOTE_MS;
  const hi = end - END_PAD_MS;
  const by = new Map();
  for (const o of analysis.onsets) {
    if (o.t < lo || o.t > hi) continue;
    let c = by.get(o.gi);
    if (!c) {
      const g = analysis.grid[o.gi];
      c = { t: o.t, gi: o.gi, q: o.q, beat: g ? g.beat : 0, bands: new Set(), s: 0, pitch: 0, pitchBand: '' };
      by.set(o.gi, c);
    }
    c.bands.add(o.band);
    c.s = Math.max(c.s, o.s);
    if (o.band === 'M' && o.pitch > 0) {
      c.pitch = o.pitch;
      c.pitchBand = 'M';
    } else if (!c.pitchBand) {
      c.pitch = BAND_PITCH[o.band];
    }
  }
  const out = [...by.values()].sort((a, b) => a.t - b.t);
  for (const c of out) {
    c.rank = rankAt(analysis.energy, c.t);
    c.bar = Math.floor((c.beat - (analysis.downbeat || 0)) / 4);
    c.down = (c.beat - (analysis.downbeat || 0)) % 4 === 0 && c.q === 4;
    c.score = c.s + POS_BONUS[c.q] + (c.bands.has('L') && c.q === 4 ? 0.2 : 0) + (c.bands.has('M') ? 0.15 : 0);
  }
  return out;
}

function allowed(c, cfg) {
  if (cfg.grid === 4) return c.q === 4;
  if (cfg.grid === 2) return c.q >= 2;
  if (cfg.loud !== undefined) return c.q >= 2 || c.rank > cfg.loud;
  return true;
}

function fits(times, t, space) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo < times.length && times[lo] - t < space) return false;
  if (lo > 0 && t - times[lo - 1] < space) return false;
  return true;
}

function insertSorted(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  times.splice(lo, 0, t);
}

function pickTimes(cands, prev, cfg, energy, rand) {
  const chosen = new Set(prev);
  const times = cands.filter((c) => chosen.has(c.gi)).map((c) => c.t).sort((a, b) => a - b);
  const jitter = new Map(cands.map((c) => [c.gi, rand() * 1e-3]));
  for (const w of energy) {
    const inWin = cands.filter((c) => c.t >= w.t && c.t < w.end);
    if (!inWin.length) continue;
    const secs = (w.end - w.t) / 1000;
    const target = Math.round(cfg.base * (0.6 + 0.8 * w.rank) * secs);
    let have = inWin.filter((c) => chosen.has(c.gi)).length;
    const pool = inWin.filter((c) => !chosen.has(c.gi) && allowed(c, cfg)).sort((a, b) => b.score + jitter.get(b.gi) - (a.score + jitter.get(a.gi)));
    for (const c of pool) {
      if (have >= target) break;
      if (!fits(times, c.t, cfg.space)) continue;
      chosen.add(c.gi);
      insertSorted(times, c.t);
      have += 1;
    }
  }
  return chosen;
}

function topScore(list, frac) {
  if (!list.length) return Infinity;
  const s = list.map((c) => c.score).sort((a, b) => b - a);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(frac * s.length) - 1))];
}

function planChords(list, cfg) {
  const out = new Set();
  if (!cfg.chord) return out;
  const ch = cfg.chord;
  const cut = topScore(list, ch.top);
  const used = new Map();
  for (const c of list) {
    const strong = c.score >= cut || (ch.multi && c.bands.size >= 2);
    if (!strong) continue;
    if (ch.downbeat && !c.down) continue;
    if (!ch.downbeat && c.q < 2) continue;
    const key = Math.floor(c.bar / ch.bars);
    const n = used.get(key) || 0;
    if (n >= ch.per) continue;
    used.set(key, n + 1);
    out.add(c.gi);
  }
  return out;
}

function addSustains(cands, chosen, analysis, cfg) {
  const byGi = new Map(cands.map((c) => [c.gi, c]));
  const times = cands.filter((c) => chosen.has(c.gi)).map((c) => c.t).sort((a, b) => a - b);
  for (const s of analysis.sustains) {
    const c = byGi.get(s.gi);
    if (!c || chosen.has(c.gi) || s.end - s.t < cfg.hold.min || !fits(times, c.t, cfg.space)) continue;
    chosen.add(c.gi);
    insertSorted(times, c.t);
  }
}

function planHolds(list, analysis, cfg, end) {
  const out = new Map();
  if (!cfg.hold) return out;
  const byGi = new Map(list.map((c) => [c.gi, c]));
  const used = new Set();
  let busyUntil = -Infinity;
  for (const s of analysis.sustains) {
    const c = byGi.get(s.gi);
    if (!c) continue;
    const stop = Math.min(s.end, c.t + HOLD_MAX_MS, end - END_PAD_MS);
    const len = Math.floor((stop - c.t) / 10) * 10;
    if (len < cfg.hold.min || len < HOLD_MIN_CS * 10 || len > HOLD_MAX_CS * 10) continue;
    const key = Math.floor(c.bar / cfg.hold.bars);
    if (used.has(key) || c.t <= busyUntil) continue;
    used.add(key);
    busyUntil = c.t + len;
    out.set(c.gi, c.t + len);
  }
  return out;
}

function planRuns(list, rand) {
  const out = new Map();
  let i = 0;
  let up = true;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].gi === list[j].gi + 1 && list[j + 1].bands.has('H')) j += 1;
    const len = j - i + 1;
    if (len >= RUN_MIN && list[i].bands.has('H')) {
      const trill = rand() < 0.25;
      for (let k = 0; k < len; k++) {
        if (k >= RUN_MAX) {
          out.set(list[i + k].gi, -1);
          continue;
        }
        const step = trill ? k % 2 : k % LANES;
        out.set(list[i + k].gi, up ? step : (trill ? 1 - step : LANES - 1 - step));
      }
      up = !up;
    }
    i = j + 1;
  }
  return out;
}

function quartileLane(pitches, p) {
  const sorted = [...pitches].sort((a, b) => a - b);
  let below = 0;
  for (const x of sorted) if (x < p) below += 1;
  const rank = sorted.length > 1 ? below / (sorted.length - 1) : 0.5;
  return Math.min(LANES - 1, Math.floor(rank * LANES));
}

function nearestFree(free, t, want, rand, avoid = new Set()) {
  const order = [0, 1, 2, 3].filter((l) => !avoid.has(l) && t >= free[l]).sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || rand() - 0.5);
  return order.length ? order[0] : -1;
}

function assignLanes(list, cfg, plans, rand) {
  const notes = [];
  const free = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pitches = [];
  const recent = [];
  let prev = null;
  let holdUntil = -Infinity;
  for (const c of list) {
    const run = plans.runs.get(c.gi);
    if (run === -1) continue;
    pitches.push(c.pitch);
    if (pitches.length > 8) pitches.shift();
    const q = quartileLane(pitches, c.pitch);
    let lane;
    if (run !== undefined) lane = run;
    else if (!prev) lane = q;
    else {
      const d = c.pitch - prev.pitch;
      if (d >= CONTOUR_STEP) lane = prev.l + 1;
      else if (d <= -CONTOUR_STEP) lane = prev.l - 1;
      else lane = prev.l ^ 1;
      if (lane >= LANES) lane = LANES - 2;
      if (lane < 0) lane = 1;
      if (Math.abs(lane - q) >= 2) lane += Math.sign(q - lane);
    }
    const chord = plans.chords.has(c.gi) && c.t > holdUntil;
    if (chord && c.down && c.bands.has('L') && c.t >= free[0] && c.t >= free[3]) lane = 0;
    if (cfg.trills && recent.length >= 4) {
      const [a, b, x, y] = recent.slice(-4);
      if (a === x && b === y && a !== b && lane === a) {
        const other = nearestFree(free, c.t, lane, rand, new Set([a, b]));
        if (other >= 0) lane = other;
      }
    }
    if (c.t < free[lane]) lane = nearestFree(free, c.t, lane, rand);
    if (lane < 0) continue;
    const holdEnd = plans.holds.get(c.gi);
    const note = { t: Math.round(c.t), l: lane, w: c.score };
    const canHold = holdEnd !== undefined && c.t > holdUntil;
    if (canHold) note.e = holdEnd;
    notes.push(note);
    free[lane] = Math.max(c.t + cfg.gap, (note.e !== undefined ? note.e : c.t) + Math.max(LANE_REST_MS, cfg.gap));
    if (canHold) holdUntil = note.e;
    recent.push(lane);
    if (recent.length > 6) recent.shift();
    if (chord && note.e === undefined) {
      const want = lane === 0 ? 3 : lane === 3 ? 0 : lane < 2 ? lane + 2 : lane - 2;
      const second = nearestFree(free, c.t, want, rand, new Set([lane]));
      if (second >= 0 && Math.abs(second - lane) >= 1) {
        notes.push({ t: Math.round(c.t), l: second, w: c.score - 0.01 });
        free[second] = c.t + cfg.gap;
      }
    }
    prev = { pitch: c.pitch, l: lane };
  }
  return notes;
}

function endOf(n) {
  return n.e !== undefined ? n.e : n.t;
}

export function legalize(notes, id, len) {
  const list = [...notes].sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  const free = [-Infinity, -Infinity, -Infinity, -Infinity];
  const holdsOk = HOLD_DIFFS.includes(id);
  for (const raw of list) {
    const n = { ...raw };
    if (n.e !== undefined) {
      const cs = Math.round((n.e - n.t) / 10);
      if (!holdsOk || cs < HOLD_MIN_CS) delete n.e;
      else n.e = n.t + Math.min(HOLD_MAX_CS, cs) * 10;
    }
    if (n.e !== undefined && n.e > len - END_PAD_MS) delete n.e;
    if (n.t < FIRST_NOTE_MS || n.t > len - END_PAD_MS) continue;
    if (n.l < 0 || n.l >= LANES || n.t < free[n.l]) continue;
    const same = out.filter((x) => x.t === n.t);
    if (same.length >= MAX_CHORD || same.some((x) => x.l === n.l)) continue;
    const active = out.filter((x) => x.e !== undefined && x.t < n.t && x.e >= n.t).length;
    if (active + same.length + 1 > MAX_ACTIVE) continue;
    if (n.e !== undefined && same.some((x) => x.e !== undefined)) delete n.e;
    out.push(n);
    free[n.l] = endOf(n) + LANE_REST_MS;
  }
  const weakest = (from, to) => {
    let k = from;
    for (let i = from; i <= to; i++) if ((out[i].w || 0) < (out[k].w || 0)) k = i;
    return k;
  };
  while (objectCount(out) > OBJECT_CAPS[id]) out.splice(weakest(0, out.length - 1), 1);
  const cap = NPS_CAPS[id];
  for (let changed = true; changed;) {
    changed = false;
    let j = 0;
    for (let i = 0; i < out.length; i++) {
      while (out[i].t - out[j].t >= 1000) j += 1;
      if (i - j + 1 > cap) {
        out.splice(weakest(j, i), 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function sectionMarks(analysis, start, end) {
  const out = [];
  for (const [t, kind] of analysis.marks || []) {
    if (t < start || t > end) continue;
    out.push([Math.round(t - start), kind]);
    if (out.length >= MARKS_MAX) break;
  }
  return out;
}

export function firstBeat(analysis, start) {
  for (const b of analysis.beats) if (b >= start) return Math.min(B0_MAX, Math.round(b - start));
  return 0;
}

export function makeCharts(analysis, { start = 0, end = analysis.dur, seed = 1 } = {}) {
  const len = Math.round(end - start);
  const rand = seeded(seed);
  const cands = candidates(analysis, start, end);
  const d = {};
  let prev = new Set();
  const all = {};
  for (const id of DIFF_IDS) {
    const cfg = CHART_DIFFS[id];
    const chosen = pickTimes(cands, prev, cfg, analysis.energy, rand);
    if (cfg.hold) addSustains(cands, chosen, analysis, cfg);
    const list = cands.filter((c) => chosen.has(c.gi));
    const holds = planHolds(list, analysis, cfg, end);
    const plans = { chords: planChords(list, cfg), holds, runs: cfg.runs ? planRuns(list, rand) : new Map() };
    const notes = assignLanes(list, cfg, plans, rand).map((n) => ({ ...n, t: n.t - start, ...(n.e !== undefined ? { e: n.e - start } : {}) }));
    all[id] = legalize(notes, id, len);
    prev = chosen;
  }
  for (let i = DIFF_IDS.length - 1; i > 0; i--) {
    const hi = all[DIFF_IDS[i]];
    const lo = all[DIFF_IDS[i - 1]];
    while (objectCount(lo) > objectCount(hi) && lo.length) {
      let k = 0;
      for (let j = 1; j < lo.length; j++) if ((lo[j].w || 0) < (lo[k].w || 0)) k = j;
      lo.splice(k, 1);
    }
  }
  for (const id of DIFF_IDS) d[id] = encodeNotes(all[id].map(({ w, ...n }) => n));
  const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(analysis.bpm * 100) / 100));
  return validateCharts({ v: CHART_V, bpm, b0: firstBeat(analysis, start), len, marks: sectionMarks(analysis, start, end), d }, len);
}

export function chartStats(charts) {
  const out = {};
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    out[id] = { objects: objectCount(notes), notes: notes.length, holds: notes.filter((n) => n.e !== undefined).length, peak: peakNps(notes) };
  }
  return out;
}

export function bestPart(analysis, lenMs) {
  const dur = analysis.dur;
  if (dur <= lenMs) return 0;
  const starts = [];
  const db = analysis.downbeat || 0;
  for (let i = db; i < analysis.beats.length; i += 4) {
    const t = analysis.beats[i];
    if (t >= 0 && t + lenMs <= dur) starts.push(Math.round(t));
  }
  if (!starts.length) starts.push(0);
  let best = starts[0];
  let bestScore = -Infinity;
  for (const s of starts) {
    const e = s + lenMs;
    let sum = 0;
    let span = 0;
    for (const w of analysis.energy) {
      const o = Math.min(e, w.end) - Math.max(s, w.t);
      if (o <= 0) continue;
      sum += w.rank * o;
      span += o;
    }
    const score = span ? sum / span : 0;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export function snapToDownbeat(analysis, t) {
  const db = analysis.downbeat || 0;
  let best = 0;
  let dist = Infinity;
  for (let i = db; i < analysis.beats.length; i += 4) {
    const d = Math.abs(analysis.beats[i] - t);
    if (d < dist) {
      dist = d;
      best = Math.round(analysis.beats[i]);
    }
  }
  return Math.max(0, best);
}
