import { findBlocked, isBlockedGameWord } from '../activity/js/filter.js';

export const NAME_MIN = 3;
export const NAME_MAX = 24;
export const BANNER_MAX = 60;
export const CREATE_COST = 500;
export const STYLE_PRICE = 1500;
export const BOOST_PRICE = 5000;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '._-]*[A-Za-z0-9.']$/;
export const TAG_RE = /^[A-Za-z0-9]{3,4}$/;
export const RESERVED = Object.freeze(['admin', 'admn', 'adm', 'mod', 'mods', 'moderator', 'staff', 'staf', 'stff', 'yapin', 'yapn', 'yap', 'yaps', 'yapper', 'yapos', 'yos', 'official', 'owner', 'ownr', 'dev', 'devs', 'system', 'sys', 'bot', 'bots', 'support', 'help']);
export const STEMS = Object.freeze(['admin', 'moderator', 'staff', 'yapin', 'yapper', 'yapos', 'official', 'developer']);
export const COLOURS = Object.freeze({
  red: 0xed4245, orange: 0xe67e22, yellow: 0xfee75c, gold: 0xd4af37, green: 0x57f287, teal: 0x1abc9c, cyan: 0x00bcd4,
  blue: 0x3498db, navy: 0x2c3e80, purple: 0x9b59b6, violet: 0x7c5cff, pink: 0xeb459e, white: 0xf5f5f5, grey: 0x95a5a6, gray: 0x95a5a6, black: 0x23272a,
});
const LOOKALIKE = Object.freeze({ '0': 'O', '1': 'I', L: 'I', '5': 'S', '8': 'B' });

export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

export function cleanClanText(text) {
  return String(text ?? '').replace(/<@&[\w-]+>/g, '').replace(/<@!?[\w-]+>/g, '').replace(/<#[\w-]+>/g, '').replace(/[<>*_~`|\\@]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function reservedWord(w) {
  if (RESERVED.includes(w)) return true;
  const bare = w.replace(/(?:es|s|z)$/, '');
  return bare !== w && RESERVED.includes(bare);
}

export function clanTextBlocked(text, { owner = false } = {}) {
  const t = String(text ?? '');
  if (!t) return false;
  const words = normalizeName(t).split('-').filter(Boolean);
  const compact = normalizeName(t).replace(/-/g, '');
  if (!owner && [...words, compact].some(reservedWord)) return true;
  if (!owner && STEMS.some((stem) => compact.startsWith(stem) || compact.endsWith(stem))) return true;
  try {
    if (findBlocked(t).length) return true;
    return words.some((w) => isBlockedGameWord(w)) || isBlockedGameWord(t.replace(/\s+/g, ''));
  } catch {
    return false;
  }
}

export function checkClanName(raw, { owner = false } = {}) {
  const name = cleanClanText(raw);
  if (name.length < NAME_MIN || name.length > NAME_MAX) return { error: `Clan names are ${NAME_MIN} to ${NAME_MAX} characters.` };
  if (!NAME_RE.test(name)) return { error: 'Use letters, numbers, spaces and simple marks like - _ . \' in clan names.' };
  if (clanTextBlocked(name, { owner })) return { error: "That name isn't allowed. Pick something else." };
  return { value: name };
}

export function checkClanTag(raw, { owner = false } = {}) {
  const tag = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!TAG_RE.test(tag)) return { error: 'Tags are 3 or 4 letters or numbers, like `OWL` or `GG42`.' };
  if (clanTextBlocked(tag, { owner })) return { error: "That tag isn't allowed. Pick something else." };
  return { value: tag.toUpperCase() };
}

export function checkClanBanner(raw, { owner = false } = {}) {
  const text = cleanClanText(raw).slice(0, BANNER_MAX).trim();
  if (!text) return { value: null };
  if (clanTextBlocked(text, { owner })) return { error: "That banner isn't allowed. Pick different words." };
  return { value: text };
}

export function parseClanColour(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (COLOURS[t] !== undefined) return COLOURS[t];
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(t);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return parseInt(hex, 16);
}

export function colourHex(n) {
  return `#${Number(n).toString(16).padStart(6, '0')}`;
}

export function tagSkeleton(tag) {
  return [...String(tag ?? '').toUpperCase()].map((ch) => LOOKALIKE[ch] || ch).join('');
}
