export const INTRO_BARS = 2;
export const STEPS = 16;
export const LANES = 4;
export const MAX_NOTES = 900;
export const TAIL_SECS = 1.5;
export const MIN_BARS = 8;
export const SEED_MAX = 2147483646;
export const JACK_SECS = 0.22;
export const STRAY_MAX = 4;
export const STRAY_MS = 800;
export const TIERS = Object.freeze([10, 25, 50, 100]);
export const MAX_SCORE = 1000;
export const HOLD_GOOD_MS = 150;
export const HOLD_OK_MS = 300;
export const HOLD_GAP_MS = 80;
export const HOLD_MAX_MS = 3000;

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
  Object.freeze({ id: 'easy', name: 'Chill', lanes: LANES, rate: 1.6, look: 2.0, gap: 280, win: Object.freeze([60, 110, 160]), grid: 4, spread: 0.45, chords: 0, holds: 0, holdMin: 0, bpm: Object.freeze([84, 108]) }),
  Object.freeze({ id: 'normal', name: 'Normal', lanes: LANES, rate: 2.6, look: 1.55, gap: 200, win: Object.freeze([50, 100, 145]), grid: 2, spread: 0.2, chords: 1, holds: 0, holdMin: 0, bpm: Object.freeze([96, 132]) }),
  Object.freeze({ id: 'hard', name: 'Hard', lanes: LANES, rate: 3.8, look: 1.15, gap: 140, win: Object.freeze([38, 80, 125]), grid: 1, spread: 0.1, chords: 2, holds: 2, holdMin: 600, bpm: null }),
  Object.freeze({ id: 'expert', name: 'Expert', lanes: LANES, rate: 5.2, look: 0.9, gap: 110, win: Object.freeze([30, 65, 110]), grid: 1, spread: 0.07, chords: 3, holds: 1, holdMin: 400, bpm: 'top' }),
]);

export const SECTION_RATE = Object.freeze({ verse: 0.8, build: 0.7, drop: 1.15 });
export const CYCLE = Object.freeze(['verse', 'build', 'drop', 'drop']);
export const SLOWER_SECS = 0.4;

export function styleById(id) {
  return STYLES.find((s) => s.id === id) || null;
}

export function diffIdx(v) {
  if (Number.isInteger(v) && v >= 0 && v < DIFFS.length) return v;
  const i = DIFFS.findIndex((d) => d.id === v);
  return i >= 0 ? i : 1;
}

export function diffOf(v) {
  return DIFFS[diffIdx(v)];
}

export function lanesFor() {
  return LANES;
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
  if (range === 'top') return Math.max(...st.bpms);
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
  if (!song || song.kind === 'u' || !Array.isArray(song.prog)) return { root: 57, mode: 'minor' };
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
  if (song.df >= 3) out.hat = true;
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

export function songLength(bpm, len) {
  const bar = 240 / bpm;
  const bars = Math.max(MIN_BARS, Math.round(Number(len) / bar) + 1);
  return { bars, bar };
}

function nearest(from, random) {
  const out = [];
  for (let l = 0; l < LANES; l += 1) if (l !== from) out.push({ l, d: Math.abs(l - from), r: random() });
  return out.sort((a, b) => a.d - b.d || a.r - b.r).map((x) => x.l);
}

function chordable(d, plan, si) {
  if (!d.chords || plan.sec !== 'drop') return false;
  if (d.chords === 1) return plan.pos === 0 && si === 0;
  if (d.chords === 3) return si === 0 || si === 8;
  return si === 0;
}

function chordOdds(d) {
  return d.chords === 1 ? 0.6 : d.chords === 3 ? 0.85 : 0.7;
}

function addHolds(song, notes, d, random) {
  if (!d.holds) return;
  const barMs = song.bar * 1000;
  const beatMs = song.beat * 1000;
  const stepMs = song.step * 1000;
  const lastOk = (song.bars - 1) * barMs - beatMs;
  const lens = d.chords === 3 ? [0.5, 1, 1.5, 2] : [1, 1.5, 2];
  let nextBar = INTRO_BARS;
  let lastEnd = -Infinity;
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i];
    const b = Math.floor((n.t + 1) / barMs);
    if (b < nextBar || n.t < lastEnd + d.gap) continue;
    const plan = song.plan[b];
    if (!plan || plan.sec === 'intro' || plan.sec === 'outro') continue;
    if (n.c || (notes[i + 1] && notes[i + 1].t === n.t) || (i > 0 && notes[i - 1].t === n.t)) continue;
    const beatPos = (n.t - b * barMs) / beatMs;
    if (Math.abs(beatPos - Math.round(beatPos)) > 0.02) continue;
    let e = n.t + lens[Math.floor(random() * lens.length) % lens.length] * beatMs;
    e = Math.min(e, n.t + HOLD_MAX_MS, lastOk);
    for (let j = i + 1; j < notes.length && notes[j].t <= e + d.gap; j += 1) {
      const m = notes[j];
      if (m.l === n.l) e = Math.min(e, m.t - d.gap);
      else if ((notes[j + 1] && notes[j + 1].t === m.t) || m.c) e = Math.min(e, m.t - 1);
    }
    const steps = Math.floor((e - n.t) / stepMs + 1e-6);
    e = Math.round(n.t + steps * stepMs);
    if (e - n.t < d.holdMin) continue;
    n.e = e;
    lastEnd = e;
    nextBar = b + d.holds;
  }
}

export function prepSong(song) {
  const heads = [];
  let n = 0;
  let endMs = 0;
  for (const x of song.notes) {
    heads.push(x.t);
    n += 1;
    endMs = Math.max(endMs, x.t);
    if (x.e > x.t) {
      heads.push(x.t);
      n += 1;
      endMs = Math.max(endMs, x.e);
    }
  }
  song.n = n;
  song.heads = heads;
  song.endMs = endMs;
  return song;
}

export function objectCount(notes) {
  let n = 0;
  for (const x of Array.isArray(notes) ? notes : []) n += x.e > x.t ? 2 : 1;
  return n;
}

export function objTimes(notes) {
  const out = [];
  for (const x of Array.isArray(notes) ? notes : []) {
    out.push(x.t);
    if (x.e > x.t) out.push(x.e);
  }
  return out.sort((a, b) => a - b);
}

export function buildSong(seed, styleId, df, len, bpm) {
  const st = styleById(styleId) || STYLES[0];
  const di = diffIdx(df);
  const d = DIFFS[di];
  const s = Math.max(1, Math.min(SEED_MAX, Math.floor(Number(seed)) || 1));
  const random = rng(s);
  const tempo = Number.isFinite(Number(bpm)) && Number(bpm) >= 60 && Number(bpm) <= 200 ? Math.round(Number(bpm)) : st.bpm;
  const { bars, bar } = songLength(tempo, len);
  const modeProgs = PROGS[st.mode];
  const song = {
    kind: 's',
    seed: s,
    style: st.id,
    df: di,
    lanes: LANES,
    bpm: tempo,
    beat: 60 / tempo,
    b0: 0,
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
  for (let q = 0; q < INTRO_BARS * 4; q += 1) raw.push({ t: stepTime(song, q * 4), fixed: q % 2 === 0 ? 0 : LANES - 1 });
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
    let chorded = 0;
    const cap = d.chords === 3 ? 2 : 1;
    for (const x of picked) {
      const t = x.ev.t;
      const vl = virtualLane(x.ev, t, vlast, random);
      vlast[vl] = t;
      raw.push({ t, l: vl });
      if (chorded < cap && chordable(d, plan, x.si) && random() < chordOdds(d)) {
        chorded += 1;
        raw.push({ t, chord: true });
      }
      prevT = t;
    }
    if (raw.length >= MAX_NOTES) break;
  }
  const notes = [];
  const last = new Array(LANES).fill(-Infinity);
  const gap = d.gap / 1000;
  const runCap = di < 2;
  let runLane = -1;
  let run = 0;
  let mainAt = -Infinity;
  let mainLane = -1;
  for (const n of raw) {
    if (n.chord) {
      if (n.t !== mainAt || mainLane < 0) continue;
      const opts = nearest(mainLane, random).filter((l) => n.t - last[l] >= gap - 1e-9);
      if (!opts.length) continue;
      const l = opts[Math.floor(random() * opts.length) % opts.length];
      notes.push({ t: n.t, l, c: 1 });
      last[l] = n.t;
      continue;
    }
    let l = n.fixed !== undefined ? n.fixed : n.l;
    const tooMany = runCap && l === runLane && run >= 2;
    if (tooMany || n.t - last[l] < gap - 1e-9) {
      const alt = nearest(l, random).find((c) => n.t - last[c] >= gap - 1e-9 && !(runCap && c === runLane && run >= 2));
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
  const out = notes.slice(0, MAX_NOTES).map((n) => (n.c ? { t: Math.round(n.t * 1000), l: n.l, c: 1 } : { t: Math.round(n.t * 1000), l: n.l }));
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].t === out[i - 1].t && !out[i].c && out[i - 1].c) {
      const a = out[i - 1];
      out[i - 1] = { t: out[i].t, l: out[i].l };
      out[i] = { t: a.t, l: a.l, c: 1 };
    }
  }
  addHolds(song, out, d, random);
  song.notes = out;
  song.dur = bars * bar + TAIL_SECS;
  return prepSong(song);
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
  if (!song || !song.notes.length) return 0;
  if (Number.isFinite(song.endMs)) return song.endMs / 1000;
  return song.notes.reduce((a, n) => Math.max(a, n.e > n.t ? n.e : n.t), 0) / 1000;
}

export function firstNoteAt(song) {
  return song && song.notes.length ? song.notes[0].t / 1000 : 0;
}

export function objectsBefore(song, sec) {
  const ms = sec * 1000;
  const list = song.heads || song.notes.map((n) => n.t);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function countOf(song) {
  if (!song) return 0;
  return Number.isInteger(song.n) ? song.n : objectCount(song.notes);
}

export function sectionMarks(song) {
  if (!song) return [];
  if (Array.isArray(song.marks)) return song.marks.slice();
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

export function releaseKind(endMs, t, win) {
  const early = endMs - t;
  if (early <= win.g) return 'p';
  if (early <= HOLD_GOOD_MS) return 'g';
  if (early <= HOLD_OK_MS) return 'o';
  return 'm';
}

export function createJudge(song, df = song.df) {
  const notes = song.notes;
  const total = countOf(song);
  const win = windowsFor(df);
  const mark = new Uint8Array(notes.length);
  const tail = new Uint8Array(notes.length);
  const at = new Float64Array(notes.length);
  const holding = new Array(LANES).fill(-1);
  const byLane = Array.from({ length: LANES }, () => []);
  notes.forEach((n, i) => {
    if (n.l >= 0 && n.l < LANES) byLane[n.l].push(i);
  });
  const state = { win, byLane, mark, ptr: new Array(LANES).fill(0) };
  const stats = { p: 0, g: 0, o: 0, m: 0, j: 0, c: 0, b: 0 };
  const dts = [];
  let strays = [];

  function tally(k) {
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

  function count(i, k, t) {
    mark[i] = k === 'p' ? 1 : k === 'g' ? 2 : k === 'o' ? 3 : 4;
    at[i] = t;
    tally(k);
  }

  function endTail(i, k, lane, out) {
    const before = tierOf(stats.c);
    const lost = stats.c;
    tail[i] = k === 'p' ? 1 : k === 'g' ? 2 : k === 'o' ? 3 : 4;
    if (holding[lane] === i) holding[lane] = -1;
    tally(k);
    if (k === 'm') out.push({ k: 'm', lane, idx: i, tail: true, lost });
    else out.push({ k, lane, idx: i, dt: 0, tail: true, streak: stats.c, up: tierOf(stats.c) > before ? tierOf(stats.c) : 0 });
  }

  function sweep(t, out = []) {
    for (let l = 0; l < LANES; l += 1) {
      const h = holding[l];
      if (h >= 0 && t >= notes[h].e) endTail(h, 'p', l, out);
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
          if (notes[i].e > notes[i].t) {
            tail[i] = 4;
            tally('m');
          }
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
    if (!(l >= 0 && l < LANES)) return out;
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
    if (notes[r.idx].e > notes[r.idx].t) {
      if (holding[l] >= 0) endTail(holding[l], releaseKind(notes[holding[l]].e, t, win), l, out);
      holding[l] = r.idx;
      tail[r.idx] = 9;
    }
    return out;
  }

  function release(lane, t) {
    const l = Math.floor(lane);
    const out = sweep(t);
    if (!(l >= 0 && l < LANES)) return out;
    const i = holding[l];
    if (i < 0) return out;
    endTail(i, releaseKind(notes[i].e, t, win), l, out);
    return out;
  }

  return {
    press,
    release,
    sweep,
    stats,
    mark,
    tail,
    holding,
    at,
    dts,
    lanes: LANES,
    win,
    n: total,
    get done() {
      return stats.j >= total;
    },
    get score() {
      return scoreOf(stats.p, stats.g, stats.o, stats.b, total);
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
