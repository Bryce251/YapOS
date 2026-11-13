import { profileOf, profileAvatar, cleanUsername } from './profiles.js';

const AVATAR_HOSTS = new Set(['files.yapper.website', 'www.yapin.gg']);
export const NAME_MAX = 24;

export function idOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'object') {
    const v = x.id ?? x.user_id ?? x.userId ?? null;
    return v === null || v === undefined ? null : String(v);
  }
  return String(x);
}

export function cleanName(raw) {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  const cut = chars.length > NAME_MAX ? chars.slice(0, NAME_MAX - 1).join('') + '…' : text;
  return cut || 'Player';
}

export function nameOf(p) {
  if (!p || typeof p !== 'object') return 'Player';
  return cleanName(p.display_name || p.displayName || p.name || p.username || 'Player');
}

export function safeAvatar(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !AVATAR_HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function avatarOf(p) {
  if (!p || typeof p !== 'object') return null;
  return safeAvatar(p.avatar_url || p.avatarUrl || null);
}

export function initials(name) {
  const words = cleanName(name).replace(/…$/, '').split(' ').filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || 'P'];
  return letters.map((w) => Array.from(w)[0] || '').join('').toUpperCase() || 'P';
}

export function hueOf(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function ownName(p) {
  if (!p || typeof p !== 'object') return null;
  const raw = p.display_name || p.displayName || p.name || p.username || null;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

export function person(p) {
  const id = idOf(p);
  if (!id) return null;
  const prof = profileOf(id);
  const name = ownName(p) || !(prof && prof.displayName) ? nameOf(p) : cleanName(prof.displayName);
  const own = p && typeof p === 'object' ? p : null;
  const username = (prof && prof.username) || (own ? cleanUsername(own.username) : null) || null;
  const avatar = (prof && profileAvatar(prof.avatar)) || avatarOf(p) || null;
  return { id, name, username, avatar, initials: initials(name), hue: hueOf(id) };
}

export function people(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const x = person(p);
    if (!x || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}
