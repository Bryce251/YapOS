import { decodeStroke, isFill } from '../activity/js/games/ink.js';
import { PIXEL_CELLS, PIXEL_CODES, PIXEL_BLANK } from '../activity/js/games/replayformat.js';

export const SPEEDS = Object.freeze([0.5, 1, 2, 4, 8, 16]);
export const DEFAULT_SPEED = 1;
export const GAP_MS = 1500;
export const GAP_KEEP_MS = 350;
export const LEGACY_STEP_MS = 450;
export const POINT_MS = 14;
export const STROKE_MIN_MS = 140;
export const STROKE_MAX_MS = 1400;
export const FILL_MS = 260;
export const CUT_MS = 220;
export const CELL_MS = 45;
export const ARTIST_TONES = 8;
export const LEGACY_NOTE = "Older report: timing and per-line artists weren't recorded";
export const LATE_NOTE = 'The reporter joined partway through, so the first lines show up all at once.';
export const CREDIT_NOTE = "Who drew each part comes from the reporter's game and can't be double-checked, so look at the whole picture before banning anyone.";
export const TRUNCATED_NOTE ='This drawing was too long to keep in full, so only the newest steps were saved.';

const str = (v) => (typeof v === 'string' && v ? v : '');
const GRID_RE = new RegExp(`^[${PIXEL_CODES}]{${PIXEL_CELLS}}$`);

function readProfile(p) {
  if (!p || typeof p !== 'object') return null;
  return { username: str(p.username), display_name: str(p.display_name), avatar: str(p.avatar) };
}

function readAuthor(a, i) {
  return {
    id: str(a && a.id),
    name: str(a && a.name) || 'Player',
    profile: readProfile(a && a.profile),
    banned: a?.banned === true,
    role: a?.role === 'owner' || a?.role === 'admin' ? a.role : '',
    tone: i % ARTIST_TONES,
    count: 0,
  };
}

export function readReplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'pixel' ? 'pixel' : raw.kind === 'ink' ? 'ink' : null;
  if (!kind || !Array.isArray(raw.authors) || !Array.isArray(raw.events) || !raw.authors.length) return null;
  const authors = raw.authors.map(readAuthor);
  const events = [];
  let last = 0;
  for (const e of raw.events) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || e[0] < 0 || e[0] >= authors.length) continue;
    const t = Math.max(last, Number.isFinite(e[1]) ? Math.max(0, Math.floor(e[1])) : last);
    last = t;
    if (kind === 'pixel') {
      if (!Number.isInteger(e[2]) || e[2] < 0 || e[2] >= PIXEL_CELLS || typeof e[3] !== 'string' || e[3].length !== 1 || !PIXEL_CODES.includes(e[3])) continue;
      events.push({ a: e[0], t, type: 'cell', i: e[2], c: e[3] });
      authors[e[0]].count += 1;
    } else if (typeof e[2] === 'string') {
      const stroke = decodeStroke(e[2]);
      if (!stroke) continue;
      events.push({ a: e[0], t, type: 'add', stroke });
      authors[e[0]].count += 1;
    } else if (Number.isInteger(e[2]) && e[2] >= 0) {
      events.push({ a: e[0], t, type: 'cut', n: e[2] });
    }
  }
  if (!events.length) return null;
  const grid = kind === 'pixel' && typeof raw.grid === 'string' && GRID_RE.test(raw.grid) ? raw.grid : null;
  return {
    kind,
    authors,
    events,
    grid,
    base: kind === 'pixel' ? baseGrid(events, grid) : null,
    truncated: raw.truncated === true,
    late: raw.late === true,
    legacy: false,
  };
}

export function legacyReplay(ink, drawer) {
  const strokes = (Array.isArray(ink) ? ink : []).map(decodeStroke).filter(Boolean);
  if (!strokes.length) return null;
  const author = readAuthor(drawer || {}, 0);
  author.count = strokes.length;
  return {
    kind: 'ink',
    authors: [author],
    events: strokes.map((stroke, i) => ({ a: 0, t: i * LEGACY_STEP_MS, type: 'add', stroke })),
    grid: null,
    truncated: false,
    late: false,
    legacy: true,
  };
}

export function replayOf(report) {
  if (!report || typeof report !== 'object') return null;
  return readReplay(report.replay) || legacyReplay(report.ink, report.drawer);
}

export function durationOf(e) {
  if (!e) return 0;
  if (e.type === 'cell') return CELL_MS;
  if (e.type === 'cut') return CUT_MS;
  if (isFill(e.stroke)) return FILL_MS;
  const n = e.stroke && Array.isArray(e.stroke.pts) ? e.stroke.pts.length : 1;
  return Math.max(STROKE_MIN_MS, Math.min(STROKE_MAX_MS, n * POINT_MS));
}

export function plan(events, { skipGaps = true } = {}) {
  const list = Array.isArray(events) ? events : [];
  const starts = new Array(list.length);
  const durs = new Array(list.length);
  let clock = 0;
  let prevT = list.length ? list[0].t : 0;
  let end = 0;
  list.forEach((e, i) => {
    const gap = Math.max(0, e.t - prevT);
    prevT = e.t;
    clock += skipGaps && gap > GAP_MS ? GAP_KEEP_MS : gap;
    const start = Math.max(clock, end);
    const dur = durationOf(e);
    starts[i] = start;
    durs[i] = dur;
    end = start + dur;
  });
  return { starts, durs, total: end, skipGaps: Boolean(skipGaps) };
}

export function endOf(p, i) {
  if (!p || i < 0) return 0;
  return p.starts[i] + p.durs[i];
}

export function progressAt(p, time) {
  const n = p ? p.starts.length : 0;
  if (!n) return { done: 0, active: -1, frac: 0 };
  const t = Math.max(0, Math.min(p.total, Number(time) || 0));
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.starts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const k = lo;
  if (k > 0 && endOf(p, k - 1) > t) {
    const i = k - 1;
    const frac = p.durs[i] > 0 ? (t - p.starts[i]) / p.durs[i] : 1;
    return { done: i, active: i, frac: Math.max(0, Math.min(1, frac)) };
  }
  return { done: k, active: -1, frac: 0 };
}

export function stepTime(p, time, dir) {
  const n = p ? p.starts.length : 0;
  if (!n) return 0;
  const at = progressAt(p, time);
  if (dir > 0) return endOf(p, Math.min(n - 1, at.done));
  const count = at.active >= 0 ? at.done : Math.max(0, at.done - 1);
  return count <= 0 ? 0 : endOf(p, count - 1);
}

export function retime(oldPlan, newPlan, time) {
  const at = progressAt(oldPlan, time);
  if (at.active >= 0) return newPlan.starts[at.active] + at.frac * newPlan.durs[at.active];
  if (time >= oldPlan.total) return newPlan.total;
  return at.done > 0 ? endOf(newPlan, at.done - 1) : 0;
}

export function speedFromKey(key) {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= SPEEDS.length ? SPEEDS[n - 1] : null;
}

export function nextSpeed(speed, dir) {
  const i = SPEEDS.indexOf(speed);
  const at = i < 0 ? SPEEDS.indexOf(DEFAULT_SPEED) : i;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + (dir > 0 ? 1 : -1)))];
}

export function speedLabel(speed) {
  return `${speed}x`;
}

export const ALL = Object.freeze({ mode: 'all', a: -1 });

export function cycleFilter(filter, a) {
  const f = filter || ALL;
  if (f.mode === 'all' || f.a !== a) return { mode: 'focus', a };
  if (f.mode === 'focus') return { mode: 'solo', a };
  return ALL;
}

export function artistView(filter, a) {
  const f = filter || ALL;
  if (f.mode === 'all' || f.a === a) return 'on';
  return f.mode === 'solo' ? 'off' : 'dim';
}

export function filterText(filter, authors) {
  const f = filter || ALL;
  const who = f.mode !== 'all' && authors && authors[f.a] ? authors[f.a].name : '';
  if (f.mode === 'focus') return `Highlighting ${who}. Click again to show only their work.`;
  if (f.mode === 'solo') return `Only ${who}. Click again to show everyone.`;
  return 'Showing everyone. Click an artist to highlight their work.';
}

export function nowDrawing(p, events, time) {
  const at = progressAt(p, time);
  if (at.active >= 0) return events[at.active].a;
  return at.done > 0 ? events[at.done - 1].a : -1;
}

export function visibleAt(events, count) {
  const out = [];
  const n = Math.max(0, Math.min(events.length, count));
  for (let i = 0; i < n; i += 1) {
    const e = events[i];
    if (e.type === 'add') out.push(i);
    else if (e.type === 'cut') out.length = Math.min(out.length, e.n);
  }
  return out;
}

export function baseGrid(events, grid) {
  if (typeof grid !== 'string' || !GRID_RE.test(grid)) return null;
  const touched = new Set();
  for (const e of Array.isArray(events) ? events : []) if (e && e.type === 'cell') touched.add(e.i);
  const out = new Array(PIXEL_CELLS);
  let any = false;
  for (let i = 0; i < PIXEL_CELLS; i += 1) {
    out[i] = touched.has(i) ? PIXEL_BLANK : grid[i];
    if (out[i] !== PIXEL_BLANK) any = true;
  }
  return any ? out : null;
}

export function gridAt(events, count, base = null) {
  const color = Array.isArray(base) && base.length === PIXEL_CELLS ? base.slice() : new Array(PIXEL_CELLS).fill(PIXEL_BLANK);
  const owner = new Array(PIXEL_CELLS).fill(-1);
  const n = Math.max(0, Math.min(events.length, count));
  for (let i = 0; i < n; i += 1) {
    const e = events[i];
    if (e.type !== 'cell') continue;
    color[e.i] = e.c;
    owner[e.i] = e.c === PIXEL_BLANK ? -1 : e.a;
  }
  return { color, owner };
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function countLabel(kind, n) {
  if (kind === 'pixel') return n === 1 ? '1 pixel' : `${n} pixels`;
  return n === 1 ? '1 line' : `${n} lines`;
}

export function notesOf(r) {
  if (!r) return [];
  const out = [];
  if (r.legacy) out.push(LEGACY_NOTE);
  if (r.late) out.push(LATE_NOTE);
  if (r.truncated) out.push(TRUNCATED_NOTE);
  if (!r.legacy && Array.isArray(r.authors) && r.authors.length > 1) out.push(CREDIT_NOTE);
  return out;
}
