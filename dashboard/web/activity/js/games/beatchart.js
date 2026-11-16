export const LANES = 4;
export const KEYS = Object.freeze(['d', 'f', 'j', 'k']);
export const WINDOWS = Object.freeze({ perfect: 0.045, great: 0.09, good: 0.135 });
export const VALUES = Object.freeze({ perfect: 100, great: 70, good: 40 });
export const MULT_STEP = 10;
export const MULT_MAX = 4;
export const INTRO_BARS = 2;
export const STEPS = 16;
export const MASH_TAPS = 5;
export const MASH_SECS = 1;
export const MAX_NOTES = 640;
export const TAIL_SECS = 1.5;
export const MIN_BARS = 8;
export const SEED_MAX = 2147483646;
export const JACK_SECS = 0.22;

export const SCALES = Object.freeze({
  minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
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
  return Object.freeze(o);
}

export const STYLES = Object.freeze([
  style({ id: 'chill', name: 'Night Drive', emoji: '🌙', bpm: 88, mode: 'minor', root: 45, swing: 0.12, wave: 'triangle', cut: 560, kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: '0......0..2.....', arp: '0...1...2...1...' }),
  style({ id: 'funk', name: 'Pocket Funk', emoji: '🕺', bpm: 100, mode: 'major', root: 40, swing: 0.06, wave: 'square', cut: 760, kick: 'x..x..x...x..x..', snare: '....x..x....x...', hat: 'x.xxx.xxx.xxx.xx', bass: '0..0..3...2..1..', arp: '2.1.0...2.1.3...' }),
  style({ id: 'pop', name: 'Sugar Rush', emoji: '🍬', bpm: 112, mode: 'major', root: 43, swing: 0, wave: 'square', cut: 900, kick: 'x.....x.x.......', snare: '....x.......x...', hat: '..x...x...x...x.', bass: '0.0.0.0.1.1.2.2.', arp: '0.1.2.3.2.1.0.1.' }),
  style({ id: 'house', name: 'Neon Floor', emoji: '🪩', bpm: 124, mode: 'minor', root: 41, swing: 0, wave: 'sawtooth', cut: 700, kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', bass: '..0...0...0...3.', arp: '0.2.1.3.0.2.1.2.' }),
  style({ id: 'rush', name: 'Turbo Lane', emoji: '🏎️', bpm: 148, mode: 'minor', root: 40, swing: 0, wave: 'sawtooth', cut: 1100, kick: 'x.....x...x..x..', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: '0.0...0.3.0...2.', arp: '0.1.2.1.3.1.2.1.' }),
]);

export const DIFFS = Object.freeze([
  Object.freeze({ id: 'easy', name: 'Easy', rate: 1.4, gap: 0.32, grid: 4, doubles: 0, scroll: 1.75 }),
  Object.freeze({ id: 'normal', name: 'Normal', rate: 2.4, gap: 0.17, grid: 2, doubles: 0.12, scroll: 1.4 }),
  Object.freeze({ id: 'hard', name: 'Hard', rate: 3.8, gap: 0.1, grid: 1, doubles: 0.35, scroll: 1.12 }),
]);

export const SECTION_RATE = Object.freeze({ verse: 0.85, build: 1, drop: 1.25, outro: 0 });
export const CYCLE = Object.freeze(['verse', 'build', 'drop', 'drop']);

export function styleById(id) {
  return STYLES.find((s) => s.id === id) || null;
}

export function diffById(id) {
  return DIFFS.find((d) => d.id === id) || DIFFS[1];
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

export function multOf(combo) {
  return Math.min(MULT_MAX, 1 + Math.floor(Math.max(0, combo) / MULT_STEP));
}

export function judgeOf(dt) {
  const a = Math.abs(dt);
  if (!(a <= WINDOWS.good)) return null;
  if (a <= WINDOWS.perfect) return 'perfect';
  if (a <= WINDOWS.great) return 'great';
  return 'good';
}

function planBars(bars, random) {
  const plan = [];
  for (let b = 0; b < bars; b += 1) {
    let sec;
    if (b < INTRO_BARS) sec = 'intro';
    else if (b === bars - 1) sec = 'outro';
    else sec = CYCLE[Math.floor((b - INTRO_BARS) / 4) % CYCLE.length];
    plan.push({ sec });
  }
  for (let b = 0; b < bars; b += 1) {
    const next = plan[b + 1];
    plan[b].roll = plan[b].sec === 'build' && Boolean(next) && next.sec === 'drop' ? 1 : 0;
    plan[b].fill = plan[b].sec === 'verse' && (b - INTRO_BARS) % 4 === 3 && random() < 0.5 ? 1 : 0;
  }
  return plan;
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

function priority(ev, diff) {
  if (ev.roll) return diff.grid === 1 ? 3 : 2;
  if (ev.kick || ev.snare) return 3;
  if (ev.bass !== null) return 2;
  if (ev.arp !== null) return 1.5;
  if (ev.hat) return 1;
  return 0;
}

export function freeLane(want, t, last, random, skip = -1) {
  if (want !== skip && t - last[want] >= JACK_SECS) return want;
  const open = [];
  for (let l = 0; l < LANES; l += 1) if (l !== skip && l !== want && t - last[l] >= JACK_SECS) open.push(l);
  if (open.length) return open[Math.floor(random() * open.length) % open.length];
  return -1;
}

function laneFor(ev, last, random) {
  let lane;
  if (ev.kick && !ev.snare) lane = random() < 0.5 ? 0 : 1;
  else if (ev.snare) lane = random() < 0.5 ? 2 : 3;
  else if (ev.bass !== null) lane = ((ev.bass % 12) + 12) % LANES;
  else lane = Math.floor(random() * LANES);
  const t = ev.t;
  const ok = freeLane(lane, t, last, random);
  if (ok >= 0) return ok;
  let oldest = 0;
  for (let l = 1; l < LANES; l += 1) if (last[l] < last[oldest]) oldest = l;
  return oldest;
}

export function songLength(st, len) {
  const bar = 240 / st.bpm;
  const bars = Math.max(MIN_BARS, Math.round(Number(len) / bar) + 1);
  return { bars, bar };
}

export function buildSong(seed, styleId, diffId, len) {
  const st = styleById(styleId) || STYLES[0];
  const diff = diffById(diffId);
  const s = Math.max(1, Math.min(SEED_MAX, Math.floor(Number(seed)) || 1));
  const random = rng(s);
  const { bars, bar } = songLength(st, len);
  const modeProgs = PROGS[st.mode];
  const song = {
    seed: s,
    style: st.id,
    diff: diff.id,
    bpm: st.bpm,
    beat: 60 / st.bpm,
    step: 60 / st.bpm / 4,
    swing: st.swing,
    bars,
    bar,
    root: st.root + (s % 5) - 2,
    prog: modeProgs[Math.floor(random() * modeProgs.length)],
    plan: planBars(bars, random),
    scroll: diff.scroll,
    notes: [],
    dur: 0,
  };
  const notes = [];
  const last = new Array(LANES).fill(-Infinity);
  let prev = null;
  for (let b = INTRO_BARS; b < bars; b += 1) {
    const sec = song.plan[b].sec;
    const rate = SECTION_RATE[sec] || 0;
    const evs = [];
    for (let k = b * STEPS; k < (b + 1) * STEPS; k += 1) {
      const sIdx = k % STEPS;
      const ev = stepAt(song, k);
      const p = priority(ev, diff);
      if (!p) continue;
      if (sIdx % diff.grid !== 0 && !(ev.roll && diff.grid <= 2 && sIdx % 2 === 0)) continue;
      evs.push({ ev, p, r: random() });
    }
    if (sec === 'outro') {
      const first = evs.find((x) => x.ev.k % STEPS === 0);
      if (first) {
        const t = first.ev.t;
        const a = freeLane(0, t, last, random);
        const b = a >= 0 ? freeLane(3, t, last, random, a) : -1;
        for (const l of [a, b]) if (l >= 0) notes.push({ t, l });
      }
      continue;
    }
    let want = Math.round(diff.rate * bar * rate);
    if (random() < 0.3) want += 1;
    evs.sort((a, c) => c.p - a.p || a.r - c.r);
    const picked = [];
    const lastT = prev ? prev.t : -Infinity;
    for (const x of evs) {
      if (picked.length >= want) break;
      const t = x.ev.t;
      const gapOk = t - lastT >= diff.gap - 1e-9 && picked.every((y) => Math.abs(y.ev.t - t) >= diff.gap - 1e-9);
      if (gapOk) picked.push(x);
    }
    picked.sort((a, c) => a.ev.t - c.ev.t);
    for (const x of picked) {
      const l = laneFor(x.ev, last, random);
      const n = { t: x.ev.t, l };
      notes.push(n);
      last[l] = n.t;
      if (sec === 'drop' && x.ev.snare && diff.doubles && random() < diff.doubles) {
        const d = freeLane((l + 2) % LANES, n.t, last, random, l);
        if (d >= 0) {
          notes.push({ t: n.t, l: d });
          last[d] = n.t;
        }
      }
      prev = n;
    }
    if (notes.length >= MAX_NOTES) break;
  }
  notes.sort((a, c) => a.t - c.t || a.l - c.l);
  song.notes = notes.slice(0, MAX_NOTES).map((n) => ({ t: Math.round(n.t * 10000) / 10000, l: n.l }));
  song.dur = bars * bar + TAIL_SECS;
  return song;
}

const cache = new Map();

export function songFor(seed, styleId, diffId, len) {
  const key = `${seed}:${styleId}:${diffId}:${len}`;
  if (cache.has(key)) return cache.get(key);
  const song = buildSong(seed, styleId, diffId, len);
  cache.set(key, song);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return song;
}

export function lastNoteAt(song) {
  return song.notes.length ? song.notes[song.notes.length - 1].t : 0;
}

export function notesBefore(song, t) {
  let n = 0;
  for (const x of song.notes) {
    if (x.t < t) n += 1;
    else break;
  }
  return n;
}

export function boundFor(p, g, o, c) {
  const hits = p + g + o;
  if (!(hits > 0)) return 0;
  const run = Math.max(1, Math.min(c, hits));
  const mults = [];
  let left = hits;
  while (left > 0) {
    const n = Math.min(run, left);
    for (let j = 0; j < n; j += 1) mults.push(multOf(j));
    left -= n;
  }
  mults.sort((a, b) => b - a);
  let sum = 0;
  mults.forEach((m, i) => {
    const v = i < p ? VALUES.perfect : i < p + g ? VALUES.great : VALUES.good;
    sum += v * m;
  });
  return sum;
}

export function prefixMax(n) {
  return boundFor(n, 0, 0, n);
}

export function maxScore(song) {
  return prefixMax(song.notes.length);
}

export function accuracy(h) {
  const [p, g, o, m] = h;
  const total = p + g + o + m;
  if (!total) return 0;
  return Math.round(((p * VALUES.perfect + g * VALUES.great + o * VALUES.good) / (total * VALUES.perfect)) * 1000) / 10;
}

export function gradeOf(acc, fc) {
  if (acc >= 95 && fc) return 'S';
  if (acc >= 90) return 'A';
  if (acc >= 80) return 'B';
  if (acc >= 65) return 'C';
  return 'D';
}

export function createRun(song, { from = 0 } = {}) {
  const notes = song.notes;
  const mark = new Array(notes.length).fill(0);
  const lanes = Array.from({ length: LANES }, () => []);
  notes.forEach((n, i) => lanes[n.l].push(i));
  const ptr = new Array(LANES).fill(0);
  const stats = { s: 0, c: 0, cur: 0, p: 0, g: 0, o: 0, m: 0, k: 0 };
  let ghosts = [];
  let judged = 0;
  for (let i = 0; i < notes.length; i += 1) {
    if (notes[i].t < from) {
      mark[i] = 5;
      stats.k += 1;
      judged += 1;
    }
  }

  function tick(t, out = []) {
    for (let l = 0; l < LANES; l += 1) {
      const list = lanes[l];
      while (ptr[l] < list.length) {
        const i = list[ptr[l]];
        if (mark[i] !== 0) {
          ptr[l] += 1;
          continue;
        }
        if (notes[i].t < t - WINDOWS.good) {
          mark[i] = 4;
          stats.m += 1;
          stats.cur = 0;
          judged += 1;
          out.push({ k: 'miss', lane: l, i, gain: 0, combo: 0 });
          ptr[l] += 1;
          continue;
        }
        break;
      }
    }
    return out;
  }

  function press(lane, t) {
    const out = tick(t);
    const l = Math.floor(lane);
    if (!(l >= 0 && l < LANES)) return out;
    const list = lanes[l];
    const i = ptr[l] < list.length ? list[ptr[l]] : -1;
    const k = i >= 0 ? judgeOf(t - notes[i].t) : null;
    if (!k) {
      ghosts = ghosts.filter((x) => t - x < MASH_SECS && x <= t);
      ghosts.push(t);
      if (ghosts.length >= MASH_TAPS) {
        ghosts = [];
        const had = stats.cur;
        stats.cur = 0;
        out.push({ k: 'mash', lane: l, i: -1, gain: 0, combo: 0, lost: had });
      } else out.push({ k: 'ghost', lane: l, i: -1, gain: 0, combo: stats.cur });
      return out;
    }
    const gain = VALUES[k] * multOf(stats.cur);
    mark[i] = k === 'perfect' ? 1 : k === 'great' ? 2 : 3;
    stats[k === 'perfect' ? 'p' : k === 'great' ? 'g' : 'o'] += 1;
    stats.s += gain;
    stats.cur += 1;
    stats.c = Math.max(stats.c, stats.cur);
    judged += 1;
    ptr[l] += 1;
    out.push({ k, lane: l, i, gain, combo: stats.cur, dt: t - notes[i].t });
    return out;
  }

  return {
    tick,
    press,
    stats,
    mark,
    get judged() {
      return judged;
    },
    get done() {
      return judged >= notes.length;
    },
    get mult() {
      return multOf(stats.cur);
    },
    final() {
      return { s: stats.s, c: stats.c, p: stats.p, g: stats.g, o: stats.o, m: stats.m, k: stats.k };
    },
  };
}
