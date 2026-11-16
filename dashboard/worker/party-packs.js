import { HttpError, json, fail, readJson, isPlainObject, clientIp, parseJsonSafe } from './util.js';
import { hit, ipKey, tooMany, LIMITS } from './rate.js';
import { cleanText } from './profiles.js';
import { findBlocked, isBlockedGameWord } from '../web/activity/js/filter.js';
import { publicInfo, setPublic, deletePackStatements, packSocialRoute } from './pack-browse.js';

export const PACK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PACK_CODE_LENGTH = 8;
export const PACK_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
export const MAX_PACKS = 10;
export const MAX_PACK_WORDS = 500;
export const MAX_PACK_TRIVIA = 200;
export const PACK_NAME_MAX = 40;
export const PACK_WORD_MIN = 2;
export const PACK_WORD_MAX = 30;
export const TRIVIA_Q_MAX = 200;
export const TRIVIA_A_MAX = 80;
export const TRIVIA_WRONG = 3;
export const PACK_BODY_LIMIT = 256 * 1024;

const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u;
const FIELDS = new Set(['name', 'words', 'trivia', 'public']);
const NOT_YOURS = "We couldn't find that word pack. It may have been deleted.";
const cache = new Map();

function bad(code, message, extra) {
  return new HttpError(400, code, message, extra);
}

export function normalizeCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  return PACK_CODE_RE.test(code) ? code : null;
}

export function newPackCode() {
  const bytes = new Uint8Array(PACK_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += PACK_ALPHABET[b % PACK_ALPHABET.length];
  return out;
}

function textOk(text) {
  return findBlocked(text).length === 0;
}

function cleanWord(raw) {
  return (cleanText(String(raw), PACK_WORD_MAX + 1) || '').toLowerCase();
}

export function cleanPackWords(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('bad_words', 'Send the words as a list.');
  const seen = new Set();
  const words = [];
  const blocked = [];
  const invalid = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw bad('bad_words', "One of the words doesn't look right.");
    const w = cleanWord(raw);
    if (!w) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    if (Array.from(w).length < PACK_WORD_MIN || Array.from(w).length > PACK_WORD_MAX || !WORD_RE.test(w)) {
      invalid.push(w.slice(0, PACK_WORD_MAX + 1));
      continue;
    }
    if (isBlockedGameWord(w) || !textOk(w)) {
      blocked.push(w);
      continue;
    }
    words.push(w);
  }
  if (invalid.length) {
    throw bad('bad_words', `Words need ${PACK_WORD_MIN} to ${PACK_WORD_MAX} letters, numbers, spaces, dashes or apostrophes. Check: ${invalid.slice(0, 3).join(', ')}.`, { invalid: invalid.slice(0, 20) });
  }
  if (blocked.length) {
    throw bad('blocked_words', blocked.length === 1 ? "One word isn't allowed in YapOS Party. Remove it and try again." : `${blocked.length} words aren't allowed in YapOS Party. Remove them and try again.`, { blocked: blocked.length });
  }
  if (words.length > MAX_PACK_WORDS) throw bad('too_many_words', `A pack can have at most ${MAX_PACK_WORDS} words.`);
  return words;
}

function cleanField(raw, max, what, n) {
  if (typeof raw !== 'string') throw bad('bad_trivia', `Question ${n} needs ${what}.`);
  const text = cleanText(raw, max + 1);
  if (!text) throw bad('bad_trivia', `Question ${n} needs ${what}.`);
  if (Array.from(text).length > max) throw bad('bad_trivia', `Question ${n}: ${what} is too long. Keep it under ${max} characters.`);
  return text;
}

export function cleanPackTrivia(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('bad_trivia', 'Send the questions as a list.');
  if (list.length > MAX_PACK_TRIVIA) throw bad('too_many_trivia', `A pack can have at most ${MAX_PACK_TRIVIA} questions.`);
  let blocked = 0;
  const out = list.map((item, i) => {
    const n = i + 1;
    if (!isPlainObject(item)) throw bad('bad_trivia', `Question ${n} doesn't look right.`);
    const q = cleanField(item.q, TRIVIA_Q_MAX, 'a question', n);
    const a = cleanField(item.a, TRIVIA_A_MAX, 'a right answer', n);
    if (!Array.isArray(item.w) || item.w.length !== TRIVIA_WRONG) throw bad('bad_trivia', `Question ${n} needs ${TRIVIA_WRONG} wrong answers.`);
    const w = item.w.map((x) => cleanField(x, TRIVIA_A_MAX, 'all 3 wrong answers', n));
    const keys = [a, ...w].map((x) => x.toLowerCase());
    if (new Set(keys).size !== keys.length) throw bad('bad_trivia', `Question ${n} has the same answer twice. Make every answer different.`);
    if (![q, a, ...w].every(textOk)) blocked += 1;
    return { q, a, w };
  });
  if (blocked) {
    throw bad('blocked_trivia', blocked === 1 ? "One question uses a word that isn't allowed in YapOS Party. Fix it and try again." : `${blocked} questions use words that aren't allowed in YapOS Party. Fix them and try again.`, { blocked });
  }
  return out;
}

export function cleanPack(body) {
  for (const k of Object.keys(body)) {
    if (!FIELDS.has(k)) throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.name !== 'string') throw bad('bad_name', 'Give your pack a name.');
  const name = cleanText(body.name, PACK_NAME_MAX + 1);
  if (!name) throw bad('bad_name', 'Give your pack a name.');
  if (Array.from(name).length > PACK_NAME_MAX) throw bad('bad_name', `Keep the name under ${PACK_NAME_MAX} characters.`);
  if (!textOk(name)) throw bad('blocked_name', "That name uses a word that isn't allowed in YapOS Party.");
  if (body.public !== undefined && typeof body.public !== 'boolean') throw bad('bad_public', '"public" must be true or false.');
  const words = cleanPackWords(body.words);
  const trivia = cleanPackTrivia(body.trivia);
  if (!words.length && !trivia.length) throw bad('empty_pack', 'Add at least one word or one question.');
  const out = { name, words, trivia };
  if (typeof body.public === 'boolean') out.public = body.public;
  return out;
}

function packOut(row, full = true, info = null) {
  const words = parseJsonSafe(row.words, []);
  const trivia = parseJsonSafe(row.trivia, []);
  const out = {
    code: row.code,
    name: row.name,
    wordCount: Array.isArray(words) ? words.length : 0,
    triviaCount: Array.isArray(trivia) ? trivia.length : 0,
    created: Number(row.created),
    updated: Number(row.updated),
    public: Boolean(info && info.public),
    blocked: Boolean(info && info.blocked),
    likes: info ? info.likes : 0,
  };
  if (full) {
    out.words = Array.isArray(words) ? words : [];
    out.trivia = Array.isArray(trivia) ? trivia : [];
  }
  return out;
}

async function listPacks(env, session, extra = {}) {
  const res = await env.DB.prepare('SELECT code, name, words, trivia, created, updated FROM party_packs WHERE owner_id = ? ORDER BY created ASC, code ASC').bind(session.user_id).all();
  const rows = (res && res.results) || [];
  const info = await publicInfo(env.DB, rows.map((r) => r.code));
  const packs = rows.map((r) => packOut(r, false, info.get(r.code)));
  return json({ packs, max: MAX_PACKS, limits: { words: MAX_PACK_WORDS, trivia: MAX_PACK_TRIVIA, name: PACK_NAME_MAX }, ...extra });
}

async function ownPack(env, session, raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  return env.DB.prepare('SELECT code, owner_id, name, words, trivia, created, updated FROM party_packs WHERE code = ? AND owner_id = ?').bind(code, session.user_id).first();
}

async function createPack(request, env, session, t) {
  const pack = cleanPack(await readJson(request, PACK_BODY_LIMIT));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_packs WHERE owner_id = ?').bind(session.user_id).first();
  if (Number(count && count.n) >= MAX_PACKS) return fail(409, 'too_many', `You already have ${MAX_PACKS} word packs. Delete one first.`);
  for (let i = 0; i < 6; i += 1) {
    const code = newPackCode();
    const res = await env.DB.prepare('INSERT INTO party_packs (code, owner_id, name, words, trivia, created, updated) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM party_packs WHERE owner_id = ?) < ? ON CONFLICT (code) DO NOTHING')
      .bind(code, session.user_id, pack.name, JSON.stringify(pack.words), JSON.stringify(pack.trivia), t, t, session.user_id, MAX_PACKS)
      .run();
    if (!(res && res.meta && res.meta.changes)) {
      const again = await env.DB.prepare('SELECT COUNT(*) AS n FROM party_packs WHERE owner_id = ?').bind(session.user_id).first();
      if (Number(again && again.n) >= MAX_PACKS) return fail(409, 'too_many', `You already have ${MAX_PACKS} word packs. Delete one first.`);
    }
    if (res && res.meta && res.meta.changes) {
      if (pack.public) await setPublic(env.DB, code, true, t);
      return json({ pack: await fullPack(env, code) }, 201);
    }
  }
  return fail(503, 'busy', "We couldn't make a code for your pack. Try again.");
}

async function updatePack(request, env, session, raw, t) {
  const row = await ownPack(env, session, raw);
  if (!row) return fail(404, 'not_found', NOT_YOURS);
  const pack = cleanPack(await readJson(request, PACK_BODY_LIMIT));
  await env.DB.prepare('UPDATE party_packs SET name = ?, words = ?, trivia = ?, updated = ? WHERE code = ? AND owner_id = ?')
    .bind(pack.name, JSON.stringify(pack.words), JSON.stringify(pack.trivia), t, row.code, session.user_id)
    .run();
  cache.delete(row.code);
  if (typeof pack.public === 'boolean') await setPublic(env.DB, row.code, pack.public, t);
  return json({ pack: await fullPack(env, row.code) });
}

async function fullPack(env, code) {
  const row = await env.DB.prepare('SELECT code, name, words, trivia, created, updated FROM party_packs WHERE code = ?').bind(code).first();
  const info = await publicInfo(env.DB, [code]);
  return packOut(row, true, info.get(code));
}

async function publishPack(request, env, session, raw, t) {
  const row = await ownPack(env, session, raw);
  if (!row) return fail(404, 'not_found', NOT_YOURS);
  const body = await readJson(request, 4 * 1024);
  for (const k of Object.keys(body)) {
    if (k !== 'public') throw bad('bad_request', `Unknown field "${k.slice(0, 40)}".`);
  }
  if (typeof body.public !== 'boolean') throw bad('bad_public', '"public" must be true or false.');
  if (body.public && !textOk(row.name)) return fail(400, 'blocked_name', "That name uses a word that isn't allowed in YapOS Party.");
  await setPublic(env.DB, row.code, body.public, t);
  return json({ pack: await fullPack(env, row.code) });
}

async function deletePack(env, session, raw) {
  const row = await ownPack(env, session, raw);
  if (!row) return fail(404, 'not_found', NOT_YOURS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM party_packs WHERE code = ? AND owner_id = ?').bind(row.code, session.user_id),
    ...deletePackStatements(env.DB, row.code),
  ]);
  cache.delete(row.code);
  return listPacks(env, session, { deleted: true });
}

export function packsRoute(request, env, session, route, t) {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  const nope = () => fail(405, 'method_not_allowed', 'That action is not allowed here.');
  if (route.length === 1) {
    if (read) return listPacks(env, session);
    if (method === 'POST') return createPack(request, env, session, t);
    return nope();
  }
  if (route.length === 2) {
    if (read) {
      return ownPack(env, session, route[1]).then((row) => (row ? fullPack(env, row.code).then((pack) => json({ pack })) : fail(404, 'not_found', NOT_YOURS)));
    }
    if (method === 'PUT' || method === 'PATCH') return updatePack(request, env, session, route[1], t);
    if (method === 'DELETE') return deletePack(env, session, route[1]);
    return nope();
  }
  if (route.length === 3 && route[2] === 'public') {
    if (method === 'PUT' || method === 'PATCH' || method === 'POST') return publishPack(request, env, session, route[1], t);
    return nope();
  }
  if (route.length === 3 && (route[2] === 'like' || route[2] === 'report')) return packSocialRoute(request, env, session, route, t);
  return fail(404, 'not_found', "That page of the dashboard doesn't exist.");
}

export function safePack(row) {
  const words = parseJsonSafe(row.words, []);
  const trivia = parseJsonSafe(row.trivia, []);
  return {
    code: row.code,
    name: textOk(row.name) ? row.name : 'Word pack',
    words: (Array.isArray(words) ? words : []).filter((w) => typeof w === 'string' && !isBlockedGameWord(w) && textOk(w)),
    trivia: (Array.isArray(trivia) ? trivia : []).filter((x) => isPlainObject(x) && typeof x.q === 'string' && typeof x.a === 'string' && Array.isArray(x.w) && x.w.length === TRIVIA_WRONG && [x.q, x.a, ...x.w].every((s) => typeof s === 'string' && textOk(s))),
  };
}

export async function getPublicPack(request, env, raw, t) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method_not_allowed', 'That action is not allowed here.');
  const limit = await hit(env.DB, await ipKey('packs', clientIp(request)), LIMITS.packs, t);
  if (!limit.ok) return tooMany(limit.retryAfter);
  const code = normalizeCode(raw);
  const missing = () => fail(404, 'not_found', "There's no word pack with that code. Check it and try again.", undefined, { 'Cache-Control': 'public, max-age=30' });
  if (!code) return missing();
  const row = await env.DB.prepare('SELECT code, name, words, trivia, updated FROM party_packs WHERE code = ?').bind(code).first();
  if (!row) return missing();
  let hitCache = cache.get(code);
  if (!hitCache || hitCache.updated !== Number(row.updated)) {
    hitCache = { updated: Number(row.updated), pack: safePack(row) };
    cache.set(code, hitCache);
    while (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return json(hitCache.pack, 200, { 'Cache-Control': 'public, max-age=60' });
}
