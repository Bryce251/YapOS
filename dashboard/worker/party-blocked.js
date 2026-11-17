import { USER_BODY_LIMIT, ID_RE, HttpError, json, fail, readJson, isPlainObject, randomToken, sha256Hex } from './util.js';
import { cleanText } from './profiles.js';
import { partyRole } from './reports.js';
import { logModAction, actorName } from './party-mod.js';
import { customKey, encodeTerm, isBlockedWord, CUSTOM_MAX, CUSTOM_CHARS } from '../web/activity/js/filter.js';

export const BLOCKED_MAX = CUSTOM_MAX;
export const BLOCKED_CHARS = CUSTOM_CHARS;
export const BLOCKED_TTL = 60_000;

const STAFF_ONLY = 'Only the owner of YapOS Party and party admins can change blocked words.';
const FIELDS = new Set(['word']);
const cache = new WeakMap();

function bad(code, message) {
  return new HttpError(400, code, message);
}

export function clearBlockedCache(db) {
  if (db) cache.delete(db);
}

export function cleanBlockedWord(value) {
  if (typeof value !== 'string' || !value.trim()) throw bad('bad_word', 'Type a word or phrase to block first.');
  const word = cleanText(value, BLOCKED_CHARS + 1);
  if (!word) throw bad('bad_word', 'Type a word or phrase to block first.');
  if (Array.from(word).length > BLOCKED_CHARS) throw bad('too_long', `Keep blocked words under ${BLOCKED_CHARS} characters.`);
  const key = customKey(word);
  if (key.replace(/ /g, '').length < 2) throw bad('bad_word', 'Blocked words need at least two letters.');
  return { word, key };
}

async function readKeys(db) {
  const res = await db.prepare('SELECT key FROM party_blocked_words ORDER BY created ASC, id ASC LIMIT ?').bind(BLOCKED_MAX).all();
  return ((res && res.results) || []).map((r) => String(r.key));
}

export async function getBlockedPublic(request, env, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  let entry = cache.get(env.DB);
  if (!entry || entry.at + BLOCKED_TTL < t || entry.at > t) {
    const keys = await readKeys(env.DB);
    const v = keys.length ? (await sha256Hex(keys.join('\n'))).slice(0, 16) : 'none';
    entry = { at: t, body: { v, n: keys.length, t: keys.map(encodeTerm) } };
    cache.set(env.DB, entry);
  }
  return json(entry.body, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function listWords(env, role, extra = {}, status = 200) {
  const res = await env.DB.prepare('SELECT id, word, added_by, added_name, created FROM party_blocked_words ORDER BY created DESC, id ASC LIMIT ?').bind(BLOCKED_MAX).all();
  const words = ((res && res.results) || []).map((r) => ({ id: r.id, word: r.word, added_by: r.added_by, added_name: r.added_name || null, created: Number(r.created) }));
  return json({ words, count: words.length, max: BLOCKED_MAX, chars: BLOCKED_CHARS, role, ...extra }, status);
}

async function addWord(request, env, session, role, t) {
  const body = await readJson(request, USER_BODY_LIMIT);
  if (!isPlainObject(body)) throw bad('bad_request', 'Send the word as an object.');
  for (const k of Object.keys(body)) {
    if (!FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  const { word, key } = cleanBlockedWord(body.word);
  if (isBlockedWord(word)) return fail(409, 'built_in', 'The built-in filter already blocks that.');
  const same = await env.DB.prepare('SELECT id, word FROM party_blocked_words WHERE key = ?').bind(key).first();
  if (same) return fail(409, 'exists', `That's already blocked as "${same.word}".`);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_blocked_words').first();
  if (Number(count && count.n) >= BLOCKED_MAX) return fail(409, 'too_many', `You can block up to ${BLOCKED_MAX} words. Remove one first.`);
  const actorId = String(session.user_id).toLowerCase();
  const name = actorName(session);
  const id = randomToken(12);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO party_blocked_words (id, word, key, added_by, added_name, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING').bind(id, word, key, actorId, name, t),
    logModAction(env.DB, { actorId, actorName: name, action: 'word_add', detail: { word }, t }),
  ]);
  clearBlockedCache(env.DB);
  return listWords(env, role, { added: id }, 201);
}

async function removeWord(env, session, role, raw, t) {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw bad('bad_id', "That word id doesn't look right.");
  const row = await env.DB.prepare('SELECT id, word FROM party_blocked_words WHERE id = ?').bind(raw).first();
  if (!row) return listWords(env, role, { removed: false });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM party_blocked_words WHERE id = ?').bind(raw),
    logModAction(env.DB, { actorId: session.user_id, actorName: actorName(session), action: 'word_remove', detail: { word: row.word }, t }),
  ]);
  clearBlockedCache(env.DB);
  return listWords(env, role, { removed: true });
}

export async function blockedWordsRoute(request, env, session, route, t) {
  const role = await partyRole(env, session.user_id);
  if (!role) return fail(403, 'staff_only', STAFF_ONLY);
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  const nope = () => fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route.length === 2) {
    if (read) return listWords(env, role);
    if (method === 'POST') return addWord(request, env, session, role, t);
    return nope();
  }
  if (route.length === 3) return method === 'DELETE' ? removeWord(env, session, role, route[2], t) : nope();
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}
