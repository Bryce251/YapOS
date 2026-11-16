import { GLOBAL_KEY, seasonBadges } from './global.js';

export const PROFILE_NS = 'profile';
const SAFE_ID = /^[\w-]{1,64}$/;
const ACH_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
const MAX_ACHIEVEMENTS = 200;
const MAX_SEASON = 24;
const MAX_TEXT = 64;
const PARTY_MS = 1500;

export const validId = (v) => typeof v === 'string' && SAFE_ID.test(v);

export function cleanText(v, max = MAX_TEXT) {
  if (typeof v !== 'string') return null;
  const text = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? Array.from(text).slice(0, max).join('') : null;
}

export function privacyOf(engine, uid) {
  const raw = validId(uid) ? engine.store.get(PROFILE_NS, uid, null) : null;
  return { hidden: raw?.hidden === true, showShards: raw?.showShards === true };
}

export function setPrivacy(engine, uid, patch = {}) {
  if (!validId(uid)) return privacyOf(engine, uid);
  let out;
  engine.store.update(PROFILE_NS, uid, (cur) => {
    const doc = cur && typeof cur === 'object' ? cur : {};
    if (typeof patch.hidden === 'boolean') doc.hidden = patch.hidden;
    if (typeof patch.showShards === 'boolean') doc.showShards = patch.showShards;
    out = { hidden: doc.hidden === true, showShards: doc.showShards === true };
    return doc;
  }, {});
  return out;
}

export function clanOf(engine, uid) {
  try {
    const c = engine.clans?.getClanOf?.(uid);
    if (!c || typeof c !== 'object') return null;
    const name = cleanText(c.name, 32);
    if (!name) return null;
    const tag = cleanText(c.tag, 6);
    const colour = typeof c.colour === 'string' && /^#[0-9a-f]{6}$/i.test(c.colour) ? c.colour.toLowerCase() : null;
    return { name, tag, colour };
  } catch {
    return null;
  }
}

export function achievementsOf(engine, uid) {
  const tries = [
    () => engine.achievements?.idsOf?.(uid),
    () => engine.service?.('achievements')?.idsOf?.(uid),
    () => engine.service?.('achievements')?.unlocked?.(uid),
    () => engine.service?.('achievements')?.list?.(uid),
  ];
  for (const fn of tries) {
    let got;
    try { got = fn(); } catch { got = undefined; }
    if (!Array.isArray(got)) continue;
    const ids = got.map((a) => (typeof a === 'string' ? a : a?.id)).filter((a) => typeof a === 'string' && ACH_RE.test(a));
    return [...new Set(ids)].slice(0, MAX_ACHIEVEMENTS);
  }
  return [];
}

export function seasonPlacings(engine, uid) {
  try {
    return seasonBadges(engine, uid).slice(0, MAX_SEASON).map((b) => ({ month: b.month, rank: b.rank, kind: b.kind }));
  } catch {
    return [];
  }
}

export function levelOf(engine, uid) {
  const levels = engine.service?.('levels');
  if (!levels?.getUser) return null;
  try {
    const u = levels.getUser(null, uid);
    const xp = Math.max(0, Math.floor(Number(u?.xp) || 0));
    const level = Number.isInteger(u?.level) ? u.level : typeof levels.levelFor === 'function' ? levels.levelFor(xp) : 0;
    const into = Math.max(0, Math.floor(Number(u?.into) || 0));
    const need = Math.max(0, Math.floor(Number(u?.need) || 0));
    const frac = need ? Math.max(0, Math.min(1, into / need)) : 0;
    return { xp, level, into, need, frac };
  } catch {
    return null;
  }
}

export function shardsOf(engine, uid) {
  const eco = engine.service?.('economy');
  if (!eco?.balance) return null;
  try {
    const n = Number(eco.balance(GLOBAL_KEY, uid));
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  } catch {
    return null;
  }
}

export function questsOf(engine, uid) {
  const q = engine.service?.('quests');
  if (!q?.today) return null;
  try {
    const t = q.today(uid);
    const list = Array.isArray(t?.quests) ? t.quests : [];
    if (!list.length) return null;
    return { done: list.filter((x) => x && x.claimed === true).length, total: list.length };
  } catch {
    return null;
  }
}

export async function partyOf(engine, uid, { timeoutMs = PARTY_MS } = {}) {
  const fn = engine.dashboard?.partyStats;
  if (typeof fn !== 'function') return null;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const got = await Promise.race([Promise.resolve().then(() => fn([uid])).catch(() => null), late]);
    return got?.[uid] || null;
  } finally {
    clearTimeout(timer);
  }
}

export async function partyMany(engine, ids) {
  const fn = engine.dashboard?.partyStats;
  if (typeof fn !== 'function' || !ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 25) {
    try {
      Object.assign(out, (await fn(ids.slice(i, i + 25))) || {});
    } catch {
      break;
    }
  }
  return out;
}

export function profileData(engine, uid, { party = null } = {}) {
  const privacy = privacyOf(engine, uid);
  return {
    id: uid,
    level: levelOf(engine, uid),
    shards: shardsOf(engine, uid),
    privacy,
    party: party && typeof party === 'object' ? party : null,
    season: seasonPlacings(engine, uid),
    quests: questsOf(engine, uid),
    clan: clanOf(engine, uid),
    achievements: achievementsOf(engine, uid),
  };
}

export function publicSnapshot(data, { name = null, username = null } = {}) {
  const base = { id: data.id, name: cleanText(name) || cleanText(username) || 'Someone', username: cleanText(username, 32) };
  if (data.privacy?.hidden) {
    return { ...base, level: 0, xp: 0, shards: null, badges: [], achievements: [], season: [], clan: null, hidden: true };
  }
  return {
    ...base,
    level: data.level?.level ?? 0,
    xp: data.level?.xp ?? 0,
    shards: data.privacy?.showShards && Number.isFinite(data.shards) ? data.shards : null,
    badges: Array.isArray(data.party?.badges) ? data.party.badges.slice(0, 40) : [],
    achievements: data.achievements || [],
    season: data.season || [],
    clan: data.clan || null,
    hidden: false,
  };
}
