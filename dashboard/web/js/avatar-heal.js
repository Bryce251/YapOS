import { AVATAR_REFRESH_API, AVATAR_REFRESH_MAX, isYapinAvatar } from './avatar-rules.js';

export const HEAL_WAIT_MS = 1500;
export const HEAL_PAGE_MAX = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE = /^[^\s/\\?#]{1,64}$/;

function defaults() {
  return {
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}

let env = defaults();
let waiting = new Set();
const sent = new Set();
let timer = null;

export function configureHeal(opts = {}) {
  env = { ...env, ...opts };
}

export function resetHeal() {
  env = defaults();
  waiting = new Set();
  sent.clear();
  timer = null;
}

export function healState() {
  return { waiting: [...waiting], sent: [...sent] };
}

async function flush() {
  timer = null;
  const keys = [...waiting].slice(0, AVATAR_REFRESH_MAX);
  for (const k of keys) waiting.delete(k);
  if (waiting.size) timer = env.setTimeout(flush, HEAL_WAIT_MS);
  if (!keys.length || !env.fetch) return;
  const ids = keys.filter((k) => k.startsWith('i:')).map((k) => k.slice(2));
  const names = keys.filter((k) => k.startsWith('n:')).map((k) => k.slice(2));
  const body = { ...(ids.length ? { ids } : {}), ...(names.length ? { names } : {}) };
  try {
    await env.fetch(AVATAR_REFRESH_API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-YapOS': '1' }, body: JSON.stringify(body) });
  } catch {}
}

export function reportBrokenAvatar(who, url) {
  const name = who && typeof who === 'object' && typeof who.name === 'string' ? who.name.replace(/^@+/, '') : null;
  const id = typeof who === 'string' ? who : null;
  if (!isYapinAvatar(url)) return false;
  if (name !== null ? !NAME_RE.test(name) : !id || !ID_RE.test(id)) return false;
  const key = name !== null ? `n:${name.toLowerCase()}` : `i:${id.toLowerCase()}`;
  if (sent.has(key) || sent.size >= HEAL_PAGE_MAX) return false;
  sent.add(key);
  waiting.add(key);
  if (!timer) timer = env.setTimeout(flush, HEAL_WAIT_MS);
  return true;
}
