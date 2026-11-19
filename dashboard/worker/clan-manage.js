import { MINUTE, DAY, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, parseJsonSafe, clientIp, randomToken } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText } from './profiles.js';
import { applySettings } from './public-profiles.js';
import { isPartyOwner } from './party.js';
import { people } from './clan-people.js';
import { noteStatements } from './inbox.js';
import { checkClanName, checkClanTag, checkClanBanner, parseClanColour, colourHex, tagSkeleton, normalizeName, CREATE_COST, STYLE_PRICE, BOOST_PRICE } from '../web/js/clan-rules.js';

export const CLAN_ACTION_KINDS = Object.freeze(['create', 'invite', 'accept', 'decline', 'kick', 'leader', 'tag', 'colour', 'banner', 'privacy', 'upgrade', 'disband', 'leave']);
export const CLAN_ACTIONS_OPEN = 3;
export const CLAN_ACTION_BATCH = 50;
export const CLAN_ACTION_RESEND = 2 * MINUTE;
export const CLAN_ACTION_WAITING = 45 * 1000;
export const CLAN_ACTION_GIVE_UP = DAY;
export const CLAN_ACTION_KEEP = 7 * DAY;
export const CLAN_ACTION_RECENT = DAY;
export const CLAN_INVITE_TTL = 7 * DAY;
export const CLAN_EVENTS_MAX = 500;
export const CLAN_ROSTER_MAX = 300;
export const CLAN_BROWSE_PAGE = 20;
export const DISBAND_NOTES_MAX = 200;

const LEADER_KINDS = new Set(['invite', 'kick', 'leader', 'tag', 'colour', 'banner', 'privacy', 'upgrade', 'disband']);
const KIND_SET = new Set(CLAN_ACTION_KINDS);
const RESULTS_LIMIT = 256 * 1024;
const RESULTS_MAX = 100;
const MESSAGE_MAX = 300;
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CLAN_ID_RE = /^c\d{1,9}$/;
const ACTION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CODE_RE = /^[a-z_]{1,24}$/;
const FEED_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_FIELDS = new Set(['kind', 'name', 'tag', 'who', 'target', 'colour', 'text', 'mode', 'upgrade', 'clan', 'confirm']);
const EVENT_KINDS = new Set(['invite', 'joined', 'left', 'kicked', 'leader', 'disbanded', 'declined']);
const GAVE_UP = "YapOS didn't answer for a day, so this was dropped. Try again.";
const WAITING = "YapOS is offline right now. This goes through when it's back.";

const lower = (v) => String(v ?? '').toLowerCase();
const rowsOf = (res) => (res && res.results) || [];

function whole(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function bad(code, message, status = 400) {
  return new HttpError(status, code, message);
}

export function cleanExtras(raw) {
  const out = {};
  if (Number.isFinite(raw.bank)) {
    out.details = {
      bank: whole(raw.bank, 0, Number.MAX_SAFE_INTEGER),
      style: raw.style === true,
      boost: raw.boost === true,
      deposits: isPlainObject(raw.deposits)
        ? Object.fromEntries(Object.entries(raw.deposits).filter(([k, v]) => USER_RE.test(k) && Number.isFinite(v) && v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => [lower(k), whole(v, 0, Number.MAX_SAFE_INTEGER)]))
        : {},
    };
  }
  if (Array.isArray(raw.invites)) {
    out.invites = raw.invites
      .filter((x) => isPlainObject(x) && typeof x.user === 'string' && USER_RE.test(x.user))
      .slice(0, 500)
      .map((x) => ({ user: lower(x.user), by: typeof x.by === 'string' && USER_RE.test(x.by) ? lower(x.by) : null, at: whole(x.at, 0, 1e15) }));
  }
  return out;
}

export function extrasStatements(db, clan, t) {
  const stmts = [];
  if (clan.details) {
    const d = clan.details;
    stmts.push(db.prepare('INSERT INTO clan_details (clan_id, bank, style, boost, deposits, joined, updated) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (clan_id) DO UPDATE SET bank = excluded.bank, style = excluded.style, boost = excluded.boost, deposits = excluded.deposits, updated = excluded.updated')
      .bind(clan.id, d.bank, d.style ? 1 : 0, d.boost ? 1 : 0, JSON.stringify(d.deposits), t));
  }
  if (clan.invites && !clan.append) {
    stmts.push(db.prepare('DELETE FROM clan_invites WHERE clan_id = ?').bind(clan.id));
    for (const inv of clan.invites) {
      stmts.push(db.prepare('INSERT INTO clan_invites (user_id, clan_id, by_id, at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, clan_id) DO UPDATE SET by_id = excluded.by_id, at = excluded.at').bind(inv.user, clan.id, inv.by, inv.at));
    }
  }
  return stmts;
}

export function extrasRemoveStatements(db, id) {
  return [
    db.prepare('DELETE FROM clan_details WHERE clan_id = ?').bind(id),
    db.prepare('DELETE FROM clan_invites WHERE clan_id = ?').bind(id),
  ];
}

export function settingsStatement(db, raw, t) {
  if (!isPlainObject(raw)) return null;
  const s = {
    createCost: whole(raw.createCost ?? CREATE_COST, 0, 1e6),
    stylePrice: whole(raw.stylePrice ?? STYLE_PRICE, 0, 1e9),
    boostPrice: whole(raw.boostPrice ?? BOOST_PRICE, 0, 1e9),
    boost: Number.isFinite(raw.boost) ? Math.max(0, Math.min(1, raw.boost)) : 0.05,
  };
  return db.prepare("INSERT INTO clan_sync (id, seq, data, updated) VALUES ('settings', 0, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated = excluded.updated").bind(JSON.stringify(s), t);
}

async function readSettings(db) {
  const row = await db.prepare("SELECT data FROM clan_sync WHERE id = 'settings'").first();
  const s = parseJsonSafe(row && row.data, null) || {};
  return {
    createCost: Number.isFinite(s.createCost) ? s.createCost : CREATE_COST,
    stylePrice: Number.isFinite(s.stylePrice) ? s.stylePrice : STYLE_PRICE,
    boostPrice: Number.isFinite(s.boostPrice) ? s.boostPrice : BOOST_PRICE,
    boost: Number.isFinite(s.boost) ? s.boost : 0.05,
  };
}

function cleanEvent(raw) {
  if (!isPlainObject(raw) || !EVENT_KINDS.has(raw.kind) || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
  const id = (v) => (typeof v === 'string' && USER_RE.test(v) ? lower(v) : null);
  const tag = typeof raw.tag === 'string' && /^[A-Za-z0-9]{3,4}$/.test(raw.tag) ? raw.tag.toUpperCase() : null;
  const clan = typeof raw.clan === 'string' && CLAN_ID_RE.test(raw.clan) ? raw.clan : null;
  if (!tag || !clan) return null;
  const members = Array.isArray(raw.members) ? raw.members.map(id).filter(Boolean).slice(0, DISBAND_NOTES_MAX) : [];
  return {
    seq: raw.seq,
    kind: raw.kind,
    user: id(raw.user),
    by: id(raw.by),
    leader: id(raw.leader),
    next: id(raw.next),
    clan,
    tag,
    name: cleanText(typeof raw.name === 'string' ? raw.name : '', 32) || tag,
    via: raw.via === 'web' || raw.via === 'party' ? raw.via : null,
    members,
  };
}

function inviterName(p) {
  return p && !p.hidden ? p.name : null;
}

function eventNotes(e, names) {
  const who = (id) => (id && names.get(id) ? names.get(id).name : 'Someone');
  const label = `[${e.tag}] ${e.name}`;
  const base = { clan: e.clan, tag: e.tag };
  const id = (suffix = '') => `ce-${e.feed}-${e.seq}${suffix}`;
  const out = [];
  if (e.kind === 'invite' && e.user) out.push({ id: id(), user: e.user, kind: 'clan_invite', title: `Clan invite from ${label}`, body: `${who(e.by)} invited you to join. Invites last 7 days.`, data: { ...base, by: e.by } });
  if (e.kind === 'joined' && e.user && e.leader && e.leader !== e.user) out.push({ id: id(), user: e.leader, kind: 'clan_joined', title: `${who(e.user)} joined ${label}`, body: e.via === 'web' ? 'They joined on the website.' : e.via === 'party' ? 'They joined in YapOS Party.' : null, data: base });
  if (e.kind === 'left' && e.user) {
    if (e.leader && e.leader !== e.user) out.push({ id: id(), user: e.leader, kind: 'clan_left', title: `${who(e.user)} left ${label}`, data: base });
    if (e.next) out.push({ id: id('-lead'), user: e.next, kind: 'clan_leader', title: `You lead ${label} now`, body: 'The old leader left, so you were next in line.', data: base });
  }
  if (e.kind === 'kicked' && e.user) out.push({ id: id(), user: e.user, kind: 'clan_kicked', title: `You were removed from ${label}`, body: 'The clan leader removed you. You can join another clan any time.', data: base });
  if (e.kind === 'leader' && e.user) out.push({ id: id(), user: e.user, kind: 'clan_leader', title: `You lead ${label} now`, body: `${who(e.by)} made you the clan leader.`, data: base });
  if (e.kind === 'declined' && e.user && e.leader) out.push({ id: id(), user: e.leader, kind: 'clan_declined', title: `${who(e.user)} said no thanks`, body: `They turned down your invite to ${label}.`, data: base });
  if (e.kind === 'disbanded') {
    for (const m of e.members) {
      if (m === e.by) continue;
      out.push({ id: id(`-${m.slice(0, 36)}`), user: m, kind: 'clan_closed', title: `${label} was closed`, body: 'The leader closed the clan. You can start or join another one.', data: base });
    }
  }
  return out;
}

export async function feedStatements(db, body, t) {
  const list = Array.isArray(body.events) ? body.events.slice(0, CLAN_EVENTS_MAX) : [];
  const feed = typeof body.feed === 'string' && FEED_RE.test(body.feed) ? body.feed : null;
  if (!feed || !list.length) return { stmts: [], notes: 0 };
  const row = await db.prepare("SELECT seq, data FROM clan_sync WHERE id = 'feed'").first();
  const last = row && row.data === feed ? Number(row.seq) || 0 : 0;
  const events = list.map(cleanEvent).filter((e) => e && e.seq > last).sort((a, b) => a.seq - b.seq);
  const max = list.reduce((m, e) => (isPlainObject(e) && Number.isInteger(e.seq) ? Math.max(m, e.seq) : m), last);
  const ids = new Set();
  for (const e of events) for (const k of ['user', 'by']) if (e[k]) ids.add(e[k]);
  const names = ids.size ? await people(db, [...ids], t) : new Map();
  const notes = events.flatMap((e) => eventNotes({ ...e, feed }, names));
  const stmts = [
    ...noteStatements(db, notes, t),
    db.prepare("INSERT INTO clan_sync (id, seq, data, updated) VALUES ('feed', ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, data = excluded.data, updated = excluded.updated").bind(max, feed, t),
  ];
  return { stmts, notes: notes.length };
}

export async function clanActionPoll(db, t) {
  await db.prepare("UPDATE clan_actions SET status = 'failed', code = 'failed', result = ?, updated = ? WHERE status IN ('queued', 'sent') AND created < ?").bind(GAVE_UP, t, t - CLAN_ACTION_GIVE_UP).run();
  const res = await db
    .prepare("UPDATE clan_actions SET status = 'sent', sent_at = ?, updated = ? WHERE id IN (SELECT id FROM clan_actions WHERE status = 'queued' OR (status = 'sent' AND sent_at <= ?) ORDER BY created ASC, rowid ASC LIMIT ?) RETURNING rowid AS seq, id, user_id, kind, clan_id, payload, created")
    .bind(t, t, t - CLAN_ACTION_RESEND, CLAN_ACTION_BATCH)
    .all();
  const rows = rowsOf(res).slice();
  rows.sort((a, b) => Number(a.created) - Number(b.created) || Number(a.seq) - Number(b.seq));
  return rows.map((r) => ({ id: r.id, user: r.user_id, kind: r.kind, clan: r.clan_id || null, payload: parseJsonSafe(r.payload, null) || {} }));
}

export async function postClanActionResults(request, env, t) {
  const body = await readJson(request, RESULTS_LIMIT);
  if (!Array.isArray(body.results)) throw bad('bad_results', '"results" must be a list.');
  if (body.results.length > RESULTS_MAX) throw new HttpError(413, 'too_many', `Send at most ${RESULTS_MAX} results at once.`);
  const db = env.DB;
  let stored = 0;
  const ignored = [];
  for (const r of body.results) {
    if (!isPlainObject(r) || typeof r.id !== 'string' || !ACTION_ID_RE.test(r.id)) {
      ignored.push(isPlainObject(r) && typeof r.id === 'string' ? r.id.slice(0, 64) : null);
      continue;
    }
    const row = await db.prepare('SELECT id, user_id, kind, clan_id, status FROM clan_actions WHERE id = ?').bind(r.id).first();
    if (!row || (row.status !== 'queued' && row.status !== 'sent')) {
      ignored.push(r.id);
      continue;
    }
    const ok = r.ok === true;
    const code = typeof r.code === 'string' && CODE_RE.test(r.code) ? r.code : ok ? 'done' : 'refused';
    const message = cleanText(typeof r.message === 'string' ? r.message : '', MESSAGE_MAX) || (ok ? 'Done.' : "YapOS couldn't do that.");
    const stmts = [db.prepare("UPDATE clan_actions SET status = ?, code = ?, result = ?, updated = ? WHERE id = ? AND status IN ('queued', 'sent')").bind(ok ? 'done' : 'refused', code, message, t, row.id)];
    if (ok && row.kind === 'accept' && row.clan_id) stmts.push(db.prepare('DELETE FROM clan_invites WHERE user_id = ?').bind(lower(row.user_id)));
    if (row.kind === 'decline' && row.clan_id) stmts.push(db.prepare('DELETE FROM clan_invites WHERE user_id = ? AND clan_id = ?').bind(lower(row.user_id), row.clan_id));
    await db.batch(stmts);
    stored += 1;
  }
  return json({ ok: true, stored, ignored });
}

export function clanManageCleanupStatements(db, t) {
  return [
    db.prepare("DELETE FROM clan_actions WHERE created < ? AND status NOT IN ('queued', 'sent')").bind(t - CLAN_ACTION_KEEP),
    db.prepare('DELETE FROM clan_invites WHERE at < ?').bind(t - CLAN_INVITE_TTL),
  ];
}

function actionOut(r, t) {
  const open = r.status === 'queued' || r.status === 'sent';
  const waiting = open && Number(r.created) < t - CLAN_ACTION_WAITING;
  return {
    id: r.id,
    kind: r.kind,
    status: open ? 'pending' : r.status === 'done' ? 'done' : 'refused',
    code: open ? null : r.code || null,
    message: open ? (waiting ? WAITING : 'Waiting for YapOS…') : r.result || null,
    waiting,
    created: Number(r.created),
    updated: Number(r.updated),
  };
}

async function membership(db, me) {
  const row = await db.prepare('SELECT m.clan_id, d.id, d.tag, d.name, d.colour, d.banner, d.members, d.join_mode, d.leader_id, d.created FROM clan_members m JOIN clan_directory d ON d.id = m.clan_id WHERE m.user_id = ?').bind(me).first();
  return row || null;
}

function personOut(id, found, extra = {}) {
  const p = found.get(id);
  return { id, name: p ? p.name : 'Private profile', username: p ? p.username : null, level: p ? p.level : null, hidden: !p, ...extra };
}

export async function myClanView(db, me, t, { owner = false } = {}) {
  const settings = await readSettings(db);
  const mine = await membership(db, me);
  const [incomingRes, actionsRes, joinRow] = await Promise.all([
    db.prepare('SELECT i.clan_id, i.by_id, i.at, d.tag, d.name, d.colour, d.banner, d.members, d.join_mode FROM clan_invites i JOIN clan_directory d ON d.id = i.clan_id WHERE i.user_id = ? AND i.at >= ? ORDER BY i.at DESC LIMIT 10').bind(me, t - CLAN_INVITE_TTL).all(),
    db.prepare('SELECT id, kind, status, code, result, created, updated FROM clan_actions WHERE user_id = ? AND created >= ? ORDER BY created DESC, rowid DESC LIMIT 10').bind(me, t - CLAN_ACTION_RECENT).all(),
    db.prepare("SELECT id, tag, status, code, result, created, updated FROM clan_joins WHERE user_id = ? AND status IN ('queued', 'sent') ORDER BY created DESC LIMIT 1").bind(me).first(),
  ]);
  const incoming = rowsOf(incomingRes);
  const ids = new Set(incoming.map((r) => r.by_id).filter(Boolean));
  let clan = null;
  if (mine) {
    const [detail, rosterRes, outRes] = await Promise.all([
      db.prepare('SELECT bank, style, boost, deposits FROM clan_details WHERE clan_id = ?').bind(mine.id).first(),
      db.prepare('SELECT user_id FROM clan_members WHERE clan_id = ? LIMIT ?').bind(mine.id, CLAN_ROSTER_MAX + 1).all(),
      db.prepare('SELECT user_id, by_id, at FROM clan_invites WHERE clan_id = ? AND at >= ? ORDER BY at DESC LIMIT 50').bind(mine.id, t - CLAN_INVITE_TTL).all(),
    ]);
    const roster = rowsOf(rosterRes).map((r) => lower(r.user_id));
    const leaderId = mine.leader_id ? lower(mine.leader_id) : null;
    if (leaderId && !roster.includes(leaderId)) roster.unshift(leaderId);
    const outgoing = rowsOf(outRes);
    const deposits = parseJsonSafe(detail && detail.deposits, null) || {};
    for (const id of roster) ids.add(id);
    for (const r of outgoing) ids.add(lower(r.user_id));
    for (const id of Object.keys(deposits)) ids.add(id);
    const found = await people(db, [...ids], t);
    const lead = leaderId === me;
    const members = roster.slice(0, CLAN_ROSTER_MAX)
      .map((id) => personOut(id, found, { leader: id === leaderId, you: id === me }))
      .sort((a, b) => Number(b.leader) - Number(a.leader) || Number(b.you) - Number(a.you) || (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name));
    clan = {
      id: mine.id,
      tag: mine.tag,
      name: mine.name,
      colour: mine.colour || null,
      banner: mine.banner || null,
      join: mine.join_mode === 'invite' ? 'invite' : 'open',
      count: whole(mine.members, 0, 1e9),
      created: whole(mine.created, 0, 1e15) || null,
      leader: lead,
      leaderName: leaderId ? personOut(leaderId, found).name : null,
      bank: detail ? whole(detail.bank, 0, Number.MAX_SAFE_INTEGER) : null,
      style: Boolean(detail && Number(detail.style)),
      boost: Boolean(detail && Number(detail.boost)),
      deposits: Object.entries(deposits).sort((a, b) => b[1] - a[1]).map(([id, amount]) => ({ name: personOut(id, found).name, amount: whole(amount, 0, Number.MAX_SAFE_INTEGER) })),
      members,
      more: Math.max(0, whole(mine.members, 0, 1e9) - members.length),
      invites: lead ? outgoing.map((r) => ({ ...personOut(lower(r.user_id), found), at: Number(r.at) })) : [],
    };
    return { me, owner, settings, clan, invites: [], actions: rowsOf(actionsRes).map((r) => actionOut(r, t)), joining: null };
  }
  const found = ids.size ? await people(db, [...ids], t) : new Map();
  return {
    me,
    owner,
    settings,
    clan: null,
    invites: incoming.map((r) => ({
      clan: { id: r.clan_id, tag: r.tag, name: r.name, colour: r.colour || null, banner: r.banner || null, members: whole(r.members, 0, 1e9), join: r.join_mode === 'invite' ? 'invite' : 'open' },
      by: r.by_id ? inviterName(personOut(lower(r.by_id), found)) : null,
      at: Number(r.at),
    })),
    actions: rowsOf(actionsRes).map((r) => actionOut(r, t)),
    joining: joinRow ? { tag: joinRow.tag, created: Number(joinRow.created) } : null,
  };
}

async function allClans(db) {
  return rowsOf(await db.prepare('SELECT id, tag, name FROM clan_directory').all());
}

export async function resolvePerson(db, raw, t) {
  const s = String(raw ?? '').trim().replace(/^<@!?|>$/g, '');
  if (UUID_RE.test(s)) return { id: lower(s) };
  const handle = s.replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) return { error: "Type their @username or paste their Yapin' user id." };
  const row = await db.prepare('SELECT p.user_id, p.hidden, p.updated, s.hidden AS s_hidden, s.show_shards AS s_show_shards, s.claimed AS s_claimed, s.updated AS s_updated FROM public_profiles p LEFT JOIN profile_settings s ON s.user_id = p.user_id WHERE p.username_key = ? LIMIT 1').bind(lower(handle)).first();
  if (!row) return { error: `No YapOS profile is called @${handle}. Paste their Yapin' user id instead.`, missing: true };
  const settings = row.s_updated === null || row.s_updated === undefined ? null : { hidden: row.s_hidden, show_shards: row.s_show_shards, claimed: row.s_claimed, updated: row.s_updated };
  if (applySettings({ hidden: row.hidden, updated: row.updated }, settings).hidden) return { error: `No YapOS profile is called @${handle}. Paste their Yapin' user id instead.`, missing: true };
  return { id: lower(row.user_id) };
}

export async function validateClanAction(db, me, body, t, { owner = false } = {}) {
  if (!isPlainObject(body)) throw bad('bad_request', 'Send the action as an object.');
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  const kind = typeof body.kind === 'string' && KIND_SET.has(body.kind) ? body.kind : null;
  if (!kind) throw bad('bad_kind', "That isn't something you can do to a clan here.");
  const mine = await membership(db, me);
  const lead = Boolean(mine && mine.leader_id && lower(mine.leader_id) === me);
  if (LEADER_KINDS.has(kind)) {
    if (!mine) throw bad('no_clan', "You're not in a clan.", 409);
    if (!lead) throw bad('not_leader', 'Only the clan leader can do that.', 403);
  }
  if (kind === 'leave' && !mine) throw bad('no_clan', "You're not in a clan.", 409);
  if ((kind === 'create' || kind === 'accept') && mine) throw bad('in_clan', `You're in [${mine.tag}] ${mine.name}. Leave it first.`, 409);
  const clanId = mine ? mine.id : null;
  if (kind === 'create') {
    const name = checkClanName(body.name, { owner });
    if (name.error) throw bad('bad_name', name.error);
    const tag = checkClanTag(body.tag, { owner });
    if (tag.error) throw bad('bad_tag', tag.error);
    const list = await allClans(db);
    if (list.some((c) => tagSkeleton(c.tag) === tagSkeleton(tag.value))) throw bad('tag_taken', `Another clan already uses [${tag.value}] or a tag that looks just like it. Pick another tag.`, 409);
    if (list.some((c) => normalizeName(c.name) === normalizeName(name.value))) throw bad('name_taken', `There is already a clan called ${name.value}. Pick another name.`, 409);
    return { kind, clan: null, payload: { name: name.value, tag: tag.value } };
  }
  if (kind === 'invite') {
    const who = await resolvePerson(db, body.who, t);
    if (who.error) throw bad(who.missing ? 'no_person' : 'bad_person', who.error, who.missing ? 404 : 400);
    if (who.id === me) throw bad('self', "That's you! You're already in the clan.");
    const theirs = await db.prepare('SELECT clan_id FROM clan_members WHERE user_id = ?').bind(who.id).first();
    if (theirs && theirs.clan_id === clanId) throw bad('already_member', "They're already in your clan.", 409);
    return { kind, clan: clanId, payload: { target: who.id } };
  }
  if (kind === 'kick' || kind === 'leader') {
    const target = typeof body.target === 'string' && USER_RE.test(body.target) ? lower(body.target) : null;
    if (!target) throw bad('bad_target', 'Pick someone from your clan first.');
    if (target === me) throw bad('self', kind === 'kick' ? 'To go, leave the clan instead.' : 'You already lead the clan.');
    const row = await db.prepare('SELECT clan_id FROM clan_members WHERE user_id = ?').bind(target).first();
    if (!row || row.clan_id !== clanId) throw bad('not_member', "They're not in your clan.", 409);
    return { kind, clan: clanId, payload: { target } };
  }
  if (kind === 'tag') {
    const tag = checkClanTag(body.tag, { owner });
    if (tag.error) throw bad('bad_tag', tag.error);
    if ((await allClans(db)).some((c) => c.id !== clanId && tagSkeleton(c.tag) === tagSkeleton(tag.value))) throw bad('tag_taken', `Another clan already uses [${tag.value}] or a tag that looks just like it.`, 409);
    return { kind, clan: clanId, payload: { tag: tag.value } };
  }
  if (kind === 'colour' || kind === 'banner') {
    const detail = await db.prepare('SELECT style FROM clan_details WHERE clan_id = ?').bind(clanId).first();
    if (detail && !Number(detail.style)) throw bad('locked', 'Clan colours and banners are an upgrade. Buy "Colour and banner" first.', 409);
    if (kind === 'colour') {
      const n = parseClanColour(body.colour);
      if (n === null) throw bad('bad_colour', 'Use a hex code like #ff8800 or a colour name like teal.');
      return { kind, clan: clanId, payload: { colour: colourHex(n) } };
    }
    const banner = checkClanBanner(body.text, { owner });
    if (banner.error) throw bad('bad_banner', banner.error);
    return { kind, clan: clanId, payload: { text: banner.value || '' } };
  }
  if (kind === 'privacy') {
    if (body.mode !== 'open' && body.mode !== 'invite') throw bad('bad_mode', 'Choose open or invite only.');
    return { kind, clan: clanId, payload: { mode: body.mode } };
  }
  if (kind === 'upgrade') {
    if (body.upgrade !== 'style' && body.upgrade !== 'boost') throw bad('bad_upgrade', 'Choose an upgrade.');
    return { kind, clan: clanId, payload: { upgrade: body.upgrade } };
  }
  if (kind === 'disband') {
    if (body.confirm !== true) throw bad('confirm', 'Confirm that you want to close the clan.');
    return { kind, clan: clanId, payload: {} };
  }
  if (kind === 'leave') return { kind, clan: clanId, payload: {} };
  const target = typeof body.clan === 'string' && CLAN_ID_RE.test(body.clan) ? body.clan : null;
  if (!target) throw bad('bad_clan', 'Pick an invite first.');
  if (kind === 'accept') {
    const inv = await db.prepare('SELECT at FROM clan_invites WHERE user_id = ? AND clan_id = ? AND at >= ?').bind(me, target, t - CLAN_INVITE_TTL).first();
    if (!inv) throw bad('no_invite', 'That invite ran out or was taken back. Ask the leader for a new one.', 409);
  }
  return { kind, clan: target, payload: { clan: target } };
}

async function limits(request, env, me, t) {
  const ip = await hit(env.DB, await ipKey('clanAct', clientIp(request)), LIMITS.clanActionsIp, t);
  if (!ip.ok) return tooMany(ip.retryAfter);
  const user = await hit(env.DB, `clanAct:u:${me}`, LIMITS.clanActions, t);
  if (!user.ok) return tooMany(user.retryAfter, "That's a lot of clan changes. Wait a minute and try again.");
  return null;
}

export async function queueClanAction(db, me, a, t, extra = []) {
  const id = randomToken(18);
  const put = await db.batch([
    db.prepare("INSERT INTO clan_actions (id, user_id, kind, clan_id, payload, created, status, sent_at, code, result, updated) SELECT ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ? WHERE (SELECT COUNT(*) FROM clan_actions WHERE user_id = ? AND status IN ('queued', 'sent')) < ?")
      .bind(id, me, a.kind, a.clan, JSON.stringify(a.payload || {}), t, t, me, CLAN_ACTIONS_OPEN),
    ...extra.map((fn) => fn(id)),
  ]);
  const added = Number((put[0] && put[0].meta && put[0].meta.changes) || 0) > 0;
  if (!added) return null;
  return db.prepare('SELECT id, kind, status, code, result, created, updated FROM clan_actions WHERE id = ?').bind(id).first();
}

async function postAction(request, env, session, t) {
  const me = lower(session.user_id);
  const limited = await limits(request, env, me, t);
  if (limited) return limited;
  const body = await readJson(request, USER_BODY_LIMIT);
  const a = await validateClanAction(env.DB, me, body, t, { owner: isPartyOwner(env, me) });
  const row = await queueClanAction(env.DB, me, a, t);
  if (!row) return fail(409, 'busy', `You have ${CLAN_ACTIONS_OPEN} clan changes waiting already. Give YapOS a moment to catch up.`);
  return json({ action: actionOut(row, t) }, 202);
}

export async function answerInvite(request, env, session, { note, data, choice }, t) {
  const me = lower(session.user_id);
  const limited = await limits(request, env, me, t);
  if (limited) return limited;
  const a = await validateClanAction(env.DB, me, { kind: choice, clan: data.clan }, t, { owner: isPartyOwner(env, me) });
  const next = (id) => env.DB.prepare('UPDATE notifications SET data = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM clan_actions WHERE id = ?)').bind(JSON.stringify({ ...data, action: id }), t, note.id, me, id);
  const row = await queueClanAction(env.DB, me, a, t, [next]);
  if (!row) return fail(409, 'busy', `You have ${CLAN_ACTIONS_OPEN} clan changes waiting already. Give YapOS a moment to catch up.`);
  return json({ action: actionOut(row, t) }, 202);
}

async function searchPeople(request, env, session, url, t) {
  const limit = await hit(env.DB, `clanPeople:u:${lower(session.user_id)}`, LIMITS.clanPeople, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const q = lower(String(url.searchParams.get('q') || '').trim().replace(/^@/, '')).replace(/[%_\\]/g, '').slice(0, 32);
  if (q.length < 2) return json({ people: [] });
  const res = await env.DB.prepare("SELECT p.user_id FROM public_profiles p LEFT JOIN profile_settings s ON s.user_id = p.user_id WHERE (p.username_key LIKE ? OR lower(p.name) LIKE ?) AND p.hidden = 0 AND (s.hidden IS NULL OR s.hidden = 0) ORDER BY p.level DESC LIMIT 12").bind(`${q}%`, `${q}%`).all();
  const ids = rowsOf(res).map((r) => lower(r.user_id)).filter((id) => id !== lower(session.user_id));
  const found = await people(env.DB, ids, t);
  const clans = new Map();
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    const rows = rowsOf(await env.DB.prepare(`SELECT m.user_id, d.tag FROM clan_members m JOIN clan_directory d ON d.id = m.clan_id WHERE m.user_id IN (${marks})`).bind(...ids).all());
    for (const r of rows) clans.set(lower(r.user_id), r.tag);
  }
  const out = [];
  for (const id of ids) {
    const p = found.get(id);
    if (!p || !p.username) continue;
    out.push({ name: p.name, username: p.username, level: p.level, clan: clans.get(id) || null });
    if (out.length >= 8) break;
  }
  return json({ people: out });
}

export async function clanManageRoute(request, env, session, route, url, t) {
  const method = request.method;
  const readOnly = method === 'GET' || method === 'HEAD';
  const me = lower(session.user_id);
  if (route.length === 2) {
    if (readOnly) return json(await myClanView(env.DB, me, t, { owner: isPartyOwner(env, me) }));
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (route.length === 3 && route[2] === 'actions') {
    if (method === 'POST') return postAction(request, env, session, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  if (route.length === 3 && route[2] === 'people') {
    if (readOnly) return searchPeople(request, env, session, url, t);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export async function browseClans(request, env, url, t) {
  const limit = await hit(env.DB, await ipKey('clans', clientIp(request)), LIMITS.clans, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const q = lower(String(url.searchParams.get('q') || '').trim().replace(/^\[|\]$/g, '')).replace(/[%_\\]/g, '').slice(0, 32);
  const page = whole(url.searchParams.get('page'), 0, 500);
  const open = url.searchParams.get('open') === '1';
  const where = [];
  const args = [];
  if (q) {
    where.push('(tag_key LIKE ? OR lower(name) LIKE ?)');
    args.push(`${q}%`, `%${q}%`);
  }
  if (open) where.push("join_mode = 'open'");
  const res = await env.DB
    .prepare(`SELECT id, tag, name, colour, banner, members, join_mode, created FROM clan_directory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY members DESC, tag_key ASC LIMIT ? OFFSET ?`)
    .bind(...args, CLAN_BROWSE_PAGE + 1, page * CLAN_BROWSE_PAGE)
    .all();
  const rows = rowsOf(res);
  return json({
    clans: rows.slice(0, CLAN_BROWSE_PAGE).map((r) => ({ tag: r.tag, name: r.name, colour: r.colour || null, banner: r.banner || null, members: whole(r.members, 0, 1e9), join: r.join_mode === 'invite' ? 'invite' : 'open', created: whole(r.created, 0, 1e15) || null })),
    page,
    more: rows.length > CLAN_BROWSE_PAGE,
  });
}

