const TTL_MS = 60_000;
const MAX_ENTRIES = 5000;

const caches = new WeakMap();
function cacheOf(engine) {
  let c = caches.get(engine);
  if (!c) { c = new Map(); caches.set(engine, c); }
  return c;
}

const nowOf = (engine) => engine.scheduler?.now?.() ?? Date.now();

async function remember(engine, key, fn) {
  const c = cacheOf(engine);
  const now = nowOf(engine);
  const hit = c.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  c.delete(key);
  c.set(key, { at: now, value });
  while (c.size > MAX_ENTRIES) c.delete(c.keys().next().value);
  return value;
}

export function forgetVisibility(engine) {
  cacheOf(engine).clear();
}

const listOf = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).filter((k) => v[k]) : []);
const denies = (o, perm) => listOf(o?.deny).includes(perm);
const allows = (o, perm) => listOf(o?.allow).includes(perm);
const isEveryone = (o, sid) => o?.role_id === null || o?.role_id === undefined || o?.role_id === 'everyone' || o?.role_id === sid;

async function channelOf(engine, sid, channelId) {
  const all = await engine.cache.channels(sid).catch(() => null);
  return Array.isArray(all) ? all.find((c) => c.id === channelId) || null : null;
}

async function overridesOf(engine, channelId) {
  return remember(engine, `o:${channelId}`, async () => {
    const list = await engine.bot.channelPermissions(channelId);
    return Array.isArray(list) ? list : [];
  });
}

export async function isPublicChannel(engine, sid, channelId) {
  if (!sid || !channelId) return false;
  try {
    return await remember(engine, `p:${sid}:${channelId}`, async () => {
      const ch = await channelOf(engine, sid, channelId);
      if (!ch || ch.private) return false;
      const overrides = await overridesOf(engine, channelId);
      return !overrides.some((o) => isEveryone(o, sid) && denies(o, 'view_channel'));
    });
  } catch {
    return false;
  }
}

async function isRealAdmin(engine, sid, uid) {
  const server = await engine.perms.server(sid).catch(() => null);
  if (server?.owner_id && server.owner_id === uid) return true;
  const p = await engine.perms.permsOf(sid, uid).catch(() => ({}));
  return !!p.administrator;
}

async function fallbackCanSee(engine, sid, uid, ch, member) {
  if (await isRealAdmin(engine, sid, uid)) return true;
  const mine = new Set(member.roles || []);
  if (ch.private) {
    const allowed = ch.role_ids || ch.roleIds || ch.allowed_role_ids || null;
    if (!Array.isArray(allowed) || !allowed.some((r) => mine.has(r))) return false;
  }
  const overrides = await overridesOf(engine, ch.id);
  const roleAllows = overrides.some((o) => !isEveryone(o, sid) && mine.has(o.role_id) && allows(o, 'view_channel'));
  if (roleAllows) return true;
  const roleDenies = overrides.some((o) => !isEveryone(o, sid) && mine.has(o.role_id) && denies(o, 'view_channel'));
  if (roleDenies) return false;
  return !overrides.some((o) => isEveryone(o, sid) && denies(o, 'view_channel'));
}

export async function canMemberSee(engine, sid, uid, channelId) {
  if (!sid || !uid || !channelId) return false;
  try {
    return await remember(engine, `s:${sid}:${channelId}:${uid}`, async () => {
      const member = await engine.perms.member(sid, uid).catch(() => null);
      if (!member) return false;
      const ch = await channelOf(engine, sid, channelId);
      if (!ch) return false;
      let direct = null;
      try {
        direct = typeof engine.bot.getPermissions === 'function' ? await engine.bot.getPermissions(sid, uid, channelId) : null;
      } catch {
        direct = null;
      }
      if (direct && typeof direct === 'object') {
        if (direct.owner || direct.administrator) return true;
        const view = direct.permissions?.view_channel;
        if (view === true) return true;
        if (view === false) return false;
      }
      return await fallbackCanSee(engine, sid, uid, ch, member);
    });
  } catch {
    return false;
  }
}
