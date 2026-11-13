export const PROFILES_EVENT = 'yapos:profiles';
export const ENDPOINT = '/api/activity/profiles';
export const BATCH = 40;
export const WAIT_MS = 60;
export const RETRY_MS = 4000;
export const GIVE_UP_MS = 60000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_MAX = 64;
const DISPLAY_MAX = 64;
const CACHE_MAX = 500;
const AVATAR_HOSTS = new Set(['files.yapper.website', 'www.yapin.gg']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEV_AVATAR = /^\/activity-dev\/avatars\/[a-z0-9-]{1,32}\.svg$/;
const STRIP = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

const cache = new Map();
const asks = new Map();
let env = defaults();
let timer = null;
let timerAt = Infinity;

function defaults() {
  return {
    win: typeof window !== 'undefined' ? window : null,
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  };
}

export function configureProfiles(opts = {}) {
  const next = { ...env };
  for (const k of Object.keys(opts)) if (opts[k] !== undefined) next[k] = opts[k];
  env = next;
}

export function resetProfiles() {
  if (timer) env.clearTimeout(timer);
  timer = null;
  timerAt = Infinity;
  cache.clear();
  asks.clear();
  env = defaults();
}

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

export function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(STRIP, '').replace(/\s+/g, '').replace(/^@+/, '');
  return text ? clip(text, USERNAME_MAX) : null;
}

function cleanDisplay(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(STRIP, '').replace(/\s+/g, ' ').trim();
  return text ? clip(text, DISPLAY_MAX) : null;
}

function location() {
  try {
    const loc = env.win && env.win.location;
    if (!loc || typeof loc.href !== 'string') return null;
    const u = new URL(loc.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

function devPage() {
  const u = location();
  return Boolean(u && LOCAL_HOSTS.has(u.hostname) && u.searchParams.get('dev') === '1');
}

export function profileAvatar(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return null;
  try {
    if (url.startsWith('/') && !url.startsWith('//')) {
      const here = devPage() ? location() : null;
      if (!here || !DEV_AVATAR.test(url)) return null;
      return new URL(url, here.origin).href;
    }
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:' && AVATAR_HOSTS.has(u.hostname) && !u.port) return u.href;
    const here = devPage() ? location() : null;
    if (here && u.origin === here.origin && DEV_AVATAR.test(u.pathname) && !u.search && !u.hash) return u.href;
    return null;
  } catch {
    return null;
  }
}

export function profileOf(id) {
  if (id === null || id === undefined) return null;
  return cache.get(String(id)) || null;
}

function store(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return false;
  const next = {
    username: cleanUsername(raw.username),
    displayName: cleanDisplay(raw.display_name ?? raw.displayName ?? null),
    avatar: profileAvatar(raw.avatar ?? raw.avatar_url ?? null),
  };
  const old = cache.get(raw.id);
  asks.delete(raw.id);
  if (old && old.username === next.username && old.displayName === next.displayName && old.avatar === next.avatar) return false;
  cache.delete(raw.id);
  cache.set(raw.id, next);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return true;
}

function announce() {
  const win = env.win;
  if (!win || typeof win.dispatchEvent !== 'function') return;
  try {
    const Ctor = win.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (Ctor) win.dispatchEvent(new Ctor(PROFILES_EVENT));
  } catch {}
}

export function rememberProfiles(list) {
  let changed = 0;
  for (const p of Array.isArray(list) ? list : []) if (store(p)) changed += 1;
  if (changed) announce();
  return changed;
}

function idOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    const v = x.id ?? x.user_id ?? x.userId ?? null;
    return v === null || v === undefined ? null : String(v);
  }
  return String(x);
}

function schedule(ms) {
  const at = env.now() + Math.max(0, ms);
  if (timer && timerAt <= at) return;
  if (timer) env.clearTimeout(timer);
  timerAt = at;
  timer = env.setTimeout(() => {
    timer = null;
    timerAt = Infinity;
    flush();
  }, Math.max(0, ms));
  if (timer && typeof timer.unref === 'function') timer.unref();
}

export function wantProfiles(list) {
  if (!location() || typeof env.fetch !== 'function') return 0;
  const t = env.now();
  let added = 0;
  for (const x of Array.isArray(list) ? list : [list]) {
    const id = idOf(x);
    if (!id || !ID_RE.test(id) || cache.has(id) || asks.has(id)) continue;
    asks.set(id, { first: t, next: t, busy: false });
    added += 1;
  }
  if (added) schedule(WAIT_MS);
  return added;
}

async function ask(ids, base) {
  const q = new URLSearchParams({ ids: ids.join(',') });
  let body = null;
  try {
    const res = await env.fetch(`${base}${ENDPOINT}?${q}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res && res.ok) body = await res.json();
  } catch {
    body = null;
  }
  return body && Array.isArray(body.profiles) ? body.profiles : [];
}

export async function flush() {
  const here = location();
  if (!here || typeof env.fetch !== 'function') {
    asks.clear();
    return 0;
  }
  const t = env.now();
  const due = [];
  for (const [id, a] of asks) {
    if (cache.has(id) || t - a.first > GIVE_UP_MS) {
      asks.delete(id);
      continue;
    }
    if (!a.busy && a.next <= t) due.push(id);
  }
  const chunks = [];
  for (let i = 0; i < due.length; i += BATCH) chunks.push(due.slice(i, i + BATCH));
  for (const id of due) {
    const a = asks.get(id);
    a.busy = true;
    a.next = t + RETRY_MS;
  }
  const answers = await Promise.all(chunks.map((c) => ask(c, here.origin)));
  let changed = 0;
  for (const list of answers) for (const p of list) if (store(p)) changed += 1;
  for (const id of due) {
    const a = asks.get(id);
    if (a) a.busy = false;
  }
  if (changed) announce();
  let soonest = Infinity;
  const after = env.now();
  for (const [id, a] of asks) {
    if (after - a.first > GIVE_UP_MS) {
      asks.delete(id);
      continue;
    }
    soonest = Math.min(soonest, a.next);
  }
  if (Number.isFinite(soonest)) schedule(Math.max(WAIT_MS, soonest - after));
  return changed;
}

export function waitingFor() {
  return [...asks.keys()];
}
