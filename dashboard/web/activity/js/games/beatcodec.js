export const SONG_MAX_BYTES = 10485760;
export const SONG_CHUNK = 1500000;
export const SONG_MAX_PARTS = Math.ceil(SONG_MAX_BYTES / SONG_CHUNK);
export const SONG_MIN_MS = 30000;
export const SONG_MAX_MS = 360000;
export const SECTION_MIN_MS = 30000;
export const SECTION_MAX_MS = SONG_MAX_MS;
export const SONG_CAP_COUNT = 40;
export const SONG_CAP_MB = 200;
export const SONG_CAP_MB_MIN = 50;
export const SONG_CAP_MB_MAX = 1000;
export const SONG_KBPS_MIN = 4;
export const SONG_KBPS_MAX = 64;
export const SONG_ID_RE = /^s-[0-9a-f]{16}$/;
export const UPLOAD_ID_RE = /^u-[0-9a-z]{16}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const TITLE_MAX = 60;
export const ARTIST_MAX = 60;
export const CREDIT_MAX = 120;
export const OFFSET_MIN = -300;
export const OFFSET_MAX = 300;
export const OFFSET_RANGE = Object.freeze([OFFSET_MIN, OFFSET_MAX]);
export const CHART_MAX_BYTES = 192 * 1024;
export const CHART_V = 1;
export const BPM_MIN = 50;
export const BPM_MAX = 220;
export const B0_MAX = 5000;
export const MARKS_MAX = 16;
export const MARK_KINDS = Object.freeze(['build', 'drop']);
export const LANES = 4;
export const DIFF_IDS = Object.freeze(['easy', 'normal', 'hard', 'expert']);
export const DIFF_NAMES = Object.freeze({ easy: 'Chill', normal: 'Normal', hard: 'Hard', expert: 'Expert' });
export const OBJECT_CAPS = Object.freeze({ easy: 1200, normal: 2100, hard: 3300, expert: 4800 });
export const NPS_CAPS = Object.freeze({ easy: 4, normal: 6, hard: 9, expert: 13 });
export const HOLD_DIFFS = Object.freeze(['hard', 'expert']);
export const HOLD_MIN_CS = 20;
export const HOLD_MAX_CS = 400;
export const LANE_REST_MS = 80;
export const MAX_CHORD = 2;
export const MAX_ACTIVE = 2;
export const FIRST_NOTE_MS = 1500;
export const END_PAD_MS = 500;
export const SONG_EXTS = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' });

export class ChartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChartError';
  }
}

function bad(message) {
  return new ChartError(message);
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

export function songCapBytes(env) {
  const raw = Number(env && env.SONG_STORE_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.min(SONG_CAP_MB_MAX, Math.max(SONG_CAP_MB_MIN, Math.floor(raw))) : SONG_CAP_MB;
  return mb * 1024 * 1024;
}

export function partsFor(bytes) {
  return Math.ceil(bytes / SONG_CHUNK);
}

export function partSize(bytes, idx) {
  const parts = partsFor(bytes);
  if (idx < 0 || idx >= parts) return 0;
  return idx === parts - 1 ? bytes - SONG_CHUNK * (parts - 1) : SONG_CHUNK;
}

export function hexOf(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256HexBytes(bytes) {
  return hexOf(await crypto.subtle.digest('SHA-256', bytes));
}

export async function songHash(chunkHashes) {
  return sha256HexBytes(new TextEncoder().encode(chunkHashes.join('')));
}

export function songIdOf(hash) {
  return `s-${String(hash).slice(0, 16)}`;
}

export function encodeNotes(notes) {
  const list = [...notes].sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  let prev = 0;
  for (const n of list) {
    const t = Math.round(n.t);
    const cs = n.e !== undefined && n.e !== null && n.e > n.t ? Math.round((n.e - n.t) / 10) : 0;
    out.push(t - prev, (n.l | 0) + LANES * cs);
    prev = t;
  }
  return out;
}

export function decodeNotes(arr) {
  const out = [];
  let t = 0;
  for (let i = 0; i + 1 < arr.length; i += 2) {
    t += arr[i];
    const code = arr[i + 1];
    const l = code % LANES;
    const cs = Math.floor(code / LANES);
    out.push(cs > 0 ? { t, l, e: t + cs * 10 } : { t, l });
  }
  return out;
}

export function objectCount(notes) {
  let n = 0;
  for (const x of notes) n += x.e !== undefined ? 2 : 1;
  return n;
}

export function objTimes(notes) {
  const out = [];
  for (const x of notes) {
    out.push(x.t);
    if (x.e !== undefined) out.push(x.e);
  }
  return out.sort((a, b) => a - b);
}

export function endOf(note) {
  return note.e !== undefined ? note.e : note.t;
}

export function peakNps(notes) {
  let best = 0;
  let j = 0;
  for (let i = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t >= 1000) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

export function chartCounts(charts) {
  return DIFF_IDS.map((id) => objectCount(decodeNotes(charts.d[id])));
}

function checkNotes(id, arr, len) {
  const name = DIFF_NAMES[id];
  if (!Array.isArray(arr) || arr.length % 2 !== 0) throw bad(`The ${name} chart is broken.`);
  for (let i = 0; i < arr.length; i++) {
    if (!isInt(arr[i]) || arr[i] < 0) throw bad(`The ${name} chart is broken.`);
    if (i % 2 === 1) {
      const cs = Math.floor(arr[i] / LANES);
      if (cs > 0 && (cs < HOLD_MIN_CS || cs > HOLD_MAX_CS)) throw bad(`A hold in the ${name} chart is too short or too long.`);
      if (cs > 0 && !HOLD_DIFFS.includes(id)) throw bad(`Only Hard and Expert charts can have holds.`);
    }
  }
  const notes = decodeNotes(arr);
  const laneFree = [-Infinity, -Infinity, -Infinity, -Infinity];
  const holds = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.l < 0 || n.l >= LANES) throw bad(`The ${name} chart uses a lane that does not exist.`);
    if (n.t < FIRST_NOTE_MS) throw bad(`The first note in the ${name} chart comes too early.`);
    if (endOf(n) > len - END_PAD_MS) throw bad(`The ${name} chart runs past the end of the song.`);
    let same = 1;
    for (let k = i - 1; k >= 0 && notes[k].t === n.t; k--) {
      same += 1;
      if (notes[k].l === n.l) throw bad(`The ${name} chart has two notes in the same place.`);
    }
    if (same > MAX_CHORD) throw bad(`The ${name} chart has more than ${MAX_CHORD} notes at once.`);
    if (n.t < laneFree[n.l]) throw bad(`The ${name} chart has notes too close together in one lane.`);
    laneFree[n.l] = endOf(n) + LANE_REST_MS;
    let active = 0;
    for (let k = holds.length - 1; k >= 0; k--) {
      if (holds[k].e < n.t) holds.splice(k, 1);
      else if (holds[k].t < n.t) active += 1;
    }
    if (active + same > MAX_ACTIVE) throw bad(`The ${name} chart asks for more than ${MAX_ACTIVE} keys at once.`);
    if (n.e !== undefined) holds.push(n);
  }
  const count = objectCount(notes);
  if (count > OBJECT_CAPS[id]) throw bad(`The ${name} chart has too many notes.`);
  if (peakNps(notes) > NPS_CAPS[id]) throw bad(`The ${name} chart is too dense in places.`);
  return count;
}

export function validateCharts(charts, len) {
  if (charts === null || typeof charts !== 'object' || Array.isArray(charts)) throw bad('The chart is missing.');
  let size;
  try {
    size = JSON.stringify(charts).length;
  } catch {
    throw bad('The chart is broken.');
  }
  if (size > CHART_MAX_BYTES) throw bad('The chart is too big. Pick a shorter part of the song.');
  if (charts.v !== CHART_V) throw bad('The chart was made by an older version. Make it again.');
  const bpm = Number(charts.bpm);
  if (typeof charts.bpm !== 'number' || !Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) throw bad(`The tempo must be between ${BPM_MIN} and ${BPM_MAX} BPM.`);
  if (typeof charts.b0 !== 'number' || !Number.isFinite(charts.b0) || charts.b0 < 0 || charts.b0 > B0_MAX) throw bad('The first beat is in the wrong place.');
  if (!isInt(len) || charts.len !== len) throw bad('The chart does not match the part of the song you picked.');
  const marks = Array.isArray(charts.marks) ? charts.marks : null;
  if (!marks || marks.length > MARKS_MAX) throw bad('The chart has too many section marks.');
  let last = -1;
  for (const m of marks) {
    if (!Array.isArray(m) || m.length !== 2 || !isInt(m[0]) || !MARK_KINDS.includes(m[1])) throw bad('A section mark is broken.');
    if (m[0] < last || m[0] < 0 || m[0] > len) throw bad('The section marks are out of order.');
    last = m[0];
  }
  const d = charts.d;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw bad('The chart is missing its difficulties.');
  for (const id of DIFF_IDS) if (!Array.isArray(d[id])) throw bad(`The ${DIFF_NAMES[id]} chart is missing.`);
  const counts = DIFF_IDS.map((id) => checkNotes(id, d[id], len));
  if (counts[0] < 1) throw bad('The Chill chart has no notes.');
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] < counts[i - 1]) throw bad(`The ${DIFF_NAMES[DIFF_IDS[i]]} chart has fewer notes than ${DIFF_NAMES[DIFF_IDS[i - 1]]}.`);
  }
  const out = { v: CHART_V, bpm: Math.round(bpm * 100) / 100, b0: Math.round(charts.b0), len, marks: marks.map((m) => [m[0], m[1]]), d: {} };
  for (const id of DIFF_IDS) out.d[id] = d[id].slice();
  return out;
}
