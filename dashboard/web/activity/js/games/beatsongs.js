import { DIFFS, TAIL_SECS, LANES, diffIdx, prepSong } from './beatchart.js';

export const CATALOG_URL = '/api/activity/songs';
export const SONG_URL = '/api/activity/songs/';
export const CATALOG_TTL_MS = 60000;
export const CATALOG_RETRY_MS = 10000;
export const CHART_TIMEOUT_MS = 10000;
export const CHART_MAX_BYTES = 98304;
export const CATALOG_MAX = 100;
export const SONG_ID_RE = /^s-[0-9a-f]{16}$/;
export const AUDIO_RE = /^\/(?:song-audio|media\/songs)\/s-[0-9a-f]{16}\.(?:mp3|ogg|m4a)$/;
export const TITLE_MAX = 60;
export const ARTIST_MAX = 60;
export const CREDIT_MAX = 120;
export const OFFSET_MAX = 300;
export const LEAD_MS = 1500;
export const END_PAD_MS = 500;
export const SAME_LANE_MS = 80;
export const HOLD_CS_MIN = 20;
export const HOLD_CS_MAX = 400;
export const MARKS_MAX = 16;
export const SECTION_MIN_MS = 30000;
export const SECTION_MAX_MS = 120000;
export const CHART_CAPS = Object.freeze({ easy: 400, normal: 700, hard: 1100, expert: 1600 });
export const CHART_PEAK = Object.freeze({ easy: 4, normal: 6, hard: 9, expert: 13 });
export const HOLD_DIFFS = Object.freeze(['hard', 'expert']);
export const CUT_LEAD_MS = 1000;
export const HOLD_MIN_MS = 200;

const env = { fetch: null, now: () => Date.now(), timer: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
const cat = { at: -Infinity, failAt: -Infinity, list: [], ok: false, tried: false, pending: null };
const charts = new Map();
const pending = new Map();
const built = new Map();
const subs = new Set();

export function configureSongs({ win } = {}) {
  const w = win || globalThis;
  env.fetch = w && typeof w.fetch === 'function' ? (...a) => w.fetch(...a) : null;
}

export function setSongFetch(fn, { now, timer, clear } = {}) {
  env.fetch = typeof fn === 'function' ? fn : null;
  if (typeof now === 'function') env.now = now;
  if (typeof timer === 'function') env.timer = timer;
  if (typeof clear === 'function') env.clear = clear;
}

export function resetSongs() {
  cat.at = -Infinity;
  cat.failAt = -Infinity;
  cat.list = [];
  cat.ok = false;
  cat.tried = false;
  cat.pending = null;
  charts.clear();
  pending.clear();
  built.clear();
}

export function onSongs(fn) {
  if (typeof fn !== 'function') return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

function tell() {
  for (const fn of subs) {
    try {
      fn(cat.list);
    } catch {
      subs.delete(fn);
    }
  }
}

export function songFetch(url, opts) {
  if (typeof env.fetch !== 'function') return Promise.reject(new Error('offline'));
  return Promise.resolve().then(() => env.fetch(url, opts));
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function rowOf(r) {
  const a = Array.isArray(r) ? r : r && typeof r === 'object' ? [r.id, r.title, r.artist, r.dur ?? r.duration_ms, r.bpm, r.cv ?? r.chart_v, r.counts] : null;
  if (!a || typeof a[0] !== 'string' || !SONG_ID_RE.test(a[0])) return null;
  const cv = Number(a[5]);
  if (!Number.isInteger(cv) || cv < 1) return null;
  const title = cleanText(a[1], TITLE_MAX);
  if (!title) return null;
  const bpm = Number(a[4]);
  const counts = Array.isArray(a[6]) ? a[6].slice(0, 4).map((x) => (Number.isInteger(x) && x >= 0 ? x : 0)) : [];
  return Object.freeze({ id: a[0], title, artist: cleanText(a[2], ARTIST_MAX), dur: Number.isFinite(Number(a[3])) ? Math.max(0, Math.round(Number(a[3]))) : 0, bpm: Number.isFinite(bpm) ? Math.round(bpm) : 0, cv, counts: Object.freeze(counts) });
}

export function catalog() {
  return cat.list;
}

export function catalogTried() {
  return cat.tried;
}

export function songRow(id) {
  return cat.list.find((r) => r.id === id) || null;
}

export function readCatalog(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.songs)) return null;
  const seen = new Set();
  const out = [];
  for (const r of body.songs) {
    const row = rowOf(r);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= CATALOG_MAX) break;
  }
  return out;
}

export function loadCatalog({ force = false } = {}) {
  if (cat.pending) return cat.pending;
  if (!force && cat.ok && env.now() - cat.at < CATALOG_TTL_MS) return Promise.resolve(cat.list);
  if (!force && !cat.ok && cat.tried && env.now() - cat.failAt < CATALOG_RETRY_MS) return Promise.resolve(cat.list);
  const p = songFetch(CATALOG_URL, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((res) => (res && res.ok ? res.json() : null))
    .then((body) => {
      const list = readCatalog(body);
      if (list) {
        const changed = JSON.stringify(list) !== JSON.stringify(cat.list) || !cat.ok;
        cat.list = list;
        cat.ok = true;
        cat.at = env.now();
        cat.tried = true;
        if (changed) tell();
      }
      return cat.list;
    })
    .catch(() => cat.list)
    .then((list) => {
      cat.pending = null;
      if (!cat.ok) cat.failAt = env.now();
      if (!cat.tried) {
        cat.tried = true;
        tell();
      }
      return list;
    });
  cat.pending = p;
  return p;
}

export function encodeNotes(notes) {
  const out = [];
  let prev = 0;
  for (const n of notes) {
    const hold = n.e > n.t ? Math.round((n.e - n.t) / 10) : 0;
    out.push(n.t - prev, n.l + 4 * hold);
    prev = n.t;
  }
  return out;
}

function fail(msg) {
  throw new Error(msg);
}

export function decodeNotes(arr) {
  if (!Array.isArray(arr) || arr.length % 2 !== 0) fail('A chart has a broken note list.');
  const out = [];
  let t = 0;
  for (let i = 0; i < arr.length; i += 2) {
    const dt = arr[i];
    const code = arr[i + 1];
    if (!Number.isInteger(dt) || dt < 0 || !Number.isInteger(code) || code < 0) fail('A chart has a broken note.');
    t += dt;
    const l = code % 4;
    const cs = Math.floor(code / 4);
    if (cs !== 0 && (cs < HOLD_CS_MIN || cs > HOLD_CS_MAX)) fail('A chart has a hold that is too short or too long.');
    out.push(cs ? { t, l, e: t + cs * 10 } : { t, l });
  }
  return out;
}

export function checkNotes(notes, id, len) {
  const cap = CHART_CAPS[id];
  const peak = CHART_PEAK[id];
  const holdsOk = HOLD_DIFFS.includes(id);
  let objs = 0;
  const laneEnd = new Array(LANES).fill(-Infinity);
  const holds = [];
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i];
    if (!(n.l >= 0 && n.l < LANES)) fail('A chart uses a lane that does not exist.');
    if (n.e && !holdsOk) fail('Holds are only allowed on Hard and Expert.');
    if (n.t < LEAD_MS) fail('The first note comes too early.');
    if ((n.e || n.t) > len - END_PAD_MS) fail('A note goes past the end of the section.');
    let same = 1;
    for (let j = i - 1; j >= 0 && notes[j].t === n.t; j -= 1) {
      same += 1;
      if (notes[j].l === n.l) fail('A chord uses one lane twice.');
    }
    if (same > 2) fail('A chord has more than two notes.');
    if (n.t - laneEnd[n.l] < SAME_LANE_MS) fail('Two notes in one lane are too close.');
    for (let k = holds.length - 1; k >= 0; k -= 1) if (holds[k] <= n.t) holds.splice(k, 1);
    let groupHolds = 0;
    for (let j = i - 1; j >= 0 && notes[j].t === n.t; j -= 1) if (notes[j].e) groupHolds += 1;
    if (holds.length - groupHolds + same > 2) fail('Too many notes are held at once.');
    laneEnd[n.l] = n.e || n.t;
    if (n.e) holds.push(n.e);
    objs += n.e ? 2 : 1;
  }
  if (objs > cap) fail(`The ${id} chart has too many notes.`);
  let lo = 0;
  for (let hi = 0; hi < notes.length; hi += 1) {
    while (notes[hi].t - notes[lo].t >= 1000) lo += 1;
    if (hi - lo + 1 > peak) fail(`The ${id} chart is too dense.`);
  }
  return objs;
}

export function validateChart(raw, len) {
  let c = raw;
  if (typeof c === 'string') {
    if (c.length > CHART_MAX_BYTES) fail('The chart is too big.');
    try {
      c = JSON.parse(c);
    } catch {
      fail('The chart is not readable.');
    }
  } else if (JSON.stringify(c || null).length > CHART_MAX_BYTES) fail('The chart is too big.');
  if (!c || typeof c !== 'object' || c.v !== 1) fail('The chart version is not supported.');
  const bpm = Number(c.bpm);
  if (!(bpm >= 50 && bpm <= 220)) fail('The chart tempo is out of range.');
  if (!Number.isInteger(c.b0) || c.b0 < 0 || c.b0 > 5000) fail('The chart first beat is out of range.');
  if (!Number.isInteger(c.len) || c.len !== len || len < SECTION_MIN_MS || len > SECTION_MAX_MS) fail('The chart length does not match the section.');
  const marks = Array.isArray(c.marks) ? c.marks : [];
  if (marks.length > MARKS_MAX) fail('The chart has too many marks.');
  let prev = -1;
  const outMarks = [];
  for (const m of marks) {
    if (!Array.isArray(m) || !Number.isInteger(m[0]) || m[0] < prev || m[0] < 0 || m[0] > len || (m[1] !== 'build' && m[1] !== 'drop')) fail('The chart has a broken mark.');
    prev = m[0];
    outMarks.push([m[0], m[1]]);
  }
  if (!c.d || typeof c.d !== 'object') fail('The chart has no notes.');
  const d = {};
  const counts = [];
  for (const diff of DIFFS) {
    if (!Array.isArray(c.d[diff.id])) fail(`The chart is missing ${diff.name}.`);
    d[diff.id] = decodeNotes(c.d[diff.id]);
    counts.push(checkNotes(d[diff.id], diff.id, len));
  }
  for (let i = 1; i < counts.length; i += 1) if (counts[i] < counts[i - 1]) fail('A harder chart has fewer notes than an easier one.');
  return { bpm, b0: c.b0, len, marks: outMarks, d, counts };
}

export function readSong(body, id, cv) {
  if (!body || typeof body !== 'object') fail('The song did not load.');
  if (body.id !== undefined && body.id !== id) fail('The song did not match.');
  if (body.cv !== undefined && Number(body.cv) !== cv) fail('The song changed. Try again.');
  if (typeof body.url !== 'string' || !AUDIO_RE.test(body.url) || !body.url.includes(`/${id}.`)) fail('The song has no audio.');
  const start = Number(body.start);
  const end = Number(body.end);
  const off = body.off === undefined ? 0 : Number(body.off);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) fail('The song section is broken.');
  if (!Number.isInteger(off) || Math.abs(off) > OFFSET_MAX) fail('The song offset is out of range.');
  const chart = validateChart(body.charts, end - start);
  return Object.freeze({ id, cv, title: cleanText(body.title, TITLE_MAX) || 'Song', artist: cleanText(body.artist, ARTIST_MAX), credit: cleanText(body.credit, CREDIT_MAX), url: body.url, dur: Number(body.dur) || 0, start, end, off, ...chart });
}

export function chartKey(id, cv) {
  return `${id}:${cv}`;
}

export function chartEntry(id, cv) {
  return charts.get(chartKey(id, cv)) || null;
}

export function songMeta(id, cv) {
  const e = chartEntry(id, cv);
  if (e) return { title: e.title, artist: e.artist, credit: e.credit, bpm: Math.round(e.bpm) };
  const r = songRow(id);
  return r ? { title: r.title, artist: r.artist, credit: '', bpm: r.bpm } : null;
}

export function putChart(entry) {
  const key = chartKey(entry.id, entry.cv);
  charts.delete(key);
  charts.set(key, entry);
  while (charts.size > 4) charts.delete(charts.keys().next().value);
  return entry;
}

export function loadChart(id, cv) {
  if (typeof id !== 'string' || !SONG_ID_RE.test(id) || !Number.isInteger(cv) || cv < 1) return Promise.reject(new Error('That song is not valid.'));
  const key = chartKey(id, cv);
  if (charts.has(key)) return Promise.resolve(charts.get(key));
  if (pending.has(key)) return pending.get(key);
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = env.timer(() => reject(new Error('The song took too long to load.')), CHART_TIMEOUT_MS);
  });
  const p = Promise.race([
    songFetch(`${SONG_URL}${id}?v=${cv}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then((res) => {
      if (!res || !res.ok) fail('The song did not load.');
      return res.json();
    }),
    late,
  ])
    .then((body) => putChart(readSong(body, id, cv)))
    .then(
      (entry) => {
        env.clear(timer);
        pending.delete(key);
        return entry;
      },
      (err) => {
        env.clear(timer);
        pending.delete(key);
        throw err;
      },
    );
  pending.set(key, p);
  return p;
}

export function chartSong(id, cv, df, len) {
  const e = chartEntry(id, cv);
  if (!e) return null;
  const di = diffIdx(df);
  const secs = [45, 60, 90, 120].includes(Number(len)) ? Number(len) : 60;
  const key = `${chartKey(id, cv)}:${di}:${secs}`;
  if (built.has(key)) return built.get(key);
  const d = DIFFS[di];
  const cut = Math.min(e.len, secs * 1000);
  const notes = [];
  for (const n of e.d[d.id]) {
    if (n.t > cut - CUT_LEAD_MS) break;
    const x = { t: n.t, l: n.l };
    if (n.e) {
      const end = Math.min(n.e, cut - END_PAD_MS);
      if (end - n.t >= HOLD_MIN_MS) x.e = end;
    }
    if (notes.length && notes[notes.length - 1].t === n.t) x.c = 1;
    notes.push(x);
  }
  const bpm = e.bpm;
  const song = prepSong({
    id,
    cv,
    df: di,
    lanes: LANES,
    bpm,
    beat: 60 / bpm,
    b0: e.b0 / 1000,
    marks: e.marks.filter((m) => m[0] < cut).map((m) => ({ t: m[0] / 1000, sec: m[1] })),
    look: d.look,
    notes,
    cut,
    dur: cut / 1000 + TAIL_SECS,
    meta: Object.freeze({ title: e.title, artist: e.artist, credit: e.credit, url: e.url, start: e.start, off: e.off }),
  });
  built.set(key, song);
  while (built.size > 6) built.delete(built.keys().next().value);
  return song;
}
