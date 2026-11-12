import { MINUTE, ID_RE, SERVER_ID_RE, APP_RE, SLUG_RE, SETTING_KEY_RE, USER_BODY_LIMIT, HttpError, json, fail, readJson, isPlainObject, parseJsonSafe, publicOrigin, clientIp } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { PUBLIC_STALE } from './cron.js';
import { getSession, touchSession, publicUser } from './sessions.js';
import { enqueue, freshGrant, recentDenial, expireJobs, JOB_TIMEOUT } from './jobs.js';

const SERVERS_TTL = 2 * MINUTE;
const CASES_PAGE_SIZE = 50;
const MAX_SETTINGS = 100;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TIMEOUT_MESSAGE = "YapOS hasn't answered yet. It may be offline or restarting.";
const NO_ACCESS_MESSAGE = 'You need to be an admin of this server.';

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
  if (job.server_id && (job.type === 'change' || job.type === 'member')) {
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
  const notFound = () => fail(404, 'not_found', "This page isn't public or doesn't exist.", null, { 'Cache-Control': 'public, max-age=60' });
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return notFound();
  const row = await env.DB.prepare('SELECT data, updated FROM public_pages WHERE slug = ?').bind(slug).first();
  if (!row || !(Number(row.updated) >= t - PUBLIC_STALE)) return notFound();
  const data = parseJsonSafe(row.data, null);
  if (!data || data.enabled !== true) return notFound();
  return json(
    {
      slug,
      name: typeof data.name === 'string' ? data.name : null,
      icon: typeof data.icon === 'string' ? data.icon : null,
      levels: Array.isArray(data.levels) ? data.levels : [],
      economy: Array.isArray(data.economy) ? data.economy : [],
      wrapped: data.wrapped ?? null,
      updatedAt: Number(data.updatedAt) || Number(row.updated) || null,
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

  if (n === 1 && route[0] === 'me' && readOnly) return json({ user: publicUser(session) });
  if (n === 1 && route[0] === 'servers' && readOnly) return getServers(env, session, t);
  if (n === 2 && route[0] === 'jobs' && readOnly) return getJob(env, session, route[1], t);

  if (route[0] === 'servers' && n >= 2) {
    const sid = checkId(route[1], 'server', SERVER_ID_RE);
    if (n === 2 && readOnly) return getServer(env, session, sid, t);
    if (n === 3 && route[2] === 'cases' && readOnly) return getCases(env, session, sid, url, t);
    if (n === 4 && route[2] === 'members' && readOnly) return getMember(env, session, sid, route[3], t);
    if (n === 4 && route[2] === 'apps' && method === 'PATCH') return patchApp(request, env, session, sid, route[3], t);
    if (n === 3 && route[2] === 'public' && method === 'PATCH') return patchPublic(request, env, session, sid, t);
  }

  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
