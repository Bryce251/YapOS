export const REPLAY_VERSION = 1;
export const REPLAY_EVENTS = 600;
export const REPLAY_CHARS = 48 * 1024;
export const REPLAY_AUTHORS = 24;
export const REPLAY_MAX_MS = 30 * 60 * 1000;
export const REPLAY_KINDS = Object.freeze(['ink', 'pixel']);
export const REPLAY_NAME_MAX = 64;
export const PIXEL_SIZE = 24;
export const PIXEL_CELLS = PIXEL_SIZE * PIXEL_SIZE;
export const PIXEL_CODES = '0123456789abc';
export const PIXEL_BLANK = '0';
export const PIXEL_COLORS = Object.freeze({
  1: '#1c1c22',
  2: '#f8fafc',
  3: '#8d8d97',
  4: '#ef4444',
  5: '#f97316',
  6: '#facc15',
  7: '#22c55e',
  8: '#14b8a6',
  9: '#3b82f6',
  a: '#8b5cf6',
  b: '#f472b6',
  c: '#92400e',
});

const INK_RE = /^[A-Za-z0-9_-]{6,4096}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GRID_RE = new RegExp(`^[${PIXEL_CODES}]{${PIXEL_CELLS}}$`);

export function replayChars(r) {
  try {
    return JSON.stringify(r).length;
  } catch {
    return Infinity;
  }
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, REPLAY_NAME_MAX).join('');
}

export function isCut(e) {
  return Array.isArray(e) && e.length === 3 && Number.isInteger(e[2]);
}

function goodEvent(e, kind, authors) {
  if (!Array.isArray(e)) return false;
  const [a, t] = e;
  if (!Number.isInteger(a) || a < 0 || a >= authors) return false;
  if (!Number.isInteger(t) || t < 0 || t > REPLAY_MAX_MS) return false;
  if (kind === 'pixel') return e.length === 4 && Number.isInteger(e[2]) && e[2] >= 0 && e[2] < PIXEL_CELLS && typeof e[3] === 'string' && e[3].length === 1 && PIXEL_CODES.includes(e[3]);
  if (e.length !== 3) return false;
  if (typeof e[2] === 'string') return INK_RE.test(e[2]);
  return Number.isInteger(e[2]) && e[2] >= 0;
}

export const SOLO_GAMES = Object.freeze(['draw', 'telephone', 'sketchduel']);

export function finalInk(r, who = null) {
  const out = [];
  if (!r || r.kind !== 'ink' || !Array.isArray(r.events)) return out;
  for (const e of r.events) {
    if (!Array.isArray(e)) continue;
    if (typeof e[2] === 'string') out.push(e);
    else if (Number.isInteger(e[2])) out.length = Math.max(0, Math.min(out.length, e[2]));
  }
  const wanted = typeof who === 'string' && Array.isArray(r.authors) ? r.authors.findIndex((a) => a && String(a.id).toLowerCase() === who.toLowerCase()) : -1;
  return out.filter((e) => typeof who !== 'string' || e[0] === wanted).map((e) => e[2]);
}

export function inkMatches(r, ink, maxStrokes, maxChars, who = null) {
  if (!r || r.kind !== 'ink' || r.truncated) return true;
  const v = finalInk(r, who);
  let chars = 0;
  for (const s of v) chars += s.length;
  if (v.length > maxStrokes || chars > maxChars) return true;
  return Array.isArray(ink) && ink.length === v.length && v.every((s, i) => s === ink[i]);
}

export function pixelMismatch(events, grid) {
  const lastCode = new Map();
  for (const e of events) lastCode.set(e[2], e[3]);
  const bad = new Set();
  for (const [i, c] of lastCode) if (typeof grid !== 'string' || grid[i] !== c) bad.add(i);
  return bad;
}

export function dropOldest(events, n) {
  const cut = Math.max(0, Math.min(events.length, Math.floor(n)));
  if (!cut) return events.slice();
  let count = 0;
  for (let i = 0; i < cut; i += 1) {
    const e = events[i];
    if (isCut(e)) count = Math.min(count, e[2]);
    else if (e.length === 3) count += 1;
  }
  const out = [];
  let base = count;
  let shown = 0;
  for (let i = cut; i < events.length; i += 1) {
    const e = events[i];
    if (isCut(e)) {
      const want = e[2];
      if (want >= base) {
        shown = Math.min(shown, want - base);
      } else {
        base = want;
        shown = 0;
      }
      out.push([e[0], e[1], shown]);
    } else {
      if (e.length === 3) shown += 1;
      out.push(e.slice());
    }
  }
  return out;
}

export function trimReplay(input) {
  const r = input && typeof input === 'object' ? input : null;
  if (!r || !REPLAY_KINDS.includes(r.kind) || !Array.isArray(r.authors) || !Array.isArray(r.events)) return null;
  const authors = r.authors.slice(0, REPLAY_AUTHORS * 4).map((x) => ({ id: x && typeof x.id === 'string' ? x.id.trim() : '', name: cleanName(x && x.name) || 'Player' }));
  let events = r.events.filter((e) => goodEvent(e, r.kind, authors.length) && ID_RE.test(authors[e[0]].id)).map((e) => e.slice());
  let last = 0;
  let count = 0;
  for (const e of events) {
    e[1] = Math.max(last, e[1]);
    last = e[1];
    if (r.kind !== 'ink') continue;
    if (isCut(e)) {
      e[2] = Math.min(e[2], count);
      count = e[2];
    } else {
      count += 1;
    }
  }
  if (r.kind === 'pixel') {
    const grid = typeof r.grid === 'string' && GRID_RE.test(r.grid) ? r.grid : PIXEL_BLANK.repeat(PIXEL_CELLS);
    const off = pixelMismatch(events, grid);
    if (off.size) events = events.filter((e) => !off.has(e[2]));
  }
  let truncated = Boolean(r.truncated);
  if (events.length > REPLAY_EVENTS) {
    events = dropOldest(events, events.length - REPLAY_EVENTS);
    truncated = true;
  }
  const build = (list) => {
    const used = [];
    const map = new Map();
    for (const e of list) {
      if (!map.has(e[0])) {
        map.set(e[0], used.length);
        used.push(authors[e[0]]);
      }
    }
    if (used.length > REPLAY_AUTHORS) return null;
    const out = { v: REPLAY_VERSION, kind: r.kind, authors: used, events: list.map((e) => [map.get(e[0]), ...e.slice(1)]) };
    if (r.kind === 'pixel') out.grid = typeof r.grid === 'string' && GRID_RE.test(r.grid) ? r.grid : PIXEL_BLANK.repeat(PIXEL_CELLS);
    if (truncated) out.truncated = true;
    if (r.late) out.late = true;
    return out;
  };
  let out = build(events);
  while (events.length && (!out || replayChars(out) > REPLAY_CHARS)) {
    const over = out ? replayChars(out) - REPLAY_CHARS : 0;
    const per = Math.max(1, Math.ceil(replayChars(out || { events }) / Math.max(1, events.length)));
    events = dropOldest(events, Math.max(1, Math.ceil(over / per), Math.ceil(events.length / 20)));
    truncated = true;
    out = build(events);
  }
  if (!out || !out.events.length) return null;
  const seen = new Set();
  for (const a of out.authors) {
    if (seen.has(a.id.toLowerCase())) return null;
    seen.add(a.id.toLowerCase());
  }
  return out;
}
