export const CACHE_LIMITS = {
  maxMessages: 5000,
  maxChars: 1_000_000,
  perChannel: 300,
  ttlMs: 24 * 3600_000,
  maxText: 2000,
  maxFiles: 4,
  maxBots: 500,
};

const fileName = (f) => {
  if (!f) return null;
  if (typeof f === 'string') return f.split('/').pop() || null;
  return String(f.name || f.path || f.url || '').split('/').pop() || null;
};

export function attachmentNames(msg) {
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(String(n).slice(0, 100)); };
  for (const a of Array.isArray(msg?.attachments) ? msg.attachments : []) add(fileName(a));
  if (msg?.attachment) add(fileName(msg.attachment));
  if (msg?.attachment_path) add(msg.attachment_name || fileName(msg.attachment_path));
  return out;
}

export function authorOf(msg) {
  const a = msg?.author;
  const id = msg?.author_id ?? (a && typeof a === 'object' ? a.id : null) ?? null;
  const name = typeof a === 'string' ? a : a?.display_name || a?.username || msg?.author_name || null;
  return { id, name };
}

export function createMessageCache(options = {}) {
  const lim = { ...CACHE_LIMITS, ...options };
  const now = options.now || (() => Date.now());
  const byId = new Map();
  const byChannel = new Map();
  const bots = new Set();
  const events = { edit: null, delete: null };
  let chars = 0;

  const sizeOf = (e) => e.content.length + e.files.join('').length + 64;

  function drop(id) {
    const e = byId.get(id);
    if (!e) return null;
    byId.delete(id);
    chars -= e.size;
    const set = byChannel.get(e.channelId);
    if (set) {
      set.delete(id);
      if (!set.size) byChannel.delete(e.channelId);
    }
    return e;
  }

  function expired(e) { return now() - e.cachedAt > lim.ttlMs; }

  function prune() {
    for (const [id, e] of byId) {
      if (expired(e)) drop(id);
      else break;
    }
    while (byId.size > lim.maxMessages || (chars > lim.maxChars && byId.size)) drop(byId.keys().next().value);
  }

  const copy = (e) => (e ? { ...e, files: [...e.files] } : null);

  function noteBot(id) {
    if (!id) return;
    bots.delete(id);
    bots.add(id);
    if (bots.size > lim.maxBots) bots.delete(bots.values().next().value);
  }

  function remember(msg) {
    if (!msg?.id || !msg.channel_id || !msg.server_id) return null;
    const author = authorOf(msg);
    if (msg.author_bot || msg.webhook_id) {
      noteBot(author.id);
      return null;
    }
    drop(msg.id);
    const e = {
      id: msg.id,
      serverId: msg.server_id,
      channelId: msg.channel_id,
      authorId: author.id,
      authorName: author.name ? String(author.name).slice(0, 64) : null,
      content: String(msg.content ?? '').slice(0, lim.maxText),
      files: attachmentNames(msg).slice(0, lim.maxFiles),
      createdAt: msg.created_at ?? null,
      cachedAt: now(),
    };
    e.size = sizeOf(e);
    byId.set(e.id, e);
    chars += e.size;
    let set = byChannel.get(e.channelId);
    if (!set) byChannel.set(e.channelId, (set = new Set()));
    set.add(e.id);
    while (set.size > lim.perChannel) drop(set.values().next().value);
    prune();
    return copy(e);
  }

  function get(id) {
    const e = byId.get(id);
    if (!e) return null;
    if (expired(e)) { drop(id); return null; }
    return copy(e);
  }

  function update(id, content) {
    const e = byId.get(id);
    if (!e) return null;
    if (expired(e)) { drop(id); return null; }
    const before = copy(e);
    drop(id);
    e.content = String(content ?? '').slice(0, lim.maxText);
    e.cachedAt = now();
    e.size = sizeOf(e);
    byId.set(id, e);
    chars += e.size;
    let set = byChannel.get(e.channelId);
    if (!set) byChannel.set(e.channelId, (set = new Set()));
    set.add(id);
    prune();
    return before;
  }

  function take(id) {
    const e = drop(id);
    return e && !expired(e) ? copy(e) : null;
  }

  function takeMany(ids) {
    const out = [];
    for (const id of ids || []) {
      const e = take(id);
      if (e) out.push(e);
    }
    return out;
  }

  function clearServer(sid) {
    for (const [id, e] of byId) if (e.serverId === sid) drop(id);
  }

  function clearChannel(cid) {
    for (const id of [...(byChannel.get(cid) || [])]) drop(id);
  }

  function clear() {
    byId.clear();
    byChannel.clear();
    bots.clear();
    chars = 0;
  }

  function markEvent(kind) { events[kind] = now(); }

  return {
    remember,
    get,
    update,
    take,
    takeMany,
    clearServer,
    clearChannel,
    clear,
    prune,
    isBot: (uid) => !!uid && bots.has(uid),
    noteBot,
    markEvent,
    lastEvent: (kind) => events[kind] ?? null,
    stats: () => ({ messages: byId.size, chars, channels: byChannel.size }),
    limits: lim,
  };
}
