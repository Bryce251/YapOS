import { MINUTE, DAY, ID_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, clientIp, publicOrigin, randomToken, parseJsonSafe, sha256Hex } from './util.js';
import { hit, tooMany, LIMITS } from './rate.js';
import { lookupProfiles, cleanText, MAX_PROFILE_IDS } from './profiles.js';
import { isPartyOwner } from './party.js';
import { buildCard } from './party-profile.js';
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

const INK_RE = /^[A-Za-z0-9_-]{6,4096}$/;
const CURSOR_RE = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/;
const STATUSES = new Set(['open', 'dismissed', 'all']);
const KIND_FILTERS = new Set(['drawing', 'text', 'all']);
const NAME_MAX = 64;
const WORD_MAX = 64;
const REASON_MAX = 200;
const STAFF_ONLY = 'Only the owner of YapOS Party and party admins can see reports.';
const REPORT_COLUMNS = 'r.id, r.game, r.drawer_id, r.drawer_name, r.drawer_username, r.reporter_id, r.reporter_name, r.ink, r.word, r.at, r.created, r.status, r.dismissed_at, r.dismissed_by, x.id AS text_id, x.text, x.context, y.data AS replay';
const DROP_ORPHAN_TEXTS = 'DELETE FROM party_report_texts WHERE id NOT IN (SELECT id FROM party_reports)';
const DROP_ORPHAN_REPLAYS = 'DELETE FROM party_report_replays WHERE report_id NOT IN (SELECT id FROM party_reports)';
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

export function cleanAnyReport(body) {
  const kind = body.kind === undefined || body.kind === null ? 'drawing' : body.kind;
  if (typeof kind !== 'string' || !REPORT_KINDS.has(kind)) throw bad('bad_kind', 'Only drawings and text can be reported.');
  return kind === 'text' ? cleanTextReport(body) : { kind: 'drawing', ...cleanReport(body) };
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
  if (isText) {
    await env.DB.batch([
      insert,
      env.DB.prepare('INSERT INTO party_report_texts (id, text, context, ip_hash, created) VALUES (?, ?, ?, ?, ?)').bind(id, report.text, report.context, ipHash, t),
    ]);
  } else if (report.replay) {
    await env.DB.batch([
      insert,
      env.DB.prepare('INSERT INTO party_report_replays (report_id, data, created) VALUES (?, ?, ?)').bind(id, JSON.stringify(report.replay), t),
    ]);
  } else {
    await insert.run();
  }
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
  ]);
  return Number((res && res.meta && res.meta.changes) || 0);
}

export function cleanupStatements(db, t) {
  return [
    db.prepare("DELETE FROM party_reports WHERE status = 'dismissed' AND dismissed_at < ?").bind(t - DISMISSED_KEEP),
    db.prepare("DELETE FROM party_reports WHERE id IN (SELECT id FROM party_reports ORDER BY (status = 'open') DESC, created DESC, id DESC LIMIT -1 OFFSET ?)").bind(MAX_REPORTS),
    db.prepare(DROP_ORPHAN_TEXTS),
    db.prepare(DROP_ORPHAN_REPLAYS),
    db.prepare('DELETE FROM party_ban_log WHERE at < ?').bind(t - BAN_LOG_KEEP),
  ];
}

async function adminSet(db, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT id FROM party_admins WHERE id IN (${marks})`).bind(...ids).all();
  return new Set(((res && res.results) || []).map((r) => String(r.id).toLowerCase()));
}

async function banSet(db, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const res = await db.prepare(`SELECT id FROM party_bans WHERE id IN (${marks})`).bind(...ids).all();
  return new Set(((res && res.results) || []).map((r) => String(r.id).toLowerCase()));
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

async function shapeReports(request, env, page, t, extraIds = []) {
  const replays = new Map();
  for (const r of page) {
    if (r.text_id !== null && r.text_id !== undefined) continue;
    const data = r.replay ? parseJsonSafe(r.replay, null) : null;
    if (data && Array.isArray(data.authors) && Array.isArray(data.events)) replays.set(r.id, data);
  }
  const artists = [...replays.values()].flatMap((x) => x.authors.map((a) => a && a.id)).filter((id) => typeof id === 'string');
  const drawers = [...new Set(page.map((r) => String(r.drawer_id).toLowerCase()).concat(artists.map((id) => id.toLowerCase())))].slice(0, 90);
  const people = [...new Set(extraIds.concat(page.flatMap((r) => [r.drawer_id, r.reporter_id])).concat(artists))].slice(0, MAX_PROFILE_IDS);
  const [admins, bans, found] = await Promise.all([adminSet(env.DB, drawers), banSet(env.DB, drawers), lookupProfiles(env, people, t, clientIp(request))]);
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
      },
      reporter: { id: r.reporter_id, name: r.reporter_name, profile: profileOut(found.profiles.get(r.reporter_id)) },
      ...(replays.has(r.id) ? { replay: replayOut(env, replays.get(r.id), found.profiles, admins, bans) } : {}),
    });
  }
  return { reports, found };
}

async function listReports(request, env, url, role, t) {
  const status = url.searchParams.get('status') || 'open';
  if (!STATUSES.has(status)) throw bad('bad_status', 'Pick open, dismissed or all reports.');
  const kind = url.searchParams.get('kind') || 'all';
  if (!KIND_FILTERS.has(kind)) throw bad('bad_kind', 'Pick drawings, text or all reports.');
  const before = url.searchParams.get('before');
  let cursor = null;
  if (before) {
    const m = CURSOR_RE.exec(before);
    if (!m) throw bad('bad_cursor', 'That page of reports does not exist.');
    cursor = { created: Number(m[1]), id: m[2] };
  }
  const where = [];
  const args = [];
  if (status !== 'all') {
    where.push('r.status = ?');
    args.push(status);
  }
  if (kind === 'drawing') where.push('x.id IS NULL');
  if (kind === 'text') where.push('x.id IS NOT NULL');
  if (cursor) {
    where.push('(r.created < ? OR (r.created = ? AND r.id < ?))');
    args.push(cursor.created, cursor.created, cursor.id);
  }
  const sql = `SELECT ${REPORT_COLUMNS} FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id LEFT JOIN party_report_replays y ON y.report_id = r.id${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created DESC, r.id DESC LIMIT ?`;
  const res = await env.DB.prepare(sql).bind(...args, REPORTS_PAGE + 1).all();
  const rows = (res && res.results) || [];
  const more = rows.length > REPORTS_PAGE;
  const page = rows.slice(0, REPORTS_PAGE);
  const [shaped, open] = await Promise.all([shapeReports(request, env, page, t), env.DB.prepare("SELECT COUNT(*) AS n FROM party_reports WHERE status = 'open'").first()]);
  const { reports, found } = shaped;
  const last = page[page.length - 1];
  return json({
    reports,
    next: more && last ? `${Number(last.created)}.${last.id}` : null,
    open: Number(open && open.n) || 0,
    status,
    kind,
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
  const row = await env.DB.prepare('SELECT id, status, drawer_id FROM party_reports WHERE id = ?').bind(id).first();
  if (!row) return fail(404, 'not_found', 'That report is gone. Someone may have deleted it.');
  if (aboutSelf(session, role, row.drawer_id)) return fail(403, 'is_self', SELF_CLEAR);
  if (row.status !== 'open') return json({ ok: true, dismissed: false });
  await env.DB.prepare("UPDATE party_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE id = ? AND status = 'open'").bind(t, session.user_id, id).run();
  return json({ ok: true, dismissed: true });
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

async function personReports(request, env, raw, role, t) {
  const id = personId(raw);
  const db = env.DB;
  const [list, agg, games, made, ban, log, isAdmin, card] = await Promise.all([
    db.prepare(`SELECT ${REPORT_COLUMNS} FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id LEFT JOIN party_report_replays y ON y.report_id = r.id WHERE r.drawer_id = ? ORDER BY r.created DESC, r.id DESC LIMIT ?`).bind(id, PERSON_REPORTS + 1).all(),
    db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, MIN(created) AS first, MAX(created) AS last FROM party_reports WHERE drawer_id = ?").bind(id).first(),
    db.prepare('SELECT r.game AS game, COUNT(*) AS n, SUM(CASE WHEN x.id IS NULL THEN 1 ELSE 0 END) AS drawings FROM party_reports r LEFT JOIN party_report_texts x ON x.id = r.id WHERE r.drawer_id = ? GROUP BY r.game ORDER BY n DESC, r.game ASC').bind(id).all(),
    db.prepare('SELECT COUNT(*) AS n FROM party_reports WHERE reporter_id = ?').bind(id).first(),
    db.prepare('SELECT id, name, username, reason, banned_by, banned_at FROM party_bans WHERE id = ?').bind(id).first(),
    db.prepare('SELECT action, reason, by_id, at FROM party_ban_log WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').bind(id, BAN_LOG_SHOWN).all(),
    adminSet(db, [id]).then((x) => x.has(id)),
    buildCard(db, id).catch(() => null),
  ]);
  const rows = (list && list.results) || [];
  const page = rows.slice(0, PERSON_REPORTS);
  const { reports, found } = await shapeReports(request, env, page, t, [id]);
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
      banned: ban ? { reason: ban.reason || null, by: ban.banned_by, at: Number(ban.banned_at) } : null,
      card: shown,
    },
    counts: {
      total: Number(agg && agg.n) || 0,
      open: Number(agg && agg.open) || 0,
      first: agg && agg.first !== null && agg.first !== undefined ? Number(agg.first) : null,
      last: agg && agg.last !== null && agg.last !== undefined ? Number(agg.last) : null,
      made: Number(made && made.n) || 0,
      games: ((games && games.results) || []).map((g) => ({ game: g.game, n: Number(g.n) || 0, drawings: Number(g.drawings) || 0 })),
    },
    bans: ((log && log.results) || []).map((b) => ({ action: b.action === 'unban' ? 'unban' : 'ban', reason: b.reason || null, by: b.by_id, at: Number(b.at) })),
    reports,
    more: rows.length > PERSON_REPORTS,
    role,
    pending: found.pending,
  });
}

async function dismissPerson(env, session, role, raw, t) {
  const id = personId(raw);
  if (aboutSelf(session, role, id)) return fail(403, 'is_self', SELF_CLEAR);
  const res = await env.DB.prepare("UPDATE party_reports SET status = 'dismissed', dismissed_at = ?, dismissed_by = ? WHERE drawer_id = ? AND status = 'open'").bind(t, session.user_id, id).run();
  return json({ ok: true, dismissed: Number((res && res.meta && res.meta.changes) || 0) });
}

function banLog(db, id, action, reason, by, t) {
  return db.prepare('INSERT INTO party_ban_log (id, user_id, action, reason, by_id, at) VALUES (?, ?, ?, ?, ?, ?)').bind(randomToken(12), id, action, reason || null, by, t);
}

async function deleteReport(env, session, role, raw) {
  const id = reportId(raw);
  const row = await env.DB.prepare('SELECT drawer_id FROM party_reports WHERE id = ?').bind(id).first();
  if (row && aboutSelf(session, role, row.drawer_id)) return fail(403, 'is_self', SELF_CLEAR);
  const [res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM party_reports WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_report_texts WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM party_report_replays WHERE report_id = ?').bind(id),
  ]);
  return json({ ok: true, deleted: Boolean(res && res.meta && res.meta.changes) });
}

async function listBans(request, env, role, t, extra = {}) {
  const res = await env.DB.prepare('SELECT id, name, username, reason, banned_by, banned_at FROM party_bans ORDER BY banned_at DESC, id ASC').all();
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
    };
  });
  return json({ bans, max: MAX_BANS, role, pending: found.pending, ...extra });
}

const BAN_FIELDS = new Set(['id', 'reason', 'name', 'username']);

async function addBan(request, env, session, role, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (!BAN_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.id !== 'string' || !body.id.trim()) throw bad('bad_id', 'Say who to ban first.');
  const id = cleanId(body.id, 'user');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw bad('bad_reason', "The reason doesn't look right.");
  const reason = cleanText(body.reason, REASON_MAX);
  const name = typeof body.name === 'string' ? cleanText(body.name, NAME_MAX) : null;
  const username = typeof body.username === 'string' ? cleanHandle(body.username) : null;
  if (isPartyOwner(env, id)) return fail(400, 'is_owner', "The owner of YapOS Party can't be banned.");
  if (id === String(session.user_id).toLowerCase()) return fail(400, 'is_self', "You can't ban yourself.");
  const isAdmin = (await adminSet(env.DB, [id])).has(id);
  if (isAdmin && role !== 'owner') return fail(403, 'is_admin', "Party admins can't ban other party admins. Ask the owner.");
  const existing = await env.DB.prepare('SELECT id FROM party_bans WHERE id = ?').bind(id).first();
  if (existing) return listBans(request, env, role, t, { banned: false });
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_bans').first();
  if (Number(count && count.n) >= MAX_BANS) return fail(409, 'too_many', `There are already ${MAX_BANS} bans. Unban someone first.`);
  const stmts = [
    env.DB.prepare('INSERT INTO party_bans (id, name, username, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(id, name, username, reason, session.user_id, t),
    banLog(env.DB, id, 'ban', reason, session.user_id, t),
  ];
  if (isAdmin) stmts.push(env.DB.prepare('DELETE FROM party_admins WHERE id = ?').bind(id));
  await env.DB.batch(stmts);
  return listBans(request, env, role, t, { banned: true, removedAdmin: isAdmin });
}

async function removeBan(request, env, session, role, raw, t) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That user id doesn't look right.");
  const res = await env.DB.prepare('DELETE FROM party_bans WHERE id = ?').bind(raw.toLowerCase()).run();
  const unbanned = Boolean(res && res.meta && res.meta.changes);
  if (unbanned) await banLog(env.DB, raw.toLowerCase(), 'unban', null, session.user_id, t).run();
  return listBans(request, env, role, t, { unbanned });
}

export async function partyStaffRoute(request, env, session, route, url, t) {
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', STAFF_ONLY);
  const n = route.length;
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  const nope = () => fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route[1] === 'reports' && route[2] === 'person' && n >= 4) {
    if (n === 4) return read ? personReports(request, env, route[3], role, t) : nope();
    if (n === 5 && route[4] === 'dismiss') return method === 'POST' ? dismissPerson(env, session, role, route[3], t) : nope();
    return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
  }
  if (route[1] === 'reports') {
    if (n === 2) return read ? listReports(request, env, url, role, t) : nope();
    if (n === 3) return method === 'DELETE' ? deleteReport(env, session, role, route[2]) : nope();
    if (n === 4 && route[3] === 'dismiss') return method === 'POST' ? dismissReport(env, session, role, route[2], t) : nope();
  }
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
