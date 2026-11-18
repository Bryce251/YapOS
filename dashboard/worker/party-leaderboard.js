import { DAY, ID_RE, HttpError, json, fail, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanAvatar, cleanUsername } from './profiles.js';
import { safeName } from './public-profiles.js';
import { findBlocked } from '../web/activity/js/filter.js';
import { banLive } from './party-mod.js';
import { maskList, HIDDEN_NAME } from './hidden-names.js';

export const LEADERBOARD_GAMES = Object.freeze(['trivia', 'draw', 'chain', 'wyr', 'odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'hangman', 'story', 'musicquiz', 'sketchduel', 'typerace', 'memory', 'beatdrop', 'closest', 'namefive']);
export const LEADERBOARD_BOARDS = Object.freeze(['points', 'wins', 'games', 'best']);
export const DEFAULT_POINT_CAP = 25_000;
export const POINT_CAPS = Object.freeze({ trivia: 50_000, emoji: 30_000, musicquiz: 30_000, draw: 30_000, hive: 40_000 });
export const DAILY_POINTS_CAP = 100_000;
export const DAILY_GAMES_CAP = 60;
export const LEADERBOARD_LIMIT = 20;
export const LEADERBOARD_MAX = 50;
export const LEADERBOARD_TTL = 30_000;
export const POINTS_DAY_KEEP = 3 * DAY;
export const LEADERBOARD_PERIODS = Object.freeze(['all', 'month']);
export const MONTH_PRIZES = 3;
export const MONTH_KEEP = 3;
export const MONTH_GRACE = 10 * 60 * 1000;

const GAME_SET = new Set(LEADERBOARD_GAMES);
const BOARD_SET = new Set(LEADERBOARD_BOARDS);
const PERIOD_SET = new Set(LEADERBOARD_PERIODS);
const NAME_MAX = 64;
const cache = new WeakMap();

function bad(code, message) {
  return new HttpError(400, code, message);
}

export function pointCap(game) {
  return Object.prototype.hasOwnProperty.call(POINT_CAPS, game) ? POINT_CAPS[game] : DEFAULT_POINT_CAP;
}

export function countedPoints(game, score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(pointCap(game), Math.floor(n));
}

const GATE = 'SELECT CASE WHEN COALESCE((SELECT games FROM party_games_day WHERE user_id = ? AND day = ?), 0) >= ? THEN 0 ELSE 1 END AS g, MIN(?, MAX(0, ? - COALESCE((SELECT points FROM party_points_day WHERE user_id = ? AND day = ?), 0))) AS a';

export function pointsStatements(db, result, banned, day, t) {
  const stmts = [];
  for (const p of result.players) {
    if (banned && banned.has(p.id)) continue;
    const pts = countedPoints(result.game, p.score);
    const gate = [p.id, day, DAILY_GAMES_CAP, pts, DAILY_POINTS_CAP, p.id, day];
    const won = p.won ? 1 : 0;
    stmts.push(
      db.prepare(`INSERT INTO party_points (user_id, name, username, points, games, wins, best, best_game, updated) SELECT ?, ?, ?, a, 1, ?, ?, ?, ? FROM (${GATE}) WHERE g = 1 ON CONFLICT (user_id) DO UPDATE SET name = CASE WHEN excluded.name = '${HIDDEN_NAME}' THEN party_points.name ELSE excluded.name END, username = COALESCE(excluded.username, party_points.username), points = party_points.points + excluded.points, games = party_points.games + 1, wins = party_points.wins + excluded.wins, best_game = CASE WHEN excluded.best > party_points.best THEN excluded.best_game ELSE party_points.best_game END, best = MAX(party_points.best, excluded.best), updated = excluded.updated`)
        .bind(p.id, p.name, p.username, won, pts, result.game, t, ...gate),
      db.prepare(`INSERT INTO party_points_game (user_id, game, points, games, wins, best, updated) SELECT ?, ?, a, 1, ?, ?, ? FROM (${GATE}) WHERE g = 1 ON CONFLICT (user_id, game) DO UPDATE SET points = party_points_game.points + excluded.points, games = party_points_game.games + 1, wins = party_points_game.wins + excluded.wins, best = MAX(party_points_game.best, excluded.best), updated = excluded.updated`)
        .bind(p.id, result.game, won, pts, t, ...gate),
      db.prepare(`INSERT INTO party_points_month (user_id, month, points, games, wins, best, best_game, updated) SELECT ?, ?, a, 1, ?, ?, ?, ? FROM (${GATE}) WHERE g = 1 ON CONFLICT (user_id, month) DO UPDATE SET points = party_points_month.points + excluded.points, games = party_points_month.games + 1, wins = party_points_month.wins + excluded.wins, best_game = CASE WHEN excluded.best > party_points_month.best THEN excluded.best_game ELSE party_points_month.best_game END, best = MAX(party_points_month.best, excluded.best), updated = excluded.updated`)
        .bind(p.id, day.slice(0, 7), won, pts, result.game, t, ...gate),
      db.prepare(`INSERT INTO party_points_day (user_id, day, points) SELECT ?, ?, a FROM (${GATE}) WHERE g = 1 ON CONFLICT (user_id, day) DO UPDATE SET points = party_points_day.points + excluded.points`)
        .bind(p.id, day, ...gate),
      db.prepare(`INSERT INTO party_games_day (user_id, day, games) SELECT ?, ?, 1 FROM (${GATE}) WHERE g = 1 ON CONFLICT (user_id, day) DO UPDATE SET games = party_games_day.games + 1`)
        .bind(p.id, day, ...gate),
    );
  }
  return stmts;
}

export function monthOf(t) {
  return new Date(t).toISOString().slice(0, 7);
}

export function monthStart(month) {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

export function monthInfo(t) {
  const month = monthOf(t);
  const ends = monthStart(nextMonth(month));
  return { month, ends, daysLeft: Math.max(0, Math.ceil((ends - t) / DAY)), prizes: MONTH_PRIZES };
}

export function pointsCleanupStatements(db, t) {
  const keep = new Date(t - POINTS_DAY_KEEP).toISOString().slice(0, 10);
  return [db.prepare('DELETE FROM party_points_day WHERE day < ?').bind(keep), db.prepare('DELETE FROM party_games_day WHERE day < ?').bind(keep)];
}

export async function monthCleanup(db, t) {
  let oldest = monthOf(t);
  for (let i = 0; i < MONTH_KEEP; i++) oldest = prevMonth(oldest);
  const res = await db.prepare('DELETE FROM party_points_month WHERE month < ?').bind(oldest).run();
  return Number((res && res.meta && res.meta.changes) || 0);
}

export async function awardMonth(db, t) {
  if (t - monthStart(monthOf(t)) < MONTH_GRACE) return { month: null, awarded: 0 };
  const month = prevMonth(monthOf(t));
  const done = await db.prepare('SELECT 1 AS x FROM party_season_awards WHERE month = ? LIMIT 1').bind(month).first();
  if (done) return { month, awarded: 0 };
  const res = await db.prepare(`SELECT m.user_id AS user_id, m.points AS points, p.name AS name, p.username AS username FROM party_points_month m LEFT JOIN party_points p ON p.user_id = m.user_id WHERE m.month = ? AND m.points > 0 AND ${offBoard('m.user_id', t)} ORDER BY m.points DESC, m.updated ASC, m.user_id ASC LIMIT ?`).bind(month, MONTH_PRIZES).all();
  const rows = (res && res.results) || [];
  if (!rows.length) return { month, awarded: 0 };
  const out = await db.batch(rows.map((r, i) => db.prepare('INSERT OR IGNORE INTO party_season_awards (month, rank, user_id, name, username, points, awarded) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(month, i + 1, String(r.user_id).toLowerCase(), r.name || null, r.username || null, Number(r.points) || 0, t)));
  return { month, awarded: out.reduce((n, x) => n + Number((x && x.meta && x.meta.changes) || 0), 0) };
}

export function parseLeaderboardQuery(url) {
  const q = url.searchParams;
  const board = (q.get('board') || 'points').trim().toLowerCase();
  if (!BOARD_SET.has(board)) throw bad('bad_board', 'Pick a board: points, wins, games or best.');
  const game = (q.get('game') || 'all').trim().toLowerCase();
  if (game !== 'all' && !GAME_SET.has(game)) throw bad('bad_game', "That game isn't on the leaderboard.");
  const rawMe = (q.get('me') || '').trim();
  if (rawMe && !ID_RE.test(rawMe)) throw bad('bad_id', "That user id doesn't look right.");
  const n = Number.parseInt(q.get('limit') || '', 10);
  const limit = Number.isFinite(n) ? Math.min(LEADERBOARD_MAX, Math.max(1, n)) : LEADERBOARD_LIMIT;
  const period = (q.get('period') || 'all').trim().toLowerCase();
  if (!PERIOD_SET.has(period)) throw bad('bad_period', 'Pick a period: all or month.');
  if (period === 'month' && game !== 'all') throw bad('bad_game', 'The monthly board covers all games.');
  return { board, game, me: rawMe ? rawMe.toLowerCase() : null, limit, period };
}

function source(board, game, month = null) {
  if (month) {
    return { from: 'party_points_month m LEFT JOIN party_points p ON p.user_id = m.user_id', col: `m.${board}`, where: 'm.month = ?', binds: [month], alias: 'm', table: 'party_points_month', key: 'month' };
  }
  if (game === 'all') {
    return { from: 'party_points p', col: `p.${board}`, where: '1 = 1', binds: [] };
  }
  return { from: 'party_points_game g LEFT JOIN party_points p ON p.user_id = g.user_id', col: `g.${board}`, where: 'g.game = ?', binds: [game], game: true };
}

export const OFF_BOARD_SQL = 'NOT EXISTS (SELECT 1 FROM party_bans b WHERE b.id = {u} AND {live}) AND NOT EXISTS (SELECT 1 FROM party_board_hidden x WHERE x.user_id = LOWER({u}))';

export function offBoard(u, t = Date.now()) {
  return OFF_BOARD_SQL.replaceAll('{live}', banLive('b', t)).replaceAll('{u}', u);
}

export async function isOffBoard(db, id, t = Date.now()) {
  const row = await db.prepare(`SELECT 1 AS x FROM party_bans b WHERE b.id = ? AND ${banLive('b', t)} UNION ALL SELECT 1 AS x FROM party_board_hidden WHERE user_id = LOWER(?) LIMIT 1`).bind(id, id).first();
  return Boolean(row);
}

async function lookup(db, ids) {
  if (!ids.length) return { avatars: new Map(), handles: new Map(), names: new Map(), open: new Map(), hidden: new Set() };
  const marks = ids.map(() => '?').join(', ');
  const [prof, pub, settings] = await Promise.all([
    db.prepare(`SELECT id, username, display_name, avatar_url, missing FROM profiles WHERE id IN (${marks})`).bind(...ids).all(),
    db.prepare(`SELECT user_id, username, hidden, updated FROM public_profiles WHERE user_id IN (${marks})`).bind(...ids).all(),
    db.prepare(`SELECT user_id, hidden, claimed, updated FROM profile_settings WHERE user_id IN (${marks})`).bind(...ids).all(),
  ]);
  const avatars = new Map();
  const handles = new Map();
  const names = new Map();
  for (const r of (prof && prof.results) || []) {
    const id = String(r.id).toLowerCase();
    if (Number(r.missing)) continue;
    avatars.set(id, cleanAvatar(r.avatar_url));
    const u = cleanUsername(r.username);
    if (u) handles.set(id, u);
    const n = safeName(r.display_name, NAME_MAX, null);
    if (n) names.set(id, n);
  }
  const setMap = new Map(((settings && settings.results) || []).map((r) => [String(r.user_id).toLowerCase(), r]));
  const open = new Map();
  const hiddenSet = new Set();
  for (const r of (settings && settings.results) || []) {
    if (Number(r.hidden)) hiddenSet.add(String(r.user_id).toLowerCase());
  }
  for (const r of (pub && pub.results) || []) {
    const id = String(r.user_id).toLowerCase();
    const s = setMap.get(id);
    const fresh = s && (!Number(s.claimed) || Number(s.updated) >= Number(r.updated || 0));
    const hidden = fresh ? Boolean(Number(s.hidden)) : Boolean(Number(r.hidden));
    const u = cleanUsername(r.username);
    if (hidden) hiddenSet.add(id);
    else {
      hiddenSet.delete(id);
      if (u) open.set(id, u);
    }
  }
  return { avatars, handles, names, open, hidden: hiddenSet };
}

function cleanHandleOut(value) {
  const u = cleanUsername(value);
  return u && !findBlocked(u).length ? u : null;
}

async function buildBoard(db, board, game, limit, month = null) {
  const src = source(board, game, month);
  const al = src.alias || (src.game ? 'g' : 'p');
  const notBanned = offBoard(`${al}.user_id`);
  const idCol = `${al}.user_id`;
  const pick = src.game
    ? `${idCol} AS user_id, p.name AS name, p.username AS username, ${src.col} AS value, g.games AS games, g.wins AS wins, g.best AS best, g.game AS best_game`
    : `${idCol} AS user_id, p.name AS name, p.username AS username, ${src.col} AS value, ${al}.games AS games, ${al}.wins AS wins, ${al}.best AS best, ${al}.best_game AS best_game`;
  const updatedCol = `${al}.updated`;
  const [res, count] = await Promise.all([
    db.prepare(`SELECT ${pick} FROM ${src.from} WHERE ${src.where} AND ${src.col} > 0 AND ${notBanned} ORDER BY ${src.col} DESC, ${updatedCol} ASC, ${idCol} ASC LIMIT ?`).bind(...src.binds, limit).all(),
    db.prepare(`SELECT COUNT(*) AS n FROM ${src.from} WHERE ${src.where} AND ${src.col} > 0 AND ${notBanned}`).bind(...src.binds).first(),
  ]);
  const list = (res && res.results) || [];
  const ids = list.map((r) => String(r.user_id).toLowerCase());
  const found = await lookup(db, ids);
  let rank = 0;
  let last = null;
  const rows = list.map((r, i) => {
    const id = String(r.user_id).toLowerCase();
    const value = Number(r.value) || 0;
    if (value !== last) {
      rank = i + 1;
      last = value;
    }
    const shy = found.hidden.has(id);
    const linked = shy ? null : found.open.get(id) || null;
    const username = shy ? null : cleanHandleOut(linked || found.handles.get(id));
    const bestGame = typeof r.best_game === 'string' && GAME_SET.has(r.best_game) ? r.best_game : null;
    return {
      rank,
      id,
      name: found.names.get(id) || safeName(r.name, NAME_MAX, username || 'Player'),
      username,
      avatar: shy ? null : found.avatars.get(id) || null,
      value,
      games: Number(r.games) || 0,
      wins: Number(r.wins) || 0,
      best: Number(r.best) || 0,
      bestGame,
      link: Boolean(linked && username && linked.toLowerCase() === username.toLowerCase()),
    };
  });
  return { rows, total: Number(count && count.n) || 0 };
}

async function myRank(db, board, game, me, month = null) {
  if (!me) return null;
  if (await isOffBoard(db, me)) return null;
  const src = source(board, game, month);
  const own = month
    ? await db.prepare(`SELECT ${board} AS value FROM party_points_month WHERE user_id = ? AND month = ?`).bind(me, month).first()
    : src.game
    ? await db.prepare(`SELECT ${board} AS value FROM party_points_game WHERE user_id = ? AND game = ?`).bind(me, game).first()
    : await db.prepare(`SELECT ${board} AS value FROM party_points WHERE user_id = ?`).bind(me).first();
  const value = Number(own && own.value) || 0;
  if (value <= 0) return null;
  const notBanned = offBoard(`${src.alias || (src.game ? 'g' : 'p')}.user_id`);
  const above = await db.prepare(`SELECT COUNT(*) AS n FROM ${src.from} WHERE ${src.where} AND ${src.col} > ? AND ${notBanned}`).bind(...src.binds, value).first();
  return { rank: (Number(above && above.n) || 0) + 1, value };
}

export async function getLeaderboard(request, env, url, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('leaderboard', clientIp(request)), LIMITS.leaderboard, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const q = parseLeaderboardQuery(url);
  let boards = cache.get(env.DB);
  if (!boards) {
    boards = new Map();
    cache.set(env.DB, boards);
  }
  const info = q.period === 'month' ? monthInfo(t) : null;
  const month = info ? info.month : null;
  const key = `${q.board}|${q.game}|${q.limit}|${month || 'all'}`;
  let entry = boards.get(key);
  if (!entry || entry.at + LEADERBOARD_TTL < t || entry.at > t) {
    entry = { at: t, ...(await buildBoard(env.DB, q.board, q.game, q.limit, month)) };
    boards.set(key, entry);
    if (boards.size > 200) boards.delete(boards.keys().next().value);
  }
  const me = await myRank(env.DB, q.board, q.game, q.me, month);
  const rows = await maskList(env.DB, entry.rows, t, { link: ['link'] });
  const out = { board: q.board, game: q.game, period: q.period, rows, me, total: entry.total, updated: entry.at };
  if (info) out.month = info;
  return json(out, 200, { 'Cache-Control': 'public, max-age=30' });
}

export function clearLeaderboardCache(db) {
  if (db) cache.delete(db);
}
