import { MINUTE, DAY, ID_RE, HttpError, json, fail, readJson, isPlainObject, clientIp, publicOrigin } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText } from './profiles.js';
import { reportIpHash } from './reports.js';
import { offBoard } from './party-leaderboard.js';
import { isBoardOwner } from './board-owner.js';
import { activeBan } from './party-mod.js';
import { dailyShardStatements, dailyShardAmounts } from './party-shards.js';
import { maskList, HIDDEN_NAME } from './hidden-names.js';
import { censor } from '../web/activity/js/filter.js';
import { dailyPuzzle, hiveAnswers, hiveMax, scoreHive, scoreScramble, dailyScrambleWords, dayKey, shiftDay, nextReset, isDateKey, HIVE_MAX_LETTERS, SCRAMBLE_ROUNDS } from '../web/activity/js/daily.js';

export const WORDS_PATH = '/activity/data/words.txt';
export const DAILY_KINDS = Object.freeze(['hive', 'scramble']);
export const DAILY_BODY_LIMIT = 16 * 1024;
export const MAX_HIVE_WORDS = 200;
export const MAX_MS = DAY;
export const TOP_SIZE = 20;
export const DICT_RETRY_MS = MINUTE;
export const DAILY_KEEP_DAYS = 8;

const KIND_SET = new Set(DAILY_KINDS);
const NAME_MAX = 64;

let dictText = '';
let dictStarts = new Uint32Array(0);
let dictState = 'idle';
let dictPromise = null;
let dictFailedAt = 0;
const puzzles = new Map();

function wordAt(i) {
  const s = dictStarts[i];
  const e = dictText.indexOf('\n', s);
  return dictText.slice(s, e < 0 ? dictText.length : e);
}

export function useWords(raw) {
  let list = String(raw ?? '').toLowerCase().replace(/\r/g, '').split('\n').filter((w) => /^[a-z]+$/.test(w));
  let sorted = true;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i - 1] >= list[i]) {
      sorted = false;
      break;
    }
  }
  if (!sorted) list = [...new Set(list)].sort();
  dictText = list.join('\n');
  const starts = new Uint32Array(list.length);
  let at = 0;
  list.forEach((w, i) => {
    starts[i] = at;
    at += w.length + 1;
  });
  dictStarts = starts;
  return list.length > 0;
}

export function isWord(word) {
  const w = String(word ?? '').toLowerCase();
  if (!w || !dictStarts.length) return false;
  let lo = 0;
  let hi = dictStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const here = wordAt(mid);
    if (here === w) return true;
    if (here < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export function resetDailyCache() {
  dictText = '';
  dictStarts = new Uint32Array(0);
  dictState = 'idle';
  dictPromise = null;
  dictFailedAt = 0;
  puzzles.clear();
}

function bad(code, message) {
  return new HttpError(400, code, message);
}

export async function loadDictionary(env, base, now = Date.now()) {
  if (dictState === 'ready') return true;
  if (dictState === 'failed' && now - dictFailedAt < DICT_RETRY_MS) return false;
  if (!dictPromise) {
    dictPromise = (async () => {
      if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') throw new Error('no assets');
      const res = await env.ASSETS.fetch(new Request(new URL(WORDS_PATH, base).href, { method: 'GET' }));
      if (!res.ok) throw new Error(`words ${res.status}`);
      if (!useWords(await res.text())) throw new Error('empty');
      return true;
    })()
      .then(() => {
        dictState = 'ready';
        puzzles.clear();
        return true;
      })
      .catch(() => {
        dictState = 'failed';
        dictFailedAt = now;
        return false;
      })
      .finally(() => {
        dictPromise = null;
      });
  }
  return dictPromise;
}

export function puzzleFor(date) {
  const key = `${date}:${dictState === 'ready' ? 1 : 0}`;
  let entry = puzzles.get(key);
  if (!entry) {
    const puzzle = dailyPuzzle(date);
    const answers = new Set(hiveAnswers(puzzle, dictState === 'ready' ? { isWord } : {}));
    entry = { puzzle, answers, max: hiveMax(puzzle, { answers }), words: dailyScrambleWords(date) };
    puzzles.set(key, entry);
    while (puzzles.size > 6) puzzles.delete(puzzles.keys().next().value);
  }
  return entry;
}

function publicPuzzle(entry, t) {
  const { puzzle } = entry;
  return {
    date: puzzle.date,
    hive: { letters: puzzle.hive.letters, centre: puzzle.hive.centre, total: entry.answers.size, max: entry.max },
    scramble: { rounds: puzzle.scramble.rounds },
    resetsAt: nextReset(t),
  };
}

function originOk(request, env) {
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  return Boolean(origin && expected && origin === expected);
}

async function getDaily(request, env, url, t) {
  const limit = await hit(env.DB, await ipKey('daily', clientIp(request)), LIMITS.daily, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  await loadDictionary(env, url.href, t);
  const age = Math.max(0, Math.min(300, Math.floor((nextReset(t) - t) / 1000) - 5));
  return json(publicPuzzle(puzzleFor(dayKey(t)), t), 200, { 'Cache-Control': age ? `public, max-age=${age}` : 'no-store' });
}

function cleanUser(value) {
  if (!isPlainObject(value)) throw bad('bad_person', 'Say who is playing.');
  if (typeof value.id !== 'string' || !ID_RE.test(value.id.trim())) throw bad('bad_id', "Your player id doesn't look right.");
  let username = null;
  if (value.username !== null && value.username !== undefined) {
    if (typeof value.username !== 'string') throw bad('bad_username', "Your username doesn't look right.");
    const text = cleanText(value.username.replace(/^@+/, ''), NAME_MAX);
    username = text ? text.replace(/\s+/g, '') : null;
  }
  if (username && censor(username).changed) username = null;
  const name = cleanText(value.name, NAME_MAX);
  return { id: value.id.trim().toLowerCase(), name: name ? censor(name).text : 'Player', username };
}

function cleanStrings(list, max, chars, what) {
  if (!Array.isArray(list)) throw bad('bad_list', `Send your ${what} as a list.`);
  if (list.length > max) throw bad('bad_list', `That is too many ${what}.`);
  return list.map((v) => {
    if (typeof v !== 'string' || v.length > chars) throw bad('bad_list', `One of your ${what} doesn't look right.`);
    return v;
  });
}

export function cleanSubmission(body) {
  if (!isDateKey(body.date)) throw bad('bad_date', "The puzzle date doesn't look right.");
  if (typeof body.kind !== 'string' || !KIND_SET.has(body.kind)) throw bad('bad_kind', 'Pick the hive or the scramble puzzle.');
  const user = cleanUser(body.user);
  const ms = Number(body.ms);
  if (typeof body.ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS) throw bad('bad_time', "Your time doesn't look right.");
  const out = { date: body.date, kind: body.kind, user, ms: Math.round(ms) };
  if (body.kind === 'hive') out.words = cleanStrings(body.words, MAX_HIVE_WORDS, HIVE_MAX_LETTERS + 2, 'words');
  else out.answers = cleanStrings(body.answers, SCRAMBLE_ROUNDS, 32, 'answers');
  return out;
}

export function nextStreak(row, day) {
  const last = row ? String(row.last_day) : null;
  const streak = row ? Number(row.streak) || 0 : 0;
  const best = row ? Number(row.best) || 0 : 0;
  if (last === day) return { streak: Math.max(1, streak), best: Math.max(best, streak, 1), changed: false };
  const now = last === shiftDay(day, -1) ? streak + 1 : 1;
  return { streak: now, best: Math.max(best, now), changed: true };
}

async function postDaily(request, env, url, t) {
  if (!originOk(request, env)) return fail(403, 'forbidden', 'This was blocked for your safety. Reload the game and try again.');
  const ipHash = await reportIpHash(env, clientIp(request));
  const limit = await hit(env.DB, `daily:ip:${ipHash}`, LIMITS.dailyPost, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "You've sent a lot of answers. Try again in a minute.");
  const body = await readJson(request, DAILY_BODY_LIMIT);
  const sub = cleanSubmission(body);
  const day = dayKey(t);
  if (sub.date !== day) return fail(409, 'old_puzzle', "That puzzle has finished. A new one is ready, so reload to play today's.", { date: day });
  const db = env.DB;
  const ban = await activeBan(db, sub.user.id, t);
  if (ban) return fail(403, 'banned', "You can't play the daily puzzle right now.");
  await loadDictionary(env, url.href, t);
  const entry = puzzleFor(day);
  let score;
  let detail;
  if (sub.kind === 'hive') {
    const r = scoreHive(sub.words, entry.puzzle, { answers: entry.answers });
    score = r.score;
    detail = { found: r.found, pangrams: r.pangrams, total: entry.answers.size, max: entry.max, words: r.words };
  } else {
    const r = scoreScramble(sub.answers, entry.puzzle, { words: entry.words });
    score = r.score;
    detail = { correct: r.correct, total: r.total, right: r.right };
  }
  const [old, streakRow] = await Promise.all([
    db.prepare('SELECT score, ms FROM party_daily_scores WHERE day = ? AND kind = ? AND user_id = ?').bind(day, sub.kind, sub.user.id).first(),
    db.prepare('SELECT last_day, streak, best FROM party_daily_streaks WHERE user_id = ?').bind(sub.user.id).first(),
  ]);
  const improved = !old || score > Number(old.score) || (score === Number(old.score) && sub.ms < Number(old.ms));
  const kept = improved ? { score, ms: sub.ms } : { score: Number(old.score), ms: Number(old.ms) };
  const streak = nextStreak(streakRow, day);
  const stmts = [];
  if (improved) {
    stmts.push(
      db.prepare('INSERT INTO party_daily_scores (day, kind, user_id, name, username, score, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, kind, user_id) DO UPDATE SET name = CASE WHEN excluded.name = ? THEN party_daily_scores.name ELSE excluded.name END, username = COALESCE(excluded.username, party_daily_scores.username), score = excluded.score, ms = excluded.ms, at = excluded.at WHERE excluded.score > party_daily_scores.score OR (excluded.score = party_daily_scores.score AND excluded.ms < party_daily_scores.ms)')
        .bind(day, sub.kind, sub.user.id, sub.user.name, sub.user.username, score, sub.ms, t, HIDDEN_NAME),
    );
  } else {
    stmts.push(db.prepare('UPDATE party_daily_scores SET name = CASE WHEN ? = ? THEN name ELSE ? END, username = COALESCE(?, username) WHERE day = ? AND kind = ? AND user_id = ?').bind(sub.user.name, HIDDEN_NAME, sub.user.name, sub.user.username, day, sub.kind, sub.user.id));
  }
  stmts.push(
    db.prepare('INSERT INTO party_daily_streaks (user_id, last_day, streak, best, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET last_day = excluded.last_day, streak = excluded.streak, best = excluded.best, updated = excluded.updated')
      .bind(sub.user.id, day, streak.streak, streak.best, t),
  );
  const payFrom = stmts.length;
  if (score > 0) stmts.push(...dailyShardStatements(db, sub.user.id, sub.kind, streak.streak, day, t));
  const done = await db.batch(stmts);
  const amounts = score > 0 ? dailyShardAmounts(streak.streak) : [];
  const shards = (Array.isArray(done) ? done.slice(payFrom) : []).reduce((sum, r, i) => sum + (Number(r && r.meta && r.meta.changes) ? amounts[i] || 0 : 0), 0);
  const rankRow = await db.prepare(`SELECT COUNT(*) AS n FROM party_daily_scores s WHERE s.day = ? AND s.kind = ? AND (s.score > ? OR (s.score = ? AND s.ms < ?)) AND ${offBoard('s.user_id', t)}`).bind(day, sub.kind, kept.score, kept.score, kept.ms).first();
  return json({
    ok: true,
    date: day,
    kind: sub.kind,
    score,
    best: kept.score,
    improved,
    rank: isBoardOwner(sub.user.id) ? null : (Number(rankRow && rankRow.n) || 0) + 1,
    ...(isBoardOwner(sub.user.id) ? { meHidden: true } : {}),
    streak: streak.streak,
    bestStreak: streak.best,
    shards,
    ...detail,
  });
}

async function getTop(request, env, url, t) {
  const limit = await hit(env.DB, await ipKey('dailyTop', clientIp(request)), LIMITS.daily, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const kind = url.searchParams.get('kind') || 'hive';
  if (!KIND_SET.has(kind)) throw bad('bad_kind', 'Pick the hive or the scramble puzzle.');
  const day = dayKey(t);
  const res = await env.DB.prepare(
    `SELECT s.user_id, s.name, s.username, s.score, s.ms, k.streak, k.last_day FROM party_daily_scores s LEFT JOIN party_daily_streaks k ON k.user_id = s.user_id WHERE s.day = ? AND s.kind = ? AND ${offBoard('s.user_id', t)} ORDER BY s.score DESC, s.ms ASC, s.at ASC, s.user_id ASC LIMIT ?`,
  ).bind(day, kind, TOP_SIZE).all();
  const yesterday = shiftDay(day, -1);
  const top = ((res && res.results) || []).map((r, i) => ({
    rank: i + 1,
    id: r.user_id,
    name: r.name,
    username: r.username || null,
    score: Number(r.score),
    ms: Number(r.ms),
    streak: r.last_day === day || r.last_day === yesterday ? Number(r.streak) || 0 : 0,
  }));
  return json({ date: day, kind, top: await maskList(env.DB, top, t) }, 200, { 'Cache-Control': 'public, max-age=15' });
}

export function dailyRoute(request, env, segs, url, t) {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  if (segs.length === 3) {
    if (read) return getDaily(request, env, url, t);
    if (method === 'POST') return postDaily(request, env, url, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (segs.length === 4 && segs[3] === 'top') {
    if (read) return getTop(request, env, url, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export function dailyCleanupStatements(db, t) {
  return [db.prepare('DELETE FROM party_daily_scores WHERE day < ?').bind(shiftDay(dayKey(t), -DAILY_KEEP_DAYS))];
}
