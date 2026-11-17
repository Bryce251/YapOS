import { setCustomTerms, customTermCount } from './filter.js';

export const BLOCKED_ENDPOINT = '/api/activity/blocked';
export const BLOCKED_REFRESH_MS = 5 * 60 * 1000;
export const BLOCKED_RETRY_MS = 30 * 1000;

let env = defaults();
let timer = null;
let version = '';

function defaults() {
  return {
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    refreshMs: BLOCKED_REFRESH_MS,
    retryMs: BLOCKED_RETRY_MS,
  };
}

export function configureBlocked(opts = {}) {
  const next = { ...env };
  for (const k of Object.keys(opts)) if (opts[k] !== undefined) next[k] = opts[k];
  if (opts.win !== undefined && opts.fetch === undefined) next.fetch = opts.win && typeof opts.win.fetch === 'function' ? (...a) => opts.win.fetch(...a) : null;
  delete next.win;
  env = next;
}

export function resetBlocked() {
  if (timer !== null) env.clearTimeout(timer);
  timer = null;
  version = '';
  env = defaults();
  setCustomTerms([]);
}

export async function loadBlocked() {
  if (typeof env.fetch !== 'function') return false;
  try {
    const res = await env.fetch(BLOCKED_ENDPOINT, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return false;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.t)) return false;
    const v = typeof body.v === 'string' ? body.v : '';
    if (v && v === version) return true;
    setCustomTerms(body.t);
    version = v;
    return true;
  } catch {
    return false;
  }
}

function schedule(ms) {
  if (timer !== null || !(ms > 0)) return;
  timer = env.setTimeout(async () => {
    timer = null;
    const ok = await loadBlocked();
    schedule(ok ? env.refreshMs : env.retryMs);
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

export async function startBlocked(opts = {}) {
  configureBlocked(opts);
  const ok = await loadBlocked();
  schedule(ok ? env.refreshMs : env.retryMs);
  return ok;
}

export function blockedCount() {
  return customTermCount();
}
