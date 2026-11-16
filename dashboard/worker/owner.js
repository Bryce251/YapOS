import { MINUTE, DAY, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, parseJsonSafe, randomToken } from './util.js';
import { hit, tooMany } from './rate.js';
import { getSession, touchSession } from './sessions.js';
import { isPartyOwner, USER_ID_RE } from './party.js';
import { cleanText, cleanUsername, cleanAvatar } from './profiles.js';
import { PARTY_BADGES, badgesFor, partySeasonBadges, partySeasonBadgeId, seasonBadgeInfo } from './party-badges.js';

export const OWNER_ACTIONS_PER_MIN = 120;
export const OWNER_READS_PER_MIN = 300;
export const OWNER_SEARCH_MAX = 20;
export const OWNER_USER_ACTIONS = 50;
export const OWNER_POLL_BATCH = 50;
export const OWNER_RESEND_AFTER = 2 * MINUTE;
export const OWNER_GIVE_UP_AFTER = 7 * DAY;
export const OWNER_ACTIONS_KEEP = 365 * DAY;
export const OWNER_RESULTS_MAX = 100;
export const OWNER_LIST_DEFAULT = 50;
export const OWNER_LIST_MAX = 200;
export const MAX_CATALOG_ACHIEVEMENTS = 300;
export const MAX_CATALOG_BADGES = 300;

const CATALOG_KEY = 'bot';
const CATALOG_LIMIT = 256 * 1024;
const RESULTS_LIMIT = 512 * 1024;
const NOTE_MAX = 200;
const MESSAGE_MAX = 300;
const QUERY_MAX = 64;
const NAME_MAX = 64;
const LABEL_MAX = 64;
const EMOJI_MAX = 16;
const MAX_SHARDS = 1e15;
const MAX_LIST = 300;
const CATALOG_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const ACTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DIGITS_RE = /^[0-9][0-9,_ ]{0,24}$/;
const INFINITE_RE = /^[+-]?(inf|infinity|∞)$/i;
const BODY_FIELDS = new Set(['user', 'kind', 'value', 'id', 'note', 'notify']);
const MISSING = "That page of the dashboard doesn't exist.";
const GAVE_UP = "YapOS didn't pick this up within a week, so it was cancelled.";

export const OWNER_KINDS = Object.freeze({
  'shards.add': Object.freeze({ label: 'Give Shards', input: 'amount', min: 1, max: 1e12, gift: true }),
  'shards.remove': Object.freeze({ label: 'Take Shards', input: 'amount', min: 1, max: 1e12, gift: false }),
  'shards.set': Object.freeze({ label: 'Set Shards', input: 'amount', min: 0, max: 1e12, gift: false }),
  'xp.add': Object.freeze({ label: 'Give XP', input: 'amount', min: 1, max: 1e9, gift: true }),
  'xp.remove': Object.freeze({ label: 'Take XP', input: 'amount', min: 1, max: 1e9, gift: false }),
  'level.set': Object.freeze({ label: 'Set level', input: 'amount', min: 0, max: 100000, gift: false }),
  'achievement.grant': Object.freeze({ label: 'Give achievement', input: 'achievement', gift: true }),
  'achievement.revoke': Object.freeze({ label: 'Take achievement', input: 'achievement', gift: false }),
  'badge.grant': Object.freeze({ label: 'Give badge', input: 'badge', gift: true }),
  'badge.revoke': Object.freeze({ label: 'Take badge', input: 'badge', gift: false }),
  'giver.grant': Object.freeze({ label: 'Let them create Shards', input: 'none', gift: true }),
  'giver.revoke': Object.freeze({ label: 'Stop them creating Shards', input: 'none', gift: false }),
  'quests.reset': Object.freeze({ label: "Reset today's quests", input: 'none', gift: false }),
  'streak.set': Object.freeze({ label: 'Set daily streak', input: 'amount', min: 0, max: 10000, gift: false }),
  'party.stats.add': Object.freeze({ label: 'Add Party games and wins', input: 'party', min: 0, max: 100000, gift: false }),
});

export const KIND_LIST = Object.freeze(Object.entries(OWNER_KINDS).map(([kind, k]) => Object.freeze({ kind, ...k })));

function bad(code, message) {
  return new HttpError(400, code, message);
}

function nice(n) {
  return Number(n).toLocaleString('en-US');
}

export function parseAmount(raw, { min, max }) {
  let n;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw bad('bad_value', 'Use a normal whole number. Infinity is not allowed.');
    n = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (INFINITE_RE.test(text)) throw bad('bad_value', 'Use a normal whole number. Infinity is not allowed.');
    if (!DIGITS_RE.test(text)) throw bad('bad_value', 'Type a whole number, like 500.');
    n = Number(text.replace(/[,_ ]/g, ''));
  } else {
    throw bad('bad_value', 'Type a whole number, like 500.');
  }
  if (!Number.isInteger(n)) throw bad('bad_value', 'Use a whole number, without decimals.');
  if (n < min) throw bad('bad_value', min > 0 ? `Use at least ${nice(min)}.` : "The number can't be below zero.");
  if (n > max) throw bad('bad_value', `That's too much. The most you can use here is ${nice(max)}.`);
  return n;
}

function cleanCatalogList(list, max, withReward) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('bad_catalog', 'The catalog lists must be lists.');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !CATALOG_ID_RE.test(item.id)) continue;
    const id = item.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = {
      id,
      label: cleanText(item.label, LABEL_MAX) || id,
      emoji: cleanText(item.emoji, EMOJI_MAX) || null,
    };
    if (withReward) {
      const reward = Number(item.reward);
      entry.reward = Number.isInteger(reward) && reward >= 0 && reward <= 1e12 ? reward : 0;
    }
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

export function cleanCatalog(body) {
  return {
    achievements: cleanCatalogList(body.achievements, MAX_CATALOG_ACHIEVEMENTS, true),
    badges: cleanCatalogList(body.badges, MAX_CATALOG_BADGES, false),
  };
}

export async function readCatalog(db) {
  const [row, awarded] = await Promise.all([
    db.prepare('SELECT data, updated FROM owner_catalog WHERE id = ?').bind(CATALOG_KEY).first(),
    db.prepare('SELECT DISTINCT month, rank FROM party_season_awards ORDER BY month DESC, rank ASC LIMIT 36').all().catch(() => null),
  ]);
  const data = row ? parseJsonSafe(row.data, {}) : {};
  const achievements = Array.isArray(data.achievements) ? data.achievements : [];
  const botBadges = Array.isArray(data.badges) ? data.badges : [];
  const badges = PARTY_BADGES.map((b) => ({ id: b.id, label: b.label, emoji: b.emoji, source: 'party' }));
  for (const r of (awarded && awarded.results) || []) {
    const info = seasonBadgeInfo(partySeasonBadgeId(Number(r.rank), r.month));
    if (info) badges.push({ id: info.id, label: info.label, emoji: info.emoji, source: 'season' });
  }
  const have = new Set(badges.map((b) => b.id));
  for (const b of botBadges) {
    if (!b || have.has(b.id)) continue;
    have.add(b.id);
    badges.push({ id: b.id, label: b.label, emoji: b.emoji ?? null, source: b.id.startsWith('season-') ? 'season' : 'bot' });
  }
  return { achievements, badges, kinds: KIND_LIST, updatedAt: row ? Number(row.updated) || null : null };
}

export function validateAction(body, catalog) {
  if (!isPlainObject(body)) throw bad('bad_request', 'Send the action as an object.');
  for (const k of Object.keys(body)) {
    if (!BODY_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.user !== 'string' || !USER_ID_RE.test(body.user.trim())) {
    throw bad('bad_user', "Pick a person first. Their user id doesn't look right.");
  }
  const user = body.user.trim().toLowerCase();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const spec = Object.prototype.hasOwnProperty.call(OWNER_KINDS, kind) ? OWNER_KINDS[kind] : null;
  if (!spec) throw bad('bad_kind', "That isn't something the owner panel can do.");
  let value = null;
  let ref = null;
  if (spec.input === 'amount') {
    value = parseAmount(body.value, spec);
  } else if (spec.input === 'party') {
    if (!isPlainObject(body.value)) throw bad('bad_value', 'Say how many games and wins to add.');
    const games = body.value.games === undefined ? 0 : parseAmount(body.value.games, spec);
    const wins = body.value.wins === undefined ? 0 : parseAmount(body.value.wins, spec);
    if (!games && !wins) throw bad('bad_value', 'Add at least one game or win.');
    value = { games, wins };
  } else if (spec.input === 'achievement' || spec.input === 'badge') {
    const raw = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const list = spec.input === 'achievement' ? catalog.achievements : catalog.badges;
    if (!raw) throw bad('bad_ref', spec.input === 'achievement' ? 'Pick an achievement first.' : 'Pick a badge first.');
    if (spec.input === 'achievement' && !list.length) {
      throw bad('no_catalog', "YapOS hasn't sent its list of achievements yet. Start the bot and try again in a minute.");
    }
    if (!list.some((x) => x.id === raw)) {
      throw bad('bad_ref', spec.input === 'achievement' ? "That achievement isn't in YapOS's list." : "That badge isn't in YapOS's list.");
    }
    ref = raw;
  }
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw bad('bad_note', 'The note must be text.');
    note = cleanText(body.note, NOTE_MAX + 1);
    if (note && Array.from(note).length > NOTE_MAX) throw bad('bad_note', `Keep the note under ${NOTE_MAX} characters.`);
  }
  if (body.notify !== undefined && body.notify !== null && typeof body.notify !== 'boolean') {
    throw bad('bad_notify', '"notify" must be true or false.');
  }
  const notify = spec.gift && body.notify === true;
  return { user, kind, value, ref, note, notify };
}

export function actionOut(r) {
  return {
    id: r.id,
    user: r.user_id,
    kind: r.kind,
    value: r.value === null || r.value === undefined ? null : parseJsonSafe(r.value, null),
    ref: r.ref ?? null,
    note: r.note ?? null,
    notify: Boolean(Number(r.notify)),
    created: Number(r.created),
    status: r.status,
    result: r.result ?? null,
    updated: Number(r.updated),
  };
}

const ACTION_COLUMNS = 'id, user_id, kind, value, ref, note, notify, created, status, result, updated';

function likeArg(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function freshest(a, aAt, b, bAt) {
  const hasA = a !== null && a !== undefined;
  const hasB = b !== null && b !== undefined;
  if (hasA && hasB) return Number(bAt) > Number(aAt) ? Number(b) : Number(a);
  if (hasA) return Number(a);
  if (hasB) return Number(b);
  return null;
}

function rowsOf(res) {
  return (res && res.results) || [];
}

function blankUser(id) {
  return { id, username: null, name: null, avatar: null, level: null, shards: null, seen: null };
}

function mergeUser(out, { pub, prof, sess, known }) {
  if (pub) {
    out.username = out.username || pub.username || null;
    out.name = out.name || cleanText(pub.name, NAME_MAX);
  }
  if (prof && !Number(prof.missing)) {
    out.username = out.username || cleanUsername(prof.username);
    out.name = out.name || cleanText(prof.display_name, NAME_MAX);
    out.avatar = out.avatar || cleanAvatar(prof.avatar_url);
  }
  if (sess) {
    out.username = out.username || cleanUsername(sess.username);
    out.name = out.name || cleanText(sess.display_name, NAME_MAX);
    out.avatar = out.avatar || cleanAvatar(sess.avatar_url);
  }
  if (!out.name && out.username) out.name = out.username;
  const pubAt = pub ? Number(pub.updated) || 0 : 0;
  const knownAt = known ? Number(known.updated) || 0 : 0;
  const real = pub && !Number(pub.hidden) ? pub : null;
  out.level = freshest(real ? real.level : null, pubAt, known ? known.level : null, knownAt);
  out.shards = freshest(real ? real.shards : null, pubAt, known ? known.shards : null, knownAt);
  const seen = Math.max(pubAt, sess ? Number(sess.seen) || 0 : 0);
  out.seen = seen || null;
  return out;
}

async function searchUsers(env, url) {
  const raw = (url.searchParams.get('q') || '').trim().replace(/^@+/, '').slice(0, QUERY_MAX);
  const db = env.DB;
  const exact = USER_ID_RE.test(raw) ? raw.toLowerCase() : null;
  const like = likeArg(raw.toLowerCase());
  const lim = OWNER_SEARCH_MAX;
  const where = raw ? true : false;
  const [pubRes, profRes, sessRes] = await Promise.all([
    where
      ? db.prepare("SELECT user_id, username, name, level, shards, hidden, updated FROM public_profiles WHERE user_id = ? OR username_key LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT ?").bind(exact || '', like, like, lim).all()
      : db.prepare('SELECT user_id, username, name, level, shards, hidden, updated FROM public_profiles ORDER BY updated DESC LIMIT ?').bind(lim).all(),
    where
      ? db.prepare("SELECT id, username, display_name, avatar_url, missing, fetched FROM profiles WHERE id = ? OR LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(display_name) LIKE ? ESCAPE '\\' ORDER BY fetched DESC LIMIT ?").bind(exact || '', like, like, lim).all()
      : db.prepare('SELECT id, username, display_name, avatar_url, missing, fetched FROM profiles WHERE missing = 0 ORDER BY fetched DESC LIMIT ?').bind(lim).all(),
    where
      ? db.prepare("SELECT user_id, username, display_name, avatar_url, MAX(CASE WHEN last_seen > created THEN last_seen ELSE created END) AS seen FROM sessions WHERE LOWER(user_id) = ? OR LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(display_name) LIKE ? ESCAPE '\\' GROUP BY user_id ORDER BY seen DESC LIMIT ?").bind(exact || '', like, like, lim).all()
      : db.prepare('SELECT user_id, username, display_name, avatar_url, MAX(CASE WHEN last_seen > created THEN last_seen ELSE created END) AS seen FROM sessions GROUP BY user_id ORDER BY seen DESC LIMIT ?').bind(lim).all(),
  ]);
  const parts = new Map();
  const slot = (id) => {
    const key = String(id).toLowerCase();
    if (!USER_ID_RE.test(key)) return null;
    if (!parts.has(key)) parts.set(key, {});
    return parts.get(key);
  };
  for (const r of rowsOf(pubRes)) { const s = slot(r.user_id); if (s) s.pub = r; }
  for (const r of rowsOf(profRes)) { const s = slot(r.id); if (s) s.prof = r; }
  for (const r of rowsOf(sessRes)) { const s = slot(r.user_id); if (s) s.sess = r; }
  if (exact && !parts.has(exact)) parts.set(exact, {});
  const ids = [...parts.keys()];
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    const [known, pubMore, profMore, sessMore] = await Promise.all([
      db.prepare(`SELECT user_id, shards, level, xp, updated FROM owner_known WHERE user_id IN (${marks})`).bind(...ids).all(),
      db.prepare(`SELECT user_id, username, name, level, shards, hidden, updated FROM public_profiles WHERE user_id IN (${marks})`).bind(...ids).all(),
      db.prepare(`SELECT id, username, display_name, avatar_url, missing, fetched FROM profiles WHERE id IN (${marks})`).bind(...ids).all(),
      db.prepare(`SELECT user_id, username, display_name, avatar_url, MAX(CASE WHEN last_seen > created THEN last_seen ELSE created END) AS seen FROM sessions WHERE LOWER(user_id) IN (${marks}) GROUP BY user_id`).bind(...ids).all(),
    ]);
    for (const r of rowsOf(known)) { const s = parts.get(String(r.user_id).toLowerCase()); if (s) s.known = r; }
    for (const r of rowsOf(pubMore)) { const s = parts.get(String(r.user_id).toLowerCase()); if (s && !s.pub) s.pub = r; }
    for (const r of rowsOf(profMore)) { const s = parts.get(String(r.id).toLowerCase()); if (s && !s.prof) s.prof = r; }
    for (const r of rowsOf(sessMore)) { const s = parts.get(String(r.user_id).toLowerCase()); if (s && !s.sess) s.sess = r; }
  }
  const q = raw.toLowerCase();
  const users = ids.map((id) => mergeUser(blankUser(id), parts.get(id)));
  const score = (u) => {
    if (exact && u.id === exact) return 0;
    if (q && u.username && u.username.toLowerCase() === q) return 1;
    if (q && u.username && u.username.toLowerCase().startsWith(q)) return 2;
    if (q && u.name && u.name.toLowerCase().startsWith(q)) return 3;
    return 4;
  };
  users.sort((a, b) => score(a) - score(b) || (b.seen || 0) - (a.seen || 0) || a.id.localeCompare(b.id));
  return json({ users: users.slice(0, OWNER_SEARCH_MAX) });
}

function idList(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string' || !CATALOG_ID_RE.test(v)) continue;
    const id = v.toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

async function userDetail(env, raw) {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!USER_ID_RE.test(id)) return fail(400, 'bad_user', "That user id doesn't look right.");
  const db = env.DB;
  const [pub, prof, sess, known, stats, streak, actions, catalog, partySeason] = await Promise.all([
    db.prepare('SELECT user_id, username, name, level, xp, shards, badges, achievements, season, clan, hidden, updated FROM public_profiles WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT id, username, display_name, avatar_url, missing, fetched FROM profiles WHERE id = ?').bind(id).first(),
    db.prepare('SELECT user_id, username, display_name, avatar_url, MAX(CASE WHEN last_seen > created THEN last_seen ELSE created END) AS seen FROM sessions WHERE LOWER(user_id) = ? GROUP BY user_id').bind(id).first(),
    db.prepare('SELECT user_id, shards, level, xp, updated FROM owner_known WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT games, wins, counters FROM party_stats WHERE user_id = ?').bind(id).first(),
    db.prepare('SELECT best FROM party_daily_streaks WHERE user_id = ?').bind(id).first(),
    db.prepare(`SELECT ${ACTION_COLUMNS} FROM owner_actions WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT ?`).bind(id, OWNER_USER_ACTIONS).all(),
    readCatalog(db),
    partySeasonBadges(db, id).catch(() => []),
  ]);
  const user = mergeUser(blankUser(id), { pub, prof, sess: sess && sess.user_id ? sess : null, known });
  const pubAt = pub ? Number(pub.updated) || 0 : 0;
  const knownAt = known ? Number(known.updated) || 0 : 0;
  user.xp = freshest(pub && !Number(pub.hidden) ? pub.xp : null, pubAt, known ? known.xp : null, knownAt);
  const counters = parseJsonSafe(stats && stats.counters, {});
  const party = { games: Number(stats && stats.games) || 0, wins: Number(stats && stats.wins) || 0 };
  const earned = badgesFor({ ...party, counters: isPlainObject(counters) ? counters : {}, dailyBest: Number(streak && streak.best) || 0 });
  const stored = idList(parseJsonSafe(pub && pub.badges, []));
  user.badges = [...new Set([...earned, ...stored])];
  user.earnedBadges = earned;
  user.achievements = idList(parseJsonSafe(pub && pub.achievements, []));
  const season = parseJsonSafe(pub && pub.season, []);
  user.season = Array.isArray(season) ? season.filter(isPlainObject).slice(0, 36) : [];
  const seasonIds = idList(user.season
    .filter((s) => (s.kind === 'xp' || s.kind === 'shards') && Number.isInteger(s.rank) && typeof s.month === 'string' && /^\d{4}-\d{2}$/.test(s.month))
    .map((s) => `season-${s.kind}-${s.rank}-${s.month}`));
  user.badges = [...new Set([...user.badges, ...seasonIds, ...partySeason])];
  const clan = parseJsonSafe(pub && pub.clan, null);
  user.clan = isPlainObject(clan) && typeof clan.name === 'string'
    ? { name: cleanText(clan.name, 32), tag: cleanText(clan.tag, 6), colour: typeof clan.colour === 'string' && /^#[0-9a-f]{6}$/i.test(clan.colour) ? clan.colour.toLowerCase() : null }
    : null;
  user.party = party;
  user.hidden = Boolean(pub && Number(pub.hidden));
  user.known = Boolean(pub || prof || (sess && sess.user_id) || known || stats);
  return json({ user, actions: rowsOf(actions).map(actionOut), catalog });
}

async function listActions(env, url) {
  const raw = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), OWNER_LIST_MAX) : OWNER_LIST_DEFAULT;
  const res = await env.DB.prepare(`SELECT ${ACTION_COLUMNS} FROM owner_actions ORDER BY created DESC, rowid DESC LIMIT ?`).bind(limit).all();
  const actions = rowsOf(res).map(actionOut);
  const ids = [...new Set(actions.map((a) => a.user))];
  const names = new Map();
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    const [pubs, profs] = await Promise.all([
      env.DB.prepare(`SELECT user_id, username, name FROM public_profiles WHERE user_id IN (${marks})`).bind(...ids).all(),
      env.DB.prepare(`SELECT id, username, display_name, missing FROM profiles WHERE id IN (${marks})`).bind(...ids).all(),
    ]);
    for (const r of rowsOf(profs)) {
      if (Number(r.missing)) continue;
      names.set(r.id, { username: cleanUsername(r.username), name: cleanText(r.display_name, NAME_MAX) });
    }
    for (const r of rowsOf(pubs)) names.set(r.user_id, { username: r.username || null, name: cleanText(r.name, NAME_MAX) });
  }
  for (const a of actions) {
    const n = names.get(a.user);
    a.who = { username: n ? n.username || null : null, name: n ? n.name || n.username || null : null };
  }
  return json({ actions });
}

async function postAction(request, env, session, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  const limit = await hit(env.DB, `owner:act:${String(session.user_id).toLowerCase()}`, OWNER_ACTIONS_PER_MIN, t);
  if (!limit.ok) return tooMany(limit.retryAfter, "That's a lot of changes in one minute. Wait a moment and try again.");
  const catalog = await readCatalog(env.DB);
  const a = validateAction(body, catalog);
  const id = randomToken(12);
  const db = env.DB;
  const instant = a.kind === 'party.stats.add';
  const status = instant ? 'done' : 'queued';
  const result = instant ? `Added ${nice(a.value.games)} ${a.value.games === 1 ? 'game' : 'games'} and ${nice(a.value.wins)} ${a.value.wins === 1 ? 'win' : 'wins'} to their Party stats.` : null;
  const stmts = [
    db.prepare('INSERT INTO owner_actions (id, user_id, kind, value, ref, note, notify, created, status, sent_at, result, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .bind(id, a.user, a.kind, a.value === null ? null : JSON.stringify(a.value), a.ref, a.note, a.notify ? 1 : 0, t, status, result, t),
  ];
  if (instant) {
    stmts.push(
      db.prepare("INSERT INTO party_stats (user_id, games, wins, by_game, counters, updated) VALUES (?, ?, ?, '{}', '{}', ?) ON CONFLICT (user_id) DO UPDATE SET games = party_stats.games + excluded.games, wins = party_stats.wins + excluded.wins, updated = excluded.updated")
        .bind(a.user, a.value.games, a.value.wins, t),
    );
  }
  await db.batch(stmts);
  const row = await db.prepare(`SELECT ${ACTION_COLUMNS} FROM owner_actions WHERE id = ?`).bind(id).first();
  return json({ action: actionOut(row) }, 201);
}

export async function ownerApi(request, env, route, url, t, { csrf }) {
  const session = await getSession(env.DB, request, t);
  if (!session || !isPartyOwner(env, session.user_id)) return fail(404, 'not_found', MISSING);
  const method = request.method;
  const readOnly = method === 'GET' || method === 'HEAD';
  if (!readOnly && !csrf) return fail(403, 'forbidden', 'This request was blocked for your safety. Reload the page and try again.');
  const reads = await hit(env.DB, `owner:read:${String(session.user_id).toLowerCase()}`, OWNER_READS_PER_MIN, t);
  if (!reads.ok) return tooMany(reads.retryAfter);
  await touchSession(env.DB, session, t);
  const n = route.length;
  if (n === 2 && route[1] === 'users') {
    if (readOnly) return searchUsers(env, url);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 3 && route[1] === 'users') {
    if (readOnly) return userDetail(env, route[2]);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (n === 2 && route[1] === 'actions') {
    if (readOnly) return listActions(env, url);
    if (method === 'POST') return postAction(request, env, session, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', MISSING);
}

export async function ownerPoll(db, t) {
  await db.prepare("UPDATE owner_actions SET status = 'failed', result = ?, updated = ? WHERE status IN ('queued', 'sent') AND created < ?").bind(GAVE_UP, t, t - OWNER_GIVE_UP_AFTER).run();
  const res = await db
    .prepare("UPDATE owner_actions SET status = 'sent', sent_at = ?, updated = ? WHERE id IN (SELECT id FROM owner_actions WHERE status = 'queued' OR (status = 'sent' AND sent_at <= ?) ORDER BY created ASC, rowid ASC LIMIT ?) RETURNING rowid AS seq, id, user_id, kind, value, ref, notify, created")
    .bind(t, t, t - OWNER_RESEND_AFTER, OWNER_POLL_BATCH)
    .all();
  const rows = rowsOf(res).slice();
  rows.sort((a, b) => Number(a.created) - Number(b.created) || Number(a.seq) - Number(b.seq));
  return rows.map((r) => ({
    id: r.id,
    user: r.user_id,
    kind: r.kind,
    value: r.value === null || r.value === undefined ? null : parseJsonSafe(r.value, null),
    ref: r.ref ?? null,
    notify: Boolean(Number(r.notify)),
  }));
}

function wholeOrNull(v, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(max, Math.floor(v));
}

export function cleanAfter(after) {
  if (!isPlainObject(after)) return null;
  const out = {
    shards: wholeOrNull(after.shards, MAX_SHARDS),
    level: wholeOrNull(after.level, 100000),
    xp: wholeOrNull(after.xp, 1e12),
    achievements: Array.isArray(after.achievements) ? idList(after.achievements) : null,
    badges: Array.isArray(after.badges) ? idList(after.badges) : null,
  };
  if (!Object.values(out).some((v) => v !== null)) return null;
  return { ...out, hidden: after.hidden === true, privateShards: after.privateShards === true };
}

function afterStatements(db, userId, after, t) {
  const sets = [];
  const args = [];
  if (after.shards !== null && !after.privateShards) {
    sets.push('shards = CASE WHEN shards IS NULL THEN NULL ELSE ? END');
    args.push(after.shards);
  }
  if (after.level !== null) { sets.push('level = ?'); args.push(after.level); }
  if (after.xp !== null) { sets.push('xp = ?'); args.push(after.xp); }
  if (after.achievements !== null) { sets.push('achievements = ?'); args.push(JSON.stringify(after.achievements)); }
  if (after.badges !== null) { sets.push('badges = ?'); args.push(JSON.stringify(after.badges)); }
  const stmts = [];
  if (sets.length && !after.hidden) stmts.push(db.prepare(`UPDATE public_profiles SET ${sets.join(', ')} WHERE user_id = ? AND hidden = 0`).bind(...args, userId));
  if (after.shards !== null || after.level !== null || after.xp !== null) {
    stmts.push(
      db.prepare('INSERT INTO owner_known (user_id, shards, level, xp, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET shards = COALESCE(excluded.shards, owner_known.shards), level = COALESCE(excluded.level, owner_known.level), xp = COALESCE(excluded.xp, owner_known.xp), updated = excluded.updated')
        .bind(userId, after.shards, after.level, after.xp, t),
    );
  }
  return stmts;
}

export async function postOwnerResults(request, env, t) {
  const body = await readJson(request, RESULTS_LIMIT);
  if (!Array.isArray(body.results)) throw bad('bad_results', '"results" must be a list.');
  if (body.results.length > OWNER_RESULTS_MAX) throw new HttpError(413, 'too_many', `Send at most ${OWNER_RESULTS_MAX} results at once.`);
  const db = env.DB;
  let stored = 0;
  const ignored = [];
  for (const r of body.results) {
    if (!isPlainObject(r) || typeof r.id !== 'string' || !ACTION_ID_RE.test(r.id)) {
      ignored.push(isPlainObject(r) && typeof r.id === 'string' ? r.id.slice(0, 64) : null);
      continue;
    }
    const row = await db.prepare('SELECT id, user_id, status FROM owner_actions WHERE id = ?').bind(r.id).first();
    if (!row || (row.status !== 'queued' && row.status !== 'sent')) {
      ignored.push(r.id);
      continue;
    }
    const ok = r.ok === true;
    const message = cleanText(typeof r.message === 'string' ? r.message : '', MESSAGE_MAX) || (ok ? 'Done.' : "YapOS couldn't do that.");
    const stmts = [
      db.prepare("UPDATE owner_actions SET status = ?, result = ?, updated = ? WHERE id = ? AND status IN ('queued', 'sent')").bind(ok ? 'done' : 'failed', message, t, row.id),
    ];
    const after = ok ? cleanAfter(r.after) : null;
    if (after) stmts.push(...afterStatements(db, row.user_id, after, t));
    await db.batch(stmts);
    stored += 1;
  }
  return json({ ok: true, stored, ignored });
}

export async function postOwnerCatalog(request, env, t) {
  const body = await readJson(request, CATALOG_LIMIT);
  const catalog = cleanCatalog(body);
  await env.DB
    .prepare('INSERT INTO owner_catalog (id, data, updated) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
    .bind(CATALOG_KEY, JSON.stringify(catalog), t)
    .run();
  return json({ ok: true, achievements: catalog.achievements.length, badges: catalog.badges.length });
}

export function ownerCleanupStatements(db, t) {
  return [
    db.prepare("DELETE FROM owner_actions WHERE created < ? AND status IN ('done', 'failed')").bind(t - OWNER_ACTIONS_KEEP),
  ];
}
