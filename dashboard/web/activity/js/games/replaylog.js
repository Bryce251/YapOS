import draw from './draw.js';
import { rawInk, KEY as ODD_KEY } from './odd.js';
import { seatInk as telInk, KEY as TEL_KEY } from './telephone.js';
import { seatInk as duelInk, KEY as DUEL_KEY } from './sketchduel.js';
import { KEY as PIXEL_KEY, COUNTS, readGrid, decodeCells, drawingId as pixelId } from './pixel.js';
import { decodeStroke } from './ink.js';
import { trimReplay, dropOldest, PIXEL_CELLS, PIXEL_BLANK } from './replayformat.js';

export const LOG_CANVASES = 32;
export const LOG_EVENTS = 1200;
export const LOG_CLAIMS = 2000;
export const MATCH_MIN = 0.5;
export const LOOSE_MS = 3000;
export const INK_GAMES = Object.freeze(['draw', 'odd', 'telephone', 'sketchduel']);

function inkCanvas(key, game, items) {
  return { key, game, kind: 'ink', items };
}

function oddItems(state, st) {
  const raw = rawInk(state, st.k);
  const marks = Array.isArray(st.marks) ? st.marks : [];
  const lens = Array.isArray(st.lens) ? st.lens : null;
  const total = lens && lens.length === marks.length ? lens.reduce((a, n) => a + (Number.isInteger(n) && n > 0 ? n : 0), 0) : -1;
  if (total === raw.length) {
    const out = [];
    let at = 0;
    marks.forEach((slot, i) => {
      const n = Number.isInteger(lens[i]) && lens[i] > 0 ? lens[i] : 0;
      for (const s of raw.slice(at, at + n)) out.push({ slot, s });
      at += n;
    });
    return out;
  }
  const order = Array.isArray(st.order) ? st.order : [];
  const cols = Array.isArray(st.cols) ? st.cols : [];
  return raw.map((s) => {
    const d = decodeStroke(s);
    const pos = d ? cols.indexOf(d.c) : -1;
    return { slot: pos >= 0 && Number.isInteger(order[pos]) ? order[pos] : -1, s };
  });
}

function seatCanvases(state, game, prefix, seats, k, owner) {
  const out = [];
  if (!Array.isArray(seats) || k === null || k === undefined) return out;
  for (let p = 0; p < seats.length; p += 1) {
    const s = state ? (game === 'telephone' ? telInk(state, p, k).s : duelInk(state, p, k).s) : [];
    const slot = owner(p);
    if (!Number.isInteger(slot)) continue;
    out.push(inkCanvas(`${prefix}.${k}.${p}`, game, s.map((x) => ({ slot, s: x }))));
  }
  return out;
}

export function canvasesOf(snap) {
  const room = snap && snap.room;
  const state = snap && snap.state;
  if (!room || !state || typeof room.game !== 'string') return [];
  const game = room.game;
  try {
    if (game === 'draw') {
      const item = draw.drawingOf(snap);
      if (!item || !Array.isArray(item.ink)) return [];
      return [inkCanvas(item.d, game, item.ink.filter((s) => typeof s === 'string').map((s) => ({ slot: item.drawer, s })))];
    }
    if (game === 'odd') {
      const st = state[ODD_KEY];
      if (!st || !Number.isInteger(st.k)) return [];
      return [inkCanvas(`odd.${st.k}`, game, oddItems(state, st))];
    }
    if (game === 'telephone') {
      const st = state[TEL_KEY];
      if (!st || !Array.isArray(st.seats)) return [];
      if (st.phase === 'draw') return seatCanvases(state, game, `tel.${st.run}`, st.seats, st.k, (p) => st.seats[p]);
      if (st.phase === 'text' && Array.isArray(st.dby)) return seatCanvases(state, game, `tel.${st.run}`, st.seats, st.dk, (p) => st.dby[p]);
      return [];
    }
    if (game === 'sketchduel') {
      const st = state[DUEL_KEY];
      if (!st || !Array.isArray(st.seats)) return [];
      return seatCanvases(state, game, `sd.${st.run}.${st.round}`, st.seats, st.k, (p) => st.seats[p]);
    }
    if (game === 'pixel') {
      const st = state[PIXEL_KEY];
      if (!st || !Number.isInteger(st.n)) return [];
      const counts = state[COUNTS] && typeof state[COUNTS] === 'object' ? state[COUNTS] : {};
      return [{ key: pixelId(st), game, kind: 'pixel', n: st.n, grid: readGrid((k) => state[k]), counts }];
    }
  } catch {
    return [];
  }
  return [];
}

const WATCH = Object.freeze({ draw: ['draw', 'ink.'], odd: ['odd', 'ink.'], telephone: ['tel'], sketchduel: ['sketchduel', 'sd.'], pixel: ['pixel'] });

function refsOf(snap) {
  const prefixes = WATCH[snap.room.game];
  if (!prefixes || !snap.state) return [];
  const keys = Object.keys(snap.state).filter((k) => prefixes.some((p) => k.startsWith(p))).sort();
  return keys.flatMap((k) => [k, snap.state[k]]);
}

function sameRefs(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameItem(a, b) {
  return a.slot === b.slot && a.s === b.s;
}

function paintsOf(data) {
  const list = data && data.t === 'many' && Array.isArray(data.m) ? data.m : [data];
  const out = [];
  for (const x of list) {
    if (!x || x.t !== 'g' || x.g !== 'pixel' || !x.a || x.a.type !== 'paint') continue;
    const cells = decodeCells(x.a.c);
    if (cells && Number.isInteger(x.a.n)) out.push({ n: x.a.n, cells });
  }
  return out;
}

export function createReplayLog({ now = () => Date.now(), canvases = LOG_CANVASES, events = LOG_EVENTS } = {}) {
  let round = null;
  const logs = new Map();
  const people = new Map();
  const ids = new Map();
  let host = null;
  let claims = new Map();
  let lastRefs = null;

  function reset(r) {
    round = r;
    logs.clear();
    claims = new Map();
    lastRefs = null;
  }

  function push(log, e) {
    log.events.push(e);
    log.touched = now();
    if (log.events.length > events) {
      const drop = log.events.length - events;
      const kept = log.events.slice(drop);
      const raws = dropOldest(log.events.map((x) => x.raw), drop);
      kept.forEach((x, i) => {
        x.raw = raws[i];
      });
      log.events = kept;
      log.truncated = true;
    }
  }

  function open(c, at) {
    let log = logs.get(c.key);
    if (log) return log;
    log = { key: c.key, game: c.game, kind: c.kind, start: at, events: [], seen: [], grid: PIXEL_BLANK.repeat(PIXEL_CELLS), counts: {}, used: new Map(), loose: [], late: false, truncated: false, touched: at };
    logs.set(c.key, log);
    while (logs.size > canvases) {
      let oldest = null;
      for (const x of logs.values()) if (!oldest || x.touched < oldest.touched) oldest = x;
      logs.delete(oldest.key);
    }
    return log;
  }

  function stamp(log, at) {
    const last = log.events.length ? log.events[log.events.length - 1].raw[1] : 0;
    return Math.max(last, Math.max(0, Math.round(at - log.start)));
  }

  function addInk(log, item, t) {
    const e = { slot: item.slot, raw: [item.slot, t, item.s] };
    push(log, e);
    log.seen.push({ slot: item.slot, s: item.s, e });
  }

  function cutInk(log, n, slot, t) {
    log.seen.length = n;
    push(log, { slot, raw: [slot, t, n] });
  }

  function syncInk(log, items, at, fresh) {
    const old = log.seen;
    if (fresh && items.length) log.late = true;
    const t = stamp(log, at);
    let p = 0;
    while (p < old.length && p < items.length && sameItem(old[p], items[p])) p += 1;
    if (p === old.length && p === items.length) return false;
    if (p < old.length && items.length >= old.length && old.every((x, i) => x.slot === items[i].slot)) {
      for (let i = p; i < old.length; i += 1) {
        old[i].s = items[i].s;
        old[i].e.raw[2] = items[i].s;
      }
      p = old.length;
    }
    if (p < old.length) cutInk(log, p, (old[old.length - 1] || {}).slot, t);
    for (let i = p; i < items.length; i += 1) addInk(log, items[i], t);
    return true;
  }

  function slotOfId(id) {
    return ids.has(id) ? ids.get(id) : null;
  }

  function credit(log) {
    const out = new Map();
    for (const [slot, n] of Object.entries(log.counts || {})) {
      const left = (Number.isInteger(n) ? n : 0) - (log.used.get(Number(slot)) || 0);
      if (left > 0) out.set(Number(slot), left);
    }
    return out;
  }

  function place(log, slot, i, code, t) {
    log.used.set(slot, (log.used.get(slot) || 0) + 1);
    push(log, { slot, raw: [slot, stamp(log, log.start + t), i, code] });
  }

  function settleLoose(log, at, force) {
    if (!log.loose.length) return;
    const left = credit(log);
    const keep = [];
    for (const x of log.loose) {
      if (log.grid[x.i] !== x.code) continue;
      let slot = null;
      for (const [s, n] of left) {
        if (n > 0 && (slot === null || n > left.get(slot))) slot = s;
      }
      if (slot === null && (force || at - x.at > LOOSE_MS)) slot = Number.isInteger(host) ? host : null;
      if (slot === null) {
        keep.push(x);
        continue;
      }
      if (left.has(slot)) left.set(slot, left.get(slot) - 1);
      place(log, slot, x.i, x.code, Math.max(0, Math.round(x.at - log.start)));
    }
    log.loose = keep;
  }

  function syncPixel(log, c, at, fresh) {
    log.counts = { ...c.counts };
    if (log.grid === c.grid) {
      settleLoose(log, at, false);
      return false;
    }
    if (fresh && c.grid !== PIXEL_BLANK.repeat(PIXEL_CELLS)) log.late = true;
    const changed = [];
    for (let i = 0; i < PIXEL_CELLS; i += 1) if (c.grid[i] !== log.grid[i]) changed.push(i);
    log.grid = c.grid;
    const moved = new Set(changed);
    if (log.loose.length) log.loose = log.loose.filter((x) => !moved.has(x.i));
    for (const i of changed) {
      const code = c.grid[i];
      const claim = claims.get(`${c.n}.${i}`);
      if (claim && claim.c === code) {
        claims.delete(`${c.n}.${i}`);
        place(log, claim.slot, i, code, Math.max(0, Math.round(claim.at - log.start)));
      } else {
        log.loose.push({ i, code, at });
      }
    }
    settleLoose(log, at, false);
    return true;
  }

  function observe(snap) {
    if (!snap || !snap.room || snap.room.phase !== 'game') return false;
    const r = `${snap.room.game}:${snap.room.round}`;
    if (r !== round) reset(r);
    for (const p of Array.isArray(snap.players) ? snap.players : []) {
      if (!Number.isInteger(p.slot) || typeof p.id !== 'string') continue;
      people.set(p.slot, { id: p.id, name: typeof p.name === 'string' ? p.name : 'Player' });
      ids.set(p.id, p.slot);
      if (p.isHost) host = p.slot;
    }
    while (people.size > 200) people.delete(people.keys().next().value);
    while (ids.size > 200) ids.delete(ids.keys().next().value);
    const refs = refsOf(snap);
    if (sameRefs(refs, lastRefs)) return false;
    lastRefs = refs;
    const at = now();
    let hit = false;
    for (const c of canvasesOf(snap)) {
      const fresh = !logs.has(c.key);
      const log = open(c, at);
      if (c.kind === 'pixel' ? syncPixel(log, c, at, fresh) : syncInk(log, c.items, at, fresh)) hit = true;
    }
    return hit;
  }

  function hear(data, by) {
    if (!round || !round.startsWith('pixel:') || typeof by !== 'string') return 0;
    const slot = slotOfId(by);
    if (!Number.isInteger(slot)) return 0;
    const at = now();
    let n = 0;
    for (const x of paintsOf(data)) {
      for (const [i, c] of x.cells) {
        const key = `${x.n}.${i}`;
        claims.delete(key);
        claims.set(key, { slot, c, at });
        n += 1;
      }
    }
    while (claims.size > LOG_CLAIMS) claims.delete(claims.keys().next().value);
    return n;
  }

  function pick(game, item) {
    if (!item || typeof item.d !== 'string') return null;
    if (logs.has(item.d) && logs.get(item.d).game === game) return logs.get(item.d);
    if (game === 'pixel') return null;
    const want = (Array.isArray(item.ink) ? item.ink : []).filter((s) => typeof s === 'string');
    if (!want.length) return null;
    let best = null;
    let score = 0;
    for (const log of logs.values()) {
      if (log.game !== game || !log.seen.length) continue;
      const have = new Set(log.seen.map((x) => x.s));
      let n = 0;
      for (const s of want) if (have.has(s)) n += 1;
      const exact = log.seen.length === want.length && n === want.length;
      const v = n / want.length + (exact ? 1 : 0);
      if (v > score || (v === score && best && log.touched > best.touched)) {
        best = log;
        score = v;
      }
    }
    return best && score >= MATCH_MIN ? best : null;
  }

  function replayFor(game, item) {
    const log = pick(game, item);
    if (log && log.kind === 'pixel') settleLoose(log, now(), true);
    if (!log || !log.events.length) return null;
    const slots = [];
    const index = new Map();
    const events = [];
    for (const e of log.events) {
      const who = people.get(e.slot);
      if (!who) continue;
      if (!index.has(e.slot)) {
        index.set(e.slot, slots.length);
        slots.push(who);
      }
      events.push([index.get(e.slot), ...e.raw.slice(1)]);
    }
    const out = { kind: log.kind, authors: slots.map((p) => ({ id: p.id, name: p.name })), events };
    if (log.kind === 'pixel') out.grid = log.grid;
    if (log.late) out.late = true;
    if (log.truncated) out.truncated = true;
    return trimReplay(out);
  }

  return {
    observe,
    hear,
    replayFor,
    clear() {
      reset(null);
    },
    get size() {
      return logs.size;
    },
    logOf(key) {
      const log = logs.get(key);
      return log ? { key: log.key, kind: log.kind, late: log.late, truncated: log.truncated, loose: log.loose.length, events: log.events.map((e) => e.raw.slice()) } : null;
    },
  };
}

export const replayLog = createReplayLog();

export function topPainter(replay, notId) {
  if (!replay || !Array.isArray(replay.authors)) return null;
  const counts = replay.authors.map(() => 0);
  for (const e of replay.events || []) counts[e[0]] += 1;
  let best = -1;
  replay.authors.forEach((a, i) => {
    if (a.id === notId || !counts[i]) return;
    if (best < 0 || counts[i] > counts[best]) best = i;
  });
  return best >= 0 ? replay.authors[best] : null;
}

export function pixelReport(snap, log = replayLog) {
  const st = snap && snap.state ? snap.state[PIXEL_KEY] : null;
  if (!st || !Number.isInteger(st.n)) return null;
  const players = Array.isArray(snap.players) ? snap.players : [];
  const me = players.find((p) => p.isMe);
  if (!me || !me.id) return null;
  const replay = log.replayFor('pixel', { d: pixelId(st) });
  let drawer = topPainter(replay, me.id);
  if (!drawer) {
    const counts = snap.state[COUNTS] && typeof snap.state[COUNTS] === 'object' ? snap.state[COUNTS] : {};
    const top = Object.entries(counts)
      .map(([slot, n]) => ({ p: players.find((x) => x.slot === Number(slot)), n: Number(n) || 0 }))
      .filter((x) => x.p && x.p.id && x.p.id !== me.id && x.n > 0)
      .sort((a, b) => b.n - a.n)[0];
    drawer = top ? { id: top.p.id, name: top.p.name } : null;
  }
  if (!drawer) return null;
  const who = players.find((p) => p.id === drawer.id) || {};
  const body = {
    game: 'pixel',
    drawer: { id: drawer.id, name: drawer.name, username: who.username || null },
    reporter: { id: me.id, name: me.name },
    ink: [],
    word: typeof st.theme === 'string' ? st.theme : null,
    at: Date.now(),
  };
  if (replay && replay.authors.some((a) => a.id === drawer.id)) body.replay = replay;
  return body;
}
