import { workerClient } from './worker-post.js';

export const STATS_NS = 'stats';
const HOUR_MS = 3600_000;
const KEEP_HOURS = 24 * 14;
const HISTORY_HOURS = 24 * 8;
const HOURS_PER_POST = 48;
const MAX_ACTIVE = 5000;
const MAX_SERVERS = 5000;
const SAVE_EVERY_MS = 60_000;
const SAFE_ID = /^[\w-]{1,64}$/;

const validId = (v) => typeof v === 'string' && SAFE_ID.test(v);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

export function hourOf(t) {
  return new Date(Math.floor(t / HOUR_MS) * HOUR_MS).toISOString();
}

function blankOpen(hour) {
  return { hour, messages: 0, joins: 0, leaves: 0, ids: new Set() };
}

function cleanHour(h) {
  if (!h || typeof h !== 'object' || typeof h.hour !== 'string' || Number.isNaN(Date.parse(h.hour))) return null;
  return { hour: h.hour, messages: count(h.messages), joins: count(h.joins), leaves: count(h.leaves), active: count(h.active) };
}

function loadDoc(raw, hour) {
  const doc = { open: blankOpen(hour), pending: [], history: [] };
  if (!raw || typeof raw !== 'object') return doc;
  if (raw.open && typeof raw.open.hour === 'string') {
    const ids = Array.isArray(raw.open.ids) ? raw.open.ids.filter(validId).slice(0, MAX_ACTIVE) : [];
    doc.open = { hour: raw.open.hour, messages: count(raw.open.messages), joins: count(raw.open.joins), leaves: count(raw.open.leaves), ids: new Set(ids) };
  }
  for (const k of ['pending', 'history']) if (Array.isArray(raw[k])) doc[k] = raw[k].map(cleanHour).filter(Boolean);
  return doc;
}

function dumpDoc(doc) {
  return {
    open: { hour: doc.open.hour, messages: doc.open.messages, joins: doc.open.joins, leaves: doc.open.leaves, ids: [...doc.open.ids] },
    pending: doc.pending,
    history: doc.history,
  };
}

function closeOpen(doc) {
  const o = doc.open;
  const row = { hour: o.hour, messages: o.messages, joins: o.joins, leaves: o.leaves, active: o.ids.size };
  if (row.messages || row.joins || row.leaves) {
    doc.pending.push(row);
    doc.history.push(row);
  }
  if (doc.pending.length > KEEP_HOURS) doc.pending.splice(0, doc.pending.length - KEEP_HOURS);
  if (doc.history.length > HISTORY_HOURS) doc.history.splice(0, doc.history.length - HISTORY_HOURS);
}

export function createStats(engine, { now = null, fetch = null } = {}) {
  const clock = () => {
    if (typeof now === 'function') return now();
    const t = engine.scheduler?.now?.();
    return Number.isFinite(t) ? t : Date.now();
  };
  const client = workerClient(engine, { fetch });
  const docs = new Map();
  const dirty = new Set();
  const listeners = [];
  let savedAt = clock();
  let flushing = null;
  let exitHook = null;

  function docOf(sid) {
    let d = docs.get(sid);
    if (!d) {
      if (docs.size >= MAX_SERVERS) {
        saveAll();
        docs.clear();
      }
      d = loadDoc(engine.store.get(STATS_NS, sid, null), hourOf(clock()));
      docs.set(sid, d);
    }
    roll(d);
    return d;
  }

  function roll(d) {
    const cur = hourOf(clock());
    if (d.open.hour === cur) return;
    if (d.open.hour < cur) closeOpen(d);
    d.open = blankOpen(cur);
  }

  function saveAll() {
    for (const sid of dirty) {
      const d = docs.get(sid);
      if (d) engine.store.set(STATS_NS, sid, dumpDoc(d));
    }
    dirty.clear();
    savedAt = clock();
  }

  function maybeSave() {
    if (clock() - savedAt >= SAVE_EVERY_MS) saveAll();
  }

  function record(kind, sid, uid = null) {
    if (!validId(sid)) return false;
    const d = docOf(sid);
    if (kind === 'message') {
      d.open.messages++;
      if (validId(uid) && d.open.ids.size < MAX_ACTIVE) d.open.ids.add(uid);
    } else if (kind === 'join') d.open.joins++;
    else if (kind === 'leave') d.open.leaves++;
    else return false;
    dirty.add(sid);
    maybeSave();
    return true;
  }

  function onMessage(msg) {
    if (!msg || msg.author_bot || msg.dm) return;
    const uid = msg.author_id ?? msg.author?.id ?? null;
    if (uid && uid === engine.bot.me?.id) return;
    record('message', msg.server_id, uid);
  }
  const onJoin = (ev) => {
    const uid = ev?.user_id ?? ev?.member?.id ?? null;
    if (uid && uid === engine.bot.me?.id) return;
    record('join', ev?.server_id);
  };
  const onLeave = (ev) => {
    const uid = ev?.user_id ?? ev?.member?.id ?? null;
    if (uid && uid === engine.bot.me?.id) return;
    record('leave', ev?.server_id);
  };

  function hours(sid, { since = 0 } = {}) {
    if (!validId(sid)) return [];
    const d = docOf(sid);
    const list = d.history.filter((h) => Date.parse(h.hour) >= since);
    const o = d.open;
    if (o.messages || o.joins || o.leaves) list.push({ hour: o.hour, messages: o.messages, joins: o.joins, leaves: o.leaves, active: o.ids.size });
    return list;
  }

  function totals(sid, since) {
    const out = { messages: 0, joins: 0, leaves: 0 };
    for (const h of hours(sid, { since })) {
      out.messages += h.messages;
      out.joins += h.joins;
      out.leaves += h.leaves;
    }
    return out;
  }

  function loadAllKeys() {
    const keys = engine.store.keys ? [...engine.store.keys(STATS_NS)] : [];
    for (const k of keys) if (validId(k) && !docs.has(k)) docOf(k);
  }

  async function runFlush() {
    loadAllKeys();
    let sent = 0;
    let failed = 0;
    for (const [sid, d] of docs) {
      roll(d);
      dirty.add(sid);
      if (!d.pending.length) continue;
      if (!client.enabled) continue;
      while (d.pending.length) {
        const batch = d.pending.slice(0, HOURS_PER_POST);
        const r = await client.post('/bot/stats', { server_id: sid, hours: batch });
        if (!r.ok) {
          failed++;
          engine.log?.debug?.(`[stats] upload answered ${r.status}`);
          break;
        }
        d.pending.splice(0, batch.length);
        sent += batch.length;
      }
    }
    saveAll();
    return { sent, failed };
  }

  function flush() {
    if (flushing) return flushing;
    flushing = runFlush().finally(() => { flushing = null; });
    return flushing;
  }

  return {
    record,
    hours,
    totals,
    flush,
    save: saveAll,
    pending: (sid) => (validId(sid) ? docOf(sid).pending.map((h) => ({ ...h })) : []),
    install() {
      if (listeners.length) return;
      const add = (event, fn) => {
        engine.bot.on(event, fn);
        listeners.push([event, fn]);
      };
      add('message', onMessage);
      add('member_join', onJoin);
      add('member_leave', onLeave);
      if (engine.store.beforeExit?.add) {
        exitHook = () => saveAll();
        engine.store.beforeExit.add(exitHook);
      }
    },
    uninstall() {
      for (const [event, fn] of listeners.splice(0)) {
        const list = engine.bot.handlers?.[event];
        if (!Array.isArray(list)) continue;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      }
      if (exitHook) engine.store.beforeExit?.delete?.(exitHook);
      exitHook = null;
      saveAll();
    },
  };
}

export function ensureStats(engine, opts) {
  if (!engine.serverStats) {
    engine.serverStats = createStats(engine, opts);
    engine.serverStats.install();
  }
  return engine.serverStats;
}

export function dropStats(engine) {
  if (!engine.serverStats) return;
  engine.serverStats.uninstall();
  engine.serverStats = null;
}
