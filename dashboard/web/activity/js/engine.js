import { OpBudget, OPS_WINDOW_MS, MAX_VALUE_BYTES, checkSet, jsonBytes, validKey } from './limits.js';
import { idOf, people, person, cleanName, initials, hueOf } from './players.js';
import { isAdmin as cachedAdmin, knows as cachedKnows, ownerId as cachedOwner, refreshAdmins, onAdmins } from './admin.js';

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
export const FUN_FX = Object.freeze(['confetti', 'emoji-rain', 'spotlight', 'hype']);
export const TROLL_FX = Object.freeze(['flip', 'mirror', 'shake', 'spin', 'tiny', 'comic', 'blur', 'crash', 'clown', 'fake-win']);
export const ALL_FX = Object.freeze(FUN_FX.concat(TROLL_FX));
export const TARGET_FX = Object.freeze(['spotlight', 'clown', 'fake-win']);
export const ADMIN_ACTIONS = Object.freeze(['start', 'end', 'skip', 'time', 'points', 'kick', 'ban', 'unban', 'lock', 'announce']);
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STRIP_RE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const EMOJI_PARTS_RE = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Emoji_Component}‍️⃣]+$/u;
const DEFAULT_ADMINS = Object.freeze({ isAdmin: cachedAdmin, knows: cachedKnows, ownerId: cachedOwner, refresh: refreshAdmins, onChange: onAdmins });

export function shiftEnd(ends, ms, at) {
  const base = Number.isFinite(ends) ? ends : at;
  const lo = Math.min(base, at + ADMIN_TIME_MIN_LEFT);
  const hi = Math.max(base, at + ADMIN_TIME_MAX);
  return Math.round(Math.min(hi, Math.max(lo, base + (Number.isFinite(ms) ? ms : 0))));
}

export function cleanText(raw, max = ANNOUNCE_MAX) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trim() : text;
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

export function cleanSetting(spec, value) {
  if (!spec) return undefined;
  const values = (spec.options || []).map((o) => o.value);
  if (spec.type === 'toggle') return Boolean(value);
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

export function createEngine(opts) {
  const t = opts.transport;
  const gameList = opts.games || [];
  const games = new Map(gameList.map((g) => [g.id, g]));
  const now = opts.now || (() => Date.now());
  let skew = 0;
  const sharedNow = () => (isHost() ? now() : now() + skew);
  const random = opts.random || Math.random;
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  const flushMs = Math.max(FLUSH_MS, opts.flushMs ?? FLUSH_MS);
  const admins = { ...DEFAULT_ADMINS, ...(opts.admins || {}) };
  const fxSeen = new Map();
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
    if (!game || typeof game.roster !== 'function') return;
    try {
      game.roster(gameApi(game));
    } catch (e) {
      fail(e);
    }
  }

  function lateJoin(id) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game') return;
    const game = games.get(room.game);
    const slot = slotOf(id);
    if (!game || slot === null || typeof game.join !== 'function') return;
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
      addPoints(slot, n) {
        if (!Number.isInteger(slot) || !Number.isFinite(n) || n === 0) return;
        const s = clone(read(SCORES)) || newScores();
        s.g[slot] = (s.g[slot] || 0) + Math.round(n);
        write(SCORES, s);
      },
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

  function finishGame(game, winners) {
    const s = clone(read(SCORES)) || newScores();
    const win = Array.isArray(winners) ? winners.filter((x) => Number.isInteger(x)) : topSlots(s.g);
    for (const [slot, pts] of Object.entries(s.g)) s.t[slot] = (s.t[slot] || 0) + pts;
    for (const slot of win) s.w[slot] = (s.w[slot] || 0) + 1;
    fitScores(s);
    write(SCORES, s);
    patchRoom({ phase: 'results', deadline: null, last: { game: game.id, winners: win, at: now() } });
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
      } else if (data.t === 'in') {
        if (!presentIds().has(from) || isBanned(from)) return;
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
    if (!isHost() || destroyed || !presentIds().has(id) || isBanned(id)) return;
    if (setJoined(id, true)) {
      lateJoin(id);
      checkAuto();
    }
  }

  function isBanned(id) {
    const room = read(ROOM);
    return Boolean(id && room && Array.isArray(room.ban) && room.ban.includes(id));
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
    scheduleDeadline();
    emit('host', { me: true });
  }

  function loseHost() {
    hosting = false;
    memory = {};
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
      for (const x of list) if (x && typeof x === 'object' && x.t === 'fx') receiveFx(x, from);
    }
    if (isHost()) handleIntent(from, data);
  }

  function hostOnly() {
    return isHost() && !destroyed;
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
    start() {
      if (!hostOnly()) return { ok: false, reason: 'not_host' };
      const room = read(ROOM);
      if (!room || room.phase === 'game') return { ok: false, reason: 'busy' };
      const game = games.get(room.pick);
      if (!game) return { ok: false, reason: 'no_game' };
      const min = game.minPlayers || 1;
      if (activePlayers().length < min) return { ok: false, reason: 'players', need: min };
      try {
        for (const g of gameList) clearGameKeys(g);
        const s = clone(read(SCORES)) || newScores();
        s.g = {};
        write(SCORES, s);
        memory[game.id] = {};
        patchRoom({ phase: 'game', game: game.id, deadline: null, round: (room.round || 0) + 1, last: null, auto: null });
        game.start(gameApi(game));
      } catch (e) {
        fail(e);
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
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
      patchRoom({ phase: 'lobby', game: null, deadline: null, auto: null });
      checkAuto();
      return true;
    },
    reset() {
      if (!hostOnly()) return false;
      for (const g of gameList) clearGameKeys(g);
      write(SCORES, newScores());
      patchRoom({ phase: 'lobby', game: null, deadline: null, last: null, auto: null });
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
    return setWant('in');
  }

  function leave() {
    return setWant('out');
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
    return {
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
      admin: { me: adminOk(me), owner, locked: Boolean(room.lock), banned: Array.isArray(room.ban) ? room.ban.filter((x) => typeof x === 'string') : [] },
      announce: announceOf(room),
      state,
      now: sharedNow(),
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
    stopAdmins = typeof admins.onChange === 'function' ? admins.onChange(() => changed()) : null;
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
    act,
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
