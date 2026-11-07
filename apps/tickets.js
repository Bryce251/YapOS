import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, freeze, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, clip, normalizeName, didYouMean, parseBool, fuzzyFind, formatDuration } from '../engine/parse.js';
import { explain, looksLikeFeatureOff } from '../engine/errors.js';

const ID = 'tickets';
const cid = (action, ...args) => customId(ID, action, ...args);

const CLOSE_DELAY_MS = 10_000;
const MAX_TYPES = 5;
const MAX_QUESTIONS = 3;
const MAX_CLOSED_KEPT = 500;
const CHUNK_SIZE = 1900;
const MAX_CHUNKS = 10;
const PREVIEW_CHUNKS = 3;
const MAX_PAGES = 50;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 500;
const MAX_LIMIT = 10;
const TRANSCRIPT_COOLDOWN_MS = 60_000;
const STAFF_PERMS = ['administrator', 'manage_server', 'kick_members', 'ban_members', 'timeout_members', 'manage_messages'];
const CAP_CHECKS = ['roles', 'files', 'dms', 'selects', 'modals'];
const CAP_LABELS = { roles: 'Role management', files: 'Sending files', dms: 'Direct messages', selects: 'Select menus', modals: 'Pop-up forms' };

const TYPES = {
  support: { id: 'support', name: 'Support', emoji: '🎫', questions: [] },
  report: { id: 'report', name: 'Report', emoji: '🚩', questions: ['Who or what are you reporting?', 'What happened?'] },
  appeal: { id: 'appeal', name: 'Appeal', emoji: '⚖️', questions: ['What were you punished for?', 'Why should we change it?'] },
  question: { id: 'question', name: 'Question', emoji: '❓', questions: ['What is your question?'] },
  character: { id: 'character', name: 'Character approval', emoji: '📜', questions: ['Character name', 'Tell us about your character'] },
};
const DEFAULT_TYPES = [TYPES.support];
const PRESET_TYPES = {
  community: [TYPES.support, TYPES.report],
  gaming: [TYPES.support, TYPES.appeal],
  study: [TYPES.question],
  roleplay: [TYPES.support, TYPES.character],
};

const SUBS = {
  open: 'open', new: 'open', create: 'open',
  close: 'close', claim: 'claim', unclaim: 'unclaim',
  add: 'add', remove: 'remove', rename: 'rename', transcript: 'transcript',
};
const ADMIN_SUBS = {
  panel: 'panel', post: 'panel', category: 'category', cat: 'category', staff: 'staff', log: 'log', logs: 'log',
  types: 'types', type: 'types', limit: 'limit', ping: 'ping', tidy: 'tidy', cleanup: 'tidy', settings: 'home', home: 'home',
};
const OFF_WORDS = /^(off|none|clear|reset|default|no)$/i;

const runtimes = new WeakMap();
function rt(engine) {
  let r = runtimes.get(engine);
  if (!r) { r = { pending: new Map(), opening: new Set(), timers: new Map(), transcripts: new Map() }; runtimes.set(engine, r); }
  return r;
}

const pad = (n) => String(n).padStart(4, '0');
const uniq = (list) => [...new Set(list.filter(Boolean))];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

const emptyData = () => ({ seq: 0, tickets: {} });

function readData(engine, sid) {
  return { ...emptyData(), ...engine.store.get(ID, sid, emptyData()) };
}

function pruneClosed(d) {
  const closed = Object.values(d.tickets).filter((t) => t.status === 'closed' && !t.cleanup).sort((a, b) => a.number - b.number);
  for (const t of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_KEPT))) delete d.tickets[t.number];
}

function writeData(engine, sid, fn) {
  let out;
  engine.store.update(ID, sid, (d) => {
    const full = { ...emptyData(), ...d };
    out = fn(full);
    pruneClosed(full);
    return full;
  }, emptyData());
  return out;
}

const getTicket = (engine, sid, num) => readData(engine, sid).tickets[Number(num)] || null;

function patchTicket(engine, sid, num, patch) {
  return writeData(engine, sid, (d) => {
    const t = d.tickets[Number(num)];
    if (!t) return null;
    Object.assign(t, typeof patch === 'function' ? patch(t) : patch);
    return { ...t };
  });
}

function ticketInChannel(engine, sid, channelId) {
  const all = Object.values(readData(engine, sid).tickets).filter((t) => t.channelId === channelId);
  return all.find((t) => t.status === 'open') || all.find((t) => t.status === 'closing' || t.cleanup) || null;
}

const openTicketsOf = (engine, sid, uid) => Object.values(readData(engine, sid).tickets).filter((t) => t.openerId === uid && t.status === 'open');
const allOpen = (engine, sid) => Object.values(readData(engine, sid).tickets).filter((t) => t.status === 'open');

const cfgOf = (engine, sid) => engine.settings.appConfig(sid, ID);
const logChannelOf = (engine, sid) => cfgOf(engine, sid).logChannelId || engine.settings.core(sid).logChannel || null;
const clampLimit = (n) => Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(n)) || 1));

function typesOf(cfg) {
  const list = Array.isArray(cfg.types) && cfg.types.length ? cfg.types : DEFAULT_TYPES;
  return list.slice(0, MAX_TYPES).map((t, i) => ({
    id: String(t.id || `type${i + 1}`),
    name: clip(t.name || 'Support', 40),
    emoji: t.emoji || '🎫',
    questions: [].concat(t.questions || []).filter(Boolean).slice(0, MAX_QUESTIONS),
  }));
}

function typeById(cfg, typeId) {
  const types = typesOf(cfg);
  return types.find((t) => t.id === typeId) || null;
}

function typeLabel(cfg, typeId) {
  const t = typeById(cfg, typeId);
  return t ? `${t.emoji} ${t.name}` : '🎫 Ticket';
}

function channelSlug(text) {
  return String(text ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

function cleanChannelName(text) {
  return channelSlug(text).slice(0, 32).replace(/-+$/g, '');
}

function ticketChannelName(number, username) {
  const base = `ticket-${pad(number)}`;
  const who = channelSlug(username);
  return (who ? `${base}-${who}` : base).slice(0, 32).replace(/-+$/g, '');
}

function rememberPending(engine, key, data) {
  const { pending } = rt(engine);
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
  pending.set(key, { ...data, at: now });
}

function takePending(engine, key) {
  const { pending } = rt(engine);
  const p = pending.get(key);
  pending.delete(key);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}

async function staffRoleIds(engine, sid) {
  const cfg = cfgOf(engine, sid);
  if (cfg.staffRoles?.length) return uniq(cfg.staffRoles);
  const core = engine.settings.core(sid);
  const roles = await engine.perms.roles(sid).catch(() => []);
  const byPerm = roles.filter((r) => STAFF_PERMS.some((k) => r.perms?.[k])).map((r) => r.id);
  return uniq([...byPerm, ...(core.modRoles || []), ...(core.adminRoles || [])]);
}

async function isStaff(engine, sid, uid) {
  const level = await engine.perms.level(sid, uid);
  if (engine.perms.atLeast(level, 'admin')) return true;
  const cfg = cfgOf(engine, sid);
  if (cfg.staffRoles?.length) {
    const m = await engine.perms.member(sid, uid).catch(() => null);
    return (m?.roles || []).some((r) => cfg.staffRoles.includes(r));
  }
  return engine.perms.atLeast(level, 'mod');
}

async function isAdmin(engine, sid, uid) {
  return engine.perms.atLeast(await engine.perms.level(sid, uid), 'admin');
}

async function canManage(ctx, t) {
  return t.openerId === ctx.userId || isStaff(ctx.engine, ctx.serverId, ctx.userId);
}

async function botTopRoleId(engine, sid) {
  const botId = engine.bot.me?.id;
  const [m, roles] = await Promise.all([engine.perms.member(sid, botId).catch(() => null), engine.perms.roles(sid).catch(() => [])]);
  const mine = new Set(m?.roles || []);
  return roles.filter((r) => mine.has(r.id)).sort((a, b) => (b.position ?? 0) - (a.position ?? 0))[0]?.id || null;
}

async function usernameOf(engine, sid, uid, fallback) {
  const members = await engine.cache.members(sid).catch(() => []);
  const m = members.find((x) => x.id === uid);
  return m?.username || fallback || 'member';
}

function withStep(action, perm, fn) {
  return Promise.resolve().then(fn).catch((e) => {
    e.ticketStep = { action, perm };
    throw e;
  });
}

function ticketCard(engine, sid, t) {
  const cfg = cfgOf(engine, sid);
  const type = typeById(cfg, t.typeId);
  const head = type ? `${type.emoji} Ticket #${pad(t.number)}: ${type.name}` : `🎫 Ticket #${pad(t.number)}`;
  const body = t.mode === 'staff'
    ? `${ICONS.warn} <@${t.openerId}> opened this ticket but **can't see this channel**. Role management isn't switched on for me on this server yet, so I can't let them in.\nPlease contact them directly, for example in a DM or a public channel.`
    : 'Thanks for reaching out! Tell us what is going on and a staff member will be with you soon.\n-# Buttons below, or type `/ticket add @user`, `/ticket close reason`.';
  const fields = [
    { name: 'Opened by', value: `<@${t.openerId}>`, inline: true },
    { name: 'Claimed by', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody yet', inline: true },
  ];
  if (t.topic) fields.push({ name: 'Topic', value: clip(t.topic, 1000), inline: false });
  for (const a of t.answers || []) fields.push({ name: clip(a.q, 250), value: clip(a.a || '-', 1000), inline: false });
  return card({ title: head, body, fields, color: t.claimedBy ? 'ok' : 'tickets', footer: `Ticket #${pad(t.number)} · opened ${stamp(t.createdAt)} UTC` });
}

function cardComponents(t) {
  const btns = [];
  if (t.claimedBy) {
    btns.push(button('Claimed', cid('claimed', t.number), 'success', '🙋', { disabled: true }));
    btns.push(button('Unclaim', cid('unclaim', t.number), 'secondary', '↩️'));
  } else {
    btns.push(button('Claim', cid('claim', t.number), 'primary', '🙋'));
  }
  if (t.mode !== 'staff') btns.push(button('Add person', cid('addp', t.number), 'secondary', '➕'));
  btns.push(button('Close', cid('close', t.number), 'danger', ICONS.lock));
  return [row(btns)];
}

async function refreshCard(ctx, t) {
  const payload = { embeds: [ticketCard(ctx.engine, ctx.serverId, t)], components: cardComponents(t) };
  if (ctx.kind === 'button' && t.cardId && ctx.source.message_id === t.cardId) return ctx.update(payload);
  if (!t.cardId) return null;
  return ctx.engine.budget.edit({ channelId: t.channelId, messageId: t.cardId, opts: payload }).catch((e) => {
    ctx.engine.log.debug('ticket card edit failed', e?.message);
    return null;
  });
}

async function postLog(engine, sid, payload, priority = 'low') {
  const channelId = logChannelOf(engine, sid);
  if (!channelId) return null;
  const p = typeof payload === 'string' ? { content: payload } : payload;
  return engine.budget.send({ serverId: sid, channelId, content: p.content || '', opts: { embeds: p.embeds, files: p.files }, priority }).catch((e) => {
    engine.log.debug('ticket log failed', e?.message);
    return null;
  });
}

async function channelGone(engine, sid, channelId) {
  if (!channelId) return true;
  try {
    await engine.bot.api('GET', `/channels/${channelId}`);
    return false;
  } catch (e) {
    if (e?.status !== 404) return false;
  }
  try {
    const list = await engine.bot.channels(sid);
    return !(list || []).some((c) => c.id === channelId);
  } catch {
    return false;
  }
}

const HAND_DELETED = 'The ticket channel was deleted by hand';

async function liveOpenTickets(engine, sid, uid, { wait = true } = {}) {
  const mine = openTicketsOf(engine, sid, uid);
  const live = [];
  for (const t of mine) {
    if (!(await channelGone(engine, sid, t.channelId))) { live.push(t); continue; }
    const closing = closeTicket(engine, sid, t, { by: engine.bot.me?.id, reason: HAND_DELETED }).catch((e) => engine.log.warn(`[tickets] closing #${pad(t.number)} failed: ${e?.message}`));
    if (wait) await closing;
  }
  return live;
}

function limitText(live, limit) {
  const visible = live.filter((t) => t.mode !== 'staff');
  const where = visible.length ? `${visible.map((t) => `<#${t.channelId}>`).join(', ')}\n` : '';
  const staffNote = visible.length < live.length ? 'The staff are still handling your earlier ticket and will contact you. ' : '';
  return `${where}${staffNote}You can have ${plural(limit, 'open ticket')} at a time. Close one first, or keep talking to staff there.`;
}

async function limitBlock(ctx) {
  const limit = clampLimit(ctx.config().limit);
  const mine = openTicketsOf(ctx.engine, ctx.serverId, ctx.userId);
  if (mine.length < limit) return false;
  const live = await liveOpenTickets(ctx.engine, ctx.serverId, ctx.userId, { wait: false });
  if (live.length < limit) return false;
  await ctx.warn('You already have a ticket open', limitText(live, limit));
  return true;
}

async function startOpen(ctx, { typeId = null, topic = '' } = {}) {
  const cfg = ctx.config();
  const types = typesOf(cfg);
  const type = types.find((t) => t.id === typeId) || (types.length === 1 ? types[0] : null);
  if (!type) return showTypePicker(ctx, topic);
  if (await limitBlock(ctx)) return null;
  if (type.questions.length) {
    rememberPending(ctx.engine, `${ctx.serverId}:${ctx.userId}`, { typeId: type.id, topic });
    return ctx.form({
      title: `${type.name} ticket`,
      action: 'answers',
      fields: type.questions.map((q, i) => ({ id: `q${i}`, label: q, style: 'paragraph', required: true, max: 1000 })),
    });
  }
  return openTicket(ctx, { type, topic, answers: [] });
}

async function showTypePicker(ctx, topic) {
  const { engine } = ctx;
  const types = typesOf(ctx.config());
  const sess = topic ? engine.router.session({ topic, userId: ctx.userId }) : '-';
  const lines = types.map((t) => `${t.emoji} **${t.name}**${t.questions.length ? ` · ${plural(t.questions.length, 'quick question')}` : ''}`);
  const embeds = [card({ title: `${ICONS.tickets} What do you need help with?`, body: `${lines.join('\n')}\n\nPick one to open a private ticket with the staff.`, color: 'tickets' })];
  const options = types.map((t) => ({ label: t.name, value: t.id, emoji: t.emoji }));
  const asSelect = () => ctx.ephemeral({ embeds, components: [select(cid('pick', sess), options, { placeholder: 'Pick a ticket type' })] });
  const asButtons = () => ctx.ephemeral({ embeds, components: rows(types.map((t) => button(t.name, cid('open', t.id, sess), 'primary', t.emoji))) });
  return engine.caps.attempt(ctx.serverId, 'selects', asSelect, asButtons);
}

function topicFromSession(ctx, sess) {
  if (!sess || sess === '-') return '';
  const s = ctx.engine.router.getSession(sess);
  return s && s.userId === ctx.userId ? s.topic || '' : '';
}

async function openTicket(ctx, { type, topic = '', answers = [] }) {
  const { engine, bot, serverId: sid, userId: uid } = ctx;
  const key = `${sid}:${uid}`;
  const { opening } = rt(engine);
  if (opening.has(key)) return ctx.info('Already on it', 'Your ticket is being opened right now.');
  opening.add(key);
  try {
    if (!ctx.answered) await ctx.ephemeral({ embeds: [card({ title: `${ICONS.tickets} Opening your ticket…`, body: 'This takes a few seconds.', color: 'tickets' })] });
    const cfg = ctx.config();
    const limit = clampLimit(cfg.limit);
    const live = await liveOpenTickets(engine, sid, uid);
    if (live.length >= limit) return ctx.warn('You already have a ticket open', limitText(live, limit));
    return await buildTicket(ctx, { type, topic, answers, cfg });
  } catch (e) {
    return ctx.fail(e, e.ticketStep || { action: 'open your ticket' });
  } finally {
    opening.delete(key);
  }
}

async function cleanupMade(engine, sid, made) {
  if (made.channelId) await engine.bot.deleteChannel(made.channelId).catch((e) => engine.log.warn(`[tickets] could not remove half-made channel: ${e?.message}`));
  if (made.roleId && made.givenTo) await engine.bot.removeRole(sid, made.givenTo, made.roleId).catch(() => null);
  if (made.roleId) await engine.bot.deleteRole(sid, made.roleId).catch((e) => engine.log.warn(`[tickets] could not remove half-made role: ${e?.message}`));
  engine.cache.invalidate(sid);
}

async function makeSpace(ctx, { number, cfg }) {
  const { engine, bot, serverId: sid, userId: uid } = ctx;
  const made = { roleId: null, channelId: null, mode: 'role', rolesError: null };
  try {
    if (engine.caps.state(sid, 'roles') === false) made.mode = 'staff';
    else {
      try {
        const role = await bot.createRole(sid, { name: `ticket-${pad(number)}`, mentionable: false, permissions: {} });
        made.roleId = role.id;
        engine.caps.mark(sid, 'roles', true);
      } catch (e) {
        if (!looksLikeFeatureOff(e)) { e.ticketStep = { action: 'make the ticket role', perm: 'manage_roles' }; throw e; }
        engine.caps.mark(sid, 'roles', false, e?.message);
        made.mode = 'staff';
      }
      if (made.roleId) {
        await withStep('give you the ticket role', 'manage_roles', () => bot.addRole(sid, uid, made.roleId));
        made.givenTo = uid;
      }
    }
    const name = ticketChannelName(number, await usernameOf(engine, sid, uid, ctx.username));
    const ch = await withStep('make the ticket channel', 'manage_channels', () => bot.createChannel(sid, name, { kind: 'text', categoryId: cfg.categoryId || undefined }));
    made.channelId = ch.id;
    made.name = ch.name || name;
    const [staff, botRole] = await Promise.all([staffRoleIds(engine, sid), botTopRoleId(engine, sid)]);
    made.roleIds = uniq([made.roleId, ...staff, botRole]);
    await withStep('make the ticket channel private', 'manage_channels', () => bot.editChannel(ch.id, { private: true, roleIds: made.roleIds }));
    engine.cache.invalidate(sid);
    return made;
  } catch (e) {
    await cleanupMade(engine, sid, made);
    e.cleanedUp = true;
    throw e;
  }
}

async function buildTicket(ctx, { type, topic, answers, cfg }) {
  const { engine, serverId: sid, userId: uid } = ctx;
  const number = writeData(engine, sid, (d) => { d.seq += 1; return d.seq; });
  const startedAt = Date.now();
  let made;
  try {
    made = await makeSpace(ctx, { number, cfg });
  } catch (e) {
    const { title, body } = explain(e, e.ticketStep || { action: 'open your ticket' });
    if (!e.friendly) engine.log.warn(`[tickets] opening ticket #${pad(number)} failed: ${e?.message}`);
    return ctx.error(title, `${body}\n\nI removed anything I had already made, so nothing is left over. Try again, or ask a staff member.`);
  }
  const now = Date.now();
  const t = {
    id: `${sid}:${number}`, number, channelId: made.channelId, roleId: made.roleId, openerId: uid, typeId: type.id,
    claimedBy: null, status: 'open', createdAt: now, closedAt: null, closedBy: null, reason: null,
    answers, topic: clip(topic, 1000), members: [], mode: made.mode, name: made.name, cardId: null, anchorAt: new Date(startedAt - 1000).toISOString(),
  };
  writeData(engine, sid, (d) => { d.tickets[number] = t; });

  const staffPing = cfg.pingStaff && cfg.staffRoles?.length ? ` ${cfg.staffRoles.map((r) => `<@&${r}>`).join(' ')}` : '';
  const sent = await ctx.send(t.channelId, { content: `<@${uid}>${staffPing}`, embeds: [ticketCard(engine, sid, t)], components: cardComponents(t) }, { priority: 'high' }).catch((e) => {
    engine.log.warn(`[tickets] welcome card failed in ticket #${pad(number)}: ${e?.message}`);
    return null;
  });
  if (sent?.id) {
    const cardAt = Date.parse(sent.created_at) - 1000;
    const anchor = Number.isFinite(cardAt) ? new Date(Math.min(cardAt, Date.parse(t.anchorAt))).toISOString() : t.anchorAt;
    patchTicket(engine, sid, number, { cardId: sent.id, anchorAt: anchor });
  }

  const what = `${type.emoji} ${type.name}${t.topic ? `: ${clip(t.topic, 200)}` : ''}`;
  if (made.mode === 'staff') {
    await postLog(engine, sid, { embeds: [card({ title: `${ICONS.tickets} Ticket #${pad(number)} needs a staff member`, body: `<@${uid}> opened a ticket (${what}) but can't see <#${t.channelId}>, because role management isn't switched on for me on this server yet.\nPlease contact them directly.`, color: 'warn' })] }, 'normal');
    return ctx.warn('Staff will contact you', `Private tickets need role management on this server, which isn't switched on for me yet, so I can't open a channel only you and the staff can see.\nI told the staff about your ticket${t.topic ? ' and your topic' : ''}, and someone will contact you soon.`);
  }
  postLog(engine, sid, { embeds: [card({ title: `${ICONS.tickets} Ticket #${pad(number)} opened`, body: `<@${uid}> opened <#${t.channelId}> (${what}).`, color: 'tickets' })] });
  return ctx.ok('Your ticket is open', `Head over to <#${t.channelId}>. Only you and the staff can see it.${sent ? '' : '\n-# I could not post the welcome message there, but the channel is ready.'}`);
}

function formatMessageLine(m, botId) {
  const who = m.author?.display_name || m.author?.username || (m.author_id === botId ? 'YapOS' : 'unknown');
  const bits = [];
  if (m.content) bits.push(String(m.content).replace(/\n/g, '\n    '));
  const files = [];
  if (m.attachment_name) files.push(m.attachment_name);
  if (m.attachment?.name) files.push(m.attachment.name);
  if (typeof m.attachment === 'string') files.push(m.attachment.split('/').pop());
  if (m.attachment_path && !files.length) files.push(String(m.attachment_path).split('/').pop());
  for (const f of [].concat(m.attachments || [], m.files || [])) if (f?.name) files.push(f.name);
  for (const f of uniq(files)) bits.push(`[file: ${f}]`);
  for (const e of m.embeds || []) if (e?.title) bits.push(`[card: ${e.title}]`);
  return `[${stamp(m.created_at)}] ${who}: ${bits.join(' ') || '(no text)'}`;
}

async function readHistory(engine, t) {
  const { bot } = engine;
  const out = [];
  const seen = new Set();
  const push = (list) => {
    let added = 0;
    for (const m of list || []) if (m?.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); added++; }
    return added;
  };
  try {
    let after = t.anchorAt || new Date(t.createdAt - 1000).toISOString();
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await bot.messagesAfter(t.channelId, after, 100);
      const added = push(batch);
      if (!batch?.length || batch.length < 100 || !added) break;
      after = batch[batch.length - 1].created_at;
    }
  } catch (e) {
    engine.log.debug('messagesAfter failed, using recent messages', e?.message);
  }
  if (!out.length) push(await bot.messages(t.channelId, 100));
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function buildTranscript(engine, sid, t, { closedBy, reason } = {}) {
  const cfg = cfgOf(engine, sid);
  const msgs = await readHistory(engine, t);
  const head = [
    `Ticket #${pad(t.number)} (${typeById(cfg, t.typeId)?.name || 'Ticket'})`,
    `Opened by ${await usernameOf(engine, sid, t.openerId, t.openerId)} on ${stamp(t.createdAt)} UTC`,
  ];
  if (t.claimedBy) head.push(`Claimed by ${await usernameOf(engine, sid, t.claimedBy, t.claimedBy)}`);
  if (closedBy) head.push(`Closed by ${await usernameOf(engine, sid, closedBy, closedBy)} on ${stamp(Date.now())} UTC${reason ? `. Reason: ${reason}` : ''}`);
  if (t.topic) head.push(`Topic: ${t.topic}`);
  for (const a of t.answers || []) head.push(`${a.q} ${a.a}`);
  head.push('-'.repeat(40));
  const lines = msgs.map((m) => formatMessageLine(m, engine.bot.me?.id));
  return { text: `${[...head, ...lines].join('\n')}\n`, count: msgs.length };
}

function chunkText(text, size = CHUNK_SIZE) {
  const safe = String(text).replace(/```/g, "'''");
  const chunks = [];
  let cur = '';
  for (const rawLine of safe.split('\n')) {
    let line = rawLine;
    while (line.length > size) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(line.slice(0, size));
      line = line.slice(size);
    }
    if (cur.length + line.length + 1 > size) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

const transcriptName = (t) => `ticket-${pad(t.number)}-transcript.txt`;

async function sendTranscript(engine, sid, channelId, t, transcript, { embed, maxChunks = MAX_CHUNKS, priority = 'normal', serverId = sid } = {}) {
  const file = { name: transcriptName(t), data: Buffer.from(transcript.text, 'utf8') };
  const asFile = () => engine.budget.send({ serverId, channelId, content: '', opts: { embeds: embed ? [embed] : undefined, files: [file] }, priority }).then(() => 'file');
  const asText = async () => {
    if (embed) await engine.budget.send({ serverId, channelId, content: '', opts: { embeds: [embed] }, priority });
    const chunks = chunkText(transcript.text);
    for (const c of chunks.slice(0, maxChunks)) {
      await engine.budget.send({ serverId, channelId, content: `\`\`\`\n${c}\n\`\`\``, priority });
    }
    if (chunks.length > maxChunks) await engine.budget.send({ serverId, channelId, content: `…truncated (${chunks.length - maxChunks} more part${chunks.length - maxChunks === 1 ? '' : 's'} not shown).`, priority });
    return 'text';
  };
  return engine.caps.attempt(sid, 'files', asFile, asText);
}

async function dmTranscript(engine, sid, t, transcript) {
  const server = await engine.perms.server(sid).catch(() => null);
  const text = `${ICONS.tickets} Your ticket #${pad(t.number)}${server?.name ? ` on **${server.name}**` : ''} was closed. Here is a copy of the conversation.`;
  try {
    return await engine.caps.attempt(sid, 'dms', async () => {
      const dmChannel = await engine.bot.dm(t.openerId);
      await engine.budget.send({ serverId: null, channelId: dmChannel, content: text, priority: 'normal' });
      await sendTranscript(engine, sid, dmChannel, t, transcript, { maxChunks: PREVIEW_CHUNKS, serverId: null });
      return true;
    }, () => false);
  } catch (e) {
    engine.log.debug('ticket DM failed', e?.message);
    return false;
  }
}

function closeSummary(t, { by, reason, count, notes }) {
  const fields = [
    { name: 'Opened by', value: `<@${t.openerId}>`, inline: true },
    { name: 'Closed by', value: by ? `<@${by}>` : 'YapOS', inline: true },
    { name: 'Claimed by', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody', inline: true },
    { name: 'Open for', value: formatDuration(Math.max(1000, Date.now() - t.createdAt)), inline: true },
    { name: 'Messages', value: count === null ? 'No transcript' : String(count), inline: true },
    { name: 'Reason', value: reason || 'No reason given', inline: false },
  ];
  if (notes.length) fields.push({ name: 'Notes', value: notes.join('\n'), inline: false });
  return card({ title: `${ICONS.lock} Ticket #${pad(t.number)} closed`, fields, color: 'tickets' });
}

async function closeTicket(engine, sid, t, { by = null, reason = '' } = {}) {
  const fresh = getTicket(engine, sid, t.number);
  if (!fresh || fresh.status !== 'open') return { already: true };
  patchTicket(engine, sid, t.number, { status: 'closing' });
  const channel = !(await channelGone(engine, sid, t.channelId));
  const notes = [];
  let transcript = null;
  if (channel) {
    try {
      transcript = await buildTranscript(engine, sid, fresh, { closedBy: by, reason });
    } catch (e) {
      engine.log.warn(`[tickets] transcript for #${pad(t.number)} failed: ${e?.message}`);
      notes.push("I couldn't read the channel history, so there is no transcript.");
    }
  } else {
    notes.push('The ticket channel was already deleted, so there is no transcript.');
  }
  const closed = patchTicket(engine, sid, t.number, {
    status: 'closed', closedAt: Date.now(), closedBy: by, reason: clip(reason || '', 500) || null,
    cleanup: { channel: !!channel, role: !!fresh.roleId },
  });
  if (transcript) {
    const dmOk = await dmTranscript(engine, sid, closed, transcript);
    notes.push(dmOk ? `Sent a copy to <@${t.openerId}> in DMs.` : `Couldn't DM a copy to <@${t.openerId}> (DMs are off or closed).`);
  }
  const logCh = logChannelOf(engine, sid);
  const summary = closeSummary(closed, { by, reason, count: transcript ? transcript.count : null, notes });
  let logged = false;
  if (logCh) {
    try {
      if (transcript) await sendTranscript(engine, sid, logCh, closed, transcript, { embed: summary });
      else await engine.budget.send({ serverId: sid, channelId: logCh, content: '', opts: { embeds: [summary] }, priority: 'normal' });
      logged = true;
    } catch (e) {
      engine.log.warn(`[tickets] could not post the transcript of #${pad(t.number)}: ${e?.message}`);
    }
  }
  if (channel) {
    const where = logged ? 'The transcript is saved in the log channel.' : logCh ? "I couldn't post the transcript to the log channel." : 'No log channel is set, so the transcript was not saved. An admin can pick one with `/tickets log #channel`.';
    await engine.budget.send({
      serverId: sid, channelId: t.channelId, priority: 'high', content: '',
      opts: { embeds: [card({ title: `${ICONS.lock} Ticket closed`, body: `Closed by ${by ? `<@${by}>` : 'YapOS'}${reason ? `: ${clip(reason, 300)}` : '.'}\n${where}\nThis channel will be deleted in 10 seconds.`, color: 'tickets' })] },
    }).catch((e) => engine.log.debug('closing note failed', e?.message));
    scheduleCleanup(engine, sid, t.number, CLOSE_DELAY_MS);
  } else {
    await finishCleanup(engine, sid, t.number);
  }
  return { closed, logged, transcript: !!transcript };
}

function scheduleCleanup(engine, sid, num, delay) {
  const { timers } = rt(engine);
  const k = `${sid}:${num}`;
  clearTimeout(timers.get(k));
  const timer = setTimeout(() => {
    timers.delete(k);
    finishCleanup(engine, sid, num).catch((e) => engine.log.warn(`[tickets] cleanup of #${pad(num)} failed: ${e?.message}`));
  }, delay);
  timer.unref?.();
  timers.set(k, timer);
}

async function finishCleanup(engine, sid, num) {
  const t = getTicket(engine, sid, num);
  if (!t?.cleanup) return;
  const problems = [];
  if (t.cleanup.channel) {
    try { await engine.bot.deleteChannel(t.channelId); } catch (e) { if (e?.status !== 404) problems.push(`I couldn't delete the channel <#${t.channelId}>. Please delete it by hand.`); }
  }
  if (t.cleanup.role && t.roleId) {
    try { await engine.bot.deleteRole(sid, t.roleId); } catch (e) { if (e?.status !== 404) problems.push(`I couldn't delete the role **ticket-${pad(num)}**. Please delete it by hand.`); }
  }
  patchTicket(engine, sid, num, { cleanup: null });
  engine.cache.invalidate(sid);
  if (problems.length) await postLog(engine, sid, { embeds: [dialog.warn(`Ticket #${pad(num)} cleanup`, problems.join('\n'))] }, 'normal');
}

function confirmRows(sess) {
  return [row(button('Close ticket', cid('closeyes', sess), 'danger', ICONS.lock), button('Keep it open', cid('closeno', sess), 'secondary'))];
}

async function askClose(ctx, t, reason) {
  if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can close it.');
  const sess = ctx.engine.router.session({ num: t.number, reason: clip(reason || '', 500), sid: ctx.serverId });
  const body = `${reason ? `**Reason:** ${clip(reason, 300)}\n` : ''}I'll save a transcript, then delete the channel. This can't be undone.`;
  return ctx.ephemeral({ embeds: [card({ title: `${ICONS.lock} Close ticket #${pad(t.number)}?`, body, color: 'warn' })], components: confirmRows(sess) });
}

async function confirmClose(ctx) {
  const sess = ctx.argv[0];
  const s = ctx.engine.router.getSession(sess);
  if (!s || s.sid !== ctx.serverId) return ctx.warn('This button expired', 'Run `/ticket close` again.');
  const t = getTicket(ctx.engine, ctx.serverId, s.num);
  if (!t || t.status !== 'open') return ctx.info('Already closed', 'This ticket is already closed.');
  if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can close it.');
  ctx.engine.router.dropSession(sess);
  await ctx.update({ embeds: [card({ title: `${ICONS.lock} Closing ticket #${pad(t.number)}…`, body: 'Saving the transcript.', color: 'tickets' })], components: freeze(confirmRows(sess), ctx.source.custom_id) });
  const out = await closeTicket(ctx.engine, ctx.serverId, t, { by: ctx.userId, reason: s.reason });
  if (ctx.channelId !== t.channelId && !out.already) {
    return ctx.ok(`Ticket #${pad(t.number)} closed`, out.transcript ? 'The transcript went to the log channel.' : 'There was no channel left, so I cleaned up the role and marked it closed.');
  }
  return null;
}

async function claimTicket(ctx, t) {
  if (!(await isStaff(ctx.engine, ctx.serverId, ctx.userId))) return ctx.warn('Staff only', 'Only staff can claim tickets. A staff member will be with you soon.');
  let outcome = 'won';
  const updated = patchTicket(ctx.engine, ctx.serverId, t.number, (x) => {
    if (x.status !== 'open') { outcome = 'closed'; return {}; }
    if (x.claimedBy) { outcome = x.claimedBy === ctx.userId ? 'mine' : 'taken'; return {}; }
    return { claimedBy: ctx.userId };
  });
  if (!updated || outcome === 'closed') return ctx.info('This ticket is closed', 'Open a new one with `/ticket` if you still need help.');
  if (outcome === 'mine') return ctx.info('Already yours', 'You have already claimed this ticket.');
  if (outcome === 'taken') return ctx.warn('Already claimed', `<@${updated.claimedBy}> is already handling this ticket.`);
  const note = `🙋 <@${ctx.userId}> claimed this ticket and will help you.`;
  if (ctx.kind === 'button' && ctx.source.message_id === updated.cardId) {
    await refreshCard(ctx, updated);
    return ctx.send(updated.channelId, note, { priority: 'normal' }).catch(() => null);
  }
  refreshCard(ctx, updated);
  return ctx.reply(note);
}

async function unclaimTicket(ctx, stale) {
  const t = getTicket(ctx.engine, ctx.serverId, stale.number) || stale;
  if (!t.claimedBy) return ctx.info('Not claimed', 'Nobody has claimed this ticket yet.');
  if (t.claimedBy !== ctx.userId && !(await isAdmin(ctx.engine, ctx.serverId, ctx.userId))) {
    return ctx.warn('Not allowed', 'Only the person who claimed this ticket, or an admin, can unclaim it.');
  }
  const updated = patchTicket(ctx.engine, ctx.serverId, t.number, { claimedBy: null });
  const note = `↩️ <@${ctx.userId}> unclaimed this ticket. Another staff member can pick it up.`;
  if (ctx.kind === 'button' && ctx.source.message_id === updated.cardId) {
    await refreshCard(ctx, updated);
    return ctx.send(updated.channelId, note, { priority: 'normal' }).catch(() => null);
  }
  refreshCard(ctx, updated);
  return ctx.reply(note);
}

function noRolesHere() {
  return ['Can\'t add people here', "Role management isn't switched on for me on this server, so I can't let more people into this ticket. Staff can talk to them directly."];
}

async function addPerson(ctx, t, token) {
  if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can add people.');
  if (t.mode === 'staff' || !t.roleId) return ctx.warn(...noRolesHere());
  if (!token) return ctx.warn('Who should I add?', 'Try `/ticket add @sam`.');
  const user = await ctx.findUser(token);
  if (!user) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(token, 40)}**. Mention them, like @sam.`);
  if (user.id === ctx.bot.me?.id) return ctx.info('Already here', 'I can already see this ticket.');
  if (user.id === t.openerId || (t.members || []).includes(user.id)) return ctx.info('Already in', `<@${user.id}> can already see this ticket.`);
  try {
    await ctx.bot.addRole(ctx.serverId, user.id, t.roleId);
  } catch (e) {
    return ctx.fail(e, { action: 'add them to the ticket', perm: 'manage_roles' });
  }
  patchTicket(ctx.engine, ctx.serverId, t.number, (x) => ({ members: uniq([...(x.members || []), user.id]) }));
  return ctx.reply({ content: `<@${user.id}>`, embeds: [dialog.ok('Added to the ticket', `<@${user.id}> can now see this ticket. Added by <@${ctx.userId}>.`, { color: 'tickets' })] });
}

async function removePerson(ctx, t, token) {
  if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can remove people.');
  if (t.mode === 'staff' || !t.roleId) return ctx.warn(...noRolesHere());
  if (!token) return ctx.warn('Who should I remove?', 'Try `/ticket remove @sam`.');
  const user = await ctx.findUser(token);
  if (!user) return ctx.warn("I couldn't find them", `Nobody here matches **${clip(token, 40)}**.`);
  if (user.id === t.openerId) return ctx.warn("Can't remove them", 'They opened this ticket. Close the ticket instead.');
  if (!(t.members || []).includes(user.id)) return ctx.info('Not in this ticket', `<@${user.id}> wasn't added to this ticket. Staff see every ticket through their role.`);
  try {
    await ctx.bot.removeRole(ctx.serverId, user.id, t.roleId);
  } catch (e) {
    return ctx.fail(e, { action: 'remove them from the ticket', perm: 'manage_roles' });
  }
  patchTicket(ctx.engine, ctx.serverId, t.number, (x) => ({ members: (x.members || []).filter((m) => m !== user.id) }));
  return ctx.reply({ embeds: [dialog.ok('Removed from the ticket', `<@${user.id}> can't see this ticket anymore. Removed by <@${ctx.userId}>.`, { color: 'tickets' })], components: [row(button('Undo: add them back', cid('readd', t.number, user.id), 'secondary', ICONS.undo))] });
}

async function renameTicket(ctx, t, text) {
  if (!(await isStaff(ctx.engine, ctx.serverId, ctx.userId))) return ctx.warn('Staff only', 'Only staff can rename tickets.');
  const name = cleanChannelName(text);
  if (!name) return ctx.warn('What should it be called?', 'Try `/ticket rename billing-question`. Letters, numbers and dashes, up to 32.');
  const before = t.name || (await ctx.bot.channel(t.channelId))?.name || `ticket-${pad(t.number)}`;
  try {
    await ctx.bot.editChannel(t.channelId, { name });
  } catch (e) {
    return ctx.fail(e, { action: 'rename this channel', perm: 'manage_channels' });
  }
  patchTicket(ctx.engine, ctx.serverId, t.number, { name });
  ctx.engine.cache.invalidate(ctx.serverId);
  const undo = cleanChannelName(before) ? [row(button(`Undo: back to ${clip(before, 40)}`, cid('unrename', t.number, cleanChannelName(before)), 'secondary', ICONS.undo))] : [];
  return ctx.reply({ embeds: [dialog.ok('Ticket renamed', `This channel is now **#${name}**.`, { color: 'tickets' })], components: undo });
}

async function postTranscriptHere(ctx, t) {
  if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can get the transcript.');
  const { transcripts } = rt(ctx.engine);
  const now = Date.now();
  for (const [k, at] of transcripts) if (now - at >= TRANSCRIPT_COOLDOWN_MS) transcripts.delete(k);
  const tkey = `${ctx.serverId}:${t.number}`;
  if (transcripts.has(tkey)) {
    const wait = Math.ceil((TRANSCRIPT_COOLDOWN_MS - (now - transcripts.get(tkey))) / 1000);
    return ctx.info('Just made one', `A transcript was posted here a moment ago. Try again in ${plural(wait, 'second')}.`);
  }
  transcripts.set(tkey, now);
  await ctx.ephemeral({ embeds: [card({ title: '📄 Making the transcript…', body: 'It will show up in this channel.', color: 'tickets' })] });
  try {
    const transcript = await buildTranscript(ctx.engine, ctx.serverId, t);
    const how = await sendTranscript(ctx.engine, ctx.serverId, t.channelId, t, transcript, { maxChunks: PREVIEW_CHUNKS, priority: 'normal' });
    if (how === 'text') await ctx.send(t.channelId, '-# Sending files is not switched on for me here, so this is the text version. The full transcript goes to the log channel when the ticket closes.', { priority: 'low' });
    return null;
  } catch (e) {
    return ctx.fail(e, { action: 'make the transcript', perm: 'read_history' });
  }
}

function ticketHelp(t) {
  const lines = [
    `This is ticket **#${pad(t.number)}**, opened by <@${t.openerId}>.`,
    '`/ticket close [reason]` closes it and saves a transcript.',
    '`/ticket claim` (staff) marks you as the helper.',
    '`/ticket add @user` and `/ticket remove @user` let people in or out.',
    '`/ticket rename name` (staff) renames the channel.',
    '`/ticket transcript` posts the conversation so far.',
  ];
  return { embeds: [card({ title: `${ICONS.tickets} Ticket #${pad(t.number)}`, body: lines.join('\n'), color: 'tickets' })] };
}

const notTicket = (ctx) => ctx.warn("This isn't a ticket channel", 'Run this inside a ticket channel. To open a new ticket, use `/ticket open your topic`.');

async function closeByNumber(ctx, numText, reason) {
  if (!(await isStaff(ctx.engine, ctx.serverId, ctx.userId))) return notTicket(ctx);
  const t = getTicket(ctx.engine, ctx.serverId, Number(String(numText).replace(/^#/, '')));
  if (!t) return ctx.warn('No such ticket', `I couldn't find ticket **#${clip(numText, 10)}**.`);
  if (t.status !== 'open') return ctx.info('Already closed', `Ticket #${pad(t.number)} is already closed.`);
  return askClose(ctx, t, reason);
}

function pickType(cfg, tokens) {
  const types = typesOf(cfg);
  if (types.length < 2 || !tokens.length) return { typeId: null, rest: tokens };
  const word = normalizeName(tokens[0]);
  const hit = types.find((t) => t.id === word || normalizeName(t.name) === word || normalizeName(t.name).split('-')[0] === word);
  return hit ? { typeId: hit.id, rest: tokens.slice(1) } : { typeId: null, rest: tokens };
}

async function runTicket(ctx, tokensIn) {
  const tokens = tokensIn ?? (ctx.argv.length ? ctx.argv : tokenize(ctx.args));
  const first = String(tokens[0] || '').toLowerCase();
  const sub = SUBS[first];
  const here = ticketInChannel(ctx.engine, ctx.serverId, ctx.channelId);
  try {
    if (!sub) {
      if (!first && here) return await ctx.ephemeral(ticketHelp(here));
      const { typeId, rest } = pickType(ctx.config(), tokens);
      return await startOpen(ctx, { typeId, topic: rest.join(' ') });
    }
    if (sub === 'open') {
      const { typeId, rest } = pickType(ctx.config(), tokens.slice(1));
      return await startOpen(ctx, { typeId, topic: rest.join(' ') });
    }
    const rest = tokens.slice(1);
    if (sub === 'close' && (!here || here.status !== 'open') && /^#?\d{1,6}$/.test(rest[0] || '')) return await closeByNumber(ctx, rest[0], rest.slice(1).join(' '));
    if (!here) return await notTicket(ctx);
    if (here.status !== 'open') return await ctx.info('This ticket is closed', 'The channel will be deleted in a few seconds.');
    if (sub === 'close') return await askClose(ctx, here, rest.join(' '));
    if (sub === 'claim') return await claimTicket(ctx, here);
    if (sub === 'unclaim') return await unclaimTicket(ctx, here);
    if (sub === 'add') return await addPerson(ctx, here, rest[0]);
    if (sub === 'remove') return await removePerson(ctx, here, rest[0]);
    if (sub === 'rename') return await renameTicket(ctx, here, rest.join('-'));
    if (sub === 'transcript') return await postTranscriptHere(ctx, here);
    return null;
  } catch (e) {
    return ctx.fail(e);
  }
}

function capLine(engine, sid, cap) {
  const s = engine.caps.state(sid, cap);
  const icon = s === true ? '🟢' : s === false ? '🔴' : '⚪';
  const word = s === true ? 'works' : s === false ? 'off on this server' : 'not tried yet';
  return `${icon} ${CAP_LABELS[cap]}: ${word}`;
}

function formatTypeLine(t) {
  return `${t.emoji} ${t.name}${t.questions.length ? `: ${t.questions.join('; ')}` : ''}`;
}

const EMOJI_RE = /^(\p{Extended_Pictographic}(?:️|⃣|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*)\s*/u;

function parseTypeLine(line) {
  let text = String(line || '').trim();
  if (!text) return null;
  let emoji = '🎫';
  const m = EMOJI_RE.exec(text);
  if (m) { emoji = m[1]; text = text.slice(m[0].length); }
  const idx = text.indexOf(':');
  const name = clip((idx >= 0 ? text.slice(0, idx) : text).trim(), 40);
  if (!name) return null;
  const questions = idx >= 0 ? text.slice(idx + 1).split(';').map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUESTIONS).map((q) => clip(q, 45)) : [];
  return { name, emoji, questions };
}

function parseTypes(lines) {
  const out = [];
  const used = new Set();
  for (const line of lines) {
    const t = parseTypeLine(line);
    if (!t) continue;
    let id = normalizeName(t.name).slice(0, 20) || `type${out.length + 1}`;
    let n = 2;
    while (used.has(id)) id = `${normalizeName(t.name).slice(0, 17) || 'type'}-${n++}`;
    used.add(id);
    out.push({ id, ...t });
    if (out.length >= MAX_TYPES) break;
  }
  return out;
}

async function setupView(ctx) {
  const { engine, serverId: sid } = ctx;
  const cfg = ctx.config();
  const types = typesOf(cfg);
  const open = allOpen(engine, sid).length;
  const logCh = logChannelOf(engine, sid);
  const botPerms = await engine.perms.botCan(sid, 'manage_channels', 'manage_roles').catch(() => ({ ok: true, missing: [] }));
  const warnings = [];
  if (engine.caps.state(sid, 'roles') === false) warnings.push(`${ICONS.warn} **Role management is off for me on this server.** New tickets are staff-only: members can't see their own ticket, and staff are told to contact them. Private tickets work once Yapin' switches role management on for this bot.`);
  if (!botPerms.ok) warnings.push(`${ICONS.warn} My role is missing **${botPerms.missing.map((p) => (p === 'manage_roles' ? 'Manage Roles' : 'Manage Channels')).join('** and **')}**. Tickets need both.`);
  if (!logCh) warnings.push(`${ICONS.warn} No log channel yet, so closed tickets have nowhere to save their transcript.`);
  const fields = [
    { name: 'Open-ticket panel', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'Not posted yet', inline: true },
    { name: 'Category', value: cfg.categoryId ? cfg.categoryName || 'Set' : 'None (top of the list)', inline: true },
    { name: 'Log channel', value: logCh ? `<#${logCh}>${cfg.logChannelId ? '' : ' (server log)'}` : 'Not set', inline: true },
    { name: 'Staff', value: cfg.staffRoles?.length ? cfg.staffRoles.map((r) => `<@&${r}>`).join(' ') : 'Anyone who is a mod or admin', inline: true },
    { name: 'Tickets per person', value: String(clampLimit(cfg.limit)), inline: true },
    { name: 'Ping staff on new tickets', value: cfg.pingStaff ? '🟢 On' : '⚪ Off', inline: true },
    { name: `Types (${types.length}/${MAX_TYPES})`, value: types.map(formatTypeLine).join('\n'), inline: false },
    { name: 'Open tickets', value: String(open), inline: true },
    { name: 'Features on this server', value: CAP_CHECKS.map((c) => capLine(engine, sid, c)).join('\n'), inline: false },
  ];
  const body = `${warnings.length ? `${warnings.join('\n')}\n\n` : ''}Members open a private channel with the staff. Each ticket gets its own role, so only the member, people they add, and staff can see it.\n-# Typed: \`/tickets panel #channel\`, \`/tickets staff @role\`, \`/tickets log #channel\`, \`/tickets limit 1\`, \`/tickets category name\`.`;
  return {
    embeds: [card({ title: `${ICONS.tickets} Ticket setup`, body, fields, color: 'tickets' })],
    components: [
      row(
        button('Post panel', cid('postpanel'), 'primary', '📌'),
        button('Edit types', cid('types'), 'secondary', '🗂️'),
        button('Staff roles', cid('edit', 'staff'), 'secondary', ICONS.mod),
        button('Log channel', cid('edit', 'log'), 'secondary', '📜'),
        button('Category', cid('edit', 'category'), 'secondary', '📁'),
      ),
      row(
        button('Limit', cid('edit', 'limit'), 'secondary', '🔢'),
        button(cfg.pingStaff ? 'Stop pinging staff' : 'Ping staff', cid('ping'), 'secondary', '🔔'),
        button('Tidy up', cid('tidy'), 'secondary', '🧹'),
        button('Refresh', cid('home'), 'secondary', '🔄'),
      ),
    ],
  };
}

function panelMessage(cfg) {
  const types = typesOf(cfg);
  const lines = types.map((t) => `${t.emoji} **${t.name}**`);
  return {
    embeds: [card({ title: `${ICONS.tickets} Need help?`, body: `Press a button to open a private ticket. Only you and the staff will see it.\n\n${lines.join('\n')}`, color: 'tickets' })],
    components: rows(types.map((t) => button(types.length === 1 ? 'Open a ticket' : t.name, cid('open', t.id), 'primary', t.emoji))),
  };
}

async function refreshPostedPanel(engine, sid) {
  const cfg = cfgOf(engine, sid);
  if (!cfg.panelChannelId || !cfg.panelMessageId) return;
  const p = panelMessage(cfg);
  await engine.budget.edit({ channelId: cfg.panelChannelId, messageId: cfg.panelMessageId, opts: { embeds: p.embeds, components: p.components } }).catch((e) => engine.log.debug('panel refresh failed', e?.message));
}

async function postPanel(ctx, channel) {
  const cfg = ctx.config();
  let sent;
  try {
    sent = await ctx.send(channel.id, panelMessage(cfg), { priority: 'high' });
  } catch (e) {
    return ctx.fail(e, { action: `post in #${channel.name}`, perm: 'send_messages' });
  }
  ctx.patchConfig({ panelChannelId: channel.id, panelMessageId: sent?.id || null });
  const extra = ctx.engine.caps.state(ctx.serverId, 'roles') === false ? "\n-# Role management is off for me here, so tickets will be staff-only until it's switched on." : '';
  return ctx.ok('Panel posted', `Members can open tickets from <#${channel.id}>.${extra}`);
}

async function askPanelChannel(ctx) {
  const { engine } = ctx;
  const chans = (await ctx.channels('text').catch(() => [])).slice(0, 25);
  const embeds = [card({ title: '📌 Where should the panel go?', body: 'Pick a channel. Members press its button to open a ticket.\n-# Or type `/tickets panel #channel`.', color: 'tickets' })];
  const asSelect = () => ctx.ephemeral({ embeds, components: [select(cid('panelpick'), chans.map((c) => ({ label: `#${c.name}`, value: c.id })), { placeholder: 'Pick a channel' }), row(button('Post here', cid('panelhere'), 'primary', '📌'))] });
  const asButtons = () => ctx.ephemeral({ embeds, components: [row(button('Post here', cid('panelhere'), 'primary', '📌')), ...rows(chans.slice(0, 15).map((c) => button(`#${c.name}`, cid('panelto', c.id), 'secondary'))).slice(0, 3)] });
  if (!chans.length) return ctx.ephemeral({ embeds, components: [row(button('Post here', cid('panelhere'), 'primary', '📌'))] });
  return engine.caps.attempt(ctx.serverId, 'selects', asSelect, asButtons);
}

async function setCategory(ctx, text) {
  if (!text || OFF_WORDS.test(text)) {
    ctx.patchConfig({ categoryId: null, categoryName: null });
    return ctx.ok('Category cleared', 'New tickets go at the top of the channel list.');
  }
  const cats = await ctx.bot.categories(ctx.serverId).catch(() => []) || [];
  const hit = cats.find((c) => c.id === text) || fuzzyFind(text, cats)?.item;
  if (!hit) {
    const names = cats.map((c) => c.name);
    const guess = didYouMean(text, names);
    return ctx.warn("I couldn't find that category", `${cats.length ? `Categories here: ${names.map((n) => `**${n}**`).join(', ')}.` : 'This server has no channel categories yet. Make one in Server settings, then try again.'}${guess.length ? `\nDid you mean **${guess[0]}**?` : ''}`);
  }
  ctx.patchConfig({ categoryId: hit.id, categoryName: hit.name });
  return ctx.ok('Category set', `New tickets go in **${hit.name}**.`);
}

async function setStaff(ctx, tokens) {
  if (!tokens.length || OFF_WORDS.test(tokens[0])) {
    ctx.patchConfig({ staffRoles: [] });
    return ctx.ok('Staff reset', 'Anyone who is a mod or admin counts as staff for tickets.');
  }
  const found = [];
  const missing = [];
  for (const tok of tokens) {
    const r = await ctx.findRole(tok);
    if (r) found.push(r); else missing.push(tok);
  }
  if (missing.length || !found.length) return ctx.warn("I couldn't find some roles", `No role matches ${missing.map((m) => `**${clip(m, 30)}**`).join(', ') || 'that'}. Mention them, like @Moderator.`);
  ctx.patchConfig({ staffRoles: uniq(found.map((r) => r.id)) });
  return ctx.ok('Staff roles saved', `${found.map((r) => `<@&${r.id}>`).join(' ')} can see and handle every new ticket.\n-# Admins always count as staff.`);
}

async function setLog(ctx, text) {
  if (!text || OFF_WORDS.test(text)) {
    ctx.patchConfig({ logChannelId: null });
    const core = ctx.core().logChannel;
    return ctx.ok('Ticket log reset', core ? `Transcripts go to the server log, <#${core}>.` : 'No log channel now, so transcripts are not saved.');
  }
  const ch = await ctx.findChannel(text);
  if (!ch) return ctx.warn("I couldn't find that channel", 'Mention it, like `/tickets log #ticket-logs`.');
  ctx.patchConfig({ logChannelId: ch.id });
  return ctx.ok('Ticket log set', `Transcripts and ticket notes go to <#${ch.id}>.`);
}

async function setLimit(ctx, text) {
  const n = Number(String(text || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return ctx.warn("That number didn't work", `Use a whole number from 1 to ${MAX_LIMIT}, like \`/tickets limit 1\`.`);
  ctx.patchConfig({ limit: n });
  return ctx.ok('Limit saved', `Each person can have ${plural(n, 'open ticket')} at a time.`);
}

function typesForm(ctx) {
  const types = typesOf(ctx.config());
  const fields = [];
  for (let i = 0; i < MAX_TYPES; i++) {
    fields.push({ id: `t${i + 1}`, label: i === 0 ? 'Type 1, like: 🎫 Support: question; question' : `Type ${i + 1} (optional)`, style: 'short', required: i === 0, value: types[i] ? formatTypeLine(types[i]) : '', max: 300, placeholder: i === 0 ? '🚩 Report: Who are you reporting?; What happened?' : undefined });
  }
  return ctx.form({ title: 'Ticket types', action: 'savetypes', fields });
}

async function saveTypes(ctx) {
  const lines = Array.from({ length: MAX_TYPES }, (_, i) => ctx.values?.[`t${i + 1}`] || '');
  const types = parseTypes(lines);
  if (!types.length) return ctx.warn('I need at least one type', 'Write it like `🎫 Support` or `🚩 Report: Who are you reporting?; What happened?`.');
  ctx.patchConfig({ types });
  await refreshPostedPanel(ctx.engine, ctx.serverId);
  return ctx.ok('Ticket types saved', `${types.map((t) => `${formatTypeLine(t)}`).join('\n')}\n-# Up to ${MAX_QUESTIONS} questions each, split with ;`);
}

const EDIT_FORMS = {
  staff: (cfg) => ({ title: 'Ticket staff roles', label: 'Staff roles (names, space separated)', value: '', placeholder: 'Moderator Helpers, or "default"' }),
  log: () => ({ title: 'Ticket log channel', label: 'Log channel name', value: '', placeholder: 'ticket-logs, or "off"' }),
  category: (cfg) => ({ title: 'Ticket category', label: 'Category name', value: cfg.categoryName || '', placeholder: 'Support, or "none"' }),
  limit: (cfg) => ({ title: 'Tickets per person', label: `Open tickets per person (1-${MAX_LIMIT})`, value: String(clampLimit(cfg.limit)), placeholder: '1' }),
};

async function saveEdit(ctx, what) {
  const text = String(ctx.values?.value || '').trim();
  if (what === 'staff') return setStaff(ctx, tokenize(text));
  if (what === 'log') return setLog(ctx, text);
  if (what === 'category') return setCategory(ctx, text);
  if (what === 'limit') return setLimit(ctx, text);
  return null;
}

async function tidyUp(ctx) {
  const open = allOpen(ctx.engine, ctx.serverId);
  if (open.length) await ctx.info('Tidying up…', `Checking ${plural(open.length, 'open ticket')}.`);
  let fixed = 0;
  for (const t of open) {
    if (!(await channelGone(ctx.engine, ctx.serverId, t.channelId))) continue;
    const out = await closeTicket(ctx.engine, ctx.serverId, t, { by: ctx.userId, reason: HAND_DELETED });
    if (!out.already) fixed++;
  }
  return ctx.ok('Tidied up', fixed ? `${plural(fixed, 'ticket')} had lost ${fixed === 1 ? 'its' : 'their'} channel, so I closed ${fixed === 1 ? 'it' : 'them'} and removed the ticket roles.` : `All ${plural(open.length, 'open ticket')} still have their channels.`);
}

async function runTickets(ctx, tokensIn) {
  const tokens = tokensIn ?? (ctx.argv.length ? ctx.argv : tokenize(ctx.args));
  const first = String(tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  try {
    if (!first) return await ctx.ephemeral(await setupView(ctx));
    const sub = ADMIN_SUBS[first];
    if (!sub) {
      const guess = didYouMean(first, Object.keys(ADMIN_SUBS));
      return await ctx.warn("I didn't get that", `I don't know **${clip(first, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/tickets\` on its own for the setup panel.`);
    }
    if (sub === 'home') return await ctx.ephemeral(await setupView(ctx));
    if (sub === 'panel') {
      if (!rest.length) return await askPanelChannel(ctx);
      const ch = /^here$/i.test(rest[0]) ? { id: ctx.channelId, name: 'this channel' } : await ctx.findChannel(rest[0]);
      if (!ch) return await ctx.warn("I couldn't find that channel", 'Mention it, like `/tickets panel #support`.');
      return await postPanel(ctx, ch);
    }
    if (sub === 'category') return await setCategory(ctx, rest.join(' '));
    if (sub === 'staff') return await setStaff(ctx, rest);
    if (sub === 'log') return await setLog(ctx, rest[0]);
    if (sub === 'limit') return await setLimit(ctx, rest[0]);
    if (sub === 'types') return await typesForm(ctx);
    if (sub === 'tidy') return await tidyUp(ctx);
    if (sub === 'ping') {
      const on = rest.length ? parseBool(rest[0]) : !ctx.config().pingStaff;
      if (on === null) return await ctx.warn("I didn't get that", 'Use `/tickets ping on` or `/tickets ping off`.');
      ctx.patchConfig({ pingStaff: on });
      return await ctx.ok(on ? 'Staff pings on' : 'Staff pings off', on ? 'New tickets mention the staff roles you picked.' : 'New tickets only mention the person who opened them.');
    }
    return null;
  } catch (e) {
    return ctx.fail(e);
  }
}

function ticketComponent(fn, { staffOnly = false } = {}) {
  return {
    run: async (ctx) => {
      const t = getTicket(ctx.engine, ctx.serverId, ctx.argv[0]);
      if (!t || t.status !== 'open') return ctx.info('This ticket is closed', 'Open a new one with `/ticket` if you still need help.');
      if (staffOnly && !(await isStaff(ctx.engine, ctx.serverId, ctx.userId))) return ctx.warn('Staff only', 'Only staff can do that.');
      return fn(ctx, t);
    },
  };
}

function openPrompt(ctx) {
  const p = panelMessage(ctx.config());
  return ctx.ephemeral({ ...p, embeds: [card({ title: `${ICONS.tickets} Open a ticket`, body: 'Need the staff? Press a button and I\'ll open a private channel just for you and them.\n-# Or type `/ticket your topic`.', color: 'tickets' })] });
}

async function showPanel(ctx) {
  if (await isAdmin(ctx.engine, ctx.serverId, ctx.userId)) return ctx.ephemeral(await setupView(ctx));
  return openPrompt(ctx);
}

export const { setup, teardown, check } = defineApp({
  id: ID,
  name: 'Tickets',
  icon: ICONS.tickets,
  description: 'Private support tickets with transcripts.',
  category: 'Support',
  botPerms: ['manage_channels', 'manage_roles'],

  defaults: {
    categoryId: null,
    categoryName: null,
    staffRoles: [],
    logChannelId: null,
    types: DEFAULT_TYPES,
    limit: 1,
    pingStaff: false,
    panelChannelId: null,
    panelMessageId: null,
  },

  commands: {
    ticket: { description: 'Open a support ticket: /ticket [topic]. Inside one: /ticket close, claim, add @user, rename', run: (ctx) => runTicket(ctx) },
    tickets: { description: 'Ticket setup (admins): /tickets panel #channel, staff @role, log #channel, types, limit 1', perm: 'admin', run: (ctx) => runTickets(ctx) },
  },

  components: {
    open: {
      run: async (ctx) => {
        const topic = topicFromSession(ctx, ctx.argv[1]);
        const cfg = ctx.config();
        const typeId = typeById(cfg, ctx.argv[0]) ? ctx.argv[0] : null;
        return startOpen(ctx, { typeId, topic });
      },
    },
    pick: {
      run: async (ctx) => {
        const typeId = ctx.values?.[0];
        if (!typeById(ctx.config(), typeId)) return ctx.warn('That type is gone', 'Run `/ticket` again to see the current types.');
        return startOpen(ctx, { typeId, topic: topicFromSession(ctx, ctx.argv[0]) });
      },
    },
    answers: {
      run: async (ctx) => {
        const p = takePending(ctx.engine, `${ctx.serverId}:${ctx.userId}`);
        if (!p) return ctx.warn('This form expired', 'Press the ticket button again to start over.');
        const type = typeById(ctx.config(), p.typeId);
        if (!type) return ctx.warn('That type is gone', 'Run `/ticket` again to see the current types.');
        const answers = type.questions.map((q, i) => ({ q, a: clip(String(ctx.values?.[`q${i}`] ?? '').trim(), 1000) }));
        return openTicket(ctx, { type, topic: p.topic, answers });
      },
    },
    claim: ticketComponent(claimTicket, { staffOnly: true }),
    unclaim: ticketComponent(unclaimTicket),
    close: ticketComponent((ctx, t) => askClose(ctx, t, '')),
    closeyes: { run: confirmClose },
    closeno: {
      run: async (ctx) => {
        const s = ctx.engine.router.getSession(ctx.argv[0]);
        const t = s && getTicket(ctx.engine, ctx.serverId, s.num);
        if (t && !(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can decide.');
        if (s) ctx.engine.router.dropSession(ctx.argv[0]);
        return ctx.update({ embeds: [card({ title: `${ICONS.tickets} Ticket stays open`, body: 'Nothing was closed.', color: 'tickets' })], components: freeze(confirmRows(ctx.argv[0]), ctx.source.custom_id) });
      },
    },
    addp: ticketComponent(async (ctx, t) => {
      if (!(await canManage(ctx, t))) return ctx.warn('Not allowed', 'Only staff or the person who opened this ticket can add people.');
      if (t.mode === 'staff' || !t.roleId) return ctx.warn(...noRolesHere());
      return ctx.form({ title: `Add someone to #${pad(t.number)}`, action: 'addsave', fields: [{ id: 'who', label: 'Who? (a name or @mention)', style: 'short', required: true, max: 100, placeholder: 'riley' }] });
    }),
    addsave: {
      run: async (ctx) => {
        const t = ticketInChannel(ctx.engine, ctx.serverId, ctx.channelId);
        if (!t || t.status !== 'open') return notTicket(ctx);
        return addPerson(ctx, t, String(ctx.values?.who || '').trim());
      },
    },
    readd: ticketComponent(async (ctx, t) => addPerson(ctx, t, ctx.argv[1])),
    unrename: ticketComponent(async (ctx, t) => renameTicket(ctx, t, ctx.argv[1]), { staffOnly: true }),

    home: { perm: 'admin', run: async (ctx) => ctx.ephemeral(await setupView(ctx)) },
    postpanel: { perm: 'admin', run: (ctx) => askPanelChannel(ctx) },
    panelhere: { perm: 'admin', run: (ctx) => postPanel(ctx, { id: ctx.channelId, name: 'this channel' }) },
    panelto: {
      perm: 'admin',
      run: async (ctx) => {
        const ch = await ctx.findChannel(ctx.argv[0]);
        if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the setup again with `/tickets`.');
        return postPanel(ctx, ch);
      },
    },
    panelpick: {
      perm: 'admin',
      run: async (ctx) => {
        const ch = await ctx.findChannel(ctx.values?.[0]);
        if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the setup again with `/tickets`.');
        return postPanel(ctx, ch);
      },
    },
    types: { perm: 'admin', run: (ctx) => typesForm(ctx) },
    savetypes: { perm: 'admin', run: saveTypes },
    edit: {
      perm: 'admin',
      run: (ctx) => {
        const what = ctx.argv[0];
        const make = EDIT_FORMS[what];
        if (!make) return ctx.warn('This button is from an older panel', 'Open the setup again with `/tickets`.');
        const f = make(ctx.config());
        return ctx.form({ title: f.title, action: `save${what}`, fields: [{ id: 'value', label: f.label, style: 'short', required: false, value: f.value, placeholder: f.placeholder, max: 200 }] });
      },
    },
    savestaff: { perm: 'admin', run: (ctx) => saveEdit(ctx, 'staff') },
    savelog: { perm: 'admin', run: (ctx) => saveEdit(ctx, 'log') },
    savecategory: { perm: 'admin', run: (ctx) => saveEdit(ctx, 'category') },
    savelimit: { perm: 'admin', run: (ctx) => saveEdit(ctx, 'limit') },
    ping: {
      perm: 'admin',
      run: async (ctx) => {
        ctx.patchConfig({ pingStaff: !ctx.config().pingStaff });
        return ctx.update(await setupView(ctx));
      },
    },
    tidy: { perm: 'admin', run: (ctx) => tidyUp(ctx) },
  },

  yap: [{
    words: ['ticket', 'tickets', 'support', 'help-desk'],
    run: async (ctx) => {
      if (ctx.word === 'tickets' && await isAdmin(ctx.engine, ctx.serverId, ctx.userId) && (!ctx.argv.length || ADMIN_SUBS[String(ctx.argv[0]).toLowerCase()])) return runTickets(ctx, ctx.argv);
      return runTicket(ctx, ctx.argv);
    },
  }],

  panel: showPanel,

  presets: {
    community: { enabled: true, config: { types: PRESET_TYPES.community } },
    gaming: { enabled: true, config: { types: PRESET_TYPES.gaming } },
    friends: { enabled: false, config: {} },
    study: { enabled: true, config: { types: PRESET_TYPES.study } },
    roleplay: { enabled: true, config: { types: PRESET_TYPES.roleplay } },
  },

  applyPreset: async (engine, serverId, { preset, channels } = {}) => {
    const notes = [];
    const cfg = cfgOf(engine, serverId);
    const types = PRESET_TYPES[preset];
    if (types) {
      engine.settings.patchApp(serverId, ID, { types });
      notes.push(`types: ${types.map((t) => t.name).join(', ')}`);
    }
    if (!cfg.logChannelId && channels?.logs?.id) {
      engine.settings.patchApp(serverId, ID, { logChannelId: channels.logs.id });
      notes.push(`transcripts to #${channels.logs.name}`);
    }
    if (preset === 'friends') return 'Tickets stays off for friend groups. Turn it on any time with /apps.';
    return `Tickets is ready${notes.length ? ` (${notes.join(', ')})` : ''}. Post the open-ticket panel with /tickets panel #channel.`;
  },

  help: [
    'Each ticket is a private channel with its own role: the member, people they add, and staff see it.',
    'Closing saves a transcript to the log channel and DMs a copy to the member when DMs work.',
    'Staff can close a ticket from anywhere with /ticket close 12, even if its channel was deleted by hand.',
  ],

  init(engine) {
    for (const sid of engine.store.keys(ID)) {
      const d = readData(engine, sid);
      if (Object.values(d.tickets).some((t) => t.status === 'closing')) {
        writeData(engine, sid, (x) => { for (const t of Object.values(x.tickets)) if (t.status === 'closing') t.status = 'open'; });
      }
      for (const t of Object.values(d.tickets)) if (t.cleanup) scheduleCleanup(engine, sid, t.number, CLOSE_DELAY_MS);
    }
  },

  dispose(engine) {
    const r = rt(engine);
    for (const timer of r.timers.values()) clearTimeout(timer);
    r.timers.clear();
    r.pending.clear();
    r.opening.clear();
    r.transcripts.clear();
  },
});
