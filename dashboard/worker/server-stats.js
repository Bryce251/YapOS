import { HOUR, DAY, SERVER_ID_RE, HttpError, json, readJson, isPlainObject } from './util.js';

export const MAX_STAT_HOURS = 744;
export const STATS_BODY_LIMIT = 128 * 1024;
export const STATS_KEEP = 90 * DAY;
export const STATS_PAST = 60 * DAY;
export const STAT_DAYS = Object.freeze([7, 30]);
const MAX_COUNT = 10_000_000;
const COUNT_KEYS = ['messages', 'joins', 'leaves', 'active'];

function bad(code, message) {
  return new HttpError(400, code, message);
}

function count(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_COUNT, Math.floor(value));
}

export function cleanHours(list, t) {
  if (!Array.isArray(list)) throw bad('bad_hours', '"hours" must be a list.');
  if (list.length > MAX_STAT_HOURS) throw new HttpError(413, 'too_many', `Send at most ${MAX_STAT_HOURS} hours at once.`);
  const byHour = new Map();
  let ignored = 0;
  for (const h of list) {
    if (!isPlainObject(h) || typeof h.hour !== 'string' || h.hour.length > 40) {
      ignored += 1;
      continue;
    }
    const at = Date.parse(h.hour);
    if (!Number.isFinite(at) || at < t - STATS_PAST || at > t + HOUR) {
      ignored += 1;
      continue;
    }
    const row = { hour: Math.floor(at / HOUR) * HOUR };
    let ok = true;
    for (const key of COUNT_KEYS) {
      const n = count(h[key]);
      if (n === null) ok = false;
      row[key] = n;
    }
    if (!ok) {
      ignored += 1;
      continue;
    }
    byHour.set(row.hour, row);
  }
  return { rows: [...byHour.values()].sort((a, b) => a.hour - b.hour), ignored };
}

export async function postStats(request, env, t) {
  const body = await readJson(request, STATS_BODY_LIMIT);
  if (typeof body.server_id !== 'string' || !SERVER_ID_RE.test(body.server_id)) throw bad('bad_id', "That server id doesn't look right.");
  const sid = body.server_id.toLowerCase();
  const { rows, ignored } = cleanHours(body.hours, t);
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(
      rows.slice(i, i + 50).map((r) =>
        env.DB
          .prepare('INSERT INTO server_stats (server_id, hour, messages, joins, leaves, active, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (server_id, hour) DO UPDATE SET messages = excluded.messages, joins = excluded.joins, leaves = excluded.leaves, active = excluded.active, updated = excluded.updated')
          .bind(sid, r.hour, r.messages, r.joins, r.leaves, r.active, t),
      ),
    );
  }
  return json({ ok: true, stored: rows.length, ignored });
}

export function parseDays(raw) {
  if (raw === null || raw === undefined || raw === '') return 7;
  const n = Number(raw);
  if (!STAT_DAYS.includes(n)) throw bad('bad_days', 'Pick 7 or 30 days.');
  return n;
}

export function summarize(rows, days, t) {
  const end = Math.floor(t / HOUR) * HOUR;
  const start = end - days * DAY + HOUR;
  const totals = { messages: 0, joins: 0, leaves: 0 };
  const byDay = new Map();
  const hourOfDay = Array(24).fill(0);
  const hours = [];
  let peakActive = 0;
  let updatedAt = 0;
  for (const r of rows) {
    const hour = Number(r.hour);
    if (hour < start || hour > end) continue;
    const row = { hour: new Date(hour).toISOString(), messages: Number(r.messages) || 0, joins: Number(r.joins) || 0, leaves: Number(r.leaves) || 0, active: Number(r.active) || 0 };
    hours.push(row);
    totals.messages += row.messages;
    totals.joins += row.joins;
    totals.leaves += row.leaves;
    peakActive = Math.max(peakActive, row.active);
    updatedAt = Math.max(updatedAt, Number(r.updated) || 0);
    hourOfDay[new Date(hour).getUTCHours()] += row.messages;
    const day = row.hour.slice(0, 10);
    const d = byDay.get(day) || { day, messages: 0, joins: 0, leaves: 0, active: 0 };
    d.messages += row.messages;
    d.joins += row.joins;
    d.leaves += row.leaves;
    d.active = Math.max(d.active, row.active);
    byDay.set(day, d);
  }
  const daily = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end - i * DAY).toISOString().slice(0, 10);
    daily.push(byDay.get(day) || { day, messages: 0, joins: 0, leaves: 0, active: 0 });
  }
  const busiest = hourOfDay.map((n) => Math.round((n / days) * 10) / 10);
  let busiestHour = null;
  for (let h = 0; h < 24; h += 1) if (hourOfDay[h] > 0 && (busiestHour === null || hourOfDay[h] > hourOfDay[busiestHour])) busiestHour = h;
  return { days, hours, daily, totals: { ...totals, net: totals.joins - totals.leaves, peakActive }, busiest, busiestHour, updatedAt: updatedAt || null };
}

export async function readStats(db, sid, days, t) {
  const end = Math.floor(t / HOUR) * HOUR;
  const res = await db
    .prepare('SELECT hour, messages, joins, leaves, active, updated FROM server_stats WHERE server_id = ? AND hour >= ? AND hour <= ? ORDER BY hour ASC')
    .bind(sid.toLowerCase(), end - days * DAY + HOUR, end)
    .all();
  return summarize((res && res.results) || [], days, t);
}

export function statsCleanupStatements(db, t) {
  return [db.prepare('DELETE FROM server_stats WHERE hour < ?').bind(t - STATS_KEEP)];
}
