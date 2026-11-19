import { workerClient } from './worker-post.js';
import { profileData, publicSnapshot, partyMany, setPrivacy, privacyOf, validId, cleanText } from './profile-data.js';
import { pickAvatar } from './links.js';

export const PROFILES_PER_POST = 50;
const PER_RUN = 200;
const ACTIVE_MS = 30 * 60_000;
const REPUSH_MS = 10 * 60_000;
const MAX_TRACKED = 5000;
const MAX_SETTINGS = 100;
const LOOKUP_MS = 3000;
export const AVATAR_FRESH_MS = 6 * 60 * 60_000;
export const AVATAR_LOOKUPS_PER_RUN = 20;

const syncs = new WeakMap();

function plain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function createProfileSync(engine, { fetch = null, now = null } = {}) {
  const clock = () => {
    if (typeof now === 'function') return now();
    const t = engine.scheduler?.now?.();
    return Number.isFinite(t) ? t : Date.now();
  };
  const client = workerClient(engine, { fetch });
  const seen = new Map();
  const pushed = new Map();
  const dirty = new Set();
  const listeners = [];
  const acks = new Set();
  let running = null;

  function note(uid, who = null) {
    if (!validId(uid) || uid === engine.bot.me?.id) return;
    const prev = seen.get(uid);
    const name = cleanText(who?.display_name ?? who?.displayName ?? who?.nickname ?? null) || prev?.name || null;
    const username = cleanText(who?.username ?? null, 32) || prev?.username || null;
    const pic = pickAvatar(who);
    const t = clock();
    const next = { at: t, name, username };
    if (pic.known) {
      next.avatar = pic.url;
      next.avatarAt = t;
      if (prev && prev.avatarAt !== undefined && prev.avatar !== pic.url) dirty.add(uid);
    } else if (prev && prev.avatarAt !== undefined) {
      next.avatar = prev.avatar;
      next.avatarAt = prev.avatarAt;
    }
    seen.delete(uid);
    seen.set(uid, next);
    while (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value);
  }

  function markDirty(uid) {
    if (validId(uid)) dirty.add(uid);
  }

  function onMessage(msg) {
    if (!msg || msg.author_bot) return;
    const uid = msg.author_id ?? msg.author?.id ?? null;
    note(uid, typeof msg.author === 'object' ? msg.author : { username: typeof msg.author === 'string' ? msg.author : null });
  }
  const onAction = (ev) => note(ev?.user_id ?? null, { username: ev?.username ?? null });

  function picFresh(hit) {
    return Boolean(hit && hit.avatarAt !== undefined && clock() - hit.avatarAt < AVATAR_FRESH_MS);
  }

  async function lookup(uid, budget = { left: AVATAR_LOOKUPS_PER_RUN }) {
    const hit = seen.get(uid);
    if (hit?.username && (picFresh(hit) || budget.left <= 0)) return hit;
    if (typeof engine.bot.user !== 'function') return hit || {};
    if (hit?.username) budget.left -= 1;
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_MS);
      timer.unref?.();
    });
    try {
      const u = await Promise.race([Promise.resolve().then(() => engine.bot.user(uid)).catch(() => null), late]);
      if (!u || typeof u !== 'object') return hit || {};
      const fresh = cleanText(u.display_name ?? u.displayName ?? null);
      const out = { name: (hit?.username ? hit?.name || fresh : fresh || hit?.name) || null, username: cleanText(u.username, 32) || hit?.username || null };
      const pic = pickAvatar(u);
      if (pic.known) {
        out.avatar = pic.url;
        out.avatarAt = clock();
      } else if (hit && hit.avatarAt !== undefined) {
        out.avatar = hit.avatar;
        out.avatarAt = hit.avatarAt;
      }
      if (hit) Object.assign(hit, out);
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  function due() {
    const t = clock();
    const out = [...dirty];
    for (const [uid, s] of seen) {
      if (out.length >= PER_RUN) break;
      if (out.includes(uid)) continue;
      if (t - s.at > ACTIVE_MS) continue;
      const last = pushed.get(uid);
      if (last !== undefined && (last >= s.at || t - last < REPUSH_MS)) continue;
      out.push(uid);
    }
    return out.slice(0, PER_RUN);
  }

  async function snapshotsFor(ids) {
    const party = await partyMany(engine, ids.filter((id) => !privacyOf(engine, id).hidden));
    const out = [];
    const budget = { left: AVATAR_LOOKUPS_PER_RUN };
    for (const id of ids) {
      const data = profileData(engine, id, { party: party[id] || null });
      const who = await lookup(id, budget);
      out.push(publicSnapshot(data, { name: who.name ?? null, username: who.username ?? null, ...(who.avatarAt !== undefined ? { avatar: who.avatar ?? null } : {}) }));
    }
    return out;
  }

  async function runPush() {
    if (!client.enabled) return { sent: 0, batches: 0 };
    const ids = due();
    let sent = 0;
    let batches = 0;
    for (let i = 0; i < ids.length; i += PROFILES_PER_POST) {
      const chunk = ids.slice(i, i + PROFILES_PER_POST);
      const profiles = await snapshotsFor(chunk);
      const r = await client.post('/bot/profiles', { profiles });
      if (!r.ok) {
        engine.log?.debug?.(`[profiles] upload answered ${r.status}`);
        break;
      }
      const t = clock();
      for (const id of chunk) {
        pushed.set(id, t);
        dirty.delete(id);
      }
      while (pushed.size > MAX_TRACKED) pushed.delete(pushed.keys().next().value);
      sent += chunk.length;
      batches++;
    }
    return { sent, batches };
  }

  function push() {
    if (running) return running;
    running = runPush().finally(() => { running = null; });
    return running;
  }

  async function applySettings(list) {
    const rows = Array.isArray(list) ? list.slice(0, MAX_SETTINGS) : [];
    const ack = [];
    let applied = 0;
    for (const raw of rows) {
      if (!plain(raw)) continue;
      const user = typeof raw.user === 'string' ? raw.user.trim() : '';
      const ackId = raw.id !== undefined && raw.id !== null && /^[\w-]{1,64}$/.test(String(raw.id)) ? String(raw.id) : user;
      if (!validId(user)) {
        if (ackId && /^[\w-]{1,64}$/.test(ackId)) ack.push(ackId);
        continue;
      }
      const patch = {};
      if (typeof raw.hidden === 'boolean') patch.hidden = raw.hidden;
      if (typeof raw.showShards === 'boolean') patch.showShards = raw.showShards;
      if (Object.keys(patch).length) {
        setPrivacy(engine, user, patch);
        markDirty(user);
        applied++;
      }
      ack.push(ackId);
    }
    for (const id of ack) acks.add(id);
    if (!acks.size) return { applied, acked: 0 };
    const profileIds = [...acks].slice(0, MAX_SETTINGS);
    const r = await client.post('/bot/party/ack', { profileIds });
    if (r.ok) for (const id of profileIds) acks.delete(id);
    else engine.log?.debug?.(`[profiles] settings ack answered ${r.status}`);
    return { applied, acked: r.ok ? profileIds.length : 0 };
  }

  return {
    note,
    markDirty,
    push,
    applySettings,
    get tracked() { return seen.size; },
    get waitingAcks() { return acks.size; },
    install() {
      if (listeners.length) return;
      const add = (event, fn) => {
        engine.bot.on(event, fn);
        listeners.push([event, fn]);
      };
      add('message', onMessage);
      add('command', onAction);
      add('interaction', onAction);
    },
    uninstall() {
      for (const [event, fn] of listeners.splice(0)) {
        const list = engine.bot.handlers?.[event];
        if (!Array.isArray(list)) continue;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      }
    },
  };
}

export function profileSync(engine, opts) {
  let s = syncs.get(engine);
  if (!s) {
    s = createProfileSync(engine, opts);
    syncs.set(engine, s);
  }
  return s;
}

export function dropProfileSync(engine) {
  const s = syncs.get(engine);
  if (!s) return;
  s.uninstall();
  syncs.delete(engine);
}

export async function syncProfiles(engine, pollBody) {
  if (!plain(pollBody)) return { applied: 0, acked: 0 };
  const list = Array.isArray(pollBody.profileSettings) ? pollBody.profileSettings
    : Array.isArray(pollBody.party?.profileSettings) ? pollBody.party.profileSettings : null;
  if (!list) return { applied: 0, acked: 0 };
  return profileSync(engine).applySettings(list);
}
