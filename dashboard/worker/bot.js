import { SERVER_ID_RE, SLUG_RE, PART_LIMIT, HttpError, json, fail, readJson, isPlainObject, safeEqual, isLocalHost, byteLength, clipString, safeHttpsUrl } from './util.js';
import { expireJobs, claimJobs, isHot, DENIED } from './jobs.js';

const RESULTS_LIMIT = 2 * 1024 * 1024;
const SNAPSHOT_LIMIT = 4 * PART_LIMIT + 64 * 1024;
const PUBLIC_LIMIT = 3 * PART_LIMIT + 64 * 1024;
const MAX_RESULTS = 100;
const MAX_SERVERS = 1000;
const MAX_CASES = 2000;
const MAX_BOARD = 100;
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const LEVEL_RE = /^[a-z_]{1,16}$/;
const SNAPSHOT_PARTS = ['overview', 'apps', 'settings', 'cases'];
const GRANT_TYPES = new Set(['access', 'change', 'member']);

async function authorize(request, env, url) {
  if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) {
    return fail(403, 'https_required', 'The bot must connect over HTTPS.');
  }
  const secret = env.BOT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    return fail(503, 'not_configured', 'The bot connection is not set up on this dashboard yet.');
  }
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer ([^\s]{1,512})$/.exec(header);
  const ok = await safeEqual(match ? match[1] : '', secret);
  if (!match || !ok) return fail(401, 'unauthorized', 'The bot secret is wrong or missing.');
  return null;
}

function partText(name, value) {
  const text = JSON.stringify(value);
  if (byteLength(text) > PART_LIMIT) {
    throw new HttpError(413, 'too_large', `The ${name} part is bigger than 512 KB.`, { part: name });
  }
  return text;
}

function cleanServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, MAX_SERVERS)) {
    if (!isPlainObject(s) || typeof s.id !== 'string' || !SERVER_ID_RE.test(s.id)) continue;
    out.push({
      id: s.id,
      name: clipString(s.name, 100) || 'Server',
      icon_url: safeHttpsUrl(s.icon_url),
      member_count: Number.isFinite(s.member_count) ? s.member_count : null,
      level: typeof s.level === 'string' && LEVEL_RE.test(s.level) ? s.level : null,
    });
  }
  return out;
}

async function poll(env, t) {
  await expireJobs(env.DB, t);
  const jobs = await claimJobs(env.DB, t, 25);
  const hot = await isHot(env.DB, t);
  return json({ jobs, hot });
}

async function results(request, env, t) {
  const body = await readJson(request, RESULTS_LIMIT);
  if (!Array.isArray(body.results)) throw new HttpError(400, 'bad_results', '"results" must be a list.');
  if (body.results.length > MAX_RESULTS) throw new HttpError(413, 'too_many', `Send at most ${MAX_RESULTS} results at once.`);
  const db = env.DB;
  let stored = 0;
  const ignored = [];
  for (const r of body.results) {
    if (!isPlainObject(r) || typeof r.id !== 'string' || !JOB_ID_RE.test(r.id)) {
      ignored.push(isPlainObject(r) && typeof r.id === 'string' ? r.id.slice(0, 64) : null);
      continue;
    }
    const job = await db.prepare('SELECT id, type, user_id, server_id, status, error FROM jobs WHERE id = ?').bind(r.id).first();
    const open = job && (job.status === 'pending' || job.status === 'claimed' || (job.status === 'error' && job.error === 'timeout'));
    if (!open) {
      ignored.push(r.id);
      continue;
    }
    const ok = r.ok === true;
    const result = isPlainObject(r.result) ? r.result : null;
    let resultText = result ? JSON.stringify(result) : null;
    let error = typeof r.error === 'string' && r.error ? r.error.slice(0, 500) : null;
    let status = ok ? 'done' : 'error';
    if (resultText && byteLength(resultText) > PART_LIMIT) {
      resultText = null;
      status = 'error';
      error = 'YapOS sent an answer that was too big.';
    }
    if (status === 'error' && !error) error = 'YapOS could not finish that.';
    const stmts = [
      db
        .prepare("UPDATE jobs SET status = ?, result = ?, error = ?, updated = ? WHERE id = ? AND status IN ('pending', 'claimed', 'error')")
        .bind(status, resultText, error, t, job.id),
    ];
    if (status === 'done' && job.type === 'servers' && result) {
      const servers = cleanServers(result.servers);
      stmts.push(
        db
          .prepare('INSERT INTO user_servers (user_id, data, updated) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
          .bind(job.user_id, JSON.stringify({ servers }), t),
      );
    }
    if (job.server_id && GRANT_TYPES.has(job.type) && result) {
      if (result.grant === true && status === 'done') {
        const level = typeof result.level === 'string' && LEVEL_RE.test(result.level) && result.level !== DENIED ? result.level : null;
        stmts.push(
          db
            .prepare("INSERT INTO grants (user_id, server_id, level, confirmed_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, server_id) DO UPDATE SET level = COALESCE(?, NULLIF(grants.level, ?), 'admin'), confirmed_at = excluded.confirmed_at")
            .bind(job.user_id, job.server_id, level || 'admin', t, level, DENIED),
        );
      } else if (result.grant === false) {
        stmts.push(
          db
            .prepare('INSERT INTO grants (user_id, server_id, level, confirmed_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, server_id) DO UPDATE SET level = excluded.level, confirmed_at = excluded.confirmed_at')
            .bind(job.user_id, job.server_id, DENIED, t),
        );
      }
    }
    if (status === 'done' && job.type === 'change' && job.server_id && result && isPlainObject(result.snapshot)) {
      for (const part of ['apps', 'settings']) {
        if (!(part in result.snapshot)) continue;
        const text = JSON.stringify(result.snapshot[part]);
        if (byteLength(text) > PART_LIMIT) continue;
        stmts.push(
          db
            .prepare('INSERT INTO snapshots (server_id, part, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (server_id, part) DO UPDATE SET data = excluded.data, updated = excluded.updated')
            .bind(job.server_id, part, text, t),
        );
      }
    }
    await db.batch(stmts);
    stored += 1;
  }
  return json({ ok: true, stored, ignored });
}

async function putSnapshot(request, env, sid, t) {
  const body = await readJson(request, SNAPSHOT_LIMIT);
  const rows = [];
  for (const part of SNAPSHOT_PARTS) {
    if (!(part in body) || body[part] === undefined) continue;
    const value = body[part];
    if ((part === 'overview' || part === 'settings') && !isPlainObject(value)) {
      throw new HttpError(400, 'bad_part', `The ${part} part must be an object.`);
    }
    if ((part === 'apps' || part === 'cases') && !Array.isArray(value)) {
      throw new HttpError(400, 'bad_part', `The ${part} part must be a list.`);
    }
    if (part === 'cases' && value.length > MAX_CASES) {
      throw new HttpError(413, 'too_large', `Send at most ${MAX_CASES} cases.`, { part });
    }
    rows.push([part, partText(part, value)]);
  }
  if (!rows.length) throw new HttpError(400, 'empty', 'The snapshot has no parts.');
  const updated = Number.isFinite(body.updatedAt) && body.updatedAt > 0 && body.updatedAt <= t + 60000 ? Math.floor(body.updatedAt) : t;
  await env.DB.batch(
    rows.map(([part, text]) =>
      env.DB
        .prepare('INSERT INTO snapshots (server_id, part, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (server_id, part) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(sid, part, text, updated),
    ),
  );
  return json({ ok: true, parts: rows.map((r) => r[0]), updatedAt: updated });
}

function isUniqueError(err) {
  return /UNIQUE|constraint/i.test(String(err && err.message));
}

async function putPublic(request, env, sid, t) {
  const body = await readJson(request, PUBLIC_LIMIT);
  if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'bad_enabled', '"enabled" must be true or false.');
  if (typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) {
    throw new HttpError(400, 'bad_slug', 'The link name must be 3 to 32 characters: lowercase letters, numbers and dashes.');
  }
  for (const part of ['levels', 'economy']) {
    if (body[part] !== undefined && body[part] !== null && !Array.isArray(body[part])) {
      throw new HttpError(400, 'bad_part', `The ${part} part must be a list.`);
    }
  }
  if (body.wrapped !== undefined && body.wrapped !== null && !isPlainObject(body.wrapped)) {
    throw new HttpError(400, 'bad_part', 'The wrapped part must be an object.');
  }
  const levels = Array.isArray(body.levels) ? body.levels.slice(0, MAX_BOARD) : [];
  const economy = Array.isArray(body.economy) ? body.economy.slice(0, MAX_BOARD) : [];
  const wrapped = body.wrapped ?? null;
  partText('levels', levels);
  partText('economy', economy);
  partText('wrapped', wrapped);
  const updatedAt = Number.isFinite(body.updatedAt) ? body.updatedAt : t;
  const data = {
    enabled: body.enabled,
    slug: body.slug,
    name: clipString(body.name, 100) || 'Server',
    icon: safeHttpsUrl(body.icon),
    levels,
    economy,
    wrapped,
    updatedAt,
  };
  const taken = await env.DB.prepare('SELECT server_id FROM public_pages WHERE slug = ? AND server_id != ?').bind(body.slug, sid).first();
  if (taken) return fail(409, 'slug_taken', 'That link name is already used by another server.');
  try {
    await env.DB
      .prepare('INSERT INTO public_pages (server_id, slug, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (server_id) DO UPDATE SET slug = excluded.slug, data = excluded.data, updated = excluded.updated')
      .bind(sid, body.slug, JSON.stringify(data), t)
      .run();
  } catch (err) {
    if (isUniqueError(err)) return fail(409, 'slug_taken', 'That link name is already used by another server.');
    throw err;
  }
  return json({ ok: true, slug: body.slug, enabled: body.enabled });
}

async function deletePublic(env, sid) {
  const res = await env.DB.prepare('DELETE FROM public_pages WHERE server_id = ?').bind(sid).run();
  return json({ ok: true, removed: Boolean(res && res.meta && res.meta.changes) });
}

export async function handleBot(request, env, deps, url) {
  const denied = await authorize(request, env, url);
  if (denied) return denied;
  const t = deps.now();
  const segs = url.pathname.split('/').filter(Boolean);
  const method = request.method;
  if (segs.length === 2 && segs[1] === 'poll' && method === 'GET') return poll(env, t);
  if (segs.length === 2 && segs[1] === 'results' && method === 'POST') return results(request, env, t);
  if (segs.length === 3 && (segs[1] === 'snapshot' || segs[1] === 'public')) {
    const sid = segs[2];
    if (!SERVER_ID_RE.test(sid)) return fail(400, 'bad_id', "That server id doesn't look right.");
    if (segs[1] === 'snapshot' && method === 'PUT') return putSnapshot(request, env, sid, t);
    if (segs[1] === 'public' && method === 'PUT') return putPublic(request, env, sid, t);
    if (segs[1] === 'public' && method === 'DELETE') return deletePublic(env, sid);
    return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  }
  return fail(404, 'not_found', 'Unknown bot endpoint.');
}
