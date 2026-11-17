import { findBlocked, isBlockedGameWord, censor } from './filter.js';
import { decodeStroke, fitLevels } from './games/ink.js';
import { trimReplay, inkMatches, SOLO_GAMES } from './games/replayformat.js';
export const ADMINS_EVENT = 'yapos:admins';
export const ADMINS_ENDPOINT = '/api/activity/admins';
export const ADMIN_BATCH = 40;
export const ADMIN_REFRESH_MS = 60000;
export const ADMIN_RETRY_MS = 5000;
export const ADMIN_TRACK_MAX = 400;
export const REPORTS_ENDPOINT = '/api/activity/reports';
export const REPORT_GAMES = Object.freeze(['draw', 'odd', 'telephone', 'sketchduel', 'pixel']);
export const REPORT_STROKES = 200;
export const REPORT_INK_CHARS = 16000;
export const REPORT_NAME_MAX = 64;
export const REPORT_WORD_MAX = 80;
export const REPORT_SENT_MAX = 200;
export const TEXT_REPORT_GAMES = Object.freeze(['draw', 'hottakes', 'truths', 'telephone', 'chain', 'bluff', 'story']);
export const REPORT_TEXT_MAX = 300;
export const REPORT_CONTEXT_MAX = 200;
export const REPORT_REASONS = Object.freeze(['rude', 'spam', 'cheating', 'other']);
export const REASON_NOTE_MAX = 100;
const INK_RE = /^[A-Za-z0-9_-]{6,4096}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let env = defaults();
let checked = new Map();
let admins = new Set();
let banned = new Set();
let bannedUntil = new Map();
let reported = new Set();
let owner = null;
let failedAt = new Map();
let busy = new Map();
let listeners = new Set();
let timer = null;

function defaults() {
  return {
    win: typeof window !== 'undefined' ? window : null,
    fetch: typeof fetch === 'function' ? (...a) => fetch(...a) : null,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    refreshMs: ADMIN_REFRESH_MS,
  };
}

export function configureAdmins(opts = {}) {
  const next = { ...env };
  for (const k of Object.keys(opts)) if (opts[k] !== undefined) next[k] = opts[k];
  env = next;
}

export function resetAdmins() {
  if (timer !== null) env.clearTimeout(timer);
  timer = null;
  checked = new Map();
  admins = new Set();
  banned = new Set();
  bannedUntil = new Map();
  reported = new Set();
  owner = null;
  failedAt = new Map();
  busy = new Map();
  listeners = new Set();
  env = defaults();
  resetParty();
}

function idOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    const v = x.id ?? x.user_id ?? x.userId ?? null;
    return v === null || v === undefined ? null : String(v);
  }
  return String(x);
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function isAdmin(id) {
  const key = idOf(id);
  return Boolean(key) && (admins.has(key) || (owner !== null && key === owner));
}

export function isOwner(id) {
  const key = idOf(id);
  return Boolean(key) && owner !== null && key === owner;
}

export function isBanned(id) {
  const key = idOf(id);
  if (!key || !banned.has(key)) return false;
  const until = bannedUntil.get(key);
  return !until || until > env.now();
}

export function banUntil(id) {
  const key = idOf(id);
  if (!key || !isBanned(key)) return null;
  return bannedUntil.get(key) || null;
}

export function bannedIds() {
  return [...banned].filter((id) => isBanned(id));
}

export function knows(id) {
  const key = idOf(id);
  return Boolean(key) && checked.has(key);
}

export function ownerId() {
  return owner;
}

export function adminIds() {
  const out = new Set(admins);
  if (owner !== null) out.add(owner);
  return [...out];
}

export function onAdmins(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {}
  }
  const win = env.win;
  if (!win || typeof win.dispatchEvent !== 'function') return;
  try {
    const Ctor = win.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
    if (Ctor) win.dispatchEvent(new Ctor(ADMINS_EVENT));
  } catch {}
}

function track(id, at) {
  checked.delete(id);
  checked.set(id, at);
  while (checked.size > ADMIN_TRACK_MAX) {
    const old = checked.keys().next().value;
    checked.delete(old);
    admins.delete(old);
    banned.delete(old);
    bannedUntil.delete(old);
  }
}

async function ask(ids) {
  if (typeof env.fetch !== 'function') return null;
  try {
    const q = new URLSearchParams({ ids: ids.join(',') });
    const res = await env.fetch(`${ADMINS_ENDPOINT}?${q}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.admins)) return null;
    return body;
  } catch {
    return null;
  }
}

function apply(ids, body) {
  const asked = new Set(ids);
  const yes = new Set(body.admins.filter((x) => typeof x === 'string' && asked.has(x)));
  const out = new Set((Array.isArray(body.banned) ? body.banned : []).filter((x) => typeof x === 'string' && asked.has(x)));
  const ends = body.until && typeof body.until === 'object' && !Array.isArray(body.until) ? body.until : {};
  const told = Number(body.now);
  const skew = Number.isFinite(told) && told > 0 ? Math.round((env.now() - told) / 60000) * 60000 : 0;
  let changed = false;
  const at = env.now();
  for (const id of ids) {
    failedAt.delete(id);
    track(id, at);
    if (yes.has(id) && !admins.has(id)) {
      admins.add(id);
      changed = true;
    } else if (!yes.has(id) && admins.delete(id)) {
      changed = true;
    }
    const end = out.has(id) && Number.isFinite(Number(ends[id])) && Number(ends[id]) > 0 ? Number(ends[id]) + skew : null;
    if ((bannedUntil.get(id) || null) !== end) {
      if (end) bannedUntil.set(id, end);
      else bannedUntil.delete(id);
      changed = true;
    }
    if (out.has(id) && !banned.has(id)) {
      banned.add(id);
      changed = true;
    } else if (!out.has(id) && banned.delete(id)) {
      changed = true;
    }
  }
  const o = typeof body.owner === 'string' && asked.has(body.owner) ? body.owner : null;
  if (o !== null && owner !== o) {
    owner = o;
    changed = true;
  }
  return changed;
}

async function load(ids) {
  const body = await ask(ids);
  if (!body) {
    const at = env.now();
    for (const id of ids) failedAt.set(id, at);
    return false;
  }
  return apply(ids, body);
}

function schedule() {
  if (timer !== null || !(env.refreshMs > 0)) return;
  timer = env.setTimeout(() => {
    timer = null;
    const recent = [...checked.keys()].reverse();
    const ids = [...new Set([...admins].filter((id) => checked.has(id)).concat(recent))].slice(0, ADMIN_BATCH);
    if (!ids.length) return;
    refreshAdmins(ids, { force: true }).finally(schedule);
  }, env.refreshMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

export function refreshAdmins(list, opts = {}) {
  const force = Boolean(opts.force);
  const at = env.now();
  const want = [];
  const waits = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : [list]) {
    const id = idOf(x);
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    if (busy.has(id)) {
      waits.push(busy.get(id));
      continue;
    }
    if (!force && checked.has(id)) continue;
    const failed = failedAt.get(id);
    if (!force && failed !== undefined && at - failed < ADMIN_RETRY_MS) continue;
    want.push(id);
  }
  for (let i = 0; i < want.length; i += ADMIN_BATCH) {
    const chunk = want.slice(i, i + ADMIN_BATCH);
    const p = load(chunk).finally(() => {
      for (const id of chunk) if (busy.get(id) === p) busy.delete(id);
    });
    for (const id of chunk) busy.set(id, p);
    waits.push(p);
  }
  schedule();
  if (!waits.length) return Promise.resolve(false);
  return Promise.all(waits).then((r) => {
    const changed = r.some(Boolean);
    if (changed) announce();
    return changed;
  });
}

function clipReport(raw, max) {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

function cleanReportName(raw) {
  return clipReport(raw, REPORT_NAME_MAX);
}

function reportFits(parts) {
  if (parts.length > REPORT_STROKES) return null;
  let chars = 0;
  for (const s of parts) {
    if (!INK_RE.test(s)) return null;
    chars += s.length;
  }
  return chars <= REPORT_INK_CHARS ? { parts } : null;
}

export function reportInk(list) {
  const clean = (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && INK_RE.test(s));
  if (reportFits(clean)) return clean;
  const strokes = clean.map(decodeStroke).filter(Boolean);
  const fit = fitLevels(strokes, 0, reportFits);
  return fit && Array.isArray(fit.parts) ? fit.parts : [];
}

export function replayFits(replay, game, drawerId, ink) {
  if (!replay || replay.kind !== (game === 'pixel' ? 'pixel' : 'ink')) return false;
  const ids = replay.authors.map((a) => String(a.id).toLowerCase());
  const me = String(drawerId).toLowerCase();
  if (!ids.includes(me)) return false;
  if (SOLO_GAMES.includes(game) && (ids.length !== 1 || ids[0] !== me)) return false;
  return inkMatches(replay, ink, REPORT_STROKES, 16 * 1024, me);
}

export function cleanReasonNote(raw) {
  const text = clipReport(raw, REASON_NOTE_MAX);
  if (!text) return '';
  try {
    return censor(text).text;
  } catch {
    return text;
  }
}

export function reasonOf(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (!REPORT_REASONS.includes(x.reason)) return {};
  const note = cleanReasonNote(x.reasonNote);
  return note ? { reason: x.reason, reasonNote: note } : { reason: x.reason };
}

export function reportBody(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (!REPORT_GAMES.includes(x.game)) return null;
  const d = x.drawer && typeof x.drawer === 'object' ? x.drawer : {};
  const r = x.reporter && typeof x.reporter === 'object' ? x.reporter : {};
  const drawerId = idOf(d.id);
  const reporterId = idOf(r.id);
  if (!validId(drawerId) || !validId(reporterId) || drawerId === reporterId) return null;
  const handle = typeof d.username === 'string' ? cleanReportName(d.username.replace(/^@+/, '')).replace(/\s/g, '') : '';
  const word = typeof x.word === 'string' ? Array.from(cleanReportName(x.word)).slice(0, REPORT_WORD_MAX).join('') : '';
  const body = {
    game: x.game,
    drawer: { id: drawerId, name: cleanReportName(d.name) || 'Player', username: handle || null },
    reporter: { id: reporterId, name: cleanReportName(r.name) || 'Player' },
    ink: reportInk(x.ink),
    word: word || null,
    at: Number.isFinite(x.at) ? Math.round(x.at) : env.now(),
    ...reasonOf(x),
  };
  const replay = x.replay ? trimReplay(x.replay) : null;
  if (replay && replayFits(replay, x.game, drawerId, body.ink)) body.replay = replay;
  return body;
}

export function wasReported(key) {
  return typeof key === 'string' && reported.has(key);
}

export async function sendReport(key, input) {
  if (typeof key !== 'string' || !key || reported.has(key)) return false;
  const body = reportBody(input);
  if (!body || typeof env.fetch !== 'function') return false;
  reported.add(key);
  while (reported.size > REPORT_SENT_MAX) reported.delete(reported.values().next().value);
  try {
    const res = await env.fetch(REPORTS_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

export function textReportBody(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (!TEXT_REPORT_GAMES.includes(x.game)) return null;
  const a = x.author && typeof x.author === 'object' ? x.author : {};
  const r = x.reporter && typeof x.reporter === 'object' ? x.reporter : {};
  const authorId = idOf(a.id);
  const reporterId = idOf(r.id);
  if (!validId(authorId) || !validId(reporterId) || authorId === reporterId) return null;
  const text = clipReport(x.text, REPORT_TEXT_MAX).trim();
  if (!text) return null;
  const handle = typeof a.username === 'string' ? cleanReportName(a.username.replace(/^@+/, '')).replace(/\s/g, '') : '';
  const context = clipReport(x.context, REPORT_CONTEXT_MAX).trim();
  return {
    kind: 'text',
    game: x.game,
    author: { id: authorId, name: cleanReportName(a.name) || 'Player', username: handle || null },
    reporter: { id: reporterId, name: cleanReportName(r.name) || 'Player' },
    text,
    context: context || null,
    at: Number.isFinite(x.at) ? Math.round(x.at) : env.now(),
    ...reasonOf(x),
  };
}

export async function sendTextReport(input) {
  const body = textReportBody(input);
  if (!body || typeof env.fetch !== 'function') return false;
  try {
    const res = await env.fetch(REPORTS_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

export const RESULTS_ENDPOINT = '/api/activity/results';
export const RESULT_GAMES = Object.freeze(['trivia', 'draw', 'chain', 'wyr', 'odd', 'telephone', 'scramble', 'hive', 'emoji', 'hottakes', 'truths', 'reflex', 'bluff', 'pixel', 'higherlower', 'sketchduel', 'story', 'hangman', 'musicquiz', 'typerace', 'memory', 'beatdrop', 'closest', 'namefive']);
export const RESULT_PLAYERS_MAX = 16;
export const RESULT_SCORE_MAX = 1000000;
export const RESULT_EXTRA_KEYS = 8;
export const RESULT_TEAM_MAX = 24;
export const PARTY_XP_PLAY = 10;
export const PARTY_XP_WIN = 15;
export const PARTY_XP_DAY = 200;
export const PARTY_SHARDS_PLAY = 5;
export const PARTY_SHARDS_WIN = 15;
export const PARTY_SHARDS_TOURNAMENT = 25;
export const PARTY_SHARDS_PREDICTION = 5;
export const PARTY_SHARDS_DAY = 150;
export const PREDICTIONS_MAX = 16;
export const DAILY_ENDPOINT = '/api/activity/daily';
export const DAILY_TOP_ENDPOINT = '/api/activity/daily/top';
export const DAILY_KINDS = Object.freeze(['hive', 'scramble']);
export const DAILY_ROUNDS = 5;
export const DAILY_WORDS_MAX = 200;
export const DAILY_TOP_MAX = 20;
export const DAILY_TOP_MS = 30000;
export const DAILY_RETRY_MS = 8000;
export const PACK_ENDPOINT = '/api/activity/pack/';
export const PACK_CODE_MAX = 12;
export const PACK_CODE_MIN = 4;
export const PACK_WORDS_MAX = 500;
export const PACK_TRIVIA_MAX = 200;
export const PACK_KEEP = 16;
const GAME_RE = /^[a-z0-9-]{1,32}$/;
const EXTRA_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let dailyCache = new Map();
let dailyBusy = new Map();
let dailyFailed = new Map();
let topCache = new Map();
let packCache = new Map();
let packBusy = new Map();
const moreGames = new Set();

export function allowResultGames(ids) {
  for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && GAME_RE.test(id)) moreGames.add(id);
}

export function resultGame(id) {
  return typeof id === 'string' && GAME_RE.test(id) && (RESULT_GAMES.includes(id) || moreGames.has(id));
}

export function resetParty() {
  dailyCache = new Map();
  dailyBusy = new Map();
  dailyFailed = new Map();
  topCache = new Map();
  packCache = new Map();
  packBusy = new Map();
}

async function getJson(url) {
  if (typeof env.fetch !== 'function') return null;
  try {
    const res = await env.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

async function postJson(url, body) {
  if (typeof env.fetch !== 'function') return null;
  try {
    const res = await env.fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok) return null;
    try {
      const out = await res.json();
      return out && typeof out === 'object' ? out : {};
    } catch {
      return {};
    }
  } catch {
    return null;
  }
}

function cleanHandle(raw) {
  if (typeof raw !== 'string') return null;
  const v = cleanReportName(raw.replace(/^@+/, '')).replace(/\s/g, '');
  return v || null;
}

function cleanUser(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const id = idOf(u.id);
  if (!validId(id)) return null;
  return { id, name: cleanReportName(u.name) || 'Player', username: cleanHandle(u.username) };
}

export function partyXp(won) {
  return PARTY_XP_PLAY + (won ? PARTY_XP_WIN : 0);
}

export function partyShards(won, champ = false) {
  return PARTY_SHARDS_PLAY + (won ? PARTY_SHARDS_WIN : 0) + (champ ? PARTY_SHARDS_TOURNAMENT : 0);
}

function cleanPredictions(list, players) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= PREDICTIONS_MAX) break;
    const u = cleanUser(raw);
    if (!u || seen.has(u.id) || players.has(u.id)) continue;
    const pick = idOf(raw.pick);
    if (!validId(pick) || !players.has(pick)) continue;
    seen.add(u.id);
    out.push({ id: u.id, name: u.name, username: u.username, pick, right: raw.right === true });
  }
  return out;
}

const SKILL_QUESTIONS_OUT = 50;
const SKILL_OUT_CAPS = Object.freeze({ s: 20, l: 10, p: 1, c: 1 });

function cleanSkillsOut(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [rawId, v] of Object.entries(raw)) {
    const id = idOf(rawId);
    if (!validId(id) || !seen.has(id) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const skill = {};
    for (const [key, cap] of Object.entries(SKILL_OUT_CAPS)) {
      const n = Math.floor(Number(v[key]) || 0);
      if (n > 0) skill[key] = Math.min(n, cap);
    }
    if (Object.keys(skill).length) out[id] = skill;
  }
  return Object.keys(out).length ? out : null;
}

export function resultsBody(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (!resultGame(x.game)) return null;
  const seen = new Set();
  const players = [];
  for (const raw of Array.isArray(x.players) ? x.players : []) {
    if (players.length >= RESULT_PLAYERS_MAX) break;
    const u = cleanUser(raw);
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    const n = Number(raw.score);
    const score = Number.isFinite(n) ? Math.round(Math.max(-RESULT_SCORE_MAX, Math.min(RESULT_SCORE_MAX, n))) : 0;
    const team = typeof raw.team === 'string' ? clipReport(raw.team, RESULT_TEAM_MAX) || null : null;
    players.push({ id: u.id, name: u.name, username: u.username, score, won: raw.won === true, team });
  }
  if (players.length < 2) return null;
  const extra = {};
  const src = x.extra && typeof x.extra === 'object' && !Array.isArray(x.extra) ? x.extra : {};
  const tour = src.tournament && typeof src.tournament === 'object' && !Array.isArray(src.tournament) ? idOf(src.tournament.winner) : null;
  if (validId(tour) && seen.has(tour)) extra.tournament = { winner: tour };
  for (const [k, v] of Object.entries(src)) {
    if (Object.keys(extra).length >= RESULT_EXTRA_KEYS) break;
    if (!EXTRA_RE.test(k) || !Array.isArray(v)) continue;
    const ids = [...new Set(v.map(idOf).filter((id) => validId(id) && seen.has(id)))].slice(0, RESULT_PLAYERS_MAX);
    if (ids.length) extra[k] = ids;
  }
  const skills = cleanSkillsOut(src.skills, seen);
  if (skills) {
    extra.skills = skills;
    const qn = Math.floor(Number(src.questions) || 0);
    if (qn > 0) extra.questions = Math.min(qn, SKILL_QUESTIONS_OUT);
  }
  const out = { game: x.game, at: Number.isFinite(x.at) ? Math.round(x.at) : env.now(), players, extra };
  const predictions = cleanPredictions(x.predictions, seen);
  if (predictions.length) out.predictions = predictions;
  return out;
}

export async function sendResults(input) {
  const body = resultsBody(input);
  if (!body) return false;
  return (await postJson(RESULTS_ENDPOINT, body)) !== null;
}

export function utcDay(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : env.now());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function lowLetters(raw) {
  const s = Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '';
  return s.toLowerCase();
}

export function cleanDaily(raw) {
  const x = raw && typeof raw === 'object' ? raw : null;
  if (!x || typeof x.date !== 'string' || !DATE_RE.test(x.date)) return null;
  const hive = x.hive && typeof x.hive === 'object' ? x.hive : null;
  const letters = hive ? lowLetters(hive.letters) : '';
  const centre = hive && typeof hive.centre === 'string' ? hive.centre.toLowerCase() : '';
  const set = [...new Set(letters)].sort().join('');
  const hiveOk = /^[a-z]{7}$/.test(set) && letters.length === 7 && /^[a-z]$/.test(centre) && set.includes(centre);
  const rounds = [];
  const sc = x.scramble && typeof x.scramble === 'object' ? x.scramble : null;
  for (const r of sc && Array.isArray(sc.rounds) ? sc.rounds.slice(0, DAILY_ROUNDS) : []) {
    const l = lowLetters(r && r.letters);
    if (!/^[a-z]{3,12}$/.test(l)) return null;
    const hash = r && (typeof r.answerHash === 'string' || Number.isFinite(r.answerHash)) ? r.answerHash : null;
    rounds.push({ letters: l, answerHash: hash });
  }
  if (!hiveOk || !rounds.length) return null;
  return { date: x.date, hive: { letters: set, centre }, scramble: { rounds } };
}

export function cachedDaily(date) {
  const key = typeof date === 'string' ? date : utcDay();
  return dailyCache.get(key) || null;
}

export function dailyFailedFor(date) {
  const at = dailyFailed.get(date);
  return at !== undefined && env.now() - at < DAILY_RETRY_MS;
}

async function localDaily(date) {
  try {
    const load =
      typeof env.importDaily === 'function'
        ? env.importDaily
        : () => Promise.all([import('./daily.js'), import('../data/hive.js'), import('../data/scramble.js'), import('./dictionary.js')]);
    const got = await load();
    const [mod, hiveData, scrambleData, dict] = Array.isArray(got) ? got : [got];
    if (!mod || typeof mod.dailyPuzzle !== 'function') return null;
    const opts = { hiveSeeds: hiveData ? hiveData.SEEDS : undefined, scrambleWords: scrambleData ? scrambleData.WORDS : undefined };
    if (dict && dict.ready && typeof dict.isWord === 'function') opts.isWord = dict.isWord;
    return cleanDaily(mod.dailyPuzzle(date, opts));
  } catch {
    return null;
  }
}

export function loadDaily(date) {
  const key = typeof date === 'string' && DATE_RE.test(date) ? date : utcDay();
  if (dailyCache.has(key)) return Promise.resolve(dailyCache.get(key));
  if (dailyBusy.has(key)) return dailyBusy.get(key);
  const p = (async () => {
    const body = await getJson(DAILY_ENDPOINT);
    let puzzle = cleanDaily(body && body.puzzle && typeof body.puzzle === 'object' ? body.puzzle : body);
    if (puzzle && puzzle.date !== key) puzzle = null;
    if (!puzzle) puzzle = await localDaily(key);
    if (puzzle && puzzle.date === key) {
      dailyCache.set(key, puzzle);
      dailyFailed.delete(key);
      while (dailyCache.size > 3) dailyCache.delete(dailyCache.keys().next().value);
      return puzzle;
    }
    dailyFailed.set(key, env.now());
    return null;
  })().finally(() => dailyBusy.delete(key));
  dailyBusy.set(key, p);
  return p;
}

export function dailyBody(input) {
  const x = input && typeof input === 'object' ? input : {};
  if (typeof x.date !== 'string' || !DATE_RE.test(x.date) || !DAILY_KINDS.includes(x.kind)) return null;
  const user = cleanUser(x.user);
  if (!user) return null;
  const ms = Number.isFinite(x.ms) ? Math.round(Math.max(0, Math.min(3600000, x.ms))) : 0;
  if (x.kind === 'hive') {
    const list = (Array.isArray(x.words) ? x.words : []).filter((w) => typeof w === 'string').map((w) => w.trim().toLowerCase());
    const words = [...new Set(list.filter((w) => /^[a-z]{4,30}$/.test(w)))].slice(0, DAILY_WORDS_MAX);
    if (!words.length) return null;
    return { date: x.date, kind: 'hive', user, words, ms };
  }
  const answers = [];
  const src = Array.isArray(x.answers) ? x.answers : [];
  for (let i = 0; i < DAILY_ROUNDS; i += 1) {
    const a = typeof src[i] === 'string' ? src[i].trim().toLowerCase() : '';
    answers.push(/^[a-z]{1,24}$/.test(a) ? a : '');
  }
  if (!answers.some(Boolean)) return null;
  return { date: x.date, kind: 'scramble', user, answers, ms };
}

export async function sendDaily(input) {
  const body = dailyBody(input);
  if (!body) return null;
  const out = await postJson(DAILY_ENDPOINT, body);
  if (!out) return null;
  const num = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);
  topCache.delete(body.kind);
  const score = num(out.score) ?? 0;
  const best = num(out.best);
  return { score, best: best !== null && best > score ? best : score, rank: num(out.rank), streak: num(out.streak) ?? 0 };
}

function cleanTopRow(r) {
  if (!r || typeof r !== 'object') return null;
  const score = Number(r.score);
  if (!Number.isFinite(score)) return null;
  const streak = Number(r.streak);
  return { name: cleanReportName(r.name) || 'Player', username: cleanHandle(r.username), score: Math.max(0, Math.round(score)), streak: Number.isFinite(streak) ? Math.max(0, Math.round(streak)) : 0 };
}

export function cachedTop(kind) {
  const hit = topCache.get(kind);
  return hit && Array.isArray(hit.rows) ? hit.rows : null;
}

export async function dailyTop(kind, opts = {}) {
  if (!DAILY_KINDS.includes(kind)) return null;
  const hit = topCache.get(kind);
  if (hit && !opts.force && env.now() - hit.at < DAILY_TOP_MS) return hit.rows;
  const body = await getJson(`${DAILY_TOP_ENDPOINT}?${new URLSearchParams({ kind })}`);
  const list = body && Array.isArray(body.top) ? body.top : Array.isArray(body) ? body : null;
  if (!list) return hit ? hit.rows : null;
  const rows = list.map(cleanTopRow).filter(Boolean).slice(0, DAILY_TOP_MAX);
  topCache.set(kind, { rows, at: env.now() });
  return rows;
}

export function cleanPackCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PACK_CODE_MAX);
}

function cleanPackText(raw, max) {
  const text = clipReport(raw, max);
  if (!text || findBlocked(text).length) return '';
  return text;
}

export function cleanPack(raw) {
  const x = raw && typeof raw === 'object' ? raw : null;
  if (!x) return null;
  const words = [];
  const seen = new Set();
  for (const w of Array.isArray(x.words) ? x.words : []) {
    if (words.length >= PACK_WORDS_MAX) break;
    const text = cleanPackText(w, 40);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || isBlockedGameWord(key)) continue;
    seen.add(key);
    words.push(text);
  }
  const trivia = [];
  for (const t of Array.isArray(x.trivia) ? x.trivia : []) {
    if (trivia.length >= PACK_TRIVIA_MAX) break;
    if (!t || typeof t !== 'object') continue;
    const q = cleanPackText(t.q, 200);
    const a = cleanPackText(t.a, 80);
    const w = (Array.isArray(t.w) ? t.w : []).map((v) => cleanPackText(v, 80)).filter(Boolean).slice(0, 3);
    const uniq = new Set(w.map((v) => v.toLowerCase()));
    if (!q || !a || w.length < 3 || uniq.size < 3 || uniq.has(a.toLowerCase())) continue;
    trivia.push({ q, a, w });
  }
  if (!words.length && !trivia.length) return null;
  return { code: cleanPackCode(x.code), name: cleanPackText(x.name, REPORT_NAME_MAX) || 'Word pack', words, trivia };
}

export function cachedPack(code) {
  return packCache.get(cleanPackCode(code)) || null;
}

export function loadPack(code) {
  const key = cleanPackCode(code);
  if (key.length < PACK_CODE_MIN) return Promise.resolve(null);
  if (packCache.has(key)) return Promise.resolve(packCache.get(key));
  if (packBusy.has(key)) return packBusy.get(key);
  const p = getJson(`${PACK_ENDPOINT}${encodeURIComponent(key)}`)
    .then((body) => {
      const pack = cleanPack(body);
      if (!pack) return null;
      const out = { code: key, name: pack.name, words: pack.words, trivia: pack.trivia };
      packCache.set(key, out);
      while (packCache.size > PACK_KEEP) packCache.delete(packCache.keys().next().value);
      return out;
    })
    .catch(() => null)
    .finally(() => packBusy.delete(key));
  packBusy.set(key, p);
  return p;
}
