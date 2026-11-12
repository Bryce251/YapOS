import { OpBudget, OPS_WINDOW_MS, MAX_VALUE_BYTES, checkSet, jsonBytes, validKey } from './limits.js';
import { idOf, people, cleanName, initials, hueOf } from './players.js';

export const FLUSH_MS = 120;
export const SOFT_OPS = 60;
export const PLAYER_CAP = 36;
export const MAX_BATCH = 20;
export const PLAYERS_BYTES = 3800;
export const STORED_NAME_BYTES = 48;
export const RESEND_MS = 3000;
export const LATE_MS = 1500;
export const ROOM = 'room';
export const SCORES = 'scores';
export const PLAYERS = 'players';
export const CORE_KEYS = Object.freeze([ROOM, SCORES, PLAYERS]);

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
  return { v: 1, phase: 'lobby', pick, game: null, opts: {}, deadline: null, round: 0, last: null };
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
  const random = opts.random || Math.random;
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  const flushMs = Math.max(FLUSH_MS, opts.flushMs ?? FLUSH_MS);
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
        if (t.set(key, val) === false) {
          stats.deferred += 1;
          break;
        }
        budget.spend(at);
        stats.sets += 1;
        pending.delete(key);
        overlay.set(key, { val, at });
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
    return isOpen(game, key) && writerOk(game, key, slotOf(meId()), val);
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
    if (!isHost() || destroyed) return;
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || typeof room.deadline !== 'number') return;
    deadlineTimer = setT(onDeadline, Math.max(0, room.deadline - now()));
  }

  function scheduleLate() {
    if (lateTimer !== null) {
      clearT(lateTimer);
      lateTimer = null;
    }
    if (isHost() || destroyed || !hostId()) return;
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || typeof room.deadline !== 'number' || lateSent === room.deadline) return;
    const d = room.deadline;
    lateTimer = setT(() => {
      lateTimer = null;
      const r = read(ROOM);
      if (destroyed || isHost() || !r || r.phase !== 'game' || r.deadline !== d || lateSent === d) return;
      lateSent = d;
      queueSend({ t: 'late', d });
    }, Math.max(0, d + LATE_MS - now()));
  }

  function onDeadline() {
    if (deadlineTimer !== null) clearT(deadlineTimer);
    deadlineTimer = null;
    if (!isHost() || destroyed) return;
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || typeof room.deadline !== 'number') return;
    if (now() < room.deadline) {
      scheduleDeadline();
      return;
    }
    const game = games.get(room.game);
    const before = room.deadline;
    try {
      if (game && typeof game.deadline === 'function') game.deadline(gameApi(game));
    } catch (e) {
      fail(e);
    }
    const after = read(ROOM);
    if (after && after.phase === 'game' && after.deadline === before) patchRoom({ deadline: null });
    scheduleDeadline();
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
    const order = Object.keys(ps.p).sort((a, b) => {
      const pa = present.has(a) ? 1 : 0;
      const pb = present.has(b) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (!pa) return worth(a) - worth(b) || ps.p[a].j - ps.p[b].j;
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
    prune(ps);
    const s = clone(read(SCORES));
    if (s && s.g && s.t && s.w && trimScores(s, ps)) write(SCORES, s);
    if (!renamed && !added.some((id) => ps.p[id])) return;
    write(PLAYERS, ps);
  }

  function syncPlayers() {
    addPlayers(presentList().map((p) => ({ id: p.id, name: p.name })));
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
      .filter((p) => ps[p.id])
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
      now,
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
        const room = read(ROOM);
        if (room && room.phase === 'game' && typeof room.deadline === 'number' && now() >= room.deadline) onDeadline();
      } else if (data.t === 'join') {
        addPlayers([{ id: from, name: nameFor(from) }]);
      } else if (data.t === 'ready') {
        addPlayers([{ id: from, name: nameFor(from) }]);
        setReady(from, Boolean(data.v));
      } else if (data.t === 'g') {
        const room = read(ROOM);
        if (!room || room.phase !== 'game' || data.g !== room.game) return;
        const game = games.get(room.game);
        if (!game || typeof game.intent !== 'function') return;
        addPlayers([{ id: from, name: nameFor(from) }]);
        const slot = slotOf(from);
        if (slot === null) return;
        game.intent(gameApi(game), slot, data.a && typeof data.a === 'object' ? data.a : {});
      }
    } catch (e) {
      fail(e);
    }
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
    } else if (isHost()) {
      try {
        syncPlayers();
        const room = read(ROOM);
        if (room && room.phase === 'game') {
          const game = games.get(room.game);
          if (game && typeof game.roster === 'function') game.roster(gameApi(game));
        }
      } catch (e) {
        fail(e);
      }
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
    else queueSend({ t: 'join' });
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
      } catch (e) {
        fail(e);
      }
      scheduleDeadline();
    } else {
      if (hosting) loseHost();
      queueSend({ t: 'join' });
      scheduleDeadline();
    }
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
    if (!isOpen(game, key)) return false;
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
    if (overlay.has(key)) {
      const mine = overlay.get(key).val;
      if (same(mine, val) || (from && from !== meId())) overlay.delete(key);
    }
    if (key === ROOM) scheduleDeadline();
    changed();
  }

  function onMessage({ data, by }) {
    const from = idOf(by);
    emit('message', { data, by: from });
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
        patchRoom({ phase: 'game', game: game.id, deadline: null, round: (room.round || 0) + 1, last: null });
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
      patchRoom({ phase: 'lobby', game: null, deadline: null });
      return true;
    },
    reset() {
      if (!hostOnly()) return false;
      for (const g of gameList) clearGameKeys(g);
      write(SCORES, newScores());
      patchRoom({ phase: 'lobby', game: null, deadline: null, last: null });
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

  function act(action) {
    const room = read(ROOM);
    if (!room || room.phase !== 'game' || !action || typeof action !== 'object') return false;
    if (isHost()) handleIntent(meId(), { t: 'g', g: room.game, a: action });
    else queueSend({ t: 'g', g: room.game, a: action });
    return true;
  }

  function direct(key, value) {
    const room = read(ROOM);
    const game = room && games.get(room.game);
    if (!isOpen(game, key)) return false;
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
    const list = [];
    const seen = new Set();
    for (const id of Object.keys(ps.p)) {
      const e = ps.p[id];
      const live = present.get(id);
      seen.add(id);
      list.push({
        id,
        slot: e.s,
        name: live ? live.name : e.n,
        avatar: live ? live.avatar : null,
        initials: live ? live.initials : initials(e.n),
        hue: live ? live.hue : hueOf(id),
        present: Boolean(live),
        ready: Boolean(e.r),
        isHost: id === h,
        isMe: id === me,
        game: scores.g[e.s] || 0,
        total: scores.t[e.s] || 0,
        wins: scores.w[e.s] || 0,
      });
    }
    for (const [id, p] of present) {
      if (seen.has(id)) continue;
      list.push({ ...p, slot: null, present: true, ready: false, isHost: id === h, isMe: id === me, game: 0, total: 0, wins: 0 });
    }
    list.sort((a, b) => (a.slot ?? 1e9) - (b.slot ?? 1e9));
    const state = merged();
    const pick = games.get(room.pick) || gameList[0] || null;
    return {
      ready: Boolean(t.ready),
      me,
      meSlot: slotOf(me),
      host: h,
      hostName: (list.find((p) => p.id === h) || {}).name || 'the host',
      isHost: isHost(),
      room,
      scores,
      players: list,
      game: games.get(room.game) || null,
      pick,
      settings: pick ? settingsFor(pick, room) : {},
      state,
      now: now(),
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
  if (t.ready && !readySeen) onReady();

  function destroy() {
    destroyed = true;
    for (const [ev, fn] of Object.entries(listeners)) if (typeof t.off === 'function') t.off(ev, fn);
    if (flushTimer !== null) clearT(flushTimer);
    if (deadlineTimer !== null) clearT(deadlineTimer);
    if (resendTimer !== null) clearT(resendTimer);
    if (lateTimer !== null) clearT(lateTimer);
  }

  return {
    on,
    off,
    snapshot,
    lobby,
    ready,
    act,
    direct,
    drop,
    broadcast,
    destroy,
    flush,
    stats,
    budget,
    isHost,
    games: gameList,
    get pendingCount() {
      return pending.size + outbox.length;
    },
  };
}
