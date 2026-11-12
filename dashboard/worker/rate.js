import { MINUTE, sha256Hex, fail } from './util.js';

export const LIMITS = {
  api: 60,
  change: 20,
  userApi: 90,
  userChange: 30,
  auth: 30,
  public: 120,
};

export async function hit(db, key, limit, t) {
  const window = Math.floor(t / MINUTE);
  const row = await db
    .prepare('INSERT INTO rate (key, "window", count) VALUES (?, ?, 1) ON CONFLICT (key, "window") DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first();
  const count = row ? Number(row.count) : 1;
  const retryAfter = Math.max(1, Math.ceil(((window + 1) * MINUTE - t) / 1000));
  return { ok: count <= limit, count, retryAfter };
}

export async function ipKey(prefix, ip) {
  return `${prefix}:ip:${(await sha256Hex(`ip:${ip}`)).slice(0, 32)}`;
}

export function tooMany(retryAfter, message) {
  return fail(429, 'rate_limited', message || 'Slow down a little. Try again in a moment.', { retryAfter }, { 'Retry-After': String(retryAfter) });
}
