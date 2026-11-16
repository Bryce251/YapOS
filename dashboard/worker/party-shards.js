import { DAY, HttpError, json, readJson, randomToken } from './util.js';

export const SHARD_REASONS = Object.freeze(['play', 'win', 'tournament', 'prediction']);
export const DEFAULT_RATES = Object.freeze({ play: 5, win: 15, tournament: 25, prediction: 5, cap: 150 });
export const RATE_BOUNDS = Object.freeze({ play: [0, 50], win: [0, 100], tournament: [0, 250], prediction: [0, 25], cap: [0, 1000] });
export const RATE_KEYS = Object.freeze(Object.keys(DEFAULT_RATES));
export const SHARD_BATCH = 100;
export const MAX_PREDICTIONS = 16;
export const SHARDS_KEEP_CLAIMED = 2 * DAY;
export const SHARDS_KEEP_UNCLAIMED = 30 * DAY;
export const REASON_DAILY_LIMIT = Object.freeze({ tournament: 3, prediction: 10 });

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
  const row = await db.prepare('SELECT play, win, tournament, prediction, cap FROM party_rates WHERE id = ?').bind(RATES_ID).first();
  if (!row) return { ...DEFAULT_RATES };
  const nums = {};
  for (const key of RATE_KEYS) nums[key] = Number(row[key]);
  return clampRates(nums);
}

export async function postRates(request, env, t) {
  const body = await readJson(request, 4 * 1024);
  for (const key of Object.keys(body)) {
    if (!RATE_KEYS.includes(key)) throw new HttpError(400, 'bad_request', `Unknown field "${key.slice(0, 40)}".`);
    const v = body[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'bad_rate', `"${key}" must be a number.`);
  }
  const current = await loadRates(env.DB);
  const rates = clampRates(body, current);
  await env.DB
    .prepare('INSERT INTO party_rates (id, play, win, tournament, prediction, cap, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET play = excluded.play, win = excluded.win, tournament = excluded.tournament, prediction = excluded.prediction, cap = excluded.cap, updated = excluded.updated')
    .bind(RATES_ID, rates.play, rates.win, rates.tournament, rates.prediction, rates.cap, t)
    .run();
  return json({ ok: true, rates });
}

export async function getRates(env) {
  return json({ rates: await loadRates(env.DB), defaults: DEFAULT_RATES, bounds: RATE_BOUNDS });
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

export function shardStatement(db, want, game, day, t, cap) {
  const limit = REASON_DAILY_LIMIT[want.reason];
  if (!limit) {
    return db
      .prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) SELECT ?, ?, MIN(?, ? - total), ?, ?, ?, ?, 0 FROM (SELECT COALESCE(SUM(shards), 0) AS total FROM party_shards WHERE user_id = ? AND day = ?) WHERE total < ?')
      .bind(randomToken(12), want.id, want.shards, cap, want.reason, game, t, day, want.id, day, cap);
  }
  return db
    .prepare('INSERT INTO party_shards (id, user_id, shards, reason, game, at, day, claimed) SELECT ?, ?, MIN(?, ? - total), ?, ?, ?, ?, 0 FROM (SELECT COALESCE(SUM(shards), 0) AS total, COALESCE(SUM(CASE WHEN reason = ? THEN 1 ELSE 0 END), 0) AS times FROM party_shards WHERE user_id = ? AND day = ?) WHERE total < ? AND times < ?')
    .bind(randomToken(12), want.id, want.shards, cap, want.reason, game, t, day, want.reason, want.id, day, cap, limit);
}

export async function shardTotals(db, ids, day) {
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT user_id, SUM(shards) AS total FROM party_shards WHERE day = ? AND user_id IN (${marks}) GROUP BY user_id`).bind(day, ...ids).all();
  return new Map(((res && res.results) || []).map((r) => [String(r.user_id), Number(r.total) || 0]));
}

export async function shardReasonCounts(db, ids, day) {
  const reasons = Object.keys(REASON_DAILY_LIMIT);
  if (!ids.length || !reasons.length) return new Map();
  const marks = ids.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT user_id, reason, COUNT(*) AS n FROM party_shards WHERE day = ? AND reason IN (${reasons.map(() => '?').join(', ')}) AND user_id IN (${marks}) GROUP BY user_id, reason`)
    .bind(day, ...reasons, ...ids)
    .all();
  const out = new Map();
  for (const r of (res && res.results) || []) out.set(`${r.user_id}|${r.reason}`, Number(r.n) || 0);
  return out;
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
