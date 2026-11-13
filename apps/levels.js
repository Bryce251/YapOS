import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, onOff, ICONS, COLORS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, didYouMean, fillTemplate, clip, normalizeName, parseBool, channelId as channelMention, roleId as roleMention } from '../engine/parse.js';
import { permName, explain, friendly } from '../engine/errors.js';
import { avatarUrl } from '../engine/links.js';
import { accept, reject, boolField, channelById, roleById, idList, plainObject } from '../engine/dashboard.js';
import { globalConfig, patchGlobalConfig, globalDoc, mutateGlobal, mergeOnce, canGiveCurrency } from '../engine/global.js';

const ID = 'levels';
const cid = (action, ...args) => customId(ID, action, ...args);

const PAGE_SIZE = 10;
const MAX_REWARDS = 20;
const MAX_LEVEL = 1000;
const MOVE_GRACE_MS = 5000;
const COMPANION_MS = 60_000;
const VOICE_CAP_S = 12 * 3600;
const VOICE_LOOKUP_MS = 5000;
const STALE_SESSION_MS = 2 * VOICE_CAP_S * 1000;
const TRACKER_LIMIT = 5000;
const TRACKER_MAX_AGE_MS = 3600_000;
const DEFAULT_MESSAGE = '🎉 {user} reached **level {level}**!';
const MEDALS = ['🥇', '🥈', '🥉'];
const ANNOUNCE_MODES = ['here', 'channel', 'dm', 'off'];
const ANNOUNCE_LABELS = { here: 'Same channel', channel: 'Level-up channel', dm: 'DM', off: 'Off' };
const BAR_WIDTH = 10;
const BAR_EMPTY = '⬛';
const AVATAR_CACHE_MS = 10 * 60_000;
const AVATAR_CACHE_LIMIT = 2000;
const AVATAR_LOOKUP_MS = 1500;
const TIERS = [
  { min: 30, name: 'red', color: COLORS.error, square: '🟥' },
  { min: 20, name: 'gold', color: COLORS.economy, square: '🟨' },
  { min: 10, name: 'purple', color: COLORS.roles, square: '🟪' },
  { min: 5, name: 'green', color: COLORS.ok, square: '🟩' },
  { min: 0, name: 'blue', color: COLORS.info, square: '🟦' },
];

const STAFF_PERMS = ['administrator', 'manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'manage_webhooks', 'manage_emojis', 'manage_events', 'manage_nicknames', 'kick_members', 'ban_members', 'timeout_members', 'move_members', 'mute_members', 'mention_everyone', 'view_audit_log'];
const isStaffPerm = (k) => STAFF_PERMS.includes(k) || k.startsWith('manage_');
const staffPerms = (r) => [...new Set([
  ...Object.entries(r?.perms || {}).filter(([k, v]) => v && isStaffPerm(k)).map(([k]) => k),
  ...Object.entries(r || {}).filter(([k, v]) => v === true && isStaffPerm(k)).map(([k]) => k),
])];
const isEveryone = (r, sid) => /^@?everyone$/i.test(r?.name || '') || r?.id === 'everyone' || r?.id === sid;

export function xpForLevel(level) {
  const l = Math.max(0, Math.floor(Number(level) || 0));
  return 5 * l * l + 50 * l + 100;
}

export function totalXpForLevel(level) {
  let total = 0;
  const target = Math.min(MAX_LEVEL, Math.max(0, Math.floor(Number(level) || 0)));
  for (let l = 0; l < target; l++) total += xpForLevel(l);
  return total;
}

export function levelFor(totalXp) {
  let left = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 0;
  while (level < MAX_LEVEL && left >= xpForLevel(level)) {
    left -= xpForLevel(level);
    level++;
  }
  return level;
}

export function tierOf(level) {
  const l = Math.max(0, Math.floor(Number(level) || 0));
  return TIERS.find((t) => l >= t.min) || TIERS[TIERS.length - 1];
}

const unit = (frac) => Math.max(0, Math.min(1, Number(frac) || 0));

export function progressBar(frac, square = TIERS[TIERS.length - 1].square, width = BAR_WIDTH) {
  const full = Math.min(width, Math.floor(unit(frac) * width + 1e-9));
  return square.repeat(full) + BAR_EMPTY.repeat(width - full);
}

export const percentOf = (frac) => Math.min(100, Math.floor(unit(frac) * 100 + 1e-9));

export { avatarUrl };

export function progressOf(totalXp) {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  const level = levelFor(xp);
  const into = xp - totalXpForLevel(level);
  const need = xpForLevel(level);
  return { level, into, need, frac: need ? into / need : 0 };
}

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { lastXp: new Map(), pendingMsgs: new Map(), sessions: new Map(), closed: new Map(), voiceCache: new Map(), avatars: new Map(), names: new Map(), logged: new Set(), seen: 0 };
    states.set(engine, s);
  }
  return s;
}

const blankUser = () => ({ xp: 0, level: 0, voiceSeconds: 0, messages: 0, lastXpAt: 0 });
const blankDoc = () => ({ users: {} });
const readDoc = (engine) => {
  const d = globalDoc(engine, ID, blankDoc());
  d.users ||= {};
  return d;
};
const readUser = (engine, uid) => ({ ...blankUser(), ...(readDoc(engine).users[uid] || {}) });
const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
let dashboardEngine = null;
const earnOf = (engine) => globalConfig(engine, ID);
const earnRead = (key, cfg) => (dashboardEngine ? earnOf(dashboardEngine)[key] : cfg?.[key] ?? null);
const patchEarn = (engine, patch) => patchGlobalConfig(engine, ID, patch);
const canSetEarn = (ctx) => canGiveCurrency(ctx.engine, ctx.userId);
const EARN_ONLY_TITLE = 'Only the bot owner can change that';
const EARN_ONLY = 'Only the bot owner can change how fast XP is earned. Reward roles, level-up messages and no-XP spots are still yours.';
const OWNER_ONLY_XP = 'Levels are shared across every server now, so only the bot owner can hand out or wipe XP. You can still set up reward roles here.';

function foldUsers(d, from) {
  d.users ||= {};
  for (const [uid, raw] of Object.entries(from?.users || {})) {
    const add = { ...blankUser(), ...(raw || {}) };
    const cur = { ...blankUser(), ...(d.users[uid] || {}) };
    const xp = Math.max(0, Math.round((Number(cur.xp) || 0) + (Number(add.xp) || 0)));
    d.users[uid] = {
      xp,
      level: levelFor(xp),
      voiceSeconds: Math.max(0, Math.round((Number(cur.voiceSeconds) || 0) + (Number(add.voiceSeconds) || 0))),
      messages: (Number(cur.messages) || 0) + (Number(add.messages) || 0),
      lastXpAt: Math.max(Number(cur.lastXpAt) || 0, Number(add.lastXpAt) || 0),
    };
  }
}

export function mergeServerXp(engine) {
  return mergeOnce(engine, ID, { blank: blankDoc, fold: foldUsers });
}
const plainName = (name) => String(name ?? '').replace(/[<>]/g, '').replace(/@/g, '@\u200b');
const ownsPanel = (ctx) => {
  const messageId = ctx.source?.message_id;
  return !!messageId && ctx.engine.router.panelOwner(messageId) === ctx.userId;
};
const typedNumber = (value, unit) => {
  const text = typeof value === 'string' ? value.trim().replace(unit, '') : '';
  return text ? Number(text) : NaN;
};

function pruneTrackers(st, now) {
  if (st.lastXp.size <= TRACKER_LIMIT && ++st.seen % 500) return;
  for (const [k, t] of st.lastXp) if (now - t > TRACKER_MAX_AGE_MS) { st.lastXp.delete(k); st.pendingMsgs.delete(k); }
  if (st.lastXp.size > TRACKER_LIMIT) {
    const extra = st.lastXp.size - TRACKER_LIMIT;
    let n = 0;
    for (const k of st.lastXp.keys()) { if (n++ >= extra) break; st.lastXp.delete(k); st.pendingMsgs.delete(k); }
  }
  for (const [k, c] of st.closed) if (now - c.closedAt > COMPANION_MS) st.closed.delete(k);
  for (const [k, s] of st.sessions) if (now - s.startedAt > STALE_SESSION_MS) st.sessions.delete(k);
  for (const [k, v] of st.voiceCache) if (now - v.at > VOICE_LOOKUP_MS) st.voiceCache.delete(k);
}

async function nameOf(engine, sid, uid) {
  const m = await engine.perms.member(sid, uid).catch(() => null);
  return m?.nickname || m?.display_name || m?.username || 'someone';
}

async function logProblem(engine, sid, key, text, title = 'Level reward problem') {
  const st = stateOf(engine);
  const k = `${sid}:${key}`;
  if (st.logged.has(k)) return;
  st.logged.add(k);
  const embed = card({ title: `${ICONS.levels} ${title}`, body: text, color: 'levels' });
  try {
    const mod = engine.service('mod');
    if (mod?.log) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (!ch) { engine.log.warn(`[levels] ${text}`); return; }
    engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low', key: `levels:log:${k}` }).catch((e) => engine.log.debug('[levels] log failed', e?.message));
  } catch (e) {
    engine.log.debug('[levels] log failed', e?.message);
  }
}

function forgetLogged(engine, sid) {
  const st = stateOf(engine);
  for (const k of [...st.logged]) if (k.startsWith(`${sid}:`)) st.logged.delete(k);
}

function rewardList(cfg) {
  return Object.entries(cfg.rewards || {}).map(([l, r]) => ({ level: Number(l), roleId: r })).filter((x) => Number.isInteger(x.level) && x.roleId).sort((a, b) => a.level - b.level);
}

async function grantRewards(engine, sid, uid, level) {
  const cfg = cfgOf(engine, sid);
  const earned = rewardList(cfg).filter((r) => r.level <= level);
  if (!earned.length) return { added: [], removed: [] };
  const member = await engine.bot.member(sid, uid).catch(() => null);
  if (!member) return { added: [], removed: [] };
  const have = new Set(member.roles || []);
  const stack = cfg.stackRewards !== false;
  const top = earned[earned.length - 1];
  const wanted = stack ? [...new Set(earned.map((r) => r.roleId))] : [top.roleId];
  const drop = stack ? [] : [...new Set(earned.slice(0, -1).map((r) => r.roleId))].filter((r) => r !== top.roleId && have.has(r));
  const added = [];
  const removed = [];
  const who = await nameOf(engine, sid, uid);
  for (const rid of wanted) {
    if (have.has(rid)) continue;
    const lvl = earned.find((r) => r.roleId === rid)?.level;
    const check = await engine.perms.canManageRole(sid, rid).catch(() => ({ ok: true }));
    const roleName = check.role?.name || 'a reward role';
    if (!check.ok) { await logProblem(engine, sid, `role:${rid}`, `I couldn't give the level ${lvl} reward to ${who}: ${check.reason}`); continue; }
    if (check.role && staffPerms(check.role).length) {
      await logProblem(engine, sid, `role:${rid}`, `**@${roleName}** (level ${lvl} reward) has staff permissions (${staffPerms(check.role).map(permName).join(', ')}), so I won't hand it out. Pick another role with **/levels reward**.`);
      continue;
    }
    try {
      await engine.bot.addRole(sid, uid, rid);
      added.push(rid);
    } catch (e) {
      const { body } = explain(e, { action: 'give', target: `@${roleName}`, perm: 'manage_roles' });
      await logProblem(engine, sid, `role:${rid}`, `I couldn't give **@${roleName}** (level ${lvl} reward) to ${who}.\n${body}`);
    }
  }
  const holdsTop = have.has(top.roleId) || added.includes(top.roleId);
  for (const rid of holdsTop ? drop : []) {
    try {
      await engine.bot.removeRole(sid, uid, rid);
      removed.push(rid);
    } catch (e) {
      const { body } = explain(e, { action: 'remove a role from', perm: 'manage_roles' });
      await logProblem(engine, sid, `remove:${rid}`, `I couldn't take an older level reward off ${who}.\n${body}`);
    }
  }
  if (added.length || removed.length) engine.perms.invalidate(`m:${sid}:${uid}`);
  return { added, removed };
}

function queueSend(engine, sid, channelId, content, key, onFail) {
  return engine.budget.send({ serverId: sid, channelId, content, priority: 'low', key })
    .catch((e) => {
      engine.log.debug('[levels] level-up message failed', e?.message);
      if (onFail) return onFail(e);
      const { body } = explain(e, { action: 'post level-ups in', target: `<#${channelId}>`, perm: 'send_messages' });
      return logProblem(engine, sid, `announce:${channelId}`, `I couldn't post a level-up message in <#${channelId}>.\n${body}\nPick another place with **/levels channel**.`, 'Level-up message problem');
    });
}

async function announce(engine, sid, uid, level, { channelId } = {}) {
  const cfg = cfgOf(engine, sid);
  const mode = cfg.announce || 'here';
  if (mode === 'off') return;
  const [server, username] = await Promise.all([engine.perms.server(sid).catch(() => null), nameOf(engine, sid, uid)]);
  const text = clip(fillTemplate(cfg.message || DEFAULT_MESSAGE, { user: `<@${uid}>`, username: plainName(username), level, server: server?.name || 'the server' }), 2000);
  const key = `levels:up:${sid}:${uid}`;
  const here = channelId || cfg.channelId;
  if (mode === 'channel' && cfg.channelId) return void queueSend(engine, sid, cfg.channelId, text, key);
  if (mode === 'dm') {
    const fallback = () => { if (here) queueSend(engine, sid, here, text, key); };
    try {
      await engine.caps.attempt(sid, 'dms', async () => {
        const dmChannel = await engine.bot.dm(uid);
        queueSend(engine, sid, dmChannel, text, key, () => fallback());
      }, fallback);
    } catch (e) {
      engine.log.debug('[levels] level-up DM failed', e?.message);
      fallback();
    }
    return;
  }
  if (here) queueSend(engine, sid, here, text, key);
}

async function onLevelUp(engine, sid, uid, level, opts) {
  try { await announce(engine, sid, uid, level, opts); } catch (e) { engine.log.debug('[levels] announce failed', e?.message); }
  try { await grantRewards(engine, sid, uid, level); } catch (e) { engine.log.debug('[levels] rewards failed', e?.message); }
}

function applyGain(engine, uid, { xp = 0, voiceSeconds = 0, messages = 0 }) {
  let before = 0;
  let after = 0;
  let total = 0;
  mutateGlobal(engine, ID, (d) => {
    d.users ||= {};
    const u = { ...blankUser(), ...(d.users[uid] || {}) };
    before = u.level;
    u.xp = Math.max(0, Math.round(u.xp + xp));
    u.level = levelFor(u.xp);
    u.voiceSeconds = Math.max(0, Math.round(u.voiceSeconds + voiceSeconds));
    u.messages = (Number(u.messages) || 0) + (Number(messages) || 0);
    if (xp > 0) u.lastXpAt = Date.now();
    d.users[uid] = u;
    after = u.level;
    total = u.xp;
  }, blankDoc());
  return { before, level: after, xp: total, leveledUp: after > before };
}

async function addXp(engine, sid, uid, amount, extra = {}) {
  const res = applyGain(engine, uid, { xp: Number(amount) || 0, voiceSeconds: extra.voiceSeconds, messages: extra.messages });
  if (res.leveledUp) await onLevelUp(engine, sid, uid, res.level, { channelId: extra.channelId });
  return res;
}

async function onMessage(ctx, msg) {
  const { engine } = ctx;
  const sid = msg.server_id;
  const uid = msg.author_id;
  if (!sid || !uid || msg.dm || msg.is_dm || msg.author_bot || msg.command || uid === botId(engine)) return;
  if (String(msg.content || '').trim().length < 3) return;
  const cfg = cfgOf(engine, sid);
  const earn = earnOf(engine);
  if (earn.messageXp === false) return;
  if ((cfg.noXpChannels || []).includes(msg.channel_id)) return;
  const st = stateOf(engine);
  const key = uid;
  const now = Date.now();
  pruneTrackers(st, now);
  const last = st.lastXp.get(key);
  const cooldownMs = Math.max(0, Number(earn.cooldownSeconds ?? 60)) * 1000;
  if (last !== undefined && now - last < cooldownMs) {
    st.pendingMsgs.set(key, (st.pendingMsgs.get(key) || 0) + 1);
    return;
  }
  const rate = Math.max(0, Number(earn.rate ?? 1));
  if (!rate) return;
  st.lastXp.delete(key);
  st.lastXp.set(key, now);
  const messages = 1 + (st.pendingMsgs.get(key) || 0);
  st.pendingMsgs.delete(key);
  if ((cfg.noXpRoles || []).length) {
    const m = await engine.perms.member(sid, uid).catch(() => null);
    if (m && (m.roles || []).some((r) => cfg.noXpRoles.includes(r))) {
      st.lastXp.delete(key);
      if (last !== undefined) st.lastXp.set(key, last);
      if (messages > 1) st.pendingMsgs.set(key, messages - 1);
      return;
    }
  }
  const amount = Math.round((15 + Math.floor(Math.random() * 11)) * rate);
  await addXp(engine, sid, uid, amount, { channelId: msg.channel_id, messages });
}

async function voiceOthers(engine, sid, channelId, uid) {
  const st = stateOf(engine);
  const now = Date.now();
  let hit = st.voiceCache.get(sid);
  if (!hit || now - hit.at > VOICE_LOOKUP_MS) {
    const list = await engine.bot.voice(sid);
    hit = { at: now, list: list || [] };
    st.voiceCache.set(sid, hit);
  }
  const entry = hit.list.find((v) => v.channel_id === channelId);
  return (entry?.user_ids || []).filter((x) => x !== uid && x !== botId(engine));
}

function trackedCompanion(st, sid, uid, channelId, now) {
  for (const [k, s] of st.sessions) if (k !== `${sid}:${uid}` && k.startsWith(`${sid}:`) && s.channelId === channelId) return true;
  for (const [k, c] of st.closed) if (k !== `${sid}:${uid}` && k.startsWith(`${sid}:`) && c.session.channelId === channelId && now - c.closedAt <= COMPANION_MS) return true;
  return false;
}

async function awardVoice(engine, sid, uid, s) {
  const now = Date.now();
  const st = stateOf(engine);
  const elapsed = Math.min(VOICE_CAP_S, Math.max(0, Math.floor((now - s.startedAt) / 1000)));
  const minutes = Math.floor(elapsed / 60);
  const newMinutes = minutes - s.awardedMin;
  const newSeconds = elapsed - s.countedSec;
  s.awardedMin = Math.max(s.awardedMin, minutes);
  s.countedSec = Math.max(s.countedSec, elapsed);
  if (newSeconds <= 0) return null;
  const earn = earnOf(engine);
  if (earn.voiceXp === false) return null;
  let company = trackedCompanion(st, sid, uid, s.channelId, now);
  if (!company) {
    try { company = (await voiceOthers(engine, sid, s.channelId, uid)).length > 0; } catch { company = true; }
  }
  if (!company) return null;
  const perMinute = Math.max(0, Number(earn.voiceXpPerMinute ?? 5));
  return addXp(engine, sid, uid, Math.max(0, newMinutes) * perMinute, { voiceSeconds: newSeconds });
}

async function onVoiceJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !uid || uid === botId(engine)) return;
  const st = stateOf(engine);
  const key = `${sid}:${uid}`;
  const now = Date.now();
  pruneTrackers(st, now);
  st.voiceCache.delete(sid);
  const open = st.sessions.get(key);
  if (open && open.channelId !== ev.channel_id && now - open.startedAt <= VOICE_CAP_S * 1000) { open.channelId = ev.channel_id; return; }
  if (open) st.sessions.delete(key);
  const recent = st.closed.get(key);
  if (recent && now - recent.closedAt <= MOVE_GRACE_MS) {
    st.closed.delete(key);
    recent.session.channelId = ev.channel_id;
    st.sessions.set(key, recent.session);
    return;
  }
  if (earnOf(engine).voiceXp === false) return;
  st.sessions.set(key, { channelId: ev.channel_id, startedAt: now, awardedMin: 0, countedSec: 0 });
}

async function onVoiceLeave(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !uid || uid === botId(engine)) return;
  const st = stateOf(engine);
  const key = `${sid}:${uid}`;
  st.voiceCache.delete(sid);
  const s = st.sessions.get(key);
  if (!s) return;
  if (ev.channel_id && s.channelId && ev.channel_id !== s.channelId) return;
  st.sessions.delete(key);
  st.closed.set(key, { closedAt: Date.now(), session: s });
  await awardVoice(engine, sid, uid, s);
}

async function onMemberJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !uid || uid === botId(engine)) return;
  const u = readUser(engine, uid);
  const level = Number.isInteger(u.level) && u.level > 0 ? u.level : levelFor(u.xp);
  if (!level) return;
  if (!rewardList(cfgOf(engine, sid)).some((r) => r.level <= level)) return;
  try {
    await grantRewards(engine, sid, uid, level);
  } catch (e) {
    engine.log.debug('[levels] rewards on join failed', e?.message);
  }
}

function ranked(engine, sort = 'xp') {
  const field = sort === 'voice' ? 'voiceSeconds' : 'xp';
  return Object.entries(readDoc(engine).users)
    .map(([id, u]) => ({ id, ...blankUser(), ...u }))
    .filter((u) => u[field] > 0)
    .sort((a, b) => b[field] - a[field] || b.xp - a.xp || a.id.localeCompare(b.id));
}

const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const graphemes = (text) => (typeof Intl.Segmenter === 'function'
  ? Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), (g) => g.segment)
  : Array.from(text));
export function shorten(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let out = '';
  for (const g of graphemes(s)) {
    if (out.length + g.length > max - 1) break;
    out += g;
  }
  return `${out.trimEnd()}…`;
}
const NAME_MAX = 64;
const BOARD_NAME_MAX = 32;
const mdSafe = (name, fallback = 'someone', max = NAME_MAX) => shorten(plainName(name).replace(/[*_`~|\\]/g, '').replace(/\s+/g, ' ').trim(), max) || fallback;
const displayName = (m) => m?.nickname || m?.display_name || m?.username || 'Someone';

export function voiceText(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return 'none yet';
  if (s < 60) return 'under a minute';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h) return `${m}m`;
  return m ? `${num(h)}h ${m}m` : `${num(h)}h`;
}

function sinceText(joinedAt) {
  if (!joinedAt) return null;
  const d = new Date(joinedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function tipFor(earn) {
  const chat = earn.messageXp !== false;
  const voice = earn.voiceXp === true;
  if (chat && voice) return 'Chat to earn XP · voice counts too · your level follows you everywhere';
  if (chat) return 'Chat to earn XP · your level follows you everywhere';
  if (voice) return 'Hang out in voice with friends to earn XP';
  return 'XP is paused right now';
}

async function avatarPathOf(engine, member) {
  if (!member?.id) return null;
  if (Object.prototype.hasOwnProperty.call(member, 'avatar_path')) return member.avatar_path ?? null;
  const st = stateOf(engine);
  const now = Date.now();
  const hit = st.avatars.get(member.id);
  if (hit && now - hit.at < AVATAR_CACHE_MS) return hit.path;
  if (typeof engine.bot.user !== 'function') return null;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), AVATAR_LOOKUP_MS); timer.unref?.(); });
  const user = await Promise.race([Promise.resolve().then(() => engine.bot.user(member.id)), timeout]).catch(() => undefined);
  clearTimeout(timer);
  if (user === undefined) return null;
  const path = user?.avatar_path ?? null;
  if (st.avatars.size >= AVATAR_CACHE_LIMIT) st.avatars.clear();
  st.avatars.set(member.id, { at: now, path });
  return path;
}

function withAuthor(embed, name, icon) {
  embed.author = { name: shorten(name, 256) };
  if (icon) embed.author.icon_url = icon;
  return embed;
}

const roleLabeller = (roles) => (id) => {
  const r = roles.find((x) => x.id === id);
  return r ? `**@${mdSafe(r.name, 'role')}**` : 'a role that was deleted';
};

async function rankView(ctx, target) {
  const { engine } = ctx;
  const stored = readDoc(engine).users[target.id] || null;
  const u = readUser(engine, target.id);
  const p = progressOf(u.xp);
  const tier = tierOf(p.level);
  const list = ranked(engine);
  const pos = list.findIndex((x) => x.id === target.id);
  const cfg = ctx.config();
  const earn = earnOf(engine);
  const rewards = rewardList(cfg);
  const next = rewards.find((r) => r.level > p.level);
  const roles = rewards.length ? await ctx.roles().catch(() => []) : [];
  const roleLabel = roleLabeller(roles);
  const self = target.id === ctx.userId;
  const name = displayName(target);
  const icon = avatarUrl(await avatarPathOf(engine, target).catch(() => null));
  const empty = !(u.xp > 0) && !(u.voiceSeconds > 0);
  const maxed = p.level >= MAX_LEVEL;
  const head = maxed ? `**Level ${num(p.level)}**  ▸  max level` : `**Level ${num(p.level)}**  ▸  Level ${num(p.level + 1)}`;
  const nextReward = next ? `Level ${num(next.level)} → ${roleLabel(next.roleId)}` : rewards.length ? 'all unlocked 🎉' : 'none set';
  const since = sinceText(target.joined_at);
  let body;
  let fields;
  if (empty) {
    body = [head, progressBar(0, tier.square), self ? 'No XP yet. Say hi in chat to get started!' : `No XP yet. ${mdSafe(name)} shows up here after their first chats.`].join('\n');
    fields = [
      { name: '🎁 Next reward', value: nextReward, inline: true },
      since ? { name: '📅 Member since', value: since, inline: true } : null,
    ];
  } else {
    body = (maxed ? [
      head,
      `${progressBar(1, tier.square)}  **100%**`,
      'Top of the ladder. Nothing left to unlock! 🎉',
    ] : [
      head,
      `${progressBar(p.frac, tier.square)}  **${percentOf(p.frac)}%**`,
      `${num(p.into)} / ${num(p.need)} XP · **${num(p.need - p.into)} XP** to go`,
    ]).join('\n');
    const msgs = Number.isFinite(stored?.messages) ? `\`${num(stored.messages)}\`` : 'not counted yet';
    fields = [
      { name: '🏆 Global rank', value: pos >= 0 ? `\`#${num(pos + 1)} of ${num(list.length)}\`` : 'not ranked yet', inline: true },
      { name: '✨ Total XP', value: `\`${num(u.xp)}\``, inline: true },
      { name: '💬 Messages', value: msgs, inline: true },
      { name: '🎙️ Voice', value: u.voiceSeconds >= 60 ? `\`${voiceText(u.voiceSeconds)}\`` : voiceText(u.voiceSeconds), inline: true },
      { name: '🎁 Next reward', value: nextReward, inline: true },
      since ? { name: '📅 Member since', value: since, inline: true } : null,
    ];
  }
  const embed = withAuthor(card({ body, fields, color: tier.color, footer: tipFor(earn), thumbnail: icon || undefined }), name, icon);
  return {
    embeds: [embed],
    components: [row(
      button('Leaderboard', cid('lbpeek'), 'secondary', '🏆'),
      button('Rewards', cid('rewards', target.id), 'secondary', '🎁'),
    )],
  };
}

async function rewardsView(ctx, subjectId) {
  const { engine, serverId: sid } = ctx;
  const wanted = typeof subjectId === 'string' && /^[\w-]{1,64}$/.test(subjectId) ? subjectId : ctx.userId;
  let uid = wanted;
  let member = await engine.perms.member(sid, uid).catch(() => null);
  if (!member && uid !== ctx.userId) {
    uid = ctx.userId;
    member = await engine.perms.member(sid, uid).catch(() => null);
  }
  const self = uid === ctx.userId;
  const u = readUser(engine, uid);
  const level = levelFor(u.xp);
  const cfg = ctx.config();
  const rewards = rewardList(cfg);
  const isAdmin = engine.perms.atLeast(await ctx.level().catch(() => 'member'), 'admin');
  let body;
  if (!rewards.length) {
    body = ['No level rewards yet.', isAdmin ? '-# Admins: add one with `/levels reward 5 @Regular`.' : '-# Levels still count, so keep chatting!'].join('\n');
  } else {
    const roleLabel = roleLabeller(await ctx.roles().catch(() => []));
    const holds = new Set(member?.roles || []);
    const lines = rewards.map((r) => {
      const status = holds.has(r.roleId)
        ? `✅ ${self ? 'you have it' : 'has it'}`
        : level >= r.level ? '✅ unlocked' : `🔒 locked · ${num(totalXpForLevel(r.level) - u.xp)} XP to go`;
      return `**Level ${num(r.level)}** → ${roleLabel(r.roleId)}  ${status}`;
    });
    const lead = self ? null : `-# Showing progress for **${mdSafe(displayName(member), 'them')}**`;
    body = [lead, ...lines].filter(Boolean).join('\n');
  }
  const footer = !rewards.length ? tipFor(earnOf(ctx.engine)) : cfg.stackRewards === false ? 'Only the highest reward role is kept' : 'Every reward role you earn is yours to keep';
  return { embeds: [card({ title: '🎁 Level rewards', body, color: tierOf(level).color, footer })] };
}

async function showRank(ctx, tokens, how = 'reply') {
  const { engine } = ctx;
  let target = { id: ctx.userId, username: ctx.username };
  const query = tokens.join(' ').trim();
  if (query && !/^me$/i.test(query)) {
    const found = await ctx.findUser(query);
    if (!found?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(query, 40)}**. Try a mention, like \`/rank @sam\`.`);
    target = found;
  } else {
    const me = await engine.perms.member(ctx.serverId, ctx.userId).catch(() => null);
    if (me) target = me;
  }
  if (target.id === botId(engine)) return ctx.info("I don't level up", "Bots don't earn XP. I'm happy just watching you all climb!");
  if (!target.username) {
    const m = await engine.perms.member(ctx.serverId, target.id).catch(() => null);
    if (m) target = m;
  }
  const view = await rankView(ctx, target);
  try {
    return await ctx[how](view);
  } catch (e) {
    const embed = view.embeds[0];
    if (e?.status !== 400 || !(embed.thumbnail || embed.author?.icon_url)) throw e;
    engine.log.debug('[levels] rank card picture refused, sending without it', e?.message);
    delete embed.thumbnail;
    delete embed.author.icon_url;
    return ctx[how](view);
  }
}

async function boardNames(engine, members, ids) {
  const names = new Map(members.map((m) => [m.id, displayName(m)]));
  if (typeof engine.bot.user !== 'function') return names;
  const st = stateOf(engine);
  const now = Date.now();
  const missing = [];
  for (const id of ids) {
    if (names.has(id)) continue;
    const hit = st.names.get(id);
    if (hit && now - hit.at < AVATAR_CACHE_MS) {
      if (hit.name) names.set(id, hit.name);
      continue;
    }
    if (!missing.includes(id)) missing.push(id);
  }
  if (!missing.length) return names;
  const found = await Promise.all(missing.map((id) => Promise.resolve().then(() => engine.bot.user(id)).catch(() => null)));
  for (let i = 0; i < missing.length; i++) {
    const user = found[i];
    const name = user && (user.display_name || user.username) ? displayName(user) : null;
    if (st.names.size >= AVATAR_CACHE_LIMIT) st.names.clear();
    st.names.set(missing[i], { at: now, name });
    if (name) names.set(missing[i], name);
  }
  return names;
}

async function leaderboardView(ctx, page, sort) {
  const { engine } = ctx;
  const by = sort === 'voice' ? 'voice' : 'xp';
  const list = ranked(engine, by);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const start = (p - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  const members = await ctx.members().catch(() => []);
  const names = await boardNames(engine, members, slice.map((u) => u.id));
  const stat = (u) => (by === 'voice' ? `${voiceText(u.voiceSeconds)} in voice` : `Level ${num(levelFor(u.xp))} · ${num(u.xp)} XP`);
  const lines = slice.map((u, i) => {
    const n = start + i;
    const mark = MEDALS[n] || `\`#${n + 1}\``;
    const who = names.has(u.id) ? mdSafe(names.get(u.id), 'someone', BOARD_NAME_MAX) : 'someone';
    return `${mark} **${who}** · ${stat(u)}${u.id === ctx.userId ? '  ◂ you' : ''}`;
  });
  const mine = list.findIndex((x) => x.id === ctx.userId);
  let you = null;
  if (list.length && (mine < start || mine >= start + PAGE_SIZE)) {
    you = mine >= 0
      ? `-# You: #${num(mine + 1)} · ${by === 'voice' ? `${voiceText(list[mine].voiceSeconds)} in voice` : `Level ${num(levelFor(list[mine].xp))}`}`
      : `-# You're not on the board yet. ${by === 'voice' ? 'Hang out in voice with friends' : 'Say hi in chat'} to join in!`;
  }
  const empty = by === 'voice' ? 'Nobody has voice time yet. Hop in a voice channel with friends!' : 'Nobody has XP yet. Start chatting to get on the board!';
  const body = lines.length ? [...lines, ...(you ? ['', you] : [])].join('\n') : empty;
  const title = by === 'voice' ? '🎙️ Global voice leaderboard' : '🏆 Global leaderboard';
  const accent = list.length ? tierOf(levelFor(list[0].xp)).color : COLORS.levels;
  const buttons = [];
  if (pages > 1) {
    buttons.push(button('Prev', cid('lb', p - 1, by), 'secondary', '⬅️', { disabled: p <= 1 }));
    buttons.push(button('Next', cid('lb', p + 1, by), 'secondary', '➡️', { disabled: p >= pages }));
  }
  buttons.push(button(by === 'voice' ? 'Sort by XP' : 'Sort by voice time', cid('lb', 1, by === 'voice' ? 'xp' : 'voice'), 'primary', by === 'voice' ? '📈' : '🎙️'));
  return {
    embeds: [card({ title, body, color: accent, footer: `Page ${p} of ${pages} · ${num(list.length)} ranked · everyone, every server` })],
    components: [row(buttons)],
  };
}

function parseLeaderboardArgs(tokens) {
  let page = 1;
  let sort = 'xp';
  for (const t of tokens.map((x) => String(x).toLowerCase())) {
    if (/^\d+$/.test(t)) page = Number(t);
    else if (['voice', 'vc', 'voicetime', 'time'].includes(t)) sort = 'voice';
    else if (['xp', 'level', 'levels', 'chat'].includes(t)) sort = 'xp';
  }
  return { page, sort };
}

async function showLeaderboard(ctx, tokens) {
  const { page, sort } = parseLeaderboardArgs(tokens);
  return ctx.reply(await leaderboardView(ctx, page, sort));
}

async function settingsView(ctx) {
  const cfg = ctx.config();
  const earn = earnOf(ctx.engine);
  const [roles, channels] = await Promise.all([ctx.roles().catch(() => []), ctx.channels().catch(() => [])]);
  const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? `@${r.name}` : 'a deleted role'; };
  const chName = (id) => { const c = channels.find((x) => x.id === id); return c ? `#${c.name}` : 'a deleted channel'; };
  const rewards = rewardList(cfg);
  const mode = cfg.announce || 'here';
  const where = mode === 'channel' ? (cfg.channelId ? chName(cfg.channelId) : 'no channel picked yet, so the same channel') : mode === 'dm' ? 'a DM (falls back to the same channel if DMs are off)' : mode === 'off' ? 'nowhere' : 'the channel they were chatting in';
  const noXp = [...(cfg.noXpChannels || []).map(chName), ...(cfg.noXpRoles || []).map(roleName)];
  const fields = [
    { name: 'XP for chatting (everywhere)', value: `${onOff(earn.messageXp !== false)} · ×${earn.rate} · once every ${earn.cooldownSeconds}s`, inline: true },
    { name: 'XP for voice (everywhere)', value: `${onOff(earn.voiceXp === true)} · ${earn.voiceXpPerMinute} XP a minute`, inline: true },
    { name: 'Level-up messages', value: `${ANNOUNCE_LABELS[mode] || mode}: ${where}`, inline: false },
    { name: `Role rewards (${rewards.length}/${MAX_REWARDS})${cfg.stackRewards === false ? ' · keep highest only' : ' · keep all'}`, value: clip(rewards.map((r) => `Level ${r.level} → ${roleName(r.roleId)}`).join('\n'), 1024) || 'None. Add one with `/levels reward 10 @Regular`.', inline: false },
    { name: 'No XP in', value: clip(noXp.join(', '), 1024) || 'Nowhere. Add with `/levels noxp #channel` or `/levels noxp @role`.', inline: false },
    { name: 'Ranked people', value: String(ranked(ctx.engine).length), inline: true },
  ];
  const body = 'XP, levels and the leaderboard are shared across every server, so a level follows people wherever they go. Only the bot owner sets how fast XP is earned; reward roles, level-up messages and no-XP spots are yours.\nTyped settings: `/levels reward 10 @Regular` · `/levels channel #level-ups` · `/levels rate 1.5` · `/levels set @sam 12` · `/levels reset @sam`';
  return {
    embeds: [card({ title: `${ICONS.levels} Levels settings`, body, fields, color: 'levels' })],
    components: [
      row(
        button(earn.messageXp !== false ? 'Chat XP: on' : 'Chat XP: off', cid('tmsg'), earn.messageXp !== false ? 'success' : 'secondary', '💬'),
        button(earn.voiceXp === true ? 'Voice XP: on' : 'Voice XP: off', cid('tvoice'), earn.voiceXp === true ? 'success' : 'secondary', '🎙️'),
        button('Rate & cooldown', cid('rateform'), 'secondary', '⏱️'),
        button(cfg.stackRewards === false ? 'Rewards: keep highest' : 'Rewards: keep all', cid('tstack'), 'secondary', '🎁'),
      ),
      row(ANNOUNCE_MODES.map((m) => button(`Level-ups: ${ANNOUNCE_LABELS[m]}`, cid('ann', m), m === mode ? 'primary' : 'secondary'))),
      row(
        button('Reset someone', cid('resetform'), 'secondary', '🧽'),
        button('Reset everyone', cid('resetall'), 'danger', '🧨'),
        button('Leaderboard', cid('lbpeek'), 'secondary', '🏆'),
      ),
    ],
  };
}

const showSettings = async (ctx) => {
  await ctx.require('admin');
  return ctx.ephemeral(await settingsView(ctx));
};

function adminUndo(ctx, label, revert) {
  const { engine, serverId: sid } = ctx;
  return engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label, perm: 'admin',
    run: async (i) => {
      if (i?.server_id && i.server_id !== sid) throw friendly('That Undo button belongs to another server, so it does nothing here.', { title: 'Wrong server' });
      if (i?.user_id) await engine.perms.require(sid, i.user_id, 'admin');
      return revert();
    },
  });
}

function snapshotUser(engine, uid) {
  const u = readDoc(engine).users[uid];
  return u ? structuredClone(u) : null;
}

function restoreUsers(engine, saved, { additive = true } = {}) {
  mutateGlobal(engine, ID, (d) => {
    d.users ||= {};
    for (const [uid, old] of Object.entries(saved)) {
      const cur = d.users[uid];
      if (!old) { delete d.users[uid]; continue; }
      if (!additive || !cur) { d.users[uid] = { ...old }; continue; }
      const xp = (old.xp || 0) + (cur.xp || 0);
      d.users[uid] = { ...old, xp, level: levelFor(xp), voiceSeconds: (old.voiceSeconds || 0) + (cur.voiceSeconds || 0), messages: (old.messages || 0) + (cur.messages || 0), lastXpAt: Math.max(old.lastXpAt || 0, cur.lastXpAt || 0) };
    }
  }, blankDoc());
}

async function resetUser(ctx, target) {
  await ctx.require('admin');
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, OWNER_ONLY_XP);
  const { engine } = ctx;
  const name = target.nickname || target.display_name || target.username || 'them';
  const saved = snapshotUser(engine, target.id);
  if (!saved || !(saved.xp || saved.voiceSeconds)) return ctx.info('Nothing to reset', `**${name}** has no XP yet.`);
  mutateGlobal(engine, ID, (d) => { d.users ||= {}; delete d.users[target.id]; }, blankDoc());
  stateOf(engine).lastXp.delete(target.id);
  const undo = adminUndo(ctx, `reset of ${name}`, async () => restoreUsers(engine, { [target.id]: saved }));
  return ctx.ok('XP reset', `**${name}** is back to level 0 everywhere (was level ${saved.level}, ${saved.xp} XP). Reward roles they already have stay.`, { components: [row(undo.button)] });
}

async function resetAllConfirm(ctx) {
  await ctx.require('admin');
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, OWNER_ONLY_XP);
  const count = ranked(ctx.engine).length;
  if (!count) return ctx.info('Nothing to reset', 'Nobody has XP yet.');
  return ctx.ephemeral({
    embeds: [dialog.warn('Reset everyone, everywhere?', `This sets all **${count}** ranked ${count === 1 ? 'person' : 'people'} back to level 0 on every server and clears voice time. Reward roles people already have stay.\nYou get an Undo button for 10 minutes.`)],
    components: [row(button('Yes, reset everyone', cid('resetallyes'), 'danger', '🧨'), button('Cancel', cid('cancel'), 'secondary'))],
  });
}

async function resetAll(ctx) {
  await ctx.require('admin');
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, OWNER_ONLY_XP);
  const { engine } = ctx;
  const saved = structuredClone(readDoc(engine).users);
  const count = Object.keys(saved).length;
  if (!count) return ctx.info('Already reset', 'Nobody has XP right now, so there was nothing to reset. If you just reset everyone, the Undo button is on that message.');
  mutateGlobal(engine, ID, (d) => { d.users = {}; }, blankDoc());
  stateOf(engine).lastXp.clear();
  const undo = adminUndo(ctx, 'reset of everyone', async () => restoreUsers(engine, saved));
  const embeds = [dialog.ok('Everyone reset', `${count} ${count === 1 ? 'person' : 'people'} went back to level 0 everywhere. Changed your mind? Press Undo within 10 minutes.`)];
  return ctx.update({ embeds, components: [row(undo.button)] });
}

async function setLevel(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, OWNER_ONLY_XP);
  const lvlIdx = tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1]) ? tokens.length - 1 : -1;
  const levelTok = lvlIdx >= 0 ? tokens[lvlIdx] : undefined;
  const who = tokens.slice(0, lvlIdx >= 0 ? lvlIdx : tokens.length).join(' ');
  if (!who || levelTok === undefined) return ctx.warn('Who and which level?', 'Try `/levels set @sam 12`.');
  const level = Number(levelTok);
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return ctx.warn("That level didn't work", `Pick a level from 0 to ${MAX_LEVEL}.`);
  const target = await ctx.findUser(who);
  if (!target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(who, 40)}**.`);
  if (target.id === botId(engine)) return ctx.info("I don't level up", "Bots don't earn XP.");
  const saved = snapshotUser(engine, target.id);
  const xp = totalXpForLevel(level);
  mutateGlobal(engine, ID, (d) => {
    d.users ||= {};
    d.users[target.id] = { ...blankUser(), ...(d.users[target.id] || {}), xp, level };
  }, blankDoc());
  const name = target.nickname || target.display_name || target.username || 'them';
  const undo = adminUndo(ctx, `level of ${name}`, async () => restoreUsers(engine, { [target.id]: saved }, { additive: false }));
  const out = await ctx.ok('Level set', `**${name}** is now level ${level} everywhere (${xp.toLocaleString('en-US')} XP). Any rewards up to level ${level} are on their way.`, { components: [row(undo.button)] });
  grantRewards(engine, sid, target.id, level).catch((e) => engine.log.debug('[levels] rewards after set failed', e?.message));
  return out;
}

const validRewardLevel = (level) => Number.isInteger(level) && level >= 1 && level <= MAX_LEVEL;
const TOO_MANY_REWARDS = `You can have up to ${MAX_REWARDS}. Remove one with \`/levels reward remove 10\`.`;

async function rewardProblem(engine, sid, role) {
  if (isEveryone(role, sid)) return { title: "That role can't be a reward", body: 'Everyone already has @everyone.' };
  const staff = staffPerms(role);
  if (staff.length) return { title: "That role can't be a reward", body: `**@${role.name}** has staff permissions (${staff.map(permName).join(', ')}). Anyone who levels up would get them. Use a role without those permissions.` };
  const check = await engine.perms.canManageRole(sid, role.id);
  if (!check.ok) return { title: "I can't hand out that role", body: check.reason };
  return null;
}

async function addReward(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const level = Number(tokens[0]);
  const roleTok = tokens.slice(1).join(' ').trim();
  if (!validRewardLevel(level) || !roleTok) return ctx.warn('Which level and role?', 'Try `/levels reward 10 @Regular`, or `/levels reward remove 10`.');
  const role = await ctx.findRole(roleTok);
  if (!role) return ctx.warn("I couldn't find that role", `No role matches **${clip(roleTok, 40)}**.`);
  const problem = await rewardProblem(engine, sid, role);
  if (problem) return ctx.warn(problem.title, problem.body);
  const cfg = ctx.config();
  const rewards = { ...(cfg.rewards || {}) };
  if (!rewards[level] && Object.keys(rewards).length >= MAX_REWARDS) return ctx.warn('Too many rewards', TOO_MANY_REWARDS);
  const prev = rewards[level] || null;
  rewards[level] = role.id;
  ctx.patchConfig({ rewards });
  forgetLogged(engine, sid);
  const undo = adminUndo(ctx, `level ${level} reward`, async () => {
    const cur = { ...(cfgOf(engine, sid).rewards || {}) };
    if (prev) cur[level] = prev; else delete cur[level];
    engine.settings.patchApp(sid, ID, { rewards: cur });
  });
  return ctx.ok('Reward saved', `Reaching **level ${level}** now gives **@${role.name}**.${prev ? ' (It replaced the old reward for that level.)' : ''}\nPeople already past level ${level} get it the next time they level up.`, { components: [row(undo.button)] });
}

async function removeReward(ctx, tokens) {
  const level = Number(tokens[0]);
  const cfg = ctx.config();
  const rewards = { ...(cfg.rewards || {}) };
  if (!Number.isInteger(level) || !rewards[level]) return ctx.warn('No reward there', `There's no reward at level **${clip(tokens[0] || '?', 10)}**. See them all with \`/levels rewards\`.`);
  const prev = rewards[level];
  delete rewards[level];
  ctx.patchConfig({ rewards });
  const { engine, serverId: sid } = ctx;
  const undo = adminUndo(ctx, `level ${level} reward removal`, async () => {
    const cur = { ...(cfgOf(engine, sid).rewards || {}) };
    if (!cur[level] && Object.keys(cur).length < MAX_REWARDS) cur[level] = prev;
    engine.settings.patchApp(sid, ID, { rewards: cur });
  });
  return ctx.ok('Reward removed', `Level ${level} no longer gives a role. Nobody loses the role they already have.`, { components: [row(undo.button)] });
}

async function setAnnounceChannel(ctx, tokens) {
  const t = (tokens[0] || '').toLowerCase();
  if (!t) return ctx.warn('Where should level-ups go?', 'Try `/levels channel #level-ups`, `here`, `dm` or `off`.');
  if (t === 'here' || t === 'same') { ctx.patchConfig({ announce: 'here' }); return ctx.ok('Level-ups saved', 'Level-up messages show up in the channel where people were chatting.'); }
  if (t === 'dm' || t === 'dms') { ctx.patchConfig({ announce: 'dm' }); return ctx.ok('Level-ups saved', "I'll DM people when they level up. DMs from bots are still in testing on Yapin', so if they don't work here I post in the same channel instead."); }
  if (t === 'off' || t === 'none' || parseBool(t) === false) { ctx.patchConfig({ announce: 'off' }); return ctx.ok('Level-ups saved', "I won't announce level-ups. People can still check **/rank**."); }
  const ch = await ctx.findChannel(tokens.join(' '));
  if (!ch) return ctx.warn("I couldn't find that channel", `No text channel matches **${clip(tokens.join(' '), 40)}**.`);
  ctx.patchConfig({ announce: 'channel', channelId: ch.id });
  return ctx.ok('Level-ups saved', `Level-up messages go to <#${ch.id}>.`);
}

async function toggleNoXp(ctx, tokens) {
  const tok = tokens.join(' ').trim();
  const cfg = ctx.config();
  if (!tok) {
    const list = [...(cfg.noXpChannels || []).map((id) => `<#${id}>`), ...(cfg.noXpRoles || []).map((id) => `<@&${id}>`)];
    return ctx.info('No-XP list', `${list.join(', ') || 'Empty. Everyone earns XP everywhere.'}\nAdd or remove with \`/levels noxp #channel\` or \`/levels noxp @role\`.`);
  }
  const looksRole = !!roleMention(tok) || tok.startsWith('@');
  const looksChannel = !!channelMention(tok) || tok.startsWith('#');
  const channel = looksRole ? null : await ctx.findChannel(tok);
  const role = channel || looksChannel ? null : await ctx.findRole(tok);
  if (channel) {
    const list = new Set(cfg.noXpChannels || []);
    const had = list.delete(channel.id);
    if (!had) list.add(channel.id);
    ctx.patchConfig({ noXpChannels: [...list].slice(0, 50) });
    return ctx.ok('No-XP list saved', had ? `Messages in <#${channel.id}> earn XP again.` : `Messages in <#${channel.id}> don't earn XP now. Run the same command again to undo.`);
  }
  if (role) {
    const list = new Set(cfg.noXpRoles || []);
    const had = list.delete(role.id);
    if (!had) list.add(role.id);
    ctx.patchConfig({ noXpRoles: [...list].slice(0, 50) });
    return ctx.ok('No-XP list saved', had ? `People with **@${role.name}** earn XP again.` : `People with **@${role.name}** don't earn XP now. Run the same command again to undo.`);
  }
  return ctx.warn("I couldn't find that", `No channel or role matches **${clip(tok, 40)}**.`);
}

const NUMBER_SETTINGS = {
  rate: { key: 'rate', min: 0, max: 5, label: 'XP rate', unit: '×' },
  cooldownSeconds: { key: 'cooldownSeconds', min: 0, max: 3600, label: 'cooldown', unit: ' seconds', integer: true },
  voiceXpPerMinute: { key: 'voiceXpPerMinute', min: 0, max: 100, label: 'voice XP a minute', integer: true },
};

function checkNumberSetting(raw, { min, max, label, integer = false }) {
  const typed = String(raw ?? '').replace(/^x|x$/i, '');
  const n = typed ? Number(typed) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return { title: `That ${label} didn't work`, error: `Use a ${integer ? 'whole ' : ''}number from ${min} to ${max}.` };
  return { value: n };
}

function levelUpMessage(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return /^reset$/i.test(t) ? DEFAULT_MESSAGE : clip(t, 500);
}

function numberSetting(ctx, tokens, { key, min, max, label, unit = '', integer = false }) {
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, EARN_ONLY);
  const checked = checkNumberSetting(tokens[0], { min, max, label, integer });
  if (checked.error) return ctx.warn(checked.title, checked.error);
  const n = checked.value;
  patchEarn(ctx.engine, { [key]: n });
  return ctx.ok('Saved', `${label[0].toUpperCase()}${label.slice(1)} is now **${n}${unit}** on every server.`);
}

function boolSetting(ctx, tokens, key, label) {
  if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, EARN_ONLY);
  const earn = earnOf(ctx.engine);
  const v = parseBool(tokens[0]);
  const current = key === 'voiceXp' ? earn.voiceXp === true : earn[key] !== false;
  const next = v === null ? !current : v;
  patchEarn(ctx.engine, { [key]: next });
  return ctx.ok('Saved', `${label} is now **${next ? 'on' : 'off'}** on every server.`);
}

const SUBS = ['reward', 'rewards', 'channel', 'noxp', 'rate', 'cooldown', 'voice', 'voicerate', 'xp', 'stack', 'message', 'set', 'reset', 'settings'];

async function runLevels(ctx) {
  await ctx.require('admin');
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  if (!sub || sub === 'settings' || sub === 'panel') return showSettings(ctx);
  if (sub === 'reward' || sub === 'rewards') {
    const first = (rest[0] || '').toLowerCase();
    if (['remove', 'delete', 'del', 'rm', 'off'].includes(first)) return removeReward(ctx, rest.slice(1));
    if (!rest.length) return showSettings(ctx);
    return addReward(ctx, rest);
  }
  if (sub === 'channel' || sub === 'announce') return setAnnounceChannel(ctx, rest);
  if (sub === 'noxp' || sub === 'no-xp' || sub === 'ignore') return toggleNoXp(ctx, rest);
  if (sub === 'rate' || sub === 'multiplier') return numberSetting(ctx, rest, NUMBER_SETTINGS.rate);
  if (sub === 'cooldown') return numberSetting(ctx, rest, NUMBER_SETTINGS.cooldownSeconds);
  if (sub === 'voicerate') return numberSetting(ctx, rest, NUMBER_SETTINGS.voiceXpPerMinute);
  if (sub === 'voice') return boolSetting(ctx, rest, 'voiceXp', 'Voice XP');
  if (sub === 'xp' || sub === 'chat') return boolSetting(ctx, rest, 'messageXp', 'Chat XP');
  if (sub === 'stack') {
    const v = parseBool(rest[0]);
    const next = v === null ? ctx.config().stackRewards === false : v;
    ctx.patchConfig({ stackRewards: next });
    return ctx.ok('Saved', next ? 'People keep every reward role they earn.' : 'People keep only their highest reward role; lower ones come off when they level up.');
  }
  if (sub === 'message') {
    const text = ctx.args.replace(/^\s*message\s*/i, '').trim();
    if (!text) return ctx.info('Level-up message', `Now: ${ctx.config().message}\nChange it with \`/levels message GG {user}, level {level}!\` (also {username} and {server}), or \`/levels message reset\`.`);
    const next = levelUpMessage(text);
    ctx.patchConfig({ message: next });
    return ctx.ok('Level-up message saved', `Preview: ${fillTemplate(next, { user: `<@${ctx.userId}>`, username: ctx.username, level: 5, server: 'this server' })}`);
  }
  if (sub === 'set') return setLevel(ctx, rest);
  if (sub === 'reset') {
    if (!rest.length) return ctx.warn('Reset who?', 'Try `/levels reset @sam`, or `/levels reset all` for everyone.');
    if (/^(all|everyone|server)$/i.test(rest[0])) return resetAllConfirm(ctx);
    const target = await ctx.findUser(rest.join(' '));
    if (!target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(rest.join(' '), 40)}**.`);
    return resetUser(ctx, target);
  }
  const guess = didYouMean(sub, SUBS);
  return ctx.warn("I didn't get that", `I don't know **${clip(sub, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/levels\` on its own for the settings panel.`);
}

const admin = (run) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const owner = (run, why = EARN_ONLY) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); if (!canSetEarn(ctx)) return ctx.warn(EARN_ONLY_TITLE, why); return run(ctx); } });
const xpOwner = (run) => owner(run, OWNER_ONLY_XP);
const refresh = async (ctx) => ctx.update(await settingsView(ctx));

const PICK_CHANNEL_FIRST = 'Type `/levels channel #level-ups` and level-ups go there.';
const NO_CHANNEL = "I couldn't find that channel";

const numberField = (key, label, help) => ({
  key, label, help, type: 'number', web: true, owner: true,
  min: NUMBER_SETTINGS[key].min, max: NUMBER_SETTINGS[key].max, step: NUMBER_SETTINGS[key].integer ? 1 : 0.1,
  read: (cfg) => earnRead(key, cfg),
  save: (ctx, value) => { patchEarn(ctx.engine, { [key]: value }); },
  validate: (ctx, v) => {
    const checked = checkNumberSetting(v, NUMBER_SETTINGS[key]);
    return checked.error ? reject(checked.error) : accept(checked.value);
  },
});

const earnField = (spec) => boolField({
  ...spec,
  owner: true,
  read: (cfg) => earnRead(spec.key, cfg),
  save: (ctx, value) => { patchEarn(ctx.engine, { [spec.key]: value }); },
});

async function validateRewards(ctx, v) {
  if (!plainObject(v)) return reject('Rewards are a list of levels and roles.');
  const prev = ctx.config().rewards || {};
  const next = {};
  for (const [lvl, rid] of Object.entries(v)) {
    const level = Number(lvl);
    if (!validRewardLevel(level)) return reject('Try `/levels reward 10 @Regular`, or `/levels reward remove 10`.');
    const role = await roleById(ctx, rid);
    if (!role) return reject(`No role matches **${clip(String(rid ?? '?'), 40)}**.`);
    if (prev[level] !== role.id) {
      const problem = await rewardProblem(ctx.engine, ctx.serverId, role);
      if (problem) return reject(problem.body);
    }
    next[String(level)] = role.id;
  }
  if (Object.keys(next).length > MAX_REWARDS) return reject(TOO_MANY_REWARDS);
  return accept(next);
}

async function validateChannelList(ctx, v) {
  const ids = idList(v);
  if (!ids) return reject('Pick channels from the list.');
  const out = [];
  for (const id of ids) {
    const ch = await channelById(ctx, id);
    if (!ch) return reject(`No channel or role matches **${clip(id, 40)}**.`);
    out.push(ch.id);
  }
  return accept([...new Set(out)].slice(0, 50));
}

async function validateRoleList(ctx, v) {
  const ids = idList(v);
  if (!ids) return reject('Pick roles from the list.');
  const out = [];
  for (const id of ids) {
    const role = await roleById(ctx, id);
    if (!role) return reject(`No channel or role matches **${clip(id, 40)}**.`);
    out.push(role.id);
  }
  return accept([...new Set(out)].slice(0, 50));
}

const DASHBOARD = [
  earnField({ key: 'messageXp', label: 'XP for chatting (every server)', help: 'People earn 15 to 25 XP (times the rate) for messages of 3 or more characters, at most once per cooldown. Set once by the bot owner for every server.' }),
  earnField({ key: 'voiceXp', label: 'XP for voice (every server)', help: 'People earn XP for each full minute in voice while someone else is in the channel. Set once by the bot owner for every server.' }),
  numberField('rate', 'XP rate (every server)', 'Multiplier on chat XP. 1 is normal, 0.5 is half, 2 is double. Set once by the bot owner.'),
  numberField('cooldownSeconds', 'Seconds between XP gains (every server)', 'The shortest time between two chat XP gains for one person. Set once by the bot owner.'),
  numberField('voiceXpPerMinute', 'Voice XP per minute (every server)', 'XP for each full minute in voice with company. Set once by the bot owner.'),
  {
    key: 'announce', label: 'Level-up messages', type: 'select', web: true,
    help: 'Where level-up messages go: the same channel, a set channel, a DM (falls back to the same channel), or nowhere.',
    options: ANNOUNCE_MODES.map((m) => ({ value: m, label: ANNOUNCE_LABELS[m] })),
    validate: async (ctx, v, all) => {
      if (!ANNOUNCE_MODES.includes(v)) return reject('Pick one of the options.');
      if (v !== 'channel') return accept(v);
      const channel = all && all.channelId !== undefined ? await channelById(ctx, all.channelId) : ctx.config().channelId;
      if (!channel) return reject('Pick a level-up channel below first.');
      return accept(v);
    },
  },
  {
    key: 'channelId', label: 'Level-up channel', type: 'channel', web: true,
    help: "The channel used when level-ups are set to 'Level-up channel'.",
    validate: async (ctx, v) => {
      const ch = await channelById(ctx, v);
      return ch ? accept(ch.id) : reject(`${NO_CHANNEL}. Pick a text channel.`);
    },
  },
  {
    key: 'message', label: 'Level-up message', type: 'text', web: true, maxLength: 500,
    help: 'Text of the level-up message. Placeholders: {user} {username} {level} {server}. Type reset for the default.',
    validate: (ctx, v) => {
      const next = levelUpMessage(v);
      return next === null ? reject('Write a message like: GG {user}, level {level}! You can also use {username} and {server}, or type reset.') : accept(next);
    },
  },
  {
    key: 'rewards', label: 'Role rewards', type: 'complex', web: true, editor: 'rewards', max: MAX_REWARDS,
    help: 'Map of level to role. Reaching that level gives the role.',
    validate: validateRewards,
    save: (ctx, value) => { ctx.patchConfig({ rewards: value }); forgetLogged(ctx.engine, ctx.serverId); },
  },
  boolField({ key: 'stackRewards', label: 'Keep all reward roles', help: 'On: members keep every reward role. Off: only the highest one is kept.' }),
  { key: 'noXpChannels', label: 'No-XP channels', type: 'channels', web: true, max: 50, help: 'Messages in these channels earn no XP.', validate: validateChannelList },
  { key: 'noXpRoles', label: 'No-XP roles', type: 'roles', web: true, max: 50, help: 'Members with any of these roles earn no chat XP.', validate: validateRoleList },
];

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Levels',
  icon: ICONS.levels,
  description: 'XP for chatting and voice, ranks and role rewards.',
  category: 'Community',

  defaults: {
    messageXp: true,
    voiceXp: false,
    rate: 1,
    cooldownSeconds: 60,
    voiceXpPerMinute: 5,
    announce: 'here',
    channelId: null,
    message: DEFAULT_MESSAGE,
    rewards: {},
    stackRewards: true,
    noXpChannels: [],
    noXpRoles: [],
  },

  commands: {
    rank: { description: "Your level, XP and rank, or someone else's: /rank or /rank @sam", run: (ctx) => showRank(ctx, ctx.argv) },
    leaderboard: { description: 'The global top by XP: /leaderboard, /leaderboard 2 for page 2, /leaderboard voice', run: (ctx) => showLeaderboard(ctx, ctx.argv) },
    levels: { description: 'Levels settings (admins): /levels reward 10 @Regular, /levels channel #level-ups', perm: 'admin', run: runLevels },
  },

  components: {
    lb: {
      run: async (ctx) => {
        const view = await leaderboardView(ctx, ctx.argv[0], ctx.argv[1]);
        return ownsPanel(ctx) ? ctx.update(view) : ctx.reply(view);
      },
    },
    rewards: { run: async (ctx) => ctx.ephemeral(await rewardsView(ctx, ctx.argv[0])) },
    lbpeek: {
      run: async (ctx) => {
        const view = await leaderboardView(ctx, 1, 'xp');
        return ctx.ephemeral({ embeds: [{ ...view.embeds[0], footer: { text: 'Type /leaderboard for the full board with pages.' } }] });
      },
    },
    tmsg: owner(async (ctx) => { patchEarn(ctx.engine, { messageXp: earnOf(ctx.engine).messageXp === false }); return refresh(ctx); }),
    tvoice: owner(async (ctx) => { patchEarn(ctx.engine, { voiceXp: earnOf(ctx.engine).voiceXp !== true }); return refresh(ctx); }),
    tstack: admin(async (ctx) => { ctx.patchConfig({ stackRewards: ctx.config().stackRewards === false }); return refresh(ctx); }),
    ann: admin(async (ctx) => {
      const mode = ANNOUNCE_MODES.includes(ctx.argv[0]) ? ctx.argv[0] : 'here';
      if (mode === 'channel' && !ctx.config().channelId) return ctx.warn('Pick a channel first', PICK_CHANNEL_FIRST);
      ctx.patchConfig({ announce: mode });
      return refresh(ctx);
    }),
    rateform: owner((ctx) => {
      const earn = earnOf(ctx.engine);
      return ctx.form({
        title: 'XP rate and cooldown',
        action: 'ratesave',
        fields: [
          { id: 'rate', label: 'XP rate (1 = normal, 0.5 = half, 2 = double)', style: 'short', value: String(earn.rate), max: 5 },
          { id: 'cooldown', label: 'Seconds between XP gains (default 60)', style: 'short', value: String(earn.cooldownSeconds), max: 4 },
        ],
      });
    }),
    ratesave: owner(async (ctx) => {
      const rate = typedNumber(ctx.values?.rate, /x$/i);
      const cooldown = typedNumber(ctx.values?.cooldown, /s$/i);
      if (!Number.isFinite(rate) || rate < 0 || rate > 5) return ctx.warn("That rate didn't work", 'Use a number from 0 to 5, like 1 or 1.5.');
      if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 3600) return ctx.warn("That cooldown didn't work", 'Use whole seconds from 0 to 3600, like 60.');
      patchEarn(ctx.engine, { rate, cooldownSeconds: cooldown });
      return ctx.ok('Saved', `XP rate ×${rate}, at most once every ${cooldown} seconds per person, on every server.`);
    }),
    resetform: xpOwner((ctx) => ctx.form({
      title: 'Reset someone',
      action: 'resetuser',
      fields: [{ id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 }],
    })),
    resetuser: xpOwner(async (ctx) => {
      const q = String(ctx.values?.user ?? '').trim();
      const target = q ? await ctx.findUser(q) : null;
      if (!target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(q || '?', 40)}**.`);
      return resetUser(ctx, target);
    }),
    resetall: xpOwner((ctx) => resetAllConfirm(ctx)),
    resetallyes: xpOwner((ctx) => resetAll(ctx)),
    cancel: admin((ctx) => ctx.update({ embeds: [dialog.info('Cancelled', 'Nothing was reset.')], components: [] })),
  },

  events: {
    message: onMessage,
    member_join: onMemberJoin,
    voice_join: onVoiceJoin,
    voice_leave: onVoiceLeave,
  },

  yap: [
    { words: ['rank', 'level', 'xp'], run: (ctx) => showRank(ctx, ctx.argv) },
    { words: ['leaderboard', 'top'], run: (ctx) => showLeaderboard(ctx, ctx.argv) },
    {
      words: ['levels'],
      run: async (ctx) => {
        if (!ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showRank(ctx, []);
        return runLevels(ctx);
      },
    },
  ],

  panel: async (ctx) => {
    if (ctx.engine.perms.atLeast(await ctx.level(), 'admin')) return showSettings(ctx);
    return showRank(ctx, [], 'ephemeral');
  },

  dashboard: DASHBOARD,

  init: (engine) => {
    dashboardEngine = engine;
    try {
      mergeServerXp(engine);
    } catch (e) {
      engine.log.debug('[levels] folding old server XP failed', e?.message);
    }
  },

  services: (engine) => ({
    ranked: () => ranked(engine).map((u) => ({ id: u.id, xp: u.xp, level: Number.isInteger(u.level) ? u.level : levelFor(u.xp), messages: u.messages || 0 })),
    getUser: (sid, uid) => {
      const u = readUser(engine, uid);
      return { ...u, ...progressOf(u.xp), level: u.level };
    },
    addXp: (sid, uid, amount, reason, opts = {}) => addXp(engine, sid, uid, amount, { ...opts, reason }),
    levelFor,
    xpForLevel,
  }),

  presets: {
    gaming: { enabled: true, config: { announce: 'here' } },
    friends: { enabled: true, config: { announce: 'here' } },
    study: { enabled: true, config: { announce: 'off' } },
    community: { enabled: true, config: { rewards: {} } },
    roleplay: { enabled: true, config: { announce: 'here' } },
  },

  applyPreset: async (engine, serverId, { preset } = {}) => {
    if (preset === 'community') {
      const all = await engine.cache.channels(serverId).catch(() => []);
      const ch = all.filter((c) => c.type === 'text' || c.kind === 'text').find((c) => /level|rank|xp/.test(normalizeName(c.name)));
      engine.settings.patchApp(serverId, ID, ch ? { announce: 'channel', channelId: ch.id } : { announce: 'here' });
      return `Levels: XP for chatting is on, level-ups post in ${ch ? `#${ch.name}` : 'the same channel'}. Add role rewards with **/levels reward**.`;
    }
    const cfg = cfgOf(engine, serverId);
    const earn = earnOf(engine);
    const parts = [`XP for chatting${earn.rate !== 1 ? ` at ×${earn.rate}` : ''}`];
    if (earn.voiceXp) parts.push('voice');
    const where = cfg.announce === 'off' ? 'level-ups stay quiet' : 'level-ups post in the same channel';
    return `Levels: ${parts.join(' and ')} is on, ${where}. Levels count on every server.`;
  },

  help: [
    'Chatting earns 15 to 25 XP at most once a minute. Voice earns XP each full minute when you are not alone.',
    'Your XP, level and place on the leaderboard count everywhere, so one level follows you from server to server.',
    'How fast XP is earned is set once by the bot owner. Reward roles, level-up messages and no-XP spots are per server.',
    'Leveling up can give reward roles: /levels reward 10 @Regular. Bots, commands and very short messages earn nothing.',
    'Typed settings: /levels channel #level-ups | here | dm | off · /levels noxp #channel · /levels rate 1.5 · /levels set @sam 12 · /levels reset @sam',
  ],

  dispose: (engine) => { states.delete(engine); if (dashboardEngine === engine) dashboardEngine = null; },
});
