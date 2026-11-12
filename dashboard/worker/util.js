export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const USER_BODY_LIMIT = 64 * 1024;
export const PART_LIMIT = 512 * 1024;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SERVER_ID_RE = /^[0-9a-f-]{36}$/i;
export const APP_RE = /^[a-z0-9_-]{1,32}$/;
export const SLUG_RE = /^[a-z0-9-]{3,32}$/;
export const SETTING_KEY_RE = /^[A-Za-z0-9_.\[\]-]{1,64}$/;

const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

export function json(data, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function fail(status, code, message, extra, headers) {
  return json({ error: code, message, ...(extra || {}) }, status, headers);
}

export function redirect(location, status = 302, headers = {}) {
  const h = headers instanceof Headers ? headers : new Headers(headers);
  h.set('Location', location);
  h.set('Cache-Control', 'no-store');
  return new Response(null, { status, headers: h });
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(text))));
}

export async function sha256Hex(text) {
  const bytes = await sha256Bytes(text);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && typeof a === 'string' && typeof b === 'string';
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

export function publicOrigin(env) {
  try {
    return new URL(String(env.PUBLIC_URL || '')).origin;
  } catch {
    return '';
  }
}

export function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

export function isLocalHttp(env) {
  try {
    const u = new URL(String(env.PUBLIC_URL || ''));
    return u.protocol === 'http:' && isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

export async function readBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'too_large', 'That request is too big.');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch {}
      throw new HttpError(413, 'too_large', 'That request is too big.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    throw new HttpError(400, 'bad_body', 'The request body is not valid text.');
  }
}

export async function readJson(request, limit) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'bad_type', 'Send the request as JSON.');
  }
  const text = await readBody(request, limit);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
  if (!isPlainObject(data)) {
    throw new HttpError(400, 'bad_json', 'The request body must be a JSON object.');
  }
  return data;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function byteLength(text) {
  return encoder.encode(text).byteLength;
}

export function parseJsonSafe(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function clipString(v, max) {
  if (typeof v !== 'string') return null;
  return v.length > max ? v.slice(0, max) : v;
}

export function safeHttpsUrl(v, max = 1024) {
  if (typeof v !== 'string' || v.length > max) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';
}
