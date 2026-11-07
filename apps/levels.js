import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, bar, onOff, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, formatDuration, didYouMean, fillTemplate, clip, normalizeName, parseBool, channelId as channelMention, roleId as roleMention } from '../engine/parse.js';
import { permName, explain } from '../engine/errors.js';

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
    s = { lastXp: new Map(), pendingMsgs: new Map(), sessions: new Map(), closed: new Map(), voiceCache: new Map(), logged: new Set(), seen: 0 };
    states.set(engine, s);
  }
  return s;
}

const blankUser = () => ({ xp: 0, level: 0, voiceSeconds: 0, messages: 0, lastXpAt: 0 });
const readDoc = (engine, sid) => {
  const d = engine.store.get(ID, sid, { users: {} });
  d.users ||= {};
  return d;
};
const readUser = (engine, sid, uid) => ({ ...blankUser(), ...(readDoc(engine, sid).users[uid] || {}) });
const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);

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
  const text = clip(fillTemplate(cfg.message || DEFAULT_MESSAGE, { user: `<@${uid}>`, username, level, server: server?.name || 'the server' }), 2000);
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

function applyGain(engine, sid, uid, { xp = 0, voiceSeconds = 0, messages = 0 }) {
  let before = 0;
  let after = 0;
  let total = 0;
  engine.store.update(ID, sid, (d) => {
    d ||= { users: {} };
    d.users ||= {};
    const u = { ...blankUser(), ...(d.users[uid] || {}) };
    before = u.level;
    u.xp = Math.max(0, Math.round(u.xp + xp));
    u.level = levelFor(u.xp);
    u.voiceSeconds = Math.max(0, Math.round(u.voiceSeconds + voiceSeconds));
    u.messages += messages;
    if (xp > 0) u.lastXpAt = Date.now();
    d.users[uid] = u;
    after = u.level;
    total = u.xp;
    return d;
  }, { users: {} });
  return { before, level: after, xp: total, leveledUp: after > before };
}

async function addXp(engine, sid, uid, amount, extra = {}) {
  const res = applyGain(engine, sid, uid, { xp: Number(amount) || 0, voiceSeconds: extra.voiceSeconds, messages: extra.messages });
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
  if (cfg.messageXp === false) return;
  if ((cfg.noXpChannels || []).includes(msg.channel_id)) return;
  const st = stateOf(engine);
  const key = `${sid}:${uid}`;
  const now = Date.now();
  pruneTrackers(st, now);
  const last = st.lastXp.get(key);
  const cooldownMs = Math.max(0, Number(cfg.cooldownSeconds ?? 60)) * 1000;
  if (last !== undefined && now - last < cooldownMs) {
    st.pendingMsgs.set(key, (st.pendingMsgs.get(key) || 0) + 1);
    return;
  }
  const rate = Math.max(0, Number(cfg.rate ?? 1));
  if (!rate) return;
  st.lastXp.delete(key);
  st.lastXp.set(key, now);
  const messages = 1 + (st.pendingMsgs.get(key) || 0);
  st.pendingMsgs.delete(key);
  if ((cfg.noXpRoles || []).length) {
    const m = await engine.perms.member(sid, uid).catch(() => null);
    if (m && (m.roles || []).some((r) => cfg.noXpRoles.includes(r))) return;
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
  const cfg = cfgOf(engine, sid);
  if (cfg.voiceXp === false) return null;
  let company = trackedCompanion(st, sid, uid, s.channelId, now);
  if (!company) {
    try { company = (await voiceOthers(engine, sid, s.channelId, uid)).length > 0; } catch { company = true; }
  }
  if (!company) return null;
  const perMinute = Math.max(0, Number(cfg.voiceXpPerMinute ?? 5));
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
  if (cfgOf(engine, sid).voiceXp === false) return;
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

function ranked(engine, sid, sort = 'xp') {
  const field = sort === 'voice' ? 'voiceSeconds' : 'xp';
  return Object.entries(readDoc(engine, sid).users)
    .map(([id, u]) => ({ id, ...blankUser(), ...u }))
    .filter((u) => u[field] > 0)
    .sort((a, b) => b[field] - a[field] || b.xp - a.xp || a.id.localeCompare(b.id));
}

const voiceText = (s) => (s > 0 ? formatDuration(s * 1000) : 'none yet');

async function rankView(ctx, target) {
  const { engine, serverId: sid } = ctx;
  const u = readUser(engine, sid, target.id);
  const p = progressOf(u.xp);
  const list = ranked(engine, sid);
  const pos = list.findIndex((x) => x.id === target.id);
  const cfg = ctx.config();
  const next = rewardList(cfg).find((r) => r.level > p.level);
  const roles = next ? await ctx.roles().catch(() => []) : [];
  const nextRole = next ? roles.find((r) => r.id === next.roleId) : null;
  const name = target.nickname || target.display_name || target.username || 'Someone';
  const lines = [
    `**Level ${p.level}** · ${u.xp.toLocaleString('en-US')} XP`,
    `\`${bar(p.frac, 14)}\` ${p.into.toLocaleString('en-US')} / ${p.need.toLocaleString('en-US')} XP to level ${p.level + 1}`,
    pos >= 0 ? `🏆 Rank **#${pos + 1}** of ${list.length}` : '🏆 Not ranked yet. Chat a bit to get on the board!',
    `🎙️ Voice time: ${voiceText(u.voiceSeconds)}`,
    next ? `🎁 Next reward: **${nextRole ? `@${nextRole.name}` : 'a role'}** at level ${next.level}` : null,
  ].filter(Boolean);
  return {
    embeds: [card({ title: `${ICONS.levels} ${name}`, body: lines.join('\n'), color: 'levels' })],
    components: [row(button('Leaderboard', cid('lbpeek'), 'secondary', '🏆'))],
  };
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
  return ctx[how](await rankView(ctx, target));
}

async function leaderboardView(ctx, page, sort) {
  const { engine, serverId: sid } = ctx;
  const by = sort === 'voice' ? 'voice' : 'xp';
  const list = ranked(engine, sid, by);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const members = await ctx.members().catch(() => []);
  const names = new Map(members.map((m) => [m.id, m.nickname || m.display_name || m.username]));
  const slice = list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const lines = slice.map((u, i) => {
    const n = (p - 1) * PAGE_SIZE + i;
    const mark = MEDALS[n] || `**${n + 1}.**`;
    const who = names.get(u.id) || 'someone who left';
    return by === 'voice' ? `${mark} ${who} · ${voiceText(u.voiceSeconds)} in voice` : `${mark} ${who} · Level ${u.level} · ${u.xp.toLocaleString('en-US')} XP`;
  });
  const empty = by === 'voice' ? 'Nobody has voice time yet. Hop in a voice channel with friends!' : 'Nobody has XP yet. Start chatting to get on the board!';
  return {
    embeds: [card({ title: `🏆 Leaderboard${by === 'voice' ? ': voice time' : ''}`, body: lines.join('\n') || empty, color: 'levels', footer: `Page ${p} of ${pages} · ${list.length} ranked` })],
    components: [row(
      button('Prev', cid('lb', p - 1, by), 'secondary', '⬅️', { disabled: p <= 1 }),
      button('Next', cid('lb', p + 1, by), 'secondary', '➡️', { disabled: p >= pages }),
      button(by === 'voice' ? 'Sort by XP' : 'Sort by voice time', cid('lb', 1, by === 'voice' ? 'xp' : 'voice'), 'primary', by === 'voice' ? '📈' : '🎙️'),
    )],
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
  const [roles, channels] = await Promise.all([ctx.roles().catch(() => []), ctx.channels().catch(() => [])]);
  const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? `@${r.name}` : 'a deleted role'; };
  const chName = (id) => { const c = channels.find((x) => x.id === id); return c ? `#${c.name}` : 'a deleted channel'; };
  const rewards = rewardList(cfg);
  const mode = cfg.announce || 'here';
  const where = mode === 'channel' ? (cfg.channelId ? chName(cfg.channelId) : 'no channel picked yet, so the same channel') : mode === 'dm' ? 'a DM (falls back to the same channel if DMs are off)' : mode === 'off' ? 'nowhere' : 'the channel they were chatting in';
  const noXp = [...(cfg.noXpChannels || []).map(chName), ...(cfg.noXpRoles || []).map(roleName)];
  const fields = [
    { name: 'XP for chatting', value: `${onOff(cfg.messageXp !== false)} · ×${cfg.rate} · once every ${cfg.cooldownSeconds}s`, inline: true },
    { name: 'XP for voice', value: `${onOff(cfg.voiceXp === true)} · ${cfg.voiceXpPerMinute} XP a minute`, inline: true },
    { name: 'Level-up messages', value: `${ANNOUNCE_LABELS[mode] || mode}: ${where}`, inline: false },
    { name: `Role rewards (${rewards.length}/${MAX_REWARDS})${cfg.stackRewards === false ? ' · keep highest only' : ' · keep all'}`, value: clip(rewards.map((r) => `Level ${r.level} → ${roleName(r.roleId)}`).join('\n'), 1024) || 'None. Add one with `/levels reward 10 @Regular`.', inline: false },
    { name: 'No XP in', value: clip(noXp.join(', '), 1024) || 'Nowhere. Add with `/levels noxp #channel` or `/levels noxp @role`.', inline: false },
    { name: 'Ranked members', value: String(ranked(ctx.engine, ctx.serverId).length), inline: true },
  ];
  const body = 'Members earn XP for chatting and hanging out in voice, level up, and unlock reward roles.\nTyped settings: `/levels reward 10 @Regular` · `/levels channel #level-ups` · `/levels rate 1.5` · `/levels set @sam 12` · `/levels reset @sam`';
  return {
    embeds: [card({ title: `${ICONS.levels} Levels settings`, body, fields, color: 'levels' })],
    components: [
      row(
        button(cfg.messageXp !== false ? 'Chat XP: on' : 'Chat XP: off', cid('tmsg'), cfg.messageXp !== false ? 'success' : 'secondary', '💬'),
        button(cfg.voiceXp === true ? 'Voice XP: on' : 'Voice XP: off', cid('tvoice'), cfg.voiceXp === true ? 'success' : 'secondary', '🎙️'),
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

const showSettings = async (ctx) => ctx.ephemeral(await settingsView(ctx));

function snapshotUser(engine, sid, uid) {
  const u = readDoc(engine, sid).users[uid];
  return u ? structuredClone(u) : null;
}

function restoreUsers(engine, sid, saved, { additive = true } = {}) {
  engine.store.update(ID, sid, (d) => {
    d ||= { users: {} };
    d.users ||= {};
    for (const [uid, old] of Object.entries(saved)) {
      const cur = d.users[uid];
      if (!old) { delete d.users[uid]; continue; }
      if (!additive || !cur) { d.users[uid] = { ...old }; continue; }
      const xp = (old.xp || 0) + (cur.xp || 0);
      d.users[uid] = { ...old, xp, level: levelFor(xp), voiceSeconds: (old.voiceSeconds || 0) + (cur.voiceSeconds || 0), messages: (old.messages || 0) + (cur.messages || 0), lastXpAt: Math.max(old.lastXpAt || 0, cur.lastXpAt || 0) };
    }
    return d;
  }, { users: {} });
}

async function resetUser(ctx, target) {
  const { engine, serverId: sid } = ctx;
  const name = target.nickname || target.display_name || target.username || 'them';
  const saved = snapshotUser(engine, sid, target.id);
  if (!saved || !(saved.xp || saved.voiceSeconds)) return ctx.info('Nothing to reset', `**${name}** has no XP yet.`);
  engine.store.update(ID, sid, (d) => { d ||= { users: {} }; d.users ||= {}; delete d.users[target.id]; return d; }, { users: {} });
  stateOf(engine).lastXp.delete(`${sid}:${target.id}`);
  const undo = engine.router.addUndo({ serverId: sid, actorId: ctx.userId, label: `reset of ${name}`, perm: 'admin', run: async () => restoreUsers(engine, sid, { [target.id]: saved }) });
  return ctx.ok('XP reset', `**${name}** is back to level 0 (was level ${saved.level}, ${saved.xp} XP). Reward roles they already have stay.`, { components: [row(undo.button)] });
}

function resetAllConfirm(ctx) {
  const count = ranked(ctx.engine, ctx.serverId).length;
  if (!count) return ctx.info('Nothing to reset', 'Nobody has XP yet.');
  return ctx.ephemeral({
    embeds: [dialog.warn('Reset everyone?', `This sets all **${count}** ranked member${count === 1 ? '' : 's'} back to level 0 and clears voice time. Reward roles people already have stay.\nYou get an Undo button for 10 minutes.`)],
    components: [row(button('Yes, reset everyone', cid('resetallyes'), 'danger', '🧨'), button('Cancel', cid('cancel'), 'secondary'))],
  });
}

async function resetAll(ctx) {
  const { engine, serverId: sid } = ctx;
  const saved = readDoc(engine, sid).users;
  const count = Object.keys(saved).length;
  if (!count) return ctx.info('Already reset', 'Nobody has XP right now, so there was nothing to reset. If you just reset everyone, the Undo button is on that message.');
  engine.store.update(ID, sid, (d) => ({ ...(d || {}), users: {} }), { users: {} });
  const st = stateOf(engine);
  for (const k of [...st.lastXp.keys()]) if (k.startsWith(`${sid}:`)) st.lastXp.delete(k);
  const undo = engine.router.addUndo({ serverId: sid, actorId: ctx.userId, label: 'reset of everyone', perm: 'admin', run: async () => restoreUsers(engine, sid, saved) });
  const embeds = [dialog.ok('Everyone reset', `${count} member${count === 1 ? '' : 's'} went back to level 0. Changed your mind? Press Undo within 10 minutes.`)];
  return ctx.update({ embeds, components: [row(undo.button)] });
}

async function setLevel(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const lvlIdx = tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1]) ? tokens.length - 1 : -1;
  const levelTok = lvlIdx >= 0 ? tokens[lvlIdx] : undefined;
  const who = tokens.slice(0, lvlIdx >= 0 ? lvlIdx : tokens.length).join(' ');
  if (!who || levelTok === undefined) return ctx.warn('Who and which level?', 'Try `/levels set @sam 12`.');
  const level = Number(levelTok);
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return ctx.warn("That level didn't work", `Pick a level from 0 to ${MAX_LEVEL}.`);
  const target = await ctx.findUser(who);
  if (!target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(who, 40)}**.`);
  if (target.id === botId(engine)) return ctx.info("I don't level up", "Bots don't earn XP.");
  const saved = snapshotUser(engine, sid, target.id);
  const xp = totalXpForLevel(level);
  engine.store.update(ID, sid, (d) => {
    d ||= { users: {} };
    d.users ||= {};
    d.users[target.id] = { ...blankUser(), ...(d.users[target.id] || {}), xp, level };
    return d;
  }, { users: {} });
  const name = target.nickname || target.display_name || target.username || 'them';
  const undo = engine.router.addUndo({ serverId: sid, actorId: ctx.userId, label: `level of ${name}`, perm: 'admin', run: async () => restoreUsers(engine, sid, { [target.id]: saved }, { additive: false }) });
  const out = await ctx.ok('Level set', `**${name}** is now level ${level} (${xp.toLocaleString('en-US')} XP). Any rewards up to level ${level} are on their way.`, { components: [row(undo.button)] });
  grantRewards(engine, sid, target.id, level).catch((e) => engine.log.debug('[levels] rewards after set failed', e?.message));
  return out;
}

async function addReward(ctx, tokens) {
  const { engine, serverId: sid } = ctx;
  const level = Number(tokens[0]);
  const roleTok = tokens.slice(1).join(' ').trim();
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL || !roleTok) return ctx.warn('Which level and role?', 'Try `/levels reward 10 @Regular`, or `/levels reward remove 10`.');
  const role = await ctx.findRole(roleTok);
  if (!role) return ctx.warn("I couldn't find that role", `No role matches **${clip(roleTok, 40)}**.`);
  if (isEveryone(role, sid)) return ctx.warn("That role can't be a reward", 'Everyone already has @everyone.');
  const staff = staffPerms(role);
  if (staff.length) return ctx.warn("That role can't be a reward", `**@${role.name}** has staff permissions (${staff.map(permName).join(', ')}). Anyone who levels up would get them. Use a role without those permissions.`);
  const check = await engine.perms.canManageRole(sid, role.id);
  if (!check.ok) return ctx.warn("I can't hand out that role", check.reason);
  const cfg = ctx.config();
  const rewards = { ...(cfg.rewards || {}) };
  if (!rewards[level] && Object.keys(rewards).length >= MAX_REWARDS) return ctx.warn('Too many rewards', `You can have up to ${MAX_REWARDS}. Remove one with \`/levels reward remove 10\`.`);
  const prev = rewards[level] || null;
  rewards[level] = role.id;
  ctx.patchConfig({ rewards });
  forgetLogged(engine, sid);
  const undo = engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label: `level ${level} reward`, perm: 'admin',
    run: async () => {
      const cur = { ...(cfgOf(engine, sid).rewards || {}) };
      if (prev) cur[level] = prev; else delete cur[level];
      engine.settings.patchApp(sid, ID, { rewards: cur });
    },
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
  const undo = engine.router.addUndo({
    serverId: sid, actorId: ctx.userId, label: `level ${level} reward removal`, perm: 'admin',
    run: async () => {
      const cur = { ...(cfgOf(engine, sid).rewards || {}) };
      if (!cur[level] && Object.keys(cur).length < MAX_REWARDS) cur[level] = prev;
      engine.settings.patchApp(sid, ID, { rewards: cur });
    },
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

function numberSetting(ctx, tokens, { key, min, max, label, unit = '', integer = false }) {
  const n = Number(String(tokens[0] ?? '').replace(/^x|x$/i, ''));
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return ctx.warn(`That ${label} didn't work`, `Use a ${integer ? 'whole ' : ''}number from ${min} to ${max}.`);
  ctx.patchConfig({ [key]: n });
  return ctx.ok('Saved', `${label[0].toUpperCase()}${label.slice(1)} is now **${n}${unit}**.`);
}

function boolSetting(ctx, tokens, key, label) {
  const v = parseBool(tokens[0]);
  const current = key === 'voiceXp' ? ctx.config().voiceXp === true : ctx.config()[key] !== false;
  const next = v === null ? !current : v;
  ctx.patchConfig({ [key]: next });
  return ctx.ok('Saved', `${label} is now **${next ? 'on' : 'off'}**.`);
}

const SUBS = ['reward', 'rewards', 'channel', 'noxp', 'rate', 'cooldown', 'voice', 'voicerate', 'xp', 'stack', 'message', 'set', 'reset', 'settings'];

async function runLevels(ctx) {
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
  if (sub === 'rate' || sub === 'multiplier') return numberSetting(ctx, rest, { key: 'rate', min: 0, max: 5, label: 'XP rate', unit: '×' });
  if (sub === 'cooldown') return numberSetting(ctx, rest, { key: 'cooldownSeconds', min: 0, max: 3600, label: 'cooldown', unit: ' seconds', integer: true });
  if (sub === 'voicerate') return numberSetting(ctx, rest, { key: 'voiceXpPerMinute', min: 0, max: 100, label: 'voice XP a minute', integer: true });
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
    const next = /^reset$/i.test(text) ? DEFAULT_MESSAGE : clip(text, 500);
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

const admin = (run) => ({ perm: 'admin', run });
const refresh = async (ctx) => ctx.update(await settingsView(ctx));

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
    leaderboard: { description: 'Top members by XP: /leaderboard, /leaderboard 2 for page 2, /leaderboard voice', run: (ctx) => showLeaderboard(ctx, ctx.argv) },
    levels: { description: 'Levels settings (admins): /levels reward 10 @Regular, /levels channel #level-ups', perm: 'admin', run: runLevels },
  },

  components: {
    lb: { run: async (ctx) => ctx.update(await leaderboardView(ctx, ctx.argv[0], ctx.argv[1])) },
    lbpeek: {
      run: async (ctx) => {
        const view = await leaderboardView(ctx, 1, 'xp');
        return ctx.ephemeral({ embeds: [{ ...view.embeds[0], footer: { text: 'Type /leaderboard for the full board with pages.' } }] });
      },
    },
    tmsg: admin(async (ctx) => { ctx.patchConfig({ messageXp: ctx.config().messageXp === false }); return refresh(ctx); }),
    tvoice: admin(async (ctx) => { ctx.patchConfig({ voiceXp: ctx.config().voiceXp !== true }); return refresh(ctx); }),
    tstack: admin(async (ctx) => { ctx.patchConfig({ stackRewards: ctx.config().stackRewards === false }); return refresh(ctx); }),
    ann: admin(async (ctx) => {
      const mode = ANNOUNCE_MODES.includes(ctx.argv[0]) ? ctx.argv[0] : 'here';
      if (mode === 'channel' && !ctx.config().channelId) return ctx.warn('Pick a channel first', 'Type `/levels channel #level-ups` and level-ups go there.');
      ctx.patchConfig({ announce: mode });
      return refresh(ctx);
    }),
    rateform: admin((ctx) => {
      const cfg = ctx.config();
      return ctx.form({
        title: 'XP rate and cooldown',
        action: 'ratesave',
        fields: [
          { id: 'rate', label: 'XP rate (1 = normal, 0.5 = half, 2 = double)', style: 'short', value: String(cfg.rate), max: 5 },
          { id: 'cooldown', label: 'Seconds between XP gains (default 60)', style: 'short', value: String(cfg.cooldownSeconds), max: 4 },
        ],
      });
    }),
    ratesave: admin(async (ctx) => {
      await ctx.require('admin');
      const rate = Number(String(ctx.values?.rate ?? '').trim().replace(/x$/i, ''));
      const cooldown = Number(String(ctx.values?.cooldown ?? '').trim().replace(/s$/i, ''));
      if (!Number.isFinite(rate) || rate < 0 || rate > 5) return ctx.warn("That rate didn't work", 'Use a number from 0 to 5, like 1 or 1.5.');
      if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 3600) return ctx.warn("That cooldown didn't work", 'Use whole seconds from 0 to 3600, like 60.');
      ctx.patchConfig({ rate, cooldownSeconds: cooldown });
      return ctx.ok('Saved', `XP rate ×${rate}, at most once every ${cooldown} seconds per person.`);
    }),
    resetform: admin((ctx) => ctx.form({
      title: 'Reset someone',
      action: 'resetuser',
      fields: [{ id: 'user', label: 'Who? (@name or username)', style: 'short', placeholder: '@sam', max: 100 }],
    })),
    resetuser: admin(async (ctx) => {
      await ctx.require('admin');
      const q = String(ctx.values?.user ?? '').trim();
      const target = q ? await ctx.findUser(q) : null;
      if (!target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(q || '?', 40)}**.`);
      return resetUser(ctx, target);
    }),
    resetall: admin((ctx) => resetAllConfirm(ctx)),
    resetallyes: admin((ctx) => resetAll(ctx)),
    cancel: admin((ctx) => ctx.update({ embeds: [dialog.info('Cancelled', 'Nothing was reset.')], components: [] })),
  },

  events: {
    message: onMessage,
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

  services: (engine) => ({
    getUser: (sid, uid) => {
      const u = readUser(engine, sid, uid);
      return { ...u, ...progressOf(u.xp), level: u.level };
    },
    addXp: (sid, uid, amount, reason, opts = {}) => addXp(engine, sid, uid, amount, { ...opts, reason }),
    levelFor,
    xpForLevel,
  }),

  presets: {
    gaming: { enabled: true, config: { messageXp: true, voiceXp: true, announce: 'here' } },
    friends: { enabled: true, config: { messageXp: true } },
    study: { enabled: true, config: { voiceXp: true, announce: 'off', rate: 0.5 } },
    community: { enabled: true, config: { messageXp: true, rewards: {} } },
    roleplay: { enabled: true, config: { messageXp: true, cooldownSeconds: 90 } },
  },

  applyPreset: async (engine, serverId, { preset } = {}) => {
    if (preset === 'community') {
      const all = await engine.cache.channels(serverId).catch(() => []);
      const ch = all.filter((c) => c.type === 'text' || c.kind === 'text').find((c) => /level|rank|xp/.test(normalizeName(c.name)));
      engine.settings.patchApp(serverId, ID, ch ? { announce: 'channel', channelId: ch.id } : { announce: 'here' });
      return `Levels: XP for chatting is on, level-ups post in ${ch ? `#${ch.name}` : 'the same channel'}. Add role rewards with **/levels reward**.`;
    }
    const cfg = cfgOf(engine, serverId);
    const parts = [`XP for chatting${cfg.rate !== 1 ? ` at ×${cfg.rate}` : ''}`];
    if (cfg.voiceXp) parts.push('voice');
    const where = cfg.announce === 'off' ? 'level-ups stay quiet' : 'level-ups post in the same channel';
    return `Levels: ${parts.join(' and ')} is on, ${where}${cfg.cooldownSeconds !== 60 ? `, ${cfg.cooldownSeconds}s between XP gains` : ''}.`;
  },

  help: [
    'Chatting earns 15 to 25 XP at most once a minute. Voice earns XP each full minute when you are not alone.',
    'Leveling up can give reward roles: /levels reward 10 @Regular. Bots, commands and very short messages earn nothing.',
    'Typed settings: /levels channel #level-ups | here | dm | off · /levels noxp #channel · /levels rate 1.5 · /levels set @sam 12 · /levels reset @sam',
  ],

  dispose: (engine) => { states.delete(engine); },
});
