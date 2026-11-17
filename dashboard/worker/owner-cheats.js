import { USER_BODY_LIMIT, ID_RE, HttpError, json, fail, readJson, isPlainObject, randomToken } from './util.js';
import { partyActionPlan, partyActionDone } from './owner-party.js';
import { logModAction, actorName } from './party-mod.js';
import { CHEAT_KINDS, CHEAT_LIST_MAX, ALERT_COLUMNS } from './party-cheats.js';

const STATUSES = new Set(['open', 'dismissed', 'actioned', 'all']);
const ACTS = new Set(['dismiss', 'hide', 'reset', 'reopen']);

function rows(res) {
  return (res && res.results) || [];
}

function bad(code, message) {
  return new HttpError(400, code, message);
}

function alertOut(r) {
  return {
    id: r.id,
    user: r.user_id,
    kind: r.kind,
    label: CHEAT_KINDS[r.kind] || r.kind,
    name: r.name || null,
    detail: r.detail,
    first_at: Number(r.first_at),
    last_at: Number(r.last_at),
    count: Number(r.count) || 1,
    status: r.status,
    handled_by: r.handled_by || null,
    handled_at: r.handled_at === null || r.handled_at === undefined ? null : Number(r.handled_at),
  };
}

async function listAlerts(env, url) {
  const raw = url.searchParams.get('status') || 'open';
  const status = STATUSES.has(raw) ? raw : 'open';
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const binds = status === 'all' ? [] : [status];
  const [res, open] = await Promise.all([
    env.DB.prepare(`SELECT ${ALERT_COLUMNS} FROM party_cheat_alerts ${where} ORDER BY last_at DESC, id ASC LIMIT ?`).bind(...binds, CHEAT_LIST_MAX).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM party_cheat_alerts WHERE status = 'open'").first(),
  ]);
  return json({ alerts: rows(res).map(alertOut), open: Number(open && open.n) || 0, status, kinds: CHEAT_KINDS });
}

async function actOnAlert(request, env, session, raw, t) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That alert id doesn't look right.");
  const body = await readJson(request, USER_BODY_LIMIT);
  if (!isPlainObject(body)) throw bad('bad_request', 'Say what to do with the alert.');
  for (const k of Object.keys(body)) if (k !== 'do') throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  if (typeof body.do !== 'string' || !ACTS.has(body.do)) throw bad('bad_action', 'Pick dismiss, hide, reset or reopen.');
  const db = env.DB;
  const row = await db.prepare(`SELECT ${ALERT_COLUMNS} FROM party_cheat_alerts WHERE id = ?`).bind(raw).first();
  if (!row) return fail(404, 'not_found', 'That alert is gone.');
  const actorId = String(session.user_id).toLowerCase();
  const user = String(row.user_id);
  const stmts = [];
  let result = null;
  if (body.do === 'hide' || body.do === 'reset') {
    const a = { user, kind: body.do === 'hide' ? 'party.board.hide' : 'party.reset', value: body.do === 'hide' ? null : { badges: false }, ref: null, note: `Cheat alert: ${CHEAT_KINDS[row.kind] || row.kind}`, notify: false };
    const plan = await partyActionPlan(db, a, session.user_id, t);
    result = plan.result;
    stmts.push(
      db.prepare("INSERT INTO owner_actions (id, user_id, kind, value, ref, note, notify, created, status, sent_at, result, updated) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, 'done', NULL, ?, ?)")
        .bind(randomToken(12), user, a.kind, a.value === null ? null : JSON.stringify(a.value), a.note, t, result, t),
      ...plan.stmts,
    );
  }
  const status = body.do === 'dismiss' ? 'dismissed' : body.do === 'reopen' ? 'open' : 'actioned';
  stmts.push(
    status === 'open'
      ? db.prepare("UPDATE party_cheat_alerts SET status = 'open', handled_by = NULL, handled_at = NULL WHERE id = ?").bind(raw)
      : db.prepare('UPDATE party_cheat_alerts SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?').bind(status, actorId, t, raw),
    logModAction(db, { actorId, actorName: actorName(session), action: `owner_cheat_${body.do}`, targetId: user, targetName: row.name, detail: { kind: row.kind, summary: row.detail }, t }),
  );
  await db.batch(stmts);
  if (body.do === 'hide' || body.do === 'reset') partyActionDone(db);
  const after = await db.prepare(`SELECT ${ALERT_COLUMNS} FROM party_cheat_alerts WHERE id = ?`).bind(raw).first();
  return json({ alert: alertOut(after), result });
}

export async function cheatsRoute(request, env, session, route, url, t) {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  if (route.length === 2) return read ? listAlerts(env, url) : fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route.length === 3) return method === 'POST' ? actOnAlert(request, env, session, route[2], t) : fail(405, 'method_not_allowed', 'That action is not allowed here.');
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
