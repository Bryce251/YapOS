import { HttpError, isPlainObject, parseJsonSafe } from './util.js';
import { LEADERBOARD_GAMES, pointCap, monthOf, clearLeaderboardCache, offBoard } from './party-leaderboard.js';
import { clearPartyProfileCache } from './party-profile.js';
import { PARTY_GAMES, PARTY_BADGE_COUNTERS } from '../web/js/community-data.js';

export const PARTY_POINTS_MAX = 1e9;
export const PARTY_RECORD_MAX = 1e6;
export const PARTY_COUNTER_MAX = 100000;

export const PARTY_COUNTERS = PARTY_BADGE_COUNTERS;

const COUNTER_KEYS = new Set(PARTY_COUNTERS.map((c) => c.key));
const GAME_SET = new Set(LEADERBOARD_GAMES);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const PARTY_OWNER_KINDS = Object.freeze({
  'party.points.set': Object.freeze({ label: 'Set all-time Party points', input: 'amount', min: 0, max: PARTY_POINTS_MAX, gift: false, instant: true }),
  'party.record.set': Object.freeze({ label: 'Set Party games and wins', input: 'record', min: 0, max: PARTY_RECORD_MAX, gift: false, instant: true }),
  'party.best.set': Object.freeze({ label: 'Set best Party game', input: 'best', min: 0, max: PARTY_POINTS_MAX, gift: false, instant: true }),
  'party.game.set': Object.freeze({ label: 'Set points for one Party game', input: 'game', min: 0, max: PARTY_POINTS_MAX, gift: false, instant: true }),
  'party.month.set': Object.freeze({ label: "Set this month's Party points", input: 'amount', min: 0, max: PARTY_POINTS_MAX, gift: false, instant: true }),
  'party.counters.set': Object.freeze({ label: 'Set Party badge counters', input: 'counters', min: 0, max: PARTY_COUNTER_MAX, gift: false, instant: true }),
  'party.reset': Object.freeze({ label: 'Reset Party leaderboard stats', input: 'reset', gift: false, instant: true }),
  'party.board.hide': Object.freeze({ label: 'Remove from Party leaderboards', input: 'none', gift: false, instant: true }),
  'party.board.show': Object.freeze({ label: 'Show on Party leaderboards again', input: 'none', gift: false, instant: true }),
});

function bad(message) {
  return new HttpError(400, 'bad_value', message);
}

function nice(n) {
  return Number(n).toLocaleString('en-US');
}

export function gameName(id) {
  return Object.prototype.hasOwnProperty.call(PARTY_GAMES, id) ? PARTY_GAMES[id].name : id;
}

function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function pickGame(raw) {
  const game = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!game) throw bad('Pick a game first.');
  if (!GAME_SET.has(game)) throw bad("That game isn't on the Party leaderboard.");
  return game;
}

export function validatePartyValue(spec, raw, parseAmount) {
  if (spec.input === 'record') {
    if (!isPlainObject(raw)) throw bad('Say how many games and wins they should have.');
    if (raw.games === undefined || raw.wins === undefined) throw bad('Fill in both games and wins.');
    const games = parseAmount(raw.games, spec);
    const wins = parseAmount(raw.wins, spec);
    if (wins > games) throw bad("Wins can't be more than games played.");
    return { games, wins };
  }
  if (spec.input === 'best') {
    if (!isPlainObject(raw)) throw bad('Say the best score and which game it was in.');
    const score = parseAmount(raw.score, spec);
    if (!score) return { score: 0, game: null };
    const game = pickGame(raw.game);
    const cap = pointCap(game);
    if (score > cap) throw bad(`One ${gameName(game)} game counts at most ${nice(cap)} points.`);
    return { score, game };
  }
  if (spec.input === 'game') {
    if (!isPlainObject(raw)) throw bad('Pick a game and type the points.');
    const game = pickGame(raw.game);
    return { game, points: parseAmount(raw.points, spec) };
  }
  if (spec.input === 'counters') {
    if (!isPlainObject(raw)) throw bad('Type at least one counter.');
    const out = {};
    for (const [key, v] of Object.entries(raw)) {
      if (!COUNTER_KEYS.has(key)) throw bad(`"${key.slice(0, 40)}" isn't a Party badge counter.`);
      out[key] = parseAmount(v, spec);
    }
    if (!Object.keys(out).length) throw bad('Type at least one counter.');
    return out;
  }
  if (spec.input === 'reset') {
    if (raw === undefined || raw === null) return { badges: false };
    if (!isPlainObject(raw)) throw bad('Send the reset choices as an object.');
    for (const k of Object.keys(raw)) if (k !== 'badges') throw bad(`Unknown reset choice "${k.slice(0, 40)}".`);
    if (raw.badges !== undefined && typeof raw.badges !== 'boolean') throw bad('"badges" must be true or false.');
    return { badges: raw.badges === true };
  }
  return null;
}

function num(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

function utcDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

async function rankAbove(db, sql, binds) {
  const row = await db.prepare(sql).bind(...binds).first();
  return (Number(row && row.n) || 0) + 1;
}

export async function partyBoardView(db, id, t, counters = {}) {
  const month = monthOf(t);
  const day = utcDay(t);
  const [pts, byGame, mon, today, todayGames, hidden, banned] = await Promise.all([
    db.prepare('SELECT points, games, wins, best, best_game FROM party_points WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT game, points, games, wins, best FROM party_points_game WHERE user_id = ? ORDER BY points DESC, game ASC').bind(id).all(),
    db.prepare('SELECT points, games, wins FROM party_points_month WHERE user_id = ? AND month = ?').bind(id, month).first(),
    db.prepare('SELECT points FROM party_points_day WHERE user_id = ? AND day = ?').bind(id, day).first(),
    db.prepare('SELECT games FROM party_games_day WHERE user_id = ? AND day = ?').bind(id, day).first(),
    db.prepare('SELECT by_id, at FROM party_board_hidden WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT 1 AS x FROM party_bans WHERE id = ?').bind(id).first(),
  ]);
  const points = num(pts && pts.points);
  const monthPoints = num(mon && mon.points);
  const off = Boolean(hidden || banned);
  const [rank, monthRank] = await Promise.all([
    !off && points > 0 ? rankAbove(db, `SELECT COUNT(*) AS n FROM party_points p WHERE p.points > ? AND ${offBoard('p.user_id')}`, [points]) : null,
    !off && monthPoints > 0 ? rankAbove(db, `SELECT COUNT(*) AS n FROM party_points_month m WHERE m.month = ? AND m.points > ? AND ${offBoard('m.user_id')}`, [month, monthPoints]) : null,
  ]);
  const c = isPlainObject(counters) ? counters : {};
  const bestGame = pts && typeof pts.best_game === 'string' && GAME_SET.has(pts.best_game) ? pts.best_game : null;
  return {
    points,
    games: num(pts && pts.games),
    wins: num(pts && pts.wins),
    best: num(pts && pts.best),
    bestGame,
    rank,
    month: { month, points: monthPoints, games: num(mon && mon.games), wins: num(mon && mon.wins), rank: monthRank },
    today: { points: num(today && today.points), games: num(todayGames && todayGames.games) },
    byGame: ((byGame && byGame.results) || [])
      .filter((r) => GAME_SET.has(r.game))
      .map((r) => ({ game: r.game, points: num(r.points), games: num(r.games), wins: num(r.wins), best: num(r.best) })),
    counters: Object.fromEntries(PARTY_COUNTERS.map((x) => [x.key, num(c[x.key])])),
    hidden: Boolean(hidden),
    hiddenAt: hidden ? Number(hidden.at) || null : null,
    banned: Boolean(banned),
  };
}

function upsertPoints(db, user, column, value, t) {
  return db.prepare(`INSERT INTO party_points (user_id, ${column}, updated) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET ${column} = excluded.${column}, updated = excluded.updated`).bind(user, value, t);
}

function bestText(best, game) {
  return best > 0 ? `${nice(best)} in ${game ? gameName(game) : 'an unknown game'}` : 'none';
}

export async function partyActionPlan(db, a, ownerId, t) {
  const user = a.user;
  const v = a.value;
  const read = () => db.prepare('SELECT points, games, wins, best, best_game FROM party_points WHERE user_id = ?').bind(user).first();
  if (a.kind === 'party.stats.add') {
    return {
      result: `Added ${nice(v.games)} ${v.games === 1 ? 'game' : 'games'} and ${nice(v.wins)} ${v.wins === 1 ? 'win' : 'wins'} to their Party stats.`,
      stmts: [
        db.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, ?, ?, '{}', '{}', ?) ON CONFLICT (user_id) DO UPDATE SET games = party_stats.games + excluded.games, wins = party_stats.wins + excluded.wins, updated = excluded.updated")
          .bind(user, v.games, v.wins, t),
      ],
    };
  }
  if (a.kind === 'party.points.set') {
    const was = await read();
    return {
      result: `Set their all-time Party points to ${nice(v)} (was ${nice(num(was && was.points))}). Per-game and monthly points did not change.`,
      stmts: [upsertPoints(db, user, 'points', v, t)],
    };
  }
  if (a.kind === 'party.record.set') {
    const was = await read();
    return {
      result: `Set their Party record to ${nice(v.games)} ${v.games === 1 ? 'game' : 'games'} and ${nice(v.wins)} ${v.wins === 1 ? 'win' : 'wins'} (was ${nice(num(was && was.games))} and ${nice(num(was && was.wins))}). Leaderboards, profile and badges all use the new numbers.`,
      stmts: [
        db.prepare('INSERT INTO party_points (user_id, games, wins, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET games = excluded.games, wins = excluded.wins, updated = excluded.updated').bind(user, v.games, v.wins, t),
        db.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, ?, ?, '{}', '{}', ?) ON CONFLICT (user_id) DO UPDATE SET games = excluded.games, wins = excluded.wins, updated = excluded.updated").bind(user, v.games, v.wins, t),
      ],
    };
  }
  if (a.kind === 'party.best.set') {
    const was = await read();
    const before = bestText(num(was && was.best), was && was.best_game);
    return {
      result: v.score ? `Set their best game to ${bestText(v.score, v.game)} (was ${before}).` : `Cleared their best game (was ${before}).`,
      stmts: [
        db.prepare('INSERT INTO party_points (user_id, best, best_game, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET best = excluded.best, best_game = excluded.best_game, updated = excluded.updated').bind(user, v.score, v.game, t),
      ],
    };
  }
  if (a.kind === 'party.game.set') {
    const [was, row] = await Promise.all([
      read(),
      db.prepare('SELECT points, best FROM party_points_game WHERE user_id = ? AND game = ?').bind(user, v.game).first(),
    ]);
    const old = num(row && row.points);
    const total = num(was && was.points);
    const after = Math.max(0, total + v.points - old);
    const moved = after - total;
    const tail = moved === 0
      ? 'All-time points did not change.'
      : `All-time points went ${moved > 0 ? 'up' : 'down'} by ${nice(Math.abs(moved))} to ${nice(after)}, so they still add up.`;
    const lowered = [];
    if (num(row && row.best) > v.points) lowered.push(`their best ${gameName(v.game)} game`);
    if (was && was.best_game === v.game && num(was.best) > v.points) lowered.push('their all-time best game');
    const bestTail = lowered.length ? ` Lowered ${lowered.join(' and ')} to ${nice(v.points)} to match.` : '';
    const delta = 'SELECT ? - COALESCE((SELECT points FROM party_points_game WHERE user_id = ? AND game = ?), 0)';
    const stmts = [
      db.prepare(`INSERT INTO party_points (user_id, points, updated) SELECT ?, MAX(0, d), ? FROM (${delta} AS d) WHERE d != 0 ON CONFLICT (user_id) DO UPDATE SET points = MAX(0, party_points.points + (${delta})), updated = excluded.updated`)
        .bind(user, t, v.points, user, v.game, v.points, user, v.game),
      db.prepare('INSERT INTO party_points_game (user_id, game, points, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, game) DO UPDATE SET points = excluded.points, best = MIN(party_points_game.best, excluded.points), updated = excluded.updated').bind(user, v.game, v.points, t),
      db.prepare('UPDATE party_points SET best = ?, best_game = CASE WHEN ? > 0 THEN best_game ELSE NULL END WHERE user_id = ? AND best_game = ? AND best > ?').bind(v.points, v.points, user, v.game, v.points),
    ];
    return { result: `Set their ${gameName(v.game)} points to ${nice(v.points)} (was ${nice(old)}). ${tail}${bestTail}`, stmts };
  }
  if (a.kind === 'party.month.set') {
    const month = monthOf(t);
    const row = await db.prepare('SELECT points FROM party_points_month WHERE user_id = ? AND month = ?').bind(user, month).first();
    return {
      result: `Set their Party points for ${monthName(month)} to ${nice(v)} (was ${nice(num(row && row.points))}). All-time points did not change.`,
      stmts: [
        db.prepare('INSERT INTO party_points_month (user_id, month, points, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, month) DO UPDATE SET points = excluded.points, updated = excluded.updated').bind(user, month, v, t),
      ],
    };
  }
  if (a.kind === 'party.counters.set') {
    const row = await db.prepare('SELECT counters FROM party_stats WHERE user_id = ?').bind(user).first();
    const stored = parseJsonSafe(row && row.counters, {});
    const counters = isPlainObject(stored) ? { ...stored } : {};
    const parts = [];
    for (const c of PARTY_COUNTERS) {
      if (!Object.prototype.hasOwnProperty.call(v, c.key)) continue;
      parts.push(`${c.label} ${nice(num(counters[c.key]))} → ${nice(v[c.key])}`);
      counters[c.key] = v[c.key];
    }
    if (Object.prototype.hasOwnProperty.call(v, 'bestWinStreak') && num(counters.winStreak) > v.bestWinStreak) counters.winStreak = v.bestWinStreak;
    return {
      result: `Set their Party badge counters: ${parts.join(', ')}. Badges follow straight away.`,
      stmts: [
        db.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, 0, 0, '{}', ?, ?) ON CONFLICT (user_id) DO UPDATE SET counters = excluded.counters, updated = excluded.updated").bind(user, JSON.stringify(counters), t),
      ],
    };
  }
  if (a.kind === 'party.reset') {
    const was = await read();
    const stmts = [
      db.prepare('DELETE FROM party_points WHERE user_id = ?').bind(user),
      db.prepare('DELETE FROM party_points_game WHERE user_id = ?').bind(user),
      db.prepare('DELETE FROM party_points_month WHERE user_id = ?').bind(user),
      db.prepare('DELETE FROM party_points_day WHERE user_id = ?').bind(user),
      db.prepare('DELETE FROM party_games_day WHERE user_id = ?').bind(user),
    ];
    if (v.badges) {
      stmts.push(
        db.prepare("UPDATE party_stats SET games = 0, wins = 0, by_game = '{}', counters = '{}', updated = ? WHERE user_id = ?").bind(t, user),
        db.prepare('DELETE FROM party_daily_streaks WHERE user_id = ?').bind(user),
      );
    }
    const before = was ? `${nice(num(was.points))} points from ${nice(num(was.games))} ${num(was.games) === 1 ? 'game' : 'games'}` : 'nothing on the boards';
    return {
      result: `Reset their Party leaderboard stats: all-time, every game, monthly and today's limits (was ${before}). ${v.badges ? 'Badge stats, counters and the daily streak were reset too.' : 'Badge stats, counters and the daily streak were kept.'}`,
      stmts,
    };
  }
  if (a.kind === 'party.board.hide') {
    const already = await db.prepare('SELECT 1 AS x FROM party_board_hidden WHERE user_id = ?').bind(user).first();
    return {
      result: already ? 'They were already off the Party leaderboards.' : 'Removed them from every Party leaderboard and from monthly prizes. They can still play, and their stats are kept.',
      stmts: [db.prepare('INSERT INTO party_board_hidden (user_id, by_id, at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING').bind(user, String(ownerId).toLowerCase(), t)],
    };
  }
  if (a.kind === 'party.board.show') {
    const already = await db.prepare('SELECT 1 AS x FROM party_board_hidden WHERE user_id = ?').bind(user).first();
    return {
      result: already ? 'They show on the Party leaderboards again.' : 'They were already on the Party leaderboards.',
      stmts: [db.prepare('DELETE FROM party_board_hidden WHERE user_id = ?').bind(user)],
    };
  }
  return null;
}

export function partyActionDone(db) {
  clearLeaderboardCache(db);
  clearPartyProfileCache(db);
}
