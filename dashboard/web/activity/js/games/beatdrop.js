import { DIFFS, diffIdx, diffOf, firstNoteAt, objectsBefore, countOf, scoreOf, accOf, gradeOf, tierOf } from './beatchart.js';
import { catalog, catalogTried, songRow, songMeta, chartSong, loadChart, loadCatalog, songLength, lengthLabel, LENGTH_CHOICES, DEFAULT_LENGTH, SONG_ID_RE } from './beatsongs.js';
import { shuffle } from '../engine.js';
import { face } from './trivia.js';
import { PLACE_POINTS } from './typerace.js';
import { award, roundAt, say, bump, prize, keep, reel, list, nameOf, funMem } from './funkit.js';

export const KEY = 'beatdrop';
export const V = 4;
export const RANDOM = 'random';
export const SONG_RE = /^(random|s-[0-9a-f]{16})$/;
export const READY_MS = 20000;
export const READY_NEXT_MS = 8000;
export const READY_LEARN_MS = 40000;
export const READY_MAX_MS = 45000;
export const LOAD_WAIT_MS = 30000;
export const HOLD_POLL_MS = 1000;
export const LEAD_MS = 3000;
export const END_GRACE_MS = 3000;
export const SHOW_MS = 9000;
export const SKIP_MS = 5000;
export const PROG_SLACK = 1.5;
export const PROG_GAP_MS = 900;
export const SPAM_MS = 500;
export const IDLE_SILENT_MS = 6000;
export const IDLE_SHARE = 0.4;
export const IDLE_END_SHARE = 0.6;
export const CHECK_MS = 3000;
export const CLOSE_GAP = 30;
export const STREAK_PRIZE = 25;
export const FLOOR_POINTS = 90;
export const ACC_POINTS = 150;
export const FULL_BONUS = 50;
export const DIFF_PAY = Object.freeze([0.9, 1, 1.1, 1.2]);
export const EV_KEEP = 4;
export const EV_TIERS = Object.freeze([25, 50, 100]);
export const QUEUE_MAX = 48;
export const SAT_SKIP = 2;
export const FLAG_PLAYED = 0;
export const FLAG_SAT = 1;
export const FLAG_LEFT = 2;
export const SKIP_LOAD = 1;
export const SKIP_NONE = 2;
export const SKIP_WAIT = 3;
export const WAIT_TRIES = 3;
export const SONG_EMOJI = '🎵';
export const GOAL = 'Tap each note as it lands on its ring. Hold the long notes until they end. Keep your streak alive and out-groove the room.';
export const BLURB = 'Tap notes on the beat. Long streaks score big.';
export const SCORE_LINE = 'Hits score, Perfects score most, your longest streak adds a bonus. Max 1000.';
export const NEED_TEXT = 'Needs a song. Party staff can add one at yapos.dev/party/songs';
export const WAIT_TEXT = 'Checking for songs...';
export const SKIP_TEXT = "That song wouldn't load, so it was skipped.";
export const LOAD_FAIL_TEXT = "That song wouldn't load for you, you'll join the next one";
export const LATE_LOAD_TEXT = "Your song finished loading after the round started, so you're watching this one. You'll play the next one.";
export const LATE_LOAD_LAST = "Your song finished loading after the round started, so you're watching this one.";

export function usableSongs(cat = catalog()) {
  return (Array.isArray(cat) ? cat : []).filter((r) => r && typeof r.id === 'string' && SONG_ID_RE.test(r.id) && Number.isInteger(r.cv));
}

export function songsNote(cat = catalog(), tried = catalogTried()) {
  if (usableSongs(cat).length) return '';
  return tried ? NEED_TEXT : WAIT_TEXT;
}

function pairOk(pair) {
  return Array.isArray(pair) && typeof pair[0] === 'string' && SONG_ID_RE.test(pair[0]) && Number.isInteger(pair[1]);
}

export function songOfState(st) {
  if (!st || st.v !== V || typeof st.sid !== 'string' || !SONG_ID_RE.test(st.sid) || !Number.isInteger(st.cv)) return null;
  return chartSong(st.sid, st.cv, st.df, st.len);
}

function requestChart(st) {
  if (st && typeof st.sid === 'string' && SONG_ID_RE.test(st.sid) && Number.isInteger(st.cv)) loadChart(st.sid, st.cv).catch(() => null);
}

export function pointsFor(place, acc, fc, df = 1) {
  const base = place >= 1 && place <= PLACE_POINTS.length ? PLACE_POINTS[place - 1] : FLOOR_POINTS;
  const a = Math.max(0, Math.min(1, Number(acc) || 0));
  return base + Math.round(ACC_POINTS * a * a * DIFF_PAY[diffIdx(df)]) + (fc ? FULL_BONUS : 0);
}

export function lineup(settings, count, random, cat = catalog()) {
  const songs = usableSongs(cat);
  if (!songs.length || !(count > 0)) return [];
  const o = settings && typeof settings === 'object' ? settings : {};
  const pick = typeof o.song === 'string' && SONG_RE.test(o.song) ? o.song : RANDOM;
  const fixed = songs.find((r) => r.id === pick);
  if (fixed) return Array.from({ length: count }, () => [fixed.id, fixed.cv]);
  const out = [];
  while (out.length < count) {
    const round = shuffle(songs, random);
    if (out.length && round.length > 1 && round[0].id === out[out.length - 1][0]) round.push(round.shift());
    out.push(...round.map((r) => [r.id, r.cv]));
  }
  return out.slice(0, count);
}

export function songChoices(cat = catalog()) {
  return [{ value: RANDOM, label: 'Random song' }].concat(usableSongs(cat).map((r) => ({ value: r.id, label: r.artist ? `${r.title} - ${r.artist}` : r.title })));
}

function int(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

function uniq(a) {
  return a.filter((s, i) => Number.isInteger(s) && a.indexOf(s) === i);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function present(api) {
  return api.players().map((p) => p.slot);
}

export function checkProgress(song, songSec, v, base = null) {
  if (!Array.isArray(v) || v.length < 7) return null;
  const vals = v.slice(0, 7).map(int);
  if (vals.some((x) => x === null)) return null;
  const [j, p, g, o, m, c, b] = vals;
  const n = countOf(song);
  if (p + g + o + m !== j || j > n) return null;
  if (j > objectsBefore(song, songSec + PROG_SLACK)) return null;
  if (c > b || b > p + g + o) return null;
  if (base && (j < base.j || p < base.p || g < base.g || o < base.o || m < base.m || b < base.b)) return null;
  return { j, p, g, o, m, c, b, score: scoreOf(p, g, o, b, n) };
}

export function checkFinal(song, songSec, v, base = null) {
  if (!Array.isArray(v) || v.length < 5) return null;
  const vals = v.slice(0, 5).map(int);
  if (vals.some((x) => x === null)) return null;
  const [p, g, o, rawM, b] = vals;
  const n = countOf(song);
  const hits = p + g + o;
  if (hits > n || b > hits || hits + rawM > n) return null;
  if (hits > objectsBefore(song, songSec + PROG_SLACK)) return null;
  const m = n - hits;
  if (base && (p < base.p || g < base.g || o < base.o || m < base.m || b < base.b)) return null;
  return { p, g, o, m, b, score: scoreOf(p, g, o, b, n) };
}

function rowOf(r, n, done) {
  return [r.score, done ? 0 : r.c, done ? n : r.j, done ? 1 : 0, r.b, Math.round(accOf(r.p, r.g, r.o, n) * 100), r.p, r.g, r.o];
}

function baseOf(row) {
  if (!Array.isArray(row)) return null;
  const [, c, j, , b, , p, g, o] = row.map((x) => Number(x) || 0);
  return { j, p, g, o, m: Math.max(0, j - p - g - o), b, c };
}

function leaderOf(rows) {
  let top = null;
  for (const [k, r] of Object.entries(rows)) {
    if (!Array.isArray(r) || !(r[0] > 0)) continue;
    if (!top || r[0] > top.s || (r[0] === top.s && Number(k) < top.k)) top = { k: Number(k), s: r[0] };
  }
  return top ? top.k : null;
}

function memOf(api, st, since = api.now()) {
  const m = api.memory;
  if (!m.bd || m.bd.n !== st.n) {
    const rows = {};
    for (const [k, v] of Object.entries(st.sc || {})) if (Array.isArray(v)) rows[k] = v.slice();
    m.bd = { n: st.n, rows, seen: {}, since, wrote: 0, sig: '', ev: arr(st.ev).slice(), evn: Number(st.evn) || 0, idle: arr(st.idle).slice(), lead: leaderOf(rows), queue: [] };
  }
  return m.bd;
}

function pushEv(mem, ev) {
  mem.evn += 1;
  mem.ev.push([...ev, mem.evn]);
  if (mem.ev.length > EV_KEEP) mem.ev.splice(0, mem.ev.length - EV_KEEP);
}

function flush(api, st, mem, force = false) {
  const now = api.now();
  st.sc = {};
  for (const [k, v] of Object.entries(mem.rows)) st.sc[k] = v.slice();
  st.ev = mem.ev.map((e) => e.slice());
  st.evn = mem.evn;
  st.idle = mem.idle.slice();
  const sig = JSON.stringify([st.sc, st.ev, st.idle]);
  if (!force && sig === mem.sig) return false;
  if (!force && now - mem.wrote < PROG_GAP_MS) return false;
  api.put(KEY, st);
  mem.wrote = now;
  mem.sig = sig;
  return true;
}

export function startState(api) {
  const set = api.settings || {};
  const want = Math.max(1, Math.min(3, Number(set.songs) || 1));
  const df = diffIdx(set.difficulty);
  const len = songLength(set.length);
  const songs = lineup(set, want, api.random);
  return { n: 0, total: songs.length ? want : 1, want, df, len, lineup: songs, in: [], w: [], so: {} };
}

function emptyWhy(st) {
  if (arr(st.lineup).length || catalogTried()) return SKIP_NONE;
  loadCatalog().catch(() => null);
  return SKIP_WAIT;
}

function skip(api, st, why) {
  const now = api.now();
  const ends = now + SKIP_MS;
  const out = { ...st, phase: 'show', sk: why, res: {}, sc: {}, f: {}, ev: [], evn: 0, idle: [], rd: [], starts: now, ends };
  delete out.tt;
  api.put(KEY, out);
  api.memory.bd = null;
  api.memory.bdHold = null;
  api.setDeadline(ends);
  return true;
}

function ready(api, prev, i) {
  const here = present(api);
  const now = api.now();
  const pair = arr(prev.lineup)[i];
  const st = {
    v: V,
    n: (prev.n || 0) + 1,
    phase: 'ready',
    i,
    total: prev.total,
    want: prev.want,
    wt: prev.wt || 0,
    lineup: arr(prev.lineup),
    df: prev.df,
    len: prev.len,
    at: null,
    starts: now,
    ends: now + (i === 0 ? READY_MS : READY_NEXT_MS),
    in: uniq(arr(prev.in).concat(arr(prev.w), here)).filter((s) => here.includes(s)),
    w: [],
    rd: [],
    lr: [],
    ld: [],
    lf: [],
    lw: 0,
    nl: [],
    idle: [],
    so: prev.so && typeof prev.so === 'object' ? { ...prev.so } : {},
    sc: {},
    f: {},
    ev: [],
    evn: 0,
    res: null,
  };
  roundAt(api, i + 1, st.total);
  if (!pairOk(pair)) return skip(api, st, emptyWhy(st));
  st.sid = pair[0];
  st.cv = pair[1];
  api.put(KEY, st);
  api.setDeadline(st.ends);
  requestChart(st);
  return undefined;
}

function readyDone(api, st) {
  const here = present(api);
  const live = arr(st.in).filter((s) => here.includes(s));
  const waited = live.filter((s) => !((st.so || {})[s] >= SAT_SKIP));
  const set = waited.length ? waited : live.filter((s) => arr(st.rd).includes(s));
  if (!set.length) return false;
  if (!set.every((s) => st.rd.includes(s))) return false;
  return set.every((s) => arr(st.ld).includes(s) || arr(st.lf).includes(s));
}

function readyDeadline(api, st) {
  if (!st.lw) {
    const here = present(api);
    const missing = arr(st.in).filter((s) => here.includes(s) && !arr(st.ld).includes(s) && !arr(st.lf).includes(s));
    const now = api.now();
    const ends = Math.min(now + LOAD_WAIT_MS, st.starts + READY_MAX_MS + LOAD_WAIT_MS);
    if (missing.length && ends > now) {
      st.lw = 1;
      st.ends = ends;
      api.put(KEY, st);
      api.setDeadline(ends);
      return undefined;
    }
  }
  return play(api, st);
}

function play(api, st) {
  const now = api.now();
  const here = present(api);
  const song = songOfState(st);
  if (!song) {
    const m = api.memory;
    if (!m.bdHold || m.bdHold.n !== st.n) m.bdHold = { n: st.n, until: now + LOAD_WAIT_MS };
    if (now < m.bdHold.until) {
      requestChart(st);
      api.put(KEY, st);
      api.setDeadline(Math.min(m.bdHold.until, now + HOLD_POLL_MS));
      return undefined;
    }
    return skip(api, st, SKIP_LOAD);
  }
  const loaded = uniq(arr(st.in)).filter((s) => here.includes(s) && arr(st.ld).includes(s));
  if (!loaded.length) return skip(api, st, SKIP_LOAD);
  const out = arr(st.in).filter((s) => !loaded.includes(s));
  const at = now + LEAD_MS;
  const du = Math.round(song.dur * 1000);
  const ends = at + du + END_GRACE_MS;
  const next = { ...st, phase: 'play', in: loaded, w: uniq(arr(st.w).concat(out)), nl: out.filter((s) => here.includes(s)), rd: [], lr: [], ld: [], lf: [], sc: {}, f: {}, ev: [], evn: 0, idle: [], at, starts: now, ends, on: countOf(song), du };
  api.put(KEY, next);
  api.memory.bd = null;
  api.memory.bdHold = null;
  memOf(api, next, at);
  api.setDeadline(Math.min(ends, at + Math.round(firstNoteAt(song) * 1000) + IDLE_SILENT_MS + 500));
  return undefined;
}

function idleOf(api, st, song, mem) {
  const now = api.now();
  const n = countOf(song);
  const sec = (now - st.at) / 1000;
  const first = firstNoteAt(song);
  const here = present(api);
  const out = [];
  for (const s of arr(st.in)) {
    if (!here.includes(s) || (st.f && st.f[s])) continue;
    const base = baseOf(mem.rows[s]);
    const hits = base ? base.p + base.g + base.o : 0;
    if (!hits && base && base.j >= IDLE_SHARE * n) {
      out.push(s);
      continue;
    }
    const heard = Math.max(mem.seen[s] || 0, mem.since, st.at + first * 1000);
    if (sec > first + IDLE_SILENT_MS / 1000 && now - heard > IDLE_SILENT_MS) out.push(s);
  }
  return out;
}

function maybeEnd(api, st, mem) {
  const song = songOfState(st);
  const here = present(api);
  const live = arr(st.in).filter((s) => here.includes(s));
  if (!live.length) return reveal(api, st);
  if (!song) return false;
  mem.idle = idleOf(api, st, song, mem);
  const done = (s) => Boolean(st.f && st.f[s]);
  const active = live.filter((s) => done(s) || !mem.idle.includes(s));
  if (active.length && active.every(done)) return reveal(api, st);
  const sec = (api.now() - st.at) / 1000;
  if (!active.length && sec >= song.dur * IDLE_END_SHARE) return reveal(api, st);
  return false;
}

function placeRows(rows) {
  rows.sort((a, b) => (a.flag === FLAG_SAT) - (b.flag === FLAG_SAT) || b.score - a.score || b.acc - a.acc || b.b - a.b || a.s - b.s);
  let place = 0;
  let prev = null;
  let seen = 0;
  for (const r of rows) {
    if (r.flag !== FLAG_PLAYED) {
      r.place = 0;
      continue;
    }
    seen += 1;
    if (!prev || prev.score !== r.score || prev.acc !== r.acc || prev.b !== r.b) place = seen;
    r.place = place;
    prev = r;
  }
  return rows;
}

export function standings(st, song, mem, here) {
  const n = song ? countOf(song) : Number(st.on) || 0;
  const rowsSrc = mem && mem.n === st.n ? mem.rows : st.sc || {};
  const slots = uniq(arr(st.in).concat(Object.keys(st.sc || {}).map(Number), Object.keys(st.f || {}).map(Number)));
  const rows = slots.map((s) => {
    let p = 0;
    let g = 0;
    let o = 0;
    let b = 0;
    const fin = st.f && st.f[s];
    if (Array.isArray(fin)) [p, g, o, , b] = fin;
    else {
      const base = baseOf(rowsSrc[s]);
      if (base) ({ p, g, o, b } = base);
    }
    const hits = p + g + o;
    const m = Math.max(0, n - hits);
    const acc = accOf(p, g, o, n);
    const flag = !here.includes(s) ? FLAG_LEFT : hits === 0 ? FLAG_SAT : FLAG_PLAYED;
    return { s, p, g, o, m, b, score: scoreOf(p, g, o, b, n), acc, flag, fc: flag === FLAG_PLAYED && m === 0 && hits === n && n > 0 };
  });
  return placeRows(rows);
}

export function trackOf(st) {
  const id = st && typeof st.sid === 'string' ? st.sid : '';
  const meta = id ? songMeta(id, st.cv) : null;
  return { id, title: meta ? meta.title : 'Song', artist: meta ? meta.artist : '', credit: meta ? meta.credit : '', emoji: SONG_EMOJI, bpm: meta ? meta.bpm : 0 };
}

function reveal(api, st) {
  const song = songOfState(st);
  const mem = api.memory.bd && api.memory.bd.n === st.n ? api.memory.bd : null;
  const rows = standings(st, song, mem, present(api));
  const fx = funMem(api);
  const track = trackOf(st);
  const res = {};
  const so = { ...(st.so || {}) };
  for (const r of rows) {
    r.pts = r.flag === FLAG_PLAYED ? award(api, r.s, pointsFor(r.place, r.acc, r.fc, st.df)) : 0;
    res[r.s] = [r.place, r.score, gradeOf(r.score), Math.round(r.acc * 100), r.b, r.p, r.g, r.o, r.m, r.pts, r.flag];
    so[r.s] = r.flag === FLAG_SAT ? (so[r.s] || 0) + 1 : 0;
    if (r.flag !== FLAG_PLAYED) continue;
    if (r.fc) {
      bump(api, 'fc', r.s);
      say(api, 'hot', { slot: r.s });
      keep(api, `🎯 ${nameOf(api, r.s)} kept a full streak through ${track.title}`, r.s, 4);
    }
    if (r.p) bump(api, 'perfect', r.s, r.p);
    if (!fx.combo || r.b > fx.combo.n) fx.combo = { slot: r.s, n: r.b };
  }
  const top = rows.filter((r) => r.flag === FLAG_PLAYED);
  if (top.length >= 2 && top[0].score > top[1].score && top[0].score - top[1].score <= CLOSE_GAP) {
    say(api, 'close', { slot: top[1].s, other: top[0].s });
    keep(api, `🥁 ${nameOf(api, top[0].s)} edged out ${nameOf(api, top[1].s)} on ${track.title} by ${top[0].score - top[1].score}`, top[0].s, 3);
  }
  const best = top.reduce((a, r) => (r.b > (a ? a.b : 0) ? r : a), null);
  if (best && best.b >= STREAK_PRIZE) keep(api, `🔥 ${nameOf(api, best.s)} strung together a ${best.b} note streak`, best.s, 2 + best.b / 100);
  const now = api.now();
  const ends = now + SHOW_MS;
  const out = { ...st, phase: 'show', res, so, sc: {}, f: {}, ev: [], idle: [], rd: [], starts: now, ends, tt: [track.title, track.artist] };
  api.put(KEY, out);
  api.memory.bd = null;
  api.setDeadline(ends);
  return true;
}

function next(api, st) {
  if (st.sk && !arr(st.lineup).length && api.players().length) {
    const want = Math.max(1, Math.min(3, Number(st.want) || 1));
    const songs = lineup(api.settings || {}, want, api.random);
    if (songs.length) return ready(api, { ...st, lineup: songs, total: want }, 0);
    if (st.sk === SKIP_WAIT && (st.wt || 0) < WAIT_TRIES) return skip(api, { ...st, wt: (st.wt || 0) + 1 }, emptyWhy(st));
  }
  if (st.i + 1 < st.total && api.players().length) return ready(api, st, st.i + 1);
  return api.finish();
}

function admit(api, st, slot) {
  if (!Number.isInteger(slot)) return false;
  st.in = arr(st.in);
  st.w = arr(st.w);
  if (st.in.includes(slot) || st.w.includes(slot)) return false;
  if (st.phase === 'ready') st.in.push(slot);
  else st.w.push(slot);
  return true;
}

function queueUp(mem, slot, type, v, at) {
  mem.queue = mem.queue.filter((q) => !(q.slot === slot && q.type === type));
  mem.queue.push({ slot, type, v, at });
  if (mem.queue.length > QUEUE_MAX) mem.queue.splice(0, mem.queue.length - QUEUE_MAX);
}

function applyProg(api, st, song, mem, slot, v, now) {
  if (mem.seen[slot] && now - mem.seen[slot] < SPAM_MS) return false;
  const prev = mem.rows[slot];
  const row = checkProgress(song, (now - st.at) / 1000, v, baseOf(prev));
  if (!row) return false;
  mem.seen[slot] = Math.max(mem.seen[slot] || 0, now);
  const n = countOf(song);
  const was = prev ? Number(prev[1]) || 0 : 0;
  mem.rows[slot] = rowOf(row, n, false);
  const crossed = EV_TIERS.filter((t) => was < t && row.c >= t).pop();
  if (crossed) pushEv(mem, [slot, 't', crossed]);
  const lead = leaderOf(mem.rows);
  if (lead !== null && lead !== mem.lead && arr(st.in).length >= 2) pushEv(mem, [lead, 'l', mem.rows[lead][0]]);
  mem.lead = lead;
  return true;
}

function applyDone(api, st, song, mem, slot, v, now) {
  if (st.f && st.f[slot]) return false;
  const fin = checkFinal(song, (now - st.at) / 1000, v, baseOf(mem.rows[slot]));
  if (!fin) return false;
  const n = countOf(song);
  st.f = { ...(st.f || {}), [slot]: [fin.p, fin.g, fin.o, fin.m, fin.b] };
  mem.rows[slot] = rowOf(fin, n, true);
  mem.seen[slot] = Math.max(mem.seen[slot] || 0, now);
  if (fin.m === 0 && n > 0) pushEv(mem, [slot, 'f', fin.score]);
  const lead = leaderOf(mem.rows);
  if (lead !== null && lead !== mem.lead && arr(st.in).length >= 2) pushEv(mem, [lead, 'l', mem.rows[lead][0]]);
  mem.lead = lead;
  return true;
}

function drain(api, st, song, mem) {
  const q = mem.queue;
  mem.queue = [];
  let force = false;
  for (const x of q) {
    if (x.type === 'prog') applyProg(api, st, song, mem, x.slot, x.v, x.at);
    else if (applyDone(api, st, song, mem, x.slot, x.v, x.at)) force = true;
  }
  return force;
}

function handleProg(api, st, slot, v) {
  const song = songOfState(st);
  const mem = memOf(api, st);
  const now = api.now();
  if (!song) {
    queueUp(mem, slot, 'prog', v, now);
    requestChart(st);
    return;
  }
  if (!applyProg(api, st, song, mem, slot, v, now)) return;
  if (maybeEnd(api, st, mem)) return;
  flush(api, st, mem);
}

function handleDone(api, st, slot, v) {
  const song = songOfState(st);
  const mem = memOf(api, st);
  const now = api.now();
  if (!song) {
    queueUp(mem, slot, 'done', v, now);
    requestChart(st);
    return;
  }
  if (!applyDone(api, st, song, mem, slot, v, now)) return;
  if (maybeEnd(api, st, mem)) return;
  flush(api, st, mem, true);
}

function loadIntent(api, st, slot, ok) {
  if (st.phase !== 'ready' || !arr(st.in).includes(slot)) return undefined;
  st.ld = arr(st.ld);
  st.lf = arr(st.lf);
  if (ok) {
    if (st.ld.includes(slot)) return undefined;
    st.ld.push(slot);
    st.lf = st.lf.filter((s) => s !== slot);
  } else {
    if (st.ld.includes(slot) || st.lf.includes(slot)) return undefined;
    st.lf.push(slot);
  }
  if (readyDone(api, st)) return play(api, st);
  api.put(KEY, st);
  return undefined;
}

const beatdrop = {
  id: 'beatdrop',
  name: 'Beat Drop',
  emoji: '🥁',
  category: 'quick',
  blurb: BLURB,
  minPlayers: 1,
  keys: [KEY],
  cards: ['swap', 'double'],
  settings: [
    { id: 'difficulty', label: 'Difficulty', type: 'choice', options: DIFFS.map((d) => ({ value: d.id, label: d.name })), default: 'normal' },
    {
      id: 'song',
      label: 'Song',
      type: 'song',
      default: RANDOM,
      get options() {
        return songChoices();
      },
      list: () => songChoices(),
    },
    { id: 'length', label: 'Song length', type: 'choice', options: LENGTH_CHOICES.map((v) => ({ value: v, label: lengthLabel(v) })), default: DEFAULT_LENGTH },
    { id: 'songs', label: 'Songs', type: 'choice', options: [1, 2, 3].map((v) => ({ value: v, label: String(v) })), default: 2 },
  ],

  blocked() {
    return songsNote();
  },

  warm() {
    return loadCatalog();
  },

  start(api) {
    ready(api, startState(api), 0);
  },

  intent(api, slot, action) {
    if (!action || typeof action.type !== 'string') return undefined;
    const st = api.get(KEY);
    if (!st || st.v !== V || action.n !== st.n) return undefined;
    if (action.type === 'loaded' || action.type === 'nolo') return loadIntent(api, st, slot, action.type === 'loaded');
    if (action.type === 'ready') {
      if (st.phase !== 'ready' || !api.players().some((p) => p.slot === slot)) return undefined;
      if (!st.in.includes(slot)) {
        st.in.push(slot);
        st.w = arr(st.w).filter((s) => s !== slot);
      }
      if (st.rd.includes(slot)) return undefined;
      st.rd.push(slot);
      if (readyDone(api, st)) return play(api, st);
      api.put(KEY, st);
      return undefined;
    }
    if (action.type === 'learn') {
      if (st.phase !== 'ready' || !arr(st.in).includes(slot) || arr(st.lr).includes(slot)) return undefined;
      st.lr = arr(st.lr).concat(slot);
      const ends = Math.min(st.starts + READY_MAX_MS, Math.max(st.ends, api.now() + READY_LEARN_MS));
      if (ends !== st.ends) {
        st.ends = ends;
        api.setDeadline(ends);
      }
      api.put(KEY, st);
      return undefined;
    }
    if (st.phase !== 'play' || !arr(st.in).includes(slot)) return undefined;
    if (action.type === 'prog') return handleProg(api, st, slot, action.v);
    if (action.type === 'done') return handleDone(api, st, slot, action.v);
    return undefined;
  },

  results(api) {
    const st = api.get(KEY);
    const res = st && st.res && typeof st.res === 'object' ? st.res : {};
    const fc = Object.entries(res)
      .filter(([, r]) => Array.isArray(r) && r[10] === FLAG_PLAYED && r[8] === 0 && r[5] + r[6] + r[7] > 0)
      .map(([k]) => Number(k));
    const extra = fc.length ? { fullCombo: fc } : {};
    if (st && Array.isArray(st.tt)) extra.song = { t: String(st.tt[0] || ''), a: String(st.tt[1] || '') };
    return { extra };
  },

  awards(api) {
    const fx = funMem(api);
    const c = fx.combo;
    return list(
      prize(api, 'fc', 'Full streak', '🎯', (n) => (n > 1 ? `${n} songs without a single miss` : 'Did not miss a single note'), 1),
      c && c.n >= STREAK_PRIZE ? { title: 'Streak king', emoji: '🔥', who: c.slot, why: `${c.n} notes in a row` } : null,
      prize(api, 'perfect', 'Perfect timing', '✨', (n) => `${n} perfect hits`, 20),
    );
  },

  highlights(api) {
    return reel(api);
  },

  deadline(api) {
    const st = api.get(KEY);
    if (!st || st.v !== V) return api.finish();
    if (st.phase === 'ready') return readyDeadline(api, st);
    if (st.phase === 'play') {
      const now = api.now();
      const song = songOfState(st);
      const mem = memOf(api, st);
      if (!song) requestChart(st);
      else if (mem.queue.length && drain(api, st, song, mem)) flush(api, st, mem, true);
      if (now >= st.ends - 20) return reveal(api, st);
      if (maybeEnd(api, st, mem)) return undefined;
      flush(api, st, mem);
      api.setDeadline(Math.min(st.ends, now + CHECK_MS));
      return undefined;
    }
    return next(api, st);
  },

  admin(api, action) {
    const st = api.get(KEY);
    if (!st || st.v !== V || !['ready', 'play', 'show'].includes(st.phase)) return false;
    if (action.type === 'skip') {
      if (st.phase === 'play') reveal(api, st);
      else beatdrop.deadline(api);
      return true;
    }
    if (action.type === 'time' && st.phase !== 'play') {
      const ends = api.shift(st.ends, action.ms);
      api.put(KEY, { ...st, ends });
      api.setDeadline(ends);
      return true;
    }
    return false;
  },

  resume(api) {
    const st = api.get(KEY);
    if (!st || st.v !== V) return beatdrop.start(api);
    requestChart(st);
    if (api.deadline === null) api.setDeadline(Math.max(api.now(), Math.min(st.ends || api.now(), api.now() + CHECK_MS)));
    return undefined;
  },

  join(api, slot) {
    const st = api.get(KEY);
    if (st && st.v === V && admit(api, st, slot)) api.put(KEY, st);
  },

  roster(api) {
    const st = api.get(KEY);
    if (!st || st.v !== V) return;
    let added = false;
    for (const p of api.players()) if (admit(api, st, p.slot)) added = true;
    if (st.phase === 'ready' && readyDone(api, st)) return play(api, st);
    if (st.phase === 'play') {
      const mem = memOf(api, st);
      if (maybeEnd(api, st, mem)) return undefined;
      if (added) flush(api, st, mem, true);
      return undefined;
    }
    if (added) api.put(KEY, st);
    return undefined;
  },

  songOf(snap) {
    const st = snap && snap.state ? snap.state[KEY] : null;
    return songOfState(st);
  },

  model(snap) {
    const st = snap.state[KEY];
    if (!st || st.v !== V) return null;
    const song = songOfState(st);
    const mine = snap.meSlot;
    const bySlot = new Map(snap.players.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
    const track = trackOf(st);
    const d = diffOf(st.df);
    const n = song ? countOf(song) : Number(st.on) || 0;
    const ins = arr(st.in);
    const ld = arr(st.ld);
    const lf = arr(st.lf);
    const playing = mine !== null && ins.includes(mine);
    const waiting = mine !== null && arr(st.w).includes(mine);
    const board = ins
      .map((s) => {
        const p = bySlot.get(s);
        if (!p) return null;
        const sc = Array.isArray(st.sc && st.sc[s]) ? st.sc[s] : [0, 0, 0, 0, 0, 0];
        return { ...face(p, mine), slot: s, score: sc[0] || 0, streak: sc[1] || 0, tier: tierOf(sc[1] || 0), pct: n ? Math.min(100, Math.round(((sc[2] || 0) / n) * 100)) : 0, done: sc[3] === 1, best: sc[4] || 0, acc: sc[5] || 0, idle: arr(st.idle).includes(s) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.slot - b.slot);
    let results = [];
    if (st.phase === 'show' && st.res && typeof st.res === 'object') {
      results = Object.entries(st.res)
        .map(([k, r]) => {
          const s = Number(k);
          const p = bySlot.get(s);
          const who = p ? face(p, mine) : { id: null, name: 'Player', isMe: s === mine, initials: '?', hue: 0 };
          const [place, score, grade, acc, best, pp, g, o, m, pts, flag] = r;
          return { ...who, slot: s, place, score, grade, acc, best, p: pp, g, o, m, pts, flag, fc: flag === FLAG_PLAYED && m === 0 && pp + g + o > 0, badges: [] };
        })
        .sort((a, b) => (a.flag === FLAG_SAT) - (b.flag === FLAG_SAT) || b.score - a.score || b.acc - a.acc || b.best - a.best || a.slot - b.slot);
      const played = results.filter((r) => r.flag === FLAG_PLAYED);
      const maxP = Math.max(0, ...played.map((r) => r.p));
      const maxB = Math.max(0, ...played.map((r) => r.best));
      for (const r of played) {
        if (r.fc) r.badges.push('Full streak');
        if (maxP > 0 && r.p === maxP && played.length > 1) r.badges.push('Most Perfects');
        if (maxB > 0 && r.best === maxB && played.length > 1) r.badges.push('Longest streak');
      }
    }
    const lineupOk = Array.isArray(st.lineup);
    const nx = st.i + 1 < st.total && lineupOk ? st.lineup[st.i + 1] : null;
    const entryBpm = (e) => (pairOk(e) ? (songRow(e[0]) || { bpm: null }).bpm || null : null);
    let nextInfo = null;
    if (pairOk(nx)) {
      const meta = songMeta(nx[0], nx[1]);
      nextInfo = { name: meta ? meta.title : 'A new song', emoji: SONG_EMOJI, bpm: meta && meta.bpm ? meta.bpm : null, diffName: d.name, title: meta ? meta.title : 'A new song' };
    }
    const prevBpm = st.i > 0 && lineupOk ? entryBpm(st.lineup[st.i - 1]) : null;
    const bpm = song ? Math.round(song.bpm) : track.bpm || null;
    const readyBy = arr(st.rd).map((s) => bySlot.get(s)).filter(Boolean).map((p) => face(p, mine));
    const dots = ins.filter((s) => bySlot.has(s)).map((s) => ({ slot: s, on: arr(st.rd).includes(s), ld: ld.includes(s), lf: lf.includes(s), isMe: s === mine }));
    return {
      key: `${st.n}`,
      n: st.n,
      phase: st.phase,
      number: st.i + 1,
      total: st.total,
      sid: track.id || null,
      cv: Number.isInteger(st.cv) ? st.cv : null,
      chart: Boolean(song),
      track: { id: track.id, name: track.title, emoji: track.emoji, bpm },
      song: { title: track.title, artist: track.artist, credit: track.credit },
      faster: prevBpm !== null && bpm !== null && bpm > prevBpm,
      df: diffIdx(st.df),
      diffName: d.name,
      len: st.len,
      at: st.at,
      starts: st.starts,
      ends: st.ends,
      notes: n,
      songEnd: st.at === null ? null : st.at + (Number.isInteger(st.du) ? st.du : song ? Math.round(song.dur * 1000) : 0),
      playing,
      waiting,
      watching: !playing,
      noLoad: mine !== null && arr(st.nl).includes(mine),
      skipped: st.phase === 'show' && st.sk ? (st.sk === SKIP_NONE ? NEED_TEXT : st.sk === SKIP_WAIT ? WAIT_TEXT : SKIP_TEXT) : '',
      iReady: mine !== null && arr(st.rd).includes(mine),
      loading: st.phase === 'ready' ? { mine: ld.includes(mine) ? 'ok' : lf.includes(mine) ? 'fail' : 'wait', done: ins.filter((s) => ld.includes(s)).length, of: ins.length } : null,
      readyBy,
      dots,
      readyCount: readyBy.length,
      players: ins.filter((s) => bySlot.has(s) && bySlot.get(s).present !== false).length,
      board,
      ev: arr(st.ev),
      results,
      satOut: results.filter((r) => r.flag === FLAG_SAT),
      mine: results.find((r) => r.slot === mine) || null,
      last: st.i + 1 >= st.total,
      next: nextInfo,
    };
  },
};

export default beatdrop;
