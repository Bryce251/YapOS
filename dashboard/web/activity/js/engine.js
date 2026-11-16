import { OpBudget, OPS_WINDOW_MS, MAX_VALUE_BYTES, checkSet, jsonBytes, validKey } from './limits.js';
import { idOf, people, person, cleanName, initials, hueOf } from './players.js';
import { censor } from './filter.js';
import { isAdmin as cachedAdmin, knows as cachedKnows, ownerId as cachedOwner, isBanned as cachedBanned, refreshAdmins, onAdmins, sendTextReport, sendResults, allowResultGames } from './admin.js';
import { cleanShared } from './text.js';
import {
  FUN,
  REACTIONS,
  REACT_WINDOW_MS,
  REACT_GAP_MS,
  REACT_MAX,
  LINE_GAP_MS,
  LINE_STALE_MS,
  LINE_MAX,
  DRAMA_MS,
  HINT_MAX,
  UPSET_MAX,
  HIGHLIGHTS_MAX,
  STREAK_MIN,
  QUIET_ROUND,
  ROAST_ROUND,
  ROAST_MAX,
  HL_RE,
  SAY_KINDS,
  PRIORITY,
  BANNER_KINDS,
  PARTY_IDS,
  cardByCode,
  cardsFor,
  dealOne,
  dealCards,
  partyOf,
  partyPatch,
  ranked,
  slotAbove,
  leaderOf,
  placeOf,
  pickLine,
  cleanAward,
  cleanHighlight,
  genericAwards,
  upsetLine,
  fitAwards,
  teamCodes,
} from './fun.js';

export { FUN, REACTIONS, CARDS, PARTY_SETTINGS, LINES, SAY_KINDS } from './fun.js';

export const FLUSH_MS = 120;
export const SOFT_OPS = 60;
export const PLAYER_CAP = 36;
export const MAX_BATCH = 20;
export const PLAYERS_BYTES = 3800;
export const STORED_NAME_BYTES = 48;
export const RESEND_MS = 3000;
export const LATE_MS = 1500;
export const WANT_MS = 4000;
export const WANT_TRIES = 5;
export const ROOM = 'room';
export const SCORES = 'scores';
export const PLAYERS = 'players';
export const CORE_KEYS = Object.freeze([ROOM, SCORES, PLAYERS]);
export const ADMIN_TIME_MAX = 600000;
export const ADMIN_TIME_MIN_LEFT = 3000;
export const ADMIN_POINTS_MAX = 100000;
export const BAN_MAX = 40;
export const ANNOUNCE_MS = 10000;
export const ANNOUNCE_MAX = 140;
export const FX_MIN_MS = 1000;
export const FX_MAX_MS = 30000;
export const FX_DEFAULT_MS = 6000;
export const FX_GAP_MS = 700;
export const EMOJI_MAX = 16;
export const FUN_FX = Object.freeze(['confetti', 'emoji-rain', 'spotlight', 'hype', 'tacos']);
export const TROLL_FX = Object.freeze(['flip', 'mirror', 'shake', 'spin', 'tiny', 'comic', 'blur', 'crash', 'clown', 'fake-win']);
export const ALL_FX = Object.freeze(FUN_FX.concat(TROLL_FX));
export const TARGET_FX = Object.freeze(['spotlight', 'clown', 'fake-win']);
export const ADMIN_ACTIONS = Object.freeze(['start', 'end', 'skip', 'time', 'points', 'kick', 'ban', 'unban', 'lock', 'announce', 'clearDrawing']);
export const FLAG_KEEP = 12;
export const FLAG_CAP = 2;
export const FLAG_CROWD = 3;
export const DRAWING_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
export const TEXT_REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const TEXT_REPORT_LIMIT = 5;
export const TEXT_REPORT_WINDOW_MS = 60000;
export const TEXT_REPORT_KEEP = 400;
export const TEXT_REPORT_CHARS = 300;
export const TEXT_CONTEXT_CHARS = 200;
export const CODE_MAX = 12;
export const RESULT_MIN_PLAYERS = 2;
export const RESULT_MAX_PLAYERS = 16;
export const RESULT_EXTRA_KEYS = 8;
export const SKILL_QUESTIONS_MAX = 50;
const SKILL_CAPS = Object.freeze([['s', 20], ['l', 10], ['p', 1]]);
export const PRED = 'pred';
export const PREDICT_MS = 20000;
export const PREDICT_MAX = 16;
export const TOUR_GAMES = 3;
export const PLACE_POINTS = Object.freeze([10, 7, 5, 3, 2, 1]);
export const OUT_MAX = 36;
const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 160;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STRIP_RE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const EMOJI_PARTS_RE = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Emoji_Component}‍️⃣]+$/u;
const DEFAULT_ADMINS = Object.freeze({ isAdmin: cachedAdmin, knows: cachedKnows, ownerId: cachedOwner, banned: cachedBanned, refresh: refreshAdmins, onChange: onAdmins });

export function validDrawing(d) {
  return typeof d === 'string' && DRAWING_RE.test(d);
}

export function validTextRef(r) {
  return typeof r === 'string' && TEXT_REF_RE.test(r);
}

function clip(raw, max) {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

export function flagNeed(guessers) {
  const n = Number.isFinite(guessers) ? Math.floor(guessers) : 0;
  return n >= FLAG_CROWD ? 2 : 1;
}

export function flagsIn(room) {
  const f = room && room.flags;
  return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
}

export function flagsUsed(room, slot) {
  const fc = room && room.fc;
  if (!fc || typeof fc !== 'object' || fc.r !== room.round || !fc.n || typeof fc.n !== 'object') return 0;
  const n = fc.n[slot];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function flagsLeft(snap) {
  const room = snap && snap.room;
  const me = snap ? snap.meSlot : null;
  if (!room || !Number.isInteger(me)) return 0;
  return Math.max(0, FLAG_CAP - flagsUsed(room, me));
}

function viewerSet(viewers) {
  return Array.isArray(viewers) ? new Set(viewers.filter((s) => Number.isInteger(s))) : null;
}

export function flagInfo(snap, d, drawer, viewers = null) {
  const room = snap && snap.room;
  const raw = validDrawing(d) ? flagsIn(room)[d] : null;
  const see = viewerSet(viewers);
  const players = (snap && Array.isArray(snap.players) ? snap.players : []).filter((p) => p.joined && p.present !== false && Number.isInteger(p.slot) && p.slot !== drawer && (!see || see.has(p.slot)));
  const live = new Set(players.map((p) => p.slot));
  const by = Array.isArray(raw) ? raw.filter((s) => Number.isInteger(s) && s !== drawer) : [];
  const me = snap ? snap.meSlot : null;
  return { count: by.filter((s) => live.has(s)).length, need: flagNeed(players.length), mine: Number.isInteger(me) && by.includes(me) };
}

export function shiftEnd(ends, ms, at) {
  const base = Number.isFinite(ends) ? ends : at;
  const lo = Math.min(base, at + ADMIN_TIME_MIN_LEFT);
  const hi = Math.max(base, at + ADMIN_TIME_MAX);
  return Math.round(Math.min(hi, Math.max(lo, base + (Number.isFinite(ms) ? ms : 0))));
}

export function cleanText(raw, max = ANNOUNCE_MAX) {
  if (typeof raw !== 'string') return '';
  const text = censor(raw.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim()).text;
  const chars = Array.from(text);
  return chars.length > max ? censor(chars.slice(0, max).join('').trim()).text : text;
}

function graphemes(text) {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
  } catch {}
  return Array.from(text).length;
}

export function cleanEmoji(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > EMOJI_MAX || !EMOJI_RE.test(text) || !EMOJI_PARTS_RE.test(text)) return null;
  return graphemes(text) === 1 ? text : null;
}

export function cleanFx(data) {
  if (!data || typeof data !== 'object') return null;
  const fx = data.fx;
  if (typeof fx !== 'string' || !ALL_FX.includes(fx)) return null;
  const target = typeof data.target === 'string' && USER_RE.test(data.target) ? data.target : null;
  if (data.target !== null && data.target !== undefined && target === null) return null;
  if (TARGET_FX.includes(fx) && !target) return null;
  const raw = data.ms === null || data.ms === undefined ? NaN : Number(data.ms);
  const ms = Number.isFinite(raw) ? Math.round(Math.min(FX_MAX_MS, Math.max(FX_MIN_MS, raw))) : FX_DEFAULT_MS;
  let extra = null;
  if (fx === 'emoji-rain') extra = { emoji: cleanEmoji(data.extra && data.extra.emoji) || '🎉' };
  return { fx, target, ms, extra };
}

export function cleanAdminAction(a) {
  if (!a || typeof a !== 'object' || typeof a.type !== 'string' || !ADMIN_ACTIONS.includes(a.type)) return null;
  const type = a.type;
  if (type === 'start' || type === 'end' || type === 'skip') return { type };
  if (type === 'clearDrawing') return validDrawing(a.d) ? { type, d: a.d } : { type };
  if (type === 'lock') return { type, on: Boolean(a.on) };
  if (type === 'announce') return { type, text: cleanText(a.text) };
  if (type === 'time') {
    const ms = Number(a.ms);
    if (!Number.isFinite(ms) || Math.round(ms) === 0) return null;
    return { type, ms: Math.round(Math.max(-ADMIN_TIME_MAX, Math.min(ADMIN_TIME_MAX, ms))) };
  }
  const out = { type };
  if (Number.isInteger(a.slot) && a.slot >= 0) out.slot = a.slot;
  else if (typeof a.id === 'string' && USER_RE.test(a.id)) out.id = a.id;
  else return null;
  if (type === 'points') {
    const n = Number(a.n);
    if (!Number.isFinite(n)) return null;
    out.n = Math.round(Math.max(-ADMIN_POINTS_MAX, Math.min(ADMIN_POINTS_MAX, n)));
    if (out.n === 0) return null;
  }
  return out;
}

export function clone(v) {
  return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));
}

export function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function shuffle(list, random = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function defaultSettings(game) {
  const out = {};
  for (const s of (game && game.settings) || []) out[s.id] = clone(s.default);
  return out;
}

export function cleanCode(raw, max = CODE_MAX) {
  if (typeof raw !== 'string') return undefined;
  const cap = Math.max(0, Math.min(CODE_MAX, Number.isInteger(max) ? max : CODE_MAX));
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, cap);
}

export function cleanSetting(spec, value) {
  if (!spec) return undefined;
  if (spec.type === 'code') return cleanCode(value, spec.max);
  const values = (spec.options || []).map((o) => o.value);
  if (spec.type === 'toggle') return value === undefined || value === null ? undefined : Boolean(value);
  if (spec.type === 'multi') {
    if (!Array.isArray(value)) return undefined;
    const picked = values.filter((v) => value.includes(v));
    return picked.length ? picked : undefined;
  }
  return values.includes(value) ? value : undefined;
}

export function settingsFor(game, room) {
  const base = defaultSettings(game);
  const saved = (room && room.opts && game && room.opts[game.id]) || {};
  for (const spec of (game && game.settings) || []) {
    const v = cleanSetting(spec, saved[spec.id]);
    if (v !== undefined) base[spec.id] = v;
  }
  return base;
}

export function newRoom(pick) {
  return { v: 1, phase: 'lobby', pick, game: null, opts: {}, deadline: null, round: 0, last: null, auto: null };
}

export function newScores() {
  return { g: {}, t: {}, w: {} };
}

export function ownsKey(game, key) {
  if (!game) return false;
  if ((game.keys || []).includes(key)) return true;
  return (game.prefixes || []).some((p) => key.startsWith(p));
}

export function rank(points) {
  return Object.entries(points || {})
    .map(([slot, pts]) => ({ slot: Number(slot), pts: Number(pts) || 0 }))
    .sort((a, b) => b.pts - a.pts || a.slot - b.slot);
}

export function topSlots(points) {
  const list = rank(points);
  if (!list.length || list[0].pts <= 0) return [];
  return list.filter((x) => x.pts === list[0].pts).map((x) => x.slot);
}

export function autoOf(game) {
  const a = game && game.autoStart;
  if (!a || typeof a !== 'object') return null;
  const min = Math.max(1, Math.floor(Number(a.min) || 1));
  const ms = Math.max(1000, Math.floor(Number(a.ms) || 0));
  return { min, ms };
}

export function timerAt(room) {
  if (!room) return null;
  if (room.phase === 'game' && typeof room.deadline === 'number') return room.deadline;
  if (room.phase === 'lobby' && room.auto && typeof room.auto.at === 'number') return room.auto.at;
  return null;
}

export function storedName(name) {
  let out = '';
  for (const ch of cleanName(name)) {
    if (jsonBytes(out + ch) - 2 > STORED_NAME_BYTES) break;
    out += ch;
  }
  return out || 'Player';
}

export function placementPoints(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isInteger(r.slot))
    .map((r) => ({ slot: r.slot, won: r.won ? 1 : 0, score: Number(r.score) || 0 }))
    .sort((a, b) => b.won - a.won || b.score - a.score || a.slot - b.slot);
  const out = {};
  let place = 0;
  let prev = null;
  list.forEach((r, i) => {
    const sig = `${r.won}|${r.score}`;
    if (sig !== prev) {
      place = i;
      prev = sig;
    }
    out[r.slot] = PLACE_POINTS[place] || 0;
  });
  return out;
}

export function championOf(pts, firsts = {}, lastPlace = {}) {
  const slots = Object.keys(pts || {}).map(Number).filter(Number.isInteger);
  if (!slots.length) return null;
  slots.sort((a, b) => (pts[b] || 0) - (pts[a] || 0) || (firsts[b] || 0) - (firsts[a] || 0) || (lastPlace[b] || 0) - (lastPlace[a] || 0) || a - b);
  return (pts[slots[0]] || 0) > 0 ? slots[0] : null;
}

export function cleanTour(raw, games) {
  if (!raw || typeof raw !== 'object') return null;
  const known = games instanceof Map ? (id) => games.has(id) : (id) => (Array.isArray(games) ? games.some((g) => g && g.id === id) : false);
  const list = Array.isArray(raw.g) ? raw.g : [];
  const g = [];
  for (const id of list) {
    if (g.length >= TOUR_GAMES) break;
    if (typeof id === 'string' && known(id) && !g.includes(id)) g.push(id);
  }
  return { g };
}

export function pickTourGames(list, chosen, players, random = Math.random) {
  const games = Array.isArray(list) ? list : [];
  const fits = (g) => g && (g.minPlayers || 1) <= players;
  const out = (Array.isArray(chosen) ? chosen : []).filter((id) => games.some((g) => g.id === id)).slice(0, TOUR_GAMES);
  const pool = shuffle(games.filter((g) => fits(g) && !out.includes(g.id)), random);
  while (out.length < TOUR_GAMES && pool.length) out.push(pool.shift().id);
  return out.length === TOUR_GAMES ? out : null;
}

export function tourOf(room) {
  const t = room && room.trn;
  if (!t || typeof t !== 'object' || !Array.isArray(t.g) || !Number.isInteger(t.i)) return null;
  return t;
}

export function createEngine(opts) {
  const t = opts.transport;
  const gameList = opts.games || [];
  const games = new Map(gameList.map((g) => [g.id, g]));
  allowResultGames(gameList.map((g) => g && g.id));
  const now = opts.now || (() => Date.now());
  let skew = 0;
  const sharedNow = () => (isHost() ? now() : now() + skew);
  const random = opts.random || Math.random;
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  const flushMs = Math.max(FLUSH_MS, opts.flushMs ?? FLUSH_MS);
  const admins = { ...DEFAULT_ADMINS, ...(opts.admins || {}) };
  const fxSeen = new Map();
  const postText = typeof opts.reportText === 'function' ? opts.reportText : sendTextReport;
  const postResults = typeof opts.postResults === 'function' ? opts.postResults : sendResults;
  const textSeen = new Set();
  const textTimes = new Map();
  const myReports = new Set();
  let myTimes = [];
  let annTimer = null;
  const budget = opts.budget || new OpBudget(opts.softOps ?? SOFT_OPS, OPS_WINDOW_MS);
  const pending = new Map();
  const overlay = new Map();
  const trusted = new Map();
  const outbox = [];
  const handlers = {};
  const stats = { sets: 0, sends: 0, deferred: 0, errors: [] };
  let memory = {};
  let flushTimer = null;
  let deadlineTimer = null;
  let resendTimer = null;
  let lateTimer = null;
  let lateSent = null;
  let want = null;
  let wantTimer = null;
  let wantTries = 0;
  let changeQueued = false;
  let lastHost = null;
  let hosting = false;
  let destroyed = false;
  let readySeen = false;
  let myPick = null;
  const funRandom = typeof opts.funRandom === 'function' ? opts.funRandom : Math.random;
  const reactSeen = new Map();
  const lineMemo = {};
  let myReacts = [];
  let fm = freshFunMem();
  let dramaTimer = null;
  let lineTimer = null;
  let queued = null;
  let lastLineAt = -Infinity;

  const meId = () => idOf(t.me);
  const hostId = () => idOf(t.host);
  const isHost = () => Boolean(meId()) && meId() === hostId();

  function emit(ev, x) {
    for (const fn of (handlers[ev] || []).slice()) {
      try {
        fn(x);
      } catch (e) {
        stats.errors.push(String((e && e.message) || e));
      }
    }
  }

  function fail(e) {
    stats.errors.push(String((e && e.message) || e));
    emit('error', e);
  }

  function changed() {
    if (changeQueued || destroyed) return;
    changeQueued = true;
    queueMicrotask(() => {
      changeQueued = false;
      if (!destroyed) emit('change', snapshot());
    });
  }

  function shared(key) {
    const v = trusted.get(key);
    return v === undefined ? null : v;
  }

  function read(key) {
    if (pending.has(key)) return pending.get(key);
    if (overlay.has(key)) return overlay.get(key).val;
    return shared(key);
  }

  function merged() {
    const out = {};
    for (const [k, v] of trusted) out[k] = v;
    for (const [k, v] of overlay) out[k] = v.val;
    for (const [k, v] of pending) out[k] = v;
    for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
    return out;
  }

  function write(key, value) {
    if (!validKey(key)) throw new Error(`Bad state key ${key}`);
    const val = value === undefined ? null : clone(value);
    if (same(read(key), val)) return false;
    const problem = checkSet(merged(), key, val);
    if (problem) throw new Error(`State ${key} refused: ${problem}`);
    pending.set(key, val);
    scheduleFlush();
    changed();
    if (key === ROOM) scheduleDeadline();
    return true;
  }

  function queueSend(data) {
    if (jsonBytes(data) > MAX_VALUE_BYTES) throw new Error('Message is too big');
    outbox.push(clone(data));
    scheduleFlush();
  }

  function delayFor(at) {
    if (budget.available(at) < 1) return Math.max(flushMs, budget.nextFree(at) - at + 1);
    if (budget.used(at) * 2 > budget.limit) return flushMs * 3;
    return flushMs;
  }

  function scheduleFlush() {
    if (flushTimer !== null || destroyed) return;
    if (!pending.size && !outbox.length) return;
    flushTimer = setT(flush, delayFor(now()));
  }

  function takeBatch() {
    const list = [];
    while (outbox.length && list.length < MAX_BATCH) {
      const next = list.concat([outbox[0]]);
      const payload = next.length === 1 ? next[0] : { t: 'many', m: next };
      if (list.length && jsonBytes(payload) > MAX_VALUE_BYTES) break;
      list.push(outbox.shift());
    }
    return list;
  }

  function flush() {
    flushTimer = null;
    if (destroyed) return;
    const at = now();
    if (t.ready !== false) {
      while (outbox.length && budget.available(at) >= 1) {
        const list = takeBatch();
        const payload = list.length === 1 ? list[0] : { t: 'many', m: list };
        if (t.send(payload) === false) {
          outbox.unshift(...list);
          stats.deferred += 1;
          break;
        }
        budget.spend(at);
        stats.sends += 1;
      }
      for (const [key, val] of [...pending]) {
        if (budget.available(at) < 1) break;
        const current = t.state ? t.state[key] ?? null : null;
        if (!overlay.has(key) && same(current, val)) {
          pending.delete(key);
          continue;
        }
        const out = key === ROOM && isHost() && val && typeof val === 'object' ? { ...val, at: now() } : val;
        if (t.set(key, out) === false) {
          stats.deferred += 1;
          break;
        }
        budget.spend(at);
        stats.sets += 1;
        pending.delete(key);
        overlay.set(key, { val: out, at });
      }
    }
    if (pending.size || outbox.length) {
      stats.deferred += budget.available(at) < 1 ? 1 : 0;
      scheduleFlush();
    }
    scheduleResend();
  }

  function scheduleResend() {
    if (resendTimer !== null || destroyed || !overlay.size) return;
    let oldest = Infinity;
    for (const entry of overlay.values()) oldest = Math.min(oldest, entry.at);
    resendTimer = setT(resendStale, Math.max(flushMs, oldest + RESEND_MS - now()));
  }

  function resendStale() {
    resendTimer = null;
    if (destroyed) return;
    const at = now();
    for (const [key, entry] of [...overlay]) {
      if (at - entry.at < RESEND_MS) continue;
      overlay.delete(key);
      if (!pending.has(key) && stillMine(key, entry.val)) pending.set(key, entry.val);
    }
    scheduleFlush();
    scheduleResend();
  }

  function stillMine(key, val) {
    if (isHost()) return true;
    const room = read(ROOM);
    const game = room && games.get(room.game);
    return isOpen(game, key) && isJoined(meId()) && writerOk(game, key, slotOf(meId()), val);
  }

  function drop(prefix, test = () => true) {
    let n = 0;
    for (const [key, val] of [...pending]) {
      if (!key.startsWith(prefix) || !test(clone(val))) continue;
      pending.delete(key);
      n += 1;
    }
    for (const [key, entry] of [...overlay]) if (key.startsWith(prefix) && test(clone(entry.val))) overlay.delete(key);
    if (n) changed();
    return n;
  }

  function scheduleDeadline() {
    if (deadlineTimer !== null) {
      clearT(deadlineTimer);
      deadlineTimer = null;
    }
    scheduleLate();
    scheduleAnn();
    if (!isHost() || destroyed) return;
    const at = timerAt(read(ROOM));
    if (at === null) return;
    deadlineTimer = setT(onDeadline, Math.max(0, at - now()));
  }

  function scheduleAnn() {
    if (annTimer !== null) {
      clearT(annTimer);
      annTimer = null;
    }
    if (destroyed) return;
    const a = announceOf(read(ROOM));
    if (!a) return;
    annTimer = setT(() => {
      annTimer = null;
      changed();
    }, Math.max(0, a.until - sharedNow()) + 50);
  }

  function announceOf(room) {
    const a = room && room.ann;
    if (!a || typeof a !== 'object' || !Number.isFinite(a.until) || a.until <= sharedNow()) return null;
    const text = cleanText(a.text);
    return text ? { text, until: a.until } : null;
  }

  function scheduleLate() {
    if (lateTimer !== null) {
      clearT(lateTimer);
      lateTimer = null;
    }
    if (isHost() || destroyed || !hostId()) return;
    const d = timerAt(read(ROOM));
    if (d === null || lateSent === d) return;
    lateTimer = setT(() => {
      lateTimer = null;
      if (destroyed || isHost() || timerAt(read(ROOM)) !== d || lateSent === d) return;
      lateSent = d;
      queueSend({ t: 'late', d });
    }, Math.max(0, d + LATE_MS - sharedNow()));
  }

  function onDeadline() {
    if (deadlineTimer !== null) clearT(deadlineTimer);
    deadlineTimer = null;
    if (!isHost() || destroyed) return;
    const room = read(ROOM);
    if (room && room.phase === 'lobby') {
      onAuto();
      return;
    }
    if (!room || room.phase !== 'game' || typeof room.deadline !== 'number') return;
    if (now() < room.deadline) {
      scheduleDeadline();
      return;
    }
    fireDeadline(games.get(room.game));
  }

  function fireDeadline(game) {
    const room = read(ROOM);
    const before = room ? room.deadline : null;
    try {
      if (game && typeof game.deadline === 'function') game.deadline(gameApi(game));
    } catch (e) {
      fail(e);
    }
    const after = read(ROOM);
    if (after && after.phase === 'game' && after.deadline === before && before !== null) patchRoom({ deadline: null });
    scheduleDeadline();
  }

  function onAuto() {
    const room = read(ROOM);
    if (!room || room.phase !== 'lobby' || !room.auto || typeof room.auto.at !== 'number') return;
    if (now() < room.auto.at) {
      scheduleDeadline();
      return;
    }
    const res = room.auto.g === room.pick ? lobby.start() : { ok: false };
    if (res.ok) return;
    const r = read(ROOM);
    if (r && r.phase === 'lobby' && r.auto) patchRoom({ auto: null });
  }

  function checkAuto() {
    if (!hostOnly()) return;
    const room = read(ROOM);
    if (!room) return;
    const game = games.get(room.pick);
    const spec = room.phase === 'lobby' ? autoOf(game) : null;
    if (!spec || activePlayers().length < spec.min) {
      if (room.auto) patchRoom({ auto: null });
      return;
    }
    if (room.auto && room.auto.g === game.id && typeof room.auto.at === 'number') return;
    const at = now();
    patchRoom({ auto: { g: game.id, from: at, at: at + spec.ms } });
  }

  function patchRoom(p) {
    const room = clone(read(ROOM)) || newRoom(gameList[0] && gameList[0].id);
    write(ROOM, { ...room, ...p });
  }

  function presentList() {
    return people(t.participants);
  }

  function presentIds() {
    return new Set(presentList().map((p) => p.id));
  }

  function playersState() {
    const ps = read(PLAYERS);
    return ps && typeof ps === 'object' && ps.p ? ps : { n: 0, p: {} };
  }

  function slotOf(id) {
    const entry = playersState().p[id];
    return entry ? entry.s : null;
  }

  function idOfSlot(slot) {
    const ps = playersState().p;
    for (const id of Object.keys(ps)) if (ps[id].s === slot) return id;
    return null;
  }

  function trimScores(s, ps) {
    const live = new Set(Object.values(ps.p).map((e) => e.s));
    let cut = false;
    for (const part of [s.g, s.t, s.w]) {
      for (const slot of Object.keys(part)) {
        if (live.has(Number(slot))) continue;
        delete part[slot];
        cut = true;
      }
    }
    return cut;
  }

  function fitScores(s) {
    if (jsonBytes(s) <= MAX_VALUE_BYTES) return;
    const present = new Set(presentList().map((p) => slotOf(p.id)).filter((x) => x !== null));
    const order = Object.keys({ ...s.g, ...s.t, ...s.w })
      .map(Number)
      .filter((slot) => !present.has(slot))
      .sort((a, b) => (s.t[a] || 0) - (s.t[b] || 0) || a - b);
    while (order.length && jsonBytes(s) > MAX_VALUE_BYTES) {
      const slot = order.shift();
      delete s.g[slot];
      delete s.t[slot];
      delete s.w[slot];
    }
  }

  function prune(ps) {
    const present = presentIds();
    const scores = read(SCORES) || newScores();
    const worth = (id) => (scores.t[ps.p[id].s] || 0) + (scores.g[ps.p[id].s] || 0);
    const tier = (id) => {
      if (present.has(id) && ps.p[id].y) return 4;
      return (worth(id) > 0 ? 2 : 0) + (present.has(id) ? 1 : 0);
    };
    const order = Object.keys(ps.p).sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      if (!present.has(a)) return worth(a) - worth(b) || ps.p[a].j - ps.p[b].j;
      return ps.p[b].s - ps.p[a].s;
    });
    while (order.length && (Object.keys(ps.p).length > PLAYER_CAP || jsonBytes(ps) > PLAYERS_BYTES)) delete ps.p[order.shift()];
  }

  function addPlayers(entries) {
    const ps = clone(playersState());
    const added = [];
    let renamed = false;
    for (const { id, name } of entries) {
      if (!id) continue;
      const nm = storedName(name || 'Player');
      const cur = ps.p[id];
      if (cur) {
        if (name && cur.n !== nm) {
          cur.n = nm;
          renamed = true;
        }
        continue;
      }
      ps.p[id] = { s: ps.n, n: nm, j: now(), r: 0 };
      ps.n += 1;
      added.push(id);
    }
    if (!added.length && !renamed) return;
    commitPlayers(ps, renamed || added.some((id) => ps.p[id]));
  }

  function commitPlayers(ps, keep = true) {
    prune(ps);
    const s = clone(read(SCORES));
    if (s && s.g && s.t && s.w && trimScores(s, ps)) write(SCORES, s);
    if (keep) write(PLAYERS, ps);
  }

  function isJoined(id) {
    const e = id ? playersState().p[id] : null;
    return Boolean(e && e.y);
  }

  function setJoined(id, on) {
    const ps = clone(playersState());
    let e = ps.p[id];
    if (!e && on) {
      e = { s: ps.n, n: storedName(nameFor(id) || 'Player'), j: now(), r: 0 };
      ps.p[id] = e;
      ps.n += 1;
    }
    if (!e || Boolean(e.y) === on) return false;
    if (on) {
      e.y = 1;
      e.j = now();
      commitPlayers(ps);
      return Boolean(ps.p[id]);
    }
    delete e.y;
    e.r = 0;
    write(PLAYERS, ps);
    return true;
  }

  function syncPlayers() {
    addPlayers(presentList().map((p) => ({ id: p.id, name: p.name })));
    const present = presentIds();
    if (!present.has(meId())) return false;
    const ps = clone(playersState());
    let cut = false;
    for (const [id, e] of Object.entries(ps.p)) {
      if (!e.y || present.has(id)) continue;
      delete e.y;
      e.r = 0;
      cut = true;
    }
    if (cut) write(PLAYERS, ps);
    return cut;
  }

  function gameRoster() {
    const room = read(ROOM);
    if (!room || room.phase !== 'game') return;
    const game = games.get(room.game);
    if (game && typeof game.roster === 'function') {
      try {
        game.roster(gameApi(game));
      } catch (e) {
        fail(e);
      }
    }
    recheckFlags();
  }

  function lateJoin(id) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game') return;
    const game = games.get(room.game);
    const slot = slotOf(id);
    if (!game || slot === null) return;
    dealLate(slot);
    if (typeof game.join !== 'function') return;
    try {
      game.join(gameApi(game), slot);
    } catch (e) {
      fail(e);
    }
  }

  function nameFor(id) {
    const p = presentList().find((x) => x.id === id);
    return p ? p.name : null;
  }

  function setReady(id, v) {
    const ps = clone(playersState());
    if (!ps.p[id]) return;
    ps.p[id].r = v ? 1 : 0;
    write(PLAYERS, ps);
  }

  function activePlayers() {
    const ps = playersState().p;
    return presentList()
      .filter((p) => ps[p.id] && ps[p.id].y)
      .map((p) => ({ slot: ps[p.id].s, id: p.id, name: ps[p.id].n }))
      .sort((a, b) => a.slot - b.slot);
  }

  function gameApi(game) {
    if (!memory[game.id]) memory[game.id] = {};
    const room = read(ROOM) || {};
    const guard = (key) => {
      if (!ownsKey(game, key)) throw new Error(`${game.id} cannot use the ${key} key`);
    };
    return {
      id: game.id,
      now: sharedNow,
      random,
      settings: settingsFor(game, room),
      memory: memory[game.id],
      players: activePlayers,
      nameOf(slot) {
        const id = idOfSlot(slot);
        return id ? playersState().p[id].n : 'Player';
      },
      get(key) {
        guard(key);
        return clone(read(key));
      },
      put(key, val) {
        guard(key);
        write(key, val);
      },
      keys() {
        return Object.keys(merged()).filter((k) => ownsKey(game, k));
      },
      get deadline() {
        const r = read(ROOM);
        return r ? r.deadline : null;
      },
      setDeadline(at) {
        patchRoom({ deadline: Math.round(at) });
      },
      clearDeadline() {
        patchRoom({ deadline: null });
      },
      shift(ends, ms) {
        return shiftEnd(ends, ms, sharedNow());
      },
      addPoints(slot, n, o) {
        if (!Number.isInteger(slot) || !Number.isFinite(n) || n === 0) return 0;
        let pts = Math.round(n);
        if (pts > 0 && !(o && o.raw)) pts *= multOf(slot, true);
        const s = clone(read(SCORES)) || newScores();
        s.g[slot] = (s.g[slot] || 0) + pts;
        write(SCORES, s);
        noteScore(slot, pts);
        return pts;
      },
      mult(slot) {
        return Number.isInteger(slot) ? multOf(slot, false) : 1;
      },
      round(n, total) {
        roundReport(n, total);
      },
      get final() {
        const f = funState();
        return Boolean(f && f.f);
      },
      say(kind, data) {
        return gameSay(kind, data);
      },
      frozen(slot) {
        const f = funState();
        return Boolean(f && Array.isArray(f.z) && f.z.includes(slot));
      },
      thaw(slot) {
        const f = funState();
        if (!f || !Array.isArray(f.z) || !f.z.includes(slot)) return false;
        patchFun({ z: f.z.filter((x) => x !== slot) });
        return true;
      },
      sameTeams() {
        const f = funState();
        return f && f.tm && typeof f.tm === 'object' ? { ...f.tm } : null;
      },
      party: partyOf(room),
      points() {
        return clone((read(SCORES) || newScores()).g);
      },
      finish(winners) {
        finishGame(game, winners);
      },
    };
  }

  function clearGameKeys(game) {
    if (!game) return;
    const keys = new Set((game.keys || []).slice());
    for (const k of Object.keys(merged())) if (ownsKey(game, k)) keys.add(k);
    for (const k of keys) if (read(k) !== null) write(k, null);
  }

  function gameResults(game) {
    if (!game || typeof game.results !== 'function') return {};
    try {
      const r = game.results(gameApi(game));
      return r && typeof r === 'object' ? r : {};
    } catch (e) {
      fail(e);
      return {};
    }
  }

  function partyPlayers(points, win, teams) {
    const slots = new Set(activePlayers().map((p) => p.slot));
    for (const [slot, pts] of Object.entries(points || {})) if (Number(pts)) slots.add(Number(slot));
    const out = [];
    for (const slot of [...slots].filter(Number.isInteger).sort((a, b) => a - b)) {
      const id = idOfSlot(slot);
      if (!id || !USER_RE.test(id)) continue;
      const p = personFor(id);
      const team = teams && typeof teams[slot] === 'string' ? clip(teams[slot], 24) || null : null;
      out.push({ slot, id, name: p.name, username: p.username, score: Math.round(Number(points[slot]) || 0), won: win.includes(slot), team });
    }
    return out.sort((a, b) => b.score - a.score || a.slot - b.slot).slice(0, RESULT_MAX_PLAYERS);
  }

  function partySkills(info, players) {
    const raw = info && info.skills && typeof info.skills === 'object' && !Array.isArray(info.skills) ? info.skills : {};
    const half = Array.isArray(fm.half) ? fm.half : [];
    const out = {};
    for (const p of players) {
      const got = raw[p.slot] && typeof raw[p.slot] === 'object' ? raw[p.slot] : {};
      const skill = {};
      for (const [key, cap] of SKILL_CAPS) {
        const n = Math.floor(Number(got[key]) || 0);
        if (n > 0) skill[key] = Math.min(n, cap);
      }
      if (p.won && half.includes(p.slot)) skill.c = 1;
      if (Object.keys(skill).length) out[p.id] = skill;
    }
    return out;
  }

  function partyExtra(raw, players) {
    const bySlot = new Map(players.map((p) => [p.slot, p.id]));
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, list] of Object.entries(raw)) {
      if (Object.keys(out).length >= RESULT_EXTRA_KEYS) break;
      if (!EXTRA_KEY_RE.test(k) || !Array.isArray(list)) continue;
      const ids = [...new Set(list.map((s) => bySlot.get(s)).filter(Boolean))];
      if (ids.length) out[k] = ids;
    }
    return out;
  }

  function postParty(game, players, info, at, trn, preds) {
    if (players.length < RESULT_MIN_PLAYERS) return false;
    const extra = partyExtra(info.extra, players);
    if (trn && trn.done && Number.isInteger(trn.champ)) {
      const champ = players.find((p) => p.slot === trn.champ);
      if (champ) extra.tournament = { winner: champ.id };
    }
    const skills = partySkills(info, players);
    if (Object.keys(skills).length) {
      extra.skills = skills;
      const qn = Math.floor(Number(info.questions) || 0);
      if (qn > 0) extra.questions = Math.min(qn, SKILL_QUESTIONS_MAX);
    }
    const body = { game: game.id, at, players: players.map(({ slot, ...p }) => p), extra };
    const ids = new Set(players.map((p) => p.id));
    const picks = [];
    for (const x of preds) {
      if (picks.length >= PREDICT_MAX) break;
      const pick = idOfSlot(x.slot);
      if (!pick || !ids.has(pick) || ids.has(x.id)) continue;
      const who = personFor(x.id);
      picks.push({ id: x.id, name: who.name, username: who.username, pick, right: x.right });
    }
    if (picks.length) body.predictions = picks;
    try {
      Promise.resolve(postResults(body)).catch(() => false);
    } catch {}
    return true;
  }

  function tourStep(room, game, players) {
    const trn = tourOf(room);
    if (!trn || trn.done || trn.g[trn.i] !== game.id) return null;
    const place = placementPoints(players);
    const pts = { ...(trn.pts || {}) };
    const f = { ...(trn.f || {}) };
    for (const [slot, n] of Object.entries(place)) {
      pts[slot] = (pts[slot] || 0) + n;
      if (n === PLACE_POINTS[0]) f[slot] = (f[slot] || 0) + 1;
    }
    const next = { ...trn, pts, f, lp: place };
    if (trn.i >= trn.g.length - 1) {
      next.done = 1;
      next.champ = championOf(pts, f, place);
    }
    return next;
  }

  function settlePicks(room, game, players, win, at) {
    const pr = read(PRED);
    if (!pr || typeof pr !== 'object' || pr.r !== room.round || pr.g !== game.id) return [];
    const playing = new Set(players.map((p) => p.id).concat(activePlayers().map((p) => p.id)));
    const kept = Object.entries(pr.p && typeof pr.p === 'object' ? pr.p : {}).filter(([id, slot]) => USER_RE.test(id) && Number.isInteger(slot) && !playing.has(id));
    if (!kept.length && !Object.keys(pr.p && typeof pr.p === 'object' ? pr.p : {}).length) return [];
    write(PRED, { ...pr, until: Math.min(Number(pr.until) || at, at), p: Object.fromEntries(kept), w: win, x: 1 });
    return kept.map(([id, slot]) => ({ id, slot, right: win.includes(slot) }));
  }

  function openPicks(round, game) {
    const playing = activePlayers();
    const ids = new Set(playing.map((p) => p.id));
    const watchers = presentList().filter((p) => !ids.has(p.id));
    if (playing.length < RESULT_MIN_PLAYERS || !watchers.length) {
      if (read(PRED) !== null) write(PRED, null);
      return;
    }
    const at = now();
    write(PRED, { r: round, g: game.id, from: at, until: at + PREDICT_MS, p: {} });
  }

  function predictPick(from, data) {
    const room = read(ROOM);
    const pr = read(PRED);
    if (!room || room.phase !== 'game' || !pr || pr.x || pr.r !== room.round || data.r !== room.round) return false;
    if (now() >= pr.until || !USER_RE.test(from)) return false;
    if (!presentIds().has(from) || isJoined(from) || isBanned(from) || partyBanned(from)) return false;
    const own = slotOf(from);
    if (own !== null && outSlots(room).includes(own)) return false;
    const slot = data.p;
    if (!Number.isInteger(slot) || !activePlayers().some((p) => p.slot === slot)) return false;
    const picks = { ...(pr.p && typeof pr.p === 'object' ? pr.p : {}) };
    if (!(from in picks) && Object.keys(picks).length >= PREDICT_MAX) return false;
    if (picks[from] === slot) return true;
    picks[from] = slot;
    write(PRED, { ...pr, p: picks });
    return true;
  }

  function finishGame(game, winners) {
    const s = clone(read(SCORES)) || newScores();
    const room = read(ROOM) || {};
    const out = outSlots(room);
    for (const slot of out) delete s.g[slot];
    const win = (Array.isArray(winners) ? winners.filter((x) => Number.isInteger(x)) : topSlots(s.g)).filter((x) => !out.includes(x));
    const info = gameResults(game);
    const at = now();
    const players = partyPlayers(s.g, win, info.teams);
    const trn = tourStep(room, game, players);
    const preds = settlePicks(room, game, players, win, at);
    const counted = postParty(game, players, info, at, trn, preds);
    for (const [slot, pts] of Object.entries(s.g)) s.t[slot] = (s.t[slot] || 0) + pts;
    for (const slot of win) s.w[slot] = (s.w[slot] || 0) + 1;
    fitScores(s);
    write(SCORES, s);
    const last = { game: game.id, winners: win, at };
    if (counted) last.ps = players.map((p) => p.slot);
    if (counted && trn && trn.done && Number.isInteger(trn.champ) && last.ps.includes(trn.champ)) last.champ = trn.champ;
    if (typeof info.daily === 'string' && DAY_RE.test(info.daily)) last.daily = info.daily;
    const note = clip(info.note, NOTE_MAX);
    if (note) last.note = note;
    try {
      endFun(game, s.g, win, info);
    } catch (e) {
      fail(e);
    }
    const patch = { phase: 'results', deadline: null, flags: null, last };
    if (trn) patch.trn = trn;
    patchRoom(patch);
  }

  function handleIntent(from, data, depth = 0) {
    if (!isHost() || !from || !data || typeof data !== 'object' || typeof data.t !== 'string') return;
    const known = presentIds().has(from) || Boolean(playersState().p[from]);
    if (!known) return;
    try {
      if (data.t === 'many') {
        if (depth === 0 && Array.isArray(data.m)) for (const x of data.m.slice(0, MAX_BATCH)) handleIntent(from, x, 1);
      } else if (data.t === 'late') {
        const at = timerAt(read(ROOM));
        if (at !== null && now() >= at) onDeadline();
      } else if (data.t === 'flag') {
        const room = read(ROOM);
        if (!room || room.phase !== 'game' || data.g !== room.game || !validDrawing(data.d)) return;
        if (!isJoined(from) || !presentIds().has(from)) return;
        const slot = slotOf(from);
        if (slot === null) return;
        flagDrawing(games.get(room.game), data.d, slot);
      } else if (data.t === 'rpt') {
        reportText(from, data);
      } else if (data.t === 'pick') {
        predictPick(from, data);
      } else if (data.t === 'card') {
        playCard(from, data);
      } else if (data.t === 'in') {
        if (!presentIds().has(from) || isBanned(from) || partyBanned(from)) return;
        const room = read(ROOM);
        if (room && room.lock && !isJoined(from)) {
          checkAdmin(from, (ok) => {
            if (ok) joinNow(from);
          });
          return;
        }
        joinNow(from);
      } else if (data.t === 'adm') {
        const a = cleanAdminAction(data.a);
        if (!a) return;
        checkAdmin(from, (ok) => {
          if (ok) runAdmin(from, a);
        });
      } else if (data.t === 'out') {
        if (setJoined(from, false)) {
          gameRoster();
          checkAuto();
        }
      } else if (data.t === 'ready') {
        addPlayers([{ id: from, name: nameFor(from) }]);
        setReady(from, Boolean(data.v));
      } else if (data.t === 'g') {
        const room = read(ROOM);
        if (!room || room.phase !== 'game' || data.g !== room.game) return;
        const game = games.get(room.game);
        if (!game || typeof game.intent !== 'function') return;
        if (!isJoined(from) || !presentIds().has(from)) return;
        const slot = slotOf(from);
        if (slot === null) return;
        game.intent(gameApi(game), slot, data.a && typeof data.a === 'object' ? data.a : {});
      }
    } catch (e) {
      fail(e);
    }
  }

  function joinNow(id) {
    if (!isHost() || destroyed || !presentIds().has(id) || isBanned(id) || partyBanned(id)) return;
    if (!joinOpen(id)) return;
    if (setJoined(id, true)) {
      lateJoin(id);
      checkAuto();
    }
  }

  function outSlots(room) {
    return room && Array.isArray(room.out) ? room.out.filter((s) => Number.isInteger(s)) : [];
  }

  function joinOpen(id) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || isJoined(id)) return true;
    if (room.nolate) return false;
    const slot = slotOf(id);
    return slot === null || !outSlots(room).includes(slot);
  }

  function isBanned(id) {
    const room = read(ROOM);
    return Boolean(id && room && Array.isArray(room.ban) && room.ban.includes(id));
  }

  function partyBanned(id) {
    try {
      return Boolean(id) && typeof admins.banned === 'function' && Boolean(admins.banned(id));
    } catch {
      return false;
    }
  }

  function enforceBans() {
    if (!hostOnly()) return;
    try {
      for (const p of activePlayers()) if (partyBanned(p.id)) kick(p.id);
    } catch (e) {
      fail(e);
    }
  }

  function drawingsOf(game) {
    if (!game || typeof game.drawings !== 'function') return [];
    let list = [];
    try {
      list = game.drawings(gameApi(game));
    } catch (e) {
      fail(e);
      return [];
    }
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && validDrawing(x.d) && Number.isInteger(x.drawer))
      .map((x) => ({ d: x.d, drawer: x.drawer, viewers: viewerSet(x.viewers) }));
  }

  function hideDrawing(game, item, why) {
    if (!game || typeof game.admin !== 'function') return false;
    try {
      return Boolean(game.admin(gameApi(game), { type: 'hideDrawing', d: item.d, drawer: item.drawer, why }));
    } catch (e) {
      fail(e);
      return false;
    }
  }

  function flaggers(item) {
    return activePlayers()
      .map((p) => p.slot)
      .filter((s) => s !== item.drawer && (!item.viewers || item.viewers.has(s)));
  }

  function checkFlag(game, item) {
    const by = flagsIn(read(ROOM))[item.d];
    if (!Array.isArray(by)) return false;
    const live = flaggers(item);
    const count = by.filter((s) => live.includes(s)).length;
    if (count < flagNeed(live.length)) return false;
    return hideDrawing(game, item, 'flags');
  }

  function flagDrawing(game, d, slot) {
    const list = drawingsOf(game);
    const item = list.find((x) => x.d === d);
    if (!item || item.drawer === slot || (item.viewers && !item.viewers.has(slot))) return false;
    const flags = flagsIn(read(ROOM));
    const by = Array.isArray(flags[d]) ? flags[d].filter((s) => Number.isInteger(s)) : [];
    if (by.includes(slot)) return false;
    const room = read(ROOM) || {};
    const mod = adminOk(idOfSlot(slot));
    const used = flagsUsed(room, slot);
    if (!mod && used >= FLAG_CAP) return false;
    const live = new Set(list.map((x) => x.d));
    const kept = Object.entries(flags)
      .filter(([k, v]) => k !== d && live.has(k) && Array.isArray(v))
      .slice(-(FLAG_KEEP - 1));
    const fc = room.fc && room.fc.r === room.round && room.fc.n && typeof room.fc.n === 'object' ? room.fc.n : {};
    patchRoom({ flags: Object.fromEntries(kept.concat([[d, by.concat([slot])]])), fc: { r: room.round, n: { ...fc, [slot]: used + 1 } } });
    if (mod) return hideDrawing(game, item, 'admin') || true;
    checkFlag(game, item);
    return true;
  }

  function textsOf(game) {
    if (!game || typeof game.texts !== 'function') return [];
    let list = [];
    try {
      list = game.texts(gameApi(game));
    } catch (e) {
      fail(e);
      return [];
    }
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && validTextRef(x.r) && Number.isInteger(x.author) && typeof x.text === 'string')
      .map((x) => ({ r: x.r, author: x.author, text: clip(x.text, TEXT_REPORT_CHARS), context: clip(x.context, TEXT_CONTEXT_CHARS) || null, viewers: viewerSet(x.viewers) }))
      .filter((x) => x.text);
  }

  function personFor(id) {
    const live = presentList().find((p) => p.id === id);
    const entry = playersState().p[id];
    const name = live ? live.name : entry && entry.n ? entry.n : 'Player';
    const look = live || person({ id, name }) || {};
    return { id, name, username: look.username || null };
  }

  function textMark(room, r) {
    return `${room.round || 0}|${room.game}|${r}`;
  }

  function reportText(from, data) {
    const room = read(ROOM);
    if (!room || data.g !== room.game || !validTextRef(data.r)) return false;
    const fromReel = HL_RE.test(data.r);
    if (room.phase !== (fromReel ? 'results' : 'game')) return false;
    if (!presentIds().has(from) || partyBanned(from)) return false;
    const slot = slotOf(from);
    if (slot === null || slot === undefined) return false;
    const game = games.get(room.game);
    if (!game) return false;
    const item = fromReel ? reelItem(data.r) : textsOf(game).find((x) => x.r === data.r);
    if (!item || item.author === slot || (item.viewers && !item.viewers.has(slot))) return false;
    const authorId = idOfSlot(item.author);
    if (!authorId || authorId === from) return false;
    const mark = `${textMark(room, data.r)}|${from}`;
    if (textSeen.has(mark)) return false;
    const at = now();
    const times = (textTimes.get(from) || []).filter((x) => at - x < TEXT_REPORT_WINDOW_MS);
    if (times.length >= TEXT_REPORT_LIMIT) {
      textTimes.set(from, times);
      return false;
    }
    textSeen.add(mark);
    while (textSeen.size > TEXT_REPORT_KEEP) textSeen.delete(textSeen.values().next().value);
    textTimes.delete(from);
    textTimes.set(from, times.concat([at]));
    while (textTimes.size > TEXT_REPORT_KEEP) textTimes.delete(textTimes.keys().next().value);
    const me = personFor(from);
    const body = { kind: 'text', game: game.id, author: personFor(authorId), reporter: { id: me.id, name: me.name }, text: item.text, context: item.context, at };
    try {
      Promise.resolve(postText(body)).catch(() => false);
    } catch {}
    return true;
  }

  function recheckFlags() {
    const room = read(ROOM);
    if (!room || room.phase !== 'game') return;
    const flags = flagsIn(room);
    if (!Object.keys(flags).length) return;
    const game = games.get(room.game);
    for (const item of drawingsOf(game)) {
      if (!Array.isArray(flags[item.d])) continue;
      if (checkFlag(game, item)) return;
    }
  }

  function ownerOf() {
    try {
      const o = admins.ownerId();
      return typeof o === 'string' && o ? o : null;
    } catch {
      return null;
    }
  }

  function adminOk(id) {
    try {
      return Boolean(id) && Boolean(admins.isAdmin(id));
    } catch {
      return false;
    }
  }

  function checkAdmin(id, fn) {
    const run = (ok) => {
      if (destroyed) return;
      try {
        fn(ok);
      } catch (e) {
        fail(e);
      }
    };
    if (adminOk(id)) return run(true);
    let known = true;
    try {
      known = Boolean(admins.knows(id));
    } catch {
      known = true;
    }
    if (known || typeof admins.refresh !== 'function') return run(false);
    let wait;
    try {
      wait = Promise.resolve(admins.refresh([id]));
    } catch {
      wait = Promise.resolve(false);
    }
    wait.catch(() => false).then(() => run(adminOk(id)));
    return undefined;
  }

  function shielded(from, id) {
    const owner = ownerOf();
    return Boolean(owner && id === owner && from !== owner);
  }

  function targetOf(a) {
    if (typeof a.id === 'string') return a.id;
    return Number.isInteger(a.slot) ? idOfSlot(a.slot) : null;
  }

  function gameAdmin(a) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game') return false;
    const game = games.get(room.game);
    if (!game) return false;
    if (typeof game.admin === 'function') return Boolean(game.admin(gameApi(game), { ...a }));
    if (a.type === 'skip') {
      if (typeof game.deadline !== 'function') return false;
      fireDeadline(game);
      return true;
    }
    if (typeof room.deadline !== 'number') return false;
    patchRoom({ deadline: shiftEnd(room.deadline, a.ms, now()) });
    return true;
  }

  function kick(id) {
    if (!setJoined(id, false)) return false;
    gameRoster();
    checkAuto();
    return true;
  }

  function runAdmin(from, a) {
    if (!isHost() || destroyed || !adminOk(from)) return false;
    const room = read(ROOM);
    if (!room) return false;
    if (a.type === 'start') return lobby.start().ok;
    if (a.type === 'end') return room.phase === 'lobby' ? false : lobby.toLobby();
    if (a.type === 'skip') return gameAdmin(a);
    if (a.type === 'time') {
      if (room.phase === 'lobby' && room.auto && typeof room.auto.at === 'number') {
        patchRoom({ auto: { ...room.auto, at: shiftEnd(room.auto.at, a.ms, now()) } });
        return true;
      }
      return gameAdmin(a);
    }
    if (a.type === 'lock') {
      patchRoom({ lock: a.on });
      return true;
    }
    if (a.type === 'announce') {
      patchRoom({ ann: a.text ? { text: a.text, until: now() + ANNOUNCE_MS } : null });
      return true;
    }
    if (a.type === 'clearDrawing') {
      if (room.phase !== 'game') return false;
      const game = games.get(room.game);
      const list = drawingsOf(game);
      const item = a.d ? list.find((x) => x.d === a.d) : list[list.length - 1];
      return item ? hideDrawing(game, item, 'admin') : false;
    }
    const id = targetOf(a);
    if (!id || shielded(from, id)) return false;
    if (a.type === 'unban') {
      const list = Array.isArray(room.ban) ? room.ban : [];
      if (!list.includes(id)) return false;
      patchRoom({ ban: list.filter((x) => x !== id) });
      return true;
    }
    if (a.type === 'ban') {
      const list = (Array.isArray(room.ban) ? room.ban : []).filter((x) => x !== id && typeof x === 'string');
      patchRoom({ ban: list.concat([id]).slice(-BAN_MAX) });
      kick(id);
      return true;
    }
    if (a.type === 'kick') return kick(id);
    if (a.type === 'points') {
      const slot = slotOf(id);
      if (slot === null || room.phase !== 'game') return false;
      const s = clone(read(SCORES)) || newScores();
      s.g[slot] = (s.g[slot] || 0) + a.n;
      write(SCORES, s);
      dramaSoon();
      return true;
    }
    return false;
  }

  function fxAllowed(fx, by) {
    if (!adminOk(by)) return false;
    const owner = ownerOf();
    if (!owner || by === owner) return true;
    if (fx.target === owner) return false;
    if (fx.target === null && TROLL_FX.includes(fx.fx) && meId() === owner) return false;
    return true;
  }

  function fxRate(by) {
    const at = now();
    const last = fxSeen.get(by);
    if (last !== undefined && at >= last && at - last < FX_GAP_MS) return false;
    fxSeen.delete(by);
    fxSeen.set(by, at);
    while (fxSeen.size > 100) fxSeen.delete(fxSeen.keys().next().value);
    return true;
  }

  function receiveFx(raw, by) {
    const fx = cleanFx(raw);
    if (!fx || !by || by === meId()) return;
    checkAdmin(by, (ok) => {
      if (!ok || !fxAllowed(fx, by) || !fxRate(by)) return;
      emit('fx', { ...fx, by });
    });
  }

  function ensureCore() {
    const room = read(ROOM);
    if (!room || room.v !== 1) write(ROOM, newRoom(gameList[0] && gameList[0].id));
    const s = read(SCORES);
    if (!s || !s.g || !s.t || !s.w) write(SCORES, newScores());
    if (!read(PLAYERS)) write(PLAYERS, { n: 0, p: {} });
  }

  function becomeHost() {
    hosting = true;
    memory = {};
    resetFunMem();
    try {
      ensureCore();
      syncPlayers();
      const room = read(ROOM);
      if (room.phase === 'game') {
        const game = games.get(room.game);
        if (!game) patchRoom({ phase: 'lobby', game: null, deadline: null });
        else if (typeof game.resume === 'function') game.resume(gameApi(game));
      }
      checkAuto();
    } catch (e) {
      fail(e);
    }
    enforceBans();
    scheduleDeadline();
    emit('host', { me: true });
  }

  function loseHost() {
    hosting = false;
    memory = {};
    stopFunTimers();
    for (const k of [...pending.keys()]) pending.delete(k);
    scheduleDeadline();
    emit('host', { me: false });
  }

  function onRoster() {
    const h = hostId();
    if (h !== lastHost) {
      lastHost = h;
      if (isHost()) becomeHost();
      else if (hosting) loseHost();
      pushWant();
    } else if (isHost()) {
      try {
        syncPlayers();
        gameRoster();
        checkAuto();
      } catch (e) {
        fail(e);
      }
    } else if (want) {
      pushWant();
    }
    changed();
  }

  function trustAll() {
    trusted.clear();
    for (const [k, v] of Object.entries(t.state || {})) if (v !== null && v !== undefined) trusted.set(k, v);
  }

  function onReady() {
    readySeen = true;
    trustAll();
    lastHost = hostId();
    if (isHost()) becomeHost();
    pushWant();
    scheduleDeadline();
    changed();
  }

  function onInit() {
    if (!readySeen) return onReady();
    overlay.clear();
    trustAll();
    const h = hostId();
    const moved = h !== lastHost;
    lastHost = h;
    if (isHost() && (moved || !hosting)) becomeHost();
    else if (isHost()) {
      try {
        ensureCore();
        syncPlayers();
        checkAuto();
      } catch (e) {
        fail(e);
      }
      scheduleDeadline();
    } else {
      if (hosting) loseHost();
      scheduleDeadline();
    }
    pushWant();
    changed();
    return undefined;
  }

  function isOpen(game, key) {
    return Boolean(game) && ownsKey(game, key) && (game.open || []).some((p) => key.startsWith(p));
  }

  function writerOk(game, key, slot, value) {
    if (typeof game.writer !== 'function') return true;
    try {
      return Boolean(game.writer((k) => clone(read(k)), key, slot, value));
    } catch {
      return false;
    }
  }

  function allowed(key, value, from) {
    if (!from || from === hostId()) return true;
    const room = read(ROOM);
    const game = room && games.get(room.game);
    if (!isOpen(game, key) || !isJoined(from)) return false;
    return writerOk(game, key, slotOf(from), value);
  }

  function repair(key) {
    if (pending.has(key)) return;
    const want = overlay.has(key) ? overlay.get(key).val : shared(key);
    overlay.delete(key);
    pending.set(key, want);
    scheduleFlush();
  }

  function onState({ key, value, by }) {
    const from = idOf(by);
    const val = value === undefined ? null : value;
    if (!allowed(key, val, from)) {
      if (from && from === meId()) overlay.delete(key);
      if (isHost()) repair(key);
      changed();
      return;
    }
    if (val === null) trusted.delete(key);
    else trusted.set(key, val);
    if (key === ROOM && from && from === hostId() && !isHost() && val && Number.isFinite(val.at)) {
      const gap = val.at - now();
      if (Math.abs(gap) < 864e5) skew = gap;
    }
    if (overlay.has(key)) {
      const mine = overlay.get(key).val;
      if (same(mine, val) || (from && from !== meId())) overlay.delete(key);
    }
    if (key === ROOM) scheduleDeadline();
    if (key === PLAYERS) settleWant();
    changed();
  }

  function settleWant() {
    if (!want || isJoined(meId()) !== (want === 'in')) return;
    want = null;
    wantTries = 0;
    if (wantTimer !== null) clearT(wantTimer);
    wantTimer = null;
  }

  function pushWant() {
    if (!want || destroyed || !readySeen || !meId()) return;
    settleWant();
    if (!want) return;
    if (isHost()) {
      const w = want;
      want = null;
      wantTries = 0;
      handleIntent(meId(), { t: w });
      changed();
      return;
    }
    try {
      queueSend({ t: want });
    } catch (e) {
      fail(e);
    }
    if (wantTimer !== null) clearT(wantTimer);
    wantTimer = setT(() => {
      wantTimer = null;
      if (!want || destroyed) return;
      wantTries += 1;
      if (wantTries >= WANT_TRIES) {
        want = null;
        wantTries = 0;
        changed();
        return;
      }
      pushWant();
    }, WANT_MS);
  }

  function setWant(w) {
    if (destroyed) return false;
    want = w;
    wantTries = 0;
    pushWant();
    changed();
    return true;
  }

  function onMessage({ data, by }) {
    const from = idOf(by);
    emit('message', { data, by: from });
    if (data && typeof data === 'object') {
      const list = data.t === 'many' && Array.isArray(data.m) ? data.m.slice(0, MAX_BATCH) : [data];
      for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        if (x.t === 'fx') receiveFx(x, from);
        else if (x.t === 're') receiveReact(x, from);
        else if (x.t === 'pm') receivePm(x, from);
      }
    }
    if (isHost()) handleIntent(from, data);
  }

  function hostOnly() {
    return isHost() && !destroyed;
  }

  function startGame(game, patch = {}, extra = {}) {
    const room = read(ROOM);
    if (!game) return { ok: false, reason: 'no_game' };
    const min = game.minPlayers || 1;
    if (activePlayers().length < min) return { ok: false, reason: 'players', need: min };
    try {
      for (const g of gameList) clearGameKeys(g);
      const s = clone(read(SCORES)) || newScores();
      s.g = {};
      write(SCORES, s);
      memory[game.id] = {};
      const round = (room.round || 0) + 1;
      const before = read(FUN);
      const keep = extra && extra.sameTeams && before && before.lt && typeof before.lt === 'object' ? before.lt : null;
      patchRoom({ phase: 'game', game: game.id, pick: game.id, deadline: null, round, last: null, auto: null, flags: null, out: null, ...patch });
      startFun(game, round, keep);
      openPicks(round, game);
      game.start(gameApi(game));
    } catch (e) {
      fail(e);
      return { ok: false, reason: 'error' };
    }
    return { ok: true };
  }

  function nextTour(trn) {
    const i = trn.i + 1;
    const count = activePlayers().length;
    let game = games.get(trn.g[i]);
    const list = trn.g.slice();
    if (game && (game.minPlayers || 1) > count) {
      const spare = shuffle(gameList.filter((g) => g && (g.minPlayers || 1) <= count && !list.includes(g.id)), random)[0];
      if (spare) {
        list[i] = spare.id;
        game = spare;
      }
    }
    if (!game) {
      patchRoom({ trn: null });
      return { ok: false, reason: 'no_game' };
    }
    return startGame(game, { trn: { ...trn, g: list, i, lp: null } });
  }

  function clearPicks() {
    myPick = null;
    if (read(PRED) !== null) write(PRED, null);
  }

  const lobby = {
    pick(id) {
      if (!hostOnly() || !games.has(id)) return false;
      const room = read(ROOM);
      if (!room || room.phase === 'game') return false;
      patchRoom({ pick: id });
      checkAuto();
      return true;
    },
    setting(id, value) {
      if (!hostOnly()) return false;
      const room = clone(read(ROOM));
      if (!room || room.phase === 'game') return false;
      const game = games.get(room.pick);
      const spec = game && (game.settings || []).find((s) => s.id === id);
      const v = cleanSetting(spec, value);
      if (v === undefined) return false;
      const opts2 = { ...(room.opts || {}) };
      opts2[game.id] = { ...settingsFor(game, room), [id]: v };
      patchRoom({ opts: opts2 });
      return true;
    },
    start(o = {}) {
      if (!hostOnly()) return { ok: false, reason: 'not_host' };
      const room = read(ROOM);
      if (!room || room.phase === 'game') return { ok: false, reason: 'busy' };
      const trn = tourOf(room);
      if (trn && !trn.done && room.phase === 'results') return nextTour(trn);
      const cfg = cleanTour(room.tour, games);
      if (cfg) {
        const list = pickTourGames(gameList, cfg.g, activePlayers().length, random);
        if (!list) return { ok: false, reason: 'tour' };
        const first = games.get(list[0]);
        return startGame(first, { trn: { g: list, i: 0, pts: {}, f: {} } });
      }
      const game = games.get(room.pick);
      if (!game) return { ok: false, reason: 'no_game' };
      return startGame(game, { trn: null }, { sameTeams: Boolean(o && o.sameTeams) });
    },
    party(id, on) {
      if (!hostOnly() || !PARTY_IDS.includes(id)) return false;
      const room = read(ROOM);
      if (!room || room.phase === 'game') return false;
      patchRoom({ px: partyPatch(room, id, Boolean(on)) });
      return true;
    },
    next() {
      if (!hostOnly()) return { ok: false, reason: 'not_host' };
      const room = read(ROOM);
      const trn = tourOf(room);
      if (!room || room.phase !== 'results' || !trn || trn.done) return { ok: false, reason: 'busy' };
      return nextTour(trn);
    },
    tournament(cfg) {
      if (!hostOnly()) return false;
      const room = read(ROOM);
      if (!room || room.phase === 'game') return false;
      const tour = cfg ? cleanTour(cfg === true ? { g: [] } : cfg, games) : null;
      patchRoom({ tour });
      checkAuto();
      return true;
    },
    remove(x) {
      if (!hostOnly()) return false;
      const room = read(ROOM);
      if (!room || room.phase !== 'game') return false;
      const id = typeof x === 'string' ? x : Number.isInteger(x) ? idOfSlot(x) : null;
      if (!id || id === meId() || !isJoined(id) || shielded(meId(), id)) return false;
      const slot = slotOf(id);
      patchRoom({ out: outSlots(room).filter((s) => s !== slot).concat([slot]).slice(-OUT_MAX) });
      return kick(id);
    },
    lateLock(on) {
      if (!hostOnly()) return false;
      patchRoom({ nolate: on ? 1 : null });
      return true;
    },
    applyPreset(p) {
      if (!hostOnly() || !p || typeof p !== 'object') return false;
      const room = clone(read(ROOM));
      if (!room || room.phase === 'game') return false;
      const game = games.get(p.game);
      if (!game) return false;
      const set = settingsFor(game, room);
      const src = p.settings && typeof p.settings === 'object' ? p.settings : {};
      for (const spec of game.settings || []) {
        const v = cleanSetting(spec, src[spec.id]);
        if (v !== undefined) set[spec.id] = v;
      }
      const patch = { pick: game.id, opts: { ...(room.opts || {}), [game.id]: set } };
      if (p.tour !== undefined) patch.tour = p.tour ? cleanTour(p.tour, games) : null;
      patchRoom(patch);
      checkAuto();
      return true;
    },
    end() {
      if (!hostOnly()) return false;
      const room = read(ROOM);
      if (!room || room.phase !== 'game') return false;
      const game = games.get(room.game);
      if (game) finishGame(game);
      return true;
    },
    toLobby() {
      if (!hostOnly()) return false;
      for (const g of gameList) clearGameKeys(g);
      clearPicks();
      clearFun();
      patchRoom({ phase: 'lobby', game: null, deadline: null, auto: null, flags: null, trn: null, out: null });
      checkAuto();
      return true;
    },
    reset() {
      if (!hostOnly()) return false;
      for (const g of gameList) clearGameKeys(g);
      clearPicks();
      clearFun();
      write(SCORES, newScores());
      patchRoom({ phase: 'lobby', game: null, deadline: null, last: null, auto: null, flags: null, trn: null, out: null });
      checkAuto();
      return true;
    },
  };

  const admin = {
    me() {
      return adminOk(meId());
    },
    owner() {
      return ownerOf();
    },
    run(action) {
      if (destroyed || !adminOk(meId())) return false;
      const a = cleanAdminAction(action);
      if (!a) return false;
      if (isHost()) {
        handleIntent(meId(), { t: 'adm', a });
        return true;
      }
      return broadcast({ t: 'adm', a });
    },
    fx(name, o = {}) {
      const me = meId();
      if (destroyed || !adminOk(me)) return false;
      const opt = o && typeof o === 'object' ? o : {};
      const fx = cleanFx({ fx: name, target: opt.target === undefined ? null : opt.target, ms: opt.ms, extra: opt.extra });
      if (!fx || !fxAllowed(fx, me) || !fxRate(me)) return false;
      if (!broadcast({ t: 'fx', ...fx })) return false;
      emit('fx', { ...fx, by: me });
      return true;
    },
  };

  function ready(v) {
    const id = meId();
    if (!id) return;
    if (isHost()) {
      addPlayers([{ id, name: nameFor(id) }]);
      setReady(id, v);
    } else {
      queueSend({ t: 'ready', v: Boolean(v) });
    }
  }

  function join() {
    if (partyBanned(meId())) return false;
    return setWant('in');
  }

  function flag(d) {
    const room = read(ROOM);
    if (destroyed || !room || room.phase !== 'game' || !validDrawing(d) || !isJoined(meId())) return false;
    const own = slotOf(meId());
    if (own !== null && !adminOk(meId()) && flagsUsed(room, own) >= FLAG_CAP) return false;
    const msg = { t: 'flag', g: room.game, d };
    if (isHost()) {
      handleIntent(meId(), msg);
      return true;
    }
    return broadcast(msg);
  }

  function report(r) {
    const room = read(ROOM);
    const id = meId();
    if (destroyed || !room || !validTextRef(r) || !id || slotOf(id) === null) return 'no';
    if (room.phase !== (HL_RE.test(r) ? 'results' : 'game')) return 'no';
    const mark = textMark(room, r);
    if (myReports.has(mark)) return 'done';
    const at = now();
    myTimes = myTimes.filter((x) => at - x < TEXT_REPORT_WINDOW_MS);
    if (myTimes.length >= TEXT_REPORT_LIMIT) return 'slow';
    const msg = { t: 'rpt', g: room.game, r };
    const ok = isHost() ? reportText(id, msg) : broadcast(msg);
    if (!ok) return 'no';
    myReports.add(mark);
    while (myReports.size > TEXT_REPORT_KEEP) myReports.delete(myReports.values().next().value);
    myTimes.push(at);
    return 'sent';
  }

  function canReport() {
    const room = read(ROOM);
    const id = meId();
    return Boolean(!destroyed && room && (room.phase === 'game' || room.phase === 'results') && id && slotOf(id) !== null);
  }

  function reported(r) {
    const room = read(ROOM);
    return Boolean(room && validTextRef(r) && myReports.has(textMark(room, r)));
  }

  function leave() {
    return setWant('out');
  }

  function predict(slot) {
    const room = read(ROOM);
    const pr = read(PRED);
    const id = meId();
    if (destroyed || !id || !room || room.phase !== 'game' || !pr || pr.x || pr.r !== room.round || !Number.isInteger(slot)) return false;
    if (isJoined(id) || sharedNow() >= pr.until) return false;
    const own = slotOf(id);
    if (own !== null && outSlots(room).includes(own)) return false;
    const msg = { t: 'pick', r: room.round, p: slot };
    if (isHost()) return predictPick(id, msg);
    if (!broadcast(msg)) return false;
    myPick = { r: room.round, p: slot };
    changed();
    return true;
  }

  function predictView(room, list, me) {
    const pr = read(PRED);
    if (!pr || typeof pr !== 'object' || pr.r !== room.round || (room.phase !== 'game' && room.phase !== 'results')) return null;
    const picks = pr.p && typeof pr.p === 'object' ? pr.p : {};
    const own = Number.isInteger(picks[me]) ? picks[me] : myPick && myPick.r === pr.r ? myPick.p : null;
    const meRow = list.find((p) => p.isMe);
    const closed = Boolean(pr.x) || room.phase !== 'game';
    const open = !closed && sharedNow() < pr.until;
    return {
      open,
      closed,
      from: Number(pr.from) || 0,
      until: Number(pr.until) || 0,
      mine: own,
      count: Object.keys(picks).length,
      canPick: open && Boolean(meRow && meRow.present && !meRow.joined && !meRow.out) && !partyBanned(me) && Object.keys(picks).length < PREDICT_MAX + (own !== null ? 1 : 0),
      picks: Object.entries(picks)
        .filter(([, slot]) => Number.isInteger(slot))
        .map(([id, slot]) => ({ id, slot })),
      winners: Array.isArray(pr.w) ? pr.w.filter(Number.isInteger) : null,
    };
  }

  function tourView(room) {
    const trn = tourOf(room);
    const cfg = cleanTour(room.tour, games);
    const live = trn && (room.phase === 'game' || room.phase === 'results') ? trn : null;
    return {
      setup: cfg,
      live: live
        ? { g: live.g.slice(), i: live.i, pts: { ...(live.pts || {}) }, f: { ...(live.f || {}) }, lp: live.lp ? { ...live.lp } : null, done: Boolean(live.done), champ: Number.isInteger(live.champ) ? live.champ : null }
        : null,
    };
  }

  function act(action) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || !action || typeof action !== 'object' || !isJoined(meId())) return false;
    if (isHost()) handleIntent(meId(), { t: 'g', g: room.game, a: action });
    else queueSend({ t: 'g', g: room.game, a: action });
    return true;
  }

  function direct(key, value) {
    const room = read(ROOM);
    const game = room && games.get(room.game);
    if (!isOpen(game, key) || !isJoined(meId())) return false;
    if (!writerOk(game, key, slotOf(meId()), value === undefined ? null : value)) return false;
    try {
      write(key, value);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  function broadcast(data) {
    try {
      queueSend(data);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  function snapshot() {
    const room = read(ROOM) || newRoom(gameList[0] && gameList[0].id);
    const scores = read(SCORES) || newScores();
    const ps = playersState();
    const present = new Map(presentList().map((p) => [p.id, p]));
    const h = hostId();
    const me = meId();
    const owner = ownerOf();
    const list = [];
    const seen = new Set();
    for (const id of Object.keys(ps.p)) {
      const e = ps.p[id];
      const live = present.get(id);
      seen.add(id);
      const look = live || person({ id, name: e.n }) || {};
      list.push({
        id,
        slot: e.s,
        name: live ? live.name : e.n,
        username: look.username || null,
        avatar: look.avatar || null,
        initials: live ? live.initials : initials(e.n),
        hue: live ? live.hue : hueOf(id),
        present: Boolean(live),
        joined: Boolean(live) && Boolean(e.y),
        ready: Boolean(e.r),
        isHost: id === h,
        isMe: id === me,
        isAdmin: adminOk(id),
        isOwner: id === owner,
        game: scores.g[e.s] || 0,
        total: scores.t[e.s] || 0,
        wins: scores.w[e.s] || 0,
      });
    }
    for (const [id, p] of present) {
      if (seen.has(id)) continue;
      list.push({ ...p, username: p.username || null, slot: null, present: true, joined: false, ready: false, isHost: id === h, isMe: id === me, isAdmin: adminOk(id), isOwner: id === owner, game: 0, total: 0, wins: 0 });
    }
    list.sort((a, b) => (a.slot ?? 1e9) - (b.slot ?? 1e9));
    const state = merged();
    const pick = games.get(room.pick) || gameList[0] || null;
    const mine = list.find((p) => p.isMe);
    const out = outSlots(room);
    for (const p of list) p.out = room.phase === 'game' && p.slot !== null && out.includes(p.slot);
    return {
      tour: tourView(room),
      predict: predictView(room, list, me),
      hostTools: { lateLocked: Boolean(room.nolate), out: room.phase === 'game' ? out : [], removed: Boolean(mine && mine.out) },
      ready: Boolean(t.ready),
      me,
      meSlot: slotOf(me),
      meJoined: Boolean(mine && mine.joined),
      joining: want,
      playing: list.filter((p) => p.joined).length,
      autoStart: room.phase === 'lobby' ? autoOf(pick) : null,
      host: h,
      hostName: (list.find((p) => p.id === h) || {}).name || 'the host',
      isHost: isHost(),
      room,
      scores,
      players: list,
      game: games.get(room.game) || null,
      pick,
      settings: pick ? settingsFor(pick, room) : {},
      admin: { me: adminOk(me), owner, locked: Boolean(room.lock), banned: Array.isArray(room.ban) ? room.ban.filter((x) => typeof x === 'string') : [], partyBanned: partyBanned(me) },
      announce: announceOf(room),
      party: partyOf(room),
      fun: funView(room),
      state,
      now: sharedNow(),
    };
  }

  function freshFunMem() {
    return { hits: {}, worst: {}, behind: {}, fast: {}, re: {}, streak: {}, bestStreak: {}, frozen: {}, scored: new Set(), lead: null, changes: 0, quiet: new Set(), roasts: 0, lastRoast: null, round: null, events: 0, half: null };
  }

  function stopFunTimers() {
    if (dramaTimer !== null) clearT(dramaTimer);
    if (lineTimer !== null) clearT(lineTimer);
    dramaTimer = null;
    lineTimer = null;
    queued = null;
  }

  function resetFunMem() {
    stopFunTimers();
    fm = freshFunMem();
    lastLineAt = -Infinity;
    const pts = (read(SCORES) || newScores()).g;
    const lead = leaderOf(pts, liveSlots(pts));
    fm.lead = lead === -1 ? null : lead;
  }

  function blankFun(room) {
    return { r: room.round, g: room.game, c: {}, u: {}, o: [], x: [], z: [], f: 0, l: null };
  }

  function funState() {
    const room = read(ROOM);
    if (!room || (room.phase !== 'game' && room.phase !== 'results') || !room.game) return null;
    const f = read(FUN);
    if (!f || typeof f !== 'object' || f.r !== room.round || f.g !== room.game) return blankFun(room);
    return f;
  }

  function fitFun(f) {
    while (jsonBytes(f) > MAX_VALUE_BYTES && Array.isArray(f.hl) && f.hl.length) f.hl = f.hl.slice(0, -1);
    while (jsonBytes(f) > MAX_VALUE_BYTES && Array.isArray(f.aw) && f.aw.length) f.aw = f.aw.slice(0, -1);
    if (jsonBytes(f) > MAX_VALUE_BYTES) f.o = [];
    return f;
  }

  function patchFun(p) {
    const f = funState();
    if (!f) return false;
    write(FUN, fitFun({ ...clone(f), ...p }));
    return true;
  }

  function clearFun() {
    stopFunTimers();
  }

  function liveSlots(pts) {
    const room = read(ROOM);
    const out = new Set(outSlots(room));
    const list = new Set(activePlayers().map((p) => p.slot));
    for (const [slot, n] of Object.entries(pts || {})) if (Number(n)) list.add(Number(slot));
    return [...list].filter((s) => Number.isInteger(s) && !out.has(s));
  }

  function nameAt(slot) {
    const id = Number.isInteger(slot) ? idOfSlot(slot) : null;
    const e = id ? playersState().p[id] : null;
    return e && e.n ? e.n : 'Player';
  }

  function startFun(game, round, keep) {
    stopFunTimers();
    fm = freshFunMem();
    lastLineAt = -Infinity;
    const px = partyOf(read(ROOM));
    const allowed = px.cards ? cardsFor(game) : [];
    const f = { r: round, g: game.id, c: dealCards(activePlayers().map((p) => p.slot), allowed, funRandom), u: {}, o: [], x: [], z: [], f: 0, l: null };
    if (keep) f.tm = { ...keep };
    if (keep || Object.keys(f.c).length) write(FUN, fitFun(f));
  }

  function dealLate(slot) {
    const f = funState();
    const room = read(ROOM);
    if (!f || !room || room.phase !== 'game' || !partyOf(room).cards) return;
    if (f.c && f.c[slot] !== undefined) return;
    const code = dealOne(cardsFor(games.get(room.game)), funRandom);
    if (code) patchFun({ c: { ...(f.c || {}), [slot]: code } });
  }

  function multOf(slot, consume) {
    const f = funState();
    if (!f) return 1;
    let m = f.f ? 2 : 1;
    if (Array.isArray(f.x) && f.x.includes(slot)) {
      m *= 2;
      if (consume) patchFun({ x: f.x.filter((s) => s !== slot) });
    }
    return m;
  }

  function noteScore(slot, pts) {
    if (!hostOnly() || !(pts > 0)) {
      dramaSoon();
      return;
    }
    fm.hits[slot] = Math.max(fm.hits[slot] || 0, pts);
    fm.scored.add(slot);
    fm.events += 1;
    dramaSoon();
  }

  function dramaSoon() {
    if (!hostOnly() || dramaTimer !== null) return;
    dramaTimer = setT(dramaCheck, DRAMA_MS);
  }

  function dramaCheck() {
    if (dramaTimer !== null) clearT(dramaTimer);
    dramaTimer = null;
    if (!hostOnly()) return;
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || !funState()) return;
    const pts = (read(SCORES) || newScores()).g;
    const slots = liveSlots(pts);
    const list = ranked(pts, slots);
    if (list.length >= 2) {
      const top = list[0].pts;
      for (const x of list) {
        const place = list.filter((y) => y.pts > x.pts).length;
        if (fm.events > 0) fm.worst[x.slot] = Math.max(Number.isInteger(fm.worst[x.slot]) ? fm.worst[x.slot] : place, place);
        fm.behind[x.slot] = Math.max(fm.behind[x.slot] || 0, top - x.pts);
      }
    }
    const lead = leaderOf(pts, slots);
    if (lead === null || lead === -1 || lead === fm.lead) return;
    const prev = fm.lead;
    fm.lead = lead;
    if (prev === null || list.length < 2) return;
    fm.changes += 1;
    queueLine('lead', { a: nameAt(lead), b: nameAt(prev) });
  }

  function lineAllowed(kind) {
    const px = partyOf(read(ROOM));
    if (kind === 'final') return px.final;
    if (kind === 'swap' || kind === 'freeze' || kind === 'double' || kind === 'peek') return px.cards;
    return px.drama;
  }

  function queueLine(kind, vars = {}, text = null) {
    if (!hostOnly() || !lineAllowed(kind) || !funState()) return false;
    const prio = PRIORITY[kind] || 1;
    const at = now();
    const item = { kind, vars, text, prio, at };
    const gap = at - lastLineAt;
    if (gap >= LINE_GAP_MS || (prio >= 7 && gap >= LINE_GAP_MS / 3)) {
      postLine(item);
      return true;
    }
    if (!queued || prio >= queued.prio) queued = item;
    if (lineTimer === null) lineTimer = setT(flushLine, Math.max(0, lastLineAt + LINE_GAP_MS - at));
    return true;
  }

  function flushLine() {
    lineTimer = null;
    const item = queued;
    if (!item || !hostOnly()) {
      queued = null;
      return;
    }
    const at = now();
    if (at - lastLineAt < LINE_GAP_MS) {
      lineTimer = setT(flushLine, lastLineAt + LINE_GAP_MS - at);
      return;
    }
    queued = null;
    if (at - item.at > LINE_STALE_MS && item.prio < PRIORITY.lead) return;
    postLine(item);
  }

  function postLine(item) {
    const f = funState();
    if (!f) return;
    const raw = item.text || pickLine(item.kind, item.vars, lineMemo, funRandom);
    const text = cleanShared(raw, LINE_MAX);
    if (!text) return;
    lastLineAt = now();
    const i = ((f.l && Number(f.l.i)) || 0) + 1;
    patchFun({ l: { i, k: item.kind, t: text, at: lastLineAt, b: BANNER_KINDS.includes(item.kind) ? 1 : 0 } });
  }

  function closeRound() {
    let hot = null;
    for (const p of activePlayers()) {
      const s = p.slot;
      if (fm.scored.has(s)) {
        fm.streak[s] = (fm.streak[s] || 0) + 1;
        fm.bestStreak[s] = Math.max(fm.bestStreak[s] || 0, fm.streak[s]);
        if (fm.streak[s] >= STREAK_MIN && (!hot || fm.streak[s] > hot.n)) hot = { slot: s, n: fm.streak[s] };
      } else {
        fm.streak[s] = 0;
      }
    }
    fm.scored.clear();
    if (hot) queueLine('streak', { a: nameAt(hot.slot), n: hot.n });
  }

  function callouts(n) {
    const pts = (read(SCORES) || newScores()).g;
    const slots = activePlayers().map((p) => p.slot);
    if (slots.length < 2) return;
    const quiet = slots.filter((s) => !((pts[s] || 0) > 0) && !fm.quiet.has(s));
    if (quiet.length && funRandom() < 0.5) {
      const s = quiet[Math.floor(funRandom() * quiet.length) % quiet.length];
      fm.quiet.add(s);
      queueLine('quiet', { a: nameAt(s) });
      return;
    }
    if (n < ROAST_ROUND || slots.length < 3 || fm.roasts >= ROAST_MAX || funRandom() >= 0.35) return;
    const list = ranked(pts, slots);
    const last = list[list.length - 1];
    if (!last || last.pts >= list[list.length - 2].pts || last.slot === fm.lastRoast) return;
    fm.roasts += 1;
    fm.lastRoast = last.slot;
    queueLine('roast', { a: nameAt(last.slot) });
  }

  function halfwayLast() {
    const pts = (read(SCORES) || newScores()).g;
    const slots = activePlayers().map((p) => p.slot).filter(Number.isInteger);
    if (slots.length < 2) return [];
    const vals = slots.map((s) => Number(pts[s]) || 0);
    const low = Math.min(...vals);
    if (low === Math.max(...vals)) return [];
    return slots.filter((s, i) => vals[i] === low);
  }

  function roundReport(n, total) {
    if (!hostOnly()) return;
    const at = Math.floor(Number(n));
    const of = Math.floor(Number(total));
    if (!Number.isFinite(at) || at < 1) return;
    if (!fm.half && Number.isFinite(of) && of >= 2 && at > of / 2) fm.half = halfwayLast();
    const f = funState();
    if (!f || fm.round === at) return;
    if (fm.round !== null && at > fm.round) closeRound();
    else fm.scored.clear();
    fm.round = at;
    const fin = Number.isFinite(of) && of >= 2 && at >= of && partyOf(read(ROOM)).final ? 1 : 0;
    const was = f.f ? 1 : 0;
    if (fin !== was) patchFun({ f: fin });
    if (fin) {
      if (!was) queueLine('final');
      return;
    }
    if (at >= QUIET_ROUND) callouts(at);
  }

  function gameSay(kind, data) {
    if (!hostOnly() || !SAY_KINDS.includes(kind)) return false;
    const d = data && typeof data === 'object' ? data : {};
    const slot = Number.isInteger(d.slot) ? d.slot : null;
    if (kind === 'custom') {
      const text = cleanShared(typeof d.text === 'string' ? d.text : '', LINE_MAX);
      return text ? queueLine('custom', {}, text) : false;
    }
    if (slot === null) return false;
    if (kind === 'fast') {
      fm.fast[slot] = (fm.fast[slot] || 0) + 1;
      if (funRandom() >= 0.3) return true;
    }
    const n = Number.isFinite(Number(d.n)) ? Math.round(Number(d.n)) : null;
    if (kind === 'streak') {
      if (n === null) return false;
      fm.bestStreak[slot] = Math.max(fm.bestStreak[slot] || 0, n);
      if (n < STREAK_MIN) return true;
    }
    return queueLine(kind, { a: nameAt(slot), b: Number.isInteger(d.other) ? nameAt(d.other) : '', n });
  }

  function pm(id, k, x) {
    if (id === meId()) {
      emit(k === 'hint' ? 'hint' : 'cardno', { text: x });
      return;
    }
    try {
      queueSend({ t: 'pm', to: id, k, x });
    } catch (e) {
      fail(e);
    }
  }

  function receivePm(x, by) {
    if (!by || by !== hostId() || by === meId() || x.to !== meId()) return;
    const text = cleanShared(typeof x.x === 'string' ? x.x : '', HINT_MAX);
    if (!text) return;
    emit(x.k === 'hint' ? 'hint' : 'cardno', { text });
  }

  function cardNo(id, text) {
    pm(id, 'no', text);
    return false;
  }

  function playCard(from, data) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || data.g !== room.game) return false;
    if (!isJoined(from) || !presentIds().has(from)) return false;
    const f = funState();
    if (!f || !partyOf(room).cards) return false;
    const slot = slotOf(from);
    if (slot === null || (f.u && f.u[slot])) return false;
    const card = cardByCode(f.c ? f.c[slot] : null);
    if (!card || data.c !== card.id) return false;
    const game = games.get(room.game);
    if (!game) return false;
    const patch = {};
    const vars = { a: nameAt(slot) };
    if (card.id === 'swap') {
      const s = clone(read(SCORES)) || newScores();
      const gone = new Set(outSlots(room));
      const above = slotAbove(s.g, activePlayers().map((p) => p.slot).filter((x) => !gone.has(x)), slot);
      if (above === null) return cardNo(from, 'Nobody is above you right now. Save it for later!');
      const mine = s.g[slot] || 0;
      s.g[slot] = s.g[above] || 0;
      s.g[above] = mine;
      write(SCORES, s);
      vars.b = nameAt(above);
      dramaSoon();
    } else if (card.id === 'double') {
      patch.x = (f.x || []).filter((x) => x !== slot).concat([slot]);
    } else if (card.id === 'freeze') {
      const to = data.to;
      if (!Number.isInteger(to) || to === slot || !activePlayers().some((p) => p.slot === to)) return cardNo(from, 'Pick someone who is playing to freeze.');
      if ((f.z || []).includes(to)) return cardNo(from, "They're already frozen. Pick someone else.");
      if (typeof game.canFreeze === 'function' && !game.canFreeze(gameApi(game), to, slot)) return cardNo(from, "They can't be frozen right now. Try again in a bit.");
      if (typeof game.freeze === 'function' && !game.freeze(gameApi(game), to, slot)) return cardNo(from, "They can't be frozen right now. Try again in a bit.");
      fm.frozen[to] = (fm.frozen[to] || 0) + 1;
      vars.b = nameAt(to);
      patch.z = ((funState() || f).z || []).filter((x) => x !== to).concat([to]);
    } else if (card.id === 'peek') {
      const hint = typeof game.hint === 'function' ? game.hint(gameApi(game), slot) : null;
      const text = cleanShared(typeof hint === 'string' ? hint : '', HINT_MAX);
      if (!text) return cardNo(from, 'Nothing to peek at right now. Try again in a bit.');
      pm(from, 'hint', text);
    }
    const cur = funState() || f;
    write(FUN, fitFun({ ...clone(cur), ...patch, u: { ...(cur.u || {}), [slot]: card.code }, o: (cur.o || []).filter((x) => x !== slot).concat([slot]).slice(-OUT_MAX) }));
    queueLine(card.id, vars);
    return true;
  }

  function play(card, target = null) {
    const room = read(ROOM);
    const f = funState();
    const slot = slotOf(meId());
    if (destroyed || !room || room.phase !== 'game' || !f || slot === null || !isJoined(meId())) return false;
    const mine = cardByCode(f.c ? f.c[slot] : null);
    if (!mine || mine.id !== card || (f.u && f.u[slot])) return false;
    const msg = { t: 'card', g: room.game, c: card };
    if (Number.isInteger(target)) msg.to = target;
    if (isHost()) return playCard(meId(), msg);
    return broadcast(msg);
  }

  function countReact(id) {
    const room = read(ROOM);
    const slot = slotOf(id);
    if (!isHost() || !room || room.phase !== 'game' || slot === null) return;
    fm.re[slot] = (fm.re[slot] || 0) + 1;
  }

  function reactEvent(id, i) {
    const entry = playersState().p[id];
    const name = entry && entry.n ? entry.n : nameFor(id) || 'Someone';
    return { e: i, emoji: REACTIONS[i], by: id, name, mine: id === meId() };
  }

  function reactOk(id) {
    const room = read(ROOM);
    return Boolean(room && partyOf(room).reactions && id && !partyBanned(id) && !isBanned(id));
  }

  function react(i) {
    const id = meId();
    if (destroyed || !Number.isInteger(i) || i < 0 || i >= REACTIONS.length || !reactOk(id)) return false;
    const at = now();
    myReacts = myReacts.filter((x) => at - x < REACT_WINDOW_MS && x <= at);
    if (myReacts.length >= REACT_MAX) return false;
    if (myReacts.length && at - myReacts[myReacts.length - 1] < REACT_GAP_MS) return false;
    if (!broadcast({ t: 're', e: i })) return false;
    myReacts.push(at);
    countReact(id);
    emit('react', reactEvent(id, i));
    return true;
  }

  function receiveReact(x, by) {
    if (!by || by === meId() || !Number.isInteger(x.e) || x.e < 0 || x.e >= REACTIONS.length) return;
    if (!reactOk(by) || !presentIds().has(by)) return;
    const at = now();
    const list = (reactSeen.get(by) || []).filter((t) => at - t < REACT_WINDOW_MS && t <= at);
    reactSeen.delete(by);
    if (list.length >= REACT_MAX + 2) {
      reactSeen.set(by, list);
      return;
    }
    reactSeen.set(by, list.concat([at]));
    while (reactSeen.size > 100) reactSeen.delete(reactSeen.keys().next().value);
    countReact(by);
    emit('react', reactEvent(by, x.e));
  }

  function reelItem(r) {
    const f = funState();
    const i = Number(String(r).slice(3));
    const item = f && Array.isArray(f.hl) ? f.hl[i] : null;
    if (!item || !Number.isInteger(item.s) || typeof item.x !== 'string') return null;
    return { r, author: item.s, text: clip(item.x, TEXT_REPORT_CHARS), context: 'Highlight reel', viewers: null };
  }

  function endFun(game, pts, win, info) {
    const f = funState();
    if (!f || !hostOnly()) return;
    if (dramaTimer !== null) dramaCheck();
    stopFunTimers();
    const slots = liveSlots(pts);
    const live = new Set(slots);
    const finalPlace = {};
    for (const s of slots) finalPlace[s] = placeOf(pts, slots, s);
    const stats = { ...fm, played: (f.o || []).map((slot) => ({ slot, code: f.u ? f.u[slot] : null })) };
    let mine = [];
    if (typeof game.awards === 'function') {
      try {
        const list = game.awards(gameApi(game));
        mine = (Array.isArray(list) ? list : []).map((a) => cleanAward(a, live)).filter(Boolean);
      } catch (e) {
        fail(e);
      }
    }
    let hl = [];
    if (typeof game.highlights === 'function') {
      try {
        const list = game.highlights(gameApi(game));
        hl = (Array.isArray(list) ? list : []).map((x) => cleanHighlight(x, live)).filter(Boolean).slice(0, HIGHLIGHTS_MAX);
      } catch (e) {
        fail(e);
      }
    }
    const next = { ...clone(f), l: null, x: [], z: [], f: 0, aw: fitAwards(mine.concat(genericAwards(stats, { finalPlace }))), hl };
    const up = upsetLine(stats, { winners: win, players: slots.length, points: pts, nameOf: nameAt });
    if (up) next.up = clip(up, UPSET_MAX);
    const lt = teamCodes(info);
    if (lt) next.lt = lt;
    else delete next.lt;
    const stored = read(FUN);
    const ours = stored && stored.r === f.r && stored.g === f.g;
    if (!ours && !next.aw.length && !hl.length && !next.up && !lt) return;
    write(FUN, fitFun(next));
  }

  function funView(room) {
    if (!room || room !== read(ROOM)) return null;
    const f = funState();
    if (!f) return null;
    const mine = slotOf(meId());
    const card = mine !== null && f.c ? cardByCode(f.c[mine]) : null;
    const used = mine !== null && f.u ? cardByCode(f.u[mine]) : null;
    const line = f.l && typeof f.l === 'object' && typeof f.l.t === 'string' ? cleanShared(f.l.t, LINE_MAX) : '';
    const ints = (list) => (Array.isArray(list) ? list.filter(Number.isInteger) : []);
    return {
      round: f.r,
      card: card ? { id: card.id, emoji: card.emoji, name: card.name, text: card.text, target: Boolean(card.target) } : null,
      used: Boolean(used),
      double: mine !== null && ints(f.x).includes(mine),
      frozen: ints(f.z),
      final: Boolean(f.f),
      played: Object.keys(f.u || {}).length,
      line: line ? { i: Number(f.l.i) || 0, kind: typeof f.l.k === 'string' ? f.l.k : 'custom', text: line, at: Number(f.l.at) || 0, banner: Boolean(f.l.b) } : null,
      awards: (Array.isArray(f.aw) ? f.aw : [])
        .filter((a) => a && typeof a.t === 'string')
        .map((a) => ({ emoji: typeof a.e === 'string' ? a.e : '🏅', title: cleanShared(a.t, 32), slots: ints(a.s), why: typeof a.y === 'string' ? cleanShared(a.y, 80) : '' }))
        .filter((a) => a.title && a.slots.length),
      highlights: (Array.isArray(f.hl) ? f.hl : [])
        .map((x, i) => ({ r: `hl.${i}`, text: x && typeof x.x === 'string' ? cleanShared(x.x, 120) : '', slot: x && Number.isInteger(x.s) ? x.s : null }))
        .filter((x) => x.text),
      upset: typeof f.up === 'string' ? cleanShared(f.up, UPSET_MAX) || null : null,
      sameTeams: Boolean(f.lt && typeof f.lt === 'object'),
    };
  }

  function on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    return () => off(ev, fn);
  }

  function off(ev, fn) {
    handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
  }

  const listeners = {
    ready: onReady,
    init: onInit,
    participants: onRoster,
    state: onState,
    message: onMessage,
  };
  for (const [ev, fn] of Object.entries(listeners)) t.on(ev, fn);
  let stopAdmins = null;
  try {
    stopAdmins =
      typeof admins.onChange === 'function'
        ? admins.onChange(() => {
            enforceBans();
            changed();
          })
        : null;
  } catch {
    stopAdmins = null;
  }
  if (t.ready && !readySeen) onReady();

  function destroy() {
    destroyed = true;
    for (const [ev, fn] of Object.entries(listeners)) if (typeof t.off === 'function') t.off(ev, fn);
    if (flushTimer !== null) clearT(flushTimer);
    if (deadlineTimer !== null) clearT(deadlineTimer);
    if (resendTimer !== null) clearT(resendTimer);
    if (lateTimer !== null) clearT(lateTimer);
    if (wantTimer !== null) clearT(wantTimer);
    if (annTimer !== null) clearT(annTimer);
    stopFunTimers();
    if (typeof stopAdmins === 'function') stopAdmins();
  }

  return {
    on,
    off,
    snapshot,
    lobby,
    admin,
    ready,
    join,
    leave,
    predict,
    act,
    react,
    play,
    flag,
    report,
    reported,
    canReport,
    direct,
    drop,
    broadcast,
    destroy,
    flush,
    stats,
    budget,
    isHost,
    now: sharedNow,
    games: gameList,
    get pendingCount() {
      return pending.size + outbox.length;
    },
  };
}
