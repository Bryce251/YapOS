import { DAY, SECOND, MINUTE, HttpError, json, readJson, randomToken } from './util.js';

export const SHARD_REASONS = Object.freeze(['play', 'win', 'tournament', 'prediction', 'daily', 'streak']);
export const DEFAULT_RATES = Object.freeze({ play: 10, win: 25, tournament: 100, prediction: 15 });
export const RATE_BOUNDS = Object.freeze({ play: [0, 100], win: [0, 250], tournament: [0, 1000], prediction: [0, 100] });
export const RATE_KEYS = Object.freeze(Object.keys(DEFAULT_RATES));
export const OLD_RATE_KEYS = Object.freeze(['cap']);
export const SHARD_BATCH = 100;
export const MAX_PREDICTIONS = 16;
export const SHARDS_KEEP_CLAIMED = 2 * DAY;
export const SHARDS_KEEP_UNCLAIMED = 30 * DAY;
export const PAY_GAP_MS = Object.freeze({ play: 30 * SECOND, win: 30 * SECOND, tournament: 10 * MINUTE, prediction: 60 * SECOND });
export const DAILY_PUZZLE_SHARDS = 25;
export const DAILY_STREAK_STEP = 5;
export const DAILY_STREAK_MAX = 50;
export const DAILY_STREAK_GAME = 'daily';

export const SHARDS_ALERT_DAY = 4000;
export const HOLD_KINDS = Object.freeze(['shards_day', 'farm', 'fast', 'same_name', 'reported', 'game_cap']);

const RATES_ID = 'party';

function clampOne(key, value) {
  const [lo, hi] = RATE_BOUNDS[key];
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

export function clampRates(raw, base = DEFAULT_RATES) {
  const out = {};
  for (const key of RATE_KEYS) {
    const v = raw ? raw[key] : undefined;
    out[key] = typeof v === 'number' && Number.isFinite(v) ? clampOne(key, v) : clampOne(key, Number(base[key]) || 0);
  }
  return out;
}

export async function loadRates(db) {
  const row = await db.prepare('SELECT play, win, tournament, prediction FROM party_rates WHERE id = ?').bind(RATES_ID).first();
  if (!row) return { ...DEFAULT_RATES };
  const nums = {};
  for (const key of RATE_KEYS) nums[key] = Number(row[key]);
  return clampRates(nums);
}

export async function postRates(request, env, t) {
  const body = await readJson(request, 4 * 1024);
  for (const key of Object.keys(body)) {
    if (OLD_RATE_KEYS.includes(key)) continue;
    if (!RATE_KEYS.includes(key)) throw new HttpError(400, 'bad_request', `Unknown field "${key.slice(0, 40)}".`);
    const v = body[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'bad_rate', `"${key}" must be a number.`);
  }
  const current = await loadRates(env.DB);
  const rates = clampRates(body, current);
  await env.DB
    .prepare('INSERT INTO party_rates (id, play, win, tournament, prediction, cap, updated) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO UPDATE SET play = excluded.play, win = excluded.win, tournament = excluded.tournament, prediction = excluded.prediction, cap = 0, updated = excluded.updated')
    .bind(RATES_ID, rates.play, rates.win, rates.tournament, rates.prediction, t)
    .run();
  return json({ ok: true, rates });
}

export async function getRates(env) {
  return json({ rates: await loadRates(env.DB), defaults: DEFAULT_RATES, bounds: RATE_BOUNDS, daily: { puzzle: DAILY_PUZZLE_SHARDS, streakStep: DAILY_STREAK_STEP, streakMax: DAILY_STREAK_MAX } });
}

export function shardWants(result, rates, banned) {
  const wants = [];
  const winners = new Set(result.players.filter((p) => p.won).map((p) => p.id));
  const decided = winners.size > 0 && winners.size < result.players.length;
  const players = new Set(result.players.map((p) => p.id));
  for (const p of result.players) {
    if (banned.has(p.id)) continue;
    if (rates.play > 0) wants.push({ id: p.id, reason: 'play', shards: rates.play });
    if (decided && p.won && rates.win > 0) wants.push({ id: p.id, reason: 'win', shards: rates.win });
    if (result.tournament && result.tournament === p.id && rates.tournament > 0) wants.push({ id: p.id, reason: 'tournament', shards: rates.tournament });
  }
  if (decided && rates.prediction > 0) {
    const seen = new Set();
    for (const w of result.predictions || []) {
      if (banned.has(w.id) || players.has(w.id) || seen.has(w.id) || !w.right || !winners.has(w.pick)) continue;
      seen.add(w.id);
      wants.push({ id: w.id, reason: 'prediction', shards: rates.prediction });
    }
  }
  return wants;
}

export function shardStatement(db, want, game, day, t) {
  const gap = PAY_GAP_MS[want.reason] || 0;
  return db
    .prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM party_shards WHERE user_id = ? AND reason = ? AND at > ?)')
    .bind(randomToken(12), want.id, want.shards, want.reason, game, t, day, want.id, want.reason, t - gap);
}

export async function recentShards(db, ids, t) {
  if (!ids.length) return new Map();
  const reasons = Object.keys(PAY_GAP_MS);
  const longest = Math.max(...Object.values(PAY_GAP_MS));
  const marks = ids.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT user_id, reason, MAX(at) AS last FROM party_shards WHERE user_id IN (${marks}) AND reason IN (${reasons.map(() => '?').join(', ')}) AND at > ? GROUP BY user_id, reason`)
    .bind(...ids, ...reasons, t - longest)
    .all();
  const out = new Map();
  for (const r of (res && res.results) || []) out.set(`${r.user_id}|${r.reason}`, Number(r.last) || 0);
  return out;
}

export async function shardHolds(db, ids, day) {
  if (!ids.length) return { held: new Set(), today: new Map() };
  const marks = ids.map(() => '?').join(', ');
  const [alertRes, sumRes] = await Promise.all([
    db.prepare(`SELECT DISTINCT user_id FROM party_cheat_alerts WHERE status = 'open' AND kind IN (${HOLD_KINDS.map(() => '?').join(', ')}) AND user_id IN (${marks})`).bind(...HOLD_KINDS, ...ids).all(),
    db.prepare(`SELECT user_id, SUM(shards) AS total FROM party_shards WHERE day = ? AND user_id IN (${marks}) GROUP BY user_id`).bind(day, ...ids).all(),
  ]);
  const held = new Set(((alertRes && alertRes.results) || []).map((r) => String(r.user_id)));
  const today = new Map(((sumRes && sumRes.results) || []).map((r) => [String(r.user_id), Number(r.total) || 0]));
  return { held, today };
}

export function tooSoon(recent, want, t) {
  const gap = PAY_GAP_MS[want.reason] || 0;
  const last = recent.get(`${want.id}|${want.reason}`);
  return Boolean(gap && last && last > t - gap);
}

export function streakShards(streak) {
  const n = Math.max(0, Math.floor(Number(streak) || 0));
  return n < 2 ? 0 : Math.min(DAILY_STREAK_MAX, n * DAILY_STREAK_STEP);
}

export function dailyShardAmounts(streak) {
  const bonus = streakShards(streak);
  return bonus > 0 ? [DAILY_PUZZLE_SHARDS, bonus] : [DAILY_PUZZLE_SHARDS];
}

export function dailyShardStatements(db, user, kind, streak, day, t) {
  const stmts = [
    db
      .prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM party_shards WHERE user_id = ? AND reason = ? AND game = ? AND day = ?)')
      .bind(randomToken(12), user, DAILY_PUZZLE_SHARDS, 'daily', kind, t, day, user, 'daily', kind, day),
  ];
  const bonus = streakShards(streak);
  if (bonus > 0) {
    stmts.push(
      db
        .prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM party_shards WHERE user_id = ? AND reason = ? AND day = ?)')
        .bind(randomToken(12), user, bonus, 'streak', DAILY_STREAK_GAME, t, day, user, 'streak', day),
    );
  }
  return stmts;
}

export async function shardsPoll(db) {
  const res = await db.prepare('SELECT id, user_id, shards, reason, game FROM party_shards WHERE claimed = 0 ORDER BY at ASC, id ASC LIMIT ?').bind(SHARD_BATCH).all();
  return ((res && res.results) || []).map((r) => ({ id: r.id, user: r.user_id, shards: Number(r.shards), reason: r.reason, game: r.game }));
}

export async function ackShards(db, ids, t) {
  let acked = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const res = await db.prepare(`UPDATE party_shards SET claimed = ? WHERE claimed = 0 AND id IN (${part.map(() => '?').join(', ')})`).bind(t, ...part).run();
    acked += Number((res && res.meta && res.meta.changes) || 0);
  }
  return acked;
}

export function shardsCleanupStatements(db, t) {
  return [db.prepare('DELETE FROM party_shards WHERE (claimed > 0 AND at < ?) OR at < ?').bind(t - SHARDS_KEEP_CLAIMED, t - SHARDS_KEEP_UNCLAIMED)];
}
