import { MINUTE, ID_RE, SERVER_ID_RE, APP_RE, SLUG_RE, SETTING_KEY_RE, USER_BODY_LIMIT, HttpError, json, fail, redirect, readJson, isPlainObject, parseJsonSafe, publicOrigin, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { getSession, touchSession, publicUser } from './sessions.js';
import { profileRoute } from './profiles.js';
import { activityAdminsRoute, partyRoute, isPartyOwner } from './party.js';
import { enqueue, freshGrant, recentDenial, expireJobs, JOB_TIMEOUT, SERVER_JOB_TYPES } from './jobs.js';

const SERVERS_TTL = 2 * MINUTE;
const GLOBAL_SLUG = 'global';
const DEFAULT_CURRENCY = { name: 'Shards', emoji: '💎' };
const CASES_PAGE_SIZE = 50;
const MAX_SETTINGS = 100;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TIMEOUT_MESSAGE = "YapOS hasn't answered yet. It may be offline or restarting.";
const NO_ACCESS_MESSAGE = 'You need to be an admin of this server.';
const MAX_LIST_PAGE = 100;
const MAX_NUMBER = 1e9;
const MEMBER_SORTS = new Set(['joined_new', 'joined_old', 'name']);
const TICKET_STATUSES = new Set(['open', 'closed', 'all']);
const MOD_ACTIONS = new Set(['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'unwarn', 'role_add', 'role_remove', 'nick', 'note']);
const TICKET_ACTIONS = new Set(['claim', 'unclaim', 'close']);
const MOD_TEXT_FIELDS = { reason: 500, duration: 20, nickname: 32, note: 500 };
const MOD_FIELDS = new Set(['action', 'role_id', 'case', ...Object.keys(MOD_TEXT_FIELDS)]);
const TICKET_FIELDS = new Set(['action', 'reason']);

export function csrfOk(request, env) {
  const origin = request.headers.get('Origin');
  const expected = publicOrigin(env);
  return Boolean(origin && expected && origin === expected && request.headers.get('X-YapOS') === '1');
}

function pending(job, extra) {
  return json({ pending: true, job, ...(extra || {}) }, 202);
}

function checkId(value, what, re = ID_RE) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new HttpError(400, 'bad_id', `That ${what} id doesn't look right.`);
  }
  return value;
}

function noAccess() {
  return fail(403, 'no_access', `${NO_ACCESS_MESSAGE} If that changed just now, try again in a few minutes.`, { result: { grant: false } });
}

async function requireGrant(env, session, sid, t) {
  const grant = await freshGrant(env.DB, session.user_id, sid, t);
  if (grant) return { grant };
  if (await recentDenial(env.DB, session.user_id, sid, t)) return { response: noAccess() };
  const job = await enqueue(env.DB, { type: 'access', userId: session.user_id, serverId: sid }, t);
  return {
    response: fail(403, 'grant_required', 'Checking your access to this server again. Try once more in a few seconds.', { job }),
  };
}

async function snapshotParts(db, sid, parts) {
  const marks = parts.map(() => '?').join(', ');
  const res = await db
    .prepare(`SELECT part, data, updated FROM snapshots WHERE server_id = ? AND part IN (${marks})`)
    .bind(sid, ...parts)
    .all();
  const out = {};
  let updatedAt = 0;
  for (const row of (res && res.results) || []) {
    out[row.part] = parseJsonSafe(row.data, null);
    updatedAt = Math.max(updatedAt, Number(row.updated) || 0);
  }
  return { parts: out, updatedAt: updatedAt || null };
}

async function getServers(env, session, t) {
  const row = await env.DB
    .prepare('SELECT data, updated FROM user_servers WHERE user_id = ? AND updated >= ?')
    .bind(session.user_id, t - SERVERS_TTL)
    .first();
  if (row) {
    const data = parseJsonSafe(row.data, {});
    return json({ servers: Array.isArray(data.servers) ? data.servers : [], updatedAt: Number(row.updated) });
  }
  const job = await enqueue(env.DB, { type: 'servers', userId: session.user_id }, t);
  return pending(job);
}

async function getJob(env, session, jobId, t) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(jobId)) {
    return fail(404, 'not_found', 'That request was not found.');
  }
  const job = await env.DB
    .prepare('SELECT id, type, user_id, server_id, status, result, error, created FROM jobs WHERE id = ? AND user_id = ?')
    .bind(jobId, session.user_id)
    .first();
  if (!job) return fail(404, 'not_found', 'That request was not found.');
  let status = job.status;
  let error = job.error;
  if ((status === 'pending' || status === 'claimed') && Number(job.created) + JOB_TIMEOUT < t) {
    await expireJobs(env.DB, t);
    status = 'error';
    error = 'timeout';
  }
  if (status === 'pending' || status === 'claimed') return json({ status: 'pending' });
  const result = parseJsonSafe(job.result, null);
  if (status === 'error') {
    if (error === 'timeout') return json({ status: 'error', error: 'timeout', message: TIMEOUT_MESSAGE });
    const message = typeof error === 'string' && error ? error : 'YapOS could not finish that.';
    const body = { status: 'error', error: message, message };
    if (result && result.grant === false) body.result = { grant: false, level: result.level ?? null };
    return json(body);
  }
  if (result && result.grant === false) {
    const message = typeof error === 'string' && error ? error : NO_ACCESS_MESSAGE;
    return json({ status: 'error', error: message, message, result: { grant: false, level: result.level ?? null } });
  }
  if (job.server_id && SERVER_JOB_TYPES.has(job.type)) {
    const grant = await freshGrant(env.DB, session.user_id, job.server_id, t);
    if (!grant) return fail(403, 'grant_required', 'Your access to this server needs checking again. Open the server page to refresh it.');
  }
  return json({ status: 'done', result });
}

async function getServer(env, session, sid, t) {
  const grant = await freshGrant(env.DB, session.user_id, sid, t);
  if (!grant) {
    if (await recentDenial(env.DB, session.user_id, sid, t)) return noAccess();
    const job = await enqueue(env.DB, { type: 'access', userId: session.user_id, serverId: sid }, t);
    return pending(job);
  }
  const { parts, updatedAt } = await snapshotParts(env.DB, sid, ['overview', 'apps', 'settings']);
  if (!parts.overview && !parts.apps && !parts.settings) {
    const job = await enqueue(env.DB, { type: 'access', userId: session.user_id, serverId: sid }, t);
    return pending(job);
  }
  return json({
    overview: parts.overview ?? null,
    apps: parts.apps ?? null,
    settings: parts.settings ?? null,
    updatedAt,
    level: grant.level,
  });
}

function matches(text, q) {
  return typeof text === 'string' && text.toLowerCase().includes(q);
}

async function getCases(env, session, sid, url, t) {
  const g = await requireGrant(env, session, sid, t);
  if (g.response) return g.response;
  const params = url.searchParams;
  const q = (params.get('q') || '').trim().toLowerCase().slice(0, 100);
  const user = (params.get('user') || '').trim();
  const type = (params.get('type') || '').trim().toLowerCase().slice(0, 32);
  if (user && !ID_RE.test(user)) return fail(400, 'bad_id', "That member id doesn't look right.");
  const pageRaw = Number.parseInt(params.get('page') || '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.min(Math.max(pageRaw, 1), 1000) : 1;
  const { parts, updatedAt } = await snapshotParts(env.DB, sid, ['cases']);
  let list = Array.isArray(parts.cases) ? parts.cases : [];
  list = list.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    if (user && !((c.user && c.user.id === user) || (c.mod && c.mod.id === user))) return false;
    if (type && String(c.type || '').toLowerCase() !== type) return false;
    if (q) {
      const num = q.replace(/^#/, '');
      return (
        String(c.n) === num ||
        matches(c.type, q) ||
        matches(c.reason, q) ||
        (c.user && (matches(c.user.name, q) || c.user.id === q)) ||
        (c.mod && (matches(c.mod.name, q) || c.mod.id === q))
      );
    }
    return true;
  });
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / CASES_PAGE_SIZE));
  const start = (page - 1) * CASES_PAGE_SIZE;
  return json({ cases: list.slice(start, start + CASES_PAGE_SIZE), total, page, pages, pageSize: CASES_PAGE_SIZE, updatedAt });
}

async function getMember(env, session, sid, uid, t) {
  checkId(uid, 'member');
  const g = await requireGrant(env, session, sid, t);
  if (g.response) return g.response;
  const job = await enqueue(env.DB, { type: 'member', userId: session.user_id, serverId: sid, data: { user_id: uid } }, t);
  return pending(job);
}

function badRequest(message) {
  return new HttpError(400, 'bad_request', message);
}

function queryText(params, name, max) {
  return (params.get(name) || '').trim().slice(0, max);
}

function queryPage(params) {
  const raw = (params.get('page') || '').trim();
  if (!raw) return 1;
  const page = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : 0;
  if (page < 1 || page > MAX_LIST_PAGE) throw badRequest(`The page must be a number from 1 to ${MAX_LIST_PAGE}.`);
  return page;
}

function checkTicketNumber(value) {
  const number = typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? Number(value) : 0;
  if (number < 1 || number > MAX_NUMBER) throw new HttpError(400, 'bad_id', "That ticket number doesn't look right.");
  return number;
}

function checkFields(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw badRequest(`Unknown field "${k.slice(0, 40)}".`);
  }
}

function optionalText(body, key, max) {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`The ${key} must be text.`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`The ${key} can be at most ${max} characters.`);
  return text;
}

function validateModAction(body) {
  checkFields(body, MOD_FIELDS);
  if (typeof body.action !== 'string' || !MOD_ACTIONS.has(body.action)) throw badRequest("That action isn't one YapOS knows.");
  const data = { action: body.action };
  for (const [key, max] of Object.entries(MOD_TEXT_FIELDS)) {
    const text = optionalText(body, key, max);
    if (text !== undefined) data[key] = text;
  }
  if (body.role_id !== undefined && body.role_id !== null) {
    if (typeof body.role_id !== 'string' || !ID_RE.test(body.role_id)) throw new HttpError(400, 'bad_id', "That role id doesn't look right.");
    data.role_id = body.role_id;
  }
  if (body.case !== undefined && body.case !== null) {
    if (!Number.isInteger(body.case) || body.case < 1 || body.case > MAX_NUMBER) throw badRequest('The case must be a case number.');
    data.case = body.case;
  }
  const action = data.action;
  if (action === 'timeout' && !data.duration) throw badRequest('Pick how long the timeout lasts.');
  if (action === 'unwarn' && data.case === undefined) throw badRequest('Pick which warning to remove.');
  if ((action === 'role_add' || action === 'role_remove') && !data.role_id) throw badRequest('Pick a role.');
  if (action === 'nick' && data.nickname === undefined) throw badRequest('Type a nickname, or leave it empty to clear it.');
  if (action === 'note' && !data.note) throw badRequest('Type the note first.');
  return data;
}

function validateTicketAction(body) {
  checkFields(body, TICKET_FIELDS);
  if (typeof body.action !== 'string' || !TICKET_ACTIONS.has(body.action)) throw badRequest("That ticket action isn't one YapOS knows.");
  const data = { action: body.action };
  const reason = optionalText(body, 'reason', 500);
  if (reason !== undefined) data.reason = reason;
  return data;
}

async function enqueueFor(env, session, sid, type, data, t) {
  const g = await requireGrant(env, session, sid, t);
  if (g.response) return g.response;
  const job = await enqueue(env.DB, { type, userId: session.user_id, serverId: sid, data }, t);
  return pending(job);
}

async function getMembers(env, session, sid, url, t) {
  const params = url.searchParams;
  const data = {};
  const q = queryText(params, 'q', 100);
  if (q) data.q = q;
  const role = (params.get('role') || '').trim();
  if (role) data.role = checkId(role, 'role');
  const sort = (params.get('sort') || '').trim() || 'joined_new';
  if (!MEMBER_SORTS.has(sort)) throw badRequest('Sort by newest, oldest or name.');
  data.sort = sort;
  data.page = queryPage(params);
  return enqueueFor(env, session, sid, 'members', data, t);
}

async function postMemberAction(request, env, session, sid, uid, t) {
  checkId(uid, 'member');
  const body = await readJson(request, USER_BODY_LIMIT);
  const data = { user_id: uid, ...validateModAction(body) };
  return enqueueFor(env, session, sid, 'modaction', data, t);
}

async function getTickets(env, session, sid, url, t) {
  const params = url.searchParams;
  const status = (params.get('status') || '').trim() || 'open';
  if (!TICKET_STATUSES.has(status)) throw badRequest('Show open, closed or all tickets.');
  const data = { status };
  const q = queryText(params, 'q', 100);
  if (q) data.q = q;
  data.page = queryPage(params);
  return enqueueFor(env, session, sid, 'tickets', data, t);
}

async function getTicket(env, session, sid, raw, t) {
  const number = checkTicketNumber(raw);
  return enqueueFor(env, session, sid, 'ticket', { number }, t);
}

async function postTicketAction(request, env, session, sid, raw, t) {
  const number = checkTicketNumber(raw);
  const body = await readJson(request, USER_BODY_LIMIT);
  const data = { number, ...validateTicketAction(body) };
  return enqueueFor(env, session, sid, 'ticketaction', data, t);
}

function validateAppChange(body, app) {
  if (!APP_RE.test(app)) throw new HttpError(400, 'bad_app', "That app name doesn't look right.");
  for (const k of Object.keys(body)) {
    if (k !== 'enabled' && k !== 'settings') throw new HttpError(400, 'bad_field', `Unknown field "${k.slice(0, 40)}".`);
  }
  const data = { app };
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled', '"enabled" must be true or false.');
    data.enabled = body.enabled;
  }
  if ('settings' in body) {
    if (!isPlainObject(body.settings)) throw new HttpError(400, 'bad_settings', '"settings" must be an object of key: value pairs.');
    const keys = Object.keys(body.settings);
    if (keys.length > MAX_SETTINGS) throw new HttpError(400, 'too_many', `Change at most ${MAX_SETTINGS} settings at once.`);
    const settings = {};
    for (const key of keys) {
      if (!SETTING_KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) {
        throw new HttpError(400, 'bad_key', `"${key.slice(0, 40)}" is not a setting name.`);
      }
      const value = body.settings[key];
      if (value === undefined) continue;
      settings[key] = value;
    }
    data.settings = settings;
  }
  if (!('enabled' in data) && !(data.settings && Object.keys(data.settings).length)) {
    throw new HttpError(400, 'empty', 'There is nothing to change.');
  }
  return data;
}

async function patchApp(request, env, session, sid, app, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  const data = validateAppChange(body, app);
  const g = await requireGrant(env, session, sid, t);
  if (g.response) return g.response;
  const job = await enqueue(env.DB, { type: 'change', userId: session.user_id, serverId: sid, data }, t);
  return pending(job);
}

async function patchPublic(request, env, session, sid, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  for (const k of Object.keys(body)) {
    if (k !== 'enabled' && k !== 'slug') throw new HttpError(400, 'bad_field', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled', '"enabled" must be true or false.');
  const publicPage = { enabled: body.enabled };
  if (body.slug !== undefined && body.slug !== null) {
    if (typeof body.slug !== 'string') throw new HttpError(400, 'bad_slug', 'The link name must be text.');
    const slug = body.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new HttpError(400, 'bad_slug', 'The link name must be 3 to 32 characters: lowercase letters, numbers and dashes.');
    }
    publicPage.slug = slug;
  }
  const g = await requireGrant(env, session, sid, t);
  if (g.response) return g.response;
  if (publicPage.slug) {
    const taken = await env.DB.prepare('SELECT server_id FROM public_pages WHERE slug = ? AND server_id != ?').bind(publicPage.slug, sid).first();
    if (taken) return fail(409, 'slug_taken', 'That link name is already used by another server. Pick a different one.');
  }
  const job = await enqueue(env.DB, { type: 'change', userId: session.user_id, serverId: sid, data: { app: 'system', settings: { publicPage } } }, t);
  return pending(job);
}

async function getPublic(request, env, slug, t) {
  const limit = await hit(env.DB, await ipKey('public', clientIp(request)), LIMITS.public, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  if (slug !== GLOBAL_SLUG) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return fail(404, 'not_found', "That page doesn't exist.", null, { 'Cache-Control': 'public, max-age=60' });
    }
    return redirect(`/api/public/${GLOBAL_SLUG}`, 308);
  }
  const row = await env.DB.prepare('SELECT data, updated FROM global_board WHERE id = ?').bind(GLOBAL_SLUG).first();
  const data = (row && parseJsonSafe(row.data, null)) || null;
  const currency = isPlainObject(data && data.currency) ? data.currency : DEFAULT_CURRENCY;
  return json(
    {
      slug: GLOBAL_SLUG,
      global: true,
      currency: { name: currency.name || DEFAULT_CURRENCY.name, emoji: currency.emoji || DEFAULT_CURRENCY.emoji },
      levels: Array.isArray(data && data.levels) ? data.levels : [],
      economy: Array.isArray(data && data.economy) ? data.economy : [],
      updatedAt: (data && Number(data.updatedAt)) || (row && Number(row.updated)) || null,
    },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
}

export async function handleApi(request, env, deps, url) {
  const t = deps.now();
  const method = request.method;
  const segs = url.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '\u0000';
    }
  });
  const mutating = MUTATING.has(method);
  const readOnly = method === 'GET' || method === 'HEAD';

  if (segs[1] === 'activity') {
    if (segs.length === 3 && segs[2] === 'admins') return activityAdminsRoute(request, env, url, t);
    return profileRoute(request, env, segs, url, t);
  }

  if (segs[1] === 'public') {
    if (!readOnly) return fail(405, 'method_not_allowed', 'That action is not allowed here.');
    if (segs.length !== 3) return fail(404, 'not_found', "This page isn't public or doesn't exist.");
    return getPublic(request, env, segs[2], t);
  }

  if (!readOnly && !mutating) return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (mutating && !csrfOk(request, env)) {
    return fail(403, 'forbidden', 'This request was blocked for your safety. Reload the page and try again.');
  }

  const session = await getSession(env.DB, request, t);
  if (!session) return fail(401, 'signed_out', 'Please sign in again.');

  const sessionKey = session.id_hash.slice(0, 32);
  const apiLimit = await hit(env.DB, `api:s:${sessionKey}`, LIMITS.api, t);
  if (!apiLimit.ok) return tooMany(apiLimit.retryAfter);
  const userApiLimit = await hit(env.DB, `api:u:${session.user_id}`, LIMITS.userApi, t);
  if (!userApiLimit.ok) return tooMany(userApiLimit.retryAfter);
  if (mutating) {
    const changeLimit = await hit(env.DB, `chg:s:${sessionKey}`, LIMITS.change, t);
    if (!changeLimit.ok) return tooMany(changeLimit.retryAfter, 'That is a lot of changes at once. Wait a minute and try again.');
    const userChangeLimit = await hit(env.DB, `chg:u:${session.user_id}`, LIMITS.userChange, t);
    if (!userChangeLimit.ok) return tooMany(userChangeLimit.retryAfter, 'That is a lot of changes at once. Wait a minute and try again.');
  }
  await touchSession(env.DB, session, t);

  const route = segs.slice(1);
  const n = route.length;

  if (n === 1 && route[0] === 'me' && readOnly) return json({ user: publicUser(session), partyOwner: isPartyOwner(env, session.user_id) });
  if (route[0] === 'party') return partyRoute(request, env, session, route, t);
  if (n === 1 && route[0] === 'servers' && readOnly) return getServers(env, session, t);
  if (n === 2 && route[0] === 'jobs' && readOnly) return getJob(env, session, route[1], t);

  if (route[0] === 'servers' && n >= 2) {
    const sid = checkId(route[1], 'server', SERVER_ID_RE);
    if (n === 2 && readOnly) return getServer(env, session, sid, t);
    if (n === 3 && route[2] === 'cases' && readOnly) return getCases(env, session, sid, url, t);
    if (n === 3 && route[2] === 'members' && readOnly) return getMembers(env, session, sid, url, t);
    if (n === 4 && route[2] === 'members' && readOnly) return getMember(env, session, sid, route[3], t);
    if (n === 5 && route[2] === 'members' && route[4] === 'actions' && method === 'POST') return postMemberAction(request, env, session, sid, route[3], t);
    if (n === 3 && route[2] === 'tickets' && readOnly) return getTickets(env, session, sid, url, t);
    if (n === 4 && route[2] === 'tickets' && readOnly) return getTicket(env, session, sid, route[3], t);
    if (n === 5 && route[2] === 'tickets' && route[4] === 'actions' && method === 'POST') return postTicketAction(request, env, session, sid, route[3], t);
    if (n === 4 && route[2] === 'apps' && method === 'PATCH') return patchApp(request, env, session, sid, route[3], t);
    if (n === 3 && route[2] === 'public' && method === 'PATCH') return patchPublic(request, env, session, sid, t);
  }

  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
