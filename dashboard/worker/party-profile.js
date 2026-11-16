import { ID_RE, json, fail, isPlainObject, parseJsonSafe, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanAvatar, cleanUsername } from './profiles.js';
import { safeName } from './public-profiles.js';
import { badgesFor } from './party-badges.js';
import { readCatalog } from './owner.js';
import { LEADERBOARD_GAMES } from './party-leaderboard.js';
import { findBlocked } from '../web/activity/js/filter.js';

export const CARD_TTL = 30_000;
export const CARD_CACHE_MAX = 500;
export const CARD_BADGES = 24;
export const CARD_ACHIEVEMENTS = 24;
export const CARD_FAVOURITES = 3;
const NAME_MAX = 64;
const CLAN_NAME_MAX = 32;
const CLAN_TAG_MAX = 6;
const MAX_LEVEL = 100000;
const BADGE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const TAG_RE = /^[\p{L}\p{N}]+$/u;
const GAME_SET = new Set(LEADERBOARD_GAMES);
const MISSING = "We couldn't find a profile for that player.";
const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=30' };
const cache = new WeakMap();

export function xpForLevel(level) {
  const l = Math.max(0, Math.floor(Number(level) || 0));
  return 5 * l * l + 50 * l + 100;
}

export function levelProgress(level, xp) {
  const lvl = Math.min(MAX_LEVEL, Math.max(0, Math.floor(Number(level) || 0)));
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  let base = 0;
  for (let l = 0; l < lvl && l < 1000; l++) base += xpForLevel(l);
  const need = xpForLevel(lvl);
  return { into: Math.max(0, Math.min(need, total - base)), need };
}

function handle(value) {
  const u = cleanUsername(value);
  return u && !findBlocked(u).length ? u : null;
}

function ids(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !BADGE_RE.test(v)) continue;
    const id = v.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, max);
}

function clanOf(raw) {
  const value = parseJsonSafe(raw, null);
  if (!isPlainObject(value)) return null;
  const name = safeName(value.name, CLAN_NAME_MAX, null);
  if (!name) return null;
  const tag = typeof value.tag === 'string' && value.tag.length <= CLAN_TAG_MAX && TAG_RE.test(value.tag) && !findBlocked(value.tag).length ? value.tag : null;
  const colour = typeof value.colour === 'string' && COLOUR_RE.test(value.colour) ? value.colour.toLowerCase() : null;
  return { name, tag, colour };
}

function pretty(id) {
  const text = id.replace(/[-_]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : id;
}

function label(list, id) {
  const hit = list.find((x) => x && x.id === id);
  const text = hit && typeof hit.label === 'string' && hit.label.trim() ? safeName(hit.label, 48, pretty(id)) : pretty(id);
  const emoji = hit && typeof hit.emoji === 'string' && hit.emoji.length <= 16 ? hit.emoji : null;
  return { id, label: text, emoji };
}

function favourites(byGame) {
  return Object.entries(isPlainObject(byGame) ? byGame : {})
    .filter(([game, v]) => GAME_SET.has(game) && isPlainObject(v) && Number(v.p) > 0)
    .map(([game, v]) => ({ game, played: Math.floor(Number(v.p)) || 0, won: Math.floor(Number(v.w)) || 0 }))
    .sort((a, b) => b.played - a.played || b.won - a.won || (a.game < b.game ? -1 : 1))
    .slice(0, CARD_FAVOURITES);
}

function visible(row, settings) {
  const fresh = settings && (!row || !Number(settings.claimed) || Number(settings.updated) >= Number(row.updated || 0));
  if (fresh) return { hidden: Boolean(Number(settings.hidden)), showShards: Boolean(Number(settings.show_shards)) };
  if (!row) return { hidden: false, showShards: false };
  return { hidden: Boolean(Number(row.hidden)), showShards: row.shards !== null && row.shards !== undefined };
}

async function rankOf(db, id, points) {
  if (!(points > 0)) return null;
  const banned = await db.prepare('SELECT 1 AS x FROM party_bans WHERE id = ?').bind(id).first();
  if (banned) return null;
  const above = await db
    .prepare('SELECT COUNT(*) AS n FROM party_points p WHERE p.points > ? AND NOT EXISTS (SELECT 1 FROM party_bans b WHERE b.id = p.user_id)')
    .bind(points)
    .first();
  return { rank: (Number(above && above.n) || 0) + 1, points };
}

export async function buildCard(db, rawId) {
  const id = rawId.toLowerCase();
  const pair = id === rawId ? [id, id] : [id, rawId];
  const [pub, settings, prof, stats, streak, pts, catalog] = await Promise.all([
    db.prepare('SELECT username, name, level, xp, shards, badges, achievements, clan, hidden, updated FROM public_profiles WHERE user_id IN (?, ?) ORDER BY updated DESC LIMIT 1').bind(...pair).first(),
    db.prepare('SELECT hidden, show_shards, claimed, updated FROM profile_settings WHERE user_id IN (?, ?) ORDER BY updated DESC LIMIT 1').bind(...pair).first(),
    db.prepare('SELECT username, display_name, avatar_url, missing FROM profiles WHERE id IN (?, ?) ORDER BY fetched DESC LIMIT 1').bind(...pair).first(),
    db.prepare('SELECT games, wins, by_game, counters FROM party_stats WHERE user_id IN (?, ?) ORDER BY updated DESC LIMIT 1').bind(...pair).first(),
    db.prepare('SELECT best FROM party_daily_streaks WHERE user_id IN (?, ?) ORDER BY best DESC LIMIT 1').bind(...pair).first(),
    db.prepare('SELECT user_id, name, username, points FROM party_points WHERE user_id IN (?, ?) ORDER BY points DESC LIMIT 1').bind(...pair).first(),
    readCatalog(db).catch(() => ({ achievements: [], badges: [] })),
  ]);
  if (!pub && !prof && !stats && !pts) return null;
  const known = prof && !Number(prof.missing) ? prof : null;
  const avatar = known ? cleanAvatar(known.avatar_url) : null;
  const callName = known ? safeName(known.display_name, NAME_MAX, null) : null;
  const view = visible(pub, settings);
  if (view.hidden) return { hidden: true, name: callName, avatar };
  const username = handle(pub && pub.username) || handle(known && known.username) || handle(pts && pts.username);
  const name = (pub && safeName(pub.name, NAME_MAX, null)) || callName || (pts && safeName(pts.name, NAME_MAX, null)) || username || 'Player';
  const games = Math.max(0, Math.floor(Number(stats && stats.games) || 0));
  const wins = Math.max(0, Math.floor(Number(stats && stats.wins) || 0));
  const counters = parseJsonSafe(stats && stats.counters, {});
  const bestStreak = Math.max(0, Math.floor(Number(streak && streak.best) || 0));
  const earned = badgesFor({ games, wins, counters: isPlainObject(counters) ? counters : {}, dailyBest: bestStreak });
  const badgeIds = [...new Set([...earned, ...ids(parseJsonSafe(pub && pub.badges, []), 64)])];
  const achievementIds = ids(parseJsonSafe(pub && pub.achievements, []), CARD_ACHIEVEMENTS);
  const badgeList = Array.isArray(catalog.badges) ? catalog.badges : [];
  const achList = Array.isArray(catalog.achievements) ? catalog.achievements : [];
  const level = pub ? Math.min(MAX_LEVEL, Math.max(0, Math.floor(Number(pub.level) || 0))) : null;
  const xp = pub ? Math.max(0, Math.floor(Number(pub.xp) || 0)) : null;
  const shards = view.showShards && pub && pub.shards !== null && pub.shards !== undefined ? Math.max(0, Math.floor(Number(pub.shards) || 0)) : null;
  return {
    hidden: false,
    name,
    username,
    avatar,
    level,
    xp,
    progress: level === null ? null : levelProgress(level, xp),
    shards,
    badges: badgeIds.slice(0, CARD_BADGES).map((b) => label(badgeList, b)),
    badgeCount: badgeIds.length,
    achievements: achievementIds.map((a) => label(achList, a)),
    clan: pub ? clanOf(pub.clan) : null,
    party: { games, wins, bestStreak, favourites: favourites(parseJsonSafe(stats && stats.by_game, {})) },
    rank: await rankOf(db, pts ? String(pts.user_id) : id, Math.floor(Number(pts && pts.points) || 0)),
    page: Boolean(pub && username && handle(pub.username) === username),
  };
}

export async function getPartyProfile(request, env, raw, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('partyProfile', clientIp(request)), LIMITS.partyProfile, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  if (typeof raw !== 'string' || !ID_RE.test(raw)) return fail(404, 'not_found', MISSING, undefined, CACHE_HEADERS);
  let cards = cache.get(env.DB);
  if (!cards) {
    cards = new Map();
    cache.set(env.DB, cards);
  }
  const key = raw.toLowerCase();
  let entry = cards.get(key);
  if (!entry || entry.at + CARD_TTL < t || entry.at > t) {
    entry = { at: t, card: await buildCard(env.DB, raw) };
    cards.delete(key);
    cards.set(key, entry);
    if (cards.size > CARD_CACHE_MAX) cards.delete(cards.keys().next().value);
  }
  if (!entry.card) return fail(404, 'not_found', MISSING, undefined, CACHE_HEADERS);
  return json({ profile: entry.card }, 200, CACHE_HEADERS);
}

export function clearPartyProfileCache(db) {
  if (db) cache.delete(db);
}
