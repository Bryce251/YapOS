import { MINUTE, DAY, HttpError, json, fail, readJson, isPlainObject, clientIp, randomToken, publicOrigin } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText } from './profiles.js';
import { safeName } from './public-profiles.js';
import { getActivityUser, bearer } from './activity-auth.js';
import { findBlocked } from '../web/activity/js/filter.js';
import { people } from './clan-people.js';
import { cleanExtras, extrasStatements, extrasRemoveStatements, settingsStatement, feedStatements, clanManageCleanupStatements, browseClans } from './clan-manage.js';
import { noteStatements } from './inbox.js';
import { isBoardOwner } from './board-owner.js';

export const CLAN_TAG_RE = /^[A-Za-z0-9]{3,4}$/;
export const CLAN_ID_RE = /^c\d{1,9}$/;
export const JOIN_MODES = Object.freeze(['open', 'invite']);
export const CLAN_PUSH_MAX = 200;
export const CLAN_MEMBER_IDS_MAX = 20000;
export const CLAN_KNOWN_MAX = 10000;
export const CLAN_TOP = 5;
export const CLAN_JOIN_BATCH = 50;
export const CLAN_JOIN_RESEND = 2 * MINUTE;
export const CLAN_JOIN_WAITING = 45 * 1000;
export const CLAN_JOIN_GIVE_UP = DAY;
export const CLAN_JOIN_KEEP = 7 * DAY;
export const CLAN_JOIN_RECENT = DAY;
export const CLAN_RESULTS_MAX = 100;

const PUSH_LIMIT = 2 * 1024 * 1024;
const RESULTS_LIMIT = 256 * 1024;
const NAME_MAX = 32;
const BANNER_MAX = 60;
const MESSAGE_MAX = 300;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MEMBER_ROWS = 30;
const CODES = new Set(['joined', 'already', 'invite_only', 'in_clan', 'gone', 'bot', 'failed']);
const MISSING = "We couldn't find a clan with that tag.";
const GAVE_UP = "YapOS didn't answer for a day, so this request was dropped. Try again.";
const WAITING = "YapOS is offline right now. Your request will go through when it's back.";
const BLOCKED = 'This request was blocked for your safety. Reload the page and try again.';

const lower = (v) => String(v ?? '').toLowerCase();

function whole(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function cleanEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' && CLAN_ID_RE.test(raw.id) ? raw.id : null;
  const tag = typeof raw.tag === 'string' && CLAN_TAG_RE.test(raw.tag) && !findBlocked(raw.tag).length ? raw.tag.toUpperCase() : null;
  const name = safeName(raw.name, NAME_MAX, null);
  if (!id || !tag || !name) return null;
  const banner = typeof raw.banner === 'string' ? safeName(raw.banner, BANNER_MAX, null) : null;
  const colour = typeof raw.colour === 'string' && COLOUR_RE.test(raw.colour) ? raw.colour.toLowerCase() : null;
  const join = JOIN_MODES.includes(raw.join) ? raw.join : 'open';
  const leader = typeof raw.leader === 'string' && USER_RE.test(raw.leader) ? lower(raw.leader) : null;
  const list = Array.isArray(raw.members) ? raw.members : [];
  const members = [...new Set(list.filter((x) => typeof x === 'string' && USER_RE.test(x)).map(lower))];
  const count = Number.isFinite(raw.count) ? whole(raw.count, members.length, 1e9) : members.length;
  return { id, tag, name, banner, colour, join, leader, created: whole(raw.created, 0, 1e15), members, count, append: raw.append === true, ...cleanExtras(raw) };
}

function memberStatements(db, clan, t) {
  const stmts = clan.append ? [] : [db.prepare('DELETE FROM clan_members WHERE clan_id = ?').bind(clan.id)];
  for (let i = 0; i < clan.members.length; i += MEMBER_ROWS) {
    const part = clan.members.slice(i, i + MEMBER_ROWS);
    stmts.push(
      db.prepare(`INSERT INTO clan_members (user_id, clan_id, updated) VALUES ${part.map(() => '(?, ?, ?)').join(', ')} ON CONFLICT (user_id) DO UPDATE SET clan_id = excluded.clan_id, updated = excluded.updated`)
        .bind(...part.flatMap((u) => [u, clan.id, t])),
    );
  }
  return stmts;
}

function removeStatements(db, id) {
  return [
    db.prepare('DELETE FROM clan_directory WHERE id = ?').bind(id),
    db.prepare('DELETE FROM clan_members WHERE clan_id = ?').bind(id),
    ...extrasRemoveStatements(db, id),
  ];
}

export async function postClanDirectory(request, env, t) {
  const body = await readJson(request, PUSH_LIMIT);
  const list = Array.isArray(body.clans) ? body.clans : [];
  if (list.length > CLAN_PUSH_MAX) throw new HttpError(413, 'too_many', `Send at most ${CLAN_PUSH_MAX} clans at once.`);
  const db = env.DB;
  const clans = [];
  const seen = new Set();
  let ids = 0;
  let ignored = 0;
  for (const raw of list) {
    const c = cleanEntry(raw);
    if (!c || seen.has(c.id)) {
      ignored += 1;
      continue;
    }
    ids += c.members.length;
    if (ids > CLAN_MEMBER_IDS_MAX) throw new HttpError(413, 'too_many', `Send at most ${CLAN_MEMBER_IDS_MAX} member ids at once.`);
    seen.add(c.id);
    clans.push(c);
  }
  const removed = [...new Set((Array.isArray(body.removed) ? body.removed : []).filter((x) => typeof x === 'string' && CLAN_ID_RE.test(x)))].filter((x) => !seen.has(x));
  const stmts = [];
  for (const c of clans) {
    stmts.push(
      db.prepare('INSERT INTO clan_directory (id, tag, tag_key, name, colour, banner, members, join_mode, leader_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET tag = excluded.tag, tag_key = excluded.tag_key, name = excluded.name, colour = excluded.colour, banner = excluded.banner, members = excluded.members, join_mode = excluded.join_mode, leader_id = excluded.leader_id, created = excluded.created, updated = excluded.updated')
        .bind(c.id, c.tag, lower(c.tag), c.name, c.colour, c.banner, c.count, c.join, c.leader, c.created, t),
      ...memberStatements(db, c, t),
      ...extrasStatements(db, c, t),
    );
  }
  const settings = settingsStatement(db, body.settings, t);
  if (settings) stmts.push(settings);
  const feed = await feedStatements(db, body, t);
  for (const id of removed) stmts.push(...removeStatements(db, id));
  let dropped = removed.length;
  if (body.full === true && Array.isArray(body.known)) {
    if (body.known.length > CLAN_KNOWN_MAX) throw new HttpError(413, 'too_many', `Send at most ${CLAN_KNOWN_MAX} known clan ids.`);
    const known = new Set(body.known.filter((x) => typeof x === 'string' && CLAN_ID_RE.test(x)));
    for (const c of clans) known.add(c.id);
    const res = await db.prepare('SELECT id FROM clan_directory').all();
    for (const r of (res && res.results) || []) {
      if (known.has(r.id) || removed.includes(r.id)) continue;
      stmts.push(...removeStatements(db, r.id));
      dropped += 1;
    }
  }
  stmts.push(...feed.stmts);
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, stored: clans.length, removed: dropped, ignored, notes: feed.notes });
}

export async function clanJoinPoll(db, t) {
  await db.prepare("UPDATE clan_joins SET status = 'failed', code = 'failed', result = ?, updated = ? WHERE status IN ('queued', 'sent') AND created < ?").bind(GAVE_UP, t, t - CLAN_JOIN_GIVE_UP).run();
  const res = await db
    .prepare("UPDATE clan_joins SET status = 'sent', sent_at = ?, updated = ? WHERE id IN (SELECT id FROM clan_joins WHERE status = 'queued' OR (status = 'sent' AND sent_at <= ?) ORDER BY created ASC, rowid ASC LIMIT ?) RETURNING rowid AS seq, id, user_id, clan_id, tag, via, created")
    .bind(t, t, t - CLAN_JOIN_RESEND, CLAN_JOIN_BATCH)
    .all();
  const rows = ((res && res.results) || []).slice();
  rows.sort((a, b) => Number(a.created) - Number(b.created) || Number(a.seq) - Number(b.seq));
  return rows.map((r) => ({ id: r.id, user: r.user_id, clan: r.clan_id, tag: r.tag, via: r.via === 'party' ? 'party' : 'web' }));
}

export async function postClanJoinResults(request, env, t) {
  const body = await readJson(request, RESULTS_LIMIT);
  if (!Array.isArray(body.results)) throw new HttpError(400, 'bad_results', '"results" must be a list.');
  if (body.results.length > CLAN_RESULTS_MAX) throw new HttpError(413, 'too_many', `Send at most ${CLAN_RESULTS_MAX} results at once.`);
  const db = env.DB;
  let stored = 0;
  const ignored = [];
  for (const r of body.results) {
    if (!isPlainObject(r) || typeof r.id !== 'string' || !REQUEST_ID_RE.test(r.id)) {
      ignored.push(isPlainObject(r) && typeof r.id === 'string' ? r.id.slice(0, 64) : null);
      continue;
    }
    const row = await db.prepare('SELECT id, user_id, clan_id, tag, status FROM clan_joins WHERE id = ?').bind(r.id).first();
    if (!row || (row.status !== 'queued' && row.status !== 'sent')) {
      ignored.push(r.id);
      continue;
    }
    const ok = r.ok === true;
    const code = typeof r.code === 'string' && CODES.has(r.code) ? r.code : ok ? 'joined' : 'failed';
    const message = cleanText(typeof r.message === 'string' ? r.message : '', MESSAGE_MAX) || (ok ? 'You joined the clan.' : "YapOS couldn't add you to that clan.");
    const stmts = [
      db.prepare("UPDATE clan_joins SET status = ?, code = ?, result = ?, updated = ? WHERE id = ? AND status IN ('queued', 'sent')").bind(ok ? 'joined' : 'refused', code, message, t, row.id),
    ];
    if (ok) {
      stmts.push(db.prepare('INSERT INTO clan_members (user_id, clan_id, updated) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET clan_id = excluded.clan_id, updated = excluded.updated').bind(row.user_id, row.clan_id, t));
      if (code === 'joined') stmts.push(db.prepare('UPDATE clan_directory SET members = members + 1 WHERE id = ?').bind(row.clan_id));
    } else if (code === 'invite_only') {
      stmts.push(db.prepare("UPDATE clan_directory SET join_mode = 'invite' WHERE id = ?").bind(row.clan_id));
    } else if (code === 'gone') {
      stmts.push(...removeStatements(db, row.clan_id));
    }
    if (!ok) stmts.push(...noteStatements(db, [{ id: `cj-${row.id}`, user: row.user_id, kind: 'clan_refused', title: `You couldn't join [${row.tag}]`, body: message, data: { clan: row.clan_id, tag: row.tag } }], t));
    await db.batch(stmts);
    stored += 1;
  }
  return json({ ok: true, stored, ignored });
}

export function clanCleanupStatements(db, t) {
  return [
    db.prepare("DELETE FROM clan_joins WHERE created < ? AND status NOT IN ('queued', 'sent')").bind(t - CLAN_JOIN_KEEP),
    ...clanManageCleanupStatements(db, t),
  ];
}

async function findClan(db, raw) {
  if (typeof raw !== 'string' || !CLAN_TAG_RE.test(raw)) return { bad: true };
  const row = await db.prepare('SELECT id, tag, name, colour, banner, members, join_mode, leader_id, created, updated FROM clan_directory WHERE tag_key = ? ORDER BY updated DESC LIMIT 1').bind(lower(raw)).first();
  return row ? { row } : { missing: true };
}

async function topMembers(db, row, t) {
  const res = await db
    .prepare('SELECT m.user_id FROM clan_members m LEFT JOIN public_profiles p ON p.user_id = m.user_id WHERE m.clan_id = ? AND (p.hidden IS NULL OR p.hidden = 0) ORDER BY COALESCE(p.level, 0) DESC, m.user_id ASC LIMIT ?')
    .bind(row.id, CLAN_TOP * 3)
    .all();
  const ids = ((res && res.results) || []).map((r) => lower(r.user_id));
  const leader = row.leader_id ? lower(row.leader_id) : null;
  const found = await people(db, leader ? [leader, ...ids] : ids, t, { pics: true });
  const top = [];
  const order = leader && ids.includes(leader) ? [leader, ...ids.filter((x) => x !== leader)] : ids;
  for (const id of order) {
    const p = found.get(id);
    if (!p || isBoardOwner(id)) continue;
    top.push({ name: p.name, username: p.username, level: p.level, leader: id === leader, ...picOut(p) });
    if (top.length >= CLAN_TOP) break;
  }
  const lead = leader ? found.get(leader) : null;
  return { leader: lead ? { name: lead.name, username: lead.username, ...picOut(lead) } : null, top };
}

function picOut(p) {
  return p && p.avatar ? { avatar: p.avatar, ...(p.avatarStill ? { avatarStill: p.avatarStill } : {}) } : {};
}

function clanOut(row, extra) {
  return {
    tag: row.tag,
    name: row.name,
    colour: row.colour || null,
    banner: row.banner || null,
    members: whole(row.members, 0, 1e9),
    join: JOIN_MODES.includes(row.join_mode) ? row.join_mode : 'open',
    created: whole(row.created, 0, 1e15) || null,
    updated: whole(row.updated, 0, 1e15),
    ...extra,
  };
}

function requestOut(r, t) {
  if (!r) return null;
  const open = r.status === 'queued' || r.status === 'sent';
  const waiting = r.status === 'queued' && Number(r.created) < t - CLAN_JOIN_WAITING;
  return {
    id: r.id,
    status: open ? 'pending' : r.status === 'joined' ? 'joined' : 'refused',
    code: open ? null : r.code || null,
    message: open ? (waiting ? WAITING : 'Waiting for YapOS to add you.') : r.result || null,
    waiting,
    created: Number(r.created),
    updated: Number(r.updated),
  };
}

async function viewerOf(db, user, row, t) {
  if (!user) return { signedIn: false, status: 'signed_out', clan: null, request: null };
  const me = lower(user.id);
  const [membership, open, recent] = await Promise.all([
    db.prepare('SELECT m.clan_id, d.tag, d.name FROM clan_members m LEFT JOIN clan_directory d ON d.id = m.clan_id WHERE m.user_id = ?').bind(me).first(),
    db.prepare("SELECT id, clan_id, tag, status, code, result, created, updated FROM clan_joins WHERE user_id = ? AND status IN ('queued', 'sent') ORDER BY created DESC LIMIT 1").bind(me).first(),
    row ? db.prepare('SELECT id, clan_id, tag, status, code, result, created, updated FROM clan_joins WHERE user_id = ? AND clan_id = ? AND created >= ? ORDER BY created DESC, rowid DESC LIMIT 1').bind(me, row.id, t - CLAN_JOIN_RECENT).first() : null,
  ]);
  const inThis = Boolean(row && membership && membership.clan_id === row.id);
  const other = membership && !inThis && membership.tag ? { tag: membership.tag, name: membership.name } : null;
  let status;
  if (inThis) status = 'member';
  else if (open && row && open.clan_id === row.id) status = 'pending';
  else if (open) status = 'pending_other';
  else if (membership && !inThis) status = 'other';
  else if (row && row.join_mode === 'invite') status = 'invite_only';
  else status = 'can_join';
  const req = open && row && open.clan_id === row.id ? open : recent;
  const out = { signedIn: true, status, clan: other, request: requestOut(req, t) };
  if (status === 'pending_other' && open) out.pendingTag = open.tag;
  return out;
}

async function whoIsAsking(request, env, t) {
  const viaBearer = Boolean(bearer(request));
  const found = await getActivityUser(env.DB, request, t);
  return found ? { user: found.user, viaBearer } : { user: null, viaBearer };
}

function csrfOk(request, env) {
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  return Boolean(origin && expected && origin === expected && request.headers.get('X-YapOS') === '1');
}

async function getClan(request, env, raw, t) {
  const limit = await hit(env.DB, await ipKey('clans', clientIp(request)), LIMITS.clans, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const found = await findClan(env.DB, raw);
  if (found.bad) return fail(400, 'bad_tag', 'Clan tags are 3 or 4 letters or numbers.');
  if (found.missing) return fail(404, 'not_found', MISSING);
  const { user } = await whoIsAsking(request, env, t);
  const extra = await topMembers(env.DB, found.row, t);
  return json({ clan: clanOut(found.row, extra), viewer: await viewerOf(env.DB, user, found.row, t) });
}

async function joinClan(request, env, raw, t) {
  const ask = await whoIsAsking(request, env, t);
  if (!ask.viaBearer && !csrfOk(request, env)) return fail(403, 'forbidden', BLOCKED);
  const ipLimit = await hit(env.DB, await ipKey('clanJoin', clientIp(request)), LIMITS.clanJoinIp, t);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  if (!ask.user) return fail(401, 'signed_out', 'Sign in to join a clan.');
  const me = lower(ask.user.id);
  const userLimit = await hit(env.DB, `clanJoin:u:${me}`, LIMITS.clanJoin, t);
  if (!userLimit.ok) return tooMany(userLimit.retryAfter, 'That is a lot of join requests. Wait a minute and try again.');
  const found = await findClan(env.DB, raw);
  if (found.bad) return fail(400, 'bad_tag', 'Clan tags are 3 or 4 letters or numbers.');
  if (found.missing) return fail(404, 'not_found', MISSING);
  const row = found.row;
  const viewer = await viewerOf(env.DB, ask.user, row, t);
  if (viewer.status === 'member') return fail(409, 'already_member', `You're already in [${row.tag}] ${row.name}.`, { viewer });
  if (viewer.status === 'pending') return json({ request: viewer.request, viewer }, 200);
  if (viewer.status === 'pending_other') return fail(409, 'pending_elsewhere', `You already asked to join [${viewer.pendingTag}]. Wait for that to finish first.`, { viewer });
  if (viewer.status === 'other') return fail(409, 'in_other_clan', `You're in [${viewer.clan.tag}] ${viewer.clan.name}. Leave it first with /clan leave.`, { viewer });
  if (viewer.status === 'invite_only') return fail(403, 'invite_only', `[${row.tag}] ${row.name} is invite only. Ask the leader for an invite.`, { viewer });
  const id = randomToken(18);
  const put = await env.DB
    .prepare("INSERT INTO clan_joins (id, user_id, clan_id, tag, via, created, status, sent_at, code, result, updated) SELECT ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM clan_joins WHERE user_id = ? AND status IN ('queued', 'sent'))")
    .bind(id, me, row.id, row.tag, ask.viaBearer ? 'party' : 'web', t, t, me)
    .run();
  const after = await viewerOf(env.DB, ask.user, row, t);
  const added = Number((put && put.meta && put.meta.changes) || 0) > 0;
  if (!added && after.status === 'pending_other') return fail(409, 'pending_elsewhere', `You already asked to join [${after.pendingTag}]. Wait for that to finish first.`, { viewer: after });
  return json({ request: after.request, viewer: after }, added ? 202 : 200);
}

export function clansRoute(request, env, segs, t) {
  const method = request.method;
  if (segs.length === 2) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return browseClans(request, env, new URL(request.url), t);
  }
  if (segs.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return getClan(request, env, segs[2], t);
  }
  if (segs.length === 4 && segs[3] === 'join') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    return joinClan(request, env, segs[2], t);
  }
  return fail(404, 'not_found', MISSING);
}
