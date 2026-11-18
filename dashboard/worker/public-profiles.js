import { DAY, ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, parseJsonSafe, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText, cleanUsername, cleanAvatar } from './profiles.js';
import { PARTY_BADGES, badgesFor, partySeasonBadges } from './party-badges.js';
import { liveBadges } from './custom-badges.js';
import { findBlocked } from '../web/activity/js/filter.js';
import { readCatalog } from './owner.js';

export const MAX_SNAPSHOTS = 50;
export const MAX_BADGES = 64;
export const MAX_ACHIEVEMENTS = 100;
export const MAX_SEASON_ROWS = 36;
export const SETTINGS_BATCH = 50;
export const PUBLIC_PROFILE_KEEP = 180 * DAY;
export const SETTINGS_KEEP = 30 * DAY;
export const FAVOURITES = 3;

const NAME_MAX = 64;
const CLAN_NAME_MAX = 32;
const CLAN_TAG_MAX = 6;
const MAX_LEVEL = 100000;
const MAX_XP = 1e12;
const MAX_SHARDS = 1e15;
const BADGE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const TAG_RE = /^[\p{L}\p{N}]+$/u;
const LOOKUP_RE = /^[^\s/\\?#]{1,64}$/;
const SEASON_KINDS = new Set(['xp', 'shards']);
const MISSING = "This profile is private or doesn't exist.";

export function safeName(value, max, fallback) {
  const text = cleanText(value, max);
  if (!text) return fallback;
  return findBlocked(text).length ? fallback : text;
}

function whole(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

function idList(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !BADGE_RE.test(v)) continue;
    const id = v.toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function cleanSeason(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const s of value) {
    if (!isPlainObject(s) || typeof s.month !== 'string' || !MONTH_RE.test(s.month) || !SEASON_KINDS.has(s.kind)) continue;
    if (typeof s.rank !== 'number' || !Number.isInteger(s.rank) || s.rank < 1 || s.rank > 1000) continue;
    out.push({ month: s.month, rank: s.rank, kind: s.kind });
    if (out.length >= MAX_SEASON_ROWS) break;
  }
  out.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.rank - b.rank));
  return out;
}

function cleanClan(value) {
  if (!isPlainObject(value)) return null;
  const name = safeName(value.name, CLAN_NAME_MAX, null);
  if (!name) return null;
  const rawTag = cleanText(value.tag, CLAN_TAG_MAX);
  const tag = rawTag && TAG_RE.test(rawTag) && !findBlocked(rawTag).length ? rawTag : null;
  const colour = typeof value.colour === 'string' && COLOUR_RE.test(value.colour) ? value.colour.toLowerCase() : null;
  return { name, tag, colour };
}

export function isSnapshot(p) {
  return isPlainObject(p) && (typeof p.hidden === 'boolean' || typeof p.level === 'number');
}

export function cleanSnapshot(p) {
  if (!isPlainObject(p) || typeof p.id !== 'string' || !ID_RE.test(p.id)) return null;
  const username = cleanUsername(p.username);
  return {
    id: p.id.toLowerCase(),
    name: safeName(p.name, NAME_MAX, username || 'Player'),
    username,
    level: whole(p.level, 0, MAX_LEVEL),
    xp: whole(p.xp, 0, MAX_XP),
    shards: p.shards === null || p.shards === undefined ? null : whole(p.shards, 0, MAX_SHARDS),
    badges: idList(p.badges, MAX_BADGES),
    achievements: idList(p.achievements, MAX_ACHIEVEMENTS),
    season: cleanSeason(p.season),
    clan: cleanClan(p.clan),
    hidden: p.hidden === true,
  };
}

export function snapshotStatements(db, list, t) {
  return list.map((s) =>
    db
      .prepare('INSERT INTO public_profiles (user_id, username, username_key, name, level, xp, shards, badges, achievements, season, clan, hidden, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, username_key = excluded.username_key, name = excluded.name, level = excluded.level, xp = excluded.xp, shards = excluded.shards, badges = excluded.badges, achievements = excluded.achievements, season = excluded.season, clan = excluded.clan, hidden = excluded.hidden, updated = excluded.updated')
      .bind(s.id, s.username, s.username ? s.username.toLowerCase() : null, s.name, s.level, s.xp, s.shards, JSON.stringify(s.badges), JSON.stringify(s.achievements), JSON.stringify(s.season), s.clan ? JSON.stringify(s.clan) : null, s.hidden ? 1 : 0, t),
  );
}

export async function settingsPoll(db, t) {
  const res = await db
    .prepare('UPDATE profile_settings SET given = ? WHERE user_id IN (SELECT user_id FROM profile_settings WHERE claimed = 0 ORDER BY updated ASC, user_id ASC LIMIT ?) RETURNING user_id, hidden, show_shards, updated')
    .bind(t, SETTINGS_BATCH)
    .all();
  const rows = (res && res.results) || [];
  rows.sort((a, b) => Number(a.updated) - Number(b.updated) || String(a.user_id).localeCompare(String(b.user_id)));
  return rows.map((r) => ({ user: r.user_id, hidden: Boolean(r.hidden), showShards: Boolean(r.show_shards) }));
}

export async function ackSettings(db, ids) {
  let acked = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await db.prepare(`UPDATE profile_settings SET claimed = 1 WHERE claimed = 0 AND updated <= given AND user_id IN (${part.map(() => '?').join(', ')})`).bind(...part).run();
    acked += Number((res && res.meta && res.meta.changes) || 0);
  }
  return acked;
}

export function profileCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM public_profiles WHERE updated < ?').bind(t - PUBLIC_PROFILE_KEEP),
    db.prepare('DELETE FROM profile_settings WHERE claimed = 1 AND updated < ?').bind(t - SETTINGS_KEEP),
  ];
}

function favourites(byGame) {
  return Object.entries(isPlainObject(byGame) ? byGame : {})
    .filter(([, v]) => isPlainObject(v) && Number(v.p) > 0)
    .map(([game, v]) => ({ game, played: Number(v.p) || 0, won: Number(v.w) || 0 }))
    .sort((a, b) => b.played - a.played || b.won - a.won || (a.game < b.game ? -1 : 1))
    .slice(0, FAVOURITES);
}

function applySettings(row, settings) {
  const fresh = settings && (!Number(settings.claimed) || Number(settings.updated) >= Number(row.updated || 0));
  if (!fresh) return { hidden: Boolean(Number(row.hidden)), showShards: row.shards !== null && row.shards !== undefined };
  return { hidden: Boolean(Number(settings.hidden)), showShards: Boolean(Number(settings.show_shards)) };
}

function displayNameOf(row, prof) {
  const username = typeof row.username === 'string' ? row.username.replace(/^@+/, '').toLowerCase() : '';
  const saved = safeName(row.name, NAME_MAX, null);
  const looked = prof && !Number(prof.missing) ? safeName(prof.display_name, NAME_MAX, null) : null;
  const isHandle = (n) => Boolean(username) && n.replace(/^@+/, '').toLowerCase() === username;
  return [saved, looked].find((n) => n && !isHandle(n)) || saved || looked || row.username || 'Player';
}

const HANDLE_CHUNK = 90;

export async function publicHandles(db, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((v) => typeof v === 'string' && v && v.length <= 64).map((v) => v.toLowerCase()))];
  const out = new Map();
  for (let i = 0; i < list.length; i += HANDLE_CHUNK) {
    const part = list.slice(i, i + HANDLE_CHUNK);
    const marks = part.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT p.user_id, p.username, p.hidden, p.shards, p.updated, s.hidden AS s_hidden, s.show_shards AS s_show_shards, s.claimed AS s_claimed, s.updated AS s_updated FROM public_profiles p LEFT JOIN profile_settings s ON s.user_id = p.user_id WHERE p.user_id IN (${marks}) AND p.username IS NOT NULL`)
      .bind(...part)
      .all();
    for (const r of (res && res.results) || []) {
      const settings = r.s_updated === null || r.s_updated === undefined ? null : { hidden: r.s_hidden, show_shards: r.s_show_shards, claimed: r.s_claimed, updated: r.s_updated };
      const username = cleanUsername(r.username);
      if (username && !applySettings(r, settings).hidden) out.set(String(r.user_id).toLowerCase(), username);
    }
  }
  return out;
}

export async function getPublicProfile(request, env, raw, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('publicProfile', clientIp(request)), LIMITS.publicProfile, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const missing = () => fail(404, 'not_found', MISSING, undefined, { 'Cache-Control': 'public, max-age=30' });
  const name = typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
  if (!LOOKUP_RE.test(name)) return missing();
  const row = await env.DB
    .prepare('SELECT user_id, username, name, level, xp, shards, badges, achievements, season, clan, hidden, updated FROM public_profiles WHERE username_key = ? ORDER BY updated DESC LIMIT 1')
    .bind(name.toLowerCase())
    .first();
  if (!row) return missing();
  const [settings, stats, streak, prof, catalog, partySeason] = await Promise.all([
    env.DB.prepare('SELECT hidden, show_shards, claimed, updated FROM profile_settings WHERE user_id = ?').bind(row.user_id).first(),
    env.DB.prepare('SELECT games, wins, by_game, counters FROM party_stats WHERE user_id = ?').bind(row.user_id).first(),
    env.DB.prepare('SELECT best FROM party_daily_streaks WHERE user_id = ?').bind(row.user_id).first(),
    env.DB.prepare('SELECT avatar_url, display_name, missing FROM profiles WHERE id = ?').bind(row.user_id).first(),
    readCatalog(env.DB).catch(() => ({ achievements: [], badges: [] })),
    partySeasonBadges(env.DB, row.user_id).catch(() => []),
  ]);
  const view = applySettings(row, settings);
  if (view.hidden) return missing();
  const byGame = parseJsonSafe(stats && stats.by_game, {});
  const counters = parseJsonSafe(stats && stats.counters, {});
  const party = {
    games: Number(stats && stats.games) || 0,
    wins: Number(stats && stats.wins) || 0,
    favourites: favourites(byGame),
  };
  const earned = badgesFor({ games: party.games, wins: party.wins, counters: isPlainObject(counters) ? counters : {}, dailyBest: Number(streak && streak.best) || 0 });
  const badges = liveBadges([...new Set([...earned, ...partySeason, ...idList(parseJsonSafe(row.badges, []), MAX_BADGES)])], catalog.badges);
  const clan = cleanClan(parseJsonSafe(row.clan, null));
  const profile = {
    username: row.username,
    name: displayNameOf(row, prof),
    avatar: prof && !Number(prof.missing) ? cleanAvatar(prof.avatar_url) : null,
    level: Number(row.level) || 0,
    xp: Number(row.xp) || 0,
    shards: view.showShards && row.shards !== null && row.shards !== undefined ? Number(row.shards) : null,
    badges,
    achievements: idList(parseJsonSafe(row.achievements, []), MAX_ACHIEVEMENTS),
    season: cleanSeason(parseJsonSafe(row.season, [])),
    clan,
    party,
    updatedAt: Number(row.updated) || null,
  };
  const pick = (list) => (Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, label: x.label, emoji: x.emoji || null, ...(x.image ? { image: x.image } : {}), ...(x.note ? { note: x.note } : {}) }));
  return json({ profile, partyBadges: PARTY_BADGES, catalog: { achievements: pick(catalog.achievements), badges: pick(catalog.badges) } }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function readVisibility(env, userId) {
  const [settings, row] = await Promise.all([
    env.DB.prepare('SELECT hidden, show_shards, claimed, updated FROM profile_settings WHERE user_id = ?').bind(userId).first(),
    env.DB.prepare('SELECT username, hidden, shards, updated FROM public_profiles WHERE user_id = ?').bind(userId).first(),
  ]);
  const base = row ? applySettings(row, settings) : settings ? applySettings({ hidden: 0, shards: null }, settings) : { hidden: false, showShards: false };
  return {
    hidden: base.hidden,
    showShards: base.showShards,
    pending: Boolean(settings && !Number(settings.claimed)),
    username: row ? row.username || null : null,
    exists: Boolean(row),
  };
}

async function setVisibility(request, env, userId, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (k !== 'hidden' && k !== 'showShards') throw new HttpError(400, 'bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw new HttpError(400, 'bad_hidden', '"hidden" must be true or false.');
  if (body.showShards !== undefined && typeof body.showShards !== 'boolean') throw new HttpError(400, 'bad_show_shards', '"showShards" must be true or false.');
  if (body.hidden === undefined && body.showShards === undefined) throw new HttpError(400, 'empty', 'There is nothing to change.');
  const now = await readVisibility(env, userId);
  const hidden = body.hidden === undefined ? now.hidden : body.hidden;
  const showShards = body.showShards === undefined ? now.showShards : body.showShards;
  const stmts = [
    env.DB
      .prepare('INSERT INTO profile_settings (user_id, hidden, show_shards, updated, given, claimed) VALUES (?, ?, ?, ?, 0, 0) ON CONFLICT (user_id) DO UPDATE SET hidden = excluded.hidden, show_shards = excluded.show_shards, updated = excluded.updated, claimed = 0')
      .bind(userId, hidden ? 1 : 0, showShards ? 1 : 0, t),
    env.DB.prepare('UPDATE public_profiles SET hidden = ? WHERE user_id = ?').bind(hidden ? 1 : 0, userId),
  ];
  if (!showShards) stmts.push(env.DB.prepare('UPDATE public_profiles SET shards = NULL WHERE user_id = ?').bind(userId));
  await env.DB.batch(stmts);
  return json({ ok: true, ...(await readVisibility(env, userId)) });
}

export function visibilityRoute(request, env, session, t) {
  const userId = String(session.user_id).toLowerCase();
  if (request.method === 'GET' || request.method === 'HEAD') return readVisibility(env, userId).then((v) => json(v));
  if (request.method === 'POST') return setVisibility(request, env, userId, t);
  return fail(405, 'method_not_allowed', 'That action is not allowed here.');
}
