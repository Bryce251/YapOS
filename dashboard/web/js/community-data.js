import { toHexColor, toMillis, toNumber } from './format.js';
import { monthLabel } from './public-data.js';

export const PARTY_GAMES = Object.freeze({
  trivia: { name: 'Trivia', emoji: '🧠' },
  draw: { name: 'Draw & Guess', emoji: '🎨' },
  chain: { name: 'Word Chain', emoji: '🔗' },
  wyr: { name: 'Would You Rather', emoji: '🤔' },
  odd: { name: 'Odd One Out', emoji: '🕵️' },
  telephone: { name: 'Draw Telephone', emoji: '☎️' },
  scramble: { name: 'Scramble Race', emoji: '🔀' },
  hive: { name: 'Letter Hive', emoji: '🐝' },
  emoji: { name: 'Emoji Decode', emoji: '🧩' },
  hottakes: { name: 'Hot Takes', emoji: '🌶️' },
  truths: { name: 'Two Truths and a Lie', emoji: '🤥' },
  reflex: { name: 'Reflex', emoji: '⚡' },
  bluff: { name: 'Bluff', emoji: '🃏' },
  pixel: { name: 'Pixel Art', emoji: '🟪' },
  higherlower: { name: 'Higher or Lower', emoji: '📈' },
  sketchduel: { name: 'Sketch Duel', emoji: '⚔️' },
  story: { name: 'Story Builder', emoji: '📖' },
  hangman: { name: 'Hangman Royale', emoji: '🪢' },
  musicquiz: { name: 'Music Quiz', emoji: '🎵' },
  closest: { name: 'Closest Guess', emoji: '🎯' },
  namefive: { name: 'Name 5', emoji: '🖐️' },
  beatdrop: { name: 'Beat Drop', emoji: '🥁' },
  typerace: { name: 'Typing Race', emoji: '⌨️' },
  memory: { name: 'Memory Chain', emoji: '💡' },
});

export const PARTY_BADGE_COUNTERS = Object.freeze([
  Object.freeze({ key: 'steals', label: 'Trivia steals' }),
  Object.freeze({ key: 'perfect', label: 'Perfect Trivia games' }),
  Object.freeze({ key: 'lightning', label: 'Lightning round answers' }),
  Object.freeze({ key: 'bestWinStreak', label: 'Best win streak' }),
  Object.freeze({ key: 'comeback', label: 'Comeback wins' }),
  Object.freeze({ key: 'fakerCaught', label: 'Fakers caught' }),
  Object.freeze({ key: 'pangram', label: 'Pangrams found' }),
  Object.freeze({ key: 'topTake', label: 'Top hot takes' }),
  Object.freeze({ key: 'fastest', label: 'Fastest in Reflex' }),
]);

export const BADGES = Object.freeze({
  'first-game': { label: 'First game', emoji: '🎈' },
  'games-10': { label: 'Party regular', emoji: '🎲' },
  'games-50': { label: 'Party animal', emoji: '🥳' },
  'games-100': { label: 'Party legend', emoji: '🏟️' },
  'wins-10': { label: 'Winner', emoji: '🥇' },
  'wins-50': { label: 'Champion', emoji: '👑' },
  'faker-10': { label: 'Faker caught 10 times', emoji: '🕵️' },
  'pangram-5': { label: 'Pangram hunter', emoji: '🐝' },
  'hottest-take-3': { label: 'Hottest take', emoji: '🌶️' },
  'reflex-5': { label: 'Lightning reflexes', emoji: '⚡' },
  'daily-7': { label: 'Daily devotee', emoji: '📅' },
  'streak-3': { label: 'Hot streak', emoji: '🔥' },
  'streak-5': { label: 'Unstoppable', emoji: '☄️' },
  'steals-10': { label: 'Master thief', emoji: '😈' },
  'perfect-trivia': { label: 'Perfect Trivia', emoji: '💯' },
  comeback: { label: 'Comeback kid', emoji: '🔄' },
  'lightning-25': { label: 'Speed demon', emoji: '🌩️' },
  'yapos-team': { label: 'YapOS team', emoji: '🛠️' },
  supporter: { label: 'Supporter', emoji: '💖' },
  'early-bird': { label: 'Early bird', emoji: '🐣' },
  'bug-hunter': { label: 'Bug hunter', emoji: '🐛' },
  vip: { label: 'VIP', emoji: '🎩' },
  'event-winner': { label: 'Event winner', emoji: '🎊' },
  legend: { label: 'YapOS legend', emoji: '🌠' },
  contributor: { label: 'Contributor', emoji: '⭐', note: 'Helped build YapOS with code, art, ideas or testing' },
  einstein: { label: 'Einstein', emoji: '🧠', note: 'Can only be given by Jolli' },
  founder: { label: 'Founder', emoji: '🔱', note: 'The owner of YapOS. Only Jolli has it' },
});

export const ACHIEVEMENTS = Object.freeze({
  msgs1k: { label: 'Chatterbox', emoji: '💬' },
  msgs10k: { label: 'Town crier', emoji: '📣' },
  level10: { label: 'Rising star', emoji: '📈' },
  level25: { label: 'Regular', emoji: '🌟' },
  level50: { label: 'Legend', emoji: '👑' },
  streak7: { label: 'On a roll', emoji: '🔥' },
  streak30: { label: 'Devoted', emoji: '☄️' },
  streak100: { label: 'Unstoppable', emoji: '🌋' },
  casino50: { label: 'High roller', emoji: '🎰' },
  party10: { label: 'Party starter', emoji: '🎉' },
  party100: { label: 'Party animal', emoji: '🪩' },
  partywin25: { label: 'Party champion', emoji: '🏆' },
  quests10: { label: 'Errand runner', emoji: '📜' },
  quests50: { label: 'Quest master', emoji: '🗺️' },
  tickets100: { label: 'Frequent flyer', emoji: '🎫' },
  clanfound: { label: 'Clan founder', emoji: '🛡️' },
  clanjoin: { label: 'Better together', emoji: '🤝' },
  'messages-1k': { label: 'Chatterbox', emoji: '💬' },
  'messages-10k': { label: 'Town crier', emoji: '📣' },
  'casino-50': { label: 'High roller', emoji: '🎰' },
  'tickets-100': { label: 'Frequent flyer', emoji: '🎫' },
});

export const SEASON_KINDS = Object.freeze({
  xp: { label: 'XP', long: 'Most XP', emoji: '⭐' },
  shards: { label: 'Shards', long: 'Most 💎 Shards earned', emoji: '💎' },
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const count = (v) => {
  const n = toNumber(v);
  return n === null || n < 0 ? 0 : Math.floor(n);
};

export function humanize(id) {
  const s = str(id).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

export function gameInfo(id, name = '') {
  const key = str(id).toLowerCase();
  const known = PARTY_GAMES[key];
  return { id: key, name: str(name) || known?.name || humanize(key) || 'Party game', emoji: known?.emoji || '🎮' };
}

export const BADGE_IMAGE_RE = /^\/badge-img\/c-[a-z0-9]{8}-[0-9a-f]{16}\.(png|webp|jpg)$/;

export function badgeImage(v) {
  return typeof v === 'string' && BADGE_IMAGE_RE.test(v) ? v : '';
}

function withExtras(out, entry, known) {
  const image = badgeImage(entry?.image) || badgeImage(known?.image);
  const note = str(entry?.note) || str(known?.note);
  if (image) out.image = image;
  if (note) out.note = Array.from(note).slice(0, 100).join('');
  return out;
}

function catalogFrom(list, base) {
  if (!Array.isArray(list) || !list.length) return base;
  const out = { ...base };
  for (const b of list) {
    if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id) continue;
    const emoji = str(b.emoji);
    out[b.id] = withExtras({ label: str(b.label) || base[b.id]?.label || humanize(b.id), emoji: emoji && Array.from(emoji).length <= 4 ? emoji : (base[b.id]?.emoji || '🏅') }, b, base[b.id]);
  }
  return out;
}

const SEASON_BADGE_RE = /^season-(xp|shards|party)-(\d{1,2})-(\d{4}-\d{2})$/;
const SEASON_BADGE_KINDS = Object.freeze({ xp: 'XP', shards: 'Shards', party: 'Party' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function seasonBadge(id) {
  const m = SEASON_BADGE_RE.exec(str(id));
  if (!m) return null;
  const rank = Number(m[2]);
  const [y, mo] = m[3].split('-').map(Number);
  if (!rank || mo < 1 || mo > 12) return null;
  const medal = ['🥇', '🥈', '🥉'][rank - 1] || '🎖️';
  return { label: `#${rank} ${SEASON_BADGE_KINDS[m[1]]} · ${MONTHS[mo - 1]} ${y}`, emoji: medal };
}

function catalogItem(entry, catalog, fallbackEmoji) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id) return null;
    const known = catalog[id] || seasonBadge(id);
    return withExtras({ id, label: known?.label || humanize(id), emoji: known?.emoji || fallbackEmoji }, null, known);
  }
  if (!entry || typeof entry !== 'object') return null;
  const id = str(entry.id);
  if (!id) return null;
  const known = catalog[id] || seasonBadge(id);
  const emoji = str(entry.emoji);
  return withExtras({ id, label: str(entry.label) || str(entry.name) || known?.label || humanize(id), emoji: emoji && Array.from(emoji).length <= 4 ? emoji : (known?.emoji || fallbackEmoji) }, entry, known);
}

export function badgeInfo(entry, catalog = BADGES) {
  const out = catalogItem(entry, catalog, '🏅');
  if (!out || out.note) return out;
  const note = Object.prototype.hasOwnProperty.call(BADGES, out.id) ? BADGES[out.id].note : null;
  return note ? { ...out, note } : out;
}

export function achievementInfo(entry, catalog = ACHIEVEMENTS) {
  return catalogItem(entry, catalog, '🎖️');
}

export function xpForLevel(level) {
  const l = Math.max(0, Math.floor(Number(level) || 0));
  return 5 * l * l + 50 * l + 100;
}

export function levelProgress(level, xp) {
  const lvl = count(level);
  const total = toNumber(xp);
  if (total === null) return { level: lvl, into: 0, need: xpForLevel(lvl), frac: 0, known: false };
  let base = 0;
  for (let l = 0; l < lvl && l < 1000; l++) base += xpForLevel(l);
  const need = xpForLevel(lvl);
  const into = Math.max(0, Math.min(need, Math.floor(total) - base));
  return { level: lvl, into, need, frac: need ? into / need : 0, known: true };
}

function readFavourites(p) {
  const raw = [p.favourites, p.favouriteGames, p.favorites, p.favoriteGames, p.party?.favourites, p.party?.favouriteGames].find(Array.isArray) || [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    const id = typeof f === 'string' ? f : str(f?.game || f?.id);
    if (!id) continue;
    const info = gameInfo(id, typeof f === 'object' ? f?.name : '');
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    const plays = typeof f === 'object' ? toNumber(f?.played ?? f?.plays ?? f?.games ?? f?.count) : null;
    const won = typeof f === 'object' ? toNumber(f?.won ?? f?.wins) : null;
    out.push({ ...info, plays: plays === null ? null : Math.max(0, Math.floor(plays)), won: won === null ? null : Math.max(0, Math.floor(won)) });
  }
  return out.slice(0, 6);
}

export function readPlacings(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s === 'object' && /^\d{4}-\d{2}$/.test(str(s.month)))
    .map((s) => ({ month: str(s.month), label: monthLabel(str(s.month)), rank: count(s.rank), kind: s.kind === 'shards' ? 'shards' : 'xp' }))
    .filter((s) => s.rank >= 1)
    .sort((a, b) => (a.month === b.month ? a.rank - b.rank : (a.month < b.month ? 1 : -1)));
}

function readClan(c) {
  if (!c || typeof c !== 'object') return null;
  const name = str(c.name);
  if (!name) return null;
  return { name, tag: str(c.tag).slice(0, 6), colour: toHexColor(c.colour ?? c.color) };
}

export function normalizeProfile(input) {
  const p = input && typeof input === 'object' && input.profile && typeof input.profile === 'object' ? input.profile : input;
  if (!p || typeof p !== 'object') return null;
  const username = str(p.username);
  const name = str(p.name) || str(p.display_name) || username || 'Player';
  const shards = toNumber(p.shards);
  const party = p.party && typeof p.party === 'object' ? p.party : {};
  const seenBadges = new Set();
  const catalog = catalogFrom(input?.catalog?.badges, catalogFrom(input?.partyBadges, BADGES));
  const badges = (Array.isArray(p.badges) ? p.badges : []).map((b) => badgeInfo(b, catalog)).filter((b) => b && !seenBadges.has(b.id) && seenBadges.add(b.id));
  const seenAch = new Set();
  const achCatalog = catalogFrom(input?.catalog?.achievements, ACHIEVEMENTS);
  const achievements = (Array.isArray(p.achievements) ? p.achievements : []).map((a) => achievementInfo(a, achCatalog)).filter((a) => a && !seenAch.has(a.id) && seenAch.add(a.id));
  return {
    id: str(p.id),
    name,
    username,
    avatar: str(p.avatar) || str(p.avatar_url),
    avatarStill: str(p.avatarStill),
    level: count(p.level),
    xp: toNumber(p.xp),
    shards: shards === null ? null : Math.max(0, Math.floor(shards)),
    badges,
    achievements,
    season: readPlacings(p.season ?? p.seasons),
    clan: readClan(p.clan),
    games: count(p.games ?? party.games),
    wins: count(p.wins ?? party.wins),
    favourites: readFavourites(p),
    updatedAt: toMillis(p.updatedAt ?? p.updated_at),
  };
}

function readBoard(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({ rank: count(r.rank) || i + 1, id: str(r.id), name: str(r.name) || str(r.username) || 'Unknown', username: str(r.username), linked: r.profile !== false && Boolean(str(r.username)), value: count(r.value) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10);
}

export function normalizeSeasons(data) {
  const raw = Array.isArray(data?.seasons) ? data.seasons : (Array.isArray(data) ? data : []);
  const seen = new Set();
  return raw
    .filter((s) => s && typeof s === 'object' && /^\d{4}-\d{2}$/.test(str(s.month)))
    .map((s) => {
      const boards = s.boards && typeof s.boards === 'object' ? s.boards : s;
      return { month: str(s.month), label: monthLabel(str(s.month)), xp: readBoard(boards.xp), shards: readBoard(boards.shards) };
    })
    .filter((s) => !seen.has(s.month) && seen.add(s.month))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

export const PACK_SORTS = Object.freeze([['top', 'Most liked'], ['new', 'Newest']]);

function readBrowsePack(p, likedSet) {
  if (!p || typeof p !== 'object' || typeof p.code !== 'string' || !p.code) return null;
  const author = p.author && typeof p.author === 'object' ? str(p.author.name) || str(p.author.username) : str(p.author) || str(p.by);
  return {
    code: p.code,
    name: str(p.name) || 'Word pack',
    wordCount: count(p.wordCount ?? p.words),
    triviaCount: count(p.triviaCount ?? p.trivia),
    likes: count(p.likes),
    liked: p.liked === true || likedSet.has(p.code),
    author,
    created: toMillis(p.published ?? p.created ?? p.createdAt ?? p.created_at),
  };
}

export function normalizeBrowse(data) {
  const likedSet = new Set(Array.isArray(data?.liked) ? data.liked.filter((c) => typeof c === 'string') : []);
  const page = Number.isInteger(data?.page) && data.page > 0 ? data.page : 1;
  return {
    packs: (Array.isArray(data?.packs) ? data.packs : []).map((p) => readBrowsePack(p, likedSet)).filter(Boolean),
    page,
    next: data?.more === true ? page + 1 : null,
  };
}

export const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeStats(data, { days = 7, now = Date.now() } = {}) {
  const span = days === 30 ? 30 : 7;
  const hours = (Array.isArray(data?.hours) ? data.hours : [])
    .map((r) => ({ at: toMillis(r?.hour), messages: count(r?.messages), joins: count(r?.joins), leaves: count(r?.leaves), active: count(r?.active) }))
    .filter((r) => r.at !== null);
  const end = new Date(now);
  const list = [];
  const index = new Map();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const row = { day: dayKey(d), messages: 0, joins: 0, leaves: 0, active: 0 };
    index.set(row.day, row);
    list.push(row);
  }
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of hours) {
    const d = new Date(r.at);
    const row = index.get(dayKey(d));
    if (!row) continue;
    row.messages += r.messages;
    row.joins += r.joins;
    row.leaves += r.leaves;
    row.active = Math.max(row.active, r.active);
    heat[d.getDay()][d.getHours()] += r.messages;
  }
  const totals = list.reduce((t, r) => ({ messages: t.messages + r.messages, joins: t.joins + r.joins, leaves: t.leaves + r.leaves }), { messages: 0, joins: 0, leaves: 0 });
  let peak = null;
  heat.forEach((row, day) => row.forEach((n, hour) => {
    if (n > 0 && (!peak || n > peak.count)) peak = { day, hour, count: n };
  }));
  return { days: list, heat, totals, peak, empty: !hours.length, span };
}

export function hourLabel(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`;
}

export function heatLevel(n, max) {
  if (!n || !max) return 0;
  return Math.max(1, Math.min(4, Math.ceil((n / max) * 4)));
}
