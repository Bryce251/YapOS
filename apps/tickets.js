import { defineApp } from '../engine/apps.js';
import { card, dialog, button, row, rows, select, freeze, ICONS } from '../engine/ui.js';
import { customId } from '../engine/router.js';
import { tokenize, clip, normalizeName, didYouMean, parseBool, fuzzyFind, formatDuration, ID_RE } from '../engine/parse.js';
import { explain, looksLikeFeatureOff } from '../engine/errors.js';
import { accept, reject, isBlank, boolField, idList, safeId, plainObject, channelById, roleById } from '../engine/dashboard.js';

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
const LIVE_PAGES = 10;
const LIVE_TTL_MS = 45_000;
const MAX_LIVE = 200;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 500;
const MAX_LIMIT = 10;
const TRANSCRIPT_COOLDOWN_MS = 60_000;
const STAFF_PERMS = ['administrator', 'manage_server', 'kick_members', 'ban_members', 'timeout_members', 'manage_messages'];
const CAP_CHECKS = ['roles', 'files', 'dms', 'selects', 'modals'];
const CAP_LABELS = { roles: 'Role management', files: 'Sending files', dms: 'Direct messages', selects: 'Select menus', modals: 'Pop-up forms' };
const MAX_TYPE_STAFF = 10;
const HOUR = 3_600_000;
const MAX_AUTOCLOSE_HOURS = 720;
const WARN_LEAD_MAX_MS = 12 * HOUR;
const QUIET_TOUCH_MS = 10 * 60_000;
const MAX_SEEN = 5000;
const WARN_JOB = 'tickets.quietwarn';
const CLOSE_JOB = 'tickets.quietclose';
const STARS = [1, 2, 3, 4, 5];
const MAX_COMMENT = 500;
const TRANSCRIPT_CAP = 200_000;
const MAX_TRANSCRIPTS_KEPT = 20;
const TRANSCRIPT_NS = 'ticket-transcripts';
const PAGE_SIZE = 50;
const MAX_PAGE = 100;
const SEARCH_MAX = 100;

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

const lookup = (entries) => Object.assign(Object.create(null), entries);
const SUBS = lookup({
  open: 'open', new: 'open', create: 'open',
  close: 'close', claim: 'claim', unclaim: 'unclaim',
  add: 'add', remove: 'remove', rename: 'rename', transcript: 'transcript',
});
const ADMIN_SUBS = lookup({
  panel: 'panel', post: 'panel', category: 'category', cat: 'category', staff: 'staff', log: 'log', logs: 'log',
  types: 'types', type: 'type', limit: 'limit', ping: 'ping', tidy: 'tidy', cleanup: 'tidy', settings: 'home', home: 'home',
  autoclose: 'autoclose', 'auto-close': 'autoclose', quiet: 'autoclose', idle: 'autoclose',
});
const OFF_WORDS = /^(off|none|clear|reset|default|no)$/i;

const runtimes = new WeakMap();
function rt(engine) {
  let r = runtimes.get(engine);
  if (!r) { r = { pending: new Map(), opening: new Set(), timers: new Map(), transcripts: new Map(), seen: new Map(), touched: new Map(), channels: new Map() }; runtimes.set(engine, r); }
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

const transcriptKey = (sid, number) => `${sid}-${Number(number)}`;

function pruneClosed(d) {
  const dropped = [];
  const closed = Object.values(d.tickets).filter((t) => t.status === 'closed' && !t.cleanup).sort((a, b) => a.number - b.number);
  for (const t of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_KEPT))) {
    if (t.hasTranscript) dropped.push(t.number);
    delete d.tickets[t.number];
  }
  const stored = Object.values(d.tickets).filter((t) => t.hasTranscript).sort((a, b) => a.number - b.number);
  for (const t of stored.slice(0, Math.max(0, stored.length - MAX_TRANSCRIPTS_KEPT))) {
    dropped.push(t.number);
    delete t.hasTranscript;
  }
  return dropped;
}

function liftInlineTranscripts(engine, sid, d) {
  for (const t of Object.values(d.tickets)) {
    if (!('transcript' in t) && !('transcriptCount' in t)) continue;
    if (typeof t.transcript === 'string') {
      engine.store.set(TRANSCRIPT_NS, transcriptKey(sid, t.number), { text: t.transcript, count: t.transcriptCount ?? 0, at: t.closedAt || Date.now() });
      t.hasTranscript = true;
    }
    delete t.transcript;
    delete t.transcriptCount;
  }
}

function saveTranscript(engine, sid, number, transcript) {
  engine.store.set(TRANSCRIPT_NS, transcriptKey(sid, number), { text: capTranscript(transcript.text), count: transcript.count, at: Date.now() });
}

function storedTranscript(engine, sid, number) {
  const doc = engine.store.get(TRANSCRIPT_NS, transcriptKey(sid, number), null);
  return doc && typeof doc.text === 'string' ? doc : null;
}

const capTranscript = (text) => {
  const s = String(text || '');
  return s.length > TRANSCRIPT_CAP ? s.slice(-TRANSCRIPT_CAP) : s;
};

function writeData(engine, sid, fn) {
  let out;
  let dropped = [];
  engine.store.update(ID, sid, (d) => {
    const full = { ...emptyData(), ...d };
    out = fn(full);
    liftInlineTranscripts(engine, sid, full);
    dropped = pruneClosed(full);
    return full;
  }, emptyData());
  for (const n of dropped) engine.store.delete(TRANSCRIPT_NS, transcriptKey(sid, n));
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
    staffRoles: uniq([].concat(t.staffRoles || []).filter((r) => typeof r === 'string')).slice(0, MAX_TYPE_STAFF),
  }));
}

function roleList(ids, max) {
  const shown = ids.slice(0, max).map((r) => `<@&${r}>`).join(' ');
  return ids.length > max ? `${shown} +${ids.length - max} more` : shown;
}

function typeStaffRoles(cfg, typeId) {
  return typeById(cfg, typeId)?.staffRoles || [];
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

async function globalStaffRoleIds(engine, sid) {
  const cfg = cfgOf(engine, sid);
  if (cfg.staffRoles?.length) return uniq(cfg.staffRoles);
  const core = engine.settings.core(sid);
  const roles = await engine.perms.roles(sid).catch(() => []);
  const byPerm = roles.filter((r) => STAFF_PERMS.some((k) => r.perms?.[k])).map((r) => r.id);
  return uniq([...byPerm, ...(core.modRoles || []), ...(core.adminRoles || [])]);
}

async function staffRoleIds(engine, sid, typeId = null) {
  const global = await globalStaffRoleIds(engine, sid);
  return uniq([...global, ...(typeId ? typeStaffRoles(cfgOf(engine, sid), typeId) : [])]);
}

async function isStaff(engine, sid, uid, t = null) {
  const level = await engine.perms.level(sid, uid);
  if (engine.perms.atLeast(level, 'admin')) return true;
  const cfg = cfgOf(engine, sid);
  const typeRoles = t ? typeStaffRoles(cfg, t.typeId) : [];
  if (cfg.staffRoles?.length || typeRoles.length) {
    const m = await engine.perms.member(sid, uid).catch(() => null);
    const mine = m?.roles || [];
    if (typeRoles.length && mine.some((r) => typeRoles.includes(r))) return true;
    if (cfg.staffRoles?.length) return mine.some((r) => cfg.staffRoles.includes(r));
  }
  return engine.perms.atLeast(level, 'mod');
}

function refuse(ctx, need, body) {
  const embed = need === 'staff' ? dialog.denied(null, { title: 'Needs Staff', body }) : dialog.denied(need, { body });
  return ctx.ephemeral({ embeds: [embed] });
}

async function isAdmin(engine, sid, uid) {
  return engine.perms.atLeast(await engine.perms.level(sid, uid), 'admin');
}

async function adminGate(ctx) {
  if (await isAdmin(ctx.engine, ctx.serverId, ctx.userId)) return true;
  await refuse(ctx, 'admin', 'Only admins can change the ticket setup.');
  return false;
}

async function channelHere(ctx) {
  const inServer = async () => (await ctx.channels('text').catch(() => [])).find((c) => c.id === ctx.channelId) || null;
  let ch = await inServer();
  if (!ch) {
    ctx.engine.cache.invalidate(ctx.serverId);
    ch = await inServer();
  }
  return ch ? { id: ch.id, name: 'this channel' } : null;
}

const notHere = (ctx) => ctx.warn("I can't post here", 'This channel is not a text channel of this server. Try `/tickets panel #channel`.');

function guarded(components) {
  const out = {};
  for (const [action, spec] of Object.entries(components)) {
    out[action] = {
      ...spec,
      run: async (ctx) => {
        if (!ctx.serverId) return ctx.warn('Servers only', 'Tickets work inside a server.');
        if (!ctx.engine.settings.isEnabled(ctx.serverId, ID)) return ctx.warn("Tickets isn't installed here", 'An admin can install it with **/apps**.');
        return spec.run(ctx);
      },
    };
  }
  return out;
}

function adminOnly(run) {
  return { perm: 'admin', run: async (ctx) => ((await adminGate(ctx)) ? run(ctx) : null) };
}

const notYourConfirm = (ctx) => ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Not your panel', body: 'Someone else asked to close this ticket. Run `/ticket close` yourself to get your own buttons.' })] });

async function canManage(ctx, t) {
  return t.openerId === ctx.userId || isStaff(ctx.engine, ctx.serverId, ctx.userId, t);
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

const cardPayload = (engine, sid, t) => ({ embeds: [ticketCard(engine, sid, t)], components: cardComponents(t) });

function editCard(engine, sid, t) {
  if (!t.cardId) return Promise.resolve(null);
  return engine.budget.edit({ channelId: t.channelId, messageId: t.cardId, opts: cardPayload(engine, sid, t) }).catch((e) => {
    engine.log.debug('ticket card edit failed', e?.message);
    return null;
  });
}

async function refreshCard(ctx, t) {
  if (ctx.kind === 'button' && t.cardId && ctx.source.message_id === t.cardId) return ctx.update(cardPayload(ctx.engine, ctx.serverId, t));
  return editCard(ctx.engine, ctx.serverId, t);
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

async function makeSpace(ctx, { number, cfg, type }) {
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
    const [staff, botRole] = await Promise.all([staffRoleIds(engine, sid, type?.id), botTopRoleId(engine, sid)]);
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
    made = await makeSpace(ctx, { number, cfg, type });
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
    lastActivityAt: engine.scheduler.now(), quietWarn: null, rating: null, ratingAsk: null,
  };
  writeData(engine, sid, (d) => { d.tickets[number] = t; });
  rememberChannel(engine, sid, t);
  rt(engine).touched.set(`${sid}:${number}`, t.lastActivityAt);
  scheduleQuiet(engine, sid, t);

  const pingRoles = uniq([...(cfg.staffRoles || []), ...(type.staffRoles || [])]);
  const staffPing = cfg.pingStaff && pingRoles.length ? ` ${pingRoles.map((r) => `<@&${r}>`).join(' ')}` : '';
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

async function mentionNames(engine, sid) {
  const [members, roles, channels] = await Promise.all([
    engine.cache.members(sid).catch(() => []),
    engine.perms.roles(sid).catch(() => []),
    engine.cache.channels(sid).catch(() => []),
  ]);
  const botId = engine.bot.me?.id;
  const users = new Map(members.map((m) => [m.id, m.nickname || m.display_name || m.username]));
  if (botId) users.set(botId, 'YapOS');
  return {
    users,
    roles: new Map(roles.map((r) => [r.id, r.name])),
    channels: new Map(channels.map((c) => [c.id, c.name])),
  };
}

function readable(text, names) {
  return String(text)
    .replace(/<@!?([\w-]+)>/g, (all, id) => `@${names.users.get(id) || 'someone'}`)
    .replace(/<@&([\w-]+)>/g, (all, id) => `@${names.roles.get(id) || 'role'}`)
    .replace(/<#([\w-]+)>/g, (all, id) => `#${names.channels.get(id) || 'channel'}`)
    .replace(/<a?:(\w+):[\w-]+>/g, ':$1:');
}

function formatMessageLine(m, botId, names) {
  const who = m.author_id === botId ? 'YapOS' : (names.users.get(m.author_id) || m.author?.display_name || m.author?.username || 'unknown');
  const bits = [];
  if (m.content) bits.push(readable(m.content, names).replace(/\n/g, '\n    '));
  const files = [];
  if (m.attachment_name) files.push(m.attachment_name);
  if (m.attachment?.name) files.push(m.attachment.name);
  if (typeof m.attachment === 'string') files.push(m.attachment.split('/').pop());
  if (m.attachment_path && !files.length) files.push(String(m.attachment_path).split('/').pop());
  for (const f of [].concat(m.attachments || [], m.files || [])) if (f?.name) files.push(f.name);
  for (const f of uniq(files)) bits.push(`[file: ${f}]`);
  for (const e of m.embeds || []) if (e?.title) bits.push(`[card: ${readable(e.title, names)}]`);
  return `[${stamp(m.created_at)}] ${who}: ${bits.join(' ') || '(no text)'}`;
}

async function readHistory(engine, t, maxPages = MAX_PAGES) {
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
    for (let page = 0; page < maxPages; page++) {
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

async function buildTranscript(engine, sid, t, { closedBy, reason, maxPages = MAX_PAGES } = {}) {
  const cfg = cfgOf(engine, sid);
  const [msgs, names] = await Promise.all([readHistory(engine, t, maxPages), mentionNames(engine, sid)]);
  const head = [
    `Ticket #${pad(t.number)} (${typeById(cfg, t.typeId)?.name || 'Ticket'})`,
    `Opened by ${await usernameOf(engine, sid, t.openerId, t.openerId)} on ${stamp(t.createdAt)} UTC`,
  ];
  if (t.claimedBy) head.push(`Claimed by ${await usernameOf(engine, sid, t.claimedBy, t.claimedBy)}`);
  if (closedBy) head.push(`Closed by ${await usernameOf(engine, sid, closedBy, closedBy)} on ${stamp(Date.now())} UTC${reason ? `. Reason: ${reason}` : ''}`);
  if (t.topic) head.push(`Topic: ${t.topic}`);
  for (const a of t.answers || []) head.push(`${a.q} ${a.a}`);
  head.push('-'.repeat(40));
  const lines = msgs.map((m) => formatMessageLine(m, engine.bot.me?.id, names));
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
  const file = { name: transcriptName(t), data: Buffer.from(`﻿${transcript.text}`, 'utf8') };
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
  cancelQuiet(engine, sid, t.number);
  forgetChannel(engine, sid, fresh);
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
  if (transcript) saveTranscript(engine, sid, t.number, transcript);
  const closed = patchTicket(engine, sid, t.number, {
    status: 'closed', closedAt: Date.now(), closedBy: by, reason: clip(reason || '', 500) || null,
    cleanup: { channel: !!channel, role: !!fresh.roleId },
    hasTranscript: !!transcript,
  });
  if (transcript) {
    const dmOk = await dmTranscript(engine, sid, closed, transcript);
    notes.push(dmOk ? `Sent a copy to <@${t.openerId}> in DMs.` : `Couldn't DM a copy to <@${t.openerId}> (DMs are off or closed).`);
  }
  if (reason !== HAND_DELETED) {
    const asked = await askRating(engine, sid, closed);
    notes.push(asked ? `Asked <@${t.openerId}> to rate the help in DMs.` : `Couldn't ask <@${t.openerId}> for a rating (DMs are off or closed).`);
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

function channelMap(engine, sid) {
  const { channels } = rt(engine);
  let m = channels.get(sid);
  if (!m) {
    m = new Map();
    for (const t of Object.values(readData(engine, sid).tickets)) if (t.status === 'open' && t.channelId) m.set(t.channelId, t.number);
    channels.set(sid, m);
    reconcileQuiet(engine, sid);
  }
  return m;
}

function reconcileQuiet(engine, sid) {
  const s = engine.scheduler;
  if (!s || !quietHours(cfgOf(engine, sid))) return 0;
  const has = new Set([WARN_JOB, CLOSE_JOB].flatMap((kind) => s.list({ kind, serverId: sid }).map((j) => j.key)));
  let n = 0;
  for (const t of allOpen(engine, sid)) {
    if (has.has(String(t.number))) continue;
    const ready = Number.isFinite(t.lastActivityAt) ? t : patchTicket(engine, sid, t.number, { lastActivityAt: s.now() }) || t;
    if (scheduleQuiet(engine, sid, ready)) n++;
  }
  return n;
}

function dropQuietMemory(engine, sid) {
  rt(engine).channels.delete(sid);
}

function rememberChannel(engine, sid, t) {
  if (t.channelId) channelMap(engine, sid).set(t.channelId, t.number);
}

function forgetChannel(engine, sid, t) {
  const m = rt(engine).channels.get(sid);
  if (m && t.channelId && m.get(t.channelId) === t.number) m.delete(t.channelId);
}

function capSeen(map) {
  while (map.size > MAX_SEEN) map.delete(map.keys().next().value);
}

function quietHours(cfg) {
  const n = Number(cfg.autoCloseHours);
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_AUTOCLOSE_HOURS, Math.floor(n)) : 0;
}

const leadFor = (hours) => Math.min(WARN_LEAD_MAX_MS, Math.round((hours * HOUR) / 2));

function quietBase(engine, sid, t) {
  const seen = rt(engine).seen.get(`${sid}:${t.number}`) || 0;
  const saved = Number.isFinite(t.lastActivityAt) ? t.lastActivityAt : t.createdAt;
  return Math.max(saved || 0, seen);
}

function cancelQuiet(engine, sid, num) {
  const s = engine.scheduler;
  if (!s) return;
  for (const kind of [WARN_JOB, CLOSE_JOB]) s.cancelWhere({ kind, serverId: sid, key: String(num) });
}

function scheduleQuiet(engine, sid, t) {
  const s = engine.scheduler;
  if (!s || !t || t.status !== 'open') return null;
  const hours = quietHours(cfgOf(engine, sid));
  if (!hours) {
    cancelQuiet(engine, sid, t.number);
    return null;
  }
  const warnAt = quietBase(engine, sid, t) + hours * HOUR - leadFor(hours);
  try {
    s.cancelWhere({ kind: CLOSE_JOB, serverId: sid, key: String(t.number) });
    return s.schedule({ kind: WARN_JOB, at: Math.max(warnAt, s.now()), serverId: sid, key: String(t.number), data: { num: t.number } });
  } catch (e) {
    engine.log.warn(`[tickets] couldn't schedule the quiet check for #${pad(t.number)}: ${e?.message}`);
    return null;
  }
}

function rescheduleAllQuiet(engine, sid) {
  const now = engine.scheduler.now();
  let n = 0;
  for (const t of allOpen(engine, sid)) {
    const ready = Number.isFinite(t.lastActivityAt) ? t : patchTicket(engine, sid, t.number, { lastActivityAt: now }) || t;
    if (scheduleQuiet(engine, sid, ready)) n++;
  }
  return n;
}

function hoursText(hours) {
  return hours % 24 === 0 ? plural(hours / 24, 'day') : plural(hours, 'hour');
}

function waitText(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return plural(mins, 'minute');
  return plural(Math.round(mins / 60), 'hour');
}

function warningPayload(num, closeInMs) {
  return {
    embeds: [card({ title: '💤 This ticket has gone quiet', body: `This ticket will close in ${waitText(closeInMs)} because it's been quiet.\nSay something here or press **Keep open** if you still need it. Closing saves a transcript as usual.`, color: 'warn' })],
    components: [row(button('Keep open', cid('keepopen', num), 'success', '✋'))],
  };
}

async function quietWarnJob(job, engine) {
  const sid = job.serverId;
  if (!sid) return undefined;
  if (!engine.settings.isEnabled(sid, ID)) return dropQuietMemory(engine, sid);
  const num = Number(job.data?.num);
  const t = getTicket(engine, sid, num);
  if (!t || t.status !== 'open') return undefined;
  const hours = quietHours(cfgOf(engine, sid));
  if (!hours) return undefined;
  const s = engine.scheduler;
  const now = s.now();
  const base = quietBase(engine, sid, t);
  const lead = leadFor(hours);
  const warnAt = base + hours * HOUR - lead;
  if (warnAt > now + 1000) return { reschedule: warnAt };
  const closeAt = Math.max(base + hours * HOUR, now + lead);
  if (!(t.quietWarn && t.quietWarn.base === base && t.quietWarn.closeAt > now)) {
    patchTicket(engine, sid, num, { quietWarn: { base, closeAt, messageId: null } });
    let sent = null;
    try {
      const p = warningPayload(num, closeAt - now);
      sent = await engine.budget.send({ serverId: sid, channelId: t.channelId, content: `<@${t.openerId}>`, opts: p, priority: 'low' });
    } catch (e) {
      patchTicket(engine, sid, num, { quietWarn: null });
      if (await channelGone(engine, sid, t.channelId)) {
        await closeTicket(engine, sid, t, { by: engine.bot.me?.id, reason: HAND_DELETED });
        return undefined;
      }
      throw e;
    }
    patchTicket(engine, sid, num, (x) => (x.quietWarn?.base === base ? { quietWarn: { ...x.quietWarn, messageId: sent?.id || null } } : {}));
  }
  const warned = getTicket(engine, sid, num)?.quietWarn;
  s.schedule({ kind: CLOSE_JOB, at: warned?.closeAt ?? closeAt, serverId: sid, key: String(num), data: { num } });
  return undefined;
}

async function quietCloseJob(job, engine) {
  const sid = job.serverId;
  if (!sid) return undefined;
  if (!engine.settings.isEnabled(sid, ID)) return dropQuietMemory(engine, sid);
  const num = Number(job.data?.num);
  const t = getTicket(engine, sid, num);
  if (!t || t.status !== 'open') return undefined;
  const hours = quietHours(cfgOf(engine, sid));
  if (!hours) return undefined;
  const base = quietBase(engine, sid, t);
  if (!t.quietWarn || t.quietWarn.base !== base) {
    scheduleQuiet(engine, sid, t);
    return undefined;
  }
  const now = engine.scheduler.now();
  if (t.quietWarn.closeAt > now + 1000) return { reschedule: t.quietWarn.closeAt };
  await closeTicket(engine, sid, t, { by: null, reason: `Closed automatically after ${hoursText(hours)} with no messages` });
  return undefined;
}

async function calmWarning(engine, t, text) {
  const w = t.quietWarn;
  if (!w?.messageId) return;
  await engine.budget.edit({ channelId: t.channelId, messageId: w.messageId, opts: { embeds: [card({ title: '💬 Ticket stays open', body: text, color: 'tickets' })], components: [] } }).catch((e) => engine.log.debug('quiet warning edit failed', e?.message));
}

async function onTicketMessage(ctx, msg) {
  const { engine, serverId: sid } = ctx;
  if (!sid || msg.dm || msg.author_bot || !msg.channel_id) return;
  const map = channelMap(engine, sid);
  const num = map.get(msg.channel_id);
  if (!num) return;
  const r = rt(engine);
  const k = `${sid}:${num}`;
  const now = engine.scheduler.now();
  r.seen.delete(k);
  r.seen.set(k, now);
  capSeen(r.seen);
  const t = getTicket(engine, sid, num);
  if (!t || t.status !== 'open') {
    map.delete(msg.channel_id);
    return;
  }
  if (!t.quietWarn && now - (r.touched.get(k) || 0) < QUIET_TOUCH_MS) return;
  r.touched.delete(k);
  r.touched.set(k, now);
  capSeen(r.touched);
  const updated = patchTicket(engine, sid, num, { lastActivityAt: now, quietWarn: null });
  scheduleQuiet(engine, sid, updated);
  if (t.quietWarn) await calmWarning(engine, t, 'Someone replied, so this ticket stays open.');
}

async function keepOpen(ctx, t) {
  const { engine, serverId: sid } = ctx;
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can keep it open.');
  const now = engine.scheduler.now();
  const k = `${sid}:${t.number}`;
  rt(engine).seen.set(k, now);
  rt(engine).touched.set(k, now);
  const updated = patchTicket(engine, sid, t.number, { lastActivityAt: now, quietWarn: null });
  scheduleQuiet(engine, sid, updated);
  const hours = quietHours(cfgOf(engine, sid));
  const body = `<@${ctx.userId}> kept this ticket open.${hours ? ` It closes after ${hoursText(hours)} with no messages.` : ''}`;
  const payload = { embeds: [card({ title: '✋ Ticket stays open', body, color: 'tickets' })], components: [] };
  if (ctx.kind === 'button' && t.quietWarn?.messageId && ctx.source.message_id === t.quietWarn.messageId) return ctx.update(payload);
  if (t.quietWarn) await calmWarning(engine, t, body);
  return ctx.ok('Ticket stays open', hours ? `I'll only close it after ${hoursText(hours)} with no messages.` : 'Auto-close is off, so it stays open until someone closes it.');
}

function starsText(n) {
  return `${'⭐'.repeat(n)}${'▫️'.repeat(5 - n)}`;
}

function ratingRows(sid, num) {
  return [row(STARS.map((n) => button(String(n), cid('rate', sid, num, n), n >= 4 ? 'success' : 'secondary', '⭐')))];
}

function ratingAskCard(serverName, t) {
  return card({ title: `${ICONS.tickets} How did we do?`, body: `Your ticket #${pad(t.number)}${serverName ? ` on **${clip(serverName, 80)}**` : ''} was closed. How happy are you with the help you got?\nPress 1 (not at all) to 5 (very happy). You can add a comment after.`, color: 'tickets' });
}

function ratingThanks(t, sid) {
  const r = t.rating;
  const lines = [`You gave ticket #${pad(t.number)} ${starsText(r.stars)} (${r.stars}/5).`];
  if (r.comment) lines.push(`> ${clip(r.comment.replace(/\n/g, ' '), 300)}`);
  lines.push('Thanks, the staff will see it.');
  return {
    embeds: [card({ title: `${ICONS.ok} Thanks for rating`, body: lines.join('\n'), color: 'ok' })],
    components: r.comment ? [] : [row(button('Add a comment', cid('ratenote', sid, t.number), 'secondary', '💬'))],
  };
}

function ratingLogCard(t) {
  const r = t.rating;
  const fields = [
    { name: 'Rating', value: `${starsText(r.stars)} ${r.stars}/5`, inline: true },
    { name: 'Opened by', value: `<@${t.openerId}>`, inline: true },
    { name: 'Claimed by', value: t.claimedBy ? `<@${t.claimedBy}>` : 'Nobody', inline: true },
  ];
  if (r.comment) fields.push({ name: 'Comment', value: clip(r.comment, MAX_COMMENT), inline: false });
  return card({ title: `⭐ Ticket #${pad(t.number)} rated ${r.stars}/5`, fields, color: r.stars >= 4 ? 'ok' : r.stars <= 2 ? 'warn' : 'tickets' });
}

async function askRating(engine, sid, t) {
  if (!t?.openerId || t.openerId === engine.bot.me?.id || t.rating) return false;
  const server = await engine.perms.server(sid).catch(() => null);
  try {
    return await engine.caps.attempt(sid, 'dms', async () => {
      const dmChannel = await engine.bot.dm(t.openerId);
      const sent = await engine.budget.send({ serverId: null, channelId: dmChannel, content: '', opts: { embeds: [ratingAskCard(server?.name, t)], components: ratingRows(sid, t.number) }, priority: 'low' });
      patchTicket(engine, sid, t.number, { ratingAsk: { channelId: dmChannel, messageId: sent?.id || null } });
      return true;
    }, () => false);
  } catch (e) {
    engine.log.debug('rating DM failed', e?.message);
    return false;
  }
}

function ratingTarget(ctx, sidArg, numArg) {
  const { engine } = ctx;
  const sid = String(sidArg || '');
  const num = Number(numArg);
  if (!ID_RE.test(sid) || !Number.isInteger(num) || num < 1) return { stop: () => ctx.warn('This button is too old', 'It no longer points at a ticket.') };
  if (ctx.serverId && ctx.serverId !== sid) return { stop: () => ctx.warn('This button belongs to another server', 'Rate a ticket from the DM I sent you about it.') };
  if (!engine.settings.isEnabled(sid, ID)) return { stop: () => ctx.warn("Tickets isn't installed there any more", "So I can't save a rating for this ticket. Thanks anyway!") };
  const t = getTicket(engine, sid, num);
  if (!t) return { stop: () => ctx.info('That ticket is gone', 'I have no record of it any more.') };
  if (t.openerId !== ctx.userId) return { stop: () => ctx.ephemeral({ embeds: [dialog.denied(null, { title: 'Not your ticket', body: 'Only the person who opened this ticket can rate it.' })] }) };
  if (t.status === 'open') return { stop: () => ctx.info('This ticket is still open', 'You can rate it once it is closed.') };
  return { sid, num, t };
}

async function rateTicket(ctx) {
  const target = ratingTarget(ctx, ctx.argv[0], ctx.argv[1]);
  if (target.stop) return target.stop();
  const stars = Number(ctx.argv[2]);
  if (!STARS.includes(stars)) return ctx.warn('This button is too old', 'Pick a number from 1 to 5 on the latest message.');
  const { engine } = ctx;
  const { sid, num } = target;
  let fresh = false;
  const updated = patchTicket(engine, sid, num, (x) => {
    if (x.rating) return {};
    fresh = true;
    return { rating: { stars, at: Date.now(), comment: null, logMessageId: null } };
  });
  const onCard = ctx.kind === 'button' && !!ctx.source.message_id && ctx.source.message_id === updated.ratingAsk?.messageId;
  if (!fresh) {
    if (onCard) return ctx.update(ratingThanks(updated, sid));
    return ctx.info('Already rated', `You already gave this ticket ${updated.rating.stars}/5. One rating per ticket.`);
  }
  if (onCard) await ctx.update(ratingThanks(updated, sid));
  else await ctx.ephemeral(ratingThanks(updated, sid));
  const logged = await postLog(engine, sid, { embeds: [ratingLogCard(updated)] }, 'low');
  if (logged?.id) patchTicket(engine, sid, num, (x) => (x.rating ? { rating: { ...x.rating, logMessageId: logged.id } } : {}));
  return null;
}

async function askComment(ctx) {
  const target = ratingTarget(ctx, ctx.argv[0], ctx.argv[1]);
  if (target.stop) return target.stop();
  const { t } = target;
  if (!t.rating) return ctx.warn('Pick your stars first', 'Press a number from 1 to 5, then you can add a comment.');
  if (t.rating.comment) return ctx.info('Comment already saved', 'You can only leave one comment per ticket. Thanks!');
  const { engine } = ctx;
  const capSid = ctx.serverId || null;
  const modal = {
    custom_id: cid('ratesave', target.sid, target.num),
    title: `Ticket #${pad(t.number)}: your comment`,
    components: [{ type: 'text_input', custom_id: 'comment', label: 'What went well, or what could be better?', style: 'paragraph', required: true, max_length: MAX_COMMENT }],
  };
  if (engine.caps.state(capSid, 'modals') !== false && typeof ctx.source.showModal === 'function') {
    try {
      await ctx.source.showModal(modal);
      engine.caps.mark(capSid, 'modals', true);
      return null;
    } catch (e) {
      engine.caps.mark(capSid, 'modals', false, e?.message);
    }
  }
  return ctx.info("Comments aren't available here", 'Pop-up forms are switched off for me, so I can only take your stars. They are saved, thanks!');
}

async function saveComment(ctx) {
  const target = ratingTarget(ctx, ctx.argv[0], ctx.argv[1]);
  if (target.stop) return target.stop();
  const { engine } = ctx;
  const { sid, num } = target;
  const text = clip(String(ctx.values?.comment ?? '').trim(), MAX_COMMENT);
  if (!text) return ctx.warn('The comment was empty', 'Nothing was saved. Your stars still count.');
  let outcome = 'saved';
  const updated = patchTicket(engine, sid, num, (x) => {
    if (!x.rating) { outcome = 'norating'; return {}; }
    if (x.rating.comment) { outcome = 'already'; return {}; }
    return { rating: { ...x.rating, comment: text } };
  });
  if (outcome === 'norating') return ctx.warn('Pick your stars first', 'Press a number from 1 to 5, then you can add a comment.');
  if (outcome === 'already') return ctx.info('Comment already saved', 'You can only leave one comment per ticket. Thanks!');
  await ctx.ok('Comment saved', 'Thanks! The staff will see it with your rating.');
  if (updated.ratingAsk?.messageId) {
    await engine.budget.edit({ channelId: updated.ratingAsk.channelId, messageId: updated.ratingAsk.messageId, opts: ratingThanks(updated, sid) }).catch((e) => engine.log.debug('rating card edit failed', e?.message));
  }
  const logCh = logChannelOf(engine, sid);
  if (logCh && updated.rating.logMessageId) {
    const edited = await engine.budget.edit({ channelId: logCh, messageId: updated.rating.logMessageId, opts: { embeds: [ratingLogCard(updated)] } }).then(() => true, () => false);
    if (edited) return null;
  }
  await postLog(engine, sid, { embeds: [ratingLogCard(updated)] }, 'low');
  return null;
}

function ratingSummary(engine, sid) {
  const rated = Object.values(readData(engine, sid).tickets).filter((t) => t.rating?.stars);
  if (!rated.length) return 'No ratings yet';
  const avg = rated.reduce((a, t) => a + t.rating.stars, 0) / rated.length;
  return `⭐ ${avg.toFixed(1)} average from ${plural(rated.length, 'rating')}`;
}

function confirmRows(sess) {
  return [row(button('Close ticket', cid('closeyes', sess), 'danger', ICONS.lock), button('Keep it open', cid('closeno', sess), 'secondary'))];
}

async function askClose(ctx, t, reason) {
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can close it.');
  const sess = ctx.engine.router.session({ num: t.number, reason: clip(reason || '', 500), sid: ctx.serverId, userId: ctx.userId });
  const body = `${reason ? `**Reason:** ${clip(reason, 300)}\n` : ''}I'll save a transcript, then delete the channel. This can't be undone.`;
  return ctx.ephemeral({ embeds: [card({ title: `${ICONS.lock} Close ticket #${pad(t.number)}?`, body, color: 'warn' })], components: confirmRows(sess) });
}

async function confirmClose(ctx) {
  const sess = ctx.argv[0];
  const s = ctx.engine.router.getSession(sess);
  if (!s || s.sid !== ctx.serverId) return ctx.warn('This button expired', 'Run `/ticket close` again.');
  const t = getTicket(ctx.engine, ctx.serverId, s.num);
  if (!t || t.status !== 'open') return ctx.info('Already closed', 'This ticket is already closed.');
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can close it.');
  if (s.userId !== ctx.userId) return notYourConfirm(ctx);
  ctx.engine.router.dropSession(sess);
  await ctx.update({ embeds: [card({ title: `${ICONS.lock} Closing ticket #${pad(t.number)}…`, body: 'Saving the transcript.', color: 'tickets' })], components: freeze(confirmRows(sess), ctx.source.custom_id) });
  const out = await closeTicket(ctx.engine, ctx.serverId, t, { by: ctx.userId, reason: s.reason });
  if (ctx.channelId !== t.channelId && !out.already) {
    return ctx.ok(`Ticket #${pad(t.number)} closed`, out.transcript ? 'The transcript went to the log channel.' : 'There was no channel left, so I cleaned up the role and marked it closed.');
  }
  return null;
}

async function claimCore(engine, sid, t, uid) {
  if (!(await isStaff(engine, sid, uid, t))) return { outcome: 'denied', ticket: t };
  let outcome = 'won';
  const updated = patchTicket(engine, sid, t.number, (x) => {
    if (x.status !== 'open') { outcome = 'closed'; return {}; }
    if (x.claimedBy) { outcome = x.claimedBy === uid ? 'mine' : 'taken'; return {}; }
    return { claimedBy: uid };
  });
  return { outcome: updated ? outcome : 'missing', ticket: updated };
}

async function unclaimCore(engine, sid, t, uid) {
  const staff = await isStaff(engine, sid, uid, t);
  if (staff && !t.claimedBy) return { outcome: 'unclaimed', ticket: t };
  if (!staff || (t.claimedBy !== uid && !(await isAdmin(engine, sid, uid)))) return { outcome: 'denied', ticket: t };
  const updated = patchTicket(engine, sid, t.number, { claimedBy: null });
  return { outcome: updated ? 'won' : 'missing', ticket: updated };
}

const claimNote = (uid) => `🙋 <@${uid}> claimed this ticket and will help you.`;
const unclaimNote = (uid) => `↩️ <@${uid}> unclaimed this ticket. Another staff member can pick it up.`;

async function claimTicket(ctx, t) {
  const { outcome, ticket: updated } = await claimCore(ctx.engine, ctx.serverId, t, ctx.userId);
  if (outcome === 'denied') return refuse(ctx, 'staff', 'Only staff can claim tickets. A staff member will be with you soon.');
  if (!updated || outcome === 'closed' || outcome === 'missing') return ctx.info('This ticket is closed', 'Open a new one with `/ticket` if you still need help.');
  if (outcome === 'mine') return ctx.info('Already yours', 'You have already claimed this ticket.');
  if (outcome === 'taken') return ctx.warn('Already claimed', `<@${updated.claimedBy}> is already handling this ticket.`);
  const note = claimNote(ctx.userId);
  if (ctx.kind === 'button' && ctx.source.message_id === updated.cardId) {
    await refreshCard(ctx, updated);
    return ctx.send(updated.channelId, note, { priority: 'normal' }).catch(() => null);
  }
  refreshCard(ctx, updated);
  return ctx.reply(note);
}

async function unclaimTicket(ctx, stale) {
  const t = getTicket(ctx.engine, ctx.serverId, stale.number) || stale;
  const { outcome, ticket: updated } = await unclaimCore(ctx.engine, ctx.serverId, t, ctx.userId);
  if (outcome === 'unclaimed') return ctx.info('Not claimed', 'Nobody has claimed this ticket yet.');
  if (outcome === 'denied') return refuse(ctx, 'admin', 'Only the person who claimed this ticket, or an admin, can unclaim it.');
  if (!updated) return ctx.info('This ticket is gone', "I couldn't find it any more.");
  const note = unclaimNote(ctx.userId);
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
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can add people.');
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
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can remove people.');
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
  if (!(await isStaff(ctx.engine, ctx.serverId, ctx.userId, t))) return refuse(ctx, 'staff', 'Only staff can rename tickets.');
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
  if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can get the transcript.');
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
  const t = getTicket(ctx.engine, ctx.serverId, Number(String(numText).replace(/^#/, '')));
  if (!(await isStaff(ctx.engine, ctx.serverId, ctx.userId, t))) return notTicket(ctx);
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
    { name: 'Auto-close when quiet', value: quietHours(cfg) ? `🟢 After ${hoursText(quietHours(cfg))} with no messages` : '⚪ Off', inline: true },
    { name: `Types (${types.length}/${MAX_TYPES})`, value: types.map((t) => `${formatTypeLine(t)}${t.staffRoles.length ? `\n-# Extra staff: ${roleList(t.staffRoles, 3)}` : ''}`).join('\n'), inline: false },
    { name: 'Open tickets and ratings', value: `${open} open · ${ratingSummary(engine, sid)}`, inline: true },
    { name: 'Features on this server', value: CAP_CHECKS.map((c) => capLine(engine, sid, c)).join('\n'), inline: false },
  ];
  const body = `${warnings.length ? `${warnings.join('\n')}\n\n` : ''}Members open a private channel with the staff. Each ticket gets its own role, so only the member, people they add, and staff can see it.\n-# Typed: \`/tickets panel #channel\`, \`/tickets staff @role\`, \`/tickets log #channel\`, \`/tickets limit 1\`, \`/tickets category name\`, \`/tickets type report staff @role\`, \`/tickets autoclose 48\`.`;
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
      row(
        button('Staff per type', cid('typestaff'), 'secondary', '🧑‍💼'),
        button('Auto-close', cid('edit', 'autoclose'), 'secondary', '💤'),
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

function categoryMissing(cats, text) {
  const names = cats.map((c) => c.name);
  const guess = didYouMean(text, names);
  return `${cats.length ? `Categories here: ${names.map((n) => `**${n}**`).join(', ')}.` : 'This server has no channel categories yet. Make one in Server settings, then try again.'}${guess.length ? `\nDid you mean **${guess[0]}**?` : ''}`;
}

async function setCategory(ctx, text) {
  if (!text || OFF_WORDS.test(text)) {
    ctx.patchConfig({ categoryId: null, categoryName: null });
    return ctx.ok('Category cleared', 'New tickets go at the top of the channel list.');
  }
  const cats = await ctx.bot.categories(ctx.serverId).catch(() => []) || [];
  const hit = cats.find((c) => c.id === text) || fuzzyFind(text, cats)?.item;
  if (!hit) return ctx.warn("I couldn't find that category", categoryMissing(cats, text));
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

const LIMIT_HELP = `Use a whole number from 1 to ${MAX_LIMIT}, like \`/tickets limit 1\`.`;

function checkLimit(text) {
  const n = Number(String(text || '').trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : null;
}

async function setLimit(ctx, text) {
  const n = checkLimit(text);
  if (n === null) return ctx.warn("That number didn't work", LIMIT_HELP);
  ctx.patchConfig({ limit: n });
  return ctx.ok('Limit saved', `Each person can have ${plural(n, 'open ticket')} at a time.`);
}

async function setAutoClose(ctx, text) {
  const raw = String(text || '').trim().toLowerCase();
  const cfg = ctx.config();
  if (!raw) {
    const hours = quietHours(cfg);
    return ctx.info('Auto-close', hours ? `Tickets close after ${hoursText(hours)} with no messages. I warn in the ticket first.\n-# Change it with \`/tickets autoclose 48\`, or \`/tickets autoclose off\`.` : 'Off. Turn it on with `/tickets autoclose 48` (hours, or like `2d`).');
  }
  if (OFF_WORDS.test(raw) || raw === '0') {
    ctx.patchConfig({ autoCloseHours: 0 });
    for (const t of allOpen(ctx.engine, ctx.serverId)) {
      cancelQuiet(ctx.engine, ctx.serverId, t.number);
      if (!t.quietWarn) continue;
      patchTicket(ctx.engine, ctx.serverId, t.number, { quietWarn: null });
      await calmWarning(ctx.engine, t, 'Auto-close was turned off, so this ticket stays open.');
    }
    return ctx.ok('Auto-close off', 'Quiet tickets stay open until someone closes them.');
  }
  const m = /^(\d{1,4})\s*(h|hr|hrs|hour|hours|d|day|days)?$/.exec(raw);
  const hours = m ? Number(m[1]) * (/^d/.test(m[2] || '') ? 24 : 1) : NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_AUTOCLOSE_HOURS) return ctx.warn("That didn't work", `Use a number of hours from 1 to ${MAX_AUTOCLOSE_HOURS}, like \`/tickets autoclose 48\` or \`/tickets autoclose 2d\`. Use \`off\` to turn it off.`);
  ctx.patchConfig({ autoCloseHours: hours });
  const n = rescheduleAllQuiet(ctx.engine, ctx.serverId);
  const lead = waitText(leadFor(hours));
  return ctx.ok('Auto-close on', `A ticket with no messages for ${hoursText(hours)} closes by itself, with the usual transcript. ${lead} before that I post a warning with a **Keep open** button.${n ? `\n-# Watching ${plural(n, 'open ticket')} now.` : ''}`);
}

function findType(cfg, word) {
  const types = typesOf(cfg);
  const w = normalizeName(word);
  if (!w) return null;
  return types.find((t) => t.id === w || normalizeName(t.name) === w) || types.find((t) => normalizeName(t.name).split('-')[0] === w) || null;
}

function typeStaffProblem(roles, sid) {
  if (roles.length > MAX_TYPE_STAFF) return { title: 'That is a lot of roles', body: `Each type can have up to ${MAX_TYPE_STAFF} extra staff roles.` };
  const auto = roles.find((r) => r.auto && r.auto !== 'none') || roles.find((r) => /^@?everyone$/i.test(r.name) || r.id === sid);
  if (auto) return { title: "That role can't be ticket staff", body: `**${auto.name}** is given to everyone automatically, so every member would see these tickets.` };
  return null;
}

async function setTypeStaff(ctx, typeId, tokens) {
  const cfg = ctx.config();
  const types = typesOf(cfg);
  const type = types.find((t) => t.id === typeId);
  if (!type) return ctx.warn('That type is gone', 'Open `/tickets` again to see the current types.');
  let roles = [];
  if (tokens.length && !OFF_WORDS.test(tokens[0])) {
    const missing = [];
    for (const tok of tokens) {
      const r = await ctx.findRole(tok);
      if (r) roles.push(r); else missing.push(tok);
    }
    if (missing.length) return ctx.warn("I couldn't find some roles", `No role matches ${missing.map((x) => `**${clip(x, 30)}**`).join(', ')}. Mention them, like @Helpers.`);
    roles = roles.filter((r, i) => roles.findIndex((x) => x.id === r.id) === i);
    const problem = typeStaffProblem(roles, ctx.serverId);
    if (problem) return ctx.warn(problem.title, problem.body);
  }
  const next = types.map((t) => (t.id === type.id ? { ...t, staffRoles: roles.map((r) => r.id) } : t));
  ctx.patchConfig({ types: next });
  if (!roles.length) return ctx.ok(`${type.name}: no extra staff`, `Only the main ticket staff see new **${type.name}** tickets.`);
  return ctx.ok(`${type.name}: staff saved`, `${roles.map((r) => `<@&${r.id}>`).join(' ')} can see, claim and close new **${type.emoji} ${type.name}** tickets, along with the main ticket staff.\n-# Tickets that are already open keep the people who could see them.`);
}

async function typeCommand(ctx, rest) {
  if (!rest.length) return typesForm(ctx);
  const cfg = ctx.config();
  const type = findType(cfg, rest[0]);
  if (!type) {
    const names = typesOf(cfg).map((t) => t.id);
    const guess = didYouMean(normalizeName(rest[0]), names);
    return ctx.warn("I couldn't find that type", `Types here: ${names.map((n) => `**${n}**`).join(', ')}.${guess.length ? `\nDid you mean **${guess[0]}**?` : ''}`);
  }
  const what = String(rest[1] || '').toLowerCase();
  if (!what) return ctx.info(`${type.emoji} ${type.name}`, `${type.questions.length ? `Questions: ${type.questions.join('; ')}` : 'No questions.'}\nExtra staff: ${type.staffRoles.length ? type.staffRoles.map((r) => `<@&${r}>`).join(' ') : 'none'}\n-# Set staff with \`/tickets type ${type.id} staff @role\`.`);
  if (!/^(staff|roles?|team|helpers)$/.test(what)) return ctx.warn("I didn't get that", `Try \`/tickets type ${type.id} staff @role\`, or \`/tickets type ${type.id} staff off\`.`);
  return setTypeStaff(ctx, type.id, rest.slice(2));
}

function typeStaffView(cfg) {
  const types = typesOf(cfg);
  const lines = types.map((t) => `${t.emoji} **${t.name}**: ${t.staffRoles.length ? t.staffRoles.map((r) => `<@&${r}>`).join(' ') : 'main staff only'}`);
  return {
    embeds: [card({ title: '🧑‍💼 Staff per ticket type', body: `${lines.join('\n')}\n\nExtra staff roles see, claim and close tickets of that type, on top of the main ticket staff.\n-# Pick a type to change it, or type \`/tickets type <type> staff @role\`.`, color: 'tickets' })],
    components: [...rows(types.map((t) => button(t.name, cid('tstaff', t.id), 'secondary', t.emoji))).slice(0, 1), row(button('Back', cid('home'), 'secondary', '⬅️'))],
  };
}

async function askTypeStaff(ctx) {
  const cfg = ctx.config();
  const type = typesOf(cfg).find((t) => t.id === ctx.argv[0]);
  if (!type) return ctx.warn('That type is gone', 'Open `/tickets` again to see the current types.');
  const roles = await ctx.roles().catch(() => []);
  const names = type.staffRoles.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean);
  rememberPending(ctx.engine, `tstaff:${ctx.serverId}:${ctx.userId}`, { typeId: type.id });
  return ctx.form({ title: `${type.name} staff`, action: 'savetstaff', fields: [{ id: 'value', label: 'Staff roles (names, space separated)', style: 'short', required: false, value: names.map((n) => (/\s/.test(n) ? `"${n}"` : n)).join(' '), placeholder: 'Helpers "Report Team", or "none"', max: 200 }] });
}

async function saveTypeStaff(ctx) {
  if (!(await adminGate(ctx))) return null;
  const p = takePending(ctx.engine, `tstaff:${ctx.serverId}:${ctx.userId}`);
  if (!p) return ctx.warn('This form expired', 'Press **Staff per type** again.');
  return setTypeStaff(ctx, p.typeId, tokenize(String(ctx.values?.value || '').trim()));
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
  if (!(await adminGate(ctx))) return null;
  const lines = Array.from({ length: MAX_TYPES }, (_, i) => ctx.values?.[`t${i + 1}`] || '');
  const parsed = parseTypes(lines);
  if (!parsed.length) return ctx.warn('I need at least one type', 'Write it like `🎫 Support` or `🚩 Report: Who are you reporting?; What happened?`.');
  const old = typesOf(ctx.config());
  const types = parsed.map((t) => ({ ...t, staffRoles: old.find((o) => o.id === t.id)?.staffRoles || [] }));
  ctx.patchConfig({ types });
  await refreshPostedPanel(ctx.engine, ctx.serverId);
  return ctx.ok('Ticket types saved', `${types.map((t) => `${formatTypeLine(t)}`).join('\n')}\n-# Up to ${MAX_QUESTIONS} questions each, split with ;`);
}

const EDIT_FORMS = lookup({
  staff: (cfg) => ({ title: 'Ticket staff roles', label: 'Staff roles (names, space separated)', value: '', placeholder: 'Moderator Helpers, or "default"' }),
  log: () => ({ title: 'Ticket log channel', label: 'Log channel name', value: '', placeholder: 'ticket-logs, or "off"' }),
  category: (cfg) => ({ title: 'Ticket category', label: 'Category name', value: cfg.categoryName || '', placeholder: 'Support, or "none"' }),
  limit: (cfg) => ({ title: 'Tickets per person', label: `Open tickets per person (1-${MAX_LIMIT})`, value: String(clampLimit(cfg.limit)), placeholder: '1' }),
  autoclose: (cfg) => ({ title: 'Auto-close quiet tickets', label: 'Hours with no messages, or "off"', value: quietHours(cfg) ? String(quietHours(cfg)) : '', placeholder: '48, 2d, or off' }),
});

async function saveEdit(ctx, what) {
  if (!(await adminGate(ctx))) return null;
  const text = String(ctx.values?.value || '').trim();
  if (what === 'staff') return setStaff(ctx, tokenize(text));
  if (what === 'log') return setLog(ctx, text);
  if (what === 'category') return setCategory(ctx, text);
  if (what === 'limit') return setLimit(ctx, text);
  if (what === 'autoclose') return setAutoClose(ctx, text || 'off');
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
    if (!(await adminGate(ctx))) return null;
    if (!first) return await ctx.ephemeral(await setupView(ctx));
    const sub = ADMIN_SUBS[first];
    if (!sub) {
      const guess = didYouMean(first, Object.keys(ADMIN_SUBS));
      return await ctx.warn("I didn't get that", `I don't know **${clip(first, 30)}**.${guess.length ? ` Did you mean ${guess.map((g) => `**${g}**`).join(', ')}?` : ''}\nTry \`/tickets\` on its own for the setup panel.`);
    }
    if (sub === 'home') return await ctx.ephemeral(await setupView(ctx));
    if (sub === 'panel') {
      if (!rest.length) return await askPanelChannel(ctx);
      const here = /^here$/i.test(rest[0]);
      const ch = here ? await channelHere(ctx) : await ctx.findChannel(rest.join(' '));
      if (!ch) return here ? await notHere(ctx) : await ctx.warn("I couldn't find that channel", 'Mention it, like `/tickets panel #support`.');
      return await postPanel(ctx, ch);
    }
    if (sub === 'category') return await setCategory(ctx, rest.join(' '));
    if (sub === 'staff') return await setStaff(ctx, rest);
    if (sub === 'log') return await setLog(ctx, rest[0]);
    if (sub === 'limit') return await setLimit(ctx, rest[0]);
    if (sub === 'types') return await typesForm(ctx);
    if (sub === 'type') return await typeCommand(ctx, rest);
    if (sub === 'autoclose') return await setAutoClose(ctx, rest.join(' '));
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
      if (staffOnly && !(await isStaff(ctx.engine, ctx.serverId, ctx.userId, t))) return refuse(ctx, 'staff', 'Only staff can do that.');
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

const ROLES_MISSING = (ids) => `No role matches ${ids.map((m) => `**${clip(m, 30)}**`).join(', ') || 'that'}. Mention them, like @Moderator.`;

async function rolesFrom(ctx, v) {
  const ids = idList(v);
  if (!ids) return { error: ROLES_MISSING([]) };
  const found = [];
  const missing = [];
  for (const id of ids) {
    const r = await roleById(ctx, id);
    if (r) found.push(r); else missing.push(id);
  }
  if (missing.length) return { error: ROLES_MISSING(missing) };
  return { roles: found.filter((r, i) => found.findIndex((x) => x.id === r.id) === i) };
}

const STATUS_FILTERS = { open: ['open', 'closing'], closed: ['closed'], all: ['open', 'closing', 'closed'] };

async function nameBook(engine, sid) {
  const members = await engine.cache.members(sid).catch(() => []);
  const byId = new Map(members.map((m) => [m.id, m]));
  return (uid) => {
    if (!uid) return null;
    if (uid === engine.bot.me?.id) return { id: uid, name: 'YapOS' };
    const m = byId.get(uid);
    return { id: uid, name: m ? (m.nickname || m.display_name || m.username || 'Someone') : 'Someone who left' };
  };
}

function ticketRow(cfg, t, who) {
  const type = typeById(cfg, t.typeId);
  return {
    number: t.number,
    status: t.status,
    name: t.name || `ticket-${pad(t.number)}`,
    topic: t.topic || null,
    type: type ? { id: type.id, name: type.name, emoji: type.emoji } : null,
    opener: who(t.openerId) || { id: null, name: 'Someone' },
    claimedBy: who(t.claimedBy),
    members: (t.members || []).length,
    createdAt: t.createdAt ?? null,
    closedAt: t.closedAt ?? null,
    lastActivityAt: t.lastActivityAt ?? null,
    rating: t.rating?.stars ?? null,
    channelId: t.status === 'closed' ? null : t.channelId ?? null,
  };
}

function ticketDetail(cfg, t, who) {
  return {
    ...ticketRow(cfg, t, who),
    answers: (t.answers || []).map((a) => ({ q: String(a.q ?? ''), a: String(a.a ?? '') })),
    reason: t.reason || null,
    closedBy: who(t.closedBy),
    people: uniq([t.openerId, ...(t.members || [])]).map(who),
  };
}

function ratingStats(tickets) {
  const rated = tickets.filter((t) => t.rating?.stars);
  if (!rated.length) return { average: null, count: 0 };
  const avg = rated.reduce((a, t) => a + t.rating.stars, 0) / rated.length;
  return { average: Math.round(avg * 10) / 10, count: rated.length };
}

const pageOf = (raw) => Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(raw)) || 1));

function matches(row, q) {
  if (!q) return true;
  const hay = [String(row.number), pad(row.number), row.name, row.topic, row.opener?.name, row.claimedBy?.name, row.type?.name].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function createTicketService(engine) {
  const cfg = (sid) => cfgOf(engine, sid);
  const live = new Map();

  function cachedLive(key) {
    const hit = live.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
    live.delete(key);
    return null;
  }

  function rememberLive(key, value) {
    live.delete(key);
    live.set(key, { at: Date.now(), value });
    while (live.size > MAX_LIVE) live.delete(live.keys().next().value);
  }

  async function list(sid, { status = 'open', q = '', page = 1 } = {}) {
    const all = Object.values(readData(engine, sid).tickets);
    const wanted = STATUS_FILTERS[status] || STATUS_FILTERS.open;
    const who = await nameBook(engine, sid);
    const c = cfg(sid);
    const needle = String(q || '').trim().slice(0, SEARCH_MAX).toLowerCase();
    const rows = all.filter((t) => wanted.includes(t.status)).sort((a, b) => b.number - a.number)
      .map((t) => ticketRow(c, t, who)).filter((r) => matches(r, needle));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const at = Math.min(pageOf(page), pages);
    return {
      tickets: rows.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE),
      total: rows.length,
      page: at,
      pages,
      pageSize: PAGE_SIZE,
      counts: { open: all.filter((t) => t.status !== 'closed').length, closed: all.filter((t) => t.status === 'closed').length },
      rating: ratingStats(all),
    };
  }

  async function get(sid, number) {
    const t = getTicket(engine, sid, number);
    if (!t) return null;
    return ticketDetail(cfg(sid), t, await nameBook(engine, sid));
  }

  async function transcript(sid, number) {
    const t = getTicket(engine, sid, number);
    if (!t) return null;
    if (t.status === 'closed') {
      const doc = t.hasTranscript ? storedTranscript(engine, sid, t.number) : null;
      return doc ? { text: doc.text, count: doc.count ?? 0, live: false } : null;
    }
    const key = `${sid}:${t.number}`;
    const hit = cachedLive(key);
    if (hit) return hit;
    const built = await buildTranscript(engine, sid, t, { maxPages: LIVE_PAGES });
    const value = { text: capTranscript(built.text), count: built.count, live: true };
    rememberLive(key, value);
    return value;
  }

  const answer = async (sid, number, ok, text) => ({ ok, message: text, ...(ok ? {} : { error: text }), ticket: await get(sid, number) });

  async function claim(sid, number, uid) {
    const t = getTicket(engine, sid, number);
    if (!t) return answer(sid, number, false, "I couldn't find that ticket.");
    const { outcome, ticket: updated } = await claimCore(engine, sid, t, uid);
    if (outcome === 'denied') return answer(sid, number, false, 'Only staff can claim tickets.');
    if (outcome === 'closed' || outcome === 'missing') return answer(sid, number, false, 'This ticket is closed.');
    if (outcome === 'mine') return answer(sid, number, true, 'You already claimed this ticket.');
    if (outcome === 'taken') {
      const name = (await nameBook(engine, sid))(updated.claimedBy)?.name || 'Someone';
      return answer(sid, number, false, `${name} is already handling this ticket.`);
    }
    await editCard(engine, sid, updated);
    await engine.budget.send({ serverId: sid, channelId: updated.channelId, content: claimNote(uid), priority: 'normal' }).catch(() => null);
    return answer(sid, number, true, `You claimed ticket #${pad(updated.number)}.`);
  }

  async function unclaim(sid, number, uid) {
    const t = getTicket(engine, sid, number);
    if (!t) return answer(sid, number, false, "I couldn't find that ticket.");
    if (t.status !== 'open') return answer(sid, number, false, 'This ticket is closed.');
    const { outcome, ticket: updated } = await unclaimCore(engine, sid, t, uid);
    if (outcome === 'unclaimed') return answer(sid, number, false, 'Nobody has claimed this ticket yet.');
    if (outcome === 'denied') return answer(sid, number, false, 'Only the person who claimed this ticket, or an admin, can unclaim it.');
    if (!updated) return answer(sid, number, false, "I couldn't find that ticket.");
    await editCard(engine, sid, updated);
    await engine.budget.send({ serverId: sid, channelId: updated.channelId, content: unclaimNote(uid), priority: 'normal' }).catch(() => null);
    return answer(sid, number, true, `You unclaimed ticket #${pad(updated.number)}. Another staff member can pick it up.`);
  }

  async function close(sid, number, { by = null, reason = '' } = {}) {
    const t = getTicket(engine, sid, number);
    if (!t) return answer(sid, number, false, "I couldn't find that ticket.");
    if (t.status !== 'open') return answer(sid, number, false, t.status === 'closing' ? 'This ticket is already closing.' : 'This ticket is already closed.');
    if (t.openerId !== by && !(await isStaff(engine, sid, by, t))) return answer(sid, number, false, 'Only staff or the person who opened this ticket can close it.');
    const out = await closeTicket(engine, sid, t, { by, reason: clip(String(reason || ''), 500) });
    if (out.already) return answer(sid, number, false, 'This ticket is already closed.');
    const where = out.logged ? 'The transcript went to the log channel.'
      : out.transcript ? 'No log channel is set, so the transcript is only kept here.'
        : 'There was no channel left, so I cleaned up and marked it closed.';
    return answer(sid, number, true, `Closed ticket #${pad(t.number)}. ${where}`);
  }

  return { list, get, transcript, claim, unclaim, close };
}

const DASHBOARD = [
  {
    key: 'staffRoles', label: 'Ticket staff roles', type: 'roles', web: true,
    help: 'Roles that see and handle every new ticket. Empty means anyone who is a mod or admin.',
    validate: async (ctx, v) => {
      const r = await rolesFrom(ctx, v);
      return r.error ? reject(r.error) : accept(uniq(r.roles.map((x) => x.id)));
    },
  },
  {
    key: 'logChannelId', label: 'Ticket log channel', type: 'channel', web: true,
    help: 'Where transcripts, close summaries and ratings go. Empty uses the server log channel.',
    validate: async (ctx, v) => {
      if (isBlank(v) || (typeof v === 'string' && OFF_WORDS.test(v.trim()))) return accept(null);
      const ch = await channelById(ctx, v);
      return ch ? accept(ch.id) : reject('Mention it, like `/tickets log #ticket-logs`.');
    },
  },
  {
    key: 'categoryId', label: 'Ticket category', type: 'category', web: true,
    help: 'The channel category new tickets go in. Empty puts them at the top of the channel list.',
    validate: async (ctx, v) => {
      if (isBlank(v) || (typeof v === 'string' && OFF_WORDS.test(v.trim()))) return accept(null);
      const cats = await ctx.bot.categories(ctx.serverId).catch(() => []) || [];
      const id = safeId(v);
      const hit = id ? cats.find((c) => c.id === id) : null;
      return hit ? accept(hit.id) : reject(categoryMissing(cats, String(v)));
    },
    save: async (ctx, value) => {
      if (!value) { ctx.patchConfig({ categoryId: null, categoryName: null }); return { applied: { categoryId: null, categoryName: null } }; }
      const cats = await ctx.bot.categories(ctx.serverId).catch(() => []) || [];
      const hit = cats.find((c) => c.id === value);
      if (!hit) return { error: categoryMissing(cats, value) };
      ctx.patchConfig({ categoryId: hit.id, categoryName: hit.name });
      return { applied: { categoryId: hit.id, categoryName: hit.name } };
    },
  },
  { key: 'categoryName', label: 'Ticket category name', type: 'string', web: false, help: 'Shown in the panel.', note: 'Set together with the ticket category.' },
  {
    key: 'limit', label: 'Open tickets per person', type: 'number', web: true, min: 1, max: MAX_LIMIT, step: 1,
    help: 'How many open tickets one person can have at a time.',
    validate: (ctx, v) => {
      const n = checkLimit(v);
      return n === null ? reject(LIMIT_HELP) : accept(n);
    },
  },
  boolField({ key: 'pingStaff', label: 'Ping staff on new tickets', help: 'New tickets mention the staff roles.' }),
  { key: 'autoCloseHours', label: 'Auto-close quiet tickets after (hours)', type: 'number', web: false, min: 0, max: MAX_AUTOCLOSE_HOURS, help: '0 keeps quiet tickets open.', note: 'Change it in the server with /tickets autoclose 48, so open tickets get rescheduled.' },
  { key: 'types', label: 'Ticket types', type: 'complex', web: false, help: 'The kinds of tickets people can open, with their questions.', note: 'Edit them in the server with /tickets types, which also updates the posted panel.' },
  {
    key: 'typeStaff', label: 'Extra staff per type', type: 'complex', web: true, editor: 'roleMap',
    labels: (cfg) => Object.fromEntries(typesOf(cfg).map((t) => [t.id, `${t.emoji} ${t.name}`])),
    help: 'Extra roles that see new tickets of one type, on top of the main ticket staff.',
    read: (cfg) => Object.fromEntries(typesOf(cfg).map((t) => [t.id, t.staffRoles])),
    validate: async (ctx, v) => {
      if (!plainObject(v)) return reject('Pick roles for each ticket type.');
      const types = typesOf(ctx.config());
      const out = {};
      for (const [typeId, list] of Object.entries(v)) {
        if (!types.some((t) => t.id === typeId)) return reject('Open `/tickets` again to see the current types.');
        const r = await rolesFrom(ctx, list);
        if (r.error) return reject(r.error);
        const problem = typeStaffProblem(r.roles, ctx.serverId);
        if (problem) return reject(problem.body);
        out[typeId] = r.roles.map((x) => x.id);
      }
      return accept(out);
    },
    save: (ctx, value) => {
      const next = typesOf(ctx.config()).map((t) => (Object.hasOwn(value, t.id) ? { ...t, staffRoles: value[t.id] } : t));
      ctx.patchConfig({ types: next });
      return { applied: { typeStaff: Object.fromEntries(next.map((t) => [t.id, t.staffRoles])) } };
    },
  },
  { key: 'panelChannelId', label: 'Open-ticket panel channel', type: 'channel', web: false, help: 'Where the Open a ticket panel is posted.', note: 'Post the panel in the server with /tickets panel #channel.' },
  { key: 'panelMessageId', label: 'Open-ticket panel message', type: 'string', web: false, help: 'The posted panel message.', note: 'Set when the panel is posted with /tickets panel #channel.' },
];

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
    autoCloseHours: 0,
  },

  dashboard: DASHBOARD,

  services: (engine) => createTicketService(engine),

  jobs: {
    quietwarn: quietWarnJob,
    quietclose: quietCloseJob,
  },

  events: {
    message: onTicketMessage,
  },

  panelPerm: 'member',

  commands: {
    ticket: { description: 'Open a support ticket: /ticket [topic]. Inside one: /ticket close, claim, add @user, rename', run: (ctx) => runTicket(ctx) },
    tickets: { description: 'Ticket setup (admins): /tickets panel #channel, staff @role, log #channel, types, limit 1', perm: 'admin', run: (ctx) => runTickets(ctx) },
  },

  components: {
    ...guarded({
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
        if (!s || s.sid !== ctx.serverId) return ctx.warn('This button expired', 'Nothing was closed. Run `/ticket close` again if you still want to.');
        const t = getTicket(ctx.engine, ctx.serverId, s.num);
        if (t && !(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can decide.');
        if (s.userId !== ctx.userId) return notYourConfirm(ctx);
        ctx.engine.router.dropSession(ctx.argv[0]);
        return ctx.update({ embeds: [card({ title: `${ICONS.tickets} Ticket stays open`, body: 'Nothing was closed.', color: 'tickets' })], components: freeze(confirmRows(ctx.argv[0]), ctx.source.custom_id) });
      },
    },
    addp: ticketComponent(async (ctx, t) => {
      if (!(await canManage(ctx, t))) return refuse(ctx, 'staff', 'Only staff or the person who opened this ticket can add people.');
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

    home: adminOnly(async (ctx) => ctx.ephemeral(await setupView(ctx))),
    postpanel: adminOnly((ctx) => askPanelChannel(ctx)),
    panelhere: adminOnly(async (ctx) => {
      const ch = await channelHere(ctx);
      return ch ? postPanel(ctx, ch) : notHere(ctx);
    }),
    panelto: adminOnly(async (ctx) => {
      const ch = await ctx.findChannel(ctx.argv[0]);
      if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the setup again with `/tickets`.');
      return postPanel(ctx, ch);
    }),
    panelpick: adminOnly(async (ctx) => {
      const ch = await ctx.findChannel(ctx.values?.[0]);
      if (!ch) return ctx.warn("I can't find that channel", 'It may have been deleted. Open the setup again with `/tickets`.');
      return postPanel(ctx, ch);
    }),
    types: adminOnly((ctx) => typesForm(ctx)),
    savetypes: { perm: 'admin', run: saveTypes },
    edit: {
      perm: 'admin',
      run: async (ctx) => {
        if (!(await adminGate(ctx))) return null;
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
    ping: adminOnly(async (ctx) => {
      ctx.patchConfig({ pingStaff: !ctx.config().pingStaff });
      return ctx.update(await setupView(ctx));
    }),
    tidy: adminOnly((ctx) => tidyUp(ctx)),
    typestaff: adminOnly(async (ctx) => ctx.ephemeral(typeStaffView(ctx.config()))),
    tstaff: adminOnly((ctx) => askTypeStaff(ctx)),
    savetstaff: { perm: 'admin', run: saveTypeStaff },
    saveautoclose: { perm: 'admin', run: (ctx) => saveEdit(ctx, 'autoclose') },
    keepopen: ticketComponent(keepOpen),
    }),
    rate: { run: rateTicket },
    ratenote: { run: askComment },
    ratesave: { run: saveComment },
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
    'After closing, the member gets a DM asking for a 1 to 5 star rating (and an optional comment); it shows up in the ticket log.',
    'Each type can have its own extra staff: /tickets type report staff @role.',
    '/tickets autoclose 48 closes tickets after 48 quiet hours, with a warning and a Keep open button first.',
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
    r.seen.clear();
    r.touched.clear();
    r.channels.clear();
  },
});
