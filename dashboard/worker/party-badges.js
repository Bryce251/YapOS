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
]);

export const BADGE_IDS = Object.freeze(PARTY_BADGES.map((b) => b.id));

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
