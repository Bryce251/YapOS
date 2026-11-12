const IMAGE_HOSTS = new Set(['files.yapper.website', 'www.yapin.gg']);

const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function toNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function formatNumber(value) {
  const n = toNumber(value);
  return n === null ? '–' : numberFmt.format(n);
}

export function formatCompact(value) {
  const n = toNumber(value);
  if (n === null) return '–';
  return Math.abs(n) < 10000 ? numberFmt.format(n) : compactFmt.format(n);
}

export function toMillis(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === 'string') {
    if (/^\d+(\.\d+)?$/.test(ts)) return toMillis(Number(ts));
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function relativeTime(ts, now = Date.now()) {
  const t = toMillis(ts);
  if (t === null) return '';
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const future = diff < 0;
  const say = (n, unit) => {
    const text = `${n} ${unit}${n === 1 ? '' : 's'}`;
    return future ? `in ${text}` : `${text} ago`;
  };
  if (abs < 45) return future ? 'in a moment' : 'just now';
  if (abs < 3600) return say(Math.max(1, Math.round(abs / 60)), 'minute');
  if (abs < 86400) return say(Math.round(abs / 3600), 'hour');
  if (abs < 86400 * 30) return say(Math.round(abs / 86400), 'day');
  if (abs < 86400 * 365) return say(Math.round(abs / (86400 * 30)), 'month');
  return say(Math.round(abs / (86400 * 365)), 'year');
}

export function formatDate(ts, { time = true } = {}) {
  const t = toMillis(ts);
  if (t === null) return '';
  const d = new Date(t);
  const opts = { year: 'numeric', month: 'short', day: 'numeric' };
  if (time) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('en-US', opts);
}

export function formatUptime(seconds) {
  const s = toNumber(seconds);
  if (s === null || s < 0) return '–';
  if (s < 60) return `${Math.floor(s)}s`;
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  const parts = [];
  let rest = Math.floor(s);
  for (const [u, n] of units) {
    if (rest >= n) {
      parts.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
  }
  return parts.slice(0, 2).join(' ');
}

export function formatDurationMs(ms) {
  const n = toNumber(ms);
  if (n === null || n < 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  let s = Math.round(n / 1000);
  const parts = [];
  for (const [u, k] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (s >= k) {
      parts.push(`${Math.floor(s / k)}${u}`);
      s %= k;
    }
  }
  return parts.join('') || '0s';
}

export function looksLikeDuration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return true;
  return /^\d+(\.\d+)?$/.test(s) || /^(\d+(\.\d+)?\s*[a-z]+\s*)+$/.test(s);
}

export function initials(name) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N}\s_-]/gu, ' ').trim();
  if (!clean) return '?';
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  const first = Array.from(words[0] || '?')[0] || '?';
  const second = words.length > 1 ? Array.from(words[1])[0] : (Array.from(words[0])[1] || '');
  return (first + (second || '')).toUpperCase();
}

export function hueFrom(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return Math.floor(((h * 0.618033988749895) % 1) * 360);
}

export function safeImageUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    if (!IMAGE_HOSTS.has(u.hostname)) return '';
    return u.href;
  } catch {
    return '';
  }
}

export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return s.length >= 3 ? s : '';
}

export function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9-]{3,32}$/.test(slug);
}

export function plural(n, word, many) {
  const v = toNumber(n) ?? 0;
  return `${formatNumber(v)} ${v === 1 ? word : (many || `${word}s`)}`;
}

const CASE_LABELS = {
  warn: 'Warning',
  warning: 'Warning',
  timeout: 'Timeout',
  mute: 'Timeout',
  untimeout: 'Timeout removed',
  kick: 'Kick',
  ban: 'Ban',
  tempban: 'Temp ban',
  unban: 'Unban',
  softban: 'Softban',
  note: 'Note',
  purge: 'Purge',
  lock: 'Lock',
  unlock: 'Unlock',
  slowmode: 'Slowmode',
};

export function caseTypeLabel(type) {
  const key = String(type ?? '').toLowerCase();
  if (CASE_LABELS[key]) return CASE_LABELS[key];
  if (!key) return 'Case';
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]+/g, ' ');
}

export function caseTone(type) {
  const key = String(type ?? '').toLowerCase();
  if (key === 'ban' || key === 'tempban' || key === 'softban') return 'danger';
  if (key === 'kick' || key === 'timeout' || key === 'mute') return 'warning';
  if (key === 'warn' || key === 'warning') return 'caution';
  if (key.startsWith('un')) return 'success';
  return 'neutral';
}

export function levelLabel(level) {
  const key = String(level ?? '').toLowerCase();
  if (key === 'owner') return 'Owner';
  if (key === 'admin') return 'Admin';
  if (key === 'mod') return 'Moderator';
  if (!key) return 'Member';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function toHexColor(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  }
  return '';
}

export function truncate(text, n) {
  const s = String(text ?? '');
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : s;
}
