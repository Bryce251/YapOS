import { HttpError, json, fail, readJson, isPlainObject, parseJsonSafe, clientIp, ID_RE } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanUsername } from './profiles.js';
import { safeName } from './public-profiles.js';
import { hiddenNameMap, flagsFor, maskEntry } from './hidden-names.js';

export const SEASON_BOARDS = Object.freeze(['xp', 'shards']);
export const SEASON_TOP = 10;
export const MAX_SEASONS = 120;
export const SEASON_BODY_LIMIT = 32 * 1024;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_VALUE = 1e15;
const cache = new WeakMap();

function bad(code, message) {
  return new HttpError(400, code, message);
}

export function monthOf(t) {
  return new Date(t).toISOString().slice(0, 7);
}

function cleanBoard(list, name) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('bad_board', `The ${name} board must be a list.`);
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!isPlainObject(e)) continue;
    const id = typeof e.id === 'string' && ID_RE.test(e.id) ? e.id.toLowerCase() : null;
    if (id && seen.has(id)) continue;
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
    if (id) seen.add(id);
    const username = cleanUsername(e.username);
    out.push({
      rank: typeof e.rank === 'number' && Number.isInteger(e.rank) && e.rank >= 1 ? e.rank : out.length + 1,
      id,
      name: safeName(e.name, 64, username || 'Player'),
      username,
      value: Math.min(MAX_VALUE, Math.max(0, Math.floor(e.value))),
    });
  }
  out.sort((a, b) => a.rank - b.rank || b.value - a.value);
  return out.slice(0, SEASON_TOP).map((e, i) => ({ ...e, rank: Math.max(e.rank, i + 1) }));
}

export async function postSeason(request, env, t) {
  const body = await readJson(request, SEASON_BODY_LIMIT);
  if (typeof body.month !== 'string' || !MONTH_RE.test(body.month)) throw bad('bad_month', 'The month must look like 2026-10.');
  if (body.month >= monthOf(t)) throw bad('bad_month', 'Only finished seasons can be saved.');
  if (!isPlainObject(body.boards)) throw bad('bad_boards', '"boards" must be an object.');
  const boards = {};
  for (const key of SEASON_BOARDS) boards[key] = cleanBoard(body.boards[key], key);
  if (!SEASON_BOARDS.some((k) => boards[k].length)) throw bad('empty', 'The season has no one on its boards.');
  await env.DB
    .prepare('INSERT INTO season_history (month, boards, updated) VALUES (?, ?, ?) ON CONFLICT (month) DO UPDATE SET boards = excluded.boards, updated = excluded.updated')
    .bind(body.month, JSON.stringify(boards), t)
    .run();
  cache.delete(env.DB);
  return json({ ok: true, month: body.month, xp: boards.xp.length, shards: boards.shards.length });
}

async function buildSeasons(db) {
  const res = await db.prepare('SELECT month, boards, updated FROM season_history ORDER BY month DESC LIMIT ?').bind(MAX_SEASONS).all();
  const rows = (res && res.results) || [];
  const seasons = rows.map((r) => {
    const raw = parseJsonSafe(r.boards, {});
    const boards = {};
    for (const key of SEASON_BOARDS) boards[key] = cleanBoard(isPlainObject(raw) ? raw[key] : [], key);
    return { month: r.month, boards, updated: Number(r.updated) || null };
  });
  const names = [...new Set(seasons.flatMap((s) => SEASON_BOARDS.flatMap((k) => s.boards[k].map((e) => (e.username ? e.username.toLowerCase() : null)))).filter(Boolean))];
  const open = new Set();
  for (let i = 0; i < names.length; i += 90) {
    const part = names.slice(i, i + 90);
    const found = await db.prepare(`SELECT DISTINCT username_key FROM public_profiles WHERE hidden = 0 AND username_key IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
    for (const r of (found && found.results) || []) open.add(r.username_key);
  }
  const hiddenNow = await db.prepare('SELECT user_id FROM profile_settings WHERE claimed = 0 AND hidden = 1').all();
  const hiddenIds = new Set(((hiddenNow && hiddenNow.results) || []).map((r) => r.user_id));
  return seasons.map((s) => {
    const boards = {};
    for (const key of SEASON_BOARDS) {
      boards[key] = s.boards[key].map((e) => ({
        id: e.id,
        rank: e.rank,
        name: e.name,
        username: e.username,
        value: e.value,
        profile: Boolean(e.username && open.has(e.username.toLowerCase()) && !(e.id && hiddenIds.has(e.id))),
      }));
    }
    return { month: s.month, boards, updated: s.updated };
  });
}

export async function getSeasons(request, env, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('seasons', clientIp(request)), LIMITS.seasons, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  let entry = cache.get(env.DB);
  if (!entry || entry.at + 60_000 < t || entry.at > t) {
    entry = { at: t, seasons: await buildSeasons(env.DB) };
    cache.set(env.DB, entry);
  }
  const hidden = await hiddenNameMap(env.DB, t);
  const shown = (e) => {
    const { id, ...rest } = e;
    const flags = id ? flagsFor(hidden, id) : null;
    return flags ? maskEntry(rest, flags, id, { link: ['profile'] }) : rest;
  };
  const seasons = entry.seasons.map((s) => ({ ...s, boards: Object.fromEntries(Object.entries(s.boards).map(([k, list]) => [k, list.map(shown)])) }));
  return json({ seasons, top: SEASON_TOP }, 200, { 'Cache-Control': 'public, max-age=300' });
}
