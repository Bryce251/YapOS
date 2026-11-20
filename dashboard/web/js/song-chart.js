import { encodeNotes, decodeNotes, validateCharts, objectCount, peakNps, DIFF_IDS, OBJECT_CAPS, NPS_CAPS, HOLD_DIFFS, LANES, LANE_REST_MS, FIRST_NOTE_MS, END_PAD_MS, HOLD_MIN_CS, HOLD_MAX_CS, MARKS_MAX, B0_MAX, BPM_MIN, BPM_MAX, MAX_CHORD, MAX_ACTIVE, CHART_V } from '../activity/js/games/beatcodec.js';
import { bpmOf } from './beat-grid.js';

export const SECTION_CHOICES = Object.freeze([45000, 60000, 90000, 120000, 150000]);
export const FULL_SECTION = 0;
export const BEST_PART_MS = 60000;
export const CHART_DIFFS = Object.freeze({
  easy: Object.freeze({ q: 4, nps: 1.3, space: 380, jack: 700, chord: null, hold: null, runs: false, trills: true }),
  normal: Object.freeze({ q: 2, nps: 2.4, space: 200, jack: 420, chord: Object.freeze({ top: 0.1, bars: 2, per: 1, down: true, loud: 0.5 }), hold: null, runs: false, trills: true }),
  hard: Object.freeze({ q: 2, loud: 0.45, nps: 3.7, space: 115, jack: 240, chord: Object.freeze({ top: 0.18, bars: 1, per: 1, down: false, loud: 0 }), hold: Object.freeze({ min: 500, bars: 2 }), runs: false, trills: false }),
  expert: Object.freeze({ q: 1, nps: 5.3, space: 80, jack: 150, chord: Object.freeze({ top: 0.3, bars: 1, per: 2, down: false, loud: 0, multi: true }), hold: Object.freeze({ min: 350, bars: 1 }), runs: true, trills: false }),
});
export const SECTION_SCALE = Object.freeze({ intro: 0.6, quiet: 0.7, build: 0.95, main: 1, drop: 1.2 });
export const POS_BONUS = Object.freeze({ 4: 0.6, 2: 0.3, 1: 0.1 });
export const KIND_HOME = Object.freeze({ kick: Object.freeze([0, 1]), snare: Object.freeze([2, 3]), hat: Object.freeze([3, 1]) });
export const PHRASE_BARS = 4;
export const RUN_MIN = 4;
export const RUN_MAX = 8;
export const HOLD_MAX_MS = 3000;
export const TONAL_MEMORY_MS = 2000;

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

function windowAt(energy, t) {
  for (const w of energy) if (t >= w.t && t < w.end) return w;
  return energy.length ? energy[energy.length - 1] : { t: 0, end: Infinity, rank: 0.5, label: 'main' };
}

function leadKind(c) {
  const k = c.kinds;
  if (k.has('kick') && c.q === 4 && k.get('kick') >= 0.5 * c.s) return 'kick';
  if (k.has('snare') && c.back && k.get('snare') >= 0.5 * c.s) return 'snare';
  if (k.has('tonal') && k.get('tonal') >= 0.6 * c.s && c.pitch) return 'tonal';
  let best = 'hat';
  let bs = -1;
  for (const [kind, s] of k) if (s > bs) { bs = s; best = kind; }
  return best === 'tonal' && !c.pitch ? 'snare' : best;
}

export function candidates(analysis, start, end) {
  const lo = start + FIRST_NOTE_MS;
  const hi = end - END_PAD_MS;
  const meter = analysis.meter || 4;
  const db = analysis.downbeat || 0;
  const energy = analysis.energy || [];
  const by = new Map();
  for (const o of analysis.onsets) {
    if (o.t < lo || o.t > hi) continue;
    let c = by.get(o.gi);
    if (!c) {
      const g = analysis.grid[o.gi] || {};
      c = { t: o.t, gi: o.gi, q: o.q, beat: g.beat || 0, k: g.k || 0, kinds: new Map(), bands: new Set(), s: 0, pitch: 0, ts: 0, off: 1 };
      by.set(o.gi, c);
    }
    const kind = o.kind || (o.band === 'L' ? 'kick' : o.band === 'H' ? 'hat' : 'snare');
    c.kinds.set(kind, Math.max(c.kinds.get(kind) || 0, o.s));
    c.bands.add(o.band);
    if (o.s > c.s) c.t = o.t;
    c.s = Math.max(c.s, o.s);
    c.off = Math.min(c.off, o.off || 0);
    if (o.pitch && (kind === 'tonal' || !c.pitch) && o.s >= c.ts) {
      c.pitch = o.pitch;
      c.ts = o.s;
    }
  }
  const out = [...by.values()].sort((a, b) => a.t - b.t);
  const slots = new Map();
  for (const c of out) {
    const rel = c.beat - db;
    c.bar = Math.floor(rel / meter);
    c.pos = rel - c.bar * meter;
    c.down = c.pos === 0 && c.q === 4;
    c.back = meter === 4 && (c.pos === 1 || c.pos === 3) && c.q === 4;
    c.kind = leadKind(c);
    const w = windowAt(energy, c.t);
    c.rank = w.rank;
    c.label = w.label || 'main';
    c.slot = `${c.pos}.${c.k}.${c.kind}`;
    const sl = slots.get(c.slot) || { n: 0, s: 0 };
    sl.n += 1;
    sl.s += c.s;
    slots.set(c.slot, sl);
  }
  const bars = new Set(out.map((c) => c.bar)).size || 1;
  for (const c of out) {
    const sl = slots.get(c.slot);
    const steady = (sl.s / sl.n) * Math.min(1, sl.n / bars);
    c.score = 0.4 * c.s + 0.6 * steady + POS_BONUS[c.q] + (c.down ? 0.25 : 0) + (c.kind === 'kick' && c.q === 4 ? 0.2 : 0) + (c.kind === 'snare' && c.back ? 0.25 : 0) + (c.kinds.has('tonal') ? 0.15 : 0) + (c.kinds.size >= 2 ? 0.1 : 0) - 0.6 * c.off;
  }
  return out;
}

function allowed(c, cfg) {
  if (c.q >= cfg.q) return true;
  return cfg.loud !== undefined && c.rank > cfg.loud;
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

export function sectionTarget(cfg, w) {
  const secs = (w.end - w.t) / 1000;
  return Math.round(cfg.nps * (0.55 + 0.7 * w.rank) * (SECTION_SCALE[w.label] || 1) * secs);
}

function pickTimes(cands, prev, cfg, energy, rand) {
  const chosen = new Set(prev);
  const times = cands.filter((c) => chosen.has(c.gi)).map((c) => c.t).sort((a, b) => a - b);
  const jitter = new Map(cands.map((c) => [c.gi, rand() * 1e-3]));
  const wins = energy.length ? energy : [{ t: 0, end: Infinity, rank: 0.5, label: 'main' }];
  for (const w of wins) {
    const inWin = cands.filter((c) => c.t >= w.t && c.t < w.end);
    if (!inWin.length) continue;
    const target = sectionTarget(cfg, { ...w, end: Math.min(w.end, inWin[inWin.length - 1].t + 1000), t: Math.max(w.t, inWin[0].t - 1000) });
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

function addSustains(cands, chosen, analysis, cfg) {
  const byGi = new Map(cands.map((c) => [c.gi, c]));
  const times = cands.filter((c) => chosen.has(c.gi)).map((c) => c.t).sort((a, b) => a - b);
  for (const s of analysis.sustains || []) {
    const c = byGi.get(s.gi);
    if (!c || chosen.has(c.gi) || s.end - s.t < cfg.hold.min || !fits(times, c.t, cfg.space)) continue;
    chosen.add(c.gi);
    insertSorted(times, c.t);
  }
}

function cutoff(list, frac) {
  if (!list.length) return Infinity;
  const s = list.map((c) => c.score).sort((a, b) => b - a);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(frac * s.length) - 1))];
}

function planChords(list, cfg, marks) {
  const out = new Set();
  const ch = cfg.chord;
  if (!ch) return out;
  const cut = cutoff(list, ch.top);
  const used = new Map();
  const drops = (marks || []).filter((m) => m[1] === 'drop').map((m) => m[0]);
  const atDrop = new Set();
  for (const d of drops) {
    const c = list.find((x) => x.t >= d - 30 && x.q === 4);
    if (c) atDrop.add(c.gi);
  }
  for (const c of list) {
    const accent = atDrop.has(c.gi) || (c.score >= cut && (c.kinds.has('kick') || c.kinds.size >= 2 || c.down)) || (ch.multi && c.kinds.size >= 2 && c.s >= 0.6);
    if (!accent) continue;
    if (ch.down && !c.down) continue;
    if (!ch.down && c.q < 2) continue;
    if (c.rank < ch.loud && !atDrop.has(c.gi)) continue;
    const key = Math.floor(c.bar / ch.bars);
    const n = used.get(key) || 0;
    if (n >= ch.per) continue;
    used.set(key, n + 1);
    out.add(c.gi);
  }
  return out;
}

function planHolds(list, analysis, cfg, end) {
  const out = new Map();
  if (!cfg.hold) return out;
  const byGi = new Map(list.map((c) => [c.gi, c]));
  let busyUntil = -Infinity;
  const used = new Set();
  for (const s of analysis.sustains || []) {
    const c = byGi.get(s.gi);
    if (!c || c.t <= busyUntil) continue;
    const key = Math.floor(c.bar / cfg.hold.bars);
    if (used.has(key)) continue;
    const next = list.find((x) => x.t > c.t + 200 && x.kinds.has('tonal') && x.pitch === s.pitch);
    const stop = Math.min(s.end, c.t + HOLD_MAX_MS, end - END_PAD_MS, next ? next.t - LANE_REST_MS - 10 : Infinity);
    const len = Math.floor((stop - c.t) / 10) * 10;
    if (len < cfg.hold.min || len < HOLD_MIN_CS * 10 || len > HOLD_MAX_CS * 10) continue;
    used.add(key);
    busyUntil = c.t + len;
    out.set(c.gi, c.t + len);
  }
  return out;
}

function planRuns(list) {
  const out = new Map();
  let i = 0;
  let up = true;
  const drum = (c) => c.kind === 'hat' || c.kind === 'snare';
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].gi === list[j].gi + 1 && drum(list[j + 1])) j += 1;
    const len = j - i + 1;
    if (len >= RUN_MIN && drum(list[i])) {
      for (let k = 0; k < len; k++) {
        if (k >= RUN_MAX) {
          out.set(list[i + k].gi, -1);
          continue;
        }
        const step = k % (2 * LANES - 2);
        const lane = step < LANES ? step : 2 * LANES - 2 - step;
        out.set(list[i + k].gi, up ? lane : LANES - 1 - lane);
      }
      up = !up;
    }
    i = j + 1;
  }
  return out;
}

function registerLane(pitches, p) {
  if (pitches.length < 2) return 1 + (p % 2);
  let below = 0;
  for (const x of pitches) if (x < p) below += 1;
  return Math.min(LANES - 1, Math.floor((below / pitches.length) * LANES));
}

function signature(notes) {
  return notes.map((c) => `${c.pos}.${c.k}.${c.kind}${c.kind === 'tonal' ? c.pitch : ''}`).join('|');
}

function makeLaner(cfg, rand) {
  const homes = {
    kick: rand() < 0.5 ? KIND_HOME.kick : [KIND_HOME.kick[1], KIND_HOME.kick[0]],
    snare: rand() < 0.5 ? KIND_HOME.snare : [KIND_HOME.snare[1], KIND_HOME.snare[0]],
    hat: KIND_HOME.hat,
  };
  const free = [-Infinity, -Infinity, -Infinity, -Infinity];
  const last = [-Infinity, -Infinity, -Infinity, -Infinity];
  const recent = [];
  let hatFlip = rand() < 0.5 ? 0 : 1;
  let tonal = null;
  let kickPrev = null;
  const pitches = [];

  function want(c, run) {
    if (run !== undefined) return run;
    if (c.kind === 'kick') {
      const home = homes.kick;
      const l = kickPrev && c.t - kickPrev.t < cfg.jack ? home[(home.indexOf(kickPrev.l) + 1) % 2] : home[0];
      return l;
    }
    if (c.kind === 'snare') return homes.snare[c.t - last[homes.snare[0]] < cfg.jack ? 1 : 0];
    if (c.kind === 'hat') {
      hatFlip ^= 1;
      return homes.hat[hatFlip];
    }
    pitches.push(c.pitch);
    if (pitches.length > 16) pitches.shift();
    const reg = registerLane(pitches, c.pitch);
    if (!tonal || c.t - tonal.t > TONAL_MEMORY_MS) return reg;
    const d = c.pitch - tonal.pitch;
    let l = d > 0 ? tonal.l + 1 : d < 0 ? tonal.l - 1 : tonal.l;
    if (l >= LANES) l = LANES - 2;
    if (l < 0) l = 1;
    if (Math.abs(l - reg) >= 2) l += Math.sign(reg - l);
    return l;
  }

  function trillish(l) {
    if (!cfg.trills || recent.length < 4) return false;
    const [a, b, x, y] = recent.slice(-4);
    return a === x && b === y && a !== b && l === a;
  }

  function settle(c, l, avoid = null) {
    const order = [l, l ^ 1, ...[0, 1, 2, 3].sort((p, q) => Math.abs(p - l) - Math.abs(q - l) || rand() - 0.5)];
    const seen = new Set();
    let fallback = -1;
    for (const x of order) {
      if (seen.has(x) || x === avoid) continue;
      seen.add(x);
      if (c.t < free[x]) continue;
      if (c.t - last[x] >= cfg.jack && !trillish(x)) return x;
      if (fallback < 0 || last[x] < last[fallback]) fallback = x;
    }
    return fallback;
  }

  function place(c, l, end) {
    free[l] = Math.max(c.t + Math.min(cfg.jack, 160), (end !== undefined ? end : c.t) + LANE_REST_MS);
    last[l] = end !== undefined ? end : c.t;
  }

  function commit(c, l) {
    recent.push(l);
    if (recent.length > 6) recent.shift();
    if (c.kind === 'tonal') tonal = { t: c.t, pitch: c.pitch, l };
    if (c.kind === 'kick') kickPrev = { t: c.t, l };
  }

  return { want, settle, place, commit, free };
}

function assignLanes(list, cfg, plans, rand) {
  const notes = [];
  const laner = makeLaner(cfg, rand);
  const patterns = new Map();
  const flipStart = rand() < 0.5;
  let holdUntil = -Infinity;
  const bars = new Map();
  for (const c of list) {
    if (!bars.has(c.bar)) bars.set(c.bar, []);
    bars.get(c.bar).push(c);
  }
  for (const [bar, inBar] of bars) {
    const mirrored = (Math.floor(bar / PHRASE_BARS) % 2 === 1) !== flipStart;
    const sig = signature(inBar);
    const stored = patterns.get(sig);
    const base = [];
    for (let j = 0; j < inBar.length; j++) {
      const c = inBar[j];
      const run = plans.runs.get(c.gi);
      if (run === -1) {
        base.push(-1);
        continue;
      }
      const w = stored && stored[j] >= 0 ? stored[j] : laner.want(c, run);
      const lane = laner.settle(c, mirrored ? LANES - 1 - w : w);
      if (lane < 0) {
        base.push(-1);
        continue;
      }
      base.push(mirrored ? LANES - 1 - lane : lane);
      const holdEnd = plans.holds.get(c.gi);
      const note = { t: Math.round(c.t), l: lane, w: c.score };
      if (holdEnd !== undefined && c.t > holdUntil) {
        note.e = holdEnd;
        holdUntil = holdEnd;
      }
      notes.push(note);
      laner.place(c, lane, note.e);
      laner.commit(c, lane);
      if (plans.chords.has(c.gi) && note.e === undefined && c.t > holdUntil) {
        const other = lane < 2 ? lane + 2 : lane - 2;
        const second = laner.settle(c, other, lane);
        if (second >= 0 && (second < 2) !== (lane < 2)) {
          notes.push({ t: Math.round(c.t), l: second, w: c.score - 0.01 });
          laner.place(c, second);
        }
      }
    }
    if (!stored && inBar.length) patterns.set(sig, base);
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
  const meter = analysis.meter || 4;
  const db = analysis.downbeat || 0;
  for (let i = 0; i < analysis.beats.length; i++) {
    const b = analysis.beats[i];
    if (b < start || (((i - db) % meter) + meter) % meter !== 0) continue;
    if (b - start <= B0_MAX) return Math.round(b - start);
    break;
  }
  for (const b of analysis.beats) if (b >= start) return Math.min(B0_MAX, Math.round(b - start));
  return 0;
}

export function chartBpm(analysis, start, end) {
  let bpm = bpmOf(analysis.beats, start, end) || analysis.bpm || 120;
  while (bpm < BPM_MIN) bpm *= 2;
  while (bpm > BPM_MAX) bpm /= 2;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 100) / 100));
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
    const chosen = pickTimes(cands, prev, cfg, analysis.energy || [], rand);
    if (cfg.hold) addSustains(cands, chosen, analysis, cfg);
    const list = cands.filter((c) => chosen.has(c.gi));
    const plans = { chords: planChords(list, cfg, analysis.marks), holds: planHolds(list, analysis, cfg, end), runs: cfg.runs ? planRuns(list) : new Map() };
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
  return validateCharts({ v: CHART_V, bpm: chartBpm(analysis, start, end), b0: firstBeat(analysis, start), len, marks: sectionMarks(analysis, start, end), d }, len);
}

export function chartStats(charts) {
  const out = {};
  for (const id of DIFF_IDS) {
    const notes = decodeNotes(charts.d[id]);
    out[id] = { objects: objectCount(notes), notes: notes.length, holds: notes.filter((n) => n.e !== undefined).length, peak: peakNps(notes) };
  }
  return out;
}

function downbeatTimes(analysis) {
  const meter = analysis.meter || 4;
  const db = analysis.downbeat || 0;
  const out = [];
  for (let i = db; i < analysis.beats.length; i += meter) out.push(analysis.beats[i]);
  return out;
}

export function bestPart(analysis, lenMs) {
  const dur = analysis.dur;
  if (dur <= lenMs) return 0;
  const starts = downbeatTimes(analysis).filter((t) => t >= 0 && t + lenMs <= dur).map((t) => Math.round(t));
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
      sum += (w.rank + (w.label === 'drop' ? 0.1 : 0)) * o;
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
  let best = 0;
  let dist = Infinity;
  for (const b of downbeatTimes(analysis)) {
    const d = Math.abs(b - t);
    if (d < dist) {
      dist = d;
      best = Math.round(b);
    }
  }
  return Math.max(0, best);
}
