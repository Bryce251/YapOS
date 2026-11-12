import { friendly, permName } from './errors.js';

const LEVELS = ['member', 'mod', 'admin', 'owner'];
const ADMIN_PERMS = ['administrator', 'manage_server'];
const MOD_PERMS = ['kick_members', 'ban_members', 'timeout_members', 'manage_messages'];

export function createPerms({ bot, settings, cacheMs = 60_000, now = () => Date.now() }) {
  const cache = new Map();
  const cached = async (key, fn) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    return value;
  };
  const invalidate = (prefix = '') => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); };

  const server = (sid) => cached(`s:${sid}`, () => bot.server(sid));
  const roles = (sid) => cached(`r:${sid}`, async () => (await bot.roles(sid)) || []);
  const member = (sid, uid) => cached(`m:${sid}:${uid}`, async () => { try { return await bot.member(sid, uid); } catch (e) { if (e.status === 404) return null; throw e; } });

  async function permsOf(sid, uid) {
    const [m, rs] = await Promise.all([member(sid, uid), roles(sid)]);
    const out = {};
    const mine = new Set(m?.roles || []);
    for (const r of rs) {
      const isEveryone = /^@?everyone$/i.test(r.name) || r.id === 'everyone' || r.id === sid;
      if (!mine.has(r.id) && !isEveryone) continue;
      for (const [k, v] of Object.entries(r.perms || {})) if (v) out[k] = true;
      if (r.manage_server) out.manage_server = true;
      if (r.manage_messages) out.manage_messages = true;
    }
    return out;
  }

  async function topPosition(sid, uid) {
    const [m, rs] = await Promise.all([member(sid, uid), roles(sid)]);
    const mine = new Set(m?.roles || []);
    let top = -1;
    for (const r of rs) if (mine.has(r.id) && typeof r.position === 'number') top = Math.max(top, r.position);
    return top;
  }

  async function level(sid, uid) {
    if (!sid || !uid) return 'member';
    const s = await server(sid).catch(() => null);
    if (s?.owner_id && s.owner_id === uid) return 'owner';
    const core = settings?.core?.(sid) || {};
    const p = await permsOf(sid, uid).catch(() => ({}));
    const m = await member(sid, uid).catch(() => null);
    const mine = new Set(m?.roles || []);
    if (ADMIN_PERMS.some((k) => p[k]) || (core.adminRoles || []).some((r) => mine.has(r))) return 'admin';
    if (MOD_PERMS.some((k) => p[k]) || (core.modRoles || []).some((r) => mine.has(r))) return 'mod';
    return 'member';
  }

  const atLeast = (have, need) => LEVELS.indexOf(have) >= LEVELS.indexOf(need);

  async function has(sid, uid, perm) {
    const p = await permsOf(sid, uid);
    return !!(p.administrator || p[perm]);
  }

  async function actorCan(sid, uid, perm) {
    const lvl = await level(sid, uid);
    if (lvl === 'owner' || lvl === 'admin') return true;
    if (await has(sid, uid, perm)) return true;
    const m = await member(sid, uid).catch(() => null);
    const mine = new Set(m?.roles || []);
    return (settings?.core?.(sid)?.modRoles || []).some((r) => mine.has(r));
  }

  async function require(sid, uid, need = 'mod') {
    const have = await level(sid, uid);
    if (!atLeast(have, need)) {
      const who = { mod: 'moderators', admin: 'admins', owner: 'the server owner' }[need] || need;
      throw friendly(`Only ${who} can use this.`, { title: 'Not allowed', hint: need === 'mod' ? 'Mods are people with Kick, Ban, Timeout or Manage Messages, or a role added with /mod modrole add.' : undefined });
    }
    return have;
  }

  const botId = () => bot.me?.id;

  async function botCan(sid, ...needs) {
    const p = await permsOf(sid, botId()).catch(() => null);
    if (!p) return { ok: true, missing: [], unknown: true };
    if (p.administrator) return { ok: true, missing: [] };
    const missing = needs.flat().filter((k) => !p[k]);
    return { ok: !missing.length, missing };
  }

  async function canActOn(sid, targetId, { actorId } = {}) {
    if (!targetId) return { ok: false, reason: 'I need to know who. Mention them, like @sam.' };
    if (targetId === botId()) return { ok: false, reason: "I can't do that to myself." };
    if (actorId && targetId === actorId) return { ok: false, reason: "You can't do that to yourself." };
    const s = await server(sid).catch(() => null);
    if (s?.owner_id === targetId) return { ok: false, reason: "That's the server owner. Nobody can moderate them." };
    const [tTop, bTop] = await Promise.all([topPosition(sid, targetId), topPosition(sid, botId())]);
    if (bTop <= tTop && tTop >= 0) return { ok: false, reason: "Their highest role is above mine (or equal). Drag my role higher in Server settings → Roles." };
    if (actorId && s?.owner_id !== actorId) {
      const aTop = await topPosition(sid, actorId);
      if (aTop <= tTop && tTop >= 0) return { ok: false, reason: 'Their highest role is above yours (or equal), so you can\'t moderate them.' };
    }
    return { ok: true };
  }

  async function canManageRole(sid, roleId) {
    const rs = await roles(sid);
    const role = rs.find((r) => r.id === roleId);
    if (!role) return { ok: false, reason: "That role doesn't exist anymore." };
    if (role.auto && role.auto !== 'none') return { ok: false, reason: `**${role.name}** is given out automatically, so nobody can hand it out.` };
    const can = await botCan(sid, 'manage_roles');
    if (!can.ok) return { ok: false, reason: `My role needs **${permName('manage_roles')}**.` };
    const bTop = await topPosition(sid, botId());
    if (typeof role.position === 'number' && role.position >= bTop) return { ok: false, reason: `My role must be above **${role.name}**. Drag it higher in Server settings → Roles.` };
    return { ok: true, role };
  }

  async function botRoleName(sid) {
    const [m, rs] = await Promise.all([member(sid, botId()).catch(() => null), roles(sid).catch(() => [])]);
    const mine = new Set(m?.roles || []);
    return rs.filter((r) => mine.has(r.id)).sort((a, b) => b.position - a.position)[0]?.name || 'YapOS';
  }

  return { level, atLeast, has, actorCan, require, botCan, canActOn, canManageRole, permsOf, topPosition, botRoleName, server, roles, member, invalidate, LEVELS };
}
