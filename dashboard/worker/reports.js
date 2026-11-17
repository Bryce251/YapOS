import { MINUTE, DAY, ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, clientIp, publicOrigin, randomToken, parseJsonSafe, sha256Hex } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { lookupProfiles, cleanText, MAX_PROFILE_IDS } from './profiles.js';
import { isPartyOwner } from './party.js';
import { buildCard } from './party-profile.js';
import { censor } from '../web/activity/js/filter.js';
import { cheatReportAlert } from './party-cheats.js';
import { cleanDuration, banLive, activeBan, activeBanIds, banTermStatements, logModAction, actorName, personName, sendWarning, warningRows, warningsOut, listModLog, BAN_DURATION_NAMES } from './party-mod.js';
import { REPLAY_VERSION, REPLAY_EVENTS, REPLAY_CHARS, REPLAY_AUTHORS, REPLAY_MAX_MS, PIXEL_CELLS, PIXEL_CODES, SOLO_GAMES, inkMatches, pixelMismatch } from '../web/activity/js/games/replayformat.js';

export const REPORT_GAMES = new Set(['draw', 'odd', 'telephone', 'sketchduel', 'pixel']);
export const TEXT_GAMES = new Set(['draw', 'odd', 'telephone', 'hottakes', 'truths', 'chain', 'emoji', 'scramble', 'trivia', 'wyr', 'hive', 'bluff', 'story', 'hangman']);
export const REPORT_KINDS = new Set(['drawing', 'text']);
export const TEXT_MAX = 300;
export const CONTEXT_MAX = 200;
export const TEXT_REPORTS_PER_WINDOW = 30;
export const MAX_STROKES = 200;
export const MAX_INK_CHARS = 16 * 1024;
export const REPORT_BODY_LIMIT = 80 * 1024;
export const REPORT_WINDOW = 10 * MINUTE;
export const REPORTS_PER_WINDOW = 10;
export const DEDUPE_WINDOW = 10 * MINUTE;
export const MAX_REPORTS = 500;
export const DISMISSED_KEEP = 30 * DAY;
export const MAX_BANS = 1000;
export const REPORTS_PAGE = 20;
export const PERSON_REPORTS = 100;
export const BAN_LOG_KEEP = 365 * DAY;
export const BAN_LOG_SHOWN = 20;
export const FLAG_WINDOW = 7 * DAY;
export const FLAG_GAMES = 3;
export const FLAG_REPORTERS = 2;
export const FLAG_SESSION = 30 * MINUTE;
export const FLAG_PEOPLE = 50;
export const FLAGGED_REPORTS = 100;
export const NOTE_MAX = 500;
export const NOTES_PER_PERSON = 100;
export const NOTES_TOTAL = 20000;
export const REPORT_REASONS = Object.freeze(['rude', 'spam', 'cheating', 'other']);
export const REASON_NOTE_MAX = 100;
export const REASON_FILTERS = new Set(['all', ...REPORT_REASONS]);

const INK_RE = /^[A-Za-z0-9_-]{6,4096}$/;
const CURSOR_RE = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/;
const STATUSES = new Set(['open', 'dismissed', 'all']);
const KIND_FILTERS = new Set(['drawing', 'text', 'flagged', 'all']);
const NAME_MAX = 64;
const WORD_MAX = 64;
const REASON_MAX = 200;
const STAFF_ONLY = 'Only the owner of YapOS Party and party admins can see reports.';
const NOTES_SELF = 'Notes about you are kept private from you. Ask another admin or the owner.';
const NOTE_FIELDS = new Set(['text']);
const FLAG_SQL = `WITH w AS (SELECT r.drawer_id, r.reporter_id, r.ip_hash, r.created, CASE WHEN r.created - LAG(r.created) OVER (PARTITION BY r.drawer_id, r.game ORDER BY r.created) <= ? THEN 0 ELSE 1 END AS fresh FROM party_reports r WHERE r.status = 'open' AND r.created > ? AND NOT EXISTS (SELECT 1 FROM party_bans b WHERE b.id = r.drawer_id{live}){only}) SELECT drawer_id AS id, SUM(fresh) AS games, MIN(COUNT(DISTINCT reporter_id), COUNT(DISTINCT ip_hash)) AS reporters, COUNT(*) AS n, MAX(created) AS last FROM w GROUP BY drawer_id HAVING SUM(fresh) >= ? AND COUNT(DISTINCT reporter_id) >= ? AND COUNT(DISTINCT ip_hash) >= ? ORDER BY games DESC, n DESC, last DESC, id ASC LIMIT ?`;
const REPORT_FROM = 'FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id LEFT JOIN party_report_replays y ON y.report_id = r.id LEFT JOIN party_report_reasons z ON z.report_id = r.id';
const REPORT_COLUMNS = 'r.id, r.game, r.drawer_id, r.drawer_name, r.drawer_username, r.reporter_id, r.reporter_name, r.ink, r.word, r.at, r.created, r.status, r.dismissed_at, r.dismissed_by, x.id AS text_id, x.text, x.context, y.data AS replay, z.reason AS reason, z.note AS reason_note';
const DROP_ORPHAN_TEXTS = 'DELETE FROM party_report_texts WHERE id NOT IN (SELECT id FROM party_reports)';
const DROP_ORPHAN_REPLAYS = 'DELETE FROM party_report_replays WHERE report_id NOT IN (SELECT id FROM party_reports)';
const DROP_ORPHAN_REASONS = 'DELETE FROM party_report_reasons WHERE report_id NOT IN (SELECT id FROM party_reports)';
const REPLAY_FIELDS = new Set(['v', 'kind', 'authors', 'events', 'grid', 'truncated', 'late']);
const STROKE_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const GRID_RE = new RegExp(`^[${PIXEL_CODES}]{${PIXEL_CELLS}}$`);
const BAD_REPLAY = "The drawing's replay doesn't look right.";

function bad(code, message) {
  return new HttpError(400, code, message);
}

function cleanId(value, what) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) throw bad('bad_id', `The ${what} id doesn't look right.`);
  return value.trim().toLowerCase();
}

function cleanName(value) {
  return cleanText(value, NAME_MAX) || 'Player';
}

function cleanHandle(value, what = 'drawer') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw bad('bad_username', `The ${what}'s username doesn't look right.`);
  const text = cleanText(value.replace(/^@+/, ''), NAME_MAX);
  return text ? text.replace(/\s+/g, '') : null;
}

function cleanPerson(value, what, withHandle) {
  if (!isPlainObject(value)) throw bad('bad_person', `Say who the ${what} is.`);
  const out = { id: cleanId(value.id, what), name: cleanName(value.name) };
  if (withHandle) out.username = cleanHandle(value.username, what);
  return out;
}

export function cleanInk(value) {
  if (!Array.isArray(value)) throw bad('bad_ink', 'The drawing is missing.');
  if (value.length > MAX_STROKES) throw bad('bad_ink', 'That drawing is too big to report.');
  let total = 0;
  for (const s of value) {
    if (typeof s !== 'string' || !INK_RE.test(s)) throw bad('bad_ink', "The drawing doesn't look right.");
    total += s.length;
    if (total > MAX_INK_CHARS) throw bad('bad_ink', 'That drawing is too big to report.');
  }
  return value.slice();
}

function strokeOk(s) {
  if (typeof s !== 'string' || !INK_RE.test(s)) return false;
  const c = STROKE_ABC.indexOf(s[0]);
  if (c < 0 || c > 12) return false;
  const head = c === 12 ? 4 : 0;
  if (s.length < head + 6) return false;
  const z = STROKE_ABC.indexOf(s[head + 1]);
  return z >= 0 && z <= 4;
}

function replayAuthor(value, seen) {
  if (!isPlainObject(value) || Object.keys(value).some((k) => k !== 'id' && k !== 'name')) throw bad('bad_replay', BAD_REPLAY);
  if (typeof value.id !== 'string' || !ID_RE.test(value.id.trim())) throw bad('bad_replay', 'An artist id in the replay doesn\'t look right.');
  const id = value.id.trim().toLowerCase();
  if (seen.has(id)) throw bad('bad_replay', 'An artist is listed twice in the replay.');
  seen.add(id);
  if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') throw bad('bad_replay', BAD_REPLAY);
  return { id, name: cleanName(value.name) };
}

export function cleanReplay(value, game, drawerId, drawer = null, ink = null) {
  const out = readReplay(value, game, drawerId);
  const me = drawerId ? String(drawerId).toLowerCase() : '';
  if (me && SOLO_GAMES.includes(game) && (out.authors.length !== 1 || out.authors[0].id !== me)) throw bad('bad_replay', 'Only the reported player can be an artist in this replay.');
  if (drawer && drawer.name) for (const a of out.authors) if (a.id === me) a.name = drawer.name;
  if (out.kind === 'pixel' && pixelMismatch(out.events, out.grid).size) throw bad('bad_replay', "The replay doesn't end in the reported picture.");
  if (ink && me && !inkMatches(out, ink, MAX_STROKES, MAX_INK_CHARS, me)) throw bad('bad_replay', "The replay doesn't end in the reported drawing.");
  return out;
}

function readReplay(value, game, drawerId) {
  if (!isPlainObject(value)) throw bad('bad_replay', BAD_REPLAY);
  let size = Infinity;
  try {
    size = JSON.stringify(value).length;
  } catch {
    size = Infinity;
  }
  if (size > REPLAY_CHARS) throw bad('bad_replay', 'That replay is too big to report.');
  for (const k of Object.keys(value)) if (!REPLAY_FIELDS.has(k)) throw bad('bad_replay', BAD_REPLAY);
  const kind = game === 'pixel' ? 'pixel' : 'ink';
  if (value.v !== REPLAY_VERSION || value.kind !== kind) throw bad('bad_replay', BAD_REPLAY);
  if (!Array.isArray(value.authors) || !value.authors.length || value.authors.length > REPLAY_AUTHORS) throw bad('bad_replay', 'The replay has too many or too few artists.');
  const seen = new Set();
  const authors = value.authors.map((a) => replayAuthor(a, seen));
  if (drawerId && !seen.has(String(drawerId).toLowerCase())) throw bad('bad_replay', "The reported player isn't one of the replay's artists.");
  if (!Array.isArray(value.events) || !value.events.length || value.events.length > REPLAY_EVENTS) throw bad('bad_replay', 'The replay has too many or too few steps.');
  const used = new Set();
  const events = [];
  let last = 0;
  let count = 0;
  for (const e of value.events) {
    if (!Array.isArray(e) || e.length !== (kind === 'pixel' ? 4 : 3)) throw bad('bad_replay', BAD_REPLAY);
    const [a, t] = e;
    if (!Number.isInteger(a) || a < 0 || a >= authors.length) throw bad('bad_replay', 'A step in the replay names an artist that is not listed.');
    if (!Number.isInteger(t) || t < 0 || t > REPLAY_MAX_MS) throw bad('bad_replay', 'A step in the replay has a bad time.');
    if (t < last) throw bad('bad_replay', 'The replay steps are out of order.');
    last = t;
    used.add(a);
    if (kind === 'pixel') {
      if (!Number.isInteger(e[2]) || e[2] < 0 || e[2] >= PIXEL_CELLS) throw bad('bad_replay', 'A pixel in the replay is off the canvas.');
      if (typeof e[3] !== 'string' || e[3].length !== 1 || !PIXEL_CODES.includes(e[3])) throw bad('bad_replay', 'A pixel in the replay has a colour that is not in the palette.');
      events.push([a, t, e[2], e[3]]);
    } else if (typeof e[2] === 'string') {
      if (!strokeOk(e[2])) throw bad('bad_replay', 'A line in the replay doesn\'t look right.');
      count += 1;
      events.push([a, t, e[2]]);
    } else {
      if (!Number.isInteger(e[2]) || e[2] < 0 || e[2] > count) throw bad('bad_replay', 'An undo in the replay doesn\'t add up.');
      count = e[2];
      events.push([a, t, e[2]]);
    }
  }
  if (used.size !== authors.length) throw bad('bad_replay', 'The replay lists an artist who drew nothing.');
  const out = { v: REPLAY_VERSION, kind, authors, events };
  if (kind === 'pixel') {
    if (typeof value.grid !== 'string' || !GRID_RE.test(value.grid)) throw bad('bad_replay', 'The pixel picture in the replay doesn\'t look right.');
    out.grid = value.grid;
  } else if (value.grid !== undefined) {
    throw bad('bad_replay', BAD_REPLAY);
  }
  for (const k of ['truncated', 'late']) {
    if (value[k] === undefined || value[k] === false) continue;
    if (value[k] !== true) throw bad('bad_replay', BAD_REPLAY);
    out[k] = true;
  }
  return out;
}

function cleanAt(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at < 0 || at > 1e15) throw bad('bad_time', "The report time doesn't look right.");
  return Math.floor(at);
}

export function cleanTextReport(body) {
  if (typeof body.game !== 'string' || !TEXT_GAMES.has(body.game)) throw bad('bad_game', 'Only text from YapOS Party games can be reported.');
  const author = cleanPerson(body.author, 'author', true);
  const reporter = cleanPerson(body.reporter, 'reporter', false);
  if (author.id === reporter.id) throw bad('own_text', "You can't report your own words.");
  if (typeof body.text !== 'string') throw bad('bad_text', 'Say what was written.');
  const text = cleanText(body.text, TEXT_MAX + 1);
  if (!text) throw bad('bad_text', 'Say what was written.');
  if (Array.from(text).length > TEXT_MAX) throw bad('bad_text', `That text is too long to report. Keep it under ${TEXT_MAX} characters.`);
  let context = null;
  if (body.context !== null && body.context !== undefined) {
    if (typeof body.context !== 'string') throw bad('bad_context', "The context doesn't look right.");
    context = cleanText(body.context, CONTEXT_MAX);
  }
  return { kind: 'text', game: body.game, author, reporter, text, context, at: cleanAt(body.at) };
}

export function cleanReason(body) {
  const raw = body.reason;
  if (raw === undefined || raw === null || raw === '') {
    if (body.reasonNote !== undefined && body.reasonNote !== null && body.reasonNote !== '') throw bad('bad_reason', 'Pick why you are reporting first.');
    return { reason: null, reasonNote: null };
  }
  if (typeof raw !== 'string' || !REPORT_REASONS.includes(raw)) throw bad('bad_reason', 'Pick rude, spam, cheating or something else.');
  let reasonNote = null;
  if (body.reasonNote !== undefined && body.reasonNote !== null) {
    if (typeof body.reasonNote !== 'string') throw bad('bad_reason_note', "The note doesn't look right.");
    const text = cleanText(body.reasonNote, REASON_NOTE_MAX + 1) || '';
    if (Array.from(text).length > REASON_NOTE_MAX) throw bad('bad_reason_note', `Keep the note under ${REASON_NOTE_MAX} characters.`);
    reasonNote = text ? censor(text).text : null;
  }
  return { reason: raw, reasonNote };
}

export function cleanAnyReport(body) {
  const kind = body.kind === undefined || body.kind === null ? 'drawing' : body.kind;
  if (typeof kind !== 'string' || !REPORT_KINDS.has(kind)) throw bad('bad_kind', 'Only drawings and text can be reported.');
  const base = kind === 'text' ? cleanTextReport(body) : { kind: 'drawing', ...cleanReport(body) };
  return { ...base, ...cleanReason(body) };
}

export function cleanReport(body) {
  if (typeof body.game !== 'string' || !REPORT_GAMES.has(body.game)) throw bad('bad_game', 'Only drawings from the drawing games can be reported.');
  const drawer = cleanPerson(body.drawer, 'drawer', true);
  const reporter = cleanPerson(body.reporter, 'reporter', false);
  if (drawer.id === reporter.id) throw bad('own_drawing', "You can't report your own drawing.");
  const ink = body.game === 'pixel' ? [] : cleanInk(body.ink);
  let word = null;
  if (body.word !== null && body.word !== undefined) {
    if (typeof body.word !== 'string') throw bad('bad_word', "The word doesn't look right.");
    word = cleanText(body.word, WORD_MAX);
  }
  const replay = body.replay === undefined || body.replay === null ? null : cleanReplay(body.replay, body.game, drawer.id, drawer, ink);
  return { game: body.game, drawer, reporter, ink, word, at: cleanAt(body.at), replay };
}

export function ipBucket(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw.includes(':')) return raw || 'unknown';
  if (raw.includes('.')) return raw.slice(raw.lastIndexOf(':') + 1);
  const [head, tail] = raw.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const full = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

export async function reportIpHash(env, ip) {
  const salt = String(env.REPORT_SALT || env.BOT_SECRET || env.YAPIN_CLIENT_SECRET || '');
  return (await sha256Hex(`report-ip:${salt}:${ipBucket(ip)}`)).slice(0, 32);
}

export async function postActivityReport(request, env, t) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  if (!origin || !expected || origin !== expected) {
    return fail(403, 'forbidden', 'This report was blocked for your safety. Reload the game and try again.');
  }
  const ipHash = await reportIpHash(env, clientIp(request));
  const body = await readJson(request, REPORT_BODY_LIMIT);
  const isText = body.kind === 'text';
  const limit = await hit(env.DB, isText ? `reports:text:ip:${ipHash}` : `reports:ip:${ipHash}`, isText ? LIMITS.textReports : LIMITS.reports, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "You've sent a lot of reports. Try again in a few minutes.");
  const report = cleanAnyReport(body);
  const recent = isText
    ? await env.DB.prepare('SELECT COUNT(*) AS n, MIN(created) AS first FROM party_report_texts WHERE ip_hash = ? AND created > ?').bind(ipHash, t - REPORT_WINDOW).first()
    : await env.DB.prepare('SELECT COUNT(*) AS n, MIN(created) AS first FROM party_reports WHERE ip_hash = ? AND created > ? AND id NOT IN (SELECT id FROM party_report_texts WHERE ip_hash = ?)').bind(ipHash, t - REPORT_WINDOW, ipHash).first();
  if (Number(recent && recent.n) >= (isText ? TEXT_REPORTS_PER_WINDOW : REPORTS_PER_WINDOW)) {
    const wait = Math.max(1, Math.ceil((Number(recent.first) + REPORT_WINDOW - t) / 1000));
    return tooMany(wait, "You've sent a lot of reports. Try again in a few minutes.");
  }
  const who = isText ? report.author : report.drawer;
  const dupe = isText
    ? await env.DB.prepare('SELECT r.id FROM party_reports r JOIN party_report_texts x ON x.id = r.id WHERE r.reporter_id = ? AND r.drawer_id = ? AND r.created > ? AND x.text = ? LIMIT 1').bind(report.reporter.id, who.id, t - DEDUPE_WINDOW, report.text).first()
    : await env.DB.prepare('SELECT r.id FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id WHERE r.reporter_id = ? AND r.drawer_id = ? AND r.created > ? AND x.id IS NULL LIMIT 1').bind(report.reporter.id, who.id, t - DEDUPE_WINDOW).first();
  if (dupe) return json({ ok: true, duplicate: true }, 200);
  const all = await hit(env.DB, 'reports:all', LIMITS.reportsAll, t);
  if (!all.ok) return tooMany(all.retryAfter, 'Lots of reports are coming in right now. Try again in a minute.');
  const id = randomToken(12);
  const insert = env.DB.prepare(
    `INSERT INTO party_reports (id, game, drawer_id, drawer_name, drawer_username, reporter_id, reporter_name, ink, word, at, created, ip_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).bind(id, report.game, who.id, who.name, who.username, report.reporter.id, report.reporter.name, isText ? '[]' : JSON.stringify(report.ink), isText ? null : report.word, report.at, t, ipHash);
  const stmts = [insert];
  if (isText) stmts.push(env.DB.prepare('INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES (?, ?, ?, ?, ?)').bind(id, report.text, report.context, ipHash, t));
  else if (report.replay) stmts.push(env.DB.prepare('INSERT INTO party_report_replays (report_id, data, created) VALUES (?, ?, ?)').bind(id, JSON.stringify(report.replay), t));
  if (report.reason) stmts.push(env.DB.prepare('INSERT INTO party_report_reasons (report_id, reason, note, created) VALUES (?, ?, ?, ?)').bind(id, report.reason, report.reasonNote, t));
  if (stmts.length > 1) await env.DB.batch(stmts);
  else await insert.run();
  if (report.reason === 'cheating') await cheatReportAlert(env.DB, who, t).catch(() => null);
  await trimReports(env.DB);
  return json({ ok: true }, 201);
}

export async function trimReports(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM party_reports').first();
  const extra = Number(row && row.n) - MAX_REPORTS;
  if (extra <= 0) return 0;
  const [res] = await db.batch([
    db.prepare("DELETE FROM party_reports WHERE id IN (SELECT id FROM party_reports ORDER BY (status = 'open') ASC, created ASC, id ASC LIMIT ?)").bind(extra),
    db.prepare(DROP_ORPHAN_TEXTS),
    db.prepare(DROP_ORPHAN_REPLAYS),
    db.prepare(DROP_ORPHAN_REASONS),
  ]);
  return Number((res && res.meta && res.meta.changes) || 0);
}

export function cleanupStatements(db, t) {
  return [
    db.prepare("DELETE FROM party_reports WHERE status = 'dismissed' AND dismissed_at < ?").bind(t - DISMISSED_KEEP),
    db.prepare("DELETE FROM party_reports WHERE id IN (SELECT id FROM party_reports ORDER BY (status = 'open') DESC, created DESC, id DESC LIMIT -1 OFFSET ?)").bind(MAX_REPORTS),
    db.prepare(DROP_ORPHAN_TEXTS),
    db.prepare(DROP_ORPHAN_REPLAYS),
    db.prepare(DROP_ORPHAN_REASONS),
    db.prepare('DELETE FROM party_ban_log WHERE at < ?').bind(t - BAN_LOG_KEEP),
  ];
}

async function adminSet(db, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT id FROM party_admins WHERE id IN (${marks})`).bind(...ids).all();
  return new Set(((res && res.results) || []).map((r) => String(r.id).toLowerCase()));
}

function banSet(db, ids, t) {
  return activeBanIds(db, ids, t);
}

export async function partyRole(env, userId) {
  if (typeof userId !== 'string' || !userId) return null;
  if (isPartyOwner(env, userId)) return 'owner';
  const row = await env.DB.prepare('SELECT id FROM party_admins WHERE id = ?').bind(userId.toLowerCase()).first();
  return row ? 'admin' : null;
}

function roleOf(env, admins, id) {
  if (isPartyOwner(env, id)) return 'owner';
  return admins.has(id.toLowerCase()) ? 'admin' : null;
}

function profileOut(p) {
  return p ? { username: p.username, display_name: p.display_name, avatar: p.avatar } : null;
}

function replayOut(env, data, profiles, admins, bans) {
  return {
    v: data.v,
    kind: data.kind,
    authors: data.authors.map((a) => ({
      id: a.id,
      name: a.name,
      profile: profileOut(profiles.get(a.id)),
      banned: bans.has(String(a.id).toLowerCase()),
      role: roleOf(env, admins, String(a.id)),
    })),
    events: data.events,
    grid: typeof data.grid === 'string' ? data.grid : null,
    truncated: data.truncated === true,
    late: data.late === true,
  };
}

export async function flaggedPeople(db, t, onlyId = null) {
  const sql = FLAG_SQL.replace('{live}', ` AND ${banLive('b', t)}`).replace('{only}', onlyId ? ' AND r.drawer_id = ?' : '');
  const args = [FLAG_SESSION, t - FLAG_WINDOW, ...(onlyId ? [onlyId] : []), FLAG_GAMES, FLAG_REPORTERS, FLAG_REPORTERS, FLAG_PEOPLE];
  const res = await db.prepare(sql).bind(...args).all();
  const out = new Map();
  for (const r of (res && res.results) || []) {
    out.set(String(r.id).toLowerCase(), { games: Number(r.games) || 0, reporters: Number(r.reporters) || 0, reports: Number(r.n) || 0 });
  }
  return out;
}

async function noteCounts(db, ids, viewer) {
  const list = ids.filter((id) => id !== viewer);
  if (!list.length) return new Map();
  const marks = list.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT user_id, COUNT(*) AS n FROM party_mod_notes WHERE user_id IN (${marks}) GROUP BY user_id`).bind(...list).all();
  return new Map(((res && res.results) || []).map((r) => [String(r.user_id).toLowerCase(), Number(r.n) || 0]));
}

function viewerOf(session) {
  return session && session.user_id ? String(session.user_id).toLowerCase() : '';
}

function notesHiddenFrom(session, role) {
  return role === 'owner' ? '' : viewerOf(session);
}

async function shapeReports(request, env, page, t, extraIds = [], { flags = new Map(), viewer = '' } = {}) {
  const replays = new Map();
  for (const r of page) {
    if (r.text_id !== null && r.text_id !== undefined) continue;
    const data = r.replay ? parseJsonSafe(r.replay, null) : null;
    if (data && Array.isArray(data.authors) && Array.isArray(data.events)) replays.set(r.id, data);
  }
  const artists = [...replays.values()].flatMap((x) => x.authors.map((a) => a && a.id)).filter((id) => typeof id === 'string');
  const drawers = [...new Set(page.map((r) => String(r.drawer_id).toLowerCase()).concat(artists.map((id) => id.toLowerCase())))].slice(0, 90);
  const people = [...new Set(extraIds.concat(page.flatMap((r) => [r.drawer_id, r.reporter_id])).concat(artists))].slice(0, MAX_PROFILE_IDS);
  const [admins, bans, found, notes] = await Promise.all([adminSet(env.DB, drawers), banSet(env.DB, drawers, t), lookupProfiles(env, people, t, clientIp(request)), noteCounts(env.DB, drawers, viewer)]);
  const reports = [];
  for (const r of page) {
    const isText = r.text_id !== null && r.text_id !== undefined;
    const ink = isText ? [] : parseJsonSafe(r.ink, []);
    reports.push({
      id: r.id,
      kind: isText ? 'text' : 'drawing',
      game: r.game,
      text: isText ? r.text : null,
      context: isText ? r.context || null : null,
      word: r.word || null,
      reason: REPORT_REASONS.includes(r.reason) ? r.reason : null,
      reasonNote: REPORT_REASONS.includes(r.reason) && r.reason_note ? r.reason_note : null,
      at: Number(r.at),
      created: Number(r.created),
      status: r.status,
      dismissed_at: r.dismissed_at === null || r.dismissed_at === undefined ? null : Number(r.dismissed_at),
      dismissed_by: r.dismissed_by || null,
      ink: Array.isArray(ink) ? ink.filter((s) => typeof s === 'string') : [],
      drawer: {
        id: r.drawer_id,
        name: r.drawer_name,
        username: r.drawer_username || null,
        profile: profileOut(found.profiles.get(r.drawer_id)),
        banned: bans.has(String(r.drawer_id).toLowerCase()),
        role: roleOf(env, admins, String(r.drawer_id)),
        flag: bans.has(String(r.drawer_id).toLowerCase()) ? null : flags.get(String(r.drawer_id).toLowerCase()) || null,
        notes: notes.get(String(r.drawer_id).toLowerCase()) || 0,
      },
      reporter: { id: r.reporter_id, name: r.reporter_name, profile: profileOut(found.profiles.get(r.reporter_id)) },
      ...(replays.has(r.id) ? { replay: replayOut(env, replays.get(r.id), found.profiles, admins, bans) } : {}),
    });
  }
  return { reports, found };
}

async function listReports(request, env, session, url, role, t) {
  const status = url.searchParams.get('status') || 'open';
  if (!STATUSES.has(status)) throw bad('bad_status', 'Pick open, dismissed or all reports.');
  const kind = url.searchParams.get('kind') || 'all';
  if (!KIND_FILTERS.has(kind)) throw bad('bad_kind', 'Pick drawings, text, flagged or all reports.');
  const reason = url.searchParams.get('reason') || 'all';
  if (!REASON_FILTERS.has(reason)) throw bad('bad_reason', 'Pick rude, spam, cheating, other or all reasons.');
  const reasonSql = reason === 'all' ? '' : ' AND z.reason = ?';
  const reasonArgs = reason === 'all' ? [] : [reason];
  const before = url.searchParams.get('before');
  let cursor = null;
  if (before) {
    const m = CURSOR_RE.exec(before);
    if (!m) throw bad('bad_cursor', 'That page of reports does not exist.');
    cursor = { created: Number(m[1]), id: m[2] };
  }
  const db = env.DB;
  const flags = await flaggedPeople(db, t);
  const flaggedIds = [...flags.keys()];
  const rank = new Map(flaggedIds.map((id, i) => [id, i]));
  const rankOf = (r) => (rank.has(String(r.drawer_id).toLowerCase()) ? rank.get(String(r.drawer_id).toLowerCase()) : flaggedIds.length);
  const byRank = (a, b) => rankOf(a) - rankOf(b) || Number(b.created) - Number(a.created) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const idMarks = flaggedIds.map(() => '?').join(', ');
  const kindSql = kind === 'drawing' ? ' AND x.id IS NULL' : kind === 'text' ? ' AND x.id IS NOT NULL' : '';
  let top = [];
  let page = [];
  let more = false;
  if (kind === 'flagged') {
    if (flaggedIds.length) {
      const statusSql = status === 'all' ? '' : ' AND r.status = ?';
      const res = await db.prepare(`SELECT ${REPORT_COLUMNS} ${REPORT_FROM} WHERE r.drawer_id IN (${idMarks})${statusSql}${reasonSql} ORDER BY r.created DESC, r.id DESC LIMIT ?`).bind(...flaggedIds, ...(status === 'all' ? [] : [status]), ...reasonArgs, FLAGGED_REPORTS).all();
      top = ((res && res.results) || []).sort(byRank);
    }
  } else {
    const lift = flaggedIds.length > 0 && status !== 'dismissed';
    const where = [];
    const args = [];
    if (status !== 'all') {
      where.push('r.status = ?');
      args.push(status);
    }
    if (kind === 'drawing') where.push('x.id IS NULL');
    if (kind === 'text') where.push('x.id IS NOT NULL');
    if (reasonArgs.length) {
      where.push('z.reason = ?');
      args.push(...reasonArgs);
    }
    if (lift) {
      where.push(`NOT (r.status = 'open' AND r.drawer_id IN (${idMarks}))`);
      args.push(...flaggedIds);
    }
    if (cursor) {
      where.push('(r.created < ? OR (r.created = ? AND r.id < ?))');
      args.push(cursor.created, cursor.created, cursor.id);
    }
    const sql = `SELECT ${REPORT_COLUMNS} ${REPORT_FROM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created DESC, r.id DESC LIMIT ?`;
    const [res, lead] = await Promise.all([
      db.prepare(sql).bind(...args, REPORTS_PAGE + 1).all(),
      lift && !cursor
        ? db.prepare(`SELECT ${REPORT_COLUMNS} ${REPORT_FROM} WHERE r.status = 'open' AND r.drawer_id IN (${idMarks})${kindSql}${reasonSql} ORDER BY r.created DESC, r.id DESC LIMIT ?`).bind(...flaggedIds, ...reasonArgs, FLAGGED_REPORTS).all()
        : null,
    ]);
    const rows = (res && res.results) || [];
    more = rows.length > REPORTS_PAGE;
    page = rows.slice(0, REPORTS_PAGE);
    top = ((lead && lead.results) || []).sort(byRank);
  }
  const [shaped, open] = await Promise.all([
    shapeReports(request, env, top.concat(page), t, [], { flags, viewer: notesHiddenFrom(session, role) }),
    db.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE status = 'open'").first(),
  ]);
  const { reports, found } = shaped;
  const last = page[page.length - 1];
  let flaggedReports = 0;
  for (const f of flags.values()) flaggedReports += f.reports;
  return json({
    reports,
    next: more && last ? `${Number(last.created)}.${last.id}` : null,
    open: Number(open && open.n) || 0,
    flagged: { people: flags.size, reports: flaggedReports },
    status,
    kind,
    reason,
    role,
    pending: found.pending,
  });
}

function reportId(raw) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That report id doesn't look right.");
  return raw;
}

const SELF_CLEAR = "You can't clear reports about yourself. Ask another admin or the owner.";

function aboutSelf(session, role, drawerId) {
  return role !== 'owner' && typeof drawerId === 'string' && drawerId.toLowerCase() === String(session.user_id).toLowerCase();
}

async function dismissReport(env, session, role, raw, t) {
  const id = reportId(raw);
  const row = await env.DB.prepare('SELECT id, status, drawer_id, drawer_name, game FROM party_reports WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'not_found', 'That report is gone. Someone may have deleted it.');
  if (aboutSelf(session, role, row.drawer_id)) return fail(403, 'is_self', SELF_CLEAR);
  if (row.status !== 'open') return json({ ok: true, dismissed: false });
  const [log, res] = await env.DB.batch([
    logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'dismiss', targetId: row.drawer_id, targetName: row.drawer_name, detail: { report: id, game: row.game }, t }, { sql: "EXISTS (SELECT 1 FROM party_reports WHERE id = ? AND status = 'open')", args: [id] }),
    env.DB.prepare("UPDATE party_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE id = ? AND status = 'open'").bind(t, session.user_id, id),
  ]);
  return json({ ok: true, dismissed: Boolean((res && res.meta && res.meta.changes) || (log && log.meta && log.meta.changes)) });
}

function personId(raw) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That user id doesn't look right.");
  return raw.toLowerCase();
}

function cardOut(card) {
  if (!card) return null;
  if (card.hidden) return { hidden: true };
  return {
    hidden: false,
    name: card.name || null,
    username: card.username || null,
    level: card.level,
    progress: card.progress || null,
    badges: Array.isArray(card.badges) ? card.badges : [],
    badgeCount: Number(card.badgeCount) || 0,
    party: card.party || null,
    rank: card.rank || null,
    page: Boolean(card.page),
  };
}

async function personReports(request, env, session, raw, role, t) {
  const id = personId(raw);
  const db = env.DB;
  const viewer = notesHiddenFrom(session, role);
  const self = id === viewer;
  const [list, agg, games, made, ban, log, isAdmin, card, flags, noteRows, warnRows, banTerms, why] = await Promise.all([
    db.prepare(`SELECT ${REPORT_COLUMNS} ${REPORT_FROM} WHERE r.drawer_id = ? ORDER BY r.created DESC, r.id DESC LIMIT ?`).bind(id, PERSON_REPORTS + 1).all(),
    db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, MIN(created) AS first, MAX(created) AS last FROM party_reports WHERE drawer_id = ?").bind(id).first(),
    db.prepare('SELECT r.game AS game, COUNT(*) AS n, SUM(CASE WHEN x.id IS NULL THEN 1 ELSE 0 END) AS drawings FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id WHERE r.drawer_id = ? GROUP BY r.game ORDER BY n DESC, r.game ASC').bind(id).all(),
    db.prepare('SELECT COUNT(*) AS n FROM party_reports WHERE reporter_id = ?').bind(id).first(),
    activeBan(db, id, t),
    db.prepare('SELECT action, reason, by_id, at FROM party_ban_log WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').bind(id, BAN_LOG_SHOWN).all(),
    adminSet(db, [id]).then((x) => x.has(id)),
    buildCard(db, id).catch(() => null),
    flaggedPeople(db, t, id),
    self ? null : noteQuery(db, id),
    warningRows(db, id),
    db.prepare("SELECT created, detail FROM party_mod_log WHERE target_id = ? AND action = 'ban' ORDER BY created DESC LIMIT ?").bind(id, BAN_LOG_SHOWN * 2).all(),
    db.prepare('SELECT z.reason AS reason, COUNT(*) AS n FROM party_reports r JOIN party_report_reasons z ON z.report_id = r.id WHERE r.drawer_id = ? GROUP BY z.reason').bind(id).all(),
  ]);
  const reasons = Object.fromEntries(REPORT_REASONS.map((k) => [k, 0]));
  for (const r of (why && why.results) || []) if (REPORT_REASONS.includes(r.reason)) reasons[r.reason] = Number(r.n) || 0;
  const rows = (list && list.results) || [];
  const page = rows.slice(0, PERSON_REPORTS);
  const authors = (noteRows ? noteRows.map((x) => x.author_id) : []).concat(warnRows.map((w) => w.author_id));
  const lengths = new Map();
  for (const r of (banTerms && banTerms.results) || []) {
    const d = parseJsonSafe(r.detail, null);
    if (d && typeof d.duration === 'string' && BAN_DURATION_NAMES[d.duration] && !lengths.has(Number(r.created))) lengths.set(Number(r.created), d.duration);
  }
  const { reports, found } = await shapeReports(request, env, page, t, [id, ...new Set(authors)], { flags, viewer });
  const flag = ban ? null : flags.get(id) || null;
  const latest = page[0] || null;
  const prof = found.profiles.get(id) || null;
  const shown = cardOut(card);
  const username = (prof && prof.username) || (shown && shown.username) || (latest && latest.drawer_username) || (ban && ban.username) || null;
  const name = (prof && prof.display_name) || (latest && latest.drawer_name) || (shown && shown.name) || (ban && ban.name) || username || 'Player';
  return json({
    person: {
      id,
      name,
      username,
      avatar: (prof && prof.avatar) || null,
      role: isPartyOwner(env, id) ? 'owner' : isAdmin ? 'admin' : null,
      banned: ban ? { reason: ban.reason || null, by: ban.banned_by, at: Number(ban.banned_at), until: ban.until === null || ban.until === undefined ? null : Number(ban.until), duration: ban.duration || 'forever' } : null,
      card: shown,
      flag,
    },
    notes: noteRows ? notesOut(noteRows, found.profiles, session, role) : null,
    warnings: warningsOut(warnRows, found.profiles),
    counts: {
      total: Number(agg && agg.n) || 0,
      open: Number(agg && agg.open) || 0,
      first: agg && agg.first !== null && agg.first !== undefined ? Number(agg.first) : null,
      last: agg && agg.last !== null && agg.last !== undefined ? Number(agg.last) : null,
      made: Number(made && made.n) || 0,
      warnings: warnRows.length,
      reasons,
      games: ((games && games.results) || []).map((g) => ({ game: g.game, n: Number(g.n) || 0, drawings: Number(g.drawings) || 0 })),
    },
    bans: ((log && log.results) || []).map((b) => ({ action: b.action === 'unban' ? 'unban' : 'ban', reason: b.reason || null, by: b.by_id, at: Number(b.at), ...(b.action === 'unban' ? { auto: b.by_id === 'yapos' } : { duration: lengths.get(Number(b.at)) || null }) })),
    reports,
    more: rows.length > PERSON_REPORTS,
    role,
    pending: found.pending,
  });
}

async function noteQuery(db, id) {
  const res = await db.prepare('SELECT id, user_id, author_id, author_name, text, created FROM party_mod_notes WHERE user_id = ? ORDER BY created DESC, id DESC LIMIT ?').bind(id, NOTES_PER_PERSON).all();
  return (res && res.results) || [];
}

function canDeleteNote(session, role, note) {
  return role === 'owner' || String(note.author_id).toLowerCase() === viewerOf(session);
}

function notesOut(rows, profiles, session, role) {
  return rows.map((n) => {
    const p = profiles.get(n.author_id) || null;
    return {
      id: n.id,
      text: n.text,
      created: Number(n.created),
      author: { id: n.author_id, name: (p && p.display_name) || n.author_name, avatar: (p && p.avatar) || null },
      mine: String(n.author_id).toLowerCase() === viewerOf(session),
      canDelete: canDeleteNote(session, role, n),
    };
  });
}

async function notesReply(request, env, session, role, id, t, extra = {}, status = 200) {
  const rows = await noteQuery(env.DB, id);
  const found = await lookupProfiles(env, [...new Set(rows.map((n) => n.author_id))].slice(0, MAX_PROFILE_IDS), t, clientIp(request));
  return json({ notes: notesOut(rows, found.profiles, session, role), max: NOTE_MAX, limit: NOTES_PER_PERSON, role, ...extra }, status);
}

export function cleanNote(value) {
  if (typeof value !== 'string') throw bad('bad_text', 'Write a note first.');
  const text = cleanText(value, NOTE_MAX + 1);
  if (!text) throw bad('bad_text', 'Write a note first.');
  if (Array.from(text).length > NOTE_MAX) throw bad('too_long', `Keep notes under ${NOTE_MAX} characters.`);
  return censor(text).text;
}

async function listNotes(request, env, session, role, raw, t) {
  const id = personId(raw);
  if (id === notesHiddenFrom(session, role)) return fail(403, 'is_self', NOTES_SELF);
  return notesReply(request, env, session, role, id, t);
}

async function addNote(request, env, session, role, raw, t) {
  const id = personId(raw);
  if (id === viewerOf(session)) return fail(403, 'is_self', "You can't leave notes about yourself.");
  const limit = await hit(env.DB, `notes:u:${viewerOf(session)}`, LIMITS.modNotes, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "That's a lot of notes at once. Wait a minute and try again.");
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (!NOTE_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  const text = cleanNote(body.text);
  const [count, total] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM party_mod_notes WHERE user_id = ?').bind(id).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM party_mod_notes').first(),
  ]);
  if (Number(count && count.n) >= NOTES_PER_PERSON) return fail(409, 'too_many', `They already have ${NOTES_PER_PERSON} notes. Delete an old one first.`);
  if (Number(total && total.n) >= NOTES_TOTAL) return fail(409, 'notes_full', 'Party staff have written as many notes as YapOS can keep. Delete some old ones first.');
  const name = cleanText(session.display_name || session.username, NAME_MAX) || 'Staff';
  const noteId = randomToken(12);
  const target = await personName(env.DB, id);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO party_mod_notes (id, user_id, author_id, author_name, text, created) VALUES (?, ?, ?, ?, ?, ?)').bind(noteId, id, viewerOf(session), name, text, t),
    logModAction(env.DB, { actorId: viewerOf(session), actorName: name, action: 'note_add', targetId: id, targetName: target, detail: { note: noteId }, t }),
  ]);
  return notesReply(request, env, session, role, id, t, { added: noteId }, 201);
}

async function deleteNote(request, env, session, role, raw, rawNote, t) {
  const id = personId(raw);
  if (id === notesHiddenFrom(session, role)) return fail(403, 'is_self', NOTES_SELF);
  if (typeof rawNote !== 'string' || !ID_RE.test(rawNote)) throw bad('bad_id', "That note id doesn't look right.");
  const row = await env.DB.prepare('SELECT id, author_id FROM party_mod_notes WHERE id = ? AND user_id = ?').bind(rawNote, id).first();
  if (!row) return fail(404, 'not_found', 'That note is gone. Someone may have deleted it.');
  if (!canDeleteNote(session, role, row)) return fail(403, 'not_yours', 'Only the person who wrote a note or the owner can delete it.');
  const target = await personName(env.DB, id);
  await env.DB.batch([
    logModAction(env.DB, { actorId: viewerOf(session), actorName: actorName(session), action: 'note_delete', targetId: id, targetName: target, detail: { note: rawNote, author: String(row.author_id).toLowerCase() === viewerOf(session) ? 'self' : 'other' }, t }, { sql: 'EXISTS (SELECT 1 FROM party_mod_notes WHERE id = ?)', args: [rawNote] }),
    env.DB.prepare('DELETE FROM party_mod_notes WHERE id = ?').bind(rawNote),
  ]);
  return notesReply(request, env, session, role, id, t, { deleted: true });
}

async function dismissPerson(env, session, role, raw, t) {
  const id = personId(raw);
  if (aboutSelf(session, role, id)) return fail(403, 'is_self', SELF_CLEAR);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(drawer_name) AS name FROM party_reports WHERE drawer_id = ? AND status = 'open'").bind(id).first();
  const [, res] = await env.DB.batch([
    logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'dismiss_all', targetId: id, targetName: (open && open.name) || null, detail: { count: Number(open && open.n) || 0 }, t }, { sql: "EXISTS (SELECT 1 FROM party_reports WHERE drawer_id = ? AND status = 'open')", args: [id] }),
    env.DB.prepare("UPDATE party_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE drawer_id = ? AND status = 'open'").bind(t, session.user_id, id),
  ]);
  return json({ ok: true, dismissed: Number((res && res.meta && res.meta.changes) || 0) });
}

function banLog(db, id, action, reason, by, t, guard = null) {
  const args = [randomToken(12), id, action, reason || null, by, t];
  if (!guard) return db.prepare('INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) VALUES (?, ?, ?, ?, ?, ?)').bind(...args);
  return db.prepare(`INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`).bind(...args, ...(guard.args || []));
}

async function deleteReport(env, session, role, raw, t) {
  const id = reportId(raw);
  const row = await env.DB.prepare('SELECT drawer_id, drawer_name, game FROM party_reports WHERE id = ?').bind(id).first();
  if (row && aboutSelf(session, role, row.drawer_id)) return fail(403, 'is_self', SELF_CLEAR);
  const stmts = [
    env.DB.prepare('DELETE FROM party_reports WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_report_texts WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_report_replays WHERE report_id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_report_reasons WHERE report_id = ?').bind(id),
  ];
  if (row) stmts.unshift(logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'report_delete', targetId: row.drawer_id, targetName: row.drawer_name, detail: { report: id, game: row.game }, t }, { sql: 'EXISTS (SELECT 1 FROM party_reports WHERE id = ?)', args: [id] }));
  const results = await env.DB.batch(stmts);
  const res = results[row ? 1 : 0];
  return json({ ok: true, deleted: Boolean(res && res.meta && res.meta.changes) });
}

async function listBans(request, env, role, t, extra = {}) {
  const res = await env.DB.prepare(`SELECT b.id, b.name, b.username, b.reason, b.banned_by, b.banned_at, bt.until, bt.duration FROM party_bans b LEFT JOIN party_ban_terms bt ON bt.user_id = b.id WHERE ${banLive('b', t)} ORDER BY b.banned_at DESC, b.id ASC`).all();
  const rows = (res && res.results) || [];
  const found = await lookupProfiles(env, rows.slice(0, MAX_PROFILE_IDS).map((r) => r.id), t, clientIp(request));
  const bans = rows.map((r) => {
    const p = found.profiles.get(r.id);
    return {
      id: r.id,
      name: r.name || null,
      username: (p && p.username) || r.username || null,
      display_name: (p && p.display_name) || null,
      avatar: (p && p.avatar) || null,
      reason: r.reason || null,
      banned_by: r.banned_by,
      banned_at: Number(r.banned_at),
      until: r.until === null || r.until === undefined ? null : Number(r.until),
      duration: r.duration || 'forever',
    };
  });
  return json({ bans, max: MAX_BANS, role, pending: found.pending, ...extra });
}

const BAN_FIELDS = new Set(['id', 'reason', 'name', 'username', 'duration']);

async function addBan(request, env, session, role, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (!BAN_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.id !== 'string' || !body.id.trim()) throw bad('bad_id', 'Say who to ban first.');
  const id = cleanId(body.id, 'user');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw bad('bad_reason', "The reason doesn't look right.");
  const reason = cleanText(body.reason, REASON_MAX);
  const duration = cleanDuration(body.duration);
  const name = typeof body.name === 'string' ? cleanText(body.name, NAME_MAX) : null;
  const username = typeof body.username === 'string' ? cleanHandle(body.username) : null;
  if (isPartyOwner(env, id)) return fail(400, 'is_owner', "The owner of YapOS Party can't be banned.");
  if (id === String(session.user_id).toLowerCase()) return fail(400, 'is_self', "You can't ban yourself.");
  const isAdmin = (await adminSet(env.DB, [id])).has(id);
  if (isAdmin && role !== 'owner') return fail(403, 'is_admin', "Party admins can't ban other party admins. Ask the owner.");
  const existing = await activeBan(env.DB, id, t);
  if (existing) return listBans(request, env, role, t, { banned: false });
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM party_bans b WHERE ${banLive('b', t)}`).first();
  if (Number(count && count.n) >= MAX_BANS) return fail(409, 'too_many', `There are already ${MAX_BANS} bans. Unban someone first.`);
  const target = name || username || (await personName(env.DB, id));
  const stmts = [
    env.DB.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, username = excluded.username, reason = excluded.reason, banned_by = excluded.banned_by, banned_at = excluded.banned_at').bind(id, name, username, reason, session.user_id, t),
    ...banTermStatements(env.DB, id, duration, t),
    banLog(env.DB, id, 'ban', reason, session.user_id, t),
    logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'ban', targetId: id, targetName: target, detail: { duration, reason: reason || null, removedAdmin: isAdmin || undefined }, t }),
  ];
  if (isAdmin) stmts.push(env.DB.prepare('DELETE FROM party_admins WHERE id = ?').bind(id));
  await env.DB.batch(stmts);
  return listBans(request, env, role, t, { banned: true, removedAdmin: isAdmin, duration });
}

async function removeBan(request, env, session, role, raw, t) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That user id doesn't look right.");
  const id = raw.toLowerCase();
  if (role !== 'owner' && id === String(session.user_id).toLowerCase()) return fail(403, 'is_self', "You can't unban yourself. Ask the owner.");
  const live = await activeBan(env.DB, id, t);
  const guard = live ? { sql: 'EXISTS (SELECT 1 FROM party_bans WHERE id = ?)', args: [id] } : { sql: '0', args: [] };
  const target = live ? live.name || live.username || (await personName(env.DB, id)) : null;
  const results = await env.DB.batch([
    banLog(env.DB, id, 'unban', null, session.user_id, t, guard),
    logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'unban', targetId: id, targetName: target, detail: live && live.until ? { early: true, until: Number(live.until), duration: live.duration } : null, t }, guard),
    env.DB.prepare('DELETE FROM party_bans WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_ban_terms WHERE user_id = ?').bind(id),
  ]);
  const unbanned = Boolean(live && results[2] && results[2].meta && results[2].meta.changes);
  return listBans(request, env, role, t, { unbanned });
}

async function warnPerson(request, env, session, role, raw, t) {
  const id = personId(raw);
  return sendWarning(request, env, session, role, id, t, {
    isOwnerId: (x) => isPartyOwner(env, x),
    isAdminId: async (x) => (await adminSet(env.DB, [x])).has(x),
  });
}

async function listWarnings(request, env, raw, t) {
  const id = personId(raw);
  const rows = await warningRows(env.DB, id);
  const found = await lookupProfiles(env, [...new Set(rows.map((w) => w.author_id))].slice(0, MAX_PROFILE_IDS), t, clientIp(request));
  return json({ warnings: warningsOut(rows, found.profiles) });
}

export async function partyStaffRoute(request, env, session, route, url, t) {
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', STAFF_ONLY);
  const n = route.length;
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  const nope = () => fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route[1] === 'reports' && route[2] === 'person' && n >= 4) {
    if (n === 4) return read ? personReports(request, env, session, route[3], role, t) : nope();
    if (n === 5 && route[4] === 'dismiss') return method === 'POST' ? dismissPerson(env, session, role, route[3], t) : nope();
    if (n === 5 && route[4] === 'notes') {
      if (read) return listNotes(request, env, session, role, route[3], t);
      if (method === 'POST') return addNote(request, env, session, role, route[3], t);
      return nope();
    }
    if (n === 5 && route[4] === 'warnings') {
      if (read) return listWarnings(request, env, route[3], t);
      if (method === 'POST') return warnPerson(request, env, session, role, route[3], t);
      return nope();
    }
    if (n === 6 && route[4] === 'notes') return method === 'DELETE' ? deleteNote(request, env, session, role, route[3], route[5], t) : nope();
    return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  }
  if (route[1] === 'reports') {
    if (n === 2) return read ? listReports(request, env, session, url, role, t) : nope();
    if (n === 3) return method === 'DELETE' ? deleteReport(env, session, role, route[2], t) : nope();
    if (n === 4 && route[3] === 'dismiss') return method === 'POST' ? dismissReport(env, session, role, route[2], t) : nope();
  }
  if (route[1] === 'modlog' && n === 2) return read ? listModLog(request, env, session, role, url, t) : nope();
  if (route[1] === 'bans') {
    if (n === 2) {
      if (read) return listBans(request, env, role, t);
      if (method === 'POST') return addBan(request, env, session, role, t);
      return nope();
    }
    if (n === 3) return method === 'DELETE' ? removeBan(request, env, session, role, route[2], t) : nope();
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
