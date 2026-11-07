export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_MENTION = /^<@!?([\w-]+)>$/;
const ROLE_MENTION = /^<@&([\w-]+)>$/;
const CHANNEL_MENTION = /^<#([\w-]+)>$/;

export function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|“([^”]*)”|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

const UNITS = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4, h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, wk: 6048e5, week: 6048e5, weeks: 6048e5 };

export function parseDuration(text, { bareUnit = 'm' } = {}) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * UNITS[bareUnit]);
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let used = '';
  let m;
  while ((m = re.exec(s))) {
    const unit = UNITS[m[2]];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    used += m[0];
  }
  if (!total || used.replace(/\s/g, '') !== s.replace(/\s/g, '')) return null;
  return Math.round(total);
}

export function takeDuration(tokens, opts) {
  for (let n = Math.min(tokens.length, 4); n >= 1; n--) {
    const ms = parseDuration(tokens.slice(0, n).join(' '), opts);
    if (ms !== null) return { ms, rest: tokens.slice(n) };
  }
  return { ms: null, rest: tokens };
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  let s = Math.round(ms / 1000);
  const parts = [];
  for (const [u, n] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (s >= n) { parts.push(`${Math.floor(s / n)}${u}`); s %= n; }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

export function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export function fuzzyFind(query, items, opts = {}) {
  const q = normalizeName(query);
  if (!q) return null;
  const direct = fuzzyFindExact(q, items, opts);
  if (direct || !/s$/.test(q) || q.length < 4) return direct;
  return fuzzyFindExact(q.slice(0, -1), items, opts);
}

function fuzzyFindExact(q, items, { key = (x) => x.name, maxTypos = 2 } = {}) {
  let best = null;
  for (const item of items || []) {
    const n = normalizeName(key(item));
    if (!n) continue;
    let score = null;
    if (n === q) score = 0;
    else if (n.startsWith(q) || n.endsWith(q)) score = 1;
    else if (n.includes(q) && q.length >= 3) score = 2;
    else {
      const d = levenshtein(n, q);
      if (d <= Math.min(maxTypos, Math.floor(q.length / 3))) score = 2 + d;
    }
    if (score !== null && (!best || score < best.score || (score === best.score && n.length < best.len))) best = { item, score, len: n.length, exact: score === 0 };
  }
  return best && { item: best.item, score: best.score, exact: best.exact };
}

export function didYouMean(query, words, { limit = 3, max = 3 } = {}) {
  const q = String(query ?? '').toLowerCase();
  return [...new Set(words)]
    .map((w) => ({ w, d: String(w).toLowerCase().startsWith(q) && q ? 0 : levenshtein(q, String(w).toLowerCase()) }))
    .filter((x) => x.d <= Math.max(1, Math.min(max, Math.ceil(q.length / 2))))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.w);
}

export function userId(token) {
  const t = String(token ?? '').trim();
  const m = USER_MENTION.exec(t);
  if (m) return m[1];
  if (ID_RE.test(t)) return t;
  return null;
}
export function roleId(token) {
  const t = String(token ?? '').trim();
  const m = ROLE_MENTION.exec(t);
  if (m) return m[1];
  if (ID_RE.test(t)) return t;
  return null;
}
export function channelId(token) {
  const t = String(token ?? '').trim();
  const m = CHANNEL_MENTION.exec(t);
  if (m) return m[1];
  if (ID_RE.test(t)) return t;
  return null;
}

export function resolveUser(token, members = []) {
  const id = userId(token);
  if (id) return members.find((m) => m.id === id) || { id };
  const q = String(token ?? '').replace(/^@/, '');
  if (!q) return null;
  const exact = members.find((m) => m.username?.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  const hit = fuzzyFind(q, members, { key: (m) => m.nickname || m.display_name || m.username, maxTypos: 1 })
    || fuzzyFind(q, members, { key: (m) => m.username, maxTypos: 1 });
  return hit?.item ?? null;
}
export function resolveRole(token, roles = []) {
  const id = roleId(token);
  if (id) return roles.find((r) => r.id === id) || null;
  const q = String(token ?? '').replace(/^@/, '');
  return fuzzyFind(q, roles)?.item ?? null;
}
export function resolveChannel(token, channels = []) {
  const id = channelId(token);
  if (id) return channels.find((c) => c.id === id) || null;
  const q = String(token ?? '').replace(/^#/, '');
  return fuzzyFind(q, channels)?.item ?? null;
}

export function mentionedUserIds(text) {
  return [...String(text ?? '').matchAll(/<@!?([\w-]+)>/g)].map((m) => m[1]);
}

export function parseBool(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (/^(y|yes|on|true|1|enable|enabled|yep|sure)$/.test(t)) return true;
  if (/^(n|no|off|false|0|disable|disabled|nope)$/.test(t)) return false;
  return null;
}

export function fillTemplate(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (all, k) => (values[k] !== undefined && values[k] !== null ? String(values[k]) : all));
}

export function ordinal(n) {
  const v = Math.abs(n) % 100;
  const s = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  return `${n}${s}`;
}

export function authorName(msg) {
  const a = msg?.author;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') return a.display_name || a.username || a.name || 'someone';
  return msg?.author_name || msg?.username || 'someone';
}

export function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}
