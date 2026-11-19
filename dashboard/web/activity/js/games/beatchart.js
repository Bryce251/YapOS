export const INTRO_BARS = 2;
export const STEPS = 16;
export const MAX_NOTES = 640;
export const TAIL_SECS = 1.5;
export const MIN_BARS = 8;
export const SEED_MAX = 2147483646;
export const JACK_SECS = 0.22;
export const STRAY_MAX = 4;
export const STRAY_MS = 800;
export const TIERS = Object.freeze([10, 25, 50, 100]);
export const MAX_SCORE = 1000;

export const SCALES = Object.freeze({
  minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
});

export const PENTA = Object.freeze({
  minor: Object.freeze([0, 3, 5, 7, 10]),
  major: Object.freeze([0, 2, 4, 7, 9]),
});

export const PROGS = Object.freeze({
  minor: Object.freeze([
    Object.freeze([0, 5, 2, 6]),
    Object.freeze([0, 3, 5, 4]),
    Object.freeze([0, 6, 5, 6]),
    Object.freeze([5, 3, 0, 4]),
  ]),
  major: Object.freeze([
    Object.freeze([0, 4, 5, 3]),
    Object.freeze([0, 5, 3, 4]),
    Object.freeze([3, 4, 0, 5]),
    Object.freeze([0, 3, 0, 4]),
  ]),
});

function style(o) {
  return Object.freeze({ ...o, bpms: Object.freeze(o.bpms) });
}

export const STYLES = Object.freeze([
  style({ id: 'chill', name: 'Night Drive', emoji: '🌙', bpm: 88, bpms: [84, 88, 96, 104], mode: 'minor', root: 45, swing: 0.12, wave: 'triangle', cut: 560, kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: '0......0..2.....', arp: '0...1...2...1...' }),
  style({ id: 'funk', name: 'Pocket Funk', emoji: '🕺', bpm: 100, bpms: [96, 100, 108], mode: 'major', root: 40, swing: 0.06, wave: 'square', cut: 760, kick: 'x..x..x...x..x..', snare: '....x..x....x...', hat: 'x.xxx.xxx.xxx.xx', bass: '0..0..3...2..1..', arp: '2.1.0...2.1.3...' }),
  style({ id: 'pop', name: 'Sugar Rush', emoji: '🍬', bpm: 112, bpms: [104, 108, 112, 120], mode: 'major', root: 43, swing: 0, wave: 'square', cut: 900, kick: 'x.....x.x.......', snare: '....x.......x...', hat: '..x...x...x...x.', bass: '0.0.0.0.1.1.2.2.', arp: '0.1.2.3.2.1.0.1.' }),
  style({ id: 'house', name: 'Neon Floor', emoji: '🪩', bpm: 124, bpms: [108, 116, 124, 128], mode: 'minor', root: 41, swing: 0, wave: 'sawtooth', cut: 700, kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', bass: '..0...0...0...3.', arp: '0.2.1.3.0.2.1.2.' }),
  style({ id: 'rush', name: 'Turbo Lane', emoji: '🏎️', bpm: 148, bpms: [132, 140, 148], mode: 'minor', root: 40, swing: 0, wave: 'sawtooth', cut: 1100, kick: 'x.....x...x..x..', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: '0.0...0.3.0...2.', arp: '0.1.2.1.3.1.2.1.' }),
]);

export const DIFFS = Object.freeze([
  Object.freeze({ id: 'easy', name: 'Chill', lanes: 2, rate: 1.2, look: 2.1, gap: 300, win: Object.freeze([60, 110, 160]), grid: 4, spread: 0.5, chords: false, bpm: Object.freeze([84, 108]) }),
  Object.freeze({ id: 'normal', name: 'Normal', lanes: 3, rate: 2.0, look: 1.7, gap: 220, win: Object.freeze([50, 100, 150]), grid: 2, spread: 0.2, chords: false, bpm: Object.freeze([96, 132]) }),
  Object.freeze({ id: 'hard', name: 'Hard', lanes: 4, rate: 3.2, look: 1.35, gap: 150, win: Object.freeze([45, 90, 135]), grid: 1, spread: 0.1, chords: true, bpm: null }),
]);

export const SECTION_RATE = Object.freeze({ verse: 0.8, build: 0.7, drop: 1.15 });
export const CYCLE = Object.freeze(['verse', 'build', 'drop', 'drop']);
export const SLOWER_SECS = 0.4;

export function styleById(id) {
  return STYLES.find((s) => s.id === id) || null;
}

export function diffIdx(v) {
  if (v === 0 || v === 1 || v === 2) return v;
  const i = DIFFS.findIndex((d) => d.id === v);
  return i >= 0 ? i : 1;
}

export function diffOf(v) {
  return DIFFS[diffIdx(v)];
}

export function lanesFor(df) {
  return diffOf(df).lanes;
}

export function windowsFor(df) {
  const w = diffOf(df).win;
  return { p: w[0], g: w[1], o: w[2] };
}

export function lookFor(df, slower = false) {
  return diffOf(df).look + (slower ? SLOWER_SECS : 0);
}

export function bpmFor(styleId, df) {
  const st = styleById(styleId) || STYLES[0];
  const range = diffOf(df).bpm;
  if (!range) return st.bpm;
  const [lo, hi] = range;
  const fit = st.bpms.filter((b) => b >= lo && b <= hi);
  if (fit.length) return fit.reduce((a, b) => (Math.abs(b - st.bpm) < Math.abs(a - st.bpm) ? b : a));
  return Math.max(lo, Math.min(hi, st.bpm));
}

export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function chordTone(mode, deg, idx) {
  const scale = SCALES[mode] || SCALES.minor;
  if (idx === 3) return scale[deg % 7] + 12 * (Math.floor(deg / 7) + 1);
  const d = deg + [0, 2, 4][Math.max(0, Math.min(2, idx))];
  return scale[d % 7] + 12 * Math.floor(d / 7);
}

export function tierOf(streak) {
  let t = 0;
  for (const x of TIERS) if (streak >= x) t += 1;
  return t;
}

export function scoreOf(p, g, o, best, n) {
  if (!(n > 0)) return 0;
  const raw = (900 * (10 * p + 7 * g + 4 * o)) / (10 * n) + (100 * Math.min(best, p + g + o)) / n;
  return Math.max(0, Math.min(MAX_SCORE, Math.round(raw)));
}

export function accOf(p, g, o, n) {
  if (!(n > 0)) return 0;
  return Math.max(0, Math.min(1, (p + 0.7 * g + 0.4 * o) / n));
}

export function gradeOf(score) {
  if (score >= 950) return 'S';
  if (score >= 850) return 'A';
  if (score >= 700) return 'B';
  if (score >= 500) return 'C';
  return 'D';
}

function planBars(bars, random) {
  const plan = [];
  for (let b = 0; b < bars; b += 1) {
    let sec;
    let pos = 0;
    if (b < INTRO_BARS) sec = 'intro';
    else if (b === bars - 1) sec = 'outro';
    else {
      sec = CYCLE[Math.floor((b - INTRO_BARS) / 4) % CYCLE.length];
      pos = (b - INTRO_BARS) % 4;
    }
    plan.push({ sec, pos });
  }
  for (let b = 0; b < bars; b += 1) {
    const next = plan[b + 1];
    plan[b].roll = plan[b].sec === 'build' && Boolean(next) && next.sec === 'drop' ? 1 : 0;
    plan[b].fill = plan[b].sec === 'verse' && (b - INTRO_BARS) % 4 === 3 && random() < 0.5 ? 1 : 0;
  }
  return plan;
}

export function sectionRate(bar) {
  if (!bar) return 0;
  if (bar.sec === 'build') return 0.7 + 0.1 * Math.min(3, bar.pos);
  return SECTION_RATE[bar.sec] || 0;
}

function hit(pattern, s) {
  return typeof pattern === 'string' && pattern[s] === 'x';
}

function tone(pattern, s) {
  const c = typeof pattern === 'string' ? pattern[s] : '.';
  return c >= '0' && c <= '3' ? Number(c) : null;
}

export function stepTime(song, k) {
  const s = k % STEPS;
  return k * song.step + (s % 2 === 1 ? song.swing * song.step : 0);
}

export function chordRoot(song, sec) {
  const st = styleById(song.style) || STYLES[0];
  const b = Math.max(0, Math.floor(sec / song.bar));
  const deg = b < INTRO_BARS || b >= song.bars - 1 ? song.prog[0] : song.prog[(b - INTRO_BARS + 400) % song.prog.length];
  return { root: song.root + chordTone(st.mode, deg, 0), mode: st.mode };
}

export function stepAt(song, k) {
  const b = Math.floor(k / STEPS);
  const s = k % STEPS;
  const bar = song.plan[b];
  const st = styleById(song.style) || STYLES[0];
  const out = { k, t: stepTime(song, k), sec: bar ? bar.sec : 'outro', kick: false, snare: false, hat: false, roll: false, bass: null, chord: null, arp: null, crash: false };
  if (!bar) return out;
  const deg = song.prog[(b - INTRO_BARS + 400) % song.prog.length];
  const root = song.root;
  if (bar.sec === 'outro') {
    if (s === 0) {
      out.kick = true;
      out.crash = true;
      out.bass = root + chordTone(st.mode, song.prog[0], 0);
      out.chord = [0, 1, 2].map((i) => root + 12 + chordTone(st.mode, song.prog[0], i));
    }
    return out;
  }
  out.kick = hit(st.kick, s);
  out.hat = hit(st.hat, s) || (bar.sec === 'build' && s % 2 === 0);
  if (bar.sec === 'intro') {
    if (s % 4 === 0) out.hat = true;
    if (b === INTRO_BARS - 1) {
      const t = tone(st.bass, s);
      if (t !== null) out.bass = root + chordTone(st.mode, deg, t);
    }
    return out;
  }
  out.snare = hit(st.snare, s) || (bar.fill === 1 && s >= 14);
  out.roll = bar.roll === 1 && s >= 12;
  if (out.roll) out.snare = true;
  const t = tone(st.bass, s);
  if (t !== null) out.bass = root + chordTone(st.mode, deg, t);
  if (s === 0) out.chord = [0, 1, 2].map((i) => root + 12 + chordTone(st.mode, deg, i));
  if (bar.sec === 'drop') {
    const a = tone(st.arp, s);
    if (a !== null) out.arp = root + 24 + chordTone(st.mode, deg, a);
    if (s === 8) out.chord = [0, 1, 2].map((i) => root + 12 + chordTone(st.mode, deg, i));
    if (s === 0 && (b - INTRO_BARS) % 8 === 0) out.crash = true;
  }
  return out;
}

function priority(ev, d) {
  if (ev.roll) return d.grid === 1 ? 3 : 2;
  if (ev.kick || ev.snare) return 3;
  if (ev.bass !== null) return 2;
  if (ev.arp !== null) return 1.5;
  if (ev.hat) return 1;
  return 0;
}

function kindOf(ev) {
  if (ev.kick && !ev.snare) return 'k';
  if (ev.snare) return 's';
  if (ev.bass !== null) return 'b';
  if (ev.arp !== null) return 'a';
  return 'h';
}

function virtualLane(ev, t, last, random) {
  let lane;
  if (ev.kick && !ev.snare) lane = random() < 0.5 ? 0 : 1;
  else if (ev.snare) lane = random() < 0.5 ? 2 : 3;
  else if (ev.bass !== null) lane = ((ev.bass % 12) + 12) % 4;
  else lane = Math.floor(random() * 4) % 4;
  if (t - last[lane] >= JACK_SECS) return lane;
  const open = [0, 1, 2, 3].filter((l) => l !== lane && t - last[l] >= JACK_SECS);
  if (open.length) return open[Math.floor(random() * open.length) % open.length];
  let oldest = 0;
  for (let l = 1; l < 4; l += 1) if (last[l] < last[oldest]) oldest = l;
  return oldest;
}

export function foldLane(vl, kind, lanes) {
  if (lanes === 2) return vl < 2 ? 0 : 1;
  if (lanes === 3) return kind === 'k' ? 0 : kind === 's' ? 2 : 1;
  return vl;
}

export function songLength(bpm, len) {
  const bar = 240 / bpm;
  const bars = Math.max(MIN_BARS, Math.round(Number(len) / bar) + 1);
  return { bars, bar };
}

function nearest(lanes, from, random) {
  const out = [];
  for (let l = 0; l < lanes; l += 1) if (l !== from) out.push({ l, d: Math.abs(l - from), r: random() });
  return out.sort((a, b) => a.d - b.d || a.r - b.r).map((x) => x.l);
}

export function buildSong(seed, styleId, df, len, bpm) {
  const st = styleById(styleId) || STYLES[0];
  const di = diffIdx(df);
  const d = DIFFS[di];
  const lanes = d.lanes;
  const s = Math.max(1, Math.min(SEED_MAX, Math.floor(Number(seed)) || 1));
  const random = rng(s);
  const tempo = Number.isFinite(Number(bpm)) && Number(bpm) >= 60 && Number(bpm) <= 200 ? Math.round(Number(bpm)) : st.bpm;
  const { bars, bar } = songLength(tempo, len);
  const modeProgs = PROGS[st.mode];
  const song = {
    seed: s,
    style: st.id,
    df: di,
    lanes,
    bpm: tempo,
    beat: 60 / tempo,
    step: 60 / tempo / 4,
    swing: st.swing,
    bars,
    bar,
    root: st.root + (s % 5) - 2,
    prog: modeProgs[Math.floor(random() * modeProgs.length)],
    plan: planBars(bars, random),
    look: d.look,
    notes: [],
    dur: 0,
  };
  const raw = [];
  for (let q = 0; q < INTRO_BARS * 4; q += 1) raw.push({ t: stepTime(song, q * 4), fixed: q % 2 === 0 ? 0 : lanes - 1 });
  const vlast = [-Infinity, -Infinity, -Infinity, -Infinity];
  let prevT = -Infinity;
  for (let b = INTRO_BARS; b < bars - 1; b += 1) {
    const plan = song.plan[b];
    const mult = sectionRate(plan);
    const evs = [];
    for (let k = b * STEPS; k < (b + 1) * STEPS; k += 1) {
      const si = k % STEPS;
      const ev = stepAt(song, k);
      const p = priority(ev, d);
      if (!p) continue;
      if (si % d.grid !== 0 && !(ev.roll && d.grid <= 2 && si % 2 === 0)) continue;
      evs.push({ ev, p, r: random(), si });
    }
    const want = Math.max(0, Math.round(d.rate * bar * mult + (random() - 0.5) * 0.8));
    evs.sort((a, c) => c.p - a.p || a.r - c.r);
    const picked = [];
    for (const x of evs) {
      if (picked.length >= want) break;
      const t = x.ev.t;
      if (t - prevT < d.spread - 1e-9) continue;
      if (picked.every((y) => Math.abs(y.ev.t - t) >= d.spread - 1e-9)) picked.push(x);
    }
    picked.sort((a, c) => a.ev.t - c.ev.t);
    let chorded = false;
    for (const x of picked) {
      const t = x.ev.t;
      const vl = virtualLane(x.ev, t, vlast, random);
      vlast[vl] = t;
      const kind = kindOf(x.ev);
      raw.push({ t, l: foldLane(vl, kind, lanes) });
      if (d.chords && plan.sec === 'drop' && x.si === 0 && !chorded && random() < 0.7) {
        chorded = true;
        raw.push({ t, chord: true });
      }
      prevT = t;
    }
    if (raw.length >= MAX_NOTES) break;
  }
  const notes = [];
  const last = new Array(lanes).fill(-Infinity);
  const gap = d.gap / 1000;
  let runLane = -1;
  let run = 0;
  let mainAt = -Infinity;
  let mainLane = -1;
  for (const n of raw) {
    if (n.chord) {
      if (n.t !== mainAt || mainLane < 0) continue;
      const opts = nearest(lanes, mainLane, random).filter((l) => n.t - last[l] >= gap - 1e-9);
      if (!opts.length) continue;
      const l = opts[Math.floor(random() * opts.length) % opts.length];
      notes.push({ t: n.t, l, c: 1 });
      last[l] = n.t;
      continue;
    }
    let l = n.fixed !== undefined ? n.fixed : n.l;
    const tooMany = lanes < 4 && l === runLane && run >= 2;
    if (tooMany || n.t - last[l] < gap - 1e-9) {
      const alt = nearest(lanes, l, random).find((c) => n.t - last[c] >= gap - 1e-9 && !(lanes < 4 && c === runLane && run >= 2));
      if (alt === undefined) continue;
      l = alt;
    }
    notes.push({ t: n.t, l });
    last[l] = n.t;
    if (l === runLane) run += 1;
    else {
      runLane = l;
      run = 1;
    }
    mainAt = n.t;
    mainLane = l;
  }
  notes.sort((a, c) => a.t - c.t || a.l - c.l);
  song.notes = notes.slice(0, MAX_NOTES).map((n) => (n.c ? { t: Math.round(n.t * 1000), l: n.l, c: 1 } : { t: Math.round(n.t * 1000), l: n.l }));
  song.dur = bars * bar + TAIL_SECS;
  return song;
}

const cache = new Map();

export function songFor(seed, styleId, df, len, bpm) {
  const key = `${seed}:${styleId}:${diffIdx(df)}:${len}:${bpm || ''}`;
  if (cache.has(key)) return cache.get(key);
  const song = buildSong(seed, styleId, df, len, bpm);
  cache.set(key, song);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return song;
}

export function lastNoteAt(song) {
  return song.notes.length ? song.notes[song.notes.length - 1].t / 1000 : 0;
}

export function firstNoteAt(song) {
  return song.notes.length ? song.notes[0].t / 1000 : 0;
}

export function notesBefore(song, sec) {
  const ms = sec * 1000;
  const notes = song.notes;
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sectionMarks(song) {
  const out = [];
  for (let b = 1; b < song.plan.length; b += 1) {
    const sec = song.plan[b].sec;
    if ((sec === 'build' || sec === 'drop') && song.plan[b - 1].sec !== sec) out.push({ t: b * song.bar, sec });
  }
  return out;
}

export function judge(notes, lane, t, state) {
  const w = state.win;
  const list = state.byLane[lane] || [];
  let best = -1;
  let bd = 0;
  for (let k = state.ptr[lane] || 0; k < list.length; k += 1) {
    const i = list[k];
    if (state.mark[i]) continue;
    const dt = t - notes[i].t;
    if (dt < -w.o) break;
    if (Math.abs(dt) <= w.o && (best < 0 || Math.abs(dt) < Math.abs(bd))) {
      best = i;
      bd = dt;
    }
  }
  if (best < 0) return { k: 'x', idx: -1, dt: 0 };
  const a = Math.abs(bd);
  return { k: a <= w.p ? 'p' : a <= w.g ? 'g' : 'o', idx: best, dt: bd };
}

export function createJudge(song, df = song.df) {
  const notes = song.notes;
  const lanes = lanesFor(df);
  const win = windowsFor(df);
  const mark = new Uint8Array(notes.length);
  const at = new Float64Array(notes.length);
  const byLane = Array.from({ length: lanes }, () => []);
  notes.forEach((n, i) => {
    if (n.l < lanes) byLane[n.l].push(i);
  });
  const state = { win, byLane, mark, ptr: new Array(lanes).fill(0) };
  const stats = { p: 0, g: 0, o: 0, m: 0, j: 0, c: 0, b: 0 };
  const dts = [];
  let strays = [];

  function count(i, k, t) {
    mark[i] = k === 'p' ? 1 : k === 'g' ? 2 : k === 'o' ? 3 : 4;
    at[i] = t;
    stats.j += 1;
    if (k === 'm') {
      stats.m += 1;
      stats.c = 0;
      return;
    }
    stats[k] += 1;
    stats.c += 1;
    stats.b = Math.max(stats.b, stats.c);
  }

  function sweep(t, out = []) {
    for (let l = 0; l < lanes; l += 1) {
      const list = byLane[l];
      while (state.ptr[l] < list.length) {
        const i = list[state.ptr[l]];
        if (mark[i]) {
          state.ptr[l] += 1;
          continue;
        }
        if (notes[i].t < t - win.o) {
          const lost = stats.c;
          count(i, 'm', t);
          out.push({ k: 'm', lane: l, idx: i, lost });
          state.ptr[l] += 1;
          continue;
        }
        break;
      }
    }
    return out;
  }

  function press(lane, t) {
    const out = sweep(t);
    const l = Math.floor(lane);
    if (!(l >= 0 && l < lanes)) return out;
    const r = judge(notes, l, t, state);
    if (r.k === 'x') {
      strays = strays.filter((x) => t - x < STRAY_MS && x <= t);
      strays.push(t);
      if (strays.length > STRAY_MAX) {
        strays = [];
        const lost = stats.c;
        stats.c = 0;
        out.push({ k: 'x', lane: l, idx: -1, dt: 0, reset: true, lost });
      } else out.push({ k: 'x', lane: l, idx: -1, dt: 0, reset: false, lost: 0 });
      return out;
    }
    const before = tierOf(stats.c);
    count(r.idx, r.k, t);
    dts.push(r.dt);
    out.push({ k: r.k, lane: l, idx: r.idx, dt: r.dt, streak: stats.c, up: tierOf(stats.c) > before ? tierOf(stats.c) : 0 });
    return out;
  }

  return {
    press,
    sweep,
    stats,
    mark,
    at,
    dts,
    lanes,
    win,
    get done() {
      return stats.j >= notes.length;
    },
    get score() {
      return scoreOf(stats.p, stats.g, stats.o, stats.b, notes.length);
    },
    get full() {
      return stats.m === 0;
    },
    prog() {
      return [stats.j, stats.p, stats.g, stats.o, stats.m, stats.c, stats.b];
    },
    final() {
      return [stats.p, stats.g, stats.o, stats.m, stats.b];
    },
  };
}
