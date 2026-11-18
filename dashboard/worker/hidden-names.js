export const HIDDEN_NAME = 'Hidden name';
export const HIDDEN_HANDLE = 'hidden';
export const HIDE_KINDS = Object.freeze(['name', 'username']);
export const HIDDEN_NAMES_TTL = 30_000;
export const HIDDEN_NAMES_MAX = 5000;
export const HINT_LENGTH = 6;

const cache = new WeakMap();
const lower = (v) => String(v ?? '').toLowerCase();

export function hintOf(id) {
  return lower(id).replace(/[^a-z0-9]/g, '').slice(0, HINT_LENGTH);
}

async function readAll(db) {
  const res = await db.prepare('SELECT user_id, kind FROM party_hidden_names ORDER BY at DESC LIMIT ?').bind(HIDDEN_NAMES_MAX).all();
  const map = new Map();
  for (const r of (res && res.results) || []) {
    const id = lower(r.user_id);
    if (!HIDE_KINDS.includes(r.kind)) continue;
    const cur = map.get(id) || { name: false, username: false };
    cur[r.kind] = true;
    map.set(id, cur);
  }
  return map;
}

export async function hiddenNameMap(db, t = Date.now()) {
  if (!db) return new Map();
  const entry = cache.get(db);
  if (entry && entry.at + HIDDEN_NAMES_TTL >= t && entry.at <= t) return entry.map;
  let map;
  try {
    map = await readAll(db);
  } catch {
    return entry ? entry.map : new Map();
  }
  cache.set(db, { at: t, map });
  return map;
}

export function clearHiddenNames(db) {
  if (db) cache.delete(db);
}

export function flagsFor(map, id) {
  const f = map && id ? map.get(lower(id)) : null;
  return f && (f.name || f.username) ? f : null;
}

function sameHandle(name, handle) {
  if (typeof name !== 'string' || typeof handle !== 'string' || !handle) return false;
  return name.replace(/^@+/, '').trim().toLowerCase() === handle.replace(/^@+/, '').toLowerCase();
}

export function maskEntry(entry, flags, id, keys = {}) {
  if (!flags || !entry || typeof entry !== 'object') return entry;
  const nameKeys = keys.name || ['name'];
  const userKeys = keys.username || ['username'];
  const out = { ...entry };
  const handles = userKeys.map((k) => out[k]).filter((v) => typeof v === 'string' && v);
  if (flags.username) {
    for (const k of userKeys) if (k in out) out[k] = null;
    for (const k of nameKeys) if (typeof out[k] === 'string' && handles.some((u) => sameHandle(out[k], u))) out[k] = HIDDEN_NAME;
    if (keys.link) for (const k of keys.link) if (k in out) out[k] = false;
    out.usernameHidden = true;
  }
  if (flags.name) {
    nameKeys.forEach((k, i) => {
      if (i === 0 || k in out) out[k] = HIDDEN_NAME;
    });
    out.nameHidden = true;
  }
  out.hint = hintOf(id);
  return out;
}

export async function maskList(db, list, t, keys = {}, idKey = 'id') {
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];
  const map = await hiddenNameMap(db, t);
  if (!map.size) return list;
  return list.map((r) => (r && typeof r === 'object' && typeof r[idKey] === 'string' ? maskEntry(r, flagsFor(map, r[idKey]), r[idKey], keys) : r));
}

export async function hiddenRows(db, id) {
  const res = await db.prepare('SELECT kind, reason, by_id, by_name, at FROM party_hidden_names WHERE user_id = ?').bind(lower(id)).all();
  const out = { name: null, username: null };
  for (const r of (res && res.results) || []) {
    if (!HIDE_KINDS.includes(r.kind)) continue;
    out[r.kind] = { reason: r.reason || null, by: r.by_id, byName: r.by_name || null, at: Number(r.at) || 0 };
  }
  return out;
}

export async function staffHiddenFlags(db, ids) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && x).map(lower))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const res = await db.prepare(`SELECT user_id, kind FROM party_hidden_names WHERE user_id IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
    for (const r of (res && res.results) || []) {
      if (!HIDE_KINDS.includes(r.kind)) continue;
      const id = lower(r.user_id);
      const cur = out.get(id) || { name: false, username: false };
      cur[r.kind] = true;
      out.set(id, cur);
    }
  }
  return out;
}
