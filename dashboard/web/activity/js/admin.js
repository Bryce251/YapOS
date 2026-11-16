export const ADMINS_EVENT = 'yapos:admins';
export const ADMINS_ENDPOINT = '/api/activity/admins';
export const ADMIN_BATCH = 40;
export const ADMIN_REFRESH_MS = 60000;
export const ADMIN_RETRY_MS = 5000;
export const ADMIN_TRACK_MAX = 400;
export const REPORTS_ENDPOINT = '/api/activity/reports';
export const REPORT_GAMES = Object.freeze(['draw', 'odd', 'telephone']);
export const REPORT_STROKES = 200;
export const REPORT_INK_CHARS = 16000;
export const REPORT_NAME_MAX = 64;
export const REPORT_WORD_MAX = 80;
export const REPORT_SENT_MAX = 200;
const INK_RE = /^[A-Za-z0-9_-]{6,4096}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let env = defaults();
let checked = new Map();
let admins = new Set();
let banned = new Set();
let reported = new Set();
let owner = null;
let failedAt = new Map();
let busy = new Map();
let listeners = new Set();
let timer = null;

function defaults() {
  return {
    win: typeof window !== 'undefined' ? window : null,
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    refreshMs: ADMIN_REFRESH_MS,
  };
}

export function configureAdmins(opts = {}) {
  const next = { ...env };
  for (const k of Object.keys(opts)) if (opts[k] !== undefined) next[k] = opts[k];
  env = next;
}

export function resetAdmins() {
  if (timer !== null) env.clearTimeout(timer);
  timer = null;
  checked = new Map();
  admins = new Set();
  banned = new Set();
  reported = new Set();
  owner = null;
  failedAt = new Map();
  busy = new Map();
  listeners = new Set();
  env = defaults();
}

function idOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    const v = x.id ?? x.user_id ?? x.userId ?? null;
    return v === null || v === undefined ? null : String(v);
  }
  return String(x);
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function isAdmin(id) {
  const key = idOf(id);
  return Boolean(key) && (admins.has(key) || (owner !== null && key === owner));
}

export function isOwner(id) {
  const key = idOf(id);
  return Boolean(key) && owner !== null && key === owner;
}

export function isBanned(id) {
  const key = idOf(id);
  return Boolean(key) && banned.has(key);
}

export function bannedIds() {
  return [...banned];
}

export function knows(id) {
  const key = idOf(id);
  return Boolean(key) && checked.has(key);
}

export function ownerId() {
  return owner;
}

export function adminIds() {
  const out = new Set(admins);
  if (owner !== null) out.add(owner);
  return [...out];
}

export function onAdmins(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {}
  }
  const win = env.win;
  if (!win || typeof win.dispatchEvent !== 'function') return;
  try {
    const Ctor = win.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (Ctor) win.dispatchEvent(new Ctor(ADMINS_EVENT));
  } catch {}
}

function track(id, at) {
  checked.delete(id);
  checked.set(id, at);
  while (checked.size > ADMIN_TRACK_MAX) {
    const old = checked.keys().next().value;
    checked.delete(old);
    admins.delete(old);
    banned.delete(old);
  }
}

async function ask(ids) {
  if (typeof env.fetch !== 'function') return null;
  try {
    const q = new URLSearchParams({ ids: ids.join(',') });
    const res = await env.fetch(`${ADMINS_ENDPOINT}?${q}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.admins)) return null;
    return body;
  } catch {
    return null;
  }
}

function apply(ids, body) {
  const asked = new Set(ids);
  const yes = new Set(body.admins.filter((x) => typeof x === 'string' && asked.has(x)));
  const out = new Set((Array.isArray(body.banned) ? body.banned : []).filter((x) => typeof x === 'string' && asked.has(x)));
  let changed = false;
  const at = env.now();
  for (const id of ids) {
    failedAt.delete(id);
    track(id, at);
    if (yes.has(id) && !admins.has(id)) {
      admins.add(id);
      changed = true;
    } else if (!yes.has(id) && admins.delete(id)) {
      changed = true;
    }
    if (out.has(id) && !banned.has(id)) {
      banned.add(id);
      changed = true;
    } else if (!out.has(id) && banned.delete(id)) {
      changed = true;
    }
  }
  const o = typeof body.owner === 'string' && asked.has(body.owner) ? body.owner : null;
  if (o !== null && owner !== o) {
    owner = o;
    changed = true;
  }
  return changed;
}

async function load(ids) {
  const body = await ask(ids);
  if (!body) {
    const at = env.now();
    for (const id of ids) failedAt.set(id, at);
    return false;
  }
  return apply(ids, body);
}

function schedule() {
  if (timer !== null || !(env.refreshMs > 0)) return;
  timer = env.setTimeout(() => {
    timer = null;
    const recent = [...checked.keys()].reverse();
    const ids = [...new Set([...admins].filter((id) => checked.has(id)).concat(recent))].slice(0, ADMIN_BATCH);
    if (!ids.length) return;
    refreshAdmins(ids, { force: true }).finally(schedule);
  }, env.refreshMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

export function refreshAdmins(list, opts = {}) {
  const force = Boolean(opts.force);
  const at = env.now();
  const want = [];
  const waits = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : [list]) {
    const id = idOf(x);
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    if (busy.has(id)) {
      waits.push(busy.get(id));
      continue;
    }
    if (!force && checked.has(id)) continue;
    const failed = failedAt.get(id);
    if (!force && failed !== undefined && at - failed < ADMIN_RETRY_MS) continue;
    want.push(id);
  }
  for (let i = 0; i < want.length; i += ADMIN_BATCH) {
    const chunk = want.slice(i, i + ADMIN_BATCH);
    const p = load(chunk).finally(() => {
      for (const id of chunk) if (busy.get(id) === p) busy.delete(id);
    });
    for (const id of chunk) busy.set(id, p);
    waits.push(p);
  }
  schedule();
  if (!waits.length) return Promise.resolve(false);
  return Promise.all(waits).then((r) => {
    const changed = r.some(Boolean);
    if (changed) announce();
    return changed;
  });
}

function cleanReportName(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, REPORT_NAME_MAX).join('');
}

export function reportInk(list) {
  const out = [];
  let chars = 0;
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= REPORT_STROKES) break;
    if (typeof s !== 'string' || !INK_RE.test(s)) continue;
    if (chars + s.length > REPORT_INK_CHARS) break;
    out.push(s);
    chars += s.length;
  }
  return out;
}

export function reportBody(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (!REPORT_GAMES.includes(x.game)) return null;
  const d = x.drawer && typeof x.drawer === 'object' ? x.drawer : {};
  const r = x.reporter && typeof x.reporter === 'object' ? x.reporter : {};
  const drawerId = idOf(d.id);
  const reporterId = idOf(r.id);
  if (!validId(drawerId) || !validId(reporterId) || drawerId === reporterId) return null;
  const handle = typeof d.username === 'string' ? cleanReportName(d.username.replace(/^@+/, '')).replace(/\s/g, '') : '';
  const word = typeof x.word === 'string' ? Array.from(cleanReportName(x.word)).slice(0, REPORT_WORD_MAX).join('') : '';
  return {
    game: x.game,
    drawer: { id: drawerId, name: cleanReportName(d.name) || 'Player', username: handle || null },
    reporter: { id: reporterId, name: cleanReportName(r.name) || 'Player' },
    ink: reportInk(x.ink),
    word: word || null,
    at: Number.isFinite(x.at) ? Math.round(x.at) : env.now(),
  };
}

export function wasReported(key) {
  return typeof key === 'string' && reported.has(key);
}

export async function sendReport(key, input) {
  if (typeof key !== 'string' || !key || reported.has(key)) return false;
  const body = reportBody(input);
  if (!body || typeof env.fetch !== 'function') return false;
  reported.add(key);
  while (reported.size > REPORT_SENT_MAX) reported.delete(reported.values().next().value);
  try {
    const res = await env.fetch(REPORTS_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}
