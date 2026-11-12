import { MINUTE, HttpError, parseJsonSafe } from './util.js';

export const JOB_TIMEOUT = 2 * MINUTE;
export const GRANT_TTL = 5 * MINUTE;
export const DENY_TTL = 5 * MINUTE;
export const DENIED = 'none';
export const OPEN_JOBS_PER_USER = 5;
export const JOB_TYPES = ['servers', 'access', 'change', 'member'];
const DEDUPE_TYPES = new Set(['servers', 'access']);

export async function expireJobs(db, t) {
  await db
    .prepare("UPDATE jobs SET status = 'error', error = 'timeout', updated = ? WHERE status IN ('pending', 'claimed') AND created < ?")
    .bind(t, t - JOB_TIMEOUT)
    .run();
}

export async function openJobs(db, userId, t) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('pending', 'claimed') AND created >= ?")
    .bind(userId, t - JOB_TIMEOUT)
    .first();
  return Number((row && row.n) || 0);
}

export async function enqueue(db, { type, userId, serverId = null, data = {} }, t) {
  if (DEDUPE_TYPES.has(type)) {
    const existing = await db
      .prepare("SELECT id FROM jobs WHERE user_id = ? AND type = ? AND IFNULL(server_id, '') = ? AND status IN ('pending', 'claimed') AND created >= ? ORDER BY created DESC LIMIT 1")
      .bind(userId, type, serverId || '', t - JOB_TIMEOUT)
      .first();
    if (existing) return existing.id;
  }
  if ((await openJobs(db, userId, t)) >= OPEN_JOBS_PER_USER) {
    throw new HttpError(429, 'busy', 'You already have a few requests waiting for YapOS. Wait for them to finish, then try again.', { retryAfter: 10 });
  }
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO jobs (id, type, user_id, server_id, data, status, result, error, created, updated) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)")
    .bind(id, type, userId, serverId, JSON.stringify(data || {}), t, t)
    .run();
  return id;
}

export async function freshGrant(db, userId, serverId, t) {
  return db
    .prepare('SELECT user_id, server_id, level, confirmed_at FROM grants WHERE user_id = ? AND server_id = ? AND confirmed_at >= ? AND level != ?')
    .bind(userId, serverId, t - GRANT_TTL, DENIED)
    .first();
}

export async function recentDenial(db, userId, serverId, t) {
  const row = await db
    .prepare('SELECT confirmed_at FROM grants WHERE user_id = ? AND server_id = ? AND level = ? AND confirmed_at >= ?')
    .bind(userId, serverId, DENIED, t - DENY_TTL)
    .first();
  return Boolean(row);
}

export async function claimJobs(db, t, max = 25) {
  const res = await db
    .prepare(
      "UPDATE jobs SET status = 'claimed', updated = ? WHERE id IN (SELECT id FROM (SELECT id, created, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created ASC, id ASC) AS turn FROM jobs WHERE status = 'pending') ORDER BY turn ASC, created ASC, id ASC LIMIT ?) RETURNING id, type, user_id, server_id, data, created",
    )
    .bind(t, max)
    .all();
  const rows = (res && res.results) || [];
  rows.sort((a, b) => Number(a.created) - Number(b.created) || String(a.id).localeCompare(String(b.id)));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    user_id: r.user_id,
    server_id: r.server_id,
    data: parseJsonSafe(r.data, {}),
    created: Number(r.created),
  }));
}

export async function isHot(db, t) {
  const row = await db.prepare('SELECT 1 AS hot FROM sessions WHERE last_seen >= ? AND expires > ? LIMIT 1').bind(t - 2 * MINUTE, t).first();
  return Boolean(row);
}
