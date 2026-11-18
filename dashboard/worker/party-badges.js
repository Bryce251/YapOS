import { badgeKindOf, specialFirst } from '../web/js/profile-look.js';

export const PARTY_BADGES = Object.freeze([
  Object.freeze({ id: 'first-game', label: 'First game', emoji: '🎈', hint: 'Finish your first YapOS Party game.' }),
  Object.freeze({ id: 'games-10', label: 'Party regular', emoji: '🎲', hint: 'Play 10 YapOS Party games.' }),
  Object.freeze({ id: 'games-50', label: 'Party animal', emoji: '🥳', hint: 'Play 50 YapOS Party games.' }),
  Object.freeze({ id: 'games-100', label: 'Party legend', emoji: '🏟️', hint: 'Play 100 YapOS Party games.' }),
  Object.freeze({ id: 'wins-10', label: 'Winner', emoji: '🥇', hint: 'Win 10 YapOS Party games.' }),
  Object.freeze({ id: 'wins-50', label: 'Champion', emoji: '👑', hint: 'Win 50 YapOS Party games.' }),
  Object.freeze({ id: 'faker-10', label: 'Faker caught 10 times', emoji: '🕵️', hint: 'Vote for the faker in Odd One Out 10 times.' }),
  Object.freeze({ id: 'pangram-5', label: 'Pangram hunter', emoji: '🐝', hint: 'Find 5 pangrams in Letter Hive.' }),
  Object.freeze({ id: 'hottest-take-3', label: 'Hottest take', emoji: '🌶️', hint: 'Write the top take in Hot Takes 3 times.' }),
  Object.freeze({ id: 'reflex-5', label: 'Lightning reflexes', emoji: '⚡', hint: 'Be the fastest in Reflex 5 times.' }),
  Object.freeze({ id: 'daily-7', label: 'Daily devotee', emoji: '📅', hint: 'Play the daily puzzle 7 days in a row.' }),
  Object.freeze({ id: 'streak-3', label: 'Hot streak', emoji: '🔥', hint: 'Win 3 YapOS Party games in a row.' }),
  Object.freeze({ id: 'streak-5', label: 'Unstoppable', emoji: '☄️', hint: 'Win 5 YapOS Party games in a row.' }),
  Object.freeze({ id: 'steals-10', label: 'Master thief', emoji: '😈', hint: 'Steal points 10 times in Trivia.' }),
  Object.freeze({ id: 'perfect-trivia', label: 'Perfect Trivia', emoji: '💯', hint: 'Get every question right in a Trivia game of 8 or more questions.' }),
  Object.freeze({ id: 'comeback', label: 'Comeback kid', emoji: '🔄', hint: 'Win a game after being last at the halfway point.' }),
  Object.freeze({ id: 'lightning-25', label: 'Speed demon', emoji: '🌩️', hint: 'Get 25 answers right in Trivia lightning rounds.' }),
]);

export const BADGE_IDS = Object.freeze(PARTY_BADGES.map((b) => b.id));

export function badgeTier(id) {
  return badgeKindOf(id, (k) => BADGE_IDS.includes(k));
}

export function specialBadgesFirst(ids) {
  return specialFirst(ids, badgeTier);
}

export const FOUNDER_BADGE = 'founder';
export const FOUNDER_ONLY = 'Only Jolli can have the Founder badge.';

export function withoutFounder(ids, isOwner) {
  const list = Array.isArray(ids) ? ids : [];
  return isOwner ? list : list.filter((id) => id !== FOUNDER_BADGE);
}

export const COUNTER_GAMES = Object.freeze({
  fakerCaught: 'odd',
  pangram: 'hive',
  topTake: 'hottakes',
  fastest: 'reflex',
});

export const COUNTER_KEYS = Object.freeze(Object.keys(COUNTER_GAMES));

const RULES = {
  'first-game': (s) => s.games >= 1,
  'games-10': (s) => s.games >= 10,
  'games-50': (s) => s.games >= 50,
  'games-100': (s) => s.games >= 100,
  'wins-10': (s) => s.wins >= 10,
  'wins-50': (s) => s.wins >= 50,
  'faker-10': (s) => (s.counters.fakerCaught || 0) >= 10,
  'pangram-5': (s) => (s.counters.pangram || 0) >= 5,
  'hottest-take-3': (s) => (s.counters.topTake || 0) >= 3,
  'reflex-5': (s) => (s.counters.fastest || 0) >= 5,
  'daily-7': (s) => (s.dailyBest || 0) >= 7,
  'streak-3': (s) => (Number(s.counters.bestWinStreak) || 0) >= 3,
  'streak-5': (s) => (Number(s.counters.bestWinStreak) || 0) >= 5,
  'steals-10': (s) => (Number(s.counters.steals) || 0) >= 10,
  'perfect-trivia': (s) => (Number(s.counters.perfect) || 0) >= 1,
  comeback: (s) => (Number(s.counters.comeback) || 0) >= 1,
  'lightning-25': (s) => (Number(s.counters.lightning) || 0) >= 25,
};

export function badgesFor(stats) {
  const s = {
    games: Number(stats && stats.games) || 0,
    wins: Number(stats && stats.wins) || 0,
    counters: (stats && stats.counters) || {},
    dailyBest: Number(stats && stats.dailyBest) || 0,
  };
  return BADGE_IDS.filter((id) => RULES[id](s));
}

export function badgeById(id) {
  return PARTY_BADGES.find((b) => b.id === id) || null;
}

export const SKILL_KEYS = Object.freeze(['s', 'l', 'p', 'c']);
export const SKILL_COUNTERS = Object.freeze({ s: 'steals', l: 'lightning', p: 'perfect', c: 'comeback' });
export const SKILL_GAMES = Object.freeze({ s: 'trivia', l: 'trivia', p: 'trivia', c: null });
export const SKILL_GAME_CAPS = Object.freeze({ s: 20, l: 10, p: 1, c: 1 });
export const SKILL_DAILY_CAPS = Object.freeze({ s: 40, l: 60, p: 3, c: 5, g: 60 });
export const PERFECT_MIN_QUESTIONS = 8;
export const PERFECT_MAX_QUESTIONS = 50;

function usedToday(counters, day) {
  const d = counters.skillToday;
  if (counters.skillDay !== day || !d || typeof d !== 'object' || Array.isArray(d)) return {};
  return { ...d };
}

export function applySkills(counters, { won, skill, day }) {
  const out = { ...(counters && typeof counters === 'object' ? counters : {}) };
  const used = usedToday(out, day);
  if ((Number(used.g) || 0) >= SKILL_DAILY_CAPS.g) return out;
  used.g = (Number(used.g) || 0) + 1;
  const streak = won ? (Number(out.winStreak) || 0) + 1 : 0;
  out.winStreak = streak;
  out.bestWinStreak = Math.max(Number(out.bestWinStreak) || 0, streak);
  for (const key of SKILL_KEYS) {
    const want = Math.max(0, Math.floor(Number(skill && skill[key]) || 0));
    if (!want) continue;
    const room = Math.max(0, SKILL_DAILY_CAPS[key] - (Number(used[key]) || 0));
    const add = Math.min(want, SKILL_GAME_CAPS[key], room);
    if (add <= 0) continue;
    used[key] = (Number(used[key]) || 0) + add;
    const name = SKILL_COUNTERS[key];
    out[name] = (Number(out[name]) || 0) + add;
  }
  out.skillDay = day;
  out.skillToday = used;
  return out;
}

const SEASON_BADGE_RE = /^season-(xp|shards|party)-(\d{1,2})-(\d{4})-(0[1-9]|1[0-2])$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SEASON_KIND_LABELS = Object.freeze({ xp: 'XP', shards: 'Shards', party: 'Party' });

export function partySeasonBadgeId(rank, month) {
  return `season-party-${rank}-${month}`;
}

export function seasonBadgeInfo(id) {
  const m = SEASON_BADGE_RE.exec(typeof id === 'string' ? id.trim().toLowerCase() : '');
  if (!m) return null;
  const rank = Number(m[2]);
  if (!rank) return null;
  return { id: m[0], label: `#${rank} ${SEASON_KIND_LABELS[m[1]]} · ${MONTHS[Number(m[4]) - 1]} ${m[3]}`, emoji: ['🥇', '🥈', '🥉'][rank - 1] || '🎖️' };
}

export async function partySeasonBadges(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase());
  if (!list.length) return [];
  const uniq = [...new Set(list)];
  const res = await db.prepare(`SELECT month, rank FROM party_season_awards WHERE user_id IN (${uniq.map(() => '?').join(', ')}) ORDER BY month DESC, rank ASC LIMIT 36`).bind(...uniq).all();
  return ((res && res.results) || []).map((r) => partySeasonBadgeId(Number(r.rank), r.month));
}
