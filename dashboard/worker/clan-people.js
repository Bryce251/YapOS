import { safeName, applySettings } from './public-profiles.js';
import { cleanUsername } from './profiles.js';
import { hiddenNameMap, flagsFor, maskEntry } from './hidden-names.js';
import { findBlocked } from '../web/activity/js/filter.js';
import { avatarsFor } from './avatar-store.js';

const NAME_CHUNK = 90;
const PERSON_NAME_MAX = 64;
const lower = (v) => String(v ?? '').toLowerCase();

function whole(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

export async function people(db, ids, t, { pics = false } = {}) {
  const list = [...new Set(ids.filter(Boolean).map(lower))];
  const out = new Map();
  for (let i = 0; i < list.length; i += NAME_CHUNK) {
    const part = list.slice(i, i + NAME_CHUNK);
    const marks = part.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT p.user_id, p.name, p.username, p.level, p.hidden, p.shards, p.updated, s.hidden AS s_hidden, s.show_shards AS s_show_shards, s.claimed AS s_claimed, s.updated AS s_updated FROM public_profiles p LEFT JOIN profile_settings s ON s.user_id = p.user_id WHERE p.user_id IN (${marks})`)
      .bind(...part)
      .all();
    for (const r of (res && res.results) || []) {
      const settings = r.s_updated === null || r.s_updated === undefined ? null : { hidden: r.s_hidden, show_shards: r.s_show_shards, claimed: r.s_claimed, updated: r.s_updated };
      if (applySettings(r, settings).hidden) continue;
      const username = cleanUsername(r.username);
      out.set(lower(r.user_id), { name: safeName(r.name, PERSON_NAME_MAX, null) || username || 'Player', username: username && !findBlocked(username).length ? username : null, level: whole(r.level, 0, 100000) });
    }
  }
  const map = await hiddenNameMap(db, t);
  for (const [id, p] of out) {
    const flags = flagsFor(map, id);
    if (!flags) continue;
    const masked = maskEntry(p, flags, id);
    out.set(id, { name: masked.name, username: masked.username, level: p.level });
  }
  if (pics && out.size) {
    const found = await avatarsFor(db, [...out.keys()]).catch(() => new Map());
    for (const [id, p] of out) {
      const pic = found.get(id);
      if (pic && pic.avatar) out.set(id, { ...p, avatar: pic.avatar, ...(pic.avatarStill ? { avatarStill: pic.avatarStill } : {}) });
    }
  }
  return out;
}
