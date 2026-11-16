import { MINUTE, DAY, ID_RE, HttpError, json, fail, readJson, isPlainObject, clientIp, publicOrigin, randomToken, parseJsonSafe, sha256Hex } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { cleanText } from './profiles.js';
import { reportIpHash } from './reports.js';
import { PARTY_BADGES, COUNTER_GAMES, COUNTER_KEYS, badgesFor, applySkills, SKILL_KEYS, SKILL_GAMES, SKILL_GAME_CAPS, PERFECT_MIN_QUESTIONS, PERFECT_MAX_QUESTIONS } from './party-badges.js';
import { MAX_PREDICTIONS, REASON_DAILY_LIMIT, loadRates, shardWants, shardStatement, shardTotals, shardReasonCounts, shardsPoll, ackShards, shardsCleanupStatements } from './party-shards.js';
import { ackSettings } from './public-profiles.js';
import { pointsStatements, pointsCleanupStatements } from './party-leaderboard.js';

export const PARTY_GAMES = Object.freeze(['trivia', 'draw', 'chain', 'wyr', 'odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'hangman', 'story', 'musicquiz', 'sketchduel', 'typerace', 'memory', 'beatdrop', 'closest', 'namefive']);
export const MAX_PLAYERS = 16;
export const MIN_COUNTED = 2;
export const PLAY_XP = 10;
export const WIN_XP = 15;
export const DAILY_XP_CAP = 200;
export const DEDUPE_MS = 2 * MINUTE;
export const RESULTS_BODY_LIMIT = 16 * 1024;
export const MAX_SCORE = 10_000_000;
export const XP_BATCH = 100;
export const MAX_ACK = 500;
export const MAX_STATS_IDS = 25;
export const XP_KEEP_CLAIMED = 2 * DAY;
export const XP_KEEP_UNCLAIMED = 30 * DAY;

const GAME_SET = new Set(PARTY_GAMES);
const NAME_MAX = 64;
const TEAM_MAX = 24;
const AT_PAST = DAY;
const AT_FUTURE = 5 * MINUTE;
const XP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL_VALUE_MAX = 1000;

function bad(code, message) {
  return new HttpError(400, code, message);
}

export function utcDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function cleanPlayerId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) throw bad('bad_id', "A player id doesn't look right.");
  return value.trim().toLowerCase();
}

function cleanHandle(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw bad('bad_username', "A player's username doesn't look right.");
  const text = cleanText(value.replace(/^@+/, ''), NAME_MAX);
  return text ? text.replace(/\s+/g, '') : null;
}

function cleanTeam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw bad('bad_team', "A team name doesn't look right.");
  return cleanText(value, TEAM_MAX);
}

function cleanScore(value) {
  const n = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_SCORE) throw bad('bad_score', "A score doesn't look right.");
  return Math.round(n);
}

export function cleanResult(body, t) {
  if (typeof body.game !== 'string' || !GAME_SET.has(body.game)) throw bad('bad_game', 'Only YapOS Party games can send results.');
  const at = Number(body.at);
  if (typeof body.at !== 'number' || !Number.isFinite(at) || at < t - AT_PAST || at > t + AT_FUTURE) throw bad('bad_time', "The game time doesn't look right.");
  if (!Array.isArray(body.players) || !body.players.length) throw bad('bad_players', 'Say who played.');
  if (body.players.length > MAX_PLAYERS) throw bad('bad_players', `A game can have at most ${MAX_PLAYERS} players.`);
  const seen = new Set();
  const players = body.players.map((p) => {
    if (!isPlainObject(p)) throw bad('bad_players', "A player doesn't look right.");
    const id = cleanPlayerId(p.id);
    if (seen.has(id)) throw bad('bad_players', 'The same player is listed twice.');
    seen.add(id);
    if (p.won !== undefined && typeof p.won !== 'boolean') throw bad('bad_won', "A player's win doesn't look right.");
    return {
      id,
      name: cleanText(p.name, NAME_MAX) || 'Player',
      username: cleanHandle(p.username),
      score: cleanScore(p.score),
      won: p.won === true,
      team: cleanTeam(p.team),
    };
  });
  const extra = {};
  if (body.extra !== undefined && body.extra !== null) {
    if (!isPlainObject(body.extra)) throw bad('bad_extra', "The extra game info doesn't look right.");
    for (const key of COUNTER_KEYS) {
      const list = body.extra[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list) || list.length > MAX_PLAYERS) throw bad('bad_extra', "The extra game info doesn't look right.");
      if (COUNTER_GAMES[key] !== body.game) continue;
      const ids = [...new Set(list.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase()))].filter((id) => seen.has(id));
      if (ids.length) extra[key] = ids;
    }
  }
  let tournament = null;
  if (body.extra !== undefined && body.extra !== null && body.extra.tournament !== undefined && body.extra.tournament !== null) {
    const tour = body.extra.tournament;
    if (!isPlainObject(tour) || typeof tour.winner !== 'string') throw bad('bad_extra', "The tournament info doesn't look right.");
    const winner = tour.winner.trim().toLowerCase();
    if (seen.has(winner)) tournament = winner;
  }
  const predictions = cleanPredictions(body.predictions, seen);
  const skills = cleanSkills(body.extra, body.game, players);
  return { game: body.game, at: Math.floor(at), players, extra, tournament, predictions, skills };
}

export function cleanSkills(raw, game, players) {
  const out = {};
  if (raw === undefined || raw === null || !isPlainObject(raw) || raw.skills === undefined || raw.skills === null) return out;
  const list = raw.skills;
  if (!isPlainObject(list) || Object.keys(list).length > MAX_PLAYERS) throw bad('bad_extra', "The extra game info doesn't look right.");
  let questions = 0;
  if (raw.questions !== undefined && raw.questions !== null) {
    if (typeof raw.questions !== 'number' || !Number.isInteger(raw.questions) || raw.questions < 0 || raw.questions > SKILL_VALUE_MAX) throw bad('bad_extra', "The extra game info doesn't look right.");
    questions = raw.questions;
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const [rawId, v] of Object.entries(list)) {
    if (!isPlainObject(v)) throw bad('bad_extra', "The extra game info doesn't look right.");
    const player = byId.get(rawId.trim().toLowerCase());
    const skill = {};
    for (const key of SKILL_KEYS) {
      const n = v[key];
      if (n === undefined || n === null) continue;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > SKILL_VALUE_MAX) throw bad('bad_extra', "The extra game info doesn't look right.");
      if (!n || !player) continue;
      if (SKILL_GAMES[key] && SKILL_GAMES[key] !== game) continue;
      if (key === 'p' && (questions < PERFECT_MIN_QUESTIONS || questions > PERFECT_MAX_QUESTIONS || player.score <= 0)) continue;
      if (key === 'c' && !player.won) continue;
      skill[key] = Math.min(n, SKILL_GAME_CAPS[key]);
    }
    if (player && Object.keys(skill).length) out[player.id] = skill;
  }
  return out;
}

function cleanPredictions(list, seen) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_PREDICTIONS) throw bad('bad_predictions', `Send at most ${MAX_PREDICTIONS} predictions.`);
  const watchers = new Set();
  const out = [];
  for (const p of list) {
    if (!isPlainObject(p)) throw bad('bad_predictions', "A prediction doesn't look right.");
    if (typeof p.id !== 'string' || !ID_RE.test(p.id.trim())) throw bad('bad_predictions', "A watcher id doesn't look right.");
    if (typeof p.pick !== 'string') throw bad('bad_predictions', "A prediction pick doesn't look right.");
    if (p.right !== undefined && typeof p.right !== 'boolean') throw bad('bad_predictions', "A prediction result doesn't look right.");
    const id = p.id.trim().toLowerCase();
    const pick = p.pick.trim().toLowerCase();
    if (watchers.has(id) || seen.has(id) || !seen.has(pick)) continue;
    watchers.add(id);
    out.push({ id, name: cleanText(p.name, NAME_MAX) || 'Watcher', username: cleanHandle(p.username), pick, right: p.right === true });
  }
  return out;
}

async function resultHash(result) {
  const players = result.players.map((p) => [p.id, p.score, p.won ? 1 : 0, p.team || '']).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return (await sha256Hex(JSON.stringify([result.game, players]))).slice(0, 40);
}

function readStats(row) {
  const byGame = parseJsonSafe(row && row.by_game, {});
  const counters = parseJsonSafe(row && row.counters, {});
  return {
    games: Number(row && row.games) || 0,
    wins: Number(row && row.wins) || 0,
    byGame: isPlainObject(byGame) ? byGame : {},
    counters: isPlainObject(counters) ? counters : {},
  };
}

async function idSet(db, table, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT id FROM ${table} WHERE id IN (${marks})`).bind(...ids).all();
  return new Set(((res && res.results) || []).map((r) => String(r.id).toLowerCase()));
}

export async function postResults(request, env, t) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  if (!origin || !expected || origin !== expected) return fail(403, 'forbidden', 'This was blocked for your safety. Reload the game and try again.');
  const ipHash = await reportIpHash(env, clientIp(request));
  const limit = await hit(env.DB, `results:ip:${ipHash}`, LIMITS.results, t);
  if (!limit.ok) return tooMany(limit.retryAfter, 'Lots of games are finishing at once. Try again in a minute.');
  const body = await readJson(request, RESULTS_BODY_LIMIT);
  const result = cleanResult(body, t);
  if (result.players.length < MIN_COUNTED) return json({ ok: true, counted: false, reason: 'solo' });
  const db = env.DB;
  const hash = await resultHash(result);
  const all = await hit(db, 'results:all', LIMITS.resultsAll, t);
  if (!all.ok) return tooMany(all.retryAfter, 'Lots of games are finishing at once. Try again in a minute.');
  const claim = await db.prepare('INSERT INTO party_results (hash, game, created) VALUES (?, ?, ?) ON CONFLICT (hash) DO UPDATE SET game = excluded.game, created = excluded.created WHERE party_results.created <= ?')
    .bind(hash, result.game, t, t - DEDUPE_MS)
    .run();
  if (!Number(claim && claim.meta && claim.meta.changes)) return json({ ok: true, counted: false, duplicate: true });
  const ids = result.players.map((p) => p.id);
  const everyone = [...new Set([...ids, ...result.predictions.map((w) => w.id)])];
  const marks = ids.map(() => '?').join(', ');
  const day = utcDay(t);
  const [statRes, xpRes, banned, rates, shardSums, reasonCounts] = await Promise.all([
    db.prepare(`SELECT user_id, games, wins, by_game, counters FROM party_stats WHERE user_id IN (${marks})`).bind(...ids).all(),
    db.prepare(`SELECT user_id, SUM(xp) AS total FROM party_xp WHERE day = ? AND user_id IN (${marks}) GROUP BY user_id`).bind(day, ...ids).all(),
    idSet(db, 'party_bans', everyone),
    loadRates(db),
    shardTotals(db, everyone, day),
    shardReasonCounts(db, everyone, day),
  ]);
  const stats = new Map(((statRes && statRes.results) || []).map((r) => [String(r.user_id), readStats(r)]));
  const earned = new Map(((xpRes && xpRes.results) || []).map((r) => [String(r.user_id), Number(r.total) || 0]));
  const stmts = [];
  const given = [];
  for (const p of result.players) {
    const s = stats.get(p.id) || readStats(null);
    s.games += 1;
    if (p.won) s.wins += 1;
    const g = isPlainObject(s.byGame[result.game]) ? s.byGame[result.game] : { p: 0, w: 0 };
    s.byGame[result.game] = { p: (Number(g.p) || 0) + 1, w: (Number(g.w) || 0) + (p.won ? 1 : 0) };
    for (const [key, list] of Object.entries(result.extra)) {
      if (list.includes(p.id)) s.counters[key] = (Number(s.counters[key]) || 0) + 1;
    }
    s.counters = applySkills(s.counters, { won: p.won, skill: result.skills[p.id], day });
    stmts.push(
      db.prepare('INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET games = excluded.games, wins = excluded.wins, by_game = excluded.by_game, counters = excluded.counters, updated = excluded.updated')
        .bind(p.id, s.games, s.wins, JSON.stringify(s.byGame), JSON.stringify(s.counters), t),
    );
    if (banned.has(p.id)) continue;
    const want = PLAY_XP + (p.won ? WIN_XP : 0);
    const xp = Math.min(want, Math.max(0, DAILY_XP_CAP - (earned.get(p.id) || 0)));
    if (xp <= 0) continue;
    earned.set(p.id, (earned.get(p.id) || 0) + xp);
    given.push({ id: p.id, xp });
    stmts.push(
      db.prepare('INSERT INTO party_xp (id, user_id, xp, game, won, day, at, claimed) SELECT ?, ?, MIN(?, ? - total), ?, ?, ?, ?, 0 FROM (SELECT COALESCE(SUM(xp), 0) AS total FROM party_xp WHERE user_id = ? AND day = ?) WHERE total < ?')
        .bind(randomToken(12), p.id, xp, DAILY_XP_CAP, result.game, p.won ? 1 : 0, day, t, p.id, day, DAILY_XP_CAP),
    );
  }
  stmts.push(...pointsStatements(db, result, banned, day, t));
  const shards = [];
  for (const want of shardWants(result, rates, banned)) {
    const room = Math.max(0, rates.cap - (shardSums.get(want.id) || 0));
    const amount = Math.min(want.shards, room);
    if (amount <= 0) continue;
    const limit = REASON_DAILY_LIMIT[want.reason];
    const key = `${want.id}|${want.reason}`;
    if (limit && (reasonCounts.get(key) || 0) >= limit) continue;
    if (limit) reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
    shardSums.set(want.id, (shardSums.get(want.id) || 0) + amount);
    shards.push({ id: want.id, shards: amount, reason: want.reason });
    stmts.push(shardStatement(db, { ...want, shards: amount }, result.game, day, t, rates.cap));
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    await db.prepare('DELETE FROM party_results WHERE hash = ? AND created = ?').bind(hash, t).run().catch(() => {});
    throw err;
  }
  return json({ ok: true, counted: true, xp: given, shards }, 201);
}

export async function partyPoll(db) {
  const [res, open] = await Promise.all([
    db.prepare('SELECT id, user_id, xp, game, won FROM party_xp WHERE claimed = 0 ORDER BY at ASC, id ASC LIMIT ?').bind(XP_BATCH).all(),
    db.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE status = 'open'").first(),
  ]);
  const xp = ((res && res.results) || []).map((r) => ({ id: r.id, user: r.user_id, xp: Number(r.xp), game: r.game, won: Boolean(r.won) }));
  const [shards, packOpen] = await Promise.all([
    shardsPoll(db),
    db.prepare("SELECT COUNT(*) AS n FROM pack_reports WHERE status = 'open'").first(),
  ]);
  return { xp, shards, reportsOpen: Number(open && open.n) || 0, packReportsOpen: Number(packOpen && packOpen.n) || 0 };
}

function ackList(body, key) {
  const list = body[key];
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) throw bad('bad_ids', `"${key}" must be a list.`);
  if (list.length > MAX_ACK) throw new HttpError(413, 'too_many', `Send at most ${MAX_ACK} ids at once.`);
  return [...new Set(list.filter((id) => typeof id === 'string' && XP_ID_RE.test(id)))];
}

export async function ackParty(request, env, t) {
  const body = await readJson(request, 96 * 1024);
  const ids = ackList(body, 'ids');
  const shardIds = ackList(body, 'shardIds');
  const profileIds = ackList(body, 'profileIds');
  if (!ids && !shardIds && !profileIds) throw bad('bad_ids', '"ids" must be a list.');
  let acked = 0;
  for (let i = 0; ids && i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await env.DB.prepare(`UPDATE party_xp SET claimed = ? WHERE claimed = 0 AND id IN (${part.map(() => '?').join(', ')})`).bind(t, ...part).run();
    acked += Number((res && res.meta && res.meta.changes) || 0);
  }
  const out = { ok: true, acked };
  if (shardIds) out.shardsAcked = shardIds.length ? await ackShards(env.DB, shardIds, t) : 0;
  if (profileIds) out.profilesAcked = profileIds.length ? await ackSettings(env.DB, profileIds.map((id) => id.toLowerCase())) : 0;
  return json(out);
}

export function favouriteGame(byGame) {
  let fav = null;
  let best = null;
  for (const [game, v] of Object.entries(byGame || {})) {
    if (!isPlainObject(v)) continue;
    const p = Number(v.p) || 0;
    const w = Number(v.w) || 0;
    if (p <= 0) continue;
    if (!best || p > best.p || (p === best.p && w > best.w) || (p === best.p && w === best.w && game < fav)) {
      fav = game;
      best = { p, w };
    }
  }
  return fav;
}

export function parseStatIds(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw bad('bad_ids', 'Say whose stats you want.');
  if (list.length > MAX_STATS_IDS) throw bad('too_many', `Ask for at most ${MAX_STATS_IDS} people at once.`);
  for (const id of list) if (!ID_RE.test(id)) throw bad('bad_id', "A user id doesn't look right.");
  return [...new Set(list.map((id) => id.toLowerCase()))];
}

export async function partyStats(env, url) {
  const ids = parseStatIds(url.searchParams.get('ids'));
  const marks = ids.map(() => '?').join(', ');
  const [statRes, streakRes] = await Promise.all([
    env.DB.prepare(`SELECT user_id, games, wins, by_game, counters FROM party_stats WHERE user_id IN (${marks})`).bind(...ids).all(),
    env.DB.prepare(`SELECT user_id, best FROM party_daily_streaks WHERE user_id IN (${marks})`).bind(...ids).all(),
  ]);
  const rows = new Map(((statRes && statRes.results) || []).map((r) => [String(r.user_id), r]));
  const streaks = new Map(((streakRes && streakRes.results) || []).map((r) => [String(r.user_id), Number(r.best) || 0]));
  const stats = {};
  for (const id of ids) {
    if (!rows.has(id) && !streaks.has(id)) continue;
    const s = readStats(rows.get(id));
    const byGame = {};
    for (const [game, v] of Object.entries(s.byGame)) {
      if (isPlainObject(v)) byGame[game] = { p: Number(v.p) || 0, w: Number(v.w) || 0 };
    }
    stats[id] = {
      games: s.games,
      wins: s.wins,
      fav: favouriteGame(byGame),
      byGame,
      badges: badgesFor({ games: s.games, wins: s.wins, counters: s.counters, dailyBest: streaks.get(id) || 0 }),
    };
  }
  return json({ stats, badges: PARTY_BADGES });
}

export function resultsCleanupStatements(db, t) {
  return [
    db.prepare('DELETE FROM party_results WHERE created < ?').bind(t - 10 * MINUTE),
    db.prepare('DELETE FROM party_xp WHERE (claimed > 0 AND at < ?) OR at < ?').bind(t - XP_KEEP_CLAIMED, t - XP_KEEP_UNCLAIMED),
    ...shardsCleanupStatements(db, t),
    ...pointsCleanupStatements(db, t),
  ];
}
