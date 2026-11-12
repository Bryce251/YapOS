import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from '../engine/sdk.js';
import { createEngine } from '../engine/index.js';
import { createMemoryStore } from '../engine/storage.js';
import { createLogger } from '../engine/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APPS_DIR = path.resolve(HERE, '..', 'apps');

let uuidSeq = 0;
export const uuid = (tag = 0) => {
  const n = (++uuidSeq).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8${String(tag).padStart(3, '0').slice(-3)}-${n}`;
};

export const IDS = {
  server: '5e000000-0000-4000-8000-000000000001',
  bot: 'b0000000-0000-4000-8000-000000000001',
  owner: 'a0000000-0000-4000-8000-000000000001',
  admin: 'a0000000-0000-4000-8000-000000000002',
  mod: 'a0000000-0000-4000-8000-000000000003',
  member: 'a0000000-0000-4000-8000-000000000004',
  member2: 'a0000000-0000-4000-8000-000000000005',
  admin2: 'a0000000-0000-4000-8000-000000000006',
  roles: {
    admin: 'r0000000-0000-4000-8000-000000000007',
    bot: 'r0000000-0000-4000-8000-000000000006',
    mod: 'r0000000-0000-4000-8000-000000000004',
    vip: 'r0000000-0000-4000-8000-000000000003',
    member: 'r0000000-0000-4000-8000-000000000001',
    gamer: 'r0000000-0000-4000-8000-000000000002',
    top: 'r0000000-0000-4000-8000-000000000009',
  },
  channels: {
    general: 'c0000000-0000-4000-8000-000000000001',
    welcome: 'c0000000-0000-4000-8000-000000000002',
    rules: 'c0000000-0000-4000-8000-000000000003',
    modlog: 'c0000000-0000-4000-8000-000000000004',
    roles: 'c0000000-0000-4000-8000-000000000005',
    news: 'c0000000-0000-4000-8000-000000000006',
    voice: 'c0000000-0000-4000-8000-000000000007',
  },
};

const httpError = (status, error, retryAfter) => {
  const e = new Error(error);
  e.status = status;
  if (retryAfter) e.retryAfter = retryAfter;
  return e;
};

export function createFakeYapin() {
  const R = IDS.roles;
  const C = IDS.channels;
  const state = {
    servers: {
      [IDS.server]: { id: IDS.server, name: 'Test Town', icon_path: null, owner_id: IDS.owner, member_count: 5, online_count: 3 },
    },
    roles: {
      [IDS.server]: [
        { id: R.top, name: 'Founders', color: '#ffffff', position: 9, perms: { administrator: true }, auto: null, mentionable: false },
        { id: R.admin, name: 'Admin', color: '#ff0000', position: 7, perms: { administrator: true }, auto: null, mentionable: false },
        { id: R.bot, name: 'YapOS', color: '#7c5cff', position: 6, perms: { manage_roles: true, manage_channels: true, kick_members: true, ban_members: true, timeout_members: true, manage_messages: true, manage_server: true, manage_webhooks: true, send_messages: true, embed_links: true, read_history: true, move_members: true }, auto: null, mentionable: false },
        { id: R.mod, name: 'Moderator', color: '#00ff00', position: 4, perms: { kick_members: true, timeout_members: true, manage_messages: true }, auto: null, mentionable: true },
        { id: R.vip, name: 'VIP', color: '#ffd700', position: 3, perms: {}, auto: null, mentionable: false },
        { id: R.gamer, name: 'Gamer', color: '#3498db', position: 2, perms: {}, auto: null, mentionable: true },
        { id: R.member, name: 'Member', color: null, position: 1, perms: { send_messages: true }, auto: null, mentionable: false },
      ],
    },
    members: {
      [IDS.server]: [
        { id: IDS.owner, username: 'jolli', display_name: 'Jolli', nickname: null, roles: [R.top], joined_at: '2026-01-01T00:00:00Z' },
        { id: IDS.bot, username: 'yapos', display_name: 'YapOS', nickname: null, roles: [R.bot], joined_at: '2026-01-02T00:00:00Z' },
        { id: IDS.admin, username: 'alex', display_name: 'Alex', nickname: null, roles: [R.admin, R.member], joined_at: '2026-01-03T00:00:00Z' },
        { id: IDS.mod, username: 'morgan', display_name: 'Morgan', nickname: 'Mo', roles: [R.mod, R.member], joined_at: '2026-01-04T00:00:00Z' },
        { id: IDS.member, username: 'sam', display_name: 'Sam', nickname: null, roles: [R.member], joined_at: '2026-01-05T00:00:00Z' },
        { id: IDS.member2, username: 'riley', display_name: 'Riley', nickname: null, roles: [R.member], joined_at: '2026-01-06T00:00:00Z' },
      ],
    },
    channels: {
      [IDS.server]: [
        { id: C.rules, name: '📜┃rules', type: 'text', kind: 'text', server_id: IDS.server, position: 0, category: null, category_id: null, private: false, read_only: true, slowmode: 0 },
        { id: C.welcome, name: '👋・welcome', type: 'text', kind: 'text', server_id: IDS.server, position: 1, category: null, category_id: null, private: false, read_only: false, slowmode: 0 },
        { id: C.general, name: 'general', type: 'text', kind: 'text', server_id: IDS.server, position: 2, category: null, category_id: null, private: false, read_only: false, slowmode: 0 },
        { id: C.roles, name: 'get-roles', type: 'text', kind: 'text', server_id: IDS.server, position: 3, category: null, category_id: null, private: false, read_only: false, slowmode: 0 },
        { id: C.news, name: 'announcements', type: 'text', kind: 'text', server_id: IDS.server, position: 4, category: null, category_id: null, private: false, read_only: false, slowmode: 0 },
        { id: C.modlog, name: 'mod-log', type: 'text', kind: 'text', server_id: IDS.server, position: 5, category: null, category_id: null, private: true, read_only: false, slowmode: 0 },
        { id: C.voice, name: 'Lounge', type: 'voice', kind: 'voice', server_id: IDS.server, position: 6, category: null, category_id: null, private: false, read_only: false, slowmode: 0 },
      ],
    },
    messages: {},
    bans: { [IDS.server]: [] },
    timeouts: {},
    overrides: {},
    everyone: { [IDS.server]: { send_messages: true, view_channel: true } },
    pins: new Set(),
    reactions: [],
    dms: {},
    webhooks: [],
    voice: {},
  };

  const calls = [];
  const answers = [];
  const failures = [];
  const features = { selects: true, modals: true, files: true, dms: true, roles: true, v2: true, emojis: true, webhooks: true };
  let msgSeq = 0;
  const clock = { t: Date.parse('2026-11-07T12:00:00Z') };

  const userIds = () => new Set(Object.values(state.members).flat().map((m) => m.id));
  const memberOf = (sid, uid) => state.members[sid]?.find((m) => m.id === uid) || null;
  const channelById = (cid) => Object.values(state.channels).flat().find((c) => c.id === cid) || null;
  const serverOfChannel = (cid) => channelById(cid)?.server_id || null;

  const checkComponents = (components, flags) => {
    const walk = (c) => {
      if (!c) return;
      if ((c.type === 'select' || c.type === 3) && !features.selects) throw httpError(400, 'Select menus are in testing (flag bot_selects)');
      if ((c.type === 17 || c.type === 10 || c.type === 9) && !features.v2) throw httpError(400, 'Unknown component type (Components V2 is not enabled here)');
      for (const k of ['components']) if (Array.isArray(c[k])) c[k].forEach(walk);
      if (c.accessory) walk(c.accessory);
    };
    (components || []).forEach(walk);
    if (flags === 32768 && !features.v2) throw httpError(400, 'Components V2 is not enabled here');
    const ids = new Set();
    const collect = (c) => {
      if (!c) return;
      if (c.custom_id) {
        if (String(c.custom_id).length > 100) throw httpError(400, 'custom_id longer than 100 characters');
        if (ids.has(c.custom_id)) throw httpError(400, `Duplicate custom_id ${c.custom_id}`);
        ids.add(c.custom_id);
      }
      (c.components || []).forEach(collect);
      if (c.accessory) collect(c.accessory);
    };
    (components || []).forEach(collect);
    if ((components || []).length > 5 && flags !== 32768) throw httpError(400, 'Up to 5 rows of components');
  };

  const createMessage = (cid, body) => {
    const content = String(body.content ?? '');
    if (content.length > 2000) throw httpError(400, 'Content over 2000 characters');
    if (!content && !(body.embeds || []).length && !(body.components || []).length && !body.sticker_id && !(body._files || []).length) throw httpError(400, 'Empty message');
    if ((body.embeds || []).length > 5) throw httpError(400, 'Up to 5 embeds');
    checkComponents(body.components, body.flags);
    const m = { id: uuid(9), channel_id: cid, author_id: IDS.bot, content, embeds: body.embeds || null, components: body.components || null, flags: body.flags || 0, reply_to_id: body.reply_to || null, created_at: new Date(clock.t + msgSeq++).toISOString(), edited_at: null, deleted: false, files: body._files || null, attachment_name: body._files?.[0]?.name ?? null };
    (state.messages[cid] ||= []).push(m);
    return m;
  };

  const routes = [
    ['GET', /^\/me$/, () => ({ id: IDS.bot, username: 'yapos', display_name: 'YapOS', bot: { name: 'YapOS', public: false, owner_id: IDS.owner } })],
    ['PUT', /^\/commands$/, (m, b) => ({ commands: b.commands })],
    ['GET', /^\/events\?/, () => ({ events: [], last: 0 })],
    ['GET', /^\/servers$/, () => ({ servers: Object.values(state.servers) })],
    ['GET', /^\/servers\/([^/]+)$/, ([sid]) => { const s = state.servers[sid]; if (!s) throw httpError(404, 'Not found'); return { server: s }; }],
    ['GET', /^\/servers\/([^/]+)\/counts$/, ([sid]) => ({ server_id: sid, member_count: state.members[sid].length, online_count: 3 })],
    ['GET', /^\/servers\/([^/]+)\/roles$/, ([sid]) => ({ roles: [...state.roles[sid]].sort((a, b) => b.position - a.position) })],
    ['POST', /^\/servers\/([^/]+)\/roles$/, ([sid], b) => {
      if (!features.roles) throw httpError(403, 'Role management is in testing (flag bot_roles)');
      const role = { id: uuid(7), name: b.name || 'new role', color: b.color || null, position: 5, perms: b.permissions || {}, auto: null, mentionable: !!b.mentionable };
      state.roles[sid].push(role);
      return { role };
    }],
    ['PATCH', /^\/servers\/([^/]+)\/roles\/everyone$/, ([sid], b) => { Object.assign(state.everyone[sid], b.permissions || {}); return { ok: true }; }],
    ['PATCH', /^\/servers\/([^/]+)\/roles\/([^/]+)$/, ([sid, rid], b) => { const r = state.roles[sid].find((x) => x.id === rid); if (!r) throw httpError(404, 'No such role'); Object.assign(r, Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined))); return { role: r }; }],
    ['DELETE', /^\/servers\/([^/]+)\/roles\/([^/]+)$/, ([sid, rid]) => { state.roles[sid] = state.roles[sid].filter((r) => r.id !== rid); return { ok: true }; }],
    ['GET', /^\/servers\/([^/]+)\/members\?/, ([sid], b, q) => {
      const all = [...state.members[sid]].sort((a, b2) => a.id.localeCompare(b2.id));
      const after = q.get('after');
      const start = after ? all.findIndex((m) => m.id === after) + 1 : 0;
      return { members: all.slice(start, start + Number(q.get('limit') || 200)) };
    }],
    ['GET', /^\/servers\/([^/]+)\/members\/([^/]+)$/, ([sid, uid]) => { const m = memberOf(sid, uid); if (!m) throw httpError(404, 'Not a member'); return { member: { ...m, timeout: state.timeouts[`${sid}:${uid}`] || null } }; }],
    ['PATCH', /^\/servers\/([^/]+)\/members\/([^/]+)$/, ([sid, uid], b) => { const m = memberOf(sid, uid); if (!m) throw httpError(404, 'Not a member'); m.nickname = b.nickname || null; return { ok: true }; }],
    ['PUT', /^\/servers\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/, ([sid, uid, rid]) => {
      const m = memberOf(sid, uid); if (!m) throw httpError(404, 'Not a member');
      const role = state.roles[sid].find((r) => r.id === rid); if (!role) throw httpError(404, 'No such role');
      if (role.position >= 6) throw httpError(403, "Missing permission: that role is above the bot's highest role");
      if (!m.roles.includes(rid)) m.roles.push(rid);
      return { ok: true };
    }],
    ['DELETE', /^\/servers\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/, ([sid, uid, rid]) => { const m = memberOf(sid, uid); if (m) m.roles = m.roles.filter((r) => r !== rid); return { ok: true }; }],
    ['POST', /^\/servers\/([^/]+)\/kick$/, ([sid], b) => { state.members[sid] = state.members[sid].filter((m) => m.id !== b.user_id); return { ok: true }; }],
    ['POST', /^\/servers\/([^/]+)\/bans$/, ([sid], b) => { state.bans[sid].push({ user_id: b.user_id, banned_by: IDS.bot, created_at: new Date(clock.t).toISOString(), user: null }); state.members[sid] = state.members[sid].filter((m) => m.id !== b.user_id); return { ok: true }; }],
    ['GET', /^\/servers\/([^/]+)\/bans$/, ([sid]) => ({ bans: state.bans[sid] })],
    ['DELETE', /^\/servers\/([^/]+)\/bans\/([^/]+)$/, ([sid, uid]) => { state.bans[sid] = state.bans[sid].filter((x) => x.user_id !== uid); return { ok: true }; }],
    ['POST', /^\/servers\/([^/]+)\/timeouts$/, ([sid], b) => {
      if (b.minutes > 40320) throw httpError(400, 'Timeouts are up to 40320 minutes');
      if (b.minutes === 0) delete state.timeouts[`${sid}:${b.user_id}`];
      else state.timeouts[`${sid}:${b.user_id}`] = { minutes: b.minutes, reason: b.reason, until: new Date(clock.t + b.minutes * 60000).toISOString() };
      return { ok: true };
    }],
    ['GET', /^\/servers\/([^/]+)\/channels(\?.*)?$/, ([sid], b, q) => {
      const t = q.get('type');
      return { channels: state.channels[sid].filter((c) => !t || c.type === t), categories: [] };
    }],
    ['GET', /^\/channels(\?.*)?$/, (m, b, q) => ({ channels: Object.values(state.channels).flat().filter((c) => !q.get('type') || c.type === q.get('type')) })],
    ['POST', /^\/servers\/([^/]+)\/channels$/, ([sid], b) => { const c = { id: uuid(5), name: b.name, type: b.kind || 'text', kind: b.kind || 'text', server_id: sid, position: 99, category: null, category_id: b.category_id || null, private: false, read_only: false, slowmode: 0 }; state.channels[sid].push(c); return { channel: c }; }],
    ['GET', /^\/channels\/([^/]+)$/, ([cid]) => { const c = channelById(cid); if (!c) throw httpError(404, 'No such channel'); return { channel: c }; }],
    ['PATCH', /^\/channels\/([^/]+)$/, ([cid], b) => {
      const c = channelById(cid); if (!c) throw httpError(404, 'No such channel');
      if (b.slowmode !== undefined && (b.slowmode < 0 || b.slowmode > 21600)) throw httpError(400, 'slowmode is 0 to 21600 seconds');
      for (const [k, v] of Object.entries(b)) if (v !== undefined) c[k] = v;
      return { channel: c };
    }],
    ['DELETE', /^\/channels\/([^/]+)$/, ([cid]) => { for (const sid of Object.keys(state.channels)) state.channels[sid] = state.channels[sid].filter((c) => c.id !== cid); return { ok: true }; }],
    ['GET', /^\/channels\/([^/]+)\/permissions$/, ([cid]) => ({ overrides: Object.entries(state.overrides).filter(([k]) => k.startsWith(`${cid}:`)).map(([k, v]) => ({ role_id: k.split(':')[1] === 'everyone' ? null : k.split(':')[1], ...v })) })],
    ['PUT', /^\/channels\/([^/]+)\/permissions\/([^/]+)$/, ([cid, rid], b) => {
      if (!features.roles) throw httpError(403, 'Permission overrides are in testing (flag bot_roles)');
      if (!b.allow?.length && !b.deny?.length) delete state.overrides[`${cid}:${rid}`];
      else state.overrides[`${cid}:${rid}`] = { allow: b.allow || [], deny: b.deny || [] };
      return { ok: true };
    }],
    ['DELETE', /^\/channels\/([^/]+)\/permissions\/([^/]+)$/, ([cid, rid]) => { delete state.overrides[`${cid}:${rid}`]; return { ok: true }; }],
    ['GET', /^\/channels\/([^/]+)\/messages\?/, ([cid], b, q) => {
      let list = (state.messages[cid] || []).filter((m) => !m.deleted);
      const limit = Math.min(100, Number(q.get('limit') || 50));
      if (q.get('before')) list = list.filter((m) => m.created_at < q.get('before'));
      const msgs = q.get('after') ? list.filter((m) => m.created_at > q.get('after')).slice(0, limit) : list.slice(-limit);
      const authors = [...new Set(msgs.map((m) => m.author_id))].map((id) => { const mm = Object.values(state.members).flat().find((x) => x.id === id); return mm ? { id, username: mm.username, display_name: mm.display_name } : { id, username: 'unknown' }; });
      return { messages: msgs, authors };
    }],
    ['POST', /^\/channels\/([^/]+)\/messages$/, ([cid], b) => {
      if (!channelById(cid) && !state.dms[cid]) throw httpError(404, 'No such channel');
      return { message: createMessage(cid, b) };
    }],
    ['POST', /^\/channels\/([^/]+)\/messages\/bulk-delete$/, ([cid], b) => {
      if ((b.ids || []).length > 100) throw httpError(400, 'Up to 100 ids');
      const deleted = []; const skipped = [];
      for (const id of b.ids || []) { const m = (state.messages[cid] || []).find((x) => x.id === id && !x.deleted); if (m) { m.deleted = true; deleted.push(id); } else skipped.push(id); }
      return { deleted, skipped };
    }],
    ['GET', /^\/channels\/([^/]+)\/messages\/([^/]+)$/, ([cid, mid]) => { const m = (state.messages[cid] || []).find((x) => x.id === mid && !x.deleted); if (!m) throw httpError(404, 'No such message'); return { message: m, author: null }; }],
    ['PATCH', /^\/channels\/([^/]+)\/messages\/([^/]+)$/, ([cid, mid], b) => {
      const m = (state.messages[cid] || []).find((x) => x.id === mid && !x.deleted); if (!m) throw httpError(404, 'No such message');
      if (m.author_id !== IDS.bot) throw httpError(403, "Can only edit the bot's own messages");
      checkComponents(b.components, b.flags ?? m.flags);
      for (const k of ['content', 'embeds', 'components']) if (b[k] !== undefined) m[k] = b[k];
      m.edited_at = new Date(clock.t).toISOString();
      return { message: m };
    }],
    ['DELETE', /^\/channels\/([^/]+)\/messages\/([^/]+)$/, ([cid, mid]) => { const m = (state.messages[cid] || []).find((x) => x.id === mid && !x.deleted); if (!m) throw httpError(404, 'No such message'); m.deleted = true; return { ok: true }; }],
    ['PUT', /^\/channels\/([^/]+)\/messages\/([^/]+)\/pin$/, ([cid, mid]) => { state.pins.add(mid); return { ok: true }; }],
    ['DELETE', /^\/channels\/([^/]+)\/messages\/([^/]+)\/pin$/, ([cid, mid]) => { state.pins.delete(mid); return { ok: true }; }],
    ['PUT', /^\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/(.+)$/, ([cid, mid, emoji]) => { state.reactions.push({ channel_id: cid, message_id: mid, emoji: decodeURIComponent(emoji), user_id: IDS.bot }); return { ok: true }; }],
    ['DELETE', /^\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/(.+)$/, ([cid, mid, emoji]) => { state.reactions = state.reactions.filter((r) => !(r.message_id === mid && r.emoji === decodeURIComponent(emoji))); return { ok: true }; }],
    ['POST', /^\/users\/([^/]+)\/dm$/, ([uid]) => { if (!features.dms) throw httpError(403, 'DMs are in testing'); const cid = `d${uid.slice(1)}`; state.dms[cid] = uid; return { channel_id: cid }; }],
    ['GET', /^\/users\/([^/]+)$/, ([uid]) => { const m = Object.values(state.members).flat().find((x) => x.id === uid); if (!m) throw httpError(404, 'No such user'); return { user: { id: m.id, username: m.username, display_name: m.display_name, avatar_path: null, badges: [] } }; }],
    ['POST', /^\/interactions\/([^/]+)\/([^/]+)\/callback$/, ([iid, token], b) => {
      const prior = answers.filter((a) => a.interactionId === iid);
      if (prior.length >= 10) throw httpError(429, 'More than 10 answers to one interaction');
      if (b.type === 'modal') {
        if (!features.modals) throw httpError(400, 'Modals are in testing (flag bot_modals)');
        if (prior.length) throw httpError(400, 'A modal has to be the first answer');
      }
      if (b.type === 'ephemeral' && b.flags === 32768) throw httpError(400, "Ephemeral replies can't be Components V2 yet");
      if (b.type === 'ephemeral' && Array.isArray(b.components) && b.components.length) throw httpError(400, "Ephemeral replies can't have buttons (yet)");
      checkComponents(b.components, b.flags);
      const a = { interactionId: iid, token, ...b, at: clock.t };
      answers.push(a);
      let message = null;
      if (b.type === 'reply') {
        const ev = pendingInteractions.get(iid);
        message = createMessage(ev?.channel_id || C.general, { content: b.content ?? '', embeds: b.embeds, components: b.components, flags: b.flags });
        a.message = message;
      }
      if (b.type === 'update') {
        const ev = pendingInteractions.get(iid);
        const m = ev?.message_id && (state.messages[ev.channel_id] || []).find((x) => x.id === ev.message_id);
        if (m) for (const k of ['content', 'embeds', 'components']) if (b[k] !== undefined) m[k] = b[k];
      }
      return { ok: true, message };
    }],
    ['GET', /^\/servers\/([^/]+)\/voice$/, ([sid]) => ({ voice: state.channels[sid].filter((c) => c.type === 'voice').map((c) => ({ channel_id: c.id, user_ids: [...(state.voice[c.id] || [])] })) })],
    ['GET', /^\/servers\/([^/]+)\/invites$/, () => ({ invites: [] })],
    ['GET', /^\/servers\/([^/]+)\/emojis$/, () => ({ emojis: [], limit: 50 })],
    ['GET', /^\/webhooks$/, () => ({ webhooks: state.webhooks })],
    ['POST', /^\/channels\/([^/]+)\/webhooks$/, ([cid], b) => { if (!features.webhooks) throw httpError(403, 'Bot webhooks are in testing'); const w = { id: uuid(8), channel_id: cid, name: b.name, token: 'secret' }; state.webhooks.push(w); return { webhook: w }; }],
    ['POST', /^\/webhooks\/([^/]+)$/, ([wid], b) => { const w = state.webhooks.find((x) => x.id === wid); if (!w) throw httpError(404, 'No such webhook'); return { message: createMessage(w.channel_id, b) }; }],
  ];

  const pendingInteractions = new Map();

  async function readForm(form) {
    if (!features.files) throw httpError(400, 'Sending files is in testing (flag bot_uploads)');
    const payload = JSON.parse(form.get('payload_json') || '{}');
    const files = [];
    for (const [key, value] of form.entries()) {
      if (!/^files?(\[\d+\])?$/.test(key) || typeof value === 'string') continue;
      const bytes = Buffer.from(await value.arrayBuffer());
      files.push({ name: value.name || 'file', size: value.size, text: await value.text(), bytes });
    }
    if (files.length > 4) throw httpError(400, 'Up to 4 files per message');
    for (const f of files) {
      if (!/\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|ogg|wav|m4a|txt|pdf|zip)$/i.test(f.name)) throw httpError(400, `${f.name}: that file type isn't allowed`);
      if (f.size > 10 * 1024 * 1024) throw httpError(400, `${f.name} is over 10 MB`);
    }
    return { payload, files };
  }

  async function api(method, fullPath, rawBody) {
    const [p, qs] = fullPath.split('?');
    const q = new URLSearchParams(qs || '');
    let body = rawBody;
    let files = null;
    if (typeof FormData !== 'undefined' && rawBody instanceof FormData) ({ payload: body, files } = await readForm(rawBody));
    calls.push({ method, path: fullPath, body: body === undefined ? undefined : structuredClone(body), files });
    if (files) {
      const cid = /^\/channels\/([^/]+)\/messages$/.exec(p)?.[1];
      if (method !== 'POST' || !cid) throw httpError(400, 'Files only go with POST /channels/:id/messages');
      const first = createMessage(cid, { ...body, content: body.content || (files.length ? '' : body.content), embeds: body.embeds, components: body.components, _files: files });
      return structuredClone({ message: first, messages: [first] });
    }
    for (const f of failures) {
      if ((f.method === '*' || f.method === method) && f.path.test(fullPath) && f.times !== 0) {
        if (f.times > 0) f.times--;
        throw httpError(f.status, f.error || `fake failure ${f.status}`, f.retryAfter);
      }
    }
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(m === 'GET' && /\?/.test(re.source) ? fullPath : p);
      if (!match) continue;
      const out = fn(match.slice(1).filter((x) => x !== undefined && !String(x).startsWith('?')), body ?? {}, q);
      return structuredClone(out);
    }
    throw httpError(404, `fake Yapin' has no route for ${method} ${fullPath}`);
  }

  return {
    api, state, calls, answers, features, clock, pendingInteractions,
    fail(method, pathRe, { status = 403, error = 'Missing permission', times = -1, retryAfter } = {}) { failures.push({ method, path: pathRe, status, error, times, retryAfter }); },
    clearFailures() { failures.length = 0; },
    userIds, memberOf, channelById, serverOfChannel,
    messagesIn: (cid) => (state.messages[cid] || []).filter((m) => !m.deleted),
    callsTo: (method, re) => calls.filter((c) => c.method === method && re.test(c.path)),
    addUserMessage(cid, authorId, content) {
      const m = { id: uuid(1), channel_id: cid, author_id: authorId, content, embeds: null, components: null, created_at: new Date(clock.t + msgSeq++).toISOString(), deleted: false };
      (state.messages[cid] ||= []).push(m);
      return m;
    },
  };
}

export const tick = () => new Promise((r) => setImmediate(r));

export async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function eventStamp({ createdAt = null, lateBy = 0 } = {}) {
  if (createdAt !== null && createdAt !== undefined) return new Date(typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)).toISOString();
  return new Date(Date.now() - (Number(lateBy) || 0)).toISOString();
}

export async function createHarness({ verified = false, store = createMemoryStore(), appsDir = APPS_DIR, loadApps = true, apps = null, features = {}, freshness = {}, fakeClock = false, scheduler = {} } = {}) {
  const fake = createFakeYapin();
  Object.assign(fake.features, features);
  const bot = new Bot('yb_test_token_not_real', { log: false, gateway: false });
  bot.api = (method, p, body) => fake.api(method, p, body);
  bot.me = await fake.api('GET', '/me');
  const lines = [];
  const log = createLogger({ level: process.env.YAPOS_TEST_LOG || 'warn', sink: (lvl, line) => { lines.push(line); if (process.env.YAPOS_TEST_LOG) console.log(line); } });
  const timers = [];
  const fakeTimers = {
    now: () => fake.clock.t,
    setTimeout: (fn, ms) => { const t = { fn, ms, at: fake.clock.t + ms, unref() { return t; } }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const engine = createEngine({ bot, config: { verified }, store, log, appsDir, freshness, scheduler: fakeClock ? { ...fakeTimers, ...scheduler } : scheduler });
  if (loadApps) await engine.load(apps ? [...new Set(['system', ...apps])] : null);

  let evId = 1000;
  const S = IDS.server;
  const nameOf = (uid) => fake.memberOf(S, uid)?.username || 'someone';

  const h = {
    bot, engine, fake, store, log, lines, IDS,
    settle,
    clock: fake.clock,
    fakeClock,
    schedulerTimers: timers,
    now: () => (fakeClock ? fake.clock.t : Date.now()),

    async runDue() {
      await engine.scheduler.runDue();
      await settle();
    },

    async advance(ms) {
      if (!fakeClock) throw new Error('h.advance needs createHarness({ fakeClock: true })');
      await h.advanceTo(fake.clock.t + (Number(ms) || 0));
    },

    async advanceTo(when) {
      if (!fakeClock) throw new Error('h.advanceTo needs createHarness({ fakeClock: true })');
      const target = when instanceof Date ? when.getTime() : typeof when === 'string' ? Date.parse(when) : Number(when);
      if (!Number.isFinite(target)) throw new Error('h.advanceTo needs a time');
      const s = engine.scheduler;
      await h.runDue();
      for (let step = 0; step < 10_000; step++) {
        let next = null;
        for (const job of s.list()) if (s.has(job.kind) && job.at > fake.clock.t && job.at <= target && (next === null || job.at < next)) next = job.at;
        if (next === null) break;
        fake.clock.t = next;
        await h.runDue();
      }
      if (target > fake.clock.t) fake.clock.t = target;
      await h.runDue();
    },

    async skip(ms) {
      if (!fakeClock) throw new Error('h.skip needs createHarness({ fakeClock: true })');
      fake.clock.t += Number(ms) || 0;
      await h.runDue();
    },

    async message(content, { user = IDS.member, channel = IDS.channels.general, server = S, replyTo = null, authorAsString = false, authorBot = false, attachment = null, createdAt = null, lateBy = 0 } = {}) {
      const stored = fake.addUserMessage(channel, user, content);
      stored.attachment_path = attachment;
      const data = {
        id: stored.id, channel_id: channel, channel_name: fake.channelById(channel)?.name, server_id: server,
        author_id: user, author: authorAsString ? nameOf(user) : { id: user, username: nameOf(user), display_name: nameOf(user) },
        content, attachment, reply_to_id: replyTo, created_at: stored.created_at,
        mentioned: content.includes(`<@${IDS.bot}>`), author_bot: authorBot,
      };
      const cmd = /^[/!]([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i.exec(content);
      if (cmd && bot.commands.has(cmd[1].toLowerCase())) { data.command = cmd[1].toLowerCase(); data.args = (cmd[2] || '').trim(); }
      await bot.handle({ id: ++evId, type: 'message', data, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
      return data;
    },

    async slash(command, args = '', { user = IDS.member, channel = IDS.channels.general, server = S, createdAt = null, lateBy = 0 } = {}) {
      const data = { id: uuid(2), token: `tok${evId}`, command, args, channel_id: channel, server_id: server, user_id: user, username: nameOf(user), expires_at: null };
      fake.pendingInteractions.set(data.id, data);
      await bot.handle({ id: ++evId, type: 'command', data, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
      return h.answersFor(data.id);
    },

    async click(customId, { user = IDS.member, channel = IDS.channels.general, server = S, messageId = null, type = 'button', values, createdAt = null, lateBy = 0 } = {}) {
      const data = { id: uuid(3), token: `tok${evId}`, type, custom_id: customId, values: values ?? (type === 'button' ? undefined : []), message_id: messageId, channel_id: channel, server_id: server, user_id: user, username: nameOf(user), expires_at: null };
      fake.pendingInteractions.set(data.id, data);
      await bot.handle({ id: ++evId, type: 'interaction', data, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
      return h.answersFor(data.id);
    },
    pick: (customId, values, opts = {}) => h.click(customId, { ...opts, type: 'select', values }),
    submit: (customId, values, opts = {}) => h.click(customId, { ...opts, type: 'modal_submit', values }),

    async clickButton(label, opts = {}) {
      const found = h.findButton(label, opts.in);
      if (!found) throw new Error(`No button "${label}" found. Buttons: ${h.allButtons(opts.in).map((b) => b.label).join(', ')}`);
      return h.click(found.custom_id, { messageId: found.messageId, channel: found.channelId ?? opts.channel ?? IDS.channels.general, ...opts });
    },

    async join(userId, { username = 'newbie', server = S, invite_code = null, createdAt = null, lateBy = 0 } = {}) {
      if (!fake.memberOf(server, userId)) fake.state.members[server].push({ id: userId, username, display_name: username, nickname: null, roles: [], joined_at: new Date(fake.clock.t).toISOString() });
      const member_count = fake.state.members[server].length;
      await bot.handle({ id: ++evId, type: 'member_join', data: { server_id: server, channel_id: null, user_id: userId, username, joined_at: new Date(fake.clock.t).toISOString(), member_count, invite_code }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },
    async leave(userId, { server = S, createdAt = null, lateBy = 0 } = {}) {
      const m = fake.memberOf(server, userId);
      fake.state.members[server] = fake.state.members[server].filter((x) => x.id !== userId);
      await bot.handle({ id: ++evId, type: 'member_leave', data: { server_id: server, channel_id: null, user_id: userId, username: m?.username || 'gone', joined_at: null, member_count: fake.state.members[server].length }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },
    async react(messageId, emoji, { user = IDS.member, channel = IDS.channels.general, server = S, remove = false, createdAt = null, lateBy = 0 } = {}) {
      await bot.handle({ id: ++evId, type: remove ? 'reaction_remove' : 'reaction_add', data: { message_id: messageId, channel_id: channel, server_id: server, user_id: user, username: nameOf(user), emoji, message_author_id: IDS.bot }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },
    addSecondAdmin() {
      if (!fake.memberOf(S, IDS.admin2)) fake.state.members[S].push({ id: IDS.admin2, username: 'casey', display_name: 'Casey', nickname: null, roles: [IDS.roles.admin, IDS.roles.member], joined_at: '2026-01-07T00:00:00Z' });
      engine.cache.invalidate(S);
      return IDS.admin2;
    },

    async voiceJoin(userId, { channel = IDS.channels.voice, server = S, createdAt = null, lateBy = 0 } = {}) {
      (fake.state.voice[channel] ||= new Set()).add(userId);
      await bot.handle({ id: ++evId, type: 'voice_join', data: { user_id: userId, channel_id: channel, server_id: server }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },
    async voiceLeave(userId, { channel = IDS.channels.voice, server = S, createdAt = null, lateBy = 0 } = {}) {
      fake.state.voice[channel]?.delete(userId);
      await bot.handle({ id: ++evId, type: 'voice_leave', data: { user_id: userId, channel_id: channel, server_id: server }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },

    async dm(content, { user = IDS.member, attachments = [], createdAt = null, lateBy = 0 } = {}) {
      const cid = `d${user.slice(1)}`;
      fake.state.dms[cid] = user;
      const files = attachments.map((a) => ({ path: a.path, name: a.name ?? null, size: a.size ?? null, width: a.width ?? null, height: a.height ?? null, voice_secs: a.voice_secs ?? null }));
      await bot.handle({ id: ++evId, type: 'dm_message', data: { id: uuid(4), channel_id: cid, dm_channel_id: cid, server_id: null, is_dm: true, dm: true, author_id: user, author: nameOf(user), author_name: nameOf(user), content, attachment: files[0]?.path ?? null, attachments: files, created_at: eventStamp({ createdAt, lateBy }), author_bot: false }, created_at: eventStamp({ createdAt, lateBy }) });
      await settle();
    },

    answersFor: (iid) => fake.answers.filter((a) => a.interactionId === iid),
    lastAnswer: () => fake.answers[fake.answers.length - 1] || null,
    sent: (cid) => (cid ? fake.messagesIn(cid) : Object.values(fake.state.messages).flat().filter((m) => !m.deleted)).filter((m) => m.author_id === IDS.bot),
    lastSent: (cid) => { const s = h.sent(cid); return s[s.length - 1] || null; },

    textOf(x) {
      if (!x) return '';
      const parts = [x.content || ''];
      for (const e of x.embeds || []) parts.push(e.title || '', e.description || '', ...(e.fields || []).flatMap((f) => [f.name, f.value]), e.footer?.text || '');
      const walk = (c) => { if (!c) return; if (c.type === 10) parts.push(c.content); if (c.label) parts.push(c.label); (c.components || []).forEach(walk); if (c.accessory) walk(c.accessory); (c.options || []).forEach((o) => parts.push(o.label)); };
      (x.components || []).forEach(walk);
      if (x.modal) { parts.push(x.modal.title); (x.modal.components || []).forEach((c) => parts.push(c.label || '')); }
      return parts.filter(Boolean).join('\n');
    },

    allButtons(where) {
      const sources = where ? [].concat(where) : [...fake.answers, ...h.sent()].reverse();
      const out = [];
      for (const s of sources) {
        const walk = (c) => {
          if (!c) return;
          if ((c.type === 'button' || c.type === 2) && c.custom_id) out.push({ ...c, messageId: s.message?.id || s.id, channelId: s.channel_id || s.message?.channel_id });
          if (c.type === 'select' || c.type === 3) out.push({ ...c, label: c.placeholder || c.custom_id, isSelect: true, messageId: s.id, channelId: s.channel_id });
          (c.components || []).forEach(walk);
          if (c.accessory) walk(c.accessory);
        };
        (s.components || []).forEach(walk);
      }
      return out;
    },
    findButton(label, where) {
      const re = label instanceof RegExp ? label : null;
      return h.allButtons(where).find((b) => (re ? re.test(b.label || '') || re.test(b.custom_id) : (b.label || '').toLowerCase().includes(String(label).toLowerCase()))) || null;
    },
  };
  return h;
}
