import { MINUTE, sha256Hex, fail } from './util.js';

export const LIMITS = {
  api: 60,
  change: 20,
  userApi: 90,
  userChange: 30,
  auth: 30,
  public: 120,
  profiles: 60,
  profileAsks: 200,
  partyAdmins: 60,
  reports: 5,
  textReports: 10,
  reportsAll: 60,
  results: 30,
  resultsAll: 600,
  daily: 120,
  dailyPost: 20,
  packs: 60,
  publicProfile: 120,
  browse: 120,
  packLikes: 30,
  packReports: 5,
  seasons: 120,
  stats: 30,
  leaderboard: 120,
  partyProfile: 90,
  modNotes: 10,
  modWarnings: 10,
  activityWarnings: 30,
  profileLook: 20,
  profileBanner: 6,
  profileAvatar: 6,
  avatarRefresh: 20,
  staffProfile: 30,
  clans: 120,
  clanJoin: 10,
  clanJoinIp: 30,
  clanActions: 20,
  clanActionsIp: 60,
  clanPeople: 60,
};

export async function hit(db, key, limit, t, weight = 1) {
  const n = Math.max(1, Math.floor(Number(weight) || 1));
  const window = Math.floor(t / MINUTE);
  const row = await db
    .prepare('INSERT INTO rate (key, "window", count) VALUES (?, ?, ?) ON CONFLICT (key, "window") DO UPDATE SET count = count + excluded.count RETURNING count')
    .bind(key, window, n)
    .first();
  const count = row ? Number(row.count) : n;
  const retryAfter = Math.max(1, Math.ceil(((window + 1) * MINUTE - t) / 1000));
  return { ok: count <= limit, count, retryAfter };
}

export async function ipKey(prefix, ip) {
  return `${prefix}:ip:${(await sha256Hex(`ip:${ip}`)).slice(0, 32)}`;
}

export function tooMany(retryAfter, message) {
  return fail(429, 'rate_limited', message || 'Slow down a little. Try again in a moment.', { retryAfter }, { 'Retry-After': String(retryAfter) });
}
