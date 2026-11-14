export const EARLY = Object.freeze([
  'Whoa there! The light was still red.',
  'Jumped the gun! Your thumb got a little too excited.',
  'Too soon! Red means wait, even for legends.',
  'A bold guess. Not a correct one.',
  'Your finger moved before the light did.',
  'Patience is a superpower. This round, it was not yours.',
  'The light said wait. Your thumb said no.',
  'Speedy! Just a bit too speedy.',
]);

export const FOOLED = Object.freeze([
  'Fooled by the amber! Not yet means not yet.',
  'The sneaky amber got you.',
  'Amber is not green. Sneaky, right?',
  'Caught by the fake-out! It happens to the best of us.',
  'That amber was a trap, and you walked right in.',
  'Almost green is not green.',
]);

export const GUESS = Object.freeze([
  'That was a guess! Nobody is that fast.',
  'Too quick to be real. Wait for the green.',
  'Lucky guess? The light only just changed.',
]);

export const SLOW = Object.freeze([
  'Nice and relaxed. Maybe a little too relaxed.',
  'Taking the scenic route, are we?',
  'The green light waited for you. Kind of.',
  'Slow and steady does not win this one.',
]);

export const NONE = Object.freeze([
  'No tap this round.',
  'The light came and went.',
  'Missed this one. Next round!',
]);

export const RATINGS = Object.freeze([
  { under: 160, label: 'Lightning', emoji: '⚡' },
  { under: 210, label: 'Blazing', emoji: '🔥' },
  { under: 260, label: 'Super quick', emoji: '🚀' },
  { under: 320, label: 'Quick', emoji: '🏃' },
  { under: 420, label: 'Steady', emoji: '👍' },
  { under: 600, label: 'Sleepy', emoji: '😴' },
  { under: Infinity, label: 'Snail mode', emoji: '🐌' },
]);

export const TIPS = Object.freeze([
  'Tap the big panel or press Space when it turns green.',
  'Keep your finger ready, but stay calm.',
  'Eyes on the panel. Green means go.',
  'Stay loose. Tense fingers are slow fingers.',
  'Breathe in. Breathe out. Wait for green.',
  'Fastest finger gets the most points.',
]);

export const FAKE_TIPS = Object.freeze([
  'Fake-outs are on. Amber means not yet!',
  'Watch out for amber. Only green counts.',
  'Some rounds turn amber first. Do not fall for it.',
]);

export function rating(ms) {
  if (!Number.isFinite(ms)) return null;
  return RATINGS.find((r) => ms < r.under) || RATINGS[RATINGS.length - 1];
}

export function pickLine(list, seed) {
  if (!list.length) return '';
  const n = Math.abs(Math.floor(Number(seed) || 0));
  return list[n % list.length];
}
