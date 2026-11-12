import { randomBytes } from 'node:crypto';
import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, clip, fuzzyFind, didYouMean, userId as mentionedUser, channelId as mentionedChannel } from '../engine/parse.js';
import { explain, permName, looksLikeFeatureOff } from '../engine/errors.js';
import { accept, reject, isBlank, channelById } from '../engine/dashboard.js';

const ID = 'voice';
const cid = (action, ...args) => customId(ID, action, ...args);

const CREATE_NAME = '➕ Create room';
const CATEGORY_NAME = 'Voice rooms';
const NAME_MAX = 32;
const DEFAULT_MAX_ROOMS = 20;
const MAX_ROOMS = 50;
const CREATES_PER_MINUTE = 5;
const MINUTE = 60_000;
const SWEEP_EVERY_MS = 10 * MINUTE;
const STARTUP_SWEEP_MS = 15_000;
const NEW_ROOM_GRACE_MS = MINUTE;
const MOVE_WAITS = [800, 1600, 3000];
const RENAME_COOLDOWN_MS = 30_000;
const ACCESS_COOLDOWN_MS = 3_000;
const PICK_LIMIT = 20;
const ROLE_GRANT_LIMIT = 20;
const MEMO_LIMIT = 500;
const FORM_MS = 15 * MINUTE;
const ROOM_PERMS = ['view_channel', 'connect'];
const LINK_RE = /https?:\/\/|www\.|\b[\w-]+\.(?:gg|com|net|org|io|xyz|ly|me|tv|website)\b/i;
const PING_RE = /@(?:everyone|here)\b|<@[!&]?[\w-]+>|<#[\w-]+>/i;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const states = new WeakMap();
function stateOf(engine) {
  let s = states.get(engine);
  if (!s) {
    s = { creating: new Set(), closing: new Set(), made: new Map(), logged: new Set(), forms: new Map(), renamed: new Map(), access: new Map(), retry: new Map() };
    states.set(engine, s);
  }
  return s;
}

function remember(map, key, value) {
  if (map.size >= MEMO_LIMIT) map.delete(map.keys().next().value);
  map.set(key, value);
}

const now = (engine) => (typeof engine.scheduler?.now === 'function' ? engine.scheduler.now() : Date.now());
const botId = (engine) => engine.bot.me?.id;
const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const maxRooms = (cfg) => {
  const n = Math.floor(Number(cfg?.maxRooms));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_ROOMS, n) : DEFAULT_MAX_ROOMS;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const chars = (s) => Array.from(String(s ?? ''));
const fit = (s, max = NAME_MAX) => {
  const a = chars(s);
  return a.length <= max ? String(s) : `${a.slice(0, max - 1).join('').trimEnd()}…`;
};
const cleanName = (raw) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>@`|\\]/g, '').replace(/\s+/g, ' ').trim();
const mdSafe = (text, fallback = 'a room') => String(text ?? '').replace(/[*_`~|\\<>]/g, '').replace(/@/g, '@​').replace(/\s+/g, ' ').trim() || fallback;
const displayName = (m) => m?.nickname || m?.display_name || m?.username || 'Someone';
const looksLikeCreate = (name) => /createroom|jointocreate|createvc|createavc|makearoom/.test(String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
const debug = (engine, what) => (e) => engine.log.debug(`[voice] ${what}`, e?.message);

function readRooms(engine, sid) {
  const doc = engine.store.get(ID, sid, { rooms: {} });
  return doc?.rooms && typeof doc.rooms === 'object' ? doc.rooms : {};
}
const roomList = (engine, sid) => Object.values(readRooms(engine, sid)).filter((r) => r && r.id);
const roomById = (engine, sid, id) => (id ? readRooms(engine, sid)[id] || null : null);
const roomByKey = (engine, sid, key) => roomList(engine, sid).find((r) => r.key === key) || null;
const roomOfOwner = (engine, sid, uid) => roomList(engine, sid).find((r) => r.ownerId === uid) || null;

function editDoc(engine, sid, fn) {
  engine.store.update(ID, sid, (d) => {
    const doc = d && typeof d === 'object' ? d : {};
    doc.rooms = { ...(doc.rooms && typeof doc.rooms === 'object' ? doc.rooms : {}) };
    fn(doc.rooms);
    return doc;
  }, { rooms: {} });
}
const writeRoom = (engine, sid, room) => { editDoc(engine, sid, (rooms) => { rooms[room.id] = room; }); return room; };
function patchRoom(engine, sid, id, patch) {
  let out = null;
  editDoc(engine, sid, (rooms) => {
    if (!rooms[id]) return;
    out = { ...rooms[id], ...patch };
    rooms[id] = out;
  });
  return out;
}
const dropRoom = (engine, sid, id) => editDoc(engine, sid, (rooms) => { delete rooms[id]; });

function newKey(engine, sid) {
  const taken = new Set(roomList(engine, sid).map((r) => r.key));
  for (let i = 0; i < 20; i++) {
    const k = randomBytes(3).toString('hex');
    if (!taken.has(k)) return k;
  }
  return randomBytes(4).toString('hex');
}

async function logProblem(engine, sid, tag, text, title = 'Voice rooms problem') {
  const st = stateOf(engine);
  const k = `${sid}:${tag}`;
  if (st.logged.has(k)) return;
  if (st.logged.size >= MEMO_LIMIT) st.logged.clear();
  st.logged.add(k);
  const embed = card({ title: `${ICONS.voice} ${title}`, body: text, color: 'voice' });
  try {
    const mod = engine.service('mod');
    if (mod?.log) { await mod.log(sid, embed); return; }
    const ch = engine.settings.core(sid).logChannel;
    if (!ch) { engine.log.warn(`[voice] ${text}`); return; }
    await engine.budget.send({ serverId: sid, channelId: ch, opts: { embeds: [embed] }, priority: 'low' });
  } catch (e) {
    engine.log.debug('[voice] log failed', e?.message);
  }
}
const solved = (engine, sid, ...tags) => { for (const t of tags) stateOf(engine).logged.delete(`${sid}:${t}`); };

async function peopleIn(engine, sid, channelId, { without } = {}) {
  const list = await engine.bot.voice(sid);
  const entry = (list || []).find((v) => v.channel_id === channelId);
  if (!entry) return null;
  return (entry.user_ids || []).filter((u) => u !== botId(engine) && u !== without);
}

async function insideRoom(engine, sid, room) {
  const people = await peopleIn(engine, sid, room.id).catch(() => undefined);
  if (people === undefined) return null;
  if (people === null) return room.hidden ? null : [];
  return people;
}

function filteredWord(engine, sid, name) {
  try {
    const am = engine.service('automod');
    if (typeof am?.findBadWord !== 'function' || !engine.settings.isEnabled(sid, 'automod')) return null;
    const cfg = engine.settings.appConfig(sid, 'automod');
    if (cfg?.filters?.words === false) return null;
    return am.findBadWord(name, cfg?.words?.list || []);
  } catch {
    return null;
  }
}

export function checkName(engine, sid, raw) {
  const text = String(raw ?? '');
  if (PING_RE.test(text)) return { ok: false, reason: "Room names can't mention people, roles or channels." };
  if (LINK_RE.test(text)) return { ok: false, reason: "Links and invites can't go in a room name." };
  const name = cleanName(text);
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, reason: 'Use at least one letter or number.' };
  const n = chars(name).length;
  if (n > NAME_MAX) return { ok: false, reason: `Room names can be up to ${NAME_MAX} characters. That one has ${n}.` };
  if (engine && filteredWord(engine, sid, name)) return { ok: false, reason: 'That name has a word this server filters out. Try another one.' };
  return { ok: true, name };
}

export function roomNameFor(member, engine = null, sid = null) {
  const base = cleanName(displayName(member)) || 'Someone';
  const suffix = "'s room";
  const whole = `${base}${suffix}`;
  const name = chars(whole).length <= NAME_MAX ? whole : `${chars(base).slice(0, NAME_MAX - chars(suffix).length - 1).join('').trimEnd()}…${suffix}`;
  return checkName(engine, sid, name).ok ? name : 'Voice room';
}

async function levelOf(engine, sid, uid) { return engine.perms.level(sid, uid).catch(() => 'member'); }
async function isMod(engine, sid, uid) { return engine.perms.atLeast(await levelOf(engine, sid, uid), 'mod'); }
async function mayRun(engine, sid, uid, room) { return room.ownerId === uid || isMod(engine, sid, uid); }
const notYours = (room) => dialog.denied(null, { title: 'Not your room', body: `Only <@${room.ownerId}> and moderators can change **${mdSafe(room.name)}**.` });

async function rolesState(engine, sid) {
  if (engine.caps.state(sid, 'roles') === false) return { ok: false, reason: "role management isn't turned on for this server yet" };
  const can = await engine.perms.botCan(sid, 'manage_roles').catch(() => ({ ok: true }));
  if (!can.ok) return { ok: false, reason: `my role needs **${permName('manage_roles')}**` };
  return { ok: true };
}

const panelText = (room) => `<@${room.ownerId}>'s voice room controls`;

async function panelView(engine, sid, room, note) {
  const roles = await rolesState(engine, sid);
  const lines = [
    `👑 Owner: <@${room.ownerId}>`,
    room.locked ? '🔒 Locked: only people who were inside can join' : '🔓 Open: anyone can join',
    room.hidden ? '🙈 Hidden: only people who were inside can see it' : '👁️ Visible in the channel list',
  ];
  if (note) lines.push('', note);
  if (!roles.ok) lines.push('', `-# Lock and Hide aren't available: ${roles.reason}.`);
  const embed = card({ title: `${ICONS.voice} ${mdSafe(room.name)}`, body: lines.join('\n'), color: 'voice', footer: 'Only the room owner and moderators can use these buttons. Empty rooms close by themselves.' });
  const lockOff = !roles.ok && !room.locked;
  const hideOff = !roles.ok && !room.hidden;
  const a = [sid, room.key];
  return {
    content: panelText(room),
    embeds: [embed],
    components: [
      row(
        button('Rename', cid('rename', ...a), 'secondary', '✏️'),
        button(lockOff ? 'Lock (unavailable)' : room.locked ? 'Unlock' : 'Lock', cid('lock', ...a), room.locked ? 'success' : 'secondary', room.locked ? '🔓' : '🔒', { disabled: lockOff }),
        button(hideOff ? 'Hide (unavailable)' : room.hidden ? 'Show' : 'Hide', cid('hide', ...a), room.hidden ? 'success' : 'secondary', '👁️', { disabled: hideOff }),
        button('Kick someone', cid('kick', ...a), 'secondary', '👢'),
        button('Transfer', cid('xfer', ...a), 'secondary', '👑'),
      ),
      row(button('Close room', cid('close', ...a), 'danger', '🗑️')),
    ],
  };
}

async function postPanel(engine, sid, room, note) {
  const view = await panelView(engine, sid, room, note);
  const opts = { embeds: view.embeds, components: view.components };
  const target = cfgOf(engine, sid).panelChannel;
  if (target) {
    try {
      const sent = await engine.budget.send({ serverId: sid, channelId: target, content: `<@${room.ownerId}> your voice room is ready. These buttons run it.`, opts, priority: 'normal' });
      if (sent?.id) { solved(engine, sid, 'panel'); return { channelId: target, messageId: sent.id, dm: false }; }
    } catch (e) {
      const { body } = explain(e, { action: 'post room panels in', perm: 'send_messages' });
      await logProblem(engine, sid, 'panel', `I couldn't post a room control panel in <#${target}>, so I sent it to the room owner by DM instead.\n${body}`);
    }
  }
  try {
    const server = await engine.perms.server(sid).catch(() => null);
    const where = server?.name ? ` in **${mdSafe(server.name, 'the server')}**` : '';
    return await engine.caps.attempt(sid, 'dms', async () => {
      const dm = await engine.bot.dm(room.ownerId);
      const sent = await engine.budget.send({ channelId: dm, content: `Your voice room${where} is ready. These buttons run it.`, opts, priority: 'normal' });
      return sent?.id ? { channelId: dm, messageId: sent.id, dm: true } : null;
    }, () => null);
  } catch (e) {
    engine.log.debug('[voice] panel DM failed', e?.message);
    return null;
  }
}

function refreshPanel(engine, sid, room, { skip, note } = {}) {
  if (!room?.panel?.messageId || room.panel.messageId === skip) return;
  panelView(engine, sid, room, note)
    .then((view) => engine.budget.edit({ channelId: room.panel.channelId, messageId: room.panel.messageId, content: room.panel.dm ? undefined : view.content, opts: { embeds: view.embeds, components: view.components }, minGap: 250 }))
    .catch(debug(engine, 'panel refresh failed'));
}

async function closeRoom(engine, sid, room, { channelGone = false } = {}) {
  const st = stateOf(engine);
  const k = `${sid}:${room.id}`;
  if (st.closing.has(k)) return false;
  st.closing.add(k);
  try {
    if (!channelGone) {
      try {
        await engine.bot.deleteChannel(room.id);
      } catch (e) {
        if (e?.status !== 404) {
          const { body } = explain(e, { action: 'delete an empty voice room', perm: 'manage_channels' });
          await logProblem(engine, sid, `delete:${room.id}`, `I couldn't delete **${mdSafe(room.name)}** after it emptied.\n${body}`);
          return false;
        }
      }
    }
    if (room.roleId) {
      await engine.bot.deleteRole(sid, room.roleId).catch(debug(engine, 'room role cleanup failed'));
      engine.perms.invalidate(`r:${sid}`);
    }
    if (room.panel?.messageId) await engine.bot.delete(room.panel.channelId, room.panel.messageId).catch(() => {});
    dropRoom(engine, sid, room.id);
    st.renamed.delete(room.id);
    st.access.delete(room.id);
    solved(engine, sid, `delete:${room.id}`);
    engine.cache.invalidate(sid);
    return true;
  } finally {
    st.closing.delete(k);
  }
}

function scheduleSweep(engine, sid, delayMs = SWEEP_EVERY_MS) {
  try {
    engine.scheduler?.schedule({ kind: `${ID}.sweep`, serverId: sid, key: 'sweep', at: now(engine) + delayMs, repeat: { everyMs: SWEEP_EVERY_MS } });
  } catch (e) {
    engine.log.debug('[voice] could not schedule the sweep', e?.message);
  }
}
function ensureSweep(engine, sid) {
  try {
    if (!engine.scheduler?.list({ kind: `${ID}.sweep`, serverId: sid }).length) scheduleSweep(engine, sid);
  } catch (e) {
    engine.log.debug('[voice] sweep check failed', e?.message);
  }
}

function takeSlot(engine, sid) {
  const st = stateOf(engine);
  const t = Date.now();
  const list = (st.made.get(sid) || []).filter((x) => t - x < MINUTE);
  if (list.length >= CREATES_PER_MINUTE) {
    st.made.set(sid, list);
    return { ok: false, waitMs: Math.max(1000, list[0] + MINUTE - t + 500) };
  }
  list.push(t);
  remember(st.made, sid, list);
  return { ok: true };
}

function retryLater(engine, sid, uid, waitMs) {
  const st = stateOf(engine);
  const k = `${sid}:${uid}`;
  if (st.retry.has(k) || st.retry.size >= MEMO_LIMIT) return;
  const timer = setTimeout(async () => {
    st.retry.delete(k);
    try {
      if (!engine.settings.isEnabled(sid, ID)) return;
      const cfg = cfgOf(engine, sid);
      if (!cfg.createChannelId) return;
      const waiting = await peopleIn(engine, sid, cfg.createChannelId);
      if (waiting?.includes(uid)) await createRoomFor(engine, sid, uid);
    } catch (e) {
      engine.log.debug('[voice] retry failed', e?.message);
    }
  }, waitMs);
  timer.unref?.();
  st.retry.set(k, timer);
}

async function inAnyVoice(engine, sid, uid) {
  try {
    const list = await engine.bot.voice(sid);
    return (list || []).some((v) => (v.user_ids || []).includes(uid));
  } catch {
    return true;
  }
}

async function moveIn(engine, sid, uid, channelId) {
  const waits = Array.isArray(engine.config?.voiceMoveWaits) ? engine.config.voiceMoveWaits : MOVE_WAITS;
  let error = null;
  for (let i = 0; i <= waits.length; i++) {
    try {
      await engine.bot.moveMember(sid, uid, channelId);
      return { ok: true };
    } catch (e) {
      error = e;
      if (e?.status === 403 || e?.status === 404 || i === waits.length) break;
      await new Promise((r) => { const t = setTimeout(r, waits[i]); t.unref?.(); });
    }
  }
  engine.log.debug('[voice] move into new room failed', error?.status, error?.message);
  return { ok: false, error };
}

async function createRoomFor(engine, sid, uid) {
  const st = stateOf(engine);
  const flight = `${sid}:${uid}`;
  if (st.creating.has(flight)) return null;
  st.creating.add(flight);
  try {
    const cfg = cfgOf(engine, sid);
    if (!cfg.createChannelId) return null;
    const own = roomOfOwner(engine, sid, uid);
    if (own) {
      if (await engine.bot.channel(own.id)) {
        await engine.bot.moveMember(sid, uid, own.id).catch(debug(engine, 'move back to own room failed'));
        return own;
      }
      await closeRoom(engine, sid, own, { channelGone: true });
    }
    const max = maxRooms(cfg);
    if (roomList(engine, sid).length >= max) {
      await logProblem(engine, sid, 'full', `Someone joined **${CREATE_NAME}**, but ${plural(max, 'room')} are already open, the most this server allows. Empty rooms close by themselves. An admin can raise the limit with \`/voice limit 30\`.`, 'Voice rooms are full');
      return null;
    }
    const slot = takeSlot(engine, sid);
    if (!slot.ok) {
      await logProblem(engine, sid, 'busy', `Lots of people joined **${CREATE_NAME}** at once. Yapin' lets a server make 10 channels a minute, so some people wait a moment; I make their rooms as soon as I can.`, 'Voice rooms are busy');
      retryLater(engine, sid, uid, slot.waitMs);
      return null;
    }
    const member = await engine.perms.member(sid, uid).catch(() => null);
    const name = roomNameFor(member, engine, sid);
    const source = await engine.bot.channel(cfg.createChannelId);
    const categoryId = source?.category_id ?? source?.category?.id ?? cfg.categoryId ?? undefined;
    let channel;
    try {
      channel = await engine.bot.createChannel(sid, name, { kind: 'voice', categoryId: categoryId || undefined });
    } catch (e) {
      const { body } = explain(e, { action: 'make a voice room', perm: 'manage_channels' });
      await logProblem(engine, sid, 'create', `**${mdSafe(displayName(member), 'Someone')}** joined **${CREATE_NAME}**, but I couldn't make their room.\n${body}`, "Couldn't make a voice room");
      return null;
    }
    if (!channel?.id) return null;
    const landed = channel.category_id !== undefined ? channel.category_id : channel.category !== undefined ? (channel.category?.id ?? null) : undefined;
    if (categoryId && landed !== undefined && landed !== categoryId) {
      await engine.bot.editChannel(channel.id, { categoryId }).catch(debug(engine, 'move new room into its category failed'));
    }
    solved(engine, sid, 'create', 'full', 'busy');
    engine.cache.invalidate(sid);
    const room = writeRoom(engine, sid, { id: channel.id, key: newKey(engine, sid), ownerId: uid, name: channel.name || name, createdAt: now(engine), roleId: null, locked: false, hidden: false, panel: null });
    ensureSweep(engine, sid);
    const moved = await moveIn(engine, sid, uid, channel.id);
    let note;
    if (moved.ok) solved(engine, sid, 'move');
    else {
      const stillInVoice = await inAnyVoice(engine, sid, uid);
      if (!stillInVoice) {
        await closeRoom(engine, sid, room);
        return null;
      }
      patchRoom(engine, sid, room.id, { waiting: true });
      note = `➡️ I couldn't move you in by myself, so click <#${room.id}> to join your room. It stays open for a minute while you get there.`;
      if (moved.error?.status === 403) {
        const { body } = explain(moved.error, { action: 'move people into their new room', perm: 'move_members' });
        await logProblem(engine, sid, 'move', `I made a room for **${mdSafe(displayName(member), 'someone')}** but couldn't move them into it, so they have to click it to join.\n${body}`, "Couldn't move someone into their room");
      }
    }
    const panel = await postPanel(engine, sid, roomById(engine, sid, room.id) || room, note);
    if (!panel) return room;
    const saved = patchRoom(engine, sid, room.id, { panel });
    if (!saved) await engine.bot.delete(panel.channelId, panel.messageId).catch(() => {});
    return saved;
  } finally {
    st.creating.delete(flight);
  }
}

async function transferRoom(engine, sid, room, newOwner, note) {
  const updated = patchRoom(engine, sid, room.id, { ownerId: newOwner });
  if (!updated) return null;
  if (updated.roleId) await engine.bot.addRole(sid, newOwner, updated.roleId).catch(debug(engine, 'room role for new owner failed'));
  if (updated.panel?.dm) {
    await engine.bot.delete(updated.panel.channelId, updated.panel.messageId).catch(() => {});
    const panel = await postPanel(engine, sid, updated);
    return patchRoom(engine, sid, room.id, { panel }) || updated;
  }
  refreshPanel(engine, sid, updated, { note });
  return updated;
}

async function passOn(engine, sid, room, people) {
  const next = people.find((u) => u !== room.ownerId && !roomOfOwner(engine, sid, u));
  if (!next) return null;
  return transferRoom(engine, sid, room, next, `👑 <@${room.ownerId}> left, so <@${next}> runs the room now.`);
}

async function sweepServer(engine, sid, { active = true } = {}) {
  const cfg = cfgOf(engine, sid);
  const rooms = roomList(engine, sid);
  if (!rooms.length && !cfg.createChannelId) return;
  const channels = await engine.bot.channels(sid);
  const ids = new Set((channels || []).map((c) => c.id));
  if (active && cfg.createChannelId && !ids.has(cfg.createChannelId) && !(await engine.bot.channel(cfg.createChannelId))) {
    engine.settings.patchApp(sid, ID, { createChannelId: null });
    await logProblem(engine, sid, 'gone', `The **${CREATE_NAME}** channel was deleted, so nobody can make voice rooms right now. An admin can run **/voice setup** to make a new one.`, 'Voice rooms are off');
  }
  if (!rooms.length) return;
  const voice = await engine.bot.voice(sid);
  const t = now(engine);
  for (const room of rooms) {
    const seen = ids.has(room.id) || !!(await engine.bot.channel(room.id));
    if (!seen) { await closeRoom(engine, sid, room); continue; }
    const entry = (voice || []).find((v) => v.channel_id === room.id);
    if (!entry && room.hidden) continue;
    const people = (entry?.user_ids || []).filter((u) => u !== botId(engine));
    if (people.length) {
      if (active && !people.includes(room.ownerId)) await passOn(engine, sid, room, people);
      continue;
    }
    if (t - (Number(room.createdAt) || 0) < NEW_ROOM_GRACE_MS) continue;
    await closeRoom(engine, sid, room);
  }
}

async function onVoiceJoin(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !uid || uid === botId(engine)) return;
  const cfg = cfgOf(engine, sid);
  if (!cfg.createChannelId || ev.channel_id !== cfg.createChannelId) return;
  await createRoomFor(engine, sid, uid);
}

function recheckLater(engine, sid, roomId, waitMs) {
  const st = stateOf(engine);
  const k = `${sid}:${roomId}`;
  st.rechecks ||= new Map();
  if (st.rechecks.has(k)) return;
  const timer = setTimeout(async () => {
    st.rechecks.delete(k);
    try {
      const room = roomById(engine, sid, roomId);
      if (!room) return;
      const people = await insideRoom(engine, sid, room);
      if (people && !people.length) await closeRoom(engine, sid, room);
    } catch (e) {
      engine.log.debug('[voice] empty room recheck failed', e?.message);
    }
  }, waitMs);
  timer.unref?.();
  st.rechecks.set(k, timer);
}

async function onVoiceLeave(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const uid = ev.user_id;
  if (!sid || !ev.channel_id || uid === botId(engine)) return;
  const room = roomById(engine, sid, ev.channel_id);
  if (!room) return;
  let people;
  try {
    people = await peopleIn(engine, sid, room.id, { without: uid });
  } catch (e) {
    engine.log.debug('[voice] voice lookup failed', e?.message);
    return;
  }
  if (people === null && room.hidden) {
    if (!(await engine.bot.channel(room.id))) await closeRoom(engine, sid, room);
    return;
  }
  if (people === null) people = [];
  if (!people.length) {
    const age = now(engine) - (Number(room.createdAt) || 0);
    if (room.waiting && age < NEW_ROOM_GRACE_MS) {
      recheckLater(engine, sid, room.id, NEW_ROOM_GRACE_MS - age + 1000);
      return;
    }
    await closeRoom(engine, sid, room);
    return;
  }
  if (uid === room.ownerId && !people.includes(room.ownerId)) await passOn(engine, sid, room, people);
}

async function onChannelDelete(ctx, ev) {
  const { engine } = ctx;
  const sid = ev.server_id;
  const id = ev.id || ev.channel_id;
  if (!sid || !id) return;
  const room = roomById(engine, sid, id);
  if (room) await closeRoom(engine, sid, room, { channelGone: true });
  if (cfgOf(engine, sid).createChannelId === id) {
    engine.settings.patchApp(sid, ID, { createChannelId: null });
    await logProblem(engine, sid, 'gone', `The **${CREATE_NAME}** channel was deleted, so nobody can make voice rooms right now. An admin can run **/voice setup** to make a new one.`, 'Voice rooms are off');
  }
}

async function ensureRole(engine, sid, room) {
  if (room.roleId) {
    const known = await engine.perms.roles(sid).catch(() => []);
    if (known.some((r) => r.id === room.roleId)) return room.roleId;
    engine.perms.invalidate(`r:${sid}`);
    const fresh = await engine.perms.roles(sid).catch(() => []);
    if (fresh.some((r) => r.id === room.roleId)) return room.roleId;
  }
  const role = await engine.bot.createRole(sid, { name: fit(`🔊 ${room.name}`), mentionable: false, permissions: {} });
  engine.perms.invalidate(`r:${sid}`);
  if (!role?.id) return null;
  if (!(await sinkRole(engine, sid, role))) {
    await engine.bot.deleteRole(sid, role.id).catch(debug(engine, 'unplaced room role cleanup failed'));
    engine.perms.invalidate(`r:${sid}`);
    return null;
  }
  patchRoom(engine, sid, room.id, { roleId: role.id });
  room.roleId = role.id;
  return role.id;
}

async function sinkRole(engine, sid, role) {
  const all = await engine.perms.roles(sid).catch(() => []);
  const isEveryone = (r) => r.id === 'everyone' || r.id === sid || /^@?everyone$/i.test(String(r.name));
  const others = all.filter((r) => r.id !== role.id && !isEveryone(r) && typeof r.position === 'number');
  if (!others.length) return true;
  const bottom = Math.max(1, Math.min(...others.map((r) => r.position)));
  if (typeof role.position === 'number' && role.position <= bottom) return true;
  try {
    const moved = await engine.bot.editRole(sid, role.id, { position: bottom });
    engine.perms.invalidate(`r:${sid}`);
    return !(typeof moved?.position === 'number' && moved.position > bottom);
  } catch (e) {
    engine.log.debug('[voice] could not move the room role down', e?.message);
    return false;
  }
}

async function grantRole(engine, sid, room, roleId) {
  const inside = (await peopleIn(engine, sid, room.id).catch(() => null)) || [];
  const ids = [...new Set([room.ownerId, ...inside])].slice(0, ROLE_GRANT_LIMIT);
  const holders = await Promise.all(ids.map((uid) => engine.perms.member(sid, uid).then((m) => !!m?.roles?.includes(roleId)).catch(() => false)));
  for (const [i, uid] of ids.entries()) {
    if (holders[i]) continue;
    try {
      await engine.bot.addRole(sid, uid, roleId);
    } catch (e) {
      if (looksLikeFeatureOff(e)) throw e;
      engine.log.debug('[voice] room role grant failed', e?.message);
    }
  }
  const me = botId(engine);
  const mine = me ? await engine.perms.member(sid, me).catch(() => null) : null;
  if (me && !mine?.roles?.includes(roleId)) await engine.bot.addRole(sid, me, roleId).catch(() => {});
  engine.perms.invalidate(`m:${sid}:`);
}

async function applyAccess(engine, sid, room, want) {
  const deny = [want.locked && 'connect', want.hidden && 'view_channel'].filter(Boolean);
  if (!deny.length) {
    await engine.bot.setChannelPermissions(room.id, 'everyone', { allow: [], deny: [] });
    return { roleId: room.roleId || null };
  }
  const state = await rolesState(engine, sid);
  if (!state.ok) return { unavailable: state.reason };
  return engine.caps.attempt(sid, 'roles', async () => {
    const roleId = await ensureRole(engine, sid, room);
    if (!roleId) return { unavailable: "I couldn't put the room role at the bottom of the role list, and a higher one would get in the way of moderators" };
    await grantRole(engine, sid, room, roleId);
    await engine.bot.setChannelPermissions(room.id, roleId, { allow: ROOM_PERMS, deny: [] });
    await engine.bot.setChannelPermissions(room.id, 'everyone', { allow: [], deny });
    return { roleId };
  }, () => ({ unavailable: "role management isn't turned on for this server yet" }));
}

const onPanel = (ctx) => ctx.kind === 'button' && !!ctx.source?.message_id;

async function showChange(ctx, sid, room, okEmbed, note) {
  const { engine } = ctx;
  if (onPanel(ctx)) {
    await ctx.update(await panelView(engine, sid, room, note));
    refreshPanel(engine, sid, room, { skip: ctx.source.message_id });
    return;
  }
  refreshPanel(engine, sid, room);
  await ctx.ephemeral({ embeds: [okEmbed] });
}

const ACCESS = {
  locked: { on: 'Lock', off: 'Unlock', onDone: 'Room locked', offDone: 'Room unlocked', onBody: 'Only people who were inside can join now.', offBody: 'Anyone can join again.' },
  hidden: { on: 'Hide', off: 'Show', onDone: 'Room hidden', offDone: 'Room visible', onBody: 'Only people who were inside can see it now.', offBody: 'Everyone can see it in the channel list again.' },
};

async function setAccess(ctx, sid, room, field, value) {
  const { engine } = ctx;
  const words = ACCESS[field];
  const next = value === undefined ? !room[field] : !!value;
  if (!!room[field] === next) return ctx.info(next ? `Already ${field}` : `Not ${field}`, next ? words.onBody : words.offBody);
  const st = stateOf(engine);
  const last = st.access.get(room.id);
  const wait = last ? ACCESS_COOLDOWN_MS - (now(engine) - last) : 0;
  if (wait > 0) return ctx.warn('Slow down a little', `Give it ${Math.ceil(wait / 1000)} more seconds before changing who can join or see the room.`);
  remember(st.access, room.id, now(engine));
  const want = { locked: !!room.locked, hidden: !!room.hidden, [field]: next };
  let res;
  try {
    res = await applyAccess(engine, sid, room, want);
  } catch (e) {
    st.access.delete(room.id);
    return ctx.fail(e, { action: `${(next ? words.on : words.off).toLowerCase()} the room`, perm: 'manage_roles' });
  }
  const fresh = roomById(engine, sid, room.id) || room;
  if (res?.unavailable) {
    st.access.delete(room.id);
    const note = `⚠️ ${words.on} isn't available: ${res.unavailable}.`;
    if (onPanel(ctx)) return ctx.update(await panelView(engine, sid, fresh, note));
    return ctx.warn(`${words.on} isn't available here`, `I can't do that because ${res.unavailable}. Everything else still works.`);
  }
  const updated = patchRoom(engine, sid, room.id, { ...want, roleId: res.roleId }) || { ...fresh, ...want, roleId: res.roleId };
  return showChange(ctx, sid, updated, dialog.ok(next ? words.onDone : words.offDone, next ? words.onBody : words.offBody));
}

async function renameRoom(ctx, sid, room, raw) {
  const { engine } = ctx;
  const check = checkName(engine, sid, raw);
  if (!check.ok) return ctx.warn("That name didn't work", check.reason);
  if (check.name === room.name) return ctx.info('Same name', `The room is already called **${mdSafe(room.name)}**.`);
  const st = stateOf(engine);
  const last = st.renamed.get(room.id);
  const wait = last ? RENAME_COOLDOWN_MS - (Date.now() - last) : 0;
  if (wait > 0) return ctx.warn('Slow down a little', `Rooms can be renamed once every ${RENAME_COOLDOWN_MS / 1000} seconds. Try again in ${Math.ceil(wait / 1000)} seconds.`);
  try {
    await engine.bot.editChannel(room.id, { name: check.name });
  } catch (e) {
    return ctx.fail(e, { action: 'rename the room', perm: 'manage_channels' });
  }
  remember(st.renamed, room.id, Date.now());
  engine.cache.invalidate(sid);
  const updated = patchRoom(engine, sid, room.id, { name: check.name }) || { ...room, name: check.name };
  refreshPanel(engine, sid, updated);
  return ctx.ok('Room renamed', `It's now called **${mdSafe(check.name)}**.`);
}

async function pickable(engine, sid, room) {
  const ids = ((await peopleIn(engine, sid, room.id).catch(() => null)) || []).filter((id) => id !== room.ownerId).slice(0, 25);
  const members = await Promise.all(ids.map((id) => engine.perms.member(sid, id).catch(() => null)));
  return ids.map((id, i) => ({ id, name: fit(cleanName(displayName(members[i])) || 'Someone', 80) }));
}

async function picker(ctx, sid, room, people, { title, body, action, fallback, emoji }) {
  const embeds = [card({ title, body, color: 'voice', footer: false })];
  return ctx.engine.caps.attempt(sid, 'selects',
    () => ctx.ephemeral({ embeds, components: [select(cid(action, sid, room.key), people.map((p) => ({ label: p.name, value: p.id, emoji })), { placeholder: 'Pick someone' })] }),
    () => ctx.ephemeral({ embeds, components: rows(people.slice(0, PICK_LIMIT).map((p) => button(p.name, cid(fallback, sid, room.key, p.id), 'secondary', emoji))) }));
}

async function answer(ctx, embed) {
  if (ctx.kind === 'select' || onPanel(ctx)) return ctx.update({ content: '', embeds: [embed], components: [] });
  return ctx.ephemeral({ embeds: [embed] });
}

async function kickPerson(ctx, sid, room, targetId) {
  const { engine } = ctx;
  if (!targetId) return ctx.warn('Kick who?', 'Try `/voice kick @sam`.');
  if (targetId === botId(engine)) return ctx.info("That's me", "I'm not in your room.");
  if (targetId === room.ownerId) return ctx.warn("That's the owner", 'Transfer the room first if they should go.');
  const inside = await insideRoom(engine, sid, room);
  if (!inside) return answer(ctx, dialog.warn("I can't see who's inside", "I couldn't check who is in the room right now, so I left everyone where they are. Try again in a moment."));
  if (!inside.includes(targetId)) return answer(ctx, dialog.info('Already gone', `<@${targetId}> isn't in the room any more.`));
  const actorMod = await isMod(engine, sid, ctx.userId);
  if (!actorMod && engine.perms.atLeast(await levelOf(engine, sid, targetId), 'mod')) {
    return answer(ctx, dialog.denied(null, { title: "Can't kick a moderator", body: 'Moderators and admins can only be dropped from a room by another moderator.' }));
  }
  const check = await engine.perms.canActOn(sid, targetId, actorMod ? { actorId: ctx.userId } : {});
  if (!check.ok) return answer(ctx, dialog.warn("I can't kick them", check.reason));
  try {
    await engine.bot.disconnectMember(sid, targetId);
  } catch (e) {
    return ctx.fail(e, { action: 'drop', target: `<@${targetId}>`, perm: 'move_members' });
  }
  if (room.roleId) await engine.bot.removeRole(sid, targetId, room.roleId).catch(debug(engine, 'room role removal failed'));
  const tail = room.locked ? "The room is locked, so they can't come back in." : 'The room is open, so they can join again. Lock it to keep them out.';
  return answer(ctx, dialog.ok('Kicked', `<@${targetId}> was dropped from **${mdSafe(room.name)}**. ${tail}`));
}

async function giveRoom(ctx, sid, room, targetId) {
  const { engine } = ctx;
  if (!targetId) return ctx.warn('Give it to who?', 'Try `/voice transfer @sam`.');
  if (targetId === room.ownerId) return answer(ctx, dialog.info('Already theirs', `<@${targetId}> already owns this room.`));
  if (targetId === botId(engine)) return answer(ctx, dialog.info("That's me", "I can't own a room."));
  const inside = await insideRoom(engine, sid, room);
  if (!inside || !inside.includes(targetId)) return answer(ctx, dialog.warn('They need to be in the room', `<@${targetId}> isn't in **${mdSafe(room.name)}** right now. Rooms can only go to someone inside.`));
  const other = roomOfOwner(engine, sid, targetId);
  if (other && other.id !== room.id) return answer(ctx, dialog.warn('They already have a room', `<@${targetId}> owns **${mdSafe(other.name)}**. Everyone gets one room at a time.`));
  const updated = await transferRoom(engine, sid, room, targetId, `👑 <@${room.ownerId}> gave the room to <@${targetId}>.`);
  if (!updated) return answer(ctx, dialog.info('This room is closed', 'It was deleted in the meantime.'));
  return answer(ctx, dialog.ok('Room transferred', `<@${targetId}> runs **${mdSafe(room.name)}** now.${updated.panel?.dm ? ' I sent them the controls by DM.' : ''}`));
}

function closeConfirm(ctx, sid, room) {
  return ctx.ephemeral({
    embeds: [dialog.warn('Close this room?', `**${mdSafe(room.name)}** is deleted and everyone inside is dropped from voice.`)],
    components: [row(button('Yes, close it', cid('closeyes', sid, room.key), 'danger', '🗑️'), button('Keep it', cid('keep'), 'secondary'))],
  });
}

async function roomFromClick(ctx) {
  const { engine } = ctx;
  const [sid, key] = ctx.argv;
  if (!sid || (ctx.serverId && ctx.serverId !== sid)) { await ctx.warn('Wrong server', 'These buttons belong to another server.'); return null; }
  if (!engine.settings.isEnabled(sid, ID)) { await ctx.warn("Voice rooms aren't installed here", 'An admin can install them with **/apps**.'); return null; }
  const room = roomByKey(engine, sid, key);
  if (!room) {
    await ctx.info('This room is closed', 'It was deleted, so these buttons do nothing now. Join the create channel to make a new room.');
    return null;
  }
  if (!(await mayRun(engine, sid, ctx.userId, room))) { await ctx.ephemeral({ embeds: [notYours(room)] }); return null; }
  return { sid, room };
}

const roomAction = (fn) => ({
  run: async (ctx) => {
    const hit = await roomFromClick(ctx);
    if (!hit) return undefined;
    return fn(ctx, hit.sid, hit.room);
  },
});

function howTo(ctx) {
  const cfg = ctx.config();
  if (!cfg.createChannelId) return ["Voice rooms aren't set up yet", 'An admin can turn them on with **/voice setup**. Then anyone can join one channel and get their own voice room.'];
  return ["You don't have a room right now", `Join <#${cfg.createChannelId}> and I'll make your own voice room and move you in. You get buttons to rename, lock, hide and close it.\n-# Empty rooms close by themselves.`];
}

async function isAdmin(ctx) { return ctx.engine.perms.atLeast(await ctx.level().catch(() => 'member'), 'admin'); }

async function settingsView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  const rooms = roomList(engine, sid);
  const roles = await rolesState(engine, sid);
  const can = await engine.perms.botCan(sid, 'manage_channels', 'move_members').catch(() => ({ ok: true, missing: [] }));
  const fields = [
    { name: 'Create channel', value: cfg.createChannelId ? `<#${cfg.createChannelId}>` : 'Not set up yet. Press **Set up** or type `/voice setup`.', inline: true },
    { name: 'Control panels', value: cfg.panelChannel ? `Posted in <#${cfg.panelChannel}>` : 'Sent to the room owner by DM', inline: true },
    { name: 'Rooms open', value: `${rooms.length} of ${maxRooms(cfg)}`, inline: true },
    rooms.length ? { name: 'Open rooms', value: clip(rooms.slice(0, 15).map((r) => `🔊 ${mdSafe(r.name)} · <@${r.ownerId}>${r.locked ? ' · 🔒' : ''}${r.hidden ? ' · 🙈' : ''}`).join('\n'), 1024) } : null,
    can.ok ? null : { name: '⚠️ Missing permissions', value: `My role needs ${(can.missing || []).map((p) => `**${permName(p)}**`).join(' and ')} to make rooms and move people in.` },
    roles.ok ? null : { name: 'Lock and Hide', value: `Not available: ${roles.reason}.` },
  ];
  const body = "People join one channel and get their own voice room with a control panel. Empty rooms are deleted on their own.\nTyped: `/voice setup` · `/voice setup #channel` · `/voice setup category` · `/voice panels #room-panels` · `/voice panels dm` · `/voice limit 20` · `/voice close Sam's room`";
  return {
    embeds: [card({ title: `${ICONS.voice} Voice rooms`, body, fields, color: 'voice' })],
    components: [row(
      button(cfg.createChannelId ? 'Set up again' : 'Set up', cid('setup'), 'primary', '🚀'),
      button('Panels here', cid('panelhere'), 'secondary', '📌'),
      button('Panels by DM', cid('paneldm'), 'secondary', '✉️'),
      button('Room limit', cid('limitform'), 'secondary', '🔢'),
      rooms.length ? button('Close a room', cid('rooms'), 'danger', '🗑️') : null,
    )],
  };
}

async function openHome(ctx) {
  const { engine, serverId: sid } = ctx;
  const own = roomOfOwner(engine, sid, ctx.userId);
  if (own) return ctx.ephemeral(await panelView(engine, sid, own));
  if (await isAdmin(ctx)) return ctx.ephemeral(await settingsView(ctx));
  const [title, body] = howTo(ctx);
  return ctx.info(title, body);
}

async function runSetup(ctx, words) {
  await ctx.require('admin');
  const { engine, serverId: sid } = ctx;
  const isCat = (w) => /^(category|cat|folder)$/i.test(w);
  const wantCategory = words.some(isCat);
  const query = words.filter((w) => !isCat(w)).join(' ').trim();
  const can = await engine.perms.botCan(sid, 'manage_channels', 'move_members').catch(() => ({ ok: true, missing: [] }));
  let channel = null;
  let made = false;
  let category = null;
  const notes = [];
  if (query) {
    channel = await ctx.findChannel(query, 'voice');
    if (!channel) return ctx.warn("I couldn't find that voice channel", `No voice channel matches **${clip(query, 40)}**. Try \`/voice setup\` on its own and I'll make one.`);
    if (roomById(engine, sid, channel.id)) return ctx.warn("That's someone's room", "Pick a normal voice channel, or run `/voice setup` on its own and I'll make one.");
  } else {
    const voiceChannels = await ctx.channels('voice').catch(() => []);
    const current = ctx.config().createChannelId;
    channel = voiceChannels.find((c) => c.id === current) || voiceChannels.find((c) => looksLikeCreate(c.name) && !roomById(engine, sid, c.id)) || null;
  }
  if (!channel) {
    if ((can.missing || []).includes('manage_channels')) return ctx.warn("I can't make channels", `My role needs **${permName('manage_channels')}** to make the **${CREATE_NAME}** channel and the rooms.\n-# Fix: Server settings → Roles → my role → tick it.`);
    if (wantCategory) {
      try {
        category = await engine.bot.createCategory(sid, CATEGORY_NAME);
      } catch (e) {
        engine.log.debug('[voice] category failed', e?.message);
        notes.push(`I couldn't make a **${CATEGORY_NAME}** category, so the channel sits outside one.`);
      }
    }
    try {
      channel = await engine.bot.createChannel(sid, CREATE_NAME, { kind: 'voice', categoryId: category?.id });
      made = true;
    } catch (e) {
      return ctx.fail(e, { action: 'make the create channel', perm: 'manage_channels' });
    }
    engine.cache.invalidate(sid);
  } else if (wantCategory) {
    notes.push(`I used the channel you already have, so I didn't make a category. Rooms appear next to <#${channel.id}>.`);
  }
  const categoryId = category?.id ?? channel.category_id ?? channel.category?.id ?? null;
  ctx.patchConfig({ createChannelId: channel.id, categoryId });
  solved(engine, sid, 'gone', 'create', 'move');
  scheduleSweep(engine, sid);
  const cfg = ctx.config();
  const lines = [
    made ? `I made <#${channel.id}>${category ? ` in a new **${CATEGORY_NAME}** category` : ''}.` : `Using <#${channel.id}>.`,
    'Anyone who joins it gets their own voice room and is moved in. Empty rooms are deleted on their own.',
    cfg.panelChannel ? `Room control panels go to <#${cfg.panelChannel}>.` : 'Room owners get their control panel by DM. Post panels in a channel instead with `/voice panels #channel`.',
    ...notes,
  ];
  const missing = (can.missing || []).filter((p) => p !== 'manage_channels' || !made);
  if (missing.length) lines.push(`⚠️ My role still needs ${missing.map((p) => `**${permName(p)}**`).join(' and ')} for rooms to work.`);
  return ctx.ok('Voice rooms are ready', lines.join('\n'));
}

async function setPanels(ctx, text) {
  await ctx.require('admin');
  const t = text.trim();
  const cfg = ctx.config();
  if (!t) return ctx.info('Room control panels', `${cfg.panelChannel ? `They go to <#${cfg.panelChannel}>.` : 'They go to the room owner by DM.'}\nChange it with \`/voice panels #channel\`, \`/voice panels here\` or \`/voice panels dm\`.`);
  if (PANELS_OFF.test(t)) {
    ctx.patchConfig({ panelChannel: null });
    return ctx.ok('Panels go by DM', 'New room owners get their control panel by DM.');
  }
  const channel = /^here$/i.test(t) ? { id: ctx.channelId } : await ctx.findChannel(t);
  if (!channel?.id) return ctx.warn("I couldn't find that channel", `No text channel matches **${clip(t, 40)}**.`);
  ctx.patchConfig({ panelChannel: channel.id });
  return ctx.ok('Panels saved', `New room control panels go to <#${channel.id}>. Only each room's owner and moderators can press their buttons.`);
}

const LIMIT_HELP = `Pick a whole number from 1 to ${MAX_ROOMS}, like \`/voice limit 20\`.`;
const PANELS_OFF = /^(dm|dms|off|none|direct)$/i;

function checkRoomLimit(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_ROOMS ? n : null;
}

const DASHBOARD = [
  { key: 'createChannelId', label: 'Join-to-create channel', type: 'voice_channel', web: false, help: 'People who join this voice channel get their own temporary voice room.', note: 'Set it up in the server with /voice setup, which also checks my permissions and starts the room sweep.' },
  {
    key: 'panelChannel', label: 'Room control panels channel', type: 'channel', web: true,
    help: 'Where new room control panels are posted. Empty means the room owner gets theirs by DM.',
    validate: async (ctx, v) => {
      if (isBlank(v) || (typeof v === 'string' && PANELS_OFF.test(v.trim()))) return accept(null);
      const ch = await channelById(ctx, v);
      return ch ? accept(ch.id) : reject(`No text channel matches **${clip(String(v), 40)}**.`);
    },
  },
  {
    key: 'maxRooms', label: 'Most rooms open at once', type: 'number', web: true, min: 1, max: MAX_ROOMS, step: 1,
    help: 'How many join-to-create rooms can exist at the same time.',
    validate: (ctx, v) => {
      const n = checkRoomLimit(v);
      return n === null ? reject(LIMIT_HELP) : accept(n);
    },
  },
  { key: 'categoryId', label: 'Rooms category', type: 'category', web: false, help: 'Category new rooms are created in when the create channel has none.', note: 'Set by /voice setup from the join-to-create channel.' },
];

async function setLimit(ctx, value) {
  await ctx.require('admin');
  const n = checkRoomLimit(value);
  if (n === null) return ctx.warn("That limit didn't work", LIMIT_HELP);
  ctx.patchConfig({ maxRooms: n });
  return ctx.ok('Room limit saved', `Up to ${plural(n, 'room')} can be open at once.`);
}

async function turnOff(ctx) {
  await ctx.require('admin');
  const cfg = ctx.config();
  if (!cfg.createChannelId) return ctx.info('Already off', 'Voice rooms are not set up. Turn them on with `/voice setup`.');
  ctx.patchConfig({ createChannelId: null });
  return ctx.ok('Voice rooms are off', `I won't make new rooms. Open rooms still close when they empty. <#${cfg.createChannelId}> is still there; delete it if you don't need it, or run \`/voice setup\` to turn rooms back on.`);
}

async function roomsList(ctx, how = 'ephemeral') {
  await ctx.require('mod');
  const { engine, serverId: sid } = ctx;
  const rooms = roomList(engine, sid);
  if (!rooms.length) return ctx.info('No rooms open', 'Nobody has a voice room right now.');
  const body = rooms.slice(0, PICK_LIMIT).map((r) => `🔊 **${mdSafe(r.name)}** · <@${r.ownerId}>${r.locked ? ' · 🔒' : ''}${r.hidden ? ' · 🙈' : ''}`).join('\n');
  const view = {
    embeds: [card({ title: `${ICONS.voice} Open voice rooms (${rooms.length})`, body, color: 'voice', footer: 'Press a room to close it. You get a confirm step first.' })],
    components: rows(rooms.slice(0, PICK_LIMIT).map((r) => button(fit(r.name, 70), cid('close', sid, r.key), 'danger', '🗑️'))),
  };
  return how === 'update' ? ctx.update(view) : ctx.ephemeral(view);
}

async function findRoom(ctx, query) {
  const { engine, serverId: sid } = ctx;
  const rooms = roomList(engine, sid);
  const q = String(query ?? '').trim();
  if (!q) return null;
  const id = mentionedChannel(q) || UUID_RE.exec(q)?.[1];
  if (id && rooms.some((r) => r.id === id)) return rooms.find((r) => r.id === id);
  const uid = mentionedUser(q);
  if (uid) return roomOfOwner(engine, sid, uid);
  const byName = fuzzyFind(q.replace(/^#/, ''), rooms, { key: (r) => r.name })?.item;
  if (byName) return byName;
  const member = await ctx.findUser(q).catch(() => null);
  return member?.id ? roomOfOwner(engine, sid, member.id) : null;
}

async function ownRoom(ctx) {
  const room = roomOfOwner(ctx.engine, ctx.serverId, ctx.userId);
  if (room) return room;
  const [title, body] = howTo(ctx);
  await ctx.info(title, body);
  return null;
}

async function closeTyped(ctx, query) {
  const { engine, serverId: sid } = ctx;
  if (!query) {
    const own = roomOfOwner(engine, sid, ctx.userId);
    if (own) return closeConfirm(ctx, sid, own);
    if (await isMod(engine, sid, ctx.userId)) return roomsList(ctx);
    const [title, body] = howTo(ctx);
    return ctx.info(title, body);
  }
  const room = await findRoom(ctx, query);
  if (!room) {
    const guess = didYouMean(query, roomList(engine, sid).map((r) => r.name));
    return ctx.warn("I couldn't find that room", `No open room matches **${clip(query, 40)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${mdSafe(g)}**`).join(', ')}?` : ''}`);
  }
  if (!(await mayRun(engine, sid, ctx.userId, room))) return ctx.ephemeral({ embeds: [notYours(room)] });
  return closeConfirm(ctx, sid, room);
}

const SUBS = ['setup', 'settings', 'panels', 'limit', 'off', 'rooms', 'close', 'rename', 'lock', 'unlock', 'hide', 'show', 'kick', 'transfer'];

async function runVoice(ctx) {
  const sid = ctx.serverId;
  const tokens = ctx.argv.length ? ctx.argv : tokenize(ctx.args);
  const sub = String(tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  const text = String(ctx.args || '').trim();
  const restText = text.toLowerCase().startsWith(sub) && sub ? text.slice(sub.length).trim() : rest.join(' ');
  if (!sub || ['room', 'panel', 'me', 'my'].includes(sub)) return openHome(ctx);
  if (['settings', 'config', 'admin'].includes(sub)) { await ctx.require('admin'); return ctx.ephemeral(await settingsView(ctx)); }
  if (sub === 'setup') return runSetup(ctx, rest);
  if (['off', 'disable', 'stop'].includes(sub)) return turnOff(ctx);
  if (['panels', 'panelchannel'].includes(sub)) return setPanels(ctx, restText);
  if (['limit', 'max'].includes(sub)) return setLimit(ctx, rest[0]);
  if (['rooms', 'list'].includes(sub)) return roomsList(ctx);
  if (['close', 'delete', 'end'].includes(sub)) return closeTyped(ctx, restText);
  if (['rename', 'name'].includes(sub)) {
    const room = await ownRoom(ctx);
    if (!room) return undefined;
    if (!restText) return ctx.warn('Rename it to what?', `Try \`/voice rename Movie night\` (up to ${NAME_MAX} characters).`);
    return renameRoom(ctx, sid, room, restText);
  }
  const access = { lock: ['locked', true], unlock: ['locked', false], hide: ['hidden', true], show: ['hidden', false], unhide: ['hidden', false] }[sub];
  if (access) {
    const room = await ownRoom(ctx);
    return room ? setAccess(ctx, sid, room, access[0], access[1]) : undefined;
  }
  if (sub === 'kick' || sub === 'transfer' || sub === 'give') {
    const room = await ownRoom(ctx);
    if (!room) return undefined;
    const target = restText ? await ctx.findUser(restText) : null;
    if (restText && !target?.id) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(restText, 40)}**.`);
    return sub === 'kick' ? kickPerson(ctx, sid, room, target?.id) : giveRoom(ctx, sid, room, target?.id);
  }
  const guess = didYouMean(sub, SUBS);
  return ctx.warn("I didn't get that", `I don't know **${clip(sub, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nType \`/voice\` on its own for your room or the settings.`);
}

const admin = (run) => ({ perm: 'admin', run: async (ctx) => { await ctx.require('admin'); return run(ctx); } });
const refreshSettings = async (ctx) => (onPanel(ctx) ? ctx.update(await settingsView(ctx)) : ctx.ephemeral(await settingsView(ctx)));

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Voice rooms',
  icon: ICONS.voice,
  description: 'Join-to-create voice rooms with a control panel.',
  category: 'Community',
  panelPerm: 'member',

  defaults: {
    createChannelId: null,
    categoryId: null,
    panelChannel: null,
    maxRooms: DEFAULT_MAX_ROOMS,
  },

  dashboard: DASHBOARD,

  commands: {
    voice: { description: 'Your voice room and its controls. Admins: /voice setup. Mods: /voice close <room>', run: runVoice },
  },

  components: {
    rename: roomAction(async (ctx, sid, room) => {
      remember(stateOf(ctx.engine).forms, ctx.userId, { sid, key: room.key, at: Date.now() });
      return ctx.form({
        title: 'Rename your room',
        action: 'renamesave',
        fields: [{ id: 'name', label: `New name (up to ${NAME_MAX} characters)`, style: 'short', value: room.name, max: NAME_MAX }],
      });
    }),
    renamesave: {
      run: async (ctx) => {
        const st = stateOf(ctx.engine);
        const pending = st.forms.get(ctx.userId);
        if (!pending || Date.now() - pending.at > FORM_MS) return ctx.warn('This form expired', 'Press **Rename** on your room panel again.');
        st.forms.delete(ctx.userId);
        const room = roomByKey(ctx.engine, pending.sid, pending.key);
        if (!room) return ctx.info('This room is closed', 'It was deleted before the new name arrived.');
        if (!(await mayRun(ctx.engine, pending.sid, ctx.userId, room))) return ctx.ephemeral({ embeds: [notYours(room)] });
        return renameRoom(ctx, pending.sid, room, ctx.values?.name);
      },
    },
    lock: roomAction((ctx, sid, room) => setAccess(ctx, sid, room, 'locked')),
    hide: roomAction((ctx, sid, room) => setAccess(ctx, sid, room, 'hidden')),
    kick: roomAction(async (ctx, sid, room) => {
      const people = await pickable(ctx.engine, sid, room);
      if (!people.length) return ctx.info('Nobody to kick', 'Nobody else is in the room right now.');
      return picker(ctx, sid, room, people, { title: '👢 Kick someone', body: `Who should leave **${mdSafe(room.name)}**?`, action: 'kickpick', fallback: 'kickp', emoji: '👢' });
    }),
    kickpick: roomAction((ctx, sid, room) => kickPerson(ctx, sid, room, ctx.values?.[0])),
    kickp: roomAction((ctx, sid, room) => kickPerson(ctx, sid, room, ctx.argv[2])),
    xfer: roomAction(async (ctx, sid, room) => {
      const people = await pickable(ctx.engine, sid, room);
      if (!people.length) return ctx.info('Nobody to give it to', 'The room can only go to someone who is in it, and nobody else is here right now.');
      return picker(ctx, sid, room, people, { title: '👑 Transfer the room', body: `Who should run **${mdSafe(room.name)}**?`, action: 'xferpick', fallback: 'xferp', emoji: '👑' });
    }),
    xferpick: roomAction((ctx, sid, room) => giveRoom(ctx, sid, room, ctx.values?.[0])),
    xferp: roomAction((ctx, sid, room) => giveRoom(ctx, sid, room, ctx.argv[2])),
    close: roomAction((ctx, sid, room) => closeConfirm(ctx, sid, room)),
    closeyes: roomAction(async (ctx, sid, room) => {
      const done = await closeRoom(ctx.engine, sid, room);
      if (!done) return answer(ctx, dialog.warn("I couldn't close it", 'Deleting the channel failed. The log channel has the details; a moderator can delete it by hand.'));
      return answer(ctx, dialog.ok('Room closed', `**${mdSafe(room.name)}** is gone.`));
    }),
    keep: { run: (ctx) => answer(ctx, dialog.info('Kept', 'The room stays open.')) },
    setup: admin((ctx) => runSetup(ctx, [])),
    panelhere: admin(async (ctx) => {
      if (!ctx.serverId || !ctx.channelId) return ctx.warn('Use this in a channel', 'Open the voice settings in the channel where panels should go.');
      ctx.patchConfig({ panelChannel: ctx.channelId });
      return refreshSettings(ctx);
    }),
    paneldm: admin(async (ctx) => { ctx.patchConfig({ panelChannel: null }); return refreshSettings(ctx); }),
    limitform: admin((ctx) => ctx.form({
      title: 'Room limit',
      action: 'limitsave',
      fields: [{ id: 'limit', label: `Most rooms open at once (1 to ${MAX_ROOMS})`, style: 'short', value: String(maxRooms(ctx.config())), max: 2 }],
    })),
    limitsave: admin((ctx) => setLimit(ctx, ctx.values?.limit)),
    rooms: { perm: 'mod', run: (ctx) => roomsList(ctx) },
  },

  events: {
    voice_join: onVoiceJoin,
    voice_leave: onVoiceLeave,
    channel_delete: onChannelDelete,
  },

  jobs: {
    sweep: async (job, engine) => {
      if (!job.serverId) return undefined;
      if (engine.settings.isEnabled(job.serverId, ID)) return sweepServer(engine, job.serverId);
      await sweepServer(engine, job.serverId, { active: false });
      if (!roomList(engine, job.serverId).length) engine.scheduler.cancelWhere({ kind: `${ID}.sweep`, serverId: job.serverId });
      return undefined;
    },
  },

  onUninstall: (engine, sid) => {
    if (roomList(engine, sid).length) scheduleSweep(engine, sid, 1000);
  },

  yap: [{ words: ['voice', 'vc', 'room'], run: runVoice }],

  panel: openHome,

  help: [
    `Join **${CREATE_NAME}** to get your own voice room. I move you in and send you its control panel.`,
    'Room owners: /voice rename <name> · /voice lock · /voice hide · /voice kick @sam · /voice transfer @sam · /voice close',
    'Admins: /voice setup [#channel] [category] · /voice panels #channel | dm · /voice limit 20. Mods: /voice rooms · /voice close <room>',
  ],

  init(engine) {
    for (const sid of engine.store.keys(ID)) {
      if (roomList(engine, sid).length) scheduleSweep(engine, sid, STARTUP_SWEEP_MS);
    }
  },

  dispose(engine) {
    const st = states.get(engine);
    if (st) for (const t of st.retry.values()) clearTimeout(t);
    if (st?.rechecks) for (const t of st.rechecks.values()) clearTimeout(t);
    states.delete(engine);
  },
});
