import { DAY, SECOND, randomToken } from './util.js';
import { cleanText } from './profiles.js';
import { pointCap, DAILY_POINTS_CAP, DAILY_GAMES_CAP } from './party-leaderboard.js';
import { PARTY_GAMES } from '../web/js/community-data.js';

export const CHEAT_WINDOW_DAYS = 7;
export const CHEAT_CAP_DAYS = 2;
export const CHEAT_WIN_GAMES = 20;
export const CHEAT_WIN_RATE = 0.9;
export const CHEAT_PAIR_GAMES = 15;
export const CHEAT_PAIR_RATE = 0.9;
export const CHEAT_FAST_MS = 20 * SECOND;
export const CHEAT_FAST_GAMES = 5;
export const CHEAT_REOPEN_MS = 7 * DAY;
export const CHEAT_DAYS_KEEP = 8 * DAY;
export const CHEAT_HANDLED_KEEP = 90 * DAY;
export const CHEAT_LIST_MAX = 200;
export const CHEAT_KINDS = Object.freeze({
  daily_points: 'Daily points cap',
  daily_games: 'Daily games cap',
  game_cap: 'Score at the game cap',
  win_rate: 'Win rate',
  farm: 'Same opponent again and again',
  fast: 'Games too close together',
  same_name: 'Same name as the other player',
  reported: 'Reported for cheating',
});
export const CHEAT_REPORTERS = 2;

export const ALERT_COLUMNS = 'id, user_id, kind, name, detail, first_at, last_at, count, status, handled_by, handled_at';
const NAME_MAX = 64;

function gameName(id) {
  return Object.prototype.hasOwnProperty.call(PARTY_GAMES, id) ? PARTY_GAMES[id].name : id;
}

function nice(n) {
  return Number(n).toLocaleString('en-US');
}

function percent(a, b) {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

function dayBefore(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
}

function upsert(db, { id, name, kind, detail, bump }, t) {
  return db
    .prepare(`INSERT INTO party_cheat_alerts (id, user_id, kind, name, detail, first_at, last_at, count, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open') ON CONFLICT (user_id, kind) DO UPDATE SET detail = excluded.detail, name = COALESCE(excluded.name, party_cheat_alerts.name), last_at = excluded.last_at, count = party_cheat_alerts.count + ?, status = CASE WHEN party_cheat_alerts.status = 'open' THEN 'open' WHEN ? = 1 AND excluded.last_at - COALESCE(party_cheat_alerts.handled_at, 0) > ? THEN 'open' ELSE party_cheat_alerts.status END`)
    .bind(randomToken(12), id, kind, cleanText(name, NAME_MAX), detail, t, t, bump ? 1 : 0, bump ? 1 : 0, CHEAT_REOPEN_MS);
}

function rows(res) {
  return (res && res.results) || [];
}

export async function detectCheats(db, result, banned, day, t) {
  const players = result.players.filter((p) => !(banned && banned.has(p.id)));
  if (!players.length) return [];
  const ids = players.map((p) => p.id);
  const marks = ids.map(() => '?').join(', ');
  const names = new Map(players.map((p) => [p.id, p.name]));
  const since = dayBefore(day, CHEAT_WINDOW_DAYS - 1);
  const alerts = [];
  const [pointsRes, gamesRes, statsRes] = await Promise.all([
    db.prepare(`SELECT user_id, points FROM party_points_day WHERE day = ? AND user_id IN (${marks})`).bind(day, ...ids).all(),
    db.prepare(`SELECT user_id, games FROM party_games_day WHERE day = ? AND user_id IN (${marks})`).bind(day, ...ids).all(),
    db.prepare(`SELECT user_id, games, wins FROM party_stats WHERE user_id IN (${marks})`).bind(...ids).all(),
  ]);
  const capped = [];
  for (const r of rows(pointsRes)) if (Number(r.points) >= DAILY_POINTS_CAP) capped.push([String(r.user_id), 'points']);
  for (const r of rows(gamesRes)) if (Number(r.games) >= DAILY_GAMES_CAP) capped.push([String(r.user_id), 'games']);
  for (const [id, kind] of capped) {
    const ins = await db.prepare('INSERT INTO party_cheat_days (user_id, day, kind) VALUES (?, ?, ?) ON CONFLICT (user_id, kind, day) DO NOTHING').bind(id, day, kind).run();
    if (!Number(ins && ins.meta && ins.meta.changes)) continue;
    const seen = await db.prepare('SELECT COUNT(*) AS n FROM party_cheat_days WHERE user_id = ? AND kind = ? AND day >= ? AND day <= ?').bind(id, kind, since, day).first();
    const n = Number(seen && seen.n) || 0;
    if (n < CHEAT_CAP_DAYS) continue;
    const detail = kind === 'points'
      ? `Hit the ${nice(DAILY_POINTS_CAP)} daily points cap on ${n} of the last ${CHEAT_WINDOW_DAYS} days`
      : `Hit the ${nice(DAILY_GAMES_CAP)} daily games cap on ${n} of the last ${CHEAT_WINDOW_DAYS} days`;
    alerts.push({ id, name: names.get(id), kind: `daily_${kind}`, detail, bump: true });
  }
  const cap = pointCap(result.game);
  for (const p of players) {
    if (Number(p.score) >= cap) alerts.push({ id: p.id, name: p.name, kind: 'game_cap', detail: `${nice(p.score)} in one ${gameName(result.game)} game = the cap`, bump: true });
  }
  for (const r of rows(statsRes)) {
    const games = Number(r.games) || 0;
    const wins = Number(r.wins) || 0;
    if (games >= CHEAT_WIN_GAMES && wins / games >= CHEAT_WIN_RATE) {
      const id = String(r.user_id);
      alerts.push({ id, name: names.get(id), kind: 'win_rate', detail: `Won ${nice(wins)} of ${nice(games)} Party games (${percent(wins, games)}%)`, bump: false });
    }
  }
  if (result.players.length === 2) {
    const [x, y] = result.players.slice().sort((p, q) => (p.id < q.id ? -1 : 1));
    if (x.name && y.name && x.name.trim().toLowerCase() === y.name.trim().toLowerCase()) {
      for (const p of [x, y]) {
        if (!banned || !banned.has(p.id)) alerts.push({ id: p.id, name: p.name, kind: 'same_name', detail: `Played a two-player game against someone with the same name ("${cleanText(p.name, NAME_MAX)}")`, bump: true });
      }
    }
    await db
      .prepare('INSERT INTO party_cheat_pairs (a, b, day, games, wins_a, wins_b, fast, last_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?) ON CONFLICT (a, b, day) DO UPDATE SET games = party_cheat_pairs.games + 1, wins_a = party_cheat_pairs.wins_a + excluded.wins_a, wins_b = party_cheat_pairs.wins_b + excluded.wins_b, fast = party_cheat_pairs.fast + CASE WHEN ABS(excluded.last_at - party_cheat_pairs.last_at) < ? THEN 1 ELSE 0 END, last_at = excluded.last_at')
      .bind(x.id, y.id, day, x.won ? 1 : 0, y.won ? 1 : 0, result.at, CHEAT_FAST_MS)
      .run();
    const pair = await db.prepare('SELECT games, wins_a, wins_b, fast FROM party_cheat_pairs WHERE a = ? AND b = ? AND day = ?').bind(x.id, y.id, day).first();
    const games = Number(pair && pair.games) || 0;
    const winsA = Number(pair && pair.wins_a) || 0;
    const winsB = Number(pair && pair.wins_b) || 0;
    const [top, other, wins] = winsA >= winsB ? [x, y, winsA] : [y, x, winsB];
    if (games >= CHEAT_PAIR_GAMES && wins / games >= CHEAT_PAIR_RATE && (!banned || !banned.has(top.id))) {
      alerts.push({ id: top.id, name: top.name, kind: 'farm', detail: `Won ${wins} of ${games} two-player games against the same person (${cleanText(other.name, NAME_MAX) || 'Player'}) today`, bump: games === CHEAT_PAIR_GAMES });
    }
    const fast = Number(pair && pair.fast) || 0;
    if (fast >= CHEAT_FAST_GAMES && (!banned || !banned.has(top.id))) {
      alerts.push({ id: top.id, name: top.name, kind: 'fast', detail: `${fast} two-player games with ${cleanText(other.name, NAME_MAX) || 'the same person'} finished under ${CHEAT_FAST_MS / SECOND} seconds apart today`, bump: fast === CHEAT_FAST_GAMES });
    }
  }
  if (alerts.length) await db.batch(alerts.map((a) => upsert(db, a, t)));
  return alerts;
}

export async function cheatReportAlert(db, who, t) {
  if (!who || typeof who.id !== 'string') return null;
  const row = await db
    .prepare("SELECT COUNT(DISTINCT r.reporter_id) AS people, COUNT(DISTINCT r.ip_hash) AS ips FROM party_reports r JOIN party_report_reasons z ON z.report_id = r.id WHERE r.drawer_id = ? AND z.reason = 'cheating' AND r.status = 'open' AND r.created > ?")
    .bind(who.id, t - CHEAT_WINDOW_DAYS * DAY)
    .first();
  const people = Math.min(Number(row && row.people) || 0, Number(row && row.ips) || 0);
  if (people < CHEAT_REPORTERS) return null;
  const alert = { id: who.id, name: who.name, kind: 'reported', detail: `Reported for cheating by ${people} different players in the last ${CHEAT_WINDOW_DAYS} days`, bump: true };
  await upsert(db, alert, t).run();
  return alert;
}

export function cheatsCleanupStatements(db, t) {
  const keep = new Date(t - CHEAT_DAYS_KEEP).toISOString().slice(0, 10);
  return [
    db.prepare('DELETE FROM party_cheat_days WHERE day < ?').bind(keep),
    db.prepare('DELETE FROM party_cheat_pairs WHERE day < ?').bind(keep),
    db.prepare("DELETE FROM party_cheat_alerts WHERE status <> 'open' AND COALESCE(handled_at, last_at) < ?").bind(t - CHEAT_HANDLED_KEEP),
  ];
}
