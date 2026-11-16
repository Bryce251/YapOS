export const GLOBAL_KEY = 'global';
export const CURRENCY = { name: 'Shards', emoji: '💎' };

const asId = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const globalConfig = (engine, appId) => engine.settings.appConfig(GLOBAL_KEY, appId);
export const patchGlobalConfig = (engine, appId, patch) => engine.settings.patchApp(GLOBAL_KEY, appId, patch);

export function globalDoc(engine, ns, blank) {
  return engine.store.get(ns, GLOBAL_KEY, blank);
}

export function mutateGlobal(engine, ns, fn, blank) {
  let out;
  engine.store.update(ns, GLOBAL_KEY, (d) => { out = fn(d); }, blank);
  return out;
}

export function serverKeys(engine, ns) {
  const keys = engine.store.keys ? engine.store.keys(ns) : [];
  return [...keys].filter((k) => k !== GLOBAL_KEY);
}

export function mergeOnce(engine, ns, { blank, fold, flag = 'merged' }) {
  const doc = globalDoc(engine, ns, blank());
  if (doc && doc[flag]) return { merged: false, servers: 0 };
  let servers = 0;
  const out = mutateGlobal(engine, ns, (d) => {
    if (d[flag]) return { merged: false, servers: 0 };
    for (const key of serverKeys(engine, ns)) {
      const from = engine.store.get(ns, key, null);
      if (!from) continue;
      servers += 1;
      fold(d, from, key);
    }
    d[flag] = true;
    return { merged: true, servers };
  }, blank());
  return out || { merged: true, servers };
}

export function ownerIds(engine) {
  const list = globalDoc(engine, 'economy', {}).givers;
  return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
}

export function canGiveCurrency(engine, uid) {
  const id = asId(uid);
  if (!id) return false;
  if (engine.isBotOwner?.(id)) return true;
  return ownerIds(engine).includes(id);
}

export function allowGiver(engine, uid) {
  const id = asId(uid);
  if (!id) return ownerIds(engine);
  return mutateGlobal(engine, 'economy', (d) => {
    d.givers = Array.isArray(d.givers) ? d.givers : [];
    if (!d.givers.includes(id)) d.givers.push(id);
    return d.givers.slice();
  }, {});
}

export function denyGiver(engine, uid) {
  const id = asId(uid);
  if (!id) return ownerIds(engine);
  return mutateGlobal(engine, 'economy', (d) => {
    d.givers = (Array.isArray(d.givers) ? d.givers : []).filter((x) => x !== id);
    return d.givers.slice();
  }, {});
}

export const SEASON_NS = 'season';
export const SEASON_TOP = 10;
export const SEASON_KINDS = Object.freeze(['xp', 'shards']);
const SEASON_HISTORY = 36;
const SEASON_BADGES_PER_USER = 60;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const clockOf = (engine) => {
  const t = engine?.scheduler?.now?.();
  return Number.isFinite(t) ? t : Date.now();
};

export function seasonMonth(t = Date.now()) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function seasonName(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return 'this season';
  return `${MONTHS[Number(m[2]) - 1] || 'Unknown'} ${m[1]}`;
}

export function seasonEndsAt(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const blankSeason = () => ({ month: null, xp: {}, shards: {}, badges: {}, history: {} });

function fixSeason(d) {
  const doc = d && typeof d === 'object' ? d : blankSeason();
  for (const k of [...SEASON_KINDS, 'badges', 'history']) if (!doc[k] || typeof doc[k] !== 'object' || Array.isArray(doc[k])) doc[k] = {};
  if (typeof doc.month !== 'string') doc.month = null;
  return doc;
}

export function seasonTop(scores, size = SEASON_TOP) {
  return Object.entries(scores || {})
    .map(([id, n]) => [id, Math.max(0, Math.floor(Number(n) || 0))])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, size);
}

function closeMonth(d) {
  const month = d.month;
  const tops = {};
  for (const kind of SEASON_KINDS) {
    const top = seasonTop(d[kind]);
    tops[kind] = top;
    top.forEach(([uid, score], i) => {
      const list = Array.isArray(d.badges[uid]) ? d.badges[uid] : [];
      if (!list.some((b) => b && b.month === month && b.kind === kind)) list.push({ month, kind, rank: i + 1, score });
      if (list.length > SEASON_BADGES_PER_USER) list.splice(0, list.length - SEASON_BADGES_PER_USER);
      d.badges[uid] = list;
    });
  }
  d.history[month] = tops;
  const months = Object.keys(d.history).sort();
  for (const old of months.slice(0, Math.max(0, months.length - SEASON_HISTORY))) delete d.history[old];
  for (const kind of SEASON_KINDS) d[kind] = {};
  return { month, tops };
}

function rollIn(d, now) {
  fixSeason(d);
  const cur = seasonMonth(now);
  if (!d.month) { d.month = cur; return null; }
  if (d.month >= cur) return null;
  const closed = closeMonth(d);
  d.month = cur;
  return closed;
}

function announceSeason(engine, closed) {
  if (!closed?.month || typeof engine?.bot?.emit !== 'function') return;
  try {
    Promise.resolve(engine.bot.emit('season:closed', { month: closed.month, boards: closed.tops })).catch((e) => engine.log?.debug?.('[season] closing listeners failed', e?.message));
  } catch (e) {
    engine.log?.debug?.('[season] closing listeners failed', e?.message);
  }
}

export function rollSeason(engine, now = clockOf(engine)) {
  const doc = fixSeason(globalDoc(engine, SEASON_NS, null));
  if (doc.month && doc.month >= seasonMonth(now)) return null;
  const closed = mutateGlobal(engine, SEASON_NS, (d) => rollIn(d, now), blankSeason());
  announceSeason(engine, closed);
  return closed;
}

export function addSeason(engine, kind, uid, amount, now = clockOf(engine)) {
  const id = asId(uid);
  const n = Math.floor(Number(amount) || 0);
  if (!id || n <= 0 || !SEASON_KINDS.includes(kind)) return 0;
  let closed = null;
  const total = mutateGlobal(engine, SEASON_NS, (d) => {
    closed = rollIn(d, now);
    const next = Math.max(0, Math.floor(Number(d[kind][id]) || 0)) + n;
    d[kind][id] = Math.min(Number.MAX_SAFE_INTEGER, next);
    return d[kind][id];
  }, blankSeason());
  announceSeason(engine, closed);
  return total;
}

export function seasonBoard(engine, kind, now = clockOf(engine)) {
  rollSeason(engine, now);
  const doc = fixSeason(globalDoc(engine, SEASON_NS, null));
  const list = seasonTop(doc[kind], Infinity).map(([id, score]) => ({ id, score }));
  return { month: doc.month || seasonMonth(now), endsAt: seasonEndsAt(now), list };
}

export function seasonScore(engine, kind, uid, now = clockOf(engine)) {
  rollSeason(engine, now);
  const doc = fixSeason(globalDoc(engine, SEASON_NS, null));
  return Math.max(0, Math.floor(Number(doc[kind]?.[uid]) || 0));
}

export function seasonBadges(engine, uid) {
  const doc = fixSeason(globalDoc(engine, SEASON_NS, null));
  const list = Array.isArray(doc.badges[uid]) ? doc.badges[uid] : [];
  return list.filter((b) => b && typeof b.month === 'string' && SEASON_KINDS.includes(b.kind) && Number.isInteger(b.rank))
    .slice()
    .sort((a, b) => b.month.localeCompare(a.month) || a.rank - b.rank);
}

export function seasonBadgeText(b) {
  const medal = ['🥇', '🥈', '🥉'][b.rank - 1] || '🏅';
  return `${medal} #${b.rank} ${b.kind === 'xp' ? 'XP' : CURRENCY.name} · ${seasonName(b.month)}`;
}
