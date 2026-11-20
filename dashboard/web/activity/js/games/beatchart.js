export const TAIL_SECS = 1.5;
export const LANES = 4;
export const STRAY_MAX = 4;
export const STRAY_MS = 800;
export const TIERS = Object.freeze([10, 25, 50, 100]);
export const MAX_SCORE = 1000;
export const HOLD_GOOD_MS = 150;
export const HOLD_OK_MS = 300;
export const SLOWER_SECS = 0.4;

export const DIFFS = Object.freeze([
  Object.freeze({ id: 'easy', name: 'Chill', lanes: LANES, look: 2.0, win: Object.freeze([60, 110, 160]) }),
  Object.freeze({ id: 'normal', name: 'Normal', lanes: LANES, look: 1.55, win: Object.freeze([50, 100, 145]) }),
  Object.freeze({ id: 'hard', name: 'Hard', lanes: LANES, look: 1.15, win: Object.freeze([38, 80, 125]) }),
  Object.freeze({ id: 'expert', name: 'Expert', lanes: LANES, look: 0.9, win: Object.freeze([30, 65, 110]) }),
]);

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
  return song && Array.isArray(song.marks) ? song.marks.slice() : [];
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
