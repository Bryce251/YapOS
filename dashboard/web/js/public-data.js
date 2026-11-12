import { formatNumber, toNumber } from './format.js';

export function normalizeBoard(list, kind) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => {
      const rank = toNumber(r.rank) ?? i + 1;
      const name = String(r.name ?? r.username ?? 'Unknown');
      if (kind === 'economy') {
        return { rank, id: String(r.id ?? ''), name, avatar: r.avatar_url ?? '', primary: toNumber(r.balance) ?? 0, primaryLabel: 'coins', secondary: '' };
      }
      const level = toNumber(r.level) ?? 0;
      const xp = toNumber(r.xp);
      const messages = toNumber(r.messages);
      const parts = [];
      if (xp !== null) parts.push(`${formatNumber(xp)} XP`);
      if (messages !== null) parts.push(`${formatNumber(messages)} messages`);
      return { rank, id: String(r.id ?? ''), name, avatar: r.avatar_url ?? '', primary: level, primaryLabel: 'level', secondary: parts.join(' · ') };
    })
    .sort((a, b) => a.rank - b.rank);
}

const LABELS = {
  msgs: 'Messages',
  messages: 'Messages',
  active: 'Active members',
  activeMembers: 'Active members',
  active_members: 'Active members',
  members: 'Active members',
  vs: 'Voice time',
  voice: 'Voice time',
  voiceSeconds: 'Voice time',
  voice_seconds: 'Voice time',
  voiceHours: 'Voice hours',
  reactions: 'Reactions',
  busiestHour: 'Busiest hour',
  busyHour: 'Busiest hour',
  busiest_hour: 'Busiest hour',
  busiestDay: 'Busiest day',
  busyDay: 'Busiest day',
  busiest_day: 'Busiest day',
  topChatters: 'Top chatters',
  chatters: 'Top chatters',
  top_chatters: 'Top chatters',
  topChannels: 'Top channels',
  channels: 'Top channels',
  top_channels: 'Top channels',
  topReactions: 'Top reactions',
  emojis: 'Top reactions',
  top_reactions: 'Top reactions',
  memberOfMonth: 'Member of the month',
  mom: 'Member of the month',
  member_of_month: 'Member of the month',
};

const SKIP = new Set(['title', 'month', 'label', 'monthLabel', 'key', 'name', 'icon', 'updatedAt', 'note', 'footer', 'color', 'empty', 'description', 'body']);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function humanKey(key) {
  if (LABELS[key]) return LABELS[key];
  const s = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function voiceText(seconds) {
  const h = seconds / 3600;
  if (h >= 1) return `${formatNumber(Math.round(h * 10) / 10)} h`;
  return `${formatNumber(Math.round(seconds / 60))} min`;
}

function hourText(h) {
  const n = ((Math.round(h) % 24) + 24) % 24;
  const suffix = n < 12 ? 'am' : 'pm';
  const base = n % 12 === 0 ? 12 : n % 12;
  return `${base}${suffix} UTC`;
}

function statValue(key, value) {
  const n = toNumber(value);
  if (/^(vs|voice|voiceSeconds|voice_seconds)$/.test(key) && n !== null) return voiceText(n);
  if (/hour/i.test(key) && n !== null) return hourText(n);
  if (/day/i.test(key) && n !== null && n >= 0 && n < 7 && Number.isInteger(n)) return DAYS[n];
  if (n !== null) return formatNumber(n);
  return String(value);
}

function itemOf(entry) {
  if (Array.isArray(entry)) return { label: String(entry[0] ?? ''), value: toNumber(entry[1]) !== null ? formatNumber(entry[1]) : String(entry[1] ?? '') };
  if (entry && typeof entry === 'object') {
    const label = entry.name ?? entry.label ?? entry.emoji ?? entry.title ?? entry.channel ?? entry.id ?? '';
    const rawValue = entry.count ?? entry.n ?? entry.messages ?? entry.m ?? entry.value ?? entry.total ?? null;
    const unit = entry.count === undefined && entry.n === undefined && (entry.messages !== undefined || entry.m !== undefined) ? ' messages' : '';
    return { label: String(label), value: rawValue === null ? '' : (toNumber(rawValue) !== null ? `${formatNumber(rawValue)}${unit}` : String(rawValue)), avatar: entry.avatar_url ?? '' };
  }
  return { label: String(entry ?? ''), value: '' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return String(key ?? '');
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${MONTHS[i]} ${m[1]}` : String(key);
}

function stripMarks(text) {
  return String(text ?? '').replace(/\*\*/g, '').replace(/<[@#][!&]?[A-Za-z0-9-]+>/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
}

export function normalizeWrapped(input) {
  if (!input || typeof input !== 'object') return null;
  let w = input;
  if (input.card && typeof input.card === 'object') {
    const { card, ...rest } = input;
    w = { ...rest, title: card.title, body: card.description, fields: card.fields };
  }
  const title = typeof w.title === 'string' ? stripMarks(w.title).replace(/^[^\p{L}\p{N}]+/u, '') : '';
  const month = monthLabel(w.monthLabel ?? w.label ?? w.month ?? '');
  const stats = [];
  const lists = [];
  const highlights = [];
  if (Array.isArray(w.fields)) {
    for (const f of w.fields) {
      if (!f || typeof f !== 'object') continue;
      const rawValue = String(f.value ?? '');
      if (/<[@#][!&]?[A-Za-z0-9-]+>/.test(rawValue) || /\]\([^)]+\)/.test(rawValue)) continue;
      const name = String(f.name ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      const value = stripMarks(rawValue);
      if (!name || !value) continue;
      const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) lists.push({ title: name, items: lines.map((l) => ({ label: l, value: '' })) });
      else stats.push({ label: name, value });
    }
  }
  for (const [key, value] of Object.entries(w)) {
    if (SKIP.has(key) || key === 'fields' || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const items = value.map(itemOf).filter((i) => i.label);
      if (items.length) lists.push({ title: humanKey(key), items: items.slice(0, 10) });
    } else if (typeof value === 'object') {
      const item = itemOf(value);
      if (item.label) highlights.push({ title: humanKey(key), label: item.label, value: item.value, avatar: item.avatar || '' });
    } else if (typeof value === 'number' || typeof value === 'string') {
      if (String(value).trim() === '') continue;
      stats.push({ label: humanKey(key), value: statValue(key, value) });
    }
  }
  const empty = !stats.length && !lists.length && !highlights.length;
  const note = typeof w.note === 'string' ? w.note : (typeof w.body === 'string' ? w.body : (typeof w.description === 'string' ? w.description : ''));
  return { title, month, stats, lists, highlights, empty, note };
}

export function medalFor(rank) {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return '';
}
