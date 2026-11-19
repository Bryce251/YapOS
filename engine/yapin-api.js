import { explain, looksLikeFeatureOff } from './errors.js';

const REACTION_CALLS_PER_MIN = 10;
const MAX_REACTION_ROUNDS = 25;
const MAX_CHANNEL_USERS = 50;
const THREADS_PER_WINDOW = 10;
const THREAD_WINDOW_MS = 10 * 60_000;
const THREAD_LIMIT_TEXT = "Yapin' allows 10 new threads every 10 minutes in a server. Try again in a few minutes.";

const enc = encodeURIComponent;
const ids = (v) => [...new Set([].concat(v ?? []).filter(Boolean).map(String))];
const sleepFor = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export function classify(e) {
  const raw = String(e?.message || '');
  if (looksLikeFeatureOff(e)) return 'off';
  if (e?.status === 429) return 'limited';
  if (e?.status === 403) return 'denied';
  if (e?.status === 404) return 'missing';
  if (e?.status === 400 && /reaction role|giveaway|suggestion/i.test(raw)) return 'protected';
  if (e?.status === 400) return 'refused';
  return 'failed';
}

const OFF_BODY = "This isn't on for this server yet. Yapin' is still testing it, so I used the older way where I could.";

export function createYapinApi({ bot, caps, cache = null, log = null, now = () => Date.now(), sleep = sleepFor } = {}) {
  const reactionCalls = [];
  const threadTimes = new Map();

  function problem(e, { sid = null, cap = null, action, perm } = {}) {
    const reason = classify(e);
    if (cap && reason === 'off') caps?.mark(sid, cap, false, e?.message);
    const ex = explain(e, { action, perm });
    const body = reason === 'off' ? OFF_BODY : reason === 'protected' ? "Yapin' keeps reactions on messages that run its own reaction roles, giveaways or suggestion votes. Those can't be cleared." : ex.body;
    const title = reason === 'off' ? "That isn't on here yet" : reason === 'protected' ? "Those reactions can't be cleared" : ex.title;
    return { ok: false, reason, status: e?.status ?? null, title, body, error: e?.message || String(e) };
  }

  const known = (sid, cap) => caps?.state(sid, cap) ?? null;
  const works = (sid, cap) => { if (known(sid, cap) !== true) caps?.mark(sid, cap, true); };

  async function createPrivateChannel(serverId, name, { kind = 'text', categoryId, roleIds = [], userIds = [] } = {}) {
    const roles = ids(roleIds);
    const users = ids(userIds).slice(0, MAX_CHANNEL_USERS);
    if (known(serverId, 'private_create') !== false) {
      try {
        const out = await bot.api('POST', `/servers/${serverId}/channels`, { name, kind, category_id: categoryId, private: true, role_ids: roles, user_ids: users });
        const ch = out?.channel ?? null;
        const listed = !users.length || (Array.isArray(ch?.user_ids) && users.every((u) => ch.user_ids.map(String).includes(u)));
        if (ch?.private && !listed) return finishPrivate(serverId, ch, roles, users);
        if (ch?.private) {
          works(serverId, 'private_create');
          if (users.length) works(serverId, 'channel_users');
          cache?.invalidate?.(serverId);
          return { ok: true, channel: ch, private: true, usersSet: users.length > 0 && Array.isArray(ch.user_ids), via: 'create' };
        }
        if (ch?.id) {
          caps?.mark(serverId, 'private_create', false, 'channel came back public');
          return finishPrivate(serverId, ch, roles, users);
        }
      } catch (e) {
        const r = classify(e);
        if (r !== 'off' && r !== 'refused') return problem(e, { sid: serverId, action: 'make that channel', perm: 'manage_channels' });
        caps?.mark(serverId, 'private_create', false, e?.message);
      }
    }
    let ch;
    try {
      ch = await bot.createChannel(serverId, name, { kind, categoryId });
    } catch (e) {
      return problem(e, { sid: serverId, action: 'make that channel', perm: 'manage_channels' });
    }
    return finishPrivate(serverId, ch, roles, users);
  }

  async function finishPrivate(serverId, ch, roles, users) {
    cache?.invalidate?.(serverId);
    let edited = ch;
    try {
      edited = (await bot.editChannel(ch.id, { private: true, roleIds: roles })) || { ...ch, private: true, role_ids: roles };
    } catch (e) {
      const p = problem(e, { sid: serverId, action: 'make that channel private', perm: 'manage_channels' });
      const removed = typeof bot.deleteChannel === 'function' ? await bot.deleteChannel(ch.id).then(() => true, () => false) : false;
      return { ...p, channel: removed ? null : ch, private: false, removed };
    }
    let usersSet = false;
    if (users.length) {
      const set = await setChannelUsers(ch.id, users, { serverId });
      usersSet = set.ok;
      if (set.ok && set.channel) edited = set.channel;
    }
    return { ok: true, channel: edited, private: true, usersSet, via: 'edit' };
  }

  async function setChannelUsers(channelId, userIds, { serverId = null } = {}) {
    const users = ids(userIds);
    if (users.length > MAX_CHANNEL_USERS) return { ok: false, reason: 'too_many', title: 'Too many people', body: `A channel can list up to ${MAX_CHANNEL_USERS} people. Use a role for bigger groups.` };
    if (known(serverId, 'channel_users') === false) return { ok: false, reason: 'off', title: "That isn't on here yet", body: OFF_BODY };
    try {
      const out = await bot.api('PATCH', `/channels/${channelId}`, { user_ids: users });
      works(serverId, 'channel_users');
      return { ok: true, channel: out?.channel ?? null, userIds: users };
    } catch (e) {
      const r = classify(e);
      if (r === 'refused' && /user_ids|unknown field|not allowed/i.test(String(e?.message))) caps?.mark(serverId, 'channel_users', false, e?.message);
      return problem(e, { sid: serverId, cap: 'channel_users', action: 'change who can see that channel', perm: 'manage_channels' });
    }
  }

  async function createThread(channelId, { name, content, messageId, serverId = null } = {}) {
    const title = String(name ?? '').trim().slice(0, 100);
    const first = String(content ?? '').trim();
    if (!title || !first) return { ok: false, reason: 'refused', title: 'A thread needs a name and a first message', body: 'Give it both and try again.' };
    if (known(serverId, 'threads') === false) return { ok: false, reason: 'off', title: "Threads aren't on here yet", body: OFF_BODY };
    const key = serverId ?? `channel:${channelId}`;
    const recent = (threadTimes.get(key) || []).filter((t) => now() - t < THREAD_WINDOW_MS);
    if (recent.length >= THREADS_PER_WINDOW) {
      threadTimes.set(key, recent);
      return { ok: false, reason: 'limited', status: null, title: 'Too many new threads', body: THREAD_LIMIT_TEXT, retryAfter: Math.ceil((recent[0] + THREAD_WINDOW_MS - now()) / 1000) };
    }
    recent.push(now());
    threadTimes.set(key, recent);
    if (threadTimes.size > 5000) threadTimes.delete(threadTimes.keys().next().value);
    try {
      const out = await bot.api('POST', `/channels/${channelId}/threads`, { name: title, content: first.slice(0, 2000), ...(messageId ? { message_id: messageId } : {}) });
      works(serverId, 'threads');
      return { ok: true, thread: out?.thread ?? out?.channel ?? null, message: out?.message ?? null };
    } catch (e) {
      if (e?.status !== 429) recent.pop();
      if (e?.status === 429) return { ok: false, reason: 'limited', status: 429, title: 'Too many new threads', body: THREAD_LIMIT_TEXT, retryAfter: e.retryAfter ?? null };
      if (e?.status === 404 && !/channel|message/i.test(String(e?.message))) caps?.mark(serverId, 'threads', false, e?.message);
      return problem(e, { sid: serverId, cap: 'threads', action: 'start that thread', perm: 'create_threads' });
    }
  }

  async function listThreads(channelId, { serverId = null } = {}) {
    if (known(serverId, 'threads') === false) return { ok: false, reason: 'off', threads: [], title: "Threads aren't on here yet", body: OFF_BODY };
    try {
      const out = await bot.api('GET', `/channels/${channelId}/threads`);
      works(serverId, 'threads');
      return { ok: true, threads: out?.threads ?? [] };
    } catch (e) {
      return { ...problem(e, { sid: serverId, cap: 'threads', action: 'list the threads' }), threads: [] };
    }
  }

  async function editThread(threadId, changes = {}, { serverId = null } = {}) {
    const body = {};
    for (const k of ['name', 'locked', 'archived']) if (changes[k] !== undefined) body[k] = k === 'name' ? String(changes[k]).slice(0, 100) : !!changes[k];
    try {
      const out = await bot.api('PATCH', `/threads/${threadId}`, body);
      works(serverId, 'threads');
      return { ok: true, thread: out?.thread ?? null };
    } catch (e) {
      return problem(e, { sid: serverId, cap: 'threads', action: 'change that thread', perm: 'manage_threads' });
    }
  }

  async function deleteThread(threadId, { serverId = null } = {}) {
    try {
      await bot.api('DELETE', `/threads/${threadId}`);
      works(serverId, 'threads');
      return { ok: true };
    } catch (e) {
      return problem(e, { sid: serverId, cap: 'threads', action: 'delete that thread', perm: 'manage_threads' });
    }
  }

  function reactionPath(channelId, messageId, { emoji, userId } = {}) {
    const base = `/channels/${channelId}/messages/${messageId}/reactions`;
    if (emoji && userId) return `${base}/${enc(emoji)}?user_id=${enc(userId)}`;
    if (emoji) return `${base}/${enc(emoji)}?all=true`;
    return base;
  }

  async function reactionSlot(maxWaitMs = Infinity) {
    for (;;) {
      const cut = now() - 60_000;
      while (reactionCalls.length && reactionCalls[0] <= cut) reactionCalls.shift();
      if (reactionCalls.length < REACTION_CALLS_PER_MIN) { reactionCalls.push(now()); return true; }
      const wait = Math.max(50, reactionCalls[0] + 60_000 - now());
      if (wait > maxWaitMs) return false;
      await sleep(wait);
    }
  }

  const REACTION_LIMIT_TEXT = "Yapin' allows 10 reaction clears a minute. Try again in a minute.";

  async function clearReactions(channelId, messageId, { emoji, userId, serverId = null, maxRounds = MAX_REACTION_ROUNDS, maxWaitMs = Infinity } = {}) {
    if (userId && !emoji) return { ok: false, reason: 'refused', removed: 0, title: 'Pick an emoji', body: "Yapin' clears one person's reactions one emoji at a time." };
    if (known(serverId, 'reaction_clear') === false) return { ok: false, reason: 'off', removed: 0, title: "Clearing reactions isn't on here yet", body: OFF_BODY };
    const path = reactionPath(channelId, messageId, { emoji, userId });
    let removed = 0;
    let rounds = 0;
    let more = false;
    try {
      do {
        if (!(await reactionSlot(maxWaitMs))) {
          if (!rounds) return { ok: false, reason: 'limited', status: null, removed, rounds, title: 'Too many at once', body: REACTION_LIMIT_TEXT };
          break;
        }
        const out = await bot.api('DELETE', path);
        rounds++;
        removed += Number(out?.removed ?? out?.deleted ?? out?.count ?? 0) || 0;
        more = out?.more === true;
      } while (more && rounds < maxRounds);
      works(serverId, 'reaction_clear');
      return { ok: true, removed, rounds, more };
    } catch (e) {
      if (classify(e) === 'missing' && !/message|channel/i.test(String(e?.message))) caps?.mark(serverId, 'reaction_clear', false, e?.message);
      return { ...problem(e, { sid: serverId, cap: 'reaction_clear', action: 'clear those reactions', perm: 'manage_messages' }), removed, rounds };
    }
  }

  async function memberCounts(serverId) {
    if (known(serverId, 'member_counts') !== false) {
      try {
        const out = await bot.api('GET', `/servers/${serverId}/counts`);
        if (Number.isFinite(Number(out?.member_count))) {
          works(serverId, 'member_counts');
          return { ok: true, live: true, member_count: Number(out.member_count), online_count: out.online_count == null ? null : Number(out.online_count) };
        }
      } catch (e) {
        const r = classify(e);
        if (r === 'off' || r === 'missing' || r === 'refused') caps?.mark(serverId, 'member_counts', false, e?.message);
        else log?.debug?.('[yapin] live counts failed', e?.message);
      }
    }
    try {
      const all = cache?.members ? await cache.members(serverId) : await bot.members(serverId);
      return { ok: true, live: false, member_count: (all || []).length, online_count: null };
    } catch (e) {
      return { ...problem(e, { sid: serverId, action: 'count the members' }), member_count: null, online_count: null, live: false };
    }
  }

  async function permissionsOf(serverId, userId, channelId = null) {
    if (known(serverId, 'permissions') === false) return null;
    const path = channelId ? `/channels/${channelId}/permissions/${userId}` : `/servers/${serverId}/members/${userId}/permissions`;
    try {
      const out = await bot.api('GET', path);
      const perms = out?.permissions ?? null;
      if (perms) works(serverId, 'permissions');
      return perms;
    } catch (e) {
      const r = classify(e);
      if (r === 'off' || r === 'missing' || r === 'refused') caps?.mark(serverId, 'permissions', false, e?.message);
      return null;
    }
  }

  return { createPrivateChannel, setChannelUsers, createThread, listThreads, editThread, deleteThread, clearReactions, memberCounts, permissionsOf, reactionPath };
}
